// Library: albums / artists / tracks / folders / genres, the album and artist pages, and search.
import { registerScreen, go, state, art, queueRender } from './app.js';
import { html, raw, icon, $ } from './dom.js';
import * as repo from '../repo.js';
import { db, meta, setMeta } from '../db.js';
import { albumCard, trackRow, trackMenu, emptyState, albumHeader, albumTracks, albumMenu } from './common.js';
import { playTracks, albumShuffle } from '../play.js';
import { debounce, plural, dur } from '../util.js';
import { scanBanner } from './scan.js';

const TABS = [['tracks', 'Tracks'], ['albums', 'Albums'], ['artists', 'Artists'], ['folders', 'Folders'], ['genres', 'Genres']];
const SORTS = [['added', 'Recent'], ['artist', 'Artist'], ['title', 'Title'], ['year', 'Year']];
const isWide = () => window.matchMedia('(min-width: 720px)').matches;

let lastList = []; // tracks currently shown, for play-from-here

const searchBox = (q, ph) => html`<label class="search">${icon('search')}<input id="libq" type="search" placeholder="${ph}" value="${q}" autocomplete="off">${q ? html`<button class="iconbtn sm" data-act="clearq" aria-label="Clear">${icon('close')}</button>` : ''}</label>`;

function albumsView(s) {
  const list = repo.albums({ sort: s.albumSort, q: s.q });
  if (!list.length) return s.q ? html`<p class="muted pad">No albums match “${s.q}”.</p>` : emptyState('disc', 'No albums yet', 'Add a music folder in Settings and scan it.');
  const grid = html`<div class="chips">${SORTS.map(([k, l]) => html`<button class="chip ${s.albumSort === k ? 'on' : ''}" data-act="asort" data-k="${k}">${l}</button>`)}<button class="chip" data-act="albumshuffle">${icon('shuffle')} Albums</button><span class="grow"></span><span class="tiny muted">${plural(list.length, 'album')}</span></div>
    <div class="agrid">${list.map((a) => albumCard(a, { act: 'album' }))}</div>`;
  if (!isWide()) return grid;
  const sel = s.selAlbum && list.find((a) => a.key === s.selAlbum) ? repo.album(s.selAlbum) : null;
  return html`<div class="split"><div>${grid}</div><aside class="pane-detail">${sel ? html`${albumHeader(sel)}${albumTracks(sel)}` : html`<div class="empty">${icon('disc')}<p>Pick an album</p></div>`}</aside></div>`;
}

function artistsView(s) {
  const list = repo.artists({ q: s.q });
  if (!list.length) return html`<p class="muted pad">No artists${s.q ? ` match “${s.q}”` : ''}.</p>`;
  let letter = null;
  return html`<div class="card">${list.map((a) => {
    const L = (a.name.replace(/^(the|a|an)\s+/i, '')[0] || '#').toUpperCase();
    const head = L !== letter ? ((letter = L), html`<div class="dischead">${/[A-Z]/.test(L) ? L : '#'}</div>`) : '';
    return html`${head}<button class="item tap" data-act="artist" data-name="${a.name}">${art(a.art, { cls: 'sm round' })}<div class="grow"><div class="title ellipsis">${a.name}</div><div class="sub">${plural(a.albums, 'album')} · ${plural(a.n, 'track')}</div></div>${icon('fwd')}</button>`;
  })}</div>`;
}

function tracksView(s) {
  lastList = repo.tracks({ q: s.q, sort: s.trackSort, limit: s.trackLimit });
  const total = repo.stats().tracks;
  return html`<div class="chips">${[['title', 'Title'], ['artist', 'Artist'], ['album', 'Album'], ['added', 'Recent'], ['duration', 'Longest']].map(([k, l]) => html`<button class="chip ${s.trackSort === k ? 'on' : ''}" data-act="tsort" data-k="${k}">${l}</button>`)}</div>
    ${lastList.length ? html`<div class="card tlist">${lastList.map((t, i) => trackRow(t, { showArt: true, showAlbum: true, i }))}</div>` : html`<p class="muted pad">No tracks${s.q ? ` match “${s.q}”` : ''}.</p>`}
    ${lastList.length >= s.trackLimit && !s.q && s.trackLimit < total ? html`<button class="btn block" data-act="moretracks">Show more (${(total - s.trackLimit).toLocaleString('en-AU')} left)</button>` : ''}`;
}

