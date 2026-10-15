// The line maths and the edits of a section launch, tested without a browser. Readings come from the real reader, so the
// shapes cannot drift; the lines and shifts are the ones measured in the real page for a piece of three sections (3, 5 and
// 7 cycles) at one cycle a second.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'acorn';
import { extractTracks } from '../page/tracks.js';
import { HELPER_TEXT, readStructure } from '../page/structure.js';
import { applyEdits } from '../page/mixer-rewrite.js';
import { MIN_TAKEOVER_LEAD_SECONDS } from '../page/change-timing.js';
import { SongEditRefusal, checkCell, checkSection, cellEdit, launchLine, launchShift, playResetEdit, quoteKey, sameShift, sectionEndLine, shiftEdit, shiftText, textAfterCanceledLaunch, unshiftedStarts } from '../page/song-edit.js';

const read = (code) => readStructure(code, { parse, tracks: extractTracks(code, { parse }) });

function piece({ shift = '0', sections = "[['x', 3], ['y', 5], ['z', 7]]", plan = "{ x: { t1: 'va' }, y: { t1: 'vb' }, z: { t1: 'va' } }" } = {}) {
  return [
    "const harmony = 'C3:major';",
    `const song = { shift: ${shift}, sections: ${sections}, plan: ${plan} };`,
    HELPER_TEXT,
    "const t1 = { va: note('c3'), vb: note('g3') };",
    "t1: play('t1', t1)",
  ].join('\n');
}

const STARTS = [0, 3, 8];
const base = { cps: 1, shift: 0, total: 15, starts: STARTS, minLeadSeconds: MIN_TAKEOVER_LEAD_SECONDS };

test('unshiftedStarts: the section starts without the shift, whole numbers, also for a fraction or a negative shift', () => {
  assert.deepEqual(unshiftedStarts(read(piece())), [0, 3, 8]);
  assert.deepEqual(unshiftedStarts(read(piece({ shift: '4' }))), [0, 3, 8]);
  assert.deepEqual(unshiftedStarts(read(piece({ shift: '-2.5' }))), [0, 3, 8]);
  assert.deepEqual(unshiftedStarts(read(piece({ shift: '0.1' }))), [0, 3, 8]);
});

test('sectionEndLine: the first section start ahead of the frontier by the minimum lead, as measured in the real page', () => {
  assert.equal(sectionEndLine({ ...base, frontier: 1.45 }), 3, 'playing x: the end of x');
  assert.equal(sectionEndLine({ ...base, frontier: 5.25 }), 8, 'playing y: the end of y');
  assert.equal(sectionEndLine({ ...base, frontier: 11.25 }), 15, 'playing z: the end of z is the start of the next pass');
  assert.equal(sectionEndLine({ ...base, frontier: 2.85 }), 8, 'the last 0.15 s of x: the end of the next section');
  assert.equal(sectionEndLine({ ...base, frontier: 7.95 }), 15, 'the last 0.05 s of y: the end of the next section');
  assert.equal(sectionEndLine({ ...base, frontier: 2.5 }), 3, 'exactly the minimum lead still counts');
  assert.equal(sectionEndLine({ ...base, frontier: 2.5000001 }), 8, 'a hair under it does not');
});

test('sectionEndLine: a shifted structure moves the lines, also a fractional or a negative shift and a frontier past several passes', () => {
  assert.equal(sectionEndLine({ ...base, shift: 4, frontier: 5 }), 7, 'x starts at 4, y at 7');
  assert.equal(sectionEndLine({ ...base, shift: 2.5, frontier: 3 }), 5.5);
  assert.equal(sectionEndLine({ ...base, shift: -2.5, frontier: 0 }), 0.5);
  assert.equal(sectionEndLine({ ...base, shift: 4, frontier: 47.2 }), 49, 'x of the fourth pass starts at 4 + 45');
  assert.equal(sectionEndLine({ ...base, frontier: -3.2 }), 0, 'a frontier before the first cycle');
  assert.equal(sectionEndLine({ ...base, frontier: -12.2 }), -7, 'a frontier two passes back');
});

