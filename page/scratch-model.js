// Pure module for the Scratchpad view: the motif model (notes on the cycle grid, kept as whole units so a
// grid change never drifts), the commands that change it, the names and positions the page reads out, and every
// word the view shows. No DOM access, window or timer at import time, so this module can be imported directly by
// node:test and by page/main.js without a build step. A command never changes its input: it returns a new frozen
// motif and the sentence that says what it did.

/** One cycle is 48 units: the least common multiple of the steps per cycle of the five grids (4, 8, 16, 12 and 24), so every grid step is a whole number of units. */
export const UNITS_PER_CYCLE = 48;

/** A beat is a quarter note and a cycle holds four beats; a beat is therefore 12 units. */
const UNITS_PER_BEAT = 12;
const BEATS_PER_CYCLE = UNITS_PER_CYCLE / UNITS_PER_BEAT;

/**
 * The five grids, in the order the page lists them. `steps` is the steps per cycle, `unit` the units in one step, `text` the
 * button word, `name` the tooltip and accessible name, and `one` and `many` the words that count a length in steps.
 */
export const GRIDS = Object.freeze([
  Object.freeze({ id: 'quarter', steps: 4, unit: 12, text: 'Quarters', name: 'Quarter notes, 4 per cycle', one: 'quarter', many: 'quarters' }),
  Object.freeze({ id: 'eighth', steps: 8, unit: 6, text: 'Eighths', name: 'Eighth notes, 8 per cycle', one: 'eighth', many: 'eighths' }),
  Object.freeze({ id: 'sixteenth', steps: 16, unit: 3, text: 'Sixteenths', name: 'Sixteenth notes, 16 per cycle', one: 'sixteenth', many: 'sixteenths' }),
  Object.freeze({ id: 'eighth-triplet', steps: 12, unit: 4, text: 'Eighth triplets', name: 'Eighth-note triplets, 12 per cycle', one: 'eighth triplet', many: 'eighth triplets' }),
  Object.freeze({ id: 'sixteenth-triplet', steps: 24, unit: 2, text: 'Sixteenth triplets', name: 'Sixteenth-note triplets, 24 per cycle', one: 'sixteenth triplet', many: 'sixteenth triplets' }),
]);

export const DEFAULT_GRID = 'sixteenth';
export const DEFAULT_CYCLES = 2;
export const MIN_CYCLES = 1;
export const MAX_CYCLES = 8;
/** A new note starts at 0.80, stored as whole hundredths; the last value used is never remembered. */
export const DEFAULT_VELOCITY = 80;
/** The pitches a note can have: C0 to B8 as MIDI numbers, with C4 = 60. */
export const MIN_PITCH = 12;
export const MAX_PITCH = 119;
/** The roll shows 24 chromatic rows (two octaves) that start on a C. */
export const WINDOW_ROWS = 24;
export const MIN_WINDOW_START = 12;
export const MAX_WINDOW_START = 96;
/** Where the window starts when the motif is empty: C3, the first key of the Jam piano. */
export const EMPTY_WINDOW_START = 48;

/**
 * Page-visible copy for the Scratchpad view. `{name}` slots are filled by fillScratch. The note line is written in two parts,
 * the name and the rest, so the page can show the name heavier than the rest.
 */
export const SCRATCH_COPY = Object.freeze({
  emptyHeading: 'No notes yet',
  emptyBody: 'Double-click the grid or press Enter to write a note, or turn Draw on and drag. Play a MIDI keyboard and press Record that. Listen plays the motif on an instrument you choose; the motif is sent only when Send to Claude is pressed.',
  hintSelect: 'Click or drag to select. Double-click or Enter writes a note. Delete erases. Listen plays the motif.',
  hintDraw: 'Draw is on: drag to write a note. Turn it off to select by dragging.',
  modeGroup: 'Mode',
  draw: 'Draw',
  drawName: 'Draw notes with a drag',
  drawTitle: 'Draw notes with a drag (key d)',
  early: 'Early experimental',
  earlyTitle: 'The whole Scratchpad is new, may still change and has known problems; check a played motif on the roll before you send it.',
  drawOn: 'Draw is on.',
  drawOff: 'Draw is off.',
  placed: 'Placed {name} at cycle {cycle}, beat {beat}.',
  erased: 'Erased {name} at cycle {cycle}, beat {beat}. Undo brings it back.',
  noteName: '{name}',
  noteRest: ' · cycle {cycle}, beat {beat} · length {length} · velocity {velocity}',
  emptyCellRest: ' · cycle {cycle}, beat {beat} · empty',
  spokenNote: '{name}, starts at cycle {cycle}, beat {beat}, lasts {length}, velocity {velocity}.',
  spokenEmpty: 'Row {name}, cycle {cycle}, beat {beat}, empty',
  summary: '{notes} in {cycles} on {grid}.',
  oneNote: '1 note',
  manyNotes: '{count} notes',
  oneCycle: '1 cycle',
  manyCycles: '{count} cycles',
  beatOne: 'beat',
  beatMany: 'beats',
  lengthWithBeats: '{count} {word} ({beats} {beatWord})',
  moved: 'Moved {name} to cycle {cycle}, beat {beat}.',
  movedPitch: 'Moved {from} to {name} at cycle {cycle}, beat {beat}.',
  lasts: '{name} now lasts {length}.',
  noNote: 'No note here. Move the cursor onto a note, or press Enter to place one.',
  cut: ' {count} note cut where a note of the same pitch starts.',
  cutMany: ' {count} notes cut where a note of the same pitch starts.',
  merged: ' Merged with the note there (same pitch in the same cell).',
  gridNotice: 'Grid: {grid}.{rest}',
  gridMoved: ' {notes} moved onto it{merged}.',
  gridMerged: ', {count} merged (same pitch in the same cell)',
  cyclesNow: 'Motif is now {cycles}.',
  cyclesCut: ' 1 note was cut at the end.',
  cyclesCutMany: ' {count} notes were cut at the end.',
  cyclesRefused: 'Cycle {cycle} has {notes}. Erase or move them first.',
  windowRange: '{low}–{high}',
  windowSpokenRange: '{low} to {high}',
  fewer: 'Fewer cycles',
  more: 'More cycles',
  fewerLeast: 'The motif is already 1 cycle long, the least.',
  moreMost: 'The motif is already 8 cycles long, the most.',
  lower: 'Lower',
  lowerName: 'Move the starting pitch window down one octave. The roll still grows to show every note.',
  lowerLowest: 'The starting pitch window is already at the lowest octave.',
  higher: 'Higher',
  higherName: 'Move the starting pitch window up one octave. The roll still grows to show every note.',
  higherHighest: 'The starting pitch window is already at the highest octave.',
  fewerSign: '−',
  moreSign: '+',
  laneLabel: 'Velocity',
  velocitySet: '{name} velocity {velocity}.',
  barName: '{name} velocity {velocity}',
  undo: 'Undo',
  redo: 'Redo',
  nothingToUndo: 'Nothing to undo.',
  nothingToRedo: 'Nothing to redo.',
  undid: 'Undid: {what}.',
  redid: 'Redid: {what}.',
  whatPlaced: 'placed {name}',
  whatErased: 'erased {name}',
  whatMoved: 'moved {name}',
  whatLength: 'changed the length of {name}',
  whatVelocity: 'changed the velocity of {name}',
  whatMovedMany: 'moved {notes}',
  whatLengthMany: 'changed the length of {notes}',
  whatErasedMany: 'erased {notes}',
  whatVelocityMany: 'changed the velocity of {notes}',
  theMotif: 'the motif',
  movedMany: 'Moved {who} {how}.',
  movedLater: 'later',
  movedEarlier: 'earlier',
  movedUp: 'up {distance}',
  movedDown: 'down {distance}',
  movedAnd: ' and ',
  oneOctave: 'one octave',
  manyOctaves: '{count} octaves',
  oneSemitone: 'one semitone',
  manySemitones: '{count} semitones',
  oneStepOf: 'one {word}',
  manyStepsOf: '{count} {word}',
  movedFirstAtStart: 'Not moved: the first note is already at the start of the motif.',
  movedLastAtEnd: 'Not moved: the last note already ends at the end of the motif.',
  movedHighest: 'Not moved: a note is already at the highest pitch.',
  movedLowest: 'Not moved: a note is already at the lowest pitch.',
  longerMany: 'Made {who} {distance} longer.',
  shorterMany: 'Made {who} {distance} shorter.',
  erasedMany: 'Erased {notes}. Undo brings them back.',
  velocityRaised: 'Raised the velocity of {notes} by {amount}.',
  velocityLowered: 'Lowered the velocity of {notes} by {amount}.',
  selectedAll: 'Selected all {notes}.',
  selectedOnly: 'Selected the only note.',
  selectNoNotes: 'No notes to select.',
  selectedNone: 'Selected none.',
  selectedAdded: 'Selected {name}. {count}',
  selectedRemoved: 'Removed {name} from the selection. {count}',
  selectedCount: '{notes} selected.',
  selectedNothing: 'Nothing selected.',
  selectNoNote: 'No note here to select.',
  selectionName: '{notes} selected',
  selectionRange: ' · {low} to {high} · from cycle {cycle}, beat {beat}',
  selectionOnePitch: ' · {low} · from cycle {cycle}, beat {beat}',
  noLaterNote: 'No later note.',
  noEarlierNote: 'No earlier note.',
  editGroup: 'Edit',
  earlier: 'Earlier',
  earlierName: 'Move the selection, or the whole motif, one grid step earlier',
  later: 'Later',
  laterName: 'Move the selection, or the whole motif, one grid step later',
  align: 'Align',
  alignName: 'Align the motif so its first note falls on the nearest beat',
  alignTitle: 'Align the motif so its first note falls on the nearest beat (key l)',
  clear: 'Clear',
  clearName: 'Clear the roll',
  moveNothing: 'Nothing to move: the roll has no notes.',
  aligned: 'Aligned: the motif moved {distance} {direction}, so its first note is on cycle {cycle}, beat {beat}.',
  alignedAlready: 'Already aligned: the first note is on a beat.',
  alignOverflow: 'Not aligned: the last note would pass the end of the motif. Make the motif longer, or move the last note earlier first.',
  alignNothing: 'Nothing to align: the roll has no notes.',
  whatAligned: 'aligned the motif',
  clearedOne: 'Cleared 1 note. Undo brings it back.',
  clearedMany: 'Cleared {count} notes. Undo brings them back.',
  clearNothing: 'Nothing to clear: the roll has no notes.',
  whatCleared: 'cleared the roll',
  whatGrid: 'changed the grid to {grid}',
  whatCycles: 'changed the motif to {cycles}',
  tap: 'Tap rhythm',
  tapTitle: 'Tap a rhythm with the Space key while the music plays (key t)',
  tapNeedsMusic: "Tap needs the music playing, because the music's clock places the taps. Press Play, then try again.",
  tapClockUnreadable: "The music's clock could not be read, so nothing was placed.",
  tapStampRefused: 'The time stamp of the key press was refused ({reason}), so nothing was placed.',
  tapReasonZero: 'it was zero',
  tapReasonNotANumber: 'it was not a number',
  tapReasonAhead: "it was ahead of the page's clock",
  tapReasonStale: 'it was more than a second old',
  tapStarted: 'Tap is on. Press Space on the beat; the marker shows where the next tap lands.',
  tapStopped: 'Tap is off.',
  tapMusicStopped: 'Tap is off, because the music stopped.',
  tapped: 'Tapped {name} at cycle {cycle}, beat {beat}.',
  whatTapped: 'tapped {name}',
  listenAbsent: 'Not listening: there is no instruments.json, so no MIDI input is named. To listen to a keyboard, add "inputs": [{ "port": "its exact name" }] to one.',
  listenInvalid: 'Not listening: instruments.json has a problem. The MIDI popover shows it.',
  listenNone: 'Not listening: instruments.json names no MIDI input. To listen to a keyboard, add "inputs": [{ "port": "its exact name" }] next to "instruments".',
  listenNeedsPermission: 'The page can listen to {ports} once MIDI is allowed.',
  listenPending: 'Waiting for the answer to the MIDI permission.',
  listenDenied: "Not listening: MIDI was refused for this page. Allow it in the browser's site settings, then reload.",
  listenUnsupported: 'Not listening: this browser has no Web MIDI.',
  listenFailed: 'Not listening: MIDI could not start ({failure}).',
  listenHidden: 'Listening is paused: this tab is hidden, behind another tab or covered by another window. It listens again when the tab is shown.',
  listenOtherTab: 'Not listening: another Moontide tab has the music. Take it back to listen here.',
  listenListening: 'Listening to {ports}. Play, and the notes show here.',
  listenNotFound: ' Not found: {ports}.',
  listenNotTold: ' Not told apart: {ports}.',
  listenNotOpenedToo: ' Could not be opened: {ports}.',
  listenNotOpened: 'Not listening: {port} is connected but could not be opened; another program may be using it. Close that program, then plug the keyboard in again or reload the page.',
  listenMissing: 'Not listening: no MIDI input is named exactly {port}. Inputs here: {names}.',
  listenUnplugged: 'Not listening: {port} was unplugged. Plug it in again; the page notices by itself. Inputs here: {names}.',
  listenAmbiguous: 'Not listening: {count} inputs are named exactly {port}, so the page cannot tell them apart.',
  allow: 'Allow MIDI to listen',
  allowTitle: 'Ask the browser to let this page read the MIDI keyboard',
  listenNoInputs: 'none',
  listenJoin: ', ',
  heard: 'Heard {name} · {notes} in the buffer.',
  heardRefusedStamp: 'A note from the keyboard was not kept: its time stamp was refused ({reason}).',
  heardRefusedClock: "A note from the keyboard was not kept: the music's clock gives no cycle and the tempo is not above 0.",
  heardRefusedFull: 'The keyboard buffer is full (2000 notes), so the newest notes were not kept.',
  record: 'Record that',
  recordGroup: 'Keyboard',
  recordTitle: 'Put what the keyboard played in the last 8 cycles on the roll, in place of the motif',
  recordNothing: 'Nothing to record: the keyboard played nothing in the last 8 cycles.',
  recordClockUnreadable: "The music's clock could not be read, so nothing was recorded.",
  recorded: 'Recorded {notes} over {cycles} on {grid}.',
  recordOutside: " {count} notes were outside the roll's range and were left out.",
  recordOutsideOne: " 1 note was outside the roll's range and was left out.",
  recordOnlyOutside: 'Nothing to record.{outside}',
  recordUndo: ' Undo brings back the earlier motif.',
  whatRecorded: 'recorded the keyboard',
  phraseLabel: 'Phrase of the motif',
  phraseEmpty: 'No phrase yet: the motif has no notes.',
  wordsLabel: 'Words for Claude',
  defaultWords: 'Add this motif to the music.',
  send: 'Send to Claude',
  sendTitle: 'Send the motif to Claude as a request. The Scratchpad changes no code.',
  sent: 'Sent to Claude at cycle {cycle}. The Requests panel shows what becomes of it.',
  sentNoMoment: 'Sent to Claude with no moment. The Requests panel shows what becomes of it.',
  sendNoNotes: 'Nothing to send: the motif has no notes.',
  sendNoWords: 'Nothing to send: write a few words for Claude first.',
  sendWordsTooLong: 'Not sent: the words are {length} characters, {max} at most.',
  sendDisconnected: 'Not sent: the page is not connected to Moontide.',
  sendPending: 'Not sent: the last motif request is still on its way.',
  sendTooBig: 'Not sent: the request would be {bytes} bytes, {max} at most. Fewer cycles, a coarser grid, fewer notes sounding together or shorter words make it smaller.',
  sendRefused: 'Not sent: {reason}',
  sendNotConfirmed: 'Moontide did not confirm the motif request. Try again.',
  sendWaiting: "It waits until Claude's next Moontide call; Send can send another motif meanwhile.",
  hearGroup: 'Hear the motif',
  hearOutputName: 'Instrument and channel',
  hearOutputPlaceholder: 'Choose an instrument',
  hearOutputOption: '{id} · channel {channel}',
  hearOutputTitle: '{id} · channel {channel} · {port}',
  hearStartGroup: 'Start',
  hearStartMusic: 'In the music',
  hearStartMusicTitle: 'Start on the next cycle line of the music, so the motif is heard in context.',
  hearStartNow: 'At once',
  hearStartNowTitle: 'Start now, whatever the music does.',
  loop: 'Loop',
  loopTitle: 'Repeat the motif until Stop. Turning it on or off while it plays applies from the next pass.',
  listen: 'Listen',
  listenTitle: 'Play the motif on the chosen instrument. Nothing is sent to Claude and the code does not change.',
  stop: 'Stop',
  stopTitle: 'Silence every note Listen started and cancel a wait.',
  stopNothing: 'Nothing is playing or waiting.',
  hearChoose: 'Choose an instrument to listen on.',
  hearNoNotes: 'Nothing to listen to: the motif has no notes.',
  hearNoInstrumentNone: 'No instrument to listen on: instruments.json names none.',
  hearNoInstrumentAbsent: 'No instrument to listen on: there is no instruments.json.',
  hearNoInstrumentInvalid: 'No instrument to listen on: instruments.json has a problem. The MIDI popover shows it.',
  hearPlaying: 'Playing on {instrument}, channel {channel}.',
  hearPlayingLoop: 'Playing on {instrument}, channel {channel}, in a loop.',
  hearEnded: 'Played once on {instrument}, channel {channel}.',
  hearStopped: 'Stopped. Held notes are silent.',
  hearNoOutput: 'Not played: no MIDI output contains the name {port}. Outputs here: {names}.',
  hearAmbiguous: 'Not played: {count} MIDI outputs contain the name {port}, so the page cannot tell them apart.',
  hearUnplugged: 'Stopped: {port} is no longer connected.',
  hearOff: 'Not played: {instrument} is switched off in the Instruments view.',
  hearResetting: 'Not played: {instrument} is being reset or was just plugged in again. Try again in a moment.',
  hearSuperseded: 'Not played: another Moontide tab has the music. Take it back to listen here.',
  hearNoRig: 'Not played: there is no valid instruments.json.',
  hearUnknownInstrument: 'Not played: instruments.json does not name an instrument {instrument}.',
  hearTempo: 'Not played: the tempo is not above 0.',
  hearChannelBusy: 'Heads up: channel {channel} on {instrument} is used by the track {tracks}, which is playing. Both would sound on it.',
  hearChannelBusyMany: 'Heads up: channel {channel} on {instrument} is used by the tracks {tracks}, which are playing. Both would sound on it.',
  hearMonophonic: 'Heads up: {instrument} plays one note at a time, so a chord would be heard as one note.',
  hearInvalid: 'Not played: the note could not be sent to the MIDI output.',
  hearSendFailed: 'Not played: the MIDI output refused the note.',
  hearWaiting: 'Waiting for cycle {cycle} of the music, then playing on {instrument}, channel {channel}. Stop cancels.',
  hearAsking: 'Waiting for the answer to the MIDI permission.',
  hearMusicNotPlaying: 'The music is not playing, so there is no cycle line to wait for. Press Play, or choose At once.',
  hearNoClock: "Not played: the music's clock gives no time for the next cycle line yet. Try again in a moment.",
  hearDenied: "Not played: MIDI was refused for this page. Allow it in the browser's site settings, then reload.",
  hearUnsupported: 'Not played: this browser has no Web MIDI.',
  hearFailed: 'Not played: MIDI could not start ({failure}).',
  hearHidden: 'Stopped: this tab was hidden, and a hidden tab cannot keep time.',
  hearMusicStopped: 'Stopped: the music stopped, so there is no cycle line to play on.',
  hearClosed: 'Stopped: the Scratchpad was closed.',
  hearLeft: 'Stopped: the page was left.',
});

