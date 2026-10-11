// Neutral fixtures shared by the tests and `npm run probe:midi`: instrument models named after no real device.
// Each call returns a new object, so a test may change it freely.

/** An instrument whose drum part takes a bank, with the General MIDI map and one kit that has no known map. */
export function bankDrumsModel() {
  return {
    id: 'bankdrums',
    name: 'Bank Drum Synth',
    channels: { melodic: [1, 2, 3, 4], rhythm: [5] },
    bankSelect: 'msb-lsb',
    rhythmBank: true,
    defaultVolume: 100,
    controls: [],
    drumMap: 'general-midi',
    sounds: {
      melodic: [{ name: 'Tone One', program: 0, bank: { msb: 1, lsb: 2 } }],
      rhythm: [
        { name: 'Kit A', program: 0, bank: { msb: 86, lsb: 64 } },
        { name: 'Kit B', program: 0, bank: { msb: 86, lsb: 65 } },
        { name: 'Kit C', program: 3, bank: { msb: 86, lsb: 65 }, noteMap: null },
      ],
    },
    notes: ['Fixture for tests: kits are chosen by bank and program on channel 5.'],
  };
}

/** A General MIDI instrument: the drum part is channel 10, kits are not chosen, the built-in map applies. */
export function gmDrumsModel() {
  return {
    id: 'gmdrums',
    name: 'GM Drum Synth',
    channels: { melodic: [1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 14, 15, 16], rhythm: [10] },
    bankSelect: 'none',
    defaultVolume: 100,
    controls: [],
    drumMap: 'general-midi',
    sounds: { melodic: [{ name: 'Tone One', program: 0 }], rhythm: [] },
    notes: ['Fixture for tests: a General MIDI instrument.'],
  };
}

const MAP_A = { id: 'own-a', name: 'Own A', notes: [{ note: 36, name: 'First' }, { note: 38, name: 'Middle' }, { note: 42, name: 'Last' }] };
const MAP_B = { id: 'own-b', name: 'Own B', notes: [{ note: 40, name: 'Other' }] };

/**
 * The resolution table (read only) of a kit's drum map, one table for the server (kitDrumMap) and the page (drumMapFor).
 * Each case: `model` (the `drumMaps` and `drumMap` of a model), `kits` (its rhythm sounds), `kit` (the sound the
 * code writes on the rhythm channel, or null), and the expected `state`, `via` and map `id` (null when unknown).
 * `pageOnly` marks a case the server never sees: a kit name the rig does not hold.
 * Never a case where an unknown map comes back as the General MIDI map.
 */
const kit = (name, extra = {}) => ({ name, program: 0, ...extra });
export const DRUM_MAP_CASES = [
  { name: 'no kit written, the model has a map', model: { drumMaps: [MAP_A], drumMap: 'own-a' }, kits: [], kit: null, state: 'known', via: 'model', id: 'own-a' },
  { name: 'a kit with its own map', model: { drumMaps: [MAP_A, MAP_B], drumMap: 'own-a' }, kits: [kit('Kit X', { noteMap: 'own-b' })], kit: 'Kit X', state: 'known', via: 'kit', id: 'own-b' },
  { name: 'a kit with noteMap null', model: { drumMaps: [MAP_A], drumMap: 'own-a' }, kits: [kit('Kit X', { noteMap: null })], kit: 'Kit X', state: 'unknown', via: 'kit', id: null },
  { name: 'a kit with no noteMap takes the model map', model: { drumMaps: [MAP_A], drumMap: 'own-a' }, kits: [kit('Kit X')], kit: 'Kit X', state: 'known', via: 'model', id: 'own-a' },
  { name: 'a kit with no noteMap and no model map', model: { drumMaps: [MAP_A] }, kits: [kit('Kit X')], kit: 'Kit X', state: 'unknown', via: 'model', id: null },
  { name: 'a kit name the rig does not hold', model: { drumMaps: [MAP_A], drumMap: 'own-a' }, kits: [kit('Kit X')], kit: 'No Such Kit', state: 'unknown', via: 'kit', id: null, pageOnly: true },
  { name: 'no kit written and no model map', model: { drumMaps: [MAP_A] }, kits: [], kit: null, state: 'unknown', via: 'model', id: null },
  { name: 'a model that names the built-in map', model: { drumMap: 'general-midi' }, kits: [], kit: null, state: 'known', via: 'model', id: 'general-midi' },
  { name: 'a kit that names the built-in map', model: { drumMaps: [MAP_A], drumMap: 'own-a' }, kits: [kit('Kit X', { noteMap: 'general-midi' })], kit: 'Kit X', state: 'known', via: 'kit', id: 'general-midi' },
  { name: 'a model with no map at all', model: {}, kits: [kit('Kit X')], kit: 'Kit X', state: 'unknown', via: 'model', id: null },
];
