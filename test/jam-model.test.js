// Unit tests for page/jam-model.js: the Jam view's copy and the model it draws. No DOM, so no
// build step: imports the page modules directly, like test/history-page.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as model from '../page/jam-model.js';
import { buildReading, readingAt, MODES } from '../page/jam-analysis.js';
import { SCALE_NAME_IDS } from '../page/harmony.js';

// Namespace import: an export the module does not have yet fails inside its own test, a targeted
// failure, instead of crashing the file at load.
const { JAM_COPY, declaredLine, jamStuckFor, jamIsStuck, JAM_RETRY_DELAY_MS, ambiguitySentence, partSubLine, messageModel, buildJamModel, secondsUntil, secondsText, capNotes, cyclesText, statusAnnounceKey } = model;

const ev = (track, begin, end, note) => ({ begin, end, value: { note }, track });
const run = (track, begin, step, names) => names.map((name, i) => ev(track, begin + i * step, begin + (i + 1) * step, name));
const stack = (track, begin, end, names) => names.map((name) => ev(track, begin, end, name));
const loop = (cycles, fn) => Array.from({ length: cycles }, (_, cycle) => fn(cycle)).flat();

const DORIAN = ['d3', 'e3', 'f3', 'g3', 'a3', 'b3', 'c4', 'd4'];
const HARMONIC_E = ['e3', 'f#3', 'g3', 'a3', 'b3', 'c4', 'd#4', 'e4'];
const at = (reading, cycle) => readingAt(reading, { cycle, cps: 0.5, playing: true });

test('JAM_COPY holds exactly the fixed sentences', () => {
  assert.deepEqual(JAM_COPY, {
    nothingPlaying: 'Nothing is playing yet.',
    reading: 'Reading the notes…',
    failed: "Jam couldn't read the notes in time — showing the code instead.",
    noPitched: 'No notes to read: the playing code has no pitched notes.',
    noPitchedSub: 'Only notes with a pitch count; drums are ignored.',
    readFromCode: 'Read from the playing code',
    warningsOff: 'Warnings are off until the scale is clear.',
    noFit: 'No clear scale: the notes fit none of the nine scales.',
    allSafe: 'All safe',
    leavesScale: 'The harmony leaves the scale:',
    noWarningAhead: 'No warning ahead',
    noLookAhead: 'Look-ahead not read yet',
    notBack: 'not back in key within 32 cycles',
    noAvoid: 'no scale note to avoid',
    comingUp: 'Coming up',
    paused: 'Not playing \u2014 countdowns are paused.',
    warningWord: 'Warning',
    partWord: 'Part',
    sameScale: 'same scale',
    scaleUnclear: 'scale unclear',
    piano: 'Piano',
    guitar: 'Guitar',
    instrumentGroup: 'Instrument',
    chordTones: 'Chord tones',
    noChord: 'No chord now',
    chordNow: 'Chord now:',
    declaredLabel: 'Declared:',
    heardLabel: 'Heard:',
    noFitDeclared: 'The notes fit none of the nine scales.',
    heardUnclearLabel: 'The heard scale is not clear.',
    declaredSection: 'section {section}',
    declaredReasons: {
      'not-const': 'Not readable: harmony is declared with let or var; the page reads only const.',
      computed: 'Not readable: harmony is computed ({source}); the page reads only written text.',
      'not-text': 'Not readable: harmony holds {source}, not scale or chord text.',
      'not-a-harmony': 'Not readable: {source} is neither a scale nor chord symbols.',
      empty: 'Not readable: harmony is empty.',
      'too-long': 'Not readable: harmony is longer than 200 characters.',
      'not-a-plain-const': 'Not readable: harmony is part of a destructuring pattern; the page reads only a plain const.',
    },
    legend: {
      scale: { word: 'Scale', title: 'Note in the scale' },
      root: { word: 'Root', title: 'Root of the scale' },
      avoid: { word: 'Avoid', title: 'Note to avoid' },
      outside: { word: 'Outside', title: 'Chord note outside the scale, fine to play' },
      chord: { word: 'Chord tone', title: 'Note of the chord sounding now' },
    },
  });
});

test('messageModel carries the text and an optional muted line', () => {
  assert.deepEqual(messageModel('a'), { state: 'message', text: 'a', sub: null });
  assert.deepEqual(messageModel('a', 'b'), { state: 'message', text: 'a', sub: 'b' });
});

const tie = (names, kind = 'tie') => ({ status: 'ambiguous', kind, candidates: names.map((name) => ({ name })) });

test('ambiguitySentence lists two, three, or the first three and a count of the rest', () => {
  assert.equal(ambiguitySentence(tie(['C major', 'A minor'])), 'No clear scale: the notes fit C major and A minor equally.');
  assert.equal(ambiguitySentence(tie(['A', 'B', 'C'])), 'No clear scale: the notes fit A, B and C equally.');
  assert.equal(ambiguitySentence(tie(['A', 'B', 'C', 'D'])), 'No clear scale: the notes fit A, B, C and 1 more equally.');
  const nine = Array.from({ length: 9 }, (_, i) => `S${i}`);
  assert.equal(ambiguitySentence(tie(nine)), 'No clear scale: the notes fit S0, S1, S2 and 6 more equally.');
});

test('ambiguitySentence says almost equally for a near tie and the no-fit sentence for no fit', () => {
  assert.equal(ambiguitySentence(tie(['C major', 'G major'], 'near')), 'No clear scale: the notes fit C major and G major almost equally.');
  assert.equal(ambiguitySentence({ status: 'no-fit' }), 'No clear scale: the notes fit none of the nine scales.');
  assert.throws(() => ambiguitySentence({ status: 'clear' }), /Moontide:/);
});

test('partSubLine names the part and says the scale is read from it', () => {
  assert.equal(partSubLine('verse'), 'Part "verse" · read from this part');
});

test('partSubLine cuts a long name to 100 UTF-16 units ending with an ellipsis', () => {
  const cut = partSubLine('x'.repeat(150)).slice('Part "'.length, -'" · read from this part'.length);
  assert.equal(cut.length, 100);
  assert.ok(cut.endsWith('…'));
});

test('partSubLine never splits a surrogate pair at the cut', () => {
  const name = `${'a'.repeat(98)}\u{1F600}${'b'.repeat(10)}`;
  const cut = partSubLine(name).slice('Part "'.length, -'" · read from this part'.length);
  assert.equal(cut, `${'a'.repeat(98)}…`);
  assert.ok(!/[\uD800-\uDBFF]$/.test(cut.slice(0, -1)));
});

test('buildJamModel: a reading with no pitched note gives the nothing-pitched message with its muted line', () => {
  const reading = buildReading({ events: [{ begin: 0, end: 1, value: { s: 'bd' }, track: 0 }], windowStart: 0, windowLength: 64 });
  assert.deepEqual(buildJamModel({ position: at(reading, 3) }), {
    state: 'message',
    text: 'No notes to read: the playing code has no pitched notes.',
    sub: 'Only notes with a pitch count; drums are ignored.',
  });
});

test('buildJamModel: a clear scale gives its name, the plain sub-line and seven degree chips', () => {
  const events = loop(4, (c) => [ev(1, c, c + 1, 'd2'), ...run(0, c, 0.125, DORIAN)]);
  const out = buildJamModel({ position: at(buildReading({ events, windowStart: 0, windowLength: 64 }), 2) });
  assert.equal(out.state, 'ready');
  assert.deepEqual(out.scale, { kind: 'clear', text: 'D Dorian', title: 'D Dorian', sub: 'Read from the playing code' });
  assert.deepEqual(out.degrees.map((d) => d.note), ['D', 'E', 'F', 'G', 'A', 'B', 'C']);
  assert.deepEqual(out.degrees.map((d) => d.degree), ['1', '2', '♭3', '4', '5', '6', '♭7']);
  assert.deepEqual(out.degrees.map((d) => d.role), ['root', 'scale', 'scale', 'scale', 'scale', 'scale', 'scale']);
  assert.equal(out.degrees[0].label, 'D, degree 1, root');
  assert.equal(out.degrees[2].label, 'F, degree ♭3');
});

test('buildJamModel: an ambiguous scale gives the sentence, the warnings-off line and no degrees', () => {
  const pads = [
    ...stack(0, 0, 1, ['a3', 'c4', 'e4']),
    ...stack(0, 1, 2, ['f3', 'a3', 'c4']),
    ...stack(0, 2, 3, ['c4', 'e4', 'g4']),
    ...stack(0, 3, 4, ['g3', 'b3', 'd4']),
  ];
  const out = buildJamModel({ position: at(buildReading({ events: pads, windowStart: 0, windowLength: 64 }), 1) });
  assert.equal(out.state, 'ready');
  assert.equal(out.scale.kind, 'ambiguous');
  assert.equal(out.scale.text, 'No clear scale: the notes fit C major, G Mixolydian, A minor and 1 more equally.');
  assert.equal(out.scale.title, out.scale.text);
  assert.equal(out.scale.sub, 'Warnings are off until the scale is clear.');
  assert.deepEqual(out.degrees, []);
});

