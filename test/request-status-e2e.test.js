// The request status board through a real server: a fake page sends requests, a real MCP client
// plays Claude, and the page must receive exactly the ask-status frames that are true. The fake page
// answers each evaluate by itself. Every expected string is built from dist exports, never from a
// token or a path written here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { startMcpClient, createFakePage, connectPage, connectListener, listenerCommandFrom, nextMessage } from './helpers.js';
import { cleanErrorDetail } from '../dist/session.js';
import * as mcpModule from '../dist/mcp.js';
import * as boardModule from '../dist/request-status.js';
import * as protocolModule from '../dist/protocol.js';

const { UNKNOWN_ANSWERING_NOTE } = mcpModule;

const CODE = 'lead: s("bd")';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A real server, one fake page that answers every evaluate with success, and a collector of what it receives. */
async function startScenario(t) {
  const started = await startMcpClient();
  const { client, port, dataDir } = started;
  const page = await createFakePage(port);
  t.after(async () => {
    page.ws.close();
    await client.close();
  });
  const evaluates = [];
  const frames = [];
  // An independent listener: the fake page's own relay swallows what it does not handle.
  page.ws.on('message', (data) => frames.push(JSON.parse(data.toString())));
  page.setResponder((msg) => {
    evaluates.push(msg);
    return { type: 'evaluated', id: msg.id, ok: true, code: msg.code, audio: 'playing' };
  });
  page.setStopResponder((msg) => ({ type: 'stop-result', id: msg.id, ok: true }));
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    return result;
  };
  const textOf = (result) => result.content.map((part) => part.text).join('\n');
  const statuses = (id) => frames.filter((m) => m.type === 'ask-status' && m.id === id);
  const waitFor = async (predicate, what, timeoutMs = 3000) => {
    const start = Date.now();
    while (!predicate()) {
      if (Date.now() - start > timeoutMs) {
        throw new Error(`Timed out waiting for ${what}; got ${JSON.stringify(frames)}`);
      }
      await sleep(10);
    }
  };
  const ask = (id, text = 'a request') => {
    page.send({ type: 'ask', id, text, context: { kind: 'session' }, chip: 'Whole session', current: null });
  };
  /** A beat for frames that must NOT arrive. */
  const settle = () => sleep(150);
  return { client, port, dataDir, started, page, evaluates, frames, call, textOf, statuses, waitFor, ask, settle };
}

/** The newest version id list_history shows. */
async function newestVersion(s) {
  const text = s.textOf(await s.call('list_history'));
  const match = /#(\d+)/.exec(text);
  assert.ok(match, `no version id in: ${text}`);
  return Number(match[1]);
}

test('a request is marked started by the next call and applied by a set_code that names it', async (t) => {
  const s = await startScenario(t);
  await s.call('set_code', { code: CODE });
  s.frames.length = 0;

  s.ask('req-a');
  await s.waitFor(() => s.frames.some((m) => m.type === 'ask-result' && m.id === 'req-a'), 'ask-result');
  assert.deepEqual(
    s.frames.filter((m) => m.type === 'ask-result' && m.id === 'req-a'),
    [{ type: 'ask-result', id: 'req-a', status: 'waiting', waiting: 1 }],
  );

  // The call that hands the request over does not mark it started.
  const got = await s.call('get_code');
  assert.ok(s.textOf(got).includes('"id":"req-a"'), 'the reply carries the request line');
  await s.waitFor(() => s.frames.some((m) => m.type === 'ask-received'), 'ask-received');
  assert.deepEqual(s.frames.filter((m) => m.type === 'ask-received'), [{ type: 'ask-received', ids: ['req-a'] }]);
  await s.settle();
  assert.deepEqual(s.statuses('req-a'), []);

  // The next call does.
  await s.call('list_history');
  await s.waitFor(() => s.statuses('req-a').length > 0, 'ask-status started');
  await s.settle();
  assert.deepEqual(s.statuses('req-a'), [{ type: 'ask-status', id: 'req-a', state: 'started' }]);

  const changed = await s.call('set_code', { code: 'lead: s("sd")', answering: 'req-a' });
  assert.ok(!changed.isError, s.textOf(changed));
  await s.waitFor(() => s.statuses('req-a').length > 1, 'ask-status applied');
  const version = await newestVersion(s);
  assert.deepEqual(s.statuses('req-a').at(-1), { type: 'ask-status', id: 'req-a', state: 'applied', version });

  // A final state is never followed by another message.
  const before = s.statuses('req-a').length;
  await s.call('list_history');
  await s.settle();
  assert.equal(s.statuses('req-a').length, before);
});

// ---- Every other path a change that names a request can take ----

