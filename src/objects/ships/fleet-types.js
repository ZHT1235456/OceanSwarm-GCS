// =============================================================================
// OceanSwarm 閳?fleet vessel classes
//
// Seven procedurally built autonomous surface vessels sharing one industrial
// design language: cel-shaded paint blocks (pearl white / silver / deep navy /
// naval grey), thin inverted-hull outlines, small signal-orange and
// fluorescent-cyan identification accents, no crew spaces, no text.
//
// Local vessel space (same convention as every other ship builder):
//   +X = bow, +Y = up, +Z = starboard, origin = waterline amidships.
//
// Public API:
//   createVessel(type, variant = 0, materials) -> {
//     type, length, beam, draft,
//     group,            // THREE.Group in local space (Lead positions it)
//     update(time, dt), // animates radar / gimbal / beacons; never moves group
//     wake: { length, beam, wakeWidth, wakeStrength },
//   }
//
// type 閳?'scout' | 'env' | 'survey' | 'patrol' | 'comms' | 'energy' | 'rescue'
//
// Geometry is merged per material by core/geo Builder (one draw call per
// material key + a single inverted-hull outline mesh). Animated sub-assemblies
// are the only separate meshes and are kept to a handful per boat.
// =============================================================================
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { BOAT_CLASS } from '../../config.js';
import {
  Builder,
  box,
  rbox,
  cyl,
  sphere,
  dome,
  disc,
  torus,
  frustum,
  clamp,
  lerp,
  hullParts,
  hullBand,
  hullSurfacePoint,
  makeRng,
} from '../../core/geo.js';

const PI = Math.PI;
const HALF_PI = Math.PI / 2;
const UP = new THREE.Vector3(0, 1, 0);
const ONE = new THREE.Vector3(1, 1, 1);

// -----------------------------------------------------------------------------
// Extra accent paints (cached on the shared material registry so instances of
// the same class/variant reuse a single material).
// -----------------------------------------------------------------------------
const ACCENT_DEFS = {
  red: [0xd9382c, { rim: 0.12 }],
  teal: [0x2b7c8f, { rim: 0.22 }],
  ink: [0x122b3f, { rim: 0.1 }],
};
const ACCENT_CACHE = new WeakMap();

function accentMaterial(materials, name) {
  const def = ACCENT_DEFS[name];
  if (!def) return null;
  let map = ACCENT_CACHE.get(materials);
  if (!map) {
    map = new Map();
    ACCENT_CACHE.set(materials, map);
  }
  let mat = map.get(name);
  if (!mat) {
    mat = materials.toon(def[0], def[1]);
    mat.name = `fleet-accent-${name}`;
    map.set(name, mat);
  }
  return mat;
}

// -----------------------------------------------------------------------------
// transforms + loose part merging
// -----------------------------------------------------------------------------
function partMatrix(pos, rot, scale) {
  const p = new THREE.Vector3(pos ? pos[0] : 0, pos ? pos[1] : 0, pos ? pos[2] : 0);
  const q = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(rot ? rot[0] : 0, rot ? rot[1] : 0, rot ? rot[2] : 0),
  );
  const s = scale ? new THREE.Vector3(scale[0], scale[1], scale[2]) : ONE;
  return new THREE.Matrix4().compose(p, q, s);
}

/** Merge a list of [geo, pos, rot] parts into one geometry (single material). */
function mergeParts(parts) {
  const list = [];
  for (const part of parts) {
    const src = part[0];
    const geo = src.index ? src.toNonIndexed() : src;
    geo.applyMatrix4(partMatrix(part[1], part[2]));
    list.push(geo);
  }
  const merged = mergeGeometries(list, false);
  for (const geo of list) geo.dispose();
  return merged;
}

function addBox(b, key, w, h, d, x, y, z, rx = 0, ry = 0, rz = 0) {
  b.add(box(w, h, d), key, { pos: [x, y, z], rot: [rx, ry, rz] });
}

function addRBox(b, key, w, h, d, x, y, z, r = 0.06, rx = 0, ry = 0, rz = 0, seg = 2) {
  b.add(rbox(w, h, d, r, seg), key, { pos: [x, y, z], rot: [rx, ry, rz] });
}

function addCyl(b, key, rt, rb, h, x, y, z, rx = 0, ry = 0, rz = 0, seg = 10, open = false) {
  b.add(cyl(rt, rb, h, seg, open), key, { pos: [x, y, z], rot: [rx, ry, rz] });
}

function addSphere(b, key, r, x, y, z, ws = 9, hs = 7) {
  b.add(sphere(r, ws, hs), key, { pos: [x, y, z] });
}

/** Thin cylinder between two points. */
function addRod(b, key, p0, p1, radius = 0.02, seg = 4, open = true) {
  const a = new THREE.Vector3(p0[0], p0[1], p0[2]);
  const c = new THREE.Vector3(p1[0], p1[1], p1[2]);
  const dir = c.clone().sub(a);
  const len = dir.length();
  if (len < 1e-4) return;
  const q = new THREE.Quaternion().setFromUnitVectors(UP, dir.normalize());
  const m = new THREE.Matrix4().compose(a.clone().add(c).multiplyScalar(0.5), q, ONE);
  b.add(cyl(radius, radius, len, seg, open), key, m);
}

// -----------------------------------------------------------------------------
// deck / hull maths
// -----------------------------------------------------------------------------
function uOf(spec, x) {
  return clamp(x / spec.length + 0.5, 0, 1);
}

/** Deck height above the waterline at local x (matches hullParts deck edge). */
function deckY(spec, x) {
  const u = uOf(spec, x);
  return (spec.freeboard ?? 1) + (spec.sheer ?? 0) * Math.pow(u, 2.1);
}

/** Local deck slope (radians, +z rotation for a box lying along X). */
function deckSlope(spec, x) {
  const u = uOf(spec, x);
  return Math.atan2(((spec.sheer ?? 0) * 2.1 * Math.pow(Math.max(u, 1e-4), 1.1)) / spec.length, 1);
}

/** Signed half width of the hull deck edge at local x. */
function deckHalfWidth(spec, x) {
  return hullSurfacePoint(spec, uOf(spec, x), 1, 1).z;
}

/** Flat plate whose top follows the deck sheer. Returns its centre values. */
function addDeckPlate(b, spec, key, x0, x1, width, rise = 0.08, thick = 0.12, r = 0.04, sink = 0) {
  const xc = (x0 + x1) * 0.5;
  const y0 = deckY(spec, x0);
  const y1 = deckY(spec, x1);
  const slope = Math.atan2(y1 - y0, x1 - x0);
  const len = Math.hypot(x1 - x0, y1 - y0);
  const yc = (y0 + y1) * 0.5 + rise - thick * 0.5 - sink;
  b.add(rbox(len, thick, width, Math.min(r, thick * 0.45), 2), key, { pos: [xc, yc, 0], rot: [0, 0, slope] });
  return { xc, yc, slope, top: yc + thick * 0.5, x0, x1, width };
}

