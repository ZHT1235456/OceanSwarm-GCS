// =============================================================================
// OceanSwarm — future autonomous surface-vessel swarm on a vast open sea.
// Third-person free-orbit cinematic scene, no UI.
// =============================================================================
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { WORLD, COLORS, LAYOUT } from './config.js';
import { createMaterials } from './core/materials.js';
import { createSky } from './core/sky.js';
import { createOcean } from './core/ocean.js';
import { loadHdrSky } from './core/hdri.js';
import { loadWaterNormalTexture } from './core/water-normal.js';
import { createFleet } from './objects/ships/index.js';
import { Fleet } from './systems/formation.js';
import { createWakes } from './objects/effects/wakes.js';
import { createTechFx } from './objects/effects/tech.js';
import { createBirds } from './objects/effects/birds.js';
import { createIslands } from './objects/world/islands.js';
import { createReef } from './objects/world/reef.js';
import { createBase } from './objects/world/base.js';
import { createMothership } from './objects/world/mothership.js';
import { createMarkers } from './objects/world/markers.js';
import { createSwarmControl } from './systems/swarm-control.js';
import { createSceneBridge } from './gcs/scene-bridge.js';
import { META } from './gcs/meta.js';
import { createGcsConsole } from './ui/index.js';

const app = document.getElementById('app');

// -----------------------------------------------------------------------------
// renderer
// -----------------------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({
  antialias: true,
  powerPreference: 'high-performance',
  alpha: false,
  stencil: false,
  logarithmicDepthBuffer: false,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, WORLD.renderer.maxPixelRatio));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = WORLD.renderer.exposure;
renderer.shadowMap.enabled = false;
app.appendChild(renderer.domElement);

// -----------------------------------------------------------------------------
// local art assets — atmosphere + water micro-relief
// Poly Haven "Kloppenheim 06 (Pure Sky)" 2K HDR lives in public/hdr/ and the
// tiled water normal map in public/textures/. Both are served from the app's own
// origin and loaded up-front so the very first frame already has the final sky,
// sea reflections and water surface detail (offline-capable; each asset falls
// back gracefully if it is ever missing).
// -----------------------------------------------------------------------------
const [hdrSky, waterNormals] = await Promise.all([
  loadHdrSky(renderer).catch((err) => {
    console.error('[hdri] local HDR sky unavailable — using procedural sky fallback:', err);
    return null;
  }),
  loadWaterNormalTexture(renderer).catch((err) => {
    console.error('[water] local water normal map unavailable — using procedural ripples only:', err);
    return null;
  }),
]);

// -----------------------------------------------------------------------------
// scene / camera / controls
// -----------------------------------------------------------------------------
const scene = new THREE.Scene();
scene.background = new THREE.Color(COLORS.haze);
scene.fog = new THREE.FogExp2(WORLD.fogColor, WORLD.fogDensity);

const camera = new THREE.PerspectiveCamera(
  WORLD.camera.fov,
  window.innerWidth / window.innerHeight,
  WORLD.camera.near,
  WORLD.camera.far,
);
camera.position.set(-320, 130, 240);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = WORLD.camera.dampingFactor;
controls.rotateSpeed = WORLD.camera.rotateSpeed;
controls.panSpeed = WORLD.camera.panSpeed;
controls.zoomSpeed = WORLD.camera.zoomSpeed;
controls.minDistance = WORLD.camera.minDistance;
controls.maxDistance = WORLD.camera.maxDistance;
controls.minPolarAngle = WORLD.camera.minPolarAngle;
controls.maxPolarAngle = WORLD.camera.maxPolarAngle;
controls.screenSpacePanning = false;
controls.target.set(0, 6, 0);
controls.update();

// -----------------------------------------------------------------------------
// lighting: warm low sun + cool sky dome light + soft fill
// -----------------------------------------------------------------------------
const sun = new THREE.DirectionalLight(WORLD.sunColor, WORLD.sunIntensity);
sun.position.copy(WORLD.sunDirection).multiplyScalar(9000);
sun.target.position.set(0, 0, 0);
scene.add(sun);
scene.add(sun.target);

const hemi = new THREE.HemisphereLight(WORLD.hemisphereSky, WORLD.hemisphereGround, WORLD.hemisphereIntensity);
scene.add(hemi);

const fill = new THREE.DirectionalLight(WORLD.fillColor, WORLD.fillIntensity);
fill.position.set(-WORLD.sunDirection.x * 6000, 2200, -WORLD.sunDirection.z * 6000);
fill.target.position.set(0, 0, 0);
scene.add(fill);
scene.add(fill.target);

// -----------------------------------------------------------------------------
// materials, sky, ocean
// -----------------------------------------------------------------------------
const materials = createMaterials(renderer, hdrSky);
const sky = createSky(hdrSky);
scene.add(sky.group);

