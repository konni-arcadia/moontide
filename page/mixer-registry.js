// Pure module for the Mixer view: the fader scale (a squared taper over a native range slider),
// the one number formatter for everything the mixer writes into code or labels, and the small
// hand-written registry of the effects the mixer knows (which Strudel methods and aliases write
// which control keys, and each effect's parameters with their ranges and starting values).
// `npm run check:reference` proves every method, alias and key pack against the pinned bundle.
// No DOM access at import time, so this module can be imported directly by node:test and by
// page/main.js without a build step.

/** The top of the volume fader, in gain units. A gain above this pins the thumb at the top. */
export const GAIN_MAX = 1.5;

/** The native range slider spans 0..GAIN_STEPS in whole steps. */
export const GAIN_STEPS = 1000;

/** The pinned bundle's default gain, shown when a track has no `.gain()` of its own. */
export const DEFAULT_GAIN = 0.8;

/** The neutral of the post-gain the fader writes: 1 plays the track as written. */
export const DEFAULT_POSTGAIN = 1;

function assertFinite(value, what) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Moontide: ${what} must be a finite number, got ${String(value)}.`);
  }
}

/** Rounds `value` to `decimals` decimal places. Throws on a non-finite value. */
export function roundTo(value, decimals) {
  assertFinite(value, 'a value to round');
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** The gain a slider position (0..GAIN_STEPS) stands for: a squared taper, two decimals. */
export function positionToGain(position) {
  assertFinite(position, 'a fader position');
  return roundTo(GAIN_MAX * (position / GAIN_STEPS) ** 2, 2);
}

/** The slider position (0..GAIN_STEPS) that shows `gain`; a gain above GAIN_MAX pins the top. */
export function gainToPosition(gain) {
  assertFinite(gain, 'a gain');
  return Math.min(GAIN_STEPS, Math.round(GAIN_STEPS * Math.sqrt(Math.max(0, gain) / GAIN_MAX)));
}

/**
 * The single number formatter for everything the mixer writes into code or labels: the shortest
 * decimal with at most three decimals, never exponent notation, and `-0` written as '0'.
 * Throws on a non-finite value or one with an absolute value of 1e21 or more (where
 * `toFixed` would fall back to exponent notation).
 */
export function formatNumber(value) {
  assertFinite(value, 'a number to write');
  if (Math.abs(value) >= 1e21) {
    throw new Error(`Moontide: a number to write is too large: ${String(value)}.`);
  }
  const text = Number(value.toFixed(3)).toString();
  return text === '-0' ? '0' : text;
}

/** A number as the mixer shows it (never written to code): `formatNumber` with a real minus sign. */
export function formatDisplayNumber(value) {
  return formatNumber(value).replace(/^-/, '\u2212');
}

// --- Methods, aliases and key packs ---

/**
 * Every Strudel method and alias the mixer reads or writes, as `[canonical, aliases, keys]`. `keys`
 * is the pack the method can write: a plain number writes only the first key, a string or a
 * pattern may write every one. The bundle is the authority:
 * scripts/check-reference.mjs compares every row with the bundle's `registerControl` calls.
 */
const METHOD_PACKS = [
  ['lpf', ['cutoff', 'ctf', 'lp'], ['cutoff', 'resonance', 'lpenv']],
  ['lpq', ['resonance'], ['resonance']],
  ['hpf', ['hcutoff', 'hp'], ['hcutoff', 'hresonance', 'hpenv']],
  ['hpq', ['hresonance'], ['hresonance']],
  ['bpf', ['bandf', 'bp'], ['bandf', 'bandq', 'bpenv']],
  ['bpq', ['bandq'], ['bandq']],
  ['vowel', [], ['vowel']],
  ['coarse', [], ['coarse']],
  ['crush', [], ['crush']],
  ['distort', ['dist'], ['distort', 'distortvol', 'distorttype']],
  ['distortvol', ['distvol'], ['distortvol']],
  ['tremolo', ['trem'], ['tremolo', 'tremolodepth', 'tremoloskew', 'tremolophase']],
  ['tremolosync', ['tremsync'], ['tremolosync', 'tremolodepth', 'tremoloskew', 'tremolophase']],
  ['tremolodepth', ['tremdepth'], ['tremolodepth']],
  ['tremoloshape', ['tremshape'], ['tremoloshape']],
  ['compressor', [], ['compressor', 'compressorRatio', 'compressorKnee', 'compressorAttack', 'compressorRelease']],
  ['pan', [], ['pan']],
  ['phaser', ['ph', 'phaserrate'], ['phaserrate', 'phaserdepth', 'phasercenter', 'phasersweep']],
  ['phaserdepth', ['phd', 'phasdp'], ['phaserdepth']],
  ['phasercenter', ['phc'], ['phasercenter']],
  ['phasersweep', ['phs'], ['phasersweep']],
  ['room', [], ['room', 'size']],
  ['roomsize', ['size', 'sz', 'rsize'], ['roomsize']],
  ['roomfade', ['rfade'], ['roomfade']],
  ['roomlp', ['rlp'], ['roomlp']],
  ['roomdim', ['rdim'], ['roomdim']],
  ['delay', [], ['delay', 'delaytime', 'delayfeedback']],
  ['delaytime', ['delayt', 'dt'], ['delaytime']],
  ['delayfeedback', ['delayfb', 'dfb'], ['delayfeedback']],
  ['orbit', ['o'], ['orbit']],
  ['gain', [], ['gain']],
  ['postgain', [], ['postgain']],
];

/** Every method and alias name mapped to `{ canonical, keys }`. Look names up with methodOf(). */
export const METHOD_KEYS = Object.freeze(
  Object.fromEntries(
    METHOD_PACKS.flatMap(([canonical, aliases, keys]) =>
      [canonical, ...aliases].map((name) => [name, Object.freeze({ canonical, keys: Object.freeze([...keys]) })]),
    ),
  ),
);

/** `{ canonical, keys }` for a method or alias name, or null (own properties only). */
export function methodOf(name) {
  return Object.hasOwn(METHOD_KEYS, name) ? METHOD_KEYS[name] : null;
}

/** Every name the mixer treats as its own: the registry methods and aliases, and `.hush()`. A string
 * a call with one of these names receives never contributes to a track's identity. */
export const MIXER_METHOD_NAMES = new Set([...Object.keys(METHOD_KEYS), 'hush']);

// --- The chain effects ---

/** The order Strudel applies the eleven effects in, and the order the strip shows them. */
export const CHAIN_ORDER = ['lpf', 'hpf', 'bpf', 'vowel', 'coarse', 'crush', 'distort', 'tremolo', 'compressor', 'pan', 'phaser'];

export const EFFECT_IDS = new Set(CHAIN_ORDER);

/** The fifteen vowels the bundle accepts. */
const VOWELS = ['a', 'e', 'i', 'o', 'u', 'ae', 'aa', 'oe', 'ue', 'y', 'uh', 'un', 'en', 'an', 'on'];

/** The five compressor fields, in the order of its `threshold:ratio:knee:attack:release` string. */
export const COMPRESSOR_FIELDS = ['threshold', 'ratio', 'knee', 'attack', 'release'];

/** One number parameter. `step: null` marks a logarithmic slider that rounds to three significant figures. */
function num(id, name, method, key, unit, min, max, step, start, strudelDefault, basic, extra = {}) {
  return { id, name, method, key, unit, min, max, step, scale: step === null ? 'log' : 'linear', start, strudelDefault, basic, kind: 'number', ...extra };
}

/** One closed-list parameter. */
function pick(id, name, method, key, options, start, strudelDefault, basic) {
  return { id, name, method, key, unit: '', min: null, max: null, step: null, scale: 'linear', start, strudelDefault, basic, kind: 'select', options };
}

/**
 * The eleven effects in chain order: `{ id, name, methods, params }`. `methods` are the canonical
 * methods that belong to the effect. A parameter's `start` is the value a fresh write uses (adding
 * the effect writes only the first parameter's call); `strudelDefault` is what Strudel does when the
 * call is absent and is only ever displayed. `field` is a compressor field index (one call writes
 * all five as a string); `movable` marks a cutoff that can sweep; `alt` is the Hz form of the
 * tremolo speed (`tremolo`), which coexists with the per-cycle form (`tremolosync`).
 */
export const EFFECTS = [
  {
    id: 'lpf',
    name: 'Lowpass',
    methods: ['lpf', 'lpq'],
    params: [
      num('cutoff', 'Cutoff', 'lpf', 'cutoff', 'Hz', 20, 20000, null, 2000, null, true, { movable: true }),
      num('resonance', 'Resonance', 'lpq', 'resonance', '', 0, 50, 0.5, 1, 1, false),
    ],
  },
  {
    id: 'hpf',
    name: 'Highpass',
    methods: ['hpf', 'hpq'],
    params: [
      num('cutoff', 'Cutoff', 'hpf', 'hcutoff', 'Hz', 20, 20000, null, 300, null, true, { movable: true }),
      num('resonance', 'Resonance', 'hpq', 'hresonance', '', 0, 50, 0.5, 1, 1, false),
    ],
  },
  {
    id: 'bpf',
    name: 'Bandpass',
    methods: ['bpf', 'bpq'],
    params: [
      num('center', 'Center', 'bpf', 'bandf', 'Hz', 20, 20000, null, 1000, null, true, { movable: true }),
      num('resonance', 'Resonance', 'bpq', 'bandq', '', 0, 50, 0.5, 1, 1, false),
    ],
  },
  {
    id: 'vowel',
    name: 'Vowel',
    methods: ['vowel'],
    params: [pick('vowel', 'Vowel', 'vowel', 'vowel', VOWELS, 'a', null, true)],
  },
  {
    id: 'coarse',
    name: 'Coarse',
    methods: ['coarse'],
    params: [num('factor', 'Factor', 'coarse', 'coarse', '', 1, 16, 1, 4, 1, true)],
  },
  {
    id: 'crush',
    name: 'Crush',
    methods: ['crush'],
    params: [num('bits', 'Bits', 'crush', 'crush', '', 1, 16, 1, 8, 16, true)],
  },
  {
    id: 'distort',
    name: 'Distort',
    methods: ['distort', 'distortvol'],
    params: [
      num('amount', 'Amount', 'distort', 'distort', '', 0, 10, 0.1, 1, null, true),
      num('volume', 'Volume', 'distortvol', 'distortvol', '', 0, 2, 0.05, 1, 1, false),
    ],
  },
  {
    id: 'tremolo',
    name: 'Tremolo',
    methods: ['tremolosync', 'tremolo', 'tremolodepth', 'tremoloshape'],
    params: [
      num('speed', 'Speed', 'tremolosync', 'tremolosync', 'per cycle', 0.25, 16, 0.25, 4, null, true, {
        alt: { method: 'tremolo', key: 'tremolo', unit: 'Hz', min: 0.1, max: 32, step: 0.1 },
      }),
      num('depth', 'Depth', 'tremolodepth', 'tremolodepth', '', 0, 1, 0.05, 1, 1, true),
      pick('shape', 'Shape', 'tremoloshape', 'tremoloshape', ['sine', 'tri', 'square', 'saw', 'ramp'], 'sine', null, false),
    ],
  },
  {
    id: 'compressor',
    name: 'Compressor',
    methods: ['compressor'],
    params: [
      num('threshold', 'Threshold', 'compressor', 'compressor', 'dB', -100, 0, 1, -20, -3, true, { field: 0 }),
      num('ratio', 'Ratio', 'compressor', 'compressorRatio', '', 1, 20, 1, 4, 10, true, { field: 1 }),
      num('knee', 'Knee', 'compressor', 'compressorKnee', 'dB', 0, 40, 1, 10, 10, false, { field: 2 }),
      num('attack', 'Attack', 'compressor', 'compressorAttack', 's', 0.001, 0.2, 0.001, 0.005, 0.005, false, { field: 3 }),
      num('release', 'Release', 'compressor', 'compressorRelease', 's', 0.01, 1, 0.01, 0.05, 0.05, false, { field: 4 }),
    ],
  },
  {
    id: 'pan',
    name: 'Pan',
    methods: ['pan'],
    params: [num('position', 'Position', 'pan', 'pan', '', 0, 1, 0.01, 0.5, 0.5, true)],
  },
  {
    id: 'phaser',
    name: 'Phaser',
    methods: ['phaser', 'phaserdepth', 'phasercenter', 'phasersweep'],
    params: [
      num('speed', 'Speed', 'phaser', 'phaserrate', 'Hz', 0.1, 16, 0.1, 2, 1, true),
      num('depth', 'Depth', 'phaserdepth', 'phaserdepth', '', 0, 1, 0.05, 0.75, 0.75, true),
      num('center', 'Center', 'phasercenter', 'phasercenter', 'Hz', 100, 8000, null, 1000, 1000, false),
      num('sweep', 'Sweep', 'phasersweep', 'phasersweep', 'Hz', 0, 4000, 50, 2000, 2000, false),
    ],
  },
];

const EFFECT_BY_ID = new Map(EFFECTS.map((effect) => [effect.id, effect]));
const EFFECT_OF_CANONICAL = new Map(EFFECTS.flatMap((effect) => effect.methods.map((method) => [method, effect.id])));

/** The effect with this id. An unknown id throws (loud). */
export function effectById(id) {
  const effect = EFFECT_BY_ID.get(id);
  if (!effect) throw new Error(`Moontide: unknown mixer effect '${String(id)}'.`);
  return effect;
}

/** The id of the effect a method or alias belongs to, or null (gain, room, hush, any other name). */
export function effectOfMethod(name) {
  const meta = methodOf(name);
  return meta ? (EFFECT_OF_CANONICAL.get(meta.canonical) ?? null) : null;
}

// --- Parameter sliders: mapping, clamping and rounding ---

/** A log slider spans 0..PARAM_STEPS in whole steps (a linear slider uses its own min, max and step). */
export const PARAM_STEPS = 1000;

/** The Hz form of the tremolo speed (`.tremolo()`): a planner default, not from the bundle. */
export const TREMOLO_HZ = Object.freeze({ min: 0.1, max: 32, step: 0.1 });

/** `value` rounded to `digits` significant figures. Throws on a non-finite value. */
export function roundSignificant(value, digits) {
  assertFinite(value, 'a value to round');
  if (value === 0) return 0;
  return Number(value.toPrecision(digits));
}

/** True for a parameter (or a range like it) whose slider is logarithmic: it has no step. */
function isLog(range) {
  return range.step === null || range.scale === 'log';
}

/** `value` clamped to the range of `param` (`{ min, max }`). Throws on a non-finite value. */
export function clampToParam(param, value) {
  assertFinite(value, 'a parameter value');
  return Math.min(param.max, Math.max(param.min, value));
}

/**
 * `value` rounded the way the parameter's slider moves: to three significant figures for a
 * logarithmic parameter, to a multiple of its step for a linear one. The result stays inside the
 * range. Throws on a non-finite value.
 */
export function roundToParam(param, value) {
  assertFinite(value, 'a parameter value');
  const clamped = clampToParam(param, value);
  const rounded = isLog(param) ? roundSignificant(clamped, 3) : roundTo(Math.round(clamped / param.step) * param.step, 6);
  return clampToParam(param, rounded);
}

/** The slider position (0..PARAM_STEPS) that shows `value`: exponential for a log parameter, straight for a linear one. */
export function valueToPosition(param, value) {
  assertFinite(value, 'a parameter value');
  const clamped = clampToParam(param, value);
  const fraction = isLog(param) ? Math.log(clamped / param.min) / Math.log(param.max / param.min) : (clamped - param.min) / (param.max - param.min);
  return Math.round(PARAM_STEPS * fraction);
}

/** The value a slider position (0..PARAM_STEPS) stands for, rounded like roundToParam. */
export function positionToValue(param, position) {
  assertFinite(position, 'a slider position');
  const fraction = Math.min(PARAM_STEPS, Math.max(0, position)) / PARAM_STEPS;
  const value = isLog(param) ? param.min * (param.max / param.min) ** fraction : param.min + fraction * (param.max - param.min);
  return roundToParam(param, value);
}

/** The value "Use a fixed value" writes for `param`: its starting value (the Hz form of the tremolo
 * speed clamps it into its own range), or the Strudel default when it has no start; a select's
 * start is its first option. */
export function fixedValueOf(param, hz = false) {
  if (param.kind === 'select') return param.options[0];
  const value = param.start ?? param.strudelDefault;
  return hz && param.alt ? clampToParam(param.alt, value) : value;
}

// --- Filter moves: from, to, over N cycles ---

/** The shapes a filter move can take: the closed list the mixer writes and reads. */
export const MOVE_SHAPES = ['sine', 'tri', 'saw'];

/** A move lasts a whole number of cycles between these. */
export const MOVE_OVER_MIN = 1;
export const MOVE_OVER_MAX = 64;

/** The number of cycles a move starts with when a fixed cutoff turns into a move. */
const MOVE_OVER_START = 8;

/** The move a fixed `value` of `param` turns into: from half of it to twice it (both clamped to the
 * range, three significant figures), sine, over eight cycles. */
export function moveFromFixed(param, value) {
  assertFinite(value, 'a cutoff');
  return { shape: 'sine', from: roundToParam(param, value / 2), to: roundToParam(param, value * 2), over: MOVE_OVER_START };
}

/** The fixed value a move turns back into: the midpoint of From and To, rounded like the parameter's slider. */
export function fixedFromMove(param, move) {
  return roundToParam(param, (move.from + move.to) / 2);
}

/** The code text of a move that was already checked: `sine.range(400, 2000).slow(8)`. Numbers go
 * through formatNumber, the shape is one of MOVE_SHAPES (anything else throws), `over` a whole
 * number of cycles. */
export function moveText(move) {
  if (!MOVE_SHAPES.includes(move.shape)) throw new Error(`Moontide: '${String(move.shape)}' is not a filter-move shape.`);
  if (!Number.isInteger(move.over) || move.over < MOVE_OVER_MIN || move.over > MOVE_OVER_MAX) {
    throw new Error(`Moontide: a move lasts a whole number of cycles from ${MOVE_OVER_MIN} to ${MOVE_OVER_MAX}.`);
  }
  return `${move.shape}.range(${formatNumber(move.from)}, ${formatNumber(move.to)}).slow(${move.over})`;
}

// --- Stored calls: the closed shape a bypass record holds ---

/** A stored `{ method, move }` of a movable parameter rebuilt from its known fields, or null. */
function normalizeStoredMove(param, call) {
  const { move } = call;
  if (move === null || typeof move !== 'object' || Array.isArray(move)) return null;
  if (typeof move.shape !== 'string' || !MOVE_SHAPES.includes(move.shape)) return null;
  if (!numberIn(move.from, param.min, param.max) || !numberIn(move.to, param.min, param.max)) return null;
  if (!Number.isInteger(move.over) || move.over < MOVE_OVER_MIN || move.over > MOVE_OVER_MAX) return null;
  return { method: call.method, move: { shape: move.shape, from: move.from, to: move.to, over: move.over } };
}

/** The parameter a canonical method of `effect` writes: its own, or the Hz form of the tremolo speed. */
function paramOfMethod(effect, method) {
  return effect.params.find((param) => param.method === method || (param.alt && param.alt.method === method)) ?? null;
}

/** True for a finite number inside `[min, max]`. */
function numberIn(value, min, max) {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

/**
 * A stored call checked against the registry and rebuilt with only its known fields, or null. The
 * closed shape: `{ method, value }` (a canonical method of the effect with a finite number inside
 * its range, or a string from its closed list) or, for the compressor, `{ method: 'compressor',
 * fields }` (one to five numbers, each inside its field's range) or, for the cutoff of a filter,
 * `{ method, move: { shape, from, to, over } }` (a shape from MOVE_SHAPES, From and To inside the
 * range, Over a whole number of cycles). Nothing else is ever accepted, so nothing read from storage
 * can reach the code except numbers and listed strings.
 */
export function normalizeStoredCall(effectId, call) {
  const effect = typeof effectId === 'string' ? (EFFECT_BY_ID.get(effectId) ?? null) : null;
  if (effect === null || call === null || typeof call !== 'object' || Array.isArray(call)) return null;
  if (typeof call.method !== 'string' || !effect.methods.includes(call.method)) return null;
  if (effect.id === 'compressor') {
    const { fields } = call;
    if (!Array.isArray(fields) || fields.length < 1 || fields.length > COMPRESSOR_FIELDS.length) return null;
    if (!fields.every((value, i) => numberIn(value, effect.params[i].min, effect.params[i].max))) return null;
    return { method: 'compressor', fields: [...fields] };
  }
  const param = paramOfMethod(effect, call.method);
  if (param === null) return null;
  if (Object.hasOwn(call, 'move')) return param.movable === true ? normalizeStoredMove(param, call) : null;
  if (param.kind === 'select') {
    return typeof call.value === 'string' && param.options.includes(call.value) ? { method: call.method, value: call.value } : null;
  }
  const range = param.alt && param.alt.method === call.method ? param.alt : param;
  return numberIn(call.value, range.min, range.max) ? { method: call.method, value: call.value } : null;
}

/** The code of a stored call that normalizeStoredCall accepted: numbers through formatNumber, a
 * string through JSON.stringify of a listed value, a filter move through moveText. A compressor with
 * one field is a plain number. */
export function storedCallText(call) {
  if (call.method === 'compressor') {
    return call.fields.length === 1
      ? `.compressor(${formatNumber(call.fields[0])})`
      : `.compressor(${JSON.stringify(call.fields.map((field) => formatNumber(field)).join(':'))})`;
  }
  if (call.move) return `.${call.method}(${moveText(call.move)})`;
  return typeof call.value === 'string' ? `.${call.method}(${JSON.stringify(call.value)})` : `.${call.method}(${formatNumber(call.value)})`;
}

// --- Sends and buses ---

/**
 * The two sends every track has: the level it feeds into the shared reverb (`.room`) and delay
 * (`.delay`), 0 to 1. Shaped like a parameter so the shared clamp, round and slider helpers apply.
 * Unwritten means "not sent" (0); exactly 0 is never written (the call is removed instead).
 */
export const SENDS = Object.freeze({
  reverb: Object.freeze({ id: 'reverb', method: 'room', key: 'room', name: 'Reverb', unit: '', min: 0, max: 1, step: 0.01, scale: 'linear', kind: 'number' }),
  delay: Object.freeze({ id: 'delay', method: 'delay', key: 'delay', name: 'Delay', unit: '', min: 0, max: 1, step: 0.01, scale: 'linear', kind: 'number' }),
});

/** One bus parameter. `costly` marks a reverb parameter that makes Strudel recalculate the reverb:
 * it applies when the user lets go, never while dragging. `start` is what a slider shows when the
 * code writes nothing and Strudel's own default is not a plain number. */
function busParam(id, name, method, unit, min, max, step, strudelDefault, basic, costly, start = strudelDefault) {
  return Object.freeze({ id, name, method, key: method, unit, min, max, step, scale: step === null ? 'log' : 'linear', start, strudelDefault, basic, costly, kind: 'number' });
}

/**
 * The two buses (Strudel's orbits): `send` is the SENDS key that feeds each one and `params` the
 * values that are shared by everything on the bus. `unwrittenIsDefault` is Strudel's own rule for
 * when tracks on one bus disagree: the reverb only changes for a value
 * that is written, so an unwritten one never disagrees; the delay fills in its defaults, so an
 * unwritten time or feedback counts as the default. The delay time is read in seconds and its
 * default is derived from the tempo, so it has no plain number (`strudelDefault: null`).
 */
export const BUSES = Object.freeze({
  reverb: Object.freeze({
    id: 'reverb',
    name: 'Reverb bus',
    send: 'reverb',
    unwrittenIsDefault: false,
    params: Object.freeze([
      busParam('size', 'Size', 'roomsize', '', 0, 10, 0.1, 2, true, true),
      busParam('fade', 'Fade', 'roomfade', 's', 0, 10, 0.1, 0.1, true, true),
      busParam('lowpass', 'Lowpass', 'roomlp', 'Hz', 20, 20000, null, 15000, false, true),
      busParam('damping', 'Damping', 'roomdim', 'Hz', 20, 20000, null, 1000, false, true),
    ]),
  }),
  delay: Object.freeze({
    id: 'delay',
    name: 'Delay bus',
    send: 'delay',
    unwrittenIsDefault: true,
    params: Object.freeze([
      busParam('time', 'Time', 'delaytime', 's', 0.01, 1, 0.01, null, true, false, 0.25),
      busParam('feedback', 'Feedback', 'delayfeedback', '', 0, 0.95, 0.01, 0.5, true, false),
    ]),
  }),
});

/** The bus ids, in the order the mixer lists them. */
export const BUS_IDS = Object.freeze(Object.keys(BUSES));

/** The parameter `id` of bus `bus`, or null. */
export function busParamById(bus, id) {
  if (!Object.hasOwn(BUSES, bus)) return null;
  return BUSES[bus].params.find((param) => param.id === id) ?? null;
}
