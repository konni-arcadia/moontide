// Unit tests for page/jam-resolve.js: which of several scales that fit the notes the Jam view uses, and the resolved
// reading every path that needs a clear scale reads. No DOM, no build step.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MODES, buildReading, detectScale, readingAt, pitchedEvents, segments, markSolid, HARMONIC_MIN } from '../page/jam-analysis.js';
import * as resolve from '../page/jam-resolve.js';

// Namespace import: an export the module does not have yet fails inside its own test, not at load.
const { candidateSetKey, sameNotes, evidenceReason, resolveScale, resolveReading, createScaleMemory, MAX_REMEMBERED_SETS } = resolve;

const ev = (track, begin, end, note) => ({ begin, end, value: { note }, track });
const run = (track, begin, step, names) => names.map((name, i) => ev(track, begin + i * step, begin + (i + 1) * step, name));
const stack = (track, begin, end, names) => names.map((name) => ev(track, begin, end, name));
const loop = (cycles, fn) => Array.from({ length: cycles }, (_, cycle) => fn(cycle)).flat();

const modeOf = (id) => MODES.find((mode) => mode.id === id);
const candidate = (root, modeId, extra = {}) => ({ key: `${root}:${modeId}`, root, mode: modeOf(modeId), ...extra });

const NONE = { state: 'none' };
const declaredScale = (rootPc, modeId, text = 'whatever') => ({ state: 'declared', kind: 'scale', text, scale: { rootPc, modeId } });

// The four pads: A minor, F, C and G triads, one per cycle. Four scales share their notes.
const PAD_CHORDS = [['a3', 'c4', 'e4'], ['f3', 'a3', 'c4'], ['c4', 'e4', 'g4'], ['g3', 'b3', 'd4']];
const PADS = loop(8, (c) => stack(0, c, c + 1, PAD_CHORDS[c % 4]));
const padsReading = () => buildReading({ events: PADS, windowStart: 0, windowLength: 8 });

// An A drone under a line that fits A minor and A Dorian: two scales with different notes, nothing to tell them apart.
const DRONE_LINE = [...loop(8, (c) => ev(1, c, c + 1, 'a2')), ...loop(8, (c) => run(0, c, 1 / 6, ['a3', 'b3', 'c4', 'd4', 'e4', 'g4']))];
const droneReading = () => buildReading({ events: DRONE_LINE, windowStart: 0, windowLength: 8 });

// A line whose F and F# alternate: C major and G major cover the same weight with different notes, and each has outside notes.
const fsharpLine = (cycles) =>
  loop(cycles, (i) => [...run(0, i * 2, 0.25, ['c4', 'd4', 'e4', 'g4', 'a4', 'b4']), ev(0, i * 2 + 1.5, i * 2 + 1.75, i % 2 === 0 ? 'f4' : 'f#4')]);
const fsharpReading = () => buildReading({ events: fsharpLine(8), windowStart: 0, windowLength: 16 });

// --- the set of candidates ---

test('candidateSetKey is the sorted keys joined by commas, the same for the same candidates in another order', () => {
  const a = candidate(0, 'ionian');
  const b = candidate(9, 'aeolian');
  const c = candidate(7, 'mixolydian');
  assert.equal(candidateSetKey([a, b, c]), '0:ionian,7:mixolydian,9:aeolian');
  assert.equal(candidateSetKey([c, a, b]), candidateSetKey([b, c, a]));
  assert.notEqual(candidateSetKey([a, b]), candidateSetKey([a, b, c]));
});

test('candidateSetKey refuses a candidate without a key', () => {
  assert.throws(() => candidateSetKey([{ root: 0, mode: modeOf('ionian') }]), /Moontide:/);
});

test('sameNotes is true for C major, A minor and G Mixolydian, false for A minor and A Dorian', () => {
  assert.equal(sameNotes([candidate(0, 'ionian'), candidate(9, 'aeolian'), candidate(7, 'mixolydian')]), true);
  assert.equal(sameNotes([candidate(9, 'aeolian'), candidate(9, 'dorian')]), false);
  assert.equal(sameNotes([candidate(0, 'ionian')]), true);
});

