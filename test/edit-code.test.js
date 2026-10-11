import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_EXCERPT_CHARS,
  MAX_EXCERPT_HUNKS,
  MAX_EXCERPT_LINE_CHARS,
  MAX_LISTED_PROBLEMS,
  applyEdits,
  changedExcerpt,
} from '../dist/edit-code.js';

const CUT_LINE = '  ... cut here; get_code returns the whole program.';

/** The problems of a refused edit set; fails the test when the set was applied. */
function problemsOf(base, edits) {
  const result = applyEdits(base, edits);
  assert.equal(result.ok, false, 'expected a refusal');
  return result.problems;
}

/** The composed code of an applied edit set; fails the test when the set was refused. */
function codeOf(base, edits) {
  const result = applyEdits(base, edits);
  assert.equal(result.ok, true, result.ok ? '' : result.problems.join(' | '));
  return result.code;
}

/** The excerpt of one edit set applied to `base`. */
function excerptOf(base, edits) {
  const result = applyEdits(base, edits);
  assert.equal(result.ok, true, result.ok ? '' : result.problems.join(' | '));
  return changedExcerpt(result.code, result.ranges);
}

/** Excerpt lines without the header. */
function bodyOf(excerpt) {
  return excerpt.split('\n').slice(1);
}

const numbered = (count) => Array.from({ length: count }, (_, i) => `row${i + 1}`);

test('applyEdits: every edit is matched against the original code, never against another edit', () => {
  assert.equal(
    codeOf('a b c', [
      { old_string: 'a', new_string: 'b' },
      { old_string: 'b', new_string: 'c' },
    ]),
    'b c c',
  );
});

test('applyEdits: replacement text is written verbatim, including every dollar form', () => {
  for (const value of ['$&', '$1', '$$', "$'", '$`', '$: s("bd")', '${x}']) {
    assert.equal(codeOf('a X b', [{ old_string: 'X', new_string: value }]), `a ${value} b`);
  }
});

test('applyEdits: replace_all replaces every match and reports the ranges in order', () => {
  const result = applyEdits('x y x', [{ old_string: 'x', new_string: 'zz', replace_all: true }]);
  assert.equal(result.ok, true);
  assert.equal(result.code, 'zz y zz');
  assert.deepEqual(result.ranges, [
    { start: 0, end: 2 },
    { start: 5, end: 7 },
  ]);
});

test('applyEdits: CRLF counts as LF in old_string, new_string and the base; a lone CR is kept', () => {
  assert.equal(codeOf('a\nb\nc', [{ old_string: 'a\r\nb', new_string: 'A\r\nB' }]), 'A\nB\nc');
  assert.equal(codeOf('a\r\nb', [{ old_string: 'b', new_string: 'B' }]), 'a\nB');
  assert.equal(codeOf('a b', [{ old_string: 'b', new_string: 'x\ry' }]), 'a x\ry');
});

test('applyEdits: an empty old_string and a no-op edit are refused, naming the edit', () => {
  assert.deepEqual(problemsOf('abc', [{ old_string: '', new_string: 'x' }]), ['edit 1 of 1: old_string is empty']);
  assert.deepEqual(problemsOf('abc', [{ old_string: 'b', new_string: 'b' }]), [
    'edit 1 of 1: old_string and new_string are the same',
  ]);
  assert.deepEqual(problemsOf('a\nb', [{ old_string: 'a\r\nb', new_string: 'a\nb' }]), [
    'edit 1 of 1: old_string and new_string are the same',
  ]);
});

test('applyEdits: an old_string that matches nowhere is refused with an echo of at most 80 code points', () => {
  assert.deepEqual(problemsOf('abc', [{ old_string: 'zz', new_string: 'x' }]), [
    'edit 1 of 1: old_string matches nowhere: "zz"',
  ]);
  const long = 'q'.repeat(85);
  assert.deepEqual(problemsOf('abc', [{ old_string: long, new_string: 'x' }]), [
    `edit 1 of 1: old_string matches nowhere: "${'q'.repeat(80)}…"`,
  ]);
});

