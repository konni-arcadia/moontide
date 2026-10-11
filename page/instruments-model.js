// The Instruments view's pure model: which sentence replaces the cards, which notice
// shows above them, and what each card says about one instrument of instruments.json. No DOM access at
// import time, so this module can be imported directly by node:test and by page/main.js without a build
// step. The words are INSTRUMENTS_COPY plus named reuses of MIDI_COPY, BUILD_MISMATCH_COPY and
// CONNECTION_LABELS (read at use time, so the popover, the top bar and this view never disagree). The DOM
// side is page/instruments-view.js; page/main.js feeds the inputs.

import { ACCESS_STATES, MIDI_COPY, fill, listNames, readMidiCalls } from './midi-plan.js';
import { BUILD_MISMATCH_COPY, CONNECTION_LABELS } from './ui-state.js';
import { midiTag, readMidiTracks } from './midi-controls.js';
import { drumMapFor, soundKey } from './midi-rig.js';

/** Mirrors RIG_LIMITS.problems of page/midi-rig.js by hand (test/instruments-model.test.js checks both): the most problems a rig message carries. */
export const MAX_PROBLEMS = 20;

/** Mirrors MAX_DATA_FOLDER_LENGTH of src/protocol.ts by hand (test/instruments-model.test.js checks both): the longest data folder path the page keeps. */
export const MAX_DATA_FOLDER_LENGTH = 1024;

// The server's CONTROL_CHARS (src/rig-util.ts): C0 and C1 controls, line separator and paragraph separator.
const FOLDER_CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/;

/**
 * The data folder the server sent, checked: null stays null, a non-empty string of at most
 * MAX_DATA_FOLDER_LENGTH UTF-16 units with no control character comes back unchanged. Anything else throws an
 * error that names the problem and never holds the text (the path can hold the OS user name).
 */
export function readDataFolder(value) {
  if (value === null) return null;
  if (typeof value !== 'string') throw new Error(`Moontide: the data folder the server sent must be a string or null, got ${typeof value}.`);
  if (value === '') throw new Error('Moontide: the data folder the server sent is empty.');
  if (value.length > MAX_DATA_FOLDER_LENGTH) throw new Error(`Moontide: the data folder the server sent is longer than ${MAX_DATA_FOLDER_LENGTH} characters.`);
  if (FOLDER_CONTROL_CHARS.test(value)) throw new Error('Moontide: the data folder the server sent holds a control character.');
  return value;
}

/** The page's own words for the Instruments view, new strings only. */
export const INSTRUMENTS_COPY = Object.freeze({
  disconnected: 'Disconnected — instruments show again when Moontide reconnects.',
  // The sub line under the "playing in another tab" lead; {takeBack} is the top-bar button's own name.
  supersededSub: 'Use "{takeBack}" in the top bar to see instruments here.',
  buildMismatchSub: 'The server and the page come from different builds, so instruments cannot be shown.',
  unreadableLead: 'Restart Claude: setup not readable',
  unreadableSub: 'The page could not read the MIDI setup the server sent. The server may come from an older build.',
  absentLeadFolder: 'Create instruments.json in the Moontide data folder:',
  absentLeadPlain: 'Create instruments.json in the Moontide data folder.',
  absentSub: 'It lists your MIDI instruments, and this view shows them.',
  absentSubNoFolder: 'It lists your MIDI instruments, and this view shows them. Claude can tell you where the folder is.',
  invalidClosing: 'Fix the file, then reload this page.',
  // The closings that follow the reused MIDI_COPY lead of each notice (the popover's closings say more than a notice needs).
  noticeUnsupportedClosing: 'Use Chrome or Edge.',
  noticeDeniedClosing: 'Click the padlock left of the address bar, set MIDI devices to Allow, then reload this page.',
  noticeFailedClosing: 'Reload the page to try again.',
  noticeIdle: 'Port states show once MIDI is allowed. Moontide asks when a track plays a MIDI instrument.',
  labelModel: 'Model',
  labelPort: 'Port',
  labelChannels: 'Channels',
  labelClock: 'Clock',
  labelControls: 'Controls',
  labelControlsHint: 'default values',
  labelCatalog: 'Catalog',
  labelInUse: 'In use',
  clockFollows: 'follows the clock',
  controlsNone: 'none',
  catalogOne: '1 sound',
  catalogMany: '{n} sounds',
  // One stretch of channels of one role: `ch 2–9 melodic`; the numbers come from channelsText.
  channelsStretch: 'ch {numbers} {role}',
  usedOutside: 'used outside a track',
  unreadableCode: "can't read the code",
  mutedSuffix: ' (muted)',
  footer: 'Edits to instruments.json made by hand show after you reload this page. Changes made here show at once.',
  chipText: '{name} {value}',
  chipTitle: '{name}: default {value}, range {min}–{max}',
  chipLabel: '{name}, default {value}',
  portUnchecked: 'not checked',
  dotUnchecked: '{port}: not checked',
  // The hover title of a card: the model id and the port.
  cardTitle: '{model} on {port}',
  // The Drum kit row and the Drum map line of an instrument with a rhythm channel.
  labelDrumKit: 'Drum kit',
  drumKitNotChosen: 'not chosen by the code',
  drumKitTitle: '{kit}: program {program}',
  drumKitTitleBank: '{kit}: bank {bank}, program {program}',
  drumKitNotInCatalog: '{kit}: not in the catalog',
  drumMapKnown: 'Drum map: {name} ({count})',
  drumMapForKit: 'Drum map: {name} ({count}) for {kit}',
  drumMapShow: 'show notes',
  drumMapHide: 'hide notes',
  drumMapUnknownLabel: 'Drum map:',
  drumMapUnknownWord: 'unknown',
  drumMapUnknownKit: 'No note map is known for {kit}, so notes show as numbers.',
  drumMapUnknownInstrument: 'No note map is known for this instrument, so notes show as numbers.',
  // The switch at the top of each card. The words for "off" (switched off) are named reuses of
  // MIDI_COPY.rowSwitchedOff and MIDI_COPY.dotSwitchedOff, so the card, the top bar and the announcement agree.
  switchOn: 'On',
  switchOff: 'Off',
  switchTurningOn: 'Turning on…',
  switchTurningOff: 'Turning off…',
  // The hover title is the action a press does.
  switchTitleWhenOn: 'Switch {id} off',
  switchTitleWhenOff: 'Switch {id} on',
  // The muted first line of the In use row of an off instrument the playing code names.
  silentWhileOff: 'silent while switched off',
  // {state} is `off` or `on` (the target of the press); {reason} is the server's own text.
  switchRefused: 'Could not switch {id} {state}: {reason}',
  switchNoReason: 'Moontide gave no reason.',
  announceOn: '{id}: switched on',
  announceSettings: '{id}: settings changed',
  // The settings editor. The reused words are labelPort, labelChannels, labelClock,
  // MIDI_COPY.outputsNone, MIDI_COPY.rowSeparator, MIDI_COPY.rowsMore and MIDI_COPY.takeBackFailed.
  editSettings: 'Edit settings',
  editSettingsLabel: 'Edit settings, {id}',
  editorName: 'Settings of {id}',
  portNotDetected: '{port} (not detected)',
  portHintIdle: 'Detected ports show once MIDI is on in this page.',
  chipRhythm: '{n} rhythm',
  clockLabel: 'Follows the clock',
  warnOne: 'ch {numbers} is used by the code and goes silent after you save.',
  warnMany: 'ch {numbers} are used by the code and go silent after you save.',
  save: 'Save',
  cancel: 'Cancel',
  saving: 'Saving…',
  writeFailed: 'Nothing was saved. instruments.json could not be written: {reason}',
  changedElsewhere: 'This instrument changed on another page. Saving replaces those values.',
});

