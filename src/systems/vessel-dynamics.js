// =============================================================================
// vessel-dynamics.js — 3-DOF (surge / sway / yaw) USV manoeuvring model.
//
// Pure mathematics: no three.js, no DOM, no imports. One instance per hull; the
// Fleet controller feeds normalised throttle / rudder commands and reads back
// the integrated pose + velocity. This replaces the old "point mass follows a
// spring target" motion with a real hydrodynamic manoeuvring model: thrust lag,
// rudder servo, added mass, linear + quadratic damping, centripetal coupling and
// current-relative flow.
//
// ---------------------------------------------------------------------------
// FRAME / SIGN CONVENTION (identical to the scene and src/systems/formation.js)
// ---------------------------------------------------------------------------
//   world      : +X = east, -Z = north, +Y = up, metres.
//   body       : u = surge (bow), v = sway (starboard), r = yaw rate.
//   yaw ψ      : forward  f = ( cosψ, 0, -sinψ)
//                starboard s = ( sinψ, 0,  cosψ)
//                positive ψ / r = turn to PORT (left); ψ=0 → heading 090°.
//   kinematics : ẋ = cosψ·u + sinψ·v
//                ż = -sinψ·u + cosψ·v
//                ψ̇ = r
//   headingDeg = (90° - ψ·180/π) mod 360   (compass bearing, 0 = north)
//   u and v are ground-relative body velocity components; the water current is
//   removed internally to obtain the relative flow (u_r, v_r) used by drag and
//   rudder forces. Course (cogRad) and drift (driftRad) are reported in snapshot.
//
// ---------------------------------------------------------------------------
// EQUATIONS OF MOTION
// ---------------------------------------------------------------------------
//   m_x·u̇ = X − m_y·v·r          (a_f = u̇ + v·r in this frame)
//   m_y·v̇ = Y + m_x·u·r          (a_s = v̇ − u·r in this frame)
//   I_z·ṙ  = N
//
//   m_x = m + (−X_u̇)          inertia incl. surge added mass
//   m_y = m + (−Y_v̇)          inertia incl. sway added mass
//   I_z = m·k_zz² + (−N_ṙ)    yaw inertia incl. added inertia
//
//   X = T − X_u·u_r − X_uu·u_r·|u_r|                 surge resistance
//   Y = Y_δ − Y_v·v_r − Y_vv·v_r·|v_r|               sway resistance
//   N = a·Y_δ − N_r·r − N_rr·r·|r|                   yaw damping
//   Y_δ = K_δ·(u_r·|u_r|)·sin δ                      rudder side force
//   a   = rudder moment arm about the CG
//   u_r = u − current_forward,  v_r = v − current_starboard
//
//   Notes: (1) the centripetal terms give the steady-turn force balance
//              Y = −m_x·u·r: the hull must side-slip so that its inward
//              hydrodynamic force supplies the turn's centripetal force. The
//              signs are the correct ones for the left-handed body frame used
//              by the project (they are opposite to right-handed-textbook
//              notation); the direction of every term is covered by the
//              turning / straight-line self-tests.
//          (2) rudder force ∝ u_r²·sin δ, so steering authority vanishes with
//              speed: a stationary rudder-only hull can never spin on the spot.
//          (3) omitted on purpose: N_v (weathercock) and cross-added-mass
//              terms, heave/roll/pitch (those stay in the wave-attitude code).
//
//   Actuators (all stateful):
//     thrust : T_target = throttle ≥ 0 ? throttle·T_max : throttle·0.25·T_max,
//              first-order lag with engineTauS.
//     rudder : δ_target = rudder·δ_max (δ_max = 30°), first-order servo with
//              rudderTauS, then slew-limited to rudderRateDegS (25–40 °/s).
//     DP     : bow thruster / differential thrust (low-speed dynamic positioning,
//              cmd.lateral and cmd.yawAux):
//                Y += dpLateralForceN · lateral · thrusterEff(u)
//                N += dpYawMomentNm   · yawAux   · thrusterEff(u)
//              thrusterEff(u) = clamp(1 − |u|/(0.75·Umax), 0.08, 1): full
//              authority at rest, 8 % floor at 0.75·Umax and above, so a fast
//              hull is still rudder-dominated (DP yaw moment < 5 % of the
//              rudder moment at Umax). At rest a pure yawAux=1 gives
//              dpYawMomentNm/I_z = 0.06–0.12 rad/s² (≥ 0.05 required).
//
//   Integration: fixed semi-implicit Euler sub-steps of ≤0.01 s (h = dt/n,
//   n = ceil(dt/0.01)); frame dt is accepted over 0.005–0.1 s (clamped to
//   0.25 s), dt ≤ 0 never advances. All state is finite for any input.
//
// ---------------------------------------------------------------------------
// CLASS PARAMETER SUMMARY (design targets; measured values in selftest.mjs)
// ---------------------------------------------------------------------------
//   type      L(m)  B(m)  T(m)  m(t)  Umax(kn)  Tmax(kN)  cruiseThr  D/L@cruise  drift@cruise  yawTau(s)  engTau(s)  dpLat(kN)  dpYaw(kN·m)
//   flagship  30.0   9.4  1.70   95    20       76.0      0.250      4.0         8°            4.5        1.2        7.60       505
//   scout     10.5   3.0  0.62   3.5   24        8.1      0.222      4.5        13°            2.2        0.5        0.81       3.2
//   env       16.5   5.6  1.00   9.0   16        7.6      0.258      4.0         9°            3.0        0.8        0.60       23.5
//   survey    18.0   7.4  1.10  14.0   12        6.5      0.325      3.5         7°            3.2        1.0        0.52       51.6
//   patrol    14.5   4.7  0.90   7.5   22       12.2      0.221      4.0        11°            2.6        0.6        1.22       14.2
//   comms     19.0   6.2  1.15  18.0   14       11.1      0.282      4.2         7°            3.4        0.9        0.89       68.5
//   energy    20.0   7.0  1.20  26.0   12       11.5      0.300      4.5         7°            4.0        1.1        0.80       56.9
//   rescue    15.5   5.4  1.00   8.0   18        9.2      0.244      4.0         9°            2.8        0.7        0.83       17.6
//   (cruise = 6 kn = 3.0867 m/s for every class; rudder limit 30°, slew 25–40°/s;
//    added-mass ratios: surge 8–12 %, sway 55–85 %, yaw inertia 15–35 %.
//    dpLat = low-speed lateral thruster force at rest, dpYaw = low-speed auxiliary
//    yaw moment at rest; both fade to the 8 % floor at 0.75·Umax.)
//   Provenance of the coefficient table: artifacts/dynamics/derive-table.mjs.
//
//   MEASURED with selftest.mjs (141/141 PASS, all 8 classes):
//     0→80 % Umax            9.5–21.2 s          (target 8–25 s)
//     terminal speed         100.0 % Umax        (target ±3 %)
//     cruise turn Ø          3.56–4.64 L         (target 2.5–5 L)
//     cruise steady drift    6.9–12.9°           (target 5–15°)
//     full-throttle turn Ø   3.13–4.03 L, 20–43 % speed loss in the turn
//     hard-turn yaw rise     1.4–2.8 s (63 % of steady rate, quadratic yaw damping)
//     dt 0.005 / 0.02 / 0.1  < 0.01 % deviation vs dt 0.01 s
//     10 000-step full-throttle full-rudder run: finite and bounded
//     coast-down from full speed   86–198 m, ends < 1 % Umax
//     current drift: settles on the current vector, heading unaffected
//     DP channel at rest: lateral steady sway 0.04–0.35 m/s (matches the
//                         Y_drag solve), yawAux 0.06–0.12 rad/s² initial accel,
//                         0.107–0.164 rad/s steady yaw rate
//     DP station keeping in 0.45 kn / 210° current: max error 0.25–0.90 m over
//                         120 s, final error ≤ 0.02 m, 10 m recovery in 15–25 s
//     high speed: DP yaw moment ≤ 4.35 % of the rudder moment at Umax and a
//                 full-rudder turn changes ≤ 3.8 % with DP fully saturated
//
// ---------------------------------------------------------------------------
// FLEET-CONTROLLER INTEGRATION RECIPE
// ---------------------------------------------------------------------------
//   const dyn = createVesselDynamics(boat.type);         // once, at boot
//   dyn.reset({ x, z, yaw, u: dyn.params.cruiseSpeedMS }); // on station, at cruise
//
//   // every frame (dt from the render/sim loop, already ≤ 0.1 s):
//   const st = dyn.state;
//   const eYaw = wrapAngle(desiredYaw - st.yaw);          // desired course
//   const rudder = clamp(1.8 * eYaw - 0.5 * st.r, -1, 1); // P(D) heading loop
//   const desiredSpeed = ...;                             // from the formation
//   const throttle = clamp(
//     dyn.throttleForSpeed(desiredSpeed) + 1.2 * (desiredSpeed - st.u), 0, 1);
//   dyn.step(dt, { throttle, rudder });
//   rt.pos.x = st.x;  rt.pos.z = st.z;  rt.yaw = st.yaw;  // write back to the hull
//
//   // low-speed station keeping / dynamic positioning (the validated DP law;
//   // selftest 13.5 holds every class inside 0.9 m in a 0.45 kn current):
//   //   position P → desired ground velocity → body (uDes, vDes)
//   //   speed loop on throttle, lateral P on sway, rate-PD on yawAux:
//   const vwx = clamp((target.x - st.x) * 0.28, -0.6, 0.6);
//   const vwz = clamp((target.z - st.z) * 0.28, -0.6, 0.6);
//   const uDes = clamp(vwx * Math.cos(st.yaw) - vwz * Math.sin(st.yaw), -0.5, 0.4 * Umax);
//   const vDes = vwx * Math.sin(st.yaw) + vwz * Math.cos(st.yaw);
//   const throttle = clamp(dyn.throttleForSpeed(Math.max(0, uDes)) + 2.5 * (uDes - st.u), -1, 1);
//   const lateral  = clamp(3.0 * (vDes - st.v), -1, 1);
//   const rDes     = clamp(1.6 * wrapAngle(holdYaw - st.yaw), -0.45, 0.45);
//   const yawAux   = clamp(2.5 * (rDes - st.r), -1, 1);
//   dyn.step(dt, { throttle, rudder: 0, lateral, yawAux });   // heading into the current
//
//   Boat-specific gains: rudder 1.5–2.2 /rad (larger for the 2.2 s yaw-tau
//   scout, smaller for the 4.5 s flagship) and heading-rate damping 0.4–0.8.
//   Heave / pitch / roll continue to come from the shared wave sampler; this
//   model only replaces the horizontal motion. Current may be pushed in from
//   the sea state: dyn.setEnvironment({ currentX, currentZ }) (world m/s,
//   east / south).
// =============================================================================

