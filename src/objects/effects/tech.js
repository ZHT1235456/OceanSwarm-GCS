// =============================================================================
// OceanSwarm — restrained "swarm intelligence" tech FX.
//
// Three tiny systems, all procedural, all additive cyan, none of them UI:
//
//  1) communication arcs — a small pool of thin billboarded ribbons that arch
//     between the flagship and cooperating vessels, with a travelling light
//     pulse. Links fade in/out on a slow deterministic schedule and only a
//     handful are ever visible.
//  2) scan rings — soft expanding rings that ripple out over the water ahead of
//     the scouts (1-2 active at a time), conforming to the animated surface.
//  3) survey fans — very faint additive cone volumes under the survey boats
//     plus a soft surface footprint that shows the fan brushing the water.
//
// Everything fades with camera distance so the effects dissolve into the haze.
// Contract: createTechFx(fleet, flagship) -> { group, update(time, dt) }
// =============================================================================
import * as THREE from 'three';
import { COLORS } from '../../config.js';
import { WAVES } from '../../core/waves.js';

const TAU = Math.PI * 2;

function clamp(v, a, b) {
  return v < a ? a : v > b ? b : v;
}
function smoothstep(a, b, x) {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

// Non-allocating sample of the shared CPU wave field (rings / footprints only).
const _wave = { h: 0 };
function waveHeightAt(x, z, t) {
  let h = 0;
  for (let i = 0; i < WAVES.length; i++) {
    const w = WAVES[i];
    h += w.amp * Math.sin(w.k * (w.dir[0] * x + w.dir[1] * z) - w.omega * t + w.phase);
  }
  _wave.h = h;
  return h;
}

// ---------------------------------------------------------------------------
// shared GLSL snippets
// ---------------------------------------------------------------------------
const DIST_FADE = /* glsl */ `
uniform float uFadeNear;
uniform float uFadeFar;
float distanceFade(vec3 worldPos) {
  float d = distance(cameraPosition, worldPos);
  return 1.0 - smoothstep(uFadeNear, uFadeFar, d);
}
`;

// ---------------------------------------------------------------------------
// 1) communication arcs
// ---------------------------------------------------------------------------
const ARC_POINTS = 26;

const ARC_VERT = /* glsl */ `
uniform float uHalfWidth;
varying vec2 vUv;
varying vec3 vWorldPos;

void main() {
  vUv = uv;
  vec3 p = position;
  vec3 toCam = cameraPosition - p;
  vec3 side = normalize(cross(normal, toCam));
  p += side * (uv.y * 2.0 - 1.0) * uHalfWidth;
  vWorldPos = p;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}
`;

const ARC_FRAG = /* glsl */ `
uniform float uTime;
uniform float uPulse;
uniform float uOpacity;
uniform float uSeed;
uniform vec3 uColor;
${DIST_FADE}

varying vec2 vUv;
varying vec3 vWorldPos;

void main() {
  float along = vUv.x;
  float edge = smoothstep(0.0, 0.34, vUv.y) * smoothstep(1.0, 0.66, vUv.y);

  // travelling packet of data + a faint second echo behind it
  float dp = (along - uPulse) / 0.1;
  float de = (along - fract(uPulse + 0.42)) / 0.06;
  float pulse = exp(-dp * dp);
  float echo = exp(-de * de) * 0.22;
  float base = 0.55 + 0.45 * sin(along * 11.0 + uTime * 0.55 + uSeed * 23.0);

  float a = edge * uOpacity * (0.38 * base + pulse * 1.15 + echo);
  a *= smoothstep(0.0, 0.045, along) * smoothstep(1.0, 0.955, along);
  a *= distanceFade(vWorldPos);

  vec3 col = uColor * (0.9 + 0.9 * pulse);
  gl_FragColor = vec4(col, a);
  #include <colorspace_fragment>
}
`;

function makeArcSlot(index) {
  const verts = ARC_POINTS * 2;
  const position = new THREE.BufferAttribute(new Float32Array(verts * 3), 3);
  const normal = new THREE.BufferAttribute(new Float32Array(verts * 3), 3);
  const uvArr = new Float32Array(verts * 2);
  for (let i = 0; i < ARC_POINTS; i++) {
    const u = i / (ARC_POINTS - 1);
    for (let s = 0; s < 2; s++) {
      const vi = i * 2 + s;
      uvArr[vi * 2] = u;
      uvArr[vi * 2 + 1] = s;
    }
  }
  const indices = [];
  for (let i = 0; i < ARC_POINTS - 1; i++) {
    const a = i * 2;
    indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  const geometry = new THREE.BufferGeometry();
  position.setUsage(THREE.DynamicDrawUsage);
  normal.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('position', position);
  geometry.setAttribute('normal', normal);
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvArr, 2));
  geometry.setIndex(indices);

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uPulse: { value: 0 },
      uOpacity: { value: 0 },
      uSeed: { value: 0.17 + index * 0.131 },
      uColor: { value: new THREE.Color(COLORS.neonCyan) },
      uHalfWidth: { value: 0.9 },
      uFadeNear: { value: 900 },
      uFadeFar: { value: 4200 },
    },
    vertexShader: ARC_VERT,
    fragmentShader: ARC_FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: false,
    toneMapped: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 6;
  mesh.visible = false;
  mesh.name = `tech-arc-${index}`;
  return {
    mesh,
    material,
    position,
    normal,
    points: new Float32Array(ARC_POINTS * 3),
    p0: new THREE.Vector3(),
    p1: new THREE.Vector3(),
    ctrl: new THREE.Vector3(),
    cycle: -1,
    partner: null,
    _lt: 0,
    _active: false,
  };
}

