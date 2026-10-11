import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  HistoryStore,
  HistoryError,
  normalizeText,
  resolveDataDir,
  unreadableLinesNote,
  versionNotFoundMessage,
  noMatchMessage,
  NO_FAVORITES_MESSAGE,
  favoriteSavedMessage,
  favoriteRenamedMessage,
  EMPTY_FAVORITE_NAME_MESSAGE,
  MAX_FAVORITE_NAME_LENGTH,
  formatVersionRow,
  HISTORY_CAP,
  COMPACTION_BATCH,
  droppedVersionsNote,
  RENAME_RETRY_DELAYS_MS,
  renameWithRetry,
  historyTrimFailedNote,
  resolveParents,
} from '../dist/history.js';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'moontide-history-store-test-'));
}

function readHistoryLines(dir) {
  const file = path.join(dir, 'history.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l));
}

test('normalizeText collapses whitespace runs (including line breaks) to one space and trims', () => {
  assert.equal(normalizeText('  added\n a   bass '), 'added a bass');
  assert.equal(normalizeText('   \n  '), '');
});

test('recording the same code as the last version without force writes nothing and returns the existing id', () => {
  const dir = tempDir();
  const store = new HistoryStore({ dataDir: dir });
  const first = store.recordVersion({ code: 's("bd")', origin: 'claude' });
  assert.equal(first.recorded, true);
  const second = store.recordVersion({ code: 's("bd")', origin: 'claude' });
  assert.equal(second.recorded, false);
  assert.equal(second.id, first.id);
  const lines = readHistoryLines(dir);
  const versions = lines.filter((l) => l.type === 'version');
  assert.equal(versions.length, 1);
});

test('recording the same code with force true records a new version', () => {
  const dir = tempDir();
  const store = new HistoryStore({ dataDir: dir });
  const first = store.recordVersion({ code: 's("bd")', origin: 'claude' });
  const second = store.recordVersion({ code: 's("bd")', origin: 'claude', force: true });
  assert.equal(second.recorded, true);
  assert.notEqual(second.id, first.id);
});

test('code A, then B, then A records three versions', () => {
  const dir = tempDir();
  const store = new HistoryStore({ dataDir: dir });
  const a1 = store.recordVersion({ code: 'A', origin: 'claude' });
  const b = store.recordVersion({ code: 'B', origin: 'claude' });
  const a2 = store.recordVersion({ code: 'A', origin: 'claude' });
  assert.equal(a1.recorded, true);
  assert.equal(b.recorded, true);
  assert.equal(a2.recorded, true);
  assert.equal(new Set([a1.id, b.id, a2.id]).size, 3);
});

test('a whitespace-only label is stored as no label; a messy label is normalized', () => {
  const dir = tempDir();
  const store = new HistoryStore({ dataDir: dir });
  store.recordVersion({ code: 's("bd")', origin: 'claude', label: '  added\n a   bass ' });
  store.recordVersion({ code: 's("cp")', origin: 'claude', label: '   ' });
  const versions = readHistoryLines(dir).filter((l) => l.type === 'version');
  assert.equal(versions[0].label, 'added a bass');
  assert.equal('label' in versions[1], false);
});

test('with an injected now() returning the same second, two recorded versions get ids 1 and 2 and listText lists #2 above #1', () => {
  const dir = tempDir();
  const fixedNow = new Date('2026-01-01T00:00:00.000Z');
  const store = new HistoryStore({ dataDir: dir, now: () => fixedNow });
  store.recordVersion({ code: 'A', origin: 'claude' });
  store.recordVersion({ code: 'B', origin: 'claude' });
  const text = store.listText();
  const lines = text.split('\n').filter((l) => l.startsWith('#'));
  assert.ok(lines[0].startsWith('#2'));
  assert.ok(lines[1].startsWith('#1'));
});

test('a new HistoryStore on the same dir continues from the highest id and marks a new session on its first record', () => {
  const dir = tempDir();
  const store1 = new HistoryStore({ dataDir: dir });
  store1.recordVersion({ code: 'A', origin: 'claude' });

  const store2 = new HistoryStore({ dataDir: dir });
  const result = store2.recordVersion({ code: 'B', origin: 'claude' });
  assert.equal(result.id, 2);

  const lines = readHistoryLines(dir);
  const sessionStarts = lines.filter((l) => l.type === 'session-start');
  assert.equal(sessionStarts.length, 2);
});

test('listText with a limit smaller than the newest session does not surface a session-start marker past the version window', () => {
  const dir = tempDir();
  const store1 = new HistoryStore({ dataDir: dir });
  store1.recordVersion({ code: 'A', origin: 'claude' });

  const store2 = new HistoryStore({ dataDir: dir });
  store2.recordVersion({ code: 'B', origin: 'claude' });

  const limited = store2.listText({ limit: 1 });
  const rows = limited.split('\n');
  assert.equal(rows.length, 1, 'exactly one row was requested via limit');
  assert.ok(rows[0].startsWith('#2'));
  assert.ok(!rows.some((r) => r.includes('session started')), 'a marker past the limited version window must not leak in');

  // Sanity: the unlimited listing still shows both session markers.
  const full = store2.listText();
  assert.equal(full.split('\n').filter((r) => r.includes('session started')).length, 2);
});

test('a store that only hits the same-code rule writes no session-start line', () => {
  const dir = tempDir();
  const store1 = new HistoryStore({ dataDir: dir });
  store1.recordVersion({ code: 'A', origin: 'claude' });

  const store2 = new HistoryStore({ dataDir: dir });
  const result = store2.recordVersion({ code: 'A', origin: 'claude' });
  assert.equal(result.recorded, false);

  const lines = readHistoryLines(dir);
  const sessionStarts = lines.filter((l) => l.type === 'session-start');
  assert.equal(sessionStarts.length, 1, 'a deduped record must not mark a new session');
});

// resolveDataDir on all three OSes, injected so every branch is testable from one machine.

test('resolveDataDir on darwin joins the injected homedir with the Application Support path', () => {
  const dir = resolveDataDir({}, 'darwin', () => '/Users/u');
  assert.equal(dir, path.posix.join('/Users/u', 'Library', 'Application Support', 'moontide'));
});

test('resolveDataDir on linux uses ~/.local/share by default, XDG_DATA_HOME when absolute, and ignores a relative XDG_DATA_HOME', () => {
  const defaultDir = resolveDataDir({}, 'linux', () => '/home/u');
  assert.equal(defaultDir, path.posix.join('/home/u', '.local', 'share', 'moontide'));

  const xdgDir = resolveDataDir({ XDG_DATA_HOME: '/data' }, 'linux', () => '/home/u');
  assert.equal(xdgDir, path.posix.join('/data', 'moontide'));

  const relativeIgnored = resolveDataDir({ XDG_DATA_HOME: 'rel' }, 'linux', () => '/home/u');
  assert.equal(relativeIgnored, path.posix.join('/home/u', '.local', 'share', 'moontide'));
});

test('resolveDataDir on win32 uses APPDATA when set, else homedir/AppData/Roaming', () => {
  const withAppData = resolveDataDir(
    { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' },
    'win32',
    () => 'C:\\Users\\u',
  );
  assert.equal(withAppData, path.win32.join('C:\\Users\\u\\AppData\\Roaming', 'moontide'));

  const withoutAppData = resolveDataDir({}, 'win32', () => 'C:\\Users\\u');
  assert.equal(withoutAppData, path.win32.join('C:\\Users\\u', 'AppData', 'Roaming', 'moontide'));
});

test('MOONTIDE_DATA_DIR wins over the OS default and resolves against the host cwd; an empty value is ignored', () => {
  const overridden = resolveDataDir({ MOONTIDE_DATA_DIR: '/tmp/x' }, process.platform, os.homedir);
  assert.equal(overridden, path.resolve('/tmp/x'));

  const ignored = resolveDataDir({ MOONTIDE_DATA_DIR: '' }, 'darwin', () => '/Users/u');
  assert.equal(ignored, path.posix.join('/Users/u', 'Library', 'Application Support', 'moontide'));
});

// Unreadable lines are reported and left untouched.

test('unreadableLinesNote lists up to 10 line numbers, then "and N more"', () => {
  assert.equal(
    unreadableLinesNote([2, 3]),
    'Note: 2 unreadable line(s) in the history file were skipped (line 2, 3). Valid entries are unaffected.',
  );
  const twelve = Array.from({ length: 12 }, (_, i) => i + 1);
  assert.equal(
    unreadableLinesNote(twelve),
    'Note: 12 unreadable line(s) in the history file were skipped (line 1, 2, 3, 4, 5, 6, 7, 8, 9, 10 and 2 more). Valid entries are unaffected.',
  );
});

test('a garbage line and a schema-invalid line are reported once as unreadable, then taken as null', () => {
  const dir = tempDir();
  const good1 = JSON.stringify({ type: 'version', id: 1, at: '2026-01-01T00:00:00Z', origin: 'claude', code: 'A' });
  const garbage = 'not json at all {{{';
  const schemaInvalid = JSON.stringify({ type: 'version', id: 2, at: '2026-01-01T00:00:01Z', origin: 'robot', code: 'B' });
  const good2 = JSON.stringify({ type: 'version', id: 3, at: '2026-01-01T00:00:02Z', origin: 'claude', code: 'C' });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'history.jsonl'), [good1, garbage, schemaInvalid, good2].join('\n') + '\n');

  const store = new HistoryStore({ dataDir: dir });
  store.load();
  assert.equal(store.takeUnreadableNote(), 'Note: 2 unreadable line(s) in the history file were skipped (line 2, 3). Valid entries are unaffected.');
  assert.equal(store.takeUnreadableNote(), null);

  const text = store.listText();
  assert.ok(text.includes('A'));
  assert.ok(text.includes('C'));
});

