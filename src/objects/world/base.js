// =============================================================================
// OceanSwarm — near-island research base: engineered apron, quays, piers,
// modular laboratory complex, signature faceted command tower and harbour works.
//
// World layout (config.js): island centre (1760,-2680) r≈300, seaward shoreline
// at z≈-2388; LAYOUT.base = (1690,-2475).
//   • upper apron   220 x 170 m, top y = 11.5, centred on LAYOUT.base
//   • lower quay    on the +Z seaward edge, top y = 8.3, skirt to the water
//   • 3 pile piers  from the lower quay, 100 / 125 / 145 m into open water
//   • rock breakwater at z≈+325 local enclosing the harbour
// All local +Z points seaward; the module group is placed at LAYOUT.base.
//
// API: createBase(materials?) -> { group, update(time, dt) }
// =============================================================================
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { LAYOUT, COLORS } from '../../config.js';
import { waterHeight, sampleWave } from '../../core/waves.js';
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
  smoothstep,
  makeRng,
  fbm2,
  valueNoise2,
  normalizeGeometry,
  matrixFrom,
  hullParts,
} from '../../core/geo.js';
import { makeToon, makeMetal, makeGlow, makeGlass, makeOutline } from '../../core/materials.js';
import { sampleIslandHeight } from './islands.js';

// -----------------------------------------------------------------------------
// layout constants (local frame, +Z = seaward)
// -----------------------------------------------------------------------------
const BX = LAYOUT.base.x;
const BZ = LAYOUT.base.z;
const PLAT = 11.5; // upper apron top
const LOWER = 8.3; // lower quay top
const PIER_TOP = 7.6;
const UP_W = 220;
const UP_D = 170;
const LQ_W = 218;
const LQ_Z0 = 85;
const LQ_Z1 = 140;
const PIER_W = 15;
const PIERS = [
  { x: -52, len: 100 },
  { x: 0, len: 125 },
  { x: 52, len: 145 },
];
const TOWER_X = 6;
const TOWER_Z = -4;
const PLAZA_Y = PLAT + 1.0;
const ANNEX_TOP = PLAZA_Y + 5.0;

// -----------------------------------------------------------------------------
// materials (shared registry + lazy fallback for standalone use / Node tests)
// -----------------------------------------------------------------------------
let _fallbackMaterials = null;

/**
 * Exact rendered island terrain height at a base-local (x, z) position.
 * Returns null over open water / off the island. Used to snap the perimeter
 * rockwork and the landward footpath to the terrain artist's bench.
 */
function groundY(lx, lz) {
  try {
    const y = sampleIslandHeight(BX + lx, BZ + lz);
    return typeof y === 'number' && Number.isFinite(y) ? y : null;
  } catch (err) {
    return null;
  }
}

function buildFallbackMaterials() {
  const M = {
    pearl: makeToon(COLORS.pearl, { rim: 0.22 }),
    white: makeToon(COLORS.white, { rim: 0.16 }),
    ivory: makeToon(COLORS.ivory, { rim: 0.18 }),
    navy: makeToon(COLORS.navy, { rim: 0.14, rimColor: 0x9fd8ff }),
    graphite: makeToon(COLORS.graphite, { rim: 0.12 }),
    darkSteel: makeToon(COLORS.darkSteel, { rim: 0.1 }),
    deckGray: makeToon(COLORS.deckGray, { rim: 0.08 }),
    deckDark: makeToon(COLORS.deckDark, { rim: 0.08 }),
    concrete: makeToon(COLORS.concrete, { rim: 0.06 }),
    black: makeToon(COLORS.black, { rim: 0.02 }),
    rubber: makeToon(COLORS.rubber, { rim: 0.03 }),
    hullBottom: makeToon(COLORS.hullBottom, { rim: 0.05 }),
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
    rock: makeToon(COLORS.rock, { rim: 0.1 }),
    rockDark: makeToon(COLORS.rockDark, { rim: 0.08 }),
    islandRock: makeToon(COLORS.islandRock, { rim: 0.1 }),
    islandRockDark: makeToon(COLORS.islandRockDark, { rim: 0.08 }),
    islandGreen: makeToon(COLORS.islandGreen, { rim: 0.12 }),
    islandGreenDark: makeToon(COLORS.islandGreenDark, { rim: 0.1 }),
    glowCyan: makeGlow(COLORS.neonCyan),
    glowRed: makeGlow(COLORS.navRed),
    glowGreen: makeGlow(COLORS.navGreen),
    glowWarm: makeGlow(COLORS.warmWhite),
    glowOrange: makeGlow(COLORS.signalOrange),
    glowWhite: makeGlow(0xffffff),
    outlineStructure: makeOutline(0.5),
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
// small geometry helpers
// -----------------------------------------------------------------------------
const _up = new THREE.Vector3(0, 1, 0);
const _dir = new THREE.Vector3();
const _mid = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _eul = new THREE.Euler();

function beamBetween(b, key, a, c, radius, tint, seg = 8) {
  _dir.set(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
  const len = _dir.length();
  if (len < 1e-4) return;
  _dir.multiplyScalar(1 / len);
  _quat.setFromUnitVectors(_up, _dir);
  _eul.setFromQuaternion(_quat);
  _mid.set(a[0] + c[0], a[1] + c[1], a[2] + c[2]).multiplyScalar(0.5);
  b.add(cyl(radius, radius, len, seg), key, { pos: [_mid.x, _mid.y, _mid.z], rot: [_eul.x, _eul.y, _eul.z] }, tint);
}

/** Merge [geometry, transform, tint] entries into a single geometry. */
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

/** Posts + two rails along a straight segment in XZ. */
function railing(b, x0, z0, x1, z1, y, opts = {}) {
  const h = opts.height ?? 1.1;
  const mat = opts.mat ?? 'silver';
  const spacing = opts.spacing ?? 3.2;
  const dx = x1 - x0;
  const dz = z1 - z0;
  const len = Math.hypot(dx, dz);
  if (len < 0.2) return;
  const n = Math.max(1, Math.round(len / spacing));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    b.add(box(0.08, h, 0.08), mat, { pos: [x0 + dx * t, y + h * 0.5, z0 + dz * t] });
  }
  const cx = (x0 + x1) * 0.5;
  const cz = (z0 + z1) * 0.5;
  const ry = -Math.atan2(dz, dx);
  b.add(box(len, 0.075, 0.06), mat, { pos: [cx, y + h, cz], rot: [0, ry, 0] });
  b.add(box(len, 0.05, 0.05), mat, { pos: [cx, y + h * 0.55, cz], rot: [0, ry, 0] });
}

/** Irregular faceted rock (displaced icosahedron). */
function rockGeometry(seed, detail = 1, rough = 0.34) {
  const g = new THREE.IcosahedronGeometry(1, detail);
  const pos = g.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const r = Math.hypot(x, y, z) || 1;
    const nx = x / r;
    const ny = y / r;
    const nz = z / r;
    const n = fbm2(nx * 2.4 + seed, nz * 2.4 + ny * 1.8 + seed * 0.7, 4);
    const n2 = valueNoise2(nx * 5.3 + seed, ny * 5.1 - seed);
    const scale = 1 + rough * n + rough * 0.26 * n2;
    pos.setXYZ(i, nx * scale, ny * scale, nz * scale);
  }
  pos.needsUpdate = true;
  g.computeVertexNormals();
  return g;
}

/** Faceted octagonal loft, flat-shaded (for the command tower). */
function octLoft(levels) {
  const verts = [];
  const ringPoint = (lvl, k) => {
    const a = (k / 8) * TAU + (lvl.rot || 0);
    return [Math.cos(a) * lvl.r, lvl.y, Math.sin(a) * lvl.r];
  };
  for (let i = 0; i < levels.length - 1; i++) {
    for (let k = 0; k < 8; k++) {
      const k2 = (k + 1) % 8;
      const a = ringPoint(levels[i], k);
      const b = ringPoint(levels[i + 1], k);
      const c = ringPoint(levels[i + 1], k2);
      const d = ringPoint(levels[i], k2);
      verts.push(...a, ...b, ...c, ...a, ...c, ...d);
    }
  }
  // top cap
  const top = levels[levels.length - 1];
  for (let k = 0; k < 8; k++) {
    const p1 = ringPoint(top, k);
    const p2 = ringPoint(top, (k + 1) % 8);
    verts.push(0, top.y, 0, ...p2, ...p1);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.computeVertexNormals(); // non-indexed => flat facets
  return geo;
}

/** Radius of a loft at height y (linear interpolation between levels). */
function loftRadius(levels, y) {
  for (let i = 0; i < levels.length - 1; i++) {
    const a = levels[i];
    const b = levels[i + 1];
    if (y >= a.y && y <= b.y) return lerp(a.r, b.r, (y - a.y) / (b.y - a.y));
  }
  return levels[levels.length - 1].r;
}

// -----------------------------------------------------------------------------
// sub-assemblies
// -----------------------------------------------------------------------------

/** Solar array on a flat roof or canopy. */
function solarArray(b, cx, cy, cz, w, d, rows = 2) {
  const cols = Math.max(2, Math.round(d / 2.5));
  const pw = w / rows;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const px = cx - w * 0.5 + pw * (r + 0.5);
      const pz = cz - d * 0.5 + (d / cols) * (c + 0.5);
      b.add(box(pw * 0.82, 0.09, (d / cols) * 0.78), 'glass', { pos: [px, cy + 0.72, pz], rot: [-0.34, 0, 0] });
      b.add(box(0.09, 0.6, 0.09), 'silver', { pos: [px - pw * 0.36, cy + 0.3, pz + (d / cols) * 0.3] });
      b.add(box(0.09, 0.95, 0.09), 'silver', { pos: [px + pw * 0.36, cy + 0.45, pz + (d / cols) * 0.3] });
    }
  }
  b.add(box(w, 0.1, d), 'silver', { pos: [cx, cy + 0.08, cz] });
}

/** Flat roof props: vents, HVAC, whips and aerials. */
function roofKit(b, cx, cy, cz, w, d, opts = {}) {
  const rng = opts.rng || makeRng(4);
  b.add(box(2.8, 1.15, 1.9), 'silver', { pos: [cx + w * 0.22, cy + 0.6, cz - d * 0.18] });
  b.add(box(1.9, 0.9, 1.5), 'silver', { pos: [cx - w * 0.24, cy + 0.45, cz + d * 0.16] });
  b.add(cyl(0.4, 0.48, 0.9, 8), 'metalDark', { pos: [cx + w * 0.02, cy + 0.45, cz + d * 0.26] });
  b.add(cyl(0.28, 0.34, 0.7, 8), 'metalDark', { pos: [cx + w * 0.1, cy + 0.35, cz - d * 0.28] });
  // equipment cabinet + lightning whips
  b.add(box(1.5, 1.6, 0.9), 'pearl', { pos: [cx - w * 0.38, cy + 0.8, cz - d * 0.3] });
  for (let i = 0; i < 2; i++) {
    const ax = cx + w * (i ? 0.34 : -0.06);
    const az = cz + d * 0.3;
    b.add(cyl(0.045, 0.07, 4.2 - i * 1.5, 5), 'silver', { pos: [ax, cy + 2.1 - i * 0.75, az] });
    b.add(sphere(0.11, 6, 4), 'glowRed', { pos: [ax, cy + 4.2 - i * 1.5, az] });
  }
  if (opts.satDish) {
    b.add(cyl(0.06, 0.08, 1.2, 5), 'silver', { pos: [cx + w * 0.3, cy + 1.6, cz + d * 0.2] });
    b.add(torus(0.65, 0.07, 4, 12), 'white', { pos: [cx + w * 0.3, cy + 2.5, cz + d * 0.2], rot: [0.5, 0.6, 0] });
  }
}