const okReply = (msg, extra = {}) => ({ type: 'evaluated', id: msg.id, ok: true, code: msg.code, audio: 'playing', ...extra });
const waitsForBar = { cycle: 12, seconds: 3 };

/** A request the page sent and Claude received (a get_code reply carried its line). */
async function receiveRequest(s, id) {
  s.ask(id);
  await s.waitFor(() => s.frames.some((m) => m.type === 'ask-result' && m.id === id), `ask-result for ${id}`);
  const reply = await s.call('get_code');
  assert.ok(s.textOf(reply).includes(`"id":"${id}"`), 'the reply carries the request line');
}

const statesOf = (s, id) => s.statuses(id).map((m) => m.state);

test('a change that waits for its bar says line with its timing, then applied at its takeover', async (t) => {
  const s = await startScenario(t);
  await s.call('set_code', { code: CODE });
  await receiveRequest(s, 'req-b');
  s.page.setResponder((msg) => {
    s.evaluates.push(msg);
    return okReply(msg, { pending: waitsForBar });
  });
  const waiting = await s.call('set_code', { code: 'lead: s("sd")', at: 'bar', answering: 'req-b' });
  assert.ok(!waiting.isError, s.textOf(waiting));
  await s.waitFor(() => statesOf(s, 'req-b').includes('line'), 'line');
  assert.deepEqual(s.statuses('req-b').at(-1), { type: 'ask-status', id: 'req-b', state: 'line', at: 'bar' });

  s.page.send({ type: 'takeover', id: s.evaluates.at(-1).id });
  await s.waitFor(() => statesOf(s, 'req-b').includes('applied'), 'applied');
  const version = await newestVersion(s);
  assert.deepEqual(s.statuses('req-b').at(-1), { type: 'ask-status', id: 'req-b', state: 'applied', version });
  assert.deepEqual(statesOf(s, 'req-b'), ['started', 'line', 'applied']);
});

test('a phrase change says line with at phrase', async (t) => {
  const s = await startScenario(t);
  await s.call('set_code', { code: CODE });
  await receiveRequest(s, 'req-p');
  s.page.setResponder((msg) => {
    s.evaluates.push(msg);
    return okReply(msg, { pending: { cycle: 16, seconds: 8 } });
  });
  await s.call('set_code', { code: 'lead: s("sd")', at: 'phrase', answering: 'req-p' });
  await s.waitFor(() => statesOf(s, 'req-p').includes('line'), 'line');
  assert.deepEqual(s.statuses('req-p').at(-1), { type: 'ask-status', id: 'req-p', state: 'line', at: 'phrase' });
});

test('a waiting change that a newer change without the id replaces says replaced, never applied', async (t) => {
  const s = await startScenario(t);
  await s.call('set_code', { code: CODE });
  await receiveRequest(s, 'req-c');
  s.page.setResponder((msg) => {
    s.evaluates.push(msg);
    return okReply(msg, { pending: waitsForBar });
  });
  await s.call('set_code', { code: 'lead: s("sd")', at: 'bar', answering: 'req-c' });
  await s.waitFor(() => statesOf(s, 'req-c').includes('line'), 'line');
  const waitingId = s.evaluates.at(-1).id;

  s.page.setResponder((msg) => {
    s.evaluates.push(msg);
    return [{ type: 'takeover-canceled', id: waitingId, reason: 'replaced' }, okReply(msg)];
  });
  await s.call('set_code', { code: 'lead: s("cp")' });
  await s.waitFor(() => statesOf(s, 'req-c').includes('replaced'), 'replaced');
  await s.settle();
  assert.deepEqual(statesOf(s, 'req-c'), ['started', 'line', 'replaced']);
});

test('a newer change that answers the same request keeps it on line until that change settles', async (t) => {
  const s = await startScenario(t);
  await s.call('set_code', { code: CODE });
  await receiveRequest(s, 'req-d');
  s.page.setResponder((msg) => {
    s.evaluates.push(msg);
    return okReply(msg, { pending: waitsForBar });
  });
  await s.call('set_code', { code: 'lead: s("sd")', at: 'bar', answering: 'req-d' });
  await s.waitFor(() => statesOf(s, 'req-d').includes('line'), 'line');
  const waitingId = s.evaluates.at(-1).id;

  s.page.setResponder((msg) => {
    s.evaluates.push(msg);
    return [{ type: 'takeover-canceled', id: waitingId, reason: 'replaced' }, okReply(msg)];
  });
  await s.call('set_code', { code: 'lead: s("cp")', answering: 'req-d' });
  await s.waitFor(() => statesOf(s, 'req-d').includes('applied'), 'applied');
  await s.settle();
  const version = await newestVersion(s);
  assert.deepEqual(statesOf(s, 'req-d'), ['started', 'line', 'applied']);
  assert.equal(s.statuses('req-d').at(-1).version, version, 'applied carries the newer change version');
});

