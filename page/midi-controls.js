// Pure MIDI-track reading, the controls rewrite and the preview rate limiter, shared by the Mixer, the
// setup step and later the Timeline. No DOM access at import time, so this module can be imported
// directly by node:test and by page/main.js without a build step. `parse` (acorn) is injected, like in
// page/midi-plan.js. page/mixer-rewrite.js never imports this module, so there is no import cycle.

import { PARSE_OPTIONS, extractTracks, trackNodes } from './tracks.js';
import { controlKeyText as keyText, readMidiSetup } from './midi-plan.js';
import { MixerRewriteError, applyEdits, readSpine, topLevelDeclaredNames, walkNodes } from './mixer-rewrite.js';
import { pitchOf } from './timeline.js';

/**
 * The shortest time between two preview CCs sent while a control is dragged: about 50 CCs a second, a small
 * share of a DIN link (a CC is 3 bytes, about 1 ms at 31.25 kbaud). At the 2026-10-02 bench the drag was
 * judged smooth by ear on a software synth and through a USB MIDI interface.
 */
export const PREVIEW_MIN_GAP_MS = 20;

/** The model's controls with the first one kept for each cc, in model order (a cc is one thing on the wire). */
export function controlsByCc(instrument) {
  const seen = new Set();
  const list = [];
  for (const control of instrument.controls) {
    if (seen.has(control.cc)) continue;
    seen.add(control.cc);
    list.push(control);
  }
  return list;
}

/** The control the Mixer fader sets: the first one on cc 7 (channel volume), or null when the model has none. */
export function faderControl(instrument) {
  return instrument.controls.find((control) => control.cc === 7) ?? null;
}

/**
 * The value a control returns to when the code does not write it. cc 7 always uses the instrument's
 * `defaultVolume` (the reset, the default on leave and the fader's default readout agree by construction);
 * every other control uses its own declared default.
 */
export function defaultOf(instrument, control) {
  return control.cc === 7 ? instrument.defaultVolume : control.default;
}

// --- Reading ---

/** A single-quoted string literal: the only string form that stays a plain name (a double-quoted one is mini-notation). */
function isSingleQuoted(node) {
  return !!node && node.type === 'Literal' && typeof node.value === 'string' && typeof node.raw === 'string' && node.raw.startsWith("'");
}

/** The key of a non-computed property: an identifier name or a string literal; null otherwise. */
function keyOf(property) {
  if (property.type !== 'Property' || property.computed) return null;
  if (property.key.type === 'Identifier') return property.key.name;
  if (property.key.type === 'Literal' && typeof property.key.value === 'string') return property.key.value;
  return null;
}

/** A number literal, or a negated one (`-N`): the only value of a control the page reads and writes. */
function isNumberNode(node) {
  if (node.type === 'Literal') return typeof node.value === 'number';
  return node.type === 'UnaryExpression' && node.operator === '-' && node.argument.type === 'Literal' && typeof node.argument.value === 'number';
}

/** The start offset page/midi-plan.js gives the setup call that reads `node` (a `.midi(` call). */
function setupStartOf(node) {
  return node.arguments[0] ? node.arguments[0].start : node.callee.property.start;
}

/**
 * One scan of the code shared by the reader and the writer: for each track whose spine can be read and holds
 * at least one `.midi` call, `{ track, midiCalls, setupCalls, entryProblem }`. `setupCalls` are the matching
 * readMidiSetup calls (one per midi call, in spine order; undefined for a call it did not read), and
 * `entryProblem` is true when a `.midichan(` that is not plain or a `.midiport(` sits inside the track's own
 * expression (either one changes the port or channel the page cannot read). `all` lists every track with its
 * AST entry (for the sweeps, which any track can write), `setup` is the readMidiSetup result and `declared` the Set
 * of names the program declares at its top level (a track that uses one keeps its strip). Returns { ok: false }
 * when the code does not parse.
 */
