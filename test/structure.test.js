import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'acorn';
import { extractTracks } from '../page/tracks.js';
import * as harmonyModule from '../page/harmony.js';
import {
  HELPER_NAMES,
  HELPER_TEXT,
  SONG_COPY,
  SONG_REASONS,
  displayName,
  harmonyParts,
  helperLine,
  readStructure,
  songMessageText,
  songNoteLines,
} from '../page/structure.js';
import { TINT_WORDS, findWords } from './tint-rules.js';

const { readHarmony } = harmonyModule;
const readHarmonyText = (text) => harmonyModule.readHarmonyText(text);
const read = (code) => readStructure(code, { parse, tracks: extractTracks(code, { parse }) });

// A small structured piece with placeholder names; a test replaces the part it is about.
const DEFAULTS = {
  kind: 'const',
  harmony: "const harmony = 'C3:major';",
  shift: '0',
  sections: "[['a', 2], ['b', 3, 'E3:minor'], ['c', 4]]",
  plan: "{ a: { u: 'p', v: 'p' }, b: { u: 'q', v: '-' }, c: { u: 'p', v: 'r' } }",
  groups: "{ low: ['u'], high: { top: ['v'] } }",
  helper: HELPER_TEXT,
  tracks: "const u = { p: note('c3'), q: note('d3') };\nconst v = { p: (h) => n('0 2').scale(h), r: ['D3:dorian', note('d4')] };",
  statements: "u: play('u', u).postgain(0.5)\nv: play('v', v)",
};

function piece(over = {}) {
  const o = { ...DEFAULTS, ...over };
  const entries = [];
  if (o.shift !== null) entries.push(`shift: ${o.shift}`);
  entries.push(`sections: ${o.sections}`);
  if (o.groups !== null) entries.push(`groups: ${o.groups}`);
  if (o.plan !== null) entries.push(`plan: ${o.plan}`);
  const song = `${o.kind} song = { ${entries.join(', ')} };`;
  return [o.harmony, song, o.helper, o.tracks, o.statements].filter((part) => part !== null && part !== '').join('\n');
}

test('every track built by play() has the range of its own variation const, and the public record keeps it', () => {
  const code = piece();
  const reading = read(code);
  assert.equal(reading.state, 'read');
  const slices = reading.tracks.map((track) => code.slice(track.constRange.start, track.constRange.end));
  assert.deepEqual(slices, ["{ p: note('c3'), q: note('d3') }", "{ p: (h) => n('0 2').scale(h), r: ['D3:dorian', note('d4')] }"]);
  assert.ok(reading.tracks.every((track) => Object.keys(track.constRange).sort().join() === 'end,start'));
});

test('the helper names and the canonical helper text are the documented ones', () => {
  assert.deepEqual(HELPER_NAMES, ['total', 'clock', 'play']);
  // Written out here (not imported) so any change of the helper is a deliberate, visible test change.
  assert.equal(
    HELPER_TEXT,
    [
      'const total = song.sections.reduce((a, [, n]) => a + n, 0);',
      'const clock = timeCat(...song.sections.map(([name, n]) => [n, pure(name)])).slow(total).late(song.shift);',
      'const play = (track, variations) => {',
      '  const cells = {};',
      '  for (const [name, , own] of song.sections) {',
      '    const key = (song.plan[name] || {})[track];',
      "    if (key === undefined) throw new Error('song: section ' + name + ' has no cell for track ' + track);",
      "    const v = key === '-' ? silence : variations[key];",
      "    if (v === undefined) throw new Error('song: section ' + name + ', track ' + track + ': no variation ' + key + ' (it has ' + Object.keys(variations).join(', ') + ')');",
      "    cells[name] = typeof v === 'function' ? v(own || harmony) : Array.isArray(v) ? v[1] : v;",
      '  }',
      '  return clock.pickRestart(cells);',
      '};',
    ].join('\n'),
  );
});

test('none: code without a song, and a song that is not an object while the code binds no play', () => {
  for (const code of [
    '',
    'lead: note("c3")',
    "const song = 'x'\nlead: note(\"c3\")",
    "const song = ['x']\nlead: note(\"c3\")",
    "let song = 'x'\nlead: note(\"c3\")",
    "function f() { const song = { a: 1 } }\nlead: note(\"c3\")",
    'const play = 1\nlead: note("c3")',
  ]) {
    assert.deepEqual(read(code), { state: 'none' }, code);
  }
});