/** Dark boot stripe hugging the actual waterline plane (y = 0). */
function waterlineBand(spec, thicknessV = 0.05, offset = 0.02, segments = 34) {
  const verts = [];
  const inds = [];
  for (let i = 0; i <= segments; i++) {
    const u = i / segments;
    let lo = 0.0;
    let hi = 1.0;
    for (let k = 0; k < 12; k++) {
      const mid = (lo + hi) * 0.5;
      if (hullSurfacePoint(spec, u, mid, 1).y < 0) lo = mid;
      else hi = mid;
    }
    const v0 = lo;
    const v1 = Math.min(0.985, v0 + thicknessV);
    const p0 = hullSurfacePoint(spec, u, v0, 1);
    const p1 = hullSurfacePoint(spec, u, v1, 1);
    const k0 = 1 + offset / Math.max(0.28, Math.abs(p0.z));
    const k1 = 1 + offset / Math.max(0.28, Math.abs(p1.z));
    verts.push(p0.x, p0.y, p0.z * k0, p1.x, p1.y, p1.z * k1, p0.x, p0.y, -p0.z * k0, p1.x, p1.y, -p1.z * k1);
  }
  for (let i = 0; i < segments; i++) {
    const a = i * 4;
    const c = (i + 1) * 4;
    inds.push(a, c, a + 1, a + 1, c, c + 1);
    inds.push(a + 2, a + 3, c + 2, a + 3, c + 3, c + 2);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.setIndex(inds);
  geo.computeVertexNormals();
  return geo;
}

/**
 * Flat cap rail that closes the deck-edge / flared-topsides junction and gives
 * the hull a crisp gunwale line. One ribbon per side.
 */
function deckEdgeCap(spec, width = 0.2, lift = 0.032, u0 = 0.035, u1 = 0.965, segments = 34) {
  const rows = [];
  for (let i = 0; i <= segments; i++) {
    const u = lerp(u0, u1, i / segments);
    const p = hullSurfacePoint(spec, u, 1, 1);
    const zOut = p.z + 0.012;
    const zIn = Math.max(0.015, zOut - width);
    rows.push([p.x, p.y + lift, zOut, zIn]);
  }
  const verts = [];
  const inds = [];
  for (const row of rows) verts.push(row[0], row[1], row[2], row[0], row[1], row[3]);
  const base = rows.length * 2;
  for (const row of rows) verts.push(row[0], row[1], -row[2], row[0], row[1], -row[3]);
  for (let i = 0; i < rows.length - 1; i++) {
    const a = i * 2;
    const c = a + 2;
    inds.push(a, c, a + 1, c, c + 1, a + 1);
    inds.push(base + a, base + a + 1, base + c, base + c, base + a + 1, base + c + 1);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.setIndex(inds);
  geo.computeVertexNormals();
  return geo;
}

/** Standard painted hull assembly. */
function addHullBase(b, spec, opts = {}) {
  const {
    hull = 'pearl',
    bottom = 'hullBottom',
    deck = 'deckGray',
    transom = 'navy',
    boot = 'navy',
    rub = 'graphite',
    accent = null,
    cap = 'darkSteel',
    capWidth = 0.2,
    caps = true,
    uMid = [0.05, 0.95],
  } = opts;
  const parts = hullParts(spec);
  b.solid(parts.lower, bottom);
  b.solid(parts.topsides, hull);
  b.add(parts.deck, deck);
  b.add(parts.transom, transom);
  if (boot) b.add(waterlineBand(spec), boot);
  if (rub) b.add(hullBand(spec, 0.885, 0.925, 0.026), rub);
  if (accent) b.add(hullBand(spec, 0.935, 0.956, 0.04), accent);
  if (caps) b.add(deckEdgeCap(spec, capWidth, 0.03, uMid[0], uMid[1]), cap);
  return parts;
}

/** Points along the deck edge, inset by half the cap rail width. */
function hullRailPoints(spec, u0, u1, count, side = 1, capW = 0, zOffset = 0) {
  const pts = [];
  for (let i = 0; i <= count; i++) {
    const u = lerp(u0, u1, i / count);
    const p = hullSurfacePoint(spec, u, 1, side);
    pts.push([p.x, p.y + 0.03, p.z - side * capW * 0.5 + zOffset]);
  }
  return pts;
}

/** Thin tube railing with stanchions; pts are [x,y,z] deck points. */
function addRailRun(b, key, pts, h = 0.8, opts = {}) {
  const { midRail = true, postStep = 1e9, radius = 0.022 } = opts;
  if (!pts || pts.length < 2) return;
  for (let i = 0; i < pts.length - 1; i++) {
    const p = pts[i];
    const n = pts[i + 1];
    addRod(b, key, [p[0], p[1] + h, p[2]], [n[0], n[1] + h, n[2]], radius, 4);
    if (midRail) {
      addRod(
        b,
        key,
        [p[0], p[1] + h * 0.55, p[2]],
        [n[0], n[1] + h * 0.55, n[2]],
        radius * 0.72,
        4,
      );
    }
  }
  let travelled = 0;
  let carry = postStep;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    let place = i === 0;
    if (i > 0) {
      const q = pts[i - 1];
      travelled = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
      carry += travelled;
      if (carry >= postStep) {
        carry = 0;
        place = true;
      }
    }
    if (place) addRod(b, key, [p[0], p[1], p[2]], [p[0], p[1] + h, p[2]], radius * 0.85, 4);
  }
  const last = pts[pts.length - 1];
  addRod(b, key, [last[0], last[1], last[2]], [last[0], last[1] + h, last[2]], radius * 0.85, 4);
}

/** Closed rectangular railing (platform edges, cages). y is a number or fn(x). */
function addRectRail(b, key, x0, x1, z0, z1, y, h = 0.85, opts = {}) {
  const yf = typeof y === 'function' ? y : () => y;
  const pts = [];
  const nx = Math.max(2, Math.round(Math.abs(x1 - x0) / 1.15));
  const nz = Math.max(2, Math.round(Math.abs(z1 - z0) / 1.15));
  for (let i = 0; i <= nx; i++) pts.push([lerp(x0, x1, i / nx), yf(lerp(x0, x1, i / nx)), z1]);
  for (let i = 1; i <= nz; i++) pts.push([x1, yf(x1), lerp(z1, z0, i / nz)]);
  for (let i = 1; i <= nx; i++) pts.push([lerp(x1, x0, i / nx), yf(lerp(x1, x0, i / nx)), z0]);
  for (let i = 1; i < nz; i++) pts.push([x0, yf(x0), lerp(z0, z1, i / nz)]);
  addRailRun(b, key, pts, h, opts);
}

// -----------------------------------------------------------------------------
// generic detail helpers
// -----------------------------------------------------------------------------

/** Black rubber fender segments along both flanks, just above the waterline. */
function addFenders(b, spec, us, opts = {}) {
  const { v = 0.72, length = 0.46, depth = 0.19, zOffset = 0, key = 'rubber', height = 0.11 } = opts;
  for (const side of [-1, 1]) {
    for (const u of us) {
      const uu = clamp(u, 0.02, 0.97);
      const p = hullSurfacePoint(spec, uu, v, side);
      const pa = hullSurfacePoint(spec, Math.max(0.01, uu - 0.015), v, side);
      const pb = hullSurfacePoint(spec, Math.min(0.99, uu + 0.015), v, side);
      const ang = Math.atan2(-(pb.z - pa.z), pb.x - pa.x);
      b.add(rbox(length, height, depth, Math.min(0.05, height * 0.32), 2), key, {
        pos: [p.x, p.y + 0.05, p.z + side * depth * 0.3 + zOffset],
        rot: [0, ang, 0],
      });
    }
  }
}

/** Port (red) / starboard (green) navigation lights on small brackets. */
function addNavLights(b, spec, x, opts = {}) {
  const { height = 0.62, inset = 0.9, redKey = 'glowRed', greenKey = 'glowGreen' } = opts;
  const u = uOf(spec, x);
  const p = hullSurfacePoint(spec, u, 1, 1);
  const y = p.y + height;
  const z = p.z * inset;
  for (const side of [-1, 1]) {
    if (height > 0.15) addRod(b, 'metal', [x, p.y, side * z], [x, y - 0.06, side * z], 0.016, 4);
    b.add(rbox(0.07, 0.09, 0.07, 0.02, 1), 'darkSteel', { pos: [x, y - 0.03, side * z] });
    b.add(sphere(0.042, 8, 6), side < 0 ? redKey : greenKey, { pos: [x, y + 0.035, side * z] });
  }
}

/** Small warm / cyan deck light dot. */
function addDeckLight(b, x, y, z, key = 'glowWarm', r = 0.032) {
  b.add(cyl(r * 1.5, r * 1.7, 0.028, 6), 'darkSteel', { pos: [x, y + 0.014, z] });
  b.add(sphere(r, 7, 5), key, { pos: [x, y + 0.05, z] });
}

/** Thin whip antenna with a dark tip ferrule. */
function addWhip(b, x, y, z, h = 1.4, opts = {}) {
  const { r = 0.014, key = 'metal', tiltZ = 0, phase = 0 } = opts;
  b.add(cyl(r * 0.35, r, h, 5), key, { pos: [x, y + h * 0.5, z], rot: [0, 0, tiltZ] });
  b.add(sphere(r * 1.9, 6, 4), 'darkSteel', {
    pos: [x + Math.sin(tiltZ) * h * 0.98, y + h * Math.cos(tiltZ) * 0.995, z + Math.sin(phase) * 0],
  });
}

function addVent(b, x, y, z, opts = {}) {
  const { w = 0.42, h = 0.22, d = 0.3, rotY = 0 } = opts;
  b.add(rbox(w, h, d, 0.035, 1), 'graphite', { pos: [x, y + h * 0.5, z], rot: [0, rotY, 0] });
  for (let i = 0; i < 3; i++) {
    addBox(b, 'darkSteel', w * 0.9, 0.018, d + 0.012, x, y + h * (0.22 + i * 0.28), z, 0, rotY, 0);
  }
}

function addHatch(b, x, y, opts = {}) {
  const { w = 0.9, d = 0.7, rotY = 0, key = 'deckDark' } = opts;
  b.add(rbox(w, 0.07, d, 0.03, 1), key, { pos: [x, y + 0.035, 0], rot: [0, rotY, 0] });
  b.add(rbox(w * 0.78, 0.045, d * 0.76, 0.02, 1), 'silver', { pos: [x, y + 0.085, 0], rot: [0, rotY, 0] });
  addBox(b, 'metal', 0.02, 0.035, 0.2, x + w * 0.3, y + 0.1, 0, 0, rotY, 0);
}

function addCleat(b, x, y, z, rotY = 0) {
  b.add(rbox(0.28, 0.06, 0.09, 0.03, 1), 'metal', { pos: [x, y + 0.11, z], rot: [0, rotY, 0] });
  addCyl(b, 'metal', 0.034, 0.04, 0.11, x - 0.085, y + 0.055, z, 0, 0, 0, 6);
  addCyl(b, 'metal', 0.034, 0.04, 0.11, x + 0.085, y + 0.055, z, 0, 0, 0, 6);
}

function addLadder(b, x, y, z, h, opts = {}) {
  const { width = 0.34, alongZ = true, key = 'silver', rungs = 5 } = opts;
  const dx = alongZ ? 0 : width * 0.5;
  const dz = alongZ ? width * 0.5 : 0;
  addRod(b, key, [x - dx, y, z - dz], [x - dx, y + h, z - dz], 0.018, 4);
  addRod(b, key, [x + dx, y, z + dz], [x + dx, y + h, z + dz], 0.018, 4);
  for (let i = 1; i < rungs; i++) {
    const yy = y + (h * i) / rungs;
    addRod(b, key, [x - dx, yy, z - dz], [x + dx, yy, z + dz], 0.013, 4);
  }
}

/**
 * Sealed deck cabin / equipment house: rounded body, roof lip, dark glass band
 * with mullions, forward sensor window and a brow visor. Returns its footprint.
 */
function addCabin(b, spec, opts = {}) {
  const {
    x0,
    x1,
    width,
    height,
    body = 'white',
    roof = 'ivory',
    glassKey = 'glass',
    sink = 0.08,
    winH = 0.34,
    winLenFrac = 0.62,
    frontGlass = true,
    aftDoor = true,
    accent = null,
    accentKey = 'signalOrange',
    trim = 'silver',
    baseOffset = 0,
  } = opts;
  const len = x1 - x0;
  const xc = (x0 + x1) * 0.5;
  const y0 = deckY(spec, xc) + baseOffset - sink;
  const yTop = y0 + height;
  b.solid(rbox(len, height, width, Math.min(0.16, height * 0.075), 3), body, { pos: [xc, y0 + height * 0.5, 0] });
  b.add(rbox(len + 0.16, 0.1, width + 0.16, 0.06, 2), roof, { pos: [xc, yTop + 0.05, 0] });
  const bandLen = len * winLenFrac;
  const bandX = xc + len * 0.06;
  const bandY = yTop - winH * 0.5 - 0.2;
  for (const side of [-1, 1]) {
    b.add(rbox(bandLen, winH, 0.055, 0.02, 1), glassKey, { pos: [bandX, bandY, side * width * 0.5] });
    const n = Math.max(2, Math.round(bandLen / 0.95));
    for (let i = 1; i < n; i++) {
      const px = bandX - bandLen * 0.5 + (bandLen * i) / n;
      addBox(b, body, 0.09, winH + 0.05, 0.08, px, bandY, side * width * 0.5);
    }
    b.add(box(bandLen + 0.12, 0.032, 0.075), trim, {
      pos: [bandX, bandY - winH * 0.5 - 0.045, side * width * 0.5],
    });
    if (accent) {
      b.add(rbox(len * 0.8, 0.07, 0.045, 0.02, 1), accentKey, {
        pos: [xc, y0 + 0.16, side * (width * 0.5)],
      });
    }
  }
  if (frontGlass) {
    const fh = Math.min(0.58, height * 0.3);
    b.add(rbox(0.055, fh, width * 0.66, 0.02, 1), glassKey, { pos: [x1 - 0.012, yTop - 0.36, 0] });
    addBox(b, roof, 0.46, 0.07, width * 0.8, x1 + 0.16, yTop + 0.015, 0, 0, 0, -0.3);
  }
  if (aftDoor) {
    const dh = Math.min(1.15, height * 0.62);
    b.add(rbox(0.05, dh, 0.62, 0.02, 1), glassKey, { pos: [x0 + 0.008, y0 + dh * 0.55, 0] });
    addBox(b, trim, 0.05, dh + 0.08, 0.05, x0 + 0.03, y0 + dh * 0.58, 0.36);
    addBox(b, trim, 0.05, dh + 0.08, 0.05, x0 + 0.03, y0 + dh * 0.58, -0.36);
  }
  return { xc, x0, x1, y0, yTop, width, len };
}

// -----------------------------------------------------------------------------
// sensors & animated assemblies
// -----------------------------------------------------------------------------
function addRadar(b, ctx, x, y, z, opts = {}) {
  const { size = 1, phase = 0, speed = 1.35, yaw = 0 } = opts;
  b.add(cyl(size * 0.17, size * 0.22, 0.2, 10), 'darkSteel', { pos: [x, y + 0.1, z] });
  b.add(rbox(size * 0.26, 0.09, size * 0.26, 0.02, 1), 'graphite', { pos: [x, y + 0.235, z] });
  const g = ctx.dyn('radar');
  g.position.set(x, y + 0.3, z);
  g.rotation.y = yaw;
  const bar = mergeParts([
    [box(size * 0.94, 0.1, size * 0.13), [0, 0.055, 0]],
    [box(size * 0.13, 0.17, size * 0.2), [0, 0, 0]],
    [box(size * 0.16, 0.055, size * 0.1), [0, 0.15, 0]],
    [box(size * 0.1, 0.07, size * 0.07), [0, -0.06, 0]],
  ]);
  ctx.dynMesh(g, bar, 'metal');
  ctx.anim.push((time) => {
    g.rotation.y = yaw + phase + time * speed;
  });
  return g;
}

function addGimbal(b, ctx, x, y, z, opts = {}) {
  const { r = 0.17, phase = 0, speed = 0.3, yaw0 = 0 } = opts;
  b.add(cyl(r * 0.68, r * 0.95, 0.16, 10), 'darkSteel', { pos: [x, y + 0.08, z] });
  b.add(rbox(0.11, 0.15, 0.09, 0.02, 1), 'metal', { pos: [x, y + 0.2, z] });
  const g = ctx.dyn('gimbal');
  g.position.set(x, y + 0.31, z);
  ctx.dynMesh(g, sphere(r, 12, 9), 'glass');
  ctx.anim.push((time) => {
    g.rotation.y = yaw0 + phase + Math.sin(time * speed + phase) * 0.65;
    g.rotation.z = Math.sin(time * speed * 0.63 + phase) * 0.1;
  });
  return g;
}

function addBeacon(b, ctx, x, y, z, opts = {}) {
  const { key = 'glowRed', r = 0.055, phase = 0, rate = 0.75, name = 'beacon' } = opts;
  b.add(cyl(r * 1.2, r * 1.55, 0.07, 8), 'darkSteel', { pos: [x, y + 0.035, z] });
  const g = ctx.dyn(name);
  g.position.set(x, y + 0.12, z);
  const mesh = ctx.dynMesh(g, sphere(r, 8, 6), key);
  ctx.anim.push((time) => {
    mesh.visible = ((time * rate + phase) % 1 + 1) % 1 < 0.48;
  });
  return g;
}

function addAnemometer(b, ctx, x, y, z, opts = {}) {
  const { phase = 0, speed = 2.4, size = 0.17 } = opts;
  const parts = [];
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * PI * 2;
    const dx = Math.cos(a) * size;
    const dz = Math.sin(a) * size;
    parts.push([box(size, 0.014, 0.014), [dx * 0.5, 0, dz * 0.5], [0, -a, 0]]);
    parts.push([sphere(0.034, 6, 5), [dx, 0.012, dz], [0, 0, 0]]);
  }
  parts.push([cyl(0.018, 0.02, 0.06, 6), [0, -0.03, 0], [0, 0, 0]]);
  const g = ctx.dyn('anemometer');
  g.position.set(x, y + 0.06, z);
  ctx.dynMesh(g, mergeParts(parts), 'silver');
  ctx.anim.push((time) => {
    g.rotation.y = phase + time * speed;
  });
  return g;
}

function addLidar(b, ctx, x, y, z, opts = {}) {
  const { r = 0.24, h = 0.32, phase = 0, speed = 0.9 } = opts;
  b.add(cyl(r * 1.12, r * 1.22, 0.1, 12), 'darkSteel', { pos: [x, y + 0.05, z] });
  b.add(cyl(r, r, h, 14), 'glass', { pos: [x, y + 0.1 + h * 0.5, z] });
  b.add(cyl(r * 1.02, r * 1.02, 0.06, 14), 'graphite', { pos: [x, y + 0.13 + h, z] });
  const g = ctx.dyn('lidar');
  g.position.set(x, y + 0.1 + h * 0.5, z);
  ctx.dynMesh(g, box(r * 0.5, h * 0.5, 0.05), 'glowCyanSoft', [r * 0.8, 0, 0]);
  ctx.anim.push((time) => {
    g.rotation.y = phase + time * speed;
  });
  return g;
}

/** Parabolic-ish dish: front dark reflector, silver back, rim and feed. */
function addDish(b, base, rot, r = 0.34) {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rot[0], rot[1], rot[2]));
  const bp = new THREE.Vector3(base[0], base[1], base[2]);
  const place = (geo, key, local, localQuat) => {
    const p = new THREE.Vector3(local[0], local[1], local[2]).applyQuaternion(q).add(bp);
    const qq = q.clone();
    if (localQuat) qq.multiply(localQuat);
    b.add(geo, key, new THREE.Matrix4().compose(p, qq, ONE));
  };
  const flip = new THREE.Quaternion().setFromEuler(new THREE.Euler(PI, 0, 0));
  const rimQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(-HALF_PI, 0, 0));
  place(disc(r * 0.94, 16), 'glass', [0, 0.035, 0]);
  place(disc(r * 0.94, 16), 'silver', [0, -0.035, 0], flip);
  place(torus(r * 0.98, 0.03, 5, 16), 'silver', [0, 0, 0], rimQ);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * PI * 2;
    place(
      box(r * 0.88, 0.022, 0.022),
      'metalDark',
      [Math.cos(a) * r * 0.45, 0.045, Math.sin(a) * r * 0.45],
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -a, 0)),
    );
  }
  const feed = new THREE.Vector3(0, 0.34, 0).applyQuaternion(q).add(bp);
  addRod(b, 'metalDark', bp.toArray(), feed.toArray(), 0.015, 4);
  b.add(sphere(0.032, 6, 5), 'darkSteel', { pos: feed.toArray() });
}

/** Cylindrical microwave relay drum mounted on a mast arm. */
function addDrumAntenna(b, base, rot, opts = {}) {
  const { r = 0.2, len = 0.5 } = opts;
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rot[0], rot[1], rot[2]));
  const bp = new THREE.Vector3(base[0], base[1], base[2]);
  const place = (geo, key, local) => {
    const p = new THREE.Vector3(local[0], local[1], local[2]).applyQuaternion(q).add(bp);
    b.add(geo, key, new THREE.Matrix4().compose(p, q, ONE));
  };
  place(cyl(r, r, len, 12), 'silver', [0, 0, 0]);
  place(cyl(r * 1.04, r * 1.04, 0.055, 12), 'white', [0, len * 0.5 + 0.02, 0]);
  place(disc(r * 0.8, 12), 'glass', [0, len * 0.5 + 0.06, 0]);
  place(cyl(r * 0.34, 0.05, len, 6), 'metal', [0, len * 0.8, 0]);
  return bp;
}

function addSolarPanel(b, x, y, z, w, d, rot = [0, 0, 0]) {
  b.add(rbox(w, 0.05, d, 0.02, 1), 'silver', { pos: [x, y, z], rot });
  b.add(box(w * 0.92, 0.05, d * 0.9), 'navy', { pos: [x, y + 0.02, z], rot });
  b.add(box(w * 0.84, 0.012, 0.028), 'silver', { pos: [x, y + 0.055, z], rot });
}

