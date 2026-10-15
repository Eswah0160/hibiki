// Sound: a 10-band EQ with presets (built-in and your own), plus headphone crossfeed, mono and balance.
// Settings live in the library database (meta 'dsp', custom presets in 'eq_custom') and are handed to
// the player: Dsp.java on Android, Web Audio in the web app.
import { html, icon, openSheet, toast, promptDlg, confirmDlg, $, $$ } from './dom.js';
import { meta, setMeta } from '../db.js';
import * as native from '../native.js';

export const FREQS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
export const BAND_LABELS = ['31', '62', '125', '250', '500', '1K', '2K', '4K', '8K', '16K'];
const Z = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
export const PRESETS = [
  ['flat', 'Flat', Z],
  ['bass', 'Bass boost', [6, 5, 4, 2, 0, 0, 0, 0, 0, 0]],
  ['bassless', 'Bass cut', [-6, -5, -3, -1, 0, 0, 0, 0, 0, 0]],
  ['treble', 'Treble boost', [0, 0, 0, 0, 0, 0, 1, 3, 5, 6]],
  ['vocal', 'Vocal', [-2, -2, -1, 0, 2, 4, 4, 2, 0, -1]],
  ['warm', 'Warm', [3, 3, 2, 1, 0, 0, -1, -2, -2, -3]],
  ['bright', 'Bright', [-1, -1, 0, 0, 0, 1, 2, 3, 4, 4]],
  ['loudness', 'Loudness', [5, 4, 2, 0, -1, -1, 0, 2, 4, 5]],
  ['acoustic', 'Acoustic', [3, 3, 2, 1, 1, 1, 2, 2, 2, 1]],
  ['classical', 'Classical', [3, 2, 1, 0, 0, 0, -1, -1, 1, 2]],
  ['electronic', 'Electronic', [5, 4, 1, 0, -2, 1, 1, 2, 4, 5]],
  ['rock', 'Rock', [4, 3, 2, -1, -2, -1, 1, 3, 4, 4]],
  ['night', 'Late night', [-4, -3, -1, 0, 1, 1, 0, -1, -2, -3]],
];
const DEF = { eq: false, preset: 'flat', gains: Z, xfeed: false, mono: false, balance: 0 };

export function dsp() { const d = { ...DEF, ...(meta('dsp') || {}) }; d.gains = (d.gains || Z).slice(0, 10); while (d.gains.length < 10) d.gains.push(0); return d; }
export const customs = () => meta('eq_custom', []) || [];
const subs = new Set();
export function onDsp(f) { subs.add(f); return () => subs.delete(f); }

let pushT = 0;
export function setDsp(patch, { quiet = false } = {}) {
  const d = { ...dsp(), ...patch };
  setMeta('dsp', d);
  // Dragging a slider sends many updates; hand the player at most one per frame.
  cancelAnimationFrame(pushT);
  pushT = requestAnimationFrame(() => native.setDsp(d));
  if (!quiet) for (const f of subs) try { f(d); } catch (e) { console.error(e); }
  return d;
}
/** Send the saved settings to the player (at launch). */
export function applyDsp() { native.setDsp(dsp()); }

export function presetName(d = dsp()) {
  if (d.preset?.startsWith('c:')) return customs().find((c) => 'c:' + c.id === d.preset)?.name || 'Custom';
  return PRESETS.find((p) => p[0] === d.preset)?.[1] || 'Custom';
}
export const eqLabel = (d = dsp()) => (d.eq ? presetName(d) : 'Off');
export const headroom = (g) => -Math.max(0, ...g);

