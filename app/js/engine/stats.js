// Listening and library statistics, plus the Markdown summary for Obsidian.
import { db } from '../db.js';
import { DAY, startOfDay, isoDate, longDur, quality, year as yearOf } from '../util.js';

const ARTIST = `COALESCE(NULLIF(TRIM(t.albumartist),''), NULLIF(TRIM(t.artist),''), 'Unknown artist')`;

export const PERIODS = { week: { label: '7 days', days: 7 }, month: { label: '30 days', days: 30 }, year: { label: '12 months', days: 365 }, all: { label: 'All time', days: 0 } };

export function since(period, now = Date.now()) {
  const d = PERIODS[period]?.days || 0;
  return d ? startOfDay(now) - (d - 1) * DAY : 0;
}

export function listening(period = 'month', now = Date.now()) {
  const from = since(period, now);
  const totals = db.get('SELECT COUNT(*) plays, COALESCE(SUM(ms),0) ms, COUNT(DISTINCT track_id) tracks FROM plays WHERE at >= ?', [from]);
  const topArtists = db.all(`SELECT ${ARTIST} AS name, COUNT(*) AS plays, SUM(p.ms) AS ms, MAX(t.art_key) AS art
    FROM plays p JOIN tracks t ON t.id=p.track_id WHERE p.at >= ? GROUP BY ${ARTIST} ORDER BY plays DESC LIMIT 10`, [from]);
  const topAlbums = db.all(`SELECT t.album_key AS key, MAX(t.album) AS album, MAX(${ARTIST}) AS artist, COUNT(*) AS plays, MAX(t.art_key) AS art
    FROM plays p JOIN tracks t ON t.id=p.track_id WHERE p.at >= ? GROUP BY t.album_key ORDER BY plays DESC LIMIT 10`, [from]);
  const topTracks = db.all(`SELECT t.*, COUNT(*) AS plays FROM plays p JOIN tracks t ON t.id=p.track_id
    WHERE p.at >= ? GROUP BY t.id ORDER BY plays DESC, MAX(p.at) DESC LIMIT 10`, [from]);
  const rows = db.all('SELECT at, ms FROM plays WHERE at >= ?', [from]);
  const hours = new Array(24).fill(0);
  for (const r of rows) hours[new Date(r.at).getHours()] += r.ms;
  return { from, ...totals, topArtists, topAlbums, topTracks, hours, streak: streak(now), byWeek: byWeek(12, now) };
}

/** Listening time per week for the last n weeks (Monday-start), oldest first. */
export function byWeek(n = 12, now = Date.now()) {
  const today = new Date(startOfDay(now));
  const dow = (today.getDay() + 6) % 7; // Monday = 0
  const thisMonday = today.getTime() - dow * DAY;
  const start = thisMonday - (n - 1) * 7 * DAY;
  const out = [];
  for (let i = 0; i < n; i++) out.push({ start: start + i * 7 * DAY, ms: 0, plays: 0 });
  for (const r of db.all('SELECT at, ms FROM plays WHERE at >= ?', [start])) {
    const i = Math.floor((r.at - start) / (7 * DAY));
    if (out[i]) { out[i].ms += r.ms; out[i].plays++; }
  }
  return out;
}

/** Consecutive days (ending today or yesterday) with at least one play. */
export function streak(now = Date.now()) {
  const days = new Set(db.all('SELECT at FROM plays WHERE at >= ?', [now - 400 * DAY]).map((r) => isoDate(r.at)));
  let d = startOfDay(now);
  if (!days.has(isoDate(d))) d -= DAY;
  let n = 0;
  while (days.has(isoDate(d))) { n++; d -= DAY; }
  return n;
}

