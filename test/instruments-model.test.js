// The Instruments view's pure model, tested without a browser. The real acorn parser is
// injected, like in test/midi-controls.test.js. All data is neutral and made up (Port A, alpha, a folder path
// that is an obvious placeholder): no real session code, path or setup file is ever copied into a test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';
// Namespace import: a missing export fails inside each test, not at load.
import * as model from '../page/instruments-model.js';
import { ACCESS_STATES, MIDI_COPY, fill } from '../page/midi-plan.js';
import { BUILD_MISMATCH_COPY, CONNECTION_LABELS } from '../page/ui-state.js';
import { midiTag, readMidiTracks } from '../page/midi-controls.js';
import { RIG_LIMITS } from '../page/midi-rig.js';
import { BUILT_IN_DRUM_MAPS } from '../dist/drum-maps.js';
import { bankDrumsModel } from './drum-fixtures.js';

const MT32_CHANNELS = [2, 3, 4, 5, 6, 7, 8, 9].map((channel) => ({ channel, role: 'melodic' })).concat([{ channel: 10, role: 'rhythm' }]);
const SC55_CHANNELS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 14, 15, 16]
  .map((channel) => ({ channel, role: 'melodic' }))
  .concat([{ channel: 10, role: 'rhythm' }])
  .sort((a, b) => a.channel - b.channel);

const CONTROLS = [
  { id: 'modulation', name: 'Modulation', cc: 1, min: 0, max: 127, default: 0 },
  { id: 'volume', name: 'Volume', cc: 7, min: 0, max: 127, default: 100 },
  { id: 'pan', name: 'Pan', cc: 10, min: 0, max: 127, default: 64 },
  { id: 'expression', name: 'Expression', cc: 11, min: 0, max: 127, default: 127 },
  { id: 'hold', name: 'Hold', cc: 64, min: 0, max: 127, default: 0 },
];

const instrument = (overrides = {}) => ({
  id: 'alpha',
  model: 'mt32',
  modelName: 'Roland MT-32',
  port: 'Port A',
  channels: MT32_CHANNELS,
  bankSelect: 'none',
  defaultVolume: 100,
  clock: false,
  controls: CONTROLS,
  reset: null,
  sounds: { melodic: [], rhythm: [] },
  catalogSounds: 0,
  // The drum fields of a parsed rig: drumMapFor throws on a rig object without them, by design.
  rhythmBank: false,
  drumMap: null,
  drumMaps: [],
  catalogKits: 0,
  ...overrides,
  // Every channel of the model; by default the instrument declares all of them.
  modelChannels: overrides.modelChannels ?? overrides.channels ?? MT32_CHANNELS,
});
const ALPHA = instrument();
const BETA = instrument({ id: 'beta', model: 'sc55', modelName: 'Roland SC-55', port: 'Port B', channels: SC55_CHANNELS });

const validRig = (...instruments) => ({ setup: 'valid', instruments });

/** A rigView()-like reading: every instrument connected on its own port unless `states` says otherwise. */
function liveOf(rig, states = {}) {
  if (rig.setup !== 'valid') return { setup: rig.setup };
  return {
    setup: 'valid',
    instruments: rig.instruments.map((entry) => {
      const reading = states[entry.id] ?? { state: 'connected', matches: [entry.port] };
      return { id: entry.id, port: entry.port, state: reading.state, matches: reading.matches ?? [], resetAt: null, used: false, clock: 'none' };
    }),
  };
}

/** The inputs of one render: connected, enabled, one instrument, nothing playing. */
function inputs(overrides = {}) {
  const rig = overrides.rig ?? validRig(ALPHA);
  return {
    connection: 'connected',
    superseded: false,
    noActive: false,
    rig,
    live: overrides.live ?? liveOf(rig, overrides.states),
    access: 'enabled',
    supported: true,
    outputs: [],
    code: '',
    parse,
    dataFolder: null,
    ...overrides,
  };
}

const FOLDER = '/data/moontide-placeholder';
const INVALID_RIG = (count, more = 0) => ({
  setup: 'invalid',
  problems: Array.from({ length: count }, (_, index) => ({ field: `instruments[${index}].port`, reason: `reason ${index}` })),
  more,
});

// --- Messages: first match wins ---

test('connecting beats everything, even an absent rig, a superseded tab or a build mismatch', () => {
  const connecting = (overrides) => model.instrumentsModel(inputs({ connection: 'connecting', ...overrides }));
  for (const overrides of [
    { rig: { setup: 'absent' } },
    { superseded: true },
    { rig: { setup: 'invalid', problems: [], more: 0, buildMismatch: true } },
    { rig: { setup: 'invalid', problems: [], more: 0, unreadable: true } },
    { rig: INVALID_RIG(2) },
  ]) {
    const result = connecting(overrides);
    assert.equal(result.kind, 'message');
    assert.equal(result.state, 'connecting');
    assert.equal(result.lead, CONNECTION_LABELS.connecting);
    assert.equal(result.lead, 'Connecting…');
  }
});

test('disconnected and refused have their own lead and beat the tab role and the file', () => {
  const disconnected = model.instrumentsModel(inputs({ connection: 'disconnected', superseded: true, rig: { setup: 'absent' } }));
  assert.equal(disconnected.state, 'disconnected');
  assert.equal(disconnected.lead, 'Disconnected — instruments show again when Moontide reconnects.');
  const refused = model.instrumentsModel(inputs({ connection: 'refused', superseded: true, rig: { setup: 'absent' } }));
  assert.equal(refused.state, 'refused');
  assert.equal(refused.lead, 'Refused — reload the page');
  assert.equal(refused.lead, CONNECTION_LABELS.refused);
});

test('a tab that lost the playing role says so and names the way back; no tab playing has its own lead', () => {
  const another = model.instrumentsModel(inputs({ superseded: true, rig: { setup: 'absent' } }));
  assert.equal(another.state, 'superseded');
  assert.equal(another.lead, 'Moontide is playing in another tab');
  assert.equal(another.sub, 'Use "Play in this tab" in the top bar to see instruments here.');
  // A superseded tab never shows cards, so it has no switch or settings form to show a stale rig with.
  const withRig = model.instrumentsModel(inputs({ superseded: true, rig: validRig(ALPHA, BETA) }));
  assert.equal(withRig.kind, 'message');
  assert.equal(withRig.state, 'superseded');
  assert.equal(withRig.cards, undefined);
  const none = model.instrumentsModel(inputs({ superseded: true, noActive: true, rig: validRig(ALPHA) }));
  assert.equal(none.lead, 'No tab is playing');
  assert.equal(none.kind, 'message');
});

test('a build mismatch beats unreadable beats invalid, with the top bar words and never the invalid-file words', () => {
  const mismatch = model.instrumentsModel(inputs({ rig: { setup: 'invalid', problems: [], more: 0, buildMismatch: true, unreadable: true } }));
  assert.equal(mismatch.state, 'build-mismatch');
  assert.equal(mismatch.lead, 'Restart Claude: different builds');
  assert.equal(mismatch.lead, BUILD_MISMATCH_COPY.line);
  assert.equal(mismatch.sub, 'The server and the page come from different builds, so instruments cannot be shown.');
  assert.deepEqual(mismatch.problems, []);
  assert.equal(JSON.stringify(mismatch).includes('instruments.json is invalid'), false);
  assert.equal(JSON.stringify(mismatch).includes(MIDI_COPY.popSetupInvalidLead), false);

  const unreadable = model.instrumentsModel(inputs({ rig: { setup: 'invalid', problems: [{ field: 'x', reason: 'y' }], more: 3, unreadable: true } }));
  assert.equal(unreadable.state, 'unreadable');
  assert.equal(unreadable.lead, 'Restart Claude: setup not readable');
  assert.equal(unreadable.sub, 'The page could not read the MIDI setup the server sent. The server may come from an older build.');
  assert.deepEqual(unreadable.problems, []);
  assert.equal(unreadable.more, null);
  assert.equal(unreadable.closing, null);
  assert.equal(JSON.stringify(unreadable).includes('instruments.json is invalid'), false);
});

test('no file: the data folder path comes back whole, or the lead ends with a period and the sub points to Claude', () => {
  const known = model.instrumentsModel(inputs({ rig: { setup: 'absent' }, dataFolder: FOLDER }));
  assert.equal(known.state, 'absent');
  assert.equal(known.lead, 'Create instruments.json in the Moontide data folder:');
  assert.equal(known.folder, FOLDER);
  assert.equal(known.sub, 'It lists your MIDI instruments, and this view shows them.');
  assert.deepEqual(known.problems, []);

  const unknown = model.instrumentsModel(inputs({ rig: { setup: 'absent' }, dataFolder: null }));
  assert.equal(unknown.lead, 'Create instruments.json in the Moontide data folder.');
  assert.equal(unknown.folder, null);
  assert.equal(unknown.sub, 'It lists your MIDI instruments, and this view shows them. Claude can tell you where the folder is.');

  const long = `/${'folder/'.repeat(150)}`;
  assert.equal(long.length > 1000, true);
  assert.equal(model.instrumentsModel(inputs({ rig: { setup: 'absent' }, dataFolder: long })).folder, long);
  assert.throws(() => model.instrumentsModel(inputs({ rig: { setup: 'absent' }, dataFolder: 7 })), /^Error: Moontide:/);
});