test('a waiting change that Stop cancels says canceled', async (t) => {
  const s = await startScenario(t);
  await s.call('set_code', { code: CODE });
  await receiveRequest(s, 'req-e');
  s.page.setResponder((msg) => {
    s.evaluates.push(msg);
    return okReply(msg, { pending: waitsForBar });
  });
  await s.call('set_code', { code: 'lead: s("sd")', at: 'bar', answering: 'req-e' });
  await s.waitFor(() => statesOf(s, 'req-e').includes('line'), 'line');
  const waitingId = s.evaluates.at(-1).id;

  s.page.setStopResponder((msg) => [
    { type: 'takeover-canceled', id: waitingId, reason: 'stop' },
    { type: 'stop-result', id: msg.id, ok: true },
  ]);
  const stopped = await s.call('stop');
  assert.ok(!stopped.isError, s.textOf(stopped));
  await s.waitFor(() => statesOf(s, 'req-e').includes('canceled'), 'canceled');
  await s.settle();
  assert.deepEqual(statesOf(s, 'req-e'), ['started', 'line', 'canceled']);
});

test('a change whose evaluation fails says failed with the cleaned reason', async (t) => {
  const s = await startScenario(t);
  await s.call('set_code', { code: CODE });
  await receiveRequest(s, 'req-f');
  const error = 'Unexpected token.';
  s.page.setResponder((msg) => {
    s.evaluates.push(msg);
    return { type: 'evaluated', id: msg.id, ok: false, code: msg.code, error, line: 2 };
  });
  const failed = await s.call('set_code', { code: 'lead: s(', answering: 'req-f' });
  assert.equal(failed.isError, true, 'the tool reply is the usual evaluation failure');
  await s.waitFor(() => statesOf(s, 'req-f').includes('failed'), 'failed');
  const reason = cleanErrorDetail(error);
  assert.deepEqual(s.statuses('req-f').at(-1), { type: 'ask-status', id: 'req-f', state: 'failed', reason });
  assert.ok(!reason.startsWith('Evaluation failed'), 'the reason carries nothing of the tool text');
  assert.ok(!reason.includes('line 2'), 'the reason carries no line suffix');
});

test('a failed change does not end a request whose earlier change still waits for its line', async (t) => {
  const s = await startScenario(t);
  await s.call('set_code', { code: CODE });
  await receiveRequest(s, 'req-fw');
  s.page.setResponder((msg) => {
    s.evaluates.push(msg);
    return okReply(msg, { pending: waitsForBar });
  });
  await s.call('set_code', { code: 'lead: s("sd")', at: 'bar', answering: 'req-fw' });
  await s.waitFor(() => statesOf(s, 'req-fw').includes('line'), 'line');
  const waitingId = s.evaluates.at(-1).id;

  // A second change for the same request fails; the page keeps the first one waiting.
  s.page.setResponder((msg) => {
    s.evaluates.push(msg);
    return { type: 'evaluated', id: msg.id, ok: false, code: msg.code, error: 'Unexpected token', line: 1 };
  });
  const failed = await s.call('set_code', { code: 'lead: s(', answering: 'req-fw' });
  assert.equal(failed.isError, true, 'the tool reply is the usual evaluation failure');
  await s.settle();
  assert.deepEqual(statesOf(s, 'req-fw'), ['started', 'line'], 'the request still waits for its line');

  s.page.send({ type: 'takeover', id: waitingId });
  await s.waitFor(() => statesOf(s, 'req-fw').includes('applied'), 'applied');
  assert.deepEqual(statesOf(s, 'req-fw'), ['started', 'line', 'applied']);
});

test('a page that never answers changes no state: silence is not failure', async (t) => {
  const s = await startScenario(t);
  await s.call('set_code', { code: CODE });
  s.ask('req-g');
  await s.waitFor(() => s.frames.some((m) => m.type === 'ask-result' && m.id === 'req-g'), 'ask-result');
  s.page.setResponder((msg) => {
    s.evaluates.push(msg);
    return null;
  });
  const timedOut = await s.call('set_code', { code: 'lead: s("sd")', answering: 'req-g' });
  assert.equal(timedOut.isError, true);
  await s.settle();
  assert.deepEqual(s.statuses('req-g'), []);
});

