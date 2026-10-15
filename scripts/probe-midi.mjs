#!/usr/bin/env node
// Developer check (npm run probe:midi): drives the real Moontide page through a real MCP client and
// a real Chromium-based browser (Chrome DevTools Protocol over Node's global WebSocket) to prove
// the MIDI path with no device: the page plays code with a .midi( call from its first beat, code
// without one never asks for MIDI access, and a misnamed port reaches Claude once.
//
// The browser has no MIDI device, so this script injects a fake Web MIDI before the page scripts
// run (Page.addScriptToEvaluateOnNewDocument): a fake MIDIAccess with two outputs whose sends land
// in window.__midiLog, and a count of the access requests in window.__midiRequests. It never runs
// downloaded code itself; the browser runs page/index.html exactly as shipped. Needs the same
// network as scripts/probe-page.mjs (the pinned Strudel bundle comes from unpkg). It reuses that
// script's helpers through plain exports. Exit codes: 0 all checks passed, 1 a check failed,
// 2 the probe could not run.
//
// Song structure: the checks of songMidiBlocks() prove that a .midi() track built by the in-code helper of a structured
// piece plays on its port only in the sections where it plays, and what happens to .midi() options that differ between
// variations. They run once before the final verdict of a full run, or alone with `--only song`.
//
// Mixer groups: the checks of mixerMidiBlocks() prove that a MIDI track inside a group of a structured piece keeps its place in the
// group's frame with its tag and controls, that the group's M silences it by the same rewrite as a track's own M, and that its
// light, and its group's light, blink at the timestamp its port got for each note. They run
// once before the final verdict of a full run, or alone with `--only mixer`.
//
// Timeline edits: the check of timelineMidiBlocks() proves that a drum note of a rhythm lane is selected and dragged like any note,
// with its ring on its row and the drums named in the sentence. It runs once before the final verdict of a full run, or alone with
// `--only timeline`. These three are the only groups this script can run alone.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CLOCK_NOTE_LEAD_MS, CLOCK_STAMPED_NOTE_SLACK_MS, CLOCK_START_LEAD_MS, CLOCK_TICKS_PER_CYCLE, CYCLIST_FIELDS } from '../page/midi-clock.js';
import { INSTRUMENTS_COPY } from '../page/instruments-model.js';
import { MIDI_COPY, MIDI_TITLE_PREFIX, fill, listNames, panicMessages } from '../page/midi-plan.js';
import { MIXER_COPY } from '../page/mixer-model.js';
import { QUEUED_NOTE_OFF_AFTER_MS, RECONNECT_REPEAT_MS, RESET_SETTLE_MS, SETUP_GUARD_MS, SILENCE_REPEAT_MS } from '../page/midi-out.js';
import { RIG_COPY } from '../page/midi-rig.js';
import { bankDrumsModel, gmDrumsModel } from '../test/drum-fixtures.js';
import { CONNECTION_LABELS, SOUND_LABELS } from '../page/ui-state.js';
import {
  MIDI_CLOCK_DROPPED_LINE,
  MIDI_DENIED_LINE,
  MIDI_HIDDEN_LINE,
  MIDI_VISIBLE_LINE,
  MIDI_NO_OUTPUTS_LINE,
  MIDI_UNREADABLE_LINE,
  MIDI_PERMISSION_WAIT_MESSAGE,
  MIDI_UNSUPPORTED_LINE,
  midiNoPortLine,
  midiPortAmbiguousLine,
  midiPortBackLine,
  midiPortUnpluggedLine,
} from '../dist/midi-state.js';
import {
  ProbeCouldNotRun,
  askAt,
  askAtCoords,
  callTool,
  clickElement,
  clickOverlay,
  closeBrowser,
  closeBrowserOnSignal,
  closeDrawer,
  DRAWER_ITEM_JS,
  dragSlider,
  evaluateExpr,
  findBrowser,
  findPageTarget,
  freshDataDir,
  makeCdp,
  openDrawer,
  parseArgs,
  pollDevToolsPort,
  pressKey,
  reloadPage,
  removeTempDirs,
  sleep,
  spawnBrowser,
  MIXER_LIGHT_WATCH_START,
  MIXER_LIGHT_WATCH_STOP,
  SONG_HELPER_TEXT,
  SONG_NOTE_LISTEN_START,
  SONG_NOTE_LISTEN_STOP,
  songHelperCode,
  songMidiOf,
  startServerAndClient,
  stopMusic,
  waitConnected,
  waitFor,
  waitSocketOpen,
} from './probe-page.mjs';

export const SCENARIO_KEY = 'moontideProbeMidi';

/**
 * Page JavaScript that runs at document start, before any page script. It reads a scenario from
 * localStorage (JSON: permission 'prompt' | 'granted' | 'denied', answer 'grant' | 'deny' | 'hang',
 * delayMs, webMidi, outputs) and installs a fake Web MIDI.
 */
export const FAKE_MIDI_SOURCE = `(() => {
  if (!location.origin.startsWith('http')) return;
  const defaults = { permission: 'prompt', answer: 'grant', delayMs: 0, webMidi: true, outputs: ['Fake Synth A', 'Fake Synth B'] };
  const stored = localStorage.getItem(${JSON.stringify(SCENARIO_KEY)});
  const scenario = stored === null ? defaults : { ...defaults, ...JSON.parse(stored) };
  let permission = scenario.permission;

  window.__midiLog = [];
  window.__midiRequests = 0;
  window.__strudelLog = [];
  window.__consoleErrors = [];
  const realConsoleError = console.error.bind(console);
  console.error = (...parts) => {
    window.__consoleErrors.push(parts.map((part) => (part instanceof Error ? part.message : String(part))).join(' '));
    realConsoleError(...parts);
  };
  document.addEventListener('strudel.log', (event) => {
    window.__strudelLog.push(String(event.detail && event.detail.message));
  });

  class FakeOut extends EventTarget {
    constructor(id, name) {
      super();
      Object.assign(this, { id, name, manufacturer: '', version: '1', type: 'output', state: 'connected', connection: 'closed', onstatechange: null });
    }
    async open() { this.connection = 'open'; return this; }
    async close() { this.connection = 'closed'; return this; }
    send(data, ts) {
      window.__midiLog.push({ t: performance.now(), port: this.name, bytes: Array.from(data), ts: ts === undefined ? null : ts });
    }
  }

  const all = scenario.outputs.map((name, index) => new FakeOut('fake-out-' + index, name));
  const access = new EventTarget();
  access.outputs = new Map();
  access.inputs = new Map();
  access.sysexEnabled = true;
  access.onstatechange = null;
  const refreshOutputs = () => {
    access.outputs.clear();
    for (const out of all) if (out.state === 'connected') access.outputs.set(out.id, out);
  };
  refreshOutputs();

  if (!scenario.webMidi) {
    delete Navigator.prototype.requestMIDIAccess;
    delete navigator.requestMIDIAccess;
  } else {
    navigator.requestMIDIAccess = async () => {
      window.__midiRequests++;
      if (permission === 'denied') throw new DOMException('Permission to use Web MIDI API was not granted.', 'NotAllowedError');
      if (scenario.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, scenario.delayMs));
      if (scenario.answer === 'hang') return new Promise(() => {});
      if (scenario.answer === 'deny') {
        permission = 'denied';
        throw new DOMException('Permission to use Web MIDI API was not granted.', 'NotAllowedError');
      }
      permission = 'granted';
      return access;
    };
  }

  const realQuery = navigator.permissions && navigator.permissions.query ? navigator.permissions.query.bind(navigator.permissions) : null;
  if (navigator.permissions) {
    navigator.permissions.query = (descriptor) => {
      if (descriptor && descriptor.name === 'midi') return Promise.resolve({ state: permission });
      if (realQuery === null) return Promise.reject(new TypeError('permissions.query is not available'));
      return realQuery(descriptor);
    };
  }

  const fire = (out) => {
    const event = Object.assign(new Event('statechange'), { port: out });
    if (typeof access.onstatechange === 'function') access.onstatechange(event);
    access.dispatchEvent(event);
  };
  const find = (name) => {
    const out = all.find((candidate) => candidate.name === name);
    if (!out) throw new Error('no fake output named ' + name);
    return out;
  };
  const change = (name, state) => {
    const out = find(name);
    out.state = state;
    refreshOutputs();
    fire(out);
  };
  window.__unplug = (name) => change(name, 'disconnected');
  window.__plug = (name) => change(name, 'connected');
  // A statechange event for an output whose state did not change: the noise real drivers make.
  window.__noise = (name) => fire(find(name));
})();`;

const SILENT = 's("bd").gain(0)';

/** The ports that received a note-on in `entries` from index `from` on. */
function noteOnsOnAnyPort(entries, from) {
  return entries
    .slice(from)
    .filter((entry) => entry.bytes.length === 3 && entry.bytes[0] >= 0x90 && entry.bytes[0] <= 0x9f && entry.bytes[2] > 0)
    .map((entry) => entry.port);
}

function noteOns(entries, port) {
  return entries.filter(
    (entry) => entry.port === port && entry.bytes.length === 3 && entry.bytes[0] >= 0x90 && entry.bytes[0] <= 0x9f && entry.bytes[2] > 0,
  );
}

/**
 * Song structure checks over the fake MIDI device. `setScenario` reloads the page with a fresh fake device (and a fresh log),
 * `dataDir` is the server's data folder (an instruments.json written there is read when the page reloads).
 */
export async function songMidiBlocks(context) {
  const { cdp, client, report, setScenario, dataDir } = context;
  const midiLog = () => evaluateExpr(cdp, 'window.__midiLog');
  const stateWord = () => evaluateExpr(cdp, `(() => { const el = document.querySelector('#sound-state .state-label'); return el ? el.textContent : null; })()`);
  const soundsAt = (entry) => (typeof entry.ts === 'number' ? entry.ts : entry.t);

  // The note-ons of one port grouped into bursts: a silence of more than a second starts a new one.
  const burstsOf = (entries, port) => {
    const ons = noteOns(entries, port).sort((a, b) => soundsAt(a) - soundsAt(b));
    const bursts = [];
    for (const entry of ons) {
      const last = bursts.at(-1);
      if (last !== undefined && soundsAt(entry) - last.at.at(-1) <= 1000) {
        last.pitches.push(entry.bytes[1]);
        last.at.push(soundsAt(entry));
      } else {
        bursts.push({ pitches: [entry.bytes[1]], at: [soundsAt(entry)] });
      }
    }
    return bursts;
  };
  const countOf = (list, pitch) => list.filter((value) => value === pitch).length;

  // A track built by the helper that ends with .midi() sends notes only in the sections where it plays. Its sections
  // are 3 cycles in E minor, 5 cycles in C major and a rest of 7 cycles; the clock runs at 2 cycles a second.
  await setScenario({ permission: 'granted' });
  let marker = (await midiLog()).length;
  await callTool(client, 'set_code', { code: songHelperCode({ midi: true, cps: 2 }), label: 'probe:midi song helper' });
  await sleep(19000);
  const playedEntries = (await midiLog()).slice(marker);
  const bursts = burstsOf(playedEntries, 'Fake Synth A');
  const middle = bursts[1] ?? { pitches: [], at: [] };
  const xPitches = middle.pitches.slice(0, 12);
  const yPitches = middle.pitches.slice(12);
  const silences = bursts.slice(1).map((burst, index) => Math.round(burst.at[0] - bursts[index].at.at(-1)));
  report(
    'song: a .midi() track built by the helper plays on its port in its sections and is silent in its rest',
    bursts.length >= 3 &&
      middle.pitches.length === 32 &&
      countOf(xPitches, 62) === 3 &&
      countOf(xPitches, 48) === 0 &&
      countOf(yPitches, 48) === 5 &&
      countOf(yPitches, 62) === 0 &&
      silences.every((gap) => gap >= 3000 && gap <= 4500) &&
      noteOns(playedEntries, 'Fake Synth B').length === 0,
    JSON.stringify({ burstSizes: bursts.map((burst) => burst.pitches.length), silencesMs: silences, middleBurstFirst12: xPitches.length, pitch62InFirst12: countOf(xPitches, 62), pitch48InLast20: countOf(yPitches, 48) }),
  );
  await callTool(client, 'set_code', { code: SILENT, label: 'probe:midi song helper done' });

  // The page's note tag names the notes of a .midi() track, and the port still receives every note. The page carries the tag for
  // every evaluation, so there is no run without it; the proof that nothing moved is in the last complete burst of 32 note-ons
  // of the port: the notes the listener names for t2 have the same 32 pitches in order, each carries a stamp equal to the
  // timestamp the port logged for the same note, and the target times are spaced the way the port timestamps are.
  await setScenario({ permission: 'granted' });
  const lightPiece = songHelperCode({ midi: true, cps: 2 });
  // The sizes of all bursts the run sent, kept for the report, so a missing complete burst shows what was sent instead.
  const burstSizes = {};
  const playForCycles = async (code, label) => {
    await evaluateExpr(cdp, 'window.__midiLog.length = 0');
    await evaluateExpr(cdp, 'window.__noteSeen.seen.length = 0');
    await callTool(client, 'set_code', { code, label });
    const active = await waitFor(cdp, `document.getElementById('repl').editor.repl.state.activeCode === ${JSON.stringify(code)} ? true : null`, 8000);
    if (active !== true) throw new ProbeCouldNotRun(`the page did not start running the code of ${label} within 8 seconds`);
    const startedAt = await evaluateExpr(cdp, `document.getElementById('repl').editor.repl.scheduler.now()`);
    const reached = await waitFor(cdp, `document.getElementById('repl').editor.repl.scheduler.now() >= ${startedAt + 24} ? true : null`, 60000);
    if (reached !== true) throw new ProbeCouldNotRun(`the scheduler did not run 24 cycles within 60 seconds in ${label}`);
    const bursts = burstsOf(await midiLog(), 'Fake Synth A');
    burstSizes[label] = bursts.map((burst) => burst.pitches.length);
    return bursts.filter((burst) => burst.pitches.length === 32).at(-1);
  };
  let lightFacts = { burstSizes };
  let lightOk = false;
  try {
    await evaluateExpr(cdp, SONG_NOTE_LISTEN_START);
    const portBurst = await playForCycles(lightPiece, 'probe:midi song note tag');
    const everything = await evaluateExpr(cdp, 'window.__noteSeen.seen.map((e) => ({ key: e.key, wb: e.wb, target: e.target, stamp: e.stamp, note: e.note }))');
    const seen = everything.filter((e) => e.key === 'label:t2').sort((a, b) => a.wb - b.wb);
    // The listener's notes of t2 in bursts of the same shape: a rest of the track is 7 cycles, so a gap of 4 cycles starts a new one.
    const namedBursts = [];
    for (const e of seen) {
      const last = namedBursts.at(-1);
      if (last !== undefined && e.wb - last.at(-1).wb <= 4) last.push(e);
      else namedBursts.push([e]);
    }
    const seenBurst = namedBursts.filter((burst) => burst.length === 32).at(-1);
    const unkeyed = everything.filter((e) => typeof e.key !== 'string' || e.key === '').length;
    lightFacts = { burstSizes, namedBurstSizes: namedBursts.map((burst) => burst.length), unkeyed };
    if (portBurst !== undefined && seenBurst !== undefined) {
      const seenPitches = seenBurst.map((e) => songMidiOf(e.note));
      // The port's burst lists note-on timestamps in time order, the listener's in whole-begin order: the same order for one track.
      const stampDiffs = seenBurst.map((e, index) => (typeof e.stamp === 'number' ? Math.abs(e.stamp - portBurst.at[index]) : Infinity));
      const targetSpacing = seenBurst.map((e) => (e.target - seenBurst[0].target) * 1000);
      const portSpacing = portBurst.at.map((value) => value - portBurst.at[0]);
      const spacingDiffs = targetSpacing.map((value, index) => Math.abs(value - portSpacing[index]));
      lightFacts = {
        burstSizes,
        portNotes: portBurst.pitches.length,
        seenNotes: seenBurst.length,
        seenEqualPort: seenPitches.filter((pitch, index) => pitch === portBurst.pitches[index]).length,
        maxStampDifferenceMs: Math.round(Math.max(...stampDiffs) * 100) / 100,
        maxSpacingDifferenceMs: Math.round(Math.max(...spacingDiffs) * 100) / 100,
        unkeyed,
      };
      lightOk =
        lightFacts.seenNotes === 32 &&
        lightFacts.seenEqualPort === 32 &&
        lightFacts.maxStampDifferenceMs < 1 &&
        lightFacts.maxSpacingDifferenceMs < 1 &&
        unkeyed === 0;
    }
  } finally {
    await evaluateExpr(cdp, SONG_NOTE_LISTEN_STOP);
    await callTool(client, 'set_code', { code: SILENT, label: 'probe:midi song note tag done' });
  }
  report("song: the page's note tag names every note of a .midi() track, and each carries the timestamp the port got", lightOk, JSON.stringify(lightFacts));

  // Options that differ between variations: two sounds asked of one channel are refused when the code is evaluated; on two
  // channels each sound goes out once when the code is evaluated and no section change sends another.
  const rigFile = path.join(dataDir, 'instruments.json');
  fs.writeFileSync(rigFile, JSON.stringify({ instruments: [{ id: 'mt32', model: 'mt32', port: 'Fake Synth B' }] }));
  try {
    await setScenario({ permission: 'granted' });
    const optionsCode = (channelA, channelB) =>
      [
        'setcps(2)',
        "const harmony = 'C3:major'",
        "const song = { shift: 0, sections: [['x', 3], ['y', 5], ['z', 7]], plan: { x: { t4: 'va' }, y: { t4: 'vb' }, z: { t4: 'va' } } };",
        SONG_HELPER_TEXT,
        `const t4 = { va: note("c3 e3").midi('Fake Synth B', { midichannel: ${channelA}, sound: 'Str Sect 1' }), vb: note("g3 b3").midi('Fake Synth B', { midichannel: ${channelB}, sound: 'Harpsi 2' }) };`,
        "t4: play('t4', t4)",
      ].join('\n');
    let refusal = '';
    try {
      await callTool(client, 'set_code', { code: optionsCode(3, 3), label: 'probe:midi song one channel two sounds' });
    } catch (err) {
      refusal = (err instanceof Error ? err.message : String(err)).split('\n\n')[0];
    }
    const stateAfterRefusal = await stateWord();
    marker = (await midiLog()).length;
    await callTool(client, 'set_code', { code: optionsCode(3, 4), label: 'probe:midi song two channels' });
    await sleep(17000);
    const optionEntries = (await midiLog()).slice(marker).filter((entry) => entry.port === 'Fake Synth B');
    const programs = optionEntries.filter((entry) => entry.bytes.length === 2 && (entry.bytes[0] & 0xf0) === 0xc0).map((entry) => entry.bytes.join('-'));
    // Runs of notes of the same variation: every change of variation is a section change that reached the port.
    const variationOf = (entry) => (entry.bytes[1] === 48 || entry.bytes[1] === 52 ? 'a' : 'b');
    const runs = [];
    for (const entry of noteOns(optionEntries, 'Fake Synth B').sort((a, b) => soundsAt(a) - soundsAt(b))) {
      if (runs.at(-1) !== variationOf(entry)) runs.push(variationOf(entry));
    }
    report(
      'song: .midi() options that differ between variations go out once per evaluation, never at a section change (two sounds on one channel are refused)',
      refusal.includes('mt32 channel 3 is asked for two different sounds: "Str Sect 1" and "Harpsi 2"') &&
        stateAfterRefusal === 'Playing' &&
        programs.length === 2 &&
        programs.includes('194-48') &&
        programs.includes('195-17') &&
        runs.length >= 4,
      JSON.stringify({ refusal, stateAfterRefusal, programChanges: programs, variationRuns: runs.join('') }),
    );
  } finally {
    await callTool(client, 'set_code', { code: SILENT, label: 'probe:midi song options done' });
    fs.rmSync(rigFile, { force: true });
  }
}

/**
 * Mixer group checks over the fake MIDI device: a MIDI track of a structured piece sits in its group's frame, and the group's M
 * mutes it. `setScenario` reloads the page with a fresh fake device (and a fresh log), `dataDir` is the server's data folder.
 */
export async function mixerMidiBlocks(context) {
  const { cdp, client, report, setScenario, dataDir } = context;
  const midiLog = () => evaluateExpr(cdp, 'window.__midiLog');
  const replState = `document.getElementById('repl').editor.repl.state`;
  const historyRows = async () => {
    const reply = String(await callTool(client, 'list_history', {}));
    return reply
      .split('\n')
      .filter((row) => /^#\d+ /.test(row))
      .map((row) => ({ id: Number(/^#(\d+) /.exec(row)[1]), label: /"([^"]*)"/.exec(row)?.[1] ?? row }));
  };
  const rigFile = path.join(dataDir, 'instruments.json');
  fs.writeFileSync(rigFile, JSON.stringify({ instruments: [{ id: 'mt32', model: 'mt32', port: 'Fake Synth A' }] }));
  try {
    await setScenario({ permission: 'granted' });
    // The instrument of the rig declares channels 2 to 10, so the track names channel 3.
    const code = songHelperCode({ midi: true, cps: 2 }).replace(".midi('Fake Synth A')", ".midi('Fake Synth A', { midichannel: 3 })");
    await callTool(client, 'set_code', { code, label: 'probe:midi mixer group' });
    if ((await waitFor(cdp, `${replState}.activeCode === ${JSON.stringify(code)} ? true : null`, 8000)) !== true) {
      throw new ProbeCouldNotRun('the page did not start running the code of the Mixer group check within 8 seconds');
    }
    await evaluateExpr(cdp, `(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); })()`);
    await pressKey(cdp, '3');
    if ((await waitFor(cdp, `document.getElementById('workspace').dataset.view === 'mixer' ? true : null`, 3000)) !== true) {
      throw new ProbeCouldNotRun('the Mixer did not open');
    }
    const frame = `.mx-group[data-group='["g1"]']`;
    const strip = `${frame} .mx-strip[data-track="label:t2"][data-midi="true"]`;
    const stripFacts = await waitFor(
      cdp,
      `(() => {
        const el = document.querySelector(${JSON.stringify(strip)});
        if (el === null) return null;
        const tag = el.querySelector('.mx-tag');
        const chips = [...el.querySelectorAll('.mx-midi-chip')].map((chip) => chip.dataset.param);
        return tag === null || tag.hidden || chips.length === 0 ? null : { tag: tag.textContent, chips, fader: !el.querySelector('.mx-fader').disabled, ownFrame: el.closest('.mx-group').dataset.group };
      })()`,
      6000,
    );
    // The piece is heard on the port before the group is muted.
    const heardBefore = await waitFor(cdp, `window.__midiLog.some((e) => e.port === 'Fake Synth A' && e.bytes.length === 3 && e.bytes[0] >= 0x90 && e.bytes[0] <= 0x9f && e.bytes[2] > 0) ? true : null`, 10000);
    const historyBefore = (await historyRows())[0].id;
    await clickElement(cdp, `${frame} > .mx-group-head .mx-mute`);
    const mutedCode = await waitFor(cdp, `(() => { const code = ${replState}.activeCode; return /^_t1:/m.test(code) && /^_t2:/m.test(code) ? code : null; })()`, 15000);
    const mutedRows = await historyRows();
    // The new code is running; notes that were already scheduled ahead of it may still leave, so the window starts a moment
    // later. The window is longer than one run of the song (15 cycles, 7.5 seconds), so a track that still played would be heard.
    await sleep(1500);
    const quietFrom = (await midiLog()).length;
    await sleep(9000);
    const heardWhileMuted = (await midiLog()).slice(quietFrom).filter((e) => e.port === 'Fake Synth A' && e.bytes.length === 3 && e.bytes[0] >= 0x90 && e.bytes[0] <= 0x9f && e.bytes[2] > 0).length;
    const mutedStrip = await evaluateExpr(cdp, `(() => { const el = document.querySelector(${JSON.stringify(strip)}); return el === null ? null : el.querySelector('.mx-mute').getAttribute('aria-pressed'); })()`);
    const backFrom = (await midiLog()).length;
    await clickElement(cdp, `${frame} > .mx-group-head .mx-mute`);
    const unmutedCode = await waitFor(cdp, `${replState}.activeCode === ${JSON.stringify(code)} ? true : null`, 15000);
    const heardAfter = await waitFor(cdp, `window.__midiLog.slice(${backFrom}).some((e) => e.port === 'Fake Synth A' && e.bytes.length === 3 && e.bytes[0] >= 0x90 && e.bytes[0] <= 0x9f && e.bytes[2] > 0) ? true : null`, 12000);
    const finalRows = await historyRows();
    const mutedLines = mutedCode === null ? [] : mutedCode.split('\n');
    report(
      "mixer: a MIDI track in a group keeps its instrument controls and the group's M mutes it with the same rewrite",
      stripFacts !== null &&
        stripFacts.ownFrame === '["g1"]' &&
        stripFacts.tag.length > 0 &&
        stripFacts.chips.length > 0 &&
        stripFacts.fader === true &&
        heardBefore === true &&
        mutedCode !== null &&
        mutedLines.some((line) => /^t3: /.test(line)) &&
        mutedRows[0].id === historyBefore + 1 &&
        mutedRows[0].label === 'mixer: group g1 muted' &&
        mutedStrip === 'true' &&
        heardWhileMuted === 0 &&
        unmutedCode === true &&
        heardAfter === true &&
        finalRows[0].id === historyBefore + 2 &&
        finalRows[0].label === 'mixer: group g1 unmuted',
      JSON.stringify({ stripFacts, heardBefore, historyBefore, mutedRows: mutedRows.slice(0, 2), mutedStrip, heardWhileMuted, unmutedCode, heardAfter, finalRows: finalRows.slice(0, 3) }),
    );
  } finally {
    await callTool(client, 'set_code', { code: SILENT, label: 'probe:midi mixer group done' });
    fs.rmSync(rigFile, { force: true });
  }

  // The light of a .midi() track lights in the first frame at or after the timestamp its port got for each note, and the light of
  // its group in the same frame. The piece runs at one cycle a second; its .midi() track plays four notes a cycle in 8 of 15 cycles,
  // and its other track is a silent browser track in the same group. The watch records each time a light's fill turns to full
  // strength (from a MutationObserver), the note listener keeps the stamp the page read for every note, and the port's own log
  // holds the timestamps the notes are compared with.
  const frameStats = '(() => { const state = window.__frameGaps; state.on = false; const gaps = state.gaps.slice().sort((a, b) => a - b); return { count: gaps.length, median: gaps.length === 0 ? null : gaps[Math.floor(gaps.length / 2)] }; })()';
  let listening = false;
  let watching = false;
  try {
    await setScenario({ permission: 'granted' });
    const lightCode = songHelperCode({ midi: true, cps: 1 });
    await callTool(client, 'set_code', { code: lightCode, label: 'probe:midi mixer light' });
    if ((await waitFor(cdp, `${replState}.activeCode === ${JSON.stringify(lightCode)} ? true : null`, 8000)) !== true) {
      throw new ProbeCouldNotRun('the page did not start running the code of the Mixer light check within 8 seconds');
    }
    await evaluateExpr(cdp, `(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); })()`);
    if ((await evaluateExpr(cdp, `document.getElementById('workspace').dataset.view`)) !== 'mixer') await pressKey(cdp, '3');
    if ((await waitFor(cdp, `document.getElementById('workspace').dataset.view === 'mixer' ? true : null`, 3000)) !== true) {
      throw new ProbeCouldNotRun('the Mixer did not open');
    }
    const lightOf = `.mx-strip[data-track="label:t2"][data-midi="true"] .mx-light`;
    const groupLightOf = `.mx-group[data-group='["g1"]'] > .mx-group-head .mx-group-title > .mx-light`;
    if ((await waitFor(cdp, `document.querySelector(${JSON.stringify(lightOf)}) !== null && document.querySelector(${JSON.stringify(groupLightOf)}) !== null ? true : null`, 6000)) !== true) {
      throw new ProbeCouldNotRun('the Mixer did not draw the light of the .midi() track and of its group');
    }
    await evaluateExpr(cdp, SONG_NOTE_LISTEN_START);
    listening = true;
    await evaluateExpr(cdp, MIXER_LIGHT_WATCH_START({ t2: lightOf, g1: groupLightOf }, ['label:t2']));
    watching = true;
    // The frame interval of this run, measured while the lights run.
    await evaluateExpr(
      cdp,
      `(() => {
        const state = (window.__frameGaps = { on: true, last: null, gaps: [] });
        const step = (t) => {
          if (!state.on) return;
          if (state.last !== null) state.gaps.push(t - state.last);
          state.last = t;
          requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      })()`,
    );
    await evaluateExpr(cdp, 'window.__midiLog.length = 0');
    const startedAt = await evaluateExpr(cdp, 'performance.now()');
    await sleep(16500);
    const endedAt = await evaluateExpr(cdp, 'performance.now()');
    const frames = await evaluateExpr(cdp, frameStats);
    const watch = await evaluateExpr(cdp, MIXER_LIGHT_WATCH_STOP);
    watching = false;
    const seen = await evaluateExpr(cdp, 'window.__noteSeen.seen.map((e) => ({ key: e.key, stamp: e.stamp }))');
    await evaluateExpr(cdp, SONG_NOTE_LISTEN_STOP);
    listening = false;
    const log = await midiLog();
    const frameMs = frames.median === null ? 17 : frames.median;
    // A note whose timestamp is in the last 100 ms of the window may light after the watch ended, so it is left out.
    const sent = noteOns(log, 'Fake Synth A')
      .map((entry) => (typeof entry.ts === 'number' ? entry.ts : entry.t))
      .filter((at) => at >= startedAt && at <= endedAt - 100);
    const litAt = (name) => watch.events[name].filter((event) => event.opacity === '1').map((event) => event.t);
    const t2Lit = litAt('t2');
    const g1Lit = litAt('g1');
    const gaps = sent.map((at) => {
      const lit = t2Lit.find((t) => t >= at - 1);
      return lit === undefined ? null : lit - at;
    });
    const inTime = gaps.filter((gap) => gap !== null && gap >= -1 && gap <= frameMs + 20);
    const gapsMs = gaps.filter((gap) => gap !== null).sort((a, b) => a - b);
    const round = (value) => Math.round(value * 10) / 10;
    const mean = gapsMs.length === 0 ? null : round(gapsMs.reduce((sum, gap) => sum + gap, 0) / gapsMs.length);
    const p95 = gapsMs.length === 0 ? null : round(gapsMs[Math.min(gapsMs.length - 1, Math.ceil(gapsMs.length * 0.95) - 1)]);
    const tagged = seen.filter((entry) => entry.key === 'label:t2');
    const unstamped = tagged.filter((entry) => typeof entry.stamp !== 'number').length;
    // The group is lit in a track's frame when its latest write at or before that moment (give or take 1 ms) is full strength: the
    // group's other track may have lit it a frame earlier, and then there is no new write for the second note.
    const g1Writes = watch.events.g1;
    const groupMissed = t2Lit.filter((t) => {
      const latest = g1Writes.filter((event) => event.t <= t + 1).at(-1);
      return latest === undefined || latest.opacity !== '1';
    }).length;
    report(
      "mixer: a .midi() track's light lights at the timestamp its port got, and its group's light with it",
      sent.length >= 24 &&
        inTime.length >= Math.ceil(sent.length * 0.95) &&
        tagged.length >= sent.length &&
        unstamped === 0 &&
        t2Lit.length >= sent.length &&
        groupMissed === 0,
      JSON.stringify({ portNotes: sent.length, inTime: inTime.length, gapMeanMs: mean, gapP95Ms: p95, gapMaxMs: gapsMs.length === 0 ? null : round(gapsMs.at(-1)), frameMs: round(frameMs), frames: frames.count, taggedNotes: tagged.length, unstamped, t2Lit: t2Lit.length, g1Lit: g1Lit.length, groupMissed }),
    );
  } finally {
    if (watching) await evaluateExpr(cdp, MIXER_LIGHT_WATCH_STOP);
    if (listening) await evaluateExpr(cdp, SONG_NOTE_LISTEN_STOP);
    await evaluateExpr(cdp, `(() => { if (window.__frameGaps) window.__frameGaps.on = false; })()`);
    await callTool(client, 'set_code', { code: SILENT, label: 'probe:midi mixer light done' });
  }
}

/**
 * Timeline edit checks over the fake MIDI device: a drum note of a rhythm lane (the rig puts the channel on its rhythm role) is
 * selected and dragged like any note. `setScenario` reloads the page with a fresh fake device, `dataDir` is the server's data
 * folder. The pieces use made-up neutral notes and are not heard: the fake port only records.
 */
export async function timelineMidiBlocks(context) {
  const { cdp, client, report, setScenario, dataDir } = context;
  const replState = `document.getElementById('repl').editor.repl.state`;
  const rigFile = path.join(dataDir, 'instruments.json');
  fs.writeFileSync(rigFile, JSON.stringify({ instruments: [{ id: 'mt32', model: 'mt32', port: 'Fake Synth A' }] }));
  try {
    await setScenario({ permission: 'granted' });
    const code = `drums: note("36 38 42 38").midi('Fake Synth A', { midichannel: 10 })`;
    await callTool(client, 'set_code', { code, label: 'probe:midi timeline drum drag' });
    if ((await waitFor(cdp, `${replState}.activeCode === ${JSON.stringify(code)} ? true : null`, 8000)) !== true) {
      throw new ProbeCouldNotRun('the page did not start running the code of the Timeline drum check within 8 seconds');
    }
    await evaluateExpr(cdp, `(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); })()`);
    await pressKey(cdp, '2');
    if ((await waitFor(cdp, `document.getElementById('workspace').dataset.view === 'timeline' ? true : null`, 3000)) !== true) {
      throw new ProbeCouldNotRun('the Timeline did not open');
    }
    const drawn = await waitFor(
      cdp,
      `(() => { const lane = document.querySelector('#timeline-lanes .lane[data-track="label:drums"]'); return document.getElementById('timeline-view').dataset.state === 'ok' && lane !== null && lane.dataset.drumRows !== undefined ? true : null; })()`,
      10000,
    );
    if (drawn !== true) throw new ProbeCouldNotRun('the Timeline did not draw the drum lane of this check within 10 seconds');
    const historyTop = async () => {
      const match = /^#(\d+) (.*)$/m.exec(String(await callTool(client, 'list_history', {})));
      if (match === null) throw new ProbeCouldNotRun('list_history shows no numbered row');
      return { id: Number(match[1]), row: match[2] };
    };
    // The note panel under the lanes keeps one height, so a short window leaves the lanes no room: the check uses a taller window.
    await cdp('Emulation.setDeviceMetricsOverride', { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(400);
    const remPx = await evaluateExpr(cdp, `parseFloat(getComputedStyle(document.documentElement).fontSize)`);
    // The first mark of the bass drum's row (the labels run from the top row to the bottom one).
    const bass = await evaluateExpr(
      cdp,
      `(() => {
        const lane = document.querySelector('#timeline-lanes .lane[data-track="label:drums"]');
        const labels = [...lane.querySelectorAll('.drum-row-label')].map((el) => el.textContent);
        const row = labels.indexOf('Acoustic Bass Drum');
        const mark = lane.querySelector('rect.event[data-row="' + row + '"]');
        if (row === -1 || mark === null) return null;
        mark.scrollIntoView({ block: 'nearest' });
        const r = mark.getBoundingClientRect();
        return { labels, row, x: r.x + r.width / 2, y: r.y + r.height / 2, box: [r.left, r.top, r.width, r.height] };
      })()`,
    );
    if (bass === null) throw new ProbeCouldNotRun('the drum lane draws no mark on the row of the bass drum');
    const mouse = (type, point, buttons) => cdp('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', buttons, clickCount: 1 });
    const READ = `(() => ({
      pitch: [...document.querySelectorAll('#timeline-note .tl-value')][0].textContent,
      state: document.querySelector('#timeline-note .tl-note-state').textContent,
      line: document.getElementById('timeline-note-line').textContent,
      rings: document.querySelectorAll('#timeline-lanes .tl-ring').length,
      ghosts: document.querySelectorAll('#timeline-lanes .tl-ghost').length,
      dragging: document.getElementById('timeline-lanes').getAttribute('data-dragging'),
      code: ${replState}.activeCode,
    }))()`;
    const historyBefore = await historyTop();
    await mouse('mousePressed', bass, 1);
    await mouse('mouseReleased', bass, 0);
    const selected = await waitFor(cdp, `(() => { const read = ${READ}; return read.state !== '' ? read : null; })()`, 3000);
    const ringBox = await evaluateExpr(
      cdp,
      `(() => {
        const ring = document.querySelector('#timeline-lanes .tl-ring');
        if (ring === null) return null;
        const r = ring.getBoundingClientRect();
        const style = getComputedStyle(ring);
        return { box: [r.left, r.top, r.width, r.height], outlineOffset: style.outlineOffset };
      })()`,
    );
    // Up two steps in small moves, the button held.
    const target = { x: bass.x, y: bass.y - 1.1 * remPx };
    await mouse('mousePressed', bass, 1);
    const steps = Math.ceil((1.1 * remPx) / 3);
    for (let i = 1; i <= steps; i++) await mouse('mouseMoved', { x: bass.x, y: bass.y - ((1.1 * remPx) * i) / steps }, 1);
    const held = await evaluateExpr(cdp, READ);
    const ghostBox = await evaluateExpr(
      cdp,
      `(() => {
        const ghost = document.querySelector('#timeline-lanes .tl-ghost');
        if (ghost === null) return null;
        const r = ghost.getBoundingClientRect();
        return [r.left, r.top, r.width, r.height];
      })()`,
    );
    const heldHistory = await historyTop();
    await mouse('mouseReleased', target, 0);
    const edited = code.replace('36', '38');
    const written = await waitFor(cdp, `${replState}.activeCode !== ${JSON.stringify(code)} ? ${replState}.activeCode : null`, 8000);
    const after = await waitFor(cdp, `(() => { const read = ${READ}; return read.line === 'Changed 36 to 38.' && read.rings === 1 ? read : null; })()`, 8000);
    const historyAfter = await historyTop();
    // A very narrow mark gets a mark a half rem wide (the floor of the ring and the ghost); otherwise the box is the note's.
    const sits = (a, b) => {
      const width = Math.max(b[2], 0.5 * remPx);
      return Math.abs(a[0] - b[0]) <= 1.5 && Math.abs(a[1] - b[1]) <= 1.5 && Math.abs(a[3] - b[3]) <= 1.5 && Math.abs(a[2] - width) <= 1.5;
    };
    report(
      'timeline: a drum note on a rhythm lane is selected and dragged like any note, its ring sits on its row, the preview names the drum, and the edit writes a note number',
      selected !== null &&
        selected.pitch === '36 \u00b7 Acoustic Bass Drum' &&
        selected.state === 'Editable' &&
        ringBox !== null &&
        sits(ringBox.box, bass.box) &&
        Math.abs(Number.parseFloat(ringBox.outlineOffset) - 0.25 * remPx) <= 1 &&
        held.dragging === 'pitch' &&
        held.ghosts === 1 &&
        held.line === '36 Acoustic Bass Drum \u2192 38 Acoustic Snare Drum (+2 semitones). Release to write.' &&
        held.code === code &&
        ghostBox !== null &&
        Math.abs(ghostBox[0] - bass.box[0]) <= 1.5 &&
        Math.abs(ghostBox[2] - Math.max(bass.box[2], 0.5 * remPx)) <= 1.5 &&
        Math.abs(ghostBox[1] - (bass.box[1] - 2 * 0.5 * remPx)) <= 1.5 &&
        heldHistory.id === historyBefore.id &&
        written === edited &&
        after !== null &&
        after.pitch === '38 \u00b7 Acoustic Snare Drum' &&
        after.ghosts === 0 &&
        historyAfter.id === historyBefore.id + 1 &&
        historyAfter.row.includes('changed drums: 36 to 38'),
      JSON.stringify({ labels: bass.labels, selected, ringBox, bassBox: bass.box, held, ghostBox, written: written === edited, after, historyBefore: historyBefore.id, historyAfter }),
    );
  } finally {
    await cdp('Emulation.clearDeviceMetricsOverride');
    await callTool(client, 'set_code', { code: SILENT, label: 'probe:midi timeline done' });
    fs.rmSync(rigFile, { force: true });
  }
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
    if (args.only !== null && args.only !== 'song' && args.only !== 'mixer' && args.only !== 'timeline') {
      throw new ProbeCouldNotRun(`probe:midi runs one group alone only with --only song, --only mixer or --only timeline (got ${JSON.stringify(args.only)})`);
    }
  } catch (err) {
    console.error(`probe:midi COULD NOT RUN: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 2;
    return;
  }

  let client;
  let browserChild;
  let ws;
  const tempDirs = [];
  let browserPath = '';

  try {
    browserPath = findBrowser(args);

    const { client: mcpClient, pageUrl, dataDir } = await startServerAndClient();
    client = mcpClient;
    tempDirs.push(dataDir);

    const userDataDir = freshDataDir('moontide-probe-midi-browser-');
    tempDirs.push(userDataDir);

    browserChild = spawnBrowser(browserPath, userDataDir, pageUrl, args.headful);
    closeBrowserOnSignal(browserChild, tempDirs, 'probe:midi');

    const port = await pollDevToolsPort(userDataDir, 10000);
    const target = await findPageTarget(port, pageUrl, 10000);

    ws = new WebSocket(target.webSocketDebuggerUrl);
    await waitSocketOpen(ws);
    const cdp = makeCdp(ws);
    /** Runs `read` with the Session drawer open, then closes it: the MIDI indicator, the tab segment and the (i) live in the
     * drawer, so a read of their size or a click on them needs it open, and a click elsewhere needs it closed. */
    const inDrawer = async (read) => {
      await openDrawer(cdp);
      try {
        return await read();
      } finally {
        await closeDrawer(cdp);
      }
    };
    await cdp('Runtime.enable');
    await waitConnected(cdp, 15000);
    await clickOverlay(cdp);

    // The fake Web MIDI must exist before the page scripts run, so it is installed for every new
    // document and each scenario reloads the page.
    await cdp('Page.enable');
    await cdp('Page.addScriptToEvaluateOnNewDocument', { source: FAKE_MIDI_SOURCE });

    /** Sets a silent non-MIDI code first (so the hello replay never touches MIDI), stores the scenario, reloads. */
    async function setScenario(scenario) {
      await callTool(client, 'set_code', { code: SILENT, label: 'probe:midi scenario' });
      await evaluateExpr(cdp, `localStorage.setItem(${JSON.stringify(SCENARIO_KEY)}, ${JSON.stringify(JSON.stringify(scenario))})`);
      await reloadPage(cdp);
    }

    const midiLog = () => evaluateExpr(cdp, 'window.__midiLog');

    /** Polls get_code until `test` accepts it (the page writes a mixer change a moment after the gesture, or reports a late evaluation after a tool call timed out); returns the last code. */
    const codeWhen = async (test, timeoutMs = 15000) => {
      const deadline = Date.now() + timeoutMs;
      let code = await callTool(client, 'get_code', {});
      while (!test(code) && Date.now() < deadline) {
        await sleep(300);
        code = await callTool(client, 'get_code', {});
      }
      return code;
    };

    // Helpers the instrument-control blocks share. A reload drops the page's own state, so a block calls installEvalCounter again.
    const VIEW_NAMES = { 1: 'history', 2: 'timeline', 3: 'mixer', 4: 'parts', 5: 'jam', 6: 'instruments' };
    /** Opens a view by its key: leaves the editor, closes any open view, presses the key and waits for the view. */
    async function openView(key) {
      await evaluateExpr(cdp, `(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); })()`);
      await pressKey(cdp, 'Escape');
      await pressKey(cdp, String(key));
      return waitFor(cdp, `document.getElementById('workspace').dataset.view === ${JSON.stringify(VIEW_NAMES[key])} ? true : null`, 3000);
    }
    /** Counts the evaluations the page runs from now on (window.__probeEvalCount, zeroed here); wrapped once per page load. */
    async function installEvalCounter() {
      await evaluateExpr(
        cdp,
        `(() => {
          const repl = document.getElementById('repl').editor.repl;
          window.__probeEvalCount = 0;
          if (window.__probeEvalWrapped) return;
          window.__probeEvalWrapped = true;
          const original = repl.evaluate;
          repl.evaluate = (...args) => {
            window.__probeEvalCount++;
            return original.apply(repl, args);
          };
        })()`,
      );
    }
    const evalCount = () => evaluateExpr(cdp, 'window.__probeEvalCount');

    const checks = [];
    function report(name, pass, detail) {
      checks.push({ name, pass, detail });
      console.log(`probe:midi ${pass ? 'PASS' : 'FAIL'}: ${name}: ${detail}`);
    }

    // The verdict line and the exit code, shared by the full run and the `--only` lanes.
    function summarize() {
      const passCount = checks.filter((check) => check.pass).length;
      const failCount = checks.length - passCount;
      if (failCount > 0) {
        console.log(`probe:midi FAILED: ${failCount} of ${checks.length} checks failed`);
        process.exitCode = 1;
        return;
      }
      console.log(
        `probe:midi OK: ${passCount} checks passed in the real page (${path.basename(browserPath)}, ${args.headful ? 'headful' : 'headless'})`,
      );
      process.exitCode = 0;
    }

    if (args.only === 'song') {
      await songMidiBlocks({ cdp, client, report, setScenario, dataDir });
      summarize();
      return;
    }
    if (args.only === 'mixer') {
      await mixerMidiBlocks({ cdp, client, report, setScenario, dataDir });
      summarize();
      return;
    }
    if (args.only === 'timeline') {
      await timelineMidiBlocks({ cdp, client, report, setScenario, dataDir });
      summarize();
      return;
    }

    // The permission stays unanswered for 400 ms, so a late enable would lose the first notes.
    await setScenario({ permission: 'prompt', answer: 'grant', delayMs: 400 });

    // (1) Code without .midi( never makes the page ask for MIDI access.
    await callTool(client, 'set_code', { code: 's("bd*2").gain(0)', label: 'probe:midi no midi' });
    await sleep(1000);
    const requestsWithoutMidi = await evaluateExpr(cdp, 'window.__midiRequests');
    report('no MIDI access is requested for code without .midi()', requestsWithoutMidi === 0, JSON.stringify({ requests: requestsWithoutMidi }));

    // (2) The first code with .midi( plays on the named port from its first beat.
    const logStart = (await midiLog()).length;
    const strudelLogStart = await evaluateExpr(cdp, 'window.__strudelLog.length');
    const playReply = await callTool(client, 'set_code', { code: `note("c3*8").midi('Fake Synth A')`, label: 'probe:midi first beat' });
    const arrived = await waitFor(
      cdp,
      `(() => window.__midiLog.slice(${logStart}).some((e) => e.port === 'Fake Synth A' && e.bytes.length === 3 && e.bytes[0] >= 0x90 && e.bytes[0] <= 0x9f && e.bytes[2] > 0) ? true : null)()`,
      1500,
    );
    const requestsWithMidi = await evaluateExpr(cdp, 'window.__midiRequests');
    const newLog = (await evaluateExpr(cdp, `window.__strudelLog.slice(${strudelLogStart})`)) ?? [];
    const notEnabled = newLog.filter((line) => /not enabled/i.test(line));
    const playedNotes = noteOns((await midiLog()).slice(logStart), 'Fake Synth A').length;
    report(
      'MIDI code plays from its first beat',
      playReply.includes('ok, playing') && requestsWithMidi === 1 && arrived === true && notEnabled.length === 0,
      JSON.stringify({ reply: playReply.split('\n')[0], requests: requestsWithMidi, noteOns: playedNotes, notEnabled: notEnabled.length }),
    );

    // (3) A misnamed port reaches Claude once: the next reply is quiet about it.
    const misnamedReply = await callTool(client, 'set_code', { code: `note("c3").midi('No Such Port')`, label: 'probe:midi misnamed port' });
    const nextReply = await callTool(client, 'get_code', {});
    report(
      'a misnamed port reaches Claude once',
      misnamedReply.includes('MIDI: port "No Such Port" was not found.') && !/^MIDI:/m.test(nextReply),
      JSON.stringify({ firstReplyHasNotice: misnamedReply.includes('MIDI: port "No Such Port" was not found.'), nextReplyHasMidiLine: /^MIDI:/m.test(nextReply) }),
    );

    await callTool(client, 'set_code', { code: SILENT, label: 'probe:midi reset' });

    // --- Notes leave on time (16) ---
    // Strudel's MIDI sends leave the page about NOTE_AHEAD_MS before the instant they are meant for, each with the
    // timestamp the page clock gives that instant, and a note-off carries the note-on's timestamp plus the note
    // length. 0.5 cycles per second with eight notes a cycle: 250 ms events, 240 ms notes (Strudel takes 10 ms off).
    await callTool(client, 'set_code', { code: `setcpm(30)\nnote("c3*8").midi('Fake Synth A')`, label: 'probe:midi notes on time' });
    await sleep(1500);
    const leaveMark = (await midiLog()).length;
    await sleep(2000);
    const leaveEntries = (await midiLog()).slice(leaveMark).filter((entry) => entry.port === 'Fake Synth A');
    const leaveOns = [];
    const leaveLengths = [];
    for (const [index, entry] of leaveEntries.entries()) {
      if (!(entry.bytes.length === 3 && entry.bytes[0] >= 0x90 && entry.bytes[0] <= 0x9f && entry.bytes[2] > 0)) continue;
      leaveOns.push(entry);
      const next = leaveEntries[index + 1];
      if (next !== undefined && next.bytes[0] === (entry.bytes[0] & 0x0f) + 0x80 && next.bytes[1] === entry.bytes[1] && typeof next.ts === 'number' && typeof entry.ts === 'number') {
        leaveLengths.push(next.ts - entry.ts);
      }
    }
    const leaveAheads = leaveOns.map((entry) => (typeof entry.ts === 'number' ? entry.ts - entry.t : Number.NaN));
    const leaveStamped = leaveAheads.every((ahead) => Number.isFinite(ahead) && ahead >= 60 && ahead <= 200);
    const leaveLengthsOk = leaveLengths.length >= 1 && leaveLengths.every((length) => Math.abs(length - 240) <= 1);
    report(
      "Strudel's MIDI note-ons leave ahead with a timestamp from the page clock",
      leaveOns.length >= 6 && leaveStamped && leaveLengthsOk,
      JSON.stringify({
        noteOns: leaveOns.length,
        smallestAheadMs: leaveAheads.length > 0 ? Math.min(...leaveAheads) : null,
        largestAheadMs: leaveAheads.length > 0 ? Math.max(...leaveAheads) : null,
        noteLengthsMs: [...new Set(leaveLengths.map((length) => Math.round(length * 10) / 10))],
      }),
    );
    await callTool(client, 'set_code', { code: SILENT, label: 'probe:midi reset' });

    // --- Stop ---
    // Stop releases the pedal and silences every channel of the ports the code named, raw and
    // immediate, and retires the webmidi Outputs so nothing of the stopped code plays after Play.
    await setScenario({ permission: 'prompt', answer: 'grant', delayMs: 0 });
    const panicBytes = JSON.stringify(panicMessages());
    const isNoteOn = (entry) => entry.bytes.length === 3 && entry.bytes[0] >= 0x90 && entry.bytes[0] <= 0x9f && entry.bytes[2] > 0;
    const waitForNoteOn = (marker, pitch) =>
      waitFor(
        cdp,
        `(() => window.__midiLog.slice(${marker}).some((e) => e.port === 'Fake Synth A' && e.bytes.length === 3 && e.bytes[0] >= 0x90 && e.bytes[0] <= 0x9f && e.bytes[2] > 0 && (${pitch} === null || e.bytes[1] === ${pitch})) ? true : null)()`,
        3000,
      );
    /** The log entries from the first sustain release after `marker` on: where Stop's silence starts. */
    const silenceAfter = async (marker) => {
      const after = (await midiLog()).slice(marker);
      const start = after.findIndex((entry) => entry.bytes.length === 3 && entry.bytes[0] === 0xb0 && entry.bytes[1] === 64);
      return start === -1 ? [] : after.slice(start);
    };
    const onPort = (entries, name) => entries.filter((entry) => entry.port === name);
    const resetStopTo = async (code, label) => {
      await callTool(client, 'set_code', { code, label });
    };

    await callTool(client, 'set_code', { code: `note("c3*8").midi('Fake Synth A')`, label: 'probe:midi stop' });
    await waitForNoteOn(0, 48);
    let marker = (await midiLog()).length;
    await stopMusic(cdp);
    await sleep(500);
    const silence = await silenceAfter(marker);
    const onA = onPort(silence, 'Fake Synth A');
    const exactBytes = JSON.stringify(onA.map((entry) => entry.bytes)) === panicBytes;
    const allRaw = onA.every((entry) => entry.ts === null);
    const reachedB = onPort((await midiLog()).slice(marker), 'Fake Synth B').length;
    report(
      'Stop sends sustain release then All Notes Off on every channel of the port in use',
      exactBytes && allRaw && reachedB === 0 && silence.length === onA.length,
      JSON.stringify({ messagesOnA: onA.length, exactBytes, allWithoutTimestamp: allRaw, bytesOnUnnamedPort: reachedB, otherEntries: silence.length - onA.length }),
    );

    marker = (await midiLog()).length;
    await resetStopTo(`note("c7*2").midi('Fake Synth A')`, 'probe:midi stop then play');
    await sleep(1500);
    const afterPlay = noteOns((await midiLog()).slice(marker), 'Fake Synth A');
    const stoppedNotes = afterPlay.filter((entry) => entry.bytes[1] !== 96).length;
    report(
      'Stop then play sends no note of the stopped code',
      afterPlay.length > 0 && stoppedNotes === 0,
      JSON.stringify({ noteOns: afterPlay.length, notesOfTheStoppedCode: stoppedNotes }),
    );

    await evaluateExpr(cdp, `window.__unplug('Fake Synth A')`);
    await sleep(500);
    marker = (await midiLog()).length;
    await evaluateExpr(cdp, `window.__plug('Fake Synth A')`);
    const resumed = await waitForNoteOn(marker, 96);
    report(
      'after Stop and Play an unplugged port plays again when it is back, without a new evaluation',
      resumed === true,
      JSON.stringify({ resumed: resumed === true }),
    );

    // The port above was unplugged and plugged back, so its Output is in both webmidi lists, as at the
    // bench. A Stop must leave no retired Output behind in the disconnected list, or the next replug puts it back.
    await stopMusic(cdp);
    await sleep(500);
    const disconnectedAfterStop = await evaluateExpr(cdp, 'globalThis.WebMidi._disconnectedOutputs.length');
    marker = (await midiLog()).length;
    await callTool(client, 'set_code', { code: `note("c7*2").midi('Fake Synth A')`, label: 'probe:midi replug after stop' });
    await waitForNoteOn(marker, 96);
    await evaluateExpr(cdp, `window.__unplug('Fake Synth A')`);
    await sleep(500);
    marker = (await midiLog()).length;
    await evaluateExpr(cdp, `window.__plug('Fake Synth A')`);
    const resumedAfterStop = await waitForNoteOn(marker, 96);
    report(
      'a port unplugged and plugged back before a Stop plays again after Stop, Play and another replug',
      resumedAfterStop === true && disconnectedAfterStop === 0,
      JSON.stringify({ resumed: resumedAfterStop === true, disconnectedAfterStop }),
    );

    marker = (await midiLog()).length;
    await callTool(client, 'stop', {});
    await sleep(500);
    const toolSilence = onPort(await silenceAfter(marker), 'Fake Synth A');
    report(
      'the stop tool sends the same silence',
      JSON.stringify(toolSilence.map((entry) => entry.bytes)) === panicBytes,
      JSON.stringify({ messagesOnA: toolSilence.length }),
    );

    await resetStopTo(`note("c7*2").midi('Fake Synth A')`, 'probe:midi stop with a failing suspend');
    await sleep(800);
    await evaluateExpr(
      cdp,
      `(() => {
        const context = getAudioContext();
        const original = context.suspend.bind(context);
        context.suspend = () => {
          context.suspend = original;
          return Promise.reject(new Error('probe: suspend refused'));
        };
      })()`,
    );
    marker = (await midiLog()).length;
    await stopMusic(cdp);
    await sleep(500);
    const failedSuspendSilence = onPort(await silenceAfter(marker), 'Fake Synth A');
    const consoleErrors = await evaluateExpr(cdp, 'window.__consoleErrors');
    const suspendLogged = consoleErrors.some((line) => line.includes('AudioContext.suspend() failed'));
    report(
      'a failing AudioContext suspend still silences MIDI',
      JSON.stringify(failedSuspendSilence.map((entry) => entry.bytes)) === panicBytes && suspendLogged,
      JSON.stringify({ messagesOnA: failedSuspendSilence.length, suspendLogged }),
    );

    // A fresh page: no port named yet and Web MIDI not enabled.
    await setScenario({ permission: 'prompt', answer: 'grant', delayMs: 0 });
    await stopMusic(cdp);
    await sleep(500);
    const freshLog = await midiLog();
    const freshErrors = (await evaluateExpr(cdp, 'window.__consoleErrors')).filter((line) => line.startsWith('Moontide:'));
    report(
      'Stop with no port named since page load sends no MIDI bytes and does not throw',
      freshLog.length === 0 && freshErrors.length === 0,
      JSON.stringify({ midiEntries: freshLog.length, moontideErrors: freshErrors }),
    );

    await callTool(client, 'set_code', { code: SILENT, label: 'probe:midi stop reset' });

    // Stop and the notes already queued ahead: Chrome cannot take a queued note-on back, so Stop sends the
    // note-off of each one QUEUED_NOTE_OFF_AFTER_MS after the note's own timestamp, before the panic bytes. A 62.5 ms
    // grid always leaves one or two note-ons in the queue (they leave 120 ms ahead).
    await setScenario({ permission: 'prompt', answer: 'grant', delayMs: 0 });
    marker = (await midiLog()).length;
    await callTool(client, 'set_code', { code: `setcpm(30)\nnote("c3*32").midi('Fake Synth A')`, label: 'probe:midi stop queued notes' });
    await waitForNoteOn(marker, null);
    await sleep(600);
    await stopMusic(cdp);
    await sleep(500);
    const queuedEntries = onPort((await midiLog()).slice(marker), 'Fake Synth A');
    const firstSilence = queuedEntries.findIndex((entry) => entry.bytes.length === 3 && entry.bytes[0] === 0xb0 && entry.bytes[1] === 64);
    const queuedBefore = firstSilence === -1 ? [] : queuedEntries.slice(0, firstSilence);
    const silenceStartedAt = firstSilence === -1 ? Number.NaN : queuedEntries[firstSilence].t;
    const stillQueued = queuedBefore.filter((entry) => isNoteOn(entry) && typeof entry.ts === 'number' && entry.ts > silenceStartedAt);
    const queuedEnded = stillQueued.filter((entry) =>
      queuedBefore.some(
        (off) =>
          off.bytes.length === 3 &&
          off.bytes[0] === 0x80 + (entry.bytes[0] & 0x0f) &&
          off.bytes[1] === entry.bytes[1] &&
          off.bytes[2] === 0 &&
          typeof off.ts === 'number' &&
          Math.abs(off.ts - (entry.ts + QUEUED_NOTE_OFF_AFTER_MS)) < 0.01,
      ),
    );
    const panicFollows = firstSilence !== -1 && JSON.stringify(queuedEntries.slice(firstSilence).map((entry) => entry.bytes)) === panicBytes && queuedEntries.slice(firstSilence).every((entry) => entry.ts === null);
    report(
      'Stop ends every Strudel note-on still queued to sound after it',
      stillQueued.length >= 1 && queuedEnded.length === stillQueued.length && panicFollows,
      JSON.stringify({ queuedNoteOns: stillQueued.length, endedBeforeTheSilence: queuedEnded.length, panicFollowsExactly: panicFollows, entriesBeforeTheSilence: queuedBefore.length }),
    );
    await callTool(client, 'set_code', { code: SILENT, label: 'probe:midi stop queued reset' });

    // --- Ports ---
    // Unplugging a port mid-play reaches Claude once; plugging it back reaches Claude once and the
    // notes resume by themselves on the same code (Strudel looks the port up by name on every hap).
    await setScenario({ permission: 'prompt', answer: 'grant', delayMs: 0 });
    marker = (await midiLog()).length;
    await callTool(client, 'set_code', { code: `note("c3*8").midi('Fake Synth A')`, label: 'probe:midi ports' });
    await waitForNoteOn(marker, null);
    const versionText = () => evaluateExpr(cdp, `document.getElementById('version-indicator').textContent`);
    const versionBefore = await versionText();
    await evaluateExpr(cdp, `window.__unplug('Fake Synth A')`);
    await sleep(500);
    const unpluggedReply = await callTool(client, 'get_code', {});
    const afterUnpluggedReply = await callTool(client, 'get_code', {});
    const unpluggedLine = midiPortUnpluggedLine('Fake Synth A', ['Fake Synth B']);
    report(
      'an unplugged port is said to Claude once',
      unpluggedReply.includes(unpluggedLine) && !/^MIDI:/m.test(afterUnpluggedReply),
      JSON.stringify({ firstReplyHasLine: unpluggedReply.includes(unpluggedLine), nextReplyHasMidiLine: /^MIDI:/m.test(afterUnpluggedReply) }),
    );

    marker = (await midiLog()).length;
    await evaluateExpr(cdp, `window.__plug('Fake Synth A')`);
    await sleep(1500);
    const backReply = await callTool(client, 'get_code', {});
    const resumedAfterBack = noteOns((await midiLog()).slice(marker), 'Fake Synth A').length;
    const versionAfter = await versionText();
    report(
      'a port that comes back is said to Claude and plays again without a new evaluation',
      backReply.includes(midiPortBackLine('Fake Synth A')) && resumedAfterBack > 0 && versionAfter === versionBefore,
      JSON.stringify({ lineSaid: backReply.includes(midiPortBackLine('Fake Synth A')), noteOnsAfterReturn: resumedAfterBack, versionChanged: versionAfter !== versionBefore }),
    );
    await callTool(client, 'set_code', { code: SILENT, label: 'probe:midi ports reset' });

    // --- Permission ---
    // Web MIDI is enabled at page start only when the permission is already granted; otherwise the
    // first MIDI evaluation asks and waits, so the first beat is heard; denied and "no Web MIDI" are
    // each said to Claude once while other tracks keep playing.
    const rejection = async (promise) => {
      try {
        await promise;
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
      return null;
    };
    const anyNoteOnAfter = (from, timeoutMs) =>
      waitFor(
        cdp,
        `(() => window.__midiLog.slice(${from}).some((e) => e.port === 'Fake Synth A' && e.bytes.length === 3 && e.bytes[0] >= 0x90 && e.bytes[0] <= 0x9f && e.bytes[2] > 0) ? true : null)()`,
        timeoutMs,
      );

    await setScenario({ permission: 'prompt' });
    await sleep(1000);
    const requestsAtStart = await evaluateExpr(cdp, 'window.__midiRequests');
    report('with the permission unanswered, page start asks for nothing', requestsAtStart === 0, JSON.stringify({ requests: requestsAtStart }));

    await setScenario({ permission: 'granted' });
    await sleep(1000);
    const requestsGranted = await evaluateExpr(cdp, 'window.__midiRequests');
    const enabledAtStart = await evaluateExpr(cdp, 'globalThis.WebMidi.enabled === true');
    marker = (await midiLog()).length;
    await callTool(client, 'set_code', { code: `note("c3*8").midi('Fake Synth A')`, label: 'probe:midi granted' });
    const playedGranted = await anyNoteOnAfter(marker, 1500);
    report(
      'with the permission granted, Web MIDI is enabled at page start without a prompt',
      requestsGranted === 1 && enabledAtStart === true && playedGranted === true,
      JSON.stringify({ requestsBeforeAnyMidiCode: requestsGranted, enabled: enabledAtStart, played: playedGranted === true }),
    );

    // A driver that never answers requestMIDIAccess at page start must not keep the page from connecting.
    let connectedWhileHung = true;
    try {
      await setScenario({ permission: 'granted', answer: 'hang' });
    } catch (err) {
      if (!(err instanceof ProbeCouldNotRun)) throw err;
      connectedWhileHung = false;
    }
    const requestsHung = connectedWhileHung ? await evaluateExpr(cdp, 'window.__midiRequests') : null;
    report(
      'a Web MIDI that never answers at page start does not keep the page from connecting',
      connectedWhileHung && requestsHung === 1,
      JSON.stringify({ connected: connectedWhileHung, requests: requestsHung }),
    );

    await setScenario({ permission: 'prompt', answer: 'grant', delayMs: 7000 });
    marker = (await midiLog()).length;
    const slowPromptCode = `note("c3*8").midi('Fake Synth A')`;
    const waitText = await rejection(callTool(client, 'set_code', { code: slowPromptCode, label: 'probe:midi slow prompt' }));
    const playedAfterWait = await anyNoteOnAfter(marker, 4000);
    // The page sends its late report only after watching the first cycle (FIRST_CYCLE_WATCH_MS), while the first
    // note-on goes out at once, so one get_code read right after a note-on could run before the server stored
    // the code (the flake). The check waits for that stored code instead, bounded at 10 s.
    const codeWaitStart = Date.now();
    const codeAfterWait = await codeWhen((reply) => reply.includes(slowPromptCode), 10000);
    const codeWaitMs = Date.now() - codeWaitStart;
    report(
      'a reply that outlasts the permission prompt says the page is waiting',
      waitText !== null && waitText.startsWith(MIDI_PERMISSION_WAIT_MESSAGE) && playedAfterWait === true && codeAfterWait.includes(slowPromptCode),
      JSON.stringify({ rejectedWith: waitText === null ? null : waitText.slice(0, 120), playedAfterTheAnswer: playedAfterWait === true, getCodeHasTheCode: codeAfterWait.includes(slowPromptCode), codeWaitMs }),
    );

    await setScenario({ permission: 'prompt', answer: 'deny' });
    marker = (await midiLog()).length;
    const deniedReply = await callTool(client, 'set_code', {
      code: `stack(note("c3*4").midi('Fake Synth A'), s("bd*2").gain(0))`,
      label: 'probe:midi denied',
    });
    await sleep(1500);
    const afterDenied = await callTool(client, 'get_code', {});
    const deniedNotes = noteOns((await midiLog()).slice(marker), 'Fake Synth A').length;
    const askedAgain = (await evaluateExpr(cdp, 'window.__consoleErrors')).filter((line) => line.includes('asked for Web MIDI again')).length;
    report(
      'a denied permission is said to Claude once and other tracks keep playing',
      deniedReply.startsWith('ok, playing') && deniedReply.includes(MIDI_DENIED_LINE) && !/^MIDI:/m.test(afterDenied) && deniedNotes === 0 && askedAgain <= 1,
      JSON.stringify({ reply: deniedReply.split('\n')[0], lineSaid: deniedReply.includes(MIDI_DENIED_LINE), nextReplyHasMidiLine: /^MIDI:/m.test(afterDenied), noteOns: deniedNotes, askedAgainLines: askedAgain }),
    );
    await callTool(client, 'set_code', { code: SILENT, label: 'probe:midi denied reset' });

    await setScenario({ webMidi: false });
    marker = (await midiLog()).length;
    const unsupportedReply = await callTool(client, 'set_code', {
      code: `stack(s("bd*2").gain(0), note("c3*4").midi('Fake Synth A'))`,
      label: 'probe:midi no web midi',
    });
    await sleep(1500);
    const noMidiState = await evaluateExpr(
      cdp,
      `(() => { const state = document.getElementById('repl').editor.repl.state; return { started: state.started === true, evalError: state.evalError ? String(state.evalError.message || state.evalError) : null }; })()`,
    );
    const noMidiSent = (await midiLog()).length - marker;
    const noMidiRequests = await evaluateExpr(cdp, 'window.__midiRequests');
    const noMidiErrors = (await evaluateExpr(cdp, 'window.__consoleErrors')).filter((line) => line.includes('does not support WebMIDI')).length;
    report(
      'in a browser without Web MIDI a piece with a browser track and a .midi() track plays, and Claude is told only the .midi() tracks are silent',
      unsupportedReply.startsWith('ok, playing') &&
        unsupportedReply.includes(MIDI_UNSUPPORTED_LINE) &&
        noMidiState.started === true &&
        !noMidiState.evalError &&
        noMidiSent === 0 &&
        noMidiRequests === 0 &&
        noMidiErrors === 0,
      JSON.stringify({
        reply: unsupportedReply.split('\n')[0],
        lineSaid: unsupportedReply.includes(MIDI_UNSUPPORTED_LINE),
        started: noMidiState.started,
        evalError: noMidiState.evalError,
        midiMessagesSent: noMidiSent,
        midiRequests: noMidiRequests,
        webMidiErrorLines: noMidiErrors,
      }),
    );
    await callTool(client, 'set_code', { code: SILENT, label: 'probe:midi no web midi reset' });

    // --- Port cases ---
    // A call with no port, an ambiguous name, zero outputs and an unreadable port each reach Claude as
    // one true line, the notes go where Strudel sends them, and nothing repeats per cycle.
    const grantedWith = (outputs) => setScenario({ permission: 'granted', answer: 'grant', outputs });
    const noteOnPorts = async (from) => [...new Set(noteOnsOnAnyPort(await midiLog(), from))];

    await grantedWith(['Fake Synth A', 'Fake IAC Bus 1']);
    marker = (await midiLog()).length;
    const noPortReply = await callTool(client, 'set_code', { code: `note("c3*4").midi()`, label: 'probe:midi no port' });
    await sleep(1500);
    const noPortPorts = await noteOnPorts(marker);
    report(
      'a .midi() call with no port plays on the output Strudel picks, and Claude is told which',
      noPortReply.includes(midiNoPortLine('Fake IAC Bus 1')) && noPortPorts.length === 1 && noPortPorts[0] === 'Fake IAC Bus 1',
      JSON.stringify({ lineSaid: noPortReply.includes(midiNoPortLine('Fake IAC Bus 1')), noteOnPorts: noPortPorts }),
    );

    await grantedWith(['Fake Synth A', 'Fake Synth B']);
    marker = (await midiLog()).length;
    const ambiguousReply = await callTool(client, 'set_code', { code: `note("c3*4").midi('Fake Synth')`, label: 'probe:midi ambiguous' });
    await sleep(1500);
    const ambiguousPorts = await noteOnPorts(marker);
    const ambiguousLine = midiPortAmbiguousLine('Fake Synth', ['Fake Synth A', 'Fake Synth B']);
    report(
      'an ambiguous port name is said with every match and plays on the first',
      ambiguousReply.includes(ambiguousLine) && ambiguousPorts.length === 1 && ambiguousPorts[0] === 'Fake Synth A',
      JSON.stringify({ lineSaid: ambiguousReply.includes(ambiguousLine), noteOnPorts: ambiguousPorts }),
    );

    await grantedWith([]);
    const zeroReply = await callTool(client, 'set_code', { code: `note("c3*4").midi('Fake Synth A')`, label: 'probe:midi zero outputs' });
    await sleep(2000);
    const zeroNext = await callTool(client, 'get_code', {});
    const countOf = (text, needle) => text.split(needle).length - 1;
    report(
      'zero outputs are said once, never per cycle',
      countOf(zeroReply, MIDI_NO_OUTPUTS_LINE) === 1 && !zeroReply.includes('No MIDI devices found') && !zeroNext.includes('No MIDI devices found') && !/^MIDI:/m.test(zeroNext),
      JSON.stringify({ lineCount: countOf(zeroReply, MIDI_NO_OUTPUTS_LINE), runtimeLineInFirstReply: zeroReply.includes('No MIDI devices found'), runtimeLineInNextReply: zeroNext.includes('No MIDI devices found'), nextReplyHasMidiLine: /^MIDI:/m.test(zeroNext) }),
    );

    await grantedWith(['Fake Synth A', 'Fake Synth B']);
    const unreadableReply = await callTool(client, 'set_code', {
      code: `let port = 'Fake Synth A'\nnote("c3*4").midi(port)`,
      label: 'probe:midi unreadable port',
    });
    await sleep(800);
    marker = (await midiLog()).length;
    await stopMusic(cdp);
    await sleep(500);
    const afterStop = (await midiLog()).slice(marker);
    const panicCount = (name) => afterStop.filter((entry) => entry.port === name && entry.bytes.length === 3 && entry.bytes[0] >= 0xb0 && entry.bytes[0] <= 0xbf).length;
    report(
      'an unreadable port is said once and Stop silences every connected output',
      unreadableReply.includes(MIDI_UNREADABLE_LINE) && panicCount('Fake Synth A') === 32 && panicCount('Fake Synth B') === 32,
      JSON.stringify({ lineSaid: unreadableReply.includes(MIDI_UNREADABLE_LINE), controlChangesOnA: panicCount('Fake Synth A'), controlChangesOnB: panicCount('Fake Synth B') }),
    );
    await callTool(client, 'set_code', { code: SILENT, label: 'probe:midi port cases reset' });

    // --- Second tab ---
    // A second Moontide tab takes the active role: the first tab stops with the MIDI panic and refuses
    // to play again on its own. The second tab gets the same fake Web MIDI (installed on its own
    // connection before the page loads), so it never reaches a real port.
    await setScenario({ permission: 'prompt', answer: 'grant', delayMs: 0 });
    await callTool(client, 'set_code', { code: `note("c3*8").midi('Fake Synth A')`, label: 'probe:midi second tab' });
    await waitForNoteOn(0, 48);
    marker = (await midiLog()).length;
    const secondTab = { id: null, ws: null, cdp: null };
    const openSecondTab = async () => {
      const created = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' });
      if (!created.ok) throw new Error(`/json/new answered ${created.status}`);
      const info = await created.json();
      secondTab.id = info.id;
      secondTab.ws = new WebSocket(info.webSocketDebuggerUrl);
      await waitSocketOpen(secondTab.ws);
      secondTab.cdp = makeCdp(secondTab.ws);
      await secondTab.cdp('Runtime.enable');
      await secondTab.cdp('Page.enable');
      await secondTab.cdp('Page.addScriptToEvaluateOnNewDocument', { source: FAKE_MIDI_SOURCE });
      await secondTab.cdp('Page.navigate', { url: pageUrl });
      await waitConnected(secondTab.cdp, 15000);
    };
    const closeSecondTab = async () => {
      if (secondTab.ws !== null) {
        try {
          secondTab.ws.close();
        } catch {
          // already closed
        }
      }
      if (secondTab.id !== null) {
        await fetch(`http://127.0.0.1:${port}/json/close/${secondTab.id}`).catch(() => {});
      }
    };
    const soundLabel = () => evaluateExpr(cdp, `document.querySelector('#sound-state .state-label').textContent`);
    try {
      // The first tab's AudioContext suspend settles only after 1 s: the superseded tab's silence must not
      // wait for it, or a late panic could cut the first notes of the tab that takes over (the panic is
      // read 300 ms after the second tab opens, below).
      await evaluateExpr(
        cdp,
        `(() => {
          const context = getAudioContext();
          const original = context.suspend.bind(context);
          context.suspend = () => {
            context.suspend = original;
            return new Promise((resolve) => setTimeout(() => resolve(original()), 1000)).finally(() => {
              window.__probeSlowSuspendLanded = true;
            });
          };
        })()`,
      );
      await openSecondTab();
      const stoppedLabel = await waitFor(
        cdp,
        `(() => document.querySelector('#sound-state .state-label').textContent === ${JSON.stringify(SOUND_LABELS.stopped)} ? true : null)()`,
        5000,
      );
      await sleep(300);
      const afterSupersede = (await midiLog()).slice(marker);
      const supersedeSilence = onPort(afterSupersede.filter((entry) => entry.bytes.length === 3 && entry.bytes[0] >= 0xb0 && entry.bytes[0] <= 0xbf), 'Fake Synth A');
      const panicSeen = supersedeSilence.length >= 32;
      marker = (await midiLog()).length;
      await evaluateExpr(cdp, `document.dispatchEvent(new CustomEvent('repl-evaluate'))`);
      await sleep(1500);
      const refusedLabel = await soundLabel();
      const afterRefusal = noteOnsOnAnyPort(await midiLog(), marker);
      const errorText = await evaluateExpr(cdp, `(() => { const el = document.getElementById('eval-error'); return el.hidden ? null : el.textContent; })()`);
      const consoleErrors = (await evaluateExpr(cdp, 'window.__consoleErrors')) ?? [];
      const refusedLogged = consoleErrors.some((line) => line.includes('evaluation refused'));
      report(
        'a superseded tab stops with the panic and refuses to play again',
        stoppedLabel === true &&
          refusedLabel === SOUND_LABELS.stopped &&
          panicSeen &&
          afterRefusal.length === 0 &&
          errorText === 'Error: Moontide is playing in another tab, so this tab does not play.' &&
          refusedLogged,
        JSON.stringify({ stoppedLabel: stoppedLabel === true, labelAfterRefusal: refusedLabel, panicMessagesOnA: supersedeSilence.length, noteOnsAfterRefusal: afterRefusal.length, errorText, refusedLogged }),
      );

      // The segment of the superseded tab: visible in the Session drawer, with the copy, and neutral (no accent, no destructive).
      const segment = await inDrawer(() => evaluateExpr(
        cdp,
        `(() => {
          const box = document.getElementById('midi-takeover');
          const button = document.getElementById('take-back');
          const resolve = (name) => {
            const el = document.createElement('span');
            el.style.color = 'var(' + name + ')';
            document.body.appendChild(el);
            const color = getComputedStyle(el).color;
            el.remove();
            return color;
          };
          const style = getComputedStyle(button);
          const reserved = ['--accent', '--accent-2', '--destructive'].map(resolve);
          const used = [getComputedStyle(box).color, style.color, style.boxShadow];
          return {
            visible: !box.hidden && box.getBoundingClientRect().width > 0,
            text: document.getElementById('midi-takeover-text').textContent,
            button: button.textContent,
            enabled: !button.disabled,
            neutral: used.every((value) => reserved.every((color) => !value.includes(color))),
            errorLineInBanner: document.getElementById('eval-error').parentElement.id === 'problem-banner',
            reserved,
            used,
          };
        })()`,
      ));
      report(
        'the segment and its button use no accent or destructive color',
        segment.neutral === true && segment.errorLineInBanner === true,
        JSON.stringify({ neutral: segment.neutral, errorLineInBanner: segment.errorLineInBanner, used: segment.used }),
      );

      // "Play in this tab": the click reads its pending state in the same task (before any message can
      // arrive), then the server's hello brings the role, the segment hides and the notes come back.
      // A real AudioContext runs suspend and resume in call order, but the slow suspend above calls the real
      // one only when its timer fires, which in this hidden tab can be 2 s after the take-over (hidden timers
      // run on whole seconds). The click waits for it, or that suspend would undo the resume of the click.
      const slowSuspendLanded = await waitFor(cdp, 'window.__probeSlowSuspendLanded === true ? true : null', 5000);
      // The bench ordering: the superseded tab's AudioContext is already running again when the click
      // comes (resumed by hand here), while its top bar still says Stopped, so no statechange is left to redraw it.
      const contextBeforeClick = await evaluateExpr(cdp, `(async () => { await getAudioContext().resume(); return getAudioContext().state; })()`);
      const labelBeforeClick = await soundLabel();
      marker = (await midiLog()).length;
      const pending = await evaluateExpr(
        cdp,
        `(() => {
          const button = document.getElementById('take-back');
          button.click();
          return { text: button.textContent, disabled: button.disabled };
        })()`,
      );
      const segmentHidden = await waitFor(cdp, `(() => document.getElementById('midi-takeover').hidden ? true : null)()`, 5000);
      const notesBack = await waitForNoteOn(marker, 48);
      // The other tab shows its segment in its Session drawer (shown with a box, which a hidden element never has).
      await openDrawer(secondTab.cdp);
      const otherSegment = await waitFor(
        secondTab.cdp,
        `(() => { const box = document.getElementById('midi-takeover'); return !box.hidden && box.getBoundingClientRect().width > 0 ? true : null; })()`,
        5000,
      );
      await closeDrawer(secondTab.cdp);
      const labelBack = await soundLabel();
      // The refusal line of the superseded time must not outlive it: the replay's evaluation clears it.
      const errorLineAfter = await evaluateExpr(cdp, `(() => { const el = document.getElementById('eval-error'); return el.hidden ? null : el.textContent; })()`);
      report(
        'Play in this tab takes the role back and the other tab shows its segment',
        slowSuspendLanded === true &&
          contextBeforeClick === 'running' &&
          labelBeforeClick === SOUND_LABELS.stopped &&
          segment.visible === true &&
          segment.text === 'Moontide is playing in another tab' &&
          segment.button === 'Play in this tab' &&
          segment.enabled === true &&
          pending.text === 'Taking over\u2026' &&
          pending.disabled === true &&
          segmentHidden === true &&
          notesBack === true &&
          otherSegment === true &&
          labelBack === SOUND_LABELS.playing &&
          errorLineAfter === null,
        JSON.stringify({
          slowSuspendLanded: slowSuspendLanded === true,
          contextBeforeClick,
          labelBeforeClick,
          segment: { visible: segment.visible, text: segment.text, button: segment.button, enabled: segment.enabled },
          pending,
          segmentHidden: segmentHidden === true,
          notesBack: notesBack === true,
          otherTabShowsSegment: otherSegment === true,
          labelBack,
          errorLineAfter,
        }),
      );

      // The superseded tab must not stay in a dead end when the tab that plays goes away. A reload of
      // the playing tab leaves the other tab saying another tab plays; a closed playing tab makes it say
      // that no tab plays, and its button still takes the role.
      const segmentSays = (text) =>
        `(() => { const box = document.getElementById('midi-takeover'); return !box.hidden && document.getElementById('midi-takeover-text').textContent === ${JSON.stringify(text)} ? true : null; })()`;
      await callTool(client, 'set_code', { code: SILENT, label: 'probe:midi dead end' });
      await evaluateExpr(secondTab.cdp, `document.getElementById('take-back').click()`);
      await waitFor(secondTab.cdp, `(() => document.getElementById('midi-takeover').hidden ? true : null)()`, 5000);
      await waitFor(cdp, segmentSays('Moontide is playing in another tab'), 5000);
      // Now the second tab plays and the first tab is superseded: the second tab goes away.
      await secondTab.cdp('Page.navigate', { url: 'about:blank' });
      const noTabText = await waitFor(cdp, segmentSays('No tab is playing'), 5000);
      const takeBackEnabled = await evaluateExpr(cdp, `!document.getElementById('take-back').disabled`);
      await evaluateExpr(cdp, `document.getElementById('take-back').click()`);
      const tookRole = await waitFor(cdp, `(() => document.getElementById('midi-takeover').hidden ? true : null)()`, 5000);
      // The second tab comes back and plays (the last page to authenticate wins); reloading it must leave
      // the first tab saying that another tab plays, not that none does.
      await secondTab.cdp('Page.navigate', { url: pageUrl });
      await waitConnected(secondTab.cdp, 15000);
      await waitFor(cdp, segmentSays('Moontide is playing in another tab'), 5000);
      await reloadPage(secondTab.cdp);
      await sleep(800);
      const backToAnotherTab = await waitFor(cdp, segmentSays('Moontide is playing in another tab'), 5000);
      report(
        'a superseded tab says that no tab plays when the active tab goes away, and its button takes the role',
        noTabText === true && takeBackEnabled === true && tookRole === true && backToAnotherTab === true,
        JSON.stringify({ noTabText: noTabText === true, takeBackEnabled, tookRole: tookRole === true, anotherTabAfterItsBack: backToAnotherTab === true }),
      );

      // The facts a tab sends when it takes the role back describe the code that plays now (the hello
      // replay), not the old code of this tab. The first tab ends with a missing-port code as its own
      // active code, is superseded, and takes the role back while the server holds a silent code.
      const hiddenTakeOver = () => waitFor(cdp, `(() => document.getElementById('midi-takeover').hidden ? true : null)()`, 5000);
      await evaluateExpr(cdp, `document.getElementById('take-back').click()`);
      await hiddenTakeOver();
      await callTool(client, 'set_code', { code: `note("c3").midi('No Such Port')`, label: 'probe:midi facts after take-over' });
      await evaluateExpr(secondTab.cdp, `document.getElementById('take-back').click()`);
      await waitFor(cdp, segmentSays('Moontide is playing in another tab'), 5000);
      await waitFor(secondTab.cdp, `(() => document.getElementById('midi-takeover').hidden ? true : null)()`, 5000);
      await callTool(client, 'set_code', { code: SILENT, label: 'probe:midi facts after take-over silent' });
      await evaluateExpr(
        cdp,
        `(() => {
          window.__factsSent = [];
          const original = WebSocket.prototype.send;
          WebSocket.prototype.send = function (data) {
            try {
              const message = JSON.parse(data);
              if (message.type === 'midi-state') window.__factsSent.push(message);
            } catch {
              // not JSON: not a fact
            }
            return original.call(this, data);
          };
        })()`,
      );
      await evaluateExpr(cdp, `document.getElementById('take-back').click()`);
      await hiddenTakeOver();
      await sleep(800);
      const factsSent = (await evaluateExpr(cdp, 'window.__factsSent')) ?? [];
      const staleFacts = factsSent.filter((facts) => JSON.stringify(facts).includes('No Such Port'));
      report(
        'the facts sent after a take-over describe the code that plays now, not the old code of the tab',
        factsSent.length >= 1 && staleFacts.length === 0,
        JSON.stringify({ factsSent: factsSent.length, staleFacts: staleFacts.length }),
      );
    } finally {
      await closeSecondTab();
    }
    // With the second tab gone nobody is the active page, so the first tab is reloaded: a reloaded tab
    // authenticates again and becomes the active page (and is not a second tab).
    await reloadPage(cdp);
    await callTool(client, 'set_code', { code: SILENT, label: 'probe:midi second tab reset' });

    // --- Indicator ---
    // The top-bar MIDI indicator shows the port state for code that uses MIDI, from the same facts Claude
    // hears: one dot per named port, filled when connected and a hollow ring when missing.
    const indicatorNow = () =>
      inDrawer(() =>
        evaluateExpr(
          cdp,
          `(() => {
            const box = document.getElementById('midi-state');
            return {
              visible: !box.hidden && box.getBoundingClientRect().width > 0,
              text: document.getElementById('midi-state-text').textContent,
              attention: box.dataset.attention === 'true',
              dots: Array.from(document.querySelectorAll('#midi-dots .midi-dot')).map((dot) => ({ kind: dot.dataset.kind, title: dot.title })),
            };
          })()`,
        ),
      );
    const waitIndicatorText = (text, timeoutMs) =>
      waitFor(
        cdp,
        `(() => { const box = document.getElementById('midi-state'); return !box.hidden && document.getElementById('midi-state-text').textContent === ${JSON.stringify(text)} ? true : null; })()`,
        timeoutMs,
      );

    await setScenario({ permission: 'granted' });
    await callTool(client, 'set_code', { code: `note("c3*4").midi('Fake Synth A')`, label: 'probe:midi indicator' });
    const shownConnected = await waitIndicatorText('MIDI: Fake Synth A connected', 5000);
    // The Session button's count and the MIDI card: MIDI counts while the indicator asks for attention.
    const sessionRead = () =>
      inDrawer(() =>
        evaluateExpr(
          cdp,
          `(() => {
            const button = document.getElementById('session-button');
            const count = document.getElementById('session-count');
            const card = document.getElementById('session-card-midi');
            return {
              count: count.hidden ? null : count.textContent,
              name: button.getAttribute('aria-label'),
              title: button.getAttribute('title'),
              cardShown: card.getClientRects().length > 0 && card.getBoundingClientRect().width > 0,
              cardNeeds: card.dataset.needs,
            };
          })()`,
        ),
      );
    const connectedNow = await indicatorNow();
    const sessionConnected = await sessionRead();
    await evaluateExpr(cdp, `window.__unplug('Fake Synth A')`);
    const shownUnplugged = await waitIndicatorText('MIDI: Fake Synth A unplugged', 3000);
    const unpluggedNow = await indicatorNow();
    const sessionUnplugged = await sessionRead();
    report(
      'the Session count includes MIDI when a used port is unplugged, and the MIDI card is rendered',
      sessionConnected.count === null &&
        sessionConnected.name === 'Session' &&
        sessionConnected.cardShown === true &&
        sessionConnected.cardNeeds === 'false' &&
        sessionUnplugged.count === '1' &&
        sessionUnplugged.name === 'Session, 1 need you' &&
        sessionUnplugged.title === 'Needs you: MIDI' &&
        sessionUnplugged.cardShown === true &&
        sessionUnplugged.cardNeeds === 'true',
      JSON.stringify({ sessionConnected, sessionUnplugged }),
    );
    report(
      'the indicator shows the port state and an unplug flips its dot',
      shownConnected === true &&
        connectedNow.visible === true &&
        connectedNow.attention === false &&
        connectedNow.dots.length === 1 &&
        connectedNow.dots[0].kind === 'filled' &&
        shownUnplugged === true &&
        unpluggedNow.attention === true &&
        unpluggedNow.dots.length === 1 &&
        unpluggedNow.dots[0].kind === 'hollow' &&
        unpluggedNow.dots[0].title === 'Fake Synth A: unplugged',
      JSON.stringify({ connected: connectedNow, unplugged: unpluggedNow }),
    );
    await evaluateExpr(cdp, `window.__plug('Fake Synth A')`);
    await callTool(client, 'set_code', { code: SILENT, label: 'probe:midi indicator reset' });
    const hiddenForPlainCode = await waitFor(cdp, `(() => document.getElementById('midi-state').hidden ? true : null)()`, 3000);
    report('the MIDI indicator stays hidden for code without .midi()', hiddenForPlainCode === true, JSON.stringify({ hidden: hiddenForPlainCode === true }));

    // --- Indicator states and popover ---
    // Each state reads as one short sentence in the top bar, from the code and the ports; the dots differ
    // by shape (never by an accent color); the (i) popover opens, closes, and stays live while open.
    const stateCase = async (expected, detailOf) => {
      const reached = await waitIndicatorText(expected, 5000);
      const now = await indicatorNow();
      report(`indicator state: ${expected}`, reached === true && now.visible === true, JSON.stringify({ expected, text: now.text, ...(detailOf ? detailOf(now) : {}) }));
    };

    await grantedWith(['Fake Synth A', 'Fake Synth B']);
    await callTool(client, 'set_code', {
      code: `stack(note("c3*2").midi('Fake Synth A'), note("c4*2").midi('Fake Synth B'))`,
      label: 'probe:midi two ports',
    });
    await stateCase('MIDI: 2 ports connected', (now) => ({ dots: now.dots.map((dot) => dot.kind) }));

    await callTool(client, 'set_code', { code: `note("c3*2").midi('Nope')`, label: 'probe:midi not found' });
    await stateCase('MIDI: Nope not found', (now) => ({ attention: now.attention, dots: now.dots.map((dot) => `${dot.kind}:${dot.title}`) }));

    await callTool(client, 'set_code', { code: `note("c3*2").midi('Fake Synth')`, label: 'probe:midi ambiguous indicator' });
    await stateCase('MIDI: Fake Synth matches several outputs');

    await grantedWith([]);
    await callTool(client, 'set_code', { code: `note("c3*2").midi('Fake Synth A')`, label: 'probe:midi no outputs indicator' });
    await stateCase('MIDI: no outputs connected');

    await grantedWith(['Fake Synth A', 'Fake IAC Bus 1']);
    await callTool(client, 'set_code', { code: `note("c3*2").midi()`, label: 'probe:midi no port indicator' });
    await stateCase('MIDI: using Fake IAC Bus 1');

    // The permission prompt stays open for 7 s: the indicator says so while it waits and not after.
    await setScenario({ permission: 'prompt', answer: 'grant', delayMs: 7000 });
    const slowSetCode = rejection(callTool(client, 'set_code', { code: `note("c3*2").midi('Fake Synth A')`, label: 'probe:midi waiting indicator' }));
    await stateCase('MIDI: waiting for permission', (now) => ({ dots: now.dots.length, attention: now.attention }));
    const answeredText = await waitIndicatorText('MIDI: Fake Synth A connected', 10000);
    report('indicator state: MIDI: waiting for permission is gone once the prompt is answered', answeredText === true, JSON.stringify({ answered: answeredText === true }));
    await slowSetCode;

    await setScenario({ permission: 'prompt', answer: 'deny' });
    await rejection(
      callTool(client, 'set_code', { code: `stack(note("c3*4").midi('Fake Synth A'), s("bd*2").gain(0))`, label: 'probe:midi denied indicator' }),
    );
    await stateCase('MIDI: permission denied');

    await setScenario({ webMidi: false });
    await callTool(client, 'set_code', { code: `note("c3*4").midi('Fake Synth A')`, label: 'probe:midi no web midi indicator' });
    await stateCase('MIDI: no Web MIDI, use Chrome or Edge', (now) => ({ attention: now.attention }));
    const unsupportedHelp = await evaluateExpr(cdp, `(() => { document.getElementById('midi-info').click(); const text = document.getElementById('midi-help').textContent; document.getElementById('midi-info').click(); return text; })()`);

    // Dots: a filled dot and a hollow ring differ by fill and ring, and no MIDI element uses an accent.
    await grantedWith(['Fake Synth A', 'Fake Synth B']);
    await callTool(client, 'set_code', {
      code: `stack(note("c3*2").midi('Fake Synth A'), note("c4*2").midi('Fake Synth B'))`,
      label: 'probe:midi dots',
    });
    await waitIndicatorText('MIDI: 2 ports connected', 5000);
    await evaluateExpr(cdp, `window.__unplug('Fake Synth B')`);
    await waitIndicatorText('MIDI: Fake Synth B unplugged', 3000);
    const dotLook = await inDrawer(() => evaluateExpr(
      cdp,
      `(() => {
        const resolve = (name) => {
          const el = document.createElement('span');
          el.style.color = 'var(' + name + ')';
          document.body.appendChild(el);
          const color = getComputedStyle(el).color;
          el.remove();
          return color;
        };
        const reserved = ['--accent', '--accent-2', '--destructive'].map(resolve);
        const filled = document.querySelector('.midi-dot[data-kind="filled"]');
        const hollow = document.querySelector('.midi-dot[data-kind="hollow"]');
        const look = (el) => {
          const style = getComputedStyle(el);
          return { background: style.backgroundColor, border: style.borderTopWidth + ' ' + style.borderTopStyle + ' ' + style.borderTopColor, width: style.width, height: style.height };
        };
        const elements = [
          document.getElementById('midi-state'),
          document.getElementById('midi-state-text'),
          document.getElementById('midi-info'),
          document.getElementById('midi-help'),
          ...document.querySelectorAll('.midi-dot'),
        ];
        const used = elements.flatMap((el) => {
          const style = getComputedStyle(el);
          return [style.color, style.backgroundColor, style.borderTopColor, style.outlineColor];
        });
        return {
          filled: look(filled),
          hollow: look(hollow),
          differ: look(filled).background !== look(hollow).background && look(filled).border !== look(hollow).border,
          ring: getComputedStyle(hollow).borderTopWidth === '1px',
          sameSize: look(filled).width === look(hollow).width && look(filled).height === look(hollow).height,
          neutral: used.every((value) => reserved.every((color) => value !== color)),
          errorLineInBanner: document.getElementById('eval-error').parentElement.id === 'problem-banner',
          reserved,
        };
      })()`,
    ));
    report(
      'the MIDI dots differ by their ring and use no accent',
      dotLook.differ === true && dotLook.ring === true && dotLook.sameSize === true && dotLook.neutral === true && dotLook.errorLineInBanner === true,
      JSON.stringify(dotLook),
    );

    // The (i) popover: opens on a click and on Enter, Esc gives focus back to the (i), a click elsewhere
    // closes it, an unplug updates it live, and opening it closes the page-requests popover.
    const helpState = () =>
      evaluateExpr(
        cdp,
        `(() => {
          const info = document.getElementById('midi-info');
          const help = document.getElementById('midi-help');
          const active = document.activeElement;
          return {
            expanded: info.getAttribute('aria-expanded'),
            hidden: help.hidden,
            active: active ? active.id || active.tagName : null,
            focusInside: help.contains(active) || active === help,
            text: help.textContent,
            label: help.getAttribute('aria-label'),
            role: help.getAttribute('role'),
          };
        })()`,
      );
    await evaluateExpr(cdp, `window.__plug('Fake Synth B')`);
    await waitIndicatorText('MIDI: 2 ports connected', 3000);
    await evaluateExpr(cdp, `document.activeElement && document.activeElement.blur()`);
    // The (i) lives in the MIDI card of the Session drawer, so the drawer opens first.
    await openDrawer(cdp);
    await clickElement(cdp, '#midi-info');
    await sleep(100);
    const afterClick = await helpState();
    await pressKey(cdp, 'Escape');
    await sleep(100);
    const afterEscape = await helpState();
    await pressKey(cdp, 'Enter');
    await sleep(100);
    const afterEnter = await helpState();
    await evaluateExpr(cdp, `window.__unplug('Fake Synth B')`);
    await sleep(400);
    const whileOpen = await helpState();
    await clickElement(cdp, '#product-name');
    await sleep(200);
    const afterOutside = await helpState();
    // Opening the MIDI popover closes the page-requests one (focus moves, its focusout closes it). The press outside closed
    // the drawer, so it opens again first: both (i) buttons are in it, and it stays open while a popover is.
    await openDrawer(cdp);
    await evaluateExpr(cdp, `document.getElementById('page-requests-info').click()`);
    await sleep(100);
    const requestsOpen = await evaluateExpr(cdp, `!document.getElementById('page-requests-help').hidden`);
    // The open page-requests popover floats over the drawer's right half and covers this (i), so the press is the page's own
    // click event (the same handler a real click or Enter reaches).
    await evaluateExpr(cdp, `document.getElementById('midi-info').click()`);
    await sleep(300);
    const requestsAfter = await evaluateExpr(cdp, `!document.getElementById('page-requests-help').hidden`);
    const midiAfter = await helpState();
    await pressKey(cdp, 'Escape');
    await closeDrawer(cdp);
    await evaluateExpr(cdp, `window.__plug('Fake Synth B')`);
    report(
      'the MIDI popover opens, closes, updates live and closes the page-requests popover',
      afterClick.expanded === 'true' &&
        afterClick.hidden === false &&
        afterClick.focusInside === true &&
        afterClick.role === 'dialog' &&
        afterClick.label === 'How MIDI works in this page' &&
        afterClick.text.includes('Moontide is sending to the MIDI ports named in the code.') &&
        afterEscape.expanded === 'false' &&
        afterEscape.hidden === true &&
        afterEscape.active === 'midi-info' &&
        afterEnter.expanded === 'true' &&
        afterEnter.focusInside === true &&
        whileOpen.hidden === false &&
        whileOpen.text.includes('Fake Synth B is unplugged.') &&
        whileOpen.text.includes('Fake Synth B · unplugged') &&
        afterOutside.expanded === 'false' &&
        afterOutside.hidden === true &&
        requestsOpen === true &&
        requestsAfter === false &&
        midiAfter.hidden === false &&
        unsupportedHelp.includes('This browser has no Web MIDI') &&
        unsupportedHelp.includes('Use Chrome or Edge.'),
      JSON.stringify({ afterClick: { ...afterClick, text: afterClick.text.slice(0, 80) }, afterEscape, afterEnter: { ...afterEnter, text: undefined }, whileOpen: whileOpen.text, afterOutside, requestsOpen, requestsAfter, unsupportedHelp: unsupportedHelp.slice(0, 120) }),
    );
    await callTool(client, 'set_code', { code: SILENT, label: 'probe:midi states reset' });

    // The indicator stays whole in its Session card at 1024 and 1920 px wide (it wraps there by design), cuts a long port
    // name, and no card overlaps another. It is measured shown, with the drawer open (a hidden element never passes).
    const longName = 'A very long instrument name!!';
    await grantedWith([longName, 'Fake Synth B']);
    await callTool(client, 'set_code', { code: `note("c3*2").midi('${longName}')`, label: 'probe:midi long name' });
    const longShown = await waitIndicatorText(`MIDI: ${longName.slice(0, 23)}… connected`, 5000);
    const widthsOk = [];
    await openDrawer(cdp);
    for (const width of [1024, 1920]) {
      await cdp('Emulation.setDeviceMetricsOverride', { width, height: 768, deviceScaleFactor: 1, mobile: false });
      await sleep(300);
      widthsOk.push({
        width,
        ...(await evaluateExpr(
          cdp,
          `(() => {
            const bar = document.getElementById('top-bar');
            const drawerItem = ${DRAWER_ITEM_JS};
            const midi = drawerItem('midi-state');
            const cards = [...document.querySelectorAll('.session-card')].filter((card) => card.getClientRects().length > 0).map((card) => card.getBoundingClientRect());
            const overlap = (a, b) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
            return {
              shown: midi.shown,
              whole: midi.whole,
              lines: midi.lines,
              noOverlap: cards.every((a, i) => cards.every((b, j) => i === j || !overlap(a, b))),
              barFits: bar.scrollWidth <= bar.clientWidth,
              title: document.getElementById('midi-state').title,
              text: document.getElementById('midi-state-text').textContent,
            };
          })()`,
        )),
      });
    }
    await cdp('Emulation.clearDeviceMetricsOverride');
    await sleep(300);
    await closeDrawer(cdp);
    report(
      'the MIDI indicator stays whole in its Session card at 1024 and 1920 px and cuts a long name',
      longShown === true && widthsOk.every((entry) => entry.shown && entry.whole && entry.lines <= 3 && entry.noOverlap && entry.barFits && entry.title === `MIDI: ${longName} connected`),
      JSON.stringify(widthsOk),
    );

    // --- Hidden tab ---
    // While MIDI plays in a hidden tab the title says so and Claude is told once each way, the music keeps
    // playing, and coming back after 3 s or more shows one banner that takes no focus and moves nothing.
    // The hidden page is simulated (visibilityState and hidden redefined, visibilitychange dispatched) so
    // every step is deterministic; one check at the end uses a real background tab.
    const simulateHidden = () =>
      evaluateExpr(
        cdp,
        `(() => {
          Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
          Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
          document.dispatchEvent(new Event('visibilitychange'));
        })()`,
      );
    const simulateVisible = () =>
      evaluateExpr(
        cdp,
        `(() => {
          delete document.visibilityState;
          delete document.hidden;
          document.dispatchEvent(new Event('visibilitychange'));
        })()`,
      );
    const titleNow = () => evaluateExpr(cdp, 'document.title');
    const waitTitle = (wanted, timeoutMs) => waitFor(cdp, `(() => document.title === ${JSON.stringify(wanted)} ? true : null)()`, timeoutMs);
    const bannerNow = () =>
      evaluateExpr(
        cdp,
        `(() => {
          const banner = document.getElementById('midi-banner');
          return {
            visible: !banner.hidden && banner.getBoundingClientRect().width > 0,
            text: document.getElementById('midi-banner-text').textContent,
            dismiss: document.getElementById('midi-banner-dismiss').textContent,
          };
        })()`,
      );
    const waitBanner = (visible, timeoutMs) =>
      waitFor(
        cdp,
        `(() => { const banner = document.getElementById('midi-banner'); return (!banner.hidden) === ${visible} ? true : null; })()`,
        timeoutMs,
      );
    const layoutNow = () =>
      evaluateExpr(
        cdp,
        `(() => {
          const rect = (id) => {
            const box = document.getElementById(id).getBoundingClientRect();
            return [box.x, box.y, box.width, box.height].map((value) => Math.round(value * 100) / 100);
          };
          const active = document.activeElement;
          return { active: active ? active.id || active.tagName : null, topBar: rect('top-bar'), workspace: rect('workspace'), editorArea: rect('editor-area') };
        })()`,
      );
    /** Sleeps until `ms` have passed since `since` (a Date.now() value). */
    const sleepUntilElapsed = async (since, ms) => {
      const left = since + ms - Date.now();
      if (left > 0) await sleep(left);
    };

    await setScenario({ permission: 'granted' });
    await callTool(client, 'set_code', { code: `note("c3*4").midi('Fake Synth A')`, label: 'probe:midi hidden tab' });
    await waitIndicatorText('MIDI: Fake Synth A connected', 5000);
    await sleep(300);
    const layoutBefore = await layoutNow();
    // The page's own base title, read while it is visible: the wordmark and the label of its server.
    const pageBaseTitle = await titleNow();
    const metaLabel = await evaluateExpr(cdp, `document.querySelector('meta[name="moontide-session-label"]')?.getAttribute('content') ?? null`);
    report(
      'the tab title is the wordmark and the label the server wrote into the page',
      typeof metaLabel === 'string' && metaLabel !== '' && pageBaseTitle === 'Moontide \u00b7 ' + metaLabel,
      JSON.stringify({ title: pageBaseTitle, hasLabel: typeof metaLabel === 'string' && metaLabel !== '' }),
    );
    const warningTitle = MIDI_TITLE_PREFIX + pageBaseTitle;
    const hiddenAt = Date.now();
    await simulateHidden();
    const titleSet = await waitTitle(warningTitle, 2000);
    const titleWhileHidden = await titleNow();
    report('a hidden tab while MIDI plays sets the tab title', titleSet === true && titleWhileHidden === warningTitle, JSON.stringify({ title: titleWhileHidden }));

    marker = (await midiLog()).length;
    await sleep(1000);
    const notesWhileHidden = noteOns((await midiLog()).slice(marker), 'Fake Synth A').length;
    const labelWhileHidden = await soundLabel();
    const codeWhileHidden = await callTool(client, 'get_code', {});
    report(
      'Moontide keeps playing while the tab is hidden',
      notesWhileHidden > 0 && labelWhileHidden === SOUND_LABELS.playing && codeWhileHidden.includes(MIDI_HIDDEN_LINE),
      JSON.stringify({ noteOnsWhileHidden: notesWhileHidden, label: labelWhileHidden, claudeToldOnce: codeWhileHidden.includes(MIDI_HIDDEN_LINE) }),
    );

    await sleepUntilElapsed(hiddenAt, 3300);
    await simulateVisible();
    const bannerShown = await waitBanner(true, 2000);
    const bannerFacts = await bannerNow();
    const layoutWith = await layoutNow();
    const titleBack = await titleNow();
    const codeBack = await callTool(client, 'get_code', {});
    const codeBackAgain = await callTool(client, 'get_code', {});
    report(
      'coming back shows the banner with two HH:MM times and takes no focus nor space',
      bannerShown === true &&
        bannerFacts.visible === true &&
        /^MIDI timing may have broken while this tab was hidden \(from \d\d:\d\d to \d\d:\d\d\)\.$/.test(bannerFacts.text) &&
        bannerFacts.dismiss === 'Dismiss' &&
        titleBack === pageBaseTitle &&
        JSON.stringify(layoutWith) === JSON.stringify(layoutBefore) &&
        codeBack.includes(MIDI_VISIBLE_LINE) &&
        !codeBackAgain.includes(MIDI_VISIBLE_LINE),
      JSON.stringify({ banner: bannerFacts, title: titleBack, layoutBefore, layoutWith, claudeToldFrontAgain: codeBack.includes(MIDI_VISIBLE_LINE) }),
    );

    await clickElement(cdp, '#midi-banner-dismiss');
    const dismissedGone = await waitBanner(false, 2000);
    await simulateHidden();
    await sleep(500);
    await simulateVisible();
    await sleep(400);
    const shortShown = (await bannerNow()).visible;
    const longerAt = Date.now();
    await simulateHidden();
    await sleepUntilElapsed(longerAt, 3300);
    await simulateVisible();
    const secondShown = await waitBanner(true, 2000);
    await evaluateExpr(cdp, `document.getElementById('midi-banner-dismiss').focus()`);
    await pressKey(cdp, 'Escape');
    const escapeGone = await waitBanner(false, 2000);
    report(
      'Dismiss and Esc hide the banner and a short hidden period shows none',
      dismissedGone === true && shortShown === false && secondShown === true && escapeGone === true,
      JSON.stringify({ dismissHides: dismissedGone === true, shortPeriodShowsBanner: shortShown, longerPeriodShowsBanner: secondShown === true, escHides: escapeGone === true }),
    );

    // Code without .midi(: no title prefix and no banner, even after a long hidden period.
    await callTool(client, 'set_code', { code: SILENT, label: 'probe:midi hidden tab no midi' });
    await waitFor(cdp, `(() => document.getElementById('midi-state').hidden ? true : null)()`, 3000);
    const plainAt = Date.now();
    await simulateHidden();
    await sleep(400);
    const plainTitle = await titleNow();
    await sleepUntilElapsed(plainAt, 3300);
    await simulateVisible();
    await sleep(400);
    const plainBanner = (await bannerNow()).visible;
    report('no title prefix for code without .midi()', plainTitle === pageBaseTitle && plainBanner === false, JSON.stringify({ titleWhileHidden: plainTitle, bannerShown: plainBanner }));

    // One real check: a second target makes headless Chrome report the first page as hidden.
    await callTool(client, 'set_code', { code: `note("c3*4").midi('Fake Synth A')`, label: 'probe:midi real background tab' });
    await waitIndicatorText('MIDI: Fake Synth A connected', 5000);
    let backgroundTarget = null;
    try {
      const created = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' });
      if (!created.ok) throw new Error(`/json/new answered ${created.status}`);
      backgroundTarget = await created.json();
      const goneHidden = await waitFor(cdp, `(() => document.visibilityState === 'hidden' ? true : null)()`, 5000);
      const realTitle = goneHidden === true ? await waitTitle(warningTitle, 2000) : null;
      report(
        'a real background tab sets the title',
        goneHidden === true && realTitle === true,
        JSON.stringify({ pageReportedHidden: goneHidden === true, titleIsWarning: realTitle === true, title: await titleNow() }),
      );
    } finally {
      if (backgroundTarget !== null) await fetch(`http://127.0.0.1:${port}/json/close/${backgroundTarget.id}`).catch(() => {});
      await cdp('Page.bringToFront');
    }
    await waitTitle(pageBaseTitle, 3000);
    await evaluateExpr(cdp, `(() => { const banner = document.getElementById('midi-banner'); if (!banner.hidden) document.getElementById('midi-banner-dismiss').click(); })()`);
    await callTool(client, 'set_code', { code: SILENT, label: 'probe:midi hidden tab reset' });

    // --- Reference facts ---
    // reference/midi.md says a control-change sweep takes its structure from the left: ccv(sine.segment(16))
    // .ccn(74) sends 16 values per cycle and ccn(74).ccv(sine.segment(16)) sends one. No MIDI is involved:
    // both patterns are stored on window by one evaluation and their onsets counted in the page.
    await evaluateExpr(cdp, 'window.__moontideCcSweep = undefined');
    await callTool(client, 'set_code', {
      code: [
        'window.__moontideCcSweep = { left: ccv(sine.segment(16)).ccn(74), right: ccn(74).ccv(sine.segment(16)) }',
        SILENT,
      ].join('\n'),
      label: 'probe:midi reference cc sweep',
    });
    const sweepCounts = await evaluateExpr(
      cdp,
      `(() => {
        const sweep = window.__moontideCcSweep;
        if (!sweep || !sweep.left || !sweep.right || !sweep.left._Pattern || !sweep.right._Pattern) return null;
        const onsets = (pattern) => pattern.queryArc(0, 1).filter((hap) => hap.hasOnset()).length;
        return { left: onsets(sweep.left), right: onsets(sweep.right) };
      })()`,
    );
    await evaluateExpr(cdp, 'delete window.__moontideCcSweep');
    report(
      'reference: a CC sweep takes its structure from the left',
      sweepCounts !== null && sweepCounts.left === 16 && sweepCounts.right === 1,
      JSON.stringify({ counts: sweepCounts }),
    );

    // --- .midichan on either side of .midi() ---
    // The setup reader sets a call's channel from a whole-number .midichan(n) on its member chain. Both
    // orders are played here, with no setup file, and the channel byte of the notes that reach the port
    // is read: the reader accepts an order only if Strudel really sends that channel for it.
    await setScenario({ permission: 'granted' });
    const isChannel3NoteOn = (entry) => entry.port === 'Fake Synth A' && entry.bytes.length === 3 && entry.bytes[0] === 0x92 && entry.bytes[2] > 0;
    const waitForChannel3NoteOn = (from, ms) =>
      waitFor(
        cdp,
        `(() => window.__midiLog.slice(${from}).some((e) => e.port === 'Fake Synth A' && e.bytes.length === 3 && e.bytes[0] === 0x92 && e.bytes[2] > 0) ? true : null)()`,
        ms,
      );
    for (const [name, code] of [
      ['.midichan before .midi() sets the channel', `note("c3*4").midichan(3).midi('Fake Synth A')`],
      ['.midichan after .midi() sets the channel', `note("c3*4").midi('Fake Synth A').midichan(3)`],
    ]) {
      marker = (await midiLog()).length;
      await callTool(client, 'set_code', { code, label: `probe:midi ${name}` });
      const sawChannel3 = await waitForChannel3NoteOn(marker, 1500);
      const statuses = [...new Set(noteOns((await midiLog()).slice(marker), 'Fake Synth A').map((entry) => entry.bytes[0]))];
      report(name, sawChannel3 === true, JSON.stringify({ noteOnStatuses: statuses }));
      await callTool(client, 'set_code', { code: SILENT, label: 'probe:midi midichan reset' });
    }

    // --- Instruments ---
    // With an instruments.json in the data folder, a sound chosen by name goes out as a program change
    // before the first note of the code that names it, with the guard in between, and an unknown sound
    // is a real failed evaluation while the previous music keeps playing.
    const rigFile = path.join(dataDir, 'instruments.json');
    fs.writeFileSync(rigFile, JSON.stringify({ instruments: [{ id: 'mt32', model: 'mt32', port: 'Fake Synth A' }] }));
    await setScenario({ permission: 'granted' });
    const soundCode = (sound) => `mt32: note("c3*8").midi('Fake Synth A', { midichannel: 3, sound: '${sound}' })`;
    marker = (await midiLog()).length;
    await callTool(client, 'set_code', { code: soundCode('Str Sect 1'), label: 'probe:midi sound by name' });
    await waitForChannel3NoteOn(marker, 1500);
    const rigLog = (await midiLog()).slice(marker);
    // The program change goes out at once or with a timestamp; Strudel's notes leave ahead with a timestamp, so the
    // moments they sound are compared: the timestamp when there is one, else the send time.
    const soundsAt = (entry) => (typeof entry.ts === 'number' ? entry.ts : entry.t);
    const programAt = rigLog.findIndex(
      (entry) => entry.port === 'Fake Synth A' && entry.bytes.length === 2 && entry.bytes[0] === 0xc2 && entry.bytes[1] === 48,
    );
    const firstNoteAt = rigLog.findIndex(isChannel3NoteOn);
    const gapMs = programAt === -1 || firstNoteAt === -1 ? null : soundsAt(rigLog[firstNoteAt]) - soundsAt(rigLog[programAt]);
    report(
      'a sound chosen by name goes out before the first note',
      programAt !== -1 && firstNoteAt !== -1 && programAt < firstNoteAt && gapMs !== null && gapMs >= SETUP_GUARD_MS,
      JSON.stringify({ programChangeIndex: programAt, firstNoteIndex: firstNoteAt, msBetween: gapMs, guardMs: SETUP_GUARD_MS }),
    );

    const playingBefore = await callTool(client, 'get_code', {});
    let refusalText = '';
    try {
      await callTool(client, 'set_code', { code: soundCode('No Such Sound'), label: 'probe:midi unknown sound' });
    } catch (err) {
      refusalText = err instanceof Error ? err.message : String(err);
    }
    const playingAfter = await callTool(client, 'get_code', {});
    marker = (await midiLog()).length;
    const stillPlays = await waitForChannel3NoteOn(marker, 1000);
    report(
      'an unknown sound fails the evaluation and the previous music keeps playing',
      refusalText.startsWith('Evaluation failed: Unknown sound "No Such Sound" for mt32.') &&
        playingAfter.includes(soundCode('Str Sect 1')) &&
        playingBefore.includes(soundCode('Str Sect 1')) &&
        stillPlays === true,
      JSON.stringify({ errorStart: refusalText.split('\n')[0], codeUnchanged: playingAfter.includes(soundCode('Str Sect 1')), stillPlays: stillPlays === true }),
    );

    // --- Refusals, restore and the may-cut line in the real page ---
    // What set_code answers when the evaluation fails: the error text, or null when it was not refused.
    const refusedWith = async (code, label) => {
      try {
        await callTool(client, 'set_code', { code, label });
        return null;
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    };
    const firstLine = (text) => (text ?? '').split('\n')[0];
    const channel3Sound = (name) => `mt32: note("c3*8").midi('Fake Synth A', { midichannel: 3, sound: '${name}' })`;
    const programChangesOnA = (entries) => entries.filter((entry) => entry.port === 'Fake Synth A' && entry.bytes.length === 2 && entry.bytes[0] === 0xc2);

    // (a) The same sound again sends nothing (a Mixer drag evaluates many times a second).
    marker = (await midiLog()).length;
    for (let index = 0; index < 5; index++) {
      await callTool(client, 'set_code', { code: `mt32: note("c3*${9 + index}").midi('Fake Synth A', { midichannel: 3, sound: 'Str Sect 1' })`, label: `probe:midi same sound ${index}` });
    }
    await sleep(300);
    const resent = programChangesOnA((await midiLog()).slice(marker));
    report('five more evaluations of the same code send no sound change', resent.length === 0, JSON.stringify({ programChanges: resent.map((entry) => entry.bytes) }));

    // (b) A change of sound on a channel the playing code used tells Claude it may cut a note.
    const cutLine = 'MIDI: changing the sound of "mt32" channel 3 may cut a note that is still sounding.';
    const changeReply = await callTool(client, 'set_code', { code: channel3Sound('Harpsi 2'), label: 'probe:midi other sound' });
    report('a sound change on a playing channel tells Claude it may cut a note', changeReply.split('\n').includes(cutLine), JSON.stringify({ reply: changeReply.slice(0, 400) }));

    // (c) Restoring the first version brings its sound back before its first note.
    const historyReply = await callTool(client, 'list_history', {});
    const firstSoundLine = historyReply.split('\n').find((line) => line.includes('"probe:midi sound by name"'));
    const firstSoundId = firstSoundLine ? Number(/^#(\d+)/.exec(firstSoundLine.trim())?.[1]) : NaN;
    marker = (await midiLog()).length;
    let restoreReply = '';
    if (Number.isInteger(firstSoundId)) restoreReply = await callTool(client, 'restore_version', { id: firstSoundId });
    await waitForChannel3NoteOn(marker, 1500);
    await sleep(200);
    const restoreLog = (await midiLog()).slice(marker);
    const restoreProgramAt = restoreLog.findIndex((entry) => entry.port === 'Fake Synth A' && entry.bytes.length === 2 && entry.bytes[0] === 0xc2 && entry.bytes[1] === 48);
    // The notes of the code that was playing go on during the guard; the restored code's first note comes after it.
    const restoredNoteAt =
      restoreProgramAt === -1 ? -1 : restoreLog.findIndex((entry, index) => index > restoreProgramAt && isChannel3NoteOn(entry) && entry.t >= restoreLog[restoreProgramAt].t + SETUP_GUARD_MS);
    report(
      'restoring an older version sends its sound again',
      Number.isInteger(firstSoundId) && restoreReply.includes('Str Sect 1') && restoreProgramAt !== -1 && restoredNoteAt !== -1,
      JSON.stringify({ restoredId: firstSoundId, programChangeIndex: restoreProgramAt, firstNoteAfterGuardIndex: restoredNoteAt }),
    );

    // (d) A port that is connected but not in the file is refused.
    const connectedText = await refusedWith(`mt32: note("c3*8").midi('Fake Synth B', { midichannel: 3 })`, 'probe:midi connected not listed');
    report(
      'a connected port missing from instruments.json is refused',
      firstLine(connectedText) === 'Evaluation failed: Port "Fake Synth B" is connected but not in instruments.json. Add it there first.' || (connectedText ?? '').startsWith('Evaluation failed: Port "Fake Synth B" is connected but not in instruments.json.'),
      JSON.stringify({ errorStart: firstLine(connectedText) }),
    );

    // (e) A channel the instrument does not declare is refused on line 1.
    const channelText = await refusedWith(`mt32: note("c3*8").midi('Fake Synth A', { midichannel: 1 })`, 'probe:midi undeclared channel');
    report(
      'a channel mt32 does not declare is refused',
      firstLine(channelText) === 'Evaluation failed: Channel 1 is not declared for mt32.',
      JSON.stringify({ errorStart: firstLine(channelText) }),
    );

    // (f) Two different sounds on one channel are refused, naming both.
    const conflictText = await refusedWith(
      [`lead: note("c3*4").midi('Fake Synth A', { midichannel: 3, sound: 'Str Sect 1' })`, `pad: note("e3*4").midi('Fake Synth A', { midichannel: 3, sound: 'Harpsi 2' })`].join('\n'),
      'probe:midi two sounds one channel',
    );
    report(
      'two different sounds on one channel are refused',
      firstLine(conflictText) === 'Evaluation failed: mt32 channel 3 is asked for two different sounds: "Str Sect 1" and "Harpsi 2".',
      JSON.stringify({ errorStart: firstLine(conflictText) }),
    );

    // (g) A double-quoted sound is refused with the mini-notation reason.
    const quotedText = await refusedWith(`mt32: note("c3*8").midi('Fake Synth A', { midichannel: 3, sound: "Str Sect 1" })`, 'probe:midi double quotes');
    report(
      'a double-quoted sound is refused with its reason',
      (quotedText ?? '').includes(RIG_COPY.soundNotPlain) && (quotedText ?? '').includes(RIG_COPY.doubleQuotes),
      JSON.stringify({ errorStart: firstLine(quotedText), hasReason: (quotedText ?? '').includes(RIG_COPY.doubleQuotes) }),
    );

    // (h) A refused hand evaluation shows on the error line and reaches Claude, and the music goes on.
    const handCode = channel3Sound('Hand Typed Sound');
    const handRefusal = await refusedWith(handCode, 'probe:midi hand refusal text');
    const codeBeforeHand = await callTool(client, 'get_code', {});
    marker = (await midiLog()).length;
    await evaluateExpr(cdp, `(() => { document.getElementById('repl').editor.setCode(${JSON.stringify(handCode)}); document.querySelector('#editor-area .cm-content').focus(); })()`);
    // No nativeVirtualKeyCode, like pressKey: on macOS an unconsumed key event that carries one comes back endlessly.
    for (const type of ['keyDown', 'keyUp']) {
      await cdp('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 2 });
    }
    const errorLine = await waitFor(
      cdp,
      `(() => { const el = document.getElementById('eval-error'); const banner = document.getElementById('problem-banner'); return el && !el.hidden ? { text: el.textContent, title: el.getAttribute('title'), bannerShown: !banner.hidden, kind: banner.dataset.kind, lead: banner.querySelector('.problem-lead').textContent } : null; })()`,
      5000,
    );
    let handNoteReply = null;
    for (let attempt = 0; attempt < 30 && handNoteReply === null; attempt++) {
      const reply = await callTool(client, 'get_code', {});
      if (reply.includes('Note: an edit evaluated by hand in the page failed: Unknown sound')) handNoteReply = reply;
      else await sleep(200);
    }
    const stillPlaysAfterHand = await waitForChannel3NoteOn(marker, 1500);
    const codeAfterHand = await callTool(client, 'get_code', {});
    const titleLines = (errorLine?.title ?? '').split('\n');
    report(
      'a refused hand evaluation shows on the error line and reaches Claude',
      errorLine !== null &&
        errorLine.text === `Error: ${titleLines[0]}` &&
        titleLines[0].startsWith('Unknown sound "Hand Typed Sound" for mt32.') &&
        titleLines.at(-1) === RIG_COPY.closingPlaying &&
        (handRefusal ?? '').includes(errorLine.title.replace(/\.+$/, '')) &&
        handNoteReply !== null &&
        stillPlaysAfterHand === true &&
        codeAfterHand.includes(channel3Sound('Str Sect 1')) &&
        codeBeforeHand.includes(channel3Sound('Str Sect 1')),
      JSON.stringify({ errorLine, claudeToldByHand: handNoteReply !== null, stillPlays: stillPlaysAfterHand === true, codeUnchanged: codeAfterHand.includes(channel3Sound('Str Sect 1')) }),
    );
    // The refused evaluation is a failed change, so the banner under the bar holds the error line with kind change.
    report(
      'a refused hand evaluation shows the failed-change banner with the error line inside it',
      errorLine !== null && errorLine.bannerShown === true && errorLine.kind === 'change' && errorLine.lead === 'Change failed.',
      JSON.stringify({ bannerShown: errorLine?.bannerShown, kind: errorLine?.kind, lead: errorLine?.lead }),
    );
    // Put the playing code back in the editor and clear the error line before the next case.
    await callTool(client, 'set_code', { code: channel3Sound('Str Sect 1'), label: 'probe:midi back to the first sound' });

    // (i) An invalid file refuses code with .midi( and lets other code play; Claude hears about the file once.
    fs.writeFileSync(rigFile, JSON.stringify({ instruments: [{ id: 'mt32', model: 'mt32' }] }));
    const invalidText = await refusedWith(channel3Sound('Str Sect 1'), 'probe:midi invalid file');
    const silentReply = await callTool(client, 'set_code', { code: SILENT, label: 'probe:midi invalid file, other code' });
    const afterReply = await callTool(client, 'get_code', {});
    const invalidLine = 'MIDI: instruments.json is invalid: instruments[0].port: required.';
    const timesTold = [invalidText ?? '', silentReply].filter((text) => text.includes(invalidLine)).length;
    report(
      'an invalid instruments.json refuses .midi() code and lets other code play',
      firstLine(invalidText) === 'Evaluation failed: instruments.json is invalid, so code with .midi() cannot play until it is fixed.' &&
        (invalidText ?? '').includes('instruments[0].port: required') &&
        silentReply.includes('ok') &&
        timesTold === 1 &&
        !afterReply.includes(invalidLine),
      JSON.stringify({ errorStart: firstLine(invalidText), toldInReplies: timesTold, toldAgain: afterReply.includes(invalidLine), silentReplyStart: firstLine(silentReply) }),
    );

    // --- Sound change drops the old notes (13.1) ---
    // Strudel plays a note on the Output it picked when it triggered the note, up to 0.3 s before it sounds,
    // so a note of the old code can leave after the program change of a sound change and play with the new
    // sound. With a fast repeated note on channel 3 and a second track on channel 4, the sound of channel 3
    // changes: after the program change no old pitch goes out on channel 3, the new pitch does, and channel
    // 4 keeps playing through the change.
    fs.writeFileSync(rigFile, JSON.stringify({ instruments: [{ id: 'mt32', model: 'mt32', port: 'Fake Synth A' }] }));
    await setScenario({ permission: 'granted' });
    await sleep(800);
    const twoTracks = (leadNote, sound) =>
      `lead: note("${leadNote}*8").midi('Fake Synth A', { midichannel: 3, sound: '${sound}' })\nbass: note("g2*8").midi('Fake Synth A', { midichannel: 4 })`;
    const isNoteOnOf = (entry, status, pitch) => entry.port === 'Fake Synth A' && entry.bytes.length === 3 && entry.bytes[0] === status && entry.bytes[1] === pitch && entry.bytes[2] > 0;
    await callTool(client, 'set_code', { code: twoTracks('c3', 'Str Sect 1'), label: 'probe:midi sound change before' });
    await waitFor(cdp, `window.__midiLog.some((e) => e.port === 'Fake Synth A' && e.bytes.length === 3 && e.bytes[0] === 0x92 && e.bytes[1] === 48 && e.bytes[2] > 0) ? true : null`, 3000);
    marker = (await midiLog()).length;
    await callTool(client, 'set_code', { code: twoTracks('e5', 'Harpsi 2'), label: 'probe:midi sound change after' });
    await sleep(1500);
    const changeLog = (await midiLog()).slice(marker).filter((entry) => entry.port === 'Fake Synth A');
    const changeAt = changeLog.findIndex((entry) => entry.bytes.length === 2 && entry.bytes[0] === 0xc2);
    const afterChange = changeAt === -1 ? [] : changeLog.slice(changeAt + 1);
    const oldAfter = afterChange.filter((entry) => isNoteOnOf(entry, 0x92, 48));
    const newAfter = afterChange.filter((entry) => isNoteOnOf(entry, 0x92, 76));
    // The window reaches back before the marker: the bass notes just before the change count too.
    const fullLog = (await midiLog()).filter((entry) => entry.port === 'Fake Synth A');
    const bassNear = changeAt === -1 ? [] : fullLog.filter((entry) => entry.bytes[0] === 0x93 && entry.bytes[2] > 0 && Math.abs(entry.t - changeLog[changeAt].t) <= 500);
    // Notes leave ahead with a timestamp (16): the old notes already queued sound with the old sound, before the
    // program change's own time, and the new pitch sounds after it.
    const changeSounds = changeAt === -1 ? Number.NaN : soundsAt(changeLog[changeAt]);
    const oldBefore = changeAt === -1 ? [] : changeLog.slice(0, changeAt).filter((entry) => isNoteOnOf(entry, 0x92, 48));
    const oldBeforeLate = oldBefore.filter((entry) => !(soundsAt(entry) < changeSounds));
    const newSoundsAfter = newAfter.length > 0 && soundsAt(newAfter[0]) > changeSounds;
    report(
      'after a sound change no note of the old code goes out on that channel, and the other channel keeps playing',
      changeAt !== -1 && oldAfter.length === 0 && newAfter.length > 0 && bassNear.length >= 3 && oldBeforeLate.length === 0 && newSoundsAfter,
      JSON.stringify({
        programChangeIndex: changeAt,
        programChangeTimed: changeAt !== -1 && typeof changeLog[changeAt].ts === 'number',
        oldPitchAfterChange: oldAfter.length,
        newPitchAfterChange: newAfter.length,
        otherChannelNotesWithin500ms: bassNear.length,
        oldPitchBeforeChange: oldBefore.length,
        oldPitchSoundingAtOrAfterTheChange: oldBeforeLate.length,
        firstNewPitchSoundsAfterTheChangeMs: newAfter.length > 0 ? Math.round((soundsAt(newAfter[0]) - changeSounds) * 10) / 10 : null,
      }),
    );
    await callTool(client, 'set_code', { code: SILENT, label: 'probe:midi sound change reset' });

    // --- Reset on connect ---
    // With a setup file of two instruments, each is brought to its known state once per connection: at page
    // start, and after a replug (once, after the settle delay, however noisy the events). The bytes on the
    // port are the model's reset, then its wait, then each declared channel's sound and volume in channel
    // order. A superseded tab resets nothing.
    const MT32_RESET = [0xf0, 0x41, 0x10, 0x16, 0x12, 0x7f, 0x00, 0x00, 0x00, 0x01, 0xf7];
    const GS_RESET = [0xf0, 0x41, 0x10, 0x42, 0x12, 0x40, 0x00, 0x7f, 0x00, 0x41, 0xf7];
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const isSysex = (entry) => entry.bytes[0] === 0xf0;
    const isNoteMessage = (entry) => entry.bytes[0] >= 0x80 && entry.bytes[0] <= 0x9f;
    const volumesOn = (channels) => channels.map((channel) => [0xb0 | (channel - 1), 7, 100]);
    const portEntries = (entries, name) => entries.filter((entry) => entry.port === name);
    const range = (from, to) => Array.from({ length: to - from + 1 }, (_, index) => from + index);
    const countOfLine = (text, line) => text.split('\n').filter((candidate) => candidate === line).length;
    const startLineFor = (id) => `MIDI: instrument "${id}" was reset to its known state when the page connected.`;
    const reconnectLine = 'MIDI: instrument "mt32" was reset to its known state after reconnecting.';

    fs.writeFileSync(
      rigFile,
      JSON.stringify({
        instruments: [
          { id: 'mt32', model: 'mt32', port: 'Fake Synth A' },
          { id: 'sc55', model: 'sc55', port: 'Fake Synth B' },
        ],
      }),
    );
    await setScenario({ permission: 'granted' });
    await sleep(1500);
    const startLog = await midiLog();
    const startA = portEntries(startLog, 'Fake Synth A');
    const startB = portEntries(startLog, 'Fake Synth B');
    const gapA = startA.length > 1 ? startA[1].t - startA[0].t : null;
    const gapB = startB.length > 1 ? startB[1].t - startB[0].t : null;
    const startReply = await callTool(client, 'get_code', {});
    // A timer waits at least its delay; one millisecond of clock rounding is allowed.
    report('page start resets each present instrument once, then sends its volume channel by channel',
      same(startA.map((entry) => entry.bytes), [MT32_RESET, ...volumesOn(range(2, 10))]) &&
        same(startB.map((entry) => entry.bytes), [GS_RESET, ...volumesOn(range(1, 16))]) &&
        gapA !== null && gapA >= 99 && gapB !== null && gapB >= 49 &&
        startA.filter(isSysex).length === 1 && startB.filter(isSysex).length === 1 &&
        countOfLine(startReply, startLineFor('mt32')) === 1 && countOfLine(startReply, startLineFor('sc55')) === 1,
      JSON.stringify({ messagesOnA: startA.length, messagesOnB: startB.length, msAfterResetA: gapA, msAfterResetB: gapB, resetVectorsA: startA.filter(isSysex).length, resetVectorsB: startB.filter(isSysex).length, claudeToldA: countOfLine(startReply, startLineFor('mt32')), claudeToldB: countOfLine(startReply, startLineFor('sc55')) }));

    // (b) A replugged instrument: one reset after the settle, then its sound and volume, channel by channel.
    await callTool(client, 'set_code', { code: soundCode('Str Sect 1'), label: 'probe:midi reset sound' });
    await waitForChannel3NoteOn(0, 1500);
    marker = (await midiLog()).length;
    await evaluateExpr(cdp, `window.__unplug('Fake Synth A')`);
    await sleep(200);
    const plugAt = await evaluateExpr(cdp, `(() => { window.__plug('Fake Synth A'); return performance.now(); })()`);
    for (let index = 0; index < 3; index++) {
      await sleep(30);
      await evaluateExpr(cdp, `window.__noise('Fake Synth A')`);
    }
    // The second setup comes RECONNECT_REPEAT_MS after the first, then the notes flow again.
    await sleep(RESET_SETTLE_MS + RECONNECT_REPEAT_MS + 1500);
    const replugA = portEntries((await midiLog()).slice(marker), 'Fake Synth A');
    const resetAt = replugA.findIndex((entry) => same(entry.bytes, MT32_RESET));
    const afterReset = resetAt === -1 ? [] : replugA.slice(resetAt + 1);
    const setupAfterReset = afterReset.filter((entry) => !isNoteMessage(entry)).map((entry) => entry.bytes);
    const expectedSetup = [[0xb1, 7, 100], [0xc2, 48], [0xb2, 7, 100], ...volumesOn(range(4, 10))];
    const settledAfter = resetAt === -1 ? null : replugA[resetAt].t - plugAt;
    const noteAfterSetup = afterReset.some((entry) => entry.bytes[0] === 0x92 && entry.bytes[2] > 0);
    // The two bursts of setup messages: the first entry of each, in the log's own clock.
    const burstStarts = afterReset.filter((entry) => !isNoteMessage(entry) && entry.bytes[0] === 0xb1 && entry.bytes[1] === 7).map((entry) => entry.t);
    const burstGap = burstStarts.length === 2 ? burstStarts[1] - burstStarts[0] : null;
    report('a replugged instrument is reset once after the settle, then gets its sound and volume back channel by channel, twice',
      replugA.filter(isSysex).length === 1 && settledAfter !== null && settledAfter >= RESET_SETTLE_MS && same(setupAfterReset, [...expectedSetup, ...expectedSetup]) && burstGap !== null && burstGap >= RECONNECT_REPEAT_MS - 1 && noteAfterSetup,
      JSON.stringify({ resetVectors: replugA.filter(isSysex).length, msFromPlugToReset: settledAfter, settleMs: RESET_SETTLE_MS, repeatMs: RECONNECT_REPEAT_MS, burstStarts, msBetweenBursts: burstGap, setupAfterReset, noteOnAfterSetup: noteAfterSetup }));

    // No note-on reaches the port between the plug and the end of the second setup, and notes flow after it.
    const secondSetupEnd = afterReset.length === 0 ? null : afterReset.filter((entry) => !isNoteMessage(entry)).at(-1).t;
    const noteOnsBefore = replugA.filter((entry) => entry.t >= plugAt && (secondSetupEnd === null || entry.t <= secondSetupEnd) && entry.bytes[0] >= 0x90 && entry.bytes[0] <= 0x9f && entry.bytes[2] > 0);
    const noteOnsAfter = replugA.filter((entry) => secondSetupEnd !== null && entry.t > secondSetupEnd && entry.bytes[0] >= 0x90 && entry.bytes[0] <= 0x9f && entry.bytes[2] > 0);
    report('no note reaches a replugged instrument before its second setup, and notes flow after it',
      secondSetupEnd !== null && noteOnsBefore.length === 0 && noteOnsAfter.length >= 1,
      JSON.stringify({ noteOnsBeforeSecondSetup: noteOnsBefore.length, noteOnsAfterSecondSetup: noteOnsAfter.length }));

    // (c) Claude hears the reset once, with the instrument named.
    const toldReply = await callTool(client, 'get_code', {});
    const toldAgain = await callTool(client, 'get_code', {});
    report('Claude hears the reset once, with the instrument named',
      countOfLine(toldReply, reconnectLine) === 1 &&
        toldReply.split('\n').some((line) => line.startsWith('MIDI: instrument "mt32" (port "Fake Synth A") is unplugged.')) &&
        countOfLine(toldReply, 'MIDI: instrument "mt32" is connected again. Playing resumed.') === 1 &&
        countOfLine(toldAgain, reconnectLine) === 0,
      JSON.stringify({ resetLines: countOfLine(toldReply, reconnectLine), midiLines: toldReply.split('\n').filter((line) => line.startsWith('MIDI:')), resetLinesInNextReply: countOfLine(toldAgain, reconnectLine) }));

    // (d) Stop and Play are not a connection.
    marker = (await midiLog()).length;
    await stopMusic(cdp);
    await sleep(500);
    await callTool(client, 'set_code', { code: soundCode('Str Sect 1'), label: 'probe:midi reset play again' });
    await sleep(1000);
    const resetsAfterPlay = (await midiLog()).slice(marker).filter(isSysex);
    report('Stop and Play send no reset', resetsAfterPlay.length === 0, JSON.stringify({ resetVectorsAfterStopAndPlay: resetsAfterPlay.length }));

    // (e) A superseded tab never resets: the second tab is the active one, and a replug seen by the first tab sends nothing.
    try {
      await openSecondTab();
      const supersededSegment = await waitFor(cdp, `(() => document.getElementById('midi-takeover').hidden ? null : true)()`, 5000);
      await sleep(800);
      marker = (await midiLog()).length;
      await evaluateExpr(cdp, `window.__unplug('Fake Synth A')`);
      await sleep(200);
      await evaluateExpr(cdp, `window.__plug('Fake Synth A')`);
      await sleep(1500);
      const supersededSent = (await midiLog()).slice(marker).filter((entry) => isSysex(entry) || entry.bytes[0] === 0xc2 || (entry.bytes[0] === 0xb2 && entry.bytes[1] === 7));
      // The check is not vacuous: the second tab, the active one, reset the instruments at its own page start.
      const secondTabLog = (await evaluateExpr(secondTab.cdp, 'window.__midiLog')) ?? [];
      const secondTabReset = secondTabLog.filter((entry) => entry.port === 'Fake Synth A' && same(entry.bytes, MT32_RESET)).length;
      report('a superseded tab never resets', supersededSegment === true && supersededSent.length === 0 && secondTabReset === 1,
        JSON.stringify({ tabIsSuperseded: supersededSegment === true, setupOrResetSentByTheSupersededTab: supersededSent.length, resetsFromTheActiveTab: secondTabReset }));
    } finally {
      await closeSecondTab();
    }
    // With the second tab gone nobody is the active page: reload the first tab so it authenticates and plays again.
    await reloadPage(cdp);
    await callTool(client, 'set_code', { code: SILENT, label: 'probe:midi reset section done' });

    // --- Indicator and popover with instruments ---
    // Words only: with a valid setup file the indicator names instruments instead of ports, an invalid file
    // has its own attention state, and the popover lists every instrument with its state, last reset and use.
    // The setup file is read when the page connects, so each case writes it and reloads through setScenario.
    {
      const MT32_LINE = `mt32: note("c3*8").midi('Fake Synth A', { midichannel: 3, sound: 'Str Sect 1' })`;
      const SC55_LINE = `sc55: note("c4*4").midi('Fake Synth B', { midichannel: 1, sound: 'Acoustic Grand Piano' })`;
      const MT32_ON_A = { id: 'mt32', model: 'mt32', port: 'Fake Synth A' };
      const SC55_ON_B = { id: 'sc55', model: 'sc55', port: 'Fake Synth B' };
      const NO_SETUP_NOTE = 'No instruments.json found, so port and sound names are not checked.';
      const writeRig = (instruments) => fs.writeFileSync(rigFile, JSON.stringify({ instruments }));
      /** The indicator as the user reads it: text, title, weight, attention and the dots. */
      const rigIndicator = () =>
        inDrawer(() =>
          evaluateExpr(
            cdp,
            `(() => {
              const box = document.getElementById('midi-state');
              const text = document.getElementById('midi-state-text');
              return {
                visible: !box.hidden && box.getBoundingClientRect().width > 0,
                text: text.textContent,
                title: box.getAttribute('title'),
                attention: box.dataset.attention === 'true',
                weight: getComputedStyle(text).fontWeight,
                dots: Array.from(document.querySelectorAll('#midi-dots .midi-dot')).map((dot) => ({ kind: dot.dataset.kind, title: dot.title })),
              };
            })()`,
          ),
        );
      /** The popover opened and read: its paragraphs, its rows (each li's code elements and text) and every tag inside it. */
      const popoverRows = () =>
        evaluateExpr(
          cdp,
          `(() => {
            const info = document.getElementById('midi-info');
            const help = document.getElementById('midi-help');
            const wasHidden = help.hidden;
            if (wasHidden) info.click();
            const result = {
              openWhileRead: !help.hidden,
              paragraphs: Array.from(help.querySelectorAll('p')).map((p) => ({ text: p.textContent, outputs: p.classList.contains('midi-outputs') })),
              rows: Array.from(help.querySelectorAll('li')).map((li) => ({ text: li.textContent, codes: Array.from(li.querySelectorAll('code')).map((code) => code.textContent), elements: li.children.length })),
              tags: Array.from(help.querySelectorAll('*')).map((el) => el.tagName.toLowerCase()),
            };
            if (wasHidden) info.click();
            return result;
          })()`,
        );
      const instrumentCase = async (instruments, code, label) => {
        writeRig(instruments);
        await setScenario({ permission: 'granted' });
        const refusal = await refusedWith(code, label);
        return refusal;
      };

      // (a) One instrument, connected: the indicator names it by its id.
      await instrumentCase([MT32_ON_A], MT32_LINE, 'probe:midi indicator one instrument');
      const oneShown = await waitIndicatorText('MIDI: mt32 connected', 5000);
      const one = await rigIndicator();
      report('indicator names one connected instrument', oneShown === true && one.attention === false && one.title === 'MIDI: mt32 connected' && one.dots.length === 1 && one.dots[0].kind === 'filled' && one.dots[0].title === 'mt32: connected', JSON.stringify(one));

      // (l) A refused evaluation leaves the indicator on the previous music.
      const refusedSound = await refusedWith(`mt32: note("c3*8").midi('Fake Synth A', { midichannel: 3, sound: 'No Such Sound' })`, 'probe:midi refused sound keeps the indicator');
      await sleep(300);
      const afterRefusal = await rigIndicator();
      const codeAfterRefusal = await callTool(client, 'get_code', {});
      report('a refusal leaves the indicator on the previous music', (refusedSound ?? '').startsWith('Evaluation failed: Unknown sound') && afterRefusal.text === 'MIDI: mt32 connected' && afterRefusal.dots.length === 1 && afterRefusal.attention === false && codeAfterRefusal.includes(MT32_LINE), JSON.stringify({ refusal: firstLine(refusedSound), indicator: afterRefusal, codeUnchanged: codeAfterRefusal.includes(MT32_LINE) }));

      // (m) An id longer than 24 characters is cut in the top bar and whole in the title.
      const longId = 'long-instrument-id'.padEnd(30, 'x');
      await instrumentCase([{ ...MT32_ON_A, id: longId }], MT32_LINE, 'probe:midi long instrument id');
      const cutText = `MIDI: ${longId.slice(0, 23)}\u2026 connected`;
      const longShown = await waitIndicatorText(cutText, 5000);
      const long = await rigIndicator();
      report('a long instrument id is cut in the top bar', longShown === true && long.text === cutText && long.title === `MIDI: ${longId} connected` && long.dots[0]?.title === `${longId}: connected`, JSON.stringify({ length: longId.length, text: long.text, title: long.title, dotTitle: long.dots[0]?.title }));

      // (b) Two instruments in use: counted. Also (k): none of the MIDI elements uses a reserved color.
      await instrumentCase([MT32_ON_A, SC55_ON_B], `${MT32_LINE}\n${SC55_LINE}`, 'probe:midi indicator two instruments');
      const twoShown = await waitIndicatorText('MIDI: 2 instruments connected', 5000);
      const two = await rigIndicator();
      report('indicator counts two connected instruments', twoShown === true && two.attention === false && two.dots.map((dot) => dot.title).join('|') === 'mt32: connected|sc55: connected' && two.dots.every((dot) => dot.kind === 'filled'), JSON.stringify(two));
      const colorLook = await evaluateExpr(
        cdp,
        `(() => {
          const info = document.getElementById('midi-info');
          const help = document.getElementById('midi-help');
          const wasHidden = help.hidden;
          if (wasHidden) info.click();
          const resolve = (name) => {
            const el = document.createElement('span');
            el.style.color = 'var(' + name + ')';
            document.body.appendChild(el);
            const color = getComputedStyle(el).color;
            el.remove();
            return color;
          };
          const reserved = ['--accent', '--accent-2', '--destructive'].map(resolve);
          const elements = [document.getElementById('midi-state'), document.getElementById('midi-state-text'), document.getElementById('midi-info'), help, ...help.querySelectorAll('*'), ...document.querySelectorAll('.midi-dot')];
          const used = elements.flatMap((el) => {
            const style = getComputedStyle(el);
            return [style.color, style.backgroundColor, style.borderTopColor, style.outlineColor];
          });
          const result = { checked: elements.length, neutral: used.every((value) => reserved.every((color) => value !== color)), errorLineInBanner: document.getElementById('eval-error').parentElement.id === 'problem-banner' };
          if (wasHidden) info.click();
          return result;
        })()`,
      );
      report('no MIDI element uses a reserved color with instruments', colorLook.neutral === true && colorLook.errorLineInBanner === true && colorLook.checked > 8, JSON.stringify(colorLook));

      // (c) An unplugged instrument flips the indicator, and plugging it back puts it right again.
      await evaluateExpr(cdp, `window.__unplug('Fake Synth B')`);
      const unpluggedShown = await waitIndicatorText('MIDI: sc55 unplugged', 3000);
      const unplugged = await rigIndicator();
      await evaluateExpr(cdp, `window.__plug('Fake Synth B')`);
      const replugged = await waitIndicatorText('MIDI: 2 instruments connected', 3000);
      report('an unplugged instrument flips the indicator', unpluggedShown === true && unplugged.attention === true && unplugged.dots.map((dot) => `${dot.kind}:${dot.title}`).join('|') === 'filled:mt32: connected|hollow:sc55: unplugged' && replugged === true, JSON.stringify({ unplugged, backToTwo: replugged === true }));

      // (d) A port that was never an output reads not found.
      const notFoundRefusal = await instrumentCase([MT32_ON_A, { id: 'sc55', model: 'sc55', port: 'Fake Synth C' }], `sc55: note("c4*4").midi('Fake Synth C', { midichannel: 1, sound: 'Acoustic Grand Piano' })`, 'probe:midi instrument not found');
      const notFoundShown = await waitIndicatorText('MIDI: sc55 not found', 5000);
      const notFound = await rigIndicator();
      report('a never-seen port reads not found', notFoundShown === true && notFound.attention === true && notFound.dots.length === 1 && notFound.dots[0].kind === 'hollow' && notFound.dots[0].title === 'sc55: not found', JSON.stringify({ refusal: firstLine(notFoundRefusal), indicator: notFound }));

      // (e) Two problems are counted.
      const problemsRefusal = await instrumentCase([{ ...MT32_ON_A, port: 'Fake Synth C' }, { ...SC55_ON_B, port: 'Fake Synth D' }], `mt32: note("c3*8").midi('Fake Synth C', { midichannel: 3, sound: 'Str Sect 1' })\nsc55: note("c4*4").midi('Fake Synth D', { midichannel: 1, sound: 'Acoustic Grand Piano' })`, 'probe:midi two instrument problems');
      const problemsShown = await waitIndicatorText('MIDI: 2 of 2 instruments need attention', 5000);
      const problems = await rigIndicator();
      report('two problems are counted', problemsShown === true && problems.attention === true && problems.dots.length === 2, JSON.stringify({ refusal: firstLine(problemsRefusal), indicator: problems }));

      // (g) Popover rows: every instrument in file order, two code elements each, the reset time and the use.
      // The second instrument is in the file but not in the code, so its row says so; with a valid file there is no no-setup line.
      await instrumentCase([MT32_ON_A, SC55_ON_B], MT32_LINE, 'probe:midi popover rows');
      await waitIndicatorText('MIDI: mt32 connected', 5000);
      await waitFor(cdp, `(() => { const li = document.querySelector('#midi-help li'); return li && /reset at/.test(li.textContent) ? true : null; })()`, 5000);
      const rowsNow = await popoverRows();
      const [rowMt32, rowSc55] = rowsNow.rows;
      report('popover rows list every instrument with its state, reset time and use', rowsNow.openWhileRead === true && rowsNow.rows.length === 2 && rowMt32.codes.join('|') === 'mt32|Fake Synth A' && /^mt32 \u00b7 Fake Synth A \u00b7 connected, reset at \d\d:\d\d$/.test(rowMt32.text) && rowSc55.codes.join('|') === 'sc55|Fake Synth B' && rowSc55.text.startsWith('sc55 \u00b7 Fake Synth B \u00b7 connected') && rowSc55.text.endsWith(', not used by the code') && !rowMt32.text.includes('not used by the code') && rowsNow.paragraphs[0].text === 'Moontide is sending to the instruments in instruments.json.', JSON.stringify(rowsNow));

      // (h) The no-setup line: only without a file, and only when the code names a port.
      const withFileNote = rowsNow.paragraphs.some((paragraph) => paragraph.text === NO_SETUP_NOTE);
      fs.rmSync(rigFile, { force: true });
      await setScenario({ permission: 'granted' });
      await callTool(client, 'set_code', { code: `note("c3*2").midi('Fake Synth A')`, label: 'probe:midi no setup note' });
      await waitIndicatorText('MIDI: Fake Synth A connected', 5000);
      const withPort = await popoverRows();
      await callTool(client, 'set_code', { code: `note("c3*2").midi()`, label: 'probe:midi no setup note without a port' });
      await waitIndicatorText('MIDI: using Fake Synth A', 5000);
      const withoutPort = await popoverRows();
      const noteParagraph = withPort.paragraphs.find((paragraph) => paragraph.text === NO_SETUP_NOTE);
      report('the no-setup line shows only without a file and only when the code names a port', noteParagraph !== undefined && noteParagraph.outputs === true && withFileNote === false && !withoutPort.paragraphs.some((paragraph) => paragraph.text === NO_SETUP_NOTE), JSON.stringify({ withPortAndNoFile: noteParagraph !== undefined, withValidFile: withFileNote, withoutPortAndNoFile: withoutPort.paragraphs.some((paragraph) => paragraph.text === NO_SETUP_NOTE) }));

      // (f) An invalid file has its own attention state: after the access problems and before any port state.
      const invalidAttempt = await instrumentCase([{ id: 'mt32', model: 'mt32' }], MT32_LINE, 'probe:midi invalid file indicator');
      const invalidShown = await waitIndicatorText('MIDI: instruments.json is invalid', 5000);
      const invalidNow = await rigIndicator();
      const invalidPopover = await popoverRows();
      await setScenario({ permission: 'denied' });
      await refusedWith(MT32_LINE, 'probe:midi invalid file and denied permission');
      const deniedShown = await waitIndicatorText('MIDI: permission denied', 5000);
      report('an invalid file has its own attention state, below access problems', (invalidAttempt ?? '').startsWith('Evaluation failed: instruments.json is invalid') && invalidShown === true && invalidNow.attention === true && invalidNow.dots.length === 0 && invalidNow.weight === '600' && invalidPopover.paragraphs[0].text === 'instruments.json has a problem, so no instruments are set up.' && deniedShown === true, JSON.stringify({ indicator: invalidNow, popoverLead: invalidPopover.paragraphs[0].text, rows: invalidPopover.rows.map((row) => row.text), deniedShown: deniedShown === true }));

      // (i) Setup-file text is shown as text, never as markup (the server words the field as it likes; the page shows it verbatim).
      fs.writeFileSync(rigFile, JSON.stringify({ instruments: [{ ...MT32_ON_A, '<b>x</b>': 1 }] }));
      await setScenario({ permission: 'granted' });
      await refusedWith(MT32_LINE, 'probe:midi markup in the setup file');
      await waitIndicatorText('MIDI: instruments.json is invalid', 5000);
      const markup = await popoverRows();
      report('setup-file text is shown as text', markup.rows.length >= 1 && markup.rows[0].codes[0].includes('<b>x</b>') && markup.rows[0].codes[0].startsWith('instruments[0]') && !markup.tags.includes('b') && markup.rows[0].elements === 1, JSON.stringify({ rows: markup.rows, tags: markup.tags }));

      // (j) Five problems: three rows, then "and 2 more".
      fs.writeFileSync(rigFile, JSON.stringify({ instruments: [{ ...MT32_ON_A, k1: 1, k2: 2, k3: 3, k4: 4, k5: 5 }] }));
      await setScenario({ permission: 'granted' });
      await refusedWith(MT32_LINE, 'probe:midi five problems');
      await waitIndicatorText('MIDI: instruments.json is invalid', 5000);
      const five = await popoverRows();
      report('the invalid rows stop at three', five.rows.length === 4 && five.rows.slice(0, 3).every((row) => row.codes.length === 1) && five.rows[3].text === 'and 2 more' && five.rows[3].codes.length === 0 && five.paragraphs.filter((paragraph) => paragraph.outputs).length === 0, JSON.stringify({ rows: five.rows.map((row) => row.text) }));
    }

    // --- Instruments view ---
    // Key 6 opens one card per instrument of instruments.json, in file order, each naming its id, its model and
    // its port. A port that the code does not use flips its card live when it is unplugged and plugged back,
    // with no reload. MIDI is already allowed (the stored permission is granted), so the ports are read.
    {
      const writeRig = (instruments) => fs.writeFileSync(rigFile, JSON.stringify({ instruments }));
      /** The cards as the user reads them: id, name, model, port, dot kind and state words. */
      const instrumentCards = () =>
        evaluateExpr(
          cdp,
          `(() => Array.from(document.querySelectorAll('#instruments-list .instrument-card')).map((card) => {
            const rows = card.querySelectorAll('.instrument-row');
            return {
              id: card.dataset.instrument,
              name: card.querySelector('.instrument-name').textContent,
              model: rows[0].querySelector('.instrument-value').textContent,
              port: card.querySelector('.instrument-port-name').textContent,
              dot: card.querySelector('.midi-dot').dataset.kind,
              words: card.querySelector('.instrument-state').textContent,
            };
          }))()`,
        );
      writeRig([
        { id: 'mt32', model: 'mt32', port: 'Fake Synth A' },
        { id: 'sc55', model: 'sc55', port: 'Fake Synth B' },
      ]);
      await setScenario({ permission: 'granted' });
      await openView(6);
      const cardsShown = await waitFor(cdp, `document.querySelectorAll('#instruments-list .instrument-card').length === 2 && document.querySelector('#instruments-list .midi-dot').dataset.kind === 'filled' ? true : null`, 5000);
      const firstCards = await instrumentCards();
      const expectedCards = [
        { id: 'mt32', name: 'mt32', model: 'Roland MT-32', port: 'Fake Synth A', dot: 'filled', words: 'connected' },
        { id: 'sc55', name: 'sc55', model: 'Roland SC-55', port: 'Fake Synth B', dot: 'filled', words: 'connected' },
      ];
      report('instruments view: key 6 shows one card per instrument in file order', cardsShown === true && JSON.stringify(firstCards) === JSON.stringify(expectedCards), JSON.stringify(firstCards));

      await evaluateExpr(cdp, `window.__probeNoReload = true`);
      await evaluateExpr(cdp, `window.__unplug('Fake Synth B')`);
      const flippedOff = await waitFor(cdp, `(() => { const cards = document.querySelectorAll('#instruments-list .instrument-card'); return cards.length === 2 && cards[1].querySelector('.midi-dot').dataset.kind === 'hollow' && cards[1].querySelector('.instrument-state').textContent === 'unplugged' ? true : null; })()`, 3000);
      const whileUnplugged = await instrumentCards();
      await evaluateExpr(cdp, `window.__plug('Fake Synth B')`);
      const flippedOn = await waitFor(cdp, `(() => { const cards = document.querySelectorAll('#instruments-list .instrument-card'); return cards.length === 2 && cards[1].querySelector('.midi-dot').dataset.kind === 'filled' && cards[1].querySelector('.instrument-state').textContent === 'connected' ? true : null; })()`, 3000);
      const afterPlug = await instrumentCards();
      const noReload = await evaluateExpr(cdp, `window.__probeNoReload === true`);
      report(
        'instruments view: unplugging and plugging a port flips its card live, without a reload',
        flippedOff === true && flippedOn === true && noReload === true && whileUnplugged[0].dot === 'filled' && whileUnplugged[0].words === 'connected' && whileUnplugged[1].dot === 'hollow' && whileUnplugged[1].words === 'unplugged' && JSON.stringify(afterPlug) === JSON.stringify(expectedCards),
        JSON.stringify({ whileUnplugged, afterPlug, noReload }),
      );

      await pressKey(cdp, 'Escape');
      fs.rmSync(rigFile, { force: true });
      await setScenario({ permission: 'granted' });
    }

    // --- Instruments view, live behavior ---
    // Plugs and unplugs flip the right card in place (focus and scroll stay), are spoken once, an unchanged
    // redraw writes nothing, the view never asks for MIDI access, Safari and a blocked permission are told in
    // words, and a take-over or a new instruments.json keeps the user's place. Words come from the page's own
    // copy tables, never retyped here.
    {
      const writeRig = (instruments) => fs.writeFileSync(rigFile, JSON.stringify({ instruments }));
      const TWO = [
        { id: 'mt32', model: 'mt32', port: 'Fake Synth A' },
        { id: 'sc55', model: 'sc55', port: 'Fake Synth B' },
      ];
      const PLAYING = [
        `lead: note("c3*4").midi('Fake Synth A', { midichannel: 3, sound: 'Str Sect 1' })`,
        `pad: note("e3*2").midi('Fake Synth A', { midichannel: 3, sound: 'Str Sect 1' })`,
      ].join('\n');
      const MIDI_LINE = `lead: note("c3*4").midi('Fake Synth A', { midichannel: 3 })`;
      // The Instruments lines the page logged as errors, kept across the reloads of this block.
      const viewErrors = [];
      const collectErrors = async () => {
        const lines = (await evaluateExpr(cdp, 'window.__consoleErrors')) ?? [];
        for (const line of lines) if (/instrument/i.test(line) && !/instruments\.json/i.test(line)) viewErrors.push(line);
      };
      const scenario = async (next) => {
        await collectErrors();
        await setScenario(next);
      };
      /** Everything the view shows, read in one go: notice, message parts, status and one entry per card. */
      const readView = () =>
        evaluateExpr(
          cdp,
          `(() => {
            const shown = (id) => { const el = document.getElementById(id); return el.hidden ? null : el.textContent; };
            const colorOf = (value) => { const s = document.createElement('span'); s.style.color = value; document.body.append(s); const c = getComputedStyle(s).color; s.remove(); return c; };
            const textColor = colorOf('var(--text)');
            const bodyHidden = document.getElementById('instruments-body').hidden;
            const inUseLabel = ${JSON.stringify(INSTRUMENTS_COPY.labelInUse)};
            const cards = bodyHidden ? [] : Array.from(document.querySelectorAll('#instruments-list .instrument-card')).map((card) => {
              const dot = card.querySelector('.midi-dot');
              const words = card.querySelector('.instrument-state');
              const rows = Array.from(card.querySelectorAll('.instrument-row'));
              const inUse = rows.find((row) => row.querySelector('.instrument-label').textContent.startsWith(inUseLabel));
              return {
                id: card.dataset.instrument,
                dot: dot.dataset.kind,
                dotHidden: dot.getAttribute('aria-hidden') === 'true',
                words: words.textContent,
                weight: getComputedStyle(words).fontWeight,
                emphasised: getComputedStyle(words).color === textColor,
                describedByWords: document.getElementById(card.getAttribute('aria-describedby')) === words,
                inUse: inUse === undefined ? null : Array.from(inUse.querySelectorAll('.instrument-inuse-line')).map((line) => line.textContent),
              };
            });
            const active = document.activeElement;
            return {
              open: document.getElementById('workspace').dataset.view === 'instruments',
              notice: shown('instruments-notice'),
              lead: document.getElementById('instruments-message').hidden ? null : document.getElementById('instruments-message-text').textContent,
              sub: document.getElementById('instruments-message').hidden ? null : shown('instruments-message-sub'),
              bodyHidden,
              status: document.getElementById('instruments-status').textContent,
              cards,
              active: active && active.dataset && active.dataset.instrument !== undefined ? active.dataset.instrument : null,
              scrollTop: document.getElementById('instruments-body').scrollTop,
            };
          })()`,
        );
      /** Waits until the cards drawn satisfy a page-side condition on `cards` (an array of the entries of readView). */
      const waitCards = (condition, ms = 5000) =>
        waitFor(
          cdp,
          `(() => {
            const bodyHidden = document.getElementById('instruments-body').hidden;
            const cards = bodyHidden ? [] : Array.from(document.querySelectorAll('#instruments-list .instrument-card')).map((card) => ({
              id: card.dataset.instrument,
              dot: card.querySelector('.midi-dot').dataset.kind,
              words: card.querySelector('.instrument-state').textContent,
            }));
            return (${condition})(cards) ? true : null;
          })()`,
          ms,
        );
      const rigIndicator = () =>
        evaluateExpr(cdp, `(() => ({ text: document.getElementById('midi-state-text').textContent, hidden: document.getElementById('midi-state').hidden }))()`);
      /** Records every text a node takes from now on, in window[name]. */
      const recordTexts = (selector, name) =>
        evaluateExpr(
          cdp,
          `(() => {
            const node = document.querySelector(${JSON.stringify(selector)});
            window[${JSON.stringify(name)}] = [];
            new MutationObserver(() => window[${JSON.stringify(name)}].push(node.textContent)).observe(node, { childList: true, characterData: true, subtree: true });
          })()`,
        );
      // A short window makes #instruments-body scroll with two cards, so "scroll kept" is a real check.
      const shrink = async () => {
        await cdp('Emulation.setDeviceMetricsOverride', { width: 1024, height: 360, deviceScaleFactor: 1, mobile: false });
        await sleep(300);
      };
      const unshrink = () => cdp('Emulation.clearDeviceMetricsOverride');
      const eachPort = (names, action) => evaluateExpr(cdp, `${JSON.stringify(names)}.forEach((name) => window.${action}('Fake Synth ' + name))`);

      // (1) A plug change flips its card in place; focus and scroll stay and the change is spoken once.
      writeRig(TWO);
      await scenario({ permission: 'granted' });
      await callTool(client, 'set_code', { code: PLAYING, label: 'probe:midi instruments view playing' });
      await openView(6);
      const bothFilled = await waitCards((cards) => cards.length === 2 && cards.every((card) => card.dot === 'filled'));
      await shrink();
      let focusCheck;
      try {
        await evaluateExpr(
          cdp,
          `(() => {
            const card = document.querySelectorAll('#instruments-list .instrument-card')[1];
            window.__probeCard = card;
            card.focus();
            const body = document.getElementById('instruments-body');
            body.scrollTop = 30;
          })()`,
        );
        await recordTexts('#instruments-status', '__statusTexts');
        const before = await readView();
        await evaluateExpr(cdp, `window.__unplug('Fake Synth B')`);
        await waitCards((cards) => cards.length === 2 && cards[1].dot === 'hollow' && cards[1].words === 'unplugged');
        await sleep(300);
        const unplugged = await readView();
        const sameCard = await evaluateExpr(cdp, `document.activeElement === window.__probeCard && window.__probeCard.isConnected`);
        await evaluateExpr(cdp, `window.__plug('Fake Synth B')`);
        await waitCards((cards) => cards.length === 2 && cards[1].dot === 'filled' && cards[1].words === 'connected');
        await sleep(300);
        const replugged = await readView();
        const spoken = await evaluateExpr(cdp, 'window.__statusTexts');
        focusCheck = { before, unplugged, replugged, sameCard, spoken };
      } finally {
        await unshrink();
      }
      const unpluggedWords = fill(MIDI_COPY.dotUnplugged, { port: 'sc55' });
      const connectedWords = fill(MIDI_COPY.dotConnected, { port: 'sc55' });
      const flipped = focusCheck.unplugged.cards[1];
      report(
        'instruments view: plug and unplug keep focus and scroll, and are announced once',
        bothFilled === true &&
          flipped.dot === 'hollow' &&
          flipped.words === MIDI_COPY.rowUnplugged &&
          flipped.weight === '600' &&
          flipped.emphasised === true &&
          flipped.dotHidden === true &&
          flipped.describedByWords === true &&
          focusCheck.unplugged.cards[0].dot === 'filled' &&
          focusCheck.sameCard === true &&
          focusCheck.unplugged.active === 'sc55' &&
          focusCheck.before.scrollTop > 0 &&
          focusCheck.unplugged.scrollTop === focusCheck.before.scrollTop &&
          focusCheck.replugged.scrollTop === focusCheck.before.scrollTop &&
          focusCheck.replugged.active === 'sc55' &&
          focusCheck.unplugged.status === unpluggedWords &&
          focusCheck.replugged.status === connectedWords &&
          JSON.stringify(focusCheck.spoken) === JSON.stringify([unpluggedWords, connectedWords]),
        JSON.stringify({ flipped, scrollBefore: focusCheck.before.scrollTop, scrollAfter: focusCheck.unplugged.scrollTop, activeAfter: focusCheck.unplugged.active, sameCard: focusCheck.sameCard, spoken: focusCheck.spoken }),
      );

      // (2) The card and the top-bar indicator agree on the instrument the code uses.
      await evaluateExpr(cdp, `window.__unplug('Fake Synth A')`);
      await waitCards((cards) => cards.length === 2 && cards[0].dot === 'hollow' && cards[0].words === 'unplugged');
      const indicatorUnplugged = fill(MIDI_COPY.indicatorInstrumentUnplugged, { id: 'mt32' });
      await waitFor(cdp, `document.getElementById('midi-state-text').textContent === ${JSON.stringify(indicatorUnplugged)} ? true : null`, 5000);
      const barUnplugged = await rigIndicator();
      const cardUnplugged = (await readView()).cards[0];
      await evaluateExpr(cdp, `window.__plug('Fake Synth A')`);
      await waitCards((cards) => cards.length === 2 && cards[0].dot === 'filled' && cards[0].words === 'connected');
      const indicatorConnected = fill(MIDI_COPY.indicatorInstrumentConnected, { id: 'mt32' });
      await waitFor(cdp, `document.getElementById('midi-state-text').textContent === ${JSON.stringify(indicatorConnected)} ? true : null`, 5000);
      const barConnected = await rigIndicator();
      report(
        'instruments view: the card and the top bar agree on the instrument the code uses',
        cardUnplugged.words === MIDI_COPY.rowUnplugged && barUnplugged.text === indicatorUnplugged && barConnected.text === indicatorConnected,
        JSON.stringify({ cardWords: cardUnplugged.words, barUnplugged: barUnplugged.text, barConnected: barConnected.text }),
      );

      // (3) The In use row names the tracks that play each instrument, and the Mixer tag agrees.
      const inUse = await readView();
      const mt32Line = `lead${MIDI_COPY.rowPartsJoin}pad${MIDI_COPY.rowSeparator}ch 3`;
      await openView(3);
      const mixerTag = await waitFor(cdp, `(() => { const tag = document.querySelector('.mx-strip[data-track="label:lead"] .mx-tag'); return tag !== null && !tag.hidden ? tag.textContent : null; })()`, 5000);
      await openView(6);
      await waitCards((cards) => cards.length === 2);
      report(
        'instruments view: the In use row names the tracks that play each instrument',
        JSON.stringify(inUse.cards[0].inUse) === JSON.stringify([mt32Line]) &&
          JSON.stringify(inUse.cards[1].inUse) === JSON.stringify([MIDI_COPY.rowNotUsed]) &&
          typeof mixerTag === 'string' &&
          mixerTag.endsWith(`${MIDI_COPY.rowSeparator}ch 3`),
        JSON.stringify({ mt32: inUse.cards[0].inUse, sc55: inUse.cards[1].inUse, mixerTag }),
      );

      // (4) Opening the view and an unchanged redraw announce nothing and write nothing.
      await openView(6);
      await waitCards((cards) => cards.length === 2);
      const statusOnOpen = (await readView()).status;
      await evaluateExpr(
        cdp,
        `(() => {
          window.__viewMutations = 0;
          new MutationObserver((records) => { window.__viewMutations += records.length; }).observe(document.getElementById('instruments-view'), { subtree: true, childList: true, characterData: true, attributes: true });
        })()`,
      );
      await callTool(client, 'get_midi_instruments', {});
      await sleep(500);
      const mutations = await evaluateExpr(cdp, 'window.__viewMutations');
      const statusAfter = (await readView()).status;
      report(
        'instruments view: opening it and an unchanged redraw announce nothing and write nothing',
        statusOnOpen === '' && mutations === 0 && statusAfter === '',
        JSON.stringify({ statusOnOpen, mutations, statusAfter }),
      );

      // (5) Four ports changed at once: three are spoken, the rest is "and 1 more".
      const FOUR = ['A', 'B', 'C', 'D'].map((letter, index) => ({ id: `a${index + 1}`, model: index % 2 === 0 ? 'mt32' : 'sc55', port: `Fake Synth ${letter}` }));
      writeRig(FOUR);
      await scenario({ permission: 'granted', outputs: FOUR.map((instrument) => instrument.port) });
      await openView(6);
      await waitCards((cards) => cards.length === 4 && cards.every((card) => card.dot === 'filled'));
      await recordTexts('#instruments-status', '__statusTexts');
      await eachPort(['A', 'B', 'C', 'D'], '__unplug');
      await waitCards((cards) => cards.length === 4 && cards.every((card) => card.dot === 'hollow'));
      await sleep(500);
      const cutTexts = await evaluateExpr(cdp, 'window.__statusTexts');
      const cutExpected = [...['a1', 'a2', 'a3'].map((id) => fill(MIDI_COPY.dotUnplugged, { port: id })), fill(MIDI_COPY.rowsMore, { count: 1 })].join(' ');
      const spokenIds = new Set(cutTexts.flatMap((text) => [...text.matchAll(/\ba(\d): unplugged/g)].map((found) => `a${found[1]}`)));
      const splitReads =
        cutTexts.length >= 2 &&
        ['a1', 'a2', 'a3', 'a4'].every((id) => spokenIds.has(id) || cutTexts.some((text) => text.includes(fill(MIDI_COPY.rowsMore, { count: 1 })))) &&
        cutTexts.every((text) => text.split(' ').length <= 3 * 2 + 3);
      report(
        'instruments view: more than three changes at once are cut with and N more',
        (cutTexts.length === 1 && cutTexts[0] === cutExpected) || splitReads,
        JSON.stringify({ texts: cutTexts, expected: cutExpected, singleRead: cutTexts.length === 1 }),
      );

      // (6) With MIDI not allowed the view asks for nothing and reads "not checked".
      writeRig(TWO);
      await scenario({ permission: 'prompt' });
      await openView(6);
      await waitCards((cards) => cards.length === 2);
      const requestsOnOpen = await evaluateExpr(cdp, 'window.__midiRequests');
      await callTool(client, 'get_midi_instruments', {});
      await sleep(500);
      const idle = await readView();
      const requestsAfterRedraw = await evaluateExpr(cdp, 'window.__midiRequests');
      report(
        'instruments view: with MIDI not allowed the view asks for nothing and reads not checked',
        requestsOnOpen === 0 &&
          requestsAfterRedraw === 0 &&
          idle.cards.length === 2 &&
          idle.cards.every((card) => card.dot === 'unknown' && card.words === INSTRUMENTS_COPY.portUnchecked) &&
          idle.notice === INSTRUMENTS_COPY.noticeIdle,
        JSON.stringify({ requestsOnOpen, requestsAfterRedraw, dots: idle.cards.map((card) => card.dot), words: idle.cards.map((card) => card.words), notice: idle.notice }),
      );

      // (7) A browser without Web MIDI says so before any MIDI code, and above the no-file sentence.
      await scenario({ webMidi: false });
      await openView(6);
      await waitCards((cards) => cards.length === 2);
      const noMidi = await readView();
      const noMidiNotice = `${MIDI_COPY.popUnsupportedLead} ${INSTRUMENTS_COPY.noticeUnsupportedClosing}`;
      fs.rmSync(rigFile, { force: true });
      await callTool(client, 'get_midi_instruments', {});
      await waitFor(cdp, `document.getElementById('instruments-body').hidden ? true : null`, 5000);
      const noFile = await readView();
      report(
        'instruments view: a browser without Web MIDI says so before any MIDI code',
        noMidi.notice === noMidiNotice &&
          noMidi.cards.every((card) => card.words === INSTRUMENTS_COPY.portUnchecked) &&
          noFile.notice === noMidiNotice &&
          noFile.cards.length === 0 &&
          typeof noFile.lead === 'string' &&
          noFile.lead.startsWith(INSTRUMENTS_COPY.absentLeadPlain.slice(0, -1)),
        JSON.stringify({ notice: noMidi.notice, wordsBeforeFileRemoved: noMidi.cards.map((card) => card.words), noFile: { notice: noFile.notice, lead: noFile.lead, cards: noFile.cards.length } }),
      );

      // (8) A blocked permission shows its notice, whole, at 1024 px wide.
      writeRig(TWO);
      await scenario({ permission: 'denied' });
      await refusedWith(MIDI_LINE, 'probe:midi instruments view blocked');
      await openView(6);
      const deniedNotice = `${MIDI_COPY.popDeniedLead} ${INSTRUMENTS_COPY.noticeDeniedClosing}`;
      await waitFor(cdp, `document.getElementById('instruments-notice').textContent === ${JSON.stringify(deniedNotice)} && !document.getElementById('instruments-notice').hidden ? true : null`, 5000);
      // The sentence is about 960 px of text, so at 1024 px it can fit on one line; it must never overflow there,
      // and at 640 px it must wrap onto more than one line, whole.
      const noticeAt = async (width) => {
        await cdp('Emulation.setDeviceMetricsOverride', { width, height: 768, deviceScaleFactor: 1, mobile: false });
        await sleep(300);
        return evaluateExpr(
          cdp,
          `(() => {
            const notice = document.getElementById('instruments-notice');
            const style = getComputedStyle(notice);
            const content = notice.getBoundingClientRect().height - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom) - parseFloat(style.borderBottomWidth);
            return { text: notice.textContent, scrollWidth: notice.scrollWidth, clientWidth: notice.clientWidth, lines: Math.round(content / parseFloat(style.lineHeight)), contentHeight: content, lineHeight: parseFloat(style.lineHeight) };
          })()`,
        );
      };
      const wrapped = {};
      try {
        for (const width of [1024, 640]) wrapped[width] = await noticeAt(width);
      } finally {
        await cdp('Emulation.clearDeviceMetricsOverride');
      }
      report(
        'instruments view: a blocked permission shows its notice, whole, at 1024 px and wrapped when narrower',
        Object.values(wrapped).every((seen) => seen.text === deniedNotice && seen.scrollWidth <= seen.clientWidth) && wrapped[640].contentHeight > 1.5 * wrapped[640].lineHeight,
        JSON.stringify({ at1024: { lines: wrapped[1024].lines, scrollWidth: wrapped[1024].scrollWidth, clientWidth: wrapped[1024].clientWidth }, at640: { lines: wrapped[640].lines, scrollWidth: wrapped[640].scrollWidth, clientWidth: wrapped[640].clientWidth } }),
      );

      // (9) A tab that lost the playing role shows a message, and taking the role back brings the cards.
      writeRig(TWO);
      await scenario({ permission: 'granted' });
      await openView(6);
      await waitCards((cards) => cards.length === 2);
      let takeOver;
      try {
        await openSecondTab();
        await waitFor(cdp, `document.getElementById('instruments-message-text').textContent === ${JSON.stringify(MIDI_COPY.takeoverText)} && !document.getElementById('instruments-message').hidden ? true : null`, 8000);
        const superseded = await readView();
        await recordTexts('#instruments-message-text', '__leadTexts');
        await evaluateExpr(cdp, `document.getElementById('take-back').click()`);
        await waitCards((cards) => cards.length === 2, 8000);
        const leads = await evaluateExpr(cdp, 'window.__leadTexts');
        takeOver = { superseded, leads };
      } finally {
        await closeSecondTab();
      }
      report(
        'instruments view: a tab that lost the playing role shows a message, and taking it back brings the cards',
        takeOver.superseded.lead === MIDI_COPY.takeoverText &&
          typeof takeOver.superseded.sub === 'string' &&
          takeOver.superseded.sub.includes(MIDI_COPY.takeBack) &&
          takeOver.superseded.cards.length === 0 &&
          !takeOver.leads.includes(CONNECTION_LABELS.connecting),
        JSON.stringify({ lead: takeOver.superseded.lead, sub: takeOver.superseded.sub, cardsWhileSuperseded: takeOver.superseded.cards.length, leadsAfterTakeBack: takeOver.leads }),
      );
      await reloadPage(cdp);

      // (10) A new instruments.json read while the view is open keeps focus on the same instrument.
      writeRig(TWO);
      await scenario({ permission: 'granted' });
      await openView(6);
      await waitCards((cards) => cards.length === 2);
      await shrink();
      let reread;
      try {
        await evaluateExpr(cdp, `(() => { document.querySelectorAll('#instruments-list .instrument-card')[1].focus(); document.getElementById('instruments-body').scrollTop = 30; })()`);
        const before = await readView();
        writeRig([...TWO, { id: 'extra', model: 'mt32', port: 'Fake Synth C' }]);
        await callTool(client, 'get_midi_instruments', {});
        await waitCards((cards) => cards.length === 3);
        await sleep(300);
        const grown = await readView();
        writeRig([TWO[0], { id: 'extra', model: 'mt32', port: 'Fake Synth C' }]);
        await callTool(client, 'get_midi_instruments', {});
        await waitCards((cards) => cards.length === 2 && cards[1].id === 'extra');
        await sleep(300);
        const shrunk = await readView();
        reread = { before, grown, shrunk };
      } finally {
        await unshrink();
      }
      report(
        'instruments view: a new instruments.json read while the view is open keeps focus on the same instrument',
        reread.grown.cards.length === 3 &&
          reread.grown.active === 'sc55' &&
          reread.before.scrollTop > 0 &&
          reread.grown.scrollTop === reread.before.scrollTop &&
          reread.shrunk.cards.length === 2 &&
          reread.shrunk.active === 'mt32',
        JSON.stringify({ scrollBefore: reread.before.scrollTop, scrollGrown: reread.grown.scrollTop, activeGrown: reread.grown.active, activeShrunk: reread.shrunk.active, idsShrunk: reread.shrunk.cards.map((card) => card.id) }),
      );

      // (11) A port that does not exist and a name that fits two outputs read like an unplugged one.
      writeRig([
        { id: 'gone', model: 'mt32', port: 'No Such Synth' },
        { id: 'both', model: 'sc55', port: 'Fake Synth' },
      ]);
      await scenario({ permission: 'granted' });
      await openView(6);
      await waitCards((cards) => cards.length === 2 && cards.every((card) => card.dot === 'hollow'));
      const problems = (await readView()).cards;
      report(
        'instruments view: not found and ambiguous ports show the hollow ring and their words in weight 600',
        problems.length === 2 &&
          problems[0].words === MIDI_COPY.rowRigNotFound &&
          problems[1].words === fill(MIDI_COPY.rowAmbiguous, { outputs: listNames(['Fake Synth A', 'Fake Synth B']) }) &&
          problems.every((card) => card.dot === 'hollow' && card.weight === '600' && card.emphasised === true && card.dotHidden === true && card.describedByWords === true),
        JSON.stringify(problems),
      );

      // (12) The longest names the rig accepts wrap inside their card, at every size and in every layout. The
      // 32-character id, the 200-character port, the 80-character model name, the 40-character control names and six
      // 30-character track names are all in the DOM whole, and nothing is cut with an ellipsis. The port is the
      // scenario's only extra fake output, so the card reads connected and the tracks that use it are listed.
      const longId = 'probe-long-id-abcdefghijklmnopqrstuvwxyz'.slice(0, 32);
      const longPort = `Probe Long Port ${'x'.repeat(184)}`;
      const longModelName = `Probe Long Model ${'M'.repeat(63)}`;
      const longControlNames = ['A'.repeat(40), 'B'.repeat(40), 'C'.repeat(40)].map((letters, index) => `Control ${index + 1} ${letters}`.slice(0, 40));
      const longTracks = Array.from({ length: 6 }, (_, index) => `long_track_${index + 1}_abcdefghijklmnopqrstuvwxyz`.slice(0, 30));
      fs.mkdirSync(path.join(dataDir, 'models'), { recursive: true });
      fs.writeFileSync(
        path.join(dataDir, 'models', 'probelong.json'),
        JSON.stringify({
          id: 'probelong',
          name: longModelName,
          channels: { melodic: [1, 2, 3, 4, 5, 6, 7, 8, 9], rhythm: [10] },
          bankSelect: 'none',
          defaultVolume: 100,
          controls: longControlNames.map((name, index) => ({ id: `long${index + 1}`, name, cc: 20 + index, min: 0, max: 127, default: 64 })),
          sounds: { melodic: [{ name: 'Probe Tone', program: 0 }], rhythm: [] },
          notes: [],
        }),
      );
      writeRig([{ id: longId, model: 'probelong', port: longPort }]);
      await scenario({ permission: 'granted', outputs: [longPort, 'Fake Synth A'] });
      await callTool(client, 'set_code', {
        code: longTracks.map((label, index) => `${label}: note("c3*2").midi('${longPort}', { midichannel: ${1 + (index % 2)} })`).join('\n'),
        label: 'probe:midi instruments long names',
      });
      await openView(6);
      await waitCards((cards) => cards.length === 1 && cards[0].dot === 'filled');
      const startLayout = await evaluateExpr(cdp, `document.getElementById('workspace').dataset.layout`);
      const longResults = [];
      try {
        for (const [width, height] of [[1024, 768], [1366, 768], [1920, 1080]]) {
          await cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
          await sleep(250);
          for (const layout of ['a', 'b', 'c']) {
            await evaluateExpr(cdp, `(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); })()`);
            await pressKey(cdp, layout);
            await sleep(150);
            const seen = await evaluateExpr(
              cdp,
              `(() => {
                const card = document.querySelector('#instruments-list .instrument-card');
                const list = document.getElementById('instruments-list');
                const body = document.getElementById('instruments-body');
                const text = card.textContent;
                const needed = ${JSON.stringify([longId, longPort, longModelName, ...longControlNames, ...longTracks])};
                return {
                  layout: document.getElementById('workspace').dataset.layout,
                  cardFits: card.scrollWidth <= card.clientWidth,
                  listFits: list.scrollWidth <= list.clientWidth && body.scrollWidth <= body.clientWidth,
                  ellipsis: [card, ...card.querySelectorAll('*')].filter((node) => getComputedStyle(node).textOverflow === 'ellipsis').length,
                  missing: needed.filter((part) => !text.includes(part)),
                  // A channel word such as 1–9 never breaks after its dash.
                  words: card.querySelectorAll('.instrument-word').length,
                  splitWords: [...card.querySelectorAll('.instrument-word')].filter((word) => word.getClientRects().length > 1).length,
                };
              })()`,
            );
            longResults.push({ size: `${width}x${height}`, ...seen });
          }
        }
      } finally {
        await cdp('Emulation.clearDeviceMetricsOverride');
        if ((await evaluateExpr(cdp, `document.getElementById('workspace').dataset.layout`)) !== startLayout) await pressKey(cdp, startLayout);
      }
      report(
        'instruments view: the longest names wrap inside their card at every size and layout',
        longResults.length === 9 && longResults.every((seen, index) => seen.layout === ['a', 'b', 'c'][index % 3] && seen.cardFits && seen.listFits && seen.ellipsis === 0 && seen.missing.length === 0 && seen.words > 0 && seen.splitWords === 0),
        JSON.stringify(longResults.map((seen) => `${seen.size}${seen.layout}:${seen.cardFits && seen.listFits ? 'fits' : 'OVERFLOW'},ellipsis${seen.ellipsis},missing${seen.missing.length},words${seen.words},split${seen.splitWords}`)),
      );
      fs.rmSync(path.join(dataDir, 'models'), { recursive: true, force: true });

      // Back to the defaults, like the indicator-with-instruments block: no rig file, default scenario, silent code, a fresh page.
      await pressKey(cdp, 'Escape');
      fs.rmSync(rigFile, { force: true });
      await collectErrors();
      report('instruments view: the page logged no Instruments error during these checks', viewErrors.length === 0, JSON.stringify(viewErrors));
      await setScenario({ permission: 'granted' });
    }

    // --- Drum kits and maps on the Instruments card ---
    // The card of an instrument with a rhythm channel shows the Drum kit row and a Drum map line: one native disclosure
    // that sends nothing and stores nothing. Maps are built from the shipped models and from fixtures, not heard on hardware.
    {
      const writeRig = (instruments) => fs.writeFileSync(rigFile, JSON.stringify({ instruments }));
      /** What the first card shows about its drums, read in the page: the labels, the kit lines, the disclosures and the notes of the first. */
      const drumCardFacts = () =>
        evaluateExpr(
          cdp,
          `(() => {
            const card = document.querySelector('#instruments-list .instrument-card');
            if (card === null) return null;
            const flat = (text) => text.replace(/\\s+/g, ' ').trim();
            const rows = [...card.querySelectorAll('.instrument-row')];
            const labels = rows.map((row) => row.querySelector('dt').firstChild.textContent);
            const kitRow = rows.find((row) => row.querySelector('dt').firstChild.textContent === ${JSON.stringify(INSTRUMENTS_COPY.labelDrumKit)});
            const details = [...card.querySelectorAll('details.instrument-drum-map')];
            const first = details[0];
            const items = first === undefined ? [] : [...first.querySelectorAll('.instrument-drum-notes li')];
            return {
              labels,
              kitLines: kitRow === undefined ? null : [...kitRow.querySelectorAll('.instrument-drum-kit')].map((line) => line.textContent),
              kitTitles: kitRow === undefined ? null : [...kitRow.querySelectorAll('.instrument-drum-kit')].map((line) => line.getAttribute('title')),
              details: details.length,
              open: first === undefined ? null : first.open,
              summary: first === undefined ? null : flat(first.querySelector('summary').innerText),
              notes: items.length,
              firstNote: items.length === 0 ? null : flat(items[0].textContent),
              lastNote: items.length === 0 ? null : flat(items[items.length - 1].textContent),
              notesShown: items.length === 0 ? null : items[0].checkVisibility(),
              unknownLines: [...card.querySelectorAll('.instrument-drum-unknown, .instrument-drum-sub')].map((line) => flat(line.textContent)),
            };
          })()`,
        );
      const drumCardsNow = (condition) => waitFor(cdp, `(() => { const card = document.querySelector('#instruments-list .instrument-card'); return card !== null && (${condition})(card) ? true : null; })()`, 6000);

      writeRig([{ id: 'mt32', model: 'mt32', port: 'Fake Synth A' }]);
      await setScenario({ permission: 'granted' });
      await callTool(client, 'set_code', { code: `drums: note("36 38").midi('Fake Synth A', { midichannel: 10 })`, label: 'probe:midi drum card tracer' });
      await openView(6);
      await drumCardsNow(`(card) => card.querySelector('details.instrument-drum-map') !== null && card.querySelector('.instrument-drum-kit') !== null`);
      const closedFacts = await drumCardFacts();
      await evaluateExpr(cdp, `document.querySelector('#instruments-list details.instrument-drum-map > summary').focus()`);
      await pressKey(cdp, 'Enter');
      await drumCardsNow(`(card) => card.querySelector('details.instrument-drum-map').open === true`);
      const openFacts = await drumCardFacts();
      const labelsOrder = closedFacts !== null && closedFacts.labels.indexOf(INSTRUMENTS_COPY.labelDrumKit) !== -1 && closedFacts.labels.indexOf(INSTRUMENTS_COPY.labelDrumKit) === closedFacts.labels.indexOf(INSTRUMENTS_COPY.labelInUse) - 1;
      report(
        'instruments view: the MT-32 card shows its drum kit row and a Drum map line that opens',
        closedFacts !== null &&
          labelsOrder &&
          JSON.stringify(closedFacts.kitLines) === JSON.stringify(['not chosen by the code · ch 10']) &&
          closedFacts.details === 1 &&
          closedFacts.open === false &&
          closedFacts.summary === 'Drum map: Roland MT-32 Rhythm (34) show notes' &&
          closedFacts.notesShown === false &&
          openFacts !== null &&
          openFacts.open === true &&
          openFacts.summary === 'Drum map: Roland MT-32 Rhythm (34) hide notes' &&
          openFacts.notes === 34 &&
          openFacts.firstNote === '35 Acoustic Bass Drum' &&
          openFacts.lastNote === '75 Claves',
        JSON.stringify({ closedFacts, openFacts }),
      );

      // The fixture models: a General MIDI instrument, a bank-chosen drum part, and one map of 128 notes whose names
      // are at the schema's 40-character limit (200-character names cannot be loaded).
      fs.mkdirSync(path.join(dataDir, 'models'), { recursive: true });
      fs.writeFileSync(path.join(dataDir, 'models', 'gmdrums.json'), JSON.stringify(gmDrumsModel()));
      fs.writeFileSync(path.join(dataDir, 'models', 'bankdrums.json'), JSON.stringify(bankDrumsModel()));
      const longDrumName = (note) => (note % 2 === 0 ? `Long drum name ${note} `.repeat(3).slice(0, 39) + 'x' : String(note).padStart(3, '0') + 'W'.repeat(37));
      const longNames = Array.from({ length: 128 }, (_, note) => longDrumName(note));
      fs.writeFileSync(
        path.join(dataDir, 'models', 'drumlong.json'),
        JSON.stringify({
          ...gmDrumsModel(),
          id: 'drumlong',
          name: 'Long Name Drum Synth',
          drumMap: 'long-names',
          drumMaps: [{ id: 'long-names', name: 'Long Names', notes: longNames.map((name, note) => ({ note, name })) }],
        }),
      );
      const FOUR_PORTS = ['Fake Synth A', 'Fake Synth B', 'Fake Synth C', 'Fake Synth D'];
      /** Writes the rig, reads it again, reloads with the four fake ports, plays `code` and opens the Instruments view. */
      const showDrumCards = async (instruments, code, label) => {
        writeRig(instruments);
        await callTool(client, 'get_midi_instruments', {});
        await setScenario({ permission: 'granted', outputs: FOUR_PORTS });
        await callTool(client, 'set_code', { code, label });
        await openView(6);
        await drumCardsNow(`(card) => card.querySelector('.instrument-drum-summary, .instrument-drum-unknown') !== null && card.querySelector('.midi-dot').dataset.kind === 'filled'`);
      };
      /** The disclosure of the first card, read in the page, with the storage and the sends around it. */
      const toggleFacts = () =>
        evaluateExpr(
          cdp,
          `(() => {
            const flat = (text) => text.replace(/\\s+/g, ' ').trim();
            const body = document.getElementById('instruments-body');
            const details = document.querySelector('#instruments-list details.instrument-drum-map');
            const items = [...details.querySelectorAll('.instrument-drum-notes li')];
            const numbers = items.map((item) => Number(item.querySelector('.instrument-drum-number').textContent));
            return {
              open: details.open,
              summary: flat(details.querySelector('summary').innerText),
              count: items.length,
              ascending: numbers.every((number, index) => index === 0 || number > numbers[index - 1]),
              first: flat(items[0].textContent),
              scrollTop: body.scrollTop,
              storage: JSON.stringify(Object.keys(localStorage).sort().map((key) => [key, localStorage.getItem(key)])),
              sends: window.__probeSends,
            };
          })()`,
        );
      const GM_CODE = `drums: note("36 38").midi('Fake Synth B', { midichannel: 10 })`;

      // (a) A General MIDI card: Enter opens, Space closes, and the toggle stores nothing and sends nothing.
      await showDrumCards([{ id: 'gmdrums', model: 'gmdrums', port: 'Fake Synth B' }], GM_CODE, 'probe:midi drum card general midi');
      await evaluateExpr(
        cdp,
        `(() => {
          window.__probeSends = 0;
          const original = WebSocket.prototype.send;
          WebSocket.prototype.send = function (...args) { window.__probeSends += 1; return original.apply(this, args); };
        })()`,
      );
      await evaluateExpr(cdp, `document.querySelector('#instruments-list details.instrument-drum-map > summary').focus()`);
      const gmClosed = await toggleFacts();
      await pressKey(cdp, 'Enter');
      await drumCardsNow(`(card) => card.querySelector('details.instrument-drum-map').open === true`);
      const gmOpened = await toggleFacts();
      await pressKey(cdp, ' ');
      await drumCardsNow(`(card) => card.querySelector('details.instrument-drum-map').open === false`);
      const gmClosedAgain = await toggleFacts();
      report(
        'instruments view: the General MIDI card opens its Drum map with Enter and Space, lists 47 notes in order, and stores and sends nothing',
        gmClosed.open === false &&
          gmClosed.summary === 'Drum map: General MIDI (47) show notes' &&
          gmOpened.open === true &&
          gmOpened.summary === 'Drum map: General MIDI (47) hide notes' &&
          gmOpened.count === 47 &&
          gmOpened.ascending === true &&
          gmOpened.first === '35 Acoustic Bass Drum' &&
          gmClosedAgain.open === false &&
          gmClosedAgain.summary === 'Drum map: General MIDI (47) show notes' &&
          gmClosedAgain.scrollTop === gmClosed.scrollTop &&
          gmOpened.storage === gmClosed.storage &&
          gmClosedAgain.storage === gmClosed.storage &&
          gmClosedAgain.sends === 0,
        JSON.stringify({ gmClosed, gmOpened, gmClosedAgain }),
      );

      // (b) A kit with no known map: a plain line, no disclosure, weight 400, the word unknown muted.
      await showDrumCards(
        [{ id: 'drumbank', model: 'bankdrums', port: 'Fake Synth D' }],
        `kit: note("36 38").midi('Fake Synth D', { midichannel: 5, sound: 'Kit C' })`,
        'probe:midi drum card unknown map',
      );
      const unknownFacts = await evaluateExpr(
        cdp,
        `(() => {
          const card = document.querySelector('#instruments-list .instrument-card');
          const line = card.querySelector('.instrument-drum-unknown');
          const sub = card.querySelector('.instrument-drum-sub');
          const word = line.querySelector('.instrument-muted');
          const mutedColor = (() => { const s = document.createElement('span'); s.style.color = 'var(--text-muted)'; document.body.append(s); const c = getComputedStyle(s).color; s.remove(); return c; })();
          const kit = card.querySelector('.instrument-drum-kit');
          return {
            details: card.querySelectorAll('details').length,
            line: line.textContent,
            sub: sub.textContent,
            weight: getComputedStyle(line).fontWeight,
            wordMuted: word !== null && word.textContent === 'unknown' && getComputedStyle(word).color === mutedColor,
            kit: kit.textContent,
            kitTitle: kit.getAttribute('title'),
          };
        })()`,
      );
      report(
        'instruments view: an unknown map is a plain line with no disclosure',
        unknownFacts.details === 0 &&
          unknownFacts.line === 'Drum map: unknown' &&
          unknownFacts.sub === 'No note map is known for Kit C, so notes show as numbers.' &&
          unknownFacts.weight === '400' &&
          unknownFacts.wordMuted === true &&
          unknownFacts.kit === 'Kit C · ch 5' &&
          unknownFacts.kitTitle === 'Kit C: bank 86/65, program 3',
        JSON.stringify(unknownFacts),
      );

      // (c) A kit with its own map names it.
      await showDrumCards(
        [{ id: 'sc55', model: 'sc55', port: 'Fake Synth A' }],
        `drums: note("36 38").midi('Fake Synth A', { midichannel: 10, sound: 'Orchestra Set' })`,
        'probe:midi drum card kit map',
      );
      const orchestraFacts = await drumCardFacts();
      report(
        'instruments view: a kit with its own map names it',
        orchestraFacts.details === 1 &&
          orchestraFacts.summary === 'Drum map: Roland GS Orchestra (62) for Orchestra Set show notes' &&
          JSON.stringify(orchestraFacts.kitLines) === JSON.stringify(['Orchestra Set · ch 10']),
        JSON.stringify(orchestraFacts),
      );

      // (d) An open map stays open and keeps focus and scroll across a live port change.
      await showDrumCards([{ id: 'gmdrums', model: 'gmdrums', port: 'Fake Synth B' }], GM_CODE, 'probe:midi drum card live change');
      await cdp('Emulation.setDeviceMetricsOverride', { width: 1024, height: 360, deviceScaleFactor: 1, mobile: false });
      await sleep(300);
      let liveFacts;
      try {
        await evaluateExpr(cdp, `document.querySelector('#instruments-list details.instrument-drum-map > summary').focus()`);
        await pressKey(cdp, 'Enter');
        await drumCardsNow(`(card) => card.querySelector('details.instrument-drum-map').open === true`);
        const before = await evaluateExpr(
          cdp,
          `(() => { const body = document.getElementById('instruments-body'); body.scrollTop = 60; return { scrollTop: body.scrollTop, scrollable: body.scrollHeight > body.clientHeight }; })()`,
        );
        await evaluateExpr(cdp, `window.__unplug('Fake Synth B')`);
        await drumCardsNow(`(card) => card.querySelector('.midi-dot').dataset.kind === 'hollow'`);
        await evaluateExpr(cdp, `window.__plug('Fake Synth B')`);
        await drumCardsNow(`(card) => card.querySelector('.midi-dot').dataset.kind === 'filled'`);
        const after = await evaluateExpr(
          cdp,
          `(() => {
            const details = document.querySelector('#instruments-list details.instrument-drum-map');
            const active = document.activeElement;
            return {
              open: details.open,
              focusOnSummary: active !== null && active.tagName === 'SUMMARY' && active.parentElement.dataset.map === details.dataset.map,
              scrollTop: document.getElementById('instruments-body').scrollTop,
            };
          })()`,
        );
        liveFacts = { before, after };
      } finally {
        await cdp('Emulation.clearDeviceMetricsOverride');
      }
      report(
        'instruments view: an open Drum map stays open and keeps focus and scroll across a live port change',
        liveFacts.before.scrollable === true && liveFacts.before.scrollTop === 60 && liveFacts.after.open === true && liveFacts.after.focusOnSummary === true && liveFacts.after.scrollTop === liveFacts.before.scrollTop,
        JSON.stringify(liveFacts),
      );

      // (e) A 128-note map with 40-character names wraps inside its card at every size and layout.
      await showDrumCards(
        [{ id: 'drumlong', model: 'drumlong', port: 'Fake Synth C' }],
        `drums: note("36 38").midi('Fake Synth C', { midichannel: 10 })`,
        'probe:midi drum card long names',
      );
      await evaluateExpr(cdp, `document.querySelector('#instruments-list details.instrument-drum-map').open = true`);
      const startLayoutLong = await evaluateExpr(cdp, `document.getElementById('workspace').dataset.layout`);
      const longDrumResults = [];
      try {
        for (const [width, height] of [[1024, 768], [1366, 768], [1920, 1080]]) {
          await cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
          await sleep(250);
          for (const layout of ['a', 'b', 'c']) {
            await evaluateExpr(cdp, `(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); })()`);
            await pressKey(cdp, layout);
            await sleep(200);
            const seen = await evaluateExpr(
              cdp,
              `(() => {
                const card = document.querySelector('#instruments-list .instrument-card');
                const list = document.getElementById('instruments-list');
                const body = document.getElementById('instruments-body');
                const notes = card.querySelector('.instrument-drum-notes');
                const items = [...notes.querySelectorAll('li')];
                const needed = ${JSON.stringify(longNames)};
                return {
                  layout: document.getElementById('workspace').dataset.layout,
                  open: card.querySelector('details').open,
                  cardFits: card.scrollWidth <= card.clientWidth,
                  listFits: notes.scrollWidth <= notes.clientWidth && list.scrollWidth <= list.clientWidth && body.scrollWidth <= body.clientWidth,
                  ellipsis: [card, ...card.querySelectorAll('*')].filter((node) => getComputedStyle(node).textOverflow === 'ellipsis').length,
                  whole: items.length === 128 && items.every((item, index) => item.textContent.endsWith(needed[index])),
                  columns: new Set(items.map((item) => Math.round(item.getBoundingClientRect().left))).size,
                  grows: card.getBoundingClientRect().height > 0 && body.scrollHeight >= card.getBoundingClientRect().height,
                };
              })()`,
            );
            longDrumResults.push({ size: `${width}x${height}`, ...seen });
          }
        }
      } finally {
        await cdp('Emulation.clearDeviceMetricsOverride');
        if ((await evaluateExpr(cdp, `document.getElementById('workspace').dataset.layout`)) !== startLayoutLong) await pressKey(cdp, startLayoutLong);
      }
      const wide = longDrumResults[8];
      report(
        'instruments view: a 128-note map with 40-character names wraps inside its card at every size and layout',
        longDrumResults.length === 9 &&
          longDrumResults.every((seen, index) => seen.layout === ['a', 'b', 'c'][index % 3] && seen.open && seen.cardFits && seen.listFits && seen.ellipsis === 0 && seen.whole && seen.grows) &&
          wide.columns > 1,
        JSON.stringify(longDrumResults.map((seen) => `${seen.size}${seen.layout}:${seen.cardFits && seen.listFits ? 'fits' : 'OVERFLOW'},ellipsis${seen.ellipsis},whole${seen.whole},columns${seen.columns}`)),
      );

      // Backstop screenshots for a final look (the directory comes from MOONTIDE_PROBE_SHOTS; nothing is saved without it):
      // a card with its Drum map closed, open, and unknown, at two sizes in the three layouts.
      if (process.env.MOONTIDE_PROBE_SHOTS) {
        await showDrumCards(
          [
            { id: 'sc55', model: 'sc55', port: 'Fake Synth A' },
            { id: 'drumbank', model: 'bankdrums', port: 'Fake Synth D' },
          ],
          `drums: note("36 38 42 38").midi('Fake Synth A', { midichannel: 10, sound: 'Standard Set' })\nkit: note("36 38").midi('Fake Synth D', { midichannel: 5, sound: 'Kit C' })`,
          'probe:midi drum card shots',
        );
        fs.mkdirSync(process.env.MOONTIDE_PROBE_SHOTS, { recursive: true });
        const startLayoutCards = await evaluateExpr(cdp, `document.getElementById('workspace').dataset.layout`);
        const cardShots = [];
        try {
          for (const [width, height] of [[1366, 768], [1920, 1080]]) {
            await cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
            await sleep(250);
            for (const layout of ['a', 'b', 'c']) {
              await evaluateExpr(cdp, `(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); })()`);
              await pressKey(cdp, layout);
              await sleep(250);
              for (const state of ['closed', 'open', 'unknown']) {
                await evaluateExpr(
                  cdp,
                  `(() => {
                    const cards = [...document.querySelectorAll('#instruments-list .instrument-card')];
                    const details = cards[0].querySelector('details');
                    details.open = ${JSON.stringify(state === 'open')};
                    // Scroll so the Drum kit row, the Drum map line and the start of its list are at the top of the panel.
                    const rows = [...cards[${state === 'unknown' ? 1 : 0}].querySelectorAll('.instrument-row')];
                    rows.find((row) => row.querySelector('dt').firstChild.textContent === ${JSON.stringify(INSTRUMENTS_COPY.labelDrumKit)}).scrollIntoView({ block: 'start' });
                  })()`,
                );
                await sleep(150);
                const shot = await cdp('Page.captureScreenshot', { format: 'png' });
                const file = path.join(process.env.MOONTIDE_PROBE_SHOTS, `instruments-drum-${state}-${width}x${height}-layout-${layout}.png`);
                fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
                cardShots.push(path.basename(file));
              }
            }
          }
        } finally {
          await cdp('Emulation.clearDeviceMetricsOverride');
          if ((await evaluateExpr(cdp, `document.getElementById('workspace').dataset.layout`)) !== startLayoutCards) await pressKey(cdp, startLayoutCards);
        }
        console.log(`probe:midi instruments drum card screenshots: ${cardShots.join(', ')}`);
      }

      await pressKey(cdp, 'Escape');
      fs.rmSync(rigFile, { force: true });
      fs.rmSync(path.join(dataDir, 'models'), { recursive: true, force: true });
      await callTool(client, 'get_midi_instruments', {});
      await setScenario({ permission: 'granted' });
    }

    // --- Catalog ---
    // A catalog in the data folder makes its sounds choosable by name: the bank select and the program
    // go out before the first note, with the guard in between, and the search tool finds the sound.
    await setScenario({ permission: 'granted' });
    fs.mkdirSync(path.join(dataDir, 'catalogs'), { recursive: true });
    fs.writeFileSync(
      path.join(dataDir, 'catalogs', 'sc55.json'),
      JSON.stringify({
        model: 'sc55',
        source: 'probe fixture',
        sounds: [
          { name: 'Probe Tone A', category: 'Probe Group', program: 5, bank: { msb: 8 } },
          { name: 'Probe Tone B', category: 'Probe Group', program: 6, bank: { msb: 16 } },
        ],
      }),
    );
    fs.writeFileSync(rigFile, JSON.stringify({ instruments: [{ id: 'sc55', model: 'sc55', port: 'Fake Synth B' }] }));
    await callTool(client, 'set_code', { code: SILENT, label: 'probe:midi catalog rig' });
    await sleep(500);
    const catalogCode = (sound) => `sc55: note("c3*8").midi('Fake Synth B', { midichannel: 1, sound: '${sound}' })`;
    marker = (await midiLog()).length;
    await callTool(client, 'set_code', { code: catalogCode('Probe Tone A'), label: 'probe:midi catalog sound' });
    const sawCatalogNote = await waitFor(
      cdp,
      `(() => window.__midiLog.slice(${marker}).some((e) => e.port === 'Fake Synth B' && e.bytes.length === 3 && e.bytes[0] === 0x90 && e.bytes[2] > 0) ? true : null)()`,
      1500,
    );
    const catalogLog = (await midiLog()).slice(marker).filter((entry) => entry.port === 'Fake Synth B');
    const bankAt = catalogLog.findIndex((entry) => entry.bytes.length === 3 && entry.bytes[0] === 0xb0 && entry.bytes[1] === 0 && entry.bytes[2] === 8);
    const catalogProgramAt = catalogLog.findIndex((entry) => entry.bytes.length === 2 && entry.bytes[0] === 0xc0 && entry.bytes[1] === 5);
    const catalogNoteAt = catalogLog.findIndex((entry) => entry.bytes.length === 3 && entry.bytes[0] === 0x90 && entry.bytes[2] > 0);
    const catalogGapMs = catalogProgramAt === -1 || catalogNoteAt === -1 ? null : catalogLog[catalogNoteAt].t - catalogLog[catalogProgramAt].t;
    report(
      'a catalog sound chosen by name sends its bank and program before the first note',
      sawCatalogNote === true && bankAt !== -1 && catalogProgramAt !== -1 && catalogNoteAt !== -1 && bankAt < catalogProgramAt && catalogProgramAt < catalogNoteAt && catalogGapMs !== null && catalogGapMs >= SETUP_GUARD_MS,
      JSON.stringify({ bankIndex: bankAt, programChangeIndex: catalogProgramAt, firstNoteIndex: catalogNoteAt, msBetween: catalogGapMs, guardMs: SETUP_GUARD_MS }),
    );
    const searchReply = await callTool(client, 'search_midi_sounds', { instrument: 'sc55', query: 'tone probe' });
    report(
      'search_midi_sounds finds a catalog sound with its bank and program',
      searchReply.split('\n').includes('- "Probe Tone A": program 5, bank 8, category "Probe Group"'),
      JSON.stringify({ reply: searchReply.slice(0, 400) }),
    );

    const catalogRefusal = await refusedWith(catalogCode('Probe Tone Z'), 'probe:midi unknown catalog sound');
    const catalogCodeNow = await callTool(client, 'get_code', {});
    report(
      'an unknown catalog sound is refused with the search pointer and the previous music keeps playing',
      firstLine(catalogRefusal) === 'Evaluation failed: Unknown sound "Probe Tone Z" for sc55.' &&
        (catalogRefusal ?? '').split('\n').some((line) => line.startsWith('Closest: ') && line.includes('Probe Tone A')) &&
        (catalogRefusal ?? '').split('\n').includes('Search the catalog with search_midi_sounds, instrument "sc55".') &&
        catalogCodeNow.includes(catalogCode('Probe Tone A')),
      JSON.stringify({ errorStart: firstLine(catalogRefusal), codeUnchanged: catalogCodeNow.includes(catalogCode('Probe Tone A')) }),
    );

    // --- Drum kits by bank ---
    // The fixture model stands for an instrument whose drum part takes a bank. It is built from documents, not
    // heard on hardware: these checks prove the bytes the page sends, never what a real instrument does with them.
    // The shipped SC-55 and MT-32 must keep getting no bank select on their drum channel.
    await setScenario({ permission: 'granted', outputs: ['Fake Synth A', 'Fake Synth B', 'Fake Synth D'] });
    fs.mkdirSync(path.join(dataDir, 'models'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'models', 'bankdrums.json'), JSON.stringify(bankDrumsModel()));
    fs.writeFileSync(
      rigFile,
      JSON.stringify({
        instruments: [
          { id: 'mt32', model: 'mt32', port: 'Fake Synth A' },
          { id: 'sc55', model: 'sc55', port: 'Fake Synth B' },
          { id: 'drumbank', model: 'bankdrums', port: 'Fake Synth D' },
        ],
      }),
    );
    await callTool(client, 'set_code', { code: SILENT, label: 'probe:midi drum kits rig' });
    await callTool(client, 'get_midi_instruments', {});
    await sleep(1500);
    // The log has thousands of entries by now: read its length and the tail after a mark, never the whole of it.
    const drumLogLength = () => evaluateExpr(cdp, 'window.__midiLog.length');
    const drumLogSince = (mark) => evaluateExpr(cdp, `window.__midiLog.slice(${mark})`);
    const drumNoteOn = (portName, status) => (entry) => entry.port === portName && entry.bytes.length === 3 && entry.bytes[0] === status && entry.bytes[2] > 0;
    const waitForDrumNote = (mark, portName, status, ms) =>
      waitFor(
        cdp,
        `(() => window.__midiLog.slice(${mark}).some((e) => e.port === ${JSON.stringify(portName)} && e.bytes.length === 3 && e.bytes[0] === ${status} && e.bytes[2] > 0) ? true : null)()`,
        ms,
      );
    const isCc = (entry, status, controller) => entry.bytes.length === 3 && entry.bytes[0] === status && entry.bytes[1] === controller;
    const isProgram = (entry, status, program) => entry.bytes.length === 2 && entry.bytes[0] === status && (program === undefined || entry.bytes[1] === program);

    // (a) The shipped models: a drum kit is a program change alone, never a bank select on channel 10.
    const shippedDrums = (kit) =>
      `sc55: note("36*4").midi('Fake Synth B', { midichannel: 10, sound: '${kit}' })\nmt32: note("36*4").midi('Fake Synth A', { midichannel: 10 })`;
    const shippedMark = await drumLogLength();
    await callTool(client, 'set_code', { code: shippedDrums('Standard Set'), label: 'probe:midi drum kits shipped standard' });
    await waitForDrumNote(shippedMark, 'Fake Synth B', 0x99, 1500);
    await callTool(client, 'set_code', { code: shippedDrums('Room Set'), label: 'probe:midi drum kits shipped room' });
    await sleep(1200);
    const shippedLog = await drumLogSince(shippedMark);
    const shippedB = shippedLog.filter((entry) => entry.port === 'Fake Synth B');
    const standardAt = shippedB.findIndex((entry) => isProgram(entry, 0xc9, 0));
    const roomAt = shippedB.findIndex((entry) => isProgram(entry, 0xc9, 8));
    const firstDrumNoteAt = shippedB.findIndex(drumNoteOn('Fake Synth B', 0x99));
    const noteAfterRoom = roomAt !== -1 && shippedB.some((entry, index) => index > roomAt && drumNoteOn('Fake Synth B', 0x99)(entry));
    const drumPrograms = shippedB.filter((entry) => isProgram(entry, 0xc9)).length;
    const drumBankSelects = shippedLog.filter((entry) => (entry.port === 'Fake Synth A' || entry.port === 'Fake Synth B') && (isCc(entry, 0xb9, 0) || isCc(entry, 0xb9, 32))).length;
    const mt32Programs = shippedLog.filter((entry) => entry.port === 'Fake Synth A' && isProgram(entry, 0xc9)).length;
    report(
      'drum kits: the SC-55 and the MT-32 get no bank select on channel 10',
      standardAt !== -1 && roomAt > standardAt && drumPrograms === 2 && firstDrumNoteAt > standardAt && noteAfterRoom && drumBankSelects === 0 && mt32Programs === 0,
      JSON.stringify({ standardProgramIndex: standardAt, roomProgramIndex: roomAt, firstNoteIndex: firstDrumNoteAt, programChangesOnSc55: drumPrograms, bankSelectsOnChannel10: drumBankSelects, programChangesOnMt32: mt32Programs }),
    );

    // (b) The opted-in fixture: bank MSB, bank LSB, program change, then the first note after the guard.
    const kitCode = (kit, notes = 4) => `kit: note("36*${notes}").midi('Fake Synth D', { midichannel: 5, sound: '${kit}' })`;
    const kitMark = await drumLogLength();
    await callTool(client, 'set_code', { code: kitCode('Kit A'), label: 'probe:midi drum kits kit a' });
    await waitForDrumNote(kitMark, 'Fake Synth D', 0x94, 1500);
    const kitLog = (await drumLogSince(kitMark)).filter((entry) => entry.port === 'Fake Synth D');
    const kitMsbAt = kitLog.findIndex((entry) => isCc(entry, 0xb4, 0) && entry.bytes[2] === 86);
    const kitLsbAt = kitLog.findIndex((entry) => isCc(entry, 0xb4, 32) && entry.bytes[2] === 64);
    const kitProgramAt = kitLog.findIndex((entry) => isProgram(entry, 0xc4, 0));
    const kitNoteAt = kitLog.findIndex(drumNoteOn('Fake Synth D', 0x94));
    const kitGapMs = kitProgramAt === -1 || kitNoteAt === -1 ? null : soundsAt(kitLog[kitNoteAt]) - soundsAt(kitLog[kitProgramAt]);
    report(
      'drum kits: an opted-in model (fixture, not heard on hardware) sends the kit bank and program before the first note',
      kitMsbAt !== -1 && kitMsbAt < kitLsbAt && kitLsbAt < kitProgramAt && kitProgramAt < kitNoteAt && kitGapMs !== null && kitGapMs >= SETUP_GUARD_MS,
      JSON.stringify({ msbIndex: kitMsbAt, lsbIndex: kitLsbAt, programChangeIndex: kitProgramAt, firstNoteIndex: kitNoteAt, msBetween: kitGapMs, guardMs: SETUP_GUARD_MS }),
    );

    // (c) A second kit with the same program: only its new bank and the program change, once; the same kit again sends nothing.
    const secondMark = await drumLogLength();
    await callTool(client, 'set_code', { code: kitCode('Kit B'), label: 'probe:midi drum kits kit b' });
    await sleep(1200);
    const secondLog = (await drumLogSince(secondMark)).filter((entry) => entry.port === 'Fake Synth D');
    const secondBanks = secondLog.filter((entry) => isCc(entry, 0xb4, 0) || isCc(entry, 0xb4, 32));
    const secondPrograms = secondLog.filter((entry) => isProgram(entry, 0xc4));
    const againMark = await drumLogLength();
    await callTool(client, 'set_code', { code: kitCode('Kit B', 8), label: 'probe:midi drum kits kit b again' });
    await sleep(1000);
    const againLog = (await drumLogSince(againMark)).filter((entry) => entry.port === 'Fake Synth D');
    const againSetup = againLog.filter((entry) => isCc(entry, 0xb4, 0) || isCc(entry, 0xb4, 32) || isProgram(entry, 0xc4)).length;
    report(
      'drum kits: a second kit with the same program sends only its new bank and program, once (fixture, not heard on hardware)',
      secondBanks.length === 2 && secondBanks[0].bytes[2] === 86 && secondBanks[1].bytes[1] === 32 && secondBanks[1].bytes[2] === 65 && secondPrograms.length === 1 && secondPrograms[0].bytes[1] === 0 && againSetup === 0,
      JSON.stringify({ bankMessages: secondBanks.length, lsb: secondBanks[1]?.bytes[2] ?? null, programChanges: secondPrograms.length, setupMessagesWhenSameKitAgain: againSetup }),
    );

    // (d) An unplugged and replugged opted-in instrument gets its kit again, after the reset wait and again after the repeat.
    const plugMark = await drumLogLength();
    await evaluateExpr(cdp, `window.__unplug('Fake Synth D')`);
    await evaluateExpr(cdp, `window.__plug('Fake Synth D')`);
    await sleep(RESET_SETTLE_MS + RECONNECT_REPEAT_MS + 1500);
    const plugLog = (await drumLogSince(plugMark)).filter((entry) => entry.port === 'Fake Synth D' && (isCc(entry, 0xb4, 0) || isCc(entry, 0xb4, 32) || isProgram(entry, 0xc4)));
    let kitSetups = 0;
    for (let index = 0; index + 2 < plugLog.length; index++) {
      if (isCc(plugLog[index], 0xb4, 0) && plugLog[index].bytes[2] === 86 && isCc(plugLog[index + 1], 0xb4, 32) && plugLog[index + 1].bytes[2] === 65 && isProgram(plugLog[index + 2], 0xc4, 0)) kitSetups++;
    }
    report(
      'drum kits: an unplugged and replugged opted-in instrument gets its kit again (fixture, not heard on hardware)',
      kitSetups >= 2,
      JSON.stringify({ kitSetupsAfterReplug: kitSetups, kitMessages: plugLog.length }),
    );

    // Back to the defaults, like the indicator-with-instruments and longest-names blocks: no models, no rig file, silent code, default scenario.
    fs.rmSync(path.join(dataDir, 'models'), { recursive: true, force: true });
    fs.rmSync(rigFile, { force: true });
    await callTool(client, 'set_code', { code: SILENT, label: 'probe:midi drum kits done' });
    await setScenario({ permission: 'granted' });

    // --- Instruments switched off, as Claude sees them ---
    // The user's choice is a file of the server (instruments-state.json) in the data folder; writing it here stands for the
    // page switch added later. Claude reads it in get_midi_instruments, code newly aimed at an instrument that is off
    // is refused by the page, and music that already names it keeps its place and plays nothing on it.
    await setScenario({ permission: 'granted', outputs: ['Fake Synth A', 'Fake Synth B'] });
    const stateFile = path.join(dataDir, 'instruments-state.json');
    fs.writeFileSync(
      rigFile,
      JSON.stringify({
        instruments: [
          { id: 'mt32', model: 'mt32', port: 'Fake Synth A' },
          { id: 'sc55', model: 'sc55', port: 'Fake Synth B' },
        ],
      }),
    );
    fs.writeFileSync(stateFile, JSON.stringify({ off: ['sc55'] }));
    const offLogLength = () => evaluateExpr(cdp, 'window.__midiLog.length');
    const offLogSince = (mark) => evaluateExpr(cdp, `window.__midiLog.slice(${mark})`);
    const isOnPort = (portName) => (entry) => entry.port === portName;
    const leadOnly = `lead: note("c3*4").midi('Fake Synth A', { midichannel: 2 })`;
    const bassLine = `bass: note("c2*4").midi('Fake Synth B', { midichannel: 2 })`;
    const bothTracks = (pattern) => `lead: note("${pattern}").midi('Fake Synth A', { midichannel: 2 })\n${bassLine}`;

    // (a) Claude reads which instruments are off, in the summary and once as a notice.
    const offReply = await callTool(client, 'get_midi_instruments', {});
    const offReplyLines = offReply.split('\n');
    const offNoticeLines = offReplyLines.filter((line) => line.startsWith('MIDI: the user'));
    report(
      'switched off: Claude reads which instruments are off',
      offReply.includes('Switched off by the user: sc55.') &&
        offNoticeLines.length === 1 &&
        offNoticeLines[0].includes('"sc55"') &&
        !offReply.includes('instruments-state'),
      JSON.stringify({ summaryLine: offReply.includes('Switched off by the user: sc55.'), noticeLines: offNoticeLines.length, namesSc55: (offNoticeLines[0] ?? '').includes('"sc55"') }),
    );
    await sleep(1000);

    // (b) Code newly aimed at the instrument that is off is refused with the reason, and the music keeps playing.
    const playMark = await offLogLength();
    await callTool(client, 'set_code', { code: leadOnly, label: 'probe:midi switched off lead only' });
    await waitFor(
      cdp,
      `(() => window.__midiLog.slice(${playMark}).some((e) => e.port === 'Fake Synth A' && e.bytes.length === 3 && e.bytes[0] >= 0x90 && e.bytes[0] <= 0x9f && e.bytes[2] > 0) ? true : null)()`,
      3000,
    );
    const refusedMark = await offLogLength();
    const offRefusal = await refusedWith(`${leadOnly}\n${bassLine}`, 'probe:midi switched off newly aimed');
    await sleep(1200);
    const refusedLog = await offLogSince(refusedMark);
    const aAfterRefusal = noteOns(refusedLog, 'Fake Synth A').length;
    const bAfterRefusal = refusedLog.filter(isOnPort('Fake Synth B')).length;
    report(
      'switched off: code newly aimed at sc55 is refused and the music keeps playing',
      offRefusal !== null &&
        offRefusal.includes('is switched off by the user') &&
        offRefusal.includes('The previous music keeps playing.') &&
        aAfterRefusal > 0 &&
        bAfterRefusal === 0,
      JSON.stringify({ refused: offRefusal !== null, hasReason: (offRefusal ?? '').includes('is switched off by the user'), hasClosing: (offRefusal ?? '').includes('The previous music keeps playing.'), noteOnsOnMt32After: aAfterRefusal, messagesOnSc55After: bAfterRefusal }),
    );

    // (c) Code that already names sc55 keeps its place when the user switches it off: silent on sc55, playing on mt32, and an edit passes.
    fs.rmSync(stateFile, { force: true });
    await callTool(client, 'get_midi_instruments', {});
    await callTool(client, 'set_code', { code: bothTracks('c3*4'), label: 'probe:midi switched off both tracks' });
    const bothArrived = await waitFor(
      cdp,
      `(() => { const log = window.__midiLog; const on = (name) => log.slice(${refusedMark}).some((e) => e.port === name && e.bytes.length === 3 && e.bytes[0] >= 0x90 && e.bytes[0] <= 0x9f && e.bytes[2] > 0); return on('Fake Synth A') && on('Fake Synth B') ? true : null; })()`,
      RESET_SETTLE_MS + RECONNECT_REPEAT_MS + 5000,
    );
    fs.writeFileSync(stateFile, JSON.stringify({ off: ['sc55'] }));
    const switchMark = await offLogLength();
    await callTool(client, 'get_midi_instruments', {});
    await sleep(SILENCE_REPEAT_MS + 100);
    const afterSwitchMark = await offLogLength();
    await sleep(1500);
    const switchLog = await offLogSince(switchMark);
    const silenceOnB = switchLog.filter(isOnPort('Fake Synth B'));
    const releases = silenceOnB.filter((entry) => entry.bytes.length === 3 && (entry.bytes[0] & 0xf0) === 0xb0 && entry.bytes[1] === 64 && entry.bytes[2] === 0);
    const allNotesOff = silenceOnB.filter((entry) => entry.bytes.length === 3 && (entry.bytes[0] & 0xf0) === 0xb0 && entry.bytes[1] === 123);
    const perChannel = (entries) => {
      const counts = new Map();
      for (const entry of entries) counts.set(entry.bytes[0] & 0x0f, (counts.get(entry.bytes[0] & 0x0f) ?? 0) + 1);
      return counts;
    };
    const releaseCounts = perChannel(releases);
    const offCounts = perChannel(allNotesOff);
    const silencedTwice = releaseCounts.size > 0 && releaseCounts.size === offCounts.size && [...releaseCounts.values(), ...offCounts.values()].every((count) => count === 2);
    const lateLog = await offLogSince(afterSwitchMark);
    const bLateNotes = noteOns(lateLog, 'Fake Synth B').length;
    const aLateNotes = noteOns(lateLog, 'Fake Synth A').length;
    const editReply = await refusedWith(bothTracks('e3*4'), 'probe:midi switched off edit');
    report(
      'switched off: code that already names sc55 keeps its place and sc55 stays silent',
      bothArrived === true && silencedTwice && bLateNotes === 0 && aLateNotes > 0 && editReply === null,
      JSON.stringify({
        bothPlayedBefore: bothArrived === true,
        channelsSilenced: releaseCounts.size,
        silencedTwiceEachChannel: silencedTwice,
        noteOnsOnSc55After400Ms: bLateNotes,
        noteOnsOnMt32After400Ms: aLateNotes,
        editRefused: editReply !== null,
      }),
    );

    // (d) A reload keeps the code that names sc55: the replay passes because the code was playing, nothing is cleared.
    const reloadCode = bothTracks('e3*4');
    await reloadPage(cdp);
    const reloaded = await codeWhen((code) => code.includes(reloadCode), 5000);
    const reloadEditor = await waitFor(cdp, `document.getElementById('repl').editor.code === ${JSON.stringify(reloadCode)} ? true : null`, 5000);
    report(
      'switched off: a reload keeps the code that names sc55',
      reloaded.includes(reloadCode) && reloadEditor === true && !/could not/i.test(reloaded),
      JSON.stringify({ serverKeepsTheCode: reloaded.includes(reloadCode), editorShowsTheCode: reloadEditor === true }),
    );

    // Back to the defaults: no state file, no rig file, silent code, default scenario.
    fs.rmSync(stateFile, { force: true });
    fs.rmSync(rigFile, { force: true });
    await callTool(client, 'set_code', { code: SILENT, label: 'probe:midi switched off done' });
    await setScenario({ permission: 'granted' });

    // --- Instruments switch on the card ---
    // The user's switch: a click on a card sends one instrument-switch, the server writes instruments-state.json, pushes the
    // rig and answers; the instrument goes silent like an unplug and, switched on again, gets its reset and its setup twice.
    // Fake Synth A is the MT-32 and stays untouched; Fake Synth B is the SC-55 that is switched off and on.
    {
      await setScenario({ permission: 'granted', outputs: ['Fake Synth A', 'Fake Synth B'] });
      const switchStateFile = path.join(dataDir, 'instruments-state.json');
      fs.rmSync(switchStateFile, { force: true });
      fs.writeFileSync(
        rigFile,
        JSON.stringify({
          instruments: [
            { id: 'mt32', model: 'mt32', port: 'Fake Synth A' },
            { id: 'sc55', model: 'sc55', port: 'Fake Synth B' },
          ],
        }),
      );
      await setScenario({ permission: 'granted', outputs: ['Fake Synth A', 'Fake Synth B'] });
      const switchCode = `lead: note("c3*4").midi('Fake Synth A', { midichannel: 2 })\nbass: note("c2*4").midi('Fake Synth B', { midichannel: 2 })`;
      await callTool(client, 'set_code', { code: switchCode, label: 'probe:midi switch both tracks' });
      const isNoteOn = (entry) => entry.bytes.length === 3 && entry.bytes[0] >= 0x90 && entry.bytes[0] <= 0x9f && entry.bytes[2] > 0;
      const bothPlaying = await waitFor(
        cdp,
        `(() => { const on = (name) => window.__midiLog.some((e) => e.port === name && e.bytes.length === 3 && e.bytes[0] >= 0x90 && e.bytes[0] <= 0x9f && e.bytes[2] > 0); return on('Fake Synth A') && on('Fake Synth B') ? true : null; })()`,
        RESET_SETTLE_MS + RECONNECT_REPEAT_MS + 5000,
      );
      await openView(6);
      const switchSelector = (id) => `.instrument-card[data-instrument="${id}"] .instrument-switch`;
      const switchRead = (id) =>
        evaluateExpr(
          cdp,
          `(() => {
            const card = document.querySelector('.instrument-card[data-instrument=${JSON.stringify(id)}]');
            const button = card === null ? null : card.querySelector('.instrument-switch');
            return button === null ? null : {
              checked: button.getAttribute('aria-checked'),
              busy: button.getAttribute('aria-busy'),
              enabled: card.dataset.enabled,
              word: button.querySelector('.instrument-switch-word').textContent,
            };
          })()`,
        );
      const cardsThere = await waitFor(cdp, `document.querySelectorAll('.instrument-card .instrument-switch').length === 2 ? true : null`, 5000);

      // (a) A click on the switch of sc55 turns it off: the card says Off, the file holds it, sc55 is silenced and stays silent.
      const offMark = await evaluateExpr(cdp, 'window.__midiLog.length');
      const offClickAt = await evaluateExpr(cdp, 'performance.now()');
      await clickElement(cdp, switchSelector('sc55'));
      const cardOff = await waitFor(
        cdp,
        `(() => { const b = document.querySelector(${JSON.stringify(switchSelector('sc55'))}); return b !== null && b.getAttribute('aria-checked') === 'false' && b.getAttribute('aria-busy') === null ? true : null; })()`,
        5000,
      );
      const offRead = await switchRead('sc55');
      await sleep(SILENCE_REPEAT_MS + 400 + 1500);
      const offLog = (await midiLog()).slice(offMark);
      const offFile = fs.existsSync(switchStateFile) ? JSON.parse(fs.readFileSync(switchStateFile, 'utf8')) : null;
      const onB = offLog.filter((entry) => entry.port === 'Fake Synth B');
      const sustainReleases = onB.filter((entry) => entry.bytes.length === 3 && (entry.bytes[0] & 0xf0) === 0xb0 && entry.bytes[1] === 64 && entry.bytes[2] === 0);
      const notesOff = onB.filter((entry) => entry.bytes.length === 3 && (entry.bytes[0] & 0xf0) === 0xb0 && entry.bytes[1] === 123);
      const bNotesLater = noteOns(onB.filter((entry) => entry.t >= offClickAt + 400), 'Fake Synth B').length;
      const aNotesLater = noteOns(offLog.filter((entry) => entry.t >= offClickAt + 400), 'Fake Synth A').length;
      report(
        'instruments switch: a click turns sc55 off: Off card, state file, silence, no more notes',
        bothPlaying === true &&
          cardsThere === true &&
          cardOff === true &&
          offRead.checked === 'false' &&
          offRead.enabled === 'false' &&
          offRead.word === INSTRUMENTS_COPY.switchOff &&
          JSON.stringify(offFile) === JSON.stringify({ off: ['sc55'] }) &&
          sustainReleases.length > 0 &&
          notesOff.length > 0 &&
          bNotesLater === 0 &&
          aNotesLater > 0,
        JSON.stringify({ bothPlayedBefore: bothPlaying === true, cardsThere: cardsThere === true, offRead, offFile, sustainReleases: sustainReleases.length, allNotesOff: notesOff.length, noteOnsOnSc55After400Ms: bNotesLater, noteOnsOnMt32After400Ms: aNotesLater }),
      );

      // (b) A second click turns it on: one reset after the settle delay, the setup twice, then notes again.
      const onMark = await evaluateExpr(cdp, 'window.__midiLog.length');
      await clickElement(cdp, switchSelector('sc55'));
      const cardOn = await waitFor(
        cdp,
        `(() => { const b = document.querySelector(${JSON.stringify(switchSelector('sc55'))}); return b !== null && b.getAttribute('aria-checked') === 'true' && b.getAttribute('aria-busy') === null ? true : null; })()`,
        5000,
      );
      const onRead = await switchRead('sc55');
      await sleep(RESET_SETTLE_MS + RECONNECT_REPEAT_MS + 2500);
      const onLog = portEntries((await midiLog()).slice(onMark), 'Fake Synth B');
      const onResetAt = onLog.findIndex((entry) => same(entry.bytes, GS_RESET));
      const afterOnReset = onResetAt === -1 ? [] : onLog.slice(onResetAt + 1);
      const onSetup = afterOnReset.filter((entry) => !isNoteMessage(entry)).map((entry) => entry.bytes);
      const sc55Setup = volumesOn(range(1, 16));
      const notesAfterOn = noteOns(afterOnReset, 'Fake Synth B').length;
      const onFile = fs.existsSync(switchStateFile) ? JSON.parse(fs.readFileSync(switchStateFile, 'utf8')) : null;
      report(
        'instruments switch: a second click turns sc55 on: reset, setup twice, notes again',
        cardOn === true &&
          onRead.checked === 'true' &&
          onRead.enabled === 'true' &&
          onRead.word === INSTRUMENTS_COPY.switchOn &&
          onLog.filter(isSysex).length === 1 &&
          same(onSetup, [...sc55Setup, ...sc55Setup]) &&
          notesAfterOn > 0 &&
          JSON.stringify(onFile) === JSON.stringify({ off: [] }),
        JSON.stringify({ cardOn: cardOn === true, onRead, resets: onLog.filter(isSysex).length, setupMessages: onSetup.length, expectedSetupMessages: sc55Setup.length * 2, noteOnsAfterSetup: notesAfterOn, onFile }),
      );

      // (c) A state file that cannot be written refuses the switch: the card keeps its confirmed state and says why.
      // A directory where the temporary file belongs makes the write fail on every OS.
      const blocker = path.join(dataDir, 'instruments-state.json.tmp');
      fs.mkdirSync(blocker);
      const errorRead = () =>
        evaluateExpr(
          cdp,
          `(() => {
            const card = document.querySelector('.instrument-card[data-instrument="sc55"]');
            const line = card.querySelector('p.instrument-error');
            const button = card.querySelector('.instrument-switch');
            return {
              text: line === null ? null : line.textContent,
              role: line === null ? null : line.getAttribute('role'),
              weight: line === null ? null : getComputedStyle(line).fontWeight,
              checked: button.getAttribute('aria-checked'),
              busy: button.getAttribute('aria-busy'),
              focused: document.activeElement === button,
              headFollowedByLine: line !== null && card.children[0].classList.contains('instrument-head') && card.children[1] === line,
            };
          })()`,
        );
      await clickElement(cdp, switchSelector('sc55'));
      const refusalShown = await waitFor(cdp, `document.querySelector('.instrument-card[data-instrument="sc55"] p.instrument-error') !== null ? true : null`, 5000);
      const refusal = await errorRead();
      fs.rmSync(blocker, { recursive: true, force: true });
      report(
        'instruments switch: a state file that cannot be written refuses the switch with the reason',
        refusalShown === true &&
          refusal.text.startsWith('Could not switch sc55 off: the choice could not be saved (') &&
          refusal.role === 'alert' &&
          refusal.weight === '600' &&
          refusal.checked === 'true' &&
          refusal.busy === null &&
          refusal.focused === true &&
          refusal.headFollowedByLine === true,
        JSON.stringify(refusal),
      );

      // The next press clears the line (and, with the folder writable again, switches sc55 on again at the end of this block).
      // (d) No answer within TAKE_BACK_CONFIRM_MS: the page says Moontide did not confirm and the switch returns to its confirmed state.
      const dropSwitchFrames = (alsoClose) =>
        evaluateExpr(
          cdp,
          `(() => {
            window.__switchFramesDropped = 0;
            if (!window.__originalSend) window.__originalSend = WebSocket.prototype.send;
            WebSocket.prototype.send = function (data) {
              let type = null;
              try { type = JSON.parse(data).type; } catch (err) { type = null; }
              if (type === 'instrument-switch') {
                window.__switchFramesDropped += 1;
                if (${alsoClose ? 'true' : 'false'}) this.close();
                return;
              }
              return window.__originalSend.call(this, data);
            };
          })()`,
        );
      const restoreSend = () => evaluateExpr(cdp, `(() => { if (window.__originalSend) WebSocket.prototype.send = window.__originalSend; })()`);
      await dropSwitchFrames(false);
      await clickElement(cdp, switchSelector('sc55'));
      const pendingShown = await waitFor(cdp, `document.querySelector(${JSON.stringify(switchSelector('sc55'))}).getAttribute('aria-busy') === 'true' ? true : null`, 2000);
      const pendingRead = await switchRead('sc55');
      const noErrorWhilePending = await evaluateExpr(cdp, `document.querySelector('.instrument-card[data-instrument="sc55"] p.instrument-error') === null`);
      await sleep(5500);
      const timedOut = await errorRead();
      const dropped = await evaluateExpr(cdp, 'window.__switchFramesDropped');
      await restoreSend();
      report(
        'instruments switch: no answer within 5 s says Moontide did not confirm',
        pendingShown === true &&
          pendingRead.word === INSTRUMENTS_COPY.switchTurningOff &&
          noErrorWhilePending === true &&
          dropped === 1 &&
          timedOut.text === MIDI_COPY.takeBackFailed &&
          timedOut.checked === 'true' &&
          timedOut.busy === null &&
          timedOut.focused === true,
        JSON.stringify({ pendingRead, noErrorWhilePending, dropped, timedOut }),
      );

      // (e) A socket that closes during a request: the cards are replaced by the Disconnected message in the same frame,
      // and no switch is left in the page. There is no auto-reconnect, so the page is reloaded afterwards.
      await dropSwitchFrames(true);
      await clickElement(cdp, switchSelector('sc55'));
      const closedShown = await waitFor(
        cdp,
        `(() => {
          const message = document.getElementById('instruments-message');
          if (message.hidden) return null;
          return { lead: document.getElementById('instruments-message-text').textContent, switches: document.querySelectorAll('.instrument-switch').length, bodyHidden: document.getElementById('instruments-body').hidden };
        })()`,
        5000,
      );
      await restoreSend();
      report(
        'instruments switch: a closed socket during a request replaces the cards at once',
        closedShown !== null && closedShown.lead === INSTRUMENTS_COPY.disconnected && closedShown.switches === 0 && closedShown.bodyHidden === true,
        JSON.stringify(closedShown),
      );
      await reloadPage(cdp);

      // (f) In the page: the choice is shown after a reload. The server reads the same data folder.
      await waitConnected(cdp, 15000);
      await openView(6);
      await waitFor(cdp, `document.querySelectorAll('.instrument-card .instrument-switch').length === 2 ? true : null`, 5000);
      await clickElement(cdp, switchSelector('sc55'));
      const offAgain = await waitFor(
        cdp,
        `(() => { const b = document.querySelector(${JSON.stringify(switchSelector('sc55'))}); return b !== null && b.getAttribute('aria-checked') === 'false' && b.getAttribute('aria-busy') === null ? true : null; })()`,
        5000,
      );
      await reloadPage(cdp);
      await waitConnected(cdp, 15000);
      await openView(6);
      const reloadedCard = await waitFor(
        cdp,
        `(() => {
          const card = document.querySelector('.instrument-card[data-instrument="sc55"]');
          if (card === null || card.dataset.enabled !== 'false') return null;
          return { word: card.querySelector('.instrument-switch-word').textContent, checked: card.querySelector('.instrument-switch').getAttribute('aria-checked'), words: card.querySelector('.instrument-state').textContent, dot: card.querySelector('.midi-dot').dataset.kind, dotTitle: card.querySelector('.midi-dot').getAttribute('title') };
        })()`,
        5000,
      );
      report(
        'instruments switch: a reload shows the choice',
        offAgain === true &&
          reloadedCard !== null &&
          reloadedCard.word === INSTRUMENTS_COPY.switchOff &&
          reloadedCard.checked === 'false' &&
          reloadedCard.words === MIDI_COPY.rowSwitchedOff &&
          reloadedCard.dot === 'off' &&
          reloadedCard.dotTitle === fill(MIDI_COPY.dotSwitchedOff, { port: 'sc55' }),
        JSON.stringify(reloadedCard),
      );

      await pressKey(cdp, 'Escape');
      fs.rmSync(switchStateFile, { force: true });
      fs.rmSync(rigFile, { force: true });
      await callTool(client, 'set_code', { code: SILENT, label: 'probe:midi switch done' });
      await setScenario({ permission: 'granted' });
    }

    // --- Top bar with instruments off ---
    // The top-bar indicator counts the instruments on and off and draws a grey crossed dot for each one switched off, without
    // being an attention state. mt32 plays; sc55 is in the rig and switched off; switching it back on restores today's reading.
    {
      await setScenario({ permission: 'granted', outputs: ['Fake Synth A', 'Fake Synth B'] });
      const offBarStateFile = path.join(dataDir, 'instruments-state.json');
      fs.rmSync(offBarStateFile, { force: true });
      fs.writeFileSync(
        rigFile,
        JSON.stringify({
          instruments: [
            { id: 'mt32', model: 'mt32', port: 'Fake Synth A' },
            { id: 'sc55', model: 'sc55', port: 'Fake Synth B' },
          ],
        }),
      );
      await setScenario({ permission: 'granted', outputs: ['Fake Synth A', 'Fake Synth B'] });
      await callTool(client, 'set_code', { code: `mt32: note("c3*4").midi('Fake Synth A', { midichannel: 2 })`, label: 'probe:midi top bar off, mt32 only' });
      const barRead = () =>
        inDrawer(() =>
          evaluateExpr(
            cdp,
            `(() => {
              const box = document.getElementById('midi-state');
              const text = document.getElementById('midi-state-text');
              return {
                visible: !box.hidden && box.getBoundingClientRect().width > 0,
                text: text.textContent,
                title: box.getAttribute('title'),
                attention: box.dataset.attention === 'true',
                dots: Array.from(document.querySelectorAll('#midi-dots .midi-dot')).map((dot) => ({ kind: dot.dataset.kind, title: dot.title })),
              };
            })()`,
          ),
        );
      await waitIndicatorText('MIDI: mt32 connected', 5000);
      fs.writeFileSync(offBarStateFile, JSON.stringify({ off: ['sc55'] }));
      await callTool(client, 'get_midi_instruments', {});
      const barOffShown = await waitIndicatorText('MIDI: 1 instrument on, 1 off', 5000);
      const barOff = await barRead();
      report(
        'top bar off: one instrument on, one off, a crossed dot, no attention',
        barOffShown === true &&
          barOff.visible === true &&
          barOff.attention === false &&
          barOff.dots.map((dot) => `${dot.kind}:${dot.title}`).join('|') === 'filled:mt32: connected|off:sc55: switched off',
        JSON.stringify(barOff),
      );

      fs.rmSync(offBarStateFile, { force: true });
      await callTool(client, 'get_midi_instruments', {});
      const barOnShown = await waitIndicatorText('MIDI: mt32 connected', 5000);
      const barOn = await barRead();
      report(
        'top bar off: switched back on, the bar is as before',
        barOnShown === true && barOn.attention === false && barOn.dots.length === 1 && barOn.dots[0].kind === 'filled',
        JSON.stringify(barOn),
      );

      fs.rmSync(rigFile, { force: true });
      await callTool(client, 'set_code', { code: SILENT, label: 'probe:midi top bar off done' });
      await setScenario({ permission: 'granted' });
    }

    // --- Settings editor on the card ---
    // The user's edit: Edit settings on a card opens a form with the detected ports and the model's channels; Save sends one
    // instrument-settings with the full chosen set, the server validates and rewrites instruments.json (with a .bak of the
    // previous text) and answers, and the card shows the new channels. mt32 is on Fake Synth A, sc55 on Fake Synth B.
    {
      await setScenario({ permission: 'granted', outputs: ['Fake Synth A', 'Fake Synth B'] });
      const editStateFile = path.join(dataDir, 'instruments-state.json');
      const bakFile = `${rigFile}.bak`;
      fs.rmSync(editStateFile, { force: true });
      fs.rmSync(bakFile, { force: true });
      const originalRigText = JSON.stringify({
        instruments: [
          { id: 'mt32', model: 'mt32', port: 'Fake Synth A' },
          { id: 'sc55', model: 'sc55', port: 'Fake Synth B' },
        ],
      });
      fs.writeFileSync(rigFile, originalRigText);
      await setScenario({ permission: 'granted', outputs: ['Fake Synth A', 'Fake Synth B'] });
      // The card of sc55 holds the editor's controls; selectors never build from user text (the ids are fixed here).
      const cardSel = '.instrument-card[data-instrument="sc55"]';
      const editSel = `${cardSel} .instrument-edit`;
      const formSel = `${cardSel} form.instrument-editor`;
      await openView(6);
      await waitFor(cdp, `document.querySelectorAll('.instrument-card .instrument-edit').length === 2 ? true : null`, 5000);
      const readEditor = () =>
        evaluateExpr(
          cdp,
          `(() => {
            const form = document.querySelector(${JSON.stringify(formSel)});
            if (form === null) return null;
            const select = form.querySelector('select');
            const chips = Array.from(form.querySelectorAll('.instrument-channel'));
            const errors = form.querySelector('.instrument-errors');
            return {
              focusedSelect: document.activeElement === select,
              options: Array.from(select.options).map((option) => option.textContent),
              selected: select.value,
              chips: chips.map((chip) => chip.textContent),
              checked: chips.filter((chip) => chip.querySelector('input').checked).map((chip) => chip.textContent),
              clock: form.querySelector('.instrument-clock input').checked,
              save: form.querySelector('button[type="submit"]').textContent,
              saveDisabled: form.querySelector('button[type="submit"]').getAttribute('aria-disabled'),
              fieldsDisabled: form.querySelector('fieldset.instrument-editor-fields').disabled,
              errors: errors === null ? null : Array.from(errors.children).map((row) => row.textContent),
              errorsRole: errors === null ? null : errors.getAttribute('role'),
              channelsInvalid: form.querySelector('.instrument-channels-group').getAttribute('aria-invalid'),
              portInvalid: select.getAttribute('aria-invalid'),
            };
          })()`,
        );
      const waitEditorGone = () => waitFor(cdp, `document.querySelector(${JSON.stringify(formSel)}) === null ? true : null`, 5000);
      const cardChannels = () => evaluateExpr(cdp, `(() => { const card = document.querySelector(${JSON.stringify(cardSel)}); return Array.from(card.querySelectorAll('.instrument-row')).find((row) => row.querySelector('dt').textContent === 'Channels').querySelector('dd').textContent; })()`);
      const readRigChannels = () => JSON.parse(fs.readFileSync(rigFile, 'utf8')).instruments[1].channels;
      const chipSel = (channel) => `${formSel} .instrument-channel:nth-child(${channel})`;
      const uncheckAllBut = async (keep) => {
        for (let channel = 1; channel <= 16; channel += 1) {
          if (!keep.includes(channel)) await clickElement(cdp, chipSel(channel));
        }
      };

      // (a) The editor offers the fake device's outputs in the browser's order and the model's sixteen channels.
      await clickElement(cdp, editSel);
      const opened = await waitFor(cdp, `document.querySelector(${JSON.stringify(formSel)}) !== null ? true : null`, 3000);
      const editor = await readEditor();
      report(
        'settings editor: detected ports and the model channels are offered',
        opened === true &&
          editor.focusedSelect === true &&
          editor.options.join('|') === 'Fake Synth A|Fake Synth B' &&
          editor.selected === 'Fake Synth B' &&
          editor.chips.length === 16 &&
          editor.chips.includes(fill(INSTRUMENTS_COPY.chipRhythm, { n: 10 })) &&
          editor.checked.length === 16 &&
          editor.clock === false &&
          editor.saveDisabled === 'true',
        JSON.stringify(editor),
      );

      const waitErrors = (matches, timeoutMs = 5000) =>
        waitFor(cdp, `(() => { const list = document.querySelector(${JSON.stringify(`${formSel} .instrument-errors`)}); return list !== null && (${matches}) ? true : null; })()`, timeoutMs);
      const checkAll = async () => {
        for (let channel = 1; channel <= 16; channel += 1) {
          const isChecked = await evaluateExpr(cdp, `document.querySelector(${JSON.stringify(`${chipSel(channel)} input`)}).checked`);
          if (!isChecked) await clickElement(cdp, chipSel(channel));
        }
      };
      const chooseWithSelect = (value) =>
        evaluateExpr(cdp, `(() => { const select = document.querySelector(${JSON.stringify(`${formSel} select`)}); select.value = ${JSON.stringify(value)}; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);

      // (a2) No chip checked is sent as is, and the page shows the server's own reason; the channels group is marked; the file is unchanged.
      await uncheckAllBut([]);
      await clickElement(cdp, `${formSel} button[type="submit"]`);
      const noChannels = await waitErrors(`list.textContent.includes('Channels · at least one channel is required')`);
      const noChannelsRead = await readEditor();
      report(
        "settings editor: no channel is refused with the server's reason",
        noChannels === true &&
          noChannelsRead.errors.join('|') === 'Channels · at least one channel is required' &&
          noChannelsRead.errorsRole === 'alert' &&
          noChannelsRead.channelsInvalid === 'true' &&
          noChannelsRead.portInvalid === null &&
          noChannelsRead.checked.length === 0 &&
          noChannelsRead.fieldsDisabled === false &&
          noChannelsRead.save === 'Save' &&
          fs.readFileSync(rigFile, 'utf8') === originalRigText,
        JSON.stringify(noChannelsRead),
      );

      // (a3) The port of another instrument is refused (sc55 on mt32's port, channels overlapping), shown as a Port row.
      await checkAll();
      await chooseWithSelect('Fake Synth A');
      await clickElement(cdp, `${formSel} button[type="submit"]`);
      const samePort = await waitErrors(`list.textContent.startsWith('Port · same port as instruments[0]')`);
      const samePortRead = await readEditor();
      report(
        'settings editor: the port of another instrument is refused',
        samePort === true &&
          samePortRead.errors.length === 1 &&
          samePortRead.errors[0].startsWith('Port · same port as instruments[0]') &&
          samePortRead.portInvalid === 'true' &&
          samePortRead.channelsInvalid === null &&
          samePortRead.selected === 'Fake Synth A' &&
          fs.readFileSync(rigFile, 'utf8') === originalRigText,
        JSON.stringify(samePortRead),
      );
      await chooseWithSelect('Fake Synth B');

      // (a4) A file that cannot be written: a directory where the temporary file belongs. One line, the draft kept, the fields unlocked.
      const writeBlocker = `${rigFile}.tmp`;
      fs.mkdirSync(writeBlocker);
      const rowsBefore = await cardChannels();
      await clickElement(cdp, chipSel(16));
      await clickElement(cdp, `${formSel} button[type="submit"]`);
      const notWritten = await waitErrors(`list.textContent.startsWith('Nothing was saved.')`);
      const notWrittenRead = await readEditor();
      const rowsAfter = await cardChannels();
      fs.rmSync(writeBlocker, { recursive: true, force: true });
      report(
        'settings editor: a file that cannot be written says nothing was saved',
        notWritten === true &&
          notWrittenRead.errors.length === 1 &&
          notWrittenRead.errors[0].startsWith('Nothing was saved. instruments.json could not be written: the file system answered ') &&
          notWrittenRead.fieldsDisabled === false &&
          notWrittenRead.checked.length === 15 &&
          !notWrittenRead.checked.includes('16') &&
          notWrittenRead.channelsInvalid === null &&
          rowsBefore === rowsAfter &&
          fs.readFileSync(rigFile, 'utf8') === originalRigText,
        JSON.stringify({ notWrittenRead, rowsBefore, rowsAfter }),
      );

      // (a5) No answer within 5 s: the list says Moontide did not confirm, the fields unlock, the draft stays as chosen.
      await evaluateExpr(
        cdp,
        `(() => {
          window.__settingsFramesDropped = 0;
          if (!window.__originalSend) window.__originalSend = WebSocket.prototype.send;
          WebSocket.prototype.send = function (data) {
            let type = null;
            try { type = JSON.parse(data).type; } catch (err) { type = null; }
            if (type === 'instrument-settings') { window.__settingsFramesDropped += 1; return; }
            return window.__originalSend.call(this, data);
          };
        })()`,
      );
      await clickElement(cdp, `${formSel} button[type="submit"]`);
      const lockedWhileWaiting = await evaluateExpr(cdp, `(() => { const form = document.querySelector(${JSON.stringify(formSel)}); return { fieldsDisabled: form.querySelector('fieldset.instrument-editor-fields').disabled, save: form.querySelector('button[type="submit"]').textContent, cancelDisabled: form.querySelector('button[type="button"]').getAttribute('aria-disabled'), focusOnSave: document.activeElement === form.querySelector('button[type="submit"]') }; })()`);
      await sleep(5500);
      const unconfirmed = await waitErrors(`list.textContent === ${JSON.stringify(MIDI_COPY.takeBackFailed)}`, 2000);
      const unconfirmedRead = await readEditor();
      const framesDropped = await evaluateExpr(cdp, 'window.__settingsFramesDropped');
      await evaluateExpr(cdp, `(() => { if (window.__originalSend) WebSocket.prototype.send = window.__originalSend; })()`);
      report(
        'settings editor: no answer within 5 s keeps the draft',
        unconfirmed === true &&
          framesDropped === 1 &&
          lockedWhileWaiting.fieldsDisabled === true &&
          lockedWhileWaiting.save === INSTRUMENTS_COPY.saving &&
          lockedWhileWaiting.cancelDisabled === 'true' &&
          lockedWhileWaiting.focusOnSave === true &&
          unconfirmedRead.fieldsDisabled === false &&
          unconfirmedRead.checked.length === 15 &&
          !unconfirmedRead.checked.includes('16'),
        JSON.stringify({ lockedWhileWaiting, unconfirmedRead, framesDropped }),
      );
      await checkAll();

      // (b) Channels 1, 2, 3 and 10 only, then Save: one message, the card, the file and its backup follow, focus lands on Edit settings.
      await uncheckAllBut([1, 2, 3, 10]);
      const edited = await readEditor();
      await clickElement(cdp, `${formSel} button[type="submit"]`);
      const gone = await waitEditorGone();
      const channelsText = await cardChannels();
      const focusOnEdit = await evaluateExpr(cdp, `document.activeElement === document.querySelector(${JSON.stringify(editSel)})`);
      const rigAfter = JSON.parse(fs.readFileSync(rigFile, 'utf8'));
      const bakText = fs.existsSync(bakFile) ? fs.readFileSync(bakFile, 'utf8') : null;
      const aimed = await refusedWith(`note("c3").midi('Fake Synth B', { midichannel: 5 })`, 'probe:midi editor channel 5');
      report(
        'settings editor: Save rewrites instruments.json, keeps the .bak, and the card shows the new channels',
        edited.saveDisabled === null &&
          gone === true &&
          channelsText === 'ch 1–3 melodic, ch 10 rhythm' &&
          focusOnEdit === true &&
          JSON.stringify(readRigChannels()) === JSON.stringify([1, 2, 3, 10]) &&
          rigAfter.instruments[1].id === 'sc55' &&
          bakText === originalRigText &&
          aimed !== null &&
          aimed.includes('Channel 5 is not declared for sc55.'),
        JSON.stringify({ gone: gone === true, channelsText, focusOnEdit, fileChannels: rigAfter.instruments[1].channels, bakKeepsTheOldText: bakText === originalRigText, aimed: firstLine(aimed) }),
      );

      fs.writeFileSync(rigFile, originalRigText);
      fs.rmSync(bakFile, { force: true });
      await callTool(client, 'get_midi_instruments', {});
      await pressKey(cdp, 'Escape');
      await callTool(client, 'set_code', { code: SILENT, label: 'probe:midi editor done' });
      await setScenario({ permission: 'granted' });
    }

    // --- Instrument controls ---
    // The fader of a MIDI track in the Mixer sets the instrument's CC7 at each move of a drag with no
    // evaluation; its release writes controls: { volume: N } into the .midi() options with one evaluation
    // that sends nothing more, and records one version about 1.5 s later.
    fs.writeFileSync(rigFile, JSON.stringify({ instruments: [{ id: 'mt32', model: 'mt32', port: 'Fake Synth A' }] }));
    await setScenario({ permission: 'granted' });
    await callTool(client, 'set_code', { code: `pad: note("c3 e3 g3 c4").midi('Fake Synth A', { midichannel: 3 })`, label: 'probe:midi controls pad' });
    await sleep(800);
    const faderSelector = '.mx-strip[data-track="label:pad"][data-midi="true"] .mx-fader';
    const mixerShown = await openView(3);
    const faderThere = await waitFor(cdp, `document.querySelector(${JSON.stringify(faderSelector)}) ? true : null`, 3000);
    await installEvalCounter();
    const newestVersion = async () => {
      const reply = await callTool(client, 'list_history', {});
      const line = reply.split('\n').find((row) => /^#\d+ /.test(row)) ?? '';
      return { id: Number((/^#(\d+) /.exec(line) ?? [])[1]), line };
    };
    const controlsBefore = await newestVersion();
    // The log has thousands of entries by now: read its length and its tail, never the whole of it.
    const logLength = () => evaluateExpr(cdp, 'window.__midiLog.length');
    const dragStart = await logLength();
    let releaseMark = null;
    let evalsBeforeRelease = null;
    await dragSlider(cdp, faderSelector, 0.3, 0.75, 8, async () => {
      evalsBeforeRelease = await evalCount();
      releaseMark = await logLength();
    });
    await waitFor(cdp, `document.querySelectorAll('.mx-flash').length > 0 ? true : null`, 1500);
    const evalsAfterRelease = await evalCount();
    const codeAfterDrag = await callTool(client, 'get_code', {});
    // The record comes about 1.5 s after the last move: wait for the version, not for a fixed time.
    let controlsAfter = await newestVersion();
    for (let attempt = 0; attempt < 120 && controlsAfter.id === controlsBefore.id; attempt += 1) {
      await sleep(250);
      controlsAfter = await newestVersion();
    }
    const isVolumeOnA = (entry) => entry.port === 'Fake Synth A' && entry.bytes.length === 3 && entry.bytes[0] === 0xb2 && entry.bytes[1] === 7;
    const dragEntries = await evaluateExpr(cdp, `window.__midiLog.slice(${dragStart})`);
    const duringDrag = dragEntries.slice(0, releaseMark === null ? 0 : releaseMark - dragStart).filter(isVolumeOnA);
    const afterMark = dragEntries.slice(releaseMark === null ? 0 : releaseMark - dragStart).filter(isVolumeOnA);
    const distinctPreviews = new Set(duringDrag.filter((entry) => entry.ts === null).map((entry) => entry.bytes[2]));
    report(
      'dragging a MIDI fader sends CC7 at each move without evaluating',
      mixerShown === true && faderThere === true && distinctPreviews.size >= 3 && evalsBeforeRelease === 0,
      JSON.stringify({ mixerShown, faderThere, distinctPreviews: [...distinctPreviews], evalsBeforeRelease }),
    );
    const writtenVolume = /controls: \{ volume: (\d+) \}/.exec(codeAfterDrag);
    const lastVolume = dragEntries.filter(isVolumeOnA).pop();
    report(
      'releasing a MIDI fader writes controls: { volume: N }, evaluates once and records one version',
      writtenVolume !== null &&
        lastVolume !== undefined &&
        Number(writtenVolume[1]) === lastVolume.bytes[2] &&
        afterMark.length <= 1 &&
        evalsAfterRelease === 1 &&
        controlsAfter.id === controlsBefore.id + 1 &&
        controlsAfter.line.includes(`"mixer: pad volume ${writtenVolume[1]}"`),
      JSON.stringify({ code: codeAfterDrag.split('\n')[0], lastVolume: lastVolume === undefined ? null : lastVolume.bytes[2], cc7AfterRelease: afterMark.length, evalsAfterRelease, controlsBefore, controlsAfter }),
    );
    await pressKey(cdp, 'Escape');

    // --- Controls inspector ---
    // A MIDI strip shows the controls its instrument's model declares in place of browser effects. A chip opens the
    // controls inspector; its slider sends the CC at each move with no evaluation, and the release writes the control
    // into the code with one evaluation and one version.
    const PAD_PLAIN = `pad: note("c3 e3 g3 c4").midi('Fake Synth A', { midichannel: 3 })`;
    await callTool(client, 'set_code', { code: PAD_PLAIN, label: 'probe:midi controls inspector pad' });
    await sleep(800);
    const padStrip = '.mx-strip[data-track="label:pad"][data-midi="true"]';
    const mixerShown2 = await openView(3);
    const chipsThere = await waitFor(cdp, `document.querySelector(${JSON.stringify(`${padStrip} .mx-midi-chip`)}) ? true : null`, 3000);
    const stripFacts = await evaluateExpr(
      cdp,
      `(() => {
        const strip = document.querySelector(${JSON.stringify(padStrip)});
        const note = strip.querySelector('.mx-midi-note');
        return {
          params: [...strip.querySelectorAll('.mx-midi-chip')].map((chip) => chip.dataset.param),
          values: [...strip.querySelectorAll('.mx-midi-chip .mx-chip-value')].map((value) => value.textContent),
          note: note === null ? null : note.textContent,
          noteHidden: note === null ? null : note.hidden,
          add: strip.querySelector('.mx-add') !== null,
          send: strip.querySelector('.mx-send') !== null,
          dots: strip.querySelectorAll('.mx-chip-dot').length,
        };
      })()`,
    );
    report(
      'a MIDI strip shows the declared controls and the browser-effects note instead of effects',
      mixerShown2 === true &&
        chipsThere === true &&
        JSON.stringify(stripFacts.params) === JSON.stringify(['modulation', 'pan', 'expression', 'hold']) &&
        stripFacts.values.every((value) => value === 'default') &&
        stripFacts.note === "Browser effects don't reach an external instrument." &&
        stripFacts.noteHidden === false &&
        stripFacts.add === false &&
        stripFacts.send === false &&
        stripFacts.dots === 0,
      JSON.stringify(stripFacts),
    );
    await clickElement(cdp, `${padStrip} .mx-midi-chip[data-param="pan"] .mx-chip-body`);
    const inspectorFacts = await waitFor(
      cdp,
      `(() => {
        const inspector = document.getElementById('mixer-inspector');
        if (inspector.hidden) return null;
        const title = inspector.querySelector('.mx-insp-title');
        const line = inspector.querySelector('.mx-insp-line');
        if (title === null || line === null || line.hidden) return null;
        return { title: title.textContent, line: line.textContent, rows: [...inspector.querySelectorAll('.mx-row')].map((row) => row.dataset.param) };
      })()`,
      3000,
    );
    const panSlider = '#mixer-inspector .mx-row[data-param="pan"] input[type="range"]';
    await installEvalCounter();
    const inspectorBefore = await newestVersion();
    const inspectorDragStart = await logLength();
    let inspectorReleaseMark = null;
    let inspectorEvalsBeforeRelease = null;
    await dragSlider(cdp, panSlider, 0.2, 0.6, 6, async () => {
      inspectorEvalsBeforeRelease = await evalCount();
      inspectorReleaseMark = await logLength();
    });
    await waitFor(cdp, `document.querySelectorAll('.mx-flash').length > 0 ? true : null`, 1500);
    const inspectorEvalsAfterRelease = await evalCount();
    const codeAfterPan = await callTool(client, 'get_code', {});
    let inspectorAfter = await newestVersion();
    for (let attempt = 0; attempt < 120 && inspectorAfter.id === inspectorBefore.id; attempt += 1) {
      await sleep(250);
      inspectorAfter = await newestVersion();
    }
    const isPanOnA = (entry) => entry.port === 'Fake Synth A' && entry.bytes.length === 3 && entry.bytes[0] === 0xb2 && entry.bytes[1] === 10;
    const panEntries = await evaluateExpr(cdp, `window.__midiLog.slice(${inspectorDragStart})`);
    const panDuring = panEntries.slice(0, inspectorReleaseMark === null ? 0 : inspectorReleaseMark - inspectorDragStart).filter(isPanOnA);
    const panPreviews = new Set(panDuring.filter((entry) => entry.ts === null).map((entry) => entry.bytes[2]));
    const writtenPan = /pan: (\d+)/.exec(codeAfterPan);
    const lastPan = panEntries.filter(isPanOnA).pop();
    report(
      'dragging a MIDI control slider sends its CC without evaluating, and the release writes it once with one version',
      inspectorFacts !== null &&
        inspectorFacts.title === 'Controls \u00b7 pad' &&
        inspectorFacts.line === 'mt32 \u00b7 ch 3' &&
        JSON.stringify(inspectorFacts.rows) === JSON.stringify(['modulation', 'pan', 'expression', 'hold']) &&
        panPreviews.size >= 3 &&
        inspectorEvalsBeforeRelease === 0 &&
        inspectorEvalsAfterRelease === 1 &&
        writtenPan !== null &&
        /controls: \{ pan: \d+ \}/.test(codeAfterPan) &&
        lastPan !== undefined &&
        Number(writtenPan[1]) === lastPan.bytes[2] &&
        inspectorAfter.id === inspectorBefore.id + 1 &&
        inspectorAfter.line.includes(`"mixer: pad pan ${writtenPan[1]}"`),
      JSON.stringify({ inspectorFacts, previews: [...panPreviews], evalsBeforeRelease: inspectorEvalsBeforeRelease, evalsAfterRelease: inspectorEvalsAfterRelease, code: codeAfterPan.split('\n')[0], lastPan: lastPan === undefined ? null : lastPan.bytes[2], inspectorBefore, inspectorAfter }),
    );
    await clickElement(cdp, '#mixer-inspector .mx-insp-close');
    await pressKey(cdp, 'Escape');

    // --- Control refusals ---
    // Code that asks an instrument for a control it does not have, or two values of one control on one channel, fails the
    // evaluation with its reason while the old music keeps playing, and no control byte is sent.
    await callTool(client, 'set_code', { code: PAD_PLAIN, label: 'probe:midi control refusals pad' });
    await sleep(500);
    const unknownText = await refusedWith(`pad: note("c3 e3 g3 c4").midi('Fake Synth A', { midichannel: 3, controls: { volum: 90 } })`, 'probe:midi unknown control');
    const codeAfterUnknown = await callTool(client, 'get_code', {});
    report(
      'an unknown control fails the evaluation with the list of controls',
      firstLine(unknownText) === 'Evaluation failed: Unknown control "volum" for mt32.' &&
        (unknownText ?? '').includes('Controls for mt32: modulation, volume, pan, expression, hold.') &&
        codeAfterUnknown.includes(PAD_PLAIN) &&
        !codeAfterUnknown.includes('volum'),
      JSON.stringify({ errorStart: firstLine(unknownText), text: (unknownText ?? '').slice(0, 400), code: codeAfterUnknown.slice(0, 160) }),
    );
    const conflictMark = await logLength();
    const controlConflictText = await refusedWith(
      [`lead: note("c3").midi('Fake Synth A', { midichannel: 3, controls: { volume: 60 } })`, `pad: note("e3").midi('Fake Synth A', { midichannel: 3, controls: { volume: 90 } })`].join('\n'),
      'probe:midi two volumes',
    );
    await sleep(300);
    const afterConflict = await evaluateExpr(cdp, `window.__midiLog.slice(${conflictMark})`);
    const volumesSent = afterConflict.filter((entry) => entry.port === 'Fake Synth A' && entry.bytes.length === 3 && entry.bytes[0] === 0xb2 && entry.bytes[1] === 7);
    report(
      'two different values of one control on one channel fail the evaluation',
      firstLine(controlConflictText) === 'Evaluation failed: mt32 channel 3 is given two different volume values: 60 and 90.' && volumesSent.length === 0,
      JSON.stringify({ errorStart: firstLine(controlConflictText), volumesSent: volumesSent.length }),
    );

    // --- Controls inspector states ---
    // Default, a typed number and PageUp each write one version; a sweep Claude wrote makes its control moving and
    // disabled; a right click on a control asks about the track, the instrument and the control.
    const padWith = (middle) => `pad: note("c3 e3 g3 c4")${middle}.midi('Fake Synth A', { midichannel: 3${middle.includes('ccn') ? '' : ', controls: { pan: 70 }'} })`;
    await callTool(client, 'set_code', { code: padWith(''), label: 'probe:midi control states pad' });
    await sleep(800);
    const statesShown = await openView(3);
    await installEvalCounter();
    await clickElement(cdp, `${padStrip} .mx-midi-chip[data-param="pan"] .mx-chip-body`);
    const panRow = '#mixer-inspector .mx-row[data-param="pan"]';
    const inspectorOpen = await waitFor(cdp, `document.querySelector(${JSON.stringify(`${panRow} .mx-default`)}) ? true : null`, 3000);
    /** The code of a get_code reply: the notices Moontide adds come after a blank line, and their words are not the code's. */
    const codeOnly = (reply) => reply.split('\n\n')[0];
    /** Waits for a history version newer than `before` and returns it. */
    const nextVersion = async (before) => {
      let version = await newestVersion();
      for (let attempt = 0; attempt < 120 && version.id === before.id; attempt += 1) {
        await sleep(250);
        version = await newestVersion();
      }
      return version;
    };

    // (a) Default takes the control out of the code and sends the model default once.
    const beforeDefault = await newestVersion();
    const defaultMark = await logLength();
    await clickElement(cdp, `${panRow} .mx-default`);
    const codeAfterDefault = codeOnly(await codeWhen((code) => !codeOnly(code).includes('pan')));
    const afterDefault = await nextVersion(beforeDefault);
    const defaultEntries = await evaluateExpr(cdp, `window.__midiLog.slice(${defaultMark})`);
    const defaultSent = defaultEntries.filter((entry) => entry.port === 'Fake Synth A' && entry.bytes.join() === '178,10,64');
    report(
      'Default removes the control from the code and sends its default',
      statesShown === true &&
        inspectorOpen === true &&
        !codeAfterDefault.includes('pan') &&
        !codeAfterDefault.includes('controls') &&
        defaultSent.length >= 1 &&
        afterDefault.id === beforeDefault.id + 1 &&
        afterDefault.line.includes('"mixer: pad pan default"'),
      JSON.stringify({ code: codeAfterDefault.split('\n')[0], defaultSent: defaultSent.length, afterDefault }),
    );

    // (b) A typed number commits on Enter: one write, one version.
    const beforeTyped = await newestVersion();
    await clickElement(cdp, `${panRow} input[type="number"]`);
    await evaluateExpr(cdp, `document.querySelector(${JSON.stringify(`${panRow} input[type="number"]`)}).select()`);
    await pressKey(cdp, '3');
    await pressKey(cdp, '0');
    await pressKey(cdp, 'Enter');
    const codeAfterTyped = await codeWhen((code) => code.includes('pan: 30'));
    const afterTyped = await nextVersion(beforeTyped);
    report(
      'a typed number writes the control at once with one version',
      codeAfterTyped.includes('pan: 30') && afterTyped.id === beforeTyped.id + 1 && afterTyped.line.includes('"mixer: pad pan 30"'),
      JSON.stringify({ code: codeAfterTyped.split('\n')[0], afterTyped }),
    );

    // (c) PageUp on the focused slider moves it by 10.
    const beforePage = await newestVersion();
    await evaluateExpr(cdp, `document.querySelector(${JSON.stringify(`${panRow} input[type="range"]`)}).focus()`);
    await pressKey(cdp, 'PageUp');
    const codeAfterPage = await codeWhen((code) => code.includes('pan: 40'));
    const afterPage = await nextVersion(beforePage);
    report(
      'PageUp moves a MIDI control by 10',
      codeAfterPage.includes('pan: 40') && afterPage.id === beforePage.id + 1 && afterPage.line.includes('"mixer: pad pan 40"'),
      JSON.stringify({ code: codeAfterPage.split('\n')[0], afterPage }),
    );

    // (d) A sweep on the same cc makes that control moving and disabled; another control stays free.
    await callTool(client, 'set_code', { code: padWith('.ccv(sine.segment(8)).ccn(10)'), label: 'probe:midi sweep on pan' });
    const swept = await waitFor(
      cdp,
      `(() => {
        const chip = document.querySelector(${JSON.stringify(`${padStrip} .mx-midi-chip[data-param="pan"] .mx-chip-value`)});
        const row = document.querySelector(${JSON.stringify(panRow)});
        if (chip === null || row === null || chip.textContent !== 'moving') return null;
        const modulation = document.querySelector('#mixer-inspector .mx-row[data-param="modulation"]');
        const text = row.querySelector('.mx-moving-text');
        const sweep = row.querySelector('.mx-sweep');
        return {
          chip: chip.textContent,
          text: text === null ? null : text.textContent,
          sweep: sweep === null ? null : sweep.textContent,
          panRange: row.querySelector('input[type="range"]') !== null,
          panNumber: row.querySelector('input[type="number"]') !== null,
          modulationRange: modulation !== null && modulation.querySelector('input[type="range"]') !== null,
        };
      })()`,
      5000,
    );
    report(
      'a Claude sweep on a control makes it moving and disabled, and another control stays free',
      swept !== null &&
        swept.text === 'Moving (from code)' &&
        swept.sweep === 'A sweep in the code moves this control on channel 3. Ask Claude to change it.' &&
        swept.panRange === false &&
        swept.panNumber === false &&
        swept.modulationRange === true,
      JSON.stringify({ swept }),
    );
    await openView(3);
    await callTool(client, 'set_code', { code: padWith('.ccv(sine.segment(8)).ccn(7)'), label: 'probe:midi sweep on volume' });
    const faderSwept = await waitFor(
      cdp,
      `(() => {
        const fader = document.querySelector(${JSON.stringify(`${padStrip} .mx-fader`)});
        const line = document.querySelector(${JSON.stringify(`${padStrip} .mx-fader-line`)});
        if (fader === null || line === null || !fader.disabled) return null;
        return { disabled: fader.disabled, line: line.textContent };
      })()`,
      5000,
    );
    report(
      'a Claude sweep on the volume disables the fader with its sentence',
      faderSwept !== null && faderSwept.line === 'A sweep in the code moves the volume on channel 3. Ask Claude to change it.',
      JSON.stringify({ faderSwept }),
    );

    // (e) A right click on a control chip asks Claude about exactly that control.
    const asked = await askAt(cdp, `${padStrip} .mx-midi-chip[data-param="pan"] .mx-chip-body`);
    report(
      'a right click on a MIDI control asks about the track, the instrument and the control',
      asked.open === true && asked.chip.includes('pad') && asked.chip.includes('mt32 \u00b7 ch 3') && asked.chip.includes('Pan'),
      JSON.stringify({ asked }),
    );
    await pressKey(cdp, 'Escape');
    await evaluateExpr(cdp, `(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); })()`);
    await pressKey(cdp, 'Escape');

    // --- Instrument tags ---
    // A MIDI track names its instrument and channel in the Timeline lane and in the Mixer strip, from one formatter, and an edit
    // of instruments.json updates both without a new evaluation.
    const TAG_PAD = `pad: note("c3 e3").midi('Fake Synth A', { midichannel: 3, sound: 'Str Sect 1' })`;
    const TAG_CODE = `${TAG_PAD}\nbeat: s("bd*4").gain(0)`;
    const writeRig = (id, port = 'Fake Synth A') => fs.writeFileSync(rigFile, JSON.stringify({ instruments: [{ id, model: 'mt32', port }] }));
    writeRig('mt32');
    await setScenario({ permission: 'granted' });
    await callTool(client, 'set_code', { code: TAG_CODE, label: 'probe:midi instrument tags' });
    await sleep(800);
    await installEvalCounter();
    const timelineReady = async () => {
      await waitFor(cdp, `(() => { const s = document.getElementById('timeline-view').dataset.state; return s === 'ok' ? s : null; })()`, 8000);
      return waitFor(cdp, `document.querySelector('#timeline-lanes .lane[data-track="label:pad"]') ? true : null`, 3000);
    };
    /** The tag of a lane (text, title, name) read from the Timeline, or null when the lane has none. */
    const laneFacts = (identity) =>
      evaluateExpr(
        cdp,
        `(() => {
          const lane = document.querySelector('#timeline-lanes .lane[data-track=' + ${JSON.stringify(JSON.stringify(identity))} + ']');
          if (lane === null) return { lane: false };
          const tag = lane.querySelector('.lane-tag');
          const order = [...lane.querySelector('.lane-gutter').children].map((child) => child.className);
          return { lane: true, name: lane.querySelector('.lane-name').textContent, tag: tag === null ? null : tag.textContent, title: tag === null ? null : tag.title, order };
        })()`,
      );
    const stripTagFacts = (identity) =>
      evaluateExpr(
        cdp,
        `(() => {
          const strip = document.querySelector('.mx-strip[data-track=' + ${JSON.stringify(JSON.stringify(identity))} + ']');
          if (strip === null) return { strip: false };
          const tag = strip.querySelector('.mx-tag');
          return { strip: true, tag: tag === null ? null : tag.textContent, title: tag === null ? null : tag.title, hidden: tag === null ? null : tag.hidden, sounding: strip.dataset.sounding };
        })()`,
      );
    await openView(2);
    const timelineOk = await timelineReady();
    const padLane = await laneFacts('label:pad');
    const beatLane = await laneFacts('label:beat');
    report(
      'the Timeline names the instrument and channel of a MIDI lane, and no other lane',
      timelineOk === true &&
        padLane.tag === 'mt32 · ch 3' &&
        padLane.title === 'mt32 (Fake Synth A) · channel 3 · Str Sect 1' &&
        padLane.name === 'pad' &&
        JSON.stringify(padLane.order) === JSON.stringify(['lane-name', 'lane-tag', 'lane-sub']) &&
        beatLane.lane === true &&
        beatLane.tag === null,
      JSON.stringify({ padLane, beatLane }),
    );
    // A right-click on the MIDI lane sends a moment whose notes name the instrument and channel exactly as the lane tag does;
    // the browser drum lane's notes carry no instrument. The request waits for the next tool reply (no listener runs here).
    const momentSpot = await evaluateExpr(
      cdp,
      `(() => {
        const svg = document.querySelector('#timeline-lanes .lane[data-track="label:pad"] .lane-events');
        const r = svg.getBoundingClientRect();
        return { x: r.x + 0.27 * r.width, y: r.y + r.height / 2 };
      })()`,
    );
    const momentOpened = await askAtCoords(cdp, momentSpot.x, momentSpot.y);
    await cdp('Input.insertText', { text: 'midi moment check' });
    await pressKey(cdp, 'Enter');
    await sleep(500);
    const momentReply = await callTool(client, 'get_code', {});
    const REQUEST_PREFIX = 'Request from the Moontide page: ';
    const momentRequests = momentReply
      .split('\n')
      .filter((line) => line.startsWith(REQUEST_PREFIX))
      .map((line) => {
        try {
          return JSON.parse(line.slice(REQUEST_PREFIX.length));
        } catch {
          return null;
        }
      })
      .filter((entry) => entry !== null && entry.text === 'midi moment check');
    const momentOf = momentRequests.length === 1 ? momentRequests[0] : undefined;
    const moment = momentOf === undefined ? undefined : momentOf.moment;
    const padNotes = moment === undefined ? [] : moment.notes.filter((note) => note.track === 'pad');
    const beatNotes = moment === undefined ? [] : moment.notes.filter((note) => note.track === 'beat');
    report(
      'moment: a MIDI lane names its instrument and channel',
      momentOpened.open === true &&
        moment !== undefined &&
        padNotes.length > 0 &&
        padNotes.every((note) => note.instrument === padLane.tag && Math.abs(note.velocity - 0.9) < 0.001) &&
        beatNotes.length > 0 &&
        beatNotes.every((note) => note.instrument === undefined && note.velocity === 0) &&
        momentOf.context.kind === 'lane' &&
        momentOf.context.track === 'pad' &&
        moment.cycle === momentOf.context.cycle,
      JSON.stringify({ momentOpened, tag: padLane.tag, requests: momentRequests.length, moment }),
    );
    if (await evaluateExpr(cdp, "!document.getElementById('ask-box').hidden")) await pressKey(cdp, 'Escape');
    await openView(3);
    await waitFor(cdp, `document.querySelector('.mx-strip[data-track="label:pad"] .mx-tag') ? true : null`, 3000);
    const padStripTag = await stripTagFacts('label:pad');
    const beatStripTag = await stripTagFacts('label:beat');
    report(
      'the Mixer strip shows the same tag',
      padStripTag.tag === padLane.tag &&
        padStripTag.title === padLane.title &&
        padStripTag.hidden === false &&
        (beatStripTag.tag === null || beatStripTag.hidden === true),
      JSON.stringify({ padStripTag, beatStripTag }),
    );
    // The file now calls the same instrument by another id: the server pushes the new rig when a tool reads the file again.
    const evalsBeforeRig = await evalCount();
    writeRig('synth');
    await callTool(client, 'get_midi_instruments', {});
    const renamed = await waitFor(
      cdp,
      `(() => { const tag = document.querySelector('.mx-strip[data-track="label:pad"] .mx-tag'); return tag !== null && tag.textContent === 'synth · ch 3' ? true : null; })()`,
      2000,
    );
    const evalsAfterRig = await evalCount();
    await openView(2);
    const timelineAgain = await timelineReady();
    const renamedLane = await laneFacts('label:pad');
    // The Timeline stays open while the file changes back: its lanes are drawn again from the cached page.
    writeRig('mt32');
    await callTool(client, 'get_midi_instruments', {});
    const restoredOpen = await waitFor(
      cdp,
      `(() => { const tag = document.querySelector('#timeline-lanes .lane[data-track="label:pad"] .lane-tag'); return tag !== null && tag.textContent === 'mt32 \u00b7 ch 3' ? true : null; })()`,
      2000,
    );
    const evalsAfterTimeline = await evalCount();
    report(
      'an edit of instruments.json updates the tags without a new evaluation',
      renamed === true && evalsAfterRig === evalsBeforeRig && timelineAgain === true && renamedLane.tag === 'synth \u00b7 ch 3' && restoredOpen === true && evalsAfterTimeline === evalsBeforeRig,
      JSON.stringify({ renamed, evalsBeforeRig, evalsAfterRig, evalsAfterTimeline, laneTag: renamedLane.tag, restoredOpen }),
    );
    await pressKey(cdp, 'Escape');

    // --- Drum lane names ---
    // An MT-32 rhythm lane is drawn as one named row per drum note, low note at the bottom; a melodic lane is drawn as before.
    const DRUM_CODE = `drums: note("36 38 42 38").midi('Fake Synth A', { midichannel: 10 })\n${TAG_PAD}`;
    await callTool(client, 'set_code', { code: DRUM_CODE, label: 'probe:midi drum lane rows' });
    await sleep(800);
    await openView(2);
    await timelineReady();
    /** The drum facts of a lane read from the Timeline: rows attribute, labels, band titles, svg role and label, tag title. */
    const drumFacts = (identity) =>
      waitFor(
        cdp,
        `(() => {
          const lane = document.querySelector('#timeline-lanes .lane[data-track=' + ${JSON.stringify(JSON.stringify(identity))} + ']');
          if (lane === null) return null;
          const overlay = lane.querySelector('.lane-drums');
          const svg = lane.querySelector('.lane-events');
          const tag = lane.querySelector('.lane-tag');
          return {
            rows: lane.dataset.drumRows === undefined ? null : lane.dataset.drumRows,
            labels: overlay === null ? null : [...overlay.querySelectorAll('.drum-row-label')].map((el) => el.textContent),
            overlay: overlay !== null,
            bands: [...lane.querySelectorAll('.drum-band')].map((band) => band.querySelector('title').textContent),
            role: svg.getAttribute('role'),
            aria: svg.getAttribute('aria-label'),
            tagTitle: tag === null ? null : tag.title,
            marks: lane.querySelectorAll('.lane-events .event').length,
          };
        })()`,
        4000,
      );
    const drumsLane = await waitFor(cdp, `(() => { const lane = document.querySelector('#timeline-lanes .lane[data-track="label:drums"]'); return lane !== null && lane.dataset.drumRows !== undefined ? true : null; })()`, 6000);
    const drumFactsA = await drumFacts('label:drums');
    const padFactsA = await drumFacts('label:pad');
    report(
      'drum lane: an MT-32 rhythm lane names its drums in rows',
      drumsLane === true &&
        drumFactsA !== null &&
        drumFactsA.rows === '3' &&
        JSON.stringify(drumFactsA.labels) === JSON.stringify(['Closed High Hat', 'Acoustic Snare Drum', 'Acoustic Bass Drum']) &&
        JSON.stringify(drumFactsA.bands) === JSON.stringify(['42 Closed High Hat', '38 Acoustic Snare Drum', '36 Acoustic Bass Drum']) &&
        drumFactsA.role === 'img' &&
        drumFactsA.aria === 'Drums: Acoustic Bass Drum, Acoustic Snare Drum, Closed High Hat' &&
        drumFactsA.marks > 0 &&
        padFactsA !== null &&
        padFactsA.rows === null &&
        padFactsA.overlay === false &&
        padFactsA.bands.length === 0 &&
        padFactsA.role === null,
      JSON.stringify({ drumFactsA, padFactsA }),
    );
    await pressKey(cdp, 'Escape');

    // --- Drums are not pitches in Jam ---
    // A MIDI drum line is numeric notes (drum-map keys): the Jam scale reading leaves out the tracks the rig puts on a rhythm channel,
    // and follows a rig that changes while Jam is open, without a new evaluation. Made-up neutral notes.
    {
      const JAM_PAD = `pad: note("c3 d3 e3 f3 g3 a3 b3 c4").midi('Fake Synth A', { midichannel: 3, sound: 'Str Sect 1' })`;
      const JAM_DRUMS = `drums: note("36 38 42 38").midi('Fake Synth A', { midichannel: 10 })`;
      const JAM_CONTROL = `drums: note("36 38 42 38").midi('Fake Synth A', { midichannel: 3 })`;
      /** The Jam scale facts as drawn: the view's state, the scale name and its kind. */
      const jamFacts = () =>
        evaluateExpr(
          cdp,
          `(() => ({
            state: document.getElementById('jam-view').dataset.state,
            name: document.getElementById('jam-scale-name').textContent,
            kind: document.getElementById('jam-scale-name').dataset.kind || null,
          }))()`,
        );
      const jamReads = (wantClear) =>
        waitFor(
          cdp,
          `(() => {
            const view = document.getElementById('jam-view');
            const name = document.getElementById('jam-scale-name');
            if (view.dataset.state !== 'ready') return null;
            const clearMajor = name.textContent === 'C major' && name.dataset.kind === 'clear';
            return clearMajor === ${wantClear ? 'true' : 'false'} ? true : null;
          })()`,
          10000,
        );
      writeRig('mt32');
      await callTool(client, 'get_midi_instruments', {});
      await setScenario({ permission: 'granted' });
      await callTool(client, 'set_code', { code: `${JAM_PAD}\n${JAM_DRUMS}`, label: 'probe:midi drums in jam' });
      await sleep(800);
      await openView(5);
      const drumsLeftOut = await jamReads(true).catch(() => null);
      report(
        'drums in Jam: an MT-32 rhythm channel does not count as pitches',
        drumsLeftOut === true,
        JSON.stringify(await jamFacts()),
      );

      // The same notes on a melodic channel are pitches: a wrong rule that also removed melodic tracks would fail here.
      await callTool(client, 'set_code', { code: `${JAM_PAD}\n${JAM_CONTROL}`, label: 'probe:midi drums in jam control' });
      const controlCounts = await jamReads(false).catch(() => null);
      report(
        'drums in Jam: the same notes on a melodic channel do count',
        controlCounts === true,
        JSON.stringify(await jamFacts()),
      );

      // A rig change while Jam is open: the drums stop being recognized (the port the code uses is no longer in the rig) and count,
      // then the rig comes back and they stop counting. No evaluation runs in between.
      await callTool(client, 'set_code', { code: `${JAM_PAD}\n${JAM_DRUMS}`, label: 'probe:midi drums in jam again' });
      const clearAgain = await jamReads(true).catch(() => null);
      await installEvalCounter();
      const evalsBeforeJamRig = await evalCount();
      writeRig('mt32', 'Fake Synth Z');
      await callTool(client, 'get_midi_instruments', {});
      const drumsCount = await jamReads(false).catch(() => null);
      writeRig('mt32');
      await callTool(client, 'get_midi_instruments', {});
      const drumsLeftOutAgain = await jamReads(true).catch(() => null);
      const evalsAfterJamRig = await evalCount();
      report(
        'drums in Jam: a rig change rebuilds the reading without a new evaluation',
        clearAgain === true && drumsCount === true && drumsLeftOutAgain === true && evalsAfterJamRig === evalsBeforeJamRig,
        JSON.stringify({ clearAgain, drumsCount, drumsLeftOutAgain, evalsBeforeJamRig, evalsAfterJamRig }),
      );
      await pressKey(cdp, 'Escape');
    }

    {
      // --- Drum lanes on the Timeline ---
      // Models are built from documents, not heard on hardware: these checks prove what the page draws and sends.
      fs.mkdirSync(path.join(dataDir, 'models'), { recursive: true });
      fs.writeFileSync(path.join(dataDir, 'models', 'bankdrums.json'), JSON.stringify(bankDrumsModel()));
      fs.writeFileSync(path.join(dataDir, 'models', 'gmdrums.json'), JSON.stringify(gmDrumsModel()));
      // A drum name at the 40-character limit of the schema (a 200-character fixture cannot be loaded).
      const LONG_DRUM_NAME = 'Long Drum Name '.repeat(3).slice(0, 39) + 'x';
      fs.writeFileSync(
        path.join(dataDir, 'models', 'drumlong.json'),
        JSON.stringify({
          ...gmDrumsModel(),
          id: 'drumlong',
          name: 'Long Name Drum Synth',
          drumMap: 'long-names',
          drumMaps: [{ id: 'long-names', name: 'Long Names', notes: [{ note: 36, name: LONG_DRUM_NAME }, { note: 38, name: 'Short' }] }],
        }),
      );
      fs.writeFileSync(
        rigFile,
        JSON.stringify({
          instruments: [
            { id: 'mt32', model: 'mt32', port: 'Fake Synth A' },
            { id: 'gmdrums', model: 'gmdrums', port: 'Fake Synth B' },
            { id: 'drumlong', model: 'drumlong', port: 'Fake Synth C' },
            { id: 'drumbank', model: 'bankdrums', port: 'Fake Synth D' },
          ],
        }),
      );
      await callTool(client, 'get_midi_instruments', {});
      await setScenario({ permission: 'granted', outputs: ['Fake Synth A', 'Fake Synth B', 'Fake Synth C', 'Fake Synth D'] });
      const PAD_LINE = `pad: note("c3 e3").midi('Fake Synth A', { midichannel: 3 })`;
      const DRUM_LANES_CODE = [
        `drums: note("36 38 42 38").midi('Fake Synth A', { midichannel: 10 })`,
        `wide: note("35 36 37 38 39 40 41 42 43 44 45 46").midi('Fake Synth B', { midichannel: 10 })`,
        `outside: note("36 52").midi('Fake Synth A', { midichannel: 10 })`,
        `frac: note("36 38.5").midi('Fake Synth A', { midichannel: 10 })`,
        `unk: note("36 38").midi('Fake Synth D', { midichannel: 5, sound: 'Kit C' })`,
        `long: note("36 38").midi('Fake Synth C', { midichannel: 10 })`,
        PAD_LINE,
      ].join('\n');
      await callTool(client, 'set_code', { code: DRUM_LANES_CODE, label: 'probe:midi drum lanes' });
      await sleep(800);
      await openView(2);
      await timelineReady();
      await waitFor(cdp, `(() => { const lane = document.querySelector('#timeline-lanes .lane[data-track="label:long"]'); return lane !== null && lane.dataset.drumRows !== undefined ? true : null; })()`, 6000);
      /** Everything the drum checks read from one lane of the Timeline (null when the lane is not drawn). */
      const drumMetrics = (selector) =>
        evaluateExpr(
          cdp,
          `(() => {
            const lane = document.querySelector(${JSON.stringify(selector)});
            if (lane === null) return null;
            lane.scrollIntoView({ block: 'center' });
            const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
            const overlay = lane.querySelector('.lane-drums');
            const svg = lane.querySelector('.lane-events');
            const labels = overlay === null ? [] : [...overlay.querySelectorAll('.drum-row-label')];
            const bands = [...lane.querySelectorAll('.drum-band')];
            const centerY = (el) => { const r = el.getBoundingClientRect(); return r.top + r.height / 2; };
            const marks = [...lane.querySelectorAll('.lane-events .event')];
            const tag = lane.querySelector('.lane-tag');
            return {
              rows: lane.dataset.drumRows === undefined ? null : lane.dataset.drumRows,
              minHeightPx: parseFloat(getComputedStyle(lane).minHeight),
              remPx: rem,
              heightPx: lane.getBoundingClientRect().height,
              overlay: overlay !== null,
              overlayPointer: overlay === null ? null : getComputedStyle(overlay).pointerEvents,
              overlayHidden: overlay === null ? null : overlay.getAttribute('aria-hidden'),
              labels: labels.map((el) => el.textContent),
              labelNumbered: labels.map((el) => el.classList.contains('drum-row-number')),
              labelOffsets: labels.map((el, index) => Math.abs(centerY(el) - centerY(bands[index]))),
              markOffset: marks.length === 0 || bands.length === 0 ? null : Math.max(...marks.map((mark) => Math.abs(centerY(mark) - centerY(bands[Number(mark.getAttribute('data-row'))])))),
              bandTitles: bands.map((band) => band.querySelector('title').textContent),
              bandCoversRow: bands.every((band) => { const r = band.getBoundingClientRect(); const s = svg.getBoundingClientRect(); return Math.abs(r.width - s.width) < 1 && r.height > 0; }),
              role: svg.getAttribute('role'),
              aria: svg.getAttribute('aria-label'),
              tagTitle: tag === null ? null : tag.title,
              muted: lane.dataset.muted === 'true',
              laneFits: lane.scrollWidth <= lane.clientWidth,
              labelBoxes: labels.map((el) => ({ overflow: getComputedStyle(el).textOverflow, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, widthPx: el.getBoundingClientRect().width })),
            };
          })()`,
        );
      const laneOf = (name) => drumMetrics(`#timeline-lanes .lane[data-track="label:${name}"]`);

      const near = await laneOf('drums');
      report(
        'drum lane: 3 rows are 3.75rem tall at least, centered marks, overlay is pointer-transparent and hidden from screen readers',
        near !== null &&
          near.rows === '3' &&
          near.minHeightPx >= 3.75 * near.remPx - 0.5 &&
          near.heightPx >= 3.75 * near.remPx - 0.5 &&
          near.labelOffsets.length === 3 &&
          near.labelOffsets.every((offset) => offset <= 1) &&
          near.markOffset !== null &&
          near.markOffset <= 1 &&
          near.overlay === true &&
          near.overlayPointer === 'none' &&
          near.overlayHidden === 'true' &&
          near.bandCoversRow === true,
        JSON.stringify({ near }),
      );

      const wide = await laneOf('wide');
      report(
        'drum lane: a 12-note lane stops at 8 rows, has no overlay, keeps 12 tooltips and the and-more label',
        wide !== null &&
          wide.rows === '8' &&
          wide.overlay === false &&
          wide.bandTitles.length === 12 &&
          wide.bandTitles.every((title) => /^\d+ \S/.test(title)) &&
          typeof wide.aria === 'string' &&
          wide.aria.startsWith('Drums: ') &&
          wide.aria.endsWith(' and 4 more') &&
          wide.heightPx <= 10 * wide.remPx + 2 &&
          wide.heightPx >= 10 * wide.remPx - 2,
        JSON.stringify({ wide }),
      );

      const outside = await laneOf('outside');
      const fraction = await laneOf('frac');
      report(
        'drum lane: a note outside the map is a number, a fraction keeps the pitch drawing',
        outside !== null &&
          JSON.stringify(outside.labels) === JSON.stringify(['52', 'Acoustic Bass Drum']) &&
          JSON.stringify(outside.labelNumbered) === JSON.stringify([true, false]) &&
          JSON.stringify(outside.bandTitles) === JSON.stringify(['52 · not in Roland MT-32 Rhythm', '36 Acoustic Bass Drum']) &&
          fraction !== null &&
          fraction.rows === null &&
          fraction.bandTitles.length === 0 &&
          fraction.overlay === false &&
          fraction.role === null,
        JSON.stringify({ outside, fraction }),
      );

      const unknown = await laneOf('unk');
      report(
        'drum lane: an unknown map draws as today and says so in the tag title',
        unknown !== null &&
          unknown.rows === null &&
          unknown.bandTitles.length === 0 &&
          unknown.overlay === false &&
          unknown.role === null &&
          typeof unknown.tagTitle === 'string' &&
          unknown.tagTitle.endsWith(' · drum map unknown'),
        JSON.stringify({ unknown }),
      );

      const long = await laneOf('long');
      report(
        'drum lane: a long name is cut at 7rem, the full name is in the tooltip',
        long !== null &&
          long.rows === '2' &&
          long.labelBoxes.length === 2 &&
          long.labelBoxes[1].overflow === 'ellipsis' &&
          long.labelBoxes[1].scrollWidth > long.labelBoxes[1].clientWidth &&
          long.labelBoxes[1].widthPx <= 7 * long.remPx + 0.5 &&
          long.laneFits === true &&
          long.labels[1] === LONG_DRUM_NAME.slice(0, 40) &&
          long.bandTitles[1] === `36 ${LONG_DRUM_NAME}` &&
          long.aria.includes(LONG_DRUM_NAME),
        JSON.stringify({ long, expectedName: LONG_DRUM_NAME }),
      );

      // The sweep: the 3-row lane keeps its overlay and the 12-row lane has none, at every size and layout, with nothing cut sideways.
      const startLayoutDrums = await evaluateExpr(cdp, `document.getElementById('workspace').dataset.layout`);
      const sweep = [];
      try {
        for (const [width, height] of [[1024, 768], [1366, 768], [1920, 1080]]) {
          await cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
          await sleep(250);
          for (const layout of ['a', 'b', 'c']) {
            await evaluateExpr(cdp, `(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); })()`);
            await pressKey(cdp, layout);
            await sleep(200);
            const three = await laneOf('drums');
            const twelve = await laneOf('wide');
            const container = await evaluateExpr(
              cdp,
              `(() => { const el = document.getElementById('timeline-lanes'); return { fits: el.scrollWidth <= el.clientWidth, scrolls: el.scrollHeight > el.clientHeight, layout: document.getElementById('workspace').dataset.layout }; })()`,
            );
            sweep.push({
              size: `${width}x${height}`,
              layout: container.layout,
              overlayThree: three !== null && three.overlay === true && three.rows === '3' && three.laneFits === true,
              noOverlayTwelve: twelve !== null && twelve.overlay === false && twelve.rows === '8' && twelve.laneFits === true,
              fits: container.fits,
              scrolls: container.scrolls,
            });
          }
        }
      } finally {
        await cdp('Emulation.clearDeviceMetricsOverride');
        if ((await evaluateExpr(cdp, `document.getElementById('workspace').dataset.layout`)) !== startLayoutDrums) await pressKey(cdp, startLayoutDrums);
      }
      report(
        'drum lane: every size and layout',
        sweep.length === 9 && sweep.every((seen, index) => seen.layout === ['a', 'b', 'c'][index % 3] && seen.overlayThree && seen.noOverlayTwelve && seen.fits),
        JSON.stringify(sweep),
      );

      // A muted lane (written `_drums:`) has no events: the Timeline never queries a muted track, so it is an empty lane
      // and draws as one today, with no rows, no overlay and no tooltip band, while the lane next to it keeps its own.
      await callTool(client, 'set_code', { code: `_drums: note("36 38 42 38").midi('Fake Synth A', { midichannel: 10 })\n${PAD_LINE}`, label: 'probe:midi drum lane muted' });
      await sleep(800);
      const mutedLane = await waitFor(cdp, `(() => { const lane = document.querySelector('#timeline-lanes .lane[data-muted="true"]'); return lane === null ? null : lane.dataset.track; })()`, 6000);
      const muted = mutedLane === null ? null : await drumMetrics(`#timeline-lanes .lane[data-track=${JSON.stringify(mutedLane)}]`);
      const mutedEvents = mutedLane === null ? null : await evaluateExpr(cdp, `document.querySelector('#timeline-lanes .lane[data-muted="true"]').dataset.events`);
      report(
        'drum lane: a muted lane has no events, so it draws as an empty lane with no rows and no overlay',
        muted !== null &&
          muted.muted === true &&
          mutedEvents === '0' &&
          muted.rows === null &&
          muted.overlay === false &&
          muted.bandTitles.length === 0 &&
          muted.role === null,
        JSON.stringify({ mutedLane, mutedEvents, muted }),
      );

      // A right-click on a label's position goes through the overlay: the lane context, and a moment that names the drums.
      // The three drums sound together all the time, so every instant of the lane holds the kick.
      const DRUM_ASK_TEXT = 'drum label moment check';
      await callTool(client, 'set_code', { code: `drums: note("36,38,42").midi('Fake Synth A', { midichannel: 10 })\n${PAD_LINE}`, label: 'probe:midi drum lane ask' });
      await sleep(800);
      await waitFor(cdp, `(() => { const lane = document.querySelector('#timeline-lanes .lane[data-track="label:drums"]'); return lane !== null && lane.querySelectorAll('.event').length > 0 && lane.dataset.drumRows === '3' ? true : null; })()`, 6000);
      const labelSpot = await evaluateExpr(
        cdp,
        `(() => {
          const lane = document.querySelector('#timeline-lanes .lane[data-track="label:drums"]');
          lane.scrollIntoView({ block: 'center' });
          const label = [...lane.querySelectorAll('.drum-row-label')].find((el) => el.textContent === 'Acoustic Bass Drum');
          if (label === undefined) return null;
          const r = label.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        })()`,
      );
      const labelAsk = labelSpot === null ? { open: false, chip: '' } : await askAtCoords(cdp, labelSpot.x, labelSpot.y);
      await cdp('Input.insertText', { text: DRUM_ASK_TEXT });
      await pressKey(cdp, 'Enter');
      await sleep(500);
      const drumReply = await callTool(client, 'get_code', {});
      const DRUM_REQUEST_PREFIX = 'Request from the Moontide page: ';
      const drumRequests = drumReply
        .split('\n')
        .filter((line) => line.startsWith(DRUM_REQUEST_PREFIX))
        .map((line) => {
          try {
            return JSON.parse(line.slice(DRUM_REQUEST_PREFIX.length));
          } catch {
            return null;
          }
        })
        .filter((entry) => entry !== null && entry.text === DRUM_ASK_TEXT);
      const drumRequest = drumRequests.length === 1 ? drumRequests[0] : undefined;
      const drumMoment = drumRequest === undefined ? undefined : drumRequest.moment;
      const kickNotes = drumMoment === undefined ? [] : drumMoment.notes.filter((note) => note.track === 'drums' && note.note === 36 && note.drum === 'Acoustic Bass Drum');
      const padDrumNotes = drumMoment === undefined ? [] : drumMoment.notes.filter((note) => note.track === 'pad' && 'drum' in note);
      report(
        'drum lane: a right-click on a label\'s position gives the lane context and a moment with drum names',
        labelSpot !== null &&
          labelAsk.open === true &&
          labelAsk.chip.startsWith('Lane drums') &&
          drumRequest !== undefined &&
          drumRequest.context.kind === 'lane' &&
          drumRequest.context.track === 'drums' &&
          kickNotes.length > 0 &&
          padDrumNotes.length === 0,
        JSON.stringify({ labelSpot, labelAsk, requests: drumRequests.length, context: drumRequest === undefined ? null : drumRequest.context, kickNotes: kickNotes.length, padDrumNotes: padDrumNotes.length }),
      );
      if (await evaluateExpr(cdp, "!document.getElementById('ask-box').hidden")) await pressKey(cdp, 'Escape');

      // Backstop screenshots for a final look (the directory comes from MOONTIDE_PROBE_SHOTS; nothing is saved without it):
      // a General MIDI pattern on the two lightest track hues, at two sizes in the three layouts.
      if (process.env.MOONTIDE_PROBE_SHOTS) {
        await setScenario({ permission: 'granted', outputs: ['Fake Synth A', 'Fake Synth B', 'Fake Synth C', 'Fake Synth D'] });
        const luminances = await evaluateExpr(
          cdp,
          `(() => {
            const canvas = document.createElement('canvas');
            canvas.width = canvas.height = 1;
            const ctx = canvas.getContext('2d');
            return [1, 2, 3, 4, 5, 6, 7, 8].map((index) => {
              ctx.clearRect(0, 0, 1, 1);
              ctx.fillStyle = '#000';
              ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--track-' + index).trim();
              ctx.fillRect(0, 0, 1, 1);
              const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
              return 0.2126 * r + 0.7152 * g + 0.0722 * b;
            });
          })()`,
        );
        const lightest = luminances.map((value, index) => ({ value, index })).sort((a, b) => b.value - a.value).slice(0, 2).map((entry) => entry.index);
        const shotLines = luminances.map((_, index) =>
          lightest.includes(index) ? `t${index + 1}: note("36 38 42 46 45").midi('Fake Synth B', { midichannel: 10 })` : `t${index + 1}: s("bd").gain(0)`,
        );
        await callTool(client, 'set_code', { code: shotLines.join('\n'), label: 'probe:midi drum lane shots' });
        await sleep(800);
        await openView(2);
        await waitFor(cdp, `document.querySelectorAll('#timeline-lanes .lane[data-drum-rows]').length === 2 ? true : null`, 8000);
        fs.mkdirSync(process.env.MOONTIDE_PROBE_SHOTS, { recursive: true });
        const startLayoutShots = await evaluateExpr(cdp, `document.getElementById('workspace').dataset.layout`);
        const shots = [];
        try {
          for (const [width, height] of [[1366, 768], [1920, 1080]]) {
            await cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
            await sleep(250);
            for (const layout of ['a', 'b', 'c']) {
              await evaluateExpr(cdp, `(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); })()`);
              await pressKey(cdp, layout);
              await sleep(250);
              await evaluateExpr(cdp, `document.querySelector('#timeline-lanes .lane[data-drum-rows]').scrollIntoView({ block: 'start' })`);
              await sleep(100);
              const shot = await cdp('Page.captureScreenshot', { format: 'png' });
              const file = path.join(process.env.MOONTIDE_PROBE_SHOTS, `drum-lane-${width}x${height}-layout-${layout}.png`);
              fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
              shots.push(path.basename(file));
            }
          }
        } finally {
          await cdp('Emulation.clearDeviceMetricsOverride');
          if ((await evaluateExpr(cdp, `document.getElementById('workspace').dataset.layout`)) !== startLayoutShots) await pressKey(cdp, startLayoutShots);
        }
        console.log(`probe:midi drum lane screenshots: ${shots.join(', ')} (lightest hues: track ${lightest.map((index) => index + 1).join(' and ')})`);
      }

      // Back to the rig the next block expects: no models, the one MT-32, the default scenario.
      fs.rmSync(path.join(dataDir, 'models'), { recursive: true, force: true });
      writeRig('mt32');
      await callTool(client, 'get_midi_instruments', {});
      await setScenario({ permission: 'granted' });
      await callTool(client, 'set_code', { code: TAG_CODE, label: 'probe:midi drum lanes done' });
      await sleep(500);
    }

    // --- No notes ---
    // A MIDI track that only sends controls, changes the program or names a silent clock has no strip and is listed in one line at
    // the bottom of the Mixer with its instrument and channel; folding changes the display only, so it still sends what it sent.
    fs.writeFileSync(
      rigFile,
      JSON.stringify({
        instruments: [
          { id: 'synth', model: 'mt32', port: 'Fake Synth A' },
          { id: 'sc55', model: 'sc55', port: 'Fake Synth B' },
        ],
      }),
    );
    await callTool(client, 'get_midi_instruments', {});
    await setScenario({ permission: 'granted' });
    const NO_NOTES_CODE = [
      `pad: note("c3 e3").midi('Fake Synth A', { midichannel: 3 })`,
      `reverb_send: ccn(91).ccv(0.95).midi('Fake Synth B', { midichannel: 15 })`,
      `sweep: ccv(sine.segment(16)).ccn(74).midi('Fake Synth B', { midichannel: 15 })`,
      `clock: silence.midi('Fake Synth A', { midichannel: 2 })`,
      `prog: progNum("<0 5>").midi('Fake Synth A', { midichannel: 4 })`,
      `beat: s("bd*4").gain(0)`,
    ].join('\n');
    const noNotesMark = await evaluateExpr(cdp, 'window.__midiLog.length');
    const noNotesSetAt = Date.now();
    await callTool(client, 'set_code', { code: NO_NOTES_CODE, label: 'probe:midi no notes' });
    await sleep(800);
    await openView(3);
    const noNotesLine = await waitFor(cdp, `(() => { const line = document.getElementById('mixer-nonotes'); return line !== null && !line.hidden ? { text: line.textContent, title: line.title } : null; })()`, 5000);
    const noNotesStrips = await evaluateExpr(cdp, `[...document.querySelectorAll('#mixer-strips .mx-strip[data-track]')].map((strip) => strip.dataset.track)`);
    report(
      'no notes: control-only, program-change and clock tracks have no strip and are listed in one line',
      JSON.stringify(noNotesStrips) === JSON.stringify(['label:pad', 'label:beat']) &&
        noNotesLine !== null &&
        noNotesLine.text === 'No notes: reverb_send (sc55 \u00b7 ch 15), sweep (sc55 \u00b7 ch 15), clock (synth \u00b7 ch 2), prog (synth \u00b7 ch 4)' &&
        noNotesLine.title === MIXER_COPY.noNotesTitle,
      JSON.stringify({ noNotesStrips, noNotesLine }),
    );
    const noNotesSent = await waitFor(
      cdp,
      `(() => {
        const log = window.__midiLog.slice(${noNotesMark});
        const has91 = log.some((e) => e.port === 'Fake Synth B' && e.bytes.length === 3 && e.bytes[0] === 0xbe && e.bytes[1] === 91);
        const has74 = log.some((e) => e.port === 'Fake Synth B' && e.bytes.length === 3 && e.bytes[0] === 0xbe && e.bytes[1] === 74);
        const program = log.some((e) => e.port === 'Fake Synth A' && e.bytes[0] === 0xc3);
        return has91 && has74 && program ? { has91, has74, program } : null;
      })()`,
      Math.max(500, 6000 - (Date.now() - noNotesSetAt)),
    );
    report('no notes: folded tracks still send their controls and program changes', noNotesSent !== null, JSON.stringify(noNotesSent));
    await pressKey(cdp, 'Escape');

    // --- Shared channels and reasons ---
    // Two tracks on one instrument and channel say who they share it with, read one value and are written together in one
    // version. Every cause that turns a MIDI track's controls off says its reason in the real page, with M and S still usable.
    writeRig('mt32');
    await callTool(client, 'get_midi_instruments', {});
    await setScenario({ permission: 'granted' });
    const KICK_LINE = `kick: note("c2*4").midi('Fake Synth A', { midichannel: 10 })`;
    const HAT_LINE = `hat: note("f#2*8").midi('Fake Synth A', { midichannel: 10 })`;
    await callTool(client, 'set_code', { code: `${KICK_LINE}\n${HAT_LINE}`, label: 'probe:midi shared channel' });
    await sleep(800);
    await openView(3);
    const kickStrip = '.mx-strip[data-track="label:kick"][data-midi="true"]';
    const hatStrip = '.mx-strip[data-track="label:hat"][data-midi="true"]';
    const sharedLine = (strip) =>
      evaluateExpr(cdp, `(() => { const line = document.querySelector(${JSON.stringify(`${strip} .mx-shared`)}); return line === null || line.hidden ? null : { text: line.textContent, title: line.title }; })()`);
    const kickShared = await waitFor(cdp, `(() => { const line = document.querySelector(${JSON.stringify(`${kickStrip} .mx-shared`)}); return line !== null && !line.hidden ? line.textContent : null; })()`, 4000);
    const hatShared = await sharedLine(hatStrip);
    report(
      'two tracks on one channel each say who they share it with',
      kickShared === 'Shared with hat' && hatShared !== null && hatShared.text === 'Shared with kick' && hatShared.title === 'Shared with kick',
      JSON.stringify({ kickShared, hatShared }),
    );
    const sharedBefore = await newestVersion();
    await dragSlider(cdp, `${kickStrip} .mx-fader`, 0.3, 0.75, 6);
    await waitFor(cdp, `document.querySelectorAll('.mx-flash').length > 0 ? true : null`, 1500);
    const sharedCode = await codeWhen((code) => (code.match(/volume: \d+/g) ?? []).length >= 2);
    const sharedAfter = await nextVersion(sharedBefore);
    const kickVolume = /^kick:.*volume: (\d+)/m.exec(sharedCode);
    const hatVolume = /^hat:.*volume: (\d+)/m.exec(sharedCode);
    report(
      'a fader gesture on a shared channel writes every track of it in one version',
      kickVolume !== null &&
        hatVolume !== null &&
        kickVolume[1] === hatVolume[1] &&
        sharedAfter.id === sharedBefore.id + 1 &&
        sharedAfter.line.includes(`"mixer: kick volume ${kickVolume[1]}"`),
      JSON.stringify({ code: sharedCode, sharedBefore: sharedBefore.id, sharedAfter }),
    );
    await pressKey(cdp, 'Escape');
    await openView(3);
    await waitFor(cdp, `document.querySelector(${JSON.stringify(`${kickStrip} .mx-midi-chip[data-param="pan"] .mx-chip-body`)}) ? true : null`, 4000);
    await clickElement(cdp, `${kickStrip} .mx-midi-chip[data-param="pan"] .mx-chip-body`);
    const sharedInspector = await waitFor(
      cdp,
      `(() => { const line = document.querySelector('#mixer-inspector .mx-insp-shared'); return line !== null && !line.hidden ? line.textContent : null; })()`,
      3000,
    );
    report(
      'the inspector of a shared channel says so',
      sharedInspector === 'Channel 10 is shared with hat. A change here is written on every one of these tracks.',
      JSON.stringify({ sharedInspector }),
    );
    await clickElement(cdp, '#mixer-inspector .mx-insp-close');
    await pressKey(cdp, 'Escape');

    // (b) Each cause that turns the controls off, read from the pad strip while the Mixer is open.
    const PAD_REASON = `pad: note("c3").midi('Fake Synth A', { midichannel: 3 })`;
    const reasonFacts = (text) =>
      waitFor(
        cdp,
        `(() => {
          const strip = document.querySelector(${JSON.stringify(padStrip)});
          if (strip === null) return null;
          const reason = strip.querySelector('.mx-reason');
          if (reason === null || reason.textContent !== ${JSON.stringify(text)}) return null;
          const fader = strip.querySelector('.mx-fader');
          return {
            text: reason.textContent,
            title: reason.title,
            faderDisabled: fader.disabled,
            readout: strip.querySelector('.mx-readout').textContent,
            mute: strip.querySelector('.mx-mute').disabled,
            solo: strip.querySelector('.mx-solo').disabled,
          };
        })()`,
        5000,
      );
    const reasonOk = (facts, text) => facts !== null && facts.text === text && facts.title === text && facts.faderDisabled === true && facts.readout === '–' && facts.mute === false && facts.solo === false;
    const reasonCase = async (name, text, setup) => {
      await setup();
      await openView(3);
      const facts = await reasonFacts(text);
      report(name, reasonOk(facts, text), JSON.stringify({ text, facts }));
    };
    await reasonCase('the no-instruments.json reason is shown and M and S stay enabled', 'No instruments.json — describe this instrument there to use its controls.', async () => {
      fs.rmSync(rigFile, { force: true });
      await callTool(client, 'set_code', { code: PAD_REASON, label: 'probe:midi reason no file' });
      await sleep(800);
    });
    await reasonCase('the invalid-file reason is shown', "instruments.json is invalid — fix it to use this instrument's controls.", async () => {
      writeRig('mt32');
      await callTool(client, 'set_code', { code: PAD_REASON, label: 'probe:midi reason valid file' });
      await sleep(800);
      fs.writeFileSync(rigFile, JSON.stringify({ instruments: [{ id: 'mt32', model: 'nope', port: 'Fake Synth A' }] }));
      await callTool(client, 'get_midi_instruments', {});
    });
    await reasonCase('the port-not-in-file reason is shown', "Port isn't in instruments.json — add it there to use its controls.", async () => {
      writeRig('mt32');
      await callTool(client, 'set_code', { code: PAD_REASON, label: 'probe:midi reason valid file again' });
      await sleep(800);
      writeRig('mt32', 'Fake Synth B');
      await callTool(client, 'get_midi_instruments', {});
    });
    await reasonCase('the options-not-plain reason is shown', "Options aren't plain values — the mixer can't edit this instrument's controls.", async () => {
      fs.rmSync(rigFile, { force: true });
      await callTool(client, 'set_code', { code: `const opts = { midichannel: 3 }\npad: note("c3").midi('Fake Synth A', opts)`, label: 'probe:midi reason options' });
      await sleep(800);
    });
    await reasonCase('the port-not-plain reason is shown', "Port or channel isn't plain — the mixer can't edit this instrument's controls.", async () => {
      await callTool(client, 'set_code', { code: `let port = 'Fake Synth A'\npad: note("c3").midi(port, { midichannel: 3 })`, label: 'probe:midi reason port' });
      await sleep(800);
    });
    await pressKey(cdp, 'Escape');
    writeRig('mt32');
    await callTool(client, 'get_midi_instruments', {});

    // --- Tag geometry ---
    // The tag line makes a MIDI lane one line taller and nothing else in the Timeline moves; a long instrument id is cut in its
    // name part and never in its channel; typing in a MIDI number field never switches the layout or the view; no new MIDI
    // element takes a reserved color.
    writeRig('mt32');
    await callTool(client, 'get_midi_instruments', {});
    const GEOMETRY_CODE = `${TAG_PAD}\nhat: note("f#2*8").midi('Fake Synth A', { midichannel: 3 })\nbeat: s("bd*4").gain(0)`;
    await callTool(client, 'set_code', { code: GEOMETRY_CODE, label: 'probe:midi tag geometry' });
    await sleep(800);
    const layoutFacts = () =>
      evaluateExpr(
        cdp,
        `(() => {
          const rect = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width }; };
          const lanes = [...document.querySelectorAll('#timeline-lanes .lane')];
          const pad = document.querySelector('#timeline-lanes .lane[data-track="label:pad"]');
          const channel = pad === null ? null : pad.querySelector('.lane-tag-channel');
          const playhead = document.getElementById('timeline-playhead');
          return {
            layout: document.getElementById('workspace').dataset.layout,
            view: document.getElementById('workspace').dataset.view,
            lanes: lanes.length,
            svgs: lanes.map((lane) => rect(lane.querySelector('.lane-events'))),
            gutter: pad === null ? null : rect(pad.querySelector('.lane-gutter')),
            channel: channel === null ? null : rect(channel),
            lastLaneBottom: lanes.length === 0 ? null : rect(lanes[lanes.length - 1]).bottom,
            lanesBottom: rect(document.getElementById('timeline-lanes')).bottom,
            playheadBottom: playhead === null ? null : rect(playhead).bottom,
          };
        })()`,
      );
    await openView(2);
    const geometryReady = await waitFor(cdp, `document.querySelectorAll('#timeline-lanes .lane').length === 3 ? true : null`, 8000);
    const layoutResults = [];
    for (const key of ['a', 'b', 'c']) {
      await evaluateExpr(cdp, `(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); })()`);
      await pressKey(cdp, key);
      await waitFor(cdp, `document.getElementById('workspace').dataset.layout !== undefined && document.querySelectorAll('#timeline-lanes .lane').length === 3 ? true : null`, 4000);
      await sleep(400);
      const facts = await layoutFacts();
      const left = facts.svgs.length > 0 ? facts.svgs[0].left : null;
      const width = facts.svgs.length > 0 ? facts.svgs[0].width : null;
      layoutResults.push({
        key,
        view: facts.view,
        lanes: facts.lanes,
        aligned: facts.svgs.length === 3 && facts.svgs.every((box) => Math.abs(box.left - left) <= 1 && Math.abs(box.width - width) <= 1),
        channelInside: facts.channel !== null && facts.gutter !== null && facts.channel.width > 0 && facts.channel.right <= facts.gutter.right + 0.5,
        // The lanes scroll in a short strip, so the playhead is measured against the bottom of the lanes area (it spans the whole body).
        playheadCovers: facts.playheadBottom !== null && facts.lanesBottom !== null && facts.playheadBottom >= Math.min(facts.lanesBottom, facts.lastLaneBottom) - 1,
        box: { svgLeft: left, svgWidth: width, channelRight: facts.channel === null ? null : facts.channel.right, gutterRight: facts.gutter === null ? null : facts.gutter.right, playheadBottom: facts.playheadBottom, lastLaneBottom: facts.lastLaneBottom, lanesBottom: facts.lanesBottom },
      });
    }
    await evaluateExpr(cdp, `(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); })()`);
    await pressKey(cdp, 'a');
    report(
      'a MIDI lane keeps every lane, ruler column and playhead aligned in layouts a, b and c',
      geometryReady === true && layoutResults.length === 3 && layoutResults.every((result) => result.view === 'timeline' && result.aligned && result.channelInside && result.playheadCovers),
      JSON.stringify(layoutResults),
    );

    // A 32-character id: the name part is cut and the channel part stays whole, in the lane and in the strip.
    const LONG_ID = 'synth-with-a-very-long-id-number';
    writeRig(LONG_ID);
    await callTool(client, 'get_midi_instruments', {});
    const tagFits = (selector) =>
      evaluateExpr(
        cdp,
        `(() => {
          const tag = document.querySelector(${JSON.stringify(selector)});
          if (tag === null) return null;
          const parts = [...tag.children];
          const name = parts.find((part) => part.className.endsWith('-name'));
          const channel = parts.find((part) => part.className.endsWith('-channel'));
          const box = tag.getBoundingClientRect();
          const channelBox = channel.getBoundingClientRect();
          return {
            cut: name.scrollWidth > name.clientWidth,
            channelText: channel.textContent,
            channelInside: channelBox.width > 0 && channelBox.left >= box.left - 0.5 && channelBox.right <= box.right + 0.5,
            titleHasId: tag.title.includes(${JSON.stringify(LONG_ID)}),
          };
        })()`,
      );
    await waitFor(cdp, `(() => { const tag = document.querySelector('#timeline-lanes .lane[data-track="label:pad"] .lane-tag-name'); return tag !== null && tag.textContent === ${JSON.stringify(LONG_ID)} ? true : null; })()`, 3000);
    const longLane = await tagFits('#timeline-lanes .lane[data-track="label:pad"] .lane-tag');
    await openView(3);
    await waitFor(cdp, `(() => { const tag = document.querySelector('.mx-strip[data-track="label:pad"] .mx-tag-name'); return tag !== null && tag.textContent === ${JSON.stringify(LONG_ID)} ? true : null; })()`, 3000);
    const longStrip = await tagFits('.mx-strip[data-track="label:pad"] .mx-tag');
    const longOk = (facts) => facts !== null && facts.cut === true && facts.channelText === ' · ch 3' && facts.channelInside === true && facts.titleHasId === true;
    report('a long instrument id keeps the channel part of the tag whole', longOk(longLane) && longOk(longStrip), JSON.stringify({ longLane, longStrip }));

    // Typing in a MIDI number field is typing: no key switches the layout or the view.
    const padStripSelector = '.mx-strip[data-track="label:pad"][data-midi="true"]';
    await clickElement(cdp, `${padStripSelector} .mx-midi-chip[data-param="pan"] .mx-chip-body`);
    const typingRow = '#mixer-inspector .mx-row[data-param="pan"]';
    await waitFor(cdp, `document.querySelector(${JSON.stringify(`${typingRow} input[type="number"]`)}) ? true : null`, 3000);
    const beforeTyping = await evaluateExpr(cdp, `({ layout: document.getElementById('workspace').dataset.layout, view: document.getElementById('workspace').dataset.view })`);
    await clickElement(cdp, `${typingRow} input[type="number"]`);
    await pressKey(cdp, 'a');
    await pressKey(cdp, '3');
    const afterTyping = await evaluateExpr(
      cdp,
      `(() => {
        const field = document.querySelector(${JSON.stringify(`${typingRow} input[type="number"]`)});
        const facts = { layout: document.getElementById('workspace').dataset.layout, view: document.getElementById('workspace').dataset.view, focused: document.activeElement === field };
        // Put the typed text back without a change event, so nothing is written to the code.
        field.value = field.defaultValue;
        return facts;
      })()`,
    );
    report(
      'typing in a MIDI number field never switches the layout or the view',
      beforeTyping.view === 'mixer' && afterTyping.view === beforeTyping.view && afterTyping.layout === beforeTyping.layout && afterTyping.focused === true,
      JSON.stringify({ beforeTyping, afterTyping }),
    );

    // No new MIDI element takes a reserved color: compare each one's computed colors with the three reserved tokens.
    const colorFacts = await evaluateExpr(
      cdp,
      `(() => {
        const computed = (token) => {
          const probe = document.createElement('span');
          probe.style.color = 'var(' + token + ')';
          document.body.appendChild(probe);
          const value = getComputedStyle(probe).color;
          probe.remove();
          return value;
        };
        const reserved = new Set(['--accent', '--accent-2', '--destructive'].map(computed));
        const selectors = ['.lane-tag', '.lane-tag-name', '.lane-tag-channel', '.mx-tag', '.mx-tag-name', '.mx-tag-channel', '.mx-midi-chips', '.mx-midi-chip', '.mx-midi-note', '.mx-shared', '.mx-insp-line', '.mx-insp-shared', '.mx-sweep'];
        const found = [];
        const offenders = [];
        for (const selector of selectors) {
          for (const el of document.querySelectorAll(selector)) {
            found.push(selector);
            const style = getComputedStyle(el);
            for (const property of ['color', 'backgroundColor', 'borderTopColor', 'borderBottomColor']) {
              if (reserved.has(style[property])) offenders.push(selector + ' ' + property);
            }
          }
        }
        return { reserved: [...reserved], checked: found.length, kinds: [...new Set(found)], offenders };
      })()`,
    );
    report(
      'no new MIDI element takes a reserved color',
      colorFacts.checked >= 6 && colorFacts.offenders.length === 0 && ['.mx-tag', '.mx-tag-name', '.mx-shared', '.lane-tag'].every((kind) => colorFacts.kinds.includes(kind)),
      JSON.stringify(colorFacts),
    );
    await evaluateExpr(cdp, `(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); })()`);
    await pressKey(cdp, 'Escape');
    await pressKey(cdp, 'Escape');
    await pressKey(cdp, 'a');
    writeRig('mt32');
    await callTool(client, 'get_midi_instruments', {});

    // --- Mute stops notes ---
    // Strudel times each note's end when the note starts, so a long note rings on after its track is muted: the page
    // silences the channel itself (sustain off, then All Notes Off, with no timestamp) and sends the same pair again
    // after SILENCE_REPEAT_MS to catch notes Strudel had already queued.
    writeRig('mt32');
    await callTool(client, 'get_midi_instruments', {});
    await setScenario({ permission: 'granted' });
    /** True once a note-on on the 0-based status byte `status` was logged after log position `mark` (reads only the tail). */
    const noteOnAfter = (mark, status, data1 = null, timeoutMs = 20000) =>
      waitFor(
        cdp,
        `window.__midiLog.slice(${mark}).some((entry) => entry.bytes.length === 3 && entry.bytes[0] === ${status} && (${data1} === null || entry.bytes[1] === ${data1}) && entry.bytes[2] > 0) ? true : null`,
        timeoutMs,
      );
    /** The raw (no timestamp) entries on one port after log position `mark`. */
    const entriesAfter = (mark) => evaluateExpr(cdp, `window.__midiLog.slice(${mark})`);
    const rawAfter = async (mark, port) => (await entriesAfter(mark)).filter((entry) => entry.port === port && entry.ts === null);
    /** Waits until at least `count` raw entries with the second byte `data1` arrived on a port after `mark`. */
    const waitRaw = async (mark, port, data1, count, timeoutMs = 8000) => {
      const deadline = Date.now() + timeoutMs;
      let entries = await rawAfter(mark, port);
      while (entries.filter((entry) => entry.bytes[1] === data1).length < count && Date.now() < deadline) {
        await sleep(200);
        entries = await rawAfter(mark, port);
      }
      return entries;
    };
    const MUTE_PAD = `pad: note("c3").slow(4).midi('Fake Synth A', { midichannel: 3 })`;
    const startPad = await logLength();
    await callTool(client, 'set_code', { code: MUTE_PAD, label: 'probe:midi mute stops notes' });
    const padSounding = await noteOnAfter(startPad, 0x92);
    await sleep(500);
    await openView(3);
    const padMute = '.mx-strip[data-track="label:pad"] .mx-mute';
    const padMuteThere = await waitFor(cdp, `document.querySelector(${JSON.stringify(padMute)}) ? true : null`, 3000);
    const muteMark = await logLength();
    await clickElement(cdp, padMute);
    const afterMute = await waitRaw(muteMark, 'Fake Synth A', 123, 2);
    const pairs = [];
    for (let index = 0; index + 1 < afterMute.length; index += 1) {
      const [first, second] = [afterMute[index], afterMute[index + 1]];
      if (first.bytes.join() === '178,64,0' && second.bytes.join() === '178,123,0') pairs.push({ first, second });
    }
    const wrongChannel = (await entriesAfter(muteMark)).filter((entry) => entry.bytes[1] === 123 && entry.bytes[0] !== 0xb2);
    report(
      'muting the only MIDI track on a channel silences that channel at once, and again after the lookahead',
      padSounding === true && padMuteThere === true && pairs.length >= 2 && pairs[1].first.t - pairs[0].first.t >= 0.8 * SILENCE_REPEAT_MS && wrongChannel.length === 0,
      JSON.stringify({ padSounding, padMuteThere, pairs: pairs.length, gap: pairs.length >= 2 ? pairs[1].first.t - pairs[0].first.t : null, wrongChannel: wrongChannel.length }),
    );
    await pressKey(cdp, 'Escape');

    // --- Stop rules ---
    // A channel another track still plays only loses the muted track's own notes; a removal by Claude and a solo on
    // another track silence the channel of the track that stopped.
    const rawBytes = (entries, bytes) => entries.filter((entry) => entry.bytes.join() === bytes.join());
    // (a) Two tracks share channel 10: muting kick ends kick's note (note-off 36, twice) and leaves the channel alone.
    const SHARED_CODE = `kick: note("c2").slow(2).midi('Fake Synth A', { midichannel: 10 })\nhat: note("f#2*8").midi('Fake Synth A', { midichannel: 10 })`;
    const sharedStart = await logLength();
    await callTool(client, 'set_code', { code: SHARED_CODE, label: 'probe:midi shared channel stop' });
    const kickSounding = await noteOnAfter(sharedStart, 0x99, 36);
    await openView(3);
    const kickMute = '.mx-strip[data-track="label:kick"] .mx-mute';
    const kickMuteThere = await waitFor(cdp, `document.querySelector(${JSON.stringify(kickMute)}) ? true : null`, 3000);
    const sharedMark = await logLength();
    await clickElement(cdp, kickMute);
    const sharedRaw = await waitRaw(sharedMark, 'Fake Synth A', 36, 2);
    await sleep(500);
    const sharedAll = await entriesAfter(sharedMark);
    const hatAfter = sharedAll.filter((entry) => entry.bytes[0] === 0x99 && entry.bytes.length === 3 && entry.bytes[1] === 42);
    const wholeChannel = sharedAll.filter((entry) => entry.bytes[0] === 0xb9 && (entry.bytes[1] === 123 || entry.bytes[1] === 64));
    report(
      'muting one of two tracks on a channel ends only its own notes',
      kickSounding === true && kickMuteThere === true && rawBytes(sharedRaw, [0x89, 36, 0]).length >= 2 && wholeChannel.length === 0 && hatAfter.length >= 1,
      JSON.stringify({ kickSounding, kickMuteThere, noteOffs: rawBytes(sharedRaw, [0x89, 36, 0]).length, wholeChannel: wholeChannel.length, hatAfter: hatAfter.length }),
    );
    // (b) Claude removes a MIDI track: its channel is silenced, the other track's channel is not.
    const TWO_CODE = `pad: note("c3").slow(4).midi('Fake Synth A', { midichannel: 3 })\nlead: note("e3*4").midi('Fake Synth A', { midichannel: 4 })`;
    const removalStart = await logLength();
    await callTool(client, 'set_code', { code: TWO_CODE, label: 'probe:midi removal stop pad and lead' });
    const removalSounding = await noteOnAfter(removalStart, 0x92);
    const removalMark = await logLength();
    await callTool(client, 'set_code', { code: `lead: note("e3*4").midi('Fake Synth A', { midichannel: 4 })`, label: 'probe:midi removal stop lead only' });
    const removalRaw = await waitRaw(removalMark, 'Fake Synth A', 123, 1);
    await sleep(500);
    const removalAll = await entriesAfter(removalMark);
    const removalPair = removalRaw.findIndex((entry, index) => entry.bytes.join() === '178,64,0' && removalRaw[index + 1] !== undefined && removalRaw[index + 1].bytes.join() === '178,123,0');
    report(
      'Claude removing a MIDI track silences its channel',
      removalSounding === true && removalPair >= 0 && removalAll.filter((entry) => entry.bytes[1] === 123 && entry.bytes[0] === 0xb3).length === 0,
      JSON.stringify({ removalSounding, removalPair, otherChannel: removalAll.filter((entry) => entry.bytes[1] === 123 && entry.bytes[0] === 0xb3).length }),
    );
    // (c) A solo on another track silences a MIDI track at once.
    const soloStart = await logLength();
    await callTool(client, 'set_code', { code: TWO_CODE, label: 'probe:midi solo stop pad and lead' });
    const soloSounding = await noteOnAfter(soloStart, 0x92);
    await openView(3);
    const leadSolo = '.mx-strip[data-track="label:lead"] .mx-solo';
    const leadSoloThere = await waitFor(cdp, `document.querySelector(${JSON.stringify(leadSolo)}) ? true : null`, 3000);
    const soloMark = await logLength();
    await clickElement(cdp, leadSolo);
    const soloRaw = await waitRaw(soloMark, 'Fake Synth A', 123, 1);
    report(
      'a solo on another track silences a MIDI track at once',
      soloSounding === true && leadSoloThere === true && rawBytes(soloRaw, [0xb2, 123, 0]).length >= 1 && rawBytes(soloRaw, [0xb3, 123, 0]).length === 0,
      JSON.stringify({ soloSounding, leadSoloThere, silences: rawBytes(soloRaw, [0xb2, 123, 0]).length }),
    );
    await pressKey(cdp, 'Escape');


    // --- MIDI clock ---
    // An instrument the rig file marks clock: true, named by a silent track, gets one Start 0.5 ms before its first
    // tick and ticks that follow the tempo, also across a tempo change; an instrument that does not ask gets none.
    // The log's ts is the timestamp the page requested, so these checks measure the clock's own scheduling (arrival
    // jitter needs a loopback and stays a bench item).
    fs.writeFileSync(
      rigFile,
      JSON.stringify({
        instruments: [
          { id: 'seq', model: 'mt32', port: 'Fake Synth A', clock: true },
          { id: 'sc55', model: 'sc55', port: 'Fake Synth B' },
        ],
      }),
    );
    await setScenario({ permission: 'granted' });
    await sleep(1500);
    const clockCode = (bpm) => `setcpm(${bpm}/4)\n$: silence.midi('Fake Synth A', { midichannel: 2 })\n$: note("c3 e3").midi('Fake Synth B', { midichannel: 1 })`;
    const intervalsOf = (entries) => {
      const stamps = entries.filter((entry) => entry.ts !== null).map((entry) => entry.ts).sort((a, b) => a - b);
      return stamps.slice(1).map((stamp, index) => stamp - stamps[index]);
    };
    const meanOf = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
    const sdOf = (values) => {
      const mean = meanOf(values);
      return Math.sqrt(meanOf(values.map((value) => (value - mean) ** 2)));
    };
    // The popover rows of the instruments, read the way the user reads them: the row texts, with the popover
    // opened for the read when it was closed, and the indicator text beside them.
    const clockPopover = () =>
      evaluateExpr(
        cdp,
        `(() => {
          const info = document.getElementById('midi-info');
          const help = document.getElementById('midi-help');
          const wasHidden = help.hidden;
          if (wasHidden) info.click();
          const result = {
            rows: Array.from(help.querySelectorAll('li')).map((li) => li.textContent),
            paragraphs: Array.from(help.querySelectorAll('p')).map((p) => ({ text: p.textContent, outputs: p.classList.contains('midi-outputs') })),
            indicator: document.getElementById('midi-state-text').textContent,
            attention: document.getElementById('midi-state').dataset.attention === 'true',
          };
          if (wasHidden) info.click();
          return result;
        })()`,
      );
    const rowOf = (popover, id) => popover.rows.find((row) => row.startsWith(`${id} \u00b7 `)) ?? '';
    const clockMark = (await midiLog()).length;
    await callTool(client, 'set_code', { code: clockCode(100), label: 'probe:midi clock 100 bpm' });
    await sleep(3000);
    const fieldPin = await evaluateExpr(
      cdp,
      `(() => { const s = document.getElementById('repl').editor.repl.scheduler; return { missing: ${JSON.stringify(CYCLIST_FIELDS)}.filter((field) => !(field in s)), now: typeof s.now }; })()`,
    );
    report('the clock reads only Cyclist fields the pinned Strudel has', fieldPin.missing.length === 0 && fieldPin.now === 'function', JSON.stringify(fieldPin));
    const clockLog = (await midiLog()).slice(clockMark);
    const clockA = portEntries(clockLog, 'Fake Synth A');
    const clockB = portEntries(clockLog, 'Fake Synth B');
    const startsA = clockA.filter((entry) => same(entry.bytes, [0xfa]));
    const ticksA = clockA.filter((entry) => same(entry.bytes, [0xf8]));
    const firstStartAt = clockA.findIndex((entry) => same(entry.bytes, [0xfa]));
    const firstTickAfterStart = firstStartAt === -1 ? undefined : clockA.slice(firstStartAt + 1).find((entry) => same(entry.bytes, [0xf8]));
    const leadMs = firstTickAfterStart === undefined || firstTickAfterStart.ts === null || startsA[0].ts === null ? null : firstTickAfterStart.ts - startsA[0].ts;
    const gaps100 = intervalsOf(ticksA);
    const nominal100 = 1000 / ((100 / 4 / 60) * CLOCK_TICKS_PER_CYCLE);
    report(
      'a clock instrument gets one Start 0.5 ms before its first tick, then ticks 25 ms apart',
      startsA.length === 1 && leadMs !== null && Math.abs(leadMs - CLOCK_START_LEAD_MS) < 0.001 && gaps100.length > 50 && Math.abs(meanOf(gaps100) - nominal100) < 1 && sdOf(gaps100) < 0.5,
      JSON.stringify({ starts: startsA.length, leadMs, nominalMs: nominal100, ticks: ticksA.length, meanMs: gaps100.length ? meanOf(gaps100) : null, sdMs: gaps100.length ? sdOf(gaps100) : null }),
    );
    report(
      'a port whose instrument does not follow the clock gets no tick',
      clockB.filter((entry) => same(entry.bytes, [0xf8])).length === 0,
      JSON.stringify({ ticksOnB: clockB.filter((entry) => same(entry.bytes, [0xf8])).length }),
    );
    // The popover says so: the clock instrument's row reads clock running once its Start has gone out, and the
    // instrument that does not follow the clock has no clock part. The indicator keeps its plain text.
    await waitFor(cdp, `(() => { const li = Array.from(document.querySelectorAll('#midi-help li')).find((item) => item.textContent.startsWith('seq')); return li && /clock running/.test(li.textContent) ? true : null; })()`, 5000);
    const runningPopover = await clockPopover();
    const runningSeqRow = rowOf(runningPopover, 'seq');
    const runningScRow = rowOf(runningPopover, 'sc55');
    report(
      'the popover row of a clock instrument says clock running',
      /^seq \u00b7 Fake Synth A \u00b7 connected, clock running/.test(runningSeqRow) && runningScRow.startsWith('sc55 \u00b7 Fake Synth B \u00b7 connected') && !runningScRow.includes('clock') && runningPopover.indicator === 'MIDI: 2 instruments connected',
      JSON.stringify({ seq: runningSeqRow, sc55: runningScRow, indicator: runningPopover.indicator }),
    );
    const runningNote = runningPopover.paragraphs.filter((p) => p.text === 'Moontide sends the MIDI clock, Start and Stop to the instruments marked clock.');
    report(
      'the muted clock line shows once while a clock runs, after the rows and before the closing paragraph',
      runningNote.length === 1 && runningNote[0].outputs === true && runningPopover.paragraphs.at(-1).text !== runningNote[0].text && runningPopover.paragraphs.indexOf(runningNote[0]) === runningPopover.paragraphs.length - 2,
      JSON.stringify({ lines: runningNote.length, outputsStyle: runningNote[0]?.outputs ?? null, paragraphs: runningPopover.paragraphs.map((p) => p.text.slice(0, 30)) }),
    );

    const tempoMark = (await midiLog()).length;
    await callTool(client, 'set_code', { code: clockCode(140), label: 'probe:midi clock 140 bpm' });
    await sleep(3000);
    const tempoA = portEntries((await midiLog()).slice(clockMark), 'Fake Synth A');
    const tempoTicks = tempoA.filter((entry) => same(entry.bytes, [0xf8]));
    const gapsAcross = intervalsOf(tempoTicks);
    const gapsAfter = gapsAcross.slice(-40);
    const nominal140 = 1000 / ((140 / 4 / 60) * CLOCK_TICKS_PER_CYCLE);
    report(
      'the clock follows a tempo change with no hole',
      gapsAcross.length > 100 && Math.max(...gapsAcross) <= 25.3 && Math.abs(meanOf(gapsAfter) - nominal140) < 1 && tempoA.filter((entry) => same(entry.bytes, [0xfa])).length === 1,
      JSON.stringify({ tempoMark, nominalMs: nominal140, maxGapMs: Math.max(...gapsAcross), meanAfterMs: meanOf(gapsAfter), starts: tempoA.filter((entry) => same(entry.bytes, [0xfa])).length }),
    );

    // --- MIDI clock Start and Stop ---
    // Stop sends exactly one Stop (0xFC, at once, no timestamp) to a running clock port and no tick follows it; Play
    // again begins with one fresh Start on a cycle boundary; code that stops naming the instrument stops its clock.
    const clockEntriesOf = (from, bytes) => portEntries(from, 'Fake Synth A').filter((entry) => same(entry.bytes, bytes));
    const clockStopMark = (await midiLog()).length;
    await callTool(client, 'stop', {});
    await sleep(1000);
    const stoppedPopover = await clockPopover();
    report(
      'Stop takes the clock part away',
      rowOf(stoppedPopover, 'seq').startsWith('seq \u00b7 Fake Synth A \u00b7 connected') && !rowOf(stoppedPopover, 'seq').includes('clock') && !stoppedPopover.paragraphs.some((p) => p.text.startsWith('Moontide sends the MIDI clock')),
      JSON.stringify({ seq: rowOf(stoppedPopover, 'seq'), paragraphs: stoppedPopover.paragraphs.length }),
    );
    const clockAfterStop = (await midiLog()).slice(clockStopMark);
    const clockStops = clockEntriesOf(clockAfterStop, [0xfc]);
    const clockStopT = clockStops.length === 1 ? clockStops[0].t : null;
    const clockTicksAfterStop = clockStopT === null ? [] : clockEntriesOf(clockAfterStop, [0xf8]).filter((entry) => entry.t > clockStopT);
    report(
      'Stop sends exactly one Stop to a running clock port',
      clockStops.length === 1 && clockStops[0].ts === null && clockTicksAfterStop.length === 0,
      JSON.stringify({ stops: clockStops.length, stopTs: clockStops[0]?.ts ?? null, ticksAfterStop: clockTicksAfterStop.length }),
    );
    const clockPlayMark = (await midiLog()).length;
    await callTool(client, 'set_code', { code: clockCode(140), label: 'probe:midi clock play again' });
    await sleep(3500);
    const clockAgainA = portEntries((await midiLog()).slice(clockPlayMark), 'Fake Synth A');
    const clockAgainStarts = clockAgainA.filter((entry) => same(entry.bytes, [0xfa]));
    const clockAgainStartAt = clockAgainA.findIndex((entry) => same(entry.bytes, [0xfa]));
    const clockAgainTicks = clockAgainStartAt === -1 ? [] : clockAgainA.slice(clockAgainStartAt + 1).filter((entry) => same(entry.bytes, [0xf8]));
    const clockAgainLead = clockAgainTicks.length === 0 || clockAgainTicks[0].ts === null || clockAgainStarts[0].ts === null ? null : clockAgainTicks[0].ts - clockAgainStarts[0].ts;
    const clockAgainGaps = intervalsOf(clockAgainTicks);
    report(
      'Play after Stop begins with one fresh Start 0.5 ms before its first tick',
      clockAgainStarts.length === 1 && clockAgainLead !== null && Math.abs(clockAgainLead - CLOCK_START_LEAD_MS) < 0.001 && clockAgainGaps.length > 20 && Math.abs(meanOf(clockAgainGaps) - nominal140) < 1,
      JSON.stringify({ starts: clockAgainStarts.length, leadMs: clockAgainLead, ticks: clockAgainTicks.length, meanMs: clockAgainGaps.length ? meanOf(clockAgainGaps) : null, nominalMs: nominal140 }),
    );
    const clockLeaveMark = (await midiLog()).length;
    await callTool(client, 'set_code', { code: `setcpm(140/4)\n$: note("c3 e3").midi('Fake Synth B', { midichannel: 1 })`, label: 'probe:midi clock leave' });
    await sleep(1500);
    const clockLeaveLog = (await midiLog()).slice(clockLeaveMark);
    const clockLeaveStops = clockEntriesOf(clockLeaveLog, [0xfc]);
    const clockLeaveT = clockLeaveStops.length === 1 ? clockLeaveStops[0].t : null;
    const clockTicksAfterLeave = clockLeaveT === null ? [] : clockEntriesOf(clockLeaveLog, [0xf8]).filter((entry) => entry.t > clockLeaveT);
    report(
      'code that stops naming a clock instrument stops its clock at once',
      clockLeaveStops.length === 1 && clockLeaveStops[0].ts === null && clockTicksAfterLeave.length === 0,
      JSON.stringify({ stops: clockLeaveStops.length, stopTs: clockLeaveStops[0]?.ts ?? null, ticksAfterStop: clockTicksAfterLeave.length }),
    );

    // A note track that joins mid-play on a clock instrument: its notes wait for its Start (on the next cycle boundary),
    // so its first note goes out with the clock. The hold reads the note's own timestamp: a stamped note-on
    // passes from CLOCK_STAMPED_NOTE_SLACK_MS before the Start's timestamp, one without a timestamp from
    // CLOCK_NOTE_LEAD_MS before it.
    const joinBase = `setcpm(100/4)\n$: note("c3 e3").midi('Fake Synth B', { midichannel: 1 })`;
    await callTool(client, 'set_code', { code: joinBase, label: 'probe:midi clock join base' });
    await sleep(2000);
    const clockJoinMark = (await midiLog()).length;
    // A sampler in the page records each distinct text of the seq row (and the indicator beside it) every 10 ms while the
    // popover stays open: the waiting state lasts until the next cycle boundary, far longer than the sampling step.
    await evaluateExpr(
      cdp,
      `(() => {
        const info = document.getElementById('midi-info');
        const help = document.getElementById('midi-help');
        if (help.hidden) info.click();
        window.__clockSamples = [];
        const read = () => {
          const li = Array.from(help.querySelectorAll('li')).find((item) => item.textContent.startsWith('seq'));
          const sample = { row: li ? li.textContent : null, indicator: document.getElementById('midi-state-text').textContent };
          const last = window.__clockSamples.at(-1);
          if (!last || last.row !== sample.row || last.indicator !== sample.indicator) window.__clockSamples.push(sample);
        };
        read();
        window.__clockSampler = setInterval(read, 10);
        return true;
      })()`,
    );
    await callTool(client, 'set_code', { code: `${joinBase}\n$: note("c3 e3 g3 c4").midi('Fake Synth A', { midichannel: 2 })`, label: 'probe:midi clock join' });
    await sleep(4000);
    const joinSamples = await evaluateExpr(cdp, `(() => { clearInterval(window.__clockSampler); const help = document.getElementById('midi-help'); const samples = window.__clockSamples; if (!help.hidden) document.getElementById('midi-info').click(); return samples; })()`);
    const joinRows = joinSamples.map((sample) => sample.row ?? '');
    const waitingAt = joinRows.findIndex((row) => row.includes('clock starts on next cycle'));
    const runningAt = joinRows.findIndex((row, index) => index > waitingAt && row.includes('clock running'));
    report(
      'a clock instrument that joins mid-play reads clock starts on next cycle until its Start',
      waitingAt !== -1 && runningAt > waitingAt && /^seq \u00b7 Fake Synth A \u00b7 connected, clock starts on next cycle/.test(joinRows[waitingAt]),
      JSON.stringify({ distinctTexts: joinRows, waitingAt, runningAt }),
    );
    const clockPartIndicators = new Set(joinSamples.filter((sample) => /clock (running|starts)/.test(sample.row ?? '')).map((sample) => sample.indicator));
    report(
      'the indicator text does not change with the clock state',
      waitingAt !== -1 && runningAt > waitingAt && clockPartIndicators.size === 1 && clockPartIndicators.has('MIDI: 2 instruments connected'),
      JSON.stringify({ indicatorsWhileAClockPartShows: Array.from(clockPartIndicators) }),
    );
    const clockJoinA = portEntries((await midiLog()).slice(clockJoinMark), 'Fake Synth A');
    const clockJoinStarts = clockJoinA.filter((entry) => same(entry.bytes, [0xfa]));
    const clockJoinNotes = clockJoinA.filter((entry) => entry.bytes.length === 3 && entry.bytes[0] >= 0x90 && entry.bytes[0] <= 0x9f && entry.bytes[2] > 0);
    // A note is early when it sounds before its hold ends: a stamped note-on sounds at its own timestamp and passes from
    // CLOCK_STAMPED_NOTE_SLACK_MS before the Start; an unstamped one sounds when it arrives and passes from
    // CLOCK_NOTE_LEAD_MS before it. The downbeat note goes out with the Start: its timestamp is the Start's first tick.
    const clockJoinStart = clockJoinStarts.length === 1 && clockJoinStarts[0].ts !== null ? clockJoinStarts[0] : null;
    const clockJoinEarly =
      clockJoinStart === null
        ? null
        : clockJoinNotes.filter((entry) =>
            typeof entry.ts === 'number' ? entry.ts < clockJoinStart.ts - CLOCK_STAMPED_NOTE_SLACK_MS : entry.t < clockJoinStart.ts - CLOCK_NOTE_LEAD_MS - 1,
          );
    const clockJoinDownbeat =
      clockJoinStart !== null && clockJoinNotes.length > 0 && typeof clockJoinNotes[0].ts === 'number' ? clockJoinNotes[0].ts - (clockJoinStart.ts + CLOCK_START_LEAD_MS) : null;
    report(
      'a note track that joins mid-play on a clock instrument starts with its Start',
      clockJoinStarts.length === 1 && clockJoinNotes.length >= 1 && clockJoinEarly !== null && clockJoinEarly.length === 0 && clockJoinDownbeat !== null && Math.abs(clockJoinDownbeat) <= 2,
      JSON.stringify({
        starts: clockJoinStarts.length,
        noteOns: clockJoinNotes.length,
        noteOnsBeforeTheHold: clockJoinEarly === null ? null : clockJoinEarly.length,
        downbeatMinusFirstTickMs: clockJoinDownbeat,
        stampedNoteOns: clockJoinNotes.filter((entry) => typeof entry.ts === 'number').length,
        leadMs: CLOCK_NOTE_LEAD_MS,
        slackMs: CLOCK_STAMPED_NOTE_SLACK_MS,
      }),
    );

    // Strudel's own transport: its per-track Start at cycle 0 never reaches a port and is not reported; a
    // midicmd of clock or start in the code reaches no port either, Moontide's own clock stays single, and Claude hears
    // once that the code wrote them. The replies are read as text: set_code and the next call each may carry the line.
    const replyTextOf = (reply) => (typeof reply === 'string' ? reply : JSON.stringify(reply));
    const transportBase = `setcpm(100/4)\n$: note("c3 e3").midi('Fake Synth B', { midichannel: 1 })\n$: silence.midi('Fake Synth A', { midichannel: 2 })`;
    await callTool(client, 'stop', {});
    await sleep(500);
    const implicitMark = (await midiLog()).length;
    const implicitSet = replyTextOf(await callTool(client, 'set_code', { code: transportBase, label: 'probe:midi transport implicit start' }));
    await sleep(2000);
    const implicitNext = replyTextOf(await callTool(client, 'get_code', {}));
    const implicitLog = (await midiLog()).slice(implicitMark);
    const implicitStartsB = portEntries(implicitLog, 'Fake Synth B').filter((entry) => entry.bytes[0] === 0xfa).length;
    const implicitStartsA = portEntries(implicitLog, 'Fake Synth A').filter((entry) => same(entry.bytes, [0xfa])).length;
    const implicitNotices = countOfLine(implicitSet, MIDI_CLOCK_DROPPED_LINE) + countOfLine(implicitNext, MIDI_CLOCK_DROPPED_LINE);
    report(
      "Strudel's per-track Start at cycle 0 never reaches a port and is not reported",
      implicitStartsB === 0 && implicitStartsA === 1 && implicitNotices === 0,
      JSON.stringify({ startsOnB: implicitStartsB, startsOnA: implicitStartsA, notices: implicitNotices }),
    );

    const writtenCode = `${transportBase}\n$: midicmd("clock*96").midi('Fake Synth A', { midichannel: 2 })\n$: midicmd("start").midi('Fake Synth B', { midichannel: 1 })`;
    const writtenMark = (await midiLog()).length;
    const writtenSet = replyTextOf(await callTool(client, 'set_code', { code: writtenCode, label: 'probe:midi transport written' }));
    await sleep(3000);
    const writtenWindowMark = (await midiLog()).length;
    await sleep(2000);
    const writtenNext = replyTextOf(await callTool(client, 'get_code', {}));
    const writtenAll = (await midiLog()).slice(writtenMark);
    const writtenWindow = (await midiLog()).slice(writtenWindowMark);
    const transportOnB = portEntries(writtenAll, 'Fake Synth B').filter((entry) => [0xf8, 0xfa, 0xfb, 0xfc].includes(entry.bytes[0])).length;
    const ticksInWindow = portEntries(writtenWindow, 'Fake Synth A').filter((entry) => same(entry.bytes, [0xf8])).length;
    const startsInAll = portEntries(writtenAll, 'Fake Synth A').filter((entry) => same(entry.bytes, [0xfa])).length;
    const expectedTicks = 2000 / 25;
    report(
      "Strudel's own clock and transport never reach a port",
      transportOnB === 0 && Math.abs(ticksInWindow - expectedTicks) <= 2 && startsInAll === 0,
      JSON.stringify({ transportOnB, ticksOnAInWindow: ticksInWindow, expectedTicks, newStartsOnA: startsInAll }),
    );
    const writtenNotices = countOfLine(writtenSet, MIDI_CLOCK_DROPPED_LINE) + countOfLine(writtenNext, MIDI_CLOCK_DROPPED_LINE);
    const againSet = replyTextOf(await callTool(client, 'set_code', { code: writtenCode, label: 'probe:midi transport written again' }));
    await sleep(2000);
    const againNext = replyTextOf(await callTool(client, 'get_code', {}));
    const againNotices = countOfLine(againSet, MIDI_CLOCK_DROPPED_LINE) + countOfLine(againNext, MIDI_CLOCK_DROPPED_LINE);
    report(
      'Claude hears once that the code wrote MIDI clock or transport',
      writtenNotices === 1 && againNotices === 0,
      JSON.stringify({ noticesForTheCode: writtenNotices, noticesAfterTheSameCodeAgain: againNotices }),
    );

    await callTool(client, 'stop', {});
    await sleep(500);

    // --- A change that waits for a line: its MIDI setup follows the line ---
    // set_code with at 'bar' or 'phrase' takes over on a cycle line. Its sound change, controls, clock Start and track
    // silence must reach the instruments at the line, never at the request. The fake device logs the timestamp each
    // message asked for (ts) and the moment it was sent (t); the line's own time is estimated from the page's scheduler.
    {
      const takeoverRig = (clockOnA) =>
        fs.writeFileSync(
          rigFile,
          JSON.stringify({
            instruments: [
              { id: 'mt32', model: 'mt32', port: 'Fake Synth A', ...(clockOnA ? { clock: true } : {}) },
              { id: 'sc55', model: 'sc55', port: 'Fake Synth B' },
            ],
          }),
        );
      const cycleOfReply = (reply) => {
        const match = /takes over at cycle (\d+)/.exec(reply);
        return match === null ? null : Number(match[1]);
      };
      const readSchedulerFacts = () =>
        evaluateExpr(cdp, `(() => { const s = document.getElementById('repl').editor.repl.scheduler; return { perf: performance.now(), now: s.now(), cps: s.cps, latency: s.latency }; })()`);
      // The performance.now() time the line is heard at, estimated from one reading of the scheduler (good to tens of ms).
      const lineEstimateMs = (facts, cycle) => facts.perf + ((cycle - facts.now) / facts.cps + facts.latency) * 1000;
      const waitForCycle = async (test, ms = 40000) => {
        const deadline = Date.now() + ms;
        for (;;) {
          const facts = await readSchedulerFacts();
          if (test(facts.now)) return facts;
          if (Date.now() > deadline) return null;
          await sleep(50);
        }
      };
      const noteOnOf = (pitch, status) => (entry) => entry.port === 'Fake Synth A' && entry.bytes.length === 3 && entry.bytes[0] === status && entry.bytes[2] > 0 && entry.bytes[1] === pitch;
      const programChangesA = (entries) => entries.filter((entry) => entry.port === 'Fake Synth A' && entry.bytes.length === 2 && entry.bytes[0] === 0xc2);
      const bar = 'setcps(1)\n';

      // The sound change, and the history follows the line in the MIDI case too.
      takeoverRig(false);
      await setScenario({ permission: 'granted' });
      await sleep(1500);
      {
        const oldCode = `${bar}mt32old: note("c3*4").midi('Fake Synth A', { midichannel: 3, sound: 'Str Sect 1' })`;
        const newCode = `${bar}mt32new: note("d3*4").midi('Fake Synth A', { midichannel: 3, sound: 'Harpsi 2' })`;
        const label = 'probe:midi takeover sound new';
        await callTool(client, 'set_code', { code: oldCode, label: 'probe:midi takeover sound old' });
        await sleep(1500);
        // Ask early in a phrase of eight cycles, so the line is more than five seconds away.
        await waitForCycle((now) => now % 8 > 0.3 && now % 8 < 3);
        const mark = (await midiLog()).length;
        const reply = await callTool(client, 'set_code', { code: newCode, label, at: 'phrase', phraseCycles: 8 });
        const facts = await readSchedulerFacts();
        const cycle = cycleOfReply(reply);
        const codeBefore = await callTool(client, 'get_code', {});
        const historyBefore = await callTool(client, 'list_history', {});
        await sleep(400);
        const earlyProgram = programChangesA((await midiLog()).slice(mark)).length;
        if (cycle === null) {
          report('takeover midi: no program change before the lead, and the change lands between the old and the new notes', false, `the reply has no cycle: ${JSON.stringify(reply.slice(0, 200))}`);
          report('takeover midi: get_code and the history follow the line', false, 'no cycle to compare');
        } else {
          await waitForCycle((now) => now > cycle + 1.5);
          await sleep(300);
          const log = (await midiLog()).slice(mark);
          const program = programChangesA(log);
          const oldOns = log.filter(noteOnOf(48, 0x92)).filter((entry) => typeof entry.ts === 'number');
          const newOns = log.filter(noteOnOf(50, 0x92)).filter((entry) => typeof entry.ts === 'number');
          const lastOld = Math.max(...oldOns.map((entry) => entry.ts));
          const firstNew = Math.min(...newOns.map((entry) => entry.ts));
          const change = program[0];
          const sentAheadMs = change === undefined ? null : firstNew - change.t;
          report(
            'takeover midi: no program change before the lead, and the change lands between the old and the new notes',
            earlyProgram === 0 &&
              program.length === 1 &&
              typeof change.ts === 'number' &&
              oldOns.length > 0 &&
              newOns.length > 0 &&
              change.ts >= lastOld &&
              change.ts <= firstNew &&
              sentAheadMs > 0 &&
              sentAheadMs <= 700,
            JSON.stringify({ line: cycle, programChangesAtTheRequest: earlyProgram, programChanges: program.length, programTs: change?.ts ?? null, lastOldNoteTs: oldOns.length > 0 ? lastOld : null, firstNewNoteTs: newOns.length > 0 ? firstNew : null, sentMsBeforeTheLine: sentAheadMs }),
          );
          const codeAfter = await callTool(client, 'get_code', {});
          const historyAfter = await callTool(client, 'list_history', {});
          report(
            'takeover midi: get_code and the history follow the line',
            codeBefore.includes('mt32old') &&
              !codeBefore.includes('mt32new') &&
              !historyBefore.includes(label) &&
              codeAfter.includes('mt32new') &&
              !codeAfter.includes('mt32old') &&
              historyAfter.includes(label),
            JSON.stringify({ codeBeforeHasOld: codeBefore.includes('mt32old'), codeBeforeHasNew: codeBefore.includes('mt32new'), historyBeforeHasLabel: historyBefore.includes(label), codeAfterHasNew: codeAfter.includes('mt32new'), historyAfterHasLabel: historyAfter.includes(label), estimatedLineMs: lineEstimateMs(facts, cycle) }),
          );
        }
        await callTool(client, 'set_code', { code: SILENT, label: 'probe:midi takeover sound done' });
        await sleep(500);
      }

      // A track the waiting change drops is silenced at the takeover, not at the request.
      {
        const pad = `pad: note("c3*4").midi('Fake Synth A', { midichannel: 3 })`;
        const lead = `lead: note("e3*4").midi('Fake Synth A', { midichannel: 4 })`;
        await callTool(client, 'set_code', { code: `${bar}${pad}\n${lead}`, label: 'probe:midi takeover tracks old' });
        await sleep(1500);
        const mark = (await midiLog()).length;
        const reply = await callTool(client, 'set_code', { code: `${bar}${lead}`, label: 'probe:midi takeover tracks new', at: 'bar' });
        const facts = await readSchedulerFacts();
        const cycle = cycleOfReply(reply);
        if (cycle === null) {
          report('takeover midi: a removed track is silenced at the takeover', false, `the reply has no cycle: ${JSON.stringify(reply.slice(0, 200))}`);
        } else {
          const lineMs = lineEstimateMs(facts, cycle);
          await waitForCycle((now) => now > cycle + 1.5);
          await sleep(500);
          const sweeps = (await midiLog()).slice(mark).filter((entry) => entry.port === 'Fake Synth A' && same(entry.bytes, [0xb2, 123, 0]));
          const earliest = sweeps.length > 0 ? Math.min(...sweeps.map((entry) => entry.t)) : null;
          report(
            'takeover midi: a removed track is silenced at the takeover',
            sweeps.length >= 1 && earliest >= lineMs - 150,
            JSON.stringify({ line: cycle, silences: sweeps.length, earliestSilenceMsBeforeTheLine: earliest === null ? null : Math.round(lineMs - earliest) }),
          );
        }
        await callTool(client, 'set_code', { code: SILENT, label: 'probe:midi takeover tracks done' });
        await sleep(500);
      }

      // Stop during the wait: no setup byte of the waiting change.
      {
        const oldCode = `${bar}mt32old: note("c3*4").midi('Fake Synth A', { midichannel: 3, sound: 'Str Sect 1' })`;
        const newCode = `${bar}mt32new: note("d3*4").midi('Fake Synth A', { midichannel: 3, sound: 'Harpsi 2' })`;
        await callTool(client, 'set_code', { code: oldCode, label: 'probe:midi takeover stop old' });
        await sleep(1500);
        await waitForCycle((now) => now % 8 > 0.3 && now % 8 < 3);
        const mark = (await midiLog()).length;
        const reply = await callTool(client, 'set_code', { code: newCode, label: 'probe:midi takeover stop new', at: 'phrase', phraseCycles: 8 });
        await callTool(client, 'stop', {});
        await sleep(3000);
        const program = programChangesA((await midiLog()).slice(mark));
        report(
          'takeover midi: Stop before the lead sends no setup',
          cycleOfReply(reply) !== null && program.length === 0,
          JSON.stringify({ line: cycleOfReply(reply), programChangesAfterTheRequest: program.length }),
        );
        await callTool(client, 'set_code', { code: SILENT, label: 'probe:midi takeover stop done' });
        await sleep(500);
      }

      // A clock instrument the waiting change names gets its Start on the line, not one bar later.
      takeoverRig(true);
      await setScenario({ permission: 'granted' });
      await sleep(1500);
      {
        const lead = `lead: note("c3*4").midi('Fake Synth B', { midichannel: 1 })`;
        await callTool(client, 'set_code', { code: `${bar}${lead}`, label: 'probe:midi takeover clock old' });
        await sleep(1500);
        const mark = (await midiLog()).length;
        const reply = await callTool(client, 'set_code', {
          code: `${bar}${lead}\nseq: note("e3*4").midi('Fake Synth A', { midichannel: 2 })`,
          label: 'probe:midi takeover clock new',
          at: 'bar',
        });
        const facts = await readSchedulerFacts();
        const cycle = cycleOfReply(reply);
        if (cycle === null) {
          report('takeover midi: a new clock instrument starts on the line', false, `the reply has no cycle: ${JSON.stringify(reply.slice(0, 200))}`);
        } else {
          const lineMs = lineEstimateMs(facts, cycle);
          await waitForCycle((now) => now > cycle + 2);
          await sleep(300);
          const log = (await midiLog()).slice(mark);
          const starts = log.filter((entry) => entry.port === 'Fake Synth A' && same(entry.bytes, [0xfa]));
          const firstNote = log.find(noteOnOf(52, 0x91));
          const startTs = starts[0]?.ts ?? null;
          const noteTs = firstNote?.ts ?? null;
          report(
            'takeover midi: a new clock instrument starts on the line',
            starts.length === 1 &&
              typeof startTs === 'number' &&
              typeof noteTs === 'number' &&
              Math.abs(startTs - lineMs) < 300 &&
              noteTs - startTs >= -1 &&
              noteTs - startTs <= 15 &&
              Math.abs(noteTs - lineMs) < 300,
            JSON.stringify({ line: cycle, starts: starts.length, startMsFromTheLine: startTs === null ? null : Math.round(startTs - lineMs), firstNoteMsAfterTheStart: startTs === null || noteTs === null ? null : Math.round((noteTs - startTs) * 10) / 10 }),
          );
        }
        await callTool(client, 'set_code', { code: SILENT, label: 'probe:midi takeover clock done' });
        await sleep(500);
      }
    }

    await callTool(client, 'set_code', { code: SILENT, label: 'probe:midi instruments done' });
    fs.rmSync(rigFile, { force: true });
    await callTool(client, 'set_code', { code: SILENT, label: 'probe:midi instruments removed' });

    await songMidiBlocks({ cdp, client, report, setScenario, dataDir });
    await mixerMidiBlocks({ cdp, client, report, setScenario, dataDir });
    await timelineMidiBlocks({ cdp, client, report, setScenario, dataDir });

    summarize();
  } catch (err) {
    if (err instanceof ProbeCouldNotRun) {
      console.error(`probe:midi COULD NOT RUN: ${err.message}`);
      process.exitCode = 2;
      return;
    }
    console.error(`probe:midi COULD NOT RUN: unexpected error: ${err instanceof Error ? err.stack || err.message : String(err)}`);
    process.exitCode = 2;
  } finally {
    if (ws) {
      try {
        ws.close();
      } catch (err) {
        console.error(`probe:midi: failed to close the CDP socket: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (browserChild) {
      try {
        await closeBrowser(browserChild);
      } catch (err) {
        console.error(`probe:midi: failed to close the browser: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (client) {
      try {
        await client.close();
      } catch (err) {
        console.error(`probe:midi: failed to close the MCP client: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    await removeTempDirs(tempDirs, 'probe:midi');
  }
}

// Runs only when executed directly, like scripts/probe-page.mjs.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
