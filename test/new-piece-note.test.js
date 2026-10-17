import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startMcpClient, createFakePage, withoutArmingLine } from './helpers.js';
import { NO_STRUCTURE_NOTE, GETTIME_ANCHOR_NOTE, newPieceWithoutStructureLines } from '../dist/mcp.js';
import { TINT_WORDS, STEERING_WORDS, findWords } from './tint-rules.js';

const NOTE = [NO_STRUCTURE_NOTE];

/** A line of exactly `length` characters, made of a letter and digits so two lines never collide. */
function lineOf(index, length) {
  return `${String.fromCharCode(97 + (index % 26))}${index}`.padEnd(length, 'z');
}

test('NO_STRUCTURE_NOTE is one plain line that names the topic and says the piece plays', () => {
  assert.ok(NO_STRUCTURE_NOTE.startsWith('Note:'));
  assert.ok(!NO_STRUCTURE_NOTE.includes('\n'));
  assert.ok(NO_STRUCTURE_NOTE.includes('structure topic of get_strudel_reference'));
  assert.ok(NO_STRUCTURE_NOTE.includes('It plays as written.'));
  assert.deepEqual(findWords(NO_STRUCTURE_NOTE, [...TINT_WORDS, ...STEERING_WORDS]), []);
});

test('newPieceWithoutStructureLines: a first piece without a song gives the note, with one gives nothing', () => {
  assert.deepEqual(newPieceWithoutStructureLines('', 'a: s("bd")'), NOTE);
  assert.deepEqual(newPieceWithoutStructureLines('', 'const song = {};\na: s("bd")'), []);
  assert.deepEqual(newPieceWithoutStructureLines('', '  const song = {};\na: s("bd")'), []);
  assert.deepEqual(newPieceWithoutStructureLines('', '\tconst song = {};\na: s("bd")'), []);
  assert.deepEqual(newPieceWithoutStructureLines('', 'const \t song={};'), []);
});

test('newPieceWithoutStructureLines: songs, song2 and a commented-out line are not a structure; let and var song are left to the page', () => {
  for (const code of [
    'const songs = {};\na: s("bd")',
    'const song2 = {};\na: s("bd")',
    'const song_ = {};\na: s("bd")',
    'let songs = {};\na: s("bd")',
    'var song2 = {};\na: s("bd")',
    '// const song = {};\na: s("bd")',
    '// let song = {};\na: s("bd")',
    'a: s("bd") // const song = {};',
    'constsong = 1',
    'letsong = 1',
  ]) {
    assert.deepEqual(newPieceWithoutStructureLines('', code), NOTE, JSON.stringify(code));
  }
  // The page names a song declared with let or var by itself, so the server says nothing and the two never disagree.
  for (const code of [
    'let song = { sections: [] }\nlead: note("c3")',
    'var song = { sections: [] }\nlead: note("c3")',
    '  let \t song={};',
    '\tvar song = {};',
  ]) {
    assert.deepEqual(newPieceWithoutStructureLines('', code), [], JSON.stringify(code));
  }
});

test('newPieceWithoutStructureLines: a piece is new when fewer than half of the previous long lines are kept', () => {
  const previous = Array.from({ length: 10 }, (_, i) => lineOf(i, 12));
  const keep = (count) => [...previous.slice(0, count), ...Array.from({ length: 10 - count }, (_, i) => lineOf(100 + i, 12))].join('\n');
  assert.deepEqual(newPieceWithoutStructureLines(previous.join('\n'), keep(10)), []);
  assert.deepEqual(newPieceWithoutStructureLines(previous.join('\n'), keep(6)), []);
  // Exactly half is not new.
  assert.deepEqual(newPieceWithoutStructureLines(previous.join('\n'), keep(5)), []);
  assert.deepEqual(newPieceWithoutStructureLines(previous.join('\n'), keep(4)), NOTE);
  assert.deepEqual(newPieceWithoutStructureLines(previous.join('\n'), keep(0)), NOTE);
  // Odd totals: 3 of 5 is more than half, 2 of 5 is less.
  const five = previous.slice(0, 5);
  assert.deepEqual(newPieceWithoutStructureLines(five.join('\n'), [...five.slice(0, 3), 'brand-new-1', 'brand-new-2'].join('\n')), []);
  assert.deepEqual(newPieceWithoutStructureLines(five.join('\n'), [...five.slice(0, 2), 'brand-new-1', 'brand-new-2'].join('\n')), NOTE);
});

test('newPieceWithoutStructureLines: lines are compared trimmed, and CRLF counts as LF', () => {
  const previous = ['first line of it', 'second line of it'].join('\n');
  assert.deepEqual(newPieceWithoutStructureLines(previous, '  first line of it  \r\n\tsecond line of it\r\n'), []);
});

