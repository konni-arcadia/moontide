// The MCP process stays quiet until the start tool: no web server, no port, no page line, no tab.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { startMcpClient, PAGE_URL_PATTERN, createFakePage, withoutPageLine } from './helpers.js';
import { Session, noPageMessage, NOT_STARTED_MESSAGE, EDIT_NOTHING_PLAYING_MESSAGE } from '../dist/session.js';
import { HistoryStore, versionNotFoundMessage } from '../dist/history.js';
import {
  createStarter,
  pageWaitTimeoutMessage,
  startReplyText,
  notStartedForRequestsText,
  notStartedForRequestsToolText,
} from '../dist/start.js';
import { PAGE_REQUESTS_ALREADY_OFF } from '../dist/ask.js';
import { createMcpServer } from '../dist/mcp.js';
import { startWebServer } from '../dist/web-server.js';

const PAGE_LINES = /Moontide page: /g;
const NO_BROWSER_LINES = /MOONTIDE_NO_BROWSER=1: not opening the browser\./g;

const countMatches = (text, pattern) => (text.match(pattern) ?? []).length;
const textOf = (reply) => reply.content.map((part) => part.text).join('\n');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** stderr reaches the test through a pipe, a moment after the tool reply: wait until a line shows up. */
async function waitForStderrCount(server, pattern, count, timeoutMs = 10000) {
  const start = Date.now();
  while (countMatches(server.stderrText, pattern) < count) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `Timed out waiting for ${count} match(es) of ${pattern} in the server log:\n${server.stderrText}`,
      );
    }
    await sleep(10);
  }
}

test('a session that connects starts nothing, then the start tool starts Moontide once', async (t) => {
  const server = await startMcpClient({ start: false });
  t.after(() => server.client.close());

  const tools = await server.client.listTools();
  assert.ok(tools.tools.some((tool) => tool.name === 'start'), 'the start tool is listed');
  const reference = await server.client.callTool({ name: 'get_strudel_reference', arguments: {} });
  assert.ok(!reference.isError, 'the reference answers before any start');

  await sleep(300);
  // A reply to a later request means the server has finished with the earlier ones, so the checks below do not pass only because a line is late.
  // It also shows that get_code starts nothing.
  const before = await server.client.callTool({ name: 'get_code', arguments: {} });
  assert.ok(before.isError, 'get_code before a start is an error');
  assert.equal(textOf(before), NOT_STARTED_MESSAGE);
  assert.equal(countMatches(server.stderrText, PAGE_LINES), 0, 'no page line before a start');
  assert.equal(countMatches(server.stderrText, NO_BROWSER_LINES), 0, 'no browser line before a start');

  const reply = await server.client.callTool({ name: 'start', arguments: {} });
  assert.ok(!reply.isError, textOf(reply));
  await waitForStderrCount(server, PAGE_LINES, 1);
  await waitForStderrCount(server, NO_BROWSER_LINES, 1);
  const match = PAGE_URL_PATTERN.exec(server.stderrText);
  assert.ok(match, 'the page line is on stderr after the start');
  const [, url, port] = match;
  const text = textOf(reply);
  assert.ok(text.startsWith('Moontide started.'), text);
  assert.ok(text.includes(url), text);
  assert.ok(text.includes(`port ${port}`), text);
  assert.equal(countMatches(server.stderrText, PAGE_LINES), 1);
  assert.equal(countMatches(server.stderrText, NO_BROWSER_LINES), 1);

  const page = await fetch(url);
  assert.equal(page.status, 200);
  const pageText = await page.text();
  assert.match(pageText, /<meta name="moontide-page-token" content="[^"]+">/);
  // The server runs in a folder named my-project, so the served page names that session.
  assert.ok(pageText.includes(`<title>Moontide \u00b7 my-project \u00b7 ${port}</title>`));

  const fakePage = await createFakePage(Number(port));
  t.after(() => fakePage.ws.close());
  assert.equal(fakePage.hello.type, 'hello');

  const again = await server.client.callTool({ name: 'start', arguments: {} });
  assert.ok(!again.isError, textOf(again));
  assert.ok(textOf(again).startsWith('Moontide is already started.'), textOf(again));
  assert.ok(textOf(again).includes(url));
  assert.equal(countMatches(server.stderrText, PAGE_LINES), 1, 'still one page line');
});

