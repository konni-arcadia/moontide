// The user's instruments: the setup file `instruments.json` in the data folder, the
// shipped instrument models of the package (`instruments/*.json`), and the one message that carries
// both to the page. Everything Claude reads from here is a fact: a field and the reason it is wrong,
// never a style or a taste. No sound name is ever exported as a string constant from this module,
// because test/guidance.test.js scans the exported strings of the modules it loads.
//
// The setup file is read whole, synchronously, at every use; reading never throws: a problem is a
// state (`invalid`), never an exception, so a hand edit in progress cannot crash the server.

import { mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { z } from 'zod';
import { catalogLine, categoriesSentence, readCatalogFile, searchCatalog, searchReply, type Catalog } from './catalog.js';
import {
  MAX_DRUM_MAPS,
  drumMapById,
  drumMapSchema,
  kitDrumMap,
  mapsToSend,
  unknownMapReason,
  BUILT_IN_DRUM_MAPS,
  type DrumMap,
} from './drum-maps.js';
import { renameWithRetry } from './history.js';
import { cleanMidiName, quoteMidiName } from './midi-state.js';
import {
  MAX_MIDI_NAME_LENGTH,
  MAX_RIG_INSTRUMENTS,
  MAX_RIG_PROBLEMS,
  MAX_RIG_SOUNDS,
  type MidiFacts,
  type RigInstrumentMessage,
  type ServerMessage,
} from './protocol.js';
import {
  CONTROL_CHARS,
  MAX_RIG_FILE_BYTES,
  RIG_FILE_NAME,
  RIG_STATE_FILE_NAME,
  cleanProblemText,
  dataByteSchema,
  errnoCode,
  idSchema,
  modelIdSchema,
  parseJsonText,
  problemsFromZod,
  soundKey,
  type Problem,
} from './rig-util.js';

// The helpers other modules and tests already read from here live in src/rig-util.ts.
export { MAX_RIG_FILE_BYTES, RIG_FILE_NAME, RIG_STATE_FILE_NAME, problemsFromZod, soundKey, type Problem } from './rig-util.js';

export const MODELS_DIR_NAME = 'models';

/** The Roland checksum of the address and data bytes: (128 minus their sum modulo 128) modulo 128. */
export function rolandChecksum(bytes: number[]): number {
  const sum = bytes.reduce((total, byte) => total + byte, 0);
  return (128 - (sum % 128)) % 128;
}

/** A Roland DT1 (data set) message: F0 41 device model 12 address data checksum F7. */
export function rolandDt1(deviceId: number, model: number, address: number[], data: number[]): number[] {
  const body = [...address, ...data];
  return [0xf0, 0x41, deviceId, model, 0x12, ...body, rolandChecksum(body), 0xf7];
}

/** Space-separated two-digit hex text to bytes. Throws on anything else (the model schema checks the text first). */
function hexBytes(text: string): number[] {
  const parts = text.trim().split(/\s+/);
  return parts.map((part) => {
    if (!/^[0-9a-fA-F]{2}$/.test(part)) {
      throw new Error(`Moontide: "${part}" is not a two-digit hex byte.`);
    }
    return Number.parseInt(part, 16);
  });
}

// A channel number says what is wrong with the value it got, so a typo reads as one clear reason.
const channelRange = { error: (issue: { input?: unknown }) => `${String(issue.input)} is not between 1 and 16` };
const channelSchema = z
  .number({
    error: (issue) =>
      issue.input === undefined ? 'required' : `expected a number, got ${JSON.stringify(issue.input)}`,
  })
  .int({ error: (issue) => `${String(issue.input)} is not a whole number` })
  .min(1, channelRange)
  .max(16, channelRange);
const soundSchema = z.strictObject({
  name: z.string().min(1).max(40),
  program: dataByteSchema,
  bank: z.strictObject({ msb: dataByteSchema, lsb: dataByteSchema.optional() }).optional(),
});

// A rhythm sound may name the drum map of its kit, or null when no map is known for it. A melodic sound
// keeps the plain schema, so a noteMap there stays an unknown field.
const rhythmSoundSchema = soundSchema.extend({ noteMap: idSchema.nullable().optional() });

const resetMessageSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('roland-dt1'), model: z.string(), address: z.string(), data: z.string() }),
  z.strictObject({ kind: z.literal('raw'), bytes: z.string() }),
]);

/** A model file (shipped in `instruments/`, or saved by the user in `<data>/models/`). */
export const modelSchema = z.strictObject({
  id: modelIdSchema,
  name: z.string().min(1).max(80),
  channels: z.strictObject({
    melodic: z.array(channelSchema).max(16),
    rhythm: z.array(channelSchema).max(16),
  }),
  bankSelect: z.enum(['none', 'msb', 'msb-lsb']),
  defaultVolume: dataByteSchema,
  reset: z
    .strictObject({
      sysex: z.array(resetMessageSchema).min(1, 'at least one message is required').max(4, 'at most 4 messages'),
      waitMs: z.number().int().min(0).max(2000),
    })
    .optional(),
  controls: z
    .array(
      z.strictObject({
        id: idSchema,
        name: z.string().min(1).max(40),
        cc: dataByteSchema,
        min: dataByteSchema,
        max: dataByteSchema,
        default: dataByteSchema,
      }),
    )
    .max(32),
  sounds: z.strictObject({
    melodic: z.array(soundSchema).max(MAX_RIG_SOUNDS),
    rhythm: z.array(rhythmSoundSchema).max(MAX_RIG_SOUNDS),
  }),
  notes: z.array(z.string().min(1).max(240)).max(10),
  // Whether the instrument follows MIDI clock. Optional, so a model saved before the field existed still loads.
  clock: z.boolean().optional(),
  // Whether the rhythm channels choose a kit by bank select and program. Optional, absent means off, so every earlier model loads unchanged.
  rhythmBank: z.boolean().optional(),
  // Which note plays which drum. The maps of the model, the id of the map its kits take unless they name
  // another, both optional, so every earlier model loads unchanged. The General MIDI map is built in.
  drumMaps: z.array(drumMapSchema).max(MAX_DRUM_MAPS).optional(),
  drumMap: idSchema.optional(),
});

/** The setup file: one entry per instrument the user plays. */
export const rigFileSchema = z.strictObject({
  instruments: z
    .array(
      z.strictObject({
        id: idSchema,
        model: z.string().min(1),
        port: z.string().min(1, 'must not be empty').max(MAX_MIDI_NAME_LENGTH, `at most ${MAX_MIDI_NAME_LENGTH} characters`),
        channels: z.array(channelSchema).min(1, 'at least one channel is required').optional(),
        // Turns the clock on or off for this instrument; the entry wins over the model's own clock.
        clock: z.boolean().optional(),
      }),
    )
    .min(1, 'at least one instrument is required')
    .max(MAX_RIG_INSTRUMENTS, 'at most 16 instruments'),
});

/** The state file: the instruments the user switched off in the page, by id. A missing file means none. */
export const rigStateSchema = z.strictObject({
  off: z.array(idSchema).max(MAX_RIG_INSTRUMENTS, 'at most 16 instruments'),
});

export type InstrumentModel = z.infer<typeof modelSchema>;

export interface RigInstrument {
  id: string;
  port: string;
  model: InstrumentModel;
  channels: { channel: number; role: 'melodic' | 'rhythm' }[];
  /** The sound catalog of the model (catalogs/<model id>.json), or null when the user has none. */
  catalog: Catalog | null;
  /** Whether Moontide sends this instrument MIDI clock, Start and Stop: the rig entry wins over the model, and neither set means false. */
  clock: boolean;
  /** False when the user switched the instrument off in the page (instruments-state.json); it is still a valid instrument of the file. */
  enabled: boolean;
}

export type RigState =
  | { setup: 'absent' }
  | { setup: 'invalid'; problems: Problem[]; more: number }
  | { setup: 'valid'; instruments: RigInstrument[] };

function invalid(problems: Problem[]): RigState {
  const cleaned = problems.map((problem) => ({ field: cleanProblemText(problem.field), reason: cleanProblemText(problem.reason) }));
  return { setup: 'invalid', problems: cleaned.slice(0, MAX_RIG_PROBLEMS), more: Math.max(0, cleaned.length - MAX_RIG_PROBLEMS) };
}

