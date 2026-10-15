// Rows, cards and menus shared by several screens.
import { html, raw, icon, menu, openSheet, promptDlg, toast } from './dom.js';
import { art, go, state } from './app.js';
import * as repo from '../repo.js';
import * as player from '../play.js';
import { dur, quality, isHiRes, titleOf, bytes, year, ago, albumArtistOf, plural } from '../util.js';

export function qualityBadge(t, { small = false } = {}) {
  const q = quality(t);
  if (!q) return '';
  return html`<span class="q ${isHiRes(t) ? 'hi' : t.lossless ? '' : 'lossy'} ${small ? 'sm' : ''}">${q}</span>`;
}

/**
 * One track row. opts: num (show track number), showArt, showAlbum, i (index in the list for play-from-here),
 * extra (raw html at the end), menuAct (data-act for the ⋯ button).
 */
export function trackRow(t, { num = false, showArt = false, showAlbum = false, i = 0, sub = null, extra = '' } = {}) {
  const subline = sub != null ? sub : [t.artist, showAlbum ? t.album : null].filter(Boolean).join(' · ');
  return html`<div class="trk ${t.missing ? 'missing' : ''}" data-tid="${t.id}" data-act="play" data-i="${i}">
    ${showArt ? art(t.art_key, { cls: 'sm' }) : num ? html`<span class="no num">${t.track_no || '–'}</span>` : ''}
    <div class="main"><div class="t ellipsis">${titleOf(t)}${t.starred ? html`<span class="staron">${icon('starOn')}</span>` : ''}</div>
      <div class="s ellipsis">${subline}</div></div>
    ${extra}
    <span class="d num">${dur(t.duration_ms)}</span>
    <button class="iconbtn sm" data-act="tmenu" data-id="${t.id}" aria-label="More">${icon('more')}</button>
  </div>`;
}

export function albumCard(a, { act = 'album' } = {}) {
  return html`<button class="acard" data-act="${act}" data-key="${a.key}">
    ${art(a.art)}
    <div class="at ellipsis">${a.album}</div>
    <div class="aa ellipsis">${a.artist}${year(a.year) ? html` · ${year(a.year)}` : ''}</div>
  </button>`;
}

/** The ⋯ menu for a track. ctx: {list, index, playlistItem, playlistId} */
export async function trackMenu(id, ctx = {}) {
  const t = repo.track(id);
  if (!t) return;
  const starred = !!t.starred;
  const items = [
    { label: 'Play next', icon: 'queue', value: 'next' },
    { label: 'Add to queue', icon: 'list', value: 'queue' },
    { label: 'Add to playlist…', icon: 'playlist', value: 'pl' },
    { label: starred ? 'Unstar' : 'Star', icon: starred ? 'starOn' : 'star', value: 'star' },
    { label: 'Go to album', icon: 'disc', value: 'album', sub: t.album || t.folder },
    { label: 'Go to artist', icon: 'user', value: 'artist', sub: albumArtistOf(t) },
    { label: 'Edit tags', icon: 'tag', value: 'tags', sub: t.ext === 'flac' ? null : 'FLAC only', disabled: t.ext !== 'flac' },
    { label: 'File info', icon: 'info', value: 'info' },
    ctx.playlistItem ? { label: 'Move up', icon: 'up', value: 'up' } : null,
    ctx.playlistItem ? { label: 'Move down', icon: 'down', value: 'down' } : null,
    ctx.playlistItem ? { label: 'Remove from playlist', icon: 'trash', value: 'plremove', danger: true } : null,
  ];
  const v = await menu(titleOf(t), items);
  switch (v) {
    case 'next': player.playNext([t]); break;
    case 'queue': player.enqueue([t]); break;
    case 'pl': pickPlaylist([t.id]); break;
    case 'star': repo.toggleStar(t.id); toast(starred ? 'Unstarred' : 'Starred'); break;
    case 'album': go('album', t.album_key); break;
    case 'artist': go('artist', albumArtistOf(t)); break;
    case 'tags': (await import('./tagedit.js')).openTagEditor([t.id]); break;
    case 'info': fileInfo(t); break;
    case 'up': repo.movePlaylistItem(ctx.playlistId, ctx.playlistItem, -1); break;
    case 'down': repo.movePlaylistItem(ctx.playlistId, ctx.playlistItem, 1); break;
    case 'plremove': repo.removeFromPlaylist(ctx.playlistItem); toast('Removed'); break;
    default: break;
  }
}

export async function pickPlaylist(trackIds) {
  const lists = repo.playlists().filter((p) => p.kind === 'manual');
  const v = await menu(`Add ${trackIds.length === 1 ? 'track' : trackIds.length + ' tracks'} to…`, [
    { label: 'New playlist…', icon: 'plus', value: '__new' },
    ...lists.map((p) => ({ label: p.name, icon: 'playlist', value: String(p.id), sub: `${p.n} tracks` })),
  ]);
  if (!v) return;
  let id = Number(v);
  if (v === '__new') {
    const name = await promptDlg('New playlist', { placeholder: 'Name', ok: 'Create' });
    if (!name || !name.trim()) return;
    id = repo.createPlaylist(name.trim());
  }
  repo.addToPlaylist(id, trackIds);
  toast(`Added to ${repo.playlist(id)?.name || 'playlist'}`, { action: 'Open', onAction: () => go('playlist', id) });
}

