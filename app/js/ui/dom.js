// Tiny view helpers: auto-escaping html`` templates, sheets, menus, toasts.
import { esc } from '../util.js';

export class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = (s) => new Raw(s);
const fmtVal = (v) => (v instanceof Raw ? v.s : Array.isArray(v) ? v.map(fmtVal).join('') : v == null || v === false ? '' : esc(String(v)));
/** Tagged template: interpolations are HTML-escaped unless wrapped in raw()/html``. */
export function html(strings, ...vals) {
  let out = '';
  strings.forEach((s, i) => { out += s; if (i < vals.length) out += fmtVal(vals[i]); });
  return new Raw(out);
}
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const P = {
  home: '<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/>',
  library: '<rect x="3" y="4" width="4" height="16" rx="1"/><rect x="9" y="4" width="4" height="16" rx="1"/><path d="M15.5 5.2l3.8-1 3 15.6-3.8 1z"/>',
  disc: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>',
  playlist: '<path d="M3 6h12M3 12h12M3 18h7"/><circle cx="17" cy="17" r="3"/><path d="M20 17V6l2 1"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/>',
  note: '<path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>',
  folder: '<path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  tag: '<path d="M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
  play: '<path d="M7 4.5v15l13-7.5z" fill="currentColor" stroke-linejoin="round"/>',
  pause: '<rect x="6" y="4.5" width="4" height="15" rx="1" fill="currentColor"/><rect x="14" y="4.5" width="4" height="15" rx="1" fill="currentColor"/>',
  next: '<path d="M5 5l10 7-10 7z" fill="currentColor"/><path d="M19 5v14"/>',
  prev: '<path d="M19 5L9 12l10 7z" fill="currentColor"/><path d="M5 5v14"/>',
  shuffle: '<path d="M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/>',
  repeat: '<path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>',
  queue: '<path d="M3 6h13M3 12h13M3 18h9"/><path d="M17 15l4 3-4 3z" fill="currentColor"/>',
  star: '<path d="M12 3l2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3 6.4 20.2l1.1-6.2L3 9.6l6.2-.9z"/>',
  starOn: '<path d="M12 3l2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3 6.4 20.2l1.1-6.2L3 9.6l6.2-.9z" fill="currentColor"/>',
  pulse: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="M21 15l-5-5L5 21"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/>',
  share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4"/>',
  alert: '<path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  back: '<path d="M15 18l-6-6 6-6"/>',
  fwd: '<path d="M9 18l6-6-6-6"/>',
  down: '<path d="M6 9l6 6 6-6"/>',
  up: '<path d="M18 15l-6-6-6 6"/>',
  close: '<path d="M18 6L6 18M6 6l12 12"/>',
  check: '<path d="M20 6L9 17l-5-5"/>',
  more: '<circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  sparkle: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 17l.8 2.2L22 20l-2.2.8L19 23l-.8-2.2L16 20l2.2-.8z"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  grid: '<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/>',
  speaker: '<path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/>',
  headphones: '<path d="M4 15v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="14" width="4" height="7" rx="1.5"/><rect x="17" y="14" width="4" height="7" rx="1.5"/>',
  usb: '<path d="M12 3v15M9.5 5.5L12 3l2.5 2.5M12 14l-4.5-2.5V9M12 16l4.5-2.5V11"/><circle cx="12" cy="19.5" r="1.8"/><rect x="6" y="7" width="3" height="2"/><circle cx="16.5" cy="10" r="1.2"/>',
  bluetooth: '<path d="M7 7l10 10-5 4V3l5 4L7 17"/>',
  eq: '<path d="M6 4v6M6 14v6M12 4v2M12 10v10M18 4v10M18 18v2"/><circle cx="6" cy="12" r="2"/><circle cx="12" cy="8" r="2"/><circle cx="18" cy="16" r="2"/>',
  wave: '<path d="M2 12h2M6 8v8M10 5v14M14 8v8M18 10v4M22 12h0"/>',
};
export const icon = (name) => raw(`<svg viewBox="0 0 24 24" aria-hidden="true">${P[name] || ''}</svg>`);

// ---------- sheets ----------
const stack = [];
export function openSheet({ title = '', body = '', footer = '', onClose = null, className = '', actions = {} } = {}) {
  const scrim = document.createElement('div');
  scrim.className = 'scrim';
  const el = document.createElement('div');
  el.className = 'sheet ' + className;
  el.setAttribute('role', 'dialog');
  el.innerHTML = String(html`<div class="grab"></div>
    <div class="sheet-h"><h2>${title}</h2><button class="iconbtn" data-act="close" aria-label="Close">${icon('close')}</button></div>
    <div class="sheet-b">${body}</div>${footer ? html`<div class="sheet-f">${footer}</div>` : ''}`);
  document.body.append(scrim, el);
  const api = {
    el, closed: false,
    close(result) {
      if (api.closed) return; api.closed = true;
      scrim.remove(); el.remove();
      const i = stack.indexOf(api); if (i >= 0) stack.splice(i, 1);
      onClose && onClose(result);
    },
    setBody(b) { el.querySelector('.sheet-b').innerHTML = String(b); },
    setFooter(f) { const ft = el.querySelector('.sheet-f'); if (ft) ft.innerHTML = String(f); },
    setTitle(t) { el.querySelector('.sheet-h h2').textContent = t; },
  };
  scrim.addEventListener('click', () => api.close());
  bindPullToClose(el, api);
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b || !el.contains(b)) return;
    const act = b.dataset.act;
    if (act === 'close') return api.close();
    if (actions[act]) actions[act](b, e, api);
  });
  stack.push(api);
  return api;
}
/**
 * Bottom sheets (the queue, menus…) can be pulled down to close: grab the header, or the list once it's
 * scrolled to the top. It follows the finger and either drops away or springs back. Phone layout only.
 */