test('sectionEndLine: a single section ends at its own length, pass after pass', () => {
  const one = { ...base, total: 4, starts: [0] };
  assert.equal(sectionEndLine({ ...one, frontier: 1.2 }), 4);
  assert.equal(sectionEndLine({ ...one, frontier: 3.7 }), 8);
});

test('sectionEndLine: an argument that is not usable is a loud error', () => {
  for (const [name, over] of [
    ['frontier', { frontier: Number.NaN }],
    ['frontier text', { frontier: '1' }],
    ['tempo', { frontier: 1, cps: 0 }],
    ['shift', { frontier: 1, shift: Number.POSITIVE_INFINITY }],
    ['total', { frontier: 1, total: 0 }],
    ['minimum lead', { frontier: 1, minLeadSeconds: Number.NaN }],
    ['starts missing', { frontier: 1, starts: [] }],
    ['starts descending', { frontier: 1, starts: [3, 0] }],
    ['a start that is not a number', { frontier: 1, starts: [0, Number.NaN] }],
  ]) {
    assert.throws(() => sectionEndLine({ ...base, ...over }), /^Error: Moontide: /, name);
  }
  assert.throws(() => sectionEndLine({ ...base, frontier: 1, minLeadSeconds: 1e9 }), /^Error: Moontide: no section line was found/);
});

test('launchLine: the three kinds give their line and their word', () => {
  const reading = read(piece());
  const args = { frontier: 2.75, cps: 1, reading, minLeadSeconds: MIN_TAKEOVER_LEAD_SECONDS };
  assert.deepEqual(launchLine({ ...args, kind: 'bar' }), { line: 4, at: 'bar' });
  assert.deepEqual(launchLine({ ...args, kind: 'phrase' }), { line: 4, at: 'phrase' });
  assert.deepEqual(launchLine({ ...args, kind: 'section' }), { line: 8, at: 'section' }, 'only 0.25 s from the end of x, so the end of y');
  assert.deepEqual(launchLine({ ...args, kind: 'section', frontier: 1.75 }), { line: 3, at: 'section' });
  assert.deepEqual(launchLine({ ...args, kind: 'phrase', frontier: 4.75 }), { line: 8, at: 'phrase' });
  assert.deepEqual(launchLine({ ...args, kind: 'bar', frontier: 5.45 }), { line: 6, at: 'bar' });
  assert.deepEqual(launchLine({ ...args, kind: 'section', frontier: 2.85 }), { line: 8, at: 'section' });
  assert.ok(Object.isFrozen(launchLine({ ...args, kind: 'bar' })));
  assert.throws(() => launchLine({ ...args, kind: 'now' }), /^Error: Moontide: unknown launch choice 'now'/);
  assert.throws(() => launchLine({ ...args, kind: undefined }), /^Error: Moontide: /);
});

test('launchLine: the end of the section follows the shift that plays', () => {
  const reading = read(piece({ shift: '4' }));
  assert.deepEqual(launchLine({ kind: 'section', frontier: 5, cps: 1, reading, minLeadSeconds: 0.5 }), { line: 7, at: 'section' });
});

test('launchShift: the shift that puts the section on the line, as measured in the real page', () => {
  const reading = read(piece());
  assert.equal(launchShift(reading, 0, 4), 4, 'x at line 4');
  assert.equal(launchShift(reading, 1, 6), 3, 'y at line 6');
  assert.equal(launchShift(reading, 2, 9), 1, 'z at line 9');
  assert.equal(launchShift(reading, 2, 18), 10, 'z at line 18');
  assert.equal(launchShift(reading, 0, 8), 8, 'x at line 8');
  assert.equal(launchShift(reading, 1, 12), 9, 'y at line 12');
  assert.equal(launchShift(reading, 0, 0), 0, 'stopped: line 0');
  assert.equal(launchShift(reading, 2, 0), 7, 'stopped: z at line 0');
});

