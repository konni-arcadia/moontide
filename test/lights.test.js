// The light state, driven with fake time. Nothing here needs a browser: the clocks are numbers the test hands in. The
// lights in the real Mixer are proved by `npm run probe:page -- --only mixer`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BROWSER_LIGHT_OFFSET_MS, LIGHT_FADE_MS, LIGHT_STEPS, MAX_PENDING_NOTES, MIDI_LIGHT_OFFSET_MS, createLights, heardMapper, lightLayout, readOutputPair, usableTempo } from '../page/lights.js';
import { FRESH_PAIR_MAX_AGE_MS } from '../page/midi-clock.js';

const STEP = 1 / LIGHT_STEPS;
// In these tests an audio time in seconds is heard at that many thousand milliseconds on the page clock.
const toPerf = (target) => target * 1000;
const ON = { motion: 'on', cps: 1, toPerf };
const OFF = { motion: 'off', cps: 1, toPerf };

/** A layout of tracks `t1`.. with ids `label:t1`.., all sounding, under groups described as `{ key: [track names] }`. */
function layoutOf(names, groups = {}, silent = []) {
  const tracks = names.map((name) => ({ key: `label:${name}`, id: `label:${name}`, sounding: !silent.includes(name) }));
  const ancestors = new Map();
  for (const [group, members] of Object.entries(groups)) {
    for (const member of members) ancestors.set(`label:${member}`, [...(ancestors.get(`label:${member}`) ?? []), group]);
  }
  return { tracks, ancestors };
}

function lightsOf(names, groups, silent) {
  const lights = createLights();
  lights.setLayout(layoutOf(names, groups, silent));
  return lights;
}

const byId = (changes) => new Map(changes.map((change) => [`${change.kind}:${change.id}`, change.value]));

test('the constants start where the page tunes them', () => {
  assert.equal(LIGHT_FADE_MS, 180);
  assert.equal(BROWSER_LIGHT_OFFSET_MS, 0);
  assert.equal(MIDI_LIGHT_OFFSET_MS, 0);
  assert.equal(LIGHT_STEPS, 64);
  assert.equal(MAX_PENDING_NOTES, 256);
});

// --- the tempo and the output timestamp the page hands in ---

test('usableTempo accepts a number above 0 and nothing else, so the page can skip a frame at tempo 0', () => {
  assert.equal(usableTempo(0.5), true);
  assert.equal(usableTempo(2), true);
  for (const cps of [0, -1, Number.NaN, Infinity, undefined, null, '1']) assert.equal(usableTempo(cps), false, String(cps));
  // frame() itself still refuses it: the page checks first.
  assert.throws(() => createLights().frame(0, { motion: 'on', cps: 0, toPerf }), /tempo above 0/);
});

test('readOutputPair reads the timestamp when the context has the method and gives null when it has not', () => {
  const pair = { contextTime: 1, performanceTime: 2 };
  assert.equal(readOutputPair({ getOutputTimestamp: () => pair }), pair);
  assert.equal(readOutputPair({}), null);
  assert.equal(readOutputPair({ getOutputTimestamp: undefined }), null);
  // A missing pair is the fallback the mapper already has: the context clock plus both latencies.
  const map = heardMapper({ pair: readOutputPair({}), currentTime: 20, baseLatency: 0.005, outputLatency: 0.025, perfNow: 9000 });
  assert.equal(map(20.5), 9000 + 500 + 30 + BROWSER_LIGHT_OFFSET_MS);
  // A method that throws is not hidden.
  assert.throws(() => readOutputPair({ getOutputTimestamp: () => { throw new Error('boom'); } }), /boom/);
});

// --- heardMapper ---

test('heardMapper maps an audio time through a fresh output timestamp', () => {
  const map = heardMapper({ pair: { contextTime: 10, performanceTime: 5000 }, currentTime: 11, baseLatency: 0.01, outputLatency: 0.02, perfNow: 5040 });
  assert.equal(map(10), 5000);
  assert.equal(map(10.5), 5500);
});

