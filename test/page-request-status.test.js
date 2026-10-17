// The rules of the per-request tracker (page/request-status.js) on a fake clock: a request only moves forward, a row
// reads No change yet after 30 s of silence and never Failed, a finished row freezes its duration and moves to Recent,
// the page shows only the states the measurement supported, and every sentence is worded as written in the copy object.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as status from '../page/request-status.js';
import { ASK_CONFIRM_TIMEOUT_MS, refusalText } from '../page/ask.js';
import { REQUEST_STATES } from '../dist/request-status.js';
import { makeFakeTime } from './clock-fakes.js';

const {
  CLOSE_PROMISED,
  FINISHED_SHOWN_MS,
  LINK_PROMISED,
  QUIET_AFTER_MS,
  RECENT_MAX,
  REQUEST_STATUS_COPY,
  SERVER_REQUEST_STATES,
  createRequestTracker,
  cutCodePoints,
  formatElapsed,
  rowText,
  stateMark,
  statePhrase,
  stateRank,
} = status;

/** A tracker on a fake clock; `changes` counts the onChange calls, `unconfirmed` lists the ids reported as not confirmed. */
function setup(options = {}) {
  const time = makeFakeTime();
  const changes = [];
  const unconfirmed = [];
  const tracker = createRequestTracker({
    now: time.perfNow,
    setTimer: time.setTimer,
    clearTimer: time.clearTimer,
    onChange: () => changes.push(time.perfNow()),
    onNotConfirmed: (id) => unconfirmed.push(id),
    ...options,
  });
  return { time, tracker, changes, unconfirmed };
}

function send(rig, id, text = 'make the drums softer') {
  rig.tracker.sent(id, { text, chip: 'Whole session' });
}

/** The row of `id`, in the list or in Recent. */
function rowOf(rig, id) {
  const model = rig.tracker.model();
  return [...model.rows, ...model.recent].find((row) => row.id === id);
}

const result = (id, state) => (state === 'waiting' ? { type: 'ask-result', id, status: 'waiting', waiting: 1 } : { type: 'ask-result', id, status: 'received' });
const board = (id, state, extra = {}) => ({ type: 'ask-status', id, state, ...extra });

/** Says an exported function or method exists, so a missing one fails as a plain assertion. */
function need(owner, name) {
  assert.equal(typeof owner[name], 'function', `${name} is exported`);
  return owner[name];
}

function consoleErrors(t) {
  t.mock.method(console, 'error', () => {});
  return () => console.error.mock.calls.map((call) => call.arguments.join(' '));
}

test('the page lists the server states in the order the server holds them', () => {
  assert.deepEqual([...SERVER_REQUEST_STATES], [...REQUEST_STATES]);
});

test('every state outranks the ones before it: sent, waiting, received, started, line, then every final state', () => {
  const ladder = ['sent', 'waiting', 'received', 'started', 'line', 'applied'];
  for (let i = 0; i < ladder.length - 1; i += 1) {
    assert.ok(stateRank(ladder[i]) < stateRank(ladder[i + 1]), `${ladder[i]} is below ${ladder[i + 1]}`);
  }
  for (const final of ['applied', 'failed', 'replaced', 'canceled', 'answered', 'declined', 'notsent', 'lost']) {
    assert.equal(stateRank(final), stateRank('applied'), `${final} ranks with the other final states`);
  }
  assert.throws(() => stateRank('almost'), /unknown request state/);
});

test('a message that lowers or repeats a state changes nothing and does not call onChange', () => {
  const rig = setup();
  send(rig, 'a');
  rig.tracker.serverMessage(board('a', 'started'));
  rig.tracker.serverMessage(board('a', 'line', { at: 'bar' }));
  const before = rig.changes.length;
  for (const message of [result('a', 'received'), result('a', 'waiting'), board('a', 'started'), board('a', 'line', { at: 'phrase' })]) {
    rig.tracker.serverMessage(message);
  }
  assert.equal(rowOf(rig, 'a').phrase, REQUEST_STATUS_COPY.phrases.line);
  assert.equal(rig.changes.length, before, 'no change was announced');
  rig.tracker.serverMessage(board('a', 'applied', { version: 4 }));
  rig.tracker.serverMessage(board('a', 'failed', { reason: 'late failure' }));
  assert.equal(rowOf(rig, 'a').phrase, 'Applied as v4', 'a failure after Applied is not written onto the row');
});

