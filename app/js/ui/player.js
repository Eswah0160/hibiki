// Mini player, Now Playing (three swipeable panels: Info, Cover, Signal), queue and sleep timer.
//
// Now Playing gestures: swipe left/right between panels, swipe down to close, swipe up for the queue,
// double-tap the cover to star, tap the cover (Cover panel) for lyrics, hold previous/next to scrub.
import { html, icon, $, $$, openSheet, menu, toast } from './dom.js';
import { art, go, onBack, setPlayingId, state as appState, queueRender } from './app.js';
import * as native from '../native.js';
import * as repo from '../repo.js';
import { dur, titleOf, albumArtistOf, quality } from '../util.js';
import { pickPlaylist, fileInfo } from './common.js';
import { meta, setMeta } from '../db.js';
import { item as queueItem } from '../play.js';
import { openEq, dsp, setDsp, eqLabel, onDsp, curvePath } from './eq.js';
import { explain } from './guide.js';
import { db } from '../db.js';
import { ago } from '../util.js';

let s = { connected: false, ids: [], order: [] };
let recvAt = performance.now();
let cur = null;          // current track row
let npEl = null;         // Now Playing overlay
let queueSheet = null;
let seeking = false, scrubMs = 0;

const PAGES = ['Info', 'Cover', 'Signal'];
const LONG_MS = 20 * 60 * 1000; // tracks this long remember where you stopped
const isWide = () => window.matchMedia('(min-width: 720px)').matches;

const position = () => {
  if (seeking) return scrubMs;
  if (!s.playing) return s.pos || 0;
  return Math.min(s.dur || Infinity, (s.pos || 0) + (performance.now() - recvAt));
};

export function initPlayer() {
  native.onPlayer(update);
  update(native.playerState());
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') update(native.playerState()); });
  // Poll the cached native state for position; events cover everything else.
  setInterval(() => {
    if (document.visibilityState === 'visible' && native.isNative && (s.playing || native.isWeb)) update(native.playerState(), true);
    saveResume();
  }, 1000);
  requestAnimationFrame(frame);
  onBack(() => {
    if (npEl) { closeNowPlaying(); return true; }
    return false;
  });
  $('#mini').addEventListener('click', onMiniClick);
}

function update(next, fromPoll = false) {
  if (!next) return;
  const idChanged = next.id !== s.id;
  const queueChanged = next.ids && (next.ids.length !== s.ids.length || next.order?.join() !== s.order?.join() || next.ids.join() !== s.ids.join());
  s = { ...s, ...next };
  if (!next.ids) { s.ids = s.ids || []; s.order = s.order || []; }
  recvAt = performance.now();
  if (idChanged || (!cur && s.id)) { cur = s.id ? repo.track(s.id) : null; if (idChanged) resumeLong(); }
  setPlayingId(s.id ?? null);
  if ((idChanged || queueChanged || next.playing !== undefined) && appState.route === 'home' && !fromPoll) queueRender();
  renderMini(idChanged);
  if (npEl) { renderNp(idChanged); if (!idChanged && queueChanged) renderUpNext(); }
  if (queueSheet && !queueSheet.closed && (queueChanged || idChanged)) renderQueue();
  if (s.error && !fromPoll) toast('Playback error: ' + s.error, { ms: 5000 });
}

// ---------------------------------------------------------------- resume long tracks

let resumeSavedAt = 0;
function resumeLong() {
  if (!cur || (cur.duration_ms || 0) < LONG_MS) return;
  const at = Number(meta('resume:' + cur.id, 0));
  if (at > 30000 && at < cur.duration_ms - 60000 && (s.pos || 0) < 5000) {
    const id = cur.id;
    native.seek(at); s.pos = at; recvAt = performance.now();
    toast(`Resumed at ${dur(at)}`, { action: 'Start over', onAction: () => { native.seek(0); setMeta('resume:' + id, 0); }, ms: 5000 });
  }
}
function saveResume() {
  if (!cur || (cur.duration_ms || 0) < LONG_MS || !s.playing) return;
  if (Date.now() - resumeSavedAt < 10000) return;
  resumeSavedAt = Date.now();
  const p = position();
  setMeta('resume:' + cur.id, p > cur.duration_ms - 60000 ? 0 : Math.round(p));
}

// ---------------------------------------------------------------- per-frame updates

