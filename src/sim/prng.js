// =============================================================================
// OceanSwarm GCS — deterministic pseudo-randomness for the simulation layer.
//
// The console is an offline demo: two runs launched with the same `?seed=`
// must produce the same batteries, the same link noise and the same alarm
// timing, on any machine. mulberry32 is tiny, fast and plenty for telemetry
// wobble; FNV-1a turns textual seeds (e.g. "?seed=qa-3") into a uint32.
// =============================================================================

/** FNV-1a 32-bit string hash. */
export function hashSeed(input) {
  const str = String(input);
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 — 32-bit PRNG returning a function in [0, 1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seeded RNG with the small conveniences telemetry code keeps needing. */
export function createRng(seed) {
  const next = mulberry32(seed >>> 0);
  const rng = () => next();
  rng.range = (a, b) => a + (b - a) * next();
  rng.int = (a, b) => Math.floor(a + (b - a + 1) * next());
  rng.pick = (arr) => arr[Math.floor(next() * arr.length) % arr.length];
  rng.sign = () => (next() < 0.5 ? -1 : 1);
  rng.chance = (p) => next() < p;
  rng.phase = () => next() * Math.PI * 2;
  return rng;
}

/**
 * Locate the seed the console runs with.
 * Priority: explicit options.seed > `?seed=` in the URL > stable default.
 * Everything is hashed to a uint32 so both numbers and strings are accepted.
 */
export function resolveSeed(explicit) {
  if (explicit !== undefined && explicit !== null && explicit !== '') return hashSeed(explicit);
  if (typeof window !== 'undefined' && window.location && typeof window.location.search === 'string') {
    try {
      const params = new URLSearchParams(window.location.search);
      const raw = params.get('seed');
      if (raw !== null && raw !== '') return hashSeed(raw);
    } catch (err) {
      // A malformed query string must never take the console down.
      console.warn('[sim] seed URL parameter ignored:', err);
    }
  }
  return hashSeed('ocean-swarm-gcs-2.0');
}

/**
 * Build a smooth deterministic drift function out of a handful of detuned
 * sine waves, e.g. wind speed. Amplitude/period are physical, phases seeded.
 *
 * @param {Function} rng  seeded rng (createRng)
 * @param {Array<{amplitude:number, periodSec:number, phase?:number}>} components
 * @returns {(t:number, offset?:number) => number}
 */
export function createDrift(rng, components) {
  const parts = components.map((c) => ({
    amplitude: c.amplitude,
    omega: (Math.PI * 2) / Math.max(1, c.periodSec),
    phase: Number.isFinite(c.phase) ? c.phase : rng.phase(),
  }));
  return function drift(t) {
    let value = 0;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      value += Math.sin(t * p.omega + p.phase) * p.amplitude;
    }
    return value;
  };
}

/** Deterministic value in [0, 1) from a few integer coordinates — no state. */
export function hash01(seed, a, b = 0) {
  let h = Math.imul((seed >>> 0) ^ 0x9e3779b9, 0x85ebca6b);
  h ^= Math.imul(a | 0, 0xc2b2ae35);
  h ^= Math.imul(b | 0, 0x27d4eb2f);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = h ^ (h >>> 12);
  return (h >>> 0) / 4294967296;
}
