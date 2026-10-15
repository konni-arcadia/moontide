import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeTimeline,
  sameEvents,
  pageStartOf,
  playheadCycle,
  playheadReadingSide,
  rulerMarks,
  pitchOf,
  drumTrackIndexes,
  sameIndexSet,
  laneShapes,
  loopPeriod,
  loopLabel,
  TRACK_COLOR_COUNT,
  createTrackColors,
  curvePoints,
  momentAt,
  rangeNotes,
  MAX_RANGE_CYCLES,
  PAGE_CYCLES,
  MIN_DRAWN_WIDTH,
  cycleAt,
  MAX_MOMENT_NOTES,
  SIXTEENTHS_PER_CYCLE,
  noteNameToMidi,
  toLaneEvent,
  velocityOf,
} from '../page/timeline.js';

/** A fake hap shaped like a real Strudel hap: { whole: { begin, end }, hasOnset(), value }. */
function fakeHap({ begin, end, value, whole = true, onset = true }) {
  return {
    whole: whole ? { begin: { valueOf: () => begin }, end: { valueOf: () => end } } : null,
    hasOnset: () => onset,
    value,
  };
}

/** A fake pattern exposing only queryArc, returning the same fixed haps regardless of range —
 * every test below uses pageCycles === sliceCycles so queryArc is called exactly once. */
function fakePattern(haps) {
  return { queryArc: () => haps };
}

test('computeTimeline returns too-slow once the budget is exceeded after the first slice, and never returns lanes', async () => {
  const clockValues = [0, 0, 0, 3000];
  const clock = () => (clockValues.length > 1 ? clockValues.shift() : clockValues[0]);
  const result = await computeTimeline({
    tracks: [{ index: 0, muted: false }],
    soloPattern: async () => fakePattern([]),
    combinedPattern: fakePattern([]),
    pageStart: 0,
    pageCycles: 32,
    budgetMs: 100,
    sliceCycles: 4,
    clock,
    yieldToPage: async () => {},
    isCancelled: () => false,
  });
  assert.equal(result.state, 'too-slow');
  assert.equal(result.computeMs, 3000);
  assert.ok(!('lanes' in result), 'a too-slow result must never carry lanes');
});

test('computeTimeline returns cancelled once isCancelled() turns true after the first slice, without finishing', async () => {
  let cancelCalls = 0;
  const isCancelled = () => {
    cancelCalls++;
    return cancelCalls > 1;
  };
  const result = await computeTimeline({
    tracks: [{ index: 0, muted: false }],
    soloPattern: async () => fakePattern([]),
    combinedPattern: fakePattern([]),
    pageStart: 0,
    pageCycles: 32,
    budgetMs: Infinity,
    sliceCycles: 4,
    clock: () => 0,
    yieldToPage: async () => {},
    isCancelled,
  });
  assert.deepEqual(result, { state: 'cancelled' });
});

test('computeTimeline returns failed/error carrying the thrown message when soloPattern throws', async () => {
  const result = await computeTimeline({
    tracks: [{ index: 0, muted: false }],
    soloPattern: async () => {
      throw new Error('boom-solo');
    },
    combinedPattern: fakePattern([]),
    pageStart: 0,
    pageCycles: 4,
    budgetMs: Infinity,
    sliceCycles: 4,
    clock: () => 0,
    yieldToPage: async () => {},
    isCancelled: () => false,
  });
  assert.equal(result.state, 'failed');
  assert.equal(result.reason, 'error');
  assert.equal(result.message, 'boom-solo');
});

test('computeTimeline returns failed/error carrying the thrown message when a track pattern queryArc throws', async () => {
  const throwingPattern = {
    queryArc: () => {
      throw new Error('boom-query');
    },
  };
  const result = await computeTimeline({
    tracks: [{ index: 0, muted: false }],
    soloPattern: async () => throwingPattern,
    combinedPattern: fakePattern([]),
    pageStart: 0,
    pageCycles: 4,
    budgetMs: Infinity,
    sliceCycles: 4,
    clock: () => 0,
    yieldToPage: async () => {},
    isCancelled: () => false,
  });
  assert.equal(result.state, 'failed');
  assert.equal(result.reason, 'error');
  assert.equal(result.message, 'boom-query');
});

test('a union missing one real event returns failed/mismatch', async () => {
  const realEvents = [
    fakeHap({ begin: 0, end: 1, value: { s: 'a' } }),
    fakeHap({ begin: 1, end: 2, value: { s: 'a' } }),
  ];
  const trackEvents = [fakeHap({ begin: 0, end: 1, value: { s: 'a' } })];
  const result = await computeTimeline({
    tracks: [{ index: 0, muted: false }],
    soloPattern: async () => fakePattern(trackEvents),
    combinedPattern: fakePattern(realEvents),
    pageStart: 0,
    pageCycles: 4,
    budgetMs: Infinity,
    sliceCycles: 4,
    clock: () => 0,
    yieldToPage: async () => {},
    isCancelled: () => false,
  });
  assert.equal(result.state, 'failed');
  assert.equal(result.reason, 'mismatch');
});