/** The ways the page stands with the server (the first match of the message table starts here). */
const CONNECTIONS = ['connecting', 'connected', 'disconnected', 'refused'];

/** The dot and the copy key of each port state the page can read; `null` (not read) is handled apart. */
const PORT_STATES = Object.freeze({
  connected: { dot: 'dotConnected', kind: 'filled' },
  unplugged: { dot: 'dotUnplugged', kind: 'hollow' },
  'not-found': { dot: 'dotNotFound', kind: 'hollow' },
  ambiguous: { dot: 'dotAmbiguous', kind: 'hollow' },
});

/** A message model: the sentence that replaces the cards. The parts a state does not use are null. */
function message(state, lead, rest = {}) {
  return { kind: 'message', state, notice: null, lead, folder: null, sub: null, problems: [], more: null, closing: null, ...rest };
}

/**
 * The notice above the cards: `{ kind, text }` or null. First match wins: no Web MIDI (read from `supported`,
 * even while the access is still idle, because the access only becomes `unsupported` once MIDI code ran),
 * then denied, failed, pending and idle; `enabled` has none. An unknown access throws (checked by the caller).
 */
function noticeFor(supported, access) {
  if (supported !== true && supported !== false) {
    throw new Error(`Moontide: the Instruments view needs supported to be true or false, got ${JSON.stringify(supported)}.`);
  }
  if (supported === false || access === 'unsupported') {
    return { kind: 'unsupported', text: `${MIDI_COPY.popUnsupportedLead} ${INSTRUMENTS_COPY.noticeUnsupportedClosing}` };
  }
  if (access === 'denied') return { kind: 'denied', text: `${MIDI_COPY.popDeniedLead} ${INSTRUMENTS_COPY.noticeDeniedClosing}` };
  if (access === 'failed') return { kind: 'failed', text: `${MIDI_COPY.popFailedLeadPlain} ${INSTRUMENTS_COPY.noticeFailedClosing}` };
  if (access === 'pending') return { kind: 'pending', text: MIDI_COPY.popPendingLead };
  if (access === 'idle') return { kind: 'idle', text: INSTRUMENTS_COPY.noticeIdle };
  return null;
}

/** The problem rows of an invalid file: every problem the message carries (at most MAX_PROBLEMS) and the count of the rest. */
function problemRows(rig) {
  if (!Number.isInteger(rig.more) || rig.more < 0) {
    throw new Error(`Moontide: an invalid setup must carry a count of further problems, got ${JSON.stringify(rig.more)}.`);
  }
  const problems = rig.problems.slice(0, MAX_PROBLEMS).map((problem) => ({ field: problem.field, reason: problem.reason }));
  const rest = Math.max(0, rig.problems.length - MAX_PROBLEMS) + rig.more;
  return { problems, more: rest > 0 ? fill(MIDI_COPY.rowsMore, { count: rest }) : null };
}

/** The no-file message: the data folder path when the page knows it (shown whole), else a lead that ends with a period. */
function absentMessage(dataFolder) {
  if (dataFolder !== null && typeof dataFolder !== 'string') {
    throw new Error(`Moontide: the data folder must be a string or null, got ${JSON.stringify(dataFolder)}.`);
  }
  if (dataFolder === null || dataFolder === '') {
    return message('absent', INSTRUMENTS_COPY.absentLeadPlain, { sub: INSTRUMENTS_COPY.absentSubNoFolder });
  }
  return message('absent', INSTRUMENTS_COPY.absentLeadFolder, { folder: dataFolder, sub: INSTRUMENTS_COPY.absentSub });
}

