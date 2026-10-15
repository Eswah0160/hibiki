// Versioned migrations. Each entry is a list of single SQL statements (the Android bridge executes one
// statement per call). Never edit a shipped migration — append a new one.
//
// NATIVE_DDL is ALSO run by Db.java, because the library scanner and the playback service write those
// tables while the UI may never have started. Keep the strings identical (tests/schema.test.mjs checks).

export const NATIVE_DDL = [
  `CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT)`,
  `CREATE TABLE IF NOT EXISTS roots(uri TEXT PRIMARY KEY, name TEXT, added_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS tracks(id INTEGER PRIMARY KEY AUTOINCREMENT, uri TEXT NOT NULL UNIQUE, root TEXT, folder TEXT, filename TEXT, ext TEXT, size INTEGER, mtime INTEGER, title TEXT, artist TEXT, album TEXT, albumartist TEXT, track_no INTEGER, track_total INTEGER, disc_no INTEGER, disc_total INTEGER, year TEXT, genre TEXT, composer TEXT, duration_ms INTEGER, sample_rate INTEGER, bits INTEGER, channels INTEGER, bitrate INTEGER, lossless INTEGER NOT NULL DEFAULT 0, audio_md5 TEXT, art_key TEXT, art_w INTEGER, art_h INTEGER, art_src TEXT, rg_track REAL, rg_album REAL, mb_album TEXT, mb_track TEXT, tags TEXT, album_key TEXT, added_at INTEGER, scanned_at INTEGER, missing INTEGER NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS ix_tracks_album ON tracks(album_key)`,
  `CREATE INDEX IF NOT EXISTS ix_tracks_artist ON tracks(artist)`,
  `CREATE TABLE IF NOT EXISTS plays(id INTEGER PRIMARY KEY AUTOINCREMENT, track_id INTEGER NOT NULL, at INTEGER NOT NULL, ms INTEGER NOT NULL, done INTEGER NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS ix_plays_track ON plays(track_id)`,
  `CREATE INDEX IF NOT EXISTS ix_plays_at ON plays(at)`,
];

export const MIGRATIONS = [
  [
    ...NATIVE_DDL,
    `CREATE TABLE playlists(id INTEGER PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'manual', rules TEXT, note TEXT, created_at INTEGER, updated_at INTEGER)`,
    `CREATE TABLE playlist_items(id INTEGER PRIMARY KEY, playlist_id INTEGER NOT NULL, track_id INTEGER NOT NULL, pos INTEGER NOT NULL, added_at INTEGER)`,
    `CREATE INDEX ix_pli ON playlist_items(playlist_id, pos)`,
    `CREATE TABLE stars(track_id INTEGER PRIMARY KEY, at INTEGER)`,
    `CREATE TABLE health_ignore(key TEXT PRIMARY KEY, at INTEGER)`,
  ],
];
