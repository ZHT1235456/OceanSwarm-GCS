// =============================================================================
// Fleet formation controller — hydrodynamics edition.
//
// Every hull is now a 3-DOF manoeuvring plant (src/systems/vessel-dynamics.js):
// surge / sway / yaw with rigid-body + added mass, linear & quadratic damping,
// thrust lag, rudder rate/angle limits and a water-current disturbance. A
// guidance layer (src/systems/motion-controller.js) converts formation slots /
// waypoints / station-keeping demands into throttle & rudder commands, and the
// plant integrates the actual motion. Nothing teleports or spring-follows a
// point mass any more.
//
// Fleet still owns the commanded formation frame (a wide, slowly-curving course),
// the slot layout handed over by SwarmControl, wave-induced attitude (heave /
// pitch / roll) and the camera anchor centroid.
//
// GCS control inputs (written by SwarmControl):
//   fleet.timeScale / speedScale / turnRate
//   boat.slot              commanded formation slot {lat, fwd}
//   boat._auto             { target:{x,z}, speed, arrive } single-vessel task
//   boat._holdPos          station keeping flag
//   boat._holdPoint/_holdYaw  captured station-keeping target
//   fleet.estopActive      propulsion cut
// =============================================================================
import * as THREE from 'three';
import { FORMATION, CURRENT } from '../config.js';
import { sampleWave } from '../core/waves.js';
import { createVesselDynamics } from './vessel-dynamics.js';
import { createAutopilot, formationGuidance } from './motion-controller.js';

const AXIS_Y = new THREE.Vector3(0, 1, 0);
const AXIS_Z = new THREE.Vector3(0, 0, 1);
const AXIS_X = new THREE.Vector3(1, 0, 0);
const _q = new THREE.Quaternion();
const KN_PER_MS = 1.943844;

const TYPE_DYNAMICS = {
  flagship: { pitch: 0.55, roll: 0.45, heave: 0.95, planing: 0.0, bank: 0.6 },
  scout: { pitch: 0.9, roll: 1.0, heave: 1.0, planing: 0.024, bank: 3.2 },
  env: { pitch: 0.68, roll: 0.7, heave: 0.95, planing: 0.004, bank: 0.9 },
  survey: { pitch: 0.44, roll: 0.38, heave: 0.85, planing: 0.003, bank: 0.4 },
  patrol: { pitch: 0.82, roll: 0.88, heave: 0.98, planing: 0.014, bank: 1.8 },
  comms: { pitch: 0.5, roll: 0.44, heave: 0.9, planing: 0.002, bank: 0.4 },
  energy: { pitch: 0.46, roll: 0.4, heave: 0.88, planing: 0.002, bank: 0.35 },
  rescue: { pitch: 0.76, roll: 0.8, heave: 0.95, planing: 0.008, bank: 1.2 },
};

function wrapAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** World-frame current vector from the compass set in config.js. */
function currentWorld() {
  const speedMS = (CURRENT.speedKn || 0) * 0.514444;
  const rad = (CURRENT.dirDeg * Math.PI) / 180;
  return { x: Math.sin(rad) * speedMS, z: -Math.cos(rad) * speedMS };
}

const slotOf = (boat) => {
  const slot = boat.slot || boat.roster.offset;
  return Array.isArray(slot) ? slot : [slot.lat || 0, slot.fwd || 0];
};

export class Fleet {
  constructor(boats) {
    this.boats = boats;
    this.time = 0;
    this.envTime = 0;
    this.pathYaw = FORMATION.heading0;
    this.pathPos = new THREE.Vector3();
    this.forward = new THREE.Vector3(1, 0, 0);
    this.right = new THREE.Vector3(0, 0, 1);
    this.center = new THREE.Vector3();
    this.prevCenter = new THREE.Vector3();
    this.delta = new THREE.Vector3();
    this.initialized = false;

    // commanded motion inputs
    this.timeScale = 1;
    this.speedScale = 1;
    this.turnRate = FORMATION.turnRate;
    this.estopActive = false;

    this.current = currentWorld();
    const cruise = FORMATION.speed;

    for (const b of boats) {
      const dyn = TYPE_DYNAMICS[b.type] || TYPE_DYNAMICS.env;
      b._dyn = dyn;
      b._hydro = createVesselDynamics(b.type);
      b._hydro.setEnvironment({ currentX: this.current.x, currentZ: this.current.z });
      b._autopilot = createAutopilot({ plant: b._hydro });
      b._rt = {
        pos: new THREE.Vector3(),
        yaw: FORMATION.heading0,
        pitch: 0,
        roll: 0,
        heave: 0,
        yawRate: 0,
        u: cruise,
        v: 0,
        r: 0,
        sogMS: cruise,
        cogRad: FORMATION.heading0,
        driftRad: 0,
        rudderDeg: 0,
        throttlePct: 0,
      };
    }
    this.meanLateral = boats.reduce((n, b) => n + slotOf(b)[0], 0) / boats.length;
    this.meanForward = boats.reduce((n, b) => n + slotOf(b)[1], 0) / boats.length;
    this.turnRadius = FORMATION.speed / Math.max(FORMATION.turnRate, 1e-5);
    this.speedKn = cruise * KN_PER_MS;
    this.headingDeg = ((90 - THREE.MathUtils.radToDeg(this.pathYaw)) % 360 + 360) % 360;
  }

