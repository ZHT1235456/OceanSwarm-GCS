// =============================================================================
// OceanSwarm GCS — telemetry model.
//
// Consumes the scene truth (`sceneProvider.getSceneState()`, docs §4.4) and
// reconstructs what a real GCS receives over the data link: position, attitude,
// speed over ground, battery / power / thermal state, data-link quality, payload
// switches, water depth, sea state and mission progress.
//
// Everything is advanced in fixed 100 ms steps so two runs with the same seed
// produce the same numbers regardless of the renderer frame rate.
// =============================================================================

import { clamp, normalizeDeg, angleDeltaDeg, round1, round2, safeNumber } from './format.js';
import { createRng, createDrift, hash01 } from './prng.js';

const KNOTS_PER_MS = 1.9438444924406; // 1 m/s = 1.9438 kn
const FIXED_STEP = 0.1;
const DEG = Math.PI / 180;

// --- scenario seed data -------------------------------------------------------
// Initial battery charge by class (%). scout-2 is deliberately degraded to 23.8 %
// so the console opens with exactly one low-battery alarm (docs §8 example).
const BATTERY_BASE = {
  flagship: 93.6,
  scout: 88.0,
  env: 90.0,
  survey: 89.0,
  patrol: 85.0,
  comms: 92.4,
  energy: 96.2,
  rescue: 87.5,
};

const LOW_BATTERY_VESSEL = { id: 'scout-2', pct: 23.8 };

// Nominal battery drain, % per second at 1x cruise (slightly above real boats so
// a demo run visibly moves the number).
const DRAIN_RATE = {
  flagship: 0.0022,
  scout: 0.0044,
  env: 0.0033,
  survey: 0.0031,
  patrol: 0.0037,
  comms: 0.0025,
  energy: 0.0015,
  rescue: 0.0034,
};

// energy-support boats generate while under way: net positive at cruise.
const CHARGE_RATE = { energy: 0.0019 };

// Seeded link-degradation windows: one boat at a time loses MESH margin so the
// 链路延时 alarm can occur naturally (docs acceptance: link alarm must exist).
const DEGRADATION = { startSec: 48, cycleSec: 170, durationSec: 24 };

// Speed over ground is derived from the commanded fleet speed (the scene truth)
// with small per-class offsets, so the roster reads as one coherent formation
// instead of 17 independently measured values. Single-vessel autonomous modes
// get the mission-planning speeds from docs §6.8.
const SOG_FACTOR = {
  flagship: 1.0,
  scout: 1.08,
  env: 0.94,
  survey: 0.97,
  patrol: 1.05,
  comms: 1.0,
  energy: 0.91,
  rescue: 1.03,
};
const SOG_AUTO_KN = 12.2; // swarm-control vessel.goto speed 6.6 m/s
const SOG_VESSEL_RTL_KN = 7.6;
const SOG_HOLD_KN = 0.4; // idle boats still ride the swell

// Approximate bathymetry around the inherited scene landmarks (fallback only —
// the sim has no bathymetry channel from the scene).
const SHOALS = [
  { x: 2350, z: 720, rx: 830, rz: 650, strength: 1.0 },
  { x: 1780, z: 400, rx: 430, rz: 330, strength: 0.6 },
  { x: 1420, z: -2220, rx: 470, rz: 470, strength: 0.8 },
  { x: 3350, z: 1050, rx: 320, rz: 230, strength: 0.45 },
];

const FLEET_MODE_KEYS = new Set(['cruise', 'hold', 'uturn', 'rtl', 'estop']);
const VESSEL_MODE_KEYS = new Set(['formation', 'auto', 'hold', 'rtl', 'manual']);

function headingFromYaw(yawRad) {
  // scene forward = (cos yaw, 0, -sin yaw); north = -Z, east = +X
  return normalizeDeg(Math.atan2(Math.cos(yawRad), Math.sin(yawRad)) / DEG);
}

function yawFromHeading(headingDeg) {
  return normalizeDeg(90 - headingDeg) * DEG;
}

/** Normalise an angle difference to (-180, 180]. */
function normalizeSignedDeg(deg) {
  const value = normalizeDeg(deg);
  return value > 180 ? value - 360 : value;
}

function waterDepthAt(x, z) {
  let depth = 44 + 9 * Math.sin(x / 640 + 1.7) + 6 * Math.sin(z / 480 + 0.4) + 3 * Math.sin((x + z) / 310);
  for (const s of SHOALS) {
    const e = Math.hypot((x - s.x) / s.rx, (z - s.z) / s.rz);
    if (e < 1) depth -= (1 - e) * s.strength * 36;
  }
  return clamp(depth, 2.5, 92);
}

/**
 * @param {object} config
 * @param {object} config.domain            createDomain() result
 * @param {number} config.seed              uint32 seed
 * @param {object} config.clock             createClock() instance
 * @param {object} [config.options]
 * @param {object} [config.initialSceneState]
 */