// --- the reason the proposal gives ---

test('evidenceReason: the bass and chord evidence that exceeds every other candidate decides first', () => {
  const chosen = { key: 'a', lean: 0.5, heard: 0.1 };
  const others = [{ key: 'b', lean: 0.3, heard: 0.9 }, { key: 'c', lean: 0.2, heard: 0.9 }];
  assert.equal(evidenceReason(chosen, [chosen, ...others]), 'bass-chords');
});

test('evidenceReason: with the same lean the note weight decides, and equal evidence says nothing decided', () => {
  const chosen = { key: 'a', lean: 0.4, heard: 0.5 };
  assert.equal(evidenceReason(chosen, [chosen, { key: 'b', lean: 0.4, heard: 0.2 }]), 'most-heard');
  assert.equal(evidenceReason(chosen, [chosen, { key: 'b', lean: 0.4, heard: 0.5 }]), 'nothing');
  // A difference under the tolerance is no difference.
  assert.equal(evidenceReason(chosen, [chosen, { key: 'b', lean: 0.4 - 1e-12, heard: 0.5 - 1e-12 }]), 'nothing');
  // One other candidate leaning as much as the chosen one is enough to say the bass did not decide.
  assert.equal(evidenceReason(chosen, [chosen, { key: 'b', lean: 0.1, heard: 0.1 }, { key: 'c', lean: 0.4, heard: 0.1 }]), 'most-heard');
});

test('evidenceReason: the four pads say C major is the note heard most', () => {
  const scale = detectScale(pitchedEvents(PADS), segments(markSolid(pitchedEvents(PADS).map((e) => ({ ...e })), HARMONIC_MIN)));
  assert.equal(scale.status, 'ambiguous');
  assert.equal(evidenceReason(scale.candidates[0], scale.candidates), 'most-heard');
});

// --- one scale ---

test('resolveScale: a clear, no-fit or none scale is the heard one', () => {
  const reading = buildReading({ events: loop(4, (c) => [ev(1, c, c + 1, 'd2'), ...run(0, c, 0.125, ['d3', 'e3', 'f3', 'g3', 'a3', 'b3', 'c4', 'd4'])]), windowStart: 0, windowLength: 8 });
  assert.equal(reading.whole.status, 'clear');
  for (const scale of [reading.whole, { status: 'no-fit' }, { status: 'none' }]) {
    assert.equal(resolveScale(scale, { declared: NONE }).source, 'heard');
  }
});

test('resolveScale: the four pads with nothing declared propose C major, the note heard most', () => {
  const scale = padsReading().whole;
  assert.equal(scale.status, 'ambiguous');
  const resolution = resolveScale(scale, { declared: NONE });
  assert.equal(resolution.source, 'proposed');
  assert.equal(resolution.key, '0:ionian');
  assert.equal(resolution.reason, 'most-heard');
  assert.equal(resolution.sameNotes, true);
  assert.equal(resolution.setKey, candidateSetKey(scale.candidates));
});

test('resolveScale: a declared scale among the candidates is proposed, matched on root and mode and never on the text', () => {
  const scale = padsReading().whole;
  const resolution = resolveScale(scale, { declared: declaredScale(9, 'aeolian', 'this text names no scale') });
  assert.equal(resolution.source, 'proposed');
  assert.equal(resolution.key, '9:aeolian');
  assert.equal(resolution.reason, 'declared');
  // The same text on another root and mode gives another scale: the text does not count.
  assert.equal(resolveScale(scale, { declared: declaredScale(7, 'mixolydian', 'A:minor') }).key, '7:mixolydian');
});

test('resolveScale: a declared scale that is not among same-notes candidates gives way to the evidence', () => {
  const scale = padsReading().whole;
  const resolution = resolveScale(scale, { declared: declaredScale(2, 'dorian') });
  assert.equal(resolution.source, 'proposed');
  assert.equal(resolution.key, '0:ionian');
  assert.equal(resolution.reason, 'most-heard');
});