let lastSec = -1, lastWaveIdx = -1, lastLyric = -1;
function frame() {
  const p = position();
  const pct = s.dur ? Math.min(100, (p / s.dur) * 100) : 0;
  const bar = $('#mini .mprog i');
  if (bar) bar.style.width = pct + '%';
  if (npEl) {
    const sec = Math.floor(p / 1000);
    if (sec !== lastSec) {
      lastSec = sec;
      for (const el of $$('.np-p', npEl)) el.textContent = dur(p);
      for (const el of $$('.np-r', npEl)) el.textContent = s.dur ? '−' + dur(Math.max(0, s.dur - p)) : '';
    }
    const cb = $('#npbar', npEl);
    if (cb) cb.style.setProperty('--pct', pct + '%');
    paintWave(pct / 100);
    paintLyrics(p);
    drawMeters();
  }
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- mini player

function renderMini(full) {
  const m = $('#mini');
  if (!m) return;
  document.body.classList.toggle('has-mini', !!cur);
  if (!cur) { m.innerHTML = ''; return; }
  if (!full && m.firstChild) {
    const b = $('[data-mini=toggle]', m);
    if (b) b.innerHTML = String(icon(s.playing ? 'pause' : 'play'));
    return;
  }
  m.innerHTML = String(html`<div class="mini">
    <div class="mprog"><i></i></div>
    <button class="mopen" data-mini="open" aria-label="Open Now Playing">${art(cur.art_key, { cls: 'sm' })}<div class="grow"><div class="t ellipsis">${titleOf(cur)}</div><div class="s ellipsis">${[cur.artist || '', quality(cur)].filter(Boolean).join(' · ')}</div></div></button>
    <button class="iconbtn" data-mini="prev" aria-label="Previous">${icon('prev')}</button>
    <button class="mplay" data-mini="toggle" aria-label="Play or pause">${icon(s.playing ? 'pause' : 'play')}</button>
    <button class="iconbtn" data-mini="next" aria-label="Next">${icon('next')}</button>
  </div>`);
}

function onMiniClick(e) {
  const b = e.target.closest('[data-mini]');
  if (!b) return;
  const a = b.dataset.mini;
  if (a === 'open') openNowPlaying();
  else if (a === 'toggle') { native.haptic('tick'); native.toggle(); s.playing = !s.playing; renderMini(false); }
  else if (a === 'next') { native.haptic('tick'); native.next(); }
  else if (a === 'prev') { native.haptic('tick'); native.prev(); }
}

// ---------------------------------------------------------------- now playing

let page = 0;
export function openNowPlaying() {
  if (!cur) return toast('Nothing is playing');
  if (npEl) return;
  page = Math.max(0, Math.min(2, Number(meta('np_page', 0)) || 0));
  npEl = document.createElement('div');
  npEl.className = 'np';
  document.body.append(npEl);
  renderNp(true);
  npEl.addEventListener('click', onNpClick);
  npEl.addEventListener('contextmenu', (e) => e.preventDefault());
  bindGestures();
  volTimer = setInterval(() => { if (document.visibilityState === 'visible' && !knobDrag && !stepDrag) refreshVol(); }, 700);
  if (meta('np_keep_awake', false)) native.keepScreenOn(true);
}

/** Close Now Playing. It slides down out of the way (continuing from wherever a swipe left it). */
export function closeNowPlaying({ animate = true } = {}) {
  clearInterval(volTimer); volTimer = 0;
  clearTimeout(volPopTimer);
  const el = npEl;
  npEl = null;
  native.keepScreenOn(false);
  if (!el) return;
  if (!animate || reduceMotion) { el.remove(); return; }
  el.style.pointerEvents = 'none';
  el.style.transition = 'transform .26s cubic-bezier(.4, 0, .9, .6), opacity .26s ease-in';
  requestAnimationFrame(() => { el.style.transform = 'translateY(100%)'; el.style.opacity = '.5'; });
  setTimeout(() => el.remove(), 280);
}

function sleepLabel() {
  if (s.sleepAt === -1) return 'End of track';
  if (s.sleepAt === -2) return 'End of album';
  if (s.sleepAt > 0) { const m = Math.max(1, Math.round((s.sleepAt - Date.now()) / 60000)); return `${m} min`; }
  return '';
}

const OUT = { usb: ['usb', 'USB DAC'], bt: ['bluetooth', 'Bluetooth'], wired: ['headphones', 'Wired'], speaker: ['speaker', 'Speaker'], other: ['speaker', 'Output'] };
function outLabel(o) {
  if (!o) return null;
  const [ic, kind] = OUT[o.kind] || OUT.other;
  return { ic, kind, name: o.name && o.kind !== 'speaker' ? o.name : kind };
}
const khz = (sr) => { const k = sr / 1000; return Number.isInteger(k) ? String(k) : k.toFixed(1); };
const fmtName = (t) => (t.ext === 'm4a' ? (t.lossless ? 'ALAC' : 'AAC') : (t.ext || '').toUpperCase());

function rgInfo() {
  const mode = meta('rg_mode', 'off');
  if (mode === 'off' || !cur) return { mode, db: null };
  const g = mode === 'album' ? (cur.rg_album ?? cur.rg_track) : (cur.rg_track ?? cur.rg_album);
  if (g == null) return { mode, db: null };
  return { mode, db: g + (Number(meta('rg_preamp', 0)) || 0) };
}
const dbText = (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)} DB`;

function renderNp(full) {
  if (!npEl) return;
  if (!cur) { closeNowPlaying(); return; }
  if (!full) { updateNpState(); return; }
  const t = cur;
  const starred = repo.isStarred(t.id);
  const q = quality(t);
  // order = the current track and what follows it (in shuffle order), so everything before it has played
  const pos = s.order.length ? Math.max(0, s.ids.length - s.order.length) : Math.max(0, s.index);
  const rg = rgInfo();
  const albumLine = [t.album || t.folder || '', t.year ? String(t.year).slice(0, 4) : ''].filter(Boolean).join(' · ');
  npEl.innerHTML = String(html`<div class="np-in">
    <div class="np-top">
      <button class="iconbtn" data-np="close" aria-label="Close">${icon('down')}</button>
      <span class="np-tl mono"><i class="led" id="npled"></i><span id="npcount">${s.ids.length ? `${String(Math.max(1, pos + 1)).padStart(2, '0')}/${String(s.ids.length).padStart(2, '0')}` : ''}</span></span>
      <div class="pager" role="tablist">${PAGES.map((l, i) => html`<button role="tab" data-np="page" data-p="${i}" aria-label="${l}"><i></i></button>`)}</div>
      <span class="np-tr mono" id="npstr" aria-live="polite"></span>
      <button class="iconbtn" data-np="eq" aria-label="Sound and EQ">${icon('eq')}</button>
      <button class="iconbtn" data-np="sleep" aria-label="Sleep timer">${icon('moon')}</button>
      <button class="iconbtn" data-np="queue" aria-label="Queue">${icon('queue')}</button>
      <button class="iconbtn" data-np="more" aria-label="More">${icon('more')}</button>
    </div>

    <div class="np-pages" id="nppages">
      <section class="npp npp-info" aria-label="Info">
        <div class="np-infotop">
        <div class="np-head">
          <button class="np-art1" data-np="art" aria-label="Double-tap to star">${art(t.art_key, { size: 'f' })}<span class="np-star">${icon('starOn')}</span></button>
          <div class="np-spec mono">
            <div data-np="explain" data-k="format"><span>FORMAT</span><b>${fmtName(t) || '—'}</b></div>
            <div data-np="explain" data-k="depth"><span>DEPTH</span><b>${t.bits ? `${t.bits} BIT` : '—'}</b></div>
            <div data-np="explain" data-k="rate"><span>RATE</span><b>${t.sample_rate ? `${khz(t.sample_rate)} KHZ` : '—'}</b></div>
            <div data-np="explain" data-k="bitrate"><span>BITRATE</span><b>${t.bitrate ? `${t.bitrate} K` : '—'}</b></div>
            <div data-np="explain" data-k="output"><span>OUT</span><b class="np-outk">—</b></div>
            <div data-np="explain" data-k="replaygain"><span>RG</span><b>${rg.db == null ? (rg.mode === 'off' ? 'OFF' : 'NO TAG') : dbText(rg.db)}</b></div>
          </div>
        </div>
        <div class="np-albumline mono"><span class="red">${t.track_no ? String(t.track_no).padStart(2, '0') : '—'}</span><button class="ellipsis" data-np="album">${albumLine.toUpperCase()}</button><span class="np-count">${s.ids.length ? `${String(Math.max(1, pos + 1)).padStart(2, '0')} / ${String(s.ids.length).padStart(2, '0')}` : ''}</span></div>
        <div class="np-titlerow"><div class="grow"><div class="np-title">${titleOf(t)}</div><button class="np-artist" data-np="artist">${t.artist || 'Unknown artist'}</button></div>
          <button class="iconbtn ${starred ? 'on' : ''}" data-np="star" aria-label="${starred ? 'Unstar' : 'Star'}">${icon(starred ? 'starOn' : 'star')}</button></div>
        <div class="np-wave" id="npwave" role="slider" tabindex="0" aria-label="Seek" data-noswipe><div class="np-wbars" id="npwbars"></div><i class="np-head-line"></i></div>
        <div class="np-times mono"><span class="np-p">0:00</span><span class="np-r"></span></div>
        </div>
        <div class="np-next"><div class="lbl">Up next</div><div id="npnext"></div></div>
      </section>

      <section class="npp npp-cover" aria-label="Cover">
        <div class="np-coverbox"><button class="np-cover" data-np="cover" aria-label="Tap for lyrics, double-tap to star">${art(t.art_key, { size: 'f' })}<span class="np-star">${icon('starOn')}</span><div class="np-lyrics" id="nplyrics" hidden></div></button></div>
        <div class="np-cmeta"><div class="grow"><div class="np-ctitle ellipsis">${titleOf(t)}</div><button class="np-artist ellipsis" data-np="artist">${t.artist || 'Unknown artist'}</button></div><div class="np-cside"><span class="mono">${q}</span></div></div>
        <div class="np-bar" id="npbar" role="slider" tabindex="0" aria-label="Seek" data-noswipe><i></i><b></b></div>
        <div class="np-times np-ctimes mono"><span class="np-p">0:00</span><button class="np-lyrbtn mono" data-np="lyrics" id="nplyrbtn" aria-pressed="false">${icon('list')}<span>Lyrics</span></button><span class="np-r"></span></div>
      </section>

      <section class="npp npp-signal" aria-label="Signal">
        <div class="np-sline"><span class="ellipsis">${titleOf(t)} <span class="muted">— ${t.artist || ''}</span></span><span class="mono np-p"></span></div>
        <canvas class="np-sgram" id="npspec" aria-hidden="true" data-np="explain" data-k="spectrum"></canvas>
        <div class="np-freq mono"><span>40</span><span>160</span><span>640</span><span>2.5K</span><span>10K</span><span>16K HZ</span></div>
        <div class="np-lr mono" data-np="explain" data-k="levels"><span>L</span><canvas id="npml" aria-hidden="true"></canvas><span id="npdbl">—</span><span>R</span><canvas id="npmr" aria-hidden="true"></canvas><span id="npdbr">—</span></div>
        <div class="np-sigmid" data-noswipe>
          <div class="np-knobcol">
            <div class="knob" id="npknob" role="slider" tabindex="0" aria-label="Volume" aria-valuemin="0" aria-valuemax="15" aria-valuenow="0" data-noswipe>
              <svg viewBox="0 0 100 100"><g id="npticks"></g>
                <circle class="trk" cx="50" cy="50" r="40" stroke-dasharray="188.5 999" transform="rotate(135 50 50)"/>
                <circle class="val" id="nparc" cx="50" cy="50" r="40" stroke-dasharray="0 999" transform="rotate(135 50 50)"/></svg>
              <div class="cap" id="npcap"><i></i></div>
            </div>
            <div class="np-kv mono" id="npvol">–</div>
            <div class="np-ko mono" id="npvolout"></div>
          </div>
          <div class="np-dsp" id="npdsp"></div>
        </div>
        <div class="np-stats mono" id="nppath"></div>
      </section>
    </div>

    <div class="np-volpop" id="npvolpop" hidden data-noswipe role="group" aria-label="Volume">
      <div class="np-vp-h mono"><span>Volume</span><span id="npvpout"></span></div>
      <div class="np-vp-row">
        <button class="np-vp-b" data-np="voldown" aria-label="Volume down">${icon('minus')}</button>
        <div class="np-stepbars" id="npstepbars" role="slider" tabindex="0" aria-label="Volume"></div>
        <button class="np-vp-b" data-np="volup" aria-label="Volume up">${icon('plus')}</button>
      </div>
    </div>
    <div class="np-util">
      <button data-np="shuffle" aria-label="Shuffle">${icon('shuffle')}<span>Shuffle</span></button>
      <button data-np="repeat" aria-label="Repeat">${icon('repeat')}<span id="nprep">Repeat</span></button>
      <button data-np="vol" aria-label="Volume" aria-expanded="false">${icon('speaker')}<span>Vol <b id="npvoln">–</b></span></button>
    </div>
    <div class="np-ctl">
      <button class="big" data-np="prev" aria-label="Previous (hold to rewind)">${icon('prev')}</button>
      <button class="playbtn" data-np="toggle" aria-label="Play or pause">${icon(s.playing ? 'pause' : 'play')}</button>
      <button class="big" data-np="next" aria-label="Next (hold to fast-forward)">${icon('next')}</button>
    </div>
  </div>`);
  lastSec = -1; lastWaveIdx = -1; lastLyric = -1; meterColors = null; lyrics = parseLyrics(t); lyricsOpen = false;
  $('#nplyrbtn', npEl).classList.toggle('none', !lyrics);
  const pages = $('#nppages', npEl);
  pages.addEventListener('scroll', onPagesScroll, { passive: true });
  requestAnimationFrame(() => { if (!isWide()) pages.scrollLeft = page * pages.clientWidth; });
  bindScrub($('#npwave', npEl));
  bindScrub($('#npbar', npEl));
  bindHold($('[data-np=prev]', npEl), -1);
  bindHold($('[data-np=next]', npEl), 1);
  loadWave(t);
  renderUpNext();
  vol = native.volume();
  bindKnob(); bindSteps(); renderVol(); bindVolPopClose(); renderDsp();
  updateNpState();
}

function updateNpState() {
  if (!npEl) return;
  $('[data-np=toggle]', npEl).innerHTML = String(icon(s.playing ? 'pause' : 'play'));
  $('[data-np=shuffle]', npEl).classList.toggle('on', !!s.shuffle);
  const rp = $('[data-np=repeat]', npEl);
  rp.classList.toggle('on', s.repeat > 0); rp.dataset.mode = s.repeat;
  $('[data-np=sleep]', npEl).classList.toggle('on', !!s.sleepAt);
  npEl.dataset.page = page;
  $$('[data-np=page]', npEl).forEach((b, i) => { b.classList.toggle('on', i === page); b.setAttribute('aria-selected', i === page); });
  $('#nprep', npEl).textContent = ['Repeat', 'Repeat 1', 'Repeat all'][s.repeat || 0];
  renderStatus();
  renderPath();
}

/** The thin DAP status line under the top bar: state, queue position, panel, format, output, sleep timer. */
function renderStatus() {
  if (!npEl || !cur) return;
  const led = $('#npled', npEl);
  led.classList.toggle('on', !!s.playing);
  led.title = statusText();
  $('#npstr', npEl).textContent = PAGES[page] || '';
  $('[data-np=eq]', npEl).classList.toggle('on', !!dsp().eq);
}
const statusText = () => (s.state === 'buffering' ? 'Loading' : s.playing ? 'Playing' : s.state === 'ended' ? 'Stopped' : 'Paused');

function onPagesScroll(e) {
  const el = e.currentTarget;
  const p = Math.round(el.scrollLeft / Math.max(1, el.clientWidth));
  if (p !== page && p >= 0 && p < PAGES.length) { page = p; setMeta('np_page', p); updateNpState(); }
}
function goPage(p) {
  const el = $('#nppages', npEl);
  page = p; setMeta('np_page', p);
  el.scrollTo({ left: p * el.clientWidth, behavior: 'smooth' });
  updateNpState();
}

// ---------------------------------------------------------------- up next

function renderUpNext() {
  const box = npEl && $('#npnext', npEl);
  if (!box) return;
  const next = s.order.slice(1, 6);
  if (!next.length) { box.innerHTML = String(html`<div class="np-nrow muted">${s.repeat === 2 ? 'Repeating the queue' : 'End of queue'}</div>`); return; }
  const rows = repo.tracksByIds(next.map((qi) => s.ids[qi]));
  const byId = new Map(rows.map((r) => [r.id, r]));
  box.innerHTML = String(html`${next.map((qi, n) => {
    const t = byId.get(s.ids[qi]);
    if (!t) return '';
    return html`<button class="np-nrow" data-np="jump" data-qi="${qi}" style="opacity:${[1, .85, .65, .45, .3][n]}"><span class="mono n">${t.track_no ? String(t.track_no).padStart(2, '0') : '—'}</span><span class="ellipsis">${titleOf(t)}</span><span class="mono">${dur(t.duration_ms)}</span></button>`;
  })}`);
}

// ---------------------------------------------------------------- waveform scrubber

const WAVE_BARS = 96;
const waveCache = new Map();
let wave = null;
async function loadWave(t) {
  wave = waveCache.get(t.id) || null;
  drawWaveBars();
  if (wave) return;
  const id = t.id;
  const peaks = await native.waveform(t);
  if (!peaks || !peaks.length) return;
  // resample to the number of bars (max of each slice keeps transients visible)
  const out = [];
  for (let i = 0; i < WAVE_BARS; i++) {
    const a = Math.floor(i * peaks.length / WAVE_BARS), b = Math.max(a + 1, Math.floor((i + 1) * peaks.length / WAVE_BARS));
    let m = 0; for (let k = a; k < b; k++) m = Math.max(m, peaks[k]);
    out.push(m);
  }
  waveCache.set(id, out);
  if (cur && cur.id === id) { wave = out; drawWaveBars(); }
}
function drawWaveBars() {
  const box = npEl && $('#npwbars', npEl);
  if (!box) return;
  const vals = wave || Array(WAVE_BARS).fill(0.06);
  box.classList.toggle('flat', !wave);
  box.innerHTML = vals.map((v) => `<i style="height:${Math.round(8 + v * 92)}%"></i>`).join('');
  lastWaveIdx = -1;
}
function paintWave(f) {
  const box = npEl && $('#npwbars', npEl);
  if (!box) return;
  f = Math.max(0, Math.min(1, f || 0));
  // The red playhead and the bar it is crossing move every frame; whole bars only re-colour when passed.
  const head = $('.np-head-line', npEl);
  if (head) head.style.transform = `translateX(${(f * box.clientWidth).toFixed(1)}px)`;
  const kids = box.children, n = kids.length;
  if (!n) return;
  const exact = f * n, idx = Math.floor(exact);
  if (idx !== lastWaveIdx) {
    const lo = Math.min(idx, lastWaveIdx < 0 ? 0 : lastWaveIdx), hi = lastWaveIdx < 0 ? n : Math.max(idx, lastWaveIdx) + 1;
    for (let i = lo; i < hi && i < n; i++) { kids[i].classList.toggle('on', i < idx); kids[i].classList.toggle('cur', i === idx); }
    lastWaveIdx = idx;
  }
  if (idx < n) kids[idx].style.setProperty('--p', ((exact - idx) * 100).toFixed(1) + '%');
}

/** Drag (or tap) along the waveform / progress bar to seek; arrow keys skip 10 s. */
function bindScrub(el) {
  if (!el) return;
  const at = (e) => { const r = el.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * (s.dur || 0); };
  el.addEventListener('pointerdown', (e) => {
    if (!s.dur) return;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    seeking = true; scrubMs = at(e); lastSec = -1;
  });
  el.addEventListener('pointermove', (e) => { if (seeking) { scrubMs = at(e); lastSec = -1; } });
  const end = () => {
    if (!seeking) return;
    native.seek(scrubMs); s.pos = scrubMs; recvAt = performance.now();
    seeking = false; lastSec = -1;
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('keydown', (e) => {
    const d = { ArrowRight: 10000, ArrowLeft: -10000 }[e.key];
    if (d) { e.preventDefault(); skipBy(d); }
  });
}

function skipBy(ms) {
  const p = Math.max(0, Math.min((s.dur || 0) - 500, position() + ms));
  native.seek(p); s.pos = p; recvAt = performance.now(); lastSec = -1;
}

/** Hold previous/next: skip 10 s every ~0.3 s while held. A short tap still changes track. */
function bindHold(btn, dir) {
  let t1 = 0, t2 = 0, held = false;
  const stop = () => { clearTimeout(t1); clearInterval(t2); };
  btn.addEventListener('pointerdown', () => {
    held = false;
    t1 = setTimeout(() => { held = true; native.haptic('tick'); skipBy(dir * 10000); t2 = setInterval(() => skipBy(dir * 10000), 300); }, 420);
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => btn.addEventListener(ev, stop));
  btn.addEventListener('click', (e) => { if (held) { held = false; e.stopPropagation(); e.preventDefault(); } }, true);
}

// ---------------------------------------------------------------- gestures

function bindGestures() {
  let g = null;
  const el = npEl;
  el.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1 || e.target.closest('[data-noswipe]')) { g = null; return; }
    const panel = e.target.closest('.npp');
    const x = e.touches[0].clientX, y = e.touches[0].clientY;
    g = { x, y, t: Date.now(), top: !panel || panel.scrollTop <= 0, bottom: !panel || panel.scrollTop + panel.clientHeight >= panel.scrollHeight - 2, drag: false, dy: 0 };
  }, { passive: true });
  // Pulling down from the top: the screen follows your finger, then either drops away or springs back.
  el.addEventListener('touchmove', (e) => {
    if (!g || !g.top || e.touches.length !== 1) return;
    const dx = e.touches[0].clientX - g.x, dy = e.touches[0].clientY - g.y;
    if (!g.drag) {
      if (dy > 12 && dy > Math.abs(dx) * 1.4) { g.drag = true; el.style.transition = 'none'; }
      else if (Math.abs(dx) > 12) { g.top = false; return; }
      else return;
    }
    g.dy = Math.max(0, dy);
    el.style.transform = `translateY(${g.dy}px)`;
    el.style.opacity = String(1 - Math.min(0.35, g.dy / 1400));
  }, { passive: true });
  el.addEventListener('touchend', (e) => {
    if (!g) return;
    const c = e.changedTouches[0];
    const dx = c.clientX - g.x, dy = c.clientY - g.y, dt = Date.now() - g.t;
    if (g.drag) {
      const fast = dy / Math.max(1, dt) > 0.6;
      if (dy > 110 || (fast && dy > 40)) closeNowPlaying();
      else { el.style.transition = 'transform .22s cubic-bezier(.2, .8, .2, 1), opacity .22s'; el.style.transform = ''; el.style.opacity = ''; }
      g = null;
      return;
    }
    const vertical = Math.abs(dy) > 90 && Math.abs(dx) < Math.abs(dy) * 0.6 && dt < 700;
    if (vertical && dy > 0 && g.top) closeNowPlaying();
    else if (vertical && dy < 0 && g.bottom) openQueue();
    g = null;
  }, { passive: true });
  el.addEventListener('touchcancel', () => {
    if (g?.drag) { el.style.transition = 'transform .22s ease-out'; el.style.transform = ''; el.style.opacity = ''; }
    g = null;
  }, { passive: true });
}

let lastTap = 0, tapTimer = 0;
function coverTap(kind) {
  const now = Date.now();
  if (now - lastTap < 300) { clearTimeout(tapTimer); lastTap = 0; starCurrent(true); return; }
  lastTap = now;
  if (kind === 'cover') tapTimer = setTimeout(toggleLyrics, 300);
}
function starCurrent(flash) {
  if (!cur) return;
  const on = repo.toggleStar(cur.id) !== false && repo.isStarred(cur.id);
  native.haptic('confirm');
  if (flash) for (const el of $$('.np-art1, .np-cover', npEl)) { el.classList.remove('flash'); void el.offsetWidth; el.classList.toggle('flash', on); }
  const b = $('[data-np=star]', npEl);
  if (b) { b.classList.toggle('on', on); b.innerHTML = String(icon(on ? 'starOn' : 'star')); b.setAttribute('aria-label', on ? 'Unstar' : 'Star'); }
  toast(on ? 'Starred' : 'Unstarred', { ms: 1400 });
}

// ---------------------------------------------------------------- lyrics (from the file's tags)

let lyrics = null, lyricsOpen = false;
/** LYRICS / UNSYNCEDLYRICS tags. Lines with [mm:ss.xx] stamps (LRC) are timed and follow playback. */
export function parseLyrics(t) {
  let tags = {};
  try { tags = JSON.parse(t.tags || '{}'); } catch { return null; }
  const up = {};
  for (const [k, v] of Object.entries(tags)) up[k.toUpperCase()] = Array.isArray(v) ? v.join('\n') : v;
  const txt = String(up.LYRICS || up.SYNCEDLYRICS || up.UNSYNCEDLYRICS || up['UNSYNCED LYRICS'] || '');
  if (!txt.trim()) return null;
  let lines = [], timed = false;
  for (const rawLine of txt.split(/\r?\n/)) {
    const re = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
    const stamps = [];
    let m;
    while ((m = re.exec(rawLine))) stamps.push((Number(m[1]) * 60 + Number(m[2])) * 1000 + (m[3] ? Number(m[3].padEnd(3, '0')) : 0));
    const text = rawLine.replace(/\[[^\]]*\]/g, '').trim();
    if (stamps.length) { timed = true; for (const ms of stamps) lines.push({ ms, text }); }
    else if (!/^\[[a-z]+:.*\]$/i.test(rawLine.trim())) lines.push({ ms: null, text });
  }
  if (timed) lines = lines.filter((l) => l.ms != null).sort((a, b) => a.ms - b.ms);
  while (lines.length && !lines[0].text) lines.shift();
  return lines.length ? { timed, lines } : null;
}
function toggleLyrics() {
  if (!lyrics) { toast('No lyrics in this file’s tags', { ms: 1800 }); return; }
  lyricsOpen = !lyricsOpen;
  const box = $('#nplyrics', npEl), cover = $('.np-cover', npEl), btn = $('#nplyrbtn', npEl);
  box.hidden = !lyricsOpen;
  cover.classList.toggle('lyr', lyricsOpen); // the artwork is swapped out for the lyrics, same space
  btn.classList.toggle('on', lyricsOpen);
  btn.setAttribute('aria-pressed', lyricsOpen);
  btn.innerHTML = String(html`${icon(lyricsOpen ? 'image' : 'list')}<span>${lyricsOpen ? 'Cover' : 'Lyrics'}</span>`);
  if (lyricsOpen) {
    box.innerHTML = String(html`<div class="np-lyrin">${lyrics.lines.map((l, i) => html`<p data-i="${i}">${l.text || '·'}</p>`)}</div>`);
    box.classList.toggle('timed', lyrics.timed);
    lastLyric = -1;
  }
}
function paintLyrics(p) {
  if (!lyricsOpen || !lyrics?.timed) return;
  let i = -1;
  for (let k = 0; k < lyrics.lines.length && lyrics.lines[k].ms <= p + 150; k++) i = k;
  if (i === lastLyric) return;
  const box = $('#nplyrics', npEl);
  box.querySelector('p.on')?.classList.remove('on');
  const el = i >= 0 ? box.querySelector(`p[data-i="${i}"]`) : null;
  if (el) { el.classList.add('on'); box.scrollTo({ top: el.offsetTop - box.clientHeight / 2 + el.clientHeight / 2, behavior: lastLyric < 0 ? 'auto' : 'smooth' }); }
  lastLyric = i;
}

// ---------------------------------------------------------------- signal path

/** Signal panel facts under the controls: output, decode, peak hold, ReplayGain tags, plays, queue left. */
function renderPath() {
  if (!npEl || !cur) return;
  const t = cur, o = outLabel(vol?.out);
  for (const el of $$('.np-outk', npEl)) el.textContent = o ? o.kind.toUpperCase() : native.isWeb ? 'SYSTEM' : '—';
  const box = $('#nppath', npEl);
  if (!box) return;
  const reduced = t.lossless && (t.bits || 16) > 16;
  const g = (v) => (v == null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)}`);
  const pl = db.get('SELECT COUNT(*) n, MAX(at) last FROM plays WHERE track_id=?', [t.id]) || { n: 0 };
  const left = queueLeft();
  const cell = (k, label, val, cls = '', id = '') => html`<button class="np-stat ${cls}" data-np="explain" data-k="${k}"><span>${label}</span><b ${id ? html`id="${id}"` : ''}>${val}</b></button>`;
  box.innerHTML = String(html`
    ${cell('output', 'Output', o ? `${o.kind.toUpperCase()}${vol.out.kind === 'usb' && vol.out.rate ? ` ≤${khz(vol.out.rate)}K` : ''}` : native.isWeb ? 'SYSTEM' : '—')}
    ${cell('decode', 'Decode', native.isWeb ? 'BROWSER' : reduced ? '16-BIT · REDUCED' : t.lossless ? '16-BIT · EXACT' : 'PCM 16-BIT', reduced && !native.isWeb ? 'warn' : '')}
    ${cell('peak', 'Peak hold', peakText(), '', 'nppeak')}
    ${cell('replaygain', 'RG track / album', t.rg_track == null && t.rg_album == null ? 'NO TAGS' : `${g(t.rg_track)} / ${g(t.rg_album)} DB`)}
    ${cell('plays', 'Plays', pl.n ? `${pl.n} · ${ago(pl.last).toUpperCase()}` : 'FIRST LISTEN')}
    ${cell('queueleft', 'Queue left', left.n ? `${Math.max(1, Math.round(left.ms / 60000))} MIN · ${left.n} TRK` : `${Math.max(0, Math.round(left.ms / 60000))} MIN`)}`);
}

