// =============================================================================
// OceanSwarm GCS — simulation engine entry point.
//
// createSim({ scene, meta, options }) is the frozen integration contract
// (docs/GCS-architecture.md §4.3/§4.4/§4.5):
//
//   update(dt, nowMs)   every frame; telemetry at 10 Hz, alarms at 1 Hz.
//                       Command data-link delays advance on real `nowMs` even
//                       while the scene is paused (dt === 0).
//   dispatch(cmd, opts) validate §4.5 protocol -> 220..650 ms link -> execute
//   snapshot()          cached §4.3 snapshot, rebuilt at 10 Hz / on change
//   debug               QA hooks (force telemetry, validate snapshot)
//
// The UI layer is a pure consumer: it never touches three.js or the scene.
// =============================================================================

import { createDomain } from './domain.js';
import { createEventLog } from './events.js';
import { createAlarmEngine } from './alarms.js';
import { buildCommandCatalog, createCommandBus } from './commands.js';
import { createTelemetryModel } from './model.js';
import { resolveSeed } from './prng.js';
import {
  clamp,
  createClock,
  formatLatency,
  round1,
  round2,
  round3,
  safeNumber,
} from './format.js';

const KNOTS_PER_MS = 1.9438444924406;
const SNAPSHOT_PERIOD_SEC = 0.1;
const ACK_LIMIT = 32;
const ACK_SNAPSHOT_LIMIT = 8;

const FLEET_MODE_KEYS = ['cruise', 'hold', 'uturn', 'rtl', 'estop'];
const VESSEL_MODE_KEYS = ['formation', 'auto', 'hold', 'rtl', 'manual', 'offline'];
const STATUS_KEYS = ['normal', 'warning', 'critical', 'offline'];
const EVENT_SEVERITY_KEYS = ['info', 'success', 'warning', 'critical', 'command'];
const EVENT_CATEGORY_KEYS = ['command', 'alarm', 'mission', 'link', 'system'];

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function safeGetSceneState(scene) {
  if (!scene || typeof scene.getSceneState !== 'function') return null;
  try {
    const state = scene.getSceneState();
    return state && typeof state === 'object' ? state : null;
  } catch (err) {
    // The scene provider is guaranteed not to throw; never let it break the UI.
    console.warn('[sim] scene.getSceneState() failed:', err);
    return null;
  }
}

function safeRenderStats(options) {
  const fallback = { fps: 0, drawCalls: 0, triangles: 0 };
  if (!options || typeof options.getRenderStats !== 'function') return fallback;
  try {
    const stats = options.getRenderStats();
    if (!stats || typeof stats !== 'object') return fallback;
    return {
      fps: Math.max(0, Math.round(safeNumber(stats.fps, 0))),
      drawCalls: Math.max(0, Math.round(safeNumber(stats.drawCalls, 0))),
      triangles: Math.max(0, Math.round(safeNumber(stats.triangles, 0))),
    };
  } catch (err) {
    console.warn('[sim] getRenderStats failed:', err);
    return fallback;
  }
}

function sourceLabelForCommand(cmd, domain) {
  if (!cmd || typeof cmd !== 'object') return '指挥台';
  if (typeof cmd.id === 'string') {
    const vessel = domain.byId.get(cmd.id);
    if (vessel) return `${vessel.callSign} ${vessel.name}`;
  }
  return '指挥台';
}

function detailTextOf(result) {
  if (!result) return null;
  const parts = [];
  if (typeof result.text === 'string' && result.text) parts.push(result.text);
  const detail = result.detail;
  if (typeof detail === 'string' && detail) parts.push(detail);
  else if (detail && typeof detail === 'object') {
    if (typeof detail.text === 'string' && detail.text) parts.push(detail.text);
    else {
      try {
        parts.push(JSON.stringify(detail));
      } catch (err) {
        parts.push('[对象]');
      }
    }
  }
  return parts.length ? parts.join(' · ') : null;
}

/**
 * Create the simulation engine.
 *
 * @param {object} args
 * @param {object} args.scene     sceneProvider (§4.4): getSceneState / execute / origin / base
 * @param {object} [args.meta]    meta.META aggregate from src/gcs/meta.js
 * @param {object} [args.options] { seed, meta, getRenderStats }
 */
