// =============================================================================
// Geometry toolkit shared by every procedural model in the scene.
// - Builder gathers transformed geometries and merges them per material to keep
//   draw calls low, and can emit a single inverted-hull outline mesh.
// - hullParts() builds a believable ship hull from parametric sections.
// Design rules: geometry is baked into object space (no per-mesh transforms in
// the merged output), attributes are normalised to position/normal/uv/color so
// mixed primitive types can always be merged.
// =============================================================================
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

export function clamp(v, a, b) {
  return v < a ? a : v > b ? b : v;
}
export function lerp(a, b, t) {
  return a + (b - a) * t;
}
export function smoothstep(a, b, x) {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}
export function smootherstep(a, b, x) {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
}
export function easeInOut(t) {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

// --- deterministic randomness -------------------------------------------------
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function makeRng(seed) {
  const r = mulberry32(seed);
  const api = () => r();
  api.range = (a, b) => a + (b - a) * r();
  api.int = (a, b) => Math.floor(a + (b - a + 1) * r());
  api.pick = (arr) => arr[Math.floor(r() * arr.length) % arr.length];
  api.sign = () => (r() < 0.5 ? -1 : 1);
  api.chance = (p) => r() < p;
  return api;
}

// --- cheap 2d value noise ------------------------------------------------------
function hash2i(x, y) {
  let h = x * 374761393 + y * 668265263;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967295;
}
export function valueNoise2(x, y) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash2i(xi, yi);
  const b = hash2i(xi + 1, yi);
  const c = hash2i(xi, yi + 1);
  const d = hash2i(xi + 1, yi + 1);
  return lerp(lerp(a, b, u), lerp(c, d, u), v) * 2 - 1;
}
export function fbm2(x, y, octaves = 4, lacunarity = 2.0, gain = 0.5) {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise2(x * freq, y * freq);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}
export function ridgeNoise2(x, y, octaves = 4) {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * (1 - Math.abs(valueNoise2(x * freq, y * freq)));
    norm += amp;
    amp *= 0.5;
    freq *= 2.0;
  }
  return sum / norm;
}

// -----------------------------------------------------------------------------
// transform helper
// -----------------------------------------------------------------------------
const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();

export function matrixFrom(transform) {
  if (!transform) return new THREE.Matrix4();
  if (transform.isMatrix4) return transform.clone();
  const pos = transform.pos || transform.position || [0, 0, 0];
  const rot = transform.rot || transform.rotation || [0, 0, 0];
  let scale = transform.scale;
  if (scale === undefined) scale = [1, 1, 1];
  if (typeof scale === 'number') scale = [scale, scale, scale];
  _v.set(pos[0], pos[1], pos[2]);
  _q.setFromEuler(_e.set(rot[0], rot[1], rot[2]));
  _s.set(scale[0], scale[1], scale[2]);
  return _m4.compose(_v, _q, _s).clone();
}

/** Normalise attribute layout so unrelated primitives can be merged. */
export function normalizeGeometry(geo, withColor = true, color = 0xffffff) {
  const out = geo.index ? geo.toNonIndexed() : geo;
  if (out !== geo) geo.dispose?.();
  for (const name of Object.keys(out.attributes)) {
    if (name !== 'position' && name !== 'normal' && name !== 'uv' && name !== 'color') {
      out.deleteAttribute(name);
    }
  }
  if (!out.getAttribute('normal')) out.computeVertexNormals();
  if (!out.getAttribute('uv')) {
    const count = out.getAttribute('position').count;
    out.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2));
  }
  if (withColor) {
    if (!out.getAttribute('color')) {
      const count = out.getAttribute('position').count;
      const c = new THREE.Color(color);
      const arr = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        arr[i * 3] = c.r;
        arr[i * 3 + 1] = c.g;
        arr[i * 3 + 2] = c.b;
      }
      out.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    }
  } else if (out.getAttribute('color')) {
    out.deleteAttribute('color');
  }
  out.morphAttributes = {};
  return out;
}

