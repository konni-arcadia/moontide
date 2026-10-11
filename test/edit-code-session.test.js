import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  Session,
  editRefusedMessage,
  evalFailedMessage,
  STILL_PLAYING_TAIL,
  takeoverCanceledLine,
  takeoverReplacedHandEditLine,
  baseMovedMessage,
  baseUnknownMessage,
  EDIT_IN_FLIGHT_MESSAGE,
} from '../dist/session.js';
import { HistoryStore } from '../dist/history.js';
import { ARMING_LINE_PREFIX } from './helpers.js';

// Session.editCode with a fake page connection.
const PAGE_URL = 'http://localhost:5757';
const A = 'a: s("bd")\nb: s("hh")';
const HAND_LINE = 'c: s("cp")';

// The helpers below are copies of the file-local ones in test/session.test.js (they are not exported there).

function tempHistoryDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'moontide-edit-code-session-test-'));
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
  const at = Array.isArray(page.sent) ? page.sent.length : null;
  session.handlePageMessage(page, { type: 'page-auth', token: session.ask.pageToken });
  if (at !== null) {
    assert.deepEqual(page.sent[at], { type: 'ask-auth', ok: true });
    assert.deepEqual(page.sent.at(-1), { type: 'page-requests', live: false });
    page.sent.pop();
    page.sent.splice(at, 1);
  }
}

function drainWithoutArming(session) {
  const drained = session.drainNotices();
  const arming = drained.lines.pop();
  assert.ok(arming !== undefined && arming.startsWith(ARMING_LINE_PREFIX), `expected the arming line last, got: ${arming}`);
  return drained;
}

/** A started session with an authenticated fake page; `store` adds a history store in a temp dir. */
function start({ store = true } = {}) {
  const dir = tempHistoryDir();
  const session = new Session({ ...(store ? { history: new HistoryStore({ dataDir: dir }) } : {}), replyTimeoutMs: 200 });
  session.setPageUrl(PAGE_URL);
  const page = fakePage();
  authenticate(session, page);
  return { session, page, dir };
}

const evaluates = (page) => page.sent.filter((m) => m.type === 'evaluate');

/** Answers the last evaluate sent to the page as the page would. `extra` carries `pending: { cycle, seconds }`. */
function answerLast(session, page, extra = {}) {
  const request = evaluates(page).at(-1);
  session.handlePageMessage(page, { type: 'evaluated', id: request.id, ok: true, code: request.code, audio: 'playing', ...extra });
  return request;
}

/** set_code for `code`, answered at once. */
async function play(session, page, code) {
  const promise = session.evaluate(code);
  answerLast(session, page);
  return promise;
}

/** A timed set_code answered pending; returns the request. */
async function sendPending(session, page, code, { at = 'bar', cycle = 12, seconds = 4.2 } = {}) {
  const promise = session.evaluate(code, { at });
  const request = answerLast(session, page, { pending: { cycle, seconds } });
  await promise;
  return request;
}

/** editCode answered at once (or pending with `extra`). */
async function edit(session, page, edits, options, extra = {}) {
  const promise = session.editCode(edits, options);
  const request = answerLast(session, page, extra);
  return { result: await promise, request };
}

const swap = (from, to) => [{ old_string: from, new_string: to }];

test('playing base: an edit of confirmed code sends that code edited, base playing, no hand edit carried', async () => {
  const { session, page } = start();
  await play(session, page, A);
  const before = evaluates(page).length;
  const { result } = await edit(session, page, swap('hh', 'oh'));
  assert.equal(evaluates(page).length, before + 1, 'exactly one evaluate');
  assert.equal(evaluates(page).at(-1).code, 'a: s("bd")\nb: s("oh")');
  assert.deepEqual(result.base, { kind: 'playing', versionId: 1 });
  assert.equal(result.carriesHandEdit, false);
  assert.equal(session.getCode(), 'a: s("bd")\nb: s("oh")');
});

