// =============================================================================
// islands.js â€?procedural island chain for the OceanSwarm ocean test range.
//
//   createIslands() -> { group, update(time, dt) }
//
// The returned group is already placed in WORLD coordinates (every island is a
// child group positioned at its LAYOUT location).
//
// Contents
//   * Near research island (LAYOUT.baseIsland): hand-shaped noise heightfield
//     with an irregular coastline, a carved low coastal bench/saddle where the
//     research base sits, layered strata-coloured rock cliffs, green hills that
//     peak at exactly LAYOUT.baseIsland.height (74 m), instanced low-poly trees,
//     merged shore rocks and animated surf ribbons.
//   * Two mid islands (LAYOUT.islands kind 'mid'): same generator, fewer rings,
//     simpler dark-green blob trees, haze-cooled palette.
//   * One far silhouette island (kind 'far') plus a second hazier ridge behind
//     it â€?very low triangle count, cool blue-grey colours, only readable as a
//     hazy mountain silhouette.
//
// Design notes
//   * Terrain is a polar grid in island-local space, displaced by a height
//     function that combines an angle-varying coastal bank, a handful of
//     ellipsoidal "massif" peaks modulated by ridge noise, and micro relief.
//     The mesh is emitted non-indexed with per-face vertex colours so the
//     low-poly facets read as stylised rock strata / grass patches.
//   * Island geometry is skirted down to about y = -12..-14 so no seam floats
//     above the water. Around the near island the ocean shader is translucent
//     inside the SHOALS shelf, so the shallow sea floor is coloured sandy and
//     fades to dark teal with depth.
//   * Every placement (trees / rocks / surf / sample helpers) goes through the
//     same deterministic height function, so nothing floats or sinks.
//
// Budget: ~100k triangles total (terrain ~72k, trees ~19k, rocks ~7k, surf ~2k).
// =============================================================================
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { COLORS, LAYOUT } from '../../config.js';
import { TAU, clamp, lerp, smoothstep, fbm2, ridgeNoise2, makeRng } from '../../core/geo.js';
import { makeToon } from '../../core/materials.js';

// -----------------------------------------------------------------------------
// Palette helpers
// -----------------------------------------------------------------------------
const c = (hex) => new THREE.Color(hex);

function makePalette(o) {
  return {
    rock: c(o.rock),
    rockLight: c(o.rockLight),
    rockDark: c(o.rockDark),
    rockCool: c(o.rockCool ?? o.rockDark),
    green: c(o.green),
    greenDark: c(o.greenDark),
    greenLight: c(o.greenLight ?? o.green),
    sand: c(o.sand),
    sandWet: c(o.sandWet),
    seabed: c(o.seabed),
    seabedDeep: c(o.seabedDeep),
    foam: c(COLORS.foam),
    haze: c(COLORS.haze),
    hazeMix: o.hazeMix ?? 0,
    canopyTints: (o.canopyTints ?? []).map((h) => c(h)),
  };
}

const NEAR_PALETTE = makePalette({
  rock: COLORS.islandRock, // 0x8f9793
  rockLight: 0xb6bcb2,
  rockDark: COLORS.islandRockDark, // 0x5d696b
  rockCool: 0x74889a, // grey-blue seaward cliff faces
  green: COLORS.islandGreen, // 0x6f9e72
  greenDark: COLORS.islandGreenDark, // 0x487554
  greenLight: 0x93b884,
  sand: COLORS.sand, // 0xe8ddb9
  sandWet: COLORS.sandWet, // 0xcdbf9a
  seabed: 0xd8cfa6,
  seabedDeep: 0x2f6c74,
  hazeMix: 0.0,
  canopyTints: [0x6f9e72, 0x5f8d63, 0x82ac7b, 0x4d7a55, 0x7a9f6a],
});

const MID_PALETTE = makePalette({
  rock: 0x7b8b96,
  rockLight: 0x9dabb0,
  rockDark: 0x4b5f66,
  rockCool: 0x687f9a,
  green: 0x557f6f,
  greenDark: 0x3a5c52,
  greenLight: 0x74987f,
  sand: 0xe0d8ba,
  sandWet: 0xc4b796,
  seabed: 0xc4c9a5,
  seabedDeep: 0x2f5f6e,
  hazeMix: 0.26,
  canopyTints: [0x4b6f5a, 0x557a63, 0x3f6152, 0x5d8268],
});

const FAR_PALETTE = makePalette({
  rock: 0x64768a,
  rockLight: 0x9bafbf,
  rockDark: 0x435a70,
  rockCool: 0x7f95a8,
  green: 0x51707a,
  greenDark: 0x3d5a66,
  greenLight: 0x6d8b93,
  sand: 0xcfd3c4,
  sandWet: 0xb2b8ac,
  seabed: 0x7d8fa2,
  seabedDeep: 0x3b556d,
  hazeMix: 0.44,
});

// -----------------------------------------------------------------------------
// Island field: deterministic procedural height function
// -----------------------------------------------------------------------------
/** Radial ring positions (in coast-radius units): dense near the coastline. */
function ringRadii(spec) {
  const list = [];
  const land = spec.landRings;
  const sea = spec.seaRings;
  for (let i = 1; i <= land; i++) {
    const t = i / land;
    list.push(1 - Math.pow(1 - t, 1.6)); // dense near the coastline
  }
  const qMax = spec.qMax ?? 1.8;
  for (let i = 1; i <= sea; i++) {
    const t = i / sea;
    list.push(1 + Math.pow(t, 1.35) * (qMax - 1));
  }
  return list;
}

