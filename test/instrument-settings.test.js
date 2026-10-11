import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RigStore, applyInstrumentSettings, formatRigFile, rigFileStyle, rigSettingsLine } from '../dist/instruments.js';
import { Session } from '../dist/session.js';

// the page changes the port, channels and clock of one entry of instruments.json. The server patches
// those three keys of the raw entry, checks the result with the code that reads the file, and writes it with a
// backup. Every test works on a temporary data folder.

function makeDir(t, files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moontide-settings-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return dir;
}

const BASE = {
  instruments: [
    { id: 'mt32', model: 'mt32', port: 'Fake Synth A' },
    { id: 'sc55', model: 'sc55', port: 'Fake Synth B' },
  ],
};
const ALL_SC55 = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];

function setup(t, value = BASE) {
  const text = typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`;
  const dir = makeDir(t, { 'instruments.json': text });
  return { dir, store: new RigStore({ dataDir: dir }), file: path.join(dir, 'instruments.json'), text };
}

const SC55 = { port: 'Fake Synth B', channels: ALL_SC55, clock: false };
const MT32 = { port: 'Fake Synth A', channels: [2, 3, 4, 5, 6, 7, 8, 9, 10], clock: false };

function untouched(context) {
  assert.equal(fs.readFileSync(context.file, 'utf8'), context.text, 'instruments.json is byte for byte as it was');
  assert.equal(fs.existsSync(`${context.file}.bak`), false, 'no backup for an edit that was not saved');
  assert.equal(fs.existsSync(`${context.file}.tmp`), false, 'no temporary file left');
}

function assertProblem(outcome, field, reason) {
  assert.equal(outcome.kind, 'invalid', JSON.stringify(outcome));
  assert.ok(
    outcome.problems.some((problem) => problem.field === field && (reason instanceof RegExp ? reason.test(problem.reason) : problem.reason === reason)),
    `expected "${field} · ${reason}" in ${JSON.stringify(outcome.problems)}`,
  );
}

// The validator: the same checks as a read of the file, nothing written for a refusal.

test('a channel the model does not have is refused with the field and reason a hand edit gets', (t) => {
  const context = setup(t);
  const outcome = applyInstrumentSettings(context.store, 'sc55', { ...SC55, channels: [1, 17] });
  // Channel 17 is no MIDI channel at all, so the shape check of the file says so (the model check never sees it).
  assertProblem(outcome, 'instruments[1].channels[1]', '17 is not between 1 and 16');
  untouched(context);
  // The model that does not have channel 1: mt32.
  const mt32 = applyInstrumentSettings(context.store, 'mt32', { ...MT32, channels: [1, 2] });
  assertProblem(mt32, 'instruments[0].channels[0]', 'channel 1 is not a channel of model mt32 (channels: 2-10)');
  untouched(context);
});

test('an empty channel list, an empty port and a repeated channel are refused with the reason of the file', (t) => {
  const context = setup(t);
  assertProblem(applyInstrumentSettings(context.store, 'sc55', { ...SC55, channels: [] }), 'instruments[1].channels', 'at least one channel is required');
  assertProblem(applyInstrumentSettings(context.store, 'sc55', { ...SC55, port: '' }), 'instruments[1].port', 'must not be empty');
  assertProblem(applyInstrumentSettings(context.store, 'sc55', { ...SC55, channels: [1, 1] }), 'instruments[1].channels[1]', 'channel 1 is listed twice');
  untouched(context);
});

test('the port of another instrument, or a part of it, is refused', (t) => {
  const context = setup(t);
  assertProblem(applyInstrumentSettings(context.store, 'sc55', { ...SC55, port: 'Fake Synth A' }), 'instruments[1].port', 'same port as instruments[0] ("mt32")');
  assertProblem(applyInstrumentSettings(context.store, 'sc55', { ...SC55, port: 'Fake Synth' }), 'instruments[1].port', /are part of each other/);
  untouched(context);
});

test('the refusal is the validator\'s own: the same problems come from the file edited by hand', (t) => {
  const context = setup(t);
  const outcome = applyInstrumentSettings(context.store, 'sc55', { ...SC55, channels: [1, 17], port: 'Fake Synth A' });
  const byHand = makeDir(t, {
    'instruments.json': {
      instruments: [
        { id: 'mt32', model: 'mt32', port: 'Fake Synth A' },
        { id: 'sc55', model: 'sc55', port: 'Fake Synth A', channels: [1, 17] },
      ],
    },
  });
  const state = new RigStore({ dataDir: byHand }).read();
  assert.equal(state.setup, 'invalid');
  assert.deepEqual(outcome.problems, state.problems);
  assert.equal(outcome.more, state.more);
  untouched(context);
});

// What changes, and what does not.

test('the same settings as the current ones change nothing: no write, no backup', (t) => {
  const context = setup(t);
  assert.deepEqual(applyInstrumentSettings(context.store, 'sc55', SC55), { kind: 'unchanged' });
  assert.deepEqual(applyInstrumentSettings(context.store, 'mt32', MT32), { kind: 'unchanged' });
  untouched(context);
});

test('every channel of the model with no channels key leaves the key absent; a subset becomes the full sorted list', (t) => {
  const context = setup(t);
  assert.deepEqual(applyInstrumentSettings(context.store, 'sc55', { ...SC55, channels: [...ALL_SC55].reverse() }), { kind: 'unchanged' });
  untouched(context);

  const subset = setup(t, { instruments: [{ id: 'sc55', model: 'sc55', port: 'Fake Synth B', channels: [1, 2, 3] }] });
  const saved = applyInstrumentSettings(subset.store, 'sc55', { ...SC55, channels: [...ALL_SC55].reverse() });
  assert.equal(saved.kind, 'saved', JSON.stringify(saved));
  assert.deepEqual(JSON.parse(fs.readFileSync(subset.file, 'utf8')).instruments[0].channels, ALL_SC55);
});

test('channels are written sorted ascending', (t) => {
  const context = setup(t);
  const outcome = applyInstrumentSettings(context.store, 'sc55', { ...SC55, channels: [10, 3, 1] });
  assert.equal(outcome.kind, 'saved', JSON.stringify(outcome));
  assert.deepEqual(JSON.parse(fs.readFileSync(context.file, 'utf8')).instruments[1].channels, [1, 3, 10]);
  assert.deepEqual(outcome.after.channels.map((entry) => entry.channel), [1, 3, 10]);
  assert.deepEqual(outcome.before.channels.map((entry) => entry.channel), ALL_SC55);
  assert.equal(fs.readFileSync(`${context.file}.bak`, 'utf8'), context.text);
});

test('the clock is written explicitly, and the same value again changes nothing', (t) => {
  const context = setup(t);
  const on = applyInstrumentSettings(context.store, 'mt32', { ...MT32, clock: true });
  assert.equal(on.kind, 'saved', JSON.stringify(on));
  assert.equal(JSON.parse(fs.readFileSync(context.file, 'utf8')).instruments[0].clock, true);
  assert.deepEqual(applyInstrumentSettings(context.store, 'mt32', { ...MT32, clock: true }), { kind: 'unchanged' });
  // Off again: the key exists now, so it is written as false instead of removed.
  const off = applyInstrumentSettings(context.store, 'mt32', { ...MT32, clock: false });
  assert.equal(off.kind, 'saved', JSON.stringify(off));
  assert.equal(JSON.parse(fs.readFileSync(context.file, 'utf8')).instruments[0].clock, false);
  assert.ok('clock' in JSON.parse(fs.readFileSync(context.file, 'utf8')).instruments[0]);
});

test('a changed port keeps every other key, and the key order of the entry stays the user\'s', (t) => {
  const context = setup(t, { instruments: [{ port: 'Fake Synth B', id: 'sc55', clock: true, model: 'sc55' }] });
  const moved = applyInstrumentSettings(context.store, 'sc55', { ...SC55, clock: true, port: 'Fake Synth C' });
  assert.equal(moved.kind, 'saved', JSON.stringify(moved));
  const entry = JSON.parse(fs.readFileSync(context.file, 'utf8')).instruments[0];
  assert.deepEqual(Object.keys(entry), ['port', 'id', 'clock', 'model']);
  assert.deepEqual(entry, { port: 'Fake Synth C', id: 'sc55', clock: true, model: 'sc55' });
  const channels = applyInstrumentSettings(context.store, 'sc55', { port: 'Fake Synth C', channels: [1, 2], clock: true });
  assert.equal(channels.kind, 'saved', JSON.stringify(channels));
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(context.file, 'utf8')).instruments[0]), ['port', 'id', 'clock', 'model', 'channels']);
});

test('the model and the id never change, whatever the chosen object holds', (t) => {
  const context = setup(t);
  const outcome = applyInstrumentSettings(context.store, 'sc55', { ...SC55, clock: true, model: 'mt32', id: 'x', extra: 1 });
  assert.equal(outcome.kind, 'saved', JSON.stringify(outcome));
  const written = JSON.parse(fs.readFileSync(context.file, 'utf8'));
  assert.deepEqual(written.instruments[1], { id: 'sc55', model: 'sc55', port: 'Fake Synth B', clock: true });
  assert.deepEqual(written.instruments[0], BASE.instruments[0]);
});

test('the other entries are untouched, keys and order included', (t) => {
  const context = setup(t, {
    instruments: [
      { clock: true, port: 'Fake Synth A', model: 'mt32', id: 'mt32', channels: [10, 2] },
      { id: 'sc55', model: 'sc55', port: 'Fake Synth B' },
    ],
  });
  const outcome = applyInstrumentSettings(context.store, 'sc55', { ...SC55, channels: [1] });
  assert.equal(outcome.kind, 'saved', JSON.stringify(outcome));
  const written = JSON.parse(fs.readFileSync(context.file, 'utf8'));
  assert.deepEqual(Object.keys(written.instruments[0]), ['clock', 'port', 'model', 'id', 'channels']);
  assert.deepEqual(written.instruments[0].channels, [10, 2], 'the unsorted list of an entry that was not edited stays as the user wrote it');
});

// The look of the file.

test('rigFileStyle reads the indentation, the line ending and the final newline', () => {
  assert.deepEqual(rigFileStyle('{\n  "a": 1\n}\n'), { indent: '  ', eol: '\n', finalNewline: true });
  assert.deepEqual(rigFileStyle('{\n    "a": 1\n}'), { indent: '    ', eol: '\n', finalNewline: false });
  assert.deepEqual(rigFileStyle('{\r\n\t"a": 1\r\n}\r\n'), { indent: '\t', eol: '\r\n', finalNewline: true });
  assert.deepEqual(rigFileStyle('{"a":1}'), { indent: '  ', eol: '\n', finalNewline: false });
});

test('a tab-indented CRLF file with a final newline stays tab-indented CRLF with a final newline', (t) => {
  const crlf = '{\r\n\t"instruments": [\r\n\t\t{\r\n\t\t\t"id": "sc55",\r\n\t\t\t"model": "sc55",\r\n\t\t\t"port": "Fake Synth B"\r\n\t\t}\r\n\t]\r\n}\r\n';
  const context = setup(t, crlf);
  const outcome = applyInstrumentSettings(context.store, 'sc55', { ...SC55, channels: [1, 2] });
  assert.equal(outcome.kind, 'saved', JSON.stringify(outcome));
  const written = fs.readFileSync(context.file, 'utf8');
  assert.equal(
    written,
    '{\r\n\t"instruments": [\r\n\t\t{\r\n\t\t\t"id": "sc55",\r\n\t\t\t"model": "sc55",\r\n\t\t\t"port": "Fake Synth B",\r\n\t\t\t"channels": [1, 2]\r\n\t\t}\r\n\t]\r\n}\r\n',
  );
  assert.equal(fs.readFileSync(`${context.file}.bak`, 'utf8'), crlf, 'the backup is the previous text byte for byte');
});

test('a compact one-line file becomes pretty text, and its backup keeps the compact text', (t) => {
  const compact = '{"instruments":[{"id":"sc55","model":"sc55","port":"Fake Synth B"}]}';
  const context = setup(t, compact);
  assert.equal(applyInstrumentSettings(context.store, 'sc55', { ...SC55, clock: true }).kind, 'saved');
  assert.equal(
    fs.readFileSync(context.file, 'utf8'),
    '{\n  "instruments": [\n    {\n      "id": "sc55",\n      "model": "sc55",\n      "port": "Fake Synth B",\n      "clock": true\n    }\n  ]\n}',
  );
  assert.equal(fs.readFileSync(`${context.file}.bak`, 'utf8'), compact);
});

test('the final newline is kept when the file has it and not added when it has none', (t) => {
  const withNewline = setup(t);
  applyInstrumentSettings(withNewline.store, 'sc55', { ...SC55, clock: true });
  assert.ok(fs.readFileSync(withNewline.file, 'utf8').endsWith('}\n'));
  const without = setup(t, JSON.stringify(BASE, null, 2));
  applyInstrumentSettings(without.store, 'sc55', { ...SC55, clock: true });
  assert.ok(fs.readFileSync(without.file, 'utf8').endsWith('}'));
});

test('formatRigFile round-trips odd ports, puts numbers on one line and objects on their own lines', () => {
  const style = { indent: '  ', eol: '\n', finalNewline: true };
  for (const port of ['say "hi"', '[1,2]', 'back\\slash', 'Péché ✓', 'line separator', '']) {
    const value = { instruments: [{ id: 'a', port, channels: [1, 2, 3] }, { id: 'b', port: 'x', nested: { empty: {}, none: [], list: [{ k: null }, true] } }] };
    const text = formatRigFile(value, style);
    assert.deepEqual(JSON.parse(text), value, text);
    assert.ok(text.includes('"channels": [1, 2, 3]'));
    assert.ok(text.endsWith('}\n'));
  }
  const text = formatRigFile({ list: [{ a: 1 }, { b: 2 }], numbers: [1, 2], empty: [], object: {} }, style);
  assert.equal(text, '{\n  "list": [\n    {\n      "a": 1\n    },\n    {\n      "b": 2\n    }\n  ],\n  "numbers": [1, 2],\n  "empty": [],\n  "object": {}\n}\n');
});

test('formatRigFile uses the line ending, the indentation and the final newline it is given', () => {
  const value = { a: [{ b: 1 }] };
  assert.equal(formatRigFile(value, { indent: '\t', eol: '\r\n', finalNewline: false }), '{\r\n\t"a": [\r\n\t\t{\r\n\t\t\t"b": 1\r\n\t\t}\r\n\t]\r\n}');
  assert.equal(formatRigFile(value, { indent: '    ', eol: '\n', finalNewline: true }).split('\n')[1], '    "a": [');
});

test('a saved edit of an odd port parses back to the patched value', (t) => {
  const context = setup(t);
  for (const port of ['Synth "B"', '[1,2]', 'Péché ✓ \\ end']) {
    const outcome = applyInstrumentSettings(context.store, 'sc55', { port, channels: ALL_SC55, clock: false });
    assert.equal(outcome.kind, 'saved', JSON.stringify(outcome));
    assert.equal(JSON.parse(fs.readFileSync(context.file, 'utf8')).instruments[1].port, port);
  }
});

// What Claude reads.

test('rigSettingsLine says only what changed', (t) => {
  const context = setup(t);
  const channels = applyInstrumentSettings(context.store, 'sc55', { ...SC55, channels: [1, 2, 3, 10] });
  assert.equal(rigSettingsLine(channels.before, channels.after), 'MIDI: the user changed "sc55": channels 1-16 became 1-3, 10.');
  const both = applyInstrumentSettings(context.store, 'mt32', { port: 'Fake Synth C', channels: MT32.channels, clock: true });
  assert.equal(both.kind, 'saved', JSON.stringify(both));
  assert.equal(rigSettingsLine(both.before, both.after), 'MIDI: the user changed "mt32": port "Fake Synth A" became "Fake Synth C"; clock now on.');
  const off = applyInstrumentSettings(context.store, 'mt32', { port: 'Fake Synth C', channels: MT32.channels, clock: false });
  assert.equal(rigSettingsLine(off.before, off.after), 'MIDI: the user changed "mt32": clock now off.');
  assert.ok(!rigSettingsLine(channels.before, channels.after).includes('instruments.json'));
});

test('validateRigValue gives the state a value would have, and never writes', (t) => {
  const context = setup(t);
  assert.equal(context.store.validateRigValue(BASE).setup, 'valid');
  assert.equal(context.store.validateRigValue(null).setup, 'invalid');
  assert.equal(context.store.validateRigValue([]).setup, 'invalid');
  assert.equal(context.store.validateRigValue({ instruments: [] }).setup, 'invalid');
  assert.equal(fs.readFileSync(context.file, 'utf8'), context.text);
});

// A write that cannot finish leaves the file as it was. A directory in the place of a file makes a write
// fail on every OS; nothing here uses chmod.

test('a temporary file that cannot be written gives write-failed with an error code only, and the file stays', (t) => {
  const context = setup(t);
  fs.mkdirSync(`${context.file}.tmp`);
  const outcome = applyInstrumentSettings(context.store, 'sc55', { ...SC55, clock: true });
  assert.equal(outcome.kind, 'write-failed');
  assert.match(outcome.reason, /^the file system answered E[A-Z]+$/);
  assert.equal(fs.readFileSync(context.file, 'utf8'), context.text);
  assert.equal(fs.existsSync(`${context.file}.bak`), false, 'no backup was written');
  assert.ok(!outcome.reason.includes(context.dir));
});

test('a backup that cannot be written gives write-failed, and no temporary file is left', (t) => {
  const context = setup(t);
  fs.mkdirSync(`${context.file}.bak`);
  const outcome = applyInstrumentSettings(context.store, 'sc55', { ...SC55, clock: true });
  assert.equal(outcome.kind, 'write-failed');
  assert.match(outcome.reason, /^the backup could not be written \(the file system answered E[A-Z]+\)$/);
  assert.equal(fs.readFileSync(context.file, 'utf8'), context.text);
  assert.equal(fs.existsSync(`${context.file}.tmp`), false);
  assert.ok(!outcome.reason.includes(context.dir));
});

test('a file changed by someone else while saving is refused, and the other writer\'s text is kept', (t) => {
  // The seam is the data folder callback of the store: the third time it is asked (the check of the patched value,
  // after the file was read and before anything is written) it rewrites the file, like another writer would.
  const dir = makeDir(t);
  const file = path.join(dir, 'instruments.json');
  const original = `${JSON.stringify(BASE, null, 2)}\n`;
  const other = `${JSON.stringify({ instruments: [{ id: 'sc55', model: 'sc55', port: 'Somebody Else' }, BASE.instruments[0]] }, null, 2)}\n`;
  fs.writeFileSync(file, original);
  let asked = 0;
  const store = new RigStore({
    dataDir: () => {
      asked += 1;
      if (asked === 3) fs.writeFileSync(file, other);
      return dir;
    },
  });
  const outcome = applyInstrumentSettings(store, 'sc55', { ...SC55, clock: true });
  assert.deepEqual(outcome, { kind: 'refused', reason: 'instruments.json changed while saving, so nothing was saved' });
  assert.equal(fs.readFileSync(file, 'utf8'), other, 'the other writer\'s text stays');
  assert.equal(fs.existsSync(`${file}.tmp`), false);
});

test('a refused "changed while saving" edit leaves an existing backup untouched and no temporary file behind', (t) => {
  const dir = makeDir(t);
  const file = path.join(dir, 'instruments.json');
  const original = `${JSON.stringify(BASE, null, 2)}\n`;
  const other = `${JSON.stringify({ instruments: [{ id: 'sc55', model: 'sc55', port: 'Somebody Else' }, BASE.instruments[0]] }, null, 2)}\n`;
  fs.writeFileSync(file, original);
  fs.writeFileSync(`${file}.bak`, 'an earlier backup the user cares about');
  let asked = 0;
  const store = new RigStore({
    dataDir: () => {
      asked += 1;
      if (asked === 3) fs.writeFileSync(file, other);
      return dir;
    },
  });
  const outcome = applyInstrumentSettings(store, 'sc55', { ...SC55, clock: true });
  assert.equal(outcome.kind, 'refused');
  assert.equal(fs.readFileSync(`${file}.bak`, 'utf8'), 'an earlier backup the user cares about', 'the backup is not replaced by a refused edit');
  assert.equal(fs.readFileSync(file, 'utf8'), other);
  assert.equal(fs.existsSync(`${file}.tmp`), false);
  assert.equal(fs.existsSync(`${file}.bak.tmp`), false);
});

test('a saved edit leaves the backup whole and no temporary files', (t) => {
  const context = setup(t);
  const outcome = applyInstrumentSettings(context.store, 'sc55', { ...SC55, clock: true });
  assert.equal(outcome.kind, 'saved');
  assert.equal(fs.readFileSync(`${context.file}.bak`, 'utf8'), context.text);
  assert.equal(fs.existsSync(`${context.file}.tmp`), false);
  assert.equal(fs.existsSync(`${context.file}.bak.tmp`), false);
});

test('no file, an invalid file, an unknown instrument and an unreadable file are refused in plain words', (t) => {
  const none = new RigStore({ dataDir: makeDir(t) });
  assert.deepEqual(applyInstrumentSettings(none, 'sc55', SC55), { kind: 'refused', reason: 'there is no instruments.json, so there is nothing to change' });

  const broken = setup(t, { instruments: [{ id: 'sc55', model: 'sc55' }] });
  assert.deepEqual(applyInstrumentSettings(broken.store, 'sc55', SC55), { kind: 'refused', reason: 'instruments.json has a problem, so nothing was saved' });
  untouched(broken);

  const fine = setup(t);
  assert.deepEqual(applyInstrumentSettings(fine.store, 'zz', SC55), { kind: 'refused', reason: 'there is no instrument "zz" in instruments.json' });
  untouched(fine);

  const dir = makeDir(t);
  fs.mkdirSync(path.join(dir, 'instruments.json'));
  const outcome = applyInstrumentSettings(new RigStore({ dataDir: dir }), 'sc55', SC55);
  assert.equal(outcome.kind, 'refused');
  assert.match(outcome.reason, /^instruments\.json could not be read \(E[A-Z]+\), so nothing was saved$/);
  assert.ok(!outcome.reason.includes(dir));
});

test('a data folder that cannot be found is refused without naming it', () => {
  const store = new RigStore({
    dataDir: () => {
      throw new Error('no folder at the secret place');
    },
  });
  const outcome = applyInstrumentSettings(store, 'sc55', SC55);
  assert.deepEqual(outcome, { kind: 'refused', reason: 'the Moontide data folder could not be found, so nothing was saved' });
});

// The Session: trust gate, active page, outcome mapping, the answer after the push.

const PAGE_URL = 'http://localhost:5757';
const TWO = { instruments: [{ id: 'mt32', model: 'mt32', port: 'Port A' }, { id: 'sc55', model: 'sc55', port: 'Port B' }] };
const GOOD = { port: 'Port B', channels: [1, 2, 3, 10], clock: false };

function fakePage() {
  const sent = [];
  return {
    sent,
    send(data) {
      sent.push(JSON.parse(data));
    },
  };
}

function authenticate(session, page) {
  const at = page.sent.length;
  session.handlePageMessage(page, { type: 'page-auth', token: session.ask.pageToken });
  assert.deepEqual(page.sent[at], { type: 'ask-auth', ok: true });
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

function sessionOn(dir) {
  const session = new Session({ rig: new RigStore({ dataDir: dir }) });
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);
  return { session, page, mark: page.sent.length };
}

const sendSettings = (session, page, settings = GOOD, instrument = 'sc55', id = 'st-1') =>
  session.handlePageMessage(page, { type: 'instrument-settings', id, instrument, settings });

test('an instrument-settings message from a page that never authenticated sends nothing and writes nothing', (t) => {
  const context = setup(t, TWO);
  const session = new Session({ rig: context.store });
  session.setPageUrl(PAGE_URL);
  const stranger = fakePage();
  const logged = captureErrors(() => sendSettings(session, stranger));
  assert.deepEqual(stranger.sent, []);
  untouched(context);
  assert.equal(logged.length, 1, logged.join('\n'));
  assert.ok(!logged[0].includes(context.dir));
});

test('a trusted page that is not the active one is refused, and nothing is written', (t) => {
  const context = setup(t, TWO);
  const session = new Session({ rig: context.store });
  session.setPageUrl(PAGE_URL);
  const first = fakePage();
  authenticate(session, first);
  authenticate(session, fakePage());
  const mark = first.sent.length;
  const logged = captureErrors(() => sendSettings(session, first));
  assert.deepEqual(first.sent.slice(mark), [
    { type: 'instrument-result', id: 'st-1', ok: false, kind: 'refused', reason: 'this tab is not the one that plays, so nothing was saved' },
  ]);
  untouched(context);
  assert.ok(logged.every((line) => !line.includes(context.dir)));
});

test('a saved edit sends exactly midi-rig then instrument-result, and Claude is told once', (t) => {
  const context = setup(t, TWO);
  const { session, page, mark } = sessionOn(context.dir);
  sendSettings(session, page);
  const frames = page.sent.slice(mark);
  assert.deepEqual(frames.map((frame) => frame.type), ['midi-rig', 'instrument-result']);
  assert.deepEqual(frames[0].instruments[1].channels.map((entry) => entry.channel), [1, 2, 3, 10]);
  assert.deepEqual(frames[1], { type: 'instrument-result', id: 'st-1', ok: true });
  const notices = session.drainNotices().lines.filter((line) => line.startsWith('MIDI:'));
  assert.deepEqual(notices, ['MIDI: the user changed "sc55": channels 1-16 became 1-3, 10.']);
  assert.deepEqual(session.drainNotices().lines.filter((line) => line.startsWith('MIDI:')), []);
});

test('an edit that changes nothing is answered ok with no rig push, no notice and no write', (t) => {
  const context = setup(t, TWO);
  const { session, page, mark } = sessionOn(context.dir);
  sendSettings(session, page, { port: 'Port B', channels: ALL_SC55, clock: false });
  assert.deepEqual(page.sent.slice(mark), [{ type: 'instrument-result', id: 'st-1', ok: true }]);
  assert.deepEqual(session.drainNotices().lines.filter((line) => line.startsWith('MIDI:')), []);
  untouched(context);
});

test('an invalid edit answers kind invalid with its problems and pushes nothing', (t) => {
  const context = setup(t, TWO);
  const { session, page, mark } = sessionOn(context.dir);
  sendSettings(session, page, { port: 'Port A', channels: [1, 2], clock: false });
  const frames = page.sent.slice(mark);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].kind, 'invalid');
  assert.equal(frames[0].ok, false);
  assert.deepEqual(frames[0].problems, [{ field: 'instruments[1].port', reason: 'same port as instruments[0] ("mt32")' }]);
  assert.equal(frames[0].more, 0);
  assert.deepEqual(session.drainNotices().lines.filter((line) => line.startsWith('MIDI:')), []);
  untouched(context);
});

test('a write failure answers write-failed, pushes no rig, queues no notice, and no log line holds the data folder', (t) => {
  const context = setup(t, TWO);
  fs.mkdirSync(`${context.file}.tmp`);
  const { session, page, mark } = sessionOn(context.dir);
  const logged = captureErrors(() => sendSettings(session, page));
  const frames = page.sent.slice(mark);
  assert.deepEqual(frames.map((frame) => frame.type), ['instrument-result']);
  assert.equal(frames[0].kind, 'write-failed');
  assert.match(frames[0].reason, /^the file system answered E[A-Z]+$/);
  assert.equal(logged.length, 1, logged.join('\n'));
  assert.match(logged[0], /^\[moontide\] Instrument settings could not be saved: the file system answered E[A-Z]+$/);
  for (const text of [...logged, JSON.stringify(frames)]) assert.ok(!text.includes(context.dir), 'nothing holds the data folder');
  assert.deepEqual(session.drainNotices().lines.filter((line) => line.startsWith('MIDI:')), []);
  assert.equal(fs.readFileSync(context.file, 'utf8'), context.text);
});

test('no instruments.json, no store and an unknown instrument are refused', (t) => {
  const noFile = sessionOn(makeDir(t));
  sendSettings(noFile.session, noFile.page);
  assert.deepEqual(noFile.page.sent.slice(noFile.mark), [
    { type: 'instrument-result', id: 'st-1', ok: false, kind: 'refused', reason: 'there is no instruments.json, so there is nothing to change' },
  ]);

  const session = new Session();
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);
  const mark = page.sent.length;
  sendSettings(session, page);
  assert.equal(page.sent.slice(mark)[0].reason, 'there is no instruments.json, so there is nothing to change');

  const context = setup(t, TWO);
  const known = sessionOn(context.dir);
  sendSettings(known.session, known.page, GOOD, 'zz');
  assert.equal(known.page.sent.slice(known.mark)[0].reason, 'there is no instrument "zz" in instruments.json');
});