/** The message a page that cannot show cards gives, or null when the cards can show (first match wins). */
function messageFor({ connection, superseded, noActive, rig, dataFolder }, notice) {
  if (connection === 'connecting') return message('connecting', CONNECTION_LABELS.connecting);
  if (connection === 'refused') return message('refused', CONNECTION_LABELS.refused);
  if (connection === 'disconnected') return message('disconnected', INSTRUMENTS_COPY.disconnected);
  if (superseded === true) {
    return message('superseded', noActive === true ? MIDI_COPY.noActiveText : MIDI_COPY.takeoverText, {
      sub: fill(INSTRUMENTS_COPY.supersededSub, { takeBack: MIDI_COPY.takeBack }),
    });
  }
  // Only the no-Web-MIDI notice shows above a message: the other notices are about ports, and no port shows here.
  const aboveMessage = notice !== null && notice.kind === 'unsupported' ? notice.text : null;
  if (rig.setup === 'invalid' && rig.buildMismatch === true) {
    return message('build-mismatch', BUILD_MISMATCH_COPY.line, { sub: INSTRUMENTS_COPY.buildMismatchSub });
  }
  if (rig.setup === 'invalid' && rig.unreadable === true) {
    return message('unreadable', INSTRUMENTS_COPY.unreadableLead, { sub: INSTRUMENTS_COPY.unreadableSub });
  }
  if (rig.setup === 'invalid') {
    return message('invalid', MIDI_COPY.popSetupInvalidLead, { notice: aboveMessage, ...problemRows(rig), closing: INSTRUMENTS_COPY.invalidClosing });
  }
  if (rig.setup === 'absent') return { ...absentMessage(dataFolder), notice: aboveMessage };
  return null;
}

/** The port part of a card from the live reading of the same instrument; an unknown state throws. */
function portPart(instrument, live) {
  // An instrument switched off is not unplugged and not unknown. It says so in words and in a crossed dot,
  // whatever its port does; it never asks for attention.
  if (instrument.enabled === false) {
    return {
      name: instrument.port,
      dot: { kind: 'off', title: fill(MIDI_COPY.dotSwitchedOff, { port: instrument.id }) },
      words: MIDI_COPY.rowSwitchedOff,
      attention: false,
      stateKind: 'off',
    };
  }
  if (live.state === null) {
    return {
      name: instrument.port,
      dot: { kind: 'unknown', title: fill(INSTRUMENTS_COPY.dotUnchecked, { port: instrument.id }) },
      words: INSTRUMENTS_COPY.portUnchecked,
      attention: false,
      stateKind: null,
    };
  }
  const known = PORT_STATES[live.state];
  if (known === undefined) {
    throw new Error(`Moontide: the state of instrument ${JSON.stringify(instrument.id)} must be connected, unplugged, not-found or ambiguous, got ${JSON.stringify(live.state)}.`);
  }
  let words;
  if (live.state === 'connected') {
    const output = live.matches[0];
    words = typeof output === 'string' && output !== instrument.port ? fill(MIDI_COPY.rowConnectedAs, { output }) : MIDI_COPY.rowConnected;
  } else if (live.state === 'unplugged') {
    words = MIDI_COPY.rowUnplugged;
  } else if (live.state === 'not-found') {
    words = MIDI_COPY.rowRigNotFound;
  } else {
    words = fill(MIDI_COPY.rowAmbiguous, { outputs: listNames(live.matches) });
  }
  return {
    name: instrument.port,
    dot: { kind: known.kind, title: fill(MIDI_COPY[known.dot], { port: instrument.id }) },
    words,
    attention: live.state !== 'connected',
    stateKind: live.state,
  };
}

/**
 * The channels of an instrument as the card writes them (R-CH): sorted ascending, cut into stretches of one role
 * and, inside a stretch, into runs of consecutive channels. A run of one reads `10`, of two `1, 2`, of three or
 * more `2–9`; a role word closes each stretch: `ch 2–9 melodic, ch 10 rhythm`. Channels of different roles
 * never merge, even when consecutive. The input is never changed.
 */
export function channelsText(channels) {
  const sorted = [...channels].sort((a, b) => a.channel - b.channel);
  const stretches = [];
  for (const entry of sorted) {
    const last = stretches[stretches.length - 1];
    if (last === undefined || last.role !== entry.role) {
      stretches.push({ role: entry.role, runs: [[entry.channel]] });
      continue;
    }
    const run = last.runs[last.runs.length - 1];
    if (entry.channel === run[run.length - 1] + 1) run.push(entry.channel);
    else last.runs.push([entry.channel]);
  }
  return stretches
    .map(({ role, runs }) => {
      const numbers = runs.map((run) => (run.length >= 3 ? `${run[0]}–${run[run.length - 1]}` : run.join(', '))).join(', ');
      return fill(INSTRUMENTS_COPY.channelsStretch, { numbers, role });
    })
    .join(', ');
}

/** One control chip: the model's name and declared default, in the model's order. */
function chipOf(control) {
  const values = { name: control.name, value: control.default, min: control.min, max: control.max };
  return {
    name: control.name,
    value: String(control.default),
    text: fill(INSTRUMENTS_COPY.chipText, values),
    title: fill(INSTRUMENTS_COPY.chipTitle, values),
    label: fill(INSTRUMENTS_COPY.chipLabel, values),
  };
}

/**
 * Reads the playing code once for every card: the MIDI tracks against the rig and the port calls, from
 * the same string. `{ kind: 'empty' }` when nothing plays, `{ kind: 'unreadable' }` when the code does not parse
 * or there is no parser, else `{ kind: 'read', tracks, calls }` with the tracks in code order.
 */
