// The settings vocabulary: the names code uses to set a tone, a part or a scene, and the optional
// `settings` description of an instrument model that maps those names to the messages the instrument
// takes. The names say nothing about how a setting is sent: a model maps the same name to a Roland data
// set, a control change or an NRPN, and the code does not change. A wrong description is a list of
// problems (a field and a reason), never an exception, so a hand edit in progress cannot crash the server.
//
// Nothing here sends a message: the page receives the names, the ranges and the message of each setting
// (settingsMessage) and builds the bytes itself, so the model file stays the one place that says where a setting goes.

import { z } from 'zod';
import { MAX_RIG_ENGINES, MAX_RIG_SETTINGS, type RigSetting, type RigSettingMessage, type RigSettings } from './protocol.js';
import { CONTROL_CHARS, dataByteSchema, idSchema, type Problem } from './rig-util.js';

export const SETTING_LEVELS = ['tone', 'part', 'scene'] as const;
export type SettingLevel = (typeof SETTING_LEVELS)[number];

// The tone names of one oscillator, the filter, the two envelopes, the LFO and the FM engine's global
// settings, then the names of the engines whose settings are their own (the number of a partial sits inside
// the name); the six operators follow, built from one list so their names stay in step.
const TONE_NAMES = [
  'osc1Wave', 'osc1Feet', 'osc1Tune', 'osc1Level',
  'osc2Wave', 'osc2Feet', 'osc2Tune', 'osc2Level',
  'filterType', 'filterCutoff', 'filterResonance', 'filterEnvDepth',
  'env1Attack', 'env1Decay', 'env1Sustain', 'env1Release',
  'env2Attack', 'env2Decay', 'env2Sustain', 'env2Release',
  'lfoRate', 'lfoOscDepth', 'lfoFilterDepth',
  'algorithm', 'feedback',
  'partial1Cutoff', 'toneCoarseTune',
  'partialMute', 'partial1Level',
];
// The part names that are offsets from the instrument's normal sound (an NRPN of the GS family): the lowest value moves the
// sound down, it does not close or silence anything.
const PART_OFFSET_NAMES = [
  'vibratoRateOffset', 'vibratoDepthOffset', 'vibratoDelayOffset',
  'cutoffOffset', 'resonanceOffset',
  'attackOffset', 'decayOffset', 'releaseOffset',
];
const OPERATOR_SETTINGS = ['Level', 'Ratio', 'Detune', 'Attack', 'Decay', 'Sustain', 'Release'];
const OPERATOR_COUNT = 6;
const operatorNames: string[] = [];
for (let operator = 1; operator <= OPERATOR_COUNT; operator++) {
  for (const setting of OPERATOR_SETTINGS) operatorNames.push(`op${operator}${setting}`);
}

// The settings of one partial of a timbre with four partials, in the order of the instrument's own table (pitch, wave,
// pitch envelope, pitch LFO, filter, filter envelope, volume, volume envelope); the four partials are built from this one
// list so their names stay in step. Two names of partial 1 already stand in TONE_NAMES and are not added twice.
const PARTIAL_SETTINGS = [
  'CoarseTune', 'FineTune', 'PitchKeyFollow', 'BendSwitch', 'Wave', 'PcmWave', 'PulseWidth', 'PulseWidthVelocity',
  'PitchEnvDepth', 'PitchEnvVelocity', 'PitchEnvTimeKeyFollow',
  'PitchEnvTime1', 'PitchEnvTime2', 'PitchEnvTime3', 'PitchEnvTime4',
  'PitchEnvLevel0', 'PitchEnvLevel1', 'PitchEnvLevel2', 'PitchEnvSustain', 'PitchEnvEnd',
  'PitchLfoRate', 'PitchLfoDepth', 'PitchLfoModSens',
  'Cutoff', 'Resonance', 'CutoffKeyFollow', 'FilterBiasPoint', 'FilterBiasLevel',
  'FilterEnvDepth', 'FilterEnvVelocity', 'FilterEnvDepthKeyFollow', 'FilterEnvTimeKeyFollow',
  'FilterEnvTime1', 'FilterEnvTime2', 'FilterEnvTime3', 'FilterEnvTime4', 'FilterEnvTime5',
  'FilterEnvLevel1', 'FilterEnvLevel2', 'FilterEnvLevel3', 'FilterEnvSustain',
  'Level', 'LevelVelocity', 'AmpBiasPoint1', 'AmpBiasLevel1', 'AmpBiasPoint2', 'AmpBiasLevel2',
  'AmpEnvTimeKeyFollow', 'AmpEnvTimeVelocity',
  'AmpEnvTime1', 'AmpEnvTime2', 'AmpEnvTime3', 'AmpEnvTime4', 'AmpEnvTime5',
  'AmpEnvLevel1', 'AmpEnvLevel2', 'AmpEnvLevel3', 'AmpEnvSustain',
];
const PARTIAL_COUNT = 4;
// The tone names of a timbre with four partials after the earlier names: how two partials are joined, the envelope mode,
// every partial, then the settings of the patch that a program change loads again.
const timbreNames: string[] = ['structure12', 'structure34', 'envMode'];
for (let partial = 1; partial <= PARTIAL_COUNT; partial++) {
  for (const setting of PARTIAL_SETTINGS) {
    const name = `partial${partial}${setting}`;
    if (!TONE_NAMES.includes(name)) timbreNames.push(name);
  }
}
timbreNames.push('keyShift', 'toneFineTune', 'bendRange', 'assignMode', 'toneReverbSwitch');

