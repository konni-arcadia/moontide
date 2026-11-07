// The notes played on a MIDI keyboard, kept in memory as notes with a start and an end in music cycles. Pure: no DOM, no window, no
// timer and no clock at import or at any call, so node:test and page/main.js import it the same way. Every call is given the cycle
// it happened at; this module never reads a clock and never sends anything. Which bytes are a note is decided here too, so the
// listener can drop everything else before it reads any clock.
//
// The buffer keeps a window: the 8 whole cycles that end with the current one, so everything it holds fits on the roll (whose longest motif
// is 8 cycles) and its edges sit on the music's cycle lines. `snapshot(now)` is what "record that" and, later, a request to Claude read:
// `{ start, cycles, notes }` where `start` is the window's first cycle, `cycles` its length (8) and each note
// `{ pitch, velocity, start, end, run, held }` in cycles from the window's start, in the order played, a note that began before the window cut at
// 0 and a note still held closed at `now` (`held` is true for it, so the live view can keep growing it). `run` says which run of the music the note was placed in: the cycle axis's whole-number offset
// (the axis cycle minus the music's own cycle count) or null for a note placed by the tempo; equal runs mean one run of the music.

import { MAX_CYCLES } from './scratch-model.js';

/** How many whole cycles the buffer keeps: the roll's longest motif. */
export const BUFFER_CYCLES = MAX_CYCLES;
/** The most notes the buffer keeps, so a stuck key or a flood never grows memory without bound. */
export const MAX_BUFFER_NOTES = 2000;

const NOTE_OFF_STATUS = 0x80;
const NOTE_ON_STATUS = 0x90;

function isDataByte(value) {
  return Number.isInteger(value) && value >= 0 && value <= 127;
}

/**
 * Reads the bytes of one MIDI message. Gives `{ kind, pitch, velocity, channel }` for a three-byte note-on (status 0x90 to 0x9F) or
 * note-off (0x80 to 0x8F) whose two data bytes are whole numbers from 0 to 127: `kind` is 'on' or 'off', `channel` 1 to 16, and a note-on
 * with velocity 0 is an off, as the MIDI standard says. Everything else gives null: clock (0xF8), active sensing (0xFE), controllers
 * (the sustain pedal), pitch bend, aftertouch, system exclusive, and data that is short, long or not bytes. Those are ignored on purpose:
 * the phrase form of a motif cannot say them.
 */
export function parseNoteMessage(data) {
  if (data === null || typeof data !== 'object' || data.length !== 3) return null;
  const [status, pitch, velocity] = [data[0], data[1], data[2]];
  if (!Number.isInteger(status) || status < NOTE_OFF_STATUS || status > 0x9f) return null;
  if (!isDataByte(pitch) || !isDataByte(velocity)) return null;
  const channel = (status & 0x0f) + 1;
  const isOn = status >= NOTE_ON_STATUS && velocity > 0;
  return { kind: isOn ? 'on' : 'off', pitch, velocity, channel };
}

function checkCycle(cycle) {
  if (typeof cycle !== 'number' || !Number.isFinite(cycle)) throw new Error(`Moontide: a played note needs a finite cycle, got ${String(cycle)}`);
}

function checkPitch(pitch) {
  if (!isDataByte(pitch)) throw new Error(`Moontide: a played note needs a whole pitch from 0 to 127, got ${String(pitch)}`);
}

/**
 * The played notes, in play order. A note is `{ pitch, velocity, start, end, run }` with the cycles of its start and end and the velocity as the
 * keyboard sent it (1 to 127); `end` is null while the key is held; `run` is the axis offset the note was placed at (a whole number)
 * or null when it was placed by the tempo. `noteOn(cycle, pitch, velocity, run)` (run left out is null) starts a note (a second on of a held
 * pitch ends the first at that cycle) and gives `{ kept: true }`, or `{ kept: false, full: true }` when 2000 notes are kept already;
 * `noteOff(cycle, pitch)` ends the held note of that pitch (an off for a pitch that is not held does nothing); `closeAll(cycle)` ends every
 * held note there. `count(now)` is how many notes the window holds (`now` is the current cycle; left out, the latest cycle any call gave),
 * `notes()` a copy of them, `snapshot(now)` the window as described above (the buffer is left as it was) and `clear()` empties it.
 * Every call that takes a cycle drops the notes that ended before the window's start, judged against the latest cycle any call has given,
 * so a note stamped a little late never moves the window back. A held note is never dropped.
 */
