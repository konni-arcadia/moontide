// The tempo ramp through a real server: a fake page answers each evaluate, a real MCP client plays Claude.
// glideBars must reach the page as asked, the reply must say the ramp the page reports, and a malformed glide
// report must never be said. Every expected string is built from dist exports, never written here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startMcpClient, createFakePage } from './helpers.js';
import { GLIDE_NOTHING_PLAYS_MESSAGE, glideLine, tempoLine } from '../dist/mcp.js';
import { NOT_STARTED_MESSAGE, glideEndedLine } from '../dist/session.js';
import { GLIDE_REFUSALS } from '../page/tempo-glide.js';

const CODE = 'setcpm(120/4)\nlead: s("bd")';

/** A real server, one fake page, and the evaluate messages it received. `answer(msg)` returns what the page sends back. */
async function startScenario(t, answer) {
  const { client, port } = await startMcpClient();
  const page = await createFakePage(port);
  const extra = [];
  t.after(async () => {
    page.ws.close();
    for (const other of extra) other.ws.close();
    await client.close();
  });
  const evaluates = [];
  page.setResponder((msg) => {
    evaluates.push(msg);
    return answer(msg);
  });
  const call = (name, args) => client.callTool({ name, arguments: args });
  const textOf = (result) => result.content.map((part) => part.text).join('\n');
  return { client, port, page, extra, evaluates, call, textOf };
}

const okReply = (msg, extra = {}) => ({ type: 'evaluated', id: msg.id, ok: true, code: msg.code, audio: 'playing', ...extra });

test('set_code with glideBars sends the page glideBars, and without it sends no glideBars key', async (t) => {
  const s = await startScenario(t, (msg) => okReply(msg));
  await s.call('set_code', { code: CODE, glideBars: 8 });
  await s.call('set_code', { code: CODE });
  assert.equal(s.evaluates.length, 2);
  assert.equal(s.evaluates[0].glideBars, 8);
  assert.equal(Object.hasOwn(s.evaluates[1], 'glideBars'), false);
});

test('a reply that started a ramp says it in place of the tempo line', async (t) => {
  const glide = { state: 'started', fromBpm: 100, toBpm: 120, bars: 8 };
  const s = await startScenario(t, (msg) => okReply(msg, { bpm: 100, glide }));
  const text = s.textOf(await s.call('set_code', { code: CODE, glideBars: 8 }));
  assert.ok(text.includes(glideLine(glide)), `the reply says the ramp: ${text}`);
  assert.ok(!text.includes(tempoLine(100)), 'the tempo line is left out when a ramp starts');
  assert.ok(!text.includes('Tempo:'), 'no tempo line');
});

test('the line of a ramp over one bar says "over 1 bar"', async (t) => {
  const glide = { state: 'started', fromBpm: 100.5, toBpm: 120, bars: 1 };
  const s = await startScenario(t, (msg) => okReply(msg, { bpm: 100.5, glide }));
  const text = s.textOf(await s.call('set_code', { code: CODE, glideBars: 1 }));
  assert.ok(text.includes(glideLine(glide)));
  assert.ok(glideLine(glide).includes('over 1 bar'));
  assert.ok(!glideLine(glide).includes('bars'), 'one bar is singular');
  assert.ok(glideLine({ ...glide, bars: 2 }).includes('over 2 bars'));
});

test('a malformed glide report is dropped like any malformed page message and never said', async (t) => {
  const good = { state: 'started', fromBpm: 100, toBpm: 120, bars: 8 };
  const bad = [
    { state: 'started', fromBpm: 100, toBpm: 120, bars: 0 },
    { state: 'started', fromBpm: 100, toBpm: 120, bars: 65 },
    { state: 'started', fromBpm: -100, toBpm: 120, bars: 8 },
    { state: 'started', fromBpm: 100, toBpm: 100001, bars: 8 },
  ];
  // The bad report comes first; the server drops it, and the good one that follows is the reply that counts.
  const s = await startScenario(t, (msg) => [
    ...bad.map((glide) => okReply(msg, { bpm: 100, glide })),
    okReply(msg, { bpm: 100, glide: good }),
  ]);
  const text = s.textOf(await s.call('set_code', { code: CODE, glideBars: 8 }));
  assert.ok(text.includes(glideLine(good)));
  for (const glide of bad) {
    assert.ok(!text.includes(glideLine(glide)), `a malformed report is never said: ${JSON.stringify(glide)}`);
  }
});

