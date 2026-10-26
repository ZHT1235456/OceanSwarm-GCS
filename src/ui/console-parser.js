// =============================================================================
// GCS command-console parser (no DOM, pure logic).
//
// The dock's command line is the duty officer's direct order channel, so the
// grammar is deliberately forgiving: Chinese and English words, aliases,
// full-width punctuation, optional colon / x-z labels and USV call signs or
// names as targets are all accepted. Parsing never touches the scene — every
// command is executed through ctx.actions / ctx.dispatch (contract §4.6).
//
// parseConsole(text, ctx) →
//   { ok:true,  id, label, run(ctx) }        run returns dispatch result / promise
//   { ok:false, message, hint? }             rendered red under the input line
//
// Examples:
//   formation wedge        编队 楔形        楔形
//   speed flank            航速 全速        全速
//   hold / 保持            resume / 恢复
//   uturn / 调头           rtl / 返航       estop / 急停
//   select USV-07          选中 侦察-3
//   goto 900 -200          派遣 USV-04 900 -200
//   vessel rtl scout-2     单艇返航 侦察-3
//   help / 帮助            clear / 清空
// =============================================================================
import { META as DEFAULT_META } from '../gcs/meta.js';

const DASH = '—';

// --- alias tables ------------------------------------------------------------
// Longest alias wins, so "编队保持" is read as hold / "解除急停" as recover and
// never as its shorter prefix.
const COMMAND_ALIASES = {
  formation: ['formation', 'form', '队形', '编队', '编队队形', '阵列'],
  speed: ['speed', '航速', '速度', '速率'],
  hold: ['hold', '保持', '编队保持', '原地保持', '待机', 'stop'],
  resume: ['resume', '恢复', '恢复编队', '继续', '继续巡航', '归队'],
  uturn: ['uturn', 'u-turn', 'turn', '调头', '掉头', '转向', '调头180', '掉头180', '调头180°', '掉头180°'],
  rtl: ['rtl', 'return', '返航', '回航', '返航基地'],
  cancelrtl: ['cancelrtl', 'cancel-rtl', '取消返航', '中止返航', '停止返航'],
  estop: ['estop', 'e-stop', '急停', '紧急停止', '紧急制动'],
  recover: ['recover', '解除急停', '恢复急停', '解除', '复位'],
  rally: ['rally', '集结', '集合', '收拢'],
  disperse: ['disperse', '分散', '散开', '展开'],
  select: ['select', '选中', '选择', '选择无人艇', '选择艇', '切换'],
  goto: ['goto', 'go', 'nav', '定点导航', '导航', '前往', '派遣', '航点'],
  vessel: ['vessel', '单艇', '艇'],
  help: ['help', '?', '？', '帮助', '指令帮助', '命令', '命令列表'],
  clear: ['clear', 'cls', '清空', '清除', '清屏'],
};

// Flatten alias → command id and sort longest first.
const ALIAS_LIST = [];
for (const [id, aliases] of Object.entries(COMMAND_ALIASES)) {
  for (const alias of aliases) ALIAS_LIST.push({ id, alias });
}
ALIAS_LIST.sort((a, b) => b.alias.length - a.alias.length);
const ALIAS_TO_ID = new Map(ALIAS_LIST.map(({ id, alias }) => [alias, id]));
const HEAD_ALIASES = ALIAS_LIST.map(({ alias }) => alias);

const FORMATION_ALIASES = {
  wedge: 'wedge', 楔形: 'wedge', 楔: 'wedge', 楔形队形: 'wedge', 楔形编队: 'wedge',
  column: 'column', 纵队: 'column', 纵列: 'column', 纵: 'column',
  line: 'line', 横队: 'line', 横列: 'line', 横: 'line', 一字: 'line',
  diamond: 'diamond', 菱形: 'diamond', 菱: 'diamond', 菱形队形: 'diamond',
  ring: 'ring', 环形: 'ring', 圆环: 'ring', 环: 'ring',
};

const SPEED_ALIASES = {
  slow: 'slow', 微速: 'slow', 慢速: 'slow', 低速: 'slow',
  cruise: 'cruise', 巡航: 'cruise', 常速: 'cruise', 中速: 'cruise',
  flank: 'flank', 全速: 'flank', 高速: 'flank', 最大: 'flank',
};

