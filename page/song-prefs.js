// Pure module for Moontide's browser page: which groups of the Song grid are folded, remembered in this browser. The
// state is one stored value, a JSON list of group paths (each path is the list of group names from the root down), so a
// group name is only ever data and never a key of an object. Reading validates everything and never throws: a value that
// cannot be read gives no folded group and says so, and a storage that is blocked says that instead. No DOM access at
// import time, so node:test and page/main.js import it without a build step.

/** The browser-storage key of the folded groups. */
export const SONG_FOLDS_KEY = 'moontide.songFolds';
/** The most folded groups that are remembered; a longer stored list is refused, and a longer one to write keeps the newest. */
export const MAX_SONG_FOLDS = 500;
/** The longest name a stored path may hold, in characters. */
const MAX_NAME_LENGTH = 200;
/** The longest stored text that is read, in characters. */
const MAX_STORED_LENGTH = 64000;

/** The sentence logged once when the stored fold state cannot be read. */
export const SONG_FOLDS_COPY = Object.freeze({
  badStored: `Moontide: the stored fold state under '${SONG_FOLDS_KEY}' cannot be read; every group starts open.`,
  // Said once per page session when a group is folded that cannot be remembered.
  notRemembered: `Moontide: a group whose name is longer than ${MAX_NAME_LENGTH} characters folds on this page but is not remembered after a reload.`,
});

/** True for a path that may be stored: a non-empty list of non-empty names, each short enough. */
function isPath(path) {
  return (
    Array.isArray(path) &&
    path.length > 0 &&
    path.every((name) => typeof name === 'string' && name.length > 0 && name.length <= MAX_NAME_LENGTH)
  );
}

/** True when `key` (a group key, the JSON text of a path) is one writeSongFolds keeps: a fold that is not is not remembered. */
export function isRememberable(key) {
  let path;
  try {
    path = JSON.parse(key);
  } catch {
    return false;
  }
  return isPath(path);
}

/**
 * Reads the folded groups from `storage` (a Storage-like object, or null): `{ value, available, rejected }`. `value` is the
 * list of group keys (JSON text of a path, as page/song-grid-model.js groupKey makes them). `rejected` is true when a value
 * was stored and refused (not JSON, not a list, more than MAX_SONG_FOLDS paths, longer than 64000 characters, or a path
 * that is not a non-empty list of non-empty names of at most 200 characters); then `value` is empty. `available` is false
 * when the storage is missing or its read throws. Never throws.
 */
export function readSongFolds(storage) {
  let raw;
  try {
    raw = storage ? storage.getItem(SONG_FOLDS_KEY) : undefined;
  } catch {
    return { value: [], available: false, rejected: false };
  }
  if (raw === undefined) return { value: [], available: false, rejected: false };
  if (raw === null) return { value: [], available: true, rejected: false };
  const refused = { value: [], available: true, rejected: true };
  if (typeof raw !== 'string' || raw.length > MAX_STORED_LENGTH) return refused;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return refused;
  }
  if (!Array.isArray(parsed) || parsed.length > MAX_SONG_FOLDS || !parsed.every(isPath)) return refused;
  return { value: parsed.map((path) => JSON.stringify(path)), available: true, rejected: false };
}

/**
 * Writes the folded groups (a list of group keys) to `storage`: returns true when written and false, never throwing, when
 * the storage is missing or refuses. A group the reader would refuse (a name over 200 characters) is folded in the page
 * but not remembered, and the newest MAX_SONG_FOLDS are kept, so what is written can always be read back.
 */
export function writeSongFolds(storage, keys) {
  if (!storage) return false;
  let paths = [];
  for (const key of keys) {
    let path;
    try {
      path = JSON.parse(key);
    } catch {
      continue;
    }
    if (isPath(path)) paths.push(path);
  }
  paths = paths.slice(-MAX_SONG_FOLDS);
  let text = JSON.stringify(paths);
  while (text.length > MAX_STORED_LENGTH && paths.length > 0) {
    paths = paths.slice(1);
    text = JSON.stringify(paths);
  }
  try {
    storage.setItem(SONG_FOLDS_KEY, text);
    return true;
  } catch {
    return false;
  }
}
