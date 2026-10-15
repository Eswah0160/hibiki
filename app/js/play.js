// Turning tracks into queue items and the common "play this" actions.
import * as native from './native.js';
import { titleOf, shuffle as shuffled } from './util.js';
import { toast } from './ui/dom.js';

export function item(t) {
  return {
    id: t.id, uri: t.uri, title: titleOf(t), artist: t.artist || t.albumartist || '', album: t.album || '',
    art: t.art_key || '', rgT: t.rg_track ?? null, rgA: t.rg_album ?? null, dur: t.duration_ms || 0,
  };
}

/** Random order that avoids the same artist twice in a row wherever the mix allows it. */
export function smartShuffle(list, key = (x) => x.artist || '') {
  const a = shuffled(list);
  for (let i = 1; i < a.length; i++) {
    const prev = key(a[i - 1]);
    if (!prev || key(a[i]) !== prev) continue;
    let j = i + 1;
    while (j < a.length && key(a[j]) === prev) j++;
    if (j < a.length) [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Whole albums in random order, each album's tracks in their own order. */
export function albumShuffle(tracks) {
  const groups = new Map();
  for (const t of tracks) {
    if (t.missing) continue;
    const k = t.album_key || `${t.root}/${t.folder}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }
  const albums = shuffled([...groups.values()]);
  for (const g of albums) g.sort((a, b) => (a.disc_no || 1) - (b.disc_no || 1) || (a.track_no || 0) - (b.track_no || 0));
  const list = albums.flat();
  if (!list.length) return toast('Nothing to play');
  native.setQueue(list.map(item), 0, 0, true);
  native.setShuffle(false);
  native.haptic('tick');
  toast(`Album shuffle · ${albums.length} album${albums.length === 1 ? '' : 's'}`, { ms: 1800 });
}

export function playTracks(tracks, start = 0, { shuffle = false } = {}) {
  const list = tracks.filter((t) => !t.missing);
  if (!list.length) return toast('Nothing to play');
  let items = list.map(item), idx = Math.max(0, Math.min(start, items.length - 1));
  if (shuffle) { items = smartShuffle(items); idx = 0; }
  native.setQueue(items, idx, 0, true);
  native.setShuffle(false);
  native.haptic('tick');
}

// Adding to the queue can be undone from the toast: the items went in at a known position.
function undoable(msg, at, n, wasEmpty) {
  toast(msg, {
    action: 'Undo', ms: 4500,
    onAction: () => {
      if (wasEmpty) return native.clearQueue();
      for (let k = 0; k < n; k++) native.removeFromQueue(at);
    },
  });
}

export function playNext(tracks) {
  const list = tracks.filter((t) => !t.missing);
  if (!list.length) return;
  const st = native.playerState();
  const empty = !(st.ids && st.ids.length);
  const at = empty ? 0 : Math.max(0, st.index ?? 0) + 1;
  native.addToQueue(list.map(item), true);
  undoable(list.length === 1 ? `Playing next: ${titleOf(list[0])}` : `${list.length} tracks play next`, at, list.length, empty);
}

export function enqueue(tracks) {
  const list = tracks.filter((t) => !t.missing);
  if (!list.length) return;
  const st = native.playerState();
  const empty = !(st.ids && st.ids.length);
  const at = empty ? 0 : st.ids.length;
  native.addToQueue(list.map(item), false);
  undoable(list.length === 1 ? `Added to queue: ${titleOf(list[0])}` : `Added ${list.length} tracks to queue`, at, list.length, empty);
}