function queueLeft() {
  const rest = s.order.slice(1).map((qi) => s.ids[qi]);
  let ms = Math.max(0, (cur?.duration_ms || 0) - position());
  if (rest.length) for (const r of repo.tracksByIds(rest)) ms += r.duration_ms || 0;
  return { ms, n: rest.length };
}

let peakHold = 0, peakId = null;
const peakText = () => (peakHold > 0.01 ? `${(peakHold * 48 - 48).toFixed(1).replace('-', '−')} DB` : '—');

// ---------------------------------------------------------------- click handling

async function onNpClick(e) {
  const b = e.target.closest('[data-np]');
  if (!b) return;
  const a = b.dataset.np;
  if (a !== 'art' && a !== 'cover') native.haptic('tick');
  switch (a) {
    case 'close': return closeNowPlaying();
    case 'vol': return toggleVolPop();
    case 'volup': volPopTouched(); return vol && stepTo(vol.cur + 1);
    case 'voldown': volPopTouched(); return vol && stepTo(vol.cur - 1);
    case 'page': return goPage(+b.dataset.p);
    case 'toggle': native.toggle(); s.playing = !s.playing; return renderNp(false);
    case 'prev': return native.prev();
    case 'next': return native.next();
    case 'shuffle': native.setShuffle(!s.shuffle); s.shuffle = !s.shuffle; return renderNp(false);
    case 'repeat': { const m = ((s.repeat || 0) + 1) % 3; native.setRepeat(m); s.repeat = m; toast(['Repeat off', 'Repeat one', 'Repeat all'][m], { ms: 1200 }); return renderNp(false); }
    case 'star': return starCurrent(false);
    case 'art': return coverTap('art');
    case 'cover': return coverTap('cover');
    case 'lyrics': return toggleLyrics();
    case 'jump': return native.jump(+b.dataset.qi);
    case 'artist': closeNowPlaying(); return go('artist', albumArtistOf(cur));
    case 'album': closeNowPlaying(); return go('album', cur.album_key);
    case 'queue': return openQueue();
    case 'sleep': return sleepMenu();
    case 'eq': return openEq();
    case 'explain': return explain(b.dataset.k);
    case 'eqon': setDsp({ eq: !dsp().eq }); return toast(dsp().eq ? `EQ on · ${eqLabel()}` : 'EQ off', { ms: 1200 });
    case 'xfeed': setDsp({ xfeed: !dsp().xfeed }); return toast(dsp().xfeed ? 'Crossfeed on' : 'Crossfeed off', { ms: 1200 });
    case 'mono': setDsp({ mono: !dsp().mono }); return toast(dsp().mono ? 'Mono' : 'Stereo', { ms: 1200 });
    case 'rgmode': {
      const m = { off: 'track', track: 'album', album: 'off' }[meta('rg_mode', 'off')] || 'off';
      setMeta('rg_mode', m); native.setReplayGain(m, Number(meta('rg_preamp', 0)));
      toast(m === 'off' ? 'ReplayGain off' : `ReplayGain · ${m}`, { ms: 1200 });
      renderDsp(); return renderPath();
    }
    case 'center': setDsp({ balance: 0 }); return null;
    case 'more': {
      const starred = repo.isStarred(cur.id);
      const v = await menu(titleOf(cur), [
        { label: starred ? 'Unstar' : 'Star', icon: starred ? 'starOn' : 'star', value: 'star' },
        { label: 'Add to playlist…', icon: 'playlist', value: 'pl' },
        { label: 'Go to album', icon: 'disc', value: 'album' },
        { label: 'Go to artist', icon: 'user', value: 'artist' },
        { label: 'Edit tags', icon: 'tag', value: 'tags', disabled: cur.ext !== 'flac', sub: cur.ext === 'flac' ? null : 'FLAC only' },
        { label: 'File info', icon: 'info', value: 'info' },
        { label: 'Clear queue', icon: 'trash', value: 'clear', danger: true },
      ]);
      if (v === 'star') starCurrent(false);
      if (v === 'pl') pickPlaylist([cur.id]);
      if (v === 'album') { closeNowPlaying(); go('album', cur.album_key); }
      if (v === 'artist') { closeNowPlaying(); go('artist', albumArtistOf(cur)); }
      if (v === 'tags') (await import('./tagedit.js')).openTagEditor([cur.id]);
      if (v === 'info') fileInfo(repo.track(cur.id));
      if (v === 'clear') clearQueueWithUndo();
      return null;
    }
    default: return null;
  }
}

