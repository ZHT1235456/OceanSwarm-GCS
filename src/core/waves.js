// =============================================================================
// Shared procedural wave field.
// A sum of directional sine waves (swell + wind sea) is used for both the GPU
// ocean surface and the CPU vessel buoyancy sampler so boats and water match.
// =============================================================================
import * as THREE from 'three';

// dir = horizontal propagation direction (normalized), wavelength in meters,
// amplitude in meters, speed in m/s, phase offset.
export const WAVES = [
  { dir: [0.94, -0.34], len: 132, amp: 0.72, speed: 8.8, phase: 0.0 }, // long swell
  { dir: [0.74, 0.67], len: 76, amp: 0.40, speed: 6.4, phase: 1.7 },
  { dir: [0.99, 0.11], len: 44, amp: 0.24, speed: 4.8, phase: 4.1 },
  { dir: [0.56, -0.83], len: 26, amp: 0.15, speed: 3.6, phase: 2.6 },
  { dir: [0.88, 0.48], len: 16.5, amp: 0.095, speed: 2.9, phase: 5.3 },
  { dir: [0.97, -0.24], len: 9.0, amp: 0.052, speed: 2.2, phase: 0.9 },
  { dir: [0.72, -0.69], len: 5.6, amp: 0.028, speed: 1.8, phase: 3.3 },
];

for (const w of WAVES) {
  const l = Math.hypot(w.dir[0], w.dir[1]);
  w.dir[0] /= l;
  w.dir[1] /= l;
  w.k = (Math.PI * 2) / w.len;
  w.omega = w.speed * w.k;
}

export function sampleWave(x, z, t) {
  let y = 0;
  let dx = 0;
  let dz = 0;
  for (let i = 0; i < WAVES.length; i++) {
    const w = WAVES[i];
    const ph = w.k * (w.dir[0] * x + w.dir[1] * z) - w.omega * t + w.phase;
    const s = Math.sin(ph);
    const c = Math.cos(ph);
    y += w.amp * s;
    dx += w.amp * w.k * w.dir[0] * c;
    dz += w.amp * w.k * w.dir[1] * c;
  }
  return { height: y, dhdx: dx, dhdz: dz };
}

export const WAVE_CONSTANTS_GLSL = WAVES.map((w) => {
  return `vec4(${w.dir[0].toFixed(5)}, ${w.dir[1].toFixed(5)}, ${w.k.toFixed(6)}, ${w.amp.toFixed(5)}), vec2(${w.omega.toFixed(
    5,
  )}, ${w.phase.toFixed(5)})`;
}).join(',\n  ');

export const WAVE_GLSL = /* glsl */ `
  const int WAVE_COUNT = ${WAVES.length};
  const vec4 WAVE_A[WAVE_COUNT] = vec4[WAVE_COUNT](
    ${WAVES.map((w) => `vec4(${w.dir[0].toFixed(5)}, ${w.dir[1].toFixed(5)}, ${w.k.toFixed(6)}, ${w.amp.toFixed(5)})`).join(
      ',\n    ',
    )}
  );
  const vec2 WAVE_B[WAVE_COUNT] = vec2[WAVE_COUNT](
    ${WAVES.map((w) => `vec2(${w.omega.toFixed(5)}, ${w.phase.toFixed(5)})`).join(',\n    ')}
  );

  // height and analytic horizontal gradient of the shared wave field
  void sampleWaves(vec2 p, float t, out float h, out vec2 grad) {
    h = 0.0;
    grad = vec2(0.0);
    for (int i = 0; i < WAVE_COUNT; i++) {
      vec4 a = WAVE_A[i];
      vec2 b = WAVE_B[i];
      float ph = a.z * dot(a.xy, p) - b.x * t + b.y;
      h += a.w * sin(ph);
      grad += a.w * a.z * a.xy * cos(ph);
    }
  }
`;

// World-space water height at a point (used by vessels / buoys / birds).
export function waterHeight(x, z, t) {
  return sampleWave(x, z, t).height;
}

export function waterNormal(x, z, t, target = new THREE.Vector3()) {
  const { dhdx, dhdz } = sampleWave(x, z, t);
  return target.set(-dhdx, 1, -dhdz).normalize();
}