function addSolarArray(b, cx, cy, cz, cols, rows, pw, pd, gap, rot = [0, 0, 0]) {
  const totalW = cols * pw + (cols - 1) * gap;
  const totalD = rows * pd + (rows - 1) * gap;
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      const ox = -totalW * 0.5 + pw * 0.5 + i * (pw + gap);
      const oz = -totalD * 0.5 + pd * 0.5 + j * (pd + gap);
      addSolarPanel(b, cx + ox, cy, cz + oz, pw, pd, rot);
    }
  }
}

/** Orange/white lifebuoy ring. rot orients the ring plane (normal = local +Z). */
function addLifebuoy(b, x, y, z, opts = {}) {
  const { r = 0.31, rot = [0, 0, 0], ringKey = 'safetyOrange' } = opts;
  const baseQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(rot[0], rot[1], rot[2]));
  const bp = new THREE.Vector3(x, y, z);
  const place = (geo, key, local, localQuat) => {
    const p = new THREE.Vector3(local ? local[0] : 0, local ? local[1] : 0, local ? local[2] : 0)
      .applyQuaternion(baseQ)
      .add(bp);
    const q = baseQ.clone();
    if (localQuat) q.multiply(localQuat);
    b.add(geo, key, new THREE.Matrix4().compose(p, q, ONE));
  };
  place(torus(r, 0.055, 5, 14), ringKey);
  for (const a of [PI * 0.16, PI * 1.16]) {
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, a));
    place(new THREE.TorusGeometry(r, 0.058, 4, 5, PI * 0.4), 'white', null, q);
  }
}

// -----------------------------------------------------------------------------
// per-class hull specifications (dimensions come from BOAT_CLASS)
// -----------------------------------------------------------------------------
const HULL_SPECS = {
  scout: (c) => ({
    length: c.length,
    beam: c.beam,
    draft: c.draft,
    freeboard: 0.74,
    sheer: 0.42,
    bowSharp: 1.38,
    flare: 0.24,
    rocker: 0.62,
    sternWidth: 0.78,
    camber: 0.05,
    rake: 0.18,
    sectionPower: 0.62,
    uSegments: 40,
    rowsLower: 5,
    rowsUpper: 6,
  }),
  env: (c) => ({
    length: c.length,
    beam: c.beam,
    draft: c.draft,
    freeboard: 1.05,
    sheer: 0.38,
    bowSharp: 1.0,
    flare: 0.2,
    rocker: 0.42,
    sternWidth: 0.92,
    camber: 0.07,
    rake: 0.12,
    sectionPower: 0.55,
    uSegments: 44,
    rowsLower: 6,
    rowsUpper: 7,
  }),
  survey: (c) => ({
    length: c.length,
    beam: 1.9, // beam of a single catamaran hull; total beam comes from BOAT_CLASS
    draft: c.draft,
    freeboard: 1.12,
    sheer: 0.34,
    bowSharp: 1.42,
    flare: 0.1,
    rocker: 0.52,
    sternWidth: 0.8,
    camber: 0.03,
    rake: 0.24,
    sectionPower: 0.68,
    uSegments: 40,
    rowsLower: 5,
    rowsUpper: 6,
  }),
  patrol: (c) => ({
    length: c.length,
    beam: c.beam,
    draft: c.draft,
    freeboard: 0.95,
    sheer: 0.42,
    bowSharp: 1.08,
    flare: 0.22,
    rocker: 0.5,
    sternWidth: 0.86,
    camber: 0.06,
    rake: 0.16,
    sectionPower: 0.6,
    uSegments: 42,
    rowsLower: 6,
    rowsUpper: 6,
  }),
  comms: (c) => ({
    length: c.length,
    beam: c.beam,
    draft: c.draft,
    freeboard: 1.35,
    sheer: 0.45,
    bowSharp: 0.92,
    flare: 0.2,
    rocker: 0.4,
    sternWidth: 0.95,
    camber: 0.08,
    rake: 0.12,
    sectionPower: 0.5,
    uSegments: 44,
    rowsLower: 6,
    rowsUpper: 7,
  }),
  energy: (c) => ({
    length: c.length,
    beam: c.beam,
    draft: c.draft,
    freeboard: 1.45,
    sheer: 0.45,
    bowSharp: 0.9,
    flare: 0.22,
    rocker: 0.38,
    sternWidth: 0.96,
    camber: 0.08,
    rake: 0.1,
    sectionPower: 0.48,
    uSegments: 46,
    rowsLower: 6,
    rowsUpper: 7,
  }),
  rescue: (c) => ({
    length: c.length,
    beam: c.beam,
    draft: c.draft,
    freeboard: 1.1,
    sheer: 0.4,
    bowSharp: 1.05,
    flare: 0.22,
    rocker: 0.48,
    sternWidth: 0.9,
    camber: 0.07,
    rake: 0.15,
    sectionPower: 0.55,
    uSegments: 44,
    rowsLower: 6,
    rowsUpper: 7,
  }),
};

// signal accent per class / variant (0, 1, 2) 閳?variants only re-fit equipment
const ACCENTS = {
  scout: ['signalOrange', 'techCyan', 'techCyan'],
  env: ['techCyan', 'signalOrange', 'warmWhite'],
  survey: ['techCyan', 'signalOrange', 'warmWhite'],
  patrol: ['signalOrange', 'techCyan', 'safetyOrange'],
  comms: ['warmWhite', 'techCyan', 'signalOrange'],
  energy: ['techCyan', 'signalOrange', 'warmWhite'],
  rescue: ['safetyOrange', 'safetyOrange', 'signalOrange'],
};