test('two start calls at once bind one port and print one page line', async (t) => {
  const server = await startMcpClient({ start: false });
  t.after(() => server.client.close());

  const replies = await Promise.all([
    server.client.callTool({ name: 'start', arguments: {} }),
    server.client.callTool({ name: 'start', arguments: {} }),
  ]);
  for (const reply of replies) {
    assert.ok(!reply.isError, textOf(reply));
  }
  await waitForStderrCount(server, PAGE_LINES, 1);
  const url = PAGE_URL_PATTERN.exec(server.stderrText)[1];
  const texts = replies.map(textOf);
  for (const text of texts) {
    assert.ok(text.includes(url), text);
  }
  assert.equal(texts.filter((text) => text.startsWith('Moontide started.')).length, 1);
  assert.equal(countMatches(server.stderrText, PAGE_LINES), 1);
});

/**
 * An in-process Moontide: a real Session, starter and MCP server talking to a Client over memory, with a
 * browser opener that is a spy. When `connect` is set, the opener connects a fake page about 100 ms after the
 * tab "opens", the way a browser would. Everything is closed in t.after.
 */
async function harness(t, options = {}) {
  const { noBrowser = false, pageWaitMs = 3000, connect = null, now, history } = options;
  const session = new Session(history ? { history } : undefined);
  const opened = [];
  const pages = [];
  let webStarts = 0;
  let done = false;
  const starter = createStarter({
    session,
    noBrowser,
    pageWaitMs,
    now,
    port: 0,
    folder: 'my-project',
    startWebServer: (serverOptions) => {
      webStarts += 1;
      return startWebServer(serverOptions);
    },
    openBrowser: (url) => {
      opened.push(url);
      if (connect !== null) {
        setTimeout(async () => {
          try {
            const page = await createFakePage(Number(new URL(url).port), { responder: connect.responder });
            if (done) page.ws.close();
            else pages.push(page);
          } catch (err) {
            // A browser that opens after the test ended finds the server closed; that is not a failure.
            if (!done) throw err;
          }
        }, connect.afterMs ?? 100);
      }
    },
  });
  const mcp = createMcpServer({ session, starter });
  const client = new Client({ name: 'test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => {
    done = true;
    for (const page of pages) page.ws.close();
    await client.close();
    await starter.close();
  });
  return {
    session,
    starter,
    client,
    opened,
    pages,
    webStarts: () => webStarts,
    call: (name, args = {}) => client.callTool({ name, arguments: args }),
  };
}

const answer = (audio) => (msg) => ({ type: 'evaluated', id: msg.id, ok: true, code: msg.code, audio });

test('music requests start Moontide: set_code before any start waits for the page, then plays after the click', async (t) => {
  const sent = [];
  const h = await harness(t, {
    connect: {
      responder: (msg) => {
        sent.push(msg);
        return answer('waiting-for-click')(msg);
      },
    },
  });
  const reply = await h.call('set_code', { code: 's("bd")' });
  assert.ok(!reply.isError, textOf(reply));
  assert.equal(h.opened.length, 1, 'one tab opened');
  const url = h.starter.current().url;
  assert.equal(h.opened[0], url);
  assert.ok(
    textOf(reply).startsWith(
      `Waiting for the user's click: the code is loaded and will start playing after one click on the page at ${url}.`,
    ),
    textOf(reply),
  );
  assert.equal(sent.length, 1, 'the page got exactly one evaluate');
  assert.equal(sent[0].code, 's("bd")');
});

test('music requests start Moontide: with the audio running the reply is ok, playing', async (t) => {
  const h = await harness(t, { connect: { responder: answer('playing') } });
  const reply = await h.call('set_code', { code: 's("bd")' });
  assert.ok(!reply.isError, textOf(reply));
  assert.ok(textOf(reply).startsWith('ok, playing'), textOf(reply));
  assert.equal(h.opened.length, 1);
});

test('music requests start Moontide: edit_code before any start is refused before any start or tab', async (t) => {
  const h = await harness(t, { connect: { responder: answer('playing') } });
  const reply = await h.call('edit_code', { edits: [{ old_string: 'x', new_string: 'y' }] });
  assert.ok(reply.isError, 'nothing plays, so there is nothing to edit');
  const text = textOf(reply);
  assert.ok(text.includes(EDIT_NOTHING_PLAYING_MESSAGE), text);
  assert.ok(!text.includes('not started'), text);
  assert.ok(!text.includes('No page connected'), text);
  assert.equal(h.opened.length, 0, 'no tab opened');
  assert.equal(h.webStarts(), 0, 'no web server started');
  assert.equal(h.starter.current(), null, 'Moontide is still not started');
});

