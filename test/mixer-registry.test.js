// Unit tests for page/mixer-registry.js: the fader scale and the one number formatter.
// No DOM, so no build step: imports the page module directly, like test/parts.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GAIN_MAX, GAIN_STEPS, DEFAULT_GAIN, DEFAULT_POSTGAIN, roundTo, positionToGain, gainToPosition, formatNumber, BUSES, BUS_IDS, SENDS, busParamById } from '../page/mixer-registry.js';
import {
  CHAIN_ORDER,
  COMPRESSOR_FIELDS,
  EFFECTS,
  EFFECT_IDS,
  METHOD_KEYS,
  MIXER_METHOD_NAMES,
  effectById,
  effectOfMethod,
  formatDisplayNumber,
  methodOf,
  MOVE_OVER_MAX,
  MOVE_OVER_MIN,
  MOVE_SHAPES,
  fixedFromMove,
  moveFromFixed,
  moveText,
  PARAM_STEPS,
  TREMOLO_HZ,
  clampToParam,
  fixedValueOf,
  positionToValue,
  roundSignificant,
  roundToParam,
  valueToPosition,
} from '../page/mixer-registry.js';

test('the fader spans 0 to 1.5 over 1000 steps and defaults to the bundle gain of 0.8', () => {
  assert.equal(GAIN_MAX, 1.5);
  assert.equal(GAIN_STEPS, 1000);
  assert.equal(DEFAULT_GAIN, 0.8);
});

test('the post-gain the fader writes has the neutral 1: the track plays as written', () => {
  assert.equal(DEFAULT_POSTGAIN, 1);
});

test('positionToGain uses a squared taper written to two decimals', () => {
  assert.equal(positionToGain(0), 0);
  assert.equal(positionToGain(1000), 1.5);
  assert.equal(positionToGain(500), 0.38);
  assert.equal(positionToGain(730), 0.8);
});

test('gainToPosition pins a gain above the top at the top and a gain of 0 at the bottom', () => {
  assert.equal(gainToPosition(0), 0);
  assert.equal(gainToPosition(0.8), 730);
  assert.equal(gainToPosition(1.5), 1000);
  assert.equal(gainToPosition(2), 1000);
  assert.equal(gainToPosition(3), 1000);
  assert.equal(gainToPosition(-1), 0);
});

test('positions round-trip through a gain as far as two decimals allow, for every position', () => {
  // A gain is written to two decimals, so one gain step (0.01) spans more than one slider step
  // where the taper is flat: about 1700 / position steps. That is the honest round-trip bound.
  for (let position = 0; position <= GAIN_STEPS; position += 1) {
    const back = gainToPosition(positionToGain(position));
    const tolerance = position < 100 ? 100 : Math.ceil(1700 / position) + 1;
    assert.ok(Math.abs(back - position) <= tolerance, `position ${position} came back as ${back}`);
  }
  // The gain itself is stable: reading a position's gain and writing it back keeps the gain.
  for (let position = 0; position <= GAIN_STEPS; position += 1) {
    const gain = positionToGain(position);
    assert.equal(positionToGain(gainToPosition(gain)), gain, `gain ${gain} at position ${position}`);
  }
  // The top and the default are exact.
  assert.equal(gainToPosition(positionToGain(1000)), 1000);
  assert.equal(gainToPosition(positionToGain(730)), 730);
});

test('the scale functions throw on a non-finite input, with a Moontide message', () => {
  for (const bad of [NaN, Infinity, -Infinity, undefined, '5']) {
    assert.throws(() => positionToGain(bad), /^Error: Moontide:/);
    assert.throws(() => gainToPosition(bad), /^Error: Moontide:/);
    assert.throws(() => roundTo(bad, 2), /^Error: Moontide:/);
  }
});

