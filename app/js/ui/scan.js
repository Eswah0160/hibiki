// Library scan status: a banner that updates in place, and the toast when a scan finishes.
import { html, icon, toast, $ } from './dom.js';
import { queueRender } from './app.js';
import * as native from '../native.js';
import { setMeta } from '../db.js';
import { invalidateHealth, healthSnapshot } from './health.js';

let status = { phase: 'idle' };
let lastRefresh = 0;

export function initScan() {
  status = native.scanStatus();
  native.onScan((s) => {
    status = s;
    const b = $('#scanbanner');
    if (b) b.outerHTML = String(scanBanner());
    // The scanner writes straight to SQLite; refresh views now and then while it runs, and at the end.
    if (s.phase === 'reading' && Date.now() - lastRefresh > 4000) { lastRefresh = Date.now(); invalidateHealth(); queueRender(); }
    if (s.phase === 'done') {
      setMeta('last_scan', s.at || Date.now());
      invalidateHealth();
      healthSnapshot();
      queueRender();
      const bits = [];
      if (s.added) bits.push(`${s.added} new`);
      if (s.updated) bits.push(`${s.updated} updated`);
      if (s.missing) bits.push(`${s.missing} missing`);
      toast(bits.length ? `Library updated: ${bits.join(', ')}` : 'Library is up to date');
      if (s.unreadable) toast(`${s.unreadable} folder${s.unreadable === 1 ? '' : 's'} couldn’t be opened — check Settings › Music folders`, { ms: 6000 });
    }
    if (s.phase === 'error') toast('Scan failed: ' + s.error, { ms: 6000 });
  });
}

export function startScan(force = false) {
  if (!native.isNative) return toast('Scanning works on the phone. The browser preview uses demo data.');
  const r = native.scan(force);
  if (!r.started) toast('A scan is already running');
  else { status = { phase: 'walking', done: 0, total: 0 }; const b = $('#scanbanner'); if (b) b.outerHTML = String(scanBanner()); else queueRender(); }
}

export function scanBanner() {
  const s = status;
  if (s.phase !== 'walking' && s.phase !== 'reading') return html`<div id="scanbanner" hidden></div>`;
  const pct = s.total ? Math.round((s.done / s.total) * 100) : 0;
  return html`<div id="scanbanner" class="banner scan">${icon('refresh')}<div class="grow">
    <div>${s.phase === 'walking' ? `Finding music… ${s.total ? s.total.toLocaleString('en-AU') + ' files' : ''}` : `Reading tags ${s.done.toLocaleString('en-AU')} / ${s.total.toLocaleString('en-AU')}`}</div>
    ${s.phase === 'reading' ? html`<div class="pbar"><i style="width:${pct}%"></i></div><div class="tiny muted ellipsis">${s.current || ''}</div>` : ''}
  </div></div>`;
}

export const isScanning = () => status.phase === 'walking' || status.phase === 'reading';
