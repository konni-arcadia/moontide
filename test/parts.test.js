import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'acorn';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  MAX_PART_NAME_LENGTH,
  PARTS_COPY,
  extractArrangements,
  readArrangements,
  arrangeProblemText,
  partsEmptyText,
  partsSkippedText,
  arrangementPosition,
  launchTargetCycle,
  launchOffset,
  applyArrangeOffset,
  rowSignature,
  partLaunchPart,
  partStates,
  sectionSpans,
} from '../page/parts.js';

const PROTOCOL_PATH = fileURLToPath(new URL('../src/protocol.ts', import.meta.url));

function arrangements(code, tracks = []) {
  return extractArrangements(code, { parse, tracks });
}

function read(code, tracks = []) {
  return readArrangements(code, { parse, tracks });
}

test('extractArrangements returns [] for code with no arrange() call', () => {
  assert.deepEqual(arrangements('s("bd*4")'), []);
});

test('a two-section arrange() gives names, lengths, starts and total', () => {
  const [a] = arrangements('main: arrange([4, verse], [8, chorus])');
  assert.deepEqual(a.sections, [
    { name: 'verse', length: 4, start: 0 },
    { name: 'chorus', length: 8, start: 4 },
  ]);
  assert.equal(a.total, 12);
});

test('a non-identifier section gets "Part N"; a non-integer or non-literal length skips the whole call', () => {
  const [a] = arrangements('arrange([2, note("c")])');
  assert.equal(a.sections[0].name, 'Part 1');
  assert.deepEqual(arrangements('arrange([x, a])'), []);
  assert.deepEqual(arrangements('arrange([1.5, a])'), []);
});

test('a trailing .late()/.early() call is read as the arrangement offset', () => {
  const [late] = arrangements('main: arrange([4, verse], [8, chorus]).late(3)');
  assert.equal(late.offset, 3);
  const [early] = arrangements('main: arrange([4, verse], [8, chorus]).early(2)');
  assert.equal(early.offset, -2);
});

test('launchTargetCycle picks the next cycle, or the one after when the lead time is too short', () => {
  assert.equal(launchTargetCycle({ now: 10.3, cps: 0.5 }), 11); // 1.4s left
  assert.equal(launchTargetCycle({ now: 10.9, cps: 0.5 }), 12); // only 0.2s left before 11
  assert.equal(launchTargetCycle({ now: 3, cps: 1, stopped: true }), 0);
});

test('launchTargetCycle throws a Moontide error when cps is not a finite positive number', () => {
  assert.throws(() => launchTargetCycle({ now: 3, cps: 0 }), /Moontide:/);
});

test('launchTargetCycle throws a Moontide error when now is not finite, instead of returning NaN', () => {
  assert.throws(() => launchTargetCycle({ now: NaN, cps: 0.5 }), /Moontide:/);
  assert.throws(() => launchTargetCycle({ now: Infinity, cps: 0.5 }), /Moontide:/);
  // A stopped page never reads `now`, so it is exempt from the finiteness check.
  assert.equal(launchTargetCycle({ now: NaN, cps: 0.5, stopped: true }), 0);
});

test('launchOffset and arrangementPosition agree on where a launch lands', () => {
  assert.equal(launchOffset(11, 4, 12), 7);
  assert.equal(arrangementPosition(11, 7, 12), 4);
});

test('applyArrangeOffset adds, replaces, then removes a single .late() call', () => {
  const code = 'main: arrange([4, verse], [8, chorus])';
  const [a] = arrangements(code);
  const withOffset = applyArrangeOffset(code, a, 7);
  assert.ok(withOffset.endsWith('.late(7)'));
  assert.equal(withOffset.split('.late(').length, 2);

  const [b] = arrangements(withOffset);
  const replaced = applyArrangeOffset(withOffset, b, 2);
  assert.equal(replaced.split('.late(').length, 2);
  assert.ok(replaced.endsWith('.late(2)'));

  const [c] = arrangements(replaced);
  const removed = applyArrangeOffset(replaced, c, 0);
  assert.equal(removed, code);
});

test('rowSignature encodes the arrangement index and every section name:length', () => {
  const [a] = arrangements('main: arrange([4, verse], [8, chorus])');
  assert.equal(rowSignature(a), '0:verse:4,chorus:8');
});

test('partLaunchPart clips a long name to MAX_PART_NAME_LENGTH with a trailing ellipsis', () => {
  const longName = 'x'.repeat(150);
  const clipped = partLaunchPart(longName);
  assert.equal(clipped.length, MAX_PART_NAME_LENGTH);
  assert.ok(clipped.endsWith('…'));
});

test('partLaunchPart leaves a short name untouched', () => {
  assert.equal(partLaunchPart('verse'), 'verse');
});

test('MAX_PART_NAME_LENGTH mirrors src/protocol.ts by hand', () => {
  const protocolSource = readFileSync(PROTOCOL_PATH, 'utf8');
  assert.ok(protocolSource.includes('MAX_PART_NAME_LENGTH = 100'));
  assert.equal(MAX_PART_NAME_LENGTH, 100);
});