test('a change that names one request changes only that request', async (t) => {
  const s = await startScenario(t);
  await s.call('set_code', { code: CODE });
  s.ask('req-h');
  s.ask('req-i');
  await s.waitFor(() => s.frames.filter((m) => m.type === 'ask-result').length >= 2, 'both ask-results');
  const reply = await s.call('get_code');
  assert.ok(s.textOf(reply).includes('"id":"req-h"') && s.textOf(reply).includes('"id":"req-i"'));
  await s.call('set_code', { code: 'lead: s("sd")', answering: 'req-i' });
  await s.waitFor(() => statesOf(s, 'req-i').includes('applied'), 'applied for the second request');
  await s.settle();
  assert.deepEqual(statesOf(s, 'req-i'), ['started', 'applied']);
  assert.deepEqual(statesOf(s, 'req-h'), ['started'], 'the other request stays where it was');
});

// ---- The id on edit_code and restore_version, and an id that is not open ----

const LONG = Array.from({ length: 10 }, (_, i) => `t${i + 1}: s("bd").lpf(${1000 + i})`).join('\n');
const oneEdit = (to, from = 'lpf(1005)') => [{ old_string: from, new_string: to }];

test('edit_code names the request: applied at once, or line then applied at its takeover', async (t) => {
  const s = await startScenario(t);
  await s.call('set_code', { code: LONG });
  await receiveRequest(s, 'req-j');
  const now = await s.call('edit_code', { edits: oneEdit('lpf(1105)'), answering: 'req-j' });
  assert.ok(!now.isError, s.textOf(now));
  await s.waitFor(() => statesOf(s, 'req-j').includes('applied'), 'applied');
  const version = await newestVersion(s);
  assert.deepEqual(s.statuses('req-j').at(-1), { type: 'ask-status', id: 'req-j', state: 'applied', version });

  await receiveRequest(s, 'req-j2');
  s.page.setResponder((msg) => {
    s.evaluates.push(msg);
    return okReply(msg, { pending: waitsForBar });
  });
  const timed = await s.call('edit_code', { edits: oneEdit('lpf(1205)', 'lpf(1105)'), at: 'bar', answering: 'req-j2' });
  assert.ok(!timed.isError, s.textOf(timed));
  await s.waitFor(() => statesOf(s, 'req-j2').includes('line'), 'line');
  s.page.send({ type: 'takeover', id: s.evaluates.at(-1).id });
  await s.waitFor(() => statesOf(s, 'req-j2').includes('applied'), 'applied after the takeover');
  assert.deepEqual(statesOf(s, 'req-j2'), ['started', 'line', 'applied']);
});

test('restore_version names the request and it is applied as the restore version', async (t) => {
  const s = await startScenario(t);
  await s.call('set_code', { code: CODE });
  await s.call('set_code', { code: 'lead: s("sd")' });
  await receiveRequest(s, 'req-k');
  const restored = await s.call('restore_version', { id: 1, answering: 'req-k' });
  assert.ok(!restored.isError, s.textOf(restored));
  await s.waitFor(() => statesOf(s, 'req-k').includes('applied'), 'applied');
  const version = await newestVersion(s);
  assert.deepEqual(s.statuses('req-k').at(-1), { type: 'ask-status', id: 'req-k', state: 'applied', version });
  assert.ok(s.textOf(restored).includes(`as #${version}`), 'the reply names the same version');
});

/** Counts the fixed note in a reply. */
const noteCount = (text) => {
  assert.equal(typeof UNKNOWN_ANSWERING_NOTE, 'string', 'the note is exported');
  return text.split(UNKNOWN_ANSWERING_NOTE).length - 1;
};

test('an id that is not open never fails the change and is said once', async (t) => {
  const s = await startScenario(t);
  await s.call('set_code', { code: CODE });
  s.frames.length = 0;

  // Never sent.
  const never = await s.call('set_code', { code: 'lead: s("sd")', answering: 'nobody-asked' });
  assert.ok(!never.isError, s.textOf(never));
  assert.equal(noteCount(s.textOf(never)), 1);
  assert.ok(!s.textOf(never).startsWith('Note'), 'the usual status comes first, then the note');
  assert.ok(s.evaluates.at(-1).code === 'lead: s("sd")', 'the change reached the page');
  await s.settle();
  assert.deepEqual(s.frames.filter((m) => m.type === 'ask-status'), []);

  // One character off a real, open id: unknown, never matched to a neighbour.
  await receiveRequest(s, 'req-m1');
  const slip = await s.call('set_code', { code: 'lead: s("cp")', answering: 'req-m2' });
  assert.ok(!slip.isError, s.textOf(slip));
  assert.equal(noteCount(s.textOf(slip)), 1);
  await s.settle();
  assert.deepEqual(s.statuses('req-m1'), [{ type: 'ask-status', id: 'req-m1', state: 'started' }], 'the real request keeps its state');
  assert.deepEqual(s.statuses('req-m2'), []);

  // Already applied: closed.
  const applied = await s.call('set_code', { code: 'lead: s("hh")', answering: 'req-m1' });
  assert.equal(noteCount(s.textOf(applied)), 0);
  await s.waitFor(() => statesOf(s, 'req-m1').includes('applied'), 'applied');
  const again = await s.call('set_code', { code: 'lead: s("oh")', answering: 'req-m1' });
  assert.ok(!again.isError, s.textOf(again));
  assert.equal(noteCount(s.textOf(again)), 1);
  await s.settle();
  assert.deepEqual(statesOf(s, 'req-m1'), ['started', 'applied'], 'the request stays applied');
});

