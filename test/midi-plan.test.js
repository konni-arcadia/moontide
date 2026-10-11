import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'acorn';
import {
  MIDI_LIMITS,
  usesMidi,
  readMidiCalls,
  portState,
  indexState,
  defaultOutput,
  buildMidiFacts,
  panicMessages,
  STRUDEL_NO_DEVICES_TEXT,
  isStrudelNoDevicesError,
  MIDI_COPY,
  TAKE_BACK_CONFIRM_MS,
  panicTargetsFrom,
  panicOrder,
  indicatorModel,
  fill,
  INDICATOR_NAME_LIMIT,
  INDICATOR_MAX_DOTS,
  hhmm,
  midiTitle,
  returnBannerText,
  hiddenTransition,
  createBannerTimer,
  MIDI_TITLE_PREFIX,
  MIDI_BANNER_MIN_HIDDEN_MS,
  MIDI_BANNER_FADE_MS,
  MIDI_BANNER_FADE_OUT_MS,
} from '../page/midi-plan.js';
import {
  MAX_MIDI_NAME_LENGTH,
  MAX_MIDI_OUTPUTS,
  MAX_MIDI_PORTS,
  MAX_MIDI_FAILURE_LENGTH,
} from '../dist/protocol.js';

const ELLIPSIS = '…';

const read = (code) => {
  const result = readMidiCalls(code, { parse });
  assert.equal(result.ok, true, `expected ${code} to parse`);
  return result.calls;
};

const facts = (overrides = {}) =>
  buildMidiFacts({
    access: 'enabled',
    failure: null,
    triedCode: '',
    activeCode: '',
    outputs: [],
    seen: new Set(),
    hidden: false,
    playing: true,
    parse,
    ...overrides,
  });

test('usesMidi is true for a .midi( call wherever it sits in the code', () => {
  assert.equal(usesMidi(`note("c3").midi('A')`, { parse }), true);
  assert.equal(usesMidi(`stack(note("c3").midi('A'), s("bd"))`, { parse }), true);
  assert.equal(usesMidi(`const voice = () => note("c3").midi('A')\nvoice()`, { parse }), true);
  assert.equal(usesMidi(`note("c3")?.midi('A')`, { parse }), true);
  assert.equal(usesMidi(`lead: note("c3").midi()`, { parse }), true);
});

test('usesMidi is false when no .midi( call can run', () => {
  assert.equal(usesMidi(`s("bd")`, { parse }), false);
  assert.equal(usesMidi(`// note("c3").midi('A')\ns("bd")`, { parse }), false);
  assert.equal(usesMidi(`s("bd") // x.midi('A')`, { parse }), false);
  assert.equal(usesMidi(`const text = "x.midi('A')"\ns("bd")`, { parse }), false);
  assert.equal(usesMidi(`const m = note("c3").midi`, { parse }), false);
});

test('usesMidi is false for code that does not parse and for values that are not code', () => {
  assert.equal(usesMidi(`note("c3").midi('A'`, { parse }), false);
  assert.equal(usesMidi(undefined, { parse }), false);
  assert.equal(usesMidi(42, { parse }), false);
  assert.equal(usesMidi(null, { parse }), false);
});

test('readMidiCalls reads a single-quoted port as a name', () => {
  assert.deepEqual(
    read(`note("c3").midi('A')`).map(({ kind, name }) => ({ kind, name })),
    [{ kind: 'name', name: 'A' }],
  );
});

test('readMidiCalls cannot read a double-quoted or a backtick port (mini-notation)', () => {
  assert.deepEqual(read(`note("c3").midi("A")`).map((call) => call.kind), ['unreadable']);
  assert.deepEqual(read('note("c3").midi(`A`)').map((call) => call.kind), ['unreadable']);
  assert.deepEqual(read(`note("c3").midi(-1)`).map((call) => call.kind), ['unreadable']);
});

test('readMidiCalls reads a number as an index and no argument as the default port', () => {
  const [index] = read(`note("c3").midi(0)`);
  assert.equal(index.kind, 'index');
  assert.equal(index.index, 0);
  assert.deepEqual(read(`note("c3").midi()`).map((call) => call.kind), ['default']);
});

test('readMidiCalls reads the port of an options object', () => {
  const [named] = read(`note("c3").midi({ port: 'A', midichannel: 2 })`);
  assert.equal(named.kind, 'name');
  assert.equal(named.name, 'A');
  assert.deepEqual(read(`note("c3").midi({ midichannel: 2 })`).map((call) => call.kind), ['default']);
  assert.deepEqual(read(`note("c3").midi({ ...opts })`).map((call) => call.kind), ['unreadable']);
  assert.deepEqual(read(`note("c3").midi({ [key]: 'A' })`).map((call) => call.kind), ['unreadable']);
  assert.deepEqual(read(`note("c3").midi({ port: "A" })`).map((call) => call.kind), ['unreadable']);
});

test('readMidiCalls resolves a port held in a top-level const of a single-quoted string', () => {
  const [named] = read(`const P = 'A'\nnote("c3").midi(P)`);
  assert.equal(named.kind, 'name');
  assert.equal(named.name, 'A');
  assert.deepEqual(read(`let P = 'A'\nnote("c3").midi(P)`).map((call) => call.kind), ['unreadable']);
  assert.deepEqual(read(`const P = "A"\nnote("c3").midi(P)`).map((call) => call.kind), ['unreadable']);
  assert.deepEqual(read(`note("c3").midi(Q)`).map((call) => call.kind), ['unreadable']);
});

test('readMidiCalls cannot read a call whose options override the port', () => {
  assert.deepEqual(read(`note("c3").midi('A', { midiport: 'B' })`).map((call) => call.kind), ['unreadable']);
  assert.deepEqual(read(`note("c3").midi('A', { port: 'B' })`).map((call) => call.kind), ['unreadable']);
  const [named] = read(`note("c3").midi('A', { midichannel: 2 })`);
  assert.equal(named.kind, 'name');
});

test('readMidiCalls reads .midiport( and a bare midiport( as a port name', () => {
  const [method] = read(`note("c3").midiport('B')`);
  assert.equal(method.kind, 'name');
  assert.equal(method.name, 'B');
  const [bare] = read(`midiport('B')`);
  assert.equal(bare.kind, 'name');
  assert.equal(bare.name, 'B');
  assert.deepEqual(read(`note("c3").midiport("<A B>")`).map((call) => call.kind), ['unreadable']);
});

test('readMidiCalls lists the calls in the order their port text appears in the code', () => {
  const calls = read(`note("c3").midi('X').midiport('Y')`);
  assert.deepEqual(
    calls.map((call) => call.name),
    ['X', 'Y'],
  );
});

test('readMidiCalls reports code that does not parse', () => {
  const result = readMidiCalls(`note("c3").midi('A'`, { parse });
  assert.equal(result.ok, false);
  assert.ok(result.error instanceof Error);
});

test('portState follows Strudel: a case-sensitive substring, the first match wins', () => {
  assert.deepEqual(portState('Mt32EmuPort', ['Mt32EmuPort'], new Set()), {
    state: 'connected',
    matches: ['Mt32EmuPort'],
  });
  assert.deepEqual(portState('Mt32', ['Mt32EmuPort'], new Set()), { state: 'connected', matches: ['Mt32EmuPort'] });
  assert.deepEqual(portState('mt32emuport', ['Mt32EmuPort'], new Set()), { state: 'not-found', matches: [] });
});

test('portState calls a port that matches several outputs ambiguous and lists them in output order', () => {
  assert.deepEqual(portState('Synth', ['Fake Synth A', 'Fake Synth B'], new Set()), {
    state: 'ambiguous',
    matches: ['Fake Synth A', 'Fake Synth B'],
  });
  assert.equal(portState('', ['A', 'B'], new Set()).state, 'ambiguous');
});

test('portState tells a port seen earlier in the page session (unplugged) from one never seen (not found)', () => {
  assert.deepEqual(portState('Gone', [], new Set(['Gone Port'])), { state: 'unplugged', matches: [] });
  assert.deepEqual(portState('Gone', [], new Set()), { state: 'not-found', matches: [] });
});

test('indexState reads a number as an index into the outputs', () => {
  assert.deepEqual(indexState(1, ['A', 'B']), { state: 'connected', matches: ['B'] });
  assert.deepEqual(indexState(5, ['A', 'B']), { state: 'not-found', matches: [] });
});

test('defaultOutput is the first IAC output, else the first output, else none', () => {
  assert.equal(defaultOutput(['A', 'Fake IAC Bus 1', 'B']), 'Fake IAC Bus 1');
  assert.equal(defaultOutput(['A', 'B']), 'A');
  assert.equal(defaultOutput([]), null);
});

test('buildMidiFacts lists the named ports once each, in code order, with their state', () => {
  const code = `a: note("c3").midi('Fake Synth A')\nb: note("e3").midi('Nope')\nc: note("g3").midi('Fake Synth A')`;
  const result = facts({ activeCode: code, triedCode: code, outputs: ['Fake Synth A', 'Fake Synth B'] });
  assert.deepEqual(result.ports, [
    { name: 'Fake Synth A', state: 'connected', matches: ['Fake Synth A'] },
    { name: 'Nope', state: 'not-found', matches: [] },
  ]);
  assert.equal(result.usesMidi, true);
  assert.equal(result.noPort, null);
  assert.equal(result.unreadable, false);
  assert.deepEqual(result.outputs, ['Fake Synth A', 'Fake Synth B']);
});

test('buildMidiFacts lists the ports of the code in the order their port text appears', () => {
  const result = facts({
    activeCode: `note("c3").midi('B')\nnote("e3").midi('A')`,
    outputs: ['A', 'B'],
  });
  assert.deepEqual(
    result.ports.map((port) => port.name),
    ['B', 'A'],
  );
});

test('buildMidiFacts lists every output of an ambiguous port, in output order', () => {
  const result = facts({ activeCode: `note("c3").midi('Synth')`, outputs: ['Fake Synth B', 'Other', 'Fake Synth A'] });
  assert.deepEqual(result.ports, [{ name: 'Synth', state: 'ambiguous', matches: ['Fake Synth B', 'Fake Synth A'] }]);
});

