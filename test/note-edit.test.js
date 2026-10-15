// The pure part of editing a note on the Timeline: the closed spelling grammar of a pitch step, the one-token edit list and the
// write through the page's rewrite path, driven here with fakes for the read-back, the rewrite and the history record. The
// real page is proved by `npm run probe:page -- --only timeline`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NOTE_EDIT_REFUSALS, NoteEditStop, REST_TOKEN, stepPitch, tokenEdit, velocityStep, velocityTarget, writeNoteEdit } from '../page/note-edit.js';
import { parseTiming } from '../page/change-timing.js';

test('a note name steps by semitones and keeps the way it was written', () => {
  assert.deepEqual(stepPitch('c3', 1), { text: 'c#3', midi: 49 });
  assert.deepEqual(stepPitch('c3', -1), { text: 'b2', midi: 47 });
  // A flat is respelled with flats, a sharp keeps its sign, a natural becomes a sharp.
  assert.equal(stepPitch('db3', 1).text, 'd3');
  assert.equal(stepPitch('db3', 2).text, 'eb3');
  assert.equal(stepPitch('eb3', -1).text, 'd3');
  assert.equal(stepPitch('d3', -1).text, 'c#3');
  assert.equal(stepPitch('cs3', 1).text, 'd3');
  assert.equal(stepPitch('cs3', 2).text, 'ds3');
  assert.equal(stepPitch('cf4', 2).text, 'df4');
  // The case of the letter stays.
  assert.equal(stepPitch('C3', 2).text, 'D3');
  assert.equal(stepPitch('Eb3', 1).text, 'E3');
  // The octave digit is left out only while the old token had none and the new note is in octave 3.
  assert.deepEqual(stepPitch('e', 1), { text: 'f', midi: 53 });
  assert.deepEqual(stepPitch('b', 1), { text: 'c4', midi: 60 });
  assert.equal(stepPitch('c', -1).text, 'b2');
  assert.equal(stepPitch('c3', 12).text, 'c4');
  assert.equal(stepPitch('c4', -12).text, 'c3');
});

test('a note written as a number stays a number', () => {
  assert.deepEqual(stepPitch('48', 2), { text: '50', midi: 50 });
  assert.deepEqual(stepPitch('48', -1), { text: '47', midi: 47 });
  assert.equal(stepPitch('48.5', 1).text, '49.5');
});

test('the ends of the note range write nothing and say which end', () => {
  assert.deepEqual(stepPitch('127', 1), { limit: 'highest' });
  assert.deepEqual(stepPitch('0', -1), { limit: 'lowest' });
  assert.deepEqual(stepPitch('g9', 1), { limit: 'highest' });
  assert.deepEqual(stepPitch('c-1', -1), { limit: 'lowest' });
  assert.deepEqual(stepPitch('c-1', 1), { text: 'c#-1', midi: 1 });
  assert.deepEqual(stepPitch('127', -1), { text: '126', midi: 126 });
});

test('text that is neither a note name nor a number throws, so nothing odd is ever written', () => {
  assert.throws(() => stepPitch('c3 e3', 1), /neither a note name nor a number/);
  assert.throws(() => stepPitch('bd', 1), /neither a note name nor a number/);
  assert.throws(() => stepPitch('', 1), /neither a note name nor a number/);
  assert.throws(() => stepPitch('c3', 0.5), /whole number of semitones/);
  assert.throws(() => stepPitch(48, 1), /text/);
});

test('tokenEdit is one edit at the place of the token, and throws when the code there is not the token', () => {
  const code = 'a: note("c3 e3")';
  const start = code.indexOf('c3');
  assert.deepEqual(tokenEdit(code, { start, end: start + 2, text: 'c3' }, 'c#3'), [{ from: start, to: start + 2, insert: 'c#3' }]);
  assert.throws(() => tokenEdit(code, { start, end: start + 2, text: 'e3' }, 'f3'), /not the token 'e3' any more/);
  assert.throws(() => tokenEdit(code, { start, end: start + 2, text: 'c3' }, ''), /needs the text to write/);
});

test('an unknown refusal throws; the two it knows are stale and read-back', () => {
  assert.deepEqual([...NOTE_EDIT_REFUSALS], ['stale', 'read-back']);
  assert.equal(new NoteEditStop('stale').reason, 'stale');
  assert.throws(() => new NoteEditStop('nope'), /unknown note edit refusal 'nope'/);
});

// --- writeNoteEdit with fakes ---

const CODE = 't1: note("c3 e3 g3").gain(0)';
const C3 = CODE.indexOf('c3');
const E3 = CODE.indexOf('e3');
const G3 = CODE.indexOf('g3');

