// The page-to-Claude channel through a real MCP client: the arming line, live delivery to a real
// listener, re-arm when the listener ends, and the hand-over in a tool reply when nobody listens.
// Pages are fake (a raw WebSocket); the server, the MCP client and the listener are real.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  connectPage,
  createFakePage,
  fetchPageToken,
  listenerCommandFrom,
  startMcpClient,
  waitForExit,
  withoutPageLine,
  withoutStructureTemplate,
} from './helpers.js';
import { REQUEST_LINE_PREFIX, requestLine } from '../dist/ask.js';
import { MAX_REQUEST_LINE_BYTES } from '../dist/protocol.js';

const ARMING_PREFIX = 'Page requests: no listener is connected.';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One MCP client on a real server, plus cleanup of everything a test opens. */
async function startScenario(t) {
  const server = await startMcpClient();
  const cleanup = [];
  t.after(async () => {
    for (const fn of cleanup) {
      try {
        await fn();
      } catch {
        // already closed
      }
    }
    await server.client.close();
  });
  const getCode = async () => {
    const result = await server.client.callTool({ name: 'get_code', arguments: {} });
    assert.ok(!result.isError, JSON.stringify(result));
    return result.content[0].text;
  };
  // Not a spread of `server`: that would freeze the stderrText getter at its current value.
  return {
    client: server.client,
    port: server.port,
    cleanup,
    getCode,
    get stderrText() {
      return server.stderrText;
    },
  };
}