function seedOf(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// -----------------------------------------------------------------------------
// factory
// -----------------------------------------------------------------------------
export function createVessel(type, variant = 0, materials) {
  const cls = BOAT_CLASS[type];
  if (!cls) throw new Error(`[fleet-types] unknown vessel type "${type}"`);
  if (!materials || typeof materials !== 'object') {
    throw new Error('[fleet-types] createVessel(type, variant, materials) requires the material registry');
  }
  const v = (((variant | 0) % 3) + 3) % 3;
  const spec = HULL_SPECS[type](cls);
  const mats = { ...materials };
  const builder = VESSEL_BUILDERS[type];
  if (!builder) throw new Error(`[fleet-types] no builder for vessel type "${type}"`);
  const b = new Builder(mats, { outlineMaterial: materials.outlineBoatSmall });
  const anim = [];
  const ctx = {
    base: materials,
    mats,
    anim,
    variant: v,
    accent: ACCENTS[type][v],
    rng: makeRng(seedOf(`${type}:${v}`)),
    dyn(name) {
      return b.dynamic(name);
    },
    dynMesh(group, geo, key, pos = [0, 0, 0], rot = [0, 0, 0]) {
      const mesh = new THREE.Mesh(geo, mats[key]);
      mesh.position.set(pos[0], pos[1], pos[2]);
      mesh.rotation.set(rot[0], rot[1], rot[2]);
      group.add(mesh);
      return mesh;
    },
    accentMat(name) {
      const mat = accentMaterial(materials, name);
      if (!mat) return null;
      mats[`accent-${name}`] = mat;
      return `accent-${name}`;
    },
  };
  builder(b, spec, v, ctx);
  const group = b.build();
  group.name = `${type}-v${v}`;
  group.userData = { fleetType: type, variant: v, length: cls.length, beam: cls.beam, draft: cls.draft };
  const update = (time) => {
    for (let i = 0; i < anim.length; i++) anim[i](time, 0);
  };
  return {
    type,
    length: cls.length,
    beam: cls.beam,
    draft: cls.draft,
    group,
    update,
    wake: {
      length: cls.length,
      beam: cls.beam,
      wakeWidth: cls.wakeWidth,
      wakeStrength: cls.wakeStrength,
    },
  };
}

// =============================================================================
// 1. SCOUT 閳?10.5 m fast deep-V reconnaissance USV
//    slim fine-entry hull, low sealed equipment deck, waterjet stern,
//    low angular electronics pod, EO ball, small scan radar, blade antennas.
// =============================================================================
function buildScout(b, spec, variant, ctx) {
  const L = spec.length;
  const accent = ctx.accent;
  const wedgeKey = variant === 0 ? 'signalOrange' : accent === 'signalOrange' ? 'techCyan' : accent;
  const stripKey = wedgeKey === 'signalOrange' ? 'techCyan' : 'signalOrange';

  addHullBase(b, spec, {
    hull: 'pearl',
    bottom: 'hullBottom',
    deck: 'deckGray',
    transom: 'navy',
    boot: 'navy',
    rub: 'graphite',
    accent: stripKey,
    cap: 'darkSteel',
    capWidth: 0.18,
  });

  // spray chine strake just above the waterline (fast deep-V signature)
  b.add(hullBand(spec, 0.5, 0.535, 0.012), 'graphite');

  // --- low seamless equipment deck ------------------------------------------
  const deckTop = (x) => deckY(spec, x) + 0.1;
  const plate = addDeckPlate(b, spec, 'deckGray', -4.3, 0.9, 2.05, 0.1, 0.13, 0.05);
  // coaming edge so the raised plate reads as one moulded part of the hull
  for (const side of [-1, 1]) {
    b.add(rbox(5.2, 0.1, 0.09, 0.03, 1), 'darkSteel', {
      pos: [-1.7, plate.top - 0.02, side * 1.02],
      rot: [0, 0, plate.slope],
    });
  }
  // deck light dots along the plate
  addDeckLight(b, -3.1, deckTop(-3.1), 0.55, 'glowCyan', 0.026);
  addDeckLight(b, -1.6, deckTop(-1.6), -0.72, 'glowWarm', 0.03);

  // --- sealed electronics pod (faceted, no windows except sensor slit) ------
  const podX = -1.5;
  const podBase = deckTop(podX);
  b.solid(frustum(2.1, 0.58, 1.4, 0.86, 0.83), 'pearl', { pos: [podX, podBase + 0.29, 0] });
  b.add(rbox(1.92, 0.06, 1.28, 0.03, 1), 'ivory', { pos: [podX, podBase + 0.61, 0] });
  // front sensor slit
  b.add(rbox(0.055, 0.15, 0.98, 0.02, 1), 'glass', {
    pos: [podX + 0.97, podBase + 0.33, 0],
    rot: [0, 0, 0.214],
  });
  // silver panel seams / base trim
  addBox(b, 'silver', 1.82, 0.014, 0.022, podX, podBase + 0.642, 0.34);
  addBox(b, 'silver', 1.82, 0.014, 0.022, podX, podBase + 0.642, -0.34);
  for (const side of [-1, 1]) {
    addBox(b, 'metal', 2.04, 0.05, 0.03, podX, podBase + 0.06, side * 0.7);
  }
  // pod vents + rear hatch
  addVent(b, podX - 0.85, deckTop(podX - 0.85) + 0.02, 0.5, { w: 0.26, h: 0.16, d: 0.3 });
  addVent(b, podX - 0.85, deckTop(podX - 0.85) + 0.02, -0.5, { w: 0.26, h: 0.16, d: 0.3 });
  addRBox(b, 'graphite', 0.1, 0.34, 0.72, podX - 1.06, podBase + 0.3, 0, 0.03);

  // --- EO ball on a short pedestal (an animated gimbal) ---------------------
  addGimbal(b, ctx, 0.42, deckTop(0.42), 0, { r: 0.16, phase: 0.7, speed: 0.34, yaw0: 0 });

  // --- small scan radar on a short mast aft of the pod ----------------------
  const mastX = -3.2;
  const mastBase = deckTop(mastX);
  addCyl(b, 'graphite', 0.055, 0.075, 0.5, mastX, mastBase + 0.25, 0, 0, 0, 0, 8);
  addRBox(b, 'metal', 0.3, 0.08, 0.3, mastX, mastBase + 0.5, 0, 0.02);
  addRadar(b, ctx, mastX, mastBase + 0.5, 0, { size: 0.68, phase: 0.2, speed: 1.45 });
  // masthead light on its own short post
  addCyl(b, 'metal', 0.022, 0.03, 1.0, mastX - 0.28, mastBase + 0.5, 0.14, 0, 0, 0, 5);
  b.add(sphere(0.032, 6, 5), 'glowWhite', { pos: [mastX - 0.28, mastBase + 1.02, 0.14] });
  // blade antennas (raked aft, low observable)
  for (const side of [-1, 1]) {
    b.add(box(0.05, 0.34, 0.13), 'graphite', {
      pos: [mastX - 0.5, mastBase + 0.17, side * 0.62],
      rot: [0, 0, 0.3],
    });
    b.add(box(0.05, 0.24, 0.1), 'graphite', {
      pos: [mastX - 0.95, mastBase + 0.12, side * 0.72],
      rot: [0, 0, 0.34],
    });
  }
  if (variant === 1) {
    // extra signals-intelligence canister + twin whip
    addRBox(b, 'graphite', 0.5, 0.26, 0.42, -4.35, deckY(spec, -4.35) + 0.13, 0.52, 0.04);
    addWhip(b, -4.35, deckY(spec, -4.35) + 0.26, 0.52, 1.15, { r: 0.011, tiltZ: 0.06 });
  }
  addWhip(b, -4.4, deckY(spec, -4.4), -0.55, 1.3, { r: 0.012, tiltZ: 0.08 });

  // --- compact waterjet stern block -----------------------------------------
  const jetBase = deckY(spec, -4.65);
  b.add(rbox(1.1, 0.42, 1.86, 0.08, 2), 'darkSteel', { pos: [-4.65, jetBase + 0.21, 0] });
  b.add(rbox(1.16, 0.08, 1.94, 0.03, 1), 'graphite', { pos: [-4.65, jetBase + 0.46, 0] });
  for (const side of [-1, 1]) {
    addCyl(b, 'metalDark', 0.19, 0.23, 0.5, -5.16, 0.02, side * 0.55, 0, 0, HALF_PI, 10);
    addCyl(b, 'black', 0.15, 0.15, 0.06, -5.42, 0.02, side * 0.55, 0, 0, HALF_PI, 10);
  }
  addDeckLight(b, -4.5, jetBase + 0.46, 0, 'glowCyan', 0.026);

  // --- flat bow: flush hatch + orange identification wedge + cleats ---------
  addHatch(b, 2.0, deckY(spec, 2.0) + 0.02, { w: 0.85, d: 0.6, rotY: 0 });
  const tri = cyl(0.5, 0.5, 0.04, 3);
  b.add(tri, wedgeKey, {
    pos: [3.15, deckY(spec, 3.15) + 0.06, 0],
    rot: [0, HALF_PI, 0],
    scale: [1.4, 1, 2.2],
  });
  addBox(b, stripKey, 0.32, 0.035, 0.7, 1.55, deckY(spec, 1.55) + 0.05, 0);
  addCleat(b, 4.35, deckY(spec, 4.35), 0.42);
  addCleat(b, 4.35, deckY(spec, 4.35), -0.42);
  addCleat(b, -4.9, deckY(spec, -4.9), 0.6);
  addCleat(b, -4.9, deckY(spec, -4.9), -0.6);

  // --- lights ---------------------------------------------------------------
  addNavLights(b, spec, 0.35, { height: 0.66, inset: 0.9 });
  addBeacon(b, ctx, podX - 0.55, podBase + 0.64, 0.42, { key: 'glowOrange', phase: 0.3, rate: 0.85 });

  // --- rails (low grab rails fore and aft) ----------------------------------
  addRailRun(b, 'metal', hullRailPoints(spec, 0.71, 0.94, 6, 1, 0.18), 0.5, { midRail: false, postStep: 0.9 });
  addRailRun(b, 'metal', hullRailPoints(spec, 0.71, 0.94, 6, -1, 0.18), 0.5, { midRail: false, postStep: 0.9 });
  addRailRun(b, 'metal', hullRailPoints(spec, 0.05, 0.2, 4, 1, 0.18), 0.58, { midRail: false, postStep: 0.9 });
  addRailRun(b, 'metal', hullRailPoints(spec, 0.05, 0.2, 4, -1, 0.18), 0.58, { midRail: false, postStep: 0.9 });

  // --- fenders --------------------------------------------------------------
  addFenders(b, spec, [0.16, 0.28, 0.4, 0.52].map((u) => u + ctx.rng.range(-0.01, 0.01)), { v: 0.72, length: 0.44, depth: 0.17 });
}

// =============================================================================
// 2. ENV 閳?16.5 m environmental monitoring USV
//    stable monohull, low white lab cabin, aft automatic sampling platform with
//    lift frame / bottle rack / guide rollers / folding probe arm, lidar mast.
// =============================================================================
function buildEnv(b, spec, variant, ctx) {
  const accent = ctx.accent;
  addHullBase(b, spec, {
    hull: 'pearl',
    bottom: 'hullBottom',
    deck: 'deckGray',
    transom: 'navy',
    boot: 'navy',
    rub: 'graphite',
    accent,
    cap: 'ivory',
    capWidth: 0.24,
  });

  // --- low white lab cabin --------------------------------------------------
  const cabin = addCabin(b, spec, {
    x0: 0.6,
    x1: 4.6,
    width: 3.2,
    height: 1.9,
    body: 'white',
    roof: 'ivory',
    accent: true,
    accentKey: accent,
    winH: 0.36,
  });
  const roofY = cabin.yTop + 0.1;
  // rooftop sensor suite
  addLidar(b, ctx, 2.35, roofY, 0, { r: 0.25, h: 0.34, phase: 0.4, speed: 0.9 });
  addVent(b, 1.25, roofY, 0.95, { w: 0.42, h: 0.2, d: 0.3 });
  addVent(b, 1.25, roofY, -0.95, { w: 0.42, h: 0.2, d: 0.3 });
  for (const side of [-1, 1]) {
    addCyl(b, 'white', 0.13, 0.15, 0.07, 3.9, roofY + 0.035, side * 0.95, 0, 0, 0, 10);
    b.add(dome(0.16, 12, 6, 0.8), 'pearl', { pos: [3.9, roofY + 0.06, side * 0.95] });
    addWhip(b, 4.25, roofY, side * 0.6, 1.05, { r: 0.012, tiltZ: side * 0.05 });
  }
  // cabin roof grab rails
  for (const side of [-1, 1]) {
    addRod(b, 'metal', [1.05, roofY + 0.14, side * 1.48], [4.0, roofY + 0.14, side * 1.48], 0.018, 4);
    addRod(b, 'metal', [1.5, roofY + 0.1, side * 1.48], [1.5, roofY + 0.14, side * 1.48], 0.016, 4);
    addRod(b, 'metal', [3.5, roofY + 0.1, side * 1.48], [3.5, roofY + 0.14, side * 1.48], 0.016, 4);
  }
  // side door + ladder
  addLadder(b, 4.95, deckY(spec, 4.95), 1.3, 1.8, { width: 0.36, alongZ: true });
  addBox(b, 'deckGray', 0.9, 0.06, 0.8, 4.9, deckY(spec, 4.9) + 0.03, 1.0);

  // --- aft automatic sampling platform -------------------------------------
  const plat = addDeckPlate(b, spec, 'deckGray', -7.7, -2.9, 4.5, 0.16, 0.14, 0.05);
  const platTop = plat.top;
  const platY = (x) => deckY(spec, x) + 0.16;
  // non-slip strips
  for (let i = 0; i < 4; i++) {
    b.add(box(0.06, 0.02, 3.9, 1, 1, 1), 'deckDark', {
      pos: [-7.2 + i * 1.1, platTop + 0.005, 0],
      rot: [0, 0, plat.slope],
    });
  }
  // lift rail frame (open stern, starboard sampling opening)
  const railLine = (x0, z0, x1, z1, n = 6) => {
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const x = lerp(x0, x1, t);
      pts.push([x, platY(x), lerp(z0, z1, t)]);
    }
    return pts;
  };
  addRailRun(b, 'metal', railLine(-7.45, -2.1, -3.1, -2.1), 1.35, { postStep: 1.05 });
  addRailRun(b, 'metal', railLine(-7.45, 2.1, -6.2, 2.1, 3), 1.35, { postStep: 1.05 });
  addRailRun(b, 'metal', railLine(-4.7, 2.1, -3.1, 2.1, 3), 1.35, { postStep: 1.05 });
  addRailRun(b, 'metal', railLine(-3.1, -2.1, -3.1, 2.1), 1.35, { postStep: 1.05 });
  // bottle rack (6 sealed sample bottles)
  const rackX = -4.7;
  const rackZ = -1.35;
  b.add(rbox(1.35, 0.1, 0.9, 0.03, 2), 'metalDark', { pos: [rackX, platTop + 0.05, rackZ] });
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 2; j++) {
      const bx = rackX - 0.42 + i * 0.42;
      const bz = rackZ - 0.2 + j * 0.4;
      addCyl(b, 'glass', 0.082, 0.082, 0.4, bx, platTop + 0.3, bz, 0, 0, 0, 8);
      addCyl(b, 'silver', 0.05, 0.058, 0.07, bx, platTop + 0.53, bz, 0, 0, 0, 8);
    }
  }
  for (const side of [-1, 1]) {
    addRod(b, 'metal', [rackX - 0.72, platTop + 0.6, rackZ + side * 0.28], [rackX + 0.72, platTop + 0.6, rackZ + side * 0.28], 0.015, 4);
  }
  // instrument modules
  for (const side of [-1, 1]) {
    addRBox(b, 'ivory', 0.85, 0.5, 0.62, -3.5, platTop + 0.27, side * 1.45, 0.05);
    b.add(rbox(0.5, 0.06, 0.34, 0.02, 1), 'glassLight', {
      pos: [-3.42, platTop + 0.54, side * 1.45],
      rot: [0, 0, -0.12],
    });
    addVent(b, -3.75, platTop + 0.02, side * 1.45, { w: 0.2, h: 0.16, d: 0.28 });
  }
  // guide rollers across the stern
  for (const yy of [0.14, 0.42]) {
    addCyl(b, 'metalDark', 0.075, 0.075, 3.8, -7.45, platTop + yy, 0, HALF_PI, 0, 0, 8);
    for (const side of [-1, 1]) {
      addRBox(b, 'metal', 0.28, 0.1, 0.16, -7.45, platTop + yy - 0.08, side * 1.92, 0.02);
    }
  }
  // sloped stern recovery ramp (platform edge down towards the waterline)
  b.add(rbox(0.95, 0.06, 2.0, 0.03, 1), 'deckDark', {
    pos: [-7.95, 0.915, 0],
    rot: [0, 0, 0.7],
  });
  for (const side of [-1, 1]) {
    addRod(b, 'metal', [-7.6, platY(-7.6), side * 0.98], [-8.3, 0.66, side * 0.98], 0.02, 4);
  }
  // folding probe arm reaching towards the water
  const armBase = [-7.0, platTop, 1.92];
  addCyl(b, 'graphite', 0.11, 0.13, 0.42, armBase[0], armBase[1] + 0.21, armBase[2], 0, 0, 0, 8);
  addCyl(b, 'metal', 0.075, 0.075, 0.16, armBase[0], armBase[1] + 0.46, armBase[2], HALF_PI, 0, 0, 8);
  const elbow = [-8.05, platTop + 0.18, 2.48];
  addRod(b, 'silver', [armBase[0], armBase[1] + 0.46, armBase[2]], elbow, 0.045, 6);
  addCyl(b, 'metalDark', 0.075, 0.075, 0.18, elbow[0], elbow[1], elbow[2], 0, HALF_PI, 0, 8);
  const wrist = [-8.55, 0.52, 2.35];
  addRod(b, 'silver', elbow, wrist, 0.038, 6);
  addCyl(b, 'graphite', 0.06, 0.085, 0.24, wrist[0], wrist[1] - 0.09, wrist[2], 0, 0, 0.22, 8);
  b.add(sphere(0.055, 7, 5), 'glass', { pos: [wrist[0] - 0.05, wrist[1] - 0.22, wrist[2]] });
  addRod(b, 'rubber', [armBase[0], armBase[1] + 0.4, armBase[2] + 0.08], [elbow[0], elbow[1] + 0.05, elbow[2] + 0.08], 0.018, 4);
  // arm base cable reel
  addCyl(b, 'graphite', 0.2, 0.2, 0.16, -6.7, platTop + 0.28, 1.75, 0, 0, HALF_PI, 10);
  for (const r of [0.215, 0.17]) {
    b.add(torus(r, 0.026, 4, 12), 'rubber', { pos: [-6.7, platTop + 0.28, 1.75], rot: [0, HALF_PI, 0] });
  }
  if (variant === 1) {
    // extra water-sample carousel + spare module
    addCyl(b, 'metalDark', 0.42, 0.42, 0.18, -5.9, platTop + 0.12, 0.95, 0, 0, 0, 12);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * PI * 2;
      addCyl(b, 'glass', 0.06, 0.06, 0.22, -5.9 + Math.cos(a) * 0.28, platTop + 0.3, 0.95 + Math.sin(a) * 0.28, 0, 0, 0, 6);
    }
    addRBox(b, 'ivory', 0.7, 0.4, 0.55, -3.6, platTop + 0.22, 0.2, 0.04);
  }
  if (variant === 2) {
    // second environmental mast cross-arm + extra flank probes
    addRod(b, 'metal', [-3.1, platTop + 1.4, 1.75], [-4.0, platTop + 1.85, 1.75], 0.02, 4);
    addRBox(b, 'graphite', 0.22, 0.16, 0.22, -4.02, platTop + 1.9, 1.75, 0.03);
  }

  // --- environmental sensor mast -------------------------------------------
  const mastX = -3.1;
  const mastZ = 1.75;
  const mastBase = platY(mastX) + 0.02;
  addRBox(b, 'metalDark', 0.42, 0.16, 0.42, mastX, mastBase + 0.08, mastZ, 0.03);
  addCyl(b, 'silver', 0.04, 0.062, 3.0, mastX, mastBase + 1.66, mastZ, 0, 0, 0, 8);
  for (const yy of [2.35, 2.9, 3.4]) {
    addRod(b, 'metal', [mastX - 0.02, mastBase + yy, mastZ - 0.36], [mastX - 0.02, mastBase + yy, mastZ + 0.36], 0.016, 4);
    addRBox(b, 'white', 0.14, 0.1, 0.14, mastX, mastBase + yy, mastZ + 0.38, 0.02);
    addRBox(b, 'graphite', 0.13, 0.1, 0.13, mastX, mastBase + yy, mastZ - 0.38, 0.02);
  }
  addRod(b, 'metal', [mastX, mastBase + 1.0, mastZ], [mastX - 0.8, platTop + 0.02, mastZ - 0.5], 0.02, 4);
  addRod(b, 'metal', [mastX, mastBase + 1.0, mastZ], [mastX - 0.8, platTop + 0.02, mastZ + 0.45], 0.02, 4);
  addAnemometer(b, ctx, mastX, mastBase + 3.16, mastZ, { phase: 1.2, speed: 2.4 });
  addWhip(b, mastX, mastBase + 2.9, mastZ - 0.18, 1.35, { r: 0.012, tiltZ: -0.05 });

  // --- hull side sensor probes ---------------------------------------------
  for (const side of [-1, 1]) {
    for (const u of variant === 2 ? [0.3, 0.46, 0.62, 0.76] : [0.42, 0.62]) {
      const p = hullSurfacePoint(spec, u, 0.56, side);
      const out = [p.x, p.y, p.z + side * 0.3];
      addRod(b, 'metal', [p.x, p.y, p.z - side * 0.05], out, 0.028, 5);
      b.add(rbox(0.1, 0.08, 0.12, 0.02, 1), 'graphite', { pos: out });
    }
  }

  // --- lighting & rails -----------------------------------------------------
  addNavLights(b, spec, 0.95, { height: 0.66, inset: 0.9 });
  addBeacon(b, ctx, 3.85, roofY, -0.55, { key: 'glowCyan', phase: 1.4, rate: 0.9 });
  addDeckLight(b, 0.25, deckY(spec, 0.25) + 0.12, 1.55, 'glowWarm', 0.03);
  addDeckLight(b, 0.25, deckY(spec, 0.25) + 0.12, -1.55, 'glowWarm', 0.03);
  addDeckLight(b, -6.5, platTop + 0.02, 1.6, 'glowCyan', 0.028);
  addRailRun(b, 'metal', hullRailPoints(spec, 0.68, 0.94, 7, 1, 0.24), 0.72);
  addRailRun(b, 'metal', hullRailPoints(spec, 0.68, 0.94, 7, -1, 0.24), 0.72);
  addRailRun(b, 'metal', hullRailPoints(spec, 0.34, 0.55, 5, 1, 0.24), 0.72);
  addRailRun(b, 'metal', hullRailPoints(spec, 0.34, 0.55, 5, -1, 0.24), 0.72);
  addFenders(b, spec, [0.12, 0.25, 0.38, 0.51, 0.64].map((u) => u + ctx.rng.range(-0.01, 0.01)), { v: 0.72, length: 0.52, depth: 0.2 });

  // bow fitting
  addHatch(b, 6.2, deckY(spec, 6.2) + 0.02, { w: 1.0, d: 0.8 });
  addCleat(b, 7.2, deckY(spec, 7.2), 0.5);
  addCleat(b, 7.2, deckY(spec, 7.2), -0.5);
  addCleat(b, -7.9, deckY(spec, -7.9), 0.8);
  addCleat(b, -7.9, deckY(spec, -7.9), -0.8);
}