test('a requeue never takes a received row back to Waiting for Claude\'s next action', () => {
  const rig = setup();
  send(rig, 'a');
  rig.tracker.serverMessage({ type: 'ask-received', ids: ['a'] });
  assert.equal(rowOf(rig, 'a').phrase, REQUEST_STATUS_COPY.phrases.received);
  const before = rig.changes.length;
  rig.tracker.serverMessage(result('a', 'waiting'));
  assert.equal(rowOf(rig, 'a').phrase, REQUEST_STATUS_COPY.phrases.received);
  assert.equal(rig.changes.length, before);
  assert.deepEqual(need(rig.tracker, 'takeLive')(), [ 'Request "make the drums softer": sent.', 'Request "make the drums softer": received.' ], 'nothing is spoken for the requeue');
});

test('two requests keep their own rows: a message for one never changes the other, and the count is the rows not finished', () => {
  const rig = setup();
  send(rig, 'a', 'first request');
  send(rig, 'b', 'second request');
  assert.equal(rig.tracker.model().inFlight, 2);
  rig.tracker.serverMessage(result('a', 'received'));
  rig.tracker.serverMessage(board('a', 'applied', { version: 3 }));
  assert.equal(rowOf(rig, 'b').phrase, REQUEST_STATUS_COPY.phrases.sent);
  assert.equal(rowOf(rig, 'a').phrase, 'Applied as v3');
  assert.equal(rig.tracker.model().inFlight, 1);
  assert.deepEqual(rig.tracker.model().rows.map((row) => row.id), ['b', 'a'], 'newest first, and a finished row keeps its place');
});

test('a message for an id the page does not know is ignored with one console line per cause', (t) => {
  const lines = consoleErrors(t);
  const rig = setup();
  send(rig, 'a');
  const before = rig.changes.length;
  rig.tracker.serverMessage(board('zz', 'started'));
  rig.tracker.serverMessage(board('yy', 'applied', { version: 2 }));
  assert.equal(lines().length, 1, 'two unknown ids in ask-status are one cause');
  rig.tracker.serverMessage(result('zz', 'received'));
  rig.tracker.serverMessage(result('yy', 'received'));
  assert.equal(lines().length, 2, 'ask-result is another cause');
  rig.tracker.serverMessage({ type: 'ask-received', ids: ['zz', 'yy'] });
  rig.tracker.serverMessage({ type: 'ask-received', ids: ['zz'] });
  assert.equal(lines().length, 3, 'ask-received is a third cause');
  assert.equal(rig.changes.length, before);
  assert.equal(rig.tracker.model().rows.length, 1, 'no row was invented');
});

test('a state the server names but this page does not know is ignored with one console line', (t) => {
  const lines = consoleErrors(t);
  const rig = setup();
  send(rig, 'a');
  rig.tracker.serverMessage(board('a', 'teleported'));
  rig.tracker.serverMessage(board('a', 'teleported'));
  assert.equal(lines().length, 1);
  assert.equal(rowOf(rig, 'a').phrase, REQUEST_STATUS_COPY.phrases.sent);
});

test('a refused request reads Not sent with the existing refusal text, and a request nobody confirms reads Not sent after 5 s', () => {
  const rig = setup();
  send(rig, 'a');
  rig.tracker.serverMessage({ type: 'ask-result', id: 'a', status: 'refused', reason: 'rate-limit' });
  assert.equal(rowOf(rig, 'a').phrase, `Not sent: ${refusalText('rate-limit')}`);
  assert.equal(rowOf(rig, 'a').shape, 'bad');
  assert.deepEqual(rig.unconfirmed, [], 'a refusal is the server\'s answer, not a missing one');

  send(rig, 'b');
  send(rig, 'c');
  rig.tracker.serverMessage(result('c', 'received'));
  rig.time.advance(ASK_CONFIRM_TIMEOUT_MS - 1);
  assert.equal(rowOf(rig, 'b').phrase, REQUEST_STATUS_COPY.phrases.sent);
  rig.time.advance(1);
  assert.equal(rowOf(rig, 'b').phrase, 'Not sent: Moontide did not confirm the request.');
  assert.deepEqual(rig.unconfirmed, ['b'], 'reported once');
  assert.equal(rowOf(rig, 'c').phrase, REQUEST_STATUS_COPY.phrases.received, 'a confirmed request is not timed out');
  rig.time.advance(ASK_CONFIRM_TIMEOUT_MS);
  assert.deepEqual(rig.unconfirmed, ['b'], 'not reported again');
});