export function createPlayedBuffer() {
  let kept = [];
  let latest = -Infinity;
  const heldOf = (pitch) => kept.find((note) => note.pitch === pitch && note.end === null);
  const windowEnd = (at) => Math.floor(at) + 1;
  const outside = (note, windowStart) => note.end !== null && note.end <= windowStart && note.start < windowStart;

  // Learns the cycle of a call and drops what has left the window.
  function advance(cycle) {
    if (cycle > latest) latest = cycle;
    if (!Number.isFinite(latest)) return;
    const windowStart = windowEnd(latest) - BUFFER_CYCLES;
    if (kept.some((note) => outside(note, windowStart))) kept = kept.filter((note) => !outside(note, windowStart));
  }

  function noteOn(cycle, pitch, velocity, run = null) {
    checkCycle(cycle);
    checkPitch(pitch);
    if (run !== null && !Number.isInteger(run)) throw new Error(`Moontide: a played note needs a run that is null or a whole number, got ${String(run)}`);
    if (!Number.isInteger(velocity) || velocity < 1 || velocity > 127) throw new Error(`Moontide: a played note needs a velocity from 1 to 127, got ${String(velocity)}`);
    advance(cycle);
    if (kept.length >= MAX_BUFFER_NOTES) return { kept: false, full: true };
    const held = heldOf(pitch);
    if (held !== undefined) held.end = Math.max(cycle, held.start);
    kept.push({ pitch, velocity, start: cycle, end: null, run });
    return { kept: true };
  }

  function noteOff(cycle, pitch) {
    checkCycle(cycle);
    checkPitch(pitch);
    advance(cycle);
    const held = heldOf(pitch);
    if (held !== undefined) held.end = Math.max(cycle, held.start);
  }

  function closeAll(cycle) {
    checkCycle(cycle);
    advance(cycle);
    for (const note of kept) if (note.end === null) note.end = Math.max(cycle, note.start);
  }

  function count(now = latest) {
    if (now !== latest) checkCycle(now);
    advance(now);
    return kept.length;
  }

  function snapshot(now) {
    checkCycle(now);
    const at = Math.max(latest, now);
    const windowStart = windowEnd(at) - BUFFER_CYCLES;
    const notes = kept
      .filter((note) => !outside(note, windowStart))
      .map((note) => {
        const start = Math.max(0, note.start - windowStart);
        const end = Math.max(start, (note.end === null ? Math.max(now, note.start) : note.end) - windowStart);
        return { pitch: note.pitch, velocity: note.velocity, start, end, run: note.run, held: note.end === null };
      });
    return { start: windowStart, cycles: BUFFER_CYCLES, notes };
  }

  return {
    noteOn,
    noteOff,
    closeAll,
    count,
    snapshot,
    clear: () => {
      kept = [];
      latest = -Infinity;
    },
    notes: () => kept.map((note) => ({ ...note })),
  };
}

function isLine(lines) {
  if (lines === null || typeof lines !== 'object') return false;
  const { a, b } = lines;
  for (const anchor of [a, b]) {
    if (anchor === null || typeof anchor !== 'object' || !Number.isFinite(anchor.c) || !Number.isFinite(anchor.t)) return false;
  }
  return a.t !== b.t;
}

const cycleOnLine = (line, h) => line.a.c + ((h - line.a.t) * (line.b.c - line.a.c)) / (line.b.t - line.a.t);

/**
 * One cycle axis for the buffer. The page clock gives cycle lines only for a music that plays, yet the buffer must keep the last cycles
 * by the tempo while the music is stopped. The axis uses the page clock's own lines while the music plays and runs on by the
 * scheduler's tempo otherwise, and in both cases hands the same kind of two anchors to the placement code (checkStamp, then
 * cycleAtStamp). It never goes back: notes already kept keep their order. While the music plays its whole cycles stay whole cycles of
 * the axis, because a Play moves the axis forward to the next whole cycle: the axis cycle equals the music's own cycle count plus the
 * offset (the count the code's patterns are queried at), and the offset changes only when the music restarts. Notes played before a Play are older cycles of the same axis;
 * their place against the new music has no meaning, because they were played against no music.
 *
 * Pure: it reads no clock and keeps no timer; every read is handed its moment. `at(h, { music, cps, playing })` takes `h`, the handler's
 * clock in milliseconds (performance.now() time), `music`, the page clock's two cycle lines `{ a: { c, t }, b: { c, t } }` or null,
 * `cps`, the scheduler's cycles per second, and `playing`, whether the music plays. It gives `{ anchors: { a, b }, source, now }`:
 * `source` is 'music' or 'free' (the tempo), `now` the axis cycle at `h` on those anchors, and `offset`, the whole number added to the music's line
 * (null when `source` is 'free'); the whole answer is null when there are no lines and no tempo above 0 (nothing changes then).
 *
 * With usable lines the axis is the music's line plus a whole-number offset. The offset stays, except when the line reads more than half a
 * cycle below the last cycle (the scheduler restarted unseen, as when the tab was hidden): it then grows by whole cycles; a smaller step
 * back is clock jitter and changes nothing. While the music plays and the lines are briefly missing, the last line is kept, so a gap
 * never costs a cycle. A line from before a Stop is never reused: a Play whose clock is still warming up stays on the tempo.
 */
export function createCycleAxis() {
  let mode = null; // null before the first read, then 'music' or 'free'
  let offset = 0;
  let line = null; // the line in use, in axis cycles: the music's plus the offset, or the tempo's from its origin
  let freeCps = 0;
  let last = null; // the axis cycle of the latest read

  function answer(h, source) {
    last = cycleOnLine(line, h);
    return { anchors: { a: { ...line.a }, b: { ...line.b } }, source, now: last, offset: source === 'music' ? offset : null };
  }

  function at(h, { music, cps, playing }) {
    if (!Number.isFinite(h)) throw new Error(`Moontide: the cycle axis needs a finite moment, got ${String(h)}`);
    if (isLine(music)) {
      const raw = cycleOnLine(music, h);
      if (mode !== 'music') offset = line === null ? 0 : Math.ceil(cycleOnLine(line, h) - raw);
      else if (raw + offset < last - 0.5) offset = Math.ceil(last - raw);
      mode = 'music';
      line = { a: { c: music.a.c + offset, t: music.a.t }, b: { c: music.b.c + offset, t: music.b.t } };
      return answer(h, 'music');
    }
    if (playing === true && mode === 'music') return answer(h, 'music');
    if (Number.isFinite(cps) && cps > 0) {
      if (mode === 'free' && cps === freeCps) return answer(h, 'free');
      const period = 1000 / cps;
      const c = line === null ? 0 : cycleOnLine(line, h);
      if (Number.isFinite(period) && period > 0 && Number.isFinite(c) && h + period !== h) {
        mode = 'free';
        freeCps = cps;
        line = { a: { c, t: h }, b: { c: c + 1, t: h + period } };
        return answer(h, 'free');
      }
    }
    return null;
  }

  return { at };
}