const ocean = createOcean(hdrSky, waterNormals);
scene.add(ocean.mesh);

// -----------------------------------------------------------------------------
// world modules (each tolerant of a late/absent module)
// -----------------------------------------------------------------------------
const worldModules = [];
function mountWorld(name, factory, opts = {}) {
  try {
    const mod = factory(materials, opts);
    if (!mod) return;
    if (mod.group) scene.add(mod.group);
    worldModules.push(mod);
  } catch (err) {
    console.error(`[world:${name}]`, err);
  }
}
mountWorld('islands', createIslands);
mountWorld('reef', createReef);
mountWorld('base', createBase);
mountWorld('mothership', createMothership);
mountWorld('markers', createMarkers);

// -----------------------------------------------------------------------------
// fleet + formation (the GCS swarm controller owns commanded formations and
// per-vessel autonomous tasks; Fleet keeps the inherited hull dynamics)
// -----------------------------------------------------------------------------
const boats = createFleet(materials);
for (const boat of boats) scene.add(boat.group);
const fleet = new Fleet(boats);
const swarm = createSwarmControl({ fleet, boats, meta: META });
fleet.snap();
const flagship = boats.find((b) => b.type === 'flagship') || boats[0];

// -----------------------------------------------------------------------------
// effects
// -----------------------------------------------------------------------------
let wakes = null;
let tech = null;
let birds = null;
try {
  wakes = createWakes(boats);
  if (wakes?.group) scene.add(wakes.group);
} catch (err) {
  console.error('[wakes]', err);
}
try {
  tech = createTechFx(boats, flagship);
  if (tech?.group) scene.add(tech.group);
} catch (err) {
  console.error('[tech fx]', err);
}
try {
  birds = createBirds();
  if (birds?.group) scene.add(birds.group);
} catch (err) {
  console.error('[birds]', err);
}

// -----------------------------------------------------------------------------
// camera presets / initial framing
// -----------------------------------------------------------------------------
const _v = new THREE.Vector3();
// GCS framing: the swarm has to read well inside the centre viewport of the
// operator console — a slightly raised rear-quarter vantage that keeps the
// golden-hour horizon in frame while the formation fills the observation window.
const CONSOLE_VIEW = { back: 660, up: 210, right: 205, targetAhead: 80, targetHeight: 10 };
function setCameraFromFleet() {
  const fwd = fleet.forward;
  const right = fleet.right;
  const target = fleet.center.clone().addScaledVector(fwd, CONSOLE_VIEW.targetAhead);
  target.y = CONSOLE_VIEW.targetHeight;
  camera.position
    .copy(target)
    .addScaledVector(fwd, -CONSOLE_VIEW.back)
    .addScaledVector(right, CONSOLE_VIEW.right)
    .add(new THREE.Vector3(0, CONSOLE_VIEW.up, 0));
  controls.target.copy(target);
  controls.update();
}
setCameraFromFleet();

const shipPos = (b) => (b ? b.group.position : fleet.center);

function viewDefault() {
  setCameraFromFleet();
}
function viewLow() {
  const fp = shipPos(flagship);
  const fwd = fleet.forward;
  const right = fleet.right;
  controls.target.copy(fp).addScaledVector(fwd, 18).add(new THREE.Vector3(0, 2.2, 0));
  camera.position
    .copy(fp)
    .addScaledVector(fwd, -26)
    .addScaledVector(right, 17)
    .add(new THREE.Vector3(0, 4.6, 0));
  controls.update();
}
function viewTop() {
  const c = fleet.center;
  controls.target.copy(c).add(new THREE.Vector3(0, 4, 0));
  camera.position.copy(c).addScaledVector(fleet.forward, 60).addScaledVector(fleet.right, 40).add(new THREE.Vector3(0, 780, 0));
  controls.update();
}
function viewFleet() {
  // show the whole cooperative formation: forward vanguard, both wings and the
  // support group astern, from a raised rear-quarter vantage point.
  const c = fleet.center;
  controls.target.copy(c).add(new THREE.Vector3(0, 6, 0));
  camera.position
    .copy(c)
    .addScaledVector(fleet.forward, -330)
    .addScaledVector(fleet.right, 80)
    .add(new THREE.Vector3(0, 235, 0));
  controls.update();
}
function viewBow() {
  const fp = shipPos(flagship);
  controls.target.copy(fp).add(new THREE.Vector3(0, 3.6, 0));
  camera.position
    .copy(fp)
    .addScaledVector(fleet.forward, 36)
    .addScaledVector(fleet.right, -28)
    .add(new THREE.Vector3(0, 6.5, 0));
  controls.update();
}
function viewSide() {
  const fp = shipPos(flagship);
  controls.target.copy(fp).add(new THREE.Vector3(0, 4, 0));
  camera.position
    .copy(fp)
    .addScaledVector(fleet.forward, 4)
    .addScaledVector(fleet.right, -46)
    .add(new THREE.Vector3(0, 10, 0));
  controls.update();
}
function viewBase() {
  // frame the base tower, the quay/pier fingers and the moored mothership
  const b = LAYOUT.base;
  const m = LAYOUT.mothership;
  controls.target.set((b.x + m.x) * 0.5 + 60, 34, (b.z + m.z) * 0.5 - 40);
  camera.position.set(b.x + 330, 152, b.z + 420);
  controls.update();
}
function viewReef() {
  const r = LAYOUT.reef;
  controls.target.set(r.x - 40, -2, r.z + 40);
  camera.position.set(r.x - 300, 86, r.z + 430);
  controls.update();
}
const VIEWS = {
  default: viewDefault,
  low: viewLow,
  top: viewTop,
  fleet: viewFleet,
  bow: viewBow,
  side: viewSide,
  base: viewBase,
  reef: viewReef,
};
function setView(name) {
  const fn = VIEWS[name] || viewDefault;
  fn();
}

