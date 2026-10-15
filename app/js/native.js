// Wrapper around the Android bridge (window.HibikiNative) with browser fallbacks, so the same UI runs on
// the phone and in a desktop browser for development (with a simulated player and demo library).
const N = typeof window !== 'undefined' ? window.HibikiNative : null;
export const isNative = !!N;

const cbs = new Map();
let seq = 0;
if (typeof window !== 'undefined') {
  window.__hibikiCb = (id, json) => {
    const f = cbs.get(id); cbs.delete(id);
    if (f) f(typeof json === 'string' ? JSON.parse(json) : json);
  };
}
function callAsync(fn, ...args) {
  return new Promise((resolve, reject) => {
    const id = 'c' + ++seq;
    cbs.set(id, (r) => (r && r.error ? reject(new Error(r.error)) : resolve(r)));
    try { N[fn](id, ...args); } catch (e) { cbs.delete(id); reject(e); }
  });
}
const sync = (fn, ...a) => { const r = JSON.parse(N[fn](...a)); if (r && r.error) throw new Error(r.error); return r; };

export function info() {
  if (!N) return { appVersion: 'web', versionCode: 0, webVersion: window.HIBIKI_WEB_VERSION || 'dev', webSource: 'browser', native: false };
  return { ...sync('info'), native: true };
}
export function openAppSettings() { if (N) N.openAppSettings(); }

// ---------------------------------------------------------------- library

/** True in the iPhone / browser web app (files live in browser storage, no folders, no tag writing). */
export const isWeb = !!(N && N.web);
export function pickFolder({ directory = false } = {}) {
  if (N && directory && N.pickDirectory) return callAsync('pickDirectory');
  if (N) return callAsync('pickFolder');
  return Promise.resolve({ cancelled: true, browser: true });
}
export function removeRoot(uri) { return N ? sync('removeRoot', uri) : { ok: true }; }
export function lostRoots() { return N ? sync('lostRoots').lost : []; }

const scanListeners = new Set();
export function onScan(fn) { scanListeners.add(fn); return () => scanListeners.delete(fn); }
if (typeof window !== 'undefined') window.hibikiOnScan = (s) => { for (const f of scanListeners) try { f(s); } catch (e) { console.error(e); } };
export function scan(force = false) { return N ? sync('scan', !!force) : { started: false }; }
export function scanStatus() { return N ? JSON.parse(N.scanStatus()) : { phase: 'idle' }; }
export function scanning() { return N ? N.scanning() : false; }

export function writeTags(edits) {
  if (N) return callAsync('writeTags', JSON.stringify(edits));
  return import('../dev/devnative.js').then((m) => m.writeTags(edits));
}
export function cacheArt(b64) { return N ? sync('cacheArt', b64) : { key: 'b64:' + b64.slice(0, 32), w: 0, h: 0, dataUrl: 'data:image/jpeg;base64,' + b64 }; }

/** GET through the app (MusicBrainz / Cover Art Archive only). */
export async function http(url, { binary = false } = {}) {
  if (N) return callAsync('http', url, !!binary);
  const r = await fetch(url, { headers: { Accept: binary ? 'image/*' : 'application/json' } });
  if (!binary) return { status: r.status, body: await r.text() };
  const buf = new Uint8Array(await r.arrayBuffer());
  let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return { status: r.status, mime: r.headers.get('content-type'), b64: btoa(s) };
}

// ---------------------------------------------------------------- art

const devArt = new Map();
/** URL for cached album art. size 't' = 320 px thumbnail, 'f' = full (1200 px). */
export function artUrl(key, size = 't') {
  if (!key) return null;
  if (N && N.artUrl) return N.artUrl(key, size);
  if (key.startsWith('b64:')) return devArt.get(key) || null;
  if (N) return `https://appassets.androidplatform.net/files/art/${size}_${key}.jpg`;
  return demoArt(key);
}
export function rememberDevArt(key, dataUrl) { devArt.set(key, dataUrl); }