test('none: an object named song that holds none of sections, plan and shift is just a constant, not a declaration', () => {
  for (const code of [
    "const song = { tempo: 90, key: 'C' };\nlead: note(\"c3\")",
    "const song = {};\nlead: note(\"c3\")",
    "const song = { ...other, ['sections']: 1 };\nlead: note(\"c3\")",
  ]) {
    assert.deepEqual(read(code), { state: 'none' }, code);
  }
});

test('a song object with a key of a declaration, or any song next to a top-level play, is still a declaration', () => {
  for (const key of ['sections: []', "'plan': {}", 'shift: 0']) {
    assert.equal(read(`const song = { ${key} };\nlead: note("c3")`).state, 'unreadable', key);
  }
  assert.equal(read("const song = { tempo: 90 };\nconst play = 1;\nlead: note(\"c3\")").reason, 'no-sections');
});

test('a piece with a song object and the canonical helper is read: sections, starts, groups, tracks and cells', () => {
  const code = piece({ shift: '4' });
  const reading = read(code);
  assert.equal(reading.state, 'read');
  assert.equal(reading.helper, 'canonical');
  assert.equal(reading.shift, 4);
  assert.equal(reading.total, 9);
  assert.deepEqual(reading.pieceHarmony, { state: 'declared', text: 'C3:major' });
  assert.deepEqual(reading.sections, [
    { name: 'a', length: 2, start: 4, ownHarmony: null, harmony: { from: 'piece', text: 'C3:major' } },
    { name: 'b', length: 3, start: 6, ownHarmony: 'E3:minor', harmony: { from: 'own', text: 'E3:minor' } },
    { name: 'c', length: 4, start: 9, ownHarmony: null, harmony: { from: 'piece', text: 'C3:major' } },
  ]);
  assert.deepEqual(
    reading.tracks.map(({ name, label, index, constName, muted }) => ({ name, label, index, constName, muted })),
    [
      { name: 'u', label: 'u', index: 0, constName: 'u', muted: false },
      { name: 'v', label: 'v', index: 1, constName: 'v', muted: false },
    ],
  );
  // Each cell range slices the exact plan string out of the code; a rest is a range too.
  const withoutRange = (cells) => cells.map(({ range, ...cell }) => cell);
  const slices = (cells) => cells.map((cell) => code.slice(cell.range.start, cell.range.end));
  assert.deepEqual(withoutRange(reading.tracks[0].cells), [
    { section: 0, key: 'p', kind: 'other', fixedHarmony: null },
    { section: 1, key: 'q', kind: 'other', fixedHarmony: null },
    { section: 2, key: 'p', kind: 'other', fixedHarmony: null },
  ]);
  assert.deepEqual(slices(reading.tracks[0].cells), ["'p'", "'q'", "'p'"]);
  assert.deepEqual(withoutRange(reading.tracks[1].cells), [
    { section: 0, key: 'p', kind: 'degrees', fixedHarmony: null },
    { section: 1, key: null, kind: 'rest', fixedHarmony: null },
    { section: 2, key: 'r', kind: 'fixed', fixedHarmony: 'D3:dorian' },
  ]);
  assert.deepEqual(slices(reading.tracks[1].cells), ["'p'", "'-'", "'r'"]);
  assert.deepEqual(reading.groups, [
    { name: 'low', items: [{ track: 'u' }] },
    { name: 'high', items: [{ group: { name: 'top', items: [{ track: 'v' }] } }] },
  ]);
  assert.deepEqual(reading.ungrouped, []);
});

test('the shift range slices the shift value out of the code, a leading minus included', () => {
  for (const shift of ['4', '0', '-3', '2.5', '-2.5']) {
    const code = piece({ shift });
    const { shiftRange } = read(code);
    assert.equal(code.slice(shiftRange.start, shiftRange.end), shift, shift);
  }
});

test('every variation of a track is listed in code order, used or not, with its kind and fixed harmony', () => {
  const reading = read(piece());
  assert.deepEqual(reading.tracks[0].variations, [
    { key: 'p', kind: 'other', fixedHarmony: null },
    { key: 'q', kind: 'other', fixedHarmony: null },
  ]);
  assert.deepEqual(reading.tracks[1].variations, [
    { key: 'p', kind: 'degrees', fixedHarmony: null },
    { key: 'r', kind: 'fixed', fixedHarmony: 'D3:dorian' },
  ]);
  const unused = read(piece({ tracks: "const u = { p: note('c3'), q: note('d3'), spare: note('e3') };\nconst v = { p: (h) => n('0 2').scale(h), r: ['D3:dorian', note('d4')] };" }));
  assert.deepEqual(unused.tracks[0].variations.map((variation) => variation.key), ['p', 'q', 'spare']);
});

