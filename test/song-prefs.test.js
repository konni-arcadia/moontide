// The remembered fold state of the Song grid, tested against fake storages: what is read back, what is refused and the
// two ways a storage can fail. Nothing here touches a browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_SONG_FOLDS, SONG_FOLDS_COPY, SONG_FOLDS_KEY, isRememberable, readSongFolds, writeSongFolds } from '../page/song-prefs.js';
import { groupKey } from '../page/song-grid-model.js';

function fakeStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
  };
}

test('the key is the documented one and the limit is 500 paths', () => {
  assert.equal(SONG_FOLDS_KEY, 'moontide.songFolds');
  assert.equal(MAX_SONG_FOLDS, 500);
  assert.match(SONG_FOLDS_COPY.badStored, /moontide\.songFolds/);
});

test('nothing stored reads as no fold, available and not rejected', () => {
  assert.deepEqual(readSongFolds(fakeStorage()), { value: [], available: true, rejected: false });
});

test('a valid stored list gives the group keys of its paths, in order', () => {
  const storage = fakeStorage({ [SONG_FOLDS_KEY]: JSON.stringify([['drums'], ['rhythm', 'drums'], ['a "quoted" name']]) });
  assert.deepEqual(readSongFolds(storage), {
    value: [groupKey(['drums']), groupKey(['rhythm', 'drums']), groupKey(['a "quoted" name'])],
    available: true,
    rejected: false,
  });
  assert.deepEqual(readSongFolds(fakeStorage({ [SONG_FOLDS_KEY]: '[]' })), { value: [], available: true, rejected: false });
});

test('a stored value that cannot be read is refused with an empty list: text, shape, size and every path rule', () => {
  const refused = { value: [], available: true, rejected: true };
  const cases = {
    'not JSON': '{oops',
    'an object': JSON.stringify({ drums: true }),
    'a number': '3',
    'a path that is a string': JSON.stringify(['drums']),
    'an empty path': JSON.stringify([[]]),
    'a path holding a number': JSON.stringify([['drums', 4]]),
    'a path holding an empty name': JSON.stringify([['drums', '']]),
    'a path holding an object': JSON.stringify([[{ name: 'drums' }]]),
    'a name over 200 characters': JSON.stringify([['n'.repeat(201)]]),
    'more than 500 paths': JSON.stringify(Array.from({ length: 501 }, (_, i) => [`g${i}`])),
    'a text over 64000 characters': JSON.stringify([['n'.repeat(200)]]) + ' '.repeat(64000),
  };
  for (const [name, text] of Object.entries(cases)) {
    assert.deepEqual(readSongFolds(fakeStorage({ [SONG_FOLDS_KEY]: text })), refused, name);
  }
  assert.deepEqual(readSongFolds(fakeStorage({ [SONG_FOLDS_KEY]: JSON.stringify(Array.from({ length: 500 }, (_, i) => [`g${i}`])) })).rejected, false, '500 paths are allowed');
  assert.equal(readSongFolds(fakeStorage({ [SONG_FOLDS_KEY]: JSON.stringify([['n'.repeat(200)]]) })).rejected, false, 'a name of 200 characters is allowed');
});

test('a hostile name is only data: it never becomes a key of anything', () => {
  const storage = fakeStorage({ [SONG_FOLDS_KEY]: JSON.stringify([['__proto__'], ['constructor', 'toString']]) });
  const read = readSongFolds(storage);
  assert.deepEqual(read.value, ['["__proto__"]', '["constructor","toString"]']);
  assert.equal(Object.keys(read).sort().join(','), 'available,rejected,value');
});

test('a storage that is missing or throws is not available and never throws', () => {
  assert.deepEqual(readSongFolds(null), { value: [], available: false, rejected: false });
  const throwing = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
  assert.deepEqual(readSongFolds(throwing), { value: [], available: false, rejected: false });
  assert.equal(writeSongFolds(throwing, [groupKey(['drums'])]), false);
  assert.equal(writeSongFolds(null, [groupKey(['drums'])]), false);
});

test('writing stores a list of paths that reads back, never an object keyed by names', () => {
  const storage = fakeStorage();
  assert.equal(writeSongFolds(storage, [groupKey(['drums']), groupKey(['rhythm', 'drums'])]), true);
  assert.equal(storage.data.get(SONG_FOLDS_KEY), '[["drums"],["rhythm","drums"]]');
  assert.deepEqual(readSongFolds(storage).value, [groupKey(['drums']), groupKey(['rhythm', 'drums'])]);
  assert.equal(writeSongFolds(storage, []), true);
  assert.equal(storage.data.get(SONG_FOLDS_KEY), '[]');
});

test('writing keeps the newest 500 and leaves out what could not be read back', () => {
  const storage = fakeStorage();
  const keys = Array.from({ length: 520 }, (_, i) => groupKey([`g${i}`]));
  writeSongFolds(storage, keys);
  const read = readSongFolds(storage);
  assert.equal(read.rejected, false);
  assert.equal(read.value.length, 500);
  assert.equal(read.value[0], groupKey(['g20']));
  writeSongFolds(storage, [groupKey(['n'.repeat(201)]), 'not json', groupKey(['kept'])]);
  assert.deepEqual(readSongFolds(storage).value, [groupKey(['kept'])]);
});

test('what is written is always under the size cap, so it reads back', () => {
  const storage = fakeStorage();
  const keys = Array.from({ length: 500 }, (_, i) => groupKey(['a'.repeat(100), 'b'.repeat(100), `${i}`.padEnd(200, 'c')]));
  writeSongFolds(storage, keys);
  const read = readSongFolds(storage);
  assert.equal(read.rejected, false);
  assert.ok(read.value.length > 0 && read.value.length < 500);
  assert.equal(read.value.at(-1), keys.at(-1), 'the newest stay');
});

test('a fold is remembered up to a name of 200 characters, and the sentence for one that is not says why', () => {
  assert.equal(isRememberable(groupKey(['n'.repeat(200)])), true);
  assert.equal(isRememberable(groupKey(['n'.repeat(201)])), false);
  assert.equal(isRememberable(groupKey(['drums', 'n'.repeat(201)])), false, 'a long name anywhere on the path');
  assert.equal(isRememberable(groupKey(['drums', 'kick'])), true);
  assert.equal(isRememberable('{oops'), false, 'a key that is not a path');
  assert.equal(isRememberable(JSON.stringify([])), false, 'an empty path');
  assert.match(SONG_FOLDS_COPY.notRemembered, /longer than 200 characters/);
  assert.match(SONG_FOLDS_COPY.notRemembered, /not remembered/);
  // The same rule decides what writeSongFolds keeps, so the two cannot drift.
  const storage = fakeStorage();
  writeSongFolds(storage, [groupKey(['a']), groupKey(['n'.repeat(201)])]);
  assert.equal(storage.data.get(SONG_FOLDS_KEY), JSON.stringify([['a']]));
});
