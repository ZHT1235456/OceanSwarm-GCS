// =============================================================================
// GCS right rail — VESSEL DETAIL (§7.5). Owner: ui-detail.
//
// One selected vessel (ctx.state.selectedId) rendered as a dense, instrument-
// like column: identity, hero readouts, attitude horizon, data link, energy
// history, payload switches, per-vessel commands and a collapsed raw-parameter
// table. Every number comes from the last Sim snapshot / ctx meta — the panel
// never invents scene state. Canvas instruments live in src/ui/charts.js.
// =============================================================================
import './../styles/detail.css';
import { h, setText, setClass, setAttr, on, clear } from '../dom.js';
import { drawHorizon, drawRingGauge, drawSignalBars, drawAreaLine } from '../charts.js';

const HISTORY_WINDOW_SEC = 480; // 8 minutes of battery history per vessel
const SAMPLE_SEC = 2; // module-local sampling cadence
const MAX_POINTS = Math.ceil(HISTORY_WINDOW_SEC / SAMPLE_SEC) + 2;

const STATUS = {
  normal: { text: '在线', en: 'ONLINE', tone: 'ok' },
  warning: { text: '告警', en: 'WARN', tone: 'warn' },
  critical: { text: '严重', en: 'CRITICAL', tone: 'danger' },
  offline: { text: '离线', en: 'OFFLINE', tone: 'offline' },
};

// §7.5 item 7 — six per-vessel commands, plus the takeover release (danger).
const ACTIONS = [
  { key: 'focus', cn: '锁定跟随', en: 'LOCK', icon: 'lock', cmd: false, title: '锁定跟随该艇 / LOCK CAMERA (F)' },
  { key: 'goto', cn: '定点导航', en: 'GOTO', icon: 'crosshair', cmd: false, title: '为该艇指定航点 / SET WAYPOINT' },
  { key: 'hold', cn: '保持待机', en: 'HOLD', icon: 'anchor', cmd: true, title: '单艇保持待机 / VESSEL HOLD' },
  { key: 'rtl', cn: '单艇返航', en: 'RTL', icon: 'route', cmd: true, title: '单艇返航基地 / VESSEL RTL' },
  { key: 'resume', cn: '归队恢复', en: 'RESUME', icon: 'refresh', cmd: true, title: '归队恢复编队 / RESUME FORMATION' },
  { key: 'mark', cn: '标记目标', en: 'MARK', icon: 'map-pin', cmd: false, title: '标记该艇当前位置 / MARK CONTACT' },
];

const RAW_FIELDS = [
  ['id', 'id'],
  ['type', 'type'],
  ['group', 'group'],
  ['mode', 'mode'],
  ['uptime', 'uptime'],
  ['cpu', 'cpu'],
  ['alarm', 'alarm'],
];

