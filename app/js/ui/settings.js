// Settings: music folders, scanning, playback, appearance, data, updates.
import { registerScreen, queueRender, go } from './app.js';
import { html, icon, confirmDlg, toast } from './dom.js';
import * as repo from '../repo.js';
import { db, meta, setMeta } from '../db.js';
import * as native from '../native.js';
import { startScan, isScanning } from './scan.js';
import { invalidateHealth } from './health.js';
import { plural, ago, bytes } from '../util.js';

export async function addRoot(opts = {}) {
  if (!native.isNative) return toast('Folder access works in the Android app. The browser preview runs on demo data.');
  try {
    const r = await native.pickFolder(opts);
    if (r.cancelled) return;
    toast(native.isWeb ? `Copying ${r.name} into Hibiki…` : `Added ${r.name} — scanning…`);
    queueRender();
    startScan(false);
  } catch (e) { toast('Couldn’t add folder: ' + e.message, { ms: 6000 }); }
}

const THEMES = [
  ['system', 'System', ['#E7E7E4', '#111110', '#BD3226']],
  ['light', 'Light', ['#E7E7E4', '#262625', '#BD3226']],
  ['dark', 'Dark', ['#111110', '#E7E7E3', '#FF6B5E']],
  ['yuya', 'Yuya', ['#ECE5D8', '#5F6B66', '#A9533C']],
  ['yuya-night', 'Yuya night', ['#1C1A17', '#A3A79C', '#C9765A']],
];

export function applyTheme() {
  const t = meta('theme', 'system');
  if (t === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
  // Colour Android's status / navigation bar area to match, with readable icons.
  const cs = getComputedStyle(document.documentElement);
  native.setSystemBars(cs.getPropertyValue('--paper').trim(), cs.colorScheme !== 'dark');
}
if (typeof window !== 'undefined' && window.matchMedia) {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => { if (meta('theme', 'system') === 'system') applyTheme(); });
}

