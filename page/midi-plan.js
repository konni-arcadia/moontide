// Pure MIDI reading for Moontide's browser page: finds the `.midi(` calls of a piece of code,
// classifies each named port against the connected outputs with Strudel's own lookup rule, and
// builds the one set of facts the page sends to the server. No DOM access at import time, so this
// module can be imported directly by node:test and by page/main.js without a build step.
// `parse` (acorn) is injected, like in page/tracks.js.

import { PARSE_OPTIONS } from './tracks.js';
import { cutText } from './ask.js';
import { CLOCK_STATES } from './midi-clock.js';

/**
 * The limits of the midi-state message. src/protocol.ts holds the same numbers
 * (MAX_MIDI_NAME_LENGTH, MAX_MIDI_OUTPUTS, MAX_MIDI_PORTS, MAX_MIDI_FAILURE_LENGTH);
 * test/midi-plan.test.js checks both sides.
 */
export const MIDI_LIMITS = Object.freeze({ name: 200, outputs: 64, ports: 32, failure: 64 });

export const ACCESS_STATES = ['idle', 'pending', 'enabled', 'denied', 'unsupported', 'failed'];

/** Calls `visit(node)` for `node` and every descendant (the shape of page/tracks.js walk). */
function walk(node, visit) {
  if (!node || typeof node.type !== 'string') return;
  visit(node);
  for (const key in node) {
    if (key === 'parent') continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) walk(child, visit);
    } else if (value && typeof value.type === 'string') {
      walk(value, visit);
    }
  }
}

function isMemberCallNamed(node, name) {
  return (
    node.type === 'CallExpression' &&
    node.callee.type === 'MemberExpression' &&
    !node.callee.computed &&
    node.callee.property.type === 'Identifier' &&
    node.callee.property.name === name
  );
}

function isMidiMemberCall(node) {
  return isMemberCallNamed(node, 'midi');
}

/**
 * True when `code` contains a `.midi(` call anywhere (not in a comment or a string). False for
 * anything that is not code, and for code that does not parse: that evaluation fails anyway, so
 * the page must never ask for MIDI access because of it.
 */
export function usesMidi(code, { parse }) {
  if (typeof code !== 'string' || !code.includes('midi')) return false;
  let ast;
  try {
    ast = parse(code, PARSE_OPTIONS);
  } catch {
    return false;
  }
  let found = false;
  walk(ast, (node) => {
    if (isMidiMemberCall(node)) found = true;
  });
  return found;
}

/** A single-quoted string literal: the only string form that stays a plain name (a double-quoted one is mini-notation). */
function isSingleQuoted(node) {
  return node.type === 'Literal' && typeof node.value === 'string' && typeof node.raw === 'string' && node.raw.startsWith("'");
}

/** The top-level `const NAME = '...'` declarations (one level of resolution, like page/tracks.js collectTopLevelDecls). */
function collectConstPorts(ast) {
  const ports = new Map();
  for (const statement of ast.body) {
    if (statement.type !== 'VariableDeclaration' || statement.kind !== 'const') continue;
    for (const declarator of statement.declarations) {
      if (declarator.id.type === 'Identifier' && declarator.init && isSingleQuoted(declarator.init)) {
        ports.set(declarator.id.name, declarator.init.value);
      }
    }
  }
  return ports;
}

function propertyKeyName(property) {
  if (property.type !== 'Property' || property.computed) return null;
  if (property.key.type === 'Identifier') return property.key.name;
  if (property.key.type === 'Literal' && typeof property.key.value === 'string') return property.key.value;
  return null;
}

/** What one port expression means: a name, an index, the default output, or something the page cannot read. */
function readPort(node, consts) {
  if (!node) return { kind: 'default' };
  if (isSingleQuoted(node)) return { kind: 'name', name: node.value };
  if (node.type === 'Literal' && typeof node.value === 'number') return { kind: 'index', index: node.value };
  if (node.type === 'Identifier' && consts.has(node.name)) return { kind: 'name', name: consts.get(node.name) };
  if (node.type === 'ObjectExpression') {
    let portNode = null;
    for (const property of node.properties) {
      if (property.type === 'SpreadElement' || property.computed) return { kind: 'unreadable' };
      if (propertyKeyName(property) === 'port') portNode = property.value;
    }
    if (portNode === null) return { kind: 'default' };
    const inner = readPort(portNode, consts);
    return inner.kind === 'default' ? { kind: 'unreadable' } : inner;
  }
  return { kind: 'unreadable' };
}

/** True when `node` is an object with a `midiport` or `port` key: Strudel spreads such options after the port. */
function overridesPort(node) {
  return (
    !!node &&
    node.type === 'ObjectExpression' &&
    node.properties.some((property) => {
      const key = propertyKeyName(property);
      return key === 'midiport' || key === 'port';
    })
  );
}

/**
 * The port calls of `code` (`.midi(...)`, `.midiport(...)` and a bare `midiport(...)`), sorted by the
 * position of their port text. Each is { kind: 'name', name, start }, { kind: 'index', index, start },
 * { kind: 'default', start } (no port named) or { kind: 'unreadable', start }. Returns
 * { ok: false, error } when the code does not parse.
 */
export function readMidiCalls(code, { parse }) {
  let ast;
  try {
    ast = parse(code, PARSE_OPTIONS);
  } catch (error) {
    return { ok: false, error };
  }
  const consts = collectConstPorts(ast);
  const calls = [];
  walk(ast, (node) => {
    const first = node.type === 'CallExpression' ? node.arguments[0] : undefined;
    const start = first ? first.start : node.start;
    if (isMidiMemberCall(node)) {
      const port = overridesPort(node.arguments[1]) ? { kind: 'unreadable' } : readPort(first, consts);
      calls.push({ ...port, start });
    } else if (isMemberCallNamed(node, 'midiport') || (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'midiport')) {
      // A per-hap control that overrides the call's port: a name or nothing the page can read.
      const port = readPort(first, consts);
      calls.push({ ...(port.kind === 'name' ? port : { kind: 'unreadable' }), start });
    }
  });
  calls.sort((a, b) => a.start - b.start);
  return { ok: true, calls };
}

/** The object of a `.midi(` argument when it is a plain literal object (no spread, no computed key), else null. */
function plainObject(node) {
  if (!node || node.type !== 'ObjectExpression') return null;
  return node.properties.every((property) => property.type === 'Property' && !property.computed) ? node : null;
}

/** A whole number from 1 to 16 written as a literal. */
function isChannelLiteral(node) {
  return node.type === 'Literal' && typeof node.value === 'number' && Number.isInteger(node.value) && node.value >= 1 && node.value <= 16;
}

const problem = (key, hints = []) => ({ key, hints });