function readUse(code, parse, rig) {
  if (typeof code !== 'string') {
    throw new Error(`Moontide: the Instruments view needs the playing code as a string, got ${JSON.stringify(code)}.`);
  }
  if (code === '') return { kind: 'empty' };
  if (typeof parse !== 'function') return { kind: 'unreadable' };
  const tracks = readMidiTracks(code, { parse, rig });
  const calls = readMidiCalls(code, { parse });
  if (!tracks.ok || !calls.ok) return { kind: 'unreadable' };
  return { kind: 'read', tracks: [...tracks.tracks.values()], calls: calls.calls };
}

/**
 * The In use row of one instrument: `{ lead, lines, muted }`; muted marks the sentences that say there is no track to
 * list. `lead` is the muted first line "silent while switched off", only for an off instrument a track names.
 */
function inUseOf(instrument, use) {
  const none = (text) => ({ lead: null, lines: [text], muted: true });
  if (use.kind === 'unreadable') return none(INSTRUMENTS_COPY.unreadableCode);
  if (use.kind === 'empty') return none(MIDI_COPY.rowNotUsed);
  const mine = use.tracks.filter((track) => track.instrument !== null && track.instrument.id === instrument.id);
  if (mine.length === 0) {
    const outside = use.calls.some((call) => call.kind === 'name' && call.name === instrument.port);
    return none(outside ? INSTRUMENTS_COPY.usedOutside : MIDI_COPY.rowNotUsed);
  }
  // One line per channel, ascending; the tracks whose channel cannot be read go last, with no channel part.
  const groups = new Map();
  for (const track of mine) {
    const channel = track.spine.channel;
    if (!groups.has(channel)) groups.set(channel, []);
    groups.get(channel).push(track);
  }
  const channels = [...groups.keys()].sort((a, b) => Number(a === null) - Number(b === null) || a - b);
  const lines = channels.map((channel) => {
    const tracks = groups.get(channel);
    const names = tracks.map((track) => `${track.name}${track.muted ? INSTRUMENTS_COPY.mutedSuffix : ''}`).join(MIDI_COPY.rowPartsJoin);
    // The channel part is midiTag's own, so this row and the Timeline and Mixer tags can never disagree.
    return `${names}${midiTag(tracks[0]).channel}`;
  });
  return { lead: instrument.enabled === false ? INSTRUMENTS_COPY.silentWhileOff : null, lines, muted: false };
}

/** True when the instrument declares at least one channel with the rhythm role (the Drum kit row and Drum map line only exist then). */
function hasRhythmChannel(instrument) {
  return instrument.channels.some((entry) => entry.role === 'rhythm');
}

/**
 * The rhythm channels of this instrument that the playing code uses, ascending: `{ channel, kit, part }` each, with
 * the kit the first sound written on that channel (null when no track writes one) and midiTag's own channel part.
 * Empty unless the code was read.
 */
function rhythmChannelsInUse(instrument, use) {
  if (use.kind !== 'read') return [];
  const rhythm = new Set(instrument.channels.filter((entry) => entry.role === 'rhythm').map((entry) => entry.channel));
  const groups = new Map();
  for (const track of use.tracks) {
    if (track.instrument === null || track.instrument.id !== instrument.id) continue;
    const channel = track.spine.channel;
    if (channel === null || !rhythm.has(channel)) continue;
    if (!groups.has(channel)) groups.set(channel, []);
    groups.get(channel).push(track);
  }
  return [...groups.keys()]
    .sort((a, b) => a - b)
    .map((channel) => {
      const tracks = groups.get(channel);
      const written = tracks.map((track) => track.spine.sound).find((sound) => typeof sound === 'string');
      return { channel, kit: written === undefined ? null : written, part: midiTag(tracks[0]).channel };
    });
}

/** The kit of the rig that a written kit name means (the same match drumMapFor makes), or undefined. */
function heldKit(instrument, name) {
  const key = soundKey(name);
  return instrument.sounds.rhythm.find((sound) => soundKey(sound.name) === key);
}

/** The Drum kit row of one instrument: null without a rhythm channel, else `{ lines: [{ text, title, muted }] }`. */
function drumKitOf(instrument, use) {
  if (!hasRhythmChannel(instrument)) return null;
  const none = (text) => ({ lines: [{ text, title: null, muted: true }] });
  if (use.kind === 'unreadable') return none(INSTRUMENTS_COPY.unreadableCode);
  if (use.kind === 'empty') return none(MIDI_COPY.rowNotUsed);
  const channels = rhythmChannelsInUse(instrument, use);
  if (channels.length === 0) {
    // Like the In use row: the port counts as used outside a track only when no track of the code uses this instrument.
    const hasTrack = use.tracks.some((track) => track.instrument !== null && track.instrument.id === instrument.id);
    const outside = !hasTrack && use.calls.some((call) => call.kind === 'name' && call.name === instrument.port);
    return none(outside ? INSTRUMENTS_COPY.usedOutside : MIDI_COPY.rowNotUsed);
  }
  const lines = channels.map(({ kit, part }) => {
    if (kit === null) return { text: `${INSTRUMENTS_COPY.drumKitNotChosen}${part}`, title: null, muted: true };
    const held = heldKit(instrument, kit);
    if (held === undefined) return { text: `${kit}${part}`, title: fill(INSTRUMENTS_COPY.drumKitNotInCatalog, { kit }), muted: false };
    let title;
    if (instrument.rhythmBank === true && held.bank !== undefined) {
      const bank = held.bank.lsb === undefined ? String(held.bank.msb) : `${held.bank.msb}/${held.bank.lsb}`;
      title = fill(INSTRUMENTS_COPY.drumKitTitleBank, { kit: held.name, bank, program: held.program });
    } else {
      title = fill(INSTRUMENTS_COPY.drumKitTitle, { kit: held.name, program: held.program });
    }
    return { text: `${held.name}${part}`, title, muted: false };
  });
  return { lines };
}