test('a union with an extra event also returns failed/mismatch', async () => {
  const realEvents = [fakeHap({ begin: 0, end: 1, value: { s: 'a' } })];
  const trackEvents = [
    fakeHap({ begin: 0, end: 1, value: { s: 'a' } }),
    fakeHap({ begin: 1, end: 2, value: { s: 'a' } }),
  ];
  const result = await computeTimeline({
    tracks: [{ index: 0, muted: false }],
    soloPattern: async () => fakePattern(trackEvents),
    combinedPattern: fakePattern(realEvents),
    pageStart: 0,
    pageCycles: 4,
    budgetMs: Infinity,
    sliceCycles: 4,
    clock: () => 0,
    yieldToPage: async () => {},
    isCancelled: () => false,
  });
  assert.equal(result.state, 'failed');
  assert.equal(result.reason, 'mismatch');
});

test('equal multisets in a different order pass with state ok', async () => {
  const events = [
    fakeHap({ begin: 0, end: 1, value: { s: 'a' } }),
    fakeHap({ begin: 1, end: 2, value: { s: 'b' } }),
  ];
  const reversedEvents = [events[1], events[0]];
  const result = await computeTimeline({
    tracks: [{ index: 0, muted: false }],
    soloPattern: async () => fakePattern(reversedEvents),
    combinedPattern: fakePattern(events),
    pageStart: 0,
    pageCycles: 4,
    budgetMs: Infinity,
    sliceCycles: 4,
    clock: () => 0,
    yieldToPage: async () => {},
    isCancelled: () => false,
  });
  assert.equal(result.state, 'ok');
});

test('a muted track contributes no events and its soloPattern is never called', async () => {
  let calledForMuted = false;
  const tracks = [
    { index: 0, muted: true },
    { index: 1, muted: false },
  ];
  const soloPattern = async (track) => {
    if (track.muted) calledForMuted = true;
    return fakePattern([]);
  };
  const result = await computeTimeline({
    tracks,
    soloPattern,
    combinedPattern: fakePattern([]),
    pageStart: 0,
    pageCycles: 4,
    budgetMs: Infinity,
    sliceCycles: 4,
    clock: () => 0,
    yieldToPage: async () => {},
    isCancelled: () => false,
  });
  assert.equal(calledForMuted, false);
  assert.equal(result.state, 'ok');
  assert.deepEqual(
    result.lanes.find((lane) => lane.index === 0).events,
    [],
  );
});

test('haps without a whole or an onset are ignored; an event ending after the page end keeps its real end', async () => {
  const haps = [
    fakeHap({ begin: 0, end: 1, value: { s: 'a' }, whole: false }),
    fakeHap({ begin: 0, end: 1, value: { s: 'a' }, onset: false }),
    fakeHap({ begin: 2, end: 40, value: { s: 'a' } }),
  ];
  const result = await computeTimeline({
    tracks: [{ index: 0, muted: false }],
    soloPattern: async () => fakePattern(haps),
    combinedPattern: fakePattern(haps),
    pageStart: 0,
    pageCycles: 32,
    budgetMs: Infinity,
    sliceCycles: 32,
    clock: () => 0,
    yieldToPage: async () => {},
    isCancelled: () => false,
  });
  assert.equal(result.state, 'ok');
  assert.equal(result.lanes[0].events.length, 1);
  assert.equal(result.lanes[0].events[0].begin, 2);
  assert.equal(result.lanes[0].events[0].end, 40);
});

test('sameEvents treats values with the same keys in a different order as equal, and different numbers as different', () => {
  const a = { begin: 0, end: 1, value: { s: 'x', gain: 1 } };
  const b = { begin: 0, end: 1, value: { gain: 1, s: 'x' } };
  assert.ok(sameEvents([a], [b]));
  const c = { begin: 0, end: 1, value: { s: 'x', gain: 2 } };
  assert.ok(!sameEvents([a], [c]));
});

test('pageStartOf clamps negative cycles to 0 and floors to a multiple of 32', () => {
  assert.equal(pageStartOf(0), 0);
  assert.equal(pageStartOf(31.9), 0);
  assert.equal(pageStartOf(32), 32);
  assert.equal(pageStartOf(70.5), 64);
  assert.equal(pageStartOf(-1), 0);
});

test('playheadCycle floors to a whole cycle when motion is off, stays exact when motion is on', () => {
  assert.equal(playheadCycle(33.7, 'off'), 33);
  assert.equal(playheadCycle(33.7, 'on'), 33.7);
});

test('playheadReadingSide keeps the reading right of the line while it fits inside the track column', () => {
  assert.equal(playheadReadingSide(100, 40, 500), 'right');
  assert.equal(playheadReadingSide(460, 40, 500), 'right');
});

test('playheadReadingSide flips the reading left of the line when it would pass the column edge', () => {
  assert.equal(playheadReadingSide(460.5, 40, 500), 'left');
});

test('playheadReadingSide answers right for a hidden Timeline body that measures as all zeros', () => {
  assert.equal(playheadReadingSide(0, 0, 0), 'right');
});

test('playheadReadingSide throws a TypeError naming the bad argument', () => {
  assert.throws(() => playheadReadingSide(NaN, 40, 500), { name: 'TypeError', message: /lineRight/ });
  assert.throws(() => playheadReadingSide(100, Infinity, 500), { name: 'TypeError', message: /readingWidth/ });
  assert.throws(() => playheadReadingSide(100, 40, undefined), { name: 'TypeError', message: /columnRight/ });
});

test('rulerMarks gives 32 marks for the page, labeled every 4 cycles', () => {
  const marks = rulerMarks(32);
  assert.equal(marks.length, 32);
  assert.equal(marks[0].cycle, 32);
  assert.equal(marks[31].cycle, 63);
  assert.deepEqual(
    marks.map((m) => m.x),
    Array.from({ length: 32 }, (_, i) => i),
  );
  const labeled = marks.filter((m) => m.labeled);
  assert.equal(labeled.length, 8);
  assert.deepEqual(
    labeled.map((m) => m.cycle),
    [32, 36, 40, 44, 48, 52, 56, 60],
  );
});