/** The value of a finite number literal, or of a negated one (`-N`); null for anything else. (A private copy of the
 * page/mixer-rewrite.js rule: this module stays a leaf, so there is no import cycle.) */
function numberLiteral(node) {
  let value = null;
  if (node.type === 'Literal' && typeof node.value === 'number') value = node.value;
  else if (node.type === 'UnaryExpression' && node.operator === '-' && node.argument.type === 'Literal' && typeof node.argument.value === 'number') value = -node.argument.value;
  return value !== null && Number.isFinite(value) ? value : null;
}

/** A control id as a property key in written code: bare when it is an identifier, else single-quoted (ids hold only [a-z0-9_-], so no quote can appear). */
export function controlKeyText(id) {
  return /^[A-Za-z_$][\w$]*$/.test(id) ? id : `'${id}'`;
}

/**
 * The `controls` option when it is a plain object of number literals (every property non-computed, with an
 * identifier or string key, no key twice): a Map from key to number in written order; null for anything else.
 */
function readControlsObject(node) {
  if (node.type !== 'ObjectExpression') return null;
  const values = new Map();
  for (const property of node.properties) {
    const id = propertyKeyName(property);
    const value = id === null ? null : numberLiteral(property.value);
    if (id === null || value === null || values.has(id)) return null;
    values.set(id, value);
  }
  return values;
}

/** The parent of every node, so a member chain can be followed upward from a `.midichan(` call. */
function collectParents(ast) {
  const parents = new Map();
  walk(ast, (node) => {
    for (const key in node) {
      if (key === 'parent') continue;
      const value = node[key];
      if (Array.isArray(value)) {
        for (const child of value) if (child && typeof child.type === 'string') parents.set(child, node);
      } else if (value && typeof value.type === 'string') {
        parents.set(value, node);
      }
    }
  });
  return parents;
}

/** The first `.midi(` call down the receiver chain of `node` (`a.midi('P').b().c()` read from `c`), or null. */
function midiDownChain(node) {
  let current = node.callee.object;
  while (current && current.type === 'CallExpression' && current.callee.type === 'MemberExpression') {
    if (isMidiMemberCall(current)) return current;
    current = current.callee.object;
  }
  return null;
}

/** The first `.midi(` call up the chain of `node` (the calls whose receiver is `node`, then theirs), or null. */
function midiUpChain(node, parents) {
  let current = node;
  for (;;) {
    const member = parents.get(current);
    if (!member || member.type !== 'MemberExpression' || member.object !== current || member.computed) return null;
    const call = parents.get(member);
    if (!call || call.type !== 'CallExpression' || call.callee !== member) return null;
    if (isMidiMemberCall(call)) return call;
    current = call;
  }
}

/**
 * The port, channel and sound of one `.midi(` call, each with its own problem when it is not written
 * in plain form. Several problems can stand at once (a plain port and a channel that is not a literal):
 * the checks of page/midi-rig.js report the first in the order port, channel, sound.
 */
function readSetupCall(node, midichan) {
  const [first, second] = node.arguments;
  const start = first ? first.start : node.callee.property.start;
  const result = { start, port: null, channel: 1, sound: null, controls: new Map(), problems: { port: null, channel: null, sound: null, controls: null } };
  const sources = [];
  if (first && isSingleQuoted(first)) {
    result.port = first.value;
    if (second !== undefined) sources.push({ node: second, portKeysAllowed: false });
  } else {
    const object = plainObject(first);
    const portProperty = object && object.properties.find((property) => propertyKeyName(property) === 'port');
    if (portProperty && isSingleQuoted(portProperty.value)) {
      result.port = portProperty.value.value;
      sources.push({ node: first, portKeysAllowed: true });
      if (second !== undefined) sources.push({ node: second, portKeysAllowed: false });
    } else {
      result.problems.port = problem('portNotPlain');
      return result;
    }
  }
  const objects = [];
  for (const source of sources) {
    const object = plainObject(source.node);
    if (object === null) {
      result.problems.channel ??= problem('optionsNotPlain');
      continue;
    }
    objects.push(object);
    for (const property of object.properties) {
      const key = propertyKeyName(property);
      // Strudel spreads these after the port the call names: the page cannot say which port plays.
      if (key === 'midiport' || (key === 'port' && !source.portKeysAllowed)) result.problems.port ??= problem('portNotPlain');
    }
  }
  if (result.problems.channel !== null) return result;
  for (const object of objects) {
    for (const property of object.properties) {
      const key = propertyKeyName(property);
      if (key === 'midichannel') {
        if (isChannelLiteral(property.value)) {
          result.channel = property.value.value;
          result.problems.channel = null;
        } else {
          result.problems.channel = problem('channelNotPlain');
        }
      } else if (key === 'sound') {
        if (isSingleQuoted(property.value)) {
          result.sound = property.value.value;
          result.problems.sound = null;
        } else {
          const doubleQuoted = property.value.type === 'Literal' && typeof property.value.raw === 'string' && property.value.raw.startsWith('"');
          result.problems.sound = problem('soundNotPlain', doubleQuoted ? ['doubleQuotes'] : []);
        }
      } else if (key === 'controls') {
        // The last `controls` key wins (Strudel spreads the options in order). A value that is not a plain
        // object of numbers is the controlsNotPlain problem of the call, with no controls.
        const read = readControlsObject(property.value);
        result.controls = read ?? new Map();
        result.problems.controls = read === null ? problem('controlsNotPlain') : null;
      }
    }
  }
  // A .midichan(n) on the same chain overrides the options' channel (a hap's own midichan wins in Strudel).
  if (midichan !== undefined) {
    result.channel = midichan;
    result.problems.channel = null;
  }
  return result;
}

/** An entry that is a problem by itself, at the position of its call (a `.midiport(` or a misplaced `.midichan(`). */
function entryProblem(node, key, hints = []) {
  const first = node.arguments[0];
  const start = first ? first.start : node.callee.type === 'MemberExpression' ? node.callee.property.start : node.start;
  return { start, port: null, channel: 1, sound: null, controls: new Map(), problems: { port: problem(key, hints), channel: null, sound: null, controls: null } };
}

/**
 * The port, channel and sound written in every `.midi(` call of `code`, in source order, for the
 * setup file's checks. Returns { ok: false } when the code does not parse (nothing is
 * refused then: Strudel reports its own syntax error), else { ok: true, calls }, each call
 * { start, port: string | null, channel, sound: string | null, controls: Map<string, number>, problems: { port,
 * channel, sound, controls } } where a problem is null or { key, hints }: `key` and each hint are RIG_COPY
 * keys. Only values written in plain form in the call are read; the port must be a single-quoted literal in
 * the call, a channel a whole number from 1 to 16, a sound a single-quoted literal and `controls` a plain
 * object of number literals (read in written order; any other value gives the `controlsNotPlain` problem and no controls). A `.midichan(n)` with a whole-number literal
 * on the member chain of one `.midi(` call sets that call's channel; a `.midichan(` that is not plain,
 * is a second one on a chain, or has no `.midi(` call on its chain, and every `.midiport(` call, become
 * entries of their own that carry a problem at their own position.
 */