const EDIT = [{ old_string: 'bd', new_string: 'sd' }];

/** Calls a tool and says whether it was refused (a thrown error or an isError reply). */
async function refused(call, name, args) {
  try {
    const result = await call(name, args);
    return result.isError === true;
  } catch {
    return true;
  }
}

test('set_code and edit_code with glideBars 1 and 64 reach the page', async (t) => {
  const s = await startScenario(t, (msg) => okReply(msg));
  for (const glideBars of [1, 64]) {
    await s.call('set_code', { code: CODE, glideBars });
    assert.equal(s.evaluates.at(-1).glideBars, glideBars, `set_code ${glideBars}`);
    await s.call('edit_code', { edits: EDIT, glideBars });
    assert.equal(s.evaluates.at(-1).glideBars, glideBars, `edit_code ${glideBars}`);
  }
  assert.equal(s.evaluates.length, 4);
});

test('edit_code without glideBars sends no glideBars key, and its reply says the ramp the page reports', async (t) => {
  const glide = { state: 'started', fromBpm: 90, toBpm: 120, bars: 16 };
  let withGlide = false;
  const s = await startScenario(t, (msg) => okReply(msg, withGlide ? { bpm: 90, glide } : {}));
  await s.call('set_code', { code: CODE });
  await s.call('edit_code', { edits: EDIT });
  assert.equal(Object.hasOwn(s.evaluates.at(-1), 'glideBars'), false);
  withGlide = true;
  const text = s.textOf(await s.call('edit_code', { edits: [{ old_string: 'sd', new_string: 'bd' }], glideBars: 16 }));
  assert.ok(text.includes(glideLine(glide)), text);
  assert.ok(!text.includes('Tempo:'));
});

test('a glideBars of 0, 65, 1.5 or -1 is refused by both tools and the page receives nothing', async (t) => {
  const s = await startScenario(t, (msg) => okReply(msg));
  await s.call('set_code', { code: CODE });
  const before = s.evaluates.length;
  for (const glideBars of [0, 65, 1.5, -1]) {
    assert.equal(await refused(s.call, 'set_code', { code: CODE, glideBars }), true, `set_code ${glideBars}`);
    assert.equal(await refused(s.call, 'edit_code', { edits: EDIT, glideBars }), true, `edit_code ${glideBars}`);
  }
  assert.equal(s.evaluates.length, before, 'no evaluate message left the server');
});

// --- the reply states of a ramp ---

test('a waiting change whose ramp starts at its line says the line and the ramp, not the tempo from the cycle', async (t) => {
  const glide = { state: 'at-line', toBpm: 120, bars: 4 };
  const s = await startScenario(t, (msg) => okReply(msg, { bpm: 120, pending: { cycle: 12, seconds: 3 }, glide }));
  await s.call('set_code', { code: CODE });
  const text = s.textOf(await s.call('set_code', { code: CODE, at: 'bar', glideBars: 4 }));
  assert.ok(text.includes(glideLine(glide, 12)), `the reply names the line and the ramp: ${text}`);
  assert.ok(glideLine(glide, 12).includes('cycle 12'), 'the line names its cycle');
  assert.ok(!text.includes('Tempo from cycle'), 'no tempo line');
});

test('a reply that restated the target of a running ramp says the ramp goes on, in place of the tempo line', async (t) => {
  const glide = { state: 'running', nowBpm: 110, toBpm: 120 };
  const s = await startScenario(t, (msg) => okReply(msg, { bpm: 110, glide }));
  const text = s.textOf(await s.call('set_code', { code: CODE }));
  assert.ok(text.includes(glideLine(glide)), text);
  assert.ok(!text.includes('Tempo:'), 'no tempo line');
});