/** Cylindrical lamp mast with a warm-white head. */
function lampMast(b, x, z, y0, height, opts = {}) {
  const key = opts.key ?? 'metalDark';
  b.add(cyl(0.13, 0.2, height, 6), key, { pos: [x, y0 + height * 0.5, z] });
  b.add(box(0.16, 0.16, 1.5), key, { pos: [x, y0 + height - 0.05, z + 0.75] });
  b.add(box(0.95, 0.3, 0.65), 'darkSteel', { pos: [x, y0 + height - 0.24, z + 1.45] });
  b.add(sphere(0.62, 8, 6), 'glowWarm', { pos: [x, y0 + height - 0.58, z + 1.45] });
  b.add(cyl(0.35, 0.5, 0.45, 8), 'concrete', { pos: [x, y0 + 0.2, z] });
}

/** Short quay bollard. */
function bollard(b, x, z, y) {
  b.add(cyl(0.42, 0.52, 0.95, 8), 'darkSteel', { pos: [x, y + 0.47, z] });
  b.add(cyl(0.6, 0.6, 0.18, 8), 'metalDark', { pos: [x, y + 1.0, z] });
  b.add(cyl(0.24, 0.24, 0.35, 8), 'silver', { pos: [x, y + 0.2, z] });
}

/** Horizontal rubber fender against a quay / pier face. */
function fender(b, x, y, z, rotY = 0, len = 2.0) {
  b.add(cyl(0.42, 0.42, len, 8), 'rubber', { pos: [x, y, z], rot: [0, rotY, Math.PI * 0.5] });
  b.add(box(0.24, 0.9, len * 0.9), 'metalDark', { pos: [x, y, z], rot: [0, rotY, 0] });
}

/** Automatic mooring unit (vacuum pad on a short pedestal). */
function autoMooring(b, x, z, y) {
  b.add(box(1.5, 0.7, 1.5), 'concrete', { pos: [x, y + 0.35, z] });
  b.add(cyl(0.55, 0.7, 1.2, 10), 'silver', { pos: [x, y + 1.2, z] });
  b.add(cyl(0.75, 0.6, 0.55, 10), 'signalOrange', { pos: [x, y + 1.95, z] });
  b.add(sphere(0.42, 10, 8), 'metalDark', { pos: [x, y + 2.35, z] });
  b.add(cyl(0.07, 0.07, 0.8, 5), 'silver', { pos: [x + 0.75, y + 1.5, z] });
}

/** Small pedestal jib crane / hoist used on the quay and piers. */
function jibCrane(b, x, z, y, opts = {}) {
  const s = opts.scale ?? 1;
  const rot = opts.rot ?? 0;
  const dx = Math.cos(rot);
  const dz = -Math.sin(rot);
  b.add(cyl(1.0 * s, 1.25 * s, 0.9 * s, 10), 'metalDark', { pos: [x, y + 0.45 * s, z] });
  b.add(cyl(0.45 * s, 0.45 * s, 2.6 * s, 8), 'silver', { pos: [x, y + 2.0 * s, z] });
  b.add(box(1.7 * s, 1.2 * s, 1.5 * s), 'white', { pos: [x, y + 3.5 * s, z], rot: [0, rot, 0] });
  b.add(box(1.2 * s, 0.5 * s, 0.16), 'glass', { pos: [x + dx * 0.82 * s, y + 3.7 * s, z + dz * 0.82 * s], rot: [0, rot, 0] });
  const bl = (opts.boom ?? 9) * s;
  const tilt = 0.6;
  const pivY = y + 3.95 * s;
  const boom = frustum(bl, 0.6 * s, 0.8 * s, 0.55, 0.5);
  boom.rotateZ(tilt);
  const bcx = x + dx * bl * 0.5 * Math.cos(tilt);
  const bcy = pivY + bl * 0.5 * Math.sin(tilt);
  const bcz = z + dz * bl * 0.5 * Math.cos(tilt);
  b.add(boom, opts.boomKey ?? 'safetyOrange', { pos: [bcx, bcy, bcz], rot: [0, rot, 0] });
  const tipX = x + dx * bl * Math.cos(tilt);
  const tipY = pivY + bl * Math.sin(tilt);
  const tipZ = z + dz * bl * Math.cos(tilt);
  const hookY = y + 1.9 * s;
  b.add(box(0.06, Math.max(0.5, tipY - hookY), 0.06), 'darkSteel', { pos: [tipX, (tipY + hookY) * 0.5, tipZ] });
  b.add(box(0.45 * s, 0.4 * s, 0.45 * s), 'metalDark', { pos: [tipX, hookY, tipZ] });
  b.add(box(0.5 * s, 0.3 * s, 0.5 * s), 'glowWarm', { pos: [x, y + 4.4 * s, z] });
}

/** Small stylised 8-9 m USV prototype, merged per material in local space. */
function makeUSVProtos(M) {
  const len = 8.6;
  const spec = {
    length: len,
    beam: len * 0.36,
    draft: len * 0.055,
    freeboard: len * 0.09,
    sheer: len * 0.014,
    bowSharp: 1.02,
    flare: 0.2,
    rocker: 0.55,
    sternWidth: 0.9,
    camber: 0.05,
    rake: 0.2,
    sectionPower: 2.15,
    uSegments: 18,
    rowsLower: 3,
    rowsUpper: 3,
  };
  const hull = hullParts(spec);
  const buckets = {
    deckDark: [[hull.lower, {}], [hull.deck, {}], [box(1.1, 0.3, 2.0), { pos: [0.4, 0.45, 0] }]],
    pearl: [
      [hull.topsides, {}],
      [hull.transom, {}],
      [box(1.5, 0.35, 1.4), { pos: [-0.6, 1.05, 0] }],
      [box(1.9, 1.05, len * 0.22), { pos: [-1.2, 1.35, 0] }],
      [cyl(0.05, 0.07, 1.7, 5), { pos: [-2.4, 1.9, 0] }],
      [box(0.5, 0.5, 0.5), { pos: [-2.4, 2.95, 0] }],
    ],
    glass: [[box(1.95, 0.42, len * 0.235), { pos: [-1.15, 1.72, 0] }]],
    signalOrange: [
      [box(len * 0.6, 0.14, 0.07), { pos: [0.3, 0.62, len * 0.18] }],
      [box(len * 0.6, 0.14, 0.07), { pos: [0.3, 0.62, -len * 0.18] }],
      [box(0.55, 0.18, 0.55), { pos: [-2.4, 2.6, 0] }],
    ],
    glowWarm: [
      [box(0.7, 0.16, 0.12), { pos: [2.2, 0.55, 0] }],
      [sphere(0.09, 6, 4), { pos: [2.4, 0.65, 0] }],
    ],
  };
  const out = {};
  for (const key of Object.keys(buckets)) {
    out[key] = mergeParts(buckets[key]);
  }
  return out;
}

/** Small quay service vehicle (van / pickup). */
function utilityVan(b, x, z, y, ry, bodyKey = 'white') {
  const c = Math.cos(ry);
  const s = Math.sin(ry);
  const at = (lx, lz) => [x + lx * c + lz * s, z - lx * s + lz * c];
  b.add(rbox(5.2, 1.35, 2.2, 0.3, 2), bodyKey, { pos: [x, y + 1.35, z], rot: [0, ry, 0] });
  b.add(rbox(2.0, 1.15, 2.05, 0.3, 2), 'glass', { pos: [at(-1.5, 0)[0], y + 2.2, at(-1.5, 0)[1]], rot: [0, ry, 0] });
  b.add(box(0.12, 0.5, 2.06), 'signalOrange', { pos: [at(1.7, 0)[0], y + 1.5, at(1.7, 0)[1]], rot: [0, ry, 0] });
  for (const [wx, wz] of [
    [-1.6, -1.05],
    [-1.6, 1.05],
    [1.6, -1.05],
    [1.6, 1.05],
  ]) {
    const [px, pz] = at(wx, wz);
    b.add(cyl(0.42, 0.42, 0.32, 10), 'rubber', { pos: [px, y + 0.45, pz], rot: [Math.PI * 0.5, 0, 0] });
  }
  b.add(box(0.5, 0.16, 0.24), 'glowWarm', { pos: [at(2.1, 0)[0], y + 1.1, at(2.1, 0)[1]], rot: [0, ry, 0] });
}

/** Ribbed shipping / workshop container. */
function container(b, cx, cy, cz, len, hgt, wid, bodyKey, opts = {}) {
  const ry = opts.rot ?? 0;
  const c = Math.cos(ry);
  const s = Math.sin(ry);
  b.add(box(len, hgt, wid), bodyKey, { pos: [cx, cy + hgt * 0.5, cz], rot: [0, ry, 0] });
  const ribN = Math.max(4, Math.floor(len / 1.1));
  for (let i = 0; i <= ribN; i++) {
    const lx = -len * 0.5 + 0.18 + ((len - 0.36) * i) / ribN;
    for (const sz of [-1, 1]) {
      const wx = cx + lx * c + (sz * wid * 0.5 + sz * 0.03) * s;
      const wz = cz - lx * s + (sz * wid * 0.5 + sz * 0.03) * c;
      b.add(box(0.14, hgt * 0.9, 0.09), 'metalDark', { pos: [wx, cy + hgt * 0.5, wz], rot: [0, ry, 0] });
    }
  }
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const wx = cx + sx * len * 0.48 * c + sz * wid * 0.48 * s;
      const wz = cz - sx * len * 0.48 * s + sz * wid * 0.48 * c;
      b.add(box(0.24, hgt + 0.06, 0.24), 'metalDark', { pos: [wx, cy + hgt * 0.5, wz], rot: [0, ry, 0] });
    }
  }
  b.add(box(len - 0.2, 0.12, wid - 0.2), 'silver', { pos: [cx, cy + hgt + 0.02, cz], rot: [0, ry, 0] });
  if (opts.accent) {
    const ax = cx + (len * 0.2) * c;
    const az = cz - (len * 0.2) * s;
    b.add(box(len * 0.22, 0.55, wid + 0.05), 'signalOrange', { pos: [ax, cy + hgt * 0.72, az], rot: [0, ry, 0] });
  }
  if (opts.lit) {
    const lx = cx - (len * 0.2) * c;
    const lz = cz + (len * 0.2) * s + wid * 0.5 + 0.02;
    b.add(box(1.4, 0.55, 0.1), 'glowWarm', { pos: [lx, cy + hgt * 0.62, lz], rot: [0, ry, 0] });
  }
}

