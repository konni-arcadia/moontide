import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  Session,
  EMPTY_CODE_MESSAGE,
  NOT_RESPONDING_MESSAGE,
  noPageMessage,
  evalFailedMessage,
  STILL_PLAYING_TAIL,
  NOTHING_PLAYING_TAIL,
  STILL_STOPPED_TAIL,
  UNKNOWN_ERROR_DETAIL,
  STALE_PAGE_MESSAGE,
  runtimeErrorLine,
  earlierRuntimeErrorLine,
  MAX_RUNTIME_ERRORS,
  MAX_DROPPED_RUNTIME_ERRORS,
  handEvalFailedLine,
  reconnectEvalFailedLine,
  RECORD_INTENT_TTL_MS,
  MAX_TRACKED_EVALUATE_IDS,
  BUILD_MISMATCH_NOTE,
  BUILD_UPDATED_NOTE,
  takeoverCanceledLine,
  takeoverReplacedHandEditLine,
} from '../dist/session.js';
import { BuildWatch } from '../dist/build-id.js';
import { RigStore } from '../dist/instruments.js';
import { MIDI_PERMISSION_WAIT_MESSAGE, midiPortNotFoundLine } from '../dist/midi-state.js';
import {
  HistoryStore,
  HistoryError,
  HAND_EDIT_LABEL,
  versionNotFoundMessage,
  historyUnavailableMessage,
  favoriteSavedMessage,
} from '../dist/history.js';
import { ARMING_LINE_PREFIX } from './helpers.js';

const PAGE_URL = 'http://localhost:5757';

function tempHistoryDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'moontide-session-history-test-'));
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

/** A fake PageConnection that records every sent frame as parsed JSON. `send` is reassignable. */
function fakePage() {
  const sent = [];
  return {
    sent,
    send(data) {
      sent.push(JSON.parse(data));
    },
  };
}

/**
 * Presents the session's page token for a fake page: the session answers ask-auth ok true and attaches
 * the page (hello follows), then sends the page-requests state last. The ask-auth and page-requests
 * frames are removed from page.sent so hello stays where the assertions expect it (sent[0] for a
 * fresh page).
 */
function authenticate(session, page) {
  const at = Array.isArray(page.sent) ? page.sent.length : null;
  session.handlePageMessage(page, { type: 'page-auth', token: session.ask.pageToken });
  if (at !== null) {
    assert.deepEqual(page.sent[at], { type: 'ask-auth', ok: true });
    assert.deepEqual(page.sent.at(-1), { type: 'page-requests', live: false });
    page.sent.pop();
    page.sent.splice(at, 1);
  }
}

/** drainNotices() for a session with an authenticated page and no listener: asserts and drops the arming line. */
function drainWithoutArming(session) {
  const drained = session.drainNotices();
  const arming = drained.lines.pop();
  assert.ok(arming !== undefined && arming.startsWith(ARMING_LINE_PREFIX), `expected the arming line last, got: ${arming}`);
  return drained;
}

function assertMessage(expected) {
  return (err) => {
    assert.equal(err.message, expected);
    return true;
  };
}

test('(1) no page connected rejects in under 50ms with a message containing the page URL', async () => {
  const session = new Session();
  session.setPageUrl(PAGE_URL);
  const start = Date.now();
  await assert.rejects(() => session.evaluate('s("bd")'), assertMessage(noPageMessage(PAGE_URL)));
  assert.ok(Date.now() - start < 50, 'expected an immediate rejection');
});

test('(2) default timeout: a silent page rejects with NOT_RESPONDING_MESSAGE between 4900 and 6500 ms', async () => {
  const session = new Session();
  session.setPageUrl(PAGE_URL);
  authenticate(session, fakePage());
  const start = Date.now();
  await assert.rejects(() => session.evaluate('s("bd")'), assertMessage(NOT_RESPONDING_MESSAGE));
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 4900 && elapsed <= 6500, `expected ~5000ms, took ${elapsed}ms`);
});

test('(3) replyTimeoutMs: 50 rejects and leaves pendingCount 0', async () => {
  const session = new Session({ replyTimeoutMs: 50 });
  session.setPageUrl(PAGE_URL);
  authenticate(session, fakePage());
  await assert.rejects(() => session.evaluate('s("bd")'), assertMessage(NOT_RESPONDING_MESSAGE));
  assert.equal(session.pendingCount(), 0);
});

test('(4) detach mid-request rejects in under 100ms with the no-page message and pendingCount 0', async () => {
  const session = new Session();
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);
  const start = Date.now();
  const promise = session.evaluate('s("bd")');
  session.detachPage(page);
  await assert.rejects(() => promise, assertMessage(noPageMessage(PAGE_URL)));
  assert.ok(Date.now() - start < 100, 'expected detach to reject the pending request immediately');
  assert.equal(session.pendingCount(), 0);
});

test('(5) late replies after timeout never throw; a late success updates getCode, a late failure does not', async () => {
  const session = new Session({ replyTimeoutMs: 30 });
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);

  await assert.rejects(() => session.evaluate('s("bd")'), assertMessage(NOT_RESPONDING_MESSAGE));
  const lateOkId = page.sent.at(-1).id;
  assert.doesNotThrow(() =>
    session.handlePageMessage(page, {
      type: 'evaluated',
      id: lateOkId,
      ok: true,
      code: 's("bd")',
      audio: 'playing',
    }),
  );
  assert.equal(session.getCode(), 's("bd")');

  await assert.rejects(() => session.evaluate('s("cp")'), assertMessage(NOT_RESPONDING_MESSAGE));
  const lateFailId = page.sent.at(-1).id;
  assert.doesNotThrow(() =>
    session.handlePageMessage(page, { type: 'evaluated', id: lateFailId, ok: false, code: 's("cp")', error: 'boom' }),
  );
  assert.equal(session.getCode(), 's("bd")', 'a late failure must not change the confirmed code');
});

test('(5b) a late success from a non-active (stale) page is discarded, not stored', async () => {
  const session = new Session({ replyTimeoutMs: 30 });
  session.setPageUrl(PAGE_URL);
  const pageA = fakePage();
  authenticate(session, pageA);

  await assert.rejects(() => session.evaluate('s("bd")'), assertMessage(NOT_RESPONDING_MESSAGE));
  const lateId = pageA.sent.at(-1).id;

  // The last page to authenticate wins: pageA stays connected but is no longer active once
  // pageB attaches.
  const pageB = fakePage();
  authenticate(session, pageB);

  assert.doesNotThrow(() =>
    session.handlePageMessage(pageA, { type: 'evaluated', id: lateId, ok: true, code: 's("bd")', audio: 'playing' }),
  );
  assert.equal(session.getCode(), '', 'a late success from a stale, non-active page must not overwrite the confirmed code');
});

test('(5d) a late success reporting audio "stopped" updates isStopped() to true', async () => {
  const session = new Session({ replyTimeoutMs: 30 });
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);
  assert.equal(session.isStopped(), false);

  await assert.rejects(() => session.evaluate('s("bd")'), assertMessage(NOT_RESPONDING_MESSAGE));
  const lateId = page.sent.at(-1).id;
  session.handlePageMessage(page, { type: 'evaluated', id: lateId, ok: true, code: 's("bd")', audio: 'stopped' });
  assert.equal(session.getCode(), 's("bd")');
  assert.equal(session.isStopped(), true, 'a late success reporting audio: "stopped" must set isStopped() true');
});

test('(5e) a late success reporting audio "playing" clears a previously true isStopped()', async () => {
  const session = new Session({ replyTimeoutMs: 30 });
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);

  session.handlePageMessage(page, { type: 'user-stopped' });
  assert.equal(session.isStopped(), true);

  await assert.rejects(() => session.evaluate('s("bd")'), assertMessage(NOT_RESPONDING_MESSAGE));
  const lateId = page.sent.at(-1).id;
  session.handlePageMessage(page, { type: 'evaluated', id: lateId, ok: true, code: 's("bd")', audio: 'playing' });
  assert.equal(session.isStopped(), false, 'a late success reporting audio: "playing" must clear isStopped()');
});

test('(5c) an on-time success from a page that stopped being active while the request was still pending is rejected, not stored', async () => {
  const session = new Session();
  session.setPageUrl(PAGE_URL);
  const pageA = fakePage();
  authenticate(session, pageA);

  // Request sent to pageA, still pending (well within the timeout window) — not (5b)'s
  // already-timed-out case.
  const promise = session.evaluate('s("bd")');
  const id = pageA.sent.at(-1).id;

  // The last page to authenticate wins: pageA stays connected but is no longer active once
  // pageB attaches, even though pageA's evaluate is still pending.
  const pageB = fakePage();
  authenticate(session, pageB);

  session.handlePageMessage(pageA, { type: 'evaluated', id, ok: true, code: 's("bd")', audio: 'playing' });

  await assert.rejects(() => promise, assertMessage(STALE_PAGE_MESSAGE));
  assert.equal(session.getCode(), '', 'an on-time success from a stale, non-active page must not overwrite the confirmed code');
  assert.equal(session.pendingCount(), 0);
});

test('(6) ok:false reply before anything played rejects with evalFailedMessage(detail, undefined, NOTHING_PLAYING_TAIL) and getCode unchanged', async () => {
  const session = new Session();
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);
  const promise = session.evaluate('s("bd")');
  const id = page.sent.at(-1).id;
  session.handlePageMessage(page, { type: 'evaluated', id, ok: false, code: 's("bd")', error: 'boom' });
  await assert.rejects(() => promise, assertMessage(evalFailedMessage('boom', undefined, NOTHING_PLAYING_TAIL)));
  assert.equal(session.getCode(), '');
});

test("(7) '' and whitespace-only code reject with EMPTY_CODE_MESSAGE and send nothing to the page", async () => {
  const session = new Session();
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);
  const sentBeforeCount = page.sent.length;
  await assert.rejects(() => session.evaluate(''), assertMessage(EMPTY_CODE_MESSAGE));
  await assert.rejects(() => session.evaluate('  \n'), assertMessage(EMPTY_CODE_MESSAGE));
  assert.equal(page.sent.length, sentBeforeCount, 'no evaluate frame should have been sent');
});

test('(8) attach A then B: evaluate goes to B only, both received hello, detaching A keeps B active', async () => {
  const session = new Session();
  session.setPageUrl(PAGE_URL);
  const pageA = fakePage();
  const pageB = fakePage();
  authenticate(session, pageA);
  authenticate(session, pageB);
  assert.deepEqual(pageA.sent[0], { type: 'hello', code: '', stopped: false });
  assert.deepEqual(pageA.sent[1], { type: 'superseded' });
  assert.deepEqual(pageB.sent[0], { type: 'hello', code: '', stopped: false });

  session.detachPage(pageA);

  const promise = session.evaluate('s("bd")');
  const id = pageB.sent.at(-1).id;
  session.handlePageMessage(pageB, { type: 'evaluated', id, ok: true, code: 's("bd")', audio: 'playing' });
  await promise;
  assert.equal(pageA.sent.length, 2, 'pageA (replaced, then detached) gets hello and superseded, never an evaluate frame');
});

test('(8b) attaching B sends A one superseded frame before B hello; the same page authenticating twice sends nothing', () => {
  const session = new Session();
  session.setPageUrl(PAGE_URL);
  const order = [];
  const record = (name) => ({
    sent: [],
    send(data) {
      const msg = JSON.parse(data);
      this.sent.push(msg);
      order.push(`${name}:${msg.type}`);
    },
  });
  const pageA = record('A');
  const pageB = record('B');
  authenticate(session, pageA);
  assert.deepEqual(order.filter((o) => o.endsWith(':superseded')), [], 'the first page supersedes nobody');
  order.length = 0;
  authenticate(session, pageB);
  assert.equal(pageA.sent.filter((m) => m.type === 'superseded').length, 1);
  assert.ok(order.indexOf('A:superseded') < order.indexOf('B:hello'), `superseded must come before the new hello: ${order.join(', ')}`);

  const before = pageB.sent.length;
  session.handlePageMessage(pageB, { type: 'page-auth', token: session.ask.pageToken });
  assert.equal(pageB.sent.filter((m) => m.type === 'superseded').length, 0);
  assert.equal(pageA.sent.filter((m) => m.type === 'superseded').length, 1, 'a repeated page-auth supersedes nobody');
  assert.ok(pageB.sent.length >= before);
});

test('(8c) take-over from the superseded page makes it active again; the other page is superseded in turn and A gets a hello', async () => {
  const session = new Session();
  session.setPageUrl(PAGE_URL);
  const pageA = fakePage();
  const pageB = fakePage();
  authenticate(session, pageA);
  authenticate(session, pageB);
  pageA.sent.length = 0;
  pageB.sent.length = 0;

  session.handlePageMessage(pageA, { type: 'take-over' });
  assert.deepEqual(pageB.sent, [{ type: 'superseded' }]);
  assert.deepEqual(pageA.sent[0], { type: 'hello', code: '', stopped: false });
  assert.equal(pageA.sent.filter((m) => m.type === 'superseded').length, 0);

  const promise = session.evaluate('s("bd")');
  const evaluateFrame = pageA.sent.find((m) => m.type === 'evaluate');
  assert.ok(evaluateFrame, 'the evaluate goes to the page that took the role back');
  assert.equal(pageB.sent.filter((m) => m.type === 'evaluate').length, 0);
  session.handlePageMessage(pageA, { type: 'evaluated', id: evaluateFrame.id, ok: true, code: 's("bd")', audio: 'playing' });
  await promise;
});

test('(8d) take-over from the page that is already active re-sends hello and supersedes nobody', () => {
  const session = new Session();
  session.setPageUrl(PAGE_URL);
  const pageA = fakePage();
  const pageB = fakePage();
  authenticate(session, pageA);
  authenticate(session, pageB);
  pageA.sent.length = 0;
  pageB.sent.length = 0;

  session.handlePageMessage(pageB, { type: 'take-over' });
  assert.equal(pageB.sent[0].type, 'hello');
  assert.equal(pageB.sent.filter((m) => m.type === 'superseded').length, 0);
  assert.deepEqual(pageA.sent, [], 'the superseded page is told nothing a second time');
});

test('(8d2) when the active page goes away, the superseded pages are told once that no tab plays', () => {
  const session = new Session();
  session.setPageUrl(PAGE_URL);
  const pageA = fakePage();
  const pageB = fakePage();
  const pageC = fakePage();
  authenticate(session, pageA);
  authenticate(session, pageB);
  authenticate(session, pageC);
  for (const page of [pageA, pageB, pageC]) page.sent.length = 0;

  session.detachPage(pageC);
  assert.deepEqual(pageA.sent, [{ type: 'no-active-page' }]);
  assert.deepEqual(pageB.sent, [{ type: 'no-active-page' }]);
  assert.deepEqual(pageC.sent, [], 'the page that went away is told nothing');

  // A page that is not active and goes away changes nothing for the others.
  session.detachPage(pageA);
  assert.deepEqual(pageB.sent, [{ type: 'no-active-page' }]);
});

test('(8d3) a superseded page that takes the role when nobody plays gets hello, and the other superseded pages are told a tab plays again', () => {
  const session = new Session();
  session.setPageUrl(PAGE_URL);
  const pageA = fakePage();
  const pageB = fakePage();
  const pageC = fakePage();
  authenticate(session, pageA);
  authenticate(session, pageB);
  authenticate(session, pageC);
  session.detachPage(pageC);
  for (const page of [pageA, pageB]) page.sent.length = 0;

  session.handlePageMessage(pageA, { type: 'take-over' });
  assert.equal(pageA.sent[0].type, 'hello');
  assert.equal(pageA.sent.filter((m) => m.type === 'superseded').length, 0);
  assert.deepEqual(pageB.sent, [{ type: 'superseded' }]);
});

test('(8d4) a page that reloads while another tab is superseded leaves that tab saying another tab plays', () => {
  const session = new Session();
  session.setPageUrl(PAGE_URL);
  const pageA = fakePage();
  const pageB = fakePage();
  authenticate(session, pageA);
  authenticate(session, pageB);
  pageA.sent.length = 0;

  // The old socket of B closes, then the reloaded B authenticates on a new connection.
  session.detachPage(pageB);
  assert.deepEqual(pageA.sent, [{ type: 'no-active-page' }]);
  const reloadedB = fakePage();
  authenticate(session, reloadedB);
  assert.deepEqual(pageA.sent, [{ type: 'no-active-page' }, { type: 'superseded' }]);
  assert.equal(reloadedB.sent[0].type, 'hello');
});

test('(8e) take-over from a connection that never sent page-auth changes nothing and is logged as untrusted', () => {
  const session = new Session();
  session.setPageUrl(PAGE_URL);
  const pageA = fakePage();
  const stranger = fakePage();
  authenticate(session, pageA);
  pageA.sent.length = 0;

  const logged = [];
  const realError = console.error;
  console.error = (...parts) => logged.push(parts.join(' '));
  try {
    session.handlePageMessage(stranger, { type: 'take-over' });
  } finally {
    console.error = realError;
  }
  assert.deepEqual(stranger.sent, []);
  assert.deepEqual(pageA.sent, [], 'the active page is not superseded by a stranger');
  assert.ok(logged.some((line) => line.includes('Refused a page message (take-over)')), logged.join('\n'));
});

test('(8f) a take-over that changes the active page clears the MIDI state the old page reported', () => {
  const session = new Session();
  session.setPageUrl(PAGE_URL);
  const pageA = fakePage();
  const pageB = fakePage();
  authenticate(session, pageA);
  authenticate(session, pageB);
  session.handlePageMessage(pageB, {
    type: 'midi-state',
    access: 'denied',
    failure: null,
    usesMidi: true,
    triedMidi: true,
    outputs: [],
    ports: [],
    noPort: null,
    unreadable: false,
    hidden: false,
    playing: true,
    events: [],
  });
  session.handlePageMessage(pageA, { type: 'take-over' });
  const drained = drainWithoutArming(session);
  assert.deepEqual(
    drained.lines.filter((line) => line.startsWith('MIDI:')),
    [],
    'the facts of the page that lost the role no longer apply',
  );
});

