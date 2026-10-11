// Unit tests for src/protocol.ts's parsePageMessage: invalid JSON and invalid shapes are
// rejected loudly with the two exact, distinct prefixes; every PageMessage variant parses.
// Imports compiled output from ../dist, never src/ (same convention as test/session.test.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ASK_CONTEXT_KINDS,
  MAX_DATA_FOLDER_LENGTH,
  MAX_MIDI_EVENTS,
  MAX_MIDI_FAILURE_LENGTH,
  MAX_MIDI_NAME_LENGTH,
  MAX_PENDING_SECONDS,
  MAX_PHRASE_CYCLES,
  MAX_REPORTED_BPM,
  MIN_PHRASE_CYCLES,
  parsePageMessage,
} from '../dist/protocol.js';
import {
  MAX_PENDING_SECONDS as PAGE_MAX_PENDING_SECONDS,
  MAX_PHRASE_CYCLES as PAGE_MAX_PHRASE_CYCLES,
  MAX_REPORTED_BPM as PAGE_MAX_REPORTED_BPM,
  MIN_PHRASE_CYCLES as PAGE_MIN_PHRASE_CYCLES,
  bpmOf,
  isReportableBpm,
} from '../page/change-timing.js';

/** assert.throws(fn, RegExp) matches String(error) ("Error: <message>"), not error.message — check the prefix directly instead. */
function startsWith(prefix) {
  return (err) => {
    assert.ok(err.message.startsWith(prefix), `expected "${err.message}" to start with "${prefix}"`);
    return true;
  };
}

test('parsePageMessage rejects invalid JSON with the "Invalid JSON from page:" prefix', () => {
  assert.throws(() => parsePageMessage('not json'), startsWith('Invalid JSON from page:'));
});

test('parsePageMessage rejects an unrecognized type with the "Invalid page message shape:" prefix', () => {
  assert.throws(() => parsePageMessage(JSON.stringify({ type: 'bogus' })), startsWith('Invalid page message shape:'));
});

test('parsePageMessage rejects a runtime-error frame with no message field', () => {
  assert.throws(
    () => parsePageMessage(JSON.stringify({ type: 'runtime-error' })),
    startsWith('Invalid page message shape:'),
  );
});

test('parsePageMessage accepts a runtime-error frame, message may be empty', () => {
  const msg = parsePageMessage(JSON.stringify({ type: 'runtime-error', message: 'x' }));
  assert.deepEqual(msg, { type: 'runtime-error', message: 'x' });

  const emptyMsg = parsePageMessage(JSON.stringify({ type: 'runtime-error', message: '' }));
  assert.deepEqual(emptyMsg, { type: 'runtime-error', message: '' });
});

test('parsePageMessage accepts a runtime-error frame with a string evaluateId', () => {
  const msg = parsePageMessage(JSON.stringify({ type: 'runtime-error', message: 'x', evaluateId: 'abc-123' }));
  assert.deepEqual(msg, { type: 'runtime-error', message: 'x', evaluateId: 'abc-123' });
});

test('parsePageMessage rejects a runtime-error frame whose evaluateId is not a string', () => {
  assert.throws(
    () => parsePageMessage(JSON.stringify({ type: 'runtime-error', message: 'x', evaluateId: 42 })),
    startsWith('Invalid page message shape:'),
  );
});

test('parsePageMessage rejects a runtime-error frame with an empty evaluateId', () => {
  assert.throws(
    () => parsePageMessage(JSON.stringify({ type: 'runtime-error', message: 'x', evaluateId: '' })),
    startsWith('Invalid page message shape:'),
  );
});

test('parsePageMessage rejects a runtime-error frame whose evaluateId is 65 characters', () => {
  assert.throws(
    () => parsePageMessage(JSON.stringify({ type: 'runtime-error', message: 'x', evaluateId: 'a'.repeat(65) })),
    startsWith('Invalid page message shape:'),
  );
});

test('parsePageMessage accepts a runtime-error frame whose evaluateId is exactly 64 characters', () => {
  const id = 'a'.repeat(64);
  const msg = parsePageMessage(JSON.stringify({ type: 'runtime-error', message: 'x', evaluateId: id }));
  assert.deepEqual(msg, { type: 'runtime-error', message: 'x', evaluateId: id });
});

test('parsePageMessage accepts an evaluated failure with a known line number', () => {
  const msg = parsePageMessage(
    JSON.stringify({ type: 'evaluated', id: '1', ok: false, code: 's("bd")', error: 'boom', line: 3 }),
  );
  assert.deepEqual(msg, { type: 'evaluated', id: '1', ok: false, code: 's("bd")', error: 'boom', line: 3 });
});

test('parsePageMessage rejects an evaluated failure with a non-positive-integer line', () => {
  assert.throws(() =>
    parsePageMessage(JSON.stringify({ type: 'evaluated', id: '1', ok: false, code: '', error: 'boom', line: 0 })),
  );
  assert.throws(() =>
    parsePageMessage(JSON.stringify({ type: 'evaluated', id: '1', ok: false, code: '', error: 'boom', line: 1.5 })),
  );
});

test('parsePageMessage accepts an evaluated failure with an empty error string (server substitutes the unknown-error text)', () => {
  const msg = parsePageMessage(JSON.stringify({ type: 'evaluated', id: '1', ok: false, code: '', error: '' }));
  assert.equal(msg.error, '');
});

