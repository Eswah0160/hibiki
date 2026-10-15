// Library queries. The tracks table is filled by the native scanner; everything here reads it.
import { db, meta, setMeta } from './db.js';
import { sortKey } from './util.js';

const LIVE = 'missing=0';
const ARTIST_EXPR = `COALESCE(NULLIF(TRIM(albumartist),''), NULLIF(TRIM(artist),''), 'Unknown artist')`;

// ---------------------------------------------------------------- roots & status

export const roots = () => db.all('SELECT * FROM roots ORDER BY added_at');
export const hasLibrary = () => !!db.val('SELECT 1 FROM roots LIMIT 1');

export function stats() {
  const r = db.get(`SELECT COUNT(*) tracks, COUNT(DISTINCT album_key) albums, COUNT(DISTINCT ${ARTIST_EXPR}) artists,
    COALESCE(SUM(duration_ms),0) ms, COALESCE(SUM(size),0) bytes, COALESCE(SUM(lossless),0) lossless,
    COALESCE(SUM(CASE WHEN lossless=1 AND (bits>16 OR sample_rate>48000) THEN 1 ELSE 0 END),0) hires
    FROM tracks WHERE ${LIVE}`);
  r.missing = db.val('SELECT COUNT(*) FROM tracks WHERE missing=1');
  r.plays = db.val('SELECT COUNT(*) FROM plays');
  return r;
}

// ---------------------------------------------------------------- albums

const ALBUM_COLS = `album_key AS key,
  COALESCE(MAX(NULLIF(TRIM(album),'')), MAX(folder), 'Unknown album') AS album,
  CASE WHEN MAX(NULLIF(TRIM(albumartist),'')) IS NOT NULL THEN MAX(NULLIF(TRIM(albumartist),''))
       WHEN COUNT(DISTINCT artist) > 1 THEN 'Various artists'
       ELSE COALESCE(MAX(artist), 'Unknown artist') END AS artist,
  MIN(year) AS year, COUNT(*) AS n, SUM(duration_ms) AS ms, SUM(size) AS bytes, MAX(added_at) AS added,
  MAX(art_key) AS art, MAX(sample_rate) AS sample_rate, MAX(bits) AS bits, MIN(lossless) AS lossless,
  MAX(ext) AS ext, MAX(genre) AS genre, MAX(NULLIF(TRIM(album),'')) IS NULL AS untagged`;

/** Untagged albums are named after their folder; show just the last part of the path. */
const fixName = (r) => { if (r && r.untagged && r.album) r.album = r.album.split('/').pop() || r.album; return r; };