test('buildJamModel: a chromatic reading says none of the nine scales fit', () => {
  const names = ['c4', 'c#4', 'd4', 'd#4', 'e4', 'f4', 'f#4', 'g4', 'g#4', 'a4', 'a#4', 'b4'];
  const events = loop(2, (c) => run(0, c, 1 / 12, names));
  const out = buildJamModel({ position: at(buildReading({ events, windowStart: 0, windowLength: 64 }), 0.5) });
  assert.equal(out.scale.text, JAM_COPY.noFit);
  assert.equal(out.scale.kind, 'ambiguous');
  assert.deepEqual(out.degrees, []);
});

const TWO_PARTS = {
  index: 0,
  owner: 0,
  total: 8,
  offset: 0,
  sections: [{ name: 'calm', length: 4, start: 0 }, { name: 'bright', length: 4, start: 4 }],
};
const partsEvents = loop(64, (c) => {
  const calm = c % 8 < 4;
  return [ev(1, c, c + 1, calm ? 'd2' : 'e2'), ...run(0, c, 0.125, calm ? DORIAN : HARMONIC_E)];
});

test('buildJamModel follows the part that plays: its scale and its sub-line', () => {
  const reading = buildReading({ events: partsEvents, windowStart: 0, windowLength: 64, arrangements: [TWO_PARTS] });
  const calm = buildJamModel({ position: at(reading, 1.5) });
  assert.equal(calm.scale.text, 'D Dorian');
  assert.equal(calm.scale.sub, 'Part "calm" · read from this part');
  const bright = buildJamModel({ position: at(reading, 5.25) });
  assert.equal(bright.scale.text, 'E harmonic minor');
  assert.equal(bright.scale.sub, 'Part "bright" · read from this part');
});

test('buildJamModel: a position outside the window reads the whole window and names no part', () => {
  const reading = buildReading({ events: partsEvents, windowStart: 0, windowLength: 64, arrangements: [TWO_PARTS] });
  const position = at(reading, 200);
  assert.equal(position.span.name, null);
  const out = buildJamModel({ position });
  assert.equal(out.state, 'ready');
  assert.ok(!out.scale.sub.startsWith('Part '));
  const single = buildReading({ events: loop(4, (c) => [ev(1, c, c + 1, 'd2'), ...run(0, c, 0.125, DORIAN)]), windowStart: 0, windowLength: 64 });
  assert.equal(buildJamModel({ position: at(single, 200) }).scale.sub, 'Read from the playing code');
});

test('buildJamModel: a part with no pitched note says so in the name slot, with its part sub-line and no degrees', () => {
  const quiet = { ...TWO_PARTS, sections: [{ name: 'calm', length: 4, start: 0 }, { name: 'quiet', length: 4, start: 4 }] };
  const events = loop(64, (c) => (c % 8 < 4 ? [ev(1, c, c + 1, 'd2'), ...run(0, c, 0.125, DORIAN)] : []));
  const reading = buildReading({ events, windowStart: 0, windowLength: 64, arrangements: [quiet] });
  const out = buildJamModel({ position: at(reading, 6) });
  assert.equal(out.state, 'ready');
  assert.equal(out.scale.kind, 'none');
  assert.equal(out.scale.text, JAM_COPY.noPitched);
  assert.equal(out.scale.sub, 'Part "quiet" · read from this part');
  assert.deepEqual(out.degrees, []);
});

// --- the status line ---

const NBSP = '\u00A0';
const DORIAN_LOOP = loop(64, (c) => [
  ev(1, c, c + 1, 'd2'),
  ...stack(2, c, c + 1, [2, 3].includes(c % 8) ? ['a2', 'c#3', 'e3', 'g3'] : ['d3', 'f3', 'a3', 'c4']),
  ...run(0, c, 0.125, DORIAN),
]);
const dorianReading = buildReading({ events: DORIAN_LOOP, windowStart: 0, windowLength: 64 });
const atCps = (reading, cycle, cps = 1, playing = true) => readingAt(reading, { cycle, cps, playing });

test('secondsUntil rounds up to whole seconds and never drops below 1', () => {
  assert.equal(secondsUntil(4, 0, 1), 4);
  assert.equal(secondsUntil(3.2, 0, 1), 4);
  assert.equal(secondsUntil(0.1, 0, 1), 1);
  assert.equal(secondsUntil(2, 0, 0.5), 4);
  assert.equal(secondsUntil(2, 2, 1), 1);
});

test('secondsText puts a non-breaking space between the number and s', () => {
  assert.equal(secondsText(4), `4${NBSP}s`);
});

test('capNotes joins six names or fewer and cuts a longer list to six names and an ellipsis', () => {
  assert.equal(capNotes(['C', 'E', 'G']), 'C E G');
  assert.equal(capNotes(['A', 'B', 'C', 'D', 'E', 'F']), 'A B C D E F');
  assert.equal(capNotes(['A', 'B', 'C', 'D', 'E', 'F', 'G']), 'A B C D E F \u2026');
});

test('buildJamModel status: while the chord stays inside the scale it says all safe and when the next warning comes', () => {
  const out = buildJamModel({ position: atCps(dorianReading, 0) });
  assert.deepEqual(out.status, {
    kind: 'safe',
    lead: 'All safe',
    rest: ' \u2014 every note of D Dorian works with the harmony right now.',
    time: `Next warning in 2${NBSP}s`,
    warningIndex: null,
  });
  assert.ok(out.degrees.every((d) => d.role !== 'avoid'));
});

test('buildJamModel status: a chord that leaves the scale names the chord, the outside note, the note to avoid and the way back', () => {
  const out = buildJamModel({ position: atCps(dorianReading, 2.5) });
  assert.deepEqual(out.status, {
    kind: 'warning',
    lead: 'The harmony leaves the scale:',
    rest: ' A7/D contains C#, avoid C',
    time: `back in key in 2${NBSP}s`,
    warningIndex: 0,
    descriptor: { kind: 'warning', chord: 'A7/D', outside: 'C#', avoid: 'C', seconds: 0, scale: 'D Dorian' },
  });
  assert.equal(out.degrees.find((d) => d.note === 'C').role, 'avoid');
  assert.equal(out.degrees.find((d) => d.note === 'C').label, 'C, degree \u266D7, to avoid');
  assert.equal(out.degrees.find((d) => d.note === 'D').role, 'root');
});

test('statusAnnounceKey: a tick keeps the key, a warning starting, ending or changing wording changes it', () => {
  const warn = (time, warningIndex = 0) => ({ kind: 'warning', lead: 'x', rest: 'y', time, warningIndex });
  const safe = (time) => ({ kind: 'safe', lead: 'x', rest: 'y', time, warningIndex: null });
  assert.equal(typeof statusAnnounceKey({ kind: 'off', lead: '', rest: '', time: null, warningIndex: null }), 'string');
  assert.equal(statusAnnounceKey(warn(`back in key in 3${NBSP}s`)), statusAnnounceKey(warn(`back in key in 2${NBSP}s`)));
  assert.equal(statusAnnounceKey(safe(`Next warning in 7${NBSP}s`)), statusAnnounceKey(safe(`Next warning in 6${NBSP}s`)));
  const base = statusAnnounceKey(warn(`back in key in 2${NBSP}s`));
  assert.notEqual(base, statusAnnounceKey(safe(`Next warning in 2${NBSP}s`)));
  assert.notEqual(base, statusAnnounceKey(warn(`back in key in 2${NBSP}s`, 1)));
  assert.notEqual(base, statusAnnounceKey(warn(null)));
  assert.notEqual(base, statusAnnounceKey(warn(JAM_COPY.notBack)));
  assert.notEqual(base, statusAnnounceKey(warn(JAM_COPY.noLookAhead)));
  assert.notEqual(statusAnnounceKey(safe(`Next warning in 5${NBSP}s`)), statusAnnounceKey(safe(JAM_COPY.noWarningAhead)));
});

test('buildJamModel status: at the exact end of the warning the status is safe again', () => {
  assert.equal(buildJamModel({ position: atCps(dorianReading, 4) }).status.kind, 'safe');
});

test('buildJamModel status: with no warning ahead the time part says so', () => {
  const calm = buildReading({ events: loop(64, (c) => [ev(1, c, c + 1, 'd2'), ...run(0, c, 0.125, DORIAN)]), windowStart: 0, windowLength: 64 });
  const out = buildJamModel({ position: atCps(calm, 1) });
  assert.equal(out.status.kind, 'safe');
  assert.equal(out.status.time, 'No warning ahead');
});