// --- Pitch, lane shapes, loop detection, track colors ---

test('pitchOf reads a numeric MIDI note directly', () => {
  assert.equal(pitchOf({ note: 60 }), 60);
});

test('pitchOf reads note names: letter, sharp/flat accidentals, default octave 3', () => {
  assert.equal(pitchOf({ note: 'c4' }), 60);
  assert.equal(pitchOf({ note: 'C#4' }), 61);
  assert.equal(pitchOf({ note: 'cs4' }), 61);
  assert.equal(pitchOf({ note: 'eb3' }), 51);
  assert.equal(pitchOf({ note: 'a' }), 57);
});

test('pitchOf reads a frequency in Hz (A4=440 is MIDI 69)', () => {
  assert.equal(pitchOf({ freq: 440 }), 69);
});

test('pitchOf is null for a value with no note or freq, and for a non-object value', () => {
  assert.equal(pitchOf({ s: 'bd' }), null);
  assert.equal(pitchOf({ s: 'bd', n: 3 }), null);
  assert.equal(pitchOf('x'), null);
});

test('pitchOf is null (never Infinity/NaN) for a note name whose octave overflows Number()', () => {
  const hugeOctave = `c${'9'.repeat(400)}`;
  assert.equal(pitchOf({ note: hugeOctave }), null);
  assert.equal(pitchOf({ note: `c-${'9'.repeat(400)}` }), null);
});

test('pitchOf is null for a note name whose octave is finite but overflows once scaled to MIDI', () => {
  const finiteHugeOctave = `c${'9'.repeat(308)}`;
  assert.ok(Number.isFinite(Number('9'.repeat(308))));
  assert.equal(pitchOf({ note: finiteHugeOctave }), null);
  assert.equal(pitchOf({ note: `c-${'9'.repeat(308)}` }), null);
});

test('laneShapes gives note shapes placed by pitch (highest at the top) and tick shapes for events with no pitch', () => {
  const events = [
    { begin: 0, end: 1, value: { note: 60 } }, // c4 — the lane's lowest pitch here
    { begin: 1, end: 2, value: { note: 72 } }, // c5 — the lane's highest pitch here
    { begin: 2, end: 3, value: { s: 'bd' } }, // no pitch -> tick
  ];
  const shapes = laneShapes(events, 0);
  assert.equal(shapes[0].kind, 'note');
  assert.equal(shapes[1].kind, 'note');
  assert.equal(shapes[2].kind, 'tick');
  assert.equal(shapes[1].y, 0, 'the highest pitch in the lane sits at the top (y=0)');
  assert.equal(shapes[0].y, 1, 'the lowest pitch in the lane sits at the bottom (y=1)');
});

test('laneShapes centers a lane whose note events all share one pitch', () => {
  const events = [
    { begin: 0, end: 1, value: { note: 60 } },
    { begin: 1, end: 2, value: { note: 60 } },
  ];
  const shapes = laneShapes(events, 0);
  assert.equal(shapes[0].y, 0.5);
  assert.equal(shapes[1].y, 0.5);
});

test('laneShapes places x at begin minus pageStart and clips width to the page end, at least 0.05', () => {
  const events = [
    { begin: 5, end: 6, value: { s: 'bd' } },
    { begin: 30, end: 40, value: { s: 'bd' } }, // extends past the 32-cycle page end
  ];
  const shapes = laneShapes(events, 0);
  assert.equal(shapes[0].x, 5);
  assert.equal(shapes[0].width, 1);
  assert.equal(shapes[1].x, 30);
  assert.equal(shapes[1].width, 2);
});

const lpfIgnore = ['cutoff'];

test('loopPeriod finds the smallest repeat period from 1 to 16 cycles', () => {
  // A single note at cycle 0, repeated every 4 cycles — the smallest true period is 4.
  const events = [0, 4, 8, 12, 16, 20, 24, 28].map((begin) => ({ begin, end: begin + 1, value: { note: 60 } }));
  assert.equal(loopPeriod(events, 0), 4);
});

test('loopPeriod returns null when nothing in the page repeats within 16 cycles', () => {
  const events = [{ begin: 0, end: 1, value: { note: 60 } }, { begin: 20, end: 21, value: { note: 62 } }];
  assert.equal(loopPeriod(events, 0), null);
});

test('loopPeriod ignores the listed keys, so a moving cutoff does not hide a note loop', () => {
  const events = [0, 1, 2, 3].flatMap((cycle) =>
    [0, 8, 16, 24].map((base) => ({ begin: base + cycle, end: base + cycle + 1, value: { note: 60 + cycle, cutoff: 400 + base + cycle } })),
  );
  assert.equal(loopPeriod(events, 0, lpfIgnore), 8);
  assert.equal(loopPeriod(events, 0, []), null, 'without ignoring cutoff, the ever-changing cutoff hides the note loop');
});

test('loopLabel names the period in words', () => {
  assert.equal(loopLabel(1), 'repeats every cycle');
  assert.equal(loopLabel(4), 'repeats every 4 cycles');
  assert.equal(loopLabel(null), '');
});