function bindPullToClose(el, api) {
  let pd = null;
  el.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1 || window.matchMedia('(min-width: 720px)').matches) return;
    const body = el.querySelector('.sheet-b');
    if (e.target.closest('.sheet-b') && body && body.scrollTop > 0) { pd = null; return; }
    if (e.target.closest('input, textarea, select, [data-noswipe]')) { pd = null; return; }
    pd = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now(), drag: false, dy: 0 };
  }, { passive: true });
  el.addEventListener('touchmove', (e) => {
    if (!pd) return;
    const dx = e.touches[0].clientX - pd.x, dy = e.touches[0].clientY - pd.y;
    if (!pd.drag) {
      if (dy > 10 && dy > Math.abs(dx) * 1.2) { pd.drag = true; el.style.animation = 'none'; el.style.transition = 'none'; }
      else if (dy < -6 || Math.abs(dx) > 12) { pd = null; return; }
      else return;
    }
    pd.dy = Math.max(0, dy);
    el.style.transform = `translateY(${pd.dy}px)`;
  }, { passive: true });
  const end = () => {
    if (!pd) return;
    const { drag, dy, t } = pd;
    pd = null;
    if (!drag) return;
    const fast = dy / Math.max(1, Date.now() - t) > 0.6;
    if (dy > 90 || (fast && dy > 30)) {
      el.style.transition = 'transform .2s ease-in';
      el.style.transform = 'translateY(100%)';
      setTimeout(() => api.close(), 190);
    } else {
      el.style.transition = 'transform .2s cubic-bezier(.2, .8, .2, 1)';
      el.style.transform = '';
    }
  };
  el.addEventListener('touchend', end, { passive: true });
  el.addEventListener('touchcancel', end, { passive: true });
}

export function closeTopSheet() { const s = stack[stack.length - 1]; if (s) { s.close(); return true; } return false; }
export const sheetOpen = () => stack.length > 0;

export function menu(title, items) {
  return new Promise((resolve) => {
    const s = openSheet({
      title, className: 'menu',
      body: html`${items.filter(Boolean).map((it, i) => html`<button class="mi ${it.danger ? 'danger' : ''}" data-act="pick" data-i="${i}" ${it.disabled ? raw('disabled') : ''}>
        ${it.icon ? icon(it.icon) : ''}<span class="grow"><div>${it.label}</div>${it.sub ? html`<div class="sub">${it.sub}</div>` : ''}</span>${it.right || ''}</button>`)}`,
      onClose: (r) => resolve(r ?? null),
      actions: { pick: (b, e, api) => { const it = items.filter(Boolean)[+b.dataset.i]; api.close(it.value ?? it.label); it.onClick && it.onClick(); } },
    });
  });
}

export function confirmDlg(message, { ok = 'OK', danger = false, title = 'Are you sure?' } = {}) {
  return new Promise((resolve) => {
    openSheet({
      title, body: html`<p class="ink2" style="margin:4px 0 8px">${message}</p>`,
      footer: html`<button class="btn grow" data-act="close">Cancel</button><button class="btn grow ${danger ? 'danger' : 'primary'}" data-act="ok">${ok}</button>`,
      onClose: (r) => resolve(!!r), actions: { ok: (b, e, api) => api.close(true) },
    });
  });
}

export function promptDlg(title, { value = '', placeholder = '', type = 'text', inputmode = '', ok = 'Save', hint = '' } = {}) {
  return new Promise((resolve) => {
    const s = openSheet({
      title,
      body: html`<input class="input" id="pd" type="${type}" ${inputmode ? raw(`inputmode="${inputmode}"`) : ''} value="${value}" placeholder="${placeholder}" autocomplete="off">${hint ? html`<p class="small muted">${hint}</p>` : ''}`,
      footer: html`<button class="btn grow" data-act="close">Cancel</button><button class="btn primary grow" data-act="ok">${ok}</button>`,
      onClose: (r) => resolve(r ?? null),
      actions: { ok: (b, e, api) => api.close(s.el.querySelector('#pd').value) },
    });
    const inp = s.el.querySelector('#pd');
    setTimeout(() => { inp.focus(); inp.select?.(); }, 60);
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') s.close(inp.value); });
  });
}

let toastEl = null, toastT = null;
export function toast(msg, { action = null, onAction = null, ms = 3200 } = {}) {
  toastEl?.remove(); clearTimeout(toastT);
  toastEl = document.createElement('div');
  toastEl.className = 'toast';
  if (stack.length) toastEl.style.cssText = 'top:16px;bottom:auto';
  toastEl.innerHTML = String(html`<span>${msg}</span>${action ? html`<button>${action}</button>` : ''}`);
  if (action) toastEl.querySelector('button').onclick = () => { toastEl?.remove(); onAction && onAction(); };
  document.body.append(toastEl);
  toastT = setTimeout(() => toastEl?.remove(), ms);
}