/** The setting names of each level, in the order a list shows them. Room for the FM engine is already here. */
export const SETTING_VOCABULARY: Readonly<Record<SettingLevel, readonly string[]>> = Object.freeze({
  tone: Object.freeze([...TONE_NAMES, ...operatorNames, ...timbreNames]),
  part: Object.freeze(['level', 'pan', 'chorusSend', 'reverbSend', 'delaySend', ...PART_OFFSET_NAMES]),
  scene: Object.freeze([
    'level',
    'chorusSwitch', 'chorusType', 'chorusLevel',
    'delaySwitch', 'delayType', 'delayLevel',
    'reverbSwitch', 'reverbType', 'reverbLevel',
    'driveAmount', 'driveSwitch',
    'masterTune', 'reverbTime',
  ]),
});

const settingValueSchema = z.number().int().min(0).max(65535);

// The message a setting becomes: a Roland data set at an address, an NRPN or a control change.
const messageSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('roland-dt1'), address: z.string(), size: z.union([z.literal(1), z.literal(2), z.literal(4)]) }),
  z.strictObject({ kind: z.literal('nrpn'), msb: dataByteSchema, lsb: dataByteSchema }),
  z.strictObject({ kind: z.literal('cc'), cc: dataByteSchema }),
]);

type SettingMessage = z.infer<typeof messageSchema>;

const rowSchema = z.strictObject({
  name: z.string().min(1).max(40),
  min: settingValueSchema,
  max: settingValueSchema,
  // Tone rows only, and required when the model declares engines: the engines that have this setting.
  engines: z.array(idSchema).min(1).max(MAX_RIG_ENGINES).optional(),
  message: messageSchema,
});

/** The optional `settings` field of a model; every key is optional, and a model without it stays valid. */
export const settingsSchema = z.strictObject({
  // The engines a tone can belong to (the sound catalog places a sound on one of them).
  engines: z.array(z.strictObject({ id: idSchema, name: z.string().min(1).max(40) })).min(1).max(MAX_RIG_ENGINES).optional(),
  // The model ID bytes of the Roland data sets, as hex text.
  rolandModel: z.string().optional(),
  // The NRPN family of the instrument's NRPN rows. Moontide knows one: 'gs', the part offsets of the Roland GS family.
  nrpnFamily: z.literal('gs').optional(),
  tone: z.array(rowSchema).max(MAX_RIG_SETTINGS).optional(),
  part: z.array(rowSchema).max(MAX_RIG_SETTINGS).optional(),
  scene: z.array(rowSchema).max(MAX_RIG_SETTINGS).optional(),
});

export type ModelSettings = z.infer<typeof settingsSchema>;

/**
 * The largest value a message carries: a control change 7 bits, an NRPN 7 bits (the page sends the data entry MSB only),
 * and a Roland data set cuts a value into 4-bit pieces, one per byte of its size.
 */
export function messageMax(message: SettingMessage): number {
  if (message.kind === 'cc') return 127;
  if (message.kind === 'nrpn') return 127;
  if (message.size === 1) return 127;
  if (message.size === 2) return 255;
  return 65535;
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let row = 1; row <= a.length; row++) {
    const current = [row];
    for (let column = 1; column <= b.length; column++) {
      const same = a[row - 1] === b[column - 1] ? 0 : 1;
      current[column] = Math.min((previous[column] as number) + 1, (current[column - 1] as number) + 1, (previous[column - 1] as number) + same);
    }
    previous = current;
  }
  return previous[b.length] as number;
}