test('a failing change with an id that is not open carries the note once', async (t) => {
  const s = await startScenario(t);
  await s.call('set_code', { code: CODE });
  s.page.setResponder((msg) => {
    s.evaluates.push(msg);
    return { type: 'evaluated', id: msg.id, ok: false, code: msg.code, error: 'Unexpected token', line: 1 };
  });
  const failed = await s.call('set_code', { code: 'lead: s(', answering: 'nobody-asked' });
  assert.equal(failed.isError, true);
  assert.equal(noteCount(s.textOf(failed)), 1);
});

test('edit_code and restore_version also say the note for an id that is not open', async (t) => {
  const s = await startScenario(t);
  await s.call('set_code', { code: LONG });
  const edited = await s.call('edit_code', { edits: oneEdit('lpf(1105)'), answering: 'nobody-asked' });
  assert.ok(!edited.isError, s.textOf(edited));
  assert.equal(noteCount(s.textOf(edited)), 1);
  const restored = await s.call('restore_version', { id: 1, answering: 'nobody-asked' });
  assert.ok(!restored.isError, s.textOf(restored));
  assert.equal(noteCount(s.textOf(restored)), 1);
});

// ---- Closing a request in words with answer_request ----

const closing = (s, id) => s.statuses(id).filter((m) => m.state === 'answered' || m.state === 'declined');

test('answer_request closes an open request as answered and the page that sent it gets the sentence', async (t) => {
  assert.equal(protocolModule.MAX_ANSWER_TEXT_LENGTH, 200);
  const s = await startScenario(t);
  await s.call('set_code', { code: CODE });
  await receiveRequest(s, 'req-n');
  const reply = await s.call('answer_request', { id: 'req-n', outcome: 'answered', text: 'It plays four tracks.' });
  assert.ok(!reply.isError, s.textOf(reply));
  assert.ok(s.textOf(reply).includes('answered'), 'the reply says the request was closed as answered');
  await s.waitFor(() => closing(s, 'req-n').length > 0, 'ask-status answered');
  assert.deepEqual(closing(s, 'req-n'), [{ type: 'ask-status', id: 'req-n', state: 'answered', answer: 'It plays four tracks.' }]);
  assert.equal(s.evaluates.length, 1, 'the music was not changed (only the first set_code)');
});

test('answer_request with declined gives state declined with the same shape', async (t) => {
  const s = await startScenario(t);
  await receiveRequest(s, 'req-o');
  const reply = await s.call('answer_request', { id: 'req-o', outcome: 'declined', text: 'That cannot be done here.' });
  assert.ok(!reply.isError, s.textOf(reply));
  assert.ok(s.textOf(reply).includes('declined'));
  await s.waitFor(() => closing(s, 'req-o').length > 0, 'ask-status declined');
  assert.deepEqual(closing(s, 'req-o'), [{ type: 'ask-status', id: 'req-o', state: 'declined', answer: 'That cannot be done here.' }]);
});

test('answer_request cleans the sentence: each run of whitespace and control characters is one space', async (t) => {
  const s = await startScenario(t);
  await receiveRequest(s, 'req-p');
  const dirty = '  It\nplays\t\tfour\u0007 tracks\u202E.\u2028Done  ';
  const reply = await s.call('answer_request', { id: 'req-p', outcome: 'answered', text: dirty });
  assert.ok(!reply.isError, s.textOf(reply));
  await s.waitFor(() => closing(s, 'req-p').length > 0, 'ask-status answered');
  assert.equal(closing(s, 'req-p')[0].answer, 'It plays four tracks . Done');
});

test('answer_request on a closed, an unknown or a one-character-off id is refused and the page gets nothing', async (t) => {
  assert.equal(typeof boardModule.NOT_OPEN_REQUEST_MESSAGE, 'string', 'the refusal text is exported');
  const s = await startScenario(t);
  await receiveRequest(s, 'req-q');
  await s.call('answer_request', { id: 'req-q', outcome: 'answered', text: 'Yes.' });
  await s.waitFor(() => closing(s, 'req-q').length > 0, 'ask-status answered');
  const before = s.frames.length;
  for (const id of ['req-q', 'nobody-asked', 'req-r']) {
    const refused = await s.call('answer_request', { id, outcome: 'answered', text: 'Yes.' });
    assert.equal(refused.isError, true, `${id} is refused`);
    assert.ok(s.textOf(refused).includes(boardModule.NOT_OPEN_REQUEST_MESSAGE));
  }
  await s.settle();
  assert.equal(s.frames.length, before, 'the page got nothing');
  assert.equal(closing(s, 'req-q').length, 1);
});