// =============================================================================
// 3. SURVEY 閳?18 m symmetric catamaran
//    two slender hulls, central moon-pool with suspended sonar pod, raked survey
//    cabin, radar + twin GNSS domes, survey light strip, aft A-frame gantry.
// =============================================================================
function buildSurvey(b, spec, variant, ctx) {
  const totalBeam = BOAT_CLASS.survey.beam;
  const zc = totalBeam * 0.5 - spec.beam * 0.5;
  const accent = ctx.accent;

  // --- twin slender hulls ---------------------------------------------------
  for (const side of [-1, 1]) {
    const zoff = side * zc;
    const hp = hullParts(spec);
    b.solid(hp.lower, 'hullBottom', { pos: [0, 0, zoff] });
    b.solid(hp.topsides, 'pearl', { pos: [0, 0, zoff] });
    b.add(hp.deck, 'deckGray', { pos: [0, 0, zoff] });
    b.add(hp.transom, 'navy', { pos: [0, 0, zoff] });
    b.add(waterlineBand(spec), 'navy', { pos: [0, 0, zoff] });
    b.add(hullBand(spec, 0.885, 0.925, 0.024), 'graphite', { pos: [0, 0, zoff] });
    b.add(hullBand(spec, 0.935, 0.956, 0.036), accent, { pos: [0, 0, zoff] });
    b.add(deckEdgeCap(spec, 0.16, 0.028, 0.035, 0.965), 'darkSteel', { pos: [0, 0, zoff] });
    addFenders(b, spec, [0.12, 0.26, 0.4, 0.54, 0.68].map((u) => u + ctx.rng.range(-0.01, 0.01)), { v: 0.72, length: 0.48, depth: 0.18, zOffset: zoff });
    // bow rails on each hull
    for (const hullSide of [-1, 1]) {
      const pts = hullRailPoints(spec, 0.72, 0.94, 5, hullSide, 0.16).map((p) => [p[0], p[1], p[2] + zoff]);
      addRailRun(b, 'metal', pts, 0.62, { midRail: false });
    }
  }

  // --- cross decks ----------------------------------------------------------
  const fwd = addDeckPlate(b, spec, 'deckGray', 0.6, 6.8, 6.6, 0.3, 0.35, 0.08);
  addDeckPlate(b, spec, 'deckGray', -8.8, -3.8, 6.4, 0.3, 0.35, 0.08);
  const deckTopAt = (x) => deckY(spec, x) + 0.3;
  // cross beams under the deck / across the moon pool ends
  for (const x of [-3.9, 0.7]) {
    b.add(rbox(0.5, 0.42, 6.4, 0.08, 2), 'navyLight', { pos: [x, deckY(spec, x) - 0.12, 0] });
  }
  // inner coaming rails along the working channel
  for (const side of [-1, 1]) {
    const pts = [];
    for (let i = 0; i <= 4; i++) {
      const x = lerp(-3.7, 0.5, i / 4);
      pts.push([x, deckY(spec, x), side * (zc - 0.9)]);
    }
    addRailRun(b, 'metal', pts, 0.92, { midRail: true });
  }

  // --- moon-pool gantry and suspended sonar pod ----------------------------
  const gantryTop = deckTopAt(-1.6) + 1.5;
  const gx = [-3.95, 0.75];
  const gz = 1.6;
  for (const x of gx) {
    for (const side of [-1, 1]) {
      addRod(b, 'metal', [x, deckTopAt(x), side * gz], [x, gantryTop, side * gz], 0.045, 5);
      addRod(b, 'metal', [x, deckTopAt(x), side * gz], [x, deckTopAt(x) + 0.5, side * (gz - 0.4)], 0.03, 4);
    }
    addRod(b, 'metal', [x, gantryTop, -gz], [x, gantryTop, gz], 0.04, 5);
  }
  for (const side of [-1, 1]) {
    addRod(b, 'metal', [gx[0], gantryTop, side * gz], [gx[1], gantryTop, side * gz], 0.04, 5);
  }
  // sonar pod
  const podY = 0.52;
  addCyl(b, 'silver', 0.28, 0.28, 1.7, -1.6, podY, 0, 0, 0, HALF_PI, 12);
  addCyl(b, 'metal', 0.05, 0.28, 0.5, -0.5, podY, 0, 0, 0, -HALF_PI, 12);
  addCyl(b, 'metal', 0.12, 0.28, 0.5, -2.7, podY, 0, 0, 0, HALF_PI, 12);
  addCyl(b, 'techCyan', 0.285, 0.285, 0.1, -1.05, podY, 0, 0, 0, HALF_PI, 12);
  addCyl(b, 'graphite', 0.285, 0.285, 0.08, -2.2, podY, 0, 0, 0, HALF_PI, 12);
  for (const side of [-1, 1]) {
    addBox(b, 'metalDark', 0.5, 0.3, 0.04, -1.9, podY, side * 0.16);
  }
  b.add(dome(0.19, 10, 6), 'glass', { pos: [-1.6, podY - 0.3, 0], rot: [PI, 0, 0] });
  // suspension cables
  for (const cx of [-2.75, -0.5]) {
    for (const side of [-1, 1]) {
      addRod(b, 'metalDark', [cx, gantryTop, side * gz], [cx + 0.1, podY + 0.24, side * 0.3], 0.012, 4);
    }
  }
  // pod mount collar
  addBox(b, 'metal', 0.5, 0.1, 0.8, -1.6, podY + 0.29, 0);
  // moon-pool tool stowage + wet hatch
  addRBox(b, 'metalDark', 0.7, 0.28, 0.7, 0.15, deckTopAt(0.15) + 0.14, -2.2, 0.03);
  addRBox(b, 'graphite', 0.55, 0.2, 0.5, -3.3, deckTopAt(-3.3) + 0.1, 2.3, 0.03);

  // --- raked survey cabin ---------------------------------------------------
  const cabin = addCabin(b, spec, {
    x0: 2.0,
    x1: 6.0,
    width: 4.2,
    height: 1.75,
    body: 'white',
    roof: 'ivory',
    accent: true,
    accentKey: accent,
    winH: 0.4,
    baseOffset: 0.3,
    sink: 0.06,
  });
  const roofY = cabin.yTop + 0.1;
  // raked forward wheelhouse fairing (faceted survey bridge front)
  b.add(rbox(1.3, 0.07, 2.96, 0.03, 1), 'ivory', {
    pos: [6.12, cabin.yTop - 0.72, 0],
    rot: [0, 0, -0.6],
  });
  b.add(rbox(1.16, 0.05, 2.62, 0.02, 1), 'glass', {
    pos: [6.17, cabin.yTop - 0.66, 0],
    rot: [0, 0, -0.6],
  });
  for (const side of [-1, 1]) {
    addRod(b, 'metal', [5.62, cabin.yTop - 0.42, side * 1.44], [6.62, cabin.yTop - 1.02, side * 1.44], 0.022, 4);
  }
  // radar mast + radar
  addCyl(b, 'graphite', 0.06, 0.08, 0.9, 4.9, roofY + 0.45, 0, 0, 0, 0, 8);
  addRadar(b, ctx, 4.9, roofY + 0.9, 0, { size: 0.9, phase: 2.1, speed: 1.2 });
  // twin GNSS domes
  for (const side of [-1, 1]) {
    addCyl(b, 'white', 0.16, 0.19, 0.08, 3.0, roofY + 0.04, side * 1.15, 0, 0, 0, 10);
    b.add(dome(0.19, 12, 6, 0.8), 'pearl', { pos: [3.0, roofY + 0.07, side * 1.15] });
    addWhip(b, 5.4, roofY, side * 1.35, 1.5, { r: 0.013, tiltZ: side * 0.04 });
  }
  addVent(b, 2.6, roofY, 0.9, { w: 0.4, h: 0.18, d: 0.28 });
  addVent(b, 2.6, roofY, -0.9, { w: 0.4, h: 0.18, d: 0.28 });
  // survey light strip along the cross decks
  for (const side of [-1, 1]) {
    for (const [x0, x1] of [
      [0.8, 6.6],
      [-8.6, -4.0],
    ]) {
      addBox(b, 'techCyan', x1 - x0, 0.05, 0.06, (x0 + x1) * 0.5, deckTopAt((x0 + x1) * 0.5) + 0.02, side * 3.22);
    }
  }
  addDeckLight(b, 0.9, deckTopAt(0.9) + 0.05, 2.2, 'glowCyan', 0.03);
  addDeckLight(b, -4.2, deckTopAt(-4.2) + 0.05, -2.2, 'glowCyan', 0.03);

  // --- aft A-frame gantry and towed sensor ---------------------------------
  const aftTop = deckTopAt(-8.0);
  const apex = [-8.35, 4.65, 0];
  for (const side of [-1, 1]) {
    addRod(b, 'metal', [-7.55, aftTop, side * 2.35], apex, 0.07, 6);
    addRod(b, 'metal', [-7.9, aftTop + 1.0, side * 2.35], [-8.35, aftTop + 1.6, side * 0.6], 0.03, 4);
  }
  addRod(b, 'metal', [-8.35, 3.35, -1.55], [-8.35, 3.35, 1.55], 0.045, 5);
  addCyl(b, 'metalDark', 0.13, 0.13, 0.16, -8.35, 3.75, 0, HALF_PI, 0, 0, 8);
  addCyl(b, 'graphite', 0.13, 0.13, 0.16, -8.35, 4.35, 0, HALF_PI, 0, 0, 8);
  // winch drum + fairlead on the aft deck
  addCyl(b, 'metal', 0.3, 0.3, 0.8, -6.5, aftTop + 0.35, 0, HALF_PI, 0, 0, 12);
  for (const p of [-0.45, 0.45]) {
    addRBox(b, 'metalDark', 0.12, 0.4, 0.3, -6.5, aftTop + 0.2, p, 0.02);
  }
  addRBox(b, 'deckDark', 0.7, 0.08, 1.1, -7.5, aftTop + 0.05, 0, 0.02);
  // tow cable + towed sensor fish
  addRod(b, 'metalDark', [-8.35, 4.28, 0], [-9.35, 0.52, 0], 0.014, 4);
  addRod(b, 'metalDark', [-9.05, 1.55, 0.1], [-9.35, 0.52, 0], 0.01, 4);
  addCyl(b, 'graphite', 0.16, 0.16, 0.72, -9.35, 0.48, 0, 0, 0, HALF_PI, 10);
  addCyl(b, 'silver', 0.05, 0.16, 0.22, -9.0, 0.48, 0, 0, 0, -HALF_PI, 10);
  for (const side of [-1, 1]) {
    addBox(b, 'metalDark', 0.34, 0.22, 0.03, -9.5, 0.48, side * 0.08, 0, 0, 0);
  }
  addCyl(b, 'graphite', 0.03, 0.03, 0.3, -9.35, 0.78, 0, 0, 0, 0, 6);
  // float marker on the tow line
  b.add(sphere(0.11, 8, 6), 'safetyOrange', { pos: [-8.9, 2.1, 0.05] });

  if (variant === 1) {
    // towed hydrophone array canister + extra deck locker
    addCyl(b, 'safetyOrange', 0.16, 0.16, 1.0, -7.2, aftTop + 0.24, 2.2, 0, 0, HALF_PI, 10);
    addRBox(b, 'metal', 0.8, 0.5, 0.6, -4.6, deckTopAt(-4.6) + 0.25, -2.3, 0.04);
    addWhip(b, -4.6, deckTopAt(-4.6) + 0.5, -2.3, 1.3, { r: 0.012 });
  }

  // --- lighting, rails, details --------------------------------------------
  for (const side of [-1, 1]) {
    // nav lights on cross-deck edge brackets
    addRod(b, 'metal', [2.2, deckTopAt(2.2), side * 3.2], [2.2, deckTopAt(2.2) + 0.9, side * 3.24], 0.018, 4);
    b.add(rbox(0.07, 0.08, 0.07, 0.02, 1), 'darkSteel', { pos: [2.2, deckTopAt(2.2) + 0.96, side * 3.24] });
    b.add(sphere(0.04, 8, 6), side < 0 ? 'glowRed' : 'glowGreen', {
      pos: [2.2, deckTopAt(2.2) + 0.99, side * 3.24],
    });
    // fwd / aft perimeter rails
    const fwdPts = [];
    for (let i = 0; i <= 5; i++) fwdPts.push([lerp(1.2, 6.2, i / 5), deckTopAt(lerp(1.2, 6.2, i / 5)), side * 3.25]);
    addRailRun(b, 'metal', fwdPts, 0.85, { midRail: true });
    const aftPts = [];
    for (let i = 0; i <= 5; i++) {
      const x = lerp(-8.6, -4.2, i / 5);
      aftPts.push([x, deckTopAt(x), side * 3.05]);
    }
    addRailRun(b, 'metal', aftPts, 0.85, { midRail: true });
  }
  // bow cross rail of the forward deck
  const bowRail = [];
  for (let i = 0; i <= 6; i++) bowRail.push([0.9, deckTopAt(0.9), lerp(-3.2, 3.2, i / 6)]);
  addRailRun(b, 'metal', bowRail, 0.85, { midRail: true });
  addBeacon(b, ctx, 5.75, roofY, 1.55, { key: 'glowCyan', phase: 0.6, rate: 0.85 });
  addHatch(b, 6.35, deckTopAt(6.35) + 0.02, { w: 0.8, d: 0.7 });
  addHatch(b, -6.2, deckTopAt(-6.2) + 0.02, { w: 1.0, d: 0.9 });
  addCleat(b, 7.1, deckTopAt(7.1), 1.3);
  addCleat(b, 7.1, deckTopAt(7.1), -1.3);
  addCleat(b, -8.4, deckTopAt(-8.4), 1.3);
  addCleat(b, -8.4, deckTopAt(-8.4), -1.3);
}