/**
 * A sentence of the copy with each `{name}` replaced by its value in `values`. A placeholder with no value throws, so a
 * sentence is never shown with a hole in it. The values are put in as plain text.
 */
export function fillScratch(template, values) {
  return template.replace(/\{(\w+)\}/g, (match, name) => {
    if (!Object.hasOwn(values, name)) throw new Error(`Moontide: the Scratchpad copy has no value for {${name}} in '${template}'`);
    return String(values[name]);
  });
}

/** The grid with this id. An id outside the list throws. */
export function gridOf(id) {
  const grid = GRIDS.find((candidate) => candidate.id === id);
  if (grid === undefined) throw new Error(`Moontide: unknown Scratchpad grid '${String(id)}'`);
  return grid;
}

/**
 * The empty motif: two cycles on sixteenths, no notes. A note is a frozen { id, pitch, start, length, velocity }, with start and length in units and velocity in hundredths.
 * `source` says how the notes got on the roll (one of MOTIF_SOURCES, null while there are none) and `recorded` is null, or `{ cycle }` for a motif
 * made by Record that: the cycle where it was played (a whole number, or null when the music was stopped). Both ride on the motif itself, so Undo brings
 * them back with the notes.
 */
export function emptyMotif() {
  return Object.freeze({ cycles: DEFAULT_CYCLES, grid: DEFAULT_GRID, notes: Object.freeze([]), nextId: 1, source: null, recorded: null });
}

/** How the notes of a motif got on the roll, in the order the request lists them; 'mixed' is more than one way. */
export const MOTIF_SOURCES = Object.freeze(['played', 'drawn', 'tapped', 'mixed']);

/** The motif's length in units. */
export function motifUnits(motif) {
  return motif.cycles * UNITS_PER_CYCLE;
}

function makeNote(id, pitch, start, length, velocity) {
  return Object.freeze({ id, pitch, start, length, velocity });
}

function checkPitch(pitch) {
  if (!Number.isInteger(pitch) || pitch < MIN_PITCH || pitch > MAX_PITCH) {
    throw new Error(`Moontide: a Scratchpad pitch must be a whole number from ${MIN_PITCH} to ${MAX_PITCH}, got ${String(pitch)}`);
  }
}

function checkUnit(motif, unit) {
  if (!Number.isInteger(unit) || unit < 0 || unit >= motifUnits(motif)) {
    throw new Error(`Moontide: a Scratchpad position must be a whole number of units from 0 to ${motifUnits(motif) - 1}, got ${String(unit)}`);
  }
}

/** A start must be a whole number of units on the grid; `inside` also asks for a place inside the motif. */
function checkStart(motif, start, { inside }) {
  const step = gridOf(motif.grid).unit;
  if (!Number.isInteger(start) || start % step !== 0 || (inside && (start < 0 || start >= motifUnits(motif)))) {
    throw new Error(`Moontide: a Scratchpad start must be a whole number of units on the ${motif.grid} grid (a multiple of ${step})${inside ? ' inside the motif' : ''}, got ${String(start)}`);
  }
}

function checkLength(motif, length) {
  const step = gridOf(motif.grid).unit;
  if (!Number.isInteger(length) || length % step !== 0) {
    throw new Error(`Moontide: a Scratchpad length must be a whole number of units on the ${motif.grid} grid (a multiple of ${step}), got ${String(length)}`);
  }
}

function checkVelocity(velocity) {
  if (!Number.isInteger(velocity) || velocity < 1 || velocity > 100) {
    throw new Error(`Moontide: a Scratchpad velocity must be a whole number of hundredths from 1 to 100, got ${String(velocity)}`);
  }
}

function findNote(motif, id) {
  const note = motif.notes.find((candidate) => candidate.id === id);
  if (note === undefined) throw new Error(`Moontide: there is no note with id ${String(id)} in the Scratchpad motif`);
  return note;
}

const clamp = (value, low, high) => Math.min(Math.max(value, low), high);

/** The nearest step to `position` for steps of `size`, with a tie going to the earlier step; exact in whole numbers. */
export function nearestStep(position, size) {
  return Math.floor((2 * position + size - 1) / (2 * size));
}

/**
 * Makes the notes obey the rules of the roll after a command. The motif's end holds every note; two notes of the same pitch at the
 * same start become the stronger one, with its length and, on a tie, the older (smaller id); and a note stops where a later note of
 * the same pitch starts. The phrase form cannot say two notes of one pitch sounding at once, so the roll never shows them. Returns
 * the notes in id order and how many were cut and merged.
 */
function settle(notes, units) {
  const bounded = notes.map((note) => (note.start + note.length > units ? makeNote(note.id, note.pitch, note.start, units - note.start, note.velocity) : note));
  const byCell = new Map();
  let merged = 0;
  for (const note of bounded) {
    const key = `${note.pitch}:${note.start}`;
    const known = byCell.get(key);
    if (known === undefined) {
      byCell.set(key, note);
      continue;
    }
    merged += 1;
    const wins = note.velocity > known.velocity || (note.velocity === known.velocity && note.id < known.id);
    byCell.set(key, wins ? note : known);
  }
  const survivors = [...byCell.values()];
  const inTime = [...survivors].sort((a, b) => a.pitch - b.pitch || a.start - b.start);
  const stops = new Map();
  inTime.forEach((note, index) => {
    const next = inTime[index + 1];
    if (next !== undefined && next.pitch === note.pitch && note.start + note.length > next.start) stops.set(note.id, next.start - note.start);
  });
  const result = survivors
    .map((note) => (stops.has(note.id) ? makeNote(note.id, note.pitch, note.start, stops.get(note.id), note.velocity) : note))
    .sort((a, b) => a.id - b.id);
  return { notes: result, cut: stops.size, merged };
}