export function tintGeometry(geo, color) {
  const c = new THREE.Color(color);
  const count = geo.getAttribute('position').count;
  const arr = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

// -----------------------------------------------------------------------------
// Builder — merge static geometry into a handful of draw calls.
// usage:
//   const b = new Builder(materials, { outlineMaterial });
//   b.add(geo, 'pearl', { pos:[..], rot:[..], scale:[..] }, 0xffffff);
//   b.solid(geo, 'pearl', transform);           // also contributes to outline
//   const group = b.build();
//   const rotor = b.dynamic('radar'); rotor.add(mesh)
// Dynamic parts are returned as live objects added to the group.
// -----------------------------------------------------------------------------
export class Builder {
  constructor(materials, opts = {}) {
    this.materials = materials;
    this.buckets = new Map();
    this.solids = [];
    this.outlineMaterial = opts.outlineMaterial || null;
    this.dynamicGroups = new Map();
    this.extraMeshes = [];
    this.disposeSources = [];
  }

  _store(geo, materialKey, transform, tint, isSolid) {
    let g = geo.clone();
    const m = matrixFrom(transform);
    g.applyMatrix4(m);
    g = normalizeGeometry(g, true, tint === undefined ? 0xffffff : tint);
    if (!this.buckets.has(materialKey)) this.buckets.set(materialKey, []);
    this.buckets.get(materialKey).push(g);
    if (isSolid && this.outlineMaterial) {
      let og = g.clone();
      og.deleteAttribute('uv');
      og.deleteAttribute('color');
      this.solids.push(og);
    }
    geo.dispose?.();
  }

  add(geo, materialKey, transform, tint) {
    this._store(geo, materialKey, transform, tint, false);
    return this;
  }

  solid(geo, materialKey, transform, tint) {
    this._store(geo, materialKey, transform, tint, true);
    return this;
  }

  /** Add several primitives with one call: [geo, matKey, transform, tint], ... */
  addAll(list) {
    for (const [geo, matKey, transform, tint] of list) this.add(geo, matKey, transform, tint);
    return this;
  }

  addMesh(mesh) {
    this.extraMeshes.push(mesh);
    return this;
  }

  /** Named group for animated sub-meshes (radar, gimbal, flags...). */
  dynamic(name, transform) {
    let g = this.dynamicGroups.get(name);
    if (!g) {
      g = new THREE.Group();
      g.name = name;
      if (transform) applyTransform(g, transform);
      this.dynamicGroups.set(name, g);
    }
    return g;
  }

  build() {
    const root = new THREE.Group();
    for (const [key, geos] of this.buckets) {
      if (!geos.length) continue;
      const merged = mergeGeometries(geos, false);
      if (!merged) {
        console.warn('[Builder] merge failed for', key);
        continue;
      }
      const mat = this.materials[key];
      if (!mat) {
        console.warn('[Builder] missing material', key);
        continue;
      }
      const mesh = new THREE.Mesh(merged, mat);
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      const lod = mat.userData?.lod ?? 'near';
      mesh.userData.detail = lod;
      root.add(mesh);
      geos.forEach((g) => g.dispose());
    }
    if (this.solids.length) {
      const mergedSolid = mergeGeometries(this.solids, false);
      if (mergedSolid) {
        const outline = new THREE.Mesh(mergedSolid, this.outlineMaterial);
        outline.renderOrder = -1;
        root.add(outline);
      }
      this.solids.forEach((g) => g.dispose());
    }
    for (const g of this.dynamicGroups.values()) root.add(g);
    for (const m of this.extraMeshes) root.add(m);
    return root;
  }
}

export function applyTransform(obj, transform) {
  const m = matrixFrom(transform);
  m.decompose(obj.position, obj.quaternion, obj.scale);
  return obj;
}

// -----------------------------------------------------------------------------
// Basic primitives (return fresh geometry, already in a useful orientation)
// -----------------------------------------------------------------------------
export function box(w, h, d) {
  return new THREE.BoxGeometry(w, h, d);
}
export function rbox(w, h, d, r = 0.15, seg = 2) {
  return new RoundedBoxGeometry(w, h, Math.max(d, 0.001), Math.min(seg, 4), Math.min(r, Math.min(w, h, d) * 0.45));
}
export function cyl(rt, rb, h, seg = 16, open = false) {
  return new THREE.CylinderGeometry(rt, rb, h, seg, 1, open);
}
export function sphere(r, w = 16, h = 12) {
  return new THREE.SphereGeometry(r, w, h);
}
export function dome(r, seg = 20, rings = 10, heightScale = 1) {
  const g = new THREE.SphereGeometry(r, seg, rings, 0, TAU, 0, Math.PI / 2);
  g.scale(1, heightScale, 1);
  return g;
}
export function disc(r, seg = 24) {
  const g = new THREE.CircleGeometry(r, seg);
  g.rotateX(-Math.PI / 2);
  return g;
}
export function ring(inner, outer, seg = 32) {
  const g = new THREE.RingGeometry(inner, outer, seg);
  g.rotateX(-Math.PI / 2);
  return g;
}
export function plane(w, h) {
  return new THREE.PlaneGeometry(w, h);
}
export function tube(points, radius, tubularSegments = 24, radialSegments = 6, closed = false) {
  const curve = points instanceof THREE.Curve ? points : new THREE.CatmullRomCurve3(points, closed, 'catmullrom', 0.4);
  return new THREE.TubeGeometry(curve, tubularSegments, radius, radialSegments, closed);
}
export function lathe(points, segments = 20) {
  const pts = points.map((p) => new THREE.Vector2(p[0], p[1]));
  return new THREE.LatheGeometry(pts, segments);
}
/** Tapered box / frustum: bottom wxd, top scaled. */
export function frustum(w, h, d, topX = 0.6, topZ = 0.6) {
  const g = new THREE.BoxGeometry(w, h, d, 1, 1, 1);
  const pos = g.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    if (y > 0) {
      pos.setX(i, pos.getX(i) * topX);
      pos.setZ(i, pos.getZ(i) * topZ);
    }
  }
  pos.needsUpdate = true;
  g.computeVertexNormals();
  return g;
}
/** Extrude an XZ polygon upward (rounded rect by default) — handy for cabins. */
export function extrudeXZ(shape, height, bevel = 0.06) {
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: height,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 2,
    curveSegments: 8,
  });
  g.rotateX(-Math.PI / 2);
  return g;
}
export function roundedRectShape(w, d, r) {
  const s = new THREE.Shape();
  const hw = w / 2;
  const hd = d / 2;
  r = Math.min(r, Math.min(hw, hd) * 0.9);
  s.moveTo(-hw + r, -hd);
  s.lineTo(hw - r, -hd);
  s.quadraticCurveTo(hw, -hd, hw, -hd + r);
  s.lineTo(hw, hd - r);
  s.quadraticCurveTo(hw, hd, hw - r, hd);
  s.lineTo(-hw + r, hd);
  s.quadraticCurveTo(-hw, hd, -hw, hd - r);
  s.lineTo(-hw, -hd + r);
  s.quadraticCurveTo(-hw, -hd, -hw + r, -hd);
  return s;
}
/** Vertical cylinder-ish rod between two points. */
export function rod(points, radius = 0.05, seg = 6) {
  return tube(points, radius, Math.max(8, points.length * 6), seg);
}
export function torus(r, t, rs = 8, ts = 24) {
  return new THREE.TorusGeometry(r, t, rs, ts);
}

