// The web app's stand-in for the Android bridge (window.HibikiNative). The UI talks to it exactly as it
// talks to the phone, so every screen works unchanged:
//   • SQL      → sql.js (SQLite in WebAssembly), saved to IndexedDB after each change
//   • library  → music files the user picks are copied into IndexedDB (browsers can't re-open a folder later)
//   • art      → covers stored as blobs, served as object URLs
//   • player   → an <audio> element (player.js) with lock-screen controls via Media Session
import * as store from './store.js';
import { readTrack, albumKey } from './tags.js';
import { createWebPlayer } from './player.js';
import { NATIVE_DDL } from '../js/schema.js';

export const ROOT = 'web:library';
const AUDIO_EXT = /\.(flac|mp3|m4a|aac|alac|wav|aif|aiff|ogg|oga|opus|caf)$/i;
const IMAGE_EXT = /\.(jpe?g|png|webp)$/i;
const FOLDER_ART = /^(cover|folder|front|album|albumart)\.(jpe?g|png|webp)$/i;
const J = (o) => JSON.stringify(o);
const err = (e) => J({ error: String(e?.message || e) });

export async function createBridge({ base = '.' } = {}) {
  // ------------------------------------------------------------------ database
  const SQL = await window.initSqlJs({ locateFile: (f) => `${base}/vendor/${f}` });
  let saved = null;
  try { saved = await store.get('kv', 'db'); } catch {}
  const d = saved ? new SQL.Database(new Uint8Array(saved)) : new SQL.Database();
  let inTx = false, dirty = false, saveT = 0;
  const fix = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
  function scheduleSave(ms = 700) {
    dirty = true;
    clearTimeout(saveT);
    saveT = setTimeout(flush, ms);
  }
  async function flush() {
    if (!dirty) return;
    if (inTx) return scheduleSave(300); // export() reopens the database, never do it mid-transaction
    dirty = false;
    try { await store.put('kv', 'db', d.export().buffer); } catch (e) { dirty = true; console.warn('Saving the library failed', e); }
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') { clearTimeout(saveT); flush(); } });
  window.addEventListener('pagehide', () => { clearTimeout(saveT); flush(); });

  function all(sql, params = []) {
    const st = d.prepare(sql);
    try { st.bind(params.map(fix)); const rows = []; while (st.step()) rows.push(st.getAsObject()); return rows; }
    finally { st.free(); }
  }
  function run(sql, params = []) {
    d.run(sql, params.map(fix));
    const changes = d.getRowsModified();
    const lastId = d.exec('SELECT last_insert_rowid()')[0].values[0][0];
    if (!inTx) scheduleSave();
    return { changes, lastId };
  }
  const tx = (fn) => { d.run('BEGIN'); inTx = true; try { const r = fn(); d.run('COMMIT'); return r; } catch (e) { try { d.run('ROLLBACK'); } catch {} throw e; } finally { inTx = false; scheduleSave(); } };
  // The scanner writes before the UI has migrated on a first run, same as Db.java.
  for (const s of NATIVE_DDL) d.run(s);

  // ------------------------------------------------------------------ art
  const artUrls = new Map(); // `${size}_${key}` -> object URL
  for (const [k, blob] of await store.entries('art').catch(() => [])) artUrls.set(k, URL.createObjectURL(blob));

  async function sha1(buf) {
    const h = await crypto.subtle.digest('SHA-1', buf);
    return Array.from(new Uint8Array(h), (x) => x.toString(16).padStart(2, '0')).join('').slice(0, 24);
  }
  async function scaled(bmp, max) {
    const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * s)), h = Math.max(1, Math.round(bmp.height * s));
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    c.getContext('2d').drawImage(bmp, 0, 0, w, h);
    return new Promise((res) => c.toBlob(res, 'image/jpeg', 0.88));
  }
  const decoding = new Map();
  /** Store a cover once (by content hash) as a 1200 px full size and a 320 px thumbnail. */
  async function storeArt(blob) {
    if (!blob || !blob.size) return null;
    const buf = await blob.arrayBuffer();
    const key = await sha1(buf);
    if (decoding.has(key)) return decoding.get(key);
    const p = (async () => {
      const bmp = await createImageBitmap(new Blob([buf], { type: blob.type || 'image/jpeg' }));
      const out = { key, w: bmp.width, h: bmp.height };
      if (!artUrls.has('f_' + key)) {
        const full = await scaled(bmp, 1200), thumb = await scaled(bmp, 320);
        await store.put('art', 'f_' + key, full); await store.put('art', 't_' + key, thumb);
        artUrls.set('f_' + key, URL.createObjectURL(full)); artUrls.set('t_' + key, URL.createObjectURL(thumb));
      }
      bmp.close?.();
      return out;
    })();
    decoding.set(key, p);
    try { return await p; } catch { return null; } finally { decoding.delete(key); }
  }

  // ------------------------------------------------------------------ library import + scan
  let pending = [];      // Files picked but not yet copied in
  let scanState = { phase: 'idle' }, scanRunning = false;
  const report = (s) => { scanState = s; try { window.hibikiOnScan?.(s); } catch {} };

  function pickFiles(cb, { folder = false } = {}) {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.multiple = true;
    if (folder) inp.webkitdirectory = true;
    else inp.accept = 'audio/*,.flac,.mp3,.m4a,.aac,.alac,.wav,.aif,.aiff,.ogg,.opus,image/jpeg,image/png';
    inp.style.display = 'none';
    let done = false;
    const finish = (r) => { if (done) return; done = true; inp.remove(); window.__hibikiCb(cb, r); };
    inp.addEventListener('change', () => {
      const files = [...(inp.files || [])].filter((f) => AUDIO_EXT.test(f.name) || IMAGE_EXT.test(f.name));
      if (!files.some((f) => AUDIO_EXT.test(f.name))) return finish({ cancelled: true });
      pending.push(...files);
      run('INSERT INTO roots(uri,name,added_at) VALUES(?,?,?) ON CONFLICT(uri) DO NOTHING', [ROOT, 'This device', Date.now()]);
      finish({ ok: true, uri: ROOT, name: `${files.filter((f) => AUDIO_EXT.test(f.name)).length} files` });
    });
    inp.addEventListener('cancel', () => finish({ cancelled: true }));
    document.body.append(inp);
    inp.click(); // must happen inside the tap that asked for it
  }

  function probeDuration(blob) {
    return new Promise((res) => {
      const a = document.createElement('audio'), u = URL.createObjectURL(blob);
      const end = (v) => { URL.revokeObjectURL(u); a.removeAttribute('src'); res(v); };
      a.preload = 'metadata';
      a.onloadedmetadata = () => end(isFinite(a.duration) ? Math.round(a.duration * 1000) : null);
      a.onerror = () => end(null);
      setTimeout(() => end(null), 8000);
      a.src = u;
    });
  }

  const folderOf = (f) => { const p = f.webkitRelativePath || ''; const i = p.lastIndexOf('/'); return i > 0 ? p.slice(0, i) : ''; };

  async function readInto(file, key, now, folderArt) {
    const { row, art } = await readTrack(file);
    if (!row.duration_ms) { row.duration_ms = await probeDuration(file); if (row.duration_ms && file.size) row.bitrate = Math.round(file.size * 8 / row.duration_ms); }
    const folder = folderOf(file) || [row.albumartist || row.artist, row.album].filter(Boolean).join('/') || '';
    let a = null, src = null;
    if (art) { a = await storeArt(art).catch(() => null); if (a) src = 'embedded'; }
    if (!a && folderArt.has(folderOf(file))) { a = await storeArt(folderArt.get(folderOf(file))).catch(() => null); if (a) src = 'folder'; }
    return {
      ...row, uri: 'idb:' + key, root: ROOT, folder, album_key: albumKey(row.albumartist, row.artist, row.album, ROOT, folder),
      art_key: a?.key ?? null, art_w: a?.w ?? null, art_h: a?.h ?? null, art_src: src, scanned_at: now, missing: 0,
    };
  }

  function upsert(row, now) {
    const ex = all('SELECT id FROM tracks WHERE uri=?', [row.uri])[0];
    const keys = Object.keys(row);
    if (ex) { run(`UPDATE tracks SET ${keys.map((k) => k + '=?').join(',')} WHERE id=?`, [...keys.map((k) => row[k]), ex.id]); return 'updated'; }
    row.added_at = now;
    const k2 = Object.keys(row);
    run(`INSERT INTO tracks(${k2.join(',')}) VALUES(${k2.map(() => '?').join(',')})`, k2.map((k) => row[k]));
    return 'added';
  }

  async function doScan(force) {
    const now = Date.now();
    let added = 0, updated = 0, missing = 0, failed = 0, full = false;
    report({ phase: 'walking', done: 0, total: 0 });
    const files = pending; pending = [];
    const audio = files.filter((f) => AUDIO_EXT.test(f.name));
    const folderArt = new Map();
    for (const f of files) if (FOLDER_ART.test(f.name)) folderArt.set(folderOf(f), f);
    // Loose images picked alongside a single album with no folder info: use the first one as its cover.
    if (!folderArt.has('') && files.some((f) => IMAGE_EXT.test(f.name) && !folderOf(f))) folderArt.set('', files.find((f) => IMAGE_EXT.test(f.name) && !folderOf(f)));

    // Re-read tags of files already stored when asked for a full rescan.
    const stored = force ? all("SELECT uri FROM tracks WHERE uri LIKE 'idb:%'").map((r) => r.uri.slice(4)) : [];
    const total = audio.length + stored.length;
    let done = 0;
    for (const f of audio) {
      report({ phase: 'reading', done, total, current: f.name });
      try {
        const key = `${(f.webkitRelativePath || f.name)}|${f.size}|${f.lastModified}`;
        const exists = all('SELECT id FROM tracks WHERE uri=?', ['idb:' + key])[0];
        if (!exists || force) {
          await store.put('files', key, f);
          const row = await readInto(f, key, now, folderArt);
          (upsert(row, now) === 'added') ? added++ : updated++;
        }
      } catch (e) {
        failed++;
        if (/quota|space|abort/i.test(String(e?.name) + String(e?.message))) { full = true; break; }
      }
      done++;
    }
    for (const key of stored) {
      report({ phase: 'reading', done, total, current: key.split('|')[0] });
      try {
        const blob = await store.get('files', key);
        if (!blob) { run('UPDATE tracks SET missing=1 WHERE uri=?', ['idb:' + key]); missing++; }
        else {
          const file = blob instanceof File ? blob : new File([blob], key.split('|')[0].split('/').pop(), { lastModified: Number(key.split('|')[2]) || now });
          upsert(await readInto(file, key, now, folderArt), now); updated++;
        }
      } catch { failed++; }
      done++;
    }
    await flush();
    report({ phase: 'done', done: total, total, added, updated, missing, at: now, unreadable: 0 });
    if (added) setTimeout(() => store.persist(), 1000); // ask the browser to keep this storage
    if (full) setTimeout(() => window.__hibikiToast?.('This device ran out of space for music. Some files weren’t added.'), 400);
    else if (failed) setTimeout(() => window.__hibikiToast?.(`${failed} file${failed === 1 ? '' : 's'} couldn’t be read`), 400);
  }

  // ------------------------------------------------------------------ player
  const player = createWebPlayer({
    resolve: async (uri) => (uri.startsWith('idb:') ? store.get('files', uri.slice(4)) : null),
    onState: (s) => { try { window.hibikiOnPlayer?.(s); } catch (e) { console.error(e); } },
    logPlay: (id, at, ms, doneFlag) => run('INSERT INTO plays(track_id,at,ms,done) VALUES(?,?,?,?)', [id, at, ms, doneFlag ? 1 : 0]),
    artUrl: (k) => artUrls.get('f_' + k) || null,
  });

  // ------------------------------------------------------------------ waveform (decoded at low rate)
  async function waveform(uri, key, durMs) {
    const hit = await store.get('wave', key).catch(() => null);
    if (hit) return hit;
    const blob = uri.startsWith('idb:') ? await store.get('files', uri.slice(4)) : null;
    if (!blob) throw new Error('no file');
    if (blob.size > 160 * 1024 * 1024) throw new Error('too large');
    const buf = await blob.arrayBuffer();
    let ctx;
    for (const rate of [8000, 22050, 44100]) { try { ctx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 1, rate); break; } catch {} }
    if (!ctx) throw new Error('no audio context');
    const ab = await new Promise((res, rej) => { const p = ctx.decodeAudioData(buf, res, rej); if (p?.then) p.then(res, rej); });
    const ch = ab.getChannelData(0), N = 120, step = Math.max(1, Math.floor(ch.length / N));
    const raw = [];
    for (let i = 0; i < N; i++) {
      let sum = 0, n = 0;
      for (let j = i * step, e = Math.min(ch.length, j + step); j < e; j += 4) { sum += ch[j] * ch[j]; n++; }
      raw.push(n ? Math.sqrt(sum / n) : 0);
    }
    const max = Math.max(...raw, 1e-6);
    const peaks = raw.map((v) => Math.round(Math.max(0.04, v / max) * 100));
    await store.put('wave', key, peaks).catch(() => {});
    return peaks;
  }

  // ------------------------------------------------------------------ the bridge
  const cb = (id, p) => Promise.resolve().then(p).then((r) => window.__hibikiCb(id, r), (e) => window.__hibikiCb(id, { error: String(e?.message || e) }));
  let wake = null;

  const N = {
    web: true,
    query: (sql, p) => { try { return J({ rows: all(sql, JSON.parse(p || '[]')) }); } catch (e) { return err(e); } },
    exec: (sql, p) => { try { return J(run(sql, JSON.parse(p || '[]'))); } catch (e) { return err(e); } },
    begin: () => { try { d.run('BEGIN'); inTx = true; return '{}'; } catch (e) { return err(e); } },
    commit: () => { try { d.run('COMMIT'); inTx = false; scheduleSave(); return '{}'; } catch (e) { return err(e); } },
    rollback: () => { try { d.run('ROLLBACK'); inTx = false; return '{}'; } catch (e) { return err(e); } },

    info: () => J({ appVersion: 'web', versionCode: 0, bridge: 0, webVersion: window.HIBIKI_WEB_VERSION || 'dev', webSource: navigator.standalone || matchMedia('(display-mode: standalone)').matches ? 'home screen app' : 'browser', platform: 'web', device: navigator.platform || '' }),
    openAppSettings: () => {},

    pickFolder: (id) => pickFiles(id),
    pickDirectory: (id) => pickFiles(id, { folder: true }),
    removeRoot: (uri) => {
      try {
        const rows = all("SELECT id, uri FROM tracks WHERE root=?", [uri]);
        tx(() => { run('DELETE FROM tracks WHERE root=?', [uri]); run('DELETE FROM roots WHERE uri=?', [uri]); });
        (async () => { for (const r of rows) if (r.uri.startsWith('idb:')) await store.del('files', r.uri.slice(4)).catch(() => {}); })();
        return J({ ok: true });
      } catch (e) { return err(e); }
    },
    lostRoots: () => J({ lost: [] }),
    scan: (force) => {
      if (scanRunning) return J({ started: false });
      scanRunning = true;
      doScan(!!force).catch((e) => report({ phase: 'error', error: String(e?.message || e) })).finally(() => { scanRunning = false; });
      return J({ started: true });
    },
    scanStatus: () => J(scanState),
    scanning: () => scanRunning,
    /** Remove one track's file from browser storage (web only). */
    deleteTrack: (id) => {
      const r = all('SELECT uri FROM tracks WHERE id=?', [id])[0];
      if (r?.uri.startsWith('idb:')) store.del('files', r.uri.slice(4)).catch(() => {});
      run('DELETE FROM tracks WHERE id=?', [id]);
      return '{}';
    },

    writeTags: (id) => window.__hibikiCb(id, { error: 'Editing tags inside files needs the Android app. The web app keeps your files as they are.' }),
    cacheArt: (b64) => {
      // Synchronous on the phone; here the key is ready at once and the stored copy follows a moment later.
      try {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const blob = new Blob([bytes], { type: 'image/jpeg' });
        const tmp = 'b64:' + b64.slice(0, 32);
        const url = URL.createObjectURL(blob);
        artUrls.set('f_' + tmp, url); artUrls.set('t_' + tmp, url);
        storeArt(blob).then((a) => { if (a) run('UPDATE tracks SET art_key=? WHERE art_key=?', [a.key, tmp]); });
        return J({ key: tmp, w: 0, h: 0, dataUrl: url });
      } catch (e) { return err(e); }
    },
    http: (id, url, binary) => cb(id, async () => {
      const r = await fetch(url, { headers: { Accept: binary ? 'image/*' : 'application/json' } });
      if (!binary) return { status: r.status, body: await r.text() };
      const buf = new Uint8Array(await r.arrayBuffer());
      let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
      return { status: r.status, mime: r.headers.get('content-type'), b64: btoa(s) };
    }),
    artUrl: (key, size) => artUrls.get(`${size === 'f' ? 'f' : 't'}_${key}`) || artUrls.get(`f_${key}`) || null,

    playerState: () => J(player.state()),
    setQueue: (items, index, pos, play) => { player.setQueue(JSON.parse(items), index, pos, play); return '{"ok":true}'; },
    addToQueue: (items, next) => { player.addToQueue(JSON.parse(items), next); return '{"ok":true}'; },
    play: () => player.play(), pause: () => player.pause(), toggle: () => player.toggle(),
    next: () => player.next(), prev: () => player.prev(), seek: (ms) => player.seek(ms), jump: (i) => player.jump(i),
    setShuffle: (on) => player.setShuffle(on), setRepeat: (m) => player.setRepeat(m),
    removeFromQueue: (i) => player.removeFromQueue(i), moveInQueue: (a, b) => player.moveInQueue(a, b),
    clearQueue: () => player.clearQueue(), setSleep: (ms) => player.setSleep(ms),
    setReplayGain: (mode, pre) => player.setReplayGain(mode, pre),
    waveform: (id, uri, key, durMs) => cb(id, async () => ({ peaks: await waveform(uri, key, durMs) })),
    setAutoResume: () => {},
    setDsp: (json) => { try { player.setDsp(JSON.parse(json)); } catch {} },
    levels: () => player.levels(),
    setSystemBars: (hex) => {
      let m = document.querySelector('meta[name=theme-color]');
      if (!m) { m = document.createElement('meta'); m.name = 'theme-color'; document.head.append(m); }
      m.content = hex || '#E7E7E4';
    },

    saveFile: (name, mime, text) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([text], { type: mime })); a.download = name; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      return J({ ok: true, uri: name });
    },
    share: (text, subject, filename, mime) => {
      const file = filename ? new File([text], filename, { type: mime || 'text/plain' }) : null;
      const data = file && navigator.canShare?.({ files: [file] }) ? { files: [file], title: subject } : { text, title: subject };
      if (navigator.share) navigator.share(data).catch(() => {});
      else navigator.clipboard?.writeText(text);
      return '{}';
    },
    checkUpdate: (id) => cb(id, async () => {
      const reg = await navigator.serviceWorker?.getRegistration?.();
      if (reg) await reg.update().catch(() => {});
      return { available: false, reason: 'web' };
    }),
    applyUpdate: (id) => window.__hibikiCb(id, { ok: false }),
    installApk: (id) => window.__hibikiCb(id, { ok: false }),
    reload: () => location.reload(),
    bootOk: () => {},
    haptic: (k) => { try { navigator.vibrate?.(k === 'tick' ? 8 : 18); } catch {} },
    openUrl: (url) => window.open(url, '_blank', 'noopener'),
    keepScreenOn: async (on) => {
      try {
        if (on && !wake && navigator.wakeLock) { wake = await navigator.wakeLock.request('screen'); wake.addEventListener('release', () => { wake = null; }); }
        else if (!on && wake) { await wake.release(); wake = null; }
      } catch {}
    },
    exitApp: () => {},

    // web-only helpers for the settings screen
    storageInfo: () => store.estimate(),
    persist: () => store.persist(),
    restorePlayer: () => player.restore(),
  };
  return N;
}

