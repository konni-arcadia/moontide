// The Scratchpad's pure model: the units and grids, the commands, the names the page reads out and the copy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  UNITS_PER_CYCLE,
  GRIDS,
  DEFAULT_GRID,
  DEFAULT_CYCLES,
  MIN_CYCLES,
  MAX_CYCLES,
  DEFAULT_VELOCITY,
  MIN_PITCH,
  MAX_PITCH,
  WINDOW_ROWS,
  MIN_WINDOW_START,
  MAX_WINDOW_START,
  EMPTY_WINDOW_START,
  SCRATCH_COPY,
  fillScratch,
  gridOf,
  emptyMotif,
  motifUnits,
  noteAt,
  toggleAt,
  noteName,
  isBlackKey,
  beatText,
  positionOf,
  lengthText,
  velocityText,
  noteParts,
  spokenNote,
  emptyCellParts,
  spokenEmptyCell,
  summaryLine,
  touchedNotes,
} from '../page/scratch-model.js';

test('a cycle is 48 units, and every grid step is a whole number of units', () => {
  assert.equal(UNITS_PER_CYCLE, 48);
  for (const grid of GRIDS) {
    assert.equal(grid.steps * grid.unit, UNITS_PER_CYCLE, grid.id);
  }
});

test('the five grids come in the page order with their words', () => {
  assert.deepEqual(
    GRIDS.map((grid) => [grid.id, grid.steps, grid.unit, grid.text, grid.name, grid.one, grid.many]),
    [
      ['quarter', 4, 12, 'Quarters', 'Quarter notes, 4 per cycle', 'quarter', 'quarters'],
      ['eighth', 8, 6, 'Eighths', 'Eighth notes, 8 per cycle', 'eighth', 'eighths'],
      ['sixteenth', 16, 3, 'Sixteenths', 'Sixteenth notes, 16 per cycle', 'sixteenth', 'sixteenths'],
      ['eighth-triplet', 12, 4, 'Eighth triplets', 'Eighth-note triplets, 12 per cycle', 'eighth triplet', 'eighth triplets'],
      ['sixteenth-triplet', 24, 2, 'Sixteenth triplets', 'Sixteenth-note triplets, 24 per cycle', 'sixteenth triplet', 'sixteenth triplets'],
    ],
  );
  assert.ok(Object.isFrozen(GRIDS));
  assert.ok(GRIDS.every((grid) => Object.isFrozen(grid)));
});

test('the constants of the roll', () => {
  assert.equal(DEFAULT_GRID, 'sixteenth');
  assert.equal(DEFAULT_CYCLES, 2);
  assert.equal(MIN_CYCLES, 1);
  assert.equal(MAX_CYCLES, 8);
  assert.equal(DEFAULT_VELOCITY, 80);
  assert.equal(MIN_PITCH, 12);
  assert.equal(MAX_PITCH, 119);
  assert.equal(WINDOW_ROWS, 24);
  assert.equal(MIN_WINDOW_START, 12);
  assert.equal(MAX_WINDOW_START, 96);
  assert.equal(EMPTY_WINDOW_START, 48);
  assert.equal(MAX_WINDOW_START + WINDOW_ROWS - 1, MAX_PITCH, 'the highest window ends on the highest pitch');
});

test('gridOf returns the grid and throws a loud error on an unknown id', () => {
  assert.equal(gridOf('eighth').steps, 8);
  assert.throws(() => gridOf('thirty-second'), /^Error: Moontide: unknown Scratchpad grid 'thirty-second'/);
});

test('the empty motif is frozen: two cycles on sixteenths and no notes', () => {
  const motif = emptyMotif();
  assert.deepEqual(motif, { cycles: 2, grid: 'sixteenth', notes: [], nextId: 1, source: null, recorded: null });
  assert.ok(Object.isFrozen(motif));
  assert.ok(Object.isFrozen(motif.notes));
  assert.equal(motifUnits(motif), 96);
});

test('toggleAt places a one-step note at the start of the grid step, at velocity 80', () => {
  const placed = toggleAt(emptyMotif(), { pitch: 60, unit: 4 });
  assert.deepEqual(placed.motif.notes, [{ id: 1, pitch: 60, start: 3, length: 3, velocity: 80 }]);
  assert.equal(placed.motif.nextId, 2);
  assert.equal(placed.notice, 'Placed C4 at cycle 1, beat 1.25.');
  assert.ok(Object.isFrozen(placed.motif));
  assert.ok(Object.isFrozen(placed.motif.notes));
  assert.ok(Object.isFrozen(placed.motif.notes[0]));
});

test('toggleAt uses the length of the grid step: a quarter is 12 units, an eighth triplet 4', () => {
  const quarter = toggleAt({ ...emptyMotif(), grid: 'quarter' }, { pitch: 60, unit: 30 });
  assert.deepEqual(quarter.motif.notes[0], { id: 1, pitch: 60, start: 24, length: 12, velocity: 80 });
  const triplet = toggleAt({ ...emptyMotif(), grid: 'eighth-triplet' }, { pitch: 60, unit: 7 });
  assert.deepEqual(triplet.motif.notes[0], { id: 1, pitch: 60, start: 4, length: 4, velocity: 80 });
  assert.equal(triplet.notice, 'Placed C4 at cycle 1, beat 1.33.');
});

test('toggleAt on a cell inside a note removes that note and says where it started', () => {
  const placed = toggleAt(emptyMotif(), { pitch: 60, unit: 0 }).motif;
  const longer = Object.freeze({ ...placed, notes: Object.freeze([Object.freeze({ ...placed.notes[0], length: 9 })]) });
  const erased = toggleAt(longer, { pitch: 60, unit: 8 });
  assert.deepEqual(erased.motif.notes, []);
  assert.equal(erased.notice, 'Erased C4 at cycle 1, beat 1. Undo brings it back.');
  assert.equal(erased.motif.nextId, longer.nextId, 'an erase takes no id');
});

test('toggleAt twice at the same cell places then removes, and a second pitch is independent', () => {
  const first = toggleAt(emptyMotif(), { pitch: 60, unit: 0 }).motif;
  const both = toggleAt(first, { pitch: 61, unit: 0 }).motif;
  assert.equal(both.notes.length, 2);
  const back = toggleAt(both, { pitch: 60, unit: 0 }).motif;
  assert.deepEqual(back.notes.map((note) => note.pitch), [61]);
});

test('toggleAt never changes its input', () => {
  const motif = emptyMotif();
  const before = JSON.stringify(motif);
  toggleAt(motif, { pitch: 60, unit: 0 });
  assert.equal(JSON.stringify(motif), before);
  assert.equal(motif.notes.length, 0);
});

test('toggleAt throws a loud error that names a bad pitch or unit', () => {
  const motif = emptyMotif();
  for (const pitch of [11, 120, 60.5, NaN, '60', undefined]) {
    assert.throws(() => toggleAt(motif, { pitch, unit: 0 }), /^Error: Moontide: a Scratchpad pitch must be a whole number from 12 to 119, got /, String(pitch));
  }
  for (const unit of [-1, 96, 1.5, NaN, undefined]) {
    assert.throws(() => toggleAt(motif, { pitch: 60, unit }), /^Error: Moontide: a Scratchpad position must be a whole number of units from 0 to 95, got /, String(unit));
  }
  assert.throws(() => toggleAt(motif, { pitch: 60, unit: 96 }), /got 96/);
});

test('noteAt finds the note whose span holds the unit, at that pitch only', () => {
  const motif = toggleAt(emptyMotif(), { pitch: 60, unit: 6 }).motif;
  assert.equal(noteAt(motif, 60, 6).id, 1);
  assert.equal(noteAt(motif, 60, 8).id, 1);
  assert.equal(noteAt(motif, 60, 9), null);
  assert.equal(noteAt(motif, 60, 5), null);
  assert.equal(noteAt(motif, 61, 6), null);
});

test('noteName uses sharps with C4 = 60', () => {
  assert.equal(noteName(60), 'C4');
  assert.equal(noteName(48), 'C3');
  assert.equal(noteName(61), 'C#4');
  assert.equal(noteName(12), 'C0');
  assert.equal(noteName(119), 'B8');
  assert.equal(noteName(69), 'A4');
  assert.throws(() => noteName(60.5), /^Error: Moontide: a note name needs a whole MIDI number/);
  assert.throws(() => noteName(128), /got 128/);
});

test('isBlackKey is true for the five sharps of an octave', () => {
  const black = [];
  for (let midi = 60; midi < 72; midi += 1) if (isBlackKey(midi)) black.push(noteName(midi));
  assert.deepEqual(black, ['C#4', 'D#4', 'F#4', 'G#4', 'A#4']);
});

test('beatText gives the beat with the part of the beat as up to two decimals', () => {
  assert.equal(beatText(0), '1');
  assert.equal(beatText(3), '1.25');
  assert.equal(beatText(6), '1.5');
  assert.equal(beatText(12), '2');
  assert.equal(beatText(4), '1.33');
  assert.equal(beatText(16), '2.33');
  assert.equal(beatText(2), '1.17');
  assert.equal(beatText(45), '4.75');
});

test('positionOf counts the cycle from 1', () => {
  assert.deepEqual(positionOf(0), { cycle: 1, beat: '1' });
  assert.deepEqual(positionOf(47), { cycle: 1, beat: '4.92' });
  assert.deepEqual(positionOf(48), { cycle: 2, beat: '1' });
  assert.deepEqual(positionOf(51), { cycle: 2, beat: '1.25' });
});

test('a length reads in the grid words with the beats in brackets, except on quarters', () => {
  assert.equal(lengthText(3, 'sixteenth'), '1 sixteenth (0.25 beat)');
  assert.equal(lengthText(6, 'sixteenth'), '2 sixteenths (0.5 beat)');
  assert.equal(lengthText(18, 'sixteenth'), '6 sixteenths (1.5 beats)');
  assert.equal(lengthText(12, 'sixteenth'), '4 sixteenths (1 beat)');
  assert.equal(lengthText(12, 'quarter'), '1 quarter');
  assert.equal(lengthText(36, 'quarter'), '3 quarters');
  assert.equal(lengthText(12, 'eighth-triplet'), '3 eighth triplets (1 beat)');
  assert.equal(lengthText(4, 'eighth-triplet'), '1 eighth triplet (0.33 beat)');
  assert.equal(lengthText(2, 'sixteenth-triplet'), '1 sixteenth triplet (0.17 beat)');
});

test('a length that is not a whole number of steps reads in beats only', () => {
  assert.equal(lengthText(4, 'sixteenth'), '0.33 beat');
  assert.equal(lengthText(20, 'sixteenth'), '1.67 beats');
});

test('a velocity reads with two decimals', () => {
  assert.equal(velocityText(80), '0.80');
  assert.equal(velocityText(5), '0.05');
  assert.equal(velocityText(100), '1.00');
});

test('the note line, the spoken note, the empty cell and the summary read as the copy says', () => {
  const note = { id: 1, pitch: 64, start: 51, length: 6, velocity: 80 };
  assert.deepEqual(noteParts(note, 'sixteenth'), { name: 'E4', rest: ' · cycle 2, beat 1.25 · length 2 sixteenths (0.5 beat) · velocity 0.80' });
  assert.equal(spokenNote(note, 'sixteenth'), 'E4, starts at cycle 2, beat 1.25, lasts 2 sixteenths (0.5 beat), velocity 0.80.');
  assert.deepEqual(emptyCellParts(64, 51), { name: 'E4', rest: ' · cycle 2, beat 1.25 · empty' });
  assert.equal(spokenEmptyCell(64, 51), 'Row E4, cycle 2, beat 1.25, empty');
  const triplet = { id: 2, pitch: 61, start: 4, length: 4, velocity: 100 };
  assert.equal(spokenNote(triplet, 'eighth-triplet'), 'C#4, starts at cycle 1, beat 1.33, lasts 1 eighth triplet (0.33 beat), velocity 1.00.');
});

test('summaryLine counts notes and cycles and names the grid in plural', () => {
  const motif = emptyMotif();
  assert.equal(summaryLine({ ...motif, notes: [{}, {}, {}, {}, {}, {}] }), '6 notes in 2 cycles on sixteenths.');
  assert.equal(summaryLine({ ...motif, cycles: 1, grid: 'quarter', notes: [{}] }), '1 note in 1 cycle on quarters.');
  assert.equal(summaryLine({ ...motif, cycles: 8, grid: 'sixteenth-triplet', notes: [{}, {}] }), '2 notes in 8 cycles on sixteenth triplets.');
});

test('fillScratch fills slots and throws when a value is missing', () => {
  assert.equal(fillScratch('Placed {name} at {cycle}.', { name: 'C4', cycle: 2 }), 'Placed C4 at 2.');
  assert.throws(() => fillScratch('Placed {name} at {cycle}.', { name: 'C4' }), /^Error: Moontide: the Scratchpad copy has no value for \{cycle\}/);
});

test('the copy is frozen and holds the empty state, the hint and the notices in plain words', () => {
  assert.ok(Object.isFrozen(SCRATCH_COPY));
  assert.equal(SCRATCH_COPY.emptyHeading, 'No notes yet');
    assert.equal(SCRATCH_COPY.hintDraw, 'Draw is on: drag to write a note. Turn it off to select by dragging.');
  assert.deepEqual([SCRATCH_COPY.modeGroup, SCRATCH_COPY.draw, SCRATCH_COPY.drawName, SCRATCH_COPY.drawOn, SCRATCH_COPY.drawOff], ['Mode', 'Draw', 'Draw notes with a drag', 'Draw is on.', 'Draw is off.']);
  assert.match(SCRATCH_COPY.drawTitle, /key d/);
  assert.equal(fillScratch(SCRATCH_COPY.placed, { name: 'E4', cycle: 1, beat: '2.25' }), 'Placed E4 at cycle 1, beat 2.25.');
  assert.equal(fillScratch(SCRATCH_COPY.erased, { name: 'C4', cycle: 2, beat: '3' }), 'Erased C4 at cycle 2, beat 3. Undo brings it back.');
});

// --- Commands: the nearest step, place, move, resize and erase, and the same-pitch rule ---
// A namespace import: a command that is missing fails inside its own test, not at module load.
import * as model from '../page/scratch-model.js';

/** A frozen motif of two cycles on sixteenths holding exactly these notes (id, pitch, start, length, velocity). */
function motifWith(...notes) {
  const frozen = notes.map(([id, pitch, start, length, velocity = 80]) => Object.freeze({ id, pitch, start, length, velocity }));
  return Object.freeze({ cycles: 2, grid: 'sixteenth', notes: Object.freeze(frozen), nextId: Math.max(0, ...notes.map((note) => note[0])) + 1 });
}
const plain = (motif) => motif.notes.map((note) => [note.id, note.pitch, note.start, note.length, note.velocity]);

test('a placement that merges away changes nothing: the same motif and an empty what, so no history step', () => {
  const motif = motifWith([1, 60, 6, 3, 80]);
  const placed = model.placeNote(motif, { pitch: 60, start: 6, length: 3 });
  assert.equal(placed.motif, motif);
  assert.equal(placed.what, '');
  assert.equal(placed.note.id, 1);
  assert.equal(placed.merged, 1);
  assert.equal(placed.notice, 'Placed C4 at cycle 1, beat 1.5. Merged with the note there (same pitch in the same cell).');
  const history = model.createHistory(motif);
  assert.equal(model.commit(history, placed), history);
  const real = model.placeNote(motif, { pitch: 62, start: 6, length: 3 });
  assert.equal(real.what, 'placed D4');
  assert.equal(real.motif.nextId, motif.nextId + 1, 'a real placement still takes the next id');
});

test('a tap that merges away into a note that stays adds no history step either', () => {
  // t = 1500 is cycle 4.25, which is unit 12 of the motif: the second pass over a note already there.
  const motif = motifWith([1, 60, 12, 3, 80]);
  const tapped = model.tapNote(motif, { ts: 1500, h: 1500, anchors: { a: { c: 4, t: 1000 }, b: { c: 5, t: 3000 } }, pitch: 60 });
  assert.equal(tapped.motif, motif);
  assert.equal(tapped.what, '');
  assert.match(tapped.notice, /^Tapped C4 at cycle 1, beat 2\. Merged with the note there/);
  const history = model.createHistory(motif);
  assert.equal(model.commit(history, tapped), history);
});

test('nearestStep rounds to the nearest step and a tie goes to the earlier step', () => {
  assert.equal(model.nearestStep(6, 12), 0);
  assert.equal(model.nearestStep(7, 12), 1);
  assert.equal(model.nearestStep(3, 2), 1);
  assert.equal(model.nearestStep(18, 12), 1);
  assert.equal(model.nearestStep(0, 12), 0);
  assert.equal(model.nearestStep(12, 12), 1);
  assert.equal(model.nearestStep(5, 3), 2);
});

test('placeNote places a note of the given length at velocity 80 unless one is given', () => {
  const placed = model.placeNote(emptyMotif(), { pitch: 64, start: 6, length: 9 });
  assert.deepEqual(plain(placed.motif), [[1, 64, 6, 9, 80]]);
  assert.equal(placed.notice, 'Placed E4 at cycle 1, beat 1.5.');
  assert.deepEqual([placed.cut, placed.merged], [0, 0]);
  assert.deepEqual(placed.note, { id: 1, pitch: 64, start: 6, length: 9, velocity: 80 });
  assert.equal(placed.motif.nextId, 2);
  const loud = model.placeNote(emptyMotif(), { pitch: 64, start: 0, length: 3, velocity: 100 });
  assert.equal(loud.motif.notes[0].velocity, 100);
});

test('placeNote throws on a start off the grid, a length below one step or past the end, and a bad pitch or velocity', () => {
  const motif = emptyMotif();
  const place = (change) => () => model.placeNote(motif, { pitch: 60, start: 0, length: 3, ...change });
  assert.throws(place({ start: 1 }), /^Error: Moontide: .*start.*got 1/);
  assert.throws(place({ start: -3 }), /got -3/);
  assert.throws(place({ start: 96 }), /got 96/);
  assert.throws(place({ length: 0 }), /^Error: Moontide: .*length.*got 0/);
  assert.throws(place({ length: 2 }), /got 2/);
  assert.throws(place({ length: 4 }), /got 4/);
  assert.throws(place({ start: 93, length: 6 }), /^Error: Moontide: .*past the end/);
  assert.throws(place({ pitch: 11 }), /a Scratchpad pitch/);
  assert.throws(place({ velocity: 0 }), /^Error: Moontide: .*velocity.*got 0/);
  assert.throws(place({ velocity: 101 }), /got 101/);
  assert.throws(place({ velocity: 0.5 }), /got 0.5/);
});

