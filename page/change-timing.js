// Pure change-timing model for Moontide's browser page: which cycle a timed change takes over on.
// No DOM access at import time, so this module can be imported directly by node:test and by
// page/main.js without a build step.

// One bar is one cycle of 4 beats (the MIDI clock sends 96 ticks per cycle, which is 24 per beat).
export const BEATS_PER_CYCLE = 4;

// The three ways a change can take over: at once, on the next bar line or on the next phrase line.
export const CHANGE_TIMINGS = ['now', 'bar', 'phrase'];

// A phrase is 4 cycles unless the change asks for another length. src/protocol.ts mirrors the two bounds by
// hand, and a test checks both sides.
export const DEFAULT_PHRASE_CYCLES = 4;
export const MIN_PHRASE_CYCLES = 2;
export const MAX_PHRASE_CYCLES = 64;

// The line must be at least this far ahead of the scheduler frontier at the current tempo, or the next line
// is used. Same rationale as LAUNCH_MIN_LEAD_SECONDS of page/parts.js (the scheduler has already queued about
// the next slices with the old pattern), but measured against the frontier `lastEnd`, not against now().
export const MIN_TAKEOVER_LEAD_SECONDS = 0.5;

// How long before the line, at the current tempo, the gate's lead hook fires. A starting value that may need
// a small tune on the bench; tests pin the order of the hooks, never this number.
export const TAKEOVER_HOOK_LEAD_SECONDS = 0.3;

/**
 * The timing of one change: `at` is 'now', 'bar' or 'phrase' (undefined means 'now') and `phraseCycles` is
 * the phrase length, allowed only with 'phrase'. Returns a frozen { at, lineLength }: lineLength is 0 for
 * now, 1 for a bar and the phrase length for a phrase. Anything else throws a `Moontide:` Error naming it.
 */
export function parseTiming(at, phraseCycles) {
  const timing = at === undefined ? 'now' : at;
  if (!CHANGE_TIMINGS.includes(timing)) {
    throw new Error(`Moontide: unknown change timing '${String(at)}' (expected one of ${CHANGE_TIMINGS.join(', ')}).`);
  }
  if (phraseCycles !== undefined) {
    if (timing !== 'phrase') {
      throw new Error(`Moontide: phraseCycles ${String(phraseCycles)} is only allowed with the timing 'phrase', not '${timing}'.`);
    }
    if (!Number.isInteger(phraseCycles) || phraseCycles < MIN_PHRASE_CYCLES || phraseCycles > MAX_PHRASE_CYCLES) {
      throw new Error(
        `Moontide: phraseCycles ${String(phraseCycles)} is not a whole number from ${MIN_PHRASE_CYCLES} to ${MAX_PHRASE_CYCLES}.`,
      );
    }
  }
  const lineLength = timing === 'now' ? 0 : timing === 'bar' ? 1 : (phraseCycles ?? DEFAULT_PHRASE_CYCLES);
  return Object.freeze({ at: timing, lineLength });
}

// The bounds the server's schema puts on the tempo and the wait of a reply; src/protocol.ts holds the same two
// numbers (MAX_REPORTED_BPM, MAX_PENDING_SECONDS) and a test checks both sides. A reply outside them would be
// dropped whole by the server, so the page clamps the wait and leaves out the tempo instead.
export const MAX_REPORTED_BPM = 100000;
export const MAX_PENDING_SECONDS = 86400;

/** True when `bpm` (already rounded, see bpmOf) is a tempo the server's schema accepts: above 0 and up to MAX_REPORTED_BPM. */
export function isReportableBpm(bpm) {
  return typeof bpm === 'number' && Number.isFinite(bpm) && bpm > 0 && bpm <= MAX_REPORTED_BPM;
}

/** `seconds` brought into [0, MAX_PENDING_SECONDS]; a value that is not a number (NaN) becomes 0. */
export function clampPendingSeconds(seconds) {
  if (typeof seconds !== 'number' || Number.isNaN(seconds)) return 0;
  return Math.min(MAX_PENDING_SECONDS, Math.max(0, seconds));
}

