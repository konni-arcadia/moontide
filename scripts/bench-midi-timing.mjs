#!/usr/bin/env node
// Developer bench: where do Moontide's MIDI note-ons ARRIVE on a loopback port? It uses the method measured in the spike: a real
// headless Chrome runs the real Moontide page, plays a fast note grid on a loopback MIDI port, and listens on the
// matching input of the same port; the arrival time is MIDIMessageEvent.timeStamp. The page can be idle or busy (its
// main thread blocked 30 to 90 ms every 200 ms). Run it with `npm run bench:midi`; it is not part of `npm test`.
//
//   npm run bench:midi -- [options]
//     --port NAME        loopback port to play on and listen to, default "IAC Driver Bus 1". On macOS turn the IAC
//                        Driver on in Audio MIDI Setup; on Windows or Linux pass a loopback port (loopMIDI, an ALSA
//                        virtual port). The bench never falls back to another port. Exactly one output name must
//                        contain NAME (Strudel plays on the first output whose name contains it) and one input must be
//                        named exactly NAME; the bench stops with a message otherwise.
//     --seconds N        measured window in seconds, default 10 (after 3 s of settling)
//     --cpm N            cycles per minute, default 25
//     --per-cycle N      note-ons per cycle, a whole number, default 96 (with 25 cpm: one note every 25 ms)
//     --busy             block the page's main thread 30 to 90 ms every 200 ms during the measured window
//     --clock            declare the port a clock instrument, so the page sends clock ticks on it too; adds the
//                        tick-minus-note offset (positive: the note arrives before its nearest tick)
//     --tail             instead of the grid run, measure the note-ons that still arrive after Stop, after muting a
//                        track and after a sound change; prints one JSON line per scenario. Not combinable with
//                        --busy or --clock.
//     --ramp MS          instead of the grid run, step the tempo about 20 times from 100 to 120 BPM, MS milliseconds apart
//                        (a whole number from 50 to 100), while the code holds 120, and measure the clock ticks around the
//                        steps: the arrival intervals (largest, smallest, holes, doubled ticks), the ticks in every cycle, and
//                        from the page's send log the late sends. Implies --clock; not combinable with --tail or --per-cycle.
//                        --busy loads the page's main thread during the ramp. The steps come from the measurement driver of
//                        scripts/probe-midi.mjs (RAMP_DRIVER_SOURCE), injected into the bench's own browser tab: it is not
//                        page code. Prints one JSON line.
//     --driver NAME      with --ramp: "interval" (default) wakes on a short timer and reads the scheduler's position, "query"
//                        hooks the scheduler's query path and sets each step in the task of the tick that found it, and
//                        "query-late" does the same but sets each step 25 ms after that tick
//     --settings         instead of the grid run, play the valid settings piece of scripts/probe-midi.mjs (tone, part and scene
//                        settings on two channels of a made-up synth, written into the bench's own temporary data folder) on the
//                        port and compare what ARRIVES on the loopback input with the data sets, bank selects and program
//                        changes the documented rules give, byte for byte and in order, and with the page's own send log.
//                        Prints one JSON line: { mode: 'settings', port, browser, piece, expected, arrived, identical, inOrder,
//                        firstDifference, programToFirstSettingMs, sentEqualsArrived, arrivedNotSent, sentNotArrived }: the
//                        last two list the messages (as hex) that arrived without the page having sent them and that the page
//                        sent without their arriving, so a message the transport added or lost does not read as a page fault.
//                        Needs a loopback port with nothing listening on it, because the bytes are real settings messages
//                        inside the temporary scene and tones.
//                        Not combinable with --tail, --ramp, --busy, --clock or --per-cycle.
//     --settings-piece NAME  with --settings: which piece to play. "analog" (the default) is the piece above; "engines" plays the
//                        engines piece of scripts/probe-midi.mjs on a made-up synth with three engines (a tone setting on a sound of
//                        each engine, two of them with a name the engines share) and compares the arrivals the same way; "offsets"
//                        plays the offsets piece on a made-up synth whose part settings are GS-style NRPN offsets (the five control
//                        changes of each offset, 99, 98, 6, 101 and 100, count as setup messages for it). The page's send log is cut
//                        into messages before the comparison, because an NRPN set leaves in one send. "timbres" plays the timbres piece
//                        on a made-up synth whose data sets have a one-byte model ID and three-byte addresses (tone settings of two
//                        partials and the patch on channel 2, the output level and the panpot on channel 3, every scene setting;
//                        the page's send log is compared with the arrivals as for the other pieces). The JSON line gains piece.
//     --input            instead of the grid run, measure where the page's own keyboard input places notes. The setup file of the bench's
//                        own temporary data folder names the port as an input, the Scratchpad (key 7) is opened so its read-outs are live, and a
//                        script in the bench's own tab records every value of the Scratchpad's heard-cycle read-out with its source (the page's
//                        own placement, not a copy of the rule). At 60, 90, 120, 140 and 180 BPM, twice: with the music playing, the page hears
//                        its own quiet note grid come back on the loopback and each note should land on its place of the grid; and with the
//                        music stopped (the tempo kept), the bench sends note-ons stamped on the grid of that tempo through the native output
//                        of the port, and the spacing of the heard cycles should match. A run passes when every note was heard and none is more
//                        than 6 ms off. --per-cycle is the notes per cycle and defaults to 4 here; --port, --headful and --browser keep their
//                        meaning, --seconds and --cpm are not used. Prints one JSON line: { mode: 'input', port, browser, perCycle, marginMs,
//                        runs: [{ bpm, music: 'playing' | 'stopped', notes, worstMs, meanMs, pass }], pass }. Needs a loopback port with
//                        nothing listening on it, because the notes are real note messages (low velocity).
//                        Not combinable with --tail, --ramp, --settings, --clock or --busy.
//     --headful          a real browser window instead of headless
//     --browser PATH     the Chromium-based browser to drive (default: found like the probes do)
//
// Output: one JSON line per run (three with --tail) on stdout. Exit code 0 when the bench ran, 2 when it could not
// (one line starting with "bench:midi COULD NOT RUN" on stderr names the cause).
//
// How to read the numbers: a message sent WITH a timestamp arrives, on the loopback, at the time it asked for, even
// when the page sent it late (a late message goes out at once, but its arrival still reads the requested time). So
// the arrival figures cannot show lateness of stamped messages: `late` is counted on the send side, from the page's
// own log of every MIDIOutput.send call, and must always be read next to the arrival figures. Messages sent without
// a timestamp arrive when they really arrive.
//
// Side effects: low-velocity notes on the port and, with --input, a setup file in the bench's own temporary data folder that names an
// MT-32 and the input on that port, and with --clock or --tail, a rig file in the bench's own temporary
// data folder that names an MT-32 on that port, so the page sends that model's setup bytes there; with --settings, a rig file
// that names a made-up synth with settings on that port, so the page sends its settings messages there. Nothing should
// listen to the port while the bench runs. The bench starts its own Moontide server and browser profile in temporary
// folders, grants Web MIDI to that profile over the DevTools protocol and removes the folders at the end. It never
// touches a Moontide server that is already running. Do not run it at the same time as `npm test`,
// `npm run probe:midi` or `npm run probe:page`: they use the same port.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ProbeCouldNotRun,
  callTool,
  clickOverlay,
  closeBrowser,
  closeBrowserOnSignal,
  evaluateExpr,
  findBrowser,
  findPageTarget,
  freshDataDir,
  makeCdp,
  pollDevToolsPort,
  pressKey,
  removeTempDirs,
  sleep,
  spawnBrowser,
  startServerAndClient,
  waitConnected,
  waitFor,
  waitSocketOpen,
} from './probe-page.mjs';
import { engineSynthCatalog, engineSynthModel, offsetSynthModel, timbreSynthModel, toneSynthCatalog, toneSynthModel } from '../test/settings-fixtures.js';
import { RAMP_DRIVER_SOURCE, engineSettingsPiece, engineSettingsSent, offsetSettingsPiece, offsetSettingsSent, rampTickStats, settingsValidPiece, settingsValidSent, splitSentMessages, timbreSettingsPiece, timbreSettingsSent } from './probe-midi.mjs';