/** Magnitude response in dB at frequency f, same filters as the player (RBJ shelves + peaks). */
export function response(gains, f, rate = 48000) {
  let db = headroom(gains);
  for (let i = 0; i < 10; i++) {
    const g = gains[i];
    if (!g) continue;
    const A = 10 ** (g / 40), w0 = 2 * Math.PI * Math.min(FREQS[i], rate * 0.45) / rate, cs = Math.cos(w0), sn = Math.sin(w0);
    let b0, b1, b2, a0, a1, a2;
    if (i === 0 || i === 9) {
      const alpha = sn / 2 * Math.SQRT2, sq = 2 * Math.sqrt(A) * alpha;
      if (i === 0) { b0 = A * ((A + 1) - (A - 1) * cs + sq); b1 = 2 * A * ((A - 1) - (A + 1) * cs); b2 = A * ((A + 1) - (A - 1) * cs - sq); a0 = (A + 1) + (A - 1) * cs + sq; a1 = -2 * ((A - 1) + (A + 1) * cs); a2 = (A + 1) + (A - 1) * cs - sq; }
      else { b0 = A * ((A + 1) + (A - 1) * cs + sq); b1 = -2 * A * ((A - 1) + (A + 1) * cs); b2 = A * ((A + 1) + (A - 1) * cs - sq); a0 = (A + 1) - (A - 1) * cs + sq; a1 = 2 * ((A - 1) - (A + 1) * cs); a2 = (A + 1) - (A - 1) * cs - sq; }
    } else {
      const alpha = sn / (2 * 1.41);
      b0 = 1 + alpha * A; b1 = -2 * cs; b2 = 1 - alpha * A; a0 = 1 + alpha / A; a1 = -2 * cs; a2 = 1 - alpha / A;
    }
    const w = 2 * Math.PI * f / rate, c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
    const nr = b0 + b1 * c1 + b2 * c2, ni = -(b1 * s1 + b2 * s2), dr = a0 + a1 * c1 + a2 * c2, di = -(a1 * s1 + a2 * s2);
    db += 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
  }
  return db;
}

/** SVG path of the EQ curve for a w×h box, ±range dB. */
export function curvePath(gains, w = 300, h = 80, range = 12) {
  let d = '';
  for (let i = 0; i <= 60; i++) {
    const f = 20 * 1000 ** (i / 60);
    const y = h / 2 - (Math.max(-range, Math.min(range, response(gains, f))) / range) * (h / 2 - 2);
    d += `${i ? 'L' : 'M'}${((i / 60) * w).toFixed(1)} ${y.toFixed(1)}`;
  }
  return d;
}

// ---------------------------------------------------------------- the sheet

let sheet = null;
export function openEq() {
  if (sheet) return;
  sheet = openSheet({
    title: 'Sound', className: 'eqsheet', body: '',
    onClose: () => { sheet = null; },
    actions: {
      eqon: (b) => { setDsp({ eq: !dsp().eq }); render(); },
      preset: (b) => {
        const k = b.dataset.k;
        const g = k.startsWith('c:') ? customs().find((c) => 'c:' + c.id === k)?.gains : PRESETS.find((p) => p[0] === k)?.[2];
        if (!g) return;
        setDsp({ eq: true, preset: k, gains: g.slice() }); render();
      },
      delpreset: async (b, e) => {
        e.stopPropagation();
        const c = customs().find((x) => String(x.id) === b.dataset.id);
        if (!c || !(await confirmDlg(`Delete the preset “${c.name}”?`, { ok: 'Delete', danger: true, title: 'Delete preset' }))) return;
        setMeta('eq_custom', customs().filter((x) => x !== c && x.id !== c.id));
        if (dsp().preset === 'c:' + c.id) setDsp({ preset: 'custom' });
        render();
      },
      save: async () => {
        const d = dsp();
        const cur = d.preset?.startsWith('c:') ? customs().find((c) => 'c:' + c.id === d.preset) : null;
        const name = (await promptDlg('Save preset', { value: cur ? cur.name : '', placeholder: 'e.g. Sennheiser HD 600', ok: 'Save', hint: 'Saving with an existing name replaces it.' }))?.trim();
        if (!name) return;
        const list = customs();
        const same = list.find((c) => c.name.toLowerCase() === name.toLowerCase());
        const id = same ? same.id : Date.now();
        const next = same ? list.map((c) => (c === same ? { ...c, name, gains: d.gains.slice() } : c)) : [...list, { id, name, gains: d.gains.slice() }];
        setMeta('eq_custom', next);
        setDsp({ preset: 'c:' + id });
        toast(`Saved “${name}”`);
        render();
      },
      reset: () => { setDsp({ preset: 'flat', gains: Z.slice() }); render(); },
      xfeed: () => { setDsp({ xfeed: !dsp().xfeed }); render(); },
      mono: () => { setDsp({ mono: !dsp().mono }); render(); },
      center: () => { setDsp({ balance: 0 }); render(); },
    },
  });
  render();
}