function sameNotes(a, b) {
  return a.length === b.length && a.every((note, index) => note.id === b[index].id && note.pitch === b[index].pitch && note.start === b[index].start && note.length === b[index].length && note.velocity === b[index].velocity);
}

/** Settles `notes` into a motif; the motif is returned as it was when nothing changed, else as a new frozen motif. */
function rebuild(motif, notes, nextId) {
  const settled = settle(notes, motifUnits(motif));
  const unchanged = nextId === motif.nextId && sameNotes(settled.notes, motif.notes);
  const next = unchanged ? motif : Object.freeze({ ...motif, notes: Object.freeze(settled.notes), nextId });
  return { motif: next, notes: settled.notes, cut: settled.cut, merged: settled.merged };
}

/** The words that say what the same-pitch rule did: the notes cut, then the merge. */
function ruleWords({ cut, merged }) {
  const cutWords = cut === 0 ? '' : fillScratch(cut === 1 ? SCRATCH_COPY.cut : SCRATCH_COPY.cutMany, { count: cut });
  return cutWords + (merged === 0 ? '' : SCRATCH_COPY.merged);
}

/** The note of a settled list that stands where the command put its note: the note itself, else the one it merged into. */
function survivor(notes, id, pitch, start) {
  return notes.find((note) => note.id === id) ?? notes.find((note) => note.pitch === pitch && note.start === start) ?? null;
}

/** The note of this pitch whose span holds this unit, or null. */
export function noteAt(motif, pitch, unit) {
  return motif.notes.find((note) => note.pitch === pitch && unit >= note.start && unit < note.start + note.length) ?? null;
}

/** The ways a note can be placed on the roll by hand: drawn (mouse or Enter) or tapped. A recorded motif is made by recordBuffer. */
const PLACE_WAYS = Object.freeze(['drawn', 'tapped']);

/** The source of a motif once a note was placed the way `how` says: the way itself for a motif with no notes, the same way when it matches, else mixed. */
function sourceAfterPlacing(motif, how) {
  if (motif.notes.length === 0 || motif.source === null) return how;
  return motif.source === how ? how : 'mixed';
}

/**
 * Places a note of `length` units at `start`, at `velocity` (80 when not given). `how` says how the note was made ('drawn' unless given, or
 * 'tapped') and sets the motif's source: the way itself on a motif with no notes, 'mixed' when the motif already holds notes made another way.
 * Returns `{ motif, notice, cut, merged, note, what }`:
 * the new motif, the sentence that says what happened, how many notes the same-pitch rule cut and merged, the note that now
 * stands there, and `what`, a short past-tense phrase of the edit that the history repeats when it is undone ('placed E4'; every command
 * carries one, empty when it changed nothing). A note that merges away into a note that stays leaves the motif as it was, with an empty `what`. A pitch, start, length or velocity that is not valid, or a note that would run past the motif's end, throws.
 */
export function placeNote(motif, { pitch, start, length, velocity = DEFAULT_VELOCITY }, how = 'drawn') {
  if (!PLACE_WAYS.includes(how)) throw new Error(`Moontide: a Scratchpad note is placed drawn or tapped, got ${String(how)}`);
  checkPitch(pitch);
  checkStart(motif, start, { inside: true });
  checkLength(motif, length);
  if (length < gridOf(motif.grid).unit) {
    throw new Error(`Moontide: a Scratchpad length must be at least one grid step (${gridOf(motif.grid).unit} units), got ${String(length)}`);
  }
  if (start + length > motifUnits(motif)) {
    throw new Error(`Moontide: a Scratchpad note of length ${length} from ${start} runs past the end of the motif (${motifUnits(motif)} units)`);
  }
  checkVelocity(velocity);
  const note = makeNote(motif.nextId, pitch, start, length, velocity);
  const done = rebuild(motif, [...motif.notes, note], motif.nextId + 1);
  const placed = survivor(done.notes, note.id, pitch, start);
  const notice = fillScratch(SCRATCH_COPY.placed, { name: noteName(pitch), ...positionOf(placed.start) }) + ruleWords(done);
  // A note that lost the same-pitch merge leaves the notes as they were: the motif stays the one it was, so no history step is added.
  const same = sameNotes(done.notes, motif.notes);
  const source = sourceAfterPlacing(motif, how);
  const next = same ? motif : source === done.motif.source ? done.motif : Object.freeze({ ...done.motif, source });
  return { motif: next, notice, cut: done.cut, merged: done.merged, note: placed, what: same ? '' : fillScratch(SCRATCH_COPY.whatPlaced, { name: noteName(pitch) }) };
}

/**
 * Moves the note `id` to `start` and `pitch` (either may be left out); the length stays. The start is held from 0 to the motif's end
 * minus the length and the pitch from 12 to 119. A move to where the note already is returns the same motif and an empty notice.
 * Returns `{ motif, notice, cut, merged, note }` like placeNote.
 */
export function moveNote(motif, id, { start, pitch } = {}) {
  const old = findNote(motif, id);
  if (start !== undefined) checkStart(motif, start, { inside: false });
  if (pitch !== undefined && !Number.isInteger(pitch)) throw new Error(`Moontide: a Scratchpad pitch must be a whole number, got ${String(pitch)}`);
  const newStart = clamp(start ?? old.start, 0, motifUnits(motif) - old.length);
  const newPitch = clamp(pitch ?? old.pitch, MIN_PITCH, MAX_PITCH);
  if (newStart === old.start && newPitch === old.pitch) return { motif, notice: '', cut: 0, merged: 0, note: old, what: '' };
  const moved = makeNote(old.id, newPitch, newStart, old.length, old.velocity);
  const done = rebuild(motif, motif.notes.map((note) => (note.id === id ? moved : note)), motif.nextId);
  const placed = survivor(done.notes, id, newPitch, newStart);
  const where = { name: noteName(newPitch), ...positionOf(placed.start) };
  const sentence = newPitch === old.pitch ? fillScratch(SCRATCH_COPY.moved, where) : fillScratch(SCRATCH_COPY.movedPitch, { from: noteName(old.pitch), ...where });
  return { motif: done.motif, notice: sentence + ruleWords(done), cut: done.cut, merged: done.merged, note: placed, what: fillScratch(SCRATCH_COPY.whatMoved, { name: noteName(newPitch) }) };
}

/**
 * Gives the note `id` this length: at least one grid step and at most the motif's end, and no further than the next note of the
 * same pitch starts. A length the note already has returns the same motif and an empty notice, except that a length cut by the
 * next note says so. Returns `{ motif, notice, cut, merged, note }` like placeNote.
 */
export function resizeNote(motif, id, length) {
  const old = findNote(motif, id);
  checkLength(motif, length);
  const wanted = clamp(length, gridOf(motif.grid).unit, motifUnits(motif) - old.start);
  const resized = makeNote(old.id, old.pitch, old.start, wanted, old.velocity);
  const done = rebuild(motif, motif.notes.map((note) => (note.id === id ? resized : note)), motif.nextId);
  const placed = survivor(done.notes, id, old.pitch, old.start);
  const silent = wanted === old.length && done.cut === 0 && done.merged === 0;
  const notice = silent ? '' : fillScratch(SCRATCH_COPY.lasts, { name: noteName(old.pitch), length: lengthText(placed.length, motif.grid) }) + ruleWords(done);
  return { motif: done.motif, notice, cut: done.cut, merged: done.merged, note: placed, what: silent ? '' : fillScratch(SCRATCH_COPY.whatLength, { name: noteName(old.pitch) }) };
}

/**
 * Gives the note `id` this velocity, a whole number of hundredths from 1 to 100 (anything else, or an unknown note, throws). The
 * velocity the note already has returns the same motif and an empty notice. Returns `{ motif, notice, cut, merged, note }` like placeNote.
 */
export function setVelocity(motif, id, velocity) {
  checkVelocity(velocity);
  const old = findNote(motif, id);
  if (old.velocity === velocity) return { motif, notice: '', cut: 0, merged: 0, note: old, what: '' };
  const note = makeNote(old.id, old.pitch, old.start, old.length, velocity);
  const next = Object.freeze({ ...motif, notes: Object.freeze(motif.notes.map((candidate) => (candidate.id === id ? note : candidate))) });
  return { motif: next, notice: fillScratch(SCRATCH_COPY.velocitySet, { name: noteName(old.pitch), velocity: velocityText(velocity) }), cut: 0, merged: 0, note, what: fillScratch(SCRATCH_COPY.whatVelocity, { name: noteName(old.pitch) }) };
}

/** The ids of the notes in the order the velocity lane visits them: by start, then the lower pitch first, then the older note. */
export function laneOrder(motif) {
  return [...motif.notes].sort((a, b) => a.start - b.start || a.pitch - b.pitch || a.id - b.id).map((note) => note.id);
}

/** Removes the note `id` and says where it started; the last note to go takes the source and the recorded moment with it. Returns `{ motif, notice, cut, merged, note }` with `note` null. */
export function eraseNote(motif, id) {
  const old = findNote(motif, id);
  const notes = Object.freeze(motif.notes.filter((note) => note !== old));
  return {
    motif: Object.freeze({ ...motif, notes, ...(notes.length === 0 ? { source: null, recorded: null } : {}) }),
    notice: fillScratch(SCRATCH_COPY.erased, { name: noteName(old.pitch), ...positionOf(old.start) }),
    cut: 0,
    merged: 0,
    note: null,
    what: fillScratch(SCRATCH_COPY.whatErased, { name: noteName(old.pitch) }),
  };
}

/**
 * Removes the note of `pitch` whose span holds `unit`; with none there, places a one-step note at the start of the grid step that
 * holds `unit`, at the default velocity. Returns `{ motif, notice, cut, merged, note }`. A pitch or a unit that is not a whole number
 * inside the roll throws.
 */
export function toggleAt(motif, { pitch, unit }) {
  checkPitch(pitch);
  checkUnit(motif, unit);
  const existing = noteAt(motif, pitch, unit);
  if (existing !== null) return eraseNote(motif, existing.id);
  const step = gridOf(motif.grid).unit;
  return placeNote(motif, { pitch, start: Math.floor(unit / step) * step, length: step });
}

/** The notes with these ids in the motif's order; an id that is not there throws, and so does an empty list. */
function pickNotes(motif, ids) {
  if (!Array.isArray(ids) || ids.length === 0) throw new Error('Moontide: a Scratchpad command on several notes needs at least one note.');
  const wanted = new Set(ids);
  for (const id of wanted) findNote(motif, id);
  return motif.notes.filter((note) => wanted.has(note.id));
}

/** A command that changes nothing: the same motif, an empty notice and an empty `what`. */
const unchanged = (motif) => ({ motif, notice: '', cut: 0, merged: 0, what: '' });

/** 'one sixteenth' or '4 sixteenths', in the words of the grid. */
function stepsText(count, grid) {
  return count === 1 ? fillScratch(SCRATCH_COPY.oneStepOf, { word: grid.one }) : fillScratch(SCRATCH_COPY.manyStepsOf, { count, word: grid.many });
}

/** A pitch distance in octaves when it is a whole number of them, else in semitones: 'one octave', '2 octaves', '3 semitones'. */
function pitchDistanceText(distance) {
  const size = Math.abs(distance);
  if (size % 12 === 0) return size === 12 ? SCRATCH_COPY.oneOctave : fillScratch(SCRATCH_COPY.manyOctaves, { count: size / 12 });
  return size === 1 ? SCRATCH_COPY.oneSemitone : fillScratch(SCRATCH_COPY.manySemitones, { count: size });
}

/** The undo phrase for several notes: '{notes}' is '3 notes'. */
const manyWhat = (template, count) => fillScratch(template, { notes: notesText(count) });

/**
 * Moves every note with an id in `ids` by the same `dStart` units (a multiple of the grid step) and `dPitch` semitones, as one command: the
 * group moves rigidly and the same-pitch rule runs once on the result, so notes of the group never cut each other. The move is all or
 * nothing: when any note would pass the motif's start or end, or C0 or B8, the motif stays as it was and the sentence is in `refused`.
 * Returns `{ motif, notice, cut, merged, what }` like placeNote. One note says where it stands now, as moveNote does; several say how
 * many and how far ('Moved 3 notes 2 sixteenths later.'), and all the notes of the motif say 'the motif'. No distance gives the same motif.
 */