test('createTrackColors assigns 1..8 in first-seen order, wrapping to 1 for a 9th identity', () => {
  const colors = createTrackColors();
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'].map((id) => colors.colorOf(id));
  assert.equal(TRACK_COLOR_COUNT, 8);
  assert.deepEqual(ids, [1, 2, 3, 4, 5, 6, 7, 8, 1]);
  assert.equal(colors.colorOf('a'), 1, 'a known identity always gives the same color');
});

// --- curvePoints ---

test('curvePoints gives one point per event carrying a finite positive control value, on a log scale', () => {
  const events = [
    { begin: 0, end: 1, value: { cutoff: 400 } }, // lowest -> bottom (y=1)
    { begin: 1, end: 2, value: { cutoff: 2000 } }, // highest -> top (y=0)
    { begin: 2, end: 3, value: { s: 'bd' } }, // no cutoff -> excluded
  ];
  const points = curvePoints(events, 'cutoff', 0);
  assert.equal(points.length, 2);
  assert.deepEqual(points[0], [0, 1]);
  assert.deepEqual(points[1], [1, 0]);
});

test('curvePoints centers at 0.5 when every value is equal', () => {
  const events = [
    { begin: 0, end: 1, value: { cutoff: 800 } },
    { begin: 1, end: 2, value: { cutoff: 800 } },
  ];
  const points = curvePoints(events, 'cutoff', 0);
  assert.deepEqual(points, [
    [0, 0.5],
    [1, 0.5],
  ]);
});

test('curvePoints excludes non-finite or non-positive values and returns [] when the control never appears', () => {
  const events = [
    { begin: 0, end: 1, value: { cutoff: -100 } },
    { begin: 1, end: 2, value: { cutoff: NaN } },
    { begin: 2, end: 3, value: { cutoff: Infinity } },
  ];
  assert.deepEqual(curvePoints(events, 'cutoff', 0), []);
  assert.deepEqual(curvePoints([{ begin: 0, end: 1, value: { s: 'bd' } }], 'cutoff', 0), []);
});

// --- momentAt ---

/** A lane as the Timeline records it when it draws: { track, midi, instrument, events }. */
function lane(events, extra = {}) {
  return { track: 'main', midi: false, instrument: null, events, ...extra };
}

/** An instant 8.64 cycles into the page (fraction 0.27), so cycle 8 of the page, beat 3. */
function momentOn(lanes, { pageStart = 32, fraction = 0.27, version = 5 } = {}) {
  return momentAt({ pageStart, fraction, lanes, version });
}

test('momentAt gives the cycle, the beat and the instant', () => {
  const at27 = momentOn([]);
  assert.equal(at27.cycle, 40);
  assert.equal(at27.beat, 3);
  assert.equal(at27.at, 40.64);
  assert.equal(at27.version, 5);
  assert.deepEqual(at27.notes, []);
  assert.equal(at27.more, 0);
  assert.equal(SIXTEENTHS_PER_CYCLE, 16);
  const first = momentOn([], { fraction: 0 });
  assert.equal(first.cycle, 32);
  assert.equal(first.beat, 1);
  for (const fraction of [1, 1.2]) {
    const last = momentOn([], { fraction });
    assert.equal(last.cycle, 63, `fraction ${fraction}`);
    assert.equal(last.beat, 4, `fraction ${fraction}`);
    assert.ok(last.at >= 63 && last.at < 64, `fraction ${fraction} stays inside cycle 63, got ${last.at}`);
  }
  const before = momentOn([], { fraction: -0.1 });
  assert.equal(before.cycle, 32);
  assert.equal(before.beat, 1);
});

test('momentAt: at, beat and the sixteenth come from the same rounded instant', () => {
  // 0.2496 into cycle 8 reads as at 8.25, so beat 2, never beat 1 beside an `at` that reads as beat 2.
  const fraction = (8 + 0.2496) / 32;
  const moment = momentAt({
    pageStart: 0,
    fraction,
    version: null,
    lanes: [
      lane([
        { begin: 8.2499, end: 8.2499 + 1 / 128, value: { s: 'hh' } },
        { begin: 8.2503, end: 9, value: { s: 'bd' } },
      ]),
    ],
  });
  assert.equal(moment.at, 8.25);
  assert.equal(moment.beat, 2);
  assert.deepEqual(moment.notes.map((note) => [note.sound, note.state]), [['hh', 'sounding'], ['bd', 'starts']]);
  // Every beat of every cycle agrees with `at` over a fine sweep.
  for (let step = 0; step <= 6400; step++) {
    const sweep = momentAt({ pageStart: 0, fraction: step / 6400, version: null, lanes: [] });
    assert.equal(sweep.beat, Math.floor((sweep.at - sweep.cycle) * 4 + 1e-9) + 1, `step ${step}: ${sweep.at}`);
    assert.ok(sweep.at >= sweep.cycle && sweep.at < sweep.cycle + 1, `step ${step}: ${sweep.at}`);
  }
});

test('momentAt takes its cycle from cycleAt over a sweep of 3201 fractions', () => {
  for (const pageStart of [0, 32]) {
    for (let step = 0; step <= 3200; step++) {
      const fraction = -0.0005 + (step * 1.001) / 3200;
      assert.equal(momentAt({ pageStart, fraction, lanes: [], version: null }).cycle, cycleAt({ pageStart, fraction }), `fraction ${fraction}`);
    }
  }
});

