// =============================================================================
// OceanSwarm GCS — LEFT RAIL panel: MISSION card / FLEET roster / FORMATION.
// Owner: ui-left · contract: docs/GCS-architecture.md §4.1/§4.6/§7.2
// -----------------------------------------------------------------------------
// · mount() builds the whole skeleton from meta.* so the rail renders (with '—'
//   placeholders) even before the first simulator snapshot arrives.
// · update(snap) is a pure diff pass: text nodes, class flags and bar widths are
//   written only when the value actually changed, so the 10 Hz snapshot loop
//   never rebuilds the 17-row roster.
// · Command buttons only go through ctx.actions; the resulting ack entries in
//   snap.acks drive the pending → acked feedback. No optimistic state here:
//   selected formation / speed / mode are always painted from the snapshot.
// =============================================================================
import './../styles/left.css';
import { h, setText, setClass, setAttr } from '../dom.js';

const DASH = '—';
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const pad2 = (v) => String(Math.max(0, Math.round(v))).padStart(2, '0');
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const DOT_BY_STATUS = {
  normal: 'gcs-dot--ok',
  warning: 'gcs-dot--warn',
  critical: 'gcs-dot--danger',
  offline: 'gcs-dot--offline',
};

const MODE_TONE = {
  ok: 'ok',
  accent: 'accent',
  warn: 'warn',
  danger: 'danger',
  offline: 'idle',
};