test('a half-written last line (no trailing newline) is preserved byte for byte, and the next record starts on a new line', () => {
  const dir = tempDir();
  const good = JSON.stringify({ type: 'version', id: 1, at: '2026-01-01T00:00:00Z', origin: 'claude', code: 'A' });
  const half = '{"type":"version","id":2,"at":"2026-01-01T00:00:01Z"';
  fs.mkdirSync(dir, { recursive: true });
  const originalContent = good + '\n' + half;
  fs.writeFileSync(path.join(dir, 'history.jsonl'), originalContent);

  const store = new HistoryStore({ dataDir: dir });
  const result = store.recordVersion({ code: 'B', origin: 'claude' });
  assert.equal(result.recorded, true);

  const newContent = fs.readFileSync(path.join(dir, 'history.jsonl'), 'utf8');
  assert.ok(newContent.startsWith(originalContent), 'the old bytes must be an exact prefix of the new file');
  assert.ok(newContent.includes('\n' + half + '\n'), 'the half-written line must end up on its own line');

  const store2 = new HistoryStore({ dataDir: dir });
  const text = store2.listText();
  assert.ok(text.includes('B'));
  const unreadable = (() => {
    store2.load();
    return store2.takeUnreadableNote();
  })();
  assert.ok(unreadable === null || unreadable.includes('1 unreadable'));
});

