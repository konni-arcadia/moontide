import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  startMcpClient,
  createFakePage,
  withoutArmingLine,
  connectPage,
  authenticatePage,
  authenticatePageWithRig,
  onEveryMessage,
  nextMessage,
} from './helpers.js';
import { MIDI_PERMISSION_WAIT_MESSAGE } from '../dist/midi-state.js';
import { checkSetup, parseRigMessage } from '../page/midi-rig.js';
import { readMidiSetup } from '../page/midi-plan.js';
import { parse } from 'acorn';
import { bankDrumsModel } from './drum-fixtures.js';

// End to end for the MIDI notices: a fake page sends facts, the real server words them,
// and the assertions read what Claude reads in the tool reply.

/** A channel range as the server prints it, for example 1-9. */
function channelRange(low, high) {
  return `${low}-${high}`;
}

/** Waits a short tick so an unsolicited page frame has time to arrive before a tool call. */
function tick(ms = 50) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A complete midi-state message; the overrides replace any field. */
function midiState(overrides = {}) {
  return {
    type: 'midi-state',
    access: 'enabled',
    failure: null,
    usesMidi: true,
    triedMidi: true,
    outputs: ['Fake Synth A', 'Fake Synth B'],
    ports: [],
    noPort: null,
    unreadable: false,
    hidden: false,
    playing: true,
    ...overrides,
  };
}

function midiLines(text) {
  return text.split('\n').filter((line) => line.startsWith('MIDI:'));
}

test('MIDI notices reach Claude through the real server', async (t) => {
  const { client, port } = await startMcpClient();
  const fakePages = [];
  t.after(async () => {
    for (const page of fakePages) {
      page.ws.close();
    }
    await client.close();
  });

  await t.test('(a) an ambiguous port is named with every match once, and the next reply repeats nothing', async () => {
    const page = await createFakePage(port);
    fakePages.push(page);
    page.setResponder((msg) => [
      midiState({ ports: [{ name: 'Fake Synth', state: 'ambiguous', matches: ['Fake Synth A', 'Fake Synth B'] }] }),
      { type: 'evaluated', id: msg.id, ok: true, code: msg.code, audio: 'playing' },
    ]);

    const result = await client.callTool({ name: 'set_code', arguments: { code: `note("c3").midi('Fake Synth')` } });
    assert.ok(!result.isError);
    const text = withoutArmingLine(result.content[0].text);
    assert.ok(text.startsWith('ok, playing'), text);
    assert.ok(
      text.includes(
        'MIDI: port name "Fake Synth" matches several outputs: "Fake Synth A", "Fake Synth B". ' +
          'Strudel sends to the first one, "Fake Synth A".',
      ),
      text,
    );

    const next = await client.callTool({ name: 'get_code', arguments: {} });
    assert.deepEqual(midiLines(next.content[0].text), []);
  });

  await t.test('(b) the facts of a page that is not the active page are ignored', async () => {
    const second = await createFakePage(port);
    fakePages.push(second);
    await tick();
    fakePages[0].send(
      midiState({ ports: [{ name: 'Other', state: 'not-found', matches: [] }] }),
    );
    await tick();
    const result = await client.callTool({ name: 'get_code', arguments: {} });
    assert.deepEqual(midiLines(result.content[0].text), []);
  });

  // Last: it leaves a request pending until the reply budget runs out.
  await t.test('(c) a reply that times out while the page waits for the MIDI prompt says so', async () => {
    const active = fakePages[1];
    active.setResponder(() => [midiState({ usesMidi: false, triedMidi: true, access: 'pending' })]);

    const result = await client.callTool({ name: 'set_code', arguments: { code: `note("c3").midi('Fake Synth A')` } });
    assert.ok(result.isError);
    assert.ok(withoutArmingLine(result.content[0].text).startsWith(MIDI_PERMISSION_WAIT_MESSAGE), result.content[0].text);
  });
});

/** A fake page that records every frame after its hello and answers evaluate with a success. */
async function recordingPage(port) {
  const ws = await connectPage(port);
  const hello = await authenticatePage(ws, port);
  const frames = [];
  onEveryMessage(ws, (msg) => {
    frames.push(msg);
    if (msg.type === 'evaluate') {
      ws.send(JSON.stringify({ type: 'evaluated', id: msg.id, ok: true, code: msg.code, audio: 'playing' }));
    }
  });
  return { ws, hello, frames };
}

test('a superseded page takes the role back with take-over and the other page is superseded in turn', async (t) => {
  const { client, port } = await startMcpClient();
  const pages = [];
  t.after(async () => {
    for (const page of pages) page.ws.close();
    await client.close();
  });

  const one = await recordingPage(port);
  pages.push(one);
  const first = await client.callTool({ name: 'set_code', arguments: { code: 's("bd")' } });
  assert.ok(!first.isError, first.content[0].text);

  const two = await recordingPage(port);
  pages.push(two);
  assert.deepEqual(two.hello, { type: 'hello', code: 's("bd")', stopped: false });
  await tick();
  assert.deepEqual(
    one.frames.filter((frame) => frame.type === 'superseded'),
    [{ type: 'superseded' }],
    'page 1 is told once that another page took the role',
  );
  one.frames.length = 0;
  two.frames.length = 0;

  one.ws.send(JSON.stringify({ type: 'take-over' }));
  await tick(150);
  assert.deepEqual(two.frames.filter((frame) => frame.type === 'superseded'), [{ type: 'superseded' }]);
  const hello = one.frames.find((frame) => frame.type === 'hello');
  assert.deepEqual(hello, { type: 'hello', code: 's("bd")', stopped: false });

  const second = await client.callTool({ name: 'set_code', arguments: { code: 's("hh*2")' } });
  assert.ok(!second.isError, second.content[0].text);
  assert.ok(one.frames.some((frame) => frame.type === 'evaluate' && frame.code === 's("hh*2")'), 'page 1 answers set_code again');
  assert.ok(!two.frames.some((frame) => frame.type === 'evaluate'), 'page 2 no longer receives evaluate');
});

test('when the active page closes, a superseded page is told that no tab plays, and it can take the role', async (t) => {
  const { client, port } = await startMcpClient();
  const pages = [];
  t.after(async () => {
    for (const page of pages) page.ws.close();
    await client.close();
  });

  const one = await recordingPage(port);
  pages.push(one);
  const two = await recordingPage(port);
  pages.push(two);
  await tick();
  one.frames.length = 0;

  two.ws.close();
  await tick(150);
  assert.deepEqual(one.frames.filter((frame) => frame.type === 'no-active-page'), [{ type: 'no-active-page' }]);

  one.ws.send(JSON.stringify({ type: 'take-over' }));
  await tick(150);
  assert.ok(one.frames.some((frame) => frame.type === 'hello'), 'the superseded page takes the role when nobody plays');
  const reply = await client.callTool({ name: 'set_code', arguments: { code: 's("bd")' } });
  assert.ok(!reply.isError, reply.content[0].text);
});

// The setup file in the data folder reaches the page before hello, and Claude hears its state.

const MT32_RESET = [0xf0, 0x41, 0x10, 0x16, 0x12, 0x7f, 0x00, 0x00, 0x00, 0x01, 0xf7];
const INVALID_FILE_LINE =
  'MIDI: instruments.json is invalid: instruments[0].port: required. No instruments are set up until it is fixed.';

function writeRig(dataDir, value) {
  fs.writeFileSync(path.join(dataDir, 'instruments.json'), typeof value === 'string' ? value : JSON.stringify(value));
}