test('hand-edited base: the hand line is kept, carriesHandEdit is true, and the edit clears the hand-edit flag', async () => {
  const { session, page } = start();
  await play(session, page, A);
  const handCode = `${A}\n${HAND_LINE}`;
  session.handlePageMessage(page, { type: 'hand-eval', ok: true, code: handCode });
  assert.equal(session.wasEditedByHand(), true);
  const { result } = await edit(session, page, swap('hh', 'oh'));
  assert.equal(evaluates(page).at(-1).code, `a: s("bd")\nb: s("oh")\n${HAND_LINE}`);
  assert.equal(result.carriesHandEdit, true);
  assert.equal(result.outcome.replacedHandEdit, true);
  assert.equal(session.wasEditedByHand(), false);
});

test('waiting base: the edit applies to the waiting change, not to get_code', async () => {
  const { session, page } = start();
  await play(session, page, A);
  const W = 'a: s("bd")\nb: s("oh")';
  const waiting = await sendPending(session, page, W, { cycle: 12 });
  const promise = session.editCode(swap('bd', 'sd'));
  assert.equal(evaluates(page).at(-1).code, 'a: s("sd")\nb: s("oh")');
  // The page cancels the waiting change before it answers the newer one.
  session.handlePageMessage(page, { type: 'takeover-canceled', id: waiting.id, reason: 'replaced' });
  answerLast(session, page);
  const result = await promise;
  assert.deepEqual(result.base, { kind: 'waiting', cycle: 12, at: 'bar' });
  assert.equal(result.carriesHandEdit, false);
});

test('waiting base: getCode keeps returning the playing code while the change waits', async () => {
  const { session, page } = start();
  await play(session, page, A);
  await sendPending(session, page, 'a: s("bd")\nb: s("oh")', { cycle: 12 });
  const promise = session.editCode(swap('bd', 'sd'), { at: 'bar' });
  answerLast(session, page, { pending: { cycle: 12, seconds: 4 } });
  const result = await promise;
  assert.equal(result.base.kind, 'waiting');
  assert.equal(session.getCode(), A, 'get_code still returns the playing code');
});

test('refusal while waiting names the waiting change and sends nothing', async () => {
  const { session, page } = start();
  await play(session, page, A);
  await sendPending(session, page, 'a: s("bd")\nb: s("oh")', { cycle: 12 });
  const before = evaluates(page).length;
  const where =
    'the change waiting for cycle 12 (next bar), which get_code does not show: it returns the code playing until then';
  await assert.rejects(session.editCode(swap('hh', 'cp')), (err) => {
    assert.ok(err.message.startsWith(editRefusedMessage(where, [])), err.message);
    assert.ok(err.message.includes('matches nowhere'), err.message);
    return true;
  });
  assert.equal(evaluates(page).length, before, 'nothing was sent');
  assert.equal(session.waitingChange().cycle, 12, 'the waiting change is untouched');
});

test('after the wait is canceled by Stop, the next edit applies to the playing code again', async () => {
  const { session, page } = start();
  await play(session, page, A);
  const waiting = await sendPending(session, page, 'a: s("bd")\nb: s("oh")', { cycle: 12 });
  session.handlePageMessage(page, { type: 'takeover-canceled', id: waiting.id, reason: 'stop' });
  assert.equal(session.waitingChange(), null);
  const { result } = await edit(session, page, swap('hh', 'cp'));
  assert.equal(evaluates(page).at(-1).code, 'a: s("bd")\nb: s("cp")');
  assert.equal(result.base.kind, 'playing');
});

test('base version: equal applies, different is refused with both versions, nothing is sent', async () => {
  const { session, page } = start();
  await play(session, page, A);
  assert.equal(session.getCurrentVersionId(), 1);
  const { result } = await edit(session, page, swap('hh', 'oh'), { base: 1 });
  assert.equal(result.outcome.versionId, 2);
  const before = evaluates(page).length;
  await assert.rejects(session.editCode(swap('oh', 'cp'), { base: 1 }), (err) => {
    assert.equal(err.message, baseMovedMessage(1, 2));
    assert.ok(err.message.includes('#1') && err.message.includes('#2'));
    return true;
  });
  assert.equal(evaluates(page).length, before);
  assert.equal(session.getCode(), 'a: s("bd")\nb: s("oh")');
  assert.equal(session.getCurrentVersionId(), 2);
});

