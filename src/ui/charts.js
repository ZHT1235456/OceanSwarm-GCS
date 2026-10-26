// =============================================================================
// OceanSwarm GCS — Canvas2D chart kit (right-rail instruments + reusable by other
// panels). Zero dependencies, zero state, no DOM ownership: every function takes
// a <canvas>, sizes its backing store for the current devicePixelRatio and draws
// in CSS-pixel coordinates.
//
// Design contract (docs/GCS-design-system.md §2/§3/§7.5):
//   • hairline technical-drawing look: 1px rules, ticks, tabular numbers;
//   • colours always come from tokens (cssVar) or from an explicit `color` opt;
//   • totally defensive: null / NaN / undefined inputs render a neutral state,
//     never "NaN" text and never a thrown error;
//   • callers are expected to re-invoke on every snapshot (10 Hz) / resize; the
//     helpers are cheap (fitCanvas reuses the backing store when unchanged).
//
// Public API
//   fitCanvas(canvas, cssW?, cssH?)   -> { ctx, w, h, dpr }
//   cssVar(name, fallback?)           -> resolved :root custom property
//   clearCanvas(canvas)               -> wipes a canvas (no DPR change)
//   drawHorizon(canvas, opts)         -> attitude indicator (roll −30…30 / pitch)
//   drawRingGauge(canvas, opts)       -> battery / percentage ring (with ticks)
//   drawSignalBars(canvas, opts)      -> 5-cell data-link strength meter
//   drawAreaLine(canvas, opts)        -> battery-history area line (8 min window)
// =============================================================================

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// --- design tokens -----------------------------------------------------------
const TOKEN_CACHE = new Map();

/** Resolve a CSS custom property once (design tokens are static per page load). */
export function cssVar(name, fallback = '') {
  if (TOKEN_CACHE.has(name)) return TOKEN_CACHE.get(name);
  let value = '';
  try {
    value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  } catch {
    value = '';
  }
  if (!value) value = fallback;
  TOKEN_CACHE.set(name, value);
  return value;
}

/** Forget cached tokens (design owner may hot-swap tokens during polish). */
export function refreshTokens() {
  TOKEN_CACHE.clear();
}

const fontStack = (token, fallback) => cssVar(token, fallback);
const monoFont = (size, weight = 400) =>
  `${weight} ${size}px ${fontStack('--gcs-font-mono', 'Consolas, monospace')}`;
const enFont = (size, weight = 500) =>
  `${weight} ${size}px ${fontStack('--gcs-font-en', 'Segoe UI, sans-serif')}`;

// --- canvas plumbing ---------------------------------------------------------

/**
 * Resize the backing store for devicePixelRatio and return a drawing context in
 * CSS-pixel space. Omitting cssW/cssH measures the element's client box.
 * Returns { ctx, w, h, dpr }; if the element is not laid out yet the size
 * degrades to 1×1 rather than throwing.
 */
export function fitCanvas(canvas, cssW, cssH) {
  if (!canvas || typeof canvas.getContext !== 'function') {
    return { ctx: null, w: 0, h: 0, dpr: 1 };
  }
  const dpr = clamp(window.devicePixelRatio || 1, 1, 3);
  let w = cssW;
  let h = cssH;
  if (!isNum(w) || !isNum(h)) {
    const rect = canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : null;
    if (!isNum(w)) w = rect && rect.width > 0 ? rect.width : canvas.clientWidth;
    if (!isNum(h)) h = rect && rect.height > 0 ? rect.height : canvas.clientHeight;
  }
  w = Math.max(1, Math.round(isNum(w) ? w : 1));
  h = Math.max(1, Math.round(isNum(h) ? h : 1));

  const bw = Math.max(1, Math.round(w * dpr));
  const bh = Math.max(1, Math.round(h * dpr));
  if (canvas.width !== bw) canvas.width = bw;
  if (canvas.height !== bh) canvas.height = bh;

  const ctx = canvas.getContext('2d');
  if (!ctx) return { ctx: null, w, h, dpr };
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h, dpr };
}

/** Wipe a canvas without touching its backing size (cheap between frames). */
export function clearCanvas(canvas) {
  if (!canvas) return;
  const ctx = canvas.getContext && canvas.getContext('2d');
  if (!ctx) return;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.restore();
}

function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}