/** @param {object} ctx @returns {{name:string, mount:Function, update:Function, frame:Function, destroy:Function}} */
export function createLeftPanel(ctx) {
  const { meta, format: fmt, icons } = ctx;
  const actions = ctx.actions;

  let refs = null;
  let selectedId = null;
  let seenAcks = null;
  let destroyed = false;
  const pending = new Map(); // command key -> pending entry
  const unsubs = [];
  const warned = new Set();

  // ---------------------------------------------------------------------------
  // tiny helpers
  // ---------------------------------------------------------------------------
  function safe(label, fn) {
    try {
      fn();
    } catch (err) {
      if (!warned.has(label)) {
        warned.add(label);
        console.error(`[gcs:left] ${label} failed`, err);
      }
    }
  }

  function buildHead(index, cn, en, metaEl) {
    return h(
      'header',
      { class: 'gcs-panel-head' },
      h('span', { class: 'gcs-panel-index', text: index }),
      h('h2', { class: 'gcs-panel-title' }, cn, h('em', {}, en)),
      metaEl,
    );
  }

  function iconSpan(name, size = 12) {
    return h('span', { class: 'left-btn-icon', html: icons.icon(name, size) });
  }

  function setIcon(ref, name) {
    if (ref.icon === name) return;
    ref.icon = name;
    ref.iconEl.innerHTML = icons.icon(name, 12);
  }

  /** Update a command button caption (中文 + optional EN micro label + icon). */
  function setCmdLabel(ref, cn, en, iconName) {
    if (ref.cn !== cn) {
      ref.cn = cn;
      setText(ref.cnEl, cn);
    }
    const nextEn = en || '';
    if (ref.en !== nextEn) {
      ref.en = nextEn;
      setText(ref.enEl, nextEn);
    }
    const showEn = nextEn.length > 0;
    if (ref.enShown !== showEn) {
      ref.enShown = showEn;
      setAttr(ref.enEl, 'hidden', !showEn);
    }
    if (iconName) setIcon(ref, iconName);
  }

  /** Build a labelled command button; refs keep the inner nodes for diffing. */
  function cmdButton({ icon, cn, en, title, extraClass }) {
    const iconEl = iconSpan(icon);
    const cnEl = h('span', { class: 'left-btn-cn', text: cn });
    const enEl = h('em', { class: 'left-btn-en', text: en || '', attrs: en ? null : { hidden: true } });
    const labelEl = h('span', { class: 'left-btn-label' }, cnEl, enEl);
    const btn = h(
      'button',
      {
        class: `gcs-btn left-btn${extraClass ? ` ${extraClass}` : ''}`,
        attrs: { type: 'button', title: title || '' },
      },
      iconEl,
      labelEl,
    );
    return { btn, iconEl, icon: icon, cnEl, cn: cn, enEl, en: en || '', enShown: !!en };
  }

  // ---------------------------------------------------------------------------
  // 1. MISSION card
  // ---------------------------------------------------------------------------
  function buildMission() {
    const md = meta.MISSION;
    const segs = [];
    const phaseBar = h('div', {
      class: 'left-phase-bar',
      attrs: { title: `任务阶段 ${md.phases.length} 段：${md.phases.map((p) => p.name).join(' / ')}` },
    });
    for (const phase of md.phases) {
      const seg = h('span', {
        class: 'left-phase-seg',
        attrs: { title: `${phase.name} ${phase.en} · ${phase.durationSec}s` },
      });
      segs.push(seg);
      phaseBar.appendChild(seg);
    }

    const codeEl = h('span', {
      class: 'gcs-chip gcs-chip--accent gcs-panel-meta left-mission-code',
      text: md.code || md.id,
    });
    const nameEl = h('span', { class: 'left-mission-name', text: md.name });
    const areaEl = h('span', { class: 'left-mission-area', text: md.area });
    const areaEnEl = h('em', { class: 'left-mission-area-en', text: md.areaEn });
    const phaseIdxEl = h('b', { class: 'left-phase-idx', text: `${DASH}/${pad2(md.phases.length)}` });
    const phaseNameEl = h('span', { class: 'left-phase-name', text: DASH });
    const metEl = h('b', { class: 'left-met', text: DASH });
    const wpIdEl = h('b', { class: 'left-wp-id', text: DASH });
    const wpNameEl = h('span', { class: 'left-wp-name', text: DASH });

    const mapBtn = h(
      'button',
      {
        class: 'gcs-btn gcs-btn--sm gcs-btn--ghost left-map-btn',
        attrs: { type: 'button', title: '切换到二维战术图（M）', 'aria-pressed': 'false' },
        on: { click: () => actions.setViewMode('map') },
      },
      iconSpan('map'),
      h('span', { class: 'left-btn-label' }, h('span', { class: 'left-btn-cn', text: '战术图' })),
    );

    const body = h(
      'div',
      { class: 'gcs-panel-body left-mission-body' },
      h('div', { class: 'left-mission-top' }, nameEl),
      h('div', { class: 'left-mission-sub' }, areaEl, areaEnEl),
      h('div', { class: 'left-phase' }, phaseBar, h('div', { class: 'left-phase-label' }, phaseIdxEl, phaseNameEl)),
      h(
        'div',
        { class: 'left-mission-foot' },
        h('span', { class: 'left-metric' }, h('i', { class: 'left-metric-k', text: 'MET' }), metEl),
        h('span', { class: 'left-metric' }, h('i', { class: 'left-metric-k', text: '航路' }), wpIdEl, wpNameEl),
        mapBtn,
      ),
    );

    const el = h('section', { class: 'gcs-panel left-mission', style: { '--gcs-i': '0' } }, buildHead('01', '任务', 'MISSION', codeEl), body);

    return { el, codeEl, nameEl, areaEl, areaEnEl, segs, phaseIdxEl, phaseNameEl, metEl, wpIdEl, wpNameEl, mapBtn };
  }

  function updateMission(snap) {
    const r = refs.mission;
    // Contract §4.3 nests the mission block under fleet.mission; tolerate a
    // top-level copy as well so partial mocks keep the card alive.
    const m = (snap.fleet && snap.fleet.mission) || snap.mission || {};
    const md = meta.MISSION;

    setText(r.codeEl, m.id || md.code || md.id);
    setText(r.nameEl, m.name || md.name);
    setText(r.areaEl, m.area || md.area);
    setText(r.areaEnEl, (m.en || md.en || '').toString());

    // ---- phase: prefer the explicit phase number, then the phase name
    // (sim exports a 0-based `phaseIndex` + 1-based `phaseNo`; the bootstrap
    // mock exports a 1-based `phaseIndex` only — the name is our common key).
    const phases = md.phases;
    const phaseCount =
      isNum(m.phaseCount) && m.phaseCount > 0 ? clamp(Math.round(m.phaseCount), 1, phases.length) : phases.length;
    let phaseIdx = 0; // 1-based, 0 = unknown
    if (isNum(m.phaseNo) && m.phaseNo >= 1) {
      phaseIdx = clamp(Math.round(m.phaseNo), 1, phaseCount);
    }
    if (!phaseIdx && typeof m.phaseName === 'string' && m.phaseName) {
      const found = phases.findIndex((p) => p.name === m.phaseName || p.en === m.phaseEn);
      if (found >= 0) phaseIdx = found + 1;
    }
    if (!phaseIdx && isNum(m.phaseIndex)) {
      const raw = Math.round(m.phaseIndex);
      phaseIdx = clamp(raw >= 1 ? raw : 1, 1, phaseCount);
    }
    for (let i = 0; i < r.segs.length; i++) {
      const seg = r.segs[i];
      const oneBased = i + 1;
      const isCurrent = phaseIdx > 0 && oneBased === phaseIdx;
      setClass(seg, 'is-done', phaseIdx > 0 && oneBased < phaseIdx);
      setClass(seg, 'is-current', isCurrent);
      if (isCurrent) {
        const p = isNum(m.phaseProgress) ? clamp(m.phaseProgress, 0, 1) : 1;
        const value = (Math.round(p * 100) / 100).toFixed(2);
        if (seg._phaseFill !== value) {
          seg.style.setProperty('--left-phase-fill', value);
          seg._phaseFill = value;
        }
      }
    }
    setText(r.phaseIdxEl, phaseIdx > 0 ? `${pad2(phaseIdx)}/${pad2(phaseCount)}` : `${DASH}/${pad2(phaseCount)}`);
    setText(r.phaseNameEl, phaseIdx > 0 ? m.phaseName || phases[phaseIdx - 1].name : DASH);

    // ---- mission elapsed time
    const metText = typeof snap.metText === 'string' && snap.metText.trim() ? snap.metText : fmt.hms(snap.met);
    setText(r.metEl, metText || DASH);

    // ---- current waypoint
    const wpList = md.waypoints;
    const wpTotal = isNum(m.waypointTotal) && m.waypointTotal > 0 ? Math.round(m.waypointTotal) : wpList.length;
    let wp = null;
    if (typeof m.waypointName === 'string' && m.waypointName) {
      wp = wpList.find((w) => w.name === m.waypointName) || null;
    }
    if (!wp && isNum(m.waypointIndex)) {
      wp = wpList[clamp(Math.round(m.waypointIndex), 1, wpTotal) - 1] || null;
    }
    setText(r.wpIdEl, wp ? wp.id : DASH);
    setText(r.wpNameEl, m.waypointName || (wp && wp.name) || DASH);

    updateMapButton(ctx.state.viewMode);
  }

  function updateMapButton(mode) {
    if (!refs) return;
    const isMap = mode === 'map';
    setClass(refs.mission.mapBtn, 'is-active', isMap);
    setAttr(refs.mission.mapBtn, 'aria-pressed', isMap ? 'true' : 'false');
  }

  // ---------------------------------------------------------------------------
  // 2. FLEET roster
  // ---------------------------------------------------------------------------
  function buildRoster() {
    const onlineEl = h('span', { class: 'left-meta-online', text: `${DASH}/${meta.FLEET.length}` });
    const avgEl = h('span', { class: 'left-meta-avg', text: DASH });
    const alertEl = h('span', { class: 'left-meta-alerts', text: `告警 ${DASH}` });
    const metaEl = h(
      'span',
      { class: 'gcs-panel-meta left-fleet-meta', attrs: { title: '在线数 · 平均电量 · 活动告警' } },
      onlineEl,
      h('span', { class: 'left-meta-sep', text: '·' }),
      avgEl,
      h('span', { class: 'left-meta-sep', text: '·' }),
      alertEl,
    );

    const listEl = h('div', { class: 'gcs-list left-roster' });
    const rows = new Map();
    const groups = [];

    for (const group of meta.GROUPS) {
      const countEl = h('span', { class: 'left-group-count', text: DASH });
      const labelEl = h(
        'div',
        { class: 'left-group' },
        h('span', { class: 'left-group-name', text: group.name }),
        h('span', { class: 'left-group-en', text: group.en }),
        h('span', { class: 'left-group-line' }),
        countEl,
      );
      listEl.appendChild(labelEl);
      groups.push({ ids: group.ids, countEl });

      for (const id of group.ids) {
        const spec = meta.FLEET_BY_ID.get(id);
        if (!spec) continue;
        const row = buildRow(spec);
        rows.set(id, row);
        listEl.appendChild(row.row);
      }
    }

    const body = h('div', { class: 'gcs-panel-body left-fleet-body' }, listEl);
    const el = h(
      'section',
      { class: 'gcs-panel left-fleet', style: { '--gcs-i': '1' } },
      buildHead('02', '集群名册', 'FLEET', metaEl),
      body,
    );

    return { el, listEl, rows, groups, onlineEl, avgEl, alertEl };
  }

  function buildRow(spec) {
    const tm = meta.TYPE_META[spec.type] || {};
    const dot = h('span', { class: 'gcs-dot left-row-dot', attrs: { 'aria-hidden': 'true' } });
    const callsign = h('span', { class: 'left-callsign', text: spec.callSign });
    const name = h('span', { class: 'left-name', text: spec.name });
    const type = h('span', {
      class: 'left-type',
      text: tm.short || spec.type,
      attrs: { title: `${tm.typeName || spec.type} ${tm.roleEn || ''}`.trim() },
    });
    const fill = h('i', { class: 'gcs-bar-fill' });
    const bar = h('span', { class: 'gcs-bar left-row-bar', attrs: { 'aria-hidden': 'true' } }, fill);
    const pct = h('span', { class: 'left-batt-pct', text: DASH });
    const spdVal = h('b', { class: 'left-spd-val', text: DASH });
    const spd = h('span', { class: 'left-spd' }, spdVal, h('i', { class: 'left-spd-unit', text: 'kn' }));
    const alarm = h('span', { class: 'left-alarm-dot', attrs: { 'aria-hidden': 'true' } });

    const row = h(
      'div',
      {
        class: 'gcs-row left-row',
        attrs: {
          'data-id': spec.id,
          role: 'button',
          tabindex: '0',
          'aria-pressed': 'false',
          'aria-label': `${spec.callSign} ${spec.name} ${tm.typeName || ''}`.trim(),
        },
        on: {
          click: () => actions.selectVessel(spec.id),
          dblclick: () => actions.focusVessel(spec.id),
          keydown: (ev) => {
            if (ev.key === 'Enter' || ev.key === ' ') {
              ev.preventDefault();
              actions.selectVessel(spec.id);
            }
          },
        },
      },
      dot,
      callsign,
      name,
      type,
      bar,
      pct,
      spd,
      alarm,
    );

    return { spec, row, dot, bar, fill, pct, spdVal, alarm, prev: {} };
  }

  function updateRow(r, v) {
    const prev = r.prev;
    if (!v) {
      // vessel not present in this snapshot yet — keep the skeleton, drop stale live values
      if (prev.dot !== null) {
        prev.dot = null;
        r.dot.className = 'gcs-dot left-row-dot';
      }
      setFill(prev, r.fill, null);
      setBarTone(prev, r.bar, 'none');
      setText(r.pct, DASH);
      setText(r.spdVal, DASH);
      setAlarm(prev, r.alarm, 0, null);
      setClass(r.row, 'is-offline', false);
      return;
    }

    const dotCls = DOT_BY_STATUS[v.status] || null;
    if (prev.dot !== dotCls) {
      prev.dot = dotCls;
      r.dot.className = dotCls ? `gcs-dot left-row-dot ${dotCls}` : 'gcs-dot left-row-dot';
    }

    const battery = isNum(v.batteryPct) ? clamp(v.batteryPct, 0, 100) : null;
    setFill(prev, r.fill, battery);
    setBarTone(prev, r.bar, battery == null ? 'none' : battery < 15 ? 'danger' : battery < 30 ? 'warn' : 'none');
    setText(r.pct, fmt.pct(battery));

    setText(r.spdVal, fmt.num(v.sogKn, 1));

    const alarmCount = isNum(v.alarmCount) ? Math.max(0, Math.round(v.alarmCount)) : 0;
    setAlarm(prev, r.alarm, alarmCount, v.status);

    setClass(r.row, 'is-offline', v.status === 'offline');
  }

  function setFill(prev, el, battery) {
    const width = battery == null ? '0%' : `${Math.round(battery)}%`;
    if (prev.fill === width) return;
    prev.fill = width;
    el.style.width = width;
  }

  function setBarTone(prev, el, tone) {
    const cls = `gcs-bar left-row-bar${tone === 'warn' ? ' gcs-bar--warn' : tone === 'danger' ? ' gcs-bar--danger' : ''}`;
    if (prev.bar === cls) return;
    prev.bar = cls;
    el.className = cls;
  }

  function setAlarm(prev, el, count, status) {
    const on = count > 0;
    if (prev.alarmOn !== on) {
      prev.alarmOn = on;
      setClass(el, 'is-on', on);
    }
    const critical = status === 'critical';
    if (prev.alarmCritical !== critical) {
      prev.alarmCritical = critical;
      setClass(el, 'is-critical', critical);
    }
    const title = on ? `${count} 条活动告警` : '';
    if (prev.alarmTitle !== title) {
      prev.alarmTitle = title;
      setAttr(el, 'title', title || null);
    }
  }

  function updateRoster(snap) {
    const r = refs.fleet;
    const vessels = Array.isArray(snap.vessels) ? snap.vessels : [];
    const byId = new Map();
    for (const v of vessels) {
      if (v && v.id) byId.set(v.id, v);
    }
    for (const [id, row] of r.rows) updateRow(row, byId.get(id) || null);

    const fleet = snap.fleet || {};
    const hasFleet = !!snap.fleet;

    // online / total
    let total = meta.FLEET.length;
    if (hasFleet && isNum(fleet.total) && fleet.total > 0) total = Math.round(fleet.total);
    let online = null;
    if (hasFleet && isNum(fleet.online)) online = Math.round(fleet.online);
    else if (vessels.length) online = vessels.filter((v) => v && v.status !== 'offline').length;
    setText(r.onlineEl, `${online == null ? DASH : online}/${total}`);
    setClass(r.onlineEl, 'gcs-txt--warn', online != null && online < total);

    // average battery
    let avg = hasFleet && isNum(fleet.avgBatteryPct) ? fleet.avgBatteryPct : null;
    if (avg == null && vessels.length) {
      let sum = 0;
      let n = 0;
      for (const v of vessels) {
        if (v && isNum(v.batteryPct)) {
          sum += v.batteryPct;
          n += 1;
        }
      }
      avg = n ? sum / n : null;
    }
    setText(r.avgEl, fmt.pct(avg));
    setClass(r.avgEl, 'gcs-txt--warn', avg != null && avg < 40);
    setClass(r.avgEl, 'gcs-txt--danger', avg != null && avg < 20);
    setAttr(r.avgEl, 'title', '集群平均电量');

    // active alarms (critical + warning; fall back to the alarm list length)
    const alerts = fleet.alerts || {};
    let alertCount = null;
    if (isNum(alerts.critical) || isNum(alerts.warning)) alertCount = (alerts.critical || 0) + (alerts.warning || 0);
    else if (Array.isArray(snap.alarms)) alertCount = snap.alarms.length;
    setText(r.alertEl, alertCount == null ? `告警 ${DASH}` : `告警 ${alertCount}`);
    const hasCritical = isNum(alerts.critical) && alerts.critical > 0;
    setClass(r.alertEl, 'gcs-txt--danger', hasCritical);
    setClass(r.alertEl, 'gcs-txt--warn', !hasCritical && !!alertCount);
    setClass(r.alertEl, 'gcs-txt--4', alertCount === 0);

    // per-group online count
    for (const group of r.groups) {
      let up = 0;
      let known = 0;
      for (const id of group.ids) {
        const v = byId.get(id);
        if (!v) continue;
        known += 1;
        if (v.status !== 'offline') up += 1;
      }
      setText(group.countEl, known ? `${up}/${group.ids.length}` : `${DASH}/${group.ids.length}`);
    }
  }

  // ---------------------------------------------------------------------------
  // 3. FORMATION control
  // ---------------------------------------------------------------------------
  function buildFormation() {
    const modeCnEl = h('b', { class: 'left-mode-cn', text: DASH });
    const modeEnEl = h('em', { class: 'left-mode-en' });
    const modeEl = h(
      'span',
      { class: 'gcs-panel-meta left-mode', attrs: { 'data-tone': 'idle', title: '集群编队模式' } },
      modeCnEl,
      modeEnEl,
    );

    const formBtns = new Map();
    const grid = h('div', { class: 'left-form-grid' });
    meta.FORMATIONS.forEach((f, i) => {
      const btn = h(
        'button',
        {
          class: 'gcs-btn left-form-btn',
          attrs: { type: 'button', title: `${f.name} ${f.en} · 快捷键 ${i + 1}`, 'aria-pressed': 'false' },
        },
        h('span', { class: 'left-form-glyph', html: icons.glyph(f.glyph, 16) }),
        h('span', { class: 'left-form-name', text: f.name }),
      );
      btn.addEventListener('click', () => {
        if (isEstopActive()) return;
        runCommand(btn, `formation:${f.key}`, [f.name, f.en, '编队', '队形', 'formation'], () =>
          actions.setFormation(f.key),
        );
      });
      formBtns.set(f.key, btn);
      grid.appendChild(btn);
    });

    const speedBtns = [];
    const speedSeg = h('div', { class: 'gcs-seg left-speed', attrs: { role: 'group', 'aria-label': '编队航速' } });
    meta.SPEED_PRESETS.forEach((p, i) => {
      const btn = h(
        'button',
        {
          class: 'gcs-seg-item',
          attrs: { type: 'button', title: `${p.name} ${p.en} · Shift+${i + 1}`, 'aria-pressed': 'false' },
        },
        h('span', { class: 'left-seg-cn', text: p.name }),
        h('span', { class: 'left-seg-en', text: p.en }),
      );
      btn.addEventListener('click', () => {
        if (isEstopActive()) return;
        runCommand(btn, `speed:${p.scale}`, [p.name, p.en, '航速', 'speed'], () => actions.setSpeedScale(p.scale));
      });
      speedBtns.push({ preset: p, btn });
      speedSeg.appendChild(btn);
    });

    const hold = cmdButton({ icon: 'pause', cn: '保持', en: 'HOLD', title: '编队保持 · Space' });
    hold.btn.addEventListener('click', () => onHoldClick(hold.btn));
    const rally = cmdButton({ icon: 'target', cn: '集结', en: 'RALLY', title: '编队集结：各艇向中心收缩阵位' });
    rally.btn.addEventListener('click', () => {
      if (isEstopActive()) return;
      runCommand(rally.btn, 'formation.scale:0.5', ['集结', '收缩', 'rally', '密集'], () => actions.rally());
    });
    const disperse = cmdButton({ icon: 'expand', cn: '分散', en: 'SPREAD', title: '编队分散：各艇展开间距' });
    disperse.btn.addEventListener('click', () => {
      if (isEstopActive()) return;
      runCommand(disperse.btn, 'formation.scale:1.8', ['分散', '展开', 'disperse', '疏开'], () => actions.disperse());
    });

    const uturn = cmdButton({ icon: 'swap', cn: '调头 180°', en: '', title: '集群调头 180° · U' });
    uturn.btn.addEventListener('click', () => {
      if (isEstopActive()) return;
      runCommand(uturn.btn, 'fleet.uturn', ['调头', '转向', 'uturn', 'turn'], () => actions.uturn());
    });
    const rtl = cmdButton({ icon: 'route', cn: '返航', en: 'RTL', title: '全员返航至试验基地' });
    rtl.btn.addEventListener('click', () => onRtlClick(rtl.btn));
    const estop = cmdButton({
      icon: 'critical',
      cn: '急停',
      en: 'E-STOP',
      title: '紧急停止（需二次确认）',
      extraClass: 'gcs-btn--danger left-estop',
    });
    estop.btn.addEventListener('click', () => onEstopClick(estop.btn));

    const body = h(
      'div',
      { class: 'gcs-panel-body left-formation-body' },
      grid,
      speedSeg,
      h('div', { class: 'left-cmd-row left-cmd-row--aux' }, hold.btn, rally.btn, disperse.btn),
      h('div', { class: 'left-cmd-row left-cmd-row--main' }, uturn.btn, rtl.btn, estop.btn),
    );

    const el = h(
      'section',
      { class: 'gcs-panel left-formation', style: { '--gcs-i': '2' } },
      buildHead('03', '编队控制', 'FORMATION', modeEl),
      body,
    );

    return {
      el,
      modeEl,
      modeCnEl,
      modeEnEl,
      formBtns,
      speedBtns,
      hold,
      rally,
      disperse,
      uturn,
      rtl,
      estop,
      held: null,
      rtlActive: null,
      estopActive: null,
      lockable: [...formBtns.values(), ...speedBtns.map((s) => s.btn), hold.btn, rally.btn, disperse.btn, uturn.btn, rtl.btn],
    };
  }

  function snapshotFleet() {
    const snap = ctx.getSnapshot();
    return (snap && snap.fleet) || null;
  }

  function isEstopActive() {
    const fleet = snapshotFleet();
    return !!fleet && (!!fleet.estop?.active || fleet.mode === 'estop');
  }

  function currentMode() {
    const fleet = snapshotFleet();
    return fleet && typeof fleet.mode === 'string' ? fleet.mode : null;
  }

  function onHoldClick(btn) {
    if (isEstopActive()) return;
    if (currentMode() === 'hold') {
      runCommand(btn, 'fleet.resume', ['恢复', '归队', 'resume', '继续'], () => actions.resumeFleet());
    } else {
      runCommand(btn, 'fleet.hold', ['保持', '驻留', 'hold'], () => actions.holdFleet());
    }
  }

  function onRtlClick(btn) {
    if (isEstopActive()) return;
    if (currentMode() === 'rtl') {
      runCommand(btn, 'fleet.cancelRtl', ['取消', 'cancel', '归队'], () => actions.cancelRtl());
    } else {
      runCommand(btn, 'fleet.rtl', ['返航', 'rtl', '基地'], () => actions.rtlFleet());
    }
  }

  function onEstopClick(btn) {
    if (isEstopActive()) {
      runCommand(btn, 'fleet.recover', ['解除', '恢复', 'recover'], () => actions.recover());
    } else {
      runCommand(btn, 'fleet.estop', ['急停', '紧急', 'estop'], () => actions.estop());
    }
  }

  function updateFormation(snap) {
    const r = refs.formation;
    const fleet = snap.fleet || {};
    const mode = typeof fleet.mode === 'string' ? fleet.mode : null;
    const estopActive = !!fleet.estop?.active || mode === 'estop';

    // ---- selected formation
    const formationKey = typeof fleet.formation === 'string' ? fleet.formation : null;
    for (const [key, btn] of r.formBtns) {
      const active = key === formationKey;
      setClass(btn, 'is-active', active);
      setAttr(btn, 'aria-pressed', active ? 'true' : 'false');
    }

    // ---- selected speed preset
    const scale = isNum(fleet.speedScale) ? fleet.speedScale : null;
    for (const item of r.speedBtns) {
      const active = scale != null && Math.abs(item.preset.scale - scale) <= 0.08;
      setClass(item.btn, 'is-active', active);
      setAttr(item.btn, 'aria-pressed', active ? 'true' : 'false');
    }

    // ---- hold / resume
    const held = mode === 'hold';
    setClass(r.hold.btn, 'is-active', held);
    if (r.held !== held) {
      r.held = held;
      setCmdLabel(r.hold, held ? '恢复' : '保持', held ? 'RESUME' : 'HOLD', held ? 'play' : 'pause');
      setAttr(r.hold.btn, 'title', held ? '恢复编队巡航 · Space' : '编队保持 · Space');
    }

    // ---- return to launch (toggles into "cancel" while the fleet is RTL)
    const rtlActive = mode === 'rtl';
    setClass(r.rtl.btn, 'is-active', rtlActive);
    if (r.rtlActive !== rtlActive) {
      r.rtlActive = rtlActive;
      if (rtlActive) setCmdLabel(r.rtl, '取消返航', '', 'close');
      else setCmdLabel(r.rtl, '返航', 'RTL', 'route');
      setAttr(r.rtl.btn, 'title', rtlActive ? '取消返航，集群归队' : '全员返航至试验基地');
    }

    // ---- u-turn in progress
    setClass(r.uturn.btn, 'is-active', mode === 'uturn');

    // ---- E-STOP lockdown (only "解除急停" stays operable)
    if (r.estopActive !== estopActive) {
      r.estopActive = estopActive;
      setClass(r.el, 'gcs-panel--danger', estopActive);
      setClass(r.el, 'is-critical', estopActive);
      setClass(r.el, 'is-estop', estopActive);
      setClass(r.estop.btn, 'is-armed', estopActive);
      if (estopActive) {
        setCmdLabel(r.estop, '解除急停', '', 'refresh');
        setAttr(r.estop.btn, 'title', '解除紧急停止，恢复编队控制');
      } else {
        setCmdLabel(r.estop, '急停', 'E-STOP', 'critical');
        setAttr(r.estop.btn, 'title', '紧急停止（需二次确认）');
      }
      for (const btn of r.lockable) {
        btn.disabled = estopActive;
        setAttr(btn, 'aria-disabled', estopActive ? 'true' : 'false');
      }
    }

    // ---- header mode readout
    const modeMeta = mode ? meta.FLEET_MODES[mode] : null;
    const modeCn = estopActive ? '紧急停止' : (modeMeta && modeMeta.text) || fleet.modeText || DASH;
    const modeEn = estopActive ? 'E-STOP' : (modeMeta && modeMeta.en) || '';
    const tone = estopActive ? 'danger' : MODE_TONE[(modeMeta && modeMeta.tone) || ''] || 'idle';
    setText(r.modeCnEl, modeCn);
    setText(r.modeEnEl, modeEn);
    setAttr(r.modeEl, 'data-tone', tone);
    const sinceSec = fleet.estop && isNum(fleet.estop.sinceSec) ? Math.round(fleet.estop.sinceSec) : null;
    setAttr(r.modeEl, 'title', estopActive && sinceSec != null ? `紧急停止已持续 ${sinceSec} s` : '集群编队模式');
  }

  // ---------------------------------------------------------------------------
  // command dispatch → pending → ack feedback
  // ---------------------------------------------------------------------------
  const PENDING_MIN_MS = 120;
  const PENDING_MAX_MS = 2800;
  const FIFO_FALLBACK_MS = 900;

  function armPending(key, btn, keywords) {
    const existing = pending.get(key);
    if (existing) finishPending(key, existing, false);
    const now = performance.now();
    const entry = {
      btn,
      keywords: (keywords || []).map((w) => String(w).toLowerCase()).filter(Boolean),
      since: now,
      minUntil: now + PENDING_MIN_MS,
      timer: 0,
    };
    entry.timer = setTimeout(() => {
      if (pending.get(key) === entry) finishPending(key, entry, false);
    }, PENDING_MAX_MS);
    btn.classList.add('is-pending');
    pending.set(key, entry);
  }

  function finishPending(key, entry, acked) {
    clearTimeout(entry.timer);
    if (pending.get(key) === entry) pending.delete(key);
    entry.btn.classList.remove('is-pending');
    if (acked) {
      entry.btn.classList.add('is-acked');
      setTimeout(() => entry.btn.classList.remove('is-acked'), 480);
    }
  }

  function resolvePending(key, acked) {
    const entry = pending.get(key);
    if (!entry) return;
    const wait = entry.minUntil - performance.now();
    if (wait > 0) {
      clearTimeout(entry.timer);
      entry.timer = setTimeout(() => finishPending(key, entry, acked), Math.ceil(wait));
      return;
    }
    finishPending(key, entry, acked);
  }

  async function runCommand(btn, key, keywords, fn) {
    if (destroyed || !btn) return;
    let result;
    try {
      result = await fn();
    } catch (err) {
      console.error('[gcs:left] command failed', key, err);
      return;
    }
    if (destroyed) return;
    if (result === false) return; // cancelled in the confirm dialog
    if (!result) return;
    if (typeof result === 'object' && result.accepted === false) return; // rejected by the bus (ctx toasts)
    armPending(key, btn, keywords);
  }

  function ackKeyOf(ack, index) {
    if (ack && ack.id != null) return `id:${ack.id}`;
    const clock = ack && ack.clockText ? ack.clockText : '';
    return `anon:${clock}|${index}`;
  }

  function ackText(ack) {
    return `${(ack && ack.commandText) || ''} ${(ack && ack.text) || ''} ${(ack && ack.detail) || ''}`.toLowerCase();
  }

  function processAcks(snap) {
    const list = Array.isArray(snap.acks) ? snap.acks : [];
    const keys = list.map(ackKeyOf);
    if (seenAcks === null) {
      seenAcks = new Set(keys);
      return;
    }
    const fresh = [];
    for (let i = 0; i < list.length; i++) {
      if (seenAcks.has(keys[i])) continue;
      fresh.push(list[i]);
      seenAcks.add(keys[i]);
    }
    if (seenAcks.size > 96) seenAcks = new Set(keys);
    if (!fresh.length || !pending.size) return;

    const used = new Set();
    // pass 1 — match the ack wording against the command's own keywords
    for (const [key, entry] of [...pending]) {
      for (let i = 0; i < fresh.length; i++) {
        if (used.has(i)) continue;
        const text = ackText(fresh[i]);
        if (!entry.keywords.some((word) => text.includes(word))) continue;
        used.add(i);
        resolvePending(key, fresh[i].ok !== false);
        break;
      }
    }
    // pass 2 — FIFO fallback for acks with unexpected wording
    for (const [key, entry] of [...pending]) {
      if (performance.now() - entry.since < FIFO_FALLBACK_MS) continue;
      for (let i = 0; i < fresh.length; i++) {
        if (used.has(i)) continue;
        used.add(i);
        resolvePending(key, fresh[i].ok !== false);
        break;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // selection
  // ---------------------------------------------------------------------------
  function applySelection(id) {
    const next = id || null;
    if (!refs) {
      selectedId = next;
      return;
    }
    if (next === selectedId) return;
    selectedId = next;
    for (const [rowId, row] of refs.fleet.rows) {
      const on = rowId === next;
      setClass(row.row, 'is-selected', on);
      setAttr(row.row, 'aria-pressed', on ? 'true' : 'false');
    }
    if (next) {
      const row = refs.fleet.rows.get(next);
      if (row) revealRow(row.row);
    }
  }

  function revealRow(row) {
    const list = refs.fleet.listEl;
    if (!list || !list.clientHeight) return;
    const listRect = list.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    if (rowRect.top >= listRect.top + 1 && rowRect.bottom <= listRect.bottom - 1) return;
    const target = list.scrollTop + (rowRect.top - listRect.top) - (listRect.height - rowRect.height) / 2;
    list.scrollTop = Math.max(0, target);
  }

  // ---------------------------------------------------------------------------
  // panel lifecycle
  // ---------------------------------------------------------------------------
  function mount(host) {
    const mission = buildMission();
    const fleet = buildRoster();
    const formation = buildFormation();
    refs = { mission, fleet, formation };

    host.append(mission.el, fleet.el, formation.el);

    selectedId = null;
    applySelection(ctx.state.selectedId);
    updateMapButton(ctx.state.viewMode);

    unsubs.push(ctx.bus.on('select', (id) => applySelection(id)));
    unsubs.push(ctx.bus.on('view', (mode) => updateMapButton(mode)));
  }

  function update(snap) {
    if (destroyed || !refs || !snap) return;
    applySelection(ctx.state.selectedId);
    safe('mission', () => updateMission(snap));
    safe('roster', () => updateRoster(snap));
    safe('formation', () => updateFormation(snap));
    safe('acks', () => processAcks(snap));
  }

  function destroy() {
    destroyed = true;
    for (const off of un