// --- Playing, queued and idle part states, the countdown ---

test('the playing card shows its position and progress; the others read idle', () => {
  const [a] = arrangements('main: arrange([4, verse], [8, chorus])');
  const states = partStates({ arrangement: a, cycle: 6.5, cps: 0.5, playing: true, pending: null });
  assert.equal(states[1].state, 'playing');
  assert.equal(states[1].text, 'Playing — 3/8 cycles');
  assert.equal(states[1].progress, 2.5 / 8);
  assert.equal(states[0].state, 'idle');
  assert.equal(states[0].text, 'Idle — 4 cycles');
});

test('a pending launch shows a queued countdown until its target cycle arrives', () => {
  const [a] = arrangements('main: arrange([4, verse], [8, chorus])');
  const queued = partStates({ arrangement: a, cycle: 6.8, cps: 0.5, playing: true, pending: { partIndex: 0, targetCycle: 7 } });
  assert.equal(queued[0].state, 'queued');
  assert.equal(queued[0].text, 'Queued — starts in 0.4s');

  const arrived = partStates({ arrangement: a, cycle: 7, cps: 0.5, playing: true, pending: { partIndex: 0, targetCycle: 7 } });
  assert.notEqual(arrived[0].state, 'queued');
});

test('with playing false, every card reads idle regardless of position or a pending launch', () => {
  const [a] = arrangements('main: arrange([4, verse], [8, chorus])');
  const states = partStates({ arrangement: a, cycle: 6.5, cps: 0.5, playing: false, pending: { partIndex: 0, targetCycle: 7 } });
  assert.deepEqual(
    states.map((s) => s.state),
    ['idle', 'idle'],
  );
  assert.deepEqual(
    states.map((s) => s.text),
    ['Idle — 4 cycles', 'Idle — 8 cycles'],
  );
});

test('a one-section arrangement gives exactly one card', () => {
  const [a] = arrangements('main: arrange([4, verse])');
  const states = partStates({ arrangement: a, cycle: 1, cps: 0.5, playing: true, pending: null });
  assert.equal(states.length, 1);
});

// --- The arrange() sections above the Timeline lanes ---

const THREE_EQUAL_SECTIONS = 'main: arrange([2, one], [2, two], [2, three])';

test('sectionSpans gives 16 equal spans covering the page when offset is 0', () => {
  const [a] = arrangements(THREE_EQUAL_SECTIONS);
  const spans = sectionSpans(a, 0);
  assert.equal(spans.length, 16);
  assert.deepEqual(
    spans.map((s) => s.name),
    ['one', 'two', 'three', 'one', 'two', 'three', 'one', 'two', 'three', 'one', 'two', 'three', 'one', 'two', 'three', 'one'],
  );
  assert.equal(spans[0].x, 0);
  assert.equal(spans[0].width, 2);
});

test('sectionSpans with an offset starts the page on the tail of the previous section, clipped to the page start', () => {
  const [a0] = arrangements(THREE_EQUAL_SECTIONS);
  const [a] = arrangements(applyArrangeOffset(THREE_EQUAL_SECTIONS, a0, 1));
  const spans = sectionSpans(a, 0);
  assert.equal(spans[0].name, 'three');
  assert.equal(spans[0].x, 0);
  assert.equal(spans[0].width, 1);
  assert.equal(spans[1].name, 'one');
  assert.equal(spans[1].x, 1);
});

test('sectionSpans clips to [pageStart, pageStart + pageCycles)', () => {
  const [a] = arrangements(THREE_EQUAL_SECTIONS);
  const spans = sectionSpans(a, 0, 5);
  const totalWidth = spans.reduce((sum, s) => sum + s.width, 0);
  assert.equal(totalWidth, 5);
  assert.ok(spans.every((s) => s.x >= 0 && s.x + s.width <= 5));
});

test('readArrangements reads a plain arrange() like extractArrangements and reports no problem', () => {
  const result = read('main: arrange([4, verse], [8, chorus])');
  assert.equal(result.arrangements.length, 1);
  assert.deepEqual(result.arrangements, arrangements('main: arrange([4, verse], [8, chorus])'));
  assert.deepEqual(result.problems, []);
  assert.equal(result.callCount, 1);
});