/** The server's stderr reaches the test through a pipe, a moment after the page frame: poll for it. */
// The waits are upper bounds, generous for slow hosted runners (a 2-vCPU Windows runner spawns the listener
// process slowly); a passing run never waits for them.
async function waitForStderr(scenario, needle, timeoutMs = 10000) {
  const start = Date.now();
  while (!scenario.stderrText.includes(needle)) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for "${needle}" in the server log:\n${scenario.stderrText}`);
    }
    await sleep(10);
  }
}

/** An independent collector: the fake page's own relay swallows what it does not handle. */
function collectFrames(page) {
  const frames = [];
  page.ws.on('message', (data) => {
    frames.push(JSON.parse(data.toString()));
  });
  return {
    frames,
    async waitFor(predicate, what, timeoutMs = 10000) {
      const start = Date.now();
      while (!frames.some(predicate)) {
        if (Date.now() - start > timeoutMs) {
          throw new Error(`Timed out waiting for ${what}; got ${JSON.stringify(frames)}`);
        }
        await sleep(10);
      }
      return frames.find(predicate);
    },
  };
}

/**
 * Waits until the server tells the page that requests are live, which it does when the listener has
 * connected. A fixed pause was not enough on a slow runner: a request sent before the listener connects
 * takes the waiting path and is acknowledged differently.
 */
async function listenerLive(trusted) {
  await trusted.waitFor((m) => m.type === 'page-requests' && m.live === true, 'the page told that requests are live');
}

/** A fake page that has authenticated with the token it was served. */
async function trustedPage(scenario) {
  // createFakePage authenticates before it returns (ask-auth ok true, then hello).
  const page = await createFakePage(scenario.port);
  scenario.cleanup.push(() => page.ws.close());
  return { page, ...collectFrames(page) };
}

function ask(page, id, text, extra = {}) {
  page.send({
    type: 'ask',
    id,
    text,
    context: { kind: 'session' },
    chip: 'Whole session',
    current: null,
    ...extra,
  });
}

/** Starts the real listener from the exact command found in a tool reply; collects its stdout. */
function startListenerFrom(replyText, scenario) {
  const { scriptPath, port, token } = listenerCommandFrom(replyText);
  const child = spawn(process.execPath, [scriptPath, String(port), token], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  scenario.cleanup.push(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
    }
  });
  return {
    child,
    token,
    get stdout() {
      return stdout;
    },
    lines() {
      return stdout === '' ? [] : stdout.replace(/\n$/, '').split('\n');
    },
    async waitForLines(count, what, timeoutMs = 10000) {
      const start = Date.now();
      while (this.lines().length < count) {
        if (Date.now() - start > timeoutMs) {
          throw new Error(`Timed out waiting for ${what}; stdout so far: ${JSON.stringify(stdout)}`);
        }
        await sleep(10);
      }
    },
  };
}

/**
 * Proves that earlier, refused requests printed nothing. A valid follow-up goes down the same path to the same
 * listener, and the server handles page frames in order, so once the follow-up line has arrived on the listener's
 * stdout, a refused request that was going to print would have printed before it. `printedBefore` is the number of
 * lines the listener had already printed legitimately. Nothing here depends on a fixed pause.
 */
async function expectNothingPrintedBefore(trusted, listener, printedBefore, followUpId) {
  ask(trusted.page, followUpId, 'a valid request after the refused one');
  await listener.waitForLines(printedBefore + 1, `the line of ${followUpId}`);
  const lines = listener.lines();
  assert.equal(lines.length, printedBefore + 1, `only the follow-up was printed after the refused request, got ${JSON.stringify(lines)}`);
  const followUp = JSON.parse(lines[lines.length - 1].slice(REQUEST_LINE_PREFIX.length + 1));
  assert.equal(followUp.id, followUpId, 'the last printed line is the follow-up');
}

test('ask e2e: a page that never authenticates is not the active page and changes no tool reply', async (t) => {
  const scenario = await startScenario(t);
  const page = await connectPage(scenario.port);
  scenario.cleanup.push(() => page.close());

  assert.equal(withoutStructureTemplate(withoutPageLine(await scenario.getCode())), 'Nothing is playing yet.');

  const set = await scenario.client.callTool({ name: 'set_code', arguments: { code: 's("bd sd")' } });
  assert.equal(set.isError, true);
  assert.ok(set.content[0].text.startsWith('No page connected'), set.content[0].text);
  assert.ok(!set.content[0].text.includes(ARMING_PREFIX));
  assert.equal(withoutStructureTemplate(withoutPageLine(await scenario.getCode())), 'Nothing is playing yet.');
});

test('ask e2e: arming line, live delivery, re-arm and hand-over in a tool reply', async (t) => {
  const scenario = await startScenario(t);
  const trusted = await trustedPage(scenario);

  // Once a page has authenticated, get_code ends with the arming line.
  const armed = await scenario.getCode();
  assert.ok(armed.startsWith('Nothing is playing yet.'), armed);
  const armingAt = armed.lastIndexOf(ARMING_PREFIX);
  assert.ok(armingAt > 0, 'get_code must end with the arming line once a page has authenticated');
  assert.ok(!armed.slice(armingAt).includes('\n'), 'the arming line is one line, last');

  // The listener started from that exact command receives the next request, verbatim.
  const listener = startListenerFrom(armed, scenario);
  await listenerLive(trusted);
  assert.equal(listener.stdout, '', 'the listener prints nothing when it connects');
  const liveText = 'make the drums shorter';
  ask(trusted.page, 'live-1', liveText);
  await listener.waitForLines(1, 'the live request line');
  const [line] = listener.lines();
  assert.ok(line.startsWith(`${REQUEST_LINE_PREFIX} `), line);
  const request = JSON.parse(line.slice(REQUEST_LINE_PREFIX.length + 1));
  assert.equal(request.text, liveText);
  assert.deepEqual(request.context, { kind: 'session' });
  assert.equal(request.chip, 'Whole session');
  assert.equal(request.current, null);
  const received = await trusted.waitFor(
    (m) => m.type === 'ask-result' && m.id === 'live-1' && m.status === 'received',
    'ask-result received for the live request',
  );
  assert.equal(received.status, 'received');

  // While the listener is connected the arming line is gone.
  const whileListening = await scenario.getCode();
  assert.equal(withoutStructureTemplate(withoutPageLine(whileListening)), 'Nothing is playing yet.');
  assert.ok(!listener.stdout.includes(listener.token), 'the listener never prints its token');

  // When the listener ends, the arming line comes back.
  listener.child.kill();
  await waitForExit(listener.child, 10000);
  // The server notices the closed socket a moment later; poll with the same generous bound as the other waits.
  let afterEnd = await scenario.getCode();
  const armingDeadline = Date.now() + 10000;
  while (!afterEnd.includes(ARMING_PREFIX)) {
    if (Date.now() > armingDeadline) {
      throw new Error(`Timed out waiting for the arming line to come back after the listener ended:\n${afterEnd}`);
    }
    await sleep(20);
    afterEnd = await scenario.getCode();
  }

  // With no listener a request waits, and the next tool reply carries its line once.
  const waitingText = 'make the hats quieter\nand shorter';
  ask(trusted.page, 'wait-1', waitingText);
  const waiting = await trusted.waitFor(
    (m) => m.type === 'ask-result' && m.id === 'wait-1' && m.status === 'waiting',
    'ask-result waiting',
  );
  assert.equal(waiting.waiting, 1);

  const handedOver = await scenario.getCode();
  const requestLines = handedOver.split('\n').filter((l) => l.startsWith(REQUEST_LINE_PREFIX));
  assert.equal(requestLines.length, 1, handedOver);
  assert.equal(JSON.parse(requestLines[0].slice(REQUEST_LINE_PREFIX.length + 1)).text, waitingText);
  assert.ok(
    handedOver.indexOf(REQUEST_LINE_PREFIX) < handedOver.indexOf(ARMING_PREFIX),
    'the request line comes before the arming line',
  );
  const ack = await trusted.waitFor((m) => m.type === 'ask-received', 'ask-received');
  assert.deepEqual(ack.ids, ['wait-1']);

  const again = await scenario.getCode();
  assert.ok(!again.includes(REQUEST_LINE_PREFIX), 'a request line is handed over once');
});

test('ask e2e: a page with a wrong token is refused and logged; no tool reply arms for it', async (t) => {
  const scenario = await startScenario(t);
  const page = await connectPage(scenario.port);
  scenario.cleanup.push(() => page.close());
  const frames = [];
  page.on('message', (data) => frames.push(JSON.parse(data.toString())));

  const wrongToken = (await fetchPageToken(scenario.port)).split('').reverse().join('');
  page.send(JSON.stringify({ type: 'page-auth', token: wrongToken }));
  for (let i = 0; i < 200 && !frames.some((m) => m.type === 'ask-auth'); i++) {
    await sleep(10);
  }
  // No hello comes before the answer: the wrong token attaches nothing.
  assert.deepEqual(frames[0], { type: 'ask-auth', ok: false });

  page.send(
    JSON.stringify({
      type: 'ask',
      id: 'bad-1',
      text: 'make the drums shorter',
      context: { kind: 'session' },
      chip: 'Whole session',
      current: null,
    }),
  );
  for (let i = 0; i < 200 && !frames.some((m) => m.type === 'ask-result'); i++) {
    await sleep(10);
  }
  const result = frames.find((m) => m.type === 'ask-result');
  assert.equal(result.status, 'refused');
  assert.equal(result.reason, 'token');

  await waitForStderr(scenario, "Refused a page's token");
  await waitForStderr(scenario, 'did not present the page token');
  assert.ok(!scenario.stderrText.includes(wrongToken), 'the server never logs the token it was given');
  assert.equal(withoutStructureTemplate(withoutPageLine(await scenario.getCode())), 'Nothing is playing yet.', 'no page is authenticated: no arming line');
});

test('ask e2e: a request whose context holds a 201-character track is refused invalid, with a detail', async (t) => {
  const scenario = await startScenario(t);
  const trusted = await trustedPage(scenario);
  ask(trusted.page, 'long-1', 'make it shorter', { context: { kind: 'track', track: 'x'.repeat(201) } });
  const refusal = await trusted.waitFor((m) => m.type === 'ask-result' && m.id === 'long-1', 'the refusal');
  assert.equal(refusal.status, 'refused');
  assert.equal(refusal.reason, 'invalid');
  assert.equal(typeof refusal.detail, 'string');
  assert.ok(refusal.detail.length > 0);
});

test('ask e2e: an instrument request from a trusted page reaches the listener with its context and chip unchanged', async (t) => {
  const scenario = await startScenario(t);
  const trusted = await trustedPage(scenario);
  const listener = startListenerFrom(await scenario.getCode(), scenario);
  await listenerLive(trusted);
  ask(trusted.page, 'instrument-1', 'what is this one good for?', {
    context: { kind: 'instrument', id: 'mt32' },
    chip: 'Instrument mt32',
  });
  await listener.waitForLines(1, 'the instrument request line');
  const [line] = listener.lines();
  const request = JSON.parse(line.slice(REQUEST_LINE_PREFIX.length + 1));
  assert.deepEqual(request.context, { kind: 'instrument', id: 'mt32' });
  assert.equal(request.chip, 'Instrument mt32');
  assert.equal(request.text, 'what is this one good for?');
  await trusted.waitFor((m) => m.type === 'ask-result' && m.id === 'instrument-1' && m.status === 'received', 'ask-result received');
});

test('ask e2e: an instrument request whose id holds 201 characters is refused invalid and nothing is printed', async (t) => {
  const scenario = await startScenario(t);
  const trusted = await trustedPage(scenario);
  const listener = startListenerFrom(await scenario.getCode(), scenario);
  await listenerLive(trusted);
  ask(trusted.page, 'instrument-long', 'what is this one good for?', {
    context: { kind: 'instrument', id: 'i'.repeat(201) },
    chip: 'Instrument',
  });
  const refusal = await trusted.waitFor((m) => m.type === 'ask-result' && m.id === 'instrument-long', 'the refusal');
  assert.equal(refusal.status, 'refused');
  assert.equal(refusal.reason, 'invalid');
  assert.equal(typeof refusal.detail, 'string');
  assert.ok(refusal.detail.length > 0);
  await expectNothingPrintedBefore(trusted, listener, 0, 'instrument-follow-up');
});

test('ask e2e: seven requests sent at once produce a rate-limit refusal', async (t) => {
  const scenario = await startScenario(t);
  const trusted = await trustedPage(scenario);
  for (let i = 0; i < 7; i++) {
    ask(trusted.page, `burst-${i}`, `request number ${i}`);
  }
  await trusted.waitFor(
    (m) => m.type === 'ask-result' && m.status === 'refused' && m.reason === 'rate-limit',
    'a rate-limit refusal',
  );
  const waiting = trusted.frames.filter((m) => m.type === 'ask-result' && m.status === 'waiting');
  assert.equal(waiting.length, 5, 'exactly five requests are accepted inside one second');
  await waitForStderr(scenario, 'more than 5 in one second');
});

/** A moment as the page sends it, with one MIDI note and one drum note. */
function goodMoment() {
  return {
    cycle: 34,
    beat: 3,
    at: 34.5,
    version: 12,
    notes: [
      { track: 'pad', instrument: 'synth \u00B7 ch 3', note: 'g4', velocity: 0.9, start: 34.5, end: 34.75, state: 'sounding' },
      { track: 'drums', sound: 'bd', velocity: 0.8, start: 34.5, end: 34.6, state: 'starts' },
      { track: 'kit', instrument: 'mt32 \u00B7 ch 10', note: 36, drum: 'Acoustic Bass Drum', velocity: 0.9, start: 34.5, end: 34.6, state: 'starts' },
    ],
    more: 0,
  };
}

test('ask e2e: a moment reaches the listener exactly as the page sent it', async (t) => {
  const scenario = await startScenario(t);
  const trusted = await trustedPage(scenario);
  const listener = startListenerFrom(await scenario.getCode(), scenario);
  await listenerLive(trusted);
  const moment = goodMoment();
  ask(trusted.page, 'moment-1', 'too loud here', {
    context: { kind: 'lane', track: 'pad', cycle: 34 },
    chip: 'Lane pad \u00B7 cycle 34, beat 3 \u00B7 2 notes',
    current: 12,
    moment,
  });
  await listener.waitForLines(1, 'the request line with a moment');
  const [line] = listener.lines();
  const request = JSON.parse(line.slice(REQUEST_LINE_PREFIX.length + 1));
  assert.deepEqual(request.moment, moment);
  assert.deepEqual(Object.keys(request), ['id', 'text', 'context', 'chip', 'current', 'moment']);
  assert.deepEqual(request.context, { kind: 'lane', track: 'pad', cycle: 34 });
  assert.equal(request.current, 12);
  await trusted.waitFor((m) => m.type === 'ask-result' && m.id === 'moment-1' && m.status === 'received', 'received');
});

test('ask e2e: a request without a moment gives a line with no moment key', async (t) => {
  const scenario = await startScenario(t);
  const trusted = await trustedPage(scenario);
  const listener = startListenerFrom(await scenario.getCode(), scenario);
  await listenerLive(trusted);
  ask(trusted.page, 'plain-1', 'make it shorter');
  await listener.waitForLines(1, 'the plain request line');
  const request = JSON.parse(listener.lines()[0].slice(REQUEST_LINE_PREFIX.length + 1));
  assert.deepEqual(Object.keys(request), ['id', 'text', 'context', 'chip', 'current']);
});

test('ask e2e: a bad moment is refused invalid with a detail and never trimmed, printed or queued', async (t) => {
  const scenario = await startScenario(t);
  const trusted = await trustedPage(scenario);
  const note = goodMoment().notes[0];
  const withMoment = (change) => ({ ...goodMoment(), ...change });
  const bad = [
    ['33 notes', withMoment({ notes: Array.from({ length: 33 }, () => note) })],
    ['a 201-character track', withMoment({ notes: [{ ...note, track: 'x'.repeat(201) }] })],
    ['beat 5', withMoment({ beat: 5 })],
    ['beat 0', withMoment({ beat: 0 })],
    ['cycle -1', withMoment({ cycle: -1 })],
    ['version 0', withMoment({ version: 0 })],
    ['a null start', withMoment({ notes: [{ ...note, start: null }] })],
    ['a state of later', withMoment({ notes: [{ ...note, state: 'later' }] })],
  ];
  for (const [index, [what, moment]] of bad.entries()) {
    const id = `bad-moment-${index}`;
    ask(trusted.page, id, 'too loud here', { moment });
    const refusal = await trusted.waitFor((m) => m.type === 'ask-result' && m.id === id, `the refusal for ${what}`);
    assert.equal(refusal.status, 'refused', what);
    assert.equal(refusal.reason, 'invalid', what);
    assert.equal(typeof refusal.detail, 'string', what);
    assert.ok(refusal.detail.length > 0, what);
    // Keeps every send well under the 5 per second limit.
    await sleep(250);
  }
  const reply = await scenario.getCode();
  assert.ok(!reply.includes(REQUEST_LINE_PREFIX), 'no refused request is queued');
  assert.ok(!trusted.frames.some((m) => m.type === 'ask-result' && m.status === 'waiting'), 'none was accepted');
});

test('ask e2e: the largest accepted request line reaches the listener whole as one line, a longer one is refused too-long', async (t) => {
  const scenario = await startScenario(t);
  const trusted = await trustedPage(scenario);
  const listener = startListenerFrom(await scenario.getCode(), scenario);
  await listenerLive(trusted);
  const note = { track: 'p'.repeat(40), instrument: 'i'.repeat(40), note: 'g4', sound: 's'.repeat(40), velocity: 0.9, start: 34.5, end: 34.75, state: 'sounding' };
  const moment = { ...goodMoment(), notes: Array.from({ length: 32 }, () => ({ ...note })) };
  const frame = (id, text) => ({
    id,
    text,
    context: { kind: 'lane', track: 'pad', cycle: 34 },
    chip: 'Lane pad \u00B7 cycle 34, beat 3 \u00B7 32 notes',
    current: 12,
    moment,
  });
  // The text that makes the line exactly as long as the server takes.
  const lineBytes = (text) => Buffer.byteLength(requestLine(frame('max-line', text)), 'utf8');
  const textLength = MAX_REQUEST_LINE_BYTES - lineBytes('');
  assert.ok(textLength > 0 && textLength <= 2000, `the filling text is ${textLength} characters`);
  const text = 'x'.repeat(textLength);
  assert.equal(lineBytes(text), MAX_REQUEST_LINE_BYTES);
  const { id, ...rest } = frame('max-line', text);
  ask(trusted.page, id, text, rest);
  await listener.waitForLines(1, 'the largest request line');
  assert.equal(listener.lines().length, 1, 'one request is one line');
  const [line] = listener.lines();
  assert.equal(Buffer.byteLength(line, 'utf8'), MAX_REQUEST_LINE_BYTES);
  const request = JSON.parse(line.slice(REQUEST_LINE_PREFIX.length + 1));
  assert.equal(request.text, text);
  assert.equal(request.moment.notes.length, 32);
  await trusted.waitFor((m) => m.type === 'ask-result' && m.id === 'max-line' && m.status === 'received', 'received');

  await sleep(250);
  const over = frame('over-line', `${text}x`);
  ask(trusted.page, over.id, over.text, { context: over.context, chip: over.chip, current: over.current, moment: over.moment });
  const refusal = await trusted.waitFor((m) => m.type === 'ask-result' && m.id === 'over-line', 'the refusal of the longer line');
  assert.equal(refusal.status, 'refused');
  assert.equal(refusal.reason, 'line-too-long');
  await expectNothingPrintedBefore(trusted, listener, 1, 'over-line-follow-up');
});

test('ask e2e: an error request from a trusted page reaches the listener with its context and chip unchanged', async (t) => {
  const scenario = await startScenario(t);
  const trusted = await trustedPage(scenario);
  const listener = startListenerFrom(await scenario.getCode(), scenario);
  await listenerLive(trusted);
  ask(trusted.page, 'error-1', 'what went wrong here?', {
    context: { kind: 'error', text: "SyntaxError: Unexpected token ')'" },
    chip: "Failed change \u00B7 SyntaxError: Unexpected token ')'",
  });
  await listener.waitForLines(1, 'the error request line');
  const [line] = listener.lines();
  const request = JSON.parse(line.slice(REQUEST_LINE_PREFIX.length + 1));
  assert.deepEqual(request.context, { kind: 'error', text: "SyntaxError: Unexpected token ')'" });
  assert.equal(request.chip, "Failed change \u00B7 SyntaxError: Unexpected token ')'");
  assert.equal(request.text, 'what went wrong here?');
  await trusted.waitFor((m) => m.type === 'ask-result' && m.id === 'error-1' && m.status === 'received', 'ask-result received');
});

test('ask e2e: an error request whose text holds 201 characters is refused invalid and nothing is printed', async (t) => {
  const scenario = await startScenario(t);
  const trusted = await trustedPage(scenario);
  const listener = startListenerFrom(await scenario.getCode(), scenario);
  await listenerLive(trusted);
  ask(trusted.page, 'error-long', 'what went wrong here?', {
    context: { kind: 'error', text: 'e'.repeat(201) },
    chip: 'Failed change',
  });
  const refusal = await trusted.waitFor((m) => m.type === 'ask-result' && m.id === 'error-long', 'the refusal');
  assert.equal(refusal.status, 'refused');
  assert.equal(refusal.reason, 'invalid');
  assert.equal(typeof refusal.detail, 'string');
  assert.ok(refusal.detail.length > 0);
  await expectNothingPrintedBefore(trusted, listener, 0, 'error-follow-up');
});