test('moveNote keeps the length and holds the start inside the motif and the pitch from 12 to 119', () => {
  const motif = motifWith([1, 60, 6, 9]);
  const moved = model.moveNote(motif, 1, { start: 30, pitch: 64 });
  assert.deepEqual(plain(moved.motif), [[1, 64, 30, 9, 80]]);
  assert.equal(moved.notice, 'Moved C4 to E4 at cycle 1, beat 3.5.');
  assert.deepEqual(moved.note, { id: 1, pitch: 64, start: 30, length: 9, velocity: 80 });
  assert.equal(model.moveNote(motif, 1, { start: 30 }).notice, 'Moved C4 to cycle 1, beat 3.5.');
  assert.deepEqual(plain(model.moveNote(motif, 1, { start: 999 }).motif), [[1, 60, 87, 9, 80]]);
  assert.deepEqual(plain(model.moveNote(motif, 1, { start: -30 }).motif), [[1, 60, 0, 9, 80]]);
  assert.deepEqual(plain(model.moveNote(motif, 1, { pitch: 500 }).motif), [[1, 119, 6, 9, 80]]);
  assert.deepEqual(plain(model.moveNote(motif, 1, { pitch: -5 }).motif), [[1, 12, 6, 9, 80]]);
});

test('moveNote to the place the note already holds returns the same motif and no notice', () => {
  const motif = motifWith([1, 60, 0, 9]);
  const same = model.moveNote(motif, 1, { start: -12 });
  assert.equal(same.motif, motif);
  assert.equal(same.notice, '');
  assert.equal(model.moveNote(motif, 1, {}).motif, motif);
});

test('moveNote, resizeNote and eraseNote throw a loud error on an unknown id and on values that are not whole', () => {
  const motif = motifWith([1, 60, 6, 9]);
  assert.throws(() => model.moveNote(motif, 9, { start: 0 }), /^Error: Moontide: .*no note with id 9/);
  assert.throws(() => model.resizeNote(motif, 9, 3), /no note with id 9/);
  assert.throws(() => model.eraseNote(motif, 9), /no note with id 9/);
  assert.throws(() => model.moveNote(motif, 1, { start: 1.5 }), /^Error: Moontide: .*start.*got 1.5/);
  assert.throws(() => model.moveNote(motif, 1, { start: 4 }), /got 4/);
  assert.throws(() => model.moveNote(motif, 1, { pitch: 60.5 }), /a Scratchpad pitch/);
  assert.throws(() => model.moveNote(motif, 1, { start: NaN }), /got NaN/);
  assert.throws(() => model.resizeNote(motif, 1, 4.5), /^Error: Moontide: .*length.*got 4.5/);
  assert.throws(() => model.resizeNote(motif, 1, 4), /got 4/);
});

test('resizeNote gives at least one grid step and at most the motif end, and says how long the note lasts', () => {
  const motif = motifWith([1, 60, 6, 9]);
  const longer = model.resizeNote(motif, 1, 12);
  assert.deepEqual(plain(longer.motif), [[1, 60, 6, 12, 80]]);
  assert.equal(longer.notice, 'C4 now lasts 4 sixteenths (1 beat).');
  assert.deepEqual(plain(model.resizeNote(motif, 1, 0).motif), [[1, 60, 6, 3, 80]]);
  assert.deepEqual(plain(model.resizeNote(motif, 1, -9).motif), [[1, 60, 6, 3, 80]]);
  assert.deepEqual(plain(model.resizeNote(motif, 1, 999).motif), [[1, 60, 6, 90, 80]]);
  const same = model.resizeNote(motif, 1, 9);
  assert.equal(same.motif, motif);
  assert.equal(same.notice, '');
});

test('eraseNote removes the note by id and says where it started', () => {
  const motif = motifWith([1, 60, 0, 3], [2, 62, 51, 6]);
  const erased = model.eraseNote(motif, 2);
  assert.deepEqual(plain(erased.motif), [[1, 60, 0, 3, 80]]);
  assert.equal(erased.notice, 'Erased D4 at cycle 2, beat 1.25. Undo brings it back.');
  assert.equal(erased.note, null);
  assert.equal(erased.motif.nextId, motif.nextId);
});

test('no command changes its input', () => {
  const motif = motifWith([1, 60, 0, 12], [2, 60, 30, 3]);
  const before = JSON.stringify(motif);
  model.placeNote(motif, { pitch: 60, start: 6, length: 3 });
  model.moveNote(motif, 2, { start: 3 });
  model.resizeNote(motif, 1, 36);
  model.eraseNote(motif, 1);
  assert.equal(JSON.stringify(motif), before);
});

test('a note placed inside an earlier note of the same pitch cuts the earlier note at the new start', () => {
  const motif = motifWith([1, 60, 0, 12]);
  const placed = model.placeNote(motif, { pitch: 60, start: 6, length: 3 });
  assert.deepEqual(plain(placed.motif), [[1, 60, 0, 6, 80], [2, 60, 6, 3, 80]]);
  assert.deepEqual([placed.cut, placed.merged], [1, 0]);
  assert.equal(placed.notice, 'Placed C4 at cycle 1, beat 1.5. 1 note cut where a note of the same pitch starts.');
  const other = model.placeNote(motif, { pitch: 61, start: 6, length: 3 });
  assert.deepEqual(plain(other.motif), [[1, 60, 0, 12, 80], [2, 61, 6, 3, 80]], 'another pitch is left alone');
  assert.deepEqual([other.cut, other.merged], [0, 0]);
});

test('a note whose length would reach a later onset of the same pitch ends there', () => {
  const motif = motifWith([1, 60, 12, 3]);
  const placed = model.placeNote(motif, { pitch: 60, start: 6, length: 12 });
  assert.deepEqual(plain(placed.motif), [[1, 60, 12, 3, 80], [2, 60, 6, 6, 80]]);
  assert.deepEqual([placed.cut, placed.merged], [1, 0]);
  assert.equal(placed.note.length, 6);
});

test('a length change stops at the next onset of the same pitch and says so, even when nothing grows', () => {
  const motif = motifWith([1, 60, 0, 3], [2, 60, 12, 3], [3, 61, 6, 3]);
  const grown = model.resizeNote(motif, 1, 30);
  assert.deepEqual(plain(grown.motif), [[1, 60, 0, 12, 80], [2, 60, 12, 3, 80], [3, 61, 6, 3, 80]]);
  assert.equal(grown.cut, 1);
  assert.equal(grown.notice, 'C4 now lasts 4 sixteenths (1 beat). 1 note cut where a note of the same pitch starts.');
  const stuck = model.resizeNote(grown.motif, 1, 30);
  assert.equal(stuck.motif, grown.motif, 'the note already ends at the onset');
  assert.equal(stuck.notice, 'C4 now lasts 4 sixteenths (1 beat). 1 note cut where a note of the same pitch starts.');
});

test('two notes of the same pitch at the same start merge into the stronger one with its length', () => {
  const motif = motifWith([1, 60, 6, 3, 50]);
  const stronger = model.placeNote(motif, { pitch: 60, start: 6, length: 6, velocity: 90 });
  assert.deepEqual(plain(stronger.motif), [[2, 60, 6, 6, 90]]);
  assert.deepEqual([stronger.cut, stronger.merged], [0, 1]);
  assert.equal(stronger.notice, 'Placed C4 at cycle 1, beat 1.5. Merged with the note there (same pitch in the same cell).');
  assert.equal(stronger.note.id, 2);
  const weaker = model.placeNote(motif, { pitch: 60, start: 6, length: 6, velocity: 30 });
  assert.deepEqual(plain(weaker.motif), [[1, 60, 6, 3, 50]]);
  assert.equal(weaker.note.id, 1, 'the surviving note is reported');
  const tie = model.placeNote(motif, { pitch: 60, start: 6, length: 6, velocity: 50 });
  assert.deepEqual(plain(tie.motif), [[1, 60, 6, 3, 50]], 'on a tie the older note stays');
});

test('a move onto the start of a same-pitch note merges them, and a move into its span cuts it', () => {
  const merge = model.moveNote(motifWith([1, 60, 6, 3, 50], [2, 61, 6, 3, 70]), 2, { pitch: 60 });
  assert.deepEqual(plain(merge.motif), [[2, 60, 6, 3, 70]]);
  assert.deepEqual([merge.cut, merge.merged], [0, 1]);
  assert.equal(merge.notice, 'Moved C#4 to C4 at cycle 1, beat 1.5. Merged with the note there (same pitch in the same cell).');
  const cut = model.moveNote(motifWith([1, 60, 0, 12], [2, 61, 30, 3]), 2, { pitch: 60, start: 6 });
  assert.deepEqual(plain(cut.motif), [[1, 60, 0, 6, 80], [2, 60, 6, 3, 80]]);
  assert.equal(cut.cut, 1);
  assert.equal(cut.notice, 'Moved C#4 to C4 at cycle 1, beat 1.5. 1 note cut where a note of the same pitch starts.');
});

test('the cut suffix is plural when two notes are cut by one command', () => {
  const motif = motifWith([1, 60, 0, 12], [2, 60, 18, 3]);
  const placed = model.placeNote(motif, { pitch: 60, start: 6, length: 30 });
  assert.deepEqual(plain(placed.motif), [[1, 60, 0, 6, 80], [2, 60, 18, 3, 80], [3, 60, 6, 12, 80]]);
  assert.equal(placed.cut, 2);
  assert.equal(placed.notice, 'Placed C4 at cycle 1, beat 1.5. 2 notes cut where a note of the same pitch starts.');
});

test('toggleAt reports no cut and no merge, and the note it placed', () => {
  const placed = toggleAt(emptyMotif(), { pitch: 60, unit: 0 });
  assert.deepEqual([placed.cut, placed.merged], [0, 0]);
  assert.deepEqual(placed.note, { id: 1, pitch: 60, start: 0, length: 3, velocity: 80 });
  const erased = toggleAt(placed.motif, { pitch: 60, unit: 0 });
  assert.equal(erased.note, null);
});

test('windowStartFor starts at C3 when empty, else at the C at or below the lowest note, held from 12 to 96', () => {
  assert.equal(model.windowStartFor(emptyMotif()), 48);
  assert.equal(model.windowStartFor(motifWith([1, 45, 0, 3])), 36, 'lowest A2');
  assert.equal(model.windowStartFor(motifWith([1, 60, 0, 3], [2, 72, 0, 3])), 60);
  assert.equal(model.windowStartFor(motifWith([1, 48, 0, 3])), 48);
  assert.equal(model.windowStartFor(motifWith([1, 12, 0, 3])), 12);
  assert.equal(model.windowStartFor(motifWith([1, 14, 0, 3])), 12);
  assert.equal(model.windowStartFor(motifWith([1, 119, 0, 3])), 96, 'lowest B8');
});

test('the move, length, no-note, cut and merged lines are in the copy', () => {
  assert.equal(SCRATCH_COPY.noNote, 'No note here. Move the cursor onto a note, or press Enter to place one.');
  assert.equal(fillScratch(SCRATCH_COPY.moved, { name: 'C4', cycle: 1, beat: '2' }), 'Moved C4 to cycle 1, beat 2.');
  assert.equal(fillScratch(SCRATCH_COPY.movedPitch, { from: 'C4', name: 'D4', cycle: 1, beat: '2' }), 'Moved C4 to D4 at cycle 1, beat 2.');
  assert.equal(fillScratch(SCRATCH_COPY.lasts, { name: 'C4', length: '1 quarter' }), 'C4 now lasts 1 quarter.');
  assert.equal(SCRATCH_COPY.merged, ' Merged with the note there (same pitch in the same cell).');
});

test('a note on a triplet grid reads its beat with two decimals', () => {
  const placed = model.placeNote({ ...emptyMotif(), grid: 'eighth-triplet' }, { pitch: 61, start: 16, length: 8 });
  assert.equal(placed.notice, 'Placed C#4 at cycle 1, beat 2.33.');
  assert.equal(spokenNote(placed.note, 'eighth-triplet'), 'C#4, starts at cycle 1, beat 2.33, lasts 2 eighth triplets (0.67 beat), velocity 0.80.');
});

// --- The grid, the length of the motif and the pitch window ---

test('setGrid moves each start to the nearest step (a tie to the earlier) and each length to the nearest whole step (a tie down, one step at least)', () => {
  const quarters = model.setGrid(motifWith([1, 60, 3, 3], [2, 62, 6, 6], [3, 64, 9, 18], [4, 65, 30, 24]), 'quarter');
  assert.equal(quarters.motif.grid, 'quarter');
  assert.deepEqual(plain(quarters.motif), [[1, 60, 0, 12, 80], [2, 62, 0, 12, 80], [3, 64, 12, 12, 80], [4, 65, 24, 24, 80]]);
});

test('a length that is exactly between two steps goes down, and a short one is held to one step', () => {
  const eighths = model.setGrid(motifWith([1, 60, 0, 9], [2, 62, 12, 3]), 'eighth');
  assert.deepEqual(plain(eighths.motif), [[1, 60, 0, 6, 80], [2, 62, 12, 6, 80]]);
});

test('a start that rounds to the end of the motif wraps to step 0, as a tap does', () => {
  const quarters = model.setGrid(motifWith([1, 60, 93, 3]), 'quarter');
  assert.deepEqual(plain(quarters.motif), [[1, 60, 0, 12, 80]]);
  const oneCycle = model.setGrid({ ...motifWith([1, 60, 45, 3]), cycles: 1 }, 'quarter');
  assert.deepEqual(plain(oneCycle.motif), [[1, 60, 0, 12, 80]]);
});

test('two notes of one pitch that land in one cell merge into the stronger, the older on a tie', () => {
  const stronger = model.setGrid(motifWith([1, 60, 3, 3, 50], [2, 60, 6, 3, 90], [3, 62, 3, 3, 70]), 'quarter');
  assert.deepEqual(plain(stronger.motif), [[2, 60, 0, 12, 90], [3, 62, 0, 12, 70]]);
  assert.equal(stronger.merged, 1);
  const tie = model.setGrid(motifWith([1, 60, 3, 6, 70], [2, 60, 6, 9, 70]), 'quarter');
  assert.deepEqual(plain(tie.motif), [[1, 60, 0, 12, 70]]);
  assert.equal(tie.merged, 1);
});

test('a length that now reaches a later note of the same pitch is cut where that note starts', () => {
  const done = model.setGrid(motifWith([1, 60, 0, 9], [2, 60, 9, 3]), 'eighth');
  assert.deepEqual(plain(done.motif), [[1, 60, 0, 6, 80], [2, 60, 6, 6, 80]]);
  const longer = model.setGrid(motifWith([1, 60, 0, 20], [2, 60, 15, 3]), 'quarter');
  assert.deepEqual(plain(longer.motif), [[1, 60, 0, 12, 80], [2, 60, 12, 12, 80]]);
  assert.equal(longer.cut, 1);
  assert.match(longer.notice, / 1 note cut where a note of the same pitch starts\.?$/);
});

test('the grid notice says how many notes moved and merged', () => {
  const some = model.setGrid(motifWith([1, 60, 3, 3], [2, 62, 6, 3], [3, 64, 7, 3], [4, 65, 9, 3], [5, 67, 12, 12]), 'quarter');
  assert.equal(some.notice, 'Grid: quarters. 4 notes moved onto it.');
  const merged = model.setGrid(motifWith([1, 60, 3, 3], [2, 60, 6, 3], [3, 62, 3, 3], [4, 62, 5, 3], [5, 64, 9, 3]), 'quarter');
  assert.equal(merged.notice, 'Grid: quarters. 5 notes moved onto it, 2 merged (same pitch in the same cell).');
  const one = model.setGrid(motifWith([1, 60, 3, 3], [2, 62, 12, 12]), 'quarter');
  assert.equal(one.notice, 'Grid: quarters. 1 note moved onto it.');
  const none = model.setGrid(emptyMotif(), 'eighth');
  assert.equal(none.notice, 'Grid: eighths.');
  assert.equal(none.motif.grid, 'eighth');
  const alreadyOn = model.setGrid(motifWith([1, 60, 0, 6]), 'eighth');
  assert.equal(alreadyOn.notice, 'Grid: eighths.');
});

test('choosing the grid in use changes nothing: the same motif and an empty notice', () => {
  const motif = motifWith([1, 60, 3, 3]);
  const same = model.setGrid(motif, 'sixteenth');
  assert.equal(same.motif, motif);
  assert.equal(same.notice, '');
  assert.throws(() => model.setGrid(motif, 'fifth'), /unknown Scratchpad grid 'fifth'/);
});

test('every grid change is exact: sixteenths to sixteenth triplets and back gives whole units', () => {
  const motif = motifWith([1, 60, 3, 3], [2, 62, 9, 6], [3, 64, 45, 9]);
  const triplets = model.setGrid(motif, 'sixteenth-triplet');
  for (const note of triplets.motif.notes) {
    assert.ok(Number.isInteger(note.start) && Number.isInteger(note.length), `note ${note.id}`);
    assert.equal(note.start % 2, 0);
    assert.equal(note.length % 2, 0);
  }
  const back = model.setGrid(triplets.motif, 'sixteenth');
  for (const note of back.motif.notes) {
    assert.equal(note.start % 3, 0);
    assert.equal(note.length % 3, 0);
  }
  assert.equal(back.motif.grid, 'sixteenth');
});

test('setGrid leaves the id counter and the other notes alone, and never changes its input', () => {
  const motif = motifWith([4, 60, 3, 3]);
  const done = model.setGrid(motif, 'quarter');
  assert.equal(done.motif.nextId, 5);
  assert.equal(motif.grid, 'sixteenth');
  assert.deepEqual(plain(motif), [[4, 60, 3, 3, 80]]);
  assert.ok(Object.isFrozen(done.motif) && Object.isFrozen(done.motif.notes));
});

test('setCycles takes a whole number from 1 to 8 and throws otherwise', () => {
  for (const bad of [0, 9, 1.5, -1, '3', NaN, undefined]) assert.throws(() => model.setCycles(emptyMotif(), bad), /Scratchpad cycles must be a whole number from 1 to 8/, String(bad));
});

test('more cycles keeps every note and says how long the motif is', () => {
  const motif = motifWith([1, 60, 0, 3]);
  const three = model.setCycles(motif, 3);
  assert.equal(three.motif.cycles, 3);
  assert.deepEqual(plain(three.motif), [[1, 60, 0, 3, 80]]);
  assert.equal(three.notice, 'Motif is now 3 cycles.');
  assert.equal(model.setCycles({ ...emptyMotif(), cycles: 3 }, 1).notice, 'Motif is now 1 cycle.');
});