test('answer_request refuses a sentence over 200 characters and one that is empty after cleaning, never trimming', async (t) => {
  const s = await startScenario(t);
  await receiveRequest(s, 'req-s');
  const long = await s.call('answer_request', { id: 'req-s', outcome: 'answered', text: 'x'.repeat(201) }).catch((err) => ({ isError: true, thrown: String(err) }));
  assert.equal(long.isError, true, 'a 201-character sentence is refused');
  const empty = await s.call('answer_request', { id: 'req-s', outcome: 'answered', text: ' \n\t\u0007 ' });
  assert.equal(empty.isError, true, 'a sentence of only spaces and control characters is refused');
  assert.ok(!s.textOf(empty).includes(boardModule.NOT_OPEN_REQUEST_MESSAGE), 'its message is about the sentence');
  await s.settle();
  assert.deepEqual(closing(s, 'req-s'), [], 'the page was told nothing about a closing');
  // The request is still open: a good sentence closes it.
  const ok = await s.call('answer_request', { id: 'req-s', outcome: 'answered', text: 'x'.repeat(200) });
  assert.ok(!ok.isError, s.textOf(ok));
});

test('after answer_request a change that names the closed request gets the unknown-id note and goes ahead', async (t) => {
  const s = await startScenario(t);
  await s.call('set_code', { code: CODE });
  await receiveRequest(s, 'req-t');
  await s.call('answer_request', { id: 'req-t', outcome: 'declined', text: 'No.' });
  await s.waitFor(() => closing(s, 'req-t').length > 0, 'ask-status declined');
  const changed = await s.call('set_code', { code: 'lead: s("sd")', answering: 'req-t' });
  assert.ok(!changed.isError, s.textOf(changed));
  assert.ok(s.textOf(changed).includes(UNKNOWN_ANSWERING_NOTE));
  assert.equal(s.evaluates.at(-1).code, 'lead: s("sd")');
  await s.settle();
  assert.deepEqual(statesOf(s, 'req-t').filter((x) => x === 'applied'), []);
});

// ---- The board a reloaded page asks for ----

/** Another fake page on the same server; it collects every frame it receives. */
async function openPage(s) {
  const page = await createFakePage(s.port);
  const frames = [];
  page.ws.on('message', (data) => frames.push(JSON.parse(data.toString())));
  s.t.after(() => page.ws.close());
  const boards = () => frames.filter((m) => m.type === 'ask-board');
  const wait = async (predicate, what) => {
    const start = Date.now();
    while (!predicate()) {
      if (Date.now() - start > 3000) throw new Error(`Timed out waiting for ${what}; got ${JSON.stringify(frames)}`);
      await sleep(10);
    }
  };
  return { page, frames, boards, wait };
}

const WORDS = 'make-the-zebra-bass-slower';

function walk(dir) {
  const files = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) files.push(...walk(full));
    else files.push(full);
  }
  return files;
}

