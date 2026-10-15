// Playlists: manual lists and smart (rule-based) ones.
import { registerScreen, go, art, queueRender } from './app.js';
import { html, icon, openSheet, promptDlg, confirmDlg, menu, toast } from './dom.js';
import * as repo from '../repo.js';
import { db } from '../db.js';
import { trackRow, trackMenu, emptyState } from './common.js';
import { playTracks } from '../play.js';
import { FIELDS, OPS, SORTS, PRESETS, compile, describe } from '../engine/smart.js';
import { plural, dur, titleOf } from '../util.js';
import * as native from '../native.js';

export function smartTracks(p) {
  const rules = typeof p.rules === 'string' ? JSON.parse(p.rules || '{}') : p.rules;
  const { sql, params } = compile(rules || {});
  return db.all(sql, params);
}

function covers(tracks) {
  const keys = [...new Set(tracks.map((t) => t.art_key).filter(Boolean))].slice(0, 4);
  if (keys.length < 4) return art(keys[0], { cls: 'plart' });
  return html`<div class="plart mosaic">${keys.map((k) => art(k))}</div>`;
}

registerScreen('playlists', {
  top: () => ({ title: 'Playlists', actions: [{ id: 'new', icon: 'plus', label: 'New playlist' }] }),
  render(el) {
    const lists = repo.playlists();
    const manual = lists.filter((p) => p.kind === 'manual'), smart = lists.filter((p) => p.kind === 'smart');
    const starred = db.val('SELECT COUNT(*) FROM stars s JOIN tracks t ON t.id=s.track_id WHERE t.missing=0');
    el.innerHTML = String(html`<div class="page">
      <div class="card">
        <button class="item tap" data-act="starred"><span class="fic star">${icon('starOn')}</span><div class="grow"><div class="title">Starred</div><div class="sub">${plural(starred, 'track')}</div></div>${icon('fwd')}</button>
      </div>
      <div class="sectionlabel"><span>Your playlists</span><button class="more" data-act="new">New</button></div>
      ${manual.length ? html`<div class="card">${manual.map((p) => html`<button class="item tap" data-act="open" data-id="${p.id}">${covers(repo.playlistTracks(p.id).slice(0, 8))}<div class="grow"><div class="title ellipsis">${p.name}</div><div class="sub">${plural(p.n, 'track')}</div></div>${icon('fwd')}</button>`)}</div>`
        : html`<p class="muted pad small">Make one from the ⋯ menu on any track or album, or tap New.</p>`}
      <div class="sectionlabel"><span>Smart playlists</span><button class="more" data-act="newsmart">New</button></div>
      <div class="card">${smart.map((p) => html`<button class="item tap" data-act="open" data-id="${p.id}"><span class="fic">${icon('sparkle')}</span><div class="grow"><div class="title ellipsis">${p.name}</div><div class="sub ellipsis">${describe(JSON.parse(p.rules || '{}'))}</div></div>${icon('fwd')}</button>`)}
        ${PRESETS.filter((pr) => !smart.some((p) => p.name === pr.name)).map((pr) => html`<button class="item tap ghost" data-act="addpreset" data-name="${pr.name}"><span class="fic">${icon('plus')}</span><div class="grow"><div class="title ellipsis">${pr.name}</div><div class="sub ellipsis">${describe(pr.rules)}</div></div></button>`)}
      </div>
    </div>`);
  },
  topAction(a) { if (a === 'new') newManual(); },
  async on(act, el) {
    switch (act) {
      case 'open': return go('playlist', el.dataset.id);
      case 'starred': return go('playlist', 'starred');
      case 'new': return newManual();
      case 'newsmart': return editSmart(null);
      case 'addpreset': {
        const pr = PRESETS.find((p) => p.name === el.dataset.name);
        const id = repo.createPlaylist(pr.name, { kind: 'smart', rules: pr.rules });
        return go('playlist', id);
      }
      default: return null;
    }
  },
});

async function newManual() {
  const name = await promptDlg('New playlist', { placeholder: 'Name', ok: 'Create' });
  if (!name || !name.trim()) return;
  const id = repo.createPlaylist(name.trim());
  go('playlist', id);
}

// ---------------------------------------------------------------- one playlist