/** The lane as drawn: three notes of a third of a cycle each, every one with the place of its token. */
function laneEvents(code = CODE, first = 'c3') {
  const at = (text) => code.indexOf(text);
  return [
    { begin: 0, end: 1 / 3, value: { note: first, gain: 0 }, locations: [{ start: at(first), end: at(first) + first.length }] },
    { begin: 1 / 3, end: 2 / 3, value: { note: 'e3', gain: 0 }, locations: [{ start: at('e3'), end: at('e3') + 2 }] },
    { begin: 2 / 3, end: 1, value: { note: 'g3', gain: 0 }, locations: [{ start: at('g3'), end: at('g3') + 2 }] },
  ];
}

function seenOf(overrides = {}) {
  return { code: CODE, trackIndex: 0, track: 't1', event: laneEvents()[0], events: laneEvents(), token: { start: C3, end: C3 + 2, text: 'c3' }, pageStart: 0, ...overrides };
}

/** Fake dependencies; `calls` lists what happened in order. */
function fakes({ readBack, apply, timing = parseTiming('now'), activeCode = 'the code that plays' } = {}) {
  const calls = [];
  const deps = {
    async readBack(code, span) {
      calls.push(span === undefined ? ['readBack', code] : ['readBack', code, span]);
      return readBack === undefined ? laneEvents(code, 'c#3') : readBack(code, span);
    },
    async apply(request) {
      calls.push(['apply']);
      if (apply !== undefined) return apply(request);
      const built = request.build(CODE);
      return { status: 'played', code: built.code, run: { deferred: null }, edits: built.edits };
    },
    timing,
    autostart: true,
    record: (code, label) => calls.push(['record', code, label]),
    whenFinished: (record, fn) => calls.push(['whenFinished', record, fn]),
    activeCode: () => activeCode,
  };
  return { deps, calls };
}

const UP = { kind: 'pitch', semitones: 1 };

test('a confirmed edit is written once, recorded once with its label, and the new code differs by exactly the token', async () => {
  let built;
  const { deps, calls } = fakes({
    apply: async (request) => {
      assert.equal(request.autostart, true);
      assert.equal(request.flash, false);
      assert.equal(request.timing.at, 'now');
      built = request.build(CODE);
      return { status: 'played', code: built.code, run: { deferred: null }, edits: built.edits };
    },
  });
  const outcome = await writeNoteEdit({ seen: seenOf(), change: UP, deps });
  assert.deepEqual(outcome, { kind: 'written', what: 'pitch', label: 'changed t1: c3 to c#3', from: 'c3', to: 'c#3' });
  assert.equal(built.code, CODE.replace('c3', 'c#3'));
  assert.deepEqual(built.edits, [{ from: C3, to: C3 + 2, insert: 'c#3' }]);
  assert.deepEqual(
    calls.filter(([name]) => name === 'record'),
    [['record', 'the code that plays', 'changed t1: c3 to c#3']],
  );
});

test('a read-back that does not show the edit is refused and nothing is written', async () => {
  for (const why of ['the note keeps its pitch', 'another note moves', 'a note is lost']) {
    const readBack = async () => {
      const events = laneEvents(CODE.replace('c3', 'c#3'), 'c#3');
      if (why === 'the note keeps its pitch') return laneEvents();
      if (why === 'another note moves') return events.map((event, i) => (i === 0 ? { ...event, value: { note: 'c#3', gain: 0 } } : { ...event, begin: event.begin + 0.01 }));
      return events.slice(0, 2);
    };
    const { deps, calls } = fakes({ readBack });
    const outcome = await writeNoteEdit({ seen: seenOf(), change: UP, deps });
    assert.equal(outcome.kind, 'refused', why);
    assert.equal(outcome.reason, 'read-back', why);
    assert.deepEqual(calls.map(([name]) => name), ['readBack'], `${why}: apply is never called`);
  }
});

test('a read-back that fails to run is a refusal that carries the error', async () => {
  const { deps, calls } = fakes({ readBack: async () => { throw new Error('boom'); } });
  const outcome = await writeNoteEdit({ seen: seenOf(), change: UP, deps });
  assert.equal(outcome.kind, 'refused');
  assert.equal(outcome.reason, 'read-back');
  assert.equal(outcome.error.message, 'boom');
  assert.deepEqual(calls.map(([name]) => name), ['readBack']);
});

test('code that is not the code the note was read from stops the write as stale', async () => {
  const { deps, calls } = fakes({
    apply: async (request) => {
      request.build('t1: note("c3 e3 g3").gain(0.5)');
      throw new Error('the build must have thrown');
    },
  });
  const outcome = await writeNoteEdit({ seen: seenOf(), change: UP, deps });
  assert.deepEqual(outcome, { kind: 'refused', reason: 'stale' });
  assert.equal(calls.filter(([name]) => name === 'record').length, 0);
});

