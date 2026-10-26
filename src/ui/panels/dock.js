// =============================================================================
// DOCK — the duty officer's watch floor (design §7.4).
//
// Left: live event stream (filter chips, unread / unacknowledged counters, auto
// follow with scroll-up pause, incremental row append, click-to-select source).
// Right: command console (last acknowledgement, monospace input, suggestion
// chips, ↑↓ history, Tab completion, error line). Parsing lives in
// src/ui/console-parser.js; execution always goes through ctx.actions /
// ctx.dispatch so the console never touches the scene directly.
// =============================================================================
import { h, setText, setClass } from '../dom.js';
import { parseConsole, completeConsole, CONSOLE_SUGGESTIONS } from '../console-parser.js';
import '../styles/dock.css';

const DASH = '—';
const MAX_ROWS = 60;
const PENDING_TIMEOUT_MS = 5200;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const SEVERITY_ORDER = { critical: 0, warning: 1, command: 2, success: 3, info: 4 };
const CATEGORY_EN = { command: 'CMD', alarm: 'ALM', mission: 'MSN', link: 'LNK', system: 'SYS' };
const FILTER_KEYS = ['all', 'command', 'alarm', 'mission', 'link'];

function fmtMs(value) {
  if (!isNum(value)) return DASH;
  if (value >= 1000) return `${(value / 1000).toFixed(2)} s`;
  return `${Math.round(value)} ms`;
}

function ackLatencyText(ack) {
  if (!ack) return DASH;
  if (typeof ack.latencyText === 'string' && ack.latencyText) return ack.latencyText;
  return fmtMs(ack.latencyMs);
}

