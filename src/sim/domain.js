// =============================================================================
// OceanSwarm GCS — simulation-side view of the domain constants.
//
// `src/gcs/meta.js` is owned by the Lead and is the single source of truth;
// createSim() receives that aggregate (`meta.META`) and this module normalises
// it into the compact shape the simulation code wants (roster by id, sensor
// catalogue, mission phases, formation labels ...).
//
// The fallback tables below mirror meta.js and exist only so the Sim engine can
// run standalone (self-test, QA spikes) when no meta object is injected. They
// must never override a provided meta value.
// =============================================================================

import { safeNumber } from './format.js';

// --- fallback domain tables ---------------------------------------------------
const FALLBACK_GEO = { lat0: 18.2215, lon0: 112.6412, mPerDegLat: 111320 };

const FALLBACK_FLEET = [
  { id: 'flagship', type: 'flagship', callSign: 'USV-01', name: '海巡指挥舰', group: 'flagship', offset: [0, 0] },
  { id: 'scout-1', type: 'scout', callSign: 'USV-02', name: '侦察-1', group: 'scout', offset: [0, 186] },
  { id: 'scout-2', type: 'scout', callSign: 'USV-03', name: '侦察-2', group: 'scout', offset: [-82, 130] },
  { id: 'scout-3', type: 'scout', callSign: 'USV-04', name: '侦察-3', group: 'scout', offset: [90, 124] },
  { id: 'scout-4', type: 'scout', callSign: 'USV-05', name: '侦察-4', group: 'scout', offset: [-218, 62] },
  { id: 'scout-5', type: 'scout', callSign: 'USV-06', name: '侦察-5', group: 'scout', offset: [224, 46] },
  { id: 'env-1', type: 'env', callSign: 'USV-07', name: '环境-1', group: 'survey', offset: [-120, -22] },
  { id: 'env-2', type: 'env', callSign: 'USV-08', name: '环境-2', group: 'survey', offset: [128, -12] },
  { id: 'env-3', type: 'env', callSign: 'USV-09', name: '环境-3', group: 'survey', offset: [-198, -76] },
  { id: 'survey-1', type: 'survey', callSign: 'USV-10', name: '测绘-1', group: 'survey', offset: [206, -68] },
  { id: 'survey-2', type: 'survey', callSign: 'USV-11', name: '测绘-2', group: 'survey', offset: [-268, -44] },
  { id: 'patrol-1', type: 'patrol', callSign: 'USV-12', name: '巡逻-1', group: 'patrol', offset: [-98, -104] },
  { id: 'patrol-2', type: 'patrol', callSign: 'USV-13', name: '巡逻-2', group: 'patrol', offset: [104, -96] },
  { id: 'comms-1', type: 'comms', callSign: 'USV-14', name: '通信-1', group: 'support', offset: [50, -126] },
  { id: 'energy-1', type: 'energy', callSign: 'USV-15', name: '能源-1', group: 'support', offset: [-64, -134] },
  { id: 'energy-2', type: 'energy', callSign: 'USV-16', name: '能源-2', group: 'support', offset: [-162, -118] },
  { id: 'rescue-1', type: 'rescue', callSign: 'USV-17', name: '救援-1', group: 'support', offset: [158, -118] },
];

const FALLBACK_TYPE_META = {
  flagship: { typeName: '三体无人指挥舰', roleEn: 'TRIMARAN COMMAND', short: 'FLAG', lengthM: 30, sensors: ['radar', 'eoir', 'sonar', 'ais', 'mesh'], powerKw: 42 },
  scout: { typeName: '高速侦察艇', roleEn: 'FAST SCOUT', short: 'SCOUT', lengthM: 10.5, sensors: ['radar', 'eoir', 'ais'], powerKw: 6.4 },
  env: { typeName: '环境监测艇', roleEn: 'ENV MONITOR', short: 'ENV', lengthM: 16.5, sensors: ['radar', 'eoir', 'sonar', 'ais'], powerKw: 9.2 },
  survey: { typeName: '海洋测绘双体艇', roleEn: 'HYDRO SURVEY', short: 'SURVEY', lengthM: 18, sensors: ['radar', 'sonar', 'ais'], powerKw: 8.6 },
  patrol: { typeName: '多用途巡逻艇', roleEn: 'PATROL', short: 'PATROL', lengthM: 14.5, sensors: ['radar', 'eoir', 'ais'], powerKw: 8 },
  comms: { typeName: '通信中继艇', roleEn: 'COMMS RELAY', short: 'COMMS', lengthM: 19, sensors: ['mesh', 'ais', 'radar'], powerKw: 10.5 },
  energy: { typeName: '能源保障艇', roleEn: 'ENERGY SUPPORT', short: 'ENERGY', lengthM: 20, sensors: ['radar', 'ais'], powerKw: 34 },
  rescue: { typeName: '无人救援艇', roleEn: 'SAR RESCUE', short: 'RESCUE', lengthM: 15.5, sensors: ['eoir', 'radar', 'ais', 'mesh'], powerKw: 7.2 },
};