export function readMidiSetup(code, { parse }) {
  let ast;
  try {
    ast = parse(code, PARSE_OPTIONS);
  } catch {
    return { ok: false };
  }
  const parents = collectParents(ast);
  const midichans = new Map();
  const misplaced = [];
  walk(ast, (node) => {
    if (!isMemberCallNamed(node, 'midichan')) return;
    const down = midiDownChain(node);
    const up = midiUpChain(node, parents);
    const arg = node.arguments[0];
    const plain = node.arguments.length === 1 && isChannelLiteral(arg);
    if (!plain || (down === null) === (up === null)) {
      // Not a plain number, on no chain, or between two .midi() calls.
      misplaced.push(node);
      return;
    }
    const target = down ?? up;
    if (!midichans.has(target)) midichans.set(target, []);
    midichans.get(target).push(node);
  });
  const calls = [];
  for (const node of misplaced) calls.push(entryProblem(node, 'midichanNotPlain', ['midichanHint']));
  walk(ast, (node) => {
    if (isMidiMemberCall(node)) {
      const attached = (midichans.get(node) ?? []).sort((a, b) => a.start - b.start);
      calls.push(readSetupCall(node, attached.length > 0 ? attached[0].arguments[0].value : undefined));
      // A second .midichan on one chain is an extra: refused at its own position.
      for (const extra of attached.slice(1)) calls.push(entryProblem(extra, 'midichanNotPlain', ['midichanHint']));
    } else if (isMemberCallNamed(node, 'midiport') || (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'midiport')) {
      calls.push(entryProblem(node, 'midiportCall'));
    }
  });
  calls.sort((a, b) => a.start - b.start);
  return { ok: true, calls };
}

/**
 * Strudel's own rule (getDevice in @strudel/midi): a port name matches every output whose name
 * contains it (case-sensitive), and the first match in output order is the one Strudel uses.
 * No match is 'unplugged' when an output seen earlier in this page session contains the name,
 * else 'not-found'; one match is 'connected'; several are 'ambiguous'.
 */
export function portState(name, outputs, seen) {
  const matches = outputs.filter((output) => output.includes(name));
  if (matches.length === 0) {
    for (const earlier of seen) {
      if (earlier.includes(name)) return { state: 'unplugged', matches };
    }
    return { state: 'not-found', matches };
  }
  return { state: matches.length === 1 ? 'connected' : 'ambiguous', matches };
}

/** A number port is an index into the outputs (Strudel's `outputs[index]`). */
export function indexState(index, outputs) {
  const match = outputs[index];
  return typeof match === 'string' ? { state: 'connected', matches: [match] } : { state: 'not-found', matches: [] };
}

/** The output Strudel uses when a call names no port: the first output whose name contains IAC, else the first output. */
export function defaultOutput(outputs) {
  return outputs.find((output) => output.includes('IAC')) ?? outputs[0] ?? null;
}

/**
 * The facts the page tells the server (the midi-state message without its type). `triedCode` is
 * the code of the latest evaluation attempt, `activeCode` the code that last evaluated
 * successfully; the port facts come from the active code, and only while access is 'enabled'
 * (without access the ports are unknown).
 */
export function buildMidiFacts({ access, failure, triedCode, activeCode, outputs, seen, hidden, playing, parse }) {
  if (!ACCESS_STATES.includes(access)) {
    throw new Error(`Moontide: the MIDI access state must be one of ${ACCESS_STATES.join(', ')}, got ${JSON.stringify(access)}.`);
  }
  const cut = (text) => cutText(text, MIDI_LIMITS.name);
  const ports = [];
  let noPort = null;
  let unreadable = false;
  const read = readMidiCalls(activeCode, { parse });
  if (read.ok) {
    const named = new Set();
    for (const call of read.calls) {
      if (call.kind === 'unreadable') {
        unreadable = true;
      } else if (call.kind === 'default') {
        noPort = { using: defaultOutput(outputs) };
      } else {
        const name = call.kind === 'name' ? call.name : String(call.index);
        if (named.has(name) || named.size >= MIDI_LIMITS.ports) continue;
        named.add(name);
        const { state, matches } = call.kind === 'name' ? portState(name, outputs, seen) : indexState(call.index, outputs);
        ports.push({ name: cut(name), state, matches: matches.slice(0, MIDI_LIMITS.outputs).map(cut) });
      }
    }
  }
  const enabled = access === 'enabled';
  return {
    access,
    failure: typeof failure === 'string' ? cutText(failure, MIDI_LIMITS.failure) : null,
    usesMidi: usesMidi(activeCode, { parse }),
    triedMidi: usesMidi(triedCode, { parse }),
    outputs: outputs.slice(0, MIDI_LIMITS.outputs).map(cut),
    ports: enabled ? ports : [],
    noPort: enabled ? noPort : null,
    unreadable,
    hidden: hidden === true,
    playing: playing === true,
  };
}

/**
 * The silence of one channel (1 to 16): sustain release (CC64 = 0) then All Notes Off (CC123). The sustain
 * release comes first because All Notes Off respects a held pedal: the notes it cuts would otherwise ring on.
 * Stop sends it on every channel; a muted or removed MIDI track sends it on its own channel.
 */
export function channelSilence(channel) {
  const status = 0xb0 | (channel - 1);
  return [
    [status, 64, 0],
    [status, 123, 0],
  ];
}

/** The 32 messages Stop sends to a port: the silence of each channel from 1 to 16, in channel order. */
export function panicMessages() {
  const messages = [];
  for (let channel = 1; channel <= 16; channel++) messages.push(...channelSilence(channel));
  return messages;
}

/**
 * The ports the calls of a piece of code name, for Stop: { names, all }. `names` are the port names
 * in call order; `all` is true when a call's port cannot be pinned to a name now, so every connected
 * output must be silenced: a port that could not be read, a port given by index and a call without a
 * port. Strudel resolves the last two at every note, against the outputs present then, so a device
 * that appears or leaves later can be the one that plays; a name resolved at evaluation time would
 * leave it ringing.
 */
export function panicTargetsFrom(calls) {
  const names = [];
  let all = false;
  for (const call of calls) {
    if (call.kind === 'name') {
      if (!names.includes(call.name)) names.push(call.name);
    } else {
      all = true;
    }
  }
  return { names, all };
}

