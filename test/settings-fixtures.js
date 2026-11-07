// Neutral fixtures shared by the tests and `npm run probe:midi`: instrument models with a settings description,
// named after no real device. Each call returns a new object, so a test may change it freely.

const roland = (address, size) => ({ kind: 'roland-dt1', address, size });

/** An instrument whose settings are Roland data sets, with two engines; the tone settings belong to the first one. */
export function toneSynthModel() {
  const tone = (name, address, size, min, max) => ({ name, min, max, engines: ['model'], message: roland(address, size) });
  return {
    id: 'tonesynth',
    name: 'Tone Synth',
    channels: { melodic: [1, 2, 3, 4], rhythm: [5] },
    bankSelect: 'msb-lsb',
    rhythmBank: true,
    defaultVolume: 100,
    controls: [],
    sounds: {
      melodic: [{ name: 'Own Tone', program: 0, bank: { msb: 97, lsb: 64 } }],
      rhythm: [{ name: 'Own Kit', program: 0, bank: { msb: 97, lsb: 65 } }],
    },
    notes: ['Fixture for tests: settings are Roland data sets.'],
    settings: {
      engines: [
        { id: 'model', name: 'Model Engine' },
        { id: 'core', name: 'Core Engine' },
      ],
      rolandModel: '00 00 00 65',
      tone: [
        tone('filterCutoff', '02 10 00 4F', 4, 0, 1023),
        tone('filterResonance', '02 10 00 53', 4, 0, 1023),
        tone('osc1Wave', '02 10 00 11', 4, 0, 27),
        tone('env1Attack', '02 10 00 68', 4, 0, 1023),
        tone('lfoOscDepth', '02 10 00 0B', 2, 28, 228),
      ],
      part: [
        { name: 'level', min: 0, max: 127, message: roland('01 00 10 05', 1) },
        { name: 'pan', min: 0, max: 127, message: roland('01 00 10 06', 1) },
      ],
      scene: [
        { name: 'reverbLevel', min: 0, max: 127, message: roland('01 00 52 02', 1) },
        { name: 'chorusSwitch', min: 0, max: 1, message: roland('01 00 50 00', 1) },
      ],
    },
  };
}

/**
 * The sound list for the tone synth: two sounds each placed in an engine by their bank, and one in no engine.
 * The own sound of the model (bank 97/64) is in the first engine too.
 */
export function toneSynthCatalog() {
  return {
    model: 'tonesynth',
    source: 'Test sound list',
    engines: [
      { engine: 'model', banks: [{ msb: 97, lsb: 64 }] },
      { engine: 'core', banks: [{ msb: 87, lsb: 64 }] },
    ],
    sounds: [
      { name: 'Model Tone', program: 0, bank: { msb: 97, lsb: 64 } },
      { name: 'Core Tone', program: 0, bank: { msb: 87, lsb: 64 } },
      { name: 'Loose Tone', program: 0, bank: { msb: 71, lsb: 3 } },
    ],
  };
}

/**
 * An instrument with three engines whose rows sit at the documented addresses of a multi-engine synth: two engines share the
 * names filterCutoff and filterResonance at their own addresses (one row per engine), and one engine has two names of its own.
 */
export function engineSynthModel() {
  const tone = (name, address, size, min, max, engines) => ({ name, min, max, engines, message: roland(address, size) });
  return {
    id: 'enginesynth',
    name: 'Engine Synth',
    channels: { melodic: [1, 2, 3, 4], rhythm: [5] },
    bankSelect: 'msb-lsb',
    rhythmBank: true,
    defaultVolume: 100,
    controls: [],
    sounds: {
      melodic: [{ name: 'Own Tone', program: 0, bank: { msb: 97, lsb: 64 } }],
      rhythm: [{ name: 'Own Kit', program: 0, bank: { msb: 97, lsb: 65 } }],
    },
    notes: ['Fixture for tests: three engines, one row per engine for a shared name.'],
    settings: {
      engines: [
        { id: 'model', name: 'Model Engine' },
        { id: 'core', name: 'Core Engine' },
        { id: 'vintage', name: 'Vintage Engine' },
      ],
      rolandModel: '00 00 00 65',
      tone: [
        tone('filterCutoff', '02 10 00 4F', 4, 0, 1023, ['model']),
        tone('filterResonance', '02 10 00 53', 4, 0, 1023, ['model']),
        tone('partial1Cutoff', '02 00 20 32', 4, 0, 1023, ['core']),
        tone('toneCoarseTune', '02 00 00 18', 1, 16, 112, ['core']),
        tone('filterCutoff', '02 50 01 42', 4, 0, 1023, ['vintage']),
        tone('filterResonance', '02 50 01 46', 4, 0, 1023, ['vintage']),
      ],
      part: [{ name: 'level', min: 0, max: 127, message: roland('01 00 10 05', 1) }],
    },
  };
}

