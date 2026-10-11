// Pure rig reading for Moontide's browser page: reads the `midi-rig` message the server pushes (the
// state of instruments.json and the instruments it describes) and checks the `.midi(` calls of a
// piece of code against it, worded as one refusal text. No DOM access at import time, so this module
// can be imported directly by node:test and by page/main.js without a build step. It mirrors the
// `midi-rig` message of src/protocol.ts by hand, as page/midi-plan.js mirrors midi-state.

import { controlKeyText, fill } from './midi-plan.js';
import { cutText } from './ask.js';

/**
 * The limits of the midi-rig message. src/protocol.ts holds the same numbers (MAX_RIG_INSTRUMENTS,
 * MAX_RIG_SOUNDS, MAX_RIG_CONTROLS, MAX_RIG_PROBLEMS, MAX_RIG_CATALOG_SOUNDS, MAX_RIG_CATALOG_KITS, MAX_RIG_DRUM_MAPS, MAX_RIG_DRUM_NOTES and
 * MAX_RIG_DRUM_NAME, and MAX_MIDI_NAME_LENGTH for names); test/midi-rig.test.js checks both sides.
 */
export const RIG_LIMITS = Object.freeze({
  instruments: 16,
  sounds: 512,
  controls: 32,
  problems: 20,
  name: 200,
  catalogSounds: 5000,
  catalogKits: 512,
  drumMaps: 16,
  drumNotes: 128,
  drumName: 40,
});

/**
 * The words of a refusal. Line 1 is one self-contained sentence (the top bar shows only that line),
 * the lines after it are for Claude and the hover, and the last line says what happened to the music.
 * The hint strings use neutral placeholders, so no sound is ever suggested.
 */
export const RIG_COPY = Object.freeze({
  invalidFile: 'instruments.json is invalid, so code with .midi() cannot play until it is fixed.',
  // The page could not read the MIDI setup (the file is usually fine, the server is an older build),
  // or it knows the server and the page come from different builds. Neither blames instruments.json.
  rigUnreadable:
    'The page could not read the MIDI setup the server sent, so code with .midi() cannot play; the server may come from an older build, restart Claude (the server).',
  buildMismatch:
    'Code with .midi() cannot play, because the server and the page come from different builds, restart the server (restart Claude).',
  invalidProblem: '{field}: {reason}',
  invalidMore: 'and {count} more problems.',
  portNotPlain: 'The port of .midi() must be a plain single-quoted name.',
  portNotPlainHint: "Write .midi('port name') with a port in instruments.json.",
  optionsNotPlain: 'The options of .midi() must be a plain object written in the call, not a variable, a spread or a computed key.',
  optionsNotPlainHint: "Write .midi('port name', { midichannel: 3, sound: 'sound name' }).",
  portConnectedNotInFile: 'Port "{port}" is connected but not in instruments.json. Add it there first.',
  midiportCall: "The port must be written once in .midi('port name'), not with .midiport(), when instruments.json exists.",
  channelNotPlain: 'The midichannel option of .midi() must be a plain whole number from 1 to 16.',
  soundNotPlain: 'The sound option of .midi() must be a plain single-quoted name, not a variable or a template.',
  doubleQuotes: 'Double quotes turn the name into mini-notation; write it in single quotes.',
  midichanNotPlain: '.midichan() must take a plain whole number from 1 to 16, once, on the chain of one .midi() call.',
  midichanHint: 'Or write midichannel in the options of .midi().',
  rhythmNoSounds: '{id} channel {channel} is a rhythm channel with no sounds to choose.',
  channelsWithSounds: 'Channels of {id} with sounds: {channels}.',
  soundConflict: '{id} channel {channel} is asked for two different sounds: "{first}" and "{second}".',
  oneSoundPerChannel: 'Give each channel one sound.',
  controlsNotPlain: 'The controls option of .midi() must be a plain object of numbers.',
  controlsNotPlainHint: "Write .midi('{port}', { midichannel: 3, controls: { volume: 90 } }).",
  unknownControl: 'Unknown control "{control}" for {id}.',
  controlsOf: 'Controls for {id}: {controls}.',
  controlRange: 'Control "{control}" of {id} must be a whole number from {min} to {max}.',
  controlExample: 'Write controls: { {control}: {example} }.',
  controlConflict: '{id} channel {channel} is given two different {control} values: {a} and {b}.',
  oneValuePerControl: 'Give each channel one value for a control.',
  also: 'Also: {line}',
  alsoMore: 'Also: {count} more problems.',
  listMore: '{items} and {count} more',
  portNotInFile: 'Port "{port}" is not in instruments.json.',
  validPorts: 'Valid ports: {ports}.',
  channelNotDeclared: 'Channel {channel} is not declared for {id}.',
  declaredChannels: 'Declared channels for {id}: {channels}.',
  unknownSound: 'Unknown sound "{sound}" for {id}.',
  closest: 'Closest: {names}.',
  toolPointer: 'Ask for the full list with the instruments tool, instrument "{id}".',
  toolPointerCatalog: 'Search the catalog with search_midi_sounds, instrument "{id}".',
  // S3: the user switched the instrument off in the page. Line 1 never says the port is missing from the file.
  offInstrument: 'Instrument "{id}" (port "{port}") is switched off by the user, so code cannot newly aim .midi() at it.',
  offInstrumentsOn: 'Instruments that are on: {ids}.',
  offNoneOn: 'No instrument is switched on.',
  offHow: 'The user switches it on in the Instruments view (key 6).',
  closingPlaying: 'The previous music keeps playing.',
  closingStopped: 'Nothing changed in the music.',
});