test('a page that authenticates while a valid instruments.json exists gets the rig before hello', async (t) => {
  const { client, port, dataDir } = await startMcpClient();
  const sockets = [];
  t.after(async () => {
    for (const ws of sockets) ws.close();
    await client.close();
  });
  writeRig(dataDir, { instruments: [{ id: 'mt32', model: 'mt32', port: 'Fake Synth A' }] });

  const ws = await connectPage(port);
  sockets.push(ws);
  const { rig, hello } = await authenticatePageWithRig(ws, port);
  assert.ok(rig, 'a midi-rig frame arrives before hello');
  assert.equal(rig.type, 'midi-rig');
  assert.equal(rig.setup, 'valid');
  assert.equal(rig.instruments.length, 1);
  const [first] = rig.instruments;
  assert.equal(first.id, 'mt32');
  assert.equal(first.port, 'Fake Synth A');
  assert.deepEqual(first.reset.messages, [MT32_RESET]);
  assert.equal(hello.type, 'hello');
});

test('an invalid instruments.json gives an invalid rig frame with its problems', async (t) => {
  const { client, port, dataDir } = await startMcpClient();
  const sockets = [];
  t.after(async () => {
    for (const ws of sockets) ws.close();
    await client.close();
  });
  writeRig(dataDir, { instruments: [{ id: 'mt32', model: 'mt32' }] });

  const ws = await connectPage(port);
  sockets.push(ws);
  const { rig } = await authenticatePageWithRig(ws, port);
  assert.deepEqual(rig, {
    type: 'midi-rig',
    setup: 'invalid',
    problems: [{ field: 'instruments[0].port', reason: 'required' }],
    more: 0,
  });
});

test('with no instruments.json hello follows ask-auth directly', async (t) => {
  const { client, port } = await startMcpClient();
  const sockets = [];
  t.after(async () => {
    for (const ws of sockets) ws.close();
    await client.close();
  });
  const ws = await connectPage(port);
  sockets.push(ws);
  const hello = await authenticatePage(ws, port);
  assert.equal(hello.type, 'hello');
});

test('set_code with an invalid instruments.json carries the notice once and the next reply does not', async (t) => {
  const { client, port, dataDir } = await startMcpClient();
  const pages = [];
  t.after(async () => {
    for (const page of pages) page.ws.close();
    await client.close();
  });
  writeRig(dataDir, { instruments: [{ id: 'mt32', model: 'mt32' }] });
  const page = await createFakePage(port, { rig: true });
  pages.push(page);
  assert.equal(page.rig.setup, 'invalid');
  page.setResponder((msg) => ({ type: 'evaluated', id: msg.id, ok: true, code: msg.code, audio: 'playing' }));

  const first = await client.callTool({ name: 'set_code', arguments: { code: 's("bd").gain(0)' } });
  assert.ok(!first.isError, first.content[0].text);
  assert.deepEqual(midiLines(first.content[0].text), [INVALID_FILE_LINE]);

  const next = await client.callTool({ name: 'get_code', arguments: {} });
  assert.deepEqual(midiLines(next.content[0].text), []);
});

// get_midi_instruments tells Claude the user's instruments as facts. The replies hold sound
// names (API facts), so they are not tint-scanned; everything runs on a temp data folder and a fake page.

// The page-requests arming line, when a page is attached, is the last paragraph of a reply: it is not part of the facts.
const replyText = (reply) => reply.content[0].text.split('\n\nPage requests:')[0];

// A catalog in the data folder rides in the midi-rig message at full size, and the search finds its sounds.

/** A catalog of `count` generated sounds with made-up names, as the catalog file holds it. */
function generatedCatalog(model, count) {
  return {
    model,
    source: 'e2e fixture',
    sounds: Array.from({ length: count }, (_, i) => ({
      name: `Catalog Tone ${String(i + 1).padStart(4, '0')}`,
      category: `Group ${String(Math.floor(i / 100) + 1).padStart(2, '0')}`,
      program: i % 128,
      bank: { msb: Math.floor(i / 128) },
    })),
  };
}

function writeCatalog(dataDir, id, value) {
  fs.mkdirSync(path.join(dataDir, 'catalogs'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'catalogs', `${id}.json`), typeof value === 'string' ? value : JSON.stringify(value));
}

test('a catalog in the data folder reaches the page in the rig, and search_midi_sounds finds its sounds', async (t) => {
  const { client, port, dataDir } = await startMcpClient();
  const pages = [];
  t.after(async () => {
    for (const page of pages) page.ws.close();
    await client.close();
  });
  writeRig(dataDir, { instruments: [{ id: 'sc55', model: 'sc55', port: 'Fake Synth B' }] });
  writeCatalog(dataDir, 'sc55', generatedCatalog('sc55', 5000));
  const page = await createFakePage(port, { rig: true });
  pages.push(page);

  await t.test('the frame holds the model sounds then the 5,000 catalog sounds, and the page reader accepts it', () => {
    assert.ok(page.rig, 'a midi-rig frame arrives before hello');
    const [first] = page.rig.instruments;
    assert.equal(first.catalogSounds, 5000);
    assert.equal(first.sounds.melodic.length, 128 + 5000);
    assert.deepEqual(first.sounds.melodic[128], { name: 'Catalog Tone 0001', program: 0, bank: { msb: 0 } });
    assert.equal(first.sounds.rhythm.length, 10);
    assert.ok(!JSON.stringify(first.sounds.melodic).includes('category'), 'the category stays on the server');
    assert.equal(parseRigMessage(page.rig).instruments[0].catalogSounds, 5000);
  });

  await t.test('search_midi_sounds finds a sound by words in any order, and caps a wide search at 25', async () => {
    const found = await client.callTool({ name: 'search_midi_sounds', arguments: { instrument: 'sc55', query: '0042 tone catalog' } });
    assert.ok(!found.isError, replyText(found));
    assert.ok(replyText(found).split('\n').includes('- "Catalog Tone 0042": program 41, bank 0, category "Group 01"'), replyText(found));
    const wide = await client.callTool({ name: 'search_midi_sounds', arguments: { instrument: 'sc55', query: 'catalog tone' } });
    const lines = replyText(wide).split('\n');
    assert.equal(lines.filter((line) => line.startsWith('- ')).length, 25);
    assert.ok(lines.includes('4975 more, refine your search.'), replyText(wide));
  });
});


