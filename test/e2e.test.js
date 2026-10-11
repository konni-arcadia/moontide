import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startMcpClient, connectPage, createFakePage, withoutArmingLine, withoutPageLine, waitForUrl } from './helpers.js';
import { FIRST_CYCLE_WATCH_MS } from '../page/ui-state.js';

/** Waits a short tick so an unsolicited page frame has time to arrive before a tool call. */
function tick(ms = 50) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The exact note text, written out here (not imported) so any rewording of
// src/mcp.ts's GETTIME_ANCHOR_NOTE is a deliberate, visible test change.
const GETTIME_NOTE_TEXT =
  'Note: this code reads getTime(); an anchor taken from it restarts every time a later change re-sends this code, ' +
  'while a transition anchored with .timeline(id) keeps running across changes (see the transitions topic).';

// The exact t/f flag note text, written out here (not imported) for the same reason.
const FLAG_NOTE_TEXT =
  'Note: this code gives .when(), .struct() or .mask() a mini-notation string of t and f. ' +
  'In mini-notation t and f are plain strings (f is also a note name), so every one of those steps counts as true: ' +
  'write 1 and 0, and struct and mask also take ~ as a silent step (see the functions topic).';

test('moontide server end-to-end', async (t) => {
  const { client, url, port } = await startMcpClient();
  const fakePages = [];
  t.after(async () => {
    for (const page of fakePages) {
      page.ws.close();
    }
    await client.close();
  });

  await t.test('(a) lists get_code, set_code and stop tools', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    assert.ok(names.includes('get_code'), 'expected get_code to be listed');
    assert.ok(names.includes('set_code'), 'expected set_code to be listed');
    assert.ok(names.includes('stop'), 'expected stop to be listed');
  });

  await t.test('(b) get_code before anything played', async () => {
    const result = await client.callTool({ name: 'get_code', arguments: {} });
    assert.ok(!result.isError);
    // After the start, get_code names its page: address, port and the tab title (written out, not imported).
    assert.equal(
      result.content[0].text,
      `Nothing is playing yet.\n\nPage: ${url} (port ${port}), in the browser tab titled "Moontide \u00b7 my-project \u00b7 ${port}".`,
    );
  });

  await t.test('(c) set_code with no page connected fails fast', async () => {
    const start = Date.now();
    const result = await client.callTool({ name: 'set_code', arguments: { code: 's("bd")' } });
    const elapsed = Date.now() - start;
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes('No page connected'));
    assert.ok(result.content[0].text.includes(url));
    assert.ok(elapsed < 1000, `expected the immediate failure to take under 1000ms, took ${elapsed}ms`);
  });

  await t.test('(d) real page is served over HTTP', async () => {
    const res = await fetch(`${url}/`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
    const body = await res.text();
    assert.ok(body.includes('<strudel-editor'));
    assert.ok(
      body.includes('@strudel/repl@1.3.0/dist/index.js'),
      'the page pins @strudel/repl 1.3.0; after a pin change, re-verify page/midi-clock.js against the Cyclist (npm run check:reference, claim midi-clock-cyclist)',
    );
  });

  await t.test('(e) WebSocket upgrade rejects a foreign origin', async () => {
    await assert.rejects(() => connectPage(port, { origin: 'http://evil.example' }));
  });

  let confirmedCode;

  await t.test('(f) fake page connects, hello, set_code succeeds and round-trips', async () => {
    const page = await createFakePage(port);
    fakePages.push(page);
    assert.deepEqual(page.hello, { type: 'hello', code: '', stopped: false });

    page.setResponder((msg) => ({ type: 'evaluated', id: msg.id, ok: true, code: msg.code, audio: 'playing' }));

    confirmedCode = 's("bd sd")';
    const setResult = await client.callTool({ name: 'set_code', arguments: { code: confirmedCode } });
    assert.ok(!setResult.isError);
    assert.ok(setResult.content[0].text.startsWith('ok, playing'));
    assert.ok(setResult.content[0].text.includes(confirmedCode));

    const getResult = await client.callTool({ name: 'get_code', arguments: {} });
    // An authenticated page with no listener connected arms the reply: the line rides on every tool reply.
    assert.equal(withoutArmingLine(withoutPageLine(getResult.content[0].text)), confirmedCode);
  });

  await t.test('(g) failed evaluation reports the error and leaves the confirmed code untouched', async () => {
    const page = fakePages[0];
    page.setResponder((msg) => ({ type: 'evaluated', id: msg.id, ok: false, code: msg.code, error: 'boom' }));

    const failResult = await client.callTool({ name: 'set_code', arguments: { code: 's("hh*4")' } });
    assert.ok(failResult.isError);
    assert.ok(failResult.content[0].text.startsWith('Evaluation failed: boom'));
    assert.ok(withoutArmingLine(failResult.content[0].text).endsWith('The previous code is still playing.'));

    const getResult = await client.callTool({ name: 'get_code', arguments: {} });
    assert.equal(withoutArmingLine(withoutPageLine(getResult.content[0].text)), confirmedCode);
  });

  await t.test('(h) a second page connecting receives hello with the confirmed code', async () => {
    const page2 = await createFakePage(port);
    fakePages.push(page2);
    assert.deepEqual(page2.hello, { type: 'hello', code: confirmedCode, stopped: false });
  });

  let waitingCode;

  await t.test('(i) waiting-for-click result is distinct from "ok, playing"', async () => {
    const page2 = fakePages[1];
    page2.setResponder((msg) => ({
      type: 'evaluated',
      id: msg.id,
      ok: true,
      code: msg.code,
      audio: 'waiting-for-click',
    }));

    waitingCode = 's("cp")';
    const waitResult = await client.callTool({ name: 'set_code', arguments: { code: waitingCode } });
    assert.ok(!waitResult.isError);
    assert.ok(waitResult.content[0].text.startsWith("Waiting for the user's click:"));
    assert.ok(!waitResult.content[0].text.includes('ok, playing'));
  });

  await t.test('(j) a connected but silent page times out after ~5s with a distinct message', async () => {
    // page3 connects but never gets a responder — simulates a page that is open but not answering.
    const page3 = await createFakePage(port);
    fakePages.push(page3);

    const start = Date.now();
    const result = await client.callTool({ name: 'set_code', arguments: { code: 's("hh*8")' } });
    const elapsed = Date.now() - start;

    assert.ok(result.isError);
    assert.equal(withoutArmingLine(result.content[0].text), "The page isn't responding — check that it's still open and try again.");
    assert.ok(elapsed >= 4900, `expected the timeout to take close to 5000ms, took ${elapsed}ms`);
    assert.ok(elapsed < 8000, `expected the timeout to resolve promptly after 5000ms, took ${elapsed}ms`);

    const getResult = await client.callTool({ name: 'get_code', arguments: {} });
    assert.equal(withoutArmingLine(withoutPageLine(getResult.content[0].text)), waitingCode, 'the confirmed code must be untouched by a timed-out request');
  });

  // Letters continue after (j), the pre-existing timeout case.
  await t.test('(k) a page that closes its socket on evaluate fails fast with "No page connected"', async () => {
    const page = await createFakePage(port);
    fakePages.push(page);
    page.setResponder(() => {
      page.ws.close();
      return null;
    });
    // Swallow the responder's return value: onEveryMessage only sends a reply if truthy.
    const originalSend = page.ws.send.bind(page.ws);
    page.ws.send = () => {};

    const start = Date.now();
    const result = await client.callTool({ name: 'set_code', arguments: { code: 's("hh*2")' } });
    const elapsed = Date.now() - start;
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes('No page connected'));
    assert.ok(elapsed < 1000, `expected the failure to take under 1000ms, took ${elapsed}ms`);
    page.ws.send = originalSend;
  });

  await t.test('(l) set_code with only whitespace fails with the empty-code message', async () => {
    const result = await client.callTool({ name: 'set_code', arguments: { code: '   ' } });
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes('set_code needs non-empty Strudel code.'));
  });

  await t.test('(m) a failed evaluation with a known line number reports it', async () => {
    const page = await createFakePage(port);
    fakePages.push(page);
    page.setResponder((msg) => ({
      type: 'evaluated',
      id: msg.id,
      ok: false,
      code: msg.code,
      error: 'Unexpected token (3:5)',
      line: 3,
    }));

    const result = await client.callTool({ name: 'set_code', arguments: { code: 's("bd"' } });
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes(', line 3.'));
    assert.ok(withoutArmingLine(result.content[0].text).endsWith('The previous code is still playing.'));
  });

  await t.test('(n) an unsolicited runtime-error reaches Claude on the next tool call, once', async () => {
    const page = await createFakePage(port);
    fakePages.push(page);

    page.send({ type: 'runtime-error', message: 'sound nosuch not found' });
    await tick();

    const first = await client.callTool({ name: 'get_code', arguments: {} });
    assert.ok(first.content[0].text.includes('Runtime error while playing: sound nosuch not found.'));

    const second = await client.callTool({ name: 'get_code', arguments: {} });
    assert.ok(!second.content[0].text.includes('Runtime error while playing'));
  });

  await t.test('(o) the same runtime-error sent 3 times is reported once with a repeat count', async () => {
    const page = await createFakePage(port);
    fakePages.push(page);

    page.send({ type: 'runtime-error', message: 'sound nosuch not found' });
    page.send({ type: 'runtime-error', message: 'sound nosuch not found' });
    page.send({ type: 'runtime-error', message: 'sound nosuch not found' });
    await tick();

    const result = await client.callTool({ name: 'get_code', arguments: {} });
    assert.ok(
      result.content[0].text.includes('Runtime error while playing (repeated 3 times): sound nosuch not found.'),
    );
  });

  await t.test('(p) set_code whose page reports a runtime error before replying starts with the runtime-errors status line', async () => {
    const page = await createFakePage(port);
    fakePages.push(page);
    page.setResponder((msg) => {
      // The real page tags an error raised while querying the code it just
      // evaluated with that evaluate's own id, before sending the evaluated reply.
      page.send({ type: 'runtime-error', message: 'sound nosuch not found', evaluateId: msg.id });
      return { type: 'evaluated', id: msg.id, ok: true, code: msg.code, audio: 'playing' };
    });

    const result = await client.callTool({ name: 'set_code', arguments: { code: 's("nosuch")' } });
    assert.ok(!result.isError);
    assert.ok(result.content[0].text.startsWith('Playing, but with runtime errors (see below).'));
    assert.ok(!result.content[0].text.startsWith('ok, playing'));
    // The real server has a history store, so the tag now maps to a version.
    assert.match(result.content[0].text, /Runtime error while playing #\d+: sound nosuch not found\./);
  });

  await t.test('(p2) an untagged runtime-error from before a set_code is labeled as coming from an earlier version, and does not taint the new reply', async () => {
    // Reuses the page from (p), already tagged with its own last evaluate id — a fresh page
    // would attach with no tag at all, which would defeat this test (an untagged error would
    // then match the fresh "no tag" state instead of demonstrating the earlier-version case).
    const page = fakePages.at(-1);
    page.setResponder((msg) => {
      // Simulates an error raised by the code that was playing before this change — it
      // arrives untagged (or tagged with a superseded id), ahead of this evaluate's own reply.
      page.send({ type: 'runtime-error', message: 'stale sound nosuch' });
      return { type: 'evaluated', id: msg.id, ok: true, code: msg.code, audio: 'playing' };
    });

    const result = await client.callTool({ name: 'set_code', arguments: { code: 's("ok")' } });
    assert.ok(!result.isError);
    assert.ok(result.content[0].text.startsWith('ok, playing'));
    assert.ok(
      result.content[0].text.includes(
        'Runtime error from an earlier version (not the code playing now): stale sound nosuch.',
      ),
    );

    const getResult = await client.callTool({ name: 'get_code', arguments: {} });
    assert.ok(!getResult.content[0].text.includes('Runtime error from an earlier version'));
  });

  await t.test('(q) a failed set_code also carries pending runtime-error lines after its error text', async () => {
    const page = await createFakePage(port);
    fakePages.push(page);
    page.setResponder((msg) => {
      page.send({ type: 'runtime-error', message: 'leftover error' });
      return { type: 'evaluated', id: msg.id, ok: false, code: msg.code, error: 'syntax boom' };
    });

    const result = await client.callTool({ name: 'set_code', arguments: { code: 's(' } });
    assert.ok(result.isError);
    assert.ok(result.content[0].text.startsWith('Evaluation failed: syntax boom'));
    assert.ok(result.content[0].text.includes('Runtime error while playing: leftover error.'));
  });

  await t.test('(r) set_code stays well under the 2s budget even when the page waits the full first-cycle watch window', async () => {
    const page = await createFakePage(port);
    fakePages.push(page);
    page.setResponder(async (msg) => {
      await tick(FIRST_CYCLE_WATCH_MS);
      return { type: 'evaluated', id: msg.id, ok: true, code: msg.code, audio: 'playing' };
    });

    const start = Date.now();
    const result = await client.callTool({ name: 'set_code', arguments: { code: 's("bd")' } });
    const elapsed = Date.now() - start;
    assert.ok(!result.isError);
    assert.ok(result.content[0].text.startsWith('ok, playing'));
    assert.ok(elapsed < 2000, `expected under 2000ms, took ${elapsed}ms`);
  });

  await t.test('(s) a runtime-error frame without a message is dropped by the server', async () => {
    const page = await createFakePage(port);
    fakePages.push(page);
    page.send({ type: 'runtime-error' });
    await tick();

    const result = await client.callTool({ name: 'get_code', arguments: {} });
    assert.ok(!result.content[0].text.includes('Runtime error while playing'));
  });

  await t.test('(t) stop with a fake page that answers returns the stopped message', async () => {
    const page = await createFakePage(port);
    fakePages.push(page);
    page.setStopResponder((msg) => ({ type: 'stop-result', id: msg.id }));

    const result = await client.callTool({ name: 'stop', arguments: {} });
    assert.ok(!result.isError);
    assert.equal(
      withoutArmingLine(result.content[0].text),
      'ok, stopped. The code stays in the page; call set_code to start playing again.',
    );
  });

  await t.test('(u) get_code after a stop includes the stopped note', async () => {
    const result = await client.callTool({ name: 'get_code', arguments: {} });
    assert.ok(result.content[0].text.includes('Note: sound is stopped. Call set_code to start playing again.'));
  });

  await t.test('(v) stop again succeeds with the same text (idempotent)', async () => {
    const result = await client.callTool({ name: 'stop', arguments: {} });
    assert.ok(!result.isError);
    assert.equal(
      withoutArmingLine(result.content[0].text),
      'ok, stopped. The code stays in the page; call set_code to start playing again.',
    );
  });

  await t.test('(w) set_code after a stop plays again, and the following get_code has no stopped note', async () => {
    const page = fakePages.at(-1);
    page.setResponder((msg) => ({ type: 'evaluated', id: msg.id, ok: true, code: msg.code, audio: 'playing' }));

    const setResult = await client.callTool({ name: 'set_code', arguments: { code: 's("bd cp")' } });
    assert.ok(!setResult.isError);
    assert.ok(setResult.content[0].text.startsWith('ok, playing'));

    const getResult = await client.callTool({ name: 'get_code', arguments: {} });
    assert.ok(!getResult.content[0].text.includes('Note: sound is stopped'));
  });

  await t.test('(x) a fake page sending user-stopped makes get_code report the stopped note', async () => {
    const page = fakePages.at(-1);
    page.send({ type: 'user-stopped' });
    await tick();

    const result = await client.callTool({ name: 'get_code', arguments: {} });
    assert.ok(result.content[0].text.includes('Note: sound is stopped. Call set_code to start playing again.'));

    // Clear the stopped state so subsequent tests in this file start from a known state.
    page.setResponder((msg) => ({ type: 'evaluated', id: msg.id, ok: true, code: msg.code, audio: 'playing' }));
    await client.callTool({ name: 'set_code', arguments: { code: 's("bd")' } });
  });

  await t.test('(y) a fake page connecting while stopped receives hello with stopped true', async () => {
    const stopPage = await createFakePage(port);
    fakePages.push(stopPage);
    stopPage.setStopResponder((msg) => ({ type: 'stop-result', id: msg.id }));
    const stopResult = await client.callTool({ name: 'stop', arguments: {} });
    assert.ok(!stopResult.isError);

    const page = await createFakePage(port);
    fakePages.push(page);
    assert.equal(page.hello.stopped, true);
  });

  await t.test('(z) a set_code answered with audio "stopped" reports the user pressed Stop, never "ok, playing"', async () => {
    const page = fakePages.at(-1);
    page.setResponder((msg) => ({ type: 'evaluated', id: msg.id, ok: true, code: msg.code, audio: 'stopped' }));

    const result = await client.callTool({ name: 'set_code', arguments: { code: 's("bd cp")' } });
    assert.ok(!result.isError);
    assert.ok(
      result.content[0].text.startsWith(
        'Stopped: the user pressed Stop in the page while this code was starting. The code is loaded; call set_code to play it.',
      ),
    );
    assert.ok(result.content[0].text.includes('s("bd cp")'));
    assert.ok(!result.content[0].text.startsWith('ok, playing'));
  });

  // Letters continue after (z).
  await t.test('(aa) a fake page sends a successful hand-eval; get_code starts with that code and carries the hand-edit note', async () => {
    const page = await createFakePage(port);
    fakePages.push(page);

    page.send({ type: 'hand-eval', ok: true, code: 's("hand")' });
    await tick();

    const result = await client.callTool({ name: 'get_code', arguments: {} });
    assert.ok(result.content[0].text.startsWith('s("hand")'));
    assert.ok(
      result.content[0].text.includes('Note: this code was edited by hand in the page since your last change.'),
    );
  });

  await t.test('(bb) a second get_code still carries the hand-edit note', async () => {
    const result = await client.callTool({ name: 'get_code', arguments: {} });
    assert.ok(
      result.content[0].text.includes('Note: this code was edited by hand in the page since your last change.'),
    );
  });

  await t.test('(cc) stop also carries the hand-edit note', async () => {
    const page = fakePages.at(-1);
    page.setStopResponder((msg) => ({ type: 'stop-result', id: msg.id }));

    const result = await client.callTool({ name: 'stop', arguments: {} });
    assert.ok(!result.isError);
    assert.ok(
      result.content[0].text.includes('Note: this code was edited by hand in the page since your last change.'),
    );
  });

  await t.test('(dd) set_code after a hand edit reports the replaced-hand-edit note', async () => {
    const page = fakePages.at(-1);
    page.setResponder((msg) => ({ type: 'evaluated', id: msg.id, ok: true, code: msg.code, audio: 'playing' }));

    const result = await client.callTool({ name: 'set_code', arguments: { code: 's("claude")' } });
    assert.ok(!result.isError);
    assert.ok(
      result.content[0].text.includes(
        'Note: the code you replaced had been edited by hand in the page since your last change.',
      ),
    );
  });

  await t.test('(ee) the next get_code carries neither hand-edit note', async () => {
    const result = await client.callTool({ name: 'get_code', arguments: {} });
    assert.ok(!result.content[0].text.includes('edited by hand'));
  });

  await t.test('(ff) a failed hand-eval reaches the next get_code once, with the error and the line', async () => {
    const page = await createFakePage(port);
    fakePages.push(page);

    page.send({ type: 'hand-eval', ok: false, error: 'Unexpected token (2:1)', line: 2 });
    await tick();

    const first = await client.callTool({ name: 'get_code', arguments: {} });
    assert.ok(
      first.content[0].text.includes(
        'Note: an edit evaluated by hand in the page failed: Unexpected token (2:1), line 2.',
      ),
    );

    const second = await client.callTool({ name: 'get_code', arguments: {} });
    assert.ok(!second.content[0].text.includes('edited by hand in the page failed'));
  });

  await t.test('(gg) a failed stop also carries the pending hand-edit note', async () => {
    const page = await createFakePage(port);
    fakePages.push(page);

    page.send({ type: 'hand-eval', ok: true, code: 's("hand-wr02")' });
    await tick();

    // Same "page closes its socket mid-request" pattern as (k): forces a fast "No page
    // connected" failure instead of the 5s reply timeout.
    page.setStopResponder(() => {
      page.ws.close();
      return null;
    });
    const originalSend = page.ws.send.bind(page.ws);
    page.ws.send = () => {};

    const result = await client.callTool({ name: 'stop', arguments: {} });
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes('No page connected'));
    assert.ok(
      result.content[0].text.includes('Note: this code was edited by hand in the page since your last change.'),
      'a failed stop must carry the pending hand-edit note, same as a failed set_code',
    );

    page.ws.send = originalSend;
  });

  // Letters continue after (gg): the getTime() note case.
  await t.test('(hh) a successful hand-eval then set_code with a getTime() anchor: the reply ends with the getTime note, after the hand-edit-replaced note, and the code reaches the page unchanged', async () => {
    const page = await createFakePage(port);
    fakePages.push(page);

    page.send({ type: 'hand-eval', ok: true, code: 's("hand-hh")' });
    await tick();

    let receivedCode;
    page.setResponder((msg) => {
      receivedCode = msg.code;
      return { type: 'evaluated', id: msg.id, ok: true, code: msg.code, audio: 'playing' };
    });

    const code =
      'const anchorStart = getTime()\ns("bd*4").lpf(signal((t) => Math.max(0, Math.min(1, t - anchorStart))).range(400, 2000))';
    const result = await client.callTool({ name: 'set_code', arguments: { code } });
    assert.ok(!result.isError);
    assert.ok(result.content[0].text.startsWith('ok, playing'));
    const lines = result.content[0].text.split('\n');
    assert.equal(lines.at(-1), GETTIME_NOTE_TEXT);
    const handEditIndex = result.content[0].text.indexOf('Note: the code you replaced had been edited by hand');
    const noteIndex = result.content[0].text.indexOf(GETTIME_NOTE_TEXT);
    assert.ok(handEditIndex >= 0, 'expected the hand-edit-replaced note to be present');
    assert.ok(handEditIndex < noteIndex, 'expected the hand-edit-replaced note before the getTime note');
    assert.equal(receivedCode, code, 'the code the page received must be strictly equal to the code sent');
  });

  await t.test('(ii) set_code with code containing both getTime with a space before its parenthesis and .timeline(1): the reply still ends with the note', async () => {
    const page = await createFakePage(port);
    fakePages.push(page);
    page.setResponder((msg) => ({ type: 'evaluated', id: msg.id, ok: true, code: msg.code, audio: 'playing' }));

    const code = 'const old = getTime ()\ns("bd*4").lpf(signal((t) => t).range(400, 2000).timeline(1))';
    const result = await client.callTool({ name: 'set_code', arguments: { code } });
    assert.ok(!result.isError);
    const lines = result.content[0].text.split('\n');
    assert.equal(lines.at(-1), GETTIME_NOTE_TEXT);
  });

  await t.test('(jj) set_code with a .timeline(id) anchor and no getTime: the reply carries no getTime note', async () => {
    const page = await createFakePage(port);
    fakePages.push(page);
    page.setResponder((msg) => ({ type: 'evaluated', id: msg.id, ok: true, code: msg.code, audio: 'playing' }));

    const code = 's("bd*4").lpf(signal((t) => t).range(400, 2000).timeline(1))';
    const result = await client.callTool({ name: 'set_code', arguments: { code } });
    assert.ok(!result.isError);
    assert.ok(!result.content[0].text.includes('re-sends this code'));
  });

  await t.test('(kk) a failed set_code whose code reads getTime( carries no note', async () => {
    const page = await createFakePage(port);
    fakePages.push(page);
    page.setResponder((msg) => ({ type: 'evaluated', id: msg.id, ok: false, code: msg.code, error: 'boom' }));

    const code = 'const start = getTime()\ns("bd")';
    const result = await client.callTool({ name: 'set_code', arguments: { code } });
    assert.ok(result.isError);
    assert.ok(result.content[0].text.startsWith('Evaluation failed: boom'));
    assert.ok(!result.content[0].text.includes('re-sends this code'));
  });

  // Letters continue after (kk): the t/f flag note case.
  await t.test('(ll) set_code with .when("<f t>", ...): the reply ends with the t/f flag note, and the code reaches the page unchanged', async () => {
    const page = await createFakePage(port);
    fakePages.push(page);
    let receivedCode;
    page.setResponder((msg) => {
      receivedCode = msg.code;
      return { type: 'evaluated', id: msg.id, ok: true, code: msg.code, audio: 'playing' };
    });

    const code = 's("bd*4").when("<f t>", (x) => x.fast(2))';
    const result = await client.callTool({ name: 'set_code', arguments: { code } });
    assert.ok(!result.isError);
    assert.ok(result.content[0].text.startsWith('ok, playing'));
    assert.equal(result.content[0].text.split('\n').at(-1), FLAG_NOTE_TEXT);
    assert.equal(receivedCode, code, 'the code the page received must be strictly equal to the code sent');
  });

  await t.test('(mm) set_code with a t/f .struct() and getTime(): the flag note is the line right before the getTime note', async () => {
    const page = await createFakePage(port);
    fakePages.push(page);
    page.setResponder((msg) => ({ type: 'evaluated', id: msg.id, ok: true, code: msg.code, audio: 'playing' }));

    const code = 'const start = getTime()\ns("bd").struct("t f t t")';
    const result = await client.callTool({ name: 'set_code', arguments: { code } });
    assert.ok(!result.isError);
    const lines = result.content[0].text.split('\n');
    assert.equal(lines.at(-1), GETTIME_NOTE_TEXT);
    assert.equal(lines.at(-2), FLAG_NOTE_TEXT);
  });

  await t.test('(nn) set_code with a const t/f string passed by name to .when(): the reply carries the flag note', async () => {
    const page = await createFakePage(port);
    fakePages.push(page);
    page.setResponder((msg) => ({ type: 'evaluated', id: msg.id, ok: true, code: msg.code, audio: 'playing' }));

    const code = 'const fear = "<f f t>"\nchord("C").when(fear, (x) => x.add(1))';
    const result = await client.callTool({ name: 'set_code', arguments: { code } });
    assert.ok(!result.isError);
    assert.equal(result.content[0].text.split('\n').at(-1), FLAG_NOTE_TEXT);
  });

  await t.test('(oo) set_code with .struct("1 0 1 1") carries no flag note, and a failed set_code with a t/f string carries none either', async () => {
    const page = await createFakePage(port);
    fakePages.push(page);
    page.setResponder((msg) => ({ type: 'evaluated', id: msg.id, ok: true, code: msg.code, audio: 'playing' }));
    const clean = await client.callTool({ name: 'set_code', arguments: { code: 's("bd").struct("1 0 1 1")' } });
    assert.ok(!clean.isError);
    assert.ok(!clean.content[0].text.includes('mini-notation string of t and f'));

    page.setResponder((msg) => ({ type: 'evaluated', id: msg.id, ok: false, code: msg.code, error: 'boom' }));
    const failed = await client.callTool({ name: 'set_code', arguments: { code: 's("bd").struct("t f t t")' } });
    assert.ok(failed.isError);
    assert.ok(failed.content[0].text.startsWith('Evaluation failed: boom'));
    assert.ok(!failed.content[0].text.includes('mini-notation string of t and f'));
  });
});