test('entries that share a section name share the cell range of each track', () => {
  const abPlan = "{ a: { u: 'p', v: 'p' }, b: { u: 'q', v: '-' } }";
  const code = piece({ sections: "[['a', 2], ['b', 1], ['a', 2]]", plan: abPlan });
  const reading = read(code);
  assert.equal(reading.state, 'read');
  const [first, second, third] = reading.tracks[0].cells;
  assert.deepEqual(first.range, third.range);
  assert.notDeepEqual(first.range, second.range);
  assert.equal(code.slice(second.range.start, second.range.end), "'q'");
});

test('tracks in no group and statements without play() are listed after the groups, in code order', () => {
  const reading = read(piece({ groups: null, statements: "u: play('u', u)\nextra: note('c4')\nv: play('v', v)" }));
  assert.equal(reading.state, 'read');
  assert.deepEqual(reading.groups, []);
  assert.deepEqual(reading.ungrouped, [
    { name: 'u', index: 0, structured: true },
    { name: 'extra', index: 1, structured: false },
    { name: 'v', index: 2, structured: true },
  ]);
});

test('a length written as arithmetic gives a reason that names the section and quotes the length', () => {
  const reading = read(piece({ sections: "[['a', 2], ['b', 1 + 2], ['c', 4]]" }));
  assert.equal(reading.state, 'unreadable');
  assert.equal(reading.reason, 'length-not-plain-number');
  assert.equal(reading.section, 'b');
  assert.equal(reading.source, '1 + 2');
  assert.equal(reading.helper, 'canonical');
  assert.equal(songMessageText(reading), "Parts can't read this song: the length of section 'b' is not a plain number (1 + 2).");
});

test('the helper is reported as changed when one character of a helper statement changes, and as missing when the three statements are gone', () => {
  const changed = HELPER_TEXT.replace('silence : variations[key]', 'silence : variations[key] || silence');
  assert.notEqual(changed, HELPER_TEXT);
  assert.equal(read(piece({ helper: changed })).helper, 'changed');
  assert.equal(read(piece({ helper: HELPER_TEXT.replace('late(song.shift)', 'late(0)') })).helper, 'changed');
  assert.equal(read(piece({ helper: HELPER_TEXT.replaceAll('  ', '    ') })).helper, 'canonical', 'whitespace runs count as one space');
  assert.equal(read(piece({ helper: '' })).helper, 'missing');
  assert.equal(read(piece({ helper: HELPER_TEXT.split('\n')[0] })).helper, 'changed', 'one statement alone is not the helper');
});

test('the helper lines and the note lines are the page sentences', () => {
  assert.equal(helperLine('canonical'), null);
  assert.equal(helperLine('changed'), 'The play() helper was changed, so the page cannot vouch for what plays.');
  assert.equal(helperLine('missing'), 'The play() helper is missing, so the page cannot vouch for what plays.');
  assert.throws(() => helperLine('odd'), /unknown helper state/);
  assert.deepEqual(songNoteLines(read(piece())), []);
  assert.deepEqual(songNoteLines(read(piece({ helper: '' }))), [SONG_COPY.helperMissing]);
  assert.deepEqual(songNoteLines({ state: 'none' }), []);
  const unreadable = read(piece({ sections: "[['a', 1 + 1]]" }));
  assert.deepEqual(songNoteLines(unreadable), [songMessageText(unreadable)]);
});

test('an unknown reason id throws, and songMessageText refuses a reading that is not unreadable', () => {
  const base = { state: 'unreadable', section: null, track: null, group: null, variation: null, source: null, helper: 'canonical' };
  assert.throws(() => songMessageText({ ...base, reason: 'no-such-reason' }), /unknown song reason 'no-such-reason'/);
  assert.throws(() => songMessageText({ state: 'none' }), /needs an unreadable song reading/);
  assert.throws(() => songMessageText({ ...base, reason: 'length-not-plain-number', section: 'a' }), /needs a value for 'source'/);
});

test('every reason id has a clause and the ids are the keys of the copy', () => {
  assert.deepEqual([...SONG_REASONS], Object.keys(SONG_COPY.reasons));
  assert.ok(Object.isFrozen(SONG_REASONS));
  for (const id of SONG_REASONS) assert.equal(typeof SONG_COPY.reasons[id], 'string', id);
});