let cur = null, list = [];
registerScreen('playlist', {
  top: (s) => ({ back: true, title: '', actions: s.params.id === 'starred' ? [] : [{ id: 'pmenu', icon: 'more', label: 'Playlist options' }], noSearch: true }),
  render(el, s) {
    if (s.params.id === 'starred') {
      cur = { id: 'starred', name: 'Starred', kind: 'starred' };
      list = db.all(`SELECT t.*, 1 AS starred FROM stars s JOIN tracks t ON t.id=s.track_id WHERE t.missing=0 ORDER BY s.at DESC`);
    } else {
      cur = repo.playlist(Number(s.params.id));
      if (!cur) { el.innerHTML = String(html`<div class="page">${emptyState('playlist', 'Playlist not found', '')}</div>`); return; }
      list = cur.kind === 'smart' ? smartTracks(cur) : repo.playlistTracks(cur.id);
    }
    const ms = list.reduce((x, t) => x + (t.duration_ms || 0), 0);
    el.innerHTML = String(html`<div class="page">
      <div class="ahead">${covers(list)}<div class="ainfo">
        <h2>${cur.name}</h2>
        <div class="meta">${cur.kind === 'smart' ? html`${icon('sparkle')} ${describe(JSON.parse(cur.rules || '{}'))} · ` : ''}${plural(list.length, 'track')} · ${dur(ms)}</div>
        <div class="row acts"><button class="btn primary" data-act="playall" ${list.length ? '' : 'disabled'}>${icon('play')} Play</button><button class="btn" data-act="shuffleall" ${list.length ? '' : 'disabled'}>${icon('shuffle')} Shuffle</button>
        ${cur.kind === 'smart' ? html`<button class="btn" data-act="edit">${icon('edit')} Rules</button>` : ''}</div>
      </div></div>
      ${list.length ? html`<div class="card tlist">${list.map((t, i) => trackRow(t, { showArt: true, showAlbum: true, i }))}</div>`
        : cur.kind === 'smart' ? html`<p class="muted pad">No tracks match these rules yet.</p>` : emptyState('playlist', 'Empty playlist', 'Add tracks from the ⋯ menu on any track or album.')}
    </div>`);
  },
  topAction(a) { if (a === 'pmenu') playlistMenu(); },
  on(act, el) {
    switch (act) {
      case 'playall': return playTracks(list, 0);
      case 'shuffleall': return playTracks(list, 0, { shuffle: true });
      case 'play': return playTracks(list, +el.dataset.i);
      case 'edit': return editSmart(cur);
      case 'tmenu': {
        const t = list.find((x) => x.id === Number(el.dataset.id));
        return trackMenu(Number(el.dataset.id), cur.kind === 'manual' ? { playlistItem: t?.item_id, playlistId: cur.id } : {});
      }
      default: return null;
    }
  },
});

async function playlistMenu() {
  if (!cur || cur.id === 'starred') return;
  const v = await menu(cur.name, [
    { label: 'Rename', icon: 'edit', value: 'rename' },
    cur.kind === 'smart' ? { label: 'Edit rules', icon: 'sparkle', value: 'rules' } : null,
    cur.kind === 'smart' ? { label: 'Save as a normal playlist', icon: 'playlist', value: 'freeze', sub: 'A fixed copy of today’s tracks' } : null,
    { label: 'Share as text', icon: 'share', value: 'share' },
    { label: 'Export M3U8', icon: 'download', value: 'm3u', sub: 'Downloads/Hibiki' },
    { label: 'Delete', icon: 'trash', value: 'delete', danger: true },
  ]);
  if (v === 'rename') {
    const name = await promptDlg('Rename', { value: cur.name });
    if (name && name.trim()) repo.updatePlaylist(cur.id, { name: name.trim() });
  } else if (v === 'rules') editSmart(cur);
  else if (v === 'freeze') {
    const id = repo.createPlaylist(cur.name + ' (copy)');
    repo.addToPlaylist(id, list.map((t) => t.id));
    go('playlist', id);
  } else if (v === 'share') {
    native.share(`${cur.name}\n\n` + list.map((t, i) => `${i + 1}. ${t.artist || ''} — ${titleOf(t)}`).join('\n'), { subject: cur.name });
  } else if (v === 'm3u') {
    const body = '#EXTM3U\n' + list.map((t) => `#EXTINF:${Math.round((t.duration_ms || 0) / 1000)},${t.artist || ''} - ${titleOf(t)}\n${t.folder ? t.folder + '/' : ''}${t.filename}`).join('\n') + '\n';
    const r = native.saveFile(`${cur.name.replace(/[\\/:*?"<>|]/g, '_')}.m3u8`, 'audio/x-mpegurl', body);
    toast(r.ok ? 'Saved to Downloads/Hibiki (paths are relative to your music folder)' : 'Could not save');
  } else if (v === 'delete') {
    if (await confirmDlg(`Delete “${cur.name}”? The music files aren’t touched.`, { ok: 'Delete', danger: true })) { repo.deletePlaylist(cur.id); go('playlists'); }
  }
}

// ---------------------------------------------------------------- smart rule editor