test('an invalid file lists every problem in order, then the rest counted with the message, then the closing line', () => {
  const three = model.instrumentsModel(inputs({ rig: INVALID_RIG(3) }));
  assert.equal(three.state, 'invalid');
  assert.equal(three.lead, 'instruments.json has a problem, so no instruments are set up.');
  assert.deepEqual(three.problems, [
    { field: 'instruments[0].port', reason: 'reason 0' },
    { field: 'instruments[1].port', reason: 'reason 1' },
    { field: 'instruments[2].port', reason: 'reason 2' },
  ]);
  assert.equal(three.more, null);
  assert.equal(three.closing, 'Fix the file, then reload this page.');

  const exactly = model.instrumentsModel(inputs({ rig: INVALID_RIG(20, 0) }));
  assert.equal(exactly.problems.length, 20);
  assert.equal(exactly.more, null);

  const withMore = model.instrumentsModel(inputs({ rig: INVALID_RIG(20, 5) }));
  assert.equal(withMore.problems.length, 20);
  assert.equal(withMore.more, 'and 5 more');

  const beyond = model.instrumentsModel(inputs({ rig: INVALID_RIG(23, 2) }));
  assert.equal(beyond.problems.length, 20);
  assert.equal(beyond.more, 'and 5 more');

  const markup = model.instrumentsModel(inputs({ rig: { setup: 'invalid', problems: [{ field: 'instruments[0]["<b>x</b>"]', reason: 'is <i>unknown</i>' }], more: 0 } }));
  assert.deepEqual(markup.problems, [{ field: 'instruments[0]["<b>x</b>"]', reason: 'is <i>unknown</i>' }]);
});

test('a rig setup the model does not know throws', () => {
  assert.throws(() => model.instrumentsModel(inputs({ rig: { setup: 'weird' } })), /^Error: Moontide:/);
});

test('an unknown connection or access throws a Moontide error that names the value', () => {
  assert.throws(() => model.instrumentsModel(inputs({ connection: 'weird' })), /^Error: Moontide:.*weird/);
  assert.throws(() => model.instrumentsModel(inputs({ access: 'weird' })), /^Error: Moontide:.*weird/);
  assert.throws(() => model.instrumentsModel(inputs({ connection: 'connecting', access: 'weird' })), /^Error: Moontide:.*weird/);
});

// --- The notice ---

const noticeOf = (overrides) => model.instrumentsModel(inputs(overrides)).notice;

test('the notice is the first match: no Web MIDI, then denied, failed, pending, idle; enabled has none', () => {
  assert.equal(noticeOf({ supported: false, access: 'idle' }), 'This browser has no Web MIDI, so MIDI instruments cannot play here. Use Chrome or Edge.');
  assert.equal(noticeOf({ supported: false, access: 'denied' }), 'This browser has no Web MIDI, so MIDI instruments cannot play here. Use Chrome or Edge.');
  assert.equal(noticeOf({ supported: true, access: 'unsupported' }), 'This browser has no Web MIDI, so MIDI instruments cannot play here. Use Chrome or Edge.');
  assert.equal(
    noticeOf({ access: 'denied' }),
    'MIDI access is blocked for this page, so MIDI tracks are silent. Click the padlock left of the address bar, set MIDI devices to Allow, then reload this page.',
  );
  assert.equal(noticeOf({ access: 'failed' }), 'Web MIDI could not start in this page, so MIDI tracks are silent. Reload the page to try again.');
  assert.equal(noticeOf({ access: 'pending' }), MIDI_COPY.popPendingLead);
  assert.equal(noticeOf({ access: 'idle' }), 'Port states show once MIDI is allowed. Moontide asks when a track plays a MIDI instrument.');
  assert.equal(noticeOf({ access: 'enabled' }), null);
});

test('the no-Web-MIDI notice also shows above the no-file and invalid-file messages; the others only above cards', () => {
  const unsupported = 'This browser has no Web MIDI, so MIDI instruments cannot play here. Use Chrome or Edge.';
  assert.equal(noticeOf({ rig: { setup: 'absent' }, supported: false, access: 'idle' }), unsupported);
  assert.equal(noticeOf({ rig: INVALID_RIG(1), supported: false, access: 'idle' }), unsupported);
  for (const access of ['denied', 'failed', 'pending', 'idle']) {
    assert.equal(noticeOf({ rig: { setup: 'absent' }, access }), null, `absent with ${access}`);
    assert.equal(noticeOf({ rig: INVALID_RIG(1), access }), null, `invalid with ${access}`);
  }
  assert.equal(noticeOf({ connection: 'connecting', supported: false }), null);
  assert.equal(noticeOf({ rig: { setup: 'invalid', problems: [], more: 0, buildMismatch: true }, supported: false }), null);
});

// --- Channels (R-CH) ---

test('channelsText writes runs of consecutive channels of one role; two read "1, 2", three or more "2–9"', () => {
  assert.equal(model.channelsText(MT32_CHANNELS), 'ch 2–9 melodic, ch 10 rhythm');
  assert.equal(model.channelsText(SC55_CHANNELS), 'ch 1–9 melodic, ch 10 rhythm, ch 11–16 melodic');
  assert.equal(model.channelsText([{ channel: 1, role: 'melodic' }, { channel: 2, role: 'melodic' }]), 'ch 1, 2 melodic');
  assert.equal(
    model.channelsText([1, 2, 3, 5].map((channel) => ({ channel, role: 'melodic' }))),
    'ch 1–3, 5 melodic',
  );
  assert.equal(model.channelsText([{ channel: 10, role: 'rhythm' }]), 'ch 10 rhythm');
  assert.equal(
    model.channelsText([{ channel: 9, role: 'melodic' }, { channel: 10, role: 'rhythm' }]),
    'ch 9 melodic, ch 10 rhythm',
  );
});

test('channelsText gives the same text for unsorted input and never changes its input', () => {
  const shuffled = [...SC55_CHANNELS].reverse();
  const before = JSON.stringify(shuffled);
  assert.equal(model.channelsText(shuffled), model.channelsText(SC55_CHANNELS));
  assert.equal(JSON.stringify(shuffled), before);
});

// --- Card rows ---

const cardsOf = (overrides) => {
  const result = model.instrumentsModel(inputs(overrides));
  assert.equal(result.kind, 'cards');
  return result.cards;
};

test('one instrument gives one card with its id, title, model and declared facts', () => {
  const cards = cardsOf({});
  assert.equal(cards.length, 1);
  const [card] = cards;
  assert.equal(card.id, 'alpha');
  assert.equal(card.title, 'mt32 on Port A');
  assert.deepEqual(card.model, { text: 'Roland MT-32', title: 'mt32' });
  assert.equal(card.channels, 'ch 2–9 melodic, ch 10 rhythm');
});

test('cards follow file order and keep it across calls', () => {
  const rig = validRig(BETA, ALPHA);
  const first = cardsOf({ rig }).map((card) => card.id);
  const second = cardsOf({ rig }).map((card) => card.id);
  assert.deepEqual(first, ['beta', 'alpha']);
  assert.deepEqual(second, first);
});

test('the clock row only exists for an instrument that follows the clock', () => {
  assert.equal(cardsOf({ rig: validRig(instrument({ clock: true })) })[0].clock, 'follows the clock');
  assert.equal(cardsOf({ rig: validRig(instrument({ clock: false })) })[0].clock, null);
});

test('the catalog row reads "1 sound" or "4325 sounds" and does not exist without a catalog', () => {
  assert.equal(cardsOf({ rig: validRig(instrument({ catalogSounds: 0 })) })[0].catalog, null);
  assert.equal(cardsOf({ rig: validRig(instrument({ catalogSounds: 1 })) })[0].catalog, '1 sound');
  assert.equal(cardsOf({ rig: validRig(instrument({ catalogSounds: 4325 })) })[0].catalog, '4325 sounds');
});

test('one chip per declared control in model order, volume included, with its title and label', () => {
  const [card] = cardsOf({});
  assert.deepEqual(
    card.controls.map((chip) => chip.name),
    ['Modulation', 'Volume', 'Pan', 'Expression', 'Hold'],
  );
  const volume = card.controls.find((chip) => chip.name === 'Volume');
  assert.equal(volume.text, 'Volume 100');
  assert.equal(volume.value, '100');
  assert.equal(volume.title, 'Volume: default 100, range 0–127');
  assert.equal(volume.label, 'Volume, default 100');
  assert.equal(card.controlsNone, null);
});

test('no controls gives none, and 32 controls give 32 chips', () => {
  const none = cardsOf({ rig: validRig(instrument({ controls: [] })) })[0];
  assert.deepEqual(none.controls, []);
  assert.equal(none.controlsNone, 'none');
  const many = Array.from({ length: 32 }, (_, index) => ({ id: `c${index}`, name: `Control ${index}`, cc: index, min: 0, max: 127, default: index }));
  const full = cardsOf({ rig: validRig(instrument({ controls: many })) })[0];
  assert.equal(full.controls.length, 32);
  assert.equal(full.controls[31].text, 'Control 31 31');
});

test('no row is ever produced with an empty value or a placeholder dash', () => {
  const bare = cardsOf({ rig: validRig(instrument({ controls: [], clock: false, catalogSounds: 0 })) })[0];
  const texts = [bare.channels, bare.clock, bare.controlsNone, bare.catalog].filter((value) => value !== null);
  for (const text of texts) {
    assert.notEqual(text, '');
    assert.notEqual(text, '-');
    assert.notEqual(text, '—');
  }
});

// --- The port part ---

test('while the live state is null the card has the dash dot and "not checked", never a read state', () => {
  const [card] = cardsOf({ states: { alpha: { state: null, matches: [] } }, access: 'idle' });
  assert.deepEqual(card.port, {
    name: 'Port A',
    dot: { kind: 'unknown', title: 'alpha: not checked' },
    words: 'not checked',
    attention: false,
    stateKind: null,
  });
});

