// Home: what's playing, new and recent albums, quick mixes, library at a glance.
import { registerScreen, go, state, art, queueRender } from './app.js';
import { html, icon, openSheet, toast } from './dom.js';
import * as repo from '../repo.js';
import { db, meta, setMeta } from '../db.js';
import * as native from '../native.js';
import { albumCard, emptyState, trackRow, trackMenu } from './common.js';
import { playTracks } from '../play.js';
import { PRESETS, compile } from '../engine/smart.js';
import { scanBanner, startScan } from './scan.js';
import { healthSnapshot } from './health.js';
import { longDur, plural, titleOf, dur } from '../util.js';
import { streak } from '../engine/stats.js';
import { buildMix, hash } from '../engine/daily.js';
import { addRoot } from './settings.js';

const partOfDay = () => { const h = new Date().getHours(); return h < 5 ? 'Late night' : h < 12 ? 'Morning' : h < 18 ? 'Afternoon' : 'Evening'; };
const localDay = () => { const d = new Date(); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };

/**
 * Mix of the day: a playlist of ~20 tracks from across your library (favourites, rediscoveries and things you
 * haven't played), the same all day. "Another" makes a new one for today; "Save" keeps it in Playlists.
 */
function mixOfDay() {
  const day = localDay(), sk = meta('today_skip', null), n = sk && sk.day === day ? sk.n : 0;
  const saved = meta('daily_mix', null);
  let ids = saved && saved.day === day && saved.n === n ? saved.ids : null;
  if (!ids) {
    const rows = db.all(`SELECT t.id, t.artist, t.album_key, t.duration_ms, t.genre, t.added_at,
      (SELECT COUNT(*) FROM plays p WHERE p.track_id=t.id) plays, (SELECT MAX(at) FROM plays p WHERE p.track_id=t.id) last,
      (SELECT 1 FROM stars s WHERE s.track_id=t.id) starred FROM tracks t WHERE t.missing=0`);
    if (!rows.length) return null;
    const m = buildMix(rows, { seed: hash(day + ':' + n) });
    ids = m.ids;
    setMeta('daily_mix', { day, n, ids, genres: m.genres });
  }
  const byId = new Map(repo.tracksByIds(ids).map((t) => [t.id, t]));
  const tracks = ids.map((id) => byId.get(id)).filter((t) => t && !t.missing);
  if (!tracks.length) return null;
  const genres = (meta('daily_mix', {}) || {}).genres || [];
  const arts = [...new Set(tracks.map((t) => t.art_key).filter(Boolean))].slice(0, 4);
  const artists = new Set(tracks.map((t) => t.artist).filter(Boolean));
  const ms = tracks.reduce((a, t) => a + (t.duration_ms || 0), 0);
  const name = genres.length ? genres.slice(0, 2).join(' · ') : 'Across your library';
  return { tracks, arts, artists, ms, name };
}

function mosaic(arts, cls = '') {
  const a = arts.length >= 4 ? arts.slice(0, 4) : arts.slice(0, 1);
  return html`<span class="mosaic ${cls} n${a.length}">${a.map((k) => art(k))}</span>`;
}

function todayPane(ps) {
  const m = mixOfDay();
  const dayMs = db.val('SELECT COALESCE(SUM(ms),0) FROM plays WHERE at >= ?', [new Date().setHours(0, 0, 0, 0)]);
  const days = streak();
  const date = new Date().toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' }).toUpperCase();
  return html`<section class="today hello" aria-label="Mix of the day">
    <div class="today-l">
      <div class="lbl">${date} · ${partOfDay().toUpperCase()}</div>
      <div class="today-k">Mix of the day</div>
      ${m ? html`<button class="today-a clamp2" data-act="mixopen">${m.name}</button>
        <div class="today-s ellipsis">${m.tracks.length} tracks · ${longDur(m.ms)} · ${plural(m.artists.size, 'artist')}</div>` : html`<div class="today-s">Add some music and a fresh mix is made for you each day.</div>`}
      <div class="today-row">
        ${m ? html`<button class="btn sm primary" data-act="mixplay">${icon('play')} Play</button><button class="btn sm" data-act="mixopen" aria-label="See the tracks">${icon('list')}</button><button class="btn sm" data-act="todayskip" aria-label="Make another mix">${icon('refresh')}</button>` : ''}
      </div>
      <div class="today-stats mono">${dayMs ? `TODAY ${longDur(dayMs).toUpperCase()}` : 'NOTHING PLAYED YET TODAY'}${days ? ` · ${days}-DAY STREAK` : ''}</div>
    </div>
    ${m ? html`<button class="today-rec ${ps.playing ? 'spin' : ''}" data-act="mixplay" aria-label="Play the mix of the day">
      <span class="vinyl" aria-hidden="true"><span class="vlabel">${m.arts[0] ? art(m.arts[0]) : ''}</span></span>
      <span class="sleeve">${mosaic(m.arts)}</span>
    </button>` : ''}
  </section>`;
}

