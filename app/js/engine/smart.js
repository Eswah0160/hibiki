// Smart playlists: rules -> SQL. Fields and operators are whitelisted; values are always bound parameters.
import { DAY } from '../util.js';

export const FIELDS = {
  title: { label: 'Title', type: 'text', sql: 't.title' },
  artist: { label: 'Artist', type: 'text', sql: 't.artist' },
  albumartist: { label: 'Album artist', type: 'text', sql: `COALESCE(NULLIF(t.albumartist,''), t.artist)` },
  album: { label: 'Album', type: 'text', sql: 't.album' },
  genre: { label: 'Genre', type: 'text', sql: 't.genre' },
  composer: { label: 'Composer', type: 'text', sql: 't.composer' },
  year: { label: 'Year', type: 'num', sql: `CAST(SUBSTR(t.year,1,4) AS INTEGER)` },
  format: { label: 'Format', type: 'text', sql: 't.ext' },
  bits: { label: 'Bit depth', type: 'num', sql: 't.bits' },
  sample_rate: { label: 'Sample rate (kHz)', type: 'num', sql: '(t.sample_rate / 1000.0)' },
  duration: { label: 'Length (min)', type: 'num', sql: '(t.duration_ms / 60000.0)' },
  plays: { label: 'Play count', type: 'num', sql: 'COALESCE(p.pc, 0)' },
  added: { label: 'Date added', type: 'date', sql: 't.added_at' },
  last_played: { label: 'Last played', type: 'date', sql: 'p.lp' },
  starred: { label: 'Starred', type: 'bool', sql: '(s.track_id IS NOT NULL)' },
  lossless: { label: 'Lossless', type: 'bool', sql: 't.lossless' },
  hires: { label: 'Hi-res', type: 'bool', sql: '(t.lossless=1 AND (t.bits>16 OR t.sample_rate>48000))' },
};

export const OPS = {
  text: [['contains', 'contains'], ['not_contains', 'does not contain'], ['is', 'is'], ['is_not', 'is not'], ['empty', 'is empty']],
  num: [['gt', 'is more than'], ['lt', 'is less than'], ['is', 'is'], ['between', 'is between']],
  date: [['within', 'in the last (days)'], ['not_within', 'not in the last (days)'], ['never', 'never']],
  bool: [['true', 'is yes'], ['false', 'is no']],
};

export const SORTS = {
  random: { label: 'Random', sql: 'RANDOM()' },
  added: { label: 'Recently added', sql: 't.added_at DESC' },
  plays: { label: 'Most played', sql: 'COALESCE(p.pc,0) DESC, p.lp DESC' },
  least: { label: 'Least played', sql: 'COALESCE(p.pc,0) ASC, RANDOM()' },
  last_played: { label: 'Recently played', sql: 'p.lp DESC' },
  album: { label: 'Album order', sql: `LOWER(COALESCE(NULLIF(t.albumartist,''), t.artist)), t.year, t.album_key, COALESCE(t.disc_no,1), t.track_no` },
  title: { label: 'Title', sql: 'LOWER(t.title)' },
};

export const PRESETS = [
  { name: 'Recently added', rules: { match: 'all', rules: [{ field: 'added', op: 'within', value: 30 }], sort: 'added', limit: 200 } },
  { name: 'Most played', rules: { match: 'all', rules: [{ field: 'plays', op: 'gt', value: 0 }], sort: 'plays', limit: 100 } },
  { name: 'Never played', rules: { match: 'all', rules: [{ field: 'last_played', op: 'never' }], sort: 'random', limit: 200 } },
  { name: 'Forgotten favourites', rules: { match: 'all', rules: [{ field: 'plays', op: 'gt', value: 4 }, { field: 'last_played', op: 'not_within', value: 90 }], sort: 'plays', limit: 100 } },
  { name: 'Hi-res', rules: { match: 'all', rules: [{ field: 'hires', op: 'true' }], sort: 'random', limit: 300 } },
  { name: 'Starred', rules: { match: 'all', rules: [{ field: 'starred', op: 'true' }], sort: 'added', limit: 0 } },
];