test('buildMidiFacts matches case-sensitively and keeps the port name exactly as written', () => {
  const written = 'mt32emuport';
  const result = facts({ activeCode: `note("c3").midi('${written}')`, outputs: ['Mt32EmuPort'] });
  assert.deepEqual(result.ports, [{ name: written, state: 'not-found', matches: [] }]);
  const accented = 'Café · Port 2';
  const other = facts({ activeCode: `note("c3").midi('${accented}')`, outputs: [accented] });
  assert.equal(other.ports[0].name, accented);
});

test('buildMidiFacts names an index port by its number and a portless call by the output Strudel uses', () => {
  const indexed = facts({ activeCode: `note("c3").midi(1)`, outputs: ['A', 'B'] });
  assert.deepEqual(indexed.ports, [{ name: '1', state: 'connected', matches: ['B'] }]);
  const portless = facts({ activeCode: `note("c3").midi()`, outputs: ['A', 'Fake IAC Bus 1'] });
  assert.deepEqual(portless.noPort, { using: 'Fake IAC Bus 1' });
  assert.deepEqual(portless.ports, []);
  const empty = facts({ activeCode: `note("c3").midi()`, outputs: [] });
  assert.deepEqual(empty.noPort, { using: null });
});

test('buildMidiFacts marks a port it cannot read and adds no port fact for it', () => {
  const result = facts({ activeCode: `note("c3").midi("A")`, outputs: ['A'] });
  assert.equal(result.unreadable, true);
  assert.deepEqual(result.ports, []);
  assert.equal(result.noPort, null);
});

test('buildMidiFacts has no port facts while MIDI access is not enabled', () => {
  const code = `note("c3").midi('A')\nnote("e3").midi()\nnote("g3").midi("B")`;
  for (const access of ['idle', 'pending', 'denied', 'unsupported', 'failed']) {
    const result = facts({ access, activeCode: code, triedCode: code, outputs: ['A'] });
    assert.deepEqual(result.ports, [], access);
    assert.equal(result.noPort, null, access);
    assert.equal(result.usesMidi, true, access);
    assert.equal(result.unreadable, true, access);
  }
});

test('buildMidiFacts takes usesMidi from the playing code and triedMidi from the latest attempt', () => {
  const withMidi = `note("c3").midi('A')`;
  const without = `s("bd")`;
  assert.deepEqual(
    [facts({ activeCode: without, triedCode: withMidi }).usesMidi, facts({ activeCode: without, triedCode: withMidi }).triedMidi],
    [false, true],
  );
  assert.deepEqual(
    [facts({ activeCode: withMidi, triedCode: without }).usesMidi, facts({ activeCode: withMidi, triedCode: without }).triedMidi],
    [true, false],
  );
});

test('buildMidiFacts passes the failure name, hidden and playing through', () => {
  const result = facts({ access: 'failed', failure: 'AbortError', hidden: true, playing: false });
  assert.equal(result.access, 'failed');
  assert.equal(result.failure, 'AbortError');
  assert.equal(result.hidden, true);
  assert.equal(result.playing, false);
  assert.equal(facts().failure, null);
});

test('buildMidiFacts throws on an access state it does not know', () => {
  assert.throws(() => facts({ access: 'maybe' }), (error) => error instanceof Error && error.message.startsWith('Moontide:') && error.message.includes('maybe'));
});

test('buildMidiFacts keeps every fact inside the protocol limits', () => {
  const longName = 'x'.repeat(250);
  const long = facts({ activeCode: `note("c3").midi('${longName}')`, outputs: [longName] });
  assert.equal(long.ports[0].name.length, MIDI_LIMITS.name);
  assert.ok(long.ports[0].name.endsWith(ELLIPSIS));
  assert.equal(long.ports[0].matches[0].length, MIDI_LIMITS.name);
  assert.equal(long.outputs[0].length, MIDI_LIMITS.name);

  const manyOutputs = Array.from({ length: 70 }, (_, index) => `Out ${index}`);
  assert.equal(facts({ outputs: manyOutputs }).outputs.length, MIDI_LIMITS.outputs);
  const manyMatches = facts({ activeCode: `note("c3").midi('Out')`, outputs: manyOutputs });
  assert.equal(manyMatches.ports[0].matches.length, MIDI_LIMITS.outputs);

  const manyPorts = Array.from({ length: 40 }, (_, index) => `note("c3").midi('Port ${index}')`).join('\n');
  assert.equal(facts({ activeCode: manyPorts }).ports.length, MIDI_LIMITS.ports);

  const failure = facts({ access: 'failed', failure: 'y'.repeat(100) }).failure;
  assert.equal(failure.length, MIDI_LIMITS.failure);
  assert.ok(failure.endsWith(ELLIPSIS));
});

test('MIDI_LIMITS equals the limits of the midi-state message in src/protocol.ts', () => {
  assert.deepEqual(
    { ...MIDI_LIMITS },
    {
      name: MAX_MIDI_NAME_LENGTH,
      outputs: MAX_MIDI_OUTPUTS,
      ports: MAX_MIDI_PORTS,
      failure: MAX_MIDI_FAILURE_LENGTH,
    },
  );
});

test('panicMessages is 32 messages: sustain release then All Notes Off for channels 1 to 16', () => {
  const messages = panicMessages();
  assert.equal(messages.length, 32);
  assert.deepEqual(messages[0], [0xb0, 64, 0]);
  assert.deepEqual(messages[1], [0xb0, 123, 0]);
  assert.deepEqual(messages[30], [0xbf, 64, 0]);
  assert.deepEqual(messages[31], [0xbf, 123, 0]);
  for (let channel = 0; channel < 16; channel++) {
    assert.deepEqual(messages[channel * 2], [0xb0 | channel, 64, 0]);
    assert.deepEqual(messages[channel * 2 + 1], [0xb0 | channel, 123, 0]);
  }
  assert.notEqual(panicMessages(), messages, 'each call returns a new array');
});

test('panicTargetsFrom lists names in call order; a port that cannot be pinned to a name means every output', () => {
  const targets = (code) => panicTargetsFrom(read(code));
  assert.deepEqual(targets(`note("c3").midi('B'); note("c3").midi('A'); note("c3").midi('B')`), { names: ['B', 'A'], all: false });
  // Strudel resolves an index and a missing port at every note, so they are never pinned to a name.
  assert.deepEqual(targets(`note("c3").midi()`), { names: [], all: true });
  assert.deepEqual(targets(`note("c3").midi(1)`), { names: [], all: true });
  assert.deepEqual(targets(`note("c3").midi(5)`), { names: [], all: true });
  assert.deepEqual(targets(`note("c3").midi(someVariable)`), { names: [], all: true });
  assert.deepEqual(targets(`note("c3").midi('B'); note("c3").midi()`), { names: ['B'], all: true });
});

test('panicOrder follows the names in order, each native once, connected only', () => {
  const natives = [
    { id: '1', name: 'A', state: 'connected' },
    { id: '2', name: 'B', state: 'connected' },
    { id: '3', name: 'C', state: 'connected' },
  ];
  assert.deepEqual(panicOrder(['B', 'A'], false, natives).map((n) => n.name), ['B', 'A']);
  assert.deepEqual(panicOrder([], false, natives), []);
  const twins = [
    { id: '1', name: 'Synth 1', state: 'connected' },
    { id: '2', name: 'Synth 2', state: 'connected' },
    { id: '3', name: 'Other', state: 'connected' },
  ];
  assert.deepEqual(panicOrder(['Synth'], false, twins).map((n) => n.id), ['1', '2']);
  assert.deepEqual(panicOrder(['Synth 2', 'Synth'], false, twins).map((n) => n.id), ['2', '1']);
  const withDead = [
    { id: '1', name: 'A', state: 'disconnected' },
    { id: '2', name: 'B', state: 'connected' },
  ];
  assert.deepEqual(panicOrder(['A', 'B'], false, withDead).map((n) => n.id), ['2']);
  assert.deepEqual(panicOrder(['C'], true, natives).map((n) => n.name), ['C', 'A', 'B']);
  assert.deepEqual(panicOrder(['B'], true, natives).map((n) => n.name), ['B', 'A', 'C']);
});

test('the per-cycle "no MIDI devices" line of Strudel is recognised, anything else is not', () => {
  assert.equal(STRUDEL_NO_DEVICES_TEXT, 'No MIDI devices found');
  assert.equal(isStrudelNoDevicesError('🔌 No MIDI devices found. Connect a device or enable IAC Driver.'), true);
  assert.equal(isStrudelNoDevicesError('Failed to fetch'), false);
  assert.equal(isStrudelNoDevicesError(null), false);
  assert.equal(isStrudelNoDevicesError(undefined), false);
});

test('the superseded-tab copy is the pinned wording and the take-back waits 5 s', () => {
  assert.equal(MIDI_COPY.refusedSuperseded, 'Moontide is playing in another tab, so this tab does not play.');
  assert.equal(MIDI_COPY.takeoverText, 'Moontide is playing in another tab');
  assert.equal(MIDI_COPY.takeBack, 'Play in this tab');
  assert.equal(MIDI_COPY.takingOver, 'Taking over…');
  assert.equal(MIDI_COPY.takeBackFailed, 'Moontide did not confirm — try again.');
  assert.equal(MIDI_COPY.noActiveText, 'No tab is playing');
  assert.equal(MIDI_COPY.refusedNoActive, 'No tab is playing, so this tab does not play until you choose Play in this tab.');
  assert.equal(TAKE_BACK_CONFIRM_MS, 5000);
});