registerScreen('settings', {
  top: () => ({ back: true, title: 'Settings', noSettings: true, noSearch: true }),
  render(el) {
    const roots = repo.roots();
    const lost = new Set(native.lostRoots());
    const counts = new Map(db.all('SELECT root, COUNT(*) n, SUM(size) b FROM tracks WHERE missing=0 GROUP BY root').map((r) => [r.root, r]));
    const s = repo.stats();
    const inf = native.info();
    const rg = meta('rg_mode', 'off'), pre = meta('rg_preamp', 0), theme = meta('theme', 'system');
    el.innerHTML = String(html`<div class="page narrow">
      ${native.isWeb ? webMusic(s) : html`<div class="sectionlabel"><span>Music folders</span></div>
      <div class="card">
        ${roots.map((r) => html`<div class="item">${icon('folder')}<div class="grow"><div class="title ellipsis">${r.name}</div>
          <div class="sub">${lost.has(r.uri) ? html`<span class="neg">Access lost — remove and add it again</span>` : `${plural(counts.get(r.uri)?.n || 0, 'track')} · ${bytes(counts.get(r.uri)?.b || 0)}`}</div></div>
          <button class="iconbtn sm" data-act="rmroot" data-uri="${r.uri}" aria-label="Remove folder">${icon('trash')}</button></div>`)}
        <button class="item tap" data-act="addroot">${icon('plus')}<div class="grow"><div class="title">Add folder</div><div class="sub">Hibiki asks for read + write so tag edits can be saved into the files.</div></div></button>
      </div>
      <div class="row gap wrap" style="margin:4px 0 6px">
        <button class="btn" data-act="scan" ${roots.length ? '' : 'disabled'}>${icon('refresh')} Rescan</button>
        <button class="btn" data-act="fullscan" ${roots.length ? '' : 'disabled'}>Full rescan</button>
      </div>
      <p class="tiny muted">${isScanning() ? 'Scanning now…' : `Last scan ${ago(meta('last_scan', 0))}.`} Rescan only reads new or changed files; a full rescan re-reads everything.</p>`}

      <div class="sectionlabel"><span>Playback</span></div>
      <div class="card"><div class="card-b">
        <div class="field"><label>ReplayGain (volume levelling)</label>
          <div class="seg">${[['off', 'Off'], ['track', 'Track'], ['album', 'Album']].map(([k, l]) => html`<button class="${rg === k ? 'on' : ''}" data-act="rg" data-k="${k}">${l}</button>`)}</div></div>
        <div class="field"><label>Pre-amp</label>
          <div class="seg">${[0, -3, -6].map((v) => html`<button class="${Number(pre) === v ? 'on' : ''}" data-act="pre" data-v="${v}">${v === 0 ? '0 dB' : v + ' dB'}</button>`)}</div></div>
        ${native.isWeb ? html`<p class="tiny muted">On iPhone the volume buttons control loudness; ReplayGain and the sleep fade apply in desktop browsers only.</p>` : ''}
        <p class="tiny muted">Uses REPLAYGAIN tags in your files (add them with foobar2000, beets or rsgain). Album mode keeps loud and quiet songs of an album in proportion. Android can only turn audio down, so tracks with positive gain play at full volume.</p>
        ${native.isWeb ? '' : html`<label class="row between"><span>Resume when headphones reconnect<div class="tiny muted">If unplugging (or a Bluetooth / USB DAC dropping out) paused the music, it carries on when it's back within 15 min.</div></span><span class="toggle"><input type="checkbox" data-act="autoresume" ${meta('auto_resume', true) ? 'checked' : ''}><span></span></span></label>`}
        <label class="row between"><span>Keep screen on in Now Playing</span><span class="toggle"><input type="checkbox" data-act="awake" ${meta('np_keep_awake', false) ? 'checked' : ''}><span></span></span></label>
      </div></div>

      <div class="sectionlabel"><span>Appearance</span></div>
      <div class="card"><div class="card-b"><div class="themes">${THEMES.map(([k, l, sw]) => html`<button class="${theme === k ? 'on' : ''}" data-act="theme" data-k="${k}" aria-pressed="${theme === k}"><span class="sw" aria-hidden="true">${sw.map((c) => html`<i style="background:${c}"></i>`)}</span><span class="l">${l}</span></button>`)}</div>
        <p class="tiny muted" style="margin:10px 0 0">${theme === 'yuya' ? 'Yuya 湯屋: washi paper, soft ink, lantern red and evening-water green. Calm and low-contrast.' : theme === 'yuya-night' ? 'Yuya night 湯屋・夜: the same palette after dark, warm umber with dimmed paper-coloured text. Nothing is pure white or pure black.' : theme === 'system' ? 'Follows your phone’s light or dark setting.' : ''}</p></div></div>

      <div class="sectionlabel"><span>Library data</span></div>
      <div class="card">
        <button class="item tap" data-act="csv">${icon('download')}<div class="grow"><div class="title">Export library as CSV</div><div class="sub">Every track with tags and quality, to Downloads/Hibiki</div></div></button>
        <button class="item tap" data-act="rmmissing" ${s.missing ? '' : 'disabled'}>${icon('trash')}<div class="grow"><div class="title">Remove missing tracks</div><div class="sub">${s.missing ? plural(s.missing, 'track') + ' no longer on disk' : 'None'}</div></div></button>
        <button class="item tap" data-act="clearplays">${icon('chart')}<div class="grow"><div class="title">Clear listening history</div><div class="sub">${plural(s.plays, 'play')} recorded</div></div></button>
      </div>

      <div class="sectionlabel"><span>Help</span></div>
      <div class="card">
        <button class="item tap" data-act="guide">${icon('info')}<div class="grow"><div class="title">Guide</div><div class="sub">What rate, depth, bitrate, ReplayGain, EQ and every other setting mean — and how they affect your music</div></div></button>
      </div>

      <div class="sectionlabel"><span>About</span></div>
      <div class="card">
        <div class="item"><span class="fic">${icon('wave')}</span><div class="grow"><div class="title">Hibiki 響き</div><div class="sub">App ${inf.appVersion} · UI ${inf.webVersion} (${inf.webSource})</div></div></div>
        <button class="item tap" data-act="update">${icon('refresh')}<div class="grow"><div class="title">Check for updates</div><div class="sub">Last checked ${ago(meta('last_update_check') ? Date.parse(meta('last_update_check')) : 0)}</div></div></button>
        <div class="item small ink2">Hibiki plays and organises music files you already have. It reads only the folders you pick, stores its database on this phone, and only goes online for updates and the MusicBrainz / Cover Art Archive lookups you start.</div>
      </div>
    </div>`);
  },
  async on(act, el) {
    switch (act) {
      case 'addroot': return addRoot();
      case 'adddir': return addRoot({ directory: true });
      case 'rmroot': {
        const r = repo.roots().find((x) => x.uri === el.dataset.uri);
        if (!(await confirmDlg(native.isWeb ? 'Remove all music from Hibiki on this device? The copies stored in the app are deleted, playlists and history stay.' : `Stop using “${r?.name}”? Its tracks leave the library (the files stay where they are).`, { ok: 'Remove', danger: true }))) return null;
        native.removeRoot(el.dataset.uri);
        if (!native.isNative) db.run('DELETE FROM roots WHERE uri=?', [el.dataset.uri]);
        invalidateHealth(); queueRender(); return null;
      }
      case 'scan': return startScan(false);
      case 'fullscan': return startScan(true);
      case 'rg': setMeta('rg_mode', el.dataset.k); native.setReplayGain(el.dataset.k, Number(meta('rg_preamp', 0))); return queueRender();
      case 'pre': setMeta('rg_preamp', Number(el.dataset.v)); native.setReplayGain(meta('rg_mode', 'off'), Number(el.dataset.v)); return queueRender();
      case 'awake': setMeta('np_keep_awake', el.checked); return null;
      case 'autoresume': setMeta('auto_resume', el.checked); native.setAutoResume(el.checked); return null;
      case 'theme': setMeta('theme', el.dataset.k); applyTheme(); return queueRender();
      case 'csv': return exportCsv();
      case 'rmmissing':
        if (await confirmDlg('Remove tracks whose files are gone? Their play history goes too.', { ok: 'Remove', danger: true })) { repo.removeMissing(); invalidateHealth(); toast('Removed'); }
        return null;
      case 'clearplays':
        if (await confirmDlg('Delete all listening history? Insights start again from zero.', { ok: 'Delete', danger: true })) { db.run('DELETE FROM plays'); toast('Listening history cleared'); }
        return null;
      case 'update': return checkUpdateNow();
      case 'guide': return go('guide');
      default: return null;
    }
  },
});

async function checkUpdateNow() {
  if (native.isWeb) { toast('Checking…'); await native.checkUpdate().catch(() => {}); setMeta('last_update_check', new Date().toISOString()); queueRender(); return setTimeout(() => { if (!document.querySelector('.toast')) toast('You’re up to date'); }, 1500); }
  if (!native.isNative) return toast('Updates apply to the Android app');
  toast('Checking…');
  try {
    const r = await native.checkUpdate();
    setMeta('last_update_check', new Date().toISOString());
    if (r.available) {
      const res = await native.applyUpdate();
      if (res?.ok) toast(`Hibiki ${r.version} is ready`, { action: 'Reload', onAction: native.reload, ms: 10000 });
    } else if (r.apkAvailable) {
      toast(`App update ${r.apkVersion}`, { action: 'Install', onAction: () => native.installApk(r.apkUrl), ms: 12000 });
    } else toast(r.reason === 'needs app update' ? 'A new UI needs an app update first' : 'You’re up to date');
    queueRender();
  } catch (e) { toast('Update check failed: ' + e.message); }
}

function exportCsv() {
  const cols = ['artist', 'albumartist', 'album', 'year', 'disc_no', 'track_no', 'title', 'genre', 'ext', 'bits', 'sample_rate', 'bitrate', 'duration_ms', 'size', 'folder', 'filename', 'audio_md5'];
  const q = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const rows = db.all(`SELECT ${cols.join(',')}, (SELECT COUNT(*) FROM plays p WHERE p.track_id=tracks.id) plays FROM tracks WHERE missing=0 ORDER BY artist, album, disc_no, track_no`);
  const csv = [[...cols, 'plays'].join(','), ...rows.map((r) => [...cols, 'plays'].map((c) => q(r[c])).join(','))].join('\n');
  const r = native.saveFile(`hibiki-library-${new Date().toISOString().slice(0, 10)}.csv`, 'text/csv', csv);
  toast(r.ok ? (native.isWeb ? `Exported ${plural(rows.length, 'track')}` : `Saved ${plural(rows.length, 'track')} to Downloads/Hibiki`) : 'Could not save');
}

let storageNote = null;
function webMusic(s) {
  if (storageNote === null) {
    storageNote = '';
    native.storageInfo().then((e) => { if (e && e.quota) { storageNote = `${bytes(e.usage || 0)} used of about ${bytes(e.quota)} available to Hibiki.`; queueRender(); } });
  }
  const dirOk = 'webkitdirectory' in document.createElement('input') && !/iPhone|iPad|iPod/.test(navigator.userAgent);
  return html`<div class="sectionlabel"><span>Music on this device</span></div>
    <div class="card">
      <div class="item">${icon('folder')}<div class="grow"><div class="title">${plural(s.tracks || 0, 'track')}</div><div class="sub">${storageNote || 'Stored inside Hibiki in this browser'}</div></div>
        ${repo.roots().length ? html`<button class="iconbtn sm" data-act="rmroot" data-uri="web:library" aria-label="Remove all music">${icon('trash')}</button>` : ''}</div>
      <button class="item tap" data-act="addroot">${icon('plus')}<div class="grow"><div class="title">Add music files</div><div class="sub">Pick songs or a whole album from Files. Hibiki keeps its own copy so they play offline.</div></div></button>
      ${dirOk ? html`<button class="item tap" data-act="adddir">${icon('folder')}<div class="grow"><div class="title">Add a folder</div><div class="sub">Everything inside, including cover.jpg files</div></div></button>` : ''}
    </div>
    <p class="tiny muted">Add Hibiki to your Home Screen (Share › Add to Home Screen) so iOS keeps this storage. Tag editing needs the Android app; here tags are read only.</p>
    <div class="row gap wrap" style="margin:4px 0 6px"><button class="btn" data-act="fullscan" ${s.tracks ? '' : 'disabled'}>${icon('refresh')} Re-read tags</button></div>`;
}
