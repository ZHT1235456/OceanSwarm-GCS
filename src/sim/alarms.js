// =============================================================================
// OceanSwarm GCS — alarm engine.
//
// Rules (evaluated at 1 Hz, see docs/GCS-architecture.md §3 / task contract):
//   • 低电量     < 25 % warning, < 15 % critical        (hysteresis 26 / 16)
//   • 链路延时   > 140 ms warning, > 300 ms critical    (hysteresis 128 / 270)
//   • 阵位偏离   scene.stationErrorM > 35 m warning, > 90 m critical,
//                must persist ≥ 3 s (formation change transients are noisy)
//   • 离线       艇失联 -> critical
//   • 急停       fleet estop -> critical
//
// Every condition owns a STABLE id (e.g. ALM-BATTERY-scout-2) so a persisting
// problem updates one alarm entry instead of spamming the event stream. Clearing
// the condition removes the alarm and emits exactly one「已恢复」event.
// =============================================================================

import { round1 } from './format.js';

export const ALARM_RULES = {
  battery: { warn: 25, warnClear: 26, crit: 15, critClear: 16 },
  link: { warn: 140, warnClear: 128, crit: 300, critClear: 270 },
  station: { warn: 35, warnClear: 25, crit: 90, critClear: 70, fallbackWarn: 120, fallbackClear: 100 },
  stationHoldSec: 3,
};

const LEVEL_RANK = { warning: 1, critical: 2 };

/** Low-is-bad severity with hysteresis. prev: 0 | 1 | 2 */
function severityForLow(value, prev, t) {
  if (prev === 2) {
    if (value >= t.critClear) return value >= t.warnClear ? 0 : 1;
    return 2;
  }
  if (prev === 1) {
    if (value >= t.warnClear) return 0;
    if (value < t.crit) return 2;
    return 1;
  }
  if (value < t.crit) return 2;
  if (value < t.warn) return 1;
  return 0;
}

/** High-is-bad severity with hysteresis. prev: 0 | 1 | 2 */
function severityForHigh(value, prev, t) {
  if (prev === 2) {
    if (value <= t.critClear) return value <= t.warnClear ? 0 : 1;
    return 2;
  }
  if (prev === 1) {
    if (value <= t.warnClear) return 0;
    if (value > t.crit) return 2;
    return 1;
  }
  if (value > t.crit) return 2;
  if (value > t.warn) return 1;
  return 0;
}

function levelOf(severity) {
  return LEVEL_RANK[severity] || 0;
}

function fmtPct(value) {
  return `${round1(value)}%`;
}

/**
 * @param {object} opts
 * @param {object} opts.clock   createClock() instance
 * @param {object} opts.domain  createDomain() result
 * @param {(event:object)=>void} opts.onEvent  receives event payloads
 * @param {(alarm:object, kind:string)=>void} [opts.onChange]  optional debug hook
 */