test('the same number of cycles is no edit', () => {
  const motif = motifWith([1, 60, 0, 3]);
  const same = model.setCycles(motif, 2);
  assert.equal(same.motif, motif);
  assert.equal(same.notice, '');
});

test('fewer cycles is refused, loudly, while a note starts in the cycle that would go', () => {
  const one = model.setCycles({ ...motifWith([1, 60, 100, 3]), cycles: 3 }, 2);
  assert.equal(one.refused, 'Cycle 3 has 1 note. Erase or move them first.');
  assert.equal(one.motif.cycles, 3);
  assert.equal(one.notice, '');
  const two = model.setCycles({ ...motifWith([1, 60, 100, 3], [2, 62, 120, 3]), cycles: 3 }, 2);
  assert.equal(two.refused, 'Cycle 3 has 2 notes. Erase or move them first.');
  const first = model.setCycles({ ...motifWith([1, 60, 100, 3], [2, 62, 50, 3]), cycles: 3 }, 1);
  assert.equal(first.refused, 'Cycle 2 has 1 note. Erase or move them first.', 'the first cycle beyond the new end that holds a note');
});

test('fewer cycles cuts a note that runs into the cycle that goes, and says so', () => {
  const motif = motifWith([1, 60, 40, 20], [2, 62, 0, 3]);
  const one = model.setCycles(motif, 1);
  assert.equal(one.motif.cycles, 1);
  assert.deepEqual(plain(one.motif), [[1, 60, 40, 8, 80], [2, 62, 0, 3, 80]]);
  assert.equal(one.notice, 'Motif is now 1 cycle. 1 note was cut at the end.');
  assert.equal(one.cut, 1);
  const many = model.setCycles(motifWith([1, 60, 40, 20], [2, 62, 44, 20]), 1);
  assert.equal(many.notice, 'Motif is now 1 cycle. 2 notes were cut at the end.');
  const clean = model.setCycles(motifWith([1, 60, 0, 20]), 1);
  assert.equal(clean.notice, 'Motif is now 1 cycle.');
});

test('shownRows of an empty motif is the two-octave base, and a note inside the base does not widen it', () => {
  assert.deepEqual(model.shownRows(emptyMotif(), { base: 48 }), { low: 48, high: 71 });
  assert.deepEqual(model.shownRows(motifWith([1, 60, 0, 3]), { base: 48 }), { low: 48, high: 71 });
  assert.deepEqual(model.shownRows(motifWith([1, 69, 0, 3], [2, 50, 3, 3]), { base: 48 }), { low: 48, high: 71 }, 'A4 and D3 keep their margin inside the base');
  assert.deepEqual(model.shownRows(motifWith([1, 71, 0, 3]), { base: 48 }), { low: 48, high: 83 }, 'B4 has no room above it, so its margin reaches the next octave');
  assert.deepEqual(model.shownRows(emptyMotif(), { base: 12 }), { low: 12, high: 35 });
  assert.deepEqual(model.shownRows(emptyMotif(), { base: 96 }), { low: 96, high: 119 });
});

test('shownRows widens by each note with two semitones of margin, rounded out to whole octaves', () => {
  assert.deepEqual(model.shownRows(motifWith([1, 36, 0, 3], [2, 84, 3, 3]), { base: 36 }), { low: 24, high: 95 }, 'C2 and C6 with the base at C2 give C1 to B6');
  // A note on the second semitone of an octave is not far enough to reach the next one.
  assert.deepEqual(model.shownRows(motifWith([1, 72, 0, 3]), { base: 48 }), { low: 48, high: 83 }, 'C5 is two above B4, so the margin reaches C5 and its octave');
  assert.deepEqual(model.shownRows(motifWith([1, 69, 0, 3]), { base: 48 }), { low: 48, high: 71 }, 'A4 plus two is B4, still the base');
  assert.deepEqual(model.shownRows(motifWith([1, 70, 0, 3]), { base: 48 }), { low: 48, high: 83 }, 'A#4 plus two is C5');
  assert.deepEqual(model.shownRows(motifWith([1, 49, 0, 3]), { base: 48 }), { low: 36, high: 71 }, 'C#3 minus two is B2');
  assert.deepEqual(model.shownRows(motifWith([1, 50, 0, 3]), { base: 48 }), { low: 48, high: 71 }, 'D3 minus two is C3, still the base');
});

test('shownRows is held to C0 and B8', () => {
  assert.deepEqual(model.shownRows(motifWith([1, 12, 0, 3]), { base: 12 }), { low: 12, high: 35 }, 'a note at C0 gives a low end of C0');
  assert.deepEqual(model.shownRows(motifWith([1, 13, 0, 3]), { base: 48 }), { low: 12, high: 71 });
  assert.deepEqual(model.shownRows(motifWith([1, 119, 0, 3]), { base: 96 }), { low: 96, high: 119 }, 'a note at B8 gives a high end of B8');
  assert.deepEqual(model.shownRows(motifWith([1, 12, 0, 3], [2, 119, 3, 3]), { base: 48 }), { low: 12, high: 119 }, 'the whole range is 108 rows');
});

test('extra pitches and the cursor widen the range the same way, and the result is never under 24 rows and always a multiple of 12', () => {
  assert.deepEqual(model.shownRows(emptyMotif(), { base: 48, extras: [30] }), { low: 24, high: 71 });
  assert.deepEqual(model.shownRows(emptyMotif(), { base: 48, extras: [90, 100] }), { low: 48, high: 107 });
  assert.deepEqual(model.shownRows(emptyMotif(), { base: 48, cursor: 100 }), { low: 48, high: 107 });
  assert.deepEqual(model.shownRows(emptyMotif(), { base: 48, cursor: 60 }), { low: 48, high: 71 }, 'a cursor inside the base changes nothing');
  assert.deepEqual(model.shownRows(motifWith([1, 36, 0, 3]), { base: 60, cursor: 62 }), { low: 24, high: 83 }, 'the base, a note and the cursor are joined');
  for (let base = 12; base <= 96; base += 12) {
    for (const pitch of [12, 13, 47, 60, 71, 72, 100, 119]) {
      const { low, high } = model.shownRows(motifWith([1, pitch, 0, 3]), { base });
      assert.ok(high - low + 1 >= 24, `at least two octaves for base ${base}, note ${pitch}`);
      assert.equal(low % 12, 0, `starts on a C for base ${base}, note ${pitch}`);
      assert.equal((high - low + 1) % 12, 0, `whole octaves for base ${base}, note ${pitch}`);
      assert.ok(low <= pitch && pitch <= high && low >= MIN_PITCH && high <= MAX_PITCH);
    }
  }
});

test('shownRows throws a loud error for a base outside the windows, or a pitch that is not a whole number', () => {
  assert.throws(() => model.shownRows(emptyMotif(), { base: 0 }), /base/);
  assert.throws(() => model.shownRows(emptyMotif(), { base: 108 }), /base/);
  assert.throws(() => model.shownRows(emptyMotif(), { base: 48.5 }), /base/);
  assert.throws(() => model.shownRows(emptyMotif(), { base: 48, extras: [60.5] }), /pitch/);
  assert.throws(() => model.shownRows(emptyMotif(), { base: 48, cursor: 'C4' }), /pitch/);
});

test('the range is worked out from the notes every time: Undo of a Clear shows every note again, and Clear gives the base back', () => {
  const wide = motifWith([1, 36, 0, 3], [2, 84, 3, 3]);
  const history = model.createHistory(wide);
  const cleared = model.commit(history, model.clearMotif(wide));
  assert.deepEqual(model.shownRows(cleared.present, { base: 36 }), { low: 36, high: 59 }, 'the base again after Clear');
  const back = model.undo(cleared);
  assert.deepEqual(model.shownRows(back.motif, { base: 36 }), { low: 24, high: 95 }, 'every note again after Undo');
});

test('rangeText and rangeSpoken name the shown range, and the window counts are gone', () => {
  assert.equal(model.rangeText(48, 71), 'C3–B4');
  assert.equal(model.rangeText(36, 83), 'C2–B5');
  assert.equal(model.rangeSpoken(36, 83), 'C2 to B5');
  for (const gone of ['outsideCounts', 'windowText', 'windowSpoken']) assert.equal(model[gone], undefined, `${gone} is no longer exported`);
  for (const gone of ['windowAbove', 'windowBelow', 'windowSpokenAbove', 'windowSpokenBelow']) assert.equal(SCRATCH_COPY[gone], undefined, `${gone} is no longer copy`);
});

test('cyclesText says 1 cycle or N cycles', () => {
  assert.equal(model.cyclesText(1), '1 cycle');
  assert.equal(model.cyclesText(2), '2 cycles');
  assert.equal(model.cyclesText(8), '8 cycles');
});

// --- The velocity of a note and the order of the lane ---

test('setVelocity gives a note a velocity from 1 to 100 hundredths and says so', () => {
  const motif = motifWith([1, 60, 0, 3], [2, 64, 6, 3]);
  const done = model.setVelocity(motif, 2, 85);
  assert.deepEqual(plain(done.motif), [[1, 60, 0, 3, 80], [2, 64, 6, 3, 85]]);
  assert.equal(done.notice, 'E4 velocity 0.85.');
  assert.deepEqual([done.cut, done.merged], [0, 0]);
  assert.deepEqual(done.note, { id: 2, pitch: 64, start: 6, length: 3, velocity: 85 });
  assert.equal(model.setVelocity(motif, 1, 1).notice, 'C4 velocity 0.01.');
  assert.equal(model.setVelocity(motif, 1, 100).notice, 'C4 velocity 1.00.');
  assert.ok(Object.isFrozen(done.motif) && Object.isFrozen(done.motif.notes));
  assert.deepEqual(plain(motif), [[1, 60, 0, 3, 80], [2, 64, 6, 3, 80]], 'the input is not changed');
});

test('setVelocity to the velocity the note has returns the same motif and an empty notice', () => {
  const motif = motifWith([1, 60, 0, 3]);
  const same = model.setVelocity(motif, 1, 80);
  assert.equal(same.motif, motif);
  assert.equal(same.notice, '');
});

test('setVelocity throws on a velocity that is not a whole number from 1 to 100 and on an unknown note', () => {
  const motif = motifWith([1, 60, 0, 3]);
  for (const bad of [0, 101, 0.85, -5, '80', NaN, undefined]) assert.throws(() => model.setVelocity(motif, 1, bad), /Scratchpad velocity must be a whole number of hundredths from 1 to 100/, String(bad));
  assert.throws(() => model.setVelocity(motif, 9, 50), /no note with id 9/);
});

test('laneOrder lists the note ids by start, then by lower pitch first, then by id', () => {
  const motif = motifWith([1, 67, 6, 3], [2, 60, 6, 3], [3, 72, 0, 3], [4, 64, 6, 3], [5, 60, 12, 3]);
  assert.deepEqual(model.laneOrder(motif), [3, 2, 4, 1, 5]);
  assert.deepEqual(model.laneOrder(emptyMotif()), []);
});

test('the velocity line is in the copy', () => {
  assert.equal(fillScratch(SCRATCH_COPY.velocitySet, { name: 'E4', velocity: '0.85' }), 'E4 velocity 0.85.');
});

// --- What each edit did, and the history that undoes it ---

test('every command result carries what it did, in a short past-tense phrase', () => {
  const motif = motifWith([1, 64, 6, 6]);
  assert.equal(model.placeNote(emptyMotif(), { pitch: 64, start: 0, length: 3 }).what, 'placed E4');
  assert.equal(model.toggleAt(emptyMotif(), { pitch: 64, unit: 0 }).what, 'placed E4');
  assert.equal(model.toggleAt(motif, { pitch: 64, unit: 6 }).what, 'erased E4');
  assert.equal(model.eraseNote(motif, 1).what, 'erased E4');
  assert.equal(model.moveNote(motif, 1, { start: 9 }).what, 'moved E4');
  assert.equal(model.moveNote(motif, 1, { pitch: 65 }).what, 'moved F4');
  assert.equal(model.resizeNote(motif, 1, 9).what, 'changed the length of E4');
  assert.equal(model.setVelocity(motif, 1, 50).what, 'changed the velocity of E4');
  assert.equal(model.setGrid(motif, 'quarter').what, 'changed the grid to quarters');
  assert.equal(model.setGrid(motif, 'eighth-triplet').what, 'changed the grid to eighth triplets');
  assert.equal(model.setCycles(motif, 1).what, 'changed the motif to 1 cycle');
  assert.equal(model.setCycles(motif, 5).what, 'changed the motif to 5 cycles');
});

test('a command that changes nothing carries an empty phrase', () => {
  const motif = motifWith([1, 64, 6, 6]);
  assert.equal(model.moveNote(motif, 1, { start: 6 }).what, '');
  assert.equal(model.setVelocity(motif, 1, 80).what, '');
  assert.equal(model.setGrid(motif, 'sixteenth').what, '');
  assert.equal(model.setCycles(motif, 2).what, '');
});

test('the erase notice ends with the Undo sentence', () => {
  assert.equal(model.eraseNote(motifWith([1, 60, 0, 3]), 1).notice, 'Erased C4 at cycle 1, beat 1. Undo brings it back.');
});

test('a new history holds the motif and nothing to undo or redo', () => {
  const motif = motifWith([1, 60, 0, 3]);
  const history = model.createHistory(motif);
  assert.equal(history.present, motif);
  assert.deepEqual([history.past.length, history.future.length], [0, 0]);
  assert.ok(Object.isFrozen(history) && Object.isFrozen(history.past) && Object.isFrozen(history.future));
});

test('commit makes the result the present and keeps the earlier motif to go back to', () => {
  const start = emptyMotif();
  const first = model.placeNote(start, { pitch: 60, start: 0, length: 3 });
  const history = model.commit(model.createHistory(start), first);
  assert.equal(history.present, first.motif);
  assert.equal(history.past.length, 1);
  assert.equal(history.past[0].motif, start);
  assert.equal(history.past[0].what, 'placed C4');
});

test('commit of a result whose motif did not change adds nothing, a refusal included', () => {
  const motif = motifWith([1, 60, 0, 3]);
  const history = model.createHistory(motif);
  assert.equal(model.commit(history, model.setVelocity(motif, 1, 80)), history);
  assert.equal(model.commit(history, model.setCycles(motif, 5)).past.length, 1, 'a real change is kept');
  const crowded = Object.freeze({ ...motifWith([1, 60, 100, 3]), cycles: 3 });
  const refused = model.setCycles(crowded, 2);
  assert.ok(refused.refused);
  const crowdedHistory = model.createHistory(crowded);
  assert.equal(model.commit(crowdedHistory, refused), crowdedHistory);
});

test('undo gives the earlier motif and says what it undid; redo brings it back and says so', () => {
  const start = emptyMotif();
  const placed = model.placeNote(start, { pitch: 60, start: 0, length: 3 });
  const erased = model.eraseNote(placed.motif, 1);
  let history = model.commit(model.commit(model.createHistory(start), placed), erased);
  const undone = model.undo(history);
  assert.equal(undone.motif, placed.motif);
  assert.equal(undone.notice, 'Undid: erased C4.');
  assert.equal(undone.history.present, placed.motif);
  assert.equal(undone.history.future.length, 1);
  const redone = model.redo(undone.history);
  assert.equal(redone.motif, erased.motif);
  assert.equal(redone.notice, 'Redid: erased C4.');
  assert.equal(redone.history.future.length, 0);
  history = model.undo(model.undo(history).history);
  assert.equal(history.motif, start);
  assert.equal(history.notice, 'Undid: placed C4.');
});

test('with nothing to undo or redo the history is unchanged and the notice says so', () => {
  const history = model.createHistory(emptyMotif());
  const none = model.undo(history);
  assert.equal(none.history, history);
  assert.equal(none.motif, history.present);
  assert.equal(none.notice, 'Nothing to undo.');
  const nothing = model.redo(history);
  assert.equal(nothing.history, history);
  assert.equal(nothing.notice, 'Nothing to redo.');
});

test('a new edit after an undo clears the redo list', () => {
  const start = emptyMotif();
  const placed = model.placeNote(start, { pitch: 60, start: 0, length: 3 });
  const history = model.undo(model.commit(model.createHistory(start), placed)).history;
  assert.equal(history.future.length, 1);
  const other = model.placeNote(history.present, { pitch: 62, start: 3, length: 3 });
  const next = model.commit(history, other);
  assert.equal(next.future.length, 0);
  assert.equal(model.redo(next).notice, 'Nothing to redo.');
});

test('undo brings back the grid and the cycles when the undone edit changed them', () => {
  const start = motifWith([1, 60, 3, 3]);
  const grid = model.setGrid(start, 'quarter');
  const cycles = model.setCycles(grid.motif, 4);
  let history = model.commit(model.commit(model.createHistory(start), grid), cycles);
  history = model.undo(history).history;
  assert.equal(history.present.cycles, 2);
  assert.equal(history.present.grid, 'quarter');
  const back = model.undo(history);
  assert.equal(back.motif.grid, 'sixteenth');
  assert.deepEqual(plain(back.motif), [[1, 60, 3, 3, 80]]);
  assert.equal(back.notice, 'Undid: changed the grid to quarters.');
});

test('the history keeps at most 100 earlier states and drops the oldest', () => {
  let motif = emptyMotif();
  let history = model.createHistory(motif);
  const firsts = [];
  for (let i = 0; i < 130; i += 1) {
    const result = model.toggleAt(motif, { pitch: 60, unit: 0 });
    firsts.push(result.what);
    history = model.commit(history, result);
    motif = result.motif;
  }
  assert.equal(history.past.length, 100);
  assert.equal(model.HISTORY_DEPTH, 100);
  let steps = 0;
  while (history.past.length > 0) {
    history = model.undo(history).history;
    steps += 1;
  }
  assert.equal(steps, 100);
  assert.equal(model.undo(history).notice, 'Nothing to undo.');
});

test('the history never changes what it was given', () => {
  const start = emptyMotif();
  const placed = model.placeNote(start, { pitch: 60, start: 0, length: 3 });
  const one = model.createHistory(start);
  const two = model.commit(one, placed);
  model.undo(two);
  assert.deepEqual([one.past.length, one.future.length, two.past.length, two.future.length], [0, 0, 1, 0]);
  assert.equal(two.present, placed.motif);
});