test('launchShift: the shift that plays does not matter, only the unshifted start of the section', () => {
  const reading = read(piece({ shift: '10' }));
  assert.equal(launchShift(reading, 1, 6), 3);
  assert.throws(() => launchShift(reading, 3, 6), /^Error: Moontide: /);
  assert.throws(() => launchShift(reading, -1, 6), /^Error: Moontide: /);
  assert.throws(() => launchShift(reading, 1.5, 6), /^Error: Moontide: /);
  assert.throws(() => launchShift(reading, 1, Number.NaN), /^Error: Moontide: /);
});

test('sameShift: equal positions modulo the total, with a little floating-point room', () => {
  assert.equal(sameShift(4, 4, 15), true);
  assert.equal(sameShift(4, 19, 15), true);
  assert.equal(sameShift(0, 15, 15), true);
  assert.equal(sameShift(-2.5, 12.5, 15), true);
  assert.equal(sameShift(0.1 + 0.2, 0.3, 15), true);
  assert.equal(sameShift(4, 5, 15), false);
  assert.equal(sameShift(4, 4.000001, 15), false);
  assert.equal(sameShift(14.99999999999, 0, 15), true);
  assert.throws(() => sameShift(1, 2, 0), /^Error: Moontide: /);
  assert.throws(() => sameShift(Number.NaN, 2, 15), /^Error: Moontide: /);
});

test('shiftText: a clean number literal for whole numbers, fractions and negative values', () => {
  assert.equal(shiftText(4), '4');
  assert.equal(shiftText(0), '0');
  assert.equal(shiftText(2.5), '2.5');
  assert.equal(shiftText(0.1 + 0.2), '0.3');
  assert.equal(shiftText(-2.5), '-2.5');
  assert.equal(shiftText(-0), '0');
  assert.equal(shiftText(-1e-12), '0', 'a negative that rounds to nothing is not "-0"');
  assert.equal(shiftText(1 / 3), '0.333333333');
  assert.equal(shiftText(100), '100');
  assert.equal(shiftText(10), '10', 'trailing zeros of a whole number stay');
  assert.throws(() => shiftText(Number.NaN), /^Error: Moontide: /);
  assert.throws(() => shiftText(Number.POSITIVE_INFINITY), /^Error: Moontide: /);
});

test('shiftEdit: replaces exactly the shift literal and the text reads back with the new shift', () => {
  for (const [written, value, text] of [
    ['0', 4, '4'],
    ['4', 11, '11'],
    ['11', 3, '3'],
    ['-2.5', 7.25, '7.25'],
    ['0.5', 0, '0'],
  ]) {
    const code = piece({ shift: written });
    const edits = shiftEdit(read(code), value);
    assert.equal(edits.length, 1);
    assert.equal(edits[0].insert, text);
    const next = applyEdits(code, edits);
    assert.equal(next, code.replace(`shift: ${written},`, `shift: ${text},`), 'only the literal changed');
    assert.equal(read(next).shift, value);
  }
});

test('shiftEdit: a reading without a range is a loud error', () => {
  assert.throws(() => shiftEdit({ sections: [] }, 3), /^Error: Moontide: /);
});

test('checkSection: null while the entry still has the name and length, else section-gone', () => {
  const reading = read(piece());
  assert.equal(checkSection(reading, { index: 1, name: 'y', length: 5 }), null);
  assert.equal(checkSection(reading, { index: 1, name: 'y', length: 6 }), 'section-gone', 'a changed length');
  assert.equal(checkSection(reading, { index: 1, name: 'q', length: 5 }), 'section-gone', 'a renamed entry');
  assert.equal(checkSection(reading, { index: 3, name: 'z', length: 7 }), 'section-gone', 'a removed entry');
  assert.equal(checkSection(reading, { index: 1, name: 'z', length: 7 }), 'section-gone', 'another section at that place');
});