test('momentAt: a note is sounding while its span holds the instant, end exclusive', () => {
  const sounding = momentOn([lane([{ begin: 40.5, end: 41, value: { note: 'c4' } }])]);
  assert.equal(sounding.notes.length, 1);
  assert.equal(sounding.notes[0].state, 'sounding');
  const atBegin = momentOn([lane([{ begin: 40.64, end: 41, value: { note: 'c4' } }])]);
  assert.equal(atBegin.notes[0].state, 'sounding');
  const atEnd = momentOn([lane([{ begin: 40.1, end: 40.64, value: { note: 'c4' } }])]);
  assert.deepEqual(atEnd.notes, []);
});

test('momentAt: a note that starts later in the same sixteenth is in, the next sixteenth is not', () => {
  // The instant 40 + 10/16 + 1/64 is 1/64 cycle into the sixteenth [40.625, 40.6875).
  const fraction = (8 + 10 / 16 + 1 / 64) / 32;
  const moment = momentOn(
    [
      lane([
        { begin: 40 + 10 / 16 + 1 / 32, end: 41, value: { s: 'bd' } },
        { begin: 40 + 11 / 16, end: 41, value: { s: 'hh' } },
      ]),
    ],
    { fraction },
  );
  assert.equal(moment.notes.length, 1);
  assert.equal(moment.notes[0].state, 'starts');
  assert.equal(moment.notes[0].sound, 'bd');
});

test('momentAt: a note that began earlier in the same sixteenth and already ended is not in the moment', () => {
  // The instant is late in the sixteenth [40.625, 40.6875): 0.06 cycles after its start, past the narrowest
  // drawn width. The hat began at the cell start and its drawn span is over; the bass begins later in the cell.
  const fraction = (40.685 - 32) / 32;
  const moment = momentOn(
    [
      lane([
        { begin: 40.625, end: 40.625 + 1 / 128, value: { s: 'hh' } },
        { begin: 40.686, end: 41, value: { s: 'bd' } },
      ]),
    ],
    { fraction },
  );
  assert.deepEqual(moment.notes.map((note) => [note.sound, note.state]), [['bd', 'starts']]);
});

test('momentAt: a note shorter than the narrowest drawn width counts as drawn, so it is sounding under its rect', () => {
  // hh*32 is 1/32 cycle long; it is drawn MIN_DRAWN_WIDTH wide from its start.
  assert.equal(MIN_DRAWN_WIDTH, 0.05);
  const begin = 40.6;
  const instant = begin + 0.04;
  const fraction = (instant - 32) / 32;
  const inside = momentOn([lane([{ begin, end: begin + 1 / 32, value: { s: 'hh' } }])], { fraction });
  assert.deepEqual(inside.notes.map((note) => [note.sound, note.state]), [['hh', 'sounding']]);
  // Past the drawn rect, in the same sixteenth or not, the note is gone.
  const past = momentOn([lane([{ begin, end: begin + 1 / 32, value: { s: 'hh' } }])], { fraction: (begin + 0.0501 - 32) / 32 });
  assert.deepEqual(past.notes, []);
});

test('momentAt: chords count every note, drums carry a sound and no note', () => {
  const chord = momentOn([
    lane([
      { begin: 40.5, end: 41, value: { note: 'c4' } },
      { begin: 40.5, end: 41, value: { note: 'e4' } },
      { begin: 40.5, end: 41, value: { note: 'g4' } },
    ]),
  ]);
  assert.deepEqual(chord.notes.map((note) => note.note), ['c4', 'e4', 'g4']);
  const drum = momentOn([lane([{ begin: 40.5, end: 41, value: { s: 'bd' } }])]).notes[0];
  assert.equal(drum.sound, 'bd');
  assert.equal('note' in drum, false);
  const number = momentOn([lane([{ begin: 40.5, end: 41, value: { note: 60 } }])]).notes[0];
  assert.equal(number.note, 60);
  const both = momentOn([lane([{ begin: 40.5, end: 41, value: { note: 'c4', s: 'sine' } }])]).notes[0];
  assert.equal(both.note, 'c4');
  assert.equal(both.sound, 'sine');
  const list = momentOn([lane([{ begin: 40.5, end: 41, value: { note: [1, 2] } }])]).notes[0];
  assert.equal('note' in list, false);
});

test('momentAt: the velocity is gain x velocity with the pinned defaults, never guessed', () => {
  const velocityOf = (value, midi) => momentOn([lane([{ begin: 40.5, end: 41, value }], { midi })]).notes[0].velocity;
  assert.equal(velocityOf({ note: 'c4' }, false), 0.8);
  assert.equal(velocityOf({ note: 'c4', gain: 0.5, velocity: 0.6 }, false), 0.3);
  assert.equal(velocityOf({ note: 'c4' }, true), 0.9);
  assert.equal(velocityOf({ note: 'c4', gain: 0.5 }, true), 0.45);
  assert.equal(velocityOf({ note: 'c4', gain: 0 }, false), 0);
  assert.equal(velocityOf({ note: 'c4', gain: Number.NaN }, false), undefined);
  assert.equal(velocityOf({ note: 'c4', gain: '0.5' }, false), undefined);
  assert.equal(velocityOf({ note: 'c4', gain: -1 }, false), undefined);
  const left = momentOn([lane([{ begin: 40.5, end: 41, value: { note: 'c4', gain: Number.NaN } }])]).notes[0];
  assert.equal('velocity' in left, false);
});