async function sleepMenu() {
  const v = await menu('Sleep timer', [
    { label: '15 minutes', value: 15 }, { label: '30 minutes', value: 30 }, { label: '45 minutes', value: 45 }, { label: '1 hour', value: 60 },
    { label: 'End of this track', value: -1 },
    { label: 'End of this album', value: -2 },
    s.sleepAt ? { label: 'Turn off', value: 0, danger: true } : null,
  ]);
  if (v == null) return;
  native.setSleep(v > 0 ? v * 60000 : v);
  s.sleepAt = v > 0 ? Date.now() + v * 60000 : v;
  toast(v === 0 ? 'Sleep timer off' : v === -1 ? 'Stops after this track' : v === -2 ? 'Stops after this album' : `Fades out and stops in ${v} min`);
  renderNp(false);
}

// ---------------------------------------------------------------- volume (Android media volume, in steps)

let vol = null, volTimer = 0, knobDrag = null, stepDrag = false, warnedCap = false;
const ARC = 188.5; // 3/4 of a circle with r = 40

function refreshVol() {
  const v = native.volume();
  if (!v) return;
  const changed = !vol || v.cur !== vol.cur || v.max !== vol.max || v.fixed !== vol.fixed || JSON.stringify(v.out) !== JSON.stringify(vol.out);
  vol = v;
  if (changed) { renderVol(); renderPath(); renderStatus(); renderDsp(); }
}

