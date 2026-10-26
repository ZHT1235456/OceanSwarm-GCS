// =============================================================================
// Fleet formation controller (GCS edition).
//
// The flagship leads the swarm along a wide, slowly-curving course. Every
// vessel holds a slot in the formation frame with organic sway, chases it with
// a soft spring and rides the shared wave field (heave / pitch / roll).
//
// GCS additions (all optional and backwards compatible):
//   fleet.timeScale    — path-advance multiplier, 0 = formation hold
//   fleet.speedScale   — commanded speed multiplier (slow / cruise / flank)
//   fleet.turnRate     — live turn rate, lets the commander order U-turns / RTL
//   boat.slot          — commanded formation slot {lat, fwd} (overrides roster)
//   boat._auto         — single-vessel autonomous navigation {target,speed,arrive,kind}
//   boat._holdPos      — single vessel station-keeping at its current position
//   fleet.center       — live centroid of the actual hull positions (camera anchor)
// =============================================================================
import * as THREE from 'three';
import { FORMATION } from '../config.js';
import { sampleWave } from '../core/waves.js';

const AXIS_Y = new THREE.Vector3(0, 1, 0);
const AXIS_Z = new THREE.Vector3(0, 0, 1);
const AXIS_X = new THREE.Vector3(1, 0, 0);
const _q = new THREE.Quaternion();

const TYPE_DYNAMICS = {
  flagship: { follow: 1.4, pitch: 0.55, roll: 0.45, heave: 0.95, planing: 0.0, bank: 0.6 },
  scout: { follow: 2.0, pitch: 0.9, roll: 1.0, heave: 1.0, planing: 0.024, bank: 3.2 },
  env: { follow: 2.8, pitch: 0.68, roll: 0.7, heave: 0.95, planing: 0.004, bank: 0.9 },
  survey: { follow: 3.2, pitch: 0.44, roll: 0.38, heave: 0.85, planing: 0.003, bank: 0.4 },
  patrol: { follow: 2.4, pitch: 0.82, roll: 0.88, heave: 0.98, planing: 0.014, bank: 1.8 },
  comms: { follow: 3.6, pitch: 0.5, roll: 0.44, heave: 0.9, planing: 0.002, bank: 0.4 },
  energy: { follow: 3.8, pitch: 0.46, roll: 0.4, heave: 0.88, planing: 0.002, bank: 0.35 },
  rescue: { follow: 2.6, pitch: 0.76, roll: 0.8, heave: 0.95, planing: 0.008, bank: 1.2 },
};

function wrapAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