// The copy keys of the instruments, written out exactly.
const RIG_COPY_PINNED = {
  indicatorSetupInvalid: 'MIDI: instruments.json is invalid',
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
  indicatorRigUnreadable: 'MIDI: setup not readable, restart the server',
  popRigUnreadableLead: 'The page could not read the MIDI setup the server sent, so no instruments are set up.',
  popRigUnreadableClosing: 'The server may come from an older build: restart Claude (the server), then reload this page.',
  indicatorBuildMismatch: 'MIDI: different builds, restart the server',
  popBuildMismatchLead: 'The server and the page come from different builds, so no instruments are set up.',
  popBuildMismatchClosing: 'Restart Claude (the server), then reload this page.',
  rowRigNotFound: 'not found, check the name in instruments.json',
  rowResetAt: 'reset at {time}',
  rowNotUsed: 'not used by the code',
  rowSwitchedOff: 'switched off',
  dotSwitchedOff: '{port}: switched off',
  rowClockRunning: 'clock running',
  rowClockWaiting: 'clock starts on next cycle',
  rowPartsJoin: ', ',
  rowsMore: 'and {count} more',
  noSetupNote: 'No instruments.json found, so port and sound names are not checked.',
  clockNote: 'Moontide sends the MIDI clock, Start and Stop to the instruments marked clock.',
  indicatorInstrumentsOnOff: 'MIDI: {n} instruments on, {k} off',
  indicatorInstrumentOnOff: 'MIDI: 1 instrument on, {k} off',
  indicatorInstrumentOff: 'MIDI: {id} off',
  indicatorAllOff: 'MIDI: all {k} instruments off',
  titleOff: '{text}. Off: {ids}.',
  offNote: 'Instruments switched off stay silent. Switch them on in the Instruments view (key 6).',
};

test('MIDI_COPY is the full frozen copy table, takeover strings and every indicator and popover string', () => {
  assert.deepEqual(MIDI_COPY, {
    refusedSuperseded: 'Moontide is playing in another tab, so this tab does not play.',
    takeoverText: 'Moontide is playing in another tab',
    noActiveText: 'No tab is playing',
    refusedNoActive: 'No tab is playing, so this tab does not play until you choose Play in this tab.',
    takeBack: 'Play in this tab',
    takingOver: 'Taking over…',
    takeBackFailed: 'Moontide did not confirm — try again.',
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
    bannerText: 'MIDI timing may have broken while this tab was hidden (from {from} to {to}).',
    bannerDismiss: 'Dismiss',
    ...RIG_COPY_PINNED,
  });
  assert.equal(Object.isFrozen(MIDI_COPY), true);
});

test('fill puts values into {placeholders} and throws for a missing one instead of writing a blank', () => {
  assert.equal(fill('MIDI: {port} connected', { port: 'A' }), 'MIDI: A connected');
  assert.equal(fill('{k} of {n}', { k: 1, n: 3 }), '1 of 3');
  assert.throws(() => fill('MIDI: {port} connected', {}), /^Error: Moontide:/);
});

// The facts object of the page, written out: indicatorModel reads only these fields.
const indicatorFacts = (overrides = {}) => ({
  access: 'enabled',
  failure: null,
  usesMidi: true,
  triedMidi: true,
  outputs: ['Synth A', 'Synth B'],
  ports: [],
  noPort: null,
  unreadable: false,
  hidden: false,
  playing: true,
  ...overrides,
});
const port = (name, state = 'connected', matches = state === 'connected' ? [name] : []) => ({ name, state, matches });
const model = (overrides = {}, flags = {}) => indicatorModel({ facts: indicatorFacts(overrides), connected: true, superseded: false, ...flags });

test('indicatorModel is hidden when the socket is closed, when the tab is superseded, and for code without MIDI', () => {
  const ports = [port('Synth A')];
  assert.equal(model({ ports }).visible, true);
  assert.equal(model({ ports }, { connected: false }).visible, false);
  assert.equal(model({ ports }, { superseded: true }).visible, false);
  assert.equal(model({ ports, usesMidi: false, triedMidi: false }).visible, false);
  assert.equal(model({ ports, usesMidi: false, triedMidi: true }).visible, false, 'the ports describe the code that plays');
});

test('indicatorModel shows the four access problems for the attempted code even when that evaluation failed', () => {
  for (const access of ['pending', 'denied', 'unsupported', 'failed']) {
    assert.equal(model({ access, usesMidi: false, triedMidi: true }).visible, true, access);
    assert.equal(model({ access, usesMidi: false, triedMidi: false }).visible, false, access);
    assert.equal(model({ access, usesMidi: true, triedMidi: false }).visible, true, access);
  }
  assert.equal(model({ access: 'enabled', usesMidi: false, triedMidi: true }).visible, false);
});

test('indicatorModel hides for idle access even when the code uses MIDI', () => {
  assert.equal(model({ access: 'idle', usesMidi: true, triedMidi: true }).visible, false);
});

test('indicatorModel words the four access states, worst first, each needing attention and with no dots', () => {
  const cases = [
    ['unsupported', 'MIDI: no Web MIDI, use Chrome or Edge'],
    ['denied', 'MIDI: permission denied'],
    ['pending', 'MIDI: waiting for permission'],
    ['failed', 'MIDI: could not start'],
  ];
  for (const [access, text] of cases) {
    const result = model({ access, ports: [port('Synth A')] });
    assert.equal(result.text, text, access);
    assert.equal(result.title, text, access);
    assert.equal(result.attention, true, access);
    assert.deepEqual(result.dots, [], access);
  }
});

test('indicatorModel says no outputs are connected when there are none, with no dots', () => {
  const result = model({ outputs: [], ports: [port('Synth A', 'not-found')] });
  assert.equal(result.text, 'MIDI: no outputs connected');
  assert.equal(result.attention, true);
  assert.deepEqual(result.dots, []);
});

test('indicatorModel names the one port that is unplugged, not found or ambiguous', () => {
  const unplugged = model({ ports: [port('Synth A', 'unplugged')] });
  assert.equal(unplugged.text, 'MIDI: Synth A unplugged');
  assert.equal(unplugged.attention, true);
  assert.equal(model({ ports: [port('Nope', 'not-found')] }).text, 'MIDI: Nope not found');
  assert.equal(model({ ports: [port('Synth', 'ambiguous', ['Synth A', 'Synth B'])] }).text, 'MIDI: Synth matches several outputs');
  assert.equal(model({ ports: [port('Synth A'), port('Synth B', 'unplugged')] }).text, 'MIDI: Synth B unplugged', 'one of two names the missing one');
});

test('indicatorModel counts the problems when two or more ports need attention', () => {
  const result = model({ ports: [port('A', 'unplugged'), port('B', 'not-found'), port('C')] });
  assert.equal(result.text, 'MIDI: 2 of 3 ports need attention');
  assert.equal(result.attention, true);
});

test('indicatorModel: no port named and an output exists reads "using", quiet, with one filled dot', () => {
  const result = model({ outputs: ['Fake Synth A', 'Fake IAC Bus 1'], noPort: { using: 'Fake IAC Bus 1' } });
  assert.equal(result.text, 'MIDI: using Fake IAC Bus 1');
  assert.equal(result.attention, false);
  assert.deepEqual(result.dots, [{ kind: 'filled', title: 'Fake IAC Bus 1: connected' }]);
});

test('indicatorModel: every named port connected is quiet, one port by name and several by count', () => {
  const one = model({ ports: [port('Synth A')] });
  assert.equal(one.text, 'MIDI: Synth A connected');
  assert.equal(one.attention, false);
  assert.deepEqual(one.dots, [{ kind: 'filled', title: 'Synth A: connected' }]);
  const three = model({ outputs: ['a', 'b', 'c'], ports: [port('a'), port('b'), port('c')] });
  assert.equal(three.text, 'MIDI: 3 ports connected');
  assert.equal(three.attention, false);
  assert.equal(three.dots.length, 3);
});

test('indicatorModel: only an unreadable port reads "port not checked", quiet, with no dots', () => {
  const result = model({ unreadable: true });
  assert.equal(result.text, 'MIDI: port not checked');
  assert.equal(result.attention, false);
  assert.deepEqual(result.dots, []);
});

test('indicatorModel draws a filled dot for a connected port and a hollow one for each kind of missing port, with titles', () => {
  const result = model({
    outputs: ['x'],
    ports: [port('A'), port('B', 'unplugged'), port('C', 'not-found'), port('D', 'ambiguous', ['D1', 'D2'])],
  });
  assert.deepEqual(result.dots, [
    { kind: 'filled', title: 'A: connected' },
    { kind: 'hollow', title: 'B: unplugged' },
    { kind: 'hollow', title: 'C: not found' },
    { kind: 'hollow', title: 'D: matches several outputs' },
  ]);
});

test('indicatorModel cuts a long port name to 24 characters in the text and keeps it whole in the title', () => {
  const name = 'A very long instrument name!!'; // 29 characters
  assert.equal(name.length, 29);
  const result = model({ ports: [port(name)] });
  const cut = `${name.slice(0, INDICATOR_NAME_LIMIT - 1)}…`;
  assert.equal(cut.length, 24);
  assert.equal(result.text, `MIDI: ${cut} connected`);
  assert.equal(result.title, `MIDI: ${name} connected`);
  assert.equal(model({ ports: [port(name, 'unplugged')] }).text, `MIDI: ${cut} unplugged`);
});

test('indicatorModel draws at most 6 dots', () => {
  assert.equal(INDICATOR_MAX_DOTS, 6);
  const ports = Array.from({ length: 8 }, (_, index) => port(`P${index}`));
  const result = model({ outputs: ports.map((p) => p.name), ports });
  assert.equal(result.dots.length, 6);
  assert.equal(result.text, 'MIDI: 8 ports connected');
});

test('indicatorModel throws for an access state it does not know', () => {
  assert.throws(() => model({ access: 'maybe' }), /^Error: Moontide:/);
  assert.throws(() => model({ access: undefined }), /^Error: Moontide:/);
});

test('indicatorModel reads the facts buildMidiFacts makes from real code', () => {
  const fromCode = (code, outputs, seen = new Set(outputs)) =>
    indicatorModel({
      facts: facts({ triedCode: code, activeCode: code, outputs, seen }),
      connected: true,
      superseded: false,
    });
  assert.equal(fromCode(`note("c3").midi('Synth A')`, ['Synth A', 'Synth B']).text, 'MIDI: Synth A connected');
  assert.equal(fromCode(`note("c3").midi('Synth A')`, ['Synth B'], new Set(['Synth A', 'Synth B'])).text, 'MIDI: Synth A unplugged');
  assert.equal(fromCode(`note("c3").midi('Nope')`, ['Synth B']).text, 'MIDI: Nope not found');
  assert.equal(fromCode(`note("c3").midi()`, ['Synth B']).text, 'MIDI: using Synth B');
  assert.equal(fromCode(`s("bd")`, ['Synth B']).visible, false);
});