test('a one-section song at the end of the section needs no code change', () => {
  const reading = read(piece({ sections: "[['x', 4]]", plan: "{ x: { t1: 'va' } }", shift: '1' }));
  const { line } = launchLine({ kind: 'section', frontier: 2.2, cps: 1, reading, minLeadSeconds: 0.5 });
  assert.equal(line, 5, 'the shifted structure restarts at 1 + 4');
  assert.equal(sameShift(launchShift(reading, 0, line), reading.shift, reading.total), true);
});

test('a launch to the section that comes next at the end of the section needs no code change', () => {
  const reading = read(piece({ shift: '4' }));
  // x starts at 4, y at 7: playing x at 5, the end of x is 7, and launching y there is what already happens.
  const { line } = launchLine({ kind: 'section', frontier: 5, cps: 1, reading, minLeadSeconds: 0.5 });
  assert.equal(line, 7);
  assert.equal(sameShift(launchShift(reading, 1, line), reading.shift, reading.total), true);
  assert.equal(sameShift(launchShift(reading, 2, line), reading.shift, reading.total), false);
});

test('playResetEdit: nothing to do with shift 0, otherwise one edit that writes 0 over the shift literal and nothing else', () => {
  for (const written of ['0', '-0', '0.0']) {
    assert.equal(playResetEdit(read(piece({ shift: written }))), null, `shift ${written}`);
  }
  for (const written of ['4', '-2.5', '0.5', '14.999999999', '15']) {
    const code = piece({ shift: written });
    const reading = read(code);
    const edits = playResetEdit(reading);
    assert.equal(edits.length, 1);
    assert.deepEqual(edits[0], { from: reading.shiftRange.start, to: reading.shiftRange.end, insert: '0' });
    const next = applyEdits(code, edits);
    assert.equal(next, code.replace(`shift: ${written},`, 'shift: 0,'), `only the literal of shift ${written} changed`);
    const after = read(next);
    assert.equal(after.state, 'read');
    assert.equal(after.shift, 0);
    assert.deepEqual(after.sections.map((section) => [section.name, section.length]), reading.sections.map((section) => [section.name, section.length]));
  }
});

test('playResetEdit: a reading without a range for a shift that is not 0 is a loud error', () => {
  assert.throws(() => playResetEdit({ shift: 4, sections: [] }), /^Error: Moontide: /);
  assert.equal(playResetEdit({ shift: 0, sections: [] }), null);
});

// ---- changing a cell ----

/** The helper piece with three tracks: t1 has variations va and vb, t2 is a degree variation, t3 a fixed one. */
function cellPiece({ sections = "[['x', 3], ['y', 5], ['z', 7]]", plan, variations = "va: note('c3'), vb: note('g3'), \'it\\\'s\': note('a3')" } = {}) {
  return [
    "const harmony = 'C3:major';",
    `const song = { shift: 0, sections: ${sections}, plan: ${plan ?? "{ x: { t1: 'va', t2: 'da' }, y: { t1: 'vb', t2: '-' }, z: { t1: 'va', t2: 'da' } }"} };`,
    HELPER_TEXT,
    `const t1 = { ${variations} };`,
    "const t2 = { da: (h) => n('0 2').scale(h) };",
    "t1: play('t1', t1)",
    "t2: play('t2', t2)",
  ].join('\n');
}

test('quoteKey: a plain name in single quotes, a quote and a backslash escaped, and the result reads back as the name', () => {
  assert.equal(quoteKey('vb'), "'vb'");
  assert.equal(quoteKey("it's"), "'it\\'s'");
  assert.equal(quoteKey('a\\b'), "'a\\\\b'");
  assert.equal(quoteKey("both ' and \\"), "'both \\' and \\\\'");
  for (const name of ["it's", 'a\\b', "x'\\'y", 'with space', 'caf\u00e9', '\ud83c\udfb5']) {
    const code = `const v = { ${quoteKey(name)}: 1 };`;
    const key = parse(code, { ecmaVersion: 'latest' }).body[0].declarations[0].init.properties[0].key.value;
    assert.equal(key, name, `${JSON.stringify(name)} round-trips`);
  }
});

