// =============================================================================
// OceanSwarm — FLAGSHIP: 30 m autonomous command trimaran (hero vessel).
//
// Art direction: stylised "three-render-two" — clean colour blocks, pearl white
// topsides with deep navy accents, silver hardware, dark glass band, thin cyan
// identification strips and a few signal-orange safety marks. Every major volume
// is authored as a faceted extrusion with chamfered edges, and hull / deckhouse
// volumes are pushed through Builder.solid() so the inverted-hull outline gives
// the vessel a crisp anime silhouette.
//
// Local vessel space (shared convention):
//   +X = bow, +Y = up, +Z = starboard, origin = waterline amidships.
// The builder NEVER bakes world position / heading: the fleet controller owns
// group.position + group.quaternion (bobbing, pitch, roll, formation heading).
//
// Layout (x, metres):
//   -15.0 .. -10.9  aft UUV hangar with recessed stern door
//   -10.9 ..  -7.6  raised aft mission platform (crane, small radome, module bay)
//    -7.5 ..  -5.35 sensor mast base house + twin masts
//    -4.75 ..   0.25 aft deckhouse carrying the big satcom radome
//    -0.15 ..   7.0  bridge / cabin block (glass band + faceted roof)
//     7.4 ..  15.4   foredeck (mission bays, windlass, nav lights, bow gear)
//   outriggers at z = +-3.95, floats 20 m, joined by three swept crossarms.
// =============================================================================
import * as THREE from 'three';
import {
  clamp,
  lerp,
  makeRng,
  Builder,
  hullParts,
  hullSurfacePoint,
  hullBand,
  normalizeGeometry,
  matrixFrom,
  box,
  rbox,
  cyl,
  sphere,
  dome,
  disc,
  tube,
  frustum,
  extrudeXZ,
  rod,
  torus,
} from '../../core/geo.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// -----------------------------------------------------------------------------
// Hull specs (see core/geo.js hullParts)
// -----------------------------------------------------------------------------
const MAIN = {
  length: 30,
  beam: 5.6,
  freeboard: 1.46,
  sheer: 0.74,
  draft: 1.635,
  bowSharp: 1.16,
  flare: 0.3,
  rocker: 0.55,
  sternWidth: 0.9,
  camber: 0.06,
  sectionPower: 1.72,
  rake: 0.24,
  uSegments: 56,
};

const FLOAT = {
  length: 20,
  beam: 1.5,
  freeboard: 0.85,
  sheer: 0.46,
  draft: 0.8,
  bowSharp: 1.2,
  flare: 0.26,
  rocker: 0.66,
  sternWidth: 0.86,
  camber: 0.045,
  sectionPower: 1.62,
  rake: 0.26,
  uSegments: 34,
};

const FLOAT_X = -2.0; // float centres: bow +8.0, stern -12.0
const FLOAT_Z = 3.944; // outboard edge 3.944 + 0.75 = 4.70  ->  overall beam 9.4
const BEAM = 9.4;

// Bridge stack (fore-aft x, half widths, chamfers, heights)
const LOWER = { x0: -0.15, x1: 7.0, hw0: 2.3, hw1: 1.95, c0: 0.24, c1: 0.86, y0: 1.04, y1: 3.7 };
const UPPER = { x0: 0.2, x1: 7.25, hw0: 2.28, hw1: 1.93, c0: 0.16, c1: 0.78, y0: 3.5, y1: 5.5, shear: -0.16 };
const GLASS_Y0 = 3.93;
const GLASS_Y1 = 5.16;
const GLASS_SCALE = 1.05;
const ROOF = { x0: -0.02, x1: 7.46, hw0: 2.4, hw1: 2.03, c0: 0.2, c1: 0.82, y0: 5.5, y1: 5.94 };

const HANGAR = { x0: -14.95, x1: -10.95, hw: 2.02, y0: 1.1, y1: 3.16 };
const AFT_HOUSE = { x0: -4.75, x1: 0.25, hw0: 1.98, hw1: 1.9, y0: 1.03, y1: 2.58 };
const MAST_HOUSE = { x0: -7.55, x1: -5.35, hw: 1.15, y0: 1.08, y1: 3.32 };
const PLATFORM = { x0: -10.9, x1: -7.6, hw: 1.88, y0: 1.18, y1: 1.82 };
const MAST_X = -6.25;
const RADAR_TOWER_X = -7.15;
const BIG_RADOME = { x: -2.35, baseY: 2.58, r: 1.1 };
const SMALL_RADOME = { x: -8.55, z: -0.95, baseY: 1.82, r: 0.5, pedH: 0.7 };
const HANGAR_FRONT = HANGAR.x1;

// -----------------------------------------------------------------------------
// Small helpers (kept local to the flagship so the shared toolkit stays clean)
// -----------------------------------------------------------------------------
function planPoly(pts) {
  const shape = new THREE.Shape();
  shape.moveTo(pts[0][0], -pts[0][1]);
  for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i][0], -pts[i][1]);
  shape.closePath();
  return shape;
}

/** Chamfered plan rectangle, fore-aft asymmetric: rear edge x0 (hw0), front x1 (hw1). */
function taperedPlan(x0, x1, hw0, hw1, c0 = 0.2, c1 = 0.2, cz = 0) {
  return [
    [x0 + c0, cz + hw0],
    [x1 - c1, cz + hw1],
    [x1, cz + hw1 - c1],
    [x1, cz - (hw1 - c1)],
    [x1 - c1, cz - hw1],
    [x0 + c0, cz - hw0],
    [x0, cz - (hw0 - c0)],
    [x0, cz + hw0 - c0],
  ];
}

function chamferPlanBox(cx, cz, ax, az, c = 0.14) {
  return taperedPlan(cx - ax, cx + ax, az, az, c, c, cz);
}

function scalePlan(pts, cx, cz, s) {
  return pts.map(([x, z]) => [cx + (x - cx) * s, cz + (z - cz) * s]);
}

/**
 * Extrude a plan polygon between exact world heights y0..y1.
 * The three.js bevel grows the geometry by `bevel` on every side, so the
 * extrusion height is compensated to keep y0/y1 exact.
 */
function extrudedPlan(pts, y0, y1, bevel = 0.05) {
  const bev = Math.min(bevel, Math.max(0, (y1 - y0) * 0.3));
  const h = Math.max(0.02, y1 - y0 - bev * 2);
  const g = extrudeXZ(planPoly(pts), h, bev);
  g.translate(0, y0 + bev, 0);
  return g;
}