const popoverOf = (overrides, flags) => model(overrides, flags).popover;

test('the popover has no content when the indicator is hidden', () => {
  assert.equal(model({ usesMidi: false, triedMidi: false }).popover, null);
  assert.equal(model({ ports: [port('A')] }, { connected: false }).popover, null);
});

test('popover, all ports connected: the quiet lead, one row per port, the outputs line and the closing', () => {
  const popover = popoverOf({ ports: [port('Synth A')] });
  assert.equal(popover.lead, 'Moontide is sending to the MIDI ports named in the code.');
  assert.deepEqual(popover.rows, [{ name: 'Synth A', stateText: 'connected' }]);
  assert.equal(popover.outputsLine, 'Connected outputs: Synth A, Synth B.');
  assert.equal(popover.closing, 'If a port is unplugged, playing resumes by itself when it is back.');
});

test('popover, unplugged: its lead names the full port and the closing says it resumes by itself', () => {
  const popover = popoverOf({ outputs: ['Synth B'], ports: [port('Synth A', 'unplugged')] });
  assert.equal(popover.lead, 'Synth A is unplugged.');
  assert.deepEqual(popover.rows, [{ name: 'Synth A', stateText: 'unplugged' }]);
  assert.equal(popover.closing, 'Plug it back in. Playing resumes by itself, without a new evaluation. Claude has been told.');
});

test('popover, not found: the lead, the row and the closing pointing at the connected outputs', () => {
  const popover = popoverOf({ ports: [port('Nope', 'not-found')] });
  assert.equal(popover.lead, 'Nope was not found. No output has this name.');
  assert.deepEqual(popover.rows, [{ name: 'Nope', stateText: 'not found, check the name' }]);
  assert.equal(popover.outputsLine, 'Connected outputs: Synth A, Synth B.');
  assert.equal(popover.closing, 'Ask Claude to use one of the connected outputs below. Claude has been told. Other tracks keep playing.');
});

test('popover, ambiguous: the row lists the matching outputs and the closing asks for the full name', () => {
  const popover = popoverOf({ ports: [port('Synth', 'ambiguous', ['Synth A', 'Synth B'])] });
  assert.equal(popover.lead, 'Synth matches several outputs.');
  assert.deepEqual(popover.rows, [{ name: 'Synth', stateText: 'matches several outputs: Synth A, Synth B' }]);
  assert.equal(popover.closing, 'Ask Claude to use the full name of one of them. Claude has been told.');
});

test('popover, several problems: a count lead and one row each', () => {
  const popover = popoverOf({ ports: [port('A', 'unplugged'), port('B', 'not-found'), port('Synth A')] });
  assert.equal(popover.lead, '2 of the 3 ports named in the code need attention.');
  assert.equal(popover.rows.length, 3);
  assert.equal(popover.closing, 'Claude has been told. Other tracks keep playing.');
});

test('popover rows say "connected as" when the match differs from the name', () => {
  const popover = popoverOf({ ports: [port('Synth A', 'connected', ['Synth A Extra']), port('1', 'connected', ['Synth B'])] });
  assert.deepEqual(popover.rows, [
    { name: 'Synth A', stateText: 'connected as Synth A Extra' },
    { name: '1', stateText: 'connected as Synth B' },
  ]);
});

test('popover, no port named: the output in use and the closing asking to name the port', () => {
  const popover = popoverOf({ noPort: { using: 'Synth A' } });
  assert.equal(popover.lead, 'The code names no MIDI port, so this output is used: Synth A.');
  assert.deepEqual(popover.rows, []);
  assert.equal(popover.closing, 'Ask Claude to name the port you want.');
});

test('popover, no outputs: its own sentence, no outputs line, rows for the ports the code names', () => {
  const popover = popoverOf({ outputs: [], ports: [port('Synth A', 'not-found')] });
  assert.equal(popover.lead, 'No MIDI outputs are connected.');
  assert.deepEqual(popover.rows, [{ name: 'Synth A', stateText: 'not found, check the name' }]);
  assert.equal(popover.outputsLine, null);
  assert.equal(popover.closing, 'Connect an instrument, or start a software one, then it is found by itself. Claude has been told. Other tracks keep playing.');
});

test('popover, waiting for permission, denied and no Web MIDI: what is happening and what to do', () => {
  assert.equal(popoverOf({ access: 'pending' }).lead, 'Your browser is asking for MIDI access. Allow it to hear MIDI instruments.');
  assert.match(popoverOf({ access: 'pending' }).closing, /^Moontide asks once, and only for code that uses MIDI\./);
  const denied = popoverOf({ access: 'denied' });
  assert.equal(denied.lead, 'MIDI access is blocked for this page, so MIDI tracks are silent.');
  assert.match(denied.closing, /^To allow it again: click the padlock left of the address bar, open Site settings, set MIDI devices to Allow, then reload this page\./);
  const unsupported = popoverOf({ access: 'unsupported' });
  assert.equal(unsupported.lead, 'This browser has no Web MIDI, so MIDI instruments cannot play here.');
  assert.equal(unsupported.closing, 'Use Chrome or Edge. Claude has been told. Other tracks keep playing.');
  for (const access of ['pending', 'denied', 'unsupported']) {
    assert.deepEqual(popoverOf({ access }).rows, [], access);
    assert.equal(popoverOf({ access }).outputsLine, null, access);
  }
});

test('popover, could not start: the error name when there is one, and to reload the page', () => {
  assert.equal(popoverOf({ access: 'failed', failure: 'InvalidStateError' }).lead, 'Web MIDI could not start in this page (InvalidStateError), so MIDI tracks are silent.');
  assert.equal(popoverOf({ access: 'failed', failure: null }).lead, 'Web MIDI could not start in this page, so MIDI tracks are silent.');
  assert.equal(popoverOf({ access: 'failed' }).closing, 'Reload the page to try again. Claude has been told. Other tracks keep playing.');
});

test('popover, a port the page cannot read: says so and that Stop silences every output', () => {
  const popover = popoverOf({ unreadable: true });
  assert.equal(popover.lead, 'A port in the code is not a plain single-quoted name, so the page cannot check it.');
  assert.equal(popover.closing, 'Stop silences every connected output. Claude has been told.');
});

test('popover outputs line lists up to 6 outputs and ends with "and {N} more" after that', () => {
  const few = popoverOf({ outputs: ['a', 'b'], ports: [port('a')] });
  assert.equal(few.outputsLine, 'Connected outputs: a, b.');
  const outputs = ['o1', 'o2', 'o3', 'o4', 'o5', 'o6', 'o7', 'o8', 'o9'];
  const many = popoverOf({ outputs, ports: [port('o1')] });
  assert.equal(many.outputsLine, 'Connected outputs: o1, o2, o3, o4, o5, o6 and 3 more.');
  const six = popoverOf({ outputs: outputs.slice(0, 6), ports: [port('o1')] });
  assert.equal(six.outputsLine, 'Connected outputs: o1, o2, o3, o4, o5, o6.');
});

// ---- The indicator and the popover read the rig ----

const MORNING = new Date(2026, 0, 1, 14, 5).getTime();
const LATER = new Date(2026, 0, 1, 14, 7).getTime();
const instrument = (id, portName, overrides = {}) => ({ id, port: portName, state: 'connected', matches: [portName], resetAt: null, used: true, ...overrides });
const validRig = (...instruments) => ({ setup: 'valid', instruments });
// The facts name the ports of the instruments the code uses, as the page's facts would.
const rigModel = (rig, overrides = {}, flags = {}) =>
  indicatorModel({
    facts: indicatorFacts({
      ports: rig.setup === 'valid' ? rig.instruments.filter((i) => i.used).map((i) => port(i.port, i.state, i.matches)) : [],
      ...overrides,
    }),
    rig,
    connected: true,
    superseded: false,
    ...flags,
  });

test('every placeholder of every new MIDI_COPY key is filled by the model, and fill throws when one is missing', () => {
  for (const [key, template] of Object.entries(RIG_COPY_PINNED)) {
    const names = Array.from(template.matchAll(/\{(\w+)\}/g), (match) => match[1]);
    if (names.length === 0) continue;
    assert.throws(() => fill(MIDI_COPY[key], {}), /^Error: Moontide:/, key);
    assert.doesNotThrow(() => fill(MIDI_COPY[key], Object.fromEntries(names.map((name) => [name, 'x']))), key);
  }
});

test('no setup file: a popover with port rows carries the muted note, and the model is otherwise the same as the plain port model', () => {
  const plain = model({ ports: [port('Synth A')] });
  assert.equal(plain.popover.note, 'No instruments.json found, so port and sound names are not checked.');
  assert.deepEqual(plain, rigModel({ setup: 'absent' }, { ports: [port('Synth A')] }));
  assert.equal(plain.text, 'MIDI: Synth A connected');
  // The no-outputs case still has port rows, so it carries the note too.
  assert.equal(model({ outputs: [], ports: [port('Synth A', 'not-found')] }).popover.note, MIDI_COPY.noSetupNote);
  // No note: no port named, a port the page cannot read, an access problem.
  assert.equal('note' in model({ noPort: { using: 'Synth A' } }).popover, false);
  assert.equal('note' in model({ unreadable: true }).popover, false);
  assert.equal('note' in model({ access: 'denied', ports: [port('A')] }).popover, false);
});

test('a valid or an invalid setup file never carries the no-setup note', () => {
  assert.equal('note' in rigModel(validRig(instrument('mt32', 'Fake Synth A'))).popover, false);
  assert.equal('note' in rigModel({ setup: 'invalid', problems: [{ field: 'instruments', reason: 'required' }], more: 0 }).popover, false);
});

// ---- The clock part of an instrument row and the clock line ----

const CLOCK_NOTE_TEXT = 'Moontide sends the MIDI clock, Start and Stop to the instruments marked clock.';
const rowTextOf = (rig, id) => rigModel(rig).popover.rows.find((row) => row.name === id).stateText;