const NAME = 'bench:midi';
const DEFAULT_PORT = 'IAC Driver Bus 1';
const SETTINGS_PIECES = ['analog', 'engines', 'offsets', 'timbres'];

/** Parses the bench's own options. Throws an Error that names the problem (the caller prints it, exit code 2). */
export function parseBenchArgs(argv) {
  const result = { port: DEFAULT_PORT, seconds: 10, cpm: 25, perCycle: 96, busy: false, clock: false, tail: false, input: false, ramp: null, driver: null, settings: false, settingsPiece: null, headful: false, browserPath: null };
  const need = (flag, i) => {
    const value = argv[i];
    if (value === undefined || value.startsWith('--') || value.trim() === '') throw new Error(`${flag} needs a value`);
    return value;
  };
  const positive = (flag, i, whole) => {
    const raw = need(flag, i);
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0 || (whole && !Number.isInteger(value))) {
      throw new Error(`${flag} needs a ${whole ? 'whole number' : 'number'} above 0, got "${raw}"`);
    }
    return value;
  };
  let perCycleGiven = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--busy') result.busy = true;
    else if (arg === '--clock') result.clock = true;
    else if (arg === '--tail') result.tail = true;
    else if (arg === '--input') result.input = true;
    else if (arg === '--settings') result.settings = true;
    else if (arg === '--headful') result.headful = true;
    else if (arg === '--ramp') {
      const raw = need(arg, ++i);
      const value = Number(raw);
      if (!Number.isInteger(value) || value < 50 || value > 100) throw new Error(`--ramp needs a whole number of milliseconds from 50 to 100, got "${raw}"`);
      result.ramp = value;
    } else if (arg === '--driver') {
      const raw = need(arg, ++i);
      if (raw !== 'interval' && raw !== 'query' && raw !== 'query-late') throw new Error(`--driver needs "interval", "query" or "query-late", got "${raw}"`);
      result.driver = raw;
    } else if (arg === '--settings-piece') {
      const raw = need(arg, ++i);
      if (!SETTINGS_PIECES.includes(raw)) throw new Error(`--settings-piece needs ${SETTINGS_PIECES.map((name) => `"${name}"`).join(' or ')}, got "${raw}"`);
      result.settingsPiece = raw;
    } else if (arg === '--port') result.port = need(arg, ++i);
    else if (arg === '--seconds') result.seconds = positive(arg, ++i, false);
    else if (arg === '--cpm') result.cpm = positive(arg, ++i, false);
    else if (arg === '--per-cycle') {
      result.perCycle = positive(arg, ++i, true);
      perCycleGiven = true;
    } else if (arg === '--browser') result.browserPath = need(arg, ++i);
    else throw new Error(`unknown option "${arg}"`);
  }
  if (result.settings) {
    const given = [
      ['--tail', result.tail],
      ['--ramp', result.ramp !== null],
      ['--busy', result.busy],
      ['--clock', result.clock],
      ['--per-cycle', perCycleGiven],
    ];
    for (const [flag, on] of given) if (on) throw new Error(`--settings cannot be combined with ${flag}`);
  }
  if (result.input) {
    const given = [
      ['--tail', result.tail],
      ['--ramp', result.ramp !== null],
      ['--settings', result.settings],
      ['--clock', result.clock],
      ['--busy', result.busy],
    ];
    for (const [flag, on] of given) if (on) throw new Error(`--input cannot be combined with ${flag}`);
    if (!perCycleGiven) result.perCycle = 4;
  }
  if (result.settingsPiece !== null && !result.settings) throw new Error('--settings-piece only goes with --settings');
  result.settingsPiece ??= 'analog';
  if (result.tail && (result.busy || result.clock)) throw new Error('--tail cannot be combined with --busy or --clock');
  if (result.driver !== null && result.ramp === null) throw new Error('--driver only goes with --ramp');
  if (result.ramp !== null) {
    if (result.tail) throw new Error('--ramp cannot be combined with --tail');
    if (perCycleGiven) throw new Error('--ramp cannot be combined with --per-cycle');
    result.clock = true;
    result.driver ??= 'interval';
  }
  // The port name goes into a Strudel string: keep it free of characters that would end the string.
  if (/['\\\n\r]/.test(result.port)) throw new Error('--port must not contain a quote, a backslash or a line break');
  return result;
}

/**
 * The instrument the bench's setup file names for the parsed options, or null for none. --input, --clock and --tail need one: an MT-32 on
 * the port, so the page sends its setup bytes there; only --clock (and --ramp, which implies it) declares it a clock instrument.
 */
export function benchRig(args) {
  if (args.input) return { id: 'seq', model: 'mt32', port: args.port };
  if (args.clock) return { id: 'seq', model: 'mt32', port: args.port, clock: true };
  if (args.tail) return { id: 'seq', model: 'mt32', port: args.port };
  return null;
}

const round2 = (x) => Math.round(x * 100) / 100;

/** { n, mean, sd, min, p95, max } of a list of numbers, or null for an empty list. */
function stats(xs) {
  if (!xs.length) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
  return { n: xs.length, mean: round2(mean), sd: round2(sd), min: round2(sorted[0]), p95: round2(sorted[Math.floor(0.95 * (sorted.length - 1))]), max: round2(sorted.at(-1)) };
}

const isNoteOn = (bytes) => (bytes[0] & 0xf0) === 0x90 && bytes[2] > 0;
const isNoteOff = (bytes) => (bytes[0] & 0xf0) === 0x80 || ((bytes[0] & 0xf0) === 0x90 && bytes[2] === 0);

/** The page-side setup: a log of every native send with its requested timestamp, and the loopback listener. */
function pageSetupExpression(port) {
  return `(async () => {
    window.__arrivals = []; window.__sends = []; window.__stopAt = null;
    // The moment Stop reaches the audio context: the page's stop path suspends it right after it retires the outputs
    // (and so after it ended the queued notes), before the panic bytes, which only go out once the suspend settles.
    const realSuspend = AudioContext.prototype.suspend;
    AudioContext.prototype.suspend = function () { window.__stopAt = performance.now(); return realSuspend.apply(this, arguments); };
    const realSend = MIDIOutput.prototype.send;
    MIDIOutput.prototype.send = function (data, ts) { window.__sends.push({ t: performance.now(), port: this.name, bytes: Array.from(data), ts: ts === undefined ? null : ts }); return realSend.call(this, data, ts); };
    const access = await navigator.requestMIDIAccess({ sysex: true });
    const inputs = [...access.inputs.values()];
    // Strudel plays on the first output whose name CONTAINS the port: list every such output.
    const outputs = [...access.outputs.values()].filter((o) => o.name.includes(${JSON.stringify(port)})).map((o) => o.name);
    const input = inputs.find((i) => i.name === ${JSON.stringify(port)});
    // The native output of the port, for the runs that send their own notes (--input with the music stopped).
    window.__benchOut = [...access.outputs.values()].find((o) => o.name.includes(${JSON.stringify(port)})) ?? null;
    if (!input) return { found: false, inputs: inputs.map((i) => i.name), outputs };
    input.onmidimessage = (e) => window.__arrivals.push({ t: e.timeStamp, bytes: Array.from(e.data) });
    await input.open();
    // The busy load: blocks the main thread for 30 to 90 ms every 200 ms while it is on.
    window.__setLoad = (on) => { clearInterval(window.__loadTimer); window.__loadTimer = null; if (!on) return; window.__loadTimer = setInterval(() => { const end = performance.now() + 60 * (0.5 + Math.random()); while (performance.now() < end) {} }, 200); };
    return { found: true, inputs: [], outputs };
  })()`;
}

/**
 * Starts the server, the browser and the loopback listener, and runs `body`. Everything is cleaned up afterwards. `files` are
 * extra files for the bench's own temporary data folder: { relative: 'models/name.json', content } with `relative` under the folder.
 * `inputs` are the names of MIDI inputs the setup file declares beside the rig.
 */
async function withBenchPage(args, rig, body, files = [], inputs = []) {
  const tempDirs = [];
  let client;
  let child;
  let ws;
  try {
    const started = await startServerAndClient();
    client = started.client;
    tempDirs.push(started.dataDir);
    for (const file of files) {
      const target = path.join(started.dataDir, ...file.relative.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, file.content);
    }
    if (rig) {
      const file = { instruments: [rig], ...(inputs.length ? { inputs: inputs.map((port) => ({ port })) } : {}) };
      fs.writeFileSync(path.join(started.dataDir, 'instruments.json'), JSON.stringify(file));
    }
    const userDataDir = freshDataDir('moontide-bench-browser-');
    tempDirs.push(userDataDir);
    child = spawnBrowser(findBrowser({ browserPath: args.browserPath }), userDataDir, started.pageUrl, args.headful);
    closeBrowserOnSignal(child, tempDirs, NAME);
    const devToolsPort = await pollDevToolsPort(userDataDir, 10000);
    const target = await findPageTarget(devToolsPort, started.pageUrl, 10000);
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await waitSocketOpen(ws);
    const cdp = makeCdp(ws);
    await cdp('Runtime.enable');
    await waitConnected(cdp, 15000);
    await clickOverlay(cdp);
    // Grants Web MIDI (with SysEx) to the fresh browser profile without a prompt; no system setting changes.
    await cdp('Browser.grantPermissions', { origin: new URL(started.pageUrl).origin, permissions: ['midi', 'midiSysex'] });
    const browser = (await cdp('Browser.getVersion')).product;
    let setup;
    try {
      setup = await evaluateExpr(cdp, pageSetupExpression(args.port));
    } catch (err) {
      throw new ProbeCouldNotRun(`Web MIDI is not available in the bench browser: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!setup.found) {
      const seen = setup.inputs.length ? `inputs seen: ${setup.inputs.map((n) => `"${n}"`).join(', ')}` : 'no MIDI input at all';
      throw new ProbeCouldNotRun(`no MIDI input is named "${args.port}" (${seen}); turn on a loopback port (on macOS the IAC Driver in Audio MIDI Setup) or pass --port`);
    }
    // The page plays on the first output whose name contains the port, while the bench listens on the input named exactly
    // like it: with a second output that contains the name (IAC Driver Bus 1 and Bus 10) the notes could go elsewhere.
    if (setup.outputs.length !== 1) {
      throw new ProbeCouldNotRun(`${setup.outputs.length} MIDI outputs contain "${args.port}" (${setup.outputs.map((n) => `"${n}"`).join(', ') || 'none'}); the page plays on the first match while the bench listens on the input named exactly "${args.port}", so pass a --port that exactly one output name contains`);
    }
    await body({ client, cdp, browser });
  } finally {
    if (ws) {
      try {
        ws.close();
      } catch (err) {
        console.error(`${NAME}: failed to close the CDP socket: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (child) {
      try {
        await closeBrowser(child);
      } catch (err) {
        console.error(`${NAME}: failed to close the browser: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (client) {
      try {
        await client.close();
      } catch (err) {
        console.error(`${NAME}: failed to close the MCP client: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    await removeTempDirs(tempDirs, NAME);
  }
}

/** One timing run: the note grid, the measured window, the analysis of the method measured in the spike. Returns the JSON object. */
async function runTiming(args, { client, cdp, browser }) {
  const { port, seconds, cpm, perCycle, busy, clock } = args;
  // With a clock instrument the notes use channel 3 and a silent track on channel 2 makes the page treat the port as in use.
  const notes = `n: note("c3*${perCycle}").midi('${port}', { midichannel: ${clock ? 3 : 16}, velocity: 0.01 })`;
  const code = `setcpm(${cpm})\n${clock ? `c: silence.midi('${port}', { midichannel: 2 })\n` : ''}${notes}`;
  const reply = await callTool(client, 'set_code', { code, label: 'bench' });
  console.error(`${NAME}: ${reply.split('\n').slice(0, 3).join(' | ')}`);
  await sleep(3000); // settle: the page-wide alignment warm-up
  await evaluateExpr(cdp, 'window.__arrivals.length = 0; window.__sends.length = 0; true');
  if (busy) await evaluateExpr(cdp, 'window.__setLoad(true); true');
  const t0 = await evaluateExpr(cdp, 'performance.now()');
  await sleep(seconds * 1000);
  const t1 = await evaluateExpr(cdp, 'performance.now()');
  if (busy) await evaluateExpr(cdp, 'window.__setLoad(false); true');
  await sleep(800);
  const { arrivals, sends } = JSON.parse(await evaluateExpr(cdp, 'JSON.stringify({ arrivals: window.__arrivals, sends: window.__sends })'));
  await callTool(client, 'stop', {});

  const inWindow = (a) => a.t >= t0 && a.t <= t1;
  const noteOns = arrivals.filter((a) => inWindow(a) && isNoteOn(a.bytes)).map((a) => a.t);
  const n = noteOns.length;
  if (n < 2) {
    throw new ProbeCouldNotRun(`only ${n} note-on(s) arrived on "${port}" in the ${seconds} s window; is something else using the port, or is the page silent?`);
  }
  const expected = 60000 / cpm / perCycle;
  const intervals = noteOns.slice(1).map((t, i) => t - noteOns[i]);
  // Residuals of a straight-line fit of arrival time against the note index: jitter about the ideal grid.
  const idx = noteOns.map((_, i) => i);
  const meanIdx = idx.reduce((a, b) => a + b, 0) / n;
  const meanT = noteOns.reduce((a, b) => a + b, 0) / n;
  const slope = idx.reduce((a, i) => a + (i - meanIdx) * (noteOns[i] - meanT), 0) / idx.reduce((a, i) => a + (i - meanIdx) ** 2, 0);
  const resid = noteOns.map((t, i) => t - (meanT + slope * (i - meanIdx)));
  const out = {
    mode: busy ? 'busy' : 'idle',
    seconds,
    cpm,
    perCycle,
    port,
    browser,
    clock,
    noteOns: n,
    expectedMs: expected,
    fittedMs: round2(slope),
    interval: stats(intervals),
    bursts: intervals.filter((d) => d < expected * 0.25).length, // under 25 % of a grid step
    gaps: intervals.filter((d) => d > expected * 1.75).length, // over 175 % of a grid step
    residual: stats(resid.map(Math.abs)),
    residualSd: stats(resid)?.sd,
  };
  if (clock) {
    const ticks = arrivals.filter((a) => inWindow(a) && a.bytes[0] === 0xf8).map((a) => a.t);
    if (!ticks.length) throw new ProbeCouldNotRun(`--clock: no clock tick arrived on "${port}" in the window; the page did not treat the port as a clock instrument`);
    out.ticks = ticks.length;
    // For each note-on: the nearest tick minus the note. Positive: the note arrives before its nearest tick.
    out.tickMinusNote = stats(noteOns.map((t) => {
      let best = Infinity;
      for (const k of ticks) if (Math.abs(k - t) < Math.abs(best)) best = k - t;
      return best;
    }).filter(Number.isFinite));
  }
  const noteOffs = arrivals.filter((a) => inWindow(a) && isNoteOff(a.bytes)).map((a) => a.t);
  out.noteOffs = noteOffs.length;
  out.offMinusOn = stats(noteOns.map((t) => {
    const next = noteOffs.find((o) => o > t);
    return next === undefined ? NaN : next - t;
  }).filter(Number.isFinite));
  // Send side. Late = the page called send after the timestamp it asked for had passed (Chrome then sends at once).
  // Only the measured window: the 800 ms after t1 run with the busy load already off and would dilute the figures.
  const noteSends = sends.filter((s) => s.t >= t0 && s.t <= t1 && isNoteOn(s.bytes));
  const stampedSends = noteSends.filter((s) => typeof s.ts === 'number' && s.ts > 0);
  const leads = stampedSends.map((s) => s.ts - s.t);
  out.late = { count: leads.filter((l) => l <= 0).length, lateByMs: stats(leads.filter((l) => l <= 0).map((l) => -l)) };
  out.requestedTimestamps = { withTs: stampedSends.length, total: noteSends.length, leadMs: stats(leads) };
  return out;
}

/**
 * The ramp run: the code holds 120 BPM, a silent track makes the port a clock instrument, a track plays one quiet note on every cycle
 * line, and the measurement driver steps the tempo from 100 to 120 BPM in 20 steps `args.ramp` ms apart. The loopback listener
 * sees every tick and note (arrival time); the page's own send log shows which sends were late. Returns the JSON object.
 */
async function runRamp(args, { client, cdp, browser }) {
  const { port, ramp: spacingMs, driver, busy } = args;
  const fromBpm = 100;
  const toBpm = 120;
  const steps = 20;
  const slowestCycleMs = 2400;
  // The last track is a sine far below what anyone hears: Chrome stops the audio output of a page that makes no sound at all
  // after about 25 seconds, and the clock's tick timestamps then jitter whatever the tempo does.
  const code = `setcpm(120/4)\nclock: silence.midi('${port}', { midichannel: 2 })\nbeat: note("c3").midi('${port}', { midichannel: 3, velocity: 0.01 })\nkeepalive: s("sine").gain(0.0006).slow(2)`;
  console.error(`${NAME}: ${(await callTool(client, 'set_code', { code, label: 'bench ramp' })).split('\n').slice(0, 3).join(' | ')}`);
  // The page-wide alignment warms up first: the clock's first tick on the port is the sign it runs.
  const ticking = await waitFor(cdp, 'window.__arrivals.some((a) => a.bytes.length === 1 && a.bytes[0] === 0xf8) ? true : null', 15000);
  if (ticking !== true) throw new ProbeCouldNotRun(`no clock tick arrived on "${port}" within 15 seconds; the page did not treat the port as a clock instrument`);
  await evaluateExpr(cdp, RAMP_DRIVER_SOURCE);
  await evaluateExpr(cdp, 'window.__arrivals.length = 0; window.__sends.length = 0; true');
  // One beat note per cycle on the loopback: three notes after a mark are two whole cycles.
  const waitTwoCycles = async (what) => {
    const mark = await evaluateExpr(cdp, 'window.__arrivals.length');
    const arrived = await waitFor(
      cdp,
      `window.__arrivals.slice(${mark}).filter((a) => a.bytes.length === 3 && (a.bytes[0] & 0xf0) === 0x90 && a.bytes[2] > 0).length >= 3 ? true : null`,
      4 * slowestCycleMs + 5000,
    );
    if (arrived !== true) throw new ProbeCouldNotRun(`two cycles of beat notes did not arrive on "${port}" ${what}`);
  };
  await evaluateExpr(cdp, `window.__rampProbe.set(${fromBpm})`);
  await waitTwoCycles('after the start tempo was set');
  const windowFrom = await evaluateExpr(cdp, 'performance.now()');
  const pageDriver = driver === 'interval' ? 'interval' : 'query';
  const applyDelayMs = driver === 'query-late' ? 25 : 0;
  await evaluateExpr(cdp, `window.__rampProbe.start(${JSON.stringify({ driver: pageDriver, fromBpm, toBpm, steps, spacingMs, busy, applyDelayMs })})`);
  const deadline = steps * spacingMs + slowestCycleMs + 5000;
  if ((await waitFor(cdp, 'window.__rampProbe.state().done ? true : null', deadline)) !== true) {
    throw new ProbeCouldNotRun(`the ${driver} ramp driver did not apply its last step within ${deadline} ms`);
  }
  await waitTwoCycles('after the last step');
  const windowTo = (await evaluateExpr(cdp, 'performance.now()')) - 500;
  const { log, errors } = await evaluateExpr(cdp, 'window.__rampProbe.state()');
  await evaluateExpr(cdp, 'window.__rampProbe.stop()');
  const { arrivals, sends } = JSON.parse(await evaluateExpr(cdp, 'JSON.stringify({ arrivals: window.__arrivals, sends: window.__sends })'));
  await callTool(client, 'stop', {});

  // Both logs go through the probe's tick statistics under one port name; the arrival log has no requested timestamp, so a
  // message counts at its arrival time (on a loopback, a stamped message arrives at the time it asked for).
  const entriesOf = (list, stamped) => list.map((entry) => ({ t: entry.t, port: 'loop', bytes: entry.bytes, ts: stamped ? entry.ts : null }));
  const options = { clockPort: 'loop', beatPort: 'loop', steps: log.map((step) => ({ landPerf: step.landPerf, bpm: step.bpm })), fromBpm, windowFrom, windowTo };
  const arrived = rampTickStats(entriesOf(arrivals, false), options);
  const sent = rampTickStats(entriesOf(sends, true), options);
  const sortedErrors = log.map((step) => step.lastEnd - step.plannedCycle).sort((a, b) => a - b);
  return {
    mode: 'ramp',
    driver,
    spacingMs,
    load: busy ? 'busy' : 'idle',
    steps: log.length,
    merged: log.filter((step) => step.merged).length,
    anchorsSeen: log.filter((step) => step.landed).length,
    stepErrorCycles: sortedErrors.length === 0 ? null : { p50: Math.round(sortedErrors[Math.floor((sortedErrors.length - 1) / 2)] * 1000) / 1000, max: Math.round(Math.max(...sortedErrors.map(Math.abs)) * 1000) / 1000 },
    arrival: { ticks: arrived.ticks, maxGapMs: arrived.maxGapMs, minGapMs: arrived.minGapMs, holes: arrived.holes, doubled: arrived.doubled, ticksPerCycle: { cycles: arrived.ticksPerCycle.cycles, min: arrived.ticksPerCycle.min, max: arrived.ticksPerCycle.max } },
    send: { ticks: sent.ticks, late: sent.late, aheadMs: sent.aheadMs, starts: sent.starts },
    driverErrors: errors,
    port,
    browser,
  };
}

/** The tail scenarios: the note-ons that still arrive after Stop, after muting a track and after a sound change. */
async function runTail(args, { client, cdp }) {
  const { port, cpm, perCycle } = args;
  const play = (label, note, sound) => `setcpm(${cpm})\n${label}: note("${note}*${perCycle}").midi('${port}', { midichannel: 3, velocity: 0.01, sound: '${sound}' })`;
  const readArrivals = async () => JSON.parse(await evaluateExpr(cdp, 'JSON.stringify(window.__arrivals)'));
  const reset = () => evaluateExpr(cdp, 'window.__arrivals.length = 0; window.__sends.length = 0; window.__stopAt = null; true');
  // A note-on after the marker is ended when a note-off of the same channel and pitch arrives within 2 ms after it.
  const ended = (arrivals, on) => arrivals.some((o) => isNoteOff(o.bytes) && (o.bytes[0] & 0x0f) === (on.bytes[0] & 0x0f) && o.bytes[1] === on.bytes[1] && o.t >= on.t && o.t - on.t <= 2);
  const noteOnsAfter = (arrivals, marker, pitch) =>
    arrivals.filter((a) => isNoteOn(a.bytes) && (pitch === undefined || a.bytes[1] === pitch) && a.t > marker + 0.5);
  const lines = [];

  // `markerOf` finds the instant the scenario is measured from, in the page's own performance.now() time.
  async function silenceScenario(scenario, act, markerOf) {
    await callTool(client, 'set_code', { code: play('n', 'c3', 'AcouPiano 1'), label: `${scenario} play` });
    await sleep(3500);
    await reset();
    await act();
    await sleep(1500);
    const arrivals = await readArrivals();
    const marker = await markerOf(arrivals);
    if (marker === undefined || marker === null) throw new ProbeCouldNotRun(`--tail: no marker for ${scenario} on "${port}" (no silence seen, or Stop never reached the audio context)`);
    const after = noteOnsAfter(arrivals, marker);
    lines.push({
      mode: 'tail',
      scenario,
      noteOnsAfterMs: after.map((a) => Math.round(a.t - marker)),
      unendedAfterMs: after.filter((a) => !ended(arrivals, a)).map((a) => Math.round(a.t - marker)),
    });
  }
  // The silence of a mute goes out at once, so its first sustain release (CC64) is the marker. Stop's panic only goes out
  // after the audio context suspends, so the CC64 would come after notes that already sounded between the Stop and the
  // suspend and leave them out of the count: Stop is measured from the moment the page suspends the context, which
  // happens in the same synchronous step as the end of the queued notes.
  const firstSustainRelease = (arrivals) => arrivals.find((a) => a.bytes.length === 3 && (a.bytes[0] & 0xf0) === 0xb0 && a.bytes[1] === 64)?.t;
  await silenceScenario(
    'stop',
    async () => {
      await callTool(client, 'stop', {});
    },
    () => evaluateExpr(cdp, 'window.__stopAt'),
  );
  await silenceScenario(
    'mute',
    async () => {
      await callTool(client, 'set_code', { code: play('n_', 'c3', 'AcouPiano 1'), label: 'mute' });
    },
    firstSustainRelease,
  );

  // Sound change: the old code plays c3, the new code c4 with another sound; old notes after the program change are the problem.
  await callTool(client, 'set_code', { code: play('n', 'c3', 'AcouPiano 1'), label: 'sound change play' });
  await sleep(3500);
  await reset();
  await callTool(client, 'set_code', { code: play('n', 'c4', 'AcouPiano 2'), label: 'sound change' });
  await sleep(2500);
  const arrivals = await readArrivals();
  const programChange = arrivals.find((a) => a.bytes.length === 2 && a.bytes[0] === 0xc2);
  const oldAfter = programChange ? noteOnsAfter(arrivals, programChange.t, 48) : [];
  const firstNew = programChange ? noteOnsAfter(arrivals, programChange.t, 60)[0] : undefined;
  lines.push({
    mode: 'tail',
    scenario: 'sound change',
    programChangeSeen: !!programChange,
    oldNoteOnsAfterProgramChangeMs: programChange ? oldAfter.map((a) => Math.round(a.t - programChange.t)) : null,
    unendedOldAfterMs: programChange ? oldAfter.filter((a) => !ended(arrivals, a)).map((a) => Math.round(a.t - programChange.t)) : null,
    firstNewNoteAfterProgramChangeMs: firstNew ? Math.round(firstNew.t - programChange.t) : null,
  });
  await callTool(client, 'stop', {});
  return lines;
}

/** The messages of the settings run: a bank select, a program change or a message starting with F0. */
const NRPN_CONTROLS = [99, 98, 6, 101, 100];
const isSetupMessage = (bytes, nrpn = false) =>
  bytes[0] === 0xf0 ||
  (bytes.length === 2 && (bytes[0] & 0xf0) === 0xc0) ||
  (bytes.length === 3 && (bytes[0] & 0xf0) === 0xb0 && (bytes[1] === 0 || bytes[1] === 32 || (nrpn && NRPN_CONTROLS.includes(bytes[1]))));
const hexOf = (bytes) => bytes.map((byte) => byte.toString(16).toUpperCase().padStart(2, '0')).join(' ');

/**
 * The settings run: a base piece that plays channel 1 with a sound settles, then the valid settings piece replaces it and the
 * bank selects, program changes and data sets that arrive on the loopback input are compared with the ones the documented rules give
 * (settingsValidSent, built by the probe independently of the page) and with the page's own send log.
 */
async function runSettings(args, { client, cdp, browser }) {
  const { port } = args;
  const engines = args.settingsPiece === 'engines';
  const offsets = args.settingsPiece === 'offsets';
  const timbres = args.settingsPiece === 'timbres';
  // Low velocity, like the other runs: the notes are not meant to be heard.
  const quiet = ', velocity: 0.01';
  const base = timbres
    ? `lead: note("c3 e3 g3 c4").midi('${port}', { midichannel: 2, sound: 'Own Timbre'${quiet} })`
    : `lead: note("c3 e3 g3 c4").midi('${port}', { midichannel: 1, sound: '${offsets ? 'Own Tone' : 'Model Tone'}'${quiet} })`;
  await callTool(client, 'set_code', { code: base, label: 'bench settings base' });
  await callTool(client, 'get_midi_instruments', {});
  await sleep(3000);
  await evaluateExpr(cdp, 'window.__arrivals.length = 0; window.__sends.length = 0; true');
  const piece = timbres ? timbreSettingsPiece(port, quiet) : offsets ? offsetSettingsPiece(port, quiet) : engines ? engineSettingsPiece(port, quiet) : settingsValidPiece(port, 600, quiet);
  const reply = await callTool(client, 'set_code', { code: piece, label: 'bench settings' });
  console.error(`${NAME}: ${reply.split('\n').slice(0, 3).join(' | ')}`);
  await sleep(4000);
  const arrivals = JSON.parse(await evaluateExpr(cdp, 'JSON.stringify(window.__arrivals)')).filter((a) => isSetupMessage(a.bytes, offsets));
  // One send can hold several messages (the five control changes of an NRPN set), so the log is cut into messages first.
  const loggedSends = JSON.parse(await evaluateExpr(cdp, 'JSON.stringify(window.__sends)')).filter((s) => s.port.includes(port));
  await callTool(client, 'stop', {});
  const expected = timbres ? timbreSettingsSent() : offsets ? offsetSettingsSent() : engines ? engineSettingsSent() : settingsValidSent();
  const arrived = arrivals.map((a) => a.bytes);
  const sent = splitSentMessages(loggedSends.map((s) => s.bytes)).filter((bytes) => isSetupMessage(bytes, offsets));
  const asText = (list) => list.map(hexOf);
  // The messages of `list` left over after one message of `other` is taken away for each match, as hex.
  const without = (list, other) => {
    const left = asText(other);
    return asText(list).filter((text) => {
      const at = left.indexOf(text);
      if (at < 0) return true;
      left.splice(at, 1);
      return false;
    });
  };
  const identical = JSON.stringify(asText(arrived).sort()) === JSON.stringify(asText(expected).sort());
  const inOrder = JSON.stringify(arrived) === JSON.stringify(expected);
  const longest = Math.max(arrived.length, expected.length);
  let firstDifference = null;
  for (let index = 0; index < longest; index++) {
    if (JSON.stringify(arrived[index] ?? null) !== JSON.stringify(expected[index] ?? null)) {
      firstDifference = { index, expected: expected[index] === undefined ? null : hexOf(expected[index]), arrived: arrived[index] === undefined ? null : hexOf(arrived[index]) };
      break;
    }
  }
  // The gap between the program change of the channel that changes its sound (channel 2, or channel 3 for the timbres piece) and the first
  // data set that follows it, on the arrival clock.
  const programStatus = timbres ? 0xc2 : 0xc1;
  const programIndex = arrivals.findIndex((a) => a.bytes.length === 2 && a.bytes[0] === programStatus);
  const programAt = programIndex < 0 ? undefined : arrivals[programIndex];
  const firstAfter = programAt === undefined ? undefined : arrivals.slice(programIndex + 1).find((a) => a.bytes[0] === 0xf0 || (offsets && a.bytes[1] === 99));
  return {
    mode: 'settings',
    port,
    browser,
    piece: args.settingsPiece,
    expected: asText(expected),
    arrived: asText(arrived),
    identical,
    inOrder,
    firstDifference,
    programToFirstSettingMs: programAt === undefined || firstAfter === undefined ? null : round2(firstAfter.t - programAt.t),
    sentEqualsArrived: JSON.stringify(sent) === JSON.stringify(arrived),
    arrivedNotSent: without(arrived, sent),
    sentNotArrived: without(sent, arrived),
  };
}

/** The tempos of the --input runs, in beats (cycles are four beats) per minute. */
const INPUT_TEMPOS = [60, 90, 120, 140, 180];
const INPUT_MARGIN_MS = 6;
/** The pitch (C3) of the quiet notes the bench sends itself in the --input runs; they go out on channel 3, which the MT-32 of the setup file declares. */
const INPUT_PITCH = 48;

/**
 * The --input run. The page listens to the port as a keyboard; its own placement is read from the Scratchpad's read-outs by a script in the
 * bench's tab (a MutationObserver over data-heard-cycle, which keeps every value even when two notes arrive in one task).
 * Music playing: the page plays a quiet note grid on the port, hears it come back and places it; each heard cycle x should be the grid
 * place round(x * perCycle) / perCycle, and its error is (x - place) * 1000 / cps milliseconds. Music stopped (tempo kept): the bench sends
 * note-ons stamped on the grid through the native output and the error of note k is ((x_k - x_0) - k / perCycle) * 1000 / cps.
 */
async function runInput(args, { client, cdp, browser }) {
  const { port, perCycle } = args;
  const view = `document.getElementById('scratch-view')`;
  await evaluateExpr(cdp, `(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); })()`);
  await pressKey(cdp, 'Escape');
  await pressKey(cdp, '7');
  if ((await waitFor(cdp, `document.getElementById('workspace').dataset.view === 'scratchpad' ? true : null`, 3000)) !== true) {
    throw new ProbeCouldNotRun('the Scratchpad did not open');
  }
  // Every value of the heard cycle, with the source and the time the change was seen. With two changes in one callback the source is the
  // one read-out value of the end of the task, which only differs at a Play or a Stop, not inside a run.
  await evaluateExpr(
    cdp,
    `(() => {
      window.__heardLog = [];
      const view = ${view};
      new MutationObserver((records) => {
        const seen = performance.now();
        records.forEach((record, i) => {
          const value = i + 1 < records.length ? records[i + 1].oldValue : view.dataset.heardCycle;
          if (value === '' || value === null || value === undefined) return;
          window.__heardLog.push({ seen, cycle: Number(value), source: view.dataset.heardSource, pitch: view.dataset.heardPitch });
        });
      }).observe(view, { attributes: true, attributeFilter: ['data-heard-cycle'], attributeOldValue: true });
      return true;
    })()`,
  );
  const heardSince = async (mark, source) =>
    JSON.parse(await evaluateExpr(cdp, 'JSON.stringify(window.__heardLog)')).filter((entry) => entry.seen >= mark && entry.source === source);
  // Polls the log until `done(entries)` says so, or the time is over; returns what the log holds then.
  const collect = async (mark, source, done, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const entries = await heardSince(mark, source);
      if (done(entries) || Date.now() > deadline) return entries;
      await sleep(150);
    }
  };
  const summarize = (bpm, music, errors, wanted) => {
    const sizes = errors.map(Math.abs);
    const worst = sizes.length ? Math.max(...sizes) : null;
    const mean = sizes.length ? sizes.reduce((a, b) => a + b, 0) / sizes.length : null;
    return {
      bpm,
      music,
      notes: errors.length,
      worstMs: worst === null ? null : round2(worst),
      meanMs: mean === null ? null : round2(mean),
      pass: errors.length === wanted && worst !== null && worst <= INPUT_MARGIN_MS,
    };
  };
  // The page says whether it listens; one press of its own Allow button if MIDI was not allowed when it loaded.
  const waitListening = async () => {
    const word = await waitFor(cdp, `${view}.dataset.listen === 'listening' ? true : null`, 6000);
    if (word === true) return;
    const state = await evaluateExpr(cdp, `${view}.dataset.listen`);
    if (state === 'needs-permission' || state === 'failed') await evaluateExpr(cdp, `document.getElementById('scratch-allow').click()`);
    if ((await waitFor(cdp, `${view}.dataset.listen === 'listening' ? true : null`, 10000)) !== true) {
      const sentence = await evaluateExpr(cdp, `document.getElementById('scratch-listen-state').textContent`);
      throw new ProbeCouldNotRun(`the page does not listen to "${port}": ${sentence}`);
    }
  };

  const runs = [];
  for (const bpm of INPUT_TEMPOS) {
    const cps = bpm / 240;
    const cycleMs = 1000 / cps;
    const code = `setcps(${cps})\nn: note("c3*${perCycle}").midi('${port}', { midichannel: 3, velocity: 0.01 })`;
    console.error(`${NAME}: ${bpm} BPM, music playing`);
    const reply = await callTool(client, 'set_code', { code, label: `bench input ${bpm}` });
    console.error(`${NAME}: ${reply.split('\n').slice(0, 3).join(' | ')}`);
    await waitListening();
    await sleep(3000); // settle: the page-wide alignment warm-up
    const wantedPlaying = 4 * perCycle;
    const mark = await evaluateExpr(cdp, 'performance.now()');
    const playing = await collect(mark, 'music', (entries) => entries.length >= wantedPlaying + 1, 7 * cycleMs + 4000);
    // The first note heard sets the first place; the next 4 * perCycle places must follow it one by one.
    const errorsPlaying = [];
    if (playing.length > 0) {
      const first = Math.round(playing[0].cycle * perCycle);
      for (let k = 0; k < wantedPlaying; k++) {
        const hits = playing.filter((entry) => Math.round(entry.cycle * perCycle) === first + k);
        if (hits.length === 1) errorsPlaying.push(((hits[0].cycle - (first + k) / perCycle) * 1000) / cps);
        else if (hits.length > 1) errorsPlaying.push(Infinity); // a note heard twice reads as a failure, never as a good one
      }
    }
    runs.push(summarize(bpm, 'playing', errorsPlaying, wantedPlaying));

    console.error(`${NAME}: ${bpm} BPM, music stopped`);
    await callTool(client, 'stop', {});
    await sleep(1500); // the page's transport word is read by a poll
    const wantedStopped = 2 * perCycle;
    const stepMs = cycleMs / perCycle;
    const markStopped = await evaluateExpr(cdp, 'performance.now()');
    await evaluateExpr(
      cdp,
      `(() => {
        const out = window.__benchOut;
        if (!out) throw new Error('the loopback output is not open');
        const t0 = performance.now() + 400;
        for (let k = 0; k < ${wantedStopped}; k++) {
          out.send([0x92, ${INPUT_PITCH}, 1], t0 + k * ${stepMs});
          out.send([0x82, ${INPUT_PITCH}, 0], t0 + k * ${stepMs} + ${Math.min(40, stepMs / 2)});
        }
        return t0;
      })()`,
    );
    const stopped = await collect(markStopped, 'free', (entries) => entries.length >= wantedStopped + 1, wantedStopped * stepMs + 4000);
    const errorsStopped = [];
    if (stopped.length > 0) {
      for (let k = 0; k < Math.min(stopped.length, wantedStopped); k++) {
        errorsStopped.push(((stopped[k].cycle - stopped[0].cycle - k / perCycle) * 1000) / cps);
      }
    }
    runs.push(summarize(bpm, 'stopped', errorsStopped, wantedStopped));
  }
  await callTool(client, 'stop', {});
  return { mode: 'input', port, browser, perCycle, marginMs: INPUT_MARGIN_MS, runs, pass: runs.length === 2 * INPUT_TEMPOS.length && runs.every((run) => run.pass) };
}

async function main() {
  let args;
  try {
    args = parseBenchArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`${NAME} COULD NOT RUN: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 2;
    return;
  }
  try {
    const rig = benchRig(args);
    const enginesPiece = args.settingsPiece === 'engines';
    const offsetsPiece = args.settingsPiece === 'offsets';
    const timbresPiece = args.settingsPiece === 'timbres';
    const settingsId = timbresPiece ? 'timbresynth' : offsetsPiece ? 'offsetsynth' : enginesPiece ? 'enginesynth' : 'tonesynth';
    const settingsRig = args.settings ? { id: settingsId, model: settingsId, port: args.port } : null;
    const settingsFiles = args.settings
      ? [
          { relative: `models/${settingsId}.json`, content: JSON.stringify(timbresPiece ? timbreSynthModel() : offsetsPiece ? offsetSynthModel() : enginesPiece ? engineSynthModel() : toneSynthModel()) },
          ...(offsetsPiece || timbresPiece ? [] : [{ relative: `catalogs/${settingsId}.json`, content: JSON.stringify(enginesPiece ? engineSynthCatalog() : toneSynthCatalog()) }]),
        ]
      : [];
    await withBenchPage(args, settingsRig ?? rig, async (page) => {
      if (args.input) {
        console.log(JSON.stringify(await runInput(args, page)));
      } else if (args.settings) {
        console.log(JSON.stringify(await runSettings(args, page)));
      } else if (args.tail) {
        for (const line of await runTail(args, page)) console.log(JSON.stringify({ ...line, port: args.port, browser: page.browser }));
      } else if (args.ramp !== null) {
        console.log(JSON.stringify(await runRamp(args, page)));
      } else {
        console.log(JSON.stringify(await runTiming(args, page)));
      }
    }, settingsFiles, args.input ? [args.port] : []);
    process.exitCode = 0;
  } catch (err) {
    if (err instanceof ProbeCouldNotRun) {
      console.error(`${NAME} COULD NOT RUN: ${err.message}`);
    } else {
      console.error(`${NAME} COULD NOT RUN: unexpected error: ${err instanceof Error ? err.stack || err.message : String(err)}`);
    }
    process.exitCode = 2;
  }
}

// Runs only when executed directly, like scripts/probe-midi.mjs.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