// =============================================================================
// 4. PATROL 閳?14.5 m multi-role patrol USV
//    medium monohull, low modular mission container aft, forward bridge-like
//    sensor pod, radar + gimbal + twin antennas.
// =============================================================================
function buildPatrol(b, spec, variant, ctx) {
  const accent = ctx.accent;
  addHullBase(b, spec, {
    hull: 'pearl',
    bottom: 'hullBottom',
    deck: 'deckGray',
    transom: 'navy',
    boot: 'navy',
    rub: 'graphite',
    accent,
    cap: 'darkSteel',
    capWidth: 0.22,
  });

  // --- aft modular mission container ---------------------------------------
  const boxX = -3.9;
  const boxLen = 3.4;
  const boxW = 2.5;
  const boxH = 2.0;
  const bodyKey = variant === 1 ? 'silver' : 'white';
  const baseY = deckY(spec, boxX) - 0.1;
  b.solid(rbox(boxLen, boxH, boxW, 0.1, 3), bodyKey, { pos: [boxX, baseY + boxH * 0.5, 0] });
  // ISO style corner posts + top/bottom rails
  for (const x of [boxX - boxLen * 0.5 + 0.1, boxX + boxLen * 0.5 - 0.1]) {
    for (const z of [-boxW * 0.5 + 0.07, boxW * 0.5 - 0.07]) {
      addBox(b, 'metalDark', 0.14, boxH, 0.14, x, baseY + boxH * 0.5, z);
    }
  }
  for (const side of [-1, 1]) {
    addBox(b, 'metalDark', boxLen, 0.12, 0.1, boxX, baseY + boxH - 0.06, side * (boxW * 0.5));
    addBox(b, 'metalDark', boxLen, 0.12, 0.1, boxX, baseY + 0.06, side * (boxW * 0.5));
    for (let i = 0; i < 4; i++) {
      addBox(b, 'silver', 0.04, boxH * 0.86, 0.03, boxX - boxLen * 0.33 + i * 0.72, baseY + boxH * 0.5, side * (boxW * 0.5 + 0.005));
    }
    addRBox(b, 'graphite', 0.5, 0.26, 0.08, boxX + 0.9, baseY + 1.3, side * (boxW * 0.5 + 0.03), 0.02);
    addBox(b, accent, boxLen * 0.7, 0.06, 0.04, boxX - 0.2, baseY + 0.34, side * (boxW * 0.5 + 0.01));
  }
  addBox(b, 'deckDark', boxLen * 0.96, 0.05, boxW * 0.98, boxX, baseY + boxH + 0.005, 0);
  // roof tie-down rails and a comms tray
  for (const side of [-1, 1]) {
    addBox(b, 'silver', boxLen * 0.9, 0.05, 0.07, boxX, baseY + boxH + 0.06, side * 0.85);
  }
  if (variant === 1) {
    addRBox(b, 'graphite', 1.0, 0.32, 1.2, boxX + 0.8, baseY + boxH + 0.2, 0, 0.04);
    addWhip(b, boxX + 0.4, baseY + boxH + 0.35, -0.35, 1.8, { r: 0.013 });
  } else {
    addRBox(b, 'white', 0.6, 0.3, 0.5, boxX - 0.9, baseY + boxH + 0.18, 0.5, 0.03);
  }
  // rear access door + steps
  addBox(b, 'graphite', 0.06, 1.2, 0.8, boxX - boxLen * 0.5 - 0.02, baseY + 0.75, 0);

  // --- forward bridge-like sensor pod --------------------------------------
  const pod = addCabin(b, spec, {
    x0: 1.4,
    x1: 4.0,
    width: 2.8,
    height: 1.5,
    body: 'white',
    roof: 'ivory',
    accent: true,
    accentKey: accent,
    winH: 0.28,
    winLenFrac: 0.55,
    sink: 0.06,
  });
  const roofY = pod.yTop + 0.1;
  // radar mast
  addCyl(b, 'graphite', 0.055, 0.075, 0.75, 2.85, roofY + 0.38, 0, 0, 0, 0, 8);
  addRadar(b, ctx, 2.85, roofY + 0.76, 0, { size: 0.85, phase: 0.9, speed: 1.3 });
  // twin antennas (one tall whip, one blade)
  addWhip(b, 1.9, roofY, 0.95, 2.3, { r: 0.016, tiltZ: 0.05 });
  addWhip(b, 1.9, roofY, -0.95, 1.9, { r: 0.014, tiltZ: -0.04 });
  addBox(b, 'graphite', 0.06, 0.5, 0.16, 3.6, roofY + 0.25, 0.8, 0, 0, 0.28);
  addBox(b, 'graphite', 0.06, 0.5, 0.16, 3.6, roofY + 0.25, -0.8, 0, 0, 0.28);
  // pod roof grab rails + vent
  for (const side of [-1, 1]) {
    addRod(b, 'metal', [1.7, roofY + 0.13, side * 1.08], [3.7, roofY + 0.13, side * 1.08], 0.018, 4);
  }
  addVent(b, 2.2, roofY, 0, { w: 0.4, h: 0.2, d: 0.3 });

  // --- foredeck: gimbal, windlass, hatch, anchor ---------------------------
  const gimbalY = deckY(spec, 4.85);
  addGimbal(b, ctx, 4.85, gimbalY, 0.55, { r: 0.18, phase: 1.5, speed: 0.28 });
  addRBox(b, 'safetyOrange', 0.5, 0.22, 0.5, 5.85, deckY(spec, 5.85) + 0.11, -0.75, 0.04);
  addCyl(b, 'graphite', 0.16, 0.16, 0.4, 6.5, deckY(spec, 6.5) + 0.32, 0.42, HALF_PI, 0, 0, 10);
  addCyl(b, 'graphite', 0.16, 0.16, 0.4, 6.5, deckY(spec, 6.5) + 0.32, -0.42, HALF_PI, 0, 0, 10);
  addRBox(b, 'metalDark', 0.6, 0.28, 0.5, 6.6, deckY(spec, 6.6) + 0.14, 0, 0.04);
  addHatch(b, 5.3, deckY(spec, 5.3) + 0.02, { w: 0.95, d: 0.75 });
  addCleat(b, 6.1, deckY(spec, 6.1), 0.35);
  addCleat(b, 6.1, deckY(spec, 6.1), -0.35);
  addCleat(b, -6.9, deckY(spec, -6.9), 0.9);
  addCleat(b, -6.9, deckY(spec, -6.9), -0.9);

  // --- aft deck equipment ---------------------------------------------------
  for (const side of [-1, 1]) {
    addRBox(b, 'ivory', 0.85, 0.55, 0.6, -6.5, deckY(spec, -6.5) + 0.28, side * 1.55, 0.05);
    addVent(b, -6.5, deckY(spec, -6.5) + 0.56, side * 1.55, { w: 0.3, h: 0.14, d: 0.4 });
  }
  addRBox(b, 'white', 0.9, 0.4, 0.5, -5.6, deckY(spec, -5.6) + 0.2, 0, 0.05);
  // stern towing bollard
  addCyl(b, 'metal', 0.11, 0.13, 0.28, -6.95, deckY(spec, -6.95) + 0.14, 0, 0, 0, 0, 8);

  // --- lights & rails -------------------------------------------------------
  addNavLights(b, spec, 1.05, { height: 0.72, inset: 0.92 });
  addBeacon(b, ctx, 3.85, roofY, 0.95, { key: 'glowRed', phase: 2.2, rate: 0.7 });
  addDeckLight(b, 0.9, deckY(spec, 0.9) + 0.12, 1.7, 'glowWarm', 0.03);
  addDeckLight(b, 0.9, deckY(spec, 0.9) + 0.12, -1.7, 'glowWarm', 0.03);
  addDeckLight(b, -6.25, deckY(spec, -6.25) + 0.06, 0, 'glowCyan', 0.028);
  addRailRun(b, 'metal', hullRailPoints(spec, 0.68, 0.94, 6, 1, 0.22), 0.68);
  addRailRun(b, 'metal', hullRailPoints(spec, 0.68, 0.94, 6, -1, 0.22), 0.68);
  addRailRun(b, 'metal', hullRailPoints(spec, 0.1, 0.3, 5, 1, 0.22), 0.74);
  addRailRun(b, 'metal', hullRailPoints(spec, 0.1, 0.3, 5, -1, 0.22), 0.74);
  addFenders(b, spec, [0.1, 0.24, 0.38, 0.52, 0.66].map((u) => u + ctx.rng.range(-0.01, 0.01)), { v: 0.72, length: 0.5, depth: 0.19 });
}

// =============================================================================
// 5. COMMS 閳?19 m communications relay USV
//    wide stable hull, large flat deck, tall lattice mast with microwave drums,
//    two dishes, satcom dome, many antennas, cable trays.
// =============================================================================
function buildComms(b, spec, variant, ctx) {
  const accent = ctx.accent;
  addHullBase(b, spec, {
    hull: 'pearl',
    bottom: 'hullBottom',
    deck: 'deckGray',
    transom: 'navy',
    boot: 'navy',
    rub: 'graphite',
    accent,
    cap: 'darkSteel',
    capWidth: 0.26,
  });

  // --- forward bridge / equipment cabin ------------------------------------
  const fwdCabin = addCabin(b, spec, {
    x0: 1.4,
    x1: 5.6,
    width: 3.6,
    height: 1.9,
    body: 'white',
    roof: 'ivory',
    accent: true,
    accentKey: accent,
    winH: 0.38,
  });
  const fwdRoof = fwdCabin.yTop + 0.1;
  // radar + sensor fit on the forward cabin
  addCyl(b, 'graphite', 0.06, 0.08, 0.85, 4.85, fwdRoof + 0.42, 0, 0, 0, 0, 8);
  addRadar(b, ctx, 4.85, fwdRoof + 0.85, 0, { size: 0.95, phase: 1.1, speed: 1.2 });
  addWhip(b, 2.1, fwdRoof, 1.3, 2.0, { r: 0.013 });
  addWhip(b, 2.1, fwdRoof, -1.3, 1.7, { r: 0.012 });
  addVent(b, 3.1, fwdRoof, 0.85, { w: 0.45, h: 0.22, d: 0.3 });
  addVent(b, 3.1, fwdRoof, -0.85, { w: 0.45, h: 0.22, d: 0.3 });

  // --- aft equipment cabin -------------------------------------------------
  const aftCabin = addCabin(b, spec, {
    x0: -7.6,
    x1: -3.4,
    width: 3.4,
    height: 1.5,
    body: 'ivory',
    roof: 'white',
    accent: true,
    accentKey: accent,
    winH: 0.26,
    winLenFrac: 0.45,
  });
  const aftRoof = aftCabin.yTop + 0.1;
  addVent(b, -5.2, aftRoof, 1.1, { w: 0.4, h: 0.2, d: 0.28 });
  addRBox(b, 'graphite', 0.7, 0.32, 0.5, -4.2, aftRoof + 0.18, -1.1, 0.04);
  for (const side of [-1, 1]) {
    addWhip(b, -5.0, aftRoof, side * 1.5, 1.6, { r: 0.012 });
  }

  // --- cable trays: forward cabin -> mast -> aft cabin ----------------------
  for (const side of [-1, 1]) {
    for (const [x0, x1, y] of [
      [1.35, -0.35, deckY(spec, 0.5) + 0.12],
      [-1.25, -3.45, deckY(spec, -2.3) + 0.12],
    ]) {
      const xc = (x0 + x1) * 0.5;
      const slope = deckSlope(spec, xc);
      b.add(rbox(Math.abs(x1 - x0), 0.12, 0.24, 0.02, 1), 'deckDark', {
        pos: [xc, y, side * 1.0],
        rot: [0, 0, slope],
      });
      for (let i = 0; i < 4; i++) {
        const px = x0 + ((x1 - x0) * (i + 0.5)) / 4;
        b.add(box(0.06, 0.18, 0.3), 'metal', { pos: [px, y - 0.06, side * 1.0], rot: [0, 0, slope] });
      }
    }
  }
  // deck cable ducts rising into the mast base
  for (const side of [-1, 1]) {
    b.add(rbox(0.3, 1.1, 0.3, 0.03, 1), 'graphite', { pos: [-0.8, deckY(spec, -0.8) + 0.55, side * 0.85] });
  }

  // --- comms mast ----------------------------------------------------------
  const mastX = -0.8;
  const plinthY = deckY(spec, mastX);
  b.add(rbox(1.55, 0.5, 1.9, 0.08, 2), 'darkSteel', { pos: [mastX, plinthY + 0.19, 0] });
  b.add(rbox(1.7, 0.08, 2.05, 0.03, 1), 'graphite', { pos: [mastX, plinthY + 0.47, 0] });
  const baseY = plinthY + 0.44;
  const H = 11;
  const hs = [0, 0.2, 0.4, 0.6, 0.8, 1.0];
  const hx = (h) => lerp(0.62, 0.17, h);
  const hz = (h) => lerp(0.5, 0.14, h);
  // legs
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      addRod(b, 'silver', [mastX + sx * hx(0), baseY, sz * hz(0)], [mastX + sx * hx(1), baseY + H, sz * hz(1)], 0.055, 6);
    }
  }
  // frames + lattice bracing
  for (let i = 0; i < hs.length; i++) {
    const y = baseY + H * hs[i];
    const a = hx(hs[i]);
    const c = hz(hs[i]);
    addRod(b, 'metal', [mastX - a, y, -c], [mastX + a, y, -c], 0.026, 4);
    addRod(b, 'metal', [mastX - a, y, c], [mastX + a, y, c], 0.026, 4);
    addRod(b, 'metal', [mastX - a, y, -c], [mastX - a, y, c], 0.026, 4);
    addRod(b, 'metal', [mastX + a, y, -c], [mastX + a, y, c], 0.026, 4);
    if (i < hs.length - 1) {
      const y2 = baseY + H * hs[i + 1];
      const a2 = hx(hs[i + 1]);
      addRod(b, 'metal', [mastX - a, y, c], [mastX + a2, y2, c], 0.02, 4);
      addRod(b, 'metal', [mastX + a, y, -c], [mastX - a2, y2, -c], 0.02, 4);
      addRod(b, 'metal', [mastX - a, y, -c], [mastX + a2, y2, c], 0.018, 4);
    }
  }
  // central cable duct
  addCyl(b, 'graphite', 0.11, 0.15, H, mastX, baseY + H * 0.5, 0, 0, 0, 0, 8);

  // top platform + satcom dome
  const topY = baseY + H;
  b.add(rbox(1.25, 0.12, 1.15, 0.04, 1), 'metalDark', { pos: [mastX, topY + 0.06, 0] });
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * PI * 2 + PI * 0.25;
    addRod(b, 'metal', [mastX + Math.cos(a) * 0.5, topY + 0.12, Math.sin(a) * 0.5], [mastX + Math.cos(a) * 0.5, topY + 0.75, Math.sin(a) * 0.5], 0.016, 4);
  }
  addRod(b, 'metal', [mastX - 0.5, topY + 0.72, 0], [mastX + 0.5, topY + 0.72, 0], 0.02, 4);
  addRod(b, 'metal', [mastX, topY + 0.72, -0.5], [mastX, topY + 0.72, 0.5], 0.02, 4);
  addCyl(b, 'white', 0.4, 0.44, 0.16, mastX, topY + 0.2, 0, 0, 0, 0, 14);
  b.add(dome(0.42, 16, 9, 0.8), 'pearl', { pos: [mastX, topY + 0.27, 0] });
  addWhip(b, mastX + 0.32, topY + 0.15, 0.46, 2.3, { r: 0.012, tiltZ: -0.03 });
  // aircraft warning light at the mast top
  b.add(sphere(0.05, 7, 5), 'glowRed', { pos: [mastX, topY + 0.78, 0] });

  // --- microwave drum antennas on outrigger arms ---------------------------
  const drumMounts = [
    { h: 0.3, yaw: 0, dir: 'fwd', r: 0.21, len: 0.52 },
    { h: 0.5, dir: 'port', r: 0.19, len: 0.46 },
    { h: 0.68, dir: 'stbd', r: 0.17, len: 0.42 },
  ];
  if (variant > 0) drumMounts.push({ h: 0.85, dir: 'aft', r: 0.2, len: 0.5 });
  for (const mount of drumMounts) {
    const y = baseY + H * mount.h;
    const a = hx(mount.h);
    const c = hz(mount.h);
    let armEnd;
    let rot;
    if (mount.dir === 'fwd') {
      armEnd = [mastX + a + 1.0, y, 0];
      rot = [0, 0, -HALF_PI];
    } else if (mount.dir === 'aft') {
      armEnd = [mastX - a - 1.0, y, 0];
      rot = [0, 0, HALF_PI];
    } else if (mount.dir === 'port') {
      armEnd = [mastX, y, -c - 0.95];
      rot = [-HALF_PI, 0, 0];
    } else {
      armEnd = [mastX, y, c + 0.95];
      rot = [HALF_PI, 0, 0];
    }
    addRod(b, 'metal', [mastX + (mount.dir === 'fwd' ? a : mount.dir === 'aft' ? -a : 0), y, mount.dir === 'stbd' ? c : mount.dir === 'port' ? -c : 0], armEnd, 0.035, 5);
    addRod(b, 'metal', [mastX, y - 0.55, 0], [armEnd[0] * 0.86 + mastX * 0.14, armEnd[1] - 0.12, armEnd[2] * 0.86], 0.022, 4);
    addDrumAntenna(b, armEnd, rot, { r: mount.r, len: mount.len });
  }

  // --- two dishes ----------------------------------------------------------
  const dishMounts = [
    { y: baseY + 6.0, base: [mastX, baseY + 6.0, 0.7], rot: [0.62, 0, -0.34], r: 0.42 },
    { y: baseY + 8.5, base: [mastX, baseY + 8.5, -0.58], rot: [-0.62, 0, 0.3], r: 0.36 },
  ];
  for (const dish of dishMounts) {
    addRod(b, 'metal', [mastX, dish.y - 0.4, 0], dish.base, 0.04, 5);
    addCyl(b, 'metalDark', 0.06, 0.06, 0.16, dish.base[0], dish.base[1], dish.base[2], HALF_PI, 0, 0, 6);
    addDish(b, dish.base, dish.rot, dish.r);
  }

  // --- deck equipment around the mast base ---------------------------------
  addRBox(b, 'graphite', 0.85, 0.9, 0.65, -2.5, deckY(spec, -2.5) + 0.45, 1.75, 0.05);
  addRBox(b, 'ivory', 0.7, 0.7, 0.55, -2.4, deckY(spec, -2.4) + 0.35, -1.8, 0.04);
  addRBox(b, 'white', 0.6, 0.5, 0.5, 0.9, deckY(spec, 0.9) + 0.25, 2.0, 0.04);

  // --- foredeck: gimbal, hatches, windlass --------------------------------
  addGimbal(b, ctx, 6.5, deckY(spec, 6.5), 0, { r: 0.19, phase: 2.6, speed: 0.26 });
  addHatch(b, 7.4, deckY(spec, 7.4) + 0.02, { w: 1.0, d: 0.8 });
  addCyl(b, 'graphite', 0.17, 0.17, 0.42, 8.3, deckY(spec, 8.3) + 0.33, 0.4, 0, 0, HALF_PI, 10);
  addRBox(b, 'metalDark', 0.7, 0.3, 0.55, 8.2, deckY(spec, 8.2) + 0.15, -0.5, 0.04);
  addCleat(b, 8.8, deckY(spec, 8.8), 0.4);
  addCleat(b, 8.8, deckY(spec, 8.8), -0.4);

  // --- lights & rails ------------------------------------------------------
  addNavLights(b, spec, 2.2, { height: 0.82, inset: 0.93 });
  addBeacon(b, ctx, -4.1, aftRoof, 0.85, { key: 'glowRed', phase: 0.5, rate: 0.62 });
  addDeckLight(b, 0.6, deckY(spec, 0.6) + 0.14, 1.55, 'glowWarm', 0.032);
  addDeckLight(b, 0.6, deckY(spec, 0.6) + 0.14, -1.55, 'glowWarm', 0.032);
  addDeckLight(b, -2.9, deckY(spec, -2.9) + 0.08, 2.4, 'glowCyan', 0.028);
  addRailRun(b, 'metal', hullRailPoints(spec, 0.7, 0.94, 7, 1, 0.26), 0.82);
  addRailRun(b, 'metal', hullRailPoints(spec, 0.7, 0.94, 7, -1, 0.26), 0.82);
  addRailRun(b, 'metal', hullRailPoints(spec, 0.06, 0.2, 5, 1, 0.26), 0.82);
  addRailRun(b, 'metal', hullRailPoints(spec, 0.06, 0.2, 5, -1, 0.26), 0.82);
  addRailRun(b, 'metal', hullRailPoints(spec, 0.36, 0.47, 4, 1, 0.26), 0.82);
  addRailRun(b, 'metal', hullRailPoints(spec, 0.36, 0.47, 4, -1, 0.26), 0.82);
  addFenders(b, spec, [0.1, 0.23, 0.36, 0.5, 0.64, 0.78].map((u) => u + ctx.rng.range(-0.01, 0.01)), { v: 0.72, length: 0.56, depth: 0.21 });
}