/** Deterministic placeholder covers for the browser demo library. */
function demoArt(key) {
  if (devArt.has(key)) return devArt.get(key);
  let h = 0; for (const c of key) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const hue = h % 360, hue2 = (hue + 40 + (h >> 8) % 80) % 360, shape = (h >> 4) % 3;
  const fig = shape === 0 ? `<circle cx="60" cy="64" r="26" fill="hsl(${hue2} 55% 82%)" opacity=".9"/>`
    : shape === 1 ? `<rect x="30" y="34" width="60" height="60" fill="none" stroke="hsl(${hue2} 50% 85%)" stroke-width="5"/>`
    : `<path d="M10 92 C40 40 80 40 110 92" fill="none" stroke="hsl(${hue2} 50% 85%)" stroke-width="6"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 45% 38%)"/><stop offset="1" stop-color="hsl(${hue2} 40% 22%)"/></linearGradient></defs><rect width="120" height="120" fill="url(#g)"/>${fig}</svg>`;
  const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  devArt.set(key, url);
  return url;
}

// ---------------------------------------------------------------- player

const playerListeners = new Set();
let lastState = { connected: false, ids: [], order: [] };
export function onPlayer(fn) { playerListeners.add(fn); return () => playerListeners.delete(fn); }
function emit(s) {
  if (s.ids === undefined) s = { ...s, ids: lastState.ids, order: lastState.order };
  lastState = s;
  for (const f of playerListeners) try { f(s); } catch (e) { console.error(e); }
}
if (typeof window !== 'undefined') window.hibikiOnPlayer = (s) => emit(s);

let dev = null, devLoading = null;
function devPlayer() {
  if (!devLoading) devLoading = import('../dev/devnative.js').then((m) => (dev = m.createDevPlayer(emit)));
  return devLoading;
}

/** Latest player state. On the phone the position is extrapolated from the last sample. */
export function playerState() {
  if (N) {
    const s = JSON.parse(N.playerState());
    if (s.ids === undefined) { s.ids = lastState.ids; s.order = lastState.order; }
    return s;
  }
  return dev ? dev.state() : lastState;
}

const P = (fn, ...a) => { if (N) N[fn](...a); else devPlayer().then((d) => d[fn](...a)); };
export function setQueue(items, index = 0, pos = 0, play = true) {
  if (N) return sync('setQueue', JSON.stringify(items), index, pos, !!play);
  devPlayer().then((d) => d.setQueue(items, index, pos, play));
  return { ok: true };
}
export function addToQueue(items, next = false) {
  if (N) return sync('addToQueue', JSON.stringify(items), !!next);
  devPlayer().then((d) => d.addToQueue(items, next));
  return { ok: true };
}
export const play = () => P('play');
export const pause = () => P('pause');
export const toggle = () => P('toggle');
export const next = () => P('next');
export const prev = () => P('prev');
export const seek = (ms) => P('seek', Math.max(0, Math.round(ms)));
export const jump = (i) => P('jump', i);
export const setShuffle = (on) => P('setShuffle', !!on);
export const setRepeat = (m) => P('setRepeat', m);
export const removeFromQueue = (i) => P('removeFromQueue', i);
export const moveInQueue = (a, b) => P('moveInQueue', a, b);
export const clearQueue = () => P('clearQueue');
export const setSleep = (ms) => P('setSleep', ms);
export function setReplayGain(mode, preamp) { if (N) N.setReplayGain(mode, preamp); }

// ---------------------------------------------------------------- waveform + auto-resume