export function library() {
  const rows = db.all('SELECT ext, lossless, bits, sample_rate, bitrate, year, genre, duration_ms, size FROM tracks WHERE missing=0');
  const quality = new Map(), formats = new Map(), decades = new Map(), genres = new Map();
  const bump = (m, k, ms = 0) => { const e = m.get(k) || { name: k, n: 0, ms: 0 }; e.n++; e.ms += ms || 0; m.set(k, e); };
  for (const t of rows) {
    bump(formats, t.ext === 'm4a' ? (t.lossless ? 'ALAC' : 'AAC') : (t.ext || '?').toUpperCase(), t.duration_ms);
    let q;
    if (!t.lossless) q = 'Lossy';
    else if ((t.bits || 0) > 16 || (t.sample_rate || 0) > 48000) q = (t.sample_rate || 0) >= 88200 ? 'Hi-res 88.2 kHz+' : 'Hi-res 24-bit';
    else q = 'CD quality';
    bump(quality, q, t.duration_ms);
    const y = Number(yearOf(t.year));
    bump(decades, y ? `${Math.floor(y / 10) * 10}s` : 'Unknown', t.duration_ms);
    for (const g of String(t.genre || '').split(/\s*[;/]\s*/).filter(Boolean)) bump(genres, g.trim(), t.duration_ms);
  }
  const qOrder = ['Hi-res 88.2 kHz+', 'Hi-res 24-bit', 'CD quality', 'Lossy'];
  return {
    quality: [...quality.values()].sort((a, b) => qOrder.indexOf(a.name) - qOrder.indexOf(b.name)),
    formats: [...formats.values()].sort((a, b) => b.n - a.n),
    decades: [...decades.values()].sort((a, b) => (a.name === 'Unknown') - (b.name === 'Unknown') || a.name.localeCompare(b.name)),
    genres: [...genres.values()].sort((a, b) => b.n - a.n).slice(0, 15),
    total: rows.length,
  };
}

/** A month of listening as Markdown, for an Obsidian daily/monthly note. month = 'YYYY-MM'. */
export function monthMarkdown(month) {
  const [y, m] = month.split('-').map(Number);
  const from = new Date(y, m - 1, 1).getTime(), to = new Date(y, m, 1).getTime();
  const tot = db.get('SELECT COUNT(*) plays, COALESCE(SUM(ms),0) ms, COUNT(DISTINCT track_id) tracks FROM plays WHERE at >= ? AND at < ?', [from, to]);
  const artists = db.all(`SELECT ${ARTIST} name, COUNT(*) n FROM plays p JOIN tracks t ON t.id=p.track_id WHERE p.at >= ? AND p.at < ? GROUP BY name ORDER BY n DESC LIMIT 10`, [from, to]);
  const albums = db.all(`SELECT MAX(t.album) album, MAX(${ARTIST}) artist, MAX(t.year) year, COUNT(*) n FROM plays p JOIN tracks t ON t.id=p.track_id WHERE p.at >= ? AND p.at < ? GROUP BY t.album_key ORDER BY n DESC LIMIT 10`, [from, to]);
  const tracks = db.all(`SELECT t.title, t.artist, COUNT(*) n FROM plays p JOIN tracks t ON t.id=p.track_id WHERE p.at >= ? AND p.at < ? GROUP BY t.id ORDER BY n DESC LIMIT 10`, [from, to]);
  const added = db.all(`SELECT MAX(album) album, MAX(COALESCE(NULLIF(albumartist,''), artist)) artist, MAX(ext) ext, MAX(bits) bits, MAX(sample_rate) sample_rate, MIN(lossless) lossless
    FROM tracks WHERE added_at >= ? AND added_at < ? GROUP BY album_key ORDER BY MIN(added_at)`, [from, to]);
  const label = new Date(y, m - 1, 1).toLocaleDateString('en-AU', { month: 'long', year: 'numeric' });
  const L = [];
  L.push('---', `type: listening`, `month: ${month}`, `plays: ${tot.plays}`, `hours: ${(tot.ms / 3600000).toFixed(1)}`, 'tags: [music, hibiki]', '---', '');
  L.push(`# Listening — ${label}`, '');
  L.push(`**${tot.plays} plays** · **${longDur(tot.ms)}** · ${tot.tracks} different tracks`, '');
  if (artists.length) { L.push('## Top artists', ''); artists.forEach((a, i) => L.push(`${i + 1}. [[${a.name}]] — ${a.n} plays`)); L.push(''); }
  if (albums.length) { L.push('## Top albums', ''); albums.forEach((a, i) => L.push(`${i + 1}. *${a.album || 'Unknown album'}* — ${a.artist}${yearOf(a.year) ? ` (${yearOf(a.year)})` : ''} · ${a.n} plays`)); L.push(''); }
  if (tracks.length) { L.push('## Top tracks', ''); tracks.forEach((t, i) => L.push(`${i + 1}. ${t.title || 'Untitled'} — ${t.artist || ''} · ${t.n}`)); L.push(''); }
  if (added.length) { L.push('## Added to the library', ''); added.forEach((a) => L.push(`- *${a.album || 'Unknown album'}* — ${a.artist || ''} · ${quality(a)}`)); L.push(''); }
  L.push(`*Exported from Hibiki ${isoDate()}*`, '');
  return L.join('\n');
}
