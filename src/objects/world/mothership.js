// =============================================================================
// OceanSwarm — 120 m future ocean support / research vessel (mothership).
//
// Stylised "three-render-two" industrial look: pearl-white hull, deep navy
// waterline band, signal-orange safety accents, dark navy glass bridge, a big
// open aft mission deck with gantry crane, USV cradles, workshops, UUV hangar
// doors, helideck forward and a comms mast / radome above the bridge.
//
// Local vessel space: +X = bow, +Y = up, +Z = starboard, origin = waterline
// amidships (same convention as every ship builder in this project).
// World placement: absolute at LAYOUT.mothership, rotation.y = -heading.
//
// API: createMothership(materials?) -> { group, update(time, dt) }
// =============================================================================
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { LAYOUT, COLORS } from '../../config.js';
import { sampleWave } from '../../core/waves.js';
import {
  Builder,
  box,
  rbox,
  cyl,
  sphere,
  dome,
  disc,
  ring,
  plane,
  tube,
  lathe,
  frustum,
  torus,
  TAU,
  DEG,
  clamp,
  lerp,
  makeRng,
  hullParts,
  hullSurfacePoint,
  normalizeGeometry,
  matrixFrom,
} from '../../core/geo.js';
import { makeToon, makeMetal, makeGlow, makeGlass, makeOutline } from '../../core/materials.js';

// -----------------------------------------------------------------------------
// Hull spec
// -----------------------------------------------------------------------------
const SHIP = {
  length: 120,
  beam: 24,
  draft: 5.0,
  freeboard: 6.9,
  sheer: 1.0,
  bowSharp: 0.82,
  flare: 0.12,
  rocker: 0.5,
  sternWidth: 0.94,
  camber: 0.06,
  rake: 0.16,
  sectionPower: 2.05,
  uSegments: 44,
  rowsLower: 4,
  rowsUpper: 6,
};

const HEADING = LAYOUT.mothership.heading;
const WAVE_PHASE = 1.35;

// -----------------------------------------------------------------------------
// Material resolution (shared registry from createMaterials, or a local
// fallback so the module also works standalone / in Node smoke tests).
// -----------------------------------------------------------------------------
let _fallbackMaterials = null;

function buildFallbackMaterials() {
  const M = {
    pearl: makeToon(COLORS.pearl, { rim: 0.22 }),
    white: makeToon(COLORS.white, { rim: 0.16 }),
    ivory: makeToon(COLORS.ivory, { rim: 0.18 }),
    navy: makeToon(COLORS.navy, { rim: 0.14, rimColor: 0x9fd8ff }),
    hullBottom: makeToon(COLORS.hullBottom, { rim: 0.05 }),
    graphite: makeToon(COLORS.graphite, { rim: 0.12 }),
    darkSteel: makeToon(COLORS.darkSteel, { rim: 0.1 }),
    deckGray: makeToon(COLORS.deckGray, { rim: 0.08 }),
    deckDark: makeToon(COLORS.deckDark, { rim: 0.08 }),
    black: makeToon(COLORS.black, { rim: 0.02 }),
    rubber: makeToon(COLORS.rubber, { rim: 0.03 }),
    silver: makeMetal(COLORS.silver, 0.55, 0.36),
    metal: makeMetal(COLORS.metal, 0.8, 0.3),
    metalDark: makeMetal(COLORS.metalDark, 0.78, 0.36),
    steel: makeMetal(0xb9c6cc, 0.72, 0.28),
    glass: makeGlass(),
    glassLight: makeGlass({ color: 0x2e5d74, metalness: 0.4, roughness: 0.1, emissive: 0x2a637c, emissiveIntensity: 0.5 }),
    glassWarm: makeGlass({ color: 0x3a4a44, metalness: 0.1, roughness: 0.18, emissive: 0xffdd9a, emissiveIntensity: 1.2 }),
    signalOrange: makeToon(COLORS.signalOrange, { rim: 0.16 }),
    safetyOrange: makeToon(COLORS.safetyOrange, { rim: 0.16 }),
    techCyan: makeToon(COLORS.techCyan, { rim: 0.25, emissive: COLORS.techCyan, emissiveIntensity: 0.32 }),
    warmWhite: makeToon(COLORS.warmWhite, { rim: 0.2 }),
    glowWarm: makeGlow(COLORS.warmWhite),
    glowRed: makeGlow(COLORS.navRed),
    glowGreen: makeGlow(COLORS.navGreen),
    glowCyan: makeGlow(COLORS.neonCyan),
    glowWhite: makeGlow(0xffffff),
    glowOrange: makeGlow(COLORS.signalOrange),
    outlineBoat: makeOutline(0.13),
    outlineBoatSmall: makeOutline(0.075),
  };
  M.toon = (color, opts) => makeToon(color, opts);
  M.metal = (color, metalness, roughness, opts) => makeMetal(color, metalness, roughness, opts);
  M.standard = M.metal;
  M.glow = (color, opts) => makeGlow(color, opts);
  M.glassCustom = (opts) => makeGlass(opts);
  M.outline = (width) => makeOutline(width);
  return M;
}

function resolveMaterials(materials) {
  if (materials) return materials;
  if (!_fallbackMaterials) _fallbackMaterials = buildFallbackMaterials();
  return _fallbackMaterials;
}

// -----------------------------------------------------------------------------
// Small helpers (local to this module)
// -----------------------------------------------------------------------------

/** Box between two 3D points (pipes, braces, wires). */
const _up = new THREE.Vector3(0, 1, 0);
const _dir = new THREE.Vector3();
const _mid = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _eul = new THREE.Euler();