function scanTracks(code, parse) {
  let ast;
  try {
    ast = parse(code, PARSE_OPTIONS);
  } catch {
    return { ok: false };
  }
  const setup = readMidiSetup(code, { parse });
  if (!setup.ok) return { ok: false };
  const tracks = extractTracks(code, { parse });
  const nodes = trackNodes(ast);
  const found = [];
  const all = [];
  tracks.forEach((track, index) => {
    const entry = nodes[index];
    all.push({ track, entry });
    let spine;
    try {
      spine = readSpine(code, entry.expression);
    } catch (error) {
      // A spine the mixer cannot read keeps its Mixer strip reason, with no MIDI strip.
      if (error instanceof MixerRewriteError) return;
      throw error;
    }
    const midiCalls = spine.calls.filter((call) => call.name === 'midi');
    if (midiCalls.length === 0) return;
    const setupCalls = midiCalls.map((call) => setup.calls.find((candidate) => candidate.start === setupStartOf(call.node)));
    const entryProblem = setup.calls.some(
      (candidate) =>
        candidate.problems.port !== null &&
        (candidate.problems.port.key === 'midichanNotPlain' || candidate.problems.port.key === 'midiportCall') &&
        candidate.start >= entry.expression.start &&
        candidate.start <= entry.expression.end,
    );
    found.push({ track, entry, midiCalls, setupCalls, entryProblem });
  });
  return { ok: true, found, all, setup, declared: topLevelDeclaredNames(ast) };
}

/** Why a track's MIDI controls are off, from what its `.midi(` call reads and the rig; null when they work. */
function reasonOf(scanned, spine, rig) {
  const { midiCalls, setupCalls, entryProblem } = scanned;
  const problems = setupCalls[0]?.problems;
  if (midiCalls.length > 1 || entryProblem || setupCalls[0] === undefined) return 'portNotPlain';
  if (!isSingleQuoted(midiCalls[0].node.arguments[0])) return 'portNotPlain';
  if (problems.port !== null) return 'portNotPlain';
  if (problems.channel !== null) return problems.channel.key === 'optionsNotPlain' ? 'optionsNotPlain' : 'portNotPlain';
  if (problems.controls !== null) return 'optionsNotPlain';
  // A setup the page could not read, or a known build mismatch, never reads as an invalid file.
  if (rig.setup === 'invalid' && rig.buildMismatch === true) return 'buildMismatch';
  if (rig.setup === 'invalid' && rig.unreadable === true) return 'rigUnreadable';
  if (rig.setup === 'invalid') return 'invalidModel';
  if (rig.setup !== 'valid') return 'noModel';
  return spine.instrument === null ? 'portNotInFile' : null;
}

// --- Sweeps: the controllers Claude moves with ccn/ccv, which the mixer never fights ---

/** The key of a port and channel in the sweep maps: a nul character cannot appear in a port name. */
export function sweepKey(port, channel) {
  return `${port}\u0000${channel}`;
}

// --- Tracks that play no notes: the ones the Mixer folds into one line ---

/** The roots of an expression that can only send controls, a program change or nothing, never a note. */
const NO_NOTE_ROOTS = new Set(['silence', 'ccn', 'ccv', 'progNum']);

/**
 * Every name an expression of a no-note track may use: the roots plus the MIDI call, the signals and the
 * time methods. A closed list on purpose: a name outside it keeps the strip (when in doubt the strip stays).
 */
const NO_NOTE_NAMES = new Set([
  ...NO_NOTE_ROOTS,
  'midi', 'segment', 'seg', 'range', 'slow', 'fast', 'early', 'late', 'rev',
  'sine', 'cosine', 'saw', 'isaw', 'tri', 'square', 'perlin', 'rand',
]);

/** Adds to `names` every identifier under `node`; an option key (a non-computed property key) is a label, not a name. */
function collectNames(node, names) {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) collectNames(child, names);
    return;
  }
  if (typeof node.type !== 'string') return;
  if (node.type === 'Identifier') {
    names.add(node.name);
    return;
  }
  if (node.type === 'Property' && !node.computed) {
    collectNames(node.value, names);
    return;
  }
  for (const key of Object.keys(node)) {
    if (key !== 'type') collectNames(node[key], names);
  }
}

/**
 * True only when the track expression provably cannot put a note on an event: its root is one of silence, ccn,
 * ccv or progNum (and not declared by the user) and every name in it is in the closed list and none is declared.
 * Pure and total: anything unknown returns false, so the strip stays. It does not read `isController`.
 */
export function playsNoNotes(expression, declared) {
  let node = expression;
  while (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && !node.callee.computed) node = node.callee.object;
  let rootName = null;
  if (node.type === 'Identifier') rootName = node.name;
  else if (node.type === 'CallExpression' && node.callee.type === 'Identifier') rootName = node.callee.name;
  if (rootName === null || !NO_NOTE_ROOTS.has(rootName) || declared.has(rootName)) return false;
  const names = new Set();
  collectNames(expression, names);
  for (const name of names) {
    if (!NO_NOTE_NAMES.has(name) || declared.has(name)) return false;
  }
  return true;
}