test('connected reads "connected", or "connected as {output}" when the output name differs from the port (R-AS)', () => {
  const same = cardsOf({ states: { alpha: { state: 'connected', matches: ['Port A'] } } })[0].port;
  assert.equal(same.words, 'connected');
  assert.deepEqual(same.dot, { kind: 'filled', title: 'alpha: connected' });
  assert.equal(same.attention, false);
  assert.equal(same.stateKind, 'connected');
  const other = cardsOf({ states: { alpha: { state: 'connected', matches: ['Port A 2'] } } })[0].port;
  assert.equal(other.words, 'connected as Port A 2');
  assert.equal(other.stateKind, 'connected');
});

test('unplugged, not found and ambiguous have the hollow ring, their words and the attention flag', () => {
  const unplugged = cardsOf({ states: { alpha: { state: 'unplugged', matches: [] } } })[0].port;
  assert.deepEqual(unplugged, { name: 'Port A', dot: { kind: 'hollow', title: 'alpha: unplugged' }, words: 'unplugged', attention: true, stateKind: 'unplugged' });
  const notFound = cardsOf({ states: { alpha: { state: 'not-found', matches: [] } } })[0].port;
  assert.equal(notFound.words, 'not found, check the name in instruments.json');
  assert.deepEqual(notFound.dot, { kind: 'hollow', title: 'alpha: not found' });
  assert.equal(notFound.attention, true);
  const ambiguous = cardsOf({ states: { alpha: { state: 'ambiguous', matches: ['Port A 1', 'Port A 2'] } } })[0].port;
  assert.equal(ambiguous.words, 'matches several outputs: Port A 1, Port A 2');
  assert.deepEqual(ambiguous.dot, { kind: 'hollow', title: 'alpha: matches several outputs' });
});

test('the ambiguous outputs are cut like the popover: six names, then "and {count} more"', () => {
  const matches = Array.from({ length: 8 }, (_, index) => `Out ${index + 1}`);
  const { words } = cardsOf({ states: { alpha: { state: 'ambiguous', matches } } })[0].port;
  assert.equal(words, 'matches several outputs: Out 1, Out 2, Out 3, Out 4, Out 5, Out 6 and 2 more');
});

test('the live reading is matched by id, never by place', () => {
  const rig = validRig(ALPHA, BETA);
  const live = liveOf(rig, { alpha: { state: 'unplugged', matches: [] }, beta: { state: 'connected', matches: ['Port B'] } });
  live.instruments.reverse();
  const [alpha, beta] = cardsOf({ rig, live });
  assert.equal(alpha.port.stateKind, 'unplugged');
  assert.equal(beta.port.stateKind, 'connected');
});

test('an unknown port state throws, and a live list without the card id throws', () => {
  assert.throws(() => cardsOf({ states: { alpha: { state: 'odd', matches: [] } } }), /^Error: Moontide:.*odd/);
  const rig = validRig(ALPHA, BETA);
  const live = liveOf(validRig(ALPHA));
  assert.throws(() => model.instrumentsModel(inputs({ rig, live })), /^Error: Moontide:.*beta/);
});

test('cards carry the footer that says how the file is read again', () => {
  const result = model.instrumentsModel(inputs({}));
  assert.equal(result.footer, 'Edits to instruments.json made by hand show after you reload this page. Changes made here show at once.');
});

// --- In use ---

const inUse = (code, rig = validRig(ALPHA, BETA), overrides = {}) => model.instrumentsModel(inputs({ rig, code, ...overrides })).cards.find((card) => card.id === 'alpha').inUse;

test('tracks on one channel are one line, names in code order joined with a comma', () => {
  const code = `lead: note("c3").midi('Port A', { midichannel: 3 })\npad: note("c2").midi('Port A', { midichannel: 3 })`;
  assert.deepEqual(inUse(code), { lead: null, lines: ['lead, pad · ch 3'], muted: false });
});

test('tracks on two channels give one line per channel in ascending order', () => {
  const code = `lead: note("c3").midi('Port A', { midichannel: 5 })\npad: note("c2").midi('Port A', { midichannel: 2 })`;
  assert.deepEqual(inUse(code).lines, ['pad · ch 2', 'lead · ch 5']);
});

test('a muted track is followed by (muted)', () => {
  const code = `lead: note("c3").midi('Port A', { midichannel: 3 })\n_pad: note("c2").midi('Port A', { midichannel: 3 })`;
  assert.deepEqual(inUse(code).lines, ['lead, pad (muted) · ch 3']);
});

test('a track whose channel cannot be read is on the last line without a channel', () => {
  const code = `lead: note("c3").midi('Port A', { midichannel: 99 })\npad: note("c2").midi('Port A', { midichannel: 2 })`;
  assert.deepEqual(inUse(code).lines, ['pad · ch 2', 'lead']);
});

test('a control-only track is listed', () => {
  const code = `ctl: ccv(sine.range(0, 127)).ccn(7).midi('Port A', { midichannel: 3 })`;
  assert.deepEqual(inUse(code).lines, ['ctl · ch 3']);
});

test('nothing uses the instrument: "not used by the code", muted', () => {
  const code = `lead: note("c3").midi('Port B', { midichannel: 3 })`;
  assert.deepEqual(inUse(code), { lead: null, lines: ['not used by the code'], muted: true });
  assert.deepEqual(inUse(''), { lead: null, lines: ['not used by the code'], muted: true });
});

test('the port named outside a track: "used outside a track", muted', () => {
  const code = `const a = note("c3").midi('Port A')\nlead: s("x")`;
  assert.deepEqual(inUse(code), { lead: null, lines: ['used outside a track'], muted: true });
});

test("code that does not parse, or no parser: \"can't read the code\", muted", () => {
  assert.deepEqual(inUse('lead: note("c3").midi('), { lead: null, lines: ["can't read the code"], muted: true });
  assert.deepEqual(inUse(`lead: note("c3").midi('Port A')`, validRig(ALPHA, BETA), { parse: null }), { lead: null, lines: ["can't read the code"], muted: true });
});

test('the channel suffix of each line equals midiTag(track).channel', () => {
  const code = `lead: note("c3").midi('Port A', { midichannel: 5 })\npad: note("c2").midi('Port A', { midichannel: 2 })`;
  const rig = validRig(ALPHA, BETA);
  const tracks = [...readMidiTracks(code, { parse, rig }).tracks.values()];
  const lines = inUse(code, rig).lines;
  for (const track of tracks) {
    const line = lines.find((entry) => entry.startsWith(track.name));
    assert.ok(line.endsWith(midiTag(track).channel), `${line} ends with ${midiTag(track).channel}`);
  }
});

test('each instrument gets the tracks of its own port', () => {
  const code = `lead: note("c3").midi('Port A', { midichannel: 3 })\nbass: note("c2").midi('Port B', { midichannel: 1 })`;
  const result = model.instrumentsModel(inputs({ rig: validRig(ALPHA, BETA), code }));
  assert.deepEqual(result.cards[0].inUse.lines, ['lead · ch 3']);
  assert.deepEqual(result.cards[1].inUse.lines, ['bass · ch 1']);
});

// --- redrawPlan ---

const cardModel = (overrides) => model.instrumentsModel(inputs(overrides));

test('redrawPlan: no earlier model means rebuild; an identical model means none', () => {
  const now = cardModel({});
  assert.equal(model.redrawPlan(null, now), 'rebuild');
  assert.equal(model.redrawPlan(now, JSON.parse(JSON.stringify(now))), 'none');
});

test('redrawPlan: a changed port state or a changed In use line is live', () => {
  const rig = validRig(ALPHA, BETA);
  const before = cardModel({ rig });
  const unplugged = cardModel({ rig, states: { beta: { state: 'unplugged', matches: [] } } });
  assert.equal(model.redrawPlan(before, unplugged), 'live');
  const playing = cardModel({ rig, code: `lead: note("c3").midi('Port A', { midichannel: 3 })` });
  assert.equal(model.redrawPlan(before, playing), 'live');
  const notice = cardModel({ rig, access: 'idle', states: { alpha: { state: null, matches: [] }, beta: { state: null, matches: [] } } });
  assert.equal(model.redrawPlan(before, notice), 'live');
});

test('redrawPlan: a changed card set or order is a rebuild; one card whose declared facts changed is a replace', () => {
  const rig = validRig(ALPHA, BETA);
  const before = cardModel({ rig });
  const GAMMA = instrument({ id: 'gamma', port: 'Port C' });
  assert.equal(model.redrawPlan(before, cardModel({ rig: validRig(ALPHA, BETA, GAMMA) })), 'rebuild');
  assert.equal(model.redrawPlan(before, cardModel({ rig: validRig(BETA, ALPHA) })), 'rebuild');
  assert.equal(model.redrawPlan(before, cardModel({ rig: validRig(ALPHA) })), 'rebuild');
  assert.equal(model.redrawPlan(before, cardModel({ rig: validRig(instrument({ channels: [{ channel: 1, role: 'melodic' }] }), BETA) })), 'replace');
  assert.equal(model.redrawPlan(before, cardModel({ rig: validRig(instrument({ controls: CONTROLS.slice(0, 2) }), BETA) })), 'replace');
  assert.equal(model.redrawPlan(before, cardModel({ rig: validRig(instrument({ modelName: 'Other' }), BETA) })), 'replace');
  assert.equal(model.redrawPlan(before, cardModel({ rig: validRig(instrument({ catalogSounds: 3 }), BETA) })), 'replace');
  assert.equal(model.redrawPlan(before, cardModel({ rig: validRig(instrument({ clock: true }), BETA) })), 'replace', 'a Clock row appears');
  assert.equal(model.redrawPlan(before, cardModel({ rig: validRig(instrument({ port: 'Port Z' }), BETA) })), 'replace', 'another port');
  assert.equal(model.redrawPlan(before, cardModel({ rig: validRig(instrument({ clock: true }), instrument({ ...BETA, channels: SC55_CHANNELS.slice(0, 3) })) })), 'replace', 'two cards changed');
});