test('music requests start Moontide: restore_version of an id that cannot be restored is refused before any start or tab', async (t) => {
  const h = await harness(t, { connect: { responder: answer('playing') } });
  const reply = await h.call('restore_version', { id: 1 });
  assert.ok(reply.isError, 'there is no history to restore from');
  const text = textOf(reply);
  assert.ok(!text.includes('not started'), text);
  assert.ok(!text.includes('No page connected'), text);
  assert.equal(h.opened.length, 0, 'no tab opened');
  assert.equal(h.webStarts(), 0, 'no web server started');
  assert.equal(h.starter.current(), null, 'Moontide is still not started');
});

test('music requests start Moontide: restore_version of an id missing from a real history is refused before any start or tab', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moontide-history-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const h = await harness(t, { connect: { responder: answer('playing') }, history: new HistoryStore({ dataDir: dir }) });
  const reply = await h.call('restore_version', { id: 99 });
  assert.ok(reply.isError);
  assert.ok(textOf(reply).includes(versionNotFoundMessage(99)), textOf(reply));
  assert.equal(h.opened.length, 0, 'no tab opened');
  assert.equal(h.starter.current(), null, 'Moontide is still not started');
});

test('music requests start Moontide: no page within the wait fails, names the address, and sends nothing', async (t) => {
  const h = await harness(t, { pageWaitMs: 300 });
  const began = Date.now();
  const reply = await h.call('set_code', { code: 's("bd")' });
  const took = Date.now() - began;
  assert.ok(reply.isError);
  const server = h.starter.current();
  assert.equal(textOf(reply), pageWaitTimeoutMessage(server, 300));
  assert.ok(textOf(reply).includes(server.url));
  assert.ok(took >= 295, `waited the limit, took ${took} ms`);
  assert.ok(took < 3000, `did not wait longer, took ${took} ms`);

  // A page that connects afterwards gets nothing: the request was never sent.
  const received = [];
  const late = await createFakePage(server.port, {
    responder: (msg) => {
      received.push(msg);
      return null;
    },
  });
  t.after(() => late.ws.close());
  await sleep(200);
  assert.equal(received.length, 0, 'a late page receives no evaluate');
});

test('music requests start Moontide: start and set_code sent at once share one start and one tab', async (t) => {
  const h = await harness(t, { connect: { responder: answer('playing') } });
  const [startReply, codeReply] = await Promise.all([h.call('start'), h.call('set_code', { code: 's("bd")' })]);
  assert.ok(!startReply.isError, textOf(startReply));
  assert.ok(!codeReply.isError, textOf(codeReply));
  assert.equal(h.webStarts(), 1, 'one web server');
  assert.equal(h.opened.length, 1, 'one tab');
});

test('music requests start Moontide: under MOONTIDE_NO_BROWSER no tab opens and nothing is awaited', async (t) => {
  const h = await harness(t, { noBrowser: true, pageWaitMs: 5000 });
  const began = Date.now();
  const reply = await h.call('set_code', { code: 's("bd")' });
  const took = Date.now() - began;
  assert.ok(reply.isError);
  assert.equal(textOf(reply), noPageMessage(h.starter.current().url));
  assert.ok(took < 1000, `failed at once, took ${took} ms`);
  assert.equal(h.opened.length, 0, 'no tab was opened');
});

test('music requests start Moontide: with a page connected set_code answers without waiting or a second tab', async (t) => {
  const h = await harness(t, { connect: { responder: answer('playing') } });
  const first = await h.call('start');
  assert.ok(!first.isError, textOf(first));
  // Wait for the page that the opened tab connects.
  const until = Date.now() + 3000;
  while (!h.session.hasActivePage() && Date.now() < until) await sleep(20);
  assert.ok(h.session.hasActivePage(), 'the fake browser connected');
  const began = Date.now();
  const reply = await h.call('set_code', { code: 's("bd")' });
  const took = Date.now() - began;
  assert.ok(!reply.isError, textOf(reply));
  assert.ok(took < 1000, `no wait, took ${took} ms`);
  assert.equal(h.opened.length, 1, 'no second tab');
});