function beam(b, key, a, c, radius, tint, seg = 8) {
  _dir.set(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
  const len = _dir.length();
  if (len < 1e-4) return;
  _dir.multiplyScalar(1 / len);
  _quat.setFromUnitVectors(_up, _dir);
  _eul.setFromQuaternion(_quat);
  _mid.set(a[0] + c[0], a[1] + c[1], a[2] + c[2]).multiplyScalar(0.5);
  b.add(cyl(radius, radius, len, seg), key, { pos: [_mid.x, _mid.y, _mid.z], rot: [_eul.x, _eul.y, _eul.z] }, tint);
}

/** Deck railing: posts + two rails along a straight segment in the XZ plane. */
function railing(b, x0, z0, x1, z1, y, opts = {}) {
  const h = opts.height ?? 1.08;
  const mat = opts.mat ?? 'silver';
  const spacing = opts.spacing ?? 3.0;
  const dx = x1 - x0;
  const dz = z1 - z0;
  const len = Math.hypot(dx, dz);
  if (len < 0.2) return;
  const n = Math.max(1, Math.round(len / spacing));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    b.add(box(0.075, h, 0.075), mat, { pos: [x0 + dx * t, y + h * 0.5, z0 + dz * t] });
  }
  const cx = (x0 + x1) * 0.5;
  const cz = (z0 + z1) * 0.5;
  const ry = -Math.atan2(dz, dx);
  b.add(box(len, 0.08, 0.06), mat, { pos: [cx, y + h, cz], rot: [0, ry, 0] });
  b.add(box(len, 0.055, 0.05), mat, { pos: [cx, y + h * 0.55, cz], rot: [0, ry, 0] });
}

/**
 * Constant-height stripe that hugs the parametric hull: unlike hullBand it
 * follows a horizontal waterline instead of a constant section parameter.
 * yLow/yHigh may be numbers or functions of u (0 = stern, 1 = bow).
 */