test('the undo and redo words are in the copy', () => {
  assert.equal(SCRATCH_COPY.undo, 'Undo');
  assert.equal(SCRATCH_COPY.redo, 'Redo');
  assert.equal(SCRATCH_COPY.nothingToUndo, 'Nothing to undo.');
  assert.equal(SCRATCH_COPY.nothingToRedo, 'Nothing to redo.');
  assert.equal(fillScratch(SCRATCH_COPY.undid, { what: 'erased C4' }), 'Undid: erased C4.');
  assert.equal(fillScratch(SCRATCH_COPY.redid, { what: 'erased C4' }), 'Redid: erased C4.');
});

// --- Tap: the rule for placing a key press by its own time stamp ---

test('checkStamp refuses a stamp of zero, one that is not a number, one ahead of the handler and one more than a second old', () => {
  assert.equal(model.STAMP_WINDOW_MS, 1000);
  assert.equal(model.AHEAD_MS, 1);
  assert.equal(model.checkStamp(0, 5), 'zero');
  assert.equal(model.checkStamp(NaN, 5), 'not-a-number');
  assert.equal(model.checkStamp(5, NaN), 'not-a-number');
  assert.equal(model.checkStamp(Infinity, 5), 'not-a-number');
  assert.equal(model.checkStamp('5', 5), 'not-a-number');
  assert.equal(model.checkStamp(10, 8.9), 'ahead');
  assert.equal(model.checkStamp(1, 1002), 'stale');
});

test('checkStamp accepts a stamp exactly 1 ms ahead and one exactly a second old', () => {
  assert.equal(model.checkStamp(10, 9), null);
  assert.equal(model.checkStamp(2, 1002), null);
  assert.equal(model.checkStamp(500, 500), null);
});

test('cycleAtStamp is the cycle on the straight line through two anchors', () => {
  assert.equal(model.cycleAtStamp(1500, { c: 4, t: 1000 }, { c: 5, t: 3000 }), 4.25);
  assert.equal(model.cycleAtStamp(1000, { c: 4, t: 1000 }, { c: 5, t: 3000 }), 4);
  assert.equal(model.cycleAtStamp(3500, { c: 4, t: 1000 }, { c: 5, t: 3000 }), 5.25);
});

test('cycleAtStamp throws loudly when the anchors cannot make a line', () => {
  assert.throws(() => model.cycleAtStamp(1500, { c: 4, t: 1000 }, { c: 5, t: 1000 }), /Moontide: .*stamp/);
  assert.throws(() => model.cycleAtStamp(1500, { c: 4, t: NaN }, { c: 5, t: 3000 }), /Moontide: /);
  assert.throws(() => model.cycleAtStamp(1500, { c: 4, t: 1000 }, { c: Infinity, t: 3000 }), /Moontide: /);
  assert.throws(() => model.cycleAtStamp(NaN, { c: 4, t: 1000 }, { c: 5, t: 3000 }), /Moontide: /);
});

test('tapStart is the music cycle modulo the motif, snapped to the nearest step, a tie to the earlier step', () => {
  const motif = emptyMotif();
  assert.equal(model.tapStart({ cycle: 7.26, motif }), 60);
  assert.equal(model.tapStart({ cycle: 0, motif }), 0);
  assert.equal(model.tapStart({ cycle: 4, motif }), 0);
  // Exactly half a step (1.5 units) after step 0 goes to the earlier step; a hair more goes to the next one.
  assert.equal(model.tapStart({ cycle: 1.5 / 48, motif }), 0);
  assert.equal(model.tapStart({ cycle: 1.5001 / 48, motif }), 3);
  assert.equal(model.tapStart({ cycle: 1 + 4.5 / 48, motif }), 51);
});

test('tapStart wraps a position that rounds to the motif end to step 0', () => {
  const motif = emptyMotif();
  assert.equal(model.tapStart({ cycle: 5.999, motif }), 0);
  assert.equal(model.tapStart({ cycle: 1.999, motif }), 0);
  assert.equal(model.tapStart({ cycle: 1.96, motif }), 93);
});

test('tapStart follows the grid in use and a negative cycle is held inside the motif', () => {
  const quarters = model.setGrid(emptyMotif(), 'quarter').motif;
  assert.equal(model.tapStart({ cycle: 0.3, motif: quarters }), 12);
  const triplets = model.setGrid(emptyMotif(), 'sixteenth-triplet').motif;
  assert.equal(model.tapStart({ cycle: 0.51, motif: triplets }), 24);
  assert.equal(model.tapStart({ cycle: -0.25, motif: emptyMotif() }), 84);
  const one = model.setCycles(emptyMotif(), 1).motif;
  assert.equal(model.tapStart({ cycle: 3.25, motif: one }), 12);
});

test('tapStart throws loudly for a cycle that is not a finite number', () => {
  assert.throws(() => model.tapStart({ cycle: NaN, motif: emptyMotif() }), /Moontide: /);
  assert.throws(() => model.tapStart({ cycle: Infinity, motif: emptyMotif() }), /Moontide: /);
});

const TAP_ANCHORS = { a: { c: 4, t: 1000 }, b: { c: 5, t: 3000 } };

test('tapNote places a one-step note at 0.80 where the stamp falls and says what it did', () => {
  // t = 1500 is cycle 4.25: a quarter into a 2-cycle motif that holds cycle 4 as its first.
  const result = model.tapNote(emptyMotif(), { ts: 1500, h: 1500, anchors: TAP_ANCHORS, pitch: 60 });
  assert.equal(result.refused, undefined);
  assert.equal(result.note.pitch, 60);
  assert.equal(result.note.start, 12);
  assert.equal(result.note.length, 3);
  assert.equal(result.note.velocity, 80);
  assert.equal(result.notice, 'Tapped C4 at cycle 1, beat 2.');
  assert.equal(result.what, 'tapped C4');
  assert.equal(result.motif.notes.length, 1);
});

test('tapNote says the cycle and the beat of the note that stands there, and merges a second tap in the same cell', () => {
  const first = model.tapNote(emptyMotif(), { ts: 1500, h: 1500, anchors: TAP_ANCHORS, pitch: 64 });
  const second = model.tapNote(first.motif, { ts: 1500, h: 1500, anchors: TAP_ANCHORS, pitch: 64 });
  assert.equal(second.motif.notes.length, 1);
  assert.match(second.notice, /^Tapped E4 at cycle 1, beat 2\. Merged with the note there/);
});

test('tapNote refuses each stamp reason in words and leaves the motif as it was', () => {
  const motif = emptyMotif();
  const cases = [
    [{ ts: 0, h: 5 }, 'The time stamp of the key press was refused (it was zero), so nothing was placed.'],
    [{ ts: NaN, h: 5 }, 'The time stamp of the key press was refused (it was not a number), so nothing was placed.'],
    [{ ts: 10, h: 5 }, "The time stamp of the key press was refused (it was ahead of the page's clock), so nothing was placed."],
    [{ ts: 1, h: 2000 }, 'The time stamp of the key press was refused (it was more than a second old), so nothing was placed.'],
  ];
  for (const [stamp, words] of cases) {
    const result = model.tapNote(motif, { ...stamp, anchors: TAP_ANCHORS, pitch: 60 });
    assert.equal(result.refused, words);
    assert.equal(result.motif, motif);
    assert.equal(result.notice, '');
    assert.equal(result.what, '');
  }
});

test('tapNote says when the music clock gave no anchors, or anchors that make no line', () => {
  const motif = emptyMotif();
  const words = "The music's clock could not be read, so nothing was placed.";
  assert.equal(model.tapNote(motif, { ts: 5, h: 5, anchors: null, pitch: 60 }).refused, words);
  assert.equal(model.tapNote(motif, { ts: 5, h: 5, anchors: { a: { c: 1, t: 10 }, b: { c: 2, t: 10 } }, pitch: 60 }).refused, words);
  assert.equal(model.tapNote(motif, { ts: 5, h: 5, anchors: { a: { c: 1, t: null }, b: { c: 2, t: 10 } }, pitch: 60 }).refused, words);
  assert.equal(model.tapNote(motif, { ts: 5, h: 5, anchors: { a: { c: 1, t: 1 }, b: { c: 2, t: 10 } }, pitch: 60 }).motif.notes.length, 1);
});

test('the Tap words are in the copy', () => {
  assert.equal(SCRATCH_COPY.tap, 'Tap rhythm');
  assert.equal(SCRATCH_COPY.tapNeedsMusic, "Tap needs the music playing, because the music's clock places the taps. Press Play, then try again.");
  assert.equal(SCRATCH_COPY.tapClockUnreadable, "The music's clock could not be read, so nothing was placed.");
  assert.equal(fillScratch(SCRATCH_COPY.tapped, { name: 'E4', cycle: 1, beat: '2.25' }), 'Tapped E4 at cycle 1, beat 2.25.');
});

test('unitInMotif is the music cycle modulo the motif, in units and not rounded', () => {
  assert.equal(model.unitInMotif(7.25, 2), 60);
  assert.equal(model.unitInMotif(0, 2), 0);
  assert.equal(model.unitInMotif(-0.25, 2), 84);
  assert.ok(Math.abs(model.unitInMotif(3.1, 1) - 4.8) < 1e-9);
  assert.throws(() => model.unitInMotif(NaN, 2), /Moontide: /);
});

// recordBuffer: the keyboard's last cycles become the motif.

const snap = (notes, cycles = 8, start = 0) => ({ start, cycles, notes });
const played = (pitch, velocity, start, end, run = null) => ({ pitch, velocity, start, end, run });

test('recordBuffer puts a snapshot on the roll: sixteenths, velocities in hundredths, the cycles of the span', () => {
  const motif = emptyMotif();
  const result = model.recordBuffer(motif, snap([played(60, 127, 2.25, 2.5), played(64, 64, 3.5, 3.75)]));
  assert.equal(result.refused, undefined);
  assert.equal(result.motif.cycles, 2);
  assert.equal(result.motif.grid, 'sixteenth');
  assert.deepEqual(result.motif.notes.map((note) => [note.pitch, note.start, note.length, note.velocity]), [[60, 12, 12, 100], [64, 72, 12, 50]]);
  assert.ok(result.notice.startsWith('Recorded 2 notes over 2 cycles on sixteenths.'), result.notice);
  assert.ok(result.notice.endsWith(' Undo brings back the earlier motif.'), result.notice);
  assert.equal(result.what, 'recorded the keyboard');
  assert.ok(Object.isFrozen(result.motif));
  assert.ok(Object.isFrozen(result.motif.notes));
});

test('recordBuffer keeps the grid of the motif and gives new ids from nextId', () => {
  const placed = model.placeNote(emptyMotif(), { pitch: 70, start: 0, length: 3 });
  const eighths = model.setGrid(placed.motif, 'eighth').motif;
  const result = model.recordBuffer(eighths, snap([played(60, 100, 0.26, 0.4)]));
  assert.equal(result.motif.grid, 'eighth');
  assert.deepEqual(result.motif.notes.map((note) => note.id), [eighths.nextId]);
  assert.equal(result.motif.nextId, eighths.nextId + 1);
  assert.equal(result.motif.notes[0].start, 12);
  assert.equal(result.motif.notes[0].length, 6);
});

test('recordBuffer never changes its input motif or its snapshot', () => {
  const motif = model.placeNote(emptyMotif(), { pitch: 70, start: 0, length: 3 }).motif;
  const input = snap([played(60, 100, 1, 1.5)]);
  const copy = JSON.stringify(input);
  const result = model.recordBuffer(motif, input);
  assert.notEqual(result.motif, motif);
  assert.equal(motif.notes.length, 1);
  assert.equal(motif.notes[0].pitch, 70);
  assert.equal(JSON.stringify(input), copy);
});

test('a start of 7.999 cycles snaps onto the ring\'s right end and lands at its left end, in the next lap', () => {
  const result = model.recordBuffer(emptyMotif(), snap([played(60, 100, 7.999, 7.999)]));
  assert.equal(result.motif.cycles, 1);
  assert.deepEqual(result.motif.notes.map((note) => [note.start, note.length]), [[0, 3]]);
});

test('a position exactly half a step after a step goes to the earlier step', () => {
  // 2.5 steps of a sixteenth is 7.5 units: the tie goes to the step at unit 6.
  const result = model.recordBuffer(emptyMotif(), snap([played(60, 100, 7.5 / 48, 12 / 48)]));
  assert.equal(result.motif.notes[0].start, 6);
});

test('an end snaps the same way and the length is at least one step', () => {
  const result = model.recordBuffer(emptyMotif(), snap([played(60, 100, 0, 0.001), played(62, 100, 0, 6 / 48 + 0.5 / 48)]));
  assert.deepEqual(result.motif.notes.map((note) => note.length), [3, 6]);
});

test('a chord stays a chord', () => {
  const result = model.recordBuffer(emptyMotif(), snap([played(60, 100, 1, 1.25), played(64, 90, 1.001, 1.25), played(67, 80, 0.999, 1.25)]));
  assert.deepEqual(result.motif.notes.map((note) => [note.pitch, note.start]), [[60, 0], [64, 0], [67, 0]]);
  assert.equal(result.merged, 0);
});

test('two notes of one pitch that snap into one cell merge into the stronger, and the notice says it', () => {
  const result = model.recordBuffer(emptyMotif(), snap([played(60, 50, 1, 1.01), played(60, 127, 1.005, 1.2)]));
  assert.equal(result.motif.notes.length, 1);
  assert.equal(result.motif.notes[0].velocity, 100);
  assert.equal(result.merged, 1);
  assert.ok(result.notice.includes('Merged with the note there (same pitch in the same cell).'), result.notice);
  assert.ok(result.notice.startsWith('Recorded 1 note over 1 cycle on sixteenths.'), result.notice);
});

test('pitches the roll cannot show are left out, counted and said, never moved', () => {
  const result = model.recordBuffer(emptyMotif(), snap([played(11, 100, 0, 0.1), played(60, 100, 0, 0.1), played(120, 100, 0.5, 0.6)]));
  assert.deepEqual(result.motif.notes.map((note) => note.pitch), [60]);
  assert.ok(result.notice.includes(" 2 notes were outside the roll's range and were left out."), result.notice);
  const one = model.recordBuffer(emptyMotif(), snap([played(11, 100, 0, 0.1), played(60, 100, 0, 0.1)]));
  assert.ok(one.notice.includes(" 1 note was outside the roll's range and was left out."), one.notice);
});

test('a lone note keeps its tail: its end is snapped, not cut', () => {
  const result = model.recordBuffer(emptyMotif(), snap([played(60, 100, 6, 7.6)]));
  assert.equal(result.motif.cycles, 2);
  assert.deepEqual(result.motif.notes.map((note) => [note.start, note.length]), [[0, 78]]);
});

test('a note that ends exactly on a cycle line stays in the cycle it ends', () => {
  const result = model.recordBuffer(emptyMotif(), snap([played(60, 100, 0.5, 1)]));
  assert.equal(result.motif.cycles, 1);
});

test('the whole window of 8 cycles makes an 8-cycle motif with no note lost', () => {
  const result = model.recordBuffer(emptyMotif(), snap([played(60, 100, 0, 0.25), played(62, 100, 7.75, 8)]));
  assert.equal(result.motif.cycles, 8);
  assert.deepEqual(result.motif.notes.map((note) => note.start), [0, 7 * 48 + 36]);
});

// ringLayout: where the live layer draws a snapshot, and where recordBuffer puts it.

const heldPlayed = (pitch, velocity, start, end, run = null) => ({ ...played(pitch, velocity, start, end, run), held: true });

test('RING_CYCLES is the buffer\'s 8 cycles', () => {
  assert.equal(model.RING_CYCLES, 8);
  assert.equal(model.RING_CYCLES, MAX_CYCLES);
});

test('ringLayout puts a note at axis cycle 10.25 (window start 3) in column 2, unit 108, on sixteenths', () => {
  const { pieces, outside } = model.ringLayout(snap([played(60, 127, 7.25, 7.5, 5)], 8, 3), 'sixteenth');
  assert.equal(outside, 0);
  assert.deepEqual(pieces, [{ pitch: 60, velocity: 100, start: 108, end: 120, held: false, run: 5, lap: 1 }]);
  assert.equal(Math.floor(pieces[0].start / UNITS_PER_CYCLE), 2, 'column 2');
});

test('ringLayout snaps with recordBuffer\'s rule on every grid: the nearest step, an exact half going to the earlier one', () => {
  for (const grid of GRIDS) {
    const step = grid.unit;
    const half = (step * 2.5) / UNITS_PER_CYCLE;
    const { pieces } = model.ringLayout(snap([played(60, 100, half, half + step / UNITS_PER_CYCLE)]), grid.id);
    assert.equal(pieces[0].start, 2 * step, `${grid.id}: 2.5 steps goes to the earlier step`);
    assert.equal(pieces[0].end, 3 * step, grid.id);
  }
});

test('ringLayout converts a velocity to hundredths the way recordBuffer does, from 1 to 100', () => {
  const { pieces } = model.ringLayout(snap([played(60, 127, 0, 0.25), played(62, 64, 0, 0.25), played(64, 1, 0, 0.25)]), 'sixteenth');
  assert.deepEqual(pieces.map((piece) => piece.velocity), [100, 50, 1]);
});

test('ringLayout drops the pitches outside C0 to B8 and counts them', () => {
  const { pieces, outside } = model.ringLayout(snap([played(11, 100, 0, 0.1), played(60, 100, 0, 0.1), played(120, 100, 0.5, 0.6)]), 'sixteenth');
  assert.deepEqual(pieces.map((piece) => piece.pitch), [60]);
  assert.equal(outside, 2);
});

test('a start that snaps onto the next cycle line lands in the next column, and one that snaps onto the ring\'s end lands at 0 in the next lap', () => {
  const next = model.ringLayout(snap([played(60, 100, 2.999, 3.25)]), 'quarter').pieces[0];
  assert.equal(next.start, 144);
  const wrapped = model.ringLayout(snap([played(60, 100, 7.99, 8.1)], 8, 16), 'quarter').pieces[0];
  assert.deepEqual([wrapped.start, wrapped.end, wrapped.lap], [0, 12, 3]);
  const kept = model.ringLayout(snap([played(60, 100, 7.75, 8)], 8, 16), 'quarter').pieces[0];
  assert.deepEqual([kept.start, kept.end, kept.lap], [372, 384, 2]);
});