test('after a socket close every open row reads Connection lost, unconfirmed ones are reported, finished ones stay', () => {
  const rig = setup();
  send(rig, 'a');
  rig.tracker.serverMessage(result('a', 'received'));
  send(rig, 'b');
  send(rig, 'c');
  rig.tracker.serverMessage(result('c', 'received'));
  rig.tracker.serverMessage(board('c', 'applied', { version: 2 }));
  need(rig.tracker, 'takeLive')();
  rig.tracker.connectionLost();
  assert.equal(rowOf(rig, 'a').phrase, REQUEST_STATUS_COPY.phrases.lost);
  assert.equal(rowOf(rig, 'b').phrase, REQUEST_STATUS_COPY.phrases.lost);
  assert.equal(rowOf(rig, 'c').phrase, 'Applied as v2');
  assert.equal(rowOf(rig, 'a').shape, 'ended');
  assert.deepEqual(rig.unconfirmed, ['b']);
  assert.equal(rig.tracker.model().inFlight, 0);
  assert.deepEqual(need(rig.tracker, 'takeLive')(), ['Connection lost. The page cannot tell what happened to 2 open requests.']);
  rig.time.advance(10 * 60 * 1000);
  assert.ok(!rowOf(rig, 'a')?.phrase.startsWith('Failed'), 'no timer turns a row into Failed');
});

test('after 30 s without news a row reads No change yet and counts on, and any news replaces it at once', () => {
  const rig = setup();
  send(rig, 'a');
  rig.tracker.serverMessage(result('a', 'received'));
  rig.time.advance(QUIET_AFTER_MS - 1);
  assert.equal(rowOf(rig, 'a').phrase, REQUEST_STATUS_COPY.phrases.received);
  const before = rig.changes.length;
  rig.time.advance(1);
  assert.equal(rowOf(rig, 'a').phrase, 'No change yet · 30 s');
  assert.equal(rowOf(rig, 'a').state, 'quiet');
  assert.equal(rowOf(rig, 'a').time, '', 'the row\'s own time column is empty while No change yet counts');
  assert.equal(rowOf(rig, 'a').shape, 'flight');
  assert.equal(rig.changes.length, before + 1, 'the timer announced the change once');
  rig.time.advance(60000);
  assert.equal(rowOf(rig, 'a').phrase, 'No change yet · 1 min', 'at 90 s it counts from the last news');
  rig.tracker.serverMessage(board('a', 'started'));
  assert.equal(rowOf(rig, 'a').phrase, REQUEST_STATUS_COPY.phrases.started, 'news replaces it at once');
  rig.time.advance(QUIET_AFTER_MS - 1);
  assert.equal(rowOf(rig, 'a').phrase, REQUEST_STATUS_COPY.phrases.started, 'the 30 s start over from that news');
  rig.time.advance(1);
  assert.equal(rowOf(rig, 'a').phrase, 'No change yet · 30 s');
  assert.ok(!rowOf(rig, 'a').phrase.startsWith('Failed'));
});

test('a row waiting for its line is never silence, and a finished row never reads No change yet', () => {
  const rig = setup();
  send(rig, 'a');
  rig.tracker.serverMessage(result('a', 'received'));
  rig.tracker.serverMessage(board('a', 'line', { at: 'phrase' }));
  rig.time.advance(10 * 60 * 1000);
  assert.equal(rowOf(rig, 'a').phrase, REQUEST_STATUS_COPY.phrases.line);
  rig.tracker.serverMessage(board('a', 'replaced'));
  rig.time.advance(10 * 60 * 1000);
  assert.equal(rowOf(rig, 'a').phrase, REQUEST_STATUS_COPY.phrases.replaced);
});

