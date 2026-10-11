#!/usr/bin/env node
// Developer bench: what does Claude save by changing one value of a long piece with edit_code instead of sending the
// whole program with set_code? A real headless Chrome runs the real Moontide page and a real MCP client calls both
// tools on pieces of about 10, 40 and 80 lines. Run it with `npm run bench:edit`; it is not part of `npm test`.
//
//   npm run bench:edit -- [--runs N] [--headful] [--browser PATH]
//     --runs N           calls per tool and per size, default 10 (the two tools are interleaved: set_code first on
//                        even runs, edit_code first on odd runs, so a slow moment of the page does not favor one tool)
//     --headful          a real browser window instead of headless
//     --browser PATH     the Chromium-based browser to drive (default: found like the probes do)
//
// What it measures, per tool and per size: the characters Claude sends (the length of the JSON arguments), the
// characters of the reply, and the milliseconds from the call to its reply. For a change at 'now' the reply comes after
// the page evaluated the program and watched its first cycle, so the change is audible by then. After every call (not
// timed) it reads get_code and stops with an error unless both tools produced the same code.
// What it cannot measure: how long Claude takes to write the arguments. That time grows with the characters Claude
// writes; it can only be estimated from the character counts, not measured.
//
// Output: one JSON line per size on stdout. Exit code 0 when the bench ran, 2 when it could not (one line starting with
// "bench:edit COULD NOT RUN" on stderr names the cause).
//
// Side effects: the bench starts its own Moontide server on a free port and its own browser profile in temporary
// folders and removes them at the end. The pieces are silent (gain 0). It never touches a Moontide server that is
// already running. Do not run it at the same time as `npm test`, `npm run probe:page` or `npm run probe:midi`.
import { pathToFileURL } from 'node:url';
import {
  ProbeCouldNotRun,
  callTool,
  clickOverlay,
  closeBrowser,
  closeBrowserOnSignal,
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

const NAME = 'bench:edit';
const SIZES = [10, 40, 80];

/** Parses the bench's own options. Throws an Error that names the problem (the caller prints it, exit code 2). */
function parseBenchArgs(argv) {
  const result = { runs: 10, headful: false, browserPath: null };
  const need = (flag, i) => {
    const value = argv[i];
    if (value === undefined || value.startsWith('--') || value.trim() === '') throw new Error(`${flag} needs a value`);
    return value;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--headful') result.headful = true;
    else if (arg === '--browser') result.browserPath = need(arg, ++i);
    else if (arg === '--runs') {
      const raw = need(arg, ++i);
      const value = Number(raw);
      if (!Number.isInteger(value) || value < 2) throw new Error(`--runs needs a whole number of at least 2, got "${raw}"`);
      result.runs = value;
    } else throw new Error(`unknown option "${arg}"`);
  }
  return result;
}

/**
 * A silent piece of exactly `lines` lines: 'setcps(1);', then tracks of five lines, then one-line tracks for the
 * rest. Every lpf value is unique (1000 + 7 * track index, plus 1 for the moved value), so one old_string matches once.
 * `value` is the lpf value of the first track, which every call moves.
 */
function buildPiece(lines, value) {
  const out = ['setcps(1);'];
  let track = 0;
  const lpf = () => (track === 0 ? value : 1000 + 7 * track);
  while (out.length + 5 <= lines) {
    out.push(`t${track + 1}: note("c3 e3 g3")`, '  .s("sawtooth")', `  .lpf(${lpf()})`, '  .room(0.1)', '  .gain(0)');
    track++;
  }
  while (out.length < lines) {
    out.push(`r${track + 1}: s("hh").lpf(${lpf()}).gain(0)`);
    track++;
  }
  return out.join('\n');
}

const median = (xs) => {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const round1 = (x) => Math.round(x * 10) / 10;

function summary(samples) {
  const ms = samples.map((s) => s.ms);
  return {
    sentChars: samples[0].sentChars,
    replyChars: Math.round(median(samples.map((s) => s.replyChars))),
    medianMs: round1(median(ms)),
    minMs: round1(Math.min(...ms)),
    maxMs: round1(Math.max(...ms)),
  };
}

/** One size: the piece set once (untimed), then `runs` interleaved calls per tool, each checked against get_code. */
async function runSize(client, lines, runs) {
  const base = 1000;
  await callTool(client, 'set_code', { code: buildPiece(lines, base), label: 'bench edit base' });
  await sleep(1500);
  let value = base;
  const samples = { set_code: [], edit_code: [] };

  async function oneCall(tool) {
    const from = value;
    const to = value === base ? base + 1 : base;
    const args =
      tool === 'set_code'
        ? { code: buildPiece(lines, to) }
        : { edits: [{ old_string: `.lpf(${from})`, new_string: `.lpf(${to})` }] };
    const sentChars = JSON.stringify(args).length;
    const start = performance.now();
    const reply = await callTool(client, tool, args);
    const ms = performance.now() - start;
    value = to;
    const expected = buildPiece(lines, to);
    const got = await callTool(client, 'get_code', {});
    if (got !== expected && !got.startsWith(`${expected}\n\n`)) {
      throw new Error(`${tool} on ${lines} lines did not produce the expected code (got ${got.length} characters, expected ${expected.length})`);
    }
    samples[tool].push({ sentChars, replyChars: reply.length, ms });
    await sleep(200);
  }

  for (let run = 0; run < runs; run++) {
    const order = run % 2 === 0 ? ['set_code', 'edit_code'] : ['edit_code', 'set_code'];
    for (const tool of order) await oneCall(tool);
  }
  return {
    size: lines,
    lines,
    programChars: buildPiece(lines, base).length,
    runs,
    set_code: summary(samples.set_code),
    edit_code: summary(samples.edit_code),
  };
}

/** Starts the server and the browser, runs `body`, and cleans everything up. */
async function withBenchPage(args, body) {
  const tempDirs = [];
  let client;
  let child;
  let ws;
  try {
    const started = await startServerAndClient();
    client = started.client;
    tempDirs.push(started.dataDir);
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
    await body({ client });
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
    await withBenchPage(args, async ({ client }) => {
      for (const lines of SIZES) console.log(JSON.stringify(await runSize(client, lines, args.runs)));
      await callTool(client, 'stop', {});
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

// Runs only when executed directly, like scripts/bench-midi-timing.mjs.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
