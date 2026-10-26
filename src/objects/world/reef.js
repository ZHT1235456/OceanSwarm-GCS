// =============================================================================
// reef.js — shallow coral lagoon for the OceanSwarm ocean test range.
//
//   createReef() -> { group, update(time, dt) }
//
// The ocean shader renders the water translucent inside the SHOALS ellipses
// around LAYOUT.reef, so everything built here lives below the surface and is
// meant to be read "through" the water. All content is placed relative to the
// shoal centres from config.js:
//
//   * seabed sand terrain for the main lagoon + secondary bank + sand bank,
//     mottled vertex colours (pale sand centre, seagrass patches, darker rim),
//     gently rippled and always below y = -1.
//   * coral gardens: branching coral, fan coral and brain / sponge coral built
//     as low-poly templates and instanced ~245 times, larger towards the centre
//     and leaving meandering open sandy channels.
//   * dark reef rocks: three clusters + two small rocky islets breaking the
//     surface on the lagoon rim (with tide-wet bands and foam rings). The
//     lighthouse rock at LAYOUT.lighthouse is left untouched.
//   * swaying kelp / seaweed: one InstancedMesh with a vertex-shader sway,
//     ~100 patches across the three shoals.
//   * three small fish schools (instanced) circling above the seabed; the
//     matrices are updated every frame.
//   * very subtle caustic light rings slowly drifting on the seabed.
//
// Everything is deterministic (fixed RNG seeds), fogged and stylised toon.
// Budget: ~55k triangles.
// =============================================================================
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { COLORS, LAYOUT, SHOALS } from '../../config.js';
import { TAU, clamp, lerp, smoothstep, fbm2, makeRng } from '../../core/geo.js';
import { makeToon } from '../../core/materials.js';

// -----------------------------------------------------------------------------
// Small helpers
// -----------------------------------------------------------------------------
const c = (hex) => new THREE.Color(hex);

function asNonIndexed(geo) {
  if (!geo.index) return geo;
  const out = geo.toNonIndexed();
  geo.dispose();
  return out;
}

/** Bake one flat colour per triangle; returns flat-shaded non-indexed geometry. */
function flatColorFaces(geo, colorFn) {
  geo = asNonIndexed(geo);
  const pos = geo.getAttribute('position');
  const count = pos.count;
  const colors = new Float32Array(count * 3);
  const tmp = new THREE.Color();
  for (let i = 0; i + 2 < count; i += 3) {
    const cx = (pos.getX(i) + pos.getX(i + 1) + pos.getX(i + 2)) / 3;
    const cy = (pos.getY(i) + pos.getY(i + 1) + pos.getY(i + 2)) / 3;
    const cz = (pos.getZ(i) + pos.getZ(i + 1) + pos.getZ(i + 2)) / 3;
    colorFn(tmp, cx, cy, cz);
    for (let k = 0; k < 3; k++) {
      const o = (i + k) * 3;
      colors[o] = tmp.r;
      colors[o + 1] = tmp.g;
      colors[o + 2] = tmp.b;
    }
  }
  geo.deleteAttribute('uv');
  geo.deleteAttribute('color');
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  return geo;
}

/** Noisy squashed boulder (indexed sphere displaced by direction noise). */
function boulderGeometry(rng, radius, segments = 8, rings = 6, squash = 0.75) {
  const geo = new THREE.SphereGeometry(1, segments, rings);
  const pos = geo.getAttribute('position');
  const v = new THREE.Vector3();
  const sa = rng() * 40;
  const sb = rng() * 40;
  const stretchX = 0.82 + rng() * 0.5;
  const stretchZ = 0.82 + rng() * 0.5;
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).normalize();
    const n = fbm2(v.x * 1.8 + sa, v.z * 1.8 + v.y * 1.3 + sb, 3);
    const s = 1 + 0.32 * n;
    pos.setXYZ(i, v.x * s * radius * stretchX, v.y * s * radius * squash, v.z * s * radius * stretchZ);
  }
  geo.computeVertexNormals();
  return geo;
}

// -----------------------------------------------------------------------------
// Palette
// -----------------------------------------------------------------------------
const PAL = {
  sandLight: c(0xfff9d8),
  sandMid: c(0xd9d2a0),
  sandDark: c(0x8d8f68),
  seagrass: c(0x123a24),
  seagrassLight: c(0x2e6640),
  rock: c(0x2e3e3b),
  rockLight: c(0x7f8781),
  rockWet: c(0x223239),
  deep: c(0x1e5666),
  deepEdge: c(0x0b3a50),
  sandWhite: c(0xf7f1cd),
  channel: c(0x063646),
  rockRubble: c(0x1f2e2b),
  gorgonian: c(0x5c4a63),
  foam: c(COLORS.foam),
  algae: c(0x4c7d55),
  coral: [c(0xff7a92), c(0xff9648), c(0xb47cf5), c(0xff6f85)],
  kelp: [c(0x2b6b4a), c(0x357a4f), c(0x437a3e), c(0x245a44), c(0x557a3c)],
  fish: [c(0xb9d4d2), c(0x9fc4cf), c(0xd9d3a8), c(0x8fb8bc), c(0xc9dcd4)],
};