// =============================================================================
// 6. ENERGY 閳?20 m energy support USV
//    broad stable hull, modular battery cabinets, solar arrays on the cabin
//    roofs, deck crane, charging cable reels, maintenance platform.
// =============================================================================
function buildEnergy(b, spec, variant, ctx) {
  const accent = ctx.accent;
  addHullBase(b, spec, {
    hull: 'pearl',
    bottom: 'hullBottom',
    deck: 'deckGray',
    transom: 'navy',
    boot: 'navy',
    rub: 'graphite',
    accent,
    cap: 'darkSteel',
    capWidth: 0.3,
  });

  // --- forward control / converter cabin -----------------------------------
  const fwdCabin = addCabin(b, spec, {
    x0: 2.0,
    x1: 5.6,
    width: 4.0,
    height: 2.0,
    body: 'white',
    roof: 'ivory',
    accent: true,
    accentKey: accent,
    winH: 0.34,
  });
  const fwdRoof = fwdCabin.yTop + 0.1;
  // solar array frame + 2x2 panels on the control cabin
  for (const side of [-1, 1]) {
    addBox(b, 'silver', 3.3, 0.07, 0.08, 3.8, fwdRoof + 0.05, side * 1.75);
  }
  for (const x of [2.3, 5.3]) {
    addBox(b, 'silver', 0.08, 0.07, 3.5, x, fwdRoof + 0.05, 0);
  }
  addSolarArray(b, 3.8, fwdRoof + 0.11, 0, 2, 2, 1.5, 1.7, 0.16, [0.2, 0, -0.22]);
  addVent(b, 2.2, fwdRoof + 0.08, 0, { w: 0.4, h: 0.18, d: 0.32 });

  // --- aft converter cabin + solar ----------------------------------------
  const aftCabin = addCabin(b, spec, {
    x0: -8.6,
    x1: -6.6,
    width: 3.2,
    height: 1.5,
    body: 'ivory',
    roof: 'white',
    accent: true,
    accentKey: accent,
    winH: 0.24,
    winLenFrac: 0.4,
  });
  const aftRoof = aftCabin.yTop + 0.1;
  for (const side of [-1, 1]) {
    addBox(b, 'silver', 1.75, 0.06, 0.07, -7.6, aftRoof + 0.04, side * 1.4);
  }
  addSolarArray(b, -7.6, aftRoof + 0.1, 0, 2, 2, 0.8, 1.35, 0.14, [0.2, 0, -0.22]);
  // vent stacks
  for (const side of [-1, 1]) {
    addCyl(b, 'white', 0.13, 0.16, 0.9, -8.15, aftRoof + 0.45, side * 0.85, 0, 0, 0, 10);
    addCyl(b, 'metalDark', 0.17, 0.13, 0.1, -8.15, aftRoof + 0.93, side * 0.85, 0, 0, 0, 10);
  }

  // --- modular battery / energy storage cabinets ---------------------------
  const cabZ = 2.15;
  const cabX = [-5.4, -3.5, -1.6];
  for (const x of cabX) {
    for (const side of [-1, 1]) {
      const baseY = deckY(spec, x) - 0.06;
      b.add(rbox(1.62, 1.35, 1.0, 0.07, 2), 'white', { pos: [x, baseY + 0.675, side * cabZ] });
      b.add(rbox(1.68, 0.08, 1.06, 0.03, 1), 'silver', { pos: [x, baseY + 1.37, side * cabZ] });
      // vertical ribbing on the outboard face
      for (let i = 0; i < 3; i++) {
        addBox(b, 'silver', 0.05, 1.15, 0.035, x - 0.5 + i * 0.5, baseY + 0.7, side * (cabZ + 0.51));
      }
      // louvred vent + status strip + handle
      for (let i = 0; i < 3; i++) {
        addBox(b, 'graphite', 0.55, 0.05, 0.03, x + 0.35, baseY + 0.85 + i * 0.11, side * (cabZ + 0.52));
      }
      addBox(b, accent, 0.6, 0.05, 0.035, x + 0.35, baseY + 1.2, side * (cabZ + 0.52));
      addBox(b, 'metalDark', 0.05, 0.26, 0.06, x - 0.72, baseY + 0.75, side * (cabZ + 0.53));
      addCyl(b, 'graphite', 0.06, 0.07, 0.1, x, baseY + 1.44, side * (cabZ - 0.25), 0, 0, 0, 8);
      // tie-down feet
      for (const fx of [-0.65, 0.65]) {
        addBox(b, 'metalDark', 0.16, 0.09, 0.16, x + fx, baseY + 0.04, side * cabZ);
      }
    }
  }
  // intermediate cable busbar down the centreline of the battery rows
  b.add(rbox(5.4, 0.1, 0.18, 0.03, 1), 'graphite', { pos: [-3.5, deckY(spec, -3.5) + 0.06, 0] });

  // --- modular maintenance platform between the cabinets -------------------
  const platform = addDeckPlate(b, spec, 'deckDark', -4.8, -1.6, 2.6, 0.22, 0.14, 0.05);
  const platTop = platform.top;
  const platY = (x) => deckY(spec, x) + 0.22;
  addRectRail(b, 'metal', -4.75, -1.65, -1.28, 1.28, platY, 0.72, { postStep: 1.0 });
  for (let i = 0; i < 3; i++) {
    addBox(b, 'deckGray', 0.06, 0.02, 2.4, -4.4 + i * 1.3, platTop + 0.005, 0, 0, 0, platform.slope);
  }
  // access steps
  addRBox(b, 'metalDark', 0.24, 0.16, 1.2, -1.5, deckY(spec, -1.5) + 0.08, 0, 0.02);
  addRBox(b, 'metalDark', 0.24, 0.32, 1.2, -1.25, deckY(spec, -1.25) + 0.16, 0, 0.02);

  if (variant === 1) {
    // solar canopy over the maintenance platform
    for (const side of [-1, 1]) {
      for (const x of [-4.6, -1.9]) {
        addRod(b, 'metal', [x, platTop, side * 1.15], [x, platTop + 1.85, side * 1.15], 0.03, 4);
      }
      addRod(b, 'metal', [-4.6, platTop + 1.85, side * 1.15], [-1.9, platTop + 1.85, side * 1.15], 0.03, 4);
    }
    addSolarArray(b, -3.25, platTop + 1.9, 0, 2, 2, 1.25, 0.95, 0.12, [0.12, 0, -0.16]);
  }

  // --- deck crane (slow slew animation) ------------------------------------
  const craneX = 1.0;
  const craneZ = -2.3;
  const craneBase = deckY(spec, craneX);
  b.add(rbox(0.95, 0.18, 0.95, 0.05, 2), 'metalDark', { pos: [craneX, craneBase + 0.09, craneZ] });
  const craneGroup = ctx.dyn('crane');
  craneGroup.position.set(craneX, craneBase + 0.18, craneZ);
  craneGroup.rotation.y = PI;
  const craneParts = [
    [cyl(0.14, 0.18, 1.45, 10), [0, 0.72, 0]],
    [box(0.34, 0.2, 0.3), [0, 1.42, 0]],
    // boom: from the column top (0, 1.5) to the tip (2.15, 2.42)
    [cyl(0.075, 0.075, 2.35, 8), [1.075, 1.96, 0], [0, 0, -1.166]],
    [box(0.42, 0.26, 0.36), [-0.3, 1.36, 0]],
    [cyl(0.018, 0.018, 0.9, 5), [2.15, 1.97, 0]],
    [sphere(0.075, 7, 5), [2.15, 1.48, 0]],
    [cyl(0.06, 0.06, 0.1, 6), [2.15, 2.4, 0], [HALF_PI, 0, 0]],
  ];
  ctx.dynMesh(craneGroup, mergeParts(craneParts), 'metal');
  ctx.anim.push((time) => {
    craneGroup.rotation.y = PI + Math.sin(time * 0.12) * 0.28;
  });

  // --- charging cable reels + charging pedestals --------------------------
  for (const side of [-1, 1]) {
    const rx = -9.3;
    const rz = side * 1.25;
    const ry = deckY(spec, rx) + 0.5;
    addCyl(b, 'metalDark', 0.32, 0.32, 0.46, rx, ry, rz, HALF_PI, 0, 0, 12);
    for (const r of [0.36, 0.3, 0.24]) {
      b.add(torus(r, 0.035, 4, 14), 'rubber', { pos: [rx, ry, rz], rot: [0, 0, 0] });
    }
    for (const fx of [-0.28, 0.28]) {
      addRBox(b, 'metal', 0.12, 0.5, 0.18, rx + fx, deckY(spec, rx) + 0.25, rz, 0.02);
    }
    addRod(b, 'rubber', [rx, ry - 0.25, rz], [rx + 0.6, deckY(spec, rx) + 0.05, rz * 0.6], 0.024, 4);
    // charging pedestal
    addCyl(b, 'graphite', 0.1, 0.13, 1.0, -2.6, deckY(spec, -2.6) + 0.5, side * 2.9, 0, 0, 0, 8);
    addRBox(b, 'white', 0.26, 0.34, 0.22, -2.6, deckY(spec, -2.6) + 1.12, side * 2.9, 0.03);
    addBox(b, 'glowCyanSoft', 0.16, 0.05, 0.02, -2.6, deckY(spec, -2.6) + 1.16, side * (2.9 + 0.11));
  }

  // --- bows / deck fittings ------------------------------------------------
  addHatch(b, 6.6, deckY(spec, 6.6) + 0.02, { w: 1.05, d: 0.85 });
  addHatch(b, 8.2, deckY(spec, 8.2) + 0.02, { w: 0.8, d: 0.65 });
  addCyl(b, 'graphite', 0.18, 0.18, 0.44, 9.2, deckY(spec, 9.2) + 0.34, 0, 0, 0, HALF_PI, 10);
  addRBox(b, 'metalDark', 0.7, 0.3, 0.6, 9.1, deckY(spec, 9.1) + 0.15, 0.6, 0.04);
  addCleat(b, 9.6, deckY(spec, 9.6), 0.3);
  addCleat(b, 9.6, deckY(spec, 9.6), -0.3);
  addCleat(b, -9.7, deckY(spec, -9.7), 1.1);
  addCleat(b, -9.7, deckY(spec, -9.7), -1.1);

  // --- lights & rails ------------------------------------------------------
  addNavLights(b, spec, 1.6, { height: 0.85, inset: 0.93 });
  addBeacon(b, ctx, 4.9, fwdRoof, 1.35, { key: 'glowRed', phase: 1.9, rate: 0.7 });
  addDeckLight(b, 1.4, deckY(spec, 1.4) + 0.14, 1.9, 'glowWarm', 0.032);
  addDeckLight(b, 1.4, deckY(spec, 1.4) + 0.14, -1.9, 'glowWarm', 0.032);
  addDeckLight(b, -3.25, platTop + 0.05, 0.9, 'glowCyan', 0.03);
  addDeckLight(b, -8.9, deckY(spec, -8.9) + 0.07, 0, 'glowCyan', 0.028);
  addRailRun(b, 'metal', hullRailPoints(spec, 0.72, 0.94, 7, 1, 0.26), 0.85);
  addRailRun(b, 'metal', hullRailPoints(spec, 0.72, 0.94, 7, -1, 0.26), 0.85);
  addRailRun(b, 'metal', hullRailPoints(spec, 0.04, 0.12, 3, 1, 0.26), 0.85);
  addRailRun(b, 'metal', hullRailPoints(spec, 0.04, 0.12, 3, -1, 0.26), 0.85);
  addRailRun(b, 'metal', hullRailPoints(spec, 0.24, 0.44, 7, 1, 0.26), 0.85);
  addRailRun(b, 'metal', hullRailPoints(spec, 0.24, 0.44, 7, -1, 0.26), 0.85);
  addFenders(b, spec, [0.1, 0.23, 0.36, 0.5, 0.63, 0.76].map((u) => u + ctx.rng.range(-0.01, 0.01)), { v: 0.72, length: 0.6, depth: 0.22 });
}