test('a finished row freezes its duration, stays about 30 s, then moves to the top of Recent', () => {
  const rig = setup();
  send(rig, 'a');
  rig.tracker.serverMessage(result('a', 'received'));
  rig.time.advance(12000);
  rig.tracker.serverMessage(board('a', 'applied', { version: 5 }));
  assert.equal(rowOf(rig, 'a').time, '12 s');
  assert.equal(rowOf(rig, 'a').timeTitle, 'Took 12 s');
  rig.time.advance(FINISHED_SHOWN_MS - 1);
  assert.equal(rowOf(rig, 'a').time, '12 s', 'the duration does not count on');
  assert.equal(rig.tracker.model().rows.length, 1);
  assert.equal(rig.tracker.model().recent.length, 0);
  rig.time.advance(1);
  assert.equal(rig.tracker.model().rows.length, 0);
  assert.deepEqual(rig.tracker.model().recent.map((row) => row.id), ['a']);
  assert.equal(rig.tracker.model().empty, false, 'the chip stays while Recent holds a row');
  assert.equal(rig.time.pendingTimers(), 0, 'no timer is left when nothing is due');
});

test('a row finished in under a second shows no duration', () => {
  const rig = setup();
  send(rig, 'a');
  rig.time.advance(400);
  rig.tracker.serverMessage(result('a', 'received'));
  rig.tracker.serverMessage(board('a', 'answered', { answer: 'Yes, it is in A minor.' }));
  assert.equal(rowOf(rig, 'a').time, '');
  assert.equal(rowOf(rig, 'a').timeTitle, '');
});

test('a held row waits in the list until it is released, then moves at once', () => {
  const rig = setup();
  send(rig, 'a');
  rig.tracker.serverMessage(result('a', 'received'));
  rig.tracker.serverMessage(board('a', 'canceled'));
  need(rig.tracker, 'setHeld')('a', true);
  rig.time.advance(FINISHED_SHOWN_MS * 3);
  assert.deepEqual(rig.tracker.model().rows.map((row) => row.id), ['a'], 'held by the pointer, focus or an open detail');
  const before = rig.changes.length;
  rig.tracker.setHeld('a', false);
  assert.deepEqual(rig.tracker.model().recent.map((row) => row.id), ['a']);
  assert.equal(rig.changes.length, before + 1);
});

test('Recent keeps the last 5 finished requests and drops the oldest', () => {
  const rig = setup();
  const ids = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7'];
  for (const id of ids) {
    send(rig, id, `request ${id}`);
    rig.tracker.serverMessage(result(id, 'received'));
    rig.tracker.serverMessage(board(id, 'declined', { answer: 'Not possible here.' }));
    rig.time.advance(FINISHED_SHOWN_MS);
  }
  const recent = rig.tracker.model().recent.map((row) => row.id);
  assert.equal(RECENT_MAX, 5);
  assert.deepEqual(recent, ['r7', 'r6', 'r5', 'r4', 'r3'], 'the newest move is at the top');
  assert.equal(rig.tracker.model().rows.length, 0);
});

test('formatElapsed counts whole units rounded down', () => {
  const cases = [
    [0, '0 s'],
    [7400, '7 s'],
    [42000, '42 s'],
    [59999, '59 s'],
    [60000, '1 min'],
    [12 * 60000 + 59000, '12 min'],
    [3600000, '1 h'],
    [3600000 + 5 * 60000, '1 h 5 min'],
    [2 * 3600000 + 59 * 60000 + 59000, '2 h 59 min'],
  ];
  for (const [ms, text] of cases) assert.equal(formatElapsed(ms), text, `${ms} ms`);
});

test('cutCodePoints never splits a surrogate pair and rowText collapses whitespace and cuts at 40 code points', () => {
  const emoji = '\u{1F3B5}';
  const cut = cutCodePoints(emoji.repeat(41), 40);
  assert.equal(cut, `${emoji.repeat(40)}…`);
  assert.ok(cut.isWellFormed(), 'no lone surrogate');
  assert.equal(cutCodePoints(emoji.repeat(40), 40), emoji.repeat(40), 'exactly the maximum is left alone');
  assert.equal(rowText('  make \n the\t\tdrums   softer \n'), 'make the drums softer');
  assert.equal(rowText('a'.repeat(41)), `${'a'.repeat(40)}…`);
  const arabic = 'مرحبا '.repeat(20);
  assert.ok(rowText(arabic).isWellFormed());
  assert.ok(Array.from(rowText(arabic)).length <= 41);
});