function renderVol() {
  if (!npEl) return;
  const k = $('#npknob', npEl), strip = $('#npstepbars', npEl);
  if (!vol) { if (k) k.closest('.np-knobcol').hidden = true; const vb = $('[data-np=vol]', npEl); if (vb) vb.hidden = true; return; }
  const span = Math.max(1, vol.max - vol.min), f = (vol.cur - vol.min) / span;
  const label = vol.fixed ? 'Fixed by the output device' : `${vol.cur} of ${vol.max}`;
  const big = vol.fixed ? 'FIX' : String(vol.cur).padStart(2, '0');
  const o = outLabel(vol.out);
  if (k) { // knob (wide layouts that still show it)
  k.classList.toggle('fixed', !!vol.fixed);
  k.setAttribute('aria-valuemin', vol.min); k.setAttribute('aria-valuemax', vol.max); k.setAttribute('aria-valuenow', vol.cur); k.setAttribute('aria-valuetext', label);
  $('#npcap', npEl).style.setProperty('--rot', (-135 + 270 * f) + 'deg');
  $('#nparc', npEl).setAttribute('stroke-dasharray', `${(ARC * f).toFixed(2)} 999`);
  const g = $('#npticks', npEl);
  const n = span <= 30 ? span : 15;
  if (g.childElementCount !== n + 1) {
    let t = '';
    for (let i = 0; i <= n; i++) {
      const a = (135 + 270 * i / n) * Math.PI / 180, c = Math.cos(a), sn = Math.sin(a);
      t += `<line class="tick" data-f="${i / n}" x1="${(50 + 45 * c).toFixed(2)}" y1="${(50 + 45 * sn).toFixed(2)}" x2="${(50 + 49 * c).toFixed(2)}" y2="${(50 + 49 * sn).toFixed(2)}"/>`;
    }
    g.innerHTML = t;
  }
  for (const l of g.children) l.classList.toggle('on', Number(l.dataset.f) <= f + 1e-6);
  $('#npvol', npEl).innerHTML = String(html`${big}<small>/${vol.max}</small>`);
  $('#npvolout', npEl).innerHTML = o ? String(html`${icon(o.ic)}<span>${o.kind}</span>`) : '';
  }
  // step strip (Info + Cover panels)
  $('#npvolpop', npEl).classList.toggle('fixed', !!vol.fixed);
  $('#npvpout', npEl).textContent = o ? `${o.name} · ${big} / ${vol.max}` : `${big} / ${vol.max}`;
  strip.setAttribute('aria-valuemin', vol.min); strip.setAttribute('aria-valuemax', vol.max); strip.setAttribute('aria-valuenow', vol.cur); strip.setAttribute('aria-valuetext', label);
  const bars = $('#npstepbars', npEl), segs = Math.min(span, 15);
  if (bars.childElementCount !== segs) bars.innerHTML = Array.from({ length: segs }, (_, i) => `<i style="height:${Math.round(35 + 65 * (i + 1) / segs)}%"></i>`).join('');
  const lit = Math.round(f * segs);
  [...bars.children].forEach((b, i) => b.classList.toggle('on', i < lit));
  $('#npvoln', npEl).textContent = big;
}

