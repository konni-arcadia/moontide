import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rampGestureReading } from '../scripts/probe-midi.mjs';
import { glideCpsOf, planGlide } from '../page/tempo-glide.js';

// A made-up run on the page's own plan: 100 to 120 BPM over 8 bars starting at cycle 0 (160 steps of 0.125 BPM, one every
// 0.05 cycles), the code holds 120 BPM. At cycle 4 the plan is on step 80, which is 110 BPM.
const plan = planGlide({ fromCps: 100 / 240, toCps: 0.5, bars: 8, startCycle: 0 });
const stepCps = (k) => glideCpsOf(plan, k);
const tickEntries = (times) => times.map((ts) => ({ t: ts - 100, port: 'A', bytes: [0xf8], ts }));
// Ticks at the tempo of step 80 (110 BPM), except that `fastCount` ticks from 1200 on are at 120 BPM, the target.
function ticks({ fastCount }) {
  const times = [];
  let at = 700;
  while (at < 1200) {
    times.push(at);
    at += 2500 / 110;
  }
  for (let i = 0; i < fastCount; i++) {
    times.push(at);
    at += 2500 / 120;
  }
  while (at < 1900) {
    times.push(at);
    at += 2500 / 110;
  }
  return tickEntries(times);
}
// The ramp's own steps, set outside any evaluation: step 79 was heard from 600 on, step 80 from 650 on (the ticks below are at the
// tempo of step 80, so the course matches them all through the window).
const rampSteps = [
  { kind: 'cps', perf: 500, cps: stepCps(79), old: stepCps(78), lastEnd: 3.95, landPerf: 600 },
  { kind: 'cps', perf: 550, cps: stepCps(80), old: stepCps(79), lastEnd: 4.0, landPerf: 650 },
];
const base = { markPerf: 1000, plan, clockPort: 'A' };
const evaluation = (at, { endStep, lastEnd = 4.0, snap = false }) => [
  { kind: 'eval-start', perf: at, cps: stepCps(80), lastEnd: 3.99 },
  ...(snap ? [{ kind: 'cps', perf: at + 3, cps: 0.5, old: stepCps(80), lastEnd: 3.99, landPerf: 1250 }] : []),
  ...(snap && endStep !== 'target' ? [{ kind: 'cps', perf: at + 8, cps: stepCps(80), old: 0.5, lastEnd: 3.99, landPerf: 1250 }] : []),
  { kind: 'eval-end', perf: at + 10, cps: endStep === 'target' ? 0.5 : stepCps(endStep), lastEnd },
];

test('rampGestureReading: an evaluation that ends on the target in the middle of the ramp reads as off course, with its off-course ticks', () => {
  const events = [{ kind: 'mark', name: 'x', perf: 1000 }, ...rampSteps, ...evaluation(1210, { endStep: 'target', snap: true })];
  const reading = rampGestureReading({ ...base, events, entries: ticks({ fastCount: 5 }) });
  assert.equal(reading.evaluations.length, 1);
  assert.equal(reading.evaluations[0].bpmAtEnd, 120);
  assert.equal(reading.evaluations[0].courseBpm, 110);
  assert.equal(reading.evaluations[0].stepsOff, 80);
  assert.equal(reading.evaluations[0].snapped, true);
  assert.equal(reading.evaluationsOnCourse, false);
  assert.equal(reading.offCourseTicks, 5);
  assert.ok(reading.heardMs > 100 && reading.heardMs < 120, `heard ${reading.heardMs}`);
  assert.ok(reading.earlyMs > 8 && reading.earlyMs < 10, `early ${reading.earlyMs}`);
  assert.equal(reading.holes, 0);
  assert.equal(reading.doubled, 0);
});