test('a name shown in a sentence has hidden characters replaced by a space and is cut at 40 code points', () => {
  assert.equal(displayName('a\nb c‮d'), 'a b c d');
  assert.equal(displayName('x'.repeat(40)), 'x'.repeat(40));
  assert.equal(displayName('x'.repeat(41)), `${'x'.repeat(39)}…`);
  assert.equal([...displayName('😀'.repeat(60))].length, 40);
});

// ---- every shape the page cannot read: one reason id, one clause ----

const NO_FIELDS = { section: null, track: null, group: null, variation: null, source: null };

/** [reason id, code, the fields the reading carries besides state, reason and helper]. */
const REASON_CASES = [
  ['song-not-const', piece({ kind: 'let' }), {}],
  ['song-not-object', `const song = 'x';\n${HELPER_TEXT}`, { source: "'x'" }],
  ['no-sections', piece({ sections: '[]' }), {}],
  ['section-not-entry', piece({ sections: "[['a', 2], 'b']" }), { section: 2, source: "'b'" }],
  ['section-name-not-text', piece({ sections: '[["a", 2]]' }), { section: 1, source: '"a"' }],
  ['section-name-empty', piece({ sections: "[['', 2]]" }), { section: 1 }],
  ['length-not-plain-number', piece({ sections: "[['a', 1 + 1]]" }), { section: 'a', source: '1 + 1' }],
  ['length-not-whole', piece({ sections: "[['a', 2.5]]" }), { section: 'a', source: '2.5' }],
  ['length-not-above-zero', piece({ sections: "[['a', 0]]" }), { section: 'a', source: '0' }],
  ['total-too-long', piece({ sections: "[['a', 9007199254740991], ['b', 1]]" }), { section: 'b' }],
  ['section-harmony-unreadable', piece({ sections: "[['a', 2, 'banana']]" }), { section: 'a', source: "'banana'" }],
  ['section-repeated-harmony', piece({ sections: "[['a', 2, 'E3:minor'], ['b', 1], ['a', 2]]" }), { section: 'a' }],
  ['shift-missing', piece({ shift: null }), {}],
  ['shift-not-number', piece({ shift: '1 + 1' }), { source: '1 + 1' }],
  ['plan-missing', piece({ plan: null }), {}],
  ['plan-unknown-section', piece({ plan: "{ a: { u: 'p', v: 'p' }, zz: { u: 'p' } }" }), { source: 'zz' }],
  ['plan-unknown-track', piece({ plan: "{ a: { u: 'p', v: 'p', ghost: 'p' } }" }), { track: 'ghost' }],
  ['cell-missing', piece({ plan: "{ a: { u: 'p', v: 'p' }, b: { u: 'q' }, c: { u: 'p', v: 'r' } }" }), { section: 'b', track: 'v' }],
  ['cell-not-text', piece({ plan: "{ a: { u: 5, v: 'p' } }" }), { section: 'a', track: 'u', source: '5' }],
  ['cell-unknown-variation', piece({ plan: "{ a: { u: 'zz', v: 'p' } }" }), { section: 'a', track: 'u', source: "'zz'" }],
  ['variations-unreadable', piece({ tracks: "const u = make();\nconst v = { p: note('c3') };", plan: "{ a: { u: 'p', v: 'p' } }" }), { track: 'u', source: 'make()' }],
  ['label-mismatch', piece({ statements: "u: play('w', u)\nv: play('v', v)" }), { track: 'u', source: "'w'" }],
  ['groups-not-data', piece({ groups: '[1]' }), { source: '[1]' }],
  ['group-unknown-track', piece({ groups: "{ low: ['ghost'] }" }), { group: 'low', track: 'ghost' }],
  ['key-not-plain', piece({ plan: '{ [key]: { u: "p" } }' }), { source: '[key]: { u: "p" }' }],
  ['duplicate-key', piece({ plan: "{ a: { u: 'p', v: 'p' }, a: { u: 'q' } }" }), { source: 'a' }],
  ['name-inherited', piece({ sections: "[['toString', 2]]" }), { source: "'toString'" }],
  ['play-call-unreadable', piece({ statements: "u: play(u)\nv: play('v', v)" }), { track: 'u', source: 'play(u)' }],
  ['track-repeated', piece({ statements: "u: play('u', u)\n_u: play('u', u)\nv: play('v', v)" }), { track: 'u' }],
  ['groups-duplicate-track', piece({ groups: "{ low: ['u'], high: ['u'] }" }), { track: 'u' }],
  ['groups-duplicate-group', piece({ groups: "{ top: [{ sub: ['u'] }, { sub: ['v'] }] }" }), { group: 'sub' }],
  [
    'fixed-not-pair',
    piece({ tracks: "const u = { p: note('c3'), q: note('d3') };\nconst v = { p: ['D3:dorian', note('d4'), 1], r: note('e3') };" }),
    { variation: 'p', track: 'v', source: "['D3:dorian', note('d4'), 1]" },
  ],
  [
    'fixed-harmony-unreadable',
    piece({ tracks: "const u = { p: note('c3'), q: note('d3') };\nconst v = { p: ['banana', note('d4')], r: note('e3') };" }),
    { variation: 'p', track: 'v', source: "'banana'" },
  ],
  ['degrees-without-harmony', piece({ harmony: '' }), { section: 'a', track: 'v', variation: 'p' }],
  [
    'variation-kind-unknown',
    piece({ tracks: "const fn = (h) => n('0').scale(h);\nconst u = { p: note('c3'), q: note('d3') };\nconst v = { p: fn, r: note('e3') };" }),
    { variation: 'p', track: 'v', source: 'fn' },
  ],
];

