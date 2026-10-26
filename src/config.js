// =============================================================================
// OceanSwarm — global art direction, world layout and fleet definition.
// All units are meters. Y is up. The fleet starts near the world origin.
//
// Local vessel space convention (shared by every ship builder):
//   +X = bow (forward), +Y = up, +Z = starboard (right)
//   origin = waterline, amidships
// =============================================================================
import * as THREE from 'three';

export const COLORS = {
  // --- ocean ---------------------------------------------------------------
  // Deep water body colour strategy: a dark base that the sky reflection and
  // sun glitter build on top of (per the water-production notes, a flat bright
  // colour makes water look light and "floaty").
  oceanDeep: 0x073a51,
  oceanMid: 0x0e617e,
  oceanLight: 0x1e94a1,
  oceanShallow: 0x3ecfbd,
  oceanShallowLight: 0x8ce8d8,
  oceanCrest: 0xc4f3e6,
  foam: 0xf2fbf8,
  foamWarm: 0xfff8e8,

  // --- sky / atmosphere ----------------------------------------------------
  skyTop: 0x1c5a96,
  skyMid: 0x4f9dca,
  skyHorizon: 0xcae6ef,
  skySun: 0xffe2ad,
  haze: 0xb7d6e5,

  // --- boats / structures --------------------------------------------------
  pearl: 0xf4f6f4,
  white: 0xffffff,
  ivory: 0xe9eeeb,
  silver: 0xc5d0d6,
  metal: 0x93a3ad,
  metalDark: 0x5d6d78,
  graphite: 0x394852,
  darkSteel: 0x233039,
  navy: 0x173a56,
  navyLight: 0x2c6186,
  hullBottom: 0x14344b,
  glass: 0x0e2230,
  glassLit: 0xffe9bd,
  black: 0x0a1116,
  deckGray: 0x647179,
  deckDark: 0x39444b,
  rubber: 0x141b20,
  concrete: 0xc9cfd0,
  rock: 0x7a8488,
  rockDark: 0x4d5a60,

  // --- accents -------------------------------------------------------------
  techCyan: 0x4cefe0,
  neonCyan: 0x8bfff0,
  cyanGlow: 0x2bd8e2,
  signalOrange: 0xff8c2e,
  safetyOrange: 0xff6a1f,
  gold: 0xffd27a,
  warmWhite: 0xfff1cf,
  navRed: 0xff4436,
  navGreen: 0x39e37c,

  // --- nature --------------------------------------------------------------
  islandGreen: 0x6f9e72,
  islandGreenDark: 0x487554,
  islandRock: 0x8f9793,
  islandRockDark: 0x5d696b,
  sand: 0xe8ddb9,
  sandWet: 0xcdbf9a,
  seabedSand: 0xcdc59c,
  coralPink: 0xe08f96,
  coralOrange: 0xe8a564,
  coralPurple: 0xa88bc8,
  seaweed: 0x3f7d62,
  outliner: 0x101c26,
};

