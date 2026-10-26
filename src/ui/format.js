// =============================================================================
// Shared display formatters for the GCS. Every module should format numbers
// through this module so units, padding and separators stay consistent.
// All values are defensive: null / NaN / undefined render as '—'.
// =============================================================================

export const DASH = '—';
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
export const num = (v, digits = 1) => (isNum(v) ? v.toFixed(digits) : DASH);
export const int = (v) => (isNum(v) ? String(Math.round(v)) : DASH);
export const pad2 = (v) => String(Math.max(0, Math.round(v))).padStart(2, '0');
export const pad3 = (v) => String(((Math.round(v) % 360) + 360) % 360).padStart(3, '0');

export function kn(v, digits = 1) {
  return isNum(v) ? `${v.toFixed(digits)} kn` : DASH;
}
export function hdg(v) {
  return isNum(v) ? `${pad3(v)}°` : DASH;
}
export function pct(v, digits = 0) {
  return isNum(v) ? `${v.toFixed(digits)}%` : DASH;
}
export function ms(v) {
  return isNum(v) ? `${Math.round(v)} ms` : DASH;
}
export function dbm(v) {
  return isNum(v) ? `${Math.round(v)} dBm` : DASH;
}
export function temp(v) {
  return isNum(v) ? `${v.toFixed(1)} °C` : DASH;
}
export function volt(v) {
  return isNum(v) ? `${v.toFixed(1)} V` : DASH;
}
export function amp(v) {
  return isNum(v) ? `${v.toFixed(1)} A` : DASH;
}
export function kw(v) {
  return isNum(v) ? `${v.toFixed(1)} kW` : DASH;
}
export function deg(v, digits = 1, signed = false) {
  if (!isNum(v)) return DASH;
  const sign = signed && v > 0 ? '+' : '';
  return `${sign}${v.toFixed(digits)}°`;
}
export function mtr(v) {
  return isNum(v) ? `${v.toFixed(1)} m` : DASH;
}
export function dist(meters) {
  if (!isNum(meters)) return DASH;
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(meters < 10000 ? 2 : 1)} km`;
}
export function speedMS2Kn(msValue) {
  return isNum(msValue) ? msValue * 1.943844 : NaN;
}

// --- time --------------------------------------------------------------------
/** hh:mm:ss from seconds (mission elapsed time). */
export function hms(seconds) {
  if (!isNum(seconds)) return DASH;
  const s = Math.max(0, Math.round(seconds));
  return `${pad2(Math.floor(s / 3600))}:${pad2(Math.floor((s % 3600) / 60))}:${pad2(s % 60)}`;
}
/** Compact duration: 00:18:42 -> 18m42s style is avoided; keep HH:MM:SS. */
export const metText = hms;

const utc8 = (tsMs) => new Date(tsMs + 8 * 3600 * 1000);

/**
 * Wall clock for the operator station (explicit UTC+8, independent of the host
 * timezone so headless QA runs are reproducible).
 */
export function clock(tsMs) {
  const d = utc8(tsMs);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}
export function date(tsMs) {
  const d = utc8(tsMs);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}
export function utc(tsMs) {
  const d = new Date(tsMs);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}Z`;
}

// --- geo ---------------------------------------------------------------------
const degToDM = (value, positive, negative) => {
  const hemi = value >= 0 ? positive : negative;
  const abs = Math.abs(value);
  const d = Math.floor(abs);
  const minutes = (abs - d) * 60;
  return `${pad2(d)}°${minutes.toFixed(2).padStart(5, '0')}′${hemi}`;
};
export const lat = (v) => (isNum(v) ? degToDM(v, 'N', 'S') : DASH);
export const lon = (v) => (isNum(v) ? degToDM(v, 'E', 'W') : DASH);
export const latShort = (v) => (isNum(v) ? `${lat(v)}` : DASH);
export const latlon = (la, lo) => `${lat(la)}  ${lon(lo)}`;

const CARDINALS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export function cardinal(v) {
  if (!isNum(v)) return DASH;
  return CARDINALS[Math.round((((v % 360) + 360) % 360) / 22.5) % 16];
}

// --- misc --------------------------------------------------------------------
export function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}
export function signed(v, digits = 1) {
  return deg(v, digits, true);
}
export function clockFromMet(metSec, tsMs) {
  // Used by the mock sim: derive a plausible wall clock from mission elapsed time.
  return clock(tsMs);
}
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}
/** SVG-safe, fixed precision helper for canvas labels. */
export const fixed = (v, digits = 0) => (isNum(v) ? v.toFixed(digits) : '—');