test('buildJamModel status: an unnamed chord lists its notes and says include', () => {
  const events = loop(8, (c) => [ev(1, c, c + 1, 'c2'), ...stack(2, c, c + 1, ['c3', 'e3', 'g3']), ...run(0, c, 0.125, ['c4', 'd4', 'e4', 'f4', 'g4', 'a4', 'b4', 'b4'])]);
  events.push(ev(3, 2.2, 2.5, 'f#3'));
  const reading = buildReading({ events, windowStart: 0, windowLength: 8 });
  const out = buildJamModel({ position: atCps(reading, 2.3) });
  assert.equal(out.status.kind, 'warning');
  assert.equal(out.status.rest, ' the notes C E F# G include F#, avoid F');
});

test('buildJamModel status: a warning with no note to avoid, or no way back in the window, says so', () => {
  const position = atCps(dorianReading, 2.5);
  const noAvoid = buildJamModel({ position: { ...position, warning: { ...position.warning, avoid: [], avoidPcs: [] } } });
  assert.equal(noAvoid.status.rest, ' A7/D contains C#, no scale note to avoid');
  const stuck = buildJamModel({ position: { ...position, backInKey: null } });
  assert.equal(stuck.status.time, 'not back in key within 32 cycles');
});

test('buildJamModel status: an ambiguous scale has no status box', () => {
  const pads = [
    ...stack(0, 0, 1, ['a3', 'c4', 'e4']),
    ...stack(0, 1, 2, ['f3', 'a3', 'c4']),
    ...stack(0, 2, 3, ['c4', 'e4', 'g4']),
    ...stack(0, 3, 4, ['g3', 'b3', 'd4']),
  ];
  const out = buildJamModel({ position: atCps(buildReading({ events: pads, windowStart: 0, windowLength: 64 }), 1) });
  assert.equal(out.status.kind, 'off');
  assert.equal(out.status.time, null);
});

test('buildJamModel status: the countdown follows the tempo', () => {
  const out = buildJamModel({ position: atCps(dorianReading, 2.5, 0.5) });
  assert.equal(out.status.time, `back in key in 3${NBSP}s`);
});

// --- the coming-up list and the paused state ---

const EN = '\u2013';
const rowsOf = (out) => {
  assert.ok(Array.isArray(out.rows), 'the model has no rows');
  return out.rows;
};
const plainTimes = (rows) => rows.map((row) => row.time.replace(NBSP, ' '));
const unnamedEvents = (() => {
  const events = loop(8, (c) => [ev(1, c, c + 1, 'c2'), ...stack(2, c, c + 1, ['c3', 'e3', 'g3']), ...run(0, c, 0.125, ['c4', 'd4', 'e4', 'f4', 'g4', 'a4', 'b4', 'b4'])]);
  events.push(ev(3, 2.2, 2.5, 'f#3'));
  return events;
})();

test('cyclesText says 1 cycle, then cycles with at most two decimals and no trailing zeros', () => {
  assert.equal(cyclesText(1), '1 cycle');
  assert.equal(cyclesText(2), '2 cycles');
  assert.equal(cyclesText(0.5), '0.5 cycles');
  assert.equal(cyclesText(1.3333), '1.33 cycles');
  assert.equal(cyclesText(0.25), '0.25 cycles');
});

test('buildJamModel rows: the next warnings, soonest first, at most three, with a countdown', () => {
  const out = buildJamModel({ position: atCps(dorianReading, 0.5) });
  assert.equal(rowsOf(out).length, 3);
  const [first] = rowsOf(out);
  assert.equal(first.kind, 'warning');
  assert.equal(first.kindWord, 'Warning');
  assert.equal(first.text, 'A7/D brings C#, avoid C, lasts 2 cycles');
  assert.equal(first.title, first.text);
  assert.equal(first.time, `2${NBSP}s`);
  assert.equal(first.seconds, 2);
  assert.equal(first.warningIndex, 0);
  assert.deepEqual(plainTimes(rowsOf(out)), ['2 s', '10 s', '18 s']);
  assert.equal(new Set(rowsOf(out).map((r) => r.key)).size, 3);
  assert.equal(out.paused, false);
});

test('buildJamModel rows: the warning the status shows is not repeated as a row', () => {
  const out = buildJamModel({ position: atCps(dorianReading, 2) });
  assert.equal(out.status.kind, 'warning');
  assert.deepEqual(plainTimes(rowsOf(out)), ['8 s', '16 s', '24 s']);
  assert.equal(rowsOf(out)[0].warningIndex, 1);
});

test('buildJamModel rows: an unnamed chord lists its notes and a chord with no note to avoid says so', () => {
  const reading = buildReading({ events: unnamedEvents, windowStart: 0, windowLength: 8 });
  const out = buildJamModel({ position: atCps(reading, 0.5) });
  assert.equal(rowsOf(out)[0].text, 'The notes C E F# G bring F#, avoid F, lasts 0.3 cycles');
  const position = atCps(reading, 0.5);
  const bare = { ...position, reading: { ...reading, warnings: reading.warnings.map((w) => ({ ...w, avoid: [], avoidPcs: [] })) } };
  assert.equal(rowsOf(buildJamModel({ position: bare }))[0].text, 'The notes C E F# G bring F#, no scale note to avoid, lasts 0.3 cycles');
});

test('buildJamModel rows: a part change says its length and what happens to the scale', () => {
  const reading = buildReading({ events: partsEvents, windowStart: 0, windowLength: 64, arrangements: [TWO_PARTS] });
  const out = buildJamModel({ position: atCps(reading, 0.5) });
  const [first] = rowsOf(out);
  assert.equal(first.kind, 'part');
  assert.equal(first.kindWord, 'Part');
  assert.equal(first.text, '"bright" starts (4 cycles) \u2014 scale changes to E harmonic minor');
  assert.equal(first.time, `4${NBSP}s`);
  assert.deepEqual(first.part, { name: 'bright', owner: null });
});

test('buildJamModel rows: same scale and scale unclear variants, and a long part name is cut with the full name kept', () => {
  const dorianPart = (c) => [ev(1, c, c + 1, 'd2'), ...run(0, c, 0.125, DORIAN)];
  const defs = (name) => [{ name: 'a', length: 4, start: 0 }, { name, length: 4, start: 4 }];
  const arranged = (name, events) =>
    buildReading({
      events,
      windowStart: 0,
      windowLength: 64,
      arrangements: [{ index: 0, owner: 0, total: 8, offset: 0, sections: defs(name) }],
    });
  const same = buildJamModel({ position: atCps(arranged('b', loop(64, dorianPart)), 0.5) });
  assert.equal(rowsOf(same)[0].text, '"b" starts (4 cycles) \u2014 same scale');
  const quiet = buildJamModel({ position: atCps(arranged('b', loop(64, (c) => (c % 8 < 4 ? dorianPart(c) : []))), 0.5) });
  assert.equal(rowsOf(quiet)[0].text, '"b" starts (4 cycles) \u2014 scale unclear');
  const longName = 'x'.repeat(150);
  const long = buildJamModel({ position: atCps(arranged(longName, loop(64, dorianPart)), 0.5) });
  const row = rowsOf(long)[0];
  assert.equal(row.text, `"${'x'.repeat(99)}\u2026" starts (4 cycles) \u2014 same scale`);
  assert.equal(row.title, `"${longName}" starts (4 cycles) \u2014 same scale`);
  assert.equal(row.part.name, longName);
});

test('buildJamModel rows: a part row carries the owner name of a many-arrangement code', () => {
  const tracks = [{ index: 0, name: 'lead' }];
  const sections = [{ name: 'a', length: 4, start: 0 }, { name: 'b', length: 4, start: 4 }];
  const one = { index: 0, owner: 0, total: 8, offset: 0, sections };
  const two = { index: 1, owner: null, total: 8, offset: 0, sections };
  const reading = buildReading({ events: loop(64, (c) => [ev(0, c, c + 1, 'd2'), ...run(0, c, 0.125, DORIAN)]), windowStart: 0, windowLength: 64, arrangements: [one, two], tracks });
  assert.deepEqual(rowsOf(buildJamModel({ position: atCps(reading, 0.5) }))[0].part, { name: 'b', owner: 'lead' });
});

test('buildJamModel rows: with no warning ahead the calm row stands in', () => {
  const calm = buildReading({ events: loop(64, (c) => [ev(1, c, c + 1, 'd2'), ...run(0, c, 0.125, DORIAN)]), windowStart: 0, windowLength: 64 });
  const out = buildJamModel({ position: atCps(calm, 1) });
  assert.equal(rowsOf(out).length, 1);
  const [row] = rowsOf(out);
  assert.equal(row.kind, 'calm');
  assert.equal(row.time, EN);
  assert.equal(row.text, `No warning ahead \u2014 nothing leaves D Dorian in the next 32${NBSP}s.`);
  assert.equal(rowsOf(buildJamModel({ position: atCps(calm, 1, 0.5) }))[0].text, `No warning ahead \u2014 nothing leaves D Dorian in the next 64${NBSP}s.`);
});