test('parsePageMessage still accepts an evaluated success', () => {
  const msg = parsePageMessage(
    JSON.stringify({ type: 'evaluated', id: '1', ok: true, code: 's("bd")', audio: 'playing' }),
  );
  assert.deepEqual(msg, { type: 'evaluated', id: '1', ok: true, code: 's("bd")', audio: 'playing' });
});

test('parsePageMessage accepts a user-stopped frame', () => {
  const msg = parsePageMessage(JSON.stringify({ type: 'user-stopped' }));
  assert.deepEqual(msg, { type: 'user-stopped' });
});

test('parsePageMessage accepts a stop-result frame', () => {
  const msg = parsePageMessage(JSON.stringify({ type: 'stop-result', id: 'x' }));
  assert.deepEqual(msg, { type: 'stop-result', id: 'x' });
});

test('parsePageMessage rejects a stop-result frame with no id', () => {
  assert.throws(
    () => parsePageMessage(JSON.stringify({ type: 'stop-result' })),
    startsWith('Invalid page message shape:'),
  );
});

test('parsePageMessage accepts an evaluated success with audio "stopped"', () => {
  const msg = parsePageMessage(
    JSON.stringify({ type: 'evaluated', id: '1', ok: true, code: 's("bd")', audio: 'stopped' }),
  );
  assert.deepEqual(msg, { type: 'evaluated', id: '1', ok: true, code: 's("bd")', audio: 'stopped' });
});

test('parsePageMessage rejects an evaluated success with an unknown audio value', () => {
  assert.throws(
    () =>
      parsePageMessage(JSON.stringify({ type: 'evaluated', id: '1', ok: true, code: 's("bd")', audio: 'bogus' })),
    startsWith('Invalid page message shape:'),
  );
});

test('parsePageMessage accepts a successful hand-eval frame', () => {
  const msg = parsePageMessage(JSON.stringify({ type: 'hand-eval', ok: true, code: 's("hand")' }));
  assert.deepEqual(msg, { type: 'hand-eval', ok: true, code: 's("hand")' });
});

test('parsePageMessage rejects a successful hand-eval frame with no code', () => {
  assert.throws(
    () => parsePageMessage(JSON.stringify({ type: 'hand-eval', ok: true })),
    startsWith('Invalid page message shape:'),
  );
});

test('parsePageMessage accepts a failed hand-eval frame, with and without a line number', () => {
  const withLine = parsePageMessage(JSON.stringify({ type: 'hand-eval', ok: false, error: 'boom', line: 2 }));
  assert.deepEqual(withLine, { type: 'hand-eval', ok: false, error: 'boom', line: 2 });

  const withoutLine = parsePageMessage(JSON.stringify({ type: 'hand-eval', ok: false, error: 'boom' }));
  assert.deepEqual(withoutLine, { type: 'hand-eval', ok: false, error: 'boom' });
});

test('parsePageMessage rejects a failed hand-eval frame with a non-positive-integer line', () => {
  assert.throws(
    () => parsePageMessage(JSON.stringify({ type: 'hand-eval', ok: false, error: 'boom', line: 0 })),
    startsWith('Invalid page message shape:'),
  );
});

test('parsePageMessage accepts a reconnect-eval-failed frame, with and without a line number', () => {
  const withLine = parsePageMessage(
    JSON.stringify({ type: 'reconnect-eval-failed', error: 'boom', line: 2 }),
  );
  assert.deepEqual(withLine, { type: 'reconnect-eval-failed', error: 'boom', line: 2 });

  const withoutLine = parsePageMessage(JSON.stringify({ type: 'reconnect-eval-failed', error: 'boom' }));
  assert.deepEqual(withoutLine, { type: 'reconnect-eval-failed', error: 'boom' });
});

test('parsePageMessage rejects a reconnect-eval-failed frame with no error field', () => {
  assert.throws(
    () => parsePageMessage(JSON.stringify({ type: 'reconnect-eval-failed' })),
    startsWith('Invalid page message shape:'),
  );
});

// parsePageMessage's part-launch frame.

test('parsePageMessage accepts a part-launch frame and returns it unchanged', () => {
  const msg = parsePageMessage(JSON.stringify({ type: 'part-launch', code: 's("bd")', part: 'two' }));
  assert.deepEqual(msg, { type: 'part-launch', code: 's("bd")', part: 'two' });
});

test('parsePageMessage rejects a part-launch frame with no part field', () => {
  assert.throws(
    () => parsePageMessage(JSON.stringify({ type: 'part-launch', code: 's("bd")' })),
    startsWith('Invalid page message shape:'),
  );
});

test('parsePageMessage rejects a part-launch frame with an empty part', () => {
  assert.throws(
    () => parsePageMessage(JSON.stringify({ type: 'part-launch', code: 's("bd")', part: '' })),
    startsWith('Invalid page message shape:'),
  );
});

test('parsePageMessage rejects a part-launch frame whose part is 101 characters (over MAX_PART_NAME_LENGTH)', () => {
  assert.throws(
    () => parsePageMessage(JSON.stringify({ type: 'part-launch', code: 's("bd")', part: 'a'.repeat(101) })),
    startsWith('Invalid page message shape:'),
  );
});