export function albums({ sort = 'added', q = '', limit = 5000, artist = null, genre = null } = {}) {
  const where = [LIVE];
  const params = [];
  if (q) { where.push(`(album LIKE ? OR artist LIKE ? OR albumartist LIKE ?)`); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  if (artist) { where.push(`${ARTIST_EXPR} = ?`); params.push(artist); }
  if (genre) { where.push(`genre LIKE ?`); params.push(`%${genre}%`); }
  const rows = db.all(`SELECT ${ALBUM_COLS} FROM tracks WHERE ${where.join(' AND ')} GROUP BY album_key LIMIT ${limit | 0}`, params).map(fixName);
  return sortAlbums(rows, sort);
}

export function sortAlbums(rows, sort) {
  const by = {
    added: (a, b) => (b.added || 0) - (a.added || 0),
    artist: (a, b) => sortKey(a.artist).localeCompare(sortKey(b.artist)) || String(a.year || '').localeCompare(String(b.year || '')),
    title: (a, b) => sortKey(a.album).localeCompare(sortKey(b.album)),
    year: (a, b) => String(b.year || '').localeCompare(String(a.year || '')) || sortKey(a.artist).localeCompare(sortKey(b.artist)),
    played: (a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0),
  }[sort] || (() => 0);
  return rows.sort(by);
}

export function album(key) {
  const head = fixName(db.get(`SELECT ${ALBUM_COLS} FROM tracks WHERE ${LIVE} AND album_key=? GROUP BY album_key`, [key]));
  if (!head) return null;
  head.tracks = db.all(`SELECT t.*, (SELECT COUNT(*) FROM plays p WHERE p.track_id=t.id) AS plays, (s.track_id IS NOT NULL) AS starred
    FROM tracks t LEFT JOIN stars s ON s.track_id=t.id WHERE t.${LIVE} AND t.album_key=?
    ORDER BY COALESCE(t.disc_no,1), COALESCE(t.track_no, 9999), t.filename`, [key]);
  head.discs = new Set(head.tracks.map((t) => t.disc_no || 1)).size;
  head.plays = head.tracks.reduce((s, t) => s + t.plays, 0);
  head.folders = [...new Set(head.tracks.map((t) => t.folder))];
  return head;
}

export function recentlyAdded(n = 12) { return albums({ sort: 'added', limit: 100000 }).slice(0, n); }

export function recentlyPlayedAlbums(n = 12) {
  return db.all(`SELECT t.album_key AS key, MAX(p.at) AS last FROM plays p JOIN tracks t ON t.id=p.track_id
    WHERE t.${LIVE} GROUP BY t.album_key ORDER BY last DESC LIMIT ?`, [n])
    .map((r) => ({ ...fixName(db.get(`SELECT ${ALBUM_COLS} FROM tracks WHERE album_key=? AND ${LIVE} GROUP BY album_key`, [r.key])), lastPlayed: r.last }))
    .filter((a) => a.key);
}

// ---------------------------------------------------------------- artists

export function artists({ q = '' } = {}) {
  const params = [];
  let where = LIVE;
  if (q) { where += ` AND ${ARTIST_EXPR} LIKE ?`; params.push(`%${q}%`); }
  const rows = db.all(`SELECT ${ARTIST_EXPR} AS name, COUNT(DISTINCT album_key) AS albums, COUNT(*) AS n, MAX(art_key) AS art, SUM(duration_ms) AS ms
    FROM tracks WHERE ${where} GROUP BY ${ARTIST_EXPR}`, params);
  return rows.sort((a, b) => sortKey(a.name).localeCompare(sortKey(b.name)));
}

export function artist(name) {
  const albumsOf = albums({ artist: name, sort: 'year' });
  const appearsOn = db.all(`SELECT t.* FROM tracks t WHERE t.${LIVE} AND t.artist LIKE ? AND ${ARTIST_EXPR} != ?
    ORDER BY t.album, t.track_no LIMIT 200`, [`%${name}%`, name]);
  const plays = db.val(`SELECT COUNT(*) FROM plays p JOIN tracks t ON t.id=p.track_id WHERE ${ARTIST_EXPR} = ?`, [name]);
  const top = db.all(`SELECT t.*, COUNT(p.id) AS plays FROM tracks t JOIN plays p ON p.track_id=t.id
    WHERE t.${LIVE} AND (${ARTIST_EXPR} = ? OR t.artist = ?) GROUP BY t.id ORDER BY plays DESC LIMIT 5`, [name, name]);
  return { name, albums: albumsOf, appearsOn, plays, top };
}

export function artistTracks(name) {
  return db.all(`SELECT * FROM tracks WHERE ${LIVE} AND ${ARTIST_EXPR} = ? ORDER BY year, album_key, COALESCE(disc_no,1), track_no`, [name]);
}

// ---------------------------------------------------------------- genres

export function genres() {
  const rows = db.all(`SELECT genre, COUNT(*) n, COUNT(DISTINCT album_key) albums FROM tracks WHERE ${LIVE} AND genre IS NOT NULL AND genre != '' GROUP BY genre`);
  const map = new Map();
  for (const r of rows) for (const g of String(r.genre).split(/\s*[;/]\s*/)) {
    if (!g) continue;
    const k = g.trim();
    const e = map.get(k.toLowerCase()) || { name: k, n: 0, albums: 0 };
    e.n += r.n; e.albums += r.albums;
    map.set(k.toLowerCase(), e);
  }
  return [...map.values()].sort((a, b) => b.n - a.n);
}

// ---------------------------------------------------------------- tracks

const TRACK_SORT = {
  title: 'LOWER(COALESCE(title, filename))',
  artist: `LOWER(${ARTIST_EXPR}), album_key, COALESCE(disc_no,1), track_no`,
  added: 'added_at DESC',
  album: 'LOWER(album), COALESCE(disc_no,1), track_no',
  duration: 'duration_ms DESC',
};

export function tracks({ q = '', sort = 'title', limit = 200, offset = 0 } = {}) {
  const params = [];
  let where = `t.${LIVE}`;
  if (q) { where += ` AND (t.title LIKE ? OR t.artist LIKE ? OR t.album LIKE ? OR t.filename LIKE ?)`; params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`); }
  return db.all(`SELECT t.*, (s.track_id IS NOT NULL) AS starred FROM tracks t LEFT JOIN stars s ON s.track_id=t.id
    WHERE ${where} ORDER BY ${(TRACK_SORT[sort] || TRACK_SORT.title)} LIMIT ? OFFSET ?`, [...params, limit, offset]);
}

export const track = (id) => db.get(`SELECT t.*, (s.track_id IS NOT NULL) AS starred,
  (SELECT COUNT(*) FROM plays p WHERE p.track_id=t.id) AS plays, (SELECT MAX(at) FROM plays p WHERE p.track_id=t.id) AS last_played
  FROM tracks t LEFT JOIN stars s ON s.track_id=t.id WHERE t.id=?`, [id]);

export function tracksByIds(ids) {
  if (!ids.length) return [];
  const out = new Map();
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    for (const r of db.all(`SELECT t.*, (s.track_id IS NOT NULL) AS starred FROM tracks t LEFT JOIN stars s ON s.track_id=t.id WHERE t.id IN (${chunk.map(() => '?').join(',')})`, chunk)) out.set(r.id, r);
  }
  return ids.map((id) => out.get(id)).filter(Boolean);
}

export function search(q, n = 8) {
  if (!q || q.trim().length < 1) return { artists: [], albums: [], tracks: [] };
  return { artists: artists({ q }).slice(0, n), albums: albums({ q, sort: 'title' }).slice(0, n), tracks: tracks({ q, limit: n * 3 }) };
}

// ---------------------------------------------------------------- folders

/** Browse by folder: subfolders + files directly inside `path` of `root`. */
export function folder(root, path = '') {
  const prefix = path ? path + '/' : '';
  const rows = db.all(`SELECT folder, COUNT(*) n, MAX(art_key) art FROM tracks WHERE root=? AND ${LIVE} AND (folder=? OR folder LIKE ?) GROUP BY folder`, [root, path, prefix + '%']);
  const subs = new Map();
  for (const r of rows) {
    if (r.folder === path) continue;
    const rest = r.folder.slice(prefix.length);
    const name = rest.split('/')[0];
    const e = subs.get(name) || { name, path: prefix + name, n: 0, art: null };
    e.n += r.n; e.art = e.art || r.art;
    subs.set(name, e);
  }
  const files = db.all(`SELECT * FROM tracks WHERE root=? AND folder=? AND ${LIVE} ORDER BY filename`, [root, path]);
  return { folders: [...subs.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })), files };
}

// ---------------------------------------------------------------- stars

export const isStarred = (id) => !!db.val('SELECT 1 FROM stars WHERE track_id=?', [id]);
export function toggleStar(id) {
  if (isStarred(id)) { db.run('DELETE FROM stars WHERE track_id=?', [id]); return false; }
  db.run('INSERT OR REPLACE INTO stars(track_id, at) VALUES (?,?)', [id, Date.now()]);
  return true;
}

// ---------------------------------------------------------------- playlists

export const playlists = () => db.all(`SELECT p.*, (SELECT COUNT(*) FROM playlist_items i WHERE i.playlist_id=p.id) AS n FROM playlists p ORDER BY p.kind DESC, LOWER(p.name)`);
export const playlist = (id) => db.get('SELECT * FROM playlists WHERE id=?', [id]);
export function createPlaylist(name, { kind = 'manual', rules = null } = {}) {
  const now = Date.now();
  return db.insert('playlists', { name, kind, rules: rules ? JSON.stringify(rules) : null, created_at: now, updated_at: now });
}
export function updatePlaylist(id, patch) {
  const p = { ...patch, updated_at: Date.now() };
  if (p.rules && typeof p.rules !== 'string') p.rules = JSON.stringify(p.rules);
  db.update('playlists', id, p);
}
export function deletePlaylist(id) {
  db.tx(() => { db.run('DELETE FROM playlist_items WHERE playlist_id=?', [id]); db.run('DELETE FROM playlists WHERE id=?', [id]); });
}
export function playlistTracks(id) {
  return db.all(`SELECT t.*, i.id AS item_id, i.pos, (s.track_id IS NOT NULL) AS starred FROM playlist_items i JOIN tracks t ON t.id=i.track_id
    LEFT JOIN stars s ON s.track_id=t.id WHERE i.playlist_id=? ORDER BY i.pos`, [id]);
}
export function addToPlaylist(id, trackIds) {
  db.tx(() => {
    let pos = db.val('SELECT COALESCE(MAX(pos), -1) FROM playlist_items WHERE playlist_id=?', [id]) + 1;
    const now = Date.now();
    for (const t of trackIds) db.insert('playlist_items', { playlist_id: id, track_id: t, pos: pos++, added_at: now });
    db.run('UPDATE playlists SET updated_at=? WHERE id=?', [now, id]);
  });
}
export function removeFromPlaylist(itemId) { db.run('DELETE FROM playlist_items WHERE id=?', [itemId]); }
export function movePlaylistItem(playlistId, itemId, dir) {
  const items = db.all('SELECT id, pos FROM playlist_items WHERE playlist_id=? ORDER BY pos', [playlistId]);
  const i = items.findIndex((x) => x.id === itemId), j = i + dir;
  if (i < 0 || j < 0 || j >= items.length) return;
  db.tx(() => {
    db.run('UPDATE playlist_items SET pos=? WHERE id=?', [items[j].pos, items[i].id]);
    db.run('UPDATE playlist_items SET pos=? WHERE id=?', [items[i].pos, items[j].id]);
  });
}

// ---------------------------------------------------------------- housekeeping

export function removeMissing(ids = null) {
  db.tx(() => {
    const where = ids ? `missing=1 AND id IN (${ids.map(() => '?').join(',')})` : 'missing=1';
    const gone = db.all(`SELECT id FROM tracks WHERE ${where}`, ids || []).map((r) => r.id);
    if (!gone.length) return;
    const list = gone.join(',');
    db.run(`DELETE FROM playlist_items WHERE track_id IN (${list})`);
    db.run(`DELETE FROM stars WHERE track_id IN (${list})`);
    db.run(`DELETE FROM tracks WHERE id IN (${list})`);
  });
}

export const ignored = () => new Set(db.all('SELECT key FROM health_ignore').map((r) => r.key));
export function ignoreIssue(key, on = true) {
  if (on) db.run('INSERT OR REPLACE INTO health_ignore(key, at) VALUES (?,?)', [key, Date.now()]);
  else db.run('DELETE FROM health_ignore WHERE key=?', [key]);
}

/** Every live track (used by health checks; ~1 KB per row, fine for tens of thousands). */
export const allTracks = () => db.all(`SELECT id, uri, root, folder, filename, ext, size, title, artist, album, albumartist, track_no, track_total,
  disc_no, disc_total, year, genre, duration_ms, sample_rate, bits, lossless, audio_md5, art_key, art_w, art_h, rg_track, rg_album, album_key, missing,
  CASE WHEN tags LIKE '%"_error"%' THEN 1 ELSE 0 END AS read_error FROM tracks`);

export { meta, setMeta };