test('newPieceWithoutStructureLines: only lines of 8 or more characters count, a line of 8 does, 7 does not', () => {
  // A previous made only of short lines counts as empty: the next piece is new.
  assert.deepEqual(newPieceWithoutStructureLines('short\n1234567\n\n  tiny  ', 'a: s("bd")'), NOTE);
  assert.deepEqual(newPieceWithoutStructureLines('   \n\n', 'a: s("bd")'), NOTE);
  // A line of exactly 8 characters counts: kept, the piece is not new; dropped, it is.
  assert.deepEqual(newPieceWithoutStructureLines('12345678', '12345678\nother'), []);
  assert.deepEqual(newPieceWithoutStructureLines('12345678', 'other'), NOTE);
  // A line of 7 characters is not counted: one long line kept out of one long line plus short ones.
  assert.deepEqual(newPieceWithoutStructureLines('1234567\nlong enough line', 'long enough line'), []);
  assert.deepEqual(newPieceWithoutStructureLines('1234567\n7654321\nlong enough line', 'long enough line'), []);
  // Trimmed length is what counts: padding does not make a short line long.
  assert.deepEqual(newPieceWithoutStructureLines('   1234567   ', 'a: s("bd")'), NOTE);
});

test('newPieceWithoutStructureLines: a 200,000-character adversarial input returns within 200 ms', () => {
  const inputs = [
    ' '.repeat(200000),
    '\n'.repeat(200000),
    `${' '.repeat(200000)}x`,
    `${'\n'.repeat(200000)}const`,
    'const '.repeat(Math.ceil(200000 / 6)),
    'const song'.repeat(Math.ceil(200000 / 10)),
    'let '.repeat(Math.ceil(200000 / 4)),
    `var${' \t'.repeat(100000)}songs`,
    'const song\n'.repeat(Math.ceil(200000 / 11)).replace(/song/g, 'songs'),
    `\t${' '.repeat(200000)}const song`,
    `const${' '.repeat(200000)}x`,
    `const${' \t'.repeat(100000)}songs`,
  ];
  for (const input of inputs) {
    for (const [previous, code] of [['', input], [input, 'a: s("bd")'], [input, input]]) {
      const started = performance.now();
      newPieceWithoutStructureLines(previous, code);
      const elapsed = performance.now() - started;
      assert.ok(elapsed < 200, `took ${elapsed.toFixed(1)} ms on an input starting ${JSON.stringify(input.slice(0, 20))}`);
    }
  }
});

test('set_code: the new-piece note rides after the drained lines and before the getTime note, and never fails the call', async (t) => {
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
  const longLines = (prefix, count) => Array.from({ length: count }, (_, i) => `${prefix}${i}: s("bd").lpf(${1000 + i})`).join('\n');

  await t.test('a new piece without a structure plays, with the note as the last line and a normal status', async () => {
    const code = longLines('a', 10);
    const result = await client.callTool({ name: 'set_code', arguments: { code } });
    assert.ok(!result.isError, textOf(result));
    assert.equal(evaluates.at(-1).code, code, 'the code reached the page as written');
    const text = textOf(result);
    assert.ok(text.startsWith('ok, playing'), text);
    assert.ok(text.endsWith(`\n\n${NO_STRUCTURE_NOTE}`), text);
  });

  await t.test('a structured piece gets no note', async () => {
    const result = await client.callTool({
      name: 'set_code',
      arguments: { code: `const song = { shift: 0 };\n${longLines('b', 10)}` },
    });
    assert.ok(!result.isError, textOf(result));
    assert.ok(!textOf(result).includes(NO_STRUCTURE_NOTE));
  });

  await t.test('a small change to an older piece without a structure gets no note', async () => {
    const older = longLines('c', 10);
    await client.callTool({ name: 'set_code', arguments: { code: older } });
    const changed = older.replace('lpf(1003)', 'lpf(2003)');
    assert.notEqual(changed, older);
    const result = await client.callTool({ name: 'set_code', arguments: { code: changed } });
    assert.ok(!result.isError, textOf(result));
    assert.ok(!textOf(result).includes(NO_STRUCTURE_NOTE));
  });

  await t.test('edit_code never carries the note', async () => {
    const older = longLines('d', 10);
    await client.callTool({ name: 'set_code', arguments: { code: older } });
    const result = await client.callTool({
      name: 'edit_code',
      arguments: { edits: [{ old_string: 'lpf(1003)', new_string: 'lpf(3003)' }] },
    });
    assert.ok(!result.isError, textOf(result));
    assert.ok(!textOf(result).includes(NO_STRUCTURE_NOTE));
  });

  await t.test('the note comes after the drained notices and the flag note, and before the getTime note', async () => {
    page.setResponder((msg) => {
      page.send({ type: 'runtime-error', message: 'sound nosuch not found', evaluateId: msg.id });
      return { type: 'evaluated', id: msg.id, ok: true, code: msg.code, audio: 'playing' };
    });
    const code = `const t0 = getTime();\ns("bd").when("t f", (x) => x.fast(2))\n${longLines('e', 10)}`;
    const result = await client.callTool({ name: 'set_code', arguments: { code } });
    assert.ok(!result.isError, textOf(result));
    const lines = textOf(result).split('\n');
    const at = (predicate) => lines.findIndex(predicate);
    const drained = at((line) => line.startsWith('Runtime error while playing'));
    const flag = at((line) => line.startsWith('Note: this code gives .when()'));
    const note = at((line) => line === NO_STRUCTURE_NOTE);
    const getTime = at((line) => line === GETTIME_ANCHOR_NOTE);
    assert.ok(drained >= 0 && flag >= 0 && note >= 0 && getTime >= 0, textOf(result));
    assert.ok(drained < flag && flag < note && note < getTime, `order ${drained} ${flag} ${note} ${getTime}`);
    assert.equal(getTime, lines.length - 1, 'the getTime note stays last');
  });
});