test('search_midi_sounds and get_midi_instruments over a catalog through the real server', async (t) => {
  const { client, port, dataDir } = await startMcpClient();
  const pages = [];
  t.after(async () => {
    for (const page of pages) page.ws.close();
    await client.close();
  });
  writeRig(dataDir, {
    instruments: [
      { id: 'sc55', model: 'sc55', port: 'Fake Synth B' },
      { id: 'mt32', model: 'mt32', port: 'Fake Synth A' },
    ],
  });
  writeCatalog(dataDir, 'sc55', {
    model: 'sc55',
    source: 'e2e fixture',
    sounds: [
      { name: 'Glass Bell', program: 1 },
      { name: 'Bell', program: 2, category: 'Group A' },
      { name: "Dan's Bell", program: 3, category: 'Group B', bank: { msb: 8 } },
    ],
  });
  pages.push(await createFakePage(port, { rig: true }));
  const search = (args) => client.callTool({ name: 'search_midi_sounds', arguments: { instrument: 'sc55', ...args } });

  await t.test('words rank the exact name first and the quote line follows a name with a single quote', async () => {
    const lines = replyText(await search({ query: 'bell' })).split('\n');
    assert.deepEqual(lines.slice(1), [
      '3 matches:',
      '- "Bell": program 2, category "Group A"',
      '- "Glass Bell": program 1',
      '- "Dan\'s Bell": program 3, bank 8, category "Group B"',
      "A name with ' or \\ takes a backslash before that character inside the single quotes of the code.",
    ]);
  });

  await t.test('a category filters, and an unknown one is a tool error that lists the categories', async () => {
    const filtered = replyText(await search({ category: 'group a' }));
    assert.ok(filtered.includes('1 match:') && filtered.includes('- "Bell": program 2'), filtered);
    const unknown = await search({ query: 'bell', category: 'Group Z' });
    assert.equal(unknown.isError, true);
    assert.equal(replyText(unknown), 'Unknown category "Group Z" in the catalog of "sc55". Categories: "Group A" (1), "Group B" (1).');
  });

  await t.test('nothing to search for, no match, an unknown instrument and an instrument with no catalog', async () => {
    const empty = await search({ query: '  ' });
    assert.equal(empty.isError, true);
    assert.ok(replyText(empty).startsWith('Nothing to search for:'), replyText(empty));
    assert.ok(replyText(await search({ query: 'zzz' })).includes('No sound matches.\nCategories: "Group A" (1), "Group B" (1).'));
    const unknown = await client.callTool({ name: 'search_midi_sounds', arguments: { instrument: 'nope', query: 'bell' } });
    assert.equal(unknown.isError, true);
    assert.equal(replyText(unknown), 'Unknown instrument "nope". Instruments in instruments.json: sc55, mt32.');
    const bare = await client.callTool({ name: 'search_midi_sounds', arguments: { instrument: 'mt32', query: 'bell' } });
    assert.equal(bare.isError, true);
    assert.equal(replyText(bare), 'Instrument "mt32" has no sound catalog. Its sounds are listed by get_midi_instruments with instrument "mt32".');
  });

  await t.test('get_midi_instruments counts the catalog and points to the search, and lists no catalog sound', async () => {
    const all = replyText(await client.callTool({ name: 'get_midi_instruments', arguments: {} }));
    assert.ok(all.includes('  Catalog: 3 sounds in 2 categories ("Group A", "Group B"). Search them with search_midi_sounds, instrument "sc55".'), all);
    assert.equal(all.split('\n').filter((line) => line.includes('Catalog:')).length, 1);
    const one = replyText(await client.callTool({ name: 'get_midi_instruments', arguments: { instrument: 'sc55' } }));
    assert.ok(one.endsWith('\n\nCatalog: 3 sounds in 2 categories ("Group A", "Group B"). Search them with search_midi_sounds, instrument "sc55".'), one);
    assert.ok(!all.includes('Glass Bell') && !one.includes('Glass Bell'));
  });

  await t.test('with no instruments.json the search gives the text the instruments tool gives', async () => {
    fs.rmSync(path.join(dataDir, 'instruments.json'));
    const none = await search({ query: 'bell' });
    assert.equal(none.isError, true);
    assert.ok(replyText(none).startsWith('No instruments.json in the Moontide data folder'), replyText(none));
  });
});

test('get_midi_instruments lists the instruments, one instrument\'s sounds, and every refusal', async (t) => {
  const { client, port, dataDir } = await startMcpClient();
  const pages = [];
  t.after(async () => {
    for (const page of pages) page.ws.close();
    await client.close();
  });

  await t.test('without instruments.json it says so, where the file goes and which models ship', async () => {
    const reply = await client.callTool({ name: 'get_midi_instruments', arguments: {} });
    assert.ok(!reply.isError, replyText(reply));
    const text = replyText(reply);
    assert.ok(text.startsWith('No instruments.json in the Moontide data folder'), text);
    assert.ok(text.includes('mt32 (Roland MT-32)') && text.includes('sc55 (Roland SC-55)'), text);
    const named = await client.callTool({ name: 'get_midi_instruments', arguments: { instrument: 'mt32' } });
    assert.ok(replyText(named).startsWith('No instruments.json in the Moontide data folder'));
  });

  writeRig(dataDir, {
    instruments: [
      { id: 'mt32', model: 'mt32', port: 'Fake Synth A' },
      { id: 'sc55', model: 'sc55', port: 'Fake Synth B' },
    ],
  });
  const page = await createFakePage(port, { rig: true });
  pages.push(page);

  await t.test('before any facts the connection is unknown, never no', async () => {
    const text = replyText(await client.callTool({ name: 'get_midi_instruments', arguments: {} }));
    assert.ok(text.includes('connected: unknown (the page has not enabled Web MIDI).'), text);
    assert.ok(!text.includes('connected: no.'), text);
  });

  await t.test('with facts the list is in file order, with connection, channels and counts', async () => {
    page.ws.send(JSON.stringify(midiState({ outputs: ['Fake Synth A'] })));
    await tick();
    const text = replyText(await client.callTool({ name: 'get_midi_instruments', arguments: {} }));
    assert.ok(text.startsWith('Instruments in instruments.json, in file order:\n'), text);
    assert.ok(text.indexOf('- mt32:') < text.indexOf('- sc55:'), text);
    assert.ok(text.includes('- mt32: Roland MT-32 (model mt32), port "Fake Synth A", connected: yes.'), text);
    assert.ok(text.includes('- sc55: Roland SC-55 (model sc55), port "Fake Synth B", connected: no.'), text);
    assert.ok(text.includes('  Channels: 2-9 melodic; 10 rhythm.'), text);
    assert.ok(text.includes(`  Channels: ${channelRange(1, 9)}, ${channelRange(11, 16)} melodic; 10 rhythm.`), text);
    assert.ok(text.includes('  Sounds: 128 melodic, 0 rhythm.'), text);
    assert.ok(text.includes('  Sounds: 128 melodic, 10 rhythm.'), text);
    assert.ok(text.includes('  Bank select: none.') && text.includes('  Bank select: CC0.'), text);
    assert.ok(text.includes('  Reset when it connects: 1 SysEx message, then a 100 ms wait.'), text);
    assert.ok(text.includes('  Controls: modulation CC1 0-127 (default 0), volume CC7 0-127 (default 100)'), text);
    assert.ok(text.includes('  Notes: '), text);
    assert.ok(
      text.endsWith(
        "One instrument's full sound list: get_midi_instruments with instrument set to its id.",
      ),
      text,
    );
    assert.ok(text.includes(".midi('port name', { midichannel: 3, sound: 'sound name' })"), text);
    assert.ok(text.includes('controls: { volume: 100 }'), text);
    assert.ok(text.includes('a sweep stays ccn and ccv'), text);
    assert.ok(text.indexOf('sound: ') < text.indexOf('controls: { volume: 100 }') && text.indexOf('controls: { volume: 100 }') < text.indexOf("One instrument's full sound list"), 'the controls sentence sits between the sound sentence and the full-list sentence');
  });

  await t.test('several outputs matching one port are named', async () => {
    page.ws.send(JSON.stringify(midiState({ outputs: ['Fake Synth A', 'Fake Synth A 2'] })));
    await tick();
    const text = replyText(await client.callTool({ name: 'get_midi_instruments', arguments: {} }));
    assert.ok(text.includes('connected: several outputs match ("Fake Synth A", "Fake Synth A 2").'), text);
  });

  await t.test('an instrument id lists its sounds with the program sent, in program order, rhythm apart', async () => {
    const reply = await client.callTool({ name: 'get_midi_instruments', arguments: { instrument: 'sc55' } });
    assert.ok(!reply.isError, replyText(reply));
    const lines = replyText(reply).split('\n');
    assert.ok(lines[0].startsWith('sc55: Roland SC-55, port "Fake Synth B".'), lines[0]);
    assert.ok(lines.includes(`Melodic, channels ${channelRange(1, 9)}, ${channelRange(11, 16)}:`), lines.join('\n'));
    assert.ok(lines.includes('0 Acoustic Grand Piano'), lines.join('\n'));
    assert.ok(lines.includes('127 Gunshot'), lines.join('\n'));
    const rhythmAt = lines.indexOf('Rhythm, channel 10:');
    assert.ok(rhythmAt > 0, lines.join('\n'));
    assert.deepEqual(lines.slice(rhythmAt + 1, rhythmAt + 11), [
      '0 Standard Set',
      '8 Room Set',
      '16 Power Set',
      '24 Electronic Set',
      '25 TR-808 Set',
      '32 Jazz Set',
      '40 Brush Set',
      '48 Orchestra Set',
      '56 SFX Set',
      '127 CM-64/32L Set',
    ]);
    const mt32 = replyText(await client.callTool({ name: 'get_midi_instruments', arguments: { instrument: 'mt32' } }));
    assert.ok(mt32.includes('\n48 Str Sect 1\n'), mt32);
    assert.ok(mt32.includes('Rhythm, channel 10:\nno sounds to choose.'), mt32);
  });

  await t.test('the drum maps are read through the tools: a Drum map line per instrument and the notes of each map', async () => {
    const summary = replyText(await client.callTool({ name: 'get_midi_instruments', arguments: {} }));
    assert.ok(
      summary.includes(
        '  Drum map: "Roland GS Standard" (61 notes) for kits without their own map; 3 kits have their own map (Orchestra Set, SFX Set, CM-64/32L Set). get_midi_instruments with instrument "sc55" lists the notes.',
      ),
      summary,
    );
    assert.ok(summary.includes('  Drum map: "Roland MT-32 Rhythm" (34 notes). get_midi_instruments with instrument "mt32" lists the notes.'), summary);
    const lines = replyText(await client.callTool({ name: 'get_midi_instruments', arguments: { instrument: 'sc55' } })).split('\n');
    const first = lines.find((line) => line.startsWith('Drum map '));
    assert.ok(first?.startsWith('Drum map "Roland GS Standard" (61 notes), for kits without their own map: 27 High Q, 28 Slap, '), first);
  });

  await t.test('an unknown instrument id is a tool error naming the valid ids', async () => {
    const reply = await client.callTool({ name: 'get_midi_instruments', arguments: { instrument: 'nope' } });
    assert.equal(reply.isError, true);
    const text = replyText(reply);
    assert.ok(text.includes('Unknown instrument "nope".'), text);
    assert.ok(text.includes('mt32, sc55'), text);
  });

  await t.test('an invalid file lists each problem as a field and a reason', async () => {
    writeRig(dataDir, { instruments: [{ id: 'mt32', model: 'mt32' }, { id: 'sc55', port: 'Fake Synth B' }] });
    const text = replyText(await client.callTool({ name: 'get_midi_instruments', arguments: {} }));
    assert.ok(text.includes('instruments.json is invalid, so no instruments are set up until it is fixed:\n'), text);
    assert.ok(text.includes('- instruments[0].port: required'), text);
    assert.ok(text.includes('- instruments[1].model: required'), text);
  });
});