test('a note that crosses unit 384 is two pieces of the same pitch and velocity, the second in the next lap, and only the last is held', () => {
  const { pieces } = model.ringLayout(snap([heldPlayed(64, 127, 7.75, 8.5, 2)], 8, 8), 'sixteenth');
  assert.deepEqual(pieces, [
    { pitch: 64, velocity: 100, start: 372, end: 384, held: false, run: 2, lap: 1 },
    { pitch: 64, velocity: 100, start: 0, end: 24, held: true, run: 2, lap: 2 },
  ]);
});

test('a note never covers more than one lap of the ring', () => {
  const { pieces } = model.ringLayout(snap([played(60, 100, 0, 12)], 8, 0), 'sixteenth');
  assert.equal(pieces.reduce((sum, piece) => sum + piece.end - piece.start, 0), 384);
});

test('ringLayout keeps the held flag of a snapshot note and calls a note with no flag not held', () => {
  const { pieces } = model.ringLayout(snap([heldPlayed(60, 100, 1, 1.5), played(62, 100, 1, 1.5), { ...played(64, 100, 1, 1.5), held: false }]), 'sixteenth');
  assert.deepEqual(pieces.map((piece) => piece.held), [true, false, false]);
});

test('ringLayout of an empty snapshot gives no pieces, and of 2000 notes at most 2000 pieces plus the split ones', () => {
  assert.deepEqual(model.ringLayout(snap([]), 'sixteenth'), { pieces: [], outside: 0 });
  const notes = Array.from({ length: 2000 }, (_, index) => played(24 + (index % 60), 100, (index % 400) / 50, (index % 400) / 50 + 0.2));
  const { pieces } = model.ringLayout(snap(notes), 'eighth');
  const crossing = pieces.filter((piece) => piece.start === 0 && piece.lap === 1).length;
  assert.ok(pieces.length >= 2000 && pieces.length <= 2000 + crossing, `${pieces.length} pieces`);
});

test('ringLayout does not change its snapshot and throws on a value that cannot be used', () => {
  const input = snap([played(60, 100, 1, 1.5)], 8, 3);
  const copy = JSON.stringify(input);
  model.ringLayout(input, 'sixteenth');
  assert.equal(JSON.stringify(input), copy);
  assert.throws(() => model.ringLayout(null, 'sixteenth'), /Moontide: /);
  assert.throws(() => model.ringLayout({ start: 0, cycles: 8 }, 'sixteenth'), /Moontide: /);
  assert.throws(() => model.ringLayout(snap([played(60, 100, Number.NaN, 1)]), 'sixteenth'), /Moontide: /);
  assert.throws(() => model.ringLayout(snap([played(60.5, 100, 0, 1)]), 'sixteenth'), /Moontide: /);
  assert.throws(() => model.ringLayout(snap([played(60, 0, 0, 1)]), 'sixteenth'), /Moontide: /);
  assert.throws(() => model.ringLayout(snap([played(60, 100, 0, 1)], 0), 'sixteenth'), /Moontide: /);
  assert.throws(() => model.ringLayout(snap([played(60, 100, 0, 1)], 8, Number.NaN), 'sixteenth'), /Moontide: /);
  assert.throws(() => model.ringLayout(snap([played(60, 100, 0, 1)]), 'whole'), /Moontide: /);
});

// recordBuffer on the ring: the motif holds what the live layer showed.

// A small seeded generator, so the property test is the same on every run.
function seeded(seed) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

test('for a snapshot of one lap, the notes recordBuffer writes equal the layout\'s pieces moved back by the trimmed cycles, on every grid', () => {
  const random = seeded(55);
  for (const grid of GRIDS) {
    for (let round = 0; round < 40; round += 1) {
      // One lap: the window starts on a multiple of 8 and no note reaches its end, so every piece falls in the same lap and none is split.
      const start = 8 * Math.floor(random() * 5);
      const count = 1 + Math.floor(random() * 12);
      // Distinct pitches, so the same-pitch rule has nothing to cut or merge.
      const pitches = Array.from({ length: 60 }, (_, index) => 24 + index).sort(() => random() - 0.5).slice(0, count);
      const notes = pitches.map((pitch) => {
        const from = random() * 7.4;
        return played(pitch, 1 + Math.floor(random() * 127), from, from + random() * 0.5, 7);
      });
      const snapshot = snap(notes, 8, start);
      const motif = model.setGrid(emptyMotif(), grid.id).motif;
      const layout = model.ringLayout(snapshot, grid.id).pieces;
      const result = model.recordBuffer(motif, snapshot);
      const first = Math.floor(Math.min(...layout.map((piece) => piece.start)) / UNITS_PER_CYCLE) * UNITS_PER_CYCLE;
      const want = layout.map((piece) => [piece.pitch, piece.velocity, piece.start - first, piece.end - piece.start]).sort((a, b) => a[0] - b[0]);
      const got = result.motif.notes.map((note) => [note.pitch, note.velocity, note.start, note.length]).sort((a, b) => a[0] - b[0]);
      assert.deepEqual(got, want, `${grid.id} round ${round}`);
    }
  }
});

test('the same-pitch rule is the only difference between the layout and the motif, and the result counts it', () => {
  const snapshot = snap([played(60, 50, 1, 1.01), played(60, 127, 1.005, 1.2), played(64, 90, 1, 1.25)]);
  const layout = model.ringLayout(snapshot, 'sixteenth').pieces;
  assert.equal(layout.length, 3);
  const result = model.recordBuffer(emptyMotif(), snapshot);
  assert.equal(result.motif.notes.length, 2);
  assert.equal(result.merged + result.cut, 1);
});

test('a take in columns 3 and 4 becomes a 2-cycle motif that starts at its column-3 notes', () => {
  const result = model.recordBuffer(emptyMotif(), snap([played(60, 100, 2.25, 2.5), played(64, 100, 3.5, 3.75)]));
  assert.equal(result.motif.cycles, 2);
  assert.deepEqual(result.motif.notes.map((note) => [note.pitch, note.start]), [[60, 12], [64, 72]]);
});

test('a take from column 8 into column 1 becomes an 8-cycle motif with the column-1 notes in cycle 1 and the column-8 notes in cycle 8', () => {
  // Window start 8: axis cycle 15.5 is column 7 (the 8th), axis cycle 16.25 is column 0 (the 1st) of the next lap.
  const result = model.recordBuffer(emptyMotif(), snap([played(60, 100, 7.5, 7.75, 3), played(64, 100, 8.25, 8.5, 3)], 8, 8));
  assert.equal(result.motif.cycles, 8);
  const byPitch = (pitch) => result.motif.notes.find((note) => note.pitch === pitch);
  assert.equal(Math.floor(byPitch(64).start / UNITS_PER_CYCLE), 0, 'column 1');
  assert.equal(Math.floor(byPitch(60).start / UNITS_PER_CYCLE), 7, 'column 8');
  assert.equal(result.motif.recorded.cycle, null, 'two laps carry no moment');
});

test('a note held across the ring\'s origin is recorded as two notes, one ending at the motif\'s end and one starting at 0', () => {
  const result = model.recordBuffer(emptyMotif(), snap([played(64, 100, 7.75, 8.25, 3)], 8, 8));
  assert.equal(result.motif.cycles, 8);
  assert.deepEqual(result.motif.notes.map((note) => [note.pitch, note.start, note.length]).sort((a, b) => a[1] - b[1]), [[64, 0, 12], [64, 372, 12]]);
  assert.equal(result.motif.recorded.cycle, null);
});

test('the moment is 8 times the lap plus the first column minus the run when every kept note has one lap and one run', () => {
  // Lap 5 (axis cycles 40 to 47), first note in column 2, run 30: the music's own cycle where the motif began is 40 + 2 - 30.
  const result = model.recordBuffer(emptyMotif(), snap([played(60, 100, 3.25, 3.5, 30), played(64, 100, 4.5, 4.75, 30)], 8, 39));
  assert.deepEqual(result.motif.recorded, { cycle: 12 });
  // The same notes with the window starting on the lap: only the column and the lap count.
  const same = model.recordBuffer(emptyMotif(), snap([played(60, 100, 2.25, 2.5, 30), played(64, 100, 3.5, 3.75, 30)], 8, 40));
  assert.deepEqual(same.motif.recorded, { cycle: 12 });
});

test('the moment is null for two laps, two runs, no run, a result below 0, and a take that crosses the origin', () => {
  const twoLaps = model.recordBuffer(emptyMotif(), snap([played(60, 100, 6.25, 6.5, 30), played(64, 100, 9.25, 9.5, 30)], 8, 40));
  assert.equal(twoLaps.motif.recorded.cycle, null);
  const twoRuns = model.recordBuffer(emptyMotif(), snap([played(60, 100, 2.25, 2.5, 30), played(64, 100, 3.5, 3.75, 34)], 8, 40));
  assert.equal(twoRuns.motif.recorded.cycle, null);
  const noRun = model.recordBuffer(emptyMotif(), snap([played(60, 100, 2.25, 2.5), played(64, 100, 3.5, 3.75)], 8, 40));
  assert.equal(noRun.motif.recorded.cycle, null);
  const below = model.recordBuffer(emptyMotif(), snap([played(60, 100, 1.25, 1.5, 50)], 8, 40));
  assert.equal(below.motif.recorded.cycle, null);
  const across = model.recordBuffer(emptyMotif(), snap([played(60, 100, 7.5, 8.5, 30)], 8, 40));
  assert.equal(across.motif.recorded.cycle, null);
});

test('the result commits as one history step that Undo takes back', () => {
  const first = model.placeNote(emptyMotif(), { pitch: 70, start: 0, length: 3 }).motif;
  const history = model.createHistory(first);
  const result = model.recordBuffer(first, snap([played(60, 100, 0, 0.25)]));
  const next = model.commit(history, result);
  assert.equal(next.past.length, 1);
  const undone = model.undo(next);
  assert.equal(undone.motif, first);
  assert.equal(undone.notice, 'Undid: recorded the keyboard.');
});

test('an empty or null snapshot is refused with the nothing-to-record sentence', () => {
  const motif = model.placeNote(emptyMotif(), { pitch: 70, start: 0, length: 3 }).motif;
  const words = 'Nothing to record: the keyboard played nothing in the last 8 cycles.';
  for (const value of [null, undefined, snap([]), { start: 0, cycles: 8 }]) {
    const result = model.recordBuffer(motif, value);
    assert.equal(result.refused, words);
    assert.equal(result.motif, motif);
    assert.equal(result.notice, '');
    assert.equal(result.what, '');
  }
});

test('a snapshot whose every note is out of range is refused with the out-of-range words', () => {
  const motif = emptyMotif();
  const result = model.recordBuffer(motif, snap([played(5, 100, 0, 0.1), played(125, 100, 0, 0.1)]));
  assert.equal(result.motif, motif);
  assert.equal(result.refused, "Nothing to record. 2 notes were outside the roll's range and were left out.");
});

test('a snapshot with a value that cannot be used throws', () => {
  assert.throws(() => model.recordBuffer(emptyMotif(), snap([played(60, 100, Number.NaN, 1)])), /Moontide: /);
  assert.throws(() => model.recordBuffer(emptyMotif(), snap([played(60.5, 100, 0, 1)])), /Moontide: /);
  assert.throws(() => model.recordBuffer(emptyMotif(), snap([played(60, 0, 0, 1)])), /Moontide: /);
});

test('recordBuffer gives the music\'s cycle where the motif was played when every note came from one run', () => {
  const result = model.recordBuffer(emptyMotif(), snap([played(60, 100, 3.25, 3.5, 30), played(64, 100, 4.5, 4.75, 30)], 8, 40));
  assert.deepEqual(result.motif.recorded, { cycle: 13 });
  assert.ok(Object.isFrozen(result.motif.recorded));
  assert.equal(result.motif.source, 'played');
  assert.equal(model.motifMoment(result.motif, 99), 13);
  assert.equal(model.motifRequest(result.motif, 99).cycle, 13);
  // Run 0 is a run like any other: the axis then equals the music's count.
  assert.deepEqual(model.recordBuffer(emptyMotif(), snap([played(60, 100, 2, 2.25, 0)], 8, 40)).motif.recorded, { cycle: 42 });
});

test('recordBuffer gives no cycle for notes of no run, of two runs, or a result below 0', () => {
  const none = model.recordBuffer(emptyMotif(), snap([played(60, 100, 3.25, 3.5), played(64, 100, 4.5, 4.75)], 8, 40));
  assert.deepEqual(none.motif.recorded, { cycle: null });
  const two = model.recordBuffer(emptyMotif(), snap([played(60, 100, 3.25, 3.5, 30), played(64, 100, 4.5, 4.75, 34)], 8, 40));
  assert.deepEqual(two.motif.recorded, { cycle: null });
  const oneNull = model.recordBuffer(emptyMotif(), snap([played(60, 100, 3.25, 3.5, 30), played(64, 100, 4.5, 4.75, null)], 8, 40));
  assert.deepEqual(oneNull.motif.recorded, { cycle: null });
  const below = model.recordBuffer(emptyMotif(), snap([played(60, 100, 1, 1.25, 50)], 8, 40));
  assert.deepEqual(below.motif.recorded, { cycle: null });
  assert.equal(Object.hasOwn(model.motifRequest(below.motif, 9), 'cycle'), false);
});

test('recordBuffer does not count the pitches left out of the roll in the run check', () => {
  const result = model.recordBuffer(emptyMotif(), snap([played(60, 100, 3.25, 3.5, 30), played(5, 100, 3.5, 3.75, 34), played(125, 100, 3.5, 3.75, null)], 8, 40));
  assert.deepEqual(result.motif.recorded, { cycle: 13 });
});

test('recordBuffer throws on a note whose run is missing or neither null nor a whole number', () => {
  const bad = (run) => ({ pitch: 60, velocity: 100, start: 1, end: 1.25, ...(run === undefined ? {} : { run }) });
  for (const run of [undefined, 1.5, -0.5, '3', NaN]) {
    assert.throws(() => model.recordBuffer(emptyMotif(), snap([bad(run)], 8, 40)), /Moontide: /, String(run));
  }
  assert.throws(() => model.recordBuffer(emptyMotif(), snap([played(60, 100, 1, 1.25, 3)], 8, Number.NaN)), /Moontide: /);
});

test('the Record that words are in the copy', () => {
  assert.equal(SCRATCH_COPY.record, 'Record that');
  assert.equal(SCRATCH_COPY.recordClockUnreadable, "The music's clock could not be read, so nothing was recorded.");
});

// --- the phrase and the motif request ---

// A motif on this grid and length with these notes, given as { pitch, step, steps, velocity } and placed through the model's own command.
function motifOf(gridId, cycles, cells) {
  const unit = gridOf(gridId).unit;
  let motif = { ...emptyMotif(), grid: gridId, cycles };
  for (const cell of cells) {
    motif = model.placeNote(motif, { pitch: cell.pitch, start: cell.step * unit, length: (cell.steps ?? 1) * unit, velocity: cell.velocity ?? 80 }).motif;
  }
  return motif;
}

test('the phrase of an empty motif is null', () => {
  assert.equal(model.motifPhrase(emptyMotif()), null);
});

test('the golden phrases are written exactly', () => {
  assert.equal(
    model.motifPhrase(motifOf('quarter', 1, [{ pitch: 60, step: 0, velocity: 80 }, { pitch: 64, step: 2, steps: 2, velocity: 100 }])),
    'note("c4 ~ e4 _").velocity("0.8 ~ 1 _")',
  );
  assert.equal(
    model.motifPhrase(motifOf('quarter', 1, [{ pitch: 60, step: 0 }, { pitch: 64, step: 0 }])),
    'note("[c4,e4] ~ ~ ~").velocity("0.8 ~ ~ ~")',
  );
  assert.equal(
    model.motifPhrase(motifOf('quarter', 1, [{ pitch: 60, step: 0, velocity: 80 }, { pitch: 64, step: 0, velocity: 50 }])),
    'stack(note("c4 ~ ~ ~").velocity("0.8 ~ ~ ~"), note("e4 ~ ~ ~").velocity("0.5 ~ ~ ~"))',
  );
  assert.equal(
    model.motifPhrase(motifOf('quarter', 2, [{ pitch: 60, step: 3, steps: 2 }])),
    'note("[~ ~ ~ c4 _ ~ ~ ~]/2").velocity("[~ ~ ~ 0.8 _ ~ ~ ~]/2")',
  );
  assert.equal(
    model.motifPhrase(motifOf('quarter', 1, [{ pitch: 61, step: 0, velocity: 1 }, { pitch: 12, step: 1, velocity: 100 }])),
    'note("c#4 c0 ~ ~").velocity("0.01 1 ~ ~")',
  );
});

test('the phrase does not depend on note ids or on the order the notes were placed', () => {
  const cells = [{ pitch: 60, step: 0 }, { pitch: 67, step: 2, steps: 3, velocity: 30 }, { pitch: 64, step: 2, steps: 3, velocity: 30 }, { pitch: 72, step: 9 }];
  const forward = model.motifPhrase(motifOf('sixteenth', 2, cells));
  const backward = model.motifPhrase(motifOf('sixteenth', 2, [...cells].reverse()));
  assert.equal(forward, backward);
  assert.match(forward, /\[e4,g4\]/, 'two voices of one length and velocity share a bracket');
});

test('the phrase writes the pitch names with a sharp sign, lowercase, C4 as 60', () => {
  const names = [[12, 'c0'], [59, 'b3'], [60, 'c4'], [61, 'c#4'], [66, 'f#4'], [119, 'b8']];
  for (const [pitch, name] of names) {
    assert.equal(model.motifPhrase(motifOf('quarter', 1, [{ pitch, step: 0 }])), `note("${name} ~ ~ ~").velocity("0.8 ~ ~ ~")`, name);
  }
});

test('the velocity is written as hundredths with trailing zeros dropped', () => {
  const words = [[1, '0.01'], [5, '0.05'], [10, '0.1'], [50, '0.5'], [80, '0.8'], [99, '0.99'], [100, '1']];
  for (const [velocity, word] of words) {
    assert.equal(model.motifPhrase(motifOf('quarter', 1, [{ pitch: 60, step: 0, velocity }])), `note("c4 ~ ~ ~").velocity("${word} ~ ~ ~")`, word);
  }
});

