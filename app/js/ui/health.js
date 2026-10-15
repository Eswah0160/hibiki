// Library health: score, issues by check, and one-tap fixes.
import { registerScreen, go, state, queueRender, art, setBadge } from './app.js';
import { html, icon, confirmDlg, toast, openSheet } from './dom.js';
import { db } from '../db.js';
import * as repo from '../repo.js';
import { runHealth, score, summarize, CHECKS } from '../engine/health.js';
import { plural } from '../util.js';
import { playTracks } from '../play.js';
import { trackRow, trackMenu } from './common.js';

let cache = null, cacheVer = -1;
export function invalidateHealth() { cache = null; }

function compute() {
  if (cache && cacheVer === db.version) return cache;
  const all = repo.allTracks();
  const issues = runHealth(all, { ignored: repo.ignored() });
  const live = all.filter((t) => !t.missing).length;
  cache = { issues, score: score(issues, live || all.length), summary: summarize(issues), total: live };
  cacheVer = db.version;
  setBadge('health', issues.filter((i) => !i.ignored && i.severity === 'high').length);
  return cache;
}

export function healthSnapshot() {
  const c = compute();
  const active = c.issues.filter((i) => !i.ignored);
  return { score: c.score, active: active.length, high: active.filter((i) => i.severity === 'high').length };
}

const SEV = { high: 'Important', medium: 'Worth fixing', low: 'Nice to have' };

registerScreen('health', {
  top: () => ({ title: 'Health', actions: [{ id: 'rescan', icon: 'refresh', label: 'Rescan' }] }),
  render(el, s) {
    const c = compute();
    const f = s.healthFilter;
    const shown = c.issues.filter((i) => (f ? i.check === f : true) && (s.showIgnored ? true : !i.ignored));
    const ignoredCount = c.issues.filter((i) => i.ignored).length;
    el.innerHTML = String(html`<div class="page">
      <div class="hscore">
        <div class="ring" style="--v:${c.score}"><b class="num">${c.score}</b></div>
        <div><div class="lbl">Library health</div>
          <div class="small ink2">${c.summary.length ? `${plural(c.issues.filter((i) => !i.ignored).length, 'issue')} across ${plural(c.total, 'track')}` : `No issues in ${plural(c.total, 'track')}`}</div>
          ${ignoredCount ? html`<button class="link small" data-act="toggleignored">${s.showIgnored ? 'Hide' : 'Show'} ${ignoredCount} dismissed</button>` : ''}
        </div>
      </div>
      ${c.summary.length ? html`<div class="chips"><button class="chip ${!f ? 'on' : ''}" data-act="filter" data-k="">All</button>${c.summary.map((x) => html`<button class="chip ${f === x.check ? 'on' : ''} ${x.severity === 'high' ? 'bad' : ''}" data-act="filter" data-k="${x.check}">${x.label} <b>${x.count}</b></button>`)}</div>` : ''}
      ${f ? html`<p class="small ink2">${CHECKS[f].blurb}</p>` : ''}
      ${['high', 'medium', 'low'].map((sev) => {
        const list = shown.filter((i) => i.severity === sev);
        if (!list.length) return '';
        return html`<div class="sectionlabel"><span>${SEV[sev]}</span><span>${list.length}</span></div>
          <div class="card">${list.slice(0, 200).map((i) => issueRow(i))}${list.length > 200 ? html`<div class="item muted small">…and ${list.length - 200} more. Filter by type above.</div>` : ''}</div>`;
      })}
      ${!shown.length ? html`<div class="empty">${icon('check')}<h3>All clear</h3><p>${f ? 'Nothing of this kind.' : 'Your library looks tidy.'}</p></div>` : ''}
    </div>`);
  },
  topAction(a) { if (a === 'rescan') import('./scan.js').then((m) => m.startScan(false)); },
  async on(act, el) {
    switch (act) {
      case 'filter': state.healthFilter = el.dataset.k || null; return queueRender();
      case 'toggleignored': state.showIgnored = !state.showIgnored; return queueRender();
      case 'issue': return openIssue(el.dataset.key);
      default: return null;
    }
  },
});