/**
 * The Drum map lines of one instrument: null without a rhythm channel, else one entry per distinct applicable map
 * in channel order (the same drumMapFor the Timeline lanes and the moment call), or one for the instrument itself
 * when no rhythm channel is in use. `{ kind: 'known', key, summary, notes }` (notes ascending, `{ note, name }`)
 * or `{ kind: 'unknown', key, sub }`; the key is the map id, or `unknown:` and the kit.
 */
function drumMapsOf(instrument, use) {
  if (!hasRhythmChannel(instrument)) return null;
  const channels = rhythmChannelsInUse(instrument, use);
  const kits = channels.length === 0 ? [null] : channels.map((entry) => entry.kit);
  const entries = new Map();
  for (const kit of kits) {
    const resolved = drumMapFor(instrument, kit);
    const held = kit === null ? undefined : heldKit(instrument, kit);
    const kitName = kit === null ? null : held === undefined ? kit : held.name;
    let entry;
    if (resolved.state === 'known') {
      const { map } = resolved;
      const ownMap = resolved.via === 'model' || map.id === instrument.drumMap;
      entry = {
        kind: 'known',
        key: map.id,
        summary: fill(ownMap ? INSTRUMENTS_COPY.drumMapKnown : INSTRUMENTS_COPY.drumMapForKit, { name: map.name, count: map.notes.length, kit: kitName }),
        notes: [...map.notes].sort((a, b) => a.note - b.note).map((drum) => ({ note: String(drum.note), name: drum.name })),
      };
    } else {
      entry = {
        kind: 'unknown',
        key: `unknown:${kitName === null ? '' : kitName}`,
        sub: kitName === null ? INSTRUMENTS_COPY.drumMapUnknownInstrument : fill(INSTRUMENTS_COPY.drumMapUnknownKit, { kit: kitName }),
      };
    }
    if (!entries.has(entry.key)) entries.set(entry.key, entry);
  }
  return [...entries.values()];
}

/** What the file declares about the drums of an instrument, as one string: a change of it rebuilds the card. */
function drumDeclaredOf(instrument) {
  return JSON.stringify({
    rhythmBank: instrument.rhythmBank,
    drumMap: instrument.drumMap,
    maps: instrument.drumMaps.map((map) => [map.id, map.name, map.notes.length]),
  });
}

/** The text of the catalog row: null without a catalog, `1 sound`, or `{n} sounds`. */
function catalogText(count) {
  if (count === 0) return null;
  return count === 1 ? INSTRUMENTS_COPY.catalogOne : fill(INSTRUMENTS_COPY.catalogMany, { n: count });
}

/**
 * How the switch of one card looks and reads. `enabled` is the state the server confirmed;
 * `pending` is null or the target boolean of a request that waits for its answer. The checked flag and the title
 * follow the confirmed state (no optimistic flip); the word and the thumb show the wait.
 */
export function switchLook({ id, enabled, pending }) {
  if (typeof enabled !== 'boolean') {
    throw new Error(`Moontide: the switch of ${JSON.stringify(id)} needs enabled to be true or false, got ${JSON.stringify(enabled)}.`);
  }
  if (pending !== null && typeof pending !== 'boolean') {
    throw new Error(`Moontide: the switch of ${JSON.stringify(id)} needs pending to be null, true or false, got ${JSON.stringify(pending)}.`);
  }
  const title = fill(enabled ? INSTRUMENTS_COPY.switchTitleWhenOn : INSTRUMENTS_COPY.switchTitleWhenOff, { id });
  const checked = enabled ? 'true' : 'false';
  if (pending !== null) {
    return { checked, word: pending ? INSTRUMENTS_COPY.switchTurningOn : INSTRUMENTS_COPY.switchTurningOff, title, busy: true, thumb: 'pending' };
  }
  return { checked, word: enabled ? INSTRUMENTS_COPY.switchOn : INSTRUMENTS_COPY.switchOff, title, busy: false, thumb: enabled ? 'on' : 'off' };
}

/**
 * The line under a card's header after a switch that did not take: `outcome` is what the server answered (a refusal
 * with its reason, or a write failure) or `{ kind: 'unconfirmed' }` when it did not answer in time or the socket
 * closed. `target` is the state the press asked for. The reason is the server's own text, kept verbatim (the view
 * sets it as text); a refusal with no reason says so.
 */
export function switchRefusalText({ id, target, outcome }) {
  if (outcome.kind === 'unconfirmed') return MIDI_COPY.takeBackFailed;
  if (outcome.kind !== 'refused' && outcome.kind !== 'write-failed') {
    throw new Error(`Moontide: a switch of ${JSON.stringify(id)} cannot end as ${JSON.stringify(outcome.kind)}.`);
  }
  const reason = typeof outcome.reason === 'string' && outcome.reason !== '' ? outcome.reason : INSTRUMENTS_COPY.switchNoReason;
  return fill(INSTRUMENTS_COPY.switchRefused, { id, state: target ? 'on' : 'off', reason });
}

/**
 * Reads an `instrument-result` message of the server (src/protocol.ts, mirrored by hand): `{ id, ok: true }` or
 * `{ id, ok: false, kind, reason, missing }`. A refusal with no reason comes back with `reason: null` and
 * `missing: 'reason'`, so the caller can log the missing field and the card can say so. A message that cannot be
 * read throws and names the field.
 */