  _frameVectors(yaw) {
    this.forward.set(Math.cos(yaw), 0, -Math.sin(yaw));
    this.right.set(Math.sin(yaw), 0, Math.cos(yaw));
  }

  /** Slot position of a hull in world space. */
  slotWorld(b, out = { x: 0, z: 0 }) {
    const [lat, fwd] = slotOf(b);
    out.x = this.pathPos.x + this.right.x * lat + this.forward.x * fwd;
    out.z = this.pathPos.z + this.right.z * lat + this.forward.z * fwd;
    return out;
  }

  /**
   * Boot placement: hulls are put exactly on their station with the commanded
   * course already made good (u = cruise). This is initialisation, after which
   * all motion is integrated by the manoeuvring plants.
   */
  snap() {
    this.time = 0;
    this.envTime = 0;
    this.pathPos.set(FORMATION.flagshipStart.x, 0, FORMATION.flagshipStart.z);
    this.pathYaw = FORMATION.heading0;
    this._frameVectors(this.pathYaw);
    const cruise = FORMATION.speed;
    for (const b of this.boats) {
      const target = this.slotWorld(b);
      const rt = b._rt;
      b._auto = null;
      b._holdPos = false;
      b._holdPoint = null;
      b._holdYaw = null;
      b._hydro.reset({ x: target.x, z: target.z, yaw: this.pathYaw, u: cruise, v: 0, r: 0 });
      b._autopilot.reset();
      this._sync(b);
      rt.pitch = TYPE_DYNAMICS[b.type]?.planing ?? 0;
      rt.roll = 0;
      const w = sampleWave(rt.pos.x, rt.pos.z, 0);
      rt.heave = w.height;
      this._apply(b);
    }
    this._computeCenter();
    this.prevCenter.copy(this.center);
    this.delta.set(0, 0, 0);
    this.initialized = true;
  }

  /** Copy the plant state into the render/telemetry state for one hull. */
  _sync(b) {
    const s = b._hydro.state;
    const rt = b._rt;
    rt.pos.x = s.x;
    rt.pos.z = s.z;
    rt.yaw = s.yaw;
    rt.u = s.u;
    rt.v = s.v;
    rt.r = s.r;
    rt.yawRate = s.r;
    const snap = b._hydro.snapshot();
    // The plant's u/v are already velocities over ground expressed in the body
    // frame (the current enters only through relative-flow damping), so the
    // snapshot is authoritative here — do NOT add the current a second time.
    rt.sogMS = snap.sogMS;
    rt.cogRad = snap.cogRad;
    rt.driftRad = snap.driftRad; // = yaw − cog, i.e. COG − heading in compass terms
    rt.headingDeg = ((90 - THREE.MathUtils.radToDeg(s.yaw)) % 360 + 360) % 360;
    rt.cogDeg = ((90 - THREE.MathUtils.radToDeg(snap.cogRad)) % 360 + 360) % 360;
    rt.driftDeg = THREE.MathUtils.radToDeg(snap.driftRad);
    rt.rudderDeg = snap.rudderDeg;
    rt.throttlePct = snap.throttlePct;
    rt.yawRateDegS = (s.r * 180) / Math.PI;
  }