// With a setup file the port notices name the instrument, and Claude hears each reset once.

test('with a valid instruments.json the port notice names the instrument first', async (t) => {
  const { client, port, dataDir } = await startMcpClient();
  const pages = [];
  t.after(async () => {
    for (const page of pages) page.ws.close();
    await client.close();
  });
  writeRig(dataDir, { instruments: [{ id: 'mt32', model: 'mt32', port: 'Fake Synth A' }] });
  const page = await createFakePage(port, { rig: true });
  pages.push(page);
  assert.equal(page.rig.setup, 'valid');
  page.setResponder((msg) => [
    midiState({ outputs: ['Fake Synth B'], ports: [{ name: 'Fake Synth A', state: 'not-found', matches: [] }] }),
    { type: 'evaluated', id: msg.id, ok: true, code: msg.code, audio: 'playing' },
  ]);
  const first = await client.callTool({ name: 'set_code', arguments: { code: "note('c3').midi('Fake Synth A')" } });
  assert.ok(!first.isError, first.content[0].text);
  const lines = midiLines(first.content[0].text);
  assert.equal(lines.length, 1, lines.join('\n'));
  assert.ok(lines[0].startsWith('MIDI: instrument "mt32": no output is named "Fake Synth A".'), lines[0]);
  const next = await client.callTool({ name: 'get_code', arguments: {} });
  assert.deepEqual(midiLines(next.content[0].text), [], 'told once');
});

test('a reset event reaches Claude in the next reply once, and the reply after holds no reset line', async (t) => {
  const { client, port, dataDir } = await startMcpClient();
  const pages = [];
  t.after(async () => {
    for (const page of pages) page.ws.close();
    await client.close();
  });
  writeRig(dataDir, { instruments: [{ id: 'mt32', model: 'mt32', port: 'Fake Synth A' }] });
  const page = await createFakePage(port, { rig: true });
  pages.push(page);
  page.setResponder((msg) => [
    midiState({ ports: [{ name: 'Fake Synth A', state: 'connected', matches: ['Fake Synth A'] }], events: [{ kind: 'reset', instrument: 'mt32', reason: 'reconnect' }] }),
    { type: 'evaluated', id: msg.id, ok: true, code: msg.code, audio: 'playing' },
  ]);
  const first = await client.callTool({ name: 'set_code', arguments: { code: "note('c3').midi('Fake Synth A')" } });
  assert.ok(!first.isError, first.content[0].text);
  assert.deepEqual(midiLines(first.content[0].text), ['MIDI: instrument "mt32" was reset to its known state after reconnecting.']);
  page.setResponder(undefined);
  const next = await client.callTool({ name: 'get_code', arguments: {} });
  assert.deepEqual(midiLines(next.content[0].text), []);
});

// save_midi_model is two steps. A draft is checked and summarized (nothing is written); it is saved
// only when the same model comes back with confirmed true. No tool ever writes instruments.json.

function draftedModel(overrides = {}) {
  return {
    id: 'synth',
    name: 'Draft Synth',
    channels: { melodic: [1, 2, 3], rhythm: [10] },
    bankSelect: 'none',
    defaultVolume: 100,
    reset: { sysex: [{ kind: 'raw', bytes: 'F0 7E 7F 09 01 F7' }], waitMs: 50 },
    controls: [{ id: 'volume', name: 'Volume', cc: 7, min: 0, max: 127, default: 100 }],
    sounds: { melodic: [{ name: 'First Sound', program: 0 }, { name: 'Last Sound', program: 5 }], rhythm: [{ name: 'Kit A', program: 0 }] },
    notes: ['Channel 1 is silent until a part is assigned.'],
    ...overrides,
  };
}