const DEG = Math.PI / 180;
const TWO_PI = Math.PI * 2;
const KNOT = 0.514444; // m/s per knot

// Internal integration step (contract: ≤ 0.02 s). 0.01 s keeps the Euler
// integration error far below the measurement tolerance for every class.
const MAX_SUBSTEP_S = 0.01;
// Frame-dt safety clamp: the simulation loop never sends more than 0.1 s, but a
// paused/background tab must not be able to force a huge integration loop.
const MAX_FRAME_DT_S = 0.25;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const finiteOr = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const wrapAngle = (a) => {
  let x = a;
  while (x > Math.PI) x -= TWO_PI;
  while (x < -Math.PI) x += TWO_PI;
  return x;
};

// =============================================================================
// 1. Frozen class parameter table.
//
// Every coefficient below is a physical hydrodynamic/actuator constant:
//   massKg                     hull displacement m [kg]
//   addedMassSurgeKg           −X_u̇  surge added mass [kg]
//   addedMassSwayKg            −Y_v̇  sway added mass [kg]
//   addedYawInertiaKgm2        −N_ṙ  added yaw inertia [kg·m²]
//   yawRadiusGyrationM         k_zz  yaw radius of gyration [m]
//   maxSpeedMS                 design maximum speed over ground [m/s]
//   cruiseSpeedMS              fleet cruise speed (6 kn) [m/s]
//   maxThrustN                 T_max effective thrust at full ahead [N]
//   reverseThrustFrac          astern thrust fraction of T_max
//   engineTauS                 thrust first-order time constant [s]
//   dragSurgeLinearNPerMS      X_u   surge linear resistance [N/(m/s)]
//   dragSurgeQuadratic...      X_uu  surge quadratic resistance [N/(m/s)²]
//   dragSwayLinearNPerMS       Y_v   sway linear resistance [N/(m/s)]
//   dragSwayQuadratic...       Y_vv  sway quadratic resistance [N/(m/s)²]
//   dragYawLinearNms           N_r   yaw linear damping [N·m·s]
//   dragYawQuadraticNms2       N_rr  yaw quadratic damping [N·m·s²]
//   rudderMaxDeg               mechanical rudder limit [deg]
//   rudderRateDegS             maximum rudder slew rate [deg/s]
//   rudderTauS                 rudder servo first-order time constant [s]
//   rudderArmM                 a     rudder moment arm from CG [m]
//   rudderForceCoeffNPerM2     K_δ   rudder side-force coefficient (½ρA·C_Lα·wash)
//   yawTimeConstantS           I_z / N_r linear yaw time constant [s]
//   nominalTimeTo80PctS        design 0→80 % Umax acceleration time [s]
//   dpLateralForceN            bow-thruster / differential-thrust lateral force at
//                              full lateral=±1, zero speed (≈ 7–10 % of T_max) [N]
//   dpYawMomentNm              auxiliary (DP) yaw moment at full yawAux=±1, zero
//                              speed; sized as dpYawFrac·I_z so that pure yawAux=1
//                              yields dpYawFrac rad/s² (0.06–0.12 ≥ 0.05) [N·m]
// Both DP channels fade with speed through
//   thrusterEff(u) = clamp(1 − |u|/(0.75·Umax), 0.08, 1)
// so a fast hull is still steered by its rudder (DP moments are < 5 % of the
// rudder moment at Umax) while station-keeping at low speed gets real authority.
// =============================================================================
const CLASS_TABLE = {
  flagship: {
    // 30 m trimaran command ship, 95 t, 20 kn; 76 kN thrust; 4.0 L cruise turn
    lengthM: 30, beamM: 9.4, draftM: 1.7, massKg: 95000,
    maxSpeedMS: 10.2889, cruiseSpeedMS: 3.08666,
    maxThrustN: 75983.5, reverseThrustFrac: 0.25, engineTauS: 1.2,
    addedMassSurgeKg: 7600, addedMassSwayKg: 80750, addedYawInertiaKgm2: 1870310,
    yawRadiusGyrationM: 7.5,
    dragSurgeLinearNPerMS: 5612.61, dragSurgeQuadraticNPerM2S2: 172.264,
    dragSwayLinearNPerMS: 34347.9, dragSwayQuadraticNPerM2S2: 63342.9,
    dragYawLinearNms: 1603130, dragYawQuadraticNms2: 24929800,
    rudderMaxDeg: 30, rudderRateDegS: 25, rudderTauS: 0.45,
    rudderArmM: 14.1, rudderForceCoeffNPerM2: 2210.09,
    yawTimeConstantS: 4.5, nominalTimeTo80PctS: 20,
    dpLateralForceN: 7598.4, dpYawMomentNm: 504984,
  },
  scout: {
    // 10.5 m fast interceptor, 3.5 t, 24 kn; 8.1 kN thrust; 4.5 L cruise turn
    lengthM: 10.5, beamM: 3, draftM: 0.62, massKg: 3500,
    maxSpeedMS: 12.3467, cruiseSpeedMS: 3.08666,
    maxThrustN: 8056.04, reverseThrustFrac: 0.25, engineTauS: 0.5,
    addedMassSurgeKg: 420, addedMassSwayKg: 1925, addedYawInertiaKgm2: 3474.32,
    yawRadiusGyrationM: 2.5725,
    dragSurgeLinearNPerMS: 554.614, dragSurgeQuadraticNPerM2S2: 7.9271,
    dragSwayLinearNPerMS: 1522.83, dragSwayQuadraticNPerM2S2: 2136.97,
    dragYawLinearNms: 12107.5, dragYawQuadraticNms2: 74135.5,
    rudderMaxDeg: 30, rudderRateDegS: 40, rudderTauS: 0.22,
    rudderArmM: 4.83, rudderForceCoeffNPerM2: 123.751,
    yawTimeConstantS: 2.2, nominalTimeTo80PctS: 9,
    dpLateralForceN: 805.6, dpYawMomentNm: 3196.4,
  },
  env: {
    // 16.5 m environmental monitor, 9 t, 16 kn; 7.6 kN thrust; 4.0 L cruise turn
    lengthM: 16.5, beamM: 5.6, draftM: 1, massKg: 9000,
    maxSpeedMS: 8.2311, cruiseSpeedMS: 3.08666,
    maxThrustN: 7550.87, reverseThrustFrac: 0.25, engineTauS: 0.8,
    addedMassSurgeKg: 900, addedMassSwayKg: 6750, addedYawInertiaKgm2: 42879.4,
    yawRadiusGyrationM: 4.125,
    dragSurgeLinearNPerMS: 458.679, dragSurgeQuadraticNPerM2S2: 55.7251,
    dragSwayLinearNPerMS: 4860.09, dragSwayQuadraticNPerM2S2: 7953.03,
    dragYawLinearNms: 65340, dragYawQuadraticNms2: 558848,
    rudderMaxDeg: 30, rudderRateDegS: 32, rudderTauS: 0.3,
    rudderArmM: 7.755, rudderForceCoeffNPerM2: 297.781,
    yawTimeConstantS: 3, nominalTimeTo80PctS: 14,
    dpLateralForceN: 604.1, dpYawMomentNm: 23522,
  },
  survey: {
    // 18 m hydrographic catamaran, 14 t, 12 kn; 6.5 kN thrust; 3.5 L cruise turn
    lengthM: 18, beamM: 7.4, draftM: 1.1, massKg: 14000,
    maxSpeedMS: 6.17333, cruiseSpeedMS: 3.08666,
    maxThrustN: 6497.86, reverseThrustFrac: 0.25, engineTauS: 1,
    addedMassSurgeKg: 1680, addedMassSwayKg: 11900, addedYawInertiaKgm2: 99202.3,
    yawRadiusGyrationM: 4.86,
    dragSurgeLinearNPerMS: 315.771, dragSurgeQuadraticNPerM2S2: 119.352,
    dragSwayLinearNPerMS: 11708, dragSwayQuadraticNPerM2S2: 21624.5,
    dragYawLinearNms: 134336, dragYawQuadraticNms2: 1096740,
    rudderMaxDeg: 30, rudderRateDegS: 28, rudderTauS: 0.38,
    rudderArmM: 8.46, rudderForceCoeffNPerM2: 587.931,
    yawTimeConstantS: 3.2, nominalTimeTo80PctS: 18,
    dpLateralForceN: 519.8, dpYawMomentNm: 51585,
  },
  patrol: {
    // 14.5 m multi-role patrol boat, 7.5 t, 22 kn; 12.2 kN thrust; 4.0 L cruise turn
    lengthM: 14.5, beamM: 4.7, draftM: 0.9, massKg: 7500,
    maxSpeedMS: 11.3178, cruiseSpeedMS: 3.08666,
    maxThrustN: 12225.6, reverseThrustFrac: 0.25, engineTauS: 0.6,
    addedMassSurgeKg: 825, addedMassSwayKg: 4875, addedYawInertiaKgm2: 19710.9,
    yawRadiusGyrationM: 3.625,
    dragSurgeLinearNPerMS: 799.356, dragSurgeQuadraticNPerM2S2: 24.8154,
    dragSwayLinearNPerMS: 3545.33, dragSwayQuadraticNPerM2S2: 5318.12,
    dragYawLinearNms: 45486.8, dragYawQuadraticNms2: 341888,
    rudderMaxDeg: 30, rudderRateDegS: 36, rudderTauS: 0.26,
    rudderArmM: 6.67, rudderForceCoeffNPerM2: 274.268,
    yawTimeConstantS: 2.6, nominalTimeTo80PctS: 11,
    dpLateralForceN: 1222.6, dpYawMomentNm: 14192,
  },
  comms: {
    // 19 m communications relay, 18 t, 14 kn; 11.1 kN thrust; 4.2 L cruise turn
    lengthM: 19, beamM: 6.2, draftM: 1.15, massKg: 18000,
    maxSpeedMS: 7.20222, cruiseSpeedMS: 3.08666,
    maxThrustN: 11149.2, reverseThrustFrac: 0.25, engineTauS: 0.9,
    addedMassSurgeKg: 1800, addedMassSwayKg: 14400, addedYawInertiaKgm2: 131779,
    yawRadiusGyrationM: 4.94,
    dragSurgeLinearNPerMS: 619.208, dragSurgeQuadraticNPerM2S2: 128.962,
    dragSwayLinearNPerMS: 11403.1, dragSwayQuadraticNPerM2S2: 21061.4,
    dragYawLinearNms: 167954, dragYawQuadraticNms2: 1736860,
    rudderMaxDeg: 30, rudderRateDegS: 28, rudderTauS: 0.36,
    rudderArmM: 8.93, rudderForceCoeffNPerM2: 549.768,
    yawTimeConstantS: 3.4, nominalTimeTo80PctS: 16,
    dpLateralForceN: 891.9, dpYawMomentNm: 68525,
  },
  energy: {
    // 20 m energy-support vessel, 26 t, 12 kn; 11.5 kN thrust; 4.5 L cruise turn
    lengthM: 20, beamM: 7, draftM: 1.2, massKg: 26000,
    maxSpeedMS: 6.17333, cruiseSpeedMS: 3.08666,
    maxThrustN: 11466, reverseThrustFrac: 0.25, engineTauS: 1.1,
    addedMassSurgeKg: 2600, addedMassSwayKg: 22100, addedYawInertiaKgm2: 246064,
    yawRadiusGyrationM: 5.2,
    dragSurgeLinearNPerMS: 371.471, dragSurgeQuadraticNPerM2S2: 240.694,
    dragSwayLinearNPerMS: 14235.5, dragSwayQuadraticNPerM2S2: 26292.9,
    dragYawLinearNms: 237276, dragYawQuadraticNms2: 2767370,
    rudderMaxDeg: 30, rudderRateDegS: 25, rudderTauS: 0.42,
    rudderArmM: 9.4, rudderForceCoeffNPerM2: 654.224,
    yawTimeConstantS: 4, nominalTimeTo80PctS: 18,
    dpLateralForceN: 802.6, dpYawMomentNm: 56946,
  },
  rescue: {
    // 15.5 m SAR craft, 8 t, 18 kn; 9.2 kN thrust; 4.0 L cruise turn
    lengthM: 15.5, beamM: 5.4, draftM: 1, massKg: 8000,
    maxSpeedMS: 9.25999, cruiseSpeedMS: 3.08666,
    maxThrustN: 9236.39, reverseThrustFrac: 0.25, engineTauS: 0.7,
    addedMassSurgeKg: 880, addedMassSwayKg: 5600, addedYawInertiaKgm2: 26427.5,
    yawRadiusGyrationM: 3.875,
    dragSurgeLinearNPerMS: 598.471, dragSurgeQuadraticNPerM2S2: 43.0865,
    dragSwayLinearNPerMS: 4596.49, dragSwayQuadraticNPerM2S2: 7521.67,
    dragYawLinearNms: 52340.2, dragYawQuadraticNms2: 420531,
    rudderMaxDeg: 30, rudderRateDegS: 34, rudderTauS: 0.28,
    rudderArmM: 7.13, rudderForceCoeffNPerM2: 276.183,
    yawTimeConstantS: 2.8, nominalTimeTo80PctS: 12,
    dpLateralForceN: 831.3, dpYawMomentNm: 17586,
  },
};