test('cardsToReplace: the indices of the cards whose declared facts changed, null when the card set or order differ', () => {
  const before = cardModel({ rig: validRig(ALPHA, BETA) });
  assert.deepEqual(model.cardsToReplace(before, cardModel({ rig: validRig(ALPHA, instrument({ ...BETA, clock: true })) })), [1]);
  assert.deepEqual(model.cardsToReplace(before, cardModel({ rig: validRig(instrument({ clock: true }), instrument({ ...BETA, clock: true })) })), [0, 1]);
  assert.deepEqual(model.cardsToReplace(before, cardModel({ rig: validRig(ALPHA, BETA) })), []);
  assert.equal(model.cardsToReplace(before, cardModel({ rig: validRig(BETA, ALPHA) })), null);
  assert.equal(model.cardsToReplace(before, cardModel({ rig: validRig(ALPHA) })), null);
  assert.equal(model.cardsToReplace(null, before), null);
  assert.equal(model.cardsToReplace(model.instrumentsModel(inputs({ connection: 'connecting' })), before), null);
});

test('redrawPlan: a change between a message and cards, or between two messages, is a rebuild', () => {
  const cards = cardModel({});
  const connecting = cardModel({ connection: 'connecting' });
  const absent = cardModel({ rig: { setup: 'absent' } });
  assert.equal(model.redrawPlan(connecting, cards), 'rebuild');
  assert.equal(model.redrawPlan(cards, connecting), 'rebuild');
  assert.equal(model.redrawPlan(connecting, absent), 'rebuild');
  assert.equal(model.redrawPlan(absent, JSON.parse(JSON.stringify(absent))), 'none');
});

// --- announcements ---

const kindsOf = (rig, states) => model.instrumentsModel(inputs({ rig, states }));

test('the first drawing announces nothing and returns the kinds that feed the next call', () => {
  const first = model.announcements(null, kindsOf(validRig(ALPHA), {}));
  assert.equal(first.text, '');
  assert.equal(first.kinds.get('alpha').kind, 'connected');
});

test('a change between not checked and a read state announces nothing', () => {
  const unchecked = kindsOf(validRig(ALPHA), { alpha: { state: null, matches: [] } });
  const connected = kindsOf(validRig(ALPHA), {});
  const start = model.announcements(null, unchecked);
  assert.equal(start.kinds.get('alpha').kind, null);
  const toConnected = model.announcements(start.kinds, connected);
  assert.equal(toConnected.text, '');
  assert.equal(toConnected.kinds.get('alpha').kind, 'connected');
  const back = model.announcements(toConnected.kinds, unchecked);
  assert.equal(back.text, '');
});

test('a change that keeps the state kind announces nothing', () => {
  const a = model.announcements(null, kindsOf(validRig(ALPHA), { alpha: { state: 'connected', matches: ['Port A'] } }));
  const b = model.announcements(a.kinds, kindsOf(validRig(ALPHA), { alpha: { state: 'connected', matches: ['Port A 2'] } }));
  assert.equal(b.text, '');
});

test('a kind change announces the id and the new state, and the kinds feed the next call', () => {
  const start = model.announcements(null, kindsOf(validRig(ALPHA), {}));
  const unplugged = model.announcements(start.kinds, kindsOf(validRig(ALPHA), { alpha: { state: 'unplugged', matches: [] } }));
  assert.equal(unplugged.text, 'alpha: unplugged');
  const back = model.announcements(unplugged.kinds, kindsOf(validRig(ALPHA), {}));
  assert.equal(back.text, 'alpha: connected');
  const notFound = model.announcements(back.kinds, kindsOf(validRig(ALPHA), { alpha: { state: 'not-found', matches: [] } }));
  assert.equal(notFound.text, 'alpha: not found');
  const ambiguous = model.announcements(notFound.kinds, kindsOf(validRig(ALPHA), { alpha: { state: 'ambiguous', matches: ['x', 'y'] } }));
  assert.equal(ambiguous.text, 'alpha: matches several outputs');
});

test('up to three announcements are joined with a space and more are cut with "and {count} more"', () => {
  const four = ['a1', 'a2', 'a3', 'a4'].map((id, index) => instrument({ id, port: `Port ${index}` }));
  const rig = validRig(...four);
  const start = model.announcements(null, kindsOf(rig, {}));
  const allDown = Object.fromEntries(four.map((entry) => [entry.id, { state: 'unplugged', matches: [] }]));
  const threeDown = Object.fromEntries(four.slice(0, 3).map((entry) => [entry.id, { state: 'unplugged', matches: [] }]));
  assert.equal(model.announcements(start.kinds, kindsOf(rig, threeDown)).text, 'a1: unplugged a2: unplugged a3: unplugged');
  assert.equal(model.announcements(start.kinds, kindsOf(rig, allDown)).text, 'a1: unplugged a2: unplugged a3: unplugged and 1 more');
});

test('a card that left the file announces nothing, and a message resets the memory', () => {
  const start = model.announcements(null, kindsOf(validRig(ALPHA, BETA), {}));
  const left = model.announcements(start.kinds, kindsOf(validRig(BETA), {}));
  assert.equal(left.text, '');
  assert.equal(left.kinds.has('alpha'), false);
  const message = model.announcements(start.kinds, cardModel({ connection: 'disconnected' }));
  assert.equal(message.text, '');
  assert.equal(message.kinds, null);
  const after = model.announcements(message.kinds, kindsOf(validRig(ALPHA), { alpha: { state: 'unplugged', matches: [] } }));
  assert.equal(after.text, '');
});

// --- The copy ---

test('every reused copy key the model reads exists, so a renamed key fails a test and not the page', () => {
  for (const key of [
    'popSetupInvalidLead',
    'popUnsupportedLead',
    'popDeniedLead',
    'popFailedLeadPlain',
    'popPendingLead',
    'rowNotUsed',
    'rowRigNotFound',
    'rowConnected',
    'rowConnectedAs',
    'rowUnplugged',
    'rowAmbiguous',
    'rowsMore',
    'dotConnected',
    'dotUnplugged',
    'dotNotFound',
    'dotAmbiguous',
    'takeoverText',
    'noActiveText',
    'takeBack',
  ]) {
    assert.equal(typeof MIDI_COPY[key], 'string', `MIDI_COPY.${key}`);
  }
  assert.equal(typeof BUILD_MISMATCH_COPY.line, 'string');
  for (const key of ['connecting', 'refused']) assert.equal(typeof CONNECTION_LABELS[key], 'string', `CONNECTION_LABELS.${key}`);
  assert.deepEqual(ACCESS_STATES, ['idle', 'pending', 'enabled', 'denied', 'unsupported', 'failed']);
});

test('every placeholder of a new INSTRUMENTS_COPY string is filled by the model (fill throws on a missing value)', () => {
  const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]);
  for (const [key, text] of Object.entries(model.INSTRUMENTS_COPY)) {
    assert.equal(typeof text, 'string', key);
    if (placeholders(text).length > 0) assert.throws(() => fill(text, {}), /^Error: Moontide:/, key);
  }
  // None of the strings the model produces still holds an unfilled placeholder.
  const rig = validRig(ALPHA, BETA);
  const results = [
    model.instrumentsModel(inputs({ rig, superseded: true })),
    model.instrumentsModel(inputs({ rig, code: `lead: note("c3").midi('Port A', { midichannel: 3 })`, states: { alpha: { state: null, matches: [] }, beta: { state: 'unplugged', matches: [] } } })),
    model.instrumentsModel(inputs({ rig: { setup: 'absent' }, dataFolder: FOLDER })),
  ];
  for (const result of results) assert.equal(/\{\w+\}/.test(JSON.stringify(result)), false);
});

test('MAX_PROBLEMS mirrors the rig message limit by hand', () => {
  assert.equal(model.MAX_PROBLEMS, RIG_LIMITS.problems);
});

test('INSTRUMENTS_COPY is frozen', () => {
  assert.equal(Object.isFrozen(model.INSTRUMENTS_COPY), true);
});

test('MAX_DATA_FOLDER_LENGTH mirrors the value in src/protocol.ts', () => {
  const protocolSource = readFileSync(fileURLToPath(new URL('../src/protocol.ts', import.meta.url)), 'utf8');
  const fromProtocol = /MAX_DATA_FOLDER_LENGTH = (\d+)/.exec(protocolSource);
  assert.ok(fromProtocol, 'src/protocol.ts declares MAX_DATA_FOLDER_LENGTH');
  assert.equal(model.MAX_DATA_FOLDER_LENGTH, Number(fromProtocol[1]));
  assert.equal(model.MAX_DATA_FOLDER_LENGTH, 1024);
});

test('readDataFolder keeps null, a valid folder and exactly 1024 units, and returns them unchanged', () => {
  assert.equal(model.readDataFolder(null), null);
  assert.equal(model.readDataFolder(FOLDER), FOLDER);
  const longest = 'f'.repeat(model.MAX_DATA_FOLDER_LENGTH);
  assert.equal(model.readDataFolder(longest), longest);
});

test('readDataFolder throws a named problem for a wrong value and never repeats the text', () => {
  const secret = 'SECRET_FOLDER_TEXT';
  const bad = [
    ['', /empty/],
    [42, /string or null/],
    [undefined, /string or null/],
    [{ path: secret }, /string or null/],
    ['f'.repeat(model.MAX_DATA_FOLDER_LENGTH + 1), /longer than 1024/],
    [`${secret}\u0007`, /control character/],
    [`${secret}\u2028`, /control character/],
    [`${secret}\u0085`, /control character/],
  ];
  for (const [value, problem] of bad) {
    assert.throws(
      () => model.readDataFolder(value),
      (err) => {
        assert.ok(err instanceof Error && err.message.startsWith('Moontide: the data folder the server sent'), err.message);
        assert.match(err.message, problem);
        assert.ok(!err.message.includes(secret), 'the message never holds the folder text');
        return true;
      },
      String(value).slice(0, 20),
    );
  }
});