function editSmart(p) {
  const def = p ? JSON.parse(p.rules || '{}') : { match: 'all', rules: [{ field: 'genre', op: 'contains', value: '' }], sort: 'random', limit: 100 };
  def.rules = def.rules || [];
  let name = p?.name || '';
  const fieldOpts = (sel) => Object.entries(FIELDS).map(([k, f]) => html`<option value="${k}" ${k === sel ? 'selected' : ''}>${f.label}</option>`);
  const opOpts = (field, sel) => OPS[FIELDS[field].type].map(([k, l]) => html`<option value="${k}" ${k === sel ? 'selected' : ''}>${l}</option>`);
  const needsValue = (r) => !['bool'].includes(FIELDS[r.field].type) && !['never', 'empty'].includes(r.op);
  const count = () => { try { const { sql, params } = compile({ ...def, limit: 0 }); return db.all(`SELECT COUNT(*) n FROM (${sql})`, params)[0].n; } catch { return 0; } };
  const body = () => html`
    <div class="field"><label>Name</label><input class="input" id="sname" value="${name}" placeholder="e.g. Late-night jazz"></div>
    <div class="row small" style="margin-bottom:8px">Match <select class="input inl" id="smatch"><option value="all" ${def.match !== 'any' ? 'selected' : ''}>all</option><option value="any" ${def.match === 'any' ? 'selected' : ''}>any</option></select> of these rules:</div>
    ${def.rules.map((r, i) => html`<div class="rule" data-i="${i}">
      <select class="input" data-r="field">${fieldOpts(r.field)}</select>
      <select class="input" data-r="op">${opOpts(r.field, r.op)}</select>
      ${needsValue(r) ? html`<input class="input" data-r="value" value="${r.value ?? ''}" ${FIELDS[r.field].type !== 'text' ? 'inputmode="decimal"' : ''} placeholder="${r.op === 'between' ? 'e.g. 1990-1999' : ''}">` : html`<span></span>`}
      <button class="iconbtn sm" data-act="rmrule" data-i="${i}" aria-label="Remove rule">${icon('close')}</button>
    </div>`)}
    <button class="btn sm" data-act="addrule">${icon('plus')} Add rule</button>
    <div class="row" style="margin-top:14px;gap:10px">
      <div class="field grow"><label>Order</label><select class="input" id="ssort">${Object.entries(SORTS).map(([k, v]) => html`<option value="${k}" ${def.sort === k ? 'selected' : ''}>${v.label}</option>`)}</select></div>
      <div class="field" style="width:110px"><label>Limit</label><input class="input" id="slimit" inputmode="numeric" value="${def.limit || ''}" placeholder="none"></div>
    </div>
    <p class="small ink2" id="scount">${plural(count(), 'track')} match now</p>`;
  const sheet = openSheet({
    title: p ? 'Edit smart playlist' : 'New smart playlist', body: body(),
    footer: html`${p ? html`<button class="btn danger" data-act="del">Delete</button>` : ''}<button class="btn grow" data-act="close">Cancel</button><button class="btn primary grow" data-act="save">Save</button>`,
    actions: {
      addrule: () => { def.rules.push({ field: 'artist', op: 'contains', value: '' }); sheet.setBody(body()); },
      rmrule: (b) => { def.rules.splice(+b.dataset.i, 1); sheet.setBody(body()); },
      save: () => {
        name = sheet.el.querySelector('#sname').value.trim() || 'Smart playlist';
        if (p) { repo.updatePlaylist(p.id, { name, rules: def }); sheet.close(); queueRender(); }
        else { const id = repo.createPlaylist(name, { kind: 'smart', rules: def }); sheet.close(); go('playlist', id); }
      },
      del: async () => { if (await confirmDlg(`Delete “${p.name}”?`, { ok: 'Delete', danger: true })) { repo.deletePlaylist(p.id); sheet.close(); go('playlists'); } },
    },
  });
  sheet.el.addEventListener('change', (e) => {
    const t = e.target;
    if (t.id === 'smatch') def.match = t.value;
    else if (t.id === 'ssort') def.sort = t.value;
    else if (t.id === 'slimit') def.limit = parseInt(t.value, 10) || 0;
    else if (t.id === 'sname') name = t.value;
    else if (t.dataset.r) {
      const r = def.rules[+t.closest('.rule').dataset.i];
      if (t.dataset.r === 'field') { r.field = t.value; r.op = OPS[FIELDS[r.field].type][0][0]; r.value = ''; name = sheet.el.querySelector('#sname').value; sheet.setBody(body()); return; }
      if (t.dataset.r === 'op') { r.op = t.value; name = sheet.el.querySelector('#sname').value; sheet.setBody(body()); return; }
      r.value = FIELDS[r.field].type === 'num' && r.op !== 'between' ? Number(t.value) : t.value;
    }
    const c = sheet.el.querySelector('#scount'); if (c) c.textContent = `${plural(count(), 'track')} match now`;
  });
}