/** Same expression as soundKey in src/instruments.ts (a test pins both on one corpus). */
export function soundKey(name) {
  return name.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
}

const BANK_SELECTS = ['none', 'msb', 'msb-lsb'];
const ROLES = ['melodic', 'rhythm'];
// The server's control id rule (idSchema in src/instruments.ts): ids are written into code, so the page checks them again.
const CONTROL_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;

function fail(path, what) {
  throw new Error(`Moontide: the midi-rig message field ${path} ${what}.`);
}

function readString(value, path) {
  if (typeof value !== 'string') fail(path, 'must be a string');
  // Counted in code points, the unit src/instruments.ts cuts its problem texts in, so a text the
  // server keeps within its limit is never rejected here (an astral character is two UTF-16 units).
  if (Array.from(value).length > RIG_LIMITS.name) fail(path, `must be at most ${RIG_LIMITS.name} characters`);
  return value;
}

function readInt(value, path, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) fail(path, `must be a whole number from ${min} to ${max}`);
  return value;
}

function readBoolean(value, path) {
  if (typeof value !== 'boolean') fail(path, 'must be true or false');
  return value;
}

function readList(value, path, max) {
  if (!Array.isArray(value)) fail(path, 'must be a list');
  if (value.length > max) fail(path, `must have at most ${max} items`);
  return value;
}

function readObject(value, path) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(path, 'must be an object');
  return value;
}

function readSound(value, path, role) {
  readObject(value, path);
  const sound = { name: readString(value.name, `${path}.name`), program: readInt(value.program, `${path}.program`, 0, 127) };
  if (value.bank !== undefined) {
    readObject(value.bank, `${path}.bank`);
    sound.bank = { msb: readInt(value.bank.msb, `${path}.bank.msb`, 0, 127) };
    if (value.bank.lsb !== undefined) sound.bank.lsb = readInt(value.bank.lsb, `${path}.bank.lsb`, 0, 127);
  }
  // A rhythm sound may name its kit's drum map (an id) or say null, no map is known; absent stays absent.
  if (value.noteMap !== undefined) {
    if (role !== 'rhythm') fail(`${path}.noteMap`, 'is only for rhythm sounds');
    if (value.noteMap !== null && !(typeof value.noteMap === 'string' && CONTROL_ID.test(value.noteMap))) fail(`${path}.noteMap`, 'must be a map id or null');
    sound.noteMap = value.noteMap;
  }
  return sound;
}

/** A name of 1 to RIG_LIMITS.drumName code points. */
function readDrumName(value, path) {
  if (typeof value !== 'string') fail(path, 'must be a string');
  const count = Array.from(value).length;
  if (count < 1 || count > RIG_LIMITS.drumName) fail(path, `must be 1 to ${RIG_LIMITS.drumName} characters`);
  return value;
}