export function readInstrumentResult(msg) {
  if (typeof msg !== 'object' || msg === null) throw new Error('Moontide: the instrument-result message must be an object.');
  if (typeof msg.id !== 'string' || msg.id === '') throw new Error('Moontide: the instrument-result field id must be a non-empty string.');
  if (typeof msg.ok !== 'boolean') throw new Error('Moontide: the instrument-result field ok must be true or false.');
  if (msg.ok) return { id: msg.id, ok: true };
  if (msg.kind === 'invalid') {
    // The problems of a settings edit: the same { field, reason } rows as an invalid file, capped.
    if (!Array.isArray(msg.problems) || !msg.problems.every((problem) => typeof problem === 'object' && problem !== null && typeof problem.field === 'string' && typeof problem.reason === 'string')) {
      throw new Error('Moontide: the instrument-result field problems must be a list of { field, reason }.');
    }
    if (!Number.isInteger(msg.more) || msg.more < 0) throw new Error('Moontide: the instrument-result field more must be a count of further problems.');
    const kept = msg.problems.slice(0, MAX_PROBLEMS).map((problem) => ({ field: problem.field, reason: problem.reason }));
    return { id: msg.id, ok: false, kind: 'invalid', problems: kept, more: Math.max(0, msg.problems.length - MAX_PROBLEMS) + msg.more };
  }
  if (msg.kind !== 'refused' && msg.kind !== 'write-failed') {
    throw new Error(`Moontide: the instrument-result field kind must be refused, write-failed or invalid, got ${JSON.stringify(msg.kind)}.`);
  }
  const hasReason = typeof msg.reason === 'string' && msg.reason !== '';
  return { id: msg.id, ok: false, kind: msg.kind, reason: hasReason ? msg.reason : null, missing: hasReason ? null : 'reason' };
}

/** Every channel of the instrument's model with its role, ascending (the editor offers one chip for each). A rig without them throws. */
function modelChannelsOf(instrument) {
  if (!Array.isArray(instrument.modelChannels)) {
    throw new Error(`Moontide: the instrument ${JSON.stringify(instrument.id)} has no modelChannels (the server and the page must come from the same build).`);
  }
  return [...instrument.modelChannels].sort((a, b) => a.channel - b.channel).map((entry) => ({ channel: entry.channel, role: entry.role }));
}

/** The channels of this instrument that the playing code's tracks use, ascending (empty unless the code was read). */
function usedChannelsOf(instrument, use) {
  if (use.kind !== 'read') return [];
  const used = new Set();
  for (const track of use.tracks) {
    if (track.instrument === null || track.instrument.id !== instrument.id) continue;
    if (Number.isInteger(track.spine.channel)) used.add(track.spine.channel);
  }
  return [...used].sort((a, b) => a - b);
}

/** One card: the declared facts of the instrument, its live port and the tracks that use it now. */
function cardOf(instrument, liveInstruments, use) {
  const live = liveInstruments.find((candidate) => candidate.id === instrument.id);
  if (live === undefined) {
    throw new Error(`Moontide: the live ports have no instrument ${JSON.stringify(instrument.id)} (the rig and its live reading must come from the same read).`);
  }
  return {
    id: instrument.id,
    title: fill(INSTRUMENTS_COPY.cardTitle, { model: instrument.model, port: instrument.port }),
    model: { text: instrument.modelName, title: instrument.model },
    port: portPart(instrument, live),
    channels: channelsText(instrument.channels),
    clock: instrument.clock === true ? INSTRUMENTS_COPY.clockFollows : null,
    controls: instrument.controls.map(chipOf),
    controlsNone: instrument.controls.length === 0 ? INSTRUMENTS_COPY.controlsNone : null,
    catalog: catalogText(instrument.catalogSounds),
    // The server's state of the switch. Only an explicit false is off, like page/midi-out.js.
    enabled: instrument.enabled !== false,
    // What the editor starts from, every channel the model has, and the channels the code plays on.
    settings: { port: instrument.port, channels: instrument.channels.map((entry) => entry.channel).sort((a, b) => a - b), clock: instrument.clock === true },
    modelChannels: modelChannelsOf(instrument),
    usedChannels: usedChannelsOf(instrument, use),
    inUse: inUseOf(instrument, use),
    drumKit: drumKitOf(instrument, use),
    drumMaps: drumMapsOf(instrument, use),
    drumDeclared: drumDeclaredOf(instrument),
  };
}

/** The most refusal rows the editor lists; the rest is "and {count} more". */
const MAX_REFUSAL_ROWS = 5;

/** The field names of the editor, by the last segment of a server `field` (`instruments[1].channels[0]` -> channels). */
const EDITOR_FIELDS = Object.freeze({ port: INSTRUMENTS_COPY.labelPort, channels: INSTRUMENTS_COPY.labelChannels, clock: INSTRUMENTS_COPY.labelClock });

/**
 * The server's refusals of a settings edit as rows: `problems` are `{ field, reason }` in the
 * server's order and `more` the count of further ones. A field whose last segment is port, channels or clock gets that
 * label; any other field comes back raw (label null) for the view to show in a code element. At most five rows, the
 * rest in `more` ("and {count} more"); `invalid` lists the editor fields the rows name, once each.
 */