/** True for a `ccn(...)` call: the bare function or a `.ccn(...)` member call. */
function isCcnCall(node) {
  if (node.type !== 'CallExpression') return false;
  const { callee } = node;
  if (callee.type === 'Identifier') return callee.name === 'ccn';
  return callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier' && callee.property.name === 'ccn';
}

/**
 * The controller numbers a `ccn` call names, or null when the page cannot tell: a number literal is one cc and a
 * string literal (mini-notation such as "<7 10>") is every whole number in it; anything
 * else, a variable or an expression, is unknown. The regex is bounded, and the argument is never evaluated.
 */
function ccnNumbers(call) {
  const [argument] = call.arguments;
  if (argument === undefined || argument.type !== 'Literal') return null;
  if (typeof argument.value === 'number') {
    return Number.isInteger(argument.value) && argument.value >= 0 && argument.value <= 127 ? [argument.value] : null;
  }
  if (typeof argument.value !== 'string') return null;
  const found = (argument.value.match(/\d{1,3}/g) ?? []).map(Number).filter((number) => number <= 127);
  return found.length === 0 ? null : found;
}

/** True for a setup call the page reads completely: a plain port and a plain channel. */
function readableCall(call) {
  return call !== undefined && call.port !== null && call.problems.port === null && call.problems.channel === null;
}

/**
 * The sweeps of the code, per port and channel: `{ sweeps: Map<sweepKey, Set<cc>>, sweepsUnknown: Set<sweepKey> }`.
 * Every track is looked at (a sweep can sit on a track that is not a MIDI strip). A `ccn` belongs to the slot of the
 * port and channel of its track: the track's own `.midi` call when it has one, else the single readable `.midi(`
 * call inside its range; a track with neither adds nothing. A `ccn` whose controllers the page cannot read puts
 * its slot in `sweepsUnknown`, so every control of that channel is treated as moving.
 */
function readSweeps(scan) {
  const sweeps = new Map();
  const sweepsUnknown = new Set();
  for (const { track, entry } of scan.all) {
    const calls = [];
    walkNodes(entry.expression, (node) => {
      if (isCcnCall(node)) calls.push(node);
    });
    if (calls.length === 0) continue;
    const own = scan.found.find((candidate) => candidate.track === track);
    let call = own !== undefined && own.midiCalls.length === 1 ? own.setupCalls[0] : undefined;
    if (!readableCall(call)) {
      const inside = scan.setup.calls.filter((candidate) => candidate.start >= entry.expression.start && candidate.start <= entry.expression.end && readableCall(candidate));
      call = inside.length === 1 ? inside[0] : undefined;
    }
    if (!readableCall(call)) continue;
    const key = sweepKey(call.port, call.channel);
    for (const ccnCall of calls) {
      const numbers = ccnNumbers(ccnCall);
      if (numbers === null) {
        sweepsUnknown.add(key);
        continue;
      }
      if (!sweeps.has(key)) sweeps.set(key, new Set());
      for (const number of numbers) sweeps.get(key).add(number);
    }
  }
  return { sweeps, sweepsUnknown };
}

/**
 * The MIDI tracks of `code`: `{ ok: false }` when it does not parse, else `{ ok: true, tracks, sweeps,
 * sweepsUnknown }`. `sweeps` is a Map from `sweepKey(port, channel)` to the Set of controller numbers a `ccn` of the
 * code moves on that port and channel, and `sweepsUnknown` a Set of the keys whose `ccn` the page cannot read.
 * `tracks` is a Map from
 * track identity to `{ identity, index, kind, muted, name, spine, instrument, reason, playsNotes }` for every track whose
 * own chain (its spine) has a `.midi` call. `spine` is `{ port, channel, sound, controls }` read from the one
 * `.midi` call (`port` null with a port problem, `channel` null with a channel problem, 1 when no channel is
 * written; `controls` a Map from control id to the number written, in written order) and has null fields and
 * no controls when the spine holds several `.midi` calls. `instrument` is the rig instrument whose port equals
 * the spine's port exactly, or null. `reason` says why the controls are off: 'portNotPlain', 'optionsNotPlain',
 * 'invalidModel', 'rigUnreadable', 'buildMismatch', 'noModel', 'portNotInFile', or null. `playsNotes` is false only when
 * the track provably cannot put a note on an event (it only sends controls, changes the program or is a silent
 * clock; see `playsNoNotes`): the Mixer then lists it in one line instead of drawing a strip. A `.midi(` call that is not on a track's own spine is
 * read by the setup step but gets no entry here.
 */
