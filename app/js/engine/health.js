// Library health checks. Pure functions over track rows so they can be unit-tested without a phone.
//
// Each issue: { key, check, severity: 'high'|'medium'|'low', title, detail, trackIds, albumKey?, fix? }
// `key` is stable across runs so the user can dismiss an issue and it stays dismissed.

export const CHECKS = {
  missing: { label: 'Missing files', severity: 'high', blurb: 'Files that were in your library but are no longer in the folder.' },
  read_error: { label: 'Unreadable files', severity: 'high', blurb: 'Files whose tags or stream info could not be read — possibly damaged.' },
  dupe_exact: { label: 'Exact duplicates', severity: 'high', blurb: 'The same audio stored more than once (identical FLAC audio checksum).' },
  dupe_likely: { label: 'Possible duplicates', severity: 'medium', blurb: 'Same artist, title and length in different files.' },
  missing_art: { label: 'Missing cover art', severity: 'medium', blurb: 'Albums with no embedded or folder artwork.' },
  missing_tags: { label: 'Missing tags', severity: 'medium', blurb: 'Tracks without a title, artist, album or track number.' },
  mixed_tags: { label: 'Inconsistent album tags', severity: 'medium', blurb: 'One folder whose tracks disagree on album, album artist or year — this splits albums.' },
  numbering: { label: 'Track numbering', severity: 'medium', blurb: 'Albums with duplicate or missing track numbers.' },
  lossy: { label: 'Lossy files', severity: 'medium', blurb: 'MP3/AAC/Ogg files in a lossless library.' },
  low_art: { label: 'Low-resolution art', severity: 'low', blurb: 'Cover art smaller than 500 × 500 px.' },
  no_md5: { label: 'No audio checksum', severity: 'low', blurb: 'FLAC files whose encoder left the MD5 empty, so integrity can’t be verified.' },
  mixed_quality: { label: 'Mixed quality in an album', severity: 'low', blurb: 'Tracks of one album with different sample rates or bit depths.' },
  no_rg: { label: 'No ReplayGain', severity: 'low', blurb: 'Albums without ReplayGain tags, so volume levelling can’t work for them.' },
};

const SEV_WEIGHT = { high: 3, medium: 1.5, low: 0.4 };

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/\s*[([](feat\.?|ft\.?|with)[^)\]]*[)\]]/g, '').replace(/\s*-\s*(remaster(ed)?|\d{4} remaster).*$/, '').replace(/[^a-z0-9]+/g, ' ').trim();

function groupBy(rows, fn) {
  const m = new Map();
  for (const r of rows) { const k = fn(r); if (k == null) continue; let a = m.get(k); if (!a) m.set(k, (a = [])); a.push(r); }
  return m;
}

const albumName = (ts) => ts.find((t) => t.album)?.album || ts[0]?.folder || 'Unknown album';
const albumArtist = (ts) => ts.find((t) => t.albumartist)?.albumartist || ts.find((t) => t.artist)?.artist || '';
const label = (ts) => { const a = albumArtist(ts); return a ? `${a} — ${albumName(ts)}` : albumName(ts); };