/**
 * The native ports Stop silences, in order, over plain { id, name, state } objects in map order:
 * for each name in order every connected native whose name contains it (Strudel's substring rule;
 * a match too many is harmless for a panic), each native once; then, when `all` is true, every
 * other connected native.
 */
export function panicOrder(names, all, natives) {
  const ordered = [];
  const take = (native) => {
    if (native.state === 'connected' && !ordered.includes(native)) ordered.push(native);
  };
  for (const name of names) {
    for (const native of natives) {
      if (typeof native.name === 'string' && native.name.includes(name)) take(native);
    }
  }
  if (all) for (const native of natives) take(native);
  return ordered;
}

/**
 * The text of Strudel's own error when no MIDI output is connected. The pinned bundle's getDevice
 * throws "🔌 No MIDI devices found. Connect a device or enable IAC Driver." and the scheduler logs
 * it as a `[getTrigger] error:` line on every hap, so it would reach Claude once per note.
 */
export const STRUDEL_NO_DEVICES_TEXT = 'No MIDI devices found';

/** True for a runtime-error text that is Strudel's per-cycle "no MIDI devices" line. */
export function isStrudelNoDevicesError(text) {
  return typeof text === 'string' && text.includes(STRUDEL_NO_DEVICES_TEXT);
}

/**
 * The page's own MIDI wording. Everything the user reads in the top bar about the
 * tab role comes from here; the server's wording for Claude lives in src/midi-state.ts.
 */
export const MIDI_COPY = Object.freeze({
  refusedSuperseded: 'Moontide is playing in another tab, so this tab does not play.',
  takeoverText: 'Moontide is playing in another tab',
  // The active tab went away and no tab plays: the same segment and button, another sentence.
  noActiveText: 'No tab is playing',
  refusedNoActive: 'No tab is playing, so this tab does not play until you choose Play in this tab.',
  takeBack: 'Play in this tab',
  takingOver: 'Taking over\u2026',
  takeBackFailed: 'Moontide did not confirm \u2014 try again.',
  // The top-bar indicator. `{port}` and the other `{name}` parts are
  // filled by `fill`. Every text the page shows about MIDI state is here, so nothing is worded twice.
  infoText: 'i',
  infoLabel: 'About MIDI in this page',
  helpLabel: 'How MIDI works in this page',
  indicatorUnsupported: 'MIDI: no Web MIDI, use Chrome or Edge',
  indicatorDenied: 'MIDI: permission denied',
  indicatorPending: 'MIDI: waiting for permission',
  indicatorFailed: 'MIDI: could not start',
  indicatorNoOutputs: 'MIDI: no outputs connected',
  indicatorUnplugged: 'MIDI: {port} unplugged',
  indicatorNotFound: 'MIDI: {port} not found',
  indicatorAmbiguous: 'MIDI: {port} matches several outputs',
  indicatorAttention: 'MIDI: {k} of {n} ports need attention',
  indicatorUsing: 'MIDI: using {output}',
  indicatorConnected: 'MIDI: {port} connected',
  indicatorManyConnected: 'MIDI: {n} ports connected',
  indicatorUnchecked: 'MIDI: port not checked',
  dotConnected: '{port}: connected',
  dotUnplugged: '{port}: unplugged',
  dotNotFound: '{port}: not found',
  dotAmbiguous: '{port}: matches several outputs',
  // The popover: a lead paragraph, the port rows, the outputs line, a closing paragraph.
  popAllLead: 'Moontide is sending to the MIDI ports named in the code.',
  popAllClosing: 'If a port is unplugged, playing resumes by itself when it is back.',
  popUnpluggedLead: '{port} is unplugged.',
  popUnpluggedClosing: 'Plug it back in. Playing resumes by itself, without a new evaluation. Claude has been told.',
  popNotFoundLead: '{port} was not found. No output has this name.',
  popNotFoundClosing: 'Ask Claude to use one of the connected outputs below. Claude has been told. Other tracks keep playing.',
  popAmbiguousLead: '{port} matches several outputs.',
  popAmbiguousClosing: 'Ask Claude to use the full name of one of them. Claude has been told.',
  popSeveralLead: '{k} of the {n} ports named in the code need attention.',
  popSeveralClosing: 'Claude has been told. Other tracks keep playing.',
  popNoPortLead: 'The code names no MIDI port, so this output is used: {output}.',
  popNoPortClosing: 'Ask Claude to name the port you want.',
  popNoOutputsLead: 'No MIDI outputs are connected.',
  popNoOutputsClosing: 'Connect an instrument, or start a software one, then it is found by itself. Claude has been told. Other tracks keep playing.',
  popPendingLead: 'Your browser is asking for MIDI access. Allow it to hear MIDI instruments.',
  popPendingClosing:
    'Moontide asks once, and only for code that uses MIDI. The prompt says "control and reprogram" because it also asks for system-exclusive access, which some instruments need to be reset. Other tracks keep playing.',
  popDeniedLead: 'MIDI access is blocked for this page, so MIDI tracks are silent.',
  popDeniedClosing:
    'To allow it again: click the padlock left of the address bar, open Site settings, set MIDI devices to Allow, then reload this page. Claude has been told. Other tracks keep playing.',
  popUnsupportedLead: 'This browser has no Web MIDI, so MIDI instruments cannot play here.',
  popUnsupportedClosing: 'Use Chrome or Edge. Claude has been told. Other tracks keep playing.',
  popFailedLead: 'Web MIDI could not start in this page ({failure}), so MIDI tracks are silent.',
  popFailedLeadPlain: 'Web MIDI could not start in this page, so MIDI tracks are silent.',
  popFailedClosing: 'Reload the page to try again. Claude has been told. Other tracks keep playing.',
  popUncheckedLead: 'A port in the code is not a plain single-quoted name, so the page cannot check it.',
  popUncheckedClosing: 'Stop silences every connected output. Claude has been told.',
  rowConnected: 'connected',
  rowConnectedAs: 'connected as {output}',
  rowUnplugged: 'unplugged',
  rowNotFound: 'not found, check the name',
  rowAmbiguous: 'matches several outputs: {outputs}',
  rowSeparator: ' · ',
  outputsLine: 'Connected outputs: {outputs}.',
  outputsMore: '{outputs} and {count} more',
  outputsNone: 'No MIDI outputs are connected.',
  // The return banner after a hidden period (times are local HH:MM, see hhmm).
  bannerText: 'MIDI timing may have broken while this tab was hidden (from {from} to {to}).',
  bannerDismiss: 'Dismiss',
  // The instruments of instruments.json. With a valid file the
  // instrument id takes the place of the port name; the dot titles reuse the dot keys with the id in {port}.
  indicatorSetupInvalid: 'MIDI: instruments.json is invalid',
  // A MIDI setup the page could not read, or a known build mismatch (never "instruments.json is invalid").
  indicatorRigUnreadable: 'MIDI: setup not readable, restart the server',
  popRigUnreadableLead: 'The page could not read the MIDI setup the server sent, so no instruments are set up.',
  popRigUnreadableClosing: 'The server may come from an older build: restart Claude (the server), then reload this page.',
  indicatorBuildMismatch: 'MIDI: different builds, restart the server',
  popBuildMismatchLead: 'The server and the page come from different builds, so no instruments are set up.',
  popBuildMismatchClosing: 'Restart Claude (the server), then reload this page.',
  indicatorInstrumentConnected: 'MIDI: {id} connected',
  indicatorInstrumentsConnected: 'MIDI: {n} instruments connected',
  indicatorInstrumentUnplugged: 'MIDI: {id} unplugged',
  indicatorInstrumentNotFound: 'MIDI: {id} not found',
  indicatorInstrumentAmbiguous: 'MIDI: {id} matches several outputs',
  indicatorInstrumentsAttention: 'MIDI: {k} of {n} instruments need attention',
  popRigAllLead: 'Moontide is sending to the instruments in instruments.json.',
  popRigAllClosing: 'If an instrument is unplugged, playing resumes by itself when it is back, and the instrument is reset to its known state.',
  popRigUnpluggedLead: '{id} is unplugged.',
  popRigUnpluggedClosing: 'Plug it back in. Playing resumes by itself and the instrument is reset to its known state. Claude has been told.',
  popRigNotFoundLead: '{id} was not found. No output has the port name written in instruments.json.',
  popRigNotFoundClosing: 'Check the port name in instruments.json, or start the instrument. Claude has been told. Other tracks keep playing.',
  popRigAmbiguousLead: '{id} matches several outputs.',
  popRigAmbiguousClosing: 'Use the exact output name in instruments.json. Claude has been told.',
  popRigSeveralLead: '{k} of the {n} instruments in use need attention.',
  popRigSeveralClosing: 'Claude has been told. Other tracks keep playing.',
  popSetupInvalidLead: 'instruments.json has a problem, so no instruments are set up.',
  popSetupInvalidClosing: 'Fix the file, then reload this page. Claude has been told.',
  rowRigNotFound: 'not found, check the name in instruments.json',
  rowResetAt: 'reset at {time}',
  rowNotUsed: 'not used by the code',
  // An instrument the user switched off. The Instruments card, the top bar and the
  // live announcement all read these two, so nothing is worded twice. {port} is the instrument id, like the other dot keys.
  rowSwitchedOff: 'switched off',
  dotSwitchedOff: '{port}: switched off',
  // The clock part of an instrument row, between the connection and the reset.
  rowClockRunning: 'clock running',
  rowClockWaiting: 'clock starts on next cycle',
  rowPartsJoin: ', ',
  rowsMore: 'and {count} more',
  noSetupNote: 'No instruments.json found, so port and sound names are not checked.',
  // The one muted line of the popover while a clock waits or runs.
  clockNote: 'Moontide sends the MIDI clock, Start and Stop to the instruments marked clock.',
  // Instruments switched off are counted apart and are not an attention
  // state. n counts the instruments of the file that are on, k those that are off.
  indicatorInstrumentsOnOff: 'MIDI: {n} instruments on, {k} off',
  indicatorInstrumentOnOff: 'MIDI: 1 instrument on, {k} off',
  indicatorInstrumentOff: 'MIDI: {id} off',
  indicatorAllOff: 'MIDI: all {k} instruments off',
  titleOff: '{text}. Off: {ids}.',
  offNote: 'Instruments switched off stay silent. Switch them on in the Instruments view (key 6).',
});