test('momentAt: the instrument only on a lane that has one, positions rounded to 3 decimals', () => {
  const midi = lane([{ begin: 40.5, end: 41, value: { note: 'c4' } }], { track: 'pad', midi: true, instrument: 'synth \u00B7 ch 3' });
  const plain = lane([{ begin: 40.1234, end: 40.9876, value: { note: 'c4' } }]);
  const moment = momentOn([midi, plain]);
  assert.equal(moment.notes[0].instrument, 'synth \u00B7 ch 3');
  assert.equal(moment.notes[0].track, 'pad');
  assert.equal('instrument' in moment.notes[1], false);
  assert.equal(moment.notes[1].start, 40.123);
  assert.equal(moment.notes[1].end, 40.988);
  assert.equal(moment.at, 40.64);
});

// The drum name of a note on a lane whose drum map is known.
const KIT_MAP = {
  name: 'Roland MT-32 Rhythm',
  byNote: new Map([
    [36, 'Acoustic Bass Drum'],
    [38, 'Acoustic Snare Drum'],
  ]),
};

test('momentAt: a note on a drum lane with a known map carries its drum name right after note', () => {
  const kit = (events, drumMap = KIT_MAP) => lane(events, { track: 'drums', midi: true, instrument: 'mt32 \u00B7 ch 10', drumMap });
  const sounding = momentOn([kit([{ begin: 40, end: 41, value: { note: 36 } }])]).notes[0];
  assert.deepEqual(sounding, {
    track: 'drums',
    instrument: 'mt32 \u00B7 ch 10',
    note: 36,
    drum: 'Acoustic Bass Drum',
    velocity: 0.9,
    start: 40,
    end: 41,
    state: 'sounding',
  });
  assert.deepEqual(Object.keys(sounding), ['track', 'instrument', 'note', 'drum', 'velocity', 'start', 'end', 'state']);
  const starting = momentOn([kit([{ begin: 40.66, end: 41, value: { note: 'c2' } }])]).notes[0];
  assert.equal(starting.state, 'starts');
  assert.equal(starting.drum, 'Acoustic Bass Drum', 'a note name reads like its number');
  assert.equal('drum' in momentOn([kit([{ begin: 40, end: 41, value: { note: 52 } }])]).notes[0], false, 'a note the map does not name');
  assert.equal('drum' in momentOn([kit([{ begin: 40, end: 41, value: { freq: 65.41 } }])]).notes[0], false, 'a frequency is not a drum note');
  assert.equal('drum' in momentOn([kit([{ begin: 40, end: 41, value: { note: 36 } }], null)]).notes[0], false, 'an unknown map');
  assert.equal('drum' in momentOn([lane([{ begin: 40, end: 41, value: { note: 36 } }], { midi: true })]).notes[0], false, 'a lane with no drumMap');
  assert.equal('drum' in momentOn([lane([{ begin: 40, end: 41, value: { note: 36 } }], { midi: true, drumMap: undefined })]).notes[0], false);
});

test('momentAt refuses a drumMap that is not null and not { name, byNote: Map }, naming drumMap', () => {
  const event = [{ begin: 40, end: 41, value: { note: 36 } }];
  for (const bad of [{}, { name: 'x', byNote: {} }, { name: 5, byNote: new Map() }, 'map', 7]) {
    assert.throws(() => momentOn([lane(event, { drumMap: bad })]), (error) => error instanceof TypeError && error.message.includes('drumMap'), JSON.stringify(bad));
  }
});

test('momentAt: at most 32 notes in lane order then start, the rest counted in more', () => {
  const events = (count, begin) => Array.from({ length: count }, (_, index) => ({ begin: begin - index / 1000, end: 41, value: { s: 'bd' } }));
  const a = lane(events(20, 40.5), { track: 'a' });
  const b = lane(events(20, 40.5), { track: 'b' });
  const input = JSON.stringify([a, b]);
  const moment = momentOn([a, b]);
  assert.equal(MAX_MOMENT_NOTES, 32);
  assert.equal(moment.notes.length, 32);
  assert.equal(moment.more, 8);
  assert.deepEqual(
    moment.notes.map((note) => note.track),
    [...Array(20).fill('a'), ...Array(12).fill('b')],
  );
  const starts = moment.notes.slice(0, 20).map((note) => note.start);
  assert.deepEqual(starts, [...starts].sort((x, y) => x - y));
  assert.equal(JSON.stringify([a, b]), input, 'the drawn events are not mutated');
  const empty = momentOn([lane([]), lane([])]);
  assert.deepEqual(empty.notes, []);
  assert.equal(empty.more, 0);
});

test('momentAt: the right-clicked lane keeps its notes first under the cap, the others follow in lane order', () => {
  const events = (count) => Array.from({ length: count }, (_, index) => ({ begin: 40.5 - index / 1000, end: 41, value: { s: 'bd' } }));
  const lanes = [
    lane(events(20), { track: 'chords' }),
    lane(events(20), { track: 'arp' }),
    lane([{ begin: 40.5, end: 41, value: { note: 'c2' } }], { track: 'lead' }),
  ];
  // Without a focus the last lane is cut off; with it, its note is first and the cap still holds.
  const plain = momentOn(lanes);
  assert.equal(plain.notes.some((note) => note.track === 'lead'), false);
  const focused = momentAt({ pageStart: 32, fraction: 0.27, lanes, version: 5, focusTrack: 'lead' });
  assert.equal(focused.notes.length, 32);
  assert.equal(focused.more, 9);
  assert.equal(focused.notes[0].track, 'lead');
  assert.deepEqual(focused.notes.slice(1).map((note) => note.track), [...Array(20).fill('chords'), ...Array(11).fill('arp')]);
  // A name that no lane has changes nothing.
  assert.deepEqual(momentAt({ pageStart: 32, fraction: 0.27, lanes, version: 5, focusTrack: 'nothing' }), plain);
  assert.throws(() => momentAt({ pageStart: 32, fraction: 0.27, lanes, version: 5, focusTrack: 3 }), TypeError);
});