export function createSim({ scene, meta, options } = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const metaArg = meta || opts.meta || {};
  const domain = createDomain(metaArg, scene, opts);
  const seed = resolveSeed(opts.seed);
  const clock = createClock({ metOffset: domain.mission.metOffset, timezone: domain.timezone });

  const sceneRef = scene && typeof scene === 'object' ? scene : {};
  const getSceneState = () => safeGetSceneState(sceneRef);

  const initialSceneState = getSceneState();
  const eventLog = createEventLog({ clock, limit: 400, snapshotLimit: 120 });
  const ackLog = { items: [], seq: 0 };
  const alarms = createAlarmEngine({
    clock,
    domain,
    onEvent: (payload) => addEvent({ ...payload, category: 'alarm' }),
  });
  const model = createTelemetryModel({
    domain,
    seed,
    clock,
    options: opts,
    initialSceneState,
  });

  const state = {
    wallMs: 0,
    snapshotAccum: 0,
    snapshotSeq: 0,
    snapshotCache: null,
    dirty: false,
    alarmMetFloor: Math.floor(model.getMet()),
    alarmDue: false,
    lastUpdateAt: 0,
    updates: 0,
    frames: 0,
    pausedFrames: 0,
  };

  function addEvent(partial) {
    const entry = eventLog.add(partial);
    state.dirty = true;
    return entry;
  }

  function pushAck(partial) {
    ackLog.seq += 1;
    const ack = {
      id: `ACK-${String(ackLog.seq).padStart(3, '0')}`,
      commandText: String(partial.commandText || ''),
      ok: !!partial.ok,
      text: String(partial.text || (partial.ok ? '指令已执行' : '指令被拒绝')),
      latencyMs: Math.max(0, Math.round(safeNumber(partial.latencyMs, 0))),
      clockText: clock.clockText(model.getMet()),
    };
    if (partial.detail) ack.detail = String(partial.detail);
    if (partial.ticket) ack.ticket = String(partial.ticket);
    if (Number.isFinite(partial.latencyMs)) ack.latencyText = formatLatency(partial.latencyMs);
    ackLog.items.push(ack);
    if (ackLog.items.length > ACK_LIMIT) ackLog.items.splice(0, ackLog.items.length - ACK_LIMIT);
    state.dirty = true;
    return ack;
  }

  function ackList() {
    const count = Math.min(ACK_SNAPSHOT_LIMIT, ackLog.items.length);
    const out = new Array(count);
    for (let i = 0; i < count; i++) out[i] = ackLog.items[ackLog.items.length - 1 - i];
    return out;
  }

  // --- command bus ----------------------------------------------------------
  const commandBus = createCommandBus({
    domain,
    execute: (cmd) => (typeof sceneRef.execute === 'function' ? sceneRef.execute(cmd) : { ok: false, text: '场景未就绪', detail: null }),
    getSceneState,
    now: () => state.wallMs,
    rng: modelRngForCommands(),
    hooks: {
      onAccepted(ticket) {
        addEvent({
          met: model.getMet(),
          severity: 'command',
          category: 'command',
          sourceId: ticket.cmd.id || null,
          sourceLabel: sourceLabelForCommand(ticket.cmd, domain),
          text: `指令下发 · ${ticket.commandText}`,
          detail: `回执单 ${ticket.id} · 数据链延时约 ${(ticket.delayMs / 1000).toFixed(2)} s`,
        });
      },
      onRejected({ cmd, commandText: text, error }) {
        addEvent({
          met: model.getMet(),
          severity: 'warning',
          category: 'command',
          sourceId: cmd && typeof cmd.id === 'string' ? cmd.id : null,
          sourceLabel: '指挥台',
          text: `指令被拒绝 · ${text}`,
          detail: error,
        });
        pushAck({
          commandText: text,
          ok: false,
          text: `指令被拒绝 · ${error}`,
          latencyMs: 0,
          detail: error,
        });
      },
      onExecuted({ ticket, result, latencyMs }) {
        const text = result.ok ? '指令已执行' : '指令被拒绝';
        const detail = detailTextOf(result);
        pushAck({
          commandText: ticket.commandText,
          ok: result.ok,
          text: result.ok
            ? `指令已执行 · 延时 ${(Math.max(0, latencyMs) / 1000).toFixed(2)} s`
            : `指令被拒绝 · ${result.text || detail || '未知原因'}`,
          latencyMs,
          detail,
          ticket: ticket.id,
        });
        addEvent({
          met: model.getMet(),
          severity: result.ok ? 'success' : 'warning',
          category: 'command',
          sourceId: ticket.cmd.id || null,
          sourceLabel: sourceLabelForCommand(ticket.cmd, domain),
          text: `${text} · ${ticket.commandText}`,
          detail,
          ackMs: latencyMs,
        });
        if (result.ok) applyCommandEcho(ticket.cmd);
      },
    },
  });

  function modelRngForCommands() {
    // A tiny standalone stream so command latency jitter never disturbs the
    // telemetry streams (keeps deterministic noise independent of user input).
    let a = (seed ^ 0x85ebca6b) >>> 0;
    return function next() {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** Mirror command side effects the sim itself owns (payload switches). */
  function applyCommandEcho(cmd) {
    if (!cmd || typeof cmd !== 'object') return;
    if (cmd.type === 'vessel.payload') model.setSensorState(cmd.id, cmd.sensor, cmd.on);
  }

  // --- snapshot -------------------------------------------------------------
  function project(x, z) {
    const p = domain.projectWorld(safeNumber(x, 0), safeNumber(z, 0));
    return {
      lat: Number.isFinite(p && p.lat) ? p.lat : safeNumber(domain.geo.lat0, 0),
      lon: Number.isFinite(p && p.lon) ? p.lon : safeNumber(domain.geo.lon0, 0),
    };
  }

  function buildWaypointSnapshot(vessel) {
    const waypoint = vessel.waypoint;
    if (!waypoint) return null;
    const p = project(waypoint.x, waypoint.z);
    const dx = waypoint.x - vessel.x;
    const dz = waypoint.z - vessel.z;
    const distM = Math.hypot(dx, dz);
    // §6.8: a boat told to navigate sprints at 6.5 m/s; otherwise use its own SOG.
    const speed = vessel.sogKn > 1.6 ? vessel.sogKn / KNOTS_PER_MS : 6.5;
    return {
      x: round1(waypoint.x),
      z: round1(waypoint.z),
      lat: roundTo6(p.lat),
      lon: roundTo6(p.lon),
      distM: round1(distM),
      etaSec: Math.max(0, Math.round(distM / Math.max(0.5, speed))),
    };
  }

  function buildFleetSnapshot(vessels) {
    const fleet = model.getFleet();
    const sea = model.getSea();
    const mission = model.getMission();
    const estop = model.getEstopState();
    const center = project(fleet.centerX, fleet.centerZ);
    const formation = domain.formationByKey.get(fleet.formationKey) || {
      key: fleet.formationKey,
      name: fleet.formationText || fleet.formationKey,
      en: String(fleet.formationKey || '').toUpperCase(),
    };
    const fleetMode = domain.fleetModes[fleet.mode] || { text: '编队巡航', en: 'CRUISE' };
    const alerts = alarms.counts();
    const online = vessels.filter((v) => !v.offline).length;
    const avgBatteryPct = vessels.length
      ? round1(vessels.reduce((sum, v) => sum + v.batteryPct, 0) / vessels.length)
      : 0;
    // Real mean ground speed of the 17 hulls (task-8): the 3-DOF dynamics model
    // makes commanded acceleration / deceleration visible here.
    const meanSogKn = vessels.length
      ? vessels.reduce((sum, v) => sum + v.sogKn, 0) / vessels.length
      : fleet.speedKn;

    // --- data link aggregate ------------------------------------------------
    const onlineVessels = vessels.filter((v) => !v.offline);
    const offlineCount = vessels.length - onlineVessels.length;
    const avgLatency = onlineVessels.length
      ? onlineVessels.reduce((sum, v) => sum + v.link.latencyMs, 0) / onlineVessels.length
      : 0;
    const avgLoss = onlineVessels.length
      ? onlineVessels.reduce((sum, v) => sum + v.link.lossPct, 0) / onlineVessels.length
      : 0;
    let maxLatency = 0;
    for (const v of onlineVessels) maxLatency = Math.max(maxLatency, v.link.latencyMs);
    const linksTotal = 5;
    let linksUp = linksTotal;
    if (maxLatency > 140) linksUp -= 1;
    if (maxLatency > 300) linksUp -= 1;
    if (offlineCount > 0) linksUp -= 1;
    linksUp = clamp(linksUp, 1, linksTotal);
    const quality = clamp(1 - (avgLatency - 30) / 300 - avgLoss / 12 - offlineCount * 0.08, 0.05, 1);
    const bandwidthMbps = clamp(18.6 - avgLoss * 1.6 - (maxLatency > 140 ? 4.5 : 0) - offlineCount * 2 + 0.6 * Math.sin(model.getTime() / 97), 1, 24);

    // --- rtl / estop --------------------------------------------------------
    const rtl =
      fleet.mode === 'rtl' && fleet.rtlDistanceM !== null
        ? {
            active: true,
            distanceM: Math.round(fleet.rtlDistanceM),
            bearingDeg: round1(bearingToHome(fleet.centerX, fleet.centerZ)),
          }
        : null;
    const estopSnap = estop.active
      ? {
          active: true,
          sinceSec: round1(Math.max(0, model.getTime() - (estop.sinceT ?? model.getTime()))),
          sinceMet: estop.sinceMet === null ? null : round1(estop.sinceMet),
        }
      : null;

    return {
      center: {
        x: round1(fleet.centerX),
        z: round1(fleet.centerZ),
        lat: roundTo6(center.lat),
        lon: roundTo6(center.lon),
      },
      headingDeg: round1(fleet.headingDeg),
      speedKn: round1(meanSogKn),
      speedScale: round2(fleet.speedScale),
      speedKnMax: round1(fleet.speedKnMax),
      mode: fleet.mode,
      modeText: fleetMode.text,
      modeEn: fleetMode.en,
      formation: formation.key,
      formationText: formation.name,
      formationEn: formation.en,
      total: vessels.length,
      online,
      avgBatteryPct,
      alerts,
      link: {
        quality: round2(quality),
        latencyMs: Math.round(avgLatency),
        lossPct: round2(avgLoss),
        linksUp,
        linksTotal,
        bandwidthMbps: round1(bandwidthMbps),
        gnssSats: offlineCount > 2 ? 11 : 12,
        gnssFix: 'RTK',
        relayId: domain.relayCallSign || domain.relayId,
      },
      sea: {
        state: sea.state,
        waveHeightM: round2(sea.waveHeightM),
        windKn: round1(sea.windKn),
        windDirDeg: round1(sea.windDirDeg),
        visibilityKm: round1(sea.visibilityKm),
        waterTempC: round1(sea.waterTempC),
        currentKn: round2(sea.currentKn),
        currentDirDeg: round1(sea.currentDirDeg),
        tideM: round2(sea.tideM),
      },
      mission: {
        id: mission.id,
        code: domain.mission.code,
        name: mission.name,
        en: mission.en,
        area: mission.area,
        phaseIndex: mission.phaseIndex,
        phaseNo: mission.phaseNo,
        phaseIndex0: mission.phaseIndex0,
        phaseCount: mission.phaseCount,
        phaseName: mission.phaseName,
        phaseEn: mission.phaseEn,
        phaseProgress: round3(mission.phaseProgress),
        phasePct: Math.round(mission.phaseProgress * 100),
        overallProgress: round3(mission.overallProgress),
        overallPct: Math.round(mission.overallProgress * 100),
        waypointIndex: mission.waypointIndex,
        waypointNo: mission.waypointNo,
        waypointIndex0: mission.waypointIndex0,
        waypointTotal: mission.waypointTotal,
        waypointId: mission.waypointId,
        waypointName: mission.waypointName,
        etaSec: Math.round(mission.etaSec),
      },
      rtl,
      estop: estopSnap,
    };
  }

  function buildVesselSnapshot(vessel) {
    const spec = vessel.spec;
    const p = project(vessel.x, vessel.z);
    const alarmCounts = alarms.countForVessel(spec.id);
    const status = vessel.offline
      ? 'offline'
      : alarmCounts.critical > 0
        ? 'critical'
        : alarmCounts.warning > 0
          ? 'warning'
          : 'normal';
    const mode = vessel.offline ? 'offline' : vessel.sceneMode;
    const modeInfo = domain.vesselModes[mode] || { text: '编队', en: 'FORMATION' };
    const statusText = { normal: '在线', warning: '告警', critical: '严重', offline: '离线' }[status];
    const statusEn = { normal: 'ONLINE', warning: 'WARN', critical: 'CRITICAL', offline: 'OFFLINE' }[status];
    return {
      id: spec.id,
      callSign: spec.callSign,
      name: spec.name,
      type: spec.type,
      typeName: spec.typeName,
      roleEn: spec.roleEn,
      group: spec.group,
      groupName: spec.groupName,
      x: round1(vessel.x),
      z: round1(vessel.z),
      lat: roundTo6(p.lat),
      lon: roundTo6(p.lon),
      headingDeg: round1(vessel.headingDeg),
      cogDeg: round1(vessel.cogDeg),
      sogKn: round1(vessel.sogKn),
      // --- 3-DOF manoeuvring telemetry (task-8, passed through from the scene)
      uKn: round1(safeNumber(vessel.uMS, 0) * KNOTS_PER_MS),
      swayKn: round2(safeNumber(vessel.swayMS, 0) * KNOTS_PER_MS),
      driftDeg: round1(safeNumber(vessel.driftDeg, 0)),
      yawRateDegS: round1(safeNumber(vessel.yawRateDegS, 0)),
      rudderDeg: round1(clamp(safeNumber(vessel.rudderDeg, 0), -30, 30)),
      throttlePct: round1(clamp(safeNumber(vessel.throttlePct, 0), 0, 100)),
      depthM: round1(vessel.depthM),
      pitchDeg: round1(vessel.pitchDeg),
      rollDeg: round1(vessel.rollDeg),
      heaveM: round2(vessel.heaveM),
      batteryPct: round1(vessel.batteryPct),
      powerKw: round1(vessel.powerKw),
      voltageV: round1(vessel.voltageV),
      currentA: round1(vessel.currentA),
      tempC: round1(vessel.tempC),
      cpuPct: Math.round(vessel.cpuPct),
      link: {
        rssiDbm: Math.round(vessel.link.rssiDbm),
        latencyMs: Math.round(vessel.link.latencyMs),
        lossPct: round2(vessel.link.lossPct),
        type: vessel.link.type,
        quality: round2(clamp(vessel.link.quality, 0, 1)),
      },
      status,
      statusText,
      statusEn,
      mode,
      modeText: modeInfo.text,
      modeEn: modeInfo.en,
      alarmCount: alarmCounts.total,
      uptimeSec: Math.round(vessel.uptimeSec),
      distToFleetM: round1(vessel.distToFleetM),
      sensors: vessel.sensors.map((sensor) => ({
        id: sensor.id,
        label: sensor.label,
        short: sensor.short,
        on: !!sensor.on,
        stateText: sensor.on ? '工作' : '待机',
        stateEn: sensor.on ? 'ACTIVE' : 'STANDBY',
      })),
      waypoint: buildWaypointSnapshot(vessel),
    };
  }

  function bearingToHome(x, z) {
    const dx = domain.homeBase.x - x;
    const dz = domain.homeBase.z - z;
    let bearing = (Math.atan2(dx, -dz) * 180) / Math.PI;
    if (bearing < 0) bearing += 360;
    return bearing;
  }

  function buildSnapshot() {
    const met = model.getMet();
    const fleet = buildFleetSnapshot(model.getVessels());
    const snapshot = {
      seq: ++state.snapshotSeq,
      t: round1(model.getTime()),
      met: round1(met),
      metText: clock.metText(met),
      clockText: clock.clockText(met),
      dateText: clock.dateText(met),
      utcText: clock.utcText(met),
      timezone: clock.timezone,
      fleet,
      vessels: model.getVessels().map(buildVesselSnapshot),
      events: eventLog.list(),
      alarms: alarms.list(),
      acks: ackList(),
      system: safeRenderStats(opts),
    };
    state.snapshotCache = snapshot;
    state.dirty = false;
    return snapshot;
  }

  function evaluateAlarms() {
    alarms.evaluate({
      met: model.getMet(),
      vessels: model.getVessels(),
      fleet: {
        estopActive: model.getEstopState().active,
        estopSinceMet: model.getEstopState().sinceMet,
        total: model.getVessels().length,
        ...model.getManoeuvring(),
      },
    });
    state.dirty = true;
  }

  // --- boot log -------------------------------------------------------------
  (function seedBootLog() {
    const met = clock.metOffset;
    const fleet = model.getFleet();
    const formation = domain.formationByKey.get(fleet.formationKey) || { name: '楔形' };
    const mission = domain.mission;
    const initialMission = model.getMission();
    const phase = mission.phases[initialMission.phaseIndex0] || mission.phases[0];
    const waypoint = mission.waypoints[initialMission.waypointIndex0] || mission.waypoints[0];
    const relay = domain.relayId ? domain.byId.get(domain.relayId) : null;
    addEvent({ met: met - 96, severity: 'info', category: 'system', sourceLabel: '系统', text: 'GCS 终端就绪 · 离线安全链路已建立' });
    addEvent({
      met: met - 74,
      severity: 'info',
      category: 'mission',
      sourceLabel: '任务',
      text: `任务 ${mission.code} 下达 · ${mission.name} / ${mission.area}`,
      detail: `任务海域 ${mission.areaEn} · 参演 ${domain.roster.length} 艘`,
    });
    addEvent({
      met: met - 58,
      severity: 'info',
      category: 'link',
      sourceLabel: '数据链',
      text: `数据链建立 · ${domain.roster.length}/${domain.roster.length} 在线 · MESH 中继 ${relay ? relay.callSign : '—'}`,
      detail: 'VHF / MESH / SATCOM / LTE / UHF 五链路握手完成',
    });
    addEvent({
      met: met - 31,
      severity: 'info',
      category: 'mission',
      sourceLabel: '任务',
      text: `进入阶段 ${initialMission.phaseIndex}/${mission.phases.length} ${phase.name} · 航路点 ${waypoint ? waypoint.id : ''}`,
    });
    addEvent({
      met: met - 12,
      severity: 'info',
      category: 'command',
      sourceLabel: '指挥台',
      text: `编队指令生效 · 编队队形 → ${formation.name}`,
    });
  })();

  // First alarm pass: the console opens with one low-battery warning active.
  evaluateAlarms();
  const initialSnapshot = buildSnapshot();

  // --- public API -----------------------------------------------------------
  function update(dt, nowMs) {
    const rawDt = Number(dt);
    const delta = isFiniteNumber(rawDt) && rawDt > 0 ? Math.min(rawDt, 0.1) : 0;
    if (isFiniteNumber(nowMs)) state.wallMs = nowMs;
    else state.wallMs += delta * 1000;
    state.updates += 1;
    state.lastUpdateAt = state.wallMs;

    // Command bus runs on real time even when the scene is paused (dt = 0):
    // QA can click a button while paused and still receive the acknowledgement.
    const executed = commandBus.process(state.wallMs);
    if (executed > 0) state.dirty = true;

    const sceneState = getSceneState();
    const paused = !!(sceneState && sceneState.paused);
    let needBuild = !state.snapshotCache || state.dirty;

    // A command that just executed changed the scene truth. When the scene is
    // paused the telemetry clock stays frozen, but control truth (fleet mode,
    // e-stop, vessel modes/waypoints) must reach the next snapshot immediately.
    if (executed > 0 && sceneState) model.syncControlState(sceneState);

    if (delta > 0 && !paused) {
      state.frames += 1;
      model.update(delta, sceneState);
      const metFloor = Math.floor(model.getMet());
      if (metFloor !== state.alarmMetFloor || state.alarmDue) {
        state.alarmMetFloor = metFloor;
        state.alarmDue = false;
        evaluateAlarms();
      }
      state.snapshotAccum += delta;
      if (state.snapshotAccum >= SNAPSHOT_PERIOD_SEC - 1e-9) {
        state.snapshotAccum = 0;
        needBuild = true;
      }
    } else {
      state.pausedFrames += 1;
      if (state.alarmDue) {
        state.alarmDue = false;
        evaluateAlarms();
        needBuild = true;
      }
    }

    if (needBuild || state.dirty) buildSnapshot();
    return state.snapshotCache;
  }

  function dispatch(cmd, dispatchOpts) {
    const result = commandBus.dispatch(cmd, dispatchOpts || {});
    if (result && (result.accepted || result.error)) state.dirty = true;
    return result;
  }

  function snapshot() {
    if (!state.snapshotCache || state.dirty) buildSnapshot();
    return state.snapshotCache;
  }

  // --- debug hooks ----------------------------------------------------------
  const debug = {
    engine: 'src/sim',
    kind: 'real-sim',
    seed,
    version: '2.0.0',
    state() {
      const telemetry = model.getDebug();
      return {
        seed,
        seedHex: `0x${seed.toString(16)}`,
        wallMs: round1(state.wallMs),
        t: round1(model.getTime()),
        met: round1(model.getMet()),
        mode: model.getFleet().mode,
        formation: model.getFleet().formationKey,
        estopActive: model.getEstopState().active,
        snapshotSeq: state.snapshotSeq,
        updates: state.updates,
        frames: state.frames,
        pausedFrames: state.pausedFrames,
        events: eventLog.size(),
        alarms: alarms.size(),
        acks: ackLog.items.length,
        pending: commandBus.pendingTickets(),
        // task-8: true when the scene supplies real 3-DOF vessel dynamics
        dynamics: {
          available: telemetry.dynamicsActive,
          vessels: telemetry.dynamicsVessels,
          total: domain.roster.length,
          meanGroundSpeedKn: telemetry.meanGroundSpeedKn,
          sceneFleetSpeedKn: telemetry.sceneFleetSpeedKn,
        },
        telemetry,
      };
    },
    pending() {
      return commandBus.pendingTickets();
    },
    force: {
      batteryPct(id, pct) {
        const ok = model.setOverride('batteryPct', id, pct);
        debug._markDirty();
        return ok;
      },
      linkLatencyMs(id, ms) {
        const ok = model.setOverride('linkLatencyMs', id, ms);
        debug._markDirty();
        return ok;
      },
      offline(id, on) {
        const ok = model.setOffline(id, !!on);
        debug._markDirty();
        return ok;
      },
      stationErrorM(id, meters) {
        const ok = model.setOverride('stationErrorM', id, meters);
        debug._markDirty();
        return ok;
      },
      clear() {
        model.clearOverrides();
        debug._markDirty();
      },
      clearLink() {
        for (const vessel of model.getVessels()) model.setOverride('linkLatencyMs', vessel.spec.id, null);
        debug._markDirty();
      },
    },
    triggerAlarmEval() {
      state.alarmDue = true;
      return true;
    },
    emitEvent(partial) {
      const payload = partial && typeof partial === 'object' ? partial : {};
      return addEvent({ met: model.getMet(), category: 'system', sourceLabel: '系统', ...payload });
    },
    validateSnapshot() {
      return validateSnapshot(snapshot(), {
        vesselCount: domain.roster.length,
        expectedIds: domain.roster.map((v) => v.id),
        timezone: clock.timezone,
      });
    },
    /** internal objects, for diagnostics only — never used by UI modules. */
    internals: {
      domain,
      model,
      eventLog,
      alarms,
      commandBus,
      ackLog,
      clock,
    },
    _markDirty() {
      state.dirty = true;
      state.alarmDue = true;
    },
  };

  // --- helpers / shared numbers --------------------------------------------
  return {
    update,
    dispatch,
    snapshot,
    commands: buildCommandCatalog(domain),
    debug,
    /** optional operator actions the dock's alarm ack button may call */
    ackAlarm(id) {
      const result = alarms.ack(id, model.getMet());
      state.dirty = true;
      return result;
    },
    ackAllAlarms() {
      const result = alarms.ackAll(model.getMet());
      state.dirty = true;
      return result;
    },
    /** Exposed for advanced integration (e.g. console completer) */
    domain,
    version: '2.0.0',
    initialSnapshot,
  };
}

/** Formatting helper kept private to the snapshot builder. */
function roundTo6(value) {
  return Math.round(safeNumber(value, 0) * 1e6) / 1e6;
}

// =============================================================================
// Snapshot schema validation (also used by artifacts/sim/selftest.mjs).
// Returns an array of human-readable problems; empty array = schema is sound.
// =============================================================================
export function validateSnapshot(snap, expected = {}) {
  const issues = [];
  const fail = (path, reason) => issues.push(`${path}: ${reason}`);
  const number = (path, value, opts = {}) => {
    if (!isFiniteNumber(value)) return fail(path, `expected finite number, got ${String(value)}`);
    if (opts.min !== undefined && value < opts.min) fail(path, `expected >= ${opts.min}, got ${value}`);
    if (opts.max !== undefined && value > opts.max) fail(path, `expected <= ${opts.max}, got ${value}`);
  };
  const int = (path, value, opts = {}) => {
    if (!Number.isInteger(value)) return fail(path, `expected integer, got ${String(value)}`);
    if (opts.min !== undefined && value < opts.min) fail(path, `expected >= ${opts.min}, got ${value}`);
    if (opts.max !== undefined && value > opts.max) fail(path, `expected <= ${opts.max}, got ${value}`);
  };
  const str = (path, value, opts = {}) => {
    if (typeof value !== 'string') return fail(path, `expected string, got ${typeof value}`);
    if (opts.nonEmpty && value.length === 0) fail(path, 'expected non-empty string');
  };
  const oneOf = (path, value, allowed) => {
    if (!allowed.includes(value)) fail(path, `unexpected value ${JSON.stringify(value)}`);
  };
  const bool = (path, value) => {
    if (typeof value !== 'boolean') fail(path, `expected boolean, got ${typeof value}`);
  };
  const object = (path, value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return fail(path, 'expected object');
    return true;
  };
  const scan = (value, path) => {
    if (value === undefined) return fail(path, 'undefined value');
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) fail(path, `non-finite number ${value}`);
      return;
    }
    if (typeof value === 'string') {
      if (value.includes('NaN') || value.includes('undefined')) fail(path, `suspicious string "${value}"`);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => scan(item, `${path}[${index}]`));
      return;
    }
    if (value && typeof value === 'object') {
      for (const key of Object.keys(value)) scan(value[key], `${path}.${key}`);
    }
  };

  if (!snap || typeof snap !== 'object') {
    return ['snapshot: not an object'];
  }

  int('seq', snap.seq, { min: 1 });
  number('t', snap.t, { min: 0 });
  number('met', snap.met, { min: 0 });
  str('metText', snap.metText);
  str('clockText', snap.clockText);
  str('dateText', snap.dateText);
  str('utcText', snap.utcText);
  str('timezone', snap.timezone);
  if (expected.timezone && snap.timezone !== expected.timezone) fail('timezone', `expected ${expected.timezone}`);

  const fleet = snap.fleet;
  if (object('fleet', fleet)) {
    if (object('fleet.center', fleet.center)) {
      number('fleet.center.x', fleet.center.x);
      number('fleet.center.z', fleet.center.z);
      number('fleet.center.lat', fleet.center.lat, { min: -90, max: 90 });
      number('fleet.center.lon', fleet.center.lon, { min: -180, max: 180 });
    }
    number('fleet.headingDeg', fleet.headingDeg, { min: 0, max: 360 });
    number('fleet.speedKn', fleet.speedKn, { min: 0 });
    number('fleet.speedScale', fleet.speedScale, { min: 0 });
    number('fleet.speedKnMax', fleet.speedKnMax, { min: 1 });
    oneOf('fleet.mode', fleet.mode, FLEET_MODE_KEYS);
    str('fleet.modeText', fleet.modeText, { nonEmpty: true });
    str('fleet.formation', fleet.formation, { nonEmpty: true });
    str('fleet.formationText', fleet.formationText, { nonEmpty: true });
    str('fleet.formationEn', fleet.formationEn);
    int('fleet.total', fleet.total, { min: 1 });
    int('fleet.online', fleet.online, { min: 0 });
    number('fleet.avgBatteryPct', fleet.avgBatteryPct, { min: 0, max: 100 });
    if (object('fleet.alerts', fleet.alerts)) {
      for (const key of ['critical', 'warning', 'info', 'unread']) int(`fleet.alerts.${key}`, fleet.alerts[key], { min: 0 });
    }
    if (object('fleet.link', fleet.link)) {
      number('fleet.link.quality', fleet.link.quality, { min: 0, max: 1 });
      number('fleet.link.latencyMs', fleet.link.latencyMs, { min: 0 });
      number('fleet.link.lossPct', fleet.link.lossPct, { min: 0 });
      int('fleet.link.linksUp', fleet.link.linksUp, { min: 0 });
      int('fleet.link.linksTotal', fleet.link.linksTotal, { min: 1 });
      number('fleet.link.bandwidthMbps', fleet.link.bandwidthMbps, { min: 0 });
      int('fleet.link.gnssSats', fleet.link.gnssSats, { min: 0 });
      str('fleet.link.gnssFix', fleet.link.gnssFix);
      if (fleet.link.relayId !== null) str('fleet.link.relayId', fleet.link.relayId);
    }
    if (object('fleet.sea', fleet.sea)) {
      int('fleet.sea.state', fleet.sea.state, { min: 0, max: 9 });
      for (const key of ['waveHeightM', 'windKn', 'windDirDeg', 'visibilityKm', 'waterTempC', 'currentKn', 'currentDirDeg', 'tideM']) {
        number(`fleet.sea.${key}`, fleet.sea[key]);
      }
    }
    if (object('fleet.mission', fleet.mission)) {
      for (const key of ['id', 'name', 'en', 'area', 'phaseName', 'phaseEn', 'waypointName']) {
        str(`fleet.mission.${key}`, fleet.mission[key]);
      }
      // phaseIndex / waypointIndex are 1-based (UI contract, matches mock-sim)
      int('fleet.mission.phaseIndex', fleet.mission.phaseIndex, { min: 1 });
      int('fleet.mission.phaseCount', fleet.mission.phaseCount, { min: 1 });
      if (fleet.mission.phaseIndex > fleet.mission.phaseCount) fail('fleet.mission.phaseIndex', 'out of phase range');
      number('fleet.mission.phaseProgress', fleet.mission.phaseProgress, { min: 0, max: 1 });
      number('fleet.mission.overallProgress', fleet.mission.overallProgress, { min: 0, max: 1 });
      int('fleet.mission.waypointIndex', fleet.mission.waypointIndex, { min: 1 });
      int('fleet.mission.waypointTotal', fleet.mission.waypointTotal, { min: 1 });
      if (fleet.mission.waypointIndex > fleet.mission.waypointTotal) fail('fleet.mission.waypointIndex', 'out of waypoint range');
      number('fleet.mission.etaSec', fleet.mission.etaSec, { min: 0 });
    }
    if (fleet.rtl !== null) {
      if (object('fleet.rtl', fleet.rtl)) {
        bool('fleet.rtl.active', fleet.rtl.active);
        number('fleet.rtl.distanceM', fleet.rtl.distanceM, { min: 0 });
        number('fleet.rtl.bearingDeg', fleet.rtl.bearingDeg, { min: 0, max: 360 });
      }
    }
    if (fleet.estop !== null) {
      if (object('fleet.estop', fleet.estop)) {
        bool('fleet.estop.active', fleet.estop.active);
        number('fleet.estop.sinceSec', fleet.estop.sinceSec, { min: 0 });
      }
    }
  }

  if (!Array.isArray(snap.vessels)) {
    fail('vessels', 'expected array');
  } else {
    if (expected.vesselCount !== undefined && snap.vessels.length !== expected.vesselCount) {
      fail('vessels', `expected ${expected.vesselCount} vessels, got ${snap.vessels.length}`);
    }
    if (expected.expectedIds) {
      const ids = snap.vessels.map((v) => v && v.id);
      if (ids.join('|') !== expected.expectedIds.join('|')) fail('vessels[].id', 'order/ids do not match meta.FLEET');
    }
    snap.vessels.forEach((v, index) => {
      const at = `vessels[${index}]`;
      if (!object(at, v)) return;
      for (const key of ['id', 'callSign', 'name', 'type', 'typeName', 'roleEn', 'group', 'groupName', 'statusText', 'statusEn', 'modeText', 'modeEn']) {
        str(`${at}.${key}`, v[key], { nonEmpty: true });
      }
      for (const key of ['x', 'z', 'lat', 'lon', 'headingDeg', 'cogDeg', 'sogKn', 'depthM', 'pitchDeg', 'rollDeg', 'heaveM', 'batteryPct', 'powerKw', 'voltageV', 'currentA', 'tempC', 'cpuPct', 'distToFleetM']) {
        number(`${at}.${key}`, v[key]);
      }
      // task-8 manoeuvring telemetry (appended fields; always finite numbers)
      for (const key of ['uKn', 'swayKn', 'driftDeg', 'yawRateDegS', 'rudderDeg', 'throttlePct']) {
        number(`${at}.${key}`, v[key]);
      }
      number(`${at}.throttlePct`, v.throttlePct, { min: 0, max: 100 });
      number(`${at}.rudderDeg`, v.rudderDeg, { min: -30, max: 30 });
      number(`${at}.driftDeg`, v.driftDeg, { min: -180, max: 180 });
      number(`${at}.yawRateDegS`, v.yawRateDegS, { min: -180, max: 180 });
      number(`${at}.batteryPct`, v.batteryPct, { min: 0, max: 100 });
      oneOf(`${at}.status`, v.status, STATUS_KEYS);
      oneOf(`${at}.mode`, v.mode, VESSEL_MODE_KEYS);
      int(`${at}.alarmCount`, v.alarmCount, { min: 0 });
      int(`${at}.uptimeSec`, v.uptimeSec, { min: 0 });
      if (object(`${at}.link`, v.link)) {
        number(`${at}.link.rssiDbm`, v.link.rssiDbm);
        number(`${at}.link.latencyMs`, v.link.latencyMs, { min: 0 });
        number(`${at}.link.lossPct`, v.link.lossPct, { min: 0 });
        number(`${at}.link.quality`, v.link.quality, { min: 0, max: 1 });
        str(`${at}.link.type`, v.link.type);
      }
      if (!Array.isArray(v.sensors) || v.sensors.length === 0) {
        fail(`${at}.sensors`, 'expected non-empty array');
      } else {
        v.sensors.forEach((s, si) => {
          const sp = `${at}.sensors[${si}]`;
          if (!object(sp, s)) return;
          str(`${sp}.id`, s.id, { nonEmpty: true });
          str(`${sp}.label`, s.label, { nonEmpty: true });
          str(`${sp}.short`, s.short, { nonEmpty: true });
          bool(`${sp}.on`, s.on);
          str(`${sp}.stateText`, s.stateText, { nonEmpty: true });
        });
      }
      if (v.waypoint !== null) {
        if (object(`${at}.waypoint`, v.waypoint)) {
          for (const key of ['x', 'z', 'lat', 'lon', 'distM', 'etaSec']) number(`${at}.waypoint.${key}`, v.waypoint[key]);
        }
      }
    });
  }

  // task-8 cross-checks: fleet.speedKn is the mean ground speed of the hulls and
  // driftDeg is the signed (COG − heading) difference.
  if (snap.fleet && Array.isArray(snap.vessels) && snap.vessels.length && Number.isFinite(snap.fleet.speedKn)) {
    const meanSog = snap.vessels.reduce((sum, v) => sum + (Number.isFinite(v && v.sogKn) ? v.sogKn : 0), 0) / snap.vessels.length;
    if (Math.abs(snap.fleet.speedKn - meanSog) > 0.35) {
      fail('fleet.speedKn', `expected mean ground speed ${meanSog.toFixed(2)} kn, got ${snap.fleet.speedKn}`);
    }
    for (let i = 0; i < snap.vessels.length; i++) {
      const v = snap.vessels[i];
      if (!v || !Number.isFinite(v.driftDeg) || !Number.isFinite(v.cogDeg) || !Number.isFinite(v.headingDeg)) continue;
      let expected = v.cogDeg - v.headingDeg;
      while (expected > 180) expected -= 360;
      while (expected < -180) expected += 360;
      if (Math.abs(v.driftDeg - expected) > 0.6) {
        fail(`vessels[${i}].driftDeg`, `expected signed(cog-heading)=${expected.toFixed(1)}, got ${v.driftDeg}`);
        break;
      }
    }
  }

  if (!Array.isArray(snap.events)) fail('events', 'expected array');
  else {
    if (snap.events.length > 120) fail('events', `too many (${snap.events.length} > 120)`);
    snap.events.forEach((event, index) => {
      const at = `events[${index}]`;
      if (!object(at, event)) return;
      str(`${at}.id`, event.id, { nonEmpty: true });
      number(`${at}.t`, event.t, { min: 0 });
      str(`${at}.metText`, event.metText);
      str(`${at}.clockText`, event.clockText);
      oneOf(`${at}.severity`, event.severity, EVENT_SEVERITY_KEYS);
      oneOf(`${at}.category`, event.category, EVENT_CATEGORY_KEYS);
      str(`${at}.sourceLabel`, event.sourceLabel);
      str(`${at}.text`, event.text, { nonEmpty: true });
    });
  }

  if (!Array.isArray(snap.alarms)) fail('alarms', 'expected array');
  else {
    snap.alarms.forEach((alarm, index) => {
      const at = `alarms[${index}]`;
      if (!object(at, alarm)) return;
      str(`${at}.id`, alarm.id, { nonEmpty: true });
      oneOf(`${at}.severity`, alarm.severity, ['warning', 'critical']);
      str(`${at}.sourceLabel`, alarm.sourceLabel);
      str(`${at}.title`, alarm.title, { nonEmpty: true });
      str(`${at}.detail`, alarm.detail);
      number(`${at}.sinceMet`, alarm.sinceMet, { min: 0 });
      str(`${at}.sinceClockText`, alarm.sinceClockText);
    });
  }

  if (!Array.isArray(snap.acks)) fail('acks', 'expected array');
  else {
    if (snap.acks.length > 8) fail('acks', `too many (${snap.acks.length} > 8)`);
    snap.acks.forEach((ack, index) => {
      const at = `acks[${index}]`;
      if (!object(at, ack)) return;
      str(`${at}.id`, ack.id, { nonEmpty: true });
      str(`${at}.commandText`, ack.commandText, { nonEmpty: true });
      bool(`${at}.ok`, ack.ok);
      str(`${at}.text`, ack.text, { nonEmpty: true });
      number(`${at}.latencyMs`, ack.latencyMs, { min: 0 });
      str(`${at}.clockText`, ack.clockText);
    });
  }

  if (object('system', snap.system)) {
    int('system.fps', snap.system.fps, { min: 0 });
    int('system.drawCalls', snap.system.drawCalls, { min: 0 });
    int('system.triangles', snap.system.triangles, { min: 0 });
  }

  scan(snap, 'snapshot');
  return issues;
}

export default createSim;