test('when history.jsonl is a directory, load() and recordVersion() throw HistoryError; removing the directory lets the next call succeed', () => {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, 'history.jsonl'));
  const store = new HistoryStore({ dataDir: dir });

  assert.throws(() => store.load(), HistoryError);
  assert.throws(() => store.recordVersion({ code: 'A', origin: 'claude' }), HistoryError);

  fs.rmSync(path.join(dir, 'history.jsonl'), { recursive: true, force: true });
  const result = store.recordVersion({ code: 'A', origin: 'claude' });
  assert.equal(result.recorded, true);
});

// Word filter and favorites.

test('noMatchMessage, favoriteSavedMessage, favoriteRenamedMessage, EMPTY_FAVORITE_NAME_MESSAGE, NO_FAVORITES_MESSAGE and MAX_FAVORITE_NAME_LENGTH pin the exact copy', () => {
  assert.equal(noMatchMessage('zzz'), 'No versions match "zzz".');
  assert.equal(favoriteSavedMessage(1, 'Dreamy'), 'Saved #1 as favorite "Dreamy".');
  assert.equal(favoriteRenamedMessage(1, 'Dorian sketch'), 'Renamed favorite #1 to "Dorian sketch".');
  assert.equal(EMPTY_FAVORITE_NAME_MESSAGE, 'favorite_version needs a non-empty name.');
  assert.equal(NO_FAVORITES_MESSAGE, 'No favorites yet.');
  assert.equal(MAX_FAVORITE_NAME_LENGTH, 100);
});

test('listText with a case-insensitive filter matches the label or the code, newest first, without session rows; an empty/whitespace filter is no filter; no match gives noMatchMessage', () => {
  const dir = tempDir();
  const store = new HistoryStore({ dataDir: dir });
  store.recordVersion({ code: 's("bd")', origin: 'claude', label: 'drums' });
  store.recordVersion({ code: 'note("c d").s("marimba")', origin: 'claude' });
  store.recordVersion({ code: 's("hh")', origin: 'claude', label: 'hi-hats' });

  const filtered = store.listText({ filter: 'MARIMBA' });
  const rows = filtered.split('\n');
  assert.equal(rows.length, 1);
  assert.ok(rows[0].includes('marimba'));
  assert.ok(!rows.some((r) => r.includes('session started')), 'a filtered listing must leave out session rows');

  const noFilter = store.listText({ filter: '   ' });
  assert.equal(noFilter.split('\n').filter((r) => r.startsWith('#')).length, 3);

  assert.equal(store.listText({ filter: 'zzz' }), noMatchMessage('zzz'));
});

test('favorite() saves a new name, renames on re-favorite, allows a repeated name on a different id, rejects an unknown id and an empty name, and writes nothing on rejection', () => {
  const dir = tempDir();
  const store = new HistoryStore({ dataDir: dir });
  store.recordVersion({ code: 's("bd")', origin: 'claude', label: 'drums' });
  store.recordVersion({ code: 's("hh")', origin: 'claude' });

  const first = store.favorite(1, '  Dorian   sketch ');
  assert.equal(first.renamed, false);
  const rename = store.favorite(1, 'Dreamy');
  assert.equal(rename.renamed, true);
  const secondId = store.favorite(2, 'Dreamy');
  assert.equal(secondId.renamed, false, 'a different id may share a favorite name');

  assert.throws(() => store.favorite(99, 'x'), (err) => err.message === versionNotFoundMessage(99));
  assert.throws(() => store.favorite(1, '   '), (err) => err.message === EMPTY_FAVORITE_NAME_MESSAGE);

  const favoriteLines = readHistoryLines(dir).filter((l) => l.type === 'favorite');
  assert.equal(favoriteLines.length, 3, 'a rejected favorite() call must write nothing');
});

// The schema stays strict, and a favorite kept under its
// current name says Saved, not Renamed.

test('a version line written by hand with code "" is still reported as unreadable by a fresh HistoryStore (the schema is not loosened)', () => {
  const dir = tempDir();
  const emptyCodeLine = JSON.stringify({ type: 'version', id: 1, at: '2026-01-01T00:00:00Z', origin: 'hand', code: '' });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'history.jsonl'), emptyCodeLine + '\n');

  const store = new HistoryStore({ dataDir: dir });
  store.load();
  assert.equal(
    store.takeUnreadableNote(),
    'Note: 1 unreadable line(s) in the history file were skipped (line 1). Valid entries are unaffected.',
  );
});

test('favorite() reports Saved (not Renamed) when the new name normalizes to the same text as the current one, and writes no duplicate line', () => {
  const dir = tempDir();
  const store = new HistoryStore({ dataDir: dir });
  store.recordVersion({ code: 's("bd")', origin: 'claude' });

  const first = store.favorite(1, 'Take one');
  assert.equal(first.renamed, false);
  const same = store.favorite(1, '  Take   one ');
  assert.equal(same.renamed, false, 'the same name (whitespace-normalized) must not be reported as a rename');
  const renamed = store.favorite(1, 'take one');
  assert.equal(renamed.renamed, true, 'a case change is still a rename');
  assert.equal(store.favoriteNames().get(1), 'take one');

  const favoriteLines = readHistoryLines(dir).filter((l) => l.type === 'favorite');
  assert.equal(favoriteLines.length, 2, 'keeping the same name must not write a duplicate favorite line');
});

test('a favorited row inserts the favorite segment after the label (or after the origin when unlabeled), before the code; no segment when favoriteName is not passed', () => {
  const labeled = { type: 'version', id: 1, at: '2026-01-01T00:00:00Z', origin: 'claude', label: 'drums', code: 's("bd")' };
  const unlabeled = { type: 'version', id: 2, at: '2026-01-01T00:00:01Z', origin: 'claude', code: 's("hh")' };
  assert.equal(
    formatVersionRow(labeled, 'Dreamy'),
    '#1 — 2026-01-01T00:00:00Z — claude — "drums" — favorite "Dreamy" — s("bd")',
  );
  assert.equal(
    formatVersionRow(unlabeled, 'Dreamy'),
    '#2 — 2026-01-01T00:00:01Z — claude — favorite "Dreamy" — s("hh")',
  );
  assert.equal(
    formatVersionRow(unlabeled),
    '#2 — 2026-01-01T00:00:01Z — claude — s("hh")',
  );
});

