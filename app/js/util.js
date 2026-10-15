// Formatting + small helpers. Times are ms since epoch; durations are ms.

export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** 3:07, 1:02:45 */
export function dur(ms) {
  if (!ms || ms < 0) return '0:00';
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}

/** "42 min", "3 h 12 min", "5 d 3 h" */
export function longDur(ms) {
  const min = Math.round((ms || 0) / 60000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h ${min % 60} min`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}

export function hours(ms) { return (ms || 0) / 3600000; }

export function bytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

export const plural = (n, one, many = one + 's') => `${n.toLocaleString('en-AU')} ${n === 1 ? one : many}`;

/** "FLAC 24/96", "MP3 320k", "ALAC 16/44.1" */
export function quality(t) {
  if (!t) return '';
  const fmt = (t.ext === 'm4a' ? (t.lossless ? 'ALAC' : 'AAC') : (t.ext || '').toUpperCase());
  if (t.lossless && t.sample_rate) {
    const k = t.sample_rate / 1000;
    return `${fmt} ${t.bits || '?'}/${Number.isInteger(k) ? k : k.toFixed(1)}`;
  }
  return t.bitrate ? `${fmt} ${t.bitrate}k` : fmt;
}

/** True for anything better than CD quality. */
export const isHiRes = (t) => !!t && !!t.lossless && ((t.bits || 0) > 16 || (t.sample_rate || 0) > 48000);

export function year(y) { const m = /\d{4}/.exec(y || ''); return m ? m[0] : ''; }

export function ago(ts) {
  if (!ts) return 'never';
  const d = (Date.now() - ts) / 1000;
  if (d < 60) return 'just now';
  if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  if (d < 86400) return `${Math.floor(d / 3600)} h ago`;
  if (d < 86400 * 7) return `${Math.floor(d / 86400)} d ago`;
  return new Date(ts).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: d > 86400 * 300 ? 'numeric' : undefined });
}

export const DAY = 86400000;
export function startOfDay(ts = Date.now()) { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); }
export function isoDate(ts = Date.now()) { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }

/** Case/accent-insensitive comparison key ("Beyoncé" -> "beyonce", "The Beatles" sorts as "beatles"). */
export function sortKey(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/^(the|a|an)\s+/, '').trim();
}

export function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

export function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

/** Display artist for an album row. */
export const albumArtistOf = (t) => (t.albumartist && t.albumartist.trim()) || t.artist || 'Unknown artist';
export const titleOf = (t) => (t.title && t.title.trim()) || (t.filename || '').replace(/\.[^.]+$/, '') || 'Untitled';
