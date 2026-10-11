// The pure model of a drum lane on the Timeline (page/drum-lane.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { drumLane } from '../page/drum-lane.js';
import { MIN_DRAWN_WIDTH, drumNoteOf } from '../page/timeline.js';
import { BUILT_IN_DRUM_MAPS } from '../dist/drum-maps.js';

const mt32 = JSON.parse(readFileSync(new URL('../instruments/mt32.json', import.meta.url), 'utf8'));
const MT32_MAP = mt32.drumMaps.find((map) => map.id === mt32.drumMap);

/** One event of a lane: a note starting at `begin` and lasting `length` cycles. */
function hit(note, begin, length = 0.25) {
  return { begin, end: begin + length, value: { note } };
}

test('an MT-32 lane of 36 38 42 38 is three rows, the low note at the bottom, with official names', () => {
  const events = [hit(36, 0), hit(38, 1), hit(42, 2), hit(38, 3)];
  const plan = drumLane(events, 0, MT32_MAP);
  assert.deepEqual(
    plan.rows.map((row) => row.label),
    ['Closed High Hat', 'Acoustic Snare Drum', 'Acoustic Bass Drum'],
  );
  assert.deepEqual(
    plan.rows.map((row) => row.tooltip),
    ['42 Closed High Hat', '38 Acoustic Snare Drum', '36 Acoustic Bass Drum'],
  );
  assert.equal(plan.rowsAttr, '3');
  assert.equal(plan.showLabels, true);
  assert.equal(plan.ariaLabel, 'Drums: Acoustic Bass Drum, Acoustic Snare Drum, Closed High Hat');
  assert.deepEqual(
    plan.shapes.map((shape) => shape.row),
    [2, 1, 0, 1],
    'the 36 event is in the bottom row (the last), the 42 event in the top row',
  );
  assert.deepEqual(plan.shapes[1], { x: 1, width: 0.25, row: 1 });
});

test('empty: a lane with no event keeps today\'s drawing', () => {
  assert.equal(drumLane([], 0, MT32_MAP), null);
});

test('one distinct note is one row with its label and the lane keeps its own height', () => {
  const plan = drumLane([hit(36, 0), hit(36, 1)], 0, MT32_MAP);
  assert.equal(plan.rows.length, 1);
  assert.equal(plan.rowsAttr, '1');
  assert.equal(plan.showLabels, true);
  assert.deepEqual(plan.shapes.map((shape) => shape.row), [0, 0]);
  const css = readFileSync(new URL('../page/style.css', import.meta.url), 'utf8');
  assert.ok(!css.includes('data-drum-rows="1"') && !css.includes('data-drum-rows="2"'), 'no min-height rule for one or two rows');
});

test('three rows keep the low note at the bottom and every mark is centered in its row', () => {
  const plan = drumLane([hit(36, 0), hit(38, 1), hit(42, 2)], 0, MT32_MAP);
  assert.equal(plan.rowsAttr, '3');
  assert.deepEqual(plan.rows.map((row) => row.note), [42, 38, 36]);
  assert.equal(plan.shapes.find((shape) => shape.x === 0).row, 2, 'the 36 event is in the last row, the bottom');
});

test('nine notes: rowsAttr stops at 8, no labels, every row keeps its tooltip', () => {
  const notes = [35, 36, 37, 38, 39, 40, 41, 42, 43];
  const plan = drumLane(notes.map((note, index) => hit(note, index)), 0, BUILT_IN_DRUM_MAPS.find((map) => map.id === 'general-midi'));
  assert.equal(plan.rows.length, 9);
  assert.equal(plan.rowsAttr, '8');
  assert.equal(plan.showLabels, false);
  assert.ok(plan.rows.every((row) => row.tooltip.length > 0));
});