// -----------------------------------------------------------------------------
// Hull construction
// -----------------------------------------------------------------------------
// spec fields (all meters):
//   length, beam, freeboard, sheer, draft,
//   bowSharp (0.4..1.4 - larger = finer entry), flare (0..0.6),
//   rocker (bow keel rise 0..1), sternWidth (0.7..1), camber,
//   rake (bow rake, 0..0.3), sectionPower (1.2 sharp V .. 2.4 round)
function hullHalfBeam(spec, u) {
  const half = spec.beam * 0.5;
  const stern = spec.sternWidth ?? 0.88;
  const bowSharp = spec.bowSharp ?? 0.9;
  const wide = stern + (1.0 - stern) * Math.sin(Math.PI * clamp(u * 0.92, 0, 1));
  const taper = Math.pow(Math.max(0, 1 - Math.pow(u, 2.2 * bowSharp)), 0.52);
  return half * wide * taper;
}
function hullDraftAt(spec, u) {
  const draft = spec.draft;
  const rocker = spec.rocker ?? 0.55;
  const base = 0.6 + 0.5 * Math.exp(-Math.pow((u - 0.42) / 0.36, 2));
  return draft * base * (1 - rocker * Math.pow(u, 2.6));
}
function hullFreeboardAt(spec, u) {
  const sheer = spec.sheer ?? 0;
  return (spec.freeboard ?? 1.2) + sheer * Math.pow(u, 2.1);
}
function hullWidthAt(spec, u, v) {
  const half = hullHalfBeam(spec, u);
  const flare = spec.flare ?? 0.16;
  const bowFactor = Math.pow(clamp(u, 0, 1), 2.2);
  return half * (1 + flare * Math.pow(clamp(v, 0, 1), 1.6) * bowFactor);
}
function hullSection(spec, u, v) {
  // v: 0 = keel, 1 = deck edge. starboard half (mirror z for port)
  const width = hullWidthAt(spec, u, v);
  const p = spec.sectionPower ?? 1.75;
  const z = Math.pow(v, p) * width;
  const keel = -hullDraftAt(spec, u);
  const deck = hullFreeboardAt(spec, u);
  const y = keel + (deck - keel) * v;
  // raked stem: deck level leans forward near the bow
  const rake = spec.rake ?? 0.12;
  const xBow = Math.pow(clamp((u - 0.72) / 0.28, 0, 1), 2.0) * rake * v;
  const x = (u - 0.5) * spec.length + xBow * spec.length * 0.06;
  return { x, y, z };
}