/** 120 loudness points (0–1) for a track's scrubber, or null if it can't be read. Cached natively per file. */
export async function waveform(t) {
  if (N) {
    if (!N.waveform) return null;
    try { const r = await callAsync('waveform', t.uri, `${t.id}_${t.mtime || 0}`, t.duration_ms || 0); return r.peaks.map((v) => v / 100); }
    catch { return null; }
  }
  // Browser preview only: a deterministic stand-in shape so the scrubber can be designed without audio.
  let h = 0; for (const c of String(t.id)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const out = [];
  for (let i = 0; i < 120; i++) out.push(Math.max(0.08, Math.min(1, Math.abs(Math.sin(i * 0.37 + h) * 0.6 + Math.sin(i * 1.3 + h * 0.1) * 0.3 + Math.sin(i * 0.05) * 0.25))));
  return out;
}
export function setSystemBars(hex, light) { if (N && N.setSystemBars) N.setSystemBars(hex, !!light); }
/** EQ + headphone settings: {eq, gains[10], xfeed, mono, balance}. */
export function setDsp(d) { if (N && N.setDsp) N.setDsp(JSON.stringify(d)); }
export function setAutoResume(on) { if (N && N.setAutoResume) N.setAutoResume(!!on); }

// ---------------------------------------------------------------- DAP face: volume wheel, output, meters

const devVol = { cur: 9, max: 15, min: 0, fixed: false, out: { kind: 'usb', name: 'USB DAC (browser preview)', rate: 384000 } };
/** Android media volume in steps: {cur, max, min, fixed, out: {kind, name, rate}}. */
export function volume() {
  if (N) { if (!N.volume) return null; try { return JSON.parse(N.volume()); } catch { return null; } }
  return { ...devVol, out: { ...devVol.out } };
}
/** Set media volume (a step index). Returns the state Android actually applied. */
export function setVolume(step) {
  if (N) { if (!N.setVolume) return null; try { return JSON.parse(N.setVolume(Math.round(step))); } catch { return null; } }
  devVol.cur = Math.max(devVol.min, Math.min(devVol.max, Math.round(step)));
  return volume();
}
/**
 * Live levels from the decoded audio: {bands: 32 values 0–1, l, r}, or null when there's no signal.
 * In the browser preview a moving fake spectrum stands in while the simulated player runs.
 */
export function levels() {
  if (N) {
    if (!N.levels) return null;
    const s = N.levels();
    if (!s) return null;
    const v = s.split(',').map((x) => Number(x) / 100);
    return v.length >= 34 ? { bands: v.slice(0, 32), l: v[32], r: v[33] } : null;
  }
  if (!dev || !dev.state().playing) return null;
  const t = performance.now() / 1000, bands = [];
  for (let i = 0; i < 32; i++) {
    const base = 0.8 - i * 0.017 - (i > 24 ? (i - 24) * 0.03 : 0);
    const wob = Math.sin(t * (3.1 + i * 0.53) + i * 1.7) * 0.16 + Math.sin(t * (9.7 + i * 0.21) + i * 2.3) * 0.1;
    const kick = i < 6 ? Math.max(0, Math.sin(t * Math.PI * 2 * 1.9)) ** 8 * 0.3 : 0;
    bands.push(Math.max(0, Math.min(1, base + wob + kick)));
  }
  return { bands, l: 0.72 + Math.sin(t * 9.1) * 0.12, r: 0.7 + Math.sin(t * 8.3 + 1) * 0.12 };
}

// ---------------------------------------------------------------- files & misc

/** Save a text file to Downloads/Hibiki (phone) or trigger a browser download. */
export function saveFile(name, mime, text, { subdir = 'Hibiki' } = {}) {
  if (N) return sync('saveFile', name, mime, text, subdir);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: mime }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  return { ok: true, uri: name };
}

export async function share(text, { subject = '', filename = null, mime = 'text/plain' } = {}) {
  if (N) { sync('share', text, subject, filename || '', mime); return true; }
  if (navigator.share) { try { await navigator.share({ title: subject, text }); return true; } catch { return false; } }
  await navigator.clipboard?.writeText(text);
  return 'copied';
}

export const checkUpdate = () => (N ? callAsync('checkUpdate') : Promise.resolve({ available: false, reason: 'browser' }));
export const applyUpdate = () => (N ? callAsync('applyUpdate') : Promise.resolve({ ok: false }));
export const installApk = (url) => (N ? callAsync('installApk', url) : Promise.resolve({ ok: false }));
export function reload() { if (N) N.reload(); else location.reload(); }
export function bootOk() { if (N) N.bootOk(); }
export function haptic(kind = 'tick') { if (N && N.haptic) N.haptic(kind); else navigator.vibrate?.(kind === 'tick' ? 8 : 18); }
export function openUrl(url) { if (N) N.openUrl(url); else window.open(url, '_blank', 'noopener'); }
export function keepScreenOn(on) { if (N && N.keepScreenOn) N.keepScreenOn(!!on); }
export function exitApp() { if (N) N.exitApp(); }
export async function storageInfo() { return N && N.storageInfo ? N.storageInfo() : null; }
export async function persistStorage() { return N && N.persist ? N.persist() : false; }
export function deleteTrack(id) { if (N && N.deleteTrack) N.deleteTrack(id); }
