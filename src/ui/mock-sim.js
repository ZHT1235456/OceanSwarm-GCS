// =============================================================================
// TEMPORARY mock simulation (Lead-owned bootstrap until src/sim/* lands).
// Implements the exact createSim contract documented in
// docs/GCS-architecture.md §4.3/§4.4/§4.5 so the whole UI can be developed and
// reviewed before the real Sim engine is merged. main.js prefers src/sim/**.
// =============================================================================
import { META } from '../gcs/meta.js';

const nowMs = () => performance.now();

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let r = Math.imul(a ^ (a >>> 15), 1 | a);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

const SEED_BATTERY = {
  flagship: 96.2,
  'scout-1': 91.4,
  'scout-2': 23.8,
  'scout-3': 88.1,
  'scout-4': 79.6,
  'scout-5': 86.7,
  'env-1': 90.2,
  'env-2': 84.5,
  'env-3': 76.3,
  'survey-1': 88.9,
  'survey-2': 81.2,
  'patrol-1': 87.4,
  'patrol-2': 18.6,
  'comms-1': 92.8,
  'energy-1': 98.1,
  'energy-2': 95.4,
  'rescue-1': 89.7,
};

export function createSim({ scene, meta = META, options = {} }) {
  const rand = mulberry32(options.seed ?? 7);
  const bootWallMs = Date.now();
  const getStats = options.getRenderStats || (() => ({ fps: 0, drawCalls: 0, triangles: 0 }));

  const state = {
    t: 0,
    seq: 0,
    lastSnapshot: null,
    lastSnapshotAt: -1,
    dirty: true,
    events: [],
    acks: [],
    alarms: new Map(),
    pending: [],
    ticketSeq: 0,
    lastDispatchAt: new Map(),
    batteries: new Map(),
    sensors: new Map(),
    latencySpike: new Map(),
    outage: new Map(),
    estopActive: false,
    stationErrorSince: new Map(),
    lastAlarmTick: 0,
    lastOutageRoll: 0,
    metOffset: meta.MISSION.metOffsetSec ?? 720,
  };

  // --- helpers ---------------------------------------------------------------
  const clock = (wallMs) => {
    const d = new Date(wallMs + 8 * 3600 * 1000);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
  };
  const dateText = (wallMs) => {
    const d = new Date(wallMs + 8 * 3600 * 1000);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
  };
  const metText = (met) => {
    const s = Math.max(0, Math.round(met));
    const p = (n) => String(n).padStart(2, '0');
    return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
  };
  const hdgText = (deg) => `${String(Math.round(((deg % 360) + 360) % 360)).padStart(3, '0')}°`;
  const noise = (amp) => (rand() * 2 - 1) * amp;
  const walkNoise = (prev, amp, rate = 0.2) => prev + (rand() * 2 - 1) * amp * rate;

  const event = (severity, category, sourceLabel, text, sourceId = null, detail = null) => {
    const wall = Date.now();
    const e = {
      id: `ev-${state.seq}-${state.events.length}-${Math.round(wall % 100000)}`,
      t: state.t,
      metText: metText(state.metOffset + state.t),
      clockText: clock(wall),
      severity,
      category,
      sourceId,
      sourceLabel,
      text,
      detail,
    };
    state.events.unshift(e);
    if (state.events.length > 400) state.events.length = 400;
    state.dirty = true;
    return e;
  };

  // --- seed telemetry ---------------------------------------------------------
  for (const v of meta.FLEET) {
    state.batteries.set(v.id, SEED_BATTERY[v.id] ?? 80 + rand() * 15);
    const sensors = {};
    for (const s of meta.TYPE_META[v.type].sensors) sensors[s] = true;
    state.sensors.set(v.id, sensors);
    state.latencySpike.set(v.id, 0);
    state.outage.set(v.id, 0);
  }

  // --- seed events / alarms ---------------------------------------------------
  event('success', 'system', 'SYSTEM', '系统自检完成 · 17/17 在线 · 三维视景与数据链就绪');
  event('info', 'mission', 'MISSION', `任务 ${meta.MISSION.id} ${meta.MISSION.name} 已加载 · 6 航路点`);
  event('command', 'command', 'FLEET', '编队队形 → 楔形 · 已就位');
  event('info', 'link', 'MESH', '数据链主链路建立 · 中继 USV-14 · 延时 42 ms');

  const raiseAlarm = (id, severity, vesselId, sourceLabel, title, detail) => {
    if (state.alarms.has(id)) return;
    const alarm = {
      id,
      severity,
      vesselId,
      sourceLabel,
      title,
      detail,
      sinceMet: state.metOffset + state.t,
      sinceClockText: clock(Date.now()),
    };
    state.alarms.set(id, alarm);
    event(severity, 'alarm', sourceLabel, `${title} · ${detail}`, vesselId);
  };
  const resolveAlarm = (id) => {
    const alarm = state.alarms.get(id);
    if (!alarm) return;
    state.alarms.delete(id);
    event('success', 'alarm', alarm.sourceLabel, `告警恢复 · ${alarm.title}`);
  };

  raiseAlarm('battery-scout-2', 'warning', 'scout-2', 'USV-03', '电量低于 25%', '当前 23.8%，剩余续航约 11 min');

  // --- mission helpers --------------------------------------------------------
  function missionInfo(met) {
    const phases = meta.MISSION.phases;
    const cycle = phases.reduce((n, p) => n + p.durationSec, 0);
    const overall = (met % cycle) / cycle;
    let acc = 0;
    let phaseIndex = 0;
    for (let i = 0; i < phases.length; i++) {
      if (met % cycle < acc + phases[i].durationSec) {
        phaseIndex = i;
        break;
      }
      acc += phases[i].durationSec;
    }
    const phase = phases[phaseIndex];
    const phaseProgress = Math.min(1, ((met % cycle) - acc) / phase.durationSec);
    const wpIndex = Math.min(meta.MISSION.waypoints.length, Math.floor(overall * meta.MISSION.waypoints.length) + 1);
    const wp = meta.MISSION.waypoints[wpIndex - 1];
    return {
      id: meta.MISSION.id,
      name: meta.MISSION.name,
      en: meta.MISSION.en,
      area: meta.MISSION.area,
      phaseIndex: phaseIndex + 1,
      phaseCount: phases.length,
      phaseName: phase.name,
      phaseEn: phase.en,
      phaseProgress,
      phasePct: Math.round(phaseProgress * 100),
      overallProgress: overall,
      overallPct: Math.round(overall * 100),
      waypointIndex: wpIndex,
      waypointTotal: meta.MISSION.waypoints.length,
      waypointName: `${wp.id} ${wp.name}`,
      etaSec: Math.round(cycle - (met % cycle)),
    };
  }

  // --- command bus ------------------------------------------------------------
  function validate(cmd) {
    if (!cmd || typeof cmd.type !== 'string') return '非法指令';
    const valid = new Set([
      'formation.set',
      'formation.scale',
      'fleet.speed',
      'fleet.hold',
      'fleet.resume',
      'fleet.uturn',
      'fleet.rtl',
      'fleet.cancelRtl',
      'fleet.estop',
      'fleet.recover',
      'vessel.goto',
      'vessel.rtl',
      'vessel.hold',
      'vessel.resume',
      'vessel.payload',
    ]);
    if (!valid.has(cmd.type)) return `未知指令：${cmd.type}`;
    if (state.estopActive && cmd.type !== 'fleet.recover') return '紧急停止状态下仅可执行“解除急停”';
    if (cmd.type === 'formation.set' && !meta.FORMATION_BY_KEY.has(cmd.formation)) return `未知编队队形：${cmd.formation}`;
    if (cmd.type.startsWith('vessel.') && !meta.FLEET_BY_ID.has(cmd.id)) return `未知无人艇：${cmd.id}`;
    if (cmd.type === 'vessel.payload' && !meta.SENSOR_CATALOG[cmd.sensor]) return `未知载荷：${cmd.sensor}`;
    if (cmd.type === 'vessel.goto' && !(Number.isFinite(cmd.x) && Number.isFinite(cmd.z))) return '航点坐标非法';
    return null;
  }

  function dispatch(cmd) {
    const wall = Date.now();
    const error = validate(cmd);
    const stamp = `${cmd.type}`;
    if (!error) {
      const last = state.lastDispatchAt.get(stamp) || 0;
      if (nowMs() - last < 400) {
        return { accepted: false, ticket: null, error: '指令重复，已忽略（400 ms 防抖）' };
      }
      state.lastDispatchAt.set(stamp, nowMs());
    }
    if (error) {
      state.acks.unshift({
        id: `ack-${++state.ticketSeq}`,
        commandText: cmd?.type || '非法指令',
        ok: false,
        text: `指令被拒绝 · ${error}`,
        latencyMs: 0,
        clockText: clock(wall),
      });
      if (state.acks.length > 8) state.acks.length = 8;
      event('warning', 'command', 'COMMAND', `指令被拒绝 · ${error}`);
      state.dirty = true;
      return { accepted: false, ticket: null, error };
    }
    const ticket = `cmd-${++state.ticketSeq}`;
    const latencyMs = Math.round(220 + rand() * 430);
    state.pending.push({ ticket, cmd, dueAt: nowMs() + latencyMs, latencyMs, issuedAt: wall });
    return { accepted: true, ticket, error: null };
  }

  function processPending() {
    const now = nowMs();
    for (let i = state.pending.length - 1; i >= 0; i--) {
      const item = state.pending[i];
      if (now < item.dueAt) continue;
      state.pending.splice(i, 1);
      let result;
      try {
        result = scene.execute(item.cmd);
      } catch (err) {
        result = { ok: false, text: `执行异常：${err && err.message ? err.message : err}` };
      }
      const cmd = item.cmd;
      // mock-side payload bookkeeping
      if (cmd.type === 'vessel.payload' && state.sensors.has(cmd.id)) {
        state.sensors.get(cmd.id)[cmd.sensor] = !!cmd.on;
      }
      const ack = {
        id: item.ticket,
        commandText: result?.text || cmd.type,
        ok: !!(result && result.ok),
        text: result && result.ok ? `指令已执行 · 延时 ${(item.latencyMs / 1000).toFixed(2)} s` : `执行失败 · ${result?.text || '未知原因'}`,
        latencyMs: item.latencyMs,
        clockText: clock(Date.now()),
      };
      state.acks.unshift(ack);
      if (state.acks.length > 8) state.acks.length = 8;
      event(result && result.ok ? 'command' : 'warning', 'command', 'COMMAND', result?.text || cmd.type, cmd.id || null, {
        latencyMs: item.latencyMs,
      });
      if (cmd.type === 'fleet.estop') state.estopActive = true;
      if (cmd.type === 'fleet.recover') state.estopActive = false;
      state.dirty = true;
    }
  }

  // --- per-frame update -------------------------------------------------------
  function update(dt, now) {
    const wall = Date.now();
    if (dt > 0) {
      state.t += dt;
      // battery drain / link noise
      for (const v of meta.FLEET) {
        let b = state.batteries.get(v.id);
        const isEnergy = v.type === 'energy';
        b += isEnergy ? -0.0006 * dt : -0.0085 * dt * (0.8 + rand() * 0.4);
        state.batteries.set(v.id, Math.max(4, b));
        let spike = state.latencySpike.get(v.id);
        spike = Math.max(0, spike - dt);
        if (Math.random() < dt / 220) spike = 90 + rand() * 160; // rare link jitter
        state.latencySpike.set(v.id, spike);
      }
      if (state.t - state.lastAlarmTick >= 1) {
        state.lastAlarmTick = state.t;
        tickAlarms(dt);
      }
      state.dirty = true;
    }
    processPending();
    if (state.dirty && (now - state.lastSnapshotAt >= 100 || state.lastSnapshot === null)) {
      state.lastSnapshot = buildSnapshot();
      state.lastSnapshotAt = now;
      state.lastSnapshotAt = now;
      state.seq++;
    }
  }

  function tickAlarms(dt) {
    // battery warnings
    for (const v of meta.FLEET) {
      const b = state.batteries.get(v.id);
      const key = `battery-${v.id}`;
      const vm = meta.FLEET_BY_ID.get(v.id);
      if (b < 15) {
        if (state.alarms.get(key)?.severity !== 'critical') {
          state.alarms.delete(key);
          raiseAlarm(key, 'critical', v.id, vm.callSign, '电量严重不足', `当前 ${b.toFixed(1)}%，请立即返航`);
        }
      } else if (b < 25) {
        raiseAlarm(key, 'warning', v.id, vm.callSign, '电量低于 25%', `当前 ${b.toFixed(1)}%，剩余续航约 ${Math.round(b * 0.5)} min`);
      } else {
        resolveAlarm(key);
      }
    }
    // estop state alarm
    if (state.estopActive) {
      raiseAlarm('estop', 'critical', null, 'FLEET', '集群处于紧急停止状态', '等待指挥员解除急停');
    } else {
      resolveAlarm('estop');
    }
  }

  // --- snapshot ---------------------------------------------------------------
  let sceneState = null;
  try {
    sceneState = scene.getSceneState();
  } catch {
    sceneState = null;
  }

  function fallbackScene() {
    return {
      simTime: state.t,
      fleet: {
        centerX: 0,
        centerZ: 0,
        headingDeg: 90,
        yawRad: 0,
        speedKn: 6,
        speedScale: 1,
        mode: 'cruise',
        formationKey: 'wedge',
        formationText: '楔形',
        formationEn: 'WEDGE',
        rtlDistanceM: null,
        rtlBearingDeg: null,
        estopActive: false,
        holdActive: false,
      },
      vessels: meta.FLEET.map((v, i) => ({
        id: v.id,
        type: v.type,
        callSign: v.callSign,
        x: (i - 8) * 40,
        z: (i % 4) * 30,
        yawRad: 0,
        headingDeg: 90,
        pitchRad: 0,
        rollRad: 0,
        heaveM: 0,
        mode: 'formation',
        stationErrorM: 0,
        waypoint: null,
      })),
    };
  }

  function buildSnapshot() {
    try {
      sceneState = scene.getSceneState();
    } catch {
      sceneState = null;
    }
    const sc = sceneState || fallbackScene();
    const wall = Date.now();
    const met = state.metOffset + state.t;
    const mission = missionInfo(met);
    const estop = !!(sc.fleet.estopActive ?? state.estopActive);

    const vessels = meta.FLEET.map((vm) => {
      const live = sc.vessels.find((v) => v.id === vm.id) || {};
      const tm = meta.TYPE_META[vm.type];
      const battery = state.batteries.get(vm.id) ?? 80;
      const sensorState = state.sensors.get(vm.id) || {};
      const linkType = vm.type === 'comms' ? 'MESH 主中继' : vm.type === 'flagship' ? '卫星 + MESH' : 'MESH';
      const spike = state.latencySpike.get(vm.id) || 0;
      const latency = Math.round(38 + (vm.type === 'comms' ? -6 : 0) + spike + Math.abs(noise(6)) * 10) / 1;
      const loss = Math.max(0, 0.04 + spike / 900 + Math.abs(noise(0.06)));
      const rssi = Math.round(-54 - spike * 0.08 + noise(4));
      const quality = Math.max(0.1, Math.min(1, 1 - loss - spike / 600));
      const status =
        battery < 15 ? 'critical' : battery < 25 || spike > 140 ? 'warning' : live.mode === 'offline' ? 'offline' : 'normal';
      const mode = live.mode || 'formation';
      const modeMeta = meta.VESSEL_MODES[mode] || meta.VESSEL_MODES.formation;
      const heading = live.headingDeg ?? 90;
      const lat = meta.GEO.lat0 - (live.z ?? 0) / meta.GEO.mPerDegLat;
      const lon = meta.GEO.lon0 + (live.x ?? 0) / (meta.GEO.mPerDegLat * Math.cos((meta.GEO.lat0 * Math.PI) / 180));
      return {
        id: vm.id,
        callSign: vm.callSign,
        name: vm.name,
        type: vm.type,
        typeName: tm.typeName,
        roleEn: tm.roleEn,
        group: vm.group,
        groupName: (meta.GROUPS.find((g) => g.key === vm.group) || {}).name || '',
        x: live.x ?? 0,
        z: live.z ?? 0,
        lat,
        lon,
        headingDeg: heading,
        cogDeg: heading,
        sogKn: Math.max(0, (sc.fleet.speedKn ?? 0) * (0.97 + 0.06 * rand())),
        depthM: 12.4 + (vm.variant || 0) * 2.1 + noise(0.6),
        pitchDeg: ((live.pitchRad ?? 0) * 180) / Math.PI,
        rollDeg: ((live.rollRad ?? 0) * 180) / Math.PI,
        heaveM: live.heaveM ?? 0,
        batteryPct: battery,
        powerKw: tm.powerKw * (0.5 + 0.1 * Math.sin(state.t / 40 + vm.variant)),
        voltageV: 26 + (battery / 100) * 2.6 + noise(0.1),
        currentA: 20 + 12 * rand(),
        tempC: 38 + (vm.variant || 0) * 1.4 + noise(1),
        cpuPct: 24 + Math.round(rand() * 30),
        link: { rssiDbm: rssi, latencyMs: latency, lossPct: loss, type: linkType, quality },
        status,
        mode,
        modeText: modeMeta.text,
        alarmCount: battery < 25 ? 1 : spike > 140 ? 1 : 0,
        uptimeSec: Math.round(state.t),
        distToFleetM: Math.hypot((live.x ?? 0) - sc.fleet.centerX, (live.z ?? 0) - sc.fleet.centerZ),
        sensors: tm.sensors.map((sid) => {
          const s = meta.SENSOR_CATALOG[sid];
          const on = sensorState[sid] !== false;
          return { id: sid, label: s.label, short: s.short, on, stateText: on ? '工作' : '关闭' };
        }),
        waypoint: live.waypoint || null,
      };
    });

    const online = vessels.filter((v) => v.status !== 'offline').length;
    const avgLatency = vessels.reduce((n, v) => n + v.link.latencyMs, 0) / vessels.length;
    const avgLoss = vessels.reduce((n, v) => n + v.link.lossPct, 0) / vessels.length;
    const avgBattery = vessels.reduce((n, v) => n + v.batteryPct, 0) / vessels.length;
    const alarms = [...state.alarms.values()].sort((a, b) => (a.severity === 'critical' ? -1 : 0) - (b.severity === 'critical' ? -1 : 0));
    const fleetMode = estop ? 'estop' : sc.fleet.mode;
    const modeMeta = meta.FLEET_MODES[fleetMode] || meta.FLEET_MODES.cruise;
    const formation = meta.FORMATION_BY_KEY.get(sc.fleet.formationKey) || meta.FORMATIONS[0];

    return {
      seq: state.seq + 1,
      t: state.t,
      met,
      metText: metText(met),
      clockText: clock(wall),
      dateText: dateText(wall),
      utcText: new Date(wall).toISOString().slice(11, 19) + 'Z',
      timezone: 'UTC+8',
      fleet: {
        center: {
          x: sc.fleet.centerX,
          z: sc.fleet.centerZ,
          lat: meta.GEO.lat0 - sc.fleet.centerZ / meta.GEO.mPerDegLat,
          lon:
            meta.GEO.lon0 +
            sc.fleet.centerX / (meta.GEO.mPerDegLat * Math.cos((meta.GEO.lat0 * Math.PI) / 180)),
        },
        headingDeg: sc.fleet.headingDeg,
        speedKn: sc.fleet.speedKn,
        speedScale: sc.fleet.speedScale,
        speedKnMax: 6.0,
        mode: fleetMode,
        modeText: modeMeta.text,
        formation: formation.key,
        formationText: formation.name,
        formationEn: formation.en,
        total: vessels.length,
        online,
        avgBatteryPct: avgBattery,
        alerts: {
          critical: alarms.filter((a) => a.severity === 'critical').length,
          warning: alarms.filter((a) => a.severity === 'warning').length,
          info: 0,
          unread: alarms.length,
        },
        link: {
          quality: Math.max(0.2, 1 - avgLoss / 3),
          latencyMs: avgLatency,
          lossPct: avgLoss,
          linksUp: online,
          linksTotal: vessels.length,
          bandwidthMbps: 24.6 + noise(1.2),
          gnssSats: 12,
          gnssFix: 'RTK 固定解',
          relayId: 'USV-14',
        },
        sea: {
          state: 3,
          waveHeightM: 0.8 + noise(0.06),
          windKn: 12 + noise(0.8),
          windDirDeg: 45 + noise(3),
          visibilityKm: 12,
          waterTempC: 26.4,
          currentKn: 0.4,
          currentDirDeg: 210,
          tideM: 1.2,
        },
        mission,
        rtl: sc.fleet.mode === 'rtl' && sc.fleet.rtlDistanceM != null
          ? { active: true, distanceM: sc.fleet.rtlDistanceM, bearingDeg: sc.fleet.rtlBearingDeg ?? 0 }
          : null,
        estop: estop ? { active: true, sinceSec: 0 } : null,
      },
      vessels,
      events: state.events.slice(0, 120),
      alarms,
      acks: state.acks.slice(0, 8),
      system: { ...(getStats() || {}) },
    };
  }

  // Force a first snapshot so the UI has data immediately.
  state.lastSnapshot = buildSnapshot();
  state.seq = 1;

  return {
    update,
    dispatch,
    snapshot: () => state.lastSnapshot,
    debug: { state, raiseAlarm, resolveAlarm },
    commands: [],
  };
}