const FALLBACK_SENSORS = {
  radar: { id: 'radar', label: '导航雷达', en: 'RADAR', short: 'RADAR' },
  eoir: { id: 'eoir', label: '光电吊舱', en: 'EO/IR', short: 'EO-IR' },
  sonar: { id: 'sonar', label: '前视声呐', en: 'SONAR', short: 'SONAR' },
  ais: { id: 'ais', label: 'AIS 接收', en: 'AIS', short: 'AIS' },
  mesh: { id: 'mesh', label: 'MESH 中继', en: 'MESH', short: 'MESH' },
};

const FALLBACK_GROUPS = [
  { key: 'flagship', name: '指挥舰', en: 'FLAGSHIP' },
  { key: 'scout', name: '侦察分队', en: 'SCOUT FLOTILLA' },
  { key: 'survey', name: '环境与测绘分队', en: 'SURVEY WING' },
  { key: 'patrol', name: '巡逻警戒分队', en: 'PATROL UNIT' },
  { key: 'support', name: '综合保障分队', en: 'SUPPORT GROUP' },
];

const FALLBACK_FORMATIONS = [
  { key: 'wedge', name: '楔形', en: 'WEDGE' },
  { key: 'column', name: '纵队', en: 'COLUMN' },
  { key: 'line', name: '横队', en: 'LINE' },
  { key: 'diamond', name: '菱形', en: 'DIAMOND' },
  { key: 'ring', name: '环形', en: 'RING' },
];