test('heardMapper falls back to the context clock plus both latencies for a pair of zeros, an old pair and a missing pair', () => {
  const fallback = (pair, perfNow = 9000) => heardMapper({ pair, currentTime: 20, baseLatency: 0.005, outputLatency: 0.025, perfNow })(20.5);
  // 9000 + 0.5 s + 30 ms
  assert.equal(fallback({ contextTime: 0, performanceTime: 0 }), 9530);
  assert.equal(fallback({ contextTime: 10, performanceTime: 9000 - FRESH_PAIR_MAX_AGE_MS }), 9530);
  assert.equal(fallback({ contextTime: 10, performanceTime: 9000 - FRESH_PAIR_MAX_AGE_MS - 1 }), 9530);
  assert.equal(fallback(null), 9530);
  // A pair just inside the age limit is still used.
  assert.equal(fallback({ contextTime: 20, performanceTime: 9000 - FRESH_PAIR_MAX_AGE_MS + 1 }), 9000 - FRESH_PAIR_MAX_AGE_MS + 1 + 500);
});

test('heardMapper counts a missing latency as 0', () => {
  const map = heardMapper({ pair: { contextTime: 0, performanceTime: 0 }, currentTime: 20, baseLatency: 0.005, perfNow: 9000 });
  assert.equal(map(20), 9005);
  const none = heardMapper({ pair: null, currentTime: 20, perfNow: 9000 });
  assert.equal(none(20), 9000);
});

test('heardMapper refuses a page clock or an audio clock that is not a number', () => {
  assert.throws(() => heardMapper({ pair: null, currentTime: 1, perfNow: Number.NaN }), /^Error: Moontide:/);
  assert.throws(() => heardMapper({ pair: null, currentTime: undefined, perfNow: 1 }), /^Error: Moontide:/);
});

// --- one track ---

test('a browser note lights in the frame at its heard time, not in the frame before, and falls to dark over 180 ms', () => {
  const lights = lightsOf(['t1']);
  lights.noteSeen('label:t1', { target: 1 });
  assert.deepEqual(lights.frame(999, ON), []);
  assert.deepEqual(lights.frame(1000, ON), [{ kind: 'track', id: 'label:t1', value: 1 }]);
  const mid = lights.frame(1090, ON);
  assert.equal(mid.length, 1);
  assert.ok(Math.abs(mid[0].value - 0.5) <= STEP);
  assert.deepEqual(lights.frame(1180, ON), [{ kind: 'track', id: 'label:t1', value: 0 }]);
  assert.deepEqual(lights.frame(1200, ON), []);
});

test('a note heard before the frame lights in that frame at full strength', () => {
  const lights = lightsOf(['t1']);
  lights.noteSeen('label:t1', { target: 1 });
  assert.deepEqual(lights.frame(1012, ON), [{ kind: 'track', id: 'label:t1', value: 1 }]);
});

test('a note that arrives while the light fades starts it over at full strength', () => {
  const lights = lightsOf(['t1']);
  lights.noteSeen('label:t1', { at: 1000 });
  lights.frame(1000, ON);
  lights.frame(1100, ON);
  lights.noteSeen('label:t1', { at: 1110 });
  assert.deepEqual(lights.frame(1120, ON), [{ kind: 'track', id: 'label:t1', value: 1 }]);
  assert.ok(lights.frame(1200, ON)[0].value > 0.5);
});

test('a frame that changes nothing returns an empty list', () => {
  const lights = lightsOf(['t1']);
  assert.deepEqual(lights.frame(10, ON), []);
  lights.noteSeen('label:t1', { at: 10 });
  lights.frame(10, ON);
  // The same ts again: the value is the same, so nothing is returned.
  assert.deepEqual(lights.frame(10, ON), []);
});

