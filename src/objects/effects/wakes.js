// =============================================================================
// OceanSwarm — wakes & water interaction (the fleet's signature motion FX).
//
// Per vessel we keep two ring buffers of WORLD-space stern positions:
//   * dense : 32 samples @ 0.1 s  (smooth curves close behind the transom)
//   * sparse: 84 samples @ 0.5 s  (long, gently widening tail out to ~25 s)
// From those we rebuild, in place, two persistent BufferGeometries per boat:
//
//   1) stern-trail mesh   : one ribbon over the dense+sparse history
//                           (+ two thin secondary prop-wash ribbons for the
//                           flagship / fast scouts)
//   2) bow-interaction mesh: the two diverging V bow-wave ribbons, the foam
//                           collar ellipse right at the bow waterline, the two
//                           hull-side waterline foam lines, the stern prop-wash
//                           patch and the flagship's wide churned field.
//
// Everything is shaded by ONE shared procedural foam ShaderMaterial (no
// textures): animated value-noise fbm, bright centre line + two edge streaks,
// feathered edges, warm low-sun colour with cool shadow tint, age/distance
// fading, and a soft shimmer. Ribbon vertices are snapped onto the animated
// CPU wave field (same WAVES as the ocean shader) so the foam rides the water
// and follows its local slope instead of cutting through it.
//
// Integration contract (owned by main):
//   const wakes = createWakes(fleet);            // fleet = boat objects
//   scene.add(wakes.group);
//   // every frame, after scene.updateMatrixWorld():
//   wakes.update(time, dt);
//
// No allocations inside update(): all buffers are preallocated per boat.
// Triangle budget: ~94 tris / boat trail, ~158 tris / boat bow mesh.
// Draw calls: 2 per boat (34 total).
// =============================================================================
import * as THREE from 'three';
import { BOAT_CLASS, COLORS, FORMATION, WORLD } from '../../config.js';
import { WAVES } from '../../core/waves.js';

// ---------------------------------------------------------------------------
// tuning
// ---------------------------------------------------------------------------
const TAU = Math.PI * 2;

const NEAR = 32; // dense stern samples kept (one per 0.1 s => ~3.1 s)
const TAIL = 14; // decimated tail sections (sparse history, up to WAKE_AGE)
const SEC = NEAR + TAIL; // ribbon cross-sections
const SSEC = 8; // sections per secondary prop-wash ribbon
const NEAR_DT = 0.1;
const LONG_DT = 0.5;
const LONGN = 128; // 64 s of sparse stern history

const ARM_SEC = 12; // sections per bow V arm
const HULL_SEC = 10; // sections per hull-side foam line
const COLLAR_SEG = 10;
const PROP_SEG = 8;
const CHURN_SEG = 8;

const Y_TRAIL = 0.075; // metres above the wave surface (never z-fights)
const Y_BOW = 0.068;
const Y_PATCH = 0.12;

const BOW_VERTS = 2 * (2 * ARM_SEC) + (1 + 2 * COLLAR_SEG) + 2 * (2 * HULL_SEC) + (1 + 2 * PROP_SEG) + (1 + 2 * CHURN_SEG);

// per-type wake personality (kept deliberately close to BOAT_CLASS values)
const WAKE_TYPES = {
  flagship: { trailMax: 2.6, bowLen: 2.6, bowStrength: 1.35, armWidth: 1.5, collar: 1.75, propwash: 1.6, churn: 1.3, secondary: true },
  scout: { trailMax: 3.1, bowLen: 3.2, bowStrength: 2.1, armWidth: 1.15, collar: 1.45, propwash: 1.75, churn: 0.7, secondary: true },
  env: { trailMax: 2.8, bowLen: 2.5, bowStrength: 1.3, armWidth: 1.3, collar: 1.25, propwash: 1.2, churn: 0.35, secondary: false },
  survey: { trailMax: 2.7, bowLen: 2.3, bowStrength: 1.2, armWidth: 1.3, collar: 1.2, propwash: 1.1, churn: 0.3, secondary: false },
  patrol: { trailMax: 2.9, bowLen: 2.7, bowStrength: 1.45, armWidth: 1.25, collar: 1.35, propwash: 1.35, churn: 0.45, secondary: false },
  comms: { trailMax: 2.6, bowLen: 2.2, bowStrength: 1.1, armWidth: 1.3, collar: 1.1, propwash: 1.0, churn: 0.2, secondary: false },
  energy: { trailMax: 2.55, bowLen: 2.1, bowStrength: 1.0, armWidth: 1.3, collar: 1.05, propwash: 0.95, churn: 0.16, secondary: false },
  rescue: { trailMax: 2.8, bowLen: 2.6, bowStrength: 1.35, armWidth: 1.25, collar: 1.25, propwash: 1.2, churn: 0.35, secondary: false },
};