export function createAlarmEngine({ clock, domain, onEvent, onChange } = {}) {
  const active = new Map(); // stable id -> alarm record
  const pending = new Map(); // stable id -> { level, sinceMet } (hold timers)
  const emit = typeof onEvent === 'function' ? onEvent : () => {};

  function push(kind, payload) {
    emit({ category: 'alarm', ...payload });
    if (typeof onChange === 'function') {
      try {
        onChange(payload, kind);
      } catch (err) {
        console.warn('[sim:alarms] onChange hook failed:', err);
      }
    }
  }

  function makeId(kind, vesselId) {
    return `ALM-${String(kind).toUpperCase()}-${vesselId || 'FLEET'}`;
  }

  function sourceLabelOf(vessel) {
    return vessel && vessel.spec ? `${vessel.spec.callSign} ${vessel.spec.name}` : '集群指挥';
  }

  function callSignOf(vessel) {
    return vessel && vessel.spec ? vessel.spec.callSign : 'USV-00';
  }

  function vesselLabel(vessel) {
    return callSignOf(vessel);
  }

  function enduranceMinutes(vessel) {
    const drain = Number.isFinite(vessel.drainPctPerMin) ? vessel.drainPctPerMin : 0.2;
    const pct = Math.max(0, vessel.batteryPct);
    return Math.max(1, Math.round(pct / Math.max(0.01, drain)));
  }

  function buildBattery(vessel, level) {
    const id = makeId('battery', vessel.spec.id);
    const critical = level === 2;
    return {
      id,
      kind: 'battery',
      level,
      vesselId: vessel.spec.id,
      sourceLabel: sourceLabelOf(vessel),
      title: critical ? '电量严重不足' : '电量偏低',
      text: critical
        ? `${vesselLabel(vessel)} 电量低于 15% · 当前 ${fmtPct(vessel.batteryPct)}`
        : `${vesselLabel(vessel)} 电量低于 25% · 当前 ${fmtPct(vessel.batteryPct)}`,
      detail: `当前 ${fmtPct(vessel.batteryPct)} · 预计续航约 ${enduranceMinutes(vessel)} 分钟`,
    };
  }

  function buildLink(vessel, level) {
    const id = makeId('link', vessel.spec.id);
    const critical = level === 2;
    const latency = Math.round(vessel.link.latencyMs);
    return {
      id,
      kind: 'link',
      level,
      vesselId: vessel.spec.id,
      sourceLabel: sourceLabelOf(vessel),
      title: critical ? '数据链严重劣化' : '数据链异常',
      text: critical
        ? `${vesselLabel(vessel)} 数据链严重劣化 · ${latency} ms`
        : `${vesselLabel(vessel)} 数据链延时过高 · ${latency} ms`,
      detail: `延时 ${latency} ms · 丢包 ${round1(vessel.link.lossPct)}% · MESH 中继 ${domain.relayCallSign || '—'}`,
    };
  }

  function buildStation(vessel, level, fallback) {
    const id = makeId('station', vessel.spec.id);
    const critical = level === 2;
    const err = Math.max(0, Math.round(vessel.stationErrorM));
    const limit = fallback ? ALARM_RULES.station.fallbackWarn : critical ? ALARM_RULES.station.crit : ALARM_RULES.station.warn;
    return {
      id,
      kind: 'station',
      level,
      vesselId: vessel.spec.id,
      sourceLabel: sourceLabelOf(vessel),
      title: critical ? '阵位严重偏离' : '阵位偏离',
      text: critical ? `${vesselLabel(vessel)} 阵位偏离过大 · ${err} m` : `${vesselLabel(vessel)} 阵位偏离 ${err} m`,
      detail: `相对编队阵位 ${err} m · 告警阈值 ${limit} m`,
    };
  }

  function buildOffline(vessel) {
    return {
      id: makeId('offline', vessel.spec.id),
      kind: 'offline',
      level: 2,
      vesselId: vessel.spec.id,
      sourceLabel: sourceLabelOf(vessel),
      title: '艇失联',
      text: `${vesselLabel(vessel)} 数据链中断 · 艇已失联`,
      detail: '遥测中断，等待链路恢复',
    };
  }

  function buildEstop(fleet, level) {
    return {
      id: makeId('estop', null),
      kind: 'estop',
      level: 2,
      vesselId: null,
      sourceLabel: '集群指挥',
      title: '紧急停止',
      text: '集群进入紧急停止状态',
      detail: `${fleet.total || 17} 艘艇动力切断 · 仅可执行解除急停指令`,
    };
  }

  function raise(alarm, met) {
    const record = {
      id: alarm.id,
      kind: alarm.kind,
      severity: alarm.level === 2 ? 'critical' : 'warning',
      vesselId: alarm.vesselId,
      sourceLabel: alarm.sourceLabel,
      title: alarm.title,
      detail: alarm.detail,
      sinceMet: met,
      sinceClockText: clock.clockText(met),
      updatedMet: met,
      acked: false,
      ackMet: null,
    };
    active.set(alarm.id, record);
    pending.delete(alarm.id);
    push(alarm.kind, {
      met,
      severity: record.severity,
      sourceId: alarm.vesselId,
      sourceLabel: record.sourceLabel,
      text: alarm.text,
      detail: alarm.detail,
    });
    return record;
  }

  function escalate(alarm, met) {
    const record = active.get(alarm.id);
    if (!record) return;
    record.severity = 'critical';
    record.title = alarm.title;
    record.detail = alarm.detail;
    record.updatedMet = met;
    record.acked = false; // re-arm: an escalation needs operator attention again
    push(alarm.kind, {
      met,
      severity: 'critical',
      sourceId: alarm.vesselId,
      sourceLabel: record.sourceLabel,
      text: alarm.text,
      detail: `告警升级 · ${alarm.detail}`,
    });
  }

  function downgrade(alarm, met) {
    const record = active.get(alarm.id);
    if (!record) return;
    record.severity = 'warning';
    record.title = alarm.title;
    record.detail = alarm.detail;
    record.updatedMet = met;
    record.acked = false;
    push(alarm.kind, {
      met,
      severity: 'warning',
      sourceId: alarm.vesselId,
      sourceLabel: record.sourceLabel,
      text: alarm.text,
      detail: `告警降级 · ${alarm.detail}`,
    });
  }

  function clear(id, met, text, detail) {
    const record = active.get(id);
    if (!record) return;
    active.delete(id);
    pending.delete(id);
    push(record.kind, {
      met,
      severity: 'success',
      sourceId: record.vesselId,
      sourceLabel: record.sourceLabel,
      text,
      detail,
    });
  }

  function recoveryText(record, vessel) {
    switch (record.kind) {
      case 'battery':
        return `${callSignOf(vessel)} 电量告警恢复 · 当前 ${fmtPct(vessel.batteryPct)}`;
      case 'link':
        return `${callSignOf(vessel)} 数据链恢复 · ${Math.round(vessel.link.latencyMs)} ms`;
      case 'station':
        return `${callSignOf(vessel)} 阵位恢复 · 误差 ${Math.max(0, Math.round(vessel.stationErrorM))} m`;
      case 'offline':
        return `${callSignOf(vessel)} 通信恢复`;
      case 'estop':
        return '集群已解除紧急停止';
      default:
        return `${record.sourceLabel} 告警恢复`;
    }
  }

  /**
   * Public `info` severity alarms are not used today, but keeping the counter
   * in the snapshot schema stable avoids a breaking change later.
   */
  const INFO_ALARM_COUNT = 0;

  /**
   * Evaluate every rule against the current telemetry.
   * @param {{met:number, vessels:Array, fleet:object}} state
   */
  function evaluate(state) {
    const met = Number.isFinite(state.met) ? state.met : clock.metOffset;
    const vessels = Array.isArray(state.vessels) ? state.vessels : [];
    const fleet = state.fleet || {};
    const seen = new Set();

    const vesselById = new Map(vessels.map((v) => [v.spec.id, v]));

    // ---- 急停 ---------------------------------------------------------------
    if (fleet.estopActive) {
      const alarm = buildEstop(fleet, 2);
      seen.add(alarm.id);
      const record = active.get(alarm.id);
      if (!record) {
        raise(alarm, Number.isFinite(fleet.estopSinceMet) ? fleet.estopSinceMet : met);
      } else if (record.severity === 'warning') {
        escalate(alarm, met);
      }
    } else {
      const record = active.get(makeId('estop', null));
      if (record) clear(record.id, met, recoveryText(record, null), '条件消失，告警自动恢复');
    }

    for (const vessel of vessels) {
      if (!vessel || !vessel.spec) continue;
      const vid = vessel.spec.id;

      // ---- 离线 -------------------------------------------------------------
      const offlineId = makeId('offline', vid);
      if (vessel.offline) {
        seen.add(offlineId);
        const record = active.get(offlineId);
        if (!record) raise(buildOffline(vessel), met);
      } else {
        const record = active.get(offlineId);
        if (record) clear(record.id, met, recoveryText(record, vessel), '链路重新建立，遥测恢复');
      }

      // ---- 低电量 -----------------------------------------------------------
      const batteryId = makeId('battery', vid);
      const prevBattery = levelOf(active.get(batteryId)?.severity);
      const batteryLevel = severityForLow(vessel.batteryPct, prevBattery, ALARM_RULES.battery);
      if (batteryLevel > 0) {
        seen.add(batteryId);
        const alarm = buildBattery(vessel, batteryLevel);
        const record = active.get(batteryId);
        if (!record) raise(alarm, met);
        else if (record.severity === 'warning' && batteryLevel === 2) escalate(alarm, met);
      } else {
        const record = active.get(batteryId);
        if (record) clear(record.id, met, recoveryText(record, vessel), '电量已回升至告警阈值以上');
      }

      // ---- 链路延时 ---------------------------------------------------------
      const linkId = makeId('link', vid);
      if (!vessel.offline) {
        const prevLink = levelOf(active.get(linkId)?.severity);
        const linkLevel = severityForHigh(vessel.link.latencyMs, prevLink, ALARM_RULES.link);
        if (linkLevel > 0) {
          seen.add(linkId);
          const alarm = buildLink(vessel, linkLevel);
          const record = active.get(linkId);
          if (!record) raise(alarm, met);
          else if (record.severity === 'warning' && linkLevel === 2) escalate(alarm, met);
          else if (record.severity === 'critical' && linkLevel === 1) downgrade(alarm, met);
        } else {
          const record = active.get(linkId);
          if (record) clear(record.id, met, recoveryText(record, vessel), '链路延时回到正常范围');
        }
      } else {
        // an offline vessel reports no link: keep link alarm if it existed, the
        // offline alarm already covers the condition.
        if (active.has(linkId)) seen.add(linkId);
      }

      // ---- 阵位偏离（需持续 ≥3 s，避免换队形瞬间误报） ----------------------
      const stationId = makeId('station', vid);
      const source = vessel.stationSource || 'none';
      const canJudge = source !== 'none' && !vessel.offline && vessel.sceneMode === 'formation';
      if (canJudge) {
        const fallback = source !== 'scene';
        const prevLevel = levelOf(active.get(stationId)?.severity);
        let stationLevel;
        if (fallback) {
          const thresholds = { warn: ALARM_RULES.station.fallbackWarn, warnClear: ALARM_RULES.station.fallbackClear, crit: Infinity, critClear: Infinity };
          stationLevel = severityForHigh(vessel.stationErrorM, prevLevel, thresholds);
        } else {
          stationLevel = severityForHigh(vessel.stationErrorM, prevLevel, ALARM_RULES.station);
        }
        if (stationLevel > 0) {
          const record = active.get(stationId);
          if (record) {
            seen.add(stationId);
            const alarm = buildStation(vessel, stationLevel, fallback);
            if (record.severity === 'warning' && stationLevel === 2) escalate(alarm, met);
            else if (record.severity === 'critical' && stationLevel === 1) downgrade(alarm, met);
          } else {
            // hold timer: the condition must persist before it becomes an alarm
            const hold = pending.get(stationId);
            if (!hold) {
              pending.set(stationId, { level: stationLevel, sinceMet: met });
            } else {
              hold.level = Math.max(hold.level, stationLevel);
              if (met - hold.sinceMet >= ALARM_RULES.stationHoldSec) {
                seen.add(stationId);
                raise(buildStation(vessel, hold.level, fallback), met);
              }
            }
          }
        } else {
          pending.delete(stationId);
          const record = active.get(stationId);
          if (record) clear(record.id, met, recoveryText(record, vessel), '艇已回到编队阵位');
        }
      } else {
        pending.delete(stationId);
        const record = active.get(stationId);
        if (record) clear(record.id, met, recoveryText(record, vessel), '艇已离开编队阵位判定条件');
      }
    }

    // prune active alarms whose condition object vanished (vessel left roster)
    for (const [id, record] of active) {
      if (seen.has(id)) continue;
      if (record.vesselId && !vesselById.has(record.vesselId)) {
        clear(id, met, `${record.sourceLabel} 告警恢复`, '遥测源已移除');
      }
    }
  }

  /** Consume-able pending holds, exposed for debug/self-test. */
  function pendingHolds() {
    return Array.from(pending.entries()).map(([id, hold]) => ({ id, ...hold }));
  }

  /** Snapshot view: critical first, then oldest first. */
  function list() {
    const out = Array.from(active.values()).map((record) => ({
      id: record.id,
      severity: record.severity,
      vesselId: record.vesselId,
      sourceLabel: record.sourceLabel,
      title: record.title,
      detail: record.detail,
      sinceMet: round1(record.sinceMet),
      sinceClockText: record.sinceClockText,
      acked: record.acked,
    }));
    out.sort((a, b) => {
      const rank = (a.severity === 'critical' ? 0 : 1) - (b.severity === 'critical' ? 0 : 1);
      if (rank !== 0) return rank;
      return a.sinceMet - b.sinceMet;
    });
    return out;
  }

  function counts() {
    let critical = 0;
    let warning = 0;
    let unread = 0;
    for (const record of active.values()) {
      if (record.severity === 'critical') critical += 1;
      else warning += 1;
      if (!record.acked) unread += 1;
    }
    return { critical, warning, info: INFO_ALARM_COUNT, unread };
  }

  function countForVessel(vesselId) {
    let critical = 0;
    let warning = 0;
    for (const record of active.values()) {
      if (record.vesselId !== vesselId) continue;
      if (record.severity === 'critical') critical += 1;
      else warning += 1;
    }
    return { critical, warning, total: critical + warning };
  }

  function ack(id, met) {
    const record = active.get(id);
    if (!record || record.acked) return { ok: false, id, text: '告警不存在或已签收' };
    record.acked = true;
    record.ackMet = Number.isFinite(met) ? met : clock.metOffset;
    push(record.kind, {
      met: record.ackMet,
      severity: 'info',
      sourceId: record.vesselId,
      sourceLabel: record.sourceLabel,
      text: `告警已签收 · ${record.title}`,
      detail: record.text || record.detail,
    });
    return { ok: true, id, text: '告警已签收' };
  }

  function ackAll(met) {
    const at = Number.isFinite(met) ? met : clock.metOffset;
    let count = 0;
    for (const record of active.values()) {
      if (record.acked) continue;
      record.acked = true;
      record.ackMet = at;
      count += 1;
    }
    if (count > 0) {
      push('fleet', {
        met: at,
        severity: 'info',
        sourceId: null,
        sourceLabel: '指挥台',
        text: `全部告警已签收 · ${count} 条`,
        detail: '操作员确认收悉当前活动告警',
      });
    }
    return { ok: true, count };
  }

  return {
    evaluate,
    list,
    counts,
    countForVessel,
    ack,
    ackAll,
    pendingHolds,
    /** debug / self-test */
    activeIds() {
      return Array.from(active.keys());
    },
    size() {
      return active.size;
    },
  };
}