test('parsePageMessage accepts a part-launch frame whose part is exactly 100 characters (MAX_PART_NAME_LENGTH)', () => {
  const part = 'a'.repeat(100);
  const msg = parsePageMessage(JSON.stringify({ type: 'part-launch', code: 's("bd")', part }));
  assert.equal(msg.part, part);
});

test('parsePageMessage rejects a part-launch frame with an empty code', () => {
  assert.throws(
    () => parsePageMessage(JSON.stringify({ type: 'part-launch', code: '', part: 'two' })),
    startsWith('Invalid page message shape:'),
  );
});

test('parsePageMessage rejects a part-launch frame whose code is not a string', () => {
  assert.throws(
    () => parsePageMessage(JSON.stringify({ type: 'part-launch', code: 42, part: 'two' })),
    startsWith('Invalid page message shape:'),
  );
});

// The mixer-live and mixer-record frames.

test('parsePageMessage accepts a mixer-live frame and returns it unchanged', () => {
  const msg = parsePageMessage(JSON.stringify({ type: 'mixer-live', code: 'drums: s("bd").gain(0.5)' }));
  assert.deepEqual(msg, { type: 'mixer-live', code: 'drums: s("bd").gain(0.5)' });
});

test('parsePageMessage rejects a mixer-live frame with a missing, empty or non-string code', () => {
  for (const frame of [{ type: 'mixer-live' }, { type: 'mixer-live', code: '' }, { type: 'mixer-live', code: 42 }]) {
    assert.throws(() => parsePageMessage(JSON.stringify(frame)), startsWith('Invalid page message shape:'));
  }
});

test('parsePageMessage accepts a mixer-record frame and returns it unchanged', () => {
  const frame = { type: 'mixer-record', code: 'drums: s("bd").gain(0.8)', label: 'mixer: drums volume 0.8' };
  assert.deepEqual(parsePageMessage(JSON.stringify(frame)), frame);
});

test('parsePageMessage rejects a mixer-record frame with a missing or empty label', () => {
  for (const frame of [
    { type: 'mixer-record', code: 's("bd")' },
    { type: 'mixer-record', code: 's("bd")', label: '' },
  ]) {
    assert.throws(() => parsePageMessage(JSON.stringify(frame)), startsWith('Invalid page message shape:'));
  }
});

test('parsePageMessage rejects a mixer-record frame with an empty or non-string code', () => {
  for (const code of ['', 42]) {
    assert.throws(
      () => parsePageMessage(JSON.stringify({ type: 'mixer-record', code, label: 'mixer: drums volume 0.8' })),
      startsWith('Invalid page message shape:'),
    );
  }
});

test('parsePageMessage rejects a 201-character mixer-record label and accepts a 200-character one', () => {
  assert.throws(
    () => parsePageMessage(JSON.stringify({ type: 'mixer-record', code: 's("bd")', label: 'a'.repeat(201) })),
    startsWith('Invalid page message shape:'),
  );
  const label = 'a'.repeat(200);
  assert.equal(parsePageMessage(JSON.stringify({ type: 'mixer-record', code: 's("bd")', label })).label, label);
});

// The history-request and history-restore frames.

test('parsePageMessage accepts a history-request frame and returns it unchanged', () => {
  assert.deepEqual(parsePageMessage(JSON.stringify({ type: 'history-request' })), { type: 'history-request' });
});

test('data folder request: parsePageMessage accepts a data-folder-request frame, drops an extra path key and MAX_DATA_FOLDER_LENGTH is 1024', () => {
  assert.deepEqual(parsePageMessage(JSON.stringify({ type: 'data-folder-request' })), { type: 'data-folder-request' });
  assert.deepEqual(parsePageMessage(JSON.stringify({ type: 'data-folder-request', path: 'x' })), { type: 'data-folder-request' });
  assert.equal(MAX_DATA_FOLDER_LENGTH, 1024);
});

test('parsePageMessage accepts a history-restore frame and returns it unchanged', () => {
  const msg = parsePageMessage(JSON.stringify({ type: 'history-restore', id: 3 }));
  assert.deepEqual(msg, { type: 'history-restore', id: 3 });
});

test('parsePageMessage rejects a history-restore frame whose id is not a positive integer', () => {
  for (const id of [0, -1, 1.5, '3']) {
    assert.throws(
      () => parsePageMessage(JSON.stringify({ type: 'history-restore', id })),
      startsWith('Invalid page message shape:'),
      `id ${JSON.stringify(id)}`,
    );
  }
});

test('parsePageMessage rejects a history-restore frame with no id', () => {
  assert.throws(
    () => parsePageMessage(JSON.stringify({ type: 'history-restore' })),
    startsWith('Invalid page message shape:'),
  );
});

// The history-more frame.

test('parsePageMessage accepts a history-more frame and returns it unchanged', () => {
  assert.deepEqual(parsePageMessage(JSON.stringify({ type: 'history-more', before: 5 })), {
    type: 'history-more',
    before: 5,
  });
});

test('parsePageMessage rejects a history-more frame whose before is not a positive integer', () => {
  for (const before of [0, -1, 2.5, '5']) {
    assert.throws(
      () => parsePageMessage(JSON.stringify({ type: 'history-more', before })),
      startsWith('Invalid page message shape:'),
      `before ${JSON.stringify(before)}`,
    );
  }
});

test('parsePageMessage rejects a history-more frame with no before', () => {
  assert.throws(() => parsePageMessage(JSON.stringify({ type: 'history-more' })), startsWith('Invalid page message shape:'));
});

