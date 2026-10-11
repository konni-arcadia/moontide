// Unit tests for src/ask.ts, the page-to-Claude channel: tokens, per-connection
// trust, the five refusals, the bounded queue, the listener hand-over with its acknowledgement, the
// whole-queue drain, the arming line, the one-line request format and the command quoting. No
// browser and no sockets: fake page and listener connections record what they are sent.
// Imports compiled output from ../dist, never src/ (same convention as test/session.test.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import * as askModule from '../dist/ask.js';
import {
  AskChannel,
  ASK_QUEUE_MAX,
  ASK_RATE_LIMIT,
  ASK_RATE_WINDOW_MS,
  LISTENER_ACK_TIMEOUT_MS,
  MONITOR_TIMEOUT_MS,
  REQUEST_LINE_FRAMING,
  REQUEST_LINE_PREFIX,
  armingLine,
  askIdOf,
  listenerCommand,
  newToken,
  requestLine,
  tokensEqual,
} from '../dist/ask.js';
import {
  MAX_ASK_CONTEXT_LENGTH,
  MAX_ASK_TEXT_LENGTH,
  MAX_MOMENT_NOTES,
  MAX_REQUEST_LINE_BYTES,
  MOMENT_BEATS,
  askMomentNoteShape,
} from '../dist/protocol.js';
import { PAGE_TOKEN_PLACEHOLDER } from '../dist/web-server.js';
import {
  MAX_ASK_CONTEXT_LENGTH as PAGE_MAX_CONTEXT,
  MAX_ASK_TEXT_LENGTH as PAGE_MAX_TEXT,
  MAX_REQUEST_LINE_BYTES as PAGE_MAX_LINE_BYTES,
  REQUEST_LINE_PREFIX as PAGE_LINE_PREFIX,
  askTextProblem,
  MOMENT_NOTE_FIELDS,
  fitMomentToLine,
  requestFitsLine,
  requestLineBytes,
  PAGE_REQUESTS_COPY,
  PAGE_TOKEN_PLACEHOLDER as PAGE_PLACEHOLDER,
} from '../page/ask.js';
import { BEATS_PER_CYCLE } from '../page/change-timing.js';
import { MAX_MOMENT_NOTES as PAGE_MAX_MOMENT_NOTES } from '../page/timeline.js';

const SCRIPT_PATH = path.join(os.tmpdir(), 'moontide test', 'listen.js');
const PORT = 5757;

/** A fake PageConnection that records every sent frame as parsed JSON. */
function fakeConn() {
  const sent = [];
  return {
    sent,
    send(data) {
      sent.push(JSON.parse(data));
    },
  };
}

/** A fake listener that records the frames it is sent and the close() call. `send` is reassignable. */
function fakeListener() {
  const sent = [];
  const closed = [];
  return {
    sent,
    closed,
    send(data) {
      sent.push(JSON.parse(data));
    },
    close(code, reason) {
      closed.push({ code, reason });
    },
  };
}

function newChannel(options = {}) {
  return new AskChannel({ send: (conn, msg) => conn.send(JSON.stringify(msg)), ...options });
}

/** A channel with one trusted fake page. */
function trustedChannel(options = {}) {
  const channel = newChannel(options);
  const page = fakeConn();
  channel.authenticate(page, channel.pageToken);
  return { channel, page };
}

function askMsg(id, text = 'make the drums shorter') {
  return { type: 'ask', id, text, context: { kind: 'session' }, chip: 'Whole session', current: 3 };
}

/** A fake clock the rate window reads. */
function fakeClock(start = 1000) {
  let time = start;
  return {
    now: () => time,
    advance(ms) {
      time += ms;
    },
  };
}

/** Runs `fn` with console.error captured; returns the logged lines. */
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

