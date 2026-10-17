// The page-requests state through a real server: an authenticated page learns
// whether page requests reach Claude live, right after its token is accepted and each time a real
// listener connects or drops; a page that never authenticated learns nothing. Then the two MCP
// prompts, page-requests-on and page-requests-off, in every state, and the arming switch they flip.
// Pages are fake (a raw WebSocket); the server, the MCP client and the listener are real. Every
// expected string is built from the dist/ask.js exports, never from a token or path written here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { connectPage, createFakePage, fetchPageToken, listenerCommandFrom, startMcpClient, waitForExit } from './helpers.js';
import * as askModule from '../dist/ask.js';

const ARMING_PREFIX = 'Page requests: no listener is connected.';
const HEX_TOKEN = /[0-9a-f]{64}/;

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
    url: server.url,
    cleanup,
    getCode,
    get stderrText() {
      return server.stderrText;
    },
  };
}

/** The server's stderr reaches the test through a pipe, a moment after the event: poll for it. */
async function waitForStderr(scenario, needle, timeoutMs = 3000) {
  const start = Date.now();
  while (!scenario.stderrText.includes(needle)) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for "${needle}" in the server log:\n${scenario.stderrText}`);
    }
    await sleep(10);
  }
}

/** The one user text message of a prompt, checked for its shape. */
async function promptText(scenario, name) {
  const result = await scenario.client.getPrompt({ name });
  assert.equal(result.messages.length, 1, JSON.stringify(result));
  assert.equal(result.messages[0].role, 'user');
  assert.equal(result.messages[0].content.type, 'text');
  return result.messages[0].content.text;
}

function ask(page, id, text) {
  page.send({ type: 'ask', id, text, context: { kind: 'session' }, chip: 'Whole session', current: null });
}

/** An independent collector: the fake page's own relay swallows what it does not handle. */
function collectFrames(page) {
  const frames = [];
  page.ws.on('message', (data) => {
    frames.push(JSON.parse(data.toString()));
  });
  return {
    frames,
    async waitFor(predicate, what, timeoutMs = 3000) {
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

/** A fake page that has authenticated with the token it was served. */
async function trustedPage(scenario) {
  const page = await createFakePage(scenario.port);
  scenario.cleanup.push(() => page.ws.close());
  const collector = collectFrames(page);
  page.send({ type: 'page-auth', token: await fetchPageToken(scenario.port) });
  await collector.waitFor((m) => m.type === 'ask-auth' && m.ok === true, 'ask-auth ok true');
  return { page, ...collector };
}

/** Starts the real listener from the exact command found in a text; collects its stdout. */
function startListenerFrom(text, scenario) {
  const { scriptPath, port, token } = listenerCommandFrom(text);
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
  };
}

const stateFrames = (collector) => collector.frames.filter((m) => m.type === 'page-requests');

/** Waits until the latest page-requests frame says `live`. */
async function waitForState(collector, live, timeoutMs = 3000) {
  const start = Date.now();
  while (stateFrames(collector).at(-1)?.live !== live) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for page-requests live ${live}; got ${JSON.stringify(stateFrames(collector))}`);
    }
    await sleep(10);
  }
}