// --- Drum kit row and Drum map line ---

const readShipped = (name) => JSON.parse(readFileSync(fileURLToPath(new URL(`../instruments/${name}.json`, import.meta.url)), 'utf8'));
const MT32_MODEL = readShipped('mt32');
const [GENERAL_MIDI] = BUILT_IN_DRUM_MAPS;

/** An MT-32-like instrument: the manual's one rhythm map, no kits. */
const MT32_DRUMS = instrument({ drumMap: 'mt32-rhythm', drumMaps: MT32_MODEL.drumMaps });

const cardOfInstrument = (id, code, rig) => model.instrumentsModel(inputs({ rig, code })).cards.find((card) => card.id === id);

test('an MT-32 rhythm track with no kit gives the not-chosen kit line and the manual map with 34 notes', () => {
  const code = `drums: note("36 38").midi('Port A', { midichannel: 10 })`;
  const card = cardOfInstrument('alpha', code, validRig(MT32_DRUMS));
  assert.deepEqual(card.drumKit, { lines: [{ text: 'not chosen by the code · ch 10', title: null, muted: true }] });
  assert.equal(card.drumMaps.length, 1);
  const [map] = card.drumMaps;
  assert.equal(map.kind, 'known');
  assert.equal(map.key, 'mt32-rhythm');
  assert.equal(map.summary, 'Drum map: Roland MT-32 Rhythm (34)');
  assert.equal(map.notes.length, 34);
  assert.deepEqual(map.notes[0], { note: '35', name: 'Acoustic Bass Drum' });
  assert.deepEqual(map.notes[33], { note: '75', name: 'Claves' });
});

test('an instrument with only melodic channels has neither the Drum kit row nor the Drum map line', () => {
  const melodic = instrument({ id: 'zeta', port: 'Port Z', channels: [{ channel: 1, role: 'melodic' }, { channel: 2, role: 'melodic' }] });
  const card = cardOfInstrument('zeta', `lead: note("c3").midi('Port Z', { midichannel: 1 })`, validRig(melodic));
  assert.equal(card.drumKit, null);
  assert.equal(card.drumMaps, null);
});

test('a model with no map and nothing in use says the instrument sentence, never a General MIDI guess', () => {
  const card = cardOfInstrument('alpha', '', validRig(instrument()));
  assert.deepEqual(card.drumMaps, [{ kind: 'unknown', key: 'unknown:', sub: 'No note map is known for this instrument, so notes show as numbers.' }]);
  assert.equal(GENERAL_MIDI.notes.length, 47);
});

const SC55_MODEL = readShipped('sc55');
const BANK_MODEL = bankDrumsModel();
const SC55_RHYTHM = { sounds: { melodic: [], rhythm: SC55_MODEL.sounds.rhythm }, drumMap: SC55_MODEL.drumMap, drumMaps: SC55_MODEL.drumMaps, bankSelect: 'msb' };
/** An SC-55-like instrument: the four GS and CM maps, kits Standard Set and Orchestra Set among others. */
const SC55_DRUMS = instrument({ id: 'beta', model: 'sc55', modelName: 'Roland SC-55', port: 'Port B', channels: SC55_CHANNELS, ...SC55_RHYTHM });
/** The same maps on two rhythm channels (10 and 11). */
const TWO_RHYTHM = instrument({
  id: 'beta',
  model: 'sc55',
  modelName: 'Roland SC-55',
  port: 'Port B',
  channels: [{ channel: 1, role: 'melodic' }, { channel: 10, role: 'rhythm' }, { channel: 11, role: 'rhythm' }],
  ...SC55_RHYTHM,
});
/** A bank-chosen drum part (the fixture of the drum kits) with the General MIDI map and one kit with no known map. */
const BANK_DRUMS = instrument({
  id: 'gamma',
  model: 'bankdrums',
  modelName: 'Bank Drum Synth',
  port: 'Port C',
  channels: [1, 2, 3, 4].map((channel) => ({ channel, role: 'melodic' })).concat([{ channel: 5, role: 'rhythm' }]),
  bankSelect: 'msb-lsb',
  rhythmBank: true,
  drumMap: 'general-midi',
  drumMaps: [GENERAL_MIDI],
  sounds: { melodic: [], rhythm: BANK_MODEL.sounds.rhythm },
});
/** A General MIDI instrument: no kits, the built-in map. */
const GM_DRUMS = instrument({ id: 'delta', port: 'Port D', channels: SC55_CHANNELS, drumMap: 'general-midi', drumMaps: [GENERAL_MIDI] });

const kitLines = (id, code, rig) => cardOfInstrument(id, code, rig).drumKit.lines;
const kit = (name, channel, port = 'Port B') => `drums: note("36*4").midi('${port}', { midichannel: ${channel}, sound: '${name}' })`;

test('Drum kit row: a kit written in any case is the rig kit, on a model with no rhythm bank its title is the program', () => {
  assert.deepEqual(kitLines('beta', kit('standard set', 10), validRig(SC55_DRUMS)), [{ text: 'Standard Set · ch 10', title: 'Standard Set: program 0', muted: false }]);
  assert.equal(kitLines('beta', kit('Room Set', 10), validRig(SC55_DRUMS))[0].title, 'Room Set: program 8');
});

test('Drum kit row: a model whose rhythm channels take a bank gives the bank in the title', () => {
  assert.deepEqual(kitLines('gamma', kit('Kit B', 5, 'Port C'), validRig(BANK_DRUMS)), [{ text: 'Kit B · ch 5', title: 'Kit B: bank 86/65, program 0', muted: false }]);
  assert.equal(kitLines('gamma', kit('Kit C', 5, 'Port C'), validRig(BANK_DRUMS))[0].title, 'Kit C: bank 86/65, program 3');
});

test('Drum kit row: two tracks on one channel give one line, two channels give two lines in ascending order', () => {
  const same = `a: note("36").midi('Port B', { midichannel: 10, sound: 'Standard Set' })\nb: note("38").midi('Port B', { midichannel: 10, sound: 'Standard Set' })`;
  assert.deepEqual(kitLines('beta', same, validRig(SC55_DRUMS)).map((line) => line.text), ['Standard Set · ch 10']);
  const two = `${kit('Room Set', 11)}\nb: note("38").midi('Port B', { midichannel: 10, sound: 'Standard Set' })`;
  assert.deepEqual(kitLines('beta', two, validRig(TWO_RHYTHM)).map((line) => line.text), ['Standard Set · ch 10', 'Room Set · ch 11']);
});

test('Drum kit row: a rhythm track with no sound reads "not chosen by the code", muted, with its channel', () => {
  const code = `drums: note("36").midi('Port B', { midichannel: 10 })`;
  assert.deepEqual(kitLines('beta', code, validRig(SC55_DRUMS)), [{ text: 'not chosen by the code · ch 10', title: null, muted: true }]);
});

test('Drum kit row: a kit the rig does not hold keeps the written name and says it is not in the catalog', () => {
  const lines = kitLines('beta', kit('Nope', 10), validRig(SC55_DRUMS));
  assert.deepEqual(lines, [{ text: 'Nope · ch 10', title: 'Nope: not in the catalog', muted: false }]);
});

test('Drum kit row: nothing in use, melodic channels only, a port named outside a track, code that does not parse', () => {
  const rig = validRig(SC55_DRUMS);
  const only = (code, overrides) => model.instrumentsModel(inputs({ rig, code, ...overrides })).cards[0].drumKit.lines;
  assert.deepEqual(only(''), [{ text: 'not used by the code', title: null, muted: true }]);
  assert.deepEqual(only(`lead: note("c3").midi('Port B', { midichannel: 3 })`), [{ text: 'not used by the code', title: null, muted: true }]);
  assert.deepEqual(only(`const a = note("c3").midi('Port B')\nlead: s("x")`), [{ text: 'used outside a track', title: null, muted: true }]);
  assert.deepEqual(only('drums: note("36").midi('), [{ text: "can't read the code", title: null, muted: true }]);
  assert.deepEqual(only(`drums: note("36").midi('Port B')`, { parse: null }), [{ text: "can't read the code", title: null, muted: true }]);
});

test('Drum map line: the model map for a kit of the model, the kit map "for {kit}" when it differs, the model map with no code', () => {
  const rig = validRig(SC55_DRUMS);
  const maps = (code) => cardOfInstrument('beta', code, rig).drumMaps;
  assert.deepEqual(maps(kit('Standard Set', 10)).map((map) => [map.kind, map.summary]), [['known', 'Drum map: Roland GS Standard (61)']]);
  assert.deepEqual(maps(kit('Orchestra Set', 10)).map((map) => [map.kind, map.summary]), [['known', 'Drum map: Roland GS Orchestra (62) for Orchestra Set']]);
  assert.deepEqual(maps('').map((map) => [map.kind, map.summary]), [['known', 'Drum map: Roland GS Standard (61)']]);
  assert.equal(maps(kit('Orchestra Set', 10))[0].key, 'gs-orchestra');
});

test('Drum map line: a kit with no known map says unknown with its name, and no code on a model with no map says the instrument', () => {
  const unknown = cardOfInstrument('gamma', kit('Kit C', 5, 'Port C'), validRig(BANK_DRUMS)).drumMaps;
  assert.deepEqual(unknown, [{ kind: 'unknown', key: 'unknown:Kit C', sub: 'No note map is known for Kit C, so notes show as numbers.' }]);
  const noMap = cardOfInstrument('alpha', '', validRig(instrument())).drumMaps;
  assert.deepEqual(noMap, [{ kind: 'unknown', key: 'unknown:', sub: 'No note map is known for this instrument, so notes show as numbers.' }]);
  const notHeld = cardOfInstrument('beta', kit('Nope', 10), validRig(SC55_DRUMS)).drumMaps;
  assert.deepEqual(notHeld, [{ kind: 'unknown', key: 'unknown:Nope', sub: 'No note map is known for Nope, so notes show as numbers.' }]);
});