/** The folder of the shipped models: module-relative, like referenceDir(), so it works wherever npm installs the package. */
export function shippedModelsDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'instruments');
}

function ranges(channels: number[]): string {
  const sorted = [...channels].sort((a, b) => a - b);
  const parts: string[] = [];
  let index = 0;
  while (index < sorted.length) {
    let end = index;
    while (end + 1 < sorted.length && sorted[end + 1] === (sorted[end] as number) + 1) end++;
    parts.push(end === index ? String(sorted[index]) : `${sorted[index]}-${sorted[end]}`);
    index = end + 1;
  }
  return parts.join(', ');
}

/** The hex text as bytes, or the problem with its first bad piece (nothing is thrown). */
function readHex(text: string, field: string, problems: Problem[]): number[] | null {
  const parts = text.trim().split(/\s+/).filter((part) => part !== '');
  if (parts.length === 0) {
    problems.push({ field, reason: 'must not be empty' });
    return null;
  }
  for (const part of parts) {
    if (!/^[0-9a-fA-F]{2}$/.test(part)) {
      problems.push({ field, reason: `"${part}" is not a two-digit hex byte` });
      return null;
    }
  }
  return parts.map((part) => Number.parseInt(part, 16));
}

const hex2 = (byte: number): string => byte.toString(16).toUpperCase().padStart(2, '0');

/** The first byte above 7F at or after `from`, as a problem. */
function checkSevenBit(bytes: number[], from: number, to: number, field: string, problems: Problem[]): void {
  for (let index = from; index < to; index++) {
    const byte = bytes[index] as number;
    if (byte > 0x7f) {
      problems.push({ field, reason: `byte ${index} (${hex2(byte)}) is above 7F` });
      return;
    }
  }
}

/** The checks that need more than one field of a model; the shape is already valid. Paths are bare (no file prefix). */
function modelProblems(model: InstrumentModel): Problem[] {
  const problems: Problem[] = [];
  const add = (field: string, reason: string): void => {
    problems.push({ field, reason });
  };
  const noControl = (field: string, text: string): void => {
    if (CONTROL_CHARS.test(text)) add(field, 'contains a control character');
  };
  noControl('name', model.name);
  model.notes.forEach((note, index) => noControl(`notes[${index}]`, note));

  for (const role of ['melodic', 'rhythm'] as const) {
    model.channels[role].forEach((channel, index) => {
      if (model.channels[role].indexOf(channel) !== index) add(`channels.${role}[${index}]`, `channel ${channel} is listed twice`);
    });
  }
  model.channels.rhythm.forEach((channel, index) => {
    if (model.channels.melodic.includes(channel)) add(`channels.rhythm[${index}]`, `channel ${channel} is also a melodic channel`);
  });

  const rhythmBank = model.rhythmBank === true;
  for (const role of ['melodic', 'rhythm'] as const) {
    const firstByKey = new Map<string, number>();
    model.sounds[role].forEach((sound, index) => {
      const at = `sounds.${role}[${index}]`;
      noControl(`${at}.name`, sound.name);
      const key = soundKey(sound.name);
      const first = firstByKey.get(key);
      if (first === undefined) {
        firstByKey.set(key, index);
      } else {
        add(`${at}.name`, `same name as sounds.${role}[${first}] ("${(model.sounds[role][first] as { name: string }).name}")`);
      }
      if (role === 'rhythm' && rhythmBank && sound.bank === undefined) {
        // A kit with no bank would go out as bank 0/0, a melodic tone on the drum part: refused instead.
        add(`${at}.bank`, 'required: the rhythm channels of this model take a bank');
        return;
      }
      if (sound.bank === undefined) return;
      if (role === 'rhythm' && !rhythmBank) add(`${at}.bank`, 'rhythm sounds take no bank unless the model sets rhythmBank to true');
      else if (model.bankSelect === 'none') add(`${at}.bank`, 'this model has no bank select');
      else if (model.bankSelect === 'msb' && sound.bank.lsb !== undefined) add(`${at}.bank.lsb`, 'this model takes a bank MSB only');
    });
  }
  if (model.sounds.rhythm.length > 0 && model.channels.rhythm.length === 0) add('sounds.rhythm', 'the model has no rhythm channel');
  if (rhythmBank && model.bankSelect === 'none') add('rhythmBank', 'needs a bank select, and bankSelect is none');
  if (rhythmBank && model.channels.rhythm.length === 0) add('rhythmBank', 'the model has no rhythm channel');

  // The drum maps, then every id that names one.
  const ownMaps = model.drumMaps ?? [];
  if (ownMaps.length > 0 && model.channels.rhythm.length === 0) add('drumMaps', 'the model has no rhythm channel');
  if (model.drumMap !== undefined && model.channels.rhythm.length === 0) add('drumMap', 'the model has no rhythm channel');
  const firstMap = new Map<string, number>();
  ownMaps.forEach((map, index) => {
    const at = `drumMaps[${index}]`;
    noControl(`${at}.name`, map.name);
    if (BUILT_IN_DRUM_MAPS.some((builtIn) => builtIn.id === map.id)) add(`${at}.id`, 'is a built-in map');
    const first = firstMap.get(map.id);
    if (first === undefined) firstMap.set(map.id, index);
    else add(`${at}.id`, `same id as drumMaps[${first}]`);
    const firstNote = new Map<number, number>();
    map.notes.forEach((entry, noteIndex) => {
      noControl(`${at}.notes[${noteIndex}].name`, entry.name);
      const earlier = firstNote.get(entry.note);
      if (earlier === undefined) firstNote.set(entry.note, noteIndex);
      else add(`${at}.notes[${noteIndex}].note`, `same note as notes[${earlier}] ("${(map.notes[earlier] as { name: string }).name}")`);
    });
  });
  if (model.drumMap !== undefined && drumMapById(ownMaps, model.drumMap) === null) add('drumMap', unknownMapReason(ownMaps, model.drumMap));
  model.sounds.rhythm.forEach((sound, index) => {
    if (typeof sound.noteMap === 'string' && drumMapById(ownMaps, sound.noteMap) === null) {
      add(`sounds.rhythm[${index}].noteMap`, unknownMapReason(ownMaps, sound.noteMap));
    }
  });

  const firstControl = new Map<string, number>();
  model.controls.forEach((control, index) => {
    noControl(`controls[${index}].name`, control.name);
    const first = firstControl.get(control.id);
    if (first === undefined) firstControl.set(control.id, index);
    else add(`controls[${index}].id`, `same id as controls[${first}]`);
    if (control.max < control.min) add(`controls[${index}].max`, 'must not be below min');
    else if (control.default < control.min || control.default > control.max) add(`controls[${index}].default`, 'must be between min and max');
  });

  model.reset?.sysex.forEach((message, index) => {
    const at = `reset.sysex[${index}]`;
    if (message.kind === 'raw') {
      const bytes = readHex(message.bytes, `${at}.bytes`, problems);
      if (bytes === null) return;
      if (bytes[0] !== 0xf0 || bytes[bytes.length - 1] !== 0xf7) add(`${at}.bytes`, 'must start with F0 and end with F7');
      else if (bytes.length > 32) add(`${at}.bytes`, 'at most 32 bytes');
      else checkSevenBit(bytes, 1, bytes.length - 1, `${at}.bytes`, problems);
      return;
    }
    const fields = [
      { name: 'model', min: 1, max: 1, reason: 'must be exactly one byte' },
      { name: 'address', min: 1, max: 4, reason: 'must be 1 to 4 bytes' },
      { name: 'data', min: 1, max: 16, reason: 'must be 1 to 16 bytes' },
    ] as const;
    for (const { name, min, max, reason } of fields) {
      const bytes = readHex(message[name], `${at}.${name}`, problems);
      if (bytes === null) continue;
      if (bytes.length < min || bytes.length > max) add(`${at}.${name}`, reason);
      else checkSevenBit(bytes, 0, bytes.length, `${at}.${name}`, problems);
    }
  });
  return problems;
}

/**
 * Checks a model value (a shipped file, a user file, or a draft): the shape with its limits, then
 * the cross-checks. `file` names a user model file for the problems (`models/<file>:<path>`).
 */