test('formatNumber writes the shortest decimal with at most three decimals and no exponent', () => {
  assert.equal(formatNumber(0.35), '0.35');
  assert.equal(formatNumber(1200), '1200');
  assert.equal(formatNumber(0.005), '0.005');
  assert.equal(formatNumber(0.0004), '0');
  assert.equal(formatNumber(0.1 + 0.2), '0.3');
  assert.equal(formatNumber(1.23456), '1.235');
  assert.equal(formatNumber(-2.5), '-2.5');
  assert.equal(formatNumber(1e-7), '0');
  assert.equal(formatNumber(123456789012345680000), '123456789012345680000');
});

test('formatNumber writes -0 as 0', () => {
  assert.equal(formatNumber(-0), '0');
  assert.equal(formatNumber(-0.0001), '0');
});

test('formatNumber throws on a non-finite value or one of 1e21 or more', () => {
  for (const bad of [NaN, Infinity, -Infinity, 1e21, -1e21, undefined]) {
    assert.throws(() => formatNumber(bad), /^Error: Moontide:/);
  }
});

test('roundTo rounds to the given decimals', () => {
  assert.equal(roundTo(0.775, 2), 0.78);
  assert.equal(roundTo(1.005, 1), 1);
  assert.equal(roundTo(2.5, 0), 3);
});

// --- The effect registry ---


test('the chain order is the fixed Strudel order and EFFECTS follows it', () => {
  assert.deepEqual(CHAIN_ORDER, ['lpf', 'hpf', 'bpf', 'vowel', 'coarse', 'crush', 'distort', 'tremolo', 'compressor', 'pan', 'phaser']);
  assert.deepEqual(EFFECTS.map((effect) => effect.id), CHAIN_ORDER);
  assert.deepEqual([...EFFECT_IDS], CHAIN_ORDER);
});

test('every effect method is a registry canonical and every parameter method writes the parameter key', () => {
  for (const effect of EFFECTS) {
    for (const method of effect.methods) {
      const meta = methodOf(method);
      assert.ok(meta, `${effect.id}: ${method} is not in METHOD_KEYS`);
      assert.equal(meta.canonical, method, `${effect.id}: ${method} must be a canonical name`);
    }
    for (const param of effect.params) {
      assert.ok(effect.methods.includes(param.method), `${effect.id}.${param.id}: method ${param.method} is not the effect's own`);
      const keys = methodOf(param.method).keys;
      // A compressor field is one key of the packed string; every other parameter is its method's first key.
      const expected = param.field === undefined ? keys[0] : keys[param.field];
      assert.equal(param.key, expected, `${effect.id}.${param.id}: key`);
      if (param.alt) assert.equal(methodOf(param.alt.method).keys[0], param.alt.key);
    }
  }
});

test('every starting value lies in its parameter range or its closed list', () => {
  for (const effect of EFFECTS) {
    for (const param of effect.params) {
      if (param.kind === 'select') {
        assert.ok(param.options.includes(param.start), `${effect.id}.${param.id}`);
      } else {
        assert.ok(param.start >= param.min && param.start <= param.max, `${effect.id}.${param.id} start ${param.start}`);
        assert.ok(param.min < param.max);
      }
    }
  }
  assert.equal(effectById('vowel').params[0].options.length, 15);
});

test('the basic flags match the UI contract', () => {
  const basic = (id) => effectById(id).params.filter((param) => param.basic).map((param) => param.id);
  assert.deepEqual(basic('lpf'), ['cutoff']);
  assert.deepEqual(basic('tremolo'), ['speed', 'depth']);
  assert.deepEqual(basic('compressor'), ['threshold', 'ratio']);
  assert.deepEqual(basic('phaser'), ['speed', 'depth']);
  assert.deepEqual(basic('distort'), ['amount']);
  assert.deepEqual(COMPRESSOR_FIELDS, ['threshold', 'ratio', 'knee', 'attack', 'release']);
});