/** The drum maps of one instrument: ids unique, each map one to RIG_LIMITS.drumNotes notes, no note twice (a repeat fails with its path). */
function readDrumMaps(value, path) {
  const seen = new Map();
  return readList(value, path, RIG_LIMITS.drumMaps).map((entry, index) => {
    const at = `${path}[${index}]`;
    readObject(entry, at);
    const id = readString(entry.id, `${at}.id`);
    if (!CONTROL_ID.test(id)) fail(`${at}.id`, 'must be an id (lowercase letters, digits, - and _)');
    if (seen.has(id)) fail(`${at}.id`, `same id as drumMaps[${seen.get(id)}]`);
    seen.set(id, index);
    const name = readDrumName(entry.name, `${at}.name`);
    const firstNote = new Map();
    const notes = readList(entry.notes, `${at}.notes`, RIG_LIMITS.drumNotes).map((drum, drumIndex) => {
      const drumAt = `${at}.notes[${drumIndex}]`;
      readObject(drum, drumAt);
      const note = readInt(drum.note, `${drumAt}.note`, 0, 127);
      if (firstNote.has(note)) fail(`${drumAt}.note`, `same note as notes[${firstNote.get(note)}]`);
      firstNote.set(note, drumIndex);
      return { note, name: readDrumName(drum.name, `${drumAt}.name`) };
    });
    if (notes.length < 1) fail(`${at}.notes`, 'must have at least 1 item');
    return { id, name, notes };
  });
}

/** The controls of one instrument, in message order: every field checked, ids unique (a repeated id fails with its path). */
function readControls(value, path) {
  const seen = new Map();
  return readList(value, path, RIG_LIMITS.controls).map((entry, index) => {
    const at = `${path}[${index}]`;
    readObject(entry, at);
    const id = readString(entry.id, `${at}.id`);
    if (!CONTROL_ID.test(id)) fail(`${at}.id`, 'must be an id (lowercase letters, digits, - and _)');
    if (seen.has(id)) fail(`${at}.id`, `same id as controls[${seen.get(id)}]`);
    seen.set(id, index);
    const name = readString(entry.name, `${at}.name`);
    const length = Array.from(name).length;
    if (length < 1 || length > 40) fail(`${at}.name`, 'must be 1 to 40 characters');
    const control = {
      id,
      name,
      cc: readInt(entry.cc, `${at}.cc`, 0, 127),
      min: readInt(entry.min, `${at}.min`, 0, 127),
      max: readInt(entry.max, `${at}.max`, 0, 127),
      default: readInt(entry.default, `${at}.default`, 0, 127),
    };
    if (control.max < control.min) fail(`${at}.max`, 'must not be below min');
    if (control.default < control.min || control.default > control.max) fail(`${at}.default`, 'must be between min and max');
    return control;
  });
}

function readInstrument(value, path) {
  readObject(value, path);
  const instrument = readInstrumentFields(value, path);
  // Every map id the instrument names must be a map of the message, or the whole rig reads unreadable.
  const hasMap = (id) => instrument.drumMaps.some((map) => map.id === id);
  if (instrument.drumMap !== null && !hasMap(instrument.drumMap)) fail(`${path}.drumMap`, `names drum map "${instrument.drumMap}", which the message does not hold`);
  instrument.sounds.rhythm.forEach((sound, index) => {
    // Same rule as src/instruments.ts and src/catalog.ts: a kit with no bank on an opted-in model would go out as bank 0/0.
    if (instrument.rhythmBank && sound.bank === undefined) {
      fail(`${path}.sounds.rhythm[${index}].bank`, 'is required: the rhythm channels of this instrument take a bank');
    }
    if (typeof sound.noteMap === 'string' && !hasMap(sound.noteMap)) {
      fail(`${path}.sounds.rhythm[${index}].noteMap`, `names drum map "${sound.noteMap}", which the message does not hold`);
    }
  });
  return instrument;
}