export function parseModel(
  value: unknown,
  file?: string,
): { ok: true; model: InstrumentModel } | { ok: false; problems: Problem[] } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, problems: [{ field: file ?? 'model', reason: 'must be an object' }] };
  }
  const parsed = modelSchema.safeParse(value);
  if (!parsed.success) return { ok: false, problems: problemsFromZod(parsed.error, file) };
  const problems = modelProblems(parsed.data).map((problem) => (file === undefined ? problem : { ...problem, field: `${file}:${problem.field}` }));
  return problems.length > 0 ? { ok: false, problems } : { ok: true, model: parsed.data };
}

export class RigStore {
  private readonly dataDir: string | (() => string);
  private readonly shipped = new Map<string, InstrumentModel>();

  constructor(options: { dataDir: string | (() => string); shippedDir?: string }) {
    this.dataDir = options.dataDir;
    const dir = options.shippedDir ?? shippedModelsDir();
    const files = readdirSync(dir)
      .filter((file) => file.endsWith('.json'))
      .sort();
    for (const file of files) {
      const parsed = parseModel(JSON.parse(readFileSync(path.join(dir, file), 'utf8')));
      if (!parsed.ok) {
        const [problem] = parsed.problems;
        throw new Error(`Moontide: shipped instrument model ${file} is invalid: ${problem?.field}: ${problem?.reason}`);
      }
      if (`${parsed.model.id}.json` !== file) {
        throw new Error(`Moontide: shipped instrument model ${file} is invalid: id: must equal the file name`);
      }
      this.shipped.set(parsed.model.id, parsed.model);
    }
  }

  /** The ids of the shipped models, in file-name order. */
  shippedModelIds(): string[] {
    return Array.from(this.shipped.keys());
  }

  /** The shipped models as id and display name, in file-name order. */
  shippedModelList(): { id: string; name: string }[] {
    return Array.from(this.shipped.values(), (model) => ({ id: model.id, name: model.name }));
  }

  /** The data folder as text for a tool reply, or 'unknown' when it cannot be resolved (never throws). */
  dataDirText(): string {
    try {
      return cleanProblemText(this.resolveDir());
    } catch {
      return 'unknown';
    }
  }

  /** The data folder now (saving a model writes there). Throws when it cannot be found. */
  resolveDataDir(): string {
    return this.resolveDir();
  }

  private resolveDir(): string {
    return typeof this.dataDir === 'function' ? this.dataDir() : this.dataDir;
  }

  /** The user models of `<data>/models/`: the usable ones, and the problems of the others (never thrown). */
  private readUserModels(dir: string): { models: Map<string, InstrumentModel>; problems: Problem[] } {
    const models = new Map<string, InstrumentModel>();
    const problems: Problem[] = [];
    const folder = path.join(dir, MODELS_DIR_NAME);
    let files: string[];
    try {
      files = readdirSync(folder)
        .filter((file) => file.endsWith('.json'))
        .sort();
    } catch (err) {
      if (errnoCode(err) !== 'ENOENT') problems.push({ field: MODELS_DIR_NAME, reason: `could not be read: ${errnoCode(err)}` });
      return { models, problems };
    }
    for (const file of files) {
      const where = `${MODELS_DIR_NAME}/${file}`;
      let text: string;
      try {
        text = readFileSync(path.join(folder, file), 'utf8');
      } catch (err) {
        problems.push({ field: where, reason: `could not be read: ${errnoCode(err)}` });
        continue;
      }
      const json = parseJsonText(text);
      if (!json.ok) {
        problems.push({ field: where, reason: json.reason });
        continue;
      }
      const parsed = parseModel(json.value, where);
      if (!parsed.ok) {
        problems.push(...parsed.problems);
        continue;
      }
      const expected = file.slice(0, -'.json'.length);
      if (parsed.model.id !== expected) {
        problems.push({ field: `${where}:id`, reason: `must equal the file name ("${expected}")` });
      } else if (this.shipped.has(parsed.model.id)) {
        problems.push({ field: `${where}:id`, reason: `"${parsed.model.id}" is a shipped model` });
      } else {
        models.set(parsed.model.id, parsed.model);
      }
    }
    return { models, problems };
  }

  /**
   * The model with this id, shipped or saved by the user, or why it is not usable: an unknown id names
   * the known models, a broken model file gives that file's problems only (another model stays usable).
   */
  modelFor(id: string): { ok: true; model: InstrumentModel } | { ok: false; problems: Problem[] } {
    const shipped = this.shipped.get(id);
    if (shipped !== undefined) return { ok: true, model: shipped };
    let dir: string;
    try {
      dir = this.resolveDir();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, problems: [{ field: 'data folder', reason: `the data folder could not be found: ${message}` }] };
    }
    const user = this.readUserModels(dir);
    const model = user.models.get(id);
    if (model !== undefined) return { ok: true, model };
    const file = `${MODELS_DIR_NAME}/${id}.json`;
    const own = user.problems.filter((problem) => problem.field === file || problem.field.startsWith(`${file}:`));
    if (own.length > 0) return { ok: false, problems: own };
    const known = [...this.shipped.keys(), ...user.models.keys()];
    return { ok: false, problems: [{ field: 'model', reason: `unknown model "${id}", known models: ${known.join(', ')}` }] };
  }

  /** Reads the setup file now. Never throws: every problem is a state. */
  read(): RigState {
    let dir: string;
    try {
      dir = this.resolveDir();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return invalid([{ field: RIG_FILE_NAME, reason: `the data folder could not be found: ${message}` }]);
    }
    let text: string;
    try {
      text = readFileSync(path.join(dir, RIG_FILE_NAME), 'utf8');
    } catch (err) {
      if (errnoCode(err) === 'ENOENT') return { setup: 'absent' };
      return invalid([{ field: RIG_FILE_NAME, reason: `could not be read: ${errnoCode(err)}` }]);
    }
    const json = parseJsonText(text);
    if (!json.ok) return invalid([{ field: RIG_FILE_NAME, reason: json.reason }]);
    return this.stateOf(dir, json.value);
  }

  /**
   * The state a value would give if it were the content of instruments.json, with the very checks
   * a read of the file makes. A settings edit is validated here before anything is written, so a hand edit and
   * a page edit get the same problems. Never throws.
   */
  validateRigValue(value: unknown): RigState {
    let dir: string;
    try {
      dir = this.resolveDir();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return invalid([{ field: RIG_FILE_NAME, reason: `the data folder could not be found: ${message}` }]);
    }
    return this.stateOf(dir, value);
  }

  /** The state of a parsed instruments.json value: the object check, the schema, the cross-checks and the models. */
  private stateOf(dir: string, value: unknown): RigState {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return invalid([{ field: RIG_FILE_NAME, reason: 'must be an object with an "instruments" list' }]);
    }

    // The models only matter with a setup file; a broken model file is a problem of the rig.
    const user = this.readUserModels(dir);
    const problems: Problem[] = [];
    const instruments: RigInstrument[] = [];
    // The user's on/off choice. A broken state file is a problem of the rig, listed after the
    // problems of instruments.json and never read as "everything on" (an instrument the user muted must not
    // start to sound because a file is damaged).
    const state = readOffIds(dir);
    const off = state.ok ? state.off : new Set<string>();
    const parsed = rigFileSchema.safeParse(value);
    if (!parsed.success) {
      problems.push(...problemsFromZod(parsed.error));
    } else {
      const known = [...this.shipped.keys(), ...user.models.keys()];
      // The catalog of a model is read once per read, and only for a model an instrument uses.
      const catalogs = new Map<string, Catalog | null>();
      const firstById = new Map<string, number>();
      const firstByPort = new Map<string, number>();
      parsed.data.instruments.forEach((entry, index) => {
        const at = `instruments[${index}]`;
        let usable = true;
        const sameId = firstById.get(entry.id);
        if (sameId === undefined) firstById.set(entry.id, index);
        else {
          problems.push({ field: `${at}.id`, reason: `same id as instruments[${sameId}]` });
          usable = false;
        }
        const samePort = firstByPort.get(entry.port);
        if (samePort !== undefined) {
          const other = (parsed.data.instruments[samePort] as { id: string }).id;
          problems.push({ field: `${at}.port`, reason: `same port as instruments[${samePort}] ("${other}")` });
          usable = false;
        } else {
          firstByPort.set(entry.port, index);
          // The page matches an output by part of its name, so a port that is part of another entry's port
          // (or contains it) would find that entry's device: one model's reset could reach the other's.
          const overlap = parsed.data.instruments.findIndex(
            (earlier, position) => position < index && (earlier.port.includes(entry.port) || entry.port.includes(earlier.port)),
          );
          if (overlap !== -1) {
            const other = (parsed.data.instruments[overlap] as { id: string }).id;
            problems.push({
              field: `${at}.port`,
              reason: `port and the port of instruments[${overlap}] ("${other}") are part of each other, so both match the same output`,
            });
            usable = false;
          }
        }
        const model = this.shipped.get(entry.model) ?? user.models.get(entry.model);
        if (model === undefined) {
          problems.push({ field: `${at}.model`, reason: `unknown model "${entry.model}", known models: ${known.join(', ')}` });
          return;
        }
        const all = [...model.channels.melodic, ...model.channels.rhythm].sort((a, b) => a - b);
        entry.channels?.forEach((channel, position) => {
          if (!all.includes(channel)) {
            problems.push({
              field: `${at}.channels[${position}]`,
              reason: `channel ${channel} is not a channel of model ${model.id} (channels: ${ranges(all)})`,
            });
            usable = false;
          } else if (entry.channels?.indexOf(channel) !== position) {
            problems.push({ field: `${at}.channels[${position}]`, reason: `channel ${channel} is listed twice` });
            usable = false;
          }
        });
        if (!usable) return;
        const channels = (entry.channels ?? all).map((channel) => ({
          channel,
          role: model.channels.rhythm.includes(channel) ? ('rhythm' as const) : ('melodic' as const),
        }));
        if (!catalogs.has(model.id)) {
          const result = readCatalogFile(dir, model);
          problems.push(...result.problems);
          catalogs.set(model.id, result.catalog);
        }
        instruments.push({ id: entry.id, port: entry.port, model, channels, catalog: catalogs.get(model.id) ?? null, clock: entry.clock ?? model.clock ?? false, enabled: !off.has(entry.id) });
      });
    }
    if (!state.ok) problems.push(...state.problems);
    problems.push(...user.problems);
    if (problems.length > 0) return invalid(problems);
    return { setup: 'valid', instruments };
  }
}