export const WORLD = {
  oceanRadius: 26000,
  oceanRings: 236,
  oceanSegments: 320,

  fogColor: 0xb7d6e5,
  fogDensity: 0.000072,

  // ---------------------------------------------------------------------------
  // Sky atmosphere: local Poly Haven HDR panorama, "Kloppenheim 06 (Pure Sky)"
  // 2K equirectangular RGBE (2048 x 1024). Stored in public/hdr/ and loaded
  // from the app's own origin — no CDN / network dependency at runtime.
  // "Pure Sky" means the panorama contains atmosphere only (no ground, no
  // buildings), which is exactly what an open-ocean scene needs.
  // ---------------------------------------------------------------------------
  sky: {
    hdrPath: 'hdr/kloppenheim_06_puresky_2k.hdr',
    // linear radiance multiplier for the panorama (tone-mapping balance)
    hdrIntensity: 0.9,
  },

  // ---------------------------------------------------------------------------
  // Water surface micro-relief: a locally shipped photo normal map (the classic
  // three.js water normals texture) tiled through three stretched, drifting
  // coordinate systems — fine capillary ripples near the camera, mid chop, and
  // broad wind patches at distance — so the surface reads as water at every
  // range. Large swell still comes from the shared wave field.
  // ---------------------------------------------------------------------------
  water: {
    normalMapPath: 'textures/waternormals.jpg',
    // uv repeats per meter; anisotropic y/x stretches the ripples along the
    // dominant wind axis. A = mid chop, B = broad wind patches, C = fine ripples
    normalScaleA: [0.11, 0.19],
    normalScaleB: [0.025, 0.05],
    normalScaleC: [0.5, 0.85],
    // slope multiplier applied to the sampled normal-map gradients
    normalStrength: 1.3,
    // how strongly the fine ripple slopes modulate the water body shading
    // (sun is low, so ripple facets facing it visibly brighten / darken)
    normalShading: 0.95,
  },

  // The key light follows the sun baked into the HDR panorama: azimuth ~40.7°
  // from +X, elevation ~4.7° — the golden-hour sun of the Kloppenheim shoot.
  // Keeping light and sky aligned makes the sea glitter, cloud rims and hull
  // shading agree with the visible sun in every view direction.
  sunDirection: new THREE.Vector3(0.7557, 0.0812, 0.6499).normalize(),
  sunColor: 0xffd9a6,
  sunIntensity: 1.85,

  hemisphereSky: 0xc7dcf0,
  hemisphereGround: 0x2a5a6c,
  hemisphereIntensity: 1.18,

  fillColor: 0xbcd6ee,
  fillIntensity: 0.5,
  rimColor: 0x9fe8ff,

  camera: {
    fov: 47,
    near: 0.4,
    far: 60000,
    // Initial orbit relative to the fleet centre, expressed in the initial
    // heading frame: back along the course, up, and to starboard of the track.
    back: 225,
    up: 72,
    right: 98,
    targetAhead: 10,
    targetHeight: 6,
    minDistance: 16,
    maxDistance: 4200,
    minPolarAngle: 0.13,
    maxPolarAngle: 1.505,
    dampingFactor: 0.05,
    rotateSpeed: 0.62,
    panSpeed: 0.65,
    zoomSpeed: 0.85,
  },

  renderer: {
    maxPixelRatio: 1.75,
    antialias: true,
    exposure: 1.0,
  },
};

export const FORMATION = {
  speed: 3.1, // m/s
  turnRate: 0.0019, // rad/s, wide left arc
  heading0: 0, // +X
  flagshipStart: new THREE.Vector3(-160, 0, 120),
  bobScale: 1.0,
  rollResponse: 0.9,
  pitchResponse: 0.85,
};

// Environmental water current used by the vessel dynamics plant (world frame).
// It matches the sea-state telemetry (0.45 kn towards 210°) and forces the
// controllers to crab / correct drift like a real USV.
export const CURRENT = {
  speedKn: 0.45,
  dirDeg: 210, // compass direction the current flows towards
};

// -----------------------------------------------------------------------------
// Fleet roster. offsets are in the formation frame:
//   [ lateral (+ = starboard/right), forward (+ = ahead) ] in meters.
// -----------------------------------------------------------------------------
export const FLEET_ROSTER = [
  { id: 'flagship', type: 'flagship', variant: 0, offset: [0, 0], phase: 0.0 },
  // --- fast reconnaissance vanguard (arrow) --------------------------------
  { id: 'scout-1', type: 'scout', variant: 0, offset: [0, 186], phase: 0.31, sweep: [0, 9] },
  { id: 'scout-2', type: 'scout', variant: 1, offset: [-82, 130], phase: 1.7, sweep: [-12, 7] },
  { id: 'scout-3', type: 'scout', variant: 0, offset: [90, 124], phase: 2.9, sweep: [12, 6] },
  { id: 'scout-4', type: 'scout', variant: 1, offset: [-218, 62], phase: 4.2, sweep: [-8, -6] },
  { id: 'scout-5', type: 'scout', variant: 0, offset: [224, 46], phase: 5.1, sweep: [16, -9] },
  // --- medium cooperative survey / monitoring wings ------------------------
  { id: 'env-1', type: 'env', variant: 0, offset: [-120, -22], phase: 0.8 },
  { id: 'env-2', type: 'env', variant: 1, offset: [128, -12], phase: 2.2 },
  { id: 'env-3', type: 'env', variant: 2, offset: [-198, -76], phase: 3.6 },
  { id: 'survey-1', type: 'survey', variant: 0, offset: [206, -68], phase: 1.3 },
  { id: 'survey-2', type: 'survey', variant: 1, offset: [-268, -44], phase: 4.8 },
  { id: 'patrol-1', type: 'patrol', variant: 0, offset: [-98, -104], phase: 5.6 },
  { id: 'patrol-2', type: 'patrol', variant: 1, offset: [104, -96], phase: 0.4 },
  // --- support group astern ------------------------------------------------
  { id: 'comms-1', type: 'comms', variant: 0, offset: [50, -126], phase: 2.4 },
  { id: 'energy-1', type: 'energy', variant: 0, offset: [-64, -134], phase: 3.9 },
  { id: 'rescue-1', type: 'rescue', variant: 0, offset: [158, -118], phase: 1.1 },
  { id: 'energy-2', type: 'energy', variant: 1, offset: [-162, -118], phase: 5.3 },
];