test('a MIDI note given as the time its port got lights at that time', () => {
  const lights = lightsOf(['t1']);
  lights.noteSeen('label:t1', { at: 2500 });
  assert.deepEqual(lights.frame(2499, ON), []);
  assert.deepEqual(lights.frame(2500, ON), [{ kind: 'track', id: 'label:t1', value: 1 }]);
});

test('two notes of one track heard in one frame give one change', () => {
  const lights = lightsOf(['t1']);
  lights.noteSeen('label:t1', { at: 100 });
  lights.noteSeen('label:t1', { at: 105 });
  assert.deepEqual(lights.frame(110, ON), [{ kind: 'track', id: 'label:t1', value: 1 }]);
});

test('two tracks whose notes are heard together both light in that frame', () => {
  const lights = lightsOf(['t1', 't2']);
  lights.noteSeen('label:t1', { at: 100 });
  lights.noteSeen('label:t2', { target: 0.1 });
  const changes = byId(lights.frame(100, ON));
  assert.equal(changes.get('track:label:t1'), 1);
  assert.equal(changes.get('track:label:t2'), 1);
});

test('notes of one track that arrive out of heard order each light in their own frame', () => {
  const lights = lightsOf(['t1']);
  lights.noteSeen('label:t1', { at: 100 });
  lights.noteSeen('label:t1', { at: 50 });
  assert.deepEqual(lights.frame(60, ON), [{ kind: 'track', id: 'label:t1', value: 1 }]);
  const fading = lights.frame(90, ON);
  assert.equal(fading.length, 1);
  assert.ok(fading[0].value < 1);
  // The later note was kept and lights in the frame it is heard in.
  assert.deepEqual(lights.frame(100, ON), [{ kind: 'track', id: 'label:t1', value: 1 }]);
});

test('a note for a key the Mixer does not show, and a note with no layout, are ignored', () => {
  const lights = lightsOf(['t1']);
  lights.noteSeen('label:nothing', { at: 1 });
  assert.deepEqual(lights.frame(10, ON), []);
  const bare = createLights();
  bare.noteSeen('label:t1', { at: 1 });
  assert.deepEqual(bare.frame(10, ON), []);
});

test('a note needs a heard time that is a number', () => {
  const lights = lightsOf(['t1']);
  assert.throws(() => lights.noteSeen('label:t1', {}), /^Error: Moontide:/);
  assert.throws(() => lights.noteSeen('label:t1', { at: Number.NaN }), /^Error: Moontide:/);
  assert.throws(() => lights.noteSeen('label:t1', { target: 'soon' }), /^Error: Moontide:/);
  assert.throws(() => lights.noteSeen('label:t1', null), /^Error: Moontide:/);
});

test('a frame refuses a time that is not a number, a motion other than on or off, a tempo that is not above 0, and a missing toPerf', () => {
  const lights = lightsOf(['t1']);
  assert.throws(() => lights.frame(Number.NaN, ON), /^Error: Moontide:/);
  assert.throws(() => lights.frame(Infinity, ON), /^Error: Moontide:/);
  assert.throws(() => lights.frame('1', ON), /^Error: Moontide:/);
  assert.throws(() => lights.frame(1, { ...ON, motion: 'fast' }), /^Error: Moontide:/);
  assert.throws(() => lights.frame(1, { ...ON, motion: undefined }), /^Error: Moontide:/);
  assert.throws(() => lights.frame(1, { ...ON, cps: 0 }), /^Error: Moontide:/);
  assert.throws(() => lights.frame(1, { ...ON, cps: -1 }), /^Error: Moontide:/);
  assert.throws(() => lights.frame(1, { ...ON, cps: Number.NaN }), /^Error: Moontide:/);
  assert.throws(() => lights.frame(1, { motion: 'on', cps: 1 }), /^Error: Moontide:/);
  assert.throws(() => lights.frame(1), /^Error: Moontide:/);
});

