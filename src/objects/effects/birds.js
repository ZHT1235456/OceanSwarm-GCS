// =============================================================================
// OceanSwarm — stylised low-poly seagulls.
//
// 8 gulls (7-9 requested) built from one tiny merged low-poly geometry
// (body + head + beak + tail + two wings, ~210 tris each) and a single shared
// MeshToonMaterial family. Wings are flapped *in the vertex shader* around the
// body axis (attribute aWing = ±1), driven by a per-bird uniform, so each bird
// is ONE draw call and there are no per-frame geometry updates at all.
//
// Motion is fully time-parametric: the flock circles above the (slowly curving)
// fleet course, each bird on its own eccentric ellipse + vertical sine, banking
// into its turns and alternating short 2.3 Hz flapping bursts with glides.
// A couple of birds are deliberately far away for depth.
//
// Contract: createBirds() -> { group, update(time, dt) }
// =============================================================================
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { COLORS, FLEET_ROSTER, FORMATION } from '../../config.js';
import { getGradientMap } from '../../core/materials.js';

const TAU = Math.PI * 2;
const BIRD_COUNT = 8;

function clamp(v, a, b) {
  return v < a ? a : v > b ? b : v;
}
function smoothstep(a, b, x) {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

// formation-centroid offset (birds circle the swarm, not the flagship alone)
let _meanLat = 0;
let _meanFwd = 0;
{
  let n = 0;
  for (const r of FLEET_ROSTER) {
    _meanLat += r.offset[0];
    _meanFwd += r.offset[1];
    n++;
  }
  if (n) {
    _meanLat /= n;
    _meanFwd /= n;
  }
}

// ---------------------------------------------------------------------------
// geometry
// ---------------------------------------------------------------------------
const BIRD_PALETTE = {
  body: COLORS.pearl,
  wingTip: COLORS.metal,
  beak: COLORS.darkSteel,
  tail: COLORS.silver,
};

/** Non-indexed geometry + uniform vertex colour + wing flag. */
function preparePart(geo, color, wing, tipColor, tipStart, tipEnd) {
  let g = geo.index ? geo.toNonIndexed() : geo;
  if (g !== geo) geo.dispose();
  if (!g.getAttribute('uv')) {
    const count = g.getAttribute('position').count;
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2));
  }
  g.computeVertexNormals();
  const pos = g.getAttribute('position');
  const count = pos.count;
  const colors = new Float32Array(count * 3);
  const wingArr = new Float32Array(count);
  const cBase = new THREE.Color(color);
  const cTip = tipColor !== undefined ? new THREE.Color(tipColor) : null;
  for (let i = 0; i < count; i++) {
    let r = cBase.r;
    let gg = cBase.g;
    let b = cBase.b;
    if (cTip && tipStart !== undefined) {
      const t = smoothstep(tipStart, tipEnd !== undefined ? tipEnd : tipStart + 0.1, Math.abs(pos.getZ(i)));
      r += (cTip.r - r) * t;
      gg += (cTip.g - gg) * t;
      b += (cTip.b - b) * t;
    }
    colors[i * 3] = r;
    colors[i * 3 + 1] = gg;
    colors[i * 3 + 2] = b;
    wingArr[i] = wing;
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  g.setAttribute('aWing', new THREE.BufferAttribute(wingArr, 1));
  return g;
}