// The start reply for every outcome, written out here (not imported) so a rewording is a visible test change.
test('start reply: one text for each outcome', () => {
  const server = { url: 'http://localhost:5757', port: 5757, label: 'my-project \u00b7 5757' };
  const page = 'Page: http://localhost:5757 (port 5757), in the browser tab titled "Moontide \u00b7 my-project \u00b7 5757".';
  assert.equal(
    startReplyText({ server, startedNow: true, tab: 'opened' }),
    `Moontide started. ${page} A new browser tab opened on it; one click there turns the sound on.`,
  );
  assert.equal(
    startReplyText({ server, startedNow: true, tab: 'no-browser' }),
    `Moontide started. ${page} No tab was opened (MOONTIDE_NO_BROWSER=1): open the page yourself; one click there turns the sound on.`,
  );
  assert.equal(
    startReplyText({ server, startedNow: false, tab: 'connected' }),
    `Moontide is already started. ${page} Its page is connected; no new tab was opened.`,
  );
  assert.equal(
    startReplyText({ server, startedNow: false, tab: 'on-its-way' }),
    `Moontide is already started. ${page} The tab opened for it has not connected yet; no second tab was opened.`,
  );
  assert.equal(
    startReplyText({ server, startedNow: false, tab: 'reopened' }),
    `Moontide is already started. ${page} No page was connected, so a new browser tab opened on it; one click there turns the sound on.`,
  );
});

test('the start prompt and the start tool share one start; a second start is safe', async (t) => {
  const h = await harness(t);
  const { prompts } = await h.client.listPrompts();
  const prompt = prompts.find((entry) => entry.name === 'start');
  assert.ok(prompt, 'the start prompt is listed');
  assert.equal(prompt.title, 'Start Moontide');

  const got = await h.client.getPrompt({ name: 'start' });
  assert.equal(got.messages.length, 1);
  assert.equal(got.messages[0].role, 'user');
  const server = h.starter.current();
  assert.equal(server.label, `my-project \u00b7 ${server.port}`);
  assert.equal(
    got.messages[0].content.text,
    startReplyText({ server, startedNow: true, tab: 'opened' }),
  );

  const again = await h.call('start');
  assert.ok(!again.isError, textOf(again));
  assert.equal(textOf(again), startReplyText({ server, startedNow: false, tab: 'on-its-way' }));
  assert.equal(h.opened.length, 1, 'one tab only');
});

test('start with a page connected opens no tab; when the page is gone it opens one new tab', async (t) => {
  const h = await harness(t, { connect: { responder: answer('playing') } });
  const first = await h.call('start');
  assert.ok(first.content[0].text.startsWith('Moontide started.'));
  const until = Date.now() + 3000;
  while (!h.session.hasActivePage() && Date.now() < until) await sleep(20);
  assert.ok(h.session.hasActivePage());

  const server = h.starter.current();
  const connected = await h.call('start');
  assert.equal(textOf(connected), startReplyText({ server, startedNow: false, tab: 'connected' }));
  assert.equal(h.opened.length, 1, 'no new tab while the page is connected');

  // The server knows the page once it authenticates; the test holds it only after its own hello arrived.
  const gotPage = Date.now() + 3000;
  while (h.pages.length === 0 && Date.now() < gotPage) await sleep(20);
  assert.equal(h.pages.length, 1, 'the fake page is known to the test');

  // The page goes away: nothing is connected and the tab that connected is no longer on its way.
  h.pages[0].ws.close();
  const gone = Date.now() + 3000;
  while (h.session.hasActivePage() && Date.now() < gone) await sleep(20);
  assert.ok(!h.session.hasActivePage(), 'the page is gone');
  const reopened = await h.call('start');
  assert.equal(textOf(reopened), startReplyText({ server, startedNow: false, tab: 'reopened' }));
  assert.equal(h.opened.length, 2);
  assert.equal(h.opened[1], h.opened[0], 'the same address');
  // The new tab's page connects too; wait for it so nothing outlives the test.
  const back = Date.now() + 3000;
  while (!h.session.hasActivePage() && Date.now() < back) await sleep(20);
  assert.ok(h.session.hasActivePage(), 'the reopened tab connected');
});