test('readArrangements gives one problem for the first unreadable argument of a call, counted from 1', () => {
  const cases = [
    ['arrange()', { call: 1, section: null, reason: 'no-sections', source: null }],
    ['arrange(...list)', { call: 1, section: 1, reason: 'spread-not-const-list', source: '...list' }],
    ['arrange([4])', { call: 1, section: 1, reason: 'not-a-pair', source: '[4]' }],
    ['arrange([4, a], [, b])', { call: 1, section: 2, reason: 'not-a-pair', source: '[, b]' }],
    ['arrange([4, , ])', { call: 1, section: 1, reason: 'no-pattern', source: '[4, , ]' }],
    ['arrange([x, a])', { call: 1, section: 1, reason: 'length-name-unknown', source: 'x' }],
    ['arrange([1.5, a])', { call: 1, section: 1, reason: 'length-not-whole', source: '1.5' }],
    ['arrange([0, a])', { call: 1, section: 1, reason: 'length-not-above-zero', source: '0' }],
    ['arrange([-4, a])', { call: 1, section: 1, reason: 'length-not-above-zero', source: '-4' }],
    ['arrange(["4", a])', { call: 1, section: 1, reason: 'length-not-plain-number', source: '"4"' }],
    ['arrange([4, a], [y, b], [z, c])', { call: 1, section: 2, reason: 'length-name-unknown', source: 'y' }],
  ];
  for (const [code, problem] of cases) {
    const result = read(code);
    assert.deepEqual(result.arrangements, [], code);
    assert.deepEqual(result.problems, [problem], code);
    assert.equal(result.callCount, 1, code);
  }
});

test('a nested arrange() inside a skipped call is still read on its own', () => {
  const result = read('arrange([x, arrange([2, a])])');
  assert.equal(result.arrangements.length, 1);
  assert.equal(result.arrangements[0].total, 2);
  assert.equal(result.problems.length, 1);
  assert.equal(result.callCount, 2);
});

test('a quoted source longer than 40 code points is cut to 40 with an ellipsis', () => {
  const long = 'a'.repeat(60);
  const [problem] = read(`arrange([${long}, a])`).problems;
  assert.equal([...problem.source].length, 40);
  assert.ok(problem.source.endsWith('…'));
});

test('arrangeProblemText names the section and the reason, and the call when there are several', () => {
  const problem = { call: 1, section: 2, reason: 'length-not-plain-number', source: 'A' };
  assert.equal(arrangeProblemText(problem, 1), "Parts can't read this arrange(): the length of section 2 is not a plain number (A).");
  assert.equal(
    arrangeProblemText({ ...problem, call: 2 }, 3),
    "Parts can't read arrange() 2 of 3: the length of section 2 is not a plain number (A).",
  );
  assert.throws(() => arrangeProblemText({ ...problem, reason: 'nope' }, 1), /^Error: Moontide:/);
});

test('partsEmptyText joins the problem texts and ends with the shape rule', () => {
  const problems = [
    { call: 1, section: 1, reason: 'length-not-plain-number', source: 'x' },
    { call: 2, section: null, reason: 'no-sections', source: null },
  ];
  assert.equal(
    partsEmptyText(problems, 2),
    `${arrangeProblemText(problems[0], 2)} ${arrangeProblemText(problems[1], 2)} ${PARTS_COPY.shapeRule}`,
  );
  assert.match(partsEmptyText(problems.slice(0, 1), 1), /Lengths must be plain numbers/);
});

test('a length written as the name of a top-level const holding a whole number above zero is read', () => {
  const result = read('const A = 96\nb: arrange([A, x], [4, y])');
  assert.equal(result.arrangements.length, 1);
  assert.deepEqual(
    result.arrangements[0].sections.map((section) => section.length),
    [96, 4],
  );
  assert.equal(result.arrangements[0].total, 100);
  assert.deepEqual(result.problems, []);
  const both = read('const A = 4, B = 8\nb: arrange([A, x], [B, y])');
  assert.deepEqual(
    both.arrangements[0].sections.map((section) => section.length),
    [4, 8],
  );
});

test('a let, a var, a non-number const, a block const or a doubly bound name is not read as a constant', () => {
  const cases = [
    ['let A = 96\nb: arrange([A, x])', 'length-name-mutable'],
    ['var A = 96\nb: arrange([A, x])', 'length-name-mutable'],
    ["const A = '4'\nb: arrange([A, x])", 'length-const-not-number'],
    ['{ const A = 4 }\nb: arrange([A, x])', 'length-name-unknown'],
    ['const A = 96\nfunction f(A) { return A }\nb: arrange([A, x])', 'length-name-rebound'],
    ['const A = 96\nconst g = () => { const A = 2; return A }\nb: arrange([A, x])', 'length-name-rebound'],
    ['const A = 96\nconst g = ({ A }) => A\nb: arrange([A, x])', 'length-name-rebound'],
    ['const A = 96\nconst g = ([A]) => A\nb: arrange([A, x])', 'length-name-rebound'],
    ['const A = 96\nconst g = (a, ...A) => A\nb: arrange([A, x])', 'length-name-rebound'],
    ['const A = 96\ntry { f() } catch (A) { }\nb: arrange([A, x])', 'length-name-rebound'],
    ['const A = 96\nconst g = () => { class A {} }\nb: arrange([A, x])', 'length-name-rebound'],
  ];
  for (const [code, reason] of cases) {
    const result = read(code);
    assert.deepEqual(result.arrangements, [], code);
    assert.equal(result.problems.length, 1, code);
    assert.equal(result.problems[0].reason, reason, code);
    assert.equal(result.problems[0].call, 1, code);
    assert.equal(result.problems[0].source, 'A', code);
  }
});

