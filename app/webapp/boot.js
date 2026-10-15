// Web app entry (iPhone / any modern browser): set up the browser bridge, then start the normal UI.
import { createBridge } from './bridge.js';

function loadScript(src) {
  return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('Could not load ' + src)); document.head.append(s); });
}

async function start() {
  await loadScript('vendor/sql-wasm.js');
  window.HibikiNative = await createBridge({ base: '.' });
  const { toast } = await import('../js/ui/dom.js');
  window.__hibikiToast = (m) => toast(m, { ms: 6000 });
  await import('../js/main.js');

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    try {
      const reg = await navigator.serviceWorker.register('sw.js');
      // A new version was downloaded in the background: offer to switch to it.
      // Only reload when the person asked for the new version (never on the very first install, which
      // would interrupt someone in the middle of adding music).
      let wantReload = false;
      const offer = (w) => w && toast('A new version of Hibiki is ready', { action: 'Reload', ms: 12000, onAction: () => { wantReload = true; w.postMessage('skipWaiting'); } });
      if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        w?.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) offer(w); });
      });
      navigator.serviceWorker.addEventListener('controllerchange', () => { if (wantReload) { wantReload = false; location.reload(); } });
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
    } catch (e) { console.warn('Service worker failed', e); }
  }
}

start().catch((e) => {
  document.getElementById('app').innerHTML = '<div class="page"><h2>Hibiki couldn’t start</h2><pre class="log"></pre></div>';
  document.querySelector('pre').textContent = String((e && e.stack) || e);
});