test('every state phrase is the wording of the copy object, and an unknown state throws', () => {
  const expected = {
    sent: 'Sent',
    received: 'Received',
    waiting: "Waiting for Claude's next action",
    started: 'Claude has started on it',
    line: 'Waiting for its line',
    replaced: 'Replaced by a newer change',
    canceled: 'Canceled',
    lost: 'Connection lost',
  };
  for (const [state, phrase] of Object.entries(expected)) assert.equal(statePhrase({ state }), phrase);
  assert.equal(statePhrase({ state: 'applied', version: 12 }), 'Applied as v12');
  assert.equal(statePhrase({ state: 'applied', version: null }), 'Applied');
  assert.equal(statePhrase({ state: 'answered', answer: 'It is in D.' }), 'Answered: It is in D.');
  assert.equal(statePhrase({ state: 'declined', answer: 'No drums here.' }), 'Declined: No drums here.');
  assert.equal(statePhrase({ state: 'notsent', reason: 'too many requests.' }), 'Not sent: too many requests.');
  assert.equal(statePhrase({ state: 'quiet', quietFor: 45000 }), 'No change yet · 45 s');
  assert.throws(() => statePhrase({ state: 'almost' }), /no wording/);
  assert.throws(() => stateMark('almost'), /no mark/);
});

test('a failed reason shows its first line cut at 80 characters, and an answer is whole in its phrase', () => {
  const reason = `${'e'.repeat(100)}\nsecond line`;
  assert.equal(statePhrase({ state: 'failed', reason }), `Failed: ${'e'.repeat(80)}…`);
  assert.equal(statePhrase({ state: 'failed', reason: 'ReferenceError: x is not defined\n  at line 3' }), 'Failed: ReferenceError: x is not defined');
  const answer = 'w'.repeat(200);
  assert.equal(statePhrase({ state: 'answered', answer }), `Answered: ${answer}`);
});

test('the marks: a ring in flight, a disc when done, a dashed ring when ended, a square when it did not work', () => {
  for (const state of ['sent', 'waiting', 'received', 'started', 'line', 'quiet']) assert.equal(stateMark(state), 'flight');
  for (const state of ['applied', 'answered']) assert.equal(stateMark(state), 'done');
  for (const state of ['declined', 'replaced', 'canceled', 'lost']) assert.equal(stateMark(state), 'ended');
  for (const state of ['failed', 'notsent']) assert.equal(stateMark(state), 'bad');
});

test('Claude has started on it carries its basis in the title', () => {
  const rig = setup();
  send(rig, 'a');
  rig.tracker.serverMessage(board('a', 'started'));
  assert.equal(rowOf(rig, 'a').phraseTitle, 'Claude made a call after this request arrived.');
  rig.tracker.serverMessage(result('a', 'received'));
  assert.equal(rowOf(rig, 'a').phrase, REQUEST_STATUS_COPY.phrases.started);
});