function stepTo(n) {
  if (!vol || vol.fixed) return;
  n = Math.max(vol.min, Math.min(vol.max, n));
  if (n === vol.cur) return;
  const r = native.setVolume(n);
  if (vol.max <= 30 || n % Math.round(vol.max / 15) === 0) native.haptic('tick');
  if (r) {
    if (r.cur < n && n > vol.cur && !warnedCap) { warnedCap = true; toast('Android is holding headphone volume down. Confirm on the volume panel to go higher.', { ms: 5000 }); }
    vol = r;
  } else vol = { ...vol, cur: n };
  renderVol();
}

function volKeys(e) {
  if (!vol) return;
  const big = Math.max(1, Math.round((vol.max - vol.min) / 5));
  const d = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, PageUp: big, PageDown: -big }[e.key];
  if (d) { e.preventDefault(); stepTo(vol.cur + d); }
  else if (e.key === 'Home') { e.preventDefault(); stepTo(vol.min); }
  else if (e.key === 'End') { e.preventDefault(); stepTo(vol.max); }
}

function bindKnob() {
  const k = npEl && $('#npknob', npEl);
  if (!k || k.dataset.bound) return;
  k.dataset.bound = '1';
  // Hold the knob a moment until it engages (a buzz), then drag up / down or turn it around the centre.
  // Brushing past it never changes the volume.
  k.addEventListener('pointerdown', (e) => {
    if (!vol) return;
    if (vol.fixed) { toast('Volume is controlled by the output device'); return; }
    e.preventDefault();
    k.setPointerCapture(e.pointerId);
    const r = k.getBoundingClientRect();
    knobDrag = { cx: r.left + r.width / 2, cy: r.top + r.height / 2, x: e.clientX, y: e.clientY, a: null, acc: vol.cur, live: false };
    knobDrag.t = setTimeout(() => { if (knobDrag) { knobDrag.live = true; knobDrag.py = knobDrag.y; k.classList.add('drag'); native.haptic('confirm'); } }, 280);
  });
  k.addEventListener('pointermove', (e) => {
    if (!knobDrag || !vol) return;
    const span = Math.max(1, vol.max - vol.min);
    const pxPerStep = Math.max(6, Math.min(16, 150 / span)); // a full sweep is about 150 px of travel
    const dy = e.clientY - knobDrag.y, dx = e.clientX - knobDrag.x;
    if (!knobDrag.live) { if (Math.hypot(dx, dy) > 10) { clearTimeout(knobDrag.t); knobDrag = null; } return; } // moved before it engaged
    // Vertical travel since the last event…
    let steps = -(e.clientY - (knobDrag.py ?? knobDrag.y)) / pxPerStep;
    // …or rotation, when the finger circles the knob.
    const rx = e.clientX - knobDrag.cx, ry = e.clientY - knobDrag.cy;
    if (Math.hypot(rx, ry) > 26) {
      const a = Math.atan2(ry, rx) * 180 / Math.PI;
      if (knobDrag.a != null) {
        let d = a - knobDrag.a; if (d > 180) d -= 360; if (d < -180) d += 360;
        const rot = d / 270 * span;
        if (Math.abs(rot) > Math.abs(steps)) steps = rot; // use whichever motion the finger is really making
      }
      knobDrag.a = a;
    } else knobDrag.a = null;
    knobDrag.py = e.clientY;
    knobDrag.acc = Math.max(vol.min - 0.49, Math.min(vol.max + 0.49, knobDrag.acc + steps));
    stepTo(Math.round(knobDrag.acc));
  });
  const end = () => { if (knobDrag) clearTimeout(knobDrag.t); knobDrag = null; k.classList.remove('drag'); };
  k.addEventListener('pointerup', end);
  k.addEventListener('pointercancel', end);
  k.addEventListener('wheel', (e) => { e.preventDefault(); if (vol) stepTo(vol.cur + (e.deltaY < 0 ? 1 : -1)); }, { passive: false });
  k.addEventListener('keydown', volKeys);
}