function createIslandField(spec) {
  const R = spec.radius;
  const rng = makeRng(spec.seed);
  const off = {
    o1: rng() * 91.7,
    o2: rng() * 91.7,
    o3: rng() * 91.7,
    o4: rng() * 91.7,
    o5: rng() * 91.7,
    o6: rng() * 91.7,
  };
  const peaks = spec.peaks ?? [];
  const sector = spec.coastSector ?? null;
  const cliffCalm = spec.cliffCalm ?? null;
  const bench = spec.bench ?? null;
  const benchOffA = rng() * 50;
  const benchOffB = rng() * 50;

  // --- coastline radius factor ------------------------------------------------
  const lobes = spec.coastLobes ?? [];
  function coastFactor(a) {
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    let f =
      1 +
      0.185 * fbm2(ca * 1.28 + off.o1, sa * 1.28 + off.o2, 3) +
      0.075 * fbm2(ca * 3.6 + off.o3, sa * 3.6 + off.o4, 2) +
      0.03 * fbm2(ca * 7.1 + off.o5, sa * 7.1 + off.o6, 2);
    // broad coastal lobes (e.g. the south-west headland next to the base bay)
    for (let i = 0; i < lobes.length; i++) {
      const lb = lobes[i];
      let d = a - lb.angle;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      f += lb.amp * Math.exp(-(d * d) / (2 * lb.width * lb.width));
    }
    if (sector) {
      // Shape a nearly straight shoreline section where the engineered apron
      // meets the sea, so the base agent can rely on a predictable waterline.
      const wgt = smoothstep(sector.a0, sector.a0 + 0.1, a) * (1 - smoothstep(sector.a1 - 0.12, sector.a1, a));
      if (wgt > 0.001) {
        const chord = clamp(sector.shoreZ / (R * Math.max(0.5, Math.abs(sa))), 0.9, 1.22);
        const jitter = 0.03 * fbm2(ca * 4.4 + off.o5, sa * 4.4 + off.o6, 2);
        f = lerp(f, chord + jitter, wgt);
      }
    }
    return f;
  }

  function calmWeight(a) {
    const cc = spec.cliffCalm;
    if (!cc) return 0;
    return smoothstep(cc.a0, cc.a0 + 0.13, a) * (1 - smoothstep(cc.a1 - 0.13, cc.a1, a));
  }

  function peakField(lx, lz) {
    let m = 0;
    for (let i = 0; i < peaks.length; i++) {
      const p = peaks[i];
      let dx = lx - p.x;
      let dz = lz - p.z;
      if (p.rot) {
        const cr = Math.cos(p.rot);
        const sr = Math.sin(p.rot);
        const rx = dx * cr + dz * sr;
        dz = -dx * sr + dz * cr;
        dx = rx;
      }
      dx /= p.rx;
      dz /= p.rz;
      m += p.amp * Math.exp(-(dx * dx + dz * dz) * (p.sharp ?? 1.15));
    }
    return m;
  }

  // --- raw (unnormalised) height ---------------------------------------------
  function natural(lx, lz) {
    const x = lx / R;
    const z = lz / R;
    const r = Math.hypot(x, z);
    const a = Math.atan2(z, x);
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const q = r / coastFactor(a);

    // coastal character: cliffs vs. beach pockets, varied around the island
    const nc = fbm2(ca * 2.35 + off.o3, sa * 2.35 + off.o4, 2);
    const seaward = clamp(sa, 0, 1);
    let cliff = clamp(0.42 + 0.58 * nc + 0.14 * seaward, 0, 1);
    if (cliffCalm) cliff = clamp(cliff - 0.66 * calmWeight(a), 0.05, 1);

    if (q >= 1) {
      // ---- sea floor: shallow sandy shelf dropping into deep water ----------
      const d = q - 1;
      const shelfDrop = 2.6 * smoothstep(0, 0.045, d);
      const deepT = Math.pow(clamp(d / 0.85, 0, 1), 0.95);
      const deep = deepT * spec.depth * (0.78 + 0.45 * cliff);
      let y = -shelfDrop - deep;
      const rockN = fbm2(x * 8.0 + off.o5, z * 8.0 + off.o6, 3);
      y += rockN * (0.9 + 2.1 * smoothstep(0.012, 0.12, d));
      // guarantee the shelf sits under the waterline once past the very beach
      return Math.min(y, -0.4 - 2.2 * smoothstep(0, 0.03, d));
    }

    // ---- land ----------------------------------------------------------------
    const u = 1 - q; // 0 at the coast, 1 in the middle
    const bankW = lerp(0.30, 0.045, cliff);
    const bankH = lerp(3.6, 28.0, cliff);
    let h = bankH * smoothstep(0, bankW, u);

    // island massif: a few broad ellipsoidal hills cut by ridge noise
    const massif = peakField(lx, lz);
    const ridge = 0.56 + 0.64 * ridgeNoise2(x * 3.0 + off.o1, z * 3.0 + off.o2, 4);
    h += massif * ridge;
    h += spec.uplift * smoothstep(0, 0.55, u);

    // micro relief: rocky inland, smooth immediately behind the waterline
    const relief = smoothstep(0.015, 0.14, u);
    const rugged = 0.35 + 0.95 * cliff;
    h += fbm2(x * 9.0 + off.o5, z * 9.0 + off.o6, 3) * (0.45 + 2.7 * relief) * rugged;
    h += fbm2(x * 21.0 + off.o2, z * 21.0 + off.o1, 3) * 0.55 * relief;
    return h;
  }

  // --- normalise so the highest hill reaches exactly spec.height --------------
  let maxRaw = 0.0001;
  let maxX = 0;
  let maxZ = 0;
  const N = spec.normGrid ?? 120;
  for (let i = 0; i <= N; i++) {
    for (let j = 0; j <= N; j++) {
      const x = ((i / N) * 2 - 1) * 0.97;
      const z = ((j / N) * 2 - 1) * 0.97;
      const lx = x * R;
      const lz = z * R;
      if (Math.hypot(x, z) / coastFactor(Math.atan2(z, x)) >= 0.995) continue;
      const h = natural(lx, lz);
      if (h > maxRaw) {
        maxRaw = h;
        maxX = lx;
        maxZ = lz;
      }
    }
  }
  // local refinement around the first maximum (1 m steps)
  for (let i = -45; i <= 45; i += 2) {
    for (let j = -45; j <= 45; j += 2) {
      const lx = maxX + i;
      const lz = maxZ + j;
      if (Math.hypot(lx / R, lz / R) / coastFactor(Math.atan2(lz / R, lx / R)) >= 1) continue;
      const h = natural(lx, lz);
      if (h > maxRaw) {
        maxRaw = h;
        maxX = lx;
        maxZ = lz;
      }
    }
  }
  const norm = spec.height / maxRaw;

  // un-scaled rendered height: normalised natural terrain + carved bench
  function heightRaw(lx, lz) {
    let h = natural(lx, lz) * norm;
    if (bench) {
      const dx = lx - bench.x;
      const dz = lz - bench.z;
      const dist = Math.hypot(dx, dz);
      let w = 1 - smoothstep(bench.fadeStart, bench.fadeEnd, dist);
      if (w > 0.0005) {
        // never lift the sea floor; keep the terrace edge close to the beach
        w *= smoothstep(-1.2, 1.8, h);
      }
      if (w > 0.0005) {
        const target =
          bench.height +
          0.6 * fbm2(lx * 0.02 + benchOffA, lz * 0.02 + benchOffB, 2) +
          bench.rise * smoothstep(bench.riseStart, bench.riseEnd, dist) -
          bench.seaDrop * smoothstep(bench.dropStart, bench.dropEnd, dz);
        h = lerp(h, target, w);
      }
    }
    return h;
  }

  // Scale the field so the highest *rendered* vertex hits spec.height exactly.
  // Sampling the same ring vertices as the mesh means heightAt() is the literal
  // terrain height, which is what other builders sample for placement/blending.
  let meshMax = 0.0001;
  const qs = ringRadii(spec);
  const ang = spec.angular;
  for (let ri = 0; ri < qs.length; ri++) {
    const q = qs[ri];
    for (let ai = 0; ai < ang; ai++) {
      const a = (ai / ang) * TAU;
      const r = q * coastFactor(a) * R;
      const h = heightRaw(Math.cos(a) * r, Math.sin(a) * r);
      if (h > meshMax) meshMax = h;
    }
  }
  const centreH = heightRaw(0, 0);
  if (centreH > meshMax) meshMax = centreH;
  const yScale = spec.height / meshMax;

  /** Exact rendered terrain height at island-local (lx, lz). */
  function heightAt(lx, lz) {
    return heightRaw(lx, lz) * yScale;
  }

  // --- helpers exposed to the builders ---------------------------------------
  function waterlineRadius(a) {
    // bisection on the coastline factor along this bearing
    let lo = 0.55;
    let hi = 1.25;
    for (let i = 0; i < 22; i++) {
      const mid = (lo + hi) * 0.5;
      const rr = mid * coastFactor(a) * R;
      const h = heightAt(Math.cos(a) * rr, Math.sin(a) * rr);
      if (h > 0) lo = mid;
      else hi = mid;
    }
    return ((lo + hi) * 0.5) * coastFactor(a) * R;
  }

  return {
    spec,
    off,
    coastFactor,
    natural,
    heightRaw,
    heightAt,
    waterlineRadius,
    peakPos: { x: maxX, z: maxZ },
    yScale,
  };
}