test('Drum map line: a General MIDI model gives 47 notes in ascending order, each a number and a name', () => {
  const [map] = cardOfInstrument('delta', '', validRig(GM_DRUMS)).drumMaps;
  assert.equal(map.summary, 'Drum map: General MIDI (47)');
  assert.equal(map.notes.length, 47);
  assert.deepEqual(map.notes[0], { note: '35', name: 'Acoustic Bass Drum' });
  assert.deepEqual(map.notes[46], { note: '81', name: 'Open Triangle' });
  const numbers = map.notes.map((entry) => Number(entry.note));
  assert.deepEqual(numbers, [...numbers].sort((a, b) => a - b));
});

test('Drum map line: the notes come out ascending even when the map is written in another order', () => {
  const shuffled = { id: 'own', name: 'Own', notes: [{ note: 42, name: 'Third' }, { note: 36, name: 'First' }, { note: 38, name: 'Second' }] };
  const [map] = cardOfInstrument('alpha', '', validRig(instrument({ drumMap: 'own', drumMaps: [shuffled] }))).drumMaps;
  assert.deepEqual(map.notes.map((entry) => entry.note), ['36', '38', '42']);
});

test('Drum map line: two rhythm channels on kits with the same map give one line, with different maps two lines in channel order', () => {
  const rig = validRig(TWO_RHYTHM);
  const same = cardOfInstrument('beta', `${kit('Standard Set', 10)}\nb: note("38").midi('Port B', { midichannel: 11, sound: 'Room Set' })`, rig).drumMaps;
  assert.deepEqual(same.map((map) => map.key), ['gs-standard']);
  const differ = cardOfInstrument('beta', `${kit('Orchestra Set', 10)}\nb: note("38").midi('Port B', { midichannel: 11, sound: 'Standard Set' })`, rig).drumMaps;
  assert.deepEqual(differ.map((map) => map.summary), ['Drum map: Roland GS Orchestra (62) for Orchestra Set', 'Drum map: Roland GS Standard (61)']);
});

test('redrawPlan: a change of the kit in use is live, a change of the declared drum maps replaces that card', () => {
  const before = cardModel({ rig: validRig(SC55_DRUMS), code: kit('Standard Set', 10) });
  const orchestra = cardModel({ rig: validRig(SC55_DRUMS), code: kit('Orchestra Set', 10) });
  assert.equal(model.redrawPlan(before, orchestra), 'live');
  const withMaps = (maps, extra = {}) => cardModel({ rig: validRig(instrument({ ...SC55_RHYTHM, id: 'beta', port: 'Port B', channels: SC55_CHANNELS, ...extra, drumMaps: maps })), code: kit('Standard Set', 10) });
  const base = withMaps(SC55_MODEL.drumMaps);
  const fewerNotes = SC55_MODEL.drumMaps.map((map) => (map.id === 'gs-standard' ? { ...map, notes: map.notes.slice(1) } : map));
  assert.equal(model.redrawPlan(base, withMaps(fewerNotes)), 'replace');
  assert.equal(model.redrawPlan(base, withMaps(SC55_MODEL.drumMaps, { rhythmBank: true })), 'replace');
  assert.equal(model.redrawPlan(base, withMaps(SC55_MODEL.drumMaps, { drumMap: 'gs-orchestra' })), 'replace');
  const renamed = SC55_MODEL.drumMaps.map((map) => (map.id === 'gs-standard' ? { ...map, name: 'Other name' } : map));
  assert.equal(model.redrawPlan(base, withMaps(renamed)), 'replace');
  assert.equal(model.redrawPlan(base, withMaps(SC55_MODEL.drumMaps)), 'none');
});

test('every placeholder of the new Drum strings is filled in what the model produces', () => {
  const rig = validRig(SC55_DRUMS, BANK_DRUMS);
  for (const code of [kit('Orchestra Set', 10), kit('Nope', 10), kit('Kit C', 5, 'Port C'), '']) {
    assert.equal(/\{\w+\}/.test(JSON.stringify(model.instrumentsModel(inputs({ rig, code })))), false);
  }
});

// --- The switch ---

test('switchLook of a confirmed on and off instrument: checked flag, word, title and thumb', () => {
  assert.deepEqual(model.switchLook({ id: 'alpha', enabled: true, pending: null }), {
    checked: 'true',
    word: 'On',
    title: 'Switch alpha off',
    busy: false,
    thumb: 'on',
  });
  assert.deepEqual(model.switchLook({ id: 'alpha', enabled: false, pending: null }), {
    checked: 'false',
    word: 'Off',
    title: 'Switch alpha on',
    busy: false,
    thumb: 'off',
  });
});

test('switchLook while a request waits keeps the confirmed state and shows the target word', () => {
  const turningOff = model.switchLook({ id: 'alpha', enabled: true, pending: false });
  assert.deepEqual(turningOff, { checked: 'true', word: 'Turning off…', title: 'Switch alpha off', busy: true, thumb: 'pending' });
  const turningOn = model.switchLook({ id: 'alpha', enabled: false, pending: true });
  assert.deepEqual(turningOn, { checked: 'false', word: 'Turning on…', title: 'Switch alpha on', busy: true, thumb: 'pending' });
});

test('switchLook refuses a state it cannot read, loudly', () => {
  assert.throws(() => model.switchLook({ id: 'alpha', enabled: undefined, pending: null }), /Moontide: the switch of "alpha" needs enabled/);
  assert.throws(() => model.switchLook({ id: 'alpha', enabled: true, pending: 'yes' }), /needs pending/);
});

test('a card is enabled unless the rig says false, and the switch is a live fact, not a declared one', () => {
  const rig = validRig(ALPHA, { ...BETA, enabled: false });
  const cards = model.instrumentsModel(inputs({ rig })).cards;
  assert.deepEqual(cards.map((card) => card.enabled), [true, false]);
  const flipped = model.instrumentsModel(inputs({ rig: validRig(ALPHA, BETA) }));
  assert.equal(model.redrawPlan(model.instrumentsModel(inputs({ rig })), flipped), 'live', 'a switch changed elsewhere is updated in place');
});

test('readInstrumentResult reads an ok answer and a refusal with its reason', () => {
  assert.deepEqual(model.readInstrumentResult({ type: 'instrument-result', id: 'instrument-1', ok: true }), { id: 'instrument-1', ok: true });
  assert.deepEqual(
    model.readInstrumentResult({ type: 'instrument-result', id: 'instrument-2', ok: false, kind: 'refused', reason: 'this tab is not playing' }),
    { id: 'instrument-2', ok: false, kind: 'refused', reason: 'this tab is not playing', missing: null },
  );
});

test('a refusal without a reason is read with the missing field named, and an unreadable message throws naming the field', () => {
  assert.deepEqual(model.readInstrumentResult({ id: 'instrument-3', ok: false, kind: 'write-failed' }), {
    id: 'instrument-3',
    ok: false,
    kind: 'write-failed',
    reason: null,
    missing: 'reason',
  });
  assert.throws(() => model.readInstrumentResult({ ok: true }), /field id/);
  assert.throws(() => model.readInstrumentResult({ id: 'x', ok: 'yes' }), /field ok/);
  assert.throws(() => model.readInstrumentResult({ id: 'x', ok: false, kind: 'odd', reason: 'r' }), /field kind/);
});

test('the new INSTRUMENTS_COPY keys and the reused MIDI_COPY keys exist', () => {
  assert.equal(model.INSTRUMENTS_COPY.footer, 'Edits to instruments.json made by hand show after you reload this page. Changes made here show at once.');
  assert.equal(MIDI_COPY.rowSwitchedOff, 'switched off');
  assert.equal(fill(MIDI_COPY.dotSwitchedOff, { port: 'alpha' }), 'alpha: switched off');
});

// --- The off card, the refusal wording and the announcements ---

const OFF_ALPHA = { ...ALPHA, enabled: false };
const OFF_BETA = { ...BETA, enabled: false };

test('an off instrument has the crossed dot, the words switched off and no attention, whatever its live port state says', () => {
  for (const state of [{ state: 'connected', matches: ['Port A'] }, { state: 'unplugged', matches: [] }, { state: 'not-found', matches: [] }, { state: null, matches: [] }]) {
    const [card] = model.instrumentsModel(inputs({ rig: validRig(OFF_ALPHA), states: { alpha: state } })).cards;
    assert.equal(card.enabled, false);
    assert.deepEqual(card.port, {
      name: 'Port A',
      dot: { kind: 'off', title: 'alpha: switched off' },
      words: 'switched off',
      attention: false,
      stateKind: 'off',
    });
  }
});

test('an off instrument the playing code names starts its In use row with the muted line, then the usual lines', () => {
  const code = `lead: note("c3").midi('Port A', { midichannel: 3 })`;
  const [off] = model.instrumentsModel(inputs({ rig: validRig(OFF_ALPHA), code })).cards;
  assert.equal(off.inUse.lead, 'silent while switched off');
  assert.deepEqual(off.inUse.lines, ['lead · ch 3']);
  const [on] = model.instrumentsModel(inputs({ rig: validRig(ALPHA), code })).cards;
  assert.equal(on.inUse.lead, null);
});

test('an off instrument no track names says not used by the code and has no silent line', () => {
  for (const code of ['', `lead: note("c3").midi('Port B', { midichannel: 3 })`]) {
    const [card] = model.instrumentsModel(inputs({ rig: validRig(OFF_ALPHA, BETA), code })).cards;
    assert.equal(card.inUse.lead, null);
    assert.deepEqual(card.inUse.lines, ['not used by the code']);
  }
});