test('save_midi_model summarizes first, saves only a summarized model, never overwrites by accident and never writes instruments.json', async (t) => {
  const { client, port, dataDir } = await startMcpClient();
  const pages = [];
  t.after(async () => {
    for (const page of pages) page.ws.close();
    await client.close();
  });
  const rigText = JSON.stringify({ instruments: [{ id: 'one', model: 'synth', port: 'Fake Synth A' }] });
  writeRig(dataDir, rigText);
  const page = await createFakePage(port, { rig: true });
  pages.push(page);
  const modelFile = path.join(dataDir, 'models', 'synth.json');
  const save = (model, confirmed, extra = {}) => client.callTool({ name: 'save_midi_model', arguments: { model, confirmed, ...extra } });
  const textOf = (reply) => withoutArmingLine(reply.content[0].text);
  const assertRigUntouched = () => assert.equal(fs.readFileSync(path.join(dataDir, 'instruments.json'), 'utf8'), rigText);

  await t.test('an instruments.json that names the model is invalid before the save', async () => {
    const reply = await client.callTool({ name: 'get_midi_instruments', arguments: {} });
    assert.ok(textOf(reply).includes('instruments[0].model: unknown model "synth"'), textOf(reply));
  });

  await t.test('confirmed false returns the summary and the not-saved line and writes nothing', async () => {
    const reply = await save(draftedModel(), false);
    assert.ok(!reply.isError, textOf(reply));
    const text = textOf(reply);
    assert.ok(text.includes('Model "synth": Draft Synth.'), text);
    assert.ok(text.includes('Channels: 1-3 melodic; 10 rhythm.'), text);
    assert.ok(text.includes('Melodic sounds: 2, from "First Sound" (program 0 as sent, 1 in a manual numbered from 1) to "Last Sound" (program 5, 6).'), text);
    assert.ok(text.includes('Reset when it connects: F0 7E 7F 09 01 F7, then a 50 ms wait.'), text);
    assert.ok(text.includes('- Channel 1 is silent until a part is assigned.'), text);
    assert.ok(
      text.includes('Not saved. Show this summary to the user; call save_midi_model again with the same model and confirmed: true after they say yes.'),
      text,
    );
    assert.equal(fs.existsSync(path.join(dataDir, 'models')), false);
    assertRigUntouched();
  });

  await t.test('confirmed true right after saves models/<id>.json, and the setup file is valid again once', async () => {
    const reply = await save(draftedModel(), true);
    assert.ok(!reply.isError, textOf(reply));
    const text = textOf(reply);
    assert.ok(
      text.startsWith('Saved model "synth" in the Moontide data folder (models/synth.json). instruments.json can now use it with "model": "synth".'),
      text,
    );
    assert.deepEqual(midiLines(text), ['MIDI: instruments.json is valid again: 1 instrument.']);
    assert.deepEqual(JSON.parse(fs.readFileSync(modelFile, 'utf8')), draftedModel());
    assertRigUntouched();
    const next = await client.callTool({ name: 'get_midi_instruments', arguments: {} });
    assert.ok(textOf(next).includes('- one: Draft Synth (model synth)'), textOf(next));
    assert.deepEqual(midiLines(textOf(next)), []);
  });

  await t.test('the same save again says the model exists and leaves it as it was', async () => {
    const before = fs.readFileSync(modelFile, 'utf8');
    const reply = await save(draftedModel(), true);
    assert.equal(reply.isError, true);
    assert.ok(textOf(reply).includes('Model "synth" already exists in the data folder; pass overwrite: true to replace it.'), textOf(reply));
    assert.equal(fs.readFileSync(modelFile, 'utf8'), before);
    assertRigUntouched();
  });

  await t.test('overwrite true replaces it', async () => {
    const changed = draftedModel({ name: 'Changed Synth' });
    assert.ok(!(await save(changed, false)).isError);
    const reply = await save(changed, true, { overwrite: true });
    assert.ok(!reply.isError, textOf(reply));
    assert.equal(JSON.parse(fs.readFileSync(modelFile, 'utf8')).name, 'Changed Synth');
    assert.deepEqual(fs.readdirSync(path.join(dataDir, 'models')), ['synth.json']);
    assertRigUntouched();
  });

  await t.test('a model that was never summarized is not saved, even with confirmed true', async () => {
    const reply = await save(draftedModel({ id: 'other' }), true);
    assert.equal(reply.isError, true);
    assert.ok(
      textOf(reply).includes('Call save_midi_model with confirmed: false first, show the summary to the user, and save only after they say yes.'),
      textOf(reply),
    );
    assert.equal(fs.existsSync(path.join(dataDir, 'models', 'other.json')), false);
    assertRigUntouched();
  });

  await t.test('a shipped model id is refused, summarized or not', async () => {
    for (const confirmed of [false, true]) {
      const reply = await save(draftedModel({ id: 'mt32' }), confirmed);
      assert.equal(reply.isError, true);
      assert.ok(textOf(reply).includes('Model id "mt32" belongs to a model Moontide ships; choose another id.'), textOf(reply));
    }
    assert.equal(fs.existsSync(path.join(dataDir, 'models', 'mt32.json')), false);
  });

  await t.test('an invalid model is refused with each field and reason, never with raw schema text', async () => {
    const reply = await save(draftedModel({ id: 'bad', channels: { melodic: [17], rhythm: [10] }, defaultVolume: 200 }), false);
    assert.equal(reply.isError, true);
    const text = textOf(reply);
    assert.ok(text.includes('The model is invalid:'), text);
    assert.ok(text.includes('- channels.melodic[0]: 17 is not between 1 and 16'), text);
    assert.ok(text.includes('- defaultVolume: '), text);
    assert.ok(!text.includes('"code"') && !text.includes('"path"'), text);
    const unframed = await save(draftedModel({ id: 'bad', reset: { sysex: [{ kind: 'raw', bytes: 'F0 7E 80 F7' }], waitMs: 5 } }), false);
    assert.ok(textOf(unframed).includes('- reset.sysex[0].bytes: byte 2 (80) is above 7F'), textOf(unframed));
    const tooMany = await save(draftedModel({ id: 'bad', reset: { sysex: Array.from({ length: 5 }, () => ({ kind: 'raw', bytes: 'F0 7E F7' })), waitMs: 5 } }), false);
    assert.ok(textOf(tooMany).includes('- reset.sysex: at most 4 messages'), textOf(tooMany));
    assert.equal(fs.existsSync(path.join(dataDir, 'models', 'bad.json')), false);
    assertRigUntouched();
  });

  await t.test('an id that is not a plain id is refused and nothing is written outside the models folder', async () => {
    const reply = await save(draftedModel({ id: '../escape' }), false);
    assert.equal(reply.isError, true);
    assert.ok(textOf(reply).includes('- id: must be 1 to 32 lowercase letters, digits, dashes or underscores'), textOf(reply));
    assert.equal(fs.existsSync(path.join(dataDir, '..', 'escape.json')), false);
  });
});

// save_midi_catalog drafts a catalog from a sound list: the summary first (nothing written), the file
// only after the confirm, and the rig and the search pick it up at once. instruments.json is never written.

