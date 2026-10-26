// =============================================================================
// OceanSwarm GCS — mission / fleet / formation domain constants.
// The single source of truth for every UI module and for the simulation layer.
// World convention (inherited): +X = east, -Z = north, +Y = up, meters.
// =============================================================================
import { FLEET_ROSTER, LAYOUT } from '../config.js';

// --- geographic projection ---------------------------------------------------
// World origin sits in the mission area; heading0 of the inherited scene points
// east (+X), and the wide left arc curves northwards towards the trial base.
export const GEO = {
  lat0: 18.2215,
  lon0: 112.6412,
  mPerDegLat: 111320,
  area: '南海 · 试验海域 A',
  areaEn: 'SOUTH CHINA SEA · TEST AREA A',
};

export const projectWorld = (x, z) => ({
  lat: GEO.lat0 - z / GEO.mPerDegLat,
  lon: GEO.lon0 + x / (GEO.mPerDegLat * Math.cos((GEO.lat0 * Math.PI) / 180)),
});

// --- vessel classes ----------------------------------------------------------
export const TYPE_META = {
  flagship: {
    typeName: '三体无人指挥舰',
    roleEn: 'TRIMARAN COMMAND',
    short: 'FLAG',
    lengthM: 30,
    sensors: ['radar', 'eoir', 'sonar', 'ais', 'mesh'],
    powerKw: 42,
    colorVar: '--gcs-type-flagship',
    hex: '#ffd27a',
  },
  scout: {
    typeName: '高速侦察艇',
    roleEn: 'FAST SCOUT',
    short: 'SCOUT',
    lengthM: 10.5,
    sensors: ['radar', 'eoir', 'ais'],
    powerKw: 6.4,
    colorVar: '--gcs-type-scout',
    hex: '#5ff3e4',
  },
  env: {
    typeName: '环境监测艇',
    roleEn: 'ENV MONITOR',
    short: 'ENV',
    lengthM: 16.5,
    sensors: ['radar', 'eoir', 'sonar', 'ais'],
    powerKw: 9.2,
    colorVar: '--gcs-type-env',
    hex: '#7ee0b8',
  },
  survey: {
    typeName: '海洋测绘双体艇',
    roleEn: 'HYDRO SURVEY',
    short: 'SURVEY',
    lengthM: 18,
    sensors: ['radar', 'sonar', 'ais'],
    powerKw: 8.6,
    colorVar: '--gcs-type-survey',
    hex: '#9fd6e8',
  },
  patrol: {
    typeName: '多用途巡逻艇',
    roleEn: 'PATROL',
    short: 'PATROL',
    lengthM: 14.5,
    sensors: ['radar', 'eoir', 'ais'],
    powerKw: 8.0,
    colorVar: '--gcs-type-patrol',
    hex: '#ffb257',
  },
  comms: {
    typeName: '通信中继艇',
    roleEn: 'COMMS RELAY',
    short: 'COMMS',
    lengthM: 19,
    sensors: ['mesh', 'ais', 'radar'],
    powerKw: 10.5,
    colorVar: '--gcs-type-comms',
    hex: '#c1a7ff',
  },
  energy: {
    typeName: '能源保障艇',
    roleEn: 'ENERGY SUPPORT',
    short: 'ENERGY',
    lengthM: 20,
    sensors: ['radar', 'ais'],
    powerKw: 34,
    colorVar: '--gcs-type-energy',
    hex: '#ffcf6e',
  },
  rescue: {
    typeName: '无人救援艇',
    roleEn: 'SAR RESCUE',
    short: 'RESCUE',
    lengthM: 15.5,
    sensors: ['eoir', 'radar', 'ais', 'mesh'],
    powerKw: 7.2,
    colorVar: '--gcs-type-rescue',
    hex: '#ff9a8a',
  },
};

// --- roster (display order = call-sign order) --------------------------------
const ID_ORDER = [
  'flagship',
  'scout-1', 'scout-2', 'scout-3', 'scout-4', 'scout-5',
  'env-1', 'env-2', 'env-3', 'survey-1', 'survey-2',
  'patrol-1', 'patrol-2',
  'comms-1', 'energy-1', 'energy-2', 'rescue-1',
];