test('start: a tab that never connected blocks a second tab only until the wait limit has passed', async (t) => {
  const clock = { time: 1_000_000 };
  const h = await harness(t, { pageWaitMs: 30000, now: () => clock.time });
  const server = (await h.starter.ensureStarted()).server;
  assert.equal(h.opened.length, 1);

  clock.time += 29_000;
  const inside = await h.call('start');
  assert.equal(textOf(inside), startReplyText({ server, startedNow: false, tab: 'on-its-way' }));
  assert.equal(h.opened.length, 1, 'no flood of tabs');

  clock.time += 2_000;
  const after = await h.call('start');
  assert.equal(textOf(after), startReplyText({ server, startedNow: false, tab: 'reopened' }));
  assert.equal(h.opened.length, 2);
  assert.equal(h.opened[1], h.opened[0]);

  // The new tab counts from its own opening.
  const again = await h.call('start');
  assert.equal(textOf(again), startReplyText({ server, startedNow: false, tab: 'on-its-way' }));
  assert.equal(h.opened.length, 2);
});

test('start under MOONTIDE_NO_BROWSER never opens a tab and says so each time', async (t) => {
  const h = await harness(t, { noBrowser: true });
  const first = await h.call('start');
  const server = h.starter.current();
  assert.equal(textOf(first), startReplyText({ server, startedNow: true, tab: 'no-browser' }));
  assert.ok(textOf(first).startsWith('Moontide started.'));
  const second = await h.call('start');
  assert.ok(textOf(second).startsWith('Moontide is already started.'), textOf(second));
  assert.ok(textOf(second).includes('No tab was opened (MOONTIDE_NO_BROWSER=1)'), textOf(second));
  assert.equal(h.opened.length, 0);
});

test('before the start: get_code and stop say how to start; the page-free tools answer as before; nothing starts', async (t) => {
  const h = await harness(t);

  for (const name of ['get_code', 'stop']) {
    const reply = await h.call(name);
    assert.ok(reply.isError, `${name} fails before the start`);
    assert.equal(textOf(reply), NOT_STARTED_MESSAGE);
  }
  assert.ok(NOT_STARTED_MESSAGE.startsWith('Moontide is not started yet:'));

  const on = await h.call('set_page_requests', { state: 'on' });
  assert.ok(on.isError);
  assert.equal(textOf(on), notStartedForRequestsToolText());
  const off = await h.call('set_page_requests', { state: 'off' });
  assert.ok(!off.isError, textOf(off));
  assert.equal(textOf(off), PAGE_REQUESTS_ALREADY_OFF);
  await assert.rejects(
    () => h.client.getPrompt({ name: 'page-requests-on' }),
    (err) => err.message.includes(notStartedForRequestsText()),
  );

  const pageFree = [
    ['get_strudel_reference', {}],
    ['get_midi_instruments', {}],
    ['search_midi_sounds', { instrument: 'my-synth' }],
    ['save_midi_model', { model: {}, confirmed: false }],
    ['save_midi_catalog', { model: 'my-synth' }],
    ['list_history', {}],
    ['favorite_version', { id: 1, name: 'my favorite' }],
  ];
  for (const [name, args] of pageFree) {
    const reply = await h.call(name, args);
    assert.notEqual(textOf(reply), NOT_STARTED_MESSAGE, `${name} does not ask for the start`);
  }

  assert.equal(h.starter.current(), null, 'nothing started');
  assert.equal(h.webStarts(), 0);
  assert.equal(h.opened.length, 0);
});

test('a Session that was never given a page URL says Moontide is not started', async () => {
  const session = new Session();
  await assert.rejects(() => session.evaluate('s("bd")'), { message: NOT_STARTED_MESSAGE });
});

test('withoutPageLine removes exactly one page line and the blank line before a last one', () => {
  const page = 'Page: http://localhost:5757 (port 5757), in the browser tab titled "Moontide \u00b7 my-project \u00b7 5757".';
  assert.equal(withoutPageLine(`s("bd")\n\n${page}`), 's("bd")');
  assert.equal(withoutPageLine(`s("bd")\n\nNote: x\n${page}`), 's("bd")\n\nNote: x');
  assert.equal(withoutPageLine(`s("bd")\n\n${page}\nPage requests: later`), 's("bd")\n\nPage requests: later');
  assert.throws(() => withoutPageLine('s("bd")'), /exactly one page line/);
  assert.throws(() => withoutPageLine(`${page}\n${page}`), /exactly one page line/);
});