test('momentAt refuses bad input loudly', () => {
  const good = { pageStart: 32, fraction: 0.5, lanes: [], version: 1 };
  for (const bad of [
    { fraction: Number.NaN },
    { fraction: '0.5' },
    { pageStart: -32 },
    { pageStart: 1.5 },
    { version: 0 },
    { version: 2.5 },
    { version: undefined },
    { lanes: null },
  ]) {
    assert.throws(() => momentAt({ ...good, ...bad }), (err) => err instanceof TypeError && err.message.startsWith('momentAt:'), JSON.stringify(bad));
  }
  assert.equal(momentAt({ ...good, version: null }).version, null);
});

test('drumTrackIndexes returns the index of every track whose identity is a drum identity', () => {
  const tracks = [
    { index: 0, identity: 'label:pad' },
    { index: 1, identity: 'label:drums' },
    { index: 2, identity: 'label:bass' },
  ];
  assert.deepEqual([...drumTrackIndexes(tracks, new Map([['label:drums', { use: 'mt32' }]]))], [1]);
  assert.equal(drumTrackIndexes(tracks, new Map()).size, 0);
  assert.deepEqual([...drumTrackIndexes(tracks, new Set(['label:bass', 'label:pad']))].sort(), [0, 2]);
  // the index of the track is returned, not its position in the array
  assert.deepEqual([...drumTrackIndexes([{ index: 7, identity: 'label:a' }, { index: 3, identity: 'label:b' }], new Set(['label:b']))], [3]);
});

test('sameIndexSet is true only for the same indexes, whatever the order', () => {
  assert.equal(sameIndexSet(new Set(), new Set()), true);
  assert.equal(sameIndexSet(new Set([1, 3]), new Set([3, 1])), true);
  assert.equal(sameIndexSet(new Set([1]), new Set([1, 2])), false);
  assert.equal(sameIndexSet(new Set([1, 2]), new Set([1])), false);
  assert.equal(sameIndexSet(new Set([1, 2]), new Set([1, 3])), false);
});

// --- the places in the code that the lanes' notes carry ---

/** A fake hap that also carries the context a real Strudel hap has: the offsets of the strings its note was read from. */
function hapWithLocations({ begin, end, value, locations }) {
  return { ...fakeHap({ begin, end, value }), context: { locations } };
}

async function lanesOf(realHaps, trackHaps) {
  return computeTimeline({
    tracks: [{ index: 0, muted: false }],
    soloPattern: async () => fakePattern(trackHaps),
    combinedPattern: fakePattern(realHaps),
    pageStart: 0,
    pageCycles: 4,
    budgetMs: Infinity,
    sliceCycles: 4,
    clock: () => 0,
    yieldToPage: async () => {},
    isCancelled: () => false,
  });
}

test('lane events carry plain copies of the places in the code of their notes', async () => {
  const locations = [{ start: 10, end: 12 }];
  const hap = hapWithLocations({ begin: 0, end: 1, value: { note: 'c3' }, locations });
  const result = await lanesOf([hap], [hap]);
  assert.equal(result.state, 'ok');
  const [event] = result.lanes[0].events;
  assert.deepEqual(event.locations, [{ start: 10, end: 12 }]);
  // Copies: changing the hap afterwards, or the list the event holds, changes nothing in the other.
  locations[0].start = 99;
  assert.deepEqual(event.locations, [{ start: 10, end: 12 }]);
  assert.notEqual(event.locations, locations);
  assert.notEqual(event.locations[0], locations[0]);
});

test('a hap with no context, or with no list of places, gives locations null', async () => {
  const bare = fakeHap({ begin: 0, end: 1, value: { note: 'c3' } });
  const noList = { ...fakeHap({ begin: 1, end: 2, value: { note: 'e3' } }), context: {} };
  const result = await lanesOf([bare, noList], [bare, noList]);
  assert.equal(result.state, 'ok');
  assert.deepEqual(result.lanes[0].events.map((event) => event.locations), [null, null]);
  assert.deepEqual(toLaneEvent(bare), { begin: 0, end: 1, value: { note: 'c3' }, locations: null });
});

test('the union check does not look at the places: the real pattern has none and the lanes still add up to it', async () => {
  const real = fakeHap({ begin: 0, end: 1, value: { note: 'c3' } });
  const lane = hapWithLocations({ begin: 0, end: 1, value: { note: 'c3' }, locations: [{ start: 1, end: 3 }] });
  const result = await lanesOf([real], [lane]);
  assert.equal(result.state, 'ok');
  assert.equal(result.lanes[0].events.length, 1);
  // The same notes with other places are the same notes.
  assert.ok(sameEvents([{ begin: 0, end: 1, value: { note: 'c3' }, locations: [{ start: 1, end: 3 }] }], [{ begin: 0, end: 1, value: { note: 'c3' }, locations: null }]));
});

test('noteNameToMidi and velocityOf are the helpers the note panel reads with', () => {
  assert.equal(noteNameToMidi('c3'), 48);
  assert.equal(noteNameToMidi('C#3'), 49);
  assert.equal(noteNameToMidi('bd'), null);
  assert.equal(velocityOf({ gain: 0.5, velocity: 0.5 }, false), 0.25);
  assert.equal(velocityOf({}, true), 0.9);
});

// --- rangeNotes ---