function openMix() {
  const m = mixOfDay();
  if (!m) return;
  const date = new Date().toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
  openSheet({
    title: 'Mix of the day', className: 'mixsheet',
    body: html`<div class="mix-h">${mosaic(m.arts, 'lg')}<div class="grow"><div class="mix-n">${m.name}</div>
        <div class="small muted">${m.tracks.length} tracks · ${longDur(m.ms)} · ${plural(m.artists.size, 'artist')}</div>
        <div class="tiny muted" style="margin-top:6px">Favourites, tracks you haven’t heard in a while and ones you haven’t played yet. A new mix every day.</div></div></div>
      <div class="list">${m.tracks.map((t, i) => trackRow(t, { showArt: true, showAlbum: true, i }))}</div>`,
    footer: html`<button class="btn grow" data-act="save">${icon('plus')} Save</button><button class="btn primary grow" data-act="playall">${icon('play')} Play</button>`,
    actions: {
      play: (b, e, api) => { if (e.target.closest('[data-act=tmenu]')) return; api.close(); playTracks(m.tracks, Number(b.dataset.i) || 0); },
      tmenu: (b) => trackMenu(Number(b.dataset.id)),
      playall: (b, e, api) => { api.close(); playTracks(m.tracks, 0); },
      save: (b, e, api) => {
        const id = repo.createPlaylist(`Mix · ${date}`);
        repo.addToPlaylist(id, m.tracks.map((t) => t.id));
        api.close();
        toast(`Saved “Mix · ${date}” to Playlists`, { action: 'Open', onAction: () => go('playlist', id) });
      },
    },
  });
}

/** What's playing and the next few tracks, straight from the player. */
function queuePane(ps) {
  if (!ps.ids || !ps.ids.length || ps.index < 0) return '';
  const order = ps.order && ps.order.length ? ps.order : ps.ids.map((_, i) => i).slice(ps.index);
  const show = order.slice(0, 6);
  const rows = repo.tracksByIds(show.map((qi) => ps.ids[qi]));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const left = Math.max(0, order.length - show.length);
  return html`<div class="sectionlabel"><span>Queue · ${ps.ids.length}</span><button class="more" data-act="openqueue">Open queue</button></div>
    <div class="card hqueue">${show.map((qi, n) => {
      const t = byId.get(ps.ids[qi]);
      if (!t) return '';
      return n === 0
        ? html`<div class="hq now" data-act="nowplaying">${art(t.art_key, { cls: 'sm' })}<div class="grow"><div class="lbl">${ps.playing ? 'Now playing' : 'Paused'}</div><div class="t ellipsis">${titleOf(t)}</div><div class="s ellipsis">${t.artist || ''}</div></div>
            <button class="iconbtn" data-act="toggle" aria-label="Play or pause">${icon(ps.playing ? 'pause' : 'play')}</button></div>`
        : html`<button class="hq" data-act="jump" data-qi="${qi}"><span class="no num">${String(n).padStart(2, '0')}</span><div class="grow"><div class="t ellipsis">${titleOf(t)}</div><div class="s ellipsis">${t.artist || ''}</div></div><span class="d num">${dur(t.duration_ms)}</span></button>`;
    })}${left ? html`<button class="hq more-row" data-act="openqueue"><span class="mono">+ ${left} more</span></button>` : ''}</div>`;
}