function lengthsOf(code) {
  const result = read(code);
  assert.deepEqual(result.problems, [], code);
  assert.equal(result.arrangements.length, 1, code);
  return result.arrangements[0].sections.map((section) => section.length);
}

function problemOf(code) {
  const result = read(code);
  assert.deepEqual(result.arrangements, [], code);
  assert.equal(result.problems.length, 1, code);
  return result.problems[0];
}

test('a length written as constant arithmetic is read', () => {
  assert.deepEqual(lengthsOf('arrange([4 * 2, a])'), [8]);
  assert.deepEqual(lengthsOf('const BAR = 4\narrange([BAR * 2, a], [BAR, b])'), [8, 4]);
  assert.deepEqual(lengthsOf('arrange([(2 + 2) * 2, a])'), [8]);
  assert.deepEqual(lengthsOf('arrange([16 / 4, a])'), [4]);
  assert.deepEqual(lengthsOf('arrange([-(-4), a])'), [4]);
  assert.deepEqual(lengthsOf('arrange([+4, a])'), [4]);
  assert.deepEqual(lengthsOf('arrange([10 - 2 - 2, a])'), [6]);
});

test('chained top-level consts are resolved in source order', () => {
  assert.deepEqual(lengthsOf('const A = 96\nconst B = A\nb: arrange([B, x])'), [96]);
  assert.deepEqual(lengthsOf('const A = 2\nconst B = A + A\nconst C = B * B\narrange([C, x])'), [16]);
  assert.deepEqual(lengthsOf('const A = 4, B = A * 2\narrange([B, x])'), [8]);
});

test('a computed length gets the reason of its value, quoting the length as written', () => {
  assert.deepEqual(problemOf('arrange([7 / 2, a])'), { call: 1, section: 1, reason: 'length-not-whole', source: '7 / 2' });
  assert.deepEqual(problemOf('arrange([1 / 0, a])'), { call: 1, section: 1, reason: 'length-not-whole', source: '1 / 0' });
  assert.deepEqual(problemOf('arrange([0 / 0, a])').reason, 'length-not-whole');
  assert.deepEqual(problemOf('arrange([2 - 2, a])'), { call: 1, section: 1, reason: 'length-not-above-zero', source: '2 - 2' });
  assert.deepEqual(problemOf('arrange([4 - 8, a])'), { call: 1, section: 1, reason: 'length-not-above-zero', source: '4 - 8' });
  assert.deepEqual(problemOf('const A = 7 / 2\narrange([A, x])'), { call: 1, section: 1, reason: 'length-not-whole', source: 'A' });
});

test('length-const-not-number: a top-level const that cannot be computed', () => {
  for (const init of ["'4'", 'f()', '[4]', '{ n: 4 }', 'true', '`4`']) {
    assert.deepEqual(problemOf(`const A = ${init}\narrange([A, x])`), { call: 1, section: 1, reason: 'length-const-not-number', source: 'A' }, init);
  }
  assert.deepEqual(problemOf('const A = 4\nconst B = A + zzz\narrange([B, x])').reason, 'length-const-not-number');
  assert.deepEqual(problemOf('const { A } = obj\narrange([A, x])').reason, 'length-const-not-number');
});

test('length-const-chain: a const that depends on a const defined later, or on itself, is not blamed as the later one', () => {
  assert.deepEqual(problemOf('const B = A\nconst A = 4\narrange([B, x])'), { call: 1, section: 1, reason: 'length-const-chain', source: 'B' });
  assert.deepEqual(problemOf('const A = A + 1\narrange([A, x])'), { call: 1, section: 1, reason: 'length-const-chain', source: 'A' });
  assert.deepEqual(problemOf('const A = B\nconst B = A\narrange([A, x])').reason, 'length-const-chain');
  assert.deepEqual(problemOf('const B = A\nconst A = 4\nconst C = B + 1\narrange([C, x])'), { call: 1, section: 1, reason: 'length-const-chain', source: 'C' });
  assert.deepEqual(problemOf('const B = A + 1\nconst A = 3\narrange([2, a], [B, x])'), { call: 1, section: 2, reason: 'length-const-chain', source: 'B' });
});

test('length-const-order: the const the length names is itself defined later', () => {
  assert.deepEqual(problemOf('arrange([A, x])\nconst A = 4'), { call: 1, section: 1, reason: 'length-const-order', source: 'A' });
  assert.deepEqual(problemOf('arrange([A + 1, x])\nconst A = 4'), { call: 1, section: 1, reason: 'length-const-order', source: 'A' });
});

test('length-calls: a call, new, member, optional chain or tagged template anywhere in the length', () => {
  for (const length of ['f(1)', 'obj.n', 'Math.PI', 'A + Math.floor(1)', 'new Number(4)', 'obj?.n', 'tag`4`', 'obj[0]', '2 * f(1)']) {
    assert.deepEqual(problemOf(`const A = 4\narrange([${length}, x])`), { call: 1, section: 1, reason: 'length-calls', source: length }, length);
  }
});