test('detailLines gives the request, the context and what the state means, in that order, and omits what has nothing to say', () => {
  const detailLines = need(status, 'detailLines');
  const base = { text: 'make the drums softer', chip: 'Lane bass · cycle 12, beat 3' };
  const lines = (row) => detailLines({ ...base, ...row }).map((line) => `${line.kind}: ${line.text}`);
  assert.deepEqual(lines({ state: 'sent' }), ['request: make the drums softer', 'about: About: Lane bass · cycle 12, beat 3', 'meaning: Moontide accepted the request.']);
  assert.deepEqual(lines({ state: 'received' }).slice(2), ['meaning: Claude was handed the request.']);
  assert.deepEqual(lines({ state: 'waiting' }).slice(2), ["meaning: The request waits until Claude's next Moontide call."]);
  assert.deepEqual(lines({ state: 'started' }).slice(2), ['basis: Basis: Claude made a call after this request arrived.']);
  assert.deepEqual(lines({ state: 'line' }).slice(2), ["meaning: Claude's change is ready and takes over at its line."]);
  assert.deepEqual(lines({ state: 'line', at: 'bar' }).slice(2), ["meaning: Claude's change is ready and takes over at its line. Next bar."]);
  assert.deepEqual(lines({ state: 'line', at: 'phrase' }).slice(2), ["meaning: Claude's change is ready and takes over at its line. Next phrase."]);
  assert.deepEqual(lines({ state: 'applied', version: 12 }).slice(2), ['meaning: Claude linked version v12 to this request.']);
  assert.deepEqual(lines({ state: 'applied', version: null }).slice(2), ['meaning: Claude linked a change to this request; the history could not save it, so it has no version number.']);
  assert.deepEqual(lines({ state: 'answered', answer: 'It is in D minor.' }).slice(2), ['meaning: It is in D minor.']);
  assert.deepEqual(lines({ state: 'failed', reason: 'ReferenceError: x\n  at 3' }).slice(2), ['reason: ReferenceError: x\n  at 3']);
  assert.deepEqual(lines({ state: 'quiet' }).slice(2), ['meaning: Claude has not linked a change or an answer to this request.']);
  assert.deepEqual(lines({ state: 'replaced' }).slice(2), ['meaning: A newer change took its place before it reached its line.']);
  assert.deepEqual(lines({ state: 'canceled' }).slice(2), ['meaning: The change was canceled before it reached its line.']);
  assert.deepEqual(lines({ state: 'notsent', reason: 'too many requests.' }).slice(2), ['meaning: too many requests.']);
  assert.deepEqual(lines({ state: 'lost' }).slice(2), ['meaning: Moontide lost the connection, so the page cannot tell what happened to this request.']);
  assert.deepEqual(lines({ state: 'sent', chip: '' }), ['request: make the drums softer', 'meaning: Moontide accepted the request.'], 'no context, no line');
  assert.equal(detailLines({ ...base, state: 'sent', text: 'x'.repeat(250) })[0].text, `${'x'.repeat(200)}…`);
});

test('liveSentence words each change once, and says nothing for a failure or a refusal', () => {
  const liveSentence = need(status, 'liveSentence');
  const text = 'make the drums softer';
  const said = (event) => liveSentence({ text, ...event });
  assert.equal(said({ state: 'sent' }), 'Request "make the drums softer": sent.');
  assert.equal(said({ state: 'received' }), 'Request "make the drums softer": received.');
  assert.equal(said({ state: 'waiting' }), 'Request "make the drums softer": waiting for Claude\'s next action.');
  assert.equal(said({ state: 'started' }), 'Request "make the drums softer": Claude has started on it.');
  assert.equal(said({ state: 'line' }), 'Request "make the drums softer": waiting for its line.');
  assert.equal(said({ state: 'applied', version: 12 }), 'Request "make the drums softer": applied as v12.');
  assert.equal(said({ state: 'answered', answer: 'It is D minor.' }), 'Request "make the drums softer" answered: It is D minor.');
  assert.equal(said({ state: 'declined', answer: 'Not possible.' }), 'Request "make the drums softer" declined: Not possible.');
  assert.equal(said({ state: 'quiet' }), 'Request "make the drums softer": no change yet.');
  assert.equal(said({ state: 'replaced' }), 'Request "make the drums softer": replaced by a newer change.');
  assert.equal(said({ state: 'canceled' }), 'Request "make the drums softer": canceled.');
  assert.equal(liveSentence({ state: 'lost', n: 3 }), 'Connection lost. The page cannot tell what happened to 3 open requests.');
  assert.equal(said({ state: 'failed', reason: 'x' }), null);
  assert.equal(said({ state: 'notsent', reason: 'x' }), null);
  assert.equal(liveSentence({ state: 'sent', text: 'z'.repeat(60) }), `Request "${'z'.repeat(40)}…": sent.`, 'the request is cut at 40');
  assert.throws(() => liveSentence({ state: 'almost', text }), /no sentence|unknown/);
});

test('joinLive joins at most three sentences and counts the rest', () => {
  const joinLive = need(status, 'joinLive');
  assert.equal(joinLive([]), '');
  assert.equal(joinLive(['One.']), 'One.');
  assert.equal(joinLive(['One.', 'Two.', 'Three.']), 'One. Two. Three.');
  assert.equal(joinLive(['One.', 'Two.', 'Three.', 'Four.']), 'One. Two. Three. and 1 more update.');
  assert.equal(joinLive(['1.', '2.', '3.', '4.', '5.', '6.']), '1. 2. 3. and 3 more updates.');
});

