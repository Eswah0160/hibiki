// App shell: router, navigation, render loop and shared view bits.
import { db } from '../db.js';
import { html, raw, icon, $, $$, closeTopSheet, sheetOpen, toast } from './dom.js';
import * as native from '../native.js';
import { openEq, dsp, eqLabel, onDsp } from './eq.js';

const screens = {};
export function registerScreen(name, mod) { screens[name] = mod; }

export const state = {
  route: 'home', params: {},
  libTab: 'tracks', albumSort: 'added', trackSort: 'title', q: '',
  selAlbum: null, period: 'month', insightsTab: 'listening', healthFilter: null,
  folder: { root: null, path: '' }, trackLimit: 200,
};

const NAV = [
  ['home', 'Home', 'home'],
  ['library', 'Library', 'library'],
  ['playlists', 'Playlists', 'playlist'],
  ['insights', 'Insights', 'chart'],
  ['health', 'Health', 'pulse'],
];
const NAV_OWNER = { album: 'library', artist: 'library', search: 'library', playlist: 'playlists', settings: null, guide: null };

let mainEl, topEl, navEl;
let renderQueued = false;
const backHandlers = [];
/** Extra Android-back handlers (e.g. the Now Playing overlay). Return true when handled. */
export function onBack(fn) { backHandlers.push(fn); }

export function mount(root) {
  root.innerHTML = String(html`<header class="topbar" id="top"></header><main id="main"></main><div id="mini"></div><nav class="bottomnav" id="nav"></nav>`);
  mainEl = $('#main'); topEl = $('#top'); navEl = $('#nav');
  navEl.innerHTML = String(html`${NAV.map(([id, label, ic]) => html`<button class="navbtn" data-nav="${id}" aria-label="${label}" title="${label}">${icon(ic)}<span>${label}</span><span class="badge hidden" data-badge="${id}"></span></button>`)}`);
  navEl.addEventListener('click', (e) => {
    const b = e.target.closest('[data-nav]');
    if (!b) return;
    native.haptic('tick');
    if (state.route === b.dataset.nav && mainEl.scrollTop > 0) { mainEl.scrollTo({ top: 0, behavior: 'smooth' }); return; }
    go(b.dataset.nav);
  });
  onDsp((d) => { const b = $('[data-top=eq]', topEl); if (b) { b.classList.toggle('on', !!d.eq); b.title = 'Sound · ' + eqLabel(d); } });
  topEl.addEventListener('click', (e) => {
    const b = e.target.closest('[data-top]');
    if (!b) return;
    const a = b.dataset.top;
    if (a === 'back') return back();
    if (a === 'settings') return go('settings');
    if (a === 'search') return go('search');
    if (a === 'eq') return openEq();
    screens[state.route]?.topAction?.(a, b);
  });
  // One delegated handler for every screen: elements carry data-act, the screen's on() handles them.
  mainEl.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el || !mainEl.contains(el)) return;
    screens[state.route]?.on?.(el.dataset.act, el, e);
  });
  bindRowGestures(mainEl);
  mainEl.addEventListener('input', (e) => screens[state.route]?.onInput?.(e.target, e));
  mainEl.addEventListener('change', (e) => screens[state.route]?.onChange?.(e.target, e));
  window.addEventListener('hashchange', fromHash);
  db.onChange(() => queueRender());
  window.hibikiBack = () => {
    if (sheetOpen()) { closeTopSheet(); return true; }
    for (const h of backHandlers) if (h()) return true;
    if (state.route !== 'home') { back(); return true; }
    return false;
  };
  fromHash();
}

function fromHash() {
  const parts = (location.hash.replace(/^#\/?/, '') || 'home').split('/');
  const prev = state.route;
  state.route = screens[parts[0]] ? parts[0] : 'home';
  state.params = { id: parts[1] ? decodeURIComponent(parts.slice(1).join('/')) : null };
  if (prev !== state.route || state.route === 'album' || state.route === 'artist' || state.route === 'playlist') mainEl.scrollTop = 0;
  render();
}
export function go(route, id = null) { location.hash = '#/' + route + (id != null ? '/' + encodeURIComponent(id) : ''); }
export function back() { if (history.length > 1) history.back(); else go('home'); }

export function queueRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; render(); });
}