function readInstrumentFields(value, path) {
  const bankSelect = value.bankSelect;
  if (!BANK_SELECTS.includes(bankSelect)) fail(`${path}.bankSelect`, `must be one of ${BANK_SELECTS.join(', ')}`);
  let reset = null;
  if (value.reset !== null) {
    readObject(value.reset, `${path}.reset`);
    const messages = readList(value.reset.messages, `${path}.reset.messages`, 4).map((message, index) =>
      readList(message, `${path}.reset.messages[${index}]`, 64).map((byte, at) => readInt(byte, `${path}.reset.messages[${index}][${at}]`, 0, 255)),
    );
    reset = { messages, waitMs: readInt(value.reset.waitMs, `${path}.reset.waitMs`, 0, 2000) };
  }
  readObject(value.sounds, `${path}.sounds`);
  return {
    id: readString(value.id, `${path}.id`),
    model: readString(value.model, `${path}.model`),
    modelName: readString(value.modelName, `${path}.modelName`),
    port: readString(value.port, `${path}.port`),
    channels: readList(value.channels, `${path}.channels`, 16).map((entry, index) => {
      readObject(entry, `${path}.channels[${index}]`);
      if (!ROLES.includes(entry.role)) fail(`${path}.channels[${index}].role`, `must be one of ${ROLES.join(', ')}`);
      return { channel: readInt(entry.channel, `${path}.channels[${index}].channel`, 1, 16), role: entry.role };
    }),
    bankSelect,
    defaultVolume: readInt(value.defaultVolume, `${path}.defaultVolume`, 0, 127),
    clock: readBoolean(value.clock, `${path}.clock`),
    controls: readControls(value.controls, `${path}.controls`),
    reset,
    sounds: {
      // The catalog sounds of the instrument follow its own sounds in this list.
      melodic: readList(value.sounds.melodic, `${path}.sounds.melodic`, RIG_LIMITS.sounds + RIG_LIMITS.catalogSounds).map((sound, index) =>
        readSound(sound, `${path}.sounds.melodic[${index}]`, 'melodic'),
      ),
      // The catalog drum kits of the instrument follow its own kits in this list.
      rhythm: readList(value.sounds.rhythm, `${path}.sounds.rhythm`, RIG_LIMITS.sounds + RIG_LIMITS.catalogKits).map((sound, index) =>
        readSound(sound, `${path}.sounds.rhythm[${index}]`, 'rhythm'),
      ),
    },
    catalogSounds: readInt(value.catalogSounds, `${path}.catalogSounds`, 0, RIG_LIMITS.catalogSounds),
    // Drum kits and note maps: the drum fields form one block, kept together; the fields after it come from the page's instrument controls.
    rhythmBank: readBoolean(value.rhythmBank, `${path}.rhythmBank`),
    drumMap: value.drumMap === null ? null : readMapId(value.drumMap, `${path}.drumMap`),
    drumMaps: readDrumMaps(value.drumMaps, `${path}.drumMaps`),
    catalogKits: readInt(value.catalogKits, `${path}.catalogKits`, 0, RIG_LIMITS.catalogKits),
    // Instruments from the page: the fields the Instruments view's switch and settings editor read.
    // Required, so a message from an older server reads unreadable instead of silently on.
    enabled: readBoolean(value.enabled, `${path}.enabled`),
    // Every channel of the model, so the editor can offer them all; required like enabled.
    modelChannels: readList(value.modelChannels, `${path}.modelChannels`, 16).map((entry, index) => {
      readObject(entry, `${path}.modelChannels[${index}]`);
      if (!ROLES.includes(entry.role)) fail(`${path}.modelChannels[${index}].role`, `must be one of ${ROLES.join(', ')}`);
      return { channel: readInt(entry.channel, `${path}.modelChannels[${index}].channel`, 1, 16), role: entry.role };
    }),
  };
}

function readMapId(value, path) {
  if (typeof value !== 'string' || !CONTROL_ID.test(value)) fail(path, 'must be a map id or null');
  return value;
}

/**
 * The drum map an instrument uses for a kit, as a plain fact:
 * { state: 'known', map: { id, name, notes }, via: 'kit' | 'model' } or { state: 'unknown', via: 'kit' | 'model' }.
 * kitName is the sound the code writes on the rhythm channel, or null when it writes none. A kit with noteMap null
 * has no known map, a kit with no noteMap takes the model's map, and a kit name the rig does not hold is unknown.
 * Never a General MIDI default: only a model or a kit that names that map gets it. Same rule as kitDrumMap in src/drum-maps.ts.
 */
export function drumMapFor(instrument, kitName) {
  if (!Array.isArray(instrument.drumMaps) || instrument.drumMap === undefined) {
    throw new Error('Moontide: drumMapFor needs a parsed rig instrument (drumMaps and drumMap).');
  }
  const byId = (id) => instrument.drumMaps.find((map) => map.id === id) ?? null;
  const model = instrument.drumMap === null ? null : byId(instrument.drumMap);
  const ofModel = () => (model === null ? { state: 'unknown', via: 'model' } : { state: 'known', map: model, via: 'model' });
  if (kitName === null) return ofModel();
  const key = soundKey(kitName);
  const kit = instrument.sounds.rhythm.find((sound) => soundKey(sound.name) === key);
  if (kit === undefined || kit.noteMap === null) return { state: 'unknown', via: 'kit' };
  if (kit.noteMap === undefined) return ofModel();
  const map = byId(kit.noteMap);
  return map === null ? { state: 'unknown', via: 'kit' } : { state: 'known', map, via: 'kit' };
}

