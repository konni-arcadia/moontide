// Pure module for the Mixer view: the groups of a song as the Mixer draws them. It joins the groups that
// page/structure.js read (names of tracks, nested to any depth) to the strips of the Mixer model, and returns the tree
// of frames: each group with its fold state, its nesting level and the strips below it, then the strips no group names.
// It has no DOM access at import time, no copy and no state, and it walks the tree with an explicit stack (never by
// recursion), so a very deep structure cannot overflow the stack. node:test and page/mixer-model.js import it without a
// build step; page/mixer-view.js draws what the model builds from it.

import { SONG_GRID_DEEP_FROM, groupKey } from './song-grid-model.js';

/**
 * The layout of the Mixer for a read song, or null when the Mixer stays flat (the song is not read, or names no
 * group). `reading` is the result of readStructure, `strips` the strips of the Mixer model (each with `identity` and
 * `index`, the index readStructure gives its track) and `folds` a Set of the keys of folded groups. Returns
 * `{ items, groups }`:
 * - `items`: the top level in order, the groups in the song's order and then `{ kind: 'strip', identity }` for every
 *   strip no group names, in the order of `strips`;
 * - a group item is `{ kind: 'group', key, path, name, level, deep, open, members, items }`: its key (see groupKey),
 *   the names from the root, its level (1 at the top), `deep` (from level 5 on), `open` (its own fold state alone: a
 *   group inside a folded group is open but hidden with its parent's body), `members` (the identity of every strip below
 *   at any depth, in display order) and its own `items` in the order written (group items and strip items);
 * - `groups`: every group item in display order, the same objects as in the tree.
 * A track a group names that has no strip adds nothing, and a group with no strip is still a group.
 */
export function mixerLayout({ reading, strips, folds }) {
  if (reading === null || typeof reading !== 'object' || reading.state !== 'read') return null;
  if (!Array.isArray(reading.groups) || reading.groups.length === 0) return null;

  // Keys of these maps are names and indexes from the code, so they stay in Map and Set, never in object properties.
  const indexOfTrack = new Map();
  for (const track of reading.tracks) indexOfTrack.set(track.name, track.index);
  const stripOfIndex = new Map();
  for (const strip of strips) stripOfIndex.set(strip.index, strip.identity);

  const groups = [];
  const named = new Set();
  const items = [];
  const stack = [{ source: reading.groups.map((group) => ({ group })), index: 0, path: [], container: items }];
  // The group items open on the way down, root first: each strip found below them is one of their members.
  const open = [];
  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    if (frame.index >= frame.source.length) {
      stack.pop();
      if (stack.length > 0) open.pop();
      continue;
    }
    const entry = frame.source[frame.index];
    frame.index += 1;
    if (entry.track !== undefined) {
      const index = indexOfTrack.get(entry.track);
      if (index === undefined) continue;
      named.add(index);
      const identity = stripOfIndex.get(index);
      if (identity === undefined) continue;
      frame.container.push({ kind: 'strip', identity });
      for (const group of open) group.members.push(identity);
      continue;
    }
    const path = [...frame.path, entry.group.name];
    const key = groupKey(path);
    const level = path.length;
    const item = {
      kind: 'group',
      key,
      path,
      name: entry.group.name,
      level,
      deep: level >= SONG_GRID_DEEP_FROM,
      open: !folds.has(key),
      members: [],
      items: [],
    };
    frame.container.push(item);
    groups.push(item);
    open.push(item);
    stack.push({ source: entry.group.items, index: 0, path, container: item.items });
  }
  for (const strip of strips) {
    if (!named.has(strip.index)) items.push({ kind: 'strip', identity: strip.identity });
  }
  return { items, groups };
}

/**
 * What a click on a group's mute and solo buttons does, from the strips below the group. `group` is a group item of
 * mixerLayout (its `members` are the identities of the strips below it at any depth, in display order) and
 * `stripsByIdentity` a Map from identity to the strip of the Mixer model. Returns `{ mute, solo, skipped }`.
 * For each kind, `mute` and `solo` hold:
 * - `identities`: the strips that kind can reach, in display order: the strip is editable and its own button for that
 *   kind is not off. Only these are counted and written;
 * - `n` and `k`: how many are reachable and how many of them are pressed (muted, or soloed);
 * - `pressed`: false for none (or nothing reachable), true for all, 'mixed' for some;
 * - `on`: what a click writes, true unless every reachable track is already pressed.
 * `skipped` counts the members that mute or solo cannot reach, each once. The module holds no copy and no state.
 */
export function groupActions(group, stripsByIdentity) {
  const strips = group.members.map((identity) => stripsByIdentity.get(identity)).filter((strip) => strip !== undefined);
  const action = (kind) => {
    const reachable = strips.filter((strip) => strip.editable === true && strip[kind].disabled === false);
    const n = reachable.length;
    const k = reachable.filter((strip) => strip[kind].pressed === true).length;
    return {
      identities: reachable.map((strip) => strip.identity),
      n,
      k,
      pressed: n === 0 || k === 0 ? false : k === n ? true : 'mixed',
      on: !(k === n && n > 0),
    };
  };
  const mute = action('mute');
  const solo = action('solo');
  const reachedByBoth = new Set(mute.identities.filter((identity) => solo.identities.includes(identity)));
  return { mute, solo, skipped: strips.filter((strip) => !reachedByBoth.has(strip.identity)).length };
}