/**
 * The state file now: the ids the user switched off, or why it cannot be read. A missing file means none are off.
 * Nothing falls back to "all on": the first problem ends with the way out (delete the file).
 */
function readOffIds(dir: string): { ok: true; off: Set<string> } | { ok: false; problems: Problem[] } {
  const hint = '; delete the file to switch every instrument on';
  const broken = (problems: Problem[]): { ok: false; problems: Problem[] } => {
    const [first, ...rest] = problems;
    return { ok: false, problems: first === undefined ? problems : [{ field: first.field, reason: `${first.reason}${hint}` }, ...rest] };
  };
  let text: string;
  try {
    text = readFileSync(path.join(dir, RIG_STATE_FILE_NAME), 'utf8');
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return { ok: true, off: new Set() };
    return broken([{ field: RIG_STATE_FILE_NAME, reason: `could not be read: ${errnoCode(err)}` }]);
  }
  const json = parseJsonText(text);
  if (!json.ok) return broken([{ field: RIG_STATE_FILE_NAME, reason: json.reason }]);
  const parsed = rigStateSchema.safeParse(json.value);
  if (!parsed.success) return broken(problemsFromZod(parsed.error, RIG_STATE_FILE_NAME));
  return { ok: true, off: new Set(parsed.data.off) };
}

/** The line Claude reads when the setup file is invalid: up to 3 problems, then how many more. */
export function rigInvalidLine(problems: Problem[], more: number): string {
  const shown = problems
    .slice(0, 3)
    .map((problem) => `${cleanMidiName(problem.field)}: ${cleanMidiName(problem.reason)}`)
    .join('; ');
  const rest = Math.max(0, problems.length - 3) + more;
  return `MIDI: instruments.json is invalid: ${shown}${rest > 0 ? `, and ${rest} more` : ''}. No instruments are set up until it is fixed.`;
}

function quotedIds(ids: string[]): string {
  return ids.map((id) => `"${id}"`).join(', ');
}

/**
 * The lines Claude reads about the user's on/off choice. Facts only, and they never name the
 * setup file, so the filters that look for its name stay true. Ids pass idSchema, so they hold no quote.
 * The first read of a state that has instruments off:
 */
export function rigOffAtStartLine(ids: string[]): string {
  const one = ids.length === 1;
  return `MIDI: the user has ${quotedIds(ids)} switched off. ${one ? 'Its notes are' : 'Their notes are'} silent; .midi() code newly aimed at ${one ? 'it is' : 'them is'} refused until the user switches ${one ? 'it' : 'them'} on.`;
}

/** Instruments the user switched off since the last read. */
export function rigSwitchedOffLine(ids: string[]): string {
  const one = ids.length === 1;
  return `MIDI: the user switched ${quotedIds(ids)} off. ${one ? 'Its notes are' : 'Their notes are'} silent; .midi() code newly aimed at ${one ? 'it is' : 'them is'} refused until the user switches ${one ? 'it' : 'them'} on.`;
}

/** Instruments the user switched on since the last read. */
export function rigSwitchedOnLine(ids: string[]): string {
  const head = `MIDI: the user switched ${quotedIds(ids)} on;`;
  return ids.length === 1 ? `${head} it is reset and set up again.` : `${head} they are reset and set up again.`;
}

/** The line Claude reads when a setup file that was invalid is valid again. */
export function rigValidAgainLine(count: number): string {
  return `MIDI: instruments.json is valid again: ${count} ${count === 1 ? 'instrument' : 'instruments'}.`;
}

/** The line Claude reads when a setup file that was there is gone. */
export function rigRemovedLine(): string {
  return 'MIDI: instruments.json was removed, so ports and sounds in .midi() calls are not checked any more.';
}

type ResetMessage = z.infer<typeof resetMessageSchema>;

/** The bytes of one reset message of a valid model: a Roland DT1 gets device 10 and its checksum, a raw one is as written. */
function resetMessageBytes(message: ResetMessage): number[] {
  return message.kind === 'roland-dt1'
    ? rolandDt1(0x10, hexBytes(message.model)[0] ?? 0, hexBytes(message.address), hexBytes(message.data))
    : hexBytes(message.bytes);
}

/** The `midi-rig` message of a setup state: reset bytes are built here, so the page never needs the checksum. */
export function rigMessage(state: RigState): Extract<ServerMessage, { type: 'midi-rig' }> {
  if (state.setup === 'absent') return { type: 'midi-rig', setup: 'absent' };
  if (state.setup === 'invalid') {
    return {
      type: 'midi-rig',
      setup: 'invalid',
      problems: state.problems.slice(0, MAX_RIG_PROBLEMS),
      more: state.more + Math.max(0, state.problems.length - MAX_RIG_PROBLEMS),
    };
  }
  const instruments: RigInstrumentMessage[] = state.instruments.map((instrument) => {
    const { model } = instrument;
    const reset =
      model.reset === undefined
        ? null
        : {
            messages: model.reset.sysex.map(resetMessageBytes),
            waitMs: model.reset.waitMs,
          };
    // The catalog sounds follow the model's own in the melodic list, so the page resolves a catalog
    // name like a model name. The category stays on the server. There is no cache: the catalog is read
    // at every use (about 10 ms for 5,000 sounds), and a push goes out only when its JSON changed.
    const catalogSounds = (instrument.catalog?.sounds ?? []).map((sound) =>
      sound.bank === undefined ? { name: sound.name, program: sound.program } : { name: sound.name, program: sound.program, bank: sound.bank },
    );
    // The catalog kits follow the model's own in the rhythm list, resolved by the same sound option.
    const catalogKits = (instrument.catalog?.kits ?? []).map((kit) => ({
      name: kit.name,
      program: kit.program,
      ...(kit.bank === undefined ? {} : { bank: kit.bank }),
      ...(kit.noteMap === undefined ? {} : { noteMap: kit.noteMap }),
    }));
    return {
      id: instrument.id,
      model: model.id,
      modelName: model.name,
      port: instrument.port,
      channels: instrument.channels,
      bankSelect: model.bankSelect,
      defaultVolume: model.defaultVolume,
      clock: instrument.clock,
      // A copy of exactly these six keys, so no other key of the model rides along to the page.
      controls: model.controls.map((control) => ({ id: control.id, name: control.name, cc: control.cc, min: control.min, max: control.max, default: control.default })),
      reset,
      // The rhythm sounds are copied key by key, so no other key of the model rides along to the page.
      sounds: {
        melodic: [...model.sounds.melodic, ...catalogSounds],
        rhythm: [
          ...model.sounds.rhythm.map((sound) => ({
            name: sound.name,
            program: sound.program,
            ...(sound.bank === undefined ? {} : { bank: sound.bank }),
            ...(sound.noteMap === undefined ? {} : { noteMap: sound.noteMap }),
          })),
          ...catalogKits,
        ],
      },
      catalogSounds: catalogSounds.length,
      // The drum fields (kits and note maps) form one block, kept together; the fields after it extend the message.
      rhythmBank: model.rhythmBank === true,
      drumMap: model.drumMap ?? null,
      drumMaps: mapsToSend(model, [...model.sounds.rhythm, ...catalogKits]),
      catalogKits: catalogKits.length,
      // The fields the Instruments view's switch and settings editor read.
      enabled: instrument.enabled,
      // Every channel of the model, so the editor can offer them all (the chosen ones are in `channels`).
      modelChannels: [
        ...model.channels.melodic.map((channel) => ({ channel, role: 'melodic' as const })),
        ...model.channels.rhythm.map((channel) => ({ channel, role: 'rhythm' as const })),
      ].sort((a, b) => a.channel - b.channel),
    };
  });
  return { type: 'midi-rig', setup: 'valid', instruments };
}

