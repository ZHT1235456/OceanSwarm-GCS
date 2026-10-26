// =============================================================================
// OceanSwarm GCS — command bus.
//
// The UI never touches the scene directly: it calls sim.dispatch(cmd), Sim
// validates the §4.5 protocol, puts the command on a simulated data link
// (220–650 ms), then calls scene.execute(cmd). The result is written into the
// ack list and the event stream.
//
// Rejection happens at dispatch time (and is therefore immediate):
//   • unknown type / bad parameter / unknown vessel / payload id
//   • fleet emergency-stop: everything except fleet.recover is refused
//   • duplicate command inside the 400 ms debounce window
// =============================================================================

import { formatDistanceM, formatLatLon } from './format.js';

export const DEBOUNCE_MS = 400;
export const LINK_DELAY_MIN_MS = 220;
export const LINK_DELAY_SPAN_MS = 430; // 220 .. 650 ms

const FORMATION_SCALES = [0.5, 1, 1.8];
const SPEED_SCALES = [0.45, 1, 1.9];
const SENSOR_IDS = ['radar', 'eoir', 'sonar', 'ais', 'mesh'];

const COMMAND_TYPES = new Set([
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

const SPEED_LABEL = { 0.45: '微速', 1: '巡航', 1.9: '全速' };
const SCALE_LABEL = { 0.5: '集结', 1: '标准', 1.8: '分散' };

function nearly(value, target) {
  return Math.abs(value - target) < 1e-6;
}

function vesselOf(domain, id) {
  if (typeof id !== 'string') return null;
  return domain.byId.get(id) || null;
}

/** Build the console autocomplete catalogue from the domain tables. */
export function buildCommandCatalog(domain) {
  const formations = domain.formations.map((f) => f.key);
  return [
    { type: 'formation.set', args: ['formation'], values: formations, text: '编队队形 → 楔形' },
    { type: 'formation.scale', args: ['scale'], values: FORMATION_SCALES, text: '编队队距 → 集结 0.5×' },
    { type: 'fleet.speed', args: ['scale'], values: SPEED_SCALES, text: '航速 → 全速' },
    { type: 'fleet.hold', args: [], text: '编队保持' },
    { type: 'fleet.resume', args: [], text: '恢复编队' },
    { type: 'fleet.uturn', args: [], text: '调头 180°' },
    { type: 'fleet.rtl', args: [], text: '返航基地' },
    { type: 'fleet.cancelRtl', args: [], text: '取消返航' },
    { type: 'fleet.estop', args: [], text: '紧急停止' },
    { type: 'fleet.recover', args: [], text: '解除急停' },
    { type: 'vessel.goto', args: ['id', 'x', 'z'], text: '单艇定点导航 → USV-03 · 18°13.29′N 112°38.05′E' },
    { type: 'vessel.rtl', args: ['id'], text: '单艇返航 → USV-03' },
    { type: 'vessel.hold', args: ['id'], text: '单艇待机 → USV-03' },
    { type: 'vessel.resume', args: ['id'], text: '单艇归队 → USV-03' },
    { type: 'vessel.payload', args: ['id', 'sensor', 'on'], values: SENSOR_IDS, text: '载荷 光电吊舱 → 开启 · USV-03' },
  ];
}

/**
 * Validate and normalise a §4.5 command.
 * @returns {{ok:true, cmd:object} | {ok:false, error:string}}
 */
export function validateCommand(cmd, domain) {
  if (!cmd || typeof cmd !== 'object' || Array.isArray(cmd)) return { ok: false, error: '指令格式无效' };
  const type = cmd.type;
  if (typeof type !== 'string' || !COMMAND_TYPES.has(type)) {
    return { ok: false, error: `未知指令类型 · ${String(type ?? '空')}` };
  }

  switch (type) {
    case 'formation.set': {
      const formation = typeof cmd.formation === 'string' ? cmd.formation.toLowerCase() : '';
      if (!domain.formationByKey.has(formation)) return { ok: false, error: `未知队形 · ${String(cmd.formation ?? '空')}` };
      return { ok: true, cmd: { type, formation } };
    }
    case 'formation.scale': {
      const scale = Number(cmd.scale);
      if (!FORMATION_SCALES.some((s) => nearly(scale, s))) return { ok: false, error: `无效的编队队距 · ${String(cmd.scale ?? '空')}` };
      return { ok: true, cmd: { type, scale } };
    }
    case 'fleet.speed': {
      const scale = Number(cmd.scale);
      if (!SPEED_SCALES.some((s) => nearly(scale, s))) return { ok: false, error: `无效的航速档位 · ${String(cmd.scale ?? '空')}` };
      return { ok: true, cmd: { type, scale } };
    }
    case 'fleet.hold':
    case 'fleet.resume':
    case 'fleet.uturn':
    case 'fleet.rtl':
    case 'fleet.cancelRtl':
    case 'fleet.estop':
    case 'fleet.recover':
      return { ok: true, cmd: { type } };
    case 'vessel.goto': {
      const vessel = vesselOf(domain, cmd.id);
      if (!vessel) return { ok: false, error: `未知艇号 · ${String(cmd.id ?? '空')}` };
      const x = Number(cmd.x);
      const z = Number(cmd.z);
      if (!Number.isFinite(x) || !Number.isFinite(z)) return { ok: false, error: '目标坐标无效' };
      if (Math.abs(x) > 30000 || Math.abs(z) > 30000) return { ok: false, error: '目标坐标超出海域范围' };
      return { ok: true, cmd: { type, id: vessel.id, x, z } };
    }
    case 'vessel.rtl':
    case 'vessel.hold':
    case 'vessel.resume': {
      const vessel = vesselOf(domain, cmd.id);
      if (!vessel) return { ok: false, error: `未知艇号 · ${String(cmd.id ?? '空')}` };
      return { ok: true, cmd: { type, id: vessel.id } };
    }
    case 'vessel.payload': {
      const vessel = vesselOf(domain, cmd.id);
      if (!vessel) return { ok: false, error: `未知艇号 · ${String(cmd.id ?? '空')}` };
      const sensor = typeof cmd.sensor === 'string' ? cmd.sensor.toLowerCase() : '';
      if (!domain.sensorCatalog[sensor]) return { ok: false, error: `未知载荷 · ${String(cmd.sensor ?? '空')}` };
      if (typeof cmd.on !== 'boolean') return { ok: false, error: '载荷开关参数无效' };
      return { ok: true, cmd: { type, id: vessel.id, sensor, on: cmd.on } };
    }
    default:
      return { ok: false, error: `未知指令类型 · ${type}` };
  }
}

/** Chinese command label used by events / acks / the console echo. */
export function commandText(cmd, domain) {
  if (!cmd || typeof cmd !== 'object') return '指令';
  switch (cmd.type) {
    case 'formation.set': {
      const f = domain.formationByKey.get(cmd.formation);
      return `编队队形 → ${f ? f.name : cmd.formation}`;
    }
    case 'formation.scale':
      return `编队队距 → ${SCALE_LABEL[cmd.scale] || '自定义'} ${cmd.scale}×`;
    case 'fleet.speed':
      return `航速 → ${SPEED_LABEL[cmd.scale] || '自定义'}`;
    case 'fleet.hold':
      return '编队保持';
    case 'fleet.resume':
      return '恢复编队';
    case 'fleet.uturn':
      return '调头 180°';
    case 'fleet.rtl':
      return '返航基地';
    case 'fleet.cancelRtl':
      return '取消返航';
    case 'fleet.estop':
      return '紧急停止';
    case 'fleet.recover':
      return '解除急停';
    case 'vessel.goto': {
      const vessel = vesselOf(domain, cmd.id);
      const p = domain.projectWorld(cmd.x, cmd.z);
      return `单艇定点导航 → ${vessel ? vessel.callSign : cmd.id} · ${formatLatLon(p.lat, p.lon)}`;
    }
    case 'vessel.rtl': {
      const vessel = vesselOf(domain, cmd.id);
      return `单艇返航 → ${vessel ? vessel.callSign : cmd.id}`;
    }
    case 'vessel.hold': {
      const vessel = vesselOf(domain, cmd.id);
      return `单艇待机 → ${vessel ? vessel.callSign : cmd.id}`;
    }
    case 'vessel.resume': {
      const vessel = vesselOf(domain, cmd.id);
      return `单艇归队 → ${vessel ? vessel.callSign : cmd.id}`;
    }
    case 'vessel.payload': {
      const vessel = vesselOf(domain, cmd.id);
      const sensor = domain.sensorCatalog[cmd.sensor];
      return `载荷 ${sensor ? sensor.label : cmd.sensor} → ${cmd.on ? '开启' : '关闭'} · ${vessel ? vessel.callSign : cmd.id}`;
    }
    default:
      return `指令 ${String(cmd.type || '未知')}`;
  }
}

/** Distance helper used by command details (kept transitive to format.js). */
export function waypointDetailText(cmd, domain) {
  if (cmd.type !== 'vessel.goto') return null;
  const p = domain.projectWorld(cmd.x, cmd.z);
  return `目标 ${formatLatLon(p.lat, p.lon)} · 世界坐标 ${Math.round(cmd.x)}, ${Math.round(cmd.z)} m`;
}

function debounceKey(cmd) {
  const parts = [cmd.type];
  if (cmd.id !== undefined) parts.push(`id:${cmd.id}`);
  if (cmd.formation !== undefined) parts.push(`f:${cmd.formation}`);
  if (cmd.scale !== undefined) parts.push(`s:${cmd.scale}`);
  if (cmd.sensor !== undefined) parts.push(`p:${cmd.sensor}`);
  if (cmd.on !== undefined) parts.push(`o:${cmd.on ? 1 : 0}`);
  if (Number.isFinite(cmd.x) && Number.isFinite(cmd.z)) parts.push(`g:${cmd.x.toFixed(1)},${cmd.z.toFixed(1)}`);
  return parts.join('|');
}

function safeSceneState(getSceneState) {
  if (typeof getSceneState !== 'function') return null;
  try {
    return getSceneState();
  } catch (err) {
    console.warn('[sim:commands] scene.getSceneState failed:', err);
    return null;
  }
}

function estopActiveOf(sceneState) {
  const fleet = sceneState && sceneState.fleet;
  if (!fleet) return false;
  return !!fleet.estopActive || fleet.mode === 'estop';
}

/**
 * @param {object} opts
 * @param {object}   opts.domain
 * @param {Function} opts.execute        (cmd) => {ok,text,detail}
 * @param {Function} opts.getSceneState
 * @param {Function} opts.now            () => wall clock in ms
 * @param {Function} opts.rng            seeded rng for link delay
 * @param {object}   opts.hooks          {onAccepted, onRejected, onExecuted}
 */
export function createCommandBus({ domain, execute, getSceneState, now, rng, hooks = {} }) {
  const pendingTickets = [];
  const lastAccepted = new Map(); // debounce key -> wall ms
  let ticketSeq = 0;
  let lastError = null;

  const callHook = (name, payload) => {
    const fn = hooks[name];
    if (typeof fn !== 'function') return;
    try {
      fn(payload);
    } catch (err) {
      // A broken UI callback must not stall the command bus.
      console.warn(`[sim:commands] hook ${name} failed:`, err);
    }
  };

  function clockNow() {
    const value = typeof now === 'function' ? now() : 0;
    return Number.isFinite(value) ? value : 0;
  }

  function reject(rawCmd, fallbackText, error, submittedMs) {
    const text = commandText(rawCmd, domain) || fallbackText;
    lastError = error;
    callHook('onRejected', { cmd: rawCmd, commandText: text, error, submittedMs });
    return { accepted: false, ticket: null, error, commandText: text };
  }

  function dispatch(cmd, opts = {}) {
    const submittedMs = Number.isFinite(opts.nowMs) ? opts.nowMs : clockNow();
    const validation = validateCommand(cmd, domain);
    if (!validation.ok) return reject(cmd, '指令校验', validation.error, submittedMs);
    const normalized = validation.cmd;
    const text = commandText(normalized, domain);

    const sceneState = safeSceneState(getSceneState);
    if (estopActiveOf(sceneState) && normalized.type !== 'fleet.recover') {
      return reject(normalized, text, '急停状态下仅可解除急停', submittedMs);
    }

    const key = debounceKey(normalized);
    const last = lastAccepted.get(key);
    if (last !== undefined && submittedMs - last < DEBOUNCE_MS) {
      return reject(normalized, text, `重复指令已忽略 · 防抖 ${DEBOUNCE_MS} ms`, submittedMs);
    }

    const delayMs = LINK_DELAY_MIN_MS + Math.round(rng() * LINK_DELAY_SPAN_MS);
    const ticket = {
      id: `CMD-${String(++ticketSeq).padStart(3, '0')}`,
      cmd: normalized,
      commandText: text,
      submittedMs,
      executeAtMs: submittedMs + delayMs,
      delayMs,
    };
    pendingTickets.push(ticket);
    lastAccepted.set(key, submittedMs);
    pruneDebounce(submittedMs);
    lastError = null;
    callHook('onAccepted', ticket);
    return {
      accepted: true,
      ticket: ticket.id,
      error: null,
      commandText: text,
      delayMs,
      queuePosition: pendingTickets.length,
    };
  }

  function pruneDebounce(nowMs) {
    if (lastAccepted.size < 256) return;
    for (const [key, at] of lastAccepted) {
      if (nowMs - at > 10000) lastAccepted.delete(key);
    }
  }

  /** Execute every ticket whose data-link delay has elapsed. Called each frame. */
  function process(nowMs) {
    const time = Number.isFinite(nowMs) ? nowMs : clockNow();
    if (!pendingTickets.length) return 0;
    const due = [];
    for (let i = 0; i < pendingTickets.length; ) {
      if (pendingTickets[i].executeAtMs <= time) {
        due.push(pendingTickets[i]);
        pendingTickets.splice(i, 1);
      } else {
        i += 1;
      }
    }
    if (!due.length) return 0;
    due.sort((a, b) => a.executeAtMs - b.executeAtMs || a.submittedMs - b.submittedMs);
    for (const ticket of due) {
      const latencyMs = Math.max(0, Math.round(time - ticket.submittedMs));
      let result;
      try {
        result = typeof execute === 'function' ? execute(ticket.cmd) : null;
      } catch (err) {
        // The Lead's sceneProvider guarantees it never throws; if it ever does,
        // fail the command instead of taking the console down.
        console.warn('[sim:commands] scene.execute threw:', err);
        result = { ok: false, text: '场景执行异常', detail: err && err.message ? String(err.message) : null };
      }
      if (!result || typeof result !== 'object') {
        result = { ok: false, text: '场景执行器无响应', detail: null };
      }
      const normalizedResult = {
        ok: !!result.ok,
        text: typeof result.text === 'string' ? result.text : result.ok ? '指令已执行' : '指令未执行',
        detail: result.detail === undefined ? null : result.detail,
      };
      lastError = normalizedResult.ok ? null : normalizedResult.text;
      callHook('onExecuted', { ticket, result: normalizedResult, latencyMs, nowMs: time });
    }
    return due.length;
  }

  return {
    dispatch,
    process,
    pendingTickets() {
      return pendingTickets.map((t) => ({
        id: t.id,
        type: t.cmd.type,
        commandText: t.commandText,
        submittedMs: t.submittedMs,
        executeAtMs: t.executeAtMs,
      }));
    },
    hasPending() {
      return pendingTickets.length > 0;
    },
    lastError() {
      return lastError;
    },
    clear() {
      pendingTickets.length = 0;
      lastAccepted.clear();
    },
  };
}

export { COMMAND_TYPES, FORMATION_SCALES, SPEED_SCALES, SENSOR_IDS };
