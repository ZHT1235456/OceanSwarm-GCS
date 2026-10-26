// =============================================================================
// Minimal DOM helpers shared by every UI module (no framework, no deps).
// =============================================================================

/**
 * Create an element.
 *   h('div', { class:'a b', text:'hi' })
 *   h('button', { class:'gcs-btn', on:{ click: fn }, attrs:{ type:'button' } }, icon('radar'), '雷达')
 * Supported props: class/className, text, html, style (object), dataset (object),
 * attrs (object), on (object of event handlers), title, id, role.
 */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  if (props) {
    if (props.class || props.className) el.className = props.class || props.className;
    if (props.id) el.id = props.id;
    if (props.text != null) el.textContent = String(props.text);
    if (props.html != null) el.innerHTML = props.html;
    if (props.title != null) el.title = String(props.title);
    if (props.style) {
      for (const [k, v] of Object.entries(props.style)) {
        if (v != null) el.style.setProperty(k, String(v));
      }
    }
    if (props.dataset) {
      for (const [k, v] of Object.entries(props.dataset)) el.dataset[k] = String(v);
    }
    if (props.attrs) {
      for (const [k, v] of Object.entries(props.attrs)) {
        if (v == null) continue;
        if (v === false) continue;
        el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    if (props.on) {
      for (const [evt, fn] of Object.entries(props.on)) {
        if (typeof fn === 'function') el.addEventListener(evt, fn);
      }
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    if (Array.isArray(child)) append(el, child);
    else if (child instanceof Node) el.appendChild(child);
    else el.appendChild(document.createTextNode(String(child)));
  }
}

/** Parse an HTML string into elements. */
export function frag(html) {
  const template = document.createElement('template');
  template.innerHTML = String(html).trim();
  return template.content;
}

export const qs = (sel, root = document) => root.querySelector(sel);
export const qsa = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** addEventListener that returns a disposer. */
export function on(target, type, handler, opts) {
  target.addEventListener(type, handler, opts);
  return () => target.removeEventListener(type, handler, opts);
}

/** Update textContent only when it actually changed (avoids layout churn). */
export function setText(el, text) {
  if (!el) return;
  const next = text == null ? '' : String(text);
  if (el.textContent !== next) el.textContent = next;
}

/** Toggle a class only when needed. */
export function setClass(el, cls, active) {
  if (!el) return;
  if (el.classList.contains(cls) !== !!active) el.classList.toggle(cls, !!active);
}

export function setAttr(el, name, value) {
  if (!el) return;
  if (value == null || value === false) {
    if (el.hasAttribute(name)) el.removeAttribute(name);
  } else if (el.getAttribute(name) !== String(value)) {
    el.setAttribute(name, String(value));
  }
}

/** Replace children in one shot. */
export function clear(el) {
  if (el) el.replaceChildren();
}

/** requestAnimationFrame-throttled callback (returns cancel fn). */
export function rafThrottle(fn) {
  let handle = 0;
  let lastArgs = null;
  const tick = () => {
    handle = 0;
    fn(...(lastArgs || []));
    lastArgs = null;
  };
  const wrapped = (...args) => {
    lastArgs = args;
    if (!handle) handle = requestAnimationFrame(tick);
  };
  wrapped.cancel = () => {
    if (handle) cancelAnimationFrame(handle);
    handle = 0;
  };
  return wrapped;
}

/** Human-readable number for data-attributes / tests: never "NaN"/"undefined". */
export function dataValue(v) {
  return typeof v === 'number' && Number.isFinite(v) ? String(v) : '';
}
