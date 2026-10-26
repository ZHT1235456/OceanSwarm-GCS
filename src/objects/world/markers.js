// =============================================================================
// OceanSwarm — navigation markers & remote marine infrastructure.
//
// Contents:
//   • 8 smart wave-measuring buoys   (orange/white, solar, sensor pod, rf cross)
//   • 7 yellow channel spar buoys    (boundary / fairway line)
//   • 3 white research spar buoys    (instrument arms, far offshore)
//   • the reef lighthouse            (rock islet, 30 m white/red tower, beam)
//   • 1 offshore steel jacket platform (legs, deck, crane, helipad, mast)
//   • 5 offshore wind turbines       (slow rotors, per-unit variation)
//   • 3 small rock light-beacons     (distant depth cues)
//
// Buoy bodies are merged prototypes drawn with InstancedMesh (one draw call per
// type), floating / tilting with the shared wave field from core/waves.js.
// Blinking marker lamps are a single InstancedMesh with per-instance colours.
//
// API: createMarkers(materials?) -> { group, update(time, dt) }
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
  smoothstep,
  makeRng,
  fbm2,
  valueNoise2,
  normalizeGeometry,
  matrixFrom,
} from '../../core/geo.js';
import { makeToon, makeMetal, makeGlow, makeGlass, makeOutline } from '../../core/materials.js';

// -----------------------------------------------------------------------------
// Materials: shared registry (primary) with a lazily-built local fallback.
// -----------------------------------------------------------------------------
let _fallbackMaterials = null;

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
// helpers
// -----------------------------------------------------------------------------
const _up = new THREE.Vector3(0, 1, 0);
const _dir = new THREE.Vector3();
const _mid = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _eul = new THREE.Euler();
const _v3 = new THREE.Vector3();
const _dummy = new THREE.Object3D();
const _dummy2 = new THREE.Object3D();

/** Cylinder/pipe between two world points. */
function addBeam(b, key, a, c, radius, tint, seg = 8) {
  _dir.set(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
  const len = _dir.length();
  if (len < 1e-4) return;
  _dir.multiplyScalar(1 / len);
  _quat.setFromUnitVectors(_up, _dir);
  _eul.setFromQuaternion(_quat);
  _mid.set(a[0] + c[0], a[1] + c[1], a[2] + c[2]).multiplyScalar(0.5);
  b.add(cyl(radius, radius, len, seg), key, { pos: [_mid.x, _mid.y, _mid.z], rot: [_eul.x, _eul.y, _eul.z] }, tint);
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

/**
 * Collapse several merged static Builder groups (each already one mesh per
 * material) into one mesh per material across all of them — four landmark
 * builders end up as ~20 draw calls instead of ~60. Dynamic child groups are
 * re-attached to `target` untouched.
 */
function flattenStatic(roots, target) {
  const dynamics = [];
  for (const r of roots) {
    r.updateMatrixWorld(true);
    r.traverse((o) => {
      if (o.userData && o.userData.dynamic) dynamics.push(o);
    });
  }
  for (const d of dynamics) target.attach(d);

  const buckets = new Map();
  for (const r of roots) {
    r.updateMatrixWorld(true);
    r.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      const g = o.geometry.clone();
      g.applyMatrix4(o.matrixWorld);
      const norm = normalizeGeometry(g, true, 0xffffff);
      if (!buckets.has(o.material)) buckets.set(o.material, []);
      buckets.get(o.material).push(norm);
    });
  }
  for (const [mat, geos] of buckets) {
    const merged = mergeGeometries(geos, false);
    geos.forEach((g) => g.dispose());
    if (!merged) {
      console.warn('[markers] static merge failed for', mat?.name || mat?.uuid);
      continue;
    }
    const mesh = new THREE.Mesh(merged, mat);
    target.add(mesh);
  }
  for (const r of roots) {
    r.traverse((o) => {
      if (o.isMesh) o.geometry?.dispose?.();
    });
  }
}

/** Deck railing helper (posts + two rails along a straight segment in XZ). */
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
    b.add(box(0.07, h, 0.07), mat, { pos: [x0 + dx * t, y + h * 0.5, z0 + dz * t] });
  }
  const cx = (x0 + x1) * 0.5;
  const cz = (z0 + z1) * 0.5;
  const ry = -Math.atan2(dz, dx);
  b.add(box(len, 0.07, 0.055), mat, { pos: [cx, y + h, cz], rot: [0, ry, 0] });
  b.add(box(len, 0.05, 0.045), mat, { pos: [cx, y + h * 0.55, cz], rot: [0, ry, 0] });
}

/** Irregular faceted rock, generated from a displaced icosahedron. */
function rockGeometry(seed, detail = 2, rough = 0.34) {
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
    const n = fbm2(nx * 2.3 + seed, nz * 2.3 + ny * 1.7 + seed * 0.7, 4);
    const n2 = valueNoise2(nx * 5.1 + seed, ny * 4.7 - seed);
    const scale = 1 + rough * n + rough * 0.28 * n2;
    pos.setXYZ(i, nx * scale, ny * scale, nz * scale);
  }
  pos.needsUpdate = true;
  g.computeVertexNormals();
  return g;
}

// -----------------------------------------------------------------------------
// Buoy prototypes — each returns { parts, lightLocal, lightKey }
// parts: [geometry, {pos,rot,scale}, tint] merged into one vertex-coloured mesh.
// Local origin = waterline; +Y up.
// -----------------------------------------------------------------------------
const C_ORANGE = 0xff7a1f;
const C_WHITE = 0xf4f7f4;
const C_YELLOW = 0xf2c21c;
const C_DARK = 0x2b343b;
const C_RUBBER = 0x1a2126;
const C_NAVY = 0x173a56;
const C_METAL = 0x9caab3;