/**
 * Whether a port is connected right now, from the last MIDI facts of the active page: 'unknown' while
 * the page has not enabled Web MIDI (never 'no' then), else Strudel's own rule: an output matches when
 * its name contains the port. One match is 'yes', none is 'no', several are listed.
 */
export function connectionOf(port: string, facts: MidiFacts | null): string {
  if (facts === null || facts.access !== 'enabled') return 'unknown (the page has not enabled Web MIDI)';
  const matches = facts.outputs.filter((output) => output.includes(port));
  if (matches.length === 0) return 'no';
  if (matches.length === 1) return 'yes';
  return `several outputs match (${matches.map(quoteMidiName).join(', ')})`;
}

export interface DescribeOptions {
  /** Connected right now for a port, as text (see connectionOf). */
  connection: (port: string) => string;
  /** The shipped models, id then display name. */
  shipped: { id: string; name: string }[];
  /** The data folder, as text. */
  dataDirText: string;
}

/** A port as Claude copies it into code: JSON-quoted, never cut, with the line separators escaped. */
function quotePort(port: string): string {
  return JSON.stringify(port).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/** The text of a setup state that holds no instruments: no file, or a file with problems. */
function noInstrumentsText(state: Exclude<RigState, { setup: 'valid' }>, options: DescribeOptions): string {
  if (state.setup === 'absent') {
    const shipped = options.shipped.map((model) => `${model.id} (${model.name})`).join(', ');
    return (
      `No ${RIG_FILE_NAME} in the Moontide data folder (${options.dataDirText}), so ports and sounds in .midi() calls are not checked. ` +
      `To describe instruments, the user writes ${RIG_FILE_NAME} there, for example: ` +
      '{"instruments": [{"id": "synth", "model": "sc55", "port": "exact output name", "channels": [1, 2, 10]}]}. ' +
      `Models shipped with Moontide: ${shipped}.`
    );
  }
  const lines = [`${RIG_FILE_NAME} is invalid, so no instruments are set up until it is fixed:`];
  for (const problem of state.problems) lines.push(`- ${problem.field}: ${problem.reason}`);
  if (state.more > 0) lines.push(`- and ${state.more} more problems`);
  return lines.join('\n');
}

const rangesOf = (instrument: RigInstrument, role: 'melodic' | 'rhythm'): string =>
  ranges(instrument.channels.filter((entry) => entry.role === role).map((entry) => entry.channel));

const notesText = (count: number): string => `${count} ${count === 1 ? 'note' : 'notes'}`;

/** At most five names, then how many more. */
function nameList(names: string[]): string {
  return names.length <= 5 ? names.join(', ') : `${names.slice(0, 5).join(', ')}, and ${names.length - 5} more`;
}

/** What the map of a kit is read from: its name and its noteMap key. */
type KitMapKey = { name: string; noteMap?: string | null | undefined };

/**
 * The kits of a model by their map, every kit resolved by kitDrumMap and never by a second rule. A kit has
 * its own map when it names one other than the model's; a kit has no known map when the rule says unknown. The kits
 * are the model's own and the kits of its catalog, the same list rigMessage sends to the page.
 */
function kitMaps(model: InstrumentModel, catalogKits: readonly KitMapKey[] = []): { own: { name: string; map: DrumMap }[]; unknown: string[] } {
  const own: { name: string; map: DrumMap }[] = [];
  const unknown: string[] = [];
  for (const kit of [...model.sounds.rhythm, ...catalogKits]) {
    const use = kitDrumMap(model, kit);
    if (use.state === 'unknown') unknown.push(kit.name);
    else if (use.via === 'kit' && use.map.id !== model.drumMap) own.push({ name: kit.name, map: use.map });
  }
  return { own, unknown };
}

const ownKitsClause = (own: { name: string }[]): string =>
  `${own.length} ${own.length === 1 ? 'kit has its own map' : 'kits have their own map'} (${nameList(own.map((kit) => kit.name))})`;

/** The Drum map line of an instrument with a rhythm channel. */
function drumMapLine(instrument: RigInstrument): string {
  const { model } = instrument;
  const use = kitDrumMap(model, null);
  const { own, unknown } = kitMaps(model, instrument.catalog?.kits);
  const tail = `. get_midi_instruments with instrument "${instrument.id}" lists the notes.`;
  if (use.state === 'known') {
    const clauses: string[] = [];
    if (own.length > 0) clauses.push(ownKitsClause(own));
    if (unknown.length > 0) clauses.push(`no map is known for ${unknown.length} ${unknown.length === 1 ? 'kit' : 'kits'} (${nameList(unknown)})`);
    const scope = clauses.length > 0 ? ` for kits without their own map; ${clauses.join('; ')}` : '';
    return `  Drum map: "${use.map.name}" (${notesText(use.map.notes.length)})${scope}${tail}`;
  }
  if (own.length > 0) return `  Drum map: unknown for kits without their own map; ${ownKitsClause(own)}${tail}`;
  return '  Drum map: unknown. Drum notes are numbers only.';
}

/** The line under an instrument the user switched off in the page (indented in the summary, bare in the single-instrument text). */
const SWITCHED_OFF_LINE = '  Switched off: the user switched this instrument off in the page.';

/** The summary Claude reads without an argument: each instrument of the setup file, as facts. */
export function describeRig(state: RigState, options: DescribeOptions): string {
  if (state.setup !== 'valid') return noInstrumentsText(state, options);
  const lines = [`Instruments in ${RIG_FILE_NAME}, in file order:`];
  const off = state.instruments.filter((instrument) => !instrument.enabled).map((instrument) => instrument.id);
  if (off.length === 1) {
    lines.push(
      `Switched off by the user: ${off[0]}. Its notes are silent; .midi() code newly aimed at it is refused until the user switches it on; music already playing that names it stays in place and plays nothing on it.`,
    );
  } else if (off.length > 1) {
    lines.push(
      `Switched off by the user: ${off.join(', ')}. Their notes are silent; .midi() code newly aimed at them is refused until the user switches them on; music already playing that names them stays in place and plays nothing on them.`,
    );
  }
  for (const instrument of state.instruments) {
    const { model } = instrument;
    lines.push(`- ${instrument.id}: ${model.name} (model ${model.id}), port ${quotePort(instrument.port)}, connected: ${options.connection(instrument.port)}.`);
    if (!instrument.enabled) lines.push(SWITCHED_OFF_LINE);
    const melodic = rangesOf(instrument, 'melodic');
    const rhythm = rangesOf(instrument, 'rhythm');
    const roles = [melodic === '' ? '' : `${melodic} melodic`, rhythm === '' ? '' : `${rhythm} rhythm`].filter((part) => part !== '');
    lines.push(`  Channels: ${roles.join('; ')}.`);
    lines.push(`  Sounds: ${model.sounds.melodic.length} melodic, ${model.sounds.rhythm.length} rhythm.`);
    if (instrument.catalog !== null) lines.push(`  ${catalogLine(instrument.id, instrument.catalog)}`);
    lines.push(`  Bank select: ${model.bankSelect === 'none' ? 'none' : model.bankSelect === 'msb' ? 'CC0' : 'CC0 then CC32'}.`);
    // How a kit goes out, so Claude knows whether a kit carries a bank on this instrument.
    if (instrument.channels.some((entry) => entry.role === 'rhythm')) {
      const kit =
        model.rhythmBank === true
          ? `a kit goes out as its bank select (${model.bankSelect === 'msb' ? 'CC0' : 'CC0 then CC32'}) and its program change.`
          : 'a kit goes out as a program change alone, with no bank select.';
      lines.push(`  Rhythm: kits are chosen like sounds, by name with the sound option on a rhythm channel; ${kit}`);
      lines.push(drumMapLine(instrument));
    }
    if (model.reset === undefined) {
      lines.push('  Reset when it connects: none.');
    } else {
      const count = model.reset.sysex.length;
      lines.push(`  Reset when it connects: ${count} SysEx ${count === 1 ? 'message' : 'messages'}, then a ${model.reset.waitMs} ms wait.`);
    }
    lines.push(
      instrument.clock
        ? '  Clock: follows MIDI clock; Moontide sends the clock, Start and Stop while the playing code names this instrument.'
        : '  Clock: none.',
    );
    lines.push(
      model.controls.length === 0
        ? '  Controls: none.'
        : `  Controls: ${model.controls.map((control) => `${control.id} CC${control.cc} ${control.min}-${control.max} (default ${control.default})`).join(', ')}`,
    );
    if (model.notes.length > 0) lines.push(`  Notes: ${model.notes.join(' ')}`);
  }
  lines.push(
    "Choose a sound with the sound option of .midi(): .midi('port name', { midichannel: 3, sound: 'sound name' }). " +
      "Set a control's static level with controls in the same options: .midi('port name', { midichannel: 3, controls: { volume: 100 } }), with the ids and ranges of the Controls lines; a sweep stays ccn and ccv. " +
      `One instrument's full sound list: get_midi_instruments with instrument set to its id.`,
  );
  return lines.join('\n');
}

function soundLine(sound: ModelSound): string {
  if (sound.bank === undefined) return `${sound.program} ${sound.name}`;
  const bank = sound.bank.lsb === undefined ? `${sound.bank.msb}` : `${sound.bank.msb}/${sound.bank.lsb}`;
  return `${sound.program} ${sound.name} (bank ${bank})`;
}

/** A drum map as Claude reads it: its name, its count, what it is for when it is not the whole model's, and its notes in note order. */
function mapListLine(map: DrumMap, scope: string | null): string {
  const notes = [...map.notes].sort((a, b) => a.note - b.note).map((entry) => `${entry.note} ${entry.name}`);
  return `Drum map "${map.name}" (${notesText(map.notes.length)})${scope === null ? '' : `, ${scope}`}: ${notes.join(', ')}`;
}

/** The map lines of one instrument: the model's map, each own map with its kits, and where no map is known. */
function drumMapLines(model: InstrumentModel, catalogKits: readonly KitMapKey[]): string[] {
  const use = kitDrumMap(model, null);
  const { own, unknown } = kitMaps(model, catalogKits);
  const lines: string[] = [];
  if (use.state === 'known') lines.push(mapListLine(use.map, own.length > 0 || unknown.length > 0 ? 'for kits without their own map' : null));
  const groups = new Map<string, { map: DrumMap; kits: string[] }>();
  for (const kit of own) {
    const group = groups.get(kit.map.id) ?? { map: kit.map, kits: [] };
    group.kits.push(kit.name);
    groups.set(kit.map.id, group);
  }
  for (const group of groups.values()) lines.push(mapListLine(group.map, `for ${group.kits.join(', ')}`));
  if (unknown.length > 0) lines.push(`No note map is known for: ${nameList(unknown)}. Notes there are numbers only.`);
  else if (use.state === 'unknown') {
    lines.push(
      model.sounds.rhythm.length + catalogKits.length === 0
        ? 'No note map is known for this instrument. Drum notes are numbers only.'
        : 'No note map is known when the code names no kit. Notes there are numbers only.',
    );
  }
  return lines;
}

/** One instrument's full sound list: program as sent, bank when there is one, in program order. */
export function describeInstrument(state: RigState, id: string, options: DescribeOptions): string {
  if (state.setup !== 'valid') return noInstrumentsText(state, options);
  const instrument = state.instruments.find((candidate) => candidate.id === id);
  if (instrument === undefined) {
    throw new Error(`Unknown instrument ${JSON.stringify(id)}. Instruments in ${RIG_FILE_NAME}: ${state.instruments.map((entry) => entry.id).join(', ')}.`);
  }
  const lines = [
    `${instrument.id}: ${instrument.model.name}, port ${quotePort(instrument.port)}. ` +
      'Sounds as the sound option of .midi() takes them; the number is the program sent (0-127), with the bank when there is one.',
  ];
  if (!instrument.enabled) lines.push(SWITCHED_OFF_LINE.trimStart());
  for (const role of ['melodic', 'rhythm'] as const) {
    const channels = rangesOf(instrument, role);
    if (channels === '') continue;
    lines.push('', role === 'melodic' ? `Melodic, channels ${channels}:` : `Rhythm, channel ${channels}:`);
    const sounds = [...instrument.model.sounds[role]].sort(
      (a, b) => a.program - b.program || (a.bank?.msb ?? -1) - (b.bank?.msb ?? -1) || (a.bank?.lsb ?? -1) - (b.bank?.lsb ?? -1),
    );
    if (sounds.length === 0) lines.push('no sounds to choose.');
    for (const sound of sounds) lines.push(soundLine(sound));
  }
  if (instrument.channels.some((entry) => entry.role === 'rhythm')) lines.push('', ...drumMapLines(instrument.model, instrument.catalog?.kits ?? []));
  if (instrument.catalog !== null) lines.push('', catalogLine(instrument.id, instrument.catalog));
  return lines.join('\n');
}

/**
 * What search_midi_sounds says: the matches of a search in the catalog of one instrument. Throws
 * an Error with the reason for every case that has nothing to search, in this order: a setup with no
 * instruments, an unknown instrument, an instrument with no catalog, a search with no words and no
 * category, a category the catalog does not have.
 */
export function describeSearch(
  state: RigState,
  search: { instrument: string; query?: string; category?: string },
  options: DescribeOptions,
): string {
  if (state.setup !== 'valid') throw new Error(noInstrumentsText(state, options));
  const instrument = state.instruments.find((candidate) => candidate.id === search.instrument);
  if (instrument === undefined) {
    throw new Error(`Unknown instrument ${JSON.stringify(search.instrument)}. Instruments in ${RIG_FILE_NAME}: ${state.instruments.map((entry) => entry.id).join(', ')}.`);
  }
  const quoted = JSON.stringify(instrument.id);
  if (instrument.catalog === null) {
    throw new Error(`Instrument ${quoted} has no sound catalog. Its sounds are listed by get_midi_instruments with instrument ${quoted}.`);
  }
  if (soundKey(search.query ?? '') === '' && soundKey(search.category ?? '') === '') {
    throw new Error(`Nothing to search for: give query (words of the sound name or its category), category, or both, with instrument ${quoted}.`);
  }
  const result = searchCatalog(instrument.catalog, { query: search.query, category: search.category });
  if (result.unknownCategory) {
    const asked = JSON.stringify(cleanProblemText(search.category ?? ''));
    throw new Error(`Unknown category ${asked} in the catalog of ${quoted}. ${categoriesSentence(instrument.catalog, 'Categories: ')}`);
  }
  return searchReply({ id: instrument.id, modelName: instrument.model.name, model: instrument.model, catalog: instrument.catalog, result });
}

type ModelSound = InstrumentModel['sounds']['melodic'][number];

/** The first and last sound of a list, each with its program as sent and as a manual numbered from 1 counts it. */
function soundsSummary(label: string, sounds: ModelSound[]): string {
  const first = sounds[0];
  const last = sounds[sounds.length - 1];
  if (first === undefined || last === undefined) return `${label} sounds: none.`;
  return (
    `${label} sounds: ${sounds.length}, from "${first.name}" (program ${first.program} as sent, ${first.program + 1} in a manual numbered from 1) ` +
    `to "${last.name}" (program ${last.program}, ${last.program + 1}).`
  );
}

/** The drum map facts of a draft, so nothing that reaches Claude later hides behind the user's yes. */
function drumMapSummary(model: InstrumentModel): string[] {
  const lines: string[] = [];
  const own = model.drumMaps ?? [];
  for (const map of own) {
    const sorted = [...map.notes].sort((a, b) => a.note - b.note);
    const first = sorted[0] as { note: number; name: string };
    const last = sorted[sorted.length - 1] as { note: number; name: string };
    lines.push(`Drum map "${map.id}": "${map.name}", ${notesText(map.notes.length)}, from ${first.note} ${first.name} to ${last.note} ${last.name}.`);
  }
  if (model.drumMap === undefined) lines.push('Default drum map: none, so kits without their own map have no known map.');
  else if (!own.some((map) => map.id === model.drumMap)) lines.push(`Default drum map: ${model.drumMap} (built in).`);
  else lines.push(`Default drum map: ${model.drumMap}.`);
  const kits = kitMaps(model);
  if (kits.own.length > 0) lines.push(`Kits with their own map: ${nameList(kits.own.map((kit) => `${kit.name} (${kit.map.id})`))}.`);
  if (kits.unknown.length > 0) lines.push(`Kits with no known map: ${nameList(kits.unknown)}.`);
  return lines;
}

/**
 * What the user is shown before a drafted model is saved, one fact per line: the exact reset
 * bytes and every note in full, so nothing that reaches hardware or Claude later is hidden in the yes.
 */
export function summarizeDraft(model: InstrumentModel): string {
  const lines = [`Model "${model.id}": ${model.name}.`];
  const melodic = ranges(model.channels.melodic);
  const rhythm = ranges(model.channels.rhythm);
  const roles = [melodic === '' ? '' : `${melodic} melodic`, rhythm === '' ? '' : `${rhythm} rhythm`].filter((part) => part !== '');
  lines.push(`Channels: ${roles.length === 0 ? 'none' : roles.join('; ')}.`);
  const bank = model.bankSelect === 'none' ? 'none' : model.bankSelect === 'msb' ? 'CC0' : 'CC0 then CC32';
  lines.push(`Bank select: ${bank}. Default volume: ${model.defaultVolume}.`);
  if (model.channels.rhythm.length > 0) {
    lines.push(model.rhythmBank === true ? 'Rhythm kits: chosen by bank select and program change.' : 'Rhythm kits: chosen by program change alone.');
    lines.push(...drumMapSummary(model));
  }
  lines.push(soundsSummary('Melodic', model.sounds.melodic));
  lines.push(soundsSummary('Rhythm', model.sounds.rhythm));
  lines.push(
    model.controls.length === 0
      ? 'Controls: none.'
      : `Controls: ${model.controls.map((control) => `${control.id} CC${control.cc} ${control.min}-${control.max} (default ${control.default})`).join(', ')}`,
  );
  if (model.reset === undefined) {
    lines.push('Reset when it connects: none.');
  } else {
    const messages = model.reset.sysex.map((message) => resetMessageBytes(message).map(hex2).join(' ')).join(' | ');
    lines.push(`Reset when it connects: ${messages}, then a ${model.reset.waitMs} ms wait.`);
  }
  lines.push(model.clock === true ? 'Clock: follows MIDI clock.' : 'Clock: none.');
  if (model.notes.length > 0) {
    lines.push('Notes:');
    for (const note of model.notes) lines.push(`- ${note}`);
  }
  return lines.join('\n');
}

/** The reply for a model id that belongs to a shipped model. */
export function shippedIdText(id: string): string {
  return `Model id "${id}" belongs to a model Moontide ships; choose another id.`;
}

/** The reply for a drafted model that is not valid: each field and reason, at most MAX_RIG_PROBLEMS lines, then the rest counted. */
export function invalidModelText(problems: Problem[]): string {
  const lines = ['The model is invalid:'];
  for (const problem of problems.slice(0, MAX_RIG_PROBLEMS)) {
    lines.push(`- ${cleanProblemText(problem.field)}: ${cleanProblemText(problem.reason)}`);
  }
  if (problems.length > MAX_RIG_PROBLEMS) lines.push(`- and ${problems.length - MAX_RIG_PROBLEMS} more problems`);
  return lines.join('\n');
}

/** A refusal or failure of a model save; the message is the reply Claude reads. */
export class ModelSaveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelSaveError';
  }
}