test('save_midi_catalog summarizes first, saves only after the yes, and the rig and the search pick the catalog up', async (t) => {
  const { client, port, dataDir } = await startMcpClient();
  const pages = [];
  t.after(async () => {
    for (const page of pages) page.ws.close();
    await client.close();
  });
  const rigText = JSON.stringify({ instruments: [{ id: 'sc55', model: 'sc55', port: 'Fake Synth B' }] });
  writeRig(dataDir, rigText);
  pages.push(await createFakePage(port, { rig: true }));
  const catalogFile = path.join(dataDir, 'catalogs', 'sc55.json');
  const textOf = (reply) => withoutArmingLine(reply.content[0].text);
  const assertRigUntouched = () => assert.equal(fs.readFileSync(path.join(dataDir, 'instruments.json'), 'utf8'), rigText);
  const part = {
    model: 'sc55',
    source: 'e2e list v1',
    programNumbering: 'from-1',
    banks: [
      { category: 'Group A', bank: { msb: 8 }, sounds: [{ program: 1, name: 'Tone 0001' }, { program: 2, name: 'Tone 0002' }] },
      { category: 'Group B', sounds: [{ program: 128, name: 'Tone 0003' }] },
    ],
  };

  await t.test('the first call returns the summary with both numberings and the not-saved line, and writes nothing', async () => {
    const reply = await client.callTool({ name: 'save_midi_catalog', arguments: part });
    assert.ok(!reply.isError, textOf(reply));
    const text = textOf(reply);
    assert.ok(text.includes('Catalog for model "sc55" (Roland SC-55), from "e2e list v1": 3 sounds.'), text);
    assert.ok(text.includes('First: "Tone 0001" (category "Group A", bank 8, program 0 as sent, 1 in a manual numbered from 1).'), text);
    assert.ok(text.includes('Last: "Tone 0003" (category "Group B", program 127 as sent, 128 in a manual numbered from 1).'), text);
    assert.ok(
      text.includes('Not saved. Show this summary to the user; call save_midi_catalog again with model "sc55" and confirmed: true after they say yes.'),
      text,
    );
    assert.equal(fs.existsSync(catalogFile), false);
    assertRigUntouched();
  });

  await t.test('the confirm, with no sound sent again, writes catalogs/sc55.json with converted programs and the rig stays valid', async () => {
    const reply = await client.callTool({ name: 'save_midi_catalog', arguments: { model: 'sc55', confirmed: true } });
    assert.ok(!reply.isError, textOf(reply));
    const text = textOf(reply);
    assert.ok(text.startsWith('Saved the catalog of model "sc55" in the Moontide data folder (catalogs/sc55.json): 3 sounds.'), text);
    assert.ok(!text.includes('instruments.json is invalid'), text);
    const saved = JSON.parse(fs.readFileSync(catalogFile, 'utf8'));
    assert.deepEqual(saved.sounds.map((sound) => [sound.name, sound.program]), [['Tone 0001', 0], ['Tone 0002', 1], ['Tone 0003', 127]]);
    assert.deepEqual(saved.sounds[0].bank, { msb: 8 });
    assertRigUntouched();
  });

  await t.test('search_midi_sounds finds a saved sound with its converted program', async () => {
    const reply = await client.callTool({ name: 'search_midi_sounds', arguments: { instrument: 'sc55', query: 'tone 0002' } });
    assert.ok(!reply.isError, textOf(reply));
    assert.ok(textOf(reply).split('\n').includes('- "Tone 0002": program 1, bank 8, category "Group A"'), textOf(reply));
  });

  await t.test('a second confirm finds the draft freed and writes nothing more', async () => {
    const before = fs.readFileSync(catalogFile, 'utf8');
    const reply = await client.callTool({ name: 'save_midi_catalog', arguments: { model: 'sc55', confirmed: true } });
    assert.equal(reply.isError, true);
    assert.ok(textOf(reply).includes('No catalog draft for model "sc55" in this session'), textOf(reply));
    assert.equal(fs.readFileSync(catalogFile, 'utf8'), before);
  });

  await t.test('a draft for a model that has a catalog is refused without overwrite', async () => {
    const reply = await client.callTool({ name: 'save_midi_catalog', arguments: part });
    assert.equal(reply.isError, true);
    assert.ok(textOf(reply).includes('catalogs/sc55.json already exists in the Moontide data folder; start the draft with overwrite: true to replace it.'), textOf(reply));
    assertRigUntouched();
  });
});


// The drum kits of a catalog.

function writeModel(dataDir, model) {
  fs.mkdirSync(path.join(dataDir, 'models'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'models', `${model.id}.json`), JSON.stringify(model));
}

const BANK_KITS_CATALOG = {
  model: 'bankdrums',
  source: 'e2e fixture',
  sounds: [],
  kits: [
    { name: 'Cat Kit One', category: 'Drum Group', program: 1, bank: { msb: 86, lsb: 65 } },
    { name: 'Cat Kit Two', category: 'Drum Group', program: 2, bank: { msb: 86, lsb: 65 }, noteMap: 'general-midi' },
    { name: 'Cat Kit Three', category: 'Drum Group', program: 3, bank: { msb: 86, lsb: 65 }, noteMap: null },
  ],
};

test('catalog kits reach the search and the page', async (t) => {
  const { client, port, dataDir } = await startMcpClient();
  const pages = [];
  t.after(async () => {
    for (const page of pages) page.ws.close();
    await client.close();
  });
  writeModel(dataDir, bankDrumsModel());
  writeRig(dataDir, { instruments: [{ id: 'drumbank', model: 'bankdrums', port: 'Fake Synth D' }] });
  writeCatalog(dataDir, 'bankdrums', BANK_KITS_CATALOG);
  const page = await createFakePage(port, { rig: true });
  pages.push(page);

  await t.test('the frame holds the kits after the model kits, and the page reader and the sound check take them', () => {
    assert.ok(page.rig, 'a midi-rig frame arrives before hello');
    const [first] = page.rig.instruments;
    assert.equal(first.catalogKits, 3);
    assert.equal(first.sounds.rhythm.length, 6);
    assert.deepEqual(first.sounds.rhythm[3], { name: 'Cat Kit One', program: 1, bank: { msb: 86, lsb: 65 } });
    assert.ok(!JSON.stringify(first.sounds.rhythm).includes('category'), 'the category stays on the server');
    const rig = parseRigMessage(page.rig);
    assert.equal(rig.instruments[0].catalogKits, 3);
    const code = `kit: note("36").midi('Fake Synth D', { midichannel: 5, sound: 'Cat Kit Two' })`;
    const { refusal, desired } = checkSetup({ read: readMidiSetup(code, { parse }), rig, outputs: [], playing: true });
    assert.equal(refusal, null);
    const entry = desired.get('drumbank:5');
    assert.equal(entry.program, 2);
    assert.deepEqual(entry.bank, { msb: 86, lsb: 65 });
  });

  await t.test('search_midi_sounds finds a kit by words of its name and says which drum map it has', async () => {
    const two = await client.callTool({ name: 'search_midi_sounds', arguments: { instrument: 'drumbank', query: 'kit two cat' } });
    assert.ok(!two.isError, replyText(two));
    assert.ok(
      replyText(two).split('\n').includes('- "Cat Kit Two" (drum kit): program 2, bank 86/65, category "Drum Group", drum map "General MIDI" (47 notes)'),
      replyText(two),
    );
    const three = await client.callTool({ name: 'search_midi_sounds', arguments: { instrument: 'drumbank', query: 'cat kit three' } });
    assert.ok(replyText(three).includes('"Cat Kit Three" (drum kit): program 3, bank 86/65, category "Drum Group", drum map unknown'), replyText(three));
    const one = await client.callTool({ name: 'search_midi_sounds', arguments: { instrument: 'drumbank', query: 'cat kit one' } });
    assert.ok(replyText(one).includes(', drum map "General MIDI" (47 notes)'), replyText(one));
  });

  await t.test('get_midi_instruments counts the kits of the catalog', async () => {
    const reply = await client.callTool({ name: 'get_midi_instruments', arguments: {} });
    assert.ok(
      replyText(reply).split('\n').includes('  Catalog: 3 drum kits in 1 category ("Drum Group"). Search them with search_midi_sounds, instrument "drumbank".'),
      replyText(reply),
    );
  });
});

// The PDF path: save_midi_catalog drafts drum kits (group role rhythm), saved only after the yes.

