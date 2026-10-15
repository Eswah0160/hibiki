// MusicBrainz lookup for an album: search → pick a release → preview the changes → write tags + cover.
import { html, icon, openSheet, toast } from './dom.js';
import { art, queueRender } from './app.js';
import * as repo from '../repo.js';
import * as native from '../native.js';
import * as mb from '../engine/mb.js';
import { invalidateHealth } from './health.js';
import { plural, titleOf, year, dur } from '../util.js';

export function openMbMatch(albumKey) {
  const a = repo.album(albumKey);
  if (!a) return toast('Album not found');
  const tracks = a.tracks.filter((t) => t.ext === 'flac');
  if (!tracks.length) return toast('MusicBrainz tagging works on FLAC files only');
  let q = { album: a.album === 'Unknown album' ? (a.folders[0] || '').split('/').pop() : a.album, artist: a.artist === 'Unknown artist' ? '' : a.artist };
  let results = null, error = null, picked = null, release = null, cover = null, opts = { genre: true, ids: true, cover: true };

  const searchView = () => html`
    <div class="row gap"><div class="field grow"><label>Album</label><input class="input" id="mbalbum" value="${q.album}"></div></div>
    <div class="row gap"><div class="field grow"><label>Artist</label><input class="input" id="mbartist" value="${q.artist}"></div><button class="btn primary" data-act="search" style="align-self:end;margin-bottom:12px">${icon('search')}</button></div>
    ${error ? html`<p class="banner warn">${icon('alert')} ${error}</p>` : ''}
    ${results === null ? html`<p class="small muted">Searching…</p>` : !results.length ? html`<p class="small muted">No releases found. Try fewer words.</p>` :
      html`<div class="card">${results.map((r) => html`<button class="item tap" data-act="pick" data-id="${r.id}">
        <div class="grow"><div class="title ellipsis">${r.title}</div>
          <div class="sub ellipsis">${r.artist} · ${[year(r.date), r.country, r.format, r.label].filter(Boolean).join(' · ')}</div></div>
        <span class="chip ${r.trackCount === tracks.length ? 'on' : ''}">${r.trackCount} trk</span></button>`)}</div>
        <p class="tiny muted">You have ${plural(tracks.length, 'track')}. Releases with the same count are highlighted.</p>`}`;

  const previewView = () => {
    const matches = mb.matchTracks(tracks, release);
    const matched = matches.filter((m) => m.remote);
    return html`
      <div class="tehead"><div class="covwrap">${cover ? html`<img class="art cov" src="data:${cover.mime};base64,${cover.b64}" alt="">` : art(a.art, { size: 'f', cls: 'cov' })}</div>
        <div class="grow"><div class="t">${release.title}</div><div class="small ink2">${mb.credit(release['artist-credit'])}</div>
          <div class="tiny muted">${[release.date, release.country, (release['label-info'] || [])[0]?.label?.name, mb.topGenres(release).join(', ')].filter(Boolean).join(' · ')}</div>
          <div class="tiny muted">${cover ? 'Cover from Cover Art Archive' : release['cover-art-archive']?.front ? 'Loading cover…' : 'No cover on Cover Art Archive'}</div></div></div>
      <label class="row small chk"><input type="checkbox" data-opt="cover" ${opts.cover && cover ? 'checked' : ''} ${cover ? '' : 'disabled'}> Embed this cover</label>
      <label class="row small chk"><input type="checkbox" data-opt="genre" ${opts.genre ? 'checked' : ''}> Set genre from MusicBrainz</label>
      <label class="row small chk"><input type="checkbox" data-opt="ids" ${opts.ids ? 'checked' : ''}> Add MusicBrainz IDs (helps future lookups)</label>
      <div class="sectionlabel"><span>Changes</span><span>${matched.length}/${tracks.length} matched</span></div>
      <div class="card mbdiff">${matches.map((m) => {
        if (!m.remote) return html`<div class="item"><span class="no num">?</span><div class="grow"><div class="title ellipsis">${titleOf(m.local)}</div><div class="sub neg">No match — left unchanged</div></div></div>`;
        const d = mb.diff(m.local, mb.tagsFor(release, m.remote, opts));
        return html`<div class="item"><span class="no num">${m.remote.num}</span><div class="grow">
          <div class="title ellipsis">${m.remote.title}</div>
          <div class="sub">${d.length ? d.map((x) => html`<span class="dchg"><b>${x.key.toLowerCase()}</b> ${x.from || '∅'} → ${x.to || '∅'}</span>`) : 'no visible changes'}</div>
          ${m.how === 'order' ? html`<div class="tiny warn">matched by position — check it</div>` : ''}
          ${m.remote.length && m.local.duration_ms && Math.abs(m.remote.length - m.local.duration_ms) > 5000 ? html`<div class="tiny warn">length differs: ${dur(m.local.duration_ms)} vs ${dur(m.remote.length)}</div>` : ''}
        </div></div>`;
      })}</div>`;
  };

  const sheet = openSheet({
    title: 'MusicBrainz', className: 'wide',
    body: searchView(),
    footer: html`<button class="btn grow" data-act="close">Cancel</button>`,
    actions: {
      search: () => { q = { album: sheet.el.querySelector('#mbalbum').value, artist: sheet.el.querySelector('#mbartist').value }; doSearch(); },
      pick: (b) => pick(b.dataset.id),
      back: () => { release = null; cover = null; sheet.setBody(searchView()); sheet.setFooter(html`<button class="btn grow" data-act="close">Cancel</button>`); },
      apply: () => apply(),
    },
  });
  sheet.el.addEventListener('change', (e) => {
    const o = e.target.dataset.opt;
    if (o) { opts[o] = e.target.checked; if (release) sheet.setBody(previewView()); }
  });
  sheet.el.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.target.id === 'mbalbum' || e.target.id === 'mbartist')) sheet.el.querySelector('[data-act=search]').click(); });

  async function doSearch() {
    results = null; error = null; sheet.setBody(searchView());
    try { results = await mb.searchReleases({ ...q, tracks: tracks.length }); }
    catch (e) { error = e.message; results = []; }
    // Same track count first, then MusicBrainz's own score.
    results.sort((x, y) => (y.trackCount === tracks.length) - (x.trackCount === tracks.length) || (y.score || 0) - (x.score || 0));
    if (!sheet.closed && !release) sheet.setBody(searchView());
  }

  async function pick(id) {
    picked = id;
    sheet.setBody(html`<p class="small muted">Loading release…</p>`);
    try { release = await mb.getRelease(id); }
    catch (e) { error = e.message; release = null; sheet.setBody(searchView()); return; }
    if (sheet.closed || picked !== id) return;
    sheet.setBody(previewView());
    sheet.setFooter(html`<button class="btn grow" data-act="back">Back</button><button class="btn primary grow" data-act="apply">Write tags</button>`);
    if (release['cover-art-archive']?.front) {
      try { cover = await mb.fetchCover(id, 1200); } catch { cover = null; }
      if (!sheet.closed && picked === id) sheet.setBody(previewView());
    }
  }

  async function apply() {
    const matches = mb.matchTracks(tracks, release).filter((m) => m.remote);
    if (!matches.length) return toast('No tracks matched');
    const edits = matches.map((m) => {
      const set = mb.tagsFor(release, m.remote, opts);
      for (const k of Object.keys(set)) if (set[k] == null) delete set[k]; // never wipe a field MusicBrainz doesn't know
      const e = { id: m.local.id, set };
      if (opts.cover && cover) { e.art = cover.b64; e.artMime = cover.mime; }
      return e;
    });
    sheet.setFooter(html`<div class="grow small ink2">Writing ${plural(edits.length, 'file')}…</div>`);
    try {
      const r = await native.writeTags(edits);
      const bad = r.results.filter((x) => !x.ok);
      invalidateHealth();
      queueRender();
      sheet.close();
      toast(bad.length ? `${bad.length} failed: ${bad[0].error}` : `Tagged ${plural(edits.length, 'track')} from MusicBrainz`, { ms: bad.length ? 7000 : 3500 });
      document.dispatchEvent(new CustomEvent('hibiki:tags', { detail: { ids: edits.map((e) => e.id) } }));
    } catch (e) {
      toast('Couldn’t write tags: ' + e.message, { ms: 7000 });
      sheet.setFooter(html`<button class="btn grow" data-act="back">Back</button><button class="btn primary grow" data-act="apply">Try again</button>`);
    }
  }

  doSearch();
}