/** The sound list for the engine synth: one sound in each of its three engines, told apart by their banks. */
export function engineSynthCatalog() {
  return {
    model: 'enginesynth',
    source: 'Test sound list',
    engines: [
      { engine: 'model', banks: [{ msb: 97, lsb: 64 }] },
      { engine: 'core', banks: [{ msb: 87, lsb: 78 }] },
      { engine: 'vintage', banks: [{ msb: 97, lsb: 81 }] },
    ],
    sounds: [
      { name: 'Model Tone', program: 0, bank: { msb: 97, lsb: 64 } },
      { name: 'Core Tone', program: 60, bank: { msb: 87, lsb: 78 } },
      { name: 'Vintage Tone', program: 72, bank: { msb: 97, lsb: 81 } },
    ],
  };
}

/**
 * A neutral instrument whose part settings are the NRPN offsets of a GS-style family: melodic channels 1 to 9 and 11 to 16, a
 * rhythm channel 10, no engines. Each row is one of the eight part offsets (data 14 to 114, 64 means no change) at the MSB and
 * LSB pair of the family's table.
 */
export function offsetSynthModel() {
  const offset = (name, lsb) => ({ name, min: 14, max: 114, message: { kind: 'nrpn', msb: 1, lsb } });
  return {
    id: 'offsetsynth',
    name: 'Offset Synth',
    channels: { melodic: [1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 14, 15, 16], rhythm: [10] },
    bankSelect: 'msb',
    defaultVolume: 100,
    controls: [],
    sounds: {
      melodic: [{ name: 'Own Tone', program: 5, bank: { msb: 8 } }],
      rhythm: [{ name: 'Own Kit', program: 16 }],
    },
    notes: ['Fixture for tests: part settings are NRPN offsets of a GS-style family.'],
    settings: {
      nrpnFamily: 'gs',
      part: [
        offset('vibratoRateOffset', 0x08),
        offset('vibratoDepthOffset', 0x09),
        offset('vibratoDelayOffset', 0x0a),
        offset('cutoffOffset', 0x20),
        offset('resonanceOffset', 0x21),
        offset('attackOffset', 0x63),
        offset('decayOffset', 0x64),
        offset('releaseOffset', 0x66),
      ],
    },
  };
}

/**
 * An instrument whose settings are control changes and an NRPN of the GS-style family, with no engines: the same names, another
 * message kind.
 */
export function ccSynthModel() {
  return {
    id: 'ccsynth',
    name: 'CC Synth',
    channels: { melodic: [1], rhythm: [] },
    bankSelect: 'none',
    defaultVolume: 100,
    controls: [],
    sounds: { melodic: [{ name: 'Own Tone', program: 0 }], rhythm: [] },
    notes: ['Fixture for tests: settings are control changes and an NRPN.'],
    settings: {
      nrpnFamily: 'gs',
      tone: [
        { name: 'filterCutoff', min: 0, max: 127, message: { kind: 'cc', cc: 74 } },
        { name: 'filterResonance', min: 0, max: 127, message: { kind: 'cc', cc: 71 } },
        { name: 'env1Attack', min: 14, max: 114, message: { kind: 'nrpn', msb: 1, lsb: 99 } },
      ],
      part: [{ name: 'level', min: 0, max: 127, message: { kind: 'cc', cc: 7 } }],
    },
  };
}

/**
 * An instrument whose part level row points into an area that keeps its data for good (a user area), under the
 * Roland model ID the tone synth uses: a valid description that must never be sent.
 */
export function memorySynthModel() {
  return {
    id: 'memorysynth',
    name: 'Memory Synth',
    channels: { melodic: [1], rhythm: [] },
    bankSelect: 'none',
    defaultVolume: 100,
    controls: [],
    sounds: { melodic: [{ name: 'Own Tone', program: 0 }], rhythm: [] },
    notes: ['Fixture for tests: a setting row whose address is in a user area.'],
    settings: {
      rolandModel: '00 00 00 65',
      part: [{ name: 'level', min: 0, max: 127, message: roland('50 00 10 05', 1) }],
    },
  };
}