test('buildJamModel rows: the calm row sits under at most two part rows, and with warnings ahead there is no calm row', () => {
  const reading = buildReading({ events: partsEvents, windowStart: 0, windowLength: 64, arrangements: [TWO_PARTS] });
  const out = buildJamModel({ position: atCps(reading, 0.5) });
  assert.deepEqual(rowsOf(out).map((r) => r.kind), ['part', 'part', 'calm']);
  const mixed = buildJamModel({ position: atCps(dorianReading, 0.5) });
  assert.ok(rowsOf(mixed).every((r) => r.kind === 'warning'));
});

test('buildJamModel rows: with several part changes before the first warning the first three events are listed', () => {
  const env = loop(64, (c) => [ev(1, c, c + 1, 'd2'), ...stack(2, c, c + 1, c % 16 === 12 ? ['a2', 'c#3', 'e3', 'g3'] : ['d3', 'f3', 'a3', 'c4']), ...run(0, c, 0.125, DORIAN)]);
  const arrangement = { index: 0, owner: 0, total: 8, offset: 0, sections: [{ name: 'a', length: 4, start: 0 }, { name: 'b', length: 4, start: 4 }] };
  const reading = buildReading({ events: env, windowStart: 0, windowLength: 64, arrangements: [arrangement] });
  const out = buildJamModel({ position: atCps(reading, 0.5) });
  assert.deepEqual(rowsOf(out).map((r) => r.kind), ['part', 'part', 'part']);
});

test('buildJamModel rows: an unclear scale lists part rows only, or the warnings-off row when there is none', () => {
  const pads = [
    ...stack(0, 0, 1, ['a3', 'c4', 'e4']),
    ...stack(0, 1, 2, ['f3', 'a3', 'c4']),
    ...stack(0, 2, 3, ['c4', 'e4', 'g4']),
    ...stack(0, 3, 4, ['g3', 'b3', 'd4']),
  ];
  const out = buildJamModel({ position: atCps(buildReading({ events: pads, windowStart: 0, windowLength: 64 }), 1) });
  assert.equal(rowsOf(out).length, 1);
  assert.equal(rowsOf(out)[0].kind, 'off');
  assert.equal(rowsOf(out)[0].text, 'Warnings are off until the scale is clear.');
  assert.equal(rowsOf(out)[0].time, EN);
});

test('buildJamModel paused: times read an en dash, the status drops its time part and the rows keep their seconds', () => {
  const out = buildJamModel({ position: atCps(dorianReading, 0.5, 1, false) });
  assert.equal(out.paused, true);
  assert.equal(out.status.time, null);
  assert.deepEqual(rowsOf(out).map((r) => r.time), [EN, EN, EN]);
  assert.deepEqual(rowsOf(out).map((r) => r.seconds), [2, 10, 18]);
  const warning = buildJamModel({ position: atCps(dorianReading, 2.5, 1, false) });
  assert.equal(warning.status.kind, 'warning');
  assert.equal(warning.status.time, null);
});

// --- the piano ---

const { pianoKeys, rolesByPc, pcNames, keyLabel, instrumentLabel } = model;
const ROLES_DORIAN = ['scale', 'off', 'root', 'off', 'scale', 'scale', 'off', 'scale', 'off', 'scale', 'off', 'scale'];

test('pianoKeys: 24 keys from C3 (MIDI 48) to B4, 14 white and 10 black, octave 3 then 4', () => {
  const keys = pianoKeys();
  assert.equal(keys.length, 24);
  assert.equal(keys[0].midi, 48);
  assert.equal(keys[23].midi, 71);
  assert.equal(keys.filter((k) => !k.black).length, 14);
  assert.equal(keys.filter((k) => k.black).length, 10);
  assert.equal(keys[0].octave, 3);
  assert.equal(keys[12].octave, 4);
  assert.equal(keys[12].pc, 0);
  assert.deepEqual(keys.map((k) => k.pc), Array.from({ length: 24 }, (_, i) => i % 12));
});

test('pianoKeys: white keys sit at k * 100/14 percent and black keys straddle the boundary after C, D, F, G and A', () => {
  const keys = pianoKeys();
  const unit = 100 / 14;
  const whites = keys.filter((k) => !k.black);
  whites.forEach((k, i) => {
    assert.ok(Math.abs(k.left - i * unit) < 1e-9);
    assert.ok(Math.abs(k.width - unit) < 1e-9);
  });
  const blacks = keys.filter((k) => k.black);
  assert.deepEqual(blacks.map((k) => k.pc), [1, 3, 6, 8, 10, 1, 3, 6, 8, 10]);
  // the black key after white key 0 (C) sits on the boundary between white keys 0 and 1
  assert.ok(Math.abs(blacks[0].left - (unit - 0.3 * unit)) < 1e-9);
  assert.ok(Math.abs(blacks[0].width - 0.6 * unit) < 1e-9);
  // the black key after white key 2 (E) does not exist: the next black key is after F (white key 3)
  assert.ok(Math.abs(blacks[2].left - (4 * unit - 0.3 * unit)) < 1e-9);
});

test('rolesByPc: D Dorian marks the root, the scale notes and leaves the rest off', () => {
  assert.deepEqual(rolesByPc(atCps(dorianReading, 0.5)), ROLES_DORIAN);
});

test('rolesByPc: during the A7/D warning the C is to avoid and the C# is outside', () => {
  const roles = rolesByPc(atCps(dorianReading, 2.5));
  assert.equal(roles[0], 'avoid');
  assert.equal(roles[1], 'outside');
  assert.equal(roles[2], 'root');
  assert.deepEqual(roles.filter((_, pc) => pc !== 0 && pc !== 1), ROLES_DORIAN.filter((_, pc) => pc !== 0 && pc !== 1));
});

test('rolesByPc: avoid wins over the root', () => {
  const position = atCps(dorianReading, 2.5);
  const rootAvoided = { ...position, warning: { ...position.warning, avoidPcs: [2], outsidePcs: [1] } };
  assert.equal(rolesByPc(rootAvoided)[2], 'avoid');
});

test('rolesByPc: an ambiguous scale gives off on all twelve', () => {
  const pads = [
    ...stack(0, 0, 1, ['a3', 'c4', 'e4']),
    ...stack(0, 1, 2, ['f3', 'a3', 'c4']),
    ...stack(0, 2, 3, ['c4', 'e4', 'g4']),
    ...stack(0, 3, 4, ['g3', 'b3', 'd4']),
  ];
  const roles = rolesByPc(atCps(buildReading({ events: pads, windowStart: 0, windowLength: 64 }), 1));
  assert.deepEqual(roles, new Array(12).fill('off'));
});

test('pcNames: the scale spelling when clear, the default spelling otherwise', () => {
  assert.equal(pcNames(atCps(dorianReading, 0.5))[1], 'C#');
  assert.equal(pcNames(atCps(dorianReading, 0.5))[10], 'Bb');
  const fMajor = buildReading({ events: loop(8, (c) => [ev(0, c, c + 1, 'f3'), ...run(0, c, 0.125, ['f3', 'g3', 'a3', 'bb3', 'c4', 'd4', 'e4', 'f4'])]), windowStart: 0, windowLength: 8 });
  assert.equal(pcNames(atCps(fMajor, 1))[10], 'Bb');
});

test('keyLabel: a C key reads its octave unless it is to avoid, a marked key its spelled name, an off key nothing', () => {
  const keys = pianoKeys();
  const position = atCps(dorianReading, 2.5);
  const roles = rolesByPc(position);
  const names = pcNames(position);
  // While C is to avoid the cross leaves no room for an octave digit: the label is the bare name.
  assert.equal(roles[0], 'avoid');
  assert.equal(keyLabel(keys[0], roles, names), 'C');
  assert.equal(keyLabel(keys[12], roles, names), 'C');
  const safe = rolesByPc(atCps(dorianReading, 0.5));
  assert.equal(keyLabel(keys[0], safe, names), 'C3');
  assert.equal(keyLabel(keys[12], safe, names), 'C4');
  assert.equal(keyLabel(keys[2], roles, names), 'D');
  assert.equal(keyLabel(keys[13], roles, names), 'C#');
  assert.equal(keyLabel(keys[3], roles, names), '');
  const off = rolesByPc({ ...position, scale: { status: 'ambiguous' }, warning: null });
  assert.equal(keyLabel(keys[12], off, pcNames({ ...position, scale: { status: 'ambiguous' } })), 'C4');
  assert.equal(keyLabel(keys[2], off, names), '');
});