test('the tracker queues one sentence per change, once, and quiet is spoken once at the 30 s mark only', () => {
  const rig = setup();
  const takeLive = need(rig.tracker, 'takeLive');
  send(rig, 'a', 'softer drums');
  rig.tracker.serverMessage(result('a', 'waiting'));
  rig.tracker.serverMessage(result('a', 'waiting'));
  rig.tracker.serverMessage({ type: 'ask-result', id: 'a', status: 'refused', reason: 'rate-limit' });
  assert.deepEqual(takeLive(), ['Request "softer drums": sent.', 'Request "softer drums": waiting for Claude\'s next action.']);
  assert.deepEqual(takeLive(), [], 'taken once');
  send(rig, 'b', 'louder bass');
  rig.tracker.serverMessage(result('b', 'received'));
  takeLive();
  rig.time.advance(QUIET_AFTER_MS);
  assert.deepEqual(takeLive(), ['Request "louder bass": no change yet.']);
  rig.time.advance(3 * 60000);
  assert.deepEqual(takeLive(), [], 'the counting after it is silent');
  rig.tracker.serverMessage(board('b', 'failed', { reason: 'boom' }));
  assert.deepEqual(takeLive(), [], 'a failure is announced by the banner, not here');
});

test('with the link not promised, a message that only a linked change can send is ignored with one console line', (t) => {
  const lines = consoleErrors(t);
  const rig = setup({ promised: { link: false, close: true } });
  send(rig, 'a');
  rig.tracker.serverMessage(result('a', 'received'));
  rig.tracker.serverMessage(board('a', 'started'));
  const before = rig.changes.length;
  for (const message of [board('a', 'line', { at: 'bar' }), board('a', 'applied', { version: 3 }), board('a', 'failed', { reason: 'x' }), board('a', 'replaced'), board('a', 'canceled')]) {
    rig.tracker.serverMessage(message);
  }
  assert.equal(rowOf(rig, 'a').phrase, REQUEST_STATUS_COPY.phrases.started);
  assert.equal(rig.changes.length, before);
  assert.equal(lines().length, 1);
  rig.tracker.serverMessage(board('a', 'answered', { answer: 'Fine.' }));
  assert.equal(rowOf(rig, 'a').phrase, 'Answered: Fine.', 'the close is still promised');
});

test('with the link not promised, the row falls to No change yet after the quiet wait', () => {
  const rig = setup({ promised: { link: false, close: true } });
  send(rig, 'a');
  rig.tracker.serverMessage(result('a', 'received'));
  rig.tracker.serverMessage(board('a', 'started'));
  rig.tracker.serverMessage(board('a', 'applied', { version: 3 }));
  rig.time.advance(QUIET_AFTER_MS);
  assert.equal(rowOf(rig, 'a').phrase, 'No change yet · 30 s');
});

test('with the close not promised, Answered and Declined are ignored with one console line', (t) => {
  const lines = consoleErrors(t);
  const rig = setup({ promised: { link: true, close: false } });
  send(rig, 'a');
  rig.tracker.serverMessage(board('a', 'started'));
  rig.tracker.serverMessage(board('a', 'answered', { answer: 'Fine.' }));
  rig.tracker.serverMessage(board('a', 'declined', { answer: 'No.' }));
  assert.equal(rowOf(rig, 'a').phrase, REQUEST_STATUS_COPY.phrases.started);
  assert.equal(lines().length, 1);
  rig.tracker.serverMessage(board('a', 'applied', { version: 9 }));
  assert.equal(rowOf(rig, 'a').phrase, 'Applied as v9');
});

test('the page promises what the measurement supported', () => {
  assert.equal(typeof LINK_PROMISED, 'boolean');
  assert.equal(typeof CLOSE_PROMISED, 'boolean');
  assert.deepEqual([...status.LINK_STATES], ['line', 'applied', 'failed', 'replaced', 'canceled']);
  assert.deepEqual([...status.CLOSE_STATES], ['answered', 'declined']);
});