export function moveNotes(motif, ids, { dStart = 0, dPitch = 0 } = {}) {
  const picked = pickNotes(motif, ids);
  const grid = gridOf(motif.grid);
  if (!Number.isInteger(dStart) || !Number.isInteger(dPitch)) throw new Error(`Moontide: a Scratchpad move needs a whole number of units and semitones, got ${String(dStart)} and ${String(dPitch)}`);
  if (dStart % grid.unit !== 0) throw new Error(`Moontide: a Scratchpad move must be a multiple of the ${motif.grid} step (${grid.unit} units), got ${String(dStart)}`);
  if (dStart === 0 && dPitch === 0) return unchanged(motif);
  const first = Math.min(...picked.map((note) => note.start));
  const last = Math.max(...picked.map((note) => note.start + note.length));
  const highest = Math.max(...picked.map((note) => note.pitch));
  const lowest = Math.min(...picked.map((note) => note.pitch));
  const refusal =
    first + dStart < 0 ? SCRATCH_COPY.movedFirstAtStart
    : last + dStart > motifUnits(motif) ? SCRATCH_COPY.movedLastAtEnd
    : highest + dPitch > MAX_PITCH ? SCRATCH_COPY.movedHighest
    : lowest + dPitch < MIN_PITCH ? SCRATCH_COPY.movedLowest
    : null;
  if (refusal !== null) return recordRefusal(motif, refusal);
  const moved = new Map(picked.map((note) => [note.id, makeNote(note.id, note.pitch + dPitch, note.start + dStart, note.length, note.velocity)]));
  const done = rebuild(motif, motif.notes.map((note) => moved.get(note.id) ?? note), motif.nextId);
  let sentence;
  let what;
  if (picked.length === 1) {
    const [old] = picked;
    const placed = survivor(done.notes, old.id, old.pitch + dPitch, old.start + dStart);
    const where = { name: noteName(placed.pitch), ...positionOf(placed.start) };
    sentence = dPitch === 0 ? fillScratch(SCRATCH_COPY.moved, where) : fillScratch(SCRATCH_COPY.movedPitch, { from: noteName(old.pitch), ...where });
    what = fillScratch(SCRATCH_COPY.whatMoved, { name: noteName(placed.pitch) });
  } else {
    const how = [];
    if (dStart !== 0) how.push(`${stepsText(Math.abs(dStart) / grid.unit, grid)} ${dStart < 0 ? SCRATCH_COPY.movedEarlier : SCRATCH_COPY.movedLater}`);
    if (dPitch !== 0) how.push(fillScratch(dPitch > 0 ? SCRATCH_COPY.movedUp : SCRATCH_COPY.movedDown, { distance: pitchDistanceText(dPitch) }));
    const who = picked.length === motif.notes.length ? SCRATCH_COPY.theMotif : notesText(picked.length);
    sentence = fillScratch(SCRATCH_COPY.movedMany, { who, how: how.join(SCRATCH_COPY.movedAnd) });
    what = manyWhat(SCRATCH_COPY.whatMovedMany, picked.length);
  }
  return { motif: done.motif, notice: sentence + ruleWords(done), cut: done.cut, merged: done.merged, what };
}

/**
 * Gives every note with an id in `ids` a length `steps` grid steps longer (negative: shorter), as one command: each note is held between
 * one step and the motif's end, and no further than the next note of its pitch starts. Returns `{ motif, notice, cut, merged, what }`;
 * no change gives the same motif and an empty notice. One note says its new length, several say how many and by how much.
 */
export function resizeNotes(motif, ids, steps) {
  const picked = pickNotes(motif, ids);
  if (!Number.isInteger(steps)) throw new Error(`Moontide: a Scratchpad length change needs a whole number of steps, got ${String(steps)}`);
  const grid = gridOf(motif.grid);
  const units = motifUnits(motif);
  const resized = new Map(picked.map((note) => [note.id, makeNote(note.id, note.pitch, note.start, clamp(note.length + steps * grid.unit, grid.unit, units - note.start), note.velocity)]));
  const done = rebuild(motif, motif.notes.map((note) => resized.get(note.id) ?? note), motif.nextId);
  if (done.motif === motif && (picked.length > 1 || (done.cut === 0 && done.merged === 0))) return unchanged(motif);
  if (picked.length === 1) {
    // One note that a neighbor of its pitch holds at the same length still says so, as resizeNote does.
    const [old] = picked;
    const placed = survivor(done.notes, old.id, old.pitch, old.start);
    return {
      motif: done.motif,
      notice: fillScratch(SCRATCH_COPY.lasts, { name: noteName(old.pitch), length: lengthText(placed.length, motif.grid) }) + ruleWords(done),
      cut: done.cut,
      merged: done.merged,
      what: fillScratch(SCRATCH_COPY.whatLength, { name: noteName(old.pitch) }),
    };
  }
  const sentence = fillScratch(steps > 0 ? SCRATCH_COPY.longerMany : SCRATCH_COPY.shorterMany, { who: notesText(picked.length), distance: stepsText(Math.abs(steps), grid) });
  return { motif: done.motif, notice: sentence + ruleWords(done), cut: done.cut, merged: done.merged, what: manyWhat(SCRATCH_COPY.whatLengthMany, picked.length) };
}

/**
 * Removes every note with an id in `ids` as one command; the last note to go takes the source and the recorded moment with it, as
 * eraseNote does. One note says where it was, several say how many and the way back.
 */
export function eraseNotes(motif, ids) {
  const picked = pickNotes(motif, ids);
  if (picked.length === 1) return eraseNote(motif, picked[0].id);
  const gone = new Set(picked.map((note) => note.id));
  const notes = Object.freeze(motif.notes.filter((note) => !gone.has(note.id)));
  return {
    motif: Object.freeze({ ...motif, notes, ...(notes.length === 0 ? { source: null, recorded: null } : {}) }),
    notice: fillScratch(SCRATCH_COPY.erasedMany, { notes: notesText(picked.length) }),
    cut: 0,
    merged: 0,
    what: manyWhat(SCRATCH_COPY.whatErasedMany, picked.length),
  };
}

/**
 * Changes the velocity of every note with an id in `ids` by `delta` hundredths, each held from 1 to 100, as one command. No change gives
 * the same motif and an empty notice. One note says its new velocity, several say how many and by how much.
 */
export function setVelocities(motif, ids, delta) {
  const picked = pickNotes(motif, ids);
  if (!Number.isInteger(delta)) throw new Error(`Moontide: a Scratchpad velocity change needs a whole number of hundredths, got ${String(delta)}`);
  const changed = new Map(picked.map((note) => [note.id, makeNote(note.id, note.pitch, note.start, note.length, clamp(note.velocity + delta, 1, 100))]));
  const notes = motif.notes.map((note) => changed.get(note.id) ?? note);
  if (notes.every((note, index) => note === motif.notes[index] || note.velocity === motif.notes[index].velocity)) return unchanged(motif);
  const next = Object.freeze({ ...motif, notes: Object.freeze(notes) });
  if (picked.length === 1) {
    const [old] = picked;
    return {
      motif: next,
      notice: fillScratch(SCRATCH_COPY.velocitySet, { name: noteName(old.pitch), velocity: velocityText(changed.get(old.id).velocity) }),
      cut: 0,
      merged: 0,
      what: fillScratch(SCRATCH_COPY.whatVelocity, { name: noteName(old.pitch) }),
    };
  }
  const sentence = fillScratch(delta > 0 ? SCRATCH_COPY.velocityRaised : SCRATCH_COPY.velocityLowered, { notes: notesText(picked.length), amount: velocityText(Math.abs(delta)) });
  return { motif: next, notice: sentence, cut: 0, merged: 0, what: manyWhat(SCRATCH_COPY.whatVelocityMany, picked.length) };
}

/**
 * Moves the whole motif so its first note falls on the nearest beat (a beat is a quarter note, 12 units), forward or back; an exact half
 * goes to the earlier beat. Every note keeps its length, pitch, velocity and the spacing between notes, and the motif keeps its source and
 * its recorded moment, because notes moving inside the motif do not change which music cycle its first cycle stands at. Every grid step
 * divides a beat, so the move is always whole steps. Returns `{ motif, notice, cut, merged, what }`: a first note already on a beat gives the
 * same motif and says so; a move later that would push the last note past the motif's end, and a roll with no notes, give the motif as it was
 * and the sentence in `refused`.
 */
export function alignMotif(motif) {
  if (motif.notes.length === 0) return recordRefusal(motif, SCRATCH_COPY.alignNothing);
  const first = Math.min(...motif.notes.map((note) => note.start));
  const delta = nearestStep(first, UNITS_PER_BEAT) * UNITS_PER_BEAT - first;
  if (delta === 0) return { motif, notice: SCRATCH_COPY.alignedAlready, cut: 0, merged: 0, what: '' };
  if (Math.max(...motif.notes.map((note) => note.start + note.length)) + delta > motifUnits(motif)) return recordRefusal(motif, SCRATCH_COPY.alignOverflow);
  const done = rebuild(motif, motif.notes.map((note) => makeNote(note.id, note.pitch, note.start + delta, note.length, note.velocity)), motif.nextId);
  const grid = gridOf(motif.grid);
  return {
    motif: done.motif,
    notice: fillScratch(SCRATCH_COPY.aligned, {
      distance: stepsText(Math.abs(delta) / grid.unit, grid),
      direction: delta < 0 ? SCRATCH_COPY.movedEarlier : SCRATCH_COPY.movedLater,
      ...positionOf(first + delta),
    }),
    cut: done.cut,
    merged: done.merged,
    what: SCRATCH_COPY.whatAligned,
  };
}

/**
 * Removes every note as one command, with no question asked: Undo is the way back, and the notice says so. The grid, the cycles and the
 * ids still to come stay; the source and the recorded moment go with the notes. A roll with no notes gives the motif as it was and the
 * sentence in `refused`.
 */
export function clearMotif(motif) {
  if (motif.notes.length === 0) return recordRefusal(motif, SCRATCH_COPY.clearNothing);
  const count = motif.notes.length;
  return {
    motif: Object.freeze({ ...motif, notes: Object.freeze([]), source: null, recorded: null }),
    notice: count === 1 ? SCRATCH_COPY.clearedOne : fillScratch(SCRATCH_COPY.clearedMany, { count }),
    cut: 0,
    merged: 0,
    what: SCRATCH_COPY.whatCleared,
  };
}

/**
 * The sentence for a selection change, from `{ kind, name, count }`: 'all' (with the number of notes in the motif), 'none', 'added' and
 * 'removed' (the note's name and how many notes are selected now) and 'nothing-here'. Any other kind throws.
 */
export function selectionText({ kind, name, count }) {
  const tail = count === 0 ? SCRATCH_COPY.selectedNothing : fillScratch(SCRATCH_COPY.selectedCount, { notes: notesText(count) });
  switch (kind) {
    case 'all':
      if (count === 0) return SCRATCH_COPY.selectNoNotes;
      return count === 1 ? SCRATCH_COPY.selectedOnly : fillScratch(SCRATCH_COPY.selectedAll, { notes: notesText(count) });
    case 'none':
      return SCRATCH_COPY.selectedNone;
    case 'added':
      return fillScratch(SCRATCH_COPY.selectedAdded, { name, count: tail });
    case 'removed':
      return fillScratch(SCRATCH_COPY.selectedRemoved, { name, count: tail });
    case 'nothing-here':
      return SCRATCH_COPY.selectNoNote;
    default:
      throw new Error(`Moontide: the Scratchpad does not know the selection change '${String(kind)}'`);
  }
}

/** The line for several selected notes as two parts, `{ name, rest }`: '3 notes selected' and ' · C4 to E4 · from cycle 1, beat 1'. */
export function selectionParts(motif, ids) {
  const picked = pickNotes(motif, ids);
  const low = Math.min(...picked.map((note) => note.pitch));
  const high = Math.max(...picked.map((note) => note.pitch));
  const where = positionOf(Math.min(...picked.map((note) => note.start)));
  return {
    name: fillScratch(SCRATCH_COPY.selectionName, { notes: notesText(picked.length) }),
    rest: low === high ? fillScratch(SCRATCH_COPY.selectionOnePitch, { low: noteName(low), ...where }) : fillScratch(SCRATCH_COPY.selectionRange, { low: noteName(low), high: noteName(high), ...where }),
  };
}

/**
 * The note before (`direction` -1) or after (1) a cursor `{ unit, pitch }` in time order: by start, then the lower pitch first, the
 * order the velocity lane walks. A note at the cursor itself is neither. Null when there is none that way.
 */
