// Drum maps, the facts of which note plays which drum. A map is model data typed from the
// makers' manuals; a kit's map is resolved by one rule (kitDrumMap), and a kit with no known map is
// a stated fact, never a General MIDI default. This module imports only zod and ./rig-util.js (the
// module-cycle rule of src/rig-util.ts: instruments.ts and catalog.ts both read these schemas).
// Names are data in arrays, never exported string constants, because test/guidance.test.js scans
// the exported strings of the modules it loads.

import { z } from 'zod';
import { dataByteSchema, idSchema } from './rig-util.js';

/** The most drum maps one model may hold; the message cap (MAX_RIG_DRUM_MAPS) leaves room for built-in maps. */
export const MAX_DRUM_MAPS = 8;
export const MAX_DRUM_NOTES = 128;
export const MAX_DRUM_NAME = 40;
/** The id of the built-in General MIDI map; a model may name it without holding it, and may not reuse it. */
export const GENERAL_MIDI_MAP_ID = 'general-midi';

export const drumMapSchema = z.strictObject({
  id: idSchema,
  name: z.string().min(1).max(MAX_DRUM_NAME),
  notes: z
    .array(z.strictObject({ note: dataByteSchema, name: z.string().min(1).max(MAX_DRUM_NAME) }))
    .min(1)
    .max(MAX_DRUM_NOTES),
});

export type DrumMap = { id: string; name: string; notes: { note: number; name: string }[] };

// The General MIDI percussion map, notes 35 to 81 (the General MIDI Level 1 table). The three hi-hat
// names are spelled with a hyphen; every other name is the table's own.
const GENERAL_MIDI_NOTES: readonly (readonly [number, string])[] = [
  [35, 'Acoustic Bass Drum'],
  [36, 'Bass Drum 1'],
  [37, 'Side Stick'],
  [38, 'Acoustic Snare'],
  [39, 'Hand Clap'],
  [40, 'Electric Snare'],
  [41, 'Low Floor Tom'],
  [42, 'Closed Hi-Hat'],
  [43, 'High Floor Tom'],
  [44, 'Pedal Hi-Hat'],
  [45, 'Low Tom'],
  [46, 'Open Hi-Hat'],
  [47, 'Low-Mid Tom'],
  [48, 'Hi-Mid Tom'],
  [49, 'Crash Cymbal 1'],
  [50, 'High Tom'],
  [51, 'Ride Cymbal 1'],
  [52, 'Chinese Cymbal'],
  [53, 'Ride Bell'],
  [54, 'Tambourine'],
  [55, 'Splash Cymbal'],
  [56, 'Cowbell'],
  [57, 'Crash Cymbal 2'],
  [58, 'Vibraslap'],
  [59, 'Ride Cymbal 2'],
  [60, 'Hi Bongo'],
  [61, 'Low Bongo'],
  [62, 'Mute Hi Conga'],
  [63, 'Open Hi Conga'],
  [64, 'Low Conga'],
  [65, 'High Timbale'],
  [66, 'Low Timbale'],
  [67, 'High Agogo'],
  [68, 'Low Agogo'],
  [69, 'Cabasa'],
  [70, 'Maracas'],
  [71, 'Short Whistle'],
  [72, 'Long Whistle'],
  [73, 'Short Guiro'],
  [74, 'Long Guiro'],
  [75, 'Claves'],
  [76, 'Hi Wood Block'],
  [77, 'Low Wood Block'],
  [78, 'Mute Cuica'],
  [79, 'Open Cuica'],
  [80, 'Mute Triangle'],
  [81, 'Open Triangle'],
];

/** The maps every model may name without holding them. Frozen, so no caller can change what Claude is told. */
export const BUILT_IN_DRUM_MAPS: readonly DrumMap[] = Object.freeze([
  Object.freeze({
    id: GENERAL_MIDI_MAP_ID,
    name: 'General MIDI',
    notes: Object.freeze(GENERAL_MIDI_NOTES.map(([note, name]) => Object.freeze({ note, name }))) as DrumMap['notes'],
  }),
]);

/** The map with this id: the model's own first, then a built-in one, else null. */
export function drumMapById(own: readonly DrumMap[], id: string): DrumMap | null {
  return own.find((map) => map.id === id) ?? BUILT_IN_DRUM_MAPS.find((map) => map.id === id) ?? null;
}

/** The map a kit uses, or the plain fact that none is known. `via` says whether the kit or the model decided it. */
export type DrumMapUse = { state: 'known'; map: DrumMap; via: 'kit' | 'model' } | { state: 'unknown'; via: 'kit' | 'model' };

interface DrumMapModel {
  drumMaps?: readonly DrumMap[] | undefined;
  drumMap?: string | undefined;
}

/**
 * The one rule: no kit written, or a kit with no noteMap of its own, takes the model's map (unknown
 * when the model has none); a kit with noteMap null has no known map; a kit with a map id takes that
 * map. Never a General MIDI guess: only a model or a kit that names the General MIDI map gets it.
 */
export function kitDrumMap(model: DrumMapModel, kit: { noteMap?: string | null | undefined } | null): DrumMapUse {
  const modelMap = model.drumMap === undefined ? null : drumMapById(model.drumMaps ?? [], model.drumMap);
  const ofModel = (): DrumMapUse => (modelMap === null ? { state: 'unknown', via: 'model' } : { state: 'known', map: modelMap, via: 'model' });
  if (kit === null || kit.noteMap === undefined) return ofModel();
  if (kit.noteMap === null) return { state: 'unknown', via: 'kit' };
  const map = drumMapById(model.drumMaps ?? [], kit.noteMap);
  // The model rules refuse an unknown id before any of this runs, so a missing map here is a bug, not data.
  if (map === null) throw new Error(`Moontide: drum map ${JSON.stringify(kit.noteMap)} is not known to the model.`);
  return { state: 'known', map, via: 'kit' };
}

const copyMap = (map: DrumMap): DrumMap => ({ id: map.id, name: map.name, notes: map.notes.map((note) => ({ note: note.note, name: note.name })) });

/** The maps that travel to the page: the model's own in model order, then each built-in map the model or one of its kits names. */
export function mapsToSend(model: DrumMapModel, kits: readonly { noteMap?: string | null | undefined }[]): DrumMap[] {
  const maps = (model.drumMaps ?? []).map(copyMap);
  const wanted = [model.drumMap, ...kits.map((kit) => kit.noteMap)];
  for (const builtIn of BUILT_IN_DRUM_MAPS) {
    if (wanted.includes(builtIn.id) && !maps.some((map) => map.id === builtIn.id)) maps.push(copyMap(builtIn));
  }
  return maps;
}

/** The reason an id names no map: the ids the model has and the built-in ones. */
export function unknownMapReason(own: readonly DrumMap[], id: string): string {
  const mine = own.length === 0 ? 'none' : own.map((map) => map.id).join(', ');
  return `unknown drum map "${id}", this model has: ${mine}; built in: ${BUILT_IN_DRUM_MAPS.map((map) => map.id).join(', ')}`;
}