function buildHullGrid(spec, vFrom, vTo, rows, uSegments) {
  // returns starboard half grid; mirrored afterwards
  const cols = uSegments + 1;
  const rowCount = rows + 1;
  const positions = [];
  for (let i = 0; i < cols; i++) {
    const u = i / uSegments;
    for (let j = 0; j < rowCount; j++) {
      const v = vFrom(u) + (vTo(u) - vFrom(u)) * (j / rows);
      const s = hullSection(spec, u, v);
      positions.push(s.x, s.y, s.z);
    }
  }
  const indices = [];
  for (let i = 0; i < uSegments; i++) {
    for (let j = 0; j < rows; j++) {
      const a = i * rowCount + j; // this station, row j
      const b = (i + 1) * rowCount + j;
      const c = i * rowCount + j + 1;
      const d = (i + 1) * rowCount + j + 1;
      indices.push(a, b, c);
      indices.push(c, b, d);
    }
  }
  return { positions, indices, cols, rowCount, uSegments, rows };
}

function mirrorGrid(grid, sign) {
  const positions = grid.positions.slice();
  const indices = grid.indices.slice();
  if (sign < 0) {
    for (let i = 0; i < positions.length; i += 3) positions[i + 2] = -positions[i + 2];
    // flip winding for mirrored half
    for (let i = 0; i < indices.length; i += 3) {
      const t = indices[i];
      indices[i] = indices[i + 2];
      indices[i + 2] = t;
    }
  }
  return { positions, indices };
}

