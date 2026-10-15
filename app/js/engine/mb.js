// MusicBrainz lookups (search a release, fetch it, turn it into Vorbis comments for local files) and
// Cover Art Archive URLs. Requests go through the app (native.http) at most one per ~1.1 s, which is
// what MusicBrainz asks of clients.
import * as native from '../native.js';

const API = 'https://musicbrainz.org/ws/2';
let chain = Promise.resolve();
let lastAt = 0;

function throttled(fn) {
  const run = chain.then(async () => {
    const wait = lastAt + 1100 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastAt = Date.now();
    return fn();
  });
  chain = run.catch(() => {});
  return run;
}

async function getJson(path) {
  const r = await throttled(() => native.http(API + path));
  if (r.status === 503) throw new Error('MusicBrainz is busy — try again in a moment');
  if (r.status !== 200) throw new Error(`MusicBrainz returned ${r.status}`);
  return JSON.parse(r.body);
}

/** Lucene-escape a term for a quoted MusicBrainz query. */
export const luceneQuote = (s) => '"' + String(s || '').replace(/[\\"]/g, '\\$&') + '"';

export function searchQuery({ album, artist, tracks }) {
  const q = [];
  if (album) q.push(`release:${luceneQuote(album)}`);
  if (artist && !/^various( artists)?$/i.test(artist)) q.push(`artist:${luceneQuote(artist)}`);
  let s = q.join(' AND ');
  if (tracks) s += ` tracks:${tracks | 0}`; // boosts, doesn't filter
  return s;
}

export async function searchReleases(opts) {
  const query = searchQuery(opts);
  if (!query.trim()) return [];
  const j = await getJson(`/release/?fmt=json&limit=15&query=${encodeURIComponent(query)}`);
  return (j.releases || []).map(summarizeRelease);
}

export function summarizeRelease(r) {
  return {
    id: r.id,
    title: r.title,
    artist: credit(r['artist-credit']),
    date: r.date || '',
    country: r.country || '',
    score: r.score ?? null,
    trackCount: r['track-count'] ?? (r.media || []).reduce((s, m) => s + (m['track-count'] || 0), 0),
    format: [...new Set((r.media || []).map((m) => m.format).filter(Boolean))].join(' + '),
    label: (r['label-info'] || []).map((l) => l.label?.name).filter(Boolean)[0] || '',
    status: r.status || '',
    barcode: r.barcode || '',
  };
}

export function getRelease(id) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return Promise.reject(new Error('Not a MusicBrainz release id'));
  return getJson(`/release/${id}?fmt=json&inc=recordings+artist-credits+labels+release-groups+genres`);
}

export const coverUrl = (releaseId, size = 1200) => `https://coverartarchive.org/release/${releaseId}/front-${size}`;

export async function fetchCover(releaseId, size = 1200) {
  const r = await native.http(coverUrl(releaseId, size), { binary: true });
  if (r.status !== 200 || !r.b64) return null;
  return { b64: r.b64, mime: (r.mime || 'image/jpeg').split(';')[0] };
}

export const credit = (ac) => (ac || []).map((c) => (c.name || c.artist?.name || '') + (c.joinphrase || '')).join('').trim();

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Flat list of release tracks: {disc, num, total, discTotal, title, artist, length, trackId, recordingId, artistId, format}. */
export function releaseTracks(rel) {
  const media = rel.media || [];
  const out = [];
  for (const m of media) {
    for (const t of m.tracks || []) {
      const ac = t['artist-credit'] || t.recording?.['artist-credit'];
      out.push({
        disc: m.position || 1, num: t.position, total: m['track-count'] || (m.tracks || []).length, discTotal: media.length,
        title: t.title || t.recording?.title || '', artist: credit(ac) || credit(rel['artist-credit']),
        length: t.length ?? t.recording?.length ?? null,
        trackId: t.id, recordingId: t.recording?.id || null, artistId: ac?.[0]?.artist?.id || null, format: m.format || '',
      });
    }
  }
  return out;
}

/**
 * Pair local tracks with release tracks: by disc + track number first, then by title, then by
 * position if the counts agree. Returns [{local, remote|null, how}].
 */
export function matchTracks(locals, rel) {
  const remote = releaseTracks(rel);
  const used = new Set();
  const out = locals.map((l) => ({ local: l, remote: null, how: null }));
  // 1. disc/track number
  for (const m of out) {
    const d = m.local.disc_no || 1, n = m.local.track_no;
    if (!n) continue;
    const i = remote.findIndex((r, k) => !used.has(k) && r.disc === d && r.num === n);
    if (i >= 0) { used.add(i); m.remote = remote[i]; m.how = 'number'; }
  }
  // sanity: a numbered match whose title is totally different and whose length is way off is probably wrong
  for (const m of out) {
    if (m.how !== 'number' || !m.local.title) continue;
    const titleOk = norm(m.local.title) === norm(m.remote.title) || norm(m.remote.title).includes(norm(m.local.title)) || norm(m.local.title).includes(norm(m.remote.title));
    const lenOk = !m.local.duration_ms || !m.remote.length || Math.abs(m.local.duration_ms - m.remote.length) < 10000;
    if (!titleOk && !lenOk) { used.delete(remote.indexOf(m.remote)); m.remote = null; m.how = null; }
  }
  // 2. title
  for (const m of out) {
    if (m.remote || !m.local.title) continue;
    const i = remote.findIndex((r, k) => !used.has(k) && norm(r.title) === norm(m.local.title));
    if (i >= 0) { used.add(i); m.remote = remote[i]; m.how = 'title'; }
  }
  // 3. order, only when everything left lines up one-to-one
  const leftL = out.filter((m) => !m.remote);
  const leftR = remote.map((r, k) => k).filter((k) => !used.has(k));
  if (leftL.length && leftL.length === leftR.length) {
    const sorted = leftL.slice().sort((a, b) => (a.local.disc_no || 1) - (b.local.disc_no || 1) || (a.local.track_no || 0) - (b.local.track_no || 0) || String(a.local.filename).localeCompare(String(b.local.filename), undefined, { numeric: true }));
    sorted.forEach((m, i) => { m.remote = remote[leftR[i]]; m.how = 'order'; used.add(leftR[i]); });
  }
  return out;
}

export function topGenres(rel, n = 2) {
  const g = [...(rel.genres || []), ...(rel['release-group']?.genres || [])];
  const m = new Map();
  for (const x of g) m.set(x.name, Math.max(m.get(x.name) || 0, x.count || 0));
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k.replace(/\b\w/g, (c) => c.toUpperCase()));
}

