// IndexedDB storage for the web app: the music files themselves, cover art, waveform shapes, and the
// SQLite database file. Everything stays in this browser on this device.
const NAME = 'hibiki-web';
const STORES = ['files', 'art', 'wave', 'kv'];
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open(NAME, 1);
    r.onupgradeneeded = () => { for (const s of STORES) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((res, rej) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => res(req && 'result' in req ? req.result : undefined);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error || new Error('Storage write was aborted (the device may be out of space)'));
  });
}

export const get = (store, key) => tx(store, 'readonly', (s) => s.get(key));
export const put = (store, key, value) => tx(store, 'readwrite', (s) => s.put(value, key));
export const del = (store, key) => tx(store, 'readwrite', (s) => s.delete(key));
export const keys = (store) => tx(store, 'readonly', (s) => s.getAllKeys());
export async function entries(store) {
  const db = await open();
  return new Promise((res, rej) => {
    const out = [];
    const t = db.transaction(store, 'readonly');
    const c = t.objectStore(store).openCursor();
    c.onsuccess = () => { const cur = c.result; if (cur) { out.push([cur.key, cur.value]); cur.continue(); } };
    t.oncomplete = () => res(out);
    t.onerror = () => rej(t.error);
  });
}

/** Ask the browser not to clear our storage under pressure (granted for Home Screen apps on iOS). */
export async function persist() {
  try { return navigator.storage?.persist ? await navigator.storage.persist() : false; } catch { return false; }
}
export async function estimate() {
  try { return navigator.storage?.estimate ? await navigator.storage.estimate() : null; } catch { return null; }
}
