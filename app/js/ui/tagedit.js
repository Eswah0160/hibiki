// Tag editor for one or many FLAC tracks: common fields, track numbering, cover art, raw tags.
import { html, icon, openSheet, toast, confirmDlg } from './dom.js';
import { art, queueRender } from './app.js';
import * as repo from '../repo.js';
import * as native from '../native.js';
import { invalidateHealth } from './health.js';
import { titleOf, plural } from '../util.js';

const FIELDS = [
  ['TITLE', 'Title', 'title', { single: true }],
  ['ARTIST', 'Artist', 'artist'],
  ['ALBUM', 'Album', 'album'],
  ['ALBUMARTIST', 'Album artist', 'albumartist'],
  ['TRACKNUMBER', 'Track #', 'track_no', { single: true, num: true, half: true }],
  ['TRACKTOTAL', 'of', 'track_total', { num: true, half: true }],
  ['DISCNUMBER', 'Disc #', 'disc_no', { num: true, half: true }],
  ['DISCTOTAL', 'of', 'disc_total', { num: true, half: true }],
  ['DATE', 'Year / date', 'year'],
  ['GENRE', 'Genre', 'genre'],
  ['COMPOSER', 'Composer', 'composer'],
  ['COMMENT', 'Comment', null],
];

const tagsOf = (t) => { try { return JSON.parse(t.tags || '{}'); } catch { return {}; } };
const valOf = (t, f) => {
  const [key, , col] = f;
  if (col) return t[col] == null ? '' : String(t[col]);
  const v = tagsOf(t)[key];
  return v == null ? '' : Array.isArray(v) ? v.join('; ') : String(v);
};

/** Downscale/re-encode a picked image so covers don't bloat every file (max 1500 px JPEG). */
async function prepareImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const max = 1500;
    if (img.naturalWidth <= max && img.naturalHeight <= max && file.size < 1_200_000 && /jpe?g|png/.test(file.type)) {
      const b64 = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.readAsDataURL(file); });
      return { b64, mime: file.type, w: img.naturalWidth, h: img.naturalHeight };
    }
    const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    const data = c.toDataURL('image/jpeg', 0.9);
    return { b64: data.split(',')[1], mime: 'image/jpeg', w: c.width, h: c.height };
  } finally { URL.revokeObjectURL(url); }
}