// ---------------------------------------------------------------------------
// tiny helpers (local so this module stays self-contained)
// ---------------------------------------------------------------------------
function clamp(v, a, b) {
  return v < a ? a : v > b ? b : v;
}
function hash01(n) {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

// Non-allocating sample of the shared CPU wave field (identical math to
// core/waves.js sampleWave, but writes into a reusable record).
const _wave = { h: 0, dx: 0, dz: 0 };
function waveAt(x, z, t) {
  let h = 0;
  let dx = 0;
  let dz = 0;
  for (let i = 0; i < WAVES.length; i++) {
    const w = WAVES[i];
    const ph = w.k * (w.dir[0] * x + w.dir[1] * z) - w.omega * t + w.phase;
    const s = Math.sin(ph);
    const c = Math.cos(ph);
    h += w.amp * s;
    dx += w.amp * w.k * w.dir[0] * c;
    dz += w.amp * w.k * w.dir[1] * c;
  }
  _wave.h = h;
  _wave.dx = dx;
  _wave.dz = dz;
  return _wave;
}

/** Approximate waterline half beam of the classed hulls (only used to place
 *  the hull-side foam line a little outside the hull). */
function hullHalfBeam(length, beam, u) {
  const stern = 0.86;
  const wide = stern + (1 - stern) * Math.sin(Math.PI * clamp(u * 0.92, 0, 1));
  const taper = Math.pow(Math.max(0, 1 - Math.pow(Math.max(u, 0), 2.2)), 0.52);
  return beam * 0.5 * wide * taper;
}

// ---------------------------------------------------------------------------
// procedural foam shader (shared by every wake mesh)
// ---------------------------------------------------------------------------
const FOAM_VERT = /* glsl */ `
attribute vec4 aInfo;   // x = age (s), y = seed, z = strength, w = kind
attribute float aAge01; // normalised age / along-parameter (per piece)

varying vec2 vUv;
varying vec3 vWorldPos;
varying vec3 vNormal;
varying vec4 vInfo;
varying float vAge01;

void main() {
  vUv = uv;
  vInfo = aInfo;
  vAge01 = aAge01;
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorldPos = world.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const FOAM_FRAG = /* glsl */ `
uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uFoamColor;
uniform vec3 uWarmTint;
uniform vec3 uCoolTint;
uniform vec3 uHaze;
uniform float uFadeNear;
uniform float uFadeFar;

varying vec2 vUv;
varying vec3 vWorldPos;
varying vec3 vNormal;
varying vec4 vInfo;
varying float vAge01;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash12(i);
  float b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0));
  float d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float fbm3(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 3; i++) {
    s += a * vnoise(p);
    p = p * 2.07 + vec2(9.1, 3.7);
    a *= 0.5;
  }
  return s;
}

float fbm2(vec2 p) {
  return 0.6667 * vnoise(p) + 0.3333 * vnoise(p * 2.03 + vec2(4.7, 1.3));
}