test('a change that waits for its line is recorded only when it takes over, with the code that took over', async () => {
  const deferred = { code: 'taken over code' };
  const { deps, calls } = fakes({
    timing: parseTiming('bar'),
    apply: async (request) => {
      const built = request.build(CODE);
      return { status: 'played', code: built.code, run: { deferred }, edits: built.edits };
    },
  });
  const outcome = await writeNoteEdit({ seen: seenOf(), change: UP, deps });
  assert.deepEqual(outcome, { kind: 'waiting', what: 'pitch', label: 'changed t1: c3 to c#3', from: 'c3', to: 'c#3', at: 'bar', record: deferred });
  assert.equal(calls.filter(([name]) => name === 'record').length, 0);
  const [, record, whenTakenOver] = calls.find(([name]) => name === 'whenFinished');
  assert.equal(record, deferred);
  whenTakenOver();
  assert.deepEqual(calls.filter(([name]) => name === 'record'), [['record', 'taken over code', 'changed t1: c3 to c#3']]);
});

test('a refusal of the rewrite path, an edit that did not evaluate and a build that changed nothing pass through', async () => {
  for (const [result, expected] of [
    [{ status: 'refused', reason: 'waiting' }, { kind: 'refused', reason: 'waiting' }],
    [{ status: 'refused', reason: 'dirty' }, { kind: 'refused', reason: 'dirty' }],
    [{ status: 'failed', errorText: 'x', line: 1 }, { kind: 'failed' }],
    [{ status: 'unchanged', code: CODE }, { kind: 'unchanged', what: 'pitch' }],
  ]) {
    const { deps, calls } = fakes({ apply: async () => result });
    assert.deepEqual(await writeNoteEdit({ seen: seenOf(), change: UP, deps }), expected);
    assert.equal(calls.filter(([name]) => name === 'record').length, 0);
  }
});

test('an error of the rewrite path other than a stop, or of the history record after the write, is an error that may have written the code', async () => {
  const { deps } = fakes({ apply: async () => { throw new Error('the evaluation threw'); } });
  const thrown = await writeNoteEdit({ seen: seenOf(), change: UP, deps });
  assert.deepEqual({ ...thrown, error: thrown.error.message }, { kind: 'refused', reason: 'error', afterWrite: true, error: 'the evaluation threw' });
  // The code was written and evaluated, and the record fails: the outcome says the error came after the write.
  const recorded = fakes();
  recorded.deps.record = () => {
    throw new Error('the record failed');
  };
  const late = await writeNoteEdit({ seen: seenOf(), change: UP, deps: recorded.deps });
  assert.deepEqual({ ...late, error: late.error.message }, { kind: 'refused', reason: 'error', afterWrite: true, error: 'the record failed' });
  // An evaluation that threw and whose text the rewrite path took back wrote nothing: a plain error, offered to Claude.
  const restored = fakes({
    apply: async () => {
      const error = new Error('the evaluation threw');
      error.restored = true;
      throw error;
    },
  });
  const back = await writeNoteEdit({ seen: seenOf(), change: UP, deps: restored.deps });
  assert.deepEqual({ ...back, error: back.error.message }, { kind: 'refused', reason: 'error', error: 'the evaluation threw' });
  // An error before the write reaches the caller as it is: nothing was written.
  const early = fakes();
  await assert.rejects(writeNoteEdit({ seen: { ...seenOf(), token: { start: 0, end: 2, text: 'zz' } }, change: { kind: 'rest' }, deps: early.deps }), /not the token 'zz' any more/);
  assert.equal(early.calls.filter(([name]) => name === 'apply').length, 0);
});

test('the end of the note range writes nothing, reads nothing back and says which end', async () => {
  const code = 't1: note("127").gain(0)';
  const at = code.indexOf('127');
  const { deps, calls } = fakes();
  const seen = seenOf({ code, token: { start: at, end: at + 3, text: '127' }, events: [] });
  assert.deepEqual(await writeNoteEdit({ seen, change: UP, deps }), { kind: 'unchanged', what: 'pitch', limit: 'highest' });
  assert.equal(calls.length, 0);
});

test('a change the edit does not know, or a token that moved, throws', async () => {
  const { deps } = fakes();
  await assert.rejects(writeNoteEdit({ seen: seenOf(), change: { kind: 'octave' }, deps }), /does not know the change/);
  await assert.rejects(writeNoteEdit({ seen: seenOf({ token: { start: E3, end: E3 + 2, text: 'c3' } }), change: UP, deps }), /not the token 'c3' any more/);
  assert.ok(G3 > E3);
});

// --- a rest ---

const REST = { kind: 'rest' };

/** The lane read back after a rest on the first token: the first note is gone, the others stay and their places move by one. */
function laneAfterRest() {
  const code = CODE.replace('c3', REST_TOKEN);
  return laneEvents(code).slice(1);
}