/**
 * The tempo in beats per minute for `cps` cycles per second (a cycle is `BEATS_PER_CYCLE` beats), rounded to
 * one decimal. The one rounding rule of the page; the server compares the rounded value. A cps that is not a
 * finite number above 0 throws a `Moontide:` Error.
 */
export function bpmOf(cps) {
  if (typeof cps !== 'number' || !Number.isFinite(cps) || cps <= 0) {
    throw new Error(`Moontide: bpmOf needs a finite cps above 0, got ${String(cps)}.`);
  }
  return Math.round(cps * 60 * BEATS_PER_CYCLE * 10) / 10;
}

/**
 * The timing of a change that must take over on one given line: a section launch writes a shift for that very line, so
 * the takeover has to take the same one. `at` is 'section' (the end of the section that plays), 'bar' or 'phrase', and
 * `atCycle` is the line, a finite cycle number. Returns a frozen { at, lineLength, atCycle }: `lineLength` (1 for a
 * section end and a bar, the phrase length for a phrase) is the line the takeover falls back to when the pinned one has
 * come too close. CHANGE_TIMINGS is not extended: it is the closed set of the stored setting and of the server's schema.
 */
export function pinnedTiming(at, atCycle) {
  if (at !== 'section' && at !== 'bar' && at !== 'phrase') {
    throw new Error(`Moontide: a pinned change timing is 'section', 'bar' or 'phrase', got '${String(at)}'.`);
  }
  if (typeof atCycle !== 'number' || !Number.isFinite(atCycle)) {
    throw new Error(`Moontide: a pinned change timing needs a finite line, got ${String(atCycle)}.`);
  }
  return Object.freeze({ at, lineLength: at === 'phrase' ? DEFAULT_PHRASE_CYCLES : 1, atCycle });
}

/**
 * The cycle a timed change takes over on: the first multiple of `lineLength` strictly after the scheduler
 * frontier `frontier` (the cycle the scheduler has already queried up to), moved one line further while
 * the lead at `cps` (cycles per second) is below `minLeadSeconds`. Lines are multiples on the scheduler's
 * own cycle count, which restarts at 0 at every Play, so a phrase is counted from Play without a stored start.
 */
export function boundaryCycle({ frontier, cps, lineLength, minLeadSeconds }) {
  if (typeof frontier !== 'number' || !Number.isFinite(frontier)) {
    throw new Error(`Moontide: boundaryCycle needs a finite frontier, got ${String(frontier)}.`);
  }
  if (typeof cps !== 'number' || !Number.isFinite(cps) || cps <= 0) {
    throw new Error(`Moontide: boundaryCycle needs a finite positive cps, got ${String(cps)}.`);
  }
  if (!Number.isInteger(lineLength) || lineLength <= 0) {
    throw new Error(`Moontide: boundaryCycle needs a positive whole lineLength, got ${String(lineLength)}.`);
  }
  if (typeof minLeadSeconds !== 'number' || !Number.isFinite(minLeadSeconds) || minLeadSeconds < 0) {
    throw new Error(`Moontide: boundaryCycle needs a finite minLeadSeconds from 0 up, got ${String(minLeadSeconds)}.`);
  }
  // The 1e-9 tolerance keeps a frontier that sits exactly on a line (up to rounding) from counting as before it.
  let line = (Math.floor(frontier / lineLength + 1e-9) + 1) * lineLength;
  while ((line - frontier) / cps < minLeadSeconds) line += lineLength;
  return line;
}

