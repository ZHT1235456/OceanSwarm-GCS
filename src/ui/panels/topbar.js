// =============================================================================
// TOPBAR — the console's instrument beam (design §7.1).
//
// Three segments: [brand · mission] | [waypoint progress] | [link · GNSS · sea ·
// alarms · clock · operator]. Every value is snapshot driven; missing values
// render as an em-dash, never NaN/undefined. The alarm counter is the one
// interactive element beyond help/clean: it filters the event stream to alarms.
// =============================================================================
import { h, setText, setClass, on } from '../dom.js';
import '../styles/topbar.css';

const DASH = '—';
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const pad2 = (v) => String(Math.max(0, Math.round(v))).padStart(2, '0');

const int = (v) => (isNum(v) ? String(Math.round(v)) : DASH);
const num1 = (v) => (isNum(v) ? v.toFixed(1) : DASH);
const pct = (v) => (isNum(v) ? `${Math.round(v)}%` : DASH);
const msText = (v) => (isNum(v) ? `${Math.round(v)} ms` : DASH);
const hms = (v) => {
  if (!isNum(v)) return DASH;
  const s = Math.max(0, Math.round(v));
  return `${pad2(Math.floor(s / 3600))}:${pad2(Math.floor((s % 3600) / 60))}:${pad2(s % 60)}`;
};

/** 0..100 from either a 0..1 or 0..100 scale. */
function progressPct(value) {
  if (!isNum(value)) return null;
  const p = value <= 1 ? value * 100 : value;
  return Math.max(0, Math.min(100, p));
}

/**
 * Mission phase derived from MET so it is always consistent with the mission
 * clock (META.MISSION.phases is the contract). Snapshot fields are the fallback.
 */
function readPhase(meta, snap) {
  const mission = snap?.fleet?.mission || {};
  const phases = meta.MISSION?.phases || [];
  const fallback = {
    index: isNum(mission.phaseIndex) ? mission.phaseIndex : null,
    count: isNum(mission.phaseCount) ? mission.phaseCount : phases.length || null,
    name: mission.phaseName || DASH,
    en: mission.phaseEn || '',
    frac: progressPct(mission.phaseProgress),
  };
  const met = snap?.met;
  if (!phases.length || !isNum(met)) return fallback;

  const total = phases.reduce((sum, p) => sum + (isNum(p.durationSec) ? p.durationSec : 0), 0);
  if (total <= 0) return fallback;
  const t = ((met % total) + total) % total;
  let acc = 0;
  let idx = phases.length - 1;
  let start = 0;
  for (let i = 0; i < phases.length; i += 1) {
    const dur = phases[i].durationSec || 0;
    if (t < acc + dur) {
      idx = i;
      start = acc;
      break;
    }
    acc += dur;
  }
  const phase = phases[idx];
  const dur = phase.durationSec || 0;
  return {
    index: idx + 1,
    count: phases.length,
    name: phase.name,
    en: phase.en,
    frac: dur > 0 ? clamp01((t - start) / dur) : 0,
  };
}

function readRoute(meta, snap) {
  const mission = snap?.fleet?.mission || {};
  const wps = meta.MISSION?.waypoints || [];
  const count = wps.length || 6;
  let index = isNum(mission.waypointIndex) ? Math.round(mission.waypointIndex) : null;
  if (isNum(index)) index = Math.max(1, Math.min(count, index));
  const wp = index ? wps[index - 1] : null;
  let overall = progressPct(mission.overallProgress);
  if (overall == null && index) overall = ((index - 1) / count) * 100;
  return {
    index,
    count,
    wpId: wp?.id || (index ? `WP-0${index}` : DASH),
    wpName: wp?.name || mission.waypointName || DASH,
    etaSec: mission.etaSec,
    pct: overall,
  };
}