test('page requests e2e: an authenticated page gets live false after ask-auth, live true when a real listener connects and live false when it is killed; a page that never authenticated gets nothing', async (t) => {
  const scenario = await startScenario(t);
  // A raw socket that never sends page-auth (createFakePage authenticates).
  const strangerWs = await connectPage(scenario.port);
  scenario.cleanup.push(() => strangerWs.close());
  const strangerFrames = collectFrames({ ws: strangerWs });

  const trusted = await trustedPage(scenario);
  await waitForState(trusted, false);
  // createFakePage already authenticated, so its own page-requests frame may land before or after the
  // collector starts; the state that answers the collector's page-auth is the first one after ask-auth.
  // (A repeated page-auth sends no hello, so it follows ask-auth directly.)
  const authAt = trusted.frames.findIndex((m) => m.type === 'ask-auth');
  const stateAt = trusted.frames.findIndex((m, i) => i > authAt && m.type === 'page-requests');
  assert.ok(authAt >= 0, 'ask-auth ok arrived');
  assert.equal(stateAt, authAt + 1, 'the state comes right after ask-auth ok');
  assert.deepEqual(trusted.frames[stateAt], { type: 'page-requests', live: false });

  const listener = startListenerFrom(await scenario.getCode(), scenario);
  await waitForState(trusted, true);

  listener.child.kill();
  await waitForExit(listener.child, 5000);
  await waitForState(trusted, false);

  const token = await fetchPageToken(scenario.port);
  for (const frame of stateFrames(trusted)) {
    assert.deepEqual(Object.keys(frame), ['type', 'live']);
    assert.ok(!JSON.stringify(frame).includes(token));
    assert.ok(!JSON.stringify(frame).includes(listener.token));
  }
  assert.deepEqual(stateFrames(strangerFrames), [], 'a page that never authenticated gets no page-requests frame');
});

test('page requests e2e: the prompts are listed, on refuses with no page, gives a working command, says already live, and off tells Claude to stop in both states', async (t) => {
  const scenario = await startScenario(t);

  const { prompts } = await scenario.client.listPrompts();
  assert.deepEqual(prompts.map((prompt) => prompt.name).sort(), ['page-requests-off', 'page-requests-on', 'start']);
  for (const prompt of prompts) {
    for (const field of ['name', 'title', 'description']) {
      assert.equal(typeof prompt[field], 'string', `${prompt.name} ${field}`);
      assert.ok(prompt[field].length > 0);
      assert.doesNotMatch(prompt[field], /listen/i, `${prompt.name} ${field}`);
      assert.doesNotMatch(prompt[field], HEX_TOKEN, `${prompt.name} ${field}`);
    }
  }

  // No page has authenticated: on fails loudly with a clear sentence and the page address.
  await assert.rejects(scenario.client.getPrompt({ name: 'page-requests-on' }), (error) => {
    assert.match(error.message, /No Moontide page is connected/);
    assert.ok(error.message.includes(scenario.url), error.message);
    return true;
  });

  const trusted = await trustedPage(scenario);
  await waitForState(trusted, false);

  const onText = await promptText(scenario, 'page-requests-on');
  const { port, token } = listenerCommandFrom(onText);
  assert.equal(port, scenario.port);
  assert.match(token, /^[0-9a-f]{64}$/);
  for (const piece of [
    'Monitor',
    'timeout_ms 1800000',
    askModule.MONITOR_DESCRIPTION,
    askModule.MONITOR_LIMIT_FACT,
    askModule.REQUEST_LINE_FRAMING,
  ]) {
    assert.ok(onText.includes(piece), `the on prompt must contain "${piece}"`);
  }
  assert.ok(!onText.includes('persistent'));
  const command = /node '[^']+' \d+ [0-9a-f]{64}/.exec(onText)[0];
  assert.doesNotMatch(onText.replace(command, '').replace(askModule.REQUEST_LINE_FRAMING, ''), /listen/i);

  // The prompt's command is the real, working command.
  const listener = startListenerFrom(onText, scenario);
  await waitForState(trusted, true);

  const alreadyOn = await promptText(scenario, 'page-requests-on');
  assert.equal(alreadyOn, askModule.PAGE_REQUESTS_ALREADY_ON);
  assert.ok(!alreadyOn.includes('node '));
  assert.doesNotMatch(alreadyOn, HEX_TOKEN);

  const off = await promptText(scenario, 'page-requests-off');
  assert.equal(off, askModule.PAGE_REQUESTS_OFF_TEXT);
  assert.ok(off.includes('TaskStop'));
  assert.ok(off.includes(askModule.MONITOR_DESCRIPTION));
  assert.ok(off.includes(askModule.PAGE_REQUESTS_OFF_NOTE));

  listener.child.kill();
  await waitForExit(listener.child, 5000);
  await waitForState(trusted, false);

  const alreadyOff = await promptText(scenario, 'page-requests-off');
  assert.equal(alreadyOff, askModule.PAGE_REQUESTS_ALREADY_OFF);
  assert.ok(alreadyOff.includes(askModule.PAGE_REQUESTS_OFF_NOTE));
  for (const text of [off, alreadyOff]) {
    assert.doesNotMatch(text, HEX_TOKEN);
    assert.doesNotMatch(text, /listen/i);
  }
});