test('the first failing operand in source order decides', () => {
  assert.deepEqual(problemOf('const A = 4\narrange([A + x, a])'), { call: 1, section: 1, reason: 'length-name-unknown', source: 'x' });
  assert.deepEqual(problemOf('const A = 4\nlet M = 1\narrange([x + M, a])').source, 'x');
  assert.deepEqual(problemOf('const A = 4\nlet M = 1\narrange([M + x, a])').reason, 'length-name-mutable');
  assert.deepEqual(problemOf('arrange([x + f(1), a])').reason, 'length-name-unknown');
});

test('the generic reason stays for strings, booleans, null, objects, arrays, templates and other operators', () => {
  for (const length of ['"4"', 'true', 'null', '{}', '[4]', '`4`', '7 % 2', '2 ** 2', '4 > 2', '4 && 2', '!4', 'typeof 4', '4 ? 2 : 1', '/4/']) {
    assert.deepEqual(problemOf(`arrange([${length}, x])`), { call: 1, section: 1, reason: 'length-not-plain-number', source: length }, length);
  }
});

test('an expression nested more than 64 levels deep is not read, without a stack overflow', () => {
  const deep = Array.from({ length: 200 }, () => '1').join(' + ');
  const problem = problemOf(`arrange([${deep}, a])`);
  assert.equal(problem.reason, 'length-not-plain-number');
  const shallow = Array.from({ length: 40 }, () => '1').join(' + ');
  assert.deepEqual(lengthsOf(`arrange([${shallow}, a])`), [40]);
  const parens = `${'('.repeat(100)}4${')'.repeat(100)}`;
  assert.deepEqual(lengthsOf(`arrange([${parens}, a])`), [4]);
  const unary = `${'-'.repeat(100)}4`;
  assert.equal(problemOf(`arrange([${unary.replace(/-/g, '- ')}, a])`).reason, 'length-not-plain-number');
});

test('a huge or non-finite result is length-not-whole, not a crash', () => {
  assert.equal(problemOf('arrange([1e999, a])').reason, 'length-not-whole');
  assert.equal(problemOf('arrange([1e999 - 1e999, a])').reason, 'length-not-whole');
  assert.equal(problemOf('arrange([2 / 3, a])').reason, 'length-not-whole');
});

function namesOf(code) {
  const result = read(code);
  assert.deepEqual(result.problems, [], code);
  assert.equal(result.arrangements.length, 1, code);
  return result.arrangements[0].sections.map((section) => `${section.name}:${section.length}`);
}

test('a spread of a top-level const list gives its sections, in order', () => {
  const code = 'const sections = [[4, a], [8, b]]\nlead: arrange(...sections)';
  const [arrangement] = read(code).arrangements;
  assert.deepEqual(arrangement.sections, [
    { name: 'a', length: 4, start: 0 },
    { name: 'b', length: 8, start: 4 },
  ]);
  assert.equal(arrangement.total, 12);
  assert.deepEqual(read(code).problems, []);
  assert.deepEqual(namesOf('const sections = [[4, a], [8, b]]\narrange([2, x], ...sections, [1, y])'), ['x:2', 'a:4', 'b:8', 'y:1']);
  assert.deepEqual(namesOf('const BAR = 4\nconst sections = [[BAR, a], [BAR * 2, b]]\narrange(...sections)'), ['a:4', 'b:8']);
  assert.deepEqual(namesOf('const s = [[2, a]]\nconst t = [[3, b]]\narrange(...s, ...t)'), ['a:2', 'b:3']);
});

test('a pair held in a top-level const is one section, named by its pattern', () => {
  assert.deepEqual(namesOf('const verse = [8, v]\narrange([4, a], verse)'), ['a:4', 'v:8']);
  assert.deepEqual(namesOf('const verse = [8, v]\nconst sections = [[4, a], verse]\narrange(...sections)'), ['a:4', 'v:8']);
  assert.deepEqual(namesOf('const verse = [4 * 2, s("bd")]\narrange([4, a], verse)'), ['a:4', 'Part 2:8']);
  assert.deepEqual(namesOf('const sections = [[4, s("bd")], [2, b]]\narrange([1, x], ...sections)'), ['x:1', 'Part 2:4', 'b:2']);
});

test('section numbers in problems count the expanded order', () => {
  assert.deepEqual(read('const s = [[4, a], [8, b]]\narrange(...s, [x, c])').problems, [
    { call: 1, section: 3, reason: 'length-name-unknown', source: 'x' },
  ]);
  assert.deepEqual(read('const s = [[4, a], [8, b]]\narrange(...s, 5)').problems, [
    { call: 1, section: 3, reason: 'not-a-pair', source: '5' },
  ]);
  assert.deepEqual(read('const s = [[4, a], [8, b]]\narrange([1, z], ...s, ...q)').problems, [
    { call: 1, section: 4, reason: 'spread-not-const-list', source: '...q' },
  ]);
});