export function readMidiTracks(code, { parse, rig = { setup: 'absent' } }) {
  const scan = scanTracks(code, parse);
  if (!scan.ok) return { ok: false };
  const tracks = new Map();
  for (const scanned of scan.found) {
    const { track, entry, midiCalls, setupCalls } = scanned;
    const call = setupCalls[0];
    const single = midiCalls.length === 1 && call !== undefined;
    const spine = {
      port: single ? call.port : null,
      channel: single && call.problems.channel === null ? call.channel : null,
      sound: single ? call.sound : null,
      controls: single ? call.controls : new Map(),
    };
    const instrument = rig.setup === 'valid' && spine.port !== null ? (rig.instruments.find((candidate) => candidate.port === spine.port) ?? null) : null;
    const withInstrument = { ...spine, instrument };
    tracks.set(track.identity, {
      identity: track.identity,
      index: track.index,
      kind: track.kind,
      muted: track.muted,
      name: track.displayName ?? track.name,
      spine,
      instrument,
      reason: reasonOf(scanned, withInstrument, rig),
      playsNotes: !playsNoNotes(entry.expression, scan.declared),
    });
  }
  const { sweeps, sweepsUnknown } = readSweeps(scan);
  return { ok: true, tracks, sweeps, sweepsUnknown };
}

// --- Writing ---

const CONTROL_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;

// --- Showing ---

/**
 * The one formatter of how a MIDI track names its instrument (the controls inspector line here; the tags of the
 * Timeline and the Mixer later): null when the track's port cannot be read, else `{ name, channel, text, title }`.
 * `name` is the instrument id (the port when the model has no instrument for it), `channel` is ` · ch {n}` (empty
 * when the channel cannot be read), `text` is both, and `title` is the longer form for a hover: `{id} ({port}) ·
 * channel {n}` plus ` · {sound}` when the code writes a sound, `{port} · channel {n}` with no instrument, or the
 * port alone when the channel cannot be read.
 */
export function midiTag(track) {
  const { port, channel, sound } = track.spine;
  if (port === null) return null;
  const name = track.instrument === null ? port : track.instrument.id;
  const channelText = channel === null ? '' : ` · ch ${channel}`;
  let title = port;
  if (channel !== null) {
    title = track.instrument === null ? `${port} · channel ${channel}` : `${track.instrument.id} (${port}) · channel ${channel}`;
    if (track.instrument !== null && sound !== null) title += ` · ${sound}`;
  }
  return { name, channel: channelText, text: `${name}${channelText}`, title };
}

/** The controls a track writes as code, `controls: { volume: 90, pan: 30 }` in written order; empty text for none. */
export function controlsText(controls) {
  const parts = [...controls].map(([id, value]) => `${keyText(id)}: ${value}`);
  return parts.length === 0 ? '' : `controls: { ${parts.join(', ')} }`;
}

/** The leading whitespace of the line `node` starts on. */
function indentOf(code, node) {
  return /^[ \t]*/.exec(code.slice(code.lastIndexOf('\n', node.start - 1) + 1))[0];
}

/** The edits that add `text` (a whole property) as the last property of `object`, after any comma and trailing `// comment`. */
function addProperty(code, object, text) {
  const last = object.properties[object.properties.length - 1];
  if (last === undefined) return [{ from: object.start + 1, to: object.end - 1, insert: ` ${text} ` }];
  if (!code.slice(object.start, object.end).includes('\n')) return [{ from: last.end, to: last.end, insert: `, ${text}` }];
  const tail = /^(?:[ \t]*(,))?(?:[ \t]*(\/\/[^\r\n]*))?/.exec(code.slice(last.end));
  const at = last.end + tail[0].length;
  const eol = code.includes('\r\n') ? '\r\n' : '\n';
  const indent = indentOf(code, last);
  // The last property had its comma: the new line gets one too. Without it, the comma goes right after the
  // property (before its comment) and the new line comes after the comment, which stays on its own line.
  if (tail[1] === ',') return [{ from: at, to: at, insert: `${eol}${indent}${text},` }];
  return [
    { from: last.end, to: last.end, insert: ',' },
    { from: at, to: at, insert: `${eol}${indent}${text}` },
  ];
}