test('page requests e2e: page-requests-off stops tool replies from carrying the command, a request sent while off still arrives, and page-requests-on brings the command back', async (t) => {
  const scenario = await startScenario(t);
  const trusted = await trustedPage(scenario);

  const armed = await scenario.getCode();
  assert.ok(armed.includes(ARMING_PREFIX), armed);
  const listener = startListenerFrom(armed, scenario);
  await waitForState(trusted, true);

  assert.equal(await promptText(scenario, 'page-requests-off'), askModule.PAGE_REQUESTS_OFF_TEXT);
  await waitForStderr(scenario, askModule.ARMING_PAUSED_LOG);
  listener.child.kill();
  await waitForExit(listener.child, 5000);
  await waitForState(trusted, false);

  const whileOff = await scenario.getCode();
  assert.ok(!whileOff.split('\n').some((line) => line.startsWith(ARMING_PREFIX)), whileOff);

  // A request sent while off still waits on the server and arrives in the next tool reply.
  ask(trusted.page, 'off-1', 'make the hats quieter');
  const waiting = await trusted.waitFor(
    (m) => m.type === 'ask-result' && m.id === 'off-1' && m.status === 'waiting',
    'ask-result waiting',
  );
  assert.equal(waiting.waiting, 1);
  const handedOver = await scenario.getCode();
  const requestLines = handedOver.split('\n').filter((line) => line.startsWith(askModule.REQUEST_LINE_PREFIX));
  assert.equal(requestLines.length, 1, handedOver);
  assert.equal(JSON.parse(requestLines[0].slice(askModule.REQUEST_LINE_PREFIX.length + 1)).text, 'make the hats quieter');
  assert.ok(!handedOver.split('\n').some((line) => line.startsWith(ARMING_PREFIX)), handedOver);
  // With no arming line, the reply still says what the moment of the request holds, in front of the line.
  assert.ok(handedOver.indexOf(askModule.REQUEST_LINE_MOMENT_FACT) >= 0, handedOver);
  assert.ok(handedOver.indexOf(askModule.REQUEST_LINE_MOMENT_FACT) < handedOver.indexOf(askModule.REQUEST_LINE_PREFIX), handedOver);
  assert.ok(handedOver.indexOf(askModule.REQUEST_LINE_STATUS_FACT) > handedOver.indexOf(askModule.REQUEST_LINE_MOMENT_FACT), handedOver);
  assert.ok(handedOver.indexOf(askModule.REQUEST_LINE_STATUS_FACT) < handedOver.indexOf(askModule.REQUEST_LINE_PREFIX), handedOver);

  // On clears the switch and gives the command; the next tool reply ends with the arming line again.
  const onText = await promptText(scenario, 'page-requests-on');
  assert.equal(listenerCommandFrom(onText).port, scenario.port);
  await waitForStderr(scenario, askModule.ARMING_RESUMED_LOG);
  const back = await scenario.getCode();
  const armingAt = back.lastIndexOf(ARMING_PREFIX);
  assert.ok(armingAt >= 0, back);
  assert.ok(!back.slice(armingAt).includes('\n'), 'the arming line is last');
});

/** The one text block of a tool reply, checked for its shape. */
function toolText(result) {
  assert.equal(result.content.length, 1, JSON.stringify(result));
  assert.equal(result.content[0].type, 'text');
  return result.content[0].text;
}

/** Calls the set_page_requests tool with the given state. */
const setPageRequests = (scenario, state) =>
  scenario.client.callTool({ name: askModule.PAGE_REQUESTS_TOOL, arguments: { state } });