registerScreen('home', {
  top: () => ({ center: html`<div class="brand grow">Hibiki <small>響き</small></div>` }),
  render(el) {
    if (!repo.hasLibrary()) {
      el.innerHTML = String(html`<div class="page">${(native.isWeb ? emptyState('folder', 'Add your music', 'Pick FLAC or MP3 files from the Files app — a whole album at a time works well. Hibiki keeps a copy on this device so it plays offline; nothing is uploaded.', html`<button class="btn primary" data-act="addroot">${icon('plus')} Add music</button>`) : emptyState('folder', 'Add your music folder', 'Pick the folder that holds your FLACs. Hibiki reads it in place — nothing is copied or uploaded.', html`<button class="btn primary" data-act="addroot">${icon('plus')} Choose folder</button>`))}</div>`);
      return;
    }
    const s = repo.stats();
    const recent = repo.recentlyAdded(14);
    const played = repo.recentlyPlayedAlbums(14);
    const ps = native.playerState();
    const cur = ps.id ? repo.track(ps.id) : null;
    const health = healthSnapshot();
    const days = streak();
    const weekMs = db.val('SELECT COALESCE(SUM(ms),0) FROM plays WHERE at >= ?', [Date.now() - 7 * 86400000]);
    el.innerHTML = String(html`<div class="page">
      ${scanBanner()}
      ${s.tracks ? todayPane(ps) : ''}
      ${!s.tracks ? emptyState('wave', 'Nothing here yet', 'Scan your folder to build the library.', html`<button class="btn primary" data-act="scan">${icon('refresh')} Scan now</button>`) : ''}
      ${queuePane(ps)}
      ${s.tracks ? html`
      <div class="mixes">
        <button class="mix" data-act="shuffleall">${icon('shuffle')}<span>Shuffle all</span></button>
        ${PRESETS.slice(0, 5).map((p, i) => html`<button class="mix" data-act="preset" data-i="${i}">${icon(['sparkle', 'star', 'note', 'refresh', 'wave'][i])}<span>${p.name}</span></button>`)}
      </div>
      ${played.length ? html`<div class="sectionlabel"><span>Jump back in</span></div><div class="shelf">${played.map((a) => albumCard(a))}</div>` : ''}
      <div class="sectionlabel"><span>Recently added</span><button class="more" data-act="lib">All albums</button></div>
      <div class="shelf">${recent.map((a) => albumCard(a))}</div>
      <div class="dash">
        <div class="dcard">
          <h2>Library</h2>
          <div class="kv"><div><span class="lbl">Tracks</span><b>${s.tracks.toLocaleString('en-AU')}</b></div><div><span class="lbl">Albums</span><b>${s.albums.toLocaleString('en-AU')}</b></div><div><span class="lbl">Artists</span><b>${s.artists.toLocaleString('en-AU')}</b></div></div>
          <div class="kv"><div><span class="lbl">Length</span><b>${longDur(s.ms)}</b></div><div><span class="lbl">Lossless</span><b>${Math.round((s.lossless / s.tracks) * 100)}%</b></div><div><span class="lbl">Hi-res</span><b>${plural(s.hires, 'track')}</b></div></div>
        </div>
        <button class="dcard tap" data-act="health">
          <h2>Library health <span class="more">Open</span></h2>
          <div class="row"><span class="big">${health.score}</span><span class="muted">/ 100</span></div>
          <div class="small ink2">${health.active ? `${plural(health.active, 'issue')} to look at${health.high ? ` · ${health.high} important` : ''}` : 'All clear'}</div>
        </button>
        <button class="dcard tap" data-act="insights">
          <h2>Listening <span class="more">Insights</span></h2>
          <div class="kv"><div><span class="lbl">This week</span><b>${longDur(weekMs)}</b></div><div><span class="lbl">Streak</span><b>${plural(days, 'day')}</b></div><div><span class="lbl">All plays</span><b>${s.plays.toLocaleString('en-AU')}</b></div></div>
        </button>
      </div>` : ''}
    </div>`);
  },
  on(act, el) {
    switch (act) {
      case 'album': return go('album', el.dataset.key);
      case 'lib': state.libTab = 'albums'; return go('library');
      case 'health': return go('health');
      case 'insights': return go('insights');
      case 'nowplaying': return import('./player.js').then((m) => m.openNowPlaying());
      case 'openqueue': return import('./player.js').then((m) => m.openQueue());
      case 'jump': return native.jump(+el.dataset.qi);
      case 'mixplay': { const m = mixOfDay(); return m && playTracks(m.tracks, 0); }
      case 'mixopen': return openMix();
      case 'todayskip': { const day = localDay(), sk = meta('today_skip', null); setMeta('today_skip', { day, n: sk && sk.day === day ? sk.n + 1 : 1 }); return queueRender(); }
      case 'toggle': return native.toggle();
      case 'scan': return startScan(false);
      case 'addroot': return addRoot(); // must stay synchronous: browsers only open a file picker inside the tap
      case 'shuffleall': return playTracks(db.all('SELECT * FROM tracks WHERE missing=0 ORDER BY RANDOM() LIMIT 500'), 0, { shuffle: true });
      case 'preset': {
        const p = PRESETS[+el.dataset.i];
        const { sql, params } = compile(p.rules);
        const list = db.all(sql, params);
        return playTracks(list, 0);
      }
      default: return null;
    }
  },
});