test('resolveScale: different notes with nothing usable declared cannot choose and say why', () => {
  const scale = droneReading().whole;
  assert.equal(scale.status, 'ambiguous');
  assert.equal(sameNotes(scale.candidates), false);
  const chords = { state: 'declared', kind: 'chords', text: '<Am G>', scale: null };
  const unreadable = { state: 'unreadable', reason: 'computed', source: 'pick()' };
  for (const declared of [NONE, chords, unreadable]) {
    const resolution = resolveScale(scale, { declared });
    assert.equal(resolution.source, 'unresolved');
    assert.equal(resolution.why, 'nothing-declared');
    assert.equal(resolution.sameNotes, false);
  }
  const elsewhere = resolveScale(scale, { declared: declaredScale(0, 'lydian') });
  assert.equal(elsewhere.source, 'unresolved');
  assert.equal(elsewhere.why, 'declared-not-among');
});

test('resolveScale: different notes with the declared scale among them propose it', () => {
  const resolution = resolveScale(droneReading().whole, { declared: declaredScale(9, 'dorian') });
  assert.equal(resolution.source, 'proposed');
  assert.equal(resolution.key, '9:dorian');
  assert.equal(resolution.reason, 'declared');
  assert.equal(resolution.sameNotes, false);
});

test('resolveScale throws a Moontide error for what it cannot resolve', () => {
  const scale = padsReading().whole;
  assert.throws(() => resolveScale({ status: 'maybe' }, { declared: NONE }), /Moontide:.*maybe/);
  assert.throws(() => resolveScale(scale, {}), /Moontide:/);
  assert.throws(() => resolveScale(scale, undefined), /Moontide:/);
  assert.throws(() => resolveScale(scale, { declared: declaredScale(0, 'nope') }), /Moontide:.*nope/);
  assert.throws(() => resolveScale(scale, { declared: declaredScale(12, 'ionian') }), /Moontide:/);
});

// --- one reading ---

test('resolveReading: a proposed span is a clear scale with its source, reason, key, set and candidates, and its own warnings', () => {
  const reading = fsharpReading();
  assert.equal(reading.spans[0].scale.status, 'ambiguous');
  const resolved = resolveReading(reading, { declared: declaredScale(0, 'ionian'), memory: createScaleMemory() });
  const scale = resolved.spans[0].scale;
  assert.equal(scale.status, 'clear');
  assert.equal(scale.name, 'C major');
  assert.equal(scale.source, 'proposed');
  assert.equal(scale.reason, 'declared');
  assert.equal(scale.key, '0:ionian');
  assert.equal(scale.sameNotes, false);
  assert.equal(scale.setKey, candidateSetKey(reading.spans[0].scale.candidates));
  assert.deepEqual(scale.candidates, reading.spans[0].scale.candidates.map((c) => ({ key: c.key, name: c.name })));
  const chosen = reading.spans[0].proposals.find((proposal) => proposal.key === '0:ionian');
  assert.ok(chosen.warnings.length > 0, 'C major has the F# to warn about');
  assert.equal(resolved.spans[0].warnings.length, chosen.warnings.length);
  resolved.spans[0].warnings.forEach((warning, i) => {
    assert.equal(warning.index, i);
    assert.equal(warning.scaleName, 'C major');
    assert.equal(warning.spanIndex, 0);
    assert.deepEqual(warning.outside, chosen.warnings[i].outside);
  });
  assert.deepEqual(resolved.warnings, resolved.spans[0].warnings);
  assert.equal(resolved.whole.name, 'C major');
  assert.equal(resolved.whole.source, 'proposed');
});