// A reader of the phrase form, small enough to trust: it turns a phrase back into { pitch, step, steps, velocity } and the motif's notes
// into the same list, so the two can be compared whatever the writer chose to do with brackets and lanes.
function readPhrase(code) {
  const lanes = [...code.matchAll(/note\("([^"]*)"\)\.velocity\("([^"]*)"\)/g)];
  const cells = [];
  for (const [, noteText, velocityText] of lanes) {
    const unwrap = (text) => {
      const slowed = /^\[(.*)\]\/\d+$/.exec(text);
      return (slowed === null ? text : slowed[1]).split(' ');
    };
    const notes = unwrap(noteText);
    const velocities = unwrap(velocityText);
    assert.equal(notes.length, velocities.length, 'the two strings are token for token');
    notes.forEach((token, step) => {
      if (token === '~' || token === '_') {
        assert.equal(velocities[step], token, 'the velocity string mirrors the rests and holds');
        return;
      }
      let steps = 1;
      while (notes[step + steps] === '_') steps += 1;
      const pitches = token.startsWith('[') ? token.slice(1, -1).split(',') : [token];
      for (const name of pitches) {
        const match = /^([a-g]#?)(\d)$/.exec(name);
        const pitch = ['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b'].indexOf(match[1]) + (Number(match[2]) + 1) * 12;
        cells.push({ pitch, step, steps, velocity: Math.round(Number(velocities[step]) * 100) });
      }
    });
  }
  return cells.sort((a, b) => a.step - b.step || a.pitch - b.pitch);
}

function cellsOf(motif) {
  const grid = gridOf(motif.grid);
  return motif.notes
    .map((note) => ({ pitch: note.pitch, step: note.start / grid.unit, steps: note.length / grid.unit, velocity: note.velocity }))
    .sort((a, b) => a.step - b.step || a.pitch - b.pitch);
}

test('a phrase read back gives the notes of the motif on every grid, with holds, chords and lanes', () => {
  let seed = 7;
  const next = (n) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  for (const grid of GRIDS) {
    for (const cycles of [1, 2, 5]) {
      let motif = { ...emptyMotif(), grid: grid.id, cycles };
      const total = grid.steps * cycles;
      for (let i = 0; i < 25; i += 1) {
        const step = next(total);
        const steps = 1 + next(Math.min(6, total - step));
        motif = model.placeNote(motif, { pitch: 48 + next(8), start: step * grid.unit, length: steps * grid.unit, velocity: [20, 80, 100][next(3)] }).motif;
      }
      const code = model.motifPhrase(motif);
      assert.doesNotThrow(() => model.assertPhraseCode(code));
      assert.deepEqual(readPhrase(code), cellsOf(motif), `${grid.id}, ${cycles} cycles`);
    }
  }
});

test('assertPhraseCode accepts the phrase form and refuses anything else', () => {
  const lane = 'note("c4 ~ e4 _").velocity("0.8 ~ 1 _")';
  assert.equal(model.assertPhraseCode(lane), lane);
  assert.equal(model.assertPhraseCode(`stack(${lane}, ${lane})`), `stack(${lane}, ${lane})`);
  for (const bad of [
    `${lane}.gain(2)`,
    `${lane}; evaluate()`,
    'note("c4").velocity("1").bank("x")',
    'note("c4 ~ x ~").velocity("1 ~ 1 ~")',
    'note("c4 $(x)").velocity("1")',
    'stack(note("c4").velocity("1"))',
    'sound("bd")',
    '',
  ]) {
    assert.throws(() => model.assertPhraseCode(bad), /Moontide: /, bad);
  }
  assert.throws(() => model.assertPhraseCode(7), /Moontide: /);
  assert.ok(model.PHRASE_SHAPE instanceof RegExp);
  assert.ok(model.PHRASE_SHAPE.test(lane));
  assert.ok(!model.PHRASE_SHAPE.test(`${lane}.gain(2)`));
});

test('the motif sources are played, drawn, tapped and mixed, in that order', () => {
  assert.deepEqual(model.MOTIF_SOURCES, ['played', 'drawn', 'tapped', 'mixed']);
  assert.ok(Object.isFrozen(model.MOTIF_SOURCES));
});

test('an empty motif has no source and no recorded moment', () => {
  const motif = emptyMotif();
  assert.equal(motif.source, null);
  assert.equal(motif.recorded, null);
});

test('placeNote marks an empty motif drawn, unless it is told how, and keeps the source for the same way', () => {
  const drawn = model.placeNote(emptyMotif(), { pitch: 60, start: 0, length: 3 });
  assert.equal(drawn.motif.source, 'drawn');
  assert.equal(model.placeNote(drawn.motif, { pitch: 62, start: 3, length: 3 }).motif.source, 'drawn');
  const tapped = model.placeNote(emptyMotif(), { pitch: 60, start: 0, length: 3 }, 'tapped');
  assert.equal(tapped.motif.source, 'tapped');
});

test('placing a note a different way into a motif that has notes makes it mixed, and mixed stays mixed', () => {
  const drawn = model.placeNote(emptyMotif(), { pitch: 60, start: 0, length: 3 }).motif;
  const mixed = model.placeNote(drawn, { pitch: 62, start: 3, length: 3 }, 'tapped').motif;
  assert.equal(mixed.source, 'mixed');
  assert.equal(model.placeNote(mixed, { pitch: 64, start: 6, length: 3 }).motif.source, 'mixed');
  assert.equal(model.placeNote(mixed, { pitch: 64, start: 6, length: 3 }, 'tapped').motif.source, 'mixed');
});

test('a note that changes nothing leaves the source alone, and moves and resizes keep it', () => {
  const tapped = model.placeNote(emptyMotif(), { pitch: 60, start: 0, length: 3 }, 'tapped').motif;
  const same = model.placeNote(tapped, { pitch: 60, start: 0, length: 3 });
  assert.equal(same.motif, tapped);
  const moved = model.moveNote(tapped, 1, { start: 6 }).motif;
  assert.equal(moved.source, 'tapped');
  assert.equal(model.resizeNote(moved, 1, 6).motif.source, 'tapped');
  assert.equal(model.setVelocity(moved, 1, 50).motif.source, 'tapped');
  assert.equal(model.setGrid(moved, 'quarter').motif.source, 'tapped');
  assert.equal(model.setCycles(moved, 3).motif.source, 'tapped');
});

test('motifMoment: a drawn motif takes the cycle where its first cycle stands, whole cycles of the motif at or below the music cycle', () => {
  const drawn = (cycles) => model.placeNote({ ...emptyMotif(), cycles }, { pitch: 60, start: 0, length: 3 }).motif;
  assert.equal(model.motifMoment(drawn(2), 13.6), 12);
  assert.equal(model.motifMoment(drawn(1), 13.6), 13);
  assert.equal(model.motifMoment(drawn(3), 0), 0);
  assert.equal(model.motifMoment(drawn(3), 2.99), 0);
  assert.equal(model.motifMoment(drawn(3), 3), 3);
  assert.equal(model.motifMoment(drawn(8), 40), 40);
  assert.equal(model.motifMoment(drawn(2), null), null, 'no cycle while the music is stopped');
  for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, '4', undefined]) {
    assert.throws(() => model.motifMoment(drawn(2), bad), /Moontide: /, String(bad));
  }
});

test('motifMoment: a recorded motif keeps the cycle where it was played, whatever the music cycle is', () => {
  const recorded = (cycle) => ({ ...model.placeNote(emptyMotif(), { pitch: 60, start: 0, length: 3 }).motif, source: 'played', recorded: { cycle } });
  assert.equal(model.motifMoment(recorded(21), 3), 21);
  assert.equal(model.motifMoment(recorded(21), null), 21);
  assert.equal(model.motifMoment(recorded(null), 3), null);
});

test('motifMoment: a recorded motif that a hand-placed note made mixed takes the cycle at the press, a whole multiple of its cycles', () => {
  // Two cycles recorded where the music was at cycle 8, then one drawn note; the music is at cycle 21.5 at the press.
  const recorded = { ...model.placeNote({ ...emptyMotif(), cycles: 2 }, { pitch: 60, start: 0, length: 3 }).motif, source: 'played', recorded: Object.freeze({ cycle: 8 }) };
  const mixed = model.placeNote(recorded, { pitch: 64, start: 6, length: 3 }).motif;
  assert.equal(mixed.source, 'mixed');
  assert.equal(model.motifMoment(mixed, 21.5), 20);
  assert.equal(model.motifRequest(mixed, 21.5).cycle, 20);
  assert.equal(model.motifMoment(mixed, null), null, 'no cycle while the music is stopped');
  const tapped = model.placeNote(recorded, { pitch: 64, start: 6, length: 3 }, 'tapped').motif;
  assert.equal(tapped.source, 'mixed');
  assert.equal(model.motifMoment(tapped, 7), 6);
  // Undo gives back the played motif, and with it the cycle where it was played.
  assert.equal(model.motifMoment(recorded, 21.5), 8);
});

test('motifRequest: null for an empty motif, else source, cycle, cycles, grid, notes and the phrase in that order', () => {
  assert.equal(model.motifRequest(emptyMotif(), 4), null);
  const motif = motifOf('quarter', 2, [{ pitch: 60, step: 0 }, { pitch: 64, step: 3 }]);
  const request = model.motifRequest(motif, 7.2);
  assert.deepEqual(request, { source: 'drawn', cycle: 6, cycles: 2, grid: 'quarter', notes: 2, phrase: model.motifPhrase(motif) });
  assert.deepEqual(Object.keys(request), ['source', 'cycle', 'cycles', 'grid', 'notes', 'phrase']);
});

test('motifRequest: with the music stopped there is no cycle key at all', () => {
  const request = model.motifRequest(motifOf('quarter', 1, [{ pitch: 60, step: 0 }]), null);
  assert.deepEqual(Object.keys(request), ['source', 'cycles', 'grid', 'notes', 'phrase']);
  assert.equal(Object.hasOwn(request, 'cycle'), false);
});

test('motifRequest: a motif with notes but no source is a bug and throws', () => {
  const motif = { ...emptyMotif(), notes: [{ id: 1, pitch: 60, start: 0, length: 3, velocity: 80 }], nextId: 2 };
  assert.throws(() => model.motifRequest(motif, 1), /Moontide: /);
});

test('the send copy: the strip labels, the default sentence and the sent lines', () => {
  assert.equal(SCRATCH_COPY.phraseLabel, 'Phrase of the motif');
  assert.equal(SCRATCH_COPY.wordsLabel, 'Words for Claude');
  assert.equal(SCRATCH_COPY.send, 'Send to Claude');
  assert.match(SCRATCH_COPY.sendTitle, /changes no code/);
  assert.equal(SCRATCH_COPY.phraseEmpty, 'No phrase yet: the motif has no notes.');
  assert.equal(SCRATCH_COPY.defaultWords, 'Add this motif to the music.');
  assert.equal(model.sentText({ cycle: 12 }), 'Sent to Claude at cycle 12. The Requests panel shows what becomes of it.');
  assert.equal(model.sentText({}), 'Sent to Claude with no moment. The Requests panel shows what becomes of it.');
});

test('the empty-roll sentence no longer says the Scratchpad sends nothing', () => {
  assert.doesNotMatch(SCRATCH_COPY.emptyBody, /sends nothing/);
  assert.match(SCRATCH_COPY.emptyBody, /Send to Claude/);
});

// --- the source of a motif through the other commands, and the refusal words ---

test('tapNote marks an empty motif tapped, and a drawn note placed into it makes it mixed', () => {
  const tapped = model.tapNote(emptyMotif(), { ts: 1500, h: 1500, anchors: TAP_ANCHORS, pitch: 60 });
  assert.equal(tapped.motif.source, 'tapped');
  assert.equal(model.tapNote(tapped.motif, { ts: 2500, h: 2500, anchors: TAP_ANCHORS, pitch: 64 }).motif.source, 'tapped');
  const mixed = model.placeNote(tapped.motif, { pitch: 70, start: 30, length: 3 });
  assert.equal(mixed.motif.source, 'mixed');
  const drawnThenTapped = model.tapNote(model.placeNote(emptyMotif(), { pitch: 70, start: 30, length: 3 }).motif, { ts: 1500, h: 1500, anchors: TAP_ANCHORS, pitch: 60 });
  assert.equal(drawnThenTapped.motif.source, 'mixed');
});

test('toggleAt and a drag draw, so they make a drawn motif', () => {
  assert.equal(toggleAt(emptyMotif(), { pitch: 60, unit: 0 }).motif.source, 'drawn');
});

test('erasing the last note clears the source and the recorded moment, and Undo of the erase brings the source back', () => {
  const recorded = model.recordBuffer(emptyMotif(), snap([played(60, 100, 0.5, 0.75)])).motif;
  assert.equal(recorded.source, 'played');
  const history = model.commit(model.createHistory(recorded), model.eraseNote(recorded, recorded.notes[0].id));
  assert.equal(history.present.notes.length, 0);
  assert.equal(history.present.source, null);
  assert.equal(history.present.recorded, null);
  const back = model.undo(history).motif;
  assert.equal(back.source, 'played');
  assert.deepEqual(back.recorded, { cycle: null });
  // Erasing one of two notes leaves the source.
  const two = model.placeNote(model.placeNote(emptyMotif(), { pitch: 60, start: 0, length: 3 }).motif, { pitch: 62, start: 3, length: 3 }).motif;
  assert.equal(model.eraseNote(two, 1).motif.source, 'drawn');
  assert.equal(model.toggleAt(model.placeNote(emptyMotif(), { pitch: 60, start: 0, length: 3 }).motif, { pitch: 60, unit: 0 }).motif.source, null);
});

test('recordBuffer marks the new motif played with a recorded moment whose cycle is null when no run is known, in place of what was there', () => {
  const drawn = model.placeNote(emptyMotif(), { pitch: 70, start: 0, length: 3 }).motif;
  const result = model.recordBuffer(drawn, snap([played(60, 100, 0.5, 0.75)]));
  assert.equal(result.motif.source, 'played');
  assert.deepEqual(result.motif.recorded, { cycle: null });
  assert.ok(Object.isFrozen(result.motif.recorded));
  // A drawn note placed into a recorded motif makes it mixed and keeps what was recorded.
  const mixed = model.placeNote(result.motif, { pitch: 72, start: 6, length: 3 });
  assert.equal(mixed.motif.source, 'mixed');
  assert.deepEqual(mixed.motif.recorded, { cycle: null });
  // The recorded motif has no moment of its own yet, whatever the music does.
  assert.equal(model.motifMoment(result.motif, 9), null);
  assert.equal(Object.hasOwn(model.motifRequest(result.motif, 9), 'cycle'), false);
  assert.equal(model.motifRequest(result.motif, 9).source, 'played');
});

test('moves, resizes, velocity, grid and cycle changes keep the recorded moment too', () => {
  const recorded = { ...model.recordBuffer(emptyMotif(), snap([played(60, 100, 0.5, 0.75)])).motif, recorded: Object.freeze({ cycle: 21 }) };
  const id = recorded.notes[0].id;
  for (const next of [
    model.moveNote(recorded, id, { start: recorded.notes[0].start + 3 }).motif,
    model.resizeNote(recorded, id, recorded.notes[0].length + 3).motif,
    model.setVelocity(recorded, id, 40).motif,
    model.setGrid(recorded, 'quarter').motif,
    model.setCycles(recorded, recorded.cycles + 1).motif,
  ]) {
    assert.equal(next.source, 'played');
    assert.deepEqual(next.recorded, { cycle: 21 });
  }
  assert.equal(model.motifMoment(recorded, 3), 21);
});

test('the refusal words become plain sentences, and an unknown word throws', () => {
  assert.equal(model.sendRefusalText({ refused: 'no-notes' }), 'Nothing to send: the motif has no notes.');
  assert.equal(model.sendRefusalText({ refused: 'empty-words' }), 'Nothing to send: write a few words for Claude first.');
  assert.equal(model.sendRefusalText({ refused: 'words-too-long', length: 2400, max: 2000 }), 'Not sent: the words are 2400 characters, 2000 at most.');
  assert.equal(model.sendRefusalText({ refused: 'disconnected' }), 'Not sent: the page is not connected to Moontide.');
  assert.equal(model.sendRefusalText({ refused: 'pending' }), 'Not sent: the last motif request is still on its way.');
  assert.equal(
    model.sendRefusalText({ refused: 'too-big', bytes: 9100, max: 8192 }),
    'Not sent: the request would be 9100 bytes, 8192 at most. Fewer cycles, a coarser grid, fewer notes sounding together or shorter words make it smaller.',
  );
  assert.throws(() => model.sendRefusalText({ refused: 'because' }), /^Error: Moontide: /);
  assert.throws(() => model.sendRefusalText({}), /^Error: Moontide: /);
});

test('motifResultText: a server refusal and an unconfirmed request have their sentences, an arrived one says nothing new', () => {
  assert.equal(model.motifResultText({ status: 'refused', text: 'too many requests — wait a moment, then send again.' }), 'Not sent: too many requests — wait a moment, then send again.');
  assert.equal(model.motifResultText({ status: 'not-confirmed' }), 'Moontide did not confirm the motif request. Try again.');
  assert.equal(model.motifResultText({ status: 'received' }), null);
  assert.equal(model.motifResultText({ status: 'waiting' }), "It waits until Claude's next Moontide call; Send can send another motif meanwhile.");
  assert.throws(() => model.motifResultText({ status: 'later' }), /^Error: Moontide: /);
});

// --- Several notes at once: move, resize, erase and velocity as one command, and one undo step per key press ---

/** Three C-major notes of the same length at 0, 12 and 24 on sixteenths: ids 1 to 3. */
const triad = () => motifWith([1, 60, 0, 3], [2, 64, 12, 3], [3, 67, 24, 3, 60]);

test('moveNotes moves every given note by the same start and pitch in one result with one what phrase', () => {
  const motif = triad();
  const moved = model.moveNotes(motif, [1, 2, 3], { dStart: 6, dPitch: 2 });
  assert.deepEqual(plain(moved.motif), [[1, 62, 6, 3, 80], [2, 66, 18, 3, 80], [3, 69, 30, 3, 60]]);
  assert.equal(moved.what, 'moved 3 notes');
  assert.equal(moved.notice, 'Moved the motif 2 sixteenths later and up 2 semitones.');
  assert.equal(moved.refused, undefined);
  assert.deepEqual([moved.cut, moved.merged], [0, 0]);
  assert.ok(Object.isFrozen(moved.motif) && Object.isFrozen(moved.motif.notes));
  assert.equal(motif.notes[0].start, 0, 'the motif given is not changed');
});