function bindSteps() {
  const el = npEl && $('#npstepbars', npEl);
  if (!el || el.dataset.bound) return;
  el.dataset.bound = '1';
  const at = (e) => { const r = el.getBoundingClientRect(); const f = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); return Math.round(vol.min + f * (vol.max - vol.min)); };
  el.addEventListener('pointerdown', (e) => { if (!vol || vol.fixed) return; e.preventDefault(); el.setPointerCapture(e.pointerId); stepDrag = true; volPopTouched(); stepTo(at(e)); });
  el.addEventListener('pointermove', (e) => { if (stepDrag) { volPopTouched(); stepTo(at(e)); } });
  const end = () => { stepDrag = false; };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('keydown', (e) => { volPopTouched(); volKeys(e); });
}

// Volume lives behind a button: tap Vol to open the panel, adjust, and it tucks itself away after 4 s untouched.
let volPopTimer = 0;
function toggleVolPop(force) {
  const pop = npEl && $('#npvolpop', npEl);
  if (!pop) return;
  const open = force ?? pop.hidden;
  pop.hidden = !open;
  $('[data-np=vol]', npEl).classList.toggle('on', open);
  $('[data-np=vol]', npEl).setAttribute('aria-expanded', open);
  clearTimeout(volPopTimer);
  if (open) { refreshVol(); volPopTouched(); }
}
function volPopTouched() {
  clearTimeout(volPopTimer);
  volPopTimer = setTimeout(() => { if (!stepDrag) toggleVolPop(false); }, 4000);
}
function bindVolPopClose() {
  npEl.addEventListener('pointerdown', (e) => {
    const pop = $('#npvolpop', npEl);
    if (pop && !pop.hidden && !e.target.closest('#npvolpop, [data-np=vol]')) toggleVolPop(false);
  }, true);
}

// ---------------------------------------------------------------- spectrum + L/R meters (segmented, like a DAP screen)

const reduceMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
let meterColors = null, lastLv = 0, lastDb = 0;
const shown = new Float32Array(34), peaks = new Float32Array(32);
function sizeCanvas(c) {
  const w = c.clientWidth, h = c.clientHeight;
  if (!w || !h) return null;
  const dpr = window.devicePixelRatio || 1;
  if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  return { g, w, h };
}
function drawMeters() {
  if (!(page === 2 || isWide())) return;
  const c = $('#npspec', npEl);
  if (!c) return;
  const now = performance.now();
  if (now - lastLv < (reduceMotion ? 250 : 33)) return;
  lastLv = now;
  if (!meterColors) {
    const cs = getComputedStyle(npEl);
    meterColors = { on: cs.getPropertyValue('--ink').trim(), off: cs.getPropertyValue('--off').trim(), peak: cs.getPropertyValue('--ink-3').trim(), clip: cs.getPropertyValue('--red').trim() };
  }
  const lv = s.playing ? native.levels() : null;
  if (peakId !== cur?.id) { peakId = cur?.id; peakHold = 0; }
  if (lv) peakHold = Math.max(peakHold, lv.l || 0, lv.r || 0);
  for (let i = 0; i < 34; i++) {
    const target = lv ? (i < 32 ? lv.bands[i] : i === 32 ? lv.l : lv.r) || 0 : 0;
    shown[i] = target > shown[i] ? target : shown[i] * 0.86 + target * 0.14; // fast attack, slow release
    if (i < 32) peaks[i] = shown[i] >= peaks[i] ? shown[i] : Math.max(0, peaks[i] - 0.012);
  }
  const sp = sizeCanvas(c);
  if (sp) {
    const { g, w, h } = sp;
    const seg = 3, gap = 2, rows = Math.floor(h / (seg + gap)), N = 32, bw = (w + 3) / N;
    for (let i = 0; i < N; i++) {
      const x = i * bw, lit = Math.round(shown[i] * rows), pk = Math.round(peaks[i] * rows);
      for (let r = 0; r < rows; r++) {
        const y = h - (r + 1) * (seg + gap) + gap;
        const on = r < lit;
        g.fillStyle = on ? meterColors.on : meterColors.off;
        g.globalAlpha = on ? 0.45 + 0.55 * (r / rows) : 1;
        g.fillRect(x, y, bw - 3, seg);
      }
      if (pk > lit) { g.globalAlpha = 1; g.fillStyle = meterColors.peak; g.fillRect(x, h - pk * (seg + gap) + gap, bw - 3, seg); }
    }
    g.globalAlpha = 1;
  }
  [['#npml', shown[32]], ['#npmr', shown[33]]].forEach(([sel, v]) => {
    const m = sizeCanvas($(sel, npEl));
    if (!m) return;
    const { g, w, h } = m, segs = 40, sw = w / segs;
    for (let i = 0; i < segs; i++) {
      const on = i < Math.round(v * segs);
      g.fillStyle = on ? (i >= segs - 3 ? meterColors.clip : meterColors.on) : meterColors.off;
      g.fillRect(i * sw, 0, sw - 2, h);
    }
  });
  if (now - lastDb > 150) {
    lastDb = now;
    const db = (v) => (v > 0.01 ? (v * 48 - 48).toFixed(1).replace('-', '−') : '—');
    $('#npdbl', npEl).textContent = db(shown[32]);
    $('#npdbr', npEl).textContent = db(shown[33]);
    const pk = $('#nppeak', npEl);
    if (pk) { pk.textContent = peakText(); pk.parentElement.classList.toggle('clip', peakHold * 48 - 48 > -0.5); }
  }
}

// ---------------------------------------------------------------- queue (with undo)