// -----------------------------------------------------------------------------
// Face colouring â€?per-triangle flat colours baked into vertex colours
// -----------------------------------------------------------------------------
const _mixRock = new THREE.Color();

function faceColor(out, lx, lz, y, ny, field) {
  const spec = field.spec;
  const pal = spec.palette;
  const o = field.off;
  const x = lx / spec.radius;
  const z = lz / spec.radius;
  const n1 = fbm2(x * 3.1 + o.o1, z * 3.1 + o.o2, 3);
  const n2 = fbm2(x * 14.0 + o.o3, z * 14.0 + o.o4, 2);
  const n3 = fbm2(x * 1.3 + o.o5, z * 1.3 + o.o6, 2);
  const slope = 1 - ny;

  if (spec.style === 'silhouette') {
    // distant ridge: vertical gradient only, pre-cooled into the haze
    const t = clamp(y / spec.height, 0, 1);
    out.copy(pal.rockDark).lerp(pal.rockLight, smoothstep(0.04, 0.82, t + 0.14 * n1 + 0.06 * n2));
    out.lerp(pal.haze, clamp(pal.hazeMix + 0.12 * (1 - t), 0, 0.75));
    return;
  }

  if (y < 0.25) {
    // ---- intertidal / submerged sea floor ------------------------------------
    const depth = -y;
    const t = smoothstep(0.0, 8.5, depth);
    out.copy(pal.seabed).lerp(pal.seabedDeep, t);
    // dark rock ledges / seagrass mottling on steeper sea floor
    const rocky = smoothstep(0.5, 0.78, slope + 0.16 * n2);
    _mixRock.copy(pal.rockDark).lerp(pal.rockCool, 0.35 + 0.3 * n1);
    out.lerp(_mixRock, rocky * 0.55);
    // wet sand right below the waterline
    out.lerp(pal.sandWet, (1 - smoothstep(0.0, 1.8, depth)) * 0.45);
    // a little broken foam speckle at the waterline
    const foamBand = smoothstep(-0.45, 0.0, y) * (1 - smoothstep(0.0, 0.7, y));
    if (n2 > 0.05) out.lerp(pal.foam, foamBand * 0.4);
    if (pal.hazeMix) out.lerp(pal.haze, pal.hazeMix * 0.75);
    return;
  }

  // ---- land -------------------------------------------------------------------
  // rock where the face is steep; grass where it is flat
  const rocky = smoothstep(0.13, 0.34, slope + 0.11 * n1 + 0.06 * n2);
  // layered strata: light / dark bands every ~6 m of elevation
  const band = 0.5 + 0.5 * Math.sin(y * 0.95 + n1 * 4.2 + n3 * 2.0);
  _mixRock.copy(pal.rockDark).lerp(pal.rockLight, clamp(band * 0.92 + n2 * 0.2, 0, 1));
  // seaward faces are a cooler grey-blue
  const seaward = clamp(0.5 + 0.5 * (lz / Math.max(1, Math.hypot(lx, lz))), 0, 1);
  _mixRock.lerp(pal.rockCool, seaward * 0.4);

  // grass cover
  out.copy(pal.greenDark).lerp(pal.green, clamp(0.5 + 0.45 * n1 + 0.25 * n2, 0, 1));
  out.lerp(pal.greenLight, clamp(0.2 + 0.6 * n2, 0, 1) * 0.35);
  out.lerp(_mixRock, rocky);

  // low sandy beach + wet band near the waterline
  const beachW = (1 - smoothstep(2.4, 4.6, y)) * (1 - smoothstep(0.16, 0.36, slope));
  out.lerp(pal.sand, beachW * 0.92);
  const wetW = (1 - smoothstep(0.35, 1.7, y)) * (1 - smoothstep(0.26, 0.5, slope));
  out.lerp(pal.sandWet, wetW * 0.55);
  // soft foam line right at the waterline
  const foamBand = smoothstep(0.0, 0.22, y) * (1 - smoothstep(0.22, 1.1, y));
  out.lerp(pal.foam, foamBand * (0.22 + 0.2 * n2) * (0.4 + 0.6 * (1 - smoothstep(0.2, 0.4, slope))));

  if (pal.hazeMix) out.lerp(pal.haze, pal.hazeMix);
}