// The third origin 'page', formatVersionRow's generic
// ORIGIN_LABELS lookup, and the reader schema.

test('formatVersionRow for an origin "page" entry reads "#N — <at> — page — \\"launched two\\" — <first line>"', () => {
  const launched = {
    type: 'version',
    id: 3,
    at: '2026-01-01T00:00:02Z',
    origin: 'page',
    label: 'launched two',
    code: 's("bd").late(1)',
  };
  assert.equal(
    formatVersionRow(launched),
    '#3 — 2026-01-01T00:00:02Z — page — "launched two" — s("bd").late(1)',
  );
});

test('the history reader accepts a stored line with origin "page", and still reports an unknown origin as damaged', () => {
  const dir = tempDir();
  const pageLine = JSON.stringify({
    type: 'version',
    id: 1,
    at: '2026-01-01T00:00:00Z',
    origin: 'page',
    label: 'launched two',
    code: 's("bd")',
  });
  const unknownOriginLine = JSON.stringify({
    type: 'version',
    id: 2,
    at: '2026-01-01T00:00:01Z',
    origin: 'mixer',
    code: 's("hh")',
  });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'history.jsonl'), [pageLine, unknownOriginLine].join('\n') + '\n');

  const store = new HistoryStore({ dataDir: dir });
  store.load();
  assert.equal(
    store.takeUnreadableNote(),
    'Note: 1 unreadable line(s) in the history file were skipped (line 2). Valid entries are unaffected.',
  );
  const text = store.listText();
  assert.ok(text.includes(' — page — "launched two" — s("bd")'));
  assert.ok(!text.includes('s("hh")'), 'the unknown-origin line must never reach listText');
});

test('listText({ favoritesOnly: true }) lists only favorited versions newest first, combines with a filter, and reports NO_FAVORITES_MESSAGE when there are none', () => {
  const dir = tempDir();
  const store = new HistoryStore({ dataDir: dir });
  store.recordVersion({ code: 's("bd")', origin: 'claude', label: 'drums' });
  store.recordVersion({ code: 'note("c d").s("marimba")', origin: 'claude' });
  store.recordVersion({ code: 's("hh")', origin: 'claude' });

  assert.equal(store.listText({ favoritesOnly: true }), NO_FAVORITES_MESSAGE);

  store.favorite(1, 'Dreamy');
  store.favorite(2, 'Marimba one');

  const favoritesOnly = store.listText({ favoritesOnly: true });
  const rows = favoritesOnly.split('\n');
  assert.equal(rows.length, 2);
  assert.ok(rows[0].startsWith('#2'), 'newest favorite first');
  assert.ok(rows[1].startsWith('#1'));

  const combined = store.listText({ favoritesOnly: true, filter: 'marimba' });
  assert.equal(combined.split('\n').length, 1);
  assert.ok(combined.includes('#2'));
});

// The 1000-version cap, applied in batches of 100, with favorites exempt.

test('HISTORY_CAP is 1000, COMPACTION_BATCH is 100, and droppedVersionsNote pins the exact copy', () => {
  assert.equal(HISTORY_CAP, 1000);
  assert.equal(COMPACTION_BATCH, 100);
  assert.equal(
    droppedVersionsNote(100, 102),
    'Note: 100 version(s) older than #102 were dropped (favorites are never dropped) to stay within the 1000-version history limit.',
  );
});