test('(9) no-page, not-responding, evaluation-failed, stale-page and MIDI-permission-wait messages are pairwise distinct', () => {
  const messages = [
    noPageMessage(PAGE_URL),
    NOT_RESPONDING_MESSAGE,
    evalFailedMessage('boom', undefined, STILL_PLAYING_TAIL),
    STALE_PAGE_MESSAGE,
    MIDI_PERMISSION_WAIT_MESSAGE,
  ];
  assert.equal(new Set(messages).size, 5);
});

test('(10) a page whose send throws makes evaluate reject with the no-page message and pendingCount 0', async () => {
  const session = new Session();
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);
  page.send = () => {
    throw new Error('socket not open');
  };
  await assert.rejects(() => session.evaluate('s("bd")'), assertMessage(noPageMessage(PAGE_URL)));
  assert.equal(session.pendingCount(), 0);
});

test('(11) evalFailedMessage formats the detail, an optional line, and the tail', () => {
  assert.equal(
    evalFailedMessage('boom', 3, STILL_PLAYING_TAIL),
    'Evaluation failed: boom, line 3. The previous code is still playing.',
  );
});

test('(12) after one confirmed success, an ok:false reply rejects with a message ending in STILL_PLAYING_TAIL and getCode is unchanged', async () => {
  const session = new Session();
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);

  const okPromise = session.evaluate('s("bd")');
  const okId = page.sent.at(-1).id;
  session.handlePageMessage(page, { type: 'evaluated', id: okId, ok: true, code: 's("bd")', audio: 'playing' });
  await okPromise;

  const failPromise = session.evaluate('s("hh*4")');
  const failId = page.sent.at(-1).id;
  session.handlePageMessage(page, { type: 'evaluated', id: failId, ok: false, code: 's("hh*4")', error: 'boom' });
  await assert.rejects(
    () => failPromise,
    (err) => {
      assert.ok(err.message.endsWith(STILL_PLAYING_TAIL));
      return true;
    },
  );
  assert.equal(session.getCode(), 's("bd")');
});

test('(13) an empty/whitespace error detail substitutes UNKNOWN_ERROR_DETAIL, and a trailing period is not doubled', async () => {
  const session = new Session();
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);

  const promise1 = session.evaluate('s("bd")');
  const id1 = page.sent.at(-1).id;
  session.handlePageMessage(page, { type: 'evaluated', id: id1, ok: false, code: 's("bd")', error: '  ' });
  await assert.rejects(
    () => promise1,
    (err) => {
      assert.ok(err.message.includes(UNKNOWN_ERROR_DETAIL));
      return true;
    },
  );

  const promise2 = session.evaluate('s("bd")');
  const id2 = page.sent.at(-1).id;
  session.handlePageMessage(page, { type: 'evaluated', id: id2, ok: false, code: 's("bd")', error: 'boom.' });
  await assert.rejects(
    () => promise2,
    (err) => {
      assert.equal(err.message, evalFailedMessage('boom.', undefined, NOTHING_PLAYING_TAIL));
      assert.ok(!err.message.includes('boom..'), 'a trailing period in the detail must not be doubled');
      return true;
    },
  );
});

test('(14) an error detail over 500 code points is cut at a code point boundary, with no lone surrogate', async () => {
  const session = new Session();
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);

  const longDetail = '🎵'.repeat(600);
  const promise = session.evaluate('s("bd")');
  const id = page.sent.at(-1).id;
  session.handlePageMessage(page, { type: 'evaluated', id, ok: false, code: 's("bd")', error: longDetail });
  await assert.rejects(
    () => promise,
    (err) => {
      assert.ok(err.message.includes('…'));
      assert.equal(Array.from(err.message).filter((ch) => ch === '🎵').length, 500);
      assert.doesNotMatch(err.message, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
      return true;
    },
  );
});

test('(15) runtimeErrorLine formats a single occurrence and a repeated one', () => {
  assert.equal(runtimeErrorLine('boom', 1), 'Runtime error while playing: boom.');
  assert.equal(runtimeErrorLine('boom', 3), 'Runtime error while playing (repeated 3 times): boom.');
});

test('(16) drainNotices reports distinct runtime errors with repeat counts, in first-seen order, then clears', () => {
  const session = new Session();
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);

  session.handlePageMessage(page, { type: 'runtime-error', message: 'a' });
  session.handlePageMessage(page, { type: 'runtime-error', message: 'b' });
  session.handlePageMessage(page, { type: 'runtime-error', message: 'a' });

  const first = drainWithoutArming(session);
  assert.deepEqual(first.lines, [
    'Runtime error while playing (repeated 2 times): a.',
    'Runtime error while playing: b.',
  ]);
  assert.equal(first.hadRuntimeErrors, true);

  const second = drainWithoutArming(session);
  assert.deepEqual(second.lines, []);
  assert.equal(second.hadRuntimeErrors, false);
});

test('(17) a runtime-error from a page that is not the active page is ignored', () => {
  const session = new Session();
  session.setPageUrl(PAGE_URL);
  const pageA = fakePage();
  authenticate(session, pageA);
  const pageB = fakePage();
  authenticate(session, pageB); // pageA is now stale (the last page to authenticate wins)

  session.handlePageMessage(pageA, { type: 'runtime-error', message: 'stale' });

  const { lines } = drainWithoutArming(session);
  assert.deepEqual(lines, []);
});

test('(18) beyond MAX_RUNTIME_ERRORS distinct entries, extras are counted as a dropped note, not shown individually', () => {
  const session = new Session();
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);
  assert.equal(MAX_RUNTIME_ERRORS, 10);

  for (let i = 0; i < 12; i++) {
    session.handlePageMessage(page, { type: 'runtime-error', message: `error ${i}` });
  }

  const { lines } = drainWithoutArming(session);
  assert.equal(lines.length, 11);
  assert.equal(lines.at(-1), 'Note: 2 more distinct runtime errors were not shown.');
});

test('(18b) thousands of distinct overflow messages report a correct count, drain fast, and clear on the next drain', () => {
  const session = new Session();
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);

  const total = 5000;
  for (let i = 0; i < total; i++) {
    session.handlePageMessage(page, { type: 'runtime-error', message: `flood ${i}` });
  }

  const first = drainWithoutArming(session);
  assert.equal(first.lines.length, MAX_RUNTIME_ERRORS + 1);
  assert.equal(
    first.lines.at(-1),
    `Note: ${total - MAX_RUNTIME_ERRORS} more distinct runtime errors were not shown.`,
    'the dropped count must track every message beyond the cap without growing unbounded storage',
  );

  const second = drainWithoutArming(session);
  assert.deepEqual(second.lines, [], 'the dropped count must clear on drain, same as the shown-errors map');
});

test('(18c) a repeated overflow message counts once as "distinct", not once per occurrence', () => {
  const session = new Session();
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);
  assert.equal(MAX_RUNTIME_ERRORS, 10);

  // Fill the main cap with 10 distinct messages, matching the review's reproduction.
  for (let i = 0; i < MAX_RUNTIME_ERRORS; i++) {
    session.handlePageMessage(page, { type: 'runtime-error', message: `error ${i}` });
  }
  // The same 11th message, repeated 5 times: still only one distinct overflow message.
  for (let i = 0; i < 5; i++) {
    session.handlePageMessage(page, { type: 'runtime-error', message: 'overflow error' });
  }

  const { lines } = drainWithoutArming(session);
  assert.equal(lines.at(-1), 'Note: 1 more distinct runtime error was not shown.');
});

test('(18d) a repeated overflow message still counts once after the dropped-set cap itself overflows', () => {
  const session = new Session();
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);

  for (let i = 0; i < MAX_RUNTIME_ERRORS; i++) {
    session.handlePageMessage(page, { type: 'runtime-error', message: `error ${i}` });
  }
  // Enough distinct overflow messages to fill MAX_DROPPED_RUNTIME_ERRORS too, so this repeats
  // into the second-level tally rather than the bounded Set.
  for (let i = 0; i < MAX_DROPPED_RUNTIME_ERRORS; i++) {
    session.handlePageMessage(page, { type: 'runtime-error', message: `dropped ${i}` });
  }
  const beforeRepeat = drainWithoutArming(session).lines.at(-1);
  assert.equal(beforeRepeat, `Note: ${MAX_DROPPED_RUNTIME_ERRORS} more distinct runtime errors were not shown.`);

  // Refill both caps identically, then send one message from the already-overflowed set
  // several times: memory for dropped tracking stays bounded either way (this documents the
  // known tail tradeoff — see the droppedRuntimeErrorOverflowCount field comment — rather
  // than asserting an exact count past the second cap).
  for (let i = 0; i < MAX_RUNTIME_ERRORS; i++) {
    session.handlePageMessage(page, { type: 'runtime-error', message: `error ${i}` });
  }
  for (let i = 0; i < MAX_DROPPED_RUNTIME_ERRORS; i++) {
    session.handlePageMessage(page, { type: 'runtime-error', message: `dropped ${i}` });
  }
  for (let i = 0; i < 5; i++) {
    session.handlePageMessage(page, { type: 'runtime-error', message: 'second-level overflow' });
  }
  const { lines } = drainWithoutArming(session);
  // Bounded: the note always reports a small, sane number, never anything close to a
  // per-occurrence count of the flood this test sent.
  const match = lines.at(-1).match(/^Note: (\d+) more distinct runtime errors were not shown\.$/);
  assert.ok(match, `expected a dropped-count note, got: ${lines.at(-1)}`);
  assert.ok(Number(match[1]) <= MAX_DROPPED_RUNTIME_ERRORS + 5);
});

test('(19) a runtime-error with an empty message drains with the unknown-error detail', () => {
  const session = new Session();
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);

  session.handlePageMessage(page, { type: 'runtime-error', message: '' });

  const { lines } = drainWithoutArming(session);
  assert.deepEqual(lines, ['Runtime error while playing: unknown error (the page gave no message).']);
});

test('(20) stop with no page connected rejects in under 50ms with the no-page message', async () => {
  const session = new Session();
  session.setPageUrl(PAGE_URL);
  const start = Date.now();
  await assert.rejects(() => session.stop(), assertMessage(noPageMessage(PAGE_URL)));
  assert.ok(Date.now() - start < 50, 'expected an immediate rejection');
});

test('(21) stop with replyTimeoutMs 50 and a silent page rejects with NOT_RESPONDING_MESSAGE and pendingCount 0', async () => {
  const session = new Session({ replyTimeoutMs: 50 });
  session.setPageUrl(PAGE_URL);
  authenticate(session, fakePage());
  await assert.rejects(() => session.stop(), assertMessage(NOT_RESPONDING_MESSAGE));
  assert.equal(session.pendingCount(), 0);
});

test('(22) stop success: the page receives {type: "stop", id}, a stop-result resolves it, and isStopped() is true', async () => {
  const session = new Session();
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);
  assert.equal(session.isStopped(), false);

  const promise = session.stop();
  const sent = page.sent.at(-1);
  assert.equal(sent.type, 'stop');
  assert.ok(typeof sent.id === 'string' && sent.id.length > 0);

  session.handlePageMessage(page, { type: 'stop-result', id: sent.id });
  await promise;
  assert.equal(session.isStopped(), true);
});

test('(23) a later evaluated ok reply clears isStopped()', async () => {
  const session = new Session();
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);

  const stopPromise = session.stop();
  const stopId = page.sent.at(-1).id;
  session.handlePageMessage(page, { type: 'stop-result', id: stopId });
  await stopPromise;
  assert.equal(session.isStopped(), true);

  const evalPromise = session.evaluate('s("bd")');
  const evalId = page.sent.at(-1).id;
  session.handlePageMessage(page, { type: 'evaluated', id: evalId, ok: true, code: 's("bd")', audio: 'playing' });
  await evalPromise;
  assert.equal(session.isStopped(), false);
});

test('(24) detach during a pending stop rejects with the no-page message and pendingCount 0', async () => {
  const session = new Session();
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);
  const promise = session.stop();
  session.detachPage(page);
  await assert.rejects(() => promise, assertMessage(noPageMessage(PAGE_URL)));
  assert.equal(session.pendingCount(), 0);
});

test('(25) a stop-result carrying an evaluate id does not resolve that evaluate', async () => {
  const session = new Session();
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);

  const promise = session.evaluate('s("bd")');
  const id = page.sent.at(-1).id;
  session.handlePageMessage(page, { type: 'stop-result', id });
  assert.equal(session.pendingCount(), 1, 'the evaluate entry must still be pending after a mismatched stop-result');

  session.handlePageMessage(page, { type: 'evaluated', id, ok: true, code: 's("bd")', audio: 'playing' });
  const outcome = await promise;
  assert.equal(outcome.code, 's("bd")');
});

test('(26) a stop-result from a page replaced by a newer one rejects with STALE_PAGE_MESSAGE and isStopped() stays false', async () => {
  const session = new Session();
  session.setPageUrl(PAGE_URL);
  const pageA = fakePage();
  authenticate(session, pageA);

  const promise = session.stop();
  const id = pageA.sent.at(-1).id;

  const pageB = fakePage();
  authenticate(session, pageB);

  session.handlePageMessage(pageA, { type: 'stop-result', id });
  await assert.rejects(() => promise, assertMessage(STALE_PAGE_MESSAGE));
  assert.equal(session.isStopped(), false);
  assert.equal(session.pendingCount(), 0);
});

test('(27) a failed evaluate while stopped (with confirmed code) ends with STILL_STOPPED_TAIL', async () => {
  const session = new Session();
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);

  const okPromise = session.evaluate('s("bd")');
  const okId = page.sent.at(-1).id;
  session.handlePageMessage(page, { type: 'evaluated', id: okId, ok: true, code: 's("bd")', audio: 'playing' });
  await okPromise;

  const stopPromise = session.stop();
  const stopId = page.sent.at(-1).id;
  session.handlePageMessage(page, { type: 'stop-result', id: stopId });
  await stopPromise;
  assert.equal(session.isStopped(), true);

  const failPromise = session.evaluate('s("hh*4")');
  const failId = page.sent.at(-1).id;
  session.handlePageMessage(page, { type: 'evaluated', id: failId, ok: false, code: 's("hh*4")', error: 'boom' });
  await assert.rejects(
    () => failPromise,
    (err) => {
      assert.ok(err.message.endsWith(STILL_STOPPED_TAIL));
      return true;
    },
  );
});

test('(28) a user-stopped message from the active page sets isStopped() true; from a replaced page it changes nothing', () => {
  const session = new Session();
  session.setPageUrl(PAGE_URL);
  const pageA = fakePage();
  authenticate(session, pageA);
  const pageB = fakePage();
  authenticate(session, pageB); // pageA is now stale (the last page to authenticate wins)

  session.handlePageMessage(pageA, { type: 'user-stopped' });
  assert.equal(session.isStopped(), false, 'a user-stopped report from a stale page must not change stopped state');

  session.handlePageMessage(pageB, { type: 'user-stopped' });
  assert.equal(session.isStopped(), true);
});

test('(29) attachPage sends hello.stopped reflecting the current stopped flag', () => {
  const session = new Session();
  session.setPageUrl(PAGE_URL);
  const pageA = fakePage();
  authenticate(session, pageA);
  assert.deepEqual(pageA.sent[0], { type: 'hello', code: '', stopped: false });

  session.handlePageMessage(pageA, { type: 'user-stopped' });
  assert.equal(session.isStopped(), true);

  const pageB = fakePage();
  authenticate(session, pageB);
  assert.deepEqual(pageB.sent[0], { type: 'hello', code: '', stopped: true });
});

test('(31) a hand-eval ok from the active page updates getCode, sets wasEditedByHand() and clears isStopped() after a stop', () => {
  const session = new Session();
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);
  session.handlePageMessage(page, { type: 'user-stopped' });
  assert.equal(session.isStopped(), true);

  session.handlePageMessage(page, { type: 'hand-eval', ok: true, code: 's("hand")' });
  assert.equal(session.getCode(), 's("hand")');
  assert.equal(session.wasEditedByHand(), true);
  assert.equal(session.isStopped(), false);
});

test('(32) a hand-eval ok with the same code as the current one does not set wasEditedByHand()', async () => {
  const session = new Session();
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);

  const okPromise = session.evaluate('s("bd")');
  const okId = page.sent.at(-1).id;
  session.handlePageMessage(page, { type: 'evaluated', id: okId, ok: true, code: 's("bd")', audio: 'playing' });
  await okPromise;

  session.handlePageMessage(page, { type: 'hand-eval', ok: true, code: 's("bd")' });
  assert.equal(session.wasEditedByHand(), false);
});

test('(33) a hand-eval from a replaced page changes nothing', () => {
  const session = new Session();
  session.setPageUrl(PAGE_URL);
  const pageA = fakePage();
  authenticate(session, pageA);
  const pageB = fakePage();
  authenticate(session, pageB); // pageA is now stale (the last page to authenticate wins)

  session.handlePageMessage(pageA, { type: 'hand-eval', ok: true, code: 's("hand")' });
  assert.equal(session.getCode(), '');
  assert.equal(session.wasEditedByHand(), false);
});

test('(34) an evaluate success after a hand edit resolves with replacedHandEdit true and clears wasEditedByHand()', async () => {
  const session = new Session();
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);

  session.handlePageMessage(page, { type: 'hand-eval', ok: true, code: 's("hand")' });
  assert.equal(session.wasEditedByHand(), true);

  const promise = session.evaluate('s("claude")');
  const id = page.sent.at(-1).id;
  session.handlePageMessage(page, { type: 'evaluated', id, ok: true, code: 's("claude")', audio: 'playing' });
  const outcome = await promise;
  assert.equal(outcome.replacedHandEdit, true);
  assert.equal(session.wasEditedByHand(), false);
});

test('(35) an evaluate failure keeps wasEditedByHand() as is', async () => {
  const session = new Session();
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);

  session.handlePageMessage(page, { type: 'hand-eval', ok: true, code: 's("hand")' });
  assert.equal(session.wasEditedByHand(), true);

  const promise = session.evaluate('s("claude")');
  const id = page.sent.at(-1).id;
  session.handlePageMessage(page, { type: 'evaluated', id, ok: false, code: 's("claude")', error: 'boom' });
  await assert.rejects(() => promise);
  assert.equal(session.wasEditedByHand(), true, 'a failed evaluate must not clear the hand-edit flag');
});