test('the rest token is a tilde', () => {
  assert.equal(REST_TOKEN, '~');
});

test('a rest replaces the token with a tilde, is read back, written once and recorded with its own label', async () => {
  let built;
  const { deps, calls } = fakes({
    readBack: async (code) => {
      assert.equal(code, CODE.replace('c3', '~'));
      return laneAfterRest();
    },
    apply: async (request) => {
      built = request.build(CODE);
      return { status: 'played', code: built.code, run: { deferred: null }, edits: built.edits };
    },
  });
  const outcome = await writeNoteEdit({ seen: seenOf(), change: REST, deps });
  assert.deepEqual(outcome, { kind: 'written', what: 'rest', label: 'changed t1: c3 to a rest', from: 'c3', to: '~' });
  assert.equal(built.code, 't1: note("~ e3 g3").gain(0)');
  assert.deepEqual(built.edits, [{ from: C3, to: C3 + 2, insert: '~' }]);
  assert.deepEqual(calls.filter(([name]) => name === 'record'), [['record', 'the code that plays', 'changed t1: c3 to a rest']]);
});

test('a rest whose read-back still plays the note, or loses or moves another note, is refused and nothing is written', async () => {
  for (const [why, readBack] of [
    ['the note is still there', async () => laneEvents()],
    ['another note is lost', async () => laneAfterRest().slice(1)],
    ['another note moves', async () => laneAfterRest().map((event) => ({ ...event, begin: event.begin + 0.01 }))],
    ['another note changes', async () => laneAfterRest().map((event, i) => (i === 0 ? { ...event, value: { note: 'f3', gain: 0 } } : event))],
  ]) {
    const { deps, calls } = fakes({ readBack });
    const outcome = await writeNoteEdit({ seen: seenOf(), change: REST, deps });
    assert.equal(outcome.kind, 'refused', why);
    assert.equal(outcome.reason, 'read-back', why);
    assert.deepEqual(calls.map(([name]) => name), ['readBack'], `${why}: apply is never called`);
  }
});

test('a rest that waits for its line is recorded when it takes over; code that moved on stops it as stale', async () => {
  const deferred = { code: 'taken over code' };
  const waiting = fakes({
    timing: parseTiming('phrase'),
    readBack: async () => laneAfterRest(),
    apply: async (request) => {
      const built = request.build(CODE);
      return { status: 'played', code: built.code, run: { deferred }, edits: built.edits };
    },
  });
  assert.deepEqual(await writeNoteEdit({ seen: seenOf(), change: REST, deps: waiting.deps }), {
    kind: 'waiting',
    what: 'rest',
    label: 'changed t1: c3 to a rest',
    from: 'c3',
    to: '~',
    at: 'phrase',
    record: deferred,
  });
  assert.equal(waiting.calls.filter(([name]) => name === 'record').length, 0);
  const stale = fakes({
    readBack: async () => laneAfterRest(),
    apply: async (request) => {
      request.build('t1: note("c3 e3 g3").gain(0.5)');
      throw new Error('the build must have thrown');
    },
  });
  assert.deepEqual(await writeNoteEdit({ seen: seenOf(), change: REST, deps: stale.deps }), { kind: 'refused', reason: 'stale' });
});

// --- velocity ---

test('a velocity step moves the shown velocity by a tenth and writes the token that gives it', () => {
  // A browser lane at the default gain 0.8 may write a token above 1.
  assert.deepEqual(velocityStep({ shown: 0.8, gain: 0.8, steps: 1 }), { token: '1.125', target: 0.9 });
  assert.deepEqual(velocityStep({ shown: 0.8, gain: 0.8, steps: -1 }), { token: '0.875', target: 0.7 });
  assert.deepEqual(velocityStep({ shown: 0.5, gain: 1, steps: -1 }), { token: '0.4', target: 0.4 });
  assert.deepEqual(velocityStep({ shown: 0.4, gain: 0.8, steps: 2 }), { token: '0.75', target: 0.6 });
  assert.deepEqual(velocityStep({ shown: 0.9, gain: 1, steps: 1 }), { token: '1', target: 1 });
});

test('a velocity step stops at 0.10 and 1.00, and a total that passes an end is held there', () => {
  assert.deepEqual(velocityStep({ shown: 1, gain: 1, steps: 1 }), { limit: 'highest' });
  assert.deepEqual(velocityStep({ shown: 0.1, gain: 1, steps: -1 }), { limit: 'lowest' });
  assert.deepEqual(velocityStep({ shown: 0.8, gain: 0.8, steps: 5 }), { token: '1.25', target: 1 });
  assert.deepEqual(velocityStep({ shown: 0.8, gain: 0.8, steps: -9 }), { token: '0.125', target: 0.1 });
  // A velocity already above the top is never moved up, and a step down comes to the top.
  assert.deepEqual(velocityStep({ shown: 1.2, gain: 1, steps: 1 }), { limit: 'highest' });
  assert.deepEqual(velocityStep({ shown: 1.2, gain: 1, steps: -1 }), { token: '1', target: 1 });
  assert.equal(velocityTarget({ shown: 0.85, steps: 1 }), 0.95);
  assert.equal(velocityTarget({ shown: 0.85, steps: 0 }), 0.85);
  assert.throws(() => velocityTarget({ shown: 0.5, steps: 0.5 }), /whole number of steps/);
});

