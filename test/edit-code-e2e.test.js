import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startMcpClient, createFakePage, withoutArmingLine, withoutPageLine } from './helpers.js';
import { EDIT_NOTHING_PLAYING_MESSAGE } from '../dist/session.js';
import {
  EDIT_HINT_MIN_LINES,
  HAND_EDIT_KEPT_NOTE,
  HAND_EDIT_NOTE,
  HAND_EDIT_REPLACED_NOTE,
  EDIT_OTHER_TEXT_NOTE,
  AT_ONCE_NOTE,
  GETTIME_ANCHOR_NOTE,
} from '../dist/mcp.js';

// A real MCP client and a fake page. The program is neutral, built here.
const LONG = Array.from({ length: 12 }, (_, i) => `t${i + 1}: s("bd").lpf(${1000 + i})`).join('\n');

/** LONG with each unique text swapped, the way an exact edit set would. */
function swapped(...pairs) {
  let code = LONG;
  for (const [from, to] of pairs) code = code.split(from).join(to);
  return code;
}

/** The first part of a get_code reply: the code, before its first blank line. */
function codeOf(result) {
  return withoutArmingLine(result.content[0].text).split('\n\n')[0];
}

test('edit_code: exact edits take over through the set_code path and the reply shows only the changed lines', async (t) => {
  const { client, port } = await startMcpClient();
  const page = await createFakePage(port);
  t.after(async () => {
    page.ws.close();
    await client.close();
  });

  const evaluates = [];
  page.setResponder((msg) => {
    evaluates.push(msg);
    return { type: 'evaluated', id: msg.id, ok: true, code: msg.code, audio: 'playing' };
  });
  const textOf = (result) => withoutArmingLine(result.content[0].text);

  await t.test('one edit', async () => {
    const first = await client.callTool({ name: 'set_code', arguments: { code: LONG } });
    assert.ok(!first.isError);
    assert.equal(evaluates.length, 1);

    const expected = swapped(['lpf(1005)', 'lpf(1105)']);
    const result = await client.callTool({
      name: 'edit_code',
      arguments: { edits: [{ old_string: 'lpf(1005)', new_string: 'lpf(1105)' }], label: 'one value' },
    });
    assert.ok(!result.isError, textOf(result));
    assert.equal(evaluates.length, 2, 'exactly one more evaluate reached the page');
    assert.equal(evaluates[1].code, expected);
    assert.equal(evaluates[1].at, undefined);

    const text = textOf(result);
    assert.ok(text.startsWith('ok, playing'));
    const lines = text.split('\n');
    const head = lines.map((line) => /^Edited 1 place in the code playing now \(#(\d+)\), now #(\d+)\.$/.exec(line)).find(Boolean);
    assert.ok(head, `head line in: ${text}`);
    assert.equal(Number(head[2]), Number(head[1]) + 1);
    assert.ok(lines.includes('Lines of the code that will play (> marks a changed line):'));
    assert.ok(lines.includes('> 6 | t6: s("bd").lpf(1105)'));
    assert.ok(lines.includes('  4 | t4: s("bd").lpf(1003)'));
    assert.ok(lines.includes('  8 | t8: s("bd").lpf(1007)'));
    for (const absent of ['t1:', 't3:', 't9:', 't12:']) {
      assert.ok(!text.includes(absent), `${absent} must not be echoed`);
    }

    assert.equal(codeOf(await client.callTool({ name: 'get_code', arguments: {} })), expected);
  });

  await t.test('two edits in one call are both applied', async () => {
    const before = evaluates.length;
    const current = codeOf(await client.callTool({ name: 'get_code', arguments: {} }));
    const expected = current.split('lpf(1001)').join('lpf(2001)').split('lpf(1010)').join('lpf(2010)');
    const result = await client.callTool({
      name: 'edit_code',
      arguments: {
        edits: [
          { old_string: 'lpf(1001)', new_string: 'lpf(2001)' },
          { old_string: 'lpf(1010)', new_string: 'lpf(2010)' },
        ],
      },
    });
    assert.ok(!result.isError, textOf(result));
    assert.equal(evaluates.length, before + 1);
    assert.equal(evaluates[before].code, expected);
    const text = textOf(result);
    assert.ok(/^Edited 2 places in the code playing now/m.test(text));
    assert.ok(text.split('\n').includes('  ...'), 'a gap line between the two windows');
    // The line numbers share one width (the largest shown number is 12).
    assert.ok(text.split('\n').includes('>  2 | t2: s("bd").lpf(2001)'));
    assert.ok(text.split('\n').includes('> 11 | t11: s("bd").lpf(2010)'));
  });
});

test('edit_code refusals: nothing reaches the page and what plays is unchanged', async (t) => {
  await t.test('no page: fails fast with the exact set_code text', async (t2) => {
    const { client, url } = await startMcpClient();
    t2.after(async () => {
      await client.close();
    });
    const start = Date.now();
    const result = await client.callTool({
      name: 'edit_code',
      arguments: { edits: [{ old_string: 'a', new_string: 'b' }] },
    });
    const elapsed = Date.now() - start;
    assert.ok(result.isError);
    assert.equal(result.content[0].text, `No page connected — open ${url} and click to start sound.`);
    assert.ok(elapsed < 1000, `expected the immediate failure to take under 1000ms, took ${elapsed}ms`);
  });

  const { client, port } = await startMcpClient();
  const page = await createFakePage(port);
  t.after(async () => {
    page.ws.close();
    await client.close();
  });
  const evaluates = [];
  page.setResponder((msg) => {
    evaluates.push(msg);
    return { type: 'evaluated', id: msg.id, ok: true, code: msg.code, audio: 'playing' };
  });
  const REFUSED_HEAD =
    'edit_code applied nothing and sent nothing to the page, so what plays is unchanged. The edits were matched against the code playing now:';

  await t.test('nothing played yet', async () => {
    const result = await client.callTool({
      name: 'edit_code',
      arguments: { edits: [{ old_string: 'a', new_string: 'b' }] },
    });
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes(EDIT_NOTHING_PLAYING_MESSAGE));
    assert.equal(evaluates.length, 0);
  });

  await client.callTool({ name: 'set_code', arguments: { code: LONG } });
  assert.equal(evaluates.length, 1);

  /** A refusal: a tool error that starts with the fixed head, leaves the page and the code alone. */
  async function refused(edits) {
    const before = evaluates.length;
    const result = await client.callTool({ name: 'edit_code', arguments: { edits } });
    assert.ok(result.isError, 'expected a tool error');
    const text = withoutArmingLine(result.content[0].text);
    assert.ok(text.startsWith(REFUSED_HEAD), text);
    assert.equal(evaluates.length, before, 'no evaluate reached the page');
    assert.equal(codeOf(await client.callTool({ name: 'get_code', arguments: {} })), LONG);
    return text.split('\n');
  }

  await t.test('an old_string that matches nowhere', async () => {
    const lines = await refused([{ old_string: 'lpf(9999)', new_string: 'lpf(1)' }]);
    assert.ok(lines.includes('- edit 1 of 1: old_string matches nowhere: "lpf(9999)"'));
  });

  await t.test('an empty old_string and a not-found edit are both listed', async () => {
    const lines = await refused([
      { old_string: '', new_string: 'x' },
      { old_string: 'nope', new_string: 'y' },
    ]);
    assert.ok(lines.some((line) => line.startsWith('- edit 1 of 2: old_string is empty')));
    assert.ok(lines.some((line) => line.startsWith('- edit 2 of 2: old_string matches nowhere')));
  });

  await t.test('two overlapping edits', async () => {
    const lines = await refused([
      { old_string: '.lpf(1005)', new_string: '.lpf(1)' },
      { old_string: 'lpf(1005)', new_string: 'lpf(2)' },
    ]);
    assert.ok(lines.some((line) => line.startsWith('- edit 2 of 2: overlaps edit 1')));
  });

  await t.test('the schema refuses 51 edits, an extra field and a missing new_string', async () => {
    const before = evaluates.length;
    const tooMany = Array.from({ length: 51 }, (_, i) => ({ old_string: `lpf(${1000 + (i % 12)})`, new_string: 'x' }));
    const extra = [{ old_string: 'lpf(1005)', new_string: 'lpf(1)', oldString: 'lpf(1005)' }];
    const missing = [{ old_string: 'lpf(1005)' }];
    for (const edits of [tooMany, extra, missing]) {
      const result = await client.callTool({ name: 'edit_code', arguments: { edits } });
      assert.ok(result.isError);
    }
    assert.equal(evaluates.length, before);
  });

  await t.test('phraseCycles without at: phrase', async () => {
    const before = evaluates.length;
    const result = await client.callTool({
      name: 'edit_code',
      arguments: { edits: [{ old_string: 'lpf(1005)', new_string: 'lpf(1)' }], phraseCycles: 8 },
    });
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes("phraseCycles applies only with at: 'phrase'"));
    assert.equal(evaluates.length, before);
  });
});