test('the clock part reads clock running or clock starts on next cycle, between the connection and the reset, and nothing for none', () => {
  const rig = (clock, rest = {}) => validRig(instrument('seq', 'Port A', { clock, ...rest }));
  assert.equal(rowTextOf(rig('running'), 'seq'), 'connected, clock running');
  assert.equal(rowTextOf(rig('waiting'), 'seq'), 'connected, clock starts on next cycle');
  assert.equal(rowTextOf(rig('running', { resetAt: MORNING }), 'seq'), 'connected, clock running, reset at 14:05');
  assert.equal(rowTextOf(rig('waiting', { resetAt: MORNING }), 'seq'), 'connected, clock starts on next cycle, reset at 14:05');
  // Clock none and a missing clock field read exactly as an instrument without clock info.
  assert.equal(rowTextOf(rig('none', { resetAt: MORNING }), 'seq'), 'connected, reset at 14:05');
  assert.equal(rowTextOf(rig(undefined), 'seq'), 'connected');
  assert.equal(rowTextOf(validRig(instrument('seq', 'Port A'), instrument('arp', 'Port B')), 'arp'), 'connected');
});

test('an instrument with clock none shows no clock part when unplugged, not found, ambiguous or not used by the code', () => {
  const rig = validRig(
    instrument('ok', 'Port A', { clock: 'running' }),
    instrument('gone', 'Port B', { state: 'unplugged', matches: [], clock: 'none' }),
    instrument('lost', 'Port C', { state: 'not-found', matches: [], clock: 'none' }),
    instrument('twin', 'Port D', { state: 'ambiguous', matches: ['Port D 1', 'Port D 2'], clock: 'none' }),
    instrument('idle', 'Port E', { used: false, clock: 'none' }),
  );
  const rows = Object.fromEntries(rigModel(rig).popover.rows.map((row) => [row.name, row.stateText]));
  assert.equal(rows.ok, 'connected, clock running');
  assert.equal(rows.gone, 'unplugged');
  assert.equal(rows.lost, 'not found, check the name in instruments.json');
  assert.equal(rows.twin, 'matches several outputs: Port D 1, Port D 2');
  assert.equal(rows.idle, 'connected, not used by the code');
  for (const [id, text] of Object.entries(rows)) if (id !== 'ok') assert.equal(text.includes('clock'), false, id);
});

test('two instruments on one port read independently: the phrase shows on the clock instrument only', () => {
  const rig = validRig(instrument('seq', 'Port A', { clock: 'running' }), instrument('pad', 'Port A', { clock: 'none' }));
  const rows = rigModel(rig).popover.rows;
  assert.equal(rows[0].stateText, 'connected, clock running');
  assert.equal(rows[1].stateText, 'connected');
});

test('an unknown clock state throws in the pure model, naming the instrument and the value', () => {
  assert.throws(() => rigModel(validRig(instrument('seq', 'Port A', { clock: 'ticking' }))), (err) => err instanceof Error && err.message === 'Moontide: the clock state of instrument "seq" must be none, waiting or running, got "ticking".');
  assert.throws(() => rigModel(validRig(instrument('seq', 'Port A', { clock: true }))), /must be none, waiting or running, got true/);
  // A missing or null field reads none (the page always sends one; an older caller may not).
  assert.equal(rowTextOf(validRig(instrument('seq', 'Port A', { clock: null })), 'seq'), 'connected');
});

test('the clock line is one midi-outputs paragraph text in each valid popover while a clock waits or runs, and never otherwise', () => {
  const clockOn = (state) => instrument('seq', 'Port A', { clock: state });
  // All connected, one problem, several problems.
  const all = rigModel(validRig(clockOn('running'), instrument('arp', 'Port B'))).popover;
  const one = rigModel(validRig(clockOn('waiting'), instrument('arp', 'Port B', { state: 'unplugged', matches: [] }))).popover;
  const several = rigModel(
    validRig(clockOn('running'), instrument('arp', 'Port B', { state: 'unplugged', matches: [] }), instrument('pad', 'Port C', { state: 'not-found', matches: [] })),
  ).popover;
  for (const popover of [all, one, several]) {
    assert.equal(popover.clockNote, CLOCK_NOTE_TEXT);
    assert.equal(MIDI_COPY.clockNote, CLOCK_NOTE_TEXT);
    assert.equal(Object.keys(popover).filter((key) => key.toLowerCase().includes('clock')).length, 1, 'one clock line, no count');
    assert.equal(/\d/.test(popover.clockNote), false, 'no count or id in the line');
  }
  // Every state none, no clock field at all, an absent file and an invalid file: no clock line, no key.
  assert.equal('clockNote' in rigModel(validRig(clockOn('none'), instrument('arp', 'Port B'))).popover, false);
  assert.equal('clockNote' in rigModel(validRig(instrument('seq', 'Port A'), instrument('arp', 'Port B'))).popover, false);
  assert.equal('clockNote' in rigModel({ setup: 'absent' }, { ports: [port('Synth A')] }).popover, false);
  assert.equal('clockNote' in rigModel({ setup: 'invalid', problems: [{ field: 'instruments', reason: 'required' }], more: 0 }).popover, false);
});

test('with zero clock instruments the popover is the same as for a rig without clock fields, key for key', () => {
  const plain = validRig(instrument('mt32', 'Port A', { resetAt: MORNING }), instrument('sc55', 'Port B', { used: false }));
  const none = validRig(instrument('mt32', 'Port A', { resetAt: MORNING, clock: 'none' }), instrument('sc55', 'Port B', { used: false, clock: 'none' }));
  assert.deepEqual(rigModel(none), rigModel(plain));
  assert.deepEqual(Object.keys(rigModel(plain).popover).sort(), ['closing', 'lead', 'outputsLine', 'rows']);
});

test('past 12 instruments the "and N more" row ends the list and one clock line shows in total', () => {
  const many = Array.from({ length: 13 }, (_, index) => instrument(`inst${index}`, `Port ${index}`, { clock: 'running' }));
  const popover = rigModel(validRig(...many)).popover;
  assert.equal(popover.rows.length, 13);
  assert.deepEqual(popover.rows.at(-1), { text: 'and 1 more' });
  assert.equal(popover.rows.slice(0, 12).every((row) => row.stateText === 'connected, clock running'), true);
  assert.equal(popover.clockNote, CLOCK_NOTE_TEXT);
});

test('the indicator text, attention, title and dots are the same for every clock state of the same rig', () => {
  for (const problem of [false, true]) {
    const build = (state) =>
      rigModel(
        validRig(
          instrument('seq', 'Port A', { clock: state }),
          instrument('arp', 'Port B', problem ? { state: 'unplugged', matches: [], clock: 'none' } : { clock: state }),
        ),
      );
    const reference = build('none');
    for (const state of ['waiting', 'running']) {
      const shown = build(state);
      for (const key of ['visible', 'text', 'title', 'attention', 'dots']) assert.deepEqual(shown[key], reference[key], `${key} with ${state}, problem ${problem}`);
    }
  }
  const one = rigModel(validRig(instrument('seq', 'Port A', { clock: 'running' })));
  assert.equal(one.text, 'MIDI: seq connected');
  assert.equal(one.attention, false);
});

test('an unknown setup case throws, naming it, even for a hidden indicator', () => {
  assert.throws(() => rigModel({ setup: 'maybe' }), /^Error: Moontide: .*"maybe"/);
  assert.throws(() => rigModel({ setup: undefined }, { usesMidi: false, triedMidi: false }), /^Error: Moontide:/);
  assert.throws(() => rigModel({ setup: 'valid', instruments: [instrument('a', 'A', { state: 'gone' })] }), /^Error: Moontide: .*"gone"/);
});

test('invalid file: hidden while the code neither uses nor tried .midi(, otherwise its own attention text with no dots', () => {
  const rig = { setup: 'invalid', problems: [{ field: 'instruments[0].port', reason: 'required' }], more: 0 };
  assert.equal(rigModel(rig, { usesMidi: false, triedMidi: false }).visible, false);
  for (const flags of [{ usesMidi: true, triedMidi: false }, { usesMidi: false, triedMidi: true }]) {
    const result = rigModel(rig, flags);
    assert.equal(result.visible, true);
    assert.equal(result.text, 'MIDI: instruments.json is invalid');
    assert.equal(result.title, 'MIDI: instruments.json is invalid');
    assert.equal(result.attention, true);
    assert.deepEqual(result.dots, []);
  }
});

test('an unreadable or build-mismatch rig has its own attention text, lead and closing, no rows, and never blames instruments.json', () => {
  const cases = [
    [{ setup: 'invalid', unreadable: true, problems: [], more: 0 }, 'RigUnreadable'],
    [{ setup: 'invalid', buildMismatch: true, problems: [], more: 0 }, 'BuildMismatch'],
  ];
  for (const [rig, name] of cases) {
    assert.equal(rigModel(rig, { usesMidi: false, triedMidi: false }).visible, false);
    for (const flags of [{ usesMidi: true, triedMidi: false }, { usesMidi: false, triedMidi: true }]) {
      const result = rigModel(rig, flags);
      assert.equal(result.visible, true);
      assert.equal(result.text, MIDI_COPY[`indicator${name}`]);
      assert.equal(result.title, MIDI_COPY[`indicator${name}`]);
      assert.equal(result.attention, true);
      assert.deepEqual(result.dots, []);
      assert.equal(result.popover.lead, MIDI_COPY[`pop${name}Lead`]);
      assert.equal(result.popover.closing, MIDI_COPY[`pop${name}Closing`]);
      assert.deepEqual(result.popover.rows, []);
      for (const text of [result.text, result.title, result.popover.lead, result.popover.closing]) assert.ok(!text.includes('instruments.json'), text);
    }
    assert.equal(rigModel(rig, { access: 'denied' }).text, 'MIDI: permission denied');
    assert.equal(rigModel(rig, { access: 'pending' }).text, 'MIDI: waiting for permission');
  }
});

test('invalid file: an access problem still wins, the file state wins over any port state', () => {
  const rig = { setup: 'invalid', problems: [{ field: 'a', reason: 'b' }], more: 0 };
  assert.equal(rigModel(rig, { access: 'denied' }).text, 'MIDI: permission denied');
  assert.equal(rigModel(rig, { access: 'unsupported' }).text, 'MIDI: no Web MIDI, use Chrome or Edge');
  assert.equal(rigModel(rig, { access: 'pending' }).text, 'MIDI: waiting for permission');
  assert.equal(rigModel(rig, { ports: [port('A', 'unplugged')] }).text, 'MIDI: instruments.json is invalid');
  assert.equal(rigModel(rig, {}, { connected: false }).visible, false);
  assert.equal(rigModel(rig, {}, { superseded: true }).visible, false);
});