test('base version without a store: a given base is refused as unknown, an omitted base applies', async () => {
  const { session, page } = start({ store: false });
  await play(session, page, A);
  const before = evaluates(page).length;
  await assert.rejects(session.editCode(swap('hh', 'oh'), { base: 5 }), (err) => {
    assert.equal(err.message, baseUnknownMessage(5));
    return true;
  });
  assert.equal(evaluates(page).length, before);
  const { result } = await edit(session, page, swap('hh', 'oh'));
  assert.equal(result.outcome.code, 'a: s("bd")\nb: s("oh")');
});

test('base version while a change waits is compared to the version playing now', async () => {
  const { session, page } = start();
  await play(session, page, A);
  await sendPending(session, page, 'a: s("bd")\nb: s("oh")', { cycle: 12 });
  const before = evaluates(page).length;
  await assert.rejects(session.editCode(swap('bd', 'sd'), { base: 2 }), (err) => {
    assert.equal(err.message, baseMovedMessage(2, 1));
    return true;
  });
  assert.equal(evaluates(page).length, before);
  assert.equal(session.waitingChange().cycle, 12);
  const promise = session.editCode(swap('bd', 'sd'), { base: 1 });
  assert.equal(evaluates(page).length, before + 1, 'base equal to the playing version applies');
  answerLast(session, page);
  await promise;
});

test('a timed edit on a hand-edited base takes over without the "replaced a hand edit" note', async () => {
  const { session, page } = start();
  await play(session, page, A);
  session.handlePageMessage(page, { type: 'hand-eval', ok: true, code: `${A}\n${HAND_LINE}` });
  const { result, request } = await edit(session, page, swap('hh', 'oh'), { at: 'bar' }, { pending: { cycle: 16, seconds: 6 } });
  assert.equal(result.carriesHandEdit, true);
  assert.equal(result.outcome.replacedHandEdit, false);
  session.handlePageMessage(page, { type: 'takeover', id: request.id });
  const lines = drainWithoutArming(session).lines;
  assert.ok(!lines.includes(takeoverReplacedHandEditLine(16)), lines.join('\n'));
  assert.equal(session.getCode(), `a: s("bd")\nb: s("oh")\n${HAND_LINE}`);
  assert.equal(session.wasEditedByHand(), false);
});

test('a timed set_code on a hand-edited base, edited while it waits, still gets the "replaced" note', async () => {
  const { session, page } = start();
  await play(session, page, A);
  session.handlePageMessage(page, { type: 'hand-eval', ok: true, code: `${A}\n${HAND_LINE}` });
  const first = await sendPending(session, page, 'a: s("bd")\nb: s("oh")', { cycle: 12 });
  const promise = session.editCode(swap('bd', 'sd'), { at: 'bar' });
  session.handlePageMessage(page, { type: 'takeover-canceled', id: first.id, reason: 'replaced' });
  const request = answerLast(session, page, { pending: { cycle: 12, seconds: 4 } });
  const result = await promise;
  assert.equal(result.carriesHandEdit, false);
  session.handlePageMessage(page, { type: 'takeover', id: request.id });
  const lines = drainWithoutArming(session).lines;
  assert.ok(lines.includes(takeoverCanceledLine(12, 'replaced')), lines.join('\n'));
  assert.ok(lines.includes(takeoverReplacedHandEditLine(12)), lines.join('\n'));
});