// -----------------------------------------------------------------------------
// Terrain mesh construction (non-indexed, flat shaded, per-face colours)
// -----------------------------------------------------------------------------
function buildTerrain(spec) {
  const field = spec.field;
  const R = spec.radius;
  const ang = spec.angular;
  const qs = ringRadii(spec);
  const rings = [];
  for (let ri = 0; ri < qs.length; ri++) {
    const q = qs[ri];
    const pts = [];
    for (let ai = 0; ai < ang; ai++) {
      const a = (ai / ang) * TAU;
      const r = q * field.coastFactor(a) * R;
      const lx = Math.cos(a) * r;
      const lz = Math.sin(a) * r;
      pts.push([lx, field.heightAt(lx, lz), lz]);
    }
    rings.push(pts);
  }

  // --- triangle soup (heights already include the exact peak normalisation) --
  const soup = [];
  const pushTri = (a, b, cc) => {
    soup.push(a[0], a[1], a[2], b[0], b[1], b[2], cc[0], cc[1], cc[2]);
  };
  // centre cap
  const centre = [0, field.heightAt(0, 0), 0];
  for (let ai = 0; ai < ang; ai++) {
    pushTri(centre, rings[0][ai], rings[0][(ai + 1) % ang]);
  }
  // grid
  for (let ri = 0; ri < rings.length - 1; ri++) {
    const inner = rings[ri];
    const outer = rings[ri + 1];
    for (let ai = 0; ai < ang; ai++) {
      const an = (ai + 1) % ang;
      pushTri(inner[ai], outer[ai], inner[an]);
      pushTri(inner[an], outer[ai], outer[an]);
    }
  }

  // --- fix winding (heightfields must face up), then colour -----------------
  const pos = new Float32Array(soup);
  const triCount = pos.length / 9;
  for (let t = 0; t < triCount; t++) {
    const o = t * 9;
    const ux = pos[o + 3] - pos[o];
    const uy = pos[o + 4] - pos[o + 1];
    const uz = pos[o + 5] - pos[o + 2];
    const vx = pos[o + 6] - pos[o];
    const vy = pos[o + 7] - pos[o + 1];
    const vz = pos[o + 8] - pos[o + 2];
    // n.y of (u x v)
    const ny = uz * vx - ux * vz;
    if (ny < 0) {
      // swap vertices 1 and 2
      for (let k = 0; k < 3; k++) {
        const s1 = o + 3 + k;
        const s2 = o + 6 + k;
        const tmp = pos[s1];
        pos[s1] = pos[s2];
        pos[s2] = tmp;
      }
    }
  }

  const colors = new Float32Array(triCount * 9);
  const tmpC = new THREE.Color();
  const A = new THREE.Vector3();
  const B = new THREE.Vector3();
  const C = new THREE.Vector3();
  const Nrm = new THREE.Vector3();
  for (let t = 0; t < triCount; t++) {
    const o = t * 9;
    A.set(pos[o], pos[o + 1], pos[o + 2]);
    B.set(pos[o + 3], pos[o + 4], pos[o + 5]);
    C.set(pos[o + 6], pos[o + 7], pos[o + 8]);
    B.sub(A);
    C.sub(A);
    Nrm.crossVectors(B, C).normalize();
    const cy = (pos[o + 1] + pos[o + 4] + pos[o + 7]) / 3;
    const cxl = (pos[o] + pos[o + 3] + pos[o + 6]) / 3;
    const czl = (pos[o + 2] + pos[o + 5] + pos[o + 8]) / 3;
    faceColor(tmpC, cxl, czl, cy, Math.abs(Nrm.y), field);
    for (let k = 0; k < 9; k += 3) {
      colors[o + k] = tmpC.r;
      colors[o + k + 1] = tmpC.g;
      colors[o + k + 2] = tmpC.b;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  return geo;
}

// -----------------------------------------------------------------------------
// Materials (shared by all islands)
// -----------------------------------------------------------------------------
function createIslandMaterials() {
  const terrain = makeToon(0xffffff, { rim: 0.0 });
  terrain.vertexColors = true;
  terrain.needsUpdate = true;

  const veg = makeToon(0xffffff, { rim: 0.1 });
  veg.vertexColors = true; // baked trunk browns + neutral canopy shading
  veg.needsUpdate = true;

  const rock = makeToon(0xffffff, { rim: 0.07 });
  rock.vertexColors = true;
  rock.needsUpdate = true;

  const surf = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.32,
    depthWrite: false,
    fog: true,
    side: THREE.DoubleSide,
    toneMapped: true,
  });

  return { terrain, veg, rock, surf };
}

// -----------------------------------------------------------------------------
// Geometry helpers for props
// -----------------------------------------------------------------------------
function asNonIndexed(geo) {
  if (!geo.index) return geo;
  const out = geo.toNonIndexed();
  geo.dispose();
  return out;
}

/** Bake one flat colour per triangle from a callback, return flat-shaded geo. */
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