test('a velocity no token can give is fixed: a gain of 0 or one that is not a number, a token that would not play the target', () => {
  assert.deepEqual(velocityStep({ shown: 0.8, gain: 0, steps: 1 }), { fixed: true });
  assert.deepEqual(velocityStep({ shown: 0.8, gain: NaN, steps: 1 }), { fixed: true });
  assert.deepEqual(velocityStep({ shown: 0.8, gain: Infinity, steps: 1 }), { fixed: true });
  assert.deepEqual(velocityStep({ shown: 0.8, gain: -1, steps: 1 }), { fixed: true });
  assert.deepEqual(velocityStep({ shown: 0.8, gain: 'loud', steps: 1 }), { fixed: true });
  // A gain so large that three decimals of the token cannot reach the target.
  assert.deepEqual(velocityStep({ shown: 0.5, gain: 5000, steps: 1 }), { fixed: true });
  assert.throws(() => velocityStep({ shown: undefined, gain: 1, steps: 1 }), /finite number/);
});

const VELOCITY_CODE = 't1: note("c3 e3").velocity("0.5 1").postgain(0)';
const V05 = VELOCITY_CODE.indexOf('0.5');

/** The lane as drawn: two notes, the first of them read from the number 0.5 of the velocity string. */
function velocityLane(code = VELOCITY_CODE, first = 0.5) {
  const at = (text) => code.indexOf(text);
  const number = first === 0.5 ? '0.5' : String(first);
  return [
    { begin: 0, end: 0.5, value: { note: 'c3', velocity: first }, locations: [{ start: at(number), end: at(number) + number.length }, { start: at('c3'), end: at('c3') + 2 }] },
    { begin: 0.5, end: 1, value: { note: 'e3', velocity: 1 }, locations: [{ start: at('1"'), end: at('1"') + 1 }, { start: at('e3'), end: at('e3') + 2 }] },
  ];
}

function velocitySeen(overrides = {}) {
  return {
    code: VELOCITY_CODE,
    trackIndex: 0,
    track: 't1',
    event: velocityLane()[0],
    events: velocityLane(),
    token: { start: VELOCITY_CODE.indexOf('c3'), end: VELOCITY_CODE.indexOf('c3') + 2, text: 'c3' },
    velocity: { writable: true, token: { start: V05, end: V05 + 3, text: '0.5' }, gain: 0.8, shown: 0.4 },
    pageStart: 0,
    ...overrides,
  };
}

test('a velocity edit replaces the number, is read back, written once and recorded with the note and the new velocity', async () => {
  let built;
  const { deps, calls } = fakes({
    readBack: async (code) => {
      assert.equal(code, 't1: note("c3 e3").velocity("0.625 1").postgain(0)');
      return velocityLane(code, 0.625);
    },
    apply: async (request) => {
      built = request.build(VELOCITY_CODE);
      return { status: 'played', code: built.code, run: { deferred: null }, edits: built.edits };
    },
  });
  const outcome = await writeNoteEdit({ seen: velocitySeen(), change: { kind: 'velocity', steps: 1 }, deps });
  assert.deepEqual(outcome, { kind: 'written', what: 'velocity', label: 'changed t1: velocity of c3 to 0.50', from: 'c3', to: '0.50' });
  assert.deepEqual(built.edits, [{ from: V05, to: V05 + 3, insert: '0.625' }]);
  assert.deepEqual(calls.filter(([name]) => name === 'record'), [['record', 'the code that plays', 'changed t1: velocity of c3 to 0.50']]);
});

test('a velocity edit whose read-back does not play the target, or moves another note, is refused and nothing is written', async () => {
  for (const [why, readBack] of [
    ['the velocity is unchanged', async () => velocityLane()],
    ['the velocity is another one', async (code) => velocityLane(code, 0.7)],
    ['another note moves', async (code) => velocityLane(code, 0.625).map((event, i) => (i === 1 ? { ...event, begin: 0.6 } : event))],
  ]) {
    const { deps, calls } = fakes({ readBack });
    const outcome = await writeNoteEdit({ seen: velocitySeen(), change: { kind: 'velocity', steps: 1 }, deps });
    assert.equal(outcome.kind, 'refused', why);
    assert.equal(outcome.reason, 'read-back', why);
    assert.deepEqual(calls.map(([name]) => name), ['readBack'], why);
  }
});