export function refusalRows({ problems, more }) {
  const rows = problems.slice(0, MAX_REFUSAL_ROWS).map((problem) => {
    const found = /(?:^|\.)(port|channels|clock)(?:\[\d+\])*$/.exec(problem.field);
    return found === null ? { label: null, field: problem.field, reason: problem.reason } : { label: EDITOR_FIELDS[found[1]], field: null, reason: problem.reason, key: found[1] };
  });
  const invalid = [];
  for (const row of rows) if (row.key !== undefined && !invalid.includes(row.key)) invalid.push(row.key);
  const rest = Math.max(0, problems.length - MAX_REFUSAL_ROWS) + more;
  return {
    rows: rows.map(({ label, field, reason }) => ({ label, field, reason })),
    more: rest > 0 ? fill(MIDI_COPY.rowsMore, { count: rest }) : null,
    invalid,
  };
}

/** The line after a settings write that failed: the server's reason, or that it sent none. */
export function writeFailedText(reason) {
  return fill(INSTRUMENTS_COPY.writeFailed, { reason: typeof reason === 'string' && reason !== '' ? reason : INSTRUMENTS_COPY.switchNoReason });
}

/**
 * What the editor lists after a settings request that did not take, from the outcome the view settles with:
 * `{ rows: [{ label, field, reason }], more, invalid }`, the same shape as refusalRows. An invalid answer is the server's
 * rows; a write failure, a plain refusal and "did not confirm" are one row each with no label and no field.
 */
export function editorFailure(outcome) {
  const one = (reason) => ({ rows: [{ label: null, field: null, reason }], more: null, invalid: [] });
  const reasonOf = () => (typeof outcome.reason === 'string' && outcome.reason !== '' ? outcome.reason : INSTRUMENTS_COPY.switchNoReason);
  if (outcome.kind === 'invalid') return refusalRows(outcome);
  if (outcome.kind === 'write-failed') return one(writeFailedText(outcome.reason));
  if (outcome.kind === 'refused') return one(reasonOf());
  if (outcome.kind === 'unconfirmed') return one(MIDI_COPY.takeBackFailed);
  throw new Error(`Moontide: a settings request cannot end as ${JSON.stringify(outcome.kind)}.`);
}

/** The same set of channels, whatever the order. */
function sameChannels(a, b) {
  if (a.length !== b.length) return false;
  const sorted = [...b].sort((x, y) => x - y);
  return [...a].sort((x, y) => x - y).every((channel, index) => channel === sorted[index]);
}

/** The warning for channels the code plays on that the draft takes away: null when there are none. */
function silencedWarning(removed) {
  if (removed.length === 0) return null;
  return fill(removed.length === 1 ? INSTRUMENTS_COPY.warnOne : INSTRUMENTS_COPY.warnMany, { numbers: removed.join(', ') });
}

/**
 * The settings editor of one card: `card` is the card model, `ports` the model's
 * `{ outputs, access, supported }` and `draft` what the user chose so far, `{ port, channels, clock }`. Returns the
 * options of the port select (the browser's order; the current port first when no detected output equals it),
 * one chip per channel of the model, and whether Save has anything to send. The page never validates a draft:
 * the server does.
 */
export function editorModel({ card, ports, draft }) {
  const detected = ports.supported === true && ports.access === 'enabled';
  const names = detected ? ports.outputs : [];
  const current = card.settings.port;
  const options = [];
  const lead = (port) => {
    if (names.includes(port) || options.some((option) => option.value === port)) return;
    // A port the browser lists nothing equal to: with Web MIDI off it is simply the current port; otherwise some output
    // may contain it (the way the rig matches), and if none does it is not detected.
    const contained = names.some((name) => name.includes(port));
    options.push({ value: port, text: !detected || contained ? port : fill(INSTRUMENTS_COPY.portNotDetected, { port }), selected: false });
  };
  lead(current);
  if (draft.port !== current) lead(draft.port);
  for (const name of names) options.push({ value: name, text: name, selected: false });
  for (const option of options) option.selected = option.value === draft.port;
  return {
    name: fill(INSTRUMENTS_COPY.editorName, { id: card.id }),
    ports: options,
    portTitle: draft.port,
    portHint: detected ? (names.length === 0 ? MIDI_COPY.outputsNone : null) : INSTRUMENTS_COPY.portHintIdle,
    chips: card.modelChannels.map((entry) => ({
      channel: entry.channel,
      text: entry.role === 'rhythm' ? fill(INSTRUMENTS_COPY.chipRhythm, { n: entry.channel }) : String(entry.channel),
      checked: draft.channels.includes(entry.channel),
    })),
    clock: draft.clock,
    warning: silencedWarning(card.usedChannels.filter((channel) => !draft.channels.includes(channel))),
    canSave: draft.port !== card.settings.port || draft.clock !== card.settings.clock || !sameChannels(draft.channels, card.settings.channels),
  };
}

/**
 * What the Instruments view shows, from one read of each source (the playing code is one string):
 * `{ connection, superseded, noActive, rig, live, access, supported, code, parse, dataFolder }`.
 * `connection` is connecting, connected, disconnected or refused; `rig` is the rig the page keeps; `live` is
 * midi-out's rigView(); `access` is a member of ACCESS_STATES; `supported` says whether the browser has Web
 * MIDI; `code` is the playing code ('' when nothing plays) and `parse` the parser or null; `dataFolder` is a
 * string or null; `outputs` is the list of output names the browser lists now (the editor's ports). Returns
 * `{ kind: 'message', state, notice, lead, folder, sub, problems, more, closing }` or
 * `{ kind: 'cards', notice, cards, ports, footer }`. An unknown connection, access or port state throws.
 */