/**
 * Reads a `midi-rig` message into the rig object the page keeps (the message without its type).
 * A field the page cannot read throws with its path (the caller logs it and refuses with rigFromReadFailure).
 */
export function parseRigMessage(msg) {
  readObject(msg, 'message');
  if (msg.setup === 'absent') return { setup: 'absent' };
  if (msg.setup === 'invalid') {
    const problems = readList(msg.problems, 'problems', RIG_LIMITS.problems).map((problem, index) => {
      readObject(problem, `problems[${index}]`);
      return { field: readString(problem.field, `problems[${index}].field`), reason: readString(problem.reason, `problems[${index}].reason`) };
    });
    return { setup: 'invalid', problems, more: readInt(msg.more, 'more', 0, Number.MAX_SAFE_INTEGER) };
  }
  if (msg.setup === 'valid') {
    const instruments = readList(msg.instruments, 'instruments', RIG_LIMITS.instruments).map((instrument, index) =>
      readInstrument(instrument, `instruments[${index}]`),
    );
    return { setup: 'valid', instruments };
  }
  fail('setup', "must be 'absent', 'invalid' or 'valid'");
  return null;
}

/**
 * The rig the page keeps when a `midi-rig` message cannot be read: an invalid setup flagged `unreadable`,
 * so code with `.midi(` is still refused (never played unchecked, never a silent fallback). It has no
 * problem rows: the file is usually fine and the server is an older build, so the reading error is not
 * shown as a file problem (the caller logs the error itself, so it is not a parameter). The flag makes the
 * refusal, the top-bar indicator and the Mixer say the setup could not be read and to restart Claude.
 */
export function rigFromReadFailure() {
  return { setup: 'invalid', unreadable: true, problems: [], more: 0 };
}

/**
 * While the page knows it and the server come from different builds, no MIDI setup check can be trusted,
 * so every `.midi(` code is refused with the mismatch as the reason: `mismatch === true` turns any
 * rig into an invalid rig flagged `buildMismatch`; anything else returns the very same rig. Code without
 * `.midi(` is never affected. The caller applies it to every rig the page keeps.
 */
export function withBuildMismatch(rig, mismatch) {
  if (mismatch !== true) return rig;
  return { setup: 'invalid', problems: [], more: 0, buildMismatch: true };
}

/**
 * The text of an evaluation refused because the check itself failed. Its closing line follows the play
 * state like every other refusal: it never says the music keeps playing when the page is stopped.
 */
export function checkFailureText(error, playing) {
  const message = error instanceof Error ? error.message : String(error);
  const closing = playing === true ? RIG_COPY.closingPlaying : RIG_COPY.closingStopped;
  return `Moontide could not check the MIDI setup: ${message}.\n${closing}`;
}

/**
 * The refusal text stays within this many code points. src/session.ts cuts the page's text at 500 when
 * it writes the failed reply, so 480 leaves room for its own words and keeps the closing line whole.
 */
const REFUSAL_BUDGET = 480;
/** Valid ports and closest names show at most this many entries (fewer when the text would not fit). */
const LIST_LIMIT = 5;

const cut = (text) => cutText(text, 60);
const cutPort = (text) => cutText(text, 40);
const length = (text) => Array.from(text).length;

/** Channel numbers as ranges: [2, 3, 4, 9] reads "2-4, 9". */
function channelRanges(channels) {
  const sorted = [...channels].sort((a, b) => a - b);
  const parts = [];
  let index = 0;
  while (index < sorted.length) {
    let end = index;
    while (end + 1 < sorted.length && sorted[end + 1] === sorted[end] + 1) end++;
    parts.push(end === index ? String(sorted[index]) : `${sorted[index]}-${sorted[end]}`);
    index = end + 1;
  }
  return parts.length === 0 ? 'none' : parts.join(', ');
}

/** Items joined by ", ": the first `limit`, then the rest counted. */
function listItems(items, limit) {
  if (items.length <= limit) return items.join(', ');
  return fill(RIG_COPY.listMore, { items: items.slice(0, limit).join(', '), count: items.length - limit });
}