test('effectOfMethod finds an effect by method or alias and knows no other name', () => {
  assert.equal(effectOfMethod('cutoff'), 'lpf');
  assert.equal(effectOfMethod('lpq'), 'lpf');
  assert.equal(effectOfMethod('resonance'), 'lpf');
  assert.equal(effectOfMethod('trem'), 'tremolo');
  assert.equal(effectOfMethod('tremsync'), 'tremolo');
  assert.equal(effectOfMethod('phaserrate'), 'phaser');
  assert.equal(effectOfMethod('dist'), 'distort');
  assert.equal(effectOfMethod('gain'), null);
  assert.equal(effectOfMethod('room'), null);
  assert.equal(effectOfMethod('hush'), null);
  assert.equal(effectOfMethod('constructor'), null);
  assert.equal(effectOfMethod('toString'), null);
});

test('MIXER_METHOD_NAMES holds every registry name and hush', () => {
  for (const name of Object.keys(METHOD_KEYS)) assert.ok(MIXER_METHOD_NAMES.has(name), name);
  assert.ok(MIXER_METHOD_NAMES.has('hush'));
  assert.ok(MIXER_METHOD_NAMES.has('gain') && MIXER_METHOD_NAMES.has('postgain'));
  assert.ok(!MIXER_METHOD_NAMES.has('bank'));
});

test('a plain number writes only the first key of a pack: the packs are kept in the bundle order', () => {
  assert.deepEqual(METHOD_KEYS.lpf.keys, ['cutoff', 'resonance', 'lpenv']);
  assert.deepEqual(METHOD_KEYS.ctf, METHOD_KEYS.lpf);
  assert.deepEqual(METHOD_KEYS.lpq.keys, ['resonance']);
  assert.deepEqual(METHOD_KEYS.compressor.keys, ['compressor', 'compressorRatio', 'compressorKnee', 'compressorAttack', 'compressorRelease']);
  assert.equal(METHOD_KEYS.trem.canonical, 'tremolo');
  assert.equal(METHOD_KEYS.tremsync.canonical, 'tremolosync');
});

test('formatDisplayNumber writes a real minus sign, and only for display', () => {
  assert.equal(formatDisplayNumber(-20), '−20');
  assert.equal(formatDisplayNumber(1200), '1200');
  assert.equal(formatDisplayNumber(0.5), '0.5');
  assert.equal(formatNumber(-20), '-20');
});

// --- Stored calls: the closed shape a bypass record holds ---

import { normalizeStoredCall, storedCallText } from '../page/mixer-registry.js';

test('normalizeStoredCall keeps only a closed shape: canonical method, in-range number or listed string', () => {
  assert.deepEqual(normalizeStoredCall('lpf', { method: 'lpf', value: 800, extra: 'x' }), { method: 'lpf', value: 800 });
  assert.deepEqual(normalizeStoredCall('lpf', { method: 'lpq', value: 4 }), { method: 'lpq', value: 4 });
  assert.deepEqual(normalizeStoredCall('tremolo', { method: 'tremolo', value: 6 }), { method: 'tremolo', value: 6 });
  assert.deepEqual(normalizeStoredCall('vowel', { method: 'vowel', value: 'oe' }), { method: 'vowel', value: 'oe' });
  assert.deepEqual(normalizeStoredCall('compressor', { method: 'compressor', fields: [-20, 4] }), { method: 'compressor', fields: [-20, 4] });
});

test('normalizeStoredCall refuses anything outside the registry', () => {
  const bad = [
    ['lpf', { method: 'lpf', value: 30000 }], // above the range
    ['lpf', { method: 'lpf', value: -1 }],
    ['lpf', { method: 'lpf', value: '800' }], // a string where a number belongs
    ['lpf', { method: 'lpf', value: Number.NaN }],
    ['lpf', { method: 'lpf', value: Infinity }],
    ['lpf', { method: 'cutoff', value: 800 }], // an alias, not a canonical method
    ['lpf', { method: 'crush', value: 4 }], // another effect's method
    ['lpf', { method: 'lpf' }],
    ['lpf', null],
    ['lpf', 'lpf'],
    ['reverb', { method: 'lpf', value: 800 }],
    ['vowel', { method: 'vowel', value: 'zz' }],
    ['vowel', { method: 'vowel', value: '"));evil(("' }],
    ['vowel', { method: 'vowel', value: 3 }],
    ['compressor', { method: 'compressor', fields: [] }],
    ['compressor', { method: 'compressor', fields: [-20, 4, 10, 0.005, 0.05, 1] }],
    ['compressor', { method: 'compressor', fields: [-20, 400] }],
    ['compressor', { method: 'compressor', fields: ['-20'] }],
    ['compressor', { method: 'compressor', value: -20 }],
  ];
  for (const [effect, call] of bad) assert.equal(normalizeStoredCall(effect, call), null, JSON.stringify([effect, call]));
});