// --- derived class data, frozen once at module load -------------------------
function finalizeClass(type, raw) {
  const u0 = raw.cruiseSpeedMS;
  const inertiaSurgeKg = raw.massKg + raw.addedMassSurgeKg;
  const inertiaSwayKg = raw.massKg + raw.addedMassSwayKg;
  const yawInertiaKgm2 = raw.massKg * raw.yawRadiusGyrationM * raw.yawRadiusGyrationM + raw.addedYawInertiaKgm2;

  // steady ahead throttle for cruise speed (still water feed-forward)
  const cruiseThrottle = clamp(
    (raw.dragSurgeLinearNPerMS * u0 + raw.dragSurgeQuadraticNPerM2S2 * u0 * u0) / raw.maxThrustN,
    0,
    1,
  );

  // Nominal full-rudder cruise turn: yaw-moment equilibrium
  //   a·K_δ·u0²·sin δ_max = N_r·r + N_rr·r²   →   solve the positive root.
  const deltaMax = raw.rudderMaxDeg * DEG;
  const yawMoment = raw.rudderArmM * raw.rudderForceCoeffNPerM2 * u0 * u0 * Math.sin(deltaMax);
  const quad = raw.dragYawQuadraticNms2;
  const lin = raw.dragYawLinearNms;
  const disc = lin * lin + 4 * quad * yawMoment;
  const r0 = (Math.sqrt(disc) - lin) / (2 * quad);

  // Nominal cruise drift: sway equilibrium  Y_v·v + Y_vv·v² = Y_δ + m_x·u0·r0
  const rudderSide = raw.rudderForceCoeffNPerM2 * u0 * u0 * Math.sin(deltaMax);
  const swayRhs = rudderSide + inertiaSurgeKg * u0 * r0;
  const swayLin = raw.dragSwayLinearNPerMS;
  const swayQuad = raw.dragSwayQuadraticNPerM2S2;
  const v0 = (Math.sqrt(swayLin * swayLin + 4 * swayQuad * swayRhs) - swayLin) / (2 * swayQuad);

  const sog0 = Math.hypot(u0, v0);
  const turnDiameterM = (2 * sog0) / r0;
  const turnDiameterL = turnDiameterM / raw.lengthM;

  return Object.freeze({
    type,
    lengthM: raw.lengthM,
    beamM: raw.beamM,
    draftM: raw.draftM,
    massKg: raw.massKg,
    maxSpeedMS: raw.maxSpeedMS,
    maxSpeedKn: raw.maxSpeedMS / KNOT,
    cruiseSpeedMS: raw.cruiseSpeedMS,
    cruiseSpeedKn: raw.cruiseSpeedMS / KNOT,
    maxThrustN: raw.maxThrustN,
    reverseThrustFrac: raw.reverseThrustFrac,
    engineTauS: raw.engineTauS,
    addedMassSurgeKg: raw.addedMassSurgeKg,
    addedMassSwayKg: raw.addedMassSwayKg,
    addedYawInertiaKgm2: raw.addedYawInertiaKgm2,
    yawRadiusGyrationM: raw.yawRadiusGyrationM,
    inertiaSurgeKg,
    inertiaSwayKg,
    yawInertiaKgm2,
    dragSurgeLinearNPerMS: raw.dragSurgeLinearNPerMS,
    dragSurgeQuadraticNPerM2S2: raw.dragSurgeQuadraticNPerM2S2,
    dragSwayLinearNPerMS: raw.dragSwayLinearNPerMS,
    dragSwayQuadraticNPerM2S2: raw.dragSwayQuadraticNPerM2S2,
    dragYawLinearNms: raw.dragYawLinearNms,
    dragYawQuadraticNms2: raw.dragYawQuadraticNms2,
    rudderMaxDeg: raw.rudderMaxDeg,
    rudderRateDegS: raw.rudderRateDegS,
    rudderTauS: raw.rudderTauS,
    rudderArmM: raw.rudderArmM,
    rudderForceCoeffNPerM2: raw.rudderForceCoeffNPerM2,
    yawTimeConstantS: raw.yawTimeConstantS,
    // low-speed DP actuators (bow thruster / differential thrust)
    dpLateralForceN: raw.dpLateralForceN,
    dpYawMomentNm: raw.dpYawMomentNm,
    dpLateralForceFrac: raw.dpLateralForceN / raw.maxThrustN,
    dpYawMomentFrac: raw.dpYawMomentNm / yawInertiaKgm2,
    dpYawAccelRadS2: raw.dpYawMomentNm / yawInertiaKgm2, // pure yawAux=1 at rest
    dpYawShareOfRudderAtUmax: ((0.08 * raw.dpYawMomentNm) /
      (raw.rudderArmM * raw.rudderForceCoeffNPerM2 * raw.maxSpeedMS * raw.maxSpeedMS * Math.sin(deltaMax))),
    // derived, informational (controller tuning / UI)
    cruiseThrottle,
    nominalTimeTo80PctS: raw.nominalTimeTo80PctS,
    cruiseTurnDiameterM: turnDiameterM,
    cruiseTurnDiameterL: turnDiameterL,
    turnRadiusCruiseM: turnDiameterM / 2,
    maxYawRateRadS: r0,
    nominalCruiseYawRateRadS: r0,
    nominalCruiseDriftDeg: (Math.atan2(v0, u0) * 180) / Math.PI,
  });
}