function genresView(s) {
  const list = repo.genres().filter((g) => !s.q || g.name.toLowerCase().includes(s.q.toLowerCase()));
  const untagged = db.val("SELECT COUNT(DISTINCT album_key) FROM tracks WHERE missing=0 AND (genre IS NULL OR TRIM(genre)='')") || 0;
  const open = !list.length || meta('genre_help_open', true);
  const help = html`<details class="note-card" ${open ? raw('open') : ''} data-k="genrehelp">
    <summary>${icon('info')}<span class="grow">How genres work${untagged ? html` · <b>${plural(untagged, 'album')} without one</b>` : ''}</span>${icon('down')}</summary>
    <div class="note-b">
      <p>Genres come from the <span class="kbd">GENRE</span> tag inside each file. Hibiki groups albums here by that tag, and smart playlists can filter on it.</p>
      <p><b>To tag an album:</b> open it, tap <b>⋯ › Edit album tags</b>, type a genre in <b>Genre</b> and save. It's written to every track on the album (FLAC only).</p>
      <p><b>Or let MusicBrainz fill it in:</b> <b>⋯ › Look up on MusicBrainz</b> adds genres where MusicBrainz has them. Not every release has one.</p>
      <p><b>Tips:</b> one main genre per album keeps this list tidy. Pick broad names you'll actually browse by (Jazz, Classical, Electronic, Ambient, Rock) and keep the spelling identical, because "Hip-Hop" and "Hip Hop" show up as two genres.</p>
    </div>
  </details>`;
  if (!list.length) return html`${help}<p class="muted pad">No genre tags in the library yet.</p>`;
  return html`${help}<div class="gwrap">${list.map((g) => html`<button class="genre" data-act="genre" data-name="${g.name}"><b>${g.name}</b><span>${plural(g.albums, 'album')}</span></button>`)}</div>`;
}

function foldersView(s) {
  const roots = repo.roots();
  if (!roots.length) return emptyState('folder', 'No folders', 'Add a music folder in Settings.');
  if (!s.folder.root || !roots.find((r) => r.uri === s.folder.root)) s.folder = { root: roots[0].uri, path: '' };
  const { folders, files } = repo.folder(s.folder.root, s.folder.path);
  lastList = files;
  const crumbs = s.folder.path ? s.folder.path.split('/') : [];
  const rootName = roots.find((r) => r.uri === s.folder.root)?.name || 'Music';
  return html`
    ${roots.length > 1 ? html`<div class="chips">${roots.map((r) => html`<button class="chip ${r.uri === s.folder.root ? 'on' : ''}" data-act="froot" data-uri="${r.uri}">${r.name}</button>`)}</div>` : ''}
    <div class="crumbs"><button data-act="fpath" data-p="">${rootName}</button>${crumbs.map((c, i) => html`<span>/</span><button data-act="fpath" data-p="${crumbs.slice(0, i + 1).join('/')}">${c}</button>`)}</div>
    ${folders.length ? html`<div class="card">${folders.map((f) => html`<button class="item tap" data-act="fpath" data-p="${f.path}">${f.art ? art(f.art, { cls: 'sm' }) : html`<span class="fic">${icon('folder')}</span>`}<div class="grow"><div class="title ellipsis">${f.name}</div><div class="sub">${plural(f.n, 'track')}</div></div>${icon('fwd')}</button>`)}</div>` : ''}
    ${files.length ? html`<div class="row" style="margin:6px 0 8px"><button class="btn sm" data-act="playfolder">${icon('play')} Play folder</button></div><div class="card tlist">${files.map((t, i) => trackRow(t, { i, sub: t.filename }))}</div>` : ''}`;
}

