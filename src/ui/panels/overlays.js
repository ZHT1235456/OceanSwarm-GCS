// =============================================================================
// OVERLAYS — boot sequence, confirmation modal, help and toast stack.
//
// This module owns the boot gate: the console is only declared ready once the
// opening animation has finished (ctx.markBooted()). It also replaces the
// fallback ctx.dialog implementation created in context.js, so every other
// panel / action obtains the real confirm / toast / help / closeAll services.
//
// Contract highlights:
//   ctx.dialog.confirm(opts) → Promise<boolean>
//   opts = { title, message, detail, confirmText, cancelText, danger, holdMs }
//   - danger defaults to a 1.2 s press-and-hold confirm with a progress ring;
//   - Esc / backdrop click / cancel resolve false, but never twice.
//   ctx.dialog.toast({ severity, title, message, ttl }) → stacked top-right.
//   ctx.dialog.help(true|false) → shortcut sheet (meta.KEYBOARD, two columns).
//   ctx.dialog.skipBoot() → dissolve the boot gate immediately.
//   ctx.dialog.closeAll() → dismiss confirm + help (toasts expire on their own).
//   ctx.state.dialogOpen mirrors whether a modal layer is on screen.
//
// Keyboard ownership: while boot or a modal is up this module captures keydown
// in the capture phase and stops propagation, so the global console shortcuts
// can never fire behind an overlay. Esc always closes, Enter / Space confirm.
// =============================================================================
import { h, setText, setClass } from '../dom.js';
import '../styles/overlays.css';