test('a toPerf that gives no number is refused loudly', () => {
  const lights = lightsOf(['t1']);
  lights.noteSeen('label:t1', { target: 1 });
  assert.throws(() => lights.frame(10, { ...ON, toPerf: () => Number.NaN }), /^Error: Moontide:/);
});

test('a track keeps at most 256 waiting notes, the oldest going first', () => {
  const lights = lightsOf(['t1']);
  for (let i = 0; i < 300; i++) lights.noteSeen('label:t1', { at: i });
  // The 44 oldest (heard at 0 to 43) are gone: nothing is due at 43, the note heard at 44 is.
  assert.deepEqual(lights.frame(43, ON), []);
  assert.deepEqual(lights.frame(44, ON), [{ kind: 'track', id: 'label:t1', value: 1 }]);
});

// --- groups ---

test('a group lights in the same frame as any of its tracks, and nested groups all light', () => {
  const lights = lightsOf(['t1', 't2', 't3'], { outer: ['t1', 't2'], inner: ['t1'] });
  lights.noteSeen('label:t1', { at: 10 });
  const first = byId(lights.frame(10, ON));
  assert.equal(first.get('track:label:t1'), 1);
  assert.equal(first.get('group:outer'), 1);
  assert.equal(first.get('group:inner'), 1);
  assert.equal(first.has('track:label:t2'), false);
  lights.noteSeen('label:t2', { at: 100 });
  const second = byId(lights.frame(100, ON));
  assert.equal(second.get('track:label:t2'), 1);
  // The outer group was at full strength and still is (t2 took over from t1): no change to write.
  assert.equal(second.has('group:outer'), false);
  // The inner group holds only t1, which kept fading: it falls with t1, not with t2.
  assert.ok(second.get('group:inner') < 1);
});

test("a group's value is the highest of its sounding tracks, and it falls when the brighter one has gone dark", () => {
  const lights = lightsOf(['t1', 't2'], { g: ['t1', 't2'] });
  lights.noteSeen('label:t1', { at: 0 });
  lights.frame(0, ON);
  lights.noteSeen('label:t2', { at: 90 });
  const changes = byId(lights.frame(90, ON));
  // t2 is at full strength, so the group stays at full strength: no change to write.
  assert.equal(changes.has('group:g'), false);
  assert.ok(Math.abs(changes.get('track:label:t1') - 0.5) <= STEP);
  const later = byId(lights.frame(180, ON));
  // t1 is dark, t2 has fallen to 0.5: the group follows t2.
  assert.equal(later.get('track:label:t1'), 0);
  assert.ok(Math.abs(later.get('group:g') - 0.5) <= STEP);
  const end = byId(lights.frame(270, ON));
  assert.equal(end.get('group:g'), 0);
  assert.equal(end.get('track:label:t2'), 0);
});

test('a group with no sounding track stays unlit while the rest of the Mixer lights', () => {
  const lights = lightsOf(['t1', 't2', 't3'], { quiet: ['t1', 't2'], loud: ['t3'] }, ['t1', 't2']);
  lights.noteSeen('label:t1', { at: 1 });
  lights.noteSeen('label:t2', { at: 1 });
  lights.noteSeen('label:t3', { at: 1 });
  const changes = byId(lights.frame(5, ON));
  assert.equal(changes.get('track:label:t3'), 1);
  assert.equal(changes.get('group:loud'), 1);
  assert.equal(changes.has('track:label:t1'), false);
  assert.equal(changes.has('group:quiet'), false);
});