/** The edit that removes the `property` of `object` (which has other properties) without touching a neighbour's comment. */
function removeProperty(code, object, property) {
  const props = object.properties;
  const index = props.indexOf(property);
  const lineStart = code.lastIndexOf('\n', property.start - 1) + 1;
  const alone = /^[ \t]*$/.test(code.slice(lineStart, property.start));
  const rest = /^[ \t]*,?[ \t]*(?:\/\/[^\r\n]*)?\r?\n/.exec(code.slice(property.end));
  // Alone on its line: the whole line goes, with its comma, its comment and its line break.
  if (alone && rest) return { from: lineStart, to: property.end + rest[0].length, insert: '' };
  const neighbour = index > 0 ? props[index - 1] : props[1];
  const between = index > 0 ? code.slice(neighbour.end, property.start) : code.slice(property.end, neighbour.start);
  if (/\/[/*]/.test(between)) {
    // A comment sits between the two: keep it, and drop the property with its own comma.
    const comma = /^[ \t]*,/.exec(code.slice(property.end));
    return { from: property.start, to: property.end + (comma ? comma[0].length : 0), insert: '' };
  }
  if (index > 0) return { from: neighbour.end, to: property.end, insert: '' };
  return { from: property.start, to: neighbour.start, insert: '' };
}

/** The writable parts of a `.midi(` call: { first, options } or a thrown refusal that names the shape. */
function writableCall(node) {
  const bad = (what) => new MixerRewriteError('unsupported-change', what);
  const [first, options, extra] = node.arguments;
  if (!isSingleQuoted(first)) throw bad("the mixer only writes .midi('port', { ... }) with a plain single-quoted port.");
  if (extra !== undefined) throw bad('this .midi() call has more than two arguments, so the mixer cannot place the control.');
  if (options === undefined) return { first, options: null };
  if (options.type !== 'ObjectExpression' || options.properties.some((property) => keyOf(property) === null)) {
    throw bad("the options of this .midi() call are not a plain object, so the mixer can't edit its controls.");
  }
  return { first, options };
}

/** The edits that give one `.midi` call the control `id` at `value` (a whole number) or take it out (null). */
function callEdits(code, node, id, value) {
  const bad = (what) => new MixerRewriteError('unsupported-change', what);
  const { first, options } = writableCall(node);
  const pair = value === null ? null : `${keyText(id)}: ${value}`;
  if (options === null) return pair === null ? [] : [{ from: first.end, to: first.end, insert: `, { controls: { ${pair} } }` }];
  const controlsProps = options.properties.filter((property) => keyOf(property) === 'controls');
  // Strudel spreads the options in order, so the last `controls` key is the one that counts.
  const controlsProp = controlsProps[controlsProps.length - 1];
  if (controlsProp === undefined) return pair === null ? [] : addProperty(code, options, `controls: { ${pair} }`);
  const object = controlsProp.value;
  const plain =
    object.type === 'ObjectExpression' &&
    object.properties.every((property) => keyOf(property) !== null && isNumberNode(property.value));
  if (!plain) throw bad("the controls of this .midi() call are not a plain object of numbers, so the mixer can't edit them.");
  const keys = object.properties.map(keyOf);
  if (new Set(keys).size !== keys.length) throw bad('this .midi() call writes the same control twice, so the mixer cannot choose which one to edit.');
  const property = object.properties.find((candidate) => keyOf(candidate) === id);
  if (property === undefined) return pair === null ? [] : addProperty(code, object, pair);
  if (value !== null) {
    if (code.slice(property.value.start, property.value.end) === String(value)) return [];
    return [{ from: property.value.start, to: property.value.end, insert: String(value) }];
  }
  if (object.properties.length > 1) return [removeProperty(code, object, property)];
  // The last control: `controls` goes, and when it was the only option the whole options argument goes.
  if (options.properties.length > 1) return [removeProperty(code, options, controlsProp)];
  return [{ from: first.end, to: options.end, insert: '' }];
}

/**
 * Writes one control of one MIDI channel on EVERY track whose `.midi` call reads that port and channel, muted
 * ones included, in one edit list (two tracks on one channel that disagree make the evaluation fail). `change`
 * is `{ type: 'midi-control', identity, port, channel, control, cc, value }`: `control` a control id, `cc` its
 * cc, `value` a whole number from 0 to 127, or null to take the control out of the code again. The control goes
 * in the `controls` object of the call's options, after the last property's comma and trailing `// comment`;
 * an emptied `controls` (and options) goes too, so a write followed by its removal gives the original text
 * back. Nothing outside the argument list of a `.midi` call is written, and `.gain()` and velocity are never
 * touched. A control a `ccn` sweep moves on that channel, and any control while a `ccn` the page cannot read sits on it,
 * is refused (the mixer never writes over Claude's sweep), a Default included. Asking for the value the code already
 * holds returns the identical code and no edits. Returns
 * `{ code, edits }` (edits in original coordinates, like writeBus); throws MixerRewriteError.
 */
export function writeMidiControl(code, change, { parse }) {
  const bad = (what) => new MixerRewriteError('unsupported-change', what);
  if (change === null || typeof change !== 'object' || change.type !== 'midi-control') throw bad('a MIDI control change needs type: midi-control.');
  if (typeof change.port !== 'string') throw bad('a MIDI control change needs the port it is on.');
  if (!Number.isInteger(change.channel) || change.channel < 1 || change.channel > 16) throw bad('a MIDI control change needs a channel from 1 to 16.');
  if (typeof change.control !== 'string' || !CONTROL_ID.test(change.control)) throw bad('a MIDI control change needs a control id.');
  if (!Number.isInteger(change.cc) || change.cc < 0 || change.cc > 127) throw bad('a MIDI control change needs a cc from 0 to 127.');
  const { value } = change;
  if (value !== null && (!Number.isInteger(value) || value < 0 || value > 127)) throw bad('a MIDI control must be a whole number from 0 to 127.');
  const scan = scanTracks(code, parse);
  if (!scan.ok) throw bad('the code does not parse, so the mixer cannot write a control.');
  // The mixer never fights a sweep: a control Claude moves with ccn/ccv on this channel, or a ccn the page cannot read, is not written.
  const { sweeps, sweepsUnknown } = readSweeps(scan);
  const slot = sweepKey(change.port, change.channel);
  if (sweepsUnknown.has(slot)) throw bad(`a sweep in the code on channel ${change.channel} uses a controller the mixer cannot read, so it cannot write this control.`);
  if (sweeps.has(slot) && sweeps.get(slot).has(change.cc)) throw bad(`a sweep in the code moves this control on channel ${change.channel}, so the mixer cannot write it.`);
  const edits = [];
  let matched = 0;
  for (const { midiCalls, setupCalls } of scan.found) {
    midiCalls.forEach((call, index) => {
      const read = setupCalls[index];
      if (read === undefined || read.port !== change.port || read.problems.port !== null || read.problems.channel !== null || read.channel !== change.channel) return;
      if (midiCalls.length > 1) throw bad("this track has several .midi() calls, so the mixer can't tell which one to write.");
      matched++;
      edits.push(...callEdits(code, call.node, change.control, value));
    });
  }
  if (matched === 0) throw new MixerRewriteError('track-gone');
  return { code: applyEdits(code, edits), edits };
}

// --- The preview rate limiter ---

/**
 * Sends the CC of a control while it is dragged, at most once per `minGapMs`, never twice in a row for an equal
 * target, and always the last value at `flush()`. `target` is `{ instrumentId, channel, cc, value }`; two
 * targets are equal when all four fields are equal. `send(target)` returns false when nothing could be sent
 * (the target is then not remembered as sent). No timers of its own: `setTimer(fn, ms)`, `clearTimer(handle)`
 * and `now()` are injected, so node:test drives it with a fake clock. Returns `{ move, flush, reset }`.
 * `flush()` also forgets the last target, so the first move of the next drag is always sent: a setup step
 * may have changed the instrument in between.
 */
export function createPreviewSender({ send, setTimer, clearTimer, now, minGapMs = PREVIEW_MIN_GAP_MS }) {
  let last = null;
  let lastAt = -Infinity;
  let pending = null;
  let timer = null;
  const same = (a, b) => a !== null && b !== null && a.instrumentId === b.instrumentId && a.channel === b.channel && a.cc === b.cc && a.value === b.value;

  function fire(target) {
    if (same(target, last)) return;
    lastAt = now();
    if (send(target) !== false) last = target;
  }

  function clearPending() {
    if (timer !== null) clearTimer(timer);
    timer = null;
    pending = null;
  }

  return {
    move(target) {
      // The gap is measured at every move, not only by the timer: a timer can fire late on a busy page, and a
      // move that comes after the gap has passed is sent at once (the timer, if any, then has nothing left to do).
      const wait = Math.max(0, minGapMs - (now() - lastAt));
      if (wait === 0) {
        if (timer !== null) clearTimer(timer);
        timer = null;
        pending = null;
        fire(target);
        return;
      }
      pending = target;
      if (timer !== null) return;
      timer = setTimer(() => {
        timer = null;
        const next = pending;
        pending = null;
        if (next !== null) fire(next);
      }, wait);
    },
    flush() {
      if (timer !== null) clearTimer(timer);
      timer = null;
      const next = pending;
      pending = null;
      if (next !== null) fire(next);
      last = null;
    },
    reset() {
      clearPending();
      last = null;
    },
  };
}

// --- Stopping: what a MIDI track that stopped sounding leaves ringing ---

/** True for a setup entry that is a problem by itself (a `.midiport(` or a misplaced `.midichan(`), not a `.midi(` call. */
function isEntryProblem(call) {
  const key = call.problems.port?.key;
  return call.port === null && (key === 'midichanNotPlain' || key === 'midiportCall');
}

/**
 * The port and channel every MIDI track of `code` plays, for the stop after an evaluation: `{ ok: false }` when
 * the code does not parse, else `{ ok: true, tracks }`, a Map from track identity to `{ identity, index, kind,
 * muted, stable, text, slots, unreadable }` for every track whose source range holds at least one `.midi(` call. `slots`
 * are the distinct `{ port, channel }` of its calls the page reads completely (a plain port and a plain channel;
 * 1 when none is written), `unreadable` is true when any `.midi(`, `.midiport(` or misplaced `.midichan(` in the
 * range has a port or channel the page cannot read, `stable` is true for a named label (its identity does not
 * change with its text; the identity of a `$:` track does), `text` is the source text of its expression (without its
 * label, so a rename alone leaves it unchanged) and `muted` is the track's "not sounding" state (its own
 * mute, a hush, or a solo on another track).
 */
export function readMidiSlots(code, { parse }) {
  let tracks;
  let setup;
  try {
    tracks = extractTracks(code, { parse });
    setup = readMidiSetup(code, { parse });
  } catch {
    return { ok: false };
  }
  if (!setup.ok) return { ok: false };
  const read = new Map();
  for (const track of tracks) {
    const calls = setup.calls.filter((call) => call.start >= track.start && call.start <= track.end);
    if (!calls.some((call) => !isEntryProblem(call))) continue;
    const slots = [];
    let unreadable = false;
    for (const call of calls) {
      if (call.problems.port !== null || call.problems.channel !== null || call.port === null) {
        unreadable = true;
        continue;
      }
      if (!slots.some((slot) => slot.port === call.port && slot.channel === call.channel)) slots.push({ port: call.port, channel: call.channel });
    }
    read.set(track.identity, {
      identity: track.identity,
      index: track.index,
      kind: track.kind,
      muted: track.muted,
      stable: track.identity.startsWith('label:'),
      text: code.slice(track.start, track.end),
      slots,
      unreadable,
    });
  }
  return { ok: true, tracks: read };
}

const sameSlot = (a, b) => a.port === b.port && a.channel === b.channel;

/**
 * What the MIDI tracks of the code that played leave ringing now that `newRead` plays, both from readMidiSlots:
 * `{ silence: [{ port, channel }], targeted: [{ port, channel, track }], skipped: [identity] }`. An old track that
 * was not muted is stopped on each of its slots that the new code does not play with the same identity, unmuted. A
 * stopped slot that no unmuted track of the new code plays gets a `silence` (once per port and channel, in the
 * order of the old tracks). A stopped slot another unmuted track still plays gets a `targeted` stop (that old
 * `track`'s own sounding notes) only when the stopped track is `stable`: the identity of a `$:` track changes with
 * its text, so a `$:` track on a slot the new code still plays is an edit, not a removal. An old unmuted track the
 * page cannot read that no longer plays the same way is `skipped` (its notes end at their natural end). A track that
 * only changed its label (an unmuted track of the new code has the same expression text under a label the old code
 * did not have) keeps playing: it is not a stop. Nothing is stopped when either code did not parse.
 */
export function midiStops(oldRead, newRead) {
  const stops = { silence: [], targeted: [], skipped: [] };
  if (!oldRead.ok || !newRead.ok) return stops;
  const playedNow = (slot) => [...newRead.tracks.values()].some((track) => !track.muted && track.slots.some((candidate) => sameSlot(candidate, slot)));
  for (const old of oldRead.tracks.values()) {
    if (old.muted) continue;
    const next = newRead.tracks.get(old.identity);
    const same = next !== undefined && !next.muted;
    // A rename: the same expression under a label the old code did not have (the identity of a label track is its
    // label). A track that was already there and happens to read the same is a twin, not the renamed one.
    const renames = (track) => !track.muted && !oldRead.tracks.has(track.identity) && track.text === old.text;
    const renamed = !same && typeof old.text === 'string' && [...newRead.tracks.values()].some(renames);
    if (old.unreadable && !same && !renamed) stops.skipped.push(old.identity);
    for (const slot of old.slots) {
      if (same && next.slots.some((candidate) => sameSlot(candidate, slot))) continue;
      if (renamed && [...newRead.tracks.values()].some((track) => renames(track) && track.slots.some((candidate) => sameSlot(candidate, slot)))) continue;
      if (!playedNow(slot)) {
        if (!stops.silence.some((candidate) => sameSlot(candidate, slot))) stops.silence.push({ port: slot.port, channel: slot.channel });
      } else if (old.stable) {
        // The channel is shared: only this track's own sounding notes end. An accepted limit: a note-off
        // for a pitch also ends another track's note of the same pitch at that instant. If the bench shows this
        // targeted stop unreliable, the fallback is one line here: push to `silence` instead of `targeted`.
        stops.targeted.push({ port: slot.port, channel: slot.channel, track: old });
      }
    }
  }
  return stops;
}

/**
 * The window of a stop, in seconds around the scheduler's `now`. Strudel's scheduler queries ahead of what is heard
 * (a latency of 0.1 s and a 0.1 s query window in the pinned bundle), so `now` is the query position: a note that
 * started up to 0.1 s ago may still be heard, and one the scheduler queued for the next 0.3 s is already on its way.
 * Held as seconds and turned into cycles with the tempo.
 */
export const STOP_WINDOW_BEFORE_S = 0.1;
export const STOP_WINDOW_AFTER_S = 0.3;

/** A number from a plain number or a Fraction (`valueOf`), NaN when it is neither. */
function numberOf(value) {
  if (typeof value === 'number') return value;
  return value !== null && typeof value === 'object' && typeof value.valueOf === 'function' ? Number(value.valueOf()) : Number.NaN;
}

/**
 * The MIDI pitches a track's own pattern sounds around `nowCycles`, for a targeted stop: sorted distinct whole numbers
 * from 0 to 127. The pattern (anything with `queryArc`) is queried over [now - STOP_WINDOW_BEFORE_S * cps, now +
 * STOP_WINDOW_AFTER_S * cps]. A hap is kept when it has a `whole` that begins at most at the window's end and whose
 * begin plus its duration (the hap's `duration`, which includes clip, else the length of its whole) is after the
 * window's start; its pitch is `pitchOf(hap.value)` rounded. A hap with no whole, no readable pitch or a pitch
 * outside 0 to 127 is skipped: its note ends at its natural end.
 */
export function notesToStop(pattern, nowCycles, cps) {
  const from = nowCycles - STOP_WINDOW_BEFORE_S * cps;
  const to = nowCycles + STOP_WINDOW_AFTER_S * cps;
  const pitches = new Set();
  for (const hap of pattern.queryArc(from, to)) {
    if (!hap.whole) continue;
    const begin = numberOf(hap.whole.begin);
    const duration = hap.duration === undefined ? numberOf(hap.whole.end) - begin : numberOf(hap.duration);
    if (!(begin <= to) || !(begin + duration > from)) continue;
    const pitch = pitchOf(hap.value);
    if (pitch === null) continue;
    const rounded = Math.round(pitch);
    if (rounded >= 0 && rounded <= 127) pitches.add(rounded);
  }
  return [...pitches].sort((a, b) => a - b);
}