test('(36) a page attaching after a hand edit receives the hand-edited code in its hello', () => {
  const session = new Session();
  session.setPageUrl(PAGE_URL);
  const pageA = fakePage();
  authenticate(session, pageA);

  session.handlePageMessage(pageA, { type: 'hand-eval', ok: true, code: 's("hand")' });

  const pageB = fakePage();
  authenticate(session, pageB);
  assert.deepEqual(pageB.sent[0], { type: 'hello', code: 's("hand")', stopped: false });
});

test('(30) an evaluated ok reply with audio "stopped" stores the code, keeps isStopped() true, and resolves with audio "stopped"', async () => {
  const session = new Session();
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);

  session.handlePageMessage(page, { type: 'user-stopped' });
  assert.equal(session.isStopped(), true);

  const promise = session.evaluate('s("bd")');
  const id = page.sent.at(-1).id;
  session.handlePageMessage(page, { type: 'evaluated', id, ok: true, code: 's("bd")', audio: 'stopped' });
  const outcome = await promise;
  assert.equal(outcome.audio, 'stopped');
  assert.equal(session.getCode(), 's("bd")');
  assert.equal(session.isStopped(), true);
});

test('(37) handEvalFailedLine formats the detail, an optional line, and the tail', () => {
  assert.equal(
    handEvalFailedLine('boom', 2, STILL_PLAYING_TAIL),
    'Note: an edit evaluated by hand in the page failed: boom, line 2. The previous code is still playing.',
  );
});

test('(38) a failed hand-eval from the active page leaves getCode unchanged; drainNotices contains the line once, then not', () => {
  const session = new Session();
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);

  session.handlePageMessage(page, { type: 'hand-eval', ok: false, error: 'boom', line: 2 });
  assert.equal(session.getCode(), '');

  const first = drainWithoutArming(session);
  assert.deepEqual(first.lines, [handEvalFailedLine('boom', 2, NOTHING_PLAYING_TAIL)]);

  const second = drainWithoutArming(session);
  assert.deepEqual(second.lines, []);
});

test('(39) drainNotices puts the hand-failure line before any runtime-error lines', () => {
  const session = new Session();
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);

  session.handlePageMessage(page, { type: 'hand-eval', ok: false, error: 'boom' });
  session.handlePageMessage(page, { type: 'runtime-error', message: 'oops' });

  const { lines } = drainWithoutArming(session);
  assert.equal(lines[0], handEvalFailedLine('boom', undefined, NOTHING_PLAYING_TAIL));
  assert.equal(lines[1], 'Runtime error while playing: oops.');
});

test('(40) two failed hand-evals before a drain give only the newest line', () => {
  const session = new Session();
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);

  session.handlePageMessage(page, { type: 'hand-eval', ok: false, error: 'first' });
  session.handlePageMessage(page, { type: 'hand-eval', ok: false, error: 'second', line: 5 });

  const { lines } = drainWithoutArming(session);
  assert.deepEqual(lines, [handEvalFailedLine('second', 5, NOTHING_PLAYING_TAIL)]);
});

test('(41) a failed hand-eval followed by a successful hand-eval drains no hand-failure line', () => {
  const session = new Session();
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);

  session.handlePageMessage(page, { type: 'hand-eval', ok: false, error: 'boom' });
  session.handlePageMessage(page, { type: 'hand-eval', ok: true, code: 's("hand")' });

  const { lines } = drainWithoutArming(session);
  assert.deepEqual(lines, []);
});

test('(42) a failed hand-eval followed by a successful set_code drains no hand-failure line', async () => {
  const session = new Session();
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);

  session.handlePageMessage(page, { type: 'hand-eval', ok: false, error: 'boom' });

  const promise = session.evaluate('s("claude")');
  const id = page.sent.at(-1).id;
  session.handlePageMessage(page, { type: 'evaluated', id, ok: true, code: 's("claude")', audio: 'playing' });
  await promise;

  const { lines } = drainWithoutArming(session);
  assert.deepEqual(lines, []);
});

test('(43) a failed hand-eval from a replaced page drains nothing', () => {
  const session = new Session();
  session.setPageUrl(PAGE_URL);
  const pageA = fakePage();
  authenticate(session, pageA);
  const pageB = fakePage();
  authenticate(session, pageB); // pageA is now stale (the last page to authenticate wins)

  session.handlePageMessage(pageA, { type: 'hand-eval', ok: false, error: 'boom' });

  const { lines } = drainWithoutArming(session);
  assert.deepEqual(lines, []);
});

test('(44) the hand-failure tail is computed when the failure arrives: NOTHING_PLAYING_TAIL with no code, STILL_STOPPED_TAIL while stopped', async () => {
  const session = new Session();
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);

  session.handlePageMessage(page, { type: 'hand-eval', ok: false, error: 'nothing yet' });
  assert.deepEqual(drainWithoutArming(session).lines, [
    handEvalFailedLine('nothing yet', undefined, NOTHING_PLAYING_TAIL),
  ]);

  const okPromise = session.evaluate('s("bd")');
  const okId = page.sent.at(-1).id;
  session.handlePageMessage(page, { type: 'evaluated', id: okId, ok: true, code: 's("bd")', audio: 'playing' });
  await okPromise;

  const stopPromise = session.stop();
  const stopId = page.sent.at(-1).id;
  session.handlePageMessage(page, { type: 'stop-result', id: stopId });
  await stopPromise;

  session.handlePageMessage(page, { type: 'hand-eval', ok: false, error: 'while stopped' });
  assert.deepEqual(drainWithoutArming(session).lines, [
    handEvalFailedLine('while stopped', undefined, STILL_STOPPED_TAIL),
  ]);
});

test('(45) reconnectEvalFailedLine formats the detail, an optional line, and always ends with NOTHING_PLAYING_TAIL', () => {
  assert.equal(
    reconnectEvalFailedLine('boom', 3),
    'Note: reconnecting to the page failed to restore the last code: boom, line 3. Nothing is playing yet.',
  );
  assert.equal(
    reconnectEvalFailedLine('boom', undefined),
    'Note: reconnecting to the page failed to restore the last code: boom. Nothing is playing yet.',
  );
});

test('(46) a reconnect-eval-failed report from the active page clears getCode and queues a notice, drained once', async () => {
  const session = new Session();
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);

  const okPromise = session.evaluate('s("bd")');
  const okId = page.sent.at(-1).id;
  session.handlePageMessage(page, { type: 'evaluated', id: okId, ok: true, code: 's("bd")', audio: 'playing' });
  await okPromise;
  assert.equal(session.getCode(), 's("bd")');

  session.handlePageMessage(page, { type: 'reconnect-eval-failed', error: 'sample not found', line: 1 });
  assert.equal(session.getCode(), '', 'a failed reconnect replay must clear the confirmed code');

  const first = drainWithoutArming(session);
  assert.deepEqual(first.lines, [reconnectEvalFailedLine('sample not found', 1)]);

  const second = drainWithoutArming(session);
  assert.deepEqual(second.lines, []);
});

test('(47) a reconnect-eval-failed report from a replaced (stale) page changes nothing', () => {
  const session = new Session();
  session.setPageUrl(PAGE_URL);
  const pageA = fakePage();
  authenticate(session, pageA);

  // Confirm code on pageA while it is still active.
  session.handlePageMessage(pageA, { type: 'hand-eval', ok: true, code: 's("hand")' });
  assert.equal(session.getCode(), 's("hand")');

  const pageB = fakePage();
  authenticate(session, pageB); // pageA is now stale (the last page to authenticate wins)

  session.handlePageMessage(pageA, { type: 'reconnect-eval-failed', error: 'boom' });
  assert.equal(session.getCode(), 's("hand")', 'a stale page report must not clear the confirmed code');
  assert.deepEqual(drainWithoutArming(session).lines, []);
});

// Cases from (48) on: recording versions to a HistoryStore.

test('(48) a hand-eval ok from the active page records origin "hand" with the hand-edit label', () => {
  const dir = tempHistoryDir();
  const history = new HistoryStore({ dataDir: dir });
  const session = new Session({ history });
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);

  session.handlePageMessage(page, { type: 'hand-eval', ok: true, code: 's("hand")' });

  const versions = readHistoryLines(dir).filter((l) => l.type === 'version');
  assert.equal(versions.length, 1);
  assert.equal(versions[0].origin, 'hand');
  assert.equal(versions[0].label, HAND_EDIT_LABEL);
});

test('(49) a hand-eval of unchanged code records nothing new', () => {
  const dir = tempHistoryDir();
  const history = new HistoryStore({ dataDir: dir });
  const session = new Session({ history });
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);

  session.handlePageMessage(page, { type: 'hand-eval', ok: true, code: 's("hand")' });
  session.handlePageMessage(page, { type: 'hand-eval', ok: true, code: 's("hand")' });

  const versions = readHistoryLines(dir).filter((l) => l.type === 'version');
  assert.equal(versions.length, 1, 'the same code twice in a row must be recorded once');
});

test('(50) a hand-eval from a replaced page records nothing', () => {
  const dir = tempHistoryDir();
  const history = new HistoryStore({ dataDir: dir });
  const session = new Session({ history });
  session.setPageUrl(PAGE_URL);
  const pageA = fakePage();
  authenticate(session, pageA);
  const pageB = fakePage();
  authenticate(session, pageB);

  session.handlePageMessage(pageA, { type: 'hand-eval', ok: true, code: 's("hand")' });

  const versions = readHistoryLines(dir).filter((l) => l.type === 'version');
  assert.equal(versions.length, 0);
});

test('(51) a late success from the active page records with the label its evaluate call gave', async () => {
  const dir = tempHistoryDir();
  const history = new HistoryStore({ dataDir: dir });
  const session = new Session({ history, replyTimeoutMs: 30 });
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);

  await assert.rejects(() => session.evaluate('s("bd")', { label: 'a late one' }), assertMessage(NOT_RESPONDING_MESSAGE));
  const lateId = page.sent.at(-1).id;
  session.handlePageMessage(page, { type: 'evaluated', id: lateId, ok: true, code: 's("bd")', audio: 'playing' });

  const versions = readHistoryLines(dir).filter((l) => l.type === 'version');
  assert.equal(versions.length, 1);
  assert.equal(versions[0].label, 'a late one');
});

test('(52) an on-time failure, a stale on-time success, a late failure and a late success from a replaced page record nothing', async () => {
  const dir = tempHistoryDir();
  const history = new HistoryStore({ dataDir: dir });
  const session = new Session({ history, replyTimeoutMs: 30 });
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);

  // On-time failure.
  const failPromise = session.evaluate('s("fail")');
  const failId = page.sent.at(-1).id;
  session.handlePageMessage(page, { type: 'evaluated', id: failId, ok: false, code: 's("fail")', error: 'boom' });
  await assert.rejects(() => failPromise);

  // Stale on-time success.
  const stalePromise = session.evaluate('s("stale")');
  const staleId = page.sent.at(-1).id;
  const pageB = fakePage();
  authenticate(session, pageB);
  session.handlePageMessage(page, { type: 'evaluated', id: staleId, ok: true, code: 's("stale")', audio: 'playing' });
  await assert.rejects(() => stalePromise);

  // Late failure (on pageB, now active).
  await assert.rejects(() => session.evaluate('s("late-fail")'), assertMessage(NOT_RESPONDING_MESSAGE));
  const lateFailId = pageB.sent.at(-1).id;
  session.handlePageMessage(pageB, { type: 'evaluated', id: lateFailId, ok: false, code: 's("late-fail")', error: 'boom' });

  // Late success from a page that is no longer active.
  await assert.rejects(() => session.evaluate('s("late-stale")'), assertMessage(NOT_RESPONDING_MESSAGE));
  const lateStaleId = pageB.sent.at(-1).id;
  const pageC = fakePage();
  authenticate(session, pageC);
  session.handlePageMessage(pageB, {
    type: 'evaluated',
    id: lateStaleId,
    ok: true,
    code: 's("late-stale")',
    audio: 'playing',
  });

  const versions = readHistoryLines(dir).filter((l) => l.type === 'version');
  assert.equal(versions.length, 0);
});

test('(53) stop, user-stopped, runtime-error and reconnect-eval-failed never record a version', async () => {
  const dir = tempHistoryDir();
  const history = new HistoryStore({ dataDir: dir });
  const session = new Session({ history });
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);

  const stopPromise = session.stop();
  const stopId = page.sent.at(-1).id;
  session.handlePageMessage(page, { type: 'stop-result', id: stopId });
  await stopPromise;

  session.handlePageMessage(page, { type: 'user-stopped' });
  session.handlePageMessage(page, { type: 'runtime-error', message: 'oops' });
  session.handlePageMessage(page, { type: 'reconnect-eval-failed', error: 'boom' });

  const versions = readHistoryLines(dir).filter((l) => l.type === 'version');
  assert.equal(versions.length, 0);
});

test('(54) a confirmed success pushes {type: "version", id}; a write failure pushes {type: "version", id: null} and queues a note once', async () => {
  const dir = tempHistoryDir();
  const okHistory = new HistoryStore({ dataDir: dir });
  const session = new Session({ history: okHistory });
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);

  const promise = session.evaluate('s("bd")');
  const id = page.sent.at(-1).id;
  session.handlePageMessage(page, { type: 'evaluated', id, ok: true, code: 's("bd")', audio: 'playing' });
  const outcome = await promise;
  assert.equal(outcome.versionId, 1);
  assert.deepEqual(page.sent.at(-1), { type: 'version', id: 1 });

  // A store whose write always fails (history.jsonl is a directory, not a file).
  const failDir = tempHistoryDir();
  fs.mkdirSync(path.join(failDir, 'history.jsonl'));
  const failingHistory = new HistoryStore({ dataDir: failDir });
  const failingSession = new Session({ history: failingHistory });
  failingSession.setPageUrl(PAGE_URL);
  const page2 = fakePage();
  authenticate(failingSession, page2);

  const promise2 = failingSession.evaluate('s("bd")');
  const id2 = page2.sent.at(-1).id;
  failingSession.handlePageMessage(page2, { type: 'evaluated', id: id2, ok: true, code: 's("bd")', audio: 'playing' });
  const outcome2 = await promise2;
  assert.equal(outcome2.versionId, null);
  assert.deepEqual(page2.sent.at(-1), { type: 'version', id: null });

  const first = drainWithoutArming(failingSession);
  assert.equal(first.lines.length, 1);
  assert.ok(first.lines[0].startsWith('Note: this version could not be saved to history ('));
  const second = drainWithoutArming(failingSession);
  assert.deepEqual(second.lines, []);
});

test('(55) a page attaching after a recorded version receives hello then {type: "version", id}; without a store, no version frame is ever sent', async () => {
  const dir = tempHistoryDir();
  const history = new HistoryStore({ dataDir: dir });
  const session = new Session({ history });
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);

  const promise = session.evaluate('s("bd")');
  const id = page.sent.at(-1).id;
  session.handlePageMessage(page, { type: 'evaluated', id, ok: true, code: 's("bd")', audio: 'playing' });
  await promise;

  const pageB = fakePage();
  authenticate(session, pageB);
  assert.deepEqual(pageB.sent[0], { type: 'hello', code: 's("bd")', stopped: false });
  assert.deepEqual(pageB.sent[1], { type: 'version', id: 1 });

  // Without a store, no version frame is ever sent (cases (1)-(47) pass unchanged).
  const plainSession = new Session();
  plainSession.setPageUrl(PAGE_URL);
  const plainPage = fakePage();
  authenticate(plainSession, plainPage);
  assert.equal(plainPage.sent.length, 1, 'a session with no history store must never send a version frame');
});

test('(56) reconnect-eval-failed from the active page makes getCurrentVersionId() null', async () => {
  const dir = tempHistoryDir();
  const history = new HistoryStore({ dataDir: dir });
  const session = new Session({ history });
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);

  const promise = session.evaluate('s("bd")');
  const id = page.sent.at(-1).id;
  session.handlePageMessage(page, { type: 'evaluated', id, ok: true, code: 's("bd")', audio: 'playing' });
  await promise;
  assert.equal(session.getCurrentVersionId(), 1);

  session.handlePageMessage(page, { type: 'reconnect-eval-failed', error: 'boom' });
  assert.equal(session.getCurrentVersionId(), null);
});

test('(57) an intent left by a timed-out request is pruned after RECORD_INTENT_TTL_MS, keeping recordIntentCount bounded', async () => {
  assert.ok(RECORD_INTENT_TTL_MS > 0);
  const session = new Session({ replyTimeoutMs: 5, recordIntentTtlMs: 50 });
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);

  await assert.rejects(() => session.evaluate('s("bd")'), assertMessage(NOT_RESPONDING_MESSAGE));
  assert.equal(session.recordIntentCount(), 1);

  await new Promise((resolve) => setTimeout(resolve, 60));

  const promise = session.evaluate('s("cp")');
  assert.equal(session.recordIntentCount(), 1, 'the stale intent must be pruned, leaving only the new request');
  const id = page.sent.at(-1).id;
  session.handlePageMessage(page, { type: 'evaluated', id, ok: true, code: 's("cp")', audio: 'playing' });
  await promise;
});

// Cases from (58) on: restore_version.

test('(58) restoreVersion of the id whose code is the last version still records a new id with restoredFrom (force bypasses the dedup rule)', async () => {
  const dir = tempHistoryDir();
  const history = new HistoryStore({ dataDir: dir });
  const session = new Session({ history });
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);

  const firstPromise = session.evaluate('s("bd")');
  const firstId = page.sent.at(-1).id;
  session.handlePageMessage(page, { type: 'evaluated', id: firstId, ok: true, code: 's("bd")', audio: 'playing' });
  await firstPromise;

  const restorePromise = session.restoreVersion(1);
  const restoreId = page.sent.at(-1).id;
  session.handlePageMessage(page, { type: 'evaluated', id: restoreId, ok: true, code: 's("bd")', audio: 'playing' });
  const outcome = await restorePromise;
  assert.equal(outcome.versionId, 2);

  const versions = readHistoryLines(dir).filter((l) => l.type === 'version');
  assert.equal(versions.length, 2);
  assert.equal(versions[1].id, 2);
  assert.equal(versions[1].restoredFrom, 1);
  assert.equal(versions[1].label, 'restored from #1');
});