test('a layout that turns a track silent drops its waiting notes and its light reads unlit at the next frame', () => {
  const lights = lightsOf(['t1'], { g: ['t1'] });
  lights.noteSeen('label:t1', { at: 0 });
  lights.frame(0, ON);
  lights.noteSeen('label:t1', { at: 50 });
  lights.setLayout(layoutOf(['t1'], { g: ['t1'] }, ['t1']));
  const changes = byId(lights.frame(60, ON));
  assert.equal(changes.get('track:label:t1'), 0);
  assert.equal(changes.get('group:g'), 0);
  // The dropped note never lights, and a note for the silent track is ignored.
  lights.noteSeen('label:t1', { at: 70 });
  assert.deepEqual(lights.frame(80, ON), []);
  // Back to sounding: only notes that come now count.
  lights.setLayout(layoutOf(['t1'], { g: ['t1'] }));
  assert.deepEqual(lights.frame(90, ON), []);
  lights.noteSeen('label:t1', { at: 95 });
  assert.equal(lights.frame(100, ON).length, 2);
});

test('a track that leaves the layout goes dark and its group with it', () => {
  const lights = lightsOf(['t1', 't2'], { g: ['t1', 't2'] });
  lights.noteSeen('label:t1', { at: 0 });
  lights.frame(0, ON);
  lights.setLayout(layoutOf(['t2'], { g: ['t2'] }));
  const changes = byId(lights.frame(10, ON));
  assert.equal(changes.get('track:label:t1'), 0);
  assert.equal(changes.get('group:g'), 0);
});

test('an empty layout returns no change', () => {
  const lights = createLights();
  lights.setLayout({ tracks: [], ancestors: new Map() });
  assert.deepEqual(lights.frame(10, ON), []);
});

test('a layout that is not a layout is refused', () => {
  const lights = createLights();
  assert.throws(() => lights.setLayout(null), /^Error: Moontide:/);
  assert.throws(() => lights.setLayout({ tracks: [] }), /^Error: Moontide:/);
});

test('40 tracks under 8 groups with 5 notes a frame cost under 0.2 ms a frame', () => {
  const names = Array.from({ length: 40 }, (_, i) => `t${i}`);
  const groups = {};
  names.forEach((name, i) => {
    (groups[`g${i % 8}`] ??= []).push(name);
  });
  const lights = lightsOf(names, groups);
  const frames = 3000;
  let changes = 0;
  const started = performance.now();
  for (let frame = 0; frame < frames; frame++) {
    const ts = frame * 16.7;
    for (let k = 0; k < 5; k++) lights.noteSeen(`label:t${(frame * 5 + k) % 40}`, { at: ts - 2 });
    changes += lights.frame(ts, ON).length;
  }
  const perFrame = (performance.now() - started) / frames;
  assert.ok(changes > 0);
  assert.ok(perFrame < 0.2, `a frame took ${perFrame.toFixed(3)} ms`);
});

// --- motion off ---

test('with motion off a light is lit from the frame a note is heard until one cycle after, then unlit', () => {
  const lights = lightsOf(['t1'], { g: ['t1'] });
  lights.noteSeen('label:t1', { at: 100 });
  assert.deepEqual(lights.frame(99, OFF), []);
  const lit = byId(lights.frame(100, OFF));
  assert.equal(lit.get('track:label:t1'), 1);
  assert.equal(lit.get('group:g'), 1);
  // Steady: nothing changes while it stays lit.
  assert.deepEqual(lights.frame(600, OFF), []);
  assert.deepEqual(lights.frame(1100, OFF), []);
  const dark = byId(lights.frame(1101, OFF));
  assert.equal(dark.get('track:label:t1'), 0);
  assert.equal(dark.get('group:g'), 0);
  // A faster tempo shortens the cycle.
  lights.noteSeen('label:t1', { at: 2000 });
  lights.frame(2000, { ...OFF, cps: 4 });
  assert.deepEqual(lights.frame(2250, { ...OFF, cps: 4 }), []);
  assert.equal(byId(lights.frame(2251, { ...OFF, cps: 4 })).get('track:label:t1'), 0);
});