/** Enclosed elevated walkway between two points on the apron. */
function skywalk(b, x0, z0, x1, z1, yTop) {
  const dx = x1 - x0;
  const dz = z1 - z0;
  const len = Math.hypot(dx, dz);
  if (len < 4) return;
  const ry = -Math.atan2(dz, dx);
  const cx = (x0 + x1) * 0.5;
  const cz = (z0 + z1) * 0.5;
  const TUBE_H = 3.1;
  const TUBE_W = 3.4;
  const yc = yTop - TUBE_H * 0.5;
  // floor slab, glass sides, roof
  b.add(box(len, 0.35, TUBE_W), 'deckGray', { pos: [cx, yc - TUBE_H * 0.5 + 0.17, cz], rot: [0, ry, 0] });
  b.add(box(len, TUBE_H * 0.82, 0.16), 'glassLight', { pos: [cx, yc, cz + TUBE_W * 0.5], rot: [0, ry, 0] });
  b.add(box(len, TUBE_H * 0.82, 0.16), 'glassLight', { pos: [cx, yc, cz - TUBE_W * 0.5], rot: [0, ry, 0] });
  b.add(box(len, 0.28, TUBE_W + 0.4), 'pearl', { pos: [cx, yTop, cz], rot: [0, ry, 0] });
  // ribs + warm lit inner line
  const n = Math.max(2, Math.round(len / 4.0));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const px = x0 + dx * t;
    const pz = z0 + dz * t;
    b.add(box(0.22, TUBE_H, TUBE_W + 0.28), 'silver', { pos: [px, yc, pz], rot: [0, ry, 0] });
  }
  b.add(box(len, 0.1, 0.1), 'glowWarm', { pos: [cx, yc + TUBE_H * 0.32, cz], rot: [0, ry, 0] });
  // support columns
  const cn = Math.max(1, Math.round(len / 13));
  for (let i = 1; i < cn; i++) {
    const t = i / cn;
    const px = x0 + dx * t;
    const pz = z0 + dz * t;
    b.add(cyl(0.24, 0.32, yTop - TUBE_H - PLAT, 8), 'silver', { pos: [px, PLAT + (yTop - TUBE_H - PLAT) * 0.5, pz] });
    b.add(box(1.2, 0.4, 1.2), 'concrete', { pos: [px, PLAT + 0.2, pz] });
  }
  // vertical access towers at both ends
  for (const [ex, ez] of [
    [x0, z0],
    [x1, z1],
  ]) {
    b.add(box(3.0, yTop - PLAT + 1.4, 3.0), 'pearl', { pos: [ex, PLAT + (yTop - PLAT + 1.4) * 0.5, ez] });
    b.add(box(3.1, 0.3, 3.1), 'silver', { pos: [ex, yTop + 0.4, ez] });
    b.add(box(0.9, 2.1, 0.14), 'glass', { pos: [ex, PLAT + 1.4, ez + 1.54] });
    b.add(box(1.1, 0.14, 0.3), 'glowWarm', { pos: [ex, yTop - 0.7, ez + 1.6] });
  }
}

/** Modular lab / admin building. */
function labBuilding(b, cfg) {
  const {
    x,
    z,
    w,
    d,
    h,
    floors = 2,
    body = 'pearl',
    glassKey = 'glass',
    rng = makeRng(1),
    helipad = false,
    hangarDoor = false,
    solar = true,
  } = cfg;
  const y0 = PLAT + 0.25;
  // foundation plinth + apron
  b.add(box(w + 2.8, 1.6, d + 2.8), 'concrete', { pos: [x, y0 - 0.8, z] });
  b.add(box(w + 1.6, 0.18, d + 1.6), 'deckGray', { pos: [x, y0 + 0.1, z] });
  b.solid(box(w, h, d), body, { pos: [x, y0 + h * 0.5, z] });
  // corner fins
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      b.add(box(0.6, h, 0.6), 'silver', { pos: [x + sx * (w * 0.5 - 0.15), y0 + h * 0.5, z + sz * (d * 0.5 - 0.15)] });
    }
  }
  const fh = h / floors;
  for (let f = 0; f < floors; f++) {
    const fy = y0 + fh * (f + 0.56);
    // seaward glazing band + mullions
    if (!hangarDoor || f > 0) {
      b.add(box(w - 2.4, fh * 0.44, 0.2), glassKey, { pos: [x, fy, z + d * 0.5 + 0.03] });
      const n = Math.max(3, Math.round((w - 2.4) / 3.1));
      for (let i = 0; i <= n; i++) {
        b.add(box(0.2, fh * 0.5, 0.3), 'silver', { pos: [x - (w - 2.4) * 0.5 + ((w - 2.4) * i) / n, fy, z + d * 0.5 + 0.13] });
      }
    }
    // side glazing bands
    for (const sx of [-1, 1]) {
      b.add(box(0.2, fh * 0.44, d - 2.4), glassKey, { pos: [x + sx * (w * 0.5 + 0.03), fy, z] });
      const n = Math.max(2, Math.round((d - 2.4) / 3.4));
      for (let i = 0; i <= n; i++) {
        b.add(box(0.3, fh * 0.5, 0.2), 'silver', { pos: [x + sx * (w * 0.5 + 0.13), fy, z - (d - 2.4) * 0.5 + ((d - 2.4) * i) / n] });
      }
    }
    // warm lit windows on the shaded landward side
    const wk = Math.max(3, Math.round((w - 4) / 4.2));
    for (let i = 0; i < wk; i++) {
      if ((i + f) % 3 === 2) continue;
      b.add(box(2.3, fh * 0.3, 0.13), 'glassWarm', { pos: [x - (w - 4) * 0.5 + ((w - 4) * (i + 0.5)) / wk, fy, z - d * 0.5 - 0.03] });
    }
    b.add(box(w + 0.3, 0.14, d + 0.3), 'silver', { pos: [x, y0 + fh * f + 0.1, z] });
  }
  // parapet
  b.add(box(w + 0.4, 0.55, 0.32), 'silver', { pos: [x, y0 + h + 0.27, z + d * 0.5] });
  b.add(box(w + 0.4, 0.55, 0.32), 'silver', { pos: [x, y0 + h + 0.27, z - d * 0.5] });
  b.add(box(0.32, 0.55, d), 'silver', { pos: [x + w * 0.5, y0 + h + 0.27, z] });
  b.add(box(0.32, 0.55, d), 'silver', { pos: [x - w * 0.5, y0 + h + 0.27, z] });
  b.add(box(w - 0.4, 0.16, d - 0.4), 'deckGray', { pos: [x, y0 + h + 0.08, z] });
  const roofY = y0 + h + 0.2;
  if (hangarDoor) {
    // big workshop door on the seaward face
    b.add(box(w * 0.62, h * 0.72, 0.3), 'darkSteel', { pos: [x, y0 + h * 0.36, z + d * 0.5 + 0.1] });
    for (let i = 0; i < 5; i++) {
      b.add(box(w * 0.62, 0.16, 0.34), 'metalDark', { pos: [x, y0 + h * 0.12 + i * h * 0.13, z + d * 0.5 + 0.16] });
    }
    b.add(box(w * 0.68, 0.35, 0.5), 'signalOrange', { pos: [x, y0 + h * 0.74, z + d * 0.5 + 0.2] });
    b.add(box(w * 0.68, 0.35, 0.5), 'signalOrange', { pos: [x, y0 + 0.4, z + d * 0.5 + 0.2] });
    b.add(box(0.5, 0.5, 0.12), 'glowWarm', { pos: [x + w * 0.22, y0 + h * 0.7, z + d * 0.5 + 0.35] });
  } else {
    // entrance + canopy
    b.add(box(5.6, 3.2, 0.3), 'darkSteel', { pos: [x, y0 + 1.6, z + d * 0.5 + 0.06] });
    b.add(box(6.2, 0.42, 0.7), 'signalOrange', { pos: [x, y0 + 3.4, z + d * 0.5 + 0.1] });
    b.add(box(6.8, 0.3, 2.4), 'white', { pos: [x, y0 + 3.8, z + d * 0.5 + 1.1] });
    b.add(box(0.6, 0.5, 0.14), 'glowWarm', { pos: [x + 2.2, y0 + 1.4, z + d * 0.5 + 0.2] });
  }
  if (solar) {
    const sw = Math.min(w * 0.5, 18);
    solarArray(b, x - w * 0.18, roofY, z - d * 0.12, sw, d * 0.5, 2);
  }
  roofKit(b, x + w * 0.16, roofY, z + d * 0.02, Math.min(w * 0.6, 20), Math.min(d * 0.6, 12), { rng, satDish: cfg.satDish });
  if (helipad) {
    const r = Math.min(w, d) * 0.31;
    const padY = roofY + 0.35;
    b.add(cyl(r + 0.8, r + 0.8, 0.7, 20), 'deckGray', { pos: [x, padY, z] });
    b.add(ring(r - 0.6, r, 28), 'white', { pos: [x, padY + 0.37, z] });
    b.add(ring(r * 0.44, r * 0.53, 18), 'white', { pos: [x, padY + 0.38, z] });
    b.add(disc(r * 0.18, 10), 'white', { pos: [x, padY + 0.38, z] });
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * TAU;
      b.add(box(0.36, 0.14, 0.36), 'glowWarm', { pos: [x + Math.cos(a) * (r + 0.35), padY + 0.45, z + Math.sin(a) * (r + 0.35)] });
    }
    // windsock on the pad edge
    b.add(cyl(0.06, 0.09, 3.4, 5), 'silver', { pos: [x - r + 1.2, roofY + 1.9, z + r - 1.0] });
    const sock = cyl(0.08, 0.34, 1.5, 8, true);
    sock.rotateZ(Math.PI * 0.5 - 0.18);
    b.add(sock, 'safetyOrange', { pos: [x - r + 2.9, roofY + 3.5, z + r - 1.0], rot: [0, 0.5, 0] });
    b.add(box(0.55, 0.14, 0.3), 'white', { pos: [x - r + 2.55, roofY + 3.62, z + r - 0.85], rot: [0, 0.5, 0.18] });
  }
}