function render() {
  if (!sheet) return;
  const d = dsp(), c = customs();
  const chip = (k, name, del) => html`<button class="chip ${d.eq && d.preset === k ? 'on' : ''}" data-act="preset" data-k="${k}">${name}${del ? html`<span class="x" data-act="delpreset" data-id="${del}" aria-label="Delete ${name}">${icon('close')}</span>` : ''}</button>`;
  const bal = Math.round(d.balance * 100);
  sheet.setBody(html`
    <div class="eq-top">
      <div class="grow"><div class="eq-name">${d.eq ? presetName(d) : 'Equaliser off'}</div><div class="tiny muted mono">${d.eq ? `HEADROOM ${headroom(d.gains) ? '−' + Math.abs(headroom(d.gains)).toFixed(1) : '0.0'} DB` : 'TAP A PRESET OR MOVE A BAND'}</div></div>
      <label class="toggle" aria-label="Equaliser"><input type="checkbox" data-act="eqon" ${d.eq ? 'checked' : ''}><span></span></label>
    </div>
    <div class="eq-graph ${d.eq ? '' : 'off'}"><svg viewBox="0 0 300 80" preserveAspectRatio="none" aria-hidden="true"><path class="mid" d="M0 40H300"/><path class="crv" id="eqcrv" d="${curvePath(d.gains)}"/></svg></div>
    <div class="eq-bands ${d.eq ? '' : 'off'}" id="eqbands" data-noswipe>${d.gains.map((g, i) => html`<div class="eq-band" data-i="${i}" role="slider" tabindex="0" aria-label="${BAND_LABELS[i]} Hz" aria-valuemin="-12" aria-valuemax="12" aria-valuenow="${g}">
      <span class="v mono">${fmt(g)}</span><div class="trk"><i class="fill"></i><b class="th"></b></div><span class="f mono">${BAND_LABELS[i]}</span></div>`)}</div>
    <div class="eq-chips">${PRESETS.map(([k, n]) => chip(k, n))}${c.map((x) => chip('c:' + x.id, x.name, String(x.id)))}</div>
    <div class="row gap" style="margin-top:10px"><button class="btn grow" data-act="save">${icon('plus')} Save preset</button><button class="btn" data-act="reset">Reset</button></div>

    <div class="sectionlabel"><span>Headphones</span></div>
    <label class="row between eq-row"><span>Crossfeed<div class="tiny muted">Blends a little of each side into the other ear, so hard-panned old stereo is easier on headphones.</div></span><span class="toggle"><input type="checkbox" data-act="xfeed" ${d.xfeed ? 'checked' : ''}><span></span></span></label>
    <label class="row between eq-row"><span>Mono<div class="tiny muted">Both ears get the same sound — for one earbud.</div></span><span class="toggle"><input type="checkbox" data-act="mono" ${d.mono ? 'checked' : ''}><span></span></span></label>
    <div class="eq-row"><div class="row between"><span>Balance</span><button class="mono tiny bal-v" data-act="center">${bal === 0 ? 'CENTRE' : bal < 0 ? `L ${-bal}` : `R ${bal}`}</button></div>
      <div class="bal mono" data-noswipe><span>L</span><input type="range" id="eqbal" min="-100" max="100" step="5" value="${bal}" aria-label="Balance"><span>R</span></div></div>
    ${native.isWeb ? html`<p class="tiny muted">In the web app these run through the browser’s audio engine. If music stops when the iPhone locks, turn sound settings off.</p>` : html`<p class="tiny muted">Applied inside Hibiki before the output, with automatic headroom so boosts don’t clip. Bluetooth codecs and USB DACs get the processed sound.</p>`}`);
  paintBands();
  bindBands();
  $('#eqbal', sheet.el).addEventListener('input', (e) => {
    const v = Number(e.target.value) / 100;
    setDsp({ balance: Math.abs(v) < 0.03 ? 0 : v });
    const n = Math.round(dsp().balance * 100);
    $('.bal-v', sheet.el).textContent = n === 0 ? 'CENTRE' : n < 0 ? `L ${-n}` : `R ${n}`;
  });
}
const fmt = (g) => (g > 0 ? '+' : g < 0 ? '−' : '') + Math.abs(g).toFixed(Math.abs(g) % 1 ? 1 : 0);