function hullWaterlineStripe(spec, yLow, yHigh, offset = 0.035, uSegments = 40) {
  const lowFn = typeof yLow === 'function' ? yLow : () => yLow;
  const highFn = typeof yHigh === 'function' ? yHigh : () => yHigh;
  const draftAt = (u) => {
    const base = 0.6 + 0.5 * Math.exp(-Math.pow((u - 0.42) / 0.36, 2));
    return spec.draft * base * (1 - (spec.rocker ?? 0.55) * Math.pow(u, 2.6));
  };
  const freeAt = (u) => (spec.freeboard ?? 1.2) + (spec.sheer ?? 0) * Math.pow(u, 2.1);
  const halfAt = (u, v) => {
    const half = spec.beam * 0.5;
    const stern = spec.sternWidth ?? 0.88;
    const bowSharp = spec.bowSharp ?? 0.9;
    const wide = stern + (1.0 - stern) * Math.sin(Math.PI * clamp(u * 0.92, 0, 1));
    const taper = Math.pow(Math.max(0, 1 - Math.pow(u, 2.2 * bowSharp)), 0.52);
    const width = half * wide * taper * (1 + (spec.flare ?? 0.16) * Math.pow(v, 1.6) * Math.pow(clamp(u, 0, 1), 2.2));
    return Math.pow(v, spec.sectionPower ?? 1.75) * width;
  };
  const xAt = (u, v) => {
    const rake = spec.rake ?? 0.12;
    const xBow = Math.pow(clamp((u - 0.72) / 0.28, 0, 1), 2.0) * rake * v;
    return (u - 0.5) * spec.length + xBow * spec.length * 0.06;
  };
  const verts = [];
  const inds = [];
  const stride = 4;
  for (let i = 0; i <= uSegments; i++) {
    const u = i / uSegments;
    const keel = -draftAt(u);
    const deck = freeAt(u);
    const yl = lowFn(u);
    const yh = highFn(u);
    const vl = clamp((yl - keel) / (deck - keel), 0.015, 0.985);
    const vh = clamp((yh - keel) / (deck - keel), 0.02, 0.99);
    const zl = halfAt(u, vl);
    const zh = halfAt(u, vh);
    const xl = xAt(u, vl);
    const xh = xAt(u, vh);
    const ol = 1 + offset / Math.max(0.35, zl);
    const oh = 1 + offset / Math.max(0.35, zh);
    // starboard low, starboard high, port low, port high
    verts.push(xl, yl, zl * ol, xh, yh, zh * oh, xl, yl, -zl * ol, xh, yh, -zh * oh);
  }
  for (let i = 0; i < uSegments; i++) {
    const a = i * stride;
    const c = (i + 1) * stride;
    inds.push(a, c, a + 1, a + 1, c, c + 1);
    inds.push(a + 2, a + 3, c + 2, a + 3, c + 3, c + 2);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.setIndex(inds);
  geo.computeVertexNormals();
  return geo;
}

/** Merge a list of [geometry, transform, tint] into one geometry. */
function mergeParts(parts) {
  const geos = parts.map(([geo, transform, tint]) => {
    const g = geo.clone();
    g.applyMatrix4(matrixFrom(transform));
    return normalizeGeometry(g, true, tint === undefined ? 0xffffff : tint);
  });
  parts.forEach(([geo]) => geo.dispose?.());
  const merged = mergeGeometries(geos, false);
  geos.forEach((g) => g.dispose());
  return merged;
}

/** One superstructure deck level: pearl body + wrap-around navy glass + mullions. */
function glazedLevel(b, cx, cy, cz, w, h, d, opts = {}) {
  const bodyKey = opts.body ?? 'pearl';
  const glassKey = opts.glass ?? 'glass';
  b.solid(box(w, h, d), bodyKey, { pos: [cx, cy + h * 0.5, cz] });
  // wrap-around window band
  const bandH = Math.min(h * 0.42, 2.15);
  const bandY = cy + h * 0.52;
  const g = 0.14;
  b.add(box(0.16, bandH, d + 0.1), glassKey, { pos: [cx + w * 0.5 + 0.05, bandY, cz] });
  b.add(box(0.16, bandH, d + 0.1), glassKey, { pos: [cx - w * 0.5 - 0.05, bandY, cz] });
  b.add(box(w + 0.1, bandH, 0.16), glassKey, { pos: [cx, bandY, cz + d * 0.5 + 0.05] });
  b.add(box(w + 0.1, bandH, 0.16), glassKey, { pos: [cx, bandY, cz - d * 0.5 - 0.05] });
  // silver mullions along both long sides and the front
  const every = opts.mullionEvery ?? 2.8;
  const nz = Math.max(2, Math.round(d / every));
  for (let i = 0; i <= nz; i++) {
    const z = cz - d * 0.5 + (d * i) / nz;
    b.add(box(0.22, bandH + 0.18, 0.16), 'silver', { pos: [cx + w * 0.5 + 0.12, bandY, z] });
    b.add(box(0.22, bandH + 0.18, 0.16), 'silver', { pos: [cx - w * 0.5 - 0.12, bandY, z] });
  }
  const nx = Math.max(2, Math.round(w / every));
  for (let i = 0; i <= nx; i++) {
    const x = cx - w * 0.5 + (w * i) / nx;
    b.add(box(0.16, bandH + 0.18, 0.22), 'silver', { pos: [x, bandY, cz + d * 0.5 + 0.12] });
    b.add(box(0.16, bandH + 0.18, 0.22), 'silver', { pos: [x, bandY, cz - d * 0.5 - 0.12] });
  }
  // sill + head trim
  b.add(box(w + 0.35, 0.14, d + 0.35), 'silver', { pos: [cx, bandY - bandH * 0.5 - 0.06, cz] });
  b.add(box(w + 0.35, 0.12, d + 0.35), 'silver', { pos: [cx, bandY + bandH * 0.5 + 0.06, cz] });
  // warm interior strips peeking through the dark glazing
  const wn = Math.max(2, Math.floor(nx * 0.7));
  for (let i = 0; i < wn; i++) {
    if ((i * 7 + 3) % 4 === 0) continue;
    const x = cx - w * 0.32 + (w * 0.64 * (i + 0.5)) / wn;
    b.add(box(0.9, bandH * 0.45, 0.08), 'glassWarm', { pos: [x, bandY, cz + d * 0.5 + 0.16] });
  }
  // side warm windows too
  const wnSide = Math.max(2, Math.round(d / 4.2));
  for (const sz of [-1, 1]) {
    for (let i = 0; i < wnSide; i++) {
      if ((i * 3 + 1) % 4 === 0) continue;
      const z = cz - d * 0.32 + (d * 0.64 * (i + 0.5)) / wnSide;
      b.add(box(0.1, bandH * 0.42, 1.5), 'glassWarm', { pos: [cx + sz * (w * 0.5 + 0.12), bandY, z] });
    }
  }
  return { bandH, bandY, g };
}

/** Flat roof props: solar array, HVAC boxes, vents, rail and antenna whips. */
function roofKit(b, cx, cy, cz, w, d, opts = {}) {
  const rng = opts.rng || makeRng(7);
  // low parapet
  const t = 0.22;
  const ph = opts.parapet ?? 0.55;
  b.add(box(w, ph, t), opts.parapetKey ?? 'silver', { pos: [cx, cy + ph * 0.5, cz + d * 0.5 - t * 0.5] });
  b.add(box(w, ph, t), opts.parapetKey ?? 'silver', { pos: [cx, cy + ph * 0.5, cz - d * 0.5 + t * 0.5] });
  b.add(box(t, ph, d), opts.parapetKey ?? 'silver', { pos: [cx + w * 0.5 - t * 0.5, cy + ph * 0.5, cz] });
  b.add(box(t, ph, d), opts.parapetKey ?? 'silver', { pos: [cx - w * 0.5 + t * 0.5, cy + ph * 0.5, cz] });
  // solar panel array (tilted dark-blue panels on silver legs)
  const solarW = opts.solarW ?? 10;
  const solarD = opts.solarD ?? 3.2;
  const rows = opts.solarRows ?? 2;
  for (let r = 0; r < rows; r++) {
    const px = cx - w * 0.28 + (w * 0.56 * r) / Math.max(1, rows - 1 || 1);
    const pz = cz + d * 0.12;
    for (let k = 0; k < 2; k++) {
      const lx = px + (k - 0.5) * (solarW * 0.52);
      b.add(box(solarW * 0.46, 0.1, solarD), 'glass', { pos: [lx, cy + 0.78, pz], rot: [-0.32, 0, 0] });
      b.add(box(0.1, 0.62, 0.1), 'silver', { pos: [lx - solarW * 0.2, cy + 0.32, pz - solarD * 0.35], rot: [0, 0, 0] });
      b.add(box(0.1, 0.9, 0.1), 'silver', { pos: [lx + solarW * 0.2, cy + 0.45, pz - solarD * 0.35] });
    }
  }
  // hvac / vents
  b.add(box(2.6, 1.1, 1.8), 'silver', { pos: [cx + w * 0.22, cy + 0.55, cz - d * 0.24] });
  b.add(box(1.8, 0.9, 1.4), 'silver', { pos: [cx - w * 0.3, cy + 0.45, cz - d * 0.26] });
  b.add(cyl(0.35, 0.42, 0.9, 8), 'metalDark', { pos: [cx - w * 0.12, cy + 0.45, cz - d * 0.3] });
  // antenna whips
  for (let i = 0; i < 2; i++) {
    const ax = cx + w * (i ? 0.36 : -0.16);
    const az = cz + d * 0.32;
    b.add(cyl(0.045, 0.07, 4.6 - i * 1.4, 5), 'silver', { pos: [ax, cy + 2.3 - i * 0.7, az] });
    b.add(sphere(0.13, 6, 4), 'glowRed', { pos: [ax, cy + 4.6 - i * 1.4, az] });
  }
}

/** Simple stylised USV (8 m) resting on a deck cradle, local +X = bow. */
function deckUSV(b, cx, cy, cz, ry, len = 8, opts = {}) {
  const spec = {
    length: len,
    beam: len * 0.35,
    draft: len * 0.052,
    freeboard: len * 0.088,
    sheer: len * 0.012,
    bowSharp: 1.02,
    flare: 0.2,
    rocker: 0.55,
    sternWidth: 0.9,
    camber: 0.05,
    rake: 0.2,
    sectionPower: 2.15,
    uSegments: 16,
    rowsLower: 3,
    rowsUpper: 3,
  };
  const parts = hullParts(spec);
  const lift = cy + spec.draft * 0.92;
  const c = Math.cos(ry);
  const s = Math.sin(ry);
  const place = (lx, lz) => [cx + lx * c + lz * s, cz - lx * s + lz * c];
  b.add(parts.lower, 'hullBottom', { pos: [cx, lift, cz], rot: [0, ry, 0] });
  b.add(parts.topsides, opts.body ?? 'pearl', { pos: [cx, lift, cz], rot: [0, ry, 0] });
  b.add(parts.deck, 'deckDark', { pos: [cx, lift, cz], rot: [0, ry, 0] });
  b.add(parts.transom, opts.body ?? 'pearl', { pos: [cx, lift, cz], rot: [0, ry, 0] });
  parts.lower.dispose();
  parts.topsides.dispose();
  parts.deck.dispose();
  parts.transom.dispose();
  // console / sensor arch
  const [bx, bz] = place(-1.1, 0);
  b.add(box(2.0, 1.15, len * 0.2), opts.cabin ?? 'white', { pos: [bx, lift + 1.15, bz], rot: [0, ry, 0] });
  b.add(box(2.1, 0.4, len * 0.21), 'glass', { pos: [bx + 0.1 * c, lift + 1.52, bz - 0.1 * s], rot: [0, ry, 0] });
  const [mx, mz] = place(-2.4, 0);
  b.add(cyl(0.06, 0.08, 2.3, 5), 'silver', { pos: [mx, lift + 2.1, mz] });
  b.add(box(0.5, 0.16, 0.5), opts.pod ?? 'signalOrange', { pos: [mx, lift + 3.2, mz], rot: [0, ry, 0] });
  // accent stripe on the topsides
  const [sx, sz] = place(0.3, len * 0.177);
  b.add(box(len * 0.62, 0.13, 0.06), 'signalOrange', { pos: [sx, lift + 0.52, sz], rot: [0, ry, 0] });
}

/**
 * Deck crane parts in local space (origin = pedestal base on the deck). Returns
 * a { materialKey: [[geometry, transform], ...] } map so it can be merged into
 * a dynamic group with one draw call per material.
 */
function deckCraneParts(ry, scale = 1) {
  const dx = Math.cos(ry);
  const dz = -Math.sin(ry);
  const bl = 13 * scale;
  const tilt = 0.55;
  const pivotY = 4.4 * scale;
  const boom = frustum(bl, 0.85 * scale, 1.1 * scale, 0.62, 0.55);
  boom.rotateZ(tilt);
  const cosT = Math.cos(tilt);
  const sinT = Math.sin(tilt);
  const bcx = dx * bl * 0.5 * cosT;
  const bcy = pivotY + bl * 0.5 * sinT;
  const bcz = dz * bl * 0.5 * cosT;
  const tipX = dx * bl * cosT;
  const tipY = pivotY + bl * sinT;
  const tipZ = dz * bl * cosT;
  const hookY = 1.9 * scale;
  const cableH = Math.max(0.4, tipY - hookY);
  return {
    metalDark: [
      [cyl(1.35 * scale, 1.55 * scale, 1.2, 12), { pos: [0, 0.6 * scale, 0] }],
      [box(0.6 * scale, 0.5 * scale, 0.6 * scale), { pos: [tipX, hookY, tipZ] }],
      [box(1.8 * scale, 1.1 * scale, 2.0 * scale), { pos: [-dx * 2.3 * scale, 3.5 * scale, -dz * 2.3 * scale], rot: [0, ry, 0] }],
    ],
    silver: [[cyl(0.6 * scale, 0.6 * scale, 2.0 * scale, 8), { pos: [0, 2.0 * scale, 0] }]],
    white: [[box(2.4 * scale, 1.5 * scale, 2.0 * scale), { pos: [0, 3.7 * scale, 0], rot: [0, ry, 0] }]],
    glass: [[box(1.6 * scale, 0.6 * scale, 0.9 * scale), { pos: [dx * 0.9 * scale, 3.9 * scale, dz * 0.9 * scale], rot: [0, ry, 0] }]],
    signalOrange: [
      [boom, { pos: [bcx, bcy, bcz], rot: [0, ry, 0] }],
      [box(0.7 * scale, 0.45 * scale, 0.7 * scale), { pos: [-dx * 0.8 * scale, 4.5 * scale, -dz * 0.8 * scale] }],
    ],
    darkSteel: [[box(0.07, cableH, 0.07), { pos: [tipX, (tipY + hookY) * 0.5, tipZ] }]],
  };
}

/** Small ribbed shipping/workshop container. */
function container(b, cx, cy, cz, ry, len, hgt, wid, bodyKey, opts = {}) {
  const c = Math.cos(ry);
  const s = Math.sin(ry);
  b.add(box(len, hgt, wid), bodyKey, { pos: [cx, cy + hgt * 0.5, cz], rot: [0, ry, 0] });
  const ribN = Math.max(4, Math.floor(len / 1.1));
  for (let i = 0; i <= ribN; i++) {
    const lx = -len * 0.5 + 0.18 + ((len - 0.36) * i) / ribN;
    const px = cx + lx * c;
    const pz = cz - lx * s;
    b.add(box(0.14, hgt * 0.9, 0.09), 'metalDark', { pos: [px, cy + hgt * 0.5, pz + wid * 0.5 + 0.02], rot: [0, ry, 0] });
    b.add(box(0.14, hgt * 0.9, 0.09), 'metalDark', { pos: [px, cy + hgt * 0.5, pz - wid * 0.5 - 0.02], rot: [0, ry, 0] });
  }
  // corner castings + roof rim
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const px = cx + sx * len * 0.48 * c + sz * wid * 0.48 * s;
      const pz = cz - sx * len * 0.48 * s + sz * wid * 0.48 * c;
      b.add(box(0.24, hgt + 0.06, 0.24), 'metalDark', { pos: [px, cy + hgt * 0.5, pz], rot: [0, ry, 0] });
    }
  }
  b.add(box(len - 0.2, 0.12, wid - 0.2), 'silver', { pos: [cx, cy + hgt + 0.02, cz], rot: [0, ry, 0] });
  if (opts.accent) {
    b.add(box(len * 0.24, 0.5, wid + 0.04), 'signalOrange', { pos: [cx + len * 0.2 * c, cy + hgt * 0.72, cz - len * 0.2 * s], rot: [0, ry, 0] });
  }
}