test('instrumentLabel piano: the scale notes, the root and what to avoid, or no clear scale', () => {
  assert.equal(
    instrumentLabel('piano', atCps(dorianReading, 0.5)),
    'Piano, two octaves from C3. Scale notes: D, E, F, G, A, B, C. Root D. Avoid: none.',
  );
  assert.equal(
    instrumentLabel('piano', atCps(dorianReading, 2.5)),
    'Piano, two octaves from C3. Scale notes: D, E, F, G, A, B, C. Root D. Avoid: C.',
  );
  const pads = [
    ...stack(0, 0, 1, ['a3', 'c4', 'e4']),
    ...stack(0, 1, 2, ['f3', 'a3', 'c4']),
    ...stack(0, 2, 3, ['c4', 'e4', 'g4']),
    ...stack(0, 3, 4, ['g3', 'b3', 'd4']),
  ];
  assert.equal(
    instrumentLabel('piano', atCps(buildReading({ events: pads, windowStart: 0, windowLength: 64 }), 1)),
    'Piano, two octaves from C3. No clear scale.',
  );
  assert.throws(() => instrumentLabel('banjo', atCps(dorianReading, 0.5)), /Moontide:/);
});

test('buildJamModel carries the instrument: roles, names, root and the piano label; a message model has none', () => {
  const out = buildJamModel({ position: atCps(dorianReading, 2.5) });
  assert.ok(out.instrument, 'the ready model has no instrument');
  assert.equal(out.instrument.roles[0], 'avoid');
  assert.equal(out.instrument.roles[1], 'outside');
  assert.equal(out.instrument.names[1], 'C#');
  assert.equal(out.instrument.rootPc, 2);
  assert.equal(out.instrument.pianoLabel, 'Piano, two octaves from C3. Scale notes: D, E, F, G, A, B, C. Root D. Avoid: C.');
  const none = buildReading({ events: [{ begin: 0, end: 1, value: { s: 'bd' }, track: 0 }], windowStart: 0, windowLength: 64 });
  assert.equal(buildJamModel({ position: atCps(none, 1) }).instrument, undefined);
});

// --- the guitar ---

const { STRINGS, STRING_NAMES, FRET_NUMBERS, fretUnits, fretCells } = model;

test('fretUnits: the open column is 0.8, fret 1 is 1 and fret 12 is 2^(-11/12) of fret 1', () => {
  assert.equal(fretUnits(0), 0.8);
  assert.equal(fretUnits(1), 1);
  assert.ok(Math.abs(fretUnits(12) / fretUnits(1) - 2 ** (-11 / 12)) < 1e-9);
  let sum = 0;
  for (let fret = 0; fret <= 12; fret++) sum += fretUnits(fret);
  assert.ok(Math.abs(sum - 9.7086) < 1e-3);
});

test('STRINGS are E4 B3 G3 D3 A2 E2 from the top row down, named e B G D A E; FRET_NUMBERS are 3 5 7 9 12', () => {
  assert.deepEqual(STRINGS, [64, 59, 55, 50, 45, 40]);
  assert.deepEqual(STRING_NAMES, ['e', 'B', 'G', 'D', 'A', 'E']);
  assert.deepEqual(FRET_NUMBERS, [3, 5, 7, 9, 12]);
});

test('fretCells: 6 rows of 13 cells, each pitch class the string open pitch class plus the fret', () => {
  const rows = fretCells();
  assert.equal(rows.length, 6);
  assert.ok(rows.every((row) => row.length === 13));
  rows.forEach((row, string) => {
    row.forEach((cell, fret) => {
      assert.equal(cell.string, string);
      assert.equal(cell.fret, fret);
      assert.equal(cell.midi, STRINGS[string] + fret);
      assert.equal(cell.pc, (STRINGS[string] + fret) % 12);
    });
  });
  assert.equal(rows[4][5].pc, 2); // the A string at fret 5 is D
  assert.equal(rows[1][4].pc, 3); // the B string at fret 4 is Eb
  assert.equal(rows[5][0].pc, 4); // the low E string open is E
});

test('instrumentLabel guitar: the scale notes, the root and what to avoid, or no clear scale', () => {
  assert.equal(
    instrumentLabel('guitar', atCps(dorianReading, 0.5)),
    'Guitar fretboard, standard tuning, 12 frets. Scale notes: D, E, F, G, A, B, C. Root D. Avoid: none.',
  );
  assert.equal(
    instrumentLabel('guitar', atCps(dorianReading, 2.5)),
    'Guitar fretboard, standard tuning, 12 frets. Scale notes: D, E, F, G, A, B, C. Root D. Avoid: C.',
  );
  assert.equal(buildJamModel({ position: atCps(dorianReading, 2.5) }).instrument.guitarLabel, instrumentLabel('guitar', atCps(dorianReading, 2.5)));
});

// --- the chord tones overlay ---

const { chordLineText, legendEntries } = model;

test('JAM_COPY carries the chord-tones words and the legend words and titles', () => {
  assert.equal(JAM_COPY.chordTones, 'Chord tones');
  assert.equal(JAM_COPY.noChord, 'No chord now');
  assert.equal(JAM_COPY.chordNow, 'Chord now:');
  assert.deepEqual(JAM_COPY.legend, {
    scale: { word: 'Scale', title: 'Note in the scale' },
    root: { word: 'Root', title: 'Root of the scale' },
    avoid: { word: 'Avoid', title: 'Note to avoid' },
    outside: { word: 'Outside', title: 'Chord note outside the scale, fine to play' },
    chord: { word: 'Chord tone', title: 'Note of the chord sounding now' },
  });
});

test('chordLineText: a named chord with its notes, an unnamed one with its notes, nothing together', () => {
  assert.equal(chordLineText({ name: 'Dm7', notes: ['D', 'F', 'A', 'C'], pcs: [2, 5, 9, 0] }), 'Chord now: Dm7 · D F A C');
  assert.equal(chordLineText({ name: null, notes: ['C', 'E', 'F#', 'G'], pcs: [0, 4, 6, 7] }), 'Chord now: C E F# G');
  assert.equal(chordLineText(null), 'No chord now');
});

test('chordLineText: at most six names, then an ellipsis', () => {
  const seven = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
  assert.equal(chordLineText({ name: null, notes: seven, pcs: [0, 2, 4, 5, 7, 9, 11] }), 'Chord now: C D E F G A …');
  assert.equal(chordLineText({ name: 'Cmaj7', notes: seven, pcs: [] }), 'Chord now: Cmaj7 · C D E F G A …');
});

test('legendEntries: four entries, five with the overlay, each with its word and title', () => {
  const four = legendEntries(false);
  assert.deepEqual(four.map((e) => e.role), ['scale', 'root', 'avoid', 'outside']);
  assert.deepEqual(four.map((e) => e.word), ['Scale', 'Root', 'Avoid', 'Outside']);
  assert.deepEqual(four.map((e) => e.title), ['Note in the scale', 'Root of the scale', 'Note to avoid', 'Chord note outside the scale, fine to play']);
  const five = legendEntries(true);
  assert.equal(five.length, 5);
  assert.deepEqual(five[4], { role: 'chord', word: 'Chord tone', title: 'Note of the chord sounding now' });
});

test('buildJamModel chordTones on: the chord line, and the chord marked on the chips and the instrument', () => {
  const out = buildJamModel({ position: atCps(dorianReading, 0.5), chordTones: true });
  assert.equal(out.chordLine, 'Chord now: Dm7 · D F A C');
  assert.deepEqual(out.degrees.filter((d) => d.chord).map((d) => d.note).sort(), ['A', 'C', 'D', 'F']);
  assert.deepEqual(out.instrument.chordPcs.map((on, pc) => (on ? pc : null)).filter((pc) => pc !== null), [0, 2, 5, 9]);
  assert.equal(out.instrument.chordPcs.length, 12);
});

test('buildJamModel chordTones off or absent: no chord marks and no chord line', () => {
  for (const out of [buildJamModel({ position: atCps(dorianReading, 0.5) }), buildJamModel({ position: atCps(dorianReading, 0.5), chordTones: false })]) {
    assert.equal(out.chordLine, null);
    assert.ok(out.degrees.every((d) => !d.chord));
    assert.deepEqual(out.instrument.chordPcs, new Array(12).fill(false));
  }
});

test('buildJamModel chordTones on with no chord sounding: no mark and the no-chord line', () => {
  const lone = buildReading({ events: loop(8, (c) => run(0, c, 0.5, ['d3', 'e3', 'f3', 'g3', 'a3', 'b3', 'c4', 'd4'].slice(0, 2))), windowStart: 0, windowLength: 8 });
  const out = buildJamModel({ position: atCps(lone, 0.25), chordTones: true });
  assert.equal(out.chordLine, 'No chord now');
  assert.deepEqual(out.instrument.chordPcs, new Array(12).fill(false));
});