test('a change of enabled alone is a live redraw, and the off look keeps the card in its place', () => {
  const on = model.instrumentsModel(inputs({ rig: validRig(ALPHA, BETA) }));
  const off = model.instrumentsModel(inputs({ rig: validRig(ALPHA, OFF_BETA) }));
  assert.equal(model.redrawPlan(on, off), 'live');
  assert.deepEqual(off.cards.map((card) => card.id), ['alpha', 'beta']);
});

test('announcements speak a switch off and a switch on once, also when the port was not checked', () => {
  const start = model.announcements(null, kindsOf(validRig(ALPHA), {}));
  const off = model.announcements(start.kinds, kindsOf(validRig(OFF_ALPHA), {}));
  assert.equal(off.text, 'alpha: switched off');
  const on = model.announcements(off.kinds, kindsOf(validRig(ALPHA), {}));
  assert.equal(on.text, 'alpha: switched on');
  const unchecked = { alpha: { state: null, matches: [] } };
  const startUnchecked = model.announcements(null, kindsOf(validRig(OFF_ALPHA), unchecked));
  assert.equal(model.announcements(startUnchecked.kinds, kindsOf(validRig(ALPHA), unchecked)).text, 'alpha: switched on');
});

test('announcements say settings changed for a new port name, channels or clock of the same id, and nothing for an identical model', () => {
  const start = model.announcements(null, kindsOf(validRig(ALPHA), {}));
  assert.equal(model.announcements(start.kinds, kindsOf(validRig(ALPHA), {})).text, '');
  assert.equal(model.announcements(start.kinds, kindsOf(validRig(instrument({ port: 'Port Z' })), {})).text, 'alpha: settings changed');
  assert.equal(model.announcements(start.kinds, kindsOf(validRig(instrument({ channels: [{ channel: 1, role: 'melodic' }] })), {})).text, 'alpha: settings changed');
  assert.equal(model.announcements(start.kinds, kindsOf(validRig(instrument({ clock: true })), {})).text, 'alpha: settings changed');
});

test('four changes give three texts and "and 1 more", and an off card never speaks a port state', () => {
  const four = ['a1', 'a2', 'a3', 'a4'].map((id, index) => instrument({ id, port: `Port ${index}` }));
  const start = model.announcements(null, kindsOf(validRig(...four), {}));
  const allOff = validRig(...four.map((entry) => ({ ...entry, enabled: false })));
  assert.equal(model.announcements(start.kinds, kindsOf(allOff, {})).text, 'a1: switched off a2: switched off a3: switched off and 1 more');
  const offStart = model.announcements(null, kindsOf(validRig(OFF_ALPHA), {}));
  const stillOff = model.announcements(offStart.kinds, kindsOf(validRig(OFF_ALPHA), { alpha: { state: 'unplugged', matches: [] } }));
  assert.equal(stillOff.text, '');
});

test('switchRefusalText names the instrument, the target and the reason, or says the server did not confirm', () => {
  assert.equal(model.switchRefusalText({ id: 'alpha', target: false, outcome: { ok: false, kind: 'refused', reason: 'x' } }), 'Could not switch alpha off: x');
  assert.equal(model.switchRefusalText({ id: 'alpha', target: true, outcome: { ok: false, kind: 'write-failed', reason: 'the file is read-only' } }), 'Could not switch alpha on: the file is read-only');
  assert.equal(model.switchRefusalText({ id: 'alpha', target: false, outcome: { ok: false, kind: 'refused', reason: null } }), 'Could not switch alpha off: Moontide gave no reason.');
  assert.equal(model.switchRefusalText({ id: 'alpha', target: false, outcome: { kind: 'unconfirmed' } }), 'Moontide did not confirm — try again.');
  assert.equal(model.switchRefusalText({ id: 'alpha', target: false, outcome: { ok: false, kind: 'unconfirmed' } }), 'Moontide did not confirm — try again.');
  assert.equal(
    model.switchRefusalText({ id: 'alpha', target: false, outcome: { ok: false, kind: 'refused', reason: '<b>x</b>' } }),
    'Could not switch alpha off: <b>x</b>',
    'the reason is kept verbatim; the view sets it as text',
  );
});

test('readInstrumentResult reads an invalid answer with its problems, capped, and refuses a bad shape naming the field', () => {
  const problems = Array.from({ length: model.MAX_PROBLEMS + 3 }, (_, index) => ({ field: `instruments[${index}].port`, reason: `reason ${index}` }));
  const read = model.readInstrumentResult({ id: 'instrument-4', ok: false, kind: 'invalid', problems, more: 2 });
  assert.equal(read.kind, 'invalid');
  assert.equal(read.problems.length, model.MAX_PROBLEMS);
  assert.equal(read.more, 5);
  assert.throws(() => model.readInstrumentResult({ id: 'x', ok: false, kind: 'invalid', problems: 'no', more: 0 }), /field problems/);
  assert.throws(() => model.readInstrumentResult({ id: 'x', ok: false, kind: 'invalid', problems: [], more: -1 }), /field more/);
});

// --- The settings editor ---

/** The first (only) card of a cards model for these inputs. */
const cardOf = (overrides) => model.instrumentsModel(inputs(overrides)).cards[0];
const OPEN_PORTS = (outputs) => ({ outputs, access: 'enabled', supported: true });
const draftOf = (card, changes = {}) => ({ port: card.settings.port, channels: [...card.settings.channels], clock: card.settings.clock, ...changes });