/** A noisy, squashed boulder. Indexed geometry displaced by direction noise. */
function boulderGeometry(rng, radius, segments = 8, rings = 6, squash = 0.72) {
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

function rockColorFn(pal, wet) {
  const wetCol = new THREE.Color(0x2c3c42);
  return (out, cx, cy, cz) => {
    const n = fbm2(cx * 0.09 + 11.3, cz * 0.09 + 7.7, 2) * 0.5 + 0.5;
    const n2 = fbm2(cx * 0.3 + 3.1, cz * 0.3 + 9.2, 2) * 0.5 + 0.5;
    out.copy(pal.rockDark).lerp(pal.rock, clamp(n * 0.9 + 0.1, 0, 1));
    out.lerp(pal.rockCool, n2 * 0.25);
    const wetT = 1 - smoothstep(wet.y0, wet.y1, cy);
    out.lerp(wetCol, wetT * (0.5 + 0.3 * n2));
    // a little algae on the low band
    out.lerp(pal.greenDark, wetT * 0.22 * n2);
    // lighter dry tops catch the sun
    out.lerp(pal.rockLight, smoothstep(wet.y1 + 1.2, wet.y1 + 5.0, cy) * 0.28);
  };
}

// -----------------------------------------------------------------------------
// Trees
// -----------------------------------------------------------------------------
function buildTreeGeometries() {
  const variants = [];

  // ---- 0: broadleaf, thin trunk + 3 clustered canopy blobs -----------------
  {
    const trunk = new THREE.CylinderGeometry(0.2, 0.42, 4.4, 5, 1, true);
    trunk.translate(0, 1.3, 0);
    const blades = [];
    const blobs = [
      [2.7, 2.2, 2.5, 0.0, 5.5, 0.0],
      [1.8, 1.6, 1.8, 1.3, 6.5, 0.6],
      [1.7, 1.5, 1.8, -1.2, 6.1, -0.5],
    ];
    for (const b of blobs) {
      const g = new THREE.IcosahedronGeometry(1, 0);
      g.scale(b[0], b[1], b[2]);
      g.translate(b[3], b[4], b[5]);
      blades.push(asNonIndexed(g));
    }
    const canopy = mergeGeometries(blades, false);
    blades.forEach((g) => g.dispose());
    variants.push({ trunk, canopy });
  }

  // ---- 1: stylised pine, stacked cones -------------------------------------
  {
    const trunk = new THREE.CylinderGeometry(0.16, 0.34, 4.0, 5, 1, true);
    trunk.translate(0, 1.1, 0);
    const cones = [
      [2.6, 4.6, 4.4],
      [1.9, 3.4, 7.0],
      [1.15, 2.4, 9.2],
    ];
    const parts = [];
    for (const [r, h, y] of cones) {
      const g = new THREE.ConeGeometry(r, h, 6, 1, false);
      g.translate(0, y, 0);
      parts.push(asNonIndexed(g));
    }
    const canopy = mergeGeometries(parts, false);
    parts.forEach((g) => g.dispose());
    variants.push({ trunk, canopy });
  }

  // ---- 2: slim tropical, tall trunk + 4 flattened fronds -------------------
  {
    const trunk = new THREE.CylinderGeometry(0.17, 0.38, 6.2, 5, 1, true);
    trunk.rotateZ(0.1);
    trunk.translate(0, 2.3, 0);
    const fronds = [];
    for (let i = 0; i < 4; i++) {
      const g = new THREE.IcosahedronGeometry(1, 0);
      g.scale(2.5, 0.6, 1.0);
      g.rotateX(0.3);
      g.rotateY((i / 4) * TAU + 0.3);
      g.translate(Math.cos((i / 4) * TAU) * 1.5, 5.6 + (i % 2) * 0.5, Math.sin((i / 4) * TAU) * 1.5);
      fronds.push(asNonIndexed(g));
    }
    const canopy = mergeGeometries(fronds, false);
    fronds.forEach((g) => g.dispose());
    variants.push({ trunk, canopy });
  }

  // bake colours: brown trunks, neutral (near-white) canopy shading so that the
  // per-instance colour tint defines the foliage hue
  for (const v of variants) {
    v.trunk = flatColorFaces(v.trunk, (out, cx, cy, cz) => {
      const t = clamp((cy + 1) / 5, 0, 1);
      out.setRGB(0.34, 0.27, 0.2).multiplyScalar(0.62 + 0.5 * t);
    });
    v.canopy = flatColorFaces(v.canopy, (out, cx, cy, cz) => {
      const s = 0.78 + 0.26 * (0.5 + 0.5 * Math.sin(cx * 1.9 + cy * 2.7 + cz * 1.3));
      out.setRGB(s, s, s);
    });
  }
  return variants;
}

function placeTrees(spec, rng) {
  const field = spec.field;
  const target = spec.treeTarget;
  const out = [];
  if (!target) return out;
  const minDist = spec.treeSpacing;
  const cell = Math.max(minDist, 4);
  const grid = new Map();
  const key = (cx, cz) => `${cx},${cz}`;
  const nearby = (x, z) => {
    const cx = Math.floor(x / cell);
    const cz = Math.floor(z / cell);
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        const arr = grid.get(key(cx + i, cz + j));
        if (!arr) continue;
        for (let k = 0; k < arr.length; k++) {
          const dx = arr[k][0] - x;
          const dz = arr[k][1] - z;
          if (dx * dx + dz * dz < minDist * minDist) return true;
        }
      }
    }
    return false;
  };
  const weights = spec.variantWeights ?? [0.45, 0.35, 0.2];
  const exclusions = spec.exclusions ?? [];
  let attempts = 0;
  while (out.length < target && attempts < target * 120) {
    attempts++;
    const a = rng() * TAU;
    const gn = Math.sqrt(rng());
    const r = gn * field.coastFactor(a) * spec.radius * 0.94;
    const lx = Math.cos(a) * r;
    const lz = Math.sin(a) * r;
    let blocked = false;
    for (let e = 0; e < exclusions.length; e++) {
      const ex = exclusions[e];
      const dx = lx - ex.x;
      const dz = lz - ex.z;
      if (dx * dx + dz * dz < ex.r * ex.r) {
        blocked = true;
        break;
      }
    }
    if (blocked) continue;
    // density roll before the (relatively costly) terrain sampling
    const q = r / (field.coastFactor(a) * spec.radius);
    const density = 0.3 + 0.7 * smoothstep(0.88, 0.3, q);
    if (rng() > density) continue;
    const y = field.heightAt(lx, lz);
    if (y < spec.treeMinHeight) continue;
    if (nearby(lx, lz)) continue;
    // reject steep ground
    const gx = (field.heightAt(lx + 3, lz) - field.heightAt(lx - 3, lz)) / 6;
    const gz = (field.heightAt(lx, lz + 3) - field.heightAt(lx, lz - 3)) / 6;
    if (Math.hypot(gx, gz) > 0.62) continue;
    // variant choice
    let variant = 0;
    let roll = rng();
    let acc = 0;
    for (let w = 0; w < weights.length; w++) {
      acc += weights[w];
      if (roll <= acc) {
        variant = w;
        break;
      }
    }
    const scale = rng.range(spec.treeScale[0], spec.treeScale[1]);
    out.push({ x: lx, z: lz, y, rot: rng() * TAU, scale, variant });
    const cx = Math.floor(lx / cell);
    const cz = Math.floor(lz / cell);
    const k = key(cx, cz);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push([lx, lz]);
  }
  return out;
}

function addTreeInstances(group, placements, geomVariants, mats, palette, rng) {
  if (!placements.length) return;
  const byVariant = new Map();
  for (const p of placements) {
    if (!byVariant.has(p.variant)) byVariant.set(p.variant, []);
    byVariant.get(p.variant).push(p);
  }
  const dummy = new THREE.Object3D();
  const tint = new THREE.Color();
  for (const [variant, list] of byVariant) {
    const geoms = geomVariants[variant % geomVariants.length];
    const trunks = new THREE.InstancedMesh(geoms.trunk, mats.veg, list.length);
    const canopies = new THREE.InstancedMesh(geoms.canopy, mats.veg, list.length);
    trunks.frustumCulled = false;
    canopies.frustumCulled = false;
    trunks.castShadow = false;
    canopies.castShadow = false;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      dummy.position.set(p.x, p.y, p.z);
      dummy.rotation.set(0, p.rot, 0);
      dummy.scale.setScalar(p.scale);
      dummy.updateMatrix();
      trunks.setMatrixAt(i, dummy.matrix);
      canopies.setMatrixAt(i, dummy.matrix);
      if (palette.canopyTints.length) {
        tint.copy(palette.canopyTints[(i + variant) % palette.canopyTints.length]);
        tint.multiplyScalar(0.85 + 0.3 * rng());
        canopies.setColorAt(i, tint);
      }
    }
    trunks.instanceMatrix.needsUpdate = true;
    canopies.instanceMatrix.needsUpdate = true;
    if (canopies.instanceColor) canopies.instanceColor.needsUpdate = true;
    group.add(trunks, canopies);
  }
}