// The words of the top bar's countdown and the hand-edit setting of the Settings card.
// Every string the bar shows comes from here, filled with numbers or a closed set of values, and
// is written into the page with textContent and setAttribute, never as markup. The probe imports it too.
export const CHANGE_COPY = Object.freeze({
  countdownLead: 'Change ',
  countdownBars: 'in {n} bars',
  countdownBeats: 'in {n} beats',
  countdownOneBeat: 'in 1 beat',
  countdownTitleBar: 'A code change is waiting. It takes over on the next bar.',
  countdownTitlePhrase: 'A code change is waiting. It takes over on the next phrase.',
  countdownTitleSection: 'A code change is waiting. It takes over at the end of the section.',
  // The Edits timing group of the Settings card: three buttons. The visible word of each, and its accessible name.
  timingNow: 'now',
  timingBar: 'next bar',
  timingPhrase: 'next phrase',
  timingNameNow: 'Your edits take over now',
  timingNameBar: 'Your edits take over at the next bar',
  timingNamePhrase: 'Your edits take over at the next phrase',
  timingTitle: "When your edits (Ctrl+Enter) take over: now, on the next bar or on the next phrase. Claude's changes choose their own timing.",
  queuedBar: 'Change waiting: it takes over on the next bar.',
  queuedPhrase: 'Change waiting: it takes over on the next phrase.',
  queuedSection: 'Change waiting: it takes over at the end of the section.',
  canceled: 'Change canceled.',
  settingNow: 'Your edits now take over: now.',
  settingBar: 'Your edits now take over: on the next bar.',
  settingPhrase: 'Your edits now take over: on the next phrase.',
  // The four sentences a tempo ramp speaks in the live region: at its start, at its end and when the code cancels it.
  // {from}, {to} and {bpm} go through bpmText and {n} is a whole number of bars. Nothing is spoken per step.
  rampStarted: 'Tempo ramp started: {from} to {to} BPM over {n} bars.',
  rampStartedOneBar: 'Tempo ramp started: {from} to {to} BPM over 1 bar.',
  rampFinished: 'Tempo ramp finished at {to} BPM.',
  rampCanceledOtherTempo: 'Tempo ramp canceled. The code sets {bpm} BPM.',
  rampCanceledNoTempo: 'Tempo ramp canceled. Tempo stays at {bpm} BPM.',
});

// The fit steps of the top bar, in the order text is given up: 0 nothing, 1 the decoration
// (the wordmark and the cycle and beat), 2 the names of the unselected view buttons, 3 long texts to their short form,
// 4 tighter spacing. The loop in page/top-bar-view.js raises the step while the bar overflows.
export const FIT_STEPS = Object.freeze([0, 1, 2, 3, 4]);

/** Fills the `{name}` placeholders of a CHANGE_COPY string. A placeholder without a value throws (loud, never a blank). */
export function fillChange(template, values = {}) {
  return template.replace(/\{(\w+)\}/g, (_, key) => {
    if (!(key in values)) throw new Error(`Moontide: the change copy needs a value for {${key}}.`);
    return String(values[key]);
  });
}

/** The tempo number for the readout: one decimal, a trailing .0 dropped. A value that is not a finite number above 0 throws. */
export function bpmText(bpm) {
  if (typeof bpm !== 'number' || !Number.isFinite(bpm) || bpm <= 0) {
    throw new Error(`Moontide: bpmText needs a finite bpm above 0, got ${String(bpm)}.`);
  }
  return String(Math.round(bpm * 10) / 10);
}

/**
 * The countdown text for `beatsLeft` beats until the line, as { lead, rest }. Whole beats count up to the next
 * whole beat (never below 1). Above 4 beats the unit is bars (whole bars, rounded up, so never '1 bar'); from
 * 4 beats down it is beats, and 'in 1 beat' for the last one. So within each unit the number only counts down.
 * A value that is not finite throws a `Moontide:` Error.
 */
export function countdownParts(beatsLeft) {
  if (typeof beatsLeft !== 'number' || !Number.isFinite(beatsLeft)) {
    throw new Error(`Moontide: countdownParts needs a finite number of beats, got ${String(beatsLeft)}.`);
  }
  const whole = Math.max(1, Math.ceil(beatsLeft - 1e-9));
  const lead = CHANGE_COPY.countdownLead;
  if (whole > BEATS_PER_CYCLE) {
    return { lead, rest: fillChange(CHANGE_COPY.countdownBars, { n: Math.ceil(whole / BEATS_PER_CYCLE) }) };
  }
  if (whole >= 2) return { lead, rest: fillChange(CHANGE_COPY.countdownBeats, { n: whole }) };
  return { lead, rest: CHANGE_COPY.countdownOneBeat };
}

