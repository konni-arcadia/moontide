// The load failure report on the server side: the message schema, the token check, the note Claude gets, and the
// promise that a report never changes which page is active.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePageMessage } from '../dist/protocol.js';
import { Session, loadFailureNote } from '../dist/session.js';
import { startWebServer } from '../dist/web-server.js';
import { authenticatePage, connectPage, fetchPageToken, nextMessage, onEveryMessage } from './helpers.js';

const STRUDEL_NOTE =
  "Moontide page: a tab could not load the Strudel script from unpkg.com, so it shows a notice instead of the editor and cannot play. The fix is on the user's side: check the internet connection and that nothing blocks unpkg.com (an ad blocker, a firewall or a proxy), then reload the page.";
const BOTH_NOTE =
  "Moontide page: a tab could not load the Strudel and acorn scripts from unpkg.com, so it shows a notice instead of the editor and cannot play. The fix is on the user's side: check the internet connection and that nothing blocks unpkg.com (an ad blocker, a firewall or a proxy), then reload the page.";
const ACORN_NOTE =
  "Moontide page: a tab could not load the acorn script from unpkg.com, so sound still plays there but the Timeline, Mixer, Parts, Jam and Instruments views cannot read the code. The fix is on the user's side: check that nothing blocks unpkg.com, then reload the page.";

/** A fake page connection: send collects the parsed frames. */
function fakePage() {
  const frames = [];
  return {
    frames,
    send(data) {
      frames.push(JSON.parse(data));
    },
  };
}

function report(token, failed) {
  return JSON.stringify({ type: 'load-failed', token, failed });
}

test('loadFailureNote words the three cases exactly', () => {
  assert.equal(loadFailureNote(['strudel']), STRUDEL_NOTE);
  assert.equal(loadFailureNote(['strudel', 'acorn']), BOTH_NOTE);
  assert.equal(loadFailureNote(['acorn']), ACORN_NOTE);
});

test('parsePageMessage accepts a good load-failed report', () => {
  for (const failed of [['strudel'], ['acorn'], ['strudel', 'acorn'], ['acorn', 'strudel']]) {
    assert.deepEqual(parsePageMessage(report('t'.repeat(64), failed)), { type: 'load-failed', token: 't'.repeat(64), failed });
  }
});

test('parsePageMessage refuses a load-failed report with a bad list or a long token', () => {
  const refused = [
    report('abc', []),
    report('abc', ['strudel', 'acorn', 'strudel']),
    report('abc', ['strudel', 'strudel']),
    report('abc', ['acorn', 'acorn']),
    report('abc', ['codemirror']),
    report('abc', ['strudel', 'codemirror']),
    report('abc', 'strudel'),
    report('x'.repeat(129), ['strudel']),
    JSON.stringify({ type: 'load-failed', failed: ['strudel'] }),
    JSON.stringify({ type: 'load-failed', token: 'abc' }),
  ];
  for (const raw of refused) {
    assert.throws(() => parsePageMessage(raw), `expected a refusal for ${raw}`);
  }
});