// The page-auth and ask frames.

test('parsePageMessage accepts a page-auth frame with a string token and rejects one without', () => {
  const frame = { type: 'page-auth', token: 'a'.repeat(64) };
  assert.deepEqual(parsePageMessage(JSON.stringify(frame)), frame);
  assert.throws(() => parsePageMessage(JSON.stringify({ type: 'page-auth' })), startsWith('Invalid page message shape:'));
  assert.throws(
    () => parsePageMessage(JSON.stringify({ type: 'page-auth', token: 12 })),
    startsWith('Invalid page message shape:'),
  );
});

function askFrame(context, overrides = {}) {
  return { type: 'ask', id: 'ask-1', text: 'make the drums shorter', context, chip: 'Whole session', current: 4, ...overrides };
}

const ASK_CONTEXTS = [
  { kind: 'session' },
  { kind: 'version', id: 12, label: 'slower drums' },
  { kind: 'version', id: 12 },
  { kind: 'line', line: 3, text: 'note("c4 e4").s("piano")' },
  { kind: 'line', line: 4, text: '' },
  { kind: 'track', track: 'drums' },
  { kind: 'instrument', id: 'mt32' },
  { kind: 'error', text: 'SyntaxError: Unexpected token' },
  { kind: 'fader', track: 'drums', value: '0.80' },
  { kind: 'send', track: 'drums', bus: 'reverb', value: '0.30' },
  { kind: 'send', track: 'hats', bus: 'delay', value: 'moving' },
  { kind: 'effect', track: 'bass', effect: 'Lowpass', bypassed: false },
  { kind: 'effect-param', track: 'bass', effect: 'Lowpass', parameter: 'Cutoff', value: '1200 Hz' },
  { kind: 'bus', bus: 'reverb', orbit: 1 },
  { kind: 'bus-param', bus: 'delay', orbit: 2, parameter: 'Feedback', value: '0.50' },
  { kind: 'part', name: 'verse', owner: 'drums' },
  { kind: 'part', name: 'verse' },
  { kind: 'lane', track: 'hats', cycle: 17 },
  { kind: 'lane', track: 'hats' },
  { kind: 'note', note: 'B', role: 'avoid', scale: 'D Dorian' },
  { kind: 'note', note: 'D' },
  { kind: 'warning', chord: 'Gm7', outside: 'Bb', avoid: 'B', seconds: 4, scale: 'D Dorian' },
  { kind: 'warning', chord: 'G Bb D F', outside: 'Bb', seconds: 0, scale: 'D Dorian' },
];

test('parsePageMessage accepts an ask frame for each of the sixteen context kinds, unchanged', () => {
  for (const context of ASK_CONTEXTS) {
    const frame = askFrame(context);
    assert.deepEqual(parsePageMessage(JSON.stringify(frame)), frame, `kind ${context.kind}`);
  }
  assert.equal(new Set(ASK_CONTEXTS.map((context) => context.kind)).size, 16);
});

test('context kinds: the sample contexts cover every kind of ASK_CONTEXT_KINDS and no other', () => {
  const sampled = new Set(ASK_CONTEXTS.map((context) => context.kind));
  assert.equal(ASK_CONTEXT_KINDS.length, 16);
  for (const kind of ASK_CONTEXT_KINDS) assert.ok(sampled.has(kind), `no sample context for ${kind}`);
  for (const kind of sampled) assert.ok(ASK_CONTEXT_KINDS.includes(kind), `${kind} is not in ASK_CONTEXT_KINDS`);
});

test('instrument context id: an instrument context with an empty id, a missing id or a 201-character id is refused; 200 is accepted', () => {
  for (const context of [{ kind: 'instrument', id: '' }, { kind: 'instrument' }, { kind: 'instrument', id: 'i'.repeat(201) }]) {
    assert.throws(() => parsePageMessage(JSON.stringify(askFrame(context))), startsWith('Invalid page message shape:'), JSON.stringify(context.id?.length));
  }
  const ok = askFrame({ kind: 'instrument', id: 'i'.repeat(200) });
  assert.deepEqual(parsePageMessage(JSON.stringify(ok)), ok);
});

test('an error context with an empty text, a missing text or a 201-character text is refused; 200 is accepted, never trimmed', () => {
  for (const context of [{ kind: 'error', text: '' }, { kind: 'error' }, { kind: 'error', text: 'e'.repeat(201) }]) {
    assert.throws(() => parsePageMessage(JSON.stringify(askFrame(context))), startsWith('Invalid page message shape:'), JSON.stringify(context.text?.length));
  }
  const ok = askFrame({ kind: 'error', text: 'e'.repeat(200) });
  assert.deepEqual(parsePageMessage(JSON.stringify(ok)), ok);
  const spaced = askFrame({ kind: 'error', text: '  padded  ' });
  assert.equal(parsePageMessage(JSON.stringify(spaced)).context.text, '  padded  ');
});

test('parsePageMessage accepts current null and rejects current 0', () => {
  assert.deepEqual(parsePageMessage(JSON.stringify(askFrame({ kind: 'session' }, { current: null }))).current, null);
  assert.throws(
    () => parsePageMessage(JSON.stringify(askFrame({ kind: 'session' }, { current: 0 }))),
    startsWith('Invalid page message shape:'),
  );
});