test('a velocity edit at an end of the range writes nothing; a velocity the page cannot write is refused as fixed', async () => {
  const { deps, calls } = fakes();
  const top = velocitySeen({ velocity: { writable: true, token: { start: V05, end: V05 + 3, text: '0.5' }, gain: 1, shown: 1 } });
  assert.deepEqual(await writeNoteEdit({ seen: top, change: { kind: 'velocity', steps: 1 }, deps }), { kind: 'unchanged', what: 'velocity', limit: 'highest' });
  for (const velocity of [undefined, null, { writable: false }]) {
    const outcome = await writeNoteEdit({ seen: velocitySeen({ velocity }), change: { kind: 'velocity', steps: 1 }, deps });
    assert.deepEqual(outcome, { kind: 'refused', reason: 'velocity-fixed' });
  }
  const zero = velocitySeen({ velocity: { writable: true, token: { start: V05, end: V05 + 3, text: '0.5' }, gain: 0, shown: 0.5 } });
  assert.deepEqual(await writeNoteEdit({ seen: zero, change: { kind: 'velocity', steps: 1 }, deps }), { kind: 'refused', reason: 'velocity-fixed' });
  assert.equal(calls.length, 0);
});

test('a velocity edit that waits for its line says so with the note and the new velocity, and records when it takes over', async () => {
  const deferred = { code: 'taken over code' };
  const { deps, calls } = fakes({
    timing: parseTiming('bar'),
    readBack: async (code) => velocityLane(code, 0.625),
    apply: async (request) => {
      const built = request.build(VELOCITY_CODE);
      return { status: 'played', code: built.code, run: { deferred }, edits: built.edits };
    },
  });
  const outcome = await writeNoteEdit({ seen: velocitySeen(), change: { kind: 'velocity', steps: 1 }, deps });
  assert.deepEqual(outcome, { kind: 'waiting', what: 'velocity', label: 'changed t1: velocity of c3 to 0.50', from: 'c3', to: '0.50', at: 'bar', record: deferred });
  const [, , whenTakenOver] = calls.find(([name]) => name === 'whenFinished');
  whenTakenOver();
  assert.deepEqual(calls.filter(([name]) => name === 'record'), [['record', 'taken over code', 'changed t1: velocity of c3 to 0.50']]);
});

// --- where the token plays ---

/** The notes of one pass of a structure, as the places query finds them: the token's note in two sections. */
function passEvents(code, first = 'c3') {
  const at = code.indexOf(first);
  const place = [{ start: at, end: at + first.length }];
  return [
    { begin: 0, end: 0.5, value: { note: first, gain: 0 }, locations: place },
    { begin: 4, end: 4.5, value: { note: first, gain: 0 }, locations: place },
    { begin: 4.5, end: 5, value: { note: 'e3', gain: 0 }, locations: [{ start: code.indexOf('e3'), end: code.indexOf('e3') + 2 }] },
  ];
}

const SPAN = { from: 0, to: 15 };
const placesOfTwo = { count: 2, sections: ['x', 'z'], onPage: false, events: passEvents(CODE) };

