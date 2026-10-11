import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Session } from '../dist/session.js';
import { RigStore } from '../dist/instruments.js';

// The instrument-switch message at the Session level. It sits behind the trust
// gate and the active-page rule, sets (never toggles) the state, writes instruments-state.json, pushes the rig, then
// answers once. Every refusal is plain words; no log line or reply holds the data folder path. Every test works on a
// temporary data folder.

const PAGE_URL = 'http://localhost:5757';
const STATE_FILE = 'instruments-state.json';

/** A fake PageConnection that records every sent frame as parsed JSON. */
function fakePage() {
  const sent = [];
  return {
    sent,
    send(data) {
      sent.push(JSON.parse(data));
    },
  };
}

/** Presents the session's page token; the ask-auth and page-requests frames are dropped from page.sent. */
function authenticate(session, page) {
  const at = page.sent.length;
  session.handlePageMessage(page, { type: 'page-auth', token: session.ask.pageToken });
  assert.deepEqual(page.sent[at], { type: 'ask-auth', ok: true });
  assert.deepEqual(page.sent.at(-1), { type: 'page-requests', live: false });
  page.sent.pop();
  page.sent.splice(at, 1);
}

function captureErrors(fn) {
  const lines = [];
  const original = console.error;
  console.error = (...args) => lines.push(args.join(' '));
  try {
    fn();
  } finally {
    console.error = original;
  }
  return lines;
}

const TWO = { instruments: [{ id: 'mt32', model: 'mt32', port: 'Port A' }, { id: 'sc55', model: 'sc55', port: 'Port B' }] };

function makeDir(t, files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moontide-switch-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return dir;
}

/** A session with its store on `dir` and one authenticated active page; `mark` is where the page's frames begin. */
function setup(dir) {
  const session = new Session({ rig: new RigStore({ dataDir: dir }) });
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);
  return { session, page, mark: page.sent.length };
}

const send = (session, page, instrument, enabled, id = 'sw-1') => session.handlePageMessage(page, { type: 'instrument-switch', id, instrument, enabled });
const results = (page, mark) => page.sent.slice(mark).filter((frame) => frame.type === 'instrument-result');
const stateOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, STATE_FILE), 'utf8'));

test('instrument-switch from a page that never authenticated sends nothing, writes nothing and logs one refusal', (t) => {
  const dir = makeDir(t, { 'instruments.json': TWO });
  const session = new Session({ rig: new RigStore({ dataDir: dir }) });
  session.setPageUrl(PAGE_URL);
  const stranger = fakePage();
  const logged = captureErrors(() => send(session, stranger, 'sc55', false));
  assert.deepEqual(stranger.sent, []);
  assert.equal(fs.existsSync(path.join(dir, STATE_FILE)), false);
  assert.equal(logged.length, 1, logged.join('\n'));
  assert.ok(logged[0].includes('(instrument-switch)'), logged[0]);
  assert.ok(!logged[0].includes(dir));
});

test('instrument-switch from an authenticated page that is not the active one is refused, and nothing is written', (t) => {
  const dir = makeDir(t, { 'instruments.json': TWO });
  const { session, page: first } = setup(dir);
  const second = fakePage();
  authenticate(session, second);
  const mark = first.sent.length;
  const logged = captureErrors(() => send(session, first, 'sc55', false));
  assert.deepEqual(first.sent.slice(mark), [
    { type: 'instrument-result', id: 'sw-1', ok: false, kind: 'refused', reason: 'this tab is not the one that plays, so nothing was switched' },
  ]);
  assert.equal(fs.existsSync(path.join(dir, STATE_FILE)), false);
  assert.equal(logged.length, 1, logged.join('\n'));
  assert.ok(!logged[0].includes(dir));
});

test('a superseded page is not pushed the rig again when the active page switches an instrument', (t) => {
  const dir = makeDir(t, { 'instruments.json': TWO });
  const { session, page: first } = setup(dir);
  const second = fakePage();
  authenticate(session, second);
  const mark = first.sent.length;
  const activeMark = second.sent.length;
  send(session, second, 'sc55', false);
  assert.deepEqual(results(second, activeMark), [{ type: 'instrument-result', id: 'sw-1', ok: true }]);
  assert.ok(second.sent.slice(activeMark).some((frame) => frame.type === 'midi-rig'), 'the active page gets the new rig');
  assert.deepEqual(first.sent.slice(mark), [], 'the superseded page gets nothing: it shows no cards, only the notice');
});

test('instrument-switch with no instruments.json, no store or an invalid instruments.json is refused with its own reason', (t) => {
  const noFile = setup(makeDir(t));
  send(noFile.session, noFile.page, 'sc55', false);
  assert.deepEqual(results(noFile.page, noFile.mark), [
    { type: 'instrument-result', id: 'sw-1', ok: false, kind: 'refused', reason: 'there is no instruments.json, so there is nothing to switch' },
  ]);

  const session = new Session();
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);
  const mark = page.sent.length;
  send(session, page, 'sc55', false);
  assert.deepEqual(results(page, mark), [
    { type: 'instrument-result', id: 'sw-1', ok: false, kind: 'refused', reason: 'there is no instruments.json, so there is nothing to switch' },
  ]);

  const dir = makeDir(t, { 'instruments.json': { instruments: [{ id: 'mt32', model: 'mt32' }] } });
  const broken = setup(dir);
  send(broken.session, broken.page, 'mt32', false);
  assert.deepEqual(results(broken.page, broken.mark), [
    { type: 'instrument-result', id: 'sw-1', ok: false, kind: 'refused', reason: 'instruments.json has a problem, so nothing was switched' },
  ]);
  assert.equal(fs.existsSync(path.join(dir, STATE_FILE)), false);
});