test('after a reply that states a ramp, the next reply does not announce the ramp target as a tempo change', async (t) => {
  const glide = { state: 'started', fromBpm: 100, toBpm: 120, bars: 8 };
  let answer = okReply;
  const s = await startScenario(t, (msg) => answer(msg));
  answer = (msg) => okReply(msg, { bpm: 100, glide });
  await s.call('set_code', { code: CODE, glideBars: 8 });
  answer = (msg) => okReply(msg, { bpm: 120 });
  const same = s.textOf(await s.call('set_code', { code: CODE }));
  assert.ok(!same.includes('Tempo:'), `the ramp's target is not announced: ${same}`);
  answer = (msg) => okReply(msg, { bpm: 90 });
  const other = s.textOf(await s.call('set_code', { code: CODE }));
  assert.ok(other.includes(tempoLine(90)), `another tempo is: ${other}`);
});

test('a ramp is refused by the server before Moontide starts, before a tab opens and before anything reaches the page', async (t) => {
  const { client } = await startMcpClient({ start: false });
  t.after(() => client.close());
  for (const [name, args] of [
    ['set_code', { code: CODE, glideBars: 4 }],
    ['edit_code', { edits: EDIT, glideBars: 4 }],
  ]) {
    const result = await client.callTool({ name, arguments: args }).catch((err) => ({ isError: true, content: [{ text: String(err) }] }));
    assert.equal(result.isError, true, `${name} is refused`);
    const text = result.content.map((part) => part.text).join('\n');
    assert.ok(text.includes(GLIDE_NOTHING_PLAYS_MESSAGE), `${name} says why: ${text}`);
  }
  const after = await client.callTool({ name: 'get_code', arguments: {} }).catch((err) => ({ content: [{ text: String(err) }] }));
  assert.ok(after.content.map((part) => part.text).join('\n').includes(NOT_STARTED_MESSAGE), 'Moontide was not started by the refusals');
});

test('after the stop tool a ramp is refused with the same text and the page receives no evaluate', async (t) => {
  const s = await startScenario(t, (msg) => okReply(msg));
  s.page.setStopResponder((msg) => ({ type: 'stop-result', id: msg.id, ok: true }));
  await s.call('set_code', { code: CODE });
  await s.call('stop');
  const before = s.evaluates.length;
  for (const [name, args] of [
    ['set_code', { code: CODE, glideBars: 4 }],
    ['edit_code', { edits: EDIT, glideBars: 4 }],
  ]) {
    const result = await s.call(name, args).catch((err) => ({ isError: true, content: [{ text: String(err) }] }));
    assert.equal(result.isError, true, `${name} is refused`);
    assert.ok(s.textOf(result).includes(GLIDE_NOTHING_PLAYS_MESSAGE), `${name}: ${s.textOf(result)}`);
  }
  assert.equal(s.evaluates.length, before, 'no evaluate left the server');
});

test('a refused ramp reaches Claude as the page refusal text, without the evaluation-failure wording', async (t) => {
  const s = await startScenario(t, (msg) => okReply(msg));
  await s.call('set_code', { code: CODE });
  s.page.setResponder((msg) => ({ type: 'evaluated', id: msg.id, ok: false, code: msg.code, error: GLIDE_REFUSALS.noTempo, glideRefused: true }));
  const result = await s.call('set_code', { code: 'lead: s("bd")', glideBars: 4 }).catch((err) => ({ isError: true, content: [{ text: String(err) }] }));
  assert.equal(result.isError, true);
  const text = s.textOf(result);
  assert.ok(text.includes(GLIDE_REFUSALS.noTempo), text);
  assert.ok(!text.includes('Evaluation failed'), text);
});

// --- a ramp that ended early is told once ---

const STARTED = { state: 'started', fromBpm: 100, toBpm: 120, bars: 8 };

