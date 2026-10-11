import { test } from 'node:test';
import assert from 'node:assert/strict';
import { whenFlagLines, FLAG_STRING_NOTE } from '../dist/mcp.js';
import { FLAG_STRING_EXAMPLE_RE } from '../scripts/check-reference.mjs';

const NOTE = [FLAG_STRING_NOTE];

test('FLAG_STRING_NOTE is a Note line that states facts: t and f are plain strings and count as true', () => {
  assert.ok(FLAG_STRING_NOTE.startsWith('Note:'));
  assert.ok(FLAG_STRING_NOTE.includes('write 1 and 0'));
  assert.ok(!FLAG_STRING_NOTE.includes('\n'));
});

test('whenFlagLines: a t/f string literal given to when, struct or mask gives the note', () => {
  assert.deepEqual(whenFlagLines('s("bd").when("<f f t>", (x) => x.fast(2))'), NOTE);
  assert.deepEqual(whenFlagLines('s("bd").struct("t f t t")'), NOTE);
  assert.deepEqual(whenFlagLines("s('bd*4').mask('t ~ f')"), NOTE);
  assert.deepEqual(whenFlagLines('s("bd").when(`t f`, g)'), NOTE);
  assert.deepEqual(whenFlagLines('s("bd").when ( "t f" , g)'), NOTE);
  assert.deepEqual(whenFlagLines('s("bd").when("<[t f] ~>!", g)'), NOTE);
});

test('whenFlagLines: a ? with no number is part of the structure, so the note still fires', () => {
  assert.deepEqual(whenFlagLines('s("bd").when("t f?", g)'), NOTE);
  assert.deepEqual(whenFlagLines('s("bd").mask("<t f>?")'), NOTE);
  assert.deepEqual(whenFlagLines('s("bd").struct("?t f")'), NOTE);
  assert.deepEqual(whenFlagLines('const m = "t? f"\ns("bd").struct(m)'), NOTE);
  assert.deepEqual(whenFlagLines('s("bd").when("t f?0.3", g)'), []);
});

test('whenFlagLines: a top-level const t/f string passed by name gives the note, with LF or CRLF line endings', () => {
  const code = 'const fear = "<f f f t f f f f>"\nchord("C").when(fear, (x) => x.add(1))';
  assert.deepEqual(whenFlagLines(code), NOTE);
  assert.deepEqual(whenFlagLines(code.replace(/\n/g, '\r\n')), NOTE);
  assert.deepEqual(whenFlagLines('  const fear = \'t f\';\ns("bd").struct(fear)'), NOTE);
  assert.deepEqual(whenFlagLines('const m = "t f"\ns("bd*4").mask( m )'), NOTE);
});

test('whenFlagLines: a name that is not such a const gives nothing', () => {
  assert.deepEqual(whenFlagLines('let fear = "<f t>"\ns("bd").when(fear, g)'), []);
  assert.deepEqual(whenFlagLines('var fear = "<f t>"\ns("bd").when(fear, g)'), []);
  assert.deepEqual(whenFlagLines('const fear = "<0 1>"\ns("bd").when(fear, g)'), []);
  assert.deepEqual(whenFlagLines('s("bd").when(cond, g)'), []);
  assert.deepEqual(whenFlagLines('const fear = "t f"\ns("bd").when(other, g)'), []);
  assert.deepEqual(whenFlagLines('const fear = "t f"\ns("bd")'), []);
});

test('whenFlagLines: strings with a digit, other letters, only rests, or no t/f give nothing', () => {
  assert.deepEqual(whenFlagLines('s("bd").when("<0 1>", g)'), []);
  assert.deepEqual(whenFlagLines('s("bd").struct("1 0 1 1")'), []);
  assert.deepEqual(whenFlagLines('s("bd").mask("x ~ x")'), []);
  assert.deepEqual(whenFlagLines('s("bd").when("t1 f", g)'), []);
  assert.deepEqual(whenFlagLines('s("bd").when("true false", g)'), []);
  assert.deepEqual(whenFlagLines('s("bd").when("", g)'), []);
  assert.deepEqual(whenFlagLines('s("bd").when("~ ~", g)'), []);
  assert.deepEqual(whenFlagLines('s("t f")'), []);
  assert.deepEqual(whenFlagLines('note("t f").fast(2)'), []);
});

test('whenFlagLines: empty code gives nothing', () => {
  assert.deepEqual(whenFlagLines(''), []);
});

test('whenFlagLines: only the ASCII letters t and f count', () => {
  assert.deepEqual(whenFlagLines('s("bd").when("ｔ ｆ", g)'), []);
  assert.deepEqual(whenFlagLines('s("bd").when("т ф", g)'), []);
  assert.deepEqual(whenFlagLines('s("bd").when("т t", g)'), []);
});

test('whenFlagLines: several matches give the note once', () => {
  const code = 's("bd").when("t f", g)\ns("hh").struct("t t")\nconst a = "f"\ns("sd").mask(a)';
  assert.deepEqual(whenFlagLines(code), NOTE);
});

test('whenFlagLines: calling it twice gives the same answer (no shared regex state)', () => {
  const code = 's("bd").when("t f", g)';
  assert.deepEqual(whenFlagLines(code), NOTE);
  assert.deepEqual(whenFlagLines(code), NOTE);
  const named = 'const a = "t"\ns("bd").when(a, g)';
  assert.deepEqual(whenFlagLines(named), NOTE);
  assert.deepEqual(whenFlagLines(named), NOTE);
});

test('whenFlagLines: a 200,000-character adversarial input returns within 200 ms (linear regexes)', () => {
  const inputs = [
    `s("bd").when("${' '.repeat(200000)}`,
    'const x = "\n'.repeat(Math.ceil(200000 / 12)),
    `const x = "${' '.repeat(200000)}`,
    '.when("'.repeat(Math.ceil(200000 / 7)),
    `.when(${' '.repeat(200000)}`,
    `.when("${'t'.repeat(200000)}`,
    `.when("${' ~'.repeat(100000)}`,
    `${'\n'.repeat(200000)}const`,
    `${' '.repeat(200000)}x`,
  ];
  for (const input of inputs) {
    const started = performance.now();
    const lines = whenFlagLines(input);
    const elapsed = performance.now() - started;
    assert.deepEqual(lines, []);
    assert.ok(elapsed < 200, `took ${elapsed.toFixed(1)} ms on an input starting ${JSON.stringify(input.slice(0, 20))}`);
  }
});

test('the server notice and the check:reference example check flag the same strings, for every printable ASCII character', () => {
  // The two character classes are written out twice (src/mcp.ts and scripts/check-reference.mjs, which reads no
  // build output); this keeps them equal. Quotes and the backslash end or escape a string, so they are not probed.
  const skipped = new Set(['"', "'", '`', '\\']);
  for (let code = 0x20; code < 0x7f; code++) {
    const ch = String.fromCharCode(code);
    if (skipped.has(ch)) continue;
    for (const body of [`t${ch}f`, `${ch}t`, `f${ch}`, `${ch}`, `${ch}${ch}t`]) {
      const call = `s("bd").when("${body}", g)`;
      const server = whenFlagLines(call).length > 0;
      const reference = call.match(FLAG_STRING_EXAMPLE_RE) !== null;
      assert.equal(server, reference, `${JSON.stringify(body)}: server notice ${server}, reference check ${reference}`);
    }
  }
});