function makeWing(side, tipColor) {
  // side: +1 = starboard (local +Z), -1 = port. Swept, slightly cambered lofts.
  const z = (v) => v * side;
  const stations = [
    [0.11, 0.02, 0.05, -0.1, 0.02, 0.05],
    [0.095, 0.045, 0.25, -0.125, 0.032, 0.25],
    [0.02, 0.062, 0.44, -0.135, 0.05, 0.44],
  ];
  const verts = [];
  for (let k = 0; k < stations.length - 1; k++) {
    const a = stations[k];
    const b = stations[k + 1];
    // leading edge -> mid -> trailing edge quads
    const rootL = [a[0], a[1], z(a[2])];
    const rootT = [a[3], a[4], z(a[5])];
    const midL = [b[0], b[1], z(b[2])];
    const midT = [b[3], b[4], z(b[5])];
    verts.push(rootL, rootT, midL, rootT, midT, midL);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts.flat(), 3));
  geo.computeVertexNormals();
  // wing: +1 when the span points along +Z (starboard), -1 for port
  return preparePart(geo, BIRD_PALETTE.body, side >= 0 ? -1 : 1, tipColor, 0.24, 0.46);
}

function buildBirdGeometry() {
  const parts = [];

  const bodyGeo = new THREE.SphereGeometry(1, 8, 6);
  bodyGeo.scale(0.245, 0.105, 0.125);
  bodyGeo.translate(-0.01, 0.005, 0);
  parts.push(preparePart(bodyGeo, BIRD_PALETTE.body, 0));

  const headGeo = new THREE.SphereGeometry(1, 7, 5);
  headGeo.scale(0.088, 0.078, 0.082);
  headGeo.translate(0.205, 0.05, 0);
  parts.push(preparePart(headGeo, BIRD_PALETTE.body, 0));

  const beakGeo = new THREE.ConeGeometry(0.03, 0.115, 5);
  beakGeo.rotateZ(-Math.PI / 2);
  beakGeo.translate(0.29, 0.042, 0);
  parts.push(preparePart(beakGeo, BIRD_PALETTE.beak, 0));

  const tailGeo = new THREE.ConeGeometry(0.095, 0.21, 4);
  tailGeo.rotateZ(Math.PI / 2);
  tailGeo.scale(1, 0.32, 1.25);
  tailGeo.translate(-0.255, 0.012, 0);
  parts.push(preparePart(tailGeo, BIRD_PALETTE.tail, 0));

  parts.push(makeWing(1, BIRD_PALETTE.wingTip));
  parts.push(makeWing(-1, BIRD_PALETTE.wingTip));

  const merged = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
  merged.computeBoundingSphere();
  merged.computeBoundingBox();
  return merged;
}

// ---------------------------------------------------------------------------
// material — toon + vertex colours + per-bird vertex-shader wing flap
// ---------------------------------------------------------------------------
function makeBirdMaterial(gradientMap) {
  const uniforms = { uFlap: { value: 0 } };
  const mat = new THREE.MeshToonMaterial({
    color: 0xffffff,
    vertexColors: true,
    gradientMap,
    side: THREE.DoubleSide,
    fog: true,
  });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uFlap = uniforms.uFlap;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
uniform float uFlap;
attribute float aWing;`,
      )
      .replace(
        '#include <beginnormal_vertex>',
        `#include <beginnormal_vertex>
      float wingAng = uFlap * aWing;
      float wingCos = cos(wingAng);
      float wingSin = sin(wingAng);
      objectNormal = vec3(
        objectNormal.x,
        objectNormal.y * wingCos - objectNormal.z * wingSin,
        objectNormal.y * wingSin + objectNormal.z * wingCos
      );`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
      transformed = vec3(
        transformed.x,
        transformed.y * wingCos - transformed.z * wingSin,
        transformed.y * wingSin + transformed.z * wingCos
      );`,
      );
  };
  mat.customProgramCacheKey = () => 'seagull-flap-v1';
  mat.userData.uniforms = uniforms;
  return mat;
}