test('cap 5, batch 2: recording #1..#6 drops nothing; #7 drops the two oldest in one rewrite; ids continue from 8; a reload lists the same kept ids', () => {
  const dir = tempDir();
  const store = new HistoryStore({ dataDir: dir, cap: 5, batch: 2 });
  for (let i = 1; i <= 6; i++) {
    const result = store.recordVersion({ code: `code ${i}`, origin: 'claude' });
    assert.equal(result.dropped, undefined, `#${i} must not drop`);
    assert.deepEqual(result.notes, []);
  }
  const seventh = store.recordVersion({ code: 'code 7', origin: 'claude' });
  assert.deepEqual(seventh.dropped, { count: 2, oldestKeptId: 3 });
  assert.deepEqual(seventh.notes, [droppedVersionsNote(2, 3, 5)]);

  const versions = readHistoryLines(dir).filter((l) => l.type === 'version');
  assert.deepEqual(versions.map((v) => v.id), [3, 4, 5, 6, 7]);

  const eighth = store.recordVersion({ code: 'code 8', origin: 'claude' });
  assert.equal(eighth.id, 8);

  const reloaded = new HistoryStore({ dataDir: dir, cap: 5, batch: 2 });
  const reloadedIds = reloaded
    .listText()
    .split('\n')
    .filter((r) => r.startsWith('#'))
    .map((r) => Number(r.match(/^#(\d+)/)[1]))
    .sort((a, b) => a - b);
  assert.deepEqual(reloadedIds, [3, 4, 5, 6, 7, 8]);
});

test('cap 5, batch 2 with a favorite: the favorited version is never a trim candidate, and survives past the cap', () => {
  const dir = tempDir();
  const store = new HistoryStore({ dataDir: dir, cap: 5, batch: 2 });
  for (let i = 1; i <= 3; i++) store.recordVersion({ code: `code ${i}`, origin: 'claude' });
  store.favorite(1, 'keep');
  for (let i = 4; i <= 7; i++) {
    const result = store.recordVersion({ code: `code ${i}`, origin: 'claude' });
    assert.equal(result.dropped, undefined, `#${i} must not drop (only #2 is a non-favorite candidate so far)`);
  }
  const eighth = store.recordVersion({ code: 'code 8', origin: 'claude' });
  assert.deepEqual(eighth.dropped, { count: 2, oldestKeptId: 4 });

  const versions = readHistoryLines(dir).filter((l) => l.type === 'version');
  assert.deepEqual(versions.map((v) => v.id), [1, 4, 5, 6, 7, 8]);
});

test('favorites and their names survive a reload; an empty history gives NO_VERSIONS_MESSAGE whatever the options', () => {
  const dir = tempDir();
  const store1 = new HistoryStore({ dataDir: dir });
  store1.recordVersion({ code: 's("bd")', origin: 'claude' });
  store1.favorite(1, 'Dreamy');

  const store2 = new HistoryStore({ dataDir: dir });
  assert.ok(store2.listText({ favoritesOnly: true }).includes('Dreamy'));

  const emptyDir = tempDir();
  const emptyStore = new HistoryStore({ dataDir: emptyDir });
  assert.equal(
    emptyStore.listText({ filter: 'anything', favoritesOnly: true, limit: 5 }),
    'No versions recorded yet.',
  );
});

// RenameWithRetry, byte-safe trims, and a trim that fails without losing anything.

test('RENAME_RETRY_DELAYS_MS is [50, 100, 200, 400, 800]', () => {
  assert.deepEqual(RENAME_RETRY_DELAYS_MS, [50, 100, 200, 400, 800]);
});

test('renameWithRetry retries EPERM with backoff then succeeds', () => {
  let calls = 0;
  const sleeps = [];
  const rename = () => {
    calls++;
    if (calls < 3) {
      const err = new Error('perm');
      err.code = 'EPERM';
      throw err;
    }
  };
  renameWithRetry('from', 'to', { rename, sleep: (ms) => sleeps.push(ms) });
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [50, 100]);
});

test('renameWithRetry gives up after exhausting every retry on a persistent EBUSY', () => {
  let calls = 0;
  const sleeps = [];
  const rename = () => {
    calls++;
    const err = new Error('busy');
    err.code = 'EBUSY';
    throw err;
  };
  assert.throws(
    () => renameWithRetry('from', 'to', { rename, sleep: (ms) => sleeps.push(ms) }),
    (err) => err.code === 'EBUSY',
  );
  assert.equal(calls, 6);
  assert.deepEqual(sleeps, [50, 100, 200, 400, 800]);
});

test('renameWithRetry never retries ENOENT; EACCES is retried exactly like EPERM/EBUSY', () => {
  let enoentCalls = 0;
  const renameEnoent = () => {
    enoentCalls++;
    const err = new Error('missing');
    err.code = 'ENOENT';
    throw err;
  };
  assert.throws(
    () => renameWithRetry('from', 'to', { rename: renameEnoent, sleep: () => assert.fail('must not sleep') }),
    (err) => err.code === 'ENOENT',
  );
  assert.equal(enoentCalls, 1);

  let accessCalls = 0;
  const renameAccess = () => {
    accessCalls++;
    if (accessCalls < 2) {
      const err = new Error('denied');
      err.code = 'EACCES';
      throw err;
    }
  };
  renameWithRetry('from', 'to', { rename: renameAccess, sleep: () => {} });
  assert.equal(accessCalls, 2);
});

test('a trim keeps an unreadable line byte for byte, and drops a session-start line only once every version inside it is gone', () => {
  const dir = tempDir();
  const s1 = JSON.stringify({ type: 'session-start', at: '2026-01-01T00:00:00Z' });
  const v1 = JSON.stringify({ type: 'version', id: 1, at: '2026-01-01T00:00:01Z', origin: 'claude', code: 'v1' });
  const v2 = JSON.stringify({ type: 'version', id: 2, at: '2026-01-01T00:00:02Z', origin: 'claude', code: 'v2' });
  const garbage = '{garbage';
  const s2 = JSON.stringify({ type: 'session-start', at: '2026-01-01T00:00:03Z' });
  const v3 = JSON.stringify({ type: 'version', id: 3, at: '2026-01-01T00:00:04Z', origin: 'claude', code: 'v3' });
  const v4 = JSON.stringify({ type: 'version', id: 4, at: '2026-01-01T00:00:05Z', origin: 'claude', code: 'v4' });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'history.jsonl'), [s1, v1, v2, garbage, s2, v3, v4].join('\n') + '\n');

  const fixedNow = new Date('2026-01-01T00:01:00.000Z');
  const store = new HistoryStore({ dataDir: dir, cap: 2, batch: 1, now: () => fixedNow });
  const result = store.recordVersion({ code: 'v5', origin: 'claude' });
  assert.deepEqual(result.dropped, { count: 3, oldestKeptId: 4 });

  const s3 = JSON.stringify({ type: 'session-start', at: '2026-01-01T00:01:00Z' });
  const v5 = JSON.stringify({ type: 'version', id: 5, at: '2026-01-01T00:01:00Z', origin: 'claude', code: 'v5', parent: 4 });
  const rawLines = fs
    .readFileSync(path.join(dir, 'history.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l !== '');
  assert.deepEqual(rawLines, [garbage, s2, v4, s3, v5]);
});

test('a trim with a favorite keeps the favorited version, the session that keeps it, the unreadable line and the favorite line', () => {
  const dir = tempDir();
  const s1 = JSON.stringify({ type: 'session-start', at: '2026-01-01T00:00:00Z' });
  const v1 = JSON.stringify({ type: 'version', id: 1, at: '2026-01-01T00:00:01Z', origin: 'claude', code: 'v1' });
  const v2 = JSON.stringify({ type: 'version', id: 2, at: '2026-01-01T00:00:02Z', origin: 'claude', code: 'v2' });
  const garbage = '{garbage';
  const s2 = JSON.stringify({ type: 'session-start', at: '2026-01-01T00:00:03Z' });
  const v3 = JSON.stringify({ type: 'version', id: 3, at: '2026-01-01T00:00:04Z', origin: 'claude', code: 'v3' });
  const v4 = JSON.stringify({ type: 'version', id: 4, at: '2026-01-01T00:00:05Z', origin: 'claude', code: 'v4' });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'history.jsonl'), [s1, v1, v2, garbage, s2, v3, v4].join('\n') + '\n');

  const store = new HistoryStore({ dataDir: dir, cap: 2, batch: 1 });
  store.favorite(2, 'kept one');
  store.recordVersion({ code: 'v5', origin: 'claude' });

  const raw = fs.readFileSync(path.join(dir, 'history.jsonl'), 'utf8');
  assert.ok(raw.includes(s1), 'the session that keeps the favorited version must stay');
  assert.ok(raw.includes(v2), 'the favorited version must stay');
  assert.ok(raw.includes(garbage), 'the unreadable line must stay, untouched');
  assert.ok(raw.includes('"kept one"'), 'the favorite line must stay');
});

