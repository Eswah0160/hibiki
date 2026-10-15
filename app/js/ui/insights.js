// Insights: listening history and what the library is made of.
import { registerScreen, go, state, art, queueRender } from './app.js';
import { html, icon, menu, toast } from './dom.js';
import { PERIODS, listening, library, monthMarkdown } from '../engine/stats.js';
import { longDur, plural } from '../util.js';
import { trackRow, trackMenu } from './common.js';
import { playTracks } from '../play.js';
import * as native from '../native.js';
import { db } from '../db.js';

let top = [];

function bars(rows, { value = (r) => r.n, label = (r) => r.name, fmt = (v) => v.toLocaleString('en-AU') } = {}) {
  const max = Math.max(1, ...rows.map(value));
  return html`${rows.map((r) => html`<div class="hbar"><span class="ellipsis">${label(r)}</span><span class="track"><i style="width:${(value(r) / max) * 100}%"></i></span><span class="num small">${fmt(value(r))}</span></div>`)}`;
}

function weekChart(weeks) {
  const max = Math.max(1, ...weeks.map((w) => w.ms));
  return html`<div class="vbars">${weeks.map((w, i) => {
    const d = new Date(w.start);
    return html`<div class="vb" title="${longDur(w.ms)}"><i style="height:${Math.max(2, (w.ms / max) * 100)}%" class="${i === weeks.length - 1 ? 'now' : ''}"></i><span>${i % 3 === 0 || i === weeks.length - 1 ? `${d.getDate()}/${d.getMonth() + 1}` : ''}</span></div>`;
  })}</div>`;
}

function hourChart(hours) {
  const max = Math.max(1, ...hours);
  return html`<div class="vbars hours">${hours.map((ms, h) => html`<div class="vb"><i style="height:${Math.max(2, (ms / max) * 100)}%"></i><span>${h % 6 === 0 ? `${h}h` : ''}</span></div>`)}</div>`;
}

registerScreen('insights', {
  top: () => ({ title: 'Insights', actions: [{ id: 'export', icon: 'download', label: 'Export to Obsidian' }] }),
  render(el, s) {
    const tabs = html`<div class="tabs"><button class="${s.insightsTab === 'listening' ? 'on' : ''}" data-act="tab" data-k="listening">Listening</button><button class="${s.insightsTab === 'library' ? 'on' : ''}" data-act="tab" data-k="library">Library</button></div>`;
    if (s.insightsTab === 'library') {
      const L = library();
      el.innerHTML = String(html`<div class="page">${tabs}
        <div class="wgrid">
          <div class="card"><div class="card-h">Quality</div><div class="card-b">${bars(L.quality, { fmt: (v) => `${Math.round((v / Math.max(1, L.total)) * 100)}%` })}</div></div>
          <div class="card"><div class="card-h">Formats</div><div class="card-b">${bars(L.formats)}</div></div>
          <div class="card"><div class="card-h">Decades</div><div class="card-b">${bars(L.decades)}</div></div>
          <div class="card"><div class="card-h">Genres</div><div class="card-b">${L.genres.length ? bars(L.genres) : html`<p class="muted small">No genre tags yet. MusicBrainz lookups can add them.</p>`}</div></div>
        </div></div>`);
      return;
    }
    const d = listening(s.period);
    top = d.topTracks;
    el.innerHTML = String(html`<div class="page">${tabs}
      <div class="seg" style="margin-bottom:12px">${Object.entries(PERIODS).map(([k, p]) => html`<button class="${s.period === k ? 'on' : ''}" data-act="period" data-k="${k}">${p.label}</button>`)}</div>
      <div class="tiles">
        <div class="tile"><div class="l">Listening time</div><div class="v">${longDur(d.ms)}</div></div>
        <div class="tile"><div class="l">Plays</div><div class="v">${d.plays.toLocaleString('en-AU')}</div></div>
        <div class="tile"><div class="l">Different tracks</div><div class="v">${d.tracks.toLocaleString('en-AU')}</div></div>
        <div class="tile"><div class="l">Streak</div><div class="v">${plural(d.streak, 'day')}</div></div>
      </div>
      ${!d.plays ? html`<div class="empty">${icon('chart')}<h3>No plays yet</h3><p>Listening is counted once you’ve heard half a track (or 4 minutes).</p></div>` : html`
      <div class="wgrid">
        <div class="card"><div class="card-h">Last 12 weeks</div><div class="card-b">${weekChart(d.byWeek)}</div></div>
        <div class="card"><div class="card-h">Time of day</div><div class="card-b">${hourChart(d.hours)}</div></div>
        <div class="card"><div class="card-h">Top artists</div>${d.topArtists.map((a, i) => html`<button class="item tap" data-act="artist" data-name="${a.name}"><span class="rank num">${i + 1}</span>${art(a.art, { cls: 'sm round' })}<div class="grow"><div class="title ellipsis">${a.name}</div><div class="sub">${plural(a.plays, 'play')} · ${longDur(a.ms)}</div></div></button>`)}</div>
        <div class="card"><div class="card-h">Top albums</div>${d.topAlbums.map((a, i) => html`<button class="item tap" data-act="album" data-key="${a.key}"><span class="rank num">${i + 1}</span>${art(a.art, { cls: 'sm' })}<div class="grow"><div class="title ellipsis">${a.album || 'Unknown album'}</div><div class="sub ellipsis">${a.artist} · ${plural(a.plays, 'play')}</div></div></button>`)}</div>
        <div class="card span2"><div class="card-h">Top tracks</div><div class="tlist">${d.topTracks.map((t, i) => trackRow(t, { showArt: true, i, sub: `${t.artist || ''} · ${plural(t.plays, 'play')}` }))}</div></div>
      </div>`}
    </div>`);
  },
  topAction(a) { if (a === 'export') exportMonth(); },
  on(act, el) {
    switch (act) {
      case 'tab': state.insightsTab = el.dataset.k; return queueRender();
      case 'period': state.period = el.dataset.k; return queueRender();
      case 'artist': return go('artist', el.dataset.name);
      case 'album': return go('album', el.dataset.key);
      case 'play': return playTracks(top, +el.dataset.i);
      case 'tmenu': return trackMenu(Number(el.dataset.id));
      default: return null;
    }
  },
});

async function exportMonth() {
  const months = db.all(`SELECT DISTINCT strftime('%Y-%m', at/1000, 'unixepoch', 'localtime') m FROM plays ORDER BY m DESC LIMIT 12`).map((r) => r.m);
  const now = new Date();
  const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  if (!months.includes(thisMonth)) months.unshift(thisMonth);
  const m = await menu('Export listening summary', months.map((x) => ({ label: new Date(x + '-01T00:00').toLocaleDateString('en-AU', { month: 'long', year: 'numeric' }), value: x, icon: 'download' })));
  if (!m) return;
  const md = monthMarkdown(m);
  const how = await menu('Send to Obsidian', [
    { label: 'Share…', sub: 'Pick Obsidian (or anything else) from the share sheet', value: 'share', icon: 'share' },
    { label: 'Save to Downloads/Hibiki', sub: `Listening ${m}.md`, value: 'save', icon: 'download' },
  ]);
  if (how === 'share') native.share(md, { subject: `Listening ${m}`, filename: `Listening ${m}.md`, mime: 'text/markdown' });
  if (how === 'save') { const r = native.saveFile(`Listening ${m}.md`, 'text/markdown', md); toast(r.ok ? 'Saved to Downloads/Hibiki' : 'Could not save'); }
}
