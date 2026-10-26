// =============================================================================
// Shared material library + environment reflections.
// Stylised toon shading with a soft fresnel rim; metals and glass use standard
// materials with an image-based environment map derived from the locally loaded
// Poly Haven HDR sky (a procedural equirectangular sky remains as a fallback).
// =============================================================================
import * as THREE from 'three';
import { COLORS, WORLD } from '../config.js';

let gradientMap = null;

export function getGradientMap() {
  if (gradientMap) return gradientMap;
  const data = new Uint8Array([86, 150, 208, 255]);
  const tex = new THREE.DataTexture(data, 4, 1, THREE.RedFormat);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  gradientMap = tex;
  return tex;
}

/** Procedural equirectangular sky used for reflections (and PMREM). */
export function buildEnvironmentTexture() {
  const w = 1024;
  const h = 512;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  const grd = ctx.createLinearGradient(0, 0, 0, h);
  grd.addColorStop(0.0, '#1d5a9e');
  grd.addColorStop(0.28, '#3f87c4');
  grd.addColorStop(0.46, '#8fc3de');
  grd.addColorStop(0.5, '#d9ecf2');
  grd.addColorStop(0.5, '#cfe6ef');
  grd.addColorStop(0.62, '#7fb6cc');
  grd.addColorStop(1.0, '#2a6a83');
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, w, h);
  // warm sun glow
  const sunU = (Math.atan2(WORLD.sunDirection.z, WORLD.sunDirection.x) / (Math.PI * 2) + 0.5) * w;
  const sunV = (1 - (Math.asin(WORLD.sunDirection.y) / Math.PI + 0.5)) * h;
  const sunGrd = ctx.createRadialGradient(sunU, sunV, 4, sunU, sunV, 190);
  sunGrd.addColorStop(0, 'rgba(255,246,220,1)');
  sunGrd.addColorStop(0.12, 'rgba(255,238,196,0.95)');
  sunGrd.addColorStop(0.35, 'rgba(255,226,170,0.4)');
  sunGrd.addColorStop(1, 'rgba(255,226,170,0)');
  ctx.fillStyle = sunGrd;
  ctx.fillRect(0, 0, w, h);
  // soft cloud bands for interesting reflections
  ctx.globalAlpha = 0.5;
  for (let i = 0; i < 26; i++) {
    const x = Math.random() * w;
    const y = h * (0.28 + Math.random() * 0.18);
    const rw = 40 + Math.random() * 120;
    const rh = 6 + Math.random() * 12;
    const g2 = ctx.createRadialGradient(x, y, 1, x, y, rw);
    g2.addColorStop(0, 'rgba(255,250,240,0.9)');
    g2.addColorStop(1, 'rgba(255,250,240,0)');
    ctx.fillStyle = g2;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(1, rh / rw);
    ctx.beginPath();
    ctx.arc(0, 0, rw, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  ctx.globalAlpha = 1;
  const tex = new THREE.CanvasTexture(canvas);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

let envMap = null;
/**
 * Environment map for metal / glass materials.
 * Uses the HDR panorama's PMREM when available (matching the visible sky),
 * otherwise falls back to the procedural sky canvas.
 */
export function createEnvironment(renderer, hdrEnvMap = null) {
  if (envMap) return envMap;
  if (hdrEnvMap) {
    envMap = hdrEnvMap;
    return envMap;
  }
  const eq = buildEnvironmentTexture();
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const target = pmrem.fromEquirectangular(eq);
  envMap = target.texture;
  eq.dispose();
  pmrem.dispose();
  return envMap;
}

// -----------------------------------------------------------------------------
function makeToon(color, opts = {}) {
  const mat = new THREE.MeshToonMaterial({
    color,
    gradientMap: getGradientMap(),
    transparent: opts.transparent ?? false,
    opacity: opts.opacity ?? 1,
    side: opts.side ?? THREE.FrontSide,
    emissive: opts.emissive ?? 0x000000,
    emissiveIntensity: opts.emissiveIntensity ?? 1,
    depthWrite: opts.depthWrite ?? true,
    fog: opts.fog ?? true,
  });
  const rimColor = new THREE.Color(opts.rimColor ?? 0xa8dcff);
  const rimStrength = opts.rim ?? 0.18;
  const rimPower = opts.rimPower ?? 3.0;
  if (rimStrength > 0) {
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.rimColor = { value: rimColor };
      shader.uniforms.rimStrength = { value: rimStrength };
      shader.uniforms.rimPower = { value: rimPower };
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform vec3 rimColor;\nuniform float rimStrength;\nuniform float rimPower;')
        .replace(
          'vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + totalEmissiveRadiance;',
          `float rimF = pow(1.0 - clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0), rimPower);
          vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + totalEmissiveRadiance + rimColor * rimF * rimStrength;`,
        );
    };
    mat.customProgramCacheKey = () => `toon-rim-${rimStrength}-${rimPower}`;
  }
  return mat;
}

function makeMetal(color, metalness = 0.72, roughness = 0.34, opts = {}) {
  return new THREE.MeshStandardMaterial({
    color,
    metalness,
    roughness,
    envMap,
    envMapIntensity: opts.envMapIntensity ?? 0.9,
    flatShading: opts.flatShading ?? false,
    side: opts.side ?? THREE.FrontSide,
    transparent: opts.transparent ?? false,
    opacity: opts.opacity ?? 1,
    emissive: opts.emissive ?? 0x000000,
    emissiveIntensity: opts.emissiveIntensity ?? 1,
    fog: opts.fog ?? true,
    depthWrite: opts.depthWrite ?? true,
  });
}

function makeGlow(color, opts = {}) {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: opts.transparent ?? false,
    opacity: opts.opacity ?? 1,
    blending: opts.blending ?? THREE.NormalBlending,
    depthWrite: opts.depthWrite ?? true,
    side: opts.side ?? THREE.FrontSide,
    fog: opts.fog ?? false,
    toneMapped: opts.toneMapped ?? false,
  });
}