// -----------------------------------------------------------------------------
// Shoal / lagoon definitions
// -----------------------------------------------------------------------------
function createShoalSpecs() {
  // primary reef, secondary bank and sand banks come from config SHOALS;
  // the island shelf (around LAYOUT.baseIsland) is handled by islands.js
  const baseIsland = LAYOUT.baseIsland;
  const candidates = SHOALS.filter((s) => Math.hypot(s.x - baseIsland.x, s.z - baseIsland.z) > 120);
  const ranked = candidates
    .map((s) => ({ s, d: Math.hypot(s.x - LAYOUT.reef.x, s.z - LAYOUT.reef.z) }))
    .sort((a, b) => a.d - b.d)
    .map((o) => o.s);

  const primary = ranked[0] ?? { x: LAYOUT.reef.x, z: LAYOUT.reef.z, rx: 830, rz: 650 };
  const secondary = ranked[1] ?? { x: 640, z: 1560, rx: 430, rz: 330 };
  const sandbar = ranked[2] ?? { x: 3000, z: 2500, rx: 320, rz: 230 };

  // rim rock clusters / islets for the primary lagoon (world coords). They sit
  // inside the shoal, on the outer rim, away from LAYOUT.lighthouse.
  // rim rock clusters / islets, expressed as fractions of the primary shoal
  // ellipse so they follow LAYOUT/SHOALS automatically. Kept away from the
  // lighthouse rock (built by another module).
  const rimFeatures = [
    { type: 'cluster', fx: 0.94, fz: 0.16, radius: 34, rockCount: 9 },
    { type: 'cluster', fx: 0.86, fz: 0.3, radius: 30, rockCount: 8 },
    { type: 'cluster', fx: 0.78, fz: -0.46, radius: 32, rockCount: 8 },
    { type: 'cluster', fx: 0.92, fz: 0.62, radius: 28, rockCount: 7 },
    { type: 'cluster', fx: 0.55, fz: -0.72, radius: 26, rockCount: 6 },
    { type: 'islet', fx: 0.4, fz: 0.86, radius: 46, rockCount: 7 },
    { type: 'islet', fx: 0.96, fz: -0.14, radius: 42, rockCount: 6 },
  ]
    .map((fdef) => ({ ...fdef, x: primary.x + fdef.fx * primary.rx, z: primary.z + fdef.fz * primary.rz }))
    .filter((fdef) => Math.hypot(fdef.x - LAYOUT.lighthouse.x, fdef.z - LAYOUT.lighthouse.z) > 230);


  return [
    {
      id: 'reef-lagoon',
      kind: 'lagoon',
      x: primary.x,
      z: primary.z,
      rx: primary.rx,
      rz: primary.rz,
      angular: 224,
      rings: 80,
      baseDepth: -8.6,
      centreLift: 4.2,
      minDepth: -11.0,
      rimDrop: 2.2,
      reliefAmp: 1.25,
      rippleAmp: 0.2,
      eMax: 1.24,
      seed: 411,
      rimFeatures,
      coral: true,
      kelpPatches: 66,
      fishSchools: true,
    },
    {
      id: 'reef-bank',
      kind: 'bank',
      x: secondary.x,
      z: secondary.z,
      rx: secondary.rx,
      rz: secondary.rz,
      angular: 120,
      rings: 38,
      baseDepth: -7.8,
      centreLift: 1.9,
      minDepth: -10.0,
      rimDrop: 1.8,
      reliefAmp: 1.0,
      rippleAmp: 0.12,
      eMax: 1.22,
      seed: 733,
      rimFeatures: [],
      coral: false,
      kelpPatches: 20,
      fishSchools: false,
    },
    {
      id: 'reef-sandbar',
      kind: 'sandbar',
      x: sandbar.x,
      z: sandbar.z,
      rx: sandbar.rx,
      rz: sandbar.rz,
      angular: 82,
      rings: 26,
      baseDepth: -7.2,
      centreLift: 1.1,
      minDepth: -9.0,
      rimDrop: 1.4,
      reliefAmp: 0.9,
      rippleAmp: 0.1,
      eMax: 1.2,
      seed: 977,
      rimFeatures: [],
      coral: false,
      kelpPatches: 12,
      fishSchools: false,
    },
  ];
}

// -----------------------------------------------------------------------------
// Seabed height field for one shoal
// -----------------------------------------------------------------------------
function createSeabed(def) {
  const rng = makeRng(def.seed);
  const off = {
    o1: rng() * 80,
    o2: rng() * 80,
    o3: rng() * 80,
    o4: rng() * 80,
    o5: rng() * 80,
    o6: rng() * 80,
  };
  const chA = rng() * 90;
  const chB = rng() * 90;
  const lifts = (def.rimFeatures ?? []).map((fdef) => ({
    x: fdef.x - def.x,
    z: fdef.z - def.z,
    amp: fdef.type === 'islet' ? 5.0 : 4.4,
    r: fdef.type === 'islet' ? fdef.radius * 1.9 : fdef.radius * 1.6,
  }));

  /**
   * Meandering deeper channels that cut into the lagoon — visible from above as
   * darker blue-green streaks, which makes the lagoon shape readable.
   */
  function channelMask(lx, lz) {
    const n = fbm2(lx * 0.0021 + chA, lz * 0.0021 + chB, 3);
    const e = Math.hypot(lx / def.rx, lz / def.rz);
    return smoothstep(0.16, 0.6, n) * smoothstep(1.0, 0.5, e);
  }

  /** Seabed Y at shoal-local (lx, lz); always <= -1.0 (below the water). */
  function height(lx, lz) {
    const ex = lx / def.rx;
    const ez = lz / def.rz;
    const e = Math.hypot(ex, ez);
    let y = def.baseDepth + def.centreLift * Math.exp(-(e * e) / 0.42);
    y -= def.rimDrop * smoothstep(0.42, 1.16, e);
    // broad dunes + fine ripples
    y += fbm2(lx * 0.0045 + off.o1, lz * 0.0045 + off.o2, 3) * def.reliefAmp * (0.45 + 0.55 * smoothstep(0.05, 0.5, e));
    const ripple = Math.sin(lx * 0.55 + lz * 0.28 + fbm2(lx * 0.02 + off.o3, lz * 0.02 + off.o4, 2) * 3.2);
    y += ripple * def.rippleAmp;
    // channels
    y -= 3.4 * channelMask(lx, lz);
    // raised sand around emergent rocks / islets
    for (let i = 0; i < lifts.length; i++) {
      const l = lifts[i];
      const dx = lx - l.x;
      const dz = lz - l.z;
      y += l.amp * Math.exp(-(dx * dx + dz * dz) / (2 * l.r * l.r));
    }
    // keep it strictly under the translucent surface and within the depth band
    return clamp(y, def.minDepth ?? -10.0, -1.05);
  }

  function eAt(lx, lz) {
    return Math.hypot(lx / def.rx, lz / def.rz);
  }

  return { def, off, height, eAt, lifts, channelMask };
}