test('buildJamModel chordTones on with an ambiguous scale: roles stay off, the chord still carries its mark and names', () => {
  const pads = [
    ...stack(0, 0, 1, ['a3', 'c4', 'e4']),
    ...stack(0, 1, 2, ['f3', 'a3', 'c4']),
    ...stack(0, 2, 3, ['c4', 'e4', 'g4']),
    ...stack(0, 3, 4, ['g3', 'b3', 'd4']),
  ];
  const out = buildJamModel({ position: atCps(buildReading({ events: pads, windowStart: 0, windowLength: 64 }), 0.5), chordTones: true });
  assert.deepEqual(out.instrument.roles, new Array(12).fill('off'));
  assert.deepEqual(out.instrument.chordPcs.map((on, pc) => (on ? pc : null)).filter((pc) => pc !== null), [0, 4, 9]);
  assert.equal(out.chordLine, 'Chord now: Am · A C E');
});

test('keyLabel with chord tones: a chord tone shows its name even when its role is off', () => {
  const keys = pianoKeys();
  const position = atCps(dorianReading, 0.5);
  const roles = rolesByPc(position);
  const names = pcNames(position);
  const chordPcs = new Array(12).fill(false);
  chordPcs[3] = true;
  assert.equal(keyLabel(keys[3], roles, names), '');
  assert.equal(keyLabel(keys[3], roles, names, chordPcs), 'Eb');
  assert.equal(keyLabel(keys[0], roles, names, chordPcs), 'C3');
});

// --- ask descriptors ---

const { warningDescriptor, noteDescriptor } = model;

test('warningDescriptor: the named chord, the outside and avoid notes, the seconds and the scale', () => {
  const warning = { chord: 'A7/D', notes: ['A', 'C#', 'D', 'E', 'G'], outside: ['C#'], avoid: ['C'] };
  assert.deepEqual(warningDescriptor({ warning, seconds: 0, scaleName: 'D Dorian' }), {
    kind: 'warning',
    chord: 'A7/D',
    outside: 'C#',
    avoid: 'C',
    seconds: 0,
    scale: 'D Dorian',
  });
});

test('warningDescriptor: an unnamed chord lists at most six names then an ellipsis, several notes are joined by commas, no avoid note leaves the field out', () => {
  const notes = ['C', 'D', 'E', 'F#', 'G', 'A', 'B'];
  const warning = { chord: null, notes, outside: ['F#', 'B'], avoid: [] };
  const out = warningDescriptor({ warning, seconds: 4, scaleName: 'C major' });
  assert.equal(out.chord, 'C D E F# G A \u2026');
  assert.equal(out.outside, 'F#, B');
  assert.equal('avoid' in out, false);
  const several = warningDescriptor({ warning: { ...warning, avoid: ['F', 'C'] }, seconds: 4, scaleName: 'C major' });
  assert.equal(several.avoid, 'F, C');
  assert.equal(warningDescriptor({ warning: { ...warning, notes: ['C', 'E', 'G'] }, seconds: 4, scaleName: 'C major' }).chord, 'C E G');
});

test('buildJamModel: the warning status carries its descriptor (seconds 0, the current scale); other states carry none', () => {
  const warn = buildJamModel({ position: atCps(dorianReading, 2.5) });
  assert.deepEqual(warn.status.descriptor, { kind: 'warning', chord: 'A7/D', outside: 'C#', avoid: 'C', seconds: 0, scale: 'D Dorian' });
  assert.equal('descriptor' in buildJamModel({ position: atCps(dorianReading, 0) }).status, false);
});

test('buildJamModel: each warning row carries a descriptor with its own seconds and its part\'s scale, also while paused; other rows carry none', () => {
  const out = buildJamModel({ position: atCps(dorianReading, 0.5) });
  assert.deepEqual(out.rows[0].descriptor, { kind: 'warning', chord: 'A7/D', outside: 'C#', avoid: 'C', seconds: 2, scale: 'D Dorian' });
  const paused = buildJamModel({ position: atCps(dorianReading, 0.5, 1, false) });
  assert.equal(paused.rows[0].descriptor.seconds, 2);
  const calm = buildReading({ events: loop(64, (c) => [ev(1, c, c + 1, 'd2'), ...run(0, c, 0.125, DORIAN)]), windowStart: 0, windowLength: 64 });
  assert.equal('descriptor' in buildJamModel({ position: atCps(calm, 1) }).rows[0], false);
  const parts = buildReading({ events: partsEvents, windowStart: 0, windowLength: 64, arrangements: [TWO_PARTS] });
  const partRows = buildJamModel({ position: atCps(parts, 0.5) }).rows.filter((row) => row.kind === 'part');
  assert.ok(partRows.length > 0);
  assert.ok(partRows.every((row) => !('descriptor' in row)));
});

test('noteDescriptor: the note with its role and scale, or the bare note while the scale is not clear', () => {
  assert.deepEqual(noteDescriptor({ note: 'B', role: 'avoid', scaleName: 'D Dorian' }), { kind: 'note', note: 'B', role: 'avoid', scale: 'D Dorian' });
  assert.deepEqual(noteDescriptor({ note: 'D', role: 'root', scaleName: null }), { kind: 'note', note: 'D' });
  assert.deepEqual(noteDescriptor({ note: 'D', role: 'off', scaleName: null }), { kind: 'note', note: 'D' });
});

test('buildJamModel noteScaleName: the clear scale name, null while the scale is ambiguous, not fitting or a part has no pitched note', () => {
  assert.equal(buildJamModel({ position: atCps(dorianReading, 0) }).noteScaleName, 'D Dorian');
  assert.equal(buildJamModel({ position: atCps(dorianReading, 2.5) }).noteScaleName, 'D Dorian');
  const pads = [
    ...stack(0, 0, 1, ['a3', 'c4', 'e4']),
    ...stack(0, 1, 2, ['f3', 'a3', 'c4']),
    ...stack(0, 2, 3, ['c4', 'e4', 'g4']),
    ...stack(0, 3, 4, ['g3', 'b3', 'd4']),
  ];
  const ambiguous = buildJamModel({ position: atCps(buildReading({ events: pads, windowStart: 0, windowLength: 64 }), 1) });
  assert.equal(ambiguous.scale.kind, 'ambiguous');
  assert.equal(ambiguous.noteScaleName, null);
  const chroma = loop(4, (c) => run(0, c, 1 / 12, ['c3', 'c#3', 'd3', 'd#3', 'e3', 'f3', 'f#3', 'g3', 'g#3', 'a3', 'a#3', 'b3']));
  const noFit = buildJamModel({ position: atCps(buildReading({ events: chroma, windowStart: 0, windowLength: 64 }), 0.5) });
  assert.equal(noFit.noteScaleName, null);
  const quiet = { ...TWO_PARTS, sections: [{ name: 'calm', length: 4, start: 0 }, { name: 'quiet', length: 4, start: 4 }] };
  const events = loop(64, (c) => (c % 8 < 4 ? [ev(1, c, c + 1, 'd2'), ...run(0, c, 0.125, DORIAN)] : []));
  const none = buildJamModel({ position: at(buildReading({ events, windowStart: 0, windowLength: 64, arrangements: [quiet] }), 6) });
  assert.equal(none.scale.kind, 'none');
  assert.equal(none.noteScaleName, null);
});

// --- a reading without look-ahead, and when a failed reading is tried again ---

test('a partial reading (the next page could not be read) promises nothing about what comes', () => {
  const events = loop(32, (c) => [ev(1, c, c + 1, 'd2'), ...run(0, c, 0.125, DORIAN)]);
  const partial = buildReading({ events, windowStart: 0, windowLength: 32, partial: true });
  assert.equal(partial.partial, true);
  const out = buildJamModel({ position: atCps(partial, 1) });
  assert.equal(out.status.kind, 'safe');
  assert.equal(out.status.time, JAM_COPY.noLookAhead);
  const calm = out.rows.find((row) => row.kind === 'calm');
  assert.ok(calm.text.startsWith(JAM_COPY.noLookAhead));
  assert.ok(!calm.text.includes('nothing leaves'));
  const full = buildReading({ events, windowStart: 0, windowLength: 64 });
  assert.equal(full.partial, false);
  const fullOut = buildJamModel({ position: atCps(full, 1) });
  assert.equal(fullOut.status.time, JAM_COPY.noWarningAhead);
  assert.ok(fullOut.rows.find((row) => row.kind === 'calm').text.includes('nothing leaves'));
});

test('jamStuckFor retries a too-slow reading once after a pause, then sticks; other failures stick at once', () => {
  const first = jamStuckFor({ previous: null, version: 3, pageStart: 32, slow: true, now: 1000 });
  assert.deepEqual(first, { version: 3, pageStart: 32, retries: 1, retryAt: 1000 + JAM_RETRY_DELAY_MS });
  const second = jamStuckFor({ previous: first, version: 3, pageStart: 32, slow: true, now: 4000 });
  assert.deepEqual(second, { version: 3, pageStart: 32, retries: 1, retryAt: null });
  assert.deepEqual(jamStuckFor({ previous: null, version: 3, pageStart: 32, slow: false, now: 1000 }), { version: 3, pageStart: 32, retries: 0, retryAt: null });
  // another page or version counts afresh
  assert.equal(jamStuckFor({ previous: second, version: 3, pageStart: 64, slow: true, now: 5000 }).retryAt, 5000 + JAM_RETRY_DELAY_MS);
  assert.equal(jamStuckFor({ previous: second, version: 4, pageStart: 32, slow: true, now: 5000 }).retryAt, 5000 + JAM_RETRY_DELAY_MS);
});