test('invalid file popover: the lead, one field and reason row per problem (at most 3), "and N more", no outputs line, the closing', () => {
  const problems = ['a', 'b', 'c', 'd', 'e'].map((field) => ({ field: `instruments[${field}]`, reason: `reason ${field}` }));
  const few = rigModel({ setup: 'invalid', problems: problems.slice(0, 2), more: 0 }).popover;
  assert.equal(few.lead, 'instruments.json has a problem, so no instruments are set up.');
  assert.deepEqual(few.rows, [
    { name: 'instruments[a]', stateText: 'reason a' },
    { name: 'instruments[b]', stateText: 'reason b' },
  ]);
  assert.equal(few.outputsLine, null);
  assert.equal(few.closing, 'Fix the file, then reload this page. Claude has been told.');
  const three = rigModel({ setup: 'invalid', problems: problems.slice(0, 3), more: 0 }).popover;
  assert.equal(three.rows.length, 3);
  const many = rigModel({ setup: 'invalid', problems, more: 0 }).popover;
  assert.deepEqual(many.rows.slice(3), [{ text: 'and 2 more' }]);
  assert.equal(many.rows.length, 4);
  // The server's own count of problems it did not send is added.
  assert.deepEqual(rigModel({ setup: 'invalid', problems: problems.slice(0, 3), more: 4 }).popover.rows.slice(3), [{ text: 'and 4 more' }]);
  assert.deepEqual(rigModel({ setup: 'invalid', problems, more: 4 }).popover.rows.slice(3), [{ text: 'and 6 more' }]);
});

test('invalid file: field and reason are kept as written, markup characters included', () => {
  const popover = rigModel({ setup: 'invalid', problems: [{ field: 'instruments[0].<b>x</b>', reason: '<i>bad</i>' }], more: 0 }).popover;
  assert.deepEqual(popover.rows, [{ name: 'instruments[0].<b>x</b>', stateText: '<i>bad</i>' }]);
});

test('valid file: one connected instrument is named by its id, quiet, with one filled dot', () => {
  const result = rigModel(validRig(instrument('mt32', 'Fake Synth A')));
  assert.equal(result.text, 'MIDI: mt32 connected');
  assert.equal(result.title, 'MIDI: mt32 connected');
  assert.equal(result.attention, false);
  assert.deepEqual(result.dots, [{ kind: 'filled', title: 'mt32: connected' }]);
  assert.equal(result.popover.lead, 'Moontide is sending to the instruments in instruments.json.');
  assert.equal(result.popover.closing, 'If an instrument is unplugged, playing resumes by itself when it is back, and the instrument is reset to its known state.');
});

test('valid file: several connected instruments are counted, with a dot each', () => {
  const result = rigModel(validRig(instrument('mt32', 'Fake Synth A'), instrument('sc55', 'Fake Synth B')));
  assert.equal(result.text, 'MIDI: 2 instruments connected');
  assert.equal(result.attention, false);
  assert.deepEqual(result.dots.map((dot) => dot.title), ['mt32: connected', 'sc55: connected']);
});

test('valid file: one unplugged, not found or ambiguous instrument is named, with its lead and closing', () => {
  const unplugged = rigModel(validRig(instrument('sc55', 'UM-ONE', { state: 'unplugged', matches: [] })));
  assert.equal(unplugged.text, 'MIDI: sc55 unplugged');
  assert.equal(unplugged.attention, true);
  assert.equal(unplugged.popover.lead, 'sc55 is unplugged.');
  assert.equal(unplugged.popover.closing, 'Plug it back in. Playing resumes by itself and the instrument is reset to its known state. Claude has been told.');
  assert.deepEqual(unplugged.dots, [{ kind: 'hollow', title: 'sc55: unplugged' }]);
  const missing = rigModel(validRig(instrument('sc55', 'UM-ONE', { state: 'not-found', matches: [] })));
  assert.equal(missing.text, 'MIDI: sc55 not found');
  assert.equal(missing.popover.lead, 'sc55 was not found. No output has the port name written in instruments.json.');
  assert.equal(missing.popover.closing, 'Check the port name in instruments.json, or start the instrument. Claude has been told. Other tracks keep playing.');
  assert.deepEqual(missing.dots, [{ kind: 'hollow', title: 'sc55: not found' }]);
  const ambiguous = rigModel(validRig(instrument('sc55', 'UM', { state: 'ambiguous', matches: ['UM-ONE', 'UM-TWO'] })));
  assert.equal(ambiguous.text, 'MIDI: sc55 matches several outputs');
  assert.equal(ambiguous.popover.lead, 'sc55 matches several outputs.');
  assert.equal(ambiguous.popover.closing, 'Use the exact output name in instruments.json. Claude has been told.');
  assert.deepEqual(ambiguous.dots, [{ kind: 'hollow', title: 'sc55: matches several outputs' }]);
});

test('mt32 on and used, sc55 off reads 1 instrument on, 1 off, a filled dot then an off dot, no attention', () => {
  const result = rigModel(validRig(instrument('mt32', 'Fake Synth A'), instrument('sc55', 'Fake Synth B', { used: false, enabled: false, clock: 'none' })));
  assert.equal(result.visible, true);
  assert.equal(result.text, 'MIDI: 1 instrument on, 1 off');
  assert.equal(result.attention, false);
  assert.deepEqual(result.dots, [
    { kind: 'filled', title: 'mt32: connected' },
    { kind: 'off', title: 'sc55: switched off' },
  ]);
});

const OFF_NOTE_TEXT = 'Instruments switched off stay silent. Switch them on in the Instruments view (key 6).';
const off = (id, portName, overrides = {}) => instrument(id, portName, { enabled: false, clock: 'none', ...overrides });

test('counts are over the whole file, with the n = 0 and n = 1 forms', () => {
  const alpha = instrument('alpha', 'A');
  const beta = instrument('beta', 'B');
  const gamma = instrument('gamma', 'C');
  assert.equal(rigModel(validRig(alpha, off('beta', 'B'), gamma)).text, 'MIDI: 2 instruments on, 1 off');
  assert.equal(rigModel(validRig(alpha, off('beta', 'B'), off('gamma', 'C'))).text, 'MIDI: 1 instrument on, 2 off');
  assert.equal(rigModel(validRig(off('alpha', 'A'), off('beta', 'B'), off('gamma', 'C'))).text, 'MIDI: all 3 instruments off');
  assert.equal(rigModel(validRig(off('alpha', 'A'))).text, 'MIDI: alpha off');
  // An on instrument the code does not use still counts as on.
  assert.equal(rigModel(validRig(alpha, instrument('beta', 'B', { used: false }), off('gamma', 'C'))).text, 'MIDI: 2 instruments on, 1 off');
  // No instrument off: today's texts, and enabled true or missing is on.
  assert.equal(rigModel(validRig(alpha, instrument('beta', 'B', { enabled: true }), beta)).text, 'MIDI: 3 instruments connected');
  for (const result of [rigModel(validRig(alpha, off('beta', 'B'), gamma)), rigModel(validRig(off('alpha', 'A')))]) {
    assert.equal(result.attention, false);
    assert.equal(result.visible, true);
  }
});

test('an id of 30 characters off alone is cut at 24 in the text and whole in the title', () => {
  const longId = 'long-instrument-id'.padEnd(30, 'x');
  const result = rigModel(validRig(off(longId, 'A')));
  assert.equal(result.text, `MIDI: ${longId.slice(0, 23)}${ELLIPSIS} off`);
  assert.equal(result.title, `MIDI: ${longId} off. Off: ${longId}.`);
});

test('the title is the text then the off ids, six at most then and N more', () => {
  const two = rigModel(validRig(instrument('alpha', 'A'), off('beta', 'B')));
  assert.equal(two.title, 'MIDI: 1 instrument on, 1 off. Off: beta.');
  const ids = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8'];
  const many = rigModel(validRig(instrument('on', 'P'), ...ids.map((id) => off(id, `Port ${id}`))));
  assert.equal(many.text, 'MIDI: 1 instrument on, 8 off');
  assert.equal(many.title, 'MIDI: 1 instrument on, 8 off. Off: a1, a2, a3, a4, a5, a6 and 2 more.');
  // Without an off instrument the title is the text, as before.
  assert.equal(rigModel(validRig(instrument('alpha', 'A'))).title, 'MIDI: alpha connected');
});

test('the dots are the on instruments the code uses, then one crossed dot per off instrument, six at most', () => {
  const rig = validRig(off('o1', 'P1'), instrument('u1', 'P2'), instrument('u2', 'P3', { state: 'unplugged', matches: [] }), off('o2', 'P4'));
  const result = rigModel(rig);
  assert.deepEqual(
    result.dots.map((dot) => `${dot.kind}:${dot.title}`),
    ['filled:u1: connected', 'hollow:u2: unplugged', 'off:o1: switched off', 'off:o2: switched off'],
  );
  const five = ['u1', 'u2', 'u3', 'u4', 'u5'].map((id) => instrument(id, `P-${id}`));
  const crowded = rigModel(validRig(...five, off('o1', 'Q1'), off('o2', 'Q2'), off('o3', 'Q3')));
  assert.equal(crowded.dots.length, 6);
  assert.deepEqual(
    crowded.dots.map((dot) => dot.kind),
    ['filled', 'filled', 'filled', 'filled', 'filled', 'off'],
  );
  // An off instrument the code does not use draws its crossed dot too.
  const idle = rigModel(validRig(instrument('alpha', 'A'), off('beta', 'B', { used: false })));
  assert.deepEqual(idle.dots.map((dot) => dot.kind), ['filled', 'off']);
});