/** An instrument whose Roland data sets use a model ID that Moontide knows no temporary areas for. */
export function otherRolandModel() {
  return {
    id: 'othersynth',
    name: 'Other Synth',
    channels: { melodic: [1], rhythm: [] },
    bankSelect: 'none',
    defaultVolume: 100,
    controls: [],
    sounds: { melodic: [{ name: 'Own Tone', program: 0 }], rhythm: [] },
    notes: ['Fixture for tests: Roland data sets under another model ID.'],
    settings: {
      rolandModel: '00 00 00 64',
      part: [{ name: 'level', min: 0, max: 127, message: roland('01 00 10 05', 1) }],
      scene: [{ name: 'reverbLevel', min: 0, max: 127, message: roland('01 00 52 02', 1) }],
    },
  };
}

// The layout of a synth with a timbre area of 246 bytes per part, written as numbers: an address is three bytes of 7 bits, so
// it is a number in base 128, and a row sits at the start of its block plus its own offset. Written here from the manual's tables
// of such a synth (the common block, the partial block, the patch block and the system block), not from the vocabulary.
const BASE_128 = 128;
const hex2 = (byte) => byte.toString(16).toUpperCase().padStart(2, '0');
const addressText = (number) => [Math.floor(number / BASE_128 ** 2), Math.floor(number / BASE_128) % BASE_128, number % BASE_128].map(hex2).join(' ');
const blockStart = (high, middle, low) => (high * BASE_128 + middle) * BASE_128 + low;
const TIMBRE_COMMON_START = blockStart(0x04, 0x00, 0x00);
const PARTIAL_1_START = TIMBRE_COMMON_START + 0x0e;
const PARTIAL_SIZE = 0x3a;
const PARTIAL_COUNT = 4;
const PATCH_START = blockStart(0x03, 0x00, 0x00);
const SYSTEM_START = blockStart(0x10, 0x00, 0x00);