test('the count of places is waited for before anything is read back or written, and the result and the entry carry it', async () => {
  let arrive;
  const pending = new Promise((resolve) => {
    arrive = resolve;
  });
  const { deps, calls } = fakes({ readBack: async (code, span) => (span === undefined ? laneEvents(code, 'c#3') : passEvents(code, 'c#3')) });
  const running = writeNoteEdit({ seen: seenOf({ places: pending, placesWindow: SPAN }), change: UP, deps });
  let done = false;
  running.then(() => {
    done = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(done, false, 'the edit waits for the count');
  assert.deepEqual(calls, [], 'nothing is read back or written meanwhile');
  arrive(placesOfTwo);
  const outcome = await running;
  assert.deepEqual(outcome, { kind: 'written', what: 'pitch', label: 'changed t1: c3 to c#3 in 2 places', from: 'c3', to: 'c#3', places: 2 });
  assert.deepEqual(calls.map(([name]) => name), ['readBack', 'readBack', 'apply', 'record']);
  assert.deepEqual(calls[1][2], SPAN, 'the stretch the places were counted on is read back as well');
  assert.equal(calls[3][2], 'changed t1: c3 to c#3 in 2 places');
});

test('a rest of a token that plays in several places says so too', async () => {
  const { deps } = fakes({ readBack: async (code, span) => (span === undefined ? laneEvents(code, 'c3').slice(1) : passEvents(code).slice(2)) });
  const outcome = await writeNoteEdit({ seen: seenOf({ places: placesOfTwo, placesWindow: SPAN }), change: { kind: 'rest' }, deps });
  assert.deepEqual(outcome, { kind: 'written', what: 'rest', label: 'changed t1: c3 to a rest in 2 places', from: 'c3', to: '~', places: 2 });
});

test('a read-back that finds a changed note outside the places is refused, though the drawn page looks right', async () => {
  const wide = (code, span) => {
    if (span === undefined) return laneEvents(code, 'c#3');
    // Over the whole pass a note that is not the token's moved as well.
    return passEvents(code, 'c#3').map((event, i) => (i === 2 ? { ...event, begin: event.begin + 1, end: event.end + 1 } : event));
  };
  const { deps, calls } = fakes({ readBack: wide });
  const outcome = await writeNoteEdit({ seen: seenOf({ places: placesOfTwo, placesWindow: SPAN }), change: UP, deps });
  assert.deepEqual(outcome, { kind: 'refused', reason: 'read-back', why: 'places-others-differ' });
  assert.deepEqual(calls.map(([name]) => name), ['readBack', 'readBack'], 'nothing is written');
  // A note of the token that keeps its old pitch in another section is refused too.
  const stays = (code, span) => (span === undefined ? laneEvents(code, 'c#3') : passEvents(code, 'c#3').map((event, i) => (i === 1 ? { ...event, value: { note: 'c3', gain: 0 } } : event)));
  const second = fakes({ readBack: stays });
  const again = await writeNoteEdit({ seen: seenOf({ places: placesOfTwo, placesWindow: SPAN }), change: UP, deps: second.deps });
  assert.deepEqual(again, { kind: 'refused', reason: 'read-back', why: 'places-edited-pitch' });
  assert.equal(second.calls.filter(([name]) => name === 'apply').length, 0);
});

test('places that could not be counted refuse the edit with the error, and nothing is read back', async () => {
  const { deps, calls } = fakes();
  const outcome = await writeNoteEdit({ seen: seenOf({ places: Promise.reject(new Error('no pattern')), placesWindow: SPAN }), change: UP, deps });
  assert.equal(outcome.kind, 'refused');
  assert.equal(outcome.reason, 'read-back');
  assert.equal(outcome.error.message, 'no pattern');
  assert.deepEqual(calls, []);
});

test('a count on the drawn page alone is told as such and reads back the page only', async () => {
  const { deps, calls } = fakes();
  const outcome = await writeNoteEdit({ seen: seenOf({ places: { count: 3, sections: ['x', 'y', 'z'], onPage: true }, placesWindow: null }), change: UP, deps });
  assert.deepEqual(outcome, { kind: 'written', what: 'pitch', label: 'changed t1: c3 to c#3 in 3 places on this page', from: 'c3', to: 'c#3', places: 3, onPage: true });
  assert.deepEqual(calls.map(([name]) => name), ['readBack', 'apply', 'record']);
});

test('a token that draws several notes in each cycle carries that count', async () => {
  const { deps } = fakes();
  const outcome = await writeNoteEdit({ seen: seenOf({ perCycle: 2 }), change: UP, deps });
  assert.equal(outcome.places, 2);
  assert.equal(outcome.label, 'changed t1: c3 to c#3 in 2 places');
  const one = await writeNoteEdit({ seen: seenOf({ perCycle: 1 }), change: UP, deps: fakes().deps });
  assert.equal('places' in one, false);
});

test('a place that counts one is not told, and the edit does not read back a stretch it was not given', async () => {
  const { deps, calls } = fakes();
  const outcome = await writeNoteEdit({ seen: seenOf({ places: { count: 1, sections: ['x'], onPage: false, events: [] }, placesWindow: null }), change: UP, deps });
  assert.deepEqual(outcome, { kind: 'written', what: 'pitch', label: 'changed t1: c3 to c#3', from: 'c3', to: 'c#3' });
  assert.deepEqual(calls.map(([name]) => name), ['readBack', 'apply', 'record']);
});

test('a velocity number that several notes of the page share is told in the result, and a lone velocity says nothing', async () => {
  const sharedCode = 't1: note("c3 e3 g3").velocity("0.5").postgain(0)';
  const lane = (code, velocity) => {
    const number = code.indexOf(velocity === 0.5 ? '0.5' : String(velocity));
    return ['c3', 'e3', 'g3'].map((name, i) => ({
      begin: i / 3,
      end: (i + 1) / 3,
      value: { note: name, velocity },
      locations: [{ start: number, end: number + String(velocity).length }, { start: code.indexOf(name), end: code.indexOf(name) + 2 }],
    }));
  };
  const seen = {
    code: sharedCode,
    trackIndex: 0,
    track: 't1',
    event: lane(sharedCode, 0.5)[0],
    events: lane(sharedCode, 0.5),
    token: { start: sharedCode.indexOf('c3'), end: sharedCode.indexOf('c3') + 2, text: 'c3' },
    velocity: { writable: true, token: { start: sharedCode.indexOf('0.5'), end: sharedCode.indexOf('0.5') + 3, text: '0.5' }, gain: 1, shown: 0.5 },
    pageStart: 0,
  };
  const { deps } = fakes({
    readBack: async (code) => lane(code, 0.6),
    apply: async (request) => {
      const built = request.build(sharedCode);
      return { status: 'played', code: built.code, run: { deferred: null }, edits: built.edits };
    },
  });
  const outcome = await writeNoteEdit({ seen, change: { kind: 'velocity', steps: 1 }, deps });
  assert.deepEqual(outcome, { kind: 'written', what: 'velocity', label: 'changed t1: velocity of c3 to 0.60', from: 'c3', to: '0.60', notes: 3 });
  // A velocity read by this note alone carries no count (the earlier tests pin that shape).
  const alone = await writeNoteEdit({ seen: velocitySeen(), change: { kind: 'velocity', steps: 1 }, deps: fakes({ readBack: async (code) => velocityLane(code, 0.625) }).deps });
  assert.equal('notes' in alone, false);
});

// --- where the velocity number plays ---

/** The notes of one pass of a structure that read the number 0.5 of the velocity string: two sections play it, at `velocity`. */
function velocityPass(code, velocity = 0.5, second = velocity) {
  // The number sits at the same place in the code whatever it was changed to, as the lane helper above leaves it.
  const place = [{ start: V05, end: V05 + String(velocity === 0.5 ? '0.5' : velocity).length }];
  return [
    { begin: 0, end: 0.5, value: { note: 'c3', velocity }, locations: place },
    { begin: 4, end: 4.5, value: { note: 'c3', velocity: second }, locations: place },
  ];
}

const velocityPlacesOfTwo = { count: 2, sections: ['x', 'z'], onPage: false, events: velocityPass(VELOCITY_CODE) };

test('a velocity number that plays in several sections is counted, read back over all of them, and told in the result and the entry', async () => {
  const { deps, calls } = fakes({
    readBack: async (code, span) => (span === undefined ? velocityLane(code, 0.625) : velocityPass(code, 0.625)),
    apply: async (request) => {
      const built = request.build(VELOCITY_CODE);
      return { status: 'played', code: built.code, run: { deferred: null }, edits: built.edits };
    },
  });
  const seen = velocitySeen({ velocityPlaces: velocityPlacesOfTwo, velocityWindow: SPAN });
  const outcome = await writeNoteEdit({ seen, change: { kind: 'velocity', steps: 1 }, deps });
  assert.deepEqual(outcome, { kind: 'written', what: 'velocity', label: 'changed t1: velocity of c3 to 0.50 in 2 places', from: 'c3', to: '0.50', places: 2 });
  assert.deepEqual(calls.filter(([name]) => name === 'readBack').map((call) => call[2]), [undefined, SPAN], 'the stretch the places were counted on is read back as well');
});

test('a velocity edit that would play another velocity in another section is refused, though the drawn page looks right', async () => {
  const { deps, calls } = fakes({
    // The first section plays the target; the second plays a velocity the edit did not ask for (it has its own gain).
    readBack: async (code, span) => (span === undefined ? velocityLane(code, 0.625) : velocityPass(code, 0.625, 0.9)),
  });
  const seen = velocitySeen({ velocityPlaces: velocityPlacesOfTwo, velocityWindow: SPAN });
  const outcome = await writeNoteEdit({ seen, change: { kind: 'velocity', steps: 1 }, deps });
  assert.deepEqual(outcome, { kind: 'refused', reason: 'read-back', why: 'places-edited-velocity' });
  assert.equal(calls.filter(([name]) => name === 'apply').length, 0, 'nothing is written');
});

test('a velocity number whose places cannot be counted refuses the edit, and a count of one adds nothing', async () => {
  const failing = fakes();
  const refused = await writeNoteEdit({ seen: velocitySeen({ velocityPlaces: Promise.reject(new Error('no pattern')), velocityWindow: SPAN }), change: { kind: 'velocity', steps: 1 }, deps: failing.deps });
  assert.equal(refused.reason, 'read-back');
  assert.equal(refused.error.message, 'no pattern');
  assert.deepEqual(failing.calls, []);
  const { deps } = fakes({ readBack: async (code, span) => (span === undefined ? velocityLane(code, 0.625) : velocityPass(code, 0.625).slice(0, 1)) });
  const one = await writeNoteEdit({
    seen: velocitySeen({ velocityPlaces: { count: 1, sections: ['x'], onPage: false, events: velocityPass(VELOCITY_CODE).slice(0, 1) }, velocityWindow: SPAN }),
    change: { kind: 'velocity', steps: 1 },
    deps,
  });
  assert.equal('places' in one, false);
});