/** Fills the `{name}` placeholders of a MIDI_COPY string. A placeholder without a value throws (loud, never a blank). */
export function fill(template, values = {}) {
  return template.replace(/\{(\w+)\}/g, (_, key) => {
    if (!(key in values)) throw new Error(`Moontide: the MIDI copy needs a value for {${key}}.`);
    return String(values[key]);
  });
}

/** How long a port name in the top bar may be before it is cut with an ellipsis. */
export const INDICATOR_NAME_LIMIT = 24;

/** At most this many dots are drawn; the text already gives the count. */
export const INDICATOR_MAX_DOTS = 6;

/** At most this many output names are listed in the popover; the rest is "and {N} more". */
export const POPOVER_MAX_OUTPUTS = 6;

/** At most this many instrument rows are listed in the popover; the rest is "and {N} more". */
export const POPOVER_MAX_ROWS = 12;

/** At most this many problems of an invalid setup file are listed in the popover; the rest is "and {N} more". */
export const POPOVER_MAX_PROBLEMS = 3;

const SETUP_CASES = ['absent', 'valid', 'invalid'];

const HIDDEN_INDICATOR = Object.freeze({
  visible: false,
  text: '',
  title: '',
  attention: false,
  dots: Object.freeze([]),
  popover: null,
});

/** The access problems that show for the attempted code, with their indicator and popover copy keys. */
const ACCESS_COPY = Object.freeze({
  unsupported: { text: 'indicatorUnsupported', lead: 'popUnsupportedLead', closing: 'popUnsupportedClosing' },
  denied: { text: 'indicatorDenied', lead: 'popDeniedLead', closing: 'popDeniedClosing' },
  pending: { text: 'indicatorPending', lead: 'popPendingLead', closing: 'popPendingClosing' },
  failed: { text: 'indicatorFailed', lead: 'popFailedLead', closing: 'popFailedClosing' },
});

/** The copy keys of a port that is not connected, by its state. */
const PORT_PROBLEM_COPY = Object.freeze({
  unplugged: { text: 'indicatorUnplugged', dot: 'dotUnplugged', lead: 'popUnpluggedLead', closing: 'popUnpluggedClosing' },
  'not-found': { text: 'indicatorNotFound', dot: 'dotNotFound', lead: 'popNotFoundLead', closing: 'popNotFoundClosing' },
  ambiguous: { text: 'indicatorAmbiguous', dot: 'dotAmbiguous', lead: 'popAmbiguousLead', closing: 'popAmbiguousClosing' },
});

/** `names` joined by ", ", the first POPOVER_MAX_OUTPUTS of them, then "and {N} more" when there are more. */
export function listNames(names) {
  const shown = names.slice(0, POPOVER_MAX_OUTPUTS).join(', ');
  if (names.length <= POPOVER_MAX_OUTPUTS) return shown;
  return fill(MIDI_COPY.outputsMore, { outputs: shown, count: names.length - POPOVER_MAX_OUTPUTS });
}