const CN_NAMES = {
  flagship: '海巡指挥舰',
  'scout-1': '侦察-1', 'scout-2': '侦察-2', 'scout-3': '侦察-3',
  'scout-4': '侦察-4', 'scout-5': '侦察-5',
  'env-1': '环境-1', 'env-2': '环境-2', 'env-3': '环境-3',
  'survey-1': '测绘-1', 'survey-2': '测绘-2',
  'patrol-1': '巡逻-1', 'patrol-2': '巡逻-2',
  'comms-1': '通信-1',
  'energy-1': '能源-1', 'energy-2': '能源-2',
  'rescue-1': '救援-1',
};

const rosterById = new Map(FLEET_ROSTER.map((r) => [r.id, r]));
const displayRoster = ID_ORDER.map((id, index) => {
  const spec = rosterById.get(id);
  if (!spec) throw new Error(`[gcs/meta] unknown roster id: ${id}`);
  const tm = TYPE_META[spec.type];
  return {
    id,
    type: spec.type,
    variant: spec.variant ?? 0,
    callSign: `USV-${String(index + 1).padStart(2, '0')}`,
    name: CN_NAMES[id] || id,
    typeName: tm.typeName,
    roleEn: tm.roleEn,
    group: groupKeyOf(spec.type),
    offset: spec.offset,
  };
});

function groupKeyOf(type) {
  if (type === 'flagship') return 'flagship';
  if (type === 'scout') return 'scout';
  if (type === 'env' || type === 'survey') return 'survey';
  if (type === 'patrol') return 'patrol';
  return 'support';
}

export const FLEET = displayRoster;
export const FLEET_BY_ID = new Map(displayRoster.map((v) => [v.id, v]));

export const GROUPS = [
  { key: 'flagship', name: '指挥舰', en: 'FLAGSHIP', ids: ['flagship'] },
  {
    key: 'scout',
    name: '侦察分队',
    en: 'SCOUT FLOTILLA',
    ids: ['scout-1', 'scout-2', 'scout-3', 'scout-4', 'scout-5'],
  },
  {
    key: 'survey',
    name: '环境与测绘分队',
    en: 'SURVEY WING',
    ids: ['env-1', 'env-2', 'env-3', 'survey-1', 'survey-2'],
  },
  { key: 'patrol', name: '巡逻警戒分队', en: 'PATROL UNIT', ids: ['patrol-1', 'patrol-2'] },
  {
    key: 'support',
    name: '综合保障分队',
    en: 'SUPPORT GROUP',
    ids: ['comms-1', 'energy-1', 'energy-2', 'rescue-1'],
  },
];

// --- formations --------------------------------------------------------------
// Glyphs are 24x24 path data rendered by src/ui/icons.js (stroke currentColor).
export const FORMATIONS = [
  { key: 'wedge', name: '楔形', en: 'WEDGE', glyph: 'M3 18 L12 4 L21 18 M12 4 L12 20' },
  { key: 'column', name: '纵队', en: 'COLUMN', glyph: 'M12 3 V21 M7 6 V21 M17 6 V21' },
  { key: 'line', name: '横队', en: 'LINE', glyph: 'M3 12 H21 M3 17 H21 M3 7 H21' },
  { key: 'diamond', name: '菱形', en: 'DIAMOND', glyph: 'M12 3 L21 12 L12 21 L3 12 Z' },
  { key: 'ring', name: '环形', en: 'RING', glyph: 'M12 3 A9 9 0 1 0 12.01 3 Z M12 9 A3 3 0 1 0 12.01 9 Z' },
];

export const FORMATION_BY_KEY = new Map(FORMATIONS.map((f) => [f.key, f]));

export const SPEED_PRESETS = [
  { key: 'slow', name: '微速', en: 'SLOW', scale: 0.45 },
  { key: 'cruise', name: '巡航', en: 'CRUISE', scale: 1 },
  { key: 'flank', name: '全速', en: 'FLANK', scale: 1.9 },
];