function issueRow(i) {
  const artKey = i.albumKey ? db.val('SELECT MAX(art_key) FROM tracks WHERE album_key=?', [i.albumKey]) : null;
  return html`<button class="item tap issue ${i.ignored ? 'dim' : ''}" data-act="issue" data-key="${i.key}">
    ${i.albumKey ? art(artKey, { cls: 'sm' }) : html`<span class="fic sev-${i.severity}">${icon(i.severity === 'high' ? 'alert' : 'info')}</span>`}
    <div class="grow"><div class="title ellipsis">${i.title}</div><div class="sub ellipsis">${CHECKS[i.check].label}${i.detail ? ' · ' + i.detail.split('\n')[0] : ''}</div></div>${icon('fwd')}</button>`;
}

function openIssue(key) {
  const i = compute().issues.find((x) => x.key === key);
  if (!i) return;
  const tracks = repo.tracksByIds(i.trackIds);
  const fixes = [];
  if (i.fix === 'remove_missing') fixes.push(html`<button class="btn danger grow" data-act="rmmissing">${icon('trash')} Remove from library</button>`);
  if ((i.fix === 'art' || i.fix === 'tags') && i.albumKey && tracks.some((t) => t.ext === 'flac')) fixes.push(html`<button class="btn primary grow" data-act="mb">${icon('sparkle')} MusicBrainz</button>`);
  if ((i.fix === 'tags' || i.fix === 'art') && tracks.some((t) => t.ext === 'flac')) fixes.push(html`<button class="btn grow" data-act="tags">${icon('tag')} Edit tags</button>`);
  const sheet = openSheet({
    title: CHECKS[i.check].label,
    body: html`<h3 class="m0">${i.title}</h3>
      ${i.detail ? html`<pre class="log">${i.detail}</pre>` : ''}
      <p class="small ink2">${CHECKS[i.check].blurb}</p>
      ${i.check === 'missing' ? html`<p class="small ink2">If you moved them, rescan — Hibiki relinks moved files (same audio checksum, or same name and size) and keeps their play counts.</p>` : ''}
      ${i.check === 'lossy' ? html`<p class="small ink2">Hibiki can’t make a lossy file lossless. Replace it with a lossless copy you own (e.g. from Qobuz’s store or Bandcamp), then rescan.</p>` : ''}
      <div class="tlist card">${tracks.slice(0, 60).map((t, n) => trackRow(t, { showArt: !i.albumKey, num: !!i.albumKey, i: n, sub: `${t.folder}/${t.filename}` }))}</div>
      ${tracks.length > 60 ? html`<p class="tiny muted">…and ${tracks.length - 60} more</p>` : ''}
      <div class="row" style="margin-top:10px">${fixes}</div>`,
    footer: html`<button class="btn grow" data-act="ignore">${i.ignored ? 'Restore' : 'Dismiss'}</button>${i.albumKey ? html`<button class="btn grow" data-act="album">Open album</button>` : ''}`,
    actions: {
      play: (b) => playTracks(tracks, +b.dataset.i),
      tmenu: (b) => trackMenu(Number(b.dataset.id)),
      ignore: () => { repo.ignoreIssue(i.key, !i.ignored); invalidateHealth(); sheet.close(); queueRender(); toast(i.ignored ? 'Restored' : 'Dismissed — it won’t count against your score'); },
      album: () => { sheet.close(); go('album', i.albumKey); },
      tags: async () => { sheet.close(); (await import('./tagedit.js')).openTagEditor(tracks.filter((t) => t.ext === 'flac').map((t) => t.id)); },
      mb: async () => { sheet.close(); (await import('./mbmatch.js')).openMbMatch(i.albumKey); },
      rmmissing: async () => {
        if (!(await confirmDlg(`Remove ${plural(tracks.length, 'missing track')} from the library? Play history for them goes too. No files are deleted.`, { ok: 'Remove', danger: true }))) return;
        repo.removeMissing(i.trackIds);
        invalidateHealth(); sheet.close(); toast('Removed');
      },
    },
  });
}