/**
 * Writes a model that parseModel already accepted to `<dataDir>/models/<id>.json`. The path is
 * built only from the validated id, so it cannot leave the models folder. Without `overwrite` the write
 * creates the file only if absent; with it the text goes to a temporary file that is renamed over the
 * old one. A model id Moontide ships is always refused. Returns the file written.
 */
export function saveUserModel(options: { dataDir: string; model: InstrumentModel; overwrite: boolean }): string {
  const { dataDir, model, overwrite } = options;
  const shipped = readdirSync(shippedModelsDir()).filter((file) => file.endsWith('.json'));
  if (shipped.includes(`${model.id}.json`)) {
    throw new ModelSaveError(shippedIdText(model.id));
  }
  const folder = path.join(dataDir, MODELS_DIR_NAME);
  const file = path.join(folder, `${model.id}.json`);
  const text = `${JSON.stringify(model, null, 2)}\n`;
  try {
    mkdirSync(folder, { recursive: true });
  } catch (err) {
    throw new ModelSaveError(`Model "${model.id}" could not be saved: ${errnoCode(err)}.`);
  }
  try {
    if (overwrite) {
      const temporary = `${file}.tmp`;
      writeFileSync(temporary, text);
      try {
        renameWithRetry(temporary, file);
      } catch (err) {
        try {
          unlinkSync(temporary);
        } catch {
          // The temporary file is already gone or cannot be removed; the rename error is the one to report.
        }
        throw err;
      }
    } else {
      writeFileSync(file, text, { flag: 'wx' });
    }
  } catch (err) {
    if (!overwrite && errnoCode(err) === 'EEXIST') {
      throw new ModelSaveError(`Model "${model.id}" already exists in the data folder; pass overwrite: true to replace it.`);
    }
    throw new ModelSaveError(`Model "${model.id}" could not be saved: ${errnoCode(err)}.`);
  }
  return file;
}