test('jamIsStuck blocks the tick for the failed version and page until the retry time', () => {
  const where = { version: 3, pageStart: 32 };
  assert.equal(jamIsStuck(null, { ...where, now: 0 }), false);
  const retrying = { version: 3, pageStart: 32, retries: 1, retryAt: 3000 };
  assert.equal(jamIsStuck(retrying, { ...where, now: 2999 }), true);
  assert.equal(jamIsStuck(retrying, { ...where, now: 3000 }), false);
  const stuck = { version: 3, pageStart: 32, retries: 1, retryAt: null };
  assert.equal(jamIsStuck(stuck, { ...where, now: 1e9 }), true);
  assert.equal(jamIsStuck(stuck, { version: 3, pageStart: 64, now: 0 }), false);
  assert.equal(jamIsStuck(stuck, { version: 4, pageStart: 32, now: 0 }), false);
  assert.equal(jamIsStuck({ ...stuck, pageStart: null }, { version: 3, pageStart: 96, now: 0 }), true);
});

// --- the declared harmony ---

const SENTENCES = {
  'not-const': 'Not readable: harmony is declared with let or var; the page reads only const.',
  computed: 'Not readable: harmony is computed (pick(["C:major"])); the page reads only written text.',
  'not-text': 'Not readable: harmony holds 42, not scale or chord text.',
  'not-a-harmony': 'Not readable: "hello" is neither a scale nor chord symbols.',
  empty: 'Not readable: harmony is empty.',
  'too-long': 'Not readable: harmony is longer than 200 characters.',
  'not-a-plain-const': 'Not readable: harmony is part of a destructuring pattern; the page reads only a plain const.',
};
const SOURCES = { computed: 'pick(["C:major"])', 'not-text': '42', 'not-a-harmony': '"hello"' };

// Every string of a nested value, keys included.
function allStrings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) allStrings(item, out);
  else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      out.push(key);
      allStrings(item, out);
    }
  }
  return out;
}

const scaleDeclared = (text, scale) => ({ state: 'declared', kind: 'scale', text, scale });
const TIE_PADS = [
  ...stack(0, 0, 1, ['a3', 'c4', 'e4']),
  ...stack(0, 1, 2, ['f3', 'a3', 'c4']),
  ...stack(0, 2, 3, ['c4', 'e4', 'g4']),
  ...stack(0, 3, 4, ['g3', 'b3', 'd4']),
];
const CHROMATIC = ['c4', 'c#4', 'd4', 'd#4', 'e4', 'f4', 'f#4', 'g4', 'g#4', 'a4', 'a#4', 'b4'];
const DRUMS = [{ begin: 0, end: 1, value: { s: 'bd' }, track: 0 }];
const modelOf = (events, declared, cycle = 1) => {
  const options = { events, windowStart: 0, windowLength: 64 };
  if (declared !== undefined) options.declared = declared;
  return buildJamModel({ position: atCps(buildReading(options), cycle, 0.5) });
};

test('declaredLine: no declaration gives null', () => {
  assert.equal(declaredLine({ state: 'none' }), null);
});

test('declaredLine: a single nine-scale token shows the page\'s own name, the title holds the text as written', () => {
  const cases = [
    ['D4:dorian', { rootPc: 2, modeId: 'dorian' }, 'D Dorian'],
    ['C:major', { rootPc: 0, modeId: 'ionian' }, 'C major'],
    ['a:minor', { rootPc: 9, modeId: 'aeolian' }, 'A minor'],
    ['Eb:major', { rootPc: 3, modeId: 'ionian' }, 'Eb major'],
    ['C:harmonic:minor', { rootPc: 0, modeId: 'harmonic-minor' }, 'C harmonic minor'],
  ];
  for (const [text, scale, shown] of cases) {
    assert.deepEqual(declaredLine(scaleDeclared(text, scale)), { kind: 'scale', text: shown, title: `harmony = ${text}` }, text);
  }
});

test('declaredLine: any other readable text is shown as written', () => {
  assert.deepEqual(declaredLine(scaleDeclared('C:minor pentatonic', null)), { kind: 'scale', text: 'C:minor pentatonic', title: 'harmony = C:minor pentatonic' });
  assert.deepEqual(declaredLine(scaleDeclared('<C:major D:dorian>/2', null)), { kind: 'scale', text: '<C:major D:dorian>/2', title: 'harmony = <C:major D:dorian>/2' });
  const chords = { state: 'declared', kind: 'chords', text: '<Dm7 G7 C^7>', scale: null };
  assert.deepEqual(declaredLine(chords), { kind: 'chords', text: '<Dm7 G7 C^7>', title: 'harmony = <Dm7 G7 C^7>' });
});

test('declaredLine: a value over 60 UTF-16 units is cut with an ellipsis and the title keeps the whole text', () => {
  const text = `<${'Dm7 '.repeat(20)}G7>`;
  const out = declaredLine({ state: 'declared', kind: 'chords', text, scale: null });
  assert.equal(out.text.length, 60);
  assert.ok(out.text.endsWith('…'));
  assert.equal(out.title, `harmony = ${text}`);
  const exact = 'C'.repeat(60);
  assert.equal(declaredLine({ state: 'declared', kind: 'chords', text: exact, scale: null }).text, exact);
});

for (const [reason, sentence] of Object.entries(SENTENCES)) {
  test(`declaredLine: the reason '${reason}' says why in one muted sentence`, () => {
    const out = declaredLine({ state: 'unreadable', reason, source: SOURCES[reason] ?? null });
    assert.deepEqual(out, { kind: 'unreadable', text: sentence, title: sentence });
  });
}

test('declaredLine: the quoted source is put in as plain text, never as a pattern', () => {
  const out = declaredLine({ state: 'unreadable', reason: 'computed', source: "$&$1 $' <b>x</b>" });
  assert.equal(out.text, "Not readable: harmony is computed ($&$1 $' <b>x</b>); the page reads only written text.");
});

test('declaredLine throws on what it cannot say', () => {
  assert.throws(() => declaredLine({ state: 'unreadable', reason: 'nope', source: null }), /^Error: Moontide:/);
  assert.throws(() => declaredLine({ state: 'unreadable', reason: '__proto__', source: null }), /Moontide:/);
  assert.throws(() => declaredLine({ state: 'unreadable', reason: 'computed', source: null }), /Moontide:/);
  assert.throws(() => declaredLine({ state: 'maybe' }), /Moontide:/);
  assert.throws(() => declaredLine(scaleDeclared('C:major', { rootPc: 0, modeId: 'nope' })), /Moontide:/);
  assert.throws(() => declaredLine({ state: 'declared', kind: 'mood', text: 'x', scale: null }), /Moontide:/);
});

test('every mode id the harmony reader can return is the id of a MODES entry', () => {
  const ids = new Set(MODES.map((mode) => mode.id));
  for (const [name, modeId] of SCALE_NAME_IDS) assert.ok(ids.has(modeId), `${name} -> ${modeId}`);
});

test('ambiguitySentence in declared mode drops the verdict prefix and keeps the list rules', () => {
  const declared = { declared: true };
  assert.equal(ambiguitySentence(tie(['C major', 'A minor']), declared), 'The notes fit C major and A minor equally.');
  assert.equal(ambiguitySentence(tie(['A', 'B', 'C']), declared), 'The notes fit A, B and C equally.');
  assert.equal(ambiguitySentence(tie(['A', 'B', 'C', 'D']), declared), 'The notes fit A, B, C and 1 more equally.');
  const nine = Array.from({ length: 9 }, (_, i) => `S${i}`);
  assert.equal(ambiguitySentence(tie(nine), declared), 'The notes fit S0, S1, S2 and 6 more equally.');
  assert.equal(ambiguitySentence(tie(['C major', 'G major'], 'near'), declared), 'The notes fit C major and G major almost equally.');
  assert.equal(ambiguitySentence({ status: 'no-fit' }, declared), 'The notes fit none of the nine scales.');
  assert.equal(ambiguitySentence({ status: 'no-fit' }, { declared: false }), JAM_COPY.noFit);
  assert.throws(() => ambiguitySentence({ status: 'clear' }, declared), /Moontide:/);
});

test('instrumentLabel in declared mode says the heard scale is not clear; a clear scale reads the same in both modes', () => {
  const tied = atCps(buildReading({ events: TIE_PADS, windowStart: 0, windowLength: 64 }), 1);
  assert.equal(instrumentLabel('piano', tied, { declared: true }), 'Piano, two octaves from C3. The heard scale is not clear.');
  assert.equal(instrumentLabel('guitar', tied, { declared: true }), 'Guitar fretboard, standard tuning, 12 frets. The heard scale is not clear.');
  assert.equal(instrumentLabel('piano', tied), 'Piano, two octaves from C3. No clear scale.');
  const clear = atCps(dorianReading, 0.5);
  assert.equal(instrumentLabel('piano', clear, { declared: true }), instrumentLabel('piano', clear));
});