export function neighborNote(motif, cursor, direction) {
  const order = (note) => note.start * 1000 + note.pitch;
  const at = cursor.unit * 1000 + cursor.pitch;
  const ahead = motif.notes.filter((note) => (direction > 0 ? order(note) > at : order(note) < at)).sort((a, b) => order(a) - order(b) || a.id - b.id);
  if (ahead.length === 0) return null;
  return direction > 0 ? ahead[0] : ahead[ahead.length - 1];
}

/** A key press older than this many milliseconds, by the handler's clock, is not placed. */
export const STAMP_WINDOW_MS = 1000;
/** A key press stamped more than this many milliseconds after the handler's clock is not placed. */
export const AHEAD_MS = 1;

/**
 * Whether the time stamp `ts` of a key press can be placed, judged against `h`, the handler's own clock read first (both in
 * milliseconds on the page's clock). Gives null for a usable stamp, else one reason word: 'zero' for a stamp of exactly 0,
 * 'not-a-number' when either value is not a finite number, 'ahead' when the stamp is more than 1 ms after the handler's clock and
 * 'stale' when it is more than 1000 ms before it. There is no fallback to the wall clock and no correction.
 */
export function checkStamp(ts, h) {
  if (typeof ts !== 'number' || typeof h !== 'number' || !Number.isFinite(ts) || !Number.isFinite(h)) return 'not-a-number';
  if (ts === 0) return 'zero';
  if (ts > h + AHEAD_MS) return 'ahead';
  if (ts < h - STAMP_WINDOW_MS) return 'stale';
  return null;
}

function checkAnchor(anchor, name) {
  if (anchor === null || typeof anchor !== 'object' || typeof anchor.c !== 'number' || typeof anchor.t !== 'number' || !Number.isFinite(anchor.c) || !Number.isFinite(anchor.t)) {
    throw new Error(`Moontide: the cycle line ${name} needs a finite cycle and a finite stamp.`);
  }
}

/**
 * The music's cycle at the stamp `t` on the straight line through the two cycle-line anchors `a` and `b`, each `{ c, t }` (a cycle
 * and its stamp on the page clock). An anchor that is not finite, a stamp that is not finite, or two anchors with the same stamp throws.
 */
export function cycleAtStamp(t, a, b) {
  if (typeof t !== 'number' || !Number.isFinite(t)) throw new Error(`Moontide: a stamp must be a finite number, got ${String(t)}`);
  checkAnchor(a, 'a');
  checkAnchor(b, 'b');
  if (a.t === b.t) throw new Error('Moontide: the two cycle lines have the same stamp, so no line runs through them.');
  return a.c + ((t - a.t) * (b.c - a.c)) / (b.t - a.t);
}

/** Where a music cycle falls inside a motif of `cycles` cycles, in units and not rounded: the cycle modulo the motif's length (a positive modulo). */
export function unitInMotif(cycle, cycles) {
  if (typeof cycle !== 'number' || !Number.isFinite(cycle)) throw new Error(`Moontide: a cycle must be a finite number, got ${String(cycle)}`);
  return (((cycle % cycles) + cycles) % cycles) * UNITS_PER_CYCLE;
}

/**
 * Where a music cycle falls in the motif, in units: the cycle modulo the motif's cycles (a positive modulo), snapped to the nearest
 * step of the motif's grid with a tie to the earlier step. A position that rounds to the motif's end wraps to step 0. A cycle that is
 * not a finite number throws.
 */
export function tapStart({ cycle, motif }) {
  if (typeof cycle !== 'number' || !Number.isFinite(cycle)) throw new Error(`Moontide: a tap needs a finite cycle, got ${String(cycle)}`);
  const step = gridOf(motif.grid).unit;
  // The position is fractional here (nearestStep is for whole units): the nearest step, an exact half going to the earlier one.
  const start = Math.max(0, Math.ceil(unitInMotif(cycle, motif.cycles) / step - 0.5)) * step;
  return start >= motifUnits(motif) ? 0 : start;
}

/** The longest port name the listening line shows; the setup file allows no longer one. */
const MAX_PORT_TEXT = 200;

/** A port name as plain text, cut at the name limit with an ellipsis. */
function portText(name) {
  const points = Array.from(String(name));
  return points.length <= MAX_PORT_TEXT ? points.join('') : `${points.slice(0, MAX_PORT_TEXT - 1).join('')}\u2026`;
}

const STAMP_REASONS = Object.freeze({
  zero: 'tapReasonZero',
  'not-a-number': 'tapReasonNotANumber',
  ahead: 'tapReasonAhead',
  stale: 'tapReasonStale',
});

function tapRefusal(motif, refused) {
  return { motif, notice: '', cut: 0, merged: 0, note: null, what: '', refused };
}

/** True for two cycle-line anchors that can make a line: both finite, with different stamps. */
function anchorsUsable(anchors) {
  if (anchors === null || typeof anchors !== 'object') return false;
  try {
    checkAnchor(anchors.a, 'a');
    checkAnchor(anchors.b, 'b');
  } catch {
    return false;
  }
  return anchors.a.t !== anchors.b.t;
}

/**
 * Places a one-step note at velocity 80 where a key press fell: `ts` is the press's own time stamp, `h` the handler's clock read
 * before it, `anchors` the stamps of two cycle lines `{ a: { c, t }, b: { c, t } }` or null when the music's clock could not give
 * them, and `pitch` the row of the cursor. A refused stamp, or anchors that cannot make a line, gives the motif as it was and the
 * sentence in `refused`; otherwise the result is the one of placeNote, with the tap's own notice and `what`.
 */
export function tapNote(motif, { ts, h, anchors, pitch }) {
  const reason = checkStamp(ts, h);
  if (reason !== null) return tapRefusal(motif, fillScratch(SCRATCH_COPY.tapStampRefused, { reason: SCRATCH_COPY[STAMP_REASONS[reason]] }));
  if (!anchorsUsable(anchors)) return tapRefusal(motif, SCRATCH_COPY.tapClockUnreadable);
  const start = tapStart({ cycle: cycleAtStamp(ts, anchors.a, anchors.b), motif });
  const placed = placeNote(motif, { pitch, start, length: gridOf(motif.grid).unit }, 'tapped');
  const name = noteName(pitch);
  return {
    ...placed,
    notice: fillScratch(SCRATCH_COPY.tapped, { name, ...positionOf(placed.note.start) }) + ruleWords(placed),
    what: placed.what === '' ? '' : fillScratch(SCRATCH_COPY.whatTapped, { name }),
  };
}

function recordRefusal(motif, refused) {
  return { motif, notice: '', cut: 0, merged: 0, what: '', refused };
}

/** The cycles of the ring the live view draws: the keyboard buffer's 8 cycles, drawn as one loop that the playhead runs round. */
export const RING_CYCLES = MAX_CYCLES;
const RING_UNITS = RING_CYCLES * UNITS_PER_CYCLE;

// The nearest step of a grid to a place given in cycles, an exact half going to the earlier step; the first step at the least. The one
// rule that puts a played note on the grid: the live layer and Record that both get their places from ringLayout, which calls this.
function snapToStep(cycle, step) {
  return Math.max(0, Math.ceil((cycle * UNITS_PER_CYCLE) / step - 0.5)) * step;
}

/**
 * Where a snapshot of the keyboard buffer sits on the ring: the one layout the live layer draws and Record that writes, so the motif after
 * the press holds exactly what was shown. `snapshot` is the one of page/played-buffer.js: `{ start, cycles, notes }` with each note
 * `{ pitch, velocity, start, end, run, held }` in cycles from the window's first cycle (`held` may be left out and then means not held).
 * `gridId` is one of the five grids.
 *
 * A note's place is its axis cycle, the window's start plus its cycle in the window, snapped to the grid (the nearest step, an exact half going
 * to the earlier one, and the end at least one step after the start), and then taken round the ring: the column is the axis cycle modulo 8,
 * the unit is that place modulo 384. A start that snaps onto the next cycle line lands in the next column, and one that snaps onto the ring's end
 * lands at unit 0. A note that passes unit 384 is cut there and goes on from unit 0, as two pieces of the same pitch and velocity; a note never
 * covers more than one lap. Returns `{ pieces, outside }`: each piece is `{ pitch, velocity, start, end, held, run, lap }` with `start` and
 * `end` in units (0 to 384), the velocity in hundredths (1 to 100), `held` true only for the last piece of a note whose key is still down (its
 * right edge is open), `run` the run of the music the note was placed in (a whole number or null) and `lap` the axis cycle of the piece's start
 * divided by 8, rounded down (the piece that goes on from unit 0 is in the next lap). The pieces come in the order the notes were played.
 * A pitch outside C0 to B8 is not placed and is counted in `outside`. A snapshot or a value that cannot be used throws.
 */
export function ringLayout(snapshot, gridId) {
  if (snapshot === null || typeof snapshot !== 'object' || !Array.isArray(snapshot.notes)) throw new Error('Moontide: the ring layout needs a snapshot with a list of notes.');
  if (!Number.isFinite(snapshot.cycles) || snapshot.cycles <= 0) throw new Error(`Moontide: a snapshot needs a positive number of cycles, got ${String(snapshot.cycles)}`);
  if (!Number.isFinite(snapshot.start)) throw new Error(`Moontide: a snapshot needs a finite start, got ${String(snapshot.start)}`);
  const step = gridOf(gridId).unit;
  const pieces = [];
  let outside = 0;
  for (const note of snapshot.notes) {
    if (!Number.isInteger(note.pitch)) throw new Error(`Moontide: a played note needs a whole pitch, got ${String(note.pitch)}`);
    if (!Number.isInteger(note.velocity) || note.velocity < 1 || note.velocity > 127) throw new Error(`Moontide: a played note needs a velocity from 1 to 127, got ${String(note.velocity)}`);
    if (!Number.isFinite(note.start) || !Number.isFinite(note.end)) throw new Error('Moontide: a played note needs a finite start and end.');
    if (note.run !== null && !Number.isInteger(note.run)) throw new Error(`Moontide: a played note needs a run that is null or a whole number, got ${String(note.run)}`);
    if (note.pitch < MIN_PITCH || note.pitch > MAX_PITCH) {
      outside += 1;
      continue;
    }
    const velocity = Math.max(1, Math.round((note.velocity * 100) / 127));
    const from = snapToStep(snapshot.start + note.start, step);
    const to = Math.max(snapToStep(snapshot.start + note.end, step), from + step);
    const start = from % RING_UNITS;
    const lap = Math.floor(from / RING_UNITS);
    const length = Math.min(to - from, RING_UNITS);
    const held = note.held === true;
    if (start + length <= RING_UNITS) {
      pieces.push({ pitch: note.pitch, velocity, start, end: start + length, held, run: note.run, lap });
    } else {
      pieces.push({ pitch: note.pitch, velocity, start, end: RING_UNITS, held: false, run: note.run, lap });
      pieces.push({ pitch: note.pitch, velocity, start: 0, end: start + length - RING_UNITS, held, run: note.run, lap: lap + 1 });
    }
  }
  return { pieces, outside };
}

/**
 * Turns what the keyboard played into the motif, in place of the one there (the motif's grid stays). `snapshot` is the one of
 * page/played-buffer.js: `{ start, cycles, notes }` with each note `{ pitch, velocity, start, end, run }` in cycles from the window's start;
 * `run` is the whole-number offset of the cycle axis the note was placed at, or null when the tempo placed it.
 * The notes are placed on the ring by ringLayout, the very layout the live view draws: a note played in the axis cycle c sits in column c
 * modulo 8, snapped to the grid, and a note that crosses the ring's right end is two notes, one ending at the motif's end and one starting
 * at 0. A take that runs past the right end (played from column 8 into column 1) therefore becomes a motif with the later bar first and
 * empty cycles between. A pitch outside the roll is left out and counted. The motif's cycles run from the column of the earliest start to the
 * column that holds the latest end (1 to 8), and positions move back by whole columns, so the music's downbeats stay downbeats. Velocities are
 * kept in hundredths. Then the same-pitch rule runs. The new motif's recorded moment is `{ cycle }`: when every note the roll can show was
 * placed by one run R of the music and lies in one lap of the ring, it is the music's own cycle where the motif's first column was played,
 * 8 times the lap plus that column minus R (null when it is below 0); otherwise null, because nothing is guessed (two laps, two runs, or notes
 * placed by the tempo). Returns `{ motif, notice, cut, merged, what }` like every command; an empty or missing snapshot, or one with no
 * note the roll can show, gives the motif as it was and the sentence in `refused`. A value that cannot be used throws.
 */