test('(59) a restore that times out and whose success arrives late records with label "restored from #N" and restoredFrom N', async () => {
  const dir = tempHistoryDir();
  const history = new HistoryStore({ dataDir: dir });
  const session = new Session({ history, replyTimeoutMs: 30 });
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);

  const firstPromise = session.evaluate('s("bd")');
  const firstId = page.sent.at(-1).id;
  session.handlePageMessage(page, { type: 'evaluated', id: firstId, ok: true, code: 's("bd")', audio: 'playing' });
  await firstPromise;

  await assert.rejects(() => session.restoreVersion(1), assertMessage(NOT_RESPONDING_MESSAGE));
  const lateId = page.sent.at(-1).id;
  session.handlePageMessage(page, { type: 'evaluated', id: lateId, ok: true, code: 's("bd")', audio: 'playing' });

  const versions = readHistoryLines(dir).filter((l) => l.type === 'version');
  assert.equal(versions.length, 2);
  assert.equal(versions[1].label, 'restored from #1');
  assert.equal(versions[1].restoredFrom, 1);
});

test('(60) restoreVersion of an unknown id rejects with versionNotFoundMessage and sends no frame', async () => {
  const dir = tempHistoryDir();
  const history = new HistoryStore({ dataDir: dir });
  const session = new Session({ history });
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);
  const sentBeforeCount = page.sent.length;

  await assert.rejects(() => session.restoreVersion(99), assertMessage(versionNotFoundMessage(99)));
  assert.equal(page.sent.length, sentBeforeCount, 'an unknown id must never reach the page');
});

test('(61) restoreVersion without a store rejects with the history-unavailable text', async () => {
  const session = new Session();
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);

  await assert.rejects(
    () => session.restoreVersion(1),
    assertMessage(historyUnavailableMessage('no history store is configured')),
  );
});

// Cases from (62) on: tagging runtime errors with the evaluate
// id that was playing when they were raised, so Claude never "fixes" code that
// isn't actually broken.

test('(62) earlierRuntimeErrorLine formats a single occurrence and a repeated one', () => {
  assert.equal(
    earlierRuntimeErrorLine('boom', 1),
    'Runtime error from an earlier version (not the code playing now): boom.',
  );
  assert.equal(
    earlierRuntimeErrorLine('boom', 3),
    'Runtime error from an earlier version (not the code playing now, repeated 3 times): boom.',
  );
});

test('(63) a runtime-error tagged with an old evaluate id is labeled as coming from an earlier version once a newer evaluate succeeds', async () => {
  const session = new Session();
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);

  const first = session.evaluate('s("a")');
  const firstId = page.sent.at(-1).id;
  session.handlePageMessage(page, { type: 'evaluated', id: firstId, ok: true, code: 's("a")', audio: 'playing' });
  await first;

  // The second evaluate's own reply hasn't arrived yet; an error tagged with the FIRST
  // (now superseded) id arrives first, exactly as the previous version's own errors can.
  const second = session.evaluate('s("b")');
  const secondId = page.sent.at(-1).id;
  session.handlePageMessage(page, { type: 'runtime-error', message: 'old boom', evaluateId: firstId });
  session.handlePageMessage(page, { type: 'evaluated', id: secondId, ok: true, code: 's("b")', audio: 'playing' });
  await second;

  const { lines, hadRuntimeErrors } = drainWithoutArming(session);
  assert.deepEqual(lines, ['Runtime error from an earlier version (not the code playing now): old boom.']);
  assert.equal(hadRuntimeErrors, false);
});

test('(64) a runtime-error tagged with the new evaluate id, arriving before its own evaluated reply, is current', async () => {
  const session = new Session();
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);

  const promise = session.evaluate('s("a")');
  const id = page.sent.at(-1).id;
  // The page tags the error with this request's own id right after evaluating it, before
  // sending the 'evaluated' success reply (see page/main.js handleEvaluate).
  session.handlePageMessage(page, { type: 'runtime-error', message: 'fresh boom', evaluateId: id });
  session.handlePageMessage(page, { type: 'evaluated', id, ok: true, code: 's("a")', audio: 'playing' });
  await promise;

  const { lines, hadRuntimeErrors } = drainWithoutArming(session);
  assert.deepEqual(lines, ['Runtime error while playing: fresh boom.']);
  assert.equal(hadRuntimeErrors, true);
});

test('(65) a successful hand evaluation resets which runtime errors count as current', async () => {
  const session = new Session();
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);

  const promise = session.evaluate('s("a")');
  const id = page.sent.at(-1).id;
  session.handlePageMessage(page, { type: 'evaluated', id, ok: true, code: 's("a")', audio: 'playing' });
  await promise;

  session.handlePageMessage(page, { type: 'hand-eval', ok: true, code: 's("hand")' });

  // An error still tagged with the id from before the hand edit is now from an earlier
  // version; an untagged error (as the page sends while a hand edit plays) is current.
  session.handlePageMessage(page, { type: 'runtime-error', message: 'still tagged old', evaluateId: id });
  session.handlePageMessage(page, { type: 'runtime-error', message: 'untagged after hand edit' });

  const { lines, hadRuntimeErrors } = drainWithoutArming(session);
  assert.deepEqual(lines, [
    'Runtime error from an earlier version (not the code playing now): still tagged old.',
    'Runtime error while playing: untagged after hand edit.',
  ]);
  assert.equal(hadRuntimeErrors, true);
});

test('(66) after a failed evaluate, a runtime-error tagged with the still-playing code stays current', async () => {
  const session = new Session();
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);

  const first = session.evaluate('s("a")');
  const firstId = page.sent.at(-1).id;
  session.handlePageMessage(page, { type: 'evaluated', id: firstId, ok: true, code: 's("a")', audio: 'playing' });
  await first;

  const second = session.evaluate('s(broken');
  const secondId = page.sent.at(-1).id;
  session.handlePageMessage(page, {
    type: 'evaluated',
    id: secondId,
    ok: false,
    code: 's(broken',
    error: 'syntax boom',
  });
  await assert.rejects(second);

  // The first evaluate's code is still playing (the failed second one never replaced it), so
  // an error still tagged with its id is current, not from an earlier version.
  session.handlePageMessage(page, { type: 'runtime-error', message: 'still playing boom', evaluateId: firstId });

  const { lines, hadRuntimeErrors } = drainWithoutArming(session);
  assert.deepEqual(lines, ['Runtime error while playing: still playing boom.']);
  assert.equal(hadRuntimeErrors, true);
});

test('(67) the runtime-error caps count distinct (tag, message) pairs, across both current and earlier entries', () => {
  const session = new Session();
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);
  assert.equal(MAX_RUNTIME_ERRORS, 10);

  for (let i = 0; i < MAX_RUNTIME_ERRORS; i++) {
    session.handlePageMessage(page, { type: 'runtime-error', message: `current ${i}` });
  }
  // An 11th distinct entry, tagged differently from every entry above — it still counts
  // toward the same cap and overflows it, whichever way it will later be classified.
  session.handlePageMessage(page, { type: 'runtime-error', message: 'overflow', evaluateId: 'old-id' });

  const { lines } = drainWithoutArming(session);
  assert.equal(lines.length, MAX_RUNTIME_ERRORS + 1);
  assert.equal(lines.at(-1), 'Note: 1 more distinct runtime error was not shown.');
});

test('(68) the same message with two different tags counts as two distinct entries, not a repeat of one', () => {
  const session = new Session();
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);

  session.handlePageMessage(page, { type: 'runtime-error', message: 'same text', evaluateId: 'id-a' });
  session.handlePageMessage(page, { type: 'runtime-error', message: 'same text', evaluateId: 'id-b' });

  const { lines } = drainWithoutArming(session);
  assert.equal(lines.length, 2);
  assert.ok(lines.every((line) => line.includes('same text')));
});

// Version-named earlier lines, and the bound on tracked evaluate ids.

test('(69) earlierRuntimeErrorLine formats a versioned single occurrence and a versioned repeated one', () => {
  assert.equal(
    earlierRuntimeErrorLine('boom', 1, 11),
    'Runtime error from an earlier version (#11, not the code playing now): boom.',
  );
  assert.equal(
    earlierRuntimeErrorLine('boom', 3, 11),
    'Runtime error from an earlier version (#11, not the code playing now, repeated 3 times): boom.',
  );
});

test('(70) drainNotices names the version of both current and earlier runtime-error entries, in first-seen order', async () => {
  const dir = tempHistoryDir();
  const history = new HistoryStore({ dataDir: dir });
  const session = new Session({ history });
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);

  const a = session.evaluate('s("a")', { label: 'A' });
  const aId = page.sent.at(-1).id;
  session.handlePageMessage(page, { type: 'evaluated', id: aId, ok: true, code: 's("a")', audio: 'playing' });
  await a; // recorded as version #1

  const b = session.evaluate('s("b")', { label: 'B' });
  const bId = page.sent.at(-1).id;
  session.handlePageMessage(page, { type: 'evaluated', id: bId, ok: true, code: 's("b")', audio: 'playing' });
  await b; // recorded as version #2

  session.handlePageMessage(page, { type: 'runtime-error', message: 'old boom', evaluateId: aId });
  session.handlePageMessage(page, { type: 'runtime-error', message: 'new boom', evaluateId: bId });
  session.handlePageMessage(page, { type: 'runtime-error', message: 'untagged boom' });

  const { lines } = drainWithoutArming(session);
  assert.deepEqual(lines, [
    'Runtime error from an earlier version (#1, not the code playing now): old boom.',
    'Runtime error while playing #2: new boom.',
    'Runtime error from an earlier version (not the code playing now): untagged boom.',
  ]);
});

test('(71) a runtime-error tagged with a failed evaluate, or with a late success, in a Session without a store, names no version', async () => {
  const session = new Session({ replyTimeoutMs: 30 });
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);

  // A tag whose evaluate failed never reaches recordConfirmed, so it is never remembered.
  const failPromise = session.evaluate('s("fail")');
  const failId = page.sent.at(-1).id;
  session.handlePageMessage(page, { type: 'evaluated', id: failId, ok: false, code: 's("fail")', error: 'boom' });
  await assert.rejects(() => failPromise);
  session.handlePageMessage(page, { type: 'runtime-error', message: 'failed eval boom', evaluateId: failId });

  // A late success (its reply arrived after the timeout, same shape as test (51)) still has no
  // store to record a version into, so it is remembered with a null versionId too.
  await assert.rejects(() => session.evaluate('s("late")'), assertMessage(NOT_RESPONDING_MESSAGE));
  const lateId = page.sent.at(-1).id;
  session.handlePageMessage(page, { type: 'evaluated', id: lateId, ok: true, code: 's("late")', audio: 'playing' });
  session.handlePageMessage(page, { type: 'runtime-error', message: 'late boom', evaluateId: lateId });

  const { lines } = drainWithoutArming(session);
  assert.deepEqual(lines, [
    'Runtime error from an earlier version (not the code playing now): failed eval boom.',
    'Runtime error while playing: late boom.',
  ]);
});

test('(72) trackedEvaluateIdCount stays bounded at MAX_TRACKED_EVALUATE_IDS after more successful evaluates of distinct code', async () => {
  const dir = tempHistoryDir();
  const history = new HistoryStore({ dataDir: dir });
  const session = new Session({ history });
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);

  for (let i = 0; i < MAX_TRACKED_EVALUATE_IDS + 5; i++) {
    const promise = session.evaluate(`s("bd").gain(${i})`);
    const id = page.sent.at(-1).id;
    session.handlePageMessage(page, { type: 'evaluated', id, ok: true, code: `s("bd").gain(${i})`, audio: 'playing' });
    await promise;
  }

  assert.equal(session.trackedEvaluateIdCount(), MAX_TRACKED_EVALUATE_IDS);
});

// Cases from (73) on: empty hand edits, and Saved (not Renamed) when a favorite
// keeps its name.

test('(73) a hand-eval ok with empty or whitespace-only code records no version and drains nothing', () => {
  const dir = tempHistoryDir();
  const history = new HistoryStore({ dataDir: dir });
  const session = new Session({ history });
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);

  session.handlePageMessage(page, { type: 'hand-eval', ok: true, code: '' });
  assert.equal(session.getCode(), '');
  session.handlePageMessage(page, { type: 'hand-eval', ok: true, code: '  \n\t ' });
  assert.equal(session.getCode(), '');

  const versions = readHistoryLines(dir).filter((l) => l.type === 'version');
  assert.equal(versions.length, 0, 'an empty or whitespace-only hand-eval must record no version');
  assert.deepEqual(drainWithoutArming(session).lines, []);
});

test('(74) an empty hand-eval after a recorded version clears getCode, sets wasEditedByHand, and pushes a null version id', async () => {
  const dir = tempHistoryDir();
  const history = new HistoryStore({ dataDir: dir });
  const session = new Session({ history });
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);

  const promise = session.evaluate('s("a")');
  const id = page.sent.at(-1).id;
  session.handlePageMessage(page, { type: 'evaluated', id, ok: true, code: 's("a")', audio: 'playing' });
  await promise;
  assert.equal(session.getCurrentVersionId(), 1);

  session.handlePageMessage(page, { type: 'hand-eval', ok: true, code: '' });
  assert.equal(session.getCode(), '');
  assert.equal(session.wasEditedByHand(), true);
  assert.deepEqual(page.sent.at(-1), { type: 'version', id: null }, 'the page must be told no version describes the editor anymore');
  assert.equal(session.getCurrentVersionId(), null);

  const versions = readHistoryLines(dir).filter((l) => l.type === 'version');
  assert.equal(versions.length, 1, 'the empty hand-eval must not add a version line');
});

test('(75) a fresh HistoryStore opened after an empty hand-eval reports no unreadable line', () => {
  const dir = tempHistoryDir();
  const history = new HistoryStore({ dataDir: dir });
  const session = new Session({ history });
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);

  session.handlePageMessage(page, { type: 'hand-eval', ok: true, code: 's("a")' });
  session.handlePageMessage(page, { type: 'hand-eval', ok: true, code: '' });

  const fresh = new HistoryStore({ dataDir: dir });
  fresh.load();
  assert.equal(fresh.takeUnreadableNote(), null, 'the empty hand-eval must never have reached the history file');
});

test('(76) a Session without a store handles an empty hand-eval without throwing, and sends no version frame', () => {
  const session = new Session();
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);
  const sentBefore = page.sent.length;

  assert.doesNotThrow(() => session.handlePageMessage(page, { type: 'hand-eval', ok: true, code: '' }));
  assert.equal(session.getCode(), '');
  assert.equal(page.sent.length, sentBefore, 'without a history store, no version frame is ever sent');
});

test('(77) a failed hand-eval is unchanged by the empty-code guard — it still queues its failure line', () => {
  const dir = tempHistoryDir();
  const history = new HistoryStore({ dataDir: dir });
  const session = new Session({ history });
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);

  session.handlePageMessage(page, { type: 'hand-eval', ok: false, error: 'boom' });
  assert.deepEqual(drainWithoutArming(session).lines, [handEvalFailedLine('boom', undefined, NOTHING_PLAYING_TAIL)]);
});

test('(78) session.favoriteVersion says Saved both times when a favorite keeps its name', async () => {
  const dir = tempHistoryDir();
  const history = new HistoryStore({ dataDir: dir });
  const session = new Session({ history });
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);

  const promise = session.evaluate('s("bd")');
  const id = page.sent.at(-1).id;
  session.handlePageMessage(page, { type: 'evaluated', id, ok: true, code: 's("bd")', audio: 'playing' });
  await promise;

  const first = session.favoriteVersion(1, 'Take one');
  const second = session.favoriteVersion(1, 'Take one');
  assert.equal(first, favoriteSavedMessage(1, 'Take one'));
  assert.equal(second, favoriteSavedMessage(1, 'Take one'), 'keeping the same name a second time must still say Saved');
});

// Cases from (79) on: the part-launch, mirroring the
// hand-eval tests above ((31)-(36), (48)-(50)) one for one.

test('(79) a part-launch from the active page updates getCode, sets wasEditedByHand() and clears isStopped() after a stop', () => {
  const session = new Session();
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);
  session.handlePageMessage(page, { type: 'user-stopped' });
  assert.equal(session.isStopped(), true);

  session.handlePageMessage(page, { type: 'part-launch', code: 's("launch")', part: 'two' });
  assert.equal(session.getCode(), 's("launch")');
  assert.equal(session.wasEditedByHand(), true);
  assert.equal(session.isStopped(), false);
});

test('(80) a part-launch with the same code as the current one does not set wasEditedByHand()', async () => {
  const session = new Session();
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);

  const okPromise = session.evaluate('s("bd")');
  const okId = page.sent.at(-1).id;
  session.handlePageMessage(page, { type: 'evaluated', id: okId, ok: true, code: 's("bd")', audio: 'playing' });
  await okPromise;

  session.handlePageMessage(page, { type: 'part-launch', code: 's("bd")', part: 'two' });
  assert.equal(session.wasEditedByHand(), false);
});

test('(81) a part-launch from a replaced (stale) page changes nothing', () => {
  const session = new Session();
  session.setPageUrl(PAGE_URL);
  const pageA = fakePage();
  authenticate(session, pageA);
  const pageB = fakePage();
  authenticate(session, pageB); // pageA is now stale (the last page to authenticate wins)

  session.handlePageMessage(pageA, { type: 'part-launch', code: 's("launch")', part: 'two' });
  assert.equal(session.getCode(), '');
  assert.equal(session.wasEditedByHand(), false);
});

test('(82) a part-launch whose code is only whitespace changes nothing (the same empty-code rule as a hand edit)', () => {
  const session = new Session();
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);

  session.handlePageMessage(page, { type: 'part-launch', code: '   \n  ', part: 'two' });
  assert.equal(session.getCode(), '');
  assert.equal(session.wasEditedByHand(), false);
  assert.equal(session.isStopped(), false);
});