/** Frozen per-class parameter table for the eight fleet hull types. */
export const DYNAMICS_CLASS_PARAMS = Object.freeze(
  Object.keys(CLASS_TABLE).reduce((acc, key) => {
    acc[key] = finalizeClass(key, CLASS_TABLE[key]);
    return acc;
  }, {}),
);

// =============================================================================
// 2. Factory
// =============================================================================

/**
 * Create the 3-DOF manoeuvring model of one hull.
 *
 * @param {string} type  one of the DYNAMICS_CLASS_PARAMS keys
 *                       (flagship / scout / env / survey / patrol / comms / energy / rescue)
 * @param {{ current?: { x?: number, z?: number } }} [opts]
 *        optional initial water current in world m/s: x = east, z = south.
 * @returns {{
 *   params: object,
 *   reset: (state?: { x?: number, z?: number, yaw?: number, u?: number, v?: number, r?: number }) => void,
 *   setEnvironment: (env?: { currentX?: number, currentZ?: number }) => void,
 *   step: (dt: number, cmd?: { throttle?: number, rudder?: number }) => object,
 *   state: { x: number, z: number, yaw: number, u: number, v: number, r: number, throttle: number, rudder: number },
 *   snapshot: () => object,
 *   throttleForSpeed: (uMS: number) => number,
 * }}
 */