test('quoteKey: a control character, a line or paragraph separator and the rest marker are refused with the same reason', () => {
  for (const name of ['a\nb', 'a\rb', 'a\u0007b', '\u0000', 'a\u007fb', 'a\u2028b', 'a\u2029b', '-']) {
    assert.throws(() => quoteKey(name), (err) => err instanceof SongEditRefusal && err.reason === 'name-unwritable' && /^Moontide: /.test(err.message), JSON.stringify(name));
  }
  assert.equal(quoteKey('--'), "'--'");
  assert.throws(() => quoteKey(3), /^Error: Moontide: /);
  assert.throws(() => new SongEditRefusal('nothing'), /^Error: Moontide: unknown song edit refusal/);
});

test('cellEdit: replaces only the plan string of one cell, and everything else reads back unchanged', () => {
  const code = cellPiece();
  const reading = read(code);
  const { edits, changed } = cellEdit(reading, { index: 1, track: 't1' }, { key: 'va' });
  assert.equal(changed, true);
  assert.equal(edits.length, 1);
  assert.equal(code.slice(edits[0].from, edits[0].to), "'vb'");
  const next = applyEdits(code, edits);
  assert.equal(next, code.replace("y: { t1: 'vb'", "y: { t1: 'va'"));
  const after = read(next);
  assert.equal(after.state, 'read');
  const cells = (r) => r.tracks.map((track) => track.cells.map((cell) => cell.key));
  assert.deepEqual(cells(after), [['va', 'va', 'va'], ['da', null, 'da']]);
  assert.deepEqual(after.tracks.map((track) => track.variations), reading.tracks.map((track) => track.variations));
  assert.equal(after.helper, 'canonical');
  assert.equal(after.shift, reading.shift);
});

test('cellEdit: a rest writes the rest literal, and a variation brings a rest cell back', () => {
  const code = cellPiece();
  const reading = read(code);
  const toRest = cellEdit(reading, { index: 0, track: 't1' }, { rest: true });
  assert.equal(toRest.changed, true);
  const restCode = applyEdits(code, toRest.edits);
  assert.equal(restCode, code.replace("x: { t1: 'va'", "x: { t1: '-'"));
  assert.equal(read(restCode).tracks[0].cells[0].kind, 'rest');
  const back = cellEdit(read(restCode), { index: 0, track: 't1' }, { key: 'vb' });
  assert.equal(applyEdits(restCode, back.edits), code.replace("x: { t1: 'va'", "x: { t1: 'vb'"));
});

test('cellEdit: choosing what the cell holds is no change and gives no edit, also for a rest', () => {
  const reading = read(cellPiece());
  assert.deepEqual(cellEdit(reading, { index: 1, track: 't1' }, { key: 'vb' }), { edits: [], changed: false });
  assert.deepEqual(cellEdit(reading, { index: 1, track: 't2' }, { rest: true }), { edits: [], changed: false });
});

test('cellEdit: a name with a quote is written escaped and reads back; an unwritable name is refused after the same-cell check', () => {
  const code = cellPiece();
  const reading = read(code);
  const quoted = cellEdit(reading, { index: 0, track: 't1' }, { key: "it's" });
  const next = applyEdits(code, quoted.edits);
  assert.equal(read(next).tracks[0].cells[0].key, "it's");
  assert.throws(() => cellEdit(reading, { index: 0, track: 't1' }, { key: 'a\nb' }), (err) => err instanceof SongEditRefusal);
  assert.throws(() => cellEdit(reading, { index: 0, track: 't1' }, { key: '-' }), (err) => err instanceof SongEditRefusal);
});