async function captureErrorsAsync(fn) {
  const lines = [];
  const original = console.error;
  console.error = (...args) => lines.push(args.join(' '));
  try {
    await fn();
  } finally {
    console.error = original;
  }
  return lines;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = (conn) => conn.sent.filter((msg) => msg.type === 'ask-result');
const drain = (channel) => channel.drainLines({ scriptPath: SCRIPT_PATH, port: PORT });
const requestLines = (lines) => lines.filter((line) => line.startsWith(`${REQUEST_LINE_PREFIX} `));
const textOf = (line) => JSON.parse(line.slice(REQUEST_LINE_PREFIX.length + 1)).text;

function assertAllEmpty(channel) {
  assert.equal(channel.waitingCount(), 0, 'waiting queue');
  assert.equal(channel.inFlightCount(), 0, 'in flight');
}

// --- tokens ---

test('newToken gives 64 lowercase hex characters and two calls differ', () => {
  const a = newToken();
  const b = newToken();
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.match(b, /^[0-9a-f]{64}$/);
  assert.notEqual(a, b);
});

test('tokensEqual is true only for the same token: a different, shorter or longer string, undefined, a number and null give false without throwing', () => {
  const token = newToken();
  assert.equal(tokensEqual(token, token), true);
  assert.equal(tokensEqual(token, newToken()), false);
  assert.equal(tokensEqual(token, token.slice(0, -1)), false);
  assert.equal(tokensEqual(token, `${token}0`), false);
  assert.equal(tokensEqual(token, undefined), false);
  assert.equal(tokensEqual(token, 12345), false);
  assert.equal(tokensEqual(token, null), false);
});

test('an AskChannel has a page token and a listener token that differ, and two channels share neither', () => {
  const a = newChannel();
  const b = newChannel();
  assert.notEqual(a.pageToken, a.listenerToken);
  assert.notEqual(a.pageToken, b.pageToken);
  assert.notEqual(a.listenerToken, b.listenerToken);
  assert.equal(a.checkListenerToken(a.listenerToken), true);
  assert.equal(a.checkListenerToken(a.pageToken), false);
  assert.equal(a.checkListenerToken(undefined), false);
});

// --- trust ---

test('authenticate with the right token trusts the connection and answers ask-auth ok true; detachPage drops the trust', () => {
  const channel = newChannel();
  const page = fakeConn();
  channel.authenticate(page, channel.pageToken);
  assert.deepEqual(page.sent, [
    { type: 'ask-auth', ok: true },
    { type: 'page-requests', live: false },
  ]);
  assert.equal(channel.isTrusted(page), true);
  assert.equal(channel.hasTrustedPage(), true);
  assert.equal(channel.trustedCount(), 1);
  channel.detachPage(page);
  assert.equal(channel.isTrusted(page), false);
  assert.equal(channel.hasTrustedPage(), false);
  assert.equal(channel.trustedCount(), 0);
});

test('authenticate with a wrong token answers ask-auth ok false, logs one line without the given value and leaves the connection untrusted', () => {
  const channel = newChannel();
  const page = fakeConn();
  const given = 'guess-'.padEnd(64, 'x');
  const lines = captureErrors(() => channel.authenticate(page, given));
  assert.deepEqual(page.sent, [{ type: 'ask-auth', ok: false }]);
  assert.equal(channel.isTrusted(page), false);
  assert.equal(lines.length, 1);
  assert.ok(lines[0].startsWith('[moontide] Refused'), lines[0]);
  assert.ok(!lines[0].includes(given), 'the given token must never be logged');
  assert.ok(!lines[0].includes(channel.pageToken), 'the real token must never be logged');
});

test('a request from an earlier start is refused: a channel made later does not accept the earlier channel token', () => {
  const earlier = newChannel();
  const later = newChannel();
  const page = fakeConn();
  captureErrors(() => later.authenticate(page, earlier.pageToken));
  assert.equal(later.isTrusted(page), false);
  assert.equal(later.checkListenerToken(earlier.listenerToken), false);
});

// --- the page-requests state ---

const pageRequestsFrames = (conn) => conn.sent.filter((msg) => msg.type === 'page-requests');

test('authenticate with a listener already attached sends ask-auth ok then page-requests live true; a wrong token sends no page-requests frame', () => {
  const channel = newChannel();
  captureErrors(() => channel.attachListener(fakeListener()));
  const page = fakeConn();
  channel.authenticate(page, channel.pageToken);
  assert.deepEqual(page.sent, [
    { type: 'ask-auth', ok: true },
    { type: 'page-requests', live: true },
  ]);

  const stranger = fakeConn();
  captureErrors(() => channel.authenticate(stranger, 'not the token'));
  assert.deepEqual(stranger.sent, [{ type: 'ask-auth', ok: false }]);
});

test('attaching the first listener sends page-requests live true once to every trusted page and to no untrusted or detached connection', () => {
  const channel = newChannel();
  const a = fakeConn();
  const b = fakeConn();
  const gone = fakeConn();
  const stranger = fakeConn();
  channel.authenticate(a, channel.pageToken);
  channel.authenticate(b, channel.pageToken);
  channel.authenticate(gone, channel.pageToken);
  channel.detachPage(gone);
  captureErrors(() => channel.authenticate(stranger, 'not the token'));
  captureErrors(() => channel.attachListener(fakeListener()));
  assert.deepEqual(pageRequestsFrames(a), [
    { type: 'page-requests', live: false },
    { type: 'page-requests', live: true },
  ]);
  assert.deepEqual(pageRequestsFrames(b), [
    { type: 'page-requests', live: false },
    { type: 'page-requests', live: true },
  ]);
  assert.deepEqual(pageRequestsFrames(gone), [{ type: 'page-requests', live: false }], 'a detached page gets nothing more');
  assert.deepEqual(pageRequestsFrames(stranger), []);
});

test('a replacing listener sends no page-requests frame; detaching a listener that is not current sends nothing; detaching the current one sends live false once', () => {
  const { channel, page } = trustedChannel();
  const first = fakeListener();
  const second = fakeListener();
  captureErrors(() => channel.attachListener(first));
  captureErrors(() => channel.attachListener(second));
  assert.deepEqual(pageRequestsFrames(page), [
    { type: 'page-requests', live: false },
    { type: 'page-requests', live: true },
  ]);
  captureErrors(() => channel.detachListener(first));
  assert.equal(pageRequestsFrames(page).length, 2, 'the replaced listener closing changes nothing');
  captureErrors(() => channel.detachListener(second));
  assert.deepEqual(pageRequestsFrames(page).at(-1), { type: 'page-requests', live: false });
  assert.equal(pageRequestsFrames(page).length, 3);
  captureErrors(() => channel.detachListener(second));
  assert.equal(pageRequestsFrames(page).length, 3, 'a second detach sends nothing');
});

test('an ack timeout sends page-requests live false exactly once', async () => {
  const { channel, page } = trustedChannel({ ackTimeoutMs: 20 });
  const listener = fakeListener();
  await captureErrorsAsync(async () => {
    channel.attachListener(listener);
    channel.handleAsk(page, askMsg('t1'));
    await sleep(80);
  });
  assert.deepEqual(pageRequestsFrames(page), [
    { type: 'page-requests', live: false },
    { type: 'page-requests', live: true },
    { type: 'page-requests', live: false },
  ]);
});

test('a page-requests frame holds only type and live, and never a token', () => {
  const { channel, page } = trustedChannel();
  const listener = fakeListener();
  captureErrors(() => channel.attachListener(listener));
  captureErrors(() => channel.detachListener(listener));
  const frames = pageRequestsFrames(page);
  assert.equal(frames.length, 3);
  for (const frame of frames) {
    assert.deepEqual(Object.keys(frame), ['type', 'live']);
    assert.equal(typeof frame.live, 'boolean');
    const raw = JSON.stringify(frame);
    assert.ok(!raw.includes(channel.pageToken), 'never the page token');
    assert.ok(!raw.includes(channel.listenerToken), 'never the listener token');
  }
});

// --- refusals ---

test('an ask from an untrusted connection is refused "token" and logged once for three attempts, with one summary line naming 2 more on detachPage', () => {
  const channel = newChannel();
  const page = fakeConn();
  const lines = captureErrors(() => {
    channel.handleAsk(page, askMsg('a1'));
    channel.handleAsk(page, askMsg('a2'));
    channel.handleAsk(page, askMsg('a3'));
  });
  assert.equal(lines.length, 1, 'only the first refusal is logged');
  assert.equal(
    lines[0],
    '[moontide] Refused a page request: the connection did not present the page token',
  );
  assert.deepEqual(
    results(page).map((msg) => [msg.id, msg.status, msg.reason]),
    [
      ['a1', 'refused', 'token'],
      ['a2', 'refused', 'token'],
      ['a3', 'refused', 'token'],
    ],
  );
  const summary = captureErrors(() => channel.detachPage(page));
  assert.deepEqual(summary, ['[moontide] Refused 2 more page requests from that connection']);
  assertAllEmpty(channel);
});

test('text of 2001 characters is refused "too-long" and logged, and 2000 characters is accepted', () => {
  const { channel, page } = trustedChannel();
  const lines = captureErrors(() => channel.handleAsk(page, askMsg('long', 'x'.repeat(MAX_ASK_TEXT_LENGTH + 1))));
  assert.equal(lines.length, 1);
  assert.ok(lines[0].startsWith('[moontide] Refused a page request'), lines[0]);
  assert.ok(!lines[0].includes('xxxx'), 'the text is never logged');
  const refusal = results(page).at(-1);
  assert.equal(refusal.status, 'refused');
  assert.equal(refusal.reason, 'too-long');
  assert.equal(channel.waitingCount(), 0);

  channel.handleAsk(page, askMsg('fits', 'x'.repeat(MAX_ASK_TEXT_LENGTH)));
  assert.deepEqual(results(page).at(-1), { type: 'ask-result', id: 'fits', status: 'waiting', waiting: 1 });
});

test('a text of only spaces is refused "invalid" with the detail "empty request"', () => {
  const { channel, page } = trustedChannel();
  const lines = captureErrors(() => channel.handleAsk(page, askMsg('blank', '   \n ')));
  assert.equal(lines.length, 1);
  assert.deepEqual(results(page).at(-1), {
    type: 'ask-result',
    id: 'blank',
    status: 'refused',
    reason: 'invalid',
    detail: 'empty request',
  });
  assert.equal(channel.waitingCount(), 0);
});

test('the sixth request inside one rolling second is refused "rate-limit" (logged once per window) and a request after the window is accepted', () => {
  const clock = fakeClock();
  const { channel, page } = trustedChannel({ now: clock.now });
  const lines = captureErrors(() => {
    for (let i = 1; i <= ASK_RATE_LIMIT; i++) {
      channel.handleAsk(page, askMsg(`r${i}`));
    }
    channel.handleAsk(page, askMsg('r6'));
    channel.handleAsk(page, askMsg('r7'));
  });
  assert.equal(results(page).filter((msg) => msg.status === 'waiting').length, ASK_RATE_LIMIT);
  const refused = results(page).filter((msg) => msg.status === 'refused');
  assert.deepEqual(
    refused.map((msg) => [msg.id, msg.reason]),
    [
      ['r6', 'rate-limit'],
      ['r7', 'rate-limit'],
    ],
  );
  assert.equal(lines.length, 1, 'the rate-limit refusal is logged once per window');
  assert.ok(lines[0].includes('more than 5 in one second'), lines[0]);

  clock.advance(ASK_RATE_WINDOW_MS);
  channel.handleAsk(page, askMsg('after'));
  assert.equal(results(page).at(-1).status, 'waiting');
});

test('the rate limit is one rolling window shared by every trusted page', () => {
  const clock = fakeClock();
  const channel = newChannel({ now: clock.now });
  const first = fakeConn();
  const second = fakeConn();
  channel.authenticate(first, channel.pageToken);
  channel.authenticate(second, channel.pageToken);
  for (let i = 1; i <= 3; i++) channel.handleAsk(first, askMsg(`f${i}`));
  for (let i = 1; i <= 2; i++) channel.handleAsk(second, askMsg(`s${i}`));
  captureErrors(() => channel.handleAsk(second, askMsg('s3')));
  assert.equal(results(second).at(-1).reason, 'rate-limit');
});

test('with no listener the 21st waiting request is refused "queue-full"', () => {
  const clock = fakeClock();
  const { channel, page } = trustedChannel({ now: clock.now });
  const lines = captureErrors(() => {
    for (let i = 1; i <= ASK_QUEUE_MAX; i++) {
      channel.handleAsk(page, askMsg(`q${i}`));
      clock.advance(300);
    }
    channel.handleAsk(page, askMsg('q21'));
  });
  assert.equal(channel.waitingCount(), ASK_QUEUE_MAX);
  assert.deepEqual(results(page).at(-1), {
    type: 'ask-result',
    id: 'q21',
    status: 'refused',
    reason: 'queue-full',
  });
  assert.equal(lines.length, 1);
  assert.ok(lines[0].startsWith('[moontide] Refused a page request'), lines[0]);
});

test('refuseInvalid on a trusted connection answers "invalid" with the detail cut to 200 characters and on an untrusted one answers "token"', () => {
  const { channel, page } = trustedChannel();
  const lines = captureErrors(() => channel.refuseInvalid(page, 'bad1', 'd'.repeat(500)));
  assert.equal(lines.length, 1);
  const refusal = results(page).at(-1);
  assert.equal(refusal.reason, 'invalid');
  assert.equal(refusal.detail.length, 200);

  const stranger = fakeConn();
  captureErrors(() => channel.refuseInvalid(stranger, 'bad2', 'anything'));
  assert.equal(results(stranger).at(-1).reason, 'token');
});

// --- waiting and drain ---

test('with no listener an accepted ask answers waiting with the queue length, and drainLines hands over the request lines oldest first, then the arming line', () => {
  const { channel, page } = trustedChannel();
  channel.handleAsk(page, askMsg('w1', 'make the drums shorter'));
  channel.handleAsk(page, askMsg('w2', 'make the hats quieter'));
  assert.deepEqual(
    results(page).map((msg) => [msg.id, msg.status, msg.waiting]),
    [
      ['w1', 'waiting', 1],
      ['w2', 'waiting', 2],
    ],
  );
  const lines = drain(channel);
  assert.equal(lines.length, 3);
  assert.deepEqual(requestLines(lines).map(textOf), ['make the drums shorter', 'make the hats quieter']);
  assert.ok(lines[2].startsWith('Page requests: no listener is connected.'), lines[2]);
  assert.deepEqual(page.sent.at(-1), { type: 'ask-received', ids: ['w1', 'w2'] });
  assertAllEmpty(channel);

  const again = drain(channel);
  assert.equal(requestLines(again).length, 0);
  assert.equal(again.length, 1, 'only the arming line comes back');
});

// Claude reads the field name `moment`, so the texts it reads when page requests
// matter say what the field holds. Facts only, in every place a request line can reach Claude without the
// instructions' short framing.
test('the moment fact says what the moment holds, and reaches Claude in the arming line, the on text and the paused path', () => {
  const fact = askModule.REQUEST_LINE_MOMENT_FACT;
  for (const piece of [
    "what the page's Timeline showed where the user right-clicked",
    'the beat of the bar (1 to 4)',
    'at the instant in cycles',
    'version the version that was playing',
    'start and end in cycles',
    'the notes of the lane the user right-clicked first',
    `at most ${MAX_MOMENT_NOTES}`,
    'more counts the notes left out',
    'State sounding means the drawn span of the note holds at',
    'a very short note is drawn wider than it lasts, so its end can come before at',
    'State starts means the note begins after at, in the same sixteenth of the bar',
    'A note that began earlier in that sixteenth and has ended is not listed',
    "drum, the name its instrument's drum map gives that note number",
    'absent when no map names it',
  ]) {
    assert.ok(fact.includes(piece), piece);
  }
  assert.doesNotMatch(fact, /listen/i);
  assert.ok(!fact.includes(REQUEST_LINE_PREFIX), 'the fact is not itself a request line');
  const token = newToken();
  assert.ok(armingLine({ scriptPath: SCRIPT_PATH, port: PORT, token }).includes(fact));
  assert.ok(armingLine({ scriptPath: SCRIPT_PATH, port: null, token }).includes(fact));
  assert.ok(askModule.pageRequestsOnText({ scriptPath: SCRIPT_PATH, port: PORT, token }).includes(fact));

  // Paused (no arming line): the fact comes in front of the request lines; with nothing to hand over, nothing.
  const { channel, page } = trustedChannel();
  channel.setArmingPaused(true);
  assert.deepEqual(drain(channel), []);
  channel.handleAsk(page, askMsg('m1', 'make the drums shorter'));
  const lines = drain(channel);
  assert.equal(lines[0], fact);
  assert.deepEqual(requestLines(lines).map(textOf), ['make the drums shorter']);
  // With the arming line it is in that line, not twice.
  channel.setArmingPaused(false);
  channel.handleAsk(page, askMsg('m2', 'make the hats quieter'));
  const armed = drain(channel);
  assert.equal(armed.filter((line) => line.includes(fact)).length, 1);
  assert.ok(armed.at(-1).includes(fact));
});

test('drainLines carries no arming line when no page is trusted, and none while a listener is connected', () => {
  const channel = newChannel();
  assert.deepEqual(drain(channel), []);

  const page = fakeConn();
  channel.authenticate(page, channel.pageToken);
  assert.equal(drain(channel).length, 1);
  channel.attachListener(fakeListener());
  assert.deepEqual(drain(channel), []);
});

test('a queued request whose page detached is still drained, and nobody is sent ask-received', () => {
  const { channel, page } = trustedChannel();
  channel.handleAsk(page, askMsg('gone'));
  channel.detachPage(page);
  const other = fakeConn();
  channel.authenticate(other, channel.pageToken);
  const lines = drain(channel);
  assert.deepEqual(requestLines(lines).map(textOf), ['make the drums shorter']);
  assert.equal(page.sent.filter((msg) => msg.type === 'ask-received').length, 0);
  assert.equal(other.sent.filter((msg) => msg.type === 'ask-received').length, 0);
  assertAllEmpty(channel);
});

test('drainLines sends one ask-received per page, grouped, with the ids in order', () => {
  const clock = fakeClock();
  const channel = newChannel({ now: clock.now });
  const a = fakeConn();
  const b = fakeConn();
  channel.authenticate(a, channel.pageToken);
  channel.authenticate(b, channel.pageToken);
  channel.handleAsk(a, askMsg('a1'));
  channel.handleAsk(b, askMsg('b1'));
  channel.handleAsk(a, askMsg('a2'));
  drain(channel);
  assert.deepEqual(a.sent.filter((msg) => msg.type === 'ask-received'), [{ type: 'ask-received', ids: ['a1', 'a2'] }]);
  assert.deepEqual(b.sent.filter((msg) => msg.type === 'ask-received'), [{ type: 'ask-received', ids: ['b1'] }]);
});

// --- listener ---

test('with a listener attached an ask is sent as one { id, line } frame and answers nothing until the ack; the ack answers received', () => {
  const { channel, page } = trustedChannel();
  const listener = fakeListener();
  captureErrors(() => channel.attachListener(listener));
  channel.handleAsk(page, askMsg('l1'));
  assert.equal(listener.sent.length, 1);
  assert.deepEqual(Object.keys(listener.sent[0]), ['id', 'line']);
  assert.equal(listener.sent[0].id, 'l1');
  assert.ok(listener.sent[0].line.startsWith(`${REQUEST_LINE_PREFIX} `));
  assert.equal(results(page).length, 0, 'nothing is answered before the ack');
  assert.equal(channel.inFlightCount(), 1);
  assert.deepEqual(drain(channel), [], 'a request in flight is never also emitted in a tool reply');

  channel.handleListenerMessage(listener, JSON.stringify({ ack: 'l1' }));
  assert.deepEqual(results(page), [{ type: 'ask-result', id: 'l1', status: 'received' }]);
  assertAllEmpty(channel);
});

test('refusals of the same kind are logged once per window, with the count of the ones left out, and the page is answered every time', () => {
  const clock = fakeClock();
  const { channel, page } = trustedChannel({ now: clock.now });
  const stranger = fakeConn();
  const logged = captureErrors(() => {
    for (let i = 0; i < 4; i++) {
      channel.handleAsk(page, askMsg(`e${i}`, '   '));
      channel.refuseInvalid(page, `m${i}`, 'bad shape');
      channel.authenticate(stranger, 'not the token');
      channel.handleAsk(page, askMsg(`t${i}`, 'x'.repeat(MAX_ASK_TEXT_LENGTH + 1)));
    }
  });
  // One line per kind (empty, malformed, auth, too-long) for the whole burst.
  assert.equal(logged.length, 4, logged.join('\n'));
  assert.equal(results(page).filter((msg) => msg.status === 'refused').length, 12, 'every refusal is still answered');
  assert.equal(stranger.sent.filter((msg) => msg.ok === false).length, 4);

  clock.advance(ASK_RATE_WINDOW_MS);
  const later = captureErrors(() => channel.handleAsk(page, askMsg('e-late', '   ')));
  assert.equal(later.length, 1);
  assert.match(later[0], /3 similar refusals since the last line were not logged/);
  assert.ok(!later[0].includes('not the token'), 'the given token is never logged');
});

test('a request whose id is already in flight or waiting is refused "invalid" and never corrupts the in-flight table', () => {
  const { channel, page } = trustedChannel();
  const listener = fakeListener();
  captureErrors(() => channel.attachListener(listener));
  channel.handleAsk(page, askMsg('dup'));
  const logged = captureErrors(() => channel.handleAsk(page, askMsg('dup', 'a second one')));
  assert.equal(logged.length, 1);
  assert.equal(listener.sent.length, 1, 'the repeated id is never written to the listener');
  assert.equal(channel.inFlightCount(), 1);
  assert.deepEqual(results(page), [
    { type: 'ask-result', id: 'dup', status: 'refused', reason: 'invalid', detail: 'duplicate request id' },
  ]);
  channel.handleListenerMessage(listener, JSON.stringify({ ack: 'dup' }));
  assert.equal(results(page).filter((msg) => msg.status === 'received').length, 1);
  assertAllEmpty(channel);
  assert.deepEqual(listener.closed, [], 'the healthy listener is left open');

  // Once the first is acknowledged the id is free again.
  channel.handleAsk(page, askMsg('dup'));
  assert.equal(channel.inFlightCount(), 1);

  // The same holds for a request that waits while nobody listens.
  const waiting = trustedChannel();
  waiting.channel.handleAsk(waiting.page, askMsg('w1'));
  captureErrors(() => waiting.channel.handleAsk(waiting.page, askMsg('w1')));
  assert.equal(waiting.channel.waitingCount(), 1);
  assert.equal(results(waiting.page).at(-1).reason, 'invalid');
});

test('an ack for an unknown id, an unreadable frame, or one from a replaced listener is ignored and logged', () => {
  const { channel, page } = trustedChannel();
  const first = fakeListener();
  const second = fakeListener();
  captureErrors(() => channel.attachListener(first));
  channel.handleAsk(page, askMsg('k1'));
  const unknown = captureErrors(() => channel.handleListenerMessage(first, JSON.stringify({ ack: 'nope' })));
  assert.equal(unknown.length, 1);
  const bad = captureErrors(() => channel.handleListenerMessage(first, 'not json'));
  assert.equal(bad.length, 1);
  assert.equal(channel.inFlightCount(), 1);

  captureErrors(() => channel.attachListener(second));
  const stale = captureErrors(() => channel.handleListenerMessage(first, JSON.stringify({ ack: 'k1' })));
  assert.equal(stale.length, 1);
  assert.equal(results(page).filter((msg) => msg.status === 'received').length, 0);
  channel.handleListenerMessage(second, JSON.stringify({ ack: 'k1' }));
  assert.equal(results(page).filter((msg) => msg.status === 'received').length, 1);
});

test('no ack within ackTimeoutMs closes the listener with code 4002 and puts the request back at the front of the queue, answered waiting', async () => {
  const { channel, page } = trustedChannel({ ackTimeoutMs: 20 });
  const listener = fakeListener();
  const lines = await captureErrorsAsync(async () => {
    channel.attachListener(listener);
    channel.handleAsk(page, askMsg('t1'));
    await sleep(80);
  });
  assert.equal(listener.closed.length, 1);
  assert.equal(listener.closed[0].code, 4002);
  assert.ok(lines.some((line) => line.includes('did not confirm a request in time')), lines.join('\n'));
  assert.equal(channel.hasListener(), false);
  assert.equal(channel.inFlightCount(), 0);
  assert.equal(channel.waitingCount(), 1);
  assert.deepEqual(results(page).at(-1), { type: 'ask-result', id: 't1', status: 'waiting', waiting: 1 });

  const handedOver = drain(channel);
  assert.deepEqual(requestLines(handedOver).map(textOf), ['make the drums shorter']);
  assert.deepEqual(page.sent.at(-1), { type: 'ask-received', ids: ['t1'] });
  assertAllEmpty(channel);
});

test('a listener closing with two requests in flight puts both back in order, answered waiting', () => {
  const clock = fakeClock();
  const { channel, page } = trustedChannel({ now: clock.now });
  const listener = fakeListener();
  captureErrors(() => channel.attachListener(listener));
  channel.handleAsk(page, askMsg('c1', 'first one'));
  channel.handleAsk(page, askMsg('c2', 'second one'));
  assert.equal(channel.inFlightCount(), 2);

  const lines = captureErrors(() => channel.detachListener(listener));
  assert.equal(lines.length, 1);
  assert.equal(channel.hasListener(), false);
  assert.equal(channel.inFlightCount(), 0);
  assert.equal(channel.waitingCount(), 2);
  assert.deepEqual(
    results(page).map((msg) => [msg.id, msg.status, msg.waiting]),
    [
      ['c1', 'waiting', 2],
      ['c2', 'waiting', 2],
    ],
  );
  assert.deepEqual(requestLines(drain(channel)).map(textOf), ['first one', 'second one']);
  assertAllEmpty(channel);
});

test('attaching a second listener closes the first with code 4001 and sends the queued requests to the new one; its acks answer ask-received for requests that were waiting', () => {
  const { channel, page } = trustedChannel();
  channel.handleAsk(page, askMsg('n1', 'queued one'));
  channel.handleAsk(page, askMsg('n2', 'queued two'));
  const first = fakeListener();
  captureErrors(() => channel.attachListener(first));
  assert.deepEqual(first.sent.map((frame) => frame.id), ['n1', 'n2']);

  const second = fakeListener();
  captureErrors(() => channel.attachListener(second));
  assert.deepEqual(first.closed, [{ code: 4001, reason: 'replaced by a newer listener' }]);
  // The same ids, in the same order: a request re-sent after a lost ack keeps its id.
  assert.deepEqual(second.sent.map((frame) => frame.id), ['n1', 'n2']);
  assert.equal(channel.waitingCount(), 0);

  // The old listener's socket closing later is ignored.
  captureErrors(() => channel.detachListener(first));
  assert.equal(channel.hasListener(), true);
  assert.equal(channel.inFlightCount(), 2);

  channel.handleListenerMessage(second, JSON.stringify({ ack: 'n1' }));
  channel.handleListenerMessage(second, JSON.stringify({ ack: 'n2' }));
  assert.deepEqual(page.sent.filter((msg) => msg.type === 'ask-received'), [
    { type: 'ask-received', ids: ['n1'] },
    { type: 'ask-received', ids: ['n2'] },
  ]);
  assertAllEmpty(channel);
});

test('a throwing listener send takes the same path as a missing ack', () => {
  const { channel, page } = trustedChannel();
  const listener = fakeListener();
  listener.send = () => {
    throw new Error('socket is not open');
  };
  captureErrors(() => {
    channel.attachListener(listener);
    channel.handleAsk(page, askMsg('x1'));
  });
  assert.equal(listener.closed[0].code, 4002);
  assert.equal(channel.hasListener(), false);
  assert.equal(channel.waitingCount(), 1);
  assert.equal(channel.inFlightCount(), 0);
  assert.deepEqual(results(page).at(-1), { type: 'ask-result', id: 'x1', status: 'waiting', waiting: 1 });
});

test('a page that leaves while its request is in flight is not answered', () => {
  const { channel, page } = trustedChannel();
  const listener = fakeListener();
  captureErrors(() => channel.attachListener(listener));
  channel.handleAsk(page, askMsg('p1'));
  channel.detachPage(page);
  channel.handleListenerMessage(listener, JSON.stringify({ ack: 'p1' }));
  assert.equal(results(page).length, 0);
  assertAllEmpty(channel);
});

test('waitingCount, inFlightCount and trustedCount return to 0 after a full scenario', () => {
  const { channel, page } = trustedChannel();
  const listener = fakeListener();
  captureErrors(() => channel.attachListener(listener));
  channel.handleAsk(page, askMsg('z1'));
  channel.handleListenerMessage(listener, JSON.stringify({ ack: 'z1' }));
  captureErrors(() => channel.detachListener(listener));
  channel.handleAsk(page, askMsg('z2'));
  drain(channel);
  channel.detachPage(page);
  assertAllEmpty(channel);
  assert.equal(channel.trustedCount(), 0);
});

// --- lines ---

test('requestLine starts with the prefix, never contains a line break, and JSON.parse of the rest gives the request back exactly', () => {
  const text = 'first line\nsecond line\r\nthird\u2028fourth';
  const request = {
    id: 'ask-1',
    text,
    context: { kind: 'line', line: 3, text: 'note("c4")' },
    chip: 'Line 3 · note("c4")',
    current: 12,
  };
  const line = requestLine(request);
  assert.ok(line.startsWith('Request from the Moontide page: '));
  assert.ok(!line.includes('\n'));
  assert.ok(!line.includes('\r'));
  assert.ok(!line.includes('\u2028'));
  assert.deepEqual(JSON.parse(line.slice('Request from the Moontide page: '.length)), request);
});

test('requestLine keeps the keys in the order id, text, context, chip, current, and carries a null current', () => {
  const line = requestLine({ id: 'a', text: 't', context: { kind: 'session' }, chip: 'Whole session', current: null });
  assert.deepEqual(Object.keys(JSON.parse(line.slice(REQUEST_LINE_PREFIX.length + 1))), [
    'id',
    'text',
    'context',
    'chip',
    'current',
  ]);
  assert.ok(line.endsWith('"current":null}'));
});

test('requestLine with a moment puts it last, keeps it whole and leaves no raw line separator', () => {
  const request = {
    id: 'ask-2',
    text: 'too loud here',
    context: { kind: 'lane', track: 'lead', cycle: 34 },
    chip: 'Lane lead \u00B7 cycle 34, beat 3 \u00B7 2 notes',
    current: 12,
    moment: {
      cycle: 34,
      beat: 3,
      at: 34.5,
      version: 12,
      notes: [
        { track: 'lead\u2028two', instrument: 'synth \u00B7 ch 3', note: 'g4', velocity: 0.35, start: 34.5, end: 34.75, state: 'sounding' },
        { track: 'drums', sound: 'bd', velocity: 0.8, start: 34.5, end: 34.6, state: 'starts' },
      ],
      more: 0,
    },
  };
  const line = requestLine(request);
  assert.ok(!line.includes('\n'));
  assert.ok(!line.includes('\u2028'), 'U+2028 inside a note track is escaped');
  assert.ok(!line.includes('\u2029'));
  const parsed = JSON.parse(line.slice(REQUEST_LINE_PREFIX.length + 1));
  assert.deepEqual(Object.keys(parsed), ['id', 'text', 'context', 'chip', 'current', 'moment']);
  assert.deepEqual(parsed, request);
  assert.equal(parsed.moment.notes[0].track, 'lead\u2028two');
});

test('armingLine with a command names the command and timeout_ms 1800000, and states facts only', () => {
  const token = newToken();
  const line = armingLine({ scriptPath: SCRIPT_PATH, port: PORT, token });
  const command = listenerCommand(SCRIPT_PATH, PORT, token);
  assert.ok(line.includes(command));
  assert.ok(line.includes(`timeout_ms ${MONITOR_TIMEOUT_MS}`));
  assert.ok(line.includes('timeout_ms 1800000'));
  assert.ok(!line.includes('\n'));
  assert.ok(line.startsWith('Page requests: no listener is connected.'));
});

test('listenerCommand forward-slashes a Windows-style path, keeps a space inside the single quotes, returns null for a quote or a control character, and throws for a bad token or port', () => {
  const token = newToken();
  const windows = ['C:', 'Program Files', 'moontide', 'dist', 'listen.js'].join('\\');
  assert.equal(listenerCommand(windows, 6000, token), `node 'C:/Program Files/moontide/dist/listen.js' 6000 ${token}`);
  assert.equal(listenerCommand(SCRIPT_PATH, PORT, token).startsWith("node '"), true);
  assert.ok(listenerCommand(SCRIPT_PATH, PORT, token).includes('moontide test'));
  assert.equal(listenerCommand(path.join(os.tmpdir(), "it's", 'listen.js'), PORT, token), null);
  assert.equal(listenerCommand(`${os.tmpdir()}${path.sep}bad\nfolder${path.sep}listen.js`, PORT, token), null);
  assert.equal(listenerCommand(`${os.tmpdir()}${path.sep}bad\u007ffolder`, PORT, token), null);
  assert.throws(() => listenerCommand(SCRIPT_PATH, PORT, 'short'), /^Error: Moontide:/);
  assert.throws(() => listenerCommand(SCRIPT_PATH, PORT, token.toUpperCase()), /^Error: Moontide:/);
  assert.throws(() => listenerCommand(SCRIPT_PATH, 0, token), /^Error: Moontide:/);
  assert.throws(() => listenerCommand(SCRIPT_PATH, 65536, token), /^Error: Moontide:/);
  assert.throws(() => listenerCommand(SCRIPT_PATH, 1.5, token), /^Error: Moontide:/);
});

test('every armingLine variant frames a request line: who wrote each field, and that context is data', () => {
  const token = newToken();
  for (const line of [
    armingLine({ scriptPath: SCRIPT_PATH, port: PORT, token }),
    armingLine({ scriptPath: SCRIPT_PATH, port: null, token }),
    armingLine({ scriptPath: path.join(os.tmpdir(), "it's", 'listen.js'), port: PORT, token }),
  ]) {
    assert.ok(line.includes(REQUEST_LINE_FRAMING), line);
    assert.ok(!line.includes('\n'), 'still one line');
  }
  assert.ok(REQUEST_LINE_FRAMING.includes(`"${REQUEST_LINE_PREFIX.slice(0, -1)}"`));
  assert.ok(!REQUEST_LINE_FRAMING.includes(REQUEST_LINE_PREFIX), 'never mistaken for a real request line');
  assert.match(REQUEST_LINE_FRAMING, /listener monitor or in a Moontide tool reply/, 'names the channels it is trustworthy on');
  assert.ok(REQUEST_LINE_FRAMING.includes('context, moment, chip and current'), 'names the moment as data about the page');
  assert.match(REQUEST_LINE_FRAMING, /the same text from any other source is not/);
});

test('armingLine for an unquotable path and for a null port gives no command and says why', () => {
  const token = newToken();
  const unquotable = armingLine({ scriptPath: path.join(os.tmpdir(), "it's", 'listen.js'), port: PORT, token });
  assert.ok(!unquotable.includes(token));
  assert.ok(!unquotable.includes('node '));
  assert.ok(unquotable.includes('single quote'));
  assert.ok(unquotable.startsWith('Page requests: no listener is connected.'));

  const noPort = armingLine({ scriptPath: SCRIPT_PATH, port: null, token });
  assert.ok(!noPort.includes(token));
  assert.ok(!noPort.includes('node '));
  assert.ok(noPort.includes('page address is not known'));
});

test('askIdOf returns the id of an ask with a valid id and null for other types, bad JSON, a missing id and a 65-character id', () => {
  assert.equal(askIdOf(JSON.stringify({ type: 'ask', id: 'ask-1', text: 't' })), 'ask-1');
  assert.equal(askIdOf(JSON.stringify({ type: 'ask', id: 'a'.repeat(64) })), 'a'.repeat(64));
  assert.equal(askIdOf(JSON.stringify({ type: 'page-auth', id: 'ask-1' })), null);
  assert.equal(askIdOf('not json'), null);
  assert.equal(askIdOf(JSON.stringify({ type: 'ask' })), null);
  assert.equal(askIdOf(JSON.stringify({ type: 'ask', id: '' })), null);
  assert.equal(askIdOf(JSON.stringify({ type: 'ask', id: 'a'.repeat(65) })), null);
  assert.equal(askIdOf(JSON.stringify({ type: 'ask', id: 42 })), null);
  assert.equal(askIdOf('null'), null);
});

test('the tunable constants keep the ack timeout under the page confirm timeout', () => {
  assert.equal(ASK_RATE_LIMIT, 5);
  assert.equal(ASK_RATE_WINDOW_MS, 1000);
  assert.equal(ASK_QUEUE_MAX, 20);
  assert.ok(LISTENER_ACK_TIMEOUT_MS < 5000);
});

// --- page requests on and off ---
// Namespace reads (askModule.x): a named import of a missing export would crash the whole file.

test('listenerCommandOrReason gives the command for a good path and port, and a reason without the word listen otherwise', () => {
  const token = newToken();
  assert.deepEqual(askModule.listenerCommandOrReason({ scriptPath: SCRIPT_PATH, port: PORT, token }), {
    command: listenerCommand(SCRIPT_PATH, PORT, token),
  });
  const noPort = askModule.listenerCommandOrReason({ scriptPath: SCRIPT_PATH, port: null, token });
  assert.deepEqual(Object.keys(noPort), ['reason']);
  assert.ok(noPort.reason.includes('page address is not known'), noPort.reason);
  const quote = askModule.listenerCommandOrReason({ scriptPath: path.join(os.tmpdir(), "it's", 'listen.js'), port: PORT, token });
  assert.deepEqual(Object.keys(quote), ['reason']);
  assert.ok(quote.reason.includes('single quote'), quote.reason);
  for (const { reason } of [noPort, quote]) {
    assert.doesNotMatch(reason, /listen/i);
    assert.ok(!reason.includes(token));
  }
});

test('armingLine keeps its command variant byte for byte, and its two reason variants say the reason after the head', () => {
  const token = newToken();
  const head =
    'Page requests: no listener is connected. A request typed in the Moontide page waits on the server and arrives in the reply of your next other Moontide tool. ' +
    `${REQUEST_LINE_FRAMING} ${askModule.REQUEST_LINE_MOMENT_FACT}`;
  assert.equal(askModule.MONITOR_LIMIT_FACT, 'a monitor ends after at most 30 minutes');
  const command = listenerCommand(SCRIPT_PATH, PORT, token);
  const withCommand = armingLine({ scriptPath: SCRIPT_PATH, port: PORT, token });
  assert.equal(
    withCommand,
    `${head} To receive each request as it is sent, run this command with the Monitor tool and timeout_ms 1800000 ` +
      `(a monitor ends after at most 30 minutes, and this line comes back once it has ended): ${command}`,
  );
  assert.ok(withCommand.includes(askModule.MONITOR_LIMIT_FACT));
  const noPortReason = askModule.listenerCommandOrReason({ scriptPath: SCRIPT_PATH, port: null, token }).reason;
  assert.equal(armingLine({ scriptPath: SCRIPT_PATH, port: null, token }), `${head} ${noPortReason}`);
  const quotePath = path.join(os.tmpdir(), "it's", 'listen.js');
  const quoteReason = askModule.listenerCommandOrReason({ scriptPath: quotePath, port: PORT, token }).reason;
  assert.equal(armingLine({ scriptPath: quotePath, port: PORT, token }), `${head} ${quoteReason}`);
});

test('pageRequestsOnText gives the command with Monitor, timeout_ms 1800000, the description, the 30-minute fact and the framing; it throws the reason when there is no command', () => {
  const token = newToken();
  const text = askModule.pageRequestsOnText({ scriptPath: SCRIPT_PATH, port: PORT, token });
  const command = listenerCommand(SCRIPT_PATH, PORT, token);
  const lines = text.split('\n');
  assert.equal(lines.length, 5);
  assert.equal(lines[1], command);
  assert.equal(lines[3], REQUEST_LINE_FRAMING);
  assert.equal(lines[4], askModule.REQUEST_LINE_MOMENT_FACT);
  for (const piece of ['Monitor', `timeout_ms ${MONITOR_TIMEOUT_MS}`, askModule.MONITOR_DESCRIPTION, askModule.MONITOR_LIMIT_FACT]) {
    assert.ok(text.includes(piece), piece);
  }
  assert.ok(!text.includes('persistent'));
  assert.doesNotMatch(text.replace(command, '').replace(REQUEST_LINE_FRAMING, ''), /listen/i);

  const noPortReason = askModule.listenerCommandOrReason({ scriptPath: SCRIPT_PATH, port: null, token }).reason;
  assert.throws(
    () => askModule.pageRequestsOnText({ scriptPath: SCRIPT_PATH, port: null, token }),
    (error) => error instanceof Error && error.message === noPortReason,
  );
  const quotePath = path.join(os.tmpdir(), "it's", 'listen.js');
  const quoteReason = askModule.listenerCommandOrReason({ scriptPath: quotePath, port: PORT, token }).reason;
  assert.throws(
    () => askModule.pageRequestsOnText({ scriptPath: quotePath, port: PORT, token }),
    (error) => error instanceof Error && error.message === quoteReason,
  );
});

test('the page-requests prompt names, titles, descriptions and texts never use the word listen and hold no token', () => {
  assert.equal(askModule.PAGE_REQUESTS_ON_PROMPT, 'page-requests-on');
  assert.equal(askModule.PAGE_REQUESTS_OFF_PROMPT, 'page-requests-off');
  assert.equal(askModule.MONITOR_DESCRIPTION, 'Moontide page requests');
  assert.ok(askModule.PAGE_REQUESTS_OFF_NOTE.includes(askModule.PAGE_REQUESTS_ON_PROMPT));
  assert.ok(askModule.PAGE_REQUESTS_OFF_TEXT.includes('TaskStop'));
  assert.ok(askModule.PAGE_REQUESTS_OFF_TEXT.includes(askModule.MONITOR_DESCRIPTION));
  assert.ok(askModule.PAGE_REQUESTS_OFF_TEXT.endsWith(askModule.PAGE_REQUESTS_OFF_NOTE));
  assert.ok(askModule.PAGE_REQUESTS_ALREADY_OFF.endsWith(askModule.PAGE_REQUESTS_OFF_NOTE));
  const noPage = askModule.noPageForRequestsText('http://localhost:5757');
  assert.ok(noPage.startsWith('No Moontide page is connected'));
  assert.ok(noPage.includes('http://localhost:5757'));
  assert.ok(noPage.includes(askModule.PAGE_REQUESTS_ON_PROMPT));
  for (const text of [
    askModule.PAGE_REQUESTS_ON_PROMPT,
    askModule.PAGE_REQUESTS_OFF_PROMPT,
    askModule.PAGE_REQUESTS_ON_TITLE,
    askModule.PAGE_REQUESTS_OFF_TITLE,
    askModule.PAGE_REQUESTS_ON_DESCRIPTION,
    askModule.PAGE_REQUESTS_OFF_DESCRIPTION,
    askModule.PAGE_REQUESTS_ALREADY_ON,
    askModule.PAGE_REQUESTS_OFF_TEXT,
    askModule.PAGE_REQUESTS_ALREADY_OFF,
    noPage,
  ]) {
    assert.equal(typeof text, 'string');
    assert.doesNotMatch(text, /listen/i, text);
    assert.doesNotMatch(text, /[0-9a-f]{64}/, text);
    assert.ok(!text.includes('node '), text);
  }
});

test('the arming switch: a fresh channel is not paused; paused, drainLines hands over the waiting requests without the arming line; cleared, the arming line is back; each change logs one line', () => {
  const { channel, page } = trustedChannel();
  assert.equal(channel.isArmingPaused(), false);
  channel.handleAsk(page, askMsg('s1', 'make the drums shorter'));

  const paused = captureErrors(() => channel.setArmingPaused(true));
  assert.deepEqual(paused, [askModule.ARMING_PAUSED_LOG]);
  assert.equal(channel.isArmingPaused(), true);
  assert.deepEqual(captureErrors(() => channel.setArmingPaused(true)), [], 'no line when the value does not change');

  const whilePaused = drain(channel);
  assert.deepEqual(requestLines(whilePaused).map(textOf), ['make the drums shorter']);
  assert.equal(whilePaused.length, 2, 'no arming line while paused: the moment fact, then the request line');
  assert.equal(whilePaused[0], askModule.REQUEST_LINE_MOMENT_FACT);
  assert.ok(!whilePaused.some((line) => line.startsWith('Page requests: no listener is connected.')));
  assert.deepEqual(page.sent.at(-1), { type: 'ask-received', ids: ['s1'] });
  assert.deepEqual(drain(channel), []);

  const resumed = captureErrors(() => channel.setArmingPaused(false));
  assert.deepEqual(resumed, [askModule.ARMING_RESUMED_LOG]);
  assert.equal(channel.isArmingPaused(), false);
  assert.deepEqual(captureErrors(() => channel.setArmingPaused(false)), []);
  const back = drain(channel);
  assert.equal(back.length, 1);
  assert.ok(back[0].startsWith('Page requests: no listener is connected.'), back[0]);
  for (const line of [askModule.ARMING_PAUSED_LOG, askModule.ARMING_RESUMED_LOG]) {
    assert.ok(line.startsWith('[moontide] '), line);
    assert.doesNotMatch(line, /listen/i);
  }
});

// --- mirrors ---

test('page/ask.js mirrors the protocol limits and the page token placeholder by hand', () => {
  assert.equal(PAGE_MAX_TEXT, MAX_ASK_TEXT_LENGTH);
  assert.equal(PAGE_MAX_CONTEXT, MAX_ASK_CONTEXT_LENGTH);
  assert.equal(PAGE_PLACEHOLDER, PAGE_TOKEN_PLACEHOLDER);
});

test('page/ask.js mirrors the request line limit and prefix by hand', () => {
  assert.equal(MAX_REQUEST_LINE_BYTES, 8192);
  assert.equal(PAGE_MAX_LINE_BYTES, MAX_REQUEST_LINE_BYTES);
  assert.equal(PAGE_LINE_PREFIX, REQUEST_LINE_PREFIX);
});

// --- the size of the whole request line ---

/** A moment of `count` notes whose strings are `length` characters long. */
function wideMoment(count, length) {
  const name = (letter) => letter.repeat(length);
  return {
    cycle: 34,
    beat: 3,
    at: 34.5,
    version: 12,
    notes: Array.from({ length: count }, () => ({
      track: name('t'),
      instrument: name('i'),
      note: name('n'),
      sound: name('s'),
      velocity: 0.9,
      start: 34.5,
      end: 34.75,
      state: 'sounding',
    })),
    more: 0,
  };
}

function lineFields(text, moment) {
  const fields = { id: 'size-1', text, context: { kind: 'lane', track: 'pad', cycle: 34 }, chip: 'Lane pad', current: 12 };
  return moment === undefined ? fields : { ...fields, moment };
}

test('requestLineBytes counts the bytes of the line the server builds, escapes and multi-byte text included', () => {
  for (const text of ['make it shorter', '\u4f60\u597d'.repeat(50), 'a\u2028b\u2029c', 'line\nbreak "quoted"', '\ud83c\udfb5 music']) {
    for (const moment of [undefined, wideMoment(3, 12)]) {
      const fields = lineFields(text, moment);
      assert.equal(requestLineBytes(fields), Buffer.byteLength(requestLine(fields), 'utf8'), JSON.stringify(text));
    }
  }
});

test('fitMomentToLine leaves a moment that fits alone and cuts notes off the end, counted in more, until the line fits', () => {
  assert.equal(fitMomentToLine(lineFields('hello')), undefined);
  const small = wideMoment(2, 10);
  assert.equal(fitMomentToLine(lineFields('hello', small)), small, 'a moment that fits comes back as it is');

  const wide = wideMoment(MAX_MOMENT_NOTES, 150);
  const input = JSON.stringify(wide);
  assert.ok(requestLineBytes(lineFields('hello', wide)) > MAX_REQUEST_LINE_BYTES, 'the test moment is too wide for one line');
  const fitted = fitMomentToLine(lineFields('hello', wide));
  assert.equal(JSON.stringify(wide), input, 'the input is never mutated');
  assert.ok(requestLineBytes(lineFields('hello', fitted)) <= MAX_REQUEST_LINE_BYTES);
  assert.ok(fitted.notes.length > 0 && fitted.notes.length < MAX_MOMENT_NOTES);
  assert.equal(fitted.notes.length + fitted.more, MAX_MOMENT_NOTES, 'the count of notes stays the same');
  assert.deepEqual(fitted.notes, wide.notes.slice(0, fitted.notes.length), 'the first notes stay');
  // One note fewer would have fitted: no more is cut than needed.
  const oneMore = { ...fitted, notes: wide.notes.slice(0, fitted.notes.length + 1), more: fitted.more - 1 };
  assert.ok(requestLineBytes(lineFields('hello', oneMore)) > MAX_REQUEST_LINE_BYTES);

  // A text that fills the line alone leaves no note and the server decides.
  const cjk = '\u4f60'.repeat(MAX_ASK_CONTEXT_LENGTH);
  const crowded = {
    ...lineFields('\u4f60'.repeat(MAX_ASK_TEXT_LENGTH), wideMoment(MAX_MOMENT_NOTES, MAX_ASK_CONTEXT_LENGTH)),
    context: { kind: 'line', line: 3, text: cjk },
    chip: cjk,
  };
  const alone = fitMomentToLine(crowded);
  assert.deepEqual(alone.notes, []);
  assert.equal(alone.more, MAX_MOMENT_NOTES);
});

test('fitMomentToLine still cuts notes off the end when 40-character drum names push the line over', () => {
  const plain = wideMoment(MAX_MOMENT_NOTES, 30);
  const named = { ...plain, notes: plain.notes.map((note) => ({ ...note, drum: 'd'.repeat(40) })) };
  assert.ok(requestLineBytes(lineFields('hello', plain)) <= MAX_REQUEST_LINE_BYTES, 'the plain moment fits one line');
  assert.ok(requestLineBytes(lineFields('hello', named)) > MAX_REQUEST_LINE_BYTES, 'the drum names push it over');
  const fitted = fitMomentToLine(lineFields('hello', named));
  assert.ok(requestLineBytes(lineFields('hello', fitted)) <= MAX_REQUEST_LINE_BYTES);
  assert.ok(fitted.notes.length > 0 && fitted.notes.length < MAX_MOMENT_NOTES);
  assert.equal(fitted.notes.length + fitted.more, MAX_MOMENT_NOTES);
  assert.deepEqual(fitted.notes, named.notes.slice(0, fitted.notes.length));
  const capped = fitMomentToLine(lineFields('hello', wideMoment(MAX_MOMENT_NOTES, 4)));
  assert.equal(capped.notes.length + capped.more, MAX_MOMENT_NOTES, 'the 32-note cap behaves as before');
});

test('the keys the page may copy into a moment note equal the keys of the server moment note shape', () => {
  assert.deepEqual([...MOMENT_NOTE_FIELDS].sort(), Object.keys(askMomentNoteShape).sort());
  assert.deepEqual([...MOMENT_NOTE_FIELDS], ['track', 'instrument', 'sound', 'note', 'drum', 'velocity', 'start', 'end', 'state']);
});

test('a request line of exactly the limit is accepted, one byte more is refused "line-too-long" and never queued', () => {
  const fields = lineFields('', wideMoment(MAX_MOMENT_NOTES, 20));
  const empty = Buffer.byteLength(requestLine({ ...fields, text: 'x' }), 'utf8') - 1;
  const textLength = MAX_REQUEST_LINE_BYTES - empty;
  assert.ok(textLength > 0 && textLength <= MAX_ASK_TEXT_LENGTH, `the filling text is ${textLength} characters`);
  const { channel, page } = trustedChannel();
  const exact = { ...fields, type: 'ask', text: 'x'.repeat(textLength) };
  assert.equal(Buffer.byteLength(requestLine(exact), 'utf8'), MAX_REQUEST_LINE_BYTES);
  channel.handleAsk(page, exact);
  assert.equal(results(page).at(-1).status, 'waiting');
  const over = { ...exact, id: 'size-2', text: 'x'.repeat(textLength + 1) };
  const lines = captureErrors(() => channel.handleAsk(page, over));
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes(`${MAX_REQUEST_LINE_BYTES} at most`), lines[0]);
  assert.ok(!lines[0].includes('xxxx'), 'the text is never logged');
  assert.deepEqual(results(page).at(-1), { type: 'ask-result', id: 'size-2', status: 'refused', reason: 'line-too-long' });
  assert.equal(channel.waitingCount(), 1);
});