// -----------------------------------------------------------------------------
// Seabed mesh (radial elliptical grid, per-face flat colours)
// -----------------------------------------------------------------------------
function buildSeabedMesh(seabed) {
  const def = seabed.def;
  const ang = def.angular;
  const o = seabed.off;

  // vertex-colour function (smooth interpolation over the dense indexed grid)
  function vertexColor(out, px, pz) {
    const ex = px / def.rx;
    const ez = pz / def.rz;
    const e = Math.hypot(ex, ez);
    const depth = -seabed.height(px, pz);
    const n1 = fbm2(px * 0.0055 + o.o1, pz * 0.0055 + o.o2, 3);
    const n2 = fbm2(px * 0.02 + o.o3, pz * 0.02 + o.o4, 2);
    const n3 = fbm2(px * 0.075 + o.o5, pz * 0.075 + o.o6, 2);
    const channel = seabed.channelMask(px, pz);

    const shallowT = smoothstep(8.5, 2.4, depth);
    out.copy(PAL.sandMid).lerp(PAL.sandLight, shallowT * 0.85);
    // bright white sand bars
    const bar = smoothstep(0.22, 0.8, n1 * 0.62 + n2 * 0.38) * smoothstep(7.5, 2.2, depth);
    out.lerp(PAL.sandWhite, bar * 0.85);
    // subtle ripple banding
    const rip = Math.sin(px * 0.19 + pz * 0.11 + n1 * 3.0);
    out.lerp(PAL.sandLight, smoothstep(0.1, 0.9, rip) * 0.14);
    out.lerp(PAL.sandDark, smoothstep(0.2, -0.85, rip) * 0.12);
    out.lerp(PAL.sandDark, smoothstep(6.0, 9.5, depth) * 0.55);
    // seagrass / algae beds (large darker patches)
    const grass = smoothstep(0.02, 0.52, n3 * 0.6 + n1 * 0.4) * smoothstep(1.6, 3.0, depth);
    out.lerp(PAL.seagrass, grass * (0.55 + 0.25 * n2));
    out.lerp(PAL.seagrassLight, grass * smoothstep(0.3, 1.0, n2) * 0.28);
    // dark reef-rock pavements
    const pavement = smoothstep(0.32, 0.72, fbm2(px * 0.011 + o.o2, pz * 0.011 + o.o1, 2) * 0.5 + 0.5) * smoothstep(2.4, 4.2, depth);
    out.lerp(PAL.rock, pavement * 0.55);
    out.lerp(PAL.rockRubble, smoothstep(0.25, 0.75, n2) * pavement * 0.45);
    // deep channels -> dark blue-green streaks
    out.lerp(PAL.channel, channel * 0.8);
    // scattered rubble speckle
    out.lerp(PAL.rockRubble, smoothstep(0.5, 0.8, n2) * 0.14);
    // fade the rim into deep water so the shoal edge is invisible
    out.lerp(PAL.deep, smoothstep(0.86, 1.08, e));
    out.lerp(PAL.deepEdge, smoothstep(1.06, 1.22, e));
  }

  const positions = [0, seabed.height(0, 0), 0];
  const colors = [];
  const tmp = new THREE.Color();
  vertexColor(tmp, 0, 0);
  colors.push(tmp.r, tmp.g, tmp.b);
  const ringQ = [];
  for (let i = 1; i <= def.rings; i++) ringQ.push(Math.pow(i / def.rings, 0.92) * def.eMax);
  for (let ri = 0; ri < ringQ.length; ri++) {
    const e = ringQ[ri];
    for (let ai = 0; ai < ang; ai++) {
      const a = (ai / ang) * TAU;
      const lx = Math.cos(a) * e * def.rx;
      const lz = Math.sin(a) * e * def.rz;
      positions.push(lx, seabed.height(lx, lz), lz);
      vertexColor(tmp, lx, lz);
      colors.push(tmp.r, tmp.g, tmp.b);
    }
  }
  const indices = [];
  for (let ai = 0; ai < ang; ai++) indices.push(0, 1 + ai, 1 + ((ai + 1) % ang));
  for (let ri = 1; ri < ringQ.length; ri++) {
    const baseA = 1 + (ri - 1) * ang;
    const baseB = 1 + ri * ang;
    for (let ai = 0; ai < ang; ai++) {
      const an = (ai + 1) % ang;
      const a0 = baseA + ai;
      const a1 = baseA + an;
      const b0 = baseB + ai;
      const b1 = baseB + an;
      indices.push(a0, b0, a1, a1, b0, b1);
    }
  }
  // ensure upward-facing winding once, then flip all if needed
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  // check the very first triangle's normal; flip index order when facing down
  const nrm = geo.getAttribute('normal');
  if (nrm && nrm.getY(0) + nrm.getY(1) + nrm.getY(2) < 0) {
    const idx = geo.getIndex().array;
    for (let i = 0; i < idx.length; i += 3) {
      const tmpI = idx[i + 1];
      idx[i + 1] = idx[i + 2];
      idx[i + 2] = tmpI;
    }
    geo.computeVertexNormals();
  }
  geo.name = 'reef-seabed';
  return geo;
}

// -----------------------------------------------------------------------------
// Coral templates (branching / fan / brain)
// -----------------------------------------------------------------------------
const _up = new THREE.Vector3(0, 1, 0);

function cylinderBetween(a, b, r0, r1, seg = 5) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = Math.max(0.001, dir.length());
  const geo = new THREE.CylinderGeometry(r1, r0, len, seg, 1, true);
  const mid = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
  const quat = new THREE.Quaternion().setFromUnitVectors(_up, dir.normalize());
  geo.applyQuaternion(quat);
  geo.translate(mid.x, mid.y, mid.z);
  return geo;
}