// --- mission -----------------------------------------------------------------
// Waypoints follow the inherited wide left arc (see src/systems/formation.js).
export const MISSION = {
  id: 'M-07',
  code: 'M-07',
  name: '协同警戒巡航',
  en: 'COOPERATIVE PATROL',
  area: GEO.area,
  areaEn: GEO.areaEn,
  operator: '海洋智能系统研究所',
  vesselCount: FLEET.length,
  metOffsetSec: 720, // the console opens mid-mission, phase 4
  phases: [
    { key: 'deploy', name: '航渡展开', en: 'DEPLOY', durationSec: 180 },
    { key: 'formup', name: '编队集结', en: 'FORM UP', durationSec: 200 },
    { key: 'guard', name: '区域警戒', en: 'PATROL', durationSec: 260 },
    { key: 'survey', name: '协同测绘', en: 'SURVEY', durationSec: 240 },
    { key: 'recon', name: '抵近侦察', en: 'RECON', durationSec: 200 },
    { key: 'recover', name: '返航评估', en: 'RECOVER', durationSec: 220 },
  ],
  waypoints: [
    { id: 'WP-01', name: '航渡起点', en: 'DEPARTURE', x: -160, z: 120 },
    { id: 'WP-02', name: '展开海域', en: 'DEPLOY AREA', x: 387, z: 26 },
    { id: 'WP-03', name: '警戒海域', en: 'PATROL AREA', x: 918, z: -287 },
    { id: 'WP-04', name: '测绘海域', en: 'SURVEY AREA', x: 1370, z: -945 },
    { id: 'WP-05', name: '侦察海域', en: 'RECON AREA', x: 1462, z: -1676 },
    { id: 'WP-06', name: '返航汇合点', en: 'RECOVERY', x: 1286, z: -2265 },
  ],
};

// Mission area boundary (world XZ) — drawn on the tactical chart, used by the
// geofence alarm rule.
export const GEOFENCE = [
  { x: -620, z: 520 },
  { x: 560, z: 700 },
  { x: 1980, z: 180 },
  { x: 2260, z: -1500 },
  { x: 1620, z: -2860 },
  { x: 420, z: -1320 },
];

// --- home base / landmarks ---------------------------------------------------
export const HOME_BASE = {
  x: LAYOUT.base.x,
  z: LAYOUT.base.z,
  name: '海洋无人系统试验基地',
  en: 'USV TEST BASE',
};

export const LANDMARKS = {
  base: { x: LAYOUT.base.x, z: LAYOUT.base.z, label: '试验基地', en: 'BASE' },
  mothership: { x: LAYOUT.mothership.x, z: LAYOUT.mothership.z, label: '保障母船', en: 'MOTHERSHIP' },
  baseIsland: {
    x: LAYOUT.baseIsland.x,
    z: LAYOUT.baseIsland.z,
    radius: LAYOUT.baseIsland.radius,
    label: '基地岛',
    en: 'BASE ISLAND',
  },
  reef: { x: LAYOUT.reef.x, z: LAYOUT.reef.z, rx: 830, rz: 650, label: '珊瑚礁潟湖', en: 'REEF LAGOON' },
  lighthouse: { x: LAYOUT.lighthouse.x, z: LAYOUT.lighthouse.z, label: '灯塔', en: 'LIGHTHOUSE' },
  platform: { x: LAYOUT.platform.x, z: LAYOUT.platform.z, label: '观测平台', en: 'PLATFORM' },
  windFarm: { ...LAYOUT.windFarm, label: '风电场', en: 'WIND FARM' },
  markerZone: { ...LAYOUT.markerZone, label: '航标阵列', en: 'MARKER FIELD' },
  farBuoys: LAYOUT.farBuoys.map((b, i) => ({ ...b, label: `航标 ${i + 1}`, en: `BUOY ${i + 1}` })),
  islands: LAYOUT.islands.map((i) => ({ ...i, label: '海岛', en: 'ISLAND' })),
};

// --- payloads ----------------------------------------------------------------
export const SENSOR_CATALOG = {
  radar: { id: 'radar', label: '导航雷达', en: 'RADAR', short: 'RADAR' },
  eoir: { id: 'eoir', label: '光电吊舱', en: 'EO/IR', short: 'EO-IR' },
  sonar: { id: 'sonar', label: '前视声呐', en: 'SONAR', short: 'SONAR' },
  ais: { id: 'ais', label: 'AIS 接收', en: 'AIS', short: 'AIS' },
  mesh: { id: 'mesh', label: 'MESH 中继', en: 'MESH', short: 'MESH' },
};

export const sensorsOf = (id) => {
  const v = FLEET_BY_ID.get(id);
  const tm = v ? TYPE_META[v.type] : TYPE_META.scout;
  return tm.sensors.map((s) => SENSOR_CATALOG[s]);
};

