// =============================================================================
// GCS UI context — the single object every panel receives.
// Holds: UI state, user actions (-> sim command bus / scene), cross-module bus,
// dialog services (registered by the overlays panel), formatters and domain meta.
// =============================================================================
import { META } from '../gcs/meta.js';
import * as format from './format.js';
import * as icons from './icons.js';

const VERSION = META.APP.version;

function createBus() {
  const listeners = new Map();
  return {
    on(evt, fn) {
      if (!listeners.has(evt)) listeners.set(evt, new Set());
      listeners.get(evt).add(fn);
      return () => listeners.get(evt)?.delete(fn);
    },
    off(evt, fn) {
      listeners.get(evt)?.delete(fn);
    },
    emit(evt, data) {
      const set = listeners.get(evt);
      if (!set) return;
      for (const fn of [...set]) {
        try {
          fn(data);
        } catch (err) {
          console.error(`[gcs:bus] ${evt}`, err);
        }
      }
    },
  };
}

function createDialog() {
  const warn = (name) => console.warn(`[gcs:dialog] overlays panel not mounted yet (${name})`);
  return {
    confirm: async () => {
      warn('confirm');
      return false;
    },
    toast: (entry) => {
      // Minimal fallback: never let a toast break a command. Overlays replaces this.
      console.log('[gcs:toast]', entry && (entry.title || entry.message || entry));
    },
    help: () => warn('help'),
    skipBoot: () => warn('skipBoot'),
    alert: (opts) => {
      warn('alert');
      console.warn('[gcs:alert]', opts);
    },
  };
}