/** Starts a ramp through a set_code and gives the scenario back. */
async function withRamp(t) {
  const s = await startScenario(t, (msg) => okReply(msg, { bpm: 100, glide: STARTED }));
  await s.call('set_code', { code: CODE, glideBars: 8 });
  s.page.setResponder((msg) => {
    s.evaluates.push(msg);
    return okReply(msg);
  });
  return s;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Counts the occurrences of a line in a text. */
const count = (text, line) => text.split(line).length - 1;

test('a canceled ramp (another tempo, no tempo, an error) is told once in the next reply and not in the one after', async (t) => {
  for (const [reason, bpm] of [['other-tempo', 90], ['no-tempo', 110], ['error', 105]]) {
    const s = await withRamp(t);
    s.page.send({ type: 'glide-ended', reason, bpm });
    await sleep(60);
    const first = s.textOf(await s.call('get_code'));
    const line = glideEndedLine(reason, bpm);
    assert.equal(count(first, line), 1, `${reason}: told once: ${first}`);
    const second = s.textOf(await s.call('get_code'));
    assert.equal(count(second, line), 0, `${reason}: not told again: ${second}`);
    // A second cause adds nothing.
    s.page.send({ type: 'glide-ended', reason: 'other-tempo', bpm: 80 });
    await sleep(60);
    assert.ok(!s.textOf(await s.call('get_code')).includes('Note: the tempo ramp ended early'), `${reason}: a second end adds nothing`);
  }
});

test('the wording of each cause names it and the tempo that plays, and the lines differ', () => {
  const lines = [glideEndedLine('other-tempo', 90), glideEndedLine('no-tempo', 110.5), glideEndedLine('error', 105), glideEndedLine('page')];
  assert.equal(new Set(lines).size, 4);
  assert.ok(lines[0].includes('90 BPM'));
  assert.ok(lines[1].includes('110.5 BPM'));
  assert.ok(lines[2].includes('105 BPM'));
  assert.ok(!lines[3].includes('BPM'));
  assert.ok(glideEndedLine('other-tempo').endsWith('tempo.'), 'no number when the page gave none');
});

test('a finished ramp adds no line and clears the record, so a later page loss adds none either', async (t) => {
  const s = await withRamp(t);
  s.page.send({ type: 'glide-ended', reason: 'finished' });
  await sleep(60);
  const text = s.textOf(await s.call('get_code'));
  assert.ok(!text.includes('Note: the tempo ramp ended early'), text);
  s.page.ws.close();
  await sleep(100);
  const second = await startScenarioPage(s);
  assert.ok(!second.includes('Note: the tempo ramp ended early'), second);
});

/** Opens a new page on the same server and returns the text of the next get_code. */
async function startScenarioPage(s) {
  const page = await createFakePage(s.port);
  s.extra.push(page);
  page.setResponder((msg) => okReply(msg));
  await sleep(60);
  return s.textOf(await s.call('get_code'));
}

test('a ramp lost with the page (closed, or taken over by another tab) is told once as the page line', async (t) => {
  // The page closes.
  const closed = await withRamp(t);
  closed.page.ws.close();
  await sleep(100);
  const text = closed.textOf(await closed.call('get_code').catch((err) => ({ content: [{ text: String(err) }] })));
  assert.equal(count(text, glideEndedLine('page')), 1, text);
  const again = await startScenarioPage(closed);
  assert.equal(count(again, glideEndedLine('page')), 0, 'a page attaching afterwards adds nothing');

  // Another tab takes the role.
  const taken = await withRamp(t);
  const second = await createFakePage(taken.port);
  taken.extra.push(second);
  second.setResponder((msg) => okReply(msg));
  await sleep(60);
  const takenText = taken.textOf(await taken.call('get_code'));
  assert.equal(count(takenText, glideEndedLine('page')), 1, takenText);
});

test('Stop (the user, then the tool) clears a ramp with no line', async (t) => {
  const user = await withRamp(t);
  user.page.send({ type: 'user-stopped' });
  await sleep(60);
  user.page.send({ type: 'glide-ended', reason: 'other-tempo', bpm: 90 });
  await sleep(60);
  assert.ok(!user.textOf(await user.call('get_code')).includes('Note: the tempo ramp ended early'), 'user-stopped ends the ramp silently');

  const tool = await withRamp(t);
  tool.page.setStopResponder((msg) => ({ type: 'stop-result', id: msg.id, ok: true }));
  const stopped = tool.textOf(await tool.call('stop'));
  assert.ok(!stopped.includes('Note: the tempo ramp ended early'), stopped);
  tool.page.send({ type: 'glide-ended', reason: 'no-tempo', bpm: 100 });
  await sleep(60);
  assert.ok(!tool.textOf(await tool.call('get_code')).includes('Note: the tempo ramp ended early'), 'the stop tool ended the ramp silently');
});

test('a reply whose audio is stopped states no ramp and records none, so a later page loss adds no line', async (t) => {
  // Stop landed while the change was starting: the page already ended the ramp, and the reply says the audio is stopped.
  let answer = okReply;
  const s = await startScenario(t, (msg) => answer(msg));
  await s.call('set_code', { code: CODE });
  answer = (msg) => okReply(msg, { audio: 'stopped', bpm: 100, glide: STARTED });
  const text = s.textOf(await s.call('set_code', { code: CODE, glideBars: 8 }));
  assert.ok(!text.includes(glideLine(STARTED)), `a stopped reply states no ramp: ${text}`);
  // A reload: the page line is queued only for a ramp the server holds.
  s.page.ws.close();
  await sleep(100);
  const after = await startScenarioPage(s);
  assert.equal(count(after, glideEndedLine('page')), 0, `no ramp was recorded: ${after}`);
});

test('glide-ended from a page that is not active is ignored', async (t) => {
  const s = await withRamp(t);
  // Another tab takes the role; its own ramp is the one recorded.
  const second = await createFakePage(s.port);
  s.extra.push(second);
  second.setResponder((msg) => okReply(msg, { bpm: 100, glide: STARTED }));
  await sleep(60);
  s.textOf(await s.call('get_code')); // drains the page line of the lost ramp
  await s.call('set_code', { code: CODE, glideBars: 8 });
  // The old page is no longer the active one: its report changes nothing.
  s.page.send({ type: 'glide-ended', reason: 'other-tempo', bpm: 90 });
  await sleep(60);
  assert.ok(!s.textOf(await s.call('get_code')).includes('Note: the tempo ramp ended early'), 'a non-active page changes nothing');
  second.send({ type: 'glide-ended', reason: 'no-tempo', bpm: 100 });
  await sleep(60);
  const text = s.textOf(await s.call('get_code'));
  assert.equal(count(text, glideEndedLine('no-tempo', 100)), 1, `the active page's report still counts: ${text}`);
  assert.equal(count(text, glideEndedLine('other-tempo', 90)), 0);
});

test('a waiting change records its ramp only at its takeover; one replaced before it records nothing', async (t) => {
  const atLine = { state: 'at-line', toBpm: 120, bars: 4 };
  const s = await startScenario(t, (msg) => okReply(msg));
  await s.call('set_code', { code: CODE });
  s.page.setResponder((msg) => {
    s.evaluates.push(msg);
    return okReply(msg, { pending: { cycle: 12, seconds: 3 }, glide: atLine });
  });
  await s.call('set_code', { code: CODE, at: 'bar', glideBars: 4 });
  const waitingId = s.evaluates.at(-1).id;
  // Before the takeover nothing is recorded: an end adds no line.
  s.page.send({ type: 'glide-ended', reason: 'other-tempo', bpm: 90 });
  await sleep(60);
  assert.ok(!s.textOf(await s.call('get_code')).includes('Note: the tempo ramp ended early'));
  // After the takeover that says the ramp runs, it is.
  s.page.send({ type: 'takeover', id: waitingId, glideRuns: true });
  await sleep(60);
  s.page.send({ type: 'glide-ended', reason: 'other-tempo', bpm: 90 });
  await sleep(60);
  assert.equal(count(s.textOf(await s.call('get_code')), glideEndedLine('other-tempo', 90)), 1);

  // A waiting change that a newer change replaces before its line records nothing.
  const s2 = await startScenario(t, (msg) => okReply(msg));
  await s2.call('set_code', { code: CODE });
  s2.page.setResponder((msg) => {
    s2.evaluates.push(msg);
    return okReply(msg, { pending: { cycle: 12, seconds: 3 }, glide: atLine });
  });
  await s2.call('set_code', { code: CODE, at: 'bar', glideBars: 4 });
  const firstId = s2.evaluates.at(-1).id;
  s2.page.setResponder((msg) => {
    s2.evaluates.push(msg);
    return [{ type: 'takeover-canceled', id: firstId, reason: 'replaced' }, okReply(msg, { pending: { cycle: 16, seconds: 6 } })];
  });
  await s2.call('set_code', { code: CODE, at: 'bar' });
  s2.page.send({ type: 'takeover', id: firstId, glideRuns: true });
  await sleep(60);
  s2.page.send({ type: 'glide-ended', reason: 'other-tempo', bpm: 90 });
  await sleep(60);
  assert.ok(!s2.textOf(await s2.call('get_code')).includes('Note: the tempo ramp ended early'), 'a replaced change recorded no ramp');
});

test('a waiting change whose ramp does not run at its takeover records none, and clears an older ramp with no line', async (t) => {
  const atLine = { state: 'at-line', toBpm: 120, bars: 4 };
  const pendingAtLine = (s) => (msg) => {
    s.evaluates.push(msg);
    return okReply(msg, { pending: { cycle: 12, seconds: 3 }, glide: atLine });
  };

  // Nothing to ramp between at the line: the takeover does not say the ramp runs, so a later page loss adds no line.
  const s = await startScenario(t, (msg) => okReply(msg));
  await s.call('set_code', { code: CODE });
  s.page.setResponder(pendingAtLine(s));
  await s.call('set_code', { code: CODE, at: 'bar', glideBars: 4 });
  s.page.send({ type: 'takeover', id: s.evaluates.at(-1).id });
  await sleep(60);
  assert.ok(!s.textOf(await s.call('get_code')).includes('Note: the tempo ramp ended early'), 'the takeover adds no line');
  s.page.ws.close();
  await sleep(100);
  const after = await startScenarioPage(s);
  assert.equal(count(after, glideEndedLine('page')), 0, `no ramp was recorded at the takeover: ${after}`);

  // An older ramp runs; the waiting change ended it at its line and started none: its record is cleared with no line.
  const older = await withRamp(t);
  older.page.setResponder(pendingAtLine(older));
  await older.call('set_code', { code: CODE, at: 'bar', glideBars: 4 });
  older.page.send({ type: 'takeover', id: older.evaluates.at(-1).id });
  await sleep(60);
  assert.ok(!older.textOf(await older.call('get_code')).includes('Note: the tempo ramp ended early'), 'the clear adds no line');
  older.page.ws.close();
  await sleep(100);
  const olderAfter = await startScenarioPage(older);
  assert.equal(count(olderAfter, glideEndedLine('page')), 0, `the older ramp's record was cleared: ${olderAfter}`);
});

test('a waiting change answered after it took over records the ramp it started at its line, so its cancel is told once', async (t) => {
  // A newer change settled the waiting one at its line before its reply: the reply has no pending line and states the
  // ramp that started there.
  const atLine = { state: 'at-line', toBpm: 120, bars: 4 };
  let answer = okReply;
  const s = await startScenario(t, (msg) => answer(msg));
  await s.call('set_code', { code: CODE });
  answer = (msg) => okReply(msg, { bpm: 120, glide: atLine });
  const text = s.textOf(await s.call('set_code', { code: CODE, at: 'bar', glideBars: 4 }));
  assert.ok(text.includes(glideLine(atLine)), `the reply states the ramp: ${text}`);
  s.page.send({ type: 'glide-ended', reason: 'other-tempo', bpm: 90 });
  await sleep(60);
  assert.equal(count(s.textOf(await s.call('get_code')), glideEndedLine('other-tempo', 90)), 1, 'the cancel is told once');
});

test('a change whose own evaluation canceled the ramp gets the cancel line in its own reply', async (t) => {
  const s = await withRamp(t);
  s.page.setResponder((msg) => {
    s.evaluates.push(msg);
    return [{ type: 'glide-ended', reason: 'other-tempo', bpm: 90 }, okReply(msg, { bpm: 90 })];
  });
  const text = s.textOf(await s.call('set_code', { code: 'setcpm(90/4)\nlead: s("bd")' }));
  assert.equal(count(text, glideEndedLine('other-tempo', 90)), 1, text);
});