/** A lane as the Timeline draws it, with events starting at the given times (the pitch follows the order given). */
function rangeLane(starts, extra = {}) {
  return {
    track: 't1',
    midi: false,
    instrument: undefined,
    drumMap: null,
    events: starts.map((begin, at) => ({ begin, end: begin + 0.25, value: { note: 48 + at } })),
    ...extra,
  };
}

test('rangeNotes: the notes that start from the first cycle up to before the one after the last', () => {
  const lane = rangeLane([1.5, 2, 3.25, 5.9, 6]);
  const { notes, more } = rangeNotes(lane, 2, 5);
  assert.deepEqual(notes.map((note) => note.start), [2, 3.25, 5.9]);
  assert.equal(more, 0);
  // A note shaped like a moment note, without a state, with the lane's shown name.
  assert.deepEqual(notes[0], { track: 't1', note: 49, velocity: 0.8, start: 2, end: 2.25 });
  assert.ok(notes.every((note) => !('state' in note)));
});

test('rangeNotes: a note that starts exactly at the first cycle is in, one that starts exactly after the last cycle is out, one that began before and still sounds is out', () => {
  const lane = rangeLane([1.5, 2, 6]);
  lane.events[0].end = 4;
  const { notes } = rangeNotes(lane, 2, 5);
  assert.deepEqual(notes.map((note) => note.start), [2]);
  // The same note with a one-cycle range ends exactly where the next cycle starts.
  assert.deepEqual(rangeNotes(lane, 5, 5).notes, []);
  assert.deepEqual(rangeNotes(lane, 6, 6).notes.map((note) => note.start), [6]);
  // Float noise at an edge does not move a note across it: just before the first cycle is the first cycle, just before the
  // cycle after the last is that cycle.
  assert.deepEqual(rangeNotes(rangeLane([2 - 1e-12, 6 - 1e-12]), 2, 5).notes.map((note) => Math.round(note.start)), [2]);
});

test('rangeNotes: a lane with no notes in the range gives no notes and more 0', () => {
  assert.deepEqual(rangeNotes(rangeLane([]), 0, 31), { notes: [], more: 0 });
  assert.deepEqual(rangeNotes(rangeLane([10, 11]), 0, 3), { notes: [], more: 0 });
});

test('rangeNotes: notes at the same start come lower pitch first, and the order is start then pitch', () => {
  const lane = {
    ...rangeLane([]),
    events: [
      { begin: 3, end: 3.5, value: { note: 'g3' } },
      { begin: 2, end: 2.5, value: { note: 'e3' } },
      { begin: 2, end: 2.5, value: { note: 'c3' } },
      { begin: 2, end: 2.5, value: { s: 'bd' } },
      { begin: 3, end: 3.5, value: { note: 40 } },
    ],
  };
  const { notes } = rangeNotes(lane, 2, 3);
  assert.deepEqual(notes.map((note) => [note.start, note.note ?? note.sound]), [[2, 'c3'], [2, 'e3'], [2, 'bd'], [3, 40], [3, 'g3']]);
});

test('rangeNotes: 40 notes give 32 and more 8, the first 32 in order', () => {
  const lane = rangeLane(Array.from({ length: 40 }, (_, at) => 2 + at / 20));
  const { notes, more } = rangeNotes(lane, 2, 5);
  assert.equal(notes.length, MAX_MOMENT_NOTES);
  assert.equal(more, 8);
  assert.deepEqual(notes.map((note) => note.start), lane.events.slice(0, 32).map((event) => event.begin));
});

test('rangeNotes: a MIDI lane keeps its instrument and a drum lane names the drums, like the moment', () => {
  const midi = rangeLane([2], { midi: true, instrument: 'jx ch 1', events: [{ begin: 2, end: 2.5, value: { note: 'c3', velocity: 0.5 } }] });
  assert.deepEqual(rangeNotes(midi, 2, 2).notes, [{ track: 't1', instrument: 'jx ch 1', note: 'c3', velocity: 0.5, start: 2, end: 2.5 }]);
  const drums = rangeLane([], { drumMap: { name: 'GM', byNote: new Map([[36, 'Kick']]) }, events: [{ begin: 2, end: 2.25, value: { note: 36 } }] });
  assert.equal(rangeNotes(drums, 2, 2).notes[0].drum, 'Kick');
});

test('rangeNotes: the input is not changed, and bad input is a loud TypeError', () => {
  const lane = rangeLane([3, 2]);
  const before = JSON.stringify(lane);
  rangeNotes(lane, 2, 3);
  assert.equal(JSON.stringify(lane), before);
  assert.equal(MAX_RANGE_CYCLES, 32);
  assert.throws(() => rangeNotes(null, 0, 1), TypeError);
  assert.throws(() => rangeNotes({ track: 't' }, 0, 1), TypeError);
  assert.throws(() => rangeNotes(lane, -1, 1), TypeError);
  assert.throws(() => rangeNotes(lane, 1.5, 3), TypeError);
  assert.throws(() => rangeNotes(lane, 3, 2), TypeError);
  assert.throws(() => rangeNotes(lane, 0, 32), TypeError);
  assert.doesNotThrow(() => rangeNotes(lane, 0, 31));
});

test('a range covering the whole page is never longer than the most cycles a range may cover', () => {
  // The edit view clamps a range to the cycles of the page; the notes of a range and the server limit it to MAX_RANGE_CYCLES.
  assert.ok(PAGE_CYCLES <= MAX_RANGE_CYCLES);
});