test('a reloaded page gets the requests of the page that went, a second live page never does', async (t) => {
  const s = await startScenario(t);
  s.t = t;
  await s.call('set_code', { code: CODE });
  s.page.send({ type: 'ask', id: 'req-bm', text: WORDS, context: { kind: 'session' }, chip: 'Bass', current: null });
  s.page.send({ type: 'ask', id: 'req-bn', text: 'second request', context: { kind: 'session' }, chip: 'Whole session', current: null });
  await s.waitFor(() => s.frames.filter((m) => m.type === 'ask-result').length === 2, 'both ask-results');
  const got = await s.call('get_code');
  assert.ok(s.textOf(got).includes('"id":"req-bn"'));
  const changed = await s.call('set_code', { code: 'lead: s("sd")', answering: 'req-bn' });
  assert.ok(!changed.isError, s.textOf(changed));
  await s.waitFor(() => statesOf(s, 'req-bn').includes('applied'), 'applied');
  const version = await newestVersion(s);
  s.page.ws.close();
  await sleep(100);

  const p2 = await openPage(s);
  p2.page.send({ type: 'ask-board-request' });
  await p2.wait(() => p2.boards().length === 1, 'the board');
  const [board] = p2.boards();
  assert.equal(board.type, 'ask-board');
  assert.deepEqual(
    board.requests.map((row) => ({ id: row.id, text: row.text, chip: row.chip, state: row.state, version: row.version })),
    [
      { id: 'req-bm', text: WORDS, chip: 'Bass', state: 'started', version: undefined },
      { id: 'req-bn', text: 'second request', chip: 'Whole session', state: 'applied', version },
    ],
  );
  for (const row of board.requests) {
    assert.equal(typeof row.openedAgoMs, 'number');
    assert.equal(typeof row.newsAgoMs, 'number');
    assert.ok(row.openedAgoMs >= row.newsAgoMs, 'the last news is not older than the request');
  }

  // A third page, while the second is connected, sees none of them.
  const p3 = await openPage(s);
  p3.page.send({ type: 'ask-board-request' });
  await p3.wait(() => p3.boards().length === 1, 'the third board');
  assert.deepEqual(p3.boards()[0].requests, []);

  // The next state of an adopted request reaches the page that adopted it, not the other.
  const closed = await s.call('answer_request', { id: 'req-bm', outcome: 'answered', text: 'Slower now.' });
  assert.ok(!closed.isError, s.textOf(closed));
  await p2.wait(() => p2.frames.some((m) => m.type === 'ask-status' && m.id === 'req-bm' && m.state === 'answered'), 'answered on the second page');
  await sleep(150);
  assert.ok(!p3.frames.some((m) => m.type === 'ask-status'), 'the third page was told nothing');

  // Nothing about a request reached the disk.
  const files = walk(s.dataDir);
  assert.ok(files.length > 0, 'the data folder holds the history, so the scan is not empty');
  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    assert.ok(!content.includes(WORDS), `${path.basename(file)} holds the request text`);
    assert.ok(!content.includes('second request'), `${path.basename(file)} holds a request text`);
    assert.ok(!content.includes('Slower now.'), `${path.basename(file)} holds the answer`);
  }
});

test('a reloaded page is told when Claude receives a request it adopted, from a listener', async (t) => {
  const s = await startScenario(t);
  s.t = t;
  const first = await s.call('set_code', { code: CODE });
  const { token } = listenerCommandFrom(s.textOf(first));
  // One request waits for a tool reply.
  s.ask('req-aq');
  await s.waitFor(() => s.frames.some((m) => m.type === 'ask-result' && m.id === 'req-aq'), 'ask-result for the queued one');
  // One request is handed to a listener that has not confirmed it yet.
  const listener = await connectListener(s.port, token);
  t.after(() => listener.close());
  const handed = await nextMessage(listener);
  assert.equal(handed.id, 'req-aq', 'the listener gets the waiting request first');
  s.ask('req-af');
  const inFlight = await nextMessage(listener);
  assert.equal(inFlight.id, 'req-af');
  s.page.ws.close();
  await sleep(100);

  const p2 = await openPage(s);
  p2.page.send({ type: 'ask-board-request' });
  await p2.wait(() => p2.boards().length === 1, 'the board');
  assert.deepEqual(
    p2.boards()[0].requests.map((row) => [row.id, row.state]),
    [['req-aq', 'waiting'], ['req-af', 'sent']],
  );

  listener.send(JSON.stringify({ ack: 'req-aq' }));
  listener.send(JSON.stringify({ ack: 'req-af' }));
  const told = (id) =>
    p2.frames.some(
      (m) => (m.type === 'ask-result' && m.id === id && m.status === 'received') || (m.type === 'ask-received' && m.ids.includes(id)),
    );
  await p2.wait(() => told('req-aq') && told('req-af'), 'received for both adopted requests');
});

test('a reloaded page is told when a tool reply hands over a request it adopted', async (t) => {
  const s = await startScenario(t);
  s.t = t;
  await s.call('set_code', { code: CODE });
  s.ask('req-ar');
  await s.waitFor(() => s.frames.some((m) => m.type === 'ask-result' && m.id === 'req-ar'), 'ask-result');
  s.page.ws.close();
  await sleep(100);

  const p2 = await openPage(s);
  p2.page.send({ type: 'ask-board-request' });
  await p2.wait(() => p2.boards().length === 1, 'the board');
  assert.deepEqual(p2.boards()[0].requests.map((row) => [row.id, row.state]), [['req-ar', 'waiting']]);

  const got = await s.call('get_code');
  assert.ok(s.textOf(got).includes('"id":"req-ar"'), 'the reply carries the request line');
  await p2.wait(() => p2.frames.some((m) => m.type === 'ask-received' && m.ids.includes('req-ar')), 'ask-received on the new page');
});