test('stop with no page connected fails fast with the exact no-page text', async (t) => {
  const { client, url } = await startMcpClient();
  t.after(async () => {
    await client.close();
  });

  const start = Date.now();
  const result = await client.callTool({ name: 'stop', arguments: {} });
  const elapsed = Date.now() - start;
  assert.ok(result.isError);
  assert.equal(result.content[0].text, `No page connected — open ${url} and click to start sound.`);
  assert.ok(elapsed < 1000, `expected the immediate failure to take under 1000ms, took ${elapsed}ms`);
});

// The replies of a change that waits for a bar or phrase line, the tempo line and the
// notes when a waiting change is lost. The exact texts are written out here so a rewording is a visible change.
test('a change that waits for a bar or phrase line: replies, tempo, get_code and canceled notes', async (t) => {
  const { client, port } = await startMcpClient();
  const page = await createFakePage(port);
  t.after(async () => {
    page.ws.close();
    await client.close();
  });

  const evaluates = [];
  /** What the fake page answers to the next evaluate: { pending, bpm, audio } or nothing special. */
  let answer = {};
  page.setResponder((msg) => {
    evaluates.push(msg);
    const reply = { type: 'evaluated', id: msg.id, ok: true, code: msg.code, audio: answer.audio ?? 'playing' };
    if (answer.pending !== undefined) reply.pending = answer.pending;
    if (answer.bpm !== undefined) reply.bpm = answer.bpm;
    return reply;
  });
  const textOf = (result) => withoutArmingLine(result.content[0].text);
  const noteLines = (text) => text.split('\n').filter((line) => line.startsWith('Note:') || line.startsWith('Tempo'));

  await t.test('phraseCycles without at: phrase is a tool error and nothing reaches the page', async () => {
    const alone = await client.callTool({ name: 'set_code', arguments: { code: 's("bd")', phraseCycles: 8 } });
    assert.ok(alone.isError);
    assert.ok(alone.content[0].text.includes("phraseCycles applies only with at: 'phrase'"));
    const withBar = await client.callTool({ name: 'set_code', arguments: { code: 's("bd")', at: 'bar', phraseCycles: 8 } });
    assert.ok(withBar.isError);
    assert.ok(withBar.content[0].text.includes("phraseCycles applies only with at: 'phrase'"));
    assert.equal(evaluates.length, 0, 'the fake page received no evaluate message');
    // Out of range is refused by the schema.
    const tooShort = await client.callTool({ name: 'set_code', arguments: { code: 's("bd")', at: 'phrase', phraseCycles: 1 } });
    assert.ok(tooShort.isError);
    assert.equal(evaluates.length, 0);
  });

  await t.test('the tempo line comes on the first reply, then only when the tempo changes', async () => {
    answer = { bpm: 120 };
    const first = await client.callTool({ name: 'set_code', arguments: { code: 's("bd")' } });
    assert.ok(!first.isError);
    assert.ok(textOf(first).startsWith('ok, playing'));
    assert.ok(noteLines(textOf(first)).includes('Tempo: 120 BPM.'));
    const second = await client.callTool({ name: 'set_code', arguments: { code: 's("bd sd")' } });
    assert.ok(!textOf(second).includes('Tempo'));
    answer = { bpm: 96.7 };
    const third = await client.callTool({ name: 'set_code', arguments: { code: 's("bd cp")' } });
    assert.ok(noteLines(textOf(third)).includes('Tempo: 96.7 BPM.'));
  });

  await t.test('at bar: the reply says the line, get_code keeps the old code and says a change waits, the takeover moves it', async () => {
    answer = { pending: { cycle: 12, seconds: 6.2 }, bpm: 96 };
    const waiting = await client.callTool({ name: 'set_code', arguments: { code: 's("hh*8")', at: 'bar' } });
    assert.ok(!waiting.isError);
    const text = textOf(waiting);
    assert.ok(
      text.startsWith('ok. The change takes over at cycle 12 (next bar), in about 6.2 s. The music keeps playing until then.'),
      text,
    );
    assert.ok(text.includes('s("hh*8")'));
    assert.ok(noteLines(text).includes('Tempo from cycle 12: 96 BPM.'), text);
    const request = evaluates.at(-1);
    assert.equal(request.at, 'bar');
    assert.equal('phraseCycles' in request, false);

    const during = textOf(await client.callTool({ name: 'get_code', arguments: {} }));
    assert.ok(during.startsWith('s("bd cp")'), 'get_code answers with the code that plays');
    assert.ok(
      noteLines(during)[0] === 'Note: a change waits to take over at cycle 12 (next bar); the code above plays until then.',
      during,
    );

    page.send({ type: 'takeover', id: request.id });
    await tick();
    const after = textOf(await client.callTool({ name: 'get_code', arguments: {} }));
    assert.equal(withoutPageLine(after), 's("hh*8")');
  });

  await t.test('at phrase: the reply says next phrase with whole seconds from 10, and phraseCycles travels', async () => {
    answer = { pending: { cycle: 16, seconds: 14.4 }, bpm: 96 };
    const waiting = await client.callTool({ name: 'set_code', arguments: { code: 's("cp*4")', at: 'phrase', phraseCycles: 8 } });
    assert.ok(
      textOf(waiting).startsWith('ok. The change takes over at cycle 16 (next phrase), in about 14 s. The music keeps playing until then.'),
      textOf(waiting),
    );
    assert.ok(!textOf(waiting).includes('Tempo'), 'the tempo was told already');
    const request = evaluates.at(-1);
    assert.equal(request.at, 'phrase');
    assert.equal(request.phraseCycles, 8);
    const during = textOf(await client.callTool({ name: 'get_code', arguments: {} }));
    assert.ok(noteLines(during)[0].includes('(next phrase)'), during);
  });

  await t.test('a newer change that replaced the waiting one is told once, in the next tool reply', async () => {
    const waitingRequest = evaluates.at(-1);
    page.send({ type: 'takeover-canceled', id: waitingRequest.id, reason: 'replaced' });
    await tick();
    const first = textOf(await client.callTool({ name: 'get_code', arguments: {} }));
    assert.ok(
      first.includes('Note: the change you sent for cycle 16 did not take over: a newer change replaced it before then.'),
      first,
    );
    assert.ok(!first.includes('a change waits'), 'nothing waits any more');
    const second = textOf(await client.callTool({ name: 'get_code', arguments: {} }));
    assert.ok(!second.includes('did not take over'), 'the note comes once');
  });

  await t.test('Stop that cancels a waiting change is told once with the stop line', async () => {
    answer = { pending: { cycle: 20, seconds: 3.1 } };
    await client.callTool({ name: 'set_code', arguments: { code: 's("sd*2")', at: 'bar' } });
    const waitingRequest = evaluates.at(-1);
    page.send({ type: 'takeover-canceled', id: waitingRequest.id, reason: 'stop' });
    await tick();
    const first = textOf(await client.callTool({ name: 'get_code', arguments: {} }));
    assert.ok(first.includes('Note: the change you sent for cycle 20 did not take over: the music was stopped before then.'), first);
    const second = textOf(await client.callTool({ name: 'get_code', arguments: {} }));
    assert.ok(!second.includes('did not take over'));
  });

  await t.test('at bar answered pending while the audio waits for a click says so instead of promising seconds', async () => {
    answer = { pending: { cycle: 24, seconds: 2.5 }, audio: 'waiting-for-click' };
    const waiting = await client.callTool({ name: 'set_code', arguments: { code: 's("rim*2")', at: 'bar' } });
    assert.ok(!waiting.isError);
    const text = textOf(waiting);
    assert.ok(text.includes('takes over at cycle 24 (next bar)'), text);
    assert.ok(text.includes("Waiting for the user's click"), text);
    assert.ok(!text.includes('The music keeps playing until then'), text);
    page.send({ type: 'takeover-canceled', id: evaluates.at(-1).id, reason: 'stop' });
    await tick();
    await client.callTool({ name: 'get_code', arguments: {} });
  });

  await t.test('at bar answered without a pending change says nothing was playing; at now never does', async () => {
    answer = {};
    const timed = await client.callTool({ name: 'set_code', arguments: { code: 's("bd*2")', at: 'bar' } });
    assert.ok(textOf(timed).startsWith('ok, playing'));
    assert.ok(noteLines(textOf(timed)).includes('Note: nothing was playing, so the change took over at once.'));
    const phrase = await client.callTool({ name: 'set_code', arguments: { code: 's("bd*3")', at: 'phrase' } });
    assert.ok(textOf(phrase).includes('Note: nothing was playing, so the change took over at once.'));
    const now = await client.callTool({ name: 'set_code', arguments: { code: 's("bd*4")', at: 'now' } });
    assert.ok(!textOf(now).includes('nothing was playing'));
    const plain = await client.callTool({ name: 'set_code', arguments: { code: 's("bd*5")' } });
    assert.ok(!textOf(plain).includes('nothing was playing'));
  });

  await t.test('restore_version carries the tempo line when the tempo changed', async () => {
    answer = { bpm: 72 };
    const restored = await client.callTool({ name: 'restore_version', arguments: { id: 1 } });
    assert.ok(!restored.isError, restored.content[0].text);
    assert.ok(noteLines(textOf(restored)).includes('Tempo: 72 BPM.'), textOf(restored));
    const again = await client.callTool({ name: 'restore_version', arguments: { id: 1 } });
    assert.ok(!textOf(again).includes('Tempo'));
  });
});

test('the start reply and get_code name the same page, port and tab title', async (t) => {
  const server = await startMcpClient({ start: false });
  t.after(() => server.client.close());

  const started = await server.client.callTool({ name: 'start', arguments: {} });
  assert.ok(!started.isError, JSON.stringify(started));
  const { url, port } = await waitForUrl(() => server.stderrText, 10000);
  const line = `Page: ${url} (port ${port}), in the browser tab titled "Moontide \u00b7 my-project \u00b7 ${port}".`;
  assert.ok(started.content[0].text.includes(line), started.content[0].text);

  const code = await server.client.callTool({ name: 'get_code', arguments: {} });
  assert.ok(code.content[0].text.split('\n').includes(line), code.content[0].text);
});