export function runHealth(all, { ignored = new Set() } = {}) {
  const issues = [];
  const add = (check, key, o) => {
    const k = `${check}:${key}`;
    issues.push({ key: k, check, severity: CHECKS[check].severity, ignored: ignored.has(k), ...o });
  };

  const missing = all.filter((t) => t.missing);
  if (missing.length) add('missing', 'all', { title: `${missing.length} file${missing.length === 1 ? '' : 's'} not found`, detail: 'Moved, renamed or deleted since the last scan.', trackIds: missing.map((t) => t.id), fix: 'remove_missing' });

  const live = all.filter((t) => !t.missing);

  for (const t of live.filter((x) => x.read_error)) add('read_error', t.id, { title: t.filename, detail: t.folder, trackIds: [t.id], fix: 'show' });

  // duplicates
  for (const [md5, ts] of groupBy(live.filter((t) => t.audio_md5), (t) => t.audio_md5)) {
    if (ts.length > 1) add('dupe_exact', md5, { title: `${ts[0].title || ts[0].filename} ×${ts.length}`, detail: ts.map((t) => `${t.folder}/${t.filename}`).join('\n'), trackIds: ts.map((t) => t.id), fix: 'compare' });
  }
  const exactIds = new Set(issues.filter((i) => i.check === 'dupe_exact').flatMap((i) => i.trackIds));
  const byTitle = groupBy(live.filter((t) => t.title && t.artist && !exactIds.has(t.id)), (t) => `${norm(t.artist)}|${norm(t.title)}`);
  for (const [k, ts] of byTitle) {
    if (ts.length < 2) continue;
    ts.sort((a, b) => (a.duration_ms || 0) - (b.duration_ms || 0));
    // cluster by duration within 2 s
    let cluster = [ts[0]];
    const flush = () => {
      // (The same song on an album and on a compilation shows up here too; dismiss those.)
      if (cluster.length > 1) {
        add('dupe_likely', `${k}|${cluster.map((t) => t.id).sort((a, b) => a - b).join(',')}`, {
          title: `${cluster[0].artist} — ${cluster[0].title}`,
          detail: cluster.map((t) => `${t.album || t.folder} (${t.ext.toUpperCase()})`).join('\n'),
          trackIds: cluster.map((t) => t.id), fix: 'compare',
        });
      }
    };
    for (let i = 1; i < ts.length; i++) {
      if (Math.abs((ts[i].duration_ms || 0) - (cluster[cluster.length - 1].duration_ms || 0)) <= 2000) cluster.push(ts[i]);
      else { flush(); cluster = [ts[i]]; }
    }
    flush();
  }

  // album-level checks
  const albums = groupBy(live, (t) => t.album_key);
  for (const [key, ts] of albums) {
    const name = label(ts);
    const ids = ts.map((t) => t.id);
    if (!ts.some((t) => t.art_key)) add('missing_art', key, { title: name, detail: `${ts.length} track${ts.length === 1 ? '' : 's'}`, trackIds: ids, albumKey: key, fix: 'art' });
    else {
      const w = Math.max(...ts.map((t) => Math.min(t.art_w || 0, t.art_h || 0)));
      if (w > 0 && w < 500) add('low_art', key, { title: name, detail: `${w} px`, trackIds: ids, albumKey: key, fix: 'art' });
    }
    const lossy = ts.filter((t) => !t.lossless);
    if (lossy.length) add('lossy', key, { title: name, detail: `${lossy.length} of ${ts.length}: ${[...new Set(lossy.map((t) => t.ext.toUpperCase()))].join(', ')}`, trackIds: lossy.map((t) => t.id), albumKey: key });

    const lacking = ts.filter((t) => !t.title || !t.artist || !t.album || !t.track_no);
    if (lacking.length) {
      const what = ['title', 'artist', 'album', 'track_no'].filter((f) => lacking.some((t) => !t[f])).map((f) => (f === 'track_no' ? 'track #' : f));
      add('missing_tags', key, { title: name, detail: `${lacking.length} track${lacking.length === 1 ? '' : 's'} missing ${what.join(', ')}`, trackIds: lacking.map((t) => t.id), albumKey: key, fix: 'tags' });
    }

    // numbering per disc
    const problems = [];
    for (const [disc, dts] of groupBy(ts, (t) => t.disc_no || 1)) {
      const nums = dts.map((t) => t.track_no).filter((n) => n > 0);
      if (!nums.length) continue;
      const seen = new Set(), dup = new Set();
      for (const n of nums) (seen.has(n) ? dup : seen).add(n);
      const total = Math.max(...dts.map((t) => t.track_total || 0), ...nums);
      const gaps = [];
      for (let n = 1; n <= total && gaps.length < 30; n++) if (!seen.has(n)) gaps.push(n);
      const pre = groupBy(ts, (t) => t.disc_no || 1).size > 1 ? `disc ${disc}: ` : '';
      if (dup.size) problems.push(`${pre}duplicate #${[...dup].join(', #')}`);
      if (gaps.length) problems.push(`${pre}missing #${gaps.join(', #')}`);
    }
    if (problems.length) add('numbering', key, { title: name, detail: problems.join('; '), trackIds: ids, albumKey: key, fix: 'tags' });

    const flac = ts.filter((t) => t.ext === 'flac');
    const noMd5 = flac.filter((t) => !t.audio_md5);
    if (noMd5.length) add('no_md5', key, { title: name, detail: `${noMd5.length} file${noMd5.length === 1 ? '' : 's'}`, trackIds: noMd5.map((t) => t.id), albumKey: key });

    const fmts = new Set(ts.filter((t) => t.lossless && t.sample_rate).map((t) => `${t.bits}/${t.sample_rate}`));
    if (fmts.size > 1) add('mixed_quality', key, { title: name, detail: [...fmts].map((f) => { const [b, s] = f.split('/'); return `${b}/${s / 1000}`; }).join(', '), trackIds: ids, albumKey: key });

    if (ts.every((t) => t.rg_track == null && t.rg_album == null)) add('no_rg', key, { title: name, detail: '', trackIds: ids, albumKey: key });
  }

  // folder-level consistency (what splits one album into several)
  for (const [, ts] of groupBy(live, (t) => `${t.root}|${t.folder}`)) {
    if (ts.length < 2) continue;
    const fields = [['album', 'album'], ['albumartist', 'album artist'], ['year', 'year']];
    const diffs = [];
    for (const [f, nice] of fields) {
      const vals = new Set(ts.map((t) => (t[f] || '').trim()));
      if (vals.size > 1) diffs.push(`${nice}: ${[...vals].map((v) => v || '(empty)').slice(0, 4).join(' / ')}`);
    }
    // A folder of loose singles (every track a different album) isn't an album; skip it.
    const albumsIn = new Set(ts.map((t) => (t.album || '').trim().toLowerCase()));
    if (diffs.length && albumsIn.size < ts.length) {
      add('mixed_tags', `${ts[0].root}|${ts[0].folder}`, { title: ts[0].folder || '(top folder)', detail: diffs.join('\n'), trackIds: ts.map((t) => t.id), fix: 'tags' });
    }
  }

  const order = { high: 0, medium: 1, low: 2 };
  issues.sort((a, b) => order[a.severity] - order[b.severity] || a.check.localeCompare(b.check) || String(a.title).localeCompare(String(b.title)));
  return issues;
}

/**
 * 0–100. Weighted share of tracks affected by active (non-dismissed) issues, so a single
 * mistagged album in a big library barely moves the needle, but missing files do.
 */
export function score(issues, totalTracks) {
  if (!totalTracks) return 100;
  const hit = new Map();
  for (const i of issues) {
    if (i.ignored) continue;
    const w = SEV_WEIGHT[i.severity];
    for (const id of i.trackIds) hit.set(id, Math.max(hit.get(id) || 0, w));
  }
  let sum = 0;
  for (const w of hit.values()) sum += w;
  return Math.max(0, Math.round(100 - (sum / (totalTracks * SEV_WEIGHT.high)) * 100));
}

export function summarize(issues) {
  const by = {};
  for (const i of issues) {
    if (i.ignored) continue;
    by[i.check] = by[i.check] || { check: i.check, ...CHECKS[i.check], count: 0, tracks: 0 };
    by[i.check].count++;
    by[i.check].tracks += i.trackIds.length;
  }
  const order = { high: 0, medium: 1, low: 2 };
  return Object.values(by).sort((a, b) => order[a.severity] - order[b.severity] || b.tracks - a.tracks);
}