test('resolveReading: the warnings follow the scale in use', () => {
  const reading = fsharpReading();
  const inC = resolveReading(reading, { declared: declaredScale(0, 'ionian'), memory: createScaleMemory() });
  const inG = resolveReading(reading, { declared: declaredScale(7, 'ionian'), memory: createScaleMemory() });
  assert.equal(inC.spans[0].scale.name, 'C major');
  assert.equal(inG.spans[0].scale.name, 'G major');
  assert.ok(inC.warnings.length > 0 && inG.warnings.length > 0);
  assert.ok(inC.warnings.every((w) => w.outside.includes('F#')));
  assert.ok(inG.warnings.every((w) => w.outside.includes('F')));
});

test('resolveReading never changes the reading it is given', () => {
  const reading = fsharpReading();
  const before = structuredClone(reading);
  resolveReading(reading, { declared: declaredScale(0, 'ionian'), memory: createScaleMemory() });
  resolveReading(reading, { declared: NONE, memory: createScaleMemory() });
  assert.deepEqual(reading, before);
});

test('resolveReading: an unresolved span keeps its ambiguous scale, says why and has no warning', () => {
  const reading = droneReading();
  const resolved = resolveReading(reading, { declared: NONE, memory: createScaleMemory() });
  const scale = resolved.spans[0].scale;
  assert.equal(scale.status, 'ambiguous');
  assert.equal(scale.source, 'unresolved');
  assert.equal(scale.why, 'nothing-declared');
  assert.equal(scale.sameNotes, false);
  assert.deepEqual(scale.candidates.map((c) => c.key).sort(), ['9:aeolian', '9:dorian']);
  assert.deepEqual(resolved.spans[0].warnings, []);
  assert.deepEqual(resolved.warnings, []);
  assert.equal(resolved.whole.source, 'unresolved');
});

test('resolveReading: a heard span and a heard whole are returned as they are', () => {
  const reading = buildReading({ events: loop(4, (c) => [ev(1, c, c + 1, 'd2'), ...run(0, c, 0.125, ['d3', 'e3', 'f3', 'g3', 'a3', 'b3', 'c4', 'd4'])]), windowStart: 0, windowLength: 8 });
  const resolved = resolveReading(reading, { declared: declaredScale(0, 'ionian'), memory: createScaleMemory() });
  assert.equal(resolved.spans[0], reading.spans[0]);
  assert.equal(resolved.whole, reading.whole);
  assert.equal(resolved.status, 'ready');
});

test('resolveReading: a reading with no pitched note resolves to itself', () => {
  const reading = buildReading({ events: [{ begin: 0, end: 1, value: { s: 'bd' }, track: 0 }], windowStart: 0, windowLength: 8 });
  const resolved = resolveReading(reading, { declared: NONE, memory: createScaleMemory() });
  assert.equal(resolved.status, 'none');
  assert.equal(resolved.whole.status, 'none');
  assert.deepEqual(resolved.warnings, []);
});

test('resolveReading rebuilds the warnings of a piece with parts in begin order with fresh indexes', () => {
  const partA = (c) => stack(0, c, c + 1, PAD_CHORDS[c % 4]);
  const partB = (c) => [
    ev(1, c, c + 1, 'd2'),
    ...stack(2, c, c + 1, c % 8 >= 6 ? ['a2', 'c#3', 'e3', 'g3'] : ['d3', 'f3', 'a3', 'c4']),
    ...run(0, c, 0.125, ['d3', 'e3', 'f3', 'g3', 'a3', 'b3', 'c4', 'd4']),
  ];
  const events = loop(16, (c) => (c % 8 < 4 ? partA(c) : partB(c)));
  const arrangement = { index: 0, owner: 0, total: 8, offset: 0, sections: [{ name: 'a', length: 4, start: 0 }, { name: 'b', length: 4, start: 4 }] };
  const reading = buildReading({ events, windowStart: 0, windowLength: 16, arrangements: [arrangement] });
  assert.deepEqual(reading.spans.map((span) => span.scale.status), ['ambiguous', 'clear', 'ambiguous', 'clear']);
  const resolved = resolveReading(reading, { declared: NONE, memory: createScaleMemory() });
  assert.deepEqual(resolved.spans.map((span) => span.scale.name), ['C major', 'D Dorian', 'C major', 'D Dorian']);
  assert.ok(resolved.warnings.length > 0);
  resolved.warnings.forEach((warning, i) => {
    assert.equal(warning.index, i);
    if (i > 0) assert.ok(warning.begin >= resolved.warnings[i - 1].begin);
    assert.equal(warning.scaleName, resolved.spans[warning.spanIndex].scale.name);
  });
  // The part changes read the resolved scales: the first part is C major, the second D Dorian.
  const position = readingAt(resolved, { cycle: 0.5, cps: 1, playing: true });
  const part = position.upcoming.find((entry) => entry.kind === 'part');
  assert.equal(part.change, 'changes');
  assert.equal(part.scaleName, 'D Dorian');
});