const BOOT_MS = 2400;
const BOOT_EXIT_MS = 460;
const BOOT_LOGS = [
  { at: 0.34, text: '初始化三维视景…' },
  { at: 0.98, text: '接入集群数据链…' },
  { at: 1.64, text: '同步任务数据与指令总线…' },
];
const MAX_TOASTS = 3;
const TOAST_TTL = 3200;
const TOAST_EXIT_MS = 260;
const RING_RADIUS = 9;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
const SEVERITY_ICON = {
  info: 'info',
  success: 'check',
  warning: 'warning',
  critical: 'critical',
  command: 'send',
  accent: 'info',
};
const MODAL_KEYS = new Set(['Escape', 'Enter', ' ', 'Spacebar']);

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const reducedMotion = () => {
  try {
    return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
};
const esc = (value) => String(value == null ? '' : value);

/** "1 – 5", "Shift + 1/2/3", "F" … for the help sheet key caps. */
function keySeparator(row, index) {
  if (index <= 0) return null;
  const first = row.keys[0] || '';
  const second = row.keys[1] || '';
  if (/^\d$/.test(first) && /^\d$/.test(second)) return '–';
  if (['Shift', 'Ctrl', 'Alt', 'Cmd'].includes(first)) return '+';
  return '';
}

export function createOverlaysPanel(ctx) {
  const meta = ctx.meta || {};
  const app = meta.APP || {};
  const icons = ctx.icons;
  const bus = ctx.bus;
  const dialog = ctx.dialog;

  let host = null;
  let bootEl = null;
  let bootFill = null;
  let bootPct = null;
  let bootState = null;
  let bootLogEls = [];
  let bootStart = 0;
  let bootRaf = 0;
  let bootFallbackTimer = 0;
  let bootDone = false;
  let bootNotified = false;
  let toastStack = null;
  let confirmState = null;
  let helpState = null;
  let lastSnap = null;
  const toasts = []; // { el, timer }
  const seenAlarmIds = new Set();
  const seenAckIds = new Set();
  let alarmsSeeded = false;
  let acksSeeded = false;
  const disposers = [];

  if (icons == null) throw new Error('[gcs:overlays] ctx.icons missing');

  // ===========================================================================
  // boot gate
  // ===========================================================================
  function notifyBooted() {
    if (bootNotified) return;
    if (typeof ctx.markBooted === 'function') {
      bootNotified = true;
      try {
        ctx.markBooted();
      } catch (err) {
        bootNotified = false;
        console.error('[gcs:overlays] markBooted failed', err);
      }
      return;
    }
    // index.js assigns ctx.markBooted after the mount loop — retry just after.
    setTimeout(notifyBooted, 30);
  }

  function buildBoot() {
    const logItems = BOOT_LOGS.map(
      (line) =>
        `<li class="ovl-boot-log"><i class="ovl-boot-log-mark"></i><span class="ovl-boot-log-text">${esc(line.text)}</span></li>`,
    ).join('');
    bootEl = h('div', {
      class: 'ovl-boot',
      attrs: { role: 'status', 'aria-live': 'polite', 'aria-label': '系统启动' },
      on: { click: () => finishBoot(true) },
    });
    bootEl.innerHTML = `
      <div class="ovl-boot-atmos" aria-hidden="true"></div>
      <div class="ovl-boot-frame" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
      <div class="ovl-boot-hud ovl-boot-hud--tl">
        <span class="ovl-boot-live"><i></i>OFFLINE SECURE LINK</span>
        <span class="ovl-boot-hud-line">LOCAL NODE // 127.0.0.1</span>
      </div>
      <div class="ovl-boot-hud ovl-boot-hud--tr">
        <span>GCS v${esc(app.version || '2.0.0')}</span>
        <span class="ovl-boot-hud-line">BUILD ${esc(app.build || '2026.10')}</span>
      </div>
      <div class="ovl-boot-center">
        <div class="ovl-boot-emblem">
          <span class="ovl-boot-emblem-ring" aria-hidden="true"></span>
          <span class="ovl-boot-emblem-ring ovl-boot-emblem-ring--2" aria-hidden="true"></span>
          <span class="ovl-boot-emblem-icon">${icons.icon('logo', 74)}</span>
        </div>
        <div class="ovl-boot-title">OCEAN SWARM</div>
        <div class="ovl-boot-rule" aria-hidden="true"><i></i></div>
        <div class="ovl-boot-sub">无人艇集群指挥控制系统 · GCS</div>
        <div class="ovl-boot-progress" aria-hidden="true"><i class="ovl-boot-progress-fill"></i></div>
        <div class="ovl-boot-status">
          <span class="ovl-boot-pct">00%</span>
          <span class="ovl-boot-state">正在初始化指挥台</span>
        </div>
        <ul class="ovl-boot-logs">${logItems}</ul>
      </div>
      <div class="ovl-boot-foot">
        <span>指挥控制终端 · 离线部署</span>
        <span class="ovl-boot-skip">点击任意位置跳过</span>
      </div>
    `;
    bootFill = bootEl.querySelector('.ovl-boot-progress-fill');
    bootPct = bootEl.querySelector('.ovl-boot-pct');
    bootState = bootEl.querySelector('.ovl-boot-state');
    bootLogEls = Array.from(bootEl.querySelectorAll('.ovl-boot-log'));
  }

  function startBoot() {
    if (!bootEl) return;
    if (ctx.state.skipIntro || reducedMotion()) {
      finishBoot(true);
      return;
    }
    bootStart = performance.now();
    bootRaf = requestAnimationFrame(tickBoot);
    // Background tabs throttle rAF — never leave the gate closed on a stalled tab.
    bootFallbackTimer = setTimeout(() => finishBoot(false), BOOT_MS + 900);
  }

  function tickBoot(now) {
    if (bootDone || !bootEl) return;
    const t = Math.max(0, (typeof now === 'number' ? now : performance.now()) - bootStart);
    const progress = Math.min(1, t / BOOT_MS);
    bootFill.style.transform = `scaleX(${Math.max(0.005, progress).toFixed(4)})`;
    setText(bootPct, `${String(Math.round(progress * 100)).padStart(2, '0')}%`);
    for (let i = 0; i < bootLogEls.length; i += 1) {
      if (t / 1000 >= BOOT_LOGS[i].at) bootLogEls[i].classList.add('is-on');
    }
    if (bootState) {
      if (progress >= 1) setText(bootState, '指挥台就绪');
      else if (progress >= 0.66) setText(bootState, '同步任务数据');
      else if (progress >= 0.3) setText(bootState, '接入集群数据链');
      else setText(bootState, '初始化三维视景');
    }
    if (progress < 1) bootRaf = requestAnimationFrame(tickBoot);
    else finishBoot(false);
  }

  /** Close the boot gate; resolves the READY promise through ctx.markBooted(). */
  function finishBoot(instant) {
    if (bootDone) return;
    bootDone = true;
    cancelAnimationFrame(bootRaf);
    clearTimeout(bootFallbackTimer);
    notifyBooted();
    const el = bootEl;
    bootEl = null;
    if (!el) return;
    if (instant || reducedMotion()) {
      el.remove();
      return;
    }
    el.classList.add('is-out');
    setTimeout(() => el.remove(), BOOT_EXIT_MS + 40);
  }

  // ===========================================================================
  // modal plumbing
  // ===========================================================================
  function syncDialogOpen() {
    ctx.state.dialogOpen = !!(confirmState || helpState);
  }

  function closeAll() {
    if (confirmState) confirmState.finish(false);
    if (helpState) closeHelp();
  }

  // ===========================================================================
  // confirmation modal
  // ===========================================================================
  function openConfirm(options = {}) {
    if (confirmState) confirmState.finish(false);
    return new Promise((resolve) => {
      const danger = !!options.danger;
      const requestedHold = isNum(options.holdMs) ? options.holdMs : 0;
      const holdMs = options.holdMs === 0 ? 0 : Math.max(0, Math.min(5000, requestedHold || (danger ? 1200 : 0)));
      const isAlert = !!options._alert;
      const title = esc(options.title) || (isAlert ? '提示' : danger ? '确认危险操作' : '确认操作');
      const message = esc(options.message);
      const details = Array.isArray(options.detail) ? options.detail : options.detail ? [options.detail] : [];
      const confirmText = esc(options.confirmText) || (isAlert ? '知道了' : holdMs > 0 ? '长按确认' : '确认');
      const cancelText = options.cancelText === null || isAlert ? null : esc(options.cancelText) || '取消';

      const scrim = h('div', {
        class: 'ovl-scrim',
        dataset: { overlay: 'confirm' },
        on: {
          click: (ev) => {
            if (ev.target === scrim) finish(false);
          },
        },
      });

      const closeBtn = h('button', {
        class: 'ovl-icon-btn ovl-dialog-close',
        attrs: { type: 'button', 'aria-label': '关闭' },
        html: icons.icon('close', 13),
        on: { click: () => finish(false) },
      });

      const panel = h('div', {
        class: `ovl-dialog${danger ? ' ovl-dialog--danger' : ''}${isAlert ? ' ovl-dialog--alert' : ''}`,
        attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      });

      const head = h(
        'div',
        { class: 'ovl-dialog-head' },
        h('span', { class: 'ovl-dialog-icon', html: icons.icon(danger ? 'critical' : 'info', 20) }),
        h(
          'div',
          { class: 'ovl-dialog-titles' },
          h('div', {
            class: 'ovl-dialog-kicker',
            text: isAlert ? 'NOTICE · 提示' : danger ? 'DANGER · 危险操作' : 'CONFIRM · 操作确认',
          }),
          h('h2', { class: 'ovl-dialog-title', text: title }),
        ),
        closeBtn,
      );

      const body = h('div', { class: 'ovl-dialog-body' });
      if (message) body.appendChild(h('p', { class: 'ovl-dialog-msg', text: message }));
      if (details.length) {
        body.appendChild(h('ul', { class: 'ovl-dialog-list' }, details.map((d) => h('li', { text: esc(d) }))));
      }

      const foot = h('div', { class: 'ovl-dialog-foot' });
      if (!isAlert) {
        foot.appendChild(
          h('span', {
            class: 'ovl-dialog-hint',
            text: holdMs > 0 ? `长按按钮 ${(holdMs / 1000).toFixed(1)} 秒确认 · Esc 取消` : 'Enter 确认 · Esc 取消',
          }),
        );
      }
      let cancelBtn = null;
      if (cancelText) {
        cancelBtn = h('button', {
          class: 'gcs-btn ovl-dialog-cancel',
          attrs: { type: 'button' },
          text: cancelText,
          on: { click: () => finish(false) },
        });
        foot.appendChild(cancelBtn);
      }

      const confirmBtn = h('button', {
        class: `gcs-btn ${danger ? 'gcs-btn--danger' : 'gcs-btn--primary'} ovl-dialog-confirm${holdMs > 0 ? ' is-hold' : ''}`,
        attrs: { type: 'button' },
      });
      if (holdMs > 0) {
        const ring = h('span', { class: 'ovl-hold-ring', attrs: { 'aria-hidden': 'true' } });
        ring.innerHTML =
          '<svg viewBox="0 0 24 24" aria-hidden="true"><circle class="ovl-hold-track" cx="12" cy="12" r="9"/>' +
          '<circle class="ovl-hold-fill" cx="12" cy="12" r="9"/></svg>';
        confirmBtn.appendChild(ring);
      }
      confirmBtn.appendChild(h('span', { class: 'ovl-dialog-confirm-label', text: confirmText }));
      foot.appendChild(confirmBtn);

      panel.append(head, body, foot);
      scrim.appendChild(panel);
      host.appendChild(scrim);

      const ringFill = confirmBtn.querySelector('.ovl-hold-fill');

      const state = {
        scrim,
        panel,
        cancelBtn,
        closeBtn,
        confirmBtn,
        holdMs,
        holdStart: 0,
        holdRaf: 0,
        holding: false,
        resolve,
        finish: null,
        startHold: null,
        cancelHold: null,
      };

      function paintHold(p) {
        const clamped = Math.max(0, Math.min(1, p));
        confirmBtn.style.setProperty('--ovl-hold-progress', String(clamped));
        if (ringFill) ringFill.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - clamped));
      }

      function cancelHold() {
        if (!state.holding) return;
        state.holding = false;
        cancelAnimationFrame(state.holdRaf);
        setClass(confirmBtn, 'is-holding', false);
        paintHold(0);
      }

      function finish(ok) {
        if (confirmState !== state) return;
        confirmState = null;
        cancelHold();
        cancelAnimationFrame(state.holdRaf);
        scrim.remove();
        syncDialogOpen();
        resolve(!!ok);
      }
      state.finish = finish;

      function loopHold() {
        if (!state.holding) return;
        const p = (performance.now() - state.holdStart) / holdMs;
        paintHold(p);
        if (p >= 1) {
          state.holding = false;
          state.holdRaf = 0;
          setClass(confirmBtn, 'is-holding', false);
          finish(true);
        } else {
          state.holdRaf = requestAnimationFrame(loopHold);
        }
      }

      state.startHold = () => {
        if (!holdMs || state.holding || confirmState !== state) return;
        state.holding = true;
        state.holdStart = performance.now();
        setClass(confirmBtn, 'is-holding', true);
        paintHold(0);
        state.holdRaf = requestAnimationFrame(loopHold);
      };
      state.cancelHold = cancelHold;
      paintHold(0);

      if (holdMs > 0) {
        confirmBtn.addEventListener('pointerdown', (ev) => {
          if (ev.button !== 0) return;
          ev.preventDefault();
          try {
            confirmBtn.setPointerCapture(ev.pointerId);
          } catch {
            /* pointer capture is best effort */
          }
          state.startHold();
        });
        const releaseHold = () => {
          if (state.holding && (performance.now() - state.holdStart) / holdMs < 1) cancelHold();
        };
        confirmBtn.addEventListener('pointerup', releaseHold);
        confirmBtn.addEventListener('pointerleave', releaseHold);
        confirmBtn.addEventListener('pointercancel', releaseHold);
        confirmBtn.addEventListener('contextmenu', (ev) => ev.preventDefault());
      } else {
        confirmBtn.addEventListener('click', () => finish(true));
      }

      confirmState = state;
      syncDialogOpen();

      // focus the safe control first (Esc still works everywhere)
      requestAnimationFrame(() => {
        (cancelBtn || confirmBtn).focus?.({ preventScroll: true });
      });
    });
  }

  // ===========================================================================
  // help sheet
  // ===========================================================================
  function buildHelpContent() {
    const scrim = h('div', {
      class: 'ovl-scrim ovl-scrim--help',
      dataset: { overlay: 'help' },
      on: {
        click: (ev) => {
          if (ev.target === scrim) closeHelp();
        },
      },
    });
    const panel = h('div', {
      class: 'ovl-help',
      attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': '操作帮助' },
    });

    const closeBtn = h('button', {
      class: 'ovl-icon-btn ovl-help-x',
      attrs: { type: 'button', 'aria-label': '关闭帮助' },
      html: icons.icon('close', 13),
      on: { click: () => closeHelp() },
    });

    const head = h(
      'header',
      { class: 'ovl-help-head' },
      h('span', { class: 'ovl-help-index', text: 'HELP' }),
      h('h2', { class: 'ovl-help-title' }, '操作帮助 ', h('em', { text: 'KEYBOARD SHORTCUTS' })),
      h('span', { class: 'ovl-help-version', text: `${app.name || 'OceanSwarm GCS'} v${app.version || '2.0.0'}` }),
      closeBtn,
    );

    const grid = h('div', { class: 'ovl-help-grid' });
    for (const row of meta.KEYBOARD || []) {
      const keys = h('span', { class: 'ovl-help-keys' });
      (row.keys || []).forEach((key, i) => {
        const sep = keySeparator(row, i);
        if (sep != null) keys.appendChild(h('span', { class: 'ovl-help-keysep', text: sep }));
        keys.appendChild(h('kbd', { class: 'ovl-key', text: key }));
      });
      grid.appendChild(h('div', { class: 'ovl-help-item' }, keys, h('span', { class: 'ovl-help-label', text: row.label || '' })));
    }

    const body = h('div', { class: 'ovl-help-body' }, grid);
    const foot = h(
      'footer',
      { class: 'ovl-help-foot' },
      h('span', {
        class: 'ovl-help-foot-brand',
        text: `${app.name || 'OceanSwarm GCS'} v${app.version || '2.0.0'} · 离线指挥控制终端`,
      }),
      h('span', { class: 'ovl-help-foot-hint', text: '指令台输入 help 可再次打开' }),
      h('button', {
        class: 'gcs-btn gcs-btn--sm ovl-help-close',
        attrs: { type: 'button' },
        text: '关闭 ESC',
        on: { click: () => closeHelp() },
      }),
    );

    panel.append(head, body, foot);
    scrim.appendChild(panel);
    return { scrim, panel, closeBtn };
  }

  function openHelp(open = true) {
    if (open === false) {
      closeHelp();
      return;
    }
    if (helpState) return;
    const built = buildHelpContent();
    host.appendChild(built.scrim);
    helpState = built;
    syncDialogOpen();
    requestAnimationFrame(() => built.closeBtn.focus?.({ preventScroll: true }));
  }

  function closeHelp() {
    if (!helpState) return;
    const el = helpState.scrim;
    helpState = null;
    el.remove();
    syncDialogOpen();
  }

  // ===========================================================================
  // toast stack
  // ===========================================================================
  function dismissToast(el, immediate = false) {
    const idx = toasts.findIndex((t) => t.el === el);
    if (idx === -1) return;
    const record = toasts.splice(idx, 1)[0];
    clearTimeout(record.timer);
    el.classList.add('is-out');
    if (immediate || reducedMotion()) el.remove();
    else setTimeout(() => el.remove(), TOAST_EXIT_MS);
  }

  function toast(entry = {}) {
    if (!toastStack) return null;
    const severity = Object.prototype.hasOwnProperty.call(SEVERITY_ICON, entry.severity) ? entry.severity : 'info';
    const title = esc(entry.title);
    const message = esc(entry.message || entry.detail);
    const ttl = isNum(entry.ttl) ? Math.max(900, Math.min(20000, entry.ttl)) : TOAST_TTL;
    const el = h('div', { class: `ovl-toast ovl-toast--${severity}`, attrs: { role: 'status' } });
    el.innerHTML =
      `<i class="ovl-toast-bar" aria-hidden="true"></i>` +
      `<span class="ovl-toast-icon">${icons.icon(SEVERITY_ICON[severity], 13)}</span>` +
      `<div class="ovl-toast-text"><div class="ovl-toast-title"></div><div class="ovl-toast-msg"></div></div>` +
      `<button class="ovl-toast-x" type="button" aria-label="关闭提示">${icons.icon('close', 10)}</button>`;
    el.querySelector('.ovl-toast-title').textContent = title || '提示';
    const msgEl = el.querySelector('.ovl-toast-msg');
    if (message) msgEl.textContent = message;
    else msgEl.remove();
    el.querySelector('.ovl-toast-x').addEventListener('click', () => dismissToast(el, true));
    toastStack.appendChild(el);
    const record = { el, timer: 0 };
    record.timer = setTimeout(() => dismissToast(el), ttl);
    toasts.push(record);
    while (toasts.length > MAX_TOASTS) dismissToast(toasts[0].el, true);
    return el;
  }

  // ===========================================================================
  // snapshot driven notices (alarms / rejected acknowledgements)
  // ===========================================================================
  function watchSnapshotLocal(snap) {
    if (!snap) return;
    const alarms = Array.isArray(snap.alarms) ? snap.alarms : [];
    if (!alarmsSeeded) {
      for (const alarm of alarms) if (alarm?.id) seenAlarmIds.add(alarm.id);
      alarmsSeeded = true;
    } else {
      for (const alarm of alarms) {
        if (!alarm?.id || seenAlarmIds.has(alarm.id)) continue;
        seenAlarmIds.add(alarm.id);
        toast({
          severity: alarm.severity === 'critical' ? 'critical' : 'warning',
          title: alarm.title || '活动告警',
          message: alarm.detail || '',
          ttl: alarm.severity === 'critical' ? 5200 : 4200,
        });
      }
    }
    if (seenAlarmIds.size > 200) {
      const keep = alarms.map((a) => a?.id).filter(Boolean);
      seenAlarmIds.clear();
      for (const id of keep) seenAlarmIds.add(id);
    }

    const acks = Array.isArray(snap.acks) ? snap.acks : [];
    if (!acksSeeded) {
      for (const ack of acks) if (ack?.id) seenAckIds.add(ack.id);
      acksSeeded = true;
    } else {
      for (const ack of acks) {
        if (!ack?.id || seenAckIds.has(ack.id)) continue;
        seenAckIds.add(ack.id);
        if (ack.ok === false) {
          toast({ severity: 'warning', title: '指令被拒绝', message: ack.text || ack.commandText || '', ttl: 4200 });
        }
      }
    }
    lastSnap = snap;
  }

  // ===========================================================================
  // keyboard capture — overlays own the keyboard while they are visible
  // ===========================================================================
  function onKeyDownCapture(ev) {
    const modalOpen = !!(confirmState || helpState);
    const bootVisible = !!bootEl && !bootDone;

    if (!modalOpen && !bootVisible) return;

    if (bootVisible && !modalOpen) {
      ev.stopPropagation();
      if (ev.key === 'Escape' || ev.key === 'Enter' || (ev.key === ' ' && !ev.repeat)) {
        ev.preventDefault();
        finishBoot(true);
      }
      return;
    }

    // A modal layer is up: stop global shortcuts from firing behind it.
    ev.stopPropagation();
    if (MODAL_KEYS.has(ev.key)) ev.preventDefault();

    if (ev.key === 'Escape') {
      if (confirmState) confirmState.finish(false);
      else closeHelp();
      return;
    }

    if (confirmState) {
      const active = document.activeElement;
      // focused safe controls keep their native semantics
      if (active === confirmState.cancelBtn || active === confirmState.closeBtn) {
        if (ev.key === 'Enter' || ev.key === ' ') confirmState.finish(false);
        return;
      }
      if (confirmState.holdMs > 0) {
        if (ev.key === 'Enter' || ev.key === ' ') {
          if (!ev.repeat) confirmState.startHold();
        }
      } else if (ev.key === 'Enter' || ev.key === ' ') {
        confirmState.finish(true);
      }
      return;
    }

    if (helpState) {
      if (ev.key === 'Enter' || ev.key === ' ') closeHelp();
    }
  }

  function onKeyUpCapture(ev) {
    if (confirmState && confirmState.holding && (ev.key === 'Enter' || ev.key === ' ')) {
      ev.stopPropagation();
      confirmState.cancelHold();
    }
  }

  // ===========================================================================
  // public panel API
  // ===========================================================================
  return {
    name: 'overlays',

    mount(hostEl) {
      host = hostEl;
      bootDone = false;
      bootNotified = false;

      toastStack = h('div', { class: 'ovl-toasts', attrs: { 'aria-live': 'polite' } });
      toastStack.style.pointerEvents = 'none';
      host.appendChild(toastStack);

      buildBoot();
      host.appendChild(bootEl);

      // Replace the fallback services created in context.js.
      dialog.confirm = (options) => openConfirm(options || {});
      dialog.alert = (options) => openConfirm({ ...(options || {}), _alert: true, holdMs: 0, cancelText: null });
      dialog.toast = (entry) => toast(entry || {});
      dialog.help = (open = true) => openHelp(open !== false);
      dialog.skipBoot = () => finishBoot(true);
      dialog.closeAll = () => closeAll();

      disposers.push(bus.on('help', (open) => openHelp(open !== false)));
      disposers.push(
        bus.on('alarm', (alarm) => {
          if (!alarm || (alarm.id && seenAlarmIds.has(alarm.id))) return;
          if (alarm.id) seenAlarmIds.add(alarm.id);
          toast({
            severity: alarm.severity === 'critical' ? 'critical' : 'warning',
            title: alarm.title || '活动告警',
            message: alarm.detail || '',
          });
        }),
      );

      window.addEventListener('keydown', onKeyDownCapture, true);
      window.addEventListener('keyup', onKeyUpCapture, true);

      startBoot();
    },

    update(snap) {
      if (bootDone) watchSnapshotLocal(snap || ctx.getSnapshot?.());
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
      window.removeEventListener('keydown', onKeyDownCapture, true);
      window.removeEventListener('keyup', onKeyUpCapture, true);
      cancelAnimationFrame(bootRaf);
      clearTimeout(bootFallbackTimer);
      closeAll();
      if (bootEl) {
        bootEl.remove();
        bootEl = null;
      }
      for (const record of toasts.splice(0)) {
        clearTimeout(record.timer);
        record.el.remove();
      }
      if (toastStack) {
        toastStack.remove();
        toastStack = null;
      }
    },
  };
}