test('the reason ids are the documented ones, and each has a case below', () => {
  assert.deepEqual([...SONG_REASONS].sort(), REASON_CASES.map(([id]) => id).sort());
  assert.equal(new Set(REASON_CASES.map(([id]) => id)).size, REASON_CASES.length, 'one case per id');
  assert.ok(SONG_REASONS.length >= 31);
});

test('every reason id gives its reading: the fields, the helper state and a sentence that fills without a gap', () => {
  for (const [id, code, fields] of REASON_CASES) {
    const reading = read(code);
    assert.deepEqual(reading, { state: 'unreadable', reason: id, ...NO_FIELDS, helper: 'canonical', ...fields }, id);
    const sentence = songMessageText(reading);
    assert.ok(sentence.startsWith("Parts can't read this song: ") && sentence.endsWith('.'), sentence);
    assert.doesNotMatch(sentence, /\{\w+\}|undefined|null/, `${id}: ${sentence}`);
  }
});

test('a missing cell is named by its section and its track, never read as a rest', () => {
  const reading = read(piece({ plan: "{ a: { u: 'p', v: 'p' }, b: { u: 'q' }, c: { u: 'p', v: 'r' } }" }));
  assert.equal(songMessageText(reading), "Parts can't read this song: section 'b' has no cell for track 'v'.");
  assert.equal(read(piece({ plan: '{}' })).reason, 'cell-missing');
});

test('the sentences quote names in single quotes and use the position of an entry whose name cannot be read', () => {
  assert.equal(
    songMessageText(read(piece({ sections: "[['a', 2], 'b']" }))),
    "Parts can't read this song: section 2 is not a name and a length written out in the code ('b').",
  );
  assert.equal(
    songMessageText(read(piece({ sections: "[['a', 2.5]]" }))),
    "Parts can't read this song: the length of section 'a' is not a whole number (2.5).",
  );
  assert.equal(
    songMessageText(read(piece({ groups: "{ low: ['ghost'] }" }))),
    "Parts can't read this song: group 'low' lists 'ghost', which has no labeled statement.",
  );
});

test('the first problem in the fixed scan order is the only one shown', () => {
  // A bad length (sections) comes before a missing shift, a missing plan and a bad statement.
  assert.equal(read(piece({ sections: "[['a', 1 + 1]]", shift: null, plan: null, statements: 'u: play(u)' })).reason, 'length-not-plain-number');
  assert.equal(read(piece({ shift: null, plan: null, statements: 'u: play(u)' })).reason, 'shift-missing');
  assert.equal(read(piece({ plan: null, groups: '[1]', statements: 'u: play(u)' })).reason, 'plan-missing');
  assert.equal(read(piece({ groups: '[1]', statements: 'u: play(u)' })).reason, 'groups-not-data');
  assert.equal(read(piece({ statements: 'u: play(u)', tracks: 'const u = make();' })).reason, 'play-call-unreadable');
  assert.equal(read(piece({ tracks: "const u = make();\nconst v = { p: note('c3') };" })).reason, 'variations-unreadable');
});