/** The Levenshtein distance between two strings (code units; keys are short). */
function editDistance(a, b) {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let row = 1; row <= a.length; row++) {
    const current = [row];
    for (let column = 1; column <= b.length; column++) {
      const same = a[row - 1] === b[column - 1] ? 0 : 1;
      current[column] = Math.min(previous[column] + 1, current[column - 1] + 1, previous[column - 1] + same);
    }
    previous = current;
  }
  return previous[b.length];
}

/**
 * At most 5 names of `sounds` closest to `query`: the names whose key contains the query key or is
 * contained in it come first, in list order; then the smallest edit distance between keys, ties in
 * list order. Never picks a name for the caller: the refusal only suggests.
 */
export function closestSounds(query, sounds) {
  const queryKey = soundKey(query);
  const near = [];
  const rest = [];
  sounds.forEach((sound, index) => {
    const key = soundKey(sound.name);
    if (queryKey !== '' && key !== '' && (key.includes(queryKey) || queryKey.includes(key))) near.push(sound.name);
    else rest.push({ name: sound.name, index, distance: editDistance(queryKey, key) });
  });
  rest.sort((a, b) => a.distance - b.distance || a.index - b.index);
  return [...near, ...rest.map((entry) => entry.name)].slice(0, LIST_LIMIT);
}

/**
 * The lines of one problem, as a function of how many list entries it may show: line 1 is one
 * self-contained sentence, the lines after it are the valid values.
 */
function problemLines(call, rig, outputs, desired, written, controls, playingPorts) {
  const issues = call.problems;
  if (issues.port !== null) {
    return () => [RIG_COPY[issues.port.key], ...issues.port.hints.map((hint) => RIG_COPY[hint])];
  }
  const instrument = rig.instruments.find((candidate) => candidate.port === call.port);
  if (instrument === undefined) {
    const connected = outputs.some((output) => typeof output === 'string' && output.includes(call.port));
    return (limit) => {
      const ports = rig.instruments.map((candidate) => `"${cutPort(candidate.port)}" (${candidate.id})`);
      return [
        fill(connected ? RIG_COPY.portConnectedNotInFile : RIG_COPY.portNotInFile, { port: cut(call.port) }),
        fill(RIG_COPY.validPorts, { ports: listItems(ports, limit) }),
      ];
    };
  }
  // S3: a call newly aimed at an instrument the user switched off is refused. A call to a port the playing
  // code already names falls through: it is checked and recorded like any other.
  if (instrument.enabled === false && !playingPorts.has(instrument.port)) {
    const onIds = rig.instruments.filter((candidate) => candidate.enabled !== false).map((candidate) => candidate.id);
    return (limit) => [
      fill(RIG_COPY.offInstrument, { id: instrument.id, port: cutPort(call.port) }),
      onIds.length === 0 ? RIG_COPY.offNoneOn : fill(RIG_COPY.offInstrumentsOn, { ids: listItems(onIds, limit) }),
      RIG_COPY.offHow,
    ];
  }
  if (issues.channel !== null) {
    return () => [RIG_COPY[issues.channel.key], RIG_COPY.optionsNotPlainHint];
  }
  const declared = instrument.channels.find((entry) => entry.channel === call.channel);
  if (declared === undefined) {
    return () => [
      fill(RIG_COPY.channelNotDeclared, { channel: call.channel, id: instrument.id }),
      fill(RIG_COPY.declaredChannels, { id: instrument.id, channels: channelRanges(instrument.channels.map((entry) => entry.channel)) }),
    ];
  }
  return soundLines(call, instrument, declared, desired, written) ?? controlLines(call, instrument, declared, controls);
}

/**
 * The sound part of one call's problems (the part of problemLines that starts at the sound): the lines of a
 * problem, or null when the sound is fine, absent or already asked for. Records the sound in `desired` and
 * `written` when it is new.
 */