// Commanded slots may be authored as the inherited [lat, fwd] tuple or as the
// GCS {lat, fwd} object used by SwarmControl — accept both.
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

    // GCS motion controls
    this.timeScale = 1;
    this.speedScale = 1;
    this.turnRate = FORMATION.turnRate;

    // formation centroid (for a stable camera anchor)
    let lat = 0;
    let fwd = 0;
    for (const b of boats) {
      const [offLat, offFwd] = slotOf(b);
      lat += offLat;
      fwd += offFwd;
      const dyn = TYPE_DYNAMICS[b.type] || TYPE_DYNAMICS.env;
      b._dyn = dyn;
      b._rt = {
        pos: new THREE.Vector3(),
        yaw: FORMATION.heading0,
        pitch: 0,
        roll: 0,
        heave: 0,
        yawRate: 0,
      };
    }
    this.meanLateral = lat / boats.length;
    this.meanForward = fwd / boats.length;
    // path geometry
    this.turnRadius = FORMATION.speed / Math.max(FORMATION.turnRate, 1e-5);
  }

  /** Path position and heading of the flagship course at elapsed time t. */
  pathAt(t, outPos, outYaw) {
    const yaw = FORMATION.heading0 + FORMATION.turnRate * t;
    const s = FORMATION.speed / Math.max(FORMATION.turnRate, 1e-6);
    outPos.set(
      FORMATION.flagshipStart.x + s * (Math.sin(yaw) - Math.sin(FORMATION.heading0)),
      0,
      FORMATION.flagshipStart.z + s * (Math.cos(yaw) - Math.cos(FORMATION.heading0)),
    );
    if (outYaw !== undefined) outYaw.value = yaw;
  }

  _frameVectors(yaw) {
    this.forward.set(Math.cos(yaw), 0, -Math.sin(yaw));
    this.right.set(Math.sin(yaw), 0, Math.cos(yaw));
  }

  /** Position each vessel exactly in its slot (no spring lag) — used at boot. */
  snap() {
    this.time = 0;
    this.envTime = 0;
    this.pathPos.set(FORMATION.flagshipStart.x, 0, FORMATION.flagshipStart.z);
    this.pathYaw = FORMATION.heading0;
    this._frameVectors(this.pathYaw);
    for (const b of this.boats) {
      const [offLat, offFwd] = slotOf(b);
      const rt = b._rt;
      rt.pos.copy(this.pathPos).addScaledVector(this.right, offLat).addScaledVector(this.forward, offFwd);
      rt.yaw = this.pathYaw;
      rt.pitch = TYPE_DYNAMICS[b.type]?.planing ?? 0;
      rt.roll = 0;
      const w = sampleWave(rt.pos.x, rt.pos.z, 0);
      rt.heave = w.height;
      b._holdPos = false;
      b._auto = null;
      this._apply(b);
    }
    this._computeCenter();
    this.prevCenter.copy(this.center);
    this.delta.set(0, 0, 0);
    this.initialized = true;
  }

  /** Reseat the whole formation at a new course anchor (used on mission reset). */
  rebase(x, z, yaw) {
    this.pathPos.set(x, 0, z);
    this.pathYaw = yaw;
    this._frameVectors(yaw);
    this.snap();
  }

  _computeCenter() {
    this.prevCenter.copy(this.center);
    // live centroid of the actual hulls: the camera follows the real swarm,
    // including vessels that have been sent away on autonomous tasks.
    let sx = 0;
    let sz = 0;
    for (const b of this.boats) {
      sx += b._rt.pos.x;
      sz += b._rt.pos.z;
    }
    const n = Math.max(1, this.boats.length);
    this.center.set(sx / n, 0, sz / n);
    this.delta.copy(this.center).sub(this.prevCenter);
    this.headingDeg = ((90 - THREE.MathUtils.radToDeg(this.pathYaw)) % 360 + 360) % 360;
    this.speedKn = (FORMATION.speed * this.speedScale * this.timeScale) * 1.943844;
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

  /** Single-vessel autonomous navigation (goto / return-to-base). */
  _updateAuto(b, rt, dt) {
    const auto = b._auto;
    const dx = auto.target.x - rt.pos.x;
    const dz = auto.target.z - rt.pos.z;
    const dist = Math.hypot(dx, dz);
    if (dist > 0.35) {
      const step = Math.min(auto.speed * dt, dist);
      rt.pos.x += (dx / dist) * step;
      rt.pos.z += (dz / dist) * step;
      // heading: forward = (cos yaw, 0, -sin yaw)
      const desiredYaw = Math.atan2(-dz, dx);
      const dy = wrapAngle(desiredYaw - rt.yaw);
      const k = 1 - Math.exp(-dt / 1.1);
      const applied = dy * k;
      rt.yaw = wrapAngle(rt.yaw + applied);
      rt.yawRate = dt > 0 ? applied / dt : 0;
    }
    return dist;
  }

  update(dt) {
    if (!this.initialized) {
      this.snap();
      return;
    }
    dt = Math.min(dt, 0.08);
    const scaled = dt * this.timeScale;
    this.time += scaled;
    this.envTime += dt;
    this.pathYaw += this.turnRate * scaled;
    this._frameVectors(this.pathYaw);
    this.pathPos.addScaledVector(this.forward, FORMATION.speed * this.speedScale * scaled);

    const t = this.envTime;
    const ship = this.pathPos;
    const dir = this.forward;
    const right = this.right;

    for (const b of this.boats) {
      const rng = b.roster;
      const dyn = b._dyn;
      const rt = b._rt;
      const [baseLat, baseFwd] = slotOf(b);
      const ph = rng.phase ?? 0;
      const isFlag = b.type === 'flagship';
      const autonomous = !!b._auto;

      if (!autonomous && !b._holdPos) {
        // organic station-keeping: slow lateral sway, gentler fore/aft breathing
        let lat = baseLat;
        let fwd = baseFwd;
        lat += Math.sin(t * 0.101 + ph * 2.37) * (isFlag ? 1.1 : 3.2);
        lat += Math.sin(t * 0.043 + ph * 1.11) * (isFlag ? 0.9 : 4.5);
        fwd += Math.cos(t * 0.077 + ph * 1.73) * (isFlag ? 1.0 : 2.8);
        if (rng.sweep) {
          lat += Math.sin(t * 0.118 + ph) * rng.sweep[0];
          fwd += Math.cos(t * 0.083 + ph * 1.4) * rng.sweep[1];
        }

        const tx = ship.x + right.x * lat + dir.x * fwd;
        const tz = ship.z + right.z * lat + dir.z * fwd;

        // soft spring toward the moving slot
        const k = 1 - Math.exp(-dt / Math.max(dyn.follow, 0.2));
        rt.pos.x += (tx - rt.pos.x) * k;
        rt.pos.z += (tz - rt.pos.z) * k;

        // desired heading: course direction blended with the correction vector
        const corrX = tx - rt.pos.x;
        const corrZ = tz - rt.pos.z;
        const desX = dir.x * 46 + corrX * 0.9;
        const desZ = dir.z * 46 + corrZ * 0.9;
        const desiredYaw = Math.atan2(-desZ, desX);
        const dy = wrapAngle(desiredYaw - rt.yaw);
        const yawK = 1 - Math.exp(-dt / (1.7 + dyn.follow * 0.35));
        const applied = dy * yawK;
        rt.yaw = wrapAngle(rt.yaw + applied);
        rt.yawRate = rt.yawRate * 0.9 + (dt > 0 ? applied / dt : 0) * 0.1;
      } else if (autonomous) {
        this._updateAuto(b, rt, dt);
      }

      // ride the shared wave field: sample the surface under bow / stern / both
      // beams so the attitude is length-filtered like a real hull (a 30 m ship
      // does not follow every short chop).
      const halfL = (b.length || 14) * 0.42;
      const halfB = (b.beam || 5) * 0.36;
      const hCenter = sampleWave(rt.pos.x, rt.pos.z, t).height;
      const hBow = sampleWave(rt.pos.x + dir.x * halfL, rt.pos.z + dir.z * halfL, t).height;
      const hStern = sampleWave(rt.pos.x - dir.x * halfL, rt.pos.z - dir.z * halfL, t).height;
      const hRight = sampleWave(rt.pos.x + right.x * halfB, rt.pos.z + right.z * halfB, t).height;
      const hLeft = sampleWave(rt.pos.x - right.x * halfB, rt.pos.z - right.z * halfB, t).height;
      const pitchTarget = Math.atan2(hBow - hStern, halfL * 2) * dyn.pitch + dyn.planing;
      const bank = THREE.MathUtils.clamp(rt.yawRate * FORMATION.speed * dyn.bank * 0.06, -0.09, 0.09);
      const rollTarget = -Math.atan2(hRight - hLeft, halfB * 2) * dyn.roll + bank;
      const heaveTarget = hCenter * 0.35 + (hBow + hStern + hRight + hLeft) * 0.1625;
      const heaveK = 1 - Math.exp(-dt / 0.28);
      rt.heave += (heaveTarget * dyn.heave - rt.heave) * heaveK;
      const attK = 1 - Math.exp(-dt / 0.42);
      rt.pitch += (pitchTarget - rt.pitch) * attK;
      rt.roll += (rollTarget - rt.roll) * attK;

      this._apply(b);
      if (b.update) b.update(t, dt);
    }

    this._computeCenter();
  }
}