test('storedCallText writes numbers through formatNumber and strings through JSON.stringify of a listed value', () => {
  assert.equal(storedCallText({ method: 'lpf', value: 800 }), '.lpf(800)');
  assert.equal(storedCallText({ method: 'lpq', value: 0.5 }), '.lpq(0.5)');
  assert.equal(storedCallText({ method: 'vowel', value: 'ae' }), '.vowel("ae")');
  assert.equal(storedCallText({ method: 'compressor', fields: [-20] }), '.compressor(-20)');
  assert.equal(storedCallText({ method: 'compressor', fields: [-20, 4] }), '.compressor("-20:4")');
  assert.equal(storedCallText({ method: 'compressor', fields: [-20, 4, 10, 0.005, 0.05] }), '.compressor("-20:4:10:0.005:0.05")');
});

// --- Parameter sliders ---

const cutoff = effectById('lpf').params[0];
const resonance = effectById('lpf').params[1];

test('a log cutoff slider spans 20 to 20000 over 1000 steps and round-trips within three significant figures', () => {
  assert.equal(PARAM_STEPS, 1000);
  assert.equal(positionToValue(cutoff, 0), 20);
  assert.equal(positionToValue(cutoff, PARAM_STEPS), 20000);
  assert.equal(valueToPosition(cutoff, 20), 0);
  assert.equal(valueToPosition(cutoff, 20000), PARAM_STEPS);
  for (const value of [20, 55, 300, 1200, 2000, 8000, 20000]) {
    const back = positionToValue(cutoff, valueToPosition(cutoff, value));
    assert.ok(Math.abs(back - value) / value < 0.01, `${value} came back as ${back}`);
  }
  assert.equal(positionToValue(cutoff, 500), roundSignificant(20 * 1000 ** 0.5, 3));
});

test('a linear slider round-trips within one step and a value above the range pins the end', () => {
  for (const value of [0, 0.5, 1, 4, 25.5, 50]) {
    assert.ok(Math.abs(positionToValue(resonance, valueToPosition(resonance, value)) - value) <= resonance.step, `${value}`);
  }
  assert.equal(valueToPosition(resonance, 500), PARAM_STEPS);
  assert.equal(valueToPosition(cutoff, 1e9), PARAM_STEPS);
});

test('clampToParam clamps both ends and roundToParam rounds like the slider', () => {
  assert.equal(clampToParam(cutoff, 5), 20);
  assert.equal(clampToParam(cutoff, 90000), 20000);
  assert.equal(clampToParam(resonance, -3), 0);
  assert.equal(roundToParam(cutoff, 1234), 1230);
  assert.equal(roundToParam(cutoff, 5), 20);
  assert.equal(roundToParam(resonance, 4.3), 4.5);
  assert.equal(roundToParam(resonance, 400), 50);
  assert.equal(roundToParam(effectById('compressor').params[3], 0.0004), 0.001);
  assert.equal(roundSignificant(12345, 3), 12300);
  assert.equal(roundSignificant(0, 3), 0);
});

test('the slider functions throw on a value that is not a finite number', () => {
  for (const bad of [Number.NaN, Infinity, '5', undefined]) {
    assert.throws(() => clampToParam(cutoff, bad), /Moontide: /);
    assert.throws(() => roundToParam(cutoff, bad), /Moontide: /);
    assert.throws(() => valueToPosition(cutoff, bad), /Moontide: /);
    assert.throws(() => positionToValue(cutoff, bad), /Moontide: /);
    assert.throws(() => roundSignificant(bad, 3), /Moontide: /);
  }
});