test('a card carries its settings, every channel of its model and the channels the code uses', () => {
  const partial = instrument({ channels: MT32_CHANNELS.filter((entry) => entry.channel !== 3), modelChannels: MT32_CHANNELS, clock: true });
  const card = cardOf({ rig: validRig(partial) });
  assert.deepEqual(card.settings, { port: 'Port A', channels: [2, 4, 5, 6, 7, 8, 9, 10], clock: true });
  assert.deepEqual(card.modelChannels.map((entry) => entry.channel), [2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(card.modelChannels[8], { channel: 10, role: 'rhythm' });
  assert.deepEqual(card.usedChannels, []);
});

test('usedChannels lists the channels of this instrument that the playing code uses, ascending, once each', () => {
  const code = [`lead: note("c3").midi('Port A', { midichannel: 4 })`, `pad: note("e3").midi('Port A', { midichannel: 2 })`, `echo: note("g3").midi('Port A', { midichannel: 4 })`].join('\n');
  const card = cardOf({ code });
  assert.deepEqual(card.usedChannels, [2, 4]);
});

test('a rig instrument without modelChannels throws, loudly', () => {
  const broken = { ...ALPHA };
  delete broken.modelChannels;
  assert.throws(() => model.instrumentsModel(inputs({ rig: validRig(broken) })), /no modelChannels/);
});

test('outputs must be a list of names, and a cards model carries the ports of the moment', () => {
  assert.throws(() => model.instrumentsModel(inputs({ outputs: undefined })), /outputs to be a list of port names/);
  assert.throws(() => model.instrumentsModel(inputs({ outputs: [1] })), /outputs to be a list of port names/);
  const cards = model.instrumentsModel(inputs({ outputs: ['Port A', 'Port B'], access: 'idle', supported: true }));
  assert.deepEqual(cards.ports, { outputs: ['Port A', 'Port B'], access: 'idle', supported: true });
});

test('the editor offers the detected outputs in the browser order, the current port selected', () => {
  const card = cardOf({});
  const editor = model.editorModel({ card, ports: OPEN_PORTS(['Port B', 'Port A']), draft: draftOf(card) });
  assert.deepEqual(editor.ports, [
    { value: 'Port B', text: 'Port B', selected: false },
    { value: 'Port A', text: 'Port A', selected: true },
  ]);
  assert.equal(editor.portTitle, 'Port A');
  assert.equal(editor.name, 'Settings of alpha');
});

test('a current port no output contains is the first option, "(not detected)", and selected', () => {
  const card = cardOf({ rig: validRig(instrument({ port: 'Port Z' })) });
  const editor = model.editorModel({ card, ports: OPEN_PORTS(['Port A', 'Port B']), draft: draftOf(card) });
  assert.deepEqual(editor.ports[0], { value: 'Port Z', text: 'Port Z (not detected)', selected: true });
  assert.deepEqual(editor.ports.slice(1).map((option) => option.value), ['Port A', 'Port B']);
});

test('a current port that an output contains but none equals is the first option with its own text, selected', () => {
  const card = cardOf({ rig: validRig(instrument({ port: 'Port' })) });
  const editor = model.editorModel({ card, ports: OPEN_PORTS(['Port B']), draft: draftOf(card) });
  assert.deepEqual(editor.ports[0], { value: 'Port', text: 'Port', selected: true });
  assert.deepEqual(editor.ports[1], { value: 'Port B', text: 'Port B', selected: false });
});

test('choosing a detected output puts its full name in the draft and selects it', () => {
  const card = cardOf({});
  const editor = model.editorModel({ card, ports: OPEN_PORTS(['Port A', 'Port B']), draft: draftOf(card, { port: 'Port B' }) });
  assert.deepEqual(editor.ports.map((option) => option.selected), [false, true]);
  assert.equal(editor.portTitle, 'Port B');
});

test('with Web MIDI not on the select holds the current port only', () => {
  const card = cardOf({});
  for (const access of ['idle', 'pending', 'denied', 'failed', 'unsupported']) {
    const editor = model.editorModel({ card, ports: { outputs: ['Port B'], access, supported: true }, draft: draftOf(card) });
    assert.deepEqual(editor.ports, [{ value: 'Port A', text: 'Port A', selected: true }], access);
  }
  const noWebMidi = model.editorModel({ card, ports: { outputs: [], access: 'idle', supported: false }, draft: draftOf(card) });
  assert.deepEqual(noWebMidi.ports, [{ value: 'Port A', text: 'Port A', selected: true }]);
});

test('60 outputs are 60 options in order, and a name holding "<" stays text', () => {
  const card = cardOf({});
  const outputs = Array.from({ length: 60 }, (_, index) => (index === 7 ? 'Out <b>7</b>' : `Out ${index}`));
  const editor = model.editorModel({ card, ports: OPEN_PORTS(outputs), draft: draftOf(card) });
  assert.equal(editor.ports.length, 61, 'the current port is not among them, so it comes first');
  assert.deepEqual(editor.ports.slice(1).map((option) => option.text), outputs);
  assert.equal(editor.ports[8].value, 'Out <b>7</b>');
});

test('one chip per channel of the model, ascending, a rhythm channel says so, checked follows the draft', () => {
  const card = cardOf({});
  const editor = model.editorModel({ card, ports: OPEN_PORTS([]), draft: draftOf(card, { channels: [2, 10] }) });
  assert.deepEqual(editor.chips.map((chip) => chip.text), ['2', '3', '4', '5', '6', '7', '8', '9', '10 rhythm']);
  assert.deepEqual(editor.chips.filter((chip) => chip.checked).map((chip) => chip.channel), [2, 10]);
  const one = cardOf({ rig: validRig(instrument({ channels: [{ channel: 5, role: 'melodic' }] })) });
  assert.equal(model.editorModel({ card: one, ports: OPEN_PORTS([]), draft: draftOf(one) }).chips.length, 1);
  const sixteen = instrument({ channels: SC55_CHANNELS });
  const wide = cardOf({ rig: validRig(sixteen) });
  const chips = model.editorModel({ card: wide, ports: OPEN_PORTS([]), draft: draftOf(wide) }).chips;
  assert.equal(chips.length, 16);
  assert.deepEqual(chips.map((chip) => chip.channel), [...chips.map((chip) => chip.channel)].sort((a, b) => a - b));
});

test('Save has something to send only when the draft differs from the card (channel order ignored)', () => {
  const card = cardOf({});
  const can = (changes) => model.editorModel({ card, ports: OPEN_PORTS(['Port A']), draft: draftOf(card, changes) }).canSave;
  assert.equal(can({}), false);
  assert.equal(can({ channels: [...card.settings.channels].reverse() }), false);
  assert.equal(can({ port: 'Port B' }), true);
  assert.equal(can({ clock: true }), true);
  assert.equal(can({ channels: [2, 3] }), true);
  assert.equal(can({ channels: [] }), true, 'an empty set is sent as is: the server gives the reason');
});

test('refusalRows labels the last segment of the field, in the server order, and names the fields', () => {
  const result = model.refusalRows({
    problems: [
      { field: 'instruments[1].channels[0]', reason: 'channel 17 is not a channel of model sc55' },
      { field: 'instruments[1].port', reason: 'same port as instruments[0] ("sc55")' },
      { field: 'instruments[1].clock', reason: 'must be true or false' },
    ],
    more: 0,
  });
  assert.deepEqual(result.rows, [
    { label: 'Channels', field: null, reason: 'channel 17 is not a channel of model sc55' },
    { label: 'Port', field: null, reason: 'same port as instruments[0] ("sc55")' },
    { label: 'Clock', field: null, reason: 'must be true or false' },
  ]);
  assert.deepEqual(result.invalid, ['channels', 'port', 'clock']);
  assert.equal(result.more, null);
});

test('a field the page does not map comes back raw, and more than 5 rows are cut with a count', () => {
  const raw = model.refusalRows({ problems: [{ field: 'instruments-state.json:off[0]', reason: 'unknown id' }], more: 0 });
  assert.deepEqual(raw.rows, [{ label: null, field: 'instruments-state.json:off[0]', reason: 'unknown id' }]);
  assert.deepEqual(raw.invalid, []);
  const many = model.refusalRows({ problems: Array.from({ length: 7 }, (_, index) => ({ field: 'instruments[0].channels[0]', reason: `reason ${index}` })), more: 2 });
  assert.equal(many.rows.length, 5);
  assert.equal(many.more, 'and 4 more');
  assert.deepEqual(many.invalid, ['channels']);
});

// --- The hints, the warnings, the failures ---

test('the port hint says why the list holds one port, or that no output is connected', () => {
  const card = cardOf({});
  const hint = (ports) => model.editorModel({ card, ports, draft: draftOf(card) }).portHint;
  for (const access of ['idle', 'pending', 'denied', 'failed', 'unsupported']) {
    assert.equal(hint({ outputs: [], access, supported: true }), 'Detected ports show once MIDI is on in this page.', access);
  }
  assert.equal(hint({ outputs: [], access: 'idle', supported: false }), 'Detected ports show once MIDI is on in this page.', 'no Web MIDI at all');
  assert.equal(hint(OPEN_PORTS([])), MIDI_COPY.outputsNone);
  assert.equal(hint(OPEN_PORTS([])), 'No MIDI outputs are connected.');
  assert.equal(hint(OPEN_PORTS(['Port A'])), null);
  const none = model.editorModel({ card, ports: OPEN_PORTS([]), draft: draftOf(card) });
  assert.deepEqual(none.ports, [{ value: 'Port A', text: 'Port A (not detected)', selected: true }]);
});

test('unchecking a channel the playing code uses warns, in the singular and the plural, and follows the draft', () => {
  const code = [`lead: note("c3").midi('Port A', { midichannel: 3 })`, `pad: note("e3").midi('Port A', { midichannel: 4 })`].join('\n');
  const card = cardOf({ code });
  assert.deepEqual(card.usedChannels, [3, 4]);
  const warning = (channels) => model.editorModel({ card, ports: OPEN_PORTS(['Port A']), draft: draftOf(card, { channels }) }).warning;
  assert.equal(warning([2, 4, 5, 6, 7, 8, 9, 10]), 'ch 3 is used by the code and goes silent after you save.');
  assert.equal(warning([2, 5, 6, 7, 8, 9, 10]), 'ch 3, 4 are used by the code and go silent after you save.');
  assert.equal(warning([2, 3, 4, 6, 7, 8, 9, 10]), null, 'an unused channel (5) says nothing');
  assert.equal(warning(card.settings.channels), null);
});

test('the warning is built from the real code through readMidiTracks, and a muted track still counts', () => {
  const code = `lead: note("c3").midi('Port A', { midichannel: 5 })\n_pad: note("c2").midi('Port A', { midichannel: 6 })`;
  const rig = validRig(ALPHA);
  const read = readMidiTracks(code, { parse, rig });
  assert.equal(read.ok, true);
  const card = cardOf({ code });
  assert.deepEqual(card.usedChannels, [5, 6]);
});

test('writeFailedText wraps the server reason, and says so when it sent none', () => {
  assert.equal(
    model.writeFailedText('the file system answered EISDIR'),
    'Nothing was saved. instruments.json could not be written: the file system answered EISDIR',
  );
  assert.equal(model.writeFailedText(''), 'Nothing was saved. instruments.json could not be written: Moontide gave no reason.');
});

test('every ending of a settings request is a list of rows for the editor', () => {
  const invalid = model.editorFailure({ ok: false, kind: 'invalid', problems: [{ field: 'instruments[0].port', reason: 'same port' }], more: 0 });
  assert.deepEqual(invalid.rows, [{ label: 'Port', field: null, reason: 'same port' }]);
  assert.deepEqual(invalid.invalid, ['port']);
  const written = model.editorFailure({ ok: false, kind: 'write-failed', reason: 'the file system answered EISDIR' });
  assert.deepEqual(written.rows, [{ label: null, field: null, reason: 'Nothing was saved. instruments.json could not be written: the file system answered EISDIR' }]);
  assert.deepEqual(written.invalid, []);
  const refused = model.editorFailure({ ok: false, kind: 'refused', reason: 'this tab is not playing' });
  assert.deepEqual(refused.rows, [{ label: null, field: null, reason: 'this tab is not playing' }]);
  const silent = model.editorFailure({ ok: false, kind: 'refused', reason: null });
  assert.equal(silent.rows[0].reason, 'Moontide gave no reason.');
  const unconfirmed = model.editorFailure({ ok: false, kind: 'unconfirmed' });
  assert.deepEqual(unconfirmed.rows, [{ label: null, field: null, reason: 'Moontide did not confirm — try again.' }]);
  assert.throws(() => model.editorFailure({ ok: false, kind: 'odd' }), /cannot end as/);
});

test('the editor copy keys exist, and each placeholder is filled by the code that uses it', () => {
  const copy = model.INSTRUMENTS_COPY;
  assert.equal(copy.editSettings, 'Edit settings');
  assert.equal(fill(copy.editSettingsLabel, { id: 'alpha' }), 'Edit settings, alpha');
  assert.equal(fill(copy.editorName, { id: 'alpha' }), 'Settings of alpha');
  assert.equal(fill(copy.portNotDetected, { port: 'P' }), 'P (not detected)');
  assert.equal(fill(copy.chipRhythm, { n: 10 }), '10 rhythm');
  assert.equal(copy.clockLabel, 'Follows the clock');
  assert.equal(copy.changedElsewhere, 'This instrument changed on another page. Saving replaces those values.');
  assert.throws(() => fill(copy.portNotDetected, {}), /port/);
  for (const key of ['labelPort', 'labelChannels', 'labelClock']) assert.ok(copy[key].length > 0);
  for (const key of ['outputsNone', 'rowSeparator', 'rowsMore', 'takeBackFailed']) assert.ok(MIDI_COPY[key].length > 0);
});
