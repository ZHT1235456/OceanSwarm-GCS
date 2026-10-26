// =============================================================================
// Atmospheric sky: a locally loaded Poly Haven HDR panorama
// ("Kloppenheim 06 Pure Sky", 2K equirectangular) sampled by a sky dome.
//
// Orbiting the camera reveals the real panoramic content in every direction:
// golden backlit cumulus around the low sun (az ~41°, el ~5°), scattered clouds
// across the rest of the sphere and a cool deep-blue zenith.
//
// The same HDR lookup is shared with the ocean shader (`HDR_SKY_GLSL`) so the
// horizon line stays seamless: the sea's distance haze is the HDR horizon in
// that exact view direction, not a flat colour. A procedural `skyTint()` fallback
// keeps the scene alive if the local HDR file is ever missing.
// =============================================================================
import * as THREE from 'three';
import { COLORS, WORLD } from '../config.js';

// -----------------------------------------------------------------------------
// Shared uniforms between sky dome, ocean horizon and environment reflections
// -----------------------------------------------------------------------------
export function createSkyUniforms(hdr = null) {
  return {
    uSunDir: { value: WORLD.sunDirection.clone() },
    uSunColor: { value: new THREE.Color(COLORS.skySun) },
    uSkyTop: { value: new THREE.Color(COLORS.skyTop) },
    uSkyMid: { value: new THREE.Color(COLORS.skyMid) },
    uSkyHorizon: { value: new THREE.Color(COLORS.skyHorizon) },
    uHaze: { value: new THREE.Color(WORLD.fogColor) },
    uSkyMap: { value: hdr?.texture ?? null },
    uSkyReady: { value: hdr?.texture ? 1 : 0 },
    uSkyIntensity: { value: WORLD.sky.hdrIntensity },
  };
}

// GLSL shared by sky dome + ocean (procedural fallback sky gradient).
export const SKY_GLSL = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyTop;
uniform vec3 uSkyMid;
uniform vec3 uSkyHorizon;
uniform vec3 uHaze;

// vertical atmospheric gradient including a wide warm scatter around the sun.
vec3 skyTint(vec3 dir) {
  float h = max(dir.y, 0.0);
  vec3 col = mix(uSkyHorizon, uSkyMid, smoothstep(0.0, 0.20, h));
  col = mix(col, uSkyTop, smoothstep(0.10, 0.72, h));

  float sd = max(dot(dir, uSunDir), 0.0);
  float nearHorizon = 1.0 - smoothstep(0.0, 0.55, h);
  vec3 warm = uSunColor * mix(vec3(1.0, 0.86, 0.66), vec3(1.0), nearHorizon);
  float scatter = pow(sd, 7.0) * 0.55 + pow(sd, 2.2) * 0.14;
  col = mix(col, warm, clamp(scatter * (0.45 + nearHorizon * 0.75), 0.0, 0.9));

  // pale atmospheric band hugging the horizon
  float band = exp(-abs(dir.y) * 26.0);
  col = mix(col, uHaze * 1.02, band * 0.42);
  return col;
}
`;

// Equirectangular HDR lookup shared by sky dome + ocean. Declared after
// SKY_GLSL because the fallback samples skyTint().
export const HDR_SKY_GLSL = /* glsl */ `
uniform sampler2D uSkyMap;
uniform float uSkyReady;
uniform float uSkyIntensity;

// three.js equirectangular convention: u = atan2(z, x) / 2pi + 0.5
vec2 skyEquirectUv(vec3 dir) {
  float u = atan(dir.z, dir.x) * 0.15915494309189535 + 0.5;
  float v = asin(clamp(dir.y, -1.0, 1.0)) * 0.3183098861837907 + 0.5;
  return vec2(u, v);
}

// Radiance of the HDR panorama for a world-space view direction.
// Samples are clamped just above the panorama horizon so the mirrored lower
// hemisphere of the HDRI is never mistaken for open sky / water.
vec3 hdrSky(vec3 dir) {
  vec3 d = normalize(dir);
  d.y = max(d.y, 0.006);
  d = normalize(d);
  return texture2D(uSkyMap, skyEquirectUv(d)).rgb * uSkyIntensity;
}

// HDR sky when the local panorama is loaded, procedural sky otherwise.
vec3 skyRadiance(vec3 dir) {
  if (uSkyReady > 0.5) return hdrSky(dir);
  return skyTint(dir);
}
`;

// -----------------------------------------------------------------------------
const DOME_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  gl_Position.z = gl_Position.w; // force to far plane
}
`;

const DOME_FRAG = /* glsl */ `
${SKY_GLSL}
${HDR_SKY_GLSL}
varying vec3 vDir;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  vec3 dir = normalize(vDir);
  vec3 col;

  if (uSkyReady > 0.5) {
    // Direction-visible HDR panorama. The sector below the panorama horizon is
    // never shown as a mirrored sky: it fades into the atmospheric haze band so
    // the distant edge of the ocean mesh still blends into the sky.
    col = hdrSky(dir);
    if (dir.y < 0.0) {
      // Below the panorama horizon: continue the *sampled* HDR horizon colour
      // downwards (slightly deeper/hazier) instead of switching to a flat haze,
      // so even the far edge of the ocean mesh resolves into the same sky.
      vec3 hdir = vec3(dir.x, 0.0, dir.z);
      hdir = length(hdir) > 1e-4 ? normalize(hdir) : vec3(0.0, 0.0, 1.0);
      vec3 horizon = hdrSky(hdir);
      float k = smoothstep(0.0, 0.55, -dir.y);
      col = mix(horizon, mix(horizon * 0.82, uHaze, 0.3), k);
    }
  } else {
    // Procedural fallback: gradient + warm sun disc / halo.
    col = skyTint(dir);
    float sd = max(dot(dir, uSunDir), 0.0);
    float disc = smoothstep(0.99955, 0.99988, sd);
    float halo = pow(sd, 900.0) * 2.2 + pow(sd, 90.0) * 0.35 + pow(sd, 9.0) * 0.08;
    col += uSunColor * (disc * 14.0 + halo);
    if (dir.y < 0.0) {
      col = mix(uHaze, skyTint(vec3(dir.x, 0.0, dir.z)), exp(dir.y * 30.0));
    }
  }

  // tiny dither to defeat 8-bit banding in the smooth sky gradient
  float dither = (hash12(gl_FragCoord.xy) - 0.5) * 0.0025;
  col += dither;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export function createSky(hdr = null) {
  const root = new THREE.Group();
  const uniforms = createSkyUniforms(hdr);

  const domeMat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: DOME_VERT,
    fragmentShader: DOME_FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
    toneMapped: true,
  });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), domeMat);
  dome.scale.setScalar(48000);
  dome.frustumCulled = false;
  dome.renderOrder = -1000;
  dome.name = 'sky-dome';
  root.add(dome);

  function update(time, camera) {
    if (camera) dome.position.copy(camera.position);
  }

  return { group: root, dome, update, uniforms, hdr, isHdr: !!hdr?.texture };
}