test('save_midi_catalog drafts kits of a model whose rhythm channels take a bank, saves them after the yes, and search finds them', async (t) => {
  const { client, port, dataDir } = await startMcpClient();
  const pages = [];
  t.after(async () => {
    for (const page of pages) page.ws.close();
    await client.close();
  });
  writeModel(dataDir, bankDrumsModel());
  writeRig(dataDir, { instruments: [{ id: 'drumbank', model: 'bankdrums', port: 'Fake Synth D' }, { id: 'sc55', model: 'sc55', port: 'Fake Synth B' }] });
  pages.push(await createFakePage(port, { rig: true }));
  const catalogFile = path.join(dataDir, 'catalogs', 'bankdrums.json');
  const textOf = (reply) => withoutArmingLine(reply.content[0].text);
  const part = {
    model: 'bankdrums',
    source: 'e2e list v1',
    programNumbering: 'from-1',
    banks: [
      { category: 'Group A', bank: { msb: 3, lsb: 4 }, sounds: [{ program: 1, name: 'Pdf Tone One' }] },
      { category: 'Drum Group', bank: { msb: 86, lsb: 64 }, role: 'rhythm', sounds: [{ program: 1, name: 'Pdf Kit One' }, { program: 2, name: 'Pdf Kit Two' }] },
    ],
  };

  await t.test('the summary counts the kits and shows the first and last with both numberings, and nothing is written', async () => {
    const reply = await client.callTool({ name: 'save_midi_catalog', arguments: part });
    assert.ok(!reply.isError, textOf(reply));
    const text = textOf(reply);
    assert.ok(text.includes('Catalog for model "bankdrums" (Bank Drum Synth), from "e2e list v1": 1 sound and 2 drum kits.'), text);
    assert.ok(
      text.includes('Kits: 2, from "Pdf Kit One" (program 0 as sent, 1 in a manual numbered from 1) to "Pdf Kit Two" (program 1, 2).'),
      text,
    );
    assert.ok(text.includes('Not saved.'), text);
    assert.equal(fs.existsSync(catalogFile), false);
  });

  await t.test('the confirm writes the kits in the kits list and the reply counts them', async () => {
    const reply = await client.callTool({ name: 'save_midi_catalog', arguments: { model: 'bankdrums', confirmed: true } });
    assert.ok(!reply.isError, textOf(reply));
    assert.ok(
      textOf(reply).startsWith('Saved the catalog of model "bankdrums" in the Moontide data folder (catalogs/bankdrums.json): 1 sound and 2 drum kits.'),
      textOf(reply),
    );
    const saved = JSON.parse(fs.readFileSync(catalogFile, 'utf8'));
    assert.equal(saved.sounds.length, 1);
    assert.deepEqual(saved.kits[0], { name: 'Pdf Kit One', category: 'Drum Group', program: 0, bank: { msb: 86, lsb: 64 } });
  });

  await t.test('search_midi_sounds then finds a saved kit as a drum kit', async () => {
    const reply = await client.callTool({ name: 'search_midi_sounds', arguments: { instrument: 'drumbank', query: 'pdf kit two' } });
    assert.ok(!reply.isError, textOf(reply));
    assert.ok(
      textOf(reply).split('\n').includes('- "Pdf Kit Two" (drum kit): program 1, bank 86/64, category "Drum Group", drum map "General MIDI" (47 notes)'),
      textOf(reply),
    );
  });

  await t.test('a rhythm group for a model that does not opt in is refused before anything is drafted', async () => {
    const reply = await client.callTool({
      name: 'save_midi_catalog',
      arguments: { model: 'sc55', source: 'e2e list', programNumbering: 'from-0', banks: [{ role: 'rhythm', bank: { msb: 1 }, sounds: [{ program: 1, name: 'Pdf Kit One' }] }] },
    });
    assert.equal(reply.isError, true);
    assert.ok(textOf(reply).includes('The part was not added:'), textOf(reply));
    assert.ok(textOf(reply).includes("- kits: this model's rhythm channels take no bank, so its kits are listed in the model"), textOf(reply));
    const confirm = await client.callTool({ name: 'save_midi_catalog', arguments: { model: 'sc55', confirmed: true } });
    assert.ok(textOf(confirm).includes('No catalog draft for model "sc55"'), textOf(confirm));
  });

  await t.test('a kit named like a kit of the model is refused at the call path of the kit, and a draft of only kits is summarized and saved', async () => {
    const clash = await client.callTool({
      name: 'save_midi_catalog',
      arguments: {
        model: 'bankdrums',
        source: 'e2e list',
        programNumbering: 'from-0',
        overwrite: true,
        banks: [{ role: 'rhythm', bank: { msb: 86, lsb: 65 }, sounds: [{ program: 1, name: 'Kit Z' }, { program: 2, name: 'kit a' }] }],
      },
    });
    assert.equal(clash.isError, true);
    assert.ok(textOf(clash).includes('- banks[0].sounds[1].name: same name as a sound of model bankdrums ("Kit A")'), textOf(clash));
    const only = await client.callTool({
      name: 'save_midi_catalog',
      arguments: {
        model: 'bankdrums',
        source: 'e2e list',
        programNumbering: 'from-0',
        overwrite: true,
        banks: [{ role: 'rhythm', noteMap: null, bank: { msb: 86, lsb: 65 }, sounds: [{ program: 1, name: 'Kit Z' }] }],
      },
    });
    assert.ok(!only.isError, textOf(only));
    assert.ok(textOf(only).includes('from "e2e list": 1 drum kit.'), textOf(only));
    assert.ok(textOf(only).includes('It replaces the existing catalogs/bankdrums.json.'), textOf(only));
    const saved = await client.callTool({ name: 'save_midi_catalog', arguments: { model: 'bankdrums', confirmed: true } });
    assert.ok(textOf(saved).includes(': 1 drum kit. '), textOf(saved));
    assert.deepEqual(JSON.parse(fs.readFileSync(catalogFile, 'utf8')).kits, [{ name: 'Kit Z', program: 1, bank: { msb: 86, lsb: 65 }, noteMap: null }]);
  });

  await t.test('a part of 300 sounds and 201 kits is refused by the 500 cap', async () => {
    const reply = await client.callTool({
      name: 'save_midi_catalog',
      arguments: {
        model: 'bankdrums',
        source: 'e2e list',
        programNumbering: 'from-0',
        overwrite: true,
        banks: [
          { bank: { msb: 3 }, sounds: Array.from({ length: 300 }, (_, index) => ({ program: index % 128, name: `Tone ${index}` })) },
          { role: 'rhythm', bank: { msb: 86 }, sounds: Array.from({ length: 201 }, (_, index) => ({ program: index % 128, name: `Kit ${index}` })) },
        ],
      },
    });
    assert.equal(reply.isError, true);
    assert.ok(textOf(reply).includes('This part holds 501 sounds; send at most 500 per call.'), textOf(reply));
  });
});

// The user's on/off choice travels from a page message to instruments-state.json, into the rig
// the server pushes, and into the page's MIDI output. Everything runs on a temporary data folder.

const SWITCH_RIG = {
  instruments: [
    { id: 'mt32', model: 'mt32', port: 'Fake Synth A' },
    { id: 'sc55', model: 'sc55', port: 'Fake Synth B' },
  ],
};

/** Sends one instrument-switch and reads frames until its instrument-result; returns the midi-rig frames that came first. */
async function switchInstrument(ws, id, instrument, enabled) {
  ws.send(JSON.stringify({ type: 'instrument-switch', id, instrument, enabled }));
  const rigs = [];
  for (;;) {
    const frame = await nextMessage(ws);
    if (frame.type === 'midi-rig') rigs.push(frame);
    else if (frame.type === 'instrument-result') return { rigs, result: frame };
  }
}

test('a switch message writes instruments-state.json, pushes the rig with enabled false, then answers ok', async (t) => {
  const { client, port, dataDir } = await startMcpClient();
  const sockets = [];
  t.after(async () => {
    for (const ws of sockets) ws.close();
    await client.close();
  });
  writeRig(dataDir, SWITCH_RIG);
  const rigText = fs.readFileSync(path.join(dataDir, 'instruments.json'), 'utf8');

  const ws = await connectPage(port);
  sockets.push(ws);
  const { rig } = await authenticatePageWithRig(ws, port);
  assert.deepEqual(rig.instruments.map((instrument) => [instrument.id, instrument.enabled]), [['mt32', true], ['sc55', true]]);

  const { rigs, result } = await switchInstrument(ws, 'switch-1', 'sc55', false);
  assert.equal(rigs.length, 1, 'exactly one midi-rig frame comes before the result');
  assert.deepEqual(rigs[0].instruments.map((instrument) => [instrument.id, instrument.enabled]), [['mt32', true], ['sc55', false]]);
  assert.deepEqual(parseRigMessage(rigs[0]).instruments.map((instrument) => instrument.enabled), [true, false]);
  assert.deepEqual(result, { type: 'instrument-result', id: 'switch-1', ok: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'instruments-state.json'), 'utf8')), { off: ['sc55'] });
  assert.equal(fs.readFileSync(path.join(dataDir, 'instruments.json'), 'utf8'), rigText, 'instruments.json is the user\'s and stays as it was');
});

