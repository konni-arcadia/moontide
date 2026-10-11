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
// Side effects: low-velocity notes on the port and, with --clock or --tail, a rig file in the bench's own temporary
// data folder that names an MT-32 on that port, so the page sends that model's setup bytes there. Nothing should
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
  removeTempDirs,
  sleep,
  spawnBrowser,
  startServerAndClient,
  waitConnected,
  waitSocketOpen,
} from './probe-page.mjs';

const NAME = 'bench:midi';
const DEFAULT_PORT = 'IAC Driver Bus 1';

/** Parses the bench's own options. Throws an Error that names the problem (the caller prints it, exit code 2). */
function parseBenchArgs(argv) {
  const result = { port: DEFAULT_PORT, seconds: 10, cpm: 25, perCycle: 96, busy: false, clock: false, tail: false, headful: false, browserPath: null };
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
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--busy') result.busy = true;
    else if (arg === '--clock') result.clock = true;
    else if (arg === '--tail') result.tail = true;
    else if (arg === '--headful') result.headful = true;
    else if (arg === '--port') result.port = need(arg, ++i);
    else if (arg === '--seconds') result.seconds = positive(arg, ++i, false);
    else if (arg === '--cpm') result.cpm = positive(arg, ++i, false);
    else if (arg === '--per-cycle') result.perCycle = positive(arg, ++i, true);
    else if (arg === '--browser') result.browserPath = need(arg, ++i);
    else throw new Error(`unknown option "${arg}"`);
  }
  if (result.tail && (result.busy || result.clock)) throw new Error('--tail cannot be combined with --busy or --clock');
  // The port name goes into a Strudel string: keep it free of characters that would end the string.
  if (/['\\\n\r]/.test(result.port)) throw new Error('--port must not contain a quote, a backslash or a line break');
  return result;
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
    if (!input) return { found: false, inputs: inputs.map((i) => i.name), outputs };
    input.onmidimessage = (e) => window.__arrivals.push({ t: e.timeStamp, bytes: Array.from(e.data) });
    await input.open();
    // The busy load: blocks the main thread for 30 to 90 ms every 200 ms while it is on.
    window.__setLoad = (on) => { clearInterval(window.__loadTimer); window.__loadTimer = null; if (!on) return; window.__loadTimer = setInterval(() => { const end = performance.now() + 60 * (0.5 + Math.random()); while (performance.now() < end) {} }, 200); };
    return { found: true, inputs: [], outputs };
  })()`;
}

/** Starts the server, the browser and the loopback listener, and runs `body`. Everything is cleaned up afterwards. */
async function withBenchPage(args, rig, body) {
  const tempDirs = [];
  let client;
  let child;
  let ws;
  try {
    const started = await startServerAndClient();
    client = started.client;
    tempDirs.push(started.dataDir);
    if (rig) fs.writeFileSync(path.join(started.dataDir, 'instruments.json'), JSON.stringify({ instruments: [rig] }));
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
    // --clock and --tail need a rig: an MT-32 on the port (with a clock for --clock), so the page sends its setup bytes there.
    const rig = args.clock ? { id: 'seq', model: 'mt32', port: args.port, clock: true } : args.tail ? { id: 'seq', model: 'mt32', port: args.port } : null;
    await withBenchPage(args, rig, async (page) => {
      if (args.tail) {
        for (const line of await runTail(args, page)) console.log(JSON.stringify({ ...line, port: args.port, browser: page.browser }));
      } else {
        console.log(JSON.stringify(await runTiming(args, page)));
      }
    });
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