function branchingTemplate(rng, opts) {
  const parts = [];
  const base = new THREE.Vector3(0, 0, 0);
  const height = opts.height;
  const trunkTop = new THREE.Vector3(rng.range(-0.1, 0.1), height * 0.36, rng.range(-0.1, 0.1));
  parts.push(cylinderBetween(base, trunkTop, opts.radius, opts.radius * 0.72, 5));

  function grow(from, dir, len, radius, depth) {
    const to = from.clone().addScaledVector(dir, len);
    parts.push(cylinderBetween(from, to, radius, radius * 0.62, 5));
    if (depth <= 0) return;
    const n = 2;
    for (let i = 0; i < n; i++) {
      const axis = new THREE.Vector3(rng() - 0.5, rng() - 0.5, rng() - 0.5).normalize();
      const q = new THREE.Quaternion().setFromAxisAngle(axis, rng.range(0.3, 0.8));
      const nd = dir.clone().applyQuaternion(q);
      nd.y = Math.abs(nd.y) * 0.75 + 0.42;
      nd.normalize();
      grow(to, nd, len * rng.range(0.55, 0.78), radius * 0.62, depth - 1);
    }
  }
  const branches = 3;
  for (let i = 0; i < branches; i++) {
    const axis = new THREE.Vector3(rng() - 0.5, rng() - 0.5, rng() - 0.5).normalize();
    const q = new THREE.Quaternion().setFromAxisAngle(axis, rng.range(0.35, 0.75));
    const dir = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    dir.y = Math.abs(dir.y) * 0.7 + 0.5;
    dir.normalize();
    grow(trunkTop, dir, height * 0.26, opts.radius * 0.68, 1);
  }

  const merged = mergeGeometries(parts.map((p) => asNonIndexed(p)), false);
  parts.forEach((p) => p.dispose());
  const geo = flatColorFaces(merged, (out, cx, cy, cz) => {
    const t = clamp(cy / height, 0, 1);
    const v = 0.66 + 0.34 * t + 0.06 * Math.sin(cx * 4.3 + cz * 3.1 + cy * 2.2);
    out.setRGB(v, v, v);
  });
  geo.computeBoundingBox();
  geo.name = 'reef-coral-branch';
  return { geo, height: geo.boundingBox.max.y };
}

function fanTemplate(rng) {
  const seg = 14;
  const fan = new THREE.CircleGeometry(1, seg, 0, Math.PI);
  const pos = fan.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const r = Math.hypot(x, y);
    if (r < 1e-4) continue;
    const n = fbm2(x * 2.1 + 3.7, y * 2.1 + 8.1, 2);
    const k = 1 + 0.16 * n;
    pos.setXYZ(i, x * k, y * k * 1.05, 0.12 * n * (r / 1));
  }
  fan.computeVertexNormals();
  const stem = new THREE.CylinderGeometry(0.07, 0.11, 0.36, 5, 1, true);
  stem.translate(0, 0.18, 0);
  const fanGeo = asNonIndexed(fan);
  fan.dispose();
  fanGeo.translate(0, 0.55, 0);
  const merged = mergeGeometries([asNonIndexed(stem), fanGeo], false);
  stem.dispose();
  fanGeo.dispose();
  const geo = flatColorFaces(merged, (out, cx, cy, cz) => {
    const v = 0.68 + 0.32 * clamp(cy / 1.6, 0, 1) + 0.05 * Math.sin(cx * 6.0 + cz * 4.0);
    out.setRGB(v, v, v);
  });
  geo.computeBoundingBox();
  geo.name = 'reef-coral-fan';
  return { geo, height: geo.boundingBox.max.y };
}

function brainTemplate(rng) {
  const geo = new THREE.SphereGeometry(1, 8, 5, 0, TAU, 0, Math.PI / 2);
  const pos = geo.getAttribute('position');
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).normalize();
    const n = fbm2(v.x * 3.2 + 1.3, v.z * 3.2 + v.y * 2.1 + 4.7, 2);
    const s = 1 + 0.14 * n;
    pos.setXYZ(i, v.x * s * 1.0, v.y * s * 0.78, v.z * s * 1.0);
  }
  geo.computeVertexNormals();
  const g2 = flatColorFaces(geo, (out, cx, cy, cz) => {
    const n = fbm2(cx * 4.1 + 2.2, cz * 4.1 + 6.3, 2) * 0.5 + 0.5;
    const v2 = 0.7 + 0.3 * n + 0.12 * cy;
    out.setRGB(v2, v2, v2);
  });
  g2.computeBoundingBox();
  g2.name = 'reef-coral-brain';
  return { geo: g2, height: g2.boundingBox.max.y };
}