test('when the trim temp path is a directory, the version is still recorded, a trim-failed note explains why, the old file is unchanged, and the next trim succeeds once the obstruction is gone', () => {
  const dir = tempDir();
  const store = new HistoryStore({ dataDir: dir, cap: 1, batch: 1 });
  store.recordVersion({ code: 'v1', origin: 'claude' });

  const tmpPath = path.join(dir, 'history.jsonl.tmp');
  fs.mkdirSync(tmpPath);

  const beforeAttempt = fs.readFileSync(path.join(dir, 'history.jsonl'), 'utf8');
  const result = store.recordVersion({ code: 'v2', origin: 'claude' });
  assert.equal(result.recorded, true);
  assert.equal(result.dropped, undefined);
  assert.equal(result.notes.length, 1);
  assert.match(result.notes[0], /EISDIR/);
  assert.ok(result.notes[0].startsWith('Note: the history file could not be trimmed to the 1-version limit ('));
  assert.ok(result.notes[0].endsWith('; nothing was lost, and it will be tried again on the next change.'));

  const afterAttempt = fs.readFileSync(path.join(dir, 'history.jsonl'), 'utf8');
  assert.ok(afterAttempt.startsWith(beforeAttempt), 'the old lines must be unchanged');
  assert.ok(afterAttempt.includes('"code":"v2"'), 'the new version is saved even though the trim failed');
  assert.ok(fs.statSync(tmpPath).isDirectory(), 'the obstruction is left in place — unlink on a directory fails harmlessly');

  const list = store.listText();
  assert.ok(list.includes('v1') && list.includes('v2'), 'both versions are still readable in memory (the candidates were not lost)');

  fs.rmSync(tmpPath, { recursive: true, force: true });
  const result2 = store.recordVersion({ code: 'v3', origin: 'claude' });
  assert.deepEqual(result2.dropped, { count: 2, oldestKeptId: result2.id });
  assert.ok(!fs.existsSync(tmpPath), 'the temp file is gone after a successful trim');
});

test('historyTrimFailedNote pins the exact copy', () => {
  assert.equal(
    historyTrimFailedNote('disk full', 1000),
    'Note: the history file could not be trimmed to the 1000-version limit (disk full); nothing was lost, and it will be tried again on the next change.',
  );
});

// ReadWindow, the newest-first window the page's History view loads.

function versionLine(id, code, extra = {}) {
  return JSON.stringify({ type: 'version', id, at: `2026-01-01T00:00:${String(id).padStart(2, '0')}Z`, origin: 'claude', code, ...extra });
}

test('readWindow({ limit: 2 }) over five versions returns ids [5, 4], beyond #3, total 5 and remaining 3', () => {
  const dir = tempDir();
  const lines = [1, 2, 3, 4, 5].map((id) => versionLine(id, `s("v${id}")`));
  fs.writeFileSync(path.join(dir, 'history.jsonl'), lines.join('\n') + '\n');

  const window = new HistoryStore({ dataDir: dir }).readWindow({ limit: 2 });

  assert.deepEqual(
    window.versions.map((v) => v.id),
    [5, 4],
  );
  assert.equal(window.versions[0].code, 's("v5")');
  assert.deepEqual(window.beyond, { id: 3, code: 's("v3")' });
  assert.equal(window.total, 5);
  assert.equal(window.remaining, 3);
});

test('readWindow over an empty store returns no versions, no beyond, total 0 and remaining 0', () => {
  const window = new HistoryStore({ dataDir: tempDir() }).readWindow({ limit: 100 });
  assert.deepEqual(window, { versions: [], beyond: null, total: 0, remaining: 0 });
});

test('readWindow with a limit above the number of versions returns them all, beyond null and remaining 0', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'history.jsonl'), [versionLine(1, 'A'), versionLine(2, 'B')].join('\n') + '\n');

  const window = new HistoryStore({ dataDir: dir }).readWindow({ limit: 100 });

  assert.deepEqual(
    window.versions.map((v) => v.id),
    [2, 1],
  );
  assert.equal(window.beyond, null);
  assert.equal(window.total, 2);
  assert.equal(window.remaining, 0);
});

test('readWindow skips unreadable lines and leaves the label, restoredFrom and parent keys out when unset', () => {
  const dir = tempDir();
  const lines = [
    versionLine(1, 'A'),
    'not json at all {{{',
    versionLine(2, 'B', { label: 'drums', restoredFrom: 1, origin: 'page' }),
  ];
  fs.writeFileSync(path.join(dir, 'history.jsonl'), lines.join('\n') + '\n');

  const window = new HistoryStore({ dataDir: dir }).readWindow({ limit: 10 });

  assert.equal(window.total, 2);
  assert.deepEqual(window.versions[0], {
    id: 2,
    at: '2026-01-01T00:00:02Z',
    origin: 'page',
    code: 'B',
    label: 'drums',
    restoredFrom: 1,
    parent: 1,
  });
  assert.deepEqual(Object.keys(window.versions[1]).sort(), ['at', 'code', 'id', 'origin']);
});

