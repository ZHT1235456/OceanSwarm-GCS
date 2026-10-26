// =============================================================================
// OceanSwarm GCS — central HUD overlay (situation view).
// Owner: ui-map. Contract: docs/GCS-architecture.md §4.1/§4.2/§7,
// visual spec: docs/GCS-design-system.md §7.3.
//
// Layers
//   · view switch (三维态势 / 战术图) + camera presets + camera-mode chip
//   · compass tape (Canvas, own heading = selected vessel else fleet)
//   · renderer readout (fps / draw calls / triangles)
//   · bottom-left: fleet coordinate, heading/speed, live camera scale bar
//   · bottom-right: wind / sea state / visibility
//   · selection lock frame projected from the 3D camera every frame
//     (four corner brackets + heading line + label, edge arrow when off-screen)
//
// All 3D-only elements carry `.hud-3d-only` and are hidden in map view via
// body[data-gcs-view="map"] (set by ctx.actions.setViewMode).
// =============================================================================
import './../styles/hud.css';
import { CAMERA_PRESETS, CAMERA_MODES } from '../../gcs/meta.js';
import { h, setText, setClass } from '../dom.js';

// --- small local helpers -----------------------------------------------------
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const rad = (deg) => (deg * Math.PI) / 180;
const TAU = Math.PI * 2;

/** '#5ff3e4' | 'rgb(...)' -> rgba(r,g,b,alpha). Never throws. */
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
  command: '#8fd6ff',
  fontMono: '"Cascadia Mono","Consolas","SFMono-Regular",monospace',
  fontEn: '"Bahnschrift","Segoe UI",sans-serif',
  fontCn: '"Microsoft YaHei UI","Microsoft YaHei",sans-serif',
};