registerScreen('library', {
  top: (s) => ({ title: 'Library', noSearch: false }),
  render(el, s) {
    const ph = { albums: 'Search albums', artists: 'Search artists', tracks: 'Search tracks', genres: 'Filter genres', folders: '' }[s.libTab];
    el.innerHTML = String(html`<div class="page">
      ${scanBanner()}
      <div class="tabs">${TABS.map(([k, l]) => html`<button class="${s.libTab === k ? 'on' : ''}" data-act="tab" data-k="${k}">${l}</button>`)}</div>
      ${s.libTab !== 'folders' ? searchBox(s.q, ph) : ''}
      ${{ albums: albumsView, artists: artistsView, tracks: tracksView, genres: genresView, folders: foldersView }[s.libTab](s)}
    </div>`);
  },
  onInput(t) {
    if (t.id === 'libq') { state.q = t.value; state.trackLimit = 200; rerenderList(); }
  },
  on(act, el) {
    switch (act) {
      case 'tab': state.libTab = el.dataset.k; state.q = ''; state.trackLimit = 200; return queueRender();
      case 'clearq': state.q = ''; return queueRender();
      case 'asort': state.albumSort = el.dataset.k; return queueRender();
      case 'tsort': state.trackSort = el.dataset.k; return queueRender();
      case 'moretracks': state.trackLimit += 400; return queueRender();
      case 'album':
        if (isWide() && state.libTab === 'albums') { state.selAlbum = el.dataset.key; return queueRender(); }
        return go('album', el.dataset.key);
      case 'artist': return go('artist', el.dataset.name);
      case 'genre': state.libTab = 'albums'; state.q = ''; return go('search', 'genre:' + el.dataset.name);
      case 'froot': state.folder = { root: el.dataset.uri, path: '' }; return queueRender();
      case 'fpath': state.folder.path = el.dataset.p; return queueRender();
      case 'playfolder': return playTracks(lastList, 0);
      case 'albumshuffle': return albumShuffle(db.all('SELECT * FROM tracks WHERE missing=0'));
      case 'play': return playFromList(el);
      case 'tmenu': return trackMenu(Number(el.dataset.id));
      // wide album pane
      case 'playall': case 'shuffleall': case 'amenu': {
        const a = repo.album(state.selAlbum);
        if (!a) return null;
        if (act === 'amenu') return albumMenu(a);
        return playTracks(a.tracks, 0, { shuffle: act === 'shuffleall' });
      }
      default: return null;
    }
  },
});

function playFromList(el) {
  // In the wide album pane the list is the selected album; otherwise whatever list is on screen.
  if (el.closest('.pane-detail') && state.selAlbum) return playTracks(repo.album(state.selAlbum).tracks, +el.dataset.i);
  return playTracks(lastList, +el.dataset.i);
}

// Re-render only the list part while typing so the input keeps focus.
const rerenderList = debounce(() => {
  const page = $('#main .page');
  if (!page) return;
  const input = $('#libq');
  const pos = input?.selectionStart;
  queueRender();
  requestAnimationFrame(() => { const i = $('#libq'); if (i) { i.focus(); try { i.setSelectionRange(pos, pos); } catch {} } });
}, 180);

// ---------------------------------------------------------------- album page

let curAlbum = null;
registerScreen('album', {
  top: () => ({ back: true, title: '' , actions: [{ id: 'amenu', icon: 'more', label: 'Album options' }], noSearch: true }),
  render(el, s) {
    curAlbum = repo.album(s.params.id);
    if (!curAlbum) { el.innerHTML = String(html`<div class="page">${emptyState('disc', 'Album not found', 'It may have been renamed by a tag edit or rescan.')}</div>`); return; }
    const other = repo.albums({ artist: curAlbum.artist, sort: 'year' }).filter((a) => a.key !== curAlbum.key);
    el.innerHTML = String(html`<div class="page albumpage">${albumHeader(curAlbum)}${albumTracks(curAlbum)}
      <p class="tiny muted pad">${curAlbum.folders.map((f) => html`<span class="kbd">${f || '/'}</span> `)}</p>
      ${other.length && curAlbum.artist !== 'Various artists' ? html`<div class="sectionlabel"><span>More by ${curAlbum.artist}</span></div><div class="shelf">${other.map((a) => albumCard(a))}</div>` : ''}
    </div>`);
  },
  topAction(a) { if (a === 'amenu' && curAlbum) albumMenu(curAlbum); },
  on(act, el) {
    if (!curAlbum) return null;
    switch (act) {
      case 'play': return playTracks(curAlbum.tracks, +el.dataset.i);
      case 'playall': return playTracks(curAlbum.tracks, 0);
      case 'shuffleall': return playTracks(curAlbum.tracks, 0, { shuffle: true });
      case 'amenu': return albumMenu(curAlbum);
      case 'tmenu': return trackMenu(Number(el.dataset.id));
      case 'artist': return go('artist', el.dataset.name);
      case 'album': return go('album', el.dataset.key);
      default: return null;
    }
  },
});

// ---------------------------------------------------------------- artist page