function paintBands() {
  const d = dsp();
  for (const b of $$('.eq-band', sheet.el)) {
    const g = d.gains[Number(b.dataset.i)], f = (g + 12) / 24;
    b.querySelector('.th').style.bottom = `calc(${(f * 100).toFixed(2)}% - 7px)`;
    const fill = b.querySelector('.fill');
    fill.style.bottom = `${(Math.min(f, 0.5) * 100).toFixed(2)}%`;
    fill.style.height = `${(Math.abs(f - 0.5) * 100).toFixed(2)}%`;
    b.querySelector('.v').textContent = fmt(g);
    b.setAttribute('aria-valuenow', g);
  }
  $('#eqcrv', sheet.el).setAttribute('d', curvePath(d.gains));
}

function bindBands() {
  const box = $('#eqbands', sheet.el);
  const setBand = (i, g) => {
    const d = dsp();
    const gains = d.gains.slice();
    gains[i] = Math.max(-12, Math.min(12, Math.round(g * 2) / 2));
    if (Math.abs(gains[i]) < 0.5) gains[i] = 0;
    const named = PRESETS.find((p) => p[2].every((v, k) => v === gains[k]));
    setDsp({ eq: true, gains, preset: named ? named[0] : 'custom' }, { quiet: true });
    paintBands();
    $('.eq-name', sheet.el).textContent = presetName();
    $('.eq-top .mono', sheet.el).textContent = `HEADROOM ${headroom(gains) ? '−' + Math.abs(headroom(gains)).toFixed(1) : '0.0'} DB`;
    for (const x of $$('.eq-chips .chip', sheet.el)) x.classList.toggle('on', x.dataset.k === dsp().preset);
    box.classList.remove('off'); $('.eq-graph', sheet.el).classList.remove('off');
    $('[data-act=eqon]', sheet.el).checked = true;
  };
  let drag = null, lastTap = { i: -1, t: 0 };
  box.addEventListener('pointerdown', (e) => {
    const b = e.target.closest('.eq-band');
    if (!b) return;
    const i = Number(b.dataset.i), now = Date.now();
    if (lastTap.i === i && now - lastTap.t < 300) { setBand(i, 0); lastTap = { i: -1, t: 0 }; for (const f of subs) f(dsp()); return; }
    lastTap = { i, t: now };
    const trk = b.querySelector('.trk').getBoundingClientRect();
    drag = { i, trk, y0: e.clientY, g0: dsp().gains[i], moved: false };
    b.setPointerCapture(e.pointerId);
    b.classList.add('drag');
  });
  box.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dy = drag.y0 - e.clientY;
    if (!drag.moved && Math.abs(dy) < 4) return;
    drag.moved = true;
    // Relative drag: the band moves with the finger from where it was, so grabbing never makes it jump.
    setBand(drag.i, drag.g0 + (dy / drag.trk.height) * 24);
  });
  const end = (e) => {
    if (!drag) return;
    const b = box.querySelector(`.eq-band[data-i="${drag.i}"]`);
    b?.classList.remove('drag');
    drag = null;
    for (const f of subs) f(dsp());
  };
  box.addEventListener('pointerup', end);
  box.addEventListener('pointercancel', end);
  box.addEventListener('keydown', (e) => {
    const b = e.target.closest('.eq-band');
    if (!b) return;
    const i = Number(b.dataset.i), g = dsp().gains[i];
    if (e.key === 'ArrowUp') { setBand(i, g + 0.5); e.preventDefault(); }
    if (e.key === 'ArrowDown') { setBand(i, g - 0.5); e.preventDefault(); }
  });
}