/** Read the design tokens once so Canvas work matches the DOM palette. */
function readTokens() {
  const out = { ...FALLBACK_TOKENS };
  try {
    const cs = getComputedStyle(document.documentElement);
    const read = (name) => cs.getPropertyValue(name).trim();
    const colorVars = ['accent', 'accent2', 'line', 'lineStrong', 'text', 'text2', 'text3', 'warn', 'danger', 'ok', 'gold', 'command'];
    const cssNames = {
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
      command: '--gcs-command',
    };
    for (const key of colorVars) {
      const v = read(cssNames[key]);
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
    /* headless / no CSS: fall back to the literal palette */
  }
  return out;
}

// =============================================================================
// Panel factory
// =============================================================================
export function createHudPanel(ctx) {
  const { actions, bus, state, format } = ctx;
  const icons = ctx.icons || { icon: () => '', glyph: () => '' };
  const Q = ctx.meta?.CAMERA_PRESETS ? ctx.meta : { CAMERA_PRESETS, CAMERA_MODES };

  let host = null;
  let root = null;
  const els = {};
  const cleanups = [];
  let tokens = FALLBACK_TOKENS;

  let snap = null;
  let liveById = new Map();
  let fleetCenter = null; // {x,z,lat,lon}

  let viewMode = state.viewMode === 'map' ? 'map' : '3d';
  let cameraMode = state.cameraMode || 'fleet';
  let presetActive = null;

  let lockCanvas = null;
  let lockCtx = null;
  let lockW = 0;
  let lockH = 0;
  let lockDpr = 1;
  let hudRect = { left: 0, top: 0, width: 0, height: 0 };
  let rectStamp = -1e9;

  let compassCanvas = null;
  let compassCtx = null;
  let compassW = 380;
  let compassDpr = 1;

  let scaleInfo = { visible: false, label: '—', px: 0 };

  const timers = { stats: -1e9, env: -1e9, coords: -1e9, scale: -1e9, rect: -1e9 };
  let lastCompassHeading = -1;
  let lastCompassAt = -1e9;

  // ---------------------------------------------------------------------------
  // projection helpers
  // ---------------------------------------------------------------------------
  function safeProject(x, y, z) {
    const project = ctx.scene3d && ctx.scene3d.project;
    if (typeof project !== 'function') return null;
    try {
      const p = project(x, y, z);
      if (!p || !isNum(p.x) || !isNum(p.y)) return null;
      return p;
    } catch {
      return null;
    }
  }

  /** Refresh the cached #gcs-hud client rect (window CSS px coordinates). */
  function refreshRect(force = false) {
    const now = performance.now();
    if (!force && now - timers.rect < 400 && rectStamp > 0) return;
    timers.rect = now;
    if (!host) return;
    const r = host.getBoundingClientRect();
    hudRect = { left: r.left, top: r.top, width: r.width, height: r.height };
    rectStamp = now;
  }

  function headingDeg() {
    const id = state.selectedId;
    if (id) {
      const lv = liveById.get(id);
      if (lv && isNum(lv.headingDeg)) return lv.headingDeg;
      if (lv && isNum(lv.yawDeg)) return lv.yawDeg;
    }
    if (snap && snap.fleet && isNum(snap.fleet.headingDeg)) return snap.fleet.headingDeg;
    return 0;
  }

  // ---------------------------------------------------------------------------
  // DOM construction
  // ---------------------------------------------------------------------------
  function buildTopLeft() {
    const viewSeg = h('div', { class: 'gcs-seg hud-viewseg hud-interactive', attrs: { role: 'group', 'aria-label': '中央视区切换' } });
    for (const item of [
      { mode: '3d', label: '三维态势', icon: 'globe' },
      { mode: 'map', label: '战术图', icon: 'map' },
    ]) {
      const btn = h('button', {
        class: 'gcs-seg-item',
        attrs: { type: 'button', 'data-view': item.mode, title: item.mode === '3d' ? '三维海域态势（M）' : '二维战术图（M）' },
        html: `${icons.icon(item.icon, 12)}<span>${item.label}</span>`,
        on: { click: () => actions.setViewMode(item.mode) },
      });
      viewSeg.appendChild(btn);
    }

    const presets = h('div', { class: 'hud-presets hud-interactive hud-3d-only' });
    for (const preset of Q.CAMERA_PRESETS || CAMERA_PRESETS) {
      const btn = h('button', {
        class: 'hud-preset',
        text: preset.name,
        attrs: { type: 'button', 'data-preset': preset.key, title: `${preset.name} ${preset.en} · 视角预设` },
        on: {
          click: () => {
            presetActive = preset.key;
            actions.applyCameraPreset(preset.key);
            syncPresetUi();
          },
        },
      });
      presets.appendChild(btn);
    }

    const camChip = h('button', {
      class: 'gcs-chip hud-camchip',
      attrs: { type: 'button', id: 'hud-camera-mode' },
      on: {
        click: () => {
          // cycle fleet -> lock (needs selection) -> free -> fleet
          const order = ['fleet', 'lock', 'free'];
          let next = 'fleet';
          if (cameraMode === 'fleet') next = state.selectedId ? 'lock' : 'free';
          else if (cameraMode === 'lock') next = 'free';
          else next = 'fleet';
          if (next === 'lock') actions.focusSelected();
          else actions.setCameraMode(next);
        },
      },
    });
    camChip.append(h('span', { class: 'gcs-dot hud-camdot' }));
    camChip.append(h('span', { class: 'hud-camtext' }));
    camChip.append(h('span', { class: 'hud-camcyc', html: icons.icon('swap', 10) }));
    const camRow = h('div', { class: 'hud-camrow hud-3d-only' }, camChip);

    const wrap = h('div', { class: 'hud-topleft' }, viewSeg, presets, camRow);
    els.viewSeg = viewSeg;
    els.presets = presets;
    els.camChip = camChip;
    els.camText = camChip.querySelector('.hud-camtext');
    els.camDot = camChip.querySelector('.hud-camdot');
    return wrap;
  }

  function buildCompass() {
    compassCanvas = h('canvas', { class: 'hud-compass-canvas', attrs: { 'aria-hidden': 'true' } });
    compassCtx = compassCanvas.getContext('2d');
    const tape = h('div', { class: 'hud-compass-tape' }, compassCanvas);
    const wrap = h('div', { class: 'hud-compass hud-3d-only' }, tape);
    els.compass = wrap;
    return wrap;
  }

  function buildStats() {
    const row = h('div', { class: 'hud-stats hud-3d-only' });
    const mk = (key, label) => {
      const item = h('span', { class: 'hud-stat' });
      const k = h('span', { class: 'hud-stat-k', text: label });
      const v = h('span', { class: `hud-stat-v hud-${key}`, text: '—' });
      item.append(k, v);
      return { item, v };
    };
    const fps = mk('fps', 'FPS');
    const dc = mk('dc', 'DRAW');
    const tri = mk('tri', 'TRI');
    const sep1 = h('span', { class: 'hud-stat-sep', text: '·' });
    const sep2 = h('span', { class: 'hud-stat-sep', text: '·' });
    row.append(fps.item, sep1, dc.item, sep2, tri.item);
    els.stats = row;
    els.fps = fps.v;
    els.dc = dc.v;
    els.tri = tri.v;
    return row;
  }

  function buildBottomLeft() {
    const coord = h('div', { class: 'hud-coord' });
    const latVal = h('span', { class: 'hud-coord-v hud-lat', text: '—' });
    const lonVal = h('span', { class: 'hud-coord-v hud-lon', text: '—' });
    coord.append(latVal, h('span', { class: 'hud-coord-sep', text: ' ' }), lonVal);

    const motion = h('div', { class: 'hud-motion' });
    const hdgV = h('span', { class: 'hud-motion-v hud-hdg', text: '—' });
    const sogV = h('span', { class: 'hud-motion-v hud-sog', text: '—' });
    motion.append(
      h('span', { class: 'hud-motion-k', text: '航向' }),
      hdgV,
      h('span', { class: 'hud-motion-sep', text: '·' }),
      h('span', { class: 'hud-motion-k', text: '航速' }),
      sogV,
      h('span', { class: 'hud-motion-u', text: 'kn' }),
    );

    const scaleBar = h('div', { class: 'hud-scale-bar' });
    const scaleLabel = h('span', { class: 'hud-scale-label', text: '—' });
    const scale = h('div', { class: 'hud-scale hud-scale--hidden' }, scaleBar, scaleLabel);
    els.scale = scale;
    els.scaleBar = scaleBar;
    els.scaleLabel = scaleLabel;

    const plate = h('div', { class: 'hud-plate' }, coord, motion, scale);
    const wrap = h('div', { class: 'hud-bottom-left hud-3d-only' }, plate);
    els.coord = coord;
    els.lat = latVal;
    els.lon = lonVal;
    els.hdg = hdgV;
    els.sog = sogV;
    return wrap;
  }

  function buildBottomRight() {
    const arrow = h('div', {
      class: 'hud-wind-arrow',
      html: `<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="10" stroke-opacity=".28"/>
        <path d="M12 5.4 V18.6 M8.2 8.6 L12 4.8 L15.8 8.6" stroke-width="1.7"/>
        <path d="M12 18.6 L9.4 15.4 M12 18.6 L14.6 15.4" stroke-opacity=".5"/>
      </svg>`,
    });
    const windLine = h('div', { class: 'hud-env-line' });
    const windVal = h('span', { class: 'hud-env-v hud-wind', text: '—' });
    const waveLine = h('div', { class: 'hud-env-line hud-env-line--sub' });
    const waveVal = h('span', { class: 'hud-env-v hud-wave', text: '—' });
    windLine.append(h('span', { class: 'hud-env-k', html: icons.icon('wind', 10) }), windVal);
    waveLine.append(h('span', { class: 'hud-env-k', html: icons.icon('wave', 10) }), waveVal);

    const seaState = h('span', { class: 'gcs-chip hud-seachip hud-sea', text: '海况 —' });
    const head = h('div', { class: 'hud-env-head' }, h('span', { class: 'hud-env-title', text: '环境' }), h('span', { class: 'hud-env-en', text: 'ENVIRONMENT' }), seaState);
    const body = h('div', { class: 'hud-env-body' }, arrow, h('div', { class: 'hud-env-lines' }, windLine, waveLine));
    const plate = h('div', { class: 'hud-plate hud-plate--env' }, head, body);
    const wrap = h('div', { class: 'hud-bottom-right hud-3d-only' }, plate);
    els.env = wrap;
    els.windArrow = arrow;
    els.wind = windVal;
    els.wave = waveVal;
    els.sea = seaState;
    return wrap;
  }

  function buildLockCanvas() {
    lockCanvas = h('canvas', { class: 'hud-lock-canvas hud-3d-only', attrs: { 'aria-hidden': 'true' } });
    lockCtx = lockCanvas.getContext('2d');
    return lockCanvas;
  }

  // ---------------------------------------------------------------------------
  // UI state sync
  // ---------------------------------------------------------------------------
  function syncViewUi() {
    viewMode = state.viewMode === 'map' ? 'map' : '3d';
    if (els.viewSeg) {
      for (const btn of els.viewSeg.querySelectorAll('.gcs-seg-item')) {
        setClass(btn, 'is-active', btn.dataset.view === viewMode);
      }
    }
  }

  function syncCameraUi() {
    cameraMode = state.cameraMode || 'fleet';
    const meta = (Q.CAMERA_MODES || CAMERA_MODES)[cameraMode] || CAMERA_MODES.fleet;
    if (els.camText) setText(els.camText, meta.text);
    if (els.camChip) {
      els.camChip.dataset.mode = cameraMode;
      els.camChip.title = `镜头模式：${meta.text} ${meta.en} · 点击切换`;
    }
    if (els.camDot) {
      els.camDot.className = `gcs-dot hud-camdot ${cameraMode === 'lock' ? 'gcs-dot--warn' : cameraMode === 'free' ? 'gcs-dot--offline' : 'gcs-dot--accent'}`;
    }
    if (cameraMode !== 'fleet') presetActive = null;
    syncPresetUi();
  }

  function syncPresetUi() {
    if (!els.presets) return;
    for (const btn of els.presets.querySelectorAll('.hud-preset')) {
      setClass(btn, 'is-active', btn.dataset.preset === presetActive);
    }
  }

  function updateStats() {
    const stats = (() => {
      try {
        return ctx.getRenderStats ? ctx.getRenderStats() : null;
      } catch {
        return null;
      }
    })() || (snap && snap.system) || null;
    if (!stats) return;
    if (els.fps) setText(els.fps, format.int(stats.fps));
    if (els.dc) setText(els.dc, format.int(stats.drawCalls));
    if (els.tri) setText(els.tri, fmtTriangles(stats.triangles));
  }

  function fmtTriangles(v) {
    if (!isNum(v)) return '—';
    if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
    if (v >= 1e3) return `${(v / 1e3).toFixed(0)}k`;
    return String(Math.round(v));
  }

  function updateCoords() {
    const fleet = snap && snap.fleet;
    if (!fleet) return;
    const c = fleet.center || {};
    if (els.lat) setText(els.lat, format.lat(c.lat));
    if (els.lon) setText(els.lon, format.lon(c.lon));
    if (els.hdg) setText(els.hdg, format.hdg(fleet.headingDeg));
    if (els.sog) setText(els.sog, format.num(fleet.speedKn, 1));
    fleetCenter = isNum(c.x) && isNum(c.z) ? { x: c.x, z: c.z, lat: c.lat, lon: c.lon } : null;
  }

  function updateEnv() {
    const sea = (snap && snap.fleet && snap.fleet.sea) || null;
    if (!sea) return;
    const windDeg = isNum(sea.windDirDeg) ? sea.windDirDeg : null;
    if (els.windArrow && windDeg != null) {
      // meteorological "from" direction: arrow points downwind
      els.windArrow.style.transform = `rotate(${windDeg + 180}deg)`;
      els.windArrow.title = `风向 ${format.hdg(windDeg)} · 风速 ${format.num(sea.windKn, 0)} kn`;
    }
    if (els.wind) {
      const cardinal = windDeg != null ? format.cardinal(windDeg) : '—';
      setText(els.wind, `${cardinal} ${windDeg != null ? format.hdg(windDeg) : '—'} · ${format.num(sea.windKn, 0)} kn`);
    }
    if (els.wave) {
      const vis = isNum(sea.visibilityKm) ? `${format.num(sea.visibilityKm, 1)} km` : '—';
      setText(els.wave, `浪 ${format.num(sea.waveHeightM, 1)} m · 能见度 ${vis}`);
    }
    if (els.sea) setText(els.sea, `海况 ${format.int(sea.state)}`);
  }

  // ---------------------------------------------------------------------------
  // Canvas sizing
  // ---------------------------------------------------------------------------
  function ensureCanvasSizes() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    refreshRect();
    // lock canvas fills the HUD host
    if (lockCanvas && hudRect.width > 0 && hudRect.height > 0) {
      const w = Math.round(hudRect.width);
      const hgt = Math.round(hudRect.height);
      if (lockW !== w || lockH !== hgt || lockDpr !== dpr) {
        lockW = w;
        lockH = hgt;
        lockDpr = dpr;
        lockCanvas.width = Math.max(1, Math.round(w * dpr));
        lockCanvas.height = Math.max(1, Math.round(hgt * dpr));
        lockCanvas.style.width = `${w}px`;
        lockCanvas.style.height = `${hgt}px`;
      }
    }
    // compass tape width comes from CSS (responsive)
    if (compassCanvas) {
      const cssW = Math.round(compassCanvas.clientWidth || 380);
      if (compassW !== cssW || compassDpr !== dpr) {
        compassW = cssW || 380;
        compassDpr = dpr;
        compassCanvas.width = Math.max(1, Math.round(compassW * dpr));
        compassCanvas.height = Math.max(1, Math.round(36 * dpr));
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Compass tape
  // ---------------------------------------------------------------------------
  function drawCompass(now) {
    if (!compassCtx || viewMode !== '3d') return;
    const heading = ((headingDeg() % 360) + 360) % 360;
    if (Math.abs(heading - lastCompassHeading) < 0.02 && now - lastCompassAt < 250) return;
    lastCompassHeading = heading;
    lastCompassAt = now;

    const w = compassW;
    const hgt = 36;
    const c = compassCtx;
    c.setTransform(compassDpr, 0, 0, compassDpr, 0, 0);
    c.clearRect(0, 0, w, hgt);

    // baseline
    const baseY = hgt - 6.5;
    c.strokeStyle = withAlpha(tokens.lineStrong, 0.55);
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(0, baseY);
    c.lineTo(w, baseY);
    c.stroke();

    const span = 100; // degrees visible across the tape
    const pxPerDeg = w / span;
    const start = Math.floor((heading - span / 2) / 5) * 5;
    c.textAlign = 'center';
    c.textBaseline = 'alphabetic';
    for (let d = start; d <= heading + span / 2 + 5; d += 5) {
      const x = w / 2 + (d - heading) * pxPerDeg;
      if (x < -12 || x > w + 12) continue;
      const norm = ((d % 360) + 360) % 360;
      const isMajor = norm % 30 === 0;
      const isMid = norm % 15 === 0;
      const len = isMajor ? 9 : isMid ? 6 : 3.5;
      c.strokeStyle = isMajor
        ? withAlpha(tokens.accent2, 0.55)
        : isMid
          ? withAlpha(tokens.accent2, 0.34)
          : withAlpha(tokens.accent2, 0.2);
      c.beginPath();
      c.moveTo(Math.round(x) + 0.5, baseY);
      c.lineTo(Math.round(x) + 0.5, baseY - len);
      c.stroke();
      if (isMajor) {
        const label = norm === 0 ? 'N' : norm === 90 ? 'E' : norm === 180 ? 'S' : norm === 270 ? 'W' : String(norm).padStart(3, '0');
        c.font = `500 8.5px ${tokens.fontMono}`;
        c.fillStyle = norm % 90 === 0 ? withAlpha(tokens.accent, 0.85) : withAlpha(tokens.text3, 0.95);
        c.fillText(label, x, baseY - len - 3.5);
      }
    }

    // fixed centre index (triangle) + vertical hairline
    const cx = w / 2;
    c.strokeStyle = withAlpha(tokens.accent, 0.5);
    c.beginPath();
    c.moveTo(cx, 8);
    c.lineTo(cx, baseY);
    c.stroke();
    c.fillStyle = tokens.accent;
    c.beginPath();
    c.moveTo(cx - 4.5, 1);
    c.lineTo(cx + 4.5, 1);
    c.lineTo(cx, 7);
    c.closePath();
    c.fill();

    // current heading readout plate
    const txt = `${String(Math.round(heading) % 360).padStart(3, '0')}°`;
    c.font = `600 10px ${tokens.fontMono}`;
    const tw = c.measureText(txt).width;
    const plateW = tw + 14;
    const plateX = cx - plateW / 2;
    const plateY = hgt - 20;
    c.fillStyle = 'rgba(2,11,18,.82)';
    c.fillRect(plateX, plateY, plateW, 13);
    c.strokeStyle = withAlpha(tokens.accent, 0.34);
    c.strokeRect(plateX + 0.5, plateY + 0.5, plateW - 1, 12);
    c.fillStyle = tokens.accent;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(txt, cx, plateY + 6.8);
  }

  // ---------------------------------------------------------------------------
  // Selection lock frame
  // ---------------------------------------------------------------------------
  function selectedInfo() {
    if (!snap || !state.selectedId) return null;
    const list = snap.vessels || [];
    for (const v of list) if (v.id === state.selectedId) return v;
    return null;
  }

  function drawLock(now) {
    if (!lockCtx) return;
    const c = lockCtx;
    c.setTransform(lockDpr, 0, 0, lockDpr, 0, 0);
    c.clearRect(0, 0, lockW, lockH);
    if (viewMode !== '3d' || lockW < 60 || lockH < 60) return;
    const id = state.selectedId;
    if (!id) return;
    const lv = liveById.get(id);
    if (!lv || !isNum(lv.x) || !isNum(lv.z)) return;
    const proj = safeProject(lv.x, 0, lv.z);
    if (!proj) return;

    refreshRect();
    const sx = proj.x - hudRect.left;
    const sy = proj.y - hudRect.top;
    const margin = 16;
    const onScreen = proj.visible !== false && sx > margin && sx < lockW - margin && sy > margin && sy < lockH - margin;
    const info = selectedInfo() || snapVesselFallback(id);

    if (!onScreen) {
      drawOffscreenCue(c, lv, proj, info, now);
      return;
    }

    // apparent scale: project a 12 m vertical probe so the bracket tracks distance
    const top = safeProject(lv.x, 12, lv.z);
    const probePx = top ? Math.hypot(top.x - proj.x, top.y - proj.y) : 6;
    const size = clamp(26 + (probePx - 7) * 1.8, 22, 72);
    const half = size / 2;
    const hdg = isNum(lv.headingDeg) ? lv.headingDeg : isNum(lv.yawDeg) ? lv.yawDeg : 0;

    // heading line (world-projected so it stays consistent with the camera):
    // run a 20 m probe along the bow and clamp the drawn length to the bracket.
    const dir = safeProject(lv.x + Math.sin(rad(hdg)) * 20, 0, lv.z - Math.cos(rad(hdg)) * 20);
    if (dir) {
      let dx = dir.x - hudRect.left - sx;
      let dy = dir.y - hudRect.top - sy;
      const rawLen = Math.hypot(dx, dy);
      if (rawLen > 1e-3) {
        const drawLen = clamp(rawLen, half + 5, half + 16);
        dx *= drawLen / rawLen;
        dy *= drawLen / rawLen;
      }
      const len = Math.hypot(dx, dy);
      if (len > 4) {
        c.strokeStyle = withAlpha(tokens.accent, 0.9);
        c.lineWidth = 1.4;
        c.beginPath();
        c.moveTo(sx + (dx / len) * half, sy + (dy / len) * half);
        c.lineTo(sx + dx, sy + dy);
        c.stroke();
        // small arrowhead
        const ang = Math.atan2(dy, dx);
        c.beginPath();
        c.moveTo(sx + dx, sy + dy);
        c.lineTo(sx + dx - Math.cos(ang - 0.42) * 5.5, sy + dy - Math.sin(ang - 0.42) * 5.5);
        c.moveTo(sx + dx, sy + dy);
        c.lineTo(sx + dx - Math.cos(ang + 0.42) * 5.5, sy + dy - Math.sin(ang + 0.42) * 5.5);
        c.stroke();
      }
    }

    // four corner brackets
    const arm = Math.max(7, size * 0.34);
    c.save();
    c.strokeStyle = withAlpha(tokens.accent, 0.92);
    c.lineWidth = 1.5;
    c.shadowColor = withAlpha(tokens.accent, 0.55);
    c.shadowBlur = 7;
    c.beginPath();
    for (const xs of [-1, 1]) {
      for (const ys of [-1, 1]) {
        const x = sx + xs * half;
        const y = sy + ys * half;
        c.moveTo(x, y - ys * arm);
        c.lineTo(x, y);
        c.lineTo(x - xs * arm, y);
      }
    }
    c.stroke();
    c.restore();

    // tiny centre reticle
    c.strokeStyle = withAlpha(tokens.accent, 0.45);
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(sx - 3, sy);
    c.lineTo(sx + 3, sy);
    c.moveTo(sx, sy - 3);
    c.lineTo(sx, sy + 3);
    c.stroke();

    // label
    const showLabel = probePx > 1.6 && size < 66;
    if (showLabel) {
      const callsign = (info && info.callSign) || id.toUpperCase();
      const name = (info && info.name) || '';
      const sog = info && isNum(info.sogKn) ? info.sogKn : isNum(lv.sogKn) ? lv.sogKn : null;
      const line1 = [callsign, name].filter(Boolean).join(' ');
      const sogTxt = sog != null ? ` · ${format.num(sog, 1)} kn` : '';
      drawLockLabel(c, sx, sy - half - 12, line1, sogTxt, size);
    }
  }

  function snapVesselFallback(id) {
    if (!snap || !snap.vessels) return null;
    return snap.vessels.find((v) => v.id === id) || null;
  }

  function drawLockLabel(c, x, y, text, suffix, size) {
    const fontA = `600 10px ${tokens.fontMono}`;
    const fontB = `400 9px ${tokens.fontMono}`;
    c.font = fontA;
    const wA = c.measureText(text).width;
    c.font = fontB;
    const wB = c.measureText(suffix).width;
    const padX = 7;
    const w = wA + wB + padX * 2;
    const hgt = 17;
    let bx = clamp(x - w / 2, 6, lockW - w - 6);
    let by = clamp(y - hgt, 4, lockH - hgt - 4);
    // glass plate
    c.fillStyle = 'rgba(2,11,18,.78)';
    c.fillRect(bx, by, w, hgt);
    c.strokeStyle = withAlpha(tokens.accent, 0.4);
    c.lineWidth = 1;
    c.strokeRect(bx + 0.5, by + 0.5, w - 1, hgt - 1);
    // accent tick on the left edge
    c.fillStyle = withAlpha(tokens.accent, 0.9);
    c.fillRect(bx, by, 2, hgt);
    // leader to the frame
    c.strokeStyle = withAlpha(tokens.accent, 0.38);
    c.beginPath();
    const leadY = by + hgt;
    c.moveTo(clamp(x, bx + 6, bx + w - 6), leadY);
    c.lineTo(clamp(x, bx + 6, bx + w - 6), y + 2);
    c.stroke();

    c.textBaseline = 'middle';
    c.textAlign = 'left';
    c.font = fontA;
    c.fillStyle = tokens.accent;
    c.fillText(text, bx + padX, by + hgt / 2 + 0.5);
    c.font = fontB;
    c.fillStyle = withAlpha(tokens.text2, 0.95);
    c.fillText(suffix, bx + padX + wA, by + hgt / 2 + 0.5);
  }

  function drawOffscreenCue(c, lv, proj, info, now) {
    const cx = lockW / 2;
    const cy = lockH / 2;
    let dx = 0;
    let dy = -1;
    if (proj) {
      dx = proj.x - hudRect.left - cx;
      dy = proj.y - hudRect.top - cy;
    }
    const mag = Math.hypot(dx, dy);
    if (!(mag > 1)) {
      const hdg = isNum(lv.headingDeg) ? lv.headingDeg : 0;
      dx = Math.sin(rad(hdg));
      dy = -Math.cos(rad(hdg));
    }
    const margin = 34;
    const limX = cx - margin;
    const limY = cy - margin;
    const ratioX = Math.abs(dx) > 0.001 ? limX / Math.abs(dx) : Infinity;
    const ratioY = Math.abs(dy) > 0.001 ? limY / Math.abs(dy) : Infinity;
    const r = Math.min(1, ratioX, ratioY);
    const ex = cx + dx * r;
    const ey = cy + dy * r;
    const ang = Math.atan2(dy, dx);
    const pulse = 0.72 + 0.28 * Math.sin(now / 240);

    // edge arrow
    c.save();
    c.translate(ex, ey);
    c.rotate(ang);
    c.fillStyle = withAlpha(tokens.accent, 0.95 * pulse);
    c.beginPath();
    c.moveTo(11, 0);
    c.lineTo(-6, -7.5);
    c.lineTo(-2.5, 0);
    c.lineTo(-6, 7.5);
    c.closePath();
    c.fill();
    c.restore();

    // distance readout
    const callsign = (info && info.callSign) || String(state.selectedId || '').toUpperCase();
    let distM = info && isNum(info.distToFleetM) ? info.distToFleetM : null;
    if (distM == null && fleetCenter && isNum(lv.x)) {
      distM = Math.hypot(lv.x - fleetCenter.x, lv.z - fleetCenter.z);
    }
    const text = `${callsign} · ${distM != null ? format.dist(distM) : '视区外'}`;
    c.font = `500 9.5px ${tokens.fontMono}`;
    const tw = c.measureText(text).width;
    const padX = 6;
    const w = tw + padX * 2;
    const hgt = 15;
    const bx = clamp(ex - dx * 16 - w / 2, 6, lockW - w - 6);
    const by = clamp(ey - dy * 14 - hgt / 2, 4, lockH - hgt - 4);
    c.fillStyle = 'rgba(2,11,18,.74)';
    c.fillRect(bx, by, w, hgt);
    c.strokeStyle = withAlpha(tokens.accent, 0.36);
    c.lineWidth = 1;
    c.strokeRect(bx + 0.5, by + 0.5, w - 1, hgt - 1);
    c.fillStyle = tokens.accent;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(text, bx + w / 2, by + hgt / 2 + 0.5);
  }

  // ---------------------------------------------------------------------------
  // Dynamic scale bar — pixels per metre straight from the live camera
  // ---------------------------------------------------------------------------
  function updateScale(now) {
    const scale = els.scale;
    if (!scale) return;
    const proj = ctx.scene3d && ctx.scene3d.project;
    const center = (snap && snap.fleet && snap.fleet.center) || (liveById.size ? centroidOfLive() : null);
    if (viewMode !== '3d' || typeof proj !== 'function' || !center || !isNum(center.x)) {
      if (!scale.classList.contains('hud-scale--hidden')) {
        scale.classList.add('hud-scale--hidden');
        scaleInfo = { visible: false, label: '—', px: 0 };
      }
      return;
    }
    if (now - timers.scale < 200) return;
    timers.scale = now;

    let pxPerM = 0;
    const a = safeProject(center.x - 50, 0, center.z);
    const b = safeProject(center.x + 50, 0, center.z);
    if (a && b && a.visible !== false && b.visible !== false) {
      pxPerM = Math.abs(b.x - a.x) / 100;
    }
    if (!(pxPerM > 0.0005)) {
      // fallback: apparent size of a 12 m vertical probe at the fleet centre
      const p0 = safeProject(center.x, 0, center.z);
      const p1 = safeProject(center.x, 12, center.z);
      if (p0 && p1) pxPerM = Math.hypot(p1.x - p0.x, p1.y - p0.y) / 12;
    }
    if (!(pxPerM > 0.0005)) {
      scale.classList.add('hud-scale--hidden');
      scaleInfo = { visible: false, label: '—', px: 0 };
      return;
    }

    const nice = [10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000, 20000];
    let pick = nice[0];
    let pickPx = pick * pxPerM;
    for (const n of nice) {
      const px = n * pxPerM;
      if (px >= 56 && px <= 132) {
        pick = n;
        pickPx = px;
        break;
      }
      if (px < 56) {
        pick = n;
        pickPx = px;
      }
    }
    const label = pick >= 1000 ? `${(pick / 1000).toFixed(pick >= 10000 ? 0 : 1)} km` : `${pick} m`;
    const px = clamp(pickPx, 26, 150);
    if (!scaleInfo.visible || scaleInfo.label !== label || Math.abs(scaleInfo.px - px) > 0.6) {
      scaleInfo = { visible: true, label, px };
      scale.classList.remove('hud-scale--hidden');
      if (els.scaleBar) els.scaleBar.style.width = `${px.toFixed(1)}px`;
      if (els.scaleLabel) setText(els.scaleLabel, label);
    }
  }

  function centroidOfLive() {
    let sx = 0;
    let sz = 0;
    let n = 0;
    for (const v of liveById.values()) {
      if (!isNum(v.x) || !isNum(v.z)) continue;
      sx += v.x;
      sz += v.z;
      n += 1;
    }
    return n ? { x: sx / n, z: sz / n } : null;
  }

  // ---------------------------------------------------------------------------
  // Frame driver
  // ---------------------------------------------------------------------------
  function refreshLive() {
    let list = [];
    try {
      list = ctx.getLiveVessels() || [];
    } catch {
      list = [];
    }
    liveById = new Map();
    for (const v of list) {
      if (v && v.id) liveById.set(v.id, v);
    }
  }

  function drawFrame(now) {
    ensureCanvasSizes();
    drawCompass(now);
    drawLock(now);
  }

  function drawNow() {
    if (!host) return;
    refreshLive();
    drawFrame(performance.now());
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------
  return {
    name: 'hud',

    mount(hostEl) {
      host = hostEl;
      tokens = readTokens();
      host.innerHTML = '';
      root = h(
        'div',
        { class: 'hud-root', attrs: { 'data-hud': 'ready' } },
        buildTopLeft(),
        buildCompass(),
        buildStats(),
        buildBottomLeft(),
        buildBottomRight(),
        buildLockCanvas(),
      );
      host.appendChild(root);

      syncViewUi();
      syncCameraUi();

      cleanups.push(
        bus.on('view', (mode) => {
          viewMode = mode === 'map' ? 'map' : '3d';
          syncViewUi();
          if (viewMode === '3d') {
            lastCompassAt = -1e9;
            drawNow();
          } else if (lockCtx) {
            lockCtx.setTransform(1, 0, 0, 1, 0, 0);
            lockCtx.clearRect(0, 0, lockCanvas.width, lockCanvas.height);
          }
        }),
      );
      cleanups.push(
        bus.on('camera', () => {
          syncCameraUi();
        }),
      );
      cleanups.push(
        bus.on('select', () => {
          drawNow();
        }),
      );
      cleanups.push(
        bus.on('clean', () => {
          lastCompassAt = -1e9;
          drawNow();
        }),
      );

      if (typeof ResizeObserver === 'function') {
        const ro = new ResizeObserver(() => {
          ensureCanvasSizes();
          lastCompassAt = -1e9;
          drawNow();
        });
        ro.observe(host);
        cleanups.push(() => ro.disconnect());
      }
      const onWinResize = () => {
        refreshRect(true);
        ensureCanvasSizes();
        lastCompassAt = -1e9;
        drawNow();
      };
      window.addEventListener('resize', onWinResize);
      cleanups.push(() => window.removeEventListener('resize', onWinResize));

      // initial paint (scene3d is ready before panels mount per integration)
      requestAnimationFrame(() => drawNow());
    },

    update(nextSnap) {
      snap = nextSnap || null;
      if (!snap) return;
      const now = performance.now();
      if (now - timers.coords > 100) {
        timers.coords = now;
        updateCoords();
      }
      if (now - timers.env > 100) {
        timers.env = now;
        updateEnv();
      }
      if (now - timers.stats > 250) {
        timers.stats = now;
        updateStats();
      }
      syncCameraUi();
      syncViewUi();
      syncPresetUi();
    },

    frame(dt, nowMs) {
      const now = isNum(nowMs) ? nowMs : performance.now();
      refreshLive();
      updateStats();
      updateScale(now);
      updateCoords();
      updateEnv();
      drawFrame(now);
    },

    resize() {
      refreshRect(true);
      ensureCanvasSizes();
      lastCompassAt = -1e9;
      drawNow();
    },

    destroy() {
      for (const off of cleanups.splice(0)) {
        try {
          off();
        } catch {
          /* noop */
        }
      }
      if (host) host.innerHTML = '';
      root = null;
      lockCtx = null;
      compassCtx = null;
    },
  };
}