/** Waits a short tick so an unsolicited page frame has time to arrive before a tool call. */
function tick(ms = 50) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const occurrences = (text, needle) => text.split(needle).length - 1;

test('edit_code tells the truth about the code it changed: hand edits, waiting changes, timing, history', async (t) => {
  const { client, port } = await startMcpClient();
  const page = await createFakePage(port);
  t.after(async () => {
    page.ws.close();
    await client.close();
  });

  const evaluates = [];
  /**
   * What the fake page answers to the next evaluate: pending, bpm, audio, cancelBefore (the id of a waiting change the
   * page cancels as replaced before it answers), codeSuffix (appended to the confirmed text) and fail.
   */
  let answer = {};
  page.setResponder((msg) => {
    evaluates.push(msg);
    if (answer.fail) return { type: 'evaluated', id: msg.id, ok: false, code: msg.code, error: 'boom', line: 2 };
    const reply = {
      type: 'evaluated',
      id: msg.id,
      ok: true,
      code: msg.code + (answer.codeSuffix ?? ''),
      audio: answer.audio ?? 'playing',
    };
    if (answer.pending !== undefined) reply.pending = answer.pending;
    if (answer.bpm !== undefined) reply.bpm = answer.bpm;
    return answer.cancelBefore !== undefined
      ? [{ type: 'takeover-canceled', id: answer.cancelBefore, reason: 'replaced' }, reply]
      : reply;
  });
  const textOf = (result) => withoutArmingLine(result.content[0].text);
  const getCode = async () => codeOf(await client.callTool({ name: 'get_code', arguments: {} }));
  const getText = async () => textOf(await client.callTool({ name: 'get_code', arguments: {} }));
  const editCode = (edits, extra = {}) => client.callTool({ name: 'edit_code', arguments: { edits, ...extra } });
  const swap = (from, to) => [{ old_string: from, new_string: to }];
  const takeover = async (request) => {
    page.send({ type: 'takeover', id: request.id });
    await tick();
  };

  const P0 = 'a: s("bd")\nb: s("hh")\nc: s("cp")';
  const HAND = 'd: s("rim")';

  await t.test('a hand edit evaluated with Ctrl+Enter is kept, and the reply says so once', async () => {
    answer = {};
    await client.callTool({ name: 'set_code', arguments: { code: P0 } });
    page.send({ type: 'hand-eval', ok: true, code: `${P0}\n${HAND}` });
    await tick();
    const result = await editCode(swap('hh', 'oh'));
    assert.ok(!result.isError, textOf(result));
    const sent = evaluates.at(-1).code;
    assert.equal(sent, 'a: s("bd")\nb: s("oh")\nc: s("cp")\nd: s("rim")');
    const text = textOf(result);
    assert.equal(occurrences(text, HAND_EDIT_KEPT_NOTE), 1, text);
    assert.equal(occurrences(text, HAND_EDIT_REPLACED_NOTE), 0, text);
    assert.equal(await getCode(), sent);
  });

  await t.test('a timed edit: the reply says the line, the head says the version, get_code keeps the old code', async () => {
    answer = { pending: { cycle: 12, seconds: 6.2 }, bpm: 96 };
    const before = await getCode();
    const result = await editCode(swap('bd', 'sd'), { at: 'bar' });
    assert.ok(!result.isError, textOf(result));
    const text = textOf(result);
    assert.ok(
      text.startsWith('ok. The change takes over at cycle 12 (next bar), in about 6.2 s. The music keeps playing until then.'),
      text,
    );
    assert.ok(/^Edited 1 place in the code playing now \(#\d+\); the result is recorded when it takes over\.$/m.test(text), text);
    assert.ok(text.split('\n').includes('Tempo from cycle 12: 96 BPM.'), text);
    const request = evaluates.at(-1);
    assert.equal(request.at, 'bar');
    const during = await getText();
    assert.equal(during.split('\n\n')[0], before, 'get_code answers with the playing code');
    assert.ok(during.split('\n').some((line) => line.startsWith('Note: a change waits to take over at cycle 12 (next bar)')), during);
    await takeover(request);
    assert.equal(await getCode(), before.replace('bd', 'sd'));
  });

  await t.test('an edit of the waiting change applies to its code and says so', async () => {
    const playing = await getCode();
    answer = { pending: { cycle: 12, seconds: 4 } };
    const waitingCode = playing.replace('cp', 'rim2');
    await client.callTool({ name: 'set_code', arguments: { code: waitingCode, at: 'bar' } });
    const waiting = evaluates.at(-1);
    answer = { pending: { cycle: 12, seconds: 4 }, cancelBefore: waiting.id };
    const result = await editCode(swap('oh', 'hh'), { at: 'bar' });
    assert.ok(!result.isError, textOf(result));
    const text = textOf(result);
    assert.ok(
      text.split('\n').includes(
        'Edited 1 place in the change waiting for cycle 12 (next bar); its code is part of this change, recorded when it takes over.',
      ),
      text,
    );
    const replaced = 'Note: the change you sent for cycle 12 did not take over: a newer change replaced it before then.';
    assert.equal(occurrences(text, replaced), 1, text);
    const request = evaluates.at(-1);
    assert.equal(request.code, waitingCode.replace('oh', 'hh'), 'the waiting code, edited');
    assert.equal(await getCode(), playing, 'get_code keeps the playing code until the takeover');
    await takeover(request);
    assert.equal(await getCode(), waitingCode.replace('oh', 'hh'));
  });

  await t.test('an at-once edit of a waiting change names the cycle and the version', async () => {
    const playing = await getCode();
    answer = { pending: { cycle: 20, seconds: 5 } };
    await client.callTool({ name: 'set_code', arguments: { code: playing.replace('rim2', 'rim3'), at: 'bar' } });
    answer = { cancelBefore: evaluates.at(-1).id };
    const result = await editCode(swap('hh', 'oh'));
    assert.ok(!result.isError, textOf(result));
    const text = textOf(result);
    assert.ok(
      /^Edited 1 place in the change waiting for cycle 20 \(next bar\); its code is part of this change, now #\d+\.$/m.test(text),
      text,
    );
    assert.equal(occurrences(text, HAND_EDIT_REPLACED_NOTE), 0, text);
  });

  await t.test('timing: phrase and phraseCycles travel, a bar line that was skipped gives the at-once note', async () => {
    answer = { pending: { cycle: 16, seconds: 14.4 } };
    const phrase = await editCode(swap('oh', 'hh'), { at: 'phrase', phraseCycles: 8 });
    assert.ok(!phrase.isError, textOf(phrase));
    const request = evaluates.at(-1);
    assert.equal(request.at, 'phrase');
    assert.equal(request.phraseCycles, 8);
    await takeover(request);
    answer = {};
    const atOnce = await editCode(swap('hh', 'oh'), { at: 'bar' });
    assert.ok(!atOnce.isError, textOf(atOnce));
    assert.ok(textOf(atOnce).split('\n').includes(AT_ONCE_NOTE), textOf(atOnce));
  });

  await t.test('a timed edit on a hand-edited code takes over without the replaced-by-hand note', async () => {
    answer = {};
    const playing = await getCode();
    page.send({ type: 'hand-eval', ok: true, code: `${playing}\ne: s("x")` });
    await tick();
    answer = { pending: { cycle: 24, seconds: 4 } };
    const result = await editCode(swap('oh', 'hh'), { at: 'bar' });
    assert.ok(!result.isError, textOf(result));
    assert.equal(occurrences(textOf(result), HAND_EDIT_KEPT_NOTE), 1, textOf(result));
    await takeover(evaluates.at(-1));
    const after = await getText();
    assert.ok(!after.includes('took over and replaced code that had been edited by hand'), after);
    assert.ok(after.includes('e: s("x")'), 'the hand line is still in the code');
  });

  await t.test('base: the version playing now applies, an older one is refused and nothing is sent', async () => {
    answer = {};
    const first = textOf(await editCode(swap('hh', 'oh')));
    const head = /, now #(\d+)\.$/m.exec(first);
    assert.ok(head, first);
    const n = Number(head[1]);
    const before = evaluates.length;
    const ok = await editCode(swap('oh', 'hh'), { base: n });
    assert.ok(!ok.isError, textOf(ok));
    assert.equal(evaluates.length, before + 1);
    const stale = await editCode(swap('hh', 'oh'), { base: n - 1 });
    assert.ok(stale.isError);
    assert.ok(textOf(stale).includes('the music moved on since version #'), textOf(stale));
    assert.equal(evaluates.length, before + 1, 'a refused edit sends nothing');
  });

  await t.test('history: the call is one change from Claude with its label', async () => {
    answer = {};
    const result = await editCode(swap('hh', 'oh'), { label: 'one value' });
    assert.ok(!result.isError, textOf(result));
    const rows = textOf(await client.callTool({ name: 'list_history', arguments: {} })).split('\n');
    const first = rows.find((row) => row.startsWith('#'));
    assert.ok(first.includes('— claude — "one value"'), first);
  });

  await t.test('an evaluation failure is a tool error and leaves the code', async () => {
    const before = await getCode();
    answer = { fail: true };
    const result = await editCode(swap('oh', 'hh'));
    assert.ok(result.isError);
    assert.ok(textOf(result).startsWith('Evaluation failed: boom, line 2.'), textOf(result));
    answer = {};
    assert.equal(await getCode(), before);
  });

  await t.test('the getTime() note is the last line, though the edit is far from the reading line', async () => {
    answer = {};
    await editCode(swap('a: s("sd")', 'a: s("sd").gain(getTime() % 1)'));
    const result = await editCode(swap('c: s("rim3")', 'c: s("sn")'));
    assert.ok(!result.isError, textOf(result));
    assert.equal(textOf(result).split('\n').at(-1), GETTIME_ANCHOR_NOTE);
  });

  await t.test('when the page confirms another text, the reply says so', async () => {
    answer = { codeSuffix: '\n// page' };
    const result = await editCode(swap('sn', 'cp'));
    assert.ok(!result.isError, textOf(result));
    assert.equal(occurrences(textOf(result), EDIT_OTHER_TEXT_NOTE), 1, textOf(result));
  });
});

// get_code points to edit_code from EDIT_HINT_MIN_LINES lines of code, after the notes it already had.
test('get_code adds the version line for long code, after the existing notes', async (t) => {
  const { client, port } = await startMcpClient();
  const page = await createFakePage(port);
  t.after(async () => {
    page.ws.close();
    await client.close();
  });

  let answer = {};
  const evaluates = [];
  page.setResponder((msg) => {
    evaluates.push(msg);
    const reply = { type: 'evaluated', id: msg.id, ok: true, code: msg.code, audio: 'playing' };
    if (answer.pending !== undefined) reply.pending = answer.pending;
    return reply;
  });
  const textOf = (result) => withoutArmingLine(result.content[0].text);
  const getText = async () => textOf(await client.callTool({ name: 'get_code', arguments: {} }));
  const program = (count, extra = '') =>
    Array.from({ length: count }, (_, i) => `t${i}: s("bd").lpf(${1000 + i})`).join('\n') + extra;
  const currentVersion = async () => {
    const rows = textOf(await client.callTool({ name: 'list_history', arguments: {} }));
    const match = /^#(\d+) /m.exec(rows);
    assert.ok(match, rows);
    return Number(match[1]);
  };
  const hint = (id) =>
    `Version #${id}. To change part of this code, edit_code sends only the change (base: ${id}); set_code is for a new piece or a rewrite of most of its lines.`;

  await t.test('a program under the threshold has no edit_code line', async () => {
    await client.callTool({ name: 'set_code', arguments: { code: program(EDIT_HINT_MIN_LINES - 1) } });
    assert.ok(!(await getText()).includes('edit_code'));
  });

  await t.test('a program at the threshold has the version line with the id list_history shows first', async () => {
    await client.callTool({ name: 'set_code', arguments: { code: program(EDIT_HINT_MIN_LINES), label: 'long one' } });
    const id = await currentVersion();
    const text = await getText();
    assert.equal(withoutPageLine(text), `${program(EDIT_HINT_MIN_LINES)}\n\n${hint(id)}`);
    const applied = await client.callTool({
      name: 'edit_code',
      arguments: { edits: [{ old_string: 'lpf(1001)', new_string: 'lpf(1101)' }], base: id },
    });
    assert.ok(!applied.isError, textOf(applied));
  });

  await t.test('a hand edit: the hand-edit note comes before the version line', async () => {
    await client.callTool({ name: 'set_code', arguments: { code: program(9) } });
    const id = await currentVersion();
    const edited = program(9, '\n// by hand');
    page.send({ type: 'hand-eval', ok: true, code: edited });
    await tick();
    const lines = (await getText()).split('\n');
    const note = lines.indexOf(HAND_EDIT_NOTE);
    assert.ok(note >= 0, lines.join('\n'));
    const version = lines.findIndex((line) => line.startsWith('Version #'));
    assert.ok(version > note, 'the version line comes after the hand-edit note');
    assert.equal(lines[version].startsWith(`Version #${await currentVersion()}.`), true);
    assert.ok(id <= (await currentVersion()));
  });

  await t.test('a waiting change: the waiting line comes first and the version is the playing one', async () => {
    await client.callTool({ name: 'set_code', arguments: { code: program(10) } });
    const playing = await currentVersion();
    answer = { pending: { cycle: 12, seconds: 3 } };
    const waiting = await client.callTool({ name: 'set_code', arguments: { code: program(10, '\n// next'), at: 'bar' } });
    assert.ok(!waiting.isError, textOf(waiting));
    const text = await getText();
    const lines = text.split('\n');
    const waitIndex = lines.findIndex((line) => line.includes('cycle 12'));
    const versionIndex = lines.indexOf(hint(playing));
    assert.ok(waitIndex >= 0 && versionIndex > waitIndex, text);
    assert.ok(!text.includes('// next'), 'get_code still shows the code playing');
    const request = evaluates.at(-1);
    page.send({ type: 'takeover-canceled', id: request.id, reason: 'stop' });
    await tick();
    answer = {};
  });
});