/** The text of one port row: its state in plain words (the page shows the name in front of it). */
function rowStateText(port) {
  if (port.state === 'connected') {
    const output = port.matches[0];
    return typeof output === 'string' && output !== port.name ? fill(MIDI_COPY.rowConnectedAs, { output }) : MIDI_COPY.rowConnected;
  }
  if (port.state === 'unplugged') return MIDI_COPY.rowUnplugged;
  if (port.state === 'not-found') return MIDI_COPY.rowNotFound;
  return fill(MIDI_COPY.rowAmbiguous, { outputs: listNames(port.matches) });
}

/** The copy keys of an instrument that is not connected, by its state (the port keys with the id in the slot). */
const INSTRUMENT_PROBLEM_COPY = Object.freeze({
  unplugged: { text: 'indicatorInstrumentUnplugged', dot: 'dotUnplugged', lead: 'popRigUnpluggedLead', closing: 'popRigUnpluggedClosing' },
  'not-found': { text: 'indicatorInstrumentNotFound', dot: 'dotNotFound', lead: 'popRigNotFoundLead', closing: 'popRigNotFoundClosing' },
  ambiguous: { text: 'indicatorInstrumentAmbiguous', dot: 'dotAmbiguous', lead: 'popRigAmbiguousLead', closing: 'popRigAmbiguousClosing' },
});

/** A dot is a kind ('filled', 'hollow' or 'off') and a title: the view draws the kind, the title is its hover text. */
function dotOf(port) {
  const key = port.state === 'connected' ? 'dotConnected' : PORT_PROBLEM_COPY[port.state].dot;
  return { kind: port.state === 'connected' ? 'filled' : 'hollow', title: fill(MIDI_COPY[key], { port: port.name }) };
}

/** The crossed dot of an instrument the user switched off. */
function offDotOf(instrument) {
  return { kind: 'off', title: fill(MIDI_COPY.dotSwitchedOff, { port: instrument.id }) };
}

/** A visible model: `text` cuts the names in it, `title` keeps them whole. */
function shown({ key, values, cutKey, attention, dots, popover }) {
  const cutValues = { ...values };
  if (cutKey !== undefined) cutValues[cutKey] = cutText(values[cutKey], INDICATOR_NAME_LIMIT);
  return {
    visible: true,
    text: fill(MIDI_COPY[key], cutValues),
    title: fill(MIDI_COPY[key], values),
    attention,
    dots,
    popover,
  };
}

/** The "and {N} more" row that ends a list cut at its limit. */
function moreRow(count) {
  return { text: fill(MIDI_COPY.rowsMore, { count }) };
}

/** The copy keys of a rig flagged `buildMismatch` or `unreadable`, or null for a real invalid file. */
function flaggedRigKeys(rig) {
  if (rig.buildMismatch === true) {
    return { text: 'indicatorBuildMismatch', lead: 'popBuildMismatchLead', closing: 'popBuildMismatchClosing' };
  }
  if (rig.unreadable === true) {
    return { text: 'indicatorRigUnreadable', lead: 'popRigUnreadableLead', closing: 'popRigUnreadableClosing' };
  }
  return null;
}

/**
 * The model of an invalid setup file: its own attention text, no dots (no setup is in force), one
 * field-and-reason row per problem up to POPOVER_MAX_PROBLEMS, then the count of the rest (the problems
 * the page was not sent included). The text of the file is shown as written; the view uses textContent.
 * A rig flagged `buildMismatch` or `unreadable` gets its own text and no rows.
 */
function invalidModel(rig) {
  const flagged = flaggedRigKeys(rig);
  if (flagged !== null) {
    // The page could not read the setup, or knows the builds differ: no problem rows, the file is not blamed.
    return {
      visible: true,
      text: MIDI_COPY[flagged.text],
      title: MIDI_COPY[flagged.text],
      attention: true,
      dots: [],
      popover: { lead: MIDI_COPY[flagged.lead], rows: [], outputsLine: null, closing: MIDI_COPY[flagged.closing] },
    };
  }
  const rows = rig.problems.slice(0, POPOVER_MAX_PROBLEMS).map((problem) => ({ name: problem.field, stateText: problem.reason }));
  const rest = Math.max(0, rig.problems.length - POPOVER_MAX_PROBLEMS) + rig.more;
  if (rest > 0) rows.push(moreRow(rest));
  return {
    visible: true,
    text: MIDI_COPY.indicatorSetupInvalid,
    title: MIDI_COPY.indicatorSetupInvalid,
    attention: true,
    dots: [],
    popover: { lead: MIDI_COPY.popSetupInvalidLead, rows, outputsLine: null, closing: MIDI_COPY.popSetupInvalidClosing },
  };
}

/** The connection part of an instrument row, by the instrument's state; an unknown state throws. */
function instrumentConnectionText(instrument) {
  if (instrument.state === 'connected') return MIDI_COPY.rowConnected;
  if (instrument.state === 'unplugged') return MIDI_COPY.rowUnplugged;
  if (instrument.state === 'not-found') return MIDI_COPY.rowRigNotFound;
  if (instrument.state === 'ambiguous') return fill(MIDI_COPY.rowAmbiguous, { outputs: listNames(instrument.matches) });
  throw new Error(`Moontide: the state of instrument ${JSON.stringify(instrument.id)} must be connected, unplugged, not-found or ambiguous, got ${JSON.stringify(instrument.state)}.`);
}

/** The clock part of an instrument row: null for none; an unknown state throws, like an unknown connection state. */
function instrumentClockText(instrument) {
  const state = instrument.clock ?? 'none';
  if (!CLOCK_STATES.includes(state)) {
    throw new Error(`Moontide: the clock state of instrument ${JSON.stringify(instrument.id)} must be none, waiting or running, got ${JSON.stringify(state)}.`);
  }
  if (state === 'running') return MIDI_COPY.rowClockRunning;
  if (state === 'waiting') return MIDI_COPY.rowClockWaiting;
  return null;
}

/**
 * One instrument row: its id and port, then the connection, the clock, the last reset and the use, joined by ", ".
 * An instrument the user switched off has none of those parts, only "switched off".
 */
function instrumentRow(instrument) {
  if (instrument.enabled === false) return { name: instrument.id, port: instrument.port, stateText: MIDI_COPY.rowSwitchedOff };
  const parts = [instrumentConnectionText(instrument)];
  const clockText = instrumentClockText(instrument);
  if (clockText !== null) parts.push(clockText);
  if (typeof instrument.resetAt === 'number') parts.push(fill(MIDI_COPY.rowResetAt, { time: hhmm(new Date(instrument.resetAt)) }));
  if (!instrument.used) parts.push(MIDI_COPY.rowNotUsed);
  return { name: instrument.id, port: instrument.port, stateText: parts.join(MIDI_COPY.rowPartsJoin) };
}

/**
 * The model for a valid setup file: instrument ids replace port names, and the popover has one row for
 * every instrument of the file. Returns null (the plain port reading) when the code that plays does not
 * name only ports of the file, which can happen for code that started before the file arrived.
 */