function clearQueueWithUndo() {
  const st = native.playerState();
  const ids = st.ids || [], index = st.index, pos = st.pos || 0, wasPlaying = !!st.playing;
  native.clearQueue();
  closeNowPlaying();
  queueSheet?.close();
  if (!ids.length) return;
  toast('Queue cleared', {
    action: 'Undo', ms: 6000,
    onAction: () => {
      const rows = repo.tracksByIds(ids), byId = new Map(rows.map((r) => [r.id, r]));
      const items = ids.map((id) => byId.get(id)).filter(Boolean).map(queueItem);
      if (items.length) native.setQueue(items, Math.max(0, index), pos, wasPlaying);
    },
  });
}

export function openQueue() {
  queueSheet = openSheet({ title: 'Queue', className: 'queue', body: '', actions: {
    jump: (b) => { native.jump(+b.dataset.qi); },
    qmenu: async (b, e) => {
      e.stopPropagation();
      const i = +b.dataset.qi;
      const v = await menu('Queue', [
        { label: 'Play next', icon: 'queue', value: 'next' },
        { label: 'Move up', icon: 'up', value: 'up' },
        { label: 'Move down', icon: 'down', value: 'down' },
        { label: 'Remove', icon: 'trash', value: 'rm', danger: true },
      ]);
      if (v === 'rm') removeWithUndo(i);
      if (v === 'up' && i > 0) native.moveInQueue(i, i - 1);
      if (v === 'down' && i < s.ids.length - 1) native.moveInQueue(i, i + 1);
      if (v === 'next') native.moveInQueue(i, i > s.index ? s.index + 1 : s.index);
    },
    save: async () => {
      const ids = s.order.map((i) => s.ids[i]);
      const { promptDlg } = await import('./dom.js');
      const name = await promptDlg('Save queue as playlist', { placeholder: 'Name', ok: 'Save' });
      if (!name) return;
      const id = repo.createPlaylist(name.trim());
      repo.addToPlaylist(id, ids);
      toast('Saved', { action: 'Open', onAction: () => { closeNowPlaying(); queueSheet?.close(); go('playlist', id); } });
    },
    clear: () => clearQueueWithUndo(),
  }, footer: html`<button class="btn" data-act="clear">${icon('trash')} Clear</button><button class="btn grow" data-act="save">${icon('playlist')} Save as playlist</button>`, onClose: () => { queueSheet = null; } });
  renderQueue();
}

function removeWithUndo(i) {
  const id = s.ids[i];
  const t = repo.track(id);
  native.removeFromQueue(i);
  if (!t) return;
  toast(`Removed “${titleOf(t)}”`, {
    action: 'Undo', ms: 5000,
    onAction: () => {
      native.addToQueue([queueItem(t)], false);
      // it was appended at the end; move it back to where it was
      setTimeout(() => { const n = native.playerState().ids?.length || 0; if (n > 0 && i < n - 1) native.moveInQueue(n - 1, i); }, 150);
    },
  });
}

function renderQueue() {
  if (!queueSheet) return;
  const rows = repo.tracksByIds(s.ids);
  const byId = new Map(rows.map((t) => [t.id, t]));
  const order = s.order.length ? s.order : s.ids.map((_, i) => i);
  const body = html`<div class="tlist">${order.map((qi, n) => {
    const t = byId.get(s.ids[qi]);
    if (!t) return '';
    return html`<div class="trk ${qi === s.index ? 'playing' : ''}" data-act="jump" data-qi="${qi}">
      ${art(t.art_key, { cls: 'sm' })}
      <div class="main"><div class="t ellipsis">${titleOf(t)}</div><div class="s ellipsis">${n === 0 ? 'Now playing · ' : ''}${t.artist || ''}</div></div>
      <span class="d num">${dur(t.duration_ms)}</span>
      ${qi !== s.index ? html`<button class="iconbtn sm" data-act="qmenu" data-qi="${qi}" aria-label="Options">${icon('more')}</button>` : html`<span class="iconbtn sm">${icon('wave')}</span>`}
    </div>`;
  })}</div>${s.shuffle ? html`<p class="tiny muted">Shuffle is on — this is the order tracks will play in.</p>` : ''}`;
  queueSheet.setBody(body);
}

export const currentState = () => s;

// ---------------------------------------------------------------- sound tiles (Signal panel)

function dspLine() {
  const d = dsp(), bits = [];
  if (d.eq) bits.push(`EQ ${eqLabel(d).toUpperCase()}`);
  if (d.xfeed) bits.push('CROSSFEED');
  if (d.mono) bits.push('MONO');
  if (d.balance) bits.push(`BAL ${d.balance < 0 ? 'L' : 'R'}${Math.round(Math.abs(d.balance) * 100)}`);
  const rg = rgInfo();
  if (rg.mode !== 'off') bits.push(`RG ${rg.mode.toUpperCase()} ${rg.db == null ? 'NO TAG' : dbText(Math.min(0, rg.db))}`);
  return bits.join(' · ') || 'BYPASS';
}

/** The Signal panel's controls: EQ (with its curve), ReplayGain, crossfeed, mono, volume, balance. */
function renderDsp() {
  const box = npEl && $('#npdsp', npEl);
  if (!box || !cur) return;
  const d = dsp(), rg = meta('rg_mode', 'off'), bal = Math.round(d.balance * 100);
  const tile = (act, label, val, on, extra = '') => html`<button class="np-tile ${on ? 'on' : ''}" data-np="${act}" aria-pressed="${!!on}"><span class="k">${label}</span><b>${val}</b>${extra}</button>`;
  box.innerHTML = String(html`
    <button class="np-tile np-eqtile ${d.eq ? 'on' : ''}" data-np="eq" aria-label="Equaliser: ${eqLabel(d)}">
      <span class="k">EQ<i class="sw" data-np="eqon" role="switch" aria-checked="${!!d.eq}" aria-label="EQ on or off"></i></span>
      <b class="ellipsis">${eqLabel(d)}</b>
      <svg viewBox="0 0 300 80" preserveAspectRatio="none" aria-hidden="true"><path class="mid" d="M0 40H300"/><path class="crv" d="${curvePath(d.eq ? d.gains : [0, 0, 0, 0, 0, 0, 0, 0, 0, 0])}"/></svg>
    </button>
    ${tile('rgmode', 'Replay gain', rg === 'off' ? 'Off' : rg === 'track' ? 'Track' : 'Album', rg !== 'off')}
    ${tile('xfeed', 'Crossfeed', d.xfeed ? 'On' : 'Off', d.xfeed)}
    ${tile('mono', 'Channels', d.mono ? 'Mono' : 'Stereo', d.mono)}
    <div class="np-bal mono"><span>L</span><input type="range" id="npbal" min="-100" max="100" step="5" value="${bal}" aria-label="Balance"><span>R</span><button data-np="center" class="bv">${bal === 0 ? 'C' : bal < 0 ? `L${-bal}` : `R${bal}`}</button></div>`);
  $('#npbal', box).addEventListener('input', (e) => {
    const v = Number(e.target.value) / 100;
    setDsp({ balance: Math.abs(v) < 0.03 ? 0 : v }, { quiet: true });
    const n = Math.round(dsp().balance * 100);
    $('.bv', box).textContent = n === 0 ? 'C' : n < 0 ? `L${-n}` : `R${n}`;
  });
  $('#npbal', box).addEventListener('change', () => { renderPath(); });
}
onDsp(() => { if (!npEl) return; renderDsp(); renderPath(); renderStatus(); });
document.addEventListener('hibiki:closenp', () => { if (npEl) closeNowPlaying({ animate: false }); });