// The common block of the timbre area: name, offset, lowest and highest value.
const TIMBRE_COMMON_ROWS = [
  ['structure12', 0x0a, 0, 12],
  ['structure34', 0x0b, 0, 12],
  ['partialMute', 0x0c, 0, 15],
  ['envMode', 0x0d, 0, 1],
];
// One partial block, 58 rows: the name without its partial, the offset in the block, lowest and highest value.
const PARTIAL_ROWS = [
  ['CoarseTune', 0x00, 0, 96],
  ['FineTune', 0x01, 0, 100],
  ['PitchKeyFollow', 0x02, 0, 16],
  ['BendSwitch', 0x03, 0, 1],
  ['Wave', 0x04, 0, 1],
  ['PcmWave', 0x05, 0, 127],
  ['PulseWidth', 0x06, 0, 100],
  ['PulseWidthVelocity', 0x07, 0, 14],
  ['PitchEnvDepth', 0x08, 0, 10],
  ['PitchEnvVelocity', 0x09, 0, 100],
  ['PitchEnvTimeKeyFollow', 0x0A, 0, 4],
  ['PitchEnvTime1', 0x0B, 0, 100],
  ['PitchEnvTime2', 0x0C, 0, 100],
  ['PitchEnvTime3', 0x0D, 0, 100],
  ['PitchEnvTime4', 0x0E, 0, 100],
  ['PitchEnvLevel0', 0x0F, 0, 100],
  ['PitchEnvLevel1', 0x10, 0, 100],
  ['PitchEnvLevel2', 0x11, 0, 100],
  ['PitchEnvSustain', 0x12, 0, 100],
  ['PitchEnvEnd', 0x13, 0, 100],
  ['PitchLfoRate', 0x14, 0, 100],
  ['PitchLfoDepth', 0x15, 0, 100],
  ['PitchLfoModSens', 0x16, 0, 100],
  ['Cutoff', 0x17, 0, 100],
  ['Resonance', 0x18, 0, 30],
  ['CutoffKeyFollow', 0x19, 0, 14],
  ['FilterBiasPoint', 0x1A, 0, 127],
  ['FilterBiasLevel', 0x1B, 0, 14],
  ['FilterEnvDepth', 0x1C, 0, 100],
  ['FilterEnvVelocity', 0x1D, 0, 100],
  ['FilterEnvDepthKeyFollow', 0x1E, 0, 4],
  ['FilterEnvTimeKeyFollow', 0x1F, 0, 4],
  ['FilterEnvTime1', 0x20, 0, 100],
  ['FilterEnvTime2', 0x21, 0, 100],
  ['FilterEnvTime3', 0x22, 0, 100],
  ['FilterEnvTime4', 0x23, 0, 100],
  ['FilterEnvTime5', 0x24, 0, 100],
  ['FilterEnvLevel1', 0x25, 0, 100],
  ['FilterEnvLevel2', 0x26, 0, 100],
  ['FilterEnvLevel3', 0x27, 0, 100],
  ['FilterEnvSustain', 0x28, 0, 100],
  ['Level', 0x29, 0, 100],
  ['LevelVelocity', 0x2A, 0, 100],
  ['AmpBiasPoint1', 0x2B, 0, 127],
  ['AmpBiasLevel1', 0x2C, 0, 12],
  ['AmpBiasPoint2', 0x2D, 0, 127],
  ['AmpBiasLevel2', 0x2E, 0, 12],
  ['AmpEnvTimeKeyFollow', 0x2F, 0, 4],
  ['AmpEnvTimeVelocity', 0x30, 0, 4],
  ['AmpEnvTime1', 0x31, 0, 100],
  ['AmpEnvTime2', 0x32, 0, 100],
  ['AmpEnvTime3', 0x33, 0, 100],
  ['AmpEnvTime4', 0x34, 0, 100],
  ['AmpEnvTime5', 0x35, 0, 100],
  ['AmpEnvLevel1', 0x36, 0, 100],
  ['AmpEnvLevel2', 0x37, 0, 100],
  ['AmpEnvLevel3', 0x38, 0, 100],
  ['AmpEnvSustain', 0x39, 0, 100],
];
// The patch block: the five settings a program change loads again are tone rows, the output level and the panpot part rows.
const PATCH_TONE_ROWS = [
  ['keyShift', 0x02, 0, 48],
  ['toneFineTune', 0x03, 0, 100],
  ['bendRange', 0x04, 0, 24],
  ['assignMode', 0x05, 0, 3],
  ['toneReverbSwitch', 0x06, 0, 1],
];
const PATCH_PART_ROWS = [
  ['level', 0x08, 0, 100],
  ['pan', 0x09, 0, 14],
];
// The system block, one for the whole instrument.
const SYSTEM_ROWS = [
  ['masterTune', 0x00, 0, 127],
  ['reverbType', 0x01, 0, 3],
  ['reverbTime', 0x02, 0, 7],
  ['reverbLevel', 0x03, 0, 7],
  ['level', 0x16, 0, 100],
];

const rowsAt = (start, table, prefix = '') => table.map(([name, offset, min, max]) => ({ name: `${prefix}${name}`, min, max, message: roland(addressText(start + offset), 1) }));

/**
 * A neutral instrument whose data sets have a one-byte model ID and three-byte addresses, at the places of a synth with
 * a timbre area of 246 bytes per part and a patch area of 16 bytes per part: melodic channels 2 to 9 and a rhythm channel 10,
 * no engines. It holds every row of the layout above: 241 tone rows (the common block, four partials of 58 rows and the five
 * patch settings), two part rows in the patch area and five scene rows in the system area.
 */
export function timbreSynthModel() {
  const partials = [];
  for (let partial = 1; partial <= PARTIAL_COUNT; partial++) {
    partials.push(...rowsAt(PARTIAL_1_START + PARTIAL_SIZE * (partial - 1), PARTIAL_ROWS, `partial${partial}`));
  }
  return {
    id: 'timbresynth',
    name: 'Timbre Synth',
    channels: { melodic: [2, 3, 4, 5, 6, 7, 8, 9], rhythm: [10] },
    bankSelect: 'none',
    defaultVolume: 100,
    controls: [],
    sounds: {
      melodic: [{ name: 'Own Timbre', program: 0 }],
      rhythm: [{ name: 'Own Kit', program: 0 }],
    },
    notes: ['Fixture for tests: settings are Roland data sets with a one-byte model ID and three-byte addresses.'],
    settings: {
      rolandModel: '16',
      tone: [...rowsAt(TIMBRE_COMMON_START, TIMBRE_COMMON_ROWS), ...partials, ...rowsAt(PATCH_START, PATCH_TONE_ROWS)],
      part: rowsAt(PATCH_START, PATCH_PART_ROWS),
      scene: rowsAt(SYSTEM_START, SYSTEM_ROWS),
    },
  };
}