const urlParams = new URLSearchParams(window.location.search);
const requestedView = urlParams.get('view');
if (requestedView && VIEWS[requestedView]) setView(requestedView);

// -----------------------------------------------------------------------------
// GCS integration: simulation engine + scene bridge (camera director, selection
// FX, truth provider) + the operator console UI mounted above the 3D scene.
// -----------------------------------------------------------------------------
const stats = { fps: 0, drawCalls: 0, triangles: 0, boats: boats.length };
let simPaused = false;
// animation-loop runtime state (declared before the console mounts so every
// callback captured by the GCS integration is initialised)
let paused = false;
let time = 0;
let frames = 0;
let fpsElapsed = 0;
let firstFrame = true;
let lastNow = performance.now();

/** Refresh the camera-dependent scene systems and render one frame. */
function renderScene() {
  scene.updateMatrixWorld(true);
  camera.updateMatrixWorld(true);
  camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
  ocean.update(time, camera);
  sky.update(time, camera);
  renderer.render(scene, camera);
}

let createSimFactory = null;
try {
  const simModule = await import('./sim/index.js');
  if (typeof simModule.createSim === 'function') {
    createSimFactory = simModule.createSim;
    console.info('[gcs] simulation engine loaded from src/sim');
  }
} catch (err) {
  console.warn('[gcs] src/sim unavailable — falling back to the bootstrap mock sim:', err?.message || err);
}
if (typeof createSimFactory !== 'function') {
  const mock = await import('./ui/mock-sim.js');
  createSimFactory = mock.createSim;
}

const bridge = createSceneBridge({
  scene,
  camera,
  controls,
  renderer,
  fleet,
  boats,
  flagship,
  swarm,
  setView,
  pauseSim() {
    simPaused = true;
  },
  resumeSim() {
    simPaused = false;
    lastNow = performance.now();
  },
  isPaused() {
    return simPaused;
  },
  renderFrame: renderScene,
  getStats: () => ({ ...stats }),
});

const gcs = await createGcsConsole({
  scene3d: bridge.scene3d,
  sceneProvider: bridge.sceneProvider,
  simFactory: createSimFactory,
  getLiveVessels: bridge.getLiveVessels,
  getRenderStats: () => ({ ...stats }),
});
// The console API exposed as window.__gcs is the UI root's inner object; enrich
// it with the scene-side handles used by the QA harness.
const gcsApi = gcs.gcs || gcs;
gcsApi.pause = () => bridge.scene3d.pause();
gcsApi.resume = () => bridge.scene3d.resume();
gcsApi.renderFrame = renderScene;
// QA-only full freeze: stops the render loop entirely so headless screenshots
// stay cheap and perfectly reproducible (no RAF painting under SwiftShader).
gcsApi.freeze = () => {
  paused = true;
};
gcsApi.unfreeze = () => {
  paused = false;
  lastNow = performance.now();
};
gcsApi.bridge = bridge;
gcsApi.swarm = swarm;