// =============================================================================
// 7. RESCUE 閳?15.5 m search & rescue USV
//    orange/white livery, forward enclosed rescue console, aft open rescue
//    platform, folded articulated rescue arm, lifebuoy launcher racks.
// =============================================================================
function buildRescue(b, spec, variant, ctx) {
  const redKey = ctx.accentMat('red');
  addHullBase(b, spec, {
    hull: 'white',
    bottom: 'hullBottom',
    deck: 'deckGray',
    transom: 'navy',
    boot: 'navy',
    rub: 'graphite',
    accent: null,
    cap: 'darkSteel',
    capWidth: 0.28,
  });
  // orange rescue band + thin red stripe above it
  b.add(hullBand(spec, 0.5, 0.7, 0.03), 'safetyOrange');
  b.add(hullBand(spec, 0.735, 0.762, 0.038), redKey);

  // --- forward enclosed rescue console -------------------------------------
  const consoleBox = addCabin(b, spec, {
    x0: 0.6,
    x1: 4.6,
    width: 3.0,
    height: 1.8,
    body: 'white',
    roof: 'ivory',
    accent: true,
    accentKey: 'safetyOrange',
    winH: 0.4,
    winLenFrac: 0.58,
  });
  const roofY = consoleBox.yTop + 0.1;
  // roof livery band
  for (const side of [-1, 1]) {
    addBox(b, 'safetyOrange', 3.4, 0.09, 0.09, 2.6, roofY + 0.02, side * 1.4);
  }
  // console side livery: orange panel + red/white marking blocks
  for (const side of [-1, 1]) {
    addRBox(b, 'safetyOrange', 1.5, 0.46, 0.035, 1.6, consoleBox.y0 + 0.62, side * 1.505, 0.02);
    addBox(b, redKey, 0.9, 0.12, 0.035, 3.2, consoleBox.y0 + 1.42, side * 1.505);
    addBox(b, 'white', 0.9, 0.12, 0.035, 3.2, consoleBox.y0 + 1.28, side * 1.505);
  }
  // radar, searchlight, beacons and antennas
  addCyl(b, 'graphite', 0.05, 0.07, 0.6, 3.9, roofY + 0.3, 0, 0, 0, 0, 8);
  addRadar(b, ctx, 3.9, roofY + 0.6, 0, { size: 0.75, phase: 1.1, speed: 1.5 });
  addCyl(b, 'graphite', 0.09, 0.11, 0.28, 2.7, roofY + 0.14, 0.6, 0, 0, 0, 8);
  addCyl(b, 'darkSteel', 0.12, 0.15, 0.16, 2.7, roofY + 0.34, 0.6, 0, 0, 0, 8);
  b.add(sphere(0.11, 8, 6), 'glowWhite', { pos: [2.7, roofY + 0.36, 0.6] });
  addBeacon(b, ctx, 1.4, roofY, -0.75, { key: 'glowCyan', phase: 0.2, rate: 1.15, name: 'beacon-blue' });
  addBeacon(b, ctx, 1.4, roofY, 0.75, { key: 'glowRed', phase: 0.7, rate: 1.15, name: 'beacon-red' });
  addWhip(b, 1.2, roofY, 0.25, 1.35, { r: 0.012 });
  addWhip(b, 0.9, roofY, -1.15, 1.1, { r: 0.011, tiltZ: 0.05 });
  for (const side of [-1, 1]) {
    addRod(b, 'metal', [1.0, roofY + 0.12, side * 1.3], [4.0, roofY + 0.12, side * 1.3], 0.018, 4);
  }

  // --- aft open rescue platform -------------------------------------------
  const plat = addDeckPlate(b, spec, 'deckDark', -7.4, -2.6, 4.4, 0.06, 0.09, 0.04);
  const platTop = plat.top;
  // tie-down grid
  for (let i = 0; i < 5; i++) {
    addBox(b, 'metalDark', 0.06, 0.02, 4.2, -7.2 + i * 1.05, platTop + 0.005, 0, 0, 0, plat.slope);
  }
  // equipment cases and stretcher cradle
  addRBox(b, 'safetyOrange', 0.8, 0.55, 0.6, -5.9, platTop + 0.28, -1.55, 0.05);
  addRBox(b, 'white', 0.7, 0.5, 0.55, -6.5, platTop + 0.25, 1.35, 0.05);
  addRBox(b, 'graphite', 0.65, 0.45, 0.5, -3.4, platTop + 0.23, 1.7, 0.04);
  addRBox(b, redKey, 0.55, 0.35, 0.45, -2.95, platTop + 0.18, 1.1, 0.04);
  // stretcher cradle
  addRBox(b, 'white', 1.9, 0.12, 0.62, -4.5, platTop + 0.32, 1.5, 0.04);
  for (let i = 0; i < 4; i++) {
    addBox(b, 'safetyOrange', 0.12, 0.14, 0.68, -5.2 + i * 0.45, platTop + 0.32, 1.5);
  }
  for (const x of [-5.2, -3.8]) {
    addRod(b, 'metal', [x, platTop, 1.2], [x, platTop + 0.28, 1.5], 0.02, 4);
    addRod(b, 'metal', [x, platTop, 1.8], [x, platTop + 0.28, 1.5], 0.02, 4);
  }
  // folded articulated rescue arm (orange segments, metal joints)
  const armX = -5.2;
  const armZ = -1.85;
  addCyl(b, 'metalDark', 0.17, 0.2, 0.42, armX, platTop + 0.21, armZ, 0, 0, 0, 10);
  const pivotA = [-6.15, platTop + 1.05, armZ - 0.1];
  addRod(b, 'safetyOrange', [armX, platTop + 0.42, armZ], pivotA, 0.075, 6);
  addCyl(b, 'metal', 0.095, 0.095, 0.22, pivotA[0], pivotA[1], pivotA[2], HALF_PI, 0, 0, 8);
  const pivotB = [-5.35, platTop + 1.48, -1.68];
  addRod(b, 'safetyOrange', pivotA, pivotB, 0.06, 6);
  addCyl(b, 'metal', 0.08, 0.08, 0.18, pivotB[0], pivotB[1], pivotB[2], HALF_PI, 0, 0, 8);
  // hydraulic cylinder + folded stowage cradle
  addRod(b, 'metal', [armX - 0.28, platTop + 0.5, armZ + 0.12], [-5.9, platTop + 1.0, armZ + 0.12], 0.03, 4);
  addRBox(b, 'metalDark', 0.5, 0.16, 0.34, pivotB[0], pivotB[1] - 0.1, pivotB[2], 0.03);
  addRod(b, 'metalDark', pivotB, [pivotB[0], platTop + 0.35, pivotB[2] + 0.2], 0.014, 4);
  addCyl(b, 'metal', 0.06, 0.06, 0.12, pivotB[0], platTop + 0.33, pivotB[2] + 0.2, HALF_PI, 0, 0, 6);
  addCyl(b, 'graphite', 0.1, 0.1, 0.14, armX + 0.3, platTop + 0.14, armZ + 0.3, 0, 0, HALF_PI, 8);
  // stern davit / A-frame for recovery
  const davitTop = deckY(spec, -7.0) + 2.7;
  for (const side of [-1, 1]) {
    addRod(b, 'metal', [-7.2, platTop, side * 1.7], [-7.05, davitTop, side * 0.45], 0.05, 5);
  }
  addRod(b, 'metal', [-7.05, davitTop, -0.45], [-7.05, davitTop, 0.45], 0.04, 5);
  addCyl(b, 'metalDark', 0.11, 0.11, 0.14, -7.05, davitTop - 0.1, 0, HALF_PI, 0, 0, 8);

  // --- lifebuoy launcher racks on the console aft face --------------------
  for (const zc of [-0.72, 0.72]) {
    for (const dz of [-0.36, 0.36]) {
      addRod(b, 'metal', [0.34, deckY(spec, 0.34), zc + dz], [0.34, consoleBox.y0 + 1.55, zc + dz], 0.022, 4);
    }
    addRod(b, 'metal', [0.34, consoleBox.y0 + 1.5, zc - 0.36], [0.34, consoleBox.y0 + 1.5, zc + 0.36], 0.024, 4);
    for (const y of [1.56, 2.1, 2.64]) {
      addLifebuoy(b, 0.34, consoleBox.y0 + y, zc, { rot: [0, HALF_PI, 0], r: 0.3 });
    }
  }
  if (variant > 0) {
    // additional side-mounted launcher rack + rescue net canister
    for (const dz of [-0.34, 0.34]) {
      addRod(b, 'metal', [-2.75, platTop, 2.05 + dz], [-2.75, platTop + 1.65, 2.05 + dz], 0.02, 4);
    }
    for (const y of [0.55, 1.1]) {
      addLifebuoy(b, -2.75, platTop + y, 2.05, { rot: [0, 0, 0], r: 0.28 });
    }
    addCyl(b, 'safetyOrange', 0.14, 0.14, 0.8, -3.6, platTop + 0.2, 2.0, 0, 0, HALF_PI, 8);
  }

  // --- bow markings, deck fittings ----------------------------------------
  addHatch(b, 5.2, deckY(spec, 5.2) + 0.02, { w: 0.9, d: 0.7 });
  // red/white identification markings on the foredeck
  addBox(b, 'white', 1.5, 0.04, 0.42, 5.9, deckY(spec, 5.9) + 0.05, 0.55);
  addBox(b, redKey, 1.5, 0.04, 0.42, 5.9, deckY(spec, 5.9) + 0.05, 0.05);
  addBox(b, 'safetyOrange', 0.42, 0.04, 1.0, 5.9, deckY(spec, 5.9) + 0.05, -0.7);
  addCleat(b, 6.8, deckY(spec, 6.8), 0.4);
  addCleat(b, 6.8, deckY(spec, 6.8), -0.4);
  addCleat(b, -7.2, deckY(spec, -7.2), 1.5);
  addCleat(b, -7.2, deckY(spec, -7.2), -1.5);
  // towing bitts at the stern
  for (const side of [-1, 1]) {
    addCyl(b, 'metal', 0.1, 0.12, 0.3, -7.35, platTop + 0.15, side * 1.1, 0, 0, 0, 8);
  }

  // --- lights & rails ------------------------------------------------------
  addNavLights(b, spec, 1.05, { height: 0.78, inset: 0.92 });
  addDeckLight(b, 0.35, deckY(spec, 0.35) + 0.14, 1.35, 'glowWarm', 0.032);
  addDeckLight(b, 0.35, deckY(spec, 0.35) + 0.14, -1.35, 'glowWarm', 0.032);
  addDeckLight(b, -4.6, platTop + 0.06, 1.9, 'glowCyan', 0.03);
  addDeckLight(b, -6.9, platTop + 0.06, -1.9, 'glowWarm', 0.03);
  addRailRun(b, 'metal', hullRailPoints(spec, 0.7, 0.94, 7, 1, 0.24), 0.75);
  addRailRun(b, 'metal', hullRailPoints(spec, 0.7, 0.94, 7, -1, 0.24), 0.75);
  addRailRun(b, 'metal', hullRailPoints(spec, 0.08, 0.32, 6, 1, 0.24), 0.9);
  addRailRun(b, 'metal', hullRailPoints(spec, 0.08, 0.32, 6, -1, 0.24), 0.9);
  addFenders(b, spec, [0.12, 0.25, 0.38, 0.51, 0.64].map((u) => u + ctx.rng.range(-0.01, 0.01)), { v: 0.72, length: 0.52, depth: 0.2 });
  // orange fender covers on two fenders
  for (const side of [-1, 1]) {
    const p = hullSurfacePoint(spec, 0.25, 0.72, side);
    addRBox(b, 'safetyOrange', 0.3, 0.1, 0.1, p.x, p.y + 0.02, p.z + side * 0.09, 0.03);
  }
}

// -----------------------------------------------------------------------------
// builder dispatch table
// -----------------------------------------------------------------------------
const VESSEL_BUILDERS = {
  scout: buildScout,
  env: buildEnv,
  survey: buildSurvey,
  patrol: buildPatrol,
  comms: buildComms,
  energy: buildEnergy,
  rescue: buildRescue,
};