// arc schedule: period / duration / start offset / base opacity.
// Slow cycles, long fade-in/out, at most 3 links simultaneously (Lead note:
// arcs must feel like faint glints, never a beam).
const ARC_DEFS = [
  { period: 38.0, dur: 16.0, offset: 0.0, opacity: 0.085 },
  { period: 47.0, dur: 13.0, offset: 9.0, opacity: 0.065 },
  { period: 42.0, dur: 17.0, offset: 21.0, opacity: 0.09 },
  { period: 54.0, dur: 14.0, offset: 5.0, opacity: 0.055 },
  { period: 50.0, dur: 18.0, offset: 33.0, opacity: 0.075 },
  { period: 62.0, dur: 12.0, offset: 15.0, opacity: 0.05 },
];
const MAX_VISIBLE_ARCS = 3;

// ---------------------------------------------------------------------------
// 2) scan rings
// ---------------------------------------------------------------------------
const RING_SEG = 64;
const RING_INNER = 0.935;
const RING_COLOR = new THREE.Color(COLORS.techCyan);

const RING_VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vWorldPos;

void main() {
  vUv = uv;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const RING_FRAG = /* glsl */ `
uniform float uTime;
uniform float uOpacity;
uniform float uSeed;
uniform vec3 uColor;
${DIST_FADE}

varying vec2 vUv;
varying vec3 vWorldPos;

void main() {
  float radial = vUv.y;
  float band = smoothstep(0.0, 0.55, radial) * smoothstep(1.0, 0.62, radial);
  float ang = vUv.x * 6.2831853;
  float dash = 0.72 + 0.28 * sin(ang * 18.0 + uTime * 0.9 + uSeed * 31.0);
  float sweep = 0.75 + 0.25 * sin(ang - uTime * 1.7 + uSeed * 12.0);

  float a = band * uOpacity * dash * sweep;
  a *= distanceFade(vWorldPos);

  vec3 col = uColor * (1.0 + 0.7 * band);
  gl_FragColor = vec4(col, a);
  #include <colorspace_fragment>
}
`;

const RING_DEFS = [
  { period: 16.0, dur: 6.0, offset: 0.0, ahead: 18.0, radius: 42.0 },
  { period: 13.0, dur: 5.0, offset: 4.0, ahead: 26.0, radius: 38.0 },
  { period: 21.0, dur: 4.5, offset: 11.0, ahead: 22.0, radius: 44.0 },
];

function makeRingSlot(index) {
  const verts = RING_SEG * 2;
  const geometry = new THREE.BufferGeometry();
  const position = new THREE.BufferAttribute(new Float32Array(verts * 3), 3);
  position.setUsage(THREE.DynamicDrawUsage);
  const uvArr = new Float32Array(verts * 2);
  for (let j = 0; j < RING_SEG; j++) {
    uvArr[j * 2] = j / RING_SEG;
    uvArr[j * 2 + 1] = 0;
    uvArr[(RING_SEG + j) * 2] = j / RING_SEG;
    uvArr[(RING_SEG + j) * 2 + 1] = 1;
  }
  const indices = [];
  for (let j = 0; j < RING_SEG; j++) {
    const j2 = (j + 1) % RING_SEG;
    const i0 = j;
    const i1 = j2;
    const o0 = RING_SEG + j;
    const o1 = RING_SEG + j2;
    indices.push(i0, o0, i1, i1, o0, o1);
  }
  geometry.setAttribute('position', position);
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvArr, 2));
  geometry.setIndex(indices);

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uOpacity: { value: 0 },
      uSeed: { value: 0.23 + index * 0.29 },
      uColor: { value: RING_COLOR.clone() },
      uFadeNear: { value: 700 },
      uFadeFar: { value: 3800 },
    },
    vertexShader: RING_VERT,
    fragmentShader: RING_FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: false,
    toneMapped: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 4;
  mesh.visible = false;
  mesh.name = `tech-ring-${index}`;
  return { mesh, material, position, anchor: null };
}