function gridToGeometry(parts) {
  const pos = [];
  const idx = [];
  let offset = 0;
  for (const p of parts) {
    pos.push(...p.positions);
    for (const i of p.indices) idx.push(i + offset);
    offset += p.positions.length / 3;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}
function gridToGeometryNonIndexed(parts) {
  const g = gridToGeometry(parts);
  const out = g.toNonIndexed();
  g.dispose();
  out.computeVertexNormals();
  return out;
}

/**
 * Build a complete hull.
 * Returns { lower, topsides, deck, transom }
 *  - lower: bottom paint, from keel to waterline (y = waterlineOffset)
 *  - topsides: waterline to deck edge
 *  - deck: top cap with camber
 *  - transom: flat stern cap
 */
export function hullParts(spec) {
  const length = spec.length;
  const uSeg = spec.uSegments ?? 46;
  const rowsLower = spec.rowsLower ?? 7;
  const rowsUpper = spec.rowsUpper ?? 8;
  const waterline = spec.waterlineOffset ?? 0;
  const camber = spec.camber ?? 0.05;

  const vWater = (u) => {
    const keel = -hullDraftAt(spec, u);
    const deck = hullFreeboardAt(spec, u);
    return clamp((waterline - keel) / (deck - keel), 0.02, 0.98);
  };

  const lowerGrid = buildHullGrid(spec, () => 0, vWater, rowsLower, uSeg);
  const upperGrid = buildHullGrid(spec, vWater, () => 1, rowsUpper, uSeg);
  const lower = gridToGeometry([mirrorGrid(lowerGrid, 1), mirrorGrid(lowerGrid, -1)]);
  const topsides = gridToGeometry([mirrorGrid(upperGrid, 1), mirrorGrid(upperGrid, -1)]);

  // deck cap with camber
  const pos = [];
  const idx = [];
  const rowWidth = 5;
  const profile = [1, 0.45, 0.0, 0.45, 1];
  const sideSign = [-1, -1, 0, 1, 1];
  for (let i = 0; i <= uSeg; i++) {
    const u = i / uSeg;
    const edge = hullSection(spec, u, 1);
    const width = hullWidthAt(spec, u, 1);
    for (let j = 0; j < rowWidth; j++) {
      const side = sideSign[j];
      const z = side * width * profile[j];
      const y = hullFreeboardAt(spec, u);
      pos.push(edge.x, y + camber * (1 - Math.pow(profile[j], 1.5)) * width, z);
    }
  }
  for (let i = 0; i < uSeg; i++) {
    for (let j = 0; j < rowWidth - 1; j++) {
      const a = i * rowWidth + j;
      const b = (i + 1) * rowWidth + j;
      const c = i * rowWidth + j + 1;
      const d = (i + 1) * rowWidth + j + 1;
      idx.push(a, c, b);
      idx.push(c, d, b);
    }
  }
  const deck = new THREE.BufferGeometry();
  deck.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  deck.setIndex(idx);
  deck.computeVertexNormals();

  // transom: U shaped stern face fan (facing aft, -X: outward from the boat)
  const tpos = [];
  const tidx = [];
  const sideRows = rowsLower + rowsUpper;
  const ring = [];
  // port deck -> keel (port side)
  for (let j = sideRows; j >= 0; j--) {
    const v = j / sideRows;
    const s = hullSection(spec, 0, v);
    ring.push([s.x, s.y, -s.z]);
  }
  // keel -> starboard deck
  for (let j = 1; j <= sideRows; j++) {
    const v = j / sideRows;
    const s = hullSection(spec, 0, v);
    ring.push([s.x, s.y, s.z]);
  }
  const cx = ring.reduce((a, p) => a + p[0], 0) / ring.length;
  const cy = ring.reduce((a, p) => a + p[1], 0) / ring.length;
  tpos.push(cx, cy, 0);
  for (const p of ring) tpos.push(...p);
  // wind the whole stern cross-section as a fan, including the deck-to-deck
  // closing edge (the ring is open at the top, so the final wedge must be
  // emitted too — otherwise the upper middle of the transom is a see-through
  // notch). Wound so the stern face normal points aft (-X).
  for (let j = 0; j < ring.length; j++) {
    const a = j + 1;
    const b = ((j + 1) % ring.length) + 1;
    tidx.push(0, a, b);
  }
  const transom = new THREE.BufferGeometry();
  transom.setAttribute('position', new THREE.Float32BufferAttribute(tpos, 3));
  transom.setIndex(tidx);
  transom.computeVertexNormals();

  return { lower, topsides, deck, transom };
}

/** A thin band hugging the hull between two vertical parameters (0..1). */
export function hullBand(spec, v0, v1, offset = 0.03, uSegments = 36) {
  const uSeg = uSegments;
  // For each station: [stbd v0, stbd v1, port v0, port v1]
  const verts = [];
  const inds = [];
  const stationStride = 4;
  for (let i = 0; i <= uSeg; i++) {
    const u = i / uSeg;
    const s0 = hullSection(spec, u, v0);
    const s1 = hullSection(spec, u, v1);
    const k0 = 1 + offset / Math.max(0.3, hullHalfBeam(spec, u));
    verts.push(s0.x, s0.y, s0.z * k0);
    verts.push(s1.x, s1.y, s1.z * k0);
    verts.push(s0.x, s0.y, -s0.z * k0);
    verts.push(s1.x, s1.y, -s1.z * k0);
  }
  for (let i = 0; i < uSeg; i++) {
    const a = i * stationStride;
    const b = (i + 1) * stationStride;
    // starboard
    inds.push(a, b, a + 1);
    inds.push(a + 1, b, b + 1);
    // port
    inds.push(a + 2, a + 3, b + 2);
    inds.push(a + 3, b + 3, b + 2);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.setIndex(inds);
  geo.computeVertexNormals();
  return geo;
}

/** Return a point on the hull surface in local space. */
export function hullSurfacePoint(spec, u, v, side = 1) {
  const s = hullSection(spec, u, v);
  return new THREE.Vector3(s.x, s.y, s.z * side);
}

/** Convenience: a long thin waterline stripe box that follows the hull side. */
export function hullSideStripe(spec, v, thickness = 0.1, uSegments = 30) {
  return hullBand(spec, Math.max(0, v - 0.004), Math.min(1, v + 0.004), 0.035, uSegments);
}