// -----------------------------------------------------------------------------
// Materials
// -----------------------------------------------------------------------------
function createReefMaterials() {
  const seabed = makeToon(0xffffff, { rim: 0.0 });
  seabed.vertexColors = true;
  seabed.needsUpdate = true;

  const coral = makeToon(0xffffff, { rim: 0.2 });
  coral.vertexColors = true;
  coral.needsUpdate = true;

  const rock = makeToon(0xffffff, { rim: 0.08 });
  rock.vertexColors = true;
  rock.needsUpdate = true;

  // kelp: vertex-shader sway driven by a per-instance phase (instance position)
  const kelp = makeToon(0xffffff, { rim: 0.0 });
  kelp.vertexColors = true;
  kelp.side = THREE.DoubleSide;
  kelp.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = { value: 0 };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uTime;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        #ifdef USE_INSTANCING
          float reefPhase = instanceMatrix[3].x * 0.37 + instanceMatrix[3].z * 0.23;
        #else
          float reefPhase = 0.0;
        #endif
        float reefAmt = clamp(transformed.y / 2.9, 0.0, 1.0);
        reefAmt *= reefAmt;
        transformed.x += sin(uTime * 1.05 + reefPhase) * reefAmt * 0.5;
        transformed.z += cos(uTime * 0.83 + reefPhase * 1.7) * reefAmt * 0.32;`,
      );
    kelp.userData.shader = shader;
  };
  kelp.customProgramCacheKey = () => 'reef-kelp-sway';
  kelp.needsUpdate = true;

  const fish = makeToon(0xffffff, { rim: 0.28 });
  fish.side = THREE.DoubleSide;
  fish.needsUpdate = true;

  const foam = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.34,
    depthWrite: false,
    fog: true,
    side: THREE.DoubleSide,
  });

  const caustic = new THREE.MeshBasicMaterial({
    color: 0xcff4ee,
    transparent: true,
    opacity: 0.09,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: true,
    side: THREE.DoubleSide,
    toneMapped: false,
  });

  return { seabed, coral, rock, kelp, fish, foam, caustic };
}

// -----------------------------------------------------------------------------
// Shore rocks / islets on the lagoon rim (+ merged submerged rubble)
// -----------------------------------------------------------------------------
function buildRimRocks(seabed, mats, rng) {
  const def = seabed.def;
  const group = new THREE.Group();
  group.name = 'reef-rocks';
  const pieces = [];
  const foamRings = [];
  const matrix = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const euler = new THREE.Euler();
  const scaleV = new THREE.Vector3();
  const posV = new THREE.Vector3();

  const rockColor = (out, cx, cy, cz) => {
    const n = fbm2(cx * 0.12 + 5.1, cz * 0.12 + 9.3, 2) * 0.5 + 0.5;
    const n2 = fbm2(cx * 0.5 + 2.7, cz * 0.5 + 3.9, 2) * 0.5 + 0.5;
    out.copy(PAL.rock).lerp(PAL.rockLight, n * 0.55);
    // tide-wet band just above the waterline
    const wet = 1 - smoothstep(0.4, 2.4, cy);
    out.lerp(PAL.rockWet, wet * 0.75);
    // algae collar at the base
    out.lerp(PAL.algae, (1 - smoothstep(-0.6, 1.6, cy)) * 0.4 * n2);
    out.lerp(PAL.rockLight, smoothstep(3.0, 7.0, cy) * 0.3);
  };

  for (const feature of def.rimFeatures ?? []) {
    const islet = feature.type === 'islet';
    const centreLocal = { x: feature.x - def.x, z: feature.z - def.z };
    const seabedY = seabed.height(centreLocal.x, centreLocal.z);
    for (let i = 0; i < feature.rockCount; i++) {
      const ang = rng() * TAU;
      const rr = islet ? rng() * feature.radius * 0.45 : rng() * feature.radius * 0.9;
      const lx = centreLocal.x + Math.cos(ang) * rr;
      const lz = centreLocal.z + Math.sin(ang) * rr;
      const groundY = Math.min(seabed.height(lx, lz), seabedY + 0.5);
      const isBig = i === 0;
      const radius = islet
        ? isBig
          ? rng.range(18, 23)
          : rng.range(13, 18)
        : isBig
          ? rng.range(9.5, 13)
          : rng.range(6.0, 10.0);
      const geo = boulderGeometry(rng, 1, islet ? 10 : 8, islet ? 7 : 5, 0.72 + rng() * 0.2);
      euler.set(rng.range(-0.12, 0.12), rng() * TAU, rng.range(-0.12, 0.12));
      quat.setFromEuler(euler);
      scaleV.set(radius, radius * (0.9 + rng() * 0.45), radius);
      posV.set(lx, groundY, lz);
      matrix.compose(posV, quat, scaleV);
      geo.applyMatrix4(matrix);
      // set the rock top so clusters definitely break the surface while a few
      // companions sit half awash
      const targetTop = islet
        ? rng.range(3.5, 7.5)
        : i === 0
          ? rng.range(2.4, 5.0)
          : rng.range(0.3, 3.4);
      geo.computeBoundingBox();
      geo.translate(0, targetTop - geo.boundingBox.max.y, 0);
      pieces.push(flatColorFaces(geo, rockColor));
    }
    // foam ring hugging the feature base on the water surface (local space!)
    const foamR = islet ? 34 : Math.min(27, feature.radius * 0.85);
    const ringGeo = new THREE.RingGeometry(foamR * 0.82, foamR * 1.06, 40, 1);
    ringGeo.rotateX(-Math.PI / 2);
    ringGeo.translate(centreLocal.x, 0.07, centreLocal.z);
    foamRings.push(ringGeo);
  }

  // scattered submerged rubble around the rim / coral gardens
  for (let i = 0; i < 52; i++) {
    const a = rng() * TAU;
    const e = rng.range(0.42, 0.97);
    const lx = Math.cos(a) * e * def.rx;
    const lz = Math.sin(a) * e * def.rz;
    const groundY = seabed.height(lx, lz);
    const radius = rng.range(1.4, 6.5);
    const geo = boulderGeometry(rng, 1, 6, 4, 0.7);
    euler.set(rng.range(-0.25, 0.25), rng() * TAU, rng.range(-0.25, 0.25));
    quat.setFromEuler(euler);
    scaleV.set(radius * 1.2, radius * 0.7, radius * 1.2);
    posV.set(lx, groundY - radius * 0.15, lz);
    matrix.compose(posV, quat, scaleV);
    geo.applyMatrix4(matrix);
    pieces.push(flatColorFaces(geo, rockColor));
  }

  const merged = mergeGeometries(pieces, false);
  pieces.forEach((g) => g.dispose());
  if (merged) {
    const mesh = new THREE.Mesh(merged, mats.rock);
    mesh.frustumCulled = false;
    group.add(mesh);
  }

  let foamMesh = null;
  if (foamRings.length) {
    const foamGeo = mergeGeometries(foamRings, false);
    foamRings.forEach((g) => g.dispose());
    if (foamGeo) {
      foamMesh = new THREE.Mesh(foamGeo, mats.foam);
      foamMesh.frustumCulled = false;
      foamMesh.renderOrder = 3;
      group.add(foamMesh);
    }
  }
  return { group, foamMesh };
}

// -----------------------------------------------------------------------------
// Coral placement + instancing
// -----------------------------------------------------------------------------
function placeCoralClusters(seabed, rng, templateHeights) {
  const def = seabed.def;
  const placements = [];
  const types = [0, 0, 0, 1, 2, 2, 3, 3]; // weighted branching / fan / brain
  const gardenCount = 16;
  for (let g = 0; g < gardenCount; g++) {
    const a = rng() * TAU;
    const e = 0.07 + Math.sqrt(rng()) * 0.8;
    const gx = Math.cos(a) * e * def.rx;
    const gz = Math.sin(a) * e * def.rz;
    // gardens avoid the deeper channels so the streaks stay readable
    if (seabed.channelMask(gx, gz) > 0.4) continue;
    const count = rng.int(22, 42);
    const radius = rng.range(9, 24);
    for (let i = 0; i < count; i++) {
      const aa = rng() * TAU;
      const rr = Math.sqrt(rng()) * radius;
      pushCoral(placements, seabed, gx + Math.cos(aa) * rr, gz + Math.sin(aa) * rr, rng, types[(rng() * types.length) | 0], templateHeights);
    }
  }
  // sparse singles through the open sand
  for (let i = 0; i < 110; i++) {
    const a = rng() * TAU;
    const e = Math.sqrt(rng()) * 0.94;
    const lx = Math.cos(a) * e * def.rx;
    const lz = Math.sin(a) * e * def.rz;
    pushCoral(placements, seabed, lx, lz, rng, types[(rng() * types.length) | 0], templateHeights);
  }
  return placements;
}

function pushCoral(out, seabed, lx, lz, rng, type, templateHeights) {
  const def = seabed.def;
  const e = seabed.eAt(lx, lz);
  if (e > 0.98) return;
  if (seabed.channelMask(lx, lz) > 0.55) return;
  if (Math.hypot(def.x + lx - LAYOUT.lighthouse.x, def.z + lz - LAYOUT.lighthouse.z) < 85) return;
  const y = seabed.height(lx, lz);
  const depth = -y;
  const templateHeight = templateHeights[type] ?? 3.0;
  if (depth < templateHeight + 1.15) return;
  const centreScale = lerp(1.9, 1.05, smoothstep(0.15, 0.95, e));
  let scale = centreScale * rng.range(0.85, 1.3);
  const maxScale = (depth - 1.12) / templateHeight;
  scale = Math.min(scale, maxScale, 3.9 / templateHeight);
  if (scale < 0.5) return;
  out.push({
    type,
    x: lx,
    z: lz,
    y: y - 0.08,
    scale,
    rot: rng() * TAU,
  });
}

function addCoralInstances(group, placements, templates, mats, rng) {
  const byType = [[], [], [], []];
  for (const p of placements) byType[p.type].push(p);
  const dummy = new THREE.Object3D();
  const tint = new THREE.Color();
  for (let type = 0; type < byType.length; type++) {
    const list = byType[type];
    if (!list.length) continue;
    const template = templates[type];
    const mesh = new THREE.InstancedMesh(template.geo, mats.coral, list.length);
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      dummy.position.set(p.x, p.y, p.z);
      dummy.rotation.set(0, p.rot, 0);
      dummy.scale.setScalar(p.scale);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      // coral palette: pink / orange / purple with tonal variation
      let base = PAL.coral[Math.floor(rng() * PAL.coral.length)];
      if (type === 2 && rng() < 0.2) base = PAL.gorgonian;
      tint.copy(base).multiplyScalar(1.2 + 0.35 * rng());
      tint.offsetHSL((rng() - 0.5) * 0.03, (rng() - 0.5) * 0.12, 0);
      mesh.setColorAt(i, tint);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    group.add(mesh);
  }
}

// -----------------------------------------------------------------------------
// Kelp / seaweed
// -----------------------------------------------------------------------------
function kelpBladeGeometry() {
  const segs = 5;
  const height = 2.9;
  const width = 0.36;
  const pos = [];
  const idx = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const y = t * height;
    const w = width * (1 - t * 0.88) * (0.75 + 0.35 * Math.sin(t * 2.4));
    const z = Math.sin(t * Math.PI) * 0.28;
    pos.push(-w, y, z, w, y, z);
  }
  for (let i = 0; i < segs; i++) {
    const a = i * 2;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const nonIndexed = asNonIndexed(geo);
  // neutral vertical shading, tinted per instance
  const p = nonIndexed.getAttribute('position');
  const colors = new Float32Array(p.count * 3);
  for (let i = 0; i <= p.count; i += 3) {
    if (i + 2 >= p.count) break;
    const cy = (p.getY(i) + p.getY(i + 1) + p.getY(i + 2)) / 3;
    const v = 0.62 + 0.38 * clamp(cy / 2.9, 0, 1);
    for (let k = 0; k < 3; k++) {
      const o = (i + k) * 3;
      colors[o] = v;
      colors[o + 1] = v;
      colors[o + 2] = v;
    }
  }
  nonIndexed.deleteAttribute('uv');
  nonIndexed.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  nonIndexed.computeVertexNormals();
  nonIndexed.name = 'reef-kelp';
  return nonIndexed;
}

function placeKelp(specs, seabeds, rng) {
  const blades = [];
  // shoal weights: mostly the main lagoon
  const total = specs.reduce((acc, s) => acc + (s.kelpPatches ?? 0), 0);
  const patches = [];
  for (let i = 0; i < total; i++) {
    const roll = rng();
    let acc = 0;
    let chosen = 0;
    for (let s = 0; s < specs.length; s++) {
      acc += (specs[s].kelpPatches ?? 0) / total;
      if (roll <= acc) {
        chosen = s;
        break;
      }
    }
    patches.push(chosen);
  }
  for (const shoalIndex of patches) {
    const seabed = seabeds[shoalIndex];
    const def = seabed.def;
    const a = rng() * TAU;
    const e = rng.range(0.22, 0.9);
    const cx = Math.cos(a) * e * def.rx;
    const cz = Math.sin(a) * e * def.rz;
    if (Math.hypot(def.x + cx - LAYOUT.lighthouse.x, def.z + cz - LAYOUT.lighthouse.z) < 85) continue;
    const y = seabed.height(cx, cz);
    if (-y < 2.7) continue; // too shallow for kelp
    const patchRadius = rng.range(2.5, 6.5);
    const count = rng.int(5, 9);
    for (let i = 0; i < count; i++) {
      const ba = rng() * TAU;
      const br = Math.sqrt(rng()) * patchRadius;
      const lx = cx + Math.cos(ba) * br;
      const lz = cz + Math.sin(ba) * br;
      const gy = seabed.height(lx, lz);
      if (-gy < 2.5) continue;
      // kelp must stay below the translucent surface (blade is 2.9 m tall)
      const maxScale = (-gy - 1.0) / 2.9;
      const scale = Math.min(rng.range(0.7, 1.35), maxScale);
      if (scale < 0.5) continue;
      blades.push({
        shoal: shoalIndex,
        x: lx,
        z: lz,
        y: gy - 0.1,
        rot: rng() * TAU,
        scale,
      });
    }
  }
  return blades;
}

function addKelpInstances(groups, blades, geo, mats, rng) {
  // one instanced mesh per shoal group (local coordinates differ)
  const perShoal = new Map();
  for (const b of blades) {
    if (!perShoal.has(b.shoal)) perShoal.set(b.shoal, []);
    perShoal.get(b.shoal).push(b);
  }
  const dummy = new THREE.Object3D();
  const tint = new THREE.Color();
  for (const [shoalIndex, list] of perShoal) {
    const mesh = new THREE.InstancedMesh(geo, mats.kelp, list.length);
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      dummy.position.set(b.x, b.y, b.z);
      dummy.rotation.set(0, b.rot, 0);
      dummy.scale.set(1, b.scale, 1);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      tint.copy(PAL.kelp[Math.floor(rng() * PAL.kelp.length)]);
      tint.multiplyScalar(0.8 + 0.35 * rng());
      mesh.setColorAt(i, tint);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    groups[shoalIndex].add(mesh);
  }
}

// -----------------------------------------------------------------------------
// Fish schools
// -----------------------------------------------------------------------------
function fishGeometry() {
  // a 5 triangle stylised fish, nose pointing +X, ~1 unit long
  const pos = [
    // body front pyramid
    0.55, 0, 0, 0.05, 0.13, 0, 0.05, 0, 0.09,
    0.55, 0, 0, 0.05, 0, 0.09, 0.05, -0.13, 0,
    0.55, 0, 0, 0.05, -0.13, 0, 0.05, 0, -0.09,
    0.55, 0, 0, 0.05, 0, -0.09, 0.05, 0.13, 0,
    // tail
    -0.36, 0, 0, -0.62, 0.17, 0, -0.62, -0.17, 0,
  ];
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  geo.name = 'reef-fish';
  return geo;
}

function createFishSchools(seabed, rng) {
  const schools = [
    { offset: [150, -235], radius: 19, count: 46, yLift: 2.3, speed: 0.17, phase: 0.4 },
    { offset: [-255, 190], radius: 16, count: 42, yLift: 2.1, speed: -0.14, phase: 2.6 },
    { offset: [-70, 385], radius: 22, count: 48, yLift: 2.5, speed: 0.11, phase: 4.4 },
  ];
  const def = seabed.def;
  const fish = [];
  for (let s = 0; s < schools.length; s++) {
    const sc = schools[s];
    // keep the school inside the lagoon and away from the very shallow centre
    const e = Math.max(0.42, Math.min(0.8, Math.hypot(sc.offset[0] / def.rx, sc.offset[1] / def.rz)));
    const cx = sc.offset[0];
    const cz = sc.offset[1];
    const ground = seabed.height(cx, cz);
    // fish stay comfortably below the surface and above the seabed
    const yCenter = clamp(ground + sc.yLift, -6.2, -3.4);
    sc.cx = cx;
    sc.cz = cz;
    sc.y = yCenter;
    sc.shoal = seabed;
    sc.fishStart = fish.length;
    sc.e = e;
    for (let i = 0; i < sc.count; i++) {
      fish.push({
        angle: (i / sc.count) * TAU + rng() * 0.16,
        rScale: 0.72 + rng() * 0.5,
        yOff: rng.range(-1.1, 1.1),
        phase: rng() * TAU,
        size: rng.range(0.45, 0.82),
      });
    }
  }
  return { schools, fish };
}

function addFishInstances(group, data, mats, rng) {
  const { schools, fish } = data;
  const mesh = new THREE.InstancedMesh(fishGeometry(), mats.fish, fish.length);
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  const tint = new THREE.Color();
  for (let i = 0; i < fish.length; i++) {
    tint.copy(PAL.fish[Math.floor(rng() * PAL.fish.length)]);
    tint.multiplyScalar(0.9 + 0.2 * rng());
    mesh.setColorAt(i, tint);
  }
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  group.add(mesh);
  return { mesh, schools, fish, dummy: new THREE.Object3D() };
}

function updateFish(data, time) {
  const { mesh, schools, fish, dummy } = data;
  for (let s = 0; s < schools.length; s++) {
    const sc = schools[s];
    const baseAngle = time * sc.speed + sc.phase;
    for (let i = 0; i < sc.count; i++) {
      const f = fish[sc.fishStart + i];
      const ang = baseAngle + f.angle;
      const rr = sc.radius * f.rScale;
      const x = sc.cx + Math.cos(ang) * rr + Math.sin(time * 0.7 + f.phase) * 1.1;
      const z = sc.cz + Math.sin(ang) * rr * 1.08 + Math.cos(time * 0.6 + f.phase) * 1.1;
      const y = sc.y + Math.sin(time * 0.9 + f.phase) * 0.9 + f.yOff;
      // orient along the tangent of the circle
      const dx = -Math.sin(ang) * Math.sign(sc.speed || 1);
      const dz = Math.cos(ang) * Math.sign(sc.speed || 1);
      const yaw = Math.atan2(-dz, dx);
      dummy.position.set(x, y, z);
      dummy.rotation.set(0, yaw, Math.sin(time * 1.4 + f.phase) * 0.22);
      dummy.scale.setScalar(f.size);
      dummy.updateMatrix();
      mesh.setMatrixAt(sc.fishStart + i, dummy.matrix);
    }
  }
  mesh.instanceMatrix.needsUpdate = true;
}

// -----------------------------------------------------------------------------
// Caustic shimmer rings on the lagoon seabed
// -----------------------------------------------------------------------------
function createCaustics(seabed, mats, rng) {
  const def = seabed.def;
  const group = new THREE.Group();
  const rings = [];
  for (let i = 0; i < 7; i++) {
    const a = rng() * TAU;
    const e = rng.range(0.12, 0.78);
    const lx = Math.cos(a) * e * def.rx;
    const lz = Math.sin(a) * e * def.rz;
    const y = seabed.height(lx, lz);
    const geo = new THREE.RingGeometry(0.55, 1.0, 26, 1);
    geo.rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(geo, mats.caustic);
    mesh.position.set(lx, y + 0.55, lz);
    const baseScale = rng.range(14, 30);
    mesh.scale.set(baseScale, 1, baseScale * rng.range(0.7, 1.1));
    mesh.frustumCulled = false;
    mesh.renderOrder = 1;
    group.add(mesh);
    rings.push({ mesh, baseScale, phase: rng() * TAU, speed: rng.range(0.03, 0.08), rotSpeed: rng.range(-0.05, 0.05) });
  }
  return { group, rings };
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------
export function createReef() {
  const root = new THREE.Group();
  root.name = 'reef';
  const mats = createReefMaterials();
  const rng = makeRng(20261022);
  const rngCoral = makeRng(5521);
  const rngKelp = makeRng(8813);
  const rngFish = makeRng(3357);
  const rngCaustic = makeRng(6691);
  const specList = createShoalSpecs();

  const shoalGroups = [];
  const seabeds = [];
  let fishData = null;
  let causticData = null;
  let foamMesh = null;
  const kelpBlades = [];
  const coralTemplates = [
    branchingTemplate(makeRng(311), { height: 2.9, radius: 0.16 }),
    branchingTemplate(makeRng(712), { height: 3.3, radius: 0.13 }),
    fanTemplate(makeRng(913)),
    brainTemplate(makeRng(1147)),
  ];
  // scale the templates so heads read from the air (roughly 1.5-4 m tall)
  const coralUpscale = [1.15, 1.05, 1.35, 1.3];
  for (let i = 0; i < coralTemplates.length; i++) {
    coralTemplates[i].geo.scale(coralUpscale[i], coralUpscale[i], coralUpscale[i]);
    coralTemplates[i].height *= coralUpscale[i];
  }

  for (let i = 0; i < specList.length; i++) {
    const def = specList[i];
    const seabed = createSeabed(def);
    seabeds.push(seabed);
    const g = new THREE.Group();
    g.name = def.id;
    g.position.set(def.x, 0, def.z);

    const mesh = new THREE.Mesh(buildSeabedMesh(seabed), mats.seabed);
    mesh.frustumCulled = false;
    g.add(mesh);

    if (def.coral) {
      const placements = placeCoralClusters(seabed, rngCoral, coralTemplates.map((t) => t.height));
      addCoralInstances(g, placements, coralTemplates, mats, rngCoral);
      const rocks = buildRimRocks(seabed, mats, rng);
      g.add(rocks.group);
      foamMesh = rocks.foamMesh ?? foamMesh;
      fishData = addFishInstances(g, createFishSchools(seabed, rngFish), mats, rngFish);
      updateFish(fishData, 0);
      causticData = createCaustics(seabed, mats, rngCaustic);
      g.add(causticData.group);
    }

    shoalGroups.push(g);
    root.add(g);

    // collect kelp blades in shoal-local space (positions are shoal-local)
    const blades = placeKelp([def], [seabed], rngKelp);
    for (const b of blades) kelpBlades.push({ ...b, shoal: i, x: b.x, z: b.z });
  }

  // kelp: one shared blade geometry, instanced per shoal group
  const kelpGeo = kelpBladeGeometry();
  addKelpInstances(shoalGroups, kelpBlades, kelpGeo, mats, rngKelp);

  // stats
  let triangles = 0;
  root.traverse((o) => {
    if (!o.isMesh) return;
    const geo = o.geometry;
    if (!geo) return;
    const n = geo.index ? geo.index.count : geo.getAttribute('position').count;
    triangles += Math.floor(n / 3) * (o.isInstancedMesh ? o.count : 1);
  });
  root.userData.triangles = triangles;
  root.userData.shoals = specList.map((s) => ({ id: s.id, x: s.x, z: s.z, rx: s.rx, rz: s.rz }));

  return {
    group: root,
    update(time /*, dt */) {
      // kelp sway
      const shader = mats.kelp.userData.shader;
      if (shader) shader.uniforms.uTime.value = time;
      // fish circles
      if (fishData) updateFish(fishData, time);
      // gentle foam pulse around the emergent rocks
      if (foamMesh) mats.foam.opacity = 0.28 + 0.12 * Math.sin(time * 0.55 + 0.7);
      // slow caustic shimmer
      if (causticData) {
        mats.caustic.opacity = 0.075 + 0.03 * Math.sin(time * 0.4);
        for (const r of causticData.rings) {
          r.mesh.rotation.y = time * r.rotSpeed + r.phase;
          const s = r.baseScale * (1 + 0.07 * Math.sin(time * 0.33 + r.phase));
          r.mesh.scale.x = s;
          r.mesh.scale.z = s * 0.85;
        }
      }
    },
  };
}