test('a length may be a negative or fractional shift but never a length below one, fractional or beyond the safe integers', () => {
  assert.equal(read(piece({ shift: '-3' })).shift, -3);
  assert.equal(read(piece({ shift: '2.5' })).shift, 2.5);
  assert.equal(read(piece({ shift: '-2.5' })).sections[0].start, -2.5);
  assert.equal(read(piece({ sections: "[['a', -2]]" })).reason, 'length-not-above-zero');
  assert.equal(read(piece({ sections: "[['a', 1e400]]" })).reason, 'length-not-whole');
  assert.equal(read(piece({ shift: '1e400' })).reason, 'shift-not-number');
});

test('zero sections gives the no-sections reason; one section is a valid list of one', () => {
  assert.equal(read(piece({ sections: '[]' })).reason, 'no-sections');
  const one = read(piece({ sections: "[['solo', 1]]", plan: "{ solo: { u: 'p', v: '-' } }", groups: null }));
  assert.equal(one.state, 'read');
  assert.equal(one.sections.length, 1);
  assert.equal(one.total, 1);
  assert.equal(one.tracks[0].cells.length, 1);
});

test('a section name used twice is valid with the same harmony and refused with different ones', () => {
  const abPlan = "{ a: { u: 'p', v: 'p' }, b: { u: 'q', v: '-' } }";
  const same = read(piece({ sections: "[['a', 2, 'E3:minor'], ['b', 1], ['a', 2, 'E3:minor']]", plan: abPlan }));
  assert.equal(same.state, 'read');
  assert.deepEqual(same.sections.map((section) => [section.name, section.start]), [['a', 0], ['b', 2], ['a', 3]]);
  assert.equal(same.tracks[0].cells.length, 3);
  assert.equal(read(piece({ sections: "[['a', 2], ['b', 1], ['a', 2]]", plan: abPlan })).state, 'read');
  assert.equal(read(piece({ sections: "[['a', 2, 'E3:minor'], ['a', 2]]" })).reason, 'section-repeated-harmony');
  assert.equal(read(piece({ sections: "[['a', 2], ['a', 2, 'E3:minor']]" })).reason, 'section-repeated-harmony');
});

test('names every object inherits are refused as names, whatever the place', () => {
  for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
    assert.equal(read(piece({ sections: `[['${name}', 2]]` })).reason, 'name-inherited', name);
  }
  assert.equal(read(piece({ plan: "{ a: { toString: 'p' } }" })).reason, 'name-inherited');
  assert.equal(read(piece({ tracks: "const u = { constructor: note('c3') };\nconst v = { p: note('c3') };" })).reason, 'name-inherited');
});

test('a name written twice in one object gives duplicate-key, a computed or double-quoted name key-not-plain', () => {
  assert.equal(read(piece({ tracks: "const u = { p: note('c3'), p: note('d3') };\nconst v = { p: note('c3') };" })).reason, 'duplicate-key');
  assert.equal(read(piece({ plan: '{ "a": { u: "p" } }' })).reason, 'key-not-plain');
  assert.equal(read(piece({ plan: "{ a: { ['u']: 'p' } }" })).reason, 'key-not-plain');
  assert.equal(read(piece({ plan: "{ ...other }" })).reason, 'key-not-plain');
  assert.equal(read(piece({ plan: "{ 'a': { 'u': 'p', 'v': 'p' }, b: { u: 'p', v: 'p' }, c: { u: 'p', v: 'p' } }" })).state, 'read', 'single-quoted names are plain');
});

test('a mute or solo marker on a label is not a label mismatch, and a $ statement skips the comparison', () => {
  assert.equal(read(piece({ statements: "_u: play('u', u)\nv: play('v', v)" })).state, 'read');
  assert.equal(read(piece({ statements: "S_u: play('u', u)\nv: play('v', v)" })).state, 'read');
  assert.equal(read(piece({ statements: "u: play('u', u)\n$: play('v', v)" })).state, 'read');
  const muted = read(piece({ statements: "_u: play('u', u)\nv: play('v', v)" }));
  assert.equal(muted.tracks[0].muted, true);
  assert.equal(muted.tracks[0].label, '_u');
  assert.equal(muted.tracks[0].name, 'u');
  assert.equal(read(piece({ statements: "u: play('t2', u)\nv: play('v', v)" })).reason, 'label-mismatch');
  assert.equal(read(piece({ statements: "u: play('u', u)\n$: play('u', u)\nv: play('v', v)" })).reason, 'track-repeated');
});

