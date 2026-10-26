// =============================================================================
// Motion autopilot — turns high-level guidance demands (track a formation slot,
// go to a waypoint, hold station, cut propulsion) into normalized actuator
// commands for the 3-DOF vessel plant (src/systems/vessel-dynamics.js).
//
// Actuator channels (all normalized −1..1):
//   throttle : main propulsion (single screw / waterjet)
//   rudder   : rudder deflection (effective ∝ u², useless at low speed)
//   lateral  : bow thruster / differential-jet side force   (low-speed DP)
//   yawAux   : auxiliary yaw moment (differential thrust)   (low-speed DP)
//
// Modes
//   'course'   formation-slot keeping: caller supplies desiredYaw + desiredSpeed
//   'waypoint' steer to a point with a braking envelope (goto / RTL)
//   'station'  dynamic positioning: inside 30 m a P+velocity DP controller holds
//              the point against current using the auxiliary thrusters; farther
//              away it makes an efficient rudder-driven transit first
//   'idle'     propulsion cut (emergency stop): everything zero → the hull drifts
//
// This module is deliberately pure math (no three.js / DOM) so the same code can
// be validated in plain Node (artifacts/motion/closed-loop-test.mjs).
// =============================================================================

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const wrap = (a) => {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
};
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** Derive handling limits from the plant parameters (with sane fallbacks). */
export function handlingOf(params = {}) {
  const L = isNum(params.lengthM) ? params.lengthM : 14;
  const cruise = isNum(params.cruiseSpeedMS) ? params.cruiseSpeedMS : 3.1;
  const uMax = isNum(params.maxSpeedMS) ? params.maxSpeedMS : cruise * 2.2;
  const turnRadius = isNum(params.turnRadiusCruiseM) ? params.turnRadiusCruiseM : L * 3.2;
  const rMax = isNum(params.maxYawRateRadS)
    ? params.maxYawRateRadS
    : Math.min(0.42, (cruise / Math.max(8, turnRadius)) * 1.25);
  return { L, cruise, uMax, turnRadius, rMax };
}

/**
 * Create an autopilot bound to one vessel's plant parameters.
 *   const ap = createAutopilot({ plant });          // plant = createVesselDynamics(...)
 *   const cmd = ap.control({ dt, state, mode, ... });
 */
