// The model of a MIDI rhythm lane drawn as named rows on the Timeline. Pure: no DOM access at import
// time, so node:test and page/main.js import it directly. The rows are the distinct drum notes of the drawn page
// by rank (the lowest note at the bottom); the names come from the lane's applicable map (page/midi-rig.js
// drumMapFor), never from a General MIDI guess. Every string here reaches the DOM through textContent, title and
// SVG title text only.

import { MIN_DRAWN_WIDTH, PAGE_CYCLES, TIMELINE_COPY, drumNoteOf } from './timeline.js';
import { MIDI_COPY, fill } from './midi-plan.js';

/**
 * The drum rows of one lane's already page-sliced events, or `null` to keep the lane's own drawing (no events, or
 * any event whose value is not a drum note: a frequency, a fraction, a name the page cannot read).
 * `map` is a drum map as the page holds it, `{ name, notes: [{ note, name }] }`.
 * Returns `{ rows, shapes, showLabels, rowsAttr, ariaLabel }`:
 * - `rows`, top to bottom (the highest note first): `{ note, name, label, numbered, tooltip }`; a note the map
 *   does not name has `name` null, the bare number as its `label` and `numbered` true;
 * - `shapes`, one per event: `{ x, width, row }`, `row` 0 at the top, x and width as `laneShapes` draws them;
 * - `showLabels`: true for at most TIMELINE_COPY.drumRowsMax rows (more rows get no overlay, only tooltips);
 * - `rowsAttr`: the string of min(rows, drumRowsMax), the lane's `data-drum-rows`;
 * - `ariaLabel`: 'Drums: ' plus the row labels bottom to top (a numbered row reads 'note N'), at most
 *   drumRowsMax, then ' and N more' when rows are left out.
 */
export function drumLane(events, pageStart, map) {
  if (!Array.isArray(events) || events.length === 0) return null;
  const notes = events.map((event) => drumNoteOf(event.value));
  if (notes.some((note) => note === null)) return null;
  const names = new Map(map.notes.map((entry) => [entry.note, entry.name]));
  const distinct = [...new Set(notes)].sort((a, b) => b - a);
  const rows = distinct.map((note) => {
    const name = names.has(note) ? names.get(note) : null;
    return {
      note,
      name,
      label: name === null ? String(note) : name,
      numbered: name === null,
      tooltip: name === null ? fill(TIMELINE_COPY.drumNotInMap, { note, map: map.name }) : fill(TIMELINE_COPY.drumTooltip, { note, name }),
    };
  });
  const rowOf = new Map(distinct.map((note, index) => [note, index]));
  const pageEnd = pageStart + PAGE_CYCLES;
  const shapes = events.map((event, index) => ({
    x: event.begin - pageStart,
    width: Math.max(Math.min(event.end, pageEnd) - event.begin, MIN_DRAWN_WIDTH),
    row: rowOf.get(notes[index]),
  }));
  const max = TIMELINE_COPY.drumRowsMax;
  const spoken = rows
    .slice()
    .reverse()
    .slice(0, max)
    .map((row) => (row.numbered ? fill(TIMELINE_COPY.drumNumbered, { note: row.note }) : row.label));
  const left = rows.length - spoken.length;
  const listed = fill(TIMELINE_COPY.drumsLabel, { names: spoken.join(', ') });
  return {
    rows,
    shapes,
    showLabels: rows.length <= max,
    rowsAttr: String(Math.min(rows.length, max)),
    ariaLabel: left > 0 ? `${listed} ${fill(MIDI_COPY.rowsMore, { count: left })}` : listed,
  };
}