test('applyEdits: several matches without replace_all are refused with the count and the lines', () => {
  const tail = 'add surrounding text so it matches once, or set replace_all: "bd"';
  const lines = ['x', 'bd', 'x', 'x', 'bd', 'x', 'x', 'x', 'bd'].join('\n');
  assert.deepEqual(problemsOf(lines, [{ old_string: 'bd', new_string: 'sd' }]), [
    `edit 1 of 1: old_string matches 3 times (lines 2, 5, 9); ${tail}`,
  ]);
  assert.deepEqual(problemsOf('bd bd', [{ old_string: 'bd', new_string: 'sd' }]), [
    `edit 1 of 1: old_string matches 2 times (line 1); ${tail}`,
  ]);
  const eight = Array.from({ length: 8 }, () => 'bd').join('\n');
  assert.deepEqual(problemsOf(eight, [{ old_string: 'bd', new_string: 'sd' }]), [
    `edit 1 of 1: old_string matches 8 times (lines 1, 2, 3, 4, 5 and 3 more); ${tail}`,
  ]);
});

test('applyEdits: matches that overlap each other count as several, and replace_all cannot apply them', () => {
  const [problem] = problemsOf('aaa', [{ old_string: 'aa', new_string: 'b' }]);
  assert.ok(problem.startsWith('edit 1 of 1: old_string matches 2 times'), problem);
  assert.deepEqual(problemsOf('aaa', [{ old_string: 'aa', new_string: 'b', replace_all: true }]), [
    'edit 1 of 1: old_string matches in places that overlap each other (line 1), so replace_all cannot apply it: "aa"',
  ]);
});

test('applyEdits: two edits over the same text overlap; touching ranges are applied', () => {
  assert.deepEqual(
    problemsOf('a b', [
      { old_string: 'a b', new_string: 'x' },
      { old_string: 'a', new_string: 'y' },
    ]),
    ['edit 2 of 2: overlaps edit 1 (line 1)'],
  );
  assert.equal(
    codeOf('ab', [
      { old_string: 'a', new_string: 'x' },
      { old_string: 'b', new_string: 'y' },
    ]),
    'xy',
  );
});

test('applyEdits: edits that together change nothing, and a result that is empty, are refused', () => {
  assert.deepEqual(
    problemsOf('abb', [
      { old_string: 'a', new_string: 'ab' },
      { old_string: 'bb', new_string: 'b' },
    ]),
    ['the edits together change nothing'],
  );
  assert.deepEqual(problemsOf('a', [{ old_string: 'a', new_string: '' }]), ['the result would be empty']);
  assert.deepEqual(problemsOf('a ', [{ old_string: 'a', new_string: '' }]), ['the result would be empty']);
});

test('applyEdits: every failing edit is listed in edit order, at most five, then a count of the rest', () => {
  const edits = Array.from({ length: 7 }, (_, i) => ({ old_string: `zz${i}`, new_string: 'x' }));
  const problems = problemsOf('abc', edits);
  assert.equal(problems.length, MAX_LISTED_PROBLEMS + 1);
  assert.ok(problems[0].startsWith('edit 1 of 7: old_string matches nowhere'));
  assert.ok(problems[4].startsWith('edit 5 of 7: old_string matches nowhere'));
  assert.equal(problems[5], 'and 2 more refused edits');
  assert.equal(problemsOf('abc', [...edits.slice(0, 6)]).at(-1), 'and 1 more refused edit');
});

test('applyEdits: overlap and whole-call checks run only when every edit passed on its own', () => {
  const problems = problemsOf('a b', [
    { old_string: 'a b', new_string: 'x' },
    { old_string: 'a', new_string: 'y' },
    { old_string: 'zz', new_string: 'q' },
  ]);
  assert.deepEqual(problems, ['edit 3 of 3: old_string matches nowhere: "zz"']);
});