// ---------------------------------------------------------------------------
// flock definition (deterministic)
// ---------------------------------------------------------------------------
const FLOCK = [
  // near / mid flock, circling the swarm
  { centerFwd: 26, centerLat: 14, radius: 34, rx: 1.0, rz: 0.78, dir: 1, omega: 0.088, height: 12.5, vAmp: 3.0, vFreq: 0.075, phase: 0.15, flapPhase: 0.31, scale: 1.02, far: false },
  { centerFwd: 8, centerLat: -26, radius: 27, rx: 0.9, rz: 1.05, dir: -1, omega: 0.1, height: 10.0, vAmp: 2.2, vFreq: 0.09, phase: 1.35, flapPhase: 1.17, scale: 0.96, far: false },
  { centerFwd: -34, centerLat: 22, radius: 38, rx: 1.1, rz: 0.85, dir: 1, omega: 0.074, height: 15.5, vAmp: 3.6, vFreq: 0.062, phase: 2.6, flapPhase: 2.03, scale: 1.08, far: false },
  { centerFwd: 42, centerLat: -8, radius: 22, rx: 1.0, rz: 1.0, dir: -1, omega: 0.115, height: 9.0, vAmp: 1.8, vFreq: 0.1, phase: 3.95, flapPhase: 2.77, scale: 0.93, far: false },
  { centerFwd: -12, centerLat: 52, radius: 44, rx: 1.15, rz: 0.8, dir: 1, omega: 0.066, height: 19.0, vAmp: 4.2, vFreq: 0.054, phase: 5.1, flapPhase: 3.41, scale: 1.12, far: false },
  { centerFwd: -58, centerLat: -14, radius: 31, rx: 0.85, rz: 1.15, dir: -1, omega: 0.093, height: 16.5, vAmp: 2.8, vFreq: 0.082, phase: 0.85, flapPhase: 4.55, scale: 1.0, far: false },
  // a couple out on the horizon
  { centerFwd: 78, centerLat: -62, radius: 108, rx: 1.2, rz: 1.0, dir: 1, omega: 0.041, height: 30.0, vAmp: 5.5, vFreq: 0.038, phase: 2.2, flapPhase: 5.4, scale: 1.22, far: true },
  { centerFwd: -96, centerLat: 86, radius: 138, rx: 1.0, rz: 1.25, dir: -1, omega: 0.033, height: 35.0, vAmp: 6.0, vFreq: 0.031, phase: 4.4, flapPhase: 0.63, scale: 1.26, far: true },
];

// reusable temps (no allocations in update)
const _pA = new THREE.Vector3();
const _pB = new THREE.Vector3();
const _pC = new THREE.Vector3();
const _vel = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _upv = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _qBank = new THREE.Quaternion();
const _xAxis = new THREE.Vector3(1, 0, 0);
const _acc = new THREE.Vector3();

/**
 * Position of a bird on its parametric path at time t (world space, Y up).
 * The flock is anchored to an analytic copy of the fleet's slow left arc, so
 * the gulls stay around the swarm no matter how long the session runs.
 */
function birdPosition(b, t, out) {
  const yaw = FORMATION.heading0 + FORMATION.turnRate * t;
  const turnR = FORMATION.speed / Math.max(FORMATION.turnRate, 1e-5);
  const px = FORMATION.flagshipStart.x + turnR * (Math.sin(yaw) - Math.sin(FORMATION.heading0));
  const pz = FORMATION.flagshipStart.z + turnR * (Math.cos(yaw) - Math.cos(FORMATION.heading0));
  const fwdx = Math.cos(yaw);
  const fwdz = -Math.sin(yaw);
  const rgtx = Math.sin(yaw);
  const rgtz = Math.cos(yaw);

  // slowly breathing orbital centre so the circling never feels clockwork
  const centerDriftX = Math.sin(t * 0.023 + b.phase * 3.1) * 12;
  const centerDriftZ = Math.cos(t * 0.019 + b.phase * 1.7) * 12;
  const cx =
    px + fwdx * (_meanFwd + b.centerFwd) + rgtx * (_meanLat + b.centerLat) + centerDriftX;
  const cz =
    pz + fwdz * (_meanFwd + b.centerFwd) + rgtz * (_meanLat + b.centerLat) + centerDriftZ;

  const ang = b.phase * 5.7 + b.dir * b.omega * t + 0.3 * Math.sin(t * 0.071 + b.phase * 2.3);
  const breathe = 1 + 0.11 * Math.sin(t * 0.052 + b.phase * 4.1);
  const rx = b.radius * b.rx * breathe;
  const rz = b.radius * b.rz * breathe;

  const x = cx + Math.cos(ang) * rx;
  const z = cz + Math.sin(ang) * rz * b.dir;
  const y =
    b.height +
    Math.sin(t * b.vFreq + b.phase * 4.7) * b.vAmp +
    Math.sin(t * 0.27 + b.phase * 2.0) * 0.8;
  out.set(x, y, z);
  return out;
}