/** Returns {sql, params} selecting matching tracks (all tracks columns + plays/last_played/starred). */
export function compile(def, { now = Date.now() } = {}) {
  const rules = (def?.rules || []).filter((r) => FIELDS[r.field]);
  const parts = [];
  const params = [];
  for (const r of rules) {
    const f = FIELDS[r.field];
    const col = f.sql;
    const v = r.value;
    switch (`${f.type}:${r.op}`) {
      case 'text:contains': parts.push(`${col} LIKE ?`); params.push(`%${v ?? ''}%`); break;
      case 'text:not_contains': parts.push(`COALESCE(${col},'') NOT LIKE ?`); params.push(`%${v ?? ''}%`); break;
      case 'text:is': parts.push(`LOWER(${col}) = LOWER(?)`); params.push(String(v ?? '')); break;
      case 'text:is_not': parts.push(`LOWER(COALESCE(${col},'')) != LOWER(?)`); params.push(String(v ?? '')); break;
      case 'text:empty': parts.push(`COALESCE(${col},'') = ''`); break;
      case 'num:gt': parts.push(`${col} > ?`); params.push(Number(v) || 0); break;
      case 'num:lt': parts.push(`${col} < ?`); params.push(Number(v) || 0); break;
      case 'num:is': parts.push(`${col} = ?`); params.push(Number(v) || 0); break;
      case 'num:between': { const [a, b] = Array.isArray(v) ? v : String(v ?? '').split(/[-–,]/); parts.push(`${col} BETWEEN ? AND ?`); params.push(Number(a) || 0, Number(b) || 0); break; }
      case 'date:within': parts.push(`${col} >= ?`); params.push(now - (Number(v) || 0) * DAY); break;
      case 'date:not_within': parts.push(`(${col} IS NULL OR ${col} < ?)`); params.push(now - (Number(v) || 0) * DAY); break;
      case 'date:never': parts.push(`${col} IS NULL`); break;
      case 'bool:true': parts.push(`${col} = 1`); break;
      case 'bool:false': parts.push(`(${col} = 0 OR ${col} IS NULL)`); break;
      default: break; // unknown op: ignore rather than fail
    }
  }
  const where = parts.length ? `AND (${parts.join(def.match === 'any' ? ' OR ' : ' AND ')})` : '';
  const sort = (SORTS[def?.sort] || SORTS.random).sql;
  const limit = Number(def?.limit) > 0 ? ` LIMIT ${Math.min(10000, Number(def.limit) | 0)}` : '';
  const sql = `SELECT t.*, COALESCE(p.pc,0) AS plays, p.lp AS last_played, (s.track_id IS NOT NULL) AS starred
    FROM tracks t
    LEFT JOIN (SELECT track_id, COUNT(*) AS pc, MAX(at) AS lp FROM plays GROUP BY track_id) p ON p.track_id = t.id
    LEFT JOIN stars s ON s.track_id = t.id
    WHERE t.missing = 0 ${where}
    ORDER BY ${sort}${limit}`;
  return { sql, params };
}

export function describe(def) {
  const rs = (def?.rules || []).filter((r) => FIELDS[r.field]).map((r) => {
    const f = FIELDS[r.field];
    const op = (OPS[f.type].find(([k]) => k === r.op) || [, r.op])[1];
    if (f.type === 'bool') return `${f.label.toLowerCase()} ${r.op === 'true' ? 'yes' : 'no'}`;
    if (r.op === 'never' || r.op === 'empty') return `${f.label.toLowerCase()} ${op}`;
    return `${f.label.toLowerCase()} ${op.replace(' (days)', '')} ${Array.isArray(r.value) ? r.value.join('–') : r.value}${f.type === 'date' ? ' days' : ''}`;
  });
  return rs.join(def?.match === 'any' ? ' or ' : ', ') || 'all tracks';
}