test('with motion off a second note keeps the light lit for one more cycle and never flickers', () => {
  const lights = lightsOf(['t1']);
  lights.noteSeen('label:t1', { at: 0 });
  lights.frame(0, OFF);
  lights.noteSeen('label:t1', { at: 800 });
  assert.deepEqual(lights.frame(800, OFF), []);
  assert.deepEqual(lights.frame(1500, OFF), []);
  assert.equal(byId(lights.frame(1801, OFF)).get('track:label:t1'), 0);
});

test('with motion off a mute clears the light at the next frame, not at the end of the cycle', () => {
  const lights = lightsOf(['t1'], { g: ['t1'] });
  lights.noteSeen('label:t1', { at: 0 });
  lights.frame(0, OFF);
  lights.setLayout(layoutOf(['t1'], { g: ['t1'] }, ['t1']));
  const changes = byId(lights.frame(10, OFF));
  assert.equal(changes.get('track:label:t1'), 0);
  assert.equal(changes.get('group:g'), 0);
});

test('reset forgets every waiting note and every lit light', () => {
  const lights = lightsOf(['t1'], { g: ['t1'] });
  lights.noteSeen('label:t1', { at: 0 });
  lights.frame(0, ON);
  lights.noteSeen('label:t1', { at: 500 });
  lights.reset();
  assert.deepEqual(lights.frame(10, ON), []);
  // The waiting note is gone: nothing lights when its time comes.
  assert.deepEqual(lights.frame(600, ON), []);
  assert.deepEqual(lights.frame(700, OFF), []);
});

test('when the strip that owns a shared key changes while its light is lit, the old strip goes dark and the new one shows the value in that frame', () => {
  const lights = createLights();
  const shared = (soundingId) => ({
    tracks: [
      { key: 'label:hats', id: 'label:hats', sounding: soundingId === 'label:hats' },
      { key: 'label:hats', id: 'label:hats_', sounding: soundingId === 'label:hats_' },
    ],
    ancestors: new Map(),
  });
  lights.setLayout(shared('label:hats'));
  lights.noteSeen('label:hats', { at: 0 });
  assert.deepEqual(lights.frame(0, ON), [{ kind: 'track', id: 'label:hats', value: 1 }]);
  lights.setLayout(shared('label:hats_'));
  lights.noteSeen('label:hats', { at: 40 });
  const changes = lights.frame(40, ON);
  assert.deepEqual(changes, [
    { kind: 'track', id: 'label:hats', value: 0 },
    { kind: 'track', id: 'label:hats_', value: 1 },
  ]);
  // Nothing is left lit on the old strip afterwards.
  assert.deepEqual(lights.frame(60, ON).filter((change) => change.id === 'label:hats'), []);
});

test('forgetShown makes the next frame give every lit value again, groups included, and a frame with nothing lit gives no change', () => {
  const lights = lightsOf(['t1'], { g: ['t1'] });
  assert.deepEqual(lights.frame(0, ON), []);
  lights.forgetShown();
  assert.deepEqual(lights.frame(1, ON), []);
  lights.noteSeen('label:t1', { at: 10 });
  const first = lights.frame(10, ON);
  assert.deepEqual([...byId(first)], [['track:label:t1', 1], ['group:g', 1]]);
  assert.deepEqual(lights.frame(10, ON), []);
  lights.forgetShown();
  assert.deepEqual([...byId(lights.frame(10, ON))], [['track:label:t1', 1], ['group:g', 1]]);
  // The note state stays: the light still falls on schedule.
  assert.deepEqual(lights.frame(190, ON), [{ kind: 'track', id: 'label:t1', value: 0 }, { kind: 'group', id: 'g', value: 0 }]);
});

test('forgetShown in the middle of a fade still darkens the strip and its group once the fade ends', () => {
  const lights = lightsOf(['t1'], { g: ['t1'] });
  lights.noteSeen('label:t1', { at: 0 });
  assert.deepEqual([...byId(lights.frame(0, ON))], [['track:label:t1', 1], ['group:g', 1]]);
  const mid = lights.frame(100, ON);
  assert.ok(mid.length > 0 && mid.every((change) => change.value > 0 && change.value < 1));
  // The view rebuilt some other strip here, while this light is still partly lit.
  lights.forgetShown();
  // The fade ends in the next frame: the light must go dark, not stay at its last written value.
  assert.deepEqual([...byId(lights.frame(400, ON))], [['track:label:t1', 0], ['group:g', 0]]);
  assert.deepEqual(lights.frame(500, ON), []);
});