export function createAutopilot({ plant, params, gains = {} }) {
  const p = params || (plant && plant.params) || {};
  const h = handlingOf(p);
  const G = {
    kHeading: gains.kHeading ?? 0.55, // r_des per rad of heading error [1/s]
    kRate: gains.kRate ?? 1.6, // rudder feedback on yaw-rate error
    kSpeed: gains.kSpeed ?? 0.55, // throttle per m/s of speed error
    kSpeedI: gains.kSpeedI ?? 0.035, // integral gain
    maxSpeedBoost: gains.maxSpeedBoost ?? 1.35, // allowed overspeed while catching up
    // dynamic-positioning gains (only used when the auxiliary thrusters exist)
    dpPosGain: gains.dpPosGain ?? 0.36, // desired ground velocity per metre [1/s]
    dpMaxVel: gains.dpMaxVel ?? 1.25, // m/s cap for the DP velocity demand
    dpStopRadius: gains.dpStopRadius ?? 1.3, // m; dead-band around the hold point
    dpSurgeGain: gains.dpSurgeGain ?? 1.05, // throttle per m/s of surge error
    dpSurgeI: gains.dpSurgeI ?? 0.16,
    dpSwayGain: gains.dpSwayGain ?? 2.2, // lateral command per m/s of sway error
    dpYawGain: gains.dpYawGain ?? 1.25, // yawAux per rad of heading error
    dpYawRateGain: gains.dpYawRateGain ?? 2.4, // yawAux per rad/s of rate error
    dpYawMaxRate: gains.dpYawMaxRate ?? 0.09, // rad/s heading-hold rate cap
  };
  // auxiliary thruster authority only exists if the plant exposes the params
  const hasDP = isNum(p.dpLateralForceN) && isNum(p.dpYawMomentNm) && p.dpLateralForceN > 0;

  const mem = { speedIntegral: 0, lastDist: Infinity };

  function reset() {
    mem.speedIntegral = 0;
    mem.lastDist = Infinity;
  }

  /**
   * @param {object} o
   * @param {number} o.dt            seconds since the previous control call
   * @param {object} o.state         plant state {x,z,yaw,u,v,r}
   * @param {string} o.mode          course | waypoint | station | idle
   * @param {number} [o.desiredSpeedMS]
   * @param {number} [o.desiredYaw]  for mode 'course'
   * @param {{x:number,z:number}} [o.target] for waypoint / station
   * @param {number} [o.holdYaw]     for station
   * @param {{x:number,z:number}} [o.current] water current (world m/s)
   */
  function control(o) {
    const dt = clamp(isNum(o.dt) ? o.dt : 0, 0, 0.2);
    const st = o.state || { x: 0, z: 0, yaw: 0, u: 0, v: 0, r: 0 };
    const mode = o.mode || 'course';
    const current = o.current || { x: 0, z: 0 };

    if (mode === 'idle') {
      mem.speedIntegral = 0;
      return {
        throttle: 0,
        rudder: 0,
        lateral: 0,
        yawAux: 0,
        dpMode: false,
        dist: 0,
        desiredYaw: st.yaw,
        desiredSpeed: 0,
        rDes: 0,
      };
    }

    const target = o.target || null;
    let dist = target ? Math.hypot(target.x - st.x, target.z - st.z) : 0;
    const holdYaw = isNum(o.holdYaw) ? o.holdYaw : st.yaw;
    let desiredYaw = isNum(o.desiredYaw) ? o.desiredYaw : st.yaw;
    let desiredSpeed = isNum(o.desiredSpeedMS) ? o.desiredSpeedMS : h.cruise;
    let dpMode = false;

    if (mode === 'waypoint' && target) {
      desiredYaw = Math.atan2(-(target.z - st.z), target.x - st.x);
      // deceleration envelope so the hull can actually stop at the waypoint
      const stopSpeed = Math.sqrt(Math.max(0, 2 * 0.55 * Math.max(0, dist - 2)));
      desiredSpeed = Math.min(desiredSpeed, Math.max(0.35, stopSpeed));
    } else if (mode === 'station') {
      if (target) {
        dist = Math.hypot(target.x - st.x, target.z - st.z);
        if (hasDP && dist < 30) {
          dpMode = true;
        } else if (dist > 4) {
          // rudder-driven transit toward the hold point (needs speed authority)
          desiredYaw = Math.atan2(-(target.z - st.z), target.x - st.x);
          desiredSpeed = Math.min(3.4, 0.16 * dist + 0.4);
        } else {
          desiredYaw = holdYaw;
          desiredSpeed = 0;
        }
      } else {
        desiredYaw = holdYaw;
        desiredSpeed = 0;
      }
    }

    // --- dynamic positioning (auxiliary thrusters, low speed) ----------------
    if (dpMode) {
      const ex = target.x - st.x;
      const ez = target.z - st.z;
      const dx = Math.hypot(ex, ez);
      let vwx = clamp(ex * G.dpPosGain, -G.dpMaxVel, G.dpMaxVel);
      let vwz = clamp(ez * G.dpPosGain, -G.dpMaxVel, G.dpMaxVel);
      if (dx < G.dpStopRadius) {
        vwx = 0;
        vwz = 0;
      }
      // desired ground velocity, compensated for the water current, expressed
      // in the body frame (u forward, v starboard)
      const vrx = vwx - current.x;
      const vrz = vwz - current.z;
      const cy = Math.cos(st.yaw);
      const sy = Math.sin(st.yaw);
      const uDes = clamp(cy * vrx - sy * vrz, -1.4, 1.4);
      const vDes = clamp(sy * vrx + cy * vrz, -1.0, 1.0);

      const uErr = uDes - st.u;
      const ff = typeof plant.throttleForSpeed === 'function'
        ? plant.throttleForSpeed(Math.max(0, uDes))
        : clamp((Math.max(0, uDes) / h.uMax) ** 2, 0, 1);
      mem.speedIntegral = clamp(mem.speedIntegral + uErr * dt, -0.9, 0.9);
      const throttle = clamp(ff + G.dpSurgeGain * uErr + G.dpSurgeI * mem.speedIntegral, -0.42, 0.62);
      const lateral = clamp(G.dpSwayGain * (vDes - st.v), -1, 1);

      const eYawH = wrap(holdYaw - st.yaw);
      const rDesH = clamp(eYawH * 0.6, -G.dpYawMaxRate, G.dpYawMaxRate);
      const rudder = clamp(rDesH / h.rMax + (1.1 * (rDesH - st.r)) / h.rMax, -1, 1);
      const yawAux = clamp(G.dpYawGain * eYawH + G.dpYawRateGain * (rDesH - st.r), -1, 1);

      mem.lastDist = dist;
      return {
        throttle,
        rudder,
        lateral,
        yawAux,
        dpMode: true,
        dist,
        desiredYaw: holdYaw,
        desiredSpeed: Math.hypot(vwx, vwz),
        rDes: rDesH,
      };
    }

    // --- conventional speed loop -------------------------------------------
    const uRef = desiredSpeed;
    const speedErr = clamp(uRef - st.u, -6, 6);
    const maxAllowed = Math.min(h.uMax * 0.92, Math.max(uRef * G.maxSpeedBoost, uRef + 0.8));
    const ff = typeof plant.throttleForSpeed === 'function'
      ? plant.throttleForSpeed(uRef)
      : clamp((uRef / h.uMax) ** 2, 0, 1);
    mem.speedIntegral = clamp(mem.speedIntegral + speedErr * dt, -0.9, 1.4);
    let throttle = ff + G.kSpeed * speedErr + G.kSpeedI * mem.speedIntegral;
    if (st.u > maxAllowed + 0.4) throttle = Math.min(throttle, -0.12);
    let lo = -0.22;
    if (mode === 'station' && uRef < 0.4) lo = Math.hypot(st.u, st.v) > 0.25 ? -0.12 : -0.04;
    throttle = clamp(throttle, lo, 1);

    // --- heading / yaw-rate loop (rudder) ----------------------------------
    const eYaw = wrap(desiredYaw - st.yaw);
    const rMax = h.rMax;
    const rDes = clamp(eYaw * G.kHeading, -rMax, rMax);
    const rudder = clamp(rDes / rMax + (G.kRate * (rDes - st.r)) / rMax, -1, 1);

    // --- low-speed lateral thruster assist while re-joining a station -------
    // A hull that has fallen far off track cannot close a large lateral error
    // with the rudder alone at low speed; a DP-equipped USV uses its bow
    // thruster / differential jets to crab back onto station.
    let lateral = 0;
    if (
      hasDP &&
      isNum(o.crossTrackErrorM) &&
      Math.abs(o.crossTrackErrorM) > 18 &&
      st.u < 3.6
    ) {
      const vLatGround = clamp(o.crossTrackErrorM * 0.05, -0.65, 0.65);
      const rel = st.yaw - (isNum(o.fleetYaw) ? o.fleetYaw : st.yaw);
      const vDes = vLatGround * Math.cos(rel);
      lateral = clamp(2.6 * (vDes - st.v), -1, 1);
    }

    mem.lastDist = dist;
    return {
      throttle,
      rudder,
      lateral,
      yawAux: 0,
      dpMode: false,
      dist,
      desiredYaw,
      desiredSpeed,
      rDes,
    };
  }

  return { control, reset, handling: h, params: p, hasDP };
}