export function createTelemetryModel({ domain, seed, clock, options = {}, initialSceneState = null }) {
  const telemetryRng = createRng((seed ^ 0x2f6e2b1) >>> 0);
  const linkRng = createRng((seed ^ 0x6ac690c5) >>> 0);
  const envRng = createRng((seed ^ 0x1b873593) >>> 0);
  const seedBase = seed >>> 0;

  const initial = initialSceneState && typeof initialSceneState === 'object' ? initialSceneState : null;
  const initialFleet = (initial && initial.fleet) || {};
  const sceneT0 = Number.isFinite(initial?.simTime) ? initial.simTime : 0;

  // --- environment drifts (slow, deterministic, no gameplay meaning) ---------
  const waveDrift = createDrift(envRng, [
    { amplitude: 0.16, periodSec: 97 },
    { amplitude: 0.07, periodSec: 37 },
  ]);
  const windDrift = createDrift(envRng, [
    { amplitude: 2.8, periodSec: 211 },
    { amplitude: 1.1, periodSec: 53 },
  ]);
  const windDirDrift = createDrift(envRng, [
    { amplitude: 12, periodSec: 263 },
    { amplitude: 5, periodSec: 89 },
  ]);
  const visibilityDrift = createDrift(envRng, [
    { amplitude: 1.3, periodSec: 307 },
    { amplitude: 0.4, periodSec: 61 },
  ]);
  const tempDrift = createDrift(envRng, [{ amplitude: 0.28, periodSec: 401 }]);
  const currentDrift = createDrift(envRng, [
    { amplitude: 0.1, periodSec: 143 },
    { amplitude: 0.04, periodSec: 47 },
  ]);
  const currentDirDrift = createDrift(envRng, [{ amplitude: 16, periodSec: 181 }]);
  const tideDrift = createDrift(envRng, [{ amplitude: 0.32, periodSec: 900 }]);

  const initialCenter = {
    x: Number.isFinite(initialFleet.centerX) ? initialFleet.centerX : 0,
    z: Number.isFinite(initialFleet.centerZ) ? initialFleet.centerZ : 0,
  };
  const initialFleetYaw = Number.isFinite(initialFleet.yawRad)
    ? initialFleet.yawRad
    : Number.isFinite(initialFleet.headingDeg)
      ? yawFromHeading(initialFleet.headingDeg)
      : 0;

  const overrides = {
    batteryPct: new Map(),
    linkLatencyMs: new Map(),
    offline: new Map(),
    stationErrorM: new Map(),
  };

  // --- vessel state ----------------------------------------------------------
  const forcedLowId = pickForcedLowVessel(domain);
  const vessels = domain.roster.map((spec, index) => {
    const sceneVessel = findSceneVessel(initial, spec.id);
    const position = resolveInitialPosition(sceneVessel, spec, initialCenter, initialFleetYaw);
    const batteryPct = initialBattery(spec, forcedLowId, telemetryRng);
    const sensors = spec.sensors.map((sensor) => ({ ...sensor }));
    const linkPhase = linkRng.phase();
    return {
      spec,
      index,
      x: position.x,
      z: position.z,
      prevX: position.x,
      prevZ: position.z,
      yawRad: Number.isFinite(sceneVessel?.yawRad) ? sceneVessel.yawRad : initialFleetYaw,
      prevYawRad: Number.isFinite(sceneVessel?.yawRad) ? sceneVessel.yawRad : initialFleetYaw,
      headingDeg: Number.isFinite(sceneVessel?.headingDeg)
        ? normalizeDeg(sceneVessel.headingDeg)
        : headingFromYaw(Number.isFinite(sceneVessel?.yawRad) ? sceneVessel.yawRad : initialFleetYaw),
      cogDeg: 0,
      driftDeg: 0,
      pitchDeg: safeNumber(sceneVessel?.pitchRad, 0) / DEG,
      rollDeg: safeNumber(sceneVessel?.rollRad, 0) / DEG,
      heaveM: safeNumber(sceneVessel?.heaveM, 0),
      sogKn: 0,
      sogFactor: clamp((SOG_FACTOR[spec.type] ?? 1) + telemetryRng.range(-0.025, 0.025), 0.8, 1.2),
      // --- 3-DOF manoeuvring telemetry (task-8, scene truth pass-through) -----
      // sceneSogMS is NaN when the scene does not provide real dynamics, in
      // which case the legacy fleet-speed × class-factor estimate is used.
      sceneSogMS: NaN,
      uMS: 0,
      swayMS: 0,
      sceneCogDeg: NaN,
      sceneDriftDeg: NaN,
      hasSceneCog: false,
      yawRateDegS: 0,
      rudderDeg: 0,
      throttlePct: 0,
      hasSceneDynamics: false,
      speedNoisePhase: telemetryRng.phase(),
      sceneMode: normalizeSceneMode(sceneVessel?.mode),
      waypoint: normalizeWaypoint(sceneVessel?.waypoint),
      batteryPct,
      drainPctPerMin: 0.3,
      powerKw: 0,
      voltageV: 50.4,
      currentA: 0,
      tempC: 26,
      cpuPct: 30,
      link: { rssiDbm: -52, latencyMs: 42, lossPct: 0.1, type: 'MESH', quality: 0.9 },
      sensors,
      uptimeSec: Math.round(5400 + index * 311 + telemetryRng.range(0, 400)),
      depthM: 40,
      distToFleetM: 0,
      stationErrorM: 0,
      stationSource: 'none',
      offline: false,
      // smooth per-vessel noise phases
      noisePhases: {
        sog: telemetryRng.phase(),
        power: telemetryRng.phase(),
        temp: telemetryRng.phase(),
        cpu: telemetryRng.phase(),
        depth: telemetryRng.phase(),
        latency: linkPhase,
        latency2: linkRng.phase(),
        rssi: linkRng.phase(),
        loss: linkRng.phase(),
      },
      baseLinkLatency: 0,
    };
  });
  const vesselById = new Map(vessels.map((v) => [v.spec.id, v]));

  // --- top-level state -------------------------------------------------------
  const model = {
    t: 0,
    met: clock.metOffset,
    sceneT0,
    totalSteps: 0,
    estopActive: false,
    estopSinceT: null,
    fleet: {
      centerX: initialCenter.x,
      centerZ: initialCenter.z,
      headingDeg: normalizeDeg(initialFleet.headingDeg),
      yawRad: initialFleetYaw,
      speedKn: Number.isFinite(initialFleet.speedKn) ? Math.max(0, initialFleet.speedKn) : 6,
      speedScale: Number.isFinite(initialFleet.speedScale) ? initialFleet.speedScale : 1,
      speedKnMax: 6,
      mode: 'cruise',
      formationKey: typeof initialFleet.formationKey === 'string' ? initialFleet.formationKey : 'wedge',
      formationText: typeof initialFleet.formationText === 'string' ? initialFleet.formationText : '',
      rtlDistanceM: null,
    },
    // commanded / scene-reported fleet speed used by the legacy fallback only;
    // the public fleet.speedKn becomes the mean ground speed of all 17 boats.
    sceneFleetSpeed: Number.isFinite(initialFleet.speedKn) ? Math.max(0, initialFleet.speedKn) : 6,
    dynamicsActive: false,
    sea: {
      state: 3,
      waveHeightM: 0.8,
      windKn: 12,
      windDirDeg: 45,
      visibilityKm: 8.6,
      waterTempC: 26.8,
      currentKn: 0.42,
      currentDirDeg: 222,
      tideM: 0.62,
    },
    mission: {
      id: domain.mission.id,
      name: domain.mission.name,
      en: domain.mission.en,
      area: domain.mission.area,
      phaseIndex: 0,
      phaseCount: domain.mission.phases.length,
      phaseName: '',
      phaseEn: '',
      phaseProgress: 0,
      overallProgress: 0,
      waypointIndex: 0,
      waypointTotal: domain.mission.waypoints.length,
      waypointName: '',
      waypointId: '',
      etaSec: 0,
    },
    stepAccumulator: 0,
    lastSceneState: initial,
    missingFrames: 0,
    lastStepMs: 0,
  };

  // --- initial telemetry ----------------------------------------------------
  applyFleetState(initialFleet, 0);
  for (const vessel of vessels) {
    if (initial) applyVesselSceneState(vessel, initial, 0);
    vessel.depthM = round1(waterDepthAt(vessel.x, vessel.z));
    if (vessel.hasSceneDynamics) {
      vessel.sogKn = round1(clamp(vessel.sceneSogMS * KNOTS_PER_MS, 0, 40));
      if (vessel.hasSceneCog) vessel.cogDeg = vessel.sceneCogDeg;
      const driftRad = (vessel.driftDeg * Math.PI) / 180;
      if (!Number.isFinite(vessel.uMS)) vessel.uMS = vessel.sceneSogMS * Math.cos(driftRad);
      if (!Number.isFinite(vessel.swayMS)) vessel.swayMS = vessel.sceneSogMS * Math.sin(driftRad);
    } else {
      vessel.sogKn = round1(model.sceneFleetSpeed * vessel.sogFactor);
      vessel.cogDeg = vessel.headingDeg;
      vessel.uMS = vessel.sogKn / KNOTS_PER_MS;
      vessel.swayMS = 0;
    }
    updateLink(vessel, 0);
    // Converge the power / thermal filters to the cruise operating point so the
    // opening snapshot already reads like a settled console (not a cold start).
    updatePower(vessel, 20, telemetryRng);
    vessel.drainPctPerMin = Math.max(0.02, (DRAIN_RATE[vessel.spec.type] || 0.003) * batteryLoadFactor(vessel) * 60);
  }
  model.dynamicsActive = vessels.some((v) => v.hasSceneDynamics);
  recomputeStationErrors();
  updateSea(0);
  updateMission(clock.metOffset);

  // --- helpers --------------------------------------------------------------
  function initialBattery(spec, forcedId, rng) {
    if (spec.id === forcedId) return LOW_BATTERY_VESSEL.pct;
    const base = BATTERY_BASE[spec.type] ?? 88;
    return round1(clamp(base + rng.range(-2.4, 2.8), 55, 99));
  }

  function pickForcedLowVessel(dom) {
    if (dom.byId.has(LOW_BATTERY_VESSEL.id)) return LOW_BATTERY_VESSEL.id;
    const scout = dom.roster.find((v) => v.type === 'scout');
    return scout ? scout.id : dom.roster[0] ? dom.roster[0].id : null;
  }

  function findSceneVessel(sceneState, id) {
    const list = sceneState && Array.isArray(sceneState.vessels) ? sceneState.vessels : null;
    if (!list) return null;
    for (const v of list) if (v && v.id === id) return v;
    return null;
  }

  function resolveInitialPosition(sceneVessel, spec, center, yaw) {
    if (sceneVessel && Number.isFinite(sceneVessel.x) && Number.isFinite(sceneVessel.z)) {
      return { x: sceneVessel.x, z: sceneVessel.z };
    }
    const offset = Array.isArray(spec.offset) ? spec.offset : [0, 0];
    const forward = { x: Math.cos(yaw), z: -Math.sin(yaw) };
    const right = { x: Math.sin(yaw), z: Math.cos(yaw) };
    return {
      x: center.x + right.x * offset[0] + forward.x * offset[1],
      z: center.z + right.z * offset[0] + forward.z * offset[1],
    };
  }

  function normalizeSceneMode(mode) {
    const value = typeof mode === 'string' ? mode : '';
    return VESSEL_MODE_KEYS.has(value) ? value : 'formation';
  }

  function normalizeWaypoint(waypoint) {
    if (!waypoint || typeof waypoint !== 'object') return null;
    if (!Number.isFinite(waypoint.x) || !Number.isFinite(waypoint.z)) return null;
    return { x: waypoint.x, z: waypoint.z };
  }

  function normalizedFleetMode(rawMode, estopActive) {
    if (estopActive) return 'estop';
    const value = typeof rawMode === 'string' ? rawMode : '';
    return FLEET_MODE_KEYS.has(value) ? value : 'cruise';
  }

  function applyFleetState(sceneFleet, dt) {
    const f = sceneFleet && typeof sceneFleet === 'object' ? sceneFleet : {};
    const estopActive = !!f.estopActive || f.mode === 'estop';
    if (estopActive && !model.estopActive) model.estopSinceT = model.t;
    if (!estopActive) model.estopSinceT = null;
    model.estopActive = estopActive;
    model.formationTransition = f.formationTransition === true;
    model.manoeuvring = f.manoeuvring === true || model.formationTransition;

    const centerX = Number.isFinite(f.centerX) ? f.centerX : model.fleet.centerX;
    const centerZ = Number.isFinite(f.centerZ) ? f.centerZ : model.fleet.centerZ;

    // Heading: prefer the scene value, else derive from motion, else keep.
    let headingDeg = Number.isFinite(f.headingDeg) ? normalizeDeg(f.headingDeg) : model.fleet.headingDeg;
    if (!Number.isFinite(f.headingDeg) && dt > 0) {
      const dx = centerX - model.fleet.centerX;
      const dz = centerZ - model.fleet.centerZ;
      if (Math.hypot(dx, dz) > 0.02) headingDeg = normalizeDeg(Math.atan2(dx, -dz) / DEG);
    }
    const yawRad = Number.isFinite(f.yawRad)
      ? f.yawRad
      : Number.isFinite(f.headingDeg)
        ? yawFromHeading(f.headingDeg)
        : model.fleet.yawRad;

    // Speed: the scene reports knots; fall back to measured centre velocity.
    // This is the COMMANDED/scene-level speed. The public snapshot fleet.speedKn
    // is the mean ground speed of the 17 hulls (computed by the snapshot builder
    // from the real per-vessel telemetry), so real acceleration shows up there.
    let speedKn = Number.isFinite(f.speedKn) ? Math.max(0, f.speedKn) : NaN;
    if (!Number.isFinite(speedKn) && dt > 0) {
      const dx = centerX - model.fleet.centerX;
      const dz = centerZ - model.fleet.centerZ;
      speedKn = (Math.hypot(dx, dz) / dt) * KNOTS_PER_MS;
    }
    if (!Number.isFinite(speedKn)) speedKn = model.sceneFleetSpeed;
    model.sceneFleetSpeed = clamp(speedKn, 0, 40);
    const speedScale = Number.isFinite(f.speedScale) ? f.speedScale : model.fleet.speedScale;

    // Cruise speed reference (1x) — 6.0 kn by contract. With a real 3-DOF scene
    // the mean speed varies during acceleration, so only adapt very slowly on
    // the legacy fallback path.
    let speedKnMax = model.fleet.speedKnMax;
    if (!model.dynamicsActive && speedScale > 0.15 && speedKn > 2) {
      const estimate = speedKn / speedScale;
      if (estimate > 3.5 && estimate < 9) {
        speedKnMax = speedKnMax + (estimate - speedKnMax) * 0.05;
      }
    }

    model.fleet.centerX = centerX;
    model.fleet.centerZ = centerZ;
    model.fleet.headingDeg = headingDeg;
    model.fleet.yawRad = yawRad;
    model.fleet.speedKn = clamp(speedKn, 0, 40);
    model.fleet.speedScale = clamp(speedScale, 0.1, 3);
    model.fleet.speedKnMax = clamp(speedKnMax, 4, 8);
    model.fleet.mode = normalizedFleetMode(f.mode, estopActive);
    if (typeof f.formationKey === 'string' && f.formationKey) {
      model.fleet.formationKey = f.formationKey;
    }
    model.fleet.formationText =
      typeof f.formationText === 'string' && f.formationText ? f.formationText : model.fleet.formationText;

    if (model.fleet.mode === 'rtl') {
      if (Number.isFinite(f.rtlDistanceM)) {
        model.fleet.rtlDistanceM = Math.max(0, f.rtlDistanceM);
      } else {
        model.fleet.rtlDistanceM = Math.hypot(
          domain.homeBase.x - centerX,
          domain.homeBase.z - centerZ,
        );
      }
    } else {
      model.fleet.rtlDistanceM = null;
    }
  }

  function applyVesselSceneState(vessel, sceneState, dt) {
    const sceneVessel = findSceneVessel(sceneState, vessel.spec.id);
    if (!sceneVessel) {
      model.missingFrames += 1;
      return;
    }
    model.missingFrames = 0;
    vessel.prevX = vessel.x;
    vessel.prevZ = vessel.z;
    vessel.prevYawRad = vessel.yawRad;
    if (Number.isFinite(sceneVessel.x)) vessel.x = sceneVessel.x;
    if (Number.isFinite(sceneVessel.z)) vessel.z = sceneVessel.z;
    const yawBefore = vessel.yawRad;
    if (Number.isFinite(sceneVessel.yawRad)) vessel.yawRad = sceneVessel.yawRad;
    if (Number.isFinite(sceneVessel.headingDeg)) {
      vessel.headingDeg = normalizeDeg(sceneVessel.headingDeg);
    } else if (Number.isFinite(sceneVessel.yawRad)) {
      vessel.headingDeg = headingFromYaw(sceneVessel.yawRad);
    }
    if (Number.isFinite(sceneVessel.pitchRad)) vessel.pitchDeg = sceneVessel.pitchRad / DEG;
    if (Number.isFinite(sceneVessel.rollRad)) vessel.rollDeg = sceneVessel.rollRad / DEG;
    if (Number.isFinite(sceneVessel.heaveM)) vessel.heaveM = sceneVessel.heaveM;
    if (sceneVessel.mode !== undefined) vessel.sceneMode = normalizeSceneMode(sceneVessel.mode);
    if (sceneVessel.waypoint !== undefined) vessel.waypoint = normalizeWaypoint(sceneVessel.waypoint);
    if (Number.isFinite(sceneVessel.stationErrorM)) {
      vessel.stationErrorM = Math.max(0, sceneVessel.stationErrorM);
      vessel.stationSource = 'scene';
    }

    // --- 3-DOF hydrodynamics telemetry (task-8 scene truth) ------------------
    // sogMS is the primary truth; the older `speedKn` field is accepted as a
    // fallback so a scene without the dynamics patch still reports real speed.
    const sogMS = Number.isFinite(sceneVessel.sogMS)
      ? Math.max(0, sceneVessel.sogMS)
      : Number.isFinite(sceneVessel.speedKn)
        ? Math.max(0, sceneVessel.speedKn) / KNOTS_PER_MS
        : NaN;
    vessel.sceneSogMS = sogMS;
    vessel.hasSceneDynamics = Number.isFinite(sogMS);
    vessel.uMS = Number.isFinite(sceneVessel.uMS) ? clamp(sceneVessel.uMS, -40, 40) : NaN;
    vessel.swayMS = Number.isFinite(sceneVessel.swayMS) ? clamp(sceneVessel.swayMS, -20, 20) : NaN;
    vessel.hasSceneCog = Number.isFinite(sceneVessel.cogDeg);
    if (vessel.hasSceneCog) vessel.sceneCogDeg = normalizeDeg(sceneVessel.cogDeg);
    vessel.sceneDriftDeg = Number.isFinite(sceneVessel.driftDeg) ? normalizeSignedDeg(sceneVessel.driftDeg) : NaN;
    if (Number.isFinite(sceneVessel.yawRateDegS)) {
      vessel.yawRateDegS = clamp(sceneVessel.yawRateDegS, -180, 180);
    } else if (dt > 0) {
      vessel.yawRateDegS = clamp(normalizeSignedDeg((vessel.yawRad - yawBefore) / DEG) / dt, -180, 180);
    } else {
      vessel.yawRateDegS = 0;
    }
    if (Number.isFinite(sceneVessel.rudderDeg)) vessel.rudderDeg = clamp(sceneVessel.rudderDeg, -30, 30);
    if (Number.isFinite(sceneVessel.throttlePct)) vessel.throttlePct = clamp(sceneVessel.throttlePct, 0, 100);

    // Course over ground: prefer the scene COG (真实区分艏向/航迹向), fall back
    // to the measured position deltas for legacy scenes.
    if (vessel.hasSceneCog) {
      vessel.cogDeg = vessel.sceneCogDeg;
    } else if (dt > 0) {
      const distance = Math.hypot(vessel.x - vessel.prevX, vessel.z - vessel.prevZ);
      if (distance > 0.03) {
        const cogTarget = normalizeDeg(Math.atan2(vessel.x - vessel.prevX, -(vessel.z - vessel.prevZ)) / DEG);
        vessel.cogDeg = normalizeDeg(vessel.cogDeg + angleDeltaDeg(vessel.cogDeg, cogTarget) * (1 - Math.exp(-dt / 0.9)));
      } else {
        vessel.cogDeg = vessel.headingDeg;
      }
    } else {
      vessel.cogDeg = vessel.headingDeg;
    }
    vessel.driftDeg = Number.isFinite(vessel.sceneDriftDeg)
      ? vessel.sceneDriftDeg
      : normalizeSignedDeg(vessel.cogDeg - vessel.headingDeg);
  }

  /**
   * Speed over ground.
   *
   * task-8: whenever the scene provides the 3-DOF truth (`sogMS`) the number is
   * passed through verbatim (only ≤0.03 kn of deterministic read-out noise).
   * Autonomous / hold / RTB speeds therefore come from the real hydrodynamic
   * model too. Legacy scenes without the new fields keep the old estimate:
   * commanded fleet speed × per-class factor + smooth wobble.
   */
  function updateSog(vessel, dt) {
    const ph = vessel.speedNoisePhase;
    if (vessel.hasSceneDynamics) {
      const trueMS = Math.max(0, vessel.sceneSogMS);
      const trueKn = trueMS * KNOTS_PER_MS;
      const noise = Math.sin(model.t * 1.13 + ph) * 0.018 + Math.sin(model.t * 0.47 + ph * 2.1) * 0.007;
      vessel.sogKn = clamp(trueKn + clamp(noise, -0.028, 0.028), 0, 40);
      const driftRad = (Number.isFinite(vessel.driftDeg) ? vessel.driftDeg : 0) * DEG;
      if (!Number.isFinite(vessel.uMS)) vessel.uMS = trueMS * Math.cos(driftRad);
      if (!Number.isFinite(vessel.swayMS)) vessel.swayMS = trueMS * Math.sin(driftRad);
      return;
    }

    const smooth =
      Math.sin(model.t * 0.37 + ph) * 0.12 +
      Math.sin(model.t * 0.11 + ph * 1.7) * 0.08 +
      Math.sin(model.t * 0.83 + ph * 2.3) * 0.04;
    const commandedKn = model.sceneFleetSpeed;
    const fleetStop = model.estopActive || model.fleet.mode === 'hold' || model.fleet.mode === 'estop' || commandedKn < 0.3;
    let target;
    if (vessel.offline) {
      target = 0;
    } else if (vessel.sceneMode === 'auto') {
      target = SOG_AUTO_KN + smooth;
    } else if (vessel.sceneMode === 'rtl') {
      target = SOG_VESSEL_RTL_KN + smooth * 0.5;
    } else if (vessel.sceneMode === 'hold') {
      target = fleetStop ? SOG_HOLD_KN + Math.abs(smooth) * 0.3 : SOG_HOLD_KN + Math.abs(smooth) * 0.6;
    } else if (fleetStop) {
      target = SOG_HOLD_KN + Math.abs(smooth) * 0.2;
    } else {
      target = commandedKn * vessel.sogFactor + smooth;
    }
    const k = 1 - Math.exp(-dt / 1.1);
    vessel.sogKn = clamp(vessel.sogKn + (clamp(target, 0, 30) - vessel.sogKn) * k, 0, 30);
    if (vessel.sogKn < 0.04) vessel.sogKn = 0;
    const speedMS = vessel.sogKn / KNOTS_PER_MS;
    const driftRad = (Number.isFinite(vessel.driftDeg) ? vessel.driftDeg : 0) * DEG;
    vessel.uMS = speedMS * Math.cos(driftRad);
    vessel.swayMS = speedMS * Math.sin(driftRad);
  }

  function recomputeStationErrors() {
    const fx = model.fleet.centerX;
    const fz = model.fleet.centerZ;
    const yaw = model.fleet.yawRad;
    const forward = { x: Math.cos(yaw), z: -Math.sin(yaw) };
    const right = { x: Math.sin(yaw), z: Math.cos(yaw) };
    const wedge = model.fleet.formationKey === 'wedge';
    for (const vessel of vessels) {
      vessel.distToFleetM = Math.hypot(vessel.x - fx, vessel.z - fz);
      if (vessel.stationSource === 'scene') {
        const override = overrides.stationErrorM.get(vessel.spec.id);
        if (override !== undefined) vessel.stationErrorM = override;
        continue;
      }
      const override = overrides.stationErrorM.get(vessel.spec.id);
      if (override !== undefined) {
        vessel.stationErrorM = override;
        vessel.stationSource = 'scene'; // forced value behaves like scene truth
        continue;
      }
      if (wedge && vessel.sceneMode === 'formation' && Array.isArray(vessel.spec.offset)) {
        const [lat, fwd] = vessel.spec.offset;
        const ex = fx + right.x * lat + forward.x * fwd;
        const ez = fz + right.z * lat + forward.z * fwd;
        vessel.stationErrorM = Math.hypot(vessel.x - ex, vessel.z - ez);
        vessel.stationSource = 'approx';
      } else {
        vessel.stationErrorM = 0;
        vessel.stationSource = 'none';
      }
    }
  }

  function updateSea(t) {
    const waveHeightM = clamp(0.78 + waveDrift(t), 0.22, 1.7);
    const sea = model.sea;
    // Douglas sea-state with hysteresis so the read-out does not flicker.
    let state = sea.state;
    let target;
    if (waveHeightM < 0.5) target = 2;
    else if (waveHeightM < 1.25) target = 3;
    else target = 4;
    if (target !== state) {
      const margin = 0.08;
      if (target > state && waveHeightM > (state === 2 ? 0.5 : 1.25) + margin) state = target;
      else if (target < state && waveHeightM < (state === 3 ? 0.5 : 1.25) - margin) state = target;
    }
    sea.state = state;
    sea.waveHeightM = round2(waveHeightM);
    sea.windKn = round1(clamp(12 + windDrift(t), 5, 22));
    sea.windDirDeg = round1(normalizeDeg(45 + windDirDrift(t)));
    sea.visibilityKm = round1(clamp(8.6 + visibilityDrift(t), 3.5, 13));
    sea.waterTempC = round1(26.8 + tempDrift(t));
    sea.currentKn = round2(clamp(0.42 + currentDrift(t), 0.03, 1.2));
    sea.currentDirDeg = round1(normalizeDeg(222 + currentDirDrift(t)));
    sea.tideM = round2(0.62 + tideDrift(t));
  }

  function updateMission(met) {
    const M = domain.mission;
    const phases = M.phases;
    const cycle = M.cycleDurationSec;
    const pos = cycle > 0 ? ((met % cycle) + cycle) % cycle : 0;
    let phaseIndex = phases.length - 1;
    let phaseStart = 0;
    let acc = 0;
    for (let i = 0; i < phases.length; i++) {
      const duration = phases[i].durationSec;
      if (pos < acc + duration) {
        phaseIndex = i;
        phaseStart = acc;
        break;
      }
      acc += duration;
    }
    const phase = phases[Math.min(phaseIndex, phases.length - 1)] || phases[0];
    const duration = Math.max(1, phase.durationSec);
    const waypointIndex0 = M.waypoints.length ? phaseIndex % M.waypoints.length : 0;
    const waypoint = M.waypoints[waypointIndex0] || M.waypoints[0] || null;
    const mission = model.mission;
    // Contract: phaseIndex / waypointIndex are 1-based (matches the UI panels
    // and the bootstrap mock); the 0-based variants stay available as extras.
    mission.phaseIndex = phaseIndex + 1;
    mission.phaseNo = phaseIndex + 1;
    mission.phaseIndex0 = phaseIndex;
    mission.phaseCount = phases.length;
    mission.phaseName = phase.name;
    mission.phaseEn = phase.en;
    mission.phaseProgress = clamp((pos - phaseStart) / duration, 0, 1);
    mission.overallProgress = clamp(cycle > 0 ? pos / cycle : 0, 0, 1);
    mission.waypointIndex = waypointIndex0 + 1;
    mission.waypointNo = waypointIndex0 + 1;
    mission.waypointIndex0 = waypointIndex0;
    mission.waypointTotal = M.waypoints.length;
    mission.waypointId = waypoint ? waypoint.id : '';
    mission.waypointName = waypoint ? `${waypoint.id} ${waypoint.name}` : '';
    mission.etaSec = Math.max(0, Math.round(cycle - pos));
  }

  function updateLink(vessel, t) {
    const relay = vesselById.get(domain.relayId) || vessels[0];
    const dx = vessel.x - relay.x;
    const dz = vessel.z - relay.z;
    const distRelay = Math.hypot(dx, dz);
    const typeFactor = { comms: -12, flagship: -5, scout: 2, env: 0, survey: 2, patrol: 1, energy: 3, rescue: 0 }[vessel.spec.type] ?? 0;
    const ph = vessel.noisePhases;
    const drift =
      Math.sin(t * 0.21 + ph.latency) * 3.1 +
      Math.sin(t * 0.047 + ph.latency2) * 2.2 +
      Math.sin(t * 0.93 + ph.rssi) * 0.9;
    let latency = 27 + distRelay * 0.05 + typeFactor + drift;

    // Natural MESH degradation window (see DEGRADATION).
    let degrade = 0;
    if (t >= DEGRADATION.startSec) {
      const cycle = Math.floor((t - DEGRADATION.startSec) / DEGRADATION.cycleSec);
      const local = t - DEGRADATION.startSec - cycle * DEGRADATION.cycleSec;
      if (local < DEGRADATION.durationSec) {
        const target = (cycle * 7 + (seedBase % Math.max(1, vessels.length))) % vessels.length;
        if (target === vessel.index) {
          const env = clamp(Math.min(local / 4, (DEGRADATION.durationSec - local) / 4, 1), 0, 1);
          degrade = env;
        }
      }
    }
    const overriddenLatency = overrides.linkLatencyMs.get(vessel.spec.id);
    if (overriddenLatency !== undefined) {
      latency = overriddenLatency;
    } else {
      latency += degrade * (150 + hash01(seedBase, vessel.index, Math.floor(t / DEGRADATION.cycleSec)) * 55);
      latency += linkRng() * 1.6;
      latency = clamp(latency, 8, 2000);
    }

    let lossPct = 0.06 + distRelay * 0.0008 + Math.abs(Math.sin(t * 0.13 + ph.loss)) * 0.06 + degrade * 2.2;
    lossPct = clamp(lossPct + linkRng() * 0.02, 0, 20);

    let rssiDbm = -47 - distRelay * 0.018 - degrade * 24 + Math.sin(t * 0.31 + ph.rssi) * 1.6;
    rssiDbm = clamp(rssiDbm + (vessel.spec.type === 'comms' ? 4 : 0), -95, -26);

    const quality = clamp(1 - (latency - 30) / 260 - lossPct / 10, 0, 1);

    const offlineOverride = overrides.offline.get(vessel.spec.id);
    vessel.offline = offlineOverride === true;

    const k = 1 - Math.exp(-FIXED_STEP / 0.7);
    vessel.link.latencyMs = vessel.link.latencyMs + (latency - vessel.link.latencyMs) * k;
    vessel.link.lossPct = vessel.link.lossPct + (lossPct - vessel.link.lossPct) * k;
    vessel.link.rssiDbm = vessel.link.rssiDbm + (rssiDbm - vessel.link.rssiDbm) * k;
    vessel.link.quality = quality;
    vessel.link.type = vessel.spec.type === 'comms' ? 'MESH RELAY' : 'MESH';
  }

  function batteryLoadFactor(vessel) {
    const ratio = clamp(vessel.sogKn / Math.max(1e-3, model.fleet.speedKnMax), 0, 2.2);
    return 0.62 + 0.5 * ratio;
  }

  function updatePower(vessel, dt, rng) {
    const rated = Math.max(1, vessel.spec.powerKw || 8);
    const speedRatio = clamp(vessel.sogKn / Math.max(1e-3, model.fleet.speedKnMax), 0, 2.2);
    const sensorsOn = vessel.sensors.reduce((sum, s) => sum + (s.on ? 1 : 0), 0);
    // Hotel load + propulsion + payload draw, expressed as a fraction of the
    // class rated power (keeps currents inside a believable 48 V bus range).
    const load = clamp(0.07 + 0.2 * speedRatio + sensorsOn * 0.008 + Math.sin(model.t * 0.37 + vessel.noisePhases.power) * 0.01, 0.05, 1.1);
    const targetPower = rated * load;
    const kPower = 1 - Math.exp(-dt / 1.2);
    vessel.powerKw = clamp(vessel.powerKw + (targetPower - vessel.powerKw) * kPower, 0.3, rated * 1.4);

    const openCircuit = 50.6 - (100 - clamp(vessel.batteryPct, 0, 100)) * 0.06;
    const current = (vessel.powerKw * 1000) / Math.max(38, openCircuit);
    vessel.currentA = round1(current);
    vessel.voltageV = clamp(openCircuit - current * 0.0016, 36, 54);

    const tempTarget = 31 + load * 17 + Math.sin(model.t * 0.11 + vessel.noisePhases.temp) * 0.8;
    vessel.tempC = vessel.tempC + (tempTarget - vessel.tempC) * (1 - Math.exp(-dt / 4));

    const cpuTarget = clamp(22 + load * 34 + sensorsOn * 2.4 + rng() * 5, 8, 97);
    vessel.cpuPct = vessel.cpuPct + (cpuTarget - vessel.cpuPct) * (1 - Math.exp(-dt / 1.8));
  }

  function updateBattery(vessel, dt) {
    const drainRate = DRAIN_RATE[vessel.spec.type] || 0.003;
    const load = batteryLoadFactor(vessel);
    const charge = CHARGE_RATE[vessel.spec.type] || 0;
    const delta = (-drainRate * load + charge * (0.55 + 0.45 * clamp(model.fleet.speedScale / 1.9, 0, 1))) * dt;
    vessel.batteryPct = clamp(vessel.batteryPct + delta, 2, 100);
    vessel.drainPctPerMin = Math.max(0.02, (drainRate * load - charge * 0.55) * 60);
    vessel.uptimeSec += dt;

    const override = overrides.batteryPct.get(vessel.spec.id);
    if (override !== undefined) vessel.batteryPct = clamp(override, 0, 100);
  }

  function applyOverridesAndSensors() {
    for (const vessel of vessels) {
      const offlineOverride = overrides.offline.get(vessel.spec.id);
      if (offlineOverride !== undefined) vessel.offline = offlineOverride === true;
    }
  }

  function step(dt, sceneState) {
    model.totalSteps += 1;
    model.lastSceneState = sceneState || null;
    sceneState = sceneState && typeof sceneState === 'object' ? sceneState : {};

    // Mission clock follows the scene truth (frozen while the scene is paused).
    if (Number.isFinite(sceneState.simTime)) {
      const relative = Math.max(0, sceneState.simTime - model.sceneT0);
      if (relative >= model.t - 1e-6) model.t = relative;
    } else {
      model.t += dt;
    }
    model.met = clock.metOffset + model.t;

    applyFleetState(sceneState.fleet, dt);

    for (const vessel of vessels) {
      applyVesselSceneState(vessel, sceneState, dt);
      updateSog(vessel, dt);
      updateBattery(vessel, dt);
      updatePower(vessel, dt, telemetryRng);
      updateLink(vessel, model.t);
      vessel.depthM = round1(waterDepthAt(vessel.x, vessel.z) + Math.sin(model.t / 41 + vessel.noisePhases.depth) * 0.35);
    }
    applyOverridesAndSensors();
    // Public fleet speed = mean ground speed of all 17 hulls (task-8): real
    // acceleration / deceleration from the hydrodynamic model shows up here.
    let sogSum = 0;
    let dynamicsCount = 0;
    for (const vessel of vessels) {
      sogSum += vessel.sogKn;
      if (vessel.hasSceneDynamics) dynamicsCount += 1;
    }
    model.fleet.speedKn = clamp(sogSum / Math.max(1, vessels.length), 0, 40);
    model.dynamicsActive = dynamicsCount > 0;
    recomputeStationErrors();
    updateSea(model.t);
    updateMission(model.met);
  }

  /**
   * Sync only the CONTROL truth (fleet mode / formation / e-stop / vessel modes
   * and waypoints) from the scene — used after a command executes while the
   * scene is paused: telemetry time / battery / link stay frozen, but the console
   * must immediately show e.g. 急停 armed or RTL active.
   */
  function syncControlState(sceneState) {
    const ss = sceneState && typeof sceneState === 'object' ? sceneState : {};
    applyFleetState(ss.fleet, 0);
    const list = Array.isArray(ss.vessels) ? ss.vessels : [];
    const byId = new Map(list.filter((v) => v && v.id).map((v) => [v.id, v]));
    for (const vessel of vessels) {
      const sv = byId.get(vessel.spec.id);
      if (!sv) continue;
      if (Number.isFinite(sv.x)) vessel.x = sv.x;
      if (Number.isFinite(sv.z)) vessel.z = sv.z;
      if (Number.isFinite(sv.yawRad)) vessel.yawRad = sv.yawRad;
      if (Number.isFinite(sv.headingDeg)) vessel.headingDeg = normalizeDeg(sv.headingDeg);
      if (Number.isFinite(sv.pitchRad)) vessel.pitchDeg = sv.pitchRad / DEG;
      if (Number.isFinite(sv.rollRad)) vessel.rollDeg = sv.rollRad / DEG;
      if (Number.isFinite(sv.heaveM)) vessel.heaveM = sv.heaveM;
      if (sv.mode !== undefined) vessel.sceneMode = normalizeSceneMode(sv.mode);
      if (sv.waypoint !== undefined) vessel.waypoint = normalizeWaypoint(sv.waypoint);
      if (Number.isFinite(sv.stationErrorM)) {
        vessel.stationErrorM = Math.max(0, sv.stationErrorM);
        vessel.stationSource = 'scene';
      } else {
        const override = overrides.stationErrorM.get(vessel.spec.id);
        if (override !== undefined) vessel.stationErrorM = override;
      }
    }
    applyOverridesAndSensors();
    recomputeStationErrors();
  }

  return {
    /** Advance the fixed-step telemetry model by `delta` seconds (call at 10 Hz). */
    update(delta, sceneState) {
      const dt = Number.isFinite(delta) && delta > 0 ? Math.min(delta, 0.5) : 0;
      if (dt <= 0) return 0;
      model.stepAccumulator += dt;
      let steps = 0;
      while (model.stepAccumulator >= FIXED_STEP - 1e-9 && steps < 8) {
        model.stepAccumulator -= FIXED_STEP;
        step(FIXED_STEP, sceneState);
        steps += 1;
      }
      return steps;
    },
    /** Control-truth refresh without advancing telemetry (paused command ack). */
    syncControlState,
    getTime() {
      return model.t;
    },
    getMet() {
      return model.met;
    },
    getVessels() {
      return vessels;
    },
    getVessel(id) {
      return vesselById.get(id) || null;
    },
    getFleet() {
      return model.fleet;
    },
    getManoeuvring() {
      return { formationTransition: !!model.formationTransition, manoeuvring: !!model.manoeuvring };
    },
    getSea() {
      return model.sea;
    },
    getMission() {
      return model.mission;
    },
    getEstopState() {
      return {
        active: model.estopActive,
        sinceT: model.estopSinceT,
        sinceMet: model.estopSinceT === null ? null : clock.metOffset + model.estopSinceT,
        total: domain.roster.length,
      };
    },
    setSensorState(id, sensorId, on) {
      const vessel = vesselById.get(id);
      if (!vessel) return false;
      const sensor = vessel.sensors.find((s) => s.id === sensorId);
      if (!sensor) return false;
      sensor.on = !!on;
      return true;
    },
    setOverride(kind, id, value) {
      const map = overrides[kind];
      if (!map) return false;
      if (value === null || value === undefined) map.delete(id);
      else if (kind === 'offline') map.set(id, !!value);
      else if (kind === 'stationErrorM' || kind === 'batteryPct' || kind === 'linkLatencyMs') {
        if (!Number.isFinite(Number(value))) return false;
        map.set(id, Number(value));
      } else map.set(id, value);
      if (kind === 'stationErrorM') {
        const vessel = vesselById.get(id);
        if (vessel && value !== null && value !== undefined) vessel.stationSource = 'scene';
      }
      return true;
    },
    setOffline(id, offline) {
      if (!overrides.offline) return false;
      overrides.offline.set(id, !!offline);
      return true;
    },
    clearOverrides() {
      for (const map of Object.values(overrides)) map.clear();
    },
    stationErrorOverridden(id) {
      return overrides.stationErrorM.has(id);
    },
    getDebug() {
      const dynamicsVessels = vessels.filter((v) => v.hasSceneDynamics).length;
      const meanSogKn = vessels.reduce((sum, v) => sum + v.sogKn, 0) / Math.max(1, vessels.length);
      return {
        t: round1(model.t),
        met: round1(model.met),
        totalSteps: model.totalSteps,
        estopActive: model.estopActive,
        fleetMode: model.fleet.mode,
        missingFrames: model.missingFrames,
        sceneFleetSpeedKn: round1(model.sceneFleetSpeed),
        meanGroundSpeedKn: round1(meanSogKn),
        dynamicsActive: model.dynamicsActive,
        dynamicsVessels,
        overrides: {
          batteryPct: overrides.batteryPct.size,
          linkLatencyMs: overrides.linkLatencyMs.size,
          offline: overrides.offline.size,
          stationErrorM: overrides.stationErrorM.size,
        },
      };
    },
  };
}