test('spread-not-const-list: a spread that is not a top-level const holding pairs', () => {
  const cases = [
    ['arrange(...list)', '...list'],
    ['let list = [[4, a]]\narrange(...list)', '...list'],
    ['const list = [[4, a]]\nconst g = (list) => list\narrange(...list)', '...list'],
    ['const list = foo()\narrange(...list)', '...list'],
    ['const list = [[4, a], 5]\narrange(...list)', '...list'],
    ['const list = [[4, a], ,]\narrange(...list)', '...list'],
    ['const other = [[1, z]]\nconst list = [...other, [4, a]]\narrange(...list)', '...list'],
    ['const obj = { list: [[4, a]] }\narrange(...obj.list)', '...obj.list'],
    ['const list = [[4, a], missing]\narrange(...list)', '...list'],
    ['const list = [[4, a], bad]\nconst bad = [8]\narrange(...list)', '...list'],
  ];
  for (const [code, source] of cases) {
    assert.deepEqual(read(code).problems, [{ call: 1, section: 1, reason: 'spread-not-const-list', source }], code);
    assert.deepEqual(read(code).arrangements, [], code);
  }
  assert.deepEqual(read('arrange([2, x], ...list)').problems, [{ call: 1, section: 2, reason: 'spread-not-const-list', source: '...list' }]);
});

test('pair-name-not-pair: a name that is not a top-level const holding a pair', () => {
  const cases = [
    'arrange(verse)',
    'let verse = [8, v]\narrange(verse)',
    'const verse = 8\narrange(verse)',
    'const verse = [8]\narrange(verse)',
    'const verse = [8, v, 1]\narrange(verse)',
    'const verse = [8, , ]\narrange(verse)',
    'const verse = [8, v]\nconst g = (verse) => verse\narrange(verse)',
  ];
  for (const code of cases) {
    assert.deepEqual(read(code).problems, [{ call: 1, section: 1, reason: 'pair-name-not-pair', source: 'verse' }], code);
  }
  assert.deepEqual(read('arrange([4, a], verse)').problems, [{ call: 1, section: 2, reason: 'pair-name-not-pair', source: 'verse' }]);
});

test('list-name-changed: a const list or pair the code changes is not read as written', () => {
  const changes = [
    'list.push([8, b])',
    'list[0] = [9, z]',
    'list.length = 0',
    'list[0][0]++',
    'delete list[0]',
    'list.splice(0, 1)',
    'list.sort()',
    'list[1][0] += 2',
  ];
  for (const change of changes) {
    const code = `const list = [[4, a], [2, c]]\n${change}\narrange(...list)`;
    assert.deepEqual(read(code).problems, [{ call: 1, section: 1, reason: 'list-name-changed', source: '...list' }], code);
    assert.deepEqual(read(code).arrangements, [], code);
  }
  const pairCode = 'const verse = [4, v]\nverse.push(1)\narrange([2, a], verse)';
  assert.deepEqual(read(pairCode).problems, [{ call: 1, section: 2, reason: 'list-name-changed', source: 'verse' }]);
  const inList = 'const verse = [4, v]\nverse[0] = 8\nconst list = [[2, a], verse]\narrange(...list)';
  assert.deepEqual(read(inList).problems, [{ call: 1, section: 1, reason: 'list-name-changed', source: 'verse' }]);
  // Reading a list or calling something that does not change it stays readable.
  assert.deepEqual(namesOf('const list = [[4, a]]\nconst n = list.length\nconst m = list.map((p) => p)\narrange(...list)'), ['a:4']);
});

test('list-name-order: a const list or pair used before it is declared', () => {
  const afterCall = 'arrange(...list)\nconst list = [[4, a]]';
  assert.deepEqual(read(afterCall).problems, [{ call: 1, section: 1, reason: 'list-name-order', source: '...list' }]);
  const pairAfter = 'arrange([2, a], verse)\nconst verse = [4, v]';
  assert.deepEqual(read(pairAfter).problems, [{ call: 1, section: 2, reason: 'list-name-order', source: 'verse' }]);
  const pairInListAfter = 'const list = [[2, a], verse]\nconst verse = [4, v]\narrange(...list)';
  assert.deepEqual(read(pairInListAfter).problems, [{ call: 1, section: 1, reason: 'list-name-order', source: 'verse' }]);
});

test('a length const read before it is declared, inside a pair or in the call, is length-const-order', () => {
  assert.deepEqual(read('arrange([n, a])\nconst n = 4').problems, [{ call: 1, section: 1, reason: 'length-const-order', source: 'n' }]);
  assert.deepEqual(read('const verse = [n, a]\nconst n = 4\narrange([2, b], verse)').problems, [
    { call: 1, section: 2, reason: 'length-const-order', source: 'n' },
  ]);
  assert.deepEqual(read('const list = [[n, a]]\nconst n = 4\narrange(...list)').problems, [
    { call: 1, section: 1, reason: 'length-const-order', source: 'n' },
  ]);
  assert.deepEqual(namesOf('const n = 4\nconst verse = [n, a]\narrange([2, b], verse)'), ['b:2', 'a:4']);
});