const VESSEL_ACTION_ALIASES = {
  rtl: 'rtl', 返航: 'rtl', 回航: 'rtl',
  hold: 'hold', 保持: 'hold', 待机: 'hold',
  resume: 'resume', 恢复: 'resume', 归队: 'resume',
};

// --- helpers -----------------------------------------------------------------
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const pad2 = (v) => String(Math.max(0, Math.round(v))).padStart(2, '0');

const ok = (id, label, run) => ({ ok: true, id, label, run });
const fail = (message, hint) => ({ ok: false, message, ...(hint ? { hint } : {}) });

/** Lower-case, collapse whitespace and turn CJK punctuation into separators. */
export function normalizeConsole(raw) {
  return String(raw == null ? '' : raw)
    .replace(/[\u3000\u00a0]/g, ' ')
    .replace(/[，、；;：]/g, ' ')
    .replace(/[（）()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const isCjk = (ch) => /[\u3400-\u9fff]/.test(ch || '');

/**
 * Split "编队楔形" / "formation wedge" into command head + argument string.
 * Chinese aliases may be glued to their argument; latin aliases need a boundary.
 */
function splitHead(norm) {
  for (const alias of HEAD_ALIASES) {
    if (norm === alias) return { head: alias, rest: '' };
    if (norm.startsWith(alias + ' ')) return { head: alias, rest: norm.slice(alias.length + 1).trim() };
    if (isCjk(alias) && norm.startsWith(alias) && isCjk(norm.charAt(alias.length))) {
      return { head: alias, rest: norm.slice(alias.length).trim() };
    }
  }
  const spaceAt = norm.indexOf(' ');
  if (spaceAt === -1) return { head: norm, rest: '' };
  return { head: norm.slice(0, spaceAt), rest: norm.slice(spaceAt + 1).trim() };
}

function metaOf(ctx) {
  return ctx && ctx.meta ? ctx.meta : DEFAULT_META;
}

/** Resolve a roster token: id / call sign / 编号 / Chinese name / 旗舰. */
export function resolveVesselToken(token, ctx) {
  const meta = metaOf(ctx);
  const roster = meta.FLEET || [];
  const byId = meta.FLEET_BY_ID || new Map(roster.map((v) => [v.id, v]));
  const raw = String(token == null ? '' : token).trim();
  if (!raw) return null;
  const low = raw.toLowerCase().replace(/\s+/g, '');
  if (byId.has(low)) return byId.get(low);

  // USV-07 / usv07 / 07 / 7
  const m = low.match(/^(?:usv[-\s]?)?(\d{1,2})$/);
  if (m) {
    const idx = Number(m[1]) - 1;
    if (idx >= 0 && idx < roster.length) return roster[idx];
  }
  if (/^(旗舰|旗舰艇|指挥舰|指挥艇|flagship|flag)$/.test(low)) {
    return roster.find((v) => v.id === 'flagship') || roster[0] || null;
  }
  const bare = low.replace(/[-_\s]/g, '');
  for (const v of roster) {
    const name = String(v.name || '').toLowerCase().replace(/[-_\s]/g, '');
    const call = String(v.callSign || '').toLowerCase().replace(/[-_\s]/g, '');
    if (name === bare || call === bare) return v;
    if (name && bare.endsWith(name)) return v;
  }
  return null;
}

function vesselLabel(vessel) {
  if (!vessel) return DASH;
  return `${vessel.callSign || vessel.id} ${vessel.name || ''}`.trim();
}

function formationName(ctx, key) {
  const meta = metaOf(ctx);
  const f = (meta.FORMATIONS || []).find((item) => item.key === key);
  return f ? f.name : key;
}

function speedName(ctx, key) {
  const meta = metaOf(ctx);
  const p = (meta.SPEED_PRESETS || []).find((item) => item.key === key);
  return p ? p.name : key;
}

// --- individual command parsers ----------------------------------------------
function parseFormation(rest, ctx) {
  if (!rest) {
    return fail('缺少队形参数', '用法：formation wedge|column|line|diamond|ring，或「编队 楔形」');
  }
  const words = rest.replace(/(队形|编队|formation)/g, ' ').split(' ').filter(Boolean);
  let key = null;
  for (const w of words) {
    if (FORMATION_ALIASES[w]) {
      key = FORMATION_ALIASES[w];
      break;
    }
  }
  if (!key) return fail(`未知队形「${rest}」`, '可选：楔形 wedge / 纵队 column / 横队 line / 菱形 diamond / 环形 ring');
  const f = metaOf(ctx).FORMATION_BY_KEY && metaOf(ctx).FORMATION_BY_KEY.get(key);
  const label = `编队队形 → ${f ? f.name : key}${f ? ` ${f.en}` : ''}`;
  return ok('formation', label, (c) => c.actions.setFormation(key));
}

function parseSpeed(rest, ctx) {
  if (!rest) return fail('缺少航速参数', '用法：speed slow|cruise|flank，或「航速 全速」');
  const meta = metaOf(ctx);
  const presets = meta.SPEED_PRESETS || [];
  const words = rest.replace(/(航速|速度|speed)/g, ' ').split(' ').filter(Boolean);
  let preset = null;
  for (const w of words) {
    if (SPEED_ALIASES[w]) {
      preset = presets.find((p) => p.key === SPEED_ALIASES[w]) || null;
      break;
    }
    const n = Number(w);
    if (isNum(n)) {
      preset = presets.find((p) => Math.abs(p.scale - n) < 0.001) || null;
      if (preset) break;
    }
  }
  if (!preset) return fail(`未知航速「${rest}」`, '可选：微速 slow / 巡航 cruise / 全速 flank');
  return ok('speed', `航速 → ${preset.name} ${preset.en}`, (c) => c.actions.setSpeedScale(preset.scale));
}

function parseSelect(rest, ctx) {
  if (!rest) return fail('缺少目标艇', '用法：select USV-07 / 选中 侦察-3');
  const vessel = resolveVesselToken(rest, ctx);
  if (!vessel) return fail(`未找到无人艇「${rest}」`, '可用呼号 USV-01…USV-17、艇 id（scout-2）或中文名（侦察-3）');
  return ok('select', `选中 → ${vesselLabel(vessel)}`, (c) => {
    const selected = c.actions.selectVessel(vessel.id);
    return { accepted: selected !== false, ok: selected !== false, commandText: `选中 ${vessel.callSign}` };
  });
}

function parseGoto(rest, ctx) {
  if (!rest) return fail('缺少坐标', '用法：goto x z（米，东 = +X / 北 = -Z），或「派遣 USV-04 900 -200」');
  const tokens = rest.replace(/[,;]/g, ' ').split(' ').filter(Boolean);
  const nums = [];
  const words = [];
  for (const tok of tokens) {
    const n = Number(tok);
    if (isNum(n)) {
      nums.push(n);
    } else if (/^[xz]\s*[:=]?$/.test(tok) || /^[xz]\s*[:=].+/.test(tok)) {
      const inlined = tok.match(/^[xz]\s*[:=]\s*(-?\d+(?:\.\d+)?)$/);
      if (inlined) nums.push(Number(inlined[1]));
      // bare x/z labels are simply ignored
    } else if (tok === 'm' || tok === '米') {
      // unit suffix
    } else {
      words.push(tok);
    }
  }
  let vessel = null;
  if (words.length) {
    vessel = resolveVesselToken(words.join(' '), ctx);
    if (!vessel) return fail(`无法识别目标艇「${words.join(' ')}」`, '用法：goto x z，或「派遣 USV-04 900 -200」');
  }
  if (nums.length < 2) return fail('定点导航需要两个坐标：x z', '示例：goto 900 -200');
  const x = nums[0];
  const z = nums[1];
  if (Math.abs(x) > 12000 || Math.abs(z) > 12000) return fail('坐标超出任务海域范围（±12000 m）');
  const targetId = vessel ? vessel.id : ctx && ctx.state ? ctx.state.selectedId : null;
  if (!targetId) return fail('未选择无人艇', '先「选中 USV-07」或在名册中点选一艘艇');
  const meta = metaOf(ctx);
  const target = meta.FLEET_BY_ID && meta.FLEET_BY_ID.get(targetId);
  const targetLabel = target ? `${target.callSign} ${target.name}` : targetId;
  const label = `定点导航 → ${targetLabel} · X ${Math.round(x)} / Z ${Math.round(z)} m`;
  return ok('goto', label, (c) => {
    if (c.state && c.state.selectedId !== targetId) c.actions.selectVessel(targetId);
    return c.actions.gotoVesselAt(targetId, x, z);
  });
}

function parseVesselCommand(rest, ctx) {
  if (!rest) return fail('缺少单艇动作', '用法：vessel rtl|hold|resume [目标艇]，如「单艇返航 侦察-3」');
  const tokens = rest.split(' ').filter(Boolean);
  let action = null;
  let targetToken = '';
  for (let i = 0; i < tokens.length; i++) {
    const id = VESSEL_ACTION_ALIASES[tokens[i]];
    if (id) {
      action = id;
      targetToken = tokens.slice(i + 1).join(' ');
      break;
    }
  }
  if (!action) return fail(`未知单艇动作「${rest}」`, '可选：返航 rtl / 保持 hold / 归队 resume');
  const vessel = targetToken ? resolveVesselToken(targetToken, ctx) : resolveVesselToken(ctx && ctx.state ? ctx.state.selectedId : '', ctx);
  if (!vessel) return fail(`未找到无人艇「${targetToken || '未选中的艇'}」`, '用法：单艇返航 USV-07');
  const actionName = { rtl: '单艇返航', hold: '保持待机', resume: '归队恢复' }[action];
  return ok(`vessel-${action}`, `${actionName} → ${vesselLabel(vessel)}`, (c) => {
    if (action === 'rtl') return c.actions.vesselRtl(vessel.id);
    if (action === 'hold') return c.actions.vesselHold(vessel.id);
    return c.actions.vesselResume(vessel.id);
  });
}

// --- public API --------------------------------------------------------------
/**
 * Parse a command line. Never throws for user input.
 * @returns {{ok:true, id:string, label:string, run:(ctx:any)=>any}|{ok:false, message:string, hint?:string}}
 */
export function parseConsole(raw, ctx) {
  const original = String(raw == null ? '' : raw).trim();
  if (!original) return fail('请输入指令', '输入 help 查看可用指令');
  const norm = normalizeConsole(original);
  if (!norm) return fail('请输入指令', '输入 help 查看可用指令');

  const { head, rest } = splitHead(norm);
  const command = ALIAS_TO_ID.get(head) || (ALIAS_TO_ID.get(norm) || null);

  // shorthand: a bare formation / speed word ("楔形", "全速")
  if (!command) {
    if (FORMATION_ALIASES[norm]) return parseFormation(norm, ctx);
    if (SPEED_ALIASES[norm]) return parseSpeed(norm, ctx);
    const canonical = ALIAS_TO_ID.get(norm);
    if (canonical) return dispatchSimple(canonical, '', ctx);
    // a bare roster token is a select shorthand ("侦察3", "USV-07", "scout-2")
    if (resolveVesselToken(norm, ctx)) return parseSelect(norm, ctx);
    return fail(`未知指令「${original}」`, '输入 help 查看可用指令（支持中文/英文别名）');
  }
  return dispatchSimple(command, rest, ctx);

  function dispatchSimple(id, args, c) {
    switch (id) {
      case 'formation':
        return parseFormation(args, c);
      case 'speed':
        return parseSpeed(args, c);
      case 'hold':
        return ok('hold', '编队保持 HOLD', (cc) => cc.actions.holdFleet());
      case 'resume':
        return ok('resume', '编队恢复 CRUISE', (cc) => cc.actions.resumeFleet());
      case 'uturn':
        return ok('uturn', '编队调头 180°', (cc) => cc.actions.uturn());
      case 'rtl':
        return ok('rtl', '返航基地 RTL', (cc) => cc.actions.rtlFleet());
      case 'cancelrtl':
        return ok('cancelrtl', '取消返航', (cc) => cc.actions.cancelRtl());
      case 'estop':
        return ok('estop', '紧急停止 E-STOP（需二次确认）', (cc) => cc.actions.estop());
      case 'recover':
        return ok('recover', '解除紧急停止', (cc) => cc.actions.recover());
      case 'rally':
        return ok('rally', '编队集结', (cc) => cc.actions.rally());
      case 'disperse':
        return ok('disperse', '编队分散', (cc) => cc.actions.disperse());
      case 'select':
        return parseSelect(args, c);
      case 'goto':
        return parseGoto(args, c);
      case 'vessel':
        return parseVesselCommand(args, c);
      case 'help':
        return ok('help', '打开操作帮助', (cc) => {
          cc.actions.requestHelp();
          return { accepted: true, ok: true };
        });
      case 'clear':
        return ok('clear', '指令台已清空', () => ({ accepted: true, ok: true }));
      default:
        return fail(`未知指令「${original}」`, '输入 help 查看可用指令');
    }
  }
}

/** Suggestion chips rendered in the command panel (click = fill, not submit). */
export const CONSOLE_SUGGESTIONS = [
  { label: '编队 楔形', text: '编队 楔形' },
  { label: '航速 全速', text: '航速 全速' },
  { label: '保持', text: '保持' },
  { label: '返航', text: '返航' },
  { label: 'help', text: 'help' },
];

export const CONSOLE_EXAMPLES =
  'formation wedge / 编队 楔形 / speed flank / goto 900 -200 / select USV-07 / help';

/** All latin keywords, used by Tab completion (primary commands first). */
const COMPLETION_WORDS = [];
for (const { alias } of ALIAS_LIST) {
  if (/^[a-z][a-z-]*$/.test(alias) && !COMPLETION_WORDS.includes(alias)) COMPLETION_WORDS.push(alias);
}
const PRIMARY_ORDER = ['formation', 'speed', 'hold', 'resume', 'uturn', 'rtl', 'estop', 'recover', 'select', 'goto', 'vessel', 'help', 'clear', 'rally', 'disperse'];
COMPLETION_WORDS.sort((a, b) => {
  const ia = a === 'formation' ? -1 : PRIMARY_ORDER.indexOf(a);
  const ib = b === 'formation' ? -1 : PRIMARY_ORDER.indexOf(b);
  const ra = ia === -1 && a !== 'formation' ? 999 : ia;
  const rb = ib === -1 && b !== 'formation' ? 999 : ib;
  return ra - rb || a.localeCompare(b);
});
const SUB_COMPLETIONS = {
  formation: ['wedge', 'column', 'line', 'diamond', 'ring', '楔形', '纵队', '横队', '菱形', '环形'],
  speed: ['slow', 'cruise', 'flank', '微速', '巡航', '全速'],
  vessel: ['rtl', 'hold', 'resume', '返航', '保持', '归队'],
  goto: [],
  select: [],
};

/**
 * Tab completion for the console input.
 * @returns {{value:string, candidates:string[]}}
 */
export function completeConsole(raw) {
  const source = String(raw == null ? '' : raw);
  const trimmed = source.replace(/\s+$/, '');
  const norm = normalizeConsole(trimmed);
  const hasArg = trimmed !== source || trimmed.includes(' ');

  // complete the first word
  if (!hasArg) {
    if (!norm) return { value: source, candidates: COMPLETION_WORDS };
    const matches = COMPLETION_WORDS.filter((w) => w.startsWith(norm) && w !== norm);
    if (!matches.length) return { value: source, candidates: [] };
    const pick = matches[0];
    const word = trimmed.split(' ').pop() || '';
    const head = trimmed.slice(0, trimmed.length - word.length);
    return { value: head + pick + ' ', candidates: matches };
  }

  // complete an argument for known commands
  const spaceAt = trimmed.indexOf(' ');
  const headRaw = spaceAt === -1 ? trimmed : trimmed.slice(0, spaceAt);
  const argRaw = spaceAt === -1 ? '' : trimmed.slice(spaceAt + 1);
  const headNorm = normalizeConsole(headRaw);
  const commandId =
    ALIAS_TO_ID.get(headNorm) ||
    (FORMATION_ALIASES[headNorm] ? 'formation' : null) ||
    (SPEED_ALIASES[headNorm] ? 'speed' : null);
  if (!commandId) return { value: source, candidates: [] };
  const pool = SUB_COMPLETIONS[commandId] || [];
  const prefix = normalizeConsole(argRaw);
  const matches = pool.filter((w) => w.startsWith(prefix) && w !== prefix);
  if (!matches.length) return { value: source, candidates: [] };
  const base = spaceAt === -1 ? trimmed + ' ' : trimmed.slice(0, spaceAt + 1);
  const pick = matches[0];
  return { value: base + pick + ' ', candidates: matches };
}