test('changedExcerpt: a change on the first or last line shows three lines', () => {
  const base = numbered(10).join('\n');
  const first = excerptOf(base, [{ old_string: 'row1\n', new_string: 'ROW1\n' }]);
  assert.equal(first.split('\n')[0], 'Lines of the code that will play (> marks a changed line):');
  assert.deepEqual(bodyOf(first), ['> 1 | ROW1', '  2 | row2', '  3 | row3']);
  const last = excerptOf(base, [{ old_string: 'row10', new_string: 'ROW10' }]);
  assert.deepEqual(bodyOf(last), ['   8 | row8', '   9 | row9', '> 10 | ROW10']);
});

test('changedExcerpt: windows five lines apart merge, ten lines apart show a gap', () => {
  const base = numbered(30).join('\n');
  const near = bodyOf(
    excerptOf(base, [
      { old_string: 'row3\n', new_string: 'R3\n' },
      { old_string: 'row8\n', new_string: 'R8\n' },
    ]),
  );
  assert.equal(near.length, 10);
  assert.ok(!near.includes('  ...'));
  const far = bodyOf(
    excerptOf(base, [
      { old_string: 'row3\n', new_string: 'R3\n' },
      { old_string: 'row13\n', new_string: 'R13\n' },
    ]),
  );
  assert.ok(far.includes('  ...'));
  assert.equal(far.filter((line) => line.startsWith('>')).length, 2);
});

test('changedExcerpt: a deletion marks the line where the cut landed, a three-line replacement marks all three', () => {
  const base = ['a', 'b', 'c', 'd', 'e'].join('\n');
  const deleted = bodyOf(excerptOf(base, [{ old_string: 'c\n', new_string: '' }]));
  assert.deepEqual(deleted, ['  1 | a', '  2 | b', '> 3 | d', '  4 | e']);
  const replaced = bodyOf(excerptOf(base, [{ old_string: 'b\nc', new_string: 'x\ny\nz' }]));
  assert.equal(replaced.filter((line) => line.startsWith('>')).length, 3);
});

test('changedExcerpt: line numbers 9 and 10 share one width', () => {
  const base = numbered(12).join('\n');
  const body = bodyOf(excerptOf(base, [{ old_string: 'row10', new_string: 'ROW10' }]));
  assert.ok(body.includes('   9 | row9'));
  assert.ok(body.includes('> 10 | ROW10'));
});

test('changedExcerpt: too many windows or too many characters end with the get_code pointer', () => {
  const base = numbered(120).join('\n');
  const edits = [];
  for (let line = 5; line <= 115; line += 10) edits.push({ old_string: `row${line}\n`, new_string: `ROW${line}\n` });
  assert.ok(edits.length > MAX_EXCERPT_HUNKS);
  const text = excerptOf(base, edits);
  assert.equal(text.split('\n').at(-1), CUT_LINE);
  assert.equal(text.split('\n').filter((line) => line.startsWith('>')).length, MAX_EXCERPT_HUNKS);

  const spaced = Array.from({ length: 40 }, (_, i) => `${i + 1} ${'k'.repeat(100)}`).join('\n');
  const capped = excerptOf(spaced, [{ old_string: ' kkkkkkkkkk', new_string: ' jjjjjjjjjj', replace_all: true }]);
  assert.ok(capped.length <= MAX_EXCERPT_CHARS + 1 + CUT_LINE.length);
  assert.equal(capped.split('\n').at(-1), CUT_LINE);
});

test('changedExcerpt: a very long line is cut to 200 code points plus an ellipsis', () => {
  const base = ['a', `b${'x'.repeat(300)}`, 'c'].join('\n');
  const body = bodyOf(excerptOf(base, [{ old_string: 'a', new_string: 'A' }]));
  assert.equal(body[1], `  2 | b${'x'.repeat(MAX_EXCERPT_LINE_CHARS - 1)}…`);
});