/** The state file could not be written. The message is the reason the page shows: an error code, never a path. */
export class RigStateSaveError extends Error {
  code: string;
  constructor(code: string) {
    super(`the choice could not be saved (${code}); nothing changed`);
    this.name = 'RigStateSaveError';
    this.code = code;
  }
}

/**
 * Writes the instruments the user switched off to `<dataDir>/instruments-state.json`, whole, through a
 * temporary file that is renamed over the old one (a crash never leaves half a file, and a failed write leaves
 * the old file as it was). Throws RigStateSaveError, which carries the error code only: the data folder can hold
 * the user's name, so no path rides along.
 */
export function writeRigState(options: { dataDir: string; off: string[] }): void {
  const { dataDir, off } = options;
  const file = path.join(dataDir, RIG_STATE_FILE_NAME);
  const temporary = `${file}.tmp`;
  const text = `${JSON.stringify({ off }, null, 2)}\n`;
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(temporary, text);
    renameWithRetry(temporary, file);
  } catch (err) {
    try {
      unlinkSync(temporary);
    } catch {
      // The temporary file is not there, or is not a file; the write error is the one to report.
    }
    throw new RigStateSaveError(errnoCode(err));
  }
}

/** What the user chose on a card: the full set of the three editable settings, never a difference. */
export type SettingsChoice = { port: string; channels: number[]; clock: boolean };

/** The result of a settings edit. Every reason is plain text with no path; `invalid` holds the problems a hand edit would get. */
export type SettingsOutcome =
  | { kind: 'saved'; before: RigInstrument; after: RigInstrument }
  | { kind: 'unchanged' }
  | { kind: 'refused'; reason: string }
  | { kind: 'invalid'; problems: Problem[]; more: number }
  | { kind: 'write-failed'; reason: string };

/** How the user's instruments.json looks, so a rewrite keeps it: indentation, line ending and the final line break. */
export interface RigFileStyle {
  indent: string;
  eol: '\n' | '\r\n';
  finalNewline: boolean;
}