test('playsMidi tells whether the strip that owns a key plays MIDI, and is false for a browser track and for an unknown key', () => {
  const lights = createLights();
  assert.equal(lights.playsMidi('label:a'), false);
  lights.setLayout({
    tracks: [
      { key: 'label:a', id: 'label:a', sounding: true, midi: true },
      { key: 'label:b', id: 'label:b', sounding: true, midi: false },
      { key: 'label:c', id: 'label:c', sounding: true },
    ],
    ancestors: new Map(),
  });
  assert.equal(lights.playsMidi('label:a'), true);
  assert.equal(lights.playsMidi('label:b'), false);
  assert.equal(lights.playsMidi('label:c'), false);
  assert.equal(lights.playsMidi('label:none'), false);
  assert.equal(lights.playsMidi(undefined), false);
});

// --- lightLayout ---

const strip = (identity, extra = {}) => ({ identity, lightKey: identity, sounding: true, midi: null, playsMidi: false, ...extra });

test('lightLayout has one entry for every strip with a light key, and none for a strip without one', () => {
  const model = { status: 'ready', strips: [strip('label:t1'), strip('unnamed:1', { lightKey: null }), strip('label:t3', { sounding: false })], layout: null };
  const { tracks, ancestors } = lightLayout(model, { webMidi: true });
  assert.deepEqual(tracks, [
    { key: 'label:t1', id: 'label:t1', sounding: true, midi: false },
    { key: 'label:t3', id: 'label:t3', sounding: false, midi: false },
  ]);
  assert.equal(ancestors.size, 0);
});

test('lightLayout says which strips play MIDI', () => {
  const model = { status: 'ready', strips: [strip('label:a', { midi: { port: 'x' } }), strip('label:b', { playsMidi: true }), strip('label:c')], layout: null };
  assert.deepEqual(lightLayout(model, { webMidi: true }).tracks.map((track) => track.midi), [true, true, false]);
});

test('lightLayout counts a MIDI strip as not sounding when the browser has no Web MIDI', () => {
  const model = {
    status: 'ready',
    strips: [strip('label:a', { midi: { port: 'x' } }), strip('label:b', { playsMidi: true }), strip('label:c')],
    layout: null,
  };
  assert.deepEqual(lightLayout(model, { webMidi: false }).tracks.map((track) => track.sounding), [false, false, true]);
  assert.deepEqual(lightLayout(model, { webMidi: true }).tracks.map((track) => track.sounding), [true, true, true]);
});

test('lightLayout gives each track every group above it, outermost first', () => {
  const model = {
    status: 'ready',
    strips: [strip('label:t1'), strip('label:t2'), strip('label:t3')],
    layout: {
      groups: [
        { key: '["a"]', members: ['label:t1', 'label:t2'] },
        { key: '["a","b"]', members: ['label:t2'] },
      ],
    },
  };
  const { ancestors } = lightLayout(model, { webMidi: true });
  assert.deepEqual(ancestors.get('label:t1'), ['["a"]']);
  assert.deepEqual(ancestors.get('label:t2'), ['["a"]', '["a","b"]']);
  assert.equal(ancestors.has('label:t3'), false);
});

test('lightLayout of a model that is not ready is empty', () => {
  for (const model of [{ status: 'empty', strips: [] }, { status: 'unreadable', strips: [] }, null]) {
    const { tracks, ancestors } = lightLayout(model, { webMidi: true });
    assert.equal(tracks.length, 0);
    assert.equal(ancestors.size, 0);
  }
});
