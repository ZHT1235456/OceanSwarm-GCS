// =============================================================================
// Scene bridge — the adapter between the three.js world and the GCS console.
// Exposes:
//   scene3d       : camera director + selection FX + world→screen projection
//                   + pause hooks for the QA harness (used by ctx.scene3d)
//   sceneProvider : the read-only truth source consumed by the Sim engine
//                   (getSceneState / execute / origin / base)
//   update(dt)    : per-frame camera / FX update (called from main's loop)
// =============================================================================
import * as THREE from 'three';
import { createCameraDirector } from '../systems/camera-director.js';
import { createSelectionFx } from '../objects/effects/selection.js';
import { META } from '../gcs/meta.js';
import { projectWorld } from '../gcs/meta.js';

export function createSceneBridge({
  scene,
  camera,
  controls,
  renderer,
  fleet,
  boats,
  flagship,
  swarm,
  setView,
  pauseSim,
  resumeSim,
  isPaused,
  renderFrame,
  getStats,
}) {
  const director = createCameraDirector({ camera, controls, fleet, boats });
  const fx = createSelectionFx({ scene, boats });

  const canvas = renderer.domElement;
  const _v = new THREE.Vector3();

  // --- live hull list (fresh every frame; used by HUD / tactical map) ---------
  let liveCache = [];
  let liveCacheSeq = 0;
  function getLiveVessels() {
    // Cheap enough to rebuild per call (17 hulls), but cache within a frame via
    // a monotonically increasing token so multiple modules share one array.
    const state = swarm.getState();
    liveCache = state.vessels.map((v) => {
      const vm = META.FLEET_BY_ID.get(v.id);
      const geo = projectWorld(v.x, v.z);
      return {
        id: v.id,
        type: v.type,
        callSign: vm ? vm.callSign : v.id,
        name: vm ? vm.name : v.id,
        x: v.x,
        z: v.z,
        yawRad: v.yawRad,
        headingDeg: v.headingDeg,
        pitchRad: v.pitchRad,
        rollRad: v.rollRad,
        heaveM: v.heaveM,
        mode: v.mode,
        sogKn: fleet.speedKn,
        lat: geo.lat,
        lon: geo.lon,
        stationErrorM: v.stationErrorM,
      };
    });
    liveCacheSeq++;
    return liveCache;
  }

  function project(x, y, z) {
    _v.set(x, y, z).project(camera);
    const rect = canvas.getBoundingClientRect();
    return {
      x: rect.left + (_v.x * 0.5 + 0.5) * rect.width,
      y: rect.top + (-_v.y * 0.5 + 0.5) * rect.height,
      visible: _v.z < 1 && _v.x > -1.15 && _v.x < 1.15 && _v.y > -1.15 && _v.y < 1.15,
      depth: _v.z,
    };
  }

  const scene3d = {
    focusVessel(id) {
      director.focusVessel(id);
    },
    focusFleet() {
      director.focusFleet();
    },
    setCameraMode(mode) {
      director.setMode(mode);
    },
    getCameraMode() {
      return director.getMode();
    },
    applyPreset(key) {
      director.applyPreset(() => setView(key));
    },
    get lockId() {
      return director.getLockId();
    },
    setSelection(id) {
      fx.setSelected(id);
    },
    setWaypoint(x, z, label) {
      fx.setWaypoint(x, z, label);
    },
    project,
    get presets() {
      return META.CAMERA_PRESETS;
    },
    pause() {
      pauseSim?.();
    },
    resume() {
      resumeSim?.();
    },
    isPaused() {
      return !!isPaused?.();
    },
    renderFrame() {
      renderFrame?.();
    },
    stats() {
      return getStats?.() || { fps: 0, drawCalls: 0, triangles: 0 };
    },
    getCanvasRect: () => canvas.getBoundingClientRect(),
    scene,
    camera,
    controls,
    fleet,
    boats,
  };

  const base = META.HOME_BASE;
  const baseGeo = projectWorld(base.x, base.z);
  const sceneProvider = {
    origin: { lat0: META.GEO.lat0, lon0: META.GEO.lon0 },
    base: { x: base.x, z: base.z, lat: baseGeo.lat, lon: baseGeo.lon },
    getSceneState() {
      const s = swarm.getState();
      return {
        simTime: s.simTime,
        paused: !!isPaused?.(),
        fleet: {
          centerX: s.fleet.centerX,
          centerZ: s.fleet.centerZ,
          headingDeg: s.fleet.headingDeg,
          yawRad: s.fleet.yawRad,
          speedKn: s.fleet.speedKn,
          speedScale: s.fleet.speedScale,
          mode: s.fleet.mode,
          formationKey: s.fleet.formationKey,
          formationText: s.fleet.formationText,
          formationEn: s.fleet.formationEn,
          rtlDistanceM: s.fleet.rtlDistanceM,
          rtlBearingDeg: s.fleet.rtlBearingDeg,
          estopActive: s.fleet.estopActive,
          holdActive: s.fleet.holdActive,
        },
        vessels: s.vessels,
      };
    },
    execute(cmd) {
      return swarm.command(cmd);
    },
  };

  function update(dt) {
    // Refresh the live hull cache once per frame so every module sees the same
    // positions within this frame.
    getLiveVessels();
    director.update(dt);
    fx.update(dt, performance.now());
  }

  return {
    scene3d,
    sceneProvider,
    director,
    fx,
    update,
    getLiveVessels,
    getLiveCacheSeq: () => liveCacheSeq,
    project,
  };
}