test('(83) a part-launch records one version with origin "page" and label "launched two", and the page receives {type: "version", id}', () => {
  const dir = tempHistoryDir();
  const history = new HistoryStore({ dataDir: dir });
  const session = new Session({ history });
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);

  session.handlePageMessage(page, { type: 'part-launch', code: 's("launch")', part: 'two' });

  const versions = readHistoryLines(dir).filter((l) => l.type === 'version');
  assert.equal(versions.length, 1);
  assert.equal(versions[0].origin, 'page');
  assert.equal(versions[0].label, 'launched two');
  assert.equal(versions[0].code, 's("launch")');
  assert.deepEqual(page.sent.at(-1), { type: 'version', id: 1 });
});

test('(84) a part-launch whose code is only whitespace records nothing to history', () => {
  const dir = tempHistoryDir();
  const history = new HistoryStore({ dataDir: dir });
  const session = new Session({ history });
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);

  session.handlePageMessage(page, { type: 'part-launch', code: '   ', part: 'two' });

  const versions = readHistoryLines(dir).filter((l) => l.type === 'version');
  assert.equal(versions.length, 0);
});

// Cases from (85) on: the history feed and a restore asked for from the page's History view.

/** Plays `code` through evaluate() and confirms it, like the page would; resolves with the outcome. */
async function playCode(session, page, code) {
  const promise = session.evaluate(code);
  const id = page.sent.at(-1).id;
  session.handlePageMessage(page, { type: 'evaluated', id, ok: true, code, audio: 'playing' });
  return promise;
}

const historyFrames = (page) => page.sent.filter((frame) => frame.type.startsWith('history'));

test('(85) a page that never sent history-request receives no history frame, and its last frame is still exactly { type: "version", id }', async () => {
  const dir = tempHistoryDir();
  const session = new Session({ history: new HistoryStore({ dataDir: dir }) });
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);

  await playCode(session, page, 's("bd")');

  assert.deepEqual(page.sent.at(-1), { type: 'version', id: 1 });
  assert.deepEqual(historyFrames(page), []);
});

test('(86) after history-request the page gets the window newest first; a later recorded evaluate sends version, then history-add with the new total; a deduplicated evaluate sends no history-add', async () => {
  const dir = tempHistoryDir();
  const session = new Session({ history: new HistoryStore({ dataDir: dir }) });
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);
  await playCode(session, page, 's("bd")');
  await playCode(session, page, 's("hh")');

  session.handlePageMessage(page, { type: 'history-request' });
  const window = page.sent.at(-1);
  assert.equal(window.type, 'history');
  assert.deepEqual(
    window.versions.map((v) => v.id),
    [2, 1],
  );
  assert.equal(window.versions[0].code, 's("hh")');
  assert.equal(window.beyond, null);
  assert.equal(window.total, 2);
  assert.equal(window.remaining, 0);

  await playCode(session, page, 's("cp")');
  const tail = page.sent.slice(-2);
  assert.deepEqual(tail[0], { type: 'version', id: 3 });
  assert.equal(tail[1].type, 'history-add');
  assert.equal(tail[1].version.id, 3);
  assert.equal(tail[1].version.origin, 'claude');
  assert.equal(tail[1].version.code, 's("cp")');
  assert.equal(tail[1].total, 3);

  const framesBefore = page.sent.length;
  await playCode(session, page, 's("cp")'); // same code, not forced: nothing new is recorded
  assert.deepEqual(
    page.sent.slice(framesBefore).map((frame) => frame.type),
    ['evaluate', 'version'],
    'the deduplicated evaluate records nothing new, so only its own evaluate and version frames go out',
  );
});

test('(87) history-request with no store, or with a store that cannot be read, sends history-error', () => {
  const noStore = new Session();
  noStore.setPageUrl(PAGE_URL);
  const pageA = fakePage();
  authenticate(noStore, pageA);
  noStore.handlePageMessage(pageA, { type: 'history-request' });
  assert.deepEqual(pageA.sent.at(-1), { type: 'history-error' });

  // A history file that is really a directory cannot be read on any system (a data dir that is a regular
  // file is not enough: on Windows the history path inside it reads as missing, not as unreadable).
  const dir = tempHistoryDir();
  fs.mkdirSync(path.join(dir, 'history.jsonl'));
  const broken = new Session({ history: new HistoryStore({ dataDir: dir }) });
  broken.setPageUrl(PAGE_URL);
  const pageB = fakePage();
  authenticate(broken, pageB);
  broken.handlePageMessage(pageB, { type: 'history-request' });
  assert.deepEqual(pageB.sent.at(-1), { type: 'history-error' });
});

test('(88) history-restore from the active page replays the code of #N; on success the new line has origin page, label "restored from #N" and restoredFrom N, the hand-edit flag is set, and the version frame carries restoredFrom', async () => {
  const dir = tempHistoryDir();
  const session = new Session({ history: new HistoryStore({ dataDir: dir }) });
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);
  await playCode(session, page, 's("bd")');
  await playCode(session, page, 's("hh")');
  assert.equal(session.wasEditedByHand(), false);

  session.handlePageMessage(page, { type: 'history-restore', id: 1 });
  const evaluate = page.sent.at(-1);
  assert.equal(evaluate.type, 'evaluate');
  assert.equal(evaluate.code, 's("bd")');
  session.handlePageMessage(page, { type: 'evaluated', id: evaluate.id, ok: true, code: 's("bd")', audio: 'playing' });

  const versions = readHistoryLines(dir).filter((l) => l.type === 'version');
  assert.equal(versions.length, 3);
  assert.equal(versions[2].origin, 'page');
  assert.equal(versions[2].label, 'restored from #1');
  assert.equal(versions[2].restoredFrom, 1);
  assert.equal(session.getCode(), 's("bd")');
  assert.equal(session.wasEditedByHand(), true);
  assert.deepEqual(page.sent.at(-1), { type: 'version', id: 3, restoredFrom: 1 });
});

test('(89) a page restore answered after the reply timeout is still recorded with origin page', async () => {
  const dir = tempHistoryDir();
  const session = new Session({ history: new HistoryStore({ dataDir: dir }), replyTimeoutMs: 20 });
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);
  await playCode(session, page, 's("bd")');
  await playCode(session, page, 's("hh")');

  session.handlePageMessage(page, { type: 'history-restore', id: 1 });
  const evaluate = page.sent.at(-1);
  await new Promise((resolve) => setTimeout(resolve, 60)); // the request times out
  session.handlePageMessage(page, { type: 'evaluated', id: evaluate.id, ok: true, code: 's("bd")', audio: 'playing' });

  const versions = readHistoryLines(dir).filter((l) => l.type === 'version');
  assert.equal(versions.length, 3);
  assert.equal(versions[2].origin, 'page');
  assert.equal(versions[2].restoredFrom, 1);
  assert.equal(session.wasEditedByHand(), true);
});

test('(90) a page restore whose code equals the code playing now leaves wasEditedByHand() exactly as it was', async () => {
  const dir = tempHistoryDir();
  const session = new Session({ history: new HistoryStore({ dataDir: dir }) });
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);
  await playCode(session, page, 's("bd")');
  assert.equal(session.wasEditedByHand(), false);

  session.handlePageMessage(page, { type: 'history-restore', id: 1 });
  let evaluate = page.sent.at(-1);
  session.handlePageMessage(page, { type: 'evaluated', id: evaluate.id, ok: true, code: 's("bd")', audio: 'playing' });
  assert.equal(session.wasEditedByHand(), false, 'a restore of what plays must not invent a hand edit');

  // Now a real hand edit is pending, and restoring the very code that plays keeps it pending.
  session.handlePageMessage(page, { type: 'hand-eval', ok: true, code: 's("hh")' });
  assert.equal(session.wasEditedByHand(), true);
  session.handlePageMessage(page, { type: 'history-restore', id: 3 });
  evaluate = page.sent.at(-1);
  assert.equal(evaluate.code, 's("hh")');
  session.handlePageMessage(page, { type: 'evaluated', id: evaluate.id, ok: true, code: 's("hh")', audio: 'playing' });
  assert.equal(session.wasEditedByHand(), true);
});

test('(91) history-restore from a replaced (stale) page sends no evaluate frame and records nothing', async () => {
  const dir = tempHistoryDir();
  const session = new Session({ history: new HistoryStore({ dataDir: dir }) });
  session.setPageUrl(PAGE_URL);
  const pageA = fakePage();
  authenticate(session, pageA);
  await playCode(session, pageA, 's("bd")');
  const pageB = fakePage();
  authenticate(session, pageB); // pageA is now stale (the last page to authenticate wins)
  const sentBefore = pageA.sent.length;

  session.handlePageMessage(pageA, { type: 'history-restore', id: 1 });

  assert.equal(pageA.sent.length, sentBefore);
  assert.ok(!pageB.sent.some((frame) => frame.type === 'evaluate'));
  assert.equal(readHistoryLines(dir).filter((l) => l.type === 'version').length, 1);
});

test('(92) history-restore of an unknown id sends no evaluate frame and resends a fresh history window to that page', async () => {
  const dir = tempHistoryDir();
  const session = new Session({ history: new HistoryStore({ dataDir: dir }) });
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);
  await playCode(session, page, 's("bd")');
  const sentBefore = page.sent.length;

  session.handlePageMessage(page, { type: 'history-restore', id: 99 });

  const newFrames = page.sent.slice(sentBefore);
  assert.equal(newFrames.length, 1);
  assert.equal(newFrames[0].type, 'history');
  assert.deepEqual(
    newFrames[0].versions.map((v) => v.id),
    [1],
  );
  assert.equal(readHistoryLines(dir).filter((l) => l.type === 'version').length, 1);
});

test('(92b) history-restore when the store cannot be read logs the real reason and answers history-error, never "not in the history"', async () => {
  const dir = tempHistoryDir();
  const history = new HistoryStore({ dataDir: dir });
  const session = new Session({ history });
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);
  await playCode(session, page, 's("bd")');
  history.getVersion = () => {
    throw new Error('disk on fire');
  };
  const sentBefore = page.sent.length;

  const realError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.join(' '));
  try {
    session.handlePageMessage(page, { type: 'history-restore', id: 1 });
  } finally {
    console.error = realError;
  }

  assert.deepEqual(page.sent.slice(sentBefore), [{ type: 'history-error' }]);
  assert.ok(logged.some((l) => l.includes('#1') && l.includes('disk on fire')));
  assert.ok(!logged.some((l) => l.includes('not in the history')));
  assert.equal(readHistoryLines(dir).filter((l) => l.type === 'version').length, 1);
});

test('(93) a page restore whose evaluation fails, or that times out with no reply, causes no unhandled rejection and records nothing', async () => {
  const seen = [];
  const listener = (reason) => seen.push(reason);
  process.on('unhandledRejection', listener);
  try {
    const dir = tempHistoryDir();
    const session = new Session({ history: new HistoryStore({ dataDir: dir }), replyTimeoutMs: 20 });
    session.setPageUrl(PAGE_URL);
    const page = fakePage();
    authenticate(session, page);
    await playCode(session, page, 's("bd")');

    // The evaluation fails in the page.
    session.handlePageMessage(page, { type: 'history-restore', id: 1 });
    const failing = page.sent.at(-1);
    session.handlePageMessage(page, { type: 'evaluated', id: failing.id, ok: false, code: 's("bd")', error: 'boom' });

    // No reply at all: the request times out.
    session.handlePageMessage(page, { type: 'history-restore', id: 1 });
    await new Promise((resolve) => setTimeout(resolve, 80));
    // Give any unhandled rejection the chance to surface.
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(seen, []);
    assert.equal(readHistoryLines(dir).filter((l) => l.type === 'version').length, 1);
    assert.equal(session.pendingCount(), 0);
  } finally {
    process.off('unhandledRejection', listener);
  }
});

test('(94) restoreVersion(id) with no options still records origin "claude"', async () => {
  const dir = tempHistoryDir();
  const session = new Session({ history: new HistoryStore({ dataDir: dir }) });
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);
  await playCode(session, page, 's("bd")');
  await playCode(session, page, 's("hh")');

  const promise = session.restoreVersion(1);
  const id = page.sent.at(-1).id;
  session.handlePageMessage(page, { type: 'evaluated', id, ok: true, code: 's("bd")', audio: 'playing' });
  await promise;

  const versions = readHistoryLines(dir).filter((l) => l.type === 'version');
  assert.equal(versions[2].origin, 'claude');
  assert.equal(versions[2].restoredFrom, 1);
  assert.equal(session.wasEditedByHand(), false);
});

test('(95) after detachPage a subscribed page receives nothing more', async () => {
  const dir = tempHistoryDir();
  const session = new Session({ history: new HistoryStore({ dataDir: dir }) });
  session.setPageUrl(PAGE_URL);
  const stale = fakePage();
  authenticate(session, stale);
  session.handlePageMessage(stale, { type: 'history-request' });
  session.detachPage(stale);
  const fresh = fakePage();
  authenticate(session, fresh);
  const sentBefore = stale.sent.length;

  await playCode(session, fresh, 's("bd")');

  assert.equal(stale.sent.length, sentBefore);
});

test('(96) attachPage after a restore re-sends { type: "version", id, restoredFrom }', async () => {
  const dir = tempHistoryDir();
  const session = new Session({ history: new HistoryStore({ dataDir: dir }) });
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);
  await playCode(session, page, 's("bd")');
  await playCode(session, page, 's("hh")');
  session.handlePageMessage(page, { type: 'history-restore', id: 1 });
  const evaluate = page.sent.at(-1);
  session.handlePageMessage(page, { type: 'evaluated', id: evaluate.id, ok: true, code: 's("bd")', audio: 'playing' });

  const reloaded = fakePage();
  authenticate(session, reloaded);

  assert.deepEqual(reloaded.sent.at(-1), { type: 'version', id: 3, restoredFrom: 1 });
});

// The parent of every new version, per origin.

const versionLines = (dir) => readHistoryLines(dir).filter((l) => l.type === 'version');
const parents = (dir) => versionLines(dir).map((v) => [v.id, v.parent]);

function newSession(dir) {
  const session = new Session({ history: new HistoryStore({ dataDir: dir }) });
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);
  return { session, page };
}

test('(97) set_code records the version that was playing as parent, and a run of changes chains id - 1', async () => {
  const dir = tempHistoryDir();
  const { session, page } = newSession(dir);
  for (const code of ['s("bd")', 's("hh")', 's("cp")', 's("sd")']) {
    await playCode(session, page, code);
  }
  assert.deepEqual(parents(dir), [
    [1, undefined],
    [2, 1],
    [3, 2],
    [4, 3],
  ]);
  for (const v of versionLines(dir).slice(1)) assert.equal(v.parent, v.id - 1);
});

test('(98) a hand-eval and a part-launch record the current version as parent', async () => {
  const dir = tempHistoryDir();
  const { session, page } = newSession(dir);
  await playCode(session, page, 's("bd")');
  session.handlePageMessage(page, { type: 'hand-eval', ok: true, code: 's("hand")' });
  session.handlePageMessage(page, { type: 'part-launch', code: 's("part")', part: 'intro' });
  assert.deepEqual(parents(dir), [
    [1, undefined],
    [2, 1],
    [3, 2],
  ]);
  assert.equal(versionLines(dir)[1].origin, 'hand');
  assert.equal(versionLines(dir)[1].parent, 1);
  assert.equal(versionLines(dir)[2].origin, 'page');
  assert.equal(versionLines(dir)[2].parent, 2);
});

test('(99) a restore by Claude and a restore from the page record the restored version as parent, and the next change forks from the restore', async () => {
  const dir = tempHistoryDir();
  const { session, page } = newSession(dir);
  for (const code of ['s("bd")', 's("hh")', 's("cp")']) await playCode(session, page, code);

  const claudeRestore = session.restoreVersion(1);
  session.handlePageMessage(page, { type: 'evaluated', id: page.sent.at(-1).id, ok: true, code: 's("bd")', audio: 'playing' });
  await claudeRestore;

  session.handlePageMessage(page, { type: 'history-restore', id: 2 });
  session.handlePageMessage(page, { type: 'evaluated', id: page.sent.at(-1).id, ok: true, code: 's("hh")', audio: 'playing' });

  await playCode(session, page, 's("sd")');

  assert.deepEqual(parents(dir), [
    [1, undefined],
    [2, 1],
    [3, 2],
    [4, 1],
    [5, 2],
    [6, 5],
  ]);
  assert.equal(versionLines(dir)[4].origin, 'page');
  assert.equal(versionLines(dir)[3].parent, 1, 'the restore by Claude hangs off #1');
  assert.equal(versionLines(dir)[4].parent, 2, 'the restore from the page hangs off #2');
  assert.equal(versionLines(dir)[5].parent, 5, 'the change after a restore forks from it');
});

test('(100) after a blank hand edit the next version hangs off the newest version in the file', async () => {
  const dir = tempHistoryDir();
  const { session, page } = newSession(dir);
  await playCode(session, page, 's("bd")');
  await playCode(session, page, 's("hh")');
  session.handlePageMessage(page, { type: 'hand-eval', ok: true, code: '   ' });
  await playCode(session, page, 's("cp")');
  assert.deepEqual(parents(dir), [
    [1, undefined],
    [2, 1],
    [3, 2],
  ]);
});

test('(101) after a write failure the next version hangs off the newest version in the file', async () => {
  const dir = tempHistoryDir();
  const history = new HistoryStore({ dataDir: dir });
  const session = new Session({ history });
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);
  await playCode(session, page, 's("bd")');
  await playCode(session, page, 's("hh")');

  const original = history.recordVersion.bind(history);
  let failed = false;
  history.recordVersion = (input) => {
    if (!failed) {
      failed = true;
      throw new HistoryError('disk full');
    }
    return original(input);
  };
  const realError = console.error;
  console.error = () => {};
  try {
    await playCode(session, page, 's("cp")');
  } finally {
    console.error = realError;
  }
  assert.equal(page.sent.filter((f) => f.type === 'version').at(-1).id, null);
  await playCode(session, page, 's("sd")');
  history.recordVersion = original;

  assert.deepEqual(parents(dir), [
    [1, undefined],
    [2, 1],
    [3, 2],
  ]);
  assert.equal(versionLines(dir)[2].code, 's("sd")');
  assert.equal(versionLines(dir)[2].parent, 2);
});