test('a report with the current token is answered ok true on its own connection, keeps the connection untrusted, and reaches Claude once', () => {
  const session = new Session();
  const conn = fakePage();
  session.handlePageMessage(conn, parsePageMessage(report(session.ask.pageToken, ['strudel'])));

  assert.deepEqual(conn.frames, [{ type: 'load-failed-result', ok: true }]);
  assert.equal(session.ask.isTrusted(conn), false);

  assert.equal(session.drainNotices().lines[0], STRUDEL_NOTE);
  assert.ok(!session.drainNotices().lines.includes(STRUDEL_NOTE), 'a drained note is gone');
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const pageNotes = (session) => session.drainNotices().lines.filter((line) => line.startsWith('Moontide page:'));

/** A real Session behind a real web server on a free port, and a page that is already the active one. */
async function startWithActivePage(t) {
  const session = new Session();
  const web = await startWebServer({ session, port: 0 });
  session.setPageUrl(web.url);
  const sockets = [];
  t.after(async () => {
    for (const ws of sockets) ws.close();
    await web.close();
  });
  const connect = async () => {
    const ws = await connectPage(web.port);
    sockets.push(ws);
    return ws;
  };
  const active = await connect();
  await authenticatePage(active, web.port);
  assert.deepEqual(await nextMessage(active), { type: 'page-requests', live: false });
  await sleep(100);
  const received = [];
  onEveryMessage(active, (msg) => received.push(msg));
  return { session, web, active, received, connect };
}

test('a report over a real server leaves the active page, its sound and its role alone', async (t) => {
  const { session, web, active, received, connect } = await startWithActivePage(t);
  const reporter = await connect();
  const heard = [];
  onEveryMessage(reporter, (msg) => heard.push(msg));

  reporter.send(report(await fetchPageToken(web.port), ['strudel']));
  await sleep(300);

  assert.deepEqual(heard, [{ type: 'load-failed-result', ok: true }], 'the reporter gets the answer and nothing else (no hello, no page-requests)');
  assert.deepEqual(received, [], 'the active page gets no message at all (no superseded, no no-active-page)');
  assert.equal(session.ask.isTrusted(reporter), false);
  assert.deepEqual(pageNotes(session), [STRUDEL_NOTE]);
});

test('a report with a wrong token is answered ok false, keeps no note, and logs one line without any token', async (t) => {
  const { session, web, active, received, connect } = await startWithActivePage(t);
  const lines = [];
  t.mock.method(console, 'error', (...args) => lines.push(args.join(' ')));
  const reporter = await connect();
  const heard = [];
  onEveryMessage(reporter, (msg) => heard.push(msg));
  const wrong = 'f'.repeat(64);
  assert.notEqual(wrong, await fetchPageToken(web.port));

  reporter.send(report(wrong, ['strudel']));
  await sleep(300);

  assert.deepEqual(heard, [{ type: 'load-failed-result', ok: false }]);
  assert.deepEqual(received, []);
  assert.deepEqual(pageNotes(session), []);
  const refusals = lines.filter((line) => line.includes('load failure report'));
  assert.equal(refusals.length, 1);
  assert.ok(!refusals[0].includes(wrong), 'the given token is never logged');
  assert.ok(!lines.join('\n').includes(session.ask.pageToken), 'the current token is never logged');
});

test('two identical reports give one note line, and different reports give one line each in arrival order', async (t) => {
  const { session, web, connect } = await startWithActivePage(t);
  const token = await fetchPageToken(web.port);
  const first = await connect();
  const second = await connect();
  first.send(report(token, ['strudel']));
  second.send(report(token, ['strudel']));
  await nextMessage(first);
  await nextMessage(second);
  assert.deepEqual(pageNotes(session), [STRUDEL_NOTE]);
  assert.deepEqual(pageNotes(session), [], 'drained once');

  first.send(report(token, ['acorn']));
  await nextMessage(first);
  second.send(report(token, ['strudel', 'acorn']));
  await nextMessage(second);
  first.send(report(token, ['acorn']));
  await nextMessage(first);
  assert.deepEqual(pageNotes(session), [ACORN_NOTE, BOTH_NOTE]);
});

test('a page that only reported can still authenticate later and becomes the active page the normal way', async (t) => {
  const { web, active, received, connect } = await startWithActivePage(t);
  const reporter = await connect();
  reporter.send(report(await fetchPageToken(web.port), ['strudel']));
  assert.deepEqual(await nextMessage(reporter), { type: 'load-failed-result', ok: true });

  const hello = await authenticatePage(reporter, web.port);
  assert.equal(hello.type, 'hello');
  await sleep(100);
  assert.ok(received.some((msg) => msg.type === 'superseded'), 'the earlier page is superseded by the normal path');
});