// --- pointer picking: click a hull in the 3D view to select it ---------------
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const boatRoots = boats.map((b) => b.group);
let pickDown = null;
const canvasEl = renderer.domElement;
canvasEl.addEventListener('pointerdown', (ev) => {
  pickDown = { x: ev.clientX, y: ev.clientY, t: performance.now() };
});
canvasEl.addEventListener('pointerup', (ev) => {
  if (!pickDown) return;
  const moved = Math.hypot(ev.clientX - pickDown.x, ev.clientY - pickDown.y);
  const held = performance.now() - pickDown.t;
  pickDown = null;
  if (moved > 6 || held > 500) return; // was an orbit / pan gesture
  const rect = canvasEl.getBoundingClientRect();
  pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects(boatRoots, true);
  if (!hits.length) return;
  let obj = hits[0].object;
  while (obj && !boatRoots.includes(obj)) obj = obj.parent;
  const boat = boats.find((b) => b.group === obj);
  if (boat) gcs.ctx.actions.selectVessel(boat.id);
});
canvasEl.addEventListener('dblclick', (ev) => {
  const rect = canvasEl.getBoundingClientRect();
  pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects(boatRoots, true);
  if (!hits.length) return;
  let obj = hits[0].object;
  while (obj && !boatRoots.includes(obj)) obj = obj.parent;
  const boat = boats.find((b) => b.group === obj);
  if (boat) gcs.ctx.actions.focusVessel(boat.id);
});

// -----------------------------------------------------------------------------
// resize
// -----------------------------------------------------------------------------
function onResize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, WORLD.renderer.maxPixelRatio));
  renderer.setSize(w, h);
}
window.addEventListener('resize', onResize);

// -----------------------------------------------------------------------------
// debug hook (used by the QA harness, invisible in the scene)
// -----------------------------------------------------------------------------
window.__oceanSwarm = {
  ready: false,
  scene,
  camera,
  controls,
  renderer,
  fleet,
  boats,
  swarm,
  bridge,
  gcs,
  sky,
  ocean,
  hdr: hdrSky,
  sunLight: sun,
  hemiLight: hemi,
  fillLight: fill,
  setView,
  stats,
  // live art-direction knobs (QA / tuning only; not used by gameplay)
  setHdrIntensity(v) {
    sky.uniforms.uSkyIntensity.value = v;
    if (ocean.uniforms?.uSkyIntensity) ocean.uniforms.uSkyIntensity.value = v;
  },
  setExposure(v) {
    renderer.toneMappingExposure = v;
  },
  setSunDirection(x, y, z) {
    const dir = new THREE.Vector3(x, y, z).normalize();
    sun.position.copy(dir).multiplyScalar(9000);
    fill.position.set(-dir.x * 6000, 2200, -dir.z * 6000);
    sky.uniforms.uSunDir.value.copy(dir);
    if (ocean.uniforms?.uSunDir) ocean.uniforms.uSunDir.value.copy(dir);
  },
  pause() {
    paused = true;
  },
  resume() {
    paused = false;
    lastNow = performance.now();
  },
  isPaused() {
    return paused;
  },
  // deterministic single frame for headless QA: apply the current camera pose
  // to the camera-following systems and render once.
  renderFrame: renderScene,
};

// -----------------------------------------------------------------------------
// animation loop
// -----------------------------------------------------------------------------
function updateWorldModules(dt) {
  for (let i = 0; i < worldModules.length; i++) {
    const m = worldModules[i];
    if (m.update) {
      try {
        m.update(time, dt);
      } catch (err) {
        console.error('[world update]', err);
        m.update = null;
      }
    }
  }
}

function animate() {
  requestAnimationFrame(animate);
  const now = performance.now();
  const rawDt = Math.min((now - lastNow) / 1000, 0.5);
  lastNow = now;
  const realDt = Math.min(rawDt, 0.1);
  if (paused) return;

  // GCS pause freezes the simulation clock but keeps camera + UI alive so
  // operators / QA can still inspect and operate the console.
  const dt = simPaused ? 0 : realDt;
  if (!simPaused) time += dt;

  // 1. fleet motion + vessel internal animation (commanded formation control
  //    runs right after the inherited dynamics and writes slot/auto overrides)
  fleet.update(dt);
  swarm.update(dt);

  // 2. camera director + world transforms of the command-controlled fleet
  bridge.update(realDt);
  scene.updateMatrixWorld(true);

  // 3. water-contact effects read the updated world transforms
  if (wakes?.update) wakes.update(time, dt);
  if (tech?.update) tech.update(time, dt);
  if (birds?.update) birds.update(time, dt);

  // 4. environment animation
  updateWorldModules(dt);
  ocean.update(time, camera);
  sky.update(time, camera);

  // 5. operator console (DOM/CSS2D UI; reads the sim snapshot, never renders 3D)
  camera.updateMatrixWorld(true);
  camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
  gcs.frame(realDt, now);

  renderer.render(scene, camera);

  if (firstFrame) {
    firstFrame = false;
    window.__oceanSwarm.ready = true;
  }

  frames++;
  fpsElapsed += rawDt;
  if (fpsElapsed >= 0.5) {
    stats.fps = Math.round(frames / fpsElapsed);
    stats.drawCalls = renderer.info.render.calls;
    stats.triangles = renderer.info.render.triangles;
    frames = 0;
    fpsElapsed = 0;
  }

  // expose a smooth simulation clock for any external tooling
  window.__oceanSwarm.simTime = time;
}

animate();