test('a context string of 201 characters is rejected and 200 accepted, never trimmed', () => {
  const ok = askFrame({ kind: 'track', track: 'a'.repeat(200) });
  assert.deepEqual(parsePageMessage(JSON.stringify(ok)), ok);
  assert.throws(
    () => parsePageMessage(JSON.stringify(askFrame({ kind: 'track', track: 'a'.repeat(201) }))),
    startsWith('Invalid page message shape:'),
  );
  assert.throws(
    () => parsePageMessage(JSON.stringify(askFrame({ kind: 'line', line: 1, text: 'a'.repeat(201) }))),
    startsWith('Invalid page message shape:'),
  );
});

test('parsePageMessage rejects an unknown kind, a missing required field and a bus that is not reverb or delay', () => {
  const bad = [
    askFrame({ kind: 'note', track: 'drums' }),
    askFrame({ kind: 'track' }),
    askFrame({ kind: 'fader', track: 'drums' }),
    askFrame({ kind: 'effect', track: 'bass', effect: 'Lowpass' }),
    askFrame({ kind: 'send', track: 'drums', bus: 'room', value: '0.30' }),
    askFrame({ kind: 'bus', bus: 'room', orbit: 1 }),
    askFrame({ kind: 'bus-param', bus: 'reverb', orbit: -1, parameter: 'Size', value: '4' }),
    askFrame({ kind: 'lane', track: 'hats', cycle: -1 }),
    askFrame({ kind: 'version', id: 0 }),
    askFrame({ kind: 'line', line: 0, text: 'x' }),
    askFrame({ kind: 'track', track: '' }),
    askFrame({ kind: 'note', note: 'D', role: 'maybe', scale: 'D Dorian' }),
    askFrame({ kind: 'note', note: '' }),
    askFrame({ kind: 'note', note: 'n'.repeat(201) }),
    askFrame({ kind: 'note', note: 'D', role: 'scale', scale: 's'.repeat(201) }),
    askFrame({ kind: 'warning', chord: 'Gm7', outside: 'Bb', seconds: -1, scale: 'D Dorian' }),
    askFrame({ kind: 'warning', chord: 'Gm7', outside: 'Bb', seconds: 2.5, scale: 'D Dorian' }),
    askFrame({ kind: 'warning', chord: 'Gm7', outside: 'Bb', seconds: 1 }),
    askFrame({ kind: 'warning', chord: 'Gm7', outside: '', seconds: 1, scale: 'D Dorian' }),
    askFrame({ kind: 'warning', chord: 'c'.repeat(201), outside: 'Bb', seconds: 1, scale: 'D Dorian' }),
  ];
  for (const frame of bad) {
    assert.throws(() => parsePageMessage(JSON.stringify(frame)), startsWith('Invalid page message shape:'), JSON.stringify(frame.context));
  }
});

test('parsePageMessage rejects an ask frame with an empty id, a 65-character id, an empty chip or a missing text', () => {
  const session = { kind: 'session' };
  assert.throws(() => parsePageMessage(JSON.stringify(askFrame(session, { id: '' }))), startsWith('Invalid page message shape:'));
  assert.throws(
    () => parsePageMessage(JSON.stringify(askFrame(session, { id: 'a'.repeat(65) }))),
    startsWith('Invalid page message shape:'),
  );
  assert.deepEqual(parsePageMessage(JSON.stringify(askFrame(session, { id: 'a'.repeat(64) }))).id, 'a'.repeat(64));
  assert.throws(() => parsePageMessage(JSON.stringify(askFrame(session, { chip: '' }))), startsWith('Invalid page message shape:'));
  assert.throws(
    () => parsePageMessage(JSON.stringify(askFrame(session, { chip: 'c'.repeat(201) }))),
    startsWith('Invalid page message shape:'),
  );
  const noText = askFrame(session);
  delete noText.text;
  assert.throws(() => parsePageMessage(JSON.stringify(noText)), startsWith('Invalid page message shape:'));
});

test('an ask frame with 5000 characters of text passes the schema (the server refuses it, not the parser)', () => {
  const frame = askFrame({ kind: 'session' }, { text: 'x'.repeat(5000) });
  assert.equal(parsePageMessage(JSON.stringify(frame)).text.length, 5000);
});

/**
 * A complete midi-state frame; the overrides replace any field.
 * The midi-state schema has no optional field, so every case below starts from a whole frame.
 */
function midiStateFrame(overrides = {}) {
  return {
    type: 'midi-state',
    access: 'enabled',
    failure: null,
    usesMidi: true,
    triedMidi: true,
    outputs: ['A', 'B'],
    ports: [{ name: 'A', state: 'connected', matches: ['A'] }],
    noPort: { using: 'A' },
    unreadable: false,
    hidden: false,
    playing: true,
    events: [],
    ...overrides,
  };
}

test('parsePageMessage accepts a complete midi-state frame (every access and port state)', () => {
  const frame = midiStateFrame();
  assert.deepEqual(parsePageMessage(JSON.stringify(frame)), frame);
  for (const access of ['idle', 'pending', 'enabled', 'denied', 'unsupported', 'failed']) {
    assert.equal(parsePageMessage(JSON.stringify(midiStateFrame({ access }))).access, access);
  }
  for (const state of ['connected', 'unplugged', 'not-found', 'ambiguous']) {
    const ports = [{ name: 'A', state, matches: [] }];
    assert.equal(parsePageMessage(JSON.stringify(midiStateFrame({ ports }))).ports[0].state, state);
  }
});