test('readWindow throws on a limit that is not a positive integer', () => {
  const store = new HistoryStore({ dataDir: tempDir() });
  for (const limit of [0, -1, 1.5]) {
    assert.throws(() => store.readWindow({ limit }), /positive integer limit/);
  }
});

// The parent link and its resolution.

function parentOf(window, id) {
  const row = window.versions.find((v) => v.id === id);
  assert.ok(row, `#${id} must be in the window`);
  return 'parent' in row ? row.parent : null;
}

function captureConsoleError(fn) {
  const original = console.error;
  const logged = [];
  console.error = (...args) => {
    logged.push(args.join(' '));
  };
  try {
    fn();
  } finally {
    console.error = original;
  }
  return logged;
}

test('recordVersion: the first version of a file has no parent, the next records the previous id', () => {
  const dir = tempDir();
  const store = new HistoryStore({ dataDir: dir });
  store.recordVersion({ code: 'A', origin: 'claude' });
  store.recordVersion({ code: 'B', origin: 'claude' });
  const versions = readHistoryLines(dir).filter((l) => l.type === 'version');
  assert.ok(!('parent' in versions[0]), 'the first version has no parent key');
  assert.equal(versions[1].parent, 1);
  assert.deepEqual(Object.keys(versions[1]), ['type', 'id', 'at', 'origin', 'code', 'parent']);
});

test('recordVersion: an explicit parent wins over restoredFrom, restoredFrom is used without a parent, and the newest version is the last resort', () => {
  const dir = tempDir();
  const store = new HistoryStore({ dataDir: dir });
  for (const code of ['A', 'B', 'C']) store.recordVersion({ code, origin: 'claude' });
  store.recordVersion({ code: 'D', origin: 'claude', parent: 2, restoredFrom: 1, force: true });
  store.recordVersion({ code: 'E', origin: 'claude', restoredFrom: 1, force: true });
  store.recordVersion({ code: 'F', origin: 'claude' });
  const versions = readHistoryLines(dir).filter((l) => l.type === 'version');
  assert.deepEqual(
    versions.map((v) => [v.id, v.parent]),
    [
      [1, undefined],
      [2, 1],
      [3, 2],
      [4, 2],
      [5, 1],
      [6, 5],
    ],
  );
});

test('resolveParents: legacy lines without a parent resolve to id - 1, a legacy restore to its restoredFrom, and a missing id - 1 is a root', () => {
  const dir = tempDir();
  const lines = [
    versionLine(1, 'A'),
    versionLine(2, 'B'),
    versionLine(3, 'C', { restoredFrom: 1, origin: 'page' }),
    versionLine(4, 'D'),
    versionLine(7, 'G'),
    versionLine(8, 'H', { restoredFrom: 5, origin: 'page' }),
  ];
  fs.writeFileSync(path.join(dir, 'history.jsonl'), lines.join('\n') + '\n');
  const window = new HistoryStore({ dataDir: dir }).readWindow({ limit: 10 });
  assert.equal(parentOf(window, 1), null);
  assert.equal(parentOf(window, 2), 1);
  assert.equal(parentOf(window, 3), 1, 'a legacy restore hangs off its restoredFrom');
  assert.equal(parentOf(window, 4), 3);
  assert.equal(parentOf(window, 7), null, 'id - 1 is not in the file: a root, not the previous line');
  assert.equal(parentOf(window, 8), 7, 'a restoredFrom that is gone falls back to id - 1 when that exists');
});

test('resolveParents: a stored parent that the cap dropped resolves to a root, never to another version', () => {
  const dir = tempDir();
  const store = new HistoryStore({ dataDir: dir, cap: 5, batch: 2 });
  for (let i = 1; i <= 7; i++) store.recordVersion({ code: `code ${i}`, origin: 'claude' });
  const kept = readHistoryLines(dir).filter((l) => l.type === 'version');
  assert.deepEqual(kept.map((v) => v.id), [3, 4, 5, 6, 7]);
  assert.equal(kept[0].parent, 2, 'the stored parent is still on the line');
  const window = store.readWindow({ limit: 10 });
  assert.equal(parentOf(window, 3), null, 'its parent #2 was dropped');
  assert.equal(parentOf(window, 4), 3);
  assert.equal(parentOf(window, 7), 6);
});

test('resolveParents: a stored parent that never existed is a root', () => {
  const dir = tempDir();
  const lines = [versionLine(1, 'A'), versionLine(2, 'B', { parent: 99 })];
  fs.writeFileSync(path.join(dir, 'history.jsonl'), lines.join('\n') + '\n');
  const window = new HistoryStore({ dataDir: dir }).readWindow({ limit: 10 });
  assert.equal(parentOf(window, 2), null);
});

test('resolveParents: a stored parent equal to or above the version is a root and is reported once per store', () => {
  const dir = tempDir();
  const lines = [versionLine(1, 'A'), versionLine(2, 'B', { parent: 2 }), versionLine(3, 'C', { parent: 5 }), versionLine(5, 'E')];
  fs.writeFileSync(path.join(dir, 'history.jsonl'), lines.join('\n') + '\n');
  const store = new HistoryStore({ dataDir: dir });
  let window;
  const first = captureConsoleError(() => {
    window = store.readWindow({ limit: 10 });
  });
  assert.equal(parentOf(window, 2), null);
  assert.equal(parentOf(window, 3), null);
  assert.equal(first.filter((l) => l.includes('is not older than itself')).length, 2, 'one line per malformed id');
  assert.ok(first.some((l) => l.includes('#2 has a parent that is not older than itself')));
  const second = captureConsoleError(() => {
    store.readWindow({ limit: 10 });
  });
  assert.deepEqual(second, [], 'a second read logs nothing new');
});