export function createDockPanel(ctx) {
  const meta = ctx.meta || {};
  const categories = meta.EVENT_CATEGORIES || {};

  const state = {
    filter: ctx.state.logFilter || 'all',
    follow: true,
    unread: 0,
    snap: null,
    renderedIds: new Set(),
    rows: [],
    lastAckId: null,
    pending: null,
    pendingTimer: 0,
    history: [],
    historyIndex: -1,
    draft: '',
    completeCycle: null,
  };

  let host = null;
  let eventsPanel = null;
  let consolePanel = null;
  const refs = {};
  const disposers = [];

  // ===========================================================================
  // event stream
  // ===========================================================================
  function buildEventsPanel() {
    refs.unread = h('span', { class: 'dock-unread', attrs: { hidden: '' } });
    refs.unreadDot = h('i', { class: 'dock-unread-dot' });
    refs.unreadCount = h('b', { text: '0' });
    refs.unread.append(refs.unreadDot, h('span', { text: '未读' }), refs.unreadCount);

    refs.ackAll = h('button', {
      class: 'gcs-btn gcs-btn--sm gcs-btn--ghost dock-ackall',
      attrs: { type: 'button', title: '签收全部活动告警', hidden: '' },
    });
    refs.ackAll.innerHTML = `<span class="dock-ackall-label">签收全部</span><b>0</b>`;
    refs.ackAllCount = refs.ackAll.querySelector('b');
    refs.ackAll.addEventListener('click', () => {
      ctx.actions.ackAllAlarms();
      flashPanel(eventsPanel, 'is-focus');
    });

    const filters = h('div', { class: 'dock-filters', attrs: { role: 'group', 'aria-label': '事件过滤' } });
    refs.filterChips = new Map();
    for (const key of FILTER_KEYS) {
      const label = categories[key] || key;
      const chip = h('button', {
        class: `gcs-chip dock-filter${key === state.filter ? ' is-active' : ''}`,
        attrs: { type: 'button', 'data-filter': key, title: `只看${label}事件` },
        text: label,
        on: {
          click: () => ctx.actions.setLogFilter(key),
        },
      });
      refs.filterChips.set(key, chip);
      filters.appendChild(chip);
    }

    refs.list = h('div', { class: 'dock-ev-list', attrs: { role: 'log', 'aria-live': 'polite', 'aria-label': '实时事件流' } });
    refs.empty = h('div', { class: 'dock-ev-empty', attrs: { hidden: '' } });
    refs.emptyText = h('span', { class: 'dock-ev-empty-text', text: '等待事件…' });
    refs.empty.append(h('i', { class: 'dock-ev-empty-mark' }), refs.emptyText);
    refs.list.appendChild(refs.empty);

    refs.follow = h('button', {
      class: 'dock-follow',
      attrs: { type: 'button', title: '滚动到最新事件', hidden: '' },
    });
    refs.follow.innerHTML = `${ctx.icons.icon('chevron-down', 11)}<span>回到最新</span><b>0</b>`;
    refs.followCount = refs.follow.querySelector('b');
    refs.follow.addEventListener('click', () => setFollowing(true));

    refs.evBody = h('div', { class: 'gcs-panel-body gcs-panel-body--flush dock-ev-body' }, refs.list, refs.follow);

    refs.list.addEventListener('scroll', onEventScroll, { passive: true });

    eventsPanel = h(
      'section',
      { class: 'gcs-panel dock-events' },
      h(
        'header',
        { class: 'gcs-panel-head dock-ev-head' },
        h('span', { class: 'gcs-panel-index', text: '05' }),
        h('h2', { class: 'gcs-panel-title' }, '实时事件 ', h('em', { text: 'EVENT STREAM' })),
        filters,
        h('div', { class: 'dock-ev-counters' }, refs.unread, refs.ackAll),
      ),
      refs.evBody,
    );
  }

  function flashPanel(panel, cls) {
    if (!panel) return;
    panel.classList.remove(cls);
    // force a reflow so the animation can restart on rapid clicks
    void panel.offsetWidth;
    panel.classList.add(cls);
    setTimeout(() => panel.classList.remove(cls), 900);
  }

  function onEventScroll() {
    const el = refs.list;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 10;
    if (nearBottom && !state.follow) setFollowing(true);
    else if (!nearBottom && state.follow) setFollowing(false);
  }

  function scrollToLatest() {
    const el = refs.list;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }

  function setFollowing(follow) {
    state.follow = !!follow;
    if (state.follow) {
      state.unread = 0;
      scrollToLatest();
    }
    updateCounters();
  }

  function matchesFilter(ev) {
    if (state.filter === 'all') return true;
    return ev && ev.category === state.filter;
  }

  function eventMeta(ev) {
    if (!ev) return DASH;
    if (isNum(ev.ackMs)) return fmtMs(ev.ackMs);
    return CATEGORY_EN[ev.category] || DASH;
  }

  /** Source chip: short label + a micro tint by source class (design §7.4). */
  function sourceChip(ev) {
    const vessel = ev.sourceId && meta.FLEET_BY_ID ? meta.FLEET_BY_ID.get(ev.sourceId) : null;
    let tone = 'is-system';
    let label = ev.sourceLabel || '系统';
    let colorVar = 'var(--gcs-text-3)';
    if (vessel) {
      tone = 'is-vessel';
      label = vessel.callSign || vessel.name || label;
      colorVar = `var(--gcs-type-${vessel.type})`;
    } else {
      const text = String(ev.sourceLabel || '');
      if (text.includes('指挥')) {
        tone = 'is-cmd';
        colorVar = 'var(--gcs-command)';
      } else if (text.includes('链路') || text.includes('数据')) {
        tone = 'is-link';
        colorVar = 'var(--gcs-accent-2)';
      } else if (text.includes('任务')) {
        tone = 'is-mission';
        colorVar = 'var(--gcs-gold)';
      }
      label = text || '系统';
    }
    const chip = h('span', {
      class: `gcs-chip dock-ev-source ${tone}`,
      text: label,
      attrs: { title: ev.sourceLabel || label },
    });
    chip.style.setProperty('--dock-src', colorVar);
    return chip;
  }

  function createRow(ev) {
    const severity = Object.prototype.hasOwnProperty.call(SEVERITY_ORDER, ev.severity) ? ev.severity : 'info';
    const row = h('div', {
      class: `gcs-row dock-ev dock-ev--${severity}`,
      dataset: { id: String(ev.id || ''), severity, category: String(ev.category || '') },
      attrs: {
        role: 'listitem',
        title: [ev.clockText, ev.sourceLabel, ev.text, ev.detail].filter(Boolean).join(' · '),
        tabindex: ev.sourceId && meta.FLEET_BY_ID && meta.FLEET_BY_ID.has(ev.sourceId) ? '0' : '-1',
      },
    });
    if (ev.sourceId && meta.FLEET_BY_ID && meta.FLEET_BY_ID.has(ev.sourceId)) {
      row.classList.add('is-clickable');
      row.addEventListener('click', () => ctx.actions.selectVessel(ev.sourceId));
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          ctx.actions.selectVessel(ev.sourceId);
        }
      });
    }
    row.append(
      h('span', { class: 'dock-ev-time', text: ev.clockText || DASH }),
      h('i', { class: 'dock-ev-bar', attrs: { 'aria-hidden': 'true' } }),
      sourceChip(ev),
      h('span', { class: 'dock-ev-text', text: ev.text || '' }),
      h('span', { class: 'dock-ev-meta', text: eventMeta(ev) }),
    );
    return row;
  }

  function clearRows() {
    for (const row of state.rows) row.remove();
    state.rows = [];
    state.renderedIds.clear();
  }

  function appendRow(ev, isNew) {
    if (!ev || !ev.id) return;
    if (refs.empty && refs.empty.isConnected) refs.empty.hidden = true;
    const row = createRow(ev);
    if (isNew) row.classList.add('is-new');
    refs.list.appendChild(row);
    state.rows.push(row);
    state.renderedIds.add(ev.id);
    if (isNew) {
      setTimeout(() => row.classList.remove('is-new'), 620);
    }
  }

  function trimRows() {
    while (state.rows.length > MAX_ROWS) {
      const row = state.rows.shift();
      const id = row.dataset.id;
      if (id) state.renderedIds.delete(id);
      row.remove();
    }
  }

  function rebuildEvents() {
    if (!refs.list) return;
    clearRows();
    const events = Array.isArray(state.snap?.events) ? state.snap.events : [];
    const filtered = [];
    for (const ev of events) if (matchesFilter(ev)) filtered.push(ev);
    // snapshot is newest-first: take the newest MAX_ROWS then render oldest→newest
    const slice = filtered.slice(0, MAX_ROWS).reverse();
    for (const ev of slice) appendRow(ev, false);
    if (refs.empty) {
      refs.empty.hidden = slice.length > 0;
      if (!slice.length) {
        refs.emptyText.textContent = state.filter === 'all' ? '等待事件…' : `暂无${categories[state.filter] || ''}事件`;
      }
    }
    if (state.follow) scrollToLatest();
    updateCounters();
  }

  function updateEvents(snap) {
    const events = Array.isArray(snap?.events) ? snap.events : [];
    const filtered = [];
    for (const ev of events) if (matchesFilter(ev)) filtered.push(ev);

    // rebuild when the DOM no longer represents the filter window
    if (state.rows.length === 0 && filtered.length > 0) {
      rebuildEvents();
      return;
    }

    let added = 0;
    // walk oldest → newest so appended rows stay in chronological order
    for (let i = filtered.length - 1; i >= 0; i -= 1) {
      const ev = filtered[i];
      if (!ev || !ev.id || state.renderedIds.has(ev.id)) continue;
      appendRow(ev, true);
      added += 1;
    }
    if (added > 0) {
      trimRows();
      if (state.follow) {
        scrollToLatest();
        state.unread = 0;
      } else {
        state.unread += added;
      }
      updateCounters();
    }
  }

  function updateCounters() {
    if (!refs.unread) return;
    const unread = state.unread;
    refs.unread.hidden = unread <= 0;
    setText(refs.unreadCount, String(unread));
    refs.follow.hidden = state.follow;
    setText(refs.followCount, String(unread));

    const snap = state.snap;
    const unacked = typeof ctx.unackedAlarms === 'function' && snap ? ctx.unackedAlarms(snap).length : 0;
    refs.ackAll.hidden = unacked <= 0;
    setText(refs.ackAllCount, String(unacked));
    refs.ackAll.title = unacked > 0 ? `签收全部 ${unacked} 条活动告警` : '当前无未签收告警';
  }

  function syncFilterChips() {
    for (const [key, chip] of refs.filterChips) setClass(chip, 'is-active', key === state.filter);
  }

  function applyFilter(kind) {
    const next = FILTER_KEYS.includes(kind) ? kind : 'all';
    if (next === state.filter) {
      syncFilterChips();
      return;
    }
    state.filter = next;
    state.unread = 0;
    state.follow = true;
    syncFilterChips();
    rebuildEvents();
  }

  // ===========================================================================
  // command console
  // ===========================================================================
  function buildConsolePanel() {
    refs.ackBadge = h('span', { class: 'dock-ack-badge' });
    refs.ackText = h('span', { class: 'dock-ack-text', text: '等待指令' });
    refs.ackSub = h('span', { class: 'dock-ack-sub', text: '指令下发后将在此显示执行结果' });
    refs.ackLat = h('span', { class: 'dock-ack-lat', text: DASH });
    refs.ack = h(
      'div',
      { class: 'dock-ack is-empty', attrs: { 'aria-live': 'polite' } },
      refs.ackBadge,
      h('div', { class: 'dock-ack-main' }, refs.ackText, refs.ackSub),
      refs.ackLat,
    );

    refs.input = h('input', {
      class: 'dock-input',
      attrs: {
        type: 'text',
        spellcheck: 'false',
        autocomplete: 'off',
        autocapitalize: 'off',
        placeholder: '输入指令 · 编队 楔形 / formation wedge',
        'aria-label': '指令输入',
      },
    });
    refs.input.addEventListener('keydown', onInputKeyDown);
    refs.input.addEventListener('input', () => clearMessage());

    refs.send = h('button', {
      class: 'gcs-btn gcs-btn--ghost gcs-btn--icon dock-send',
      attrs: { type: 'button', title: '执行指令 (Enter)', 'aria-label': '执行指令' },
      html: ctx.icons.icon('send', 14),
      on: { click: () => submitConsole() },
    });

    refs.prompt = h('span', { class: 'dock-prompt', text: '▸' });

    const inputRow = h(
      'div',
      { class: 'dock-input-row' },
      refs.prompt,
      h('div', { class: 'dock-input-wrap' }, refs.input),
      refs.send,
    );

    refs.msgText = h('span', { class: 'dock-msg-text' });
    refs.msgHint = h('span', { class: 'dock-msg-hint', text: 'Enter 执行 · Tab 补全 · ↑↓ 历史' });
    refs.msg = h('div', { class: 'dock-con-msg' }, refs.msgText, refs.msgHint);

    const suggest = h('div', { class: 'dock-suggest' }, h('span', { class: 'dock-suggest-label', text: '建议' }));
    for (const item of CONSOLE_SUGGESTIONS) {
      suggest.appendChild(
        h('button', {
          class: 'gcs-chip dock-suggest-chip',
          attrs: { type: 'button', title: '点击填入指令' },
          text: item.label,
          on: {
            click: () => {
              refs.input.value = item.text;
              refs.input.focus();
              const len = refs.input.value.length;
              try {
                refs.input.setSelectionRange(len, len);
              } catch {
                /* ignore */
              }
              clearMessage();
            },
          },
        }),
      );
    }

    refs.stateDot = h('i', { class: 'dock-con-dot' });
    refs.stateText = h('span', { text: '就绪' });
    refs.conState = h('span', { class: 'dock-con-state' }, refs.stateDot, refs.stateText);

    consolePanel = h(
      'section',
      { class: 'gcs-panel dock-console' },
      h(
        'header',
        { class: 'gcs-panel-head dock-con-head' },
        h('span', { class: 'gcs-panel-index', text: '06' }),
        h('h2', { class: 'gcs-panel-title' }, '指令台 ', h('em', { text: 'COMMAND' })),
        refs.conState,
      ),
      h(
        'div',
        { class: 'gcs-panel-body gcs-panel-body--flush dock-con-body' },
        refs.ack,
        inputRow,
        refs.msg,
        suggest,
      ),
    );
  }

  function setConsoleState(kind, text) {
    if (!refs.conState) return;
    refs.conState.dataset.state = kind;
    setText(refs.stateText, text);
  }

  function renderEmptyAck() {
    refs.ack.className = 'dock-ack is-empty';
    refs.ackBadge.replaceChildren(h('span', { text: 'ACK' }));
    setText(refs.ackText, '等待指令');
    setText(refs.ackSub, '指令下发后将在此显示执行结果');
    setText(refs.ackLat, DASH);
    setConsoleState('idle', '就绪');
  }

  function renderPending() {
    const pending = state.pending;
    if (!pending) return;
    refs.ack.className = 'dock-ack is-pending';
    refs.ackBadge.replaceChildren(h('i', { class: 'dock-ack-spin' }));
    setText(refs.ackText, '指令已下发 · 等待回执…');
    setText(refs.ackSub, pending.label || pending.text || '');
    setText(refs.ackLat, '···');
    setConsoleState('pending', '等待回执');
  }

  function renderAck(ack) {
    if (!ack) {
      renderEmptyAck();
      return;
    }
    const ok = ack.ok !== false;
    refs.ack.className = `dock-ack ${ok ? 'is-ok' : 'is-fail'}`;
    refs.ackBadge.replaceChildren(
      h('span', { class: 'dock-ack-icon', html: ctx.icons.icon(ok ? 'check' : 'close', 12) }),
    );
    setText(refs.ackText, ack.text || (ok ? '指令已执行' : '指令被拒绝'));
    setText(refs.ackSub, [ack.commandText, ack.clockText].filter(Boolean).join(' · ') || DASH);
    setText(refs.ackLat, ackLatencyText(ack));
    setConsoleState(ok ? 'ok' : 'fail', ok ? '执行成功' : '指令被拒绝');
    flashPanel(consolePanel, ok ? 'is-acked' : 'is-denied');
  }

  function clearPending() {
    state.pending = null;
    clearTimeout(state.pendingTimer);
    state.pendingTimer = 0;
  }

  function setPending(label, text) {
    clearPending();
    state.pending = { label, text, at: performance.now() };
    renderPending();
    state.pendingTimer = setTimeout(() => {
      if (!state.pending) return;
      failPending('未收到回执，请检查数据链状态');
    }, PENDING_TIMEOUT_MS);
  }

  function failPending(message) {
    if (!state.pending) return;
    const label = state.pending.label;
    clearPending();
    refs.ack.className = 'dock-ack is-pending is-stale';
    refs.ackBadge.replaceChildren(h('span', { class: 'dock-ack-icon', html: ctx.icons.icon('warning', 12) }));
    setText(refs.ackText, message);
    setText(refs.ackSub, label || '');
    setText(refs.ackLat, DASH);
    setConsoleState('stale', '回执超时');
    showMessage(message, 'error');
  }

  function showMessage(text, kind = 'hint') {
    if (!refs.msg) return;
    refs.msg.dataset.kind = kind;
    setText(refs.msgText, text || '');
    setText(refs.msgHint, kind === 'error' ? 'Esc 清空' : 'Enter 执行 · Tab 补全 · ↑↓ 历史');
    setClass(refs.input, 'is-error', kind === 'error');
    if (refs.msgText) {
      refs.msg.hidden = !text;
    }
  }

  function clearMessage() {
    if (!refs.msg) return;
    refs.msg.hidden = true;
    refs.msgText.textContent = '';
    refs.msg.dataset.kind = '';
    setClass(refs.input, 'is-error', false);
  }

  function pushHistory(text) {
    if (!text) return;
    if (state.history[state.history.length - 1] !== text) state.history.push(text);
    if (state.history.length > 40) state.history.shift();
    state.historyIndex = -1;
    state.draft = '';
  }

  function navHistory(delta) {
    const input = refs.input;
    if (!state.history.length) return;
    if (state.historyIndex === -1) {
      state.draft = input.value;
      state.historyIndex = delta < 0 ? state.history.length - 1 : -1;
    } else {
      state.historyIndex += delta;
    }
    if (state.historyIndex < -1) state.historyIndex = -1;
    if (state.historyIndex >= state.history.length) state.historyIndex = state.history.length - 1;
    if (state.historyIndex === -1) {
      input.value = state.draft;
    } else {
      input.value = state.history[state.historyIndex];
    }
    const len = input.value.length;
    try {
      input.setSelectionRange(len, len);
    } catch {
      /* ignore */
    }
  }

  function doComplete() {
    const result = completeConsole(refs.input.value);
    if (!result || !result.candidates || !result.candidates.length) {
      showMessage('无匹配补全', 'hint');
      return;
    }
    refs.input.value = result.value;
    const len = refs.input.value.length;
    try {
      refs.input.setSelectionRange(len, len);
    } catch {
      /* ignore */
    }
    clearMessage();
    if (result.candidates.length > 1) {
      showMessage(`可用：${result.candidates.slice(0, 6).join(' · ')}`, 'hint');
    }
  }

  function clearConsoleLocal() {
    state.history.length = 0;
    state.historyIndex = -1;
    state.draft = '';
    refs.input.value = '';
    clearMessage();
    clearPending();
    renderEmptyAck();
    showMessage('指令台已清空', 'hint');
    refs.input.focus();
  }

  function submitConsole() {
    if (!refs.input) return;
    const raw = refs.input.value;
    const text = raw.trim();
    if (!text) {
      showMessage('请输入指令', 'hint');
      refs.input.focus();
      return;
    }
    pushHistory(text);
    const parsed = parseConsole(text, ctx);
    if (!parsed.ok) {
      showMessage(parsed.hint ? `${parsed.message} · ${parsed.hint}` : parsed.message, 'error');
      state.historyIndex = -1;
      return;
    }
    clearMessage();
    refs.input.value = '';
    if (parsed.id === 'clear') {
      clearConsoleLocal();
      return;
    }
    setPending(parsed.label || text, text);
    let result;
    try {
      result = parsed.run(ctx);
    } catch (err) {
      console.error('[gcs:dock] console command failed', err);
      failPending('指令执行异常，请查看控制台');
      return;
    }
    if (result && typeof result.then === 'function') {
      result
        .then((res) => {
          if (res === false) failPending('指令已取消');
        })
        .catch((err) => {
          console.error('[gcs:dock] console command rejected', err);
          failPending('指令执行异常，请查看控制台');
        });
    } else if (result && result.accepted === false) {
      failPending(result.error || '指令被拒绝');
    }
    refs.input.focus();
  }

  function onInputKeyDown(ev) {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      submitConsole();
      return;
    }
    if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      navHistory(-1);
      return;
    }
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      navHistory(1);
      return;
    }
    if (ev.key === 'Tab') {
      ev.preventDefault();
      doComplete();
      return;
    }
    if (ev.key === 'Escape') {
      ev.preventDefault();
      if (refs.input.value) {
        refs.input.value = '';
        state.historyIndex = -1;
        clearMessage();
      } else {
        refs.input.blur();
      }
    }
  }

  function focusConsole() {
    if (!refs.input) return;
    refs.input.focus({ preventScroll: true });
    const len = refs.input.value.length;
    try {
      refs.input.setSelectionRange(len, len);
    } catch {
      /* ignore */
    }
  }

  function updateConsole(snap) {
    const acks = Array.isArray(snap?.acks) ? snap.acks : [];
    const ack = acks[0] || null;
    if (!ack) {
      if (!state.pending) renderEmptyAck();
      return;
    }
    if (ack.id !== state.lastAckId) {
      state.lastAckId = ack.id;
      clearPending();
      renderAck(ack);
    } else if (!state.pending && refs.ack.classList.contains('is-empty')) {
      renderAck(ack);
    }
    setText(refs.ackLat, ackLatencyText(ack));
  }

  // ===========================================================================
  // public panel API
  // ===========================================================================
  return {
    name: 'dock',

    mount(hostEl) {
      host = hostEl;
      state.filter = ctx.state.logFilter || 'all';
      buildEventsPanel();
      buildConsolePanel();
      host.appendChild(eventsPanel);
      host.appendChild(consolePanel);
      syncFilterChips();
      clearMessage();
      if (refs.msg) refs.msg.hidden = true;
      renderEmptyAck();

      disposers.push(ctx.bus.on('filter', (kind) => applyFilter(kind)));
      disposers.push(
        ctx.bus.on('focus-events', () => {
          setFollowing(true);
          flashPanel(eventsPanel, 'is-focus');
          if (refs.list) refs.list.scrollTop = 0;
        }),
      );
      disposers.push(ctx.bus.on('focus-console', focusConsole));

      const initialSnap = ctx.getSnapshot ? ctx.getSnapshot() : null;
      if (initialSnap) {
        state.snap = initialSnap;
        updateEvents(initialSnap);
        updateCounters();
        updateConsole(initialSnap);
      }
    },

    update(snap) {
      if (!snap) return;
      state.snap = snap;
      updateEvents(snap);
      updateCounters();
      updateConsole(snap);
    },

    frame() {},

    destroy() {
      for (const off of disposers.splice(0)) {
        try {
          off();
        } catch {
          /* ignore */
        }
      }
      clearTimeout(state.pendingTimer);
    },
  };
}