test('a call, a member or a wrongly sized array as an argument keeps not-a-pair', () => {
  assert.deepEqual(read('arrange(makePair())').problems, [{ call: 1, section: 1, reason: 'not-a-pair', source: 'makePair()' }]);
  assert.deepEqual(read('arrange(obj.pair)').problems, [{ call: 1, section: 1, reason: 'not-a-pair', source: 'obj.pair' }]);
  assert.deepEqual(read('arrange([4])').problems, [{ call: 1, section: 1, reason: 'not-a-pair', source: '[4]' }]);
  assert.deepEqual(read('const list = [[4], [8, b]]\narrange(...list)').problems, [{ call: 1, section: 1, reason: 'not-a-pair', source: '[4]' }]);
});

test('a bad length inside a list gives the length reason at its expanded section number', () => {
  assert.deepEqual(read('const list = [[4, a], [x, b]]\narrange(...list)').problems, [
    { call: 1, section: 2, reason: 'length-name-unknown', source: 'x' },
  ]);
  assert.deepEqual(read('const list = [[4, a], [1.5, b]]\narrange([2, z], ...list)').problems, [
    { call: 1, section: 3, reason: 'length-not-whole', source: '1.5' },
  ]);
});

test('an empty list gives no-sections with no section and no source', () => {
  assert.deepEqual(read('const sections = []\narrange(...sections)').problems, [
    { call: 1, section: null, reason: 'no-sections', source: null },
  ]);
});

test('a list is not expanded again: a name inside a list that holds a list is not read', () => {
  assert.deepEqual(read('const inner = [[4, a]]\nconst list = [inner]\narrange(...list)').problems.map((p) => p.reason), ['spread-not-const-list']);
});

test('the offset after a spread arrangement, a nested call in a skipped call and the spans behave as for literals', () => {
  const [spread] = read('const s = [[2, one], [2, two], [2, three]]\nmain: arrange(...s).late(3)').arrangements;
  assert.equal(spread.offset, 3);
  const [early] = read('const s = [[2, one], [2, two]]\nmain: arrange(...s).early(1)').arrangements;
  assert.equal(early.offset, -1);
  const nested = read('const s = [[4, a]]\narrange([1, arrange(...s)], ...nothing)');
  assert.equal(nested.arrangements.length, 1);
  assert.equal(nested.arrangements[0].total, 4);
  assert.equal(nested.problems.length, 1);
  assert.equal(nested.callCount, 2);

  const [literal] = arrangements(THREE_EQUAL_SECTIONS);
  const [viaList] = arrangements('const s = [[2, one], [2, two]]\nconst three = [2, three]\nmain: arrange(...s, three)');
  assert.deepEqual(sectionSpans(viaList, 0), sectionSpans(literal, 0));
  assert.deepEqual(sectionSpans(viaList, 5, 10), sectionSpans(literal, 5, 10));
});

test('PARTS_COPY.reasons holds exactly the 17 ids, with no clause for a time-changed call', () => {
  assert.deepEqual(Object.keys(PARTS_COPY.reasons).sort(), [
    'length-calls',
    'length-const-chain',
    'length-const-not-number',
    'length-const-order',
    'length-name-mutable',
    'length-name-rebound',
    'length-name-unknown',
    'length-not-above-zero',
    'length-not-plain-number',
    'length-not-whole',
    'list-name-changed',
    'list-name-order',
    'no-pattern',
    'no-sections',
    'not-a-pair',
    'pair-name-not-pair',
    'spread-not-const-list',
  ]);
  assert.equal(PARTS_COPY.reasons['time-changed'], undefined);
});

test('every new reason fills its clause with the section and the quoted source', () => {
  const sentence = (reason, call = 1, count = 1) =>
    arrangeProblemText({ call, section: 3, reason, source: 'S' }, count);
  const expected = {
    'length-name-unknown': 'the length of section 3 is S, which is not a top-level const',
    'length-name-mutable': 'the length of section 3 is S, declared with let or var, so it can change',
    'length-name-rebound': 'the length of section 3 is S, which is bound more than once in the code',
    'length-const-not-number': 'the length of section 3 is S, a top-level const that is not a number the page can compute',
    'length-const-order': 'the length of section 3 is S, a top-level const defined later in the code or referring to itself',
    'length-const-chain': 'the length of section 3 is S, a top-level const that depends on a const defined later in the code or on itself',
    'length-calls': 'the length of section 3 calls a function or reads a property (S)',
    'spread-not-const-list': 'section 3 spreads S, which is not a top-level const holding [length, pattern] pairs',
    'pair-name-not-pair': 'section 3 is S, which is not a [length, pattern] pair or a top-level const holding one',
    'list-name-changed': 'section 3 uses S, a top-level const that the code changes, so what plays can differ from what is written',
    'list-name-order': 'section 3 uses S, a top-level const defined later in the code or referring to itself',
  };
  for (const [reason, clause] of Object.entries(expected)) {
    assert.equal(sentence(reason), `Parts can't read this arrange(): ${clause}.`, reason);
    assert.equal(sentence(reason, 2, 3), `Parts can't read arrange() 2 of 3: ${clause}.`, reason);
    assert.equal(
      partsSkippedText([{ call: 2, section: 3, reason, source: 'S' }], 3),
      `Skipped arrange() 2 of 3: ${clause}.`,
      reason,
    );
  }
  assert.throws(() => arrangeProblemText({ call: 1, section: 1, reason: 'time-changed', source: 'x' }, 1), /^Error: Moontide:/);
});

