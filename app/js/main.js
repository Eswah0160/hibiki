// Boot: storage driver, migrations, screens, player, scanner, updates.
import { useDriver, nativeDriver, migrate, meta, setMeta } from './db.js';
import * as repo from './repo.js';
import { mount, state, go, queueRender, setBadge } from './ui/app.js';
import './ui/home.js';
import './ui/library.js';
import './ui/playlists.js';
import './ui/health.js';
import './ui/insights.js';
import './ui/guide.js';
import { applyTheme } from './ui/settings.js';
import { initPlayer } from './ui/player.js';
import { applyDsp } from './ui/eq.js';
import { initScan, startScan } from './ui/scan.js';
import { healthSnapshot } from './ui/health.js';
import { toast } from './ui/dom.js';
import * as native from './native.js';

window.addEventListener('error', (e) => toast('Error: ' + (e.message || e.error), { ms: 6000 }));
window.addEventListener('unhandledrejection', (e) => toast('Error: ' + (e.reason?.message || e.reason), { ms: 6000 }));

async function boot() {
  if (native.isNative) useDriver(nativeDriver(window.HibikiNative));
  else { const { devDriver } = await import('../dev/dev.js'); useDriver(await devDriver()); }
  migrate();
  if (!native.isNative && new URLSearchParams(location.search).has('demo') && !repo.hasLibrary()) {
    const { seedDemo } = await import('../dev/demo.js');
    seedDemo();
  }
  applyTheme();
  native.setReplayGain(meta('rg_mode', 'off'), Number(meta('rg_preamp', 0)));
  native.setAutoResume(meta('auto_resume', true));
  applyDsp();
  mount(document.getElementById('app'));
  initPlayer();
  if (native.isWeb) window.HibikiNative.restorePlayer();
  initScan();
  refreshBadges();
  native.bootOk();

  // A tag edit can rename an album (its key changes); follow it instead of showing "not found".
  document.addEventListener('hibiki:tags', (e) => {
    refreshBadges();
    if (state.route === 'album' && !repo.album(state.params.id)) {
      const t = repo.track(e.detail.ids[0]);
      if (t) go('album', t.album_key);
    }
  });

  // Rescan on launch when the last scan is over a day old (incremental, so it's quick).
  if (native.isNative && !native.isWeb && repo.hasLibrary() && !native.scanning()) {
    const last = meta('last_scan', 0);
    if (!last || Date.now() - last > 86400000) setTimeout(() => startScan(false), 1500);
    const lost = native.lostRoots();
    if (lost.length) toast(`Lost access to ${lost.length} music folder${lost.length === 1 ? '' : 's'}`, { action: 'Fix', onAction: () => go('settings'), ms: 8000 });
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { queueRender(); checkForUpdates(); } });
  checkForUpdates();
}

export function refreshBadges() {
  try { const h = healthSnapshot(); setBadge('health', h.high); } catch (e) { console.error(e); }
}

// Kura-style updates: on launch (and on return after 30 min) ask the update site for a newer UI.
const bootAt = Date.now();
let lastCheck = 0;
function checkForUpdates() {
  if (!native.isNative || native.isWeb || Date.now() - lastCheck < 30 * 60 * 1000) return;
  lastCheck = Date.now();
  native.checkUpdate().then(async (r) => {
    setMeta('last_update_check', new Date().toISOString());
    if (r.available) {
      const res = await native.applyUpdate();
      if (!res?.ok) return;
      if (Date.now() - bootAt < 8000 && !document.querySelector('.sheet') && !document.querySelector('.np')) native.reload();
      else toast(`Hibiki ${r.version} is ready`, { action: 'Reload', onAction: native.reload, ms: 10000 });
    }
    const today = new Date().toISOString().slice(0, 10);
    if (r.apkAvailable && meta('apk_prompted') !== today) {
      setMeta('apk_prompted', today);
      toast(`App update ${r.apkVersion}`, { action: 'Install', onAction: () => native.installApk(r.apkUrl), ms: 12000 });
    }
  }).catch(() => {});
}

boot().catch((e) => {
  document.getElementById('app').innerHTML = '<div class="page"><h2>Hibiki couldn’t start</h2><pre class="log"></pre></div>';
  document.querySelector('pre').textContent = String((e && e.stack) || e);
});