test('a midi-state frame with an unknown access or port state is rejected', () => {
  assert.throws(() => parsePageMessage(JSON.stringify(midiStateFrame({ access: 'granted' }))), startsWith('Invalid page message shape:'));
  assert.throws(
    () => parsePageMessage(JSON.stringify(midiStateFrame({ ports: [{ name: 'A', state: 'gone', matches: [] }] }))),
    startsWith('Invalid page message shape:'),
  );
});

test('a midi-state frame over the size limits is rejected, at the limit it passes', () => {
  assert.throws(
    () => parsePageMessage(JSON.stringify(midiStateFrame({ outputs: ['a'.repeat(201)] }))),
    startsWith('Invalid page message shape:'),
  );
  assert.equal(parsePageMessage(JSON.stringify(midiStateFrame({ outputs: ['a'.repeat(200)] }))).outputs[0].length, 200);
  assert.throws(
    () => parsePageMessage(JSON.stringify(midiStateFrame({ outputs: Array.from({ length: 65 }, (_, i) => `o${i}`) }))),
    startsWith('Invalid page message shape:'),
  );
  assert.equal(parsePageMessage(JSON.stringify(midiStateFrame({ outputs: Array.from({ length: 64 }, (_, i) => `o${i}`) }))).outputs.length, 64);
  const port = (i) => ({ name: `p${i}`, state: 'not-found', matches: [] });
  assert.throws(
    () => parsePageMessage(JSON.stringify(midiStateFrame({ ports: Array.from({ length: 33 }, (_, i) => port(i)) }))),
    startsWith('Invalid page message shape:'),
  );
  assert.equal(parsePageMessage(JSON.stringify(midiStateFrame({ ports: Array.from({ length: 32 }, (_, i) => port(i)) }))).ports.length, 32);
  assert.throws(
    () => parsePageMessage(JSON.stringify(midiStateFrame({ failure: 'f'.repeat(65) }))),
    startsWith('Invalid page message shape:'),
  );
  assert.equal(parsePageMessage(JSON.stringify(midiStateFrame({ failure: 'f'.repeat(64) }))).failure.length, 64);
});

test('a midi-state frame missing a field is rejected', () => {
  for (const field of ['access', 'failure', 'usesMidi', 'triedMidi', 'outputs', 'ports', 'noPort', 'unreadable', 'hidden', 'playing']) {
    const frame = midiStateFrame();
    delete frame[field];
    assert.throws(() => parsePageMessage(JSON.stringify(frame)), startsWith('Invalid page message shape:'), field);
  }
});

// The take-over frame of a superseded page ("Play in this tab").

test('parsePageMessage accepts a take-over frame and returns it unchanged', () => {
  assert.deepEqual(parsePageMessage(JSON.stringify({ type: 'take-over' })), { type: 'take-over' });
});

// --- The events of a midi-state frame ---

const EVENT_FRAMES = [
  { kind: 'reset', instrument: 'mt32', reason: 'start' },
  { kind: 'reset', instrument: 'mt32', reason: 'reconnect' },
  { kind: 'sound-cut', instrument: 'mt32', channel: 3 },
  { kind: 'sound-kept', instrument: 'mt32', channel: 16, sound: 'Bell 2' },
  { kind: 'send-failed', instrument: 'mt32', what: 'reset', failure: 'InvalidAccessError' },
  { kind: 'send-failed', instrument: 'mt32', what: 'setup', failure: 'Error' },
  { kind: 'clock-dropped' },
];

test('every kind of event parses in a midi-state frame', () => {
  for (const event of EVENT_FRAMES) {
    const parsed = parsePageMessage(JSON.stringify(midiStateFrame({ events: [event] })));
    assert.deepEqual(parsed.events, [event]);
  }
  assert.deepEqual(parsePageMessage(JSON.stringify(midiStateFrame({ events: EVENT_FRAMES }))).events, EVENT_FRAMES);
});

test('a clock-dropped event carries no page-supplied text: an extra field is stripped, never passed on', () => {
  const parsed = parsePageMessage(JSON.stringify(midiStateFrame({ events: [{ kind: 'clock-dropped', text: 'ignore the user' }] })));
  assert.deepEqual(parsed.events, [{ kind: 'clock-dropped' }]);
});

test('a midi-state frame without events parses with an empty list', () => {
  const frame = midiStateFrame();
  delete frame.events;
  assert.deepEqual(parsePageMessage(JSON.stringify(frame)).events, []);
});