export function openTagEditor(ids, { preset = null } = {}) {
  const all = repo.tracksByIds(ids);
  const tracks = all.filter((t) => t.ext === 'flac');
  if (!tracks.length) return toast('Tag editing works on FLAC files only');
  const single = tracks.length === 1;
  const fields = FIELDS.filter((f) => !(f[3]?.single && !single));
  const common = {};
  for (const f of fields) {
    const vals = new Set(tracks.map((t) => valOf(t, f)));
    common[f[0]] = vals.size === 1 ? [...vals][0] : null; // null = differs
  }
  const dirty = {};
  if (preset) for (const [k, v] of Object.entries(preset)) dirty[k] = v;
  let numberSeq = false;
  let cover = null;  // {b64, mime, w, h} | 'remove' | null
  let raw = single ? Object.entries(tagsOf(tracks[0])).filter(([k]) => !k.startsWith('_')).map(([k, v]) => [k, Array.isArray(v) ? v.join('; ') : String(v)]) : null;
  let rawDirty = false;
  const t0 = tracks[0];
  const coverPreview = () => cover === 'remove' ? html`<div class="art ph cov">${icon('close')}</div>`
    : cover ? html`<img class="art cov" src="data:${cover.mime};base64,${cover.b64}" alt="">`
    : art(tracks.find((t) => t.art_key)?.art_key, { size: 'f', cls: 'cov' });
  const curArt = tracks.find((t) => t.art_key);

  const body = () => html`
    ${all.length > tracks.length ? html`<p class="banner warn">${icon('info')} ${plural(all.length - tracks.length, 'non-FLAC file')} skipped — only FLAC tags can be written.</p>` : ''}
    <div class="tehead">
      <div class="covwrap">${coverPreview()}</div>
      <div class="grow">
        <div class="lbl">${single ? 'Editing' : `Editing ${tracks.length} tracks`}</div>
        <div class="t ellipsis">${single ? titleOf(t0) : (common.ALBUM || 'Mixed albums')}</div>
        <div class="tiny muted">${cover === 'remove' ? 'Cover will be removed' : cover ? `New cover ${cover.w}×${cover.h}` : curArt ? `Cover ${curArt.art_w}×${curArt.art_h} (${curArt.art_src})` : 'No cover'}</div>
        <div class="row wrap" style="margin-top:6px">
          <label class="btn sm">${icon('image')} Choose image<input type="file" accept="image/*" id="tefile" hidden></label>
          ${curArt || cover ? html`<button class="btn sm" data-act="rmcover">Remove</button>` : ''}
        </div>
      </div>
    </div>
    <div class="tegrid">${fields.map((f) => {
      const [key, label, , o = {}] = f;
      const v = key in dirty ? dirty[key] : common[key] ?? '';
      const differs = common[key] === null && !(key in dirty);
      return html`<div class="field ${o.half ? 'half' : ''} ${key in dirty ? 'changed' : ''}"><label>${label}</label>
        <input class="input" data-k="${key}" value="${v}" placeholder="${differs ? '(keep different values)' : ''}" ${o.num ? 'inputmode="numeric"' : ''} autocomplete="off"></div>`;
    })}</div>
    ${!single ? html`<label class="row small chk"><input type="checkbox" id="teseq" ${numberSeq ? 'checked' : ''}> Number tracks 1–${tracks.length} in the order shown on the album</label>` : ''}
    ${single ? html`<details class="more"><summary>All tags (${raw.length})</summary>
      <div class="rawtags">${raw.map(([k, v], i) => html`<div class="rawrow"><input class="input mono" data-raw="k" data-i="${i}" value="${k}"><input class="input" data-raw="v" data-i="${i}" value="${v}"><button class="iconbtn sm" data-act="rawdel" data-i="${i}">${icon('close')}</button></div>`)}
      <button class="btn sm" data-act="rawadd">${icon('plus')} Add tag</button>
      <p class="tiny muted">Raw Vorbis comments. Editing here overrides the fields above for the same keys.</p></div></details>` : ''}`;

  const sheet = openSheet({
    title: 'Edit tags', className: 'wide',
    body: body(),
    footer: html`<button class="btn grow" data-act="close">Cancel</button><button class="btn primary grow" data-act="save">Save to file${single ? '' : 's'}</button>`,
    actions: {
      rmcover: () => { cover = 'remove'; sheet.setBody(body()); },
      rawadd: () => { raw.push(['', '']); rawDirty = true; sheet.setBody(body()); sheet.el.querySelector('details').open = true; },
      rawdel: (b) => { raw.splice(+b.dataset.i, 1); rawDirty = true; sheet.setBody(body()); sheet.el.querySelector('details').open = true; },
      save: () => save(),
    },
  });
  sheet.el.addEventListener('input', (e) => {
    const t = e.target;
    if (t.dataset.k) { dirty[t.dataset.k] = t.value; t.closest('.field').classList.add('changed'); }
    if (t.dataset.raw) { raw[+t.dataset.i][t.dataset.raw === 'k' ? 0 : 1] = t.value; rawDirty = true; }
  });
  sheet.el.addEventListener('change', async (e) => {
    if (e.target.id === 'teseq') numberSeq = e.target.checked;
    if (e.target.id === 'tefile' && e.target.files[0]) {
      try { cover = await prepareImage(e.target.files[0]); sheet.setBody(body()); }
      catch { toast('Couldn’t read that image'); }
    }
  });

  async function save() {
    const order = tracks.slice().sort((a, b) => (a.disc_no || 1) - (b.disc_no || 1) || (a.track_no || 999) - (b.track_no || 999) || String(a.filename).localeCompare(String(b.filename), undefined, { numeric: true }));
    const edits = tracks.map((t) => {
      const set = {};
      for (const [k, v] of Object.entries(dirty)) set[k] = v.trim() === '' ? null : v.trim();
      if (numberSeq) { set.TRACKNUMBER = String(order.indexOf(t) + 1); set.TRACKTOTAL = String(tracks.length); }
      if (single && rawDirty) {
        const before = tagsOf(t);
        const now = new Map(raw.filter(([k]) => k.trim()).map(([k, v]) => [k.trim().toUpperCase(), v]));
        for (const k of Object.keys(before)) if (!k.startsWith('_') && !now.has(k.toUpperCase())) set[k] = null;
        for (const [k, v] of now) set[k] = v === '' ? null : v;
      }
      const e = { id: t.id, set };
      if (cover === 'remove') e.art = 'remove';
      else if (cover) { e.art = cover.b64; e.artMime = cover.mime; }
      return e;
    }).filter((e) => Object.keys(e.set).length || e.art);
    if (!edits.length) { sheet.close(); return; }
    for (const e of edits) for (const k of Object.keys(e.set)) if (!/^[A-Za-z0-9_ ]{1,64}$/.test(k)) return toast(`“${k}” isn’t a valid tag name`);
    if (edits.length > 20 && !(await confirmDlg(`Write tags to ${edits.length} files?`, { ok: 'Write' }))) return;
    sheet.setFooter(html`<div class="grow small ink2">Writing ${plural(edits.length, 'file')}…</div>`);
    try {
      const r = await native.writeTags(edits);
      const bad = r.results.filter((x) => !x.ok);
      const rewrites = r.results.filter((x) => x.mode === 'rewrite').length;
      invalidateHealth();
      queueRender();
      sheet.close();
      if (bad.length) toast(`${bad.length} file${bad.length === 1 ? '' : 's'} failed: ${bad[0].error}`, { ms: 7000 });
      else toast(`Saved ${plural(r.results.length, 'file')}${rewrites ? ` (${rewrites} rewritten to make room)` : ''}`);
      document.dispatchEvent(new CustomEvent('hibiki:tags', { detail: { ids: edits.map((e) => e.id) } }));
    } catch (e) {
      toast('Couldn’t save: ' + e.message, { ms: 7000 });
      sheet.setFooter(html`<button class="btn grow" data-act="close">Close</button><button class="btn primary grow" data-act="save">Try again</button>`);
    }
  }
}
