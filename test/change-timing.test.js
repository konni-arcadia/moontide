import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLOCK_TICKS_PER_CYCLE } from '../page/midi-clock.js';
import {
  BEATS_PER_CYCLE,
  CHANGE_COPY,
  CHANGE_TIMINGS,
  DEFAULT_PHRASE_CYCLES,
  FIT_STEPS,
  MAX_PENDING_SECONDS,
  MAX_PHRASE_CYCLES,
  MAX_REPORTED_BPM,
  MIN_PHRASE_CYCLES,
  MIN_TAKEOVER_LEAD_SECONDS,
  TAKEOVER_HOOK_LEAD_SECONDS,
  bpmOf,
  bpmText,
  boundaryCycle,
  clampPendingSeconds,
  countdownParts,
  countdownTitle,
  fillChange,
  parseTiming,
  pinnedTiming,
  queuedLine,
  settingLine,
  timingOptions,
} from '../page/change-timing.js';

const lead = MIN_TAKEOVER_LEAD_SECONDS;

test('boundaryCycle: the first bar line after the frontier that leaves enough lead', () => {
  assert.equal(boundaryCycle({ frontier: 2.3, cps: 0.5, lineLength: 1, minLeadSeconds: lead }), 3);
});

test('boundaryCycle: a line that is too close at the current tempo moves to the next one', () => {
  // Cycle 3 is 0.1 cycles = 0.2 s ahead at 0.5 cps, under the 0.5 s lead.
  assert.equal(boundaryCycle({ frontier: 2.9, cps: 0.5, lineLength: 1, minLeadSeconds: lead }), 4);
});

test('boundaryCycle: a frontier exactly on a line does not count that line (strictly after)', () => {
  assert.equal(boundaryCycle({ frontier: 3, cps: 0.5, lineLength: 1, minLeadSeconds: lead }), 4);
});

test('boundaryCycle: the lead is measured in seconds, so a faster tempo needs more cycles of lead', () => {
  // At 4 cps, 0.5 s is 2 cycles: from 2.3 the line 3 is only 0.175 s ahead, 4 is 0.425 s, 5 is 0.675 s.
  assert.equal(boundaryCycle({ frontier: 2.3, cps: 4, lineLength: 1, minLeadSeconds: lead }), 5);
});

test('boundaryCycle: phrase lines are multiples of the phrase length', () => {
  assert.equal(boundaryCycle({ frontier: 5.1, cps: 0.5, lineLength: 4, minLeadSeconds: lead }), 8);
  assert.equal(boundaryCycle({ frontier: 5.1, cps: 0.5, lineLength: 8, minLeadSeconds: lead }), 8);
});

test('boundaryCycle: a phrase line that is too close moves one phrase further', () => {
  // Line 8 is 0.1 cycles = 0.2 s ahead at 0.5 cps.
  assert.equal(boundaryCycle({ frontier: 7.9, cps: 0.5, lineLength: 4, minLeadSeconds: lead }), 12);
});

test('boundaryCycle: a frontier at 0 (a fresh Play) gives the first line that leaves the lead', () => {
  assert.equal(boundaryCycle({ frontier: 0, cps: 0.5, lineLength: 1, minLeadSeconds: lead }), 1);
});

test('boundaryCycle: invalid input throws a Moontide: Error', () => {
  const base = { frontier: 2.3, cps: 0.5, lineLength: 1, minLeadSeconds: lead };
  for (const bad of [
    { ...base, frontier: Number.NaN },
    { ...base, frontier: Number.POSITIVE_INFINITY },
    { ...base, cps: 0 },
    { ...base, cps: -1 },
    { ...base, cps: Number.NaN },
    { ...base, lineLength: 0 },
    { ...base, lineLength: 1.5 },
    { ...base, minLeadSeconds: Number.NaN },
  ]) {
    assert.throws(() => boundaryCycle(bad), /^Error: Moontide:/);
  }
});

test('parseTiming: no value means now, with no line length', () => {
  const timing = parseTiming(undefined);
  assert.deepEqual({ ...timing }, { at: 'now', lineLength: 0 });
  assert.equal(Object.isFrozen(timing), true);
  assert.deepEqual({ ...parseTiming('now') }, { at: 'now', lineLength: 0 });
});

test('parseTiming: a bar is one cycle and a phrase is four by default', () => {
  assert.deepEqual({ ...parseTiming('bar') }, { at: 'bar', lineLength: 1 });
  assert.deepEqual({ ...parseTiming('phrase') }, { at: 'phrase', lineLength: DEFAULT_PHRASE_CYCLES });
  assert.equal(DEFAULT_PHRASE_CYCLES, 4);
});

test('parseTiming: a phrase length from the allowed range is used', () => {
  assert.deepEqual({ ...parseTiming('phrase', 8) }, { at: 'phrase', lineLength: 8 });
  assert.equal(parseTiming('phrase', MIN_PHRASE_CYCLES).lineLength, MIN_PHRASE_CYCLES);
  assert.equal(parseTiming('phrase', MAX_PHRASE_CYCLES).lineLength, MAX_PHRASE_CYCLES);
});

