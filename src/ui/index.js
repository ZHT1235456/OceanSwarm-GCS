// =============================================================================
// GCS UI root — mounts the shell + all panels, drives the 10 Hz snapshot loop,
// owns global keyboard shortcuts, the boot gate and the window.__gcs QA API.
// The three.js scene integration is injected from src/main.js (scene3d/
// sceneProvider/simFactory) so this module never imports three.js.
// =============================================================================
import './styles/tokens.css';
import './styles/base.css';
import './styles/layout.css';
import { createShell } from './shell.js';
import { createContext } from './context.js';
import { META } from '../gcs/meta.js';

const PARAM = new URLSearchParams(window.location.search);
const HAS = (key) => PARAM.has(key) && PARAM.get(key) !== '0';

// Panels are loaded lazily so one broken / in-flight module can never take the
// whole console down: a failed panel is replaced by an inline error panel.
const PANEL_SPECS = [
  {
    name: 'overlays',
    host: 'overlays',
    factory: 'createOverlaysPanel',
    load: () => import('./panels/overlays.js'),
    required: true,
  },
  { name: 'topbar', host: 'topbar', factory: 'createTopbarPanel', load: () => import('./panels/topbar.js') },
  { name: 'left', host: 'left', factory: 'createLeftPanel', load: () => import('./panels/left.js') },
  { name: 'hud', host: 'hud', factory: 'createHudPanel', load: () => import('./panels/hud.js') },
  { name: 'map', host: 'map', factory: 'createMapPanel', load: () => import('./panels/map.js') },
  { name: 'detail', host: 'right', factory: 'createDetailPanel', load: () => import('./panels/detail.js') },
  { name: 'dock', host: 'dock', factory: 'createDockPanel', load: () => import('./panels/dock.js') },
];