test('instrument-switch with an unknown instrument is refused with its id, cleaned of control characters', (t) => {
  const dir = makeDir(t, { 'instruments.json': TWO });
  const { session, page, mark } = setup(dir);
  send(session, page, 'zz', false);
  send(session, page, 'a\u0007b', false, 'sw-2');
  assert.deepEqual(results(page, mark), [
    { type: 'instrument-result', id: 'sw-1', ok: false, kind: 'refused', reason: 'there is no instrument "zz" in instruments.json' },
    { type: 'instrument-result', id: 'sw-2', ok: false, kind: 'refused', reason: 'there is no instrument "ab" in instruments.json' },
  ]);
  assert.equal(fs.existsSync(path.join(dir, STATE_FILE)), false);
});

test('instrument-switch to the state the instrument already has is answered ok with no write and no rig push', (t) => {
  const dir = makeDir(t, { 'instruments.json': TWO, [STATE_FILE]: { off: ['sc55'] } });
  const file = path.join(dir, STATE_FILE);
  const old = new Date('2001-01-01T00:00:00Z');
  fs.utimesSync(file, old, old);
  const before = fs.readFileSync(file, 'utf8');
  const { session, page, mark } = setup(dir);
  send(session, page, 'sc55', false);
  send(session, page, 'mt32', true, 'sw-2');
  assert.deepEqual(page.sent.slice(mark), [
    { type: 'instrument-result', id: 'sw-1', ok: true },
    { type: 'instrument-result', id: 'sw-2', ok: true },
  ]);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(fs.statSync(file).mtimeMs, old.getTime(), 'the file was not rewritten');
});

test('instrument-switch writes the choice, pushes the rig, then answers; off then on writes { off } then { off: [] }', (t) => {
  const dir = makeDir(t, { 'instruments.json': TWO });
  const { session, page, mark } = setup(dir);
  send(session, page, 'sc55', false);
  assert.deepEqual(stateOf(dir), { off: ['sc55'] });
  const first = page.sent.slice(mark);
  assert.deepEqual(first.map((frame) => frame.type), ['midi-rig', 'instrument-result']);
  assert.deepEqual(first[0].instruments.map((instrument) => [instrument.id, instrument.enabled]), [['mt32', true], ['sc55', false]]);
  assert.deepEqual(first[1], { type: 'instrument-result', id: 'sw-1', ok: true });

  send(session, page, 'sc55', true, 'sw-2');
  assert.deepEqual(stateOf(dir), { off: [] });
  const second = page.sent.slice(mark + 2);
  assert.deepEqual(second.map((frame) => frame.type), ['midi-rig', 'instrument-result']);
  assert.deepEqual(second[0].instruments.map((instrument) => instrument.enabled), [true, true]);
  assert.deepEqual(second[1], { type: 'instrument-result', id: 'sw-2', ok: true });
});

test('instrument-switch keeps file order in the state file and drops ids the instruments file does not hold', (t) => {
  const dir = makeDir(t, { 'instruments.json': TWO, [STATE_FILE]: { off: ['gone', 'sc55'] } });
  const { session, page, mark } = setup(dir);
  send(session, page, 'mt32', false);
  assert.deepEqual(stateOf(dir), { off: ['mt32', 'sc55'] });
  assert.deepEqual(results(page, mark), [{ type: 'instrument-result', id: 'sw-1', ok: true }]);
});

test('instrument-switch with a state file that cannot be written is refused write-failed: no rig push, the old file stays, no path in a log or a reply', (t) => {
  const dir = makeDir(t, { 'instruments.json': TWO, [STATE_FILE]: { off: ['mt32'] } });
  // A directory in the temporary file's place makes the write fail on every OS (never chmod).
  fs.mkdirSync(path.join(dir, `${STATE_FILE}.tmp`));
  const { session, page, mark } = setup(dir);
  const logged = captureErrors(() => send(session, page, 'sc55', false));
  const frames = page.sent.slice(mark);
  assert.deepEqual(frames.map((frame) => frame.type), ['instrument-result'], 'no midi-rig frame');
  assert.equal(frames[0].ok, false);
  assert.equal(frames[0].kind, 'write-failed');
  assert.match(frames[0].reason, /^the choice could not be saved \(E[A-Z]+\); nothing changed$/);
  assert.deepEqual(stateOf(dir), { off: ['mt32'] }, 'the old file stays');
  assert.equal(logged.length, 1, logged.join('\n'));
  assert.match(logged[0], /^\[moontide\] An instrument switch could not be saved: E[A-Z]+$/);
  for (const text of [...logged, JSON.stringify(frames)]) assert.ok(!text.includes(dir), 'nothing holds the data folder');
});

test('instrument-switch when the data folder cannot be found is refused, and nothing holds the folder', (t) => {
  const dir = makeDir(t, { 'instruments.json': TWO });
  let allowed = Infinity;
  const rig = new RigStore({
    dataDir: () => {
      if (allowed-- > 0) return dir;
      throw new Error(`cannot resolve ${dir}`);
    },
  });
  const session = new Session({ rig });
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);
  const mark = page.sent.length;
  // The read inside the handler finds the folder; the write then cannot.
  allowed = 1;
  const logged = captureErrors(() => send(session, page, 'sc55', false));
  assert.deepEqual(page.sent.slice(mark), [
    { type: 'instrument-result', id: 'sw-1', ok: false, kind: 'refused', reason: 'the Moontide data folder could not be found, so nothing was switched' },
  ]);
  assert.equal(fs.existsSync(path.join(dir, STATE_FILE)), false);
  assert.equal(logged.length, 1, logged.join('\n'));
  assert.ok(!logged[0].includes(dir));
});