// Paging, live favorite updates, and a fresh window after a compaction.

test('(102) history-more answers history-older with the next older versions; a page that is not the active one is answered too', async () => {
  const dir = tempHistoryDir();
  const session = new Session({ history: new HistoryStore({ dataDir: dir }) });
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);
  for (const code of ['s("a")', 's("b")', 's("c")', 's("d")']) await playCode(session, page, code);
  const stale = fakePage();
  authenticate(session, stale);

  session.handlePageMessage(stale, { type: 'history-more', before: 3 });

  assert.deepEqual(stale.sent.at(-1).versions.map((v) => v.id), [2, 1]);
  assert.equal(stale.sent.at(-1).type, 'history-older');
  assert.equal(stale.sent.at(-1).beyond, null);
  assert.equal(stale.sent.at(-1).remaining, 0);
});

test('(103) history-more with a cursor no longer in the file logs and answers with a fresh history', async () => {
  const dir = tempHistoryDir();
  const session = new Session({ history: new HistoryStore({ dataDir: dir }) });
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);
  await playCode(session, page, 's("a")');

  const realError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.join(' '));
  try {
    session.handlePageMessage(page, { type: 'history-more', before: 42 });
  } finally {
    console.error = realError;
  }
  assert.equal(page.sent.at(-1).type, 'history');
  assert.ok(logged.some((l) => l.includes('#42') && l.includes('no longer in the history')));
});

test('(104) history-more with no store answers history-error', () => {
  const session = new Session();
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);
  const realError = console.error;
  console.error = () => {};
  try {
    session.handlePageMessage(page, { type: 'history-more', before: 3 });
  } finally {
    console.error = realError;
  }
  assert.deepEqual(page.sent.at(-1), { type: 'history-error' });
});

test('(104b) history-more when the file cannot be read answers history-older-error, not history-error', async () => {
  const dir = tempHistoryDir();
  const history = new HistoryStore({ dataDir: dir });
  const session = new Session({ history });
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);
  await playCode(session, page, 's("a")');
  history.readWindow = () => {
    throw new Error('disk on fire');
  };
  const realError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.join(' '));
  try {
    session.handlePageMessage(page, { type: 'history-more', before: 1 });
  } finally {
    console.error = realError;
  }
  assert.deepEqual(page.sent.at(-1), { type: 'history-older-error' });
  assert.ok(logged.some((l) => l.includes('disk on fire')));
});

test('(104c) a failed read while adding a version sends every subscriber a fresh window, not a terminal history-error', async () => {
  const dir = tempHistoryDir();
  const history = new HistoryStore({ dataDir: dir });
  const session = new Session({ history });
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);
  session.handlePageMessage(page, { type: 'history-request' });
  await playCode(session, page, 's("a")');
  const realReadWindow = history.readWindow.bind(history);
  let failNext = true;
  history.readWindow = (options) => {
    // Only the one-row read behind history-add fails; the fresh window that follows succeeds.
    if (failNext && options.limit === 1) {
      failNext = false;
      throw new Error('disk on fire');
    }
    return realReadWindow(options);
  };
  const before = historyFrames(page).length;
  const realError = console.error;
  console.error = () => {};
  try {
    await playCode(session, page, 's("b")');
  } finally {
    console.error = realError;
  }
  const frames = historyFrames(page).slice(before);
  assert.deepEqual(frames.map((f) => f.type), ['history']);
  assert.deepEqual(frames[0].versions.map((v) => v.id), [2, 1]);
});

test('(105) favoriteVersion sends every subscriber history-favorite with the normalized name; a page that never asked receives nothing', async () => {
  const dir = tempHistoryDir();
  const session = new Session({ history: new HistoryStore({ dataDir: dir }) });
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);
  await playCode(session, page, 's("a")');
  const other = fakePage();
  authenticate(session, other);
  session.handlePageMessage(page, { type: 'history-request' });

  session.favoriteVersion(1, '  my \n groove ');

  assert.deepEqual(page.sent.at(-1), { type: 'history-favorite', id: 1, name: 'my groove' });
  assert.deepEqual(historyFrames(other), []);
});

test('(106) a record that triggers a compaction sends every subscriber a full history window instead of history-add', async () => {
  const dir = tempHistoryDir();
  const history = new HistoryStore({ dataDir: dir, cap: 5, batch: 2 });
  const session = new Session({ history });
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);
  session.handlePageMessage(page, { type: 'history-request' });
  for (let i = 1; i <= 6; i++) await playCode(session, page, `s("v${i}")`);
  const before = historyFrames(page).length;
  assert.ok(historyFrames(page).slice(1).every((f) => f.type === 'history-add'));

  await playCode(session, page, 's("v7")');

  const frames = historyFrames(page).slice(before);
  assert.deepEqual(frames.map((f) => f.type), ['history']);
  assert.deepEqual(frames[0].versions.map((v) => v.id), [7, 6, 5, 4, 3]);
});

// A Mixer gesture reaches the server as mixer-live (the code playing, never
// recorded) and mixer-record (one version, sent about 1.5 s after the last move).

/** Runs `fn` with console.error captured; returns the lines it printed. */
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

test('(107) mixer-live from the active page sets get_code, writes no history line and sends no version', async () => {
  const dir = tempHistoryDir();
  const { session, page } = newSession(dir);
  await playCode(session, page, 'drums: s("bd").gain(0.3)');
  const linesBefore = readHistoryLines(dir).length;
  const sentBefore = page.sent.length;

  session.handlePageMessage(page, { type: 'mixer-live', code: 'drums: s("bd").gain(0.5)' });
  session.handlePageMessage(page, { type: 'mixer-live', code: 'drums: s("bd").gain(0.7)' });

  assert.equal(session.getCode(), 'drums: s("bd").gain(0.7)');
  assert.equal(readHistoryLines(dir).length, linesBefore);
  assert.equal(page.sent.length, sentBefore);
  assert.equal(session.getCurrentVersionId(), 1);
});

test('(108) mixer-live after a change makes the hand-edit note behave as for a part launch', async () => {
  const dir = tempHistoryDir();
  const { session, page } = newSession(dir);
  await playCode(session, page, 'drums: s("bd").gain(0.3)');
  assert.equal(session.wasEditedByHand(), false);
  session.handlePageMessage(page, { type: 'mixer-live', code: 'drums: s("bd").gain(0.5)' });
  assert.equal(session.wasEditedByHand(), true);
});

test('(108b) a mixer drag that ends where it began clears the hand-edit flag again, one that ended elsewhere keeps it', async () => {
  const dir = tempHistoryDir();
  const { session, page } = newSession(dir);
  await playCode(session, page, 'drums: s("bd").gain(0.3)');
  session.handlePageMessage(page, { type: 'mixer-live', code: 'drums: s("bd").gain(0.5)' });
  assert.equal(session.wasEditedByHand(), true);
  session.handlePageMessage(page, { type: 'mixer-live', code: 'drums: s("bd").gain(0.7)' });
  assert.equal(session.wasEditedByHand(), true);
  session.handlePageMessage(page, { type: 'mixer-live', code: 'drums: s("bd").gain(0.3)' });
  assert.equal(session.wasEditedByHand(), false, 'the code is Claude\'s own again');
  session.handlePageMessage(page, { type: 'mixer-record', code: 'drums: s("bd").gain(0.3)', label: 'mixer: drums volume 0.3' });
  assert.equal(session.wasEditedByHand(), false);
  // A genuine hand edit is never cleared by a drag that returns to the code the drag started from.
  session.handlePageMessage(page, { type: 'hand-eval', ok: true, code: 'drums: s("hand")' });
  assert.equal(session.wasEditedByHand(), true);
  session.handlePageMessage(page, { type: 'mixer-live', code: 'drums: s("hand").gain(0.5)' });
  session.handlePageMessage(page, { type: 'mixer-live', code: 'drums: s("hand")' });
  assert.equal(session.wasEditedByHand(), true);
});

test('(109) mixer-live and mixer-record from a page that is not the active one change nothing and log', async () => {
  const dir = tempHistoryDir();
  const session = new Session({ history: new HistoryStore({ dataDir: dir }) });
  session.setPageUrl(PAGE_URL);
  const stale = fakePage();
  authenticate(session, stale);
  const page = fakePage();
  authenticate(session, page); // the last page to authenticate wins: stale is no longer the active page
  await playCode(session, page, 'drums: s("bd").gain(0.3)');
  const linesBefore = readHistoryLines(dir).length;

  const lines = captureErrors(() => {
    session.handlePageMessage(stale, { type: 'mixer-live', code: 'drums: s("bd").gain(0.9)' });
    session.handlePageMessage(stale, { type: 'mixer-record', code: 'drums: s("bd").gain(0.9)', label: 'mixer: drums volume 0.9' });
  });

  assert.deepEqual(lines, [
    '[moontide] Ignoring mixer change from a non-active page',
    '[moontide] Ignoring mixer record from a non-active page',
  ]);
  assert.equal(session.getCode(), 'drums: s("bd").gain(0.3)');
  assert.equal(readHistoryLines(dir).length, linesBefore);
});

test('(110) mixer-live and mixer-record with whitespace-only code are ignored', async () => {
  const dir = tempHistoryDir();
  const { session, page } = newSession(dir);
  await playCode(session, page, 'drums: s("bd").gain(0.3)');
  const linesBefore = readHistoryLines(dir).length;

  const lines = captureErrors(() => {
    session.handlePageMessage(page, { type: 'mixer-live', code: '   \n' });
    session.handlePageMessage(page, { type: 'mixer-record', code: '  ', label: 'mixer: drums volume 0' });
  });

  assert.deepEqual(lines, [
    '[moontide] Ignoring mixer change with empty code',
    '[moontide] Ignoring mixer record with empty code',
  ]);
  assert.equal(session.getCode(), 'drums: s("bd").gain(0.3)');
  assert.equal(readHistoryLines(dir).length, linesBefore);
});

test('(111) mixer-record writes one page version with the label, sends the version, and its parent is the version that was playing', async () => {
  const dir = tempHistoryDir();
  const { session, page } = newSession(dir);
  await playCode(session, page, 'drums: s("bd").gain(0.3)');
  session.handlePageMessage(page, { type: 'mixer-live', code: 'drums: s("bd").gain(0.6)' });
  session.handlePageMessage(page, { type: 'mixer-record', code: 'drums: s("bd").gain(0.6)', label: 'mixer: drums volume 0.6' });

  const versions = versionLines(dir);
  assert.equal(versions.length, 2);
  assert.equal(versions[1].origin, 'page');
  assert.equal(versions[1].label, 'mixer: drums volume 0.6');
  assert.equal(versions[1].code, 'drums: s("bd").gain(0.6)');
  assert.equal(versions[1].parent, 1);
  assert.deepEqual(page.sent.at(-1), { type: 'version', id: 2 });
  assert.equal(session.getCode(), 'drums: s("bd").gain(0.6)');
});

test('(112) mixer-record after a hand-eval hangs off the hand-eval version', async () => {
  const dir = tempHistoryDir();
  const { session, page } = newSession(dir);
  await playCode(session, page, 's("bd")');
  session.handlePageMessage(page, { type: 'hand-eval', ok: true, code: 'drums: s("hand")' });
  session.handlePageMessage(page, { type: 'mixer-record', code: 'drums: s("hand").gain(0.4)', label: 'mixer: drums volume 0.4' });

  assert.deepEqual(parents(dir), [
    [1, undefined],
    [2, 1],
    [3, 2],
  ]);
  assert.equal(versionLines(dir)[2].origin, 'page');
});

test('(113) a second mixer-record with the same code records nothing new', async () => {
  const dir = tempHistoryDir();
  const { session, page } = newSession(dir);
  await playCode(session, page, 'drums: s("bd").gain(0.3)');
  session.handlePageMessage(page, { type: 'mixer-record', code: 'drums: s("bd").gain(0.6)', label: 'mixer: drums volume 0.6' });
  session.handlePageMessage(page, { type: 'mixer-record', code: 'drums: s("bd").gain(0.6)', label: 'mixer: drums volume 0.6' });
  assert.equal(versionLines(dir).length, 2);
  // A drag that ends where it began is a no-op too: the code is the playing code again.
  session.handlePageMessage(page, { type: 'mixer-record', code: 'drums: s("bd").gain(0.6)', label: 'mixer: drums volume 0.6' });
  assert.equal(versionLines(dir).length, 2);
});

test('(114) mixer-live and mixer-record leave a stopped session stopped', async () => {
  const dir = tempHistoryDir();
  const { session, page } = newSession(dir);
  await playCode(session, page, 'drums: s("bd").gain(0.3)');
  session.handlePageMessage(page, { type: 'user-stopped' });
  assert.equal(session.isStopped(), true);

  session.handlePageMessage(page, { type: 'mixer-live', code: 'drums: s("bd").gain(0.5)' });
  assert.equal(session.isStopped(), true);
  session.handlePageMessage(page, { type: 'mixer-record', code: 'drums: s("bd").gain(0.5)', label: 'mixer: drums volume 0.5' });
  assert.equal(session.isStopped(), true);
  assert.equal(versionLines(dir).length, 2);
});

// The ask channel's wiring in the session.

/** A session with the page URL set and one connected fake page; `page-auth` is sent by the caller. */
function askSession({ authenticated = true } = {}) {
  const session = new Session();
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  if (authenticated) authenticate(session, page);
  return { session, page };
}

test('(115) drainNotices with no authenticated page returns only the lines already queued: no arming line', async () => {
  const { session, page } = askSession({ authenticated: false });
  assert.deepEqual(session.drainNotices().lines, []);
  // A failed hand evaluation from a page that never authenticated is not dispatched: no notice line.
  const errors = captureErrors(() => {
    session.handlePageMessage(page, { type: 'hand-eval', ok: false, error: 'boom', line: 2 });
  });
  assert.equal(errors.length, 1);
  assert.deepEqual(session.drainNotices().lines, []);
  assert.deepEqual(page.sent, []);
});

test('(116) after page-auth the last drained line is the arming line with the port and the listener token, after a failed hand-eval line', () => {
  const { session, page } = askSession();
  session.handlePageMessage(page, { type: 'hand-eval', ok: false, error: 'boom', line: 2 });
  const { lines } = session.drainNotices();
  assert.equal(lines.length, 2);
  assert.equal(lines[0], handEvalFailedLine('boom', 2, NOTHING_PLAYING_TAIL));
  const arming = lines.at(-1);
  assert.ok(arming.startsWith('Page requests: no listener is connected.'), arming);
  assert.match(arming, / 5757 [0-9a-f]{64}$/);
  assert.ok(arming.includes(session.ask.listenerToken));
  assert.ok(arming.includes('timeout_ms 1800000'));
  // Still armed on the next reply: no listener came.
  assert.equal(session.drainNotices().lines.length, 1);
});

test('(117) after detachPage the arming line is gone', () => {
  const { session, page } = askSession();
  assert.equal(session.drainNotices().lines.length, 1);
  session.detachPage(page);
  assert.deepEqual(session.drainNotices().lines, []);
  assert.equal(session.ask.trustedCount(), 0);
});

test('(118) an ask routed through handlePageMessage from an authenticated page is answered waiting, never reaches handleEvaluated, and comes back before the arming line', () => {
  const { session, page } = askSession();
  const errors = captureErrors(() => {
    session.handlePageMessage(page, {
      type: 'ask',
      id: 'ask-1',
      text: 'make the drums shorter',
      context: { kind: 'session' },
      chip: 'Whole session',
      current: null,
    });
  });
  assert.deepEqual(errors, [], 'handleEvaluated would have logged an unmatched reply');
  assert.deepEqual(page.sent.at(-1), { type: 'ask-result', id: 'ask-1', status: 'waiting', waiting: 1 });
  assert.equal(session.pendingCount(), 0);

  const { lines } = session.drainNotices();
  assert.equal(lines.length, 2);
  assert.ok(lines[0].startsWith('Request from the Moontide page: '));
  assert.equal(JSON.parse(lines[0].slice('Request from the Moontide page: '.length)).text, 'make the drums shorter');
  assert.ok(lines[1].startsWith('Page requests: no listener is connected.'));
  assert.deepEqual(page.sent.at(-1), { type: 'ask-received', ids: ['ask-1'] });
});

test('(119) an ask from a page that did not authenticate is refused "token" through the session', () => {
  const { session, page } = askSession({ authenticated: false });
  const errors = captureErrors(() => {
    session.handlePageMessage(page, {
      type: 'ask',
      id: 'ask-9',
      text: 'make the hats quieter',
      context: { kind: 'session' },
      chip: 'Whole session',
      current: null,
    });
  });
  assert.equal(errors.length, 1);
  assert.deepEqual(page.sent.at(-1), { type: 'ask-result', id: 'ask-9', status: 'refused', reason: 'token' });
  assert.deepEqual(session.drainNotices().lines, []);
});

test('(120) without a known page address the arming line says so and holds no command', () => {
  const session = new Session();
  const page = fakePage();
  authenticate(session, page);
  const { lines } = session.drainNotices();
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes('page address is not known'), lines[0]);
  assert.ok(!lines[0].includes(session.ask.listenerToken));
});

// The page token gates every page message: a page that has not presented it is sent nothing,
// changes nothing and is logged; page-auth attaches it as the active page.

const CODE_MARKER = 'FORGED_MARKER';