test('parseTiming: an unknown timing, a phrase length with another timing or a bad length throws, naming the value', () => {
  assert.throws(() => parseTiming('later'), /^Error: Moontide: .*'later'/);
  assert.throws(() => parseTiming('bar', 8), /^Error: Moontide: .*8.*'bar'/);
  assert.throws(() => parseTiming('now', 8), /^Error: Moontide: .*8.*'now'/);
  assert.throws(() => parseTiming('phrase', 1), /^Error: Moontide: .*phraseCycles 1 /);
  assert.throws(() => parseTiming('phrase', 65), /^Error: Moontide: .*phraseCycles 65 /);
  assert.throws(() => parseTiming('phrase', 4.5), /^Error: Moontide: .*phraseCycles 4.5 /);
  assert.throws(() => parseTiming(null), /^Error: Moontide: .*'null'/);
});

test('bpmOf: cycles per second times 60 times four beats, rounded to one decimal', () => {
  assert.equal(bpmOf(0.5), 120);
  assert.equal(bpmOf(0.5625), 135);
  assert.equal(bpmOf(0.4), 96);
  assert.equal(bpmOf(0.4025), 96.6);
});

test('bpmOf: a cps that is not a finite number above 0 throws a Moontide: Error', () => {
  for (const bad of [Number.NaN, 0, -0.5, Number.POSITIVE_INFINITY, '0.5', undefined]) {
    assert.throws(() => bpmOf(bad), /^Error: Moontide:/);
  }
});

test('the constants state a bar of four beats, the three timings and a positive lead', () => {
  assert.equal(BEATS_PER_CYCLE, 4);
  assert.deepEqual(CHANGE_TIMINGS, ['now', 'bar', 'phrase']);
  assert.ok(MIN_TAKEOVER_LEAD_SECONDS > 0);
  assert.ok(TAKEOVER_HOOK_LEAD_SECONDS > 0);
});

test('bpmText: one decimal, a trailing .0 dropped', () => {
  assert.equal(bpmText(120), '120');
  assert.equal(bpmText(96.6), '96.6');
  assert.equal(bpmText(135), '135');
  assert.equal(bpmText(1000.5), '1000.5');
  assert.equal(bpmText(bpmOf(0.4025)), '96.6');
  assert.equal(bpmText(bpmOf(0.5)), '120');
});

test('bpmText: a value that is not a finite number above 0 throws a Moontide: Error', () => {
  for (const bad of [Number.NaN, 0, -1, Number.POSITIVE_INFINITY, '120', undefined]) {
    assert.throws(() => bpmText(bad), /^Error: Moontide:/);
  }
});

test('countdownParts: bars above four beats, beats from four down, one beat for the last', () => {
  const rest = (beats) => countdownParts(beats).rest;
  assert.equal(countdownParts(16).lead, 'Change ');
  assert.equal(rest(16), 'in 4 bars');
  assert.equal(rest(5), 'in 2 bars');
  assert.equal(rest(4.2), 'in 2 bars');
  assert.equal(rest(4), 'in 4 beats');
  assert.equal(rest(3.2), 'in 4 beats');
  assert.equal(rest(2.9), 'in 3 beats');
  assert.equal(rest(1.5), 'in 2 beats');
  assert.equal(rest(0.5), 'in 1 beat');
  assert.equal(rest(0), 'in 1 beat');
  assert.equal(rest(-0.2), 'in 1 beat');
});

test('countdownParts: never says 1 bar, and within a unit the number only counts down', () => {
  let lastBars = Infinity;
  let lastBeats = Infinity;
  let sawBeats = false;
  for (let beats = 16; beats >= -0.5; beats -= 0.05) {
    const { lead, rest } = countdownParts(beats);
    assert.ok(`${lead}${rest}`.startsWith('Change in '));
    assert.doesNotMatch(rest, /1 bar/);
    const bars = /^in (\d+) bars$/.exec(rest);
    const many = /^in (\d+) beats$/.exec(rest);
    if (bars) {
      assert.equal(sawBeats, false, 'bars never come back after beats');
      assert.ok(Number(bars[1]) <= lastBars);
      lastBars = Number(bars[1]);
    } else {
      sawBeats = true;
      const n = many ? Number(many[1]) : 1;
      assert.ok(n <= lastBeats);
      lastBeats = n;
    }
  }
  assert.equal(sawBeats, true);
});

test('countdownParts: a value that is not finite throws a Moontide: Error', () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, '3', undefined]) {
    assert.throws(() => countdownParts(bad), /^Error: Moontide:/);
  }
});

test('timingOptions: the three buttons, in the order of CHANGE_TIMINGS, with their words and their full accessible names', () => {
  const options = timingOptions();
  assert.deepEqual(
    options.map((option) => option.value),
    [...CHANGE_TIMINGS],
    'one option per timing, in order, and no option for any other value',
  );
  assert.deepEqual(options, [
    { value: 'now', label: 'now', name: 'Your edits take over now' },
    { value: 'bar', label: 'next bar', name: 'Your edits take over at the next bar' },
    { value: 'phrase', label: 'next phrase', name: 'Your edits take over at the next phrase' },
  ]);
  for (const option of options) assert.ok(Object.isFrozen(option), `${option.value} is frozen`);
  assert.equal(new Set(options.map((option) => option.name)).size, 3, 'the three names differ');
});