void main() {
  float kind = vInfo.w;
  float seed = vInfo.y;
  float strength = vInfo.z;
  float age = vInfo.x;

  // ---- animated, world-anchored foam field (flows aft behind the boats) ----
  vec2 p = vWorldPos.xz;
  vec2 so = vec2(seed * 43.71, seed * 17.13);
  vec2 flow = vec2(uTime * 0.50, uTime * 0.055);

  float nA = fbm3(p * 0.40 + so + flow * 0.5);
  float nB = fbm2(p * 1.30 - so * 0.7 + vec2(-flow.x * 0.8, flow.y * 1.4));
  float nC = vnoise(p * 4.4 + so.yx + flow * 2.2);
  float field = nA * 0.58 + nB * 0.29 + nC * 0.13;
  float bubbles = smoothstep(0.46, 0.74, field);
  float sparkle = smoothstep(0.78, 0.94, nC * 0.6 + field * 0.55);

  // large drifting patches of thin/thick foam + small local gaps: keeps the
  // wake from reading as one uniform white sheet
  float patchN = fbm2(p * 0.21 + so * 1.3 + flow * 0.30);
  float foamPatch = 0.58 + 0.80 * smoothstep(0.30, 0.74, patchN);
  float gapN = vnoise(p * 7.0 + so.yx + flow * 3.0);
  float gaps = 1.0 - 0.68 * smoothstep(0.70, 0.92, gapN);

  float mask = 0.0;
  float crest = 0.0;

  if ((kind > 1.5 && kind < 2.5) || (kind > 3.5 && kind < 5.5)) {
    // ==================== radial patches ====================
    // 2 = bow foam collar, 4 = stern prop-wash patch, 5 = churned field
    float radial = vUv.y;
    float ang = vUv.x * 6.2831853;
    float front = 0.5 + 0.5 * cos(ang);
    if (kind < 2.5) {
      float band = smoothstep(1.0, 0.52, radial) * smoothstep(0.0, 0.34, radial);
      mask = band * (0.25 + 0.9 * smoothstep(0.30, 0.86, field)) * (0.25 + 0.95 * front);
      mask *= 0.8 + 0.5 * bubbles;
      crest = band * (0.35 + 0.65 * front);
    } else if (kind < 4.5) {
      float edge = smoothstep(1.0, 0.58, radial);
      mask = edge * (0.18 + 1.0 * smoothstep(0.34, 0.82, field)) * (0.5 + 0.75 * bubbles);
      crest = edge * 0.5;
    } else {
      float edge = smoothstep(1.0, 0.42, radial);
      mask = edge * (0.08 + 0.65 * smoothstep(0.22, 0.80, field)) * (0.55 + 0.55 * bubbles);
      crest = edge * 0.25;
    }
  } else {
    // ==================== ribbons ====================
    // 0 = stern trail, 1 = bow V arm, 3 = hull-side foam line, 6 = secondary trail
    float v = vUv.y;
    float along = vUv.x;
    float dc = (v - 0.5) / 0.155;
    float da = (v - 0.10) / 0.045;
    float db = (v - 0.90) / 0.045;
    float dcore = (v - 0.5) / 0.34;
    float centre = exp(-dc * dc);
    float streak = exp(-da * da) + exp(-db * db);
    float feather = smoothstep(0.0, 0.06, v) * smoothstep(1.0, 0.94, v);
    float body = 0.05 + 0.88 * centre + 0.62 * streak;
    float f = smoothstep(0.30, 0.86, field + (centre + streak * 0.8) * 0.18);
    mask = body * feather * (0.20 + 1.08 * f);

    if (kind < 0.5) {
      // stern trail: fades in over the first metres, then decays with age
      mask *= smoothstep(0.0, 1.15, age) * (1.0 - smoothstep(0.18, 1.0, vAge01) * 0.90);
      mask *= 1.0 + 0.22 * (1.0 - smoothstep(0.0, 0.16, vAge01));
    } else if (kind < 1.5) {
      // bow V arm: sharp near the stem, tapers and fades aft
      mask *= smoothstep(0.015, 0.12, along) * (1.0 - smoothstep(0.42, 1.0, along));
      mask *= 1.35;
      crest = centre * 0.7;
    } else if (kind < 3.5) {
      // hull-side foam line: thin, lapping, fades towards the stern
      float core = exp(-dcore * dcore);
      float fe2 = smoothstep(0.0, 0.22, v) * smoothstep(1.0, 0.78, v);
      mask = core * fe2 * (0.28 + 0.95 * smoothstep(0.30, 0.88, field));
      mask *= smoothstep(0.0, 0.12, along) * (1.0 - smoothstep(0.55, 1.0, along));
      mask *= 0.85 + 0.35 * sin(uTime * 2.1 + along * 8.0 + seed * 13.0);
      crest = core * 0.5;
    } else {
      // secondary prop-wash ribbons
      mask *= smoothstep(0.0, 0.9, age) * (1.0 - smoothstep(0.25, 0.9, vAge01) * 0.9);
      mask *= 0.72;
    }
  }

  // ---- patchy density (drifting thick/thin areas + small holes) ----
  mask *= foamPatch * gaps;

  // ---- shading: warm low sun over cool foam shadow ----
  vec3 N = normalize(vNormal);
  float sunDot = clamp(dot(N, uSunDir), 0.0, 1.0);
  float lit = clamp(mask * 1.15 + crest * 0.3 + bubbles * 0.22, 0.0, 1.0);
  vec3 tint = mix(uCoolTint, uWarmTint, clamp(0.26 + 0.74 * sunDot + (patchN - 0.5) * 0.22, 0.0, 1.0));
  vec3 col = mix(tint, uFoamColor, clamp(0.20 + 0.55 * lit, 0.0, 0.82));
  col += uSunColor * pow(lit, 2.6) * 0.14 * (0.35 + 0.65 * sunDot);
  col += uSunColor * sparkle * (0.08 + 0.18 * lit);

  // ---- alpha: foam breakup, shimmer, atmospheric fade ----
  // kept fairly sheer: the wake must read as aerated water, not white paint.
  float alpha = mask * strength * 0.90;
  alpha *= 0.40 + 0.60 * bubbles;
  alpha *= 0.94 + 0.06 * sin(uTime * 1.7 + seed * 37.0 + age * 0.8);

  float camDist = distance(cameraPosition, vWorldPos);
  float haze = smoothstep(uFadeNear, uFadeFar, camDist);
  alpha *= 1.0 - haze;
  col = mix(col, uHaze, haze * 0.35);

  alpha = clamp(alpha, 0.0, 0.88);
  if (alpha < 0.004) discard;

  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

function createFoamMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uSunDir: { value: WORLD.sunDirection.clone() },
      uSunColor: { value: new THREE.Color(COLORS.skySun) },
      uFoamColor: { value: new THREE.Color(COLORS.foam) },
      uWarmTint: { value: new THREE.Color(COLORS.foamWarm) },
      uCoolTint: { value: new THREE.Color(0x9fbfcf) },
      uHaze: { value: new THREE.Color(WORLD.fogColor) },
      uFadeNear: { value: 1200 },
      uFadeFar: { value: 4200 },
    },
    vertexShader: FOAM_VERT,
    fragmentShader: FOAM_FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    blending: THREE.NormalBlending,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -2,
    fog: false,
    toneMapped: true,
  });
}