export function createTopbarPanel(ctx) {
  const meta = ctx.meta || {};
  const app = meta.APP || {};
  const operator = app.operator || {};
  const missionMeta = meta.MISSION || {};

  let host = null;
  let root = null;
  const refs = {};
  let lastSnap = null;

  const ic = (name, size = 12, cls = '') => h('span', { class: `topbar-ic${cls ? ` ${cls}` : ''}`, html: ctx.icons.icon(name, size) });

  function buildRouteDots() {
    const count = (meta.MISSION?.waypoints || []).length || 6;
    const wrap = h('div', { class: 'topbar-route-dots' });
    refs.wpDots = [];
    for (let i = 0; i < count; i += 1) {
      const wp = meta.MISSION.waypoints?.[i];
      const dot = h(
        'span',
        { class: 'topbar-wp', title: wp ? `${wp.id} ${wp.name}` : `WP-${pad2(i + 1)}` },
        h('i', { class: 'topbar-wp-node' }),
        i < count - 1 ? h('i', { class: 'topbar-wp-link' }) : null,
      );
      refs.wpDots.push(dot);
      wrap.appendChild(dot);
    }
    return wrap;
  }

  function buildStat(name, label, en, iconName) {
    const valueEl = h('span', { class: 'topbar-stat-v' });
    const el = h(
      'div',
      { class: `topbar-stat topbar-stat--${name}`, title: label },
      ic(iconName, 13, 'topbar-stat-ic'),
      h(
        'span',
        { class: 'topbar-stat-body' },
        h('span', { class: 'topbar-stat-k' }, label, h('em', { text: en })),
        valueEl,
      ),
    );
    return { el, valueEl };
  }

  function build() {
    const link = buildStat('link', '数据链', 'LINK', 'link');
    const gnss = buildStat('gnss', 'GNSS', 'GNSS', 'satellite');
    const sea = buildStat('sea', '海况', 'SEA', 'wave');
    refs.link = link;
    refs.gnss = gnss;
    refs.sea = sea;

    refs.missionName = h('span', { class: 'topbar-mission-name', text: missionMeta.name || DASH });
    refs.missionEn = h('span', { class: 'topbar-mission-en gcs-en', text: missionMeta.en || '' });
    refs.liveDot = h('i', { class: 'gcs-dot gcs-dot--ok is-live' });
    refs.phaseName = h('span', { class: 'topbar-phase-name', text: DASH });
    refs.phaseCount = h('span', { class: 'topbar-phase-count', text: DASH });
    refs.phaseFill = h('i', { class: 'topbar-bar-fill' });
    refs.phasePct = h('span', { class: 'topbar-phase-pct', text: DASH });
    refs.routeWp = h('span', { class: 'topbar-route-wp', text: DASH });
    refs.routeCount = h('b', { text: DASH });
    refs.routePct = h('b', { text: DASH });
    refs.routeSub = h('span', { class: 'topbar-route-sub', text: DASH });
    refs.clock = h('div', { class: 'topbar-clock-time', text: DASH });
    refs.tz = h('span', { text: app.timezone || 'UTC+8' });
    refs.date = h('span', { text: DASH });
    refs.alarmCount = h('b', { class: 'topbar-alarm-count', text: '0' });
    refs.alarm = h(
      'button',
      {
        class: 'topbar-alarm is-idle',
        attrs: { type: 'button' },
        title: '活动告警 · 点击筛选告警事件',
      },
      ic('bell', 14, 'topbar-alarm-ic'),
      h('span', { class: 'topbar-alarm-body' }, refs.alarmCount, h('span', { class: 'topbar-alarm-label', text: '告警' })),
    );
    refs.alarm.addEventListener('click', () => {
      ctx.actions.setLogFilter('alarm');
      ctx.bus.emit('focus-events', 'alarm');
    });

    root = h(
      'div',
      { class: 'topbar', role: 'banner', attrs: { 'aria-label': 'GCS 顶栏' } },
      // ---- left: brand + mission ----
      h(
        'div',
        { class: 'topbar-left' },
        h(
          'div',
          { class: 'topbar-brand' },
          h('span', { class: 'topbar-mark', html: ctx.icons.icon('logo', 26) }),
          h(
            'span',
            { class: 'topbar-wordmark' },
            h('span', { class: 'topbar-name', text: 'OCEAN SWARM' }),
            h('span', { class: 'topbar-sub', text: '无人艇集群上位机 · GCS' }),
          ),
        ),
        h('span', { class: 'topbar-sep' }),
        h(
          'div',
          { class: 'topbar-mission' },
          h('span', { class: 'gcs-chip gcs-chip--accent topbar-mission-chip', text: missionMeta.code || 'M-07' }),
          h(
            'div',
            { class: 'topbar-mission-main' },
            h(
              'div',
              { class: 'topbar-mission-line' },
              refs.missionName,
              refs.missionEn,
              h('span', { class: 'topbar-live' }, refs.liveDot, h('span', { class: 'topbar-live-text', text: 'LIVE' })),
            ),
            h(
              'div',
              { class: 'topbar-mission-line topbar-mission-meta' },
              h('span', { class: 'topbar-label', text: '阶段 PHASE' }),
              refs.phaseName,
              refs.phaseCount,
              h('span', { class: 'topbar-bar' }, refs.phaseFill),
              refs.phasePct,
            ),
          ),
        ),
      ),
      // ---- center: waypoint progress ----
      h(
        'div',
        { class: 'topbar-center' },
        h(
          'div',
          { class: 'topbar-route' },
          buildRouteDots(),
          h(
            'div',
            { class: 'topbar-route-info' },
            h(
              'div',
              { class: 'topbar-route-main' },
              refs.routeWp,
              h('span', { class: 'topbar-sep-text', text: '·' }),
              h('span', { class: 'topbar-route-label' }, '航路 ', refs.routeCount),
              h('span', { class: 'topbar-sep-text', text: '·' }),
              refs.routePct,
            ),
            h('div', { class: 'topbar-route-meta' }, refs.routeSub),
          ),
        ),
      ),
      // ---- right: instruments ----
      h(
        'div',
        { class: 'topbar-right' },
        h('div', { class: 'topbar-stats' }, link.el, gnss.el, sea.el),
        h('span', { class: 'topbar-sep topbar-sep--short' }),
        refs.alarm,
        h('span', { class: 'topbar-sep topbar-sep--short' }),
        h(
          'div',
          { class: 'topbar-clock', title: '指挥台时钟 UTC+8' },
          refs.clock,
          h('div', { class: 'topbar-clock-sub' }, refs.tz, h('span', { text: ' · ' }), refs.date),
        ),
        h(
          'div',
          { class: 'topbar-operator', title: `${operator.rank || '指挥员'} ${operator.name || ''}` },
          h('span', { class: 'topbar-avatar', text: operator.short || '指' }),
          h(
            'span',
            { class: 'topbar-operator-body' },
            h('span', { class: 'topbar-operator-k' }, `${operator.rank || '指挥员'} `, h('em', { text: operator.en || 'OPERATOR' })),
            h('span', { class: 'topbar-operator-v', text: `${operator.name || DASH} · ${operator.role || 'ADMIN'}` }),
          ),
        ),
        h(
          'div',
          { class: 'topbar-tools' },
          h('button', {
            class: 'gcs-btn gcs-btn--ghost gcs-btn--icon topbar-tool',
            attrs: { type: 'button', title: '操作帮助 (?)', 'aria-label': '操作帮助' },
            html: ctx.icons.icon('help', 14),
            on: { click: () => ctx.actions.requestHelp() },
          }),
          h('button', {
            class: 'gcs-btn gcs-btn--ghost gcs-btn--icon topbar-tool',
            attrs: { type: 'button', title: '纯净视景 (H)', 'aria-label': '纯净视景' },
            html: ctx.icons.icon('expand', 14),
            on: { click: () => ctx.actions.toggleClean() },
          }),
        ),
      ),
    );
  }

  function setMission(snap) {
    const phase = readPhase(meta, snap);
    setText(refs.phaseName, phase.name);
    setText(refs.phaseCount, isNum(phase.index) && isNum(phase.count) ? `${pad2(phase.index)}/${pad2(phase.count)}` : DASH);
    const frac = phase.frac == null ? 0 : phase.frac;
    refs.phaseFill.style.width = `${(frac * 100).toFixed(1)}%`;
    setText(refs.phasePct, isNum(phase.frac) ? pct(phase.frac * 100) : DASH);
    refs.phaseName.title = phase.en ? `${phase.name} ${phase.en}` : phase.name;
  }

  function setRoute(snap) {
    const route = readRoute(meta, snap);
    const current = route.index || 0;
    refs.wpDots.forEach((dot, i) => {
      const node = dot.querySelector('.topbar-wp-node');
      const linkEl = dot.querySelector('.topbar-wp-link');
      const ordinal = i + 1;
      setClass(node, 'is-done', current > 0 && ordinal < current);
      setClass(node, 'is-current', current > 0 && ordinal === current);
      setClass(node, 'is-todo', !(current > 0 && ordinal <= current));
      if (linkEl) setClass(linkEl, 'is-done', current > 0 && ordinal < current);
    });
    setText(refs.routeWp, route.wpId);
    setText(refs.routeCount, isNum(route.index) ? `${pad2(route.index)}/${pad2(route.count)}` : DASH);
    setText(refs.routePct, route.pct == null ? DASH : `${Math.round(route.pct)}%`);
    const eta = hms(route.etaSec);
    setText(refs.routeSub, route.etaSec == null ? `${route.wpName}` : `${route.wpName} · ETA ${eta}`);
  }

  function clockText(snap) {
    if (snap && typeof snap.clockText === 'string' && snap.clockText) return snap.clockText;
    const ts = snap && isNum(snap.t) ? snap.t * 1000 : Date.now();
    return ctx.format.clock(ts) || DASH;
  }

  function setInstruments(snap) {
    const fleet = snap?.fleet;
    const link = fleet?.link || {};
    const sea = fleet?.sea || {};
    const total = fleet?.total;

    // link
    const up = link.linksUp;
    const links = link.linksTotal;
    const latency = link.latencyMs;
    const loss = link.lossPct;
    const linkWarn = (isNum(up) && isNum(links) && up < links) || (isNum(latency) && latency > 140) || (isNum(loss) && loss > 2);
    refs.link.valueEl.replaceChildren(
      h('b', { text: isNum(up) || isNum(links) ? `${int(up)}/${int(links)}` : DASH }),
      h('i', { class: 'topbar-stat-unit', text: '·' }),
      h('span', { text: msText(latency) }),
    );
    refs.link.el.classList.toggle('is-warn', linkWarn);
    refs.link.el.title = `数据链 ${int(up)}/${int(links)} · 延时 ${msText(latency)} · 丢包 ${isNum(loss) ? `${loss.toFixed(2)}%` : DASH} · 带宽 ${num1(link.bandwidthMbps)} Mbps`;

    // gnss
    const sats = link.gnssSats;
    const fix = link.gnssFix || DASH;
    refs.gnss.valueEl.replaceChildren(
      h('b', { text: int(sats) }),
      h('i', { class: 'topbar-stat-unit', text: '·' }),
      h('span', { text: fix }),
    );
    refs.gnss.el.classList.toggle('is-warn', isNum(sats) && sats < 6);
    refs.gnss.el.title = `GNSS 卫星 ${int(sats)} · ${fix} · 中继 ${link.relayId || DASH}`;

    // sea
    refs.sea.valueEl.replaceChildren(
      h('b', { text: isNum(sea.state) ? `${int(sea.state)} 级` : DASH }),
      h('i', { class: 'topbar-stat-unit', text: '·' }),
      h('span', { text: isNum(sea.waveHeightM) ? `${sea.waveHeightM.toFixed(1)} m` : DASH }),
    );
    refs.sea.el.classList.toggle('is-warn', isNum(sea.state) && sea.state >= 4);
    refs.sea.el.title = `海况 ${isNum(sea.state) ? `${int(sea.state)} 级` : DASH} · 浪高 ${num1(sea.waveHeightM)} m · 风 ${isNum(sea.windKn) ? `${int(sea.windKn)} kn` : DASH} ${isNum(sea.windDirDeg) ? `${int(sea.windDirDeg)}°` : ''} · 能见度 ${num1(sea.visibilityKm)} km`;

    // heartbeat tone (fleet online ratio + link)
    const online = fleet?.online;
    const onlineAll = isNum(online) && isNum(total) ? online >= total : true;
    refs.liveDot.className = `gcs-dot ${onlineAll && !linkWarn ? 'gcs-dot--ok is-live' : 'gcs-dot--warn is-pulse'}`;
    refs.liveDot.parentElement.title = `集群在线 ${int(online)}/${int(total || (meta.FLEET || []).length)}`;

    // clock
    setText(refs.clock, clockText(snap));
    setText(refs.tz, snap?.timezone || app.timezone || 'UTC+8');
    setText(refs.date, snap?.dateText || DASH);

    // alarms
    const alarms = Array.isArray(snap?.alarms) ? snap.alarms : [];
    let critical = 0;
    for (const a of alarms) if (a && a.severity === 'critical') critical += 1;
    const unacked = typeof ctx.unackedAlarms === 'function' ? ctx.unackedAlarms(snap).length : alarms.length;
    setText(refs.alarmCount, String(alarms.length));
    refs.alarm.classList.remove('is-idle', 'is-warn', 'is-danger');
    if (critical > 0) refs.alarm.classList.add('is-danger');
    else if (alarms.length > 0) refs.alarm.classList.add('is-warn');
    else refs.alarm.classList.add('is-idle');
    refs.alarm.title = alarms.length
      ? `活动告警 ${alarms.length}（严重 ${critical}） · 未签收 ${unacked} · 点击筛选告警事件`
      : '当前无活动告警 · 点击筛选告警事件';
  }

  function clockText(snap) {
    if (snap && typeof snap.clockText === 'string' && snap.clockText) return snap.clockText;
    const ts = snap && isNum(snap.t) ? snap.t * 1000 : Date.now();
    return ctx.format.clock(ts) || DASH;
  }

  function update(snap) {
    if (!root) return;
    lastSnap = snap || lastSnap;
    const current = lastSnap;
    if (!current) {
      setMission(null);
      setRoute(null);
      setInstruments(null);
      return;
    }
    setMission(current);
    setRoute(current);
    setInstruments(current);
  }

  return {
    name: 'topbar',
    mount(hostEl) {
      host = hostEl;
      build();
      host.appendChild(root);
      update(ctx.getSnapshot ? ctx.getSnapshot() : null);
      // first paint fallback so the beam is never empty before the first snapshot
      setText(refs.clock, ctx.format.clock(Date.now()));
      setText(refs.date, ctx.format.date(Date.now()));
    },
    update,
    frame() {},
  };
}