function smartBuoyParts() {
  const parts = [];
  // orange flotation hull (below the waterline collar)
  parts.push([lathe([[0.03, -1.15], [0.5, -0.9], [0.95, -0.42], [1.18, 0.05], [1.16, 0.5]], 12), { pos: [0, 0, 0] }, C_ORANGE]);
  // white upper collar / shoulders
  parts.push([lathe([[1.16, 0.5], [1.1, 0.85], [0.92, 1.35], [0.74, 1.8], [0.6, 2.08], [0.48, 2.12]], 12), { pos: [0, 0, 0] }, C_WHITE]);
  parts.push([cyl(0.5, 0.5, 0.12, 12), { pos: [0, 2.13, 0] }, C_WHITE]);
  // rubber ring fender at the waterline
  parts.push([torus(1.2, 0.18, 6, 18), { pos: [0, 0.18, 0], rot: [Math.PI * 0.5, 0, 0] }, C_RUBBER]);
  // upper instrument deck
  parts.push([cyl(0.86, 0.92, 0.2, 12), { pos: [0, 2.3, 0] }, C_WHITE]);
  parts.push([cyl(0.5, 0.58, 0.5, 10), { pos: [0, 2.62, 0] }, C_ORANGE]);
  // solar panel on a small frame
  parts.push([box(1.5, 0.06, 1.02), { pos: [0, 3.0, -0.42], rot: [-0.42, 0, 0] }, C_NAVY]);
  parts.push([box(1.56, 0.05, 1.08), { pos: [0, 2.93, -0.42], rot: [-0.42, 0, 0] }, C_METAL]);
  parts.push([box(0.08, 0.34, 0.08), { pos: [-0.5, 2.86, 0.1] }, C_METAL]);
  parts.push([box(0.08, 0.34, 0.08), { pos: [0.5, 2.86, 0.1] }, C_METAL]);
  // mast + lamp housing
  parts.push([cyl(0.06, 0.08, 1.5, 6), { pos: [0, 3.55, -0.42] }, C_METAL]);
  parts.push([box(0.3, 0.22, 0.3), { pos: [0, 4.33, -0.42] }, C_DARK]);
  // radar reflector: three crossed plates
  parts.push([box(0.82, 0.7, 0.03), { pos: [0, 3.06, 0.56] }, C_METAL]);
  parts.push([box(0.82, 0.03, 0.7), { pos: [0, 3.06, 0.56] }, C_METAL]);
  parts.push([box(0.03, 0.7, 0.7), { pos: [0, 3.06, 0.56] }, C_METAL]);
  // sensor package on the shoulder + whip antenna
  parts.push([box(0.4, 0.3, 0.34), { pos: [0.72, 2.4, 0.28] }, C_ORANGE]);
  parts.push([cyl(0.022, 0.03, 0.9, 5), { pos: [-0.65, 2.9, 0.35] }, C_METAL]);
  return { parts, lightLocal: [0, 4.5, -0.42], lightKey: 'glowOrange', floatOffset: 0 };
}

function channelBuoyParts() {
  const parts = [];
  // slim yellow spar
  parts.push([lathe([[0.04, -0.95], [0.42, -0.7], [0.55, -0.1], [0.56, 0.7], [0.5, 1.9], [0.44, 3.1], [0.4, 3.55]], 10), { pos: [0, 0, 0] }, C_YELLOW]);
  // white top band
  parts.push([lathe([[0.4, 3.55], [0.34, 3.95], [0.26, 4.2]], 10), { pos: [0, 0, 0] }, C_WHITE]);
  parts.push([cyl(0.26, 0.26, 0.1, 10), { pos: [0, 4.24, 0] }, C_WHITE]);
  // black band near the top + light housing
  parts.push([cyl(0.415, 0.42, 0.3, 10), { pos: [0, 3.38, 0] }, C_DARK]);
  parts.push([cyl(0.07, 0.09, 0.5, 6), { pos: [0, 4.47, 0] }, C_METAL]);
  // ring fender + small reflector
  parts.push([torus(0.58, 0.12, 5, 14), { pos: [0, 0.28, 0], rot: [Math.PI * 0.5, 0, 0] }, C_RUBBER]);
  parts.push([box(0.5, 0.4, 0.02), { pos: [0, 2.5, 0.42] }, C_METAL]);
  parts.push([box(0.02, 0.4, 0.5), { pos: [0, 2.5, 0.42] }, C_METAL]);
  return { parts, lightLocal: [0, 4.86, 0], lightKey: 'glowWarm', floatOffset: 0 };
}

function researchBuoyParts() {
  const parts = [];
  // orange float, white spar body
  parts.push([lathe([[0.05, -1.7], [0.7, -1.3], [1.02, -0.55], [1.06, 0.15]], 12), { pos: [0, 0, 0] }, C_ORANGE]);
  parts.push([lathe([[1.06, 0.15], [1.0, 0.8], [0.9, 2.4], [0.8, 4.2], [0.66, 5.6], [0.5, 6.5], [0.36, 6.85]], 12), { pos: [0, 0, 0] }, C_WHITE]);
  parts.push([cyl(0.37, 0.37, 0.12, 12), { pos: [0, 6.9, 0] }, C_WHITE]);
  parts.push([torus(1.08, 0.17, 6, 18), { pos: [0, 0.35, 0], rot: [Math.PI * 0.5, 0, 0] }, C_RUBBER]);
  // instrument arms
  parts.push([box(2.1, 0.09, 0.09), { pos: [0, 4.4, 0], rot: [0, 0.5, 0] }, C_METAL]);
  parts.push([box(2.1, 0.09, 0.09), { pos: [0, 5.5, 0], rot: [0, -0.6, 0] }, C_METAL]);
  parts.push([box(0.46, 0.4, 0.34), { pos: [0.95, 4.25, 0.5] }, C_ORANGE]);
  parts.push([box(0.4, 0.36, 0.3), { pos: [-0.85, 5.35, -0.55] }, C_DARK]);
  parts.push([cyl(0.5, 0.5, 0.5, 8), { pos: [0.9, 5.05, -0.5] }, C_WHITE]);
  // solar panels + rf reflector
  parts.push([box(1.7, 0.06, 1.0), { pos: [0, 7.25, -0.35], rot: [-0.38, 0.2, 0] }, C_NAVY]);
  parts.push([box(0.9, 0.8, 0.03), { pos: [0, 6.4, 0.42] }, C_METAL]);
  parts.push([box(0.03, 0.8, 0.9), { pos: [0, 6.4, 0.42] }, C_METAL]);
  // mast + lamp
  parts.push([cyl(0.06, 0.09, 1.1, 6), { pos: [0, 7.5, 0.3] }, C_METAL]);
  parts.push([box(0.32, 0.24, 0.32), { pos: [0, 8.05, 0.3] }, C_DARK]);
  return { parts, lightLocal: [0, 8.25, 0.3], lightKey: 'glowWhite', floatOffset: 0 };
}