// ---------------------------------------------------------------------------
// public factory
// ---------------------------------------------------------------------------
/**
 * @returns {{ group: THREE.Group, update: (time:number, dt:number) => void }}
 */
export function createBirds() {
  const group = new THREE.Group();
  group.name = 'birds';

  const geometry = buildBirdGeometry();
  const gradientMap = getGradientMap();
  const birds = [];

  for (let i = 0; i < BIRD_COUNT; i++) {
    const def = FLOCK[i % FLOCK.length];
    const material = makeBirdMaterial(gradientMap);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `seagull-${i}`;
    mesh.scale.setScalar(def.scale);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    const bird = {
      def,
      mesh,
      material,
      flapUniforms: material.userData.uniforms,
      flapSpeed: 2.15 + (i % 4) * 0.14,
      burstFreq: 0.72 + (i % 3) * 0.11,
    };
    birds.push(bird);
    group.add(mesh);
  }

  function update(time, dt) {
    for (let i = 0; i < birds.length; i++) {
      const bird = birds[i];
      const def = bird.def;

      // ---- path position --------------------------------------------------
      birdPosition(def, time, _pA);
      birdPosition(def, time + 0.09, _pB);
      _vel.copy(_pB).sub(_pA);
      const speed = _vel.length();
      if (speed > 1e-5) _vel.multiplyScalar(1 / speed);

      // lateral acceleration from a symmetric second difference (for banking)
      birdPosition(def, time - 0.09, _pC);
      _acc.copy(_pB).add(_pC).addScaledVector(_pA, -2);
      _right.set(-_vel.z, 0, _vel.x);
      const rl = Math.hypot(_right.x, _right.z) || 1;
      _right.multiplyScalar(1 / rl);
      const bank = clamp(_acc.dot(_right) * 150, -0.4, 0.4);

      // ---- orientation ----------------------------------------------------
      _fwd.copy(_vel);
      if (_fwd.y > 0.7) _fwd.y = 0.7;
      if (_fwd.y < -0.7) _fwd.y = -0.7;
      _fwd.normalize();
      _right.set(-_fwd.z, 0, _fwd.x);
      const rlen = _right.length();
      if (rlen < 1e-4) _right.set(1, 0, 0);
      else _right.multiplyScalar(1 / rlen);
      _upv.crossVectors(_right, _fwd).normalize();
      _m.makeBasis(_fwd, _upv, _right);
      _q.setFromRotationMatrix(_m);
      _qBank.setFromAxisAngle(_xAxis, bank);
      _q.multiply(_qBank);

      const mesh = bird.mesh;
      mesh.position.copy(_pA);
      mesh.quaternion.copy(_q);

      // ---- flapping bursts + glides --------------------------------------
      const burstSignal =
        Math.sin(time * bird.burstFreq + def.flapPhase * 5.3) *
        Math.sin(time * 0.19 + def.flapPhase * 1.7);
      const burst = smoothstep(0.02, 0.52, burstSignal);
      const flap =
        Math.sin(time * TAU * bird.flapSpeed + def.flapPhase * 9.0) * 0.62 * burst +
        (1 - burst) * 0.11 +
        0.02 * Math.sin(time * 0.8 + def.flapPhase);
      bird.flapUniforms.uFlap.value = flap;
    }
  }

  return { group, update, birds, geometry };
}