/** Shear geometry along +X as a function of world Y (raked bridge / canopy). */
function shearX(geo, k, yRef = 0) {
  const pos = geo.getAttribute('position');
  for (let i = 0; i < pos.count; i++) pos.setX(i, pos.getX(i) + k * (pos.getY(i) - yRef));
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

function addB(b, geo, key, x = 0, y = 0, z = 0, rot) {
  b.add(geo, key, { pos: [x, y, z], rot });
}

function solidB(b, geo, key, x = 0, y = 0, z = 0, rot) {
  b.solid(geo, key, { pos: [x, y, z], rot });
}

// --- hull sampling -----------------------------------------------------------
function hullU(x) {
  return clamp(x / MAIN.length + 0.5, 0.001, 0.999);
}

/** Approximate top deck height of a hull at (x, z) — matches hullParts' deck cap. */
function deckY(spec, x, z) {
  const u = clamp(x / spec.length + 0.5, 0.001, 0.999);
  const edge = hullSurfacePoint(spec, u, 1, 1);
  const hb = Math.max(0.08, Math.abs(edge.z));
  const t = Math.min(1, Math.abs(z) / hb);
  return edge.y + (spec.camber ?? 0) * hb * (1 - Math.pow(t, 1.5));
}

function mainDeckY(x, z) {
  return deckY(MAIN, x, z);
}

function hullDeckEdge(x) {
  return hullSurfacePoint(MAIN, hullU(x), 1, 1);
}

function hullDeckHalfZ(x) {
  return hullDeckEdge(x).z;
}

function hullDeckEdgeY(x) {
  return hullDeckEdge(x).y;
}

/** Point on the main hull surface at world x / waterline height y. */
function hullPointAtY(x, y, side) {
  const u = hullU(x);
  const keel = hullSurfacePoint(MAIN, u, 0, 1).y;
  const deck = hullSurfacePoint(MAIN, u, 1, 1).y;
  const v = clamp((y - keel) / Math.max(0.001, deck - keel), 0.02, 0.98);
  return hullSurfacePoint(MAIN, u, v, side);
}

function floatU(x) {
  return clamp((x - FLOAT_X) / FLOAT.length + 0.5, 0.02, 0.98);
}

function floatDeckEdge(x) {
  return hullSurfacePoint(FLOAT, floatU(x), 1, 1);
}

function floatDeckHalfZ(x) {
  return floatDeckEdge(x).z;
}

function floatDeckEdgeY(x) {
  return floatDeckEdge(x).y;
}

/** World-space point on an outrigger float surface (u along float, v up the section). */
function floatPoint(u, v, side) {
  const p = hullSurfacePoint(FLOAT, u, v, 1);
  return new THREE.Vector3(FLOAT_X + p.x, p.y, side * (FLOAT_Z + p.z));
}

function floatDeckY(x, zSide) {
  const p = floatDeckEdge(x);
  const t = Math.min(1, Math.abs(zSide) / Math.max(0.08, p.z));
  return p.y + (FLOAT.camber ?? 0) * p.z * (1 - Math.pow(t, 1.5));
}

/** Horizontal band hugging the hull at constant world heights (boot stripe etc.). */
function hullBandAtY(spec, y0, y1, offset = 0.03, uSeg = 48) {
  const n = Math.max(8, uSeg);
  const verts = [];
  const inds = [];
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    const keel = hullSurfacePoint(spec, u, 0, 1).y;
    const deck = hullSurfacePoint(spec, u, 1, 1).y;
    const span = Math.max(0.02, deck - keel);
    const v0 = clamp((y0 - keel) / span, 0.01, 0.995);
    const v1 = clamp((y1 - keel) / span, 0.01, 0.995);
    const s0 = hullSurfacePoint(spec, u, v0, 1);
    const s1 = hullSurfacePoint(spec, u, v1, 1);
    const k0 = 1 + offset / Math.max(0.25, Math.abs(s0.z));
    const k1 = 1 + offset / Math.max(0.25, Math.abs(s1.z));
    verts.push(s0.x, s0.y, s0.z * k0, s1.x, s1.y, s1.z * k1, s0.x, s0.y, -s0.z * k0, s1.x, s1.y, -s1.z * k1);
  }
  for (let i = 0; i < n; i++) {
    const a = i * 4;
    const b = (i + 1) * 4;
    inds.push(a, b, a + 1, a + 1, b, b + 1); // starboard
    inds.push(a + 2, a + 3, b + 2, a + 3, b + 3, b + 2); // port
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  g.setIndex(inds);
  g.computeVertexNormals();
  return g;
}

/** Thin ribbon that follows the cambered deck (seams, anti-slip patches). */
function deckRibbon(spec, samples, width, lift) {
  const n = samples.length;
  const pos = [];
  const idx = [];
  for (let i = 0; i < n; i++) {
    const [x, z] = samples[i];
    const [xp, zp] = samples[Math.max(0, i - 1)];
    const [xn, zn] = samples[Math.min(n - 1, i + 1)];
    let tx = xn - xp;
    let tz = zn - zp;
    const tl = Math.hypot(tx, tz) || 1;
    tx /= tl;
    tz /= tl;
    const nx = -tz;
    const nz = tx;
    const hw = width * 0.5;
    const ax = x + nx * hw;
    const az = z + nz * hw;
    const bx = x - nx * hw;
    const bz = z - nz * hw;
    pos.push(ax, deckY(spec, ax, az) + lift, az);
    pos.push(bx, deckY(spec, bx, bz) + lift, bz);
  }
  for (let i = 0; i < n - 1; i++) {
    const a = i * 2;
    idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function sampleRibbon(spec, x0, x1, z0, z1, count) {
  const out = [];
  for (let i = 0; i <= count; i++) {
    const t = i / count;
    out.push([lerp(x0, x1, t), lerp(z0, z1, t)]);
  }
  return out;
}

function mergeMesh(parts) {
  const geos = parts.map(([geo, transform]) => {
    const g = geo.clone();
    if (transform) g.applyMatrix4(matrixFrom(transform));
    const normalized = normalizeGeometry(g, true);
    geo.dispose?.();
    return normalized;
  });
  const merged = mergeGeometries(geos, false);
  for (const g of geos) g.dispose();
  return merged;
}

// =============================================================================
// Hulls
// =============================================================================
function buildMainHull(b) {
  const h = hullParts(MAIN);
  b.solid(h.lower, 'hullBottom');
  b.solid(h.topsides, 'pearl');
  b.solid(h.deck, 'deckGray');
  b.solid(h.transom, 'navy');

  // --- crisp waterline / hull graphics ---------------------------------------
  addB(b, hullBandAtY(MAIN, 0.015, 0.36, 0.03, 56), 'navy'); // boot stripe
  addB(b, hullBandAtY(MAIN, 0.5, 0.55, 0.022, 56), 'metalDark'); // chine line
  addB(b, hullBandAtY(MAIN, 0.96, 1.07, 0.055, 56), 'metal'); // silver rub rail
  addB(b, hullBandAtY(MAIN, 1.16, 1.215, 0.06, 56), 'glowCyan'); // ID light strip
  addB(b, hullBand(MAIN, 0.915, 1.0, 0.032, 56), 'navy'); // sheer cap / gunwale

  // --- black rubber stem bumper (wave-piercing bow) --------------------------
  const stemPts = [0.28, 0.46, 0.66, 0.84, 0.96].map((v) => hullSurfacePoint(MAIN, 0.997, v, 1));
  stemPts.forEach((p) => {
    p.x += 0.02;
  });
  addB(b, tube(stemPts, 0.135, 22, 6), 'rubber');
  addB(b, sphere(0.15, 10, 7), 'rubber', 15.1, 0.82, 0, [0, 0, 0]);
  // small black forward-looking sensor eye just under the stem bumper
  addB(b, cyl(0.075, 0.09, 0.12, 10), 'rubber', 15.05, 1.28, 0, [0, 0, Math.PI / 2]);

  // --- foredeck breakwater (low transverse wall ahead of the bridge) --------
  addB(b, rbox(0.32, 0.55, 2.9, 0.05), 'pearl', 7.75, mainDeckY(7.75, 0) - 0.05, 0);
  addB(b, box(0.34, 0.05, 2.94), 'metal', 7.75, mainDeckY(7.75, 0) + 0.23, 0);

  // --- deck seams & anti-slip patches ---------------------------------------
  addB(b, deckRibbon(MAIN, sampleRibbon(MAIN, -10.6, 7.2, 0, 0, 24), 0.05, 0.012), 'navy');
  addB(b, deckRibbon(MAIN, sampleRibbon(MAIN, 7.8, 13.9, 0, 0, 12), 0.05, 0.012), 'navy');
  for (const x of [-10.2, -8.4, -6.6, -5.1, 8.5, 10.6, 12.4]) {
    const hw = Math.max(0.5, hullDeckHalfZ(x) - 0.3);
    addB(b, deckRibbon(MAIN, sampleRibbon(MAIN, x, x, -hw, hw, 6), 0.045, 0.014), 'navy');
  }
  addB(b, deckRibbon(MAIN, sampleRibbon(MAIN, 8.2, 12.9, 0, 0, 16), 1.02, 0.018), 'rubber');
  addB(b, deckRibbon(MAIN, sampleRibbon(MAIN, 10.0, 11.4, -1.3, -1.3, 6), 0.5, 0.018), 'rubber');
  addB(b, deckRibbon(MAIN, sampleRibbon(MAIN, 10.0, 11.4, 1.3, 1.3, 6), 0.5, 0.018), 'rubber');

  // --- orange safety marks on the sheer / foredeck --------------------------
  for (const side of [1, -1]) {
    const p = hullDeckEdge(9.2);
    addB(b, box(0.5, 0.09, 0.04), 'signalOrange', 9.2, p.y - 0.12, side * (p.z + 0.02));
    const q = hullDeckEdge(6.4);
    addB(b, box(0.42, 0.08, 0.035), 'signalOrange', 6.4, q.y - 0.1, side * (q.z + 0.02));
  }
}

function buildFloats(b) {
  for (const side of [1, -1]) {
    const pos = [FLOAT_X, 0, side * FLOAT_Z];
    const f = hullParts(FLOAT);
    b.solid(f.lower, 'hullBottom', { pos });
    b.solid(f.topsides, 'pearl', { pos });
    b.solid(f.deck, 'deckGray', { pos });
    b.solid(f.transom, 'navy', { pos });

    // waterline graphics
    addB(b, hullBandAtY(FLOAT, 0.015, 0.3, 0.025, 34), 'navy', ...pos);
    addB(b, hullBandAtY(FLOAT, 0.52, 0.575, 0.04, 34), 'metal', ...pos);
    addB(b, hullBandAtY(FLOAT, 0.66, 0.71, 0.05, 34), 'glowCyan', ...pos);
    addB(b, hullBand(FLOAT, 0.915, 1.0, 0.028, 34), 'navy', ...pos);

    // pearl walkway down the centre of the float deck, framed by navy seams
    for (let i = 0; i < 8; i++) {
      const wx = FLOAT_X - 8.6 + i * 2.2;
      const wy = floatDeckY(wx, 0);
      addB(b, box(2.0, 0.03, 0.6), 'pearl', wx, wy + 0.015, side * FLOAT_Z);
      addB(b, box(2.04, 0.02, 0.035), 'navy', wx, wy + 0.04, side * (FLOAT_Z - 0.28));
      addB(b, box(2.04, 0.02, 0.035), 'navy', wx, wy + 0.04, side * (FLOAT_Z + 0.28));
    }

    // orange bow flash
    const bx = FLOAT_X + 9.35;
    addB(b, box(0.5, 0.1, 0.06), 'signalOrange', bx, floatDeckEdgeY(bx) - 0.16, side * (FLOAT_Z + floatDeckHalfZ(bx) - 0.02));

    // float deck gear: low equipment pod + cleat + sensor fin
    const px = FLOAT_X + 2.6;
    const py = floatDeckY(px, 0);
    solidB(b, rbox(0.72, 0.26, 0.52, 0.04), 'navy', px, py + 0.11, side * FLOAT_Z);
    addB(b, box(0.22, 0.05, 0.14), 'metal', px + 0.28, py + 0.27, side * FLOAT_Z);
    addB(b, box(0.26, 0.03, 0.16), 'metal', px - 1.5, py + 0.02, side * FLOAT_Z); // cleat base
    addB(b, cyl(0.045, 0.045, 0.24, 8), 'metal', px - 1.5, py + 0.1, side * FLOAT_Z, [Math.PI / 2, 0, 0]);
    // sleek sensor fin towards the float bow
    const fx = FLOAT_X + 7.4;
    solidB(b, box(0.07, 0.42, 0.5), 'pearl', fx, floatDeckY(fx, 0) + 0.24, side * FLOAT_Z, [0, 0, 0.12]);
    // small cyan float marker
    addB(b, box(0.09, 0.05, 0.09), 'glowCyan', fx, floatDeckY(fx, 0) + 0.5, side * FLOAT_Z);
  }
}

function buildCrossArms(b) {
  const arms = [
    { rootX: 3.4, tipX: 2.7, rootChord: 1.18, tipChord: 0.88 },
    { rootX: -1.4, tipX: -2.2, rootChord: 1.06, tipChord: 0.8 },
    { rootX: -7.4, tipX: -8.2, rootChord: 1.0, tipChord: 0.78 },
  ];
  for (const side of [1, -1]) {
    for (const arm of arms) {
      const rZ = hullDeckHalfZ(arm.rootX) - 0.3;
      const tZ = FLOAT_Z - floatDeckHalfZ(arm.tipX) + 0.28;
      const rootTop = hullDeckEdgeY(arm.rootX) + 0.06;
      const tipTop = floatDeckEdgeY(arm.tipX) + 0.22;
      const rc = arm.rootChord * 0.5;
      const tc = arm.tipChord * 0.5;
      const rx = arm.rootX;
      const tx = arm.tipX;
      const planPts = [
        [rx + rc, side * rZ],
        [tx + tc, side * tZ],
        [tx, side * (tZ + 0.12)],
        [tx - tc, side * tZ],
        [rx - rc, side * rZ],
      ];
      const g = extrudedPlan(planPts, -0.26, 0, 0.045);
      g.translate(0, 0, -side * rZ);
      const angle = Math.atan2(rootTop - tipTop, Math.max(0.25, Math.abs(tZ - rZ)));
      g.rotateX(side * angle);
      g.translate(0, rootTop, side * rZ);
      b.solid(g, 'pearl');

      // hull-side knee fairing
      solidB(
        b,
        extrudedPlan(chamferPlanBox(rx, side * rZ, 0.74, 0.4, 0.16), rootTop - 0.95, rootTop + 0.03, 0.05),
        'pearl',
      );
      // riveted silver cap on the knee
      addB(b, box(0.14, 0.06, 0.7), 'metal', rx, rootTop + 0.05, side * rZ);
      // float pylon fairing
      solidB(
        b,
        extrudedPlan(chamferPlanBox(tx, side * FLOAT_Z, 0.4, 0.44, 0.12), floatDeckEdgeY(tx) - 0.18, tipTop - 0.02, 0.045),
        'pearl',
      );
      // orange wing-tip marker
      addB(b, box(0.36, 0.05, 0.14), 'signalOrange', tx, tipTop + 0.04, side * tZ, [side * angle, 0, 0]);
      // diagonal structural brace down to the float
      const hullAttach = hullPointAtY(rx - 0.55, 0.78, side);
      const fp = floatPoint(clamp((tx + 0.25 - FLOAT_X) / FLOAT.length + 0.5, 0.02, 0.98), 0.62, side);
      addB(
        b,
        rod(
          [
            new THREE.Vector3(hullAttach.x, hullAttach.y, hullAttach.z),
            new THREE.Vector3(fp.x, fp.y, fp.z),
          ],
          0.075,
          6,
        ),
        'metalDark',
      );
    }
  }
}

// =============================================================================
// Superstructure (bridge / cabin)
// =============================================================================
function buildSuperstructure(b) {
  const lowerPts = taperedPlan(LOWER.x0, LOWER.x1, LOWER.hw0, LOWER.hw1, LOWER.c0, LOWER.c1);
  const lowerGeo = extrudedPlan(lowerPts, LOWER.y0, LOWER.y1, 0.06);
  shearX(lowerGeo, -0.1, LOWER.y0);
  b.solid(lowerGeo, 'pearl');

  // navy waistline belt around the cabin (visible above the cambered deck)
  const beltPts = scalePlan(lowerPts, 3.4, 0, 1.02);
  const beltGeo = extrudedPlan(beltPts, 2.58, 2.7, 0.03);
  shearX(beltGeo, -0.1, LOWER.y0);
  b.add(beltGeo, 'navy');

  // upper bridge volume
  const upperPts = taperedPlan(UPPER.x0, UPPER.x1, UPPER.hw0, UPPER.hw1, UPPER.c0, UPPER.c1);
  const upperGeo = extrudedPlan(upperPts, UPPER.y0, UPPER.y1, 0.06);
  shearX(upperGeo, UPPER.shear, UPPER.y0);
  b.solid(upperGeo, 'pearl');

  // wrap-around dark glass band (slightly proud of the shell)
  const glassPts = scalePlan(upperPts, 3.725, 0, GLASS_SCALE);
  const glassGeo = extrudedPlan(glassPts, GLASS_Y0, GLASS_Y1, 0.04);
  shearX(glassGeo, UPPER.shear, UPPER.y0);
  b.add(glassGeo, 'glass');

  // white pillars articulating the glass band
  const pillarPositions = [];
  const glx1 = 3.725 + (UPPER.x1 - 3.725) * GLASS_SCALE;
  const glx0 = 3.725 + (UPPER.x0 - 3.725) * GLASS_SCALE;
  const glhw1 = UPPER.hw1 * GLASS_SCALE;
  const glhw0 = UPPER.hw0 * GLASS_SCALE;
  const glc1 = UPPER.c1 * GLASS_SCALE;
  pillarPositions.push({ x: glx1 + 0.06, z: 0, rot: 0, w: 0.34, d: 0.13 });
  pillarPositions.push({ x: glx1 - glc1 * 0.5 + 0.02, z: 0, rot: 0, skip: true });
  if (glc1 > 0.1) {
    pillarPositions.push({ x: glx1 - glc1 * 0.5 + 0.02, z: glhw1 - glc1 * 0.5, rot: Math.PI / 4, w: 0.34, d: 0.13 });
    pillarPositions.push({ x: glx1 - glc1 * 0.5 + 0.02, z: -(glhw1 - glc1 * 0.5), rot: -Math.PI / 4, w: 0.34, d: 0.13 });
  }
  for (const sx of [1.4, 5.6]) {
    const frac = (sx - (glx0 + UPPER.c0 * GLASS_SCALE)) / Math.max(0.1, glx1 - glc1 - (glx0 + UPPER.c0 * GLASS_SCALE));
    const hw = glhw0 + (glhw1 - glhw0) * clamp(frac, 0, 1);
    pillarPositions.push({ x: sx, z: hw + 0.06, rot: 0, w: 0.34, d: 0.13 });
    pillarPositions.push({ x: sx, z: -(hw + 0.06), rot: 0, w: 0.34, d: 0.13 });
  }
  for (const p of pillarPositions) {
    if (p.skip) continue;
    const geo = box(p.w, GLASS_Y1 - GLASS_Y0 + 0.06, p.d);
    geo.rotateY(p.rot);
    geo.translate(p.x, (GLASS_Y0 + GLASS_Y1) * 0.5, p.z);
    shearX(geo, UPPER.shear, UPPER.y0);
    b.add(geo, 'pearl');
  }

  // silver drip rail + cyan LED gasket under the roof
  const trimGeo = extrudedPlan(scalePlan(upperPts, 3.725, 0, 1.075), 5.43, 5.52, 0.03);
  shearX(trimGeo, UPPER.shear, UPPER.y0);
  b.add(trimGeo, 'metal');
  const ledGeo = extrudedPlan(scalePlan(upperPts, 3.725, 0, 1.06), 5.3, 5.355, 0.015);
  shearX(ledGeo, UPPER.shear, UPPER.y0);
  b.add(ledGeo, 'glowCyan');

  // faceted roof cap
  const roofPts = taperedPlan(ROOF.x0, ROOF.x1, ROOF.hw0, ROOF.hw1, ROOF.c0, ROOF.c1);
  const roofGeo = extrudedPlan(roofPts, ROOF.y0, ROOF.y1, 0.075);
  shearX(roofGeo, UPPER.shear, UPPER.y0);
  b.solid(roofGeo, 'pearl');

  const roofShift = (y) => UPPER.shear * (y - UPPER.y0);

  // --- cabin side details ----------------------------------------------------
  const lowerHw = (x) => {
    const f = clamp((x - LOWER.x0) / (LOWER.x1 - LOWER.x0), 0, 1);
    return LOWER.hw0 + (LOWER.hw1 - LOWER.hw0) * f + 0.06;
  };
  const lowerTaper = Math.atan((LOWER.hw0 - LOWER.hw1) / (LOWER.x1 - LOWER.x0));
  // a thin plate lying on the tapering cabin side, automatically on both sides
  const sidePlate = (x, y, w, h, key, proud = 0.025, depth = 0.07) => {
    for (const side of [1, -1]) {
      const g = box(w, h, depth);
      g.rotateY(side * lowerTaper);
      g.translate(x, y, side * (lowerHw(x) + proud));
      shearX(g, -0.1, LOWER.y0);
      b.add(g, key);
    }
  };
  // vertical panel seams
  for (const x of [1.3, 3.5, 5.7]) sidePlate(x, 2.45, 0.035, 1.9, 'navy', 0.015, 0.05);
  // horizontal seam
  sidePlate(3.3, 2.92, 4.4, 0.035, 'navy', 0.015, 0.05);
  // recessed access hatch, hinges and a silver handle
  sidePlate(2.25, 2.28, 0.66, 0.82, 'metalDark', 0.03, 0.1);
  sidePlate(1.92, 2.28, 0.07, 0.24, 'metal', 0.085, 0.05);
  sidePlate(2.58, 2.28, 0.07, 0.24, 'metal', 0.085, 0.05);
  sidePlate(2.25, 2.64, 0.5, 0.05, 'metal', 0.06, 0.05);
  // cooling louvres
  for (let i = 0; i < 3; i++) sidePlate(4.6, 2.98 + i * 0.09, 0.95, 0.045, 'metalDark', 0.02, 0.05);
  // warm lit windows tucked in the shade of the bridge wing / aft end
  sidePlate(0.9, 2.62, 0.5, 0.3, 'glowWarm', 0.02, 0.05);
  sidePlate(6.0, 2.38, 0.42, 0.26, 'glowWarm', 0.02, 0.05);
  // orange docking marks
  sidePlate(6.25, 2.02, 0.36, 0.24, 'signalOrange', 0.012, 0.05);
  // life rings
  for (const side of [1, -1]) {
    addB(b, torus(0.17, 0.045, 5, 12), 'signalOrange', 1.6, 2.98, side * (lowerHw(1.6) + 0.06), [0, side > 0 ? 0 : Math.PI, 0]);
    addB(b, box(0.06, 0.08, 0.1), 'metalDark', 1.6, 3.12, side * (lowerHw(1.6) + 0.02));
  }

  // --- front face: downward looking sensor windows ---------------------------
  for (const side of [1, -1]) {
    addB(b, box(0.035, 0.44, 0.62), 'glass', 6.95, 2.24, side * 0.62, [0, 0, -0.52]);
    addB(b, box(0.05, 0.1, 0.7), 'metalDark', 6.97, 2.52, side * 0.62, [0, 0, -0.52]);
  }

  // --- bridge wings (small open side platforms with consoles) ----------------
  for (const side of [1, -1]) {
    addB(b, rbox(1.7, 0.14, 0.68, 0.03), 'pearl', 5.7, 3.42, side * 2.42);
    addB(b, box(0.05, 0.2, 0.64), 'navy', 4.86, 3.42, side * 2.42);
    addB(b, rbox(0.46, 0.3, 0.5, 0.04), 'pearl', 6.18, 3.62, side * 2.6);
    addB(b, box(0.4, 0.03, 0.4), 'glass', 6.18, 3.79, side * 2.6);
    // wing rail
    const railPts = [
      new THREE.Vector3(4.95, 4.17, side * 2.74),
      new THREE.Vector3(5.7, 4.17, side * 2.78),
      new THREE.Vector3(6.45, 4.17, side * 2.74),
    ];
    addB(b, tube(railPts, 0.022, 8, 4), 'metal');
    for (const px of [4.98, 5.7, 6.42]) {
      addB(b, cyl(0.02, 0.026, 0.72, 5), 'metal', px, 3.82, side * 2.75);
    }
    // support strut to the deck edge
    const attach = hullDeckEdge(6.55);
    addB(
      b,
      rod(
        [
          new THREE.Vector3(6.35, 3.34, side * 2.55),
          new THREE.Vector3(6.7, attach.y + 0.06, side * (attach.z - 0.12)),
        ],
        0.045,
        6,
      ),
      'metal',
    );
  }

  // navy collar marking the bridge-deck edge (reads as a dark deck ring)
  const browPts = scalePlan(lowerPts, 3.4, 0, 1.006);
  const browGeo = extrudedPlan(browPts, 3.38, 3.56, 0.02);
  shearX(browGeo, -0.1, LOWER.y0);
  b.add(browGeo, 'navy');

  // --- roof equipment --------------------------------------------------------
  const eoX = 6.0 + roofShift(ROOF.y1);
  const eoY = ROOF.y1;
  // EO gimbal pedestal + fixed yoke
  addB(b, cyl(0.52, 0.58, 0.12, 18), 'pearl', eoX, eoY + 0.06, 0);
  addB(b, cyl(0.3, 0.36, 0.1, 14), 'metalDark', eoX, eoY + 0.17, 0);
  for (const side of [1, -1]) {
    addB(b, rbox(0.36, 0.6, 0.12, 0.035), 'pearl', eoX, eoY + 0.52, side * 0.47);
    addB(b, cyl(0.09, 0.09, 0.07, 10), 'metal', eoX, eoY + 0.52, side * 0.4, [Math.PI / 2, 0, 0]);
  }
  addB(b, box(0.5, 0.06, 0.24), 'pearl', eoX, eoY + 0.22, 0);
  // GPS domes + roof antennas
  for (const side of [1, -1]) {
    addB(b, dome(0.17, 12, 6, 0.62), 'pearl', 2.2 + roofShift(6.0), 6.0, side * 1.45);
    addB(b, cyl(0.19, 0.22, 0.05, 10), 'metal', 2.2 + roofShift(5.98), 5.98, side * 1.45);
    addB(b, box(0.05, 0.55, 0.17), 'pearl', 1.15 + roofShift(6.2), 6.23, side * 1.15, [0, side * 0.45, 0]);
  }
  // environmental sensor rod on the roof
  addB(b, cyl(0.022, 0.028, 0.9, 6), 'metal', 3.2 + roofShift(6.35), 6.35, -1.1);
  addB(b, box(0.34, 0.03, 0.03), 'metal', 3.2 + roofShift(6.68), 6.68, -1.1);
  addB(b, sphere(0.05, 6, 5), 'metal', 3.2 + roofShift(6.8), 6.8, -1.1);
  // flat roof hatch + anti-slip patch
  addB(b, rbox(0.7, 0.08, 0.55, 0.03), 'metalDark', 1.4 + roofShift(5.98), 5.98, 0.4);
  addB(b, box(0.72, 0.02, 0.56), 'metal', 1.4 + roofShift(5.94), 5.945, 0.4);
  addB(b, rbox(1.5, 0.02, 0.9, 0.01), 'rubber', 2.5 + roofShift(5.95), 5.95, 0.15);
  // short range antenna mast on the roof rear
  addB(b, cyl(0.03, 0.075, 1.0, 8), 'pearl', 0.75 + roofShift(6.44), 6.44, 0);
  addB(b, box(0.1, 0.05, 0.1), 'metal', 0.75 + roofShift(6.96), 6.98, 0);
  // bridge wing marker lights
  for (const side of [1, -1]) {
    addB(b, box(0.1, 0.06, 0.1), 'glowCyan', 5.7, 3.53, side * 2.72);
  }
}

// =============================================================================
// Aft structures: hangar, aft platform, aft deckhouse + radomes
// =============================================================================
function buildHangar(b) {
  const hw = HANGAR.hw;
  const shellPts = taperedPlan(HANGAR.x0, HANGAR.x1, hw, hw - 0.02, 0.3, 0.22);
  const shell = extrudedPlan(shellPts, HANGAR.y0, HANGAR.y1, 0.07);
  b.solid(shell, 'pearl');
  const sideFace = hw + 0.07; // beveled side plane

  // navy roof-edge capping band + side rub strip
  addB(b, extrudedPlan(scalePlan(shellPts, -12.95, 0, 1.018), HANGAR.y1 - 0.16, HANGAR.y1 - 0.06, 0.02), 'navy');
  for (const side of [1, -1]) {
    addB(b, box(3.5, 0.1, 0.05), 'navy', -12.95, 2.92, side * (sideFace + 0.025));
  }

  // ---- recessed UUV stern door --------------------------------------------
  const dfx = HANGAR.x0 - 0.07; // beveled stern face plane
  // proud navy door surround -> the dark leaf between it reads as recessed
  addB(b, box(0.1, 0.16, 3.3), 'navy', dfx - 0.045, 3.11, 0);
  addB(b, box(0.1, 0.16, 3.3), 'navy', dfx - 0.045, 1.43, 0);
  for (const side of [1, -1]) {
    addB(b, box(0.1, 1.84, 0.18), 'navy', dfx - 0.045, 2.27, side * 1.62);
    addB(b, box(0.08, 0.28, 0.14), 'metalDark', dfx - 0.05, 2.86, side * 1.44);
    addB(b, box(0.08, 0.28, 0.14), 'metalDark', dfx - 0.05, 1.68, side * 1.44);
    addB(b, box(0.03, 0.09, 0.62), 'signalOrange', dfx - 0.09, 1.6, side * 0.78, [side * 0.55, 0, 0]);
    addB(b, box(0.012, 0.07, 0.5), 'metal', dfx - 0.075, 2.28, side * 0.78);
  }
  // dark door leaf, seams, rails and lock wheel
  addB(b, box(0.04, 1.5, 2.96), 'rubber', dfx - 0.03, 2.27, 0);
  addB(b, box(0.012, 1.44, 0.05), 'metalDark', dfx - 0.072, 2.27, 0);
  addB(b, box(0.012, 0.05, 2.9), 'metalDark', dfx - 0.072, 2.27, 0);
  addB(b, box(0.012, 0.05, 2.92), 'metal', dfx - 0.072, 3.0, 0);
  addB(b, box(0.012, 0.05, 2.92), 'metal', dfx - 0.072, 1.54, 0);
  addB(b, cyl(0.12, 0.12, 0.06, 14), 'metalDark', dfx - 0.1, 2.27, 0, [0, 0, Math.PI / 2]);

  // ---- hangar roof ---------------------------------------------------------
  addB(b, rbox(2.72, 0.04, 2.72, 0.03), 'deckGray', -13.0, HANGAR.y1 + 0.02, 0); // working deck
  // navy coaming ring
  addB(b, box(0.14, 0.12, 2.9), 'navy', -14.36, HANGAR.y1 + 0.05, 0);
  addB(b, box(0.14, 0.12, 2.9), 'navy', -11.64, HANGAR.y1 + 0.05, 0);
  for (const side of [1, -1]) {
    addB(b, box(2.86, 0.12, 0.14), 'navy', -13.0, HANGAR.y1 + 0.05, side * 1.38);
  }
  addB(b, rbox(0.9, 0.1, 0.7, 0.03), 'metalDark', -13.3, HANGAR.y1 + 0.1, 0.2); // roof hatch
  addB(b, box(0.86, 0.03, 0.66), 'metal', -13.3, HANGAR.y1 + 0.055, 0.2);
  for (const side of [1, -1]) {
    addB(b, rbox(0.5, 0.24, 0.42, 0.04), 'metalDark', -12.6, HANGAR.y1 + 0.17, side * 1.15); // vents
  }
  addB(b, rbox(0.62, 0.02, 0.42, 0.01), 'rubber', -11.2, HANGAR.y1 + 0.045, 0.3);
  for (const side of [1, -1]) {
    addB(b, box(0.16, 0.03, 0.16), 'signalOrange', -11.2, HANGAR.y1 + 0.06, side * 1.45);
    addB(b, box(0.16, 0.03, 0.16), 'signalOrange', -14.6, HANGAR.y1 + 0.06, side * 1.45);
  }
  // ops light on the coaming
  addB(b, box(0.18, 0.06, 0.18), 'metalDark', -12.0, HANGAR.y1 + 0.1, 0);
  addB(b, box(0.12, 0.08, 0.12), 'glowWarm', -12.0, HANGAR.y1 + 0.18, 0);

  // ---- hangar side panels --------------------------------------------------
  for (const side of [1, -1]) {
    for (const x of [-14.0, -12.7, -11.4]) {
      addB(b, box(0.035, 1.9, 0.024), 'navy', x, 2.28, side * (sideFace + 0.012));
    }
    addB(b, box(3.7, 0.1, 0.05), 'navy', -12.95, 1.78, side * (sideFace + 0.022)); // navy base belt
    addB(b, box(0.8, 0.9, 0.06), 'metalDark', -13.35, 2.2, side * (sideFace + 0.02));
    addB(b, box(0.05, 0.16, 0.05), 'metal', -13.35, 2.2, side * (sideFace + 0.075));
    addB(b, box(0.6, 0.28, 0.03), 'glowWarm', -12.05, 2.55, side * (sideFace + 0.012));
    addB(b, box(0.5, 0.9, 0.04), 'metalDark', -11.55, 2.0, side * (sideFace + 0.015));
  }

  // ---- hangar front face ---------------------------------------------------
  addB(b, box(2.9, 1.0, 0.06), 'navy', HANGAR.x1 + 0.1, 2.35, 0);
  for (const side of [1, -1]) {
    addB(b, box(0.4, 0.28, 0.03), 'glowWarm', HANGAR.x1 + 0.135, 2.62, side * 0.9);
  }
  addB(b, box(1.6, 0.05, 0.05), 'metal', HANGAR.x1 + 0.13, 2.9, 0);
  // small davit pivot pad on the roof edge
  addB(b, cyl(0.28, 0.32, 0.1, 14), 'metalDark', HANGAR.x1 - 0.05, HANGAR.y1 + 0.05, 0.5);
}

function buildAftPlatform(b) {
  const pts = taperedPlan(PLATFORM.x0, PLATFORM.x1, PLATFORM.hw, PLATFORM.hw - 0.06, 0.2, 0.18);
  const body = extrudedPlan(pts, PLATFORM.y0, PLATFORM.y1 - 0.08, 0.05);
  b.solid(body, 'pearl');
  const deckPts = scalePlan(pts, -9.25, 0, 1.01);
  addB(b, extrudedPlan(deckPts, PLATFORM.y1 - 0.09, PLATFORM.y1, 0.015), 'deckGray');
  // orange border marks
  addB(b, box(3.3, 0.022, 0.07), 'signalOrange', -9.25, PLATFORM.y1 + 0.015, 1.8);
  addB(b, box(3.3, 0.022, 0.07), 'signalOrange', -9.25, PLATFORM.y1 + 0.015, -1.8);
  addB(b, box(0.07, 0.022, 3.4), 'signalOrange', PLATFORM.x0 + 0.06, PLATFORM.y1 + 0.015, 0);
  addB(b, box(0.07, 0.022, 3.4), 'signalOrange', PLATFORM.x1 - 0.06, PLATFORM.y1 + 0.015, 0);
  // anti-slip patch
  addB(b, rbox(2.2, 0.02, 1.3, 0.02), 'rubber', -9.3, PLATFORM.y1 + 0.03, -0.15);
  // padeyes
  for (const side of [1, -1]) {
    for (const x of [-10.3, -9.25, -8.2]) {
      addB(b, torus(0.05, 0.014, 4, 8), 'metal', x, PLATFORM.y1 + 0.035, side * 1.55, [0, 0, 0]);
    }
  }
  // step down to the deck
  addB(b, box(1.4, 0.26, 0.5), 'pearl', PLATFORM.x1 - 0.2, PLATFORM.y1 - 0.24, 0.0);
  addB(b, box(1.4, 0.05, 0.52), 'metal', PLATFORM.x1 - 0.05, PLATFORM.y1 - 0.1, 0.0);

  // ---- mission module bay on the platform (port) --------------------------
  const bayY = PLATFORM.y1;
  addB(b, rbox(1.2, 0.5, 0.85, 0.05), 'pearl', -9.85, bayY + 0.25, -1.02);
  addB(b, box(1.06, 0.04, 0.7), 'navy', -9.85, bayY + 0.51, -1.02);
  for (const dx of [-0.34, 0.34]) {
    addB(b, box(0.03, 0.36, 0.72), 'navy', -9.85 + dx, bayY + 0.28, -1.02);
  }
  addB(b, box(0.18, 0.05, 0.04), 'metal', -9.85, bayY + 0.3, -0.58);
  for (const side of [1, -1]) {
    addB(b, box(0.12, 0.03, 0.1), 'signalOrange', -10.3, bayY + 0.52, -1.02 + side * 0.28);
  }

  // ---- folded knuckle-boom crane ------------------------------------------
  const craneBase = new THREE.Vector3(-8.35, PLATFORM.y1, 1.55);
  addB(b, cyl(0.34, 0.44, 0.72, 16), 'metalDark', craneBase.x, PLATFORM.y1 + 0.36, craneBase.z);
  addB(b, cyl(0.44, 0.4, 0.34, 16), 'pearl', craneBase.x, PLATFORM.y1 + 0.86, craneBase.z);
  addB(b, cyl(0.415, 0.415, 0.06, 16), 'signalOrange', craneBase.x, PLATFORM.y1 + 0.74, craneBase.z);
  // boom A: horizontal, forward
  const boomA = frustum(0.28, 2.4, 0.34, 0.7, 0.7);
  boomA.translate(0, 1.2, 0);
  boomA.applyMatrix4(new THREE.Matrix4().makeRotationZ(-Math.PI / 2));
  boomA.translate(craneBase.x, PLATFORM.y1 + 1.08, craneBase.z);
  b.solid(boomA, 'pearl');
  addB(b, box(1.6, 0.05, 0.24), 'metal', craneBase.x + 1.25, PLATFORM.y1 + 1.26, craneBase.z);
  // jib B: folded back aft and up
  const jib = frustum(0.2, 1.7, 0.26, 0.65, 0.65);
  jib.translate(0, 0.85, 0);
  jib.applyMatrix4(new THREE.Matrix4().makeRotationZ(1.22));
  jib.translate(craneBase.x + 2.4, PLATFORM.y1 + 1.08, craneBase.z);
  b.solid(jib, 'pearl');
  // hydraulic ram + hook block + cable
  addB(
    b,
    rod(
      [
        new THREE.Vector3(craneBase.x + 0.1, PLATFORM.y1 + 0.55, craneBase.z),
        new THREE.Vector3(craneBase.x + 1.05, PLATFORM.y1 + 1.0, craneBase.z),
      ],
      0.055,
      5,
    ),
    'metal',
  );
  addB(b, box(0.05, 0.42, 0.05), 'metal', -7.55, PLATFORM.y1 + 1.55, craneBase.z);
  addB(b, rbox(0.16, 0.2, 0.16, 0.03), 'metalDark', -7.55, PLATFORM.y1 + 1.3, craneBase.z);
  addB(b, box(0.18, 0.05, 0.18), 'signalOrange', -7.55, PLATFORM.y1 + 1.42, craneBase.z);
  addB(b, box(0.16, 0.1, 0.1), 'metalDark', craneBase.x + 2.3, PLATFORM.y1 + 1.36, craneBase.z);
  // small deck locker
  addB(b, rbox(0.9, 0.56, 0.66, 0.04), 'pearl', -10.35, PLATFORM.y1 + 0.28, 1.3);
  addB(b, box(0.82, 0.04, 0.58), 'navy', -10.35, PLATFORM.y1 + 0.58, 1.3);
  addB(b, box(0.06, 0.06, 0.3), 'metal', -9.9, PLATFORM.y1 + 0.34, 1.3);
  // warm work light on a short pole
  addB(b, cyl(0.04, 0.05, 0.9, 6), 'metal', PLATFORM.x1 - 0.35, PLATFORM.y1 + 0.45, 1.55);
  addB(b, box(0.16, 0.1, 0.14), 'glowWarm', PLATFORM.x1 - 0.35, PLATFORM.y1 + 0.94, 1.55);

  // ---- small satcom radome further aft ------------------------------------
  addB(b, cyl(0.34, 0.4, 0.24, 16), 'metalDark', SMALL_RADOME.x, PLATFORM.y1 + 0.12, SMALL_RADOME.z);
  addB(b, cyl(0.26, 0.3, SMALL_RADOME.pedH, 14), 'pearl', SMALL_RADOME.x, PLATFORM.y1 + 0.24 + SMALL_RADOME.pedH * 0.5, SMALL_RADOME.z);
  solidB(b, sphere(SMALL_RADOME.r, 18, 12), 'pearl', SMALL_RADOME.x, PLATFORM.y1 + 0.24 + SMALL_RADOME.pedH + SMALL_RADOME.r - 0.06, SMALL_RADOME.z);
}

function buildAftDeckhouse(b) {
  const pts = taperedPlan(AFT_HOUSE.x0, AFT_HOUSE.x1, AFT_HOUSE.hw0, AFT_HOUSE.hw1, 0.32, 0.28);
  const geo = extrudedPlan(pts, AFT_HOUSE.y0, AFT_HOUSE.y1, 0.07);
  b.solid(geo, 'pearl');
  const capBand = extrudedPlan(scalePlan(pts, -2.2, 0, 1.02), AFT_HOUSE.y1 - 0.15, AFT_HOUSE.y1 - 0.05, 0.02);
  b.add(capBand, 'navy');
  const roofY = AFT_HOUSE.y1;
  const aftHw = (x) => {
    const f = clamp((x - AFT_HOUSE.x0) / (AFT_HOUSE.x1 - AFT_HOUSE.x0), 0, 1);
    return AFT_HOUSE.hw0 + (AFT_HOUSE.hw1 - AFT_HOUSE.hw0) * f + 0.07;
  };

  // side details
  for (const side of [1, -1]) {
    for (const x of [-4.0, -2.6, -1.2]) {
      addB(b, box(0.035, 1.0, 0.024), 'navy', x, 2.05, side * (aftHw(x) + 0.012));
    }
    addB(b, box(0.62, 0.32, 0.03), 'glowWarm', -3.5, 2.2, side * (aftHw(-3.5) + 0.012));
    addB(b, box(0.44, 0.24, 0.03), 'glowWarm', -1.5, 2.2, side * (aftHw(-1.5) + 0.012));
    addB(b, box(0.6, 0.8, 0.06), 'navy', -2.9, 2.0, side * (aftHw(-2.9) + 0.02));
    addB(b, box(0.05, 0.24, 0.04), 'metal', -2.9, 2.0, side * (aftHw(-2.9) + 0.07));
    // cable conduit along the roof edge
    addB(b, cyl(0.035, 0.035, 4.2, 6), 'metalDark', -2.2, roofY + 0.05, side * 1.75, [Math.PI / 2, 0, 0]);
    // navy base belt
    const beltGeo = box(4.3, 0.09, 0.05);
    beltGeo.rotateY(side * 0.016);
    beltGeo.translate(-2.2, 1.86, side * (aftHw(-2.2) + 0.02));
    b.add(beltGeo, 'navy');
  }
  // roof details
  addB(b, box(4.1, 0.03, 0.06), 'metal', -2.2, roofY + 0.02, 1.62);
  addB(b, box(4.1, 0.03, 0.06), 'metal', -2.2, roofY + 0.02, -1.62);
  for (const side of [1, -1]) {
    addB(b, cyl(0.022, 0.028, 0.95, 6), 'metal', -3.9, roofY + 0.48, side * 1.55);
    addB(b, sphere(0.045, 6, 5), 'metal', -3.9, roofY + 0.98, side * 1.55);
    addB(b, box(0.3, 0.03, 0.03), 'metal', -3.9, roofY + 0.8, side * 1.55);
  }
  addB(b, rbox(0.7, 0.1, 0.55, 0.03), 'metalDark', -1.05, roofY + 0.05, 0.85); // hatch
  addB(b, box(0.66, 0.03, 0.5), 'metal', -1.05, roofY + 0.01, 0.85);
  addB(b, box(0.16, 0.09, 0.14), 'glowWarm', -4.35, roofY + 0.09, 0); // warm roof light

  // ---- big satcom radome ---------------------------------------------------
  const rb = BIG_RADOME;
  addB(b, cyl(0.74, 0.82, 0.2, 20), 'metalDark', rb.x, rb.baseY + 0.1, 0);
  addB(b, cyl(0.56, 0.62, 0.34, 18), 'pearl', rb.x, rb.baseY + 0.37, 0);
  addB(b, cyl(0.5, 0.5, 0.06, 18), 'metal', rb.x, rb.baseY + 0.58, 0);
  solidB(b, sphere(rb.r, 28, 18), 'pearl', rb.x, rb.baseY + 0.56 + rb.r - 0.14, 0);
  const sphereY = rb.baseY + 0.56 + rb.r - 0.14;
  addB(b, torus(rb.r * 0.995, 0.016, 4, 40), 'metal', rb.x, sphereY, 0, [Math.PI / 2, 0, 0]);
  addB(b, disc(0.16, 14), 'metalDark', rb.x, sphereY + rb.r * 0.995, 0);
  // pedestal gussets
  for (const a of [0, Math.PI * 0.5, Math.PI, Math.PI * 1.5]) {
    const gx = rb.x + Math.cos(a) * 0.6;
    const gz = Math.sin(a) * 0.6;
    addB(b, box(0.16, 0.5, 0.05), 'metalDark', gx, rb.baseY + 0.3, gz, [0, -a, 0]);
  }
  // feed conduit from radome base toward the mast house
  addB(b, cyl(0.05, 0.05, 1.3, 6), 'metalDark', -3.6, rb.baseY + 0.12, -0.6, [0, 0, Math.PI / 2]);
}

// =============================================================================
// Sensor masts
// =============================================================================
function buildMastHouse(b) {
  const pts = taperedPlan(MAST_HOUSE.x0, MAST_HOUSE.x1, MAST_HOUSE.hw, MAST_HOUSE.hw, 0.3, 0.3);
  const geo = extrudedPlan(pts, MAST_HOUSE.y0, MAST_HOUSE.y1, 0.07);
  b.solid(geo, 'pearl');
  const capBand = extrudedPlan(scalePlan(pts, -6.45, 0, 1.02), MAST_HOUSE.y1 - 0.15, MAST_HOUSE.y1 - 0.05, 0.02);
  b.add(capBand, 'navy');
  const roofY = MAST_HOUSE.y1;
  // roof edge trim
  addB(b, box(2.2, 0.04, 2.24), 'metal', -6.45, roofY + 0.02, 0);
  // side details
  for (const side of [1, -1]) {
    addB(b, box(0.5, 0.7, 0.05), 'navy', -6.9, 2.0, side * (MAST_HOUSE.hw + 0.07));
    addB(b, box(1.9, 0.09, 0.05), 'navy', -6.45, 1.92, side * (MAST_HOUSE.hw + 0.09)); // navy base belt
    for (let i = 0; i < 3; i++) {
      addB(b, box(0.9, 0.045, 0.04), 'metalDark', -6.1, 2.2 + i * 0.09, side * (MAST_HOUSE.hw + 0.075));
    }
    addB(b, box(0.34, 0.22, 0.035), 'glowWarm', -5.75, 2.6, side * (MAST_HOUSE.hw + 0.08));
    addB(b, box(0.035, 1.7, 0.024), 'navy', -6.45, 2.1, side * (MAST_HOUSE.hw + 0.07));
  }
  // roof equipment boxes
  addB(b, rbox(0.6, 0.3, 0.5, 0.04), 'metalDark', -7.05, roofY + 0.16, 0.62);
  addB(b, rbox(0.5, 0.26, 0.44, 0.04), 'pearl', -5.9, roofY + 0.14, -0.55);
  // cable conduits between masts
  addB(b, tube([new THREE.Vector3(-7.05, roofY + 0.05, 0.3), new THREE.Vector3(-6.25, roofY + 0.05, 0.1)], 0.03, 6, 4), 'metalDark');
}

function buildMasts(b) {
  const roofY = MAST_HOUSE.y1;

  // ---------------- main comms mast ----------------------------------------
  const mx = MAST_X;
  addB(b, cyl(0.25, 0.32, 0.5, 12), 'metalDark', mx, roofY + 0.25, 0);
  addB(b, cyl(0.12, 0.2, 6.0, 10), 'pearl', mx, roofY + 3.5, 0); // 3.82 .. 9.82
  addB(b, cyl(0.055, 0.12, 4.4, 8), 'pearl', mx, roofY + 8.7, 0); // 9.82 .. 14.22
  addB(b, cyl(0.04, 0.055, 1.35, 8), 'pearl', mx, roofY + 11.575, 0); // 14.22 .. 15.57
  addB(b, cyl(0.006, 0.014, 0.55, 5), 'metal', mx, roofY + 12.425, 0); // lightning rod

  // yardarm with two small dish antennas
  addB(b, cyl(0.055, 0.08, 2.9, 8), 'metal', mx, roofY + 6.35, 0, [Math.PI / 2, 0, 0]);
  for (const side of [1, -1]) {
    addB(b, cyl(0.05, 0.05, 0.22, 8), 'metal', mx, roofY + 6.45, side * 1.32);
    const dishY = roofY + 6.58;
    addB(b, dome(0.3, 12, 5, 0.4), 'pearl', mx, dishY, side * 1.32, [-side * Math.PI / 2, 0, 0]);
    addB(b, cyl(0.015, 0.015, 0.34, 5), 'metal', mx, dishY, side * 1.44);
    addB(b, sphere(0.035, 5, 4), 'metal', mx, dishY, side * 1.58);
    // small yard light
    addB(b, box(0.07, 0.05, 0.07), 'glowWarm', mx, roofY + 6.72, side * 1.05);
  }

  // crow's-nest platform + rail
  addB(b, cyl(0.5, 0.5, 0.07, 16), 'metal', mx, roofY + 6.535, 0);
  for (const a of [0, Math.PI * 0.5, Math.PI, Math.PI * 1.5]) {
    addB(b, cyl(0.016, 0.02, 0.38, 5), 'metal', mx + Math.cos(a) * 0.42, roofY + 6.76, Math.sin(a) * 0.42);
  }
  addB(b, torus(0.42, 0.018, 4, 20), 'metal', mx, roofY + 6.95, 0, [Math.PI / 2, 0, 0]);

  // blade antennas
  const blades = [
    { y: 7.4, rot: 0.35 },
    { y: 8.3, rot: 1.4 },
    { y: 9.2, rot: 2.5 },
  ];
  for (const blade of blades) {
    const g = box(0.05, 0.8, 0.18);
    g.rotateY(blade.rot);
    g.translate(mx + Math.sin(blade.rot) * 0.16, roofY + blade.y, Math.cos(blade.rot) * 0.16);
    b.add(g, 'pearl');
  }
  // two whip antennas
  addB(b, cyl(0.008, 0.02, 1.5, 5), 'metal', mx - 0.16, roofY + 10.8, 0.1, [0, 0, 0.18]);
  addB(b, cyl(0.008, 0.018, 1.3, 5), 'metal', mx + 0.15, roofY + 11.4, -0.1, [0, 0, -0.2]);

  // weather station (anemometer + vane) just below the masthead
  const wx = mx;
  const wy = roofY + 11.15;
  addB(b, cyl(0.022, 0.03, 0.34, 5), 'metal', wx, wy + 0.17, 0);
  addB(b, cyl(0.014, 0.014, 0.62, 5), 'metal', wx, wy + 0.32, 0, [0, 0, Math.PI / 2]);
  addB(b, cyl(0.014, 0.014, 0.62, 5), 'metal', wx, wy + 0.32, 0, [Math.PI / 2, 0, 0]);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 0.4;
    addB(b, sphere(0.045, 6, 4), 'metal', wx + Math.cos(a) * 0.3, wy + 0.38, Math.sin(a) * 0.3);
  }
  addB(b, box(0.16, 0.08, 0.03), 'metal', wx, wy + 0.42, 0.24);
  addB(b, box(0.1, 0.06, 0.12), 'glowWarm', wx, wy + 0.12, -0.18);

  // masthead light + aviation beacon (beacon itself is animated)
  addB(b, box(0.12, 0.06, 0.12), 'metalDark', mx, roofY + 11.88, 0.02);
  addB(b, box(0.07, 0.07, 0.07), 'glowWarm', mx, roofY + 11.96, 0.1);
  addB(b, cyl(0.09, 0.11, 0.1, 10), 'metalDark', mx, roofY + 12.25, 0);

  // ---------------- radar tower --------------------------------------------
  const rx = RADAR_TOWER_X;
  addB(b, cyl(0.16, 0.26, 0.4, 10), 'metalDark', rx, roofY + 0.2, 0);
  addB(b, cyl(0.085, 0.16, 5.9, 8), 'metalDark', rx, roofY + 3.35, 0);
  addB(b, cyl(0.52, 0.52, 0.07, 16), 'metal', rx, roofY + 6.335, 0);
  addB(b, cyl(0.18, 0.22, 0.32, 12), 'metalDark', rx, roofY + 6.53, 0);
  // tower to mast bracing
  addB(b, cyl(0.04, 0.04, 0.92, 6), 'metalDark', (mx + rx) * 0.5, roofY + 5.6, 0, [0, 0, Math.PI / 2]);
  addB(b, cyl(0.04, 0.04, 1.15, 6), 'metalDark', (mx + rx) * 0.5 + 0.12, roofY + 3.0, 0, [0, 0, Math.PI / 2 - 0.5]);

  // stays from the mast head down to the bridge roof
  for (const side of [1, -1]) {
    addB(
      b,
      rod(
        [
          new THREE.Vector3(mx, roofY + 10.7, side * 0.1),
          new THREE.Vector3(1.0, ROOF.y1 + 0.1, side * 2.1),
        ],
        0.014,
        4,
      ),
      'metalDark',
    );
    addB(b, cyl(0.05, 0.05, 0.1, 6), 'metal', 1.0, ROOF.y1 + 0.16, side * 2.1);
  }
}

// =============================================================================
// Deck gear, lights, railings, hull fittings
// =============================================================================
function buildDeckGear(b) {
  const rng = makeRng(0x5ea51f);

  // ---- foredeck mission module bays ---------------------------------------
  for (const side of [1, -1]) {
    const cx = 9.55;
    const cz = side * 1.15;
    const cy = mainDeckY(cx, cz);
    addB(b, rbox(2.0, 0.75, 0.84, 0.07, 2), 'pearl', cx, cy + 0.125, cz);
    addB(b, box(1.82, 0.05, 0.68), 'deckGray', cx, cy + 0.5, cz);
    // panel seams
    for (const dx of [-0.62, 0, 0.62]) {
      addB(b, box(0.035, 0.04, 0.8), 'navy', cx + dx, cy + 0.53, cz);
    }
    addB(b, box(1.9, 0.035, 0.024), 'navy', cx, cy + 0.28, cz + side * 0.42);
    // orange corner marks
    for (const dx of [-0.88, 0.88]) {
      addB(b, box(0.14, 0.03, 0.12), 'signalOrange', cx + dx, cy + 0.54, cz + side * 0.26);
    }
    // silver pull handles on the walkway side
    addB(b, box(0.22, 0.04, 0.05), 'metal', cx - 0.5, cy + 0.36, cz - side * 0.44);
    addB(b, box(0.22, 0.04, 0.05), 'metal', cx + 0.5, cy + 0.36, cz - side * 0.44);
    // small vent pod
    addB(b, rbox(0.4, 0.12, 0.3, 0.03), 'metalDark', cx + 0.6, cy + 0.58, cz + side * 0.18);
  }

  // ---- windlass + anchor gear ---------------------------------------------
  const wx = 11.65;
  const wy = mainDeckY(wx, 0);
  addB(b, rbox(0.9, 0.08, 0.7, 0.02), 'metal', wx, wy + 0.04, 0);
  addB(b, cyl(0.2, 0.25, 0.4, 14), 'metalDark', wx, wy + 0.24, 0);
  addB(b, cyl(0.27, 0.27, 0.1, 16), 'metal', wx, wy + 0.09, 0);
  addB(b, box(0.26, 0.16, 0.24), 'metalDark', wx + 0.36, wy + 0.14, 0.22);
  addB(b, box(0.26, 0.16, 0.24), 'metalDark', wx + 0.36, wy + 0.14, -0.22);
  for (let i = 0; i < 4; i++) {
    addB(b, box(0.09, 0.05, 0.07), 'metalDark', wx + 0.62 + i * 0.16, wy + 0.05, 0.22);
  }
  // hawse recesses high on the bow sides
  for (const side of [1, -1]) {
    const p = hullPointAtY(12.4, 1.55, side);
    addB(b, cyl(0.1, 0.12, 0.06, 10), 'metalDark', p.x, p.y, p.z + side * 0.02, [Math.PI / 2, 0, 0]);
  }

  // ---- foredeck hatches ----------------------------------------------------
  const hatches = [
    { x: 12.95, z: -0.42, w: 0.7, d: 0.5 },
    { x: 12.2, z: 0.55, w: 0.62, d: 0.46 },
  ];
  for (const hatch of hatches) {
    const y = mainDeckY(hatch.x, hatch.z);
    addB(b, box(hatch.w + 0.08, 0.05, hatch.d + 0.08), 'metal', hatch.x, y + 0.02, hatch.z);
    addB(b, rbox(hatch.w, 0.06, hatch.d, 0.02), 'metalDark', hatch.x, y + 0.065, hatch.z);
    addB(b, box(0.1, 0.05, 0.12), 'metal', hatch.x - hatch.w * 0.3, y + 0.1, hatch.z);
    addB(b, box(0.1, 0.05, 0.12), 'metal', hatch.x + hatch.w * 0.3, y + 0.1, hatch.z);
  }

  // ---- bow jackstaff + stowed anchor --------------------------------------
  {
    const jx = 14.0;
    const jy = mainDeckY(jx, 0);
    addB(b, cyl(0.015, 0.03, 1.35, 6), 'metal', jx, jy + 0.68, 0);
    addB(b, box(0.16, 0.04, 0.16), 'metalDark', jx, jy + 0.02, 0);
    addB(b, box(0.07, 0.06, 0.07), 'glowWarm', jx, jy + 1.4, 0);
  }
  {
    const ax = 13.15;
    const az = 0.55;
    const ay = mainDeckY(ax, az);
    addB(b, box(0.09, 0.07, 0.95), 'metalDark', ax, ay + 0.045, az, [0, 0.35, 0]); // shank
    addB(b, box(0.52, 0.05, 0.08), 'metalDark', ax, ay + 0.06, az, [0, 0.35, 0]); // stock
    addB(b, box(0.26, 0.06, 0.07), 'metal', ax - 0.34, ay + 0.06, az + 0.32, [0, 0.62, 0]);
    addB(b, box(0.26, 0.06, 0.07), 'metal', ax - 0.34, ay + 0.06, az - 0.32, [0, 0.62, 0]);
    addB(b, box(0.2, 0.03, 0.14), 'metal', ax + 0.36, ay + 0.03, az, [0, 0.35, 0]);
  }

  // ---- anchor / mooring deck hardware -------------------------------------
  addB(b, box(0.36, 0.06, 0.2), 'metal', 8.3, mainDeckY(8.3, 1.2) + 0.03, 1.2);
  addB(b, cyl(0.18, 0.2, 0.34, 12), 'metalDark', 8.3, mainDeckY(8.3, 1.2) + 0.2, 1.2);

  // ---- cleats / bollards ---------------------------------------------------
  const cleatXs = [
    { x: 9.9, z: 1.52 },
    { x: 9.9, z: -1.52 },
    { x: -10.4, z: 2.3 },
    { x: -10.4, z: -2.3 },
    { x: -13.6, z: 2.3 },
    { x: -13.6, z: -2.3 },
  ];
  for (const cleat of cleatXs) {
    const y = mainDeckY(cleat.x, cleat.z);
    addB(b, rbox(0.34, 0.06, 0.2, 0.02), 'metal', cleat.x, y + 0.03, cleat.z);
    addB(b, cyl(0.05, 0.05, 0.3, 6), 'metal', cleat.x, y + 0.12, cleat.z, [Math.PI / 2, 0, 0]);
    addB(b, cyl(0.045, 0.045, 0.1, 6), 'metal', cleat.x, y + 0.17, cleat.z - 0.13);
    addB(b, cyl(0.045, 0.045, 0.1, 6), 'metal', cleat.x, y + 0.17, cleat.z + 0.13);
  }
  // two bollards on the after deck
  for (const z of [2.28, -2.28]) {
    const y = mainDeckY(-12.4, z);
    addB(b, cyl(0.11, 0.14, 0.3, 10), 'metalDark', -12.4, y + 0.15, z);
    addB(b, cyl(0.17, 0.17, 0.05, 10), 'metal', -12.4, y + 0.31, z);
  }

  // ---- side-deck LiDAR pods ------------------------------------------------
  for (const side of [1, -1]) {
    const px = -3.6;
    const pz = side * 2.2;
    const py = mainDeckY(px, pz);
    addB(b, cyl(0.3, 0.34, 0.12, 12), 'metalDark', px, py + 0.06, pz);
    addB(b, cyl(0.24, 0.26, 0.42, 14), 'pearl', px, py + 0.33, pz);
    addB(b, cyl(0.245, 0.245, 0.13, 14), 'glass', px, py + 0.5, pz);
    addB(b, cyl(0.25, 0.25, 0.02, 14), 'glowCyan', px, py + 0.575, pz);
    addB(b, cyl(0.2, 0.24, 0.07, 14), 'metalDark', px, py + 0.62, pz);
    for (const a of [0.6, 2.2, 3.8, 5.4]) {
      addB(b, sphere(0.022, 4, 3), 'metal', px + Math.cos(a) * 0.31, py + 0.13, pz + Math.sin(a) * 0.31);
    }
  }

  // ---- stern light pole ----------------------------------------------------
  {
    const pz = -2.2;
    const py = mainDeckY(-14.35, pz);
    addB(b, cyl(0.04, 0.05, 1.35, 6), 'metal', -14.35, py + 0.67, pz);
    addB(b, box(0.1, 0.1, 0.16), 'glowWarm', -14.35, py + 1.38, pz);
    addB(b, box(0.14, 0.06, 0.2), 'metalDark', -14.35, py + 1.3, pz);
  }

  // ---- environmental sensor rods on deck ----------------------------------
  for (const side of [1, -1]) {
    const sx = -10.55;
    const sz = side * 1.15;
    const sy = PLATFORM.y1;
    addB(b, cyl(0.02, 0.026, 0.75, 5), 'metal', sx, sy + 0.38, sz);
    addB(b, box(0.26, 0.025, 0.025), 'metal', sx, sy + 0.6, sz);
    addB(b, sphere(0.04, 5, 4), 'metal', sx, sy + 0.77, sz);
  }

  // ---- fenders (segmented rubber) + lines ---------------------------------
  const fenderXs = [-13.4, -11.2, -8.6, -5.8, -3.0, 0.4, 3.4, 6.2];
  for (const side of [1, -1]) {
    for (const baseX of fenderXs) {
      const x = baseX + rng.range(-0.22, 0.22);
      const p = hullPointAtY(x, 0.86, side);
      const cz = p.z + side * 0.16;
      addB(b, cyl(0.145, 0.145, 0.55, 10), 'rubber', x, 0.86, cz);
      addB(b, sphere(0.145, 8, 5), 'rubber', x, 1.13, cz, [0, 0, 0]);
      addB(b, sphere(0.145, 8, 5), 'rubber', x, 0.59, cz, [0, 0, 0]);
      // fender line up to the rail
      const top = hullDeckEdge(x);
      addB(
        b,
        rod(
          [
            new THREE.Vector3(x, 1.16, cz),
            new THREE.Vector3(top.x, top.y + 0.04, side * (top.z - 0.2)),
          ],
          0.012,
          4,
        ),
        'metalDark',
      );
    }
  }

  // ---- hull drain ports / small through-hull details ----------------------
  for (const side of [1, -1]) {
    for (const x of [-11.4, -7.0, -2.4, 2.2, 6.6, 10.2]) {
      const p = hullPointAtY(x, 0.58, side);
      addB(b, cyl(0.05, 0.05, 0.035, 8), 'metalDark', p.x, p.y, p.z + side * 0.025, [Math.PI / 2, 0, 0]);
    }
  }
}

function buildLights(b) {
  // ---- port / starboard navigation lights near the bow ---------------------
  const navX = 11.9;
  for (const side of [1, -1]) {
    const p = hullDeckEdge(navX);
    const pz = side * (p.z - 0.16);
    const py = mainDeckY(navX, pz);
    addB(b, rbox(0.26, 0.2, 0.22, 0.03), 'pearl', navX, py + 0.14, pz);
    addB(b, box(0.16, 0.1, 0.04), side > 0 ? 'glowGreen' : 'glowRed', navX, py + 0.16, pz + side * 0.12);
    // small shield / brow over the lamp
    addB(b, box(0.3, 0.04, 0.26), 'metalDark', navX, py + 0.26, pz);
    // short guard rail around the lamp pod
    addB(b, cyl(0.016, 0.016, 0.26, 4), 'metal', navX - 0.14, py + 0.34, pz);
  }

  // ---- cyan under-rail marker dots ---------------------------------------
  for (const side of [1, -1]) {
    for (let i = 0; i < 9; i++) {
      const x = lerp(10.6, -13.6, i / 8);
      const p = hullSurfacePoint(MAIN, hullU(x), 1, side);
      addB(b, box(0.1, 0.05, 0.09), 'glowCyan', p.x, p.y + 0.06, p.z - side * 0.2);
    }
  }

  // ---- warm work lights on deck / hangar ---------------------------------
  // bridge front floodlights (mounted on the raked visor face)
  for (const side of [1, -1]) {
    addB(b, box(0.07, 0.16, 0.2), 'metalDark', 6.9, 2.0, side * 0.8);
    addB(b, box(0.16, 0.1, 0.14), 'glowWarm', 6.95, 2.0, side * 0.8);
  }
  // hangar front work lights
  for (const side of [1, -1]) {
    addB(b, box(0.07, 0.16, 0.2), 'metalDark', HANGAR.x1 + 0.1, 2.75, side * 1.5);
    addB(b, box(0.16, 0.1, 0.14), 'glowWarm', HANGAR.x1 + 0.16, 2.75, side * 1.5);
  }

  // ---- cyan accent dots ---------------------------------------------------
  addB(b, box(0.12, 0.04, 0.12), 'glowCyan', 0.28, 5.97, 0); // roof mast base
  for (const side of [1, -1]) {
    addB(b, box(0.09, 0.05, 0.09), 'glowCyan', 4.7, 3.52, side * 2.44); // wing tips
    addB(b, box(0.07, 0.04, 0.07), 'glowCyan', HANGAR.x0 + 0.2, HANGAR.y1 + 0.03, side * 1.9);
  }
}

function buildRailings(b) {
  const n = 26;
  const xBow = 12.6;
  const xStern = -14.2;
  for (const side of [1, -1]) {
    const base = [];
    for (let i = 0; i <= n; i++) {
      const x = lerp(xBow, xStern, i / n);
      const p = hullSurfacePoint(MAIN, hullU(x), 1, side);
      base.push(new THREE.Vector3(p.x, p.y + 0.02, p.z - side * 0.16));
    }
    for (const dy of [0.78, 0.44]) {
      const railPts = base.map((p) => new THREE.Vector3(p.x, p.y + dy, p.z));
      b.add(tube(railPts, dy > 0.6 ? 0.032 : 0.023, 46, 5), 'metal');
    }
    for (let i = 0; i <= n; i += 2) {
      const p = base[i];
      b.add(cyl(0.03, 0.042, 0.78, 6), 'metal', { pos: [p.x, p.y + 0.39, p.z] });
      b.add(box(0.13, 0.035, 0.13), 'metal', { pos: [p.x, p.y + 0.018, p.z] });
      // recessed socket
      b.add(cyl(0.055, 0.055, 0.02, 8), 'metalDark', { pos: [p.x, p.y + 0.006, p.z] });
    }
  }
}

// =============================================================================
// Animated sub-assemblies (dynamic groups)
// =============================================================================
function buildDynamics(b, materials) {
  const roofY = MAST_HOUSE.y1;

  // --- rotating maritime radar (1 merged mesh) ------------------------------
  const radar = b.dynamic('radar');
  radar.position.set(RADAR_TOWER_X, roofY + 6.69, 0);
  const radarGeo = mergeMesh([
    [rbox(0.16, 0.2, 1.42, 0.05), { pos: [0, 0.11, 0] }],
    [cyl(0.13, 0.16, 0.2, 12), { pos: [0, -0.02, 0] }],
    [rbox(0.13, 0.16, 0.08, 0.03), { pos: [0, 0.11, 0.7] }],
    [rbox(0.13, 0.16, 0.08, 0.03), { pos: [0, 0.11, -0.7] }],
    [box(0.06, 0.05, 0.22), { pos: [0, 0.02, 0] }],
  ]);
  const radarMesh = new THREE.Mesh(radarGeo, materials.metalDark);
  radarMesh.name = 'flagship-radar-bar';
  radar.add(radarMesh);

  // --- EO ball gimbal (white yoke is static, ball pitches inside) -----------
  const eoX = 6.0 + UPPER.shear * (ROOF.y1 - UPPER.y0);
  const gimbal = b.dynamic('gimbal');
  gimbal.position.set(eoX, ROOF.y1 + 0.52, 0);
  const gimbalPitch = new THREE.Group();
  gimbalPitch.position.set(0, 0.02, 0);
  gimbal.add(gimbalPitch);
  const ballGeo = new THREE.Mesh(sphere(0.42, 22, 16), materials.glass);
  ballGeo.name = 'flagship-eo-ball';
  gimbalPitch.add(ballGeo);
  // lens barrel + protective rim merged into one mesh
  const lensBarrel = cyl(0.17, 0.19, 0.14, 14);
  lensBarrel.rotateZ(-Math.PI / 2);
  const lensRim = torus(0.2, 0.028, 5, 16);
  lensRim.rotateY(Math.PI / 2);
  const lensGeo = mergeMesh([
    [lensBarrel, { pos: [0.37, 0, 0] }],
    [lensRim, { pos: [0.4, 0, 0] }],
  ]);
  const lens = new THREE.Mesh(lensGeo, materials.metalDark);
  lens.name = 'flagship-eo-lens';
  gimbalPitch.add(lens);

  // --- blinking aviation beacon on the mast top ----------------------------
  const beacon = b.dynamic('beacon');
  beacon.position.set(MAST_X, roofY + 12.4, 0);
  const beaconMesh = new THREE.Mesh(sphere(0.085, 10, 8), materials.glowRed);
  beaconMesh.name = 'flagship-beacon';
  beacon.add(beaconMesh);

  return { radar, gimbal, gimbalPitch, beacon, beaconMesh };
}

// =============================================================================
// Public factory
// =============================================================================
export function createFlagship(materials) {
  const b = new Builder(materials, { outlineMaterial: materials.outlineBoat });

  buildMainHull(b);
  buildFloats(b);
  buildCrossArms(b);
  buildSuperstructure(b);
  buildHangar(b);
  buildAftPlatform(b);
  buildAftDeckhouse(b);
  buildMastHouse(b);
  buildMasts(b);
  buildDeckGear(b);
  buildLights(b);
  buildRailings(b);

  const dyn = buildDynamics(b, materials);
  const group = b.build();
  group.name = 'flagship';
  group.userData.type = 'flagship';

  // --- deterministic subtle animation drivers ------------------------------
  let radarAngle = 0;
  let beaconPhase = 0;
  let timeS = 0;

  function update(time, dt) {
    const step = Number.isFinite(dt) ? Math.min(Math.max(dt, 0), 0.1) : 0;
    timeS = Number.isFinite(time) ? time : timeS + step;

    // maritime radar: steady 0.7 rad/s sweep
    radarAngle += 0.7 * step;
    dyn.radar.rotation.y = radarAngle;

    // EO ball: slow search pattern (yaw + pitch), visible through the yoke
    dyn.gimbal.rotation.y = Math.sin(timeS * 0.21) * 0.6 + Math.sin(timeS * 0.53) * 0.07;
    dyn.gimbalPitch.rotation.z = -0.1 + Math.sin(timeS * 0.31 + 1.1) * 0.24;

    // aviation beacon: 1.3 s period with a short bright flash
    beaconPhase = (timeS % 1.3) / 1.3;
    dyn.beaconMesh.visible = beaconPhase < 0.13;
  }

  return {
    type: 'flagship',
    length: 30,
    beam: BEAM,
    draft: 1.7,
    group,
    update,
    wake: { length: 30, beam: BEAM, wakeWidth: 11.5, wakeStrength: 1.0 },
  };
}