// The character limit does not bound the line. JSON writes a control character
// or U+2028 as six bytes, so 2000 of them are within MAX_ASK_TEXT_LENGTH and far over MAX_REQUEST_LINE_BYTES.
test('a text within 2000 characters whose JSON is too big is refused "line-too-long", not "too-long", by the server, and the page knows it cannot fit', () => {
  // U+2028 is white space, so the text starts and ends with a letter: the box trims before it counts.
  for (const text of ['\u0001'.repeat(MAX_ASK_TEXT_LENGTH), `a${'\u2028'.repeat(MAX_ASK_TEXT_LENGTH - 2)}a`, '\u001f'.repeat(MAX_ASK_TEXT_LENGTH)]) {
    assert.equal(text.length, MAX_ASK_TEXT_LENGTH);
    assert.equal(askTextProblem(text), null, 'the character count alone accepts it');
    const fields = lineFields(text, wideMoment(5, 10));
    assert.ok(requestLineBytes(lineFields(text)) > MAX_REQUEST_LINE_BYTES, 'the line is over the bound with no moment at all');
    assert.equal(requestFitsLine(fields), false);
    const { channel, page } = trustedChannel();
    channel.handleAsk(page, { ...fields, type: 'ask' });
    assert.equal(results(page).at(-1).reason, 'line-too-long');
    assert.equal(channel.waitingCount(), 0);
  }
  // A plain text of the same length fits, and the moment is what gives way.
  const plain = lineFields('x'.repeat(MAX_ASK_TEXT_LENGTH), wideMoment(MAX_MOMENT_NOTES, 20));
  assert.equal(requestFitsLine(plain), true);
  assert.equal(requestFitsLine(lineFields('hello')), true);
  // The moment is cut as far as it goes, down to no notes, before the page gives up.
  const edge = lineFields('\u0001'.repeat(1300), wideMoment(MAX_MOMENT_NOTES, 20));
  assert.ok(requestLineBytes(edge) > MAX_REQUEST_LINE_BYTES);
  assert.equal(requestFitsLine(edge), requestLineBytes({ ...edge, moment: fitMomentToLine(edge) }) <= MAX_REQUEST_LINE_BYTES);
  assert.equal(requestFitsLine(edge), true, 'cutting the notes is enough for 1300 control characters');
});

test('page/timeline.js mirrors the moment limits by hand, and the beats of a bar', () => {
  assert.equal(PAGE_MAX_MOMENT_NOTES, MAX_MOMENT_NOTES);
  assert.equal(BEATS_PER_CYCLE, MOMENT_BEATS);
});

test('page/ask.js mirrors the two page-requests prompt names by hand, as Claude Code shows them', () => {
  assert.equal(PAGE_REQUESTS_COPY.onCommand, `/mcp__moontide__${askModule.PAGE_REQUESTS_ON_PROMPT}`);
  assert.equal(PAGE_REQUESTS_COPY.offCommand, `/mcp__moontide__${askModule.PAGE_REQUESTS_OFF_PROMPT}`);
});
