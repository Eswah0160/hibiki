// Reading tags and stream info in the browser (web app only). FLAC: STREAMINFO, Vorbis comments, PICTURE.
// MP3: ID3v2.3/2.4 text frames + APIC. Everything else falls back to the file name and the audio element.
// Only the header region of each file is read, never the whole file.

const u8 = async (f, a, b) => new Uint8Array(await f.slice(a, b).arrayBuffer());
const syncsafe = (b, o) => ((b[o] & 127) << 21) | ((b[o + 1] & 127) << 14) | ((b[o + 2] & 127) << 7) | (b[o + 3] & 127);
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

function addTag(tags, k, v) {
  v = String(v ?? '').replace(/\u0000+$/, '').trim();
  if (!v) return;
  k = k.toUpperCase();
  if (tags[k] == null) tags[k] = v;
  else if (Array.isArray(tags[k])) { if (!tags[k].includes(v)) tags[k].push(v); }
  else if (tags[k] !== v) tags[k] = [tags[k], v];
}

async function readFlac(file, out) {
  let off = 0, h = await u8(file, 0, 10);
  if (h[0] === 0x49 && h[1] === 0x44 && h[2] === 0x33) { off = 10 + syncsafe(h, 6) + ((h[5] & 0x10) ? 10 : 0); h = await u8(file, off, off + 4); }
  if (String.fromCharCode(h[0], h[1], h[2], h[3]) !== 'fLaC') throw new Error('Not a FLAC file');
  off += 4;
  for (let i = 0; i < 256; i++) {
    const bh = await u8(file, off, off + 4);
    if (bh.length < 4) break;
    const last = bh[0] & 0x80, type = bh[0] & 0x7f, len = (bh[1] << 16) | (bh[2] << 8) | bh[3];
    off += 4;
    if (type === 0) {
      const b = await u8(file, off, off + len);
      out.sample_rate = (b[10] << 12) | (b[11] << 4) | (b[12] >> 4);
      out.channels = ((b[12] >> 1) & 7) + 1;
      out.bits = (((b[12] & 1) << 4) | (b[13] >> 4)) + 1;
      const total = (b[13] & 15) * 4294967296 + (((b[14] << 24) >>> 0) + (b[15] << 16) + (b[16] << 8) + b[17]);
      if (out.sample_rate && total) out.duration_ms = Math.round(total / out.sample_rate * 1000);
      const md5 = hex(b.subarray(18, 34));
      out.audio_md5 = /^0+$/.test(md5) ? null : md5;
    } else if (type === 4) {
      const b = await u8(file, off, off + len);
      const dv = new DataView(b.buffer), td = new TextDecoder();
      let p = 0; p += 4 + dv.getUint32(p, true);
      const n = dv.getUint32(p, true); p += 4;
      for (let k = 0; k < n && p + 4 <= b.length; k++) {
        const l = dv.getUint32(p, true); p += 4;
        const s = td.decode(b.subarray(p, p + l)); p += l;
        const e = s.indexOf('=');
        if (e > 0) addTag(out.tags, s.slice(0, e), s.slice(e + 1));
      }
    } else if (type === 6) {
      const b = await u8(file, off, off + Math.min(len, 65536));
      const dv = new DataView(b.buffer);
      const ptype = dv.getUint32(0), ml = dv.getUint32(4);
      const mime = new TextDecoder('latin1').decode(b.subarray(8, 8 + ml));
      let p = 8 + ml; const dl = dv.getUint32(p); p += 4 + dl + 16;
      const size = dv.getUint32(p); p += 4;
      if (!out.art || (ptype === 3 && out.artType !== 3)) { out.art = file.slice(off + p, off + p + size, mime || 'image/jpeg'); out.artType = ptype; }
    }
    off += len;
    if (last) break;
  }
  out.lossless = 1;
}