function validModel(facts, rig) {
  const used = rig.instruments.filter((instrument) => instrument.used);
  // Instruments the user switched off are counted apart and never raise attention.
  const off = rig.instruments.filter((instrument) => instrument.enabled === false);
  const usedOn = used.filter((instrument) => instrument.enabled !== false);
  const named = facts.ports.every((port) => rig.instruments.some((instrument) => instrument.port === port.name));
  if (facts.ports.length === 0 || used.length === 0 || !named) return null;
  // Building the rows first checks every state: an unknown one throws before anything is shown.
  const allRows = rig.instruments.map(instrumentRow);
  const rows = allRows.slice(0, POPOVER_MAX_ROWS);
  if (allRows.length > POPOVER_MAX_ROWS) rows.push(moreRow(allRows.length - POPOVER_MAX_ROWS));
  const outputsLine = facts.outputs.length === 0 ? null : fill(MIDI_COPY.outputsLine, { outputs: listNames(facts.outputs) });
  const dots = [
    ...usedOn.map((instrument) => dotOf({ name: instrument.id, state: instrument.state })),
    ...off.map(offDotOf),
  ].slice(0, INDICATOR_MAX_DOTS);
  const problems = usedOn.filter((instrument) => instrument.state !== 'connected');
  // The muted clock line shows only while at least one instrument has a clock part in its row.
  const clockLine = rig.instruments.some((instrument) => instrumentClockText(instrument) !== null) ? { clockNote: MIDI_COPY.clockNote } : {};
  // The muted off note follows the clock note, only while at least one instrument is off.
  const offLine = off.length > 0 ? { offNote: MIDI_COPY.offNote } : {};
  if (problems.length === 0) {
    const popover = { lead: MIDI_COPY.popRigAllLead, rows, outputsLine, ...clockLine, ...offLine, closing: MIDI_COPY.popRigAllClosing };
    if (off.length > 0) {
      const n = rig.instruments.length - off.length;
      const k = off.length;
      let result;
      if (n >= 2) result = shown({ key: 'indicatorInstrumentsOnOff', values: { n, k }, attention: false, dots, popover });
      else if (n === 1) result = shown({ key: 'indicatorInstrumentOnOff', values: { k }, attention: false, dots, popover });
      else if (k === 1) result = shown({ key: 'indicatorInstrumentOff', values: { id: off[0].id }, cutKey: 'id', attention: false, dots, popover });
      else result = shown({ key: 'indicatorAllOff', values: { k }, attention: false, dots, popover });
      // The hover title adds who is off; the text cut an id, the title keeps it whole.
      return { ...result, title: fill(MIDI_COPY.titleOff, { text: result.title, ids: listNames(off.map((instrument) => instrument.id)) }) };
    }
    if (used.length === 1) {
      return shown({ key: 'indicatorInstrumentConnected', values: { id: used[0].id }, cutKey: 'id', attention: false, dots, popover });
    }
    return shown({ key: 'indicatorInstrumentsConnected', values: { n: used.length }, attention: false, dots, popover });
  }
  if (problems.length === 1) {
    const problem = problems[0];
    const keys = INSTRUMENT_PROBLEM_COPY[problem.state];
    const popover = { lead: fill(MIDI_COPY[keys.lead], { id: problem.id }), rows, outputsLine, ...clockLine, ...offLine, closing: MIDI_COPY[keys.closing] };
    return shown({ key: keys.text, values: { id: problem.id }, cutKey: 'id', attention: true, dots, popover });
  }
  const counts = { k: problems.length, n: usedOn.length };
  const popover = { lead: fill(MIDI_COPY.popRigSeveralLead, counts), rows, outputsLine, ...clockLine, ...offLine, closing: MIDI_COPY.popRigSeveralClosing };
  return shown({ key: 'indicatorInstrumentsAttention', values: counts, attention: true, dots, popover });
}

/**
 * What the top-bar MIDI indicator and its popover show, from the same facts the server words its notice
 * from (so the page and Claude never disagree): { visible, text, title, attention, dots, popover }.
 * `text` cuts port names at 24 characters; `title` keeps them whole. `connected` is whether the socket is
 * open, `superseded` whether this tab lost the active role; either one hides it. The access problems
 * (no Web MIDI, denied, waiting, could not start) show for the attempted code, even when that evaluation
 * failed; everything about ports describes the code that plays. An access value it does not know throws.
 */