test('an on instrument the code uses that has a problem keeps the attention text, off instruments never count', () => {
  const gone = { state: 'unplugged', matches: [] };
  const one = rigModel(validRig(instrument('alpha', 'A', gone), off('beta', 'B'), instrument('gamma', 'C')));
  assert.equal(one.text, 'MIDI: alpha unplugged');
  assert.equal(one.title, 'MIDI: alpha unplugged');
  assert.equal(one.attention, true);
  const two = rigModel(validRig(instrument('alpha', 'A', gone), instrument('beta', 'B', gone), off('gamma', 'C')));
  assert.equal(two.text, 'MIDI: 2 of 2 instruments need attention');
  assert.equal(two.attention, true);
  // The k of n counts on instruments the code uses only.
  const three = rigModel(validRig(instrument('alpha', 'A', gone), instrument('beta', 'B', gone), instrument('gamma', 'C'), off('delta', 'D')));
  assert.equal(three.text, 'MIDI: 2 of 3 instruments need attention');
  // An off instrument that is also unplugged never raises attention.
  const quiet = rigModel(validRig(instrument('alpha', 'A'), off('beta', 'B', gone)));
  assert.equal(quiet.attention, false);
  assert.equal(quiet.text, 'MIDI: 1 instrument on, 1 off');
  // The off dots and the off note still show next to an attention text.
  assert.deepEqual(one.dots.map((dot) => dot.kind), ['hollow', 'filled', 'off']);
  assert.equal(one.popover.offNote, OFF_NOTE_TEXT);
});

test('off instruments never make the indicator appear, and the other cases ignore them', () => {
  const rig = validRig(instrument('alpha', 'A', { used: false }), off('beta', 'B', { used: false }));
  // The code names no MIDI port: hidden, as without any off instrument.
  assert.equal(rigModel(rig, { usesMidi: false, ports: [] }).visible, false);
  assert.equal(rigModel(rig, { access: 'idle', usesMidi: false, ports: [] }).visible, false);
  // The access, invalid-file, unreadable and build-mismatch cases are unchanged.
  const withOff = validRig(instrument('alpha', 'A'), off('beta', 'B'));
  assert.equal(rigModel(withOff, { access: 'denied' }).text, 'MIDI: permission denied');
  assert.equal(rigModel({ setup: 'invalid', problems: [{ field: 'instruments', reason: 'required' }], more: 0 }).text, 'MIDI: instruments.json is invalid');
  assert.equal(rigModel({ setup: 'invalid', unreadable: true, problems: [], more: 0 }).text, 'MIDI: setup not readable, restart the server');
  assert.equal(rigModel({ setup: 'invalid', buildMismatch: true, problems: [], more: 0 }).text, 'MIDI: different builds, restart the server');
});

test('the popover row of an off instrument is its id, port and switched off, nothing else; the note shows only while one is off', () => {
  const rig = validRig(
    instrument('alpha', 'A', { clock: 'running', resetAt: MORNING }),
    off('beta', 'B', { state: 'unplugged', matches: [], resetAt: MORNING, clock: 'running', used: false }),
  );
  const popover = rigModel(rig).popover;
  assert.deepEqual(popover.rows, [
    { name: 'alpha', port: 'A', stateText: 'connected, clock running, reset at 14:05' },
    { name: 'beta', port: 'B', stateText: 'switched off' },
  ]);
  assert.equal(popover.offNote, OFF_NOTE_TEXT);
  assert.equal(popover.clockNote, CLOCK_NOTE_TEXT);
  // Without an off instrument there is no offNote at all.
  assert.equal('offNote' in rigModel(validRig(instrument('alpha', 'A'))).popover, false);
  assert.equal('offNote' in rigModel(validRig(instrument('alpha', 'A', { enabled: true }))).popover, false);
});

test('the off rows still stop at the row limit with and N more', () => {
  const many = Array.from({ length: 14 }, (_, index) => off(`i${index}`, `Port ${index}`));
  const popover = rigModel(validRig(instrument('on', 'P'), ...many)).popover;
  assert.equal(popover.rows.length, 13);
  assert.deepEqual(popover.rows[12], { text: 'and 3 more' });
  assert.equal(popover.rows[1].stateText, 'switched off');
});

test('valid file: a problem on one of two used instruments names that one, two problems are counted', () => {
  const one = rigModel(validRig(instrument('mt32', 'A'), instrument('sc55', 'B', { state: 'unplugged', matches: [] })));
  assert.equal(one.text, 'MIDI: sc55 unplugged');
  const two = rigModel(validRig(instrument('mt32', 'A', { state: 'not-found', matches: [] }), instrument('sc55', 'B', { state: 'unplugged', matches: [] })));
  assert.equal(two.text, 'MIDI: 2 of 2 instruments need attention');
  assert.equal(two.attention, true);
  assert.equal(two.popover.lead, '2 of the 2 instruments in use need attention.');
  assert.equal(two.popover.closing, 'Claude has been told. Other tracks keep playing.');
});

test('valid file: an instrument the code does not use gets no dot and no part in the text, but has its row', () => {
  const result = rigModel(
    validRig(instrument('mt32', 'A'), instrument('sc55', 'B', { state: 'unplugged', matches: [], used: false })),
  );
  assert.equal(result.text, 'MIDI: mt32 connected');
  assert.equal(result.attention, false);
  assert.equal(result.dots.length, 1);
  assert.equal(result.popover.rows.length, 2);
});

test('valid file: at most 6 dots, and the id is cut at 24 characters in the text while the title keeps it whole', () => {
  const many = rigModel(validRig(...Array.from({ length: 8 }, (_, index) => instrument(`i${index}`, `P${index}`))));
  assert.equal(many.dots.length, 6);
  assert.equal(many.text, 'MIDI: 8 instruments connected');
  const id = 'a-very-long-instrument-id-of-thirty'; // 35 characters
  const long = rigModel(validRig(instrument(id, 'P')));
  const cut = `${id.slice(0, INDICATOR_NAME_LIMIT - 1)}…`;
  assert.equal(long.text, `MIDI: ${cut} connected`);
  assert.equal(long.title, `MIDI: ${id} connected`);
  assert.equal(long.dots[0].title, `${id}: connected`);
  assert.equal(rigModel(validRig(instrument(id, 'P', { state: 'unplugged', matches: [] }))).text, `MIDI: ${cut} unplugged`);
});

test('valid file rows: every instrument in file order, id and port apart, then the state parts joined by ", "', () => {
  const rows = rigModel(
    validRig(
      instrument('mt32', 'Fake Synth A', { resetAt: MORNING }),
      instrument('sc55', 'Fake Synth B', { used: false }),
      instrument('jv', 'JV', { state: 'unplugged', matches: [], used: false, resetAt: LATER }),
      instrument('xv', 'XV', { state: 'not-found', matches: [] }),
      instrument('dx', 'DX', { state: 'ambiguous', matches: ['DX 1', 'DX 2'] }),
    ),
  ).popover.rows;
  assert.deepEqual(rows, [
    { name: 'mt32', port: 'Fake Synth A', stateText: 'connected, reset at 14:05' },
    { name: 'sc55', port: 'Fake Synth B', stateText: 'connected, not used by the code' },
    { name: 'jv', port: 'JV', stateText: 'unplugged, reset at 14:07, not used by the code' },
    { name: 'xv', port: 'XV', stateText: 'not found, check the name in instruments.json' },
    { name: 'dx', port: 'DX', stateText: 'matches several outputs: DX 1, DX 2' },
  ]);
});

test('valid file rows: the reset time moves to the new time after a reconnect', () => {
  const at = (resetAt) => rigModel(validRig(instrument('mt32', 'A', { resetAt }))).popover.rows[0].stateText;
  assert.equal(at(MORNING), 'connected, reset at 14:05');
  assert.equal(at(LATER), 'connected, reset at 14:07');
  assert.equal(at(null), 'connected');
});

test('valid file rows: 13 instruments give 12 rows and "and 1 more"; the outputs line is the plain port one', () => {
  const rig = validRig(...Array.from({ length: 13 }, (_, index) => instrument(`i${index}`, `P${index}`)));
  const popover = rigModel(rig).popover;
  assert.equal(popover.rows.length, 13);
  assert.deepEqual(popover.rows[12], { text: 'and 1 more' });
  assert.deepEqual(popover.rows[0], { name: 'i0', port: 'P0', stateText: 'connected' });
  assert.equal(popover.outputsLine, 'Connected outputs: Synth A, Synth B.');
  assert.equal(rigModel(validRig(...Array.from({ length: 12 }, (_, index) => instrument(`i${index}`, `P${index}`)))).popover.rows.length, 12);
});

test('valid file: a reset leaves the indicator text and weight alone', () => {
  const before = rigModel(validRig(instrument('mt32', 'A')));
  const after = rigModel(validRig(instrument('mt32', 'A', { resetAt: MORNING })));
  assert.equal(after.text, before.text);
  assert.equal(after.attention, before.attention);
  assert.deepEqual(after.dots, before.dots);
});

test('valid file: no outputs at all still names the instrument, with no outputs line', () => {
  const result = rigModel(validRig(instrument('mt32', 'A', { state: 'not-found', matches: [] })), { outputs: [] });
  assert.equal(result.text, 'MIDI: mt32 not found');
  assert.equal(result.popover.outputsLine, null);
});

test('valid file: code naming a port that is not a rig port falls back to the port rows', () => {
  const result = rigModel(validRig(instrument('mt32', 'Fake Synth A')), { ports: [port('Other Port')] });
  assert.equal(result.text, 'MIDI: Other Port connected');
  assert.deepEqual(result.popover.rows, [{ name: 'Other Port', stateText: 'connected' }]);
  assert.equal('note' in result.popover, false);
  // Code that names no port at all also stays on the port reading.
  assert.equal(rigModel(validRig(instrument('mt32', 'A')), { ports: [], noPort: { using: 'Synth A' } }).text, 'MIDI: using Synth A');
});

test('valid file: access problems and hiding follow the same rules as without a setup file', () => {
  const rig = validRig(instrument('mt32', 'A'));
  assert.equal(rigModel(rig, { access: 'denied' }).text, 'MIDI: permission denied');
  assert.equal(rigModel(rig, { usesMidi: false, triedMidi: false }).visible, false);
  assert.equal(rigModel(rig, {}, { connected: false }).visible, false);
  assert.equal(rigModel(rig, {}, { superseded: true }).visible, false);
});