// ---------------------------------------------------------------------------
// geometry construction — every static attribute (uv / kind / seed / strength /
// indices) is baked once; only position, normal, aInfo.x (age) and aAge01 are
// dynamic per frame.
// ---------------------------------------------------------------------------
function pushStripIndices(indices, base, sections) {
  for (let i = 0; i < sections - 1; i++) {
    const a = base + i * 2;
    indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
}

function makeDynamicAttrs(count) {
  return {
    position: new THREE.BufferAttribute(new Float32Array(count * 3), 3),
    normal: new THREE.BufferAttribute(new Float32Array(count * 3), 3),
  };
}

function makeTrailGeometry(seed, strength, withSecondary) {
  const verts = SEC * 2 + (withSecondary ? 2 * SSEC * 2 : 0);
  const positions = new Float32Array(verts * 3);
  const normals = new Float32Array(verts * 3);
  const uv = new Float32Array(verts * 2);
  const info = new Float32Array(verts * 4);
  const age01 = new Float32Array(verts);
  const indices = [];

  for (let i = 0; i < SEC; i++) {
    const u = i / (SEC - 1);
    for (let s = 0; s < 2; s++) {
      const vi = i * 2 + s;
      uv[vi * 2] = u;
      uv[vi * 2 + 1] = s;
      info[vi * 4] = 0;
      info[vi * 4 + 1] = seed;
      info[vi * 4 + 2] = strength;
      info[vi * 4 + 3] = 0;
    }
  }
  pushStripIndices(indices, 0, SEC);

  if (withSecondary) {
    for (let r = 0; r < 2; r++) {
      const base = SEC * 2 + r * SSEC * 2;
      for (let j = 0; j < SSEC; j++) {
        const u = j / (SSEC - 1);
        for (let s = 0; s < 2; s++) {
          const vi = base + j * 2 + s;
          uv[vi * 2] = u;
          uv[vi * 2 + 1] = s;
          info[vi * 4] = 0;
          info[vi * 4 + 1] = seed;
          info[vi * 4 + 2] = strength * 0.85;
          info[vi * 4 + 3] = 6;
        }
      }
      pushStripIndices(indices, base, SSEC);
    }
  }

  const geometry = new THREE.BufferGeometry();
  const position = new THREE.BufferAttribute(positions, 3);
  const normal = new THREE.BufferAttribute(normals, 3);
  position.setUsage(THREE.DynamicDrawUsage);
  normal.setUsage(THREE.DynamicDrawUsage);
  const uvAttr = new THREE.BufferAttribute(uv, 2);
  const infoAttr = new THREE.BufferAttribute(info, 4);
  const ageAttr = new THREE.BufferAttribute(age01, 1);
  infoAttr.setUsage(THREE.DynamicDrawUsage);
  ageAttr.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('position', position);
  geometry.setAttribute('normal', normal);
  geometry.setAttribute('uv', uvAttr);
  geometry.setAttribute('aInfo', infoAttr);
  geometry.setAttribute('aAge01', ageAttr);
  geometry.setIndex(indices);

  return {
    geometry,
    verts,
    position,
    normal,
    info,
    age01,
    posArray: positions,
    norArray: normals,
    infoArray: info,
    ageArray: age01,
  };
}

function makeBowGeometry(length, beam, params, seed, strength, wakeWidth) {
  const positions = new Float32Array(BOW_VERTS * 3);
  const normals = new Float32Array(BOW_VERTS * 3);
  const uv = new Float32Array(BOW_VERTS * 2);
  const info = new Float32Array(BOW_VERTS * 4);
  const age01 = new Float32Array(BOW_VERTS);
  const local = new Float32Array(BOW_VERTS * 2); // local (x, z) of every vertex
  const indices = [];
  const strips = [];
  const patches = [];
  let cursor = 0;

  function writeVert(lx, lz, u, v, kind, strengthMul) {
    const vi = cursor++;
    local[vi * 2] = lx;
    local[vi * 2 + 1] = lz;
    uv[vi * 2] = u;
    uv[vi * 2 + 1] = v;
    info[vi * 4] = 0;
    info[vi * 4 + 1] = seed;
    info[vi * 4 + 2] = strengthMul;
    info[vi * 4 + 3] = kind;
    age01[vi] = 0;
  }

  // ---- two diverging V bow-wave ribbons -----------------------------------
  const armLen = length * params.bowLen;
  const latStart = beam * 0.27;
  const latEnd = wakeWidth * params.trailMax * 0.5;
  for (let side = -1; side <= 1; side += 2) {
    const start = cursor;
    const clx = new Float32Array(ARM_SEC);
    const clz = new Float32Array(ARM_SEC);
    for (let k = 0; k < ARM_SEC; k++) {
      const t = k / (ARM_SEC - 1);
      const aft = armLen * Math.pow(t, 1.05);
      const lat = latStart + (latEnd - latStart) * Math.pow(t, 0.85);
      clx[k] = length * 0.42 - aft;
      clz[k] = side * lat;
    }
    const cax = new Float32Array(ARM_SEC);
    const caz = new Float32Array(ARM_SEC);
    const chw = new Float32Array(ARM_SEC);
    for (let k = 0; k < ARM_SEC; k++) {
      const kp = k > 0 ? k - 1 : k;
      const kn = k < ARM_SEC - 1 ? k + 1 : k;
      let tx = clx[kp] - clx[kn];
      let tz = clz[kp] - clz[kn];
      const tl = Math.hypot(tx, tz) || 1;
      cax[k] = -tz / tl;
      caz[k] = tx / tl;
        const t = k / (ARM_SEC - 1);
      chw[k] = (0.52 + length * 0.032) * params.armWidth * (1 - 0.45 * Math.pow(t, 1.6));
    }
    for (let k = 0; k < ARM_SEC; k++) {
      const t = k / (ARM_SEC - 1);
      const w = chw[k];
      writeVert(clx[k] - cax[k] * w, clz[k] - caz[k] * w, t, 0, 1, strength * params.bowStrength);
      writeVert(clx[k] + cax[k] * w, clz[k] + caz[k] * w, t, 1, 1, strength * params.bowStrength);
    }
    pushStripIndices(indices, start, ARM_SEC);
    strips.push({ start, sections: ARM_SEC, clx, clz, cax, caz, chw, yOff: Y_BOW });
  }

  // ---- hull-side waterline foam lines -------------------------------------
  for (let side = -1; side <= 1; side += 2) {
    const start = cursor;
    const clx = new Float32Array(HULL_SEC);
    const clz = new Float32Array(HULL_SEC);
    const cax = new Float32Array(HULL_SEC);
    const caz = new Float32Array(HULL_SEC);
    const chw = new Float32Array(HULL_SEC);
    for (let k = 0; k < HULL_SEC; k++) {
      const t = k / (HULL_SEC - 1);
      const u = 0.62 - 0.57 * t;
      clx[k] = (u - 0.5) * length;
      clz[k] = side * (hullHalfBeam(length, beam, u) * 0.95 + 0.22);
      cax[k] = 0;
      caz[k] = 1;
      chw[k] = 0.2 + length * 0.006;
    }
    for (let k = 0; k < HULL_SEC; k++) {
      const t = k / (HULL_SEC - 1);
      writeVert(clx[k] - cax[k] * chw[k], clz[k] - caz[k] * chw[k], t, 0, 3, strength * 0.85);
      writeVert(clx[k] + cax[k] * chw[k], clz[k] + caz[k] * chw[k], t, 1, 3, strength * 0.85);
    }
    pushStripIndices(indices, start, HULL_SEC);
    strips.push({ start, sections: HULL_SEC, clx, clz, cax, caz, chw, yOff: Y_BOW });
  }

  // ---- flat radial foam patches -------------------------------------------
  function addPatch(cx, cz, rx, rz, seg, kind, strengthMul) {
    const start = cursor;
    writeVert(cx, cz, 0, 0, kind, strengthMul);
    for (let r = 0; r < 2; r++) {
      const rr = r === 0 ? 0.55 : 1.0;
      for (let j = 0; j < seg; j++) {
        const a = (j / seg) * TAU;
        writeVert(cx + Math.cos(a) * rx * rr, cz + Math.sin(a) * rz * rr, j / seg, rr, kind, strengthMul);
      }
    }
    const c = start;
    const r0 = start + 1;
    const r1 = start + 1 + seg;
    for (let j = 0; j < seg; j++) {
      const j2 = (j + 1) % seg;
      indices.push(c, r0 + j, r0 + j2);
      indices.push(r0 + j, r1 + j, r1 + j2);
      indices.push(r0 + j, r1 + j2, r0 + j2);
    }
    patches.push({ start, verts: 1 + 2 * seg });
  }

  addPatch(length * 0.33, 0, length * 0.21, beam * 0.58, COLLAR_SEG, 2, strength * params.collar);
  addPatch(-length * 0.58, 0, length * 0.22, beam * 0.42, PROP_SEG, 4, strength * params.propwash);
  if (params.churn > 0.05) {
    addPatch(-length * 0.32, 0, length * 0.5, beam * 0.95, CHURN_SEG, 5, strength * params.churn);
  }

  const geometry = new THREE.BufferGeometry();
  const position = new THREE.BufferAttribute(positions, 3);
  const normal = new THREE.BufferAttribute(normals, 3);
  position.setUsage(THREE.DynamicDrawUsage);
  normal.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('position', position);
  geometry.setAttribute('normal', normal);
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geometry.setAttribute('aInfo', new THREE.BufferAttribute(info, 4));
  geometry.setAttribute('aAge01', new THREE.BufferAttribute(age01, 1));
  geometry.setIndex(indices);

  return { geometry, verts: cursor, position, normal, posArray: positions, norArray: normals, local, strips, patches };
}

// ---------------------------------------------------------------------------
// per-boat state
// ---------------------------------------------------------------------------
function createBoatState(boat, index, material) {
  const type = boat.type || 'env';
  const cls = BOAT_CLASS[type] || BOAT_CLASS.env;
  const wakeMeta = boat.wake || {};
  const length = boat.length || wakeMeta.length || cls.length;
  const beam = boat.beam || wakeMeta.beam || cls.beam;
  const wakeWidth = wakeMeta.wakeWidth || cls.wakeWidth;
  const strength = wakeMeta.wakeStrength || cls.wakeStrength;
  const params = WAKE_TYPES[type] || WAKE_TYPES.env;

  const seed = hash01(index * 7.31 + 0.37);
  const ageMax = clamp(18 + length * 1.15, 28, 55);

  const st = {
    boat,
    type,
    L: length,
    B: beam,
    wakeWidth,
    strength,
    params,
    seed,
    ageMax,
    trailMax: params.trailMax,
    hasSecondary: !!params.secondary,
    initialized: false,
    // ring buffers (world-space stern positions)
    nearX: new Float32Array(NEAR),
    nearZ: new Float32Array(NEAR),
    nearT: new Float32Array(NEAR),
    nearW: 0,
    nearAcc: index * 0.011,
    longX: new Float32Array(LONGN),
    longZ: new Float32Array(LONGN),
    longT: new Float32Array(LONGN),
    longW: 0,
    longAcc: (index % 5) * 0.11,
  };

  // stern-trail mesh -------------------------------------------------------
  const trail = makeTrailGeometry(seed, strength, st.hasSecondary);
  const trailMesh = new THREE.Mesh(trail.geometry, material);
  trailMesh.name = `${boat.id || type}-wake`;
  trailMesh.frustumCulled = false;
  trailMesh.renderOrder = 3;
  st.trail = trail;
  st.trailMesh = trailMesh;

  // bow-interaction mesh ---------------------------------------------------
  const bow = makeBowGeometry(length, beam, params, seed, strength, wakeWidth);
  st.bow = bow;
  // scratch attributes for the bow mesh
  bow.uvStatic = true;
  const bowMesh = new THREE.Mesh(bow.geometry, material);
  bowMesh.name = `${boat.id || type}-bowfoam`;
  bowMesh.frustumCulled = false;
  bowMesh.renderOrder = 3;
  st.bowMesh = bowMesh;

  return st;
}

// module-level scratch buffers (reused by every boat — no per-frame alloc)
const secWX = new Float32Array(SEC);
const secWZ = new Float32Array(SEC);
const secAge = new Float32Array(SEC);
const secHalf = new Float32Array(SEC);
const secAX = new Float32Array(SEC);
const secAZ = new Float32Array(SEC);
const secNorm = new Float32Array(SEC);
const secH = new Float32Array(SEC);
const secGX = new Float32Array(SEC);
const secGZ = new Float32Array(SEC);

function resetHistory(st, sx, sz, fx, fz, time) {
  const speed = FORMATION.speed || 3.1;
  // dense ring: oldest sample first, newest last
  for (let i = NEAR - 1; i >= 0; i--) {
    const age = i * NEAR_DT;
    st.nearX[st.nearW] = sx - fx * speed * age;
    st.nearZ[st.nearW] = sz - fz * speed * age;
    st.nearT[st.nearW] = time - age;
    st.nearW = (st.nearW + 1) % NEAR;
  }
  for (let i = LONGN - 1; i >= 0; i--) {
    const age = i * LONG_DT;
    st.longX[st.longW] = sx - fx * speed * age;
    st.longZ[st.longW] = sz - fz * speed * age;
    st.longT[st.longW] = time - age;
    st.longW = (st.longW + 1) % LONGN;
  }
  st.nearAcc = 0;
  st.longAcc = 0;
}

// ---------------------------------------------------------------------------
// stern-trail update
// ---------------------------------------------------------------------------
function updateTrail(st, time, dt) {
  const e = st.boat.group.matrixWorld.elements;
  const halfL = st.L * 0.5;

  let fx = e[0];
  let fz = e[2];
  let fl = Math.hypot(fx, fz) || 1;
  fx /= fl;
  fz /= fl;
  let rx = e[8];
  let rz = e[10];
  let rl = Math.hypot(rx, rz) || 1;
  rx /= rl;
  rz /= rl;

  const sternX = e[0] * -halfL + e[12];
  const sternZ = e[2] * -halfL + e[14];

  if (!st.initialized) {
    resetHistory(st, sternX, sternZ, fx, fz, time);
    st.initialized = true;
  } else {
    const ni = (st.nearW - 1 + NEAR) % NEAR;
    const jx = sternX - st.nearX[ni];
    const jz = sternZ - st.nearZ[ni];
    if (jx * jx + jz * jz > 1600) resetHistory(st, sternX, sternZ, fx, fz, time);
  }

  // ---- sample the stern path at fixed intervals ---------------------------
  st.nearAcc += dt;
  while (st.nearAcc >= NEAR_DT) {
    st.nearAcc -= NEAR_DT;
    st.nearX[st.nearW] = sternX;
    st.nearZ[st.nearW] = sternZ;
    st.nearT[st.nearW] = time;
    st.nearW = (st.nearW + 1) % NEAR;
  }
  st.longAcc += dt;
  while (st.longAcc >= LONG_DT) {
    st.longAcc -= LONG_DT;
    st.longX[st.longW] = sternX;
    st.longZ[st.longW] = sternZ;
    st.longT[st.longW] = time;
    st.longW = (st.longW + 1) % LONGN;
  }

  // ---- build ribbon cross-sections: dense near field ----------------------
  secWX[0] = sternX;
  secWZ[0] = sternZ;
  secAge[0] = 0;
  let lastAge = 0;
  for (let i = 1; i < NEAR; i++) {
    const idx = (st.nearW - 1 - (i - 1) + NEAR * 2) % NEAR;
    secWX[i] = st.nearX[idx];
    secWZ[i] = st.nearZ[idx];
    const age = time - st.nearT[idx];
    secAge[i] = age > 0 ? age : 0;
    lastAge = secAge[i];
  }

  // ---- build ribbon cross-sections: decimated tail ------------------------
  // walk the sparse ring from newest towards oldest, interpolating at evenly
  // spaced ages so the widening stays smooth.
  const ageMax = st.ageMax;
  let oi = (st.longW - 1 + LONGN) % LONGN; // newest sparse sample
  let oAge = time - st.longT[oi];
  if (oAge < 0) oAge = 0;
  let pi = oi;
  let pAge = oAge;
  for (let k = 0; k < TAIL; k++) {
    const target = lastAge + (ageMax - lastAge) * ((k + 1) / TAIL);
    let guard = 0;
    while (oAge < target && guard++ < LONGN) {
      pi = oi;
      pAge = oAge;
      oi = (oi - 1 + LONGN) % LONGN;
      oAge = time - st.longT[oi];
      if (oAge < 0) oAge = 0;
    }
    const s = NEAR + k;
    if (oAge > pAge + 1e-4) {
      const f = clamp((target - pAge) / (oAge - pAge), 0, 1);
      secWX[s] = st.longX[pi] + (st.longX[oi] - st.longX[pi]) * f;
      secWZ[s] = st.longZ[pi] + (st.longZ[oi] - st.longZ[pi]) * f;
      secAge[s] = target;
    } else {
      secWX[s] = st.longX[oi];
      secWZ[s] = st.longZ[oi];
      secAge[s] = oAge;
    }
  }

  // ---- cross-section frames, widths, normalised ages ---------------------
  const ww = st.wakeWidth;
  const maxF = st.trailMax;
  for (let i = 0; i < SEC; i++) {
    const ip = i > 0 ? i - 1 : i;
    const inx = i < SEC - 1 ? i + 1 : i;
    const tx = secWX[ip] - secWX[inx];
    const tz = secWZ[ip] - secWZ[inx];
    const tl = Math.hypot(tx, tz);
    let ax;
    let az;
    if (tl > 1e-5) {
      ax = -tz / tl;
      az = tx / tl;
    } else {
      ax = rx;
      az = rz;
    }
    secAX[i] = ax;
    secAZ[i] = az;
    const agen = clamp(secAge[i] / ageMax, 0, 1);
    secNorm[i] = agen;
    let hw = 0.5 * ww * (0.60 + (maxF - 0.60) * Math.pow(agen, 1.15));
    hw *= 1 + 0.055 * Math.sin(secWX[i] * 0.12 + st.seed * 21.3);
    secHalf[i] = hw;
  }

  // ---- write the dense+tail ribbon ---------------------------------------
  const pos = st.trail.posArray;
  const nor = st.trail.norArray;
  const info = st.trail.infoArray;
  const ageArr = st.trail.ageArray;

  for (let i = 0; i < SEC; i++) {
    const cx = secWX[i];
    const cz = secWZ[i];
    waveAt(cx, cz, time);
    const h = _wave.h;
    const gx = _wave.dx;
    const gz = _wave.dz;
    const nf = 1 / Math.sqrt(gx * gx + gz * gz + 1);
    const nx = -gx * nf;
    const ny = nf;
    const nz = -gz * nf;
    secH[i] = h;
    secGX[i] = gx;
    secGZ[i] = gz;

    const hw = secHalf[i];
    const ax = secAX[i];
    const az = secAZ[i];
    const lx = cx - ax * hw;
    const lz = cz - az * hw;
    const rxp = cx + ax * hw;
    const rzp = cz + az * hw;
    const ly = h + gx * (lx - cx) + gz * (lz - cz) + Y_TRAIL;
    const ryp = h + gx * (rxp - cx) + gz * (rzp - cz) + Y_TRAIL;

    const vi = i * 2;
    pos[vi * 3] = lx;
    pos[vi * 3 + 1] = ly;
    pos[vi * 3 + 2] = lz;
    pos[vi * 3 + 3] = rxp;
    pos[vi * 3 + 4] = ryp;
    pos[vi * 3 + 5] = rzp;
    nor[vi * 3] = nx;
    nor[vi * 3 + 1] = ny;
    nor[vi * 3 + 2] = nz;
    nor[vi * 3 + 3] = nx;
    nor[vi * 3 + 4] = ny;
    nor[vi * 3 + 5] = nz;

    const age = secAge[i];
    const agen = secNorm[i];
    info[vi * 4] = age;
    info[(vi + 1) * 4] = age;
    ageArr[vi] = agen;
    ageArr[vi + 1] = agen;
  }

  // ---- secondary prop-wash ribbons (flagship + fast scouts) --------------
  if (st.hasSecondary) {
    const base = SEC * 2;
    for (let r = 0; r < 2; r++) {
      const sign = r === 0 ? -1 : 1;
      const off = base + r * SSEC * 2;
      for (let j = 0; j < SSEC; j++) {
        const t = j / (SSEC - 1);
        const age = 0.25 + t * 2.65;
        let si = Math.round(age / NEAR_DT) + 1;
        si = si < 1 ? 1 : si > NEAR - 1 ? NEAR - 1 : si;
        const sAge = secAge[si];
        const lat = sign * (st.B * 0.42 + (st.wakeWidth * 0.95 - st.B * 0.42) * t);
        const halfw = 0.5 * (0.35 + st.L * 0.012) * (1 - 0.35 * t);
        const ax = secAX[si];
        const az = secAZ[si];
        const cx = secWX[si] + ax * lat;
        const cz = secWZ[si] + az * lat;
        const lx = cx - ax * halfw;
        const lz = cz - az * halfw;
        const rxp = cx + ax * halfw;
        const rzp = cz + az * halfw;
        const ly = secH[si] + secGX[si] * (lx - secWX[si]) + secGZ[si] * (lz - secWZ[si]) + Y_TRAIL + 0.01;
        const ryp = secH[si] + secGX[si] * (rxp - secWX[si]) + secGZ[si] * (rzp - secWZ[si]) + Y_TRAIL + 0.01;
        const nf = 1 / Math.sqrt(secGX[si] * secGX[si] + secGZ[si] * secGZ[si] + 1);
        const nx = -secGX[si] * nf;
        const ny = nf;
        const nz = -secGZ[si] * nf;
        const vi = off + j * 2;
        pos[vi * 3] = lx;
        pos[vi * 3 + 1] = ly;
        pos[vi * 3 + 2] = lz;
        pos[vi * 3 + 3] = rxp;
        pos[vi * 3 + 4] = ryp;
        pos[vi * 3 + 5] = rzp;
        nor[vi * 3] = nx;
        nor[vi * 3 + 1] = ny;
        nor[vi * 3 + 2] = nz;
        nor[vi * 3 + 3] = nx;
        nor[vi * 3 + 4] = ny;
        nor[vi * 3 + 5] = nz;
        const agen = clamp(sAge / ageMax, 0, 1);
        info[vi * 4] = sAge;
        info[(vi + 1) * 4] = sAge;
        ageArr[vi] = agen;
        ageArr[vi + 1] = agen;
      }
    }
  }

  st.trail.position.needsUpdate = true;
  st.trail.normal.needsUpdate = true;
  st.trail.info.needsUpdate = true;
  st.trail.age01.needsUpdate = true;
}

// ---------------------------------------------------------------------------
// bow interaction update (rigid in boat-local space, snapped to the water)
// ---------------------------------------------------------------------------
function updateBow(st, time) {
  const e = st.boat.group.matrixWorld.elements;
  const m0 = e[0];
  const m8 = e[8];
  const m12 = e[12];
  const m2 = e[2];
  const m10 = e[10];
  const m14 = e[14];
  const pos = st.bow.posArray;
  const nor = st.bow.norArray;

  for (let s = 0; s < st.bow.strips.length; s++) {
    const strip = st.bow.strips[s];
    const start = strip.start;
    const sections = strip.sections;
    const clx = strip.clx;
    const clz = strip.clz;
    const cax = strip.cax;
    const caz = strip.caz;
    const chw = strip.chw;
    const yOff = strip.yOff;
    for (let k = 0; k < sections; k++) {
      const cx = m0 * clx[k] + m8 * clz[k] + m12;
      const cz = m2 * clx[k] + m10 * clz[k] + m14;
      waveAt(cx, cz, time);
      const h = _wave.h;
      const gx = _wave.dx;
      const gz = _wave.dz;
      const nf = 1 / Math.sqrt(gx * gx + gz * gz + 1);
      const nx = -gx * nf;
      const ny = nf;
      const nz = -gz * nf;
      const w = chw[k];
      for (let side = 0; side < 2; side++) {
        const sign = side === 0 ? -1 : 1;
        const lx = clx[k] + cax[k] * w * sign;
        const lz = clz[k] + caz[k] * w * sign;
        const wx = m0 * lx + m8 * lz + m12;
        const wz = m2 * lx + m10 * lz + m14;
        const wy = h + gx * (wx - cx) + gz * (wz - cz) + yOff;
        const vi = start + k * 2 + side;
        pos[vi * 3] = wx;
        pos[vi * 3 + 1] = wy;
        pos[vi * 3 + 2] = wz;
        nor[vi * 3] = nx;
        nor[vi * 3 + 1] = ny;
        nor[vi * 3 + 2] = nz;
      }
    }
  }

  for (let p = 0; p < st.bow.patches.length; p++) {
    const patch = st.bow.patches[p];
    const start = patch.start;
    const count = patch.verts;
    const local = st.bow.local;
    for (let k = 0; k < count; k++) {
      const vi = start + k;
      const lx = local[vi * 2];
      const lz = local[vi * 2 + 1];
      const wx = m0 * lx + m8 * lz + m12;
      const wz = m2 * lx + m10 * lz + m14;
      waveAt(wx, wz, time);
      const h = _wave.h;
      const nf = 1 / Math.sqrt(_wave.dx * _wave.dx + _wave.dz * _wave.dz + 1);
      pos[vi * 3] = wx;
      pos[vi * 3 + 1] = h + Y_PATCH;
      pos[vi * 3 + 2] = wz;
      nor[vi * 3] = -_wave.dx * nf;
      nor[vi * 3 + 1] = nf;
      nor[vi * 3 + 2] = -_wave.dz * nf;
    }
  }

  st.bow.position.needsUpdate = true;
  st.bow.normal.needsUpdate = true;
}

function updateBoat(st, time, dt) {
  updateTrail(st, time, dt);
  updateBow(st, time);
}

// ---------------------------------------------------------------------------
// public factory
// ---------------------------------------------------------------------------
/**
 * @param {Array} fleet array of boat objects { type, length, beam, group, wake }
 * @returns {{ group: THREE.Group, update: (time:number, dt:number) => void }}
 */
export function createWakes(fleet) {
  const boats = Array.isArray(fleet) ? fleet : (fleet && fleet.boats) || [];
  const group = new THREE.Group();
  group.name = 'wakes';

  const material = createFoamMaterial();
  const states = [];
  let frame = 0;

  for (let i = 0; i < boats.length; i++) {
    const boat = boats[i];
    if (!boat || !boat.group || !boat.group.matrixWorld) continue;
    const st = createBoatState(boat, i, material);
    states.push(st);
    group.add(st.trailMesh);
    group.add(st.bowMesh);
  }

  function update(time, dt) {
    const rawDt = dt > 0 ? dt : 0;
    material.uniforms.uTime.value = time;
    const step = rawDt > 0.1 ? 0.1 : rawDt;
    if (rawDt > 0.25) {
      // tab resume / giant hitch: rebuild the histories instead of stretching
      for (let i = 0; i < states.length; i++) states[i].initialized = false;
    }
    // Bow foam is small and rigid: at high frame rates it is updated on
    // alternating frames (staggered per boat) to halve its wave-sampling cost;
    // the one-frame lag is a couple of centimetres and invisible.
    const stagger = rawDt < 0.03;
    for (let i = 0; i < states.length; i++) {
      const st = states[i];
      updateTrail(st, time, step);
      if (!st.bowReady || !stagger || ((frame + i) & 1) === 0) {
        updateBow(st, time);
        st.bowReady = true;
      }
    }
    frame++;
  }

  return { group, update, material, states };
}