// =============================================================================
// 1. ATTITUDE — artificial horizon (§7.5 item 3)
//    roll −30…30°, pitch ladder in 10° steps, cyan horizon line, fixed aircraft
//    reticle and fixed roll scale. Sized by CSS (default 132×66).
// =============================================================================
export function drawHorizon(canvas, opts = {}) {
  const { rollDeg = 0, pitchDeg = 0, headingDeg } = opts;
  const { ctx, w, h } = fitCanvas(canvas);
  if (!ctx) return;

  const accent = cssVar('--gcs-accent', '#5ff3e4');
  const ice = cssVar('--gcs-accent-2', '#9fd6e8');
  const text3 = cssVar('--gcs-text-3', 'rgba(188,220,229,.44)');
  const lineFaint = cssVar('--gcs-line-faint', 'rgba(140,224,238,.07)');

  const roll = clamp(isNum(rollDeg) ? rollDeg : 0, -85, 85);
  const pitch = clamp(isNum(pitchDeg) ? pitchDeg : 0, -45, 45);
  const cx = w / 2;
  const cy = h / 2;
  const big = Math.hypot(w, h) * 1.4;
  const ppd = h / 54; // pixels per degree — ±27° fills the instrument height

  ctx.save();
  roundRectPath(ctx, 0.5, 0.5, w - 1, h - 1, 2);
  ctx.clip();

  // --- sky (fixed gradient) -------------------------------------------------
  const sky = ctx.createLinearGradient(0, 0, 0, cy);
  sky.addColorStop(0, cssVar('--gcs-ink-900', '#06202c'));
  sky.addColorStop(1, 'rgba(16, 58, 74, 0.92)');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);

  // --- rotated horizon / sea ------------------------------------------------
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate((-roll * Math.PI) / 180);
  const horizonY = pitch * ppd;

  const sea = ctx.createLinearGradient(0, horizonY, 0, horizonY + big * 0.6);
  sea.addColorStop(0, 'rgba(12, 40, 52, 0.98)');
  sea.addColorStop(1, cssVar('--gcs-ink-1000', '#020b12'));
  ctx.fillStyle = sea;
  ctx.fillRect(-big, horizonY, big * 2, big);

  // pitch ladder (10° steps, ±20° visible)
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(159, 214, 232, 0.34)';
  ctx.fillStyle = text3;
  ctx.font = monoFont(6.5);
  ctx.textBaseline = 'middle';
  for (let deg = -20; deg <= 20; deg += 10) {
    if (deg === 0) continue;
    const y = Math.round(horizonY - deg * ppd) + 0.5;
    const half = deg % 20 === 0 ? w * 0.24 : w * 0.15;
    ctx.beginPath();
    ctx.moveTo(-half - 8, y);
    ctx.lineTo(-8, y);
    ctx.moveTo(8, y);
    ctx.lineTo(half + 8, y);
    ctx.stroke();
    const label = `${deg > 0 ? '+' : '−'}${Math.abs(deg)}`;
    ctx.textAlign = 'right';
    ctx.fillText(label, -half - 10, y);
    ctx.textAlign = 'left';
    ctx.fillText(label, half + 10, y);
  }

  // horizon line — cyan with a restrained glow
  ctx.strokeStyle = accent;
  ctx.globalAlpha = 0.95;
  ctx.lineWidth = 1.2;
  ctx.shadowColor = accent;
  ctx.shadowBlur = 5;
  ctx.beginPath();
  ctx.moveTo(-big, Math.round(horizonY) + 0.5);
  ctx.lineTo(big, Math.round(horizonY) + 0.5);
  ctx.stroke();
  ctx.shadowBlur = 0;

  // small side ticks on the horizon line (drafting detail)
  ctx.globalAlpha = 0.8;
  ctx.strokeStyle = accent;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(-w * 0.30, Math.round(horizonY) + 0.5);
  ctx.lineTo(-w * 0.30, Math.round(horizonY) + 4.5);
  ctx.moveTo(w * 0.30, Math.round(horizonY) + 0.5);
  ctx.lineTo(w * 0.30, Math.round(horizonY) + 4.5);
  ctx.stroke();
  ctx.restore();

  // --- fixed roll scale (ticks stay level while the horizon rotates) --------
  const arcR = Math.min(w, h) * 0.46;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.strokeStyle = 'rgba(159, 214, 232, 0.4)';
  ctx.fillStyle = text3;
  ctx.lineWidth = 1;
  ctx.font = enFont(6, 500);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let deg = -30; deg <= 30; deg += 10) {
    const a = (deg * Math.PI) / 180;
    const major = deg % 20 === 0;
    const r0 = arcR;
    const r1 = arcR - (major ? 4.5 : 3);
    ctx.globalAlpha = deg === 0 ? 0.95 : 0.6;
    ctx.beginPath();
    ctx.moveTo(Math.sin(a) * r0, -Math.cos(a) * r0);
    ctx.lineTo(Math.sin(a) * r1, -Math.cos(a) * r1);
    ctx.stroke();
    if (major) {
      ctx.globalAlpha = 0.55;
      ctx.fillText(String(Math.abs(deg)), Math.sin(a) * (r0 - 9), -Math.cos(a) * (r0 - 9));
    }
  }
  // fixed roll pointer at 12 o'clock
  ctx.globalAlpha = 1;
  ctx.fillStyle = accent;
  ctx.beginPath();
  ctx.moveTo(0, -arcR + 1);
  ctx.lineTo(-3, -arcR + 6);
  ctx.lineTo(3, -arcR + 6);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // --- fixed reticle --------------------------------------------------------
  ctx.strokeStyle = accent;
  ctx.globalAlpha = 0.95;
  ctx.lineWidth = 1.25;
  ctx.beginPath();
  ctx.moveTo(cx - w * 0.20, cy + 0.5);
  ctx.lineTo(cx - 5, cy + 0.5);
  ctx.moveTo(cx + 5, cy + 0.5);
  ctx.lineTo(cx + w * 0.20, cy + 0.5);
  ctx.stroke();
  ctx.fillStyle = accent;
  ctx.beginPath();
  ctx.arc(cx, cy, 1.1, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;

  // --- corner brackets ------------------------------------------------------
  const c = Math.min(6, w * 0.06);
  ctx.strokeStyle = lineFaint;
  ctx.lineWidth = 1;
  for (const [sx, sy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    const x = sx > 0 ? 1.5 : w - 1.5;
    const y = sy > 0 ? 1.5 : h - 1.5;
    ctx.beginPath();
    ctx.moveTo(x + sx * c, y);
    ctx.lineTo(x, y);
    ctx.lineTo(x, y + sy * c);
    ctx.stroke();
  }

  // heading readout, bottom-right (kept tiny: the right column owns the numbers)
  if (isNum(headingDeg)) {
    const hdg = String(((Math.round(headingDeg) % 360) + 360) % 360).padStart(3, '0');
    ctx.fillStyle = text3;
    ctx.font = monoFont(7);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillText(`HDG ${hdg}°`, w - 4, h - 3);
  }
  ctx.restore();

  ctx.save();
  roundRectPath(ctx, 0.5, 0.5, w - 1, h - 1, 2);
  ctx.strokeStyle = cssVar('--gcs-line', 'rgba(140,224,238,.14)');
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();
}

// =============================================================================
// 2. RING GAUGE — battery / percentage (§7.5 item 2)
//    opts: { pct, digits, dangerBelow, warnBelow, color, label }
// =============================================================================
export function drawRingGauge(canvas, opts = {}) {
  const { pct, digits = 0, dangerBelow = 15, warnBelow = 30, color, label } = opts;
  const { ctx, w, h } = fitCanvas(canvas);
  if (!ctx) return { color: cssVar('--gcs-text-3', '#888') };

  const accent = cssVar('--gcs-accent', '#5ff3e4');
  const warn = cssVar('--gcs-warn', '#ffb257');
  const danger = cssVar('--gcs-danger', '#ff5d4a');
  const track = 'rgba(140, 224, 238, 0.13)';
  const text3 = cssVar('--gcs-text-3', 'rgba(188,220,229,.44)');
  const valid = isNum(pct);
  const value = valid ? clamp(pct, 0, 100) : null;
  const tone = !valid ? text3 : value < dangerBelow ? danger : value < warnBelow ? warn : color || accent;

  const cx = w / 2;
  const cy = h / 2;
  const outer = Math.min(w, h) / 2 - 0.75;
  const r = outer - 3.5;

  // tick ring — 36 ticks, every 30° slightly longer
  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(140, 224, 238, 0.32)';
  for (let i = 0; i < 36; i++) {
    const a = (i / 36) * Math.PI * 2 - Math.PI / 2;
    const major = i % 3 === 0;
    const r0 = outer;
    const r1 = outer - (major ? 2.6 : 1.5);
    ctx.globalAlpha = major ? 0.9 : 0.5;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
    ctx.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // track
  ctx.strokeStyle = track;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();

  // progress
  if (value != null && value > 0.4) {
    ctx.strokeStyle = tone;
    ctx.lineWidth = 3;
    ctx.lineCap = 'butt';
    ctx.shadowColor = tone;
    ctx.shadowBlur = 4;
    ctx.beginPath();
    ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + (value / 100) * Math.PI * 2);
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  // centre readout
  const pctText = valid ? `${value.toFixed(digits)}` : '—';
  ctx.fillStyle = valid ? tone : text3;
  ctx.font = enFont(w > 46 ? 13.5 : 11.5, 600);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(pctText, cx, cy + 2.5);
  ctx.fillStyle = text3;
  ctx.font = enFont(6.5, 500);
  ctx.fillText(label || '%', cx, cy + 10);
  ctx.restore();
  return { color: tone, pct: value };
}

// =============================================================================
// 3. SIGNAL BARS — 5-cell link strength (§7.5 item 4)
//    opts: { quality: 0..1, color?, warnBelow, dangerBelow }
// =============================================================================
export function drawSignalBars(canvas, opts = {}) {
  const { quality, color, warnBelow = 0.34, dangerBelow = 0.2 } = opts;
  const { ctx, w, h } = fitCanvas(canvas);
  if (!ctx) return;

  const accent = cssVar('--gcs-accent', '#5ff3e4');
  const warn = cssVar('--gcs-warn', '#ffb257');
  const danger = cssVar('--gcs-danger', '#ff5d4a');
  const track = 'rgba(140, 224, 238, 0.15)';
  const valid = isNum(quality);
  const q = valid ? clamp(quality, 0, 1) : 0;
  const lit = valid ? clamp(Math.round(q * 5), 0, 5) : 0;
  const tone = color || (!valid ? track : q < dangerBelow ? danger : q < warnBelow ? warn : accent);

  const cellGap = 2;
  const barW = Math.max(2, (w - cellGap * 4) / 5);
  const baseY = h - 1.5;
  for (let i = 0; i < 5; i++) {
    const bh = Math.max(2.5, (h - 3) * (0.36 + i * 0.16));
    const x = i * (barW + cellGap);
    const y = baseY - bh;
    const on = i < lit;
    ctx.save();
    if (on) {
      ctx.fillStyle = tone;
      ctx.shadowColor = tone;
      ctx.shadowBlur = i === lit - 1 ? 3 : 0;
    } else {
      ctx.fillStyle = track;
    }
    roundRectPath(ctx, x, y, barW, bh, 0.7);
    ctx.fill();
    ctx.restore();
  }
}

// =============================================================================
// 4. AREA LINE — battery history (§7.5 item 5)
//    opts: {
//      samples: [{ t, v }], minV, maxV, windowSec, nowT,
//      color, threshold, thresholdColor, showAxis, pendingLabel
//    }
//    Returns { spanSec, fromT, toT, points } for the DOM meta label.
// =============================================================================
export function drawAreaLine(canvas, opts = {}) {
  const {
    samples = [],
    minV = 0,
    maxV = 100,
    windowSec = 480,
    nowT,
    color = cssVar('--gcs-accent', '#5ff3e4'),
    threshold = 25,
    thresholdColor = cssVar('--gcs-warn', '#ffb257'),
    showAxis = true,
  } = opts;

  const { ctx, w, h } = fitCanvas(canvas);
  if (!ctx) return { spanSec: 0, points: 0 };

  const text3 = cssVar('--gcs-text-3', 'rgba(188,220,229,.44)');
  const text4 = cssVar('--gcs-text-4', 'rgba(168,204,214,.28)');
  const lineFaint = cssVar('--gcs-line-faint', 'rgba(140,224,238,.07)');
  const line = cssVar('--gcs-line', 'rgba(140,224,238,.14)');

  const padL = showAxis ? 17 : 2;
  const padR = 2;
  const padT = 4;
  const padB = 3;
  const plotW = Math.max(1, w - padL - padR);
  const plotH = Math.max(1, h - padT - padB);
  const spanV = Math.max(1e-6, maxV - minV);
  const yFor = (v) => padT + plotH - ((clamp(isNum(v) ? v : minV, minV, maxV) - minV) / spanV) * plotH;

  const valid = [];
  for (const s of Array.isArray(samples) ? samples : []) {
    if (s && isNum(s.t) && isNum(s.v)) valid.push({ t: s.t, v: clamp(s.v, minV, maxV) });
  }
  valid.sort((a, b) => a.t - b.t);

  const lastKnownT = valid.length ? valid[valid.length - 1].t : 0;
  const t1 = isNum(nowT) ? Math.max(nowT, lastKnownT) : lastKnownT;
  let t0 = t1 - windowSec;
  if (!valid.length) {
    t0 = t1 - Math.max(20, windowSec * 0.25);
  } else {
    const firstT = valid[0].t;
    const cover = t1 - firstT;
    if (cover < windowSec) {
      // history cache still warming up: stretch the observed span to full width,
      // but never pretend it is the full 8 minutes (the DOM label reports the span)
      const display = clamp(cover, Math.max(20, windowSec * 0.06), windowSec);
      t0 = t1 - display;
    }
  }
  const spanT = Math.max(1e-3, t1 - t0);
  const xFor = (t) => padL + ((t - t0) / spanT) * plotW;

  // --- background grid ------------------------------------------------------
  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle = lineFaint;
  ctx.setLineDash([2, 3]);
  for (let i = 1; i < 4; i++) {
    const gy = Math.round(padT + (plotH * i) / 4) + 0.5;
    ctx.beginPath();
    ctx.moveTo(padL, gy);
    ctx.lineTo(w - padR, gy);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // --- warning threshold (e.g. 25% battery) ---------------------------------
  if (isNum(threshold) && threshold > minV && threshold < maxV) {
    const ty = Math.round(yFor(threshold)) + 0.5;
    ctx.strokeStyle = thresholdColor;
    ctx.globalAlpha = 0.42;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(padL, ty);
    ctx.lineTo(w - padR, ty);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  // --- axis labels ----------------------------------------------------------
  if (showAxis) {
    ctx.fillStyle = text4;
    ctx.font = monoFont(6.5);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(Math.round(maxV)), padL - 4, yFor(maxV) + 0.5);
    ctx.fillText(String(Math.round((maxV + minV) / 2)), padL - 4, yFor((maxV + minV) / 2) + 0.5);
    ctx.fillText(String(Math.round(minV)), padL - 4, yFor(minV) - 0.5);
  }
  ctx.restore();

  // --- plot -----------------------------------------------------------------
  ctx.save();
  ctx.beginPath();
  ctx.rect(padL, padT - 1, plotW, plotH + 2);
  ctx.clip();

  const lastV = valid.length ? valid[valid.length - 1].v : null;

  // faint reference while the 8-min cache is still filling
  if (lastV != null && (valid.length < 2 || t1 - valid[0].t < windowSec * 0.6)) {
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.2;
    ctx.lineWidth = 1;
    ctx.setLineDash([1.5, 3]);
    const ry = Math.round(yFor(lastV)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(padL, ry);
    ctx.lineTo(w - padR, ry);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  if (valid.length >= 2) {
    // area fill
    const grad = ctx.createLinearGradient(0, padT, 0, padT + plotH);
    grad.addColorStop(0, color);
    grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.globalAlpha = 0.16;
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(xFor(valid[0].t), padT + plotH);
    for (const s of valid) ctx.lineTo(xFor(s.t), yFor(s.v));
    ctx.lineTo(xFor(valid[valid.length - 1].t), padT + plotH);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1;

    // line
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.35;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(xFor(valid[0].t), yFor(valid[0].v));
    for (let i = 1; i < valid.length; i++) ctx.lineTo(xFor(valid[i].t), yFor(valid[i].v));
    ctx.stroke();
  }

  // current sample marker
  if (lastV != null) {
    const px = xFor(valid[valid.length - 1].t);
    const py = yFor(lastV);
    ctx.fillStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = 5;
    ctx.beginPath();
    ctx.arc(px, py, 1.7, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
  } else {
    // empty state: baseline + hint
    ctx.strokeStyle = text4;
    ctx.globalAlpha = 0.7;
    ctx.setLineDash([2, 3]);
    const by = Math.round(padT + plotH * 0.5) + 0.5;
    ctx.beginPath();
    ctx.moveTo(padL, by);
    ctx.lineTo(w - padR, by);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    ctx.fillStyle = text3;
    ctx.font = monoFont(7);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('等待遥测', padL + plotW / 2, by - 6);
  }
  ctx.restore();

  // --- base rule ------------------------------------------------------------
  ctx.save();
  ctx.strokeStyle = line;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padL, Math.round(padT + plotH) + 0.5);
  ctx.lineTo(w - padR, Math.round(padT + plotH) + 0.5);
  ctx.stroke();
  ctx.restore();

  return {
    spanSec: Math.round(t1 - (valid.length ? valid[0].t : t0)),
    fromT: valid.length ? valid[0].t : t0,
    toT: t1,
    points: valid.length,
  };
}