test('readingAt on a resolved reading gives the warning, the next warning and the warning rows of a proposed span', () => {
  const resolved = resolveReading(fsharpReading(), { declared: declaredScale(0, 'ionian'), memory: createScaleMemory() });
  const during = readingAt(resolved, { cycle: 3.6, cps: 1, playing: true });
  assert.equal(during.scale.status, 'clear');
  assert.notEqual(during.warning, null);
  assert.deepEqual(during.warning.outside, ['F#']);
  const before = readingAt(resolved, { cycle: 0.2, cps: 1, playing: true });
  assert.equal(before.warning, null);
  assert.notEqual(before.nextWarning, null);
  assert.ok(before.upcoming.some((entry) => entry.kind === 'warning'));
});

test('resolveReading throws a Moontide error for a reading it cannot resolve', () => {
  assert.throws(() => resolveReading({ status: 'too-dense', count: 5 }, { declared: NONE, memory: createScaleMemory() }), /Moontide:.*too-dense/);
  assert.throws(() => resolveReading(padsReading(), {}), /Moontide:/);
});

// --- the pick, the kept proposal and the order they apply in ---

test('the scale in use follows the pick, then the declared scale, then the kept proposal, then the evidence', () => {
  const scale = padsReading().whole;
  assert.ok(scale.candidates.some((c) => c.key === '9:aeolian') && scale.candidates.some((c) => c.key === '7:mixolydian'));
  const declared = declaredScale(0, 'ionian');
  // 1. the pick wins over everything
  const picked = resolveScale(scale, { declared, pick: '9:aeolian', kept: '7:mixolydian' });
  assert.equal(picked.source, 'chosen');
  assert.equal(picked.key, '9:aeolian');
  assert.equal(picked.reason, null);
  assert.equal(picked.setKey, candidateSetKey(scale.candidates));
  // 2. no pick: the declared scale, over the kept proposal
  const byDeclaration = resolveScale(scale, { declared, kept: '7:mixolydian' });
  assert.deepEqual([byDeclaration.source, byDeclaration.key, byDeclaration.reason], ['proposed', '0:ionian', 'declared']);
  // 3. nothing declared: the kept proposal, with the reason the evidence gives for it
  const byKept = resolveScale(scale, { declared: NONE, kept: '7:mixolydian' });
  assert.deepEqual([byKept.source, byKept.key], ['proposed', '7:mixolydian']);
  assert.ok(['bass-chords', 'most-heard', 'nothing'].includes(byKept.reason));
  assert.equal(byKept.reason, evidenceReason(scale.candidates.find((c) => c.key === '7:mixolydian'), scale.candidates));
  // 4. nothing held and nothing declared: the strongest evidence
  const byEvidence = resolveScale(scale, { declared: NONE });
  assert.deepEqual([byEvidence.source, byEvidence.key, byEvidence.reason], ['proposed', '0:ionian', 'most-heard']);
  // a declared scale outside the candidates is skipped
  const skipped = resolveScale(scale, { declared: declaredScale(2, 'lydian'), kept: '7:mixolydian' });
  assert.deepEqual([skipped.source, skipped.key], ['proposed', '7:mixolydian']);
});