async function readId3(file, out) {
  const h = await u8(file, 0, 10);
  if (!(h[0] === 0x49 && h[1] === 0x44 && h[2] === 0x33)) return;
  const ver = h[3];
  if (ver < 3) return;
  const b = await u8(file, 10, 10 + syncsafe(h, 6));
  const dv = new DataView(b.buffer);
  let p = 0;
  if (h[5] & 0x40) p += ver === 4 ? syncsafe(b, 0) : dv.getUint32(0) + 4;
  const dec = (enc, d) => new TextDecoder(['latin1', 'utf-16', 'utf-16be', 'utf-8'][enc] || 'utf-8').decode(d);
  const MAP = { TIT2: 'TITLE', TPE1: 'ARTIST', TPE2: 'ALBUMARTIST', TALB: 'ALBUM', TRCK: 'TRACKNUMBER', TPOS: 'DISCNUMBER', TDRC: 'DATE', TYER: 'DATE', TCON: 'GENRE', TCOM: 'COMPOSER' };
  while (p + 10 <= b.length) {
    const id = String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const sz = ver === 4 ? syncsafe(b, p + 4) : dv.getUint32(p + 4);
    const f = b.subarray(p + 10, p + 10 + sz);
    p += 10 + sz;
    if (!f.length) continue;
    if (id === 'APIC') {
      const enc = f[0]; let q = 1;
      while (q < f.length && f[q]) q++;
      const mime = dec(0, f.subarray(1, q)); q++;
      const ptype = f[q++];
      if (enc === 1 || enc === 2) { while (q + 1 < f.length && (f[q] || f[q + 1])) q += 2; q += 2; } else { while (q < f.length && f[q]) q++; q++; }
      if (!out.art || (ptype === 3 && out.artType !== 3)) { out.art = new Blob([f.subarray(q)], { type: mime.includes('/') ? mime : 'image/' + (mime || 'jpeg').toLowerCase() }); out.artType = ptype; }
    } else if (id === 'TXXX') {
      const parts = dec(f[0], f.subarray(1)).split('\u0000').filter(Boolean);
      if (parts.length >= 2) addTag(out.tags, parts[0], parts[1]);
    } else if (id === 'USLT') {
      // enc, lang(3), descriptor\0, text
      const enc = f[0]; let q = 4;
      if (enc === 1 || enc === 2) { while (q + 1 < f.length && (f[q] || f[q + 1])) q += 2; q += 2; } else { while (q < f.length && f[q]) q++; q++; }
      addTag(out.tags, 'LYRICS', dec(enc, f.subarray(q)));
    } else if (MAP[id]) addTag(out.tags, MAP[id], dec(f[0], f.subarray(1)).split('\u0000')[0]);
  }
}

const first = (v) => (Array.isArray(v) ? v[0] : v) || null;
const num = (v) => { const n = parseInt(String(first(v) || ''), 10); return Number.isFinite(n) ? n : null; };
const total = (v) => { const m = /\/\s*(\d+)/.exec(String(first(v) || '')); return m ? Number(m[1]) : null; };
const fnum = (v) => { const n = parseFloat(String(first(v) || '')); return Number.isFinite(n) ? n : null; };

/** Read one file into the shape of a tracks row (minus ids/keys), plus `art` (Blob) if it has a cover. */
export async function readTrack(file) {
  const name = file.name || 'Untitled';
  const ext = (name.match(/\.([a-z0-9]+)$/i) || ['', ''])[1].toLowerCase();
  const out = { tags: {}, art: null, artType: -1, lossless: ext === 'flac' || ext === 'wav' ? 1 : 0, sample_rate: null, bits: null, channels: null, duration_ms: null, audio_md5: null };
  try {
    if (ext === 'flac') await readFlac(file, out);
    else if (ext === 'mp3') await readId3(file, out);
  } catch (e) { out.tags._error = String(e.message || e); }
  const t = out.tags;
  const base = name.replace(/\.[^.]+$/, '');
  const m = /^(?:(\d)[-.])?(\d{1,3})[\s._-]+(.+)$/.exec(base);
  const row = {
    filename: name, ext, size: file.size, mtime: file.lastModified || Date.now(),
    title: first(t.TITLE) || (m ? m[3].replace(/^-\s*/, '') : base),
    artist: first(t.ARTIST), album: first(t.ALBUM), albumartist: first(t.ALBUMARTIST) || first(t['ALBUM ARTIST']),
    track_no: num(t.TRACKNUMBER) ?? (m ? Number(m[2]) : null), track_total: num(t.TRACKTOTAL) ?? num(t.TOTALTRACKS) ?? total(t.TRACKNUMBER),
    disc_no: num(t.DISCNUMBER), disc_total: num(t.DISCTOTAL) ?? num(t.TOTALDISCS) ?? total(t.DISCNUMBER),
    year: (String(first(t.DATE) || first(t.YEAR) || '').match(/\d{4}/) || [null])[0],
    genre: first(t.GENRE), composer: first(t.COMPOSER),
    duration_ms: out.duration_ms, sample_rate: out.sample_rate, bits: out.bits, channels: out.channels,
    lossless: out.lossless, audio_md5: out.audio_md5,
    rg_track: fnum(t.REPLAYGAIN_TRACK_GAIN), rg_album: fnum(t.REPLAYGAIN_ALBUM_GAIN),
    mb_album: first(t.MUSICBRAINZ_ALBUMID), mb_track: first(t.MUSICBRAINZ_TRACKID),
    tags: JSON.stringify(t),
  };
  if (row.duration_ms && file.size && !row.bitrate) row.bitrate = Math.round(file.size * 8 / row.duration_ms);
  return { row, art: out.art };
}

/** Same rule as the Android scanner (Tags.albumKey). */
export function albumKey(albumartist, artist, album, root, folder) {
  const a = (album || '').trim();
  if (!a) return `\u001f/${root || ''}/${folder || ''}`;
  const who = (albumartist || '').trim() || (artist || '').trim();
  return `${who.toLowerCase()}\u001f${a.toLowerCase()}`;
}