export function createVesselDynamics(type, opts = {}) {
  const params = DYNAMICS_CLASS_PARAMS[type];
  if (!params) {
    const known = Object.keys(DYNAMICS_CLASS_PARAMS).join(', ');
    throw new TypeError(`[vessel-dynamics] unknown vessel type "${String(type)}" — expected one of: ${known}`);
  }

  // --- constants hoisted out of the hot loop --------------------------------
  const inertiaSurge = params.inertiaSurgeKg;
  const inertiaSway = params.inertiaSwayKg;
  const inertiaYaw = params.yawInertiaKgm2;
  const thrustMax = params.maxThrustN;
  const thrustReverse = params.reverseThrustFrac * params.maxThrustN;
  const engineTau = params.engineTauS;
  const rudderTau = params.rudderTauS;
  const rudderMaxRad = params.rudderMaxDeg * DEG;
  const rudderRateRad = params.rudderRateDegS * DEG;
  const aArm = params.rudderArmM;
  const kDelta = params.rudderForceCoeffNPerM2;
  const dragSurgeLin = params.dragSurgeLinearNPerMS;
  const dragSurgeQuad = params.dragSurgeQuadraticNPerM2S2;
  const dragSwayLin = params.dragSwayLinearNPerMS;
  const dragSwayQuad = params.dragSwayQuadraticNPerM2S2;
  const dragYawLin = params.dragYawLinearNms;
  const dragYawQuad = params.dragYawQuadraticNms2;
  const maxSpeed = params.maxSpeedMS;
  const dpLateralForceN = params.dpLateralForceN; // low-speed lateral thruster [N]
  const dpYawMomentNm = params.dpYawMomentNm; // low-speed auxiliary yaw moment [N·m]
  // DP authority fades with speed: full at rest, 8 % floor at 0.75·Umax and above.
  const dpFadeSpeed = 0.75 * maxSpeed;

  // hard safety rails, far outside any physically reachable state
  const uRail = 1.5 * maxSpeed;
  const vRail = 1.5 * maxSpeed;
  const rRail = 3; // rad/s (~172 °/s)

  // --- mutable state ---------------------------------------------------------
  let currentX = finiteOr(opts?.current?.x, 0);
  let currentZ = finiteOr(opts?.current?.z, 0);

  const state = {
    x: 0,
    z: 0,
    yaw: 0,
    u: 0,
    v: 0,
    r: 0,
    throttle: 0, // actual engine thrust ratio: −0.25 … 1
    rudder: 0, // actual rudder deflection: −1 … 1 (of 30°)
    lateral: 0, // low-speed DP lateral thrust: −1 … 1
    yawAux: 0, // low-speed DP auxiliary yaw moment: −1 … 1
  };

  let thrustN = 0; // actual thrust [N], first-order lag from the engine
  let rudderRad = 0; // actual rudder angle [rad]
  let lateralCmd = 0; // last accepted normalized lateral thruster command
  let yawAuxCmd = 0; // last accepted normalized auxiliary yaw command
  let thrusterEff = 1; // speed-dependent DP authority at the current state

  // last validated pose, restored if a numerical accident ever slips through
  const guard = { x: 0, z: 0, yaw: 0, u: 0, v: 0, r: 0, thrustN: 0, rudderRad: 0, lateralCmd: 0, yawAuxCmd: 0 };

  /**
   * Place the hull and (optionally) give it an initial velocity.
   * Actuator states (engine thrust, rudder angle, DP thruster commands) are cleared.
   */
  function reset(initial = {}) {
    state.x = finiteOr(initial?.x, 0);
    state.z = finiteOr(initial?.z, 0);
    state.yaw = wrapAngle(finiteOr(initial?.yaw, 0));
    state.u = finiteOr(initial?.u, 0);
    state.v = finiteOr(initial?.v, 0);
    state.r = finiteOr(initial?.r, 0);
    thrustN = 0;
    rudderRad = 0;
    lateralCmd = 0;
    yawAuxCmd = 0;
    thrusterEff = 1;
    state.throttle = 0;
    state.rudder = 0;
    state.lateral = 0;
    state.yawAux = 0;
  }

  /** Set the ambient water current (world frame, m/s: +x east, +z south). */
  function setEnvironment(env = {}) {
    currentX = finiteOr(env?.currentX, 0);
    currentZ = finiteOr(env?.currentZ, 0);
  }

  // --- one integration sub-step (h ≤ 0.02 s) --------------------------------
  function substep(h, kEngine, kRudder, throttleCmd, rudderCmd) {
    // 1. propulsion: first-order engine lag, bounded ahead / astern thrust
    const thrustTarget = throttleCmd >= 0 ? throttleCmd * thrustMax : throttleCmd * thrustReverse;
    thrustN += (thrustTarget - thrustN) * kEngine;

    // 2. rudder servo: first-order response + slew-rate limit + mechanical stop
    const rudderTarget = rudderCmd * rudderMaxRad;
    const maxDelta = rudderRateRad * h;
    let dRudder = (rudderTarget - rudderRad) * kRudder;
    if (dRudder > maxDelta) dRudder = maxDelta;
    else if (dRudder < -maxDelta) dRudder = -maxDelta;
    rudderRad += dRudder;
    if (rudderRad > rudderMaxRad) rudderRad = rudderMaxRad;
    else if (rudderRad < -rudderMaxRad) rudderRad = -rudderMaxRad;

    // 3. relative flow through the water (current removed in the body frame)
    const cosY = Math.cos(state.yaw);
    const sinY = Math.sin(state.yaw);
    const currentFwd = currentX * cosY - currentZ * sinY;
    const currentStbd = currentX * sinY + currentZ * cosY;
    const uR = state.u - currentFwd;
    const vR = state.v - currentStbd;

    // 4. low-speed DP thruster authority: full authority in DP, ramp down to an
    // 8 % floor at 0.75·Umax so that a fast hull is steered by the rudder only.
    thrusterEff = clamp(1 - Math.abs(state.u) / dpFadeSpeed, 0.08, 1);
    const dpLateralForce = dpLateralForceN * lateralCmd * thrusterEff;
    const dpYawMoment = dpYawMomentNm * yawAuxCmd * thrusterEff;

    // 5. forces / moments (hull hydrodynamics + rudder + DP actuators)
    const absUR = Math.abs(uR);
    const surgeForce = thrustN - dragSurgeLin * uR - dragSurgeQuad * uR * absUR;
    const rudderSurge = uR * absUR; // sign kept so astern flow reverses steering
    const rudderSide = kDelta * rudderSurge * Math.sin(rudderRad);
    const swayForce = rudderSide + dpLateralForce - dragSwayLin * vR - dragSwayQuad * vR * Math.abs(vR);
    const yawMoment =
      aArm * rudderSide + dpYawMoment - dragYawLin * state.r - dragYawQuad * state.r * Math.abs(state.r);

    // 6. accelerations (added mass + centripetal coupling for this frame)
    const du = (surgeForce - inertiaSway * state.v * state.r) / inertiaSurge;
    const dv = (swayForce + inertiaSurge * state.u * state.r) / inertiaSway;
    const dr = yawMoment / inertiaYaw;

    // 7. semi-implicit Euler on velocities, then kinematics
    state.u += du * h;
    state.v += dv * h;
    state.r += dr * h;
    if (state.u > uRail) state.u = uRail;
    else if (state.u < -uRail) state.u = -uRail;
    if (state.v > vRail) state.v = vRail;
    else if (state.v < -vRail) state.v = -vRail;
    if (state.r > rRail) state.r = rRail;
    else if (state.r < -rRail) state.r = -rRail;
    state.x += (cosY * state.u + sinY * state.v) * h;
    state.z += (-sinY * state.u + cosY * state.v) * h;
    state.yaw += state.r * h;
    if (state.yaw > Math.PI) state.yaw -= TWO_PI;
    else if (state.yaw < -Math.PI) state.yaw += TWO_PI;
  }

  /**
   * Advance the model by `dt` seconds with normalised commands.
   *   throttle ∈ [-1, 1]  main propulsion (negative = astern)
   *   rudder   ∈ [-1, 1]  main rudder (+1 = full to port = positive yaw)
   *   lateral  ∈ [-1, 1]  low-speed DP bow thruster / differential thrust
   *                       (positive = force to starboard), optional, default 0
   *   yawAux   ∈ [-1, 1]  low-speed DP auxiliary yaw moment
   *                       (positive = bow to port = positive yaw), optional, default 0
   * The DP channels are only allowed to dominate at low speed: their authority
   * is scaled by thrusterEff(u) (100 % at rest → 8 % at 0.75·Umax and above).
   * dt ≤ 0 or non-finite dt is a no-op.
   */
  function step(dt, cmd) {
    if (!(dt > 0) || !Number.isFinite(dt)) return state; // paused / invalid frame
    const frameDt = Math.min(dt, MAX_FRAME_DT_S);
    const throttleCmd = clamp(finiteOr(cmd?.throttle, 0), -1, 1);
    const rudderCmd = clamp(finiteOr(cmd?.rudder, 0), -1, 1);
    lateralCmd = clamp(finiteOr(cmd?.lateral, 0), -1, 1);
    yawAuxCmd = clamp(finiteOr(cmd?.yawAux, 0), -1, 1);

    const n = Math.max(1, Math.ceil(frameDt / MAX_SUBSTEP_S));
    const h = frameDt / n;
    const kEngine = 1 - Math.exp(-h / engineTau);
    const kRudder = 1 - Math.exp(-h / rudderTau);

    // remember the last good state, then integrate
    guard.x = state.x;
    guard.z = state.z;
    guard.yaw = state.yaw;
    guard.u = state.u;
    guard.v = state.v;
    guard.r = state.r;
    guard.thrustN = thrustN;
    guard.rudderRad = rudderRad;
    guard.lateralCmd = lateralCmd;
    guard.yawAuxCmd = yawAuxCmd;

    for (let i = 0; i < n; i++) substep(h, kEngine, kRudder, throttleCmd, rudderCmd);

    // defensive: the model is passive and bounded, so this never triggers with
    // finite inputs, but a corrupted state must never leak out to the scene.
    if (!Number.isFinite(state.x + state.z + state.yaw + state.u + state.v + state.r)) {
      state.x = guard.x;
      state.z = guard.z;
      state.yaw = guard.yaw;
      state.u = guard.u;
      state.v = guard.v;
      state.r = guard.r;
      thrustN = guard.thrustN;
      rudderRad = guard.rudderRad;
      lateralCmd = guard.lateralCmd;
      yawAuxCmd = guard.yawAuxCmd;
    }

    state.throttle = thrustN / thrustMax;
    state.rudder = rudderRad / rudderMaxRad;
    state.lateral = lateralCmd;
    state.yawAux = yawAuxCmd;
    return state;
  }

  /**
   * Telemetry snapshot (fresh object, all values finite).
   *   x, z          world position [m]
   *   yaw           yaw angle [rad], forward = (cos yaw, 0, -sin yaw)
   *   u, v, r       surge / sway / yaw-rate body velocities
   *   sogMS         speed over ground [m/s]
   *   cogRad        course over ground in the yaw convention [rad]
   *   driftRad      signed drift = yaw - cog [rad]; > 0 = crabbing to starboard
   *   rudderDeg     actual rudder angle [deg], −30 … 30
   *   throttlePct   actual thrust level [%], 0 … 100 (reverse reported as 0)
   *   yawRateRadS   yaw rate [rad/s] (same as r, for telemetry symmetry)
   *   lateral       applied DP lateral command [−1 … 1] (positive = starboard)
   *   yawAux        applied DP auxiliary yaw command [−1 … 1] (positive = port)
   * Added (not required by the contract, useful for the console):
   *   headingDeg, speedThroughWaterMS, thrustPctSigned, turnRadM,
   *   lateralPct, yawAuxPct, thrusterEff
   */
  function snapshot() {
    const cosY = Math.cos(state.yaw);
    const sinY = Math.sin(state.yaw);
    const worldVx = cosY * state.u + sinY * state.v;
    const worldVz = -sinY * state.u + cosY * state.v;
    const sog = Math.hypot(worldVx, worldVz);
    const cog = sog > 1e-9 ? Math.atan2(-worldVz, worldVx) : state.yaw;
    const drift = wrapAngle(state.yaw - cog);
    const thrustPct = (thrustN / thrustMax) * 100;
    return {
      x: state.x,
      z: state.z,
      yaw: state.yaw,
      u: state.u,
      v: state.v,
      r: state.r,
      sogMS: sog,
      cogRad: cog,
      driftRad: drift,
      rudderDeg: rudderRad / DEG,
      throttlePct: clamp(thrustPct, 0, 100),
      yawRateRadS: state.r,
      lateral: lateralCmd,
      yawAux: yawAuxCmd,
      // --- additive diagnostics ---------------------------------------------
      headingDeg: (((90 - (state.yaw * 180) / Math.PI) % 360) + 360) % 360,
      speedThroughWaterMS: Math.hypot(
        state.u - (currentX * cosY - currentZ * sinY),
        state.v - (currentX * sinY + currentZ * cosY),
      ),
      thrustPctSigned: thrustPct,
      turnRadM: Math.abs(state.r) > 1e-6 ? sog / Math.abs(state.r) : 0,
      lateralPct: lateralCmd * 100,
      yawAuxPct: yawAuxCmd * 100,
      thrusterEff,
    };
  }

  /**
   * Steady-state ahead throttle that settles the hull at `uMS` m/s in still
   * water: solves  T_max·throttle = X_u·u + X_uu·u².
   * Returns 0 for u ≤ 0 and 1 for u ≥ Umax. Add speed feedback on top when
   * operating in current or while turning.
   */
  function throttleForSpeed(uMS) {
    const u = Number(uMS);
    if (!Number.isFinite(u) || u <= 0) return 0;
    if (u >= maxSpeed) return 1;
    const t = (dragSurgeLin * u + dragSurgeQuad * u * u) / thrustMax;
    return clamp(t, 0, 1);
  }

  return Object.freeze({
    params,
    reset,
    setEnvironment,
    step,
    snapshot,
    throttleForSpeed,
    /** Live internal state (read-only by convention; do not mutate). */
    get state() {
      return state;
    },
  });
}