test('a compaction keeps the parent bytes of kept lines verbatim', () => {
  const dir = tempDir();
  const store = new HistoryStore({ dataDir: dir, cap: 5, batch: 2 });
  for (let i = 1; i <= 6; i++) store.recordVersion({ code: `code ${i}`, origin: 'claude' });
  const rawBefore = fs
    .readFileSync(path.join(dir, 'history.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.includes('"type":"version"') && /"id":[3-6],/.test(l));
  assert.equal(rawBefore.length, 4);
  assert.ok(rawBefore.every((l) => l.includes('"parent":')));
  store.recordVersion({ code: 'code 7', origin: 'claude' });
  const rawAfter = fs.readFileSync(path.join(dir, 'history.jsonl'), 'utf8').split('\n');
  for (const line of rawBefore) {
    assert.ok(rawAfter.includes(line), `kept line is unchanged: ${line}`);
  }
});

test('a version line with an unknown extra key stays readable and listed with its code', () => {
  const dir = tempDir();
  const withExtra = JSON.stringify({ type: 'version', id: 1, at: '2026-01-01T00:00:01Z', origin: 'claude', code: 'A', parent: 1, future: { a: 1 } });
  fs.writeFileSync(path.join(dir, 'history.jsonl'), withExtra + '\n');
  const store = new HistoryStore({ dataDir: dir });
  const window = store.readWindow({ limit: 10 });
  assert.equal(window.total, 1);
  assert.equal(window.versions[0].code, 'A');
  assert.equal(parentOf(window, 1), null, 'a self parent is malformed, never a link');
  assert.equal(store.getVersion(1).code, 'A');
});

test('resolveParents is a pure function: the last line for a duplicated id wins and nothing throws', () => {
  const v = (id, extra = {}) => ({ type: 'version', id, at: 'x', origin: 'claude', code: 'c', ...extra });
  const { parents, malformed } = resolveParents([v(1), v(2), v(2, { parent: 1 }), v(3, { parent: 3 })]);
  assert.equal(parents.get(2), 1);
  assert.equal(parents.get(3), null);
  assert.deepEqual(malformed, [3]);
});

// Session boundaries, favorites and paging in readWindow.

const sessionLine = (at) => JSON.stringify({ type: 'session-start', at });
const favoriteLine = (id, name) => JSON.stringify({ type: 'favorite', id, name, at: '2026-01-01T00:10:00Z' });

test('readWindow sessionStart: the latest session-start line before a version wins, and a trailing one is attached to nothing', () => {
  const dir = tempDir();
  const lines = [
    sessionLine('2026-01-01T00:00:00Z'),
    versionLine(1, 'A'),
    versionLine(2, 'B'),
    sessionLine('2026-01-02T00:00:00Z'),
    sessionLine('2026-01-03T00:00:00Z'),
    versionLine(3, 'C'),
    sessionLine('2026-01-04T00:00:00Z'),
  ];
  fs.writeFileSync(path.join(dir, 'history.jsonl'), lines.join('\n') + '\n');
  const window = new HistoryStore({ dataDir: dir }).readWindow({ limit: 10 });
  const byId = new Map(window.versions.map((v) => [v.id, v]));
  assert.equal(byId.get(1).sessionStart, '2026-01-01T00:00:00Z');
  assert.ok(!('sessionStart' in byId.get(2)));
  assert.equal(byId.get(3).sessionStart, '2026-01-03T00:00:00Z');
  assert.equal(window.total, 3);
});

test('readWindow favorite: a renamed favorite carries its current name, other versions have no favorite key', () => {
  const dir = tempDir();
  const lines = [versionLine(1, 'A'), versionLine(2, 'B'), favoriteLine(1, 'keep'), favoriteLine(1, 'kept')];
  fs.writeFileSync(path.join(dir, 'history.jsonl'), lines.join('\n') + '\n');
  const window = new HistoryStore({ dataDir: dir }).readWindow({ limit: 10 });
  assert.equal(window.versions.find((v) => v.id === 1).favorite, 'kept');
  assert.ok(!('favorite' in window.versions.find((v) => v.id === 2)));
});

test('readWindow({ before, limit }): pages back through 250 versions by id cursor', () => {
  const dir = tempDir();
  const lines = [];
  for (let id = 1; id <= 250; id++) lines.push(versionLine(id, `s("v${id}")`));
  fs.writeFileSync(path.join(dir, 'history.jsonl'), lines.join('\n') + '\n');
  const store = new HistoryStore({ dataDir: dir });

  const page = store.readWindow({ before: 151, limit: 100 });
  assert.equal(page.versions[0].id, 150);
  assert.equal(page.versions.at(-1).id, 51);
  assert.equal(page.versions.length, 100);
  assert.deepEqual(page.beyond, { id: 50, code: 's("v50")' });
  assert.equal(page.remaining, 50);
  assert.equal(page.total, 250);

  const last = store.readWindow({ before: 51, limit: 100 });
  assert.equal(last.versions.length, 50);
  assert.equal(last.beyond, null);
  assert.equal(last.remaining, 0);

  const bottom = store.readWindow({ before: 1, limit: 100 });
  assert.deepEqual(bottom.versions, []);
  assert.equal(bottom.beyond, null);
  assert.equal(bottom.remaining, 0);

  assert.equal(store.readWindow({ before: 999, limit: 100 }), null);
});