test('buildJamModel without a declaration: every ready model has declared null and the texts are as before', () => {
  assert.equal(buildReading({ events: TIE_PADS, windowStart: 0, windowLength: 64 }).declared.state, 'none');
  const tied = modelOf(TIE_PADS);
  assert.equal(tied.declared, null);
  assert.ok(tied.scale.text.startsWith('No clear scale: the notes fit '));
  assert.ok(tied.instrument.pianoLabel.endsWith(' No clear scale.'));
  assert.equal(modelOf(loop(2, (c) => run(0, c, 1 / 12, CHROMATIC)), undefined).declared, null);
  assert.equal(buildJamModel({ position: atCps(dorianReading, 2.5) }).declared, null);
  assert.equal(modelOf(DRUMS).state, 'message');
  assert.equal('declared' in modelOf(DRUMS), false);
  const explicit = modelOf(TIE_PADS, { state: 'none' });
  assert.deepEqual(explicit, tied);
});

test('buildJamModel in declared mode: a tie says what the notes fit, with no verdict words anywhere', () => {
  const plain = modelOf(TIE_PADS);
  for (const declared of [scaleDeclared('C:major', { rootPc: 0, modeId: 'ionian' }), { state: 'unreadable', reason: 'empty', source: null }]) {
    const out = modelOf(TIE_PADS, declared);
    assert.equal(out.state, 'ready');
    assert.equal(out.scale.kind, 'ambiguous');
    assert.equal(out.scale.text, plain.scale.text.replace('No clear scale: the', 'The'));
    assert.ok(out.scale.text.startsWith('The notes fit ') && out.scale.text.endsWith(' equally.'));
    assert.equal(out.scale.title, out.scale.text);
    assert.equal(out.scale.sub, 'Warnings are off until the scale is clear.');
    assert.equal(out.instrument.pianoLabel, 'Piano, two octaves from C3. The heard scale is not clear.');
    assert.equal(out.instrument.guitarLabel, 'Guitar fretboard, standard tuning, 12 frets. The heard scale is not clear.');
    assert.deepEqual(allStrings(out).filter((text) => /no clear scale/i.test(text)), []);
    assert.deepEqual(out.degrees, plain.degrees);
    assert.deepEqual(out.status, plain.status);
    assert.deepEqual(out.rows, plain.rows);
  }
});

test('buildJamModel in declared mode: no fit says the notes fit none of the nine scales', () => {
  const events = loop(2, (c) => run(0, c, 1 / 12, CHROMATIC));
  const declared = scaleDeclared('D4:dorian', { rootPc: 2, modeId: 'dorian' });
  const out = modelOf(events, declared, 0.5);
  assert.equal(out.scale.text, 'The notes fit none of the nine scales.');
  assert.equal(out.scale.kind, 'ambiguous');
  assert.deepEqual(allStrings(out).filter((text) => /no clear scale/i.test(text)), []);
  assert.equal(out.declared.text, 'D Dorian');
});

test('buildJamModel in declared mode: nothing pitched is a ready model that keeps the Declared line', () => {
  const declared = scaleDeclared('D4:dorian', { rootPc: 2, modeId: 'dorian' });
  const out = modelOf(DRUMS, declared, 3);
  assert.equal(out.state, 'ready');
  assert.equal(out.scale.kind, 'none');
  assert.equal(out.scale.text, JAM_COPY.noPitched);
  assert.equal(out.scale.sub, JAM_COPY.noPitchedSub);
  assert.deepEqual(out.degrees, []);
  assert.equal(out.status.kind, 'off');
  assert.ok(out.instrument.roles.every((role) => role === 'off'));
  assert.equal(out.instrument.pianoLabel, `Piano, two octaves from C3. ${JAM_COPY.noPitched}`);
  assert.equal(out.instrument.guitarLabel, `Guitar fretboard, standard tuning, 12 frets. ${JAM_COPY.noPitched}`);
  assert.deepEqual(out.declared, { kind: 'scale', text: 'D Dorian', title: 'harmony = D4:dorian' });
  assert.deepEqual(allStrings(out).filter((text) => /no clear scale/i.test(text)), []);
  const unreadable = modelOf(DRUMS, { state: 'unreadable', reason: 'not-const', source: null }, 3);
  assert.equal(unreadable.state, 'ready');
  assert.equal(unreadable.declared.kind, 'unreadable');
});

test('buildJamModel: a declaration changes nothing that is heard for a clear scale', () => {
  const events = loop(4, (c) => [ev(1, c, c + 1, 'd2'), ...run(0, c, 0.125, DORIAN)]);
  const plain = modelOf(events, undefined, 2);
  const agree = modelOf(events, scaleDeclared('D4:dorian', { rootPc: 2, modeId: 'dorian' }), 2);
  const differ = modelOf(events, scaleDeclared('C:major', { rootPc: 0, modeId: 'ionian' }), 2);
  const chords = modelOf(events, { state: 'declared', kind: 'chords', text: '<Dm7 G7>', scale: null }, 2);
  const unreadable = modelOf(events, { state: 'unreadable', reason: 'computed', source: 'pick()' }, 2);
  const { declared: none, ...heard } = plain;
  assert.equal(none, null);
  for (const out of [agree, differ, chords, unreadable]) {
    const { declared, ...rest } = out;
    assert.notEqual(declared, null);
    assert.deepEqual(rest, heard);
  }
  assert.equal(agree.declared.text, agree.scale.text);
  assert.equal(differ.declared.text, 'C major');
  assert.equal(differ.scale.text, 'D Dorian');
  assert.deepEqual({ ...agree.declared, text: '', title: '' }, { ...differ.declared, text: '', title: '' });
});

// --- the section the Declared line follows ---

test('buildJamModel without an override and a section is today\'s model, with a section field of null', () => {
  const plain = modelOf(TIE_PADS, scaleDeclared('C:major', { rootPc: 0, modeId: 'ionian' }));
  assert.equal(plain.section, null);
  const { section, ...rest } = plain;
  const again = buildJamModel({ position: atCps(buildReading({ events: TIE_PADS, windowStart: 0, windowLength: 64, declared: scaleDeclared('C:major', { rootPc: 0, modeId: 'ionian' }) }), 1, 0.5), declaredOverride: undefined, section: null });
  assert.deepEqual(again, plain);
  assert.equal('section' in rest, false);
});

test('buildJamModel: a declared override replaces the declaration of the reading and a section names it', () => {
  const position = atCps(buildReading({ events: TIE_PADS, windowStart: 0, windowLength: 64, declared: scaleDeclared('C:major', { rootPc: 0, modeId: 'ionian' }) }), 1, 0.5);
  const out = buildJamModel({ position, declaredOverride: scaleDeclared('Eb:major', { rootPc: 3, modeId: 'ionian' }), section: "'y'" });
  assert.deepEqual(out.declared, { kind: 'scale', text: 'Eb major', title: 'harmony = Eb:major' });
  assert.equal(out.section, "section 'y'");
});

test('buildJamModel: a none override hides the Declared line and leaves declared mode', () => {
  const position = atCps(buildReading({ events: TIE_PADS, windowStart: 0, windowLength: 64, declared: scaleDeclared('C:major', { rootPc: 0, modeId: 'ionian' }) }), 1, 0.5);
  const out = buildJamModel({ position, declaredOverride: { state: 'none' }, section: "'x'" });
  assert.equal(out.declared, null);
  assert.ok(out.scale.text.startsWith('No clear scale: the notes fit '));
  assert.equal(out.section, "section 'x'");
});

test('buildJamModel: two sections with the same harmony give the same Declared line and only the name changes', () => {
  const position = atCps(buildReading({ events: TIE_PADS, windowStart: 0, windowLength: 64 }), 1, 0.5);
  const same = scaleDeclared('G:major', { rootPc: 7, modeId: 'ionian' });
  const first = buildJamModel({ position, declaredOverride: same, section: "'x'" });
  const second = buildJamModel({ position, declaredOverride: same, section: "'y'" });
  assert.deepEqual(first.declared, second.declared);
  assert.notEqual(first.section, second.section);
});

test('buildJamModel: an unreadable override says why in the usual sentence', () => {
  const position = atCps(buildReading({ events: TIE_PADS, windowStart: 0, windowLength: 64 }), 1, 0.5);
  const out = buildJamModel({ position, declaredOverride: { state: 'unreadable', reason: 'empty', source: null }, section: "'z'" });
  assert.equal(out.declared.kind, 'unreadable');
  assert.equal(out.declared.text, 'Not readable: harmony is empty.');
});