test('moveNotes names the count for a part of the motif, in the grid words, octaves and semitones', () => {
  const motif = triad();
  assert.equal(model.moveNotes(motif, [1, 2], { dStart: 3 }).notice, 'Moved 2 notes one sixteenth later.');
  assert.equal(model.moveNotes(motif, [2, 3], { dStart: -12 }).notice, 'Moved 2 notes 4 sixteenths earlier.');
  assert.equal(model.moveNotes(motif, [1, 2], { dPitch: 12 }).notice, 'Moved 2 notes up one octave.');
  assert.equal(model.moveNotes(motif, [1, 2], { dPitch: -24 }).notice, 'Moved 2 notes down 2 octaves.');
  assert.equal(model.moveNotes(motif, [1, 2], { dPitch: 1 }).notice, 'Moved 2 notes up one semitone.');
  assert.equal(model.moveNotes(motif, [1, 2], { dPitch: -3 }).notice, 'Moved 2 notes down 3 semitones.');
  const eighths = Object.freeze({ ...motif, grid: 'eighth', notes: Object.freeze([Object.freeze({ id: 1, pitch: 60, start: 12, length: 6, velocity: 80 })]) });
  assert.equal(model.moveNotes(Object.freeze({ ...eighths, notes: Object.freeze([...eighths.notes, Object.freeze({ id: 2, pitch: 62, start: 24, length: 6, velocity: 80 })]) }), [1, 2], { dStart: -6 }).notice, 'Moved the motif one eighth earlier.');
});

test('moveNotes of one note says where it stands, like moveNote', () => {
  const motif = triad();
  assert.equal(model.moveNotes(motif, [1], { dStart: 3 }).notice, 'Moved C4 to cycle 1, beat 1.25.');
  assert.equal(model.moveNotes(motif, [1], { dStart: 3, dPitch: 1 }).notice, 'Moved C4 to C#4 at cycle 1, beat 1.25.');
  assert.equal(model.moveNotes(motif, [1], { dStart: 3 }).what, 'moved C4');
  assert.equal(model.moveNotes(motif, [1], { dStart: 3, dPitch: 1 }).what, 'moved C#4');
});

test('moveNotes runs the same-pitch rule once: a group that moves over its own former places cuts and merges nothing', () => {
  const motif = motifWith([1, 60, 0, 3], [2, 60, 3, 3], [3, 60, 6, 3]);
  const moved = model.moveNotes(motif, [1, 2, 3], { dStart: 3 });
  assert.deepEqual(plain(moved.motif), [[1, 60, 3, 3, 80], [2, 60, 6, 3, 80], [3, 60, 9, 3, 80]]);
  assert.deepEqual([moved.cut, moved.merged], [0, 0]);
  const partial = model.moveNotes(motif, [1, 2], { dStart: 3 });
  assert.equal(partial.merged, 1, 'a note that stays can still be met by the group');
  assert.match(partial.notice, /Merged with the note there/);
});

test('moveNotes refuses a move that would push any note out of the motif or out of C0 to B8, and changes nothing', () => {
  const motif = triad();
  const refusal = (ids, change) => model.moveNotes(motif, ids, change);
  for (const [result, sentence] of [
    [refusal([1, 2], { dStart: -3 }), 'Not moved: the first note is already at the start of the motif.'],
    [refusal([2, 3], { dStart: 72 }), 'Not moved: the last note already ends at the end of the motif.'],
    [refusal([1, 2, 3], { dPitch: 53 }), 'Not moved: a note is already at the highest pitch.'],
    [refusal([1, 2, 3], { dPitch: -49 }), 'Not moved: a note is already at the lowest pitch.'],
    [refusal([1, 2], { dStart: -3, dPitch: 1 }), 'Not moved: the first note is already at the start of the motif.'],
  ]) {
    assert.equal(result.refused, sentence);
    assert.equal(result.motif, motif);
    assert.equal(result.what, '');
    assert.equal(result.notice, '');
  }
  assert.equal(model.moveNotes(motif, [2, 3], { dStart: -12 }).refused, undefined, 'a note at 12 can go to 0');
  assert.equal(model.moveNotes(motif, [3], { dStart: 69 }).refused, undefined);
  assert.equal(model.moveNotes(motif, [1, 2, 3], { dStart: 72 }).refused, 'Not moved: the last note already ends at the end of the motif.');
});

test('moveNotes with no distance changes nothing, and a bad argument throws', () => {
  const motif = triad();
  const none = model.moveNotes(motif, [1, 2], { dStart: 0, dPitch: 0 });
  assert.deepEqual([none.motif === motif, none.notice, none.what], [true, '', '']);
  assert.throws(() => model.moveNotes(motif, [1, 9], { dStart: 3 }), /no note with id 9/);
  assert.throws(() => model.moveNotes(motif, [], { dStart: 3 }), /at least one note/);
  assert.throws(() => model.moveNotes(motif, [1], { dStart: 2 }), /3 units/);
  assert.throws(() => model.moveNotes(motif, [1], { dStart: 1.5 }), /whole number/);
  assert.throws(() => model.moveNotes(motif, [1], { dPitch: 0.5 }), /whole number/);
});

test('resizeNotes changes every note by the same number of steps, each held between one step and the motif\'s end', () => {
  const motif = motifWith([1, 60, 0, 6], [2, 64, 12, 3], [3, 67, 90, 6]);
  const longer = model.resizeNotes(motif, [1, 2, 3], 2);
  assert.deepEqual(plain(longer.motif).map((note) => note[3]), [12, 9, 6], 'the note at the end of the motif stays put');
  assert.equal(longer.what, 'changed the length of 3 notes');
  assert.equal(longer.notice, 'Made 3 notes 2 sixteenths longer.');
  const shorter = model.resizeNotes(motif, [1, 2, 3], -1);
  assert.deepEqual(plain(shorter.motif).map((note) => note[3]), [3, 3, 3], 'one step is the shortest');
  assert.equal(shorter.notice, 'Made 3 notes one sixteenth shorter.');
  const same = model.resizeNotes(motif, [2], -1);
  assert.deepEqual([same.motif === motif, same.notice, same.what], [true, '', ''], 'no change gives the same motif and an empty notice');
  assert.equal(model.resizeNotes(motif, [1, 2], 0).motif, motif);
});

test('resizeNotes of one note says its new length, and a note stops where the next of its pitch starts', () => {
  const motif = motifWith([1, 60, 0, 3], [2, 60, 9, 3]);
  const one = model.resizeNotes(motif, [1], 1);
  assert.equal(one.notice, 'C4 now lasts 2 sixteenths (0.5 beat).');
  assert.equal(one.what, 'changed the length of C4');
  const cut = model.resizeNotes(motif, [1], 5);
  assert.equal(cut.cut, 1);
  assert.deepEqual(plain(cut.motif).map((note) => note[3]), [9, 3]);
  assert.match(cut.notice, /1 note cut where a note of the same pitch starts\.$/);
});

test('eraseNotes removes the given notes in one step; the last note going clears source and recorded', () => {
  const motif = Object.freeze({ ...triad(), source: 'played', recorded: Object.freeze({ cycle: 4 }) });
  const some = model.eraseNotes(motif, [1, 3]);
  assert.deepEqual(plain(some.motif), [[2, 64, 12, 3, 80]]);
  assert.equal(some.what, 'erased 2 notes');
  assert.equal(some.notice, 'Erased 2 notes. Undo brings them back.');
  assert.deepEqual([some.motif.source, some.motif.recorded.cycle], ['played', 4]);
  const all = model.eraseNotes(motif, [1, 2, 3]);
  assert.deepEqual(plain(all.motif), []);
  assert.deepEqual([all.motif.source, all.motif.recorded], [null, null]);
  assert.equal(all.notice, 'Erased 3 notes. Undo brings them back.');
  const one = model.eraseNotes(motif, [2]);
  assert.equal(one.notice, 'Erased E4 at cycle 1, beat 2. Undo brings it back.');
  assert.equal(one.what, 'erased E4');
  assert.throws(() => model.eraseNotes(motif, [9]), /no note with id 9/);
  assert.throws(() => model.eraseNotes(motif, []), /at least one note/);
});

test('setVelocities changes every given note by the same delta, held from 1 to 100, in one step', () => {
  const motif = triad();
  const up = model.setVelocities(motif, [1, 2, 3], 5);
  assert.deepEqual(plain(up.motif).map((note) => note[4]), [85, 85, 65]);
  assert.equal(up.what, 'changed the velocity of 3 notes');
  assert.equal(up.notice, 'Raised the velocity of 3 notes by 0.05.');
  assert.equal(model.setVelocities(motif, [1, 2], -1).notice, 'Lowered the velocity of 2 notes by 0.01.');
  const top = model.setVelocities(motifWith([1, 60, 0, 3, 98], [2, 62, 3, 3, 100]), [1, 2], 5);
  assert.deepEqual(plain(top.motif).map((note) => note[4]), [100, 100]);
  const same = model.setVelocities(motifWith([1, 60, 0, 3, 100]), [1], 5);
  assert.deepEqual([same.notice, same.what], ['', '']);
  assert.equal(model.setVelocities(motif, [1], 5).notice, 'C4 velocity 0.85.');
  assert.equal(model.setVelocities(motif, [1], 5).what, 'changed the velocity of C4');
  assert.throws(() => model.setVelocities(motif, [1], 0.5), /whole number/);
});

test('commit with amend replaces the present and the phrase of the last step and adds no entry', () => {
  const motif = triad();
  let history = model.createHistory(motif);
  history = model.commit(history, model.moveNotes(motif, [1, 2, 3], { dStart: 3 }));
  assert.equal(history.past.length, 1);
  const again = model.moveNotes(motif, [1, 2, 3], { dStart: 6 });
  const amended = model.commit(history, again, { amend: true });
  assert.equal(amended.past.length, 1, 'no new entry');
  assert.equal(amended.present, again.motif);
  assert.equal(amended.past[0].motif, motif, 'the entry still goes back to the motif before the first press');
  assert.equal(amended.past[0].what, 'moved 3 notes');
  const undone = model.undo(amended);
  assert.equal(undone.motif, motif);
  assert.equal(undone.notice, 'Undid: moved 3 notes.');
  assert.equal(undone.history.future.length, 1);
});

test('commit with amend clears the redo list, adds nothing for a result that did not change the motif, and is a plain commit without a past', () => {
  const motif = triad();
  let history = model.commit(model.createHistory(motif), model.moveNotes(motif, [1], { dStart: 3 }));
  history = model.undo(history).history;
  assert.equal(history.future.length, 1);
  const first = model.commit(history, model.moveNotes(motif, [2], { dStart: 3 }), { amend: true });
  assert.equal(first.past.length, 1, 'with no past entry an amend adds the step like any commit');
  assert.equal(first.future.length, 0);
  const amended = model.commit(first, model.moveNotes(motif, [2], { dStart: 6 }), { amend: true });
  assert.deepEqual([amended.past.length, amended.future.length], [1, 0]);
  assert.equal(model.commit(amended, { motif: amended.present, notice: '', what: '' }, { amend: true }), amended);
  assert.equal(model.commit(amended, model.moveNotes(motif, [1, 2], { dStart: -3 }), { amend: true }), amended, 'a refusal changes nothing');
});

test('the selection sentences use the 1 note and N notes forms', () => {
  const motif = triad();
  assert.equal(model.selectionText({ kind: 'all', count: 3 }), 'Selected all 3 notes.');
  assert.equal(model.selectionText({ kind: 'all', count: 1 }), 'Selected the only note.');
  assert.equal(model.selectionText({ kind: 'all', count: 0 }), 'No notes to select.');
  assert.equal(model.selectionText({ kind: 'none' }), 'Selected none.');
  assert.equal(model.selectionText({ kind: 'added', name: 'C4', count: 3 }), 'Selected C4. 3 notes selected.');
  assert.equal(model.selectionText({ kind: 'added', name: 'C4', count: 1 }), 'Selected C4. 1 note selected.');
  assert.equal(model.selectionText({ kind: 'removed', name: 'C4', count: 2 }), 'Removed C4 from the selection. 2 notes selected.');
  assert.equal(model.selectionText({ kind: 'removed', name: 'C4', count: 0 }), 'Removed C4 from the selection. Nothing selected.');
  assert.equal(model.selectionText({ kind: 'nothing-here' }), 'No note here to select.');
  assert.throws(() => model.selectionText({ kind: 'sideways' }), /does not know/);
  assert.deepEqual(model.selectionParts(motif, [1, 2, 3]), { name: '3 notes selected', rest: ' · C4 to G4 · from cycle 1, beat 1' });
  assert.deepEqual(model.selectionParts(motif, [2, 3]), { name: '2 notes selected', rest: ' · E4 to G4 · from cycle 1, beat 2' });
  assert.deepEqual(model.selectionParts(motifWith([1, 60, 0, 3], [2, 60, 12, 3]), [1, 2]), { name: '2 notes selected', rest: ' · C4 · from cycle 1, beat 1' });
});

test('neighborNote finds the previous or next note in time order from a cursor, and null at the ends', () => {
  const motif = motifWith([1, 60, 0, 3], [2, 64, 12, 3], [3, 67, 12, 3], [4, 62, 24, 3]);
  const next = (unit, pitch) => model.neighborNote(motif, { unit, pitch }, 1)?.id ?? null;
  const previous = (unit, pitch) => model.neighborNote(motif, { unit, pitch }, -1)?.id ?? null;
  assert.equal(next(0, 60), 2);
  assert.equal(next(12, 64), 3, 'a chord is walked from the lower pitch to the higher');
  assert.equal(next(12, 67), 4);
  assert.equal(next(24, 62), null);
  assert.equal(next(6, 80), 2, 'from an empty cell: the next note in time');
  assert.equal(previous(12, 67), 2);
  assert.equal(previous(12, 64), 1);
  assert.equal(previous(0, 60), null);
  assert.equal(previous(30, 10), 4);
});

// --- Align and Clear ---

/** A motif on eighth triplets (a step is 4 units) with these notes (id, pitch, start, length, velocity). */
const triplets = (...notes) => Object.freeze({ ...motifWith(...notes), grid: 'eighth-triplet' });

test('alignMotif moves the first note to the nearest beat: earlier from 4, later from 8, and a tie goes to the earlier beat', () => {
  const startOf = (first) => model.alignMotif(triplets([1, 60, first, 4], [2, 64, first + 8, 4])).motif.notes.map((note) => note.start);
  assert.deepEqual(startOf(4), [0, 8], 'from 4 units, 4 earlier');
  assert.deepEqual(startOf(8), [12, 20], 'from 8 units, 4 later');
  assert.deepEqual(startOf(24), [24, 32], 'a first note on a beat stays');
  const tie = model.alignMotif(motifWith([1, 60, 6, 3], [2, 64, 15, 3]));
  assert.deepEqual(tie.motif.notes.map((note) => note.start), [0, 9], 'an exact half (6 units) goes to the earlier beat');
  const tieLater = model.alignMotif(motifWith([1, 60, 18, 3]));
  assert.deepEqual(tieLater.motif.notes.map((note) => note.start), [12], '18 units is a half too: the earlier beat, 12');
  assert.deepEqual(model.alignMotif(motifWith([1, 60, 21, 3])).motif.notes.map((note) => note.start), [24], 'past the half goes later');
});

test('alignMotif at unit 0 or 12 changes nothing and says the first note is on a beat', () => {
  for (const first of [0, 12, 36]) {
    const motif = motifWith([1, 60, first, 3]);
    const result = model.alignMotif(motif);
    assert.equal(result.motif, motif, String(first));
    assert.equal(result.notice, 'Already aligned: the first note is on a beat.');
    assert.equal(result.what, '');
    assert.equal(result.refused, undefined);
  }
});

test('alignMotif keeps every length, pitch, velocity and the spacing, and says how far and where the first note is now', () => {
  const motif = motifWith([1, 60, 18, 6, 50], [2, 64, 27, 3, 100], [3, 67, 48, 12, 20]);
  const result = model.alignMotif(motif);
  assert.deepEqual(plain(result.motif), [[1, 60, 12, 6, 50], [2, 64, 21, 3, 100], [3, 67, 42, 12, 20]]);
  assert.equal(result.what, 'aligned the motif');
  assert.equal(result.notice, 'Aligned: the motif moved 2 sixteenths earlier, so its first note is on cycle 1, beat 2.');
  assert.deepEqual([result.cut, result.merged], [0, 0]);
  assert.equal(result.motif.nextId, motif.nextId);
  const later = model.alignMotif(motifWith([1, 60, 21, 3]));
  assert.equal(later.notice, 'Aligned: the motif moved one sixteenth later, so its first note is on cycle 1, beat 3.');
  const history = model.commit(model.createHistory(motif), result);
  assert.equal(history.past.length, 1, 'one undo step');
  assert.equal(model.undo(history).notice, 'Undid: aligned the motif.');
});

test('alignMotif refuses when moving later would push the last note past the end of the motif, and when there are no notes', () => {
  const crowded = triplets([1, 60, 8, 4], [2, 64, 92, 4]);
  const refused = model.alignMotif(crowded);
  assert.equal(refused.refused, 'Not aligned: the last note would pass the end of the motif. Make the motif longer, or move the last note earlier first.');
  assert.equal(refused.motif, crowded);
  assert.equal(refused.what, '');
  const empty = model.alignMotif(emptyMotif());
  assert.equal(empty.refused, 'Nothing to align: the roll has no notes.');
  assert.equal(empty.motif.notes.length, 0);
  assert.equal(model.commit(model.createHistory(crowded), refused).past.length, 0);
});

test('alignMotif of a played motif keeps the cycle its request carries and shifts only the phrase', () => {
  const played = (pitch, start, end) => ({ pitch, velocity: 100, start, end, run: 0 });
  const recorded = model.recordBuffer(emptyMotif(), { start: 8, cycles: 8, notes: [played(60, 2.3, 2.4), played(64, 2.55, 2.65)] }).motif;
  assert.equal(recorded.source, 'played');
  assert.ok(recorded.notes[0].start % 12 !== 0, 'the played motif starts off the beat');
  const aligned = model.alignMotif(recorded);
  assert.notEqual(aligned.motif, recorded);
  assert.equal(aligned.motif.source, 'played');
  assert.deepEqual(aligned.motif.recorded, recorded.recorded);
  const before = model.motifRequest(recorded, 5);
  const after = model.motifRequest(aligned.motif, 5);
  assert.equal(after.cycle, before.cycle, 'the moment sent stays right');
  assert.notEqual(after.phrase, before.phrase, 'only the phrase changes');
  assert.deepEqual({ ...after, phrase: '' }, { ...before, phrase: '' });
});