/** Vorbis comments for one matched track. opts.genre=false keeps the user's genre; opts.ids=false skips MusicBrainz ids. */
export function tagsFor(rel, r, { genre = true, ids = true } = {}) {
  const lab = (rel['label-info'] || [])[0];
  const rg = rel['release-group'] || {};
  const set = {
    TITLE: r.title,
    ARTIST: r.artist,
    ALBUM: rel.title,
    ALBUMARTIST: credit(rel['artist-credit']),
    DATE: rel.date || rg['first-release-date'] || null,
    ORIGINALDATE: rg['first-release-date'] || null,
    TRACKNUMBER: String(r.num),
    TRACKTOTAL: String(r.total),
    DISCNUMBER: String(r.disc),
    DISCTOTAL: String(r.discTotal),
    LABEL: lab?.label?.name || null,
    CATALOGNUMBER: lab?.['catalog-number'] || null,
    BARCODE: rel.barcode || null,
    RELEASECOUNTRY: rel.country || null,
    MEDIA: r.format || null,
  };
  if (genre) { const g = topGenres(rel); if (g.length) set.GENRE = g.join('; '); }
  if (ids) Object.assign(set, {
    MUSICBRAINZ_ALBUMID: rel.id,
    MUSICBRAINZ_RELEASEGROUPID: rg.id || null,
    MUSICBRAINZ_TRACKID: r.recordingId,
    MUSICBRAINZ_RELEASETRACKID: r.trackId,
    MUSICBRAINZ_ARTISTID: r.artistId,
    MUSICBRAINZ_ALBUMARTISTID: rel['artist-credit']?.[0]?.artist?.id || null,
  });
  for (const k of Object.keys(set)) if (set[k] === '' || set[k] === undefined) set[k] = null;
  return set;
}

/** Fields the user will see changing, for the preview table. */
export function diff(local, set) {
  const cur = { TITLE: local.title, ARTIST: local.artist, ALBUM: local.album, ALBUMARTIST: local.albumartist, DATE: local.year,
    TRACKNUMBER: local.track_no != null ? String(local.track_no) : null, DISCNUMBER: local.disc_no != null ? String(local.disc_no) : null, GENRE: local.genre };
  const out = [];
  for (const k of Object.keys(cur)) {
    if (!(k in set)) continue;
    const a = cur[k] ?? '', b = set[k] ?? '';
    if (String(a) !== String(b)) out.push({ key: k, from: a, to: b });
  }
  return out;
}