export function recordBuffer(motif, snapshot) {
  const played = snapshot === null || typeof snapshot !== 'object' || !Array.isArray(snapshot.notes) ? [] : snapshot.notes;
  if (played.length === 0) return recordRefusal(motif, SCRATCH_COPY.recordNothing);
  const { pieces, outside } = ringLayout(snapshot, motif.grid);
  if (pieces.length === 0) return recordRefusal(motif, fillScratch(SCRATCH_COPY.recordOnlyOutside, { outside: outsideWords(outside) }));
  const firstCycle = Math.floor(Math.min(...pieces.map((piece) => piece.start)) / UNITS_PER_CYCLE);
  const lastCycle = Math.floor((Math.max(...pieces.map((piece) => piece.end)) - 1) / UNITS_PER_CYCLE);
  const cycles = lastCycle - firstCycle + 1;
  const shift = firstCycle * UNITS_PER_CYCLE;
  // The new motif is the keyboard's: played. Its moment is the music's cycle where its first column was played, only when one run of the music
  // and one lap of the ring placed every note (the axis then differs from the music's count by that run); else null, no moment.
  const runs = new Set(pieces.map((piece) => piece.run));
  const laps = new Set(pieces.map((piece) => piece.lap));
  const [run] = runs;
  const [lap] = laps;
  let cycle = null;
  if (runs.size === 1 && run !== null && laps.size === 1) {
    const music = RING_CYCLES * lap + firstCycle - run;
    if (Number.isInteger(music) && music >= 0) cycle = music;
  }
  const base = Object.freeze({ ...motif, cycles, notes: Object.freeze([]), source: 'played', recorded: Object.freeze({ cycle }) });
  const notes = pieces.map((piece, index) => makeNote(motif.nextId + index, piece.pitch, piece.start - shift, piece.end - piece.start, piece.velocity));
  const done = rebuild(base, notes, motif.nextId + notes.length);
  const notice =
    fillScratch(SCRATCH_COPY.recorded, { notes: notesText(done.notes.length), cycles: cyclesText(cycles), grid: gridOf(motif.grid).many }) +
    ruleWords(done) +
    (outside === 0 ? '' : outsideWords(outside)) +
    SCRATCH_COPY.recordUndo;
  return { motif: done.motif, notice, cut: done.cut, merged: done.merged, what: SCRATCH_COPY.whatRecorded };
}

/**
 * The sentence for the keyboard's listening state `{ listen, ports, listened, notOpened, missing, unplugged, several, available, failure }` (see page/midi-in.js):
 * what is listened to, or why not and what to do, with the inputs that exist when the reason is a name. Each state word has its own sentence. Port names are cut at the name limit and are plain text.
 */
export function listeningText(state) {
  const names = (list) => (list.length === 0 ? SCRATCH_COPY.listenNoInputs : list.map(portText).join(SCRATCH_COPY.listenJoin));
  const ports = names(state.ports);
  switch (state.listen) {
    case 'absent':
      return SCRATCH_COPY.listenAbsent;
    case 'invalid':
      return SCRATCH_COPY.listenInvalid;
    case 'none':
      return SCRATCH_COPY.listenNone;
    case 'needs-permission':
      return fillScratch(SCRATCH_COPY.listenNeedsPermission, { ports });
    case 'pending':
      return SCRATCH_COPY.listenPending;
    case 'denied':
      return SCRATCH_COPY.listenDenied;
    case 'unsupported':
      return SCRATCH_COPY.listenUnsupported;
    case 'failed':
      return fillScratch(SCRATCH_COPY.listenFailed, { failure: portText(state.failure ?? 'Error') });
    case 'hidden':
      return SCRATCH_COPY.listenHidden;
    case 'other-tab':
      return SCRATCH_COPY.listenOtherTab;
    case 'listening': {
      const others = state.missing.filter((name) => !state.several.includes(name));
      return (
        fillScratch(SCRATCH_COPY.listenListening, { ports: names(state.listened) }) +
        (others.length === 0 ? '' : fillScratch(SCRATCH_COPY.listenNotFound, { ports: names(others) })) +
        (state.several.length === 0 ? '' : fillScratch(SCRATCH_COPY.listenNotTold, { ports: names(state.several) })) +
        (state.notOpened.length === 0 ? '' : fillScratch(SCRATCH_COPY.listenNotOpenedToo, { ports: names(state.notOpened) }))
      );
    }
    case 'not-opened':
      return fillScratch(SCRATCH_COPY.listenNotOpened, { port: portText(state.notOpened[0]) });
    case 'ambiguous': {
      const port = state.several[0];
      return fillScratch(SCRATCH_COPY.listenAmbiguous, { count: state.available.filter((name) => name === port).length, port: portText(port) });
    }
    case 'unplugged':
      return fillScratch(SCRATCH_COPY.listenUnplugged, { port: portText(state.unplugged[0]), names: names(state.available) });
    case 'missing':
      return fillScratch(SCRATCH_COPY.listenMissing, { port: portText(state.missing[0]), names: names(state.available) });
    default:
      throw new Error(`Moontide: the keyboard's listening state is not known: ${String(state.listen)}`);
  }
}

/**
 * The line about the last note the keyboard played, or '' when nothing was heard or refused: the note's name and how many notes are kept,
 * or why the last note was not kept. `state` is the one of page/midi-in.js.
 */
export function heardText(state) {
  if (state.refused !== null) {
    if (state.refused === 'clock') return SCRATCH_COPY.heardRefusedClock;
    if (state.refused === 'full') return SCRATCH_COPY.heardRefusedFull;
    return fillScratch(SCRATCH_COPY.heardRefusedStamp, { reason: SCRATCH_COPY[STAMP_REASONS[state.refused]] });
  }
  if (state.heard === null) return '';
  return fillScratch(SCRATCH_COPY.heard, { name: noteName(state.heard.pitch), notes: notesText(state.count) });
}

/**
 * The motif as the notes Listen plays: events `{ unit, kind: 'on' | 'off', pitch, velocity }` in units from the motif's start, sorted by unit with
 * the offs first at one unit (so two notes of one pitch, one right after the other, both sound) and, inside one kind, by pitch. A velocity is the
 * MIDI byte of the note's hundredths (rounded, at least 1) on an on and 0 on an off. A note-off sits at the note's written end; the player ends
 * the sound a little before it, as the music's own MIDI path does.
 */
export function listenSchedule(motif) {
  const events = [];
  for (const note of motif.notes) {
    events.push({ unit: note.start, kind: 'on', pitch: note.pitch, velocity: Math.max(1, Math.round((note.velocity * 127) / 100)) });
    events.push({ unit: note.start + note.length, kind: 'off', pitch: note.pitch, velocity: 0 });
  }
  return events.sort((a, b) => a.unit - b.unit || (a.kind === b.kind ? 0 : a.kind === 'off' ? -1 : 1) || a.pitch - b.pitch);
}

/**
 * The menu of Listen: one option for each instrument of the setup file and each channel it uses (both roles, once each), in the file's order,
 * as `{ value, text, title, instrumentId, channel, enabled, port }`. `value` joins the id and the channel with a bar, `text` reads
 * `sc55 · channel 3` and `title` adds the port, and `monophonic` is true only when the rig says the instrument plays one note at a time. Names are plain text cut at the name limit. A rig that is absent, has a problem or is null gives none.
 */
export function listenOptions(rig) {
  if (rig === null || rig === undefined || rig.setup !== 'valid') return [];
  const options = [];
  for (const instrument of rig.instruments) {
    const channels = [...new Set(instrument.channels.map((entry) => entry.channel))].sort((a, b) => a - b);
    for (const channel of channels) {
      const names = { id: portText(instrument.id), channel, port: portText(instrument.port) };
      options.push({
        value: `${instrument.id}|${channel}`,
        text: fillScratch(SCRATCH_COPY.hearOutputOption, names),
        title: fillScratch(SCRATCH_COPY.hearOutputTitle, names),
        instrumentId: instrument.id,
        channel,
        enabled: instrument.enabled !== false,
        port: instrument.port,
        // Only what the instrument's model states; the page never guesses it, so a rig that says nothing gives false.
        monophonic: instrument.monophonic === true,
      });
    }
  }
  return options;
}

// A sentence in two or three parts, so the page can show the instrument id heavier than the rest, as the note line shows the note name.
function hearParts(template, values) {
  const at = template.indexOf('{instrument}');
  if (at === -1) return { before: fillScratch(template, values), id: '', after: '' };
  return { before: fillScratch(template.slice(0, at), values), id: portText(values.instrument), after: fillScratch(template.slice(at + '{instrument}'.length), values) };
}

/**
 * True when two notes of the motif sound at the same time: their spans overlap, whether or not they start together. A note that starts where
 * another ends is not a chord.
 */
export function hasChord(motif) {
  let reach = -Infinity;
  for (const note of [...motif.notes].sort((a, b) => a.start - b.start)) {
    if (note.start < reach) return true;
    reach = Math.max(reach, note.start + note.length);
  }
  return false;
}

/**
 * The Heads up sentences of the hear strip for the chosen instrument and channel, each as `{ before, id, after }` (the instrument id apart, as in
 * hearText), in the order they are shown: the channel first, then the chord. `tracks` are the display names of the unmuted tracks of the playing
 * code on that instrument and channel (none: nothing is said), `monophonic` is the rig's fact for the instrument (absent or false: unknown, nothing
 * is said) and `chord` says whether the motif has one. Track names are plain text, cut at the name limit. A warning never blocks Listen: this only
 * words what the page already knows.
 */
export function hearWarnings({ instrumentId, channel, tracks = [], monophonic = false, chord = false }) {
  const values = { instrument: instrumentId, channel, tracks: tracks.map(portText).join(SCRATCH_COPY.listenJoin) };
  const warnings = [];
  if (tracks.length > 0) warnings.push(hearParts(tracks.length === 1 ? SCRATCH_COPY.hearChannelBusy : SCRATCH_COPY.hearChannelBusyMany, values));
  if (monophonic === true && chord === true) warnings.push(hearParts(SCRATCH_COPY.hearMonophonic, values));
  return warnings;
}

/**
 * The sentence of the hear strip for a state, as `{ before, id, after }`: the instrument id apart (it is shown heavier) and the words around it. A
 * state is `{ kind, ... }` with `instrumentId` and `channel` when an instrument is chosen: 'choose', 'no-instrument' (with `setup`, the setup file's
 * word), 'playing' (with `loop`), 'ended', 'stopped' and 'refused' (with `refused`, the reason word, and `port`, `names`, `count` and `mid` where
 * it has them). A word or kind the model does not know throws.
 */
export function hearText(state) {
  const values = { instrument: state.instrumentId ?? '', channel: state.channel ?? '', port: portText(state.port ?? ''), count: state.count ?? 0, failure: portText(state.failure ?? 'Error'), names: (state.names ?? []).length === 0 ? SCRATCH_COPY.listenNoInputs : (state.names ?? []).map(portText).join(SCRATCH_COPY.listenJoin) };
  switch (state.kind) {
    case 'choose':
      return hearParts(SCRATCH_COPY.hearChoose, values);
    case 'no-instrument':
      return hearParts(state.setup === 'absent' ? SCRATCH_COPY.hearNoInstrumentAbsent : state.setup === 'invalid' ? SCRATCH_COPY.hearNoInstrumentInvalid : SCRATCH_COPY.hearNoInstrumentNone, values);
    case 'playing':
      return hearParts(state.loop === true ? SCRATCH_COPY.hearPlayingLoop : SCRATCH_COPY.hearPlaying, values);
    case 'ended':
      return hearParts(SCRATCH_COPY.hearEnded, values);
    case 'waiting':
      return hearParts(SCRATCH_COPY.hearWaiting, { ...values, cycle: state.cycle });
    case 'asking':
      return hearParts(SCRATCH_COPY.hearAsking, values);
    case 'stopped':
      return hearParts(stoppedWords(state.reason), values);
    case 'refused':
      return hearParts(refusedWords(state), values);
    default:
      throw new Error(`Moontide: the Scratchpad hear state is not known: ${String(state.kind)}`);
  }
}

// The template of a stop, by the reason the player gives.
function stoppedWords(reason) {
  switch (reason) {
    case 'stop':
      return SCRATCH_COPY.hearStopped;
    case 'hidden':
      return SCRATCH_COPY.hearHidden;
    case 'music-stopped':
      return SCRATCH_COPY.hearMusicStopped;
    case 'closed':
      return SCRATCH_COPY.hearClosed;
    case 'page':
      return SCRATCH_COPY.hearLeft;
    default:
      throw new Error(`Moontide: a Listen stop reason is not known: ${String(reason)}`);
  }
}

