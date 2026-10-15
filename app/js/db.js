// Thin synchronous SQL layer. On the phone the driver is the Android bridge
// (window.HibikiNative, backed by the app's private SQLite file). In a desktop
// browser / tests it is sql.js (see dev/sqljs-driver.js).
import { MIGRATIONS } from './schema.js';

let driver = null;
let version = 0;
let depth = 0;
const listeners = new Set();

export function nativeDriver(N) {
  const call = (fn, ...a) => {
    const r = JSON.parse(N[fn](...a));
    if (r.error) throw new Error(r.error);
    return r;
  };
  return {
    kind: 'native',
    all: (sql, params) => call('query', sql, JSON.stringify(params || [])).rows,
    run: (sql, params) => call('exec', sql, JSON.stringify(params || [])),
    begin: () => call('begin'),
    commit: () => call('commit'),
    rollback: () => call('rollback'),
  };
}

export function useDriver(d) { driver = d; }
export function driverKind() { return driver?.kind || 'none'; }

export const db = {
  all(sql, params = []) { return driver.all(sql, params); },
  get(sql, params = []) { return driver.all(sql, params)[0] || null; },
  val(sql, params = []) { const r = driver.all(sql, params)[0]; return r ? Object.values(r)[0] : null; },
  run(sql, params = []) { const r = driver.run(sql, params); touch(); return r; },
  insert(table, obj) {
    const keys = Object.keys(obj);
    const r = driver.run(`INSERT INTO ${table}(${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, keys.map((k) => obj[k]));
    touch();
    return r.lastId;
  },
  update(table, id, obj) {
    const keys = Object.keys(obj);
    if (!keys.length) return;
    driver.run(`UPDATE ${table} SET ${keys.map((k) => k + '=?').join(',')} WHERE id=?`, [...keys.map((k) => obj[k]), id]);
    touch();
  },
  tx(fn) {
    if (depth > 0) { depth++; try { return fn(); } finally { depth--; } } // nested: join outer tx
    driver.begin();
    depth = 1;
    let out;
    try { out = fn(); depth = 0; driver.commit(); } catch (e) { depth = 0; try { driver.rollback(); } catch {} throw e; }
    touch();
    return out;
  },
  get version() { return version; },
  onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
};

let pending = false;
function touch() {
  version++;
  if (pending) return;
  pending = true;
  queueMicrotask(() => { pending = false; for (const fn of listeners) try { fn(version); } catch (e) { console.error(e); } });
}

export function meta(key, fallback = null) {
  const r = db.get('SELECT value FROM meta WHERE key=?', [key]);
  if (!r) return fallback;
  try { return JSON.parse(r.value); } catch { return r.value; }
}
export function setMeta(key, value) {
  db.run('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [key, JSON.stringify(value)]);
}

export function migrate() {
  driver.run('CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT)', []);
  const cur = Number(meta('schema_version', 0));
  for (let v = cur; v < MIGRATIONS.length; v++) {
    db.tx(() => {
      for (const stmt of MIGRATIONS[v]) driver.run(stmt, []);
      setMeta('schema_version', v + 1);
    });
  }
  return MIGRATIONS.length;
}
