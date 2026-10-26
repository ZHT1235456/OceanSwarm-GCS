// =============================================================================
// OceanSwarm GCS — formatting helpers shared by the simulation layer.
//
// The GCS runs offline on a Chinese console, so all wall-clock strings are
// rendered in UTC+8 from a fixed mission date (2026-10-26). Deriving the clock
// from the simulation time keeps the whole UI deterministic: same seed + same
// elapsed time => byte-identical clock strings on any machine / timezone.
// =============================================================================

export const TZ_LABEL = 'UTC+8';
export const TZ_OFFSET_MIN = 8 * 60;

// Wall clock at MET = metOffset (the console opens at 14:32:07 local).
const BASE_UTC_MS = Date.UTC(2026, 9, 26, 6, 32, 7);
const DEFAULT_MET_OFFSET = 720;

export function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return value < min ? min : value > max ? max : value;
}

export function roundTo(value, digits = 0) {
  if (!Number.isFinite(value)) return 0;
  const f = Math.pow(10, digits);
  return Math.round(value * f) / f;
}

export const round1 = (value) => roundTo(value, 1);
export const round2 = (value) => roundTo(value, 2);
export const round3 = (value) => roundTo(value, 3);

/** Coerce anything to a finite number (NaN / undefined / Infinity -> fallback). */
export function safeNumber(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

export function pad2(value) {
  const n = Math.floor(Math.abs(safeNumber(value, 0)));
  return n < 10 ? `0${n}` : String(n);
}

export function pad3(value) {
  const n = Math.floor(Math.abs(safeNumber(value, 0)));
  if (n < 10) return `00${n}`;
  if (n < 100) return `0${n}`;
  return String(n);
}

/** Mission elapsed time -> `HH:MM:SS` (counts past 24 h instead of wrapping). */
export function formatMet(metSec) {
  const total = Math.max(0, Math.floor(safeNumber(metSec, 0)));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h < 100 ? pad2(h) : String(h)}:${pad2(m)}:${pad2(s)}`;
}

/** Small helper: `0.42 s` / `42 ms` for command latency read-outs. */
export function formatLatency(ms) {
  const value = Math.max(0, safeNumber(ms, 0));
  if (value < 1000) return `${Math.round(value)} ms`;
  return `${(value / 1000).toFixed(2)} s`;
}

function toDmPart(absDeg, digits = 2) {
  let deg = Math.floor(absDeg);
  let min = (absDeg - deg) * 60;
  const f = Math.pow(10, digits);
  min = Math.round(min * f) / f;
  if (min >= 60) {
    min -= 60;
    deg += 1;
  }
  const minText = min.toFixed(digits).padStart(digits > 0 ? digits + 3 : 2, '0');
  return { deg, minText };
}

/** Decimal degrees -> `18°13.29′N`. */
export function formatLat(deg) {
  const value = clamp(safeNumber(deg, 0), -90, 90);
  const { deg: d, minText } = toDmPart(Math.abs(value));
  return `${d}°${minText}′${value >= 0 ? 'N' : 'S'}`;
}

/** Decimal degrees -> `112°38.05′E`. */
export function formatLon(deg) {
  let value = safeNumber(deg, 0);
  // keep longitude in (-180, 180] so the string never grows a second turn
  value = ((((value + 180) % 360) + 360) % 360) - 180;
  const { deg: d, minText } = toDmPart(Math.abs(value));
  return `${d}°${minText}′${value >= 0 ? 'E' : 'W'}`;
}

export function formatLatLon(lat, lon) {
  return `${formatLat(lat)}  ${formatLon(lon)}`;
}

/** Human distance used in event details: `420 m` / `2.4 km`. */
export function formatDistanceM(meters) {
  const value = Math.max(0, safeNumber(meters, 0));
  if (value < 1000) return `${Math.round(value)} m`;
  return `${(value / 1000).toFixed(1)} km`;
}

/** Normalise an angle to [0, 360). */
export function normalizeDeg(deg) {
  let value = safeNumber(deg, 0) % 360;
  if (value < 0) value += 360;
  return value;
}

/** Signed shortest delta between two compass headings, in degrees. */
export function angleDeltaDeg(fromDeg, toDeg) {
  let delta = normalizeDeg(toDeg) - normalizeDeg(fromDeg);
  if (delta > 180) delta -= 360;
  if (delta < -180) delta += 360;
  return delta;
}

/**
 * Fixed mission clock. `met` is the mission elapsed time in seconds; the local
 * wall clock is 14:32:07 + (met - metOffset). Date roll-over at midnight is
 * handled, so a long QA soak keeps a truthful date string.
 */
export function createClock({ metOffset = DEFAULT_MET_OFFSET, timezone = TZ_LABEL } = {}) {
  const offset = safeNumber(metOffset, DEFAULT_MET_OFFSET);
  const tzOffsetMs = TZ_OFFSET_MIN * 60 * 1000;

  function wallUtcMs(metSec) {
    return BASE_UTC_MS + (safeNumber(metSec, offset) - offset) * 1000;
  }

  function localParts(metSec) {
    const d = new Date(wallUtcMs(metSec) + tzOffsetMs);
    return {
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      day: d.getUTCDate(),
      hour: d.getUTCHours(),
      minute: d.getUTCMinutes(),
      second: d.getUTCSeconds(),
    };
  }

  function utcParts(metSec) {
    const d = new Date(wallUtcMs(metSec));
    return {
      hour: d.getUTCHours(),
      minute: d.getUTCMinutes(),
      second: d.getUTCSeconds(),
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      day: d.getUTCDate(),
    };
  }

  return {
    metOffset: offset,
    timezone,
    wallUtcMs,
    localParts,
    utcParts,
    metText: (metSec) => formatMet(metSec),
    clockText(metSec) {
      const p = localParts(metSec);
      return `${pad2(p.hour)}:${pad2(p.minute)}:${pad2(p.second)}`;
    },
    dateText(metSec) {
      const p = localParts(metSec);
      return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
    },
    utcText(metSec) {
      const p = utcParts(metSec);
      return `${pad2(p.hour)}:${pad2(p.minute)}:${pad2(p.second)}Z`;
    },
  };
}