test('a section that declares another candidate moves the proposal even when a proposal was kept', () => {
  const scale = padsReading().whole;
  const first = resolveScale(scale, { declared: declaredScale(9, 'aeolian'), kept: '0:ionian' });
  const second = resolveScale(scale, { declared: declaredScale(0, 'ionian'), kept: '0:ionian' });
  assert.equal(first.key, '9:aeolian');
  assert.equal(second.key, '0:ionian');
});

test('the proposal does not flicker: the same candidates in another evidence order keep the proposal in view', () => {
  const reading = padsReading();
  const memory = createScaleMemory();
  const base = reading.whole.candidates;
  const orders = [base, [...base].reverse(), [base[1], base[2], base[0], ...base.slice(3)]];
  const keys = orders.map((candidates) => {
    const resolution = resolveScale({ ...reading.whole, candidates }, { declared: NONE, kept: memory.keptFor(candidateSetKey(candidates)) });
    memory.keep(resolution.setKey, resolution.key);
    return resolution.key;
  });
  assert.equal(new Set(keys).size, 1, `the proposal moved between readings: ${keys.join(', ')}`);
  // Another set of candidates gets the choice of its own evidence.
  const other = { ...reading.whole, candidates: base.slice(0, 2) };
  assert.equal(resolveScale(other, { declared: NONE, kept: memory.keptFor(candidateSetKey(other.candidates)) }).key, base[0].key);
});

test('resolveScale: with different notes a pick is used, a kept key never is, and nothing held stays unresolved', () => {
  const scale = droneReading().whole;
  const picked = resolveScale(scale, { declared: NONE, pick: '9:dorian' });
  assert.deepEqual([picked.source, picked.key, picked.sameNotes], ['chosen', '9:dorian', false]);
  const kept = resolveScale(scale, { declared: NONE, kept: '9:dorian' });
  assert.equal(kept.source, 'unresolved');
  assert.equal(resolveScale(scale, { declared: NONE }).source, 'unresolved');
  // a pick wins over a declared scale here too
  assert.equal(resolveScale(scale, { declared: declaredScale(9, 'aeolian'), pick: '9:dorian' }).key, '9:dorian');
});

test('resolveScale throws a Moontide error for a pick or a kept key that is not a candidate', () => {
  const scale = padsReading().whole;
  assert.throws(() => resolveScale(scale, { declared: NONE, pick: '1:ionian' }), /Moontide:.*1:ionian/);
  assert.throws(() => resolveScale(scale, { declared: NONE, kept: '1:ionian' }), /Moontide:.*1:ionian/);
  assert.throws(() => resolveScale(droneReading().whole, { declared: NONE, kept: '0:ionian' }), /Moontide:/);
});

test('resolveReading: a held pick sets the scale in use, its warnings and its source; the kept proposal steadies the rest', () => {
  const reading = fsharpReading();
  const setKey = candidateSetKey(reading.spans[0].scale.candidates);
  const memory = createScaleMemory();
  memory.pick(setKey, '7:ionian');
  const resolved = resolveReading(reading, { declared: declaredScale(0, 'ionian'), memory });
  assert.equal(resolved.spans[0].scale.name, 'G major');
  assert.equal(resolved.spans[0].scale.source, 'chosen');
  assert.equal(resolved.whole.source, 'chosen');
  assert.ok(resolved.warnings.length > 0 && resolved.warnings.every((w) => w.outside.includes('F')));
  // the kept proposal is used when nothing is declared
  const keptMemory = createScaleMemory();
  keptMemory.keep(setKey, '7:ionian');
  const kept = resolveReading(reading, { declared: NONE, memory: keptMemory });
  assert.equal(kept.spans[0].scale.source, 'unresolved', 'a kept proposal never settles scales with different notes');
});

test('resolveReading: the kept proposal holds the pads on one scale in any evidence order', () => {
  const reading = padsReading();
  const setKey = candidateSetKey(reading.spans[0].scale.candidates);
  const memory = createScaleMemory();
  memory.keep(setKey, '7:mixolydian');
  const resolved = resolveReading(reading, { declared: NONE, memory });
  assert.equal(resolved.spans[0].scale.name, 'G Mixolydian');
  assert.equal(resolved.spans[0].scale.source, 'proposed');
});