// The template of a refusal: the word the page's MIDI layer or the player gives. A play that had begun and lost its output says it stopped.
function refusedWords(state) {
  switch (state.refused) {
    case 'empty':
      return SCRATCH_COPY.hearNoNotes;
    case 'no-output':
      return state.mid === true ? SCRATCH_COPY.hearUnplugged : SCRATCH_COPY.hearNoOutput;
    case 'ambiguous':
      return SCRATCH_COPY.hearAmbiguous;
    case 'off':
      return SCRATCH_COPY.hearOff;
    case 'resetting':
      return SCRATCH_COPY.hearResetting;
    case 'superseded':
      return SCRATCH_COPY.hearSuperseded;
    case 'no-rig':
      return SCRATCH_COPY.hearNoRig;
    case 'no-instrument':
      return SCRATCH_COPY.hearUnknownInstrument;
    case 'tempo':
      return SCRATCH_COPY.hearTempo;
    case 'invalid':
      return SCRATCH_COPY.hearInvalid;
    case 'send-failed':
      return SCRATCH_COPY.hearSendFailed;
    case 'music-not-playing':
      return SCRATCH_COPY.hearMusicNotPlaying;
    case 'no-clock':
      return SCRATCH_COPY.hearNoClock;
    case 'denied':
      return SCRATCH_COPY.hearDenied;
    case 'unsupported':
      return SCRATCH_COPY.hearUnsupported;
    case 'failed':
      return SCRATCH_COPY.hearFailed;
    default:
      throw new Error(`Moontide: Listen was refused for a word the Scratchpad does not know: ${String(state.refused)}`);
  }
}

/** The sentence that says how many played notes the roll could not show. */
function outsideWords(count) {
  return count === 1 ? SCRATCH_COPY.recordOutsideOne : fillScratch(SCRATCH_COPY.recordOutside, { count });
}

/** The notes with a count in words: '1 note' or '3 notes'. */
export function notesText(count) {
  return count === 1 ? SCRATCH_COPY.oneNote : fillScratch(SCRATCH_COPY.manyNotes, { count });
}

/** '1 cycle' or 'N cycles'. */
export function cyclesText(cycles) {
  return cycles === 1 ? SCRATCH_COPY.oneCycle : fillScratch(SCRATCH_COPY.manyCycles, { count: cycles });
}

/**
 * Moves every note onto the grid `gridId` at once: a start goes to the nearest step and a length to the nearest whole step, a tie
 * going to the earlier step and down, a length never below one step; a start that rounds to the motif's end wraps to step 0, as a tap
 * does. Then the same-pitch rule runs, so notes of one pitch that land in one cell become the stronger one. Returns
 * `{ motif, notice, cut, merged }`; the grid already in use gives the same motif and an empty notice. An id outside the list throws.
 */
export function setGrid(motif, gridId) {
  const grid = gridOf(gridId);
  if (gridId === motif.grid) return { motif, notice: '', cut: 0, merged: 0, what: '' };
  const units = motifUnits(motif);
  let moved = 0;
  const notes = motif.notes.map((note) => {
    const start = nearestStep(note.start, grid.unit) * grid.unit;
    const length = Math.max(1, nearestStep(note.length, grid.unit)) * grid.unit;
    const wrapped = start >= units ? 0 : start;
    if (wrapped === note.start && length === note.length) return note;
    moved += 1;
    return makeNote(note.id, note.pitch, wrapped, length, note.velocity);
  });
  const next = Object.freeze({ ...motif, grid: gridId });
  const done = rebuild(next, notes, motif.nextId);
  const mergedWords = done.merged === 0 ? '' : fillScratch(SCRATCH_COPY.gridMerged, { count: done.merged });
  const rest = moved === 0 ? '' : fillScratch(SCRATCH_COPY.gridMoved, { notes: notesText(moved), merged: mergedWords });
  const cutWords = done.cut === 0 ? '' : fillScratch(done.cut === 1 ? SCRATCH_COPY.cut : SCRATCH_COPY.cutMany, { count: done.cut });
  return {
    motif: done.motif,
    notice: fillScratch(SCRATCH_COPY.gridNotice, { grid: grid.many, rest }) + cutWords,
    cut: done.cut,
    merged: done.merged,
    what: fillScratch(SCRATCH_COPY.whatGrid, { grid: grid.many }),
  };
}

/**
 * Sets the motif to `cycles` cycles, a whole number from 1 to 8 (anything else throws). More cycles keeps every note. Fewer is
 * refused, with the motif unchanged and the sentence in `refused`, while a note starts in a cycle that would go (the first such
 * cycle is named); otherwise a note that runs into the cycles that go is cut at the new end, and `cut` counts them. The same number
 * gives the same motif and an empty notice. Returns `{ motif, notice, cut, merged }`, plus `refused` when it refuses.
 */
export function setCycles(motif, cycles) {
  if (!Number.isInteger(cycles) || cycles < MIN_CYCLES || cycles > MAX_CYCLES) {
    throw new Error(`Moontide: the Scratchpad cycles must be a whole number from ${MIN_CYCLES} to ${MAX_CYCLES}, got ${String(cycles)}`);
  }
  if (cycles === motif.cycles) return { motif, notice: '', cut: 0, merged: 0, what: '' };
  const units = cycles * UNITS_PER_CYCLE;
  if (cycles < motif.cycles) {
    for (let cycle = cycles + 1; cycle <= motif.cycles; cycle += 1) {
      const holding = motif.notes.filter((note) => Math.floor(note.start / UNITS_PER_CYCLE) + 1 === cycle).length;
      if (holding > 0) {
        const refused = fillScratch(SCRATCH_COPY.cyclesRefused, { cycle, notes: notesText(holding) });
        return { motif, notice: '', cut: 0, merged: 0, what: '', refused };
      }
    }
  }
  const cutCount = motif.notes.filter((note) => note.start + note.length > units).length;
  const next = Object.freeze({ ...motif, cycles });
  const done = rebuild(next, motif.notes, motif.nextId);
  const cutWords = cutCount === 0 ? '' : cutCount === 1 ? SCRATCH_COPY.cyclesCut : fillScratch(SCRATCH_COPY.cyclesCutMany, { count: cutCount });
  return {
    motif: done.motif,
    notice: fillScratch(SCRATCH_COPY.cyclesNow, { cycles: cyclesText(cycles) }) + cutWords,
    cut: cutCount,
    merged: 0,
    what: fillScratch(SCRATCH_COPY.whatCycles, { cycles: cyclesText(cycles) }),
  };
}

/** The semitones of room the shown range keeps above and below every pitch it has to show. */
const RANGE_MARGIN = 2;

/**
 * The pitch rows the roll shows, worked out from the notes each time it is drawn and never stored, so Undo, Redo, Clear, Record that and
 * Align always show the notes again: `{ low, high }`, the lowest and the highest shown pitch. It starts from the base window (the 24 rows
 * from `base`, which Lower and Higher move), joins the pitch of every note of the motif, every pitch in `extras` and the `cursor` pitch,
 * each with a margin of two semitones, then rounds the low end down to a C and the high end up to a B and holds the result to C0 to B8.
 * The rows are therefore never fewer than 24 and always a whole number of octaves. A base outside the windows or a pitch that is not a
 * whole number throws.
 */
export function shownRows(motif, { base, extras = [], cursor = null }) {
  if (!Number.isInteger(base) || base < MIN_WINDOW_START || base > MAX_WINDOW_START) {
    throw new Error(`Moontide: the base of the shown rows must be a whole number from ${MIN_WINDOW_START} to ${MAX_WINDOW_START}, got ${String(base)}`);
  }
  const pitches = [...motif.notes.map((note) => note.pitch), ...extras, ...(cursor === null ? [] : [cursor])];
  for (const pitch of pitches) {
    if (!Number.isInteger(pitch)) throw new Error(`Moontide: a pitch of the shown rows must be a whole number, got ${String(pitch)}`);
  }
  const lowest = Math.min(base, ...pitches.map((pitch) => pitch - RANGE_MARGIN));
  const highest = Math.max(base + WINDOW_ROWS - 1, ...pitches.map((pitch) => pitch + RANGE_MARGIN));
  return { low: Math.max(MIN_PITCH, Math.floor(lowest / 12) * 12), high: Math.min(MAX_PITCH, Math.floor(highest / 12) * 12 + 11) };
}

/** The Pitch readout: the shown range as 'C2–B5'. */
export function rangeText(low, high) {
  return fillScratch(SCRATCH_COPY.windowRange, { low: noteName(low), high: noteName(high) });
}

/** The Pitch readout in full words: 'C2 to B5'. */
export function rangeSpoken(low, high) {
  return fillScratch(SCRATCH_COPY.windowSpokenRange, { low: noteName(low), high: noteName(high) });
}

/** The most earlier states the history keeps; the oldest is dropped past this, so the memory stays flat. */
export const HISTORY_DEPTH = 100;

/**
 * The Scratchpad's own history of edits, kept apart from the music's History: a frozen `{ present, past, future }`. `past` and
 * `future` hold `{ motif, what }`, an earlier or a later motif and the phrase of the edit between it and its neighbour. Nothing here
 * ever changes what it is given: each function returns a new history, or the same one when nothing changed.
 */
export function createHistory(motif) {
  return Object.freeze({ present: motif, past: Object.freeze([]), future: Object.freeze([]) });
}

/**
 * Makes the result of a command the present. A result whose motif is the present one (no change), or that carries a refusal, adds nothing; a real edit clears the redo list.
 * With `amend` the result replaces the present and the phrase of the last step instead of adding one, so the auto-repeats of one held key
 * stay one step that Undo takes back to the motif before the first press; with no earlier step it adds the step like any commit.
 */
export function commit(history, result, { amend = false } = {}) {
  if (result.motif === history.present || result.refused !== undefined) return history;
  if (amend && history.past.length > 0) {
    const last = history.past[history.past.length - 1];
    const past = [...history.past.slice(0, -1), Object.freeze({ motif: last.motif, what: result.what })];
    return Object.freeze({ present: result.motif, past: Object.freeze(past), future: Object.freeze([]) });
  }
  const past = [...history.past, Object.freeze({ motif: history.present, what: result.what })].slice(-HISTORY_DEPTH);
  return Object.freeze({ present: result.motif, past: Object.freeze(past), future: Object.freeze([]) });
}

/** Steps back one edit: `{ history, motif, notice }`. With nothing to undo the history is the same one and the notice says so. */
export function undo(history) {
  if (history.past.length === 0) return { history, motif: history.present, notice: SCRATCH_COPY.nothingToUndo };
  const entry = history.past[history.past.length - 1];
  const next = Object.freeze({
    present: entry.motif,
    past: Object.freeze(history.past.slice(0, -1)),
    future: Object.freeze([...history.future, Object.freeze({ motif: history.present, what: entry.what })]),
  });
  return { history: next, motif: next.present, notice: fillScratch(SCRATCH_COPY.undid, { what: entry.what }) };
}

/** Steps forward one undone edit: `{ history, motif, notice }`. With nothing to redo the history is the same one and the notice says so. */
export function redo(history) {
  if (history.future.length === 0) return { history, motif: history.present, notice: SCRATCH_COPY.nothingToRedo };
  const entry = history.future[history.future.length - 1];
  const next = Object.freeze({
    present: entry.motif,
    past: Object.freeze([...history.past, Object.freeze({ motif: history.present, what: entry.what })].slice(-HISTORY_DEPTH)),
    future: Object.freeze(history.future.slice(0, -1)),
  });
  return { history: next, motif: next.present, notice: fillScratch(SCRATCH_COPY.redid, { what: entry.what }) };
}

/**
 * The notes an Undo or a Redo brought back or changed: the notes of `after` that `before` does not hold with the same id, pitch, start,
 * length and velocity, in the order of `after.notes`. A step that only took notes away gives an empty list.
 */
export function touchedNotes(before, after) {
  const held = new Map(before.notes.map((note) => [note.id, note]));
  return after.notes.filter((note) => {
    const old = held.get(note.id);
    return old === undefined || old.pitch !== note.pitch || old.start !== note.start || old.length !== note.length || old.velocity !== note.velocity;
  });
}

/** Where the window of 24 rows starts for a motif: the C at or below its lowest note, held from 12 to 96, and C3 when it is empty. */
export function windowStartFor(motif) {
  if (motif.notes.length === 0) return EMPTY_WINDOW_START;
  const lowest = Math.min(...motif.notes.map((note) => note.pitch));
  return clamp(Math.floor(lowest / 12) * 12, MIN_WINDOW_START, MAX_WINDOW_START);
}