// ---------------------------------------------------------------------------
// 3) underwater survey fans (+ faint surface footprint)
// ---------------------------------------------------------------------------
const CONE_COLOR = new THREE.Color(0x37d8cf);

const CONE_VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vNormal;
varying vec3 vWorldPos;

void main() {
  vUv = uv;
  vNormal = normalize(mat3(modelMatrix) * normal);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const CONE_FRAG = /* glsl */ `
uniform float uTime;
uniform float uPulse;
uniform vec3 uColor;
${DIST_FADE}

varying vec2 vUv;
varying vec3 vNormal;
varying vec3 vWorldPos;

void main() {
  // vUv.y: 0 at the wide base, 1 at the cone tip
  float along = vUv.y;
  float body = smoothstep(0.06, 0.55, along) * (0.25 + 0.75 * smoothstep(0.55, 0.98, along));

  vec3 V = normalize(cameraPosition - vWorldPos);
  float rim = pow(1.0 - abs(dot(normalize(vNormal), V)), 2.0);
  rim = 0.25 + 0.75 * rim;

  float a = body * rim * (0.045 + 0.06 * uPulse);
  a *= distanceFade(vWorldPos);

  vec3 col = uColor * (0.55 + 0.45 * along);
  gl_FragColor = vec4(col, a);
  #include <colorspace_fragment>
}
`;

const FOOT_VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vWorldPos;

void main() {
  vUv = uv;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const FOOT_FRAG = /* glsl */ `
uniform float uTime;
uniform float uPulse;
uniform vec3 uColor;
${DIST_FADE}

varying vec2 vUv;
varying vec3 vWorldPos;

void main() {
  vec2 q = (vUv - 0.5) * vec2(1.15, 1.7);
  float r = length(q);
  float soft = 1.0 - smoothstep(0.12, 0.72, r);
  float ripple = 0.7 + 0.3 * sin(r * 26.0 - uTime * 2.4);
  float a = soft * ripple * (0.04 + 0.085 * uPulse);
  a *= distanceFade(vWorldPos);
  gl_FragColor = vec4(uColor * 0.9, a);
  #include <colorspace_fragment>
}
`;

const CONE_SEG = 12;
const FOOT_GRID = 3; // 3x3 vertices

function makeSurveyFan(index) {
  // --- cone volume (hard-coded slim cone, tip at the hull) ---
  const coneGeo = new THREE.ConeGeometry(1, 1, CONE_SEG, 1, true);
  const coneMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uPulse: { value: 0 },
      uColor: { value: CONE_COLOR.clone() },
      uFadeNear: { value: 600 },
      uFadeFar: { value: 2600 },
    },
    vertexShader: CONE_VERT,
    fragmentShader: CONE_FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: false, // the water is opaque: let the faint volume read "through" it
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: false,
    toneMapped: false,
  });
  const cone = new THREE.Mesh(coneGeo, coneMat);
  cone.frustumCulled = false;
  cone.renderOrder = 4;
  cone.name = `tech-fan-cone-${index}`;

  // local orientation: the cone tip sits just under the hull and its base is
  // pushed down-forward into the water.
  const tilt = 0.42; // radians below horizontal
  const dir = new THREE.Vector3(Math.cos(-tilt), Math.sin(-tilt), 0).normalize(); // forward & down
  const up = new THREE.Vector3(0, 1, 0);
  const axisTo = dir.clone().multiplyScalar(-1); // cone local +Y points back up the axis
  const quat = new THREE.Quaternion().setFromUnitVectors(up, axisTo);
  const length = 24;
  const radius = 4.2;
  cone.quaternion.copy(quat);
  cone.scale.set(radius, length, radius);
  const apex = new THREE.Vector3(0.0, -1.5, 0.0);
  cone.position.copy(apex).addScaledVector(dir, length * 0.5);

  // --- surface footprint (world-anchored, water-following soft glow) ---
  const verts = FOOT_GRID * FOOT_GRID;
  const footGeo = new THREE.BufferGeometry();
  const footPos = new THREE.BufferAttribute(new Float32Array(verts * 3), 3);
  footPos.setUsage(THREE.DynamicDrawUsage);
  const footUv = new Float32Array(verts * 2);
  for (let iz = 0; iz < FOOT_GRID; iz++) {
    for (let ix = 0; ix < FOOT_GRID; ix++) {
      const vi = iz * FOOT_GRID + ix;
      footUv[vi * 2] = ix / (FOOT_GRID - 1);
      footUv[vi * 2 + 1] = iz / (FOOT_GRID - 1);
    }
  }
  const footIdx = [];
  for (let iz = 0; iz < FOOT_GRID - 1; iz++) {
    for (let ix = 0; ix < FOOT_GRID - 1; ix++) {
      const a = iz * FOOT_GRID + ix;
      const b = a + 1;
      const c = a + FOOT_GRID;
      const d = c + 1;
      footIdx.push(a, c, b, b, c, d);
    }
  }
  footGeo.setAttribute('position', footPos);
  footGeo.setAttribute('uv', new THREE.BufferAttribute(footUv, 2));
  footGeo.setIndex(footIdx);
  const footMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uPulse: { value: 0 },
      uColor: { value: new THREE.Color(COLORS.techCyan) },
      uFadeNear: { value: 600 },
      uFadeFar: { value: 3000 },
    },
    vertexShader: FOOT_VERT,
    fragmentShader: FOOT_FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: false,
    toneMapped: false,
  });
  const foot = new THREE.Mesh(footGeo, footMat);
  foot.frustumCulled = false;
  foot.renderOrder = 4;
  foot.name = `tech-fan-footprint-${index}`;

  return {
    cone,
    foot,
    coneMat,
    footMat,
    footPos,
    phase: index * 1.7,
    halfX: 9.0,
    halfZ: 6.5,
    centreForward: 5.0,
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();

function boatPos(boat, out) {
  const e = boat.group.matrixWorld.elements;
  return out.set(e[12], e[13], e[14]);
}
function boatForward(boat, out) {
  const e = boat.group.matrixWorld.elements;
  let x = e[0];
  let z = e[2];
  const l = Math.hypot(x, z) || 1;
  return out.set(x / l, 0, z / l);
}

const ARC_CANDIDATE_TYPES = new Set(['scout', 'env', 'patrol', 'survey', 'comms', 'rescue', 'energy']);

// ---------------------------------------------------------------------------
// public factory
// ---------------------------------------------------------------------------
/**
 * @param {Array} fleet array of boat objects { type, group, ... }
 * @param {Object} flagship the flagship boat object
 * @returns {{ group: THREE.Group, update: (time:number, dt:number) => void }}
 */
export function createTechFx(fleet, flagship) {
  const boats = Array.isArray(fleet) ? fleet : (fleet && fleet.boats) || [];
  const group = new THREE.Group();
  group.name = 'tech-fx';

  let flag = flagship && flagship.group ? flagship : null;
  if (!flag) {
    for (const b of boats) {
      if (b && b.type === 'flagship') {
        flag = b;
        break;
      }
    }
  }

  const candidates = [];
  for (const b of boats) {
    if (!b || !b.group || b === flag) continue;
    if (b.type && ARC_CANDIDATE_TYPES.has(b.type)) candidates.push(b);
  }
  if (!candidates.length) {
    for (const b of boats) if (b && b.group && b !== flag) candidates.push(b);
  }

  // ---- communication arcs ------------------------------------------------
  const arcs = [];
  for (let i = 0; i < ARC_DEFS.length; i++) {
    const slot = makeArcSlot(i);
    group.add(slot.mesh);
    arcs.push(slot);
  }

  // ---- scan rings --------------------------------------------------------
  const scouts = boats.filter((b) => b && b.group && b.type === 'scout');
  const ringAnchors = scouts.length ? scouts : boats.filter((b) => b && b.group && b !== flag);
  const rings = [];
  for (let i = 0; i < RING_DEFS.length; i++) {
    const slot = makeRingSlot(i);
    if (ringAnchors.length) slot.anchor = ringAnchors[i % ringAnchors.length];
    group.add(slot.mesh);
    rings.push(slot);
  }

  // ---- survey fans -------------------------------------------------------
  let surveyBoats = boats.filter((b) => b && b.group && b.type === 'survey');
  if (!surveyBoats.length) surveyBoats = boats.filter((b) => b && b.group && b.type === 'env').slice(0, 2);
  const fans = [];
  for (let i = 0; i < surveyBoats.length && i < 2; i++) {
    const fan = makeSurveyFan(i);
    fan.boat = surveyBoats[i];
    // cone lives in the boat's local space, so hang it on a lightweight pivot
    // that copies the boat transform every frame
    fan.pivot = new THREE.Group();
    fan.pivot.name = `tech-fan-${i}`;
    fan.pivot.add(fan.cone);
    group.add(fan.pivot);
    group.add(fan.foot);
    fans.push(fan);
  }

  // ---- update ------------------------------------------------------------
  const flagPoint = new THREE.Vector3();
  const partnerPoint = new THREE.Vector3();

  /** Pick a cooperating boat that is reasonably close to the flagship so the
   *  arcs stay short "wing links" instead of looping across the whole fleet. */
  function pickWingPartner(index, cycle) {
    if (!candidates.length || !flag) return null;
    boatPos(flag, _v0);
    // deterministic target distance in the 55-150 m band
    const h = ((index * 73 + cycle * 41) % 97) / 97;
    const target = 55 + h * 95;
    let best = null;
    let bestScore = Infinity;
    for (let i = 0; i < candidates.length; i++) {
      const p = candidates[i];
      const e = p.group.matrixWorld.elements;
      const dx = e[12] - _v0.x;
      const dz = e[14] - _v0.z;
      const d = Math.hypot(dx, dz);
      // prefer the target-distance band, break ties deterministically
      const score = Math.abs(d - target) + ((((i * 37 + cycle * 13 + index * 7) % 17) / 17) * 14);
      if (score < bestScore) {
        bestScore = score;
        best = p;
      }
    }
    return best;
  }

  function updateArc(slot, index, time, lt, active) {
    const def = ARC_DEFS[index];
    slot.mesh.visible = active;
    if (!active) return;
    const cycle = Math.floor((time + def.offset) / def.period);

    if (cycle !== slot.cycle) {
      slot.cycle = cycle;
      slot.partner = pickWingPartner(index, cycle);
    }
    const partner = slot.partner;
    if (!partner || !flag) {
      slot.mesh.visible = false;
      return;
    }

    // endpoints: low over the deck, with a slow organic bob. Kept deliberately
    // close to boat level so the links read as data glints, not sky beams.
    boatPos(flag, flagPoint);
    flagPoint.y += (flag.length || 20) * 0.22 + Math.sin(time * 0.7 + index) * 0.4;
    boatPos(partner, partnerPoint);
    partnerPoint.y += (partner.length || 12) * 0.2 + Math.sin(time * 0.63 + index * 1.7) * 0.4;

    const p0 = slot.p0.copy(flagPoint);
    const p1 = slot.p1.copy(partnerPoint);
    const dx = p1.x - p0.x;
    const dy = p1.y - p0.y;
    const dz = p1.z - p0.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 8) {
      slot.mesh.visible = false;
      return;
    }
    // apex only ~5-12 m above the chord (=> 8-18 m above the water)
    const arch = clamp(4 + dist * 0.06, 5, 12);
    slot.ctrl.set(
      (p0.x + p1.x) * 0.5 - dz * 0.05,
      (p0.y + p1.y) * 0.5 + arch * 2.0,
      (p0.z + p1.z) * 0.5 + dx * 0.05,
    );

    // sample the quadratic bezier
    const a = p0;
    const c = slot.ctrl;
    const b = p1;
    const pts = slot.points;
    for (let i = 0; i < ARC_POINTS; i++) {
      const t = i / (ARC_POINTS - 1);
      const it = 1 - t;
      pts[i * 3] = it * it * a.x + 2 * it * t * c.x + t * t * b.x;
      pts[i * 3 + 1] = it * it * a.y + 2 * it * t * c.y + t * t * b.y;
      pts[i * 3 + 2] = it * it * a.z + 2 * it * t * c.z + t * t * b.z;
    }
    const pos = slot.position.array;
    const nor = slot.normal.array;
    for (let i = 0; i < ARC_POINTS; i++) {
      const prev = i > 0 ? i - 1 : i;
      const next = i < ARC_POINTS - 1 ? i + 1 : i;
      let tx = pts[prev * 3] - pts[next * 3];
      let ty = pts[prev * 3 + 1] - pts[next * 3 + 1];
      let tz = pts[prev * 3 + 2] - pts[next * 3 + 2];
      const tl = Math.hypot(tx, ty, tz) || 1;
      tx /= tl;
      ty /= tl;
      tz /= tl;
      const pi = i * 3;
      const vi = i * 2;
      pos[vi * 3] = pts[pi];
      pos[vi * 3 + 1] = pts[pi + 1];
      pos[vi * 3 + 2] = pts[pi + 2];
      pos[vi * 3 + 3] = pts[pi];
      pos[vi * 3 + 4] = pts[pi + 1];
      pos[vi * 3 + 5] = pts[pi + 2];
      nor[vi * 3] = tx;
      nor[vi * 3 + 1] = ty;
      nor[vi * 3 + 2] = tz;
      nor[vi * 3 + 3] = tx;
      nor[vi * 3 + 4] = ty;
      nor[vi * 3 + 5] = tz;
    }
    slot.position.needsUpdate = true;
    slot.normal.needsUpdate = true;

    const fadeIn = smoothstep(0.0, 3.5, lt);
    const fadeOut = 1 - smoothstep(def.dur - 3.5, def.dur, lt);
    const uniforms = slot.material.uniforms;
    uniforms.uTime.value = time;
    uniforms.uOpacity.value = def.opacity * fadeIn * fadeOut;
    uniforms.uPulse.value = (lt * 0.13 + index * 0.37) % 1;
    uniforms.uHalfWidth.value = clamp(0.32 + dist * 0.0022, 0.4, 0.85);
  }

  function updateRing(slot, def, time) {
    const local = time + def.offset;
    const cycle = Math.floor(local / def.period);
    const lt = local - cycle * def.period;
    const active = lt < def.dur;
    slot.mesh.visible = active;
    if (!active || !slot.anchor) return;

    const boat = slot.anchor;
    boatPos(boat, _v0);
    boatForward(boat, _v1);
    const ahead = def.ahead + (cycle % 3) * 4;
    const cx = _v0.x + _v1.x * ahead + Math.sin(time * 0.13 + def.offset) * 2.0;
    const cz = _v0.z + _v1.z * ahead + Math.cos(time * 0.11 + def.offset) * 2.0;

    const progress = clamp(lt / def.dur, 0, 1);
    // fast start, gentle end (an expanding sensor ping)
    const radius = 1.5 + def.radius * (1 - Math.pow(1 - progress, 2.4));
    const pos = slot.position.array;
    for (let j = 0; j < RING_SEG; j++) {
      const ang = (j / RING_SEG) * TAU;
      const ca = Math.cos(ang);
      const sa = Math.sin(ang);
      const ix = cx + ca * radius * RING_INNER;
      const iz = cz + sa * radius * RING_INNER;
      const ox = cx + ca * radius;
      const oz = cz + sa * radius;
      const iy = waveHeightAt(ix, iz, time) + 0.16;
      const oy = waveHeightAt(ox, oz, time) + 0.16;
      pos[j * 3] = ix;
      pos[j * 3 + 1] = iy;
      pos[j * 3 + 2] = iz;
      pos[(RING_SEG + j) * 3] = ox;
      pos[(RING_SEG + j) * 3 + 1] = oy;
      pos[(RING_SEG + j) * 3 + 2] = oz;
    }
    slot.position.needsUpdate = true;

    const fadeIn = smoothstep(0.0, 0.55, progress);
    const fadeOut = 1 - smoothstep(0.55, 1.0, progress);
    const uniforms = slot.material.uniforms;
    uniforms.uTime.value = time;
    uniforms.uOpacity.value = 0.3 * fadeIn * fadeOut;
  }

  function updateFan(fan, index, time) {
    const boat = fan.boat;
    const pivot = fan.pivot;
    // follow the boat transform exactly (cone is a rigid child)
    const e = boat.group.matrixWorld.elements;
    pivot.position.set(e[12], e[13], e[14]);
    pivot.quaternion.setFromRotationMatrix(boat.group.matrixWorld);
    pivot.scale.set(1, 1, 1);

    // slow 2.2 s ping envelope
    const pulse = 0.5 + 0.5 * Math.sin((time + fan.phase) * (TAU / 2.6));
    const env = smoothstep(0.15, 0.8, pulse);

    fan.coneMat.uniforms.uTime.value = time;
    fan.coneMat.uniforms.uPulse.value = env;
    fan.footMat.uniforms.uTime.value = time;
    fan.footMat.uniforms.uPulse.value = env;

    // surface footprint: a soft ellipse just under/ahead of the hull,
    // conforming to the wave surface.
    boatPos(boat, _v0);
    boatForward(boat, _v1);
    const fwdx = _v1.x;
    const fwdz = _v1.z;
    const rx = fwdz; // right = forward rotated -90° around Y
    const rz = -fwdx;
    const halfX = fan.halfX;
    const halfZ = fan.halfZ;
    const cf = fan.centreForward;
    const pos = fan.footPos.array;
    let k = 0;
    for (let iz = 0; iz < FOOT_GRID; iz++) {
      const lz = (iz / (FOOT_GRID - 1)) * 2 - 1;
      for (let ix = 0; ix < FOOT_GRID; ix++) {
        const lx = (ix / (FOOT_GRID - 1)) * 2 - 1;
        const wx = _v0.x + fwdx * (cf + lx * halfX) + rx * lz * halfZ;
        const wz = _v0.z + fwdz * (cf + lx * halfX) + rz * lz * halfZ;
        pos[k * 3] = wx;
        pos[k * 3 + 1] = waveHeightAt(wx, wz, time) + 0.09;
        pos[k * 3 + 2] = wz;
        k++;
      }
    }
    fan.footPos.needsUpdate = true;
    fan.foot.visible = env > 0.02;
  }

  function update(time, dt) {
    // visibility budget: never show every link at once (max 4 of the 6 arcs).
    // Hide the most recently started links first — their fade-in is lowest.
    let activeCount = 0;
    for (let i = 0; i < arcs.length; i++) {
      const def = ARC_DEFS[i];
      const local = time + def.offset;
      const lt = local - Math.floor(local / def.period) * def.period;
      arcs[i]._lt = lt;
      arcs[i]._active = lt < def.dur;
      if (arcs[i]._active) activeCount++;
    }
    while (activeCount > MAX_VISIBLE_ARCS) {
      let worst = -1;
      let worstLt = Infinity;
      for (let i = 0; i < arcs.length; i++) {
        if (arcs[i]._active && arcs[i]._lt < worstLt) {
          worstLt = arcs[i]._lt;
          worst = i;
        }
      }
      if (worst < 0) break;
      arcs[worst]._active = false;
      activeCount--;
    }
    for (let i = 0; i < arcs.length; i++) updateArc(arcs[i], i, time, arcs[i]._lt, arcs[i]._active);
    for (let i = 0; i < rings.length; i++) updateRing(rings[i], RING_DEFS[i], time);
    for (let i = 0; i < fans.length; i++) updateFan(fans[i], i, time);
  }

  return { group, update, arcs, rings, fans };
}