test('(121) a page that never authenticated is sent nothing, changes no state and each message type logs one refusal', () => {
  const dir = tempHistoryDir();
  const session = new Session({ history: new HistoryStore({ dataDir: dir }) });
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  const code = `s("bd") // ${CODE_MARKER}`;
  const frames = [
    { type: 'hand-eval', ok: true, code },
    { type: 'part-launch', code, part: 'A' },
    { type: 'mixer-live', code },
    { type: 'mixer-record', code, label: 'mixer: x' },
    { type: 'history-restore', id: 1 },
    { type: 'history-request' },
    { type: 'history-more', before: 3 },
    { type: 'user-stopped' },
    { type: 'runtime-error', message: CODE_MARKER },
    { type: 'reconnect-eval-failed', error: CODE_MARKER },
    { type: 'evaluated', id: 'x', ok: true, code, audio: 'playing' },
    { type: 'stop-result', id: 'x' },
  ];
  const logs = captureErrors(() => {
    for (const frame of frames) session.handlePageMessage(page, frame);
  });

  assert.deepEqual(page.sent, []);
  assert.equal(session.getCode(), '');
  assert.deepEqual(readHistoryLines(dir), []);
  assert.equal(session.getCurrentVersionId(), null);
  assert.equal(session.isStopped(), false);
  assert.equal(session.wasEditedByHand(), false);
  assert.deepEqual(session.drainNotices().lines, []);
  for (const frame of frames) {
    const matching = logs.filter((l) => l.includes(`(${frame.type})`) && l.includes('did not present the page token'));
    assert.equal(matching.length, 1, `${frame.type}: ${logs.join('\n')}`);
  }
  assert.ok(!logs.some((l) => l.includes(CODE_MARKER)), 'the content must never be logged');
});

test('(122) a burst of 5 hand-eval frames from an unauthenticated page logs one line; a mixer-live in the burst logs its own', () => {
  const session = new Session();
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  const logs = captureErrors(() => {
    for (let i = 0; i < 5; i++) session.handlePageMessage(page, { type: 'hand-eval', ok: true, code: 's("bd")' });
    session.handlePageMessage(page, { type: 'mixer-live', code: 's("bd")' });
  });
  assert.equal(logs.filter((l) => l.includes('(hand-eval)')).length, 1, logs.join('\n'));
  assert.equal(logs.filter((l) => l.includes('(mixer-live)')).length, 1, logs.join('\n'));
  assert.equal(logs.length, 2);
});

test('(123) a correct page-auth sends ask-auth then hello and makes the page active; a repeated page-auth sends no second hello', async () => {
  const session = new Session();
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  session.handlePageMessage(page, { type: 'page-auth', token: session.ask.pageToken });
  assert.deepEqual(page.sent, [
    { type: 'ask-auth', ok: true },
    { type: 'hello', code: '', stopped: false },
    { type: 'page-requests', live: false },
  ]);
  session.handlePageMessage(page, { type: 'page-auth', token: session.ask.pageToken });
  assert.deepEqual(page.sent.slice(3), [
    { type: 'ask-auth', ok: true },
    { type: 'page-requests', live: false },
  ]);
  assert.equal(page.sent.filter((f) => f.type === 'hello').length, 1);
  await playCode(session, page, 's("bd")');
  assert.equal(session.getCode(), 's("bd")');
});

test('(124) last authenticated wins: an unauthenticated second page does not take over, an authenticated one does', async () => {
  const session = new Session();
  session.setPageUrl(PAGE_URL);
  const first = fakePage();
  const second = fakePage();
  authenticate(session, first);

  captureErrors(() => session.handlePageMessage(second, { type: 'user-stopped' }));
  let promise = session.evaluate('s("bd")');
  assert.equal(first.sent.at(-1).type, 'evaluate');
  assert.deepEqual(second.sent, []);
  session.handlePageMessage(first, { type: 'evaluated', id: first.sent.at(-1).id, ok: true, code: 's("bd")', audio: 'playing' });
  await promise;

  authenticate(session, second);
  promise = session.evaluate('s("hh")');
  assert.equal(second.sent.at(-1).type, 'evaluate');
  assert.notEqual(first.sent.at(-1).code, 's("hh")');
  session.handlePageMessage(second, { type: 'evaluated', id: second.sent.at(-1).id, ok: true, code: 's("hh")', audio: 'playing' });
  await promise;
});

test('(125) a wrong token sends ask-auth false and leaves the page unattached; a later correct token attaches it', async () => {
  const session = new Session();
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  const logs = captureErrors(() => {
    session.handlePageMessage(page, { type: 'page-auth', token: 'f'.repeat(64) });
  });
  assert.deepEqual(page.sent, [{ type: 'ask-auth', ok: false }]);
  assert.ok(logs.some((l) => l.includes("Refused a page's token")));
  await assert.rejects(() => session.evaluate('s("bd")'), assertMessage(noPageMessage(PAGE_URL)));

  session.handlePageMessage(page, { type: 'page-auth', token: session.ask.pageToken });
  assert.deepEqual(page.sent.slice(1), [
    { type: 'ask-auth', ok: true },
    { type: 'hello', code: '', stopped: false },
    { type: 'page-requests', live: false },
  ]);
  await playCode(session, page, 's("bd")');
  assert.equal(session.getCode(), 's("bd")');
});

/** A complete midi-state message for the session tests. */
function midiFacts(overrides = {}) {
  return {
    type: 'midi-state',
    access: 'enabled',
    failure: null,
    usesMidi: true,
    triedMidi: true,
    outputs: ['A', 'B'],
    ports: [],
    noPort: null,
    unreadable: false,
    hidden: false,
    playing: true,
    events: [],
    ...overrides,
  };
}

const notFoundFacts = (name) => midiFacts({ ports: [{ name, state: 'not-found', matches: [] }] });

test('(126) a midi-state from a page that is not the active page, or has not authenticated, leaves no MIDI line', () => {
  const session = new Session();
  session.setPageUrl(PAGE_URL);
  const replaced = fakePage();
  const active = fakePage();
  const anonymous = fakePage();
  authenticate(session, replaced);
  authenticate(session, active);
  const logs = captureErrors(() => session.handlePageMessage(replaced, notFoundFacts('X')));
  assert.ok(logs.some((l) => l.includes('non-active page')));
  captureErrors(() => session.handlePageMessage(anonymous, notFoundFacts('Y')));
  assert.deepEqual(drainWithoutArming(session).lines, []);
});

test('(127) the MIDI lines come before the arming line, and only once', () => {
  const session = new Session();
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);
  session.handlePageMessage(page, notFoundFacts('X'));
  const drained = session.drainNotices();
  assert.equal(drained.lines.length, 2);
  assert.equal(drained.lines[0], midiPortNotFoundLine('X', ['A', 'B']));
  assert.ok(drained.lines[1].startsWith(ARMING_LINE_PREFIX));
  assert.deepEqual(drainWithoutArming(session).lines, []);
});

test('(128) detaching the active page clears the MIDI state', () => {
  const session = new Session();
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);
  session.handlePageMessage(page, notFoundFacts('X'));
  session.detachPage(page);
  assert.deepEqual(session.drainNotices().lines, []);
  authenticate(session, page);
  session.handlePageMessage(page, notFoundFacts('X'));
  assert.equal(drainWithoutArming(session).lines.length, 1, 'the same problem is reported again by the next page');
});

test('(129) a second page becoming the active page clears the MIDI state', () => {
  const session = new Session();
  session.setPageUrl(PAGE_URL);
  const first = fakePage();
  const second = fakePage();
  authenticate(session, first);
  session.handlePageMessage(first, notFoundFacts('X'));
  authenticate(session, second);
  assert.deepEqual(drainWithoutArming(session).lines, []);
  session.handlePageMessage(second, notFoundFacts('X'));
  assert.equal(drainWithoutArming(session).lines.length, 1);
});

test('(130) a request that times out while the page awaits the MIDI permission says so', async () => {
  const session = new Session({ replyTimeoutMs: 30 });
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);
  session.handlePageMessage(page, midiFacts({ access: 'pending', usesMidi: false, triedMidi: true }));
  await assert.rejects(() => session.evaluate(`note("c3").midi('A')`), assertMessage(MIDI_PERMISSION_WAIT_MESSAGE));
  assert.equal(session.pendingCount(), 0);
});

test('(131) a timeout without a pending permission keeps the not-responding text', async () => {
  const session = new Session({ replyTimeoutMs: 30 });
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);
  session.handlePageMessage(page, midiFacts({ access: 'enabled' }));
  await assert.rejects(() => session.evaluate('s("bd")'), assertMessage(NOT_RESPONDING_MESSAGE));
  const other = new Session({ replyTimeoutMs: 30 });
  other.setPageUrl(PAGE_URL);
  authenticate(other, fakePage());
  await assert.rejects(() => other.evaluate('s("bd")'), assertMessage(NOT_RESPONDING_MESSAGE));
});

test('(132) a changed build is sent before hello, and Claude is told once', () => {
  const session = new Session({ build: { changed: () => ({ page: true, server: false }) } });
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);
  assert.deepEqual(page.sent[0], { type: 'build-mismatch' });
  assert.equal(page.sent[1].type, 'hello');
  const first = drainWithoutArming(session).lines;
  assert.equal(first.filter((l) => l === BUILD_MISMATCH_NOTE).length, 1);
  assert.ok(BUILD_MISMATCH_NOTE.includes('the server and the page come from different builds, restart the server'));
  assert.ok(BUILD_MISMATCH_NOTE.includes('restart Claude'));
  assert.deepEqual(drainWithoutArming(session).lines, []);
  const second = fakePage();
  authenticate(session, second);
  assert.deepEqual(second.sent[0], { type: 'build-mismatch' });
  assert.deepEqual(drainWithoutArming(session).lines, []);
});

test('(133) the build mismatch comes before midi-rig and hello', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moontide-session-build-rig-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(dir, 'instruments.json'),
    JSON.stringify({ instruments: [{ id: 'mt32', model: 'mt32', port: 'Fake Synth A' }] }),
  );
  const session = new Session({ build: { changed: () => ({ page: true, server: false }) }, rig: new RigStore({ dataDir: dir }) });
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);
  assert.deepEqual(
    page.sent.slice(0, 3).map((m) => m.type),
    ['build-mismatch', 'midi-rig', 'hello'],
  );
});

test('(134) a real BuildWatch tells once per transition into a mismatch', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moontide-session-build-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pageDir = path.join(root, 'page');
  const distDir = path.join(root, 'dist');
  fs.mkdirSync(pageDir);
  fs.mkdirSync(distDir);
  fs.writeFileSync(path.join(pageDir, 'index.html'), '<html></html>');
  fs.writeFileSync(path.join(pageDir, 'main.js'), 'a');
  fs.writeFileSync(path.join(distDir, 'a.js'), 'b');
  const session = new Session({ build: new BuildWatch({ page: pageDir, server: distDir }, { log: () => {} }) });
  session.setPageUrl(PAGE_URL);

  const first = fakePage();
  authenticate(session, first);
  assert.equal(first.sent[0].type, 'hello');
  assert.ok(!drainWithoutArming(session).lines.includes(BUILD_MISMATCH_NOTE));

  fs.writeFileSync(path.join(pageDir, 'main.js'), 'a2');
  const second = fakePage();
  authenticate(session, second);
  assert.deepEqual(second.sent[0], { type: 'build-mismatch' });
  assert.equal(drainWithoutArming(session).lines.filter((l) => l === BUILD_MISMATCH_NOTE).length, 1);

  fs.writeFileSync(path.join(pageDir, 'main.js'), 'a');
  const third = fakePage();
  authenticate(session, third);
  assert.equal(third.sent[0].type, 'hello');
  assert.ok(!drainWithoutArming(session).lines.includes(BUILD_MISMATCH_NOTE));

  fs.writeFileSync(path.join(pageDir, 'main.js'), 'a3');
  const fourth = fakePage();
  authenticate(session, fourth);
  assert.deepEqual(fourth.sent[0], { type: 'build-mismatch' });
  assert.equal(drainWithoutArming(session).lines.filter((l) => l === BUILD_MISMATCH_NOTE).length, 1);
});

test('(134b) a change in the compiled code alone tells Claude once, and the page hears server-updated on every connection, never a mismatch', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moontide-session-build-server-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pageDir = path.join(root, 'page');
  const distDir = path.join(root, 'dist');
  fs.mkdirSync(pageDir);
  fs.mkdirSync(distDir);
  fs.writeFileSync(path.join(pageDir, 'main.js'), 'a');
  fs.writeFileSync(path.join(distDir, 'a.js'), 'b');
  const session = new Session({ build: new BuildWatch({ page: pageDir, server: distDir }, { log: () => {} }) });
  session.setPageUrl(PAGE_URL);

  fs.writeFileSync(path.join(distDir, 'a.js'), 'b2');
  const first = fakePage();
  authenticate(session, first);
  assert.deepEqual(first.sent[0], { type: 'server-updated' });
  assert.equal(first.sent[1].type, 'hello');
  assert.ok(!first.sent.some((m) => m.type === 'build-mismatch'), 'the page and the server still match');
  const lines = drainWithoutArming(session).lines;
  assert.equal(lines.filter((l) => l === BUILD_UPDATED_NOTE).length, 1);
  assert.ok(!lines.includes(BUILD_MISMATCH_NOTE));
  assert.ok(BUILD_UPDATED_NOTE.includes('restart Claude'));
  assert.ok(!BUILD_UPDATED_NOTE.includes('come from different builds, restart'));

  const second = fakePage();
  authenticate(session, second);
  assert.ok(!second.sent.some((m) => m.type === 'build-mismatch'));
  assert.deepEqual(second.sent[0], { type: 'server-updated' }, 'a reloaded page is told again, the line is the page\'s own');
  assert.deepEqual(drainWithoutArming(session).lines, []);

  // The page folder changing as well is a real mismatch: the page hears it (and not server-updated) and
  // Claude gets the stronger note.
  fs.writeFileSync(path.join(pageDir, 'main.js'), 'a2');
  const third = fakePage();
  authenticate(session, third);
  assert.deepEqual(third.sent[0], { type: 'build-mismatch' });
  assert.ok(!third.sent.some((m) => m.type === 'server-updated'));
  assert.equal(drainWithoutArming(session).lines.filter((l) => l === BUILD_MISMATCH_NOTE).length, 1);
});

test('(135) a Session without a build check never sends build-mismatch', () => {
  const session = new Session();
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);
  assert.equal(page.sent[0].type, 'hello');
  assert.ok(!page.sent.some((m) => m.type === 'build-mismatch' || m.type === 'server-updated'));
  assert.ok(!drainWithoutArming(session).lines.includes(BUILD_MISMATCH_NOTE));
});

// A change that waits for its bar or phrase line.

/** Sends set_code-style evaluate with `at`, answers it from the fake page with a pending reply and returns the outcome. */
async function sendPendingChange(session, page, { code, label, at = 'bar', cycle = 12, seconds = 4.2 }) {
  const promise = session.evaluate(code, { label, at });
  const request = page.sent.filter((m) => m.type === 'evaluate').at(-1);
  session.handlePageMessage(page, { type: 'evaluated', id: request.id, ok: true, code, audio: 'playing', pending: { cycle, seconds } });
  return { outcome: await promise, request };
}

test('(136) the at option travels in the evaluate message, and an evaluate without it carries no at field', async () => {
  const session = new Session({ replyTimeoutMs: 200 });
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);
  const timed = session.evaluate('s("bd")', { at: 'phrase' });
  const timedRequest = page.sent.find((m) => m.type === 'evaluate');
  assert.equal(timedRequest.at, 'phrase');
  session.handlePageMessage(page, { type: 'evaluated', id: timedRequest.id, ok: true, code: 's("bd")', audio: 'playing' });
  await timed;
  const plain = session.evaluate('s("hh")');
  const plainRequest = page.sent.filter((m) => m.type === 'evaluate').at(-1);
  assert.equal('at' in plainRequest, false);
  session.handlePageMessage(page, { type: 'evaluated', id: plainRequest.id, ok: true, code: 's("hh")', audio: 'playing' });
  await plain;
});

test('(137) a pending reply stores nothing and records nothing until the takeover, which records the stored code with its label', async () => {
  const dir = tempHistoryDir();
  const session = new Session({ history: new HistoryStore({ dataDir: dir }), replyTimeoutMs: 200 });
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);
  session.handlePageMessage(page, { type: 'hand-eval', ok: true, code: 's("old")' });
  const versionsBefore = readHistoryLines(dir).filter((l) => l.type === 'version').length;
  const sentBefore = page.sent.length;

  const { outcome, request } = await sendPendingChange(session, page, { code: 's("new")', label: 'next bar change' });
  assert.deepEqual(outcome.pending, { cycle: 12, seconds: 4.2 });
  assert.equal(outcome.versionId, null);
  assert.equal(outcome.code, 's("new")');
  assert.equal(session.getCode(), 's("old")', 'get_code still answers with the code that plays');
  assert.equal(readHistoryLines(dir).filter((l) => l.type === 'version').length, versionsBefore, 'no history entry before the line');
  assert.equal(page.sent.slice(sentBefore).some((m) => m.type === 'version'), false, 'no version push before the line');

  session.handlePageMessage(page, { type: 'takeover', id: request.id });
  assert.equal(session.getCode(), 's("new")');
  const versions = readHistoryLines(dir).filter((l) => l.type === 'version');
  assert.equal(versions.length, versionsBefore + 1);
  assert.equal(versions.at(-1).code, 's("new")');
  assert.equal(versions.at(-1).label, 'next bar change');
  assert.equal(versions.at(-1).origin, 'claude');
  assert.equal(page.sent.filter((m) => m.type === 'version').length >= 1, true, 'the page hears its version id at the line');

  // A second takeover for the same id changes nothing.
  session.handlePageMessage(page, { type: 'takeover', id: request.id });
  assert.equal(readHistoryLines(dir).filter((l) => l.type === 'version').length, versionsBefore + 1);
});

test('(138) a takeover from a page that is not the active one, or for another id, changes nothing', async () => {
  const dir = tempHistoryDir();
  const session = new Session({ history: new HistoryStore({ dataDir: dir }), replyTimeoutMs: 200 });
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);
  const { request } = await sendPendingChange(session, page, { code: 's("new")', label: 'waiting' });
  const other = fakePage();
  authenticate(session, other);
  const originalError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.join(' '));
  try {
    session.handlePageMessage(page, { type: 'takeover', id: request.id });
    session.handlePageMessage(other, { type: 'takeover', id: 'not-the-id' });
  } finally {
    console.error = originalError;
  }
  assert.equal(session.getCode(), '', 'nothing took over');
  assert.equal(readHistoryLines(dir).filter((l) => l.type === 'version').length, 0);
  assert.equal(logged.length >= 1, true, 'a refused takeover is one stderr line, not silent');
});