test('the Hz form of the tremolo speed runs 0.1 to 32 and the fixed value of a parameter is its start', () => {
  assert.deepEqual({ ...TREMOLO_HZ }, { min: 0.1, max: 32, step: 0.1 });
  assert.deepEqual(effectById('tremolo').params[0].alt, { method: 'tremolo', key: 'tremolo', unit: 'Hz', ...TREMOLO_HZ });
  assert.equal(fixedValueOf(cutoff), 2000);
  assert.equal(fixedValueOf(effectById('vowel').params[0]), 'a');
  assert.equal(fixedValueOf(effectById('tremolo').params[2]), 'sine');
  assert.equal(fixedValueOf(effectById('tremolo').params[0], true), 4);
});

// --- Filter moves ---

test('a move is one of three shapes over a whole number of cycles from 1 to 64', () => {
  assert.deepEqual(MOVE_SHAPES, ['sine', 'tri', 'saw']);
  assert.equal(MOVE_OVER_MIN, 1);
  assert.equal(MOVE_OVER_MAX, 64);
});

test('a fixed cutoff becomes a move from half to twice its value over 8 cycles, and the midpoint comes back', () => {
  const cutoff = effectById('lpf').params[0];
  assert.deepEqual(moveFromFixed(cutoff, 1000), { shape: 'sine', from: 500, to: 2000, over: 8 });
  assert.deepEqual(moveFromFixed(cutoff, 15000), { shape: 'sine', from: 7500, to: 20000, over: 8 });
  assert.deepEqual(moveFromFixed(cutoff, 30), { shape: 'sine', from: 20, to: 60, over: 8 });
  assert.equal(fixedFromMove(cutoff, { shape: 'sine', from: 400, to: 2000, over: 8 }), 1200);
});

test('a move is written as shape.range(from, to).slow(N), and only a listed shape and a whole N are written', () => {
  assert.equal(moveText({ shape: 'sine', from: 400, to: 2000, over: 8 }), 'sine.range(400, 2000).slow(8)');
  assert.equal(moveText({ shape: 'tri', from: 2000, to: 400, over: 1 }), 'tri.range(2000, 400).slow(1)');
  assert.throws(() => moveText({ shape: 'square', from: 400, to: 2000, over: 8 }), /not a filter-move shape/);
  assert.throws(() => moveText({ shape: 'sine', from: 400, to: 2000, over: 0 }), /whole number/);
});

test('a stored filter move keeps only its shape and three numbers, and is written by moveText', () => {
  const stored = { method: 'lpf', move: { shape: 'tri', from: 400, to: 2000, over: 8 } };
  assert.deepEqual(normalizeStoredCall('lpf', { ...stored, extra: 1, move: { ...stored.move, note: 'x' } }), stored);
  assert.deepEqual(normalizeStoredCall('hpf', { method: 'hpf', move: { shape: 'saw', from: 2000, to: 100, over: 64 } }), { method: 'hpf', move: { shape: 'saw', from: 2000, to: 100, over: 64 } });
  assert.deepEqual(normalizeStoredCall('bpf', { method: 'bpf', move: { shape: 'sine', from: 20, to: 20000, over: 1 } }), { method: 'bpf', move: { shape: 'sine', from: 20, to: 20000, over: 1 } });
  assert.equal(storedCallText(stored), '.lpf(tri.range(400, 2000).slow(8))');
  const bad = [
    ['lpf', { method: 'lpf', move: { shape: 'square', from: 400, to: 2000, over: 8 } }],
    ['lpf', { method: 'lpf', move: { shape: 'sine); evil(', from: 400, to: 2000, over: 8 } }],
    ['lpf', { method: 'lpf', move: { shape: 'sine', from: 400, to: 2000, over: 0 } }],
    ['lpf', { method: 'lpf', move: { shape: 'sine', from: 400, to: 2000, over: 65 } }],
    ['lpf', { method: 'lpf', move: { shape: 'sine', from: 400, to: 2000, over: 2.5 } }],
    ['lpf', { method: 'lpf', move: { shape: 'sine', from: 10, to: 2000, over: 8 } }],
    ['lpf', { method: 'lpf', move: { shape: 'sine', from: 400, to: 30000, over: 8 } }],
    ['lpf', { method: 'lpf', move: { shape: 'sine', from: '400', to: 2000, over: 8 } }],
    ['lpf', { method: 'lpf', move: { shape: 'sine', from: Number.NaN, to: 2000, over: 8 } }],
    ['lpf', { method: 'lpf', move: { shape: 'sine', from: 400, to: 2000 } }],
    ['lpf', { method: 'lpf', move: null }],
    ['lpf', { method: 'lpf', move: [] }],
    ['lpf', { method: 'lpq', move: { shape: 'sine', from: 400, to: 2000, over: 8 } }], // a parameter that cannot move
    ['crush', { method: 'crush', move: { shape: 'sine', from: 4, to: 8, over: 8 } }],
    ['vowel', { method: 'vowel', move: { shape: 'sine', from: 400, to: 2000, over: 8 } }],
    ['compressor', { method: 'compressor', move: { shape: 'sine', from: 400, to: 2000, over: 8 } }],
  ];
  for (const [effect, call] of bad) assert.equal(normalizeStoredCall(effect, call), null, JSON.stringify([effect, call]));
});