let curArtist = null;
registerScreen('artist', {
  top: (s) => ({ back: true, title: s.params.id || '', noSearch: true }),
  render(el, s) {
    curArtist = repo.artist(s.params.id);
    const a = curArtist;
    const ms = a.albums.reduce((x, b) => x + (b.ms || 0), 0);
    el.innerHTML = String(html`<div class="page">
      <div class="arthead">${art(a.albums[0]?.art, { size: 'f', cls: 'round big' })}<div><h2>${a.name}</h2>
        <div class="meta">${plural(a.albums.length, 'album')} · ${dur(ms)}${a.plays ? ` · ${plural(a.plays, 'play')}` : ''}</div>
        <div class="row acts"><button class="btn primary" data-act="playall">${icon('play')} Play</button><button class="btn" data-act="shuffleall">${icon('shuffle')} Shuffle</button></div></div></div>
      ${a.top.length ? html`<div class="sectionlabel"><span>Most played</span></div><div class="card tlist">${a.top.map((t, i) => trackRow(t, { showArt: true, i, sub: `${t.album || ''} · ${t.plays} plays`, }))}</div>` : ''}
      <div class="sectionlabel"><span>Albums</span></div>
      <div class="agrid">${a.albums.map((b) => albumCard(b))}</div>
      ${a.appearsOn.length ? html`<div class="sectionlabel"><span>Appears on</span></div><div class="card tlist">${a.appearsOn.map((t, i) => trackRow(t, { showArt: true, i: 1000 + i, showAlbum: true }))}</div>` : ''}
    </div>`);
  },
  on(act, el) {
    const a = curArtist;
    switch (act) {
      case 'album': return go('album', el.dataset.key);
      case 'playall': return playTracks(repo.artistTracks(a.name), 0);
      case 'shuffleall': return playTracks(repo.artistTracks(a.name), 0, { shuffle: true });
      case 'play': {
        const i = +el.dataset.i;
        return i >= 1000 ? playTracks(a.appearsOn, i - 1000) : playTracks(a.top, i);
      }
      case 'tmenu': return trackMenu(Number(el.dataset.id));
      default: return null;
    }
  },
});

// ---------------------------------------------------------------- search

let found = { artists: [], albums: [], tracks: [] };
registerScreen('search', {
  top: () => ({ back: true, center: html`<label class="search top grow">${icon('search')}<input id="sq" type="search" placeholder="Artists, albums, tracks" value="${state.q}" autocomplete="off"></label>`, noSearch: true }),
  render(el, s) {
    const genre = (s.params.id || '').startsWith('genre:') ? s.params.id.slice(6) : null;
    if (genre) {
      const list = repo.albums({ genre, sort: 'artist' });
      el.innerHTML = String(html`<div class="page"><div class="sectionlabel"><span>${genre}</span><span>${plural(list.length, 'album')}</span></div><div class="agrid">${list.map((a) => albumCard(a))}</div></div>`);
      return;
    }
    found = repo.search(s.q);
    el.innerHTML = String(html`<div class="page">
      ${!s.q ? html`<p class="muted pad">Search your whole library.</p>` : ''}
      ${found.artists.length ? html`<div class="sectionlabel"><span>Artists</span></div><div class="card">${found.artists.map((a) => html`<button class="item tap" data-act="artist" data-name="${a.name}">${art(a.art, { cls: 'sm round' })}<div class="grow"><div class="title">${a.name}</div><div class="sub">${plural(a.albums, 'album')}</div></div></button>`)}</div>` : ''}
      ${found.albums.length ? html`<div class="sectionlabel"><span>Albums</span></div><div class="shelf">${found.albums.map((a) => albumCard(a))}</div>` : ''}
      ${found.tracks.length ? html`<div class="sectionlabel"><span>Tracks</span></div><div class="card tlist">${found.tracks.map((t, i) => trackRow(t, { showArt: true, showAlbum: true, i }))}</div>` : ''}
      ${s.q && !found.artists.length && !found.albums.length && !found.tracks.length ? html`<p class="muted pad">Nothing found for “${s.q}”.</p>` : ''}
    </div>`);
    setTimeout(() => { const i = $('#sq'); if (i && document.activeElement !== i && !s.q) i.focus(); }, 50);
  },
  on(act, el) {
    switch (act) {
      case 'artist': return go('artist', el.dataset.name);
      case 'album': return go('album', el.dataset.key);
      case 'play': return playTracks(found.tracks, +el.dataset.i);
      case 'tmenu': return trackMenu(Number(el.dataset.id));
      default: return null;
    }
  },
});

// The search box lives in the top bar, outside #main, so wire it up globally.
document.addEventListener('input', debounce((e) => {
  if (e.target.id !== 'sq') return;
  state.q = e.target.value;
  const pos = e.target.selectionStart;
  queueRender();
  requestAnimationFrame(() => { const i = $('#sq'); if (i) { i.focus(); try { i.setSelectionRange(pos, pos); } catch {} } });
}, 200));


// Remember whether the genres note is folded away.
// (Opening with the attribute also fires 'toggle', so only write when it actually changed, or the save → re-render loops.)
document.addEventListener('toggle', (e) => { if (e.target?.dataset?.k === 'genrehelp' && meta('genre_help_open', true) !== e.target.open) setMeta('genre_help_open', e.target.open); }, true);