function installKeyboard(ctx, gcs) {
  const isTyping = (target) => {
    const el = target instanceof Element ? target : null;
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
  };

  window.addEventListener('keydown', (ev) => {
    if (ev.defaultPrevented) return;
    const snap = gcs.getSnapshot();
    const fleetMode = snap?.fleet?.mode || 'cruise';

    // While typing in the command console only Enter/Escape are meaningful.
    if (isTyping(ev.target)) return;

    if (ev.key === 'Escape') {
      if (ctx.state.dialogOpen) {
        ctx.actions.closeOverlays();
      } else if (ctx.state.clean) {
        ctx.actions.toggleClean(false);
      } else if (ctx.state.mapTool !== 'select') {
        ctx.actions.setMapTool('select');
      } else if (ctx.state.viewMode === 'map') {
        ctx.actions.setViewMode('3d');
      }
      ev.preventDefault();
      return;
    }

    if (ev.key === '?' || (ev.key === '/' && !ev.shiftKey)) {
      ctx.actions.requestHelp();
      ev.preventDefault();
      return;
    }

    if (ev.key === 'Enter') {
      ctx.bus.emit('focus-console');
      return;
    }

    if (ev.altKey || ev.ctrlKey || ev.metaKey) return;

    const key = ev.key.toLowerCase();

    // formation 1..5
    if (!ev.shiftKey && /^[1-5]$/.test(ev.key)) {
      ctx.actions.setFormation(META.FORMATIONS[Number(ev.key) - 1].key);
      ev.preventDefault();
      return;
    }

    // speed presets Shift+1..3
    if (ev.shiftKey && /^[!@#]$/.test(ev.key)) {
      const preset = META.SPEED_PRESETS['!@#'.indexOf(ev.key)];
      if (preset) ctx.actions.setSpeedScale(preset.scale);
      ev.preventDefault();
      return;
    }

    switch (key) {
      case ' ':
      case 'spacebar': {
        if (fleetMode === 'hold') ctx.actions.resumeFleet();
        else ctx.actions.holdFleet();
        ev.preventDefault();
        break;
      }
      case 'u':
        ctx.actions.uturn();
        ev.preventDefault();
        break;
      case 'f':
        ctx.actions.focusSelected();
        ev.preventDefault();
        break;
      case 'r':
        ctx.actions.focusFleet();
        ev.preventDefault();
        break;
      case 'm':
        ctx.actions.toggleViewMode();
        ev.preventDefault();
        break;
      case 'h':
        ctx.actions.toggleClean();
        ev.preventDefault();
        break;
      default:
        break;
    }
  });
}

export async function createGcsConsole(options) {
  const { scene3d, sceneProvider, simFactory, getLiveVessels, getRenderStats } = options;

  const shell = createShell(document.body);
  document.body.dataset.gcsView = '3d';
  document.body.dataset.gcsClean = '0';

  const skipIntro = HAS('nointro') || HAS('qa');
  const seedParam = Number(PARAM.get('seed'));
  const seed = Number.isFinite(seedParam) ? seedParam : 7;

  // --- simulation ------------------------------------------------------------
  const sim = simFactory({
    scene: sceneProvider,
    meta: META,
    options: {
      seed,
      getRenderStats: () => getRenderStats?.() || { fps: 0, drawCalls: 0, triangles: 0 },
    },
  });

  let latestSnap = null;
  let lastSnapSeq = -1;

  const ctx = createContext({
    scene3d,
    dispatch: (cmd, opts) => sim.dispatch(cmd, opts),
    getSnapshot: () => latestSnap,
    getLiveVessels,
    getSceneState: () => sceneProvider.getSceneState(),
    getRenderStats,
  });
  ctx.state.skipIntro = skipIntro;
  ctx.sim = sim;

  // --- mount panels (errors stay isolated per panel) -------------------------
  const panels = [];
  for (const spec of PANEL_SPECS) {
    const host = shell.hosts[spec.host];
    try {
      if (!host) throw new Error(`missing host #gcs-${spec.host}`);
      const mod = await spec.load();
      const factory = mod[spec.factory];
      if (typeof factory !== 'function') throw new Error(`missing export ${spec.factory}`);
      const panel = factory(ctx);
      await panel.mount(host);
      if (panel.name == null) panel.name = spec.name;
      panels.push(panel);
    } catch (err) {
      console.error(`[gcs:panel:${spec.name}] mount failed`, err);
      if (host) {
        host.innerHTML = `<div class="gcs-panel-error">面板 ${spec.name} 加载失败 · 见控制台</div>`;
      }
    }
  }

  // --- boot gate / ready -----------------------------------------------------
  let booted = false;
  let ready = false;
  const bootWaiters = [];
  const markReady = () => {
    if (ready) return;
    ready = true;
    gcs.ready = true;
    ctx.state.booted = true;
    for (const fn of bootWaiters.splice(0)) {
      try {
        fn();
      } catch (err) {
        console.error('[gcs:ready]', err);
      }
    }
    document.body.classList.add('gcs-ready');
  };
  const markBooted = () => {
    booted = true;
    markReady();
  };
  ctx.markBooted = markBooted;
  const bootTimer = skipIntro
    ? setTimeout(markBooted, 250)
    : setTimeout(() => {
        console.warn('[gcs] boot overlay fallback timeout — forcing ready');
        markBooted();
      }, 5200);

  // --- frame loop ------------------------------------------------------------
  let lastFrameNow = performance.now();
  let simElapsed = 0;
  let fpsAcc = 0;
  let fpsFrames = 0;
  let fps = 0;

  function frame(dt, nowMs) {
    const now = typeof nowMs === 'number' ? nowMs : performance.now();
    const rawDt = Math.min(Math.max((now - lastFrameNow) / 1000, 0), 0.5);
    lastFrameNow = now;
    const frameDt = typeof dt === 'number' ? dt : rawDt;

    // fps estimate for the console badge
    fpsAcc += rawDt;
    fpsFrames += 1;
    if (fpsAcc >= 0.5) {
      fps = Math.round(fpsFrames / fpsAcc);
      fpsAcc = 0;
      fpsFrames = 0;
    }

    try {
      sim.update(frameDt, now);
      simElapsed += frameDt;
      const snap = sim.snapshot();
      if (snap && snap.seq !== lastSnapSeq) {
        latestSnap = snap;
        lastSnapSeq = snap.seq;
        for (const panel of panels) {
          try {
            panel.update?.(snap);
          } catch (err) {
            console.error(`[gcs:panel:${panel.name}] update failed`, err);
            panel.update = null;
          }
        }
        if (!booted && latestSnap) {
          // first useful frame: panels have data; boot overlay owns the rest.
        }
      }
      for (const panel of panels) {
        try {
          panel.frame?.(frameDt, now);
        } catch (err) {
          console.error(`[gcs:panel:${panel.name}] frame failed`, err);
          panel.frame = null;
        }
      }
    } catch (err) {
      console.error('[gcs:frame]', err);
    }
  }

  function onResize() {
    for (const panel of panels) {
      try {
        panel.resize?.();
      } catch (err) {
        console.error(`[gcs:panel:${panel.name}] resize failed`, err);
      }
    }
  }
  window.addEventListener('resize', onResize);

  // --- public QA / debug API -------------------------------------------------
  const gcs = {
    ready: false,
    version: META.APP.version,
    meta: META,
    ctx,
    sim,
    shell,
    getSnapshot: () => latestSnap,
    getVessel: (id) => latestSnap?.vessels?.find((v) => v.id === id) || null,
    select: (id) => ctx.actions.selectVessel(id),
    focus: (id) => ctx.actions.focusVessel(id),
    setView: (mode) => ctx.actions.setViewMode(mode),
    setCameraPreset: (key) => ctx.actions.applyCameraPreset(key),
    dispatch: (cmd) => sim.dispatch(cmd),
    setFormation: (key) => ctx.actions.setFormation(key),
    openHelp: () => ctx.actions.requestHelp(),
    openEstop: () => ctx.actions.estop(),
    openMapTool: (tool = 'goto') => ctx.actions.setMapTool(tool),
    clickMapAt: (x, z) => ctx.actions.placeWaypoint(x, z),
    toggleClean: (force) => ctx.actions.toggleClean(force),
    skipBoot: () => {
      clearTimeout(bootTimer);
      markBooted();
      ctx.dialog.skipBoot?.();
      return true;
    },
    isReady: () => ready,
    onReady: (fn) => (ready ? Promise.resolve(fn()) : new Promise((resolve) => bootWaiters.push(() => resolve(fn())))),
    stats: () => ({
      fps,
      simElapsed: Math.round(simElapsed * 10) / 10,
      panels: panels.map((p) => p.name),
      seq: latestSnap?.seq ?? -1,
      render: getRenderStats?.() || null,
    }),
    panels,
    // QA knob: force-mark ready even if the boot overlay never calls markBooted.
    forceReady: markBooted,
    getState: () => ({
      selectedId: ctx.state.selectedId,
      viewMode: ctx.state.viewMode,
      cameraMode: ctx.state.cameraMode,
      mapTool: ctx.state.mapTool,
      clean: ctx.state.clean,
      logFilter: ctx.state.logFilter,
      booted: ctx.state.booted,
    }),
  };
  ctx.gcs = gcs;
  window.__gcs = gcs;

  // If the overlays panel mounted and already finished its intro, make sure the
  // ready gate opens even without a bus signal.
  if (skipIntro) setTimeout(markBooted, 260);

  installKeyboard(ctx, gcs);

  return {
    frame,
    shell,
    ctx,
    sim,
    panels,
    gcs,
    markBooted,
    markReady,
    isReady: () => ready,
  };
}