const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** The note name with sharps and C4 = 60: 48 is 'C3', 61 is 'C#4', 119 is 'B8'. */
export function noteName(midi) {
  if (!Number.isInteger(midi) || midi < 0 || midi > 127) throw new Error(`Moontide: a note name needs a whole MIDI number from 0 to 127, got ${String(midi)}`);
  return `${SHARP_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;
}

/** True for the five black keys of an octave. */
export function isBlackKey(midi) {
  return SHARP_NAMES[midi % 12].includes('#');
}

/** A number of beats as up to two decimals without trailing zeros: 1, 2.25, 1.33. */
function beatNumber(beats) {
  return String(Number(beats.toFixed(2)));
}

/** The beat text of a unit inside one cycle: the beat number with the part of the beat as decimals ('1', '2.25', '1.33'). */
export function beatText(unitInCycle) {
  return beatNumber(1 + unitInCycle / UNITS_PER_BEAT);
}

/** Where a start unit lies: `{ cycle, beat }` with the cycle counted from 1 and the beat as text. */
export function positionOf(start) {
  return { cycle: Math.floor(start / UNITS_PER_CYCLE) + 1, beat: beatText(start % UNITS_PER_CYCLE) };
}

/** Number of beats in the whole motif. */
export function beatsIn(motif) {
  return motif.cycles * BEATS_PER_CYCLE;
}

/** A length in the grid's own words with the beats in brackets, except on quarters: '1 sixteenth (0.25 beat)', '6 sixteenths (1.5 beats)'. */
export function lengthText(length, gridId) {
  const grid = gridOf(gridId);
  const beats = length / UNITS_PER_BEAT;
  const steps = length / grid.unit;
  if (!Number.isInteger(steps)) {
    return `${beatNumber(beats)} ${beats > 1 ? SCRATCH_COPY.beatMany : SCRATCH_COPY.beatOne}`;
  }
  const word = steps === 1 ? grid.one : grid.many;
  if (grid.id === 'quarter') return `${steps} ${word}`;
  return fillScratch(SCRATCH_COPY.lengthWithBeats, { count: steps, word, beats: beatNumber(beats), beatWord: beats > 1 ? SCRATCH_COPY.beatMany : SCRATCH_COPY.beatOne });
}

/** A velocity in hundredths as text with two decimals: 80 is '0.80'. */
export function velocityText(velocity) {
  return (velocity / 100).toFixed(2);
}

/** The visible dot form of a note, `{ name, rest }`: 'E4' and ' · cycle 1, beat 2.25 · length 2 sixteenths (0.5 beat) · velocity 0.80'. */
export function noteParts(note, gridId) {
  return {
    name: fillScratch(SCRATCH_COPY.noteName, { name: noteName(note.pitch) }),
    rest: fillScratch(SCRATCH_COPY.noteRest, { ...positionOf(note.start), length: lengthText(note.length, gridId), velocity: velocityText(note.velocity) }),
  };
}

/** The spoken form of a note, also its accessible name: 'E4, starts at cycle 1, beat 2.25, lasts 2 sixteenths (0.5 beat), velocity 0.80.' */
export function spokenNote(note, gridId) {
  return fillScratch(SCRATCH_COPY.spokenNote, {
    name: noteName(note.pitch),
    ...positionOf(note.start),
    length: lengthText(note.length, gridId),
    velocity: velocityText(note.velocity),
  });
}

/** The visible dot form of an empty cell, `{ name, rest }`. */
export function emptyCellParts(pitch, unit) {
  return { name: fillScratch(SCRATCH_COPY.noteName, { name: noteName(pitch) }), rest: fillScratch(SCRATCH_COPY.emptyCellRest, positionOf(unit)) };
}

/** The spoken form of an empty cell: 'Row E4, cycle 1, beat 2.25, empty'. */
export function spokenEmptyCell(pitch, unit) {
  return fillScratch(SCRATCH_COPY.spokenEmpty, { name: noteName(pitch), ...positionOf(unit) });
}

/** '6 notes in 2 cycles on sixteenths.' and '1 note in 1 cycle on quarters.' */
export function summaryLine(motif) {
  return fillScratch(SCRATCH_COPY.summary, { notes: notesText(motif.notes.length), cycles: cyclesText(motif.cycles), grid: gridOf(motif.grid).many });
}

// --- the phrase and the motif request ---

const PHRASE_NAMES = ['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b'];

/** The phrase's spelling of a MIDI number: lowercase letter, '#' for a sharp, octave number (60 is 'c4'). It is not the display name of noteName. */
function phraseName(midi) {
  return `${PHRASE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;
}

/** A velocity in whole hundredths (1 to 100) as the phrase writes it: two decimals, trailing zeros dropped (80 is '0.8', 100 is '1', 1 is '0.01'). */
function phraseVelocity(hundredths) {
  return String(Number((hundredths / 100).toFixed(2)));
}

const PHRASE_LANE = 'note\\("[a-g0-9#.~_\\[\\],/ <>]*"\\)\\.velocity\\("[a-g0-9#.~_\\[\\],/ <>]*"\\)';

/**
 * The shape of a phrase: one lane, note("...").velocity("..."), or stack(...) of two or more such lanes, with only the characters of the
 * phrase (letters a to g, digits, '#', '.', '~', '_', brackets, commas, '/', spaces and angle brackets) inside the quotes. src/protocol.ts's
 * MOTIF_PHRASE_SHAPE mirrors it by hand (test/ask.test.js checks both are the same pattern).
 */
export const PHRASE_SHAPE = new RegExp(`^(${PHRASE_LANE}|stack\\(${PHRASE_LANE}(, ${PHRASE_LANE})+\\))$`);

/** Returns `code` when it has the shape of a phrase; anything else throws, so a writer bug is loud and nothing but notes ever travels as a phrase. */
export function assertPhraseCode(code) {
  if (typeof code !== 'string') throw new TypeError('Moontide: phrase code must be a string');
  if (!PHRASE_SHAPE.test(code)) throw new Error('Moontide: phrase code does not have the shape note("...").velocity("...") or stack of such lanes');
  return code;
}

/** Groups cells into tokens (a chord is voices with the same step, length and velocity) and the tokens into lanes (the first lane where the token fits). */
function phraseLanes(cells) {
  const groups = new Map();
  for (const cell of cells) {
    const key = `${cell.step}|${cell.steps}|${cell.velocity}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(cell);
  }
  const tokens = [...groups.values()].map((members) => ({
    step: members[0].step,
    steps: members[0].steps,
    velocity: members[0].velocity,
    pitches: members.map((cell) => cell.pitch).sort((a, b) => a - b),
  }));
  tokens.sort((a, b) => a.step - b.step || a.pitches[0] - b.pitches[0]);
  const lanes = [];
  for (const token of tokens) {
    let lane = lanes.find((entry) => entry.end <= token.step);
    if (lane === undefined) {
      lane = { end: 0, tokens: [] };
      lanes.push(lane);
    }
    lane.tokens.push(token);
    lane.end = token.step + token.steps;
  }
  return lanes;
}

/** One lane as the text of its two strings, one token per grid step: the notes, and the velocities mirrored token for token ('~' a rest, '_' a held step). */
function laneStrings(lane, total, cycles) {
  const notes = new Array(total).fill('~');
  const velocities = new Array(total).fill('~');
  for (const token of lane.tokens) {
    const names = token.pitches.map(phraseName);
    notes[token.step] = names.length === 1 ? names[0] : `[${names.join(',')}]`;
    velocities[token.step] = token.velocity;
    for (let held = 1; held < token.steps; held += 1) {
      notes[token.step + held] = '_';
      velocities[token.step + held] = '_';
    }
  }
  // Several cycles are one bracketed sequence slowed by the cycle count, so a note can be held across a cycle line.
  const arrange = (tokens) => (cycles === 1 ? tokens.join(' ') : `[${tokens.join(' ')}]/${cycles}`);
  return { notes: arrange(notes), velocities: arrange(velocities) };
}

/**
 * The phrase of a motif: Strudel code in the form the played-notes measurement proved, note("...").velocity("..."), or stack(...) of such lanes
 * when notes overlap in ways one string cannot say. One token per grid step, '~' a rest, '_' a held step, voices with the same step, length and
 * velocity in a [a,b] chord, the whole motif one sequence slowed by its cycle count. It depends only on the notes (not on ids or the order they
 * were placed), and null for a motif with no notes. The result always passes assertPhraseCode.
 */
export function motifPhrase(motif) {
  if (motif.notes.length === 0) return null;
  const grid = gridOf(motif.grid);
  const cells = motif.notes.map((note) => ({ pitch: note.pitch, step: note.start / grid.unit, steps: note.length / grid.unit, velocity: phraseVelocity(note.velocity) }));
  const total = motif.cycles * grid.steps;
  const lanes = phraseLanes(cells).map((lane) => laneStrings(lane, total, motif.cycles)).map(({ notes, velocities }) => `note("${notes}").velocity("${velocities}")`);
  return assertPhraseCode(lanes.length === 1 ? lanes[0] : `stack(${lanes.join(', ')})`);
}

/**
 * The cycle to tell Claude for a motif, or null for none. A played motif (made by Record that, with no note placed by hand since) keeps the cycle
 * where it was played (null when the music was stopped then, whatever the music does now). Any other motif, a mixed one that began as a recording
 * included, takes the cycle where the roll's first cycle stands at the press: the music's cycle rounded down to a whole number of the motif's cycles,
 * because Tap and the marker place the music on the roll by the cycle modulo the motif's length. `musicCycle` is the music's cycle now, or null while
 * the music is stopped; a value that is neither null nor a finite number of at least 0 throws.
 */
export function motifMoment(motif, musicCycle) {
  if (motif.source === 'played' && motif.recorded !== null) return motif.recorded.cycle;
  if (musicCycle === null) return null;
  if (typeof musicCycle !== 'number' || !Number.isFinite(musicCycle) || musicCycle < 0) {
    throw new Error(`Moontide: the music cycle for a motif must be null or a finite number of at least 0, got ${String(musicCycle)}`);
  }
  return Math.floor(musicCycle / motif.cycles) * motif.cycles;
}

/**
 * The motif field of a page request: `{ source, cycle, cycles, grid, notes, phrase }` with the cycle key only when there is a moment, or null
 * for a motif with no notes. A motif with notes and no source is a bug and throws.
 */
export function motifRequest(motif, musicCycle) {
  if (motif.notes.length === 0) return null;
  if (!MOTIF_SOURCES.includes(motif.source)) throw new Error(`Moontide: a motif with notes needs a source of ${MOTIF_SOURCES.join(', ')}, got ${String(motif.source)}`);
  const cycle = motifMoment(motif, musicCycle);
  return {
    source: motif.source,
    ...(cycle === null ? {} : { cycle }),
    cycles: motif.cycles,
    grid: motif.grid,
    notes: motif.notes.length,
    phrase: motifPhrase(motif),
  };
}

/** The status line after a send: the cycle the request carried, or the words for no moment. */
export function sentText(request) {
  return Object.hasOwn(request, 'cycle') ? fillScratch(SCRATCH_COPY.sent, { cycle: request.cycle }) : SCRATCH_COPY.sentNoMoment;
}

/**
 * The sentence for a refusal: `{ refused: word, ...numbers }` as the view and askUi.sendMotif give it. The words are no-notes, empty-words,
 * words-too-long (with `length` and `max`), disconnected, pending and too-big (with `bytes` and `max`); any other word throws.
 */
export function sendRefusalText(result) {
  switch (result.refused) {
    case 'no-notes':
      return SCRATCH_COPY.sendNoNotes;
    case 'empty-words':
      return SCRATCH_COPY.sendNoWords;
    case 'words-too-long':
      return fillScratch(SCRATCH_COPY.sendWordsTooLong, { length: result.length, max: result.max });
    case 'disconnected':
      return SCRATCH_COPY.sendDisconnected;
    case 'pending':
      return SCRATCH_COPY.sendPending;
    case 'too-big':
      return fillScratch(SCRATCH_COPY.sendTooBig, { bytes: result.bytes, max: result.max });
    default:
      throw new Error(`Moontide: a motif send was refused for a word the Scratchpad does not know: ${String(result.refused)}`);
  }
}

/**
 * The sentence for what became of a sent motif request, from `{ status }` as page/ask-view.js's onMotifResult gives it, or null when it only arrived
 * (the sent line stays). The sentence for a request that waits for Claude goes after the sent line.
 */
export function motifResultText(result) {
  switch (result.status) {
    case 'received':
      return null;
    case 'waiting':
      return SCRATCH_COPY.sendWaiting;
    case 'refused':
      return fillScratch(SCRATCH_COPY.sendRefused, { reason: result.text });
    case 'not-confirmed':
      return SCRATCH_COPY.sendNotConfirmed;
    default:
      throw new Error(`Moontide: a motif request ended in a state the Scratchpad does not know: ${String(result.status)}`);
  }
}