test('groups nest to any depth and may mix track names and group objects; a track can be listed once', () => {
  const deep = Array.from({ length: 10 }, (_, i) => `g${i}`);
  const nested = deep.reduceRight((inner, name) => `{ ${name}: ${inner} }`, "['u']");
  const reading = read(piece({ groups: nested }));
  assert.equal(reading.state, 'read');
  let node = reading.groups[0];
  for (let i = 1; i < 10; i++) {
    assert.equal(node.name, `g${i - 1}`);
    node = node.items[0].group;
  }
  assert.deepEqual(node, { name: 'g9', items: [{ track: 'u' }] });
  const mixed = read(piece({ groups: "{ top: ['u', { inner: ['v'] }] }" }));
  assert.deepEqual(mixed.groups, [{ name: 'top', items: [{ track: 'u' }, { group: { name: 'inner', items: [{ track: 'v' }] } }] }]);
  assert.deepEqual(read(piece({ groups: '{}' })).groups, []);
  assert.equal(read(piece({ groups: "{ a: ['u'], b: { c: ['u'] } }" })).reason, 'groups-duplicate-track');
});

test('two groups with the same name side by side are refused, the same name in different places is read', () => {
  const twice = read(piece({ groups: "{ top: [{ sub: ['u'] }, { sub: ['v'] }] }" }));
  assert.equal(twice.state, 'unreadable');
  assert.equal(twice.reason, 'groups-duplicate-group');
  assert.equal(twice.group, 'sub');
  assert.match(songMessageText(twice), /two groups named 'sub' side by side/);
  assert.equal(read(piece({ groups: "{ top: [{ sub: ['u'] }, 'v', { sub: ['x'] }] }" })).reason, 'groups-duplicate-group');
  const apart = read(piece({ groups: "{ a: { sub: ['u'] }, b: { sub: ['v'] } }" }));
  assert.equal(apart.state, 'read');
  assert.deepEqual(apart.groups.map((group) => group.items[0].group.name), ['sub', 'sub']);
});

test('a track whose cells are all rests reads, and a statement without play() is listed with no cells', () => {
  const rests = read(piece({ plan: "{ a: { u: '-', v: '-' }, b: { u: '-', v: '-' }, c: { u: '-', v: '-' } }" }));
  assert.equal(rests.state, 'read');
  assert.ok(rests.tracks.every((track) => track.cells.every((cell) => cell.kind === 'rest' && cell.key === null)));
  const plain = read(piece({ groups: null, statements: "u: play('u', u)\nv: play('v', v)\nextra: note('e4')" }));
  assert.deepEqual(plain.ungrouped.at(-1), { name: 'extra', index: 2, structured: false });
});

test('the harmony of a section is its own text, the piece text, none or not readable', () => {
  const kinds = (code) => read(code).sections.map((section) => section.harmony);
  assert.deepEqual(kinds(piece()), [
    { from: 'piece', text: 'C3:major' },
    { from: 'own', text: 'E3:minor' },
    { from: 'piece', text: 'C3:major' },
  ]);
  const none = read(piece({ harmony: '', tracks: "const u = { p: note('c3'), q: note('d3') };\nconst v = { p: note('c3'), r: ['D3:dorian', note('d4')] };" }));
  assert.deepEqual(none.sections.map((section) => section.harmony.from), ['none', 'own', 'none']);
  const unreadable = read(piece({ harmony: "const harmony = 'banana';" }));
  assert.equal(unreadable.state, 'read');
  assert.deepEqual(unreadable.sections.map((section) => section.harmony.from), ['piece-unreadable', 'own', 'piece-unreadable']);
  assert.equal(unreadable.pieceHarmony.state, 'unreadable');
  assert.equal(read(piece({ harmony: "const harmony = 'C3:major';" })).pieceHarmony.text, 'C3:major');
});

test('a variation is degrees for a function, fixed for a harmony and a pattern, other for anything else', () => {
  const cells = read(piece()).tracks[1].cells;
  assert.deepEqual(cells.map((cell) => cell.kind), ['degrees', 'rest', 'fixed']);
  const methods = read(
    piece({ tracks: "const u = { p: note('c3'), q: note('d3') };\nconst v = { p() { return n('0'); }, r: function (h) { return n('1'); } };" }),
  );
  assert.deepEqual(methods.tracks[1].cells.map((cell) => cell.kind), ['degrees', 'rest', 'degrees']);
});

