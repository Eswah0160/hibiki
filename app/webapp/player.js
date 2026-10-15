// The web app's player: an <audio> element driven like the Android PlaybackService. Same commands and the
// same state shape the UI already understands (ids, order, index, pos, shuffle, repeat 0/1/2, sleepAt…).
// Lock-screen / Control Centre controls come from the Media Session API.

const REPEAT_OFF = 0, REPEAT_ONE = 1, REPEAT_ALL = 2;
const FADE_MS = 30000;

export function createWebPlayer({ resolve, onState, logPlay, artUrl }) {
  const audio = new Audio();
  audio.preload = 'auto';
  audio.setAttribute('playsinline', '');
  let items = [], cur = null, shuffle = false, shuffled = [], repeat = REPEAT_OFF;
  let wantPlay = false, ended = false, error = null, url = null, loadSeq = 0;
  let sleepAt = 0, sleepTimer = 0, fadeTimer = 0, fade = 1, rg = { mode: 'off', pre: 0 };
  let acc = 0, lastTick = 0, pendingSeek = null;

  // iOS only lets an <audio> element start by itself once it has played inside a tap. Our files load
  // asynchronously from IndexedDB, so unlock the element on the first touch with a moment of silence.
  let unlocked = false;
  // 0.1 s of real silence (an empty WAV can fail to play on iOS, which would leave the element locked).
  const SILENT = (() => {
    const n = 800, b = new Uint8Array(44 + n * 2), v = new DataView(b.buffer), w = (o, t) => { for (let i = 0; i < t.length; i++) b[o + i] = t.charCodeAt(i); };
    w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, 8000, true); v.setUint32(28, 16000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
    let s = ''; for (const x of b) s += String.fromCharCode(x);
    return 'data:audio/wav;base64,' + btoa(s);
  })();
  // Events from the unlock clip must never touch the player's state (its "ended" used to stop the real track).
  const isSilent = () => audio.getAttribute('src') === SILENT;
  function unlock() {
    if (unlocked) return;
    unlocked = true;
    if (audio.getAttribute('src')) return;
    audio.src = SILENT;
    audio.play().then(() => { if (isSilent()) { audio.pause(); audio.removeAttribute('src'); } }).catch(() => { unlocked = false; if (isSilent()) audio.removeAttribute('src'); });
  }
  for (const ev of ['touchend', 'pointerup', 'keydown']) window.addEventListener(ev, unlock, { capture: true, passive: true });

  // ------------------------------------------------------------- state
  const list = () => (shuffle ? shuffled : items);
  function order() {
    const l = list(), out = [];
    let i = l.indexOf(cur);
    for (; i >= 0 && i < l.length; i++) out.push(items.indexOf(l[i]));
    return out;
  }
  function state(full = true) {
    const s = {
      connected: true, playing: !isSilent() && !audio.paused && !audio.ended && !ended, playWhenReady: wantPlay,
      state: !cur ? 'idle' : ended ? 'ended' : audio.readyState < 3 && wantPlay ? 'buffering' : 'ready',
      index: cur ? items.indexOf(cur) : -1, id: cur ? cur.id : null,
      pos: pendingSeek ?? Math.round((audio.currentTime || 0) * 1000), buffered: 0,
      dur: Math.round((isFinite(audio.duration) ? audio.duration : (cur?.dur || 0) / 1000) * 1000),
      shuffle, repeat, at: performance.now(), sleepAt,
    };
    if (error) s.error = error;
    if (full) { s.ids = items.map((x) => x.id); s.order = order(); }
    return s;
  }
  let pushT = 0;
  const push = () => { cancelAnimationFrame(pushT); pushT = requestAnimationFrame(() => { onState(state()); save(); }); };

  // ------------------------------------------------------------- loading
  async function load(item, posMs = 0, play = wantPlay) {
    commitPlay();
    cur = item; ended = false; error = null; acc = 0;
    const seq = ++loadSeq;
    if (!item) { audio.removeAttribute('src'); audio.load(); push(); return; }
    let blob;
    try { blob = await resolve(item.uri); } catch (e) { blob = null; }
    if (seq !== loadSeq) return;
    if (!blob) { error = 'File not found in this browser’s library'; wantPlay = false; push(); return; }
    if (url) URL.revokeObjectURL(url);
    url = URL.createObjectURL(blob);
    audio.src = url;
    applyGain();
    pendingSeek = posMs > 0 ? posMs : null;
    if (posMs > 0) {
      const at = posMs / 1000;
      const onMeta = () => { if (seq !== loadSeq) return; try { audio.currentTime = at; } catch {} pendingSeek = null; };
      audio.addEventListener('loadedmetadata', onMeta, { once: true });
    }
    wantPlay = play;
    if (play) await tryPlay();
    session();
    push();
  }
  async function tryPlay() {
    try { await audio.play(); error = null; }
    catch (e) { if (e && e.name !== 'AbortError') { wantPlay = false; if (e.name === 'NotAllowedError') error = null; else error = e.message; } }
    push();
  }

  function successor(auto) {
    const l = list(), i = l.indexOf(cur);
    if (auto && repeat === REPEAT_ONE) return cur;
    if (i + 1 < l.length) return l[i + 1];
    if (repeat === REPEAT_ALL && l.length) return l[0];
    return null;
  }

  // ------------------------------------------------------------- events
  audio.addEventListener('play', () => { if (isSilent()) return; lastTick = performance.now(); push(); });
  audio.addEventListener('pause', () => { if (isSilent()) return; tick(); push(); });
  audio.addEventListener('playing', () => { if (isSilent()) return; ended = false; push(); }); // playing again always clears a stale 'ended'
  audio.addEventListener('waiting', push);
  audio.addEventListener('durationchange', push);
  audio.addEventListener('seeked', () => { lastTick = performance.now(); push(); });
  audio.addEventListener('timeupdate', () => { tick(); positionState(); save(); });
  audio.addEventListener('error', () => { if (!audio.getAttribute('src') || isSilent()) return; error = 'This browser can’t play ' + (cur?.title || 'this file'); wantPlay = false; push(); });
  audio.addEventListener('ended', () => {
    if (isSilent()) return;
    if (!cur) return;
    tick();
    if (sleepAt === -1) { stopForSleep(); ended = true; return push(); }
    const nxt = successor(true);
    if (sleepAt === -2 && (!nxt || nxt.album !== cur.album)) { stopForSleep(); ended = true; return push(); }
    if (!nxt) { ended = true; wantPlay = false; commitPlay(); return push(); }
    if (nxt === cur) { audio.currentTime = 0; commitPlay(); tryPlay(); return; }
    load(nxt, 0, true);
  });
  function tick() {
    const now = performance.now();
    if (!audio.paused && lastTick) acc += now - lastTick;
    lastTick = now;
  }
  /** A play counts after half the track (max 4 min), like scrobbling — same rule as the Android app. */
  function commitPlay() {
    if (!cur) return;
    tick();
    const dur = cur.dur || (isFinite(audio.duration) ? audio.duration * 1000 : 0);
    const need = dur > 0 ? Math.min(240000, dur / 2) : 30000;
    if (acc >= need && acc >= 5000) { try { logPlay(cur.id, Date.now() - acc, Math.round(acc), dur > 0 && acc >= dur * 0.9); } catch {} }
    acc = 0;
  }

  // ------------------------------------------------------------- media session
  function session() {
    if (!('mediaSession' in navigator) || !cur) return;
    try {
      const a = cur.art ? artUrl(cur.art) : null;
      navigator.mediaSession.metadata = new MediaMetadata({ title: cur.title, artist: cur.artist, album: cur.album, artwork: a ? [{ src: a, sizes: '512x512' }] : [] });
    } catch {}
  }
  function positionState() {
    if (!('mediaSession' in navigator) || !isFinite(audio.duration)) return;
    try { navigator.mediaSession.setPositionState({ duration: audio.duration, position: Math.min(audio.currentTime, audio.duration), playbackRate: 1 }); } catch {}
  }
  if ('mediaSession' in navigator) {
    const h = {
      play: () => api.play(), pause: () => api.pause(), previoustrack: () => api.prev(), nexttrack: () => api.next(),
      seekto: (d) => api.seek((d.seekTime || 0) * 1000),
      seekbackward: (d) => api.seek((audio.currentTime - (d.seekOffset || 10)) * 1000),
      seekforward: (d) => api.seek((audio.currentTime + (d.seekOffset || 10)) * 1000),
    };
    for (const k in h) { try { navigator.mediaSession.setActionHandler(k, h[k]); } catch {} }
  }

  // ------------------------------------------------------------- volume (ReplayGain + sleep fade)
  // iOS ignores audio.volume (the hardware buttons own the volume), so there these only apply on desktop.
  function applyGain() {
    let g = 1;
    if (cur && rg.mode !== 'off') {
      const db = rg.mode === 'album' ? (cur.rgA ?? cur.rgT) : (cur.rgT ?? cur.rgA);
      if (db != null) g = Math.min(1, Math.pow(10, (db + (rg.pre || 0)) / 20));
    }
    try { audio.volume = Math.max(0, Math.min(1, g * fade)); } catch {}
  }

  // ------------------------------------------------------------- sound (EQ, crossfeed, mono, balance) via Web Audio
  // The <audio> element is only routed through Web Audio once a sound setting is first used, because on
  // iPhone that route can pause when the screen locks. With everything off the graph is a straight wire.
  const FREQS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
  let g = null, dspCfg = { eq: false, gains: FREQS.map(() => 0), xfeed: false, mono: false, balance: 0 };
  const passthrough = (c) => !(c.eq && c.gains.some((x) => x)) && !c.xfeed && !c.mono && !c.balance;
  function graph() {
    if (g) return g;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    const ctx = new AC();
    const src = ctx.createMediaElementSource(audio);
    const pre = ctx.createGain();
    const bands = FREQS.map((f, i) => { const b = ctx.createBiquadFilter(); b.type = i === 0 ? 'lowshelf' : i === 9 ? 'highshelf' : 'peaking'; b.frequency.value = f; b.Q.value = 1.41; b.gain.value = 0; return b; });
    const split = ctx.createChannelSplitter(2), merge = ctx.createChannelMerger(2);
    const lpL = ctx.createBiquadFilter(), lpR = ctx.createBiquadFilter();
    lpL.type = lpR.type = 'lowpass'; lpL.frequency.value = lpR.frequency.value = 700; lpL.Q.value = lpR.Q.value = 0.5;
    const m = { LL: ctx.createGain(), RL: ctx.createGain(), LR: ctx.createGain(), RR: ctx.createGain(), xRL: ctx.createGain(), xLR: ctx.createGain() };
    const analyser = ctx.createAnalyser(); analyser.fftSize = 4096; analyser.smoothingTimeConstant = 0.6;
    const aSplit = ctx.createChannelSplitter(2), aL = ctx.createAnalyser(), aR = ctx.createAnalyser(); aL.fftSize = aR.fftSize = 1024;
    let n = src; n.connect(pre); n = pre;
    for (const b of bands) { n.connect(b); n = b; }
    n.connect(split);
    split.connect(m.LL, 0); m.LL.connect(merge, 0, 0);
    split.connect(m.LR, 0); m.LR.connect(merge, 0, 1);
    split.connect(m.RR, 1); m.RR.connect(merge, 0, 1);
    split.connect(m.RL, 1); m.RL.connect(merge, 0, 0);
    split.connect(lpL, 0); lpL.connect(m.xLR); m.xLR.connect(merge, 0, 1);
    split.connect(lpR, 1); lpR.connect(m.xRL); m.xRL.connect(merge, 0, 0);
    merge.connect(ctx.destination);
    merge.connect(analyser); merge.connect(aSplit); aSplit.connect(aL, 0); aSplit.connect(aR, 1);
    g = { ctx, pre, bands, m, analyser, aL, aR };
    return g;
  }
  function applyDsp() {
    const c = dspCfg;
    if (!g && passthrough(c)) return;
    const G = graph();
    if (!G) return;
    const eq = c.eq && c.gains.some((x) => x);
    G.bands.forEach((b, i) => { b.gain.value = eq ? c.gains[i] : 0; });
    G.pre.gain.value = eq ? Math.pow(10, -Math.max(0, ...c.gains) / 20) : 1;
    const gl = c.balance > 0 ? 1 - c.balance : 1, gr = c.balance < 0 ? 1 + c.balance : 1;
    let d = 1, x = 0, cross = 0;
    if (c.mono) { d = 0.5; cross = 0.5; }
    else if (c.xfeed) { d = 1 / 1.35; x = 0.35 / 1.35; }
    G.m.LL.gain.value = d * gl; G.m.RR.gain.value = d * gr;
    G.m.RL.gain.value = cross * gl; G.m.LR.gain.value = cross * gr;
    G.m.xRL.gain.value = x * gl; G.m.xLR.gain.value = x * gr;
  }
  const resume = () => { if (g && g.ctx.state !== 'running') g.ctx.resume().catch(() => {}); };
  audio.addEventListener('play', resume);
  let fbuf = null, tbuf = null;
  /** Spectrum + L/R peaks in the same text format as the Android bridge, while Web Audio is in use. */
  function levels() {
    if (!g || audio.paused) return '';
    const a = g.analyser, rate = g.ctx.sampleRate;
    if (!fbuf) fbuf = new Float32Array(a.frequencyBinCount);
    a.getFloatFrequencyData(fbuf);
    const out = [];
    for (let i = 0; i < 32; i++) {
      const f0 = 40 * Math.pow(16000 / 40, i / 32), f1 = 40 * Math.pow(16000 / 40, (i + 1) / 32);
      const b0 = Math.max(1, Math.floor(f0 / rate * a.fftSize)), b1 = Math.max(b0 + 1, Math.ceil(f1 / rate * a.fftSize));
      let m = -200; for (let k = b0; k < b1 && k < fbuf.length; k++) m = Math.max(m, fbuf[k]);
      out.push(Math.round(Math.max(0, Math.min(1, (m + 90) / 80)) * 100));
    }
    if (!tbuf) tbuf = new Float32Array(g.aL.fftSize);
    for (const an of [g.aL, g.aR]) { an.getFloatTimeDomainData(tbuf); let p = 0; for (const v of tbuf) p = Math.max(p, Math.abs(v)); const db = 20 * Math.log10(Math.max(p, 1e-6)); out.push(Math.round(Math.max(0, Math.min(1, (db + 48) / 48)) * 100)); }
    return out.join(',');
  }

  // ------------------------------------------------------------- sleep timer
  function clearSleep() { clearTimeout(sleepTimer); clearInterval(fadeTimer); sleepAt = 0; if (fade !== 1) { fade = 1; applyGain(); } }
  function stopForSleep() { wantPlay = false; audio.pause(); clearSleep(); }

  // ------------------------------------------------------------- queue persistence
  let saveT = 0;
  function save(now = false) {
    if (saveT && !now) return; // throttle: at most one write per 800 ms, even while timeupdate fires
    clearTimeout(saveT);
    const write = () => {
      saveT = 0;
      try { localStorage.setItem('hibiki-web-queue', JSON.stringify({ items, index: cur ? items.indexOf(cur) : -1, pos: pendingSeek ?? Math.round((audio.currentTime || 0) * 1000), shuffle, repeat })); } catch {}
    };
    if (now) write(); else saveT = setTimeout(write, 800);
  }
  window.addEventListener('pagehide', () => save(true));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') save(true); });

  const shuffleRest = (first) => {
    const rest = items.filter((x) => x !== first);
    for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]]; }
    return first ? [first, ...rest] : rest;
  };

  // ------------------------------------------------------------- API (mirrors the Android bridge)
  const api = {
    audio,
    state,
    restore() {
      try {
        const q = JSON.parse(localStorage.getItem('hibiki-web-queue') || 'null');
        if (!q || !q.items?.length) return;
        items = q.items; shuffle = !!q.shuffle; repeat = q.repeat || 0;
        const c = items[Math.max(0, Math.min(items.length - 1, q.index))];
        shuffled = shuffle ? shuffleRest(c) : [];
        load(c, q.pos || 0, false);
      } catch {}
    },
    setQueue(list, index, posMs, play) {
      items = list.slice();
      const c = items[Math.max(0, Math.min(index, items.length - 1))] || null;
      shuffled = shuffle ? shuffleRest(c) : [];
      wantPlay = !!play;
      load(c, posMs || 0, !!play);
    },
    addToQueue(list, nextUp) {
      if (!items.length) return api.setQueue(list, 0, 0, false);
      const at = nextUp ? items.indexOf(cur) + 1 : items.length;
      items.splice(at, 0, ...list);
      if (shuffle) {
        const si = shuffled.indexOf(cur) + 1;
        if (nextUp) shuffled.splice(si, 0, ...list);
        else for (const x of list) shuffled.splice(si + Math.floor(Math.random() * (shuffled.length - si + 1)), 0, x);
      }
      push();
    },
    play() { if (!cur) return; if (ended) { ended = false; audio.currentTime = 0; } wantPlay = true; tryPlay(); },
    pause() { wantPlay = false; audio.pause(); push(); },
    toggle() { if (!audio.paused && !ended) api.pause(); else api.play(); },
    next() { const n = successor(false); if (n) load(n, 0, wantPlay || !audio.paused); },
    prev() {
      const l = list(), i = l.indexOf(cur);
      if ((audio.currentTime || 0) > 3 || i <= 0) { audio.currentTime = 0; push(); return; }
      load(l[i - 1], 0, wantPlay || !audio.paused);
    },
    seek(ms) { if (!cur) return; try { audio.currentTime = Math.max(0, ms / 1000); } catch {} ended = false; push(); },
    jump(i) { if (items[i]) { wantPlay = true; load(items[i], 0, true); } },
    setShuffle(on) { shuffle = !!on; shuffled = shuffle ? shuffleRest(cur) : []; push(); },
    setRepeat(m) { repeat = m; push(); },
    removeFromQueue(i) {
      const x = items[i];
      if (!x) return;
      items.splice(i, 1);
      shuffled = shuffled.filter((y) => y !== x);
      if (x === cur) { const n = items[Math.min(i, items.length - 1)] || null; load(n, 0, wantPlay && !!n); return; }
      push();
    },
    moveInQueue(a, b) { const [x] = items.splice(a, 1); items.splice(b, 0, x); push(); },
    clearQueue() { items = []; shuffled = []; wantPlay = false; audio.pause(); load(null); },
    setSleep(ms) {
      clearSleep();
      if (ms === -1 || ms === -2) { sleepAt = ms; push(); return; }
      if (ms > 0) {
        sleepAt = Date.now() + ms;
        const end = performance.now() + ms;
        sleepTimer = setTimeout(() => {
          fadeTimer = setInterval(() => {
            const left = end - performance.now();
            if (left <= 0) { stopForSleep(); push(); return; }
            fade = Math.pow(Math.min(1, left / FADE_MS), 2);
            applyGain();
          }, 250);
        }, Math.max(0, ms - FADE_MS));
      }
      push();
    },
    setReplayGain(mode, pre) { rg = { mode, pre: Number(pre) || 0 }; applyGain(); },
    setDsp(c) { dspCfg = { ...dspCfg, ...c }; applyDsp(); resume(); },
    levels,
  };
  return api;
}