test('the choice survives a restart of the server', async (t) => {
  const first = await startMcpClient();
  const sockets = [];
  let secondClient = null;
  t.after(async () => {
    for (const ws of sockets) ws.close();
    await first.client.close().catch(() => undefined);
    if (secondClient !== null) await secondClient.close();
  });
  writeRig(first.dataDir, SWITCH_RIG);
  const ws = await connectPage(first.port);
  sockets.push(ws);
  await authenticatePageWithRig(ws, first.port);
  const { result } = await switchInstrument(ws, 'switch-1', 'sc55', false);
  assert.deepEqual(result, { type: 'instrument-result', id: 'switch-1', ok: true });
  ws.close();
  await first.client.close();

  // A second server on the same data folder pushes the same choice to a newly authenticated page.
  const second = await startMcpClient({ env: { MOONTIDE_DATA_DIR: first.dataDir } });
  secondClient = second.client;
  const next = await connectPage(second.port);
  sockets.push(next);
  const { rig } = await authenticatePageWithRig(next, second.port);
  assert.deepEqual(rig.instruments.map((instrument) => [instrument.id, instrument.enabled]), [['mt32', true], ['sc55', false]]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(first.dataDir, 'instruments-state.json'), 'utf8')), { off: ['sc55'] });
});

// Claude reads which instruments the user switched off, and the page refuses code newly aimed at one.

test('Claude reads the off instrument and the page refuses code newly aimed at it', async (t) => {
  const { client, port, dataDir } = await startMcpClient();
  const sockets = [];
  t.after(async () => {
    for (const ws of sockets) ws.close();
    await client.close();
  });
  writeRig(dataDir, SWITCH_RIG);
  fs.writeFileSync(path.join(dataDir, 'instruments-state.json'), JSON.stringify({ off: ['sc55'] }));

  const summary = await client.callTool({ name: 'get_midi_instruments', arguments: {} });
  assert.ok(!summary.isError, summary.content[0].text);
  const lines = summary.content[0].text.split('\n');
  assert.ok(lines.includes('Switched off by the user: sc55. Its notes are silent; .midi() code newly aimed at it is refused until the user switches it on; music already playing that names it stays in place and plays nothing on it.'), summary.content[0].text);
  const header = lines.findIndex((line) => line.startsWith('- sc55:'));
  assert.ok(header >= 0);
  assert.equal(lines[header + 1], '  Switched off: the user switched this instrument off in the page.');
  assert.ok(!lines[lines.findIndex((line) => line.startsWith('- mt32:')) + 1].includes('Switched off'));

  const ws = await connectPage(port);
  sockets.push(ws);
  const { rig: frame } = await authenticatePageWithRig(ws, port);
  const rig = parseRigMessage(frame);
  const code = "lead: note(\"c3\").midi('Fake Synth A', { midichannel: 2 })\nbass: note(\"c2\").midi('Fake Synth B', { midichannel: 2, sound: 'Acoustic Grand Piano' })";
  const read = readMidiSetup(code, { parse });
  const refused = checkSetup({ read, rig, outputs: [], playing: true });
  const refusalLines = refused.refusal.split('\n');
  assert.equal(refusalLines[0], 'Instrument "sc55" (port "Fake Synth B") is switched off by the user, so code cannot newly aim .midi() at it.');
  assert.equal(refusalLines[refusalLines.length - 1], 'The previous music keeps playing.');
  assert.ok(refusalLines.includes('Instruments that are on: mt32.'), refused.refusal);

  const playingIt = checkSetup({ read, rig, outputs: [], playing: true, playingPorts: new Set(['Fake Synth B']) });
  assert.equal(playingIt.refusal, null);
  assert.ok([...playingIt.desired.values()].some((entry) => entry.instrument === 'sc55'), 'the sound of sc55 is recorded');
});

// The user's edit of an instrument's port, channels and clock travels from a page message to instruments.json
// (checked by the code that reads it, written with a backup), into the rig the server pushes, and to Claude once.

const SETTINGS_TEXT = `${JSON.stringify(
  {
    instruments: [
      { id: 'mt32', model: 'mt32', port: 'Fake Synth A' },
      { id: 'sc55', model: 'sc55', port: 'Fake Synth B', channels: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16] },
    ],
  },
  null,
  2,
)}\n`;

/** Sends one instrument-settings and reads frames until its instrument-result; returns the midi-rig frames that came first. */
async function changeSettings(ws, id, instrument, settings) {
  ws.send(JSON.stringify({ type: 'instrument-settings', id, instrument, settings }));
  const rigs = [];
  for (;;) {
    const frame = await nextMessage(ws);
    if (frame.type === 'midi-rig') rigs.push(frame);
    else if (frame.type === 'instrument-result') return { rigs, result: frame };
  }
}

test('a settings message rewrites one entry, keeps instruments.json.bak and pushes the new rig', async (t) => {
  const first = await startMcpClient();
  const sockets = [];
  let secondClient = null;
  t.after(async () => {
    for (const ws of sockets) ws.close();
    await first.client.close().catch(() => undefined);
    if (secondClient !== null) await secondClient.close();
  });
  writeRig(first.dataDir, SETTINGS_TEXT);
  const file = path.join(first.dataDir, 'instruments.json');

  const ws = await connectPage(first.port);
  sockets.push(ws);
  const { rig } = await authenticatePageWithRig(ws, first.port);
  assert.deepEqual(parseRigMessage(rig).instruments[1].modelChannels.map((entry) => entry.channel), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);

  const { rigs, result } = await changeSettings(ws, 'settings-1', 'sc55', { port: 'Fake Synth B', channels: [1, 2, 3, 10], clock: false });
  assert.equal(rigs.length, 1, 'exactly one midi-rig frame comes before the result');
  assert.deepEqual(rigs[0].instruments[1].channels.map((entry) => entry.channel), [1, 2, 3, 10]);
  assert.deepEqual(result, { type: 'instrument-result', id: 'settings-1', ok: true });

  const written = fs.readFileSync(file, 'utf8');
  const expected = JSON.parse(SETTINGS_TEXT);
  expected.instruments[1].channels = [1, 2, 3, 10];
  assert.deepEqual(JSON.parse(written), expected);
  assert.deepEqual(Object.keys(JSON.parse(written).instruments[1]), ['id', 'model', 'port', 'channels']);
  assert.ok(written.includes('"channels": [1, 2, 3, 10]'), written);
  assert.equal(fs.readFileSync(`${file}.bak`, 'utf8'), SETTINGS_TEXT, 'the previous text is kept byte for byte');
  assert.equal(fs.existsSync(`${file}.tmp`), false);

  // Claude hears it once.
  const next = await first.client.callTool({ name: 'get_code', arguments: {} });
  const lines = midiLines(next.content[0].text);
  assert.deepEqual(lines, ['MIDI: the user changed "sc55": channels 1-16 became 1-3, 10.']);
  const again = await first.client.callTool({ name: 'get_code', arguments: {} });
  assert.deepEqual(midiLines(again.content[0].text), []);

  // A second server on the same folder reads the new channels.
  ws.close();
  await first.client.close();
  const second = await startMcpClient({ env: { MOONTIDE_DATA_DIR: first.dataDir } });
  secondClient = second.client;
  const later = await connectPage(second.port);
  sockets.push(later);
  const { rig: pushed } = await authenticatePageWithRig(later, second.port);
  assert.deepEqual(pushed.instruments[1].channels.map((entry) => entry.channel), [1, 2, 3, 10]);
});