// -----------------------------------------------------------------------------
// Lighthouse
// -----------------------------------------------------------------------------
function buildLighthouse(M, mats) {
  const b = new Builder(mats, { outlineMaterial: M.outlineStructure });

  // --- rocky islet -----------------------------------------------------------
  const mainRock = rockGeometry(3.7, 3, 0.42);
  mainRock.scale(13.2, 7.8, 13.2);
  mainRock.translate(0, -1.2, 0);
  b.add(mainRock, 'islandRock');
  mainRock.dispose();
  // secondary jagged outcrop to break the islet silhouette
  const outcrop = rockGeometry(17.3, 2, 0.46);
  outcrop.scale(7.6, 4.6, 6.8);
  outcrop.rotateY(0.7);
  outcrop.translate(6.2, -0.6, -3.4);
  b.add(outcrop, 'islandRock');
  outcrop.dispose();

  // wet / submerged skirt (darker, reads as the water line)
  const wetRock = rockGeometry(8.1, 2, 0.3);
  wetRock.scale(15.4, 4.6, 15.4);
  wetRock.translate(0, -2.6, 0);
  b.add(wetRock, 'islandRockDark');
  wetRock.dispose();

  // scattered boulders breaking the water around the islet
  const brng = makeRng(42);
  for (let i = 0; i < 13; i++) {
    const a = brng.range(0, TAU);
    const rr = brng.range(9, 19);
    const s = brng.range(1.4, 4.4) * (i % 4 === 0 ? 1.5 : 1);
    const g = rockGeometry(brng.range(0, 50), 1, 0.4);
    g.scale(s * 1.2, s * 0.8, s * 1.15);
    g.rotateY(brng.range(0, TAU));
    g.translate(Math.cos(a) * rr, brng.range(-1.6, 0.6), Math.sin(a) * rr);
    b.add(g, i % 3 === 0 ? 'rockDark' : 'islandRock');
    g.dispose();
  }

  // --- tower plinth ----------------------------------------------------------
  const BASE = 4.5;
  b.add(cyl(4.3, 5.3, 2.2, 10), 'concrete', { pos: [0, BASE - 1.0, 0] });
  b.add(cyl(4.3, 4.3, 0.22, 10), 'deckGray', { pos: [0, BASE + 0.15, 0] });
  // entrance steps + door
  b.add(box(2.4, 0.5, 1.4), 'concrete', { pos: [0, BASE + 0.2, 4.8] });
  b.add(box(1.5, 0.35, 0.9), 'concrete', { pos: [0, BASE + 0.02, 5.6] });
  b.add(box(1.25, 2.0, 0.25), 'darkSteel', { pos: [0, BASE + 1.2, 3.95] });
  b.add(box(1.5, 0.2, 0.4), 'signalOrange', { pos: [0, BASE + 2.3, 3.95] });
  b.add(box(0.5, 0.35, 0.1), 'glowWarm', { pos: [0.75, BASE + 2.0, 3.99] });

  // --- tapered tower (white with red-orange bands) ---------------------------
  b.add(cyl(3.0, 3.4, 2.6, 12), 'white', { pos: [0, BASE + 1.5, 0] });
  b.add(cyl(2.42, 3.0, 9.6, 12), 'white', { pos: [0, BASE + 7.6, 0] });
  b.add(cyl(2.36, 2.42, 2.7, 12), 'safetyOrange', { pos: [0, BASE + 13.75, 0] });
  b.add(cyl(2.02, 2.36, 8.2, 12), 'white', { pos: [0, BASE + 19.2, 0] });
  b.add(cyl(2.0, 2.02, 2.3, 12), 'safetyOrange', { pos: [0, BASE + 24.45, 0] });
  b.add(cyl(1.9, 2.0, 1.8, 12), 'white', { pos: [0, BASE + 27.0, 0] });
  // small porthole windows with warm light
  for (const [yy, aa] of [
    [BASE + 10.0, 0.6],
    [BASE + 16.4, 2.4],
    [BASE + 21.4, 4.1],
    [BASE + 25.6, 5.5],
  ]) {
    const rr = 2.42 - (yy - (BASE + 8)) * 0.018;
    b.add(box(0.5, 0.75, 0.1), 'glassWarm', { pos: [Math.cos(aa) * rr, yy, Math.sin(aa) * rr], rot: [0, -aa + Math.PI * 0.5, 0] });
    b.add(box(0.62, 0.12, 0.16), 'silver', { pos: [Math.cos(aa) * rr, yy - 0.45, Math.sin(aa) * rr], rot: [0, -aa + Math.PI * 0.5, 0] });
  }

  // --- gallery deck / balcony ------------------------------------------------
  // tower body tops out at y = BASE + 27.9 (31.9 above the waterline); the
  // gallery deck, lantern room and dome are stacked continuously on top of it.
  const GAL = BASE + 27.45; // 31.95
  b.add(cyl(2.55, 2.2, 0.5, 12), 'darkSteel', { pos: [0, GAL - 0.15, 0] });
  b.add(ring(2.2, 3.35, 20), 'deckGray', { pos: [0, GAL + 0.12, 0] });
  b.add(torus(3.28, 0.055, 4, 20), 'silver', { pos: [0, GAL + 1.1, 0], rot: [Math.PI * 0.5, 0, 0] });
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * TAU;
    b.add(box(0.06, 1.05, 0.06), 'silver', { pos: [Math.cos(a) * 3.2, GAL + 0.65, Math.sin(a) * 3.2] });
  }
  // gallery support struts
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU + 0.3;
    addBeam(b, 'silver', [Math.cos(a) * 1.85, GAL - 1.2, Math.sin(a) * 1.85], [Math.cos(a) * 3.0, GAL + 0.1, Math.sin(a) * 3.0], 0.09);
  }

  // --- lantern room ----------------------------------------------------------
  const LAN = GAL + 0.12; // gallery floor height
  b.add(cyl(1.25, 1.4, 0.5, 10), 'darkSteel', { pos: [0, LAN + 0.25, 0] });
  b.add(cyl(1.28, 1.28, 2.0, 8), 'glass', { pos: [0, LAN + 1.42, 0] });
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * TAU + Math.PI / 8;
    b.add(box(0.07, 2.0, 0.07), 'silver', { pos: [Math.cos(a) * 1.29, LAN + 1.42, Math.sin(a) * 1.29] });
  }
  b.add(cyl(1.42, 1.42, 0.16, 8), 'silver', { pos: [0, LAN + 2.47, 0] });
  // interior lamp (reads as the characteristic warm dot from far away)
  b.add(sphere(0.95, 10, 8), 'glowWarm', { pos: [0, LAN + 1.35, 0] });
  b.add(dome(1.62, 12, 6, 1.15), 'darkSteel', { pos: [0, LAN + 2.55, 0] });
  b.add(cyl(0.22, 0.34, 0.4, 8), 'metalDark', { pos: [0, LAN + 4.3, 0] });
  b.add(sphere(0.28, 8, 6), 'metalDark', { pos: [0, LAN + 4.65, 0] });
  b.add(cyl(0.03, 0.05, 2.5, 5), 'silver', { pos: [0, LAN + 5.95, 0] });
  b.add(sphere(0.14, 6, 4), 'glowRed', { pos: [0, LAN + 7.25, 0] });
  // faint additive halo around the lamp (stylised, no volumetrics)
  const haloMat = makeGlow(COLORS.warmWhite, {
    transparent: true,
    opacity: 0.16,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const halo = new THREE.Mesh(sphere(2.3, 12, 8), haloMat);
  halo.position.set(0, LAN + 1.35, 0);
  halo.renderOrder = 2;
  b.addMesh(halo);

  // rotating warm beam (subtle additive wedge, no big cone)
  const beamMat = makeGlow(COLORS.warmWhite, {
    transparent: true,
    opacity: 0.055,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const beamGeo = new THREE.PlaneGeometry(26, 2.6);
  beamGeo.rotateX(-Math.PI * 0.5);
  beamGeo.translate(13.2, 0, 0);
  const beam = new THREE.Mesh(beamGeo, beamMat);
  const lanternY = LAN + 1.45;
  const beamGroup = b.dynamic('lhBeam');
  beamGroup.position.set(0, lanternY, 0);
  beamGroup.userData.dynamic = true;
  beamGroup.add(beam);

  // --- equipment hut on the islet -------------------------------------------
  const HX = -6.2;
  const HZ = 2.2;
  b.add(box(4.8, 2.6, 3.8), 'pearl', { pos: [HX, 3.4, HZ] });
  b.add(box(5.0, 0.18, 4.0), 'silver', { pos: [HX, 4.8, HZ] });
  b.add(box(1.0, 1.7, 0.16), 'darkSteel', { pos: [HX, 3.0, HZ + 1.96] });
  b.add(box(0.8, 0.5, 0.12), 'glowWarm', { pos: [HX + 1.3, 3.6, HZ + 1.95] });
  b.add(box(2.6, 0.08, 1.5), 'glass', { pos: [HX, 5.15, HZ], rot: [-0.3, 0, 0] });
  b.add(cyl(0.05, 0.07, 4.2, 5), 'silver', { pos: [HX + 1.9, 6.6, HZ - 1.2] });
  b.add(sphere(0.12, 6, 4), 'glowRed', { pos: [HX + 1.9, 8.75, HZ - 1.2] });
  // exposed conduit from hut to tower
  b.add(cyl(0.1, 0.1, 2.8, 6), 'silver', { pos: [HX + 2.9, 3.5, HZ - 0.2], rot: [0, 0, Math.PI * 0.5] });
  // steps
  for (let i = 0; i < 4; i++) {
    b.add(box(2.2, 0.35, 0.6), 'concrete', { pos: [-1.9 + i * 0.55, 3.6 + i * 0.28, 2.9] });
  }

  const staticGroup = b.build();
  return { group: staticGroup, beamGroup };
}

// -----------------------------------------------------------------------------
// Offshore steel jacket platform
// -----------------------------------------------------------------------------
function buildOffshorePlatform(M, mats) {
  const b = new Builder(mats, { outlineMaterial: M.outlineStructure });
  const deckY = 22.0;
  const deckW = 26;
  const deckD = 19;

  // four battered tubular legs with cross bracing
  const legTops = [
    [-7.5, -5.2],
    [7.5, -5.2],
    [-7.5, 5.2],
    [7.5, 5.2],
  ];
  const legBottoms = legTops.map(([x, z]) => [x * 1.62, z * 1.68]);
  for (let i = 0; i < 4; i++) {
    addBeam(
      b,
      'metalDark',
      [legBottoms[i][0], -18, legBottoms[i][1]],
      [legTops[i][0], deckY + 0.2, legTops[i][1]],
      1.35,
      undefined,
      12,
    );
    // leg base mud-mat / concrete pad
    b.add(cyl(2.4, 2.9, 1.6, 10), 'concrete', { pos: [legBottoms[i][0], -17.0, legBottoms[i][1]] });
  }
  // horizontal bracing rings
  for (const yy of [-9, 1.5, 12.5]) {
    const t = (yy + 18) / (deckY - 0.6 + 18);
    const ring = legBottoms.map(([bx, bz], i) => [lerp(bx, legTops[i][0], t), yy, lerp(bz, legTops[i][1], t)]);
    for (let i = 0; i < 4; i++) {
      addBeam(b, 'metalDark', ring[i], ring[(i + 1) % 4], 0.5);
    }
  }
  // X bracing on all four faces between two levels
  const levelPos = (yy) => {
    const t = (yy + 18) / (deckY - 0.6 + 18);
    return legBottoms.map(([bx, bz], i) => [lerp(bx, legTops[i][0], t), yy, lerp(bz, legTops[i][1], t)]);
  };
  const l1 = levelPos(-9);
  const l2 = levelPos(12.5);
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    addBeam(b, 'metalDark', l1[i], l2[j], 0.38);
    addBeam(b, 'metalDark', l1[j], l2[i], 0.38);
  }
  // conductor / riser pipes up one leg
  for (let i = 0; i < 2; i++) {
    addBeam(b, 'steel', [legBottoms[1][0] - 1.8 - i * 1.0, -17, legBottoms[1][1] + 0.6], [legTops[1][0] - 1.1 - i * 0.7, deckY, legTops[1][1] + 0.4], 0.34);
  }

  // deck slab + girders
  b.solid(box(deckW, 1.3, deckD), 'deckGray', { pos: [0, deckY + 0.65, 0] });
  for (let i = 0; i < 4; i++) {
    b.add(box(deckW - 1.0, 0.8, 0.85), 'metalDark', { pos: [0, deckY - 0.3, -deckD * 0.5 + 2.2 + i * ((deckD - 4.4) / 3)] });
  }
  // deck edge yellow safety curb + railing
  for (const sz of [-1, 1]) {
    b.add(box(deckW, 0.22, 0.3), 'markerYellow', { pos: [0, deckY + 1.4, sz * (deckD * 0.5 - 0.15)] });
    railing(b, -deckW * 0.5 + 0.4, sz * (deckD * 0.5 - 0.3), deckW * 0.5 - 0.4, sz * (deckD * 0.5 - 0.3), deckY + 1.5, { spacing: 3.2 });
  }
  for (const sx of [-1, 1]) {
    b.add(box(0.3, 0.22, deckD), 'markerYellow', { pos: [sx * (deckW * 0.5 - 0.15), deckY + 1.4, 0] });
    railing(b, sx * (deckW * 0.5 - 0.3), -deckD * 0.5 + 0.4, sx * (deckW * 0.5 - 0.3), deckD * 0.5 - 0.4, deckY + 1.5, { spacing: 3.2 });
  }

  // --- deck equipment cabin --------------------------------------------------
  b.solid(box(11.5, 4.6, 7.2), 'pearl', { pos: [3.4, deckY + 2.3, -1.2] });
  b.add(box(11.2, 0.9, 6.9), 'glass', { pos: [3.4, deckY + 3.5, -1.2] });
  for (let i = 0; i < 5; i++) {
    b.add(box(0.16, 1.0, 0.16), 'silver', { pos: [3.4 - 4.4 + i * 2.2, deckY + 3.5, -4.72] });
  }
  b.add(box(1.2, 2.0, 0.18), 'darkSteel', { pos: [5.9, deckY + 1.5, 2.35] });
  b.add(box(1.0, 0.65, 0.12), 'glowWarm', { pos: [7.4, deckY + 2.9, 2.34] });
  b.add(box(12.0, 0.25, 7.7), 'silver', { pos: [3.4, deckY + 4.72, -1.2] });
  // roof kit: antenna, vent, solar
  b.add(cyl(0.06, 0.1, 5.5, 5), 'silver', { pos: [1.2, deckY + 7.5, -2.4] });
  b.add(cyl(0.5, 0.5, 0.7, 8), 'metalDark', { pos: [7.4, deckY + 5.2, -0.4] });
  b.add(box(3.1, 0.08, 1.6), 'glass', { pos: [3.4, deckY + 5.35, -1.2], rot: [-0.28, 0, 0] });
  // transformer + equipment boxes on deck
  b.add(box(2.6, 1.8, 1.8), 'silver', { pos: [-8.5, deckY + 2.2, 4.4] });
  b.add(box(1.4, 1.2, 1.2), 'safetyOrange', { pos: [-5.4, deckY + 1.9, 6.2] });
  b.add(box(2.0, 1.0, 1.2), 'metalDark', { pos: [-9.2, deckY + 1.8, -6.0] });
  b.add(box(0.9, 0.9, 0.9), 'white', { pos: [-11.0, deckY + 1.75, 1.2] });

  // --- deck crane ------------------------------------------------------------
  const crX = -6.4;
  const crZ = -5.2;
  const craneRot = 0.6;
  const crDx = Math.cos(craneRot);
  const crDz = -Math.sin(craneRot);
  const crTilt = 0.6;
  const crPivotY = deckY + 6.3;
  const crLen = 15;
  const crCos = Math.cos(crTilt);
  const crSin = Math.sin(crTilt);
  b.add(cyl(1.5, 1.8, 1.4, 12), 'metalDark', { pos: [crX, deckY + 2.0, crZ] });
  b.add(cyl(0.7, 0.7, 2.2, 8), 'silver', { pos: [crX, deckY + 3.6, crZ] });
  b.add(box(2.8, 1.8, 2.4), 'white', { pos: [crX, deckY + 5.4, crZ] });
  b.add(box(1.6, 0.7, 1.0), 'glass', { pos: [crX + crDx * 1.5, deckY + 5.5, crZ + crDz * 1.5], rot: [0, craneRot, 0] });
  b.add(box(2.0, 1.2, 2.2), 'metalDark', { pos: [crX - crDx * 2.4, deckY + 4.6, crZ - crDz * 2.4], rot: [0, craneRot, 0] });
  const crBoom = frustum(crLen, 1.0, 1.3, 0.55, 0.5);
  crBoom.rotateZ(crTilt);
  b.add(crBoom, 'safetyOrange', {
    pos: [crX + crDx * crLen * 0.5 * crCos, crPivotY + crLen * 0.5 * crSin, crZ + crDz * crLen * 0.5 * crCos],
    rot: [0, craneRot, 0],
  });
  const crTipX = crX + crDx * crLen * crCos;
  const crTipY = crPivotY + crLen * crSin;
  const crTipZ = crZ + crDz * crLen * crCos;
  const crHookY = deckY + 2.6;
  b.add(box(0.09, Math.max(0.5, crTipY - crHookY), 0.09), 'darkSteel', { pos: [crTipX, (crTipY + crHookY) * 0.5, crTipZ] });
  b.add(box(0.8, 0.7, 0.8), 'metalDark', { pos: [crTipX, crHookY, crTipZ] });

  // --- helipad square --------------------------------------------------------
  const hpX = 8.2;
  const hpZ = 5.4;
  b.add(box(11.5, 0.45, 11.5), 'deckDark', { pos: [hpX, deckY + 1.45, hpZ] });
  b.add(box(11.5, 0.16, 0.5), 'markerYellow', { pos: [hpX, deckY + 1.75, hpZ + 5.5] });
  b.add(box(11.5, 0.16, 0.5), 'markerYellow', { pos: [hpX, deckY + 1.75, hpZ - 5.5] });
  b.add(box(0.5, 0.16, 11.5), 'markerYellow', { pos: [hpX + 5.5, deckY + 1.75, hpZ] });
  b.add(box(0.5, 0.16, 11.5), 'markerYellow', { pos: [hpX - 5.5, deckY + 1.75, hpZ] });
  b.add(ring(3.6, 4.1, 24), 'white', { pos: [hpX, deckY + 1.72, hpZ] });
  b.add(ring(1.3, 1.55, 18), 'white', { pos: [hpX, deckY + 1.72, hpZ] });

  // --- comms mast + radome ---------------------------------------------------
  const mastX = 3.4;
  const mastZ = -5.6;
  const mastBase = deckY + 4.85;
  b.add(cyl(0.22, 0.4, 11.5, 8), 'white', { pos: [mastX, mastBase + 5.75, mastZ] });
  b.add(box(6.2, 0.16, 0.16), 'silver', { pos: [mastX, mastBase + 6.4, mastZ] });
  b.add(box(4.0, 0.14, 0.14), 'silver', { pos: [mastX, mastBase + 9.2, mastZ] });
  for (const [ww, yy] of [
    [6.2, mastBase + 6.4],
    [4.0, mastBase + 9.2],
  ]) {
    for (const sx of [-1, 1]) {
      b.add(cyl(0.045, 0.045, 2.1, 5), 'silver', { pos: [mastX + sx * ww * 0.5, yy + 0.3, mastZ] });
    }
  }
  b.add(sphere(0.85, 12, 8), 'white', { pos: [mastX - 0.2, mastBase + 11.9, mastZ] });
  b.add(cyl(0.05, 0.05, 1.8, 5), 'silver', { pos: [mastX, mastBase + 13.0, mastZ] });

  // --- boat landing ladder + fenders on the seaward face ---------------------
  const ladZ = deckD * 0.5 + 0.6;
  for (const sx of [-1, 1]) {
    addBeam(b, 'safetyOrange', [sx * 1.5 - 0.4, deckY + 1.2, ladZ], [sx * 1.5 - 0.4, 1.0, ladZ], 0.08);
  }
  for (let i = 0; i < 9; i++) {
    b.add(box(2.8, 0.06, 0.06), 'safetyOrange', { pos: [-0.4, 2.2 + i * 1.9, ladZ] });
  }
  for (let i = 0; i < 3; i++) {
    b.add(cyl(0.65, 0.65, 0.9, 8), 'rubber', { pos: [legTops[1][0] / 2 + i * 3.0, 3.0, ladZ + 0.2], rot: [Math.PI * 0.5, 0, 0] });
  }

  // warm deck floods + hose reel
  b.add(box(0.9, 0.2, 0.4), 'glowWarm', { pos: [3.4, deckY + 5.0, 2.6] });
  b.add(box(0.9, 0.2, 0.4), 'glowWarm', { pos: [-2.4, deckY + 5.0, 2.6] });
  b.add(cyl(0.7, 0.7, 1.1, 10), 'signalOrange', { pos: [11.0, deckY + 1.9, -7.2], rot: [0, 0, Math.PI * 0.5] });
  b.add(torus(0.45, 0.12, 5, 10), 'safetyOrange', { pos: [-10.5, deckY + 2.4, 7.0], rot: [Math.PI * 0.5, 0, 0] });

  const g = b.build();
  return { group: g, deckY, mastTop: [mastX, mastBase + 13.9, mastZ], heli: [hpX, deckY, hpZ] };
}

// -----------------------------------------------------------------------------
// Wind turbines
// -----------------------------------------------------------------------------
function windTurbineDefs() {
  const perpX = -0.583;
  const perpZ = 0.813;
  const viewX = 0.813;
  const viewZ = 0.583;
  const heights = [93, 88, 99, 90, 95];
  const yaws = [1.92, 2.06, 1.78, 2.14, 1.98];
  const speeds = [0.24, 0.19, 0.29, 0.22, 0.26];
  const defs = [];
  for (let i = 0; i < 5; i++) {
    const t = i / 4 - 0.5;
    const lat = t * LAYOUT.windFarm.spread;
    const stag = [0, 70, 140, 80, 20][i];
    defs.push({
      x: LAYOUT.windFarm.x + perpX * lat + viewX * stag,
      z: LAYOUT.windFarm.z + perpZ * lat + viewZ * stag,
      h: heights[i],
      yaw: yaws[i],
      speed: speeds[i],
      phase: i * 1.9,
      scale: 0.95 + i * 0.022,
    });
  }
  return defs;
}

function buildTurbines(M, mats, defs) {
  const b = new Builder(mats, { outlineMaterial: M.outlineStructure });
  const rotors = [];
  let bladeGeo = null;

  for (let i = 0; i < defs.length; i++) {
    const d = defs[i];
    const s = d.scale;
    const h = d.h * s;
    const dirX = Math.cos(d.yaw);
    const dirZ = -Math.sin(d.yaw);
    const baseY = 7.0;
    // monopile + yellow transition piece + access platform
    b.solid(cyl(3.5 * s, 4.1 * s, 17.0, 10), 'silver', { pos: [d.x, 0.5, d.z] });
    b.add(cyl(3.55 * s, 3.6 * s, 2.4, 10), 'markerYellow', { pos: [d.x, baseY + 0.8, d.z] });
    b.add(ring(3.4 * s, 5.0 * s, 16), 'deckGray', { pos: [d.x, baseY + 2.1, d.z] });
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * TAU;
      b.add(box(0.07, 1.0, 0.07), 'silver', { pos: [d.x + Math.cos(a) * 4.9 * s, baseY + 2.6, d.z + Math.sin(a) * 4.9 * s] });
    }
    b.add(torus(4.9 * s, 0.045, 4, 20), 'silver', { pos: [d.x, baseY + 3.1, d.z], rot: [Math.PI * 0.5, 0, 0] });
    // tower
    b.solid(cyl(1.95 * s, 3.2 * s, h - baseY - 3.0, 12), 'white', { pos: [d.x, (h + baseY + 3.0) * 0.5, d.z] });
    // nacelle (rotated about the tower top)
    b.solid(box(11, 4.4, 4.4), 'white', { pos: [d.x, h + 0.4, d.z], rot: [0, d.yaw, 0] });
    b.add(box(2.2, 0.7, 0.7), 'white', { pos: [d.x - dirX * 6.2, h + 1.4, d.z - dirZ * 6.2], rot: [0, d.yaw, 0] });
    b.add(box(8.0, 1.2, 3.2), 'silver', { pos: [d.x + dirX * 0.6, h + 3.4, d.z + dirZ * 0.6], rot: [0, d.yaw, 0] });
    // hub + spinner at the front
    const hubX = d.x + dirX * 5.8;
    const hubZ = d.z + dirZ * 5.8;
    b.add(cyl(0.9, 1.7, 1.5, 10), 'white', { pos: [hubX - dirX * 0.4, h + 0.4, hubZ - dirZ * 0.4], rot: [0, d.yaw, Math.PI * 0.5] });
    // blades (one merged geometry shared by every rotor)
    if (!bladeGeo) {
      const blade = frustum(0.62, 47, 3.5, 0.55, 0.26);
      blade.rotateY(0.22);
      blade.translate(0, 23.5, 0);
      const tri = [];
      for (let k = 0; k < 3; k++) {
        const g = blade.clone();
        g.rotateX((k / 3) * TAU);
        tri.push([g, {}, 0xffffff]);
      }
      blade.dispose();
      bladeGeo = mergeParts(tri);
    }
    const rotor = new THREE.Group();
    rotor.position.set(hubX, h + 0.4, hubZ);
    rotor.rotation.order = 'YXZ';
    rotor.rotation.y = d.yaw;
    const bladeMesh = new THREE.Mesh(bladeGeo, M.white);
    rotor.add(bladeMesh);
    rotor.scale.setScalar(s);
    rotors.push({ group: rotor, speed: d.speed * (i % 2 === 0 ? 1 : -1), phase: d.phase, yaw: d.yaw });
    // nacelle beacon
    defs[i].beacon = [d.x - dirX * 2.4, h + 4.9, d.z - dirZ * 2.4];
  }

  const staticGroup = b.build();
  return { group: staticGroup, rotors };
}

// -----------------------------------------------------------------------------
// createMarkers
// -----------------------------------------------------------------------------
export function createMarkers(materials) {
  const M = resolveMaterials(materials);

  // local material registry: lets us add a couple of custom colours while still
  // resolving all shared keys through the project registry.
  const mats = Object.create(M);
  mats.markerYellow = makeToon(0xf2c31c, { rim: 0.14 });
  mats.markerRed = makeToon(0xc2503f, { rim: 0.14 });
  const buoyBodyMat = makeToon(0xffffff, { rim: 0.12 });
  buoyBodyMat.vertexColors = true;
  buoyBodyMat.needsUpdate = true;
  mats.buoyBody = buoyBodyMat;

  const root = new THREE.Group();
  root.name = 'markers';

  const rng = makeRng(61123);
  const updaters = [];

  // ==== buoys ================================================================
  const families = [];

  function addBuoyFamily(proto, positions, lightMatKey) {
    const bodyGeo = mergeParts(proto.parts.map(([g, t, tint]) => [g, t, tint]));
    const body = new THREE.InstancedMesh(bodyGeo, mats.buoyBody, positions.length);
    body.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    body.frustumCulled = false;
    body.name = 'buoys';
    root.add(body);
    const lightGeo = sphere(0.62, 8, 6);
    const light = new THREE.InstancedMesh(lightGeo, M[lightMatKey], positions.length);
    light.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    light.frustumCulled = false;
    light.name = 'buoyLights';
    root.add(light);
    const fam = { body, light, positions, lightLocal: proto.lightLocal, lightKey: lightMatKey };
    families.push(fam);
    return fam;
  }

  // 8 smart buoys in a loose 4x2 pattern inside the marker zone (kept clear of
  // the reef shallows so they always float in open water)
  const smartPos = [];
  for (let i = 0; i < 8; i++) {
    const col = i % 4;
    const row = (i / 4) | 0;
    smartPos.push({
      x: -120 + col * 260 + rng.range(-70, 70),
      z: 700 + row * 330 + rng.range(-65, 65),
      yaw: rng.range(0, TAU),
      phase: rng.range(0, TAU),
      blink: rng.range(1.4, 2.1),
    });
  }
  addBuoyFamily(smartBuoyParts(), smartPos, 'glowOrange');

  // 7 yellow channel buoys: regular line marking the fairway boundary
  const chPos = [];
  for (let i = 0; i < 7; i++) {
    const t = i / 6;
    chPos.push({
      x: lerp(-180, 120, t),
      z: lerp(640, 1640, t),
      yaw: rng.range(0, TAU),
      phase: rng.range(0, TAU),
      blink: rng.range(1.5, 2.0),
    });
  }
  addBuoyFamily(channelBuoyParts(), chPos, 'glowWarm');

  // 3 white research spar buoys (two at LAYOUT.farBuoys + one extra)
  const rsPos = [
    { x: LAYOUT.farBuoys[0].x, z: LAYOUT.farBuoys[0].z, yaw: 0.4, phase: 0.0, blink: 0.9 },
    { x: LAYOUT.farBuoys[1].x, z: LAYOUT.farBuoys[1].z, yaw: 1.8, phase: 1.2, blink: 1.1 },
    { x: 1500, z: 3200, yaw: 3.0, phase: 2.4, blink: 1.0 },
  ];
  addBuoyFamily(researchBuoyParts(), rsPos, 'glowWhite');

  const updateBuoys = (time) => {
    for (const fam of families) {
      for (let i = 0; i < fam.positions.length; i++) {
        const p = fam.positions[i];
        const wave = sampleWave(p.x, p.z, time);
        _eul.set(-wave.dhdz * 0.55, p.yaw, wave.dhdx * 0.55, 'YXZ');
        _quat.setFromEuler(_eul);
        _dummy.position.set(p.x, wave.height, p.z);
        _dummy.quaternion.copy(_quat);
        _dummy.scale.set(1, 1, 1);
        _dummy.updateMatrix();
        fam.body.setMatrixAt(i, _dummy.matrix);

        // lamp: on for a fraction of the cycle
        const on = Math.sin(time * p.blink + p.phase) > 0.35;
        _dummy2.position.set(p.x, wave.height, p.z).add(_v3.set(...fam.lightLocal).applyQuaternion(_quat));
        _dummy2.quaternion.identity();
        _dummy2.scale.setScalar(on ? 1 : 0.001);
        _dummy2.updateMatrix();
        fam.light.setMatrixAt(i, _dummy2.matrix);
      }
      fam.body.instanceMatrix.needsUpdate = true;
      fam.light.instanceMatrix.needsUpdate = true;
    }
  };
  updaters.push(updateBuoys);

  // ==== static landmarks =====================================================
  // Built as separate local-space builders, then flattened into one mesh per
  // material at the end (dynamic child groups such as the lighthouse beam are
  // re-attached untouched, keeping their world transform).
  const staticRoots = [];
  const opX = LAYOUT.platform.x;
  const opZ = LAYOUT.platform.z;

  // lighthouse
  const lh = buildLighthouse(M, mats);
  lh.group.position.set(LAYOUT.lighthouse.x, 0, LAYOUT.lighthouse.z);
  staticRoots.push(lh.group);
  const lhBeam = lh.beamGroup;
  updaters.push((time) => {
    lhBeam.rotation.y = time * 0.72;
  });

  // offshore platform
  const op = buildOffshorePlatform(M, mats);
  op.group.position.set(opX, 0, opZ);
  staticRoots.push(op.group);

  // wind farm (rotors are separate dynamic groups)
  const windDefs = windTurbineDefs();
  const wt = buildTurbines(M, mats, windDefs);
  staticRoots.push(wt.group);
  for (const r of wt.rotors) root.add(r.group);
  updaters.push((time) => {
    for (const r of wt.rotors) {
      r.group.rotation.set(r.phase + r.speed * time, r.yaw, 0);
    }
  });

  // distant rock light beacons
  const beaconDefs = [
    { x: 1250, z: 3350, color: 0xff4436 },
    { x: 2950, z: 2050, color: 0x39e37c },
    { x: 3600, z: 1600, color: 0xff4436 },
  ];
  const bb = new Builder(mats, { outlineMaterial: null });
  const beaconLights = [];
  for (let i = 0; i < beaconDefs.length; i++) {
    const d = beaconDefs[i];
    const rock = rockGeometry(11 + i * 3.3, 2, 0.3);
    rock.scale(3.6 + i * 0.4, 2.1 + i * 0.25, 3.6);
    rock.translate(d.x, -0.4, d.z);
    bb.add(rock, 'rockDark');
    rock.dispose();
    const rock2 = rockGeometry(21 + i, 1, 0.4);
    rock2.scale(1.8, 1.2, 1.9);
    rock2.translate(d.x + 2.6, -0.8, d.z - 1.4);
    bb.add(rock2, 'islandRock');
    rock2.dispose();
    // solar-powered light pole on the rock
    const topY = 1.5;
    bb.add(cyl(0.08, 0.11, 4.6, 6), 'silver', { pos: [d.x, topY + 2.3, d.z] });
    bb.add(box(0.4, 0.3, 0.4), 'darkSteel', { pos: [d.x, topY + 4.68, d.z] });
    bb.add(box(0.9, 0.07, 0.6), 'glass', { pos: [d.x, topY + 3.6, d.z + 0.25], rot: [-0.3, 0, 0] });
    bb.add(box(0.22, 0.12, 0.22), 'markerYellow', { pos: [d.x + 0.32, topY + 2.0, d.z] });
    beaconLights.push({ pos: [d.x, topY + 4.92, d.z], color: d.color, phase: i * 2.3, speed: 1.1, size: 2.2 });
  }
  staticRoots.push(bb.build());

  // collapse all static landmark geometry into a handful of material meshes
  flattenStatic(staticRoots, root);

  // ==== all blinking warning / marker lights (one instanced draw call) ======
  // sizes are deliberately generous: these must read as crisp blinking dots
  // from 2-3.5 km away.
  const lightSpecs = [];
  // platform: masthead + deck corner warning lights
  lightSpecs.push({ pos: [opX + op.mastTop[0], op.mastTop[1], opZ + op.mastTop[2]], color: 0xff4436, phase: 0, speed: 1.05, size: 2.4 });
  for (const [sx, sz] of [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ]) {
    lightSpecs.push({ pos: [opX + sx * 12.0, op.deckY + 1.8, opZ + sz * 8.4], color: 0xff8c2e, phase: sx + sz + 1.2, speed: 0.62, size: 1.2 });
  }
  // turbine nacelle aviation lights
  for (let i = 0; i < windDefs.length; i++) {
    const pos = windDefs[i].beacon;
    if (pos) lightSpecs.push({ pos, color: 0xff4436, phase: i * 1.7, speed: 0.95, size: 3.4 });
  }
  // rock beacons
  for (const bl of beaconLights) lightSpecs.push(bl);

  const lightGeo = sphere(0.5, 8, 6);
  const lightMesh = new THREE.InstancedMesh(lightGeo, M.glowWhite, lightSpecs.length);
  lightMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  lightMesh.frustumCulled = false;
  lightMesh.name = 'markerWarnLights';
  const col = new THREE.Color();
  for (let i = 0; i < lightSpecs.length; i++) {
    col.setHex(lightSpecs[i].color);
    lightMesh.setColorAt(i, col);
  }
  if (lightMesh.instanceColor) lightMesh.instanceColor.needsUpdate = true;
  root.add(lightMesh);

  const updateWarnLights = (time) => {
    for (let i = 0; i < lightSpecs.length; i++) {
      const s = lightSpecs[i];
      const on = Math.sin(time * s.speed + s.phase) > 0.1;
      _dummy.position.set(s.pos[0], s.pos[1], s.pos[2]);
      _dummy.quaternion.identity();
      _dummy.scale.setScalar(on ? s.size : 0.0001);
      _dummy.updateMatrix();
      lightMesh.setMatrixAt(i, _dummy.matrix);
    }
    lightMesh.instanceMatrix.needsUpdate = true;
  };
  updaters.push(updateWarnLights);

  // ==== animation ============================================================
  const update = (time, dt) => {
    for (const fn of updaters) fn(time, dt);
  };

  update(0, 0);
  return { group: root, update };
}