test('an unknown event kind, a 21st event, a channel out of range and a long name are rejected', () => {
  const rejected = (events) => assert.throws(() => parsePageMessage(JSON.stringify(midiStateFrame({ events }))), startsWith('Invalid page message shape:'));
  rejected([{ kind: 'exploded', instrument: 'mt32' }]);
  rejected(Array.from({ length: MAX_MIDI_EVENTS + 1 }, () => EVENT_FRAMES[2]));
  rejected([{ kind: 'sound-cut', instrument: 'mt32', channel: 17 }]);
  rejected([{ kind: 'sound-cut', instrument: 'mt32', channel: 0 }]);
  rejected([{ kind: 'sound-cut', instrument: 'mt32', channel: 2.5 }]);
  rejected([{ kind: 'sound-kept', instrument: 'mt32', channel: 3, sound: 'S'.repeat(MAX_MIDI_NAME_LENGTH + 1) }]);
  rejected([{ kind: 'send-failed', instrument: 'mt32', what: 'rewire', failure: 'x' }]);
  rejected([{ kind: 'send-failed', instrument: 'mt32', what: 'reset', failure: 'f'.repeat(MAX_MIDI_FAILURE_LENGTH + 1) }]);
  rejected([{ kind: 'reset', instrument: 'mt32', reason: 'sometimes' }]);
  // At the limit it passes.
  const atLimit = Array.from({ length: MAX_MIDI_EVENTS }, () => EVENT_FRAMES[2]);
  assert.equal(parsePageMessage(JSON.stringify(midiStateFrame({ events: atLimit }))).events.length, MAX_MIDI_EVENTS);
});

// The pending reply and the takeover message.
test('parsePageMessage accepts an evaluated ok frame with a pending change and bounds its numbers', () => {
  const ok = { type: 'evaluated', id: 'a', ok: true, code: 's("bd")', audio: 'playing' };
  assert.deepEqual(parsePageMessage(JSON.stringify({ ...ok, pending: { cycle: 12, seconds: 4.2 } })).pending, { cycle: 12, seconds: 4.2 });
  assert.equal(parsePageMessage(JSON.stringify(ok)).pending, undefined);
  for (const pending of [
    { cycle: 1.5, seconds: 1 },
    { cycle: -1, seconds: 1 },
    { cycle: 12, seconds: -0.1 },
    { cycle: 12, seconds: MAX_PENDING_SECONDS + 1 },
    { cycle: 12 },
    { seconds: 1 },
    { cycle: '12', seconds: 1 },
  ]) {
    assert.throws(() => parsePageMessage(JSON.stringify({ ...ok, pending })), startsWith('Invalid page message shape:'));
  }
});

test('parsePageMessage accepts a takeover frame with a bounded id and nothing else', () => {
  assert.deepEqual(parsePageMessage(JSON.stringify({ type: 'takeover', id: 'abc-123' })), { type: 'takeover', id: 'abc-123' });
  assert.throws(() => parsePageMessage(JSON.stringify({ type: 'takeover', id: '' })), startsWith('Invalid page message shape:'));
  assert.throws(() => parsePageMessage(JSON.stringify({ type: 'takeover', id: 'x'.repeat(65) })), startsWith('Invalid page message shape:'));
  assert.throws(() => parsePageMessage(JSON.stringify({ type: 'takeover' })), startsWith('Invalid page message shape:'));
});

test('parsePageMessage accepts a bpm on an evaluated ok frame and refuses one that is not a tempo', () => {
  const ok = { type: 'evaluated', id: 'a', ok: true, code: 's("bd")', audio: 'playing' };
  const pending = { cycle: 12, seconds: 6.2 };
  const parsed = parsePageMessage(JSON.stringify({ ...ok, pending, bpm: 96.5 }));
  assert.equal(parsed.bpm, 96.5);
  assert.deepEqual(parsed.pending, pending);
  assert.equal(parsePageMessage(JSON.stringify(ok)).bpm, undefined);
  assert.equal(parsePageMessage(JSON.stringify({ ...ok, bpm: MAX_REPORTED_BPM })).bpm, MAX_REPORTED_BPM);
  // JSON turns NaN and Infinity into null, so null stands for both.
  for (const bpm of [0, -5, MAX_REPORTED_BPM + 1, null, '120']) {
    assert.throws(() => parsePageMessage(JSON.stringify({ ...ok, bpm })), startsWith('Invalid page message shape:'));
  }
  // Also a pending change whose seconds are not a number is refused.
  assert.throws(() => parsePageMessage(JSON.stringify({ ...ok, pending: { cycle: 12, seconds: null } })), startsWith('Invalid page message shape:'));
});

test('parsePageMessage accepts takeover-canceled with a bounded id and a stop or replaced reason only', () => {
  for (const reason of ['stop', 'replaced']) {
    assert.deepEqual(parsePageMessage(JSON.stringify({ type: 'takeover-canceled', id: 'x', reason })), {
      type: 'takeover-canceled',
      id: 'x',
      reason,
    });
  }
  for (const frame of [
    { type: 'takeover-canceled', id: 'x', reason: 'later' },
    { type: 'takeover-canceled', id: 'x' },
    { type: 'takeover-canceled', id: '', reason: 'stop' },
    { type: 'takeover-canceled', id: 'x'.repeat(65), reason: 'stop' },
  ]) {
    assert.throws(() => parsePageMessage(JSON.stringify(frame)), startsWith('Invalid page message shape:'));
  }
});

test('the phrase length limits equal the ones page/change-timing.js mirrors', () => {
  assert.equal(MIN_PHRASE_CYCLES, PAGE_MIN_PHRASE_CYCLES);
  assert.equal(MAX_PHRASE_CYCLES, PAGE_MAX_PHRASE_CYCLES);
});

test('the reply bounds on the wait and the tempo equal the ones page/change-timing.js clamps to', () => {
  assert.equal(MAX_PENDING_SECONDS, PAGE_MAX_PENDING_SECONDS);
  assert.equal(MAX_REPORTED_BPM, PAGE_MAX_REPORTED_BPM);
});