/** Formation slot guidance in the fleet's path frame (used by Fleet). */
export function formationGuidance({
  state,
  slotTarget,
  forward,
  right,
  pathYaw,
  cruiseSpeedMS,
  maxSpeedMS,
}) {
  const ex = slotTarget.x - state.x;
  const ez = slotTarget.z - state.z;
  const errFwd = ex * forward.x + ez * forward.z; // + = slot ahead of the hull
  const errLat = ex * right.x + ez * right.z; // + = slot to starboard
  // A large lateral error still requires way (speed) on the hull to steer /
  // use the thrusters effectively — do not let a big astern error drag the
  // commanded speed down to idle while the hull is hundreds of metres abeam.
  const manoeuvreFloor = clamp(
    0.55 + Math.abs(errLat) * 0.007,
    0.55,
    Math.min(3.2, maxSpeedMS * 0.6),
  );
  const speed = clamp(
    cruiseSpeedMS + errFwd * 0.22,
    Math.max(0.35, cruiseSpeedMS * 0.35, manoeuvreFloor),
    Math.min(maxSpeedMS * 0.85, cruiseSpeedMS * 3),
  );
  const look = Math.max(28, cruiseSpeedMS * 6);
  const desiredYaw = pathYaw - clamp(Math.atan2(errLat, look), -0.5, 0.5);
  return { desiredYaw, desiredSpeedMS: speed, errFwd, errLat };
}