/** The hover title of the countdown for a change waiting on 'bar', 'phrase' or (a section launch) 'section'. */
export function countdownTitle(at) {
  if (at === 'bar') return CHANGE_COPY.countdownTitleBar;
  if (at === 'phrase') return CHANGE_COPY.countdownTitlePhrase;
  if (at === 'section') return CHANGE_COPY.countdownTitleSection;
  throw new Error(`Moontide: a waiting change has the timing 'bar', 'phrase' or 'section', got '${String(at)}'.`);
}

/**
 * The three buttons of the Edits timing group, in the order of CHANGE_TIMINGS: [{ value, label, name }]. `label` is the
 * visible word ('now', 'next bar', 'next phrase') and `name` what the button is called ('Your edits take over at the next bar').
 * Every value of CHANGE_TIMINGS has exactly one option, so the view builds its buttons from this list and nothing else.
 */
export function timingOptions() {
  const copy = {
    now: [CHANGE_COPY.timingNow, CHANGE_COPY.timingNameNow],
    bar: [CHANGE_COPY.timingBar, CHANGE_COPY.timingNameBar],
    phrase: [CHANGE_COPY.timingPhrase, CHANGE_COPY.timingNamePhrase],
  };
  return CHANGE_TIMINGS.map((value) => Object.freeze({ value, label: copy[value][0], name: copy[value][1] }));
}

/** The spoken line for a change that just started to wait, for 'bar', 'phrase' or 'section'. */
export function queuedLine(at) {
  if (at === 'bar') return CHANGE_COPY.queuedBar;
  if (at === 'phrase') return CHANGE_COPY.queuedPhrase;
  if (at === 'section') return CHANGE_COPY.queuedSection;
  throw new Error(`Moontide: a waiting change has the timing 'bar', 'phrase' or 'section', got '${String(at)}'.`);
}

/** The spoken line after a press of the setting button, for the value it now has. */
export function settingLine(value) {
  if (value === 'now') return CHANGE_COPY.settingNow;
  if (value === 'bar') return CHANGE_COPY.settingBar;
  if (value === 'phrase') return CHANGE_COPY.settingPhrase;
  throw new Error(`Moontide: unknown change timing '${String(value)}' (expected one of ${CHANGE_TIMINGS.join(', ')}).`);
}

/**
 * The spoken line of a tempo ramp, for the three events that are told: `{ kind: 'started', fromBpm, toBpm, bars }`,
 * `{ kind: 'finished', toBpm }` and `{ kind: 'canceled', reason, bpm }` with the reason 'other-tempo' (the code states
 * another tempo, which plays now) or 'no-tempo' (the code states none, the tempo stays). The tempos go through bpmText and
 * `bars` is a whole number from 1; anything else throws a `Moontide:` Error. Stop, a reload and a replaced ramp are not told.
 */
export function rampLine(event) {
  if (event === null || typeof event !== 'object') {
    throw new Error(`Moontide: a ramp line needs an event, got ${String(event)}.`);
  }
  if (event.kind === 'started') {
    if (!Number.isInteger(event.bars) || event.bars < 1) {
      throw new Error(`Moontide: a ramp line needs a whole number of bars from 1, got ${String(event.bars)}.`);
    }
    const template = event.bars === 1 ? CHANGE_COPY.rampStartedOneBar : CHANGE_COPY.rampStarted;
    return fillChange(template, { from: bpmText(event.fromBpm), to: bpmText(event.toBpm), n: event.bars });
  }
  if (event.kind === 'finished') {
    return fillChange(CHANGE_COPY.rampFinished, { to: bpmText(event.toBpm) });
  }
  if (event.kind === 'canceled') {
    if (event.reason === 'other-tempo') return fillChange(CHANGE_COPY.rampCanceledOtherTempo, { bpm: bpmText(event.bpm) });
    if (event.reason === 'no-tempo') return fillChange(CHANGE_COPY.rampCanceledNoTempo, { bpm: bpmText(event.bpm) });
    throw new Error(`Moontide: a canceled ramp is told for 'other-tempo' or 'no-tempo', not '${String(event.reason)}'.`);
  }
  throw new Error(`Moontide: a ramp line is told for 'started', 'finished' or 'canceled', not '${String(event.kind)}'.`);
}