// -----------------------------------------------------------------------------
// createMothership
// -----------------------------------------------------------------------------
export function createMothership(materials) {
  const M = resolveMaterials(materials);
  const b = new Builder(M, { outlineMaterial: M.outlineBoat || null });
  const rng = makeRng(20261021);

  const group = new THREE.Group();
  group.name = 'mothership';
  group.position.set(LAYOUT.mothership.x, 0, LAYOUT.mothership.z);
  group.rotation.order = 'YXZ';
  group.rotation.y = -HEADING;

  // ==== hull ================================================================
  const hull = hullParts(SHIP);
  b.solid(hull.lower, 'hullBottom');
  b.solid(hull.topsides, 'pearl');
  b.add(hull.deck, 'deckGray');
  b.add(hull.transom, 'pearl');
  // navy waterline band + thin orange sheer stripe
  b.add(hullWaterlineStripe(SHIP, 0.04, 1.35, 0.04, 40), 'navy');
  b.add(
    hullWaterlineStripe(
      SHIP,
      (u) => SHIP.freeboard + SHIP.sheer * Math.pow(u, 2.1) - 0.72,
      (u) => SHIP.freeboard + SHIP.sheer * Math.pow(u, 2.1) - 0.4,
      0.045,
      40,
    ),
    'signalOrange',
  );
  // stern name-board panel + orange stern stripe
  b.add(box(0.14, 1.1, 12), 'darkSteel', { pos: [-SHIP.length * 0.5 + 0.02, 6.0, 0] });
  b.add(box(0.14, 0.32, 9.6), 'signalOrange', { pos: [-SHIP.length * 0.5 - 0.02, 7.9, 0] });

  // ==== main deck structures =================================================
  const DECK = 7.1;

  // hull-side promenade windows (two rows of inset glass in the topsides)
  for (let i = 0; i < 22; i++) {
    const u = 0.16 + (i / 21) * 0.56;
    for (const rowV of [0.73, 0.865]) {
      for (const side of [-1, 1]) {
        const p = hullSurfacePoint(SHIP, u, rowV, side);
        b.add(box(0.66, 0.5, 0.1), 'glass', { pos: [p.x, p.y, p.z + side * 0.05] });
        b.add(box(0.8, 0.08, 0.14), 'silver', { pos: [p.x, p.y - 0.31, p.z + side * 0.05] });
      }
    }
  }
  // anchor recesses + bow hawse
  for (const side of [-1, 1]) {
    b.add(box(1.6, 1.2, 0.35), 'darkSteel', { pos: [51.5, 4.6, side * 4.6] });
    b.add(cyl(0.35, 0.35, 0.4, 8), 'metalDark', { pos: [51.4, 4.4, side * 4.8], rot: [Math.PI * 0.5, 0, 0] });
    b.add(box(1.0, 0.8, 0.5), 'graphite', { pos: [44.0, 5.1, side * 10.2] });
  }

  // lifeboats in davits, just aft of the accommodation block
  for (const side of [-1, 1]) {
    const lx = 1.4;
    const lz = side * 12.5;
    const ly = 9.2;
    b.add(rbox(6.6, 1.9, 2.4, 0.55, 2), 'safetyOrange', { pos: [lx, ly, lz] });
    b.add(box(2.5, 0.85, 2.1), 'white', { pos: [lx + 1.3, ly + 1.15, lz] });
    b.add(box(0.55, 0.4, 0.1), 'glass', { pos: [lx + 1.3, ly + 1.3, lz + side * 1.07] });
    b.add(box(0.5, 0.4, 0.12), 'glass', { pos: [lx + 0.3, ly + 1.3, lz + side * 1.07] });
    // davit posts + arms + hanging falls
    for (const dx of [-1.9, 1.9]) {
      beam(b, 'silver', [lx + dx, DECK + 0.1, side * 10.7], [lx + dx, DECK + 3.8, side * 10.7], 0.16, undefined, 6);
      beam(b, 'silver', [lx + dx, DECK + 3.8, side * 10.7], [lx + dx, DECK + 4.3, side * 12.3], 0.12, undefined, 6);
      b.add(box(0.06, 1.1, 0.06), 'darkSteel', { pos: [lx + dx, ly + 1.5, lz] });
    }
    b.add(box(4.4, 0.18, 0.18), 'silver', { pos: [lx, DECK + 4.3, side * 12.3] });
  }

  // external stair from the aft mission deck up to the deckhouse level
  for (let i = 0; i < 7; i++) {
    b.add(box(1.1, 0.28, 2.4), 'metalDark', { pos: [8.6, DECK + 0.35 + i * 0.6, 6.2] });
  }
  b.add(box(0.1, 3.9, 0.1), 'silver', { pos: [8.1, DECK + 2.1, 7.4] });
  b.add(box(0.1, 3.9, 0.1), 'silver', { pos: [9.1, DECK + 2.1, 7.4] });
  b.add(box(0.1, 3.9, 0.1), 'silver', { pos: [8.1, DECK + 2.1, 5.0] });
  b.add(box(0.1, 3.9, 0.1), 'silver', { pos: [9.1, DECK + 2.1, 5.0] });
  // helideck support struts
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU + 0.4;
    beam(
      b,
      'steel',
      [51.5 + Math.cos(a) * 5.2, DECK + 1.6, Math.sin(a) * 5.2],
      [51.5 + Math.cos(a) * 3.2, DECK + 0.1, Math.sin(a) * 3.2],
      0.16,
      undefined,
      6,
    );
  }

  // engine casing (supports the funnels) tucked behind the deckhouse
  b.solid(box(13, 6.9, 11), 'pearl', { pos: [2.5, DECK + 3.45, 0] });
  b.add(box(13.2, 0.9, 11.2), 'deckDark', { pos: [2.5, DECK + 1.0, 0] });
  // UUV hangar doors on the aft face of the casing
  for (const sz of [-1, 1]) {
    b.add(box(0.2, 3.4, 4.3), 'darkSteel', { pos: [-4.15, DECK + 3.4, sz * 2.9] });
    b.add(box(0.24, 0.4, 4.3), 'safetyOrange', { pos: [-4.16, DECK + 5.0, sz * 2.9] });
    b.add(box(0.24, 0.14, 3.4), 'signalOrange', { pos: [-4.18, DECK + 2.0, sz * 2.9] });
    b.add(box(0.06, 0.5, 0.5), 'warmWhite', { pos: [-4.24, DECK + 4.6, sz * 2.9 - 1.6] });
  }
  // casing side machinery + vents
  for (const sz of [-1, 1]) {
    b.add(box(9.5, 0.7, 0.7), 'metalDark', { pos: [2.5, DECK + 5.6, sz * 5.6] });
    b.add(cyl(0.5, 0.5, 2.2, 8), 'silver', { pos: [2.0, DECK + 1.6, sz * 5.9], rot: [0, 0, Math.PI * 0.5] });
  }

  // forward deckhouse: three stepped, glazed levels
  glazedLevel(b, 27, DECK - 0.6, 0, 34, 5.4, 17, { body: 'pearl', glass: 'glass', mullionEvery: 2.6 });
  glazedLevel(b, 28, DECK + 4.8, 0, 30, 2.9, 15, { body: 'ivory', glass: 'glassLight', mullionEvery: 2.4 });
  glazedLevel(b, 30, DECK + 7.7, 0, 22, 3.2, 13, { body: 'pearl', glass: 'glass', mullionEvery: 2.2 });
  // raked bridge front window + brow
  const rake = box(0.22, 2.6, 11);
  rake.rotateZ(-0.28);
  b.add(rake, 'glass', { pos: [41.0, DECK + 9.3, 0] });
  b.add(box(1.4, 0.28, 12.4), 'pearl', { pos: [41.1, DECK + 10.7, 0], rot: [0, 0, -0.28] });
  // bridge wings
  for (const sz of [-1, 1]) {
    b.add(box(5.6, 2.3, 3.4), 'pearl', { pos: [31.5, DECK + 8.7, sz * 8.1] });
    b.add(box(4.2, 1.0, 0.14), 'glass', { pos: [32.0, DECK + 9.1, sz * 9.85] });
    b.add(box(0.18, 0.18, 3.2), 'silver', { pos: [29.0, DECK + 11.0, sz * 6.6] });
    b.add(box(0.18, 0.18, 3.2), 'silver', { pos: [34.0, DECK + 11.0, sz * 6.6] });
    // nav lights
    b.add(sphere(0.28, 6, 4), sz > 0 ? 'glowGreen' : 'glowRed', { pos: [33.4, DECK + 9.9, sz * 10.2] });
  }
  // bridge roof equipment
  b.add(box(3.0, 0.7, 3.0), 'silver', { pos: [34.0, DECK + 11.3, 2.6] });
  b.add(cyl(0.5, 0.7, 1.4, 8), 'metalDark', { pos: [33.0, DECK + 11.6, -2.8] });
  // cyan tech strip under the bridge brow
  b.add(box(0.1, 0.12, 10.5), 'glowCyan', { pos: [41.4, DECK + 8.1, 0] });

  // radome on the bridge roof
  b.add(cyl(1.3, 1.6, 1.2, 12), 'silver', { pos: [24.0, DECK + 11.2, 0] });
  b.add(sphere(2.1, 16, 10), 'white', { pos: [24.0, DECK + 13.2, 0] });
  b.add(cyl(0.12, 0.12, 0.8, 6), 'silver', { pos: [24.0, DECK + 15.5, 0] });
  b.add(sphere(0.18, 6, 4), 'glowRed', { pos: [24.0, DECK + 16.0, 0] });

  // funnels
  for (const sz of [-1, 1]) {
    const fx = 4.2;
    const fz = sz * 3.4;
    b.solid(frustum(4.4, 8.0, 2.8, 0.82, 0.86), 'white', { pos: [fx, DECK + 10.4, fz], rot: [0.1, 0, 0] });
    b.add(box(4.5, 0.85, 2.9), 'signalOrange', { pos: [fx, DECK + 13.4, fz], rot: [0.1, 0, 0] });
    b.add(box(4.5, 0.4, 2.9), 'darkSteel', { pos: [fx, DECK + 14.4, fz], rot: [0.1, 0, 0] });
    b.add(cyl(0.75, 0.75, 0.7, 10), 'darkSteel', { pos: [fx - 0.4, DECK + 14.8, fz] });
    b.add(cyl(0.75, 0.75, 0.7, 10), 'darkSteel', { pos: [fx + 1.25, DECK + 14.8, fz] });
  }

  // ==== foredeck / helideck ==================================================
  // forecastle bulwark (follows the hull sides roughly)
  for (let i = 0; i < 4; i++) {
    const u0 = 0.78 + i * 0.05;
    const x = (u0 - 0.5) * SHIP.length;
    const half = (SHIP.beam * 0.5) * Math.pow(Math.max(0, 1 - Math.pow(u0, 2.2 * SHIP.bowSharp)), 0.52);
    for (const sz of [-1, 1]) {
      b.add(box(6.1, 1.15, 0.32), 'pearl', { pos: [x, DECK + 0.62, sz * half * 0.96], rot: [0, sz * 0.03, 0] });
      b.add(box(6.1, 0.16, 0.4), 'signalOrange', { pos: [x, DECK + 1.24, sz * half * 0.96], rot: [0, sz * 0.03, 0] });
      b.add(box(0.35, 1.15, 0.35), 'silver', { pos: [x - 2.9, DECK + 0.62, sz * half * 0.9] });
    }
  }
  // helideck
  const heliX = 51.5;
  const heliY = DECK + 1.55;
  b.add(cyl(6.4, 6.7, 0.7, 20), 'deckDark', { pos: [heliX, heliY, 0] });
  b.add(ring(5.9, 6.42, 28), 'white', { pos: [heliX, heliY + 0.37, 0] });
  b.add(ring(2.2, 2.6, 20), 'warmWhite', { pos: [heliX, heliY + 0.38, 0] });
  b.add(disc(1.0, 12), 'warmWhite', { pos: [heliX, heliY + 0.38, 0] });
  b.add(cyl(0.5, 0.7, 1.2, 8), 'silver', { pos: [heliX, heliY - 1.0, 0] });
  const heliLights = 8;
  for (let i = 0; i < heliLights; i++) {
    const a = (i / heliLights) * TAU;
    b.add(box(0.3, 0.12, 0.3), 'glowWarm', { pos: [heliX + Math.cos(a) * 6.6, heliY + 0.4, Math.sin(a) * 6.6] });
  }
  // foredeck hatches + windlass
  b.add(box(4.0, 0.5, 3.2), 'deckDark', { pos: [46.0, DECK + 0.3, 3.2] });
  b.add(box(4.0, 0.5, 3.2), 'deckDark', { pos: [46.0, DECK + 0.3, -3.2] });
  b.add(cyl(0.9, 1.1, 1.0, 10), 'metalDark', { pos: [57.0, DECK + 0.6, 0] });
  b.add(box(1.4, 0.5, 1.4), 'silver', { pos: [55.2, DECK + 0.4, 2.4] });

  // ==== aft mission deck =====================================================
  // deck coating panel and safety walkway stripes
  b.add(box(66, 0.12, 23.4), 'deckDark', { pos: [-27, DECK + 0.02, 0] });
  for (const sz of [-1, 1]) {
    b.add(box(64, 0.05, 0.42), 'safetyOrange', { pos: [-27, DECK + 0.1, sz * 10.4] });
    b.add(box(64, 0.05, 0.16), 'warmWhite', { pos: [-27, DECK + 0.1, sz * 9.9] });
  }
  // gantry crane: two A-frames + longitudinal rails + trolley + hoist
  const gantry = [];
  for (const gx of [-20, -32]) {
    for (const sz of [-1, 1]) {
      gantry.push([[gx, DECK + 0.1, sz * 9.0], [gx, DECK + 8.4, sz * 1.7]]);
      gantry.push([[gx, DECK + 0.1, sz * 1.7], [gx, DECK + 8.4, sz * 1.7]]);
    }
    gantry.push([[gx, DECK + 8.4, -1.7], [gx, DECK + 8.4, 1.7]]);
    // diagonal bracing on the A legs
    gantry.push([[gx, DECK + 4.2, -8.3], [gx, DECK + 6.9, -2.9]]);
    gantry.push([[gx, DECK + 4.2, 8.3], [gx, DECK + 6.9, 2.9]]);
  }
  gantry.push([[-20, DECK + 8.6, -1.7], [-32, DECK + 8.6, -1.7]]);
  gantry.push([[-20, DECK + 8.6, 1.7], [-32, DECK + 8.6, 1.7]]);
  gantry.push([[-20, DECK + 8.6, 1.7], [-32, DECK + 8.6, -1.7]]);
  for (const [a, c] of gantry) beam(b, 'steel', a, c, 0.3, undefined, 6);
  // trolley + hook
  b.add(box(5.4, 0.9, 4.0), 'metalDark', { pos: [-26, DECK + 8.9, 0] });
  b.add(box(1.5, 0.7, 1.5), 'steel', { pos: [-26, DECK + 9.7, 0] });
  b.add(box(0.08, 6.4, 0.08), 'darkSteel', { pos: [-26, DECK + 6.2, 0] });
  b.add(box(0.9, 0.7, 0.9), 'signalOrange', { pos: [-26, DECK + 2.8, 0] });
  // deck crane (dynamic: slow idle slew)
  const crane = b.dynamic('deckCrane', { pos: [-4.5, DECK, -8.2] });
  const craneParts = deckCraneParts(-0.55, 1.06);
  for (const key of Object.keys(craneParts)) {
    const geo = mergeParts(craneParts[key].map(([g, t]) => [g, t]));
    crane.add(new THREE.Mesh(geo, M[key]));
  }

  // USV docking cradles (8) with 5 occupied
  const cradleXs = [-34, -41, -48, -55];
  const cradleZs = [-5.4, 5.4];
  let occ = 0;
  for (let i = 0; i < cradleXs.length; i++) {
    for (let j = 0; j < cradleZs.length; j++) {
      const cx = cradleXs[i];
      const cz = cradleZs[j];
      // cradle frame
      for (const sz of [-1, 1]) {
        b.add(box(9.2, 0.28, 0.34), 'metalDark', { pos: [cx, DECK + 0.34, cz + sz * 1.9] });
        b.add(box(9.2, 0.16, 0.22), 'signalOrange', { pos: [cx, DECK + 0.18, cz + sz * 1.9] });
      }
      for (const rx of [-3.4, 3.4]) {
        b.add(box(0.3, 0.9, 3.2), 'metalDark', { pos: [cx + rx, DECK + 0.45, cz] });
        b.add(box(0.5, 0.25, 3.4), 'rubber', { pos: [cx + rx, DECK + 0.9, cz] });
      }
      const occupied = occ % 3 !== 2;
      occ++;
      if (occupied) {
        const ry = (i + j) % 2 === 0 ? 0 : Math.PI;
        deckUSV(b, cx, DECK + 0.95, cz, ry, 8.2, {
          body: j === 0 ? 'pearl' : 'ivory',
          cabin: 'white',
          pod: j === 0 ? 'signalOrange' : 'techCyan',
        });
      }
    }
  }

  // workshops / containers along the deck sides
  container(b, -12.5, DECK + 0.05, -9.0, 0, 7.6, 2.7, 2.5, 'pearl', { accent: true });
  container(b, -21.0, DECK + 0.05, -9.0, 0, 7.6, 2.7, 2.5, 'silver', { accent: false });
  container(b, -21.0, DECK + 2.75, -9.0, 0, 7.6, 2.7, 2.5, 'signalOrange', { accent: false });
  container(b, -13.0, DECK + 0.05, 8.6, 0, 7.6, 2.7, 2.5, 'white', { accent: true });
  // glow window on the workshop container
  b.add(box(1.4, 0.7, 0.1), 'glowWarm', { pos: [-12.5, DECK + 2.1, -7.72] });
  // stern equipment + winch
  b.add(cyl(1.2, 1.2, 3.2, 12), 'metalDark', { pos: [-58.6, DECK + 1.0, 0], rot: [0, 0, Math.PI * 0.5] });
  b.add(box(2.2, 1.3, 2.0), 'silver', { pos: [-56.0, DECK + 0.75, 4.2] });
  b.add(box(1.8, 0.9, 1.6), 'signalOrange', { pos: [-58.0, DECK + 0.55, -5.2] });

  // deck edge railings
  railing(b, -58, -10.9, 7, -10.9, DECK + 0.15, { spacing: 3.2 });
  railing(b, -58, 10.9, 7, 10.9, DECK + 0.15, { spacing: 3.2 });
  railing(b, -58.6, -10.9, -58.6, 10.9, DECK + 0.15, { spacing: 3.0 });
  // bollards
  for (let i = 0; i < 6; i++) {
    const x = -52 + i * 10;
    for (const sz of [-1, 1]) {
      b.add(cyl(0.34, 0.44, 0.8, 8), 'darkSteel', { pos: [x, DECK + 0.55, sz * 11.2] });
      b.add(cyl(0.5, 0.5, 0.16, 8), 'metalDark', { pos: [x, DECK + 0.98, sz * 11.2] });
    }
  }
  // life rings
  for (const sz of [-1, 1]) {
    b.add(torus(0.55, 0.16, 6, 12), 'safetyOrange', { pos: [6.6, DECK + 2.2, sz * 6.4], rot: [Math.PI * 0.5, 0, 0] });
  }
  // warm deck floods under the bridge overhang and on the casing
  for (let i = 0; i < 3; i++) {
    b.add(box(1.1, 0.16, 0.4), 'glowWarm', { pos: [8 + i * 7, DECK + 4.6, 6.1] });
    b.add(box(1.1, 0.16, 0.4), 'glowWarm', { pos: [8 + i * 7, DECK + 4.6, -6.1] });
  }
  b.add(box(0.5, 0.5, 0.5), 'glowWarm', { pos: [-4.3, DECK + 6.2, 0] });

  // ==== comms mast ===========================================================
  const mastX = 35.5;
  const mastBase = DECK + 10.9;
  b.add(cyl(0.5, 0.85, 2.0, 8), 'silver', { pos: [mastX, mastBase + 1.0, 0] });
  b.add(cyl(0.16, 0.36, 13.0, 8), 'white', { pos: [mastX, mastBase + 8.5, 0] });
  for (const [yy, ww] of [
    [mastBase + 6.4, 7.2],
    [mastBase + 10.2, 5.0],
  ]) {
    b.add(box(ww, 0.16, 0.16), 'silver', { pos: [mastX, yy, 0] });
    for (const sz of [-1, 1]) {
      b.add(cyl(0.05, 0.05, 2.4, 5), 'silver', { pos: [mastX, yy + 0.4, sz * ww * 0.5] });
    }
  }
  // satcom domes on the deckhouse roof aft of the mast
  for (const sz of [-1, 1]) {
    b.add(sphere(0.85, 10, 8), 'white', { pos: [mastX - 1.8, DECK + 12.4, sz * 2.6] });
  }
  // whip antennas on the bridge roof
  for (let i = 0; i < 3; i++) {
    b.add(cyl(0.045, 0.065, 5.2 - i * 0.9, 5), 'silver', { pos: [20 + i * 1.6, DECK + 12.4, 5.0] });
  }
  // aviation warning light at the masthead
  b.add(cyl(0.22, 0.22, 0.5, 6), 'darkSteel', { pos: [mastX, mastBase + 15.2, 0] });
  const awning = b.dynamic('mastWarn');
  awning.position.set(mastX, mastBase + 15.7, 0);
  const warnGlow = new THREE.Mesh(sphere(0.42, 8, 6), M.glowRed);
  awning.add(warnGlow);

  // rotating radar bar (dynamic)
  const radar = b.dynamic('radarBar', { pos: [mastX, mastBase + 12.4, 0] });
  const bar = mergeParts([
    [box(6.4, 0.22, 0.6), { pos: [0, 0.3, 0] }],
    [box(2.6, 0.85, 0.14), { pos: [-2.1, 0.72, 0] }],
    [box(2.6, 0.85, 0.14), { pos: [2.1, 0.72, 0] }],
    [cyl(0.34, 0.44, 0.9, 8), { pos: [0, 0, 0] }],
    [box(0.9, 0.28, 0.9), { pos: [0, -0.45, 0] }],
  ]);
  radar.add(new THREE.Mesh(bar, M.silver));

  // ==== build ================================================================
  const root = b.build();
  group.add(root);

  const beacon = awning;
  const craneGroup = crane;
  const radarGroup = radar;

  // ==== animation ============================================================
  const update = (time, dt) => {
    const wx = group.position.x;
    const wz = group.position.z;
    const wave = sampleWave(wx, wz, time);
    // tiny heave + pitch/roll driven by the shared wave field
    const heave = wave.height * 0.72;
    const cosH = Math.cos(HEADING);
    const sinH = Math.sin(HEADING);
    const slopeFwd = wave.dhdx * cosH + wave.dhdz * sinH;
    const slopeSide = -wave.dhdx * sinH + wave.dhdz * cosH;
    const pitch = -slopeFwd * 0.22 + Math.sin(time * 0.33 + WAVE_PHASE) * 0.0045;
    const roll = slopeSide * 0.5 + Math.sin(time * 0.21 + WAVE_PHASE * 2.1) * 0.0075;
    group.position.y = heave;
    group.rotation.set(pitch, -HEADING, roll);

    if (radarGroup) radarGroup.rotation.y = time * 1.15 + 0.6;
    if (craneGroup) craneGroup.rotation.y = -0.55 + Math.sin(time * 0.11 + 0.7) * 0.4;
    if (beacon) beacon.visible = Math.sin(time * 3.4) > 0.1;
  };

  update(0, 0);
  return { group, update };
}