// -----------------------------------------------------------------------------
// Shore rocks (merged, vertex-coloured, partially submerged at the waterline)
// -----------------------------------------------------------------------------
function addShoreRocks(group, spec, mats, rng) {
  const field = spec.field;
  const R = spec.radius;
  const count = spec.rockCount ?? 0;
  if (!count) return;
  const pal = spec.palette;
  const pieces = [];
  const matrix = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const euler = new THREE.Euler();
  const scaleV = new THREE.Vector3();
  const posV = new THREE.Vector3();
  const exclusions = spec.exclusions ?? [];
  let made = 0;
  let attempts = 0;
  const colorFn = rockColorFn(pal, { y0: -1.2, y1: 1.4 });
  while (made < count && attempts < count * 14) {
    attempts++;
    const a = rng() * TAU;
    const wl = field.waterlineRadius(a);
    // 62% along the waterline, 38% boulders scattered inland / on the shelf
    let r;
    let isShore = rng() < 0.62;
    if (isShore) r = wl * rng.range(0.93, 1.16);
    else r = wl * rng.range(0.35, 0.92);
    const lx = Math.cos(a) * r;
    const lz = Math.sin(a) * r;
    let blocked = false;
    for (let e = 0; e < exclusions.length; e++) {
      const ex = exclusions[e];
      const dx = lx - ex.x;
      const dz = lz - ex.z;
      if (dx * dx + dz * dz < ex.r * ex.r) {
        blocked = true;
        break;
      }
    }
    if (blocked) continue;
    const y = field.heightAt(lx, lz);
    if (y < -5.5) continue;
    const size = isShore ? 1.3 + Math.pow(rng(), 1.6) * 8.5 : 0.9 + Math.pow(rng(), 2.0) * 5.0;
    const geo = boulderGeometry(rng, size, isShore ? 7 : 6, isShore ? 5 : 4, 0.62 + rng() * 0.28);
    euler.set(rng.range(-0.16, 0.16), rng() * TAU, rng.range(-0.16, 0.16));
    quat.setFromEuler(euler);
    scaleV.set(1, 0.7 + rng() * 0.55, 1);
    posV.set(lx, y - size * 0.32, lz);
    matrix.compose(posV, quat, scaleV);
    geo.applyMatrix4(matrix);
    pieces.push(flatColorFaces(geo, colorFn));
    made++;
    // occasional cluster companion
    if (rng() < 0.24) {
      const companion = boulderGeometry(rng, size * rng.range(0.35, 0.62), 6, 4, 0.7);
      posV.set(lx + rng.range(-size * 1.4, size * 1.4), y - size * 0.25, lz + rng.range(-size * 1.4, size * 1.4));
      matrix.compose(posV, quat, scaleV);
      companion.applyMatrix4(matrix);
      pieces.push(flatColorFaces(companion, colorFn));
      made++;
    }
  }
  if (!pieces.length) return;
  const merged = mergeGeometries(pieces, false);
  pieces.forEach((g) => g.dispose());
  if (!merged) return;
  const mesh = new THREE.Mesh(merged, mats.rock);
  mesh.castShadow = false;
  group.add(mesh);
}

function addHillOutcrops(group, spec, mats, rng) {
  const field = spec.field;
  const R = spec.radius;
  const count = spec.outcropCount ?? 0;
  if (!count) return;
  const pal = spec.palette;
  const pieces = [];
  const matrix = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const euler = new THREE.Euler();
  const scaleV = new THREE.Vector3();
  const posV = new THREE.Vector3();
  const exclusions = spec.exclusions ?? [];
  const colorFn = rockColorFn(pal, { y0: 0.2, y1: 2.8 });
  let made = 0;
  let attempts = 0;
  while (made < count && attempts < count * 40) {
    attempts++;
    // bias outcrops into the quadrant seen from the fleet / open sea
    const a = rng() < 0.62 ? rng.range(0.75, 3.5) : rng() * TAU;
    const r = Math.sqrt(rng()) * field.coastFactor(a) * R * 0.92;
    const lx = Math.cos(a) * r;
    const lz = Math.sin(a) * r;
    let blocked = false;
    for (let e = 0; e < exclusions.length; e++) {
      const ex = exclusions[e];
      const dx = lx - ex.x;
      const dz = lz - ex.z;
      if (dx * dx + dz * dz < ex.r * ex.r) {
        blocked = true;
        break;
      }
    }
    if (blocked) continue;
    const y = field.heightAt(lx, lz);
    if (y < -0.5) continue;
    const gx = (field.heightAt(lx + 4, lz) - field.heightAt(lx - 4, lz)) / 8;
    const gz = (field.heightAt(lx, lz + 4) - field.heightAt(lx, lz - 4)) / 8;
    const grad = Math.hypot(gx, gz);
    // rocky outcrops cling to steep ground; a few larger sea stacks sit at the
    // waterline so the coast reads as layered rock from a distance
    const shoreStack = y < 7 && grad > 0.42 && rng() < 0.55;
    if (grad < 0.4 && !shoreStack) continue;
    const size = shoreStack ? 5.0 + Math.pow(rng(), 1.3) * 9.0 : 3.0 + Math.pow(rng(), 1.7) * 8.0;
    const geo = boulderGeometry(rng, size, 8, 5, 0.55 + rng() * 0.35);
    euler.set(rng.range(-0.22, 0.22), rng() * TAU, rng.range(-0.22, 0.22));
    quat.setFromEuler(euler);
    scaleV.set(1.2 + rng() * 0.7, 0.7 + rng() * 0.5, 1.1 + rng() * 0.6);
    posV.set(lx, y - size * (shoreStack ? 0.22 : 0.38), lz);
    matrix.compose(posV, quat, scaleV);
    geo.applyMatrix4(matrix);
    pieces.push(flatColorFaces(geo, colorFn));
    made++;
  }
  if (!pieces.length) return;
  const merged = mergeGeometries(pieces, false);
  pieces.forEach((g) => g.dispose());
  if (!merged) return;
  const mesh = new THREE.Mesh(merged, mats.rock);
  mesh.castShadow = false;
  group.add(mesh);
}