/** The vocabulary name of a level closest to `name`, when it is at most 3 edits away. */
function closestName(level: SettingLevel, name: string): string | null {
  let best: string | null = null;
  let bestDistance = 4;
  for (const candidate of SETTING_VOCABULARY[level]) {
    const distance = editDistance(name, candidate);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

const hex2 = (byte: number): string => byte.toString(16).toUpperCase().padStart(2, '0');

/**
 * The data range of each NRPN family the page knows (KNOWN_NRPNS in page/midi-settings.js; a test pins both): a row of the
 * family whose range leaves it would be refused at every use, so it is refused when the model loads.
 */
export const NRPN_FAMILY_RANGES: Readonly<Record<'gs', { readonly min: number; readonly max: number }>> = Object.freeze({
  gs: Object.freeze({ min: 14, max: 114 }),
});

/**
 * The Roland model IDs whose temporary areas the page knows, with the length of the addresses their data sets take
 * (TEMPORARY_AREAS in page/midi-settings.js; a test pins both). A row of another length would be refused at every use.
 */
export const ROLAND_ADDRESS_SIZES: readonly { readonly model: readonly number[]; readonly size: number }[] = Object.freeze([
  Object.freeze({ model: Object.freeze([0x00, 0x00, 0x00, 0x65]), size: 4 }),
  Object.freeze({ model: Object.freeze([0x16]), size: 3 }),
]);

/**
 * Why hex text is not 1 to 4 two-digit bytes of at most 7F (3 or 4 with `isAddress`: a data set takes a three-byte or a
 * four-byte address, and a shorter one would make the instrument read data bytes as address bytes; which of the two the
 * instrument takes is checked when the bytes are built), or null when it is.
 */
function hexProblem(text: string, isAddress = false): string | null {
  const parts = text.trim().split(/\s+/).filter((part) => part !== '');
  if (parts.length === 0) return 'must not be empty';
  for (const part of parts) {
    if (!/^[0-9a-fA-F]{2}$/.test(part)) return `"${part}" is not a two-digit hex byte`;
  }
  if (isAddress && (parts.length < 3 || parts.length > 4)) return 'must be 3 or 4 bytes';
  if (parts.length > 4) return 'must be 1 to 4 bytes';
  for (let index = 0; index < parts.length; index++) {
    const byte = Number.parseInt(parts[index] as string, 16);
    if (byte > 0x7f) return `byte ${index} (${hex2(byte)}) is above 7F`;
  }
  return null;
}

/** The engine rules: ids and names unique, a tone row names declared engines when the model declares some, no other row names any. */
function checkEngines(settings: ModelSettings, add: (field: string, reason: string) => void): void {
  const declared = settings.engines;
  const first = new Map<string, number>();
  const firstNamed = new Map<string, number>();
  (declared ?? []).forEach((engine, index) => {
    if (CONTROL_CHARS.test(engine.name)) add(`engines[${index}].name`, 'contains a control character');
    const earlier = first.get(engine.id);
    if (earlier === undefined) first.set(engine.id, index);
    else add(`engines[${index}].id`, `same id as engines[${earlier}]`);
    const sameName = firstNamed.get(engine.name);
    if (sameName === undefined) firstNamed.set(engine.name, index);
    else add(`engines[${index}].name`, `same name as engines[${sameName}]`);
  });
  (settings.tone ?? []).forEach((row, index) => {
    const at = `tone[${index}].engines`;
    if (declared === undefined) {
      if (row.engines !== undefined) add(at, 'the model declares no engines');
    } else if (row.engines === undefined) {
      add(at, 'required: the model declares engines');
    } else {
      row.engines.forEach((id, position) => {
        if (!first.has(id)) add(`${at}[${position}]`, `unknown engine "${id}", engines: ${declared.map((engine) => engine.id).join(', ')}`);
      });
    }
  });
  for (const level of ['part', 'scene'] as const) {
    (settings[level] ?? []).forEach((row, index) => {
      if (row.engines !== undefined) add(`${level}[${index}].engines`, `${level} settings reach every engine`);
    });
  }
}

/**
 * Why a row repeats the name of earlier rows of its level, or null when it may. A tone name may have one row per engine
 * (the same setting sits at another address on each engine), so a tone row may repeat a name only when the model declares
 * engines and no engine appears in two rows of the name; every other repeat is refused.
 */
function repeatProblem(
  level: SettingLevel,
  settings: ModelSettings,
  row: z.infer<typeof rowSchema>,
  earlier: readonly number[],
): string | null {
  const rows = settings[level] ?? [];
  for (const index of earlier) {
    const other = rows[index] as z.infer<typeof rowSchema>;
    const perEngine = level === 'tone' && settings.engines !== undefined && row.engines !== undefined && other.engines !== undefined;
    if (!perEngine) return `same name as ${level}[${index}]`;
    const shared = (row.engines as string[]).find((id) => (other.engines as string[]).includes(id));
    if (shared !== undefined) return `same name as ${level}[${index}], and both reach engine "${shared}"`;
  }
  return null;
}

/**
 * The checks that need more than one field of a settings description; the shape is already valid.
 * Paths are relative to the settings object (`tone[0].name`); the empty path is the object itself.
 */
export function settingsProblems(settings: ModelSettings | undefined): Problem[] {
  const problems: Problem[] = [];
  if (settings === undefined) return problems;
  const add = (field: string, reason: string): void => {
    problems.push({ field, reason });
  };
  if (SETTING_LEVELS.every((level) => (settings[level] ?? []).length === 0)) add('', 'describes no setting');

  let needsRolandModel = false;
  let needsNrpnFamily = false;
  // The rows with a well-formed data set address, checked against the address length of the model ID below.
  const addressed: { at: string; length: number }[] = [];
  for (const level of SETTING_LEVELS) {
    // The rows seen so far by name: a tone name may repeat once per engine (see repeatProblem), no other name may.
    const seen = new Map<string, number[]>();
    (settings[level] ?? []).forEach((row, index) => {
      const at = `${level}[${index}]`;
      if (!SETTING_VOCABULARY[level].includes(row.name)) {
        const other = SETTING_LEVELS.find((candidate) => candidate !== level && SETTING_VOCABULARY[candidate].includes(row.name));
        const closest = closestName(level, row.name);
        add(
          `${at}.name`,
          other !== undefined
            ? `"${row.name}" is a ${other} setting name, not a ${level} one`
            : `"${row.name}" is not a ${level} setting name${closest === null ? '' : ` (closest: ${closest})`}`,
        );
      } else {
        const earlier = seen.get(row.name) ?? [];
        const problem = repeatProblem(level, settings, row, earlier);
        if (problem !== null) add(`${at}.name`, problem);
        seen.set(row.name, [...earlier, index]);
      }
      const carried = messageMax(row.message);
      if (row.max < row.min) add(`${at}.max`, 'must not be below min');
      else if (row.max > carried) add(`${at}.max`, `${row.max} is more than this message carries (${carried})`);
      if (row.message.kind === 'roland-dt1') {
        needsRolandModel = true;
        const address = hexProblem(row.message.address, true);
        if (address !== null) add(`${at}.message.address`, address);
        else addressed.push({ at, length: row.message.address.trim().split(/\s+/).length });
      }
      if (row.message.kind === 'nrpn') {
        needsNrpnFamily = true;
        if (level === 'scene') add(`${at}.message`, 'an NRPN reaches one channel, so it is not a scene setting');
        if (settings.nrpnFamily !== undefined) {
          const family = NRPN_FAMILY_RANGES[settings.nrpnFamily];
          if (row.min < family.min) add(`${at}.min`, `${row.min} is below the lowest value of the ${settings.nrpnFamily} family (${family.min})`);
          if (row.max > family.max) add(`${at}.max`, `${row.max} is above the highest value of the ${settings.nrpnFamily} family (${family.max})`);
        }
      }
    });
  }

  checkEngines(settings, add);

  if (settings.rolandModel === undefined) {
    if (needsRolandModel) add('rolandModel', 'required: a roland-dt1 setting needs the model ID');
  } else {
    const bad = hexProblem(settings.rolandModel);
    if (bad !== null) add('rolandModel', bad);
    else {
      // A model ID whose temporary areas Moontide knows takes one address length; any other takes 3 or 4 bytes.
      const model = hexToBytes(settings.rolandModel);
      const known = ROLAND_ADDRESS_SIZES.find((entry) => entry.model.length === model.length && entry.model.every((byte, index) => byte === model[index]));
      if (known !== undefined) {
        const modelText = model.map(hex2).join(' ');
        for (const row of addressed) {
          if (row.length !== known.size) add(`${row.at}.message.address`, `must be ${known.size} bytes: the data sets of model ID ${modelText} take ${known.size}-byte addresses`);
        }
      }
    }
  }
  if (needsNrpnFamily && settings.nrpnFamily === undefined) add('nrpnFamily', 'required: an nrpn setting needs the NRPN family');
  return problems;
}

/** Hex text as bytes. The description was checked when it was read, so a bad byte here is a fault: it throws. */
function hexToBytes(text: string): number[] {
  return text
    .trim()
    .split(/\s+/)
    .map((part) => {
      if (!/^[0-9a-fA-F]{2}$/.test(part)) throw new Error(`Moontide: "${part}" is not a two-digit hex byte.`);
      return Number.parseInt(part, 16);
    });
}

/** The message of one row for the page, copied key by key so nothing else of the model rides along. */
function rowMessage(message: SettingMessage): RigSettingMessage {
  if (message.kind === 'roland-dt1') return { kind: 'roland-dt1', address: hexToBytes(message.address), size: message.size };
  if (message.kind === 'nrpn') return { kind: 'nrpn', msb: message.msb, lsb: message.lsb };
  return { kind: 'cc', cc: message.cc };
}

/**
 * The settings as the page gets them: names, ranges and the message of each row, copied key by key so no other
 * key of the model rides along. Null when the model describes no settings.
 */
export function settingsMessage(settings: ModelSettings | undefined): RigSettings | null {
  if (settings === undefined) return null;
  const declared = settings.engines !== undefined;
  const row = (entry: z.infer<typeof rowSchema>, withEngines: boolean): RigSetting => ({
    name: entry.name,
    min: entry.min,
    max: entry.max,
    ...(withEngines && declared && entry.engines !== undefined ? { engines: [...entry.engines] } : {}),
    message: rowMessage(entry.message),
  });
  return {
    engines: (settings.engines ?? []).map((engine) => ({ id: engine.id, name: engine.name })),
    rolandModel: settings.rolandModel === undefined ? null : hexToBytes(settings.rolandModel),
    nrpnFamily: settings.nrpnFamily ?? null,
    tone: (settings.tone ?? []).map((entry) => row(entry, true)),
    part: (settings.part ?? []).map((entry) => row(entry, false)),
    scene: (settings.scene ?? []).map((entry) => row(entry, false)),
  };
}

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

function messageText(message: SettingMessage): string {
  if (message.kind === 'cc') return `control change ${message.cc}`;
  if (message.kind === 'nrpn') return `NRPN ${message.msb} ${message.lsb}`;
  return `Roland data set at ${hexBytesText(message.address)} over ${plural(message.size, 'byte')}`;
}

/** Hex text as two-digit upper-case bytes joined by single spaces. */
function hexBytesText(text: string): string {
  return text
    .trim()
    .split(/\s+/)
    .map((part) => part.toUpperCase())
    .join(' ');
}

/**
 * The save summary lines of a settings description, one fact per line, so nothing that reaches hardware
 * later is hidden behind the user's yes: the engines, the Roland model ID, then every setting row in level order.
 */
export function settingsSummary(settings: ModelSettings): string[] {
  const lines: string[] = [];
  if (settings.engines !== undefined) {
    lines.push(`Settings engines: ${settings.engines.map((engine) => `${engine.id} (${engine.name})`).join(', ')}.`);
  }
  if (settings.rolandModel !== undefined) lines.push(`Settings Roland model ID: ${hexBytesText(settings.rolandModel)}.`);
  if (settings.nrpnFamily !== undefined) lines.push(`Settings NRPN family: ${settings.nrpnFamily}.`);
  for (const level of SETTING_LEVELS) {
    const label = `${level.charAt(0).toUpperCase()}${level.slice(1)}`;
    for (const row of settings[level] ?? []) {
      const engines = row.engines === undefined ? '' : `, engines ${row.engines.join(', ')}`;
      lines.push(`${label} setting ${row.name}: ${row.min}-${row.max}, ${messageText(row.message)}${engines}.`);
    }
  }
  return lines;
}