test('(139) a waiting change keeps its label past the record intent time-to-live', async () => {
  const dir = tempHistoryDir();
  const session = new Session({ history: new HistoryStore({ dataDir: dir }), replyTimeoutMs: 200, recordIntentTtlMs: 1 });
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);
  const { request } = await sendPendingChange(session, page, { code: 's("new")', label: 'long wait' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  // Another request prunes the expired intents.
  const next = session.evaluate('s("hh")');
  const nextRequest = page.sent.filter((m) => m.type === 'evaluate').at(-1);
  session.handlePageMessage(page, { type: 'evaluated', id: nextRequest.id, ok: false, code: 's("hh")', error: 'nope' });
  await assert.rejects(() => next);
  session.handlePageMessage(page, { type: 'takeover', id: request.id });
  const versions = readHistoryLines(dir).filter((l) => l.type === 'version');
  assert.equal(versions.at(-1).label, 'long wait');
});

test('(140) detaching the active page drops the waiting change, so a later takeover is ignored', async () => {
  const dir = tempHistoryDir();
  const session = new Session({ history: new HistoryStore({ dataDir: dir }), replyTimeoutMs: 200 });
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);
  const { request } = await sendPendingChange(session, page, { code: 's("new")' });
  session.detachPage(page);
  authenticate(session, page);
  const originalError = console.error;
  console.error = () => {};
  try {
    session.handlePageMessage(page, { type: 'takeover', id: request.id });
  } finally {
    console.error = originalError;
  }
  assert.equal(session.getCode(), '');
  assert.equal(readHistoryLines(dir).filter((l) => l.type === 'version').length, 0);
});

// The lifecycle of a waiting change, the notices when it is lost, and the tempo comparison.

/** The lines of a drain that mention a change that did not take over. */
function notTakenOverLines(session) {
  return session.drainNotices().lines.filter((line) => line.includes('did not take over'));
}

/** Runs `fn` with console.error silenced and returns the lines it logged. */
function quietly(fn) {
  const originalError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.join(' '));
  try {
    fn();
  } finally {
    console.error = originalError;
  }
  return logged;
}

test('(141) phraseCycles travels in the evaluate message with at, and an evaluate without them carries neither', async () => {
  const session = new Session({ replyTimeoutMs: 200 });
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);
  const timed = session.evaluate('s("bd")', { at: 'phrase', phraseCycles: 8 });
  const timedRequest = page.sent.find((m) => m.type === 'evaluate');
  assert.equal(timedRequest.at, 'phrase');
  assert.equal(timedRequest.phraseCycles, 8);
  session.handlePageMessage(page, { type: 'evaluated', id: timedRequest.id, ok: true, code: 's("bd")', audio: 'playing' });
  await timed;
  const plain = session.evaluate('s("hh")');
  const plainRequest = page.sent.filter((m) => m.type === 'evaluate').at(-1);
  assert.equal('at' in plainRequest, false);
  assert.equal('phraseCycles' in plainRequest, false);
  session.handlePageMessage(page, { type: 'evaluated', id: plainRequest.id, ok: true, code: 's("hh")', audio: 'playing' });
  await plain;
});

test('(142) waitingChange() names the line and the timing while a change waits, and is null before and after the takeover', async () => {
  const session = new Session({ replyTimeoutMs: 200 });
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);
  assert.equal(session.waitingChange(), null);
  const { outcome, request } = await sendPendingChange(session, page, { code: 's("new")', at: 'phrase', cycle: 16 });
  assert.deepEqual(outcome.pending, { cycle: 16, seconds: 4.2 });
  assert.deepEqual(session.waitingChange(), { cycle: 16, at: 'phrase' });
  assert.equal(session.getCode(), '');
  session.handlePageMessage(page, { type: 'takeover', id: request.id });
  assert.equal(session.waitingChange(), null);
  assert.equal(session.getCode(), 's("new")');
  assert.deepEqual(notTakenOverLines(session), []);
});

test('(143) a takeover is recorded with the stored label also after the intent time-to-live', async () => {
  const dir = tempHistoryDir();
  const session = new Session({ history: new HistoryStore({ dataDir: dir }), replyTimeoutMs: 200, recordIntentTtlMs: 1 });
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);
  const { request } = await sendPendingChange(session, page, { code: 's("new")', label: 'late line' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  session.handlePageMessage(page, { type: 'takeover', id: request.id });
  assert.equal(session.getCode(), 's("new")');
  const versions = readHistoryLines(dir).filter((l) => l.type === 'version');
  assert.equal(versions.length, 1);
  assert.equal(versions[0].label, 'late line');
  assert.equal(session.waitingChange(), null);
});

test('(144) takeover-canceled stop and replaced each queue one note, once, with the cause', async () => {
  for (const [reason, fragment] of [
    ['stop', 'stopped'],
    ['replaced', 'a newer change replaced it'],
  ]) {
    const session = new Session({ replyTimeoutMs: 200 });
    session.setPageUrl(PAGE_URL);
    const page = fakePage();
    authenticate(session, page);
    const { request } = await sendPendingChange(session, page, { code: 's("new")', cycle: 12 });
    session.handlePageMessage(page, { type: 'takeover-canceled', id: request.id, reason });
    assert.equal(session.waitingChange(), null);
    const lines = notTakenOverLines(session);
    assert.equal(lines.length, 1, `one note for ${reason}`);
    assert.equal(lines[0], takeoverCanceledLine(12, reason));
    assert.ok(lines[0].includes(fragment), lines[0]);
    assert.ok(lines[0].includes('cycle 12'), lines[0]);
    assert.deepEqual(notTakenOverLines(session), [], 'the note comes once');
    assert.equal(session.getCode(), '', 'the canceled change never played');
  }
});

test('(144b) a pending reply does not claim a hand edit was replaced; the takeover tells it once, and a canceled change never does', async () => {
  const session = new Session({ replyTimeoutMs: 200 });
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);
  session.handlePageMessage(page, { type: 'hand-eval', ok: true, code: 's("hand")' });
  assert.equal(session.wasEditedByHand(), true);

  const waiting = await sendPendingChange(session, page, { code: 's("new")', cycle: 12 });
  assert.equal(waiting.outcome.replacedHandEdit, false, 'nothing is replaced at the request');
  assert.equal(session.wasEditedByHand(), true, 'the hand edit still plays');
  session.handlePageMessage(page, { type: 'takeover', id: waiting.request.id });
  assert.equal(session.wasEditedByHand(), false);
  const told = session.drainNotices().lines.filter((line) => line.includes('edited by hand'));
  assert.deepEqual(told, [takeoverReplacedHandEditLine(12)]);
  assert.deepEqual(session.drainNotices().lines.filter((line) => line.includes('edited by hand')), [], 'once');

  // A canceled change replaces nothing: the hand edit stays and no note is queued.
  const other = new Session({ replyTimeoutMs: 200 });
  other.setPageUrl(PAGE_URL);
  const otherPage = fakePage();
  authenticate(other, otherPage);
  other.handlePageMessage(otherPage, { type: 'hand-eval', ok: true, code: 's("hand")' });
  const canceled = await sendPendingChange(other, otherPage, { code: 's("new")', cycle: 9 });
  other.handlePageMessage(otherPage, { type: 'takeover-canceled', id: canceled.request.id, reason: 'replaced' });
  assert.equal(other.wasEditedByHand(), true);
  assert.deepEqual(other.drainNotices().lines.filter((line) => line.includes('edited by hand')), []);
});

test('(145) takeover-canceled for another id, or from a page that is not active, changes nothing and queues no note', async () => {
  const session = new Session({ replyTimeoutMs: 200 });
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);
  const { request } = await sendPendingChange(session, page, { code: 's("new")' });
  const logged = quietly(() => {
    session.handlePageMessage(page, { type: 'takeover-canceled', id: 'not-the-id', reason: 'stop' });
    const stranger = fakePage();
    session.handlePageMessage(stranger, { type: 'takeover-canceled', id: request.id, reason: 'stop' });
  });
  assert.equal(logged.length >= 1, true, 'a refused cancel is a stderr line, not silent');
  assert.notEqual(session.waitingChange(), null, 'the change still waits');
  assert.deepEqual(notTakenOverLines(session), []);
  // The change still takes over when its line comes.
  session.handlePageMessage(page, { type: 'takeover', id: request.id });
  assert.equal(session.getCode(), 's("new")');
});

test('(146) a stop the server confirms clears a waiting change, and the page cancel that follows adds nothing', async () => {
  // A stop-result for a stop request.
  const session = new Session({ replyTimeoutMs: 200 });
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);
  const { request } = await sendPendingChange(session, page, { code: 's("new")', cycle: 9 });
  const stopped = session.stop();
  const stopRequest = page.sent.filter((m) => m.type === 'stop').at(-1);
  session.handlePageMessage(page, { type: 'stop-result', id: stopRequest.id });
  await stopped;
  assert.equal(session.waitingChange(), null);
  quietly(() => session.handlePageMessage(page, { type: 'takeover-canceled', id: request.id, reason: 'stop' }));
  const lines = notTakenOverLines(session);
  assert.equal(lines.length, 1);
  assert.equal(lines[0], takeoverCanceledLine(9, 'stop'));
  assert.ok(lines[0].includes('did not take over'), lines[0]);

  // A user-stopped report, with the page cancel arriving after it (any order gives one line).
  const second = new Session({ replyTimeoutMs: 200 });
  second.setPageUrl(PAGE_URL);
  const page2 = fakePage();
  authenticate(second, page2);
  const waiting = await sendPendingChange(second, page2, { code: 's("again")', cycle: 5 });
  second.handlePageMessage(page2, { type: 'user-stopped' });
  quietly(() => second.handlePageMessage(page2, { type: 'takeover-canceled', id: waiting.request.id, reason: 'stop' }));
  assert.equal(notTakenOverLines(second).length, 1);
});

test('(147) a newer pending change replaces the waiting one without a note of its own', async () => {
  const session = new Session({ replyTimeoutMs: 200 });
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);
  const first = await sendPendingChange(session, page, { code: 's("one")', cycle: 10 });
  let second;
  const originalError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.join(' '));
  try {
    second = await sendPendingChange(session, page, { code: 's("two")', cycle: 11 });
  } finally {
    console.error = originalError;
  }
  assert.equal(logged.length, 1, 'one stderr line for the replacement');
  assert.deepEqual(session.waitingChange(), { cycle: 11, at: 'bar' });
  assert.deepEqual(notTakenOverLines(session), []);
  // The takeover of the replaced change is ignored; the newer one plays.
  quietly(() => session.handlePageMessage(page, { type: 'takeover', id: first.request.id }));
  assert.equal(session.getCode(), '');
  session.handlePageMessage(page, { type: 'takeover', id: second.request.id });
  assert.equal(session.getCode(), 's("two")');
});

test('(148) a page that goes away, or another page taking the role, loses the waiting change with one note', async () => {
  const detached = new Session({ replyTimeoutMs: 200 });
  detached.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(detached, page);
  await sendPendingChange(detached, page, { code: 's("new")', cycle: 7 });
  detached.detachPage(page);
  const lines = notTakenOverLines(detached);
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes('closed, reloaded or replaced by another tab'), lines[0]);
  assert.equal(lines[0], takeoverCanceledLine(7, 'page'));
  assert.ok(lines[0].includes('did not take over'), lines[0]);

  const replaced = new Session({ replyTimeoutMs: 200 });
  replaced.setPageUrl(PAGE_URL);
  const first = fakePage();
  authenticate(replaced, first);
  await sendPendingChange(replaced, first, { code: 's("new")', cycle: 8 });
  const second = fakePage();
  authenticate(replaced, second);
  assert.equal(replaced.waitingChange(), null);
  // The old page closing afterwards adds nothing: the two causes meet in one line.
  replaced.detachPage(first);
  assert.equal(notTakenOverLines(replaced).length, 1);

  const both = new Session({ replyTimeoutMs: 200 });
  both.setPageUrl(PAGE_URL);
  const a = fakePage();
  authenticate(both, a);
  await sendPendingChange(both, a, { code: 's("new")', cycle: 8 });
  both.detachPage(a);
  authenticate(both, fakePage());
  assert.equal(notTakenOverLines(both).length, 1);
});

test('(149) BPM: the tempo is told on the first reply and when its rounded value changes, never when it is the same', async () => {
  const session = new Session({ replyTimeoutMs: 200 });
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);
  async function change(code, bpm) {
    const promise = session.evaluate(code);
    const request = page.sent.filter((m) => m.type === 'evaluate').at(-1);
    const reply = { type: 'evaluated', id: request.id, ok: true, code, audio: 'playing' };
    if (bpm !== undefined) reply.bpm = bpm;
    session.handlePageMessage(page, reply);
    return promise;
  }
  const first = await change('s("a")', 120);
  assert.equal(first.bpm, 120);
  assert.equal(first.tempoChanged, true);
  const same = await change('s("b")', 120.04);
  assert.equal(same.bpm, 120);
  assert.equal(same.tempoChanged, false);
  const changed = await change('s("c")', 96.66);
  assert.equal(changed.bpm, 96.7);
  assert.equal(changed.tempoChanged, true);
  const none = await change('s("d")', undefined);
  assert.equal(none.bpm, null);
  assert.equal(none.tempoChanged, false);
  // The last told tempo survived the reply without one.
  const again = await change('s("e")', 96.7);
  assert.equal(again.tempoChanged, false);
});

test('(150) BPM: a pending reply carries the tempo from the line and compares it like any other', async () => {
  const session = new Session({ replyTimeoutMs: 200 });
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);
  const promise = session.evaluate('s("new")', { at: 'bar' });
  const request = page.sent.filter((m) => m.type === 'evaluate').at(-1);
  session.handlePageMessage(page, {
    type: 'evaluated',
    id: request.id,
    ok: true,
    code: 's("new")',
    audio: 'playing',
    pending: { cycle: 12, seconds: 4 },
    bpm: 96,
  });
  const outcome = await promise;
  assert.equal(outcome.bpm, 96);
  assert.equal(outcome.tempoChanged, true);
  assert.deepEqual(outcome.pending, { cycle: 12, seconds: 4 });
});

test('(151) data folder: an authenticated page that asks gets the data folder as its last frame, and a page that never asks gets none', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moontide-session-folder-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const session = new Session({ rig: new RigStore({ dataDir: dir }) });
  session.setPageUrl(PAGE_URL);
  const silent = fakePage();
  authenticate(session, silent);
  assert.deepEqual(
    silent.sent.filter((frame) => frame.type === 'data-folder'),
    [],
    'the folder is never sent unasked',
  );

  const page = fakePage();
  authenticate(session, page);
  session.handlePageMessage(page, { type: 'data-folder-request' });
  assert.deepEqual(page.sent.at(-1), { type: 'data-folder', path: dir });
  // The first page is trusted but is no longer the active one: read-only, so it is answered too.
  session.handlePageMessage(silent, { type: 'data-folder-request' });
  assert.deepEqual(silent.sent.at(-1), { type: 'data-folder', path: dir });
});

test('(152) data folder: with no setup store the answer is path null', () => {
  const session = new Session();
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);
  session.handlePageMessage(page, { type: 'data-folder-request' });
  assert.deepEqual(page.sent.at(-1), { type: 'data-folder', path: null });
});

test('(153) data folder: a data folder that cannot be resolved gives path null and exactly one log line that names no path', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moontide-session-folder-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let asked = false;
  const rig = new RigStore({
    dataDir: () => {
      if (!asked) return dir;
      throw new Error(`cannot resolve ${dir}`);
    },
  });
  const session = new Session({ rig });
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);
  asked = true;
  const logged = captureErrors(() => session.handlePageMessage(page, { type: 'data-folder-request' }));
  assert.deepEqual(page.sent.at(-1), { type: 'data-folder', path: null });
  assert.equal(logged.length, 1, logged.join('\n'));
  assert.ok(!logged[0].includes(dir), 'the log line never holds the folder');
});

test('(154) data folder: a folder with a control character, or longer than 1024 characters, gives path null and is never logged or cut', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'moontide-session-folder-test-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const withControl = `${base}${path.sep}bell\u0007folder`;
  const exactly1024 = base + path.sep + 'a'.repeat(1024 - base.length - 1);
  const tooLong = base + path.sep + 'a'.repeat(1025 - base.length - 1);
  assert.equal(exactly1024.length, 1024);
  assert.equal(tooLong.length, 1025);
  for (const [what, folder, expected] of [
    ['control character', withControl, null],
    ['1025 characters', tooLong, null],
    ['1024 characters', exactly1024, exactly1024],
  ]) {
    const session = new Session({ rig: new RigStore({ dataDir: folder }) });
    session.setPageUrl(PAGE_URL);
    const page = fakePage();
    authenticate(session, page);
    const logged = captureErrors(() => session.handlePageMessage(page, { type: 'data-folder-request' }));
    assert.deepEqual(page.sent.at(-1), { type: 'data-folder', path: expected }, what);
    assert.equal(logged.length, expected === null ? 1 : 0, `${what}: ${logged.join('\n')}`);
    assert.ok(!logged.some((line) => line.includes(base)), `${what}: the log never holds the folder`);
  }
});

test('(155) data folder: a connection that did not present the token gets no data-folder frame and one log line by type', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moontide-session-folder-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const session = new Session({ rig: new RigStore({ dataDir: dir }) });
  session.setPageUrl(PAGE_URL);
  const stranger = fakePage();
  const logged = captureErrors(() => session.handlePageMessage(stranger, { type: 'data-folder-request' }));
  assert.deepEqual(stranger.sent, []);
  assert.equal(logged.length, 1, logged.join('\n'));
  assert.ok(logged[0].includes('(data-folder-request)'), logged[0]);
  assert.ok(!logged[0].includes(dir));
});