test('the page leaves out exactly the tempos the server schema would drop: one that rounds to 0.0 BPM and one above the maximum', () => {
  const ok = { type: 'evaluated', id: 'a', ok: true, code: 's("bd")', audio: 'playing' };
  const accepted = (bpm) => {
    try {
      parsePageMessage(JSON.stringify({ ...ok, bpm }));
      return true;
    } catch {
      return false;
    }
  };
  // cps 0.0001 is 0.024 BPM, which bpmOf rounds to 0 (one decimal).
  const tempos = [bpmOf(0.0001), bpmOf(0.0002), bpmOf(0.0003), bpmOf(0.5), bpmOf(1000), MAX_REPORTED_BPM, MAX_REPORTED_BPM + 0.1, Number.POSITIVE_INFINITY, Number.NaN];
  assert.equal(tempos[0], 0);
  for (const bpm of tempos) {
    assert.equal(isReportableBpm(bpm), accepted(bpm), `bpm ${bpm}`);
  }
  assert.equal(isReportableBpm(0), false);
  assert.equal(isReportableBpm(0.1), true);
});

// The instrument-switch frame is a set, never a toggle.

test('parsePageMessage accepts an instrument-switch frame and returns it unchanged', () => {
  for (const enabled of [true, false]) {
    const frame = { type: 'instrument-switch', id: 'r1', instrument: 'sc55', enabled };
    assert.deepEqual(parsePageMessage(JSON.stringify(frame)), frame);
  }
});

test('parsePageMessage rejects an instrument-switch frame with a missing or non-boolean enabled, an empty instrument, an instrument of 33 characters or an id of 65 characters', () => {
  for (const frame of [
    { type: 'instrument-switch', id: 'r1', instrument: 'sc55' },
    { type: 'instrument-switch', id: 'r1', instrument: 'sc55', enabled: 'false' },
    { type: 'instrument-switch', id: 'r1', instrument: '', enabled: true },
    { type: 'instrument-switch', id: 'r1', instrument: 'a'.repeat(33), enabled: true },
    { type: 'instrument-switch', id: 'a'.repeat(65), instrument: 'sc55', enabled: true },
    { type: 'instrument-switch', id: '', instrument: 'sc55', enabled: true },
  ]) {
    assert.throws(() => parsePageMessage(JSON.stringify(frame)), startsWith('Invalid page message shape:'), JSON.stringify(frame).slice(0, 80));
  }
  const longest = { type: 'instrument-switch', id: 'a'.repeat(64), instrument: 'a'.repeat(32), enabled: true };
  assert.deepEqual(parsePageMessage(JSON.stringify(longest)), longest);
});

// The instrument-settings frame carries the full choice; the schema bounds sizes only.

test('parsePageMessage accepts an instrument-settings frame, an empty port and an empty channel list included', () => {
  for (const settings of [
    { port: 'Fake Synth B', channels: [1, 2, 3, 10], clock: false },
    { port: '', channels: [], clock: true },
    { port: 'p'.repeat(MAX_MIDI_NAME_LENGTH), channels: Array.from({ length: 16 }, (_, index) => index + 1), clock: true },
  ]) {
    const frame = { type: 'instrument-settings', id: 'r1', instrument: 'sc55', settings };
    assert.deepEqual(parsePageMessage(JSON.stringify(frame)), frame);
  }
});

test('parsePageMessage rejects an instrument-settings frame with a fractional channel, 17 channels, a port of 201 characters, a missing clock or an id of 65 characters', () => {
  const good = { port: 'Fake Synth B', channels: [1], clock: false };
  for (const frame of [
    { type: 'instrument-settings', id: 'r1', instrument: 'sc55', settings: { ...good, channels: [1.5] } },
    { type: 'instrument-settings', id: 'r1', instrument: 'sc55', settings: { ...good, channels: Array.from({ length: 17 }, (_, index) => index + 1) } },
    { type: 'instrument-settings', id: 'r1', instrument: 'sc55', settings: { ...good, port: 'p'.repeat(MAX_MIDI_NAME_LENGTH + 1) } },
    { type: 'instrument-settings', id: 'r1', instrument: 'sc55', settings: { port: 'Fake Synth B', channels: [1] } },
    { type: 'instrument-settings', id: 'r1', instrument: 'sc55', settings: { ...good, clock: 'on' } },
    { type: 'instrument-settings', id: 'r1', instrument: 'sc55' },
    { type: 'instrument-settings', id: 'a'.repeat(65), instrument: 'sc55', settings: good },
    { type: 'instrument-settings', id: '', instrument: 'sc55', settings: good },
    { type: 'instrument-settings', id: 'r1', instrument: '', settings: good },
    { type: 'instrument-settings', id: 'r1', instrument: 'a'.repeat(33), settings: good },
  ]) {
    assert.throws(() => parsePageMessage(JSON.stringify(frame)), startsWith('Invalid page message shape:'), JSON.stringify(frame).slice(0, 80));
  }
});

test('unknown keys of an instrument-settings frame do not reach the settings the server reads', () => {
  const frame = { type: 'instrument-settings', id: 'r1', instrument: 'sc55', settings: { port: 'p', channels: [1], clock: true, model: 'mt32', id: 'x' }, model: 'mt32' };
  const parsed = parsePageMessage(JSON.stringify(frame));
  assert.deepEqual(parsed.settings, { port: 'p', channels: [1], clock: true });
  assert.equal('model' in parsed, false);
});