test('timingOptions: every label sits inside its name, so the visible word is part of what is read', () => {
  for (const option of timingOptions()) {
    assert.ok(option.name.endsWith(option.label), `${option.name} ends with ${option.label}`);
  }
});

test('the spoken lines and the titles', () => {
  assert.equal(queuedLine('bar'), 'Change waiting: it takes over on the next bar.');
  assert.equal(queuedLine('phrase'), 'Change waiting: it takes over on the next phrase.');
  assert.throws(() => queuedLine('now'), /^Error: Moontide:/);
  assert.equal(CHANGE_COPY.canceled, 'Change canceled.');
  assert.equal(settingLine('now'), 'Your edits now take over: now.');
  assert.equal(settingLine('bar'), 'Your edits now take over: on the next bar.');
  assert.equal(settingLine('phrase'), 'Your edits now take over: on the next phrase.');
  assert.throws(() => settingLine('later'), /^Error: Moontide:/);
  assert.equal(countdownTitle('bar'), 'A code change is waiting. It takes over on the next bar.');
  assert.equal(countdownTitle('phrase'), 'A code change is waiting. It takes over on the next phrase.');
  assert.throws(() => countdownTitle('now'), /^Error: Moontide:/);
  assert.equal(queuedLine('section'), 'Change waiting: it takes over at the end of the section.');
  assert.equal(countdownTitle('section'), 'A code change is waiting. It takes over at the end of the section.');
  assert.throws(() => queuedLine('later'), /^Error: Moontide:/);
  assert.throws(() => countdownTitle(undefined), /^Error: Moontide:/);
});

test('pinnedTiming: a change written for one given line, frozen, with the line length it falls back to', () => {
  const section = pinnedTiming('section', 18);
  assert.deepEqual({ ...section }, { at: 'section', lineLength: 1, atCycle: 18 });
  assert.equal(Object.isFrozen(section), true);
  assert.deepEqual({ ...pinnedTiming('bar', 4) }, { at: 'bar', lineLength: 1, atCycle: 4 });
  assert.deepEqual({ ...pinnedTiming('phrase', 8) }, { at: 'phrase', lineLength: DEFAULT_PHRASE_CYCLES, atCycle: 8 });
  assert.deepEqual({ ...pinnedTiming('section', -2.5) }, { at: 'section', lineLength: 1, atCycle: -2.5 });
  assert.throws(() => pinnedTiming('now', 1), /^Error: Moontide: /);
  assert.throws(() => pinnedTiming(undefined, 1), /^Error: Moontide: /);
  assert.throws(() => pinnedTiming('bar', Number.NaN), /^Error: Moontide: /);
  assert.throws(() => pinnedTiming('bar', '4'), /^Error: Moontide: /);
  assert.throws(() => pinnedTiming('bar', Number.POSITIVE_INFINITY), /^Error: Moontide: /);
});

test('CHANGE_TIMINGS stays the closed set of the stored setting: a pinned section end is not one of them', () => {
  assert.deepEqual(CHANGE_TIMINGS, ['now', 'bar', 'phrase']);
  assert.throws(() => parseTiming('section'), /^Error: Moontide: unknown change timing/);
});

test('fillChange: a placeholder without a value throws, and every template fills with its documented values', () => {
  assert.throws(() => fillChange(CHANGE_COPY.countdownBars, {}), /^Error: Moontide: .*\{n\}/);
  const values = { bpm: 120, n: 3 };
  for (const [key, template] of Object.entries(CHANGE_COPY)) {
    assert.doesNotMatch(fillChange(template, values), /[{}]/, key);
  }
  assert.equal(Object.isFrozen(CHANGE_COPY), true);
});

test('FIT_STEPS is ordered and complete, and the clock ticks agree with the beats per bar', () => {
  assert.deepEqual([...FIT_STEPS], [0, 1, 2, 3, 4]);
  assert.equal(Object.isFrozen(FIT_STEPS), true);
  assert.equal(CLOCK_TICKS_PER_CYCLE, 24 * BEATS_PER_CYCLE);
});

test('clampPendingSeconds keeps a wait inside what the server accepts and turns NaN into 0', () => {
  assert.equal(clampPendingSeconds(6.2), 6.2);
  assert.equal(clampPendingSeconds(-3), 0);
  assert.equal(clampPendingSeconds(Number.NaN), 0);
  assert.equal(clampPendingSeconds(Number.POSITIVE_INFINITY), MAX_PENDING_SECONDS);
  assert.equal(clampPendingSeconds(MAX_PENDING_SECONDS + 1), MAX_PENDING_SECONDS);
  assert.equal(MAX_REPORTED_BPM, 100000);
});