// -----------------------------------------------------------------------------
// createBase
// -----------------------------------------------------------------------------
export function createBase(materials) {
  const M = resolveMaterials(materials);
  const mats = Object.create(M);
  mats.safetyYellow = makeToon(0xf2c31c, { rim: 0.14 });
  mats.palmTrunk = makeToon(0x8a7355, { rim: 0.08 });
  mats.palmLeaf = makeToon(0x4e8a5e, { rim: 0.12 });

  const b = new Builder(mats, { outlineMaterial: M.outlineStructure || null });
  const rng = makeRng(20261022);

  const group = new THREE.Group();
  group.name = 'seaBase';
  group.position.set(BX, 0, BZ);

  const usvMeshes = [];
  let usvDefs = [];
  let towerRadar = null;
  let quayCrane = null;
  let towerBeaconY = PLAZA_Y + 50;

  // ===========================================================================
  // 1. apron platform, foundation & seaward quay
  // ===========================================================================
  // upper apron slab (visible sides read as a concrete caisson wall)
  b.add(box(UP_W, 3.4, UP_D), 'concrete', { pos: [0, PLAT - 1.7, 0] });
  // apron surface tone panels
  b.add(box(UP_W - 2, 0.16, UP_D - 2), 'deckGray', { pos: [0, PLAT + 0.06, 0] });
  // seaward working strip (lighter concrete so the apron reads pearl-white/cool grey)
  b.add(box(UP_W - 6, 0.1, 30), 'deckGray', { pos: [0, PLAT + 0.16, 68] });
  // inner service road + painted lane markings
  b.add(box(11, 0.1, 128), 'deckDark', { pos: [0, PLAT + 0.16, -14] });
  for (let i = 0; i < 15; i++) {
    b.add(box(0.35, 0.05, 3.4), 'white', { pos: [0, PLAT + 0.24, -72 + i * 8.6] });
  }
  for (const sx of [-1, 1]) {
    b.add(box(0.22, 0.06, 128), 'signalOrange', { pos: [sx * 6.2, PLAT + 0.23, -14] });
  }
  // cross road to the piers
  b.add(box(190, 0.1, 8), 'deckDark', { pos: [0, PLAT + 0.18, 52] });
  for (const sx of [-1, 1]) {
    b.add(box(190, 0.05, 0.3), 'signalOrange', { pos: [0, PLAT + 0.23, 52 + sx * 4.2] });
  }
  // expansion joints
  for (let i = -4; i <= 4; i++) {
    b.add(box(UP_W - 8, 0.05, 0.22), 'darkSteel', { pos: [0, PLAT + 0.15, i * 19] });
  }
  for (let i = -4; i <= 4; i++) {
    b.add(box(0.22, 0.05, UP_D - 8), 'darkSteel', { pos: [i * 22, PLAT + 0.15, 0] });
  }
  // concrete edge coping / curb around the apron
  for (const sz of [-1, 1]) {
    b.add(box(UP_W, 0.5, 0.7), 'concrete', { pos: [0, PLAT + 0.35, sz * (UP_D * 0.5 - 0.35)] });
  }
  for (const sx of [-1, 1]) {
    b.add(box(0.7, 0.5, UP_D), 'concrete', { pos: [sx * (UP_W * 0.5 - 0.35), PLAT + 0.35, 0] });
  }
  // quay edge bollards + lamps along the apron's seaward edge
  for (let i = 0; i < 9; i++) {
    const x = -100 + i * 25;
    const pierGap = PIERS.some((p) => Math.abs(p.x - x) < 12);
    if (!pierGap) bollard(b, x, 82, PLAT + 0.15);
  }
  for (let i = 0; i < 6; i++) lampMast(b, -102 + i * 40.8, 78.5, PLAT + 0.15, 9.5);
  railing(b, -UP_W * 0.5 + 1, UP_D * 0.5 - 1.2, -90, UP_D * 0.5 - 1.2, PLAT + 0.5, { spacing: 3.6 });
  railing(b, 90, UP_D * 0.5 - 1.2, UP_W * 0.5 - 1, UP_D * 0.5 - 1.2, PLAT + 0.5, { spacing: 3.6 });

  // retaining face between upper apron and lower quay
  b.add(box(UP_W, 3.4, 1.2), 'concrete', { pos: [0, PLAT - 1.7, UP_D * 0.5 + 0.6] });
  // two grand stairs + a vehicle ramp down to the lower quay
  for (const sx of [-1, 1]) {
    const sxp = sx * 26;
    for (let i = 0; i < 5; i++) {
      b.add(box(9, 0.42, 1.5), 'concrete', { pos: [sxp, PLAT - 0.3 - i * 0.42, UP_D * 0.5 + 1.2 + i * 1.35] });
    }
    railing(b, sxp - 4, UP_D * 0.5 + 1.2, sxp - 4, UP_D * 0.5 + 8.0, PLAT - 1.5, { spacing: 2.0 });
    railing(b, sxp + 4, UP_D * 0.5 + 1.2, sxp + 4, UP_D * 0.5 + 8.0, PLAT - 1.5, { spacing: 2.0 });
  }
  // lower quay slab (over the water, founded on a rock/concrete toe; deep
  // enough that its underside meets the beach at the landward edge)
  b.add(box(LQ_W, 7.0, LQ_Z1 - LQ_Z0), 'concrete', { pos: [0, LOWER - 3.5, (LQ_Z0 + LQ_Z1) * 0.5] });
  b.add(box(LQ_W - 2, 0.14, LQ_Z1 - LQ_Z0 - 1), 'deckGray', { pos: [0, LOWER + 0.06, (LQ_Z0 + LQ_Z1) * 0.5] });
  b.add(box(LQ_W - 4, 0.1, 26), 'deckDark', { pos: [0, LOWER + 0.14, 122] });
  for (let i = 0; i < 7; i++) {
    b.add(box(0.28, 0.05, 26), 'white', { pos: [-36 + i * 12, LOWER + 0.2, 122] });
  }
  // lower quay seaward wall down to the seabed + coping
  b.add(box(LQ_W, 13.5, 3.2), 'concrete', { pos: [0, LOWER - 6.75, LQ_Z1 + 1.6] });
  b.add(box(LQ_W, 0.55, 1.0), 'concrete', { pos: [0, LOWER + 0.3, LQ_Z1 - 0.5] });
  // lower quay side walls (no visible underside from the flanks)
  for (const sx of [-1, 1]) {
    b.add(box(3.2, 13.5, LQ_Z1 - LQ_Z0 + 3.2), 'concrete', { pos: [sx * (LQ_W * 0.5 + 1.6), LOWER - 6.75, (LQ_Z0 + LQ_Z1) * 0.5] });
  }
  // wall joints + fenders + bollards + auto mooring
  for (let i = 0; i < 11; i++) {
    b.add(box(0.16, 12.8, 0.2), 'darkSteel', { pos: [-80 + i * 16, LOWER - 6.7, LQ_Z1 + 3.22] });
  }
  for (let i = 0; i < 12; i++) {
    const x = -82 + i * 14.9;
    fender(b, x, LOWER - 2.6, LQ_Z1 + 3.5);
  }
  for (let i = 0; i < 7; i++) {
    const x = -78 + i * 26;
    bollard(b, x, LQ_Z1 - 2.2, LOWER + 0.15);
  }
  for (const p of PIERS) {
    autoMooring(b, p.x - 4.5, LQ_Z1 - 4.5, LOWER + 0.15);
    autoMooring(b, p.x + 4.5, LQ_Z1 - 4.5, LOWER + 0.15);
  }
  for (const sx of [-1, 1]) {
    for (let i = 0; i < 4; i++) fender(b, sx * (LQ_W * 0.5 + 0.2), LOWER - 2.8, 96 + i * 12, Math.PI * 0.5);
    bollard(b, sx * (LQ_W * 0.5 - 1.4), LQ_Z0 + 4, LOWER + 0.15);
  }
  // lamps + railings on the lower quay
  for (let i = 0; i < 4; i++) lampMast(b, -84 + i * 56, LQ_Z1 - 2.2, LOWER + 0.15, 8.0);
  // pier roots: low guide lights + hazard chevrons
  for (const p of PIERS) {
    for (let i = 0; i < 5; i++) {
      b.add(box(0.6, 0.1, 0.6), 'glowWarm', { pos: [p.x - PIER_W * 0.5, LOWER + 0.22, LQ_Z1 + 1.4 + i * 1.6] });
      b.add(box(0.6, 0.1, 0.6), 'glowWarm', { pos: [p.x + PIER_W * 0.5, LOWER + 0.22, LQ_Z1 + 1.4 + i * 1.6] });
    }
  }
  // rock revetment skirt around the platform's seaward + side edges
  const revetRng = makeRng(90210);
  function revetmentLine(x0, z0, x1, z1, count, baseY, spread, snapToGround = false) {
    for (let i = 0; i < count; i++) {
      const t = i / Math.max(1, count - 1);
      const px = lerp(x0, x1, t) + revetRng.range(-spread, spread);
      const pz = lerp(z0, z1, t) + revetRng.range(-spread * 0.7, spread * 0.7);
      const s = revetRng.range(1.6, 4.6);
      let anchorY = baseY;
      if (snapToGround) {
        const gy = groundY(px, pz);
        if (gy !== null && gy > -1.5) anchorY = gy + 0.3;
      }
      const g = rockGeometry(revetRng.range(0, 80), revetRng.chance(0.45) ? 1 : 0, 0.4);
      g.scale(s * 1.15, s * 0.75, s * 1.1);
      g.rotateY(revetRng.range(0, TAU));
      g.translate(px, anchorY + revetRng.range(-1.4, 0.6) - s * 0.2, pz);
      b.add(g, revetRng.chance(0.4) ? 'rockDark' : 'islandRock');
      g.dispose();
    }
  }
  // toe of the lower-quay wall
  revetmentLine(-LQ_W * 0.5, LQ_Z1 + 4.0, LQ_W * 0.5, LQ_Z1 + 4.0, 52, 1.6, 2.4);
  // apron side skirts (snapped onto the natural bench)
  revetmentLine(-UP_W * 0.5 - 1.5, -UP_D * 0.5 + 4, -UP_W * 0.5 - 1.5, UP_D * 0.5 - 4, 26, 9.0, 2.2, true);
  revetmentLine(UP_W * 0.5 + 1.5, -UP_D * 0.5 + 4, UP_W * 0.5 + 1.5, UP_D * 0.5 - 4, 26, 9.0, 2.2, true);
  // landward skirt (blends the apron into the island bench)
  revetmentLine(-UP_W * 0.5 + 4, -UP_D * 0.5 - 2.0, UP_W * 0.5 - 4, -UP_D * 0.5 - 2.0, 44, 9.2, 2.6, true);
  // riprap wedges where the upper apron steps down to the lower quay
  for (const sx of [-1, 1]) {
    revetmentLine(sx * (LQ_W * 0.5 - 4), UP_D * 0.5 + 2.5, sx * (LQ_W * 0.5 + 1), UP_D * 0.5 + 2.5, 8, 9.2, 1.4);
  }
  // loose boulders scattered over the natural bench around the apron so the
  // concrete pad reads as founded on the island rather than dropped on it
  {
    const scatterRng = makeRng(77113);
    let placed = 0;
    for (let attempt = 0; attempt < 420 && placed < 52; attempt++) {
      const lx = scatterRng.range(-200, 200);
      const lz = scatterRng.range(-180, 190);
      // keep clear of the slab + lower quay + pier lanes
      if (Math.abs(lx) < UP_W * 0.5 + 5 && lz > -UP_D * 0.5 - 6 && lz < LQ_Z1 + 8) continue;
      if (lz > 120 && PIERS.some((p) => Math.abs(lx - p.x) < 22)) continue;
      const gy = groundY(lx, lz);
      if (gy === null || gy < 1.2) continue;
      const s = scatterRng.range(1.1, 3.6);
      const g = rockGeometry(scatterRng.range(0, 90), scatterRng.chance(0.22) ? 1 : 0, 0.42);
      g.scale(s * 1.2, s * 0.7, s * 1.1);
      g.rotateY(scatterRng.range(0, TAU));
      g.translate(lx, gy + s * 0.16, lz);
      b.add(g, scatterRng.chance(0.5) ? 'islandRock' : 'rockDark');
      g.dispose();
      placed++;
    }
  }
  // landward footpath: steps off the apron back edge, then flagstone slabs
  // following the bench down toward the island interior
  {
    const stepX = -26;
    for (let i = 0; i < 3; i++) {
      b.add(box(16, 0.38, 1.5), 'concrete', { pos: [stepX, PLAT - 0.25 - i * 0.38, -UP_D * 0.5 - 0.9 - i * 1.45] });
    }
    const pathRng = makeRng(4242);
    for (let i = 0; i < 7; i++) {
      const lx = stepX + Math.sin(i * 0.7) * 5;
      const lz = -UP_D * 0.5 - 6.5 - i * 7.5;
      const gy = groundY(lx, lz);
      if (gy === null) continue;
      b.add(box(8.5, 0.26, 6.0), 'concrete', { pos: [lx + pathRng.range(-0.4, 0.4), gy + 0.1, lz], rot: [0, pathRng.range(-0.12, 0.12), 0] });
    }
    // small landing pad + lamp at the apron back edge
    b.add(box(9, 0.3, 6), 'deckGray', { pos: [stepX, PLAT - 0.05, -UP_D * 0.5 - 1.2] });
    lampMast(b, stepX - 5.5, -UP_D * 0.5 - 2.5, PLAT - 0.4, 6.5);
  }

  // ===========================================================================
  // 2. three pile piers
  // ===========================================================================
  for (let pi = 0; pi < PIERS.length; pi++) {
    const p = PIERS[pi];
    const z0 = LQ_Z1;
    const zc = z0 + p.len * 0.5;
    // deck slab + anti-slip surface + curbs
    b.add(box(PIER_W, 1.7, p.len), 'concrete', { pos: [p.x, PIER_TOP - 0.85, zc] });
    b.add(box(PIER_W - 0.3, 0.12, p.len - 0.4), 'deckDark', { pos: [p.x, PIER_TOP + 0.03, zc] });
    for (const sx of [-1, 1]) {
      b.add(box(0.35, 0.42, p.len), 'concrete', { pos: [p.x + sx * (PIER_W * 0.5 - 0.17), PIER_TOP + 0.28, zc] });
      b.add(box(0.12, 0.1, p.len - 0.6), 'safetyYellow', { pos: [p.x + sx * (PIER_W * 0.5 - 0.4), PIER_TOP + 0.1, zc] });
    }
    // pile bents every ~19 m, 3 piles each
    const bents = Math.max(3, Math.round(p.len / 19));
    for (let bi = 0; bi <= bents; bi++) {
      const z = z0 + 1.8 + ((p.len - 3.6) * bi) / bents;
      for (const sx of [-1, 0, 1]) {
        const px = p.x + sx * (PIER_W * 0.5 - 2.2);
        b.add(cyl(0.95, 1.1, 15.0, 10), 'concrete', { pos: [px, PIER_TOP - 8.2, z] });
        b.add(box(2.3, 0.8, 2.3), 'metalDark', { pos: [px, PIER_TOP - 1.9, z] });
      }
      // transverse cap + X bracing below deck
      for (const sx of [-1, 1]) {
        beamBetween(b, 'metalDark', [p.x + sx * (PIER_W * 0.5 - 2.2), PIER_TOP - 2.6, z], [p.x, PIER_TOP - 2.6, z], 0.26);
        beamBetween(b, 'metalDark', [p.x + sx * (PIER_W * 0.5 - 2.2), PIER_TOP - 10.5, z], [p.x + sx * 0.0, PIER_TOP - 2.9, z], 0.2);
      }
      if (bi < bents) {
        const z2 = z0 + 1.8 + ((p.len - 3.6) * (bi + 1)) / bents;
        for (const sx of [-1, 1]) {
          const px = p.x + sx * (PIER_W * 0.5 - 2.2);
          beamBetween(b, 'metalDark', [px, PIER_TOP - 2.6, z], [px, PIER_TOP - 2.6, z2], 0.22);
          beamBetween(b, 'metalDark', [px, PIER_TOP - 9.8, z], [px, PIER_TOP - 2.9, z2], 0.16);
        }
      }
    }
    // fenders along both pier faces
    const nf = Math.round(p.len / 13);
    for (let i = 0; i < nf; i++) {
      const z = z0 + 7 + (i * (p.len - 14)) / Math.max(1, nf - 1);
      for (const sx of [-1, 1]) fender(b, p.x + sx * (PIER_W * 0.5 + 0.25), PIER_TOP - 1.7, z, Math.PI * 0.5);
    }
    // bollards at the head + along the pier
    for (let i = 0; i < 3; i++) {
      bollard(b, p.x - 5 + i * 5, z0 + p.len - 2.0, PIER_TOP + 0.1);
      bollard(b, p.x - 5 + i * 5, z0 + 8.0, PIER_TOP + 0.1);
    }
    // lamp masts + guide lights
    for (let i = 0; i < Math.max(2, Math.round(p.len / 45)); i++) {
      const z = z0 + 12 + i * 45;
      for (const sx of [-1, 1]) lampMast(b, p.x + sx * (PIER_W * 0.5 - 1.2), z, PIER_TOP + 0.1, 7.5);
    }
    for (let i = 0; i < Math.round(p.len / 9); i++) {
      const z = z0 + 4 + i * 9;
      for (const sx of [-1, 1]) {
        b.add(box(0.24, 0.16, 0.42), i % 2 === 0 ? 'glowWarm' : 'glowCyan', { pos: [p.x + sx * (PIER_W * 0.5 - 0.5), PIER_TOP + 0.2, z] });
      }
    }
    // pier head: wider mooring platform + auto mooring + hoist
    const hz = z0 + p.len - 2.5;
    b.add(box(PIER_W + 8, 0.9, 9), 'concrete', { pos: [p.x, PIER_TOP - 0.45, hz] });
    b.add(box(PIER_W + 7.2, 0.12, 8.2), 'deckDark', { pos: [p.x, PIER_TOP + 0.02, hz] });
    for (const sx of [-1, 1]) {
      fender(b, p.x + sx * (PIER_W * 0.5 + 4.2), PIER_TOP - 1.5, hz, 0, 2.6);
      b.add(box(1.1, 0.7, 1.1), 'concrete', { pos: [p.x + sx * (PIER_W * 0.5 + 3.2), PIER_TOP + 0.4, hz - 2.5] });
    }
    autoMooring(b, p.x - 3.5, hz + 3.0, PIER_TOP + 0.1);
    autoMooring(b, p.x + 3.5, hz + 3.0, PIER_TOP + 0.1);
    jibCrane(b, p.x, hz - 1.2, PIER_TOP + 0.1, { scale: 0.8, rot: -0.7 + pi * 0.4, boom: 8 });
    for (const sx of [-1, 1]) {
      b.add(box(2.4, 1.7, 1.8), 'pearl', { pos: [p.x + sx * (PIER_W * 0.5 - 2.2), PIER_TOP + 0.95, z0 + 15] });
      b.add(box(2.5, 0.1, 1.9), 'silver', { pos: [p.x + sx * (PIER_W * 0.5 - 2.2), PIER_TOP + 1.85, z0 + 15] });
    }
    // cable reels + crates staged on the pier
    for (let i = 0; i < 2; i++) {
      const z = z0 + 26 + i * 30;
      b.add(cyl(1.35, 1.35, 2.1, 12), 'signalOrange', { pos: [p.x + 4.2, PIER_TOP + 1.5, z], rot: [0, 0, Math.PI * 0.5] });
      b.add(box(0.25, 2.4, 2.4), 'metalDark', { pos: [p.x + 3.0, PIER_TOP + 1.3, z] });
      b.add(box(0.25, 2.4, 2.4), 'metalDark', { pos: [p.x + 5.4, PIER_TOP + 1.3, z] });
    }
    for (let i = 0; i < 3; i++) {
      const boxKey = i === 0 ? 'safetyOrange' : i === 1 ? 'pearl' : 'silver';
      b.add(box(2.6, 1.9, 2.0), boxKey, { pos: [p.x - 3.4, PIER_TOP + 1.05, z0 + 20 + i * 2.6] });
      b.add(box(2.4, 0.14, 0.16), 'darkSteel', { pos: [p.x - 3.4, PIER_TOP + 1.85, z0 + 20 + i * 2.6] });
    }
  }

  // small quay cranes on the lower quay (one animated)
  jibCrane(b, -34, 112, LOWER + 0.1, { scale: 1.35, rot: 0.25, boom: 11, boomKey: 'safetyOrange' });
  // crane geometry is built once in local space and bucketed per material
  const craneGroup = b.dynamic('quayCrane', { pos: [36, LOWER + 0.1, 112] });
  const craneBuckets = { metalDark: [], silver: [], pearl: [], glass: [], safetyOrange: [], glowWarm: [] };
  {
    const tmp = new Builder(mats, { outlineMaterial: null });
    jibCrane(tmp, 0, 0, 0, { scale: 1.25, rot: 0.0, boom: 10, boomKey: 'safetyOrange' });
    const tmpRoot = tmp.build();
    tmpRoot.updateMatrixWorld(true);
    tmpRoot.traverse((o) => {
      if (!o.isMesh) return;
      const mat = o.material;
      const bucketKey =
        mat === mats.safetyOrange
          ? 'safetyOrange'
          : mat === mats.silver
            ? 'silver'
            : mat === mats.white || mat === mats.pearl || mat === mats.ivory
              ? 'pearl'
              : mat === mats.glass || mat === mats.glassLight
                ? 'glass'
                : mat === mats.darkSteel || mat === mats.metalDark
                  ? 'metalDark'
                  : mat === mats.glowWarm
                    ? 'glowWarm'
                    : null;
      if (!bucketKey) return;
      const g = o.geometry.clone();
      g.applyMatrix4(o.matrixWorld);
      craneBuckets[bucketKey].push(g);
    });
    tmpRoot.traverse((o) => {
      if (o.isMesh) o.geometry?.dispose?.();
    });
  }
  for (const key of Object.keys(craneBuckets)) {
    if (!craneBuckets[key].length) continue;
    const geo = mergeGeometries(craneBuckets[key], false);
    craneBuckets[key].forEach((g) => g.dispose());
    craneGroup.add(new THREE.Mesh(geo, mats[key]));
  }
  quayCrane = craneGroup;

  // ===========================================================================
  // 3. boat ramp on the lower quay east end
  // ===========================================================================
  {
    const rampAngle = Math.atan2(LOWER + 1.6, 44);
    const ramp = box(15, 0.9, 44.6);
    b.add(ramp, 'concrete', { pos: [80, (LOWER - 1.6) * 0.5, 132], rot: [rampAngle, 0, 0] });
    for (const sx of [-1, 1]) {
      const curb = box(0.5, 1.0, 44.6);
      b.add(curb, 'concrete', { pos: [80 + sx * 7.4, (LOWER - 1.6) * 0.5 + 0.6, 132], rot: [rampAngle, 0, 0] });
      b.add(box(0.16, 0.12, 43), 'safetyYellow', { pos: [80 + sx * 7.0, (LOWER - 1.6) * 0.5 + 1.15, 132], rot: [rampAngle, 0, 0] });
    }
    // end piles + winch at the top of the ramp
    for (const sx of [-1, 1]) {
      b.add(cyl(0.85, 1.0, 12, 8), 'concrete', { pos: [80 + sx * 5.6, -3.0, 152] });
    }
    b.add(cyl(0.8, 0.8, 2.2, 10), 'metalDark', { pos: [80, LOWER + 1.3, 112], rot: [0, 0, Math.PI * 0.5] });
    b.add(box(2.6, 0.45, 2.2), 'silver', { pos: [80, LOWER + 0.55, 112] });
  }

  // ===========================================================================
  // 3b. close-up quay detail (ladders, vehicles, hang tyres, life rings, hoses)
  // ===========================================================================
  // vertical access ladders on the pier faces
  for (const p of PIERS) {
    for (const sx of [-1, 1]) {
      const x = p.x + sx * (PIER_W * 0.5 + 0.12);
      const zc = 150 + p.len * 0.45;
      for (const dz of [-0.3, 0.3]) b.add(box(0.07, 6.2, 0.07), 'safetyYellow', { pos: [x, PIER_TOP - 3.3, zc + dz] });
      for (let i = 0; i < 10; i++) b.add(box(0.06, 0.06, 0.62), 'darkSteel', { pos: [x, PIER_TOP - 0.55 - i * 0.58, zc] });
      b.add(torus(0.32, 0.07, 4, 10), 'silver', { pos: [x, PIER_TOP + 0.15, zc], rot: [Math.PI * 0.5, 0, 0] });
    }
  }
  // hanging tyres along the lower-quay wall
  for (let i = 0; i < 10; i++) {
    b.add(torus(0.5, 0.2, 5, 12), 'rubber', { pos: [-78 + i * 17.3, LOWER - 2.1, LQ_Z1 + 3.7], rot: [Math.PI * 0.5, 0, 0] });
  }
  // hazard chevrons at the pier roots
  for (const p of PIERS) {
    for (let i = 0; i < 6; i++) {
      const key = i % 2 === 0 ? 'safetyYellow' : 'darkSteel';
      b.add(box(1.6, 0.06, 0.8), key, { pos: [p.x - 7.8 + i * 2.2, LOWER + 0.22, LQ_Z1 + 2.2] });
    }
  }
  // service vehicles on the apron
  utilityVan(b, -26, 4, PLAT + 0.2, 0.1, 'white');
  utilityVan(b, 26, 22, PLAT + 0.2, Math.PI * 0.5, 'pearl');
  utilityVan(b, -44, 30, PLAT + 0.2, -0.25, 'ivory');
  // life rings by the quay edge
  for (const x of [-70, 8, 84]) {
    b.add(torus(0.55, 0.17, 5, 12), 'safetyOrange', { pos: [x, PLAT + 1.3, 82.6], rot: [Math.PI * 0.5, 0, 0] });
    b.add(box(0.12, 0.18, 0.3), 'darkSteel', { pos: [x, PLAT + 1.95, 82.9] });
  }
  // fire / valve cabinets + hose reels near the working strip
  for (let i = 0; i < 4; i++) {
    const x = -72 + i * 48;
    b.add(box(1.3, 1.6, 0.7), 'white', { pos: [x, PLAT + 1.0, 60] });
    b.add(box(1.35, 0.18, 0.75), 'signalOrange', { pos: [x, PLAT + 1.82, 60] });
    b.add(box(0.5, 0.5, 0.1), 'glass', { pos: [x, PLAT + 1.05, 60.38] });
  }

  // ===========================================================================
  // 4. apron buildings
  // ===========================================================================
  // Lab A — largest research block
  labBuilding(b, { x: -64, z: -46, w: 46, d: 28, h: 13.5, floors: 2, body: 'pearl', glassKey: 'glass', rng: makeRng(11), solar: true, satDish: true });
  // Lab B — secondary lab, helipad on the roof
  labBuilding(b, { x: 58, z: -50, w: 34, d: 24, h: 11, floors: 2, body: 'ivory', glassKey: 'glassLight', rng: makeRng(12), helipad: true, satDish: true });
  // Admin / visitor centre — taller, 3 floors
  labBuilding(b, { x: 4, z: -66, w: 30, d: 20, h: 17, floors: 3, body: 'white', glassKey: 'glass', rng: makeRng(13), solar: false });
  // Workshop / hangar — big door facing the quay
  labBuilding(b, { x: -80, z: 20, w: 30, d: 30, h: 12.5, floors: 2, body: 'pearl', glassKey: 'glassLight', rng: makeRng(14), hangarDoor: true, solar: true });
  // Energy / utility block
  labBuilding(b, { x: 82, z: -2, w: 22, d: 16, h: 9, floors: 1, body: 'pearl', glassKey: 'glass', rng: makeRng(15), solar: true });

  // elevated enclosed walkways to the command tower
  skywalk(b, -40, -44, TOWER_X - 15, TOWER_Z - 12, PLAT + 7.2);
  skywalk(b, 4, -56, TOWER_X - 2, TOWER_Z - 16, PLAT + 7.2);
  skywalk(b, 41, -48, TOWER_X + 17, TOWER_Z - 6, PLAT + 7.2);

  // ===========================================================================
  // 5. command tower
  // ===========================================================================
  {
    const tx = TOWER_X;
    const tz = TOWER_Z;
    // plaza + steps
    b.add(box(38, 1.3, 38), 'concrete', { pos: [tx, PLAT + 0.65, tz] });
    b.add(box(36, 0.2, 36), 'deckGray', { pos: [tx, PLAT + 1.35, tz] });
    for (let i = 0; i < 4; i++) {
      b.add(box(14, 0.34, 1.2), 'concrete', { pos: [tx, PLAT + 1.18 - i * 0.3, tz + 19.5 + i * 1.1] });
    }
    b.add(cyl(4.0, 4.3, 0.8, 12), 'concrete', { pos: [tx, PLAZA_Y + 0.4, tz] });
    // annex / lobby
    b.solid(box(24, 5.0, 20), 'pearl', { pos: [tx, PLAZA_Y + 2.5, tz] });
    b.add(box(24.4, 1.9, 20.4), 'glass', { pos: [tx, PLAZA_Y + 3.1, tz] });
    for (let i = 0; i < 7; i++) {
      b.add(box(0.22, 2.0, 0.3), 'silver', { pos: [tx - 10.8 + i * 3.6, PLAZA_Y + 3.1, tz + 10.2] });
    }
    b.add(box(8.3, 3.6, 0.3), 'darkSteel', { pos: [tx, PLAZA_Y + 1.8, tz + 10.15] });
    b.add(box(9.2, 0.4, 1.0), 'signalOrange', { pos: [tx, PLAZA_Y + 3.8, tz + 10.4] });
    b.add(box(9.2, 0.28, 3.2), 'white', { pos: [tx, PLAZA_Y + 4.3, tz + 11.7] });
    for (let i = 0; i < 3; i++) {
      b.add(box(0.4, 0.14, 1.2), 'glowWarm', { pos: [tx - 2 + i * 2, PLAZA_Y + 4.15, tz + 11.9] });
    }
    // annex roof rim
    b.add(box(25, 0.55, 21), 'silver', { pos: [tx, ANNEX_TOP + 0.27, tz] });

    // faceted main shaft
    const levels = [
      { y: ANNEX_TOP, r: 10.6, rot: 0.0 },
      { y: ANNEX_TOP + 10, r: 9.7, rot: 0.0 },
      { y: ANNEX_TOP + 20, r: 8.8, rot: 0.0 },
      { y: ANNEX_TOP + 29, r: 7.9, rot: 0.0 },
      { y: ANNEX_TOP + 34, r: 7.3, rot: 0.0 },
    ];
    b.solid(octLoft(levels), 'pearl', { pos: [tx, 0, tz] });
    // silver corner ribs following the facet edges
    for (let k = 0; k < 8; k++) {
      for (let i = 0; i < levels.length - 1; i++) {
        const a = levels[i];
        const c = levels[i + 1];
        const r1 = a.r;
        const r2 = c.r;
        beamBetween(
          b,
          'silver',
          [tx + Math.cos((k / 8) * TAU) * r1, a.y, tz + Math.sin((k / 8) * TAU) * r1],
          [tx + Math.cos((k / 8) * TAU) * r2, c.y, tz + Math.sin((k / 8) * TAU) * r2],
          0.27,
          undefined,
          5,
        );
      }
    }
    // dark recess grooves on every facet centre (reads as crisp faceting up close)
    for (let k = 0; k < 8; k++) {
      const a = ((k + 0.5) / 8) * TAU;
      for (let i = 0; i < levels.length - 1; i++) {
        const lo = levels[i];
        const hi = levels[i + 1];
        for (let j = 0; j < 2; j++) {
          const t = (j + 0.5) / 2;
          const yy = lerp(lo.y, hi.y, t);
          const rr = lerp(lo.r, hi.r, t) + 0.04;
          b.add(box(0.22, (hi.y - lo.y) * 0.48, 0.22), 'darkSteel', { pos: [tx + Math.cos(a) * rr, yy, tz + Math.sin(a) * rr] });
        }
      }
    }
    // narrow navy window slits for scale
    for (const k of [0, 2, 4, 6]) {
      const a = ((k + 0.5) / 8) * TAU;
      for (const localY of [13, 20, 27]) {
        const rr = loftRadius(levels, ANNEX_TOP + localY) + 0.05;
        b.add(box(0.62, 1.9, 0.1), 'glass', { pos: [tx + Math.cos(a) * rr, ANNEX_TOP + localY, tz + Math.sin(a) * rr], rot: [0, Math.PI * 0.5 - a, 0] });
      }
    }
    // structural joint rings
    for (const lvl of levels.slice(1)) {
      b.add(cyl(lvl.r + 0.1, lvl.r + 0.1, 0.5, 8, true), 'silver', { pos: [tx, lvl.y, tz] });
    }
    // signal-orange accent band on the lower shaft
    const oy0 = ANNEX_TOP + 5.5;
    const oy1 = ANNEX_TOP + 8.5;
    const or0 = loftRadius(levels, ANNEX_TOP + 5.5);
    const or1 = loftRadius(levels, ANNEX_TOP + 8.5);
    b.add(cyl(or1 + 0.12, or0 + 0.12, oy1 - oy0, 8, true), 'signalOrange', { pos: [tx, (oy0 + oy1) * 0.5, tz] });
    // vertical cyan strip + pair of orange service fins at the base
    for (let i = 0; i < 4; i++) {
      const yy = ANNEX_TOP + 12 + i * 6;
      const rr = loftRadius(levels, yy) + 0.06;
      b.add(box(0.16, 5.4, 0.16), 'glowCyan', { pos: [tx + Math.cos(1.9) * rr, yy, tz + Math.sin(1.9) * rr] });
    }
    for (const sx of [-1, 1]) {
      b.add(box(1.0, 9.0, 3.2), 'silver', { pos: [tx + sx * 8.6, ANNEX_TOP + 4.5, tz - 2.0], rot: [0, 0, sx * -0.08] });
      b.add(box(0.7, 3.0, 2.4), 'signalOrange', { pos: [tx + sx * 8.9, ANNEX_TOP + 10.5, tz - 2.0], rot: [0, 0, sx * -0.06] });
    }
    // external lift shaft on the landward side
    const liftX = tx;
    const liftZ = tz - 11.4;
    b.add(box(3.6, 34, 3.4), 'silver', { pos: [liftX, ANNEX_TOP + 17, liftZ] });
    b.add(box(1.0, 32, 0.2), 'glassLight', { pos: [liftX, ANNEX_TOP + 17, liftZ - 1.75] });
    b.add(box(4.2, 2.2, 4.0), 'pearl', { pos: [liftX, ANNEX_TOP + 35, liftZ] });
    b.add(box(4.4, 0.3, 4.2), 'metalDark', { pos: [liftX, ANNEX_TOP + 36.2, liftZ] });

    // observation band + exterior ring platform
    const obsY0 = ANNEX_TOP + 34;
    const obsY1 = obsY0 + 5.0;
    b.add(cyl(7.85, 7.85, obsY1 - obsY0, 8), 'glass', { pos: [tx, (obsY0 + obsY1) * 0.5, tz] });
    for (let k = 0; k < 8; k++) {
      const a = ((k + 0.5) / 8) * TAU;
      b.add(box(0.3, 5.0, 0.3), 'silver', { pos: [tx + Math.cos(a) * 7.9, (obsY0 + obsY1) * 0.5, tz + Math.sin(a) * 7.9] });
    }
    for (let k = 0; k < 8; k++) {
      const a = ((k + 0.5) / 8) * TAU;
      b.add(box(1.7, 0.2, 0.14), 'glowWarm', { pos: [tx + Math.cos(a) * 7.5, obsY0 + 1.1, tz + Math.sin(a) * 7.5], rot: [0, -a + Math.PI * 0.5, 0] });
    }
    b.add(cyl(8.1, 8.3, 0.4, 8), 'darkSteel', { pos: [tx, obsY0 - 0.15, tz] });
    b.add(cyl(8.1, 8.1, 0.4, 8), 'darkSteel', { pos: [tx, obsY1 + 0.2, tz] });
    // ring balcony
    b.add(ring(7.9, 10.3, 32), 'deckGray', { pos: [tx, obsY0 - 0.42, tz] });
    b.add(ring(7.9, 10.3, 32), 'deckGray', { pos: [tx, obsY1 + 0.42, tz] });
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * TAU;
      b.add(box(0.08, 1.1, 0.08), 'silver', { pos: [tx + Math.cos(a) * 10.0, obsY1 + 0.95, tz + Math.sin(a) * 10.0] });
    }
    b.add(torus(10.0, 0.06, 4, 40), 'silver', { pos: [tx, obsY1 + 1.5, tz], rot: [Math.PI * 0.5, 0, 0] });
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * TAU;
      beamBetween(
        b,
        'silver',
        [tx + Math.cos(a) * 7.4, obsY1, tz + Math.sin(a) * 7.4],
        [tx + Math.cos(a) * 10.1, obsY0 + 0.2, tz + Math.sin(a) * 10.1],
        0.17,
      );
    }
    // cyan glow line under the balcony
    b.add(torus(8.02, 0.055, 4, 40), 'glowCyan', { pos: [tx, obsY0 - 0.5, tz], rot: [Math.PI * 0.5, 0, 0] });

    // upper equipment level above the observation deck
    const up0 = obsY1 + 0.6;
    const upLevels = [
      { y: up0, r: 6.5, rot: 0.0 },
      { y: up0 + 5.0, r: 5.8, rot: 0.0 },
    ];
    b.solid(octLoft(upLevels), 'pearl', { pos: [tx, 0, tz] });
    b.add(cyl(5.9, 5.9, 0.4, 8), 'darkSteel', { pos: [tx, up0 + 5.2, tz] });
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * TAU;
      b.add(box(0.07, 1.05, 0.07), 'silver', { pos: [tx + Math.cos(a) * 5.6, up0 + 5.9, tz + Math.sin(a) * 5.6] });
    }
    b.add(torus(5.6, 0.05, 4, 30), 'silver', { pos: [tx, up0 + 6.42, tz], rot: [Math.PI * 0.5, 0, 0] });
    // radome
    b.add(cyl(1.5, 1.9, 1.2, 12), 'silver', { pos: [tx - 1.8, up0 + 5.8, tz + 1.4] });
    b.add(sphere(2.15, 16, 10), 'white', { pos: [tx - 1.8, up0 + 7.6, tz + 1.4] });
    // antenna whips + dishes
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * TAU + 0.4;
      const hh = 5.5 - i * 0.7;
      b.add(cyl(0.05, 0.075, hh, 5), 'silver', { pos: [tx + Math.cos(a) * 4.4, up0 + 5.4 + hh * 0.5, tz + Math.sin(a) * 4.4] });
    }
    for (const [dx, dz, ry] of [
      [3.2, -2.6, 0.6],
      [2.6, 3.0, 2.2],
    ]) {
      b.add(cyl(0.1, 0.1, 0.9, 5), 'silver', { pos: [tx + dx, up0 + 6.1, tz + dz] });
      b.add(torus(0.7, 0.08, 4, 14), 'white', { pos: [tx + dx, up0 + 7.1, tz + dz], rot: [0.6, ry, 0] });
    }
    // radar mast + rotating bar array
    const mastY0 = up0 + 5.2;
    b.add(cyl(0.16, 0.3, 7.0, 6), 'white', { pos: [tx, mastY0 + 3.5, tz] });
    b.add(box(2.4, 0.18, 0.18), 'silver', { pos: [tx, mastY0 + 4.6, tz] });
    const radar = b.dynamic('towerRadar', { pos: [tx, mastY0 + 5.6, tz] });
    const radarGeo = mergeParts([
      [box(7.2, 0.26, 0.7), { pos: [0, 0.35, 0] }],
      [box(2.9, 1.0, 0.16), { pos: [-2.3, 0.85, 0] }],
      [box(2.9, 1.0, 0.16), { pos: [2.3, 0.85, 0] }],
      [cyl(0.34, 0.42, 1.0, 8), { pos: [0, 0, 0] }],
      [box(1.0, 0.25, 1.0), { pos: [0, -0.45, 0] }],
    ]);
    radar.add(new THREE.Mesh(radarGeo, mats.silver));
    towerRadar = radar;
    // lightning rod + aviation beacon
    b.add(cyl(0.035, 0.06, 6.8, 5), 'silver', { pos: [tx, mastY0 + 10.5, tz] });
    towerBeaconY = mastY0 + 7.25;
    b.add(cyl(0.3, 0.3, 0.6, 6), 'darkSteel', { pos: [tx, towerBeaconY, tz] });
  }

  // ===========================================================================
  // 6. working quay: container yard, energy modules, solar canopies, equipment
  // ===========================================================================
  // container yard
  const cRng = makeRng(555);
  const contDefs = [
    [-6, 0, 0, 'pearl'],
    [-6, 2.75, 0, 'signalOrange'],
    [-6, 5.5, 0, 'white'],
    [6, 0, 0, 'silver'],
    [6, 2.75, 0, 'safetyOrange'],
    [18, 0, 0, 'pearl'],
    [18, 0, 3.0, 'white'],
    [18, 2.75, 3.0, 'pearl'],
    [30, 0, 0, 'signalOrange'],
    [30, 0, 3.0, 'silver'],
  ];
  for (let i = 0; i < contDefs.length; i++) {
    const [gx, gy, gz, key] = contDefs[i];
    container(b, 48 + gx, PLAT + 0.2 + gy, 36 + gz, 12.2, 2.65, 2.65, key, { lit: i % 4 === 1, accent: i % 3 === 0 });
  }
  // reach-stacker-ish yard vehicle
  b.add(box(4.2, 2.2, 2.2), 'safetyOrange', { pos: [34, PLAT + 1.4, 48] });
  b.add(box(2.0, 1.4, 2.0), 'darkSteel', { pos: [31.5, PLAT + 1.2, 48] });
  b.add(box(0.9, 0.9, 0.9), 'glass', { pos: [35.8, PLAT + 2.5, 48] });
  for (const [wx, wz] of [
    [32.6, 46.6],
    [32.6, 49.4],
    [35.4, 46.6],
    [35.4, 49.4],
  ]) {
    b.add(cyl(0.75, 0.75, 0.5, 10), 'rubber', { pos: [wx, PLAT + 0.55, wz], rot: [Math.PI * 0.5, 0, 0] });
  }
  // energy / fuel modules next to the utility block
  for (const sz of [-1, 1]) {
    b.add(cyl(2.3, 2.3, 11.5, 14), 'silver', { pos: [72, PLAT + 3.35, sz * 12], rot: [0, 0, Math.PI * 0.5] });
    b.add(cyl(2.34, 2.34, 0.6, 14), 'signalOrange', { pos: [72 + sz * 2.4, PLAT + 3.35, sz * 12], rot: [0, 0, Math.PI * 0.5] });
    for (const sx of [-1, 1]) b.add(box(1.2, 1.6, 2.2), 'concrete', { pos: [72 + sx * 3.4, PLAT + 0.9, sz * 12] });
    b.add(cyl(0.4, 0.4, 0.25, 8), 'metalDark', { pos: [72, PLAT + 5.75, sz * 12] });
  }
  b.add(box(22, 0.5, 30), 'concrete', { pos: [72, PLAT + 0.3, 0] });
  for (let i = 0; i < 3; i++) beamBetween(b, 'silver', [66 + i * 4, PLAT + 0.9, -6], [66 + i * 4, PLAT + 0.9, 6], 0.18);
  // solar canopy over the staging area
  for (const [cx, cz] of [
    [-36, 38],
    [-14, 38],
  ]) {
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        b.add(cyl(0.22, 0.28, 4.2, 8), 'silver', { pos: [cx + sx * 5.6, PLAT + 2.2, cz + sz * 3.6] });
      }
    }
    b.add(box(13.4, 0.16, 9.0), 'silver', { pos: [cx, PLAT + 4.35, cz] });
    for (let i = 0; i < 2; i++) {
      for (let j = 0; j < 3; j++) {
        b.add(box(5.6, 0.09, 2.5), 'glass', { pos: [cx - 3.2 + i * 6.4, PLAT + 4.62, cz - 2.6 + j * 2.6], rot: [-0.26, 0, 0] });
      }
    }
    b.add(box(13.0, 0.1, 0.12), 'glowWarm', { pos: [cx, PLAT + 4.1, cz - 4.4] });
  }
  // equipment crates / cable reels / tanks scattered on the apron
  const eqRng = makeRng(31337);
  for (let i = 0; i < 18; i++) {
    const ex = eqRng.range(-96, 96);
    const ez = eqRng.range(-20, 74);
    // keep clear of buildings and walkway paths
    const nearTower = Math.hypot(ex - TOWER_X, ez - TOWER_Z) < 26;
    const nearBld =
      (Math.abs(ex + 64) < 28 && ez < -26) ||
      (Math.abs(ex - 58) < 22 && ez < -32) ||
      (Math.abs(ex - 4) < 20 && ez < -48) ||
      (Math.abs(ex + 80) < 20 && ez > 0) ||
      (Math.abs(ex - 82) < 18 && ez < 12);
    if (nearTower || nearBld) continue;
    const s = eqRng.range(1.4, 3.0);
    const key = eqRng.pick(['pearl', 'silver', 'safetyOrange', 'white', 'metalDark']);
    b.add(box(s * 1.6, s, s * 1.3), key, { pos: [ex, PLAT + 0.25 + s * 0.5, ez], rot: [0, eqRng.range(-0.4, 0.4), 0] });
    if (eqRng.chance(0.4)) b.add(box(s * 1.5, 0.12, 0.3), 'darkSteel', { pos: [ex, PLAT + 0.25 + s * 0.95, ez] });
  }
  for (let i = 0; i < 3; i++) {
    const rx = -22 + i * 5.5;
    const rz = 64;
    b.add(cyl(1.5, 1.5, 2.4, 12), i === 1 ? 'safetyOrange' : 'signalOrange', { pos: [rx, PLAT + 1.65, rz], rot: [0, 0, Math.PI * 0.5] });
    b.add(box(0.3, 2.8, 2.8), 'metalDark', { pos: [rx - 1.2, PLAT + 1.5, rz] });
    b.add(box(0.3, 2.8, 2.8), 'metalDark', { pos: [rx + 1.2, PLAT + 1.5, rz] });
  }
  // vertical storage / process tanks against the eastern edge
  for (const [tx2, tz2] of [
    [97, -26],
    [97, -36],
  ]) {
    b.add(cyl(3.0, 3.2, 0.7, 14), 'concrete', { pos: [tx2, PLAT + 0.35, tz2] });
    b.add(cyl(2.5, 2.5, 6.2, 14), 'silver', { pos: [tx2, PLAT + 3.6, tz2] });
    b.add(dome(2.5, 14, 6, 0.55), 'white', { pos: [tx2, PLAT + 6.7, tz2] });
    b.add(cyl(2.54, 2.54, 0.45, 14), 'signalOrange', { pos: [tx2, PLAT + 5.2, tz2] });
    // cage ladder + pipe run
    for (const sx of [-1, 1]) b.add(box(0.07, 6.0, 0.07), 'darkSteel', { pos: [tx2 + sx * 0.28, PLAT + 3.7, tz2 - 2.6] });
    for (let i = 0; i < 9; i++) b.add(box(0.5, 0.05, 0.05), 'darkSteel', { pos: [tx2, PLAT + 0.9 + i * 0.62, tz2 - 2.6] });
    beamBetween(b, 'silver', [tx2 - 2.5, PLAT + 1.0, tz2], [tx2 - 8.0, PLAT + 1.0, tz2 - 4.0], 0.22);
    b.add(cyl(0.3, 0.3, 1.0, 8), 'metalDark', { pos: [tx2 + 1.4, PLAT + 7.35, tz2] });
  }
  // equipment skids / generator sets along the service road
  for (let i = 0; i < 6; i++) {
    const sx2 = -94 + i * 13;
    const sz2 = -6;
    b.add(box(5.2, 0.4, 2.8), 'darkSteel', { pos: [sx2, PLAT + 0.45, sz2] });
    b.add(box(4.6, 1.7, 2.3), i % 2 === 0 ? 'white' : 'silver', { pos: [sx2, PLAT + 1.5, sz2] });
    b.add(box(1.1, 0.5, 0.12), 'glass', { pos: [sx2 + 1.5, PLAT + 1.7, sz2 + 1.18] });
    for (const ex of [-1.6, -0.4]) b.add(cyl(0.3, 0.3, 1.1, 8), 'metalDark', { pos: [sx2 + ex, PLAT + 2.4, sz2], rot: [Math.PI * 0.5, 0, 0] });
    if (i === 2) b.add(box(0.6, 0.16, 0.3), 'glowWarm', { pos: [sx2 - 2.0, PLAT + 2.2, sz2 + 1.2] });
  }
  // extra service vehicles + pallet stacks in the open yard areas
  utilityVan(b, -92, 52, PLAT + 0.2, Math.PI * 0.5, 'pearl');
  utilityVan(b, 68, 68, PLAT + 0.2, -0.15, 'white');
  for (let i = 0; i < 7; i++) {
    const px = 66 + (i % 4) * 1.5;
    const pz = 58 + Math.floor(i / 4) * 2.4;
    b.add(box(1.3, 0.9, 1.1), i % 3 === 0 ? 'signalOrange' : 'pearl', { pos: [px, PLAT + 0.7, pz] });
  }
  // small pier-root guard kiosk on the lower quay
  b.add(box(2.8, 2.6, 2.8), 'white', { pos: [-64, LOWER + 1.3, 132] });
  b.add(box(2.9, 0.2, 2.9), 'signalOrange', { pos: [-64, LOWER + 2.7, 132] });
  b.add(box(1.7, 0.9, 0.12), 'glass', { pos: [-64, LOWER + 1.6, 133.45] });
  b.add(box(0.6, 0.5, 0.12), 'glowWarm', { pos: [-63.4, LOWER + 1.6, 133.5] });
  // blue-green planters + a few palms near the buildings and tower plaza
  function planter(b2, px, pz, py) {
    b2.add(box(4.2, 1.0, 4.2), 'concrete', { pos: [px, py + 0.5, pz] });
    b2.add(box(3.7, 0.15, 3.7), 'islandGreenDark', { pos: [px, py + 1.0, pz] });
    b2.add(sphere(1.5, 8, 6), 'islandGreen', { pos: [px, py + 1.5, pz] });
    b2.add(sphere(1.1, 8, 6), 'islandGreenDark', { pos: [px + 0.9, py + 1.25, pz - 0.6] });
  }
  function palm(b2, px, pz, py, s = 1) {
    b2.add(cyl(0.16 * s, 0.3 * s, 4.6 * s, 7), 'palmTrunk', { pos: [px, py + 2.3 * s, pz] });
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * TAU;
      const leaf = box(3.4 * s, 0.1, 0.8 * s);
      leaf.rotateY(-a);
      b2.add(leaf, 'palmLeaf', { pos: [px + Math.cos(a) * 1.5 * s, py + 4.6 * s, pz + Math.sin(a) * 1.5 * s], rot: [0.18, -a, 0.12] });
    }
  }
  for (const [px, pz] of [
    [-24, -30],
    [24, -28],
    [-10, 24],
    [26, 20],
  ]) {
    planter(b, px, pz, PLAT + 0.2);
  }
  palm(b, -14, -28, PLAT + 0.2, 1.0);
  palm(b, 20, -22, PLAT + 0.2, 1.15);
  palm(b, -30, 18, PLAT + 0.2, 0.9);

  // antenna cluster near the admin building
  for (let i = 0; i < 3; i++) {
    b.add(cyl(0.07, 0.1, 7.5 - i * 1.4, 5), 'silver', { pos: [18 + i * 2.6, PLAT + (7.5 - i * 1.4) * 0.5 + 0.3, -78] });
    b.add(sphere(0.12, 6, 4), 'glowRed', { pos: [18 + i * 2.6, PLAT + 7.5 - i * 1.4 + 0.3, -78] });
  }
  b.add(box(5.2, 2.2, 4.2), 'silver', { pos: [26, PLAT + 1.4, -76] });
  b.add(cyl(1.5, 1.9, 0.9, 12), 'white', { pos: [22, PLAT + 1.9, -74] });
  b.add(torus(2.1, 0.16, 4, 16), 'white', { pos: [22, PLAT + 2.8, -74], rot: [0.7, 0.4, 0] });

  // ===========================================================================
  // 7. breakwater
  // ===========================================================================
  {
    const bz = 325;
    const halfLen = 160;
    const bwRng = makeRng(2027);
    // rubble core founded on the sea bed (depth here is ~7-9 m)
    b.add(box(2 * halfLen, 13, 28), 'islandRockDark', { pos: [-20, -2.0, bz] });
    b.add(box(2 * halfLen - 20, 3.5, 16), 'concrete', { pos: [-20, 5.0, bz] });
    // armour rocks along the crest and both slopes
    for (let i = 0; i < 90; i++) {
      const t = i / 89;
      const px = -20 - halfLen + t * 2 * halfLen + bwRng.range(-6, 6);
      const side = bwRng.chance(0.5) ? 1 : -1;
      const pz = bz + side * bwRng.range(2, 11);
      const s = bwRng.range(2.2, 5.2);
      const g = rockGeometry(bwRng.range(0, 90), bwRng.chance(0.5) ? 1 : 0, 0.42);
      g.scale(s * 1.2, s * 0.8, s);
      g.rotateY(bwRng.range(0, TAU));
      g.translate(px, bwRng.range(1.5, 6.6) - s * 0.25, pz);
      b.add(g, bwRng.chance(0.45) ? 'rockDark' : 'islandRock');
      g.dispose();
    }
    // concrete armour units along the crest
    for (let i = 0; i < 12; i++) {
      const px = -20 - halfLen + 18 + i * ((2 * halfLen - 36) / 11);
      b.add(box(4.4, 3.6, 4.0), 'concrete', { pos: [px, 6.2, bz + (i % 2 === 0 ? 2.5 : -2.5)], rot: [0, (i % 3) * 0.3, 0] });
      b.add(box(4.4, 0.3, 0.5), 'safetyYellow', { pos: [px, 7.9, bz + (i % 2 === 0 ? 2.5 : -2.5)] });
    }
    // breakwater head platform + day marker poles
    for (const hx of [-20 - halfLen, -20 + halfLen]) {
      b.add(cyl(9, 11, 4, 10), 'concrete', { pos: [hx, 4.5, bz] });
      b.add(cyl(8.2, 8.2, 0.6, 10), 'deckGray', { pos: [hx, 6.8, bz] });
      b.add(cyl(0.22, 0.32, 6.0, 8), 'safetyYellow', { pos: [hx, 10.3, bz] });
      b.add(box(0.8, 0.8, 0.8), 'darkSteel', { pos: [hx, 13.5, bz] });
      b.add(torus(1.3, 0.16, 4, 12), 'safetyOrange', { pos: [hx, 11.7, bz], rot: [Math.PI * 0.5, 0, 0] });
    }
  }

  // ===========================================================================
  // 8. moored small USVs alongside the piers (instanced + animated bobbing)
  // ===========================================================================
  {
    const proto = makeUSVProtos(M);
    usvDefs = [
      { x: -52 - 11.2, z: 205, yaw: Math.PI * 0.5, phase: 0.4 },
      { x: 0 + 12.2, z: 225, yaw: -Math.PI * 0.5, phase: 2.1 },
      { x: 52 + 11.2, z: 190, yaw: Math.PI * 0.5, phase: 4.0 },
    ];
    for (const key of Object.keys(proto)) {
      if (!proto[key]) continue;
      const mesh = new THREE.InstancedMesh(proto[key], mats[key], usvDefs.length);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      mesh.name = `mooredUSV:${key}`;
      group.add(mesh);
      usvMeshes.push(mesh);
    }
  }

  // ===========================================================================
  // 9. build + blinkers
  // ===========================================================================
  const root = b.build();
  group.add(root);

  // blinking warning lights (single instanced draw call); generous sizes so
  // they read as crisp dots from 3+ km away
  const blinkSpecs = [
    { pos: [TOWER_X, towerBeaconY, TOWER_Z], color: 0xff4436, phase: 0.0, speed: 1.15, size: 2.4 }, // tower aviation
  ];
  // breakwater heads: green (west/entrance) / red (east)
  blinkSpecs.push({ pos: [-180 + 0, 14.4, 325], color: 0x39e37c, phase: 1.1, speed: 0.8, size: 2.2 });
  blinkSpecs.push({ pos: [140 + 0, 14.4, 325], color: 0xff4436, phase: 2.6, speed: 0.8, size: 2.2 });
  // pier head warning lights
  for (const p of PIERS) {
    blinkSpecs.push({ pos: [p.x, PIER_TOP + 7.9, 140 + p.len - 2.5], color: 0xff8c2e, phase: p.x * 0.04 + 1.0, speed: 0.9, size: 1.5 });
  }
  const lightGeo = sphere(0.5, 8, 6);
  const blinkMesh = new THREE.InstancedMesh(lightGeo, M.glowWhite, blinkSpecs.length);
  blinkMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  blinkMesh.frustumCulled = false;
  blinkMesh.name = 'baseWarningLights';
  const color = new THREE.Color();
  for (let i = 0; i < blinkSpecs.length; i++) {
    color.setHex(blinkSpecs[i].color);
    blinkMesh.setColorAt(i, color);
  }
  if (blinkMesh.instanceColor) blinkMesh.instanceColor.needsUpdate = true;
  group.add(blinkMesh);

  const blinkDummy = new THREE.Object3D();
  const updateBlinkers = (time) => {
    for (let i = 0; i < blinkSpecs.length; i++) {
      const s = blinkSpecs[i];
      const on = Math.sin(time * s.speed + s.phase) > 0.1;
      blinkDummy.position.set(s.pos[0], s.pos[1], s.pos[2]);
      blinkDummy.scale.setScalar(on ? s.size : 0.0001);
      blinkDummy.quaternion.identity();
      blinkDummy.updateMatrix();
      blinkMesh.setMatrixAt(i, blinkDummy.matrix);
    }
    blinkMesh.instanceMatrix.needsUpdate = true;
  };

  // ===========================================================================
  // 10. animation
  // ===========================================================================
  const usvDummy = new THREE.Object3D();
  const usvQuat = new THREE.Quaternion();
  const usvEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  const update = (time, dt) => {
    if (towerRadar) towerRadar.rotation.y = time * 0.85 + 0.5;
    if (quayCrane) quayCrane.rotation.y = 0.35 + Math.sin(time * 0.07) * 0.5;
    // moored USVs: heave + pitch/roll from the shared wave field
    for (let i = 0; i < usvDefs.length; i++) {
      const u = usvDefs[i];
      const wave = sampleWave(BX + u.x, BZ + u.z, time);
      const cosH = Math.cos(u.yaw);
      const sinH = Math.sin(u.yaw);
      const slopeFwd = wave.dhdx * cosH + wave.dhdz * sinH;
      const slopeSide = -wave.dhdx * sinH + wave.dhdz * cosH;
      usvEuler.set(
        -slopeFwd * 0.35 + Math.sin(time * 0.7 + u.phase) * 0.01,
        u.yaw,
        slopeSide * 0.5 + Math.sin(time * 0.55 + u.phase) * 0.012,
      );
      usvQuat.setFromEuler(usvEuler);
      usvDummy.position.set(u.x, wave.height * 0.85, u.z);
      usvDummy.quaternion.copy(usvQuat);
      usvDummy.scale.set(1, 1, 1);
      usvDummy.updateMatrix();
      for (let m = 0; m < usvMeshes.length; m++) usvMeshes[m].setMatrixAt(i, usvDummy.matrix);
    }
    for (let m = 0; m < usvMeshes.length; m++) usvMeshes[m].instanceMatrix.needsUpdate = true;
    updateBlinkers(time);
  };

  update(0, 0);
  return { group, update };
}
