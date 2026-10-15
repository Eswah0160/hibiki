// Mix of the day: a ~20-track playlist built once per day from your own library, kept the same all day.
// A blend of favourites (starred / often played), rediscoveries (not heard for a month) and things you
// haven't played yet, with no more than 2 tracks per album or 3 per artist, never the same artist twice
// in a row. "Another" makes a new mix for today. Pure selection logic: the caller passes rows + stats.

const DAY = 86400000;

/** Small seeded random generator, so the same day gives the same mix. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export const hash = (s) => { let h = 2166136261; for (const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };

/**
 * tracks: [{id, artist, album_key, duration_ms, genre, added_at, plays, last, starred}]
 * Returns { ids, ms, genres } — ordered track ids, total length, the most common genres in the mix.
 */
export function buildMix(tracks, { seed = 1, now = Date.now(), size = 20, maxMs = 80 * 60000 } = {}) {
  const r = rng(seed);
  const shuffle = (a) => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const usable = tracks.filter((t) => (t.duration_ms || 0) >= 45000 && (t.duration_ms || 0) <= 15 * 60000); // skip interludes and long sets
  const pool = usable.length >= 8 ? usable : tracks;
  const recent = (t) => t.last && now - t.last < 2 * DAY;
  const fav = shuffle(pool.filter((t) => (t.starred || t.plays >= 3) && !recent(t)));
  const old = shuffle(pool.filter((t) => t.plays > 0 && t.last && now - t.last > 30 * DAY));
  // Unheard: lean towards recent additions — sort by added date, then shuffle within the newest half.
  const unheardAll = pool.filter((t) => !t.plays).sort((a, b) => (b.added_at || 0) - (a.added_at || 0));
  const unheard = shuffle(unheardAll.slice(0, Math.max(30, Math.ceil(unheardAll.length / 2))));
  const rest = shuffle(pool);

  const picked = [], seen = new Set(), perAlbum = new Map(), perArtist = new Map();
  let ms = 0;
  let capped = true;
  const take = (t) => {
    if (seen.has(t.id)) return false;
    const al = t.album_key || '', ar = (t.artist || '').toLowerCase();
    if (capped && ((perAlbum.get(al) || 0) >= 2 || (ar && (perArtist.get(ar) || 0) >= 3))) return false;
    if (picked.length && ms + (t.duration_ms || 0) > maxMs) return false;
    seen.add(t.id); perAlbum.set(al, (perAlbum.get(al) || 0) + 1); if (ar) perArtist.set(ar, (perArtist.get(ar) || 0) + 1);
    picked.push(t); ms += t.duration_ms || 0;
    return true;
  };
  const fill = (list, n) => { let k = 0; for (const t of list) { if (k >= n || picked.length >= size) break; if (take(t)) k++; } };
  const third = Math.ceil(size / 3);
  fill(fav, third); fill(old, third); fill(unheard, third); fill(rest, size);
  // Small libraries: relax the per-album / per-artist limits rather than return a short mix.
  if (picked.length < Math.min(size, pool.length)) { capped = false; fill(rest, size); }

  // Order: shuffled, then nudged so one artist never plays twice in a row where the mix allows it.
  const out = shuffle(picked);
  for (let i = 1; i < out.length; i++) {
    if (!out[i].artist || out[i].artist !== out[i - 1].artist) continue;
    let j = i + 1;
    while (j < out.length && out[j].artist === out[i - 1].artist) j++;
    if (j < out.length) [out[i], out[j]] = [out[j], out[i]];
  }
  const g = new Map();
  for (const t of out) for (const x of String(t.genre || '').split(/\s*[;/]\s*/).filter(Boolean)) g.set(x, (g.get(x) || 0) + 1);
  const genres = [...g.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0]).slice(0, 3);
  return { ids: out.map((t) => t.id), ms, genres };
}