export function instrumentsModel(inputs) {
  const { connection, rig, live, access, supported, code, parse } = inputs;
  if (!CONNECTIONS.includes(connection)) {
    throw new Error(`Moontide: the Instruments view needs a connection of ${CONNECTIONS.join(', ')}, got ${JSON.stringify(connection)}.`);
  }
  if (!ACCESS_STATES.includes(access)) {
    throw new Error(`Moontide: the Instruments view needs a MIDI access of ${ACCESS_STATES.join(', ')}, got ${JSON.stringify(access)}.`);
  }
  const notice = noticeFor(supported, access);
  const replaced = messageFor(inputs, notice);
  if (replaced !== null) return replaced;
  if (rig.setup !== 'valid' || live.setup !== 'valid') {
    throw new Error(`Moontide: the Instruments view needs a valid setup in the rig and in the live reading, got ${JSON.stringify(rig.setup)} and ${JSON.stringify(live.setup)}.`);
  }
  const { outputs } = inputs;
  if (!Array.isArray(outputs) || !outputs.every((name) => typeof name === 'string')) {
    throw new Error(`Moontide: the Instruments view needs outputs to be a list of port names, got ${JSON.stringify(outputs)}.`);
  }
  const use = readUse(code, parse, rig);
  return {
    kind: 'cards',
    notice: notice === null ? null : notice.text,
    cards: rig.instruments.map((instrument) => cardOf(instrument, live.instruments, use)),
    // Live, not a declared fact: the output names the browser lists now (empty while Web MIDI is not on) and what the editor may offer.
    ports: { outputs: [...outputs], access, supported },
    footer: INSTRUMENTS_COPY.footer,
  };
}

/** What a card says that only the file declares: the facts a live redraw never has to rebuild. */
function declaredFacts(card) {
  return JSON.stringify({
    id: card.id,
    title: card.title,
    model: card.model,
    portName: card.port.name,
    channels: card.channels,
    clock: card.clock,
    controls: card.controls,
    controlsNone: card.controlsNone,
    catalog: card.catalog,
    drumDeclared: card.drumDeclared,
    settings: card.settings,
    modelChannels: card.modelChannels,
  });
}

/**
 * The indices of the cards whose declared facts differ between two cards models: null when either is not a cards model
 * or the card set or its order differ (then nothing can be compared card by card), else a list that may be empty.
 */
export function cardsToReplace(previous, next) {
  if (previous === null || previous === undefined || previous.kind !== 'cards' || next.kind !== 'cards') return null;
  if (previous.cards.length !== next.cards.length) return null;
  if (previous.cards.some((card, index) => card.id !== next.cards[index].id)) return null;
  const changed = [];
  next.cards.forEach((card, index) => {
    if (declaredFacts(previous.cards[index]) !== declaredFacts(card)) changed.push(index);
  });
  return changed;
}

/**
 * How much of the view must be drawn again: 'none' for an identical model, 'live' when only a port state, the
 * notice or an In use line changed (the cards' own nodes are updated in place), 'replace' when the card set and order
 * are the same and only some cards' declared facts changed (those cards alone are replaced), 'rebuild' when there was
 * no earlier drawing, the message or cards kind changed, or the card set or their order changed.
 */
export function redrawPlan(previous, next) {
  if (previous === null || previous === undefined) return 'rebuild';
  if (JSON.stringify(previous) === JSON.stringify(next)) return 'none';
  const changed = cardsToReplace(previous, next);
  if (changed === null) return 'rebuild';
  return changed.length > 0 ? 'replace' : 'live';
}

/** The most announcements one drawing speaks; the rest is "and {count} more". */
const MAX_ANNOUNCED = 3;

/**
 * The text of the hidden live region after a drawing and the facts to hand to the next call.
 * `previousKinds` is the Map the last call returned (card id -> `{ kind, enabled, settings }`), or null before the
 * first drawing. Per card that was drawn before and is drawn now, one line at most, the first rule that applies:
 * the switch changed (`{id}: switched off`, `{id}: switched on`), the port name, channels or clock changed
 * (`{id}: settings changed`), or the state kind of the port changed (`{id}: unplugged`, `{id}: connected`, ...). The
 * first drawing, a change from or to "not checked", a change that keeps the kind (another `connected as` output) and
 * a card that is new or gone say nothing, and a card that is off never speaks a port state. Up to three are joined
 * with a space, the rest cut. A message has no cards: it returns no facts, so the next cards are a first drawing again.
 */
export function announcements(previousKinds, next) {
  if (next.kind !== 'cards') return { text: '', kinds: null };
  const kinds = new Map(
    next.cards.map((card) => [
      card.id,
      { kind: card.port.stateKind, enabled: card.enabled, settings: JSON.stringify({ port: card.port.name, channels: card.channels, clock: card.clock }) },
    ]),
  );
  if (previousKinds === null || previousKinds === undefined) return { text: '', kinds };
  const said = [];
  for (const card of next.cards) {
    const before = previousKinds.get(card.id);
    if (before === undefined) continue;
    const now = kinds.get(card.id);
    if (before.enabled !== now.enabled) {
      said.push(now.enabled ? fill(INSTRUMENTS_COPY.announceOn, { id: card.id }) : fill(MIDI_COPY.dotSwitchedOff, { port: card.id }));
      continue;
    }
    if (before.settings !== now.settings) {
      said.push(fill(INSTRUMENTS_COPY.announceSettings, { id: card.id }));
      continue;
    }
    if (before.kind === null || now.kind === null || before.kind === now.kind || now.kind === 'off') continue;
    said.push(fill(MIDI_COPY[PORT_STATES[now.kind].dot], { port: card.id }));
  }
  const parts = said.slice(0, MAX_ANNOUNCED);
  if (said.length > MAX_ANNOUNCED) parts.push(fill(MIDI_COPY.rowsMore, { count: said.length - MAX_ANNOUNCED }));
  return { text: parts.join(' '), kinds };
}