const FALLBACK_MISSION = {
  id: 'M-07',
  name: '协同警戒巡航',
  en: 'COOPERATIVE PATROL',
  area: '南海 · 试验海域 A',
  areaEn: 'SOUTH CHINA SEA · TEST AREA A',
  metOffset: 720,
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

const FALLBACK_HOME_BASE = { x: 1350, z: -2015, name: '海洋无人系统试验基地', en: 'USV TEST BASE' };

const FALLBACK_FLEET_MODES = {
  cruise: { text: '编队巡航', en: 'CRUISE' },
  hold: { text: '编队保持', en: 'HOLD' },
  uturn: { text: '转向中', en: 'TURNING' },
  rtl: { text: '返航中', en: 'RTL' },
  estop: { text: '紧急停止', en: 'E-STOP' },
};

const FALLBACK_VESSEL_MODES = {
  formation: { text: '编队', en: 'FORMATION' },
  auto: { text: '自主', en: 'AUTO' },
  hold: { text: '待机', en: 'STANDBY' },
  rtl: { text: '返航', en: 'RTL' },
  manual: { text: '手动', en: 'MANUAL' },
  offline: { text: '离线', en: 'OFFLINE' },
};

const FALLBACK_SEVERITY = {
  info: { text: '信息', en: 'INFO' },
  success: { text: '成功', en: 'OK' },
  warning: { text: '告警', en: 'WARN' },
  critical: { text: '严重', en: 'CRIT' },
  command: { text: '指令', en: 'CMD' },
};

const FALLBACK_EVENT_CATEGORIES = {
  command: '指令',
  alarm: '告警',
  mission: '任务',
  link: '链路',
  system: '系统',
};

const FLEET_MODE_KEYS = ['cruise', 'hold', 'uturn', 'rtl', 'estop'];
const VESSEL_MODE_KEYS = ['formation', 'auto', 'hold', 'rtl', 'manual', 'offline'];
const SEVERITY_KEYS = ['info', 'success', 'warning', 'critical', 'command'];
const CATEGORY_KEYS = ['command', 'alarm', 'mission', 'link', 'system'];

function isObject(value) {
  return !!value && typeof value === 'object';
}

function mergeTable(fallback, provided, keys) {
  const out = {};
  for (const key of keys) {
    const f = fallback[key] || {};
    const p = isObject(provided) && isObject(provided[key]) ? provided[key] : {};
    out[key] = { ...f, ...p };
  }
  return out;
}

function normalizeTypeMeta(provided) {
  const out = {};
  const types = new Set([...Object.keys(FALLBACK_TYPE_META), ...(isObject(provided) ? Object.keys(provided) : [])]);
  for (const type of types) {
    const f = FALLBACK_TYPE_META[type] || {};
    const p = isObject(provided) && isObject(provided[type]) ? provided[type] : {};
    const merged = { ...f, ...p };
    merged.type = type;
    merged.typeName = String(merged.typeName || merged.name || type);
    merged.roleEn = String(merged.roleEn || type).toUpperCase();
    merged.short = String(merged.short || type).toUpperCase();
    merged.lengthM = safeNumber(merged.lengthM, 14);
    merged.powerKw = safeNumber(merged.powerKw, 8);
    const sensors = Array.isArray(merged.sensors) ? merged.sensors : f.sensors || [];
    merged.sensors = sensors
      .map((s) => (typeof s === 'string' ? s : s && s.id))
      .filter((s) => typeof s === 'string');
    out[type] = merged;
  }
  return out;
}

function normalizeSensors(provided) {
  const out = {};
  const ids = new Set([...Object.keys(FALLBACK_SENSORS), ...(isObject(provided) ? Object.keys(provided) : [])]);
  for (const id of ids) {
    const f = FALLBACK_SENSORS[id] || { id, label: id, en: id, short: id.toUpperCase() };
    const p = isObject(provided) && isObject(provided[id]) ? provided[id] : {};
    const merged = { ...f, ...p, id };
    merged.label = String(merged.label || id);
    merged.en = String(merged.en || merged.short || id).toUpperCase();
    merged.short = String(merged.short || merged.en || id).toUpperCase();
    out[id] = merged;
  }
  return out;
}

function normalizeFleet(provided) {
  const list = Array.isArray(provided) && provided.length ? provided : FALLBACK_FLEET;
  return list.map((entry, index) => {
    const type = String(entry.type || 'scout');
    const rawOffset = Array.isArray(entry.offset) ? entry.offset : [0, 0];
    const offset = [safeNumber(rawOffset[0], 0), safeNumber(rawOffset[1], 0)];
    return {
      id: String(entry.id || `${type}-${index}`),
      type,
      variant: safeNumber(entry.variant, 0),
      callSign: String(entry.callSign || `USV-${String(index + 1).padStart(2, '0')}`),
      name: String(entry.name || entry.id || type),
      group: String(entry.group || 'support'),
      offset,
    };
  });
}

function normalizeGroups(provided) {
  if (Array.isArray(provided) && provided.length) {
    return provided.map((g, index) => ({
      key: String(g.key || `group-${index}`),
      name: String(g.name || g.key || ''),
      en: String(g.en || '').toUpperCase(),
      ids: Array.isArray(g.ids) ? g.ids.slice() : null,
    }));
  }
  if (isObject(provided)) {
    return Object.keys(provided).map((key) => ({
      key,
      name: String(provided[key].name || provided[key].text || key),
      en: String(provided[key].en || '').toUpperCase(),
      ids: null,
    }));
  }
  return FALLBACK_GROUPS.map((g) => ({ ...g, ids: null }));
}

function normalizeFormations(provided) {
  const list = Array.isArray(provided) && provided.length ? provided : FALLBACK_FORMATIONS;
  return list.map((f, index) => ({
    key: String(f.key || f.id || `formation-${index}`),
    name: String(f.name || f.text || f.key || ''),
    en: String(f.en || '').toUpperCase(),
    glyph: f.glyph,
  }));
}

function normalizePhases(provided) {
  const list = Array.isArray(provided) && provided.length ? provided : FALLBACK_MISSION.phases;
  const phases = list
    .map((p) => ({
      key: String(p.key || p.id || ''),
      name: String(p.name || p.text || ''),
      en: String(p.en || '').toUpperCase(),
      durationSec: Math.max(1, safeNumber(p.durationSec ?? p.duration, 120)),
    }))
    .filter((p) => p.name);
  return phases.length ? phases : FALLBACK_MISSION.phases.map((p) => ({ ...p }));
}

function normalizeWaypoints(provided) {
  const list = Array.isArray(provided) && provided.length ? provided : FALLBACK_MISSION.waypoints;
  return list.map((w, index) => {
    const fallback = FALLBACK_MISSION.waypoints[index % FALLBACK_MISSION.waypoints.length];
    return {
      id: String(w.id || fallback.id),
      name: String(w.name || fallback.name),
      en: String(w.en || fallback.en || '').toUpperCase(),
      x: safeNumber(w.x, fallback.x),
      z: safeNumber(w.z, fallback.z),
    };
  });
}

function normalizeMission(provided) {
  const raw = isObject(provided) ? provided : {};
  const phases = normalizePhases(raw.phases);
  const waypoints = normalizeWaypoints(raw.waypoints);
  const cycleDurationSec = phases.reduce((sum, p) => sum + p.durationSec, 0);
  return {
    id: String(raw.id || raw.code || FALLBACK_MISSION.id),
    code: String(raw.code || raw.id || FALLBACK_MISSION.id),
    name: String(raw.name || FALLBACK_MISSION.name),
    en: String(raw.en || FALLBACK_MISSION.en).toUpperCase(),
    area: String(raw.area || FALLBACK_MISSION.area),
    areaEn: String(raw.areaEn || FALLBACK_MISSION.areaEn).toUpperCase(),
    operator: String(raw.operator || ''),
    vesselCount: safeNumber(raw.vesselCount, 17),
    metOffset: safeNumber(raw.metOffsetSec ?? raw.metOffset, FALLBACK_MISSION.metOffset),
    phases,
    waypoints,
    cycleDurationSec,
  };
}

function normalizeModeTable(provided, fallback, keys) {
  const out = {};
  for (const key of keys) {
    const f = fallback[key] || { text: key, en: key.toUpperCase() };
    const raw = isObject(provided) ? provided[key] : undefined;
    const p = isObject(raw) ? raw : {};
    const text = typeof p.text === 'string' ? p.text : typeof raw === 'string' ? raw : f.text;
    out[key] = {
      text,
      en: String(p.en || f.en || key).toUpperCase(),
      tone: p.tone || f.tone || 'ok',
    };
  }
  return out;
}

function normalizeSeverity(provided) {
  return mergeTable(FALLBACK_SEVERITY, provided, SEVERITY_KEYS);
}

function normalizeCategories(provided) {
  const out = { ...FALLBACK_EVENT_CATEGORIES };
  if (isObject(provided)) {
    for (const key of CATEGORY_KEYS) {
      if (typeof provided[key] === 'string') out[key] = provided[key];
    }
  }
  return out;
}

/**
 * Normalise the injected `meta.META` aggregate (or any partial object) into the
 * simulation domain. Every field is guaranteed present and sane.
 *
 * @param {object|null|undefined} meta  meta.META aggregate from src/gcs/meta.js
 * @param {object} [scene]              sceneProvider (origin/base fallbacks)
 * @param {object} [options]
 */
export function createDomain(meta, scene, options = {}) {
  const M = isObject(meta)
    ? isObject(meta.META) && !isObject(meta.FLEET)
      ? meta.META
      : meta
    : {};
  const opts = isObject(options) ? options : {};

  const geo = { ...FALLBACK_GEO, ...(isObject(M.GEO) ? M.GEO : {}) };
  const projectWorld =
    typeof M.projectWorld === 'function'
      ? M.projectWorld
      : (x, z) => ({
          lat: safeNumber(geo.lat0, FALLBACK_GEO.lat0) - safeNumber(z, 0) / safeNumber(geo.mPerDegLat, 111320),
          lon:
            safeNumber(geo.lon0, FALLBACK_GEO.lon0) +
            safeNumber(x, 0) / (safeNumber(geo.mPerDegLat, 111320) * Math.cos((safeNumber(geo.lat0, 18.2215) * Math.PI) / 180)),
        });

  const typeMeta = normalizeTypeMeta(M.TYPE_META);
  const sensorCatalog = normalizeSensors(M.SENSOR_CATALOG);
  const rosterEntries = normalizeFleet(M.FLEET);
  const groups = normalizeGroups(M.GROUPS);
  const groupByKey = new Map(groups.map((g) => [g.key, g]));
  const formations = normalizeFormations(M.FORMATIONS);
  const formationByKey = new Map(formations.map((f) => [f.key, f]));
  const mission = normalizeMission(M.MISSION);
  const fleetModes = normalizeModeTable(M.FLEET_MODES, FALLBACK_FLEET_MODES, FLEET_MODE_KEYS);
  const vesselModes = normalizeModeTable(M.VESSEL_MODES, FALLBACK_VESSEL_MODES, VESSEL_MODE_KEYS);
  const severity = normalizeSeverity(M.SEVERITY);
  const categories = normalizeCategories(M.EVENT_CATEGORIES);

  const typeKeyOfGroup = new Map();
  const roster = rosterEntries.map((entry) => {
    const tm = typeMeta[entry.type] || typeMeta.scout;
    const group = groupByKey.get(entry.group);
    const sensors = (tm.sensors || [])
      .map((id) => sensorCatalog[id])
      .filter(Boolean)
      .map((s) => ({ ...s, on: defaultSensorOn(s.id, entry.type) }));
    typeKeyOfGroup.set(entry.type, entry.group);
    return {
      ...entry,
      typeName: tm.typeName,
      roleEn: tm.roleEn,
      short: tm.short,
      lengthM: tm.lengthM,
      powerKw: tm.powerKw,
      groupName: group ? group.name : '',
      groupEn: group ? group.en : '',
      offset: Array.isArray(entry.offset) ? entry.offset.slice() : [0, 0],
      sensors,
    };
  });

  const byId = new Map(roster.map((v) => [v.id, v]));
  const relay = roster.find((v) => v.type === 'comms') || roster.find((v) => v.type === 'flagship') || roster[0];
  const sceneBase = isObject(scene) && isObject(scene.base) ? scene.base : null;
  const homeBase = {
    ...FALLBACK_HOME_BASE,
    ...(isObject(M.HOME_BASE) ? M.HOME_BASE : {}),
  };
  if (sceneBase && Number.isFinite(sceneBase.x) && Number.isFinite(sceneBase.z)) {
    homeBase.x = sceneBase.x;
    homeBase.z = sceneBase.z;
  }
  if (!Number.isFinite(homeBase.x)) homeBase.x = FALLBACK_HOME_BASE.x;
  if (!Number.isFinite(homeBase.z)) homeBase.z = FALLBACK_HOME_BASE.z;
  const projectedBase = projectWorld(homeBase.x, homeBase.z);

  const sceneOrigin = isObject(scene) && isObject(scene.origin) ? scene.origin : null;
  if (sceneOrigin) {
    if (Number.isFinite(sceneOrigin.lat0)) geo.lat0 = sceneOrigin.lat0;
    if (Number.isFinite(sceneOrigin.lon0)) geo.lon0 = sceneOrigin.lon0;
  }

  const app = isObject(M.APP) ? M.APP : {};
  const timezone = typeof app.timezone === 'string' && app.timezone ? app.timezone : 'UTC+8';

  return {
    meta: M,
    geo,
    projectWorld,
    typeMeta,
    sensorCatalog,
    roster,
    byId,
    relayId: relay ? relay.id : null,
    relayCallSign: relay ? relay.callSign : '',
    groups,
    groupByKey,
    formations,
    formationByKey,
    mission,
    fleetModes,
    vesselModes,
    severity,
    categories,
    homeBase: {
      x: safeNumber(homeBase.x, FALLBACK_HOME_BASE.x),
      z: safeNumber(homeBase.z, FALLBACK_HOME_BASE.z),
      lat: safeNumber(homeBase.lat, projectedBase.lat),
      lon: safeNumber(homeBase.lon, projectedBase.lon),
      name: String(homeBase.name || FALLBACK_HOME_BASE.name),
      en: String(homeBase.en || FALLBACK_HOME_BASE.en),
    },
    timezone,
    seedInput: opts.seed,
  };
}

/** Sensors that default to "on" when a mission starts. */
function defaultSensorOn(sensorId, vesselType) {
  if (sensorId === 'radar' || sensorId === 'ais') return true;
  if (sensorId === 'eoir') return vesselType === 'scout' || vesselType === 'patrol' || vesselType === 'rescue' || vesselType === 'flagship';
  if (sensorId === 'sonar') return vesselType === 'env' || vesselType === 'survey' || vesselType === 'flagship';
  if (sensorId === 'mesh') return vesselType === 'comms' || vesselType === 'flagship' || vesselType === 'rescue';
  return false;
}

/** Text of a fleet mode as frozen by the design system (§8). */
export function fleetModeText(domain, mode) {
  const entry = domain.fleetModes[mode];
  return entry ? entry.text : '编队巡航';
}

export function fleetModeEn(domain, mode) {
  const entry = domain.fleetModes[mode];
  return entry ? entry.en : 'CRUISE';
}

export function vesselModeText(domain, mode) {
  const entry = domain.vesselModes[mode];
  return entry ? entry.text : '编队';
}

export function vesselModeEn(domain, mode) {
  const entry = domain.vesselModes[mode];
  return entry ? entry.en : 'FORMATION';
}

export function formationLabel(domain, key) {
  const f = domain.formationByKey.get(key);
  return f || { key, name: key, en: String(key).toUpperCase() };
}