export function render() {
  const scr = screens[state.route];
  if (!scr) return;
  const top = scr.top ? scr.top(state) : { title: scr.title };
  topEl.innerHTML = String(html`
    ${top.back ? html`<button class="iconbtn" data-top="back" aria-label="Back">${icon('back')}</button>` : ''}
    ${top.center ? raw(String(top.center)) : html`<h1 class="grow ellipsis">${top.title || ''}</h1>`}
    ${(top.actions || []).map((a) => html`<button class="iconbtn" data-top="${a.id}" aria-label="${a.label}" title="${a.label}">${icon(a.icon)}</button>`)}
    ${top.noSearch ? '' : html`<button class="iconbtn ${dsp().eq ? 'on' : ''}" data-top="eq" aria-label="Sound and EQ" title="Sound · ${eqLabel()}">${icon('eq')}</button>`}
    ${top.noSearch ? '' : html`<button class="iconbtn" data-top="search" aria-label="Search">${icon('search')}</button>`}
    ${top.noSettings ? '' : html`<button class="iconbtn" data-top="settings" aria-label="Settings">${icon('gear')}</button>`}`);
  const owner = NAV_OWNER[state.route] !== undefined ? NAV_OWNER[state.route] : state.route;
  for (const b of $$('[data-nav]', navEl)) b.classList.toggle('on', b.dataset.nav === owner);
  const st = mainEl.scrollTop;
  scr.render(mainEl, state);
  mainEl.scrollTop = st;
  markPlaying();
}

// ---------------------------------------------------------------- row gestures

/**
 * Swipe a track row right = Play next, left = Add to queue (both undoable from the toast).
 * Long-press a track row = its menu; long-press an album = quick actions (play, shuffle, queue, artist…).
 */
function bindRowGestures(root) {
  let sw = null, suppress = false;
  root.addEventListener('pointerdown', (e) => {
    const row = e.target.closest('.trk[data-tid]');
    if (!row || (e.pointerType === 'mouse' && e.button !== 0) || e.target.closest('button')) { sw = null; return; }
    sw = { row, x: e.clientX, y: e.clientY, id: e.pointerId, dx: 0, active: false };
  });
  root.addEventListener('pointermove', (e) => {
    if (!sw || e.pointerId !== sw.id) return;
    const dx = e.clientX - sw.x, dy = e.clientY - sw.y;
    if (!sw.active) {
      if (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) { sw = null; return; }
      if (Math.abs(dx) < 14 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      sw.active = true;
      try { sw.row.setPointerCapture(e.pointerId); } catch {}
      sw.row.classList.add('swiping');
    }
    sw.dx = Math.max(-130, Math.min(130, dx));
    sw.row.style.transform = `translateX(${sw.dx}px)`;
    const armed = sw.dx > 76 ? 'next' : sw.dx < -76 ? 'queue' : '';
    if (armed && sw.row.dataset.swipe !== armed) native.haptic('tick');
    sw.row.dataset.swipe = armed;
  });
  const end = async () => {
    if (!sw) return;
    const { row, dx, active } = sw;
    sw = null;
    if (!active) return;
    row.style.transform = '';
    row.classList.remove('swiping');
    row.dataset.swipe = '';
    suppress = true; setTimeout(() => { suppress = false; }, 60);
    if (Math.abs(dx) <= 76) return;
    const [{ track }, play] = await Promise.all([import('../repo.js'), import('../play.js')]);
    const t = track(Number(row.dataset.tid));
    if (!t) return;
    if (dx > 0) play.playNext([t]); else play.enqueue([t]);
  };
  root.addEventListener('pointerup', end);
  root.addEventListener('pointercancel', end);
  root.addEventListener('click', (e) => { if (suppress) { e.stopPropagation(); e.preventDefault(); } }, true);
  root.addEventListener('contextmenu', async (e) => {
    const row = e.target.closest('.trk[data-tid]'), card = e.target.closest('.acard[data-key]');
    if (!row && !card) return;
    e.preventDefault();
    if (sw?.active) return;
    sw = null;
    native.haptic('confirm');
    const common = await import('./common.js');
    if (card) { const { album } = await import('../repo.js'); const a = album(card.dataset.key); if (a) common.albumMenu(a, { quick: true }); }
    else common.trackMenu(Number(row.dataset.tid));
  });
}

export function setBadge(nav, n) {
  const b = navEl?.querySelector(`[data-badge="${nav}"]`);
  if (!b) return;
  b.textContent = n > 99 ? '99+' : String(n);
  b.classList.toggle('hidden', !n);
}

// ---------------------------------------------------------------- shared view helpers

/** Album art <img> (lazy) or a placeholder tile. */
export function art(key, { size = 't', cls = '' } = {}) {
  const url = native.artUrl(key, size);
  return url ? html`<img class="art ${cls}" src="${url}" alt="" loading="lazy" decoding="async">`
    : html`<div class="art ph ${cls}">${icon('note')}</div>`;
}

let playingId = null;
export function setPlayingId(id) { if (id !== playingId) { playingId = id; markPlaying(); } }
export const currentPlayingId = () => playingId;
/** Highlight rows of the track that's playing, without a full re-render. */
export function markPlaying() {
  if (!mainEl) return;
  for (const el of $$('[data-tid]', mainEl)) el.classList.toggle('playing', Number(el.dataset.tid) === playingId);
}

export { screens, toast, mainEl };