test('the board a reloaded page gets becomes rows in the states the server holds, with their ages', () => {
  const rig = setup();
  rig.time.advance(100000);
  rig.tracker.serverMessage({
    type: 'ask-board',
    requests: [
      { id: 'old', text: 'an old request', chip: 'Whole session', state: 'applied', openedAgoMs: 90000, newsAgoMs: 80000, version: 7 },
      { id: 'mid', text: 'a finished one', chip: 'Lane bass', state: 'answered', openedAgoMs: 20000, newsAgoMs: 10000, answer: 'It is D minor.' },
      { id: 'open', text: 'still going', chip: 'Whole session', state: 'started', openedAgoMs: 15000, newsAgoMs: 5000 },
      { id: 'line', text: 'timed change', chip: 'Whole session', state: 'line', openedAgoMs: 15000, newsAgoMs: 2000, at: 'bar' },
    ],
  });
  const model = rig.tracker.model();
  assert.deepEqual(model.rows.map((row) => row.id), ['line', 'open', 'mid'], 'the list is newest first');
  assert.deepEqual(model.recent.map((row) => row.id), ['old'], 'a finished request older than the window goes straight to Recent');
  assert.equal(rowOf(rig, 'old').phrase, 'Applied as v7');
  assert.equal(rowOf(rig, 'mid').phrase, 'Answered: It is D minor.');
  assert.equal(rowOf(rig, 'mid').time, '10 s', 'a finished request keeps the time it took');
  assert.equal(rowOf(rig, 'open').time, '15 s', 'a request in flight counts from when it was sent');
  assert.equal(rowOf(rig, 'open').text, 'still going');
  assert.equal(model.inFlight, 2);
  assert.equal(model.empty, false);
  rig.time.advance(QUIET_AFTER_MS - 5000 - 1);
  assert.equal(rowOf(rig, 'open').phrase, REQUEST_STATUS_COPY.phrases.started, 'the quiet wait counts from the last news the server reported');
  rig.time.advance(1);
  assert.equal(rowOf(rig, 'open').phrase, 'No change yet · 30 s');
  assert.deepEqual(need(rig.tracker, 'takeLive')(), ['Request "still going": no change yet.'], 'nothing is spoken for rows that came back');
});

test('an entry of the board for a request the page already knows follows the forward-only rule', () => {
  const rig = setup();
  send(rig, 'a');
  rig.tracker.serverMessage(board('a', 'started'));
  rig.tracker.serverMessage({ type: 'ask-board', requests: [{ id: 'a', text: 'make the drums softer', chip: 'Whole session', state: 'received', openedAgoMs: 1000, newsAgoMs: 900 }] });
  assert.equal(rowOf(rig, 'a').phrase, REQUEST_STATUS_COPY.phrases.started);
  rig.tracker.serverMessage({ type: 'ask-board', requests: [{ id: 'a', text: 'make the drums softer', chip: 'Whole session', state: 'applied', openedAgoMs: 1000, newsAgoMs: 100, version: 8 }] });
  assert.equal(rowOf(rig, 'a').phrase, 'Applied as v8');
  assert.equal(rig.tracker.model().rows.length, 1, 'the row was not duplicated');
});

test('an empty board changes nothing, and a board entry in a state that is not promised is ignored', (t) => {
  const lines = consoleErrors(t);
  const rig = setup({ promised: { link: false, close: true } });
  rig.tracker.serverMessage({ type: 'ask-board', requests: [] });
  assert.equal(rig.tracker.model().empty, true);
  assert.equal(rig.changes.length, 0);
  rig.tracker.serverMessage({ type: 'ask-board', requests: [{ id: 'a', text: 'x', chip: '', state: 'applied', openedAgoMs: 10, newsAgoMs: 5, version: 1 }] });
  assert.equal(rig.tracker.model().empty, true);
  assert.equal(lines().length, 1);
});

test('the tracker keeps at most one timer and never a repeating one', () => {
  const rig = setup();
  for (let i = 0; i < 20; i += 1) send(rig, `r${i}`, `request ${i}`);
  assert.ok(rig.time.pendingTimers() <= 1, 'one timer for the next due change, not one per row');
  rig.time.advance(ASK_CONFIRM_TIMEOUT_MS);
  assert.ok(rig.time.pendingTimers() <= 1);
  rig.time.advance(10 * 60 * 1000);
  assert.equal(rig.time.pendingTimers(), 0, 'when nothing is due no timer is left');
});