test('resolveReading needs a memory', () => {
  assert.throws(() => resolveReading(padsReading(), { declared: NONE }), /Moontide:.*memory/);
  assert.throws(() => resolveReading(padsReading(), { declared: NONE, memory: {} }), /Moontide:.*memory/);
});

// --- the page memory ---

test('createScaleMemory: a pick is remembered for its own set of candidates only', () => {
  assert.equal(MAX_REMEMBERED_SETS, 32);
  const memory = createScaleMemory();
  assert.equal(memory.pickFor('a,b'), null);
  memory.pick('a,b', 'a');
  assert.equal(memory.pickFor('a,b'), 'a');
  assert.equal(memory.pickFor('a,c'), null);
  memory.pick('a,b', 'b');
  assert.equal(memory.pickFor('a,b'), 'b');
  assert.equal(memory.size(), 1);
});

test('createScaleMemory: the 33rd set drops the oldest, and picking an old set again makes it the newest', () => {
  const memory = createScaleMemory();
  for (let i = 0; i < 32; i += 1) memory.pick(`set${i}`, 'k');
  assert.equal(memory.size(), 32);
  memory.pick('set32', 'k');
  assert.equal(memory.size(), 32);
  assert.equal(memory.pickFor('set0'), null);
  assert.equal(memory.pickFor('set1'), 'k');
  // set1 becomes the newest, so the next drop takes set2
  memory.pick('set1', 'k2');
  memory.pick('set33', 'k');
  assert.equal(memory.pickFor('set1'), 'k2');
  assert.equal(memory.pickFor('set2'), null);
  assert.equal(memory.size(), 32);
});

test('createScaleMemory: a kept proposal is held for each set, and the sets are capped like the picks', () => {
  const memory = createScaleMemory();
  assert.equal(memory.keptFor('a,b'), null);
  memory.keep('a,b', 'a');
  assert.equal(memory.keptFor('a,b'), 'a');
  assert.equal(memory.keptFor('c,d'), null);
  memory.keep('c,d', 'c');
  assert.equal(memory.keptFor('a,b'), 'a', 'another set does not replace the kept proposal of the first');
  assert.equal(memory.keptFor('c,d'), 'c');
  memory.keep('a,b', 'b');
  assert.equal(memory.keptFor('a,b'), 'b');
  assert.equal(memory.size(), 0, 'the kept proposals are not picks');
});

test('createScaleMemory: the 33rd kept set drops the oldest, and keeping an old set again makes it the newest', () => {
  const memory = createScaleMemory();
  for (let i = 0; i < 32; i += 1) memory.keep(`set${i}`, 'k');
  memory.keep('set32', 'k');
  assert.equal(memory.keptFor('set0'), null);
  assert.equal(memory.keptFor('set1'), 'k');
  memory.keep('set1', 'k2');
  memory.keep('set33', 'k');
  assert.equal(memory.keptFor('set1'), 'k2');
  assert.equal(memory.keptFor('set2'), null);
  assert.equal(memory.keptFor('set3'), 'k');
});

test('createScaleMemory refuses bad arguments with a Moontide error', () => {
  const memory = createScaleMemory();
  for (const bad of [undefined, null, '', 3]) {
    assert.throws(() => memory.pick(bad, 'k'), /Moontide:/);
    assert.throws(() => memory.pick('s', bad), /Moontide:/);
    assert.throws(() => memory.keep(bad, 'k'), /Moontide:/);
    assert.throws(() => memory.keep('s', bad), /Moontide:/);
    assert.throws(() => memory.pickFor(bad), /Moontide:/);
    assert.throws(() => memory.keptFor(bad), /Moontide:/);
  }
  assert.throws(() => createScaleMemory({ cap: 0 }), /Moontide:/);
});
