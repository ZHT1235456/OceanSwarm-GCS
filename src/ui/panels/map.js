// =============================================================================
// OceanSwarm GCS — two-dimensional tactical chart (central viewport layer).
// Owner: ui-map. Contract: docs/GCS-architecture.md §4.1/§4.2/§7,
// visual spec: docs/GCS-design-system.md §7.6.
//
// Chart content
//   · deep-sea chart bed with adaptive lat/lon graticule (edge ticks + labels)
//   · 500 m range rings around the flagship, chart compass rose, chart frame
//   · terrain from meta.LANDMARKS: base island, islands, reef lagoon, base,
//     mothership, lighthouse, observation platform, wind farm, buoy field
//   · mission area boundary (meta.GEOFENCE, amber dashed)
//   · mission route (meta.MISSION.waypoints) with passed / current / future states
//   · live vessels from ctx.getLiveVessels() (smooth): type-coloured rotating
//     markers, 60 s fading tracks, flagship diamond, selection halo + label,
//     alarm pips, heading vectors, per-vessel waypoint lines
//   · active waypoint marker (ctx.state.activeWaypoint), measure tool,
//     goto placement pulse feedback
//   · DOM chrome: chart title, zoom + scale instrument, layer chips, tool bar,
//     cursor lat/lon readout, pan/zoom/follow interactions
//
// Geometry: world X = east, Z = south (north = -Z), north-up chart.
//   screenX = w/2 + (worldX - view.cx) * pxPerMetre
//   screenY = h/2 + (worldZ - view.cz) * pxPerMetre
// pxPerMetre = CHART.basePxPerM * view.zoom (zoom 0.3 … 8).
// =============================================================================
import './../styles/map.css';
import { MISSION, GEOFENCE, LANDMARKS, TYPE_META, FLEET_BY_ID, GEO, projectWorld } from '../../gcs/meta.js';
import { h, setText, setClass } from '../dom.js';

// --- exported chart geometry (QA harness / capture.mjs assertions) ----------
export const CHART = Object.freeze({
  basePxPerM: 0.16, // 1× zoom => 0.16 px per metre
  minZoom: 0.3,
  maxZoom: 8,
  defaultZoom: 0.62,
  drawHz: 30,
  trailSec: 60, // track history length
});

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const TAU = Math.PI * 2;
const rad = (deg) => (deg * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

/** pixels per metre for a zoom factor. */
export const chartScale = (zoom) => CHART.basePxPerM * clamp(zoom, CHART.minZoom, CHART.maxZoom);

/** world → chart pixel coordinates (chart local, CSS px). */
export function worldToScreen(view, width, height, x, z) {
  const k = chartScale(view.zoom);
  return { x: width / 2 + (x - view.cx) * k, y: height / 2 + (z - view.cz) * k };
}

/** chart pixel coordinates → world (x east, z south-meters). */
export function screenToWorld(view, width, height, sx, sy) {
  const k = chartScale(view.zoom);
  return { x: view.cx + (sx - width / 2) / k, z: view.cz + (sy - height / 2) / k };
}

// --- colour helpers ----------------------------------------------------------
function withAlpha(color, alpha) {
  if (typeof color !== 'string' || !color) return `rgba(95,243,228,${alpha})`;
  if (color[0] === '#') {
    let hex = color.slice(1);
    if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
    const n = parseInt(hex.slice(0, 6), 16);
    if (!Number.isFinite(n)) return color;
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
  }
  const m = color.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const p = m[1].split(',').map((s) => parseFloat(s));
    if (p.length >= 3) return `rgba(${Math.round(p[0])},${Math.round(p[1])},${Math.round(p[2])},${alpha})`;
  }
  return color;
}

const FALLBACK_TOKENS = {
  accent: '#5ff3e4',
  accent2: '#9fd6e8',
  line: 'rgba(140,224,238,.14)',
  lineStrong: 'rgba(140,224,238,.30)',
  text: '#eaf7f7',
  text2: 'rgba(212,236,241,.68)',
  text3: 'rgba(188,220,229,.44)',
  warn: '#ffb257',
  danger: '#ff5d4a',
  ok: '#5ce8a5',
  gold: '#ffd27a',
  fontMono: '"Cascadia Mono","Consolas","SFMono-Regular",monospace',
  fontEn: '"Bahnschrift","Segoe UI",sans-serif',
  fontCn: '"Microsoft YaHei UI","Microsoft YaHei",sans-serif',
};

function readTokens() {
  const out = { ...FALLBACK_TOKENS };
  try {
    const cs = getComputedStyle(document.documentElement);
    const read = (name) => cs.getPropertyValue(name).trim();
    const map = {
      accent: '--gcs-accent',
      accent2: '--gcs-accent-2',
      line: '--gcs-line',
      lineStrong: '--gcs-line-strong',
      text: '--gcs-text',
      text2: '--gcs-text-2',
      text3: '--gcs-text-3',
      warn: '--gcs-warn',
      danger: '--gcs-danger',
      ok: '--gcs-ok',
      gold: '--gcs-gold',
    };
    for (const [key, cssVar] of Object.entries(map)) {
      const v = read(cssVar);
      if (v) out[key] = v;
    }
    const font = (name, fallback) => {
      let v = read(name);
      if (!v) return fallback;
      const cut = v.indexOf('var(');
      if (cut >= 0) v = v.slice(0, cut);
      v = v.replace(/,\s*$/, '').trim();
      return v || fallback;
    };
    out.fontMono = font('--gcs-font-mono', FALLBACK_TOKENS.fontMono);
    out.fontEn = font('--gcs-font-en', FALLBACK_TOKENS.fontEn);
    out.fontCn = font('--gcs-font-cn', FALLBACK_TOKENS.fontCn);
  } catch {
    /* no CSS available — literal fallbacks are fine */
  }
  return out;
}

// --- chart palette -----------------------------------------------------------
const C = {
  seaTop: '#04131d',
  seaBottom: '#071f2a',
  seaGlow: 'rgba(20,66,84,0.30)',
  gridMinor: 'rgba(140,224,238,0.05)',
  gridMajor: 'rgba(140,224,238,0.11)',
  gridTick: 'rgba(140,224,238,0.20)',
  frame: 'rgba(140,224,238,0.10)',
  landFill: 'rgba(90,140,105,0.28)',
  landFillInner: 'rgba(74,120,92,0.32)',
  landLine: 'rgba(126,196,146,0.48)',
  landContour: 'rgba(126,196,146,0.16)',
  reefFill: 'rgba(80,215,205,0.08)',
  reefFillInner: 'rgba(95,243,228,0.10)',
  reefLine: 'rgba(95,243,228,0.30)',
  reefContour: 'rgba(95,243,228,0.12)',
  geofence: 'rgba(255,178,87,0.55)',
  geofenceFill: 'rgba(255,178,87,0.035)',
  sonarFill: 'rgba(95,243,228,0.045)',
  sonarLine: 'rgba(95,243,228,0.22)',
  routePast: 'rgba(95,243,228,0.58)',
  routeFuture: 'rgba(95,243,228,0.30)',
  markerDark: 'rgba(2,11,18,0.85)',
};

// --- terrain geometry (pre-computed, deterministic) --------------------------
function islandPolygon(cx, cz, radius, seed, n = 22) {
  const pts = [];
  for (let i = 0; i < n; i += 1) {
    const a = (i / n) * TAU;
    const wob =
      Math.sin(a * 3 + seed) * 0.09 + Math.sin(a * 5 + seed * 2.3) * 0.06 + Math.sin(a * 7 + seed * 0.7) * 0.035;
    const r = radius * (1 + wob);
    pts.push({ x: cx + Math.cos(a) * r, z: cz + Math.sin(a) * r });
  }
  return pts;
}

const ISLANDS = [
  { ...LANDMARKS.baseIsland, seed: 2.4, kind: 'base' },
  ...LANDMARKS.islands.map((isl, i) => ({ ...isl, seed: 5.1 + i * 3.7, kind: 'island' })),
];
for (const isl of ISLANDS) {
  isl.polygon = islandPolygon(isl.x, isl.z, isl.radius, isl.seed);
}

const REEF = LANDMARKS.reef;
const WIND = LANDMARKS.windFarm;
const WIND_TURBINES = (() => {
  const list = [];
  const count = WIND.count || 5;
  for (let i = 0; i < count; i += 1) {
    const row = i % 2;
    const col = Math.floor(i / 2);
    list.push({ x: WIND.x + (col - 1) * 240, z: WIND.z + (row - 0.5) * 210 });
  }
  return list;
})();

const MARKER_BUOYS = (() => {
  const zone = LANDMARKS.markerZone;
  const list = [];
  const count = zone.count || 18;
  const cols = 6;
  const rows = Math.ceil(count / cols);
  for (let i = 0; i < count; i += 1) {
    const cIdx = i % cols;
    const rIdx = Math.floor(i / cols);
    list.push({
      x: zone.x + ((cIdx + 0.5) / cols - 0.5) * zone.width * 0.78,
      z: zone.z + ((rIdx + 0.5) / rows - 0.5) * zone.depth * 0.72,
    });
  }
  return list;
})();

const LAYER_CHIPS = [
  { key: 'tracks', label: '航迹' },
  { key: 'labels', label: '标注' },
  { key: 'route', label: '航线' },
  { key: 'grid', label: '网格' },
  { key: 'geofence', label: '边界' },
  { key: 'landmarks', label: '设施' },
  { key: 'sonar', label: '声呐' },
];