export function fileInfo(t) {
  let tags = {};
  try { tags = JSON.parse(t.tags || '{}'); } catch {}
  const rows = [
    ['File', t.filename], ['Folder', t.folder || '/'], ['Format', quality(t)], ['Channels', t.channels],
    ['Bitrate', t.bitrate ? `${t.bitrate} kbps` : ''], ['Length', dur(t.duration_ms)], ['Size', bytes(t.size)],
    ['Audio MD5', t.audio_md5 || (t.ext === 'flac' ? 'not set by the encoder' : '')],
    ['ReplayGain', [t.rg_track != null ? `track ${t.rg_track} dB` : '', t.rg_album != null ? `album ${t.rg_album} dB` : ''].filter(Boolean).join(', ')],
    ['Cover', t.art_key ? `${t.art_w}×${t.art_h} (${t.art_src})` : 'none'],
    ['Plays', `${t.plays || 0}${t.last_played ? ` · last ${ago(t.last_played)}` : ''}`],
    ['Added', t.added_at ? new Date(t.added_at).toLocaleString('en-AU') : ''],
  ].filter(([, v]) => v !== '' && v != null);
  const tagRows = Object.entries(tags).filter(([k]) => !k.startsWith('_'));
  openSheet({
    title: 'File info',
    body: html`<table class="tbl kvt">${rows.map(([k, v]) => html`<tr><th>${k}</th><td>${v}</td></tr>`)}</table>
      ${tags._error ? html`<p class="banner warn">${icon('alert')} Couldn’t read this file: ${tags._error}</p>` : ''}
      ${tagRows.length ? html`<div class="sectionlabel">All tags</div><table class="tbl kvt mono">${tagRows.map(([k, v]) => html`<tr><th>${k}</th><td>${Array.isArray(v) ? v.join(' ; ') : v}</td></tr>`)}</table>` : ''}`,
  });
}

export function emptyState(ic, title, text, btn = '') {
  return html`<div class="empty">${icon(ic)}<h3>${title}</h3><p>${text}</p>${btn ? raw(String(btn)) : ''}</div>`;
}

/** Album header block used on the album page and the wide detail pane. */
export function albumHeader(a) {
  const t0 = a.tracks[0] || {};
  return html`<div class="ahead">
    ${art(a.art, { size: 'f', cls: 'big' })}
    <div class="ainfo">
      <h2>${a.album}</h2>
      <button class="link" data-act="artist" data-name="${a.artist}">${a.artist}</button>
      <div class="meta">${[year(a.year), `${a.n} track${a.n === 1 ? '' : 's'}`, dur(a.ms), bytes(a.bytes)].filter(Boolean).join(' · ')}</div>
      <div class="row wrap">${qualityBadge({ ...t0, bits: a.bits, sample_rate: a.sample_rate, lossless: a.lossless })}${a.genre ? html`<span class="chip">${a.genre}</span>` : ''}${a.plays ? html`<span class="chip">${plural(a.plays, 'play')}</span>` : ''}</div>
      <div class="row acts">
        <button class="btn primary" data-act="playall">${icon('play')} Play</button>
        <button class="btn" data-act="shuffleall">${icon('shuffle')} Shuffle</button>
        <button class="iconbtn" data-act="amenu" aria-label="Album options">${icon('more')}</button>
      </div>
    </div>
  </div>`;
}

export function albumTracks(a) {
  let disc = null;
  const out = [];
  a.tracks.forEach((t, i) => {
    const d = t.disc_no || 1;
    if (a.discs > 1 && d !== disc) { disc = d; out.push(html`<div class="dischead">Disc ${d}</div>`); }
    const various = a.artist === 'Various artists' || (t.artist && t.artist !== a.artist);
    out.push(trackRow(t, { num: true, i, sub: various ? t.artist : '' , extra: !t.lossless ? html`<span class="q lossy sm">${(t.ext || '').toUpperCase()}</span>` : '' }));
  });
  return html`<div class="card tlist">${out}</div>`;
}

/** Album ⋯ menu. */
/** Album actions. quick = opened by long-pressing an album card, so it also offers play / shuffle / artist. */
export async function albumMenu(a, { quick = false } = {}) {
  const flac = a.tracks.filter((t) => t.ext === 'flac').length;
  const v = await menu(a.album, [
    quick ? { label: 'Play', icon: 'play', value: 'play' } : null,
    quick ? { label: 'Shuffle', icon: 'shuffle', value: 'shuffle' } : null,
    { label: 'Play next', icon: 'queue', value: 'next' },
    { label: 'Add to queue', icon: 'list', value: 'queue' },
    { label: 'Add to playlist…', icon: 'playlist', value: 'pl' },
    { label: 'Edit album tags', icon: 'tag', value: 'tags', sub: flac ? `${flac} FLAC file${flac === 1 ? '' : 's'}` : 'FLAC only', disabled: !flac },
    { label: 'Look up on MusicBrainz', icon: 'sparkle', value: 'mb', sub: 'Fix tags and cover art', disabled: !flac },
    { label: 'Browse folder', icon: 'folder', value: 'folder', sub: a.folders[0] },
    quick ? { label: 'Go to artist', icon: 'user', value: 'artist', sub: a.artist } : null,
  ]);
  switch (v) {
    case 'play': player.playTracks(a.tracks, 0); break;
    case 'shuffle': player.playTracks(a.tracks, 0, { shuffle: true }); break;
    case 'artist': go('artist', a.artist); break;
    case 'next': player.playNext(a.tracks); break;
    case 'queue': player.enqueue(a.tracks); break;
    case 'pl': pickPlaylist(a.tracks.map((t) => t.id)); break;
    case 'tags': (await import('./tagedit.js')).openTagEditor(a.tracks.map((t) => t.id)); break;
    case 'mb': (await import('./mbmatch.js')).openMbMatch(a.key); break;
    case 'folder': state.libTab = 'folders'; state.folder = { root: a.tracks[0].root, path: a.folders[0] }; go('library'); break;
    default: break;
  }
}