export function indicatorModel({ facts, connected, superseded, rig = { setup: 'absent' } }) {
  if (!ACCESS_STATES.includes(facts.access)) {
    throw new Error(`Moontide: the MIDI access state must be one of ${ACCESS_STATES.join(', ')}, got ${JSON.stringify(facts.access)}.`);
  }
  if (!SETUP_CASES.includes(rig.setup)) {
    throw new Error(`Moontide: the MIDI setup case must be one of ${SETUP_CASES.join(', ')}, got ${JSON.stringify(rig.setup)}.`);
  }
  if (!connected || superseded) return HIDDEN_INDICATOR;
  const access = facts.access;
  if (access in ACCESS_COPY) {
    if (!facts.usesMidi && !facts.triedMidi) return HIDDEN_INDICATOR;
    const keys = ACCESS_COPY[access];
    const failed = access === 'failed';
    const lead =
      failed && typeof facts.failure === 'string' && facts.failure !== ''
        ? fill(MIDI_COPY.popFailedLead, { failure: facts.failure })
        : failed
          ? MIDI_COPY.popFailedLeadPlain
          : MIDI_COPY[keys.lead];
    return {
      visible: true,
      text: MIDI_COPY[keys.text],
      title: MIDI_COPY[keys.text],
      attention: true,
      dots: [],
      popover: { lead, rows: [], outputsLine: null, closing: MIDI_COPY[keys.closing] },
    };
  }
  // An invalid setup file shows for code that uses or tried MIDI, below the access problems and above any port state.
  if (rig.setup === 'invalid') {
    return facts.usesMidi || facts.triedMidi ? invalidModel(rig) : HIDDEN_INDICATOR;
  }
  if (access === 'idle' || !facts.usesMidi) return HIDDEN_INDICATOR;
  if (rig.setup === 'valid') {
    const instrumentModel = validModel(facts, rig);
    if (instrumentModel !== null) return instrumentModel;
  }

  const ports = facts.ports;
  const rows = ports.map((port) => ({ name: port.name, stateText: rowStateText(port) }));
  // Without a setup file a typo is not caught the way the file would catch it: say so, once port rows show.
  const note = rig.setup === 'absent' && ports.length > 0 ? { note: MIDI_COPY.noSetupNote } : {};
  const outputsLine =
    facts.outputs.length === 0 ? null : fill(MIDI_COPY.outputsLine, { outputs: listNames(facts.outputs) });
  const dots = ports.slice(0, INDICATOR_MAX_DOTS).map(dotOf);

  if (facts.outputs.length === 0) {
    return {
      visible: true,
      text: MIDI_COPY.indicatorNoOutputs,
      title: MIDI_COPY.indicatorNoOutputs,
      attention: true,
      dots: [],
      popover: { lead: MIDI_COPY.popNoOutputsLead, rows, outputsLine: null, ...note, closing: MIDI_COPY.popNoOutputsClosing },
    };
  }

  if (ports.length > 0) {
    const problems = ports.filter((port) => port.state !== 'connected');
    if (problems.length === 0) {
      const popover = { lead: MIDI_COPY.popAllLead, rows, outputsLine, ...note, closing: MIDI_COPY.popAllClosing };
      if (ports.length === 1) {
        return shown({ key: 'indicatorConnected', values: { port: ports[0].name }, cutKey: 'port', attention: false, dots, popover });
      }
      return shown({ key: 'indicatorManyConnected', values: { n: ports.length }, attention: false, dots, popover });
    }
    if (problems.length === 1) {
      const problem = problems[0];
      const keys = PORT_PROBLEM_COPY[problem.state];
      const popover = { lead: fill(MIDI_COPY[keys.lead], { port: problem.name }), rows, outputsLine, ...note, closing: MIDI_COPY[keys.closing] };
      return shown({ key: keys.text, values: { port: problem.name }, cutKey: 'port', attention: true, dots, popover });
    }
    const counts = { k: problems.length, n: ports.length };
    const popover = { lead: fill(MIDI_COPY.popSeveralLead, counts), rows, outputsLine, ...note, closing: MIDI_COPY.popSeveralClosing };
    return shown({ key: 'indicatorAttention', values: counts, attention: true, dots, popover });
  }

  if (facts.noPort !== null && typeof facts.noPort.using === 'string') {
    const output = facts.noPort.using;
    const popover = { lead: fill(MIDI_COPY.popNoPortLead, { output }), rows: [], outputsLine, closing: MIDI_COPY.popNoPortClosing };
    return shown({
      key: 'indicatorUsing',
      values: { output },
      cutKey: 'output',
      attention: false,
      dots: [{ kind: 'filled', title: fill(MIDI_COPY.dotConnected, { port: output }) }],
      popover,
    });
  }

  if (facts.unreadable) {
    return {
      visible: true,
      text: MIDI_COPY.indicatorUnchecked,
      title: MIDI_COPY.indicatorUnchecked,
      attention: false,
      dots: [],
      popover: { lead: MIDI_COPY.popUncheckedLead, rows: [], outputsLine, closing: MIDI_COPY.popUncheckedClosing },
    };
  }
  return HIDDEN_INDICATOR;
}

/** How long "Play in this tab" waits for the server's hello before it says so. */
export const TAKE_BACK_CONFIRM_MS = 5000;

/** What the tab title starts with while the page is hidden with MIDI playing. */
export const MIDI_TITLE_PREFIX = '\u26a0 MIDI \u00b7 ';

/** A hidden period shorter than this shows no banner on return, so a quick look at another tab stays quiet. */
export const MIDI_BANNER_MIN_HIDDEN_MS = 3000;

/** The banner fades by itself this long after it opened (paused while the pointer or focus is on it). */
export const MIDI_BANNER_FADE_MS = 20000;

/** With motion on, the banner fades out over this long before it is hidden. */
export const MIDI_BANNER_FADE_OUT_MS = 150;

/**
 * The tab title: the warning in front of the page's base title exactly while the page is hidden, the code
 * uses `.midi(`, sound is not stopped and this tab holds the role; otherwise the base title. The warning
 * comes first so it survives a tab title cut short by the browser. The title is never built from a MIDI
 * port name: the port inside the base title is the web server's port. A missing base title is a bug and throws.
 */
export function midiTitle({ hidden, usesMidi, playing, superseded, baseTitle }) {
  if (typeof baseTitle !== 'string' || baseTitle === '') {
    throw new TypeError('midiTitle needs the page base title, a non-empty string');
  }
  return hidden && usesMidi && playing && !superseded ? MIDI_TITLE_PREFIX + baseTitle : baseTitle;
}

/** Local 24-hour "HH:MM" from getHours and getMinutes: no locale formatting, so it reads the same on every machine. */
export function hhmm(date) {
  const two = (value) => String(value).padStart(2, '0');
  return `${two(date.getHours())}:${two(date.getMinutes())}`;
}

/** The return banner's text for two "HH:MM" strings. */
export function returnBannerText(from, to) {
  return fill(MIDI_COPY.bannerText, { from, to });
}

/**
 * One step of the hidden-period rule. `state` is { since }: when the hidden-with-MIDI condition began, or
 * null. `hiddenWithMidi` says whether the condition holds now, `hidden` whether the page is hidden, `now`
 * is a millisecond time. Returns { state, banner }: banner is { from, to } only when the condition ended
 * because the page came back (not hidden) after MIDI_BANNER_MIN_HIDDEN_MS or more; ending while the page
 * is still hidden (Stop, the code dropping MIDI, another tab taking over) forgets the start and shows nothing.
 */
export function hiddenTransition(state, { hiddenWithMidi, hidden, now }) {
  if (hiddenWithMidi) return { state: state.since === null ? { since: now } : state, banner: null };
  if (state.since === null) return { state, banner: null };
  const banner = !hidden && now - state.since >= MIDI_BANNER_MIN_HIDDEN_MS ? { from: state.since, to: now } : null;
  return { state: { since: null }, banner };
}

/**
 * The banner's fade-out clock, over an injected timer. start() runs `onExpire` once after
 * MIDI_BANNER_FADE_MS; pause(reason) stops it while a reason ('pointer', 'focus') is held; resume(reason)
 * restarts the full time once every reason is released; stop() cancels and forgets every reason.
 * start() begins again from a clean state.
 */
export function createBannerTimer({ setTimer, clearTimer, onExpire }) {
  let timer = null;
  let running = false;
  const held = new Set();

  function cancel() {
    if (timer === null) return;
    clearTimer(timer);
    timer = null;
  }

  function arm() {
    cancel();
    timer = setTimer(() => {
      timer = null;
      running = false;
      onExpire();
    }, MIDI_BANNER_FADE_MS);
  }

  return {
    start() {
      held.clear();
      running = true;
      arm();
    },
    stop() {
      held.clear();
      running = false;
      cancel();
    },
    pause(reason) {
      if (!running) return;
      held.add(reason);
      cancel();
    },
    resume(reason) {
      if (!running || !held.delete(reason) || held.size > 0) return;
      arm();
    },
  };
}