function soundLines(call, instrument, declared, desired, written) {
  const issues = call.problems;
  if (issues.sound !== null) {
    return () => [RIG_COPY[issues.sound.key], RIG_COPY.optionsNotPlainHint, ...issues.sound.hints.map((hint) => RIG_COPY[hint])];
  }
  if (call.sound === null) return null;
  const list = instrument.sounds[declared.role];
  if (list.length === 0) {
    const withSounds = instrument.channels.filter((entry) => instrument.sounds[entry.role].length > 0).map((entry) => entry.channel);
    return () => [
      fill(RIG_COPY.rhythmNoSounds, { id: instrument.id, channel: call.channel }),
      fill(RIG_COPY.channelsWithSounds, { id: instrument.id, channels: channelRanges(withSounds) }),
    ];
  }
  const key = soundKey(call.sound);
  const found = list.find((sound) => soundKey(sound.name) === key);
  if (found === undefined) {
    const names = closestSounds(call.sound, list).map(cut);
    return (limit) => {
      const lines = [fill(RIG_COPY.unknownSound, { sound: cut(call.sound), id: instrument.id })];
      if (names.length > 0) lines.push(fill(RIG_COPY.closest, { names: names.slice(0, limit).join(', ') }));
      // An instrument with a catalog has too many sounds (melodic) or kits (rhythm) to list: it points to the search tool.
      const hasCatalog = (declared.role === 'melodic' && instrument.catalogSounds > 0) || (declared.role === 'rhythm' && instrument.catalogKits > 0);
      const pointer = hasCatalog ? RIG_COPY.toolPointerCatalog : RIG_COPY.toolPointer;
      lines.push(fill(pointer, { id: instrument.id }));
      return lines;
    };
  }
  const slot = `${instrument.id}:${call.channel}`;
  const earlier = desired.get(slot);
  if (earlier !== undefined) {
    if (earlier.program === found.program && JSON.stringify(earlier.bank) === JSON.stringify(found.bank ?? null)) return null;
    return () => [
      fill(RIG_COPY.soundConflict, { id: instrument.id, channel: call.channel, first: cut(written.get(slot)), second: cut(call.sound) }),
      RIG_COPY.oneSoundPerChannel,
    ];
  }
  desired.set(slot, {
    instrument: instrument.id,
    port: instrument.port,
    channel: call.channel,
    role: declared.role,
    sound: found.name,
    program: found.program,
    bank: found.bank ?? null,
  });
  written.set(slot, call.sound);
  return null;
}

/**
 * The controls part of one call's problems, after the sound part: the lines of the first problem, or null when
 * the controls are fine or absent. A `controls` option the page cannot read comes first; then, for each written
 * control in written order: an id the model does not declare, a value that is not a whole number inside the
 * control's min to max, and a cc whose slot `<instrument id>:<channel>` already holds a different value (two tracks
 * on one channel). A valid value is recorded in `controls` under the control's cc in that slot.
 */
function controlLines(call, instrument, declared, controls) {
  if (call.problems.controls !== null) {
    return () => [RIG_COPY[call.problems.controls.key], fill(RIG_COPY.controlsNotPlainHint, { port: cut(call.port) })];
  }
  if (call.controls.size === 0) return null;
  const slot = `${instrument.id}:${call.channel}`;
  for (const [id, value] of call.controls) {
    const control = instrument.controls.find((candidate) => candidate.id === id);
    if (control === undefined) {
      const ids = instrument.controls.map((candidate) => candidate.id);
      return (limit) => [
        fill(RIG_COPY.unknownControl, { control: cut(id), id: instrument.id }),
        fill(RIG_COPY.controlsOf, { id: instrument.id, controls: listItems(ids, limit) }),
        fill(RIG_COPY.toolPointer, { id: instrument.id }),
      ];
    }
    if (!Number.isInteger(value) || value < control.min || value > control.max) {
      return () => [
        fill(RIG_COPY.controlRange, { control: id, id: instrument.id, min: control.min, max: control.max }),
        fill(RIG_COPY.controlExample, { control: controlKeyText(id), example: control.default }),
      ];
    }
    let entry = controls.get(slot);
    const earlier = entry === undefined ? undefined : entry.values.get(control.cc);
    if (earlier !== undefined && earlier.value !== value) {
      return () => [
        fill(RIG_COPY.controlConflict, { id: instrument.id, channel: call.channel, control: id, a: earlier.value, b: value }),
        RIG_COPY.oneValuePerControl,
      ];
    }
    if (entry === undefined) {
      entry = { instrument: instrument.id, port: instrument.port, channel: call.channel, values: new Map() };
      controls.set(slot, entry);
    }
    entry.values.set(control.cc, { id, value });
  }
  return null;
}

/**
 * Composes the refusal from the problems in code order: the first problem's lines (its lists shrink
 * until the text fits), then 'Also:' lines with line 1 of the next problems while they fit, then one
 * line that counts the rest, then the closing line. Never longer than REFUSAL_BUDGET code points.
 */