test('history: one Claude entry per successful edit, none for a refusal, a timed edit at its takeover only', async () => {
  const { session, page, dir } = start();
  await play(session, page, A);
  const versions = () => readHistoryLines(dir).filter((l) => l.type === 'version');
  const before = versions().length;
  await edit(session, page, swap('hh', 'oh'), { label: 'one value' });
  assert.equal(versions().length, before + 1);
  assert.equal(versions().at(-1).origin, 'claude');
  assert.equal(versions().at(-1).label, 'one value');

  await assert.rejects(session.editCode(swap('nope', 'x'), { label: 'refused' }));
  assert.equal(versions().length, before + 1, 'a refusal records nothing');

  const { request } = await edit(session, page, swap('oh', 'cp'), { at: 'bar', label: 'timed' }, { pending: { cycle: 12, seconds: 4 } });
  assert.equal(versions().length, before + 1, 'nothing recorded while the change waits');
  session.handlePageMessage(page, { type: 'takeover', id: request.id });
  assert.equal(versions().length, before + 2);
  assert.equal(versions().at(-1).label, 'timed');
  assert.equal(versions().at(-1).origin, 'claude');
});

test('timing travels in the evaluate message, and an evaluation failure rejects and leaves the code', async () => {
  const { session, page } = start();
  await play(session, page, A);
  const promise = session.editCode(swap('hh', 'oh'), { at: 'phrase', phraseCycles: 8 });
  const request = evaluates(page).at(-1);
  assert.equal(request.at, 'phrase');
  assert.equal(request.phraseCycles, 8);
  session.handlePageMessage(page, { type: 'evaluated', id: request.id, ok: false, error: 'boom', line: 2 });
  await assert.rejects(promise, (err) => {
    assert.equal(err.message, evalFailedMessage('boom', 2, STILL_PLAYING_TAIL));
    return true;
  });
  assert.equal(session.getCode(), A);
});

test('an edit while another change is still reaching the page is refused loudly, so no edit is lost', async () => {
  const { session, page } = start();
  await play(session, page, A);
  const first = session.editCode(swap('bd', 'sd'));
  const before = evaluates(page).length;
  // The first reply has not come yet: a second edit would be composed on the old code and silently drop the first.
  await assert.rejects(session.editCode(swap('hh', 'oh')), (err) => {
    assert.equal(err.message, EDIT_IN_FLIGHT_MESSAGE);
    return true;
  });
  assert.equal(evaluates(page).length, before, 'nothing was sent for the refused edit');
  answerLast(session, page);
  await first;
  assert.equal(session.getCode(), 'a: s("sd")\nb: s("hh")');
  // Once the reply is in, the retry builds on the first edit.
  const { result } = await edit(session, page, swap('hh', 'oh'));
  assert.equal(result.outcome.code, 'a: s("sd")\nb: s("oh")');
});

test('an edit right after a set_code that is still reaching the page is refused too', async () => {
  const { session, page } = start();
  await play(session, page, A);
  const B = 'a: s("sd")\nb: s("cp")';
  const setCode = session.evaluate(B);
  await assert.rejects(session.editCode(swap('cp', 'oh')), (err) => {
    assert.equal(err.message, EDIT_IN_FLIGHT_MESSAGE);
    return true;
  });
  answerLast(session, page);
  await setCode;
  assert.equal(session.getCode(), B);
});

test('the in-flight refusal ends when the first change gets no reply in time', async () => {
  const { session, page } = start();
  await play(session, page, A);
  const first = session.editCode(swap('bd', 'sd'));
  await assert.rejects(session.editCode(swap('hh', 'oh')), (err) => err.message === EDIT_IN_FLIGHT_MESSAGE);
  // Nobody answers: the reply timeout rejects the first edit and clears its pending request.
  await assert.rejects(first);
  const { result } = await edit(session, page, swap('hh', 'oh'));
  assert.equal(result.outcome.code, 'a: s("bd")\nb: s("oh")');
});

test('the in-flight refusal ends when the first change is answered as failed', async () => {
  const { session, page } = start();
  await play(session, page, A);
  const first = session.editCode(swap('bd', 'sd'));
  await assert.rejects(session.editCode(swap('hh', 'oh')), (err) => err.message === EDIT_IN_FLIGHT_MESSAGE);
  const request = evaluates(page).at(-1);
  session.handlePageMessage(page, { type: 'evaluated', id: request.id, ok: false, error: 'boom', line: 1 });
  await assert.rejects(first);
  const { result } = await edit(session, page, swap('hh', 'oh'));
  assert.equal(result.outcome.code, 'a: s("bd")\nb: s("oh")');
});