test('an id already on the board is refused as a duplicate and the row it names is left alone', async (t) => {
  const s = await startScenario(t);
  s.t = t;
  await s.call('set_code', { code: CODE });
  await receiveRequest(s, 'req-dup');
  const refusal = { status: 'refused', reason: 'invalid', detail: 'duplicate request id' };
  const refusals = (frames) => frames.filter((m) => m.type === 'ask-result' && m.id === 'req-dup' && m.status === 'refused');

  // The same page, once Claude holds the request.
  s.ask('req-dup', 'a second request');
  await s.waitFor(() => refusals(s.frames).length === 1, 'the refusal');
  assert.deepEqual(refusals(s.frames)[0], { type: 'ask-result', id: 'req-dup', ...refusal });

  // Another live page.
  const p2 = await openPage(s);
  p2.page.send({ type: 'ask', id: 'req-dup', text: 'from another tab', context: { kind: 'session' }, chip: 'Whole session', current: null });
  await p2.wait(() => refusals(p2.frames).length === 1, 'the refusal on the other page');
  assert.deepEqual(refusals(p2.frames)[0], { type: 'ask-result', id: 'req-dup', ...refusal });

  // The row still belongs to the first page and keeps its state: closing it reaches that page.
  // (The second page took the active role, so the music is not changed here.)
  const reply = await s.call('get_code');
  assert.ok(!s.textOf(reply).includes('a second request') && !s.textOf(reply).includes('from another tab'), 'no repeat reached Claude');
  const closed = await s.call('answer_request', { id: 'req-dup', outcome: 'answered', text: 'Done.' });
  assert.ok(!closed.isError, s.textOf(closed));
  await s.waitFor(() => statesOf(s, 'req-dup').includes('answered'), 'answered on the first page');
  await s.settle();
  assert.deepEqual(statesOf(s, 'req-dup'), ['started', 'answered']);
  assert.ok(!p2.frames.some((m) => m.type === 'ask-status'), 'the other page was told nothing');
});

test('a page that never presented the token gets no board and one refusal line is logged', async (t) => {
  const s = await startScenario(t);
  s.page.send({ type: 'ask', id: 'req-bx', text: 'a request', context: { kind: 'session' }, chip: 'Whole session', current: null });
  await s.waitFor(() => s.frames.some((m) => m.type === 'ask-result'), 'ask-result');
  const ws = await connectPage(s.port);
  const received = [];
  ws.on('message', (data) => received.push(JSON.parse(data.toString())));
  t.after(() => ws.close());
  ws.send(JSON.stringify({ type: 'ask-board-request' }));
  ws.send(JSON.stringify({ type: 'ask-board-request' }));
  await sleep(300);
  assert.deepEqual(received.filter((m) => m.type === 'ask-board'), []);
  const lines = s.started.stderrText.split('\n').filter((line) => line.includes('(ask-board-request)') && line.includes('did not present the page token'));
  assert.equal(lines.length, 1, 'one refusal line, however often it is asked');
});

test('a ramp the page refuses leaves the request open, and a change without glideBars still answers it', async (t) => {
  const s = await startScenario(t);
  await s.call('set_code', { code: CODE });
  await receiveRequest(s, 'req-g');
  s.page.setResponder((msg) => {
    s.evaluates.push(msg);
    return { type: 'evaluated', id: msg.id, ok: false, code: msg.code, error: 'Nothing was changed.', glideRefused: true };
  });
  const refused = await s.call('set_code', { code: 'lead: s("sd")', glideBars: 4, answering: 'req-g' });
  assert.equal(refused.isError, true, 'the call is refused');
  await s.settle();
  assert.deepEqual(statesOf(s, 'req-g'), ['started'], 'no failed status: the request is still open');
  s.page.setResponder((msg) => {
    s.evaluates.push(msg);
    return okReply(msg);
  });
  const answered = await s.call('set_code', { code: 'lead: s("sd")', answering: 'req-g' });
  assert.ok(!answered.isError, s.textOf(answered));
  await s.waitFor(() => statesOf(s, 'req-g').includes('applied'), 'applied');
  assert.deepEqual(statesOf(s, 'req-g'), ['started', 'applied']);
});

test('a refusal that is not a ramp refusal still marks the request failed', async (t) => {
  const s = await startScenario(t);
  await s.call('set_code', { code: CODE });
  await receiveRequest(s, 'req-h');
  s.page.setResponder((msg) => {
    s.evaluates.push(msg);
    return { type: 'evaluated', id: msg.id, ok: false, code: msg.code, error: 'Nothing was changed.' };
  });
  const failed = await s.call('set_code', { code: 'lead: s("sd")', glideBars: 4, answering: 'req-h' });
  assert.equal(failed.isError, true);
  await s.waitFor(() => statesOf(s, 'req-h').includes('failed'), 'failed');
});