test('clearMotif removes every note in one step and keeps grid, cycles and nextId; source and recorded go', () => {
  const motif = Object.freeze({ ...triad(), cycles: 3, grid: 'eighth', source: 'played', recorded: Object.freeze({ cycle: 9 }), nextId: 40 });
  const result = model.clearMotif(motif);
  assert.deepEqual(plain(result.motif), []);
  assert.deepEqual([result.motif.cycles, result.motif.grid, result.motif.nextId, result.motif.source, result.motif.recorded], [3, 'eighth', 40, null, null]);
  assert.equal(result.notice, 'Cleared 3 notes. Undo brings them back.');
  assert.equal(result.what, 'cleared the roll');
  assert.ok(Object.isFrozen(result.motif));
  const one = model.clearMotif(motifWith([1, 60, 0, 3]));
  assert.equal(one.notice, 'Cleared 1 note. Undo brings it back.');
  const history = model.commit(model.createHistory(motif), result);
  assert.equal(model.undo(history).motif, motif, 'Undo brings the notes back');
});

test('clearMotif of an empty roll refuses with its sentence and adds no step', () => {
  const empty = emptyMotif();
  const result = model.clearMotif(empty);
  assert.equal(result.refused, 'Nothing to clear: the roll has no notes.');
  assert.equal(result.motif, empty);
  assert.equal(model.commit(model.createHistory(empty), result).past.length, 0);
});

test('the Edit group words are in the copy', () => {
  assert.deepEqual(
    [SCRATCH_COPY.editGroup, SCRATCH_COPY.earlier, SCRATCH_COPY.later, SCRATCH_COPY.align, SCRATCH_COPY.clear],
    ['Edit', 'Earlier', 'Later', 'Align', 'Clear'],
  );
  assert.equal(SCRATCH_COPY.earlierName, 'Move the selection, or the whole motif, one grid step earlier');
  assert.equal(SCRATCH_COPY.laterName, 'Move the selection, or the whole motif, one grid step later');
  assert.equal(SCRATCH_COPY.alignName, 'Align the motif so its first note falls on the nearest beat');
  assert.match(SCRATCH_COPY.alignTitle, /key l/);
  assert.equal(SCRATCH_COPY.clearName, 'Clear the roll');
  assert.equal(SCRATCH_COPY.moveNothing, 'Nothing to move: the roll has no notes.');
});

// --- Listen: the schedule, the menu and the sentences ---

test('listenSchedule gives the notes as timed on and off events, offs first at one moment, velocities as MIDI bytes', () => {
  const motif = motifWith([1, 60, 0, 3, 80], [2, 64, 3, 3, 100]);
  assert.deepEqual(model.listenSchedule(motif), [
    { unit: 0, kind: 'on', pitch: 60, velocity: 102 },
    { unit: 3, kind: 'off', pitch: 60, velocity: 0 },
    { unit: 3, kind: 'on', pitch: 64, velocity: 127 },
    { unit: 6, kind: 'off', pitch: 64, velocity: 0 },
  ]);
});

test('listenSchedule of an empty motif gives no event, and a velocity of 1 hundredth still gives a byte of 1', () => {
  assert.deepEqual(model.listenSchedule(emptyMotif()), []);
  assert.equal(model.listenSchedule(motifWith([1, 60, 0, 3, 1]))[0].velocity, 1);
});

test('listenSchedule orders by unit, offs before ons, and a chord by pitch', () => {
  const motif = motifWith([1, 67, 0, 6], [2, 60, 0, 3], [3, 64, 0, 6], [4, 60, 3, 3]);
  const events = model.listenSchedule(motif);
  assert.deepEqual(
    events.map((event) => `${event.unit}:${event.kind}:${event.pitch}`),
    ['0:on:60', '0:on:64', '0:on:67', '3:off:60', '3:on:60', '6:off:60', '6:off:64', '6:off:67'],
  );
});

test('listenOptions gives one option for each channel an instrument uses, with the id and the channel in the text and the port in the title', () => {
  const rig = {
    setup: 'valid',
    instruments: [
      { id: 'mt32', port: 'Port A', enabled: true, channels: [{ channel: 10, role: 'rhythm' }, { channel: 2, role: 'melodic' }, { channel: 2, role: 'rhythm' }] },
      { id: 'jx', port: 'Port B', enabled: false, channels: [{ channel: 1, role: 'melodic' }] },
    ],
  };
  const options = model.listenOptions(rig);
  assert.deepEqual(options.map((option) => [option.value, option.text, option.title, option.instrumentId, option.channel, option.enabled, option.port]), [
    ['mt32|2', 'mt32 · channel 2', 'mt32 · channel 2 · Port A', 'mt32', 2, true, 'Port A'],
    ['mt32|10', 'mt32 · channel 10', 'mt32 · channel 10 · Port A', 'mt32', 10, true, 'Port A'],
    ['jx|1', 'jx · channel 1', 'jx · channel 1 · Port B', 'jx', 1, false, 'Port B'],
  ]);
});

test('listenOptions of a setup file that is absent or has a problem, or of no rig, gives none; a long name is cut at the name limit', () => {
  assert.deepEqual(model.listenOptions({ setup: 'absent', instruments: [] }), []);
  assert.deepEqual(model.listenOptions({ setup: 'invalid', instruments: [] }), []);
  assert.deepEqual(model.listenOptions(null), []);
  assert.deepEqual(model.listenOptions({ setup: 'valid', instruments: [] }), []);
  const long = 'x'.repeat(300);
  const [option] = model.listenOptions({ setup: 'valid', instruments: [{ id: 'a', port: long, enabled: true, channels: [{ channel: 1, role: 'melodic' }] }] });
  assert.equal(Array.from(option.title).length, 'a · channel 1 · '.length + 200);
  assert.ok(option.title.endsWith('…'));
});

test('hearText gives the state sentences of a Listen that needs no clock, the instrument id apart from the rest', () => {
  const at = { instrumentId: 'sc55', channel: 3 };
  assert.deepEqual(model.hearText({ kind: 'choose' }), { before: 'Choose an instrument to listen on.', id: '', after: '' });
  assert.equal(model.hearText({ kind: 'refused', refused: 'empty' }).before, 'Nothing to listen to: the motif has no notes.');
  assert.deepEqual(model.hearText({ kind: 'playing', ...at, loop: false }), { before: 'Playing on ', id: 'sc55', after: ', channel 3.' });
  assert.deepEqual(model.hearText({ kind: 'playing', ...at, loop: true }), { before: 'Playing on ', id: 'sc55', after: ', channel 3, in a loop.' });
  assert.deepEqual(model.hearText({ kind: 'ended', ...at }), { before: 'Played once on ', id: 'sc55', after: ', channel 3.' });
  assert.equal(model.hearText({ kind: 'stopped', reason: 'stop', ...at }).before, 'Stopped. Held notes are silent.');
});

test('hearText says why there is no instrument, in the words of the setup file state', () => {
  assert.equal(model.hearText({ kind: 'no-instrument', setup: 'valid' }).before, 'No instrument to listen on: instruments.json names none.');
  assert.equal(model.hearText({ kind: 'no-instrument', setup: 'absent' }).before, 'No instrument to listen on: there is no instruments.json.');
  assert.equal(model.hearText({ kind: 'no-instrument', setup: 'invalid' }).before, 'No instrument to listen on: instruments.json has a problem. The MIDI popover shows it.');
});

test('hearText says every refusal of the page in one sentence, with the port and the names as plain text', () => {
  const at = { instrumentId: 'sc55', channel: 3, port: 'Port A' };
  const words = (refused, more = {}) => model.hearText({ kind: 'refused', refused, ...at, ...more });
  assert.deepEqual(words('no-output', { names: ['Port B', 'Port C'] }), { before: 'Not played: no MIDI output contains the name Port A. Outputs here: Port B, Port C.', id: '', after: '' });
  assert.equal(words('no-output', { names: [] }).before, 'Not played: no MIDI output contains the name Port A. Outputs here: none.');
  assert.equal(words('ambiguous', { count: 2 }).before, 'Not played: 2 MIDI outputs contain the name Port A, so the page cannot tell them apart.');
  assert.deepEqual(words('off'), { before: 'Not played: ', id: 'sc55', after: ' is switched off in the Instruments view.' });
  assert.deepEqual(words('resetting'), { before: 'Not played: ', id: 'sc55', after: ' is being reset or was just plugged in again. Try again in a moment.' });
  assert.equal(words('superseded').before, 'Not played: another Moontide tab has the music. Take it back to listen here.');
  assert.equal(words('no-rig').before, 'Not played: there is no valid instruments.json.');
  assert.deepEqual(words('no-instrument'), { before: 'Not played: instruments.json does not name an instrument ', id: 'sc55', after: '.' });
  assert.equal(words('tempo').before, 'Not played: the tempo is not above 0.');
  assert.equal(words('invalid').before, 'Not played: the note could not be sent to the MIDI output.');
  assert.equal(words('send-failed').before, 'Not played: the MIDI output refused the note.');
  assert.equal(words('no-output', { names: ['Port B'], mid: true }).before, 'Stopped: Port A is no longer connected.');
  assert.throws(() => words('nope'), /does not know/);
  assert.throws(() => model.hearText({ kind: 'nope' }), /is not known/);
});

test('the Listen copy names the strip, the menu and the buttons', () => {
  assert.deepEqual(
    [SCRATCH_COPY.hearGroup, SCRATCH_COPY.hearOutputName, SCRATCH_COPY.hearOutputPlaceholder, SCRATCH_COPY.hearStartGroup, SCRATCH_COPY.hearStartMusic, SCRATCH_COPY.hearStartNow, SCRATCH_COPY.loop, SCRATCH_COPY.listen, SCRATCH_COPY.stop],
    ['Hear the motif', 'Instrument and channel', 'Choose an instrument', 'Start', 'In the music', 'At once', 'Loop', 'Listen', 'Stop'],
  );
  assert.equal(SCRATCH_COPY.listenTitle, 'Play the motif on the chosen instrument. Nothing is sent to Claude and the code does not change.');
  assert.equal(SCRATCH_COPY.hearStartMusicTitle, 'Start on the next cycle line of the music, so the motif is heard in context.');
  assert.equal(SCRATCH_COPY.hearStartNowTitle, 'Start now, whatever the music does.');
});

// --- Listen: the waiting sentences, the stops and the permission ---

test('hearText says the wait, naming the music cycle and the instrument', () => {
  assert.deepEqual(model.hearText({ kind: 'waiting', instrumentId: 'sc55', channel: 3, cycle: 13 }), {
    before: 'Waiting for cycle 13 of the music, then playing on ',
    id: 'sc55',
    after: ', channel 3. Stop cancels.',
  });
  assert.equal(model.hearText({ kind: 'asking' }).before, 'Waiting for the answer to the MIDI permission.');
});

test('hearText says every reason a play was stopped or could not start in one plain sentence', () => {
  const stopped = (reason) => model.hearText({ kind: 'stopped', reason, instrumentId: 'sc55', channel: 3 });
  assert.equal(stopped('stop').before, 'Stopped. Held notes are silent.');
  assert.equal(stopped('hidden').before, 'Stopped: this tab was hidden, and a hidden tab cannot keep time.');
  assert.equal(stopped('music-stopped').before, 'Stopped: the music stopped, so there is no cycle line to play on.');
  assert.equal(stopped('closed').before, 'Stopped: the Scratchpad was closed.');
  assert.equal(stopped('page').before, 'Stopped: the page was left.');
  assert.throws(() => stopped('nope'), /is not known/);
  const refused = (word, more = {}) => model.hearText({ kind: 'refused', refused: word, instrumentId: 'sc55', channel: 3, ...more }).before;
  assert.equal(refused('music-not-playing'), 'The music is not playing, so there is no cycle line to wait for. Press Play, or choose At once.');
  assert.equal(refused('no-clock'), "Not played: the music's clock gives no time for the next cycle line yet. Try again in a moment.");
  assert.equal(refused('denied'), "Not played: MIDI was refused for this page. Allow it in the browser's site settings, then reload.");
  assert.equal(refused('unsupported'), 'Not played: this browser has no Web MIDI.');
  assert.equal(refused('failed', { failure: 'AbortError' }), 'Not played: MIDI could not start (AbortError).');
});

test('the select hint ends by saying Listen plays the motif, and no sentence of the copy says the Scratchpad makes no sound any more', () => {
  assert.equal(SCRATCH_COPY.hintSelect, 'Click or drag to select. Double-click or Enter writes a note. Delete erases. Listen plays the motif.');
  assert.equal(
    SCRATCH_COPY.emptyBody,
    'Double-click the grid or press Enter to write a note, or turn Draw on and drag. Play a MIDI keyboard and press Record that. Listen plays the motif on an instrument you choose; the motif is sent only when Send to Claude is pressed.',
  );
  for (const [name, sentence] of Object.entries(SCRATCH_COPY)) assert.doesNotMatch(sentence, /\bno sound\b|makes no sound|plays no sound/i, `${name} must not say the Scratchpad is silent`);
});

// --- the Heads up warnings of the hear strip: a chord on an instrument that plays one note at a time ---

test('hasChord is false for an empty motif and for notes one after another, even touching, and true for two notes that overlap in time', () => {
  assert.equal(model.hasChord(emptyMotif()), false);
  assert.equal(model.hasChord(motifWith([1, 60, 0, 6])), false, 'one note');
  assert.equal(model.hasChord(motifWith([1, 60, 0, 6], [2, 64, 6, 6])), false, 'the second starts where the first ends');
  assert.equal(model.hasChord(motifWith([1, 60, 0, 6], [2, 64, 12, 6])), false, 'a gap');
  assert.equal(model.hasChord(motifWith([1, 60, 0, 6], [2, 64, 0, 6])), true, 'two notes that start together');
  assert.equal(model.hasChord(motifWith([1, 60, 0, 12], [2, 64, 6, 3])), true, 'a note that starts inside a longer one');
  assert.equal(model.hasChord(motifWith([1, 60, 0, 12], [2, 64, 3, 3], [3, 67, 18, 3])), true, 'the overlap sits between the first two');
  assert.equal(model.hasChord(motifWith([2, 64, 6, 6], [1, 60, 0, 7])), true, 'the notes need not come in time order');
});

test('listenOptions carries monophonic from the rig, true only when the rig says true', () => {
  const rig = {
    setup: 'valid',
    instruments: [
      { id: 'lead', port: 'Port A', enabled: true, monophonic: true, channels: [{ channel: 1, role: 'melodic' }] },
      { id: 'wide', port: 'Port B', enabled: true, monophonic: false, channels: [{ channel: 2, role: 'melodic' }] },
      { id: 'unsaid', port: 'Port C', enabled: true, channels: [{ channel: 3, role: 'melodic' }] },
    ],
  };
  assert.deepEqual(model.listenOptions(rig).map((option) => [option.instrumentId, option.monophonic]), [['lead', true], ['wide', false], ['unsaid', false]]);
});

test('the chord warning is one sentence with the instrument id apart, and only a monophonic instrument with a chord gets it', () => {
  const chord = { before: 'Heads up: ', id: 'jx', after: ' plays one note at a time, so a chord would be heard as one note.' };
  assert.deepEqual(model.hearWarnings({ instrumentId: 'jx', channel: 1, monophonic: true, chord: true }), [chord]);
  assert.deepEqual(model.hearWarnings({ instrumentId: 'jx', channel: 1, monophonic: true, chord: false }), [], 'no chord');
  assert.deepEqual(model.hearWarnings({ instrumentId: 'jx', channel: 1, monophonic: false, chord: true }), [], 'a model that says nothing never warns');
  assert.deepEqual(model.hearWarnings({ instrumentId: 'jx', channel: 1, chord: true }), [], 'the fact absent never warns');
  assert.equal(SCRATCH_COPY.hearMonophonic, 'Heads up: {instrument} plays one note at a time, so a chord would be heard as one note.');
});

// --- the Heads up warning for a channel that a playing track uses ---

test('the channel warning names one track or several, with the instrument id apart, and comes before the chord warning', () => {
  const at = { instrumentId: 'mt32', channel: 3 };
  assert.deepEqual(model.hearWarnings({ ...at, tracks: ['lead'] }), [
    { before: 'Heads up: channel 3 on ', id: 'mt32', after: ' is used by the track lead, which is playing. Both would sound on it.' },
  ]);
  assert.equal(model.hearWarnings({ ...at, tracks: ['lead', 'pad'] })[0].after, ' is used by the tracks lead, pad, which are playing. Both would sound on it.');
  assert.deepEqual(model.hearWarnings({ ...at, tracks: [] }), []);
  assert.deepEqual(model.hearWarnings(at), [], 'no tracks given: nothing is said');
  const both = model.hearWarnings({ ...at, tracks: ['lead'], monophonic: true, chord: true });
  assert.deepEqual(both.map((parts) => parts.before + parts.id + parts.after), [
    'Heads up: channel 3 on mt32 is used by the track lead, which is playing. Both would sound on it.',
    'Heads up: mt32 plays one note at a time, so a chord would be heard as one note.',
  ]);
});

test('a track name in the channel warning is cut at the name limit and stays plain text', () => {
  const long = 'y'.repeat(300);
  const [warning] = model.hearWarnings({ instrumentId: 'a', channel: 1, tracks: [long, '<b>x</b>'] });
  assert.ok(Array.from(warning.after).length < 300 + 60, 'the long name was cut');
  assert.ok(warning.after.includes('…'));
  assert.ok(warning.after.includes('<b>x</b>'), 'markup is just letters here');
});

test('touchedNotes gives the notes a step brought back or changed, and nothing for a step that only took notes away', () => {
  const one = motifWith([1, 60, 0, 3]);
  const two = motifWith([1, 60, 0, 3], [2, 72, 3, 3]);
  assert.deepEqual(plain({ notes: touchedNotes(one, two) }), [[2, 72, 3, 3, 80]], 'a note added: that note alone');
  assert.deepEqual(touchedNotes(two, two), [], 'the same motif twice');
  assert.deepEqual(touchedNotes(two, one), [], 'an Undo of an add took a note away: nothing is touched');
  const moved = model.moveNote(two, 2, { pitch: 84 }).motif;
  assert.deepEqual(plain({ notes: touchedNotes(two, moved) }), [[2, 84, 3, 3, 80]], 'a note moved to another pitch, at its new pitch');
  const louder = model.setVelocity(two, 1, 95).motif;
  assert.deepEqual(plain({ notes: touchedNotes(two, louder) }), [[1, 60, 0, 3, 95]], 'a note with another velocity');
  const cleared = model.clearMotif(two).motif;
  assert.deepEqual(plain({ notes: touchedNotes(cleared, two) }), plain(two), 'an Undo of a Clear brings every note back, in the notes order');
});