test('cellEdit: loud errors for a track, a section or a choice the reading does not have', () => {
  const reading = read(cellPiece());
  assert.throws(() => cellEdit(reading, { index: 0, track: 'nope' }, { key: 'va' }), /^Error: Moontide: /);
  assert.throws(() => cellEdit(reading, { index: 9, track: 't1' }, { key: 'va' }), /^Error: Moontide: /);
  assert.throws(() => cellEdit(reading, { index: 0, track: 't1' }, {}), /^Error: Moontide: /);
  assert.throws(() => cellEdit(reading, { index: 0, track: 't1' }, null), /^Error: Moontide: /);
});

test('cellEdit: two entries of one section name share one cell, so one edit changes both columns', () => {
  const code = cellPiece({ sections: "[['p', 3], ['q', 5], ['p', 3]]", plan: "{ p: { t1: 'va', t2: 'da' }, q: { t1: 'vb', t2: 'da' } }" });
  const reading = read(code);
  const first = cellEdit(reading, { index: 0, track: 't1' }, { key: 'vb' });
  const third = cellEdit(reading, { index: 2, track: 't1' }, { key: 'vb' });
  assert.deepEqual(first.edits, third.edits, 'the same string either way');
  const after = read(applyEdits(code, first.edits));
  assert.deepEqual(after.tracks[0].cells.map((cell) => cell.key), ['vb', 'vb', 'vb']);
});

test('checkCell: still what the person saw gives null; each thing that changed gives its own id', () => {
  const reading = read(cellPiece());
  const seen = { index: 1, name: 'y', length: 5, track: 't1', key: 'vb' };
  assert.equal(checkCell(reading, seen, { key: 'va' }), null);
  assert.equal(checkCell(reading, seen, { rest: true }), null);
  assert.equal(checkCell(reading, { ...seen, name: 'q' }, { key: 'va' }), 'section-gone');
  assert.equal(checkCell(reading, { ...seen, length: 6 }, { key: 'va' }), 'section-gone');
  assert.equal(checkCell(reading, { ...seen, index: 7 }, { key: 'va' }), 'section-gone');
  assert.equal(checkCell(reading, { ...seen, track: 'nope' }, { key: 'va' }), 'cell-gone');
  assert.equal(checkCell(reading, { ...seen, key: 'va' }, { key: 'vb' }), 'cell-gone', 'the cell holds another variation than the one seen');
  assert.equal(checkCell(reading, { ...seen, key: null }, { key: 'va' }), 'cell-gone', 'a rest was seen, a variation is there');
  assert.equal(checkCell(reading, { index: 1, name: 'y', length: 5, track: 't2', key: null }, { key: 'da' }), null, 'a rest that is still a rest');
  assert.equal(checkCell(reading, seen, { key: 'gone' }), 'variation-gone');
});

test('textAfterCanceledLaunch: the playing code goes back only while the editor holds exactly the text the launch wrote', () => {
  const playing = piece({ shift: '0' });
  const launched = piece({ shift: '8' });
  assert.equal(textAfterCanceledLaunch({ editorCode: launched, launchCode: launched, playingCode: playing }), playing);
  // The person typed over the launch's text: nothing is replaced.
  assert.equal(textAfterCanceledLaunch({ editorCode: `// mine\n${launched}`, launchCode: launched, playingCode: playing }), null);
  assert.equal(textAfterCanceledLaunch({ editorCode: playing, launchCode: launched, playingCode: playing }), null, 'the editor already holds the playing code');
  // A launch that never recorded its text has nothing to put back.
  assert.equal(textAfterCanceledLaunch({ editorCode: launched, launchCode: null, playingCode: playing }), null);
  assert.throws(() => textAfterCanceledLaunch({ editorCode: undefined, launchCode: launched, playingCode: playing }), /needs the text of the editor/);
  assert.throws(() => textAfterCanceledLaunch({ editorCode: launched, launchCode: launched, playingCode: null }), /needs the text of the editor/);
});