/** Asserts a tool reply ends with the arming line, and that the line is its last one. */
function assertEndsWithArmingLine(text) {
  const armingAt = text.lastIndexOf(ARMING_PREFIX);
  assert.ok(armingAt >= 0, text);
  assert.ok(!text.slice(armingAt).includes('\n'), 'the arming line is last');
}

test("page requests e2e: set_page_requests switches page requests from any client, with the prompts' texts", async (t) => {
  const scenario = await startScenario(t);

  // The tool is listed, with a required on/off state, and its texts hold no listening word and no token.
  const { tools } = await scenario.client.listTools();
  const tool = tools.find((candidate) => candidate.name === 'set_page_requests');
  assert.ok(tool, 'set_page_requests is listed');
  assert.deepEqual(tool.inputSchema.properties.state.enum, ['on', 'off']);
  assert.deepEqual(tool.inputSchema.required, ['state']);
  for (const text of [tool.description, tool.inputSchema.properties.state.description]) {
    assert.doesNotMatch(text, /listen/i);
    assert.doesNotMatch(text, HEX_TOKEN);
  }

  // No page has authenticated: a loud tool error with the page address and the way back, no token.
  const noPage = await setPageRequests(scenario, 'on');
  assert.equal(noPage.isError, true);
  const noPageText = toolText(noPage);
  assert.match(noPageText, /No Moontide page is connected/);
  assert.ok(noPageText.includes(scenario.url), noPageText);
  assert.ok(noPageText.includes('set_page_requests'), noPageText);
  assert.doesNotMatch(noPageText, HEX_TOKEN);
  assert.equal(noPageText, askModule.noPageForRequestsToolText(scenario.url));

  const trusted = await trustedPage(scenario);
  await waitForState(trusted, false);

  // On, twice: the same text, equal to the prompt's, with the command exactly once.
  const first = toolText(await setPageRequests(scenario, 'on'));
  const second = toolText(await setPageRequests(scenario, 'on'));
  assert.equal(first, second);
  assert.equal(first, await promptText(scenario, 'page-requests-on'));
  assert.equal(first.split('node ').length - 1, 1, 'the command appears exactly once');
  assert.ok(!first.includes(ARMING_PREFIX), 'no arming line is appended');
  assert.equal(listenerCommandFrom(first).port, scenario.port);

  // The command, run as is, makes the page live; on again says so and holds no command or token.
  const listener = startListenerFrom(first, scenario);
  await waitForState(trusted, true);
  const alreadyOn = toolText(await setPageRequests(scenario, 'on'));
  assert.equal(alreadyOn, askModule.PAGE_REQUESTS_ALREADY_ON);
  assert.doesNotMatch(alreadyOn, HEX_TOKEN);

  // Off while a monitor is connected: how to stop it; the arming line pauses.
  const off = toolText(await setPageRequests(scenario, 'off'));
  assert.equal(off, askModule.PAGE_REQUESTS_OFF_TEXT);
  assert.ok(off.includes('TaskStop'));
  assert.ok(off.includes(askModule.MONITOR_DESCRIPTION));
  await waitForStderr(scenario, askModule.ARMING_PAUSED_LOG);
  listener.child.kill();
  await waitForExit(listener.child, 5000);
  await waitForState(trusted, false);

  const whileOff = await scenario.getCode();
  assert.ok(!whileOff.split('\n').some((line) => line.startsWith(ARMING_PREFIX)), whileOff);

  // A request sent while off waits and arrives in the next tool reply, which carries no command.
  ask(trusted.page, 'tool-off-1', 'make the pads wider');
  const waiting = await trusted.waitFor(
    (m) => m.type === 'ask-result' && m.id === 'tool-off-1' && m.status === 'waiting',
    'ask-result waiting',
  );
  assert.equal(waiting.waiting, 1);
  const handedOver = await scenario.getCode();
  const requestLines = handedOver.split('\n').filter((line) => line.startsWith(askModule.REQUEST_LINE_PREFIX));
  assert.equal(requestLines.length, 1, handedOver);
  assert.equal(JSON.parse(requestLines[0].slice(askModule.REQUEST_LINE_PREFIX.length + 1)).text, 'make the pads wider');
  assert.ok(!handedOver.split('\n').some((line) => line.startsWith(ARMING_PREFIX)), handedOver);

  // set_page_requests never hands over the waiting requests, and its texts say they come in the reply
  // of another Moontide tool: a request that waits while the tool is called stays queued for that reply.
  ask(trusted.page, 'tool-off-2', 'and slower');
  await trusted.waitFor((m) => m.type === 'ask-result' && m.id === 'tool-off-2' && m.status === 'waiting', 'ask-result waiting');
  const offAgain = toolText(await setPageRequests(scenario, 'off'));
  assert.ok(!offAgain.includes(askModule.REQUEST_LINE_PREFIX), offAgain);
  assert.match(offAgain, /reply of your next other Moontide tool/);
  assert.match(tool.description, /reply of your next other Moontide tool/);
  assert.match((await scenario.getCode()).split('\n').find((line) => line.startsWith(askModule.REQUEST_LINE_PREFIX)) ?? '', /and slower/);

  // Off with no monitor connected.
  const alreadyOff = toolText(await setPageRequests(scenario, 'off'));
  assert.equal(alreadyOff, askModule.PAGE_REQUESTS_ALREADY_OFF);
  for (const text of [off, alreadyOff]) {
    assert.doesNotMatch(text, HEX_TOKEN);
    assert.doesNotMatch(text, /listen/i);
    assert.ok(text.includes(askModule.PAGE_REQUESTS_OFF_NOTE));
  }

  // One switch, last call wins: the prompt on clears a tool off, then prompt off and tool on clear again.
  assert.equal(listenerCommandFrom(await promptText(scenario, 'page-requests-on')).port, scenario.port);
  await waitForStderr(scenario, askModule.ARMING_RESUMED_LOG);
  assertEndsWithArmingLine(await scenario.getCode());

  assert.equal(await promptText(scenario, 'page-requests-off'), askModule.PAGE_REQUESTS_ALREADY_OFF);
  const pausedByPrompt = await scenario.getCode();
  assert.ok(!pausedByPrompt.split('\n').some((line) => line.startsWith(ARMING_PREFIX)), pausedByPrompt);
  assert.equal(listenerCommandFrom(toolText(await setPageRequests(scenario, 'on'))).port, scenario.port);
  assertEndsWithArmingLine(await scenario.getCode());

  // An empty call and a state other than on or off are refused, and the switch is unchanged.
  for (const args of [{}, { state: 'maybe' }]) {
    let refused = false;
    try {
      const result = await scenario.client.callTool({ name: askModule.PAGE_REQUESTS_TOOL, arguments: args });
      refused = result.isError === true;
    } catch {
      refused = true;
    }
    assert.ok(refused, `${JSON.stringify(args)} is refused`);
  }
  assertEndsWithArmingLine(await scenario.getCode());
});

// A refused "on" with no page still clears the pause, as the prompt always did: the user asked for live
// requests, so the arming line comes back as soon as a page connects.
test('page requests e2e: an on call refused for lack of a page still clears an earlier off', async (t) => {
  const scenario = await startScenario(t);
  const off = toolText(await setPageRequests(scenario, 'off'));
  assert.equal(off, askModule.PAGE_REQUESTS_ALREADY_OFF);
  const refused = await setPageRequests(scenario, 'on');
  assert.equal(refused.isError, true);
  assert.equal(toolText(refused), askModule.noPageForRequestsToolText(scenario.url));
  await waitForStderr(scenario, askModule.ARMING_RESUMED_LOG);

  const trusted = await trustedPage(scenario);
  await waitForState(trusted, false);
  assertEndsWithArmingLine(await scenario.getCode());
});