test('a variation that is a name or an expression is refused, whatever it holds at run time; calls, quoted text and templates are patterns', () => {
  const withV = (value) => read(piece({ tracks: `const w = ${value};\nconst u = { p: note('c3'), q: note('d3') };\nconst v = { p: note('c3'), r: ${value} };` }));
  for (const value of ['w', 'other.p', 'flag ? note("c3") : w', 'w || note("c3")', 'await w']) {
    const reading = withV(value);
    assert.equal(reading.state, 'unreadable', value);
    assert.equal(reading.reason, 'variation-kind-unknown', value);
    assert.equal(reading.variation, 'r', value);
    assert.equal(reading.track, 'v', value);
    assert.equal(songMessageText(reading).startsWith("Parts can't read this song: variation 'r' of 'v' is a name or an expression"), true, value);
  }
  for (const value of ["note('c3')", "s('bd').slow(2)", '"c3 e3"', '`c3 e3`', "mini`c3`"]) {
    assert.equal(withV(value).state, 'read', value);
    assert.equal(withV(value).tracks[1].cells.find((cell) => cell.key === 'r')?.kind ?? 'other', 'other', value);
  }
  // A shorthand entry is a name too.
  const shorthand = read(piece({ tracks: "const fn = (h) => n('0').scale(h);\nconst u = { p: note('c3'), q: note('d3') };\nconst v = { p: note('c3'), fn };" }));
  assert.equal(shorthand.reason, 'variation-kind-unknown');
  assert.equal(shorthand.variation, 'fn');
});

test('names with hidden characters are shown with spaces in their place and cut at 40 code points', () => {
  const weird = read(piece({ sections: "[['a\\nb\\u2028c\\u202ed', 0]]" }));
  assert.equal(weird.section, 'a\nb c‮d');
  assert.equal(songMessageText(weird), "Parts can't read this song: the length of section 'a b c d' is not above zero (0).");
  const long = read(piece({ sections: `[['${'n'.repeat(50)}', 0]]` }));
  assert.equal(songMessageText(long), `Parts can't read this song: the length of section '${'n'.repeat(39)}…' is not above zero (0).`);
  const source = read(piece({ sections: "[['a', 1 + 1111111111111111111111111111111111111111111111111]]" }));
  assert.ok([...source.source].length <= 40 && source.source.endsWith('…'));
  assert.equal(displayName('abc'), 'abc');
});

test('a harmony in the list is cut at 60 code points with the whole text kept for the title', () => {
  const short = harmonyParts({ from: 'own', text: 'E3:minor' });
  assert.deepEqual(short, { text: 'harmony E3:minor', whole: null });
  const text = 'A'.repeat(61);
  const cut = harmonyParts({ from: 'own', text });
  assert.equal(cut.text, `harmony ${'A'.repeat(59)}…`);
  assert.equal(cut.whole, text);
  assert.equal(harmonyParts({ from: 'piece', text: 'C3:major' }).text, 'harmony C3:major (from the piece)');
  assert.equal(harmonyParts({ from: 'none', text: null }).text, 'no harmony declared');
  assert.equal(harmonyParts({ from: 'piece-unreadable', text: null }).text, 'harmony not readable');
});

test('the song copy holds no verdict word and no tint word', () => {
  const strings = [];
  const collect = (value) => {
    if (typeof value === 'string') strings.push(value);
    else for (const inner of Object.values(value)) collect(inner);
  };
  collect(SONG_COPY);
  for (const text of strings) {
    assert.doesNotMatch(text, /\b(wrong|error|errors|should|try|tries)\b/i, text);
    assert.deepEqual(findWords(text, TINT_WORDS), [], text);
  }
});

test('readHarmonyText classifies a harmony text as scale or chords and refuses anything else; readHarmony is unchanged', () => {
  assert.deepEqual(readHarmonyText('E3:minor'), { kind: 'scale', scale: { rootPc: 4, modeId: 'aeolian' } });
  assert.deepEqual(readHarmonyText('C:major'), { kind: 'scale', scale: { rootPc: 0, modeId: 'ionian' } });
  assert.deepEqual(readHarmonyText('Am'), { kind: 'chords', scale: null });
  assert.deepEqual(readHarmonyText('<Dm7 G7 C^7>'), { kind: 'chords', scale: null });
  assert.equal(readHarmonyText(''), null);
  assert.equal(readHarmonyText('   '), null);
  assert.equal(readHarmonyText('banana'), null);
  assert.equal(readHarmonyText('C3:major '.repeat(40)), null, 'over the longest declaration text');
  assert.deepEqual(readHarmony("const harmony = 'E3:minor'", { parse }), {
    state: 'declared',
    kind: 'scale',
    text: 'E3:minor',
    scale: { rootPc: 4, modeId: 'aeolian' },
  });
});