test('rampGestureReading: an evaluation that takes the snap back and ends on the course step reads as on course, with no off-course tick', () => {
  const events = [{ kind: 'mark', name: 'x', perf: 1000 }, ...rampSteps, ...evaluation(1210, { endStep: 80, snap: true })];
  const reading = rampGestureReading({ ...base, events, entries: ticks({ fastCount: 0 }) });
  assert.equal(reading.evaluations[0].bpmAtEnd, 110);
  assert.equal(reading.evaluations[0].courseBpm, 110);
  assert.equal(reading.evaluations[0].stepsOff, 0);
  assert.equal(reading.evaluations[0].snapped, true);
  assert.equal(reading.evaluationsOnCourse, true);
  assert.equal(reading.offCourseTicks, 0);
  assert.equal(reading.heardMs, 0);
  // The snap and its take-back are inside the evaluation, so they are not steps of the ramp: the ramp's three steps stay the course.
  assert.equal(reading.at, 0.01);
});

test('rampGestureReading: one step behind the course is on course, three steps behind is not', () => {
  const behind = (step) => rampGestureReading({ ...base, events: [...rampSteps, ...evaluation(1210, { endStep: step })], entries: ticks({ fastCount: 0 }) });
  assert.equal(behind(79).evaluations[0].stepsOff, 1);
  assert.equal(behind(79).evaluationsOnCourse, true);
  assert.equal(behind(77).evaluations[0].stepsOff, 3);
  assert.equal(behind(77).evaluationsOnCourse, false);
});

test('rampGestureReading: every evaluation of a burst is judged at its own end, and one off course fails the gesture', () => {
  const events = [
    ...rampSteps,
    ...evaluation(1210, { endStep: 80 }),
    ...evaluation(1310, { endStep: 80 }),
    ...evaluation(1410, { endStep: 'target', snap: true }),
    ...evaluation(1510, { endStep: 80 }),
  ];
  const reading = rampGestureReading({ ...base, events, entries: ticks({ fastCount: 0 }) });
  assert.equal(reading.evaluations.length, 4);
  assert.deepEqual(reading.evaluations.map((row) => row.stepsOff), [0, 0, 80, 0]);
  assert.equal(reading.evaluationsOnCourse, false);
});

test('rampGestureReading: a waiting change is read at its line, where the tempo is on the course or not', () => {
  const events = [...rampSteps, ...evaluation(1210, { endStep: 80 })];
  const onCourse = rampGestureReading({ ...base, events, entries: ticks({ fastCount: 0 }), lines: [{ perf: 1700, cps: stepCps(80), lastEnd: 4.05 }] });
  assert.equal(onCourse.lines.length, 1);
  assert.equal(onCourse.lines[0].bpmAtLine, 110);
  assert.equal(onCourse.lines[0].stepsOff, 1);
  assert.equal(onCourse.linesOnCourse, true);
  const snapped = rampGestureReading({ ...base, events, entries: ticks({ fastCount: 0 }), lines: [{ perf: 1700, cps: 0.5, lastEnd: 4.05 }] });
  assert.equal(snapped.lines[0].bpmAtLine, 120);
  assert.equal(snapped.linesOnCourse, false);
  assert.equal(rampGestureReading({ ...base, events, entries: ticks({ fastCount: 0 }) }).linesOnCourse, true);
});

test('rampGestureReading: an evaluation that never ends is not on course, and no evaluation after the mark gives null', () => {
  const open = rampGestureReading({ ...base, events: [...rampSteps, { kind: 'eval-start', perf: 1210, cps: stepCps(80), lastEnd: 3.99 }], entries: ticks({ fastCount: 0 }) });
  assert.equal(open.evaluations[0].ended, false);
  assert.equal(open.evaluationsOnCourse, false);
  assert.equal(rampGestureReading({ ...base, events: rampSteps, entries: [] }), null);
  assert.equal(rampGestureReading({ ...base, events: [{ kind: 'eval-start', perf: 500, cps: stepCps(80), lastEnd: 3 }, { kind: 'eval-end', perf: 510, cps: stepCps(80), lastEnd: 3 }], entries: [] }), null);
});

test('rampGestureReading: a hole in the ticks is counted, so a stall cannot pass as on course', () => {
  const times = [];
  for (let at = 700; at < 1900; at += 2500 / 110) if (at < 1300 || at > 1360) times.push(at);
  const reading = rampGestureReading({ ...base, events: [...rampSteps, ...evaluation(1210, { endStep: 80 })], entries: tickEntries(times) });
  assert.ok(reading.holes >= 1, `holes ${reading.holes}`);
});