export const BOAT_CLASS = {
  flagship: { length: 30, beam: 9.4, draft: 1.7, wakeWidth: 11, wakeStrength: 1.0 },
  scout: { length: 10.5, beam: 3.0, draft: 0.62, wakeWidth: 3.4, wakeStrength: 1.35 },
  env: { length: 16.5, beam: 5.6, draft: 1.0, wakeWidth: 6.0, wakeStrength: 0.9 },
  survey: { length: 18, beam: 7.4, draft: 1.1, wakeWidth: 7.0, wakeStrength: 0.85 },
  patrol: { length: 14.5, beam: 4.7, draft: 0.9, wakeWidth: 5.0, wakeStrength: 1.0 },
  comms: { length: 19, beam: 6.2, draft: 1.15, wakeWidth: 6.6, wakeStrength: 0.8 },
  energy: { length: 20, beam: 7.0, draft: 1.2, wakeWidth: 7.2, wakeStrength: 0.75 },
  rescue: { length: 15.5, beam: 5.4, draft: 1.0, wakeWidth: 5.8, wakeStrength: 0.95 },
};

// -----------------------------------------------------------------------------
// World layout (fixed landmarks). Fleet starts around the origin.
// -----------------------------------------------------------------------------
export const LAYOUT = {
  // left-of-course (screen left from the initial camera) research island & base
  baseIsland: { x: 1420, z: -2220, radius: 300, height: 92, shorelineZ: -1928 },
  base: { x: 1350, z: -2015 },
  mothership: { x: 1845, z: -1805, heading: 2.75 },
  docks: { x: 1560, z: -1890 },

  // right-of-course shallow reef / lagoon (kept inside the initial view cone)
  reef: { x: 2350, z: 720, radius: 760 },
  lighthouse: { x: 2700, z: 280 },

  // mid & far islands on the horizon
  islands: [
    { x: 5350, z: -4350, radius: 520, height: 220, kind: 'mid', seed: 11 },
    { x: 9800, z: 3600, radius: 1250, height: 430, kind: 'far', seed: 29 },
    { x: 2600, z: -6200, radius: 640, height: 170, kind: 'mid', seed: 47 },
  ],

  // remote marine infrastructure
  platform: { x: 3180, z: 700 },
  windFarm: { x: 4600, z: 1500, count: 5, spread: 700 },
  markerZone: { x: 1500, z: 420, width: 1400, depth: 760, count: 18 },
  farBuoys: [
    { x: 3200, z: 1200 },
    { x: 1900, z: 1500 },
  ],
};

// Shallow-water fields used by the ocean shader (ellipses, world XZ).
// e = normalized elliptical distance; shallow when e < 1.
export const SHOALS = [
  // reef / lagoon
  { x: 2350, z: 720, rx: 830, rz: 650, strength: 1.0 },
  { x: 1780, z: 400, rx: 430, rz: 330, strength: 0.6 },
  // shallow shelf around the research island
  { x: 1420, z: -2220, rx: 470, rz: 470, strength: 0.8 },
  // scattered sand banks
  { x: 3350, z: 1050, rx: 320, rz: 230, strength: 0.45 },
];

export const QUALITY = {
  oceanDetail: 1.0,
  boatDetail: 1.0,
  envDetail: 1.0,
};