const mmss = (sec) => {
  if (!Number.isFinite(sec)) return '—';
  const s = Math.max(0, Math.round(sec));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

export function createDetailPanel(ctx) {
  const meta = ctx.meta;
  const fmt = ctx.format;
  const icons = ctx.icons;

  // --- local state ----------------------------------------------------------
  let root = null;
  let refs = {};
  const actionRefs = new Map();
  const rawRefs = new Map();
  const sensorRefs = new Map();
  let sensorSignature = '';
  const history = new Map(); // vesselId -> { t:number[], v:number[] }
  let lastSnap = null;
  let lastVessel = null;
  let lastRenderedId = null;
  let pendingSensor = null; // { vesselId, sensorId, expectedOn, deadline }
  let pendingCmd = null; // { btn, baselineAckId, timer }
  let resizeObserver = null;
  let rafHandle = 0;
  const disposers = [];

  // --- small helpers --------------------------------------------------------
  const clockSec = () => performance.now() / 1000;

  const vesselOf = (snap, id) => {
    if (!snap || !Array.isArray(snap.vessels) || id == null) return null;
    return snap.vessels.find((v) => v && v.id === id) || null;
  };

  const metaOf = (id) => (id != null ? meta.FLEET_BY_ID.get(id) || null : null);

  function relayLabel(snap) {
    const raw = snap?.fleet?.link?.relayId;
    if (raw == null || raw === '') return '—';
    const mi = meta.FLEET_BY_ID.get(String(raw));
    return mi ? mi.callSign : String(raw);
  }

  function distanceToFlag(vessel, snap) {
    const flag = vesselOf(snap, 'flagship');
    const tx = flag ? flag.x : snap?.fleet?.center?.x;
    const tz = flag ? flag.z : snap?.fleet?.center?.z;
    if (!Number.isFinite(vessel.x) || !Number.isFinite(vessel.z) || !Number.isFinite(tx) || !Number.isFinite(tz)) {
      return null;
    }
    return Math.hypot(vessel.x - tx, vessel.z - tz);
  }

  function distanceToBase(vessel) {
    const base = meta.HOME_BASE;
    if (!base || !Number.isFinite(vessel.x) || !Number.isFinite(vessel.z)) return null;
    return Math.hypot(vessel.x - base.x, vessel.z - base.z);
  }

  /** Signed longitudinal offset from the fleet centre along the fleet heading. */
  function alongOffset(vessel, snap) {
    const center = snap?.fleet?.center;
    const hdg = Number.isFinite(snap?.fleet?.headingDeg) ? snap.fleet.headingDeg : vessel.headingDeg;
    if (!center || !Number.isFinite(center.x) || !Number.isFinite(center.z) || !Number.isFinite(hdg)) return null;
    if (!Number.isFinite(vessel.x) || !Number.isFinite(vessel.z)) return null;
    const rad = (hdg * Math.PI) / 180;
    const fx = Math.sin(rad); // heading 0 = north = −Z
    const fz = -Math.cos(rad);
    return (vessel.x - center.x) * fx + (vessel.z - center.z) * fz;
  }

  const fmtSignedMeters = (value) => {
    if (!Number.isFinite(value)) return '—';
    const sign = value >= 0 ? '+' : '−';
    return `${sign}${fmt.num(Math.abs(value), 1)} m`;
  };

  // --- battery history cache (per vessel, 8 min @ 2 s, module-local) --------
  function sampleHistory(snap) {
    if (!snap || !Array.isArray(snap.vessels)) return;
    const now = clockSec();
    for (const v of snap.vessels) {
      if (!v || !Number.isFinite(v.batteryPct)) continue;
      let entry = history.get(v.id);
      if (!entry) {
        entry = { t: [], v: [] };
        history.set(v.id, entry);
      }
      const n = entry.t.length;
      const lastT = n ? entry.t[n - 1] : -Infinity;
      if (now < lastT - 1) {
        // page was resumed / clock jumped back — restart the cache for this boat
        entry.t.length = 0;
        entry.v.length = 0;
      }
      const prev = entry.t.length ? entry.t[entry.t.length - 1] : -Infinity;
      if (now - prev >= SAMPLE_SEC - 1e-6) {
        entry.t.push(now);
        entry.v.push(v.batteryPct);
        while (entry.t.length > MAX_POINTS) {
          entry.t.shift();
          entry.v.shift();
        }
        const cutoff = now - HISTORY_WINDOW_SEC;
        while (entry.t.length && entry.t[0] < cutoff) {
          entry.t.shift();
          entry.v.shift();
        }
      }
    }
  }

  function historySamples(id) {
    const entry = history.get(id);
    if (!entry || !entry.t.length) return [];
    const out = new Array(entry.t.length);
    for (let i = 0; i < entry.t.length; i++) out[i] = { t: entry.t[i], v: entry.v[i] };
    return out;
  }

  // --- pending states (never optimistic: wait for the next snapshot / ack) --
  function clearPendingSensor() {
    if (!pendingSensor) return;
    const r = sensorRefs.get(pendingSensor.sensorId);
    if (r) {
      setClass(r.switchEl, 'is-pending', false);
      setClass(r.row, 'is-pending', false);
      r.switchEl.removeAttribute('aria-busy');
    }
    pendingSensor = null;
  }

  function resolvePendingSensor(snap) {
    if (!pendingSensor) return;
    const vessel = vesselOf(snap, pendingSensor.vesselId);
    const sensor = vessel && Array.isArray(vessel.sensors) ? vessel.sensors.find((s) => s.id === pendingSensor.sensorId) : null;
    if (sensor && !!sensor.on === pendingSensor.expectedOn) {
      clearPendingSensor();
      return;
    }
    if (Date.now() > pendingSensor.deadline) clearPendingSensor();
  }

  function clearPendingCommand(acked) {
    if (!pendingCmd) return;
    const { btn, timer } = pendingCmd;
    if (timer) clearTimeout(timer);
    pendingCmd = null;
    if (!btn) return;
    setClass(btn, 'is-pending', false);
    if (acked) {
      setClass(btn, 'is-acked', true);
      setTimeout(() => setClass(btn, 'is-acked', false), 420);
    }
  }

  function resolvePendingCommand(snap) {
    if (!pendingCmd) return;
    const ackId = snap?.acks?.[0]?.id ?? null;
    if (ackId != null && ackId !== pendingCmd.baselineAckId) {
      clearPendingCommand(true);
      return;
    }
    if (Date.now() > pendingCmd.deadline) clearPendingCommand(false);
  }

  function startPendingCommand(btn) {
    if (!btn) return;
    clearPendingCommand(false);
    pendingCmd = {
      btn,
      baselineAckId: lastSnap?.acks?.[0]?.id ?? null,
      deadline: Date.now() + 2800,
      timer: setTimeout(() => clearPendingCommand(false), 2800),
    };
    setClass(btn, 'is-pending', true);
  }

  // --- DOM ------------------------------------------------------------------
  function skeleton() {
    return `
      <header class="gcs-panel-head">
        <span class="gcs-panel-index">04</span>
        <h2 class="gcs-panel-title">单艇详情 <em>VESSEL DETAIL</em></h2>
        <span class="gcs-panel-meta" data-ref="headMeta">—</span>
      </header>
      <div class="gcs-panel-body detail-body">
        <div class="detail-empty" data-ref="empty">
          <div class="detail-empty-frame">
            <span class="detail-empty-icon">${icons.icon('crosshair', 28)}</span>
            <span class="detail-empty-title" data-ref="emptyTitle">未选择无人艇</span>
            <span class="detail-empty-hint" data-ref="emptyHint">在左侧名册、二维战术图或三维视图中选择一艘无人艇，查看实时遥测与载荷控制。</span>
            <span class="detail-empty-en" data-ref="emptyEn">NO VESSEL SELECTED · AWAITING TELEMETRY</span>
          </div>
        </div>

        <div class="detail-content" data-ref="content" hidden>
          <div class="detail-identity">
            <span class="detail-typebar" data-ref="typebar" aria-hidden="true"></span>
            <div class="detail-id-main">
              <div class="detail-id-row">
                <span class="detail-callsign" data-ref="callsign">—</span>
                <span class="gcs-chip detail-type-chip" data-ref="typeChip">—</span>
              </div>
              <div class="detail-id-row detail-id-row--sub">
                <span class="detail-name" data-ref="name">—</span>
                <span class="detail-status"><span class="gcs-dot" data-ref="statusDot"></span><span class="detail-status-text" data-ref="statusText">—</span></span>
              </div>
            </div>
            <button type="button" class="gcs-btn gcs-btn--icon detail-lock" data-ref="lockBtn" title="锁定跟随 / LOCK CAMERA (F)" aria-label="锁定跟随">${icons.icon('lock', 14)}</button>
          </div>

          <div class="detail-hero">
            <div class="detail-hero-cell">
              <span class="detail-hero-label">航速 <em>SPEED</em></span>
              <span class="detail-hero-figure detail-hero-figure--hero"><b data-ref="sog">—</b><i class="gcs-unit">kn</i></span>
            </div>
            <div class="detail-hero-cell detail-hero-cell--rule">
              <span class="detail-hero-label">艏向 <em>HEADING</em></span>
              <span class="detail-hero-figure"><b data-ref="hdg">—</b></span>
            </div>
            <div class="detail-hero-cell detail-hero-cell--ring">
              <span class="detail-hero-label">电量 <em>BATTERY</em></span>
              <canvas class="detail-ring" data-ref="ring" width="52" height="52" aria-label="电量环形仪表"></canvas>
            </div>
          </div>

          <div class="detail-substats">
            <div class="detail-substat">
              <span class="detail-substat-k"><span data-ref="distKeyCn">距旗舰</span> <em data-ref="distKeyEn">TO FLAG</em></span>
              <span class="detail-substat-v" data-ref="dist">—</span>
            </div>
            <div class="detail-substat">
              <span class="detail-substat-k">纵向偏差 <em>ALONG</em></span>
              <span class="detail-substat-v" data-ref="along">—</span>
            </div>
            <div class="detail-substat">
              <span class="detail-substat-k">载荷在线 <em>PAYLOAD</em></span>
              <span class="detail-substat-v" data-ref="payloadCount">—</span>
            </div>
          </div>

          <section class="detail-sec">
            <header class="detail-sec-head">
              <span class="detail-sec-icon">${icons.icon('compass', 11)}</span>
              <h3 class="detail-sec-title">姿态 <em>ATTITUDE</em></h3>
              <span class="detail-sec-meta" data-ref="attMeta">—</span>
            </header>
            <div class="detail-attitude">
              <canvas class="detail-horizon" data-ref="horizon" width="132" height="66" aria-label="人工地平线"></canvas>
              <div class="detail-attitude-kv">
                <div class="gcs-kv"><span class="gcs-kv-k">纵摇 PITCH</span><span class="gcs-kv-v" data-ref="pitch">—</span></div>
                <div class="gcs-kv"><span class="gcs-kv-k">横摇 ROLL</span><span class="gcs-kv-v" data-ref="roll">—</span></div>
                <div class="gcs-kv"><span class="gcs-kv-k">升沉 HEAVE</span><span class="gcs-kv-v" data-ref="heave">—</span></div>
              </div>
            </div>
          </section>

          <section class="detail-sec">
            <header class="detail-sec-head">
              <span class="detail-sec-icon">${icons.icon('link', 11)}</span>
              <h3 class="detail-sec-title">数据链 <em>DATA LINK</em></h3>
              <span class="detail-sec-meta" data-ref="linkMeta">—</span>
            </header>
            <div class="detail-link">
              <div class="detail-link-main">
                <canvas class="detail-signal" data-ref="signal" width="44" height="18" aria-label="链路信号强度"></canvas>
                <span class="detail-link-rssi" data-ref="rssi">—</span>
                <span class="gcs-chip detail-link-chip" data-ref="linkChip">—</span>
              </div>
              <div class="detail-kv-grid detail-kv-grid--3">
                <div class="gcs-kv"><span class="gcs-kv-k">延时 LATENCY</span><span class="gcs-kv-v" data-ref="latency">—</span></div>
                <div class="gcs-kv"><span class="gcs-kv-k">丢包 LOSS</span><span class="gcs-kv-v" data-ref="loss">—</span></div>
                <div class="gcs-kv"><span class="gcs-kv-k">中继 RELAY</span><span class="gcs-kv-v" data-ref="relay">—</span></div>
              </div>
            </div>
          </section>

          <section class="detail-sec">
            <header class="detail-sec-head">
              <span class="detail-sec-icon">${icons.icon('battery', 11)}</span>
              <h3 class="detail-sec-title">能源 <em>ENERGY</em></h3>
              <span class="detail-sec-meta" data-ref="energyMeta">—</span>
            </header>
            <canvas class="detail-energy" data-ref="energy" width="280" height="46" aria-label="最近电量历史曲线"></canvas>
            <div class="detail-kv-grid detail-kv-grid--2">
              <div class="gcs-kv"><span class="gcs-kv-k">电压 VOLTAGE</span><span class="gcs-kv-v" data-ref="voltage">—</span></div>
              <div class="gcs-kv"><span class="gcs-kv-k">电流 CURRENT</span><span class="gcs-kv-v" data-ref="current">—</span></div>
              <div class="gcs-kv"><span class="gcs-kv-k">功率 POWER</span><span class="gcs-kv-v" data-ref="power">—</span></div>
              <div class="gcs-kv"><span class="gcs-kv-k">温度 TEMP</span><span class="gcs-kv-v" data-ref="temp">—</span></div>
            </div>
          </section>

          <section class="detail-sec">
            <header class="detail-sec-head">
              <span class="detail-sec-icon">${icons.icon('radar', 11)}</span>
              <h3 class="detail-sec-title">载荷 <em>PAYLOAD</em></h3>
              <span class="detail-sec-meta" data-ref="payloadMeta">—</span>
            </header>
            <div class="detail-sensors" data-ref="sensors"></div>
          </section>

          <section class="detail-sec">
            <header class="detail-sec-head">
              <span class="detail-sec-icon">${icons.icon('target', 11)}</span>
              <h3 class="detail-sec-title">操作 <em>COMMANDS</em></h3>
              <span class="detail-sec-meta" data-ref="commandsMeta">—</span>
            </header>
            <div class="detail-actions" data-ref="actions"></div>
            <button type="button" class="gcs-btn gcs-btn--danger detail-recover" data-ref="recover" hidden>
              ${icons.icon('unlock', 13)}<span>解除接管</span><em class="detail-recover-en">RELEASE</em>
            </button>
          </section>

          <details class="detail-raw" data-ref="raw">
            <summary class="detail-raw-sum">
              <span class="detail-raw-title">原始参数 <em>RAW PARAMETERS</em></span>
              <span class="detail-raw-chev">${icons.icon('chevron-down', 12)}</span>
            </summary>
            <div class="detail-raw-grid" data-ref="rawGrid"></div>
          </details>
        </div>
      </div>`;
  }

  function buildActions() {
    clear(refs.actions);
    actionRefs.clear();
    for (const spec of ACTIONS) {
      const btn = h('button', {
        class: 'gcs-btn detail-action-btn',
        attrs: { type: 'button', 'data-action': spec.key },
        title: spec.title,
      });
      btn.innerHTML = `${icons.icon(spec.icon, 13)}<span>${spec.cn}</span>`;
      refs.actions.appendChild(btn);
      actionRefs.set(spec.key, btn);
    }
  }

  function buildRawRows() {
    clear(refs.rawGrid);
    rawRefs.clear();
    for (const [key, label] of RAW_FIELDS) {
      const row = h('div', { class: 'detail-raw-row' });
      row.innerHTML = `<span class="detail-raw-k">${label}</span><span class="detail-raw-v"></span>`;
      refs.rawGrid.appendChild(row);
      rawRefs.set(key, row.querySelector('.detail-raw-v'));
    }
  }

  function build() {
    const el = h('section', { class: 'gcs-panel detail-panel', attrs: { 'aria-label': '单艇详情' } });
    el.innerHTML = skeleton();
    refs = {};
    for (const node of el.querySelectorAll('[data-ref]')) refs[node.dataset.ref] = node;
    buildActions();
    buildRawRows();
    return el;
  }

  // --- sensors --------------------------------------------------------------
  function syncSensorRows(vessel) {
    const list = Array.isArray(vessel.sensors) ? vessel.sensors : [];
    const signature = list.map((s) => `${s.id}:${s.short || ''}:${s.label || ''}`).join('|');
    if (signature === sensorSignature) return;
    sensorSignature = signature;
    sensorRefs.clear();
    clear(refs.sensors);
    for (const sensor of list) {
      const catalog = meta.SENSOR_CATALOG[sensor.id] || {};
      const row = h('div', { class: 'detail-sensor', dataset: { sensor: sensor.id || '' } });
      row.innerHTML =
        `<span class="detail-sensor-icon">${icons.sensorIcon(sensor.id, 14)}</span>` +
        `<span class="detail-sensor-label"><span class="detail-sensor-cn"></span><em class="detail-sensor-short"></em></span>` +
        `<span class="gcs-chip detail-sensor-state">—</span>` +
        `<button type="button" class="detail-switch" role="switch" aria-checked="false" data-switch="${sensor.id}" aria-label="切换载荷">` +
        `<span class="detail-switch-knob"></span></button>`;
      refs.sensors.appendChild(row);
      setText(row.querySelector('.detail-sensor-cn'), sensor.label || catalog.label || sensor.id || '—');
      setText(row.querySelector('.detail-sensor-short'), sensor.short || catalog.short || '');
      sensorRefs.set(sensor.id, {
        row,
        stateEl: row.querySelector('.detail-sensor-state'),
        switchEl: row.querySelector('[data-switch]'),
      });
    }
  }

  function renderSensors(vessel) {
    syncSensorRows(vessel);
    const list = Array.isArray(vessel.sensors) ? vessel.sensors : [];
    let online = 0;
    for (const sensor of list) {
      const r = sensorRefs.get(sensor.id);
      if (!r) continue;
      const isOn = !!sensor.on;
      if (isOn) online += 1;
      setText(r.stateEl, sensor.stateText || (isOn ? '开启' : '关闭'));
      r.stateEl.className = isOn ? 'gcs-chip gcs-chip--ok detail-sensor-state' : 'gcs-chip detail-sensor-state';
      setAttr(r.switchEl, 'aria-checked', isOn ? 'true' : 'false');
      setClass(r.switchEl, 'is-on', isOn);
      const label = sensor.label || meta.SENSOR_CATALOG[sensor.id]?.label || sensor.id;
      r.switchEl.setAttribute('aria-label', `${isOn ? '关闭' : '开启'} ${label}`);
      r.switchEl.title = `${isOn ? '关闭' : '开启'} ${label} / TOGGLE PAYLOAD`;
      const isPending = !!(pendingSensor && pendingSensor.sensorId === sensor.id && pendingSensor.vesselId === vessel.id);
      setClass(r.switchEl, 'is-pending', isPending);
      setClass(r.row, 'is-pending', isPending);
    }
    setText(refs.payloadCount, `${fmt.int(online)}/${fmt.int(list.length)}`);
    setText(refs.payloadMeta, `${fmt.int(online)}/${fmt.int(list.length)} 在线`);
  }

  function onSensorToggle(sensorId) {
    if (pendingSensor) return; // one payload command at a time
    const id = ctx.state.selectedId;
    if (!id || !sensorId) return;
    const snap = ctx.getSnapshot() || lastSnap;
    const vessel = vesselOf(snap, id);
    const sensor = vessel && Array.isArray(vessel.sensors) ? vessel.sensors.find((s) => s.id === sensorId) : null;
    if (!sensor) return;
    pendingSensor = { vesselId: id, sensorId, expectedOn: !sensor.on, deadline: Date.now() + 3400 };
    const r = sensorRefs.get(sensorId);
    if (r) {
      setClass(r.switchEl, 'is-pending', true);
      setClass(r.row, 'is-pending', true);
      setAttr(r.switchEl, 'aria-busy', 'true');
    }
    let result = null;
    try {
      result = ctx.actions.toggleSensor(id, sensorId);
    } catch (err) {
      console.error('[gcs:detail] toggleSensor', err);
      clearPendingSensor();
      return;
    }
    if (result && result.accepted === false) clearPendingSensor();
  }

  // --- per-vessel commands --------------------------------------------------
  function onAction(key) {
    const id = ctx.state.selectedId;
    if (!id || !key) return;
    if (key === 'focus') {
      ctx.actions.focusSelected();
      return;
    }
    if (key === 'goto') {
      ctx.actions.vesselGotoSelected();
      return;
    }
    if (key === 'mark') {
      ctx.actions.markSelected();
      return;
    }
    const handlers = {
      hold: () => ctx.actions.vesselHold(id),
      rtl: () => ctx.actions.vesselRtl(id),
      resume: () => ctx.actions.vesselResume(id),
      recover: () => ctx.actions.vesselResume(id),
    };
    const run = handlers[key];
    if (!run) return;
    let result = null;
    try {
      result = run();
    } catch (err) {
      console.error('[gcs:detail] action', key, err);
      return;
    }
    if (result && result.accepted === false) return;
    startPendingCommand(key === 'recover' ? refs.recover : actionRefs.get(key));
  }

  // --- instrument drawing ---------------------------------------------------
  function drawInstruments(vessel) {
    drawHorizon(refs.horizon, {
      rollDeg: vessel.rollDeg,
      pitchDeg: vessel.pitchDeg,
      headingDeg: vessel.headingDeg,
    });
    drawRingGauge(refs.ring, { pct: vessel.batteryPct, digits: 0, dangerBelow: 15, warnBelow: 30 });
    const link = vessel.link || {};
    drawSignalBars(refs.signal, { quality: link.quality });

    const samples = historySamples(vessel.id);
    const info = drawAreaLine(refs.energy, {
      samples,
      nowT: clockSec(),
      windowSec: HISTORY_WINDOW_SEC,
      threshold: 25,
      minV: 0,
      maxV: 100,
    });
    let spanText;
    if (samples.length < 2) spanText = '缓存建立中';
    else if (info.spanSec >= HISTORY_WINDOW_SEC - 2) spanText = '最近 08:00 · 2 s';
    else spanText = `缓存 ${mmss(info.spanSec)} / 08:00`;
    setText(refs.energyMeta, `${fmt.pct(vessel.batteryPct, 1)} · ${spanText}`);
  }

  function renderVessel(vessel, snap) {
    const id = vessel.id;
    const mi = metaOf(id);
    const type = vessel.type || mi?.type || 'scout';
    const tm = meta.TYPE_META[type] || {};
    const typeColor = tm.hex || '#5ff3e4';
    const switched = id !== lastRenderedId;
    lastRenderedId = id;
    lastVessel = vessel;

    if (root) root.style.setProperty('--detail-type', typeColor);
    if (switched) {
      clearPendingSensor();
      clearPendingCommand(false);
      sensorSignature = '';
      if (refs.content) {
        refs.content.classList.remove('is-entering');
        void refs.content.offsetWidth; // restart the 180 ms fade
        refs.content.classList.add('is-entering');
      }
    }
    refs.empty.hidden = true;
    refs.content.hidden = false;

    // --- 1. identity ---------------------------------------------------------
    const statusKey = STATUS[vessel.status] ? vessel.status : 'offline';
    const status = STATUS[statusKey];
    const modeText = vessel.modeText || meta.VESSEL_MODES?.[vessel.mode]?.text || '—';
    const callSign = vessel.callSign || mi?.callSign || '—';
    setText(refs.callsign, callSign);
    setText(refs.name, vessel.name || mi?.name || '—');
    setText(refs.typeChip, `${vessel.typeName || tm.typeName || '—'} ${vessel.roleEn || tm.roleEn || ''}`.trim());
    refs.statusDot.className =
      `gcs-dot gcs-dot--${status.tone}` +
      (statusKey === 'normal' ? ' is-live' : statusKey === 'warning' ? ' is-pulse' : '');
    // Status line: status + mode, without repeating the same word for an
    // offline boat (statusText and modeText are both 离线 there).
    const statusLine = modeText && modeText !== status.text ? `${status.text} · ${modeText}` : status.text;
    setText(refs.statusText, statusLine);
    setText(refs.headMeta, `${callSign} · ${status.text}`);
    setClass(refs.lockBtn, 'is-active', ctx.state.cameraMode === 'lock');

    // alarm stripe on the panel (§6.9)
    if (root) {
      setClass(root, 'gcs-panel--warn', statusKey === 'warning');
      setClass(root, 'gcs-panel--danger', statusKey === 'critical');
      setClass(root, 'is-critical', statusKey === 'critical');
    }

    // --- 2. hero readouts ----------------------------------------------------
    setText(refs.sog, fmt.num(vessel.sogKn, 1));
    setText(refs.hdg, fmt.hdg(vessel.headingDeg));
    if (id === 'flagship') {
      setText(refs.distKeyCn, '距基地');
      setText(refs.distKeyEn, 'TO BASE');
      setText(refs.dist, fmt.dist(distanceToBase(vessel)));
    } else {
      setText(refs.distKeyCn, '距旗舰');
      setText(refs.distKeyEn, 'TO FLAG');
      setText(refs.dist, fmt.dist(distanceToFlag(vessel, snap)));
    }
    setText(refs.along, fmtSignedMeters(alongOffset(vessel, snap)));

    // --- 3. attitude ---------------------------------------------------------
    setText(refs.pitch, `${fmt.signed(vessel.pitchDeg, 1)}`);
    setText(refs.roll, `${fmt.signed(vessel.rollDeg, 1)}`);
    setText(refs.heave, fmt.mtr(vessel.heaveM));
    setText(refs.attMeta, `航向 ${fmt.hdg(vessel.headingDeg)}`);

    // --- 4. data link --------------------------------------------------------
    const link = vessel.link || {};
    const quality = Number.isFinite(link.quality) ? Math.max(0, Math.min(1, link.quality)) : null;
    setText(refs.rssi, fmt.dbm(link.rssiDbm));
    setText(refs.latency, fmt.ms(link.latencyMs));
    setText(refs.loss, fmt.pct(link.lossPct, 2));
    setText(refs.relay, relayLabel(snap));
    setText(refs.linkChip, link.type ? String(link.type).toUpperCase() : '—');
    const linkTone = quality == null ? '' : quality < 0.2 ? ' gcs-chip--danger' : quality < 0.34 ? ' gcs-chip--warn' : quality >= 0.6 ? ' gcs-chip--ok' : '';
    refs.linkChip.className = `gcs-chip detail-link-chip${linkTone}`;
    setText(refs.linkMeta, quality == null ? '—' : `信号 ${Math.round(quality * 100)}%`);

    // --- 5. energy -----------------------------------------------------------
    setText(refs.voltage, fmt.volt(vessel.voltageV));
    setText(refs.current, fmt.amp(vessel.currentA));
    setText(refs.power, fmt.kw(vessel.powerKw));
    setText(refs.temp, fmt.temp(vessel.tempC));

    // --- 6. payload ----------------------------------------------------------
    renderSensors(vessel);

    // --- 7. commands ---------------------------------------------------------
    setText(refs.commandsMeta, modeText);
    // §7.5: the danger “解除接管” release is shown whenever the boat is under a
    // per-vessel command (single-vessel takeover) instead of formation control.
    const takenOver = ['auto', 'manual', 'hold', 'rtl'].includes(vessel.mode);
    refs.recover.hidden = !takenOver;

    // --- 8. raw parameters ---------------------------------------------------
    setText(rawRefs.get('id'), vessel.id || '—');
    setText(rawRefs.get('type'), `${type}${tm.short ? ` · ${tm.short}` : ''}`);
    setText(rawRefs.get('group'), `${vessel.group || ''}${vessel.groupName ? ` · ${vessel.groupName}` : ''}`.trim() || '—');
    setText(rawRefs.get('mode'), `${vessel.mode || '—'} · ${modeText}`);
    setText(rawRefs.get('uptime'), fmt.hms(vessel.uptimeSec));
    setText(rawRefs.get('cpu'), fmt.pct(vessel.cpuPct, 1));
    setText(rawRefs.get('alarm'), `${fmt.int(vessel.alarmCount)} 条`);

    // --- instruments (after layout: the energy chart stretches to the rail) --
    drawInstruments(vessel);
  }

  function showEmpty(snap) {
    if (!root) return;
    refs.empty.hidden = false;
    refs.content.hidden = true;
    setText(refs.headMeta, '—');
    setClass(refs.lockBtn, 'is-active', false);
    if (root) {
      setClass(root, 'gcs-panel--warn', false);
      setClass(root, 'gcs-panel--danger', false);
      setClass(root, 'is-critical', false);
    }
    const id = ctx.state.selectedId;
    if (!snap) {
      setText(refs.emptyTitle, '正在接入集群数据链');
      setText(refs.emptyHint, '正在等待首帧遥测快照，界面将自动就绪。');
      setText(refs.emptyEn, 'INITIALIZING TELEMETRY LINK');
    } else if (!id) {
      setText(refs.emptyTitle, '未选择无人艇');
      setText(refs.emptyHint, '在左侧名册、二维战术图或三维视图中选择一艘无人艇，查看实时遥测与载荷控制。');
      setText(refs.emptyEn, 'NO VESSEL SELECTED · AWAITING TELEMETRY');
    } else {
      const mi = metaOf(id);
      setText(refs.emptyTitle, '遥测同步中');
      setText(refs.emptyHint, `${mi ? `${mi.callSign} ${mi.name}` : id} 的快照尚未到达，正在重新同步。`);
      setText(refs.emptyEn, 'TELEMETRY SYNC · RETRYING');
    }
    lastVessel = null;
    lastRenderedId = null;
    clearPendingSensor();
    clearPendingCommand(false);
  }

  // --- snapshot / bus intake ------------------------------------------------
  function update(snap) {
    if (!snap) return;
    lastSnap = snap;
    sampleHistory(snap);
    resolvePendingSensor(snap);
    resolvePendingCommand(snap);
    const vessel = vesselOf(snap, ctx.state.selectedId);
    if (!vessel) {
      showEmpty(snap);
      return;
    }
    renderVessel(vessel, snap);
  }

  function refreshFromSnapshot() {
    if (!lastSnap) {
      showEmpty(null);
      return;
    }
    update(lastSnap);
  }

  // --- lifecycle ------------------------------------------------------------
  function mount(host) {
    if (root || !host) return;
    root = build();
    host.appendChild(root);

    disposers.push(
      on(refs.actions, 'click', (ev) => {
        const target = ev.target instanceof Element ? ev.target.closest('[data-action]') : null;
        if (!target || !refs.actions.contains(target)) return;
        onAction(target.dataset.action);
      }),
    );
    disposers.push(
      on(refs.sensors, 'click', (ev) => {
        const target = ev.target instanceof Element ? ev.target.closest('[data-switch]') : null;
        if (!target || !refs.sensors.contains(target)) return;
        onSensorToggle(target.dataset.switch);
      }),
    );
    disposers.push(on(refs.lockBtn, 'click', () => ctx.actions.focusSelected()));
    disposers.push(on(refs.recover, 'click', () => onAction('recover')));

    if (ctx.bus && typeof ctx.bus.on === 'function') {
      const offSelect = ctx.bus.on('select', refreshFromSnapshot);
      const offCamera = ctx.bus.on('camera', (mode) => setClass(refs.lockBtn, 'is-active', mode === 'lock'));
      disposers.push(offSelect, offCamera);
    }

    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => resize());
      resizeObserver.observe(root);
    }
    showEmpty(null);
    rafHandle = requestAnimationFrame(() => {
      rafHandle = 0;
      if (lastSnap) update(lastSnap);
    });
  }

  function resize() {
    if (!root || !refs.content || refs.content.hidden || !lastVessel) return;
    drawInstruments(lastVessel);
  }

  function destroy() {
    if (rafHandle) cancelAnimationFrame(rafHandle);
    rafHandle = 0;
    while (disposers.length) {
      const off = disposers.pop();
      try {
        off?.();
      } catch {
        /* ignore */
      }
    }
    if (resizeObserver) resizeObserver.disconnect();
    resizeObserver = null;
    clearPendingSensor();
    clearPendingCommand(false);
    root?.remove();
    root = null;
    refs = {};
    lastSnap = null;
    lastVessel = null;
    lastRenderedId = null;
    sensorSignature = '';
    history.clear();
  }

  return {
    name: 'detail',
    mount,
    update,
    frame() {},
    resize,
    destroy,
  };
}