function makeGlass(opts = {}) {
  return new THREE.MeshStandardMaterial({
    color: opts.color ?? COLORS.glass,
    metalness: opts.metalness ?? 0.55,
    roughness: opts.roughness ?? 0.12,
    envMap,
    envMapIntensity: opts.envMapIntensity ?? 1.25,
    transparent: opts.transparent ?? false,
    opacity: opts.opacity ?? 1,
    emissive: opts.emissive ?? 0x122b3a,
    emissiveIntensity: opts.emissiveIntensity ?? 0.35,
    flatShading: opts.flatShading ?? false,
    fog: opts.fog ?? true,
  });
}

function makeOutline(width = 0.14) {
  const mat = new THREE.MeshBasicMaterial({
    color: COLORS.outliner,
    side: THREE.BackSide,
    fog: true,
  });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.outlineWidth = { value: width };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float outlineWidth;')
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\ntransformed += normalize(normal) * outlineWidth;',
      );
  };
  mat.customProgramCacheKey = () => `outline-${width}`;
  return mat;
}

/**
 * Build the shared material registry.
 * Keys are the same names every model builder uses through Builder.
 */
export function createMaterials(renderer, hdr = null) {
  createEnvironment(renderer, hdr?.envMap ?? null);

  const M = {
    // ---- hull / topside paints (toon) ------------------------------------
    pearl: makeToon(COLORS.pearl, { rim: 0.22 }),
    white: makeToon(COLORS.white, { rim: 0.16 }),
    ivory: makeToon(COLORS.ivory, { rim: 0.18 }),
    navy: makeToon(COLORS.navy, { rim: 0.14, rimColor: 0x9fd8ff }),
    navyLight: makeToon(COLORS.navyLight, { rim: 0.16 }),
    hullBottom: makeToon(COLORS.hullBottom, { rim: 0.05 }),
    graphite: makeToon(COLORS.graphite, { rim: 0.12 }),
    darkSteel: makeToon(COLORS.darkSteel, { rim: 0.1 }),
    deckGray: makeToon(COLORS.deckGray, { rim: 0.08 }),
    deckDark: makeToon(COLORS.deckDark, { rim: 0.08 }),
    concrete: makeToon(COLORS.concrete, { rim: 0.06 }),
    black: makeToon(COLORS.black, { rim: 0.02 }),
    rubber: makeToon(COLORS.rubber, { rim: 0.03 }),

    // ---- metals -----------------------------------------------------------
    silver: makeMetal(COLORS.silver, 0.55, 0.36),
    metal: makeMetal(COLORS.metal, 0.8, 0.3),
    metalDark: makeMetal(COLORS.metalDark, 0.78, 0.36),
    steel: makeMetal(0xb9c6cc, 0.72, 0.28),
    hullMetal: makeMetal(0xdde3e2, 0.35, 0.4),
    gold: makeMetal(COLORS.gold, 0.85, 0.28),

    // ---- glass ------------------------------------------------------------
    glass: makeGlass(),
    glassLight: makeGlass({ color: 0x2e5d74, metalness: 0.4, roughness: 0.1, emissive: 0x2a637c, emissiveIntensity: 0.5 }),
    glassWarm: makeGlass({ color: 0x3a4a44, metalness: 0.1, roughness: 0.18, emissive: 0xffdd9a, emissiveIntensity: 1.2 }),

    // ---- accents ----------------------------------------------------------
    signalOrange: makeToon(COLORS.signalOrange, { rim: 0.16 }),
    safetyOrange: makeToon(COLORS.safetyOrange, { rim: 0.16 }),
    techCyan: makeToon(COLORS.techCyan, { rim: 0.25, emissive: COLORS.techCyan, emissiveIntensity: 0.32 }),
    warmWhite: makeToon(COLORS.warmWhite, { rim: 0.2 }),

    // ---- nature -----------------------------------------------------------
    rock: makeToon(COLORS.rock, { rim: 0.1 }),
    rockDark: makeToon(COLORS.rockDark, { rim: 0.08 }),
    islandRock: makeToon(COLORS.islandRock, { rim: 0.1 }),
    islandRockDark: makeToon(COLORS.islandRockDark, { rim: 0.08 }),
    islandGreen: makeToon(COLORS.islandGreen, { rim: 0.12 }),
    islandGreenDark: makeToon(COLORS.islandGreenDark, { rim: 0.1 }),
    sand: makeToon(COLORS.sand, { rim: 0.06 }),
    sandWet: makeToon(COLORS.sandWet, { rim: 0.06 }),
    seabed: makeToon(COLORS.seabedSand, { rim: 0.0 }),
    coralPink: makeToon(COLORS.coralPink, { rim: 0.15 }),
    coralOrange: makeToon(COLORS.coralOrange, { rim: 0.15 }),
    coralPurple: makeToon(COLORS.coralPurple, { rim: 0.15 }),
    seaweed: makeToon(COLORS.seaweed, { rim: 0.1 }),

    // ---- glowing bits -----------------------------------------------------
    glowCyan: makeGlow(COLORS.neonCyan),
    glowCyanSoft: makeGlow(COLORS.techCyan, { transparent: true, opacity: 0.8 }),
    glowRed: makeGlow(COLORS.navRed),
    glowGreen: makeGlow(COLORS.navGreen),
    glowWarm: makeGlow(COLORS.warmWhite),
    glowOrange: makeGlow(COLORS.signalOrange),
    glowWhite: makeGlow(0xffffff),

    // ---- outlines ---------------------------------------------------------
    outlineBoat: makeOutline(0.13),
    outlineBoatSmall: makeOutline(0.075),
    outlineStructure: makeOutline(0.5),
    outlineThin: makeOutline(0.05),
  };

  // convenience factories (names deliberately chosen so they never shadow a
  // material registry key — e.g. `metal` stays a Material, use `makeMetal`)
  M.toon = (color, opts) => makeToon(color, opts);
  M.makeToon = M.toon;
  M.makeMetal = (color, metalness, roughness, opts) => makeMetal(color, metalness, roughness, opts);
  M.makeGlow = (color, opts) => makeGlow(color, opts);
  M.makeGlass = (opts) => makeGlass(opts);
  M.makeOutline = (width) => makeOutline(width);
  M.glow = (color, opts) => makeGlow(color, opts);
  M.standard = (color, metalness, roughness, opts) => makeMetal(color, metalness, roughness, opts);
  M.glassCustom = (opts) => makeGlass(opts);
  M.outline = (width) => makeOutline(width);
  M.envMap = envMap;
  M.gradientMap = getGradientMap();
  return M;
}

export { makeToon, makeMetal, makeGlow, makeGlass, makeOutline };