// --- Sends and buses ---

test('SENDS are the .room and .delay levels from 0 to 1, in steps of 0.01', () => {
  assert.deepEqual(Object.keys(SENDS), ['reverb', 'delay']);
  assert.equal(SENDS.reverb.method, 'room');
  assert.equal(SENDS.delay.method, 'delay');
  for (const send of Object.values(SENDS)) {
    assert.equal(send.min, 0);
    assert.equal(send.max, 1);
    assert.equal(send.step, 0.01);
    assert.equal(methodOf(send.method).keys[0], send.key);
    assert.equal(roundToParam(send, 0.304), 0.3);
    assert.equal(roundToParam(send, 2), 1);
  }
});

test('BUSES list the values shared on a bus, each written by a registry method, with the costly reverb ones flagged', () => {
  assert.deepEqual(BUS_IDS, ['reverb', 'delay']);
  assert.deepEqual(BUSES.reverb.params.map((param) => [param.id, param.method, param.costly, param.basic]), [
    ['size', 'roomsize', true, true],
    ['fade', 'roomfade', true, true],
    ['lowpass', 'roomlp', true, false],
    ['damping', 'roomdim', true, false],
  ]);
  assert.deepEqual(BUSES.delay.params.map((param) => [param.id, param.method, param.costly, param.basic]), [
    ['time', 'delaytime', false, true],
    ['feedback', 'delayfeedback', false, true],
  ]);
  for (const bus of Object.values(BUSES)) {
    assert.equal(SENDS[bus.send].id, bus.id);
    for (const param of bus.params) assert.equal(methodOf(param.method).keys[0], param.key, param.method);
  }
  assert.deepEqual(BUSES.reverb.params.map((param) => [param.min, param.max, param.strudelDefault]), [[0, 10, 2], [0, 10, 0.1], [20, 20000, 15000], [20, 20000, 1000]]);
  // The delay time is in seconds up to 1 (the DelayNode's maximum), its default comes from the tempo.
  const [time, feedback] = BUSES.delay.params;
  assert.deepEqual([time.min, time.max, time.strudelDefault], [0.01, 1, null]);
  assert.deepEqual([feedback.min, feedback.max, feedback.strudelDefault], [0, 0.95, 0.5]);
});

test('each bus says how Strudel judges an unwritten value: the reverb ignores it, the delay reads it as the default', () => {
  assert.equal(BUSES.reverb.unwrittenIsDefault, false);
  assert.equal(BUSES.delay.unwrittenIsDefault, true);
  assert.equal(busParamById('reverb', 'size').method, 'roomsize');
  assert.equal(busParamById('reverb', 'nope'), null);
  assert.equal(busParamById('toString', 'size'), null);
});