export function createContext(services) {
  const {
    scene3d,
    dispatch: rawDispatch,
    getSnapshot,
    getLiveVessels,
    getSceneState,
    getRenderStats,
  } = services;

  const bus = createBus();
  const dialog = createDialog();

  const state = {
    selectedId: 'flagship',
    viewMode: '3d', // '3d' | 'map'
    cameraMode: 'fleet', // 'fleet' | 'lock' | 'free'
    mapTool: 'select', // 'select' | 'goto' | 'measure'
    mapFollow: true,
    mapLayers: {
      tracks: true,
      labels: true,
      route: true,
      grid: true,
      geofence: true,
      landmarks: true,
      sonar: false,
    },
    logFilter: 'all',
    clean: false,
    booted: false,
    ackedAlarms: new Set(),
    activeWaypoint: null, // {x,z,label}
    dialogOpen: false,
    lastAck: null,
    pending: new Set(), // command types awaiting ack
  };

  const vesselOf = (id) => META.FLEET_BY_ID.get(id) || null;

  function liveVessel(id) {
    const list = getLiveVessels ? getLiveVessels() : [];
    return list.find((v) => v.id === id) || null;
  }

  function dispatch(cmd, opts) {
    let result;
    try {
      result = rawDispatch(cmd, opts);
    } catch (err) {
      console.error('[gcs:dispatch]', err);
      result = { accepted: false, error: '指令总线异常' };
    }
    if (result && result.accepted === false) {
      dialog.toast({ severity: 'warning', title: '指令被拒绝', message: result.error || '未知原因' });
    }
    return result;
  }

  function setCameraMode(mode) {
    state.cameraMode = mode;
    scene3d?.setCameraMode?.(mode);
    bus.emit('camera', mode);
  }

  function selectVessel(id) {
    if (id != null && !vesselOf(id)) return false;
    state.selectedId = id;
    scene3d?.setSelection?.(id);
    bus.emit('select', id);
    return true;
  }

  const actions = {
    selectVessel,

    focusSelected() {
      const id = state.selectedId;
      if (!id) return;
      scene3d?.focusVessel?.(id);
      setCameraMode('lock');
    },

    focusVessel(id) {
      if (!vesselOf(id)) return;
      selectVessel(id);
      scene3d?.focusVessel?.(id);
      setCameraMode('lock');
    },

    focusFleet() {
      scene3d?.focusFleet?.();
      setCameraMode('fleet');
    },

    setCameraMode,

    applyCameraPreset(key) {
      const preset = META.CAMERA_PRESETS.find((p) => p.key === key);
      if (!preset) return;
      const follow = ['default', 'fleet', 'top', 'low', 'bow', 'side'].includes(key);
      if (follow) {
        setCameraMode('fleet');
        scene3d?.focusFleet?.();
      } else {
        setCameraMode('free');
      }
      scene3d?.applyPreset?.(key);
      bus.emit('camera', state.cameraMode);
    },

    setViewMode(mode) {
      const next = mode === 'map' ? 'map' : '3d';
      if (state.viewMode === next) return;
      state.viewMode = next;
      if (typeof document !== 'undefined') document.body.dataset.gcsView = next;
      bus.emit('view', next);
    },

    toggleViewMode() {
      actions.setViewMode(state.viewMode === 'map' ? '3d' : 'map');
    },

    toggleClean(force) {
      state.clean = typeof force === 'boolean' ? force : !state.clean;
      if (typeof document !== 'undefined') {
        document.body.classList.toggle('gcs-clean', state.clean);
        document.body.dataset.gcsClean = state.clean ? '1' : '0';
      }
      bus.emit('clean', state.clean);
    },

    // --- fleet commands ------------------------------------------------------
    setFormation(key) {
      if (!key) return;
      return dispatch({ type: 'formation.set', formation: key });
    },
    rally() {
      return dispatch({ type: 'formation.scale', scale: 0.5 });
    },
    disperse() {
      return dispatch({ type: 'formation.scale', scale: 1.8 });
    },
    setSpeedScale(scale) {
      return dispatch({ type: 'fleet.speed', scale });
    },
    holdFleet() {
      return dispatch({ type: 'fleet.hold' });
    },
    resumeFleet() {
      return dispatch({ type: 'fleet.resume' });
    },
    uturn() {
      return dispatch({ type: 'fleet.uturn' });
    },
    rtlFleet() {
      return dispatch({ type: 'fleet.rtl' });
    },
    cancelRtl() {
      return dispatch({ type: 'fleet.cancelRtl' });
    },
    async estop() {
      const snap = getSnapshot?.();
      const total = snap?.fleet?.total || META.FLEET.length;
      const ok = await dialog.confirm({
        title: '确认紧急停止',
        danger: true,
        message: `将对全部 ${total} 艘无人艇执行紧急停止。`,
        detail: [
          '集群航迹推进立即冻结，各艇原地保持并随浪姿态。',
          '急停状态下除“解除急停”外的所有指令都将被拒绝。',
          '请确认海况与周边通航环境安全后执行。',
        ],
        confirmText: '长按确认急停',
        holdMs: 1200,
      });
      if (!ok) return false;
      return dispatch({ type: 'fleet.estop' });
    },
    recover() {
      return dispatch({ type: 'fleet.recover' });
    },

    // --- vessel commands -----------------------------------------------------
    vesselGotoSelected() {
      if (!state.selectedId) {
        dialog.toast({ severity: 'warning', title: '未选择无人艇', message: '请先在名册或战术图上选择一艘无人艇。' });
        return;
      }
      state.mapTool = 'goto';
      actions.setViewMode('map');
      bus.emit('tool', state.mapTool);
      dialog.toast({
        severity: 'info',
        title: '定点导航',
        message: `在战术图上点击目标点，派遣 ${vesselOf(state.selectedId)?.callSign} ${vesselOf(state.selectedId)?.name}。`,
        ttl: 2600,
      });
    },

    gotoVesselAt(id, x, z) {
      if (!vesselOf(id)) return null;
      state.activeWaypoint = { x, z, label: vesselOf(id).callSign };
      scene3d?.setWaypoint?.(x, z, vesselOf(id).callSign);
      return dispatch({ type: 'vessel.goto', id, x, z });
    },

    vesselRtl(id) {
      return dispatch({ type: 'vessel.rtl', id });
    },
    vesselHold(id) {
      return dispatch({ type: 'vessel.hold', id });
    },
    vesselResume(id) {
      return dispatch({ type: 'vessel.resume', id });
    },

    toggleSensor(id, sensorId) {
      const snap = getSnapshot?.();
      const vessel = snap?.vessels?.find((v) => v.id === id);
      const current = vessel?.sensors?.find((s) => s.id === sensorId);
      const on = !(current ? current.on : true);
      return dispatch({ type: 'vessel.payload', id, sensor: sensorId, on });
    },

    markSelected() {
      const id = state.selectedId;
      const v = id ? liveVessel(id) : null;
      if (!v) return;
      state.activeWaypoint = { x: v.x, z: v.z, label: `${vesselOf(id)?.callSign} 标记` };
      scene3d?.setWaypoint?.(v.x, v.z, 'MARK');
      dialog.toast({ severity: 'info', title: '目标已标记', message: `${vesselOf(id)?.callSign} 当前位置已标记在海图。`, ttl: 2200 });
    },

    clearWaypoint() {
      state.activeWaypoint = null;
      scene3d?.setWaypoint?.(null);
    },

    // --- map / filters -------------------------------------------------------
    setMapTool(tool) {
      state.mapTool = tool;
      if (tool === 'goto' && !state.selectedId) {
        dialog.toast({ severity: 'warning', title: '未选择无人艇', message: '定点导航需要先选择一艘无人艇。' });
        state.mapTool = 'select';
      }
      bus.emit('tool', state.mapTool);
    },

    placeWaypoint(x, z) {
      if (state.mapTool === 'goto' && state.selectedId) {
        const res = actions.gotoVesselAt(state.selectedId, x, z);
        state.mapTool = 'select';
        bus.emit('tool', 'select');
        return res;
      }
      state.activeWaypoint = { x, z, label: 'TGT' };
      scene3d?.setWaypoint?.(x, z, 'TGT');
      return null;
    },

    toggleMapLayer(layer) {
      if (!(layer in state.mapLayers)) return;
      state.mapLayers[layer] = !state.mapLayers[layer];
      bus.emit('layers', state.mapLayers);
    },

    setMapFollow(follow) {
      state.mapFollow = typeof follow === 'boolean' ? follow : !state.mapFollow;
      bus.emit('mapfollow', state.mapFollow);
    },

    setLogFilter(kind) {
      state.logFilter = kind;
      bus.emit('filter', kind);
    },

    ackAlarm(id) {
      if (id) state.ackedAlarms.add(id);
      bus.emit('alarm-ack', id);
    },

    ackAllAlarms() {
      const snap = getSnapshot?.();
      for (const alarm of snap?.alarms || []) state.ackedAlarms.add(alarm.id);
      bus.emit('alarm-ack', null);
    },

    requestHelp() {
      dialog.help(true);
    },

    closeOverlays() {
      if (dialog.closeAll) dialog.closeAll();
    },

    async runConsole(text) {
      if (typeof services.runConsole === 'function') {
        return services.runConsole(text);
      }
      return { ok: false, text: '指令台尚未就绪' };
    },
  };

  const ctx = {
    version: VERSION,
    meta: META,
    state,
    actions,
    bus,
    dialog,
    format,
    icons,
    scene3d,
    dispatch,
    getSnapshot: () => (getSnapshot ? getSnapshot() : null),
    getLiveVessels: () => (getLiveVessels ? getLiveVessels() : []),
    getSceneState: () => (getSceneState ? getSceneState() : null),
    getRenderStats: () => {
      try {
        return getRenderStats ? getRenderStats() : null;
      } catch {
        return null;
      }
    },
    vesselOf,
    isAlarmAcked: (id) => state.ackedAlarms.has(id),
    unackedAlarms: (snap) => (snap?.alarms || []).filter((a) => !state.ackedAlarms.has(a.id)),
  };

  // If the scene bridge is not ready yet, keep the surface stable.
  return ctx;
}