test('twelve notes: the spoken label lists eight and then says and 4 more', () => {
  const notes = [35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46];
  const gm = BUILT_IN_DRUM_MAPS.find((map) => map.id === 'general-midi');
  const plan = drumLane(notes.map((note, index) => hit(note, index)), 0, gm);
  assert.equal(plan.rowsAttr, '8');
  assert.ok(plan.ariaLabel.endsWith(' and 4 more'), plan.ariaLabel);
  assert.equal(plan.ariaLabel.slice('Drums: '.length, -' and 4 more'.length).split(', ').length, 8);
  assert.ok(plan.ariaLabel.startsWith(`Drums: ${gm.notes.find((entry) => entry.note === 35).name}, `), 'bottom to top');
});

test('partial: an event that is not a drum note keeps today\'s pitch drawing, whatever the other events say', () => {
  assert.equal(drumLane([hit(36, 0), hit(38.5, 1)], 0, MT32_MAP), null, 'a fraction');
  assert.equal(drumLane([hit(36, 0), { begin: 1, end: 1.25, value: { freq: 110 } }], 0, MT32_MAP), null, 'a frequency');
  assert.equal(drumLane([hit(36, 0), hit('nonsense', 1)], 0, MT32_MAP), null, 'a name the page cannot read');
  assert.equal(drumLane([hit(36, 0), { begin: 1, end: 1.25, value: { s: 'bd' } }], 0, MT32_MAP), null, 'a sound with no note');
});

test('a note the map does not name is a number, never a General MIDI name', () => {
  const plan = drumLane([hit(36, 0), hit(52, 1)], 0, MT32_MAP);
  assert.deepEqual(plan.rows[0], { note: 52, name: null, label: '52', numbered: true, tooltip: '52 · not in Roland MT-32 Rhythm' });
  assert.equal(plan.ariaLabel, 'Drums: Acoustic Bass Drum, note 52');
});

test('the names come from the lane\'s own map: General MIDI names 36 only for a lane whose map is General MIDI', () => {
  const gm = BUILT_IN_DRUM_MAPS.find((map) => map.id === 'general-midi');
  assert.equal(drumLane([hit(36, 0)], 0, gm).rows[0].label, 'Bass Drum 1');
  assert.equal(drumLane([hit(36, 0)], 0, MT32_MAP).rows[0].label, 'Acoustic Bass Drum');
  for (const row of drumLane([hit(36, 0), hit(38, 1), hit(42, 2)], 0, MT32_MAP).rows) {
    assert.equal(row.label, MT32_MAP.notes.find((entry) => entry.note === row.note).name, `${row.note} is named by the MT-32 map`);
    assert.notEqual(row.label, gm.notes.find((entry) => entry.note === row.note).name, `${row.note} is not the General MIDI name`);
  }
});

test('shapes are clipped to the page end and never narrower than the narrowest drawn note', () => {
  const plan = drumLane([{ begin: 31.9, end: 40, value: { note: 36 } }, { begin: 3, end: 3.001, value: { note: 38 } }], 0, MT32_MAP);
  assert.ok(Math.abs(plan.shapes[0].width - 0.1) < 1e-9);
  assert.equal(plan.shapes[1].width, MIN_DRAWN_WIDTH);
});

test('drumNoteOf reads whole numbers from 0 to 127 and note names, never a frequency', () => {
  assert.equal(drumNoteOf({ note: 36 }), 36);
  assert.equal(drumNoteOf({ note: 'c2' }), 36);
  assert.equal(drumNoteOf({ note: 0 }), 0);
  assert.equal(drumNoteOf({ note: 127 }), 127);
  assert.equal(drumNoteOf({ note: 128 }), null);
  assert.equal(drumNoteOf({ note: -1 }), null);
  assert.equal(drumNoteOf({ note: 38.5 }), null);
  assert.equal(drumNoteOf({ freq: 440 }), null);
  assert.equal(drumNoteOf({ note: 'nonsense' }), null);
  assert.equal(drumNoteOf({ s: 'bd' }), null);
  assert.equal(drumNoteOf(null), null);
  assert.equal(drumNoteOf('36'), null);
});