// --- modes / severities / labels --------------------------------------------
export const FLEET_MODES = {
  cruise: { text: '编队巡航', en: 'CRUISE', tone: 'ok' },
  hold: { text: '编队保持', en: 'HOLD', tone: 'warn' },
  uturn: { text: '转向中', en: 'TURNING', tone: 'accent' },
  rtl: { text: '返航中', en: 'RTL', tone: 'warn' },
  estop: { text: '紧急停止', en: 'E-STOP', tone: 'danger' },
};

export const VESSEL_MODES = {
  formation: { text: '编队', en: 'FORMATION', tone: 'ok' },
  auto: { text: '自主', en: 'AUTO', tone: 'accent' },
  hold: { text: '待机', en: 'STANDBY', tone: 'warn' },
  rtl: { text: '返航', en: 'RTL', tone: 'warn' },
  manual: { text: '手动', en: 'MANUAL', tone: 'accent' },
  offline: { text: '离线', en: 'OFFLINE', tone: 'offline' },
};

export const SEVERITY = {
  info: { text: '信息', en: 'INFO', colorVar: '--gcs-accent-2' },
  success: { text: '成功', en: 'OK', colorVar: '--gcs-ok' },
  warning: { text: '告警', en: 'WARN', colorVar: '--gcs-warn' },
  critical: { text: '严重', en: 'CRIT', colorVar: '--gcs-danger' },
  command: { text: '指令', en: 'CMD', colorVar: '--gcs-command' },
};

export const EVENT_CATEGORIES = {
  all: '全部',
  command: '指令',
  alarm: '告警',
  mission: '任务',
  link: '链路',
  system: '系统',
};

export const CAMERA_PRESETS = [
  { key: 'default', name: '默认', en: 'DEFAULT' },
  { key: 'fleet', name: '编队', en: 'FLEET' },
  { key: 'top', name: '俯视', en: 'TOP' },
  { key: 'low', name: '低空', en: 'LOW' },
  { key: 'bow', name: '船首', en: 'BOW' },
  { key: 'side', name: '舷侧', en: 'SIDE' },
  { key: 'base', name: '基地', en: 'BASE' },
  { key: 'reef', name: '礁区', en: 'REEF' },
];

export const CAMERA_MODES = {
  fleet: { text: '跟随编队', en: 'FLEET FOLLOW' },
  lock: { text: '锁定目标', en: 'TARGET LOCK' },
  free: { text: '自由视角', en: 'FREE LOOK' },
};

// --- keyboard shortcut table (help overlay renders this verbatim) -------------
export const KEYBOARD = [
  { keys: ['1', '5'], label: '切换编队队形（楔形 / 纵队 / 横队 / 菱形 / 环形）' },
  { keys: ['Shift', '1/2/3'], label: '航速：微速 / 巡航 / 全速' },
  { keys: ['Space'], label: '编队保持 / 恢复' },
  { keys: ['U'], label: '编队调头 180°' },
  { keys: ['F'], label: '镜头锁定选中艇' },
  { keys: ['R'], label: '镜头回到跟随编队' },
  { keys: ['M'], label: '三维态势 / 二维战术图 切换' },
  { keys: ['H'], label: '纯净视景（隐藏界面）' },
  { keys: ['Enter'], label: '聚焦指令台' },
  { keys: ['Esc'], label: '关闭覆盖层 / 取消地图工具 / 退出纯净' },
  { keys: ['?'], label: '打开本帮助' },
  { keys: ['↑', '↓'], label: '指令历史' },
];

export const APP = {
  name: 'OceanSwarm GCS',
  nameCn: '无人艇集群指挥控制系统',
  version: '2.0.0',
  build: '2026.10',
  operator: { rank: '指挥员', en: 'OPERATOR', name: 'ZHAO', short: '指', role: 'ADMIN' },
  timezone: 'UTC+8',
};

// Convenience aggregate for modules that prefer a single import.
export const META = {
  GEO,
  projectWorld,
  TYPE_META,
  FLEET,
  FLEET_BY_ID,
  GROUPS,
  FORMATIONS,
  FORMATION_BY_KEY,
  SPEED_PRESETS,
  MISSION,
  GEOFENCE,
  HOME_BASE,
  LANDMARKS,
  SENSOR_CATALOG,
  sensorsOf,
  FLEET_MODES,
  VESSEL_MODES,
  SEVERITY,
  EVENT_CATEGORIES,
  CAMERA_PRESETS,
  CAMERA_MODES,
  KEYBOARD,
  APP,
};