test('hhmm is local 24-hour time, zero-padded, from getHours and getMinutes', () => {
  assert.equal(hhmm(new Date(2026, 0, 1, 0, 5)), '00:05');
  assert.equal(hhmm(new Date(2026, 0, 1, 9, 7)), '09:07');
  assert.equal(hhmm(new Date(2026, 0, 1, 23, 59)), '23:59');
  assert.equal(hhmm(new Date(2026, 5, 1, 12, 0)), '12:00');
});

test('midiTitle puts the warning in front of the base title only while hidden with MIDI code playing and this tab holding the role', () => {
  assert.equal(MIDI_TITLE_PREFIX, '⚠ MIDI · ');
  const base = 'Moontide · my-project · 5757';
  const on = { hidden: true, usesMidi: true, playing: true, superseded: false, baseTitle: base };
  assert.equal(midiTitle(on), '⚠ MIDI · Moontide · my-project · 5757');
  assert.equal(midiTitle({ ...on, hidden: false }), base);
  assert.equal(midiTitle({ ...on, usesMidi: false }), base);
  assert.equal(midiTitle({ ...on, playing: false }), base);
  assert.equal(midiTitle({ ...on, superseded: true }), base);
  // The unusable-folder form: the port alone behind the wordmark.
  assert.equal(midiTitle({ ...on, baseTitle: 'Moontide · 5757' }), '⚠ MIDI · Moontide · 5757');
  assert.equal(midiTitle({ ...on, hidden: false, baseTitle: 'Moontide · 5757' }), 'Moontide · 5757');
});

test('midiTitle throws a TypeError without a non-empty base title', () => {
  const on = { hidden: true, usesMidi: true, playing: true, superseded: false };
  assert.throws(() => midiTitle(on), TypeError);
  assert.throws(() => midiTitle({ ...on, baseTitle: '' }), TypeError);
  assert.throws(() => midiTitle({ ...on, baseTitle: null }), TypeError);
  assert.throws(() => midiTitle({ ...on, hidden: false, baseTitle: undefined }), TypeError);
});

test('returnBannerText carries the two times', () => {
  assert.equal(returnBannerText('14:05', '14:12'), 'MIDI timing may have broken while this tab was hidden (from 14:05 to 14:12).');
  assert.equal(MIDI_COPY.bannerDismiss, 'Dismiss');
});

test('the banner constants: 3 s minimum hidden period, 20 s before it fades, a 150 ms fade', () => {
  assert.equal(MIDI_BANNER_MIN_HIDDEN_MS, 3000);
  assert.equal(MIDI_BANNER_FADE_MS, 20000);
  assert.equal(MIDI_BANNER_FADE_OUT_MS, 150);
});

test('hiddenTransition records the start of the hidden-with-MIDI condition and gives no banner while it holds', () => {
  const started = hiddenTransition({ since: null }, { hiddenWithMidi: true, hidden: true, now: 1000 });
  assert.deepEqual(started, { state: { since: 1000 }, banner: null });
  const held = hiddenTransition(started.state, { hiddenWithMidi: true, hidden: true, now: 9000 });
  assert.deepEqual(held, { state: { since: 1000 }, banner: null });
  assert.deepEqual(hiddenTransition({ since: null }, { hiddenWithMidi: false, hidden: false, now: 5 }), { state: { since: null }, banner: null });
});

test('hiddenTransition gives a banner with the two times when the page is visible after 3000 ms or more', () => {
  assert.deepEqual(hiddenTransition({ since: 1000 }, { hiddenWithMidi: false, hidden: false, now: 4000 }), {
    state: { since: null },
    banner: { from: 1000, to: 4000 },
  });
  assert.deepEqual(hiddenTransition({ since: 1000 }, { hiddenWithMidi: false, hidden: false, now: 65000 }), {
    state: { since: null },
    banner: { from: 1000, to: 65000 },
  });
});

test('hiddenTransition gives no banner for a hidden period shorter than 3000 ms', () => {
  assert.deepEqual(hiddenTransition({ since: 1000 }, { hiddenWithMidi: false, hidden: false, now: 3999 }), { state: { since: null }, banner: null });
});

test('hiddenTransition forgets the start when the condition ends while the page is still hidden', () => {
  // Stop, the code dropping MIDI or a superseded tab ends the condition without the page coming back.
  assert.deepEqual(hiddenTransition({ since: 1000 }, { hiddenWithMidi: false, hidden: true, now: 9000 }), { state: { since: null }, banner: null });
  const later = hiddenTransition({ since: null }, { hiddenWithMidi: false, hidden: false, now: 20000 });
  assert.equal(later.banner, null, 'coming back later shows nothing');
});

test('hiddenTransition: a second hidden period replaces the first', () => {
  const first = hiddenTransition({ since: null }, { hiddenWithMidi: true, hidden: true, now: 1000 });
  const back = hiddenTransition(first.state, { hiddenWithMidi: false, hidden: false, now: 5000 });
  assert.deepEqual(back.banner, { from: 1000, to: 5000 });
  const second = hiddenTransition(back.state, { hiddenWithMidi: true, hidden: true, now: 7000 });
  assert.deepEqual(second.state, { since: 7000 });
  const backAgain = hiddenTransition(second.state, { hiddenWithMidi: false, hidden: false, now: 12000 });
  assert.deepEqual(backAgain.banner, { from: 7000, to: 12000 });
});

/** A clock the banner timer can be driven by: setTimer and clearTimer over a list, advance(ms) fires what is due. */
function fakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { fn, at: now + ms });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(id);
          timer.fn();
        }
      }
    },
    pending: () => timers.size,
  };
}

test('createBannerTimer expires 20 s after start', () => {
  const clock = fakeClock();
  let expired = 0;
  const timer = createBannerTimer({ setTimer: clock.setTimer, clearTimer: clock.clearTimer, onExpire: () => expired++ });
  timer.start();
  clock.advance(MIDI_BANNER_FADE_MS - 1);
  assert.equal(expired, 0);
  clock.advance(1);
  assert.equal(expired, 1);
  clock.advance(MIDI_BANNER_FADE_MS * 2);
  assert.equal(expired, 1, 'it fires once');
});

test('createBannerTimer pauses while the pointer is over the banner and restarts from 20 s when it leaves', () => {
  const clock = fakeClock();
  let expired = 0;
  const timer = createBannerTimer({ setTimer: clock.setTimer, clearTimer: clock.clearTimer, onExpire: () => expired++ });
  timer.start();
  clock.advance(15000);
  timer.pause('pointer');
  clock.advance(60000);
  assert.equal(expired, 0, 'paused');
  timer.resume('pointer');
  clock.advance(MIDI_BANNER_FADE_MS - 1);
  assert.equal(expired, 0, 'the full 20 s start again');
  clock.advance(1);
  assert.equal(expired, 1);
});

test('createBannerTimer needs both the pointer and the focus to leave before it restarts', () => {
  const clock = fakeClock();
  let expired = 0;
  const timer = createBannerTimer({ setTimer: clock.setTimer, clearTimer: clock.clearTimer, onExpire: () => expired++ });
  timer.start();
  timer.pause('pointer');
  timer.pause('focus');
  timer.resume('pointer');
  clock.advance(MIDI_BANNER_FADE_MS * 2);
  assert.equal(expired, 0, 'focus is still inside');
  timer.resume('focus');
  clock.advance(MIDI_BANNER_FADE_MS);
  assert.equal(expired, 1);
});

test('createBannerTimer stop cancels and start again restarts', () => {
  const clock = fakeClock();
  let expired = 0;
  const timer = createBannerTimer({ setTimer: clock.setTimer, clearTimer: clock.clearTimer, onExpire: () => expired++ });
  timer.start();
  timer.stop();
  assert.equal(clock.pending(), 0);
  clock.advance(MIDI_BANNER_FADE_MS * 2);
  assert.equal(expired, 0);
  timer.start();
  clock.advance(10000);
  timer.start();
  clock.advance(15000);
  assert.equal(expired, 0, 'the second start restarted the 20 s');
  clock.advance(5000);
  assert.equal(expired, 1);
  assert.equal(clock.pending(), 0);
});

test('createBannerTimer: resume without a pause and a resume while stopped start nothing', () => {
  const clock = fakeClock();
  let expired = 0;
  const timer = createBannerTimer({ setTimer: clock.setTimer, clearTimer: clock.clearTimer, onExpire: () => expired++ });
  timer.resume('pointer');
  assert.equal(clock.pending(), 0);
  timer.start();
  timer.pause('pointer');
  timer.stop();
  timer.resume('pointer');
  assert.equal(clock.pending(), 0, 'a stopped timer stays stopped');
});

// --- A controls option the page cannot read is a problem of its call ---

import { readMidiSetup as readSetupForControls } from '../page/midi-plan.js';

const setupCall = (code) => {
  const result = readSetupForControls(code, { parse });
  assert.equal(result.ok, true, `expected ${code} to parse`);
  return result.calls[0];
};

test('a controls option that is not a plain object of numbers is the controlsNotPlain problem, with no controls', () => {
  for (const controls of ['someVar', '{ volume: x }', '{ [k]: 1 }', '{ volume: 90, volume: 80 }', "'loud'", '{ ...more }']) {
    const call = setupCall(`note("c3").midi('Port A', { midichannel: 3, controls: ${controls} })`);
    assert.equal(call.problems.controls?.key, 'controlsNotPlain', controls);
    assert.equal(call.controls.size, 0, controls);
  }
});

test('a plain controls object keeps the problem null, a negative literal is read as it is, and the last controls key wins', () => {
  const plain = setupCall(`note("c3").midi('Port A', { midichannel: 3, controls: { volume: 90, pan: -1 } })`);
  assert.equal(plain.problems.controls, null);
  assert.deepEqual([...plain.controls], [['volume', 90], ['pan', -1]]);
  const later = setupCall(`note("c3").midi('Port A', { controls: someVar, controls: { volume: 90 } })`);
  assert.equal(later.problems.controls, null, 'a later plain controls key clears the problem');
  assert.deepEqual([...later.controls], [['volume', 90]]);
  const broken = setupCall(`note("c3").midi('Port A', { controls: { volume: 90 }, controls: someVar })`);
  assert.equal(broken.problems.controls?.key, 'controlsNotPlain');
  assert.equal(broken.controls.size, 0);
  const none = setupCall(`note("c3").midi('Port A', { midichannel: 3 })`);
  assert.equal(none.problems.controls, null);
});