const TOOLS = [
  { key: 'select', label: '选择', icon: 'crosshair', title: '选择工具：点击艇标选中（Esc 取消）' },
  { key: 'goto', label: '航点', icon: 'wavepoint', title: '航点工具：点击海图派遣选中艇' },
  { key: 'measure', label: '测距', icon: 'ruler', title: '测距工具：点击两点测量距离/方位' },
];

// =============================================================================
// Panel factory
// =============================================================================
export function createMapPanel(ctx) {
  const { actions, bus, state, format } = ctx;
  const icons = ctx.icons || { icon: () => '' };

  let host = null;
  let root = null;
  let canvas = null;
  let c2d = null;
  const els = {};
  const cleanups = [];
  let tokens = FALLBACK_TOKENS;

  // chart camera
  const view = { cx: 0, cz: 0, zoom: CHART.defaultZoom };
  let follow = state.mapFollow !== false;
  let tool = state.mapTool || 'select';
  let layers = { ...(state.mapLayers || {}) };
  let inited = false;

  // data
  let snap = null;
  let live = [];
  let snapById = new Map();
  const trails = new Map(); // id -> [{x,z,t}]
  let lastTrailAt = 0;

  // interaction
  const pointer = { x: 0, y: 0, inside: false, hoverId: null };
  let drag = null;
  let measure = { a: null, b: null };
  let pulse = null; // {x,z,t}
  let lastDraw = -1e9;
  let lastDrawCost = 0;
  let lastCursorDom = 0;

  // canvas sizing
  const size = { w: 0, h: 0, dpr: 1 };

  // ---------------------------------------------------------------------------
  // projection
  // ---------------------------------------------------------------------------
  const ppu = () => chartScale(view.zoom);
  const w2s = (x, z) => worldToScreen(view, size.w, size.h, x, z);
  const s2w = (sx, sy) => screenToWorld(view, size.w, size.h, sx, sy);

  function onScreen(p, margin = 40) {
    return p.x >= -margin && p.x <= size.w + margin && p.y >= -margin && p.y <= size.h + margin;
  }

  // ---------------------------------------------------------------------------
  // DOM construction
  // ---------------------------------------------------------------------------
  function buildTitle() {
    const wrap = h('div', { class: 'map-title' });
    wrap.append(h('span', { class: 'map-title-cn', text: '二维战术图' }));
    wrap.append(h('span', { class: 'map-title-en', text: 'TACTICAL CHART' }));
    wrap.append(h('span', { class: 'map-title-sep' }));
    wrap.append(h('span', { class: 'map-title-area', text: GEO.area }));
    wrap.append(h('span', { class: 'map-title-meta', text: 'N UP · WGS-84' }));
    els.title = wrap;
    return wrap;
  }

  function buildHint() {
    const hint = h('div', { class: 'map-hint map-hint--hidden' });
    els.hint = hint;
    return hint;
  }

  function buildInstrument() {
    const zoomOut = h('button', {
      class: 'map-btn map-btn--icon',
      html: icons.icon('minus', 12),
      attrs: { type: 'button', title: '缩小（滚轮）' },
      on: { click: () => setZoom(view.zoom / 1.45) },
    });
    const zoomIn = h('button', {
      class: 'map-btn map-btn--icon',
      html: icons.icon('plus', 12),
      attrs: { type: 'button', title: '放大（滚轮）' },
      on: { click: () => setZoom(view.zoom * 1.45) },
    });
    const zoomVal = h('button', {
      class: 'map-zoom-val',
      text: '0.70×',
      attrs: { type: 'button', title: '点击回到 1.0×（双击海图居中，滚轮缩放）' },
      on: { click: () => setZoom(1) },
    });
    const row = h('div', { class: 'map-zoomrow' }, zoomOut, zoomVal, zoomIn);

    const scaleFill = h('span', { class: 'map-scalebar-fill' });
    const scaleTrack = h('div', { class: 'map-scalebar-track' }, scaleFill);
    const scaleLabel = h('span', { class: 'map-scalebar-label', text: '—' });
    const scaleRow = h('div', { class: 'map-scalebar' }, scaleTrack, scaleLabel);
    const denom = h('div', { class: 'map-instrument-meta', text: '1:—' });
    const plate = h('div', { class: 'map-plate map-instrument' }, row, scaleRow, denom);
    els.zoomVal = zoomVal;
    els.scaleFill = scaleFill;
    els.scaleLabel = scaleLabel;
    els.denom = denom;
    return plate;
  }

  function buildLayers() {
    const chips = h('div', { class: 'map-layers-grid' });
    for (const layer of LAYER_CHIPS) {
      const chip = h('button', {
        class: 'map-chip',
        text: layer.label,
        attrs: { type: 'button', 'data-layer': layer.key, title: `图层：${layer.label}` },
        on: { click: () => actions.toggleMapLayer(layer.key) },
      });
      chips.appendChild(chip);
    }
    const head = h(
      'div',
      { class: 'map-plate-head' },
      h('span', { text: '图层' }),
      h('span', { class: 'map-plate-en', text: 'LAYERS' }),
    );
    const plate = h('div', { class: 'map-plate map-layers' }, head, chips);
    els.layerChips = chips;
    return plate;
  }

  function buildToolbar() {
    const bar = h('div', { class: 'map-toolbar' });
    const toolBtns = [];
    for (const item of TOOLS) {
      const btn = h('button', {
        class: 'map-btn map-tool',
        attrs: { type: 'button', 'data-tool': item.key, title: item.title },
        html: `${icons.icon(item.icon, 13)}<span>${item.label}</span>`,
        on: { click: () => actions.setMapTool(item.key) },
      });
      toolBtns.push(btn);
      bar.appendChild(btn);
    }
    bar.appendChild(h('span', { class: 'map-toolbar-sep' }));
    const centerBtn = h('button', {
      class: 'map-btn map-tool',
      attrs: { type: 'button', 'data-tool': 'center', title: '居中：把编队质心放回海图中心' },
      html: `${icons.icon('target', 13)}<span>居中</span>`,
      on: {
        click: () => {
          snapToFleet();
          if (!follow) actions.setMapFollow(true);
          drawNow();
        },
      },
    });
    const followBtn = h('button', {
      class: 'map-btn map-tool',
      attrs: { type: 'button', 'data-tool': 'follow', title: '跟随编队：海图中心实时跟随集群质心' },
      html: `${icons.icon('lock', 13)}<span>跟随</span>`,
      on: { click: () => actions.setMapFollow(!follow) },
    });
    bar.appendChild(centerBtn);
    bar.appendChild(followBtn);
    els.toolBtns = toolBtns;
    els.followBtn = followBtn;
    return bar;
  }

  function buildCursor() {
    const line1 = h('div', { class: 'map-cursor-line' });
    const lat = h('span', { class: 'map-cursor-v map-cursor-lat', text: '—' });
    const lon = h('span', { class: 'map-cursor-v map-cursor-lon', text: '—' });
    line1.append(lat, h('span', { class: 'map-cursor-sep', text: ' ' }), lon);
    const line2 = h('div', { class: 'map-cursor-line map-cursor-line--sub' });
    const coords = h('span', { class: 'map-cursor-v map-cursor-en', text: 'E — / N —' });
    line2.append(coords);
    const plate = h('div', { class: 'map-plate map-cursor' }, line1, line2);
    els.cursorLat = lat;
    els.cursorLon = lon;
    els.cursorEn = coords;
    return plate;
  }

  // ---------------------------------------------------------------------------
  // UI sync
  // ---------------------------------------------------------------------------
  function syncToolUi() {
    tool = state.mapTool || 'select';
    if (els.toolBtns) {
      for (const btn of els.toolBtns) setClass(btn, 'is-active', btn.dataset.tool === tool);
    }
    if (els.hint) {
      let text = '';
      if (tool === 'goto') {
        const vm = FLEET_BY_ID.get(state.selectedId || '');
        text = `航点工具 · 点击海图派遣 ${vm ? `${vm.callSign} ${vm.name}` : '选中艇'}（Esc 取消）`;
      } else if (tool === 'measure') {
        text = '测距工具 · 点击两点测量距离与方位（Esc 取消）';
      }
      setText(els.hint, text);
      setClass(els.hint, 'map-hint--hidden', !text);
    }
    if (tool !== 'measure') {
      measure = { a: null, b: null };
    }
    applyCursor();
  }

  function applyCursor() {
    if (!canvas) return;
    canvas.style.cursor = tool === 'goto' || tool === 'measure' ? 'crosshair' : drag ? 'grabbing' : 'grab';
  }

  function syncFollowUi() {
    follow = state.mapFollow !== false;
    if (els.followBtn) {
      setClass(els.followBtn, 'is-active', follow);
      els.followBtn.title = follow ? '跟随编队：开（点击关闭）' : '跟随编队：关（点击开启）';
    }
  }

  function syncLayerUi() {
    layers = { ...(state.mapLayers || {}) };
    if (!els.layerChips) return;
    for (const chip of els.layerChips.querySelectorAll('.map-chip')) {
      setClass(chip, 'is-active', !!layers[chip.dataset.layer]);
    }
  }

  function updateZoomUi() {
    const zoomText = `${view.zoom >= 1 ? view.zoom.toFixed(1) : view.zoom.toFixed(2)}×`;
    if (els.zoomVal) setText(els.zoomVal, zoomText);

    // chart scale bar: pick a round distance close to 80 CSS px
    const nice = [10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000, 20000, 50000];
    const k = ppu();
    let pick = nice[0];
    for (const m of nice) {
      pick = m;
      if (m * k >= 62) break;
    }
    const width = clamp(pick * k, 34, 140);
    if (els.scaleFill) els.scaleFill.style.width = `${width.toFixed(1)}px`;
    if (els.scaleLabel) {
      setText(els.scaleLabel, pick >= 1000 ? `${(pick / 1000).toFixed(pick >= 10000 ? 0 : 1)} km` : `${pick} m`);
    }
    if (els.denom) {
      // representative fraction, assuming a 0.2646 mm CSS pixel
      const denominator = Math.max(500, Math.round(1 / (0.0002645833 * k) / 100) * 100);
      setText(els.denom, `1:${String(denominator).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}`);
    }
    applyCursor();
  }

  // ---------------------------------------------------------------------------
  // canvas sizing
  // ---------------------------------------------------------------------------
  function ensureSize(force = false) {
    if (!host) return false;
    const cssW = host.clientWidth;
    const cssH = host.clientHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (!force && cssW === size.w && cssH === size.h && dpr === size.dpr) return false;
    if (cssW < 8 || cssH < 8) return false;
    size.w = cssW;
    size.h = cssH;
    size.dpr = dpr;
    canvas.width = Math.max(1, Math.round(cssW * dpr));
    canvas.height = Math.max(1, Math.round(cssH * dpr));
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    updateZoomUi();
    return true;
  }

  // ---------------------------------------------------------------------------
  // chart camera
  // ---------------------------------------------------------------------------
  function snapToFleet() {
    const target = centroidOfLive() || (snap && snap.fleet && snap.fleet.center) || null;
    if (!target || !isNum(target.x)) return;
    view.cx = target.x;
    view.cz = target.z;
    inited = true;
  }

  function setZoom(next, anchorSx, anchorSy) {
    const z = clamp(next, CHART.minZoom, CHART.maxZoom);
    if (Math.abs(z - view.zoom) < 0.0005) return;
    const anchor = isNum(anchorSx) && isNum(anchorSy) && !follow;
    let wx = view.cx;
    let wz = view.cz;
    if (anchor) {
      const w = s2w(anchorSx, anchorSy);
      wx = w.x;
      wz = w.z;
    }
    view.zoom = z;
    if (anchor) {
      const k = ppu();
      view.cx = wx - (anchorSx - size.w / 2) / k;
      view.cz = wz - (anchorSy - size.h / 2) / k;
    }
    updateZoomUi();
    drawNow();
  }

  function centroidOfLive() {
    let sx = 0;
    let sz = 0;
    let n = 0;
    for (const v of live) {
      if (!isNum(v.x) || !isNum(v.z)) continue;
      sx += v.x;
      sz += v.z;
      n += 1;
    }
    return n ? { x: sx / n, z: sz / n } : null;
  }

  // ---------------------------------------------------------------------------
  // data plumbing
  // ---------------------------------------------------------------------------
  function refreshLive() {
    try {
      live = ctx.getLiveVessels() || [];
    } catch {
      live = [];
    }
  }

  function recordTrails(now) {
    if (now - lastTrailAt < 160) return;
    lastTrailAt = now;
    const cutoff = now - CHART.trailSec * 1000;
    for (const v of live) {
      if (!v || !v.id || !isNum(v.x) || !isNum(v.z)) continue;
      let arr = trails.get(v.id);
      if (!arr) {
        arr = [];
        trails.set(v.id, arr);
      }
      arr.push({ x: v.x, z: v.z, t: now });
      while (arr.length > 2 && arr[0].t < cutoff) arr.shift();
      if (arr.length > 600) arr.splice(0, arr.length - 600);
    }
    if (trails.size > live.length + 6) {
      const ids = new Set(live.map((v) => v.id));
      for (const key of trails.keys()) if (!ids.has(key)) trails.delete(key);
    }
  }

  function currentWaypointIndex() {
    const idx = snap && snap.fleet && snap.fleet.mission && snap.fleet.mission.waypointIndex;
    if (isNum(idx)) return clamp(Math.round(idx), 1, MISSION.waypoints.length);
    return 4; // opens mid-mission (SURVEY phase, WP-04)
  }

  function selectedLive() {
    if (!state.selectedId) return null;
    return live.find((v) => v.id === state.selectedId) || null;
  }

  function snapshotById(id) {
    return snapById.get(id) || null;
  }

  function selectedSnapshot() {
    return state.selectedId ? snapshotById(state.selectedId) : null;
  }

  // ---------------------------------------------------------------------------
  // text helpers
  // ---------------------------------------------------------------------------
  function font(size, weight, family) {
    return `${weight ? `${weight} ` : ''}${size}px ${family || tokens.fontMono}`;
  }

  function textAt(c, str, x, y, opts = {}) {
    const { size = 9, weight = 400, family, color, align = 'left', baseline = 'middle' } = opts;
    c.font = font(size, weight, family);
    c.textAlign = align;
    c.textBaseline = baseline;
    c.fillStyle = color || tokens.text3;
    c.fillText(str, x, y);
  }

  function plateAt(c, x, y, w, hgt, opts = {}) {
    const { border = withAlpha(tokens.accent, 0.4), bg = 'rgba(2,11,18,0.78)', accentBar = false } = opts;
    c.fillStyle = bg;
    c.fillRect(x, y, w, hgt);
    if (border) {
      c.strokeStyle = border;
      c.lineWidth = 1;
      c.strokeRect(x + 0.5, y + 0.5, w - 1, hgt - 1);
    }
    if (accentBar) {
      c.fillStyle = withAlpha(tokens.accent, 0.9);
      c.fillRect(x, y, 2, hgt);
    }
  }

  // ---------------------------------------------------------------------------
  // drawing — sea bed + graticule
  // ---------------------------------------------------------------------------
  function drawSea(c, w, hgt) {
    const g = c.createLinearGradient(0, 0, 0, hgt);
    g.addColorStop(0, C.seaTop);
    g.addColorStop(1, C.seaBottom);
    c.fillStyle = g;
    c.fillRect(0, 0, w, hgt);

    const rg = c.createRadialGradient(w * 0.5, hgt * 0.42, 0, w * 0.5, hgt * 0.42, Math.max(w, hgt) * 0.78);
    rg.addColorStop(0, C.seaGlow);
    rg.addColorStop(0.62, 'rgba(10,40,54,0.14)');
    rg.addColorStop(1, 'rgba(4,19,29,0)');
    c.fillStyle = rg;
    c.fillRect(0, 0, w, hgt);

    const vg = c.createRadialGradient(
      w / 2,
      hgt / 2,
      Math.min(w, hgt) * 0.32,
      w / 2,
      hgt / 2,
      Math.max(w, hgt) * 0.78,
    );
    vg.addColorStop(0, 'rgba(2,11,18,0)');
    vg.addColorStop(1, 'rgba(2,11,18,0.42)');
    c.fillStyle = vg;
    c.fillRect(0, 0, w, hgt);
  }

  function niceGridStep(k) {
    const candidates = [20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000, 20000];
    for (const m of candidates) if (m * k >= 70) return m;
    return 20000;
  }

  function drawGraticule(c, w, hgt) {
    const k = ppu();
    const step = niceGridStep(k);
    const minor = step / 4;
    const showMinor = minor * k >= 16;

    const left = view.cx - w / 2 / k;
    const right = view.cx + w / 2 / k;
    const top = view.cz - hgt / 2 / k;
    const bottom = view.cz + hgt / 2 / k;

    c.lineWidth = 1;
    if (showMinor) {
      c.strokeStyle = C.gridMinor;
      c.beginPath();
      for (let x = Math.floor(left / minor) * minor; x <= right; x += minor) {
        const sx = Math.round(w / 2 + (x - view.cx) * k) + 0.5;
        if (sx < 0 || sx > w) continue;
        c.moveTo(sx, 0);
        c.lineTo(sx, hgt);
      }
      for (let z = Math.floor(top / minor) * minor; z <= bottom; z += minor) {
        const sy = Math.round(hgt / 2 + (z - view.cz) * k) + 0.5;
        if (sy < 0 || sy > hgt) continue;
        c.moveTo(0, sy);
        c.lineTo(w, sy);
      }
      c.stroke();
    }

    c.strokeStyle = C.gridMajor;
    c.beginPath();
    const majorXs = [];
    const majorZs = [];
    for (let x = Math.floor(left / step) * step; x <= right; x += step) {
      const sx = Math.round(w / 2 + (x - view.cx) * k) + 0.5;
      if (sx < 0 || sx > w) continue;
      majorXs.push({ world: x, sx });
      c.moveTo(sx, 0);
      c.lineTo(sx, hgt);
    }
    for (let z = Math.floor(top / step) * step; z <= bottom; z += step) {
      const sy = Math.round(hgt / 2 + (z - view.cz) * k) + 0.5;
      if (sy < 0 || sy > hgt) continue;
      majorZs.push({ world: z, sy });
      c.moveTo(0, sy);
      c.lineTo(w, sy);
    }
    c.stroke();

    // edge ticks + coordinate labels (lon on the top edge, lat on the left)
    c.strokeStyle = C.gridTick;
    c.beginPath();
    for (const line of majorXs) {
      c.moveTo(line.sx, 0);
      c.lineTo(line.sx, 5);
      c.moveTo(line.sx, hgt);
      c.lineTo(line.sx, hgt - 5);
    }
    for (const line of majorZs) {
      c.moveTo(0, line.sy);
      c.lineTo(5, line.sy);
      c.moveTo(w, line.sy);
      c.lineTo(w - 5, line.sy);
    }
    c.stroke();

    for (const line of majorXs) {
      const geo = projectWorld(line.world, view.cz);
      const anchorX = clamp(line.sx, 28, w - 28);
      textAt(c, format.lon(geo.lon), anchorX, 12, {
        size: 8,
        color: withAlpha(tokens.text3, 0.9),
        align: 'center',
        family: tokens.fontMono,
      });
    }
    for (const line of majorZs) {
      const geo = projectWorld(view.cx, line.world);
      const anchorY = clamp(line.sy, 12, hgt - 12);
      textAt(c, format.lat(geo.lat), 8, anchorY - 7, {
        size: 8,
        color: withAlpha(tokens.text3, 0.9),
        family: tokens.fontMono,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // drawing — terrain / facilities
  // ---------------------------------------------------------------------------
  function polygonPath(c, pts) {
    c.beginPath();
    for (let i = 0; i < pts.length; i += 1) {
      const p = w2s(pts[i].x, pts[i].z);
      if (i === 0) c.moveTo(p.x, p.y);
      else c.lineTo(p.x, p.y);
    }
    c.closePath();
  }

  function drawTerrain(c) {
    const k = ppu();
    for (const isl of ISLANDS) {
      const p = w2s(isl.x, isl.z);
      const rPx = isl.radius * k;
      if (!onScreen(p, rPx + 40)) continue;
      if (rPx < 2.5) {
        c.fillStyle = C.landLine;
        c.beginPath();
        c.arc(p.x, p.y, 1.6, 0, TAU);
        c.fill();
        continue;
      }
      // bathymetric shoreline contour
      c.strokeStyle = C.landContour;
      c.lineWidth = 1;
      c.setLineDash([3, 4]);
      c.beginPath();
      c.ellipse(p.x, p.y, rPx * 1.34, rPx * 1.2, 0, 0, TAU);
      c.stroke();
      c.setLineDash([]);
      // land
      polygonPath(c, isl.polygon);
      c.fillStyle = C.landFill;
      c.fill();
      c.strokeStyle = C.landLine;
      c.lineWidth = 1.1;
      c.stroke();
      // inner high ground
      if (rPx > 16) {
        c.save();
        c.globalAlpha = 0.6;
        polygonPath(
          c,
          isl.polygon.map((pt) => ({ x: isl.x + (pt.x - isl.x) * 0.62, z: isl.z + (pt.z - isl.z) * 0.62 })),
        );
        c.fillStyle = C.landFillInner;
        c.fill();
        c.restore();
      }
      if (layers.labels && rPx > 9) {
        const label = isl.kind === 'base' ? LANDMARKS.baseIsland.label : '海岛';
        textAt(c, label, p.x, p.y + rPx * 0.55 + 10, {
          size: 9,
          color: withAlpha(tokens.text2, 0.85),
          align: 'center',
          family: tokens.fontCn,
        });
      }
    }

    // reef / lagoon
    const reef = w2s(REEF.x, REEF.z);
    const rx = REEF.rx * k;
    const rz = REEF.rz * k;
    if (onScreen(reef, Math.max(rx, rz) + 40)) {
      c.setLineDash([]);
      c.fillStyle = C.reefFill;
      c.beginPath();
      c.ellipse(reef.x, reef.y, rx, rz, 0, 0, TAU);
      c.fill();
      c.strokeStyle = C.reefLine;
      c.lineWidth = 1;
      c.setLineDash([4, 4]);
      c.stroke();
      c.setLineDash([]);
      c.strokeStyle = C.reefContour;
      c.beginPath();
      c.ellipse(reef.x, reef.y, rx * 1.24, rz * 1.24, 0, 0, TAU);
      c.stroke();
      c.fillStyle = C.reefFillInner;
      c.beginPath();
      c.ellipse(reef.x, reef.y, rx * 0.52, rz * 0.5, 0, 0, TAU);
      c.fill();
      if (layers.labels) {
        textAt(c, REEF.label, reef.x, reef.y + rz + 12, {
          size: 9,
          color: withAlpha(tokens.accent, 0.7),
          align: 'center',
          family: tokens.fontCn,
        });
      }
    }
  }

  function drawRangeRings(c, w, hgt) {
    const flag = live.find((v) => v.id === 'flagship');
    const center = flag ? w2s(flag.x, flag.z) : { x: w / 2, y: hgt / 2 };
    const k = ppu();
    for (let i = 1; i <= 3; i += 1) {
      const r = 500 * i * k;
      if (r < 12) continue;
      c.strokeStyle = i === 1 ? withAlpha(tokens.accent, 0.11) : withAlpha(tokens.accent, 0.07);
      c.lineWidth = 1;
      c.setLineDash([2, 5]);
      c.beginPath();
      c.arc(center.x, center.y, r, 0, TAU);
      c.stroke();
      c.setLineDash([]);
      if (r >= 46) {
        textAt(c, `${i * 500} m`, center.x + r * 0.7, center.y - r * 0.7, {
          size: 8,
          color: withAlpha(tokens.text3, 0.8),
          align: 'center',
        });
      }
    }
  }

  function drawGeofence(c) {
    if (!GEOFENCE || GEOFENCE.length < 3) return;
    c.beginPath();
    for (let i = 0; i < GEOFENCE.length; i += 1) {
      const p = w2s(GEOFENCE[i].x, GEOFENCE[i].z);
      if (i === 0) c.moveTo(p.x, p.y);
      else c.lineTo(p.x, p.y);
    }
    c.closePath();
    c.fillStyle = C.geofenceFill;
    c.fill();
    c.strokeStyle = C.geofence;
    c.lineWidth = 1.1;
    c.setLineDash([7, 5]);
    c.stroke();
    c.setLineDash([]);
    c.fillStyle = C.geofence;
    for (const pt of GEOFENCE) {
      const p = w2s(pt.x, pt.z);
      c.beginPath();
      c.moveTo(p.x, p.y - 2.6);
      c.lineTo(p.x + 2.6, p.y);
      c.lineTo(p.x, p.y + 2.6);
      c.lineTo(p.x - 2.6, p.y);
      c.closePath();
      c.fill();
    }
    if (layers.labels) {
      const p = w2s(GEOFENCE[1].x, GEOFENCE[1].z);
      if (onScreen(p, 20)) {
        textAt(c, '任务海域边界', p.x + 8, p.y - 8, {
          size: 8.5,
          color: withAlpha(tokens.warn, 0.85),
          family: tokens.fontCn,
        });
      }
    }
  }

  function drawFacilities(c) {
    const k = ppu();

    const base = w2s(LANDMARKS.base.x, LANDMARKS.base.z);
    if (onScreen(base, 60)) {
      c.save();
      c.translate(base.x, base.y);
      c.strokeStyle = withAlpha(tokens.gold, 0.9);
      c.fillStyle = 'rgba(255,210,122,0.14)';
      c.lineWidth = 1.2;
      c.beginPath();
      c.rect(-4.5, -4.5, 9, 9);
      c.fill();
      c.stroke();
      c.beginPath();
      c.moveTo(-4.5, 0);
      c.lineTo(-8.5, 0);
      c.moveTo(4.5, 0);
      c.lineTo(8.5, 0);
      c.stroke();
      c.restore();
      if (layers.labels) {
        textAt(c, LANDMARKS.base.label, base.x + 11, base.y - 1, {
          size: 9,
          color: withAlpha(tokens.gold, 0.9),
          family: tokens.fontCn,
        });
        textAt(c, LANDMARKS.base.en, base.x + 11, base.y + 9, {
          size: 7,
          color: withAlpha(tokens.text3, 0.9),
          family: tokens.fontEn,
        });
      }
    }

    const mother = w2s(LANDMARKS.mothership.x, LANDMARKS.mothership.z);
    if (onScreen(mother, 60)) {
      c.save();
      c.translate(mother.x, mother.y);
      c.strokeStyle = withAlpha(tokens.text2, 0.85);
      c.fillStyle = 'rgba(212,236,241,0.10)';
      c.lineWidth = 1.1;
      c.beginPath();
      c.moveTo(0, -7);
      c.lineTo(3.4, -1);
      c.lineTo(3.4, 6);
      c.lineTo(-3.4, 6);
      c.lineTo(-3.4, -1);
      c.closePath();
      c.fill();
      c.stroke();
      c.beginPath();
      c.moveTo(-1.6, -1);
      c.lineTo(1.6, -1);
      c.moveTo(0, -1);
      c.lineTo(0, 4);
      c.stroke();
      c.restore();
      if (layers.labels) {
        textAt(c, LANDMARKS.mothership.label, mother.x + 8, mother.y + 4, {
          size: 8.5,
          color: withAlpha(tokens.text2, 0.8),
          family: tokens.fontCn,
        });
      }
    }

    const light = w2s(LANDMARKS.lighthouse.x, LANDMARKS.lighthouse.z);
    if (onScreen(light, 40)) {
      c.save();
      c.translate(light.x, light.y);
      c.strokeStyle = withAlpha(tokens.warn, 0.9);
      c.lineWidth = 1.1;
      c.beginPath();
      c.moveTo(0, 5);
      c.lineTo(0, -3);
      c.moveTo(-3, 5);
      c.lineTo(3, 5);
      c.moveTo(0, -3);
      c.lineTo(-3.6, -6.4);
      c.moveTo(0, -3);
      c.lineTo(3.6, -6.4);
      c.stroke();
      c.fillStyle = withAlpha(tokens.warn, 0.9);
      c.beginPath();
      c.arc(0, -3, 1.5, 0, TAU);
      c.fill();
      c.restore();
      if (layers.labels) {
        textAt(c, LANDMARKS.lighthouse.label, light.x + 7, light.y, {
          size: 8.5,
          color: withAlpha(tokens.warn, 0.85),
          family: tokens.fontCn,
        });
      }
    }

    const platform = w2s(LANDMARKS.platform.x, LANDMARKS.platform.z);
    if (onScreen(platform, 40)) {
      c.save();
      c.translate(platform.x, platform.y);
      c.strokeStyle = withAlpha(tokens.accent2, 0.85);
      c.lineWidth = 1.1;
      c.beginPath();
      c.moveTo(0, -5);
      c.lineTo(5, 0);
      c.lineTo(0, 5);
      c.lineTo(-5, 0);
      c.closePath();
      c.stroke();
      c.beginPath();
      c.moveTo(-2.4, 0);
      c.lineTo(2.4, 0);
      c.moveTo(0, -2.4);
      c.lineTo(0, 2.4);
      c.stroke();
      c.restore();
      if (layers.labels) {
        textAt(c, LANDMARKS.platform.label, platform.x + 8, platform.y, {
          size: 8.5,
          color: withAlpha(tokens.accent2, 0.85),
          family: tokens.fontCn,
        });
      }
    }

    // wind farm
    if (WIND_TURBINES.length) {
      c.strokeStyle = withAlpha(tokens.accent2, 0.55);
      c.lineWidth = 1;
      for (const t of WIND_TURBINES) {
        const p = w2s(t.x, t.z);
        if (!onScreen(p, 30)) continue;
        c.save();
        c.translate(p.x, p.y);
        c.beginPath();
        c.moveTo(0, 4);
        c.lineTo(0, -3);
        for (let i = 0; i < 3; i += 1) {
          const a = (i / 3) * TAU - Math.PI / 2;
          c.moveTo(0, -3);
          c.lineTo(Math.cos(a) * 5, -3 + Math.sin(a) * 5);
        }
        c.stroke();
        c.restore();
      }
      const wf = w2s(WIND.x, WIND.z);
      if (layers.labels && onScreen(wf, 40)) {
        textAt(c, LANDMARKS.windFarm.label, wf.x, wf.y + 18, {
          size: 8.5,
          color: withAlpha(tokens.text2, 0.75),
          align: 'center',
          family: tokens.fontCn,
        });
      }
    }

    // buoy field (marker zone)
    c.fillStyle = withAlpha(tokens.accent, 0.5);
    for (const b of MARKER_BUOYS) {
      const p = w2s(b.x, b.z);
      if (!onScreen(p, 8)) continue;
      c.beginPath();
      c.moveTo(p.x, p.y - 2.2);
      c.lineTo(p.x + 2.2, p.y);
      c.lineTo(p.x, p.y + 2.2);
      c.lineTo(p.x - 2.2, p.y);
      c.closePath();
      c.fill();
    }
    if (layers.labels) {
      const zone = w2s(LANDMARKS.markerZone.x, LANDMARKS.markerZone.z);
      if (onScreen(zone, 60)) {
        textAt(c, LANDMARKS.markerZone.label, zone.x, zone.y + (LANDMARKS.markerZone.depth * k) / 2 + 12, {
          size: 8.5,
          color: withAlpha(tokens.accent, 0.6),
          align: 'center',
          family: tokens.fontCn,
        });
      }
    }
    for (const b of LANDMARKS.farBuoys) {
      const p = w2s(b.x, b.z);
      if (!onScreen(p, 10)) continue;
      c.strokeStyle = withAlpha(tokens.accent2, 0.6);
      c.lineWidth = 1;
      c.beginPath();
      c.moveTo(p.x, p.y - 3);
      c.lineTo(p.x + 3, p.y);
      c.lineTo(p.x, p.y + 3);
      c.lineTo(p.x - 3, p.y);
      c.closePath();
      c.stroke();
      c.fillStyle = withAlpha(tokens.warn, 0.8);
      c.beginPath();
      c.arc(p.x, p.y, 1, 0, TAU);
      c.fill();
    }
  }

  // ---------------------------------------------------------------------------
  // drawing — mission route / waypoints / active target
  // ---------------------------------------------------------------------------
  function drawRoute(c, now) {
    const wps = MISSION.waypoints;
    const cur = currentWaypointIndex();
    const points = wps.map((wp) => ({ wp, p: w2s(wp.x, wp.z) }));

    for (let i = 0; i < points.length - 1; i += 1) {
      const a = points[i].p;
      const b = points[i + 1].p;
      const passed = i + 1 < cur;
      c.strokeStyle = passed ? C.routePast : C.routeFuture;
      c.lineWidth = passed ? 1.5 : 1.1;
      c.setLineDash(passed ? [] : [6, 5]);
      c.beginPath();
      c.moveTo(a.x, a.y);
      c.lineTo(b.x, b.y);
      c.stroke();
    }
    c.setLineDash([]);

    for (let i = 0; i < points.length; i += 1) {
      const { wp, p } = points[i];
      if (!onScreen(p, 30)) continue;
      const st = i + 1 < cur ? 'passed' : i + 1 === cur ? 'current' : 'future';
      if (st === 'current') {
        const pulseR = 6 + Math.sin(now / 300) * 1.6;
        c.strokeStyle = withAlpha(tokens.accent, 0.55);
        c.lineWidth = 1;
        c.beginPath();
        c.arc(p.x, p.y, pulseR + 4, 0, TAU);
        c.stroke();
      }
      c.beginPath();
      if (st === 'passed') {
        c.fillStyle = withAlpha(tokens.accent, 0.75);
        c.arc(p.x, p.y, 3.2, 0, TAU);
        c.fill();
      } else if (st === 'current') {
        c.fillStyle = withAlpha(tokens.accent, 0.9);
        c.arc(p.x, p.y, 3.6, 0, TAU);
        c.fill();
        c.strokeStyle = withAlpha(tokens.accent, 0.6);
        c.lineWidth = 1;
        c.beginPath();
        c.arc(p.x, p.y, 8.5, 0, TAU);
        c.stroke();
      } else {
        c.strokeStyle = withAlpha(tokens.accent, 0.55);
        c.fillStyle = 'rgba(2,11,18,0.65)';
        c.lineWidth = 1;
        c.arc(p.x, p.y, 4, 0, TAU);
        c.fill();
        c.stroke();
      }
      const offset = st === 'current' ? 13 : 9;
      textAt(c, wp.id, p.x + offset, p.y - offset, {
        size: 8.5,
        weight: st === 'current' ? 600 : 400,
        color: st === 'passed' ? withAlpha(tokens.text3, 0.9) : withAlpha(tokens.accent, 0.9),
      });
      if (layers.labels && st === 'current') {
        textAt(c, wp.name, p.x + offset, p.y - offset + 10, {
          size: 8.5,
          color: withAlpha(tokens.text2, 0.9),
          family: tokens.fontCn,
        });
      }
    }
  }

  function drawActiveWaypoint(c, now) {
    const wp = state.activeWaypoint;
    if (!wp || !isNum(wp.x) || !isNum(wp.z)) return;
    const p = w2s(wp.x, wp.z);
    if (!onScreen(p, 40)) return;
    const sel = selectedLive();
    if (sel && isNum(sel.x)) {
      const sp = w2s(sel.x, sel.z);
      c.strokeStyle = withAlpha(tokens.accent, 0.35);
      c.lineWidth = 1;
      c.setLineDash([3, 4]);
      c.beginPath();
      c.moveTo(sp.x, sp.y);
      c.lineTo(p.x, p.y);
      c.stroke();
      c.setLineDash([]);
    }
    const pulseR = 10 + Math.sin(now / 260) * 2;
    c.strokeStyle = withAlpha(tokens.accent, 0.8);
    c.lineWidth = 1.2;
    c.beginPath();
    c.arc(p.x, p.y, pulseR, 0, TAU);
    c.stroke();
    c.beginPath();
    c.arc(p.x, p.y, 4, 0, TAU);
    c.stroke();
    c.beginPath();
    c.moveTo(p.x - 9, p.y);
    c.lineTo(p.x - 5, p.y);
    c.moveTo(p.x + 5, p.y);
    c.lineTo(p.x + 9, p.y);
    c.moveTo(p.x, p.y - 9);
    c.lineTo(p.x, p.y - 5);
    c.moveTo(p.x, p.y + 5);
    c.lineTo(p.x, p.y + 9);
    c.stroke();

    let distTxt = '';
    if (sel) distTxt = format.dist(Math.hypot(wp.x - sel.x, wp.z - sel.z));
    const label = `${wp.label || 'TGT'}${distTxt ? ` · ${distTxt}` : ''}`;
    c.font = font(9, 500, tokens.fontMono);
    const tw = c.measureText(label).width;
    plateAt(c, p.x + 13, p.y - 20, tw + 12, 15, { accentBar: true });
    textAt(c, label, p.x + 19, p.y - 12.5, { size: 9, weight: 500, color: tokens.accent });
  }

  function drawVesselWaypoint(c) {
    const sel = selectedSnapshot();
    const liveSel = selectedLive();
    if (!sel || !sel.waypoint || !liveSel) return;
    const wp = sel.waypoint;
    if (!isNum(wp.x) || !isNum(wp.z)) return;
    const p = w2s(wp.x, wp.z);
    const sp = w2s(liveSel.x, liveSel.z);
    if (!onScreen(p, 60) || !onScreen(sp, 40)) return;
    c.strokeStyle = withAlpha(tokens.accent, 0.3);
    c.lineWidth = 1;
    c.setLineDash([2, 4]);
    c.beginPath();
    c.moveTo(sp.x, sp.y);
    c.lineTo(p.x, p.y);
    c.stroke();
    c.setLineDash([]);
    c.strokeStyle = withAlpha(tokens.accent, 0.7);
    c.beginPath();
    c.arc(p.x, p.y, 3.4, 0, TAU);
    c.stroke();
    if (layers.labels) {
      const label = `${format.dist(wp.distM)} · ETA ${format.hms(wp.etaSec)}`;
      textAt(c, label, p.x + 7, p.y - 7, { size: 8.5, color: withAlpha(tokens.accent, 0.75) });
    }
  }

  // ---------------------------------------------------------------------------
  // drawing — sonar coverage / tracks
  // ---------------------------------------------------------------------------
  function drawSonar(c) {
    for (const v of live) {
      const type = v.type || (snapshotById(v.id) || {}).type;
      let radiusM = 0;
      if (type === 'survey') radiusM = 170;
      else if (type === 'env') radiusM = 120;
      else if (type === 'flagship') radiusM = 210;
      if (!radiusM) continue;
      const p = w2s(v.x, v.z);
      const r = radiusM * ppu();
      if (!onScreen(p, r + 10) || r < 4) continue;
      const isSel = v.id === state.selectedId;
      c.fillStyle = isSel ? withAlpha(tokens.accent, 0.06) : C.sonarFill;
      c.strokeStyle = isSel ? withAlpha(tokens.accent, 0.35) : C.sonarLine;
      c.lineWidth = 1;
      c.setLineDash([2, 4]);
      c.beginPath();
      c.arc(p.x, p.y, r, 0, TAU);
      c.fill();
      c.stroke();
      c.setLineDash([]);
    }
  }

  function drawTracks(c, now) {
    for (const [id, pts] of trails) {
      if (!pts || pts.length < 2) continue;
      const type = (snapshotById(id) || {}).type || 'scout';
      const color = (TYPE_META[type] || TYPE_META.scout).hex;
      for (let bucket = 0; bucket < 3; bucket += 1) {
        const ageMin = bucket * 20;
        const ageMax = (bucket + 1) * 20;
        c.strokeStyle = withAlpha(color, 0.42 - bucket * 0.12);
        c.lineWidth = bucket === 0 ? 1.3 : 1;
        c.beginPath();
        let started = false;
        for (const pt of pts) {
          const age = (now - pt.t) / 1000;
          if (age < ageMin || age >= ageMax) {
            started = false;
            continue;
          }
          const p = w2s(pt.x, pt.z);
          if (!started) {
            c.moveTo(p.x, p.y);
            started = true;
          } else {
            c.lineTo(p.x, p.y);
          }
        }
        c.stroke();
      }
      if (pts.length > 1) {
        const last = w2s(pts[pts.length - 1].x, pts[pts.length - 1].z);
        const prev = w2s(pts[pts.length - 2].x, pts[pts.length - 2].z);
        if (Math.hypot(last.x - prev.x, last.y - prev.y) < 30) {
          c.strokeStyle = withAlpha(color, 0.6);
          c.lineWidth = 1.4;
          c.beginPath();
          c.moveTo(prev.x, prev.y);
          c.lineTo(last.x, last.y);
          c.stroke();
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // drawing — vessels
  // ---------------------------------------------------------------------------
  function drawVessels(c, now) {
    const zoomK = clamp(0.62 + view.zoom * 0.25, 0.62, 1.3);
    const selId = state.selectedId;
    for (const v of live) {
      if (!v || !isNum(v.x) || !isNum(v.z)) continue;
      const p = w2s(v.x, v.z);
      const sv = snapshotById(v.id) || {};
      const type = v.type || sv.type || 'scout';
      const meta = TYPE_META[type] || TYPE_META.scout;
      const color = meta.hex || '#5ff3e4';
      const isFlag = type === 'flagship' || v.id === 'flagship';
      const isSel = v.id === selId;
      const status = sv.status || 'normal';
      const heading = isNum(v.headingDeg) ? v.headingDeg : isNum(v.yawDeg) ? v.yawDeg : 0;
      const s = (isFlag ? 13 : 10) * zoomK;
      if (!onScreen(p, 24)) continue;

      // heading vector for the selected hull / flagship
      if (isSel || isFlag) {
        const hx = p.x + Math.sin(rad(heading)) * s * 1.5;
        const hy = p.y - Math.cos(rad(heading)) * s * 1.5;
        c.strokeStyle = isSel ? withAlpha(tokens.accent, 0.55) : withAlpha(tokens.gold, 0.4);
        c.lineWidth = 1;
        c.beginPath();
        c.moveTo(p.x, p.y);
        c.lineTo(hx, hy);
        c.stroke();
      }

      if (isSel) {
        const pulse = 1 + Math.sin(now / 380) * 0.08;
        c.strokeStyle = withAlpha(tokens.accent, 0.85);
        c.lineWidth = 1.3;
        c.beginPath();
        c.arc(p.x, p.y, s * 1.55 * pulse, 0, TAU);
        c.stroke();
        c.strokeStyle = withAlpha(tokens.accent, 0.25);
        c.beginPath();
        c.arc(p.x, p.y, s * 1.9 * pulse, 0, TAU);
        c.stroke();
      } else if (pointer.hoverId === v.id) {
        c.strokeStyle = withAlpha(tokens.accent2, 0.5);
        c.lineWidth = 1;
        c.setLineDash([2, 3]);
        c.beginPath();
        c.arc(p.x, p.y, s * 1.5, 0, TAU);
        c.stroke();
        c.setLineDash([]);
      }

      c.save();
      c.translate(p.x, p.y);
      c.rotate(rad(heading));
      c.globalAlpha = status === 'offline' ? 0.45 : 1;
      if (isFlag) {
        c.fillStyle = 'rgba(255,210,122,0.16)';
        c.beginPath();
        c.arc(0, 0, s * 1.1, 0, TAU);
        c.fill();
        c.strokeStyle = withAlpha(tokens.gold, 0.45);
        c.lineWidth = 1;
        c.beginPath();
        c.arc(0, 0, s * 0.95, 0, TAU);
        c.stroke();
        c.beginPath();
        c.moveTo(0, -s * 0.68);
        c.lineTo(s * 0.58, 0);
        c.lineTo(0, s * 0.68);
        c.lineTo(-s * 0.58, 0);
        c.closePath();
        c.fillStyle = tokens.gold;
        c.fill();
        c.strokeStyle = C.markerDark;
        c.lineWidth = 1;
        c.stroke();
        c.fillStyle = C.markerDark;
        c.beginPath();
        c.moveTo(0, -s * 0.68);
        c.lineTo(s * 0.2, -s * 0.24);
        c.lineTo(-s * 0.2, -s * 0.24);
        c.closePath();
        c.fill();
      } else {
        c.beginPath();
        c.moveTo(0, -s * 0.66);
        c.lineTo(s * 0.46, s * 0.56);
        c.lineTo(0, s * 0.28);
        c.lineTo(-s * 0.46, s * 0.56);
        c.closePath();
        c.fillStyle = color;
        c.fill();
        c.strokeStyle = C.markerDark;
        c.lineWidth = 1;
        c.stroke();
      }
      c.restore();

      const sev = status === 'critical' ? 'danger' : status === 'warning' ? 'warn' : null;
      if (sev) {
        const col = sev === 'danger' ? tokens.danger : tokens.warn;
        const pulse = 0.72 + 0.28 * Math.sin(now / 300 + p.x);
        c.fillStyle = withAlpha(col, 0.95 * pulse);
        c.beginPath();
        c.arc(p.x + s * 0.78, p.y - s * 0.78, 2.5, 0, TAU);
        c.fill();
        c.strokeStyle = withAlpha(col, 0.5);
        c.lineWidth = 1;
        c.beginPath();
        c.arc(p.x + s * 0.78, p.y - s * 0.78, 4.6, 0, TAU);
        c.stroke();
      } else if (status === 'offline') {
        c.fillStyle = withAlpha(tokens.text3, 0.8);
        c.beginPath();
        c.arc(p.x + s * 0.8, p.y - s * 0.8, 1.8, 0, TAU);
        c.fill();
      }

      const vm = FLEET_BY_ID.get(v.id);
      const callSign = sv.callSign || v.callSign || (vm ? vm.callSign : v.id);
      const name = sv.name || v.name || (vm ? vm.name : '');
      if (isSel) {
        const sog = isNum(sv.sogKn) ? sv.sogKn : isNum(v.sogKn) ? v.sogKn : null;
        const label = `${callSign} ${name}${sog != null ? ` · ${format.num(sog, 1)} kn` : ''}`;
        c.font = font(9.5, 600, tokens.fontMono);
        const tw = c.measureText(label).width;
        const bw = tw + 24;
        let bx = p.x + s * 1.9 - 4;
        let by = p.y - s * 1.5 - 9;
        if (bx + bw > size.w - 8) bx = p.x - s * 1.9 - bw + 4;
        if (by < 52) by = p.y + s * 1.7 + 2;
        plateAt(c, bx, by, bw, 17, { accentBar: true, border: withAlpha(tokens.accent, 0.45) });
        textAt(c, label, bx + 8, by + 9, { size: 9.5, weight: 600, color: tokens.accent });
      } else if (layers.labels && (view.zoom >= 2.2 || isFlag || sev)) {
        textAt(c, callSign, p.x + s * 0.95, p.y - s * 0.3, {
          size: 8.5,
          color: isFlag ? withAlpha(tokens.gold, 0.95) : withAlpha(tokens.text2, 0.9),
        });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // drawing — measure tool / placement pulse
  // ---------------------------------------------------------------------------
  function drawMeasure(c) {
    if (!measure.a) return;
    const a = w2s(measure.a.x, measure.a.z);
    c.strokeStyle = withAlpha(tokens.accent2, 0.75);
    c.lineWidth = 1;
    c.beginPath();
    c.arc(a.x, a.y, 3.5, 0, TAU);
    c.stroke();
    c.beginPath();
    c.moveTo(a.x - 8, a.y);
    c.lineTo(a.x + 8, a.y);
    c.moveTo(a.x, a.y - 8);
    c.lineTo(a.x, a.y + 8);
    c.stroke();
    if (!measure.b) {
      textAt(c, '起点', a.x + 8, a.y - 8, {
        size: 8.5,
        color: withAlpha(tokens.accent2, 0.85),
        family: tokens.fontCn,
      });
      return;
    }
    const b = w2s(measure.b.x, measure.b.z);
    c.strokeStyle = withAlpha(tokens.accent, 0.75);
    c.lineWidth = 1.2;
    c.beginPath();
    c.moveTo(a.x, a.y);
    c.lineTo(b.x, b.y);
    c.stroke();
    c.strokeStyle = withAlpha(tokens.accent2, 0.75);
    c.beginPath();
    c.arc(b.x, b.y, 3.5, 0, TAU);
    c.stroke();
    c.beginPath();
    c.moveTo(b.x - 8, b.y);
    c.lineTo(b.x + 8, b.y);
    c.moveTo(b.x, b.y - 8);
    c.lineTo(b.x, b.y + 8);
    c.stroke();
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len > 20) {
      const nx = -dy / len;
      const ny = dx / len;
      c.beginPath();
      c.moveTo(a.x + nx * 4, a.y + ny * 4);
      c.lineTo(a.x - nx * 4, a.y - ny * 4);
      c.moveTo(b.x + nx * 4, b.y + ny * 4);
      c.lineTo(b.x - nx * 4, b.y - ny * 4);
      c.stroke();
    }
    const distM = Math.hypot(measure.b.x - measure.a.x, measure.b.z - measure.a.z);
    const bearing = (deg(Math.atan2(measure.b.x - measure.a.x, -(measure.b.z - measure.a.z))) + 360) % 360;
    const label = `${format.dist(distM)} · ${format.hdg(bearing)}`;
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    c.font = font(9, 500, tokens.fontMono);
    const tw = c.measureText(label).width;
    plateAt(c, mx - tw / 2 - 7, my - 20, tw + 14, 16);
    textAt(c, label, mx, my - 12, { size: 9, weight: 500, color: tokens.accent, align: 'center' });
  }

  function drawPulse(c, now) {
    if (!pulse) return;
    const age = now - pulse.t;
    if (age < 0 || age > 900) {
      pulse = null;
      return;
    }
    const p = w2s(pulse.x, pulse.z);
    const t = age / 900;
    const r = 8 + t * 42;
    c.strokeStyle = withAlpha(tokens.accent, (1 - t) * 0.9);
    c.lineWidth = 1.5;
    c.beginPath();
    c.arc(p.x, p.y, r, 0, TAU);
    c.stroke();
    c.strokeStyle = withAlpha(tokens.accent, (1 - t) * 0.5);
    c.beginPath();
    c.arc(p.x, p.y, r * 0.55, 0, TAU);
    c.stroke();
    c.fillStyle = withAlpha(tokens.accent, (1 - t) * 0.6);
    c.beginPath();
    c.arc(p.x, p.y, 3, 0, TAU);
    c.fill();
  }

  // ---------------------------------------------------------------------------
  // drawing — chart furniture (rose, frame)
  // ---------------------------------------------------------------------------
  function drawCompassRose(c, w, hgt) {
    if (hgt < 380 || w < 420) return;
    const cx = 66;
    const cy = hgt - 104;
    const R = 26;
    c.strokeStyle = withAlpha(tokens.accent2, 0.2);
    c.lineWidth = 1;
    c.beginPath();
    c.arc(cx, cy, R, 0, TAU);
    c.stroke();
    c.strokeStyle = withAlpha(tokens.accent2, 0.1);
    c.beginPath();
    c.arc(cx, cy, R * 0.72, 0, TAU);
    c.stroke();
    c.strokeStyle = withAlpha(tokens.accent2, 0.32);
    c.beginPath();
    for (let a = 0; a < 360; a += 15) {
      const len = a % 90 === 0 ? 6 : a % 45 === 0 ? 4.5 : 3;
      const r1 = R - len;
      const ar = rad(a);
      c.moveTo(cx + Math.sin(ar) * r1, cy - Math.cos(ar) * r1);
      c.lineTo(cx + Math.sin(ar) * R, cy - Math.cos(ar) * R);
    }
    c.stroke();
    const cardinals = [
      { t: 'N', a: 0, strong: true },
      { t: 'E', a: 90 },
      { t: 'S', a: 180 },
      { t: 'W', a: 270 },
    ];
    for (const cd of cardinals) {
      const ar = rad(cd.a);
      textAt(c, cd.t, cx + Math.sin(ar) * (R + 8), cy - Math.cos(ar) * (R + 8), {
        size: 8,
        weight: cd.strong ? 600 : 400,
        color: cd.strong ? tokens.accent : withAlpha(tokens.text3, 0.9),
        align: 'center',
      });
    }
    c.fillStyle = withAlpha(tokens.accent, 0.85);
    c.beginPath();
    c.moveTo(cx, cy - R + 7);
    c.lineTo(cx + 3.6, cy + 3);
    c.lineTo(cx, cy + 1);
    c.lineTo(cx - 3.6, cy + 3);
    c.closePath();
    c.fill();
    c.fillStyle = withAlpha(tokens.text3, 0.5);
    c.beginPath();
    c.moveTo(cx, cy + 1);
    c.lineTo(cx - 3.6, cy + 3);
    c.lineTo(cx, cy + 9);
    c.lineTo(cx + 3.6, cy + 3);
    c.closePath();
    c.fill();
  }

  function drawFrame(c, w, hgt) {
    c.strokeStyle = C.frame;
    c.lineWidth = 1;
    c.strokeRect(7.5, 7.5, w - 15, hgt - 15);
    c.strokeStyle = withAlpha(tokens.accent, 0.16);
    c.beginPath();
    const leg = 16;
    for (const [sx, sy, dx, dy] of [
      [8, 8, 1, 1],
      [w - 8, 8, -1, 1],
      [8, hgt - 8, 1, -1],
      [w - 8, hgt - 8, -1, -1],
    ]) {
      c.moveTo(sx + dx * leg, sy);
      c.lineTo(sx, sy);
      c.lineTo(sx, sy + dy * leg);
    }
    c.stroke();
  }

  // ---------------------------------------------------------------------------
  // main draw
  // ---------------------------------------------------------------------------
  function draw(now) {
    if (!c2d || size.w < 8 || size.h < 8) return;
    const started = performance.now();
    const w = size.w;
    const hgt = size.h;
    const c = c2d;
    c.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
    c.clearRect(0, 0, w, hgt);

    drawSea(c, w, hgt);
    if (layers.grid !== false) drawGraticule(c, w, hgt);
    drawRangeRings(c, w, hgt);
    if (layers.geofence !== false) drawGeofence(c);
    drawTerrain(c);
    if (layers.landmarks !== false) drawFacilities(c);
    if (layers.route !== false) drawRoute(c, now);
    drawActiveWaypoint(c, now);
    drawVesselWaypoint(c);
    if (layers.sonar) drawSonar(c);
    if (layers.tracks !== false) drawTracks(c, now);
    drawVessels(c, now);
    drawMeasure(c);
    drawPulse(c, now);
    drawCompassRose(c, w, hgt);
    drawFrame(c, w, hgt);

    lastDraw = now;
    lastDrawCost = performance.now() - started;
  }

  function drawNow() {
    if (!host) return;
    if (!(host.clientWidth > 8 && host.clientHeight > 8)) return;
    ensureSize();
    refreshLive();
    draw(performance.now());
  }

  // ---------------------------------------------------------------------------
  // cursor readout
  // ---------------------------------------------------------------------------
  function updateCursorDom(now) {
    if (!els.cursorLat) return;
    if (now - lastCursorDom < 90) return;
    lastCursorDom = now;
    let world = null;
    if (pointer.inside) {
      world = s2w(pointer.x, pointer.y);
    } else if (snap && snap.fleet && snap.fleet.center && isNum(snap.fleet.center.x)) {
      world = { x: snap.fleet.center.x, z: snap.fleet.center.z };
    }
    if (!world) return;
    const geo = projectWorld(world.x, world.z);
    setText(els.cursorLat, format.lat(geo.lat));
    setText(els.cursorLon, format.lon(geo.lon));
    const east = Math.round(world.x);
    const north = Math.round(-world.z);
    setText(els.cursorEn, `E ${east >= 0 ? '+' : ''}${east} m / N ${north >= 0 ? '+' : ''}${north} m`);
  }

  function updateHover() {
    if (!pointer.inside || drag) {
      pointer.hoverId = null;
      return;
    }
    const hit = pickVessel(pointer.x, pointer.y);
    pointer.hoverId = hit ? hit.id : null;
    applyCursor();
    if (canvas) {
      canvas.style.cursor =
        tool === 'goto' || tool === 'measure' ? 'crosshair' : drag ? 'grabbing' : hit ? 'pointer' : 'grab';
    }
  }

  // ---------------------------------------------------------------------------
  // hit testing / interaction
  // ---------------------------------------------------------------------------
  function pickVessel(sx, sy) {
    let best = null;
    let bestDist = Infinity;
    for (const v of live) {
      const p = w2s(v.x, v.z);
      const d = Math.hypot(p.x - sx, p.y - sy);
      const limit = 11;
      if (d < limit && d < bestDist) {
        bestDist = d;
        best = v;
      }
    }
    return best;
  }

  function eventPos(ev) {
    const rect = canvas.getBoundingClientRect();
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  }

  function onPointerDown(ev) {
    if (ev.button !== 0) return;
    const pos = eventPos(ev);
    pointer.x = pos.x;
    pointer.y = pos.y;
    pointer.inside = true;
    drag = { id: ev.pointerId, startX: pos.x, startY: pos.y, lastX: pos.x, lastY: pos.y, moved: false };
    if (canvas.setPointerCapture) {
      try {
        canvas.setPointerCapture(ev.pointerId);
      } catch {
        /* ignore */
      }
    }
  }

  function onPointerMove(ev) {
    const pos = eventPos(ev);
    pointer.x = pos.x;
    pointer.y = pos.y;
    pointer.inside = true;
    if (drag) {
      const dx = pos.x - drag.lastX;
      const dy = pos.y - drag.lastY;
      drag.lastX = pos.x;
      drag.lastY = pos.y;
      if (!drag.moved && Math.hypot(pos.x - drag.startX, pos.y - drag.startY) > 3) {
        drag.moved = true;
        if (follow) actions.setMapFollow(false);
        applyCursor();
      }
      if (drag.moved) {
        view.cx -= dx / ppu();
        view.cz -= dy / ppu();
        drawNow();
      }
      return;
    }
    const prevHover = pointer.hoverId;
    updateHover();
    updateCursorDom(performance.now());
    if (prevHover !== pointer.hoverId) drawNow();
  }

  function onPointerUp(ev) {
    if (!drag) return;
    const wasDrag = drag.moved;
    const pos = eventPos(ev);
    drag = null;
    applyCursor();
    if (canvas.releasePointerCapture && ev.pointerId != null) {
      try {
        canvas.releasePointerCapture(ev.pointerId);
      } catch {
        /* ignore */
      }
    }
    if (!wasDrag) handleClick(pos.x, pos.y);
    else drawNow();
  }

  function onPointerLeave() {
    pointer.inside = false;
    pointer.hoverId = null;
    if (!drag) {
      drawNow();
      updateCursorDom(performance.now());
    }
  }

  function handleClick(sx, sy) {
    const hit = pickVessel(sx, sy);
    const world = s2w(sx, sy);
    if (tool === 'goto') {
      actions.placeWaypoint(world.x, world.z);
      pulse = { x: world.x, z: world.z, t: performance.now() };
      drawNow();
      return;
    }
    if (tool === 'measure') {
      if (!measure.a || measure.b) measure = { a: world, b: null };
      else measure.b = world;
      drawNow();
      return;
    }
    if (hit) {
      actions.selectVessel(hit.id);
      drawNow();
    }
  }

  function onWheel(ev) {
    ev.preventDefault();
    const pos = eventPos(ev);
    const factor = Math.exp(-ev.deltaY * 0.0014);
    setZoom(view.zoom * factor, follow ? undefined : pos.x, follow ? undefined : pos.y);
  }

  function onDblClick(ev) {
    if (ev.button !== 0) return;
    const pos = eventPos(ev);
    const world = s2w(pos.x, pos.y);
    if (follow) actions.setMapFollow(false);
    view.cx = world.x;
    view.cz = world.z;
    drawNow();
  }

  function onContextMenu(ev) {
    ev.preventDefault();
    if (tool !== 'select') actions.setMapTool('select');
  }

  // ---------------------------------------------------------------------------
  // follow / frame driver
  // ---------------------------------------------------------------------------
  function updateFollow(dt) {
    if (!follow) return;
    const target = centroidOfLive() || (snap && snap.fleet && snap.fleet.center) || null;
    if (!target || !isNum(target.x) || !isNum(target.z)) return;
    if (!inited) {
      view.cx = target.x;
      view.cz = target.z;
      inited = true;
      return;
    }
    const k = 1 - Math.exp(-6 * clamp(dt, 0, 0.12));
    view.cx += (target.x - view.cx) * k;
    view.cz += (target.z - view.cz) * k;
  }

  // ---------------------------------------------------------------------------
  // lifecycle
  // ---------------------------------------------------------------------------
  return {
    name: 'map',

    mount(hostEl) {
      host = hostEl;
      host.removeAttribute('hidden');
      tokens = readTokens();
      host.innerHTML = '';
      canvas = h('canvas', { class: 'map-canvas', attrs: { 'aria-label': '二维战术图' } });
      c2d = canvas.getContext('2d', { alpha: false });
      root = h(
        'div',
        { class: 'map-root', attrs: { 'data-map': 'ready' } },
        canvas,
        h(
          'div',
          { class: 'map-chrome' },
          buildTitle(),
          buildHint(),
          buildInstrument(),
          buildLayers(),
          buildToolbar(),
          buildCursor(),
        ),
      );
      host.appendChild(root);

      syncToolUi();
      syncFollowUi();
      syncLayerUi();
      updateZoomUi();

      const canvasEvents = [
        ['pointerdown', onPointerDown],
        ['pointermove', onPointerMove],
        ['pointerup', onPointerUp],
        ['pointercancel', onPointerUp],
        ['pointerleave', onPointerLeave],
        ['dblclick', onDblClick],
        ['contextmenu', onContextMenu],
      ];
      for (const [evt, fn] of canvasEvents) canvas.addEventListener(evt, fn);
      canvas.addEventListener('wheel', onWheel, { passive: false });
      cleanups.push(() => {
        for (const [evt, fn] of canvasEvents) canvas.removeEventListener(evt, fn);
        canvas.removeEventListener('wheel', onWheel);
      });

      cleanups.push(
        bus.on('view', (mode) => {
          if (mode === 'map') {
            ensureSize(true);
            refreshLive();
            if (!inited) snapToFleet();
            updateZoomUi();
            drawNow();
          }
        }),
      );
      cleanups.push(bus.on('select', () => drawNow()));
      cleanups.push(
        bus.on('tool', () => {
          syncToolUi();
          drawNow();
        }),
      );
      cleanups.push(
        bus.on('layers', () => {
          syncLayerUi();
          drawNow();
        }),
      );
      cleanups.push(
        bus.on('mapfollow', () => {
          syncFollowUi();
          if (follow) snapToFleet();
          drawNow();
        }),
      );
      cleanups.push(
        bus.on('mapfocus', (data) => {
          if (!data) return;
          let target = null;
          if (isNum(data.x) && isNum(data.z)) target = { x: data.x, z: data.z };
          else if (data.id) {
            const v = live.find((x) => x.id === data.id);
            if (v) target = { x: v.x, z: v.z };
          }
          if (!target) return;
          if (follow) actions.setMapFollow(false);
          view.cx = target.x;
          view.cz = target.z;
          inited = true;
          drawNow();
        }),
      );

      if (typeof ResizeObserver === 'function') {
        const ro = new ResizeObserver(() => {
          if (ensureSize(true)) drawNow();
        });
        ro.observe(host);
        cleanups.push(() => ro.disconnect());
      }
      const onResize = () => {
        if (ensureSize(true)) drawNow();
      };
      window.addEventListener('resize', onResize);
      cleanups.push(() => window.removeEventListener('resize', onResize));

      // debug hook for the QA harness (read-only chart camera introspection)
      window.__gcsMap = {
        view,
        chart: CHART,
        getZoom: () => view.zoom,
        getCenter: () => ({ x: view.cx, z: view.cz }),
        getSize: () => ({ w: size.w, h: size.h }),
        worldToScreen: (x, z) => worldToScreen(view, size.w, size.h, x, z),
        screenToWorld: (sx, sy) => screenToWorld(view, size.w, size.h, sx, sy),
        getTool: () => tool,
        getFollow: () => follow,
        getLastDrawCost: () => lastDrawCost,
        draw: () => drawNow(),
        setCenter: (x, z) => {
          view.cx = x;
          view.cz = z;
          inited = true;
          drawNow();
        },
        setZoom: (z) => setZoom(z),
      };

      drawNow();
    },

    update(nextSnap) {
      snap = nextSnap || null;
      snapById = new Map();
      if (snap && Array.isArray(snap.vessels)) {
        for (const v of snap.vessels) snapById.set(v.id, v);
      }
      if (snap && !inited && snap.fleet && snap.fleet.center && host && host.clientWidth > 8) {
        snapToFleet();
      }
    },

    frame(dt, nowMs) {
      const now = isNum(nowMs) ? nowMs : performance.now();
      refreshLive();
      recordTrails(now);
      updateFollow(dt);
      if (host && host.clientWidth > 8 && now - lastDraw >= 1000 / CHART.drawHz) {
        ensureSize();
        draw(now);
      }
      updateCursorDom(now);
    },

    resize() {
      if (ensureSize(true)) drawNow();
    },

    destroy() {
      for (const off of cleanups.splice(0)) {
        try {
          off();
        } catch {
          /* noop */
        }
      }
      if (window.__gcsMap) delete window.__gcsMap;
      if (host) host.innerHTML = '';
      root = null;
      canvas = null;
      c2d = null;
    },
  };
}