  /** Light neighbour separation bias used while manoeuvring through a formation. */
  _separation(b) {
    const rt = b._rt;
    let ax = 0;
    let az = 0;
    let nearest = Infinity;
    for (const other of this.boats) {
      if (other === b) continue;
      const dx = rt.pos.x - other._rt.pos.x;
      const dz = rt.pos.z - other._rt.pos.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < 1e-4) continue;
      const d = Math.sqrt(d2);
      nearest = Math.min(nearest, d);
      const safe = Math.max(14, (b.length + other.length) * 0.62);
      if (d < safe) {
        const w = (safe - d) / safe;
        ax += (dx / d) * w * 14;
        az += (dz / d) * w * 14;
      }
    }
    return { ax: clamp(ax, -18, 18), az: clamp(az, -18, 18), nearest };
  }

  _apply(b) {
    const rt = b._rt;
    const g = b.group;
    g.position.set(rt.pos.x, rt.heave, rt.pos.z);
    g.quaternion
      .setFromAxisAngle(AXIS_Y, rt.yaw)
      .multiply(_q.setFromAxisAngle(AXIS_Z, rt.pitch))
      .multiply(_q.setFromAxisAngle(AXIS_X, rt.roll));
  }

  /** Wave-induced attitude from the hull's own heading (not the fleet course). */
  _updateAttitude(b, dt) {
    const rt = b._rt;
    const dyn = b._dyn;
    const t = this.envTime;
    const fwdX = Math.cos(rt.yaw);
    const fwdZ = -Math.sin(rt.yaw);
    const rightX = Math.sin(rt.yaw);
    const rightZ = Math.cos(rt.yaw);
    const halfL = (b.length || 14) * 0.42;
    const halfB = (b.beam || 5) * 0.36;
    const hCenter = sampleWave(rt.pos.x, rt.pos.z, t).height;
    const hBow = sampleWave(rt.pos.x + fwdX * halfL, rt.pos.z + fwdZ * halfL, t).height;
    const hStern = sampleWave(rt.pos.x - fwdX * halfL, rt.pos.z - fwdZ * halfL, t).height;
    const hRight = sampleWave(rt.pos.x + rightX * halfB, rt.pos.z + rightZ * halfB, t).height;
    const hLeft = sampleWave(rt.pos.x - rightX * halfB, rt.pos.z - rightZ * halfB, t).height;
    const pitchTarget = Math.atan2(hBow - hStern, halfL * 2) * dyn.pitch + dyn.planing;
    const rollWave = -Math.atan2(hRight - hLeft, halfB * 2) * dyn.roll;
    // banking into the turn (centripetal roll): r·u is lateral acceleration
    const bank = clamp(dyn.bank * 0.02 * rt.r * Math.max(rt.u, 1.2), -0.16, 0.16);
    const rollTarget = rollWave + bank;
    const heaveTarget = hCenter * 0.35 + (hBow + hStern + hRight + hLeft) * 0.1625;
    const heaveK = 1 - Math.exp(-dt / 0.28);
    rt.heave += (heaveTarget * dyn.heave - rt.heave) * heaveK;
    const attK = 1 - Math.exp(-dt / 0.42);
    rt.pitch += (pitchTarget - rt.pitch) * attK;
    rt.roll += (rollTarget - rt.roll) * attK;
  }

  _computeCenter() {
    this.prevCenter.copy(this.center);
    let sx = 0;
    let sz = 0;
    let speed = 0;
    for (const b of this.boats) {
      sx += b._rt.pos.x;
      sz += b._rt.pos.z;
      speed += b._rt.sogMS;
    }
    const n = Math.max(1, this.boats.length);
    this.center.set(sx / n, 0, sz / n);
    this.delta.copy(this.center).sub(this.prevCenter);
    this.speedKn = (speed / n) * KN_PER_MS;
    this.headingDeg = ((90 - THREE.MathUtils.radToDeg(this.pathYaw)) % 360 + 360) % 360;
  }

  /** Organic station-keeping sway added to the commanded slot. */
  _formationSway(b, isFlag, ph) {
    const t = this.envTime;
    let lat = Math.sin(t * 0.101 + ph * 2.37) * (isFlag ? 1.1 : 3.2);
    lat += Math.sin(t * 0.043 + ph * 1.11) * (isFlag ? 0.9 : 4.5);
    let fwd = Math.cos(t * 0.077 + ph * 1.73) * (isFlag ? 1.0 : 2.8);
    if (b.roster.sweep) {
      lat += Math.sin(t * 0.118 + ph) * b.roster.sweep[0];
      fwd += Math.cos(t * 0.083 + ph * 1.4) * b.roster.sweep[1];
    }
    return { lat, fwd };
  }

  update(dt) {
    if (!this.initialized) {
      this.snap();
      return;
    }
    dt = Math.min(Math.max(dt, 0), 0.08);
    const scaled = dt * this.timeScale;
    this.time += scaled;
    this.envTime += dt;
    this.pathYaw += this.turnRate * scaled;
    this._frameVectors(this.pathYaw);
    const cruiseMS = FORMATION.speed * this.speedScale;
    this.pathPos.addScaledVector(this.forward, cruiseMS * scaled);

    const estop = !!this.estopActive;

    for (const b of this.boats) {
      const rt = b._rt;
      const ph = b.roster.phase ?? 0;
      const isFlag = b.type === 'flagship';
      let mode = 'course';
      let target = { x: rt.pos.x, z: rt.pos.z };
      let desiredSpeedMS = cruiseMS;
      let desiredYaw = this.pathYaw;
      let holdYaw = rt.yaw;
      let crossTrackErrorM = 0;

      if (estop) {
        mode = 'idle';
      } else if (b._auto) {
        // Terminal approach: inside ~18 m hand over to station keeping so the
        // hull can bleed off speed and settle instead of orbiting the waypoint.
        const dx = b._auto.target.x - rt.pos.x;
        const dz = b._auto.target.z - rt.pos.z;
        const dist = Math.hypot(dx, dz);
        if (dist < 18) {
          mode = 'station';
          target = b._auto.target;
          holdYaw = rt.yaw;
        } else {
          mode = 'waypoint';
          target = b._auto.target;
          desiredSpeedMS = clamp(b._auto.speed || 6.5, 0.6, 12);
        }
      } else if (b._holdPos) {
        mode = 'station';
        if (!b._holdPoint) b._holdPoint = { x: rt.pos.x, z: rt.pos.z };
        target = b._holdPoint;
        holdYaw = b._holdYaw != null ? b._holdYaw : this.pathYaw;
      } else if (this.timeScale < 0.15) {
        // formation hold: keep station on the frozen slot
        mode = 'station';
        const [lat, fwd] = slotOf(b);
        const sway = this._formationSway(b, isFlag, ph);
        target = {
          x: this.pathPos.x + this.right.x * (lat + sway.lat) + this.forward.x * (fwd + sway.fwd),
          z: this.pathPos.z + this.right.z * (lat + sway.lat) + this.forward.z * (fwd + sway.fwd),
        };
        holdYaw = this.pathYaw;
      } else {
        mode = 'course';
        const sway = this._formationSway(b, isFlag, ph);
        const lat = slotOf(b)[0] + sway.lat;
        const fwd = slotOf(b)[1] + sway.fwd;
        const slot = {
          x: this.pathPos.x + this.right.x * lat + this.forward.x * fwd,
          z: this.pathPos.z + this.right.z * lat + this.forward.z * fwd,
        };
        // neighbour separation bias while crossing a formation
        const sep = this._separation(b);
        const shifted = { x: slot.x + sep.ax, z: slot.z + sep.az };
        const guide = formationGuidance({
          state: { x: rt.pos.x, z: rt.pos.z },
          slotTarget: shifted,
          forward: this.forward,
          right: this.right,
          pathYaw: this.pathYaw,
          cruiseSpeedMS: cruiseMS,
          maxSpeedMS: b._hydro.params.maxSpeedMS || 9,
        });
        desiredSpeedMS = guide.desiredSpeedMS;
        desiredYaw = guide.desiredYaw;
        crossTrackErrorM = guide.errLat;
        if (sep.nearest < 12) desiredSpeedMS *= 0.62;
        target = shifted;
      }

      const ctl = b._autopilot.control({
        dt,
        state: b._hydro.state,
        mode,
        target,
        desiredSpeedMS,
        desiredYaw,
        holdYaw,
        current: this.current,
        crossTrackErrorM,
        fleetYaw: this.pathYaw,
      });
      b._hydro.step(dt, {
        throttle: ctl.throttle,
        rudder: ctl.rudder,
        lateral: ctl.lateral || 0,
        yawAux: ctl.yawAux || 0,
      });
      b._ctl = ctl;
      this._sync(b);
      this._updateAttitude(b, dt);
      this._apply(b);
      if (b.update) b.update(this.envTime, dt);
    }

    this._computeCenter();
  }
}