/**
 * The look of a setup file text. The line ending is CRLF when the text holds one; the indentation
 * is the leading whitespace of the first line that has some (a tab, or that many spaces), else two spaces; the
 * final newline is kept when the text ends with a line break.
 */
export function rigFileStyle(text: string): RigFileStyle {
  const eol: '\n' | '\r\n' = text.includes('\r\n') ? '\r\n' : '\n';
  let indent = '  ';
  for (const line of text.split('\n')) {
    const lead = /^[ \t]+/.exec(line);
    if (lead !== null) {
      indent = lead[0];
      break;
    }
  }
  return { indent, eol, finalNewline: text.endsWith('\n') };
}

function formatNode(value: unknown, style: RigFileStyle, depth: number): string {
  const pad = (level: number): string => style.indent.repeat(level);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    // A list of numbers (the channels) stays on one line; any other list has an item per line.
    if (value.every((item) => typeof item === 'number')) return `[${value.map((item) => JSON.stringify(item)).join(', ')}]`;
    const items = value.map((item) => `${pad(depth + 1)}${formatNode(item, style, depth + 1)}`);
    return `[${style.eol}${items.join(`,${style.eol}`)}${style.eol}${pad(depth)}]`;
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 0) return '{}';
    const members = keys.map((key) => `${pad(depth + 1)}${JSON.stringify(key)}: ${formatNode((value as Record<string, unknown>)[key], style, depth + 1)}`);
    return `{${style.eol}${members.join(`,${style.eol}`)}${style.eol}${pad(depth)}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * The setup file text of a parsed value in the look of `style`. Keys stay in insertion order (the
 * caller passes the raw JSON.parse value, never the zod output, which reorders keys), a list of numbers is on one
 * line, and nothing here reads JSON text with an expression.
 */
export function formatRigFile(value: unknown, style: RigFileStyle): string {
  return `${formatNode(value, style, 0)}${style.finalNewline ? style.eol : ''}`;
}

/**
 * Assigns the three settings a card can change on the raw entry of instruments.json, and nothing else: the port
 * when it differs, the channels (sorted ascending) when the set differs, the clock when the effective value
 * differs. Returns whether anything changed. The chosen object is never spread, so the model, the id and any
 * other key of the message cannot reach the file.
 */
function patchEntry(raw: Record<string, unknown>, chosen: SettingsChoice, current: RigInstrument): boolean {
  let changed = false;
  if (chosen.port !== current.port) {
    raw.port = chosen.port;
    changed = true;
  }
  // An entry with no "channels" key plays every channel of its model, so that is what `current.channels` holds
  // then: choosing them all changes nothing and the key stays absent, instead of writing a list nobody asked for.
  const now = current.channels.map((entry) => entry.channel).sort((a, b) => a - b);
  const next = [...chosen.channels].sort((a, b) => a - b);
  if (next.length !== now.length || next.some((channel, index) => channel !== now[index])) {
    raw.channels = next;
    changed = true;
  }
  // The effective clock is the entry's own or else the model's; the entry wins, so a change is written explicitly.
  if (chosen.clock !== current.clock) {
    raw.clock = chosen.clock;
    changed = true;
  }
  return changed;
}

/**
 * Changes the port, channels and clock of one instrument in the user's instruments.json.
 * The patched value is checked by the same code that reads the file (RigStore.validateRigValue), so a channel the
 * model lacks or two instruments on one port come back as the problems a hand edit would get and nothing is
 * written. An accepted edit is written whole to a temporary file and the file is read once more: when it is no
 * longer the text this edit started from, someone else wrote it meanwhile and nothing is saved (the backup is left
 * as it was). Otherwise the previous bytes go to `instruments.json.bak` (through a temporary file and a rename) and
 * the new file takes the place of the old one. Reasons carry an error code at most, never a path.
 */
export function applyInstrumentSettings(store: RigStore, id: string, chosen: SettingsChoice): SettingsOutcome {
  const refused = (reason: string): SettingsOutcome => ({ kind: 'refused', reason });
  let dir: string;
  try {
    dir = store.resolveDataDir();
  } catch {
    return refused('the Moontide data folder could not be found, so nothing was saved');
  }
  const file = path.join(dir, RIG_FILE_NAME);
  let original: Buffer;
  try {
    original = readFileSync(file);
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return refused('there is no instruments.json, so there is nothing to change');
    return refused(`instruments.json could not be read (${errnoCode(err)}), so nothing was saved`);
  }
  const text = original.toString('utf8');
  const before = store.read();
  if (before.setup === 'absent') return refused('there is no instruments.json, so there is nothing to change');
  if (before.setup === 'invalid') return refused('instruments.json has a problem, so nothing was saved');
  const current = before.instruments.find((instrument) => instrument.id === id);
  if (current === undefined) return refused(`there is no instrument "${cleanProblemText(id)}" in instruments.json`);

  // The raw parsed value keeps the user's key order (the zod output would not).
  const json = parseJsonText(text);
  const list = json.ok && json.value !== null && typeof json.value === 'object' ? (json.value as { instruments?: unknown }).instruments : undefined;
  if (!json.ok || !Array.isArray(list)) return refused('instruments.json has a problem, so nothing was saved');
  const entry = list.find((candidate): candidate is Record<string, unknown> => candidate !== null && typeof candidate === 'object' && (candidate as { id?: unknown }).id === id);
  if (entry === undefined) return refused(`there is no instrument "${cleanProblemText(id)}" in instruments.json`);
  if (!patchEntry(entry, chosen, current)) return { kind: 'unchanged' };

  const candidate = store.validateRigValue(json.value);
  if (candidate.setup === 'invalid') return { kind: 'invalid', problems: candidate.problems, more: candidate.more };
  const after = candidate.setup === 'valid' ? candidate.instruments.find((instrument) => instrument.id === id) : undefined;
  if (after === undefined) return refused('instruments.json has a problem, so nothing was saved');

  const next = formatRigFile(json.value, rigFileStyle(text));
  if (Buffer.byteLength(next, 'utf8') > MAX_RIG_FILE_BYTES) return refused('instruments.json would become too large, so nothing was saved');
  const temporary = `${file}.tmp`;
  const backup = `${file}.bak`;
  const removeTemporary = (): void => {
    try {
      unlinkSync(temporary);
    } catch {
      // The temporary file is not there, or is not a file; the write error is the one to report.
    }
  };
  try {
    writeFileSync(temporary, next);
  } catch (err) {
    removeTemporary();
    return { kind: 'write-failed', reason: `the file system answered ${errnoCode(err)}` };
  }
  let again: Buffer | null;
  try {
    again = readFileSync(file);
  } catch {
    again = null;
  }
  if (again === null || !again.equals(original)) {
    // Checked before the backup is touched: a refused edit leaves instruments.json.bak as it was.
    removeTemporary();
    return refused('instruments.json changed while saving, so nothing was saved');
  }
  // The backup goes through its own temporary file and a rename, so a crash never leaves a truncated backup.
  const backupTemporary = `${backup}.tmp`;
  try {
    writeFileSync(backupTemporary, original);
    renameWithRetry(backupTemporary, backup);
  } catch (err) {
    removeTemporary();
    try {
      unlinkSync(backupTemporary);
    } catch {
      // The temporary backup is not there, or is not a file; the write error is the one to report.
    }
    return { kind: 'write-failed', reason: `the backup could not be written (the file system answered ${errnoCode(err)})` };
  }
  try {
    renameWithRetry(temporary, file);
  } catch (err) {
    removeTemporary();
    return { kind: 'write-failed', reason: `the file system answered ${errnoCode(err)}` };
  }
  return { kind: 'saved', before: current, after };
}

/**
 * The line Claude reads once after the user changed an instrument's settings in the page: only what changed, as
 * facts. It never names the setup file.
 */
export function rigSettingsLine(before: RigInstrument, after: RigInstrument): string {
  const parts: string[] = [];
  if (before.port !== after.port) parts.push(`port ${quotePort(before.port)} became ${quotePort(after.port)}`);
  const was = before.channels.map((entry) => entry.channel);
  const now = after.channels.map((entry) => entry.channel);
  if (ranges(was) !== ranges(now)) parts.push(`channels ${ranges(was)} became ${ranges(now)}`);
  if (before.clock !== after.clock) parts.push(`clock now ${after.clock ? 'on' : 'off'}`);
  return `MIDI: the user changed "${after.id}": ${parts.join('; ')}.`;
}