test('the shape rule is the sentence of the design and keeps the two pinned phrases', () => {
  assert.equal(
    PARTS_COPY.shapeRule,
    'Lengths must be plain numbers: whole numbers above zero, written in the call, or computed from number literals and top-level consts with + - * /.',
  );
  assert.match(PARTS_COPY.shapeRule, /Lengths must be plain numbers/);
  assert.match(PARTS_COPY.shapeRule, /top-level const/);
});

test('no Parts clause or sentence recommends a shape', () => {
  const all = [...Object.values(PARTS_COPY.reasons), PARTS_COPY.shapeRule, PARTS_COPY.cannotReadOne, PARTS_COPY.cannotReadOf, PARTS_COPY.skippedOf];
  for (const text of all) assert.doesNotMatch(text, /\b(use|write|try|should|prefer|instead)\b/i, text);
});

test('a const holding a fraction, zero or a negative gets the reason of the value, quoting the name', () => {
  assert.deepEqual(read('const A = 2.5\nb: arrange([A, x])').problems, [
    { call: 1, section: 1, reason: 'length-not-whole', source: 'A' },
  ]);
  assert.deepEqual(read('const A = 0\nb: arrange([A, x])').problems, [
    { call: 1, section: 1, reason: 'length-not-above-zero', source: 'A' },
  ]);
});

test('with several arrange() calls the readable ones are kept and each skipped call is named', () => {
  const result = read('a: arrange([4, x])\nb: arrange([2.5, y])');
  assert.equal(result.arrangements.length, 1);
  assert.deepEqual(result.problems, [{ call: 2, section: 1, reason: 'length-not-whole', source: '2.5' }]);
  assert.equal(result.callCount, 2);
  assert.equal(
    partsSkippedText(result.problems, result.callCount),
    'Skipped arrange() 2 of 2: the length of section 1 is not a whole number (2.5).',
  );
  const two = [
    { call: 1, section: 1, reason: 'length-not-whole', source: '2.5' },
    { call: 3, section: null, reason: 'no-sections', source: null },
  ];
  assert.equal(
    partsSkippedText(two, 3),
    'Skipped arrange() 1 of 3: the length of section 1 is not a whole number (2.5). Skipped arrange() 3 of 3: it has no [length, pattern] sections.',
  );
});

test('the shape rule names the top-level const form', () => {
  assert.match(PARTS_COPY.shapeRule, /top-level const/);
});

test("Claude's reference states the arrange() shape the Parts view reads, and the code agrees", () => {
  const reference = readFileSync(fileURLToPath(new URL('../reference/functions.md', import.meta.url)), 'utf8');
  const lines = reference.split('\n').filter((line) => line.includes('Parts view'));
  assert.equal(lines.length, 1);
  const [line] = lines;
  assert.ok(line.includes('[length, pattern]'));
  assert.ok(line.includes('whole number above zero'));
  assert.ok(line.includes('top-level `const`'));

  const readable = read('const A = 4\nmain: arrange([A, s("bd")], [8, s("hh")])');
  assert.equal(readable.arrangements.length, 1);
  assert.deepEqual(
    readable.arrangements[0].sections.map((section) => section.length),
    [4, 8],
  );
  assert.equal(read('let A = 4\nmain: arrange([A, s("bd")], [8, s("hh")])').problems.length, 1);
  assert.equal(read('main: arrange(...list)').problems.length, 1);

  // The line also states constant arithmetic, the pair held in a const and the spread, and the code agrees.
  assert.ok(line.includes('arithmetic with `+ - * /`'));
  assert.ok(line.includes('a spread of a top-level `const`'));
  assert.ok(line.includes('the Parts view says why'));
  assert.doesNotMatch(line, /\b(use|prefer|should|recommend|instead)\b/i);
  const shapes = read(
    ['const BAR = 2', 'const sections = [[BAR, a], [BAR * 2, b]]', 'const verse = [8, v]', 'main: arrange(...sections, verse)'].join('\n'),
  );
  assert.deepEqual(shapes.problems, []);
  assert.deepEqual(
    shapes.arrangements[0].sections.map((section) => `${section.name}:${section.length}`),
    ['a:2', 'b:4', 'v:8'],
  );
  assert.equal(read('main: arrange(...unknown)').problems.length, 1);
  assert.equal(read('main: arrange(...unknown)').problems[0].reason, 'spread-not-const-list');
});

test('PARTS_COPY.waiting says a launch waits for the takeover of a waiting change', () => {
  assert.equal(PARTS_COPY.waiting, 'A change is waiting for its bar line. Parts can be launched again when it takes over.');
});