// -----------------------------------------------------------------------------
// Surf ribbons â€?thin animated foam bands hugging the waterline
// -----------------------------------------------------------------------------
function addSurfBands(group, spec, mats, surfRings) {
  const bands = spec.surfBands;
  if (!bands || !bands.length) return;
  const field = spec.field;
  const R = spec.radius;
  const ang = Math.min(spec.angular, 200);
  const wl = [];
  for (let k = 0; k < ang; k++) wl.push(field.waterlineRadius((k / ang) * TAU));
  const widthScale = R / 300;
  for (let bi = 0; bi < bands.length; bi++) {
    const band = bands[bi];
    const r0off = band.offset * widthScale;
    const r1off = (band.offset + band.width) * widthScale;
    const pos = new Float32Array(ang * 2 * 3);
    const idx = [];
    for (let k = 0; k < ang; k++) {
      const a = (k / ang) * TAU;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const wob = 1 + 0.1 * fbm2(ca * 5 + 3.1, sa * 5 + 7.7, 2);
      const rr0 = (wl[k] + r0off) * wob;
      const rr1 = (wl[k] + r1off) * wob;
      const o = k * 6;
      pos[o] = ca * rr0;
      pos[o + 1] = band.y0;
      pos[o + 2] = sa * rr0;
      pos[o + 3] = ca * rr1;
      pos[o + 4] = band.y1;
      pos[o + 5] = sa * rr1;
    }
    for (let k = 0; k < ang; k++) {
      const n = (k + 1) % ang;
      const a0 = k * 2;
      const b0 = n * 2;
      idx.push(a0, a0 + 1, b0, b0, a0 + 1, b0 + 1);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mat = mats.surf.clone();
    mat.opacity = band.opacity;
    mat.needsUpdate = true;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 3;
    group.add(mesh);
    surfRings.push({
      mesh,
      mat,
      baseOpacity: band.opacity,
      phase: bi * 2.3 + spec.seed * 0.17,
      speed: band.speed,
      pulse: band.pulse ?? 0.004,
    });
  }
}

// -----------------------------------------------------------------------------
// Island specifications
// -----------------------------------------------------------------------------
function createSpecs() {
  const specs = [];
  const bi = LAYOUT.baseIsland;
  const baseLocal = { x: LAYOUT.base.x - bi.x, z: LAYOUT.base.z - bi.z }; // (-70, 205)

  // ---- near research island -------------------------------------------------
  specs.push({
    id: 'research-island',
    kind: 'near',
    center: { x: bi.x, z: bi.z },
    radius: bi.radius,
    height: bi.height,
    seed: 9107,
    style: 'terrain',
    angular: 224,
    normGrid: 120,
    landRings: 48,
    seaRings: 32,
    qMax: 1.85,
    depth: 12.0,
    uplift: 4.0,
    // high ground pushed to the interior (-Z side of the island centre);
    // the main summit lands near world (1780, -2850)
    peaks: [
      // main summit pushed inland, with a steep seaward rock wall behind the bench
      { x: 20, z: -168, rx: 148, rz: 108, amp: 104.0, sharp: 1.2 },
      { x: 124, z: -196, rx: 96, rz: 78, amp: 40.0, sharp: 1.35 },
      { x: -218, z: -116, rx: 118, rz: 100, amp: 50.0 },
      { x: 224, z: -58, rx: 104, rz: 92, amp: 42.0 },
      { x: -58, z: -252, rx: 112, rz: 90, amp: 36.0 },
      { x: 292, z: 66, rx: 78, rz: 66, amp: 24.0 },
      { x: -305, z: -84, rx: 82, rz: 70, amp: 30.0 },
    ],
    // straight-ish seaward shoreline section for the engineered apron
    coastSector: { a0: 1.16, a1: 2.26, shoreZ: (bi.shorelineZ ?? bi.z - 2390) - bi.z },
    cliffCalm: { a0: 1.38, a1: 2.12 },
    // broad south-west lobe so the coast blends into the shaped shoreline
    coastLobes: [{ angle: 2.46, width: 0.62, amp: 0.2 }],
    // low coastal bench where the research base sits
    bench: {
      x: baseLocal.x,
      z: baseLocal.z,
      fadeStart: 250,
      fadeEnd: 370,
      height: 10.2,
      rise: 2.8,
      riseStart: 140,
      riseEnd: 330,
      seaDrop: 6.5,
      dropStart: 245,
      dropEnd: 325,
    },
    exclusions: [{ x: baseLocal.x, z: baseLocal.z, r: 240 }],
    treeTarget: 236,
    treeSpacing: 7.2,
    treeMinHeight: 2.6,
    treeScale: [0.95, 1.8],
    treeAltScale: null,
    variantWeights: [0.45, 0.35, 0.2],
    rockCount: 56,
    outcropCount: 48,
    surfBands: [
      { offset: 0.6, width: 2.8, y0: 0.3, y1: 0.2, opacity: 0.34, speed: 0.55, pulse: 0.005 },
      { offset: 4.0, width: 4.5, y0: 0.18, y1: 0.1, opacity: 0.2, speed: 0.42, pulse: 0.004 },
      { offset: 9.5, width: 7.0, y0: 0.1, y1: 0.05, opacity: 0.11, speed: 0.32, pulse: 0.003 },
    ],
    palette: NEAR_PALETTE,
  });

  // ---- mid islands from LAYOUT ---------------------------------------------
  const midSeeds = [11, 47];
  let midIdx = 0;
  for (const isl of LAYOUT.islands) {
    if (isl.kind !== 'mid') continue;
    const seed = isl.seed ?? midSeeds[midIdx] ?? 100 + midIdx * 17;
    const rng = makeRng(seed * 13 + 7);
    // elongated, rotated ridge chains -> layered asymmetric silhouette, never a cone
    const ph = rng() * TAU;
    const peaks = [];
    peaks.push({
      x: Math.cos(ph) * isl.radius * 0.1,
      z: -isl.radius * rng.range(0.14, 0.24),
      rx: isl.radius * rng.range(0.52, 0.68),
      rz: isl.radius * rng.range(0.2, 0.3),
      rot: ph + rng.range(-0.6, 0.6),
      amp: isl.height * rng.range(0.55, 0.72),
      sharp: 1.3,
    });
    peaks.push({
      x: Math.cos(ph + 0.9) * isl.radius * 0.22,
      z: -isl.radius * rng.range(0.26, 0.42),
      rx: isl.radius * rng.range(0.34, 0.46),
      rz: isl.radius * rng.range(0.16, 0.24),
      rot: ph + rng.range(0.7, 1.8),
      amp: isl.height * rng.range(0.34, 0.5),
      sharp: 1.35,
    });
    peaks.push({
      x: Math.cos(ph + 2.3) * isl.radius * rng.range(0.26, 0.4),
      z: -isl.radius * rng.range(0.0, 0.2),
      rx: isl.radius * rng.range(0.22, 0.32),
      rz: isl.radius * rng.range(0.13, 0.2),
      rot: ph + rng.range(-1.4, 0.2),
      amp: isl.height * rng.range(0.2, 0.32),
      sharp: 1.4,
    });
    peaks.push({
      x: isl.radius * rng.range(-0.12, 0.16),
      z: isl.radius * rng.range(0.14, 0.3),
      rx: isl.radius * rng.range(0.16, 0.26),
      rz: isl.radius * rng.range(0.1, 0.16),
      rot: rng() * TAU,
      amp: isl.height * rng.range(0.1, 0.2),
      sharp: 1.4,
    });
    specs.push({
      id: `mid-island-${midIdx}`,
      kind: 'mid',
      center: { x: isl.x, z: isl.z },
      radius: isl.radius,
      height: isl.height,
      seed: seed * 97 + 13,
      style: 'terrain',
      angular: 156,
      normGrid: 84,
      landRings: 32,
      seaRings: 18,
      qMax: 1.62,
      depth: 16,
      uplift: 3,
      peaks,
      treeTarget: 44,
      treeSpacing: 14,
      treeMinHeight: 5,
      treeScale: [1.3, 2.2],
      variantWeights: [0.62, 0.38],
      rockCount: 34,
      outcropCount: 18,
      surfBands: [
        { offset: 1.2, width: 5.0, y0: 0.3, y1: 0.18, opacity: 0.24, speed: 0.42, pulse: 0.004 },
        { offset: 7.0, width: 8.0, y0: 0.14, y1: 0.08, opacity: 0.1, speed: 0.3, pulse: 0.003 },
      ],
      palette: MID_PALETTE,
    });
    midIdx++;
  }

  // ---- far silhouette island ------------------------------------------------
  const far = LAYOUT.islands.find((i) => i.kind === 'far');
  if (far) {
    specs.push({
      id: 'far-island',
      kind: 'far',
      center: { x: far.x, z: far.z },
      radius: far.radius,
      height: far.height,
      seed: (far.seed ?? 29) * 131 + 5,
      style: 'silhouette',
      angular: 92,
      normGrid: 56,
      landRings: 22,
      seaRings: 9,
      qMax: 1.42,
      depth: 26,
      uplift: 40,
      peaks: [
        { x: -80, z: -260, rx: 700, rz: 560, amp: 360 },
        { x: 470, z: 40, rx: 400, rz: 350, amp: 215 },
        { x: -560, z: -130, rx: 380, rz: 330, amp: 180 },
      ],
      treeTarget: 0,
      rockCount: 0,
      surfBands: [],
      palette: FAR_PALETTE,
    });

    // A second, hazier ridge sits further behind the far island. Together they
    // read as one layered mountain silhouette on the horizon.
    specs.push({
      id: 'far-ridge',
      kind: 'far',
      center: { x: far.x + 1520, z: far.z + 980 },
      radius: 980,
      height: 300,
      seed: 771,
      style: 'silhouette',
      angular: 56,
      normGrid: 44,
      landRings: 14,
      seaRings: 5,
      qMax: 1.3,
      depth: 34,
      uplift: 30,
      peaks: [
        { x: 120, z: -120, rx: 520, rz: 440, amp: 300 },
        { x: -380, z: 160, rx: 330, rz: 290, amp: 170 },
      ],
      treeTarget: 0,
      rockCount: 0,
      surfBands: [],
      palette: FAR_PALETTE,
    });
  }
  return specs;
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------
// Fields are built once and cached so that other builders can sample the exact
// rendered terrain height without paying for (or duplicating) the mesh work:
//
//   import { sampleIslandHeight } from './world/islands.js';
//   const y = sampleIslandHeight(1690, -2440); // world metres, null = open sea
//
let _preparedSpecs = null;
function preparedSpecs() {
  if (_preparedSpecs) return _preparedSpecs;
  const specs = createSpecs();
  for (const spec of specs) spec.field = createIslandField(spec);
  _preparedSpecs = specs;
  return specs;
}

/**
 * Exact rendered terrain height (metres, world Y) of the nearest island at a
 * world XZ position, or null when the point is open sea / off the islands.
 */
export function sampleIslandHeight(worldX, worldZ) {
  const specs = preparedSpecs();
  let best = null;
  for (let i = 0; i < specs.length; i++) {
    const s = specs[i];
    const lx = worldX - s.center.x;
    const lz = worldZ - s.center.z;
    if (Math.hypot(lx, lz) > s.radius * 1.9) continue;
    const y = s.field.heightAt(lx, lz);
    if (!best || y > best.y) best = { y, island: s.id };
  }
  return best ? best.y : null;
}

export function createIslands() {
  const root = new THREE.Group();
  root.name = 'islands';
  const mats = createIslandMaterials();
  const treeGeometries = buildTreeGeometries();
  const specs = preparedSpecs();
  const surfRings = [];
  const rng = makeRng(20261021);

  for (const spec of specs) {
    const islandGroup = new THREE.Group();
    islandGroup.name = spec.id;
    islandGroup.position.set(spec.center.x, 0, spec.center.z);

    // terrain
    const geo = buildTerrain(spec);
    const terrainMesh = new THREE.Mesh(geo, mats.terrain);
    terrainMesh.castShadow = false;
    terrainMesh.receiveShadow = false;
    islandGroup.add(terrainMesh);

    // trees / rocks / surf
    if (spec.treeTarget) {
      const placements = placeTrees(spec, rng);
      addTreeInstances(islandGroup, placements, treeGeometries, mats, spec.palette, rng);
      spec.treeCount = placements.length;
    }
    if (spec.rockCount) addShoreRocks(islandGroup, spec, mats, rng);
    if (spec.outcropCount) addHillOutcrops(islandGroup, spec, mats, rng);
    if (spec.surfBands && spec.surfBands.length) addSurfBands(islandGroup, spec, mats, surfRings);

    root.add(islandGroup);
  }

  // --- stats & sampling helpers (used by the base builder / QA) -------------
  let triangles = 0;
  root.traverse((o) => {
    if (!o.isMesh) return;
    const g = o.geometry;
    if (!g) return;
    const n = g.index ? g.index.count : g.getAttribute('position').count;
    triangles += Math.floor(n / 3) * (o.isInstancedMesh ? o.count : 1);
  });

  const islandMeta = specs.map((s) => ({
    id: s.id,
    kind: s.kind,
    center: { ...s.center },
    radius: s.radius,
    height: s.height,
    peak: { x: s.center.x + s.field.peakPos.x, z: s.center.z + s.field.peakPos.z },
    heightAt: (worldX, worldZ) => s.field.heightAt(worldX - s.center.x, worldZ - s.center.z),
    waterlineAt: (worldX, worldZ) => {
      const a = Math.atan2(worldZ - s.center.z, worldX - s.center.x);
      return s.field.waterlineRadius(a);
    },
  }));
  root.userData.islands = islandMeta;
  root.userData.triangles = triangles;
  root.userData.heightSampler = (worldX, worldZ) => {
    let best = null;
    for (const s of specs) {
      const lx = worldX - s.center.x;
      const lz = worldZ - s.center.z;
      if (Math.hypot(lx, lz) > s.radius * 1.9) continue;
      const y = s.field.heightAt(lx, lz);
      if (!best || y > best.y) best = { y, island: s.id };
    }
    return best;
  };

  return {
    group: root,
    update(time /*, dt */) {
      for (let i = 0; i < surfRings.length; i++) {
        const r = surfRings[i];
        const s = 1 + Math.sin(time * r.speed + r.phase) * r.pulse;
        r.mesh.scale.set(s, 1, s);
        r.mat.opacity = r.baseOpacity * (0.6 + 0.4 * Math.sin(time * r.speed * 1.27 + r.phase * 1.7));
      }
    },
  };
}