function composeRefusal(problems, closing) {
  const reserve = problems.length > 1 ? length(fill(RIG_COPY.alsoMore, { count: problems.length - 1 })) + 1 : 0;
  let first = problems[0](LIST_LIMIT);
  for (let limit = LIST_LIMIT; limit >= 1; limit--) {
    first = problems[0](limit);
    if (length([...first, closing].join('\n')) + reserve <= REFUSAL_BUDGET) break;
  }
  const lines = [...first];
  const alsos = problems.slice(1).map((lines_) => fill(RIG_COPY.also, { line: lines_(1)[0] }));
  let shown = 0;
  while (shown < alsos.length) {
    const remaining = alsos.length - shown - 1;
    const tail = remaining > 0 ? [fill(RIG_COPY.alsoMore, { count: remaining })] : [];
    if (length([...lines, alsos[shown], ...tail, closing].join('\n')) > REFUSAL_BUDGET) break;
    lines.push(alsos[shown]);
    shown++;
  }
  if (shown < alsos.length) lines.push(fill(RIG_COPY.alsoMore, { count: alsos.length - shown }));
  lines.push(closing);
  return lines.join('\n');
}

/**
 * The refusal of an invalid setup: a known build mismatch or an unreadable setup gets its own first line
 * (never "instruments.json is invalid"); a real invalid file lists up to 3 problems, the rest counted,
 * within the budget.
 */
function composeInvalid(rig, closing) {
  if (rig.buildMismatch === true) return [RIG_COPY.buildMismatch, closing].join('\n');
  if (rig.unreadable === true) return [RIG_COPY.rigUnreadable, closing].join('\n');
  const problems = rig.problems.map((problem) => cutText(fill(RIG_COPY.invalidProblem, { field: problem.field, reason: problem.reason }), 100));
  let shown = Math.min(3, problems.length);
  for (;;) {
    const left = problems.length - shown + rig.more;
    const lines = [RIG_COPY.invalidFile, ...problems.slice(0, shown)];
    if (left > 0) lines.push(fill(RIG_COPY.invalidMore, { count: left }));
    lines.push(closing);
    const text = lines.join('\n');
    if (length(text) <= REFUSAL_BUDGET || shown === 0) return text;
    shown--;
  }
}

/**
 * Checks the `.midi(` calls of a piece of code against the rig. `read` is the result of
 * readMidiSetup, `rig` the object parseRigMessage returned, `outputs` the connected output names (they
 * only decide the wording of a port that is missing from the file) and `playing` whether the page plays
 * now. Returns { refusal, desired, controls }: `refusal` is the whole text of the failed evaluation (null
 * when the code may run), `desired` the sound each used instrument channel must have, keyed
 * `<instrument id>:<channel>`: { instrument, port, channel, role, sound, program, bank }, and `controls`
 * the controls the code writes, keyed the same way: { instrument, port, channel, values: Map<cc, { id, value }> }.
 * `desired` and `controls` are empty Maps on every refusal and for an absent or invalid setup.
 * Every call is checked in source order and, within one call, port, channel, sound, then controls; a port
 * equals a file port only by exact string equality.
 * `playingPorts` is the set of ports the playing code already names with .midi(): a call to the port of an
 * instrument the user switched off is refused unless that port is in it. Such an allowed call is still
 * checked and recorded, because switching the instrument on sends what it records.
 */
export function checkSetup({ read, rig, outputs = [], playing, playingPorts = new Set() }) {
  const closing = playing === true ? RIG_COPY.closingPlaying : RIG_COPY.closingStopped;
  const desired = new Map();
  const controls = new Map();
  if (rig.setup === 'absent') return { refusal: null, desired, controls };
  if (rig.setup === 'invalid') {
    if (read.calls.length === 0) return { refusal: null, desired, controls };
    return { refusal: composeInvalid(rig, closing), desired, controls };
  }
  if (rig.setup !== 'valid') {
    throw new Error(`Moontide: the rig setup must be absent, invalid or valid, got ${JSON.stringify(rig.setup)}.`);
  }
  const problems = [];
  // The sound as the code wrote it for each slot: a conflict names both spellings.
  const written = new Map();
  for (const call of read.calls) {
    const lines = problemLines(call, rig, outputs, desired, written, controls, playingPorts);
    if (lines !== null) problems.push(lines);
  }
  if (problems.length === 0) return { refusal: null, desired, controls };
  return { refusal: composeRefusal(problems, closing), desired: new Map(), controls: new Map() };
}
