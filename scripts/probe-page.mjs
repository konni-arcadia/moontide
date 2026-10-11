#!/usr/bin/env node
// Developer check: drives the real Moontide page through a real MCP client, exactly the
// way Claude drives it (set_code), and a real Chromium-based browser (Chrome DevTools Protocol
// over Node's global WebSocket) to prove whether the pinned Strudel bundle's `pat.timeline(id)`
// keeps a transition's anchor across a later change. Every fact this proves is read straight from
// the live page — nothing here is assumed from the bundle's minified text. Node built-ins, the
// project's own `@modelcontextprotocol/sdk` client and Node 22's global `fetch`/`WebSocket` only:
// no new dependency. This script never evaluates, runs or imports downloaded code itself — driving
// a real browser through CDP is the only way to observe the pinned bundle's actual runtime
// behavior; the browser runs page/index.html exactly as shipped, including its `integrity`-pinned
// `<script>` tag.
//
// Not imported from test/ (the probe must stand on its own outside the test suite): the MCP
// stdio-client bootstrap mirrors test/helpers.js startMcpClient() rather than importing it.
//
// It also checks sound loading — that a comma-path VCSL sound loads from the
// pinned jsDelivr host, and that a sound failing after set_code already answered reaches Claude
// named, with its version, on the next tool call.
//
// Tracks and views: it also drives real key presses (Input.dispatchKeyEvent) to prove
// the Timeline view against the live page — the pinned acorn parser, a real 32-cycle query whose
// lanes match the real playing pattern, and that view keys are inert while the code has focus.
//
// Top bar: the bar's contracts (test/bar-inventory.js) run as the "bar invariants" and "bar helpers"
// checks of barBlocks(), once before the final summary of a full run, or alone with `--only bar` (about a minute).
// Harmony: the declaration checks of harmonyBlocks() run once before the final summary of a full run, or
// alone with `--only harmony` (about a minute).
// Load failure notice: the checks of loadFailureBlocks() block the Strudel and acorn scripts by address in tabs of their own
// and run once before the final summary of a full run, or alone with `--only load-failure`.
// Identity: the checks of identityBlocks() prove in real Chrome that the tab title and the Session card name the folder and
// the port of the server, that the replies say the same, and that a long folder name wraps without clipping; they run
// once before the final summary of a full run, or alone with `--only identity`.
// Every probe that stops the music calls stopMusic(), which refuses to click unless the state word says Playing.

import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { BUILD_MISMATCH_COPY, CONNECTION_LABELS, QUERY_ERROR_LEAD, SERVER_UPDATED_COPY, SOUND_LABELS, VCSL_SAMPLE_BASE } from '../page/ui-state.js';
import { MIDI_COPY, fill } from '../page/midi-plan.js';
import { INSTRUMENTS_COPY } from '../page/instruments-model.js';
import { TIMELINE_COPY } from '../page/timeline.js';
import { VIEW_KEYS, layoutButtonParts, viewButtonParts } from '../page/views.js';
import { MIXER_COPY } from '../page/mixer-model.js';
import { arrangementPosition, PARTS_COPY, partsEmptyText, partsSkippedText } from '../page/parts.js';
import { ASK_COPY, PAGE_REQUESTS_COPY, PAGE_TOKEN_PLACEHOLDER, cycleAt, errorAskPrefill, waitingShortText } from '../page/ask.js';
import { QUERY_REFUSAL_LEAD } from '../page/query-check.js';
import { BAR_COPY, stripModel, tempoText } from '../page/bar-model.js';
import { CHANGE_COPY, countdownParts, queuedLine, settingLine, timingOptions } from '../page/change-timing.js';
import { ACCENT_EXEMPT_TODAY, BAR_INVENTORY, BAR_WIDTHS, SHOT_LAYOUTS, SHOT_SIZES, SHOT_SKIPPED, SHOT_STATES, SIZED_CONTROLS, WORST_CASE, shotFileNames } from '../test/bar-inventory.js';
import { STILL_PLAYING_TAIL, STILL_STOPPED_TAIL, loadFailureNote } from '../dist/session.js';
import { sessionLabel } from '../dist/session-label.js';
import { LOAD_FAILURE_COPY } from '../page/load-failure.js';

const DIST_ENTRY = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const PAGE_URL_PATTERN = /Moontide page: (http:\/\/localhost:(\d+))/;

/** Thrown when the probe itself could not be driven to a verdict (exit 2) — distinct from a
 * behavior FAIL (exit 1), which means the probe ran fully and a check failed. */
export class ProbeCouldNotRun extends Error {}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** The real path of `target` even when it does not exist yet: the nearest existing ancestor is resolved (symlinks and
 * all) and the missing tail is put back, so a folder that would be created through a link into the repository is seen. */
function realPathOfFuture(target) {
  const tail = [];
  let current = target;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    tail.unshift(path.basename(current));
    current = parent;
  }
  return path.join(fs.realpathSync(current), ...tail);
}

/** Where the screenshots go (MOONTIDE_PROBE_SHOTS): null when the variable is unset or empty, so nothing is saved. A
 * folder inside the repository is refused with ProbeCouldNotRun (exit 2) before any browser work, because a picture of
 * the page can show local state and would be committed by accident. Creates the folder; returns its resolved path. */
export function shotsFolder(env = process.env) {
  const raw = env.MOONTIDE_PROBE_SHOTS;
  if (raw === undefined || raw.trim() === '') return null;
  const resolved = path.resolve(raw);
  const root = fs.realpathSync(REPO_ROOT);
  for (const candidate of [resolved, realPathOfFuture(resolved)]) {
    const relative = path.relative(root, candidate);
    const leaves = relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
    if (!leaves) throw new ProbeCouldNotRun('MOONTIDE_PROBE_SHOTS must name a folder outside the repository');
  }
  fs.mkdirSync(resolved, { recursive: true });
  return resolved;
}

/** --headful (real window instead of headless), --browser <path> (skip discovery), --only <group> (run only one
 * group of checks after the clock check; the groups are "bar", the top bar invariants, "harmony", the harmony
 * declaration checks, "load-failure", the notice for a page whose scripts did not load, and "identity", the tab
 * title and the Session card row that name the session, each about a minute instead of nine: `npm run probe:page -- --only bar`).
 * `only` is null for a full run. */
export function parseArgs(argv) {
  const result = { headful: false, browserPath: null, only: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--headful') {
      result.headful = true;
    } else if (arg === '--browser') {
      const value = argv[++i];
      if (value === undefined || value.trim() === '') throw new ProbeCouldNotRun('--browser needs a path');
      result.browserPath = value;
    } else if (arg === '--only') {
      const value = argv[++i];
      if (value !== 'bar' && value !== 'harmony' && value !== 'load-failure' && value !== 'identity') {
        throw new ProbeCouldNotRun(`--only needs a group name; the groups are "bar", "harmony", "load-failure" and "identity" (got ${JSON.stringify(value ?? null)})`);
      }
      result.only = value;
    } else {
      throw new ProbeCouldNotRun(`unknown flag "${arg}"`);
    }
  }
  return result;
}

function findOnPath(name) {
  const pathEnv = process.env.PATH || '';
  const exts = process.platform === 'win32' ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of pathEnv.split(path.delimiter)) {
    if (dir === '') continue;
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** Resolves the Chromium-based browser to drive: --browser, then MOONTIDE_PROBE_BROWSER, then the
 * standard install locations for the current platform, in order. Throws ProbeCouldNotRun (never
 * silently substitutes a different browser) listing every location tried. */
export function findBrowser({ browserPath } = {}) {
  if (browserPath) {
    if (!fs.existsSync(browserPath)) {
      throw new ProbeCouldNotRun(`no Chromium-based browser found (tried: --browser ${browserPath})`);
    }
    return browserPath;
  }
  const envOverride = process.env.MOONTIDE_PROBE_BROWSER;
  if (envOverride) {
    if (!fs.existsSync(envOverride)) {
      throw new ProbeCouldNotRun(`no Chromium-based browser found (tried: MOONTIDE_PROBE_BROWSER=${envOverride})`);
    }
    return envOverride;
  }

  const tried = [];
  if (process.platform === 'darwin') {
    const candidates = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ];
    for (const candidate of candidates) {
      tried.push(candidate);
      if (fs.existsSync(candidate)) return candidate;
    }
  } else if (process.platform === 'win32') {
    const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const localAppData = process.env['LocalAppData'] || '';
    const candidates = [
      path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      localAppData ? path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe') : null,
      path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ].filter(Boolean);
    for (const candidate of candidates) {
      tried.push(candidate);
      if (fs.existsSync(candidate)) return candidate;
    }
  } else {
    const names = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge'];
    for (const name of names) {
      tried.push(name);
      const found = findOnPath(name);
      if (found) return found;
    }
  }
  throw new ProbeCouldNotRun(`no Chromium-based browser found (tried: ${tried.join(', ')})`);
}

/** How many versions the probe's seeded history holds before the server records anything. */
export const SEED_VERSION_COUNT = 105;

/**
 * The lines of a seeded history.jsonl, as text: a session start on 2026-01-01, versions 1 to 60,
 * a second session start on 2026-01-02, the rest of the versions, and one favorite on version 60.
 * Neutral text only. The lines carry no parent, so they read as legacy lines.
 */
export function seedHistoryLines(count = SEED_VERSION_COUNT) {
  const isoSeconds = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const firstSession = Math.min(60, count);
  const dayOne = Date.UTC(2026, 0, 1, 9, 0, 0);
  const dayTwo = Date.UTC(2026, 0, 2, 9, 0, 0);
  const lines = [{ type: 'session-start', at: isoSeconds(dayOne) }];
  for (let i = 1; i <= count; i += 1) {
    if (i === firstSession + 1) lines.push({ type: 'session-start', at: isoSeconds(dayTwo) });
    const base = i <= firstSession ? dayOne + i * 60000 : dayTwo + (i - firstSession) * 60000;
    lines.push({
      type: 'version',
      id: i,
      at: isoSeconds(base),
      origin: 'claude',
      label: `probe seed ${i}`,
      code: `drums: s("bd*${1 + (i % 4)}").gain(0)\nhats: s("hh").gain(0)`,
    });
  }
  lines.push({ type: 'favorite', id: firstSession, name: 'probe favorite', at: isoSeconds(dayTwo + 3600000) });
  return lines.map((line) => JSON.stringify(line)).join('\n') + '\n';
}

export function freshDataDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** A fresh OS temp folder holding one child folder called `name`; returns the child, the folder a Moontide process is
 * started in so its label is made from that made-up name. The temp folder is pushed to `tempDirs`, which every
 * cleanup path removes (also on a signal). */
export function makeNamedFolder(name, tempDirs) {
  const root = freshDataDir('moontide-probe-cwd-');
  tempDirs.push(root);
  const folder = path.join(root, name);
  fs.mkdirSync(folder);
  return folder;
}

function waitForPageUrl(getStderr, timeoutMs) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const text = getStderr();
      const match = PAGE_URL_PATTERN.exec(text);
      if (match) {
        resolve({ url: match[1], port: Number(match[2]) });
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new ProbeCouldNotRun(`the Moontide server did not print its page URL within ${timeoutMs}ms`));
        return;
      }
      setTimeout(check, 25);
    };
    check();
  });
}

/** Starts dist/index.js through a real MCP stdio client, exactly like test/helpers.js
 * startMcpClient(): connect, call the start tool (Moontide starts nothing by itself), then read the
 * page URL from stderr — same env shape, same parsing — but standing on its own (the probe may not
 * import from test/). */
export async function startServerAndClient({ entry = DIST_ENTRY, cwd = undefined } = {}) {
  const dataDir = freshDataDir('moontide-probe-data-');
  fs.writeFileSync(path.join(dataDir, 'history.jsonl'), seedHistoryLines());
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env: { ...process.env, MOONTIDE_NO_BROWSER: '1', MOONTIDE_DATA_DIR: dataDir },
    cwd,
    stderr: 'pipe',
  });
  let stderrText = '';
  transport.stderr?.on('data', (chunk) => {
    stderrText += chunk.toString();
  });
  const client = new Client({ name: 'moontide-probe-client', version: '0.0.0' });
  await client.connect(transport);
  const started = await client.callTool({ name: 'start', arguments: {} });
  if (started.isError) {
    throw new ProbeCouldNotRun(`the start tool failed: ${JSON.stringify(started.content)}`);
  }
  const { url: pageUrl } = await waitForPageUrl(() => stderrText, 10000);
  return { client, pageUrl, dataDir, getStderr: () => stderrText };
}

/** Every package copy made by makePackageCopy and not yet removed. removeTempDirs consults it, so every cleanup path
 * (normal end, signal) removes the copy's node_modules link on its own before any recursive removal of the copy. */
const packageCopies = new Set();

/**
 * A throwaway copy of the package in the OS temp dir (dist, page, reference, instruments and
 * package.json), with node_modules linked to the repo's, so a second server can run from files the probe
 * is free to change. Nothing is ever written in the working tree. The link is removed by itself with
 * removePackageCopyLink before any recursive removal of the copy.
 */
export function makePackageCopy() {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const copy = freshDataDir('moontide-probe-copy-');
  for (const name of ['dist', 'page', 'reference', 'instruments']) {
    fs.cpSync(path.join(root, name), path.join(copy, name), { recursive: true });
  }
  fs.copyFileSync(path.join(root, 'package.json'), path.join(copy, 'package.json'));
  // A junction needs no extra rights on Windows; the type is ignored elsewhere.
  packageCopies.add(copy);
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(copy, 'node_modules'), 'junction');
  return copy;
}

/**
 * Removes only the copy's node_modules link, never its target, then checks the repo's node_modules is
 * still there and throws loudly when it is not. Safe to call twice (a missing link is fine).
 */
export function removePackageCopyLink(copy) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const link = path.join(copy, 'node_modules');
  let stat = null;
  try {
    stat = fs.lstatSync(link);
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
  if (stat !== null) {
    if (!stat.isSymbolicLink()) {
      throw new Error(`removePackageCopyLink: ${link} is not a link, refusing to remove it`);
    }
    try {
      fs.unlinkSync(link);
    } catch (err) {
      // Windows can refuse to unlink a junction: remove the (non-recursive) directory entry instead.
      if (process.platform === 'win32') fs.rmdirSync(link);
      else throw err;
    }
  }
  if (!fs.existsSync(path.join(root, 'node_modules'))) {
    throw new Error('removePackageCopyLink: the repo node_modules folder is gone');
  }
}

/** Calls an MCP tool through a real client and returns its text content; throws on isError,
 * with the tool's own error text (never a generic "call failed"). */
export async function callTool(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content ?? [])
    .filter((entry) => entry.type === 'text')
    .map((entry) => entry.text)
    .join('\n');
  if (result.isError) {
    throw new Error(text || `${name} failed with no message`);
  }
  return text;
}

/** Starts the browser. The probes speak CDP over the port; the pipe (fds 3 and 4) is only a lifeline: the browser closes
 * itself when that pipe closes, so it never outlives the probe, even after a SIGKILL or a crash. */
export function spawnBrowser(browserPath, userDataDir, pageUrl, headful) {
  const args = [
    `--user-data-dir=${userDataDir}`,
    '--remote-debugging-port=0',
    '--remote-debugging-pipe',
    '--no-first-run',
    '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required',
  ];
  if (!headful) args.push('--headless=new');
  args.push(pageUrl);
  return spawn(browserPath, args, { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
}

function hasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    if (hasExited(child)) {
      resolve(true);
      return;
    }
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    child.once('exit', onExit);
  });
}

/** Stops the browser and waits until it has exited, so its profile folder can be removed: a plain kill first, then
 * SIGKILL after 3 s. Throws when the browser is still running after that. */
export async function closeBrowser(child) {
  if (hasExited(child)) return;
  child.kill();
  if (await waitForExit(child, 3000)) return;
  child.kill('SIGKILL');
  if (!(await waitForExit(child, 3000))) {
    throw new Error(`the browser (pid ${child.pid}) is still running after SIGKILL`);
  }
}

/** Removes the probe's temp folders, with a couple of short retries: the browser can still be releasing file handles on
 * its profile folder for a moment after it exits. Reports a folder it could not remove. A package copy's node_modules
 * link is removed by itself first (removePackageCopyLink); when that fails, the copy is NOT removed recursively (the
 * recursive removal could follow the link into the repo's node_modules): it stays on disk and a loud message names it. */
export async function removeTempDirs(dirs, name) {
  for (const dir of dirs) {
    if (packageCopies.has(dir)) {
      try {
        removePackageCopyLink(dir);
      } catch (err) {
        console.error(
          `${name}: NOT removing ${dir}: its node_modules link could not be removed safely (${err instanceof Error ? err.message : String(err)}). Check the link by hand, then delete the folder.`,
        );
        continue;
      }
      packageCopies.delete(dir);
    }
    let lastErr;
    let removed = false;
    for (let attempt = 0; attempt < 3 && !removed; attempt++) {
      try {
        if (attempt > 0) await sleep(500);
        fs.rmSync(dir, { recursive: true, force: true });
        removed = true;
      } catch (err) {
        lastErr = err;
      }
    }
    if (!removed) {
      console.error(`${name}: failed to remove temp dir ${dir}: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
    }
  }
}

/**
 * Cleans up when the probe is stopped by Ctrl+C (SIGINT) or SIGTERM: closes the browser, removes `tempDirs` and exits
 * with 128 + the signal number. Any other end (a crash, a SIGKILL, a hard kill on Windows, which never delivers SIGTERM
 * to Node) still closes the browser through the lifeline pipe of spawnBrowser, but leaves the temp folders behind.
 */
export function closeBrowserOnSignal(child, tempDirs, name) {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, async () => {
      console.error(`${name}: stopped by ${signal}, closing the browser`);
      try {
        await closeBrowser(child);
      } catch (err) {
        console.error(`${name}: failed to close the browser: ${err instanceof Error ? err.message : String(err)}`);
      }
      await removeTempDirs(tempDirs, name);
      process.exit(128 + os.constants.signals[signal]);
    });
  }
}

/** Polls <user-data-dir>/DevToolsActivePort (first line = the auto-assigned port) until it
 * appears, up to timeoutMs. */
export async function pollDevToolsPort(userDataDir, timeoutMs) {
  const filePath = path.join(userDataDir, 'DevToolsActivePort');
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf8');
      const firstLine = content.split('\n')[0]?.trim();
      const port = Number(firstLine);
      if (Number.isInteger(port) && port > 0) return port;
    }
    await sleep(200);
  }
  throw new ProbeCouldNotRun('the browser did not open a DevTools port in time');
}

/** Polls http://127.0.0.1:<port>/json/list for the page target whose url starts with pageUrl. */
export async function findPageTarget(port, pageUrl, timeoutMs) {
  const start = Date.now();
  let lastErr;
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (res.ok) {
        const list = await res.json();
        const target = list.find((entry) => typeof entry.url === 'string' && entry.url.startsWith(pageUrl));
        if (target) return target;
      }
    } catch (err) {
      lastErr = err;
    }
    await sleep(200);
  }
  const reason = lastErr instanceof Error ? `: ${lastErr.message}` : '';
  throw new ProbeCouldNotRun(`could not find the Moontide page target via CDP /json/list in time${reason}`);
}

export function waitSocketOpen(ws, timeoutMs = 10000) {
  if (ws.readyState === ws.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new ProbeCouldNotRun('the CDP WebSocket did not open in time')), timeoutMs);
    ws.addEventListener(
      'open',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
    ws.addEventListener(
      'error',
      () => {
        clearTimeout(timer);
        reject(new ProbeCouldNotRun('the CDP WebSocket failed to connect to the browser'));
      },
      { once: true },
    );
  });
}

/** The viewport probe:page works in when no check sets its own. A headless Chrome opens a window of 756 x 469 CSS px,
 * narrower than the 1024 px the top bar is built for (it gives up the wordmark and more below that), so every
 * `Emulation.clearDeviceMetricsOverride` of a check puts the page back at this size instead. The height is the headless
 * window's own, so nothing that depends on the height moves. */
export const PROBE_VIEWPORT = Object.freeze({ width: 1366, height: 469, deviceScaleFactor: 1, mobile: false });

/** Wraps a CDP WebSocket with a small `cdp(method, params)` request/response helper: sends
 * {id, method, params}, resolves on the matching id, rejects on an error reply or after 10s. With `baseViewport`, a
 * `Emulation.clearDeviceMetricsOverride` sets that viewport instead of going back to the browser window's own size. */
export function makeCdp(ws, { baseViewport = null } = {}) {
  let nextId = 0;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    let msg;
    try {
      msg = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
    } catch {
      return;
    }
    if (typeof msg.id !== 'number' || !pending.has(msg.id)) return; // a CDP event, not a reply
    const { resolve, reject, timer } = pending.get(msg.id);
    clearTimeout(timer);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(`CDP error (${msg.error.code}): ${msg.error.message}`));
    else resolve(msg.result);
  });
  return function cdp(method, params = {}) {
    if (baseViewport !== null && method === 'Emulation.clearDeviceMetricsOverride') {
      method = 'Emulation.setDeviceMetricsOverride';
      params = baseViewport;
    }
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP ${method} timed out after 10s`));
      }, 10000);
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
  };
}

/** Runs `expression` in the page via Runtime.evaluate (returnByValue, awaitPromise) and returns
 * its value; throws with the page's own exception description on failure. */
export async function evaluateExpr(cdp, expression) {
  const result = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) {
    const description =
      result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'unknown error';
    throw new Error(`page evaluation failed: ${description}`);
  }
  return result.result.value;
}

export async function waitConnected(cdp, timeoutMs, expectedLabel = CONNECTION_LABELS.connected) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      // The navigation to the page URL can still be in flight (document briefly about:blank or
      // mid-parse) right after the target is found — a missing element is "not ready yet", not a
      // failure, so it is retried exactly like an unmatched label rather than thrown.
      const text = await evaluateExpr(
        cdp,
        `(() => { const el = document.getElementById('connection-state'); return el ? el.textContent : null; })()`,
      );
      if (text === expectedLabel) return;
    } catch {
      // Evaluation can transiently fail during navigation (execution context destroyed); retry.
    }
    await sleep(200);
  }
  throw new ProbeCouldNotRun(`the page never showed the connection label "${expectedLabel}" in time`);
}

/** Reloads the page and brings it back to the connected, sound-unlocked state: a window marker,
 * Page.reload, poll until the marker is gone (retrying while the execution context is destroyed),
 * waitConnected, clickOverlay. The same steps as the older reload block in main(). A page that is
 * expected to be refused passes { expectedLabel: CONNECTION_LABELS.refused }. */
export async function reloadPage(cdp, { expectedLabel } = {}) {
  await evaluateExpr(cdp, `(() => { window.__moontideProbeReloadMarker = true; })()`);
  await cdp('Page.reload');
  const deadline = Date.now() + 15000;
  let markerGone = false;
  while (Date.now() < deadline && !markerGone) {
    try {
      markerGone = await evaluateExpr(cdp, `window.__moontideProbeReloadMarker === undefined`);
    } catch {
      // Evaluation can transiently fail during navigation (execution context destroyed); retry.
    }
    if (!markerGone) await sleep(200);
  }
  if (!markerGone) {
    throw new ProbeCouldNotRun('the page reload marker never cleared within 15s');
  }
  await waitConnected(cdp, 15000, expectedLabel);
  await clickOverlay(cdp);
}

/** Clicks the center of #audio-unlock-overlay via Input.dispatchMouseEvent, reading its bounding
 * box from the page first (the click-to-start-sound gesture, same element a real user clicks). */
export async function clickOverlay(cdp) {
  const rect = await evaluateExpr(
    cdp,
    `(() => {
      const el = document.getElementById('audio-unlock-overlay');
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    })()`,
  );
  const x = rect.x + rect.width / 2;
  const y = rect.y + rect.height / 2;
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

/** Page-side source: scrolls an element into view for a real mouse click. The separator's hit area (2rem) reaches
 * 0.75rem into the view and into the editor, so a control scrolled to the very edge of the view would sit under it and a
 * click would grab the border. A person scrolls such a control clear of it; so does the probe: when the separator would take
 * the click at the element's center, the element is scrolled to the middle instead. */
const SCROLL_FOR_CLICK_JS = `(el) => {
  el.scrollIntoView({ block: 'nearest' });
  const r = el.getBoundingClientRect();
  const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
  if (hit !== null && hit.id === 'split-handle') el.scrollIntoView({ block: 'center' });
}`;

/** Clicks the center of the first element matching `selector` via Input.dispatchMouseEvent, after
 * scrolling it into view. A missing element throws a plain Error naming the selector, so it shows
 * up as a failed check rather than a ProbeCouldNotRun (the same click shape as clickOverlay). */
export async function clickElement(cdp, selector) {
  const rect = await evaluateExpr(
    cdp,
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      (${SCROLL_FOR_CLICK_JS})(el);
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    })()`,
  );
  if (rect === null) {
    throw new Error(`clickElement: no element matches "${selector}"`);
  }
  const x = rect.x + rect.width / 2;
  const y = rect.y + rect.height / 2;
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

/** A page-side function (as source text) that measures one item of the Session drawer by id: `shown` (displayed with a
 * box of non-zero width and height, which a hidden or undisplayed item never has, so a size check cannot pass on it),
 * `whole` (shown, inside its card, not clipped) and `lines` (its height in lines of its own line height). A check on a
 * moved item calls openDrawer first and asserts `shown` before it reads anything else. */
export const DRAWER_ITEM_JS = `(id) => {
  const el = document.getElementById(id);
  const box = el.getBoundingClientRect();
  const card = el.closest('.session-card');
  const cardBox = card === null ? null : card.getBoundingClientRect();
  const shown = !el.hidden && box.width > 0 && box.height > 0 && el.getClientRects().length > 0;
  const whole = shown && cardBox !== null && box.left >= cardBox.left - 1 && box.right <= cardBox.right + 1 &&
    (el.clientWidth === 0 || el.scrollWidth <= el.clientWidth) && card.scrollWidth <= card.clientWidth;
  return { shown, whole, lines: Math.round(box.height / parseFloat(getComputedStyle(el).lineHeight)), width: box.width, height: box.height };
}`;

const DRAWER_OPEN_EXPR = `(() => { const drawer = document.getElementById('session-drawer'); return !drawer.hidden && drawer.getClientRects().length > 0; })()`;

/** Presses the Session button: a real mouse click, or a click event from the page when a real click cannot reach it: the
 * tab is hidden (a hidden tab of the second-tab probes takes no mouse input) or the audio-unlock overlay still covers the
 * page (a second tab nobody has clicked into yet). */
async function pressSessionButton(cdp) {
  if (await evaluateExpr(cdp, `document.visibilityState === 'hidden' || !document.getElementById('audio-unlock-overlay').hidden`)) {
    await evaluateExpr(cdp, `(() => { document.getElementById('session-button').click(); return true; })()`);
    return;
  }
  await clickElement(cdp, '#session-button');
}

/** Opens the Session drawer the way a person does: a real click on the Session button, then waits until the panel is
 * displayed (not hidden, with a box). It does nothing when the drawer is already open, so a migrated check can call
 * it without knowing the state; it throws a plain Error when the drawer does not open. The items that left the top bar
 * live in it: a check that measures one of them, or clicks it with the mouse, opens the drawer first. */
export async function openDrawer(cdp) {
  if (await evaluateExpr(cdp, DRAWER_OPEN_EXPR)) return;
  await pressSessionButton(cdp);
  const shown = await waitFor(cdp, `${DRAWER_OPEN_EXPR} ? true : null`, 3000);
  if (shown !== true) {
    const where = await evaluateExpr(cdp, `(() => { const b = document.getElementById('session-button'); const r = b.getBoundingClientRect(); const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return { r: [r.x, r.y, r.width, r.height], hit: hit === null ? null : hit.id || hit.className || hit.tagName, innerWidth: window.innerWidth, visibility: document.visibilityState, hasFocus: document.hasFocus(), active: document.activeElement === null ? null : document.activeElement.id, hidden: document.getElementById('session-drawer').hidden, expanded: b.getAttribute('aria-expanded') }; })()`);
    throw new Error('openDrawer: the Session drawer did not open after a click on the Session button ' + JSON.stringify(where));
  }
}

/** Closes the Session drawer with a real click on the Session button and waits until it is hidden. It does nothing
 * when the drawer is already closed. */
export async function closeDrawer(cdp) {
  if (!(await evaluateExpr(cdp, `!document.getElementById('session-drawer').hidden`))) return;
  await pressSessionButton(cdp);
  const closed = await waitFor(cdp, `document.getElementById('session-drawer').hidden ? true : null`, 3000);
  if (closed !== true) {
    const where = await evaluateExpr(cdp, `(() => { const b = document.getElementById('session-button'); const r = b.getBoundingClientRect(); const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return { r: [r.x, r.y, r.width, r.height], hit: hit === null ? null : hit.id || hit.className || hit.tagName, innerWidth: window.innerWidth, active: document.activeElement.id, hasFocus: document.hasFocus(), hidden: document.getElementById('session-drawer').hidden }; })()`);
    throw new Error('closeDrawer: the Session drawer did not close after a click on the Session button ' + JSON.stringify(where));
  }
}

/** Clicks the first element matching `selector` with the mouse from inside the Session drawer: opens the drawer,
 * clicks, and closes it again (unless `keepOpen`). For a moved button (Motion, Edits timing, Play in this tab, the
 * (i) buttons) that a person reaches through the drawer. */
export async function clickInDrawer(cdp, selector, { keepOpen = false } = {}) {
  await openDrawer(cdp);
  await clickElement(cdp, selector);
  if (!keepOpen) await closeDrawer(cdp);
}

/** Presses one of the three Edits timing buttons ('now', 'bar' or 'phrase') of the Settings card with the mouse: opens the
 * drawer, clicks the button named `value`, closes the drawer again. */
export async function pickTiming(cdp, value) {
  await clickInDrawer(cdp, `#change-timing button[data-value=${JSON.stringify(value)}]`);
}

/** The id of the one Play/Stop button the probes click. The only place the id is written in this file: a rename of
 * the button is a change of this line. The button toggles, so a probe never clicks it blind: stopMusic and playMusic
 * read the state word first. */
export const TRANSPORT_ID = 'transport-button';
export const TRANSPORT_SELECTOR = `#${TRANSPORT_ID}`;

const STATE_WORD_EXPR = `(() => { const el = document.querySelector('#sound-state .state-label'); return el ? el.textContent : null; })()`;

/** The state word the bar shows now ("Playing" or "Stopped"; the bar no longer shows "Silent" or "Sound off"), or null when the bar has none. */
export async function readStateWord(cdp) {
  return evaluateExpr(cdp, STATE_WORD_EXPR);
}

/** Stops the music the way a person does: clicks the transport button. It reads the state word first and throws a
 * plain Error unless it says Playing (a short wait lets a set_code reply that just returned reach the bar), so a
 * button that toggles can never start music by accident; it then waits until the word is no longer Playing. */
export async function stopMusic(cdp) {
  const playing = JSON.stringify(SOUND_LABELS.playing);
  const before = await waitFor(cdp, `(() => (${STATE_WORD_EXPR}) === ${playing} ? true : null)()`, 2000);
  if (before !== true) {
    throw new Error(`stopMusic: the state word is ${JSON.stringify(await readStateWord(cdp))}, not ${playing}; refusing to click the transport button`);
  }
  await clickElement(cdp, TRANSPORT_SELECTOR);
  const after = await waitFor(cdp, `(() => (${STATE_WORD_EXPR}) !== ${playing} ? true : null)()`, 5000);
  if (after !== true) throw new Error('stopMusic: the state word still says Playing 5 s after the click');
}

/** Starts the music the way a person does: clicks the transport button, which runs the editor's code as a hand
 * evaluation, then waits until the state word is Playing. Throws if the word already says Playing (a click would stop
 * the music instead) or if the button does not say Play. */
export async function playMusic(cdp) {
  const playing = JSON.stringify(SOUND_LABELS.playing);
  const word = await readStateWord(cdp);
  if (word === SOUND_LABELS.playing) throw new Error('playMusic: the state word already says Playing');
  const button = await readTransport(cdp);
  if (button.label !== BAR_COPY.play || button.ariaDisabled !== null) {
    throw new Error(`playMusic: the transport button is ${JSON.stringify(button)}, not an enabled Play; refusing to click`);
  }
  await clickElement(cdp, TRANSPORT_SELECTOR);
  const after = await waitFor(cdp, `(() => (${STATE_WORD_EXPR}) === ${playing} ? true : null)()`, 8000);
  if (after !== true) throw new Error(`playMusic: the state word is ${JSON.stringify(await readStateWord(cdp))}, not ${playing}, 8 s after the click`);
}

/** What the transport button and the state word show now: the word, its ' here' part, the button's word, its action,
 * aria-disabled (null when absent), the disabled property, its title, the state's data-accent and the status line. */
export async function readTransport(cdp) {
  return evaluateExpr(
    cdp,
    `(() => {
      const button = document.getElementById(${JSON.stringify(TRANSPORT_ID)});
      const state = document.getElementById('sound-state');
      return {
        word: state.querySelector('.state-label').textContent,
        here: state.querySelector('.state-here').textContent,
        label: button.querySelector('.transport-word').textContent,
        action: button.dataset.action ?? null,
        ariaDisabled: button.getAttribute('aria-disabled'),
        disabledProperty: button.disabled,
        title: button.title,
        accent: state.dataset.accent ?? null,
        status: document.getElementById('change-status').textContent,
      };
    })()`,
  );
}

/** For each width in `widths`: sets the viewport (height 768, scale 1, not mobile), waits 300 ms, calls `fn(width)`
 * and collects its result. The device metrics override is cleared in a finally block, so a throw leaves the page
 * at its own size. Returns the results in the order of `widths`. */
export async function atWidths(cdp, widths, fn) {
  const results = [];
  try {
    for (const width of widths) {
      await cdp('Emulation.setDeviceMetricsOverride', { width, height: 768, deviceScaleFactor: 1, mobile: false });
      await sleep(300);
      results.push(await fn(width));
    }
  } finally {
    await cdp('Emulation.clearDeviceMetricsOverride');
    // The page lays itself out at its own size again; a click right after would aim at the old layout.
    await sleep(300);
  }
  return results;
}

/**
 * Writes the longest real strings of the top bar (WORST_CASE in test/bar-inventory.js) into the live page, layout
 * only: texts and hidden flags, in the throwaway browser. It shows the build line, the ask status, the version
 * indicator, "wait for Claude", the MIDI attention text with six dots, the tempo and the countdown. Returns what
 * it replaced, for restoreWorstCase; the page's own code does not know about the fixture and may rewrite an
 * element on its next poll, so measure at once.
 */
export async function setWorstCase(cdp) {
  const unit = ` ${BAR_COPY.tempoUnit}`;
  const arrowJoint = ` ${BAR_COPY.tempoArrow} `;
  if (!WORST_CASE.tempo.endsWith(unit) || !WORST_CASE.tempo.includes(arrowJoint)) {
    throw new Error(`setWorstCase: WORST_CASE.tempo ${JSON.stringify(WORST_CASE.tempo)} is not '<number>${arrowJoint}<number>${unit}'`);
  }
  const [num, waitingNum] = WORST_CASE.tempo.slice(0, WORST_CASE.tempo.length - unit.length).split(arrowJoint);
  const arrow = ` ${BAR_COPY.tempoArrow} ${waitingNum}`;
  const countdown = countdownParts(48);
  if (`${countdown.lead}${countdown.rest}` !== WORST_CASE.pending) {
    throw new Error(`setWorstCase: WORST_CASE.pending ${JSON.stringify(WORST_CASE.pending)} is not the countdown for 12 bars`);
  }
  const texts = [
    ['#connection-state', WORST_CASE.connection],
    ['#midi-takeover-text', WORST_CASE.takeover],
    ['#build-mismatch', WORST_CASE.build],
    // The status holds its long sentence and its short form; the fixture writes both.
    ['#ask-status .ask-long', WORST_CASE.askStatus],
    ['#ask-status .ask-short', waitingShortText(12)],
    // The longest state word is 'Stopped here' (a tab that lost the role): the ' here' part is written too.
    ['#sound-state .state-here', BAR_COPY.stateHere],
    ['#version-indicator', WORST_CASE.version],
    ['#page-requests-state', WORST_CASE.pageRequests],
    ['#midi-state-text', WORST_CASE.midiAttention],
    ['#tempo-readout .tempo-num', num],
    ['#tempo-readout .tempo-arrow', arrow],
    ['#tempo-readout .tempo-unit', unit],
    ['#pending-change .pending-lead', countdown.lead],
    ['#pending-change .pending-rest', countdown.rest],
  ];
  const shows = ['#build-mismatch', '#ask-status', '#version-indicator', '#page-requests', '#midi-state', '#midi-dots', '#midi-takeover', '#tempo-readout', '#pending-change'];
  return evaluateExpr(
    cdp,
    `(() => {
      const texts = ${JSON.stringify(texts)};
      const shows = ${JSON.stringify(shows)};
      const get = (selector) => {
        const el = document.querySelector(selector);
        if (el === null) throw new Error('setWorstCase: no element matches ' + selector);
        return el;
      };
      const midiState = get('#midi-state');
      const dots = get('#midi-dots');
      const saved = {
        texts: [...texts.map(([selector]) => selector), '#midi-dots'].map((selector) => ({ selector, html: get(selector).innerHTML })),
        hiddens: shows.map((selector) => ({ selector, hidden: get(selector).hidden })),
        attention: midiState.dataset.attention ?? null,
      };
      for (const [selector, text] of texts) get(selector).textContent = text;
      dots.replaceChildren(...['filled', 'hollow', 'filled', 'hollow', 'filled', 'filled'].map((kind) => {
        const span = document.createElement('span');
        span.className = 'state-dot midi-dot';
        span.dataset.kind = kind;
        return span;
      }));
      midiState.dataset.attention = 'true';
      for (const selector of shows) get(selector).hidden = false;
      return saved;
    })()`,
  );
}

/** Puts back exactly what setWorstCase replaced (`saved` is its return value): texts, child markup of the dots,
 * hidden flags and the attention flag. */
export async function restoreWorstCase(cdp, saved) {
  await evaluateExpr(
    cdp,
    `(() => {
      const saved = ${JSON.stringify(saved)};
      for (const { selector, html } of saved.texts) document.querySelector(selector).innerHTML = html;
      for (const { selector, hidden } of saved.hiddens) document.querySelector(selector).hidden = hidden;
      const midiState = document.querySelector('#midi-state');
      if (saved.attention === null) delete midiState.dataset.attention;
      else midiState.dataset.attention = saved.attention;
    })()`,
  );
}

/**
 * Captures what the page writes to the clipboard. Headless Chrome refuses navigator.clipboard.writeText with
 * NotAllowedError ("Document is not focused") unless focus emulation is on, and readText is unusable, so this turns
 * focus emulation on and replaces writeText in the page by a spy that records each text and then resolves (or, with
 * `reject`, rejects with a DOMException named NotAllowedError). It never calls readText and never touches the system
 * clipboard. Returns { texts(), restore() }: texts() is the list recorded so far; restore() puts the page's own
 * writeText back and turns focus emulation off.
 */
export async function spyClipboard(cdp, { reject = false } = {}) {
  await cdp('Emulation.setFocusEmulationEnabled', { enabled: true });
  try {
    await evaluateExpr(
      cdp,
      `(() => {
        if (!navigator.clipboard) throw new Error('spyClipboard: this page has no navigator.clipboard (not a secure context?)');
        if (Object.hasOwn(navigator.clipboard, 'writeText')) throw new Error('spyClipboard: a spy is already installed');
        const recorded = [];
        window.__moontideClipboardTexts = recorded;
        navigator.clipboard.writeText = (text) => {
          recorded.push(String(text));
          return ${reject ? `Promise.reject(new DOMException('Write permission denied.', 'NotAllowedError'))` : 'Promise.resolve()'};
        };
        return true;
      })()`,
    );
  } catch (err) {
    await cdp('Emulation.setFocusEmulationEnabled', { enabled: false });
    throw err;
  }
  return {
    texts: () => evaluateExpr(cdp, `[...(window.__moontideClipboardTexts ?? [])]`),
    restore: async () => {
      await evaluateExpr(cdp, `(() => { delete navigator.clipboard.writeText; delete window.__moontideClipboardTexts; return true; })()`);
      await cdp('Emulation.setFocusEmulationEnabled', { enabled: false });
    },
  };
}

/** The page-side statements that set `el` to the target of `helper` (askAt or askAtPoint): the first match of
 * `selector`, the match at `index`, or the first match whose textContent is exactly `text`. They throw in the
 * page when nothing matches, naming the selector, the index or text asked for and how many elements matched. */
function askTargetExpr(helper, selector, { index, text } = {}) {
  if (index !== undefined && text !== undefined) {
    throw new Error(`${helper}: pass either index or text, not both`);
  }
  if (index !== undefined && !(Number.isInteger(index) && index >= 0)) {
    throw new Error(`${helper}: index must be a non-negative integer, got ${JSON.stringify(index)}`);
  }
  if (text !== undefined && typeof text !== 'string') {
    throw new Error(`${helper}: text must be a string, got ${JSON.stringify(text)}`);
  }
  const sel = JSON.stringify(selector);
  if (index === undefined && text === undefined) {
    return `const el = document.querySelector(${sel});
      if (!el) throw new Error('${helper}: no element matches ' + ${sel});`;
  }
  const pick =
    index !== undefined
      ? `all[${index}]`
      : `all.find((candidate) => candidate.textContent === ${JSON.stringify(text)})`;
  const asked = index !== undefined ? ` at index ${index}` : ` with text ${JSON.stringify(text)}`;
  return `const all = [...document.querySelectorAll(${sel})];
      const el = ${pick};
      if (!el) throw new Error('${helper}: no element matches ' + ${sel} + ${JSON.stringify(asked)} + ' (' + all.length + ' matched)');`;
}

/** Right-clicks the center of an element matching `selector` the way a browser does: one `contextmenu` event on
 * the element, after scrolling it into view. The element is the first match, or the match at `index`, or the
 * first match whose textContent is exactly `text`. It is resolved at click time, in the same page evaluation as
 * the event, because the editor can rebuild its elements between two evaluations. Returns whether the page took
 * the event (`prevented`), whether the Ask Claude box is open and its context chip text. */
export async function askAt(cdp, selector, { shiftKey = false, index, text } = {}) {
  const target = askTargetExpr('askAt', selector, { index, text });
  return evaluateExpr(
    cdp,
    `(() => {
      ${target}
      el.scrollIntoView({ block: 'nearest' });
      const r = el.getBoundingClientRect();
      const event = new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: r.x + r.width / 2,
        clientY: r.y + r.height / 2,
        shiftKey: ${shiftKey ? 'true' : 'false'},
        button: 2,
      });
      const notPrevented = el.dispatchEvent(event);
      return {
        prevented: !notPrevented,
        open: !document.getElementById('ask-box').hidden,
        chip: document.getElementById('ask-context-chip').textContent,
      };
    })()`,
  );
}

/** Like askAt, but the contextmenu event lands where `pointExpr` says: a JS expression over `r` (the element's
 * bounding rect) that returns `[clientX, clientY]`. The event is dispatched on the matching element itself, which
 * `index` or `text` pick the same way as in askAt, at click time, because the editor can rebuild its elements
 * between two evaluations. */
async function askAtPoint(cdp, selector, pointExpr, { index, text } = {}) {
  const target = askTargetExpr('askAtPoint', selector, { index, text });
  return evaluateExpr(
    cdp,
    `(() => {
      ${target}
      el.scrollIntoView({ block: 'nearest' });
      const r = el.getBoundingClientRect();
      const [clientX, clientY] = (${pointExpr});
      const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX, clientY, button: 2 });
      const notPrevented = el.dispatchEvent(event);
      return {
        prevented: !notPrevented,
        open: !document.getElementById('ask-box').hidden,
        chip: document.getElementById('ask-context-chip').textContent,
      };
    })()`,
  );
}

/** Like askAt, but the contextmenu event lands on whatever element is at the viewport point (x, y) (the body
 * when there is none): the way a right-click near a corner or an edge of the window lands. */
export async function askAtCoords(cdp, x, y) {
  return evaluateExpr(
    cdp,
    `(() => {
      const el = document.elementFromPoint(${x}, ${y}) || document.body;
      const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: ${x}, clientY: ${y}, button: 2 });
      const notPrevented = el.dispatchEvent(event);
      return {
        prevented: !notPrevented,
        open: !document.getElementById('ask-box').hidden,
        chip: document.getElementById('ask-context-chip').textContent,
      };
    })()`,
  );
}

// The page-request listeners this probe started, killed in the finally block.
const spawnedListeners = [];

/** Starts the listener exactly as the arming line says: parses `node '<script>' <port> <token>` out of
 * `armingLine`, runs it with this Node, and collects its stdout lines. Returns null when the line holds
 * no command. */
function spawnListener(armingLine) {
  const match = /node '([^']+)' (\d+) ([0-9a-f]{64})/.exec(armingLine);
  if (match === null) return null;
  const child = spawn(process.execPath, [match[1], match[2], match[3]], { stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = [];
  let pending = '';
  child.stdout.on('data', (chunk) => {
    pending += chunk.toString();
    let newline = pending.indexOf('\n');
    while (newline !== -1) {
      lines.push(pending.slice(0, newline));
      pending = pending.slice(newline + 1);
      newline = pending.indexOf('\n');
    }
  });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  spawnedListeners.push(child);
  return { child, lines, exited };
}

/** Drags a range slider with real mouse events (Input.dispatchMouseEvent): presses at
 * `fromFraction` of its length, moves through `steps` points to `toFraction` with a 30 ms pause
 * between them, and releases there. A slider taller than wide is vertical (0 = bottom, 1 = top:
 * the native writing-mode: vertical-lr range, input per move, one change at release); a slider
 * wider than tall is horizontal (0 = left, 1 = right). A missing element throws a plain Error
 * naming the selector, like clickElement. The optional `beforeRelease` callback runs after the last
 * move and before the button is released. */
export async function dragSlider(cdp, selector, fromFraction, toFraction, steps, beforeRelease = null) {
  const rect = await evaluateExpr(
    cdp,
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      (${SCROLL_FOR_CLICK_JS})(el);
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom };
    })()`,
  );
  if (rect === null) {
    throw new Error(`dragSlider: no element matches "${selector}"`);
  }
  const horizontal = rect.width > rect.height;
  const at = (fraction) =>
    horizontal
      ? { x: rect.x + fraction * rect.width, y: rect.y + rect.height / 2 }
      : { x: rect.x + rect.width / 2, y: rect.bottom - fraction * rect.height };
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', ...at(fromFraction), button: 'left', buttons: 1, clickCount: 1 });
  for (let step = 1; step <= steps; step += 1) {
    const fraction = fromFraction + ((toFraction - fromFraction) * step) / steps;
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', ...at(fraction), button: 'left', buttons: 1 });
    await sleep(30);
  }
  // `beforeRelease` runs after the last move and before the button goes up (what the page holds mid-drag).
  if (beforeRelease) await beforeRelease();
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', ...at(toFraction), button: 'left', buttons: 0, clickCount: 1 });
}

async function readSchedulerNow(cdp) {
  return evaluateExpr(cdp, `document.getElementById('repl').editor.repl.scheduler.now()`);
}

/** Reads the current scheduler time and every onset hap of the currently-playing pattern in
 * [from, to], queried directly on state.pattern (never through the live scheduler's own cyclist
 * query), so this read itself never creates or moves a timeline(id) anchor. */
async function readArc(cdp, from, to) {
  return evaluateExpr(
    cdp,
    `(() => {
      const repl = document.getElementById('repl').editor.repl;
      const now = repl.scheduler.now();
      const haps = repl.state.pattern.queryArc(${from}, ${to})
        .filter((h) => h.hasOnset())
        .map((h) => ({
          s: h.value && typeof h.value === 'object' ? h.value.s : undefined,
          // The page's .lpf() control alias sets the pattern's own control name, 'cutoff' —
          // confirmed live in the page (Object.keys of a .lpf()-chained hap's value), read here
          // under the 'lpf' field name this script uses throughout for readability.
          lpf: h.value && typeof h.value === 'object' ? h.value.cutoff : undefined,
          begin: h.whole.begin.valueOf(),
        }));
      return { now, haps };
    })()`,
  );
}

/** Maps a printable key, an arrow (up, down, left, right), PageUp, PageDown, Home, End, Enter, Space, Tab or 'Escape' to the CDP key-event fields dispatchKeyEvent needs. */
function keyInfo(key) {
  if (key === 'Escape') return { code: 'Escape', windowsVirtualKeyCode: 27 };
  if (key === 'Tab') return { code: 'Tab', windowsVirtualKeyCode: 9 };
  if (key === 'ArrowUp') return { code: 'ArrowUp', windowsVirtualKeyCode: 38 };
  if (key === 'ArrowDown') return { code: 'ArrowDown', windowsVirtualKeyCode: 40 };
  if (key === 'ArrowLeft') return { code: 'ArrowLeft', windowsVirtualKeyCode: 37 };
  if (key === 'ArrowRight') return { code: 'ArrowRight', windowsVirtualKeyCode: 39 };
  if (key === 'PageUp') return { code: 'PageUp', windowsVirtualKeyCode: 33 };
  if (key === 'PageDown') return { code: 'PageDown', windowsVirtualKeyCode: 34 };
  if (key === 'End') return { code: 'End', windowsVirtualKeyCode: 35 };
  if (key === 'Home') return { code: 'Home', windowsVirtualKeyCode: 36 };
  if (key === 'Enter') return { code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' };
  if (key === ' ') return { code: 'Space', windowsVirtualKeyCode: 32, text: ' ' };
  if (/^[0-9]$/.test(key)) return { code: `Digit${key}`, windowsVirtualKeyCode: key.charCodeAt(0), text: key };
  if (/^[a-z]$/.test(key)) {
    return { code: `Key${key.toUpperCase()}`, windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0), text: key };
  }
  throw new Error(`pressKey: no key mapping for "${key}"`);
}

/** Dispatches a real keydown+keyup for `key` via Input.dispatchKeyEvent (with Shift held when `shift` is
 * true: modifiers 8 on both events), exactly the fields a
 * real browser keyboard event carries (key, code, windowsVirtualKeyCode, and text for a
 * printable key) — the same event shape page/main.js's document keydown listener reads.
 *
 * There is no nativeVirtualKeyCode, on purpose: on macOS, Chrome sends a key event that carries one
 * and that the page does not consume (Escape with no view open) back to the page as a new keydown,
 * again and again. Thousands of keydowns a second starve the page's timers and every CDP call. */
export async function pressKey(cdp, key, { shift = false } = {}) {
  const info = keyInfo(key);
  const base = {
    key,
    code: info.code,
    windowsVirtualKeyCode: info.windowsVirtualKeyCode,
    ...(shift ? { modifiers: 8 } : {}),
  };
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...(info.text ? { text: info.text } : {}) });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

/** Polls `expression` via evaluateExpr every 100ms, up to timeoutMs, and returns the last value
 * observed — the expression itself encodes the "not ready yet" condition (returning null/
 * undefined while waiting), so this stays a small, generic poll loop with no check-specific logic. */
export async function waitFor(cdp, expression, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let value = await evaluateExpr(cdp, expression);
  while ((value === null || value === undefined) && Date.now() < deadline) {
    await sleep(100);
    value = await evaluateExpr(cdp, expression);
  }
  return value;
}

/** Reads the Timeline's vertical geometry after the layout has settled (two animation frames, so
 * a layout key or a viewport change has been laid out). Every value is rounded to 0.01 px. */
async function measureTimelineGeometry(cdp) {
  return evaluateExpr(
    cdp,
    `new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const round = (n) => Math.round(n * 100) / 100;
        const box = (el) => {
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { top: round(r.top), bottom: round(r.bottom) };
        };
        const lanes = [...document.querySelectorAll('#timeline-lanes .lane')];
        const sectionRows = [...document.querySelectorAll('#timeline-sections .section-row')];
        resolve({
          body: box(document.getElementById('timeline-body')),
          ruler: box(document.getElementById('timeline-ruler')),
          sections: box(document.getElementById('timeline-sections')),
          lanesBox: box(document.getElementById('timeline-lanes')),
          playhead: box(document.getElementById('timeline-playhead')),
          firstLane: box(lanes[0]),
          lastLane: box(lanes[lanes.length - 1]),
          laneCount: lanes.length,
          sectionRowCount: sectionRows.length,
          sectionRowsHeight: round(sectionRows.reduce((sum, el) => sum + el.getBoundingClientRect().height, 0)),
          state: document.getElementById('timeline-view').dataset.state,
          layout: document.getElementById('workspace').dataset.layout,
          innerWidth: window.innerWidth,
        });
      }));
    })`,
  );
}

/** Samples the playhead's cycle reading against the ruler on every animation frame while the
 * scheduler advances `cycles`. A stalled animation frame cannot hang the probe: a timer resolves
 * the sweep one second after `timeoutMs` at the latest. */
async function sweepPlayheadReading(cdp, cycles, timeoutMs) {
  return evaluateExpr(
    cdp,
    `new Promise((resolve) => {
      const scheduler = document.getElementById('repl').editor.repl.scheduler;
      const view = document.getElementById('timeline-view');
      const ruler = document.getElementById('timeline-ruler');
      const panel = document.getElementById('view-panel');
      const playhead = document.getElementById('timeline-playhead');
      const reading = document.querySelector('#timeline-playhead .playhead-cycle');
      const out = {
        frames: 0, skipped: 0, overlapFrames: 0, overlaps: [], outsideRulerFrames: 0,
        outsidePanelFrames: 0, outsideColumnFrames: 0, leftSideFrames: 0, rightSideFrames: 0, escapes: [],
        minOffset: null, maxOffset: null, timedOut: false,
        motion: document.documentElement.dataset.motion,
      };
      const deadline = performance.now() + ${timeoutMs};
      let startNow = null;
      let done = false;
      const finish = (timedOut) => {
        if (done) return;
        done = true;
        out.timedOut = timedOut;
        resolve(out);
      };
      setTimeout(() => finish(true), ${timeoutMs} + 1000);
      const cross = (a, b) =>
        Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 &&
        Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5;
      const frame = () => {
        if (done) return;
        const now = scheduler.now();
        if (startNow === null) startNow = now;
        if (now - startNow >= ${cycles}) return finish(false);
        if (performance.now() > deadline) return finish(true);
        const text = reading.textContent;
        if (view.dataset.state === 'ok' && text) {
          out.frames += 1;
          const box = reading.getBoundingClientRect();
          const rulerBox = ruler.getBoundingClientRect();
          const hit = [...ruler.querySelectorAll('.ruler-tick')].find((tick) => cross(box, tick.getBoundingClientRect()));
          if (hit) {
            out.overlapFrames += 1;
            if (out.overlaps.length < 3) out.overlaps.push({ reading: text, mark: hit.textContent });
          }
          if (box.top < rulerBox.top - 0.5 || box.bottom > rulerBox.bottom + 0.5) out.outsideRulerFrames += 1;
          // Edges: the reading must stay inside the panel's right edge and the track column's left edge.
          const side = playhead.dataset.readingSide === 'left' ? 'left' : 'right';
          if (side === 'left') out.leftSideFrames += 1;
          else out.rightSideFrames += 1;
          const pastPanel = box.right - panel.getBoundingClientRect().right;
          const pastColumn = rulerBox.left - box.left;
          if (pastPanel > 0.01) out.outsidePanelFrames += 1;
          if (pastColumn > 0.01) out.outsideColumnFrames += 1;
          if ((pastPanel > 0.01 || pastColumn > 0.01) && out.escapes.length < 3) {
            out.escapes.push({ reading: text, side, pxPast: Math.round(Math.max(pastPanel, pastColumn) * 100) / 100 });
          }
          const offset = Number(text) - Number(view.dataset.pageStart);
          if (out.minOffset === null || offset < out.minOffset) out.minOffset = offset;
          if (out.maxOffset === null || offset > out.maxOffset) out.maxOffset = offset;
        } else {
          out.skipped += 1;
        }
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    })`,
  );
}

// Four short silent lanes on basic synths: they leave spare height in every layout.
const GEOMETRY_LANES = [
  'one: note("c4 e4").s("sine").gain(0)',
  'two: note("g3*2").s("triangle").gain(0)',
  'three: s("square*4").gain(0)',
  'four: note("c5").s("sawtooth").gain(0)',
];

// --- Probe program pieces ---

function rampCode(id, sound) {
  return `note("c*16").s("${sound}").gain(0).lpf(signal((t) => t).range(1000, 2000).timeline(${id}))`;
}
function delayedCode(id) {
  return `note("c*16").s("triangle").gain(0).mask(signal((t) => t >= 2).timeline(${id}))`;
}
const GETTIME_LINE = 'const probeStart = getTime()';
const GETTIME_PART = 'note("c*16").s("square").gain(0).lpf(signal((t) => t - probeStart).range(1000, 2000))';

export function buildProgram(parts) {
  return [GETTIME_LINE, 'stack(', ...parts.map((part) => `  ${part},`), ')'].join('\n');
}

/** [floor(before), ceil(after)] — the cycle window a change's anchor must land inside. */
export function anchorWindow(before, after) {
  return [Math.floor(before), Math.ceil(after)];
}

function inWindow(value, window) {
  return value >= window[0] && value <= window[1];
}

const RAMP_TOLERANCE = 1 / 16 + 1e-6;

/** From a RAMP hap {lpf, begin}: elapsed cycles since its timeline(id) anchor (via the 1000-2000
 * range), the anchor rounded to the cycle boundary it should have snapped to, and whether the raw
 * (unrounded) anchor is close enough to that rounded value to trust this hap (a hap sampled well
 * inside its 1/16-cycle step should be within RAMP_TOLERANCE of the true anchor). */
export function computeRampAnchor(hap) {
  const elapsed = (hap.lpf - 1000) / 1000;
  const rawAnchor = hap.begin - elapsed;
  const anchor = Math.round(rawAnchor);
  const consistent = Math.abs(rawAnchor - anchor) < RAMP_TOLERANCE;
  return { anchor, rawAnchor, elapsed, begin: hap.begin, consistent };
}

/** From a GETTIME hap {lpf, begin}: the (unrounded) getTime() anchor — no .timeline() is applied
 * to this part, so its anchor is expected to differ on every evaluation, not snap to a cycle. */
export function computeGettimeAnchor(hap) {
  const elapsed = (hap.lpf - 1000) / 1000;
  return { rawAnchor: hap.begin - elapsed, elapsed, begin: hap.begin };
}

function firstBySound(haps, sound) {
  return haps.filter((hap) => hap.s === sound).sort((a, b) => a.begin - b.begin)[0];
}

/**
 * The Instruments view in the real page, the checks that need no fake MIDI device. Each check writes its own
 * fixture files into the probe's data folder (made-up names only), reloads the page so the server reads them, and
 * leaves the data folder, the view, the layout and the window as it found them. Every expected sentence is the
 * page's own copy, imported, never retyped. Exported so a scratch script can run the block alone.
 */
export async function instrumentsViewChecks({ cdp, dataDir, report, client }) {
  const rigFile = path.join(dataDir, 'instruments.json');
  const modelsDir = path.join(dataDir, 'models');
  // The choice of the user, written by the server when a switch is pressed (or by hand, to stand for another page).
  const stateFile = path.join(dataDir, 'instruments-state.json');
  const writeRig = (instruments) => fs.writeFileSync(rigFile, JSON.stringify({ instruments }));
  const TWO = [
    { id: 'mt32', model: 'mt32', port: 'Probe Port A' },
    { id: 'sc55', model: 'sc55', port: 'Probe Port B' },
  ];
  const workspace = (field) => evaluateExpr(cdp, `document.getElementById('workspace').dataset.${field}`);
  const blurFocus = () =>
    evaluateExpr(cdp, `(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); })()`);
  const hintPressed = (key) => evaluateExpr(cdp, `document.querySelector('#view-buttons button[data-key="${key}"], #layout-buttons button[data-key="${key}"]').getAttribute('aria-pressed')`);
  const panelHidden = (ms) => waitFor(cdp, `document.getElementById('view-panel').hidden ? true : null`, ms);
  /** Opens the Instruments view with key 6 unless it is open already (a remembered view opens by itself). */
  const openInstruments = async () => {
    await blurFocus();
    if ((await workspace('view')) === 'instruments') return true;
    if ((await workspace('view')) !== 'none') await pressKey(cdp, 'Escape');
    await pressKey(cdp, '6');
    return waitFor(cdp, `document.getElementById('workspace').dataset.view === 'instruments' ? true : null`, 3000);
  };
  const closeInstruments = async () => {
    await blurFocus();
    if ((await workspace('view')) !== 'none') await pressKey(cdp, 'Escape');
    await waitFor(cdp, `document.getElementById('workspace').dataset.view === 'none' ? true : null`, 3000);
  };
  /** What the view says now: the message parts, the cards drawn and the whole text of the view. */
  const readMessage = () =>
    evaluateExpr(
      cdp,
      `(() => {
        const el = (id) => document.getElementById(id);
        const shown = (id) => (el(id).hidden ? null : el(id).textContent);
        return {
          open: el('workspace').dataset.view === 'instruments',
          lead: el('instruments-message').hidden ? null : el('instruments-message-text').textContent,
          sub: shown('instruments-message-sub'),
          closing: shown('instruments-message-closing'),
          cards: document.querySelectorAll('.instrument-card').length,
          bodyHidden: el('instruments-body').hidden,
          text: el('instruments-view').textContent,
        };
      })()`,
    );
  const startLayout = await workspace('layout');
  await cdp('Page.enable');

  try {
    // (1) Key 6 and the 6 Instruments button open and close the view; the button is pressed while it is open.
    await closeInstruments();
    await panelHidden(1000);
    await pressKey(cdp, '6');
    const openedByKey = await waitFor(
      cdp,
      `(() => document.getElementById('workspace').dataset.view === 'instruments' && !document.getElementById('instruments-view').hidden && !document.getElementById('view-panel').hidden ? true : null)()`,
      3000,
    );
    const pressedAfterKey = await hintPressed('6');
    await pressKey(cdp, '6');
    const closedByKey = await waitFor(cdp, `document.getElementById('workspace').dataset.view === 'none' ? true : null`, 3000);
    const pressedAfterKeyClose = await hintPressed('6');
    await panelHidden(1000);
    await clickElement(cdp, '#view-buttons button[data-key="6"]');
    const openedByClick = await waitFor(cdp, `document.getElementById('workspace').dataset.view === 'instruments' ? true : null`, 3000);
    const pressedAfterClick = await hintPressed('6');
    await pressKey(cdp, 'Escape');
    const closedByEscape = await waitFor(cdp, `document.getElementById('workspace').dataset.view === 'none' ? true : null`, 3000);
    const pressedAfterEscape = await hintPressed('6');
    report(
      'instruments view: key 6 and the 6 Instruments button open and close it',
      openedByKey === true &&
        pressedAfterKey === 'true' &&
        closedByKey === true &&
        pressedAfterKeyClose === 'false' &&
        openedByClick === true &&
        pressedAfterClick === 'true' &&
        closedByEscape === true &&
        pressedAfterEscape === 'false',
      JSON.stringify({ openedByKey, pressedAfterKey, closedByKey, pressedAfterKeyClose, openedByClick, pressedAfterClick, closedByEscape, pressedAfterEscape }),
    );
    await panelHidden(1000);

    // (3) A remembered view says Connecting… first and never a no-file sentence before the cards. The script records
    // every text the message takes from document start (each added text node of every change, so two changes in one
    // task are both seen).
    writeRig(TWO);
    await reloadPage(cdp);
    await openInstruments();
    await waitFor(cdp, `document.querySelectorAll('.instrument-card').length === 2 ? true : null`, 5000);
    const recorderSource = `(() => {
      window.__instrumentsTexts = [];
      let attached = false;
      const attach = () => {
        if (attached) return;
        const node = document.getElementById('instruments-message-text');
        if (node === null) return;
        attached = true;
        window.__instrumentsTexts.push(node.textContent);
        new MutationObserver((records) => {
          for (const record of records) {
            if (record.addedNodes.length === 0) window.__instrumentsTexts.push('');
            for (const added of record.addedNodes) window.__instrumentsTexts.push(added.textContent);
          }
        }).observe(node, { childList: true, characterData: true, subtree: true });
      };
      new MutationObserver(attach).observe(document, { childList: true, subtree: true });
    })()`;
    const recorder = await cdp('Page.addScriptToEvaluateOnNewDocument', { source: recorderSource });
    let remembered;
    try {
      await reloadPage(cdp);
      await waitFor(cdp, `document.querySelectorAll('.instrument-card').length === 2 ? true : null`, 5000);
      remembered = await evaluateExpr(
        cdp,
        `(() => ({ texts: window.__instrumentsTexts, open: document.getElementById('workspace').dataset.view === 'instruments', cards: document.querySelectorAll('.instrument-card').length }))()`,
      );
    } finally {
      await cdp('Page.removeScriptToEvaluateOnNewDocument', { identifier: recorder.identifier });
    }
    const firstText = remembered.texts.find((text) => text !== '');
    report(
      'instruments view: a remembered view shows Connecting… and never the no-file sentence before the cards',
      remembered.open === true &&
        remembered.cards === 2 &&
        firstText === CONNECTION_LABELS.connecting &&
        !remembered.texts.includes(INSTRUMENTS_COPY.absentLeadFolder) &&
        !remembered.texts.includes(INSTRUMENTS_COPY.absentLeadPlain),
      JSON.stringify({ texts: remembered.texts, open: remembered.open, cards: remembered.cards }),
    );
    await closeInstruments();

    // (4) An invalid file lists 20 problems as `field · reason`, then the rest. Sixteen entries (the most the file
    // allows) each break the file's own shape twice (an id with a space and a capital, an empty port), and entry 0
    // also carries an extra key that looks like markup.
    writeRig(
      Array.from({ length: 16 }, (_, index) => ({
        id: `Bad ${index}`,
        model: 'mt32',
        port: '',
        ...(index === 0 ? { '<b>x</b>': 1 } : {}),
      })),
    );
    await reloadPage(cdp);
    await openInstruments();
    await waitFor(cdp, `document.getElementById('instruments-problems').hidden ? null : true`, 5000);
    const invalid = await evaluateExpr(
      cdp,
      `(() => ({
        lead: document.getElementById('instruments-message-text').textContent,
        closing: document.getElementById('instruments-message-closing').hidden ? null : document.getElementById('instruments-message-closing').textContent,
        rows: [...document.querySelectorAll('#instruments-problems li')].map((li) => ({
          codes: [...li.querySelectorAll('code')].map((code) => code.textContent),
          children: li.childElementCount,
          text: li.textContent,
        })),
        boldElements: document.querySelectorAll('#instruments-view b').length,
        cards: document.querySelectorAll('.instrument-card').length,
        bodyHidden: document.getElementById('instruments-body').hidden,
      }))()`,
    );
    const moreParts = MIDI_COPY.rowsMore.split('{count}');
    const problemRows = invalid.rows.slice(0, 20);
    const moreRow = invalid.rows[20];
    const moreCount = moreRow === undefined ? Number.NaN : Number(moreRow.text.slice(moreParts[0].length, moreRow.text.length - moreParts[1].length));
    report(
      'instruments view: an invalid file lists 20 problems as field · reason, then the rest',
      invalid.lead === MIDI_COPY.popSetupInvalidLead &&
        invalid.rows.length === 21 &&
        problemRows.every((row) => row.codes.length === 1 && row.children === 1 && row.text.startsWith(row.codes[0] + MIDI_COPY.rowSeparator) && row.text.length > row.codes[0].length + MIDI_COPY.rowSeparator.length) &&
        problemRows.slice(0, 3).every((row) => row.codes[0].startsWith('instruments[0]')) &&
        moreRow.codes.length === 0 &&
        moreRow.text.startsWith(moreParts[0]) &&
        moreRow.text.endsWith(moreParts[1]) &&
        Number.isInteger(moreCount) &&
        moreCount >= 5 &&
        invalid.closing === INSTRUMENTS_COPY.invalidClosing &&
        problemRows.some((row) => row.codes[0].includes('<b>x</b>')) &&
        invalid.boldElements === 0 &&
        invalid.cards === 0 &&
        invalid.bodyHidden === true,
      JSON.stringify({ lead: invalid.lead, rows: invalid.rows.length, firstRows: problemRows.slice(0, 4).map((row) => row.text), moreRow: moreRow?.text, moreCount, closing: invalid.closing, boldElements: invalid.boldElements, cards: invalid.cards }),
    );
    await closeInstruments();

    // (6) A setup the page cannot read says so and never blames the file. A probe-only script breaks one field of
    // the real midi-rig frame before the page reads it, so the page's own parseRigMessage takes its failure path.
    writeRig(TWO);
    const breakerSource = `(() => {
      const original = WebSocket.prototype.addEventListener;
      WebSocket.prototype.addEventListener = function (type, listener, options) {
        if (type !== 'message' || typeof listener !== 'function') return original.call(this, type, listener, options);
        const wrapped = function (event) {
          let data = event.data;
          try {
            const frame = JSON.parse(data);
            if (frame && frame.type === 'midi-rig' && Array.isArray(frame.instruments) && frame.instruments.length > 0) {
              frame.instruments[0].catalogSounds = -1;
              data = JSON.stringify(frame);
            }
          } catch (error) {
            // Not JSON: the page's own listener reports it.
          }
          return listener.call(this, { data });
        };
        return original.call(this, type, wrapped, options);
      };
    })()`;
    const breaker = await cdp('Page.addScriptToEvaluateOnNewDocument', { source: breakerSource });
    let unreadable;
    try {
      await reloadPage(cdp);
      await openInstruments();
      await waitFor(cdp, `document.getElementById('instruments-message').hidden ? null : document.getElementById('instruments-message-text').textContent === ${JSON.stringify(INSTRUMENTS_COPY.unreadableLead)} ? true : null`, 5000);
      unreadable = await readMessage();
    } finally {
      await cdp('Page.removeScriptToEvaluateOnNewDocument', { identifier: breaker.identifier });
    }
    report(
      'instruments view: a setup the page cannot read says so and never blames the file',
      unreadable.lead === INSTRUMENTS_COPY.unreadableLead &&
        unreadable.sub === INSTRUMENTS_COPY.unreadableSub &&
        unreadable.cards === 0 &&
        unreadable.bodyHidden === true &&
        !unreadable.text.includes(MIDI_COPY.popSetupInvalidLead) &&
        !unreadable.text.includes(INSTRUMENTS_COPY.invalidClosing),
      JSON.stringify({ lead: unreadable.lead, sub: unreadable.sub, cards: unreadable.cards }),
    );
    await closeInstruments();

    // The biggest file the rig allows: 16 instruments of one user model with 32 controls each.
    const pad = (number) => String(number).padStart(2, '0');
    fs.mkdirSync(modelsDir, { recursive: true });
    fs.writeFileSync(
      path.join(modelsDir, 'probe32.json'),
      JSON.stringify({
        id: 'probe32',
        name: 'Probe 32',
        channels: { melodic: [1, 2, 3, 4, 5, 6, 7, 8, 9], rhythm: [10] },
        bankSelect: 'none',
        defaultVolume: 100,
        controls: Array.from({ length: 32 }, (_, index) => ({ id: `c${pad(index + 1)}`, name: `Control ${pad(index + 1)}`, cc: 20 + index, min: 0, max: 127, default: 64 })),
        sounds: { melodic: [{ name: 'Probe Tone', program: 0 }], rhythm: [] },
        notes: [],
      }),
    );
    const sixteen = Array.from({ length: 16 }, (_, index) => ({ id: `p${pad(index + 1)}`, model: 'probe32', port: `Probe Port ${pad(index + 1)}` }));
    writeRig(sixteen);
    await reloadPage(cdp);
    await openInstruments();
    await waitFor(cdp, `document.querySelectorAll('.instrument-card').length === 16 ? true : null`, 5000);
    const drawn = await evaluateExpr(
      cdp,
      `(() => ({
        ids: [...document.querySelectorAll('.instrument-card')].map((card) => card.dataset.instrument),
        chips: [...document.querySelectorAll('.instrument-card')].map((card) => card.querySelectorAll('.instrument-chip').length),
      }))()`,
    );
    const settle = (ms = 250) => new Promise((resolve) => setTimeout(resolve, ms));
    const setSize = async (width, height) => {
      await cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      await settle();
    };
    const sizes = [
      [1024, 768],
      [1366, 768],
      [1920, 1080],
    ];

    // (7) 16 cards with 32 controls each scroll inside the panel at every size and in every layout.
    const overflowResults = [];
    for (const [width, height] of sizes) {
      await setSize(width, height);
      for (const layout of ['a', 'b', 'c']) {
        await blurFocus();
        await pressKey(cdp, layout);
        const measured = await evaluateExpr(
          cdp,
          `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => {
            const el = (id) => document.getElementById(id);
            const root = parseFloat(getComputedStyle(document.documentElement).fontSize);
            const body = el('instruments-body');
            const list = el('instruments-list');
            const notice = el('instruments-notice');
            const cards = [...list.querySelectorAll('.instrument-card')];
            const box = (node) => node.getBoundingClientRect();
            const chipsOutside = cards.reduce((count, card) => {
              const cardBox = box(card);
              return count + [...card.querySelectorAll('.instrument-chip')].filter((chip) => box(chip).left < cardBox.left - 0.5 || box(chip).right > cardBox.right + 0.5).length;
            }, 0);
            const noticeBefore = box(notice).top;
            const noticeBottom = box(notice).bottom;
            const bodyTop = box(body).top;
            const scrolls = body.scrollHeight > body.clientHeight;
            const cardsOverflowing = cards.filter((card) => card.scrollWidth > card.clientWidth).length;
            const widths = cards.slice(0, 2).map((card) => box(card).width);
            const firstTop = box(cards[0]).top;
            const columns = cards.filter((card) => Math.abs(box(card).top - firstTop) < 1).length;
            const cardHeight = box(cards[cards.length - 1]).height;
            body.scrollTop = body.scrollHeight;
            const last = box(cards[cards.length - 1]);
            const bodyBox = box(body);
            const noticeAfter = box(notice).top;
            const listFits = list.scrollWidth <= list.clientWidth;
            const bodyFits = body.scrollWidth <= body.clientWidth;
            body.scrollTop = 0;
            resolve({
              layout: el('workspace').dataset.layout,
              root,
              noticeShown: !notice.hidden,
              noticeAbove: noticeBottom <= bodyTop + 1,
              noticeStill: noticeBefore === noticeAfter,
              scrolls,
              cardsOverflowing,
              listFits,
              bodyFits,
              chipsOutside,
              widths,
              columns,
              lastReachable: last.bottom <= bodyBox.bottom + 1 && last.bottom >= bodyBox.top,
              lastInside: last.top >= bodyBox.top - 1 && last.bottom <= bodyBox.bottom + 1,
              lastTaller: cardHeight > bodyBox.height,
              docFits: document.documentElement.scrollWidth <= window.innerWidth,
            });
          })))`,
        );
        const ok =
          measured.layout === layout &&
          measured.noticeShown &&
          measured.noticeAbove &&
          measured.noticeStill &&
          measured.scrolls &&
          measured.cardsOverflowing === 0 &&
          measured.listFits &&
          measured.bodyFits &&
          measured.docFits &&
          measured.chipsOutside === 0 &&
          measured.widths.every((cardWidth) => cardWidth >= 18 * measured.root) &&
          measured.lastReachable &&
          (measured.lastInside || measured.lastTaller);
        overflowResults.push({ size: `${width}x${height}`, ok, ...measured });
      }
    }
    await cdp('Emulation.clearDeviceMetricsOverride');
    const overflowBad = overflowResults.filter((result) => !result.ok);
    report(
      'instruments view: 16 cards with 32 controls scroll inside the panel at every size and layout',
      drawn.ids.length === 16 &&
        JSON.stringify(drawn.ids) === JSON.stringify(sixteen.map((entry) => entry.id)) &&
        drawn.chips.every((count) => count === 32) &&
        overflowBad.length === 0,
      JSON.stringify({
        cards: drawn.ids.length,
        chips: [...new Set(drawn.chips)],
        combos: overflowResults.map((result) => `${result.size}${result.layout}:${result.columns}col,w${Math.round(result.widths[0])}`),
        bad: overflowBad,
      }),
    );

    // (9) Tab walks each card, then its switch, in file order, and the view keys still work from a card.
    await openInstruments();
    await evaluateExpr(cdp, `document.querySelector('.instrument-card').focus()`);
    const readStop = () =>
      evaluateExpr(
        cdp,
        `(() => {
          const active = document.activeElement;
          const card = active.closest('.instrument-card');
          if (card === null) return null;
          return card.dataset.instrument + (active.classList.contains('instrument-switch') ? ':switch' : active.classList.contains('instrument-edit') ? ':edit' : active === card ? ':card' : ':other');
        })()`,
      );
    const walked = [await readStop()];
    for (let step = 0; step < 47; step += 1) {
      await pressKey(cdp, 'Tab');
      walked.push(await readStop());
    }
    await evaluateExpr(cdp, `document.querySelector('.instrument-card').focus()`);
    await pressKey(cdp, 'b');
    const layoutAfterB = await workspace('layout');
    await pressKey(cdp, '6');
    const closedFromCard = await waitFor(cdp, `document.getElementById('workspace').dataset.view === 'none' ? true : null`, 3000);
    await pressKey(cdp, '6');
    const reopenedFromBody = await waitFor(cdp, `document.getElementById('workspace').dataset.view === 'instruments' ? true : null`, 3000);
    const expectedWalk = sixteen.flatMap((entry) => [`${entry.id}:card`, `${entry.id}:switch`, `${entry.id}:edit`]);
    report(
      'instruments view: Tab walks each card, its switch, then Edit settings, in file order, and the view keys still work from a card',
      JSON.stringify(walked) === JSON.stringify(expectedWalk) && layoutAfterB === 'b' && closedFromCard === true && reopenedFromBody === true,
      JSON.stringify({ walked, layoutAfterB, closedFromCard, reopenedFromBody }),
    );

    // (10) A right-click on a card asks about that instrument; the footer gives the whole session; Shift keeps the browser's menu.
    await openInstruments();
    const closeAsk = async () => {
      if (await evaluateExpr(cdp, `!document.getElementById('ask-box').hidden`)) await pressKey(cdp, 'Escape');
      await waitFor(cdp, `document.getElementById('ask-box').hidden ? true : null`, 2000);
    };
    const onCard = await askAt(cdp, '.instrument-card', { index: 1 });
    await closeAsk();
    await openInstruments();
    const onFooter = await askAt(cdp, '#instruments-footer');
    await closeAsk();
    await openInstruments();
    const withShift = await askAt(cdp, '.instrument-card', { index: 1, shiftKey: true });
    await closeAsk();
    report(
      'instruments view: a right-click on a card asks about that instrument',
      onCard.prevented === true &&
        onCard.open === true &&
        onCard.chip === 'Instrument p02' &&
        onFooter.prevented === true &&
        onFooter.open === true &&
        onFooter.chip === ASK_COPY.wholeSession &&
        withShift.prevented === false &&
        withShift.open === false,
      JSON.stringify({ onCard, onFooter, withShift }),
    );

    // (11) With the view open, clicks, scrolling, Tab and a resize send no socket message and write no storage; one press
    // on a switch sends exactly one instrument-switch (a set to the other state) and still stores nothing.
    await openInstruments();
    fs.rmSync(stateFile, { force: true });
    const before = await evaluateExpr(
      cdp,
      `(() => {
        window.__instrumentsSpy = { sends: 0, switchFrames: [], sets: 0, send: WebSocket.prototype.send, setItem: Storage.prototype.setItem };
        WebSocket.prototype.send = function (...args) {
          const spy = window.__instrumentsSpy;
          spy.sends += 1;
          try {
            const frame = JSON.parse(args[0]);
            if (frame.type === 'instrument-switch') spy.switchFrames.push(frame);
          } catch (err) {
            // A frame that is not JSON is counted as a send and nothing else.
          }
          return spy.send.apply(this, args);
        };
        Storage.prototype.setItem = function (...args) { window.__instrumentsSpy.sets += 1; return window.__instrumentsSpy.setItem.apply(this, args); };
        return document.getElementById('instruments-list').innerHTML;
      })()`,
    );
    let quiet;
    let pressed;
    try {
      await clickElement(cdp, '.instrument-card:nth-child(2)');
      await clickElement(cdp, '.instrument-chip');
      await clickElement(cdp, '.instrument-label');
      await evaluateExpr(cdp, `document.getElementById('instruments-body').scrollTop = 300`);
      await evaluateExpr(cdp, `document.querySelector('.instrument-card').focus()`);
      for (let step = 0; step < 3; step += 1) await pressKey(cdp, 'Tab');
      await setSize(1366, 768);
      await cdp('Emulation.clearDeviceMetricsOverride');
      await settle();
      quiet = await evaluateExpr(
        cdp,
        `(() => {
          const spy = window.__instrumentsSpy;
          return {
            sends: spy.sends,
            sets: spy.sets,
            open: document.getElementById('workspace').dataset.view === 'instruments',
            askOpen: !document.getElementById('ask-box').hidden,
            list: document.getElementById('instruments-list').innerHTML,
          };
        })()`,
      );
      // One press on the switch of p02 sends one frame, the server answers, and the card shows Off; a second press brings it back.
      const switchOfP02 = '.instrument-card[data-instrument="p02"] .instrument-switch';
      const p02Is = (checked) =>
        waitFor(cdp, `(() => { const b = document.querySelector(${JSON.stringify(switchOfP02)}); return b !== null && b.getAttribute('aria-checked') === ${JSON.stringify(checked)} && b.getAttribute('aria-busy') === null ? true : null; })()`, 5000);
      await clickElement(cdp, switchOfP02);
      const turnedOff = await p02Is('false');
      const afterOne = await evaluateExpr(cdp, `({ frames: window.__instrumentsSpy.switchFrames, sets: window.__instrumentsSpy.sets })`);
      await clickElement(cdp, switchOfP02);
      const turnedOn = await p02Is('true');
      pressed = { turnedOff, turnedOn, afterOne };
    } finally {
      await evaluateExpr(
        cdp,
        `(() => {
          const spy = window.__instrumentsSpy;
          WebSocket.prototype.send = spy.send;
          Storage.prototype.setItem = spy.setItem;
          delete window.__instrumentsSpy;
        })()`,
      );
    }
    const oneFrame = pressed.afterOne.frames.length === 1 ? pressed.afterOne.frames[0] : null;
    report(
      'instruments view: clicks, scrolling, Tab and a resize send nothing; one switch press sends one instrument-switch; nothing is stored',
      quiet.sends === 0 &&
        quiet.sets === 0 &&
        quiet.open === true &&
        quiet.askOpen === false &&
        quiet.list === before &&
        pressed.turnedOff === true &&
        pressed.turnedOn === true &&
        oneFrame !== null &&
        oneFrame.instrument === 'p02' &&
        oneFrame.enabled === false &&
        typeof oneFrame.id === 'string' &&
        pressed.afterOne.sets === 0,
      JSON.stringify({ sends: quiet.sends, sets: quiet.sets, open: quiet.open, askOpen: quiet.askOpen, listUnchanged: quiet.list === before, ...pressed }),
    );
    fs.rmSync(stateFile, { force: true });
    await closeInstruments();

    // Sixteen switches, two requests in flight: each shows its own pending look and nothing moves or reorders.
    await reloadPage(cdp);
    await openInstruments();
    await waitFor(cdp, `document.querySelectorAll('.instrument-card .instrument-switch').length === 16 ? true : null`, 5000);
    const layoutOf = () =>
      evaluateExpr(
        cdp,
        `(() => {
          const body = document.getElementById('instruments-body');
          const bodyTop = body.getBoundingClientRect().top;
          return [...document.querySelectorAll('.instrument-card')].map((card) => {
            const r = card.getBoundingClientRect();
            return [card.dataset.instrument, Math.round(r.left), Math.round(r.top - bodyTop + body.scrollTop), Math.round(r.width), Math.round(r.height)];
          });
        })()`,
      );
    const layoutBefore = await layoutOf();
    await evaluateExpr(
      cdp,
      `(() => {
        window.__originalSend = WebSocket.prototype.send;
        window.__switchFramesDropped = 0;
        WebSocket.prototype.send = function (data) {
          let type = null;
          try { type = JSON.parse(data).type; } catch (err) { type = null; }
          if (type === 'instrument-switch') { window.__switchFramesDropped += 1; return; }
          return window.__originalSend.call(this, data);
        };
      })()`,
    );
    let inFlight;
    try {
      await clickElement(cdp, '.instrument-card[data-instrument="p03"] .instrument-switch');
      await clickElement(cdp, '.instrument-card[data-instrument="p05"] .instrument-switch');
      inFlight = await evaluateExpr(
        cdp,
        `(() => {
          const busy = [...document.querySelectorAll('.instrument-switch[aria-busy="true"]')].map((button) => [button.closest('.instrument-card').dataset.instrument, button.querySelector('.instrument-switch-word').textContent, button.getAttribute('aria-disabled')]);
          return { busy, dropped: window.__switchFramesDropped, ids: [...document.querySelectorAll('.instrument-card')].map((card) => card.dataset.instrument) };
        })()`,
      );
    } finally {
      await evaluateExpr(cdp, `(() => { WebSocket.prototype.send = window.__originalSend; })()`);
    }
    const layoutAfter = await layoutOf();
    report(
      'instruments view: sixteen switches, two requests in flight, nothing moves',
      layoutBefore.length === 16 &&
        JSON.stringify(inFlight.busy) === JSON.stringify([['p03', INSTRUMENTS_COPY.switchTurningOff, 'true'], ['p05', INSTRUMENTS_COPY.switchTurningOff, 'true']]) &&
        inFlight.dropped === 2 &&
        JSON.stringify(inFlight.ids) === JSON.stringify(sixteen.map((entry) => entry.id)) &&
        JSON.stringify(layoutAfter) === JSON.stringify(layoutBefore),
      JSON.stringify({ busy: inFlight.busy, dropped: inFlight.dropped, moved: layoutAfter.filter((entry, index) => JSON.stringify(entry) !== JSON.stringify(layoutBefore[index])) }),
    );
    // The pending looks end with the page: a reload forgets them (and the server never saw the frames).
    await closeInstruments();
    await reloadPage(cdp);

    // A switch changed by the server (another page, Claude's session) flips the card in place: the same node, the same
    // focus, the same scroll, and no focus() call. A hand-written state file and get_midi_instruments stand for the push.
    await openInstruments();
    await waitFor(cdp, `document.querySelectorAll('.instrument-card .instrument-switch').length === 16 ? true : null`, 5000);
    await evaluateExpr(
      cdp,
      `(() => {
        const button = document.querySelector('.instrument-card[data-instrument="p04"] .instrument-switch');
        button.focus();
        window.__probeSwitch = button;
        document.getElementById('instruments-body').scrollTop = 200;
        window.__probeFocusCalls = 0;
        window.__probeFocus = HTMLElement.prototype.focus;
        HTMLElement.prototype.focus = function (...args) { window.__probeFocusCalls += 1; return window.__probeFocus.apply(this, args); };
      })()`,
    );
    const scrollBefore = await evaluateExpr(cdp, `document.getElementById('instruments-body').scrollTop`);
    let flipped;
    try {
      fs.writeFileSync(stateFile, JSON.stringify({ off: ['p04'] }));
      await callTool(client, 'get_midi_instruments', {});
      const flippedIn = await waitFor(cdp, `document.querySelector('.instrument-card[data-instrument="p04"]').dataset.enabled === 'false' ? true : null`, 5000);
      flipped = await evaluateExpr(
        cdp,
        `(() => {
          const card = document.querySelector('.instrument-card[data-instrument="p04"]');
          const button = card.querySelector('.instrument-switch');
          return {
            sameNode: button === window.__probeSwitch,
            stillFocused: document.activeElement === window.__probeSwitch,
            checked: button.getAttribute('aria-checked'),
            word: button.querySelector('.instrument-switch-word').textContent,
            scrollTop: document.getElementById('instruments-body').scrollTop,
            focusCalls: window.__probeFocusCalls,
            status: document.getElementById('instruments-status').textContent,
            words: card.querySelector('.instrument-state').textContent,
          };
        })()`,
      );
      flipped.flippedIn = flippedIn === true;
      // Back on, again by the server: the same node flips back.
      fs.rmSync(stateFile, { force: true });
      await callTool(client, 'get_midi_instruments', {});
      flipped.backOn = (await waitFor(cdp, `document.querySelector('.instrument-card[data-instrument="p04"]').dataset.enabled === 'true' ? true : null`, 5000)) === true;
      flipped.backSame = await evaluateExpr(cdp, `document.querySelector('.instrument-card[data-instrument="p04"] .instrument-switch') === window.__probeSwitch`);
      flipped.backStatus = await evaluateExpr(cdp, `document.getElementById('instruments-status').textContent`);
    } finally {
      fs.rmSync(stateFile, { force: true });
      await evaluateExpr(cdp, `(() => { HTMLElement.prototype.focus = window.__probeFocus; })()`);
    }
    report(
      'instruments view: a switch changed by the server flips the card in place, keeps focus and scroll',
      flipped.flippedIn === true &&
        flipped.sameNode === true &&
        flipped.stillFocused === true &&
        flipped.checked === 'false' &&
        flipped.word === INSTRUMENTS_COPY.switchOff &&
        flipped.scrollTop === scrollBefore &&
        flipped.focusCalls === 0 &&
        flipped.status === fill(MIDI_COPY.dotSwitchedOff, { port: 'p04' }) &&
        flipped.words === MIDI_COPY.rowSwitchedOff &&
        flipped.backOn === true &&
        flipped.backSame === true &&
        flipped.backStatus === fill(INSTRUMENTS_COPY.announceOn, { id: 'p04' }),
      JSON.stringify({ scrollBefore, ...flipped }),
    );
    await closeInstruments();

    // --- The settings editor on the card ---
    // Keyboard, the single message of a Save, long text, and a change made elsewhere, in the real page. The sixteen fixture is
    // in the data folder; Save really rewrites it, so each check puts the file back and removes the .bak.
    const edCardOf = (id) => `.instrument-card[data-instrument="${id}"]`;
    const edEditOf = (id) => `${edCardOf(id)} .instrument-edit`;
    const edFormOf = (id) => `${edCardOf(id)} form.instrument-editor`;
    const edChipOf = (id, channel) => `${edFormOf(id)} .instrument-channel:nth-child(${channel})`;
    const edBakFile = `${rigFile}.bak`;
    const restoreSixteen = () => {
      writeRig(sixteen);
      fs.rmSync(edBakFile, { force: true });
    };
    /** What holds focus in a card, as a role (the select, chip N, the clock, Save, Cancel, the switch, Edit settings, the card). */
    const focusRole = () =>
      evaluateExpr(
        cdp,
        `(() => {
          const active = document.activeElement;
          const card = active === null ? null : active.closest('.instrument-card');
          if (card === null) return null;
          const id = card.dataset.instrument;
          if (active === card) return id + ':card';
          if (active.classList.contains('instrument-switch')) return id + ':switch';
          if (active.classList.contains('instrument-edit')) return id + ':edit';
          if (active.tagName === 'SELECT') return id + ':port';
          if (active.tagName === 'INPUT') {
            const chip = active.closest('.instrument-channel');
            if (chip !== null) return id + ':chip' + chip.parentElement.children.length + '/' + (Array.prototype.indexOf.call(chip.parentElement.children, chip) + 1);
            return id + ':clock';
          }
          if (active.tagName === 'BUTTON') return id + ':' + active.textContent;
          return id + ':other';
        })()`,
      );

    await openInstruments();
    await waitFor(cdp, `document.querySelectorAll('.instrument-card .instrument-edit').length === 16 ? true : null`, 5000);

    // (E1) Focus, the Tab walk, the inert keys and Esc.
    await clickElement(cdp, edEditOf('p02'));
    await waitFor(cdp, `document.querySelector(${JSON.stringify(edFormOf('p02'))}) !== null ? true : null`, 3000);
    const afterOpen = await focusRole();
    const editHiddenWhileOpen = await evaluateExpr(cdp, `document.querySelector(${JSON.stringify(edEditOf('p02'))}).hidden`);
    const edEditorWalk = [afterOpen];
    for (let step = 0; step < 13; step += 1) {
      await pressKey(cdp, 'Tab');
      edEditorWalk.push(await focusRole());
    }
    const expectedEditorWalk = ['p02:port', ...Array.from({ length: 10 }, (_, index) => `p02:chip10/${index + 1}`), 'p02:clock', 'p02:Save', 'p02:Cancel'];
    // A chip holds focus; the page's single-key shortcuts must do nothing there.
    await evaluateExpr(cdp, `document.querySelector(${JSON.stringify(`${edChipOf('p02', 4)} input`)}).focus()`);
    const edViewBefore = await workspace('view');
    const edLayoutBefore = await workspace('layout');
    for (const key of ['2', 'b', '6']) await pressKey(cdp, key);
    const edInert = { view: await workspace('view'), layout: await workspace('layout'), role: await focusRole(), formThere: await evaluateExpr(cdp, `document.querySelector(${JSON.stringify(edFormOf('p02'))}) !== null`) };
    // Esc closes the editor only; focus lands on Edit settings; a second Esc closes the view.
    await pressKey(cdp, 'Escape');
    const editorGone = await waitFor(cdp, `document.querySelector(${JSON.stringify(edFormOf('p02'))}) === null ? true : null`, 3000);
    const edAfterEsc = { role: await focusRole(), view: await workspace('view'), editShown: await evaluateExpr(cdp, `!document.querySelector(${JSON.stringify(edEditOf('p02'))}).hidden`) };
    await pressKey(cdp, 'Escape');
    const viewClosed = await waitFor(cdp, `document.getElementById('workspace').dataset.view === 'none' ? true : null`, 3000);
    // On the switch the keys still work.
    await openInstruments();
    await evaluateExpr(cdp, `document.querySelector(${JSON.stringify(`${edCardOf('p02')} .instrument-switch`)}).focus()`);
    const edStartLayout2 = await workspace('layout');
    const edOtherKey = edStartLayout2 === 'b' ? 'a' : 'b';
    await pressKey(cdp, edOtherKey);
    const changedByKey = await workspace('layout');
    await pressKey(cdp, edStartLayout2);
    const layoutBack = await workspace('layout');
    report(
      'instruments editor: focus, Tab order, inert keys and Esc',
      afterOpen === 'p02:port' &&
        editHiddenWhileOpen === true &&
        JSON.stringify(edEditorWalk) === JSON.stringify(expectedEditorWalk) &&
        edInert.view === edViewBefore &&
        edInert.layout === edLayoutBefore &&
        edInert.role === 'p02:chip10/4' &&
        edInert.formThere === true &&
        editorGone === true &&
        edAfterEsc.role === 'p02:edit' &&
        edAfterEsc.view === 'instruments' &&
        edAfterEsc.editShown === true &&
        viewClosed === true &&
        changedByKey === edOtherKey &&
        layoutBack === edStartLayout2,
      JSON.stringify({ edEditorWalk, edInert, edAfterEsc, viewClosed, changedByKey, layoutBack }),
    );

    // (E2) Save sends exactly one instrument-settings message with the full chosen set, and stores nothing.
    await openInstruments();
    await waitFor(cdp, `document.querySelectorAll('.instrument-card .instrument-edit').length === 16 ? true : null`, 5000);
    await evaluateExpr(
      cdp,
      `(() => {
        const spy = { send: WebSocket.prototype.send, setItem: Storage.prototype.setItem, frames: [], sets: 0, sends: 0 };
        window.__editorSpy = spy;
        WebSocket.prototype.send = function (...args) {
          spy.sends += 1;
          try {
            const edFrame = JSON.parse(args[0]);
            if (edFrame.type === 'instrument-settings') spy.frames.push(edFrame);
          } catch (err) {
            // Not JSON: counted as a send and nothing else.
          }
          return spy.send.apply(this, args);
        };
        Storage.prototype.setItem = function (...args) { spy.sets += 1; return spy.setItem.apply(this, args); };
      })()`,
    );
    let edSaved;
    try {
      await clickElement(cdp, edEditOf('p02'));
      await waitFor(cdp, `document.querySelector(${JSON.stringify(edFormOf('p02'))}) !== null ? true : null`, 3000);
      await clickElement(cdp, edChipOf('p02', 3));
      await clickElement(cdp, edChipOf('p02', 7));
      const checkedChips = await evaluateExpr(cdp, `Array.from(document.querySelectorAll(${JSON.stringify(`${edFormOf('p02')} .instrument-channel`)})).filter((chip) => chip.querySelector('input').checked).map((chip) => parseInt(chip.textContent, 10))`);
      const sendsBefore = await evaluateExpr(cdp, 'window.__editorSpy.sends');
      await clickElement(cdp, `${edFormOf('p02')} button[type="submit"]`);
      const closed = await waitFor(cdp, `document.querySelector(${JSON.stringify(edFormOf('p02'))}) === null ? true : null`, 5000);
      edSaved = await evaluateExpr(cdp, `({ frames: window.__editorSpy.frames, sets: window.__editorSpy.sets, sendsSince: window.__editorSpy.sends })`);
      edSaved.checkedChips = checkedChips;
      edSaved.closed = closed === true;
      edSaved.sendsBefore = sendsBefore;
      edSaved.focusRole = await focusRole();
    } finally {
      await evaluateExpr(cdp, `(() => { const spy = window.__editorSpy; WebSocket.prototype.send = spy.send; Storage.prototype.setItem = spy.setItem; delete window.__editorSpy; })()`);
    }
    const edFrame = edSaved.frames.length === 1 ? edSaved.frames[0] : null;
    report(
      'instruments editor: Save sends exactly one instrument-settings message with the full chosen set',
      edFrame !== null &&
        edFrame.instrument === 'p02' &&
        typeof edFrame.id === 'string' &&
        JSON.stringify(edFrame.settings) === JSON.stringify({ port: 'Probe Port 02', channels: edSaved.checkedChips, clock: false }) &&
        JSON.stringify(edSaved.checkedChips) === JSON.stringify([1, 2, 4, 5, 6, 8, 9, 10]) &&
        edSaved.sendsSince === edSaved.sendsBefore + 1 &&
        edSaved.sets === 0 &&
        edSaved.closed === true &&
        edSaved.focusRole === 'p02:edit',
      JSON.stringify({ frames: edSaved.frames.length, edFrame, sets: edSaved.sets, sendsBefore: edSaved.sendsBefore, sendsSince: edSaved.sendsSince, closed: edSaved.closed, focus: edSaved.focusRole }),
    );
    restoreSixteen();
    await closeInstruments();

    // (E3) A change made elsewhere updates the rows, leaves the draft, the focused field and every other card alone.
    await reloadPage(cdp);
    await openInstruments();
    await waitFor(cdp, `document.querySelectorAll('.instrument-card .instrument-edit').length === 16 ? true : null`, 5000);
    await clickElement(cdp, edEditOf('p03'));
    await waitFor(cdp, `document.querySelector(${JSON.stringify(edFormOf('p03'))}) !== null ? true : null`, 3000);
    await clickElement(cdp, edChipOf('p03', 2));
    await evaluateExpr(
      cdp,
      `(() => {
        document.querySelector(${JSON.stringify(`${edChipOf('p03', 6)} input`)}).focus();
        for (const card of document.querySelectorAll('.instrument-card')) card.dataset.probeMark = '1';
        document.getElementById('instruments-body').scrollTop = 150;
        window.__probeFocusCalls = 0;
        window.__probeFocus = HTMLElement.prototype.focus;
        HTMLElement.prototype.focus = function (...args) { window.__probeFocusCalls += 1; return window.__probeFocus.apply(this, args); };
      })()`,
    );
    const edScrollKept = await evaluateExpr(cdp, `document.getElementById('instruments-body').scrollTop`);
    let edElsewhere;
    try {
      writeRig(sixteen.map((entry) => (entry.id === 'p03' ? { ...entry, clock: true } : entry)));
      await callTool(client, 'get_midi_instruments', {});
      const clockRow = await waitFor(cdp, `Array.from(document.querySelectorAll(${JSON.stringify(`${edCardOf('p03')} dt.instrument-label`)})).some((label) => label.textContent === 'Clock') ? true : null`, 5000);
      edElsewhere = await evaluateExpr(
        cdp,
        `(() => {
          const card = document.querySelector(${JSON.stringify(edCardOf('p03'))});
          const form = card.querySelector('form.instrument-editor');
          const chips = Array.from(form.querySelectorAll('.instrument-channel input'));
          const notes = Array.from(form.querySelectorAll('.instrument-hint')).map((node) => node.textContent);
          return {
            marksKept: document.querySelectorAll('.instrument-card[data-probe-mark="1"]').length,
            replaced: card.dataset.probeMark === undefined,
            draft: chips.map((input) => input.checked),
            focusOnChip6: document.activeElement === chips[5],
            notes,
            scrollTop: document.getElementById('instruments-body').scrollTop,
            focusCalls: window.__probeFocusCalls,
            status: document.getElementById('instruments-status').textContent,
          };
        })()`,
      );
      edElsewhere.clockRow = clockRow === true;
    } finally {
      await evaluateExpr(cdp, `(() => { HTMLElement.prototype.focus = window.__probeFocus; })()`);
    }
    // The file becomes invalid: the invalid-file message replaces the cards and no editor is left.
    fs.writeFileSync(rigFile, '{ "instruments": [ { "id": "p01" ');
    await callTool(client, 'get_midi_instruments', {});
    const invalidShown = await waitFor(cdp, `document.getElementById('instruments-message').hidden ? null : document.getElementById('instruments-message-text').textContent === ${JSON.stringify(MIDI_COPY.popSetupInvalidLead)} ? true : null`, 5000);
    const noEditorUnderMessage = await evaluateExpr(cdp, `document.querySelectorAll('.instrument-editor').length === 0 && document.querySelectorAll('.instrument-card').length === 0`);
    restoreSixteen();
    await callTool(client, 'get_midi_instruments', {});
    await waitFor(cdp, `document.querySelectorAll('.instrument-card').length === 16 ? true : null`, 5000);
    const draftDropped = await evaluateExpr(cdp, `document.querySelectorAll('.instrument-editor').length === 0`);
    report(
      'instruments editor: a change made elsewhere updates the rows and keeps the draft and the focus',
      edElsewhere.clockRow === true &&
        edElsewhere.marksKept === 15 &&
        edElsewhere.replaced === true &&
        JSON.stringify(edElsewhere.draft) === JSON.stringify([true, false, true, true, true, true, true, true, true, true]) &&
        edElsewhere.focusOnChip6 === true &&
        edElsewhere.notes.filter((note) => note === INSTRUMENTS_COPY.changedElsewhere).length === 1 &&
        edElsewhere.scrollTop === edScrollKept &&
        edElsewhere.focusCalls === 1 &&
        edElsewhere.status === fill(INSTRUMENTS_COPY.announceSettings, { id: 'p03' }) &&
        invalidShown === true &&
        noEditorUnderMessage === true &&
        draftDropped === true,
      JSON.stringify({ ...edElsewhere, edScrollKept, invalidShown, noEditorUnderMessage, draftDropped }),
    );
    await closeInstruments();

    // (E4) A 200-character port and a 300-character reason wrap inside the card. The reason is injected into the
    // answer's frame (the server's own reason is short), so the real refusal path draws it.
    const edLongPort = Array.from({ length: 19 }, (_, index) => `Port${pad(index)}abcd`).join('') + 'wxyzabcdef';
    writeRig([{ id: 'longp', model: 'probe32', port: edLongPort }]);
    const edLongReason = 'ReasonWithoutSpaces'.repeat(16).slice(0, 300);
    const edWrapperSource = `(() => {
      const original = WebSocket.prototype.addEventListener;
      WebSocket.prototype.addEventListener = function (type, listener, options) {
        if (type !== 'message' || typeof listener !== 'function') return original.call(this, type, listener, options);
        const wrapped = function (event) {
          let data = event.data;
          try {
            const frame = JSON.parse(data);
            if (frame && frame.type === 'instrument-result' && Array.isArray(frame.problems) && frame.problems.length > 0) {
              frame.problems[0].reason = ${JSON.stringify(edLongReason)};
              data = JSON.stringify(frame);
            }
          } catch (error) {
            // Not JSON: the page's own listener reports it.
          }
          return listener.call(this, { data });
        };
        return original.call(this, type, wrapped, options);
      };
    })()`;
    const edWrapper = await cdp('Page.addScriptToEvaluateOnNewDocument', { source: edWrapperSource });
    let edLongRead;
    try {
      await reloadPage(cdp);
      await openInstruments();
      await waitFor(cdp, `document.querySelectorAll('.instrument-card .instrument-edit').length === 1 ? true : null`, 5000);
      await setSize(1000, 380);
      await clickElement(cdp, edEditOf('longp'));
      await waitFor(cdp, `document.querySelector(${JSON.stringify(edFormOf('longp'))}) !== null ? true : null`, 3000);
      const edPortPart = await evaluateExpr(
        cdp,
        `(() => {
          const card = document.querySelector(${JSON.stringify(edCardOf('longp'))});
          const select = card.querySelector('select');
          const name = card.querySelector('.instrument-port-name');
          const cardBox = card.getBoundingClientRect();
          const selectBox = select.getBoundingClientRect();
          const line = parseFloat(getComputedStyle(name).lineHeight);
          return {
            selectInside: selectBox.left >= cardBox.left - 0.5 && selectBox.right <= cardBox.right + 0.5,
            title: select.title,
            optionText: select.options[0].textContent,
            rowWrapped: name.getBoundingClientRect().height > line * 1.5,
            rowText: name.textContent,
            cardFits: card.scrollWidth <= card.clientWidth,
          };
        })()`,
      );
      for (let channel = 1; channel <= 10; channel += 1) await clickElement(cdp, edChipOf('longp', channel));
      await clickElement(cdp, `${edFormOf('longp')} button[type="submit"]`);
      await waitFor(cdp, `document.querySelector(${JSON.stringify(`${edFormOf('longp')} .instrument-errors`)}) !== null ? true : null`, 5000);
      edLongRead = await evaluateExpr(
        cdp,
        `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => {
          const card = document.querySelector(${JSON.stringify(edCardOf('longp'))});
          const list = card.querySelector('.instrument-errors');
          const body = document.getElementById('instruments-body');
          resolve({
            reason: list.textContent,
            listFits: list.scrollWidth <= list.clientWidth,
            cardFits: card.scrollWidth <= card.clientWidth,
            bodyFits: body.scrollWidth <= body.clientWidth,
            bodyScrolls: body.scrollHeight > body.clientHeight && ['auto', 'scroll'].includes(getComputedStyle(body).overflowY),
            wrap: getComputedStyle(list).overflowWrap,
          });
        })))`,
      );
      Object.assign(edLongRead, { edPortPart });
    } finally {
      await cdp('Emulation.clearDeviceMetricsOverride');
      await cdp('Page.removeScriptToEvaluateOnNewDocument', { identifier: edWrapper.identifier });
    }
    report(
      'instruments editor: a 200-character port and a 300-character reason wrap inside the card',
      edLongPort.length === 200 &&
        edLongRead.edPortPart.selectInside === true &&
        edLongRead.edPortPart.title === edLongPort &&
        edLongRead.edPortPart.optionText === edLongPort &&
        edLongRead.edPortPart.rowWrapped === true &&
        edLongRead.edPortPart.rowText === edLongPort &&
        edLongRead.edPortPart.cardFits === true &&
        edLongRead.reason === `Channels${MIDI_COPY.rowSeparator}${edLongReason}` &&
        edLongRead.listFits === true &&
        edLongRead.cardFits === true &&
        edLongRead.bodyFits === true &&
        edLongRead.bodyScrolls === true &&
        edLongRead.wrap === 'anywhere',
      JSON.stringify(edLongRead),
    );
    restoreSixteen();
    await reloadPage(cdp);
    await closeInstruments();

    // A 32-character id wraps beside its switch at the narrowest card (18rem): the switch keeps its place on the first
    // line and nothing overflows, also while it says Turning off….
    const LONG_ID = 'abcdefghijklmnopqrstuvwxyz012345';
    writeRig([{ id: LONG_ID, model: 'probe32', port: 'Probe Port Long' }, sixteen[1]]);
    await reloadPage(cdp);
    await openInstruments();
    await waitFor(cdp, `document.querySelectorAll('.instrument-card .instrument-switch').length === 2 ? true : null`, 5000);
    await evaluateExpr(
      cdp,
      `(() => {
        window.__originalSend = WebSocket.prototype.send;
        WebSocket.prototype.send = function (data) {
          let type = null;
          try { type = JSON.parse(data).type; } catch (err) { type = null; }
          if (type === 'instrument-switch') return;
          return window.__originalSend.call(this, data);
        };
      })()`,
    );
    const measureHead = () =>
      evaluateExpr(
        cdp,
        `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => {
          const root = parseFloat(getComputedStyle(document.documentElement).fontSize);
          const body = document.getElementById('instruments-body');
          const card = document.querySelector('.instrument-card');
          const name = card.querySelector('.instrument-name');
          const button = card.querySelector('.instrument-switch');
          const lineHeight = parseFloat(getComputedStyle(name).lineHeight);
          const cardBox = card.getBoundingClientRect();
          const buttonBox = button.getBoundingClientRect();
          const nameBox = name.getBoundingClientRect();
          resolve({
            cardRem: Math.round((cardBox.width / root) * 100) / 100,
            bodyWidth: body.clientWidth,
            bodyScrollWidth: body.scrollWidth,
            bodyFits: body.scrollWidth <= body.clientWidth,
            cardFits: card.scrollWidth <= card.clientWidth,
            nameLines: Math.round(nameBox.height / lineHeight),
            nameText: name.textContent,
            switchTopDelta: Math.round(Math.abs(buttonBox.top - nameBox.top) * 100) / 100,
            switchInsideCard: buttonBox.right <= cardBox.right + 0.5 && buttonBox.left >= cardBox.left - 0.5,
            switchNoShrink: getComputedStyle(button).flexShrink === '0',
            switchFits: button.scrollWidth <= button.clientWidth + 1,
            word: button.querySelector('.instrument-switch-word').textContent,
          });
        })))`,
      );
    let narrow = null;
    let narrowWidth = null;
    let narrowPending = null;
    const tried = [];
    try {
      // The narrowest window whose panel holds one card of 18rem without a horizontal scrollbar. The panel is a share of the
      // window, so the first reading (a card wider than its panel) says which share, and the width follows from it.
      await setSize(400, 800);
      const first = await measureHead();
      tried.push([400, first.cardRem, first.bodyWidth, first.bodyScrollWidth]);
      let width = Math.ceil((first.bodyScrollWidth / first.bodyWidth) * 400) + 1;
      for (let attempt = 0; attempt < 8 && narrow === null; attempt += 1, width += 2) {
        await setSize(width, 800);
        const measured = await measureHead();
        tried.push([width, measured.cardRem, measured.bodyWidth, measured.bodyScrollWidth]);
        if (measured.bodyFits) {
          narrow = measured;
          narrowWidth = width;
        }
      }
      if (narrow !== null) {
        await clickElement(cdp, '.instrument-card .instrument-switch');
        narrowPending = await measureHead();
      }
    } finally {
      await cdp('Emulation.clearDeviceMetricsOverride');
      await evaluateExpr(cdp, `(() => { WebSocket.prototype.send = window.__originalSend; })()`);
    }
    const headOk = (m) =>
      m !== null &&
      m.cardRem <= 18.8 &&
      m.bodyFits &&
      m.cardFits &&
      m.nameLines >= 2 &&
      m.nameText === LONG_ID &&
      m.switchTopDelta <= 1 &&
      m.switchInsideCard &&
      m.switchNoShrink &&
      m.switchFits;
    report(
      'instruments view: a 32-character id wraps beside its switch at 18rem',
      headOk(narrow) && headOk(narrowPending) && narrowPending.word === INSTRUMENTS_COPY.switchTurningOff,
      JSON.stringify({ width: narrowWidth, narrow, narrowPending, tried }),
    );
    await closeInstruments();

    // (8) One card sits alone in layout b, and the list and its card are centered, the list at most 100rem wide, in
    // layout c.
    writeRig([sixteen[0]]);
    await reloadPage(cdp);
    await openInstruments();
    await waitFor(cdp, `document.querySelectorAll('.instrument-card').length === 1 ? true : null`, 5000);
    await setSize(1920, 1080);
    const lone = {};
    for (const layout of ['b', 'c']) {
      await blurFocus();
      await pressKey(cdp, layout);
      lone[layout] = await evaluateExpr(
        cdp,
        `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => {
          const list = document.getElementById('instruments-list');
          const card = list.querySelector('.instrument-card');
          const workspaceBox = document.getElementById('workspace').getBoundingClientRect();
          const listBox = list.getBoundingClientRect();
          const root = parseFloat(getComputedStyle(document.documentElement).fontSize);
          resolve({
            cards: list.querySelectorAll('.instrument-card').length,
            cardLeftOffset: Math.round((card.getBoundingClientRect().left - listBox.left) * 100) / 100,
            listWidthRem: Math.round((listBox.width / root) * 100) / 100,
            leftMargin: Math.round((listBox.left - workspaceBox.left) * 100) / 100,
            rightMargin: Math.round((workspaceBox.right - listBox.right) * 100) / 100,
            cardCenterGap: Math.round(((card.getBoundingClientRect().left - workspaceBox.left) - (workspaceBox.right - card.getBoundingClientRect().right)) * 100) / 100,
          });
        })))`,
      );
    }
    await cdp('Emulation.clearDeviceMetricsOverride');
    report(
      'instruments view: one card sits alone in layout b and the list and its card are centered in layout c',
      lone.b.cards === 1 &&
        Math.abs(lone.b.cardLeftOffset) <= 1 &&
        lone.c.cards === 1 &&
        lone.c.listWidthRem <= 100 &&
        Math.abs(lone.c.leftMargin - lone.c.rightMargin) <= 1 &&
        Math.abs(lone.c.cardCenterGap) <= 1,
      JSON.stringify(lone),
    );
    await closeInstruments();
  } finally {
    fs.rmSync(rigFile, { force: true });
    fs.rmSync(stateFile, { force: true });
    fs.rmSync(modelsDir, { recursive: true, force: true });
    await cdp('Emulation.clearDeviceMetricsOverride');
    await reloadPage(cdp);
    await closeInstruments();
    if ((await workspace('layout')) !== startLayout) await pressKey(cdp, startLayout);
    await panelHidden(1000);
  }
}

/**
 * The Session drawer against the live page. It is
 * part of the bar's quick lane: `context` is { cdp, client, report, port, pageUrl }, the same object barBlocks gets.
 * It leaves the page as it found it: the drawer closed, no view open, the viewport override cleared.
 */
async function drawerBlocks(context) {
  const { cdp, report } = context;
  const workspaceRect = () =>
    evaluateExpr(cdp, `(() => { const r = document.getElementById('workspace').getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map((n) => Math.round(n * 100) / 100); })()`);
  const viewIs = (view) => waitFor(cdp, `document.getElementById('workspace').dataset.view === ${JSON.stringify(view)} ? true : null`, 3000);

  // The drawer is an overlay: it pushes nothing, focus goes in, Esc closes only it and focus returns; with a view open one Esc leaves the view.
  {
    await closeDrawer(cdp);
    const closedRect = await workspaceRect();
    await openDrawer(cdp);
    const opened = await evaluateExpr(
      cdp,
      `(() => {
        const drawer = document.getElementById('session-drawer');
        const button = document.getElementById('session-button');
        const bar = document.getElementById('top-bar').getBoundingClientRect();
        const box = drawer.getBoundingClientRect();
        return {
          position: getComputedStyle(drawer).position,
          gap: Math.round((box.top - bar.bottom) * 100) / 100,
          active: document.activeElement === drawer,
          expanded: button.getAttribute('aria-expanded'),
          controls: button.getAttribute('aria-controls'),
          role: drawer.getAttribute('role'),
          name: drawer.getAttribute('aria-label'),
          width: box.width,
          innerWidth: window.innerWidth,
        };
      })()`,
    );
    const openRect = await workspaceRect();
    await pressKey(cdp, 'Escape');
    const afterEsc = await evaluateExpr(
      cdp,
      `(() => ({ hidden: document.getElementById('session-drawer').hidden, active: document.activeElement.id, expanded: document.getElementById('session-button').getAttribute('aria-expanded') }))()`,
    );

    await clickElement(cdp, '#view-buttons button[data-key="2"]');
    const timelineOpen = await viewIs('timeline');
    const withViewClosedRect = await workspaceRect();
    await openDrawer(cdp);
    const withViewOpenRect = await workspaceRect();
    await pressKey(cdp, 'Escape');
    const afterOneEsc = await evaluateExpr(
      cdp,
      `(() => ({ drawerHidden: document.getElementById('session-drawer').hidden, view: document.getElementById('workspace').dataset.view, active: document.activeElement.id }))()`,
    );
    await pressKey(cdp, 'Escape');
    const viewClosed = await viewIs('none');

    report(
      'drawer: opens as an overlay, pushes nothing, focus goes in, Esc closes and focus returns',
      JSON.stringify(closedRect) === JSON.stringify(openRect) &&
        opened.position === 'absolute' &&
        Math.abs(opened.gap) <= 1 &&
        opened.width >= opened.innerWidth - 1 &&
        opened.active === true &&
        opened.expanded === 'true' &&
        opened.controls === 'session-drawer' &&
        opened.role === 'region' &&
        opened.name === 'Session' &&
        afterEsc.hidden === true &&
        afterEsc.active === 'session-button' &&
        afterEsc.expanded === 'false' &&
        timelineOpen === true &&
        JSON.stringify(withViewClosedRect) === JSON.stringify(withViewOpenRect) &&
        afterOneEsc.drawerHidden === true &&
        afterOneEsc.view === 'timeline' &&
        afterOneEsc.active === 'session-button' &&
        viewClosed === true,
      JSON.stringify({ opened, afterEsc, afterOneEsc, closedRect, openRect, withViewClosedRect, withViewOpenRect, viewClosed }),
    );
  }

  // The moved items are shown (never a size check on a hidden element), whole and inside their card, at three widths.
  {
    const ids = BAR_INVENTORY.filter((entry) => entry.home === 'drawer' && entry.id !== 'session-drawer').map((entry) => entry.id);
    const measure = () =>
      evaluateExpr(
        cdp,
        `((ids) => ids.map((id) => {
          const matches = document.querySelectorAll('#' + id);
          const el = matches[0] ?? null;
          if (el === null) return { id, count: matches.length, shown: false, whole: false };
          const box = el.getBoundingClientRect();
          const card = el.closest('.session-card');
          const cardBox = card === null ? null : card.getBoundingClientRect();
          return {
            id,
            count: matches.length,
            shown: !el.hidden && box.width > 0 && box.height > 0 && el.getClientRects().length > 0,
            whole:
              cardBox !== null &&
              box.left >= cardBox.left - 1 &&
              box.right <= cardBox.right + 1 &&
              (el.clientWidth === 0 || el.scrollWidth <= el.clientWidth) &&
              card.scrollWidth <= card.clientWidth,
            lines: Math.round(box.height / parseFloat(getComputedStyle(el).lineHeight)),
          };
        }))(${JSON.stringify(ids)})`,
      );
    const saved = await setWorstCase(cdp);
    const results = [];
    try {
      await openDrawer(cdp);
      for (const text of [WORST_CASE.midiAttention, WORST_CASE.midiOff]) {
        await evaluateExpr(cdp, `(() => { document.getElementById('midi-state-text').textContent = ${JSON.stringify(text)}; })()`);
        const perWidth = await atWidths(cdp, [1024, 1366, 1920], measure);
        results.push({ text, perWidth });
      }
    } finally {
      // The fixture first: with the longest texts in the bar the Session button can sit past the window edge.
      await restoreWorstCase(cdp, saved);
      await sleep(400);
      await closeDrawer(cdp);
    }
    const problems = [];
    for (const { text, perWidth } of results) {
      for (const [index, width] of [1024, 1366, 1920].entries()) {
        for (const item of perWidth[index]) {
          if (item.count !== 1) problems.push(`${width} ${JSON.stringify(text)}: #${item.id} exists ${item.count} times`);
          else if (!item.shown) problems.push(`${width} ${JSON.stringify(text)}: #${item.id} is not shown`);
          else if (!item.whole) problems.push(`${width} ${JSON.stringify(text)}: #${item.id} is clipped or leaves its card`);
        }
      }
    }
    report(
      'drawer: the Session card shows the moved items whole at 1024, 1366 and 1920',
      problems.length === 0 && results.every(({ perWidth }) => perWidth.every((items) => items.length === ids.length)),
      JSON.stringify({ ids: ids.length, problems, midiLines: results.map(({ text, perWidth }) => [text, perWidth.map((items) => items.find((item) => item.id === 'midi-state')?.lines)]) }),
    );
  }

  // Cards that have nothing to show are not rendered; the Last change card says so before any version.
  {
    const shownExpr = (selector) => `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el !== null && !el.hidden && el.getClientRects().length > 0; })()`;
    await openDrawer(cdp);
    const saved = await evaluateExpr(
      cdp,
      `(() => ({ midi: document.getElementById('midi-state').hidden, requests: document.getElementById('page-requests').hidden, version: document.getElementById('version-indicator').hidden }))()`,
    );
    const set = (id, hidden) => evaluateExpr(cdp, `(() => { document.getElementById(${JSON.stringify(id)}).hidden = ${hidden}; return true; })()`);
    let result;
    try {
      await set('midi-state', true);
      await set('page-requests', true);
      await set('version-indicator', true);
      const without = {
        midiCard: await evaluateExpr(cdp, shownExpr('#session-card-midi')),
        requestsCard: await evaluateExpr(cdp, shownExpr('#session-card-requests')),
        empty: await evaluateExpr(cdp, shownExpr('.session-empty')),
        emptyText: await evaluateExpr(cdp, `document.querySelector('.session-empty').textContent`),
        sessionCard: await evaluateExpr(cdp, shownExpr('#session-card-session')),
        settingsCard: await evaluateExpr(cdp, shownExpr('#session-card-settings')),
      };
      await set('midi-state', false);
      await set('page-requests', false);
      await set('version-indicator', false);
      const versionText = await evaluateExpr(cdp, `document.getElementById('version-indicator').textContent`);
      await evaluateExpr(cdp, `(() => { document.getElementById('version-indicator').textContent = 'v42 · from v38'; return true; })()`);
      const withAll = {
        midiCard: await evaluateExpr(cdp, shownExpr('#session-card-midi')),
        requestsCard: await evaluateExpr(cdp, shownExpr('#session-card-requests')),
        empty: await evaluateExpr(cdp, shownExpr('.session-empty')),
        versionShown: await evaluateExpr(cdp, shownExpr('#version-indicator')),
        versionText: await evaluateExpr(cdp, `document.getElementById('version-indicator').textContent`),
      };
      await evaluateExpr(cdp, `(() => { document.getElementById('version-indicator').textContent = ${JSON.stringify(versionText)}; return true; })()`);
      result = { without, withAll, versionText };
    } finally {
      await set('midi-state', saved.midi);
      await set('page-requests', saved.requests);
      await set('version-indicator', saved.version);
      await closeDrawer(cdp);
    }
    report(
      'drawer: with no MIDI use and no page-requests status those cards are not rendered, and Last change reads "No change yet." before any version',
      result.without.midiCard === false &&
        result.without.requestsCard === false &&
        result.without.sessionCard === true &&
        result.without.settingsCard === true &&
        result.without.empty === true &&
        result.without.emptyText === 'No change yet.' &&
        result.withAll.midiCard === true &&
        result.withAll.requestsCard === true &&
        result.withAll.empty === false &&
        result.withAll.versionShown === true &&
        result.withAll.versionText === 'v42 · from v38' &&
        /^v\d+( · from v\d+)?$/.test(result.versionText),
      JSON.stringify(result),
    );
  }

  // Focus, a press outside, the (i) popovers and the layers of Esc.
  {
    const state = () =>
      evaluateExpr(
        cdp,
        `(() => ({
          drawer: !document.getElementById('session-drawer').hidden,
          help: !document.getElementById('page-requests-help').hidden,
          active: document.activeElement === null ? null : document.activeElement.id,
          view: document.getElementById('workspace').dataset.view,
        }))()`,
      );
    const settle = async () => {
      await sleep(120);
      return state();
    };
    const requestsWasHidden = await evaluateExpr(cdp, `document.getElementById('page-requests').hidden`);
    // Focus leaving the drawer closes it ...
    await openDrawer(cdp);
    await evaluateExpr(cdp, `(() => { document.getElementById('${TRANSPORT_ID}').focus(); return true; })()`);
    const afterFocusLeaves = await settle();
    // ... unless the window itself lost focus.
    await openDrawer(cdp);
    await evaluateExpr(cdp, `(() => { window.__probeHasFocus = document.hasFocus.bind(document); document.hasFocus = () => false; return true; })()`);
    await evaluateExpr(cdp, `(() => { document.getElementById('${TRANSPORT_ID}').focus(); return true; })()`);
    const whileWindowUnfocused = await settle();
    await evaluateExpr(cdp, `(() => { document.hasFocus = window.__probeHasFocus; delete window.__probeHasFocus; return true; })()`);
    await closeDrawer(cdp);
    // A press outside closes it.
    await openDrawer(cdp);
    await clickElement(cdp, '#product-name');
    const afterPressOutside = await settle();
    // Opening the drawer closes an open popover.
    await evaluateExpr(cdp, `(() => { document.getElementById('page-requests').hidden = false; const help = document.getElementById('page-requests-help'); help.hidden = false; document.getElementById('page-requests-info').setAttribute('aria-expanded', 'true'); return true; })()`);
    await openDrawer(cdp);
    const openedWithHelpOpen = await settle();
    // A popover opened from a card sits under the bar, above the drawer; the drawer stays so the (i) it returns to is there.
    await clickElement(cdp, '#page-requests-info');
    const fromCard = await evaluateExpr(
      cdp,
      `(() => {
        const help = document.getElementById('page-requests-help');
        const box = help.getBoundingClientRect();
        const bar = document.getElementById('top-bar').getBoundingClientRect();
        const hit = document.elementFromPoint(box.x + box.width / 2, box.y + Math.min(box.height / 2, 20));
        return {
          open: !help.hidden,
          expanded: document.getElementById('page-requests-info').getAttribute('aria-expanded'),
          clearOfBar: box.top >= bar.bottom - 0.5,
          aboveDrawer: hit !== null && help.contains(hit),
          drawer: !document.getElementById('session-drawer').hidden,
          focusInHelp: help.contains(document.activeElement),
        };
      })()`,
    );
    await sleep(150);
    const stillOpenAfterFocusMove = await state();
    // Esc layers: the popover first, then the drawer, then the view.
    await closeDrawer(cdp);
    await clickElement(cdp, '#view-buttons button[data-key="2"]');
    await viewIs('timeline');
    await openDrawer(cdp);
    await clickElement(cdp, '#page-requests-info');
    await sleep(100);
    const layers = [await state()];
    await pressKey(cdp, 'Escape');
    layers.push(await settle());
    await pressKey(cdp, 'Escape');
    layers.push(await settle());
    await pressKey(cdp, 'Escape');
    await viewIs('none');
    layers.push(await settle());
    await evaluateExpr(cdp, `(() => { document.getElementById('page-requests').hidden = ${JSON.stringify(requestsWasHidden)}; return true; })()`);
    report(
      'drawer: focus leaving closes it unless the window lost focus, a press outside closes it, opening it closes an open popover, Esc layers popover then drawer then view',
      afterFocusLeaves.drawer === false &&
        whileWindowUnfocused.drawer === true &&
        afterPressOutside.drawer === false &&
        openedWithHelpOpen.drawer === true &&
        openedWithHelpOpen.help === false &&
        fromCard.open === true &&
        fromCard.expanded === 'true' &&
        fromCard.clearOfBar === true &&
        fromCard.aboveDrawer === true &&
        fromCard.drawer === true &&
        fromCard.focusInHelp === true &&
        stillOpenAfterFocusMove.drawer === true &&
        stillOpenAfterFocusMove.help === true &&
        layers[0].drawer === true && layers[0].help === true && layers[0].view === 'timeline' &&
        layers[1].drawer === true && layers[1].help === false && layers[1].view === 'timeline' && layers[1].active === 'page-requests-info' &&
        layers[2].drawer === false && layers[2].help === false && layers[2].view === 'timeline' && layers[2].active === 'session-button' &&
        layers[3].view === 'none',
      JSON.stringify({ afterFocusLeaves, whileWindowUnfocused, afterPressOutside, openedWithHelpOpen, fromCard, stillOpenAfterFocusMove, layers }),
    );
  }

  // The count follows the facts: a closed socket, a refused page, a build mismatch, the updated server and a lost tab.
  await sessionFactsBlock(context);
}

const SOCKET_RECORDER_SOURCE = `(() => {
  const Native = window.WebSocket;
  window.__probeSockets = [];
  window.__probeSent = [];
  window.WebSocket = class extends Native {
    constructor(...args) {
      super(...args);
      window.__probeSockets.push(this);
    }
    send(data) {
      window.__probeSent.push(String(data));
      return super.send(data);
    }
  };
})()`;

const STALE_TOKEN_SOURCE = `(() => {
  const stale = () => {
    const meta = document.querySelector('meta[name="moontide-page-token"]');
    if (!meta) return false;
    meta.setAttribute('content', '0'.repeat(64));
    return true;
  };
  if (stale()) return;
  const observer = new MutationObserver(() => { if (stale()) observer.disconnect(); });
  observer.observe(document, { childList: true, subtree: true });
})()`;

/**
 * The Session count and the strip against the facts that drive them: a socket the page closed, a page the
 * server refused, a build mismatch and an updated server (messages handed to the page's own handler through a
 * recorded socket), and a tab that lost the role to a second tab. The page and its Play in this tab buttons are
 * driven with real clicks. It leaves the page reloaded, connected and playing.
 */
async function sessionFactsBlock(context) {
  const { cdp, client, report, port, pageUrl } = context;
  const BAR_CODE = 'setcps(0.5)\nbar_probe: s("bd*4").gain(0)';
  const read = () =>
    evaluateExpr(
      cdp,
      `(() => {
        const button = document.getElementById('session-button');
        const count = document.getElementById('session-count');
        const shown = (el) => !el.hidden && el.getClientRects().length > 0;
        const connection = document.getElementById('connection-state');
        return {
          name: button.getAttribute('aria-label'),
          title: button.getAttribute('title'),
          count: count.hidden ? null : count.textContent,
          buttonWeight: getComputedStyle(button).fontWeight,
          connection: connection.textContent,
          connectionWeight: getComputedStyle(connection).fontWeight,
          connectionAccent: connection.dataset.accent ?? null,
          stripShown: shown(document.getElementById('session-strip')),
          stripText: document.getElementById('strip-text').textContent,
          stripButtonShown: shown(document.getElementById('strip-take-back')),
          buildCount: document.querySelectorAll('#build-mismatch').length,
          buildText: document.getElementById('build-mismatch').textContent,
          buildWeight: getComputedStyle(document.getElementById('build-mismatch')).fontWeight,
          takeoverCount: document.querySelectorAll('#midi-takeover').length,
        };
      })()`,
    );
  const inject = (message) =>
    evaluateExpr(cdp, `(() => { window.__probeSockets[0].dispatchEvent(new MessageEvent('message', { data: ${JSON.stringify(JSON.stringify(message))} })); return true; })()`);
  const waitState = (predicate, timeoutMs = 4000) =>
    (async () => {
      const deadline = Date.now() + timeoutMs;
      let state = await read();
      while (!predicate(state) && Date.now() < deadline) {
        await sleep(100);
        state = await read();
      }
      return state;
    })();
  await cdp('Page.enable');
  const recorder = await cdp('Page.addScriptToEvaluateOnNewDocument', { source: SOCKET_RECORDER_SOURCE });
  let stale = null;
  const secondTab = { id: null, ws: null, cdp: null };
  const closeSecondTab = async () => {
    if (secondTab.ws !== null) {
      try {
        secondTab.ws.close();
      } catch {
        // already closed
      }
      secondTab.ws = null;
    }
    if (secondTab.id !== null) {
      await fetch(`http://127.0.0.1:${port}/json/close/${secondTab.id}`).catch(() => {});
      secondTab.id = null;
    }
  };
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
    await secondTab.cdp('Page.navigate', { url: pageUrl });
    await waitConnected(secondTab.cdp, 15000);
  };
  const takeOvers = () => evaluateExpr(cdp, `window.__probeSent.filter((text) => JSON.parse(text).type === 'take-over').length`);
  try {
    await reloadPage(cdp);
    const calm = await read();

    // A socket that closed: Disconnected counts, in weight 600, in a card that needs the user.
    await evaluateExpr(cdp, `(() => { window.__probeSockets[0].close(); return true; })()`);
    const disconnected = await waitState((state) => state.connection === CONNECTION_LABELS.disconnected);
    await openDrawer(cdp);
    const disconnectedCard = await evaluateExpr(cdp, `document.getElementById('session-card-session').dataset.needs`);
    await closeDrawer(cdp);
    await reloadPage(cdp);

    // A page the server refused: the refused label, in weight 600, counts.
    stale = await cdp('Page.addScriptToEvaluateOnNewDocument', { source: STALE_TOKEN_SOURCE });
    await reloadPage(cdp, { expectedLabel: CONNECTION_LABELS.refused });
    const refused = await waitState((state) => state.connection === CONNECTION_LABELS.refused);
    await cdp('Page.removeScriptToEvaluateOnNewDocument', { identifier: stale.identifier });
    stale = null;
    await reloadPage(cdp);

    report(
      'drawer: the count follows the refused label and a closed socket, in weight 600, and calm counts nothing',
      calm.count === null && calm.name === 'Session' && calm.title === null && calm.connection === CONNECTION_LABELS.connected && calm.connectionAccent === null &&
        disconnected.count === '1' && disconnected.name === 'Session, 1 need you' && disconnected.title === 'Needs you: Disconnected' &&
        disconnected.connectionWeight === '600' && disconnected.buttonWeight === '600' && disconnectedCard === 'true' &&
        refused.count === '1' && refused.name === 'Session, 1 need you' && refused.title === 'Needs you: Refused' &&
        refused.connection === CONNECTION_LABELS.refused && refused.connectionWeight === '600',
      JSON.stringify({ calm, disconnected, refused, disconnectedCard }),
    );

    // A build mismatch: counted once, the strip repeats it only while the drawer is closed, the real id stays unique.
    await inject({ type: 'build-mismatch' });
    const mismatch = await waitState((state) => state.stripShown);
    await openDrawer(cdp);
    const mismatchOpen = await read();
    await closeDrawer(cdp);
    const mismatchClosed = await read();
    // The softer updated line never counts together with a mismatch.
    await inject({ type: 'server-updated' });
    const mismatchAndUpdated = await waitState(() => true);
    await reloadPage(cdp);
    await inject({ type: 'server-updated' });
    const updated = await waitState((state) => state.stripShown);
    await openDrawer(cdp);
    const updatedOpen = await read();
    await closeDrawer(cdp);
    await reloadPage(cdp);
    const stripLine = `${BUILD_MISMATCH_COPY.line}. MIDI code is refused until then.`;
    report(
      'drawer: the strip shows only while the drawer is closed (build line, updated line), with its own text, and they count once',
      mismatch.count === '1' && mismatch.title === 'Needs you: Different builds' && mismatch.stripShown === true && mismatch.stripText === stripLine &&
        mismatch.stripButtonShown === false && mismatch.buildCount === 1 && mismatch.buildText === BUILD_MISMATCH_COPY.line && mismatch.buildWeight === '600' &&
        mismatchOpen.stripShown === false && mismatchOpen.buildCount === 1 &&
        mismatchClosed.stripShown === true &&
        mismatchAndUpdated.count === '1' && mismatchAndUpdated.title === 'Needs you: Different builds' && mismatchAndUpdated.buildText === BUILD_MISMATCH_COPY.line &&
        updated.count === '1' && updated.title === 'Needs you: Server updated' && updated.stripShown === true && updated.stripText === `${SERVER_UPDATED_COPY.line}.` &&
        updated.buildText === SERVER_UPDATED_COPY.line && updated.buildWeight === '400' && updatedOpen.stripShown === false,
      JSON.stringify({ mismatch, mismatchOpen, mismatchClosed, mismatchAndUpdated, updated, updatedOpen }),
    );

    // A tab that lost the role: counted, the strip carries its own Play in this tab button, and that button does what #take-back does.
    await openSecondTab();
    await cdp('Page.bringToFront');
    const lost = await waitState((state) => state.stripShown && state.stripButtonShown);
    await openDrawer(cdp);
    const lostOpen = await read();
    const lostCard = await evaluateExpr(cdp, `(() => { const el = document.getElementById('midi-takeover'); return { shown: !el.hidden && el.getClientRects().length > 0, text: document.getElementById('midi-takeover-text').textContent, weight: getComputedStyle(el).fontWeight, needs: document.getElementById('session-card-session').dataset.needs }; })()`);
    await closeDrawer(cdp);
    await secondTab.cdp('Page.navigate', { url: 'about:blank' });
    const nobody = await waitState((state) => state.stripText === `${MIDI_COPY.noActiveText}.`, 6000);
    await clickElement(cdp, '#strip-take-back');
    const backByStrip = await waitState((state) => state.stripShown === false && state.count === null, 8000);
    const sentByStrip = await takeOvers();
    await closeSecondTab();
    await openSecondTab();
    await cdp('Page.bringToFront');
    await waitState((state) => state.stripButtonShown);
    const pendingBoth = await evaluateExpr(
      cdp,
      `(() => {
        document.getElementById('take-back').click();
        const card = document.getElementById('take-back');
        const strip = document.getElementById('strip-take-back');
        return { card: [card.textContent, card.disabled], strip: [strip.textContent, strip.disabled] };
      })()`,
    );
    const backByCard = await waitState((state) => state.stripShown === false && state.count === null, 8000);
    const sentByCard = await takeOvers();
    report(
      'drawer: the count follows the lost tab, the strip has its own button, and it does exactly what #take-back does',
      lost.count === '1' && lost.title === 'Needs you: Other tab' && lost.stripText === `${MIDI_COPY.takeoverText}.` && lost.stripButtonShown === true && lost.takeoverCount === 1 &&
        lostOpen.stripShown === false && lostCard.shown === true && lostCard.text === MIDI_COPY.takeoverText && lostCard.weight === '600' && lostCard.needs === 'true' &&
        nobody.stripText === `${MIDI_COPY.noActiveText}.` && nobody.stripButtonShown === true &&
        backByStrip.stripShown === false && backByStrip.count === null && sentByStrip === 1 &&
        pendingBoth.card[0] === MIDI_COPY.takingOver && pendingBoth.card[1] === true && pendingBoth.strip[0] === MIDI_COPY.takingOver && pendingBoth.strip[1] === true &&
        backByCard.stripShown === false && backByCard.count === null && sentByCard === 2,
      JSON.stringify({ lost, lostOpen: { stripShown: lostOpen.stripShown }, lostCard, nobody: { text: nobody.stripText, button: nobody.stripButtonShown }, backByStrip: { stripShown: backByStrip.stripShown, count: backByStrip.count }, sentByStrip, pendingBoth, backByCard: { stripShown: backByCard.stripShown, count: backByCard.count }, sentByCard }),
    );
  } finally {
    await closeSecondTab();
    if (stale !== null) await cdp('Page.removeScriptToEvaluateOnNewDocument', { identifier: stale.identifier });
    await cdp('Page.removeScriptToEvaluateOnNewDocument', { identifier: recorder.identifier });
  }
  await reloadPage(cdp);
  await callTool(client, 'set_code', { code: BAR_CODE, label: 'probe drawer facts reset' });
  const playing = await waitFor(cdp, `(() => (${STATE_WORD_EXPR}) === ${JSON.stringify(SOUND_LABELS.playing)} ? true : null)()`, 8000);
  if (playing !== true) throw new Error(`sessionFactsBlock: the state word is ${JSON.stringify(await readStateWord(cdp))} after the reset, not "Playing"`);
}

/** Presses Ctrl and a key in the editor (a Strudel shortcut such as Ctrl+.). Like pressKey, the event carries no
 * nativeVirtualKeyCode (see pressKey). The editor is focused first, because the shortcut lives in its key map. */
async function pressCtrl(cdp, key, code, windowsVirtualKeyCode) {
  await evaluateExpr(cdp, `(() => { const el = document.querySelector('#editor-area .cm-content'); if (el) el.focus(); return true; })()`);
  const base = { key, code, windowsVirtualKeyCode, modifiers: 2 };
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', ...base });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

/** Waits until the transport button's word is `label`; returns the transport read, or throws with it. */
async function waitTransportLabel(cdp, label, what) {
  const reached = await waitFor(cdp, `document.getElementById(${JSON.stringify(TRANSPORT_ID)}).querySelector('.transport-word').textContent === ${JSON.stringify(label)} ? true : null`, 5000);
  if (reached !== true) throw new Error(`${what}: the transport button did not say ${JSON.stringify(label)} within 5 s: ${JSON.stringify(await readTransport(cdp))}`);
  return readTransport(cdp);
}

/** A set_code that fails to evaluate: returns { isError, text } and never throws on the failure itself. */
async function callSetCodeExpectingFailure(client, code, label) {
  const result = await client.callTool({ name: 'set_code', arguments: { code, label } });
  const text = (result.content ?? []).filter((entry) => entry.type === 'text').map((entry) => entry.text).join('\n');
  return { isError: result.isError === true, text };
}

/**
 * The Play/Stop button and the state word against the live page.
 * `context` is { cdp, client, report }. The page is left playing the quiet bar pattern.
 */
export async function transportBlocks(context) {
  const { cdp, client, report } = context;
  const BAR_CODE = 'setcps(0.5)\nbar_probe: s("bd*4").gain(0)';
  const BAD_CODE = 'setcps(0.5)\nbar_probe: s("bd*4"';
  const resetPlaying = async (label) => {
    await callTool(client, 'set_code', { code: BAR_CODE, label });
    const back = await waitFor(cdp, `(() => (${STATE_WORD_EXPR}) === ${JSON.stringify(SOUND_LABELS.playing)} ? true : null)()`, 8000);
    if (back !== true) throw new Error(`transportBlocks: the state word is ${JSON.stringify(await readStateWord(cdp))} after the reset, not "Playing"`);
  };

  // Tracer: Stop, then one Play click; the word and the button agree; the server's stopped flag is cleared.
  {
    const live = await readTransport(cdp);
    await stopMusic(cdp);
    const stopped = await waitTransportLabel(cdp, BAR_COPY.play, 'transport: Stop then Play');
    await playMusic(cdp);
    const playing = await waitTransportLabel(cdp, BAR_COPY.stop, 'transport: Stop then Play');
    // The hand evaluation reaches the server a few milliseconds after the word flips; a failing change sent now must
    // be answered with the still-playing tail, which proves the stopped flag was cleared by the Play.
    await sleep(600);
    const failing = await callSetCodeExpectingFailure(client, BAD_CODE, 'probe transport failing change');
    await resetPlaying('probe transport reset');
    await stopMusic(cdp);
    const again = await waitTransportLabel(cdp, BAR_COPY.play, 'transport: Stop then Play');
    await playMusic(cdp);
    await waitTransportLabel(cdp, BAR_COPY.stop, 'transport: Stop then Play');
    report(
      'transport: Stop then Play flips the word and the button, and the server hears the Play',
      live.word === SOUND_LABELS.playing && live.label === BAR_COPY.stop && live.action === 'stop' && live.accent === 'true' &&
        live.title === BAR_COPY.stopTitle && live.ariaDisabled === null && live.disabledProperty === false &&
        stopped.word === SOUND_LABELS.stopped && stopped.label === BAR_COPY.play && stopped.action === 'play' && stopped.accent === 'false' &&
        stopped.title === BAR_COPY.playTitle && stopped.here === '' &&
        playing.word === SOUND_LABELS.playing && playing.label === BAR_COPY.stop && playing.accent === 'true' &&
        failing.isError === true && failing.text.includes(STILL_PLAYING_TAIL) && !failing.text.includes(STILL_STOPPED_TAIL) &&
        again.word === SOUND_LABELS.stopped && again.label === BAR_COPY.play,
      JSON.stringify({ live, stopped, playing, failing: { isError: failing.isError, text: failing.text.slice(-120) }, again: [again.word, again.label] }),
    );
  }

  // Ctrl+. (a Strudel shortcut) flips the same word through the same function; the 250 ms poll writes no status line.
  {
    await evaluateExpr(cdp, `(() => { document.getElementById('change-status').textContent = 'probe sentinel'; return true; })()`);
    await pressCtrl(cdp, '.', 'Period', 190);
    const stopped = await waitTransportLabel(cdp, BAR_COPY.play, 'transport: Ctrl+.');
    // More than two poll ticks later nothing wrote the status line: neither the shortcut nor the poll.
    await sleep(900);
    const later = await readTransport(cdp);
    await playMusic(cdp);
    const playing = await waitTransportLabel(cdp, BAR_COPY.stop, 'transport: Ctrl+.');
    report(
      'transport: Ctrl+. flips the word and a poll tick writes no status line',
      stopped.word === SOUND_LABELS.stopped && stopped.accent === 'false' && later.word === SOUND_LABELS.stopped &&
        later.status === 'probe sentinel' && playing.word === SOUND_LABELS.playing,
      JSON.stringify({ stopped: [stopped.word, stopped.label], laterStatus: later.status, playing: [playing.word, playing.label] }),
    );
    await evaluateExpr(cdp, `(() => { document.getElementById('change-status').textContent = ''; return true; })()`);
  }

  const setEditor = (text) => evaluateExpr(cdp, `(() => { document.getElementById('repl').editor.setCode(${JSON.stringify(text)}); return true; })()`);
  const errorLine = () => evaluateExpr(cdp, `(() => { const el = document.getElementById('eval-error'); return el.hidden ? null : el.textContent; })()`);

  // A failing Play: the music is stopped and the editor holds a syntax error; one click, and the word stays Stopped.
  {
    await stopMusic(cdp);
    await waitTransportLabel(cdp, BAR_COPY.play, 'transport: a failing Play');
    await setEditor(BAD_CODE);
    await clickElement(cdp, TRANSPORT_SELECTOR);
    await sleep(1500);
    const after = await readTransport(cdp);
    const error = await errorLine();
    // The next poll rewrites the button from the model: still a Play, enabled, no half state.
    await sleep(600);
    const settled = await readTransport(cdp);
    await setEditor(BAR_CODE);
    await resetPlaying('probe transport failing play reset');
    const errorAfterReset = await errorLine();
    report(
      'transport: a failing Play leaves the word Stopped',
      after.word === SOUND_LABELS.stopped && after.accent === 'false' && after.label === BAR_COPY.play && after.status !== BAR_COPY.saidPlaying &&
        error !== null && error.startsWith('Error') &&
        settled.word === SOUND_LABELS.stopped && settled.label === BAR_COPY.play && settled.action === 'play' && settled.ariaDisabled === null && settled.title === BAR_COPY.playTitle &&
        errorAfterReset === null,
      JSON.stringify({ after: [after.word, after.label, after.status], error: error === null ? null : error.slice(0, 80), settled: [settled.word, settled.label, settled.ariaDisabled], errorAfterReset }),
    );
  }

  // An empty editor: Play is aria-disabled (never the disabled attribute) with the reason; a press says it and starts nothing.
  {
    await stopMusic(cdp);
    const historyBefore = await callTool(client, 'list_history', {});
    await setEditor('');
    const disabled = await waitFor(cdp, `document.getElementById(${JSON.stringify(TRANSPORT_ID)}).getAttribute('aria-disabled') === 'true' ? true : null`, 3000);
    const before = await readTransport(cdp);
    await evaluateExpr(cdp, `(() => { document.getElementById('change-status').textContent = ''; return true; })()`);
    await clickElement(cdp, TRANSPORT_SELECTOR);
    await sleep(800);
    const pressed = await readTransport(cdp);
    const started = await evaluateExpr(cdp, `(() => { const state = document.getElementById('repl').editor.repl.state; return { started: state.started === true, pending: state.pending === true }; })()`);
    const historyAfter = await callTool(client, 'list_history', {});
    await setEditor(BAR_CODE);
    const enabledAgain = await waitFor(cdp, `document.getElementById(${JSON.stringify(TRANSPORT_ID)}).getAttribute('aria-disabled') === null ? true : null`, 3000);
    await resetPlaying('probe transport empty editor reset');
    report(
      'transport: an empty editor disables Play with a reason',
      disabled === true && before.ariaDisabled === 'true' && before.disabledProperty === false && before.title === BAR_COPY.playDisabledEmpty &&
        before.word === SOUND_LABELS.stopped && before.label === BAR_COPY.play &&
        pressed.status === BAR_COPY.playDisabledEmpty && pressed.word === SOUND_LABELS.stopped &&
        started.started === false && started.pending === false && historyAfter === historyBefore &&
        enabledAgain === true,
      JSON.stringify({ before: [before.ariaDisabled, before.disabledProperty, before.title], status: pressed.status, started, historyUnchanged: historyAfter === historyBefore, enabledAgain }),
    );
  }

  // A tab that lost the role: the word says ' here', Play is aria-disabled with the reason, a press says so and adds
  // the way out, and Play in this tab brings the role (and the music) back.
  {
    const secondTab = { id: null, ws: null, cdp: null };
    let lost = null;
    let pressedLost = null;
    let back = null;
    let hereAfter = null;
    let noEval = null;
    try {
      const created = await fetch(`http://127.0.0.1:${context.port}/json/new?about:blank`, { method: 'PUT' });
      if (!created.ok) throw new Error(`/json/new answered ${created.status}`);
      const info = await created.json();
      secondTab.id = info.id;
      secondTab.ws = new WebSocket(info.webSocketDebuggerUrl);
      await waitSocketOpen(secondTab.ws);
      secondTab.cdp = makeCdp(secondTab.ws);
      await secondTab.cdp('Runtime.enable');
      await secondTab.cdp('Page.enable');
      await secondTab.cdp('Page.navigate', { url: context.pageUrl });
      await waitConnected(secondTab.cdp, 15000);
      const superseded = await waitFor(cdp, `document.querySelector('#sound-state .state-here').textContent === ${JSON.stringify(BAR_COPY.stateHere)} ? true : null`, 8000);
      if (superseded !== true) throw new Error(`transport: the first tab never lost the role: ${JSON.stringify(await readTransport(cdp))}`);
      lost = await readTransport(cdp);
      // A synthetic click (the first tab is hidden behind the second): nothing starts, the reason is said.
      await evaluateExpr(cdp, `(() => { document.getElementById('change-status').textContent = ''; document.getElementById(${JSON.stringify(TRANSPORT_ID)}).click(); return true; })()`);
      await sleep(600);
      pressedLost = await readTransport(cdp);
      noEval = await evaluateExpr(cdp, `(() => { const state = document.getElementById('repl').editor.repl.state; return { started: state.started === true, pending: state.pending === true }; })()`);
      // Play in this tab takes the role back; the first tab plays again and the word and the button agree.
      await evaluateExpr(cdp, `document.getElementById('take-back').click()`);
      const hidden = await waitFor(cdp, `(() => document.getElementById('midi-takeover').hidden ? true : null)()`, 8000);
      if (hidden !== true) throw new Error('transport: Play in this tab did not bring the role back');
      back = await waitTransportLabel(cdp, BAR_COPY.stop, 'transport: a tab that lost the role');
      hereAfter = back.here;
    } finally {
      if (secondTab.ws !== null) {
        try {
          secondTab.ws.close();
        } catch {
          // already closed
        }
      }
      if (secondTab.id !== null) {
        await fetch(`http://127.0.0.1:${context.port}/json/close/${secondTab.id}`).catch(() => {});
      }
    }
    await resetPlaying('probe transport lost tab reset');
    report(
      'transport: a tab that lost the role is silent here',
      lost !== null && lost.word === SOUND_LABELS.stopped && lost.here === BAR_COPY.stateHere && lost.accent === 'false' &&
        lost.ariaDisabled === 'true' && lost.disabledProperty === false && lost.title === BAR_COPY.playDisabledTab && lost.label === BAR_COPY.play &&
        pressedLost.status === `${BAR_COPY.playDisabledTab} ${BAR_COPY.playUseTakeBack}` && pressedLost.word === SOUND_LABELS.stopped &&
        noEval.started === false && noEval.pending === false &&
        back !== null && back.word === SOUND_LABELS.playing && back.accent === 'true' && hereAfter === '' && back.ariaDisabled === null,
      JSON.stringify({ lost: lost && [lost.word, lost.here, lost.ariaDisabled, lost.title], status: pressedLost && pressedLost.status, noEval, back: back && [back.word, back.label, back.here] }),
    );
  }
}

/** What the failed-change banner shows now: its hidden flag, kind, lead, consequence, the error line (null while
 * it is hidden), the hover text of the line, the alert region's text and the id of the focused element. */
const BANNER_READ_EXPR = `(() => {
  const banner = document.getElementById('problem-banner');
  const line = document.getElementById('eval-error');
  const text = (selector) => { const el = banner.querySelector(selector); return el ? el.textContent : null; };
  const active = document.activeElement;
  return {
    hidden: banner.hidden,
    kind: banner.dataset.kind ?? null,
    lead: text('.problem-lead'),
    consequence: text('.problem-consequence'),
    line: line.hidden ? null : line.textContent,
    lineHidden: line.hidden,
    title: line.getAttribute('title'),
    alert: document.getElementById('problem-alert').textContent,
    active: active === null ? null : (active.id || active.tagName),
  };
})()`;

export async function readBanner(cdp) {
  return evaluateExpr(cdp, BANNER_READ_EXPR);
}

/** Waits until the banner is shown (or, with `shown` false, hidden); returns the read, or throws with it. */
export async function waitBanner(cdp, what, { shown = true } = {}) {
  const reached = await waitFor(cdp, `document.getElementById('problem-banner').hidden === ${!shown} ? true : null`, 5000);
  if (reached !== true) throw new Error(`${what}: the banner did not become ${shown ? 'visible' : 'hidden'} within 5 s: ${JSON.stringify(await readBanner(cdp))}`);
  return readBanner(cdp);
}

/**
 * The failed-change banner against the live page. `context`
 * is { cdp, client, report }. The page is left playing the quiet bar pattern with the editor restored.
 */
export async function bannerBlocks(context) {
  const { cdp, client, report } = context;
  const BAR_CODE = 'setcps(0.5)\nbar_probe: s("bd*4").gain(0)';
  const BAD_CODE = 'setcps(0.5)\nbar_probe: s("bd*4"';
  const setEditor = (text) => evaluateExpr(cdp, `(() => { document.getElementById('repl').editor.setCode(${JSON.stringify(text)}); return true; })()`);
  const resetPlaying = async (label) => {
    await callTool(client, 'set_code', { code: BAR_CODE, label });
    const back = await waitFor(cdp, `(() => (${STATE_WORD_EXPR}) === ${JSON.stringify(SOUND_LABELS.playing)} ? true : null)()`, 8000);
    if (back !== true) throw new Error(`bannerBlocks: the state word is ${JSON.stringify(await readStateWord(cdp))} after the reset, not "Playing"`);
    await waitBanner(cdp, 'bannerBlocks reset', { shown: false });
  };
  const tempoNow = () => evaluateExpr(cdp, `document.getElementById('tempo-readout').textContent`);

  // Tracer: a failed Play with the music stopped says the sound is still stopped.
  {
    await stopMusic(cdp);
    await waitTransportLabel(cdp, BAR_COPY.play, 'banner: a failed Play');
    await setEditor(BAD_CODE);
    await clickElement(cdp, TRANSPORT_SELECTOR);
    const banner = await waitBanner(cdp, 'banner: a failed Play');
    const transportAfter = await readTransport(cdp);
    await setEditor(BAR_CODE);
    await resetPlaying('probe banner failed play reset');
    report(
      'banner: a failed Play with the music stopped says the sound is still stopped',
      banner.kind === 'change' && banner.lead === BAR_COPY.leadChange && banner.consequence === BAR_COPY.consequenceStopped &&
        banner.line !== null && banner.line.startsWith('Error: ') && banner.lineHidden === false &&
        transportAfter.word === SOUND_LABELS.stopped && transportAfter.label === BAR_COPY.play,
      JSON.stringify({ banner, transport: [transportAfter.word, transportAfter.label] }),
    );
  }

  // A failed hand evaluation while the music plays says the previous music keeps playing.
  {
    await setEditor(BAD_CODE);
    await pressCtrl(cdp, 'Enter', 'Enter', 13);
    const banner = await waitBanner(cdp, 'banner: a failed hand evaluation while playing');
    const transportAfter = await readTransport(cdp);
    await setEditor(BAR_CODE);
    await resetPlaying('probe banner failed hand eval reset');
    report(
      'banner: a failed hand evaluation while playing says the previous music keeps playing',
      banner.kind === 'change' && banner.lead === BAR_COPY.leadChange && banner.consequence === BAR_COPY.consequencePlaying &&
        banner.line !== null && banner.line.startsWith('Error: ') && transportAfter.word === SOUND_LABELS.playing,
      JSON.stringify({ banner, transport: [transportAfter.word, transportAfter.label] }),
    );
  }

  // Dismiss hides the banner and the line and touches nothing else: the word, the tempo and the music stay.
  {
    await setEditor(BAD_CODE);
    await pressCtrl(cdp, 'Enter', 'Enter', 13);
    await waitBanner(cdp, 'banner: Dismiss');
    // The failed hand evaluation is reported to the server a few milliseconds after the banner shows; let it settle.
    await sleep(800);
    // Only the version lines: the reply ends with the current time, which differs between two calls.
    const versions = async () => (await callTool(client, 'list_history', {})).split('\n').filter((line) => line.startsWith('#')).join('\n');
    const before = { transport: await readTransport(cdp), tempo: await tempoNow(), history: await versions() };
    await clickElement(cdp, '#problem-dismiss');
    const banner = await waitBanner(cdp, 'banner: Dismiss', { shown: false });
    await sleep(700);
    const after = { transport: await readTransport(cdp), tempo: await tempoNow(), history: await versions() };
    const state = await evaluateExpr(cdp, `(() => { const repl = document.getElementById('repl').editor.repl.state; return { started: repl.started === true, pending: repl.pending === true, code: document.getElementById('repl').editor.code }; })()`);
    report(
      'banner: Dismiss hides it and touches nothing else',
      banner.hidden === true && banner.lineHidden === true && banner.line === null &&
        after.transport.word === before.transport.word && after.transport.label === before.transport.label &&
        after.transport.accent === before.transport.accent && after.tempo === before.tempo &&
        after.history === before.history && state.started === true && state.pending === false && state.code === BAD_CODE,
      JSON.stringify({ banner, before: [before.transport.word, before.tempo], after: [after.transport.word, after.tempo], historyUnchanged: after.history === before.history, state: { started: state.started, pending: state.pending } }),
    );
  }

  // The next failure shows it again, after a Dismiss.
  {
    await pressCtrl(cdp, 'Enter', 'Enter', 13);
    const banner = await waitBanner(cdp, 'banner: a second failure');
    await setEditor(BAR_CODE);
    await resetPlaying('probe banner second failure reset');
    report(
      'banner: a second failure shows it again',
      banner.hidden === false && banner.kind === 'change' && banner.consequence === BAR_COPY.consequencePlaying && banner.line !== null,
      JSON.stringify(banner),
    );
  }

  // --- Details, Copy, the cap and the announcement ---
  // Errors come from real code the page evaluates: a thrown Error carries the shape under test as its message.
  // (Double quotes would be mini-notation in Strudel, so the message is a single-quoted JavaScript string.)
  const jsString = (text) => `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;
  const throwing = (message) => `(() => { throw new Error(${jsString(message)}); })()`;
  const fail = async (message, what) => {
    await setEditor(throwing(message));
    await pressCtrl(cdp, 'Enter', 'Enter', 13);
    return waitBanner(cdp, what);
  };
  const dismiss = async () => {
    await clickElement(cdp, '#problem-dismiss');
    await waitBanner(cdp, 'banner: dismiss', { shown: false });
  };
  const click = async (selector) => clickElement(cdp, selector);
  const readDetails = () =>
    evaluateExpr(
      cdp,
      `(() => {
        const box = document.getElementById('problem-details');
        const toggle = document.getElementById('problem-details-toggle');
        const line = document.getElementById('eval-error');
        const style = getComputedStyle(box);
        const rootPx = parseFloat(getComputedStyle(document.documentElement).fontSize);
        return {
          open: !box.hidden,
          expanded: toggle.getAttribute('aria-expanded'),
          controls: toggle.getAttribute('aria-controls'),
          word: toggle.textContent,
          name: toggle.getAttribute('aria-label'),
          text: box.textContent,
          maxHeightRem: parseFloat(style.maxHeight) / rootPx,
          overflowY: style.overflowY,
          userSelect: style.userSelect,
          whiteSpace: style.whiteSpace,
          boxHeight: box.getBoundingClientRect().height,
          lineCut: line.scrollWidth > line.clientWidth,
          lineEllipsis: getComputedStyle(line).textOverflow === 'ellipsis' && getComputedStyle(line).whiteSpace === 'nowrap',
          lineOneLine: line.getBoundingClientRect().height < parseFloat(getComputedStyle(line).lineHeight) * 1.5,
        };
      })()`,
    );

  // A 6-line error whose first line is 200 characters: the message stays one line (cut with an ellipsis), Details shows
  // all six lines in a box with its own max-height.
  {
    const lines = ['A'.repeat(200), 'second', 'third', 'fourth', 'fifth', 'sixth'];
    const message = lines.join('\n');
    const banner = await fail(message, 'banner: a 6-line error');
    const closed = await readDetails();
    await click('#problem-details-toggle');
    const open = await readDetails();
    await click('#problem-details-toggle');
    const closedAgain = await readDetails();
    await dismiss();
    report(
      'banner: Details shows a 6-line error whose first line is 200 characters, the message stays one line with an ellipsis',
      banner.line === `Error: ${lines[0]}` && closed.open === false && closed.expanded === 'false' && closed.word === BAR_COPY.detailsShow &&
        closed.lineCut === true && closed.lineEllipsis === true && closed.lineOneLine === true &&
        open.open === true && open.expanded === 'true' && open.controls === 'problem-details' && open.word === BAR_COPY.detailsHide &&
        open.name === BAR_COPY.detailsHideName && open.text === message && open.text.split('\n').length === 6 &&
        Math.abs(open.maxHeightRem - 12) < 0.01 && open.overflowY === 'auto' && open.userSelect === 'text' && open.whiteSpace === 'pre-wrap' &&
        closedAgain.open === false && closedAgain.word === BAR_COPY.detailsShow,
      JSON.stringify({ line: banner.line && banner.line.length, closed, open: { ...open, text: open.text.length }, closedAgain: closedAgain.open }),
    );
  }

  // A 5000-character error: drawn cut at 4000 with an ellipsis, Copy writes all 5000. Markup in a message is only text.
  {
    const message = 'z'.repeat(5000);
    await fail(message, 'banner: a 5000-character error');
    await click('#problem-details-toggle');
    const open = await readDetails();
    const spy = await spyClipboard(cdp);
    let texts;
    let titleLength;
    try {
      await click('#problem-copy');
      await sleep(300);
      texts = await spy.texts();
      titleLength = await evaluateExpr(cdp, `document.getElementById('eval-error').getAttribute('title').length`);
    } finally {
      await spy.restore();
    }
    await dismiss();
    const markup = '<img src=x onerror=alert(1)><b>bold</b>';
    await fail(markup, 'banner: markup in an error message');
    await click('#problem-details-toggle');
    const asText = await evaluateExpr(
      cdp,
      `(() => ({
        elements: document.getElementById('problem-banner').querySelectorAll('img, b').length,
        line: document.getElementById('eval-error').textContent,
        details: document.getElementById('problem-details').textContent,
      }))()`,
    );
    await dismiss();
    report(
      'banner: a 5000-character error is drawn cut at 4000 and Copy writes all 5000',
      open.text.length === 4000 && open.text.endsWith('…') && open.text === `${'z'.repeat(3999)}…` &&
        texts.length === 1 && texts[0] === message && titleLength <= 4000 && open.boxHeight <= 12 * 22 + 2,
      JSON.stringify({ drawn: open.text.length, copied: texts.map((text) => text.length), titleLength, boxHeight: open.boxHeight }),
    );
    report(
      'banner: markup in an error message is shown as text',
      asText.elements === 0 && asText.line === `Error: ${markup}` && asText.details === markup,
      JSON.stringify(asText),
    );
  }

  // A rejected Copy says so out loud: the failure line (weight 600), Details open, the text selectable, one console error.
  {
    const message = 'copy-me\nsecond line';
    await fail(message, 'banner: a rejected Copy');
    await evaluateExpr(cdp, `(() => { window.__bannerErrors = []; window.__bannerRealError = console.error; console.error = (...args) => { window.__bannerErrors.push(args.map(String).join(' ')); }; return true; })()`);
    const rejecting = await spyClipboard(cdp, { reject: true });
    let result;
    try {
      await click('#problem-copy');
      await waitFor(cdp, `document.getElementById('problem-copy-failure').hidden ? null : true`, 3000);
      result = await evaluateExpr(
        cdp,
        `(() => {
          const failure = document.getElementById('problem-copy-failure');
          const box = document.getElementById('problem-details');
          const range = document.createRange();
          range.selectNodeContents(box);
          const selection = window.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
          const selected = selection.toString();
          selection.removeAllRanges();
          return {
            text: failure.textContent,
            weight: getComputedStyle(failure).fontWeight,
            detailsOpen: !box.hidden,
            userSelect: getComputedStyle(box).userSelect,
            selected,
            copyWord: document.getElementById('problem-copy').textContent,
            errors: window.__bannerErrors.filter((line) => line.startsWith('Moontide: could not copy the error:')).length,
          };
        })()`,
      );
    } finally {
      await rejecting.restore();
      await evaluateExpr(cdp, `(() => { console.error = window.__bannerRealError; delete window.__bannerErrors; delete window.__bannerRealError; return true; })()`);
    }
    await dismiss();
    const afterDismiss = await evaluateExpr(cdp, `({ failureHidden: document.getElementById('problem-copy-failure').hidden, detailsHidden: document.getElementById('problem-details').hidden })`);
    report(
      'banner: a rejected Copy says so, opens Details and leaves the text selectable',
      result.text === BAR_COPY.copyFailed && result.weight === '600' && result.detailsOpen === true && result.userSelect === 'text' &&
        result.selected === message && result.copyWord === BAR_COPY.copy && result.errors === 1 &&
        afterDismiss.failureHidden === true && afterDismiss.detailsHidden === true,
      JSON.stringify({ result, afterDismiss }),
    );
  }

  // A successful Copy: the word Copied for 2 s, and the alert region says Error copied.
  {
    await fail('copy ok', 'banner: Copied');
    const spy = await spyClipboard(cdp);
    let atClick;
    let atOneSecond;
    let atEnd;
    let texts;
    try {
      await click('#problem-copy');
      await sleep(150);
      atClick = await evaluateExpr(cdp, `({ word: document.getElementById('problem-copy').textContent, alert: document.getElementById('problem-alert').textContent, failureHidden: document.getElementById('problem-copy-failure').hidden })`);
      await sleep(850);
      atOneSecond = await evaluateExpr(cdp, `document.getElementById('problem-copy').textContent`);
      await sleep(1700);
      atEnd = await evaluateExpr(cdp, `document.getElementById('problem-copy').textContent`);
      texts = await spy.texts();
    } finally {
      await spy.restore();
    }
    await dismiss();
    report(
      'banner: Copied shows for 2 seconds and the alert region says so',
      atClick.word === BAR_COPY.copied && atClick.alert === BAR_COPY.copiedAnnouncement && atClick.failureHidden === true &&
        atOneSecond === BAR_COPY.copied && atEnd === BAR_COPY.copy && texts.length === 1 && texts[0] === 'copy ok',
      JSON.stringify({ atClick, atOneSecond, atEnd, texts }),
    );
  }

  // The alert region gets its text once per change banner (an identical second failure again), and focus never moves.
  {
    await evaluateExpr(
      cdp,
      `(() => {
        window.__bannerAlerts = [];
        const region = document.getElementById('problem-alert');
        window.__bannerObserver = new MutationObserver((records) => {
          for (const record of records) for (const node of record.addedNodes) if (node.textContent !== '') window.__bannerAlerts.push(node.textContent);
        });
        window.__bannerObserver.observe(region, { childList: true, characterData: true, subtree: true });
        return true;
      })()`,
    );
    const message = 'same failure twice';
    await setEditor(throwing(message));
    await evaluateExpr(cdp, `(() => { const el = document.querySelector('#editor-area .cm-content'); if (el) el.focus(); return true; })()`);
    const focusBefore = (await readBanner(cdp)).active;
    await pressCtrl(cdp, 'Enter', 'Enter', 13);
    const first = await waitBanner(cdp, 'banner: the alert region, first');
    await sleep(300);
    await pressCtrl(cdp, 'Enter', 'Enter', 13);
    await sleep(800);
    const second = await readBanner(cdp);
    const alerts = await evaluateExpr(cdp, `(() => { window.__bannerObserver.disconnect(); const seen = window.__bannerAlerts; delete window.__bannerAlerts; delete window.__bannerObserver; return seen; })()`);
    await dismiss();
    const cleared = (await readBanner(cdp)).alert;
    // A notice announces nothing: a refusal from a tab that lost the role is not driven here; the pure model pins ''.
    report(
      'banner: the alert region is set once per change banner and focus does not move',
      first.alert === `${BAR_COPY.leadChange} ${BAR_COPY.consequencePlaying}` && second.alert === first.alert &&
        alerts.length === 2 && alerts.every((text) => text === first.alert) &&
        focusBefore === first.active && first.active === second.active && cleared === '',
      JSON.stringify({ alerts, focusBefore, firstActive: first.active, secondActive: second.active, cleared }),
    );
  }

  // The row at 1024 px (and, to force the wrap, at 640 px): every button is whole and inside the banner, nothing is
  // clipped except the one allowed message ellipsis.
  {
    const message = ['B'.repeat(200), 'two', 'three'].join('\n');
    await fail(message, 'banner: the row at 1024');
    await click('#problem-details-toggle');
    const measure = () =>
      evaluateExpr(
        cdp,
        `(() => {
          const banner = document.getElementById('problem-banner');
          const box = banner.getBoundingClientRect();
          const rootPx = parseFloat(getComputedStyle(document.documentElement).fontSize);
          const buttons = [...banner.querySelectorAll('button')].filter((el) => !el.hidden).map((el) => {
            const r = el.getBoundingClientRect();
            return { id: el.id, whole: el.scrollWidth <= el.clientWidth, inside: r.left >= box.left - 0.5 && r.right <= box.right + 0.5, big: r.width >= 1.75 * rootPx - 0.5 && r.height >= 1.75 * rootPx - 0.5 };
          });
          const clipped = [banner, ...banner.querySelectorAll('*')].filter((el) => el.id !== 'eval-error' && el.id !== 'problem-details' && !el.hidden && el.scrollWidth > el.clientWidth + 0.5).map((el) => el.id || el.className || el.tagName);
          const lead = banner.querySelector('.problem-lead').getBoundingClientRect();
          const actions = banner.querySelector('.problem-actions').getBoundingClientRect();
          return { width: window.innerWidth, buttons, clipped, noOverflow: banner.scrollWidth <= banner.clientWidth, actionsOnOwnLine: actions.top >= lead.bottom - 1 };
        })()`,
      );
    const [at1024, at640] = await atWidths(cdp, [1024, 640], measure);
    await dismiss();
    const good = (m) => m.buttons.length === 4 && m.buttons.every((b) => b.whole && b.inside && b.big) && m.clipped.length === 0 && m.noOverflow;
    report(
      'banner: at 1024 px the row wraps and every button is whole',
      good(at1024) && good(at640) && at640.actionsOnOwnLine === true,
      JSON.stringify({ at1024, at640 }),
    );
  }

  // --- Every writer picks its kind ---
  const askButtonShown = `(() => { const ask = document.getElementById('problem-ask'); return ask !== null && !ask.hidden; })()`;
  const readKind = () =>
    evaluateExpr(
      cdp,
      `(() => {
        const detailsToggle = document.getElementById('problem-details-toggle');
        const buttons = [...document.getElementById('problem-banner').querySelectorAll('button')].filter((el) => !el.hidden).map((el) => el.id);
        return { buttons, detailsShown: !detailsToggle.hidden, ask: ${askButtonShown} };
      })()`,
    );

  // Claude's set_code failing is a failed change (the old music keeps playing).
  {
    const failing = await callSetCodeExpectingFailure(client, BAD_CODE, 'probe banner set_code failure');
    const banner = await waitBanner(cdp, "banner: Claude's failing set_code");
    const kind = await readKind();
    const editorAfter = await evaluateExpr(cdp, `document.getElementById('repl').editor.code`);
    await dismiss();
    report(
      "banner: Claude's failing set_code is a failed change",
      failing.isError === true && banner.kind === 'change' && banner.lead === BAR_COPY.leadChange && banner.consequence === BAR_COPY.consequencePlaying &&
        banner.line !== null && kind.detailsShown === true && kind.ask === true && editorAfter === BAR_CODE,
      JSON.stringify({ banner, kind, editorReverted: editorAfter === BAR_CODE }),
    );
  }

  // An Ask problem (a right-click whose context cannot be read) is a notice: its own lead, no sentence, no Ask button.
  {
    const result = await evaluateExpr(
      cdp,
      `(() => {
        const el = document.createElement('div');
        el.id = 'probe-bad-part';
        el.className = 'part-card';
        el.setAttribute('data-part', '');
        el.style.position = 'fixed';
        el.style.left = '200px';
        el.style.top = '200px';
        el.style.width = '40px';
        el.style.height = '20px';
        document.body.appendChild(el);
        el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 220, clientY: 210, button: 2 }));
        return true;
      })()`,
    );
    const banner = await waitBanner(cdp, 'banner: an Ask problem');
    const kind = await readKind();
    const alertWhileNotice = banner.alert;
    await evaluateExpr(cdp, "(() => { const el = document.getElementById('probe-bad-part'); if (el) el.remove(); return true; })()");
    await pressKey(cdp, 'Escape');
    await dismiss();
    report(
      'banner: an Ask problem is a notice',
      result === true && banner.kind === 'notice' && banner.lead === BAR_COPY.leadNotice && banner.consequence === '' &&
        alertWhileNotice === '' && kind.ask === false && kind.buttons.includes('problem-copy') && kind.buttons.includes('problem-dismiss') &&
        kind.detailsShown === true,
      JSON.stringify({ banner, kind }),
    );
  }

  // A refusal is a notice too: a tab that lost the role refuses to evaluate, and that is no failed change, so the banner
  // must not claim the previous music keeps playing. One line of text gives no Details button.
  {
    const secondTab = { id: null, ws: null };
    let banner = null;
    let kind = null;
    try {
      const created = await fetch(`http://127.0.0.1:${context.port}/json/new?about:blank`, { method: 'PUT' });
      if (!created.ok) throw new Error(`/json/new answered ${created.status}`);
      const info = await created.json();
      secondTab.id = info.id;
      secondTab.ws = new WebSocket(info.webSocketDebuggerUrl);
      await waitSocketOpen(secondTab.ws);
      const cdp2 = makeCdp(secondTab.ws);
      await cdp2('Runtime.enable');
      await cdp2('Page.enable');
      await cdp2('Page.navigate', { url: context.pageUrl });
      await waitConnected(cdp2, 15000);
      const superseded = await waitFor(cdp, `document.querySelector('#sound-state .state-here').textContent === ${JSON.stringify(BAR_COPY.stateHere)} ? true : null`, 8000);
      if (superseded !== true) throw new Error(`banner: the first tab never lost the role: ${JSON.stringify(await readTransport(cdp))}`);
      await evaluateExpr(cdp, `(() => { Promise.resolve(document.getElementById('repl').editor.evaluate()).catch(() => {}); return true; })()`);
      banner = await waitBanner(cdp, 'banner: a refusal in a tab that lost the role');
      kind = await readKind();
      await evaluateExpr(cdp, `document.getElementById('take-back').click()`);
      const back = await waitFor(cdp, `(() => document.getElementById('midi-takeover').hidden ? true : null)()`, 8000);
      if (back !== true) throw new Error('banner: Play in this tab did not bring the role back');
    } finally {
      if (secondTab.ws !== null) {
        try {
          secondTab.ws.close();
        } catch {
          // already closed
        }
      }
      if (secondTab.id !== null) {
        await fetch(`http://127.0.0.1:${context.port}/json/close/${secondTab.id}`).catch(() => {});
      }
    }
    await resetPlaying('probe banner lost tab reset');
    report(
      'banner: a refused change in a tab that lost the role is a notice without the consequence sentence or Ask',
      banner !== null && banner.kind === 'notice' && banner.lead === BAR_COPY.leadNotice && banner.consequence === '' && banner.alert === '' &&
        banner.line !== null && banner.line.startsWith('Error: ') && kind.ask === false && kind.detailsShown === false &&
        kind.buttons.includes('problem-copy') && kind.buttons.includes('problem-dismiss'),
      JSON.stringify({ banner, kind }),
    );
  }

  // A failed part launch is a failed change: the launch writes `.late(n)` after the arrangement; with that call made to
  // throw (restored at once) the evaluation fails, the editor goes back to the playing code and the banner says so.
  {
    const PARTS_PROGRAM = [
      'const one = note("c4").s("sine").gain(0)',
      'const two = note("e4").s("square").gain(0)',
      'const three = note("g4").s("triangle").gain(0)',
      'main: arrange([2, one], [2, two], [2, three])',
    ].join('\n');
    await callTool(client, 'set_code', { code: PARTS_PROGRAM, label: 'probe banner parts' });
    await evaluateExpr(cdp, `(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); return true; })()`);
    await pressKey(cdp, '4');
    const cards = await waitFor(cdp, `document.querySelectorAll('#parts-rows .part-card').length === 3 ? true : null`, 5000);
    if (cards !== true) throw new Error('banner: the Parts view did not show three parts');
    const patched = await evaluateExpr(
      cdp,
      `(() => {
        const Pattern = document.getElementById('repl').editor.repl.scheduler.pattern.constructor;
        window.__bannerRealLate = Pattern.prototype.late;
        Pattern.prototype.late = function () { throw new Error('probe: late is made to fail'); };
        window.__bannerPattern = Pattern;
        return true;
      })()`,
    );
    let banner = null;
    let codeAfter = null;
    try {
      await evaluateExpr(cdp, `(() => { [...document.querySelectorAll('#parts-rows .part-card')].find((c) => c.querySelector('.part-name').textContent === 'three').click(); return true; })()`);
      banner = await waitBanner(cdp, 'banner: a failed part launch');
      codeAfter = await evaluateExpr(cdp, `document.getElementById('repl').editor.code`);
    } finally {
      await evaluateExpr(cdp, `(() => { window.__bannerPattern.prototype.late = window.__bannerRealLate; delete window.__bannerPattern; delete window.__bannerRealLate; return true; })()`);
    }
    await dismiss();
    await pressKey(cdp, 'Escape');
    await callTool(client, 'set_code', { code: BAR_CODE, label: 'probe banner parts reset' });
    await resetPlaying('probe banner parts end');
    report(
      'banner: a failed part launch is a failed change',
      patched === true && banner !== null && banner.kind === 'change' && banner.lead === BAR_COPY.leadChange &&
        banner.consequence === BAR_COPY.consequencePlaying && banner.line !== null && banner.line.includes('late is made to fail') &&
        codeAfter === PARTS_PROGRAM,
      JSON.stringify({ banner, editorReverted: codeAfter === PARTS_PROGRAM }),
    );
  }

  // --- Ask Claude with the error attached ---
  const REQUEST_PREFIX = 'Request from the Moontide page: ';
  const readAskBox = () =>
    evaluateExpr(
      cdp,
      `(() => {
        const box = document.getElementById('ask-box');
        const field = document.getElementById('ask-field');
        const r = box.getBoundingClientRect();
        const active = document.activeElement;
        return {
          open: !box.hidden,
          chip: document.getElementById('ask-context-chip').textContent,
          value: field.value,
          start: field.selectionStart,
          end: field.selectionEnd,
          active: active === null ? null : (active.id || active.tagName),
          left: r.left, right: r.right, top: r.top, bottom: r.bottom,
        };
      })()`,
    );
  const clearAsk = async () => {
    await evaluateExpr(cdp, `(() => { const f = document.getElementById('ask-field'); f.value = ''; f.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    if ((await readAskBox()).open) await pressKey(cdp, 'Escape');
  };
  const stopListeners = async () => {
    for (const child of spawnedListeners) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise((resolve) => child.once('exit', resolve));
        child.kill();
        await exited;
      }
    }
    await sleep(300);
  };
  const buttonCenter = (selector) =>
    evaluateExpr(cdp, `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  const firstLineOf = (text) => text.split('\n').map((line) => line.trim()).find((line) => line !== '');
  const cutTo200 = (text) => (text.length <= 200 ? text : `${text.slice(0, 199)}\u2026`);

  // The button opens the box at the button with the chip and the prefill, the caret after the prefill.
  {
    const message = 'ask probe: the first line of the error\nsecond line of the error';
    const banner = await fail(message, 'ask error: the button');
    const full = await evaluateExpr(cdp, `document.getElementById('eval-error').getAttribute('title')`);
    const point = await buttonCenter('#problem-ask');
    const askShown = await evaluateExpr(cdp, `!document.getElementById('problem-ask').hidden`);
    await clickElement(cdp, '#problem-ask');
    const box = await readAskBox();
    const expectedChip = `${ASK_COPY.errorChipLead} \u00B7 ${firstLineOf(full)}`;
    const expectedValue = errorAskPrefill(full);
    // Anchored at the button: the box touches the button's center, give or take the pointer offset and the window edge.
    const gapX = Math.max(box.left - point.x, 0, point.x - box.right);
    const gapY = Math.max(box.top - point.y, 0, point.y - box.bottom);
    const anchored = Math.hypot(gapX, gapY) < 40;
    // An existing draft is never lost: the prefill follows it after a blank line.
    await clearAsk();
    await evaluateExpr(cdp, `(() => { const f = document.getElementById('ask-field'); f.value = 'my draft'; return true; })()`);
    await clickElement(cdp, '#problem-ask');
    const withDraft = await readAskBox();
    await clearAsk();
    await dismiss();
    await resetPlaying('probe ask error button reset');
    report(
      'ask error: the button opens the box with the chip and the prefill',
      askShown === true && banner.kind === 'change' && box.open === true && box.chip === expectedChip &&
        box.value === expectedValue && box.value.startsWith(ASK_COPY.errorPrefillLead) && box.value.includes(firstLineOf(full)) &&
        box.value.endsWith('\n\n') && box.start === box.value.length && box.end === box.value.length && box.active === 'ask-field' && anchored &&
        withDraft.value === `my draft\n\n${expectedValue}` && withDraft.start === withDraft.value.length,
      JSON.stringify({ chip: box.chip, expectedChip, valueHead: box.value.slice(0, 60), start: box.start, length: box.value.length, point, box: [box.left, box.right, box.top, box.bottom], anchored, draftHead: withDraft.value.slice(0, 30) }),
    );
  }

  // Enter sends one request of kind error that a real listener receives.
  {
    await stopListeners();
    const listener = spawnListener(await callTool(client, 'get_code', {}));
    await sleep(500);
    const message = 'ask probe: sent line\nsecond line';
    await fail(message, 'ask error: Enter sends');
    const full = await evaluateExpr(cdp, `document.getElementById('eval-error').getAttribute('title')`);
    await clickElement(cdp, '#problem-ask');
    const box = await readAskBox();
    await cdp('Input.insertText', { text: 'what is wrong with this?' });
    await pressKey(cdp, 'Enter');
    const deadline = Date.now() + 4000;
    while (listener !== null && listener.lines.length === 0 && Date.now() < deadline) await sleep(100);
    const printed = listener === null ? undefined : listener.lines[0];
    let parsed = null;
    if (printed !== undefined && printed.startsWith(REQUEST_PREFIX)) {
      try {
        parsed = JSON.parse(printed.slice(REQUEST_PREFIX.length));
      } catch {
        parsed = null;
      }
    }
    const boxAfter = await readAskBox();
    await stopListeners();
    await dismiss();
    await resetPlaying('probe ask error send reset');
    report(
      'ask error: Enter sends one request of kind error that the listener receives',
      listener !== null && parsed !== null && listener.lines.length === 1 && parsed.context.kind === 'error' &&
        parsed.context.text === cutTo200(firstLineOf(full)) && parsed.chip === box.chip && parsed.chip.startsWith(`${ASK_COPY.errorChipLead} \u00B7 `) &&
        parsed.text === `${errorAskPrefill(full)}what is wrong with this?` && boxAfter.open === false,
      JSON.stringify({ listener: listener !== null, lines: listener === null ? null : listener.lines.length, context: parsed && parsed.context, chip: parsed && parsed.chip, boxChip: box.chip, text: parsed && parsed.text.slice(-40), boxOpenAfter: boxAfter.open }),
    );
  }

  // A 5000-character error still fits the request line: the prefill is cut at 1500 and the context text at 200.
  {
    await stopListeners();
    const listener = spawnListener(await callTool(client, 'get_code', {}));
    await sleep(500);
    await fail('E'.repeat(5000), 'ask error: a 5000-character error');
    await clickElement(cdp, '#problem-ask');
    const box = await readAskBox();
    await cdp('Input.insertText', { text: 'why?' });
    const counter = await evaluateExpr(cdp, `(() => { const el = document.getElementById('ask-message'); return el === null || el.hidden ? '' : el.textContent; })()`);
    await pressKey(cdp, 'Enter');
    const deadline = Date.now() + 4000;
    while (listener !== null && listener.lines.length === 0 && Date.now() < deadline) await sleep(100);
    const printed = listener === null ? undefined : listener.lines[0];
    let parsed = null;
    if (printed !== undefined && printed.startsWith(REQUEST_PREFIX)) {
      try {
        parsed = JSON.parse(printed.slice(REQUEST_PREFIX.length));
      } catch {
        parsed = null;
      }
    }
    await stopListeners();
    await dismiss();
    await resetPlaying('probe ask error long reset');
    report(
      'ask error: a 5000-character error still fits the request line',
      listener !== null && parsed !== null && printed !== undefined && Buffer.byteLength(printed) <= 8192 + REQUEST_PREFIX.length &&
        parsed.context.kind === 'error' && parsed.context.text.length <= 200 && parsed.chip.length <= 200 &&
        box.value.length < 2000 && box.value.length > 1500 && box.value.includes('\u2026') && parsed.text.endsWith('why?') && counter === '',
      JSON.stringify({ bytes: printed === undefined ? null : Buffer.byteLength(printed), contextLength: parsed && parsed.context.text.length, chipLength: parsed && parsed.chip.length, fieldLength: box.value.length, counter }),
    );
  }

  // --- The right-click popover of the banner ---
  const readMenu = () =>
    evaluateExpr(
      cdp,
      `(() => {
        const menu = document.getElementById('problem-menu');
        const active = document.activeElement;
        const rect = menu.getBoundingClientRect();
        const shown = [...menu.querySelectorAll('button')].filter((button) => !button.hidden && button.getClientRects().length > 0);
        return {
          hidden: menu.hidden,
          role: menu.getAttribute('role'),
          label: menu.getAttribute('aria-label'),
          ids: shown.map((button) => button.id),
          texts: shown.map((button) => button.textContent),
          sized: shown.every((button) => button.getBoundingClientRect().width >= 24 && button.getBoundingClientRect().height >= 24),
          inside: rect.left >= 0 && rect.top >= 0 && rect.right <= window.innerWidth && rect.bottom <= window.innerHeight,
          active: active === null ? null : (active.id || active.tagName),
          bannerHidden: document.getElementById('problem-banner').hidden,
        };
      })()`,
    );
  const viewNow = () => evaluateExpr(cdp, `document.getElementById('workspace').dataset.view`);
  const openPartsView = async () => {
    await evaluateExpr(cdp, `(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); return true; })()`);
    await pressKey(cdp, '4');
    const reached = await waitFor(cdp, `document.getElementById('workspace').dataset.view === 'parts' ? true : null`, 3000);
    if (reached !== true) throw new Error('banner menu: the Parts view did not open');
  };
  const closeViewIfOpen = async () => {
    if ((await viewNow()) !== 'none') {
      await evaluateExpr(cdp, `(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); return true; })()`);
      await pressKey(cdp, 'Escape');
      await waitFor(cdp, `document.getElementById('workspace').dataset.view === 'none' ? true : null`, 3000);
    }
  };
  const BANNER_TARGET = '#problem-banner .problem-lead';

  // Three plain buttons, in order, Tab walks them, a press outside closes the popover.
  {
    await fail('menu probe: first line\nsecond line', 'banner menu: a right-click');
    const asked = await askAt(cdp, BANNER_TARGET);
    const opened = await readMenu();
    await pressKey(cdp, 'Tab');
    const second = await readMenu();
    await pressKey(cdp, 'Tab');
    const third = await readMenu();
    // A press outside: the corner of the banner's padding, far from the popover (which opens at the pointer).
    const corner = await evaluateExpr(cdp, `(() => { const r = document.getElementById('problem-banner').getBoundingClientRect(); return { x: r.right - 3, y: r.top + 3 }; })()`);
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: corner.x, y: corner.y, button: 'left', clickCount: 1 });
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: corner.x, y: corner.y, button: 'left', clickCount: 1 });
    const afterOutside = await readMenu();
    await dismiss();
    report(
      'banner menu: a right-click opens three plain buttons and Tab walks them',
      asked.prevented === true && asked.open === false && opened.hidden === false && opened.role === 'group' && opened.label === BAR_COPY.menuName &&
        JSON.stringify(opened.ids) === JSON.stringify(['problem-menu-copy', 'problem-menu-ask', 'problem-menu-dismiss']) &&
        JSON.stringify(opened.texts) === JSON.stringify([BAR_COPY.menuCopy, BAR_COPY.menuAsk, BAR_COPY.menuDismiss]) &&
        opened.sized === true && opened.inside === true && opened.active === 'problem-menu-copy' && second.active === 'problem-menu-ask' &&
        third.active === 'problem-menu-dismiss' && afterOutside.hidden === true && afterOutside.bannerHidden === false,
      JSON.stringify({ asked, opened, second: second.active, third: third.active, afterOutside: [afterOutside.hidden, afterOutside.bannerHidden] }),
    );
  }

  // A notice has no Ask item (an Ask problem is the notice the page can make on demand).
  {
    await evaluateExpr(
      cdp,
      `(() => {
        const el = document.createElement('div');
        el.id = 'probe-bad-part';
        el.className = 'part-card';
        el.setAttribute('data-part', '');
        el.style.position = 'fixed';
        el.style.left = '200px';
        el.style.top = '200px';
        el.style.width = '40px';
        el.style.height = '20px';
        document.body.appendChild(el);
        el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 220, clientY: 210, button: 2 }));
        return true;
      })()`,
    );
    const banner = await waitBanner(cdp, 'banner menu: a notice');
    await evaluateExpr(cdp, "(() => { const el = document.getElementById('probe-bad-part'); if (el) el.remove(); return true; })()");
    await pressKey(cdp, 'Escape');
    await askAt(cdp, BANNER_TARGET);
    const opened = await readMenu();
    await pressKey(cdp, 'Escape');
    await dismiss();
    report(
      'banner menu: kind notice has no Ask item',
      banner.kind === 'notice' && opened.hidden === false && JSON.stringify(opened.ids) === JSON.stringify(['problem-menu-copy', 'problem-menu-dismiss']) &&
        JSON.stringify(opened.texts) === JSON.stringify([BAR_COPY.menuCopy, BAR_COPY.menuDismiss]),
      JSON.stringify({ kind: banner.kind, ids: opened.ids, texts: opened.texts }),
    );
  }

  // Shift + right-click keeps the browser's own menu: the popover stays hidden and the event is not prevented.
  {
    await fail('menu probe: shift', 'banner menu: Shift + right-click');
    const asked = await askAt(cdp, BANNER_TARGET, { shiftKey: true });
    const menu = await readMenu();
    await dismiss();
    report(
      "banner menu: Shift + right-click keeps the browser menu",
      asked.prevented === false && asked.open === false && menu.hidden === true,
      JSON.stringify({ asked, menuHidden: menu.hidden }),
    );
  }

  // Esc closes only the popover: the banner and the open view stay, focus returns to the banner; the next Esc is the view's.
  {
    await fail('menu probe: escape', 'banner menu: Esc');
    await openPartsView();
    await askAt(cdp, BANNER_TARGET);
    const opened = await readMenu();
    await pressKey(cdp, 'Escape');
    const after = await readMenu();
    const viewAfter = await viewNow();
    await pressKey(cdp, 'Escape');
    const viewNext = await waitFor(cdp, `document.getElementById('workspace').dataset.view === 'none' ? 'none' : null`, 3000);
    await dismiss();
    report(
      'banner menu: Esc closes only the menu and focus returns to the banner',
      opened.hidden === false && after.hidden === true && after.bannerHidden === false && after.active === 'problem-banner' &&
        viewAfter === 'parts' && viewNext === 'none',
      JSON.stringify({ opened: opened.hidden, after: [after.hidden, after.bannerHidden, after.active], viewAfter, viewNext }),
    );
  }

  // With the Ask box open from the popover, one Esc closes the Ask box first and leaves the banner and the view alone.
  {
    await fail('menu probe: ask from the menu', 'banner menu: Ask from the popover');
    await openPartsView();
    await askAt(cdp, BANNER_TARGET);
    await clickElement(cdp, '#problem-menu-ask');
    const box = await readAskBox();
    const menu = await readMenu();
    await pressKey(cdp, 'Escape');
    const boxAfter = await readAskBox();
    const after = await readMenu();
    const viewAfter = await viewNow();
    await clearAsk();
    await closeViewIfOpen();
    await dismiss();
    report(
      'banner menu: with the Ask box open from the menu one Esc closes the Ask box first',
      box.open === true && box.chip.startsWith(`${ASK_COPY.errorChipLead} \u00B7 `) && box.value.startsWith(ASK_COPY.errorPrefillLead) && menu.hidden === true &&
        boxAfter.open === false && after.bannerHidden === false && viewAfter === 'parts' && boxAfter.active === 'problem-banner',
      JSON.stringify({ chip: box.chip, boxOpen: box.open, menuHidden: menu.hidden, boxAfter: [boxAfter.open, boxAfter.active], bannerHidden: after.bannerHidden, viewAfter }),
    );
  }

  // The items run the banner's actions: Copy writes the uncut text, Dismiss hides the banner.
  {
    await fail('menu probe: items\nsecond line', 'banner menu: items');
    const full = await evaluateExpr(cdp, `document.getElementById('eval-error').getAttribute('title')`);
    const spy = await spyClipboard(cdp);
    let texts;
    let afterCopy;
    try {
      await askAt(cdp, BANNER_TARGET);
      await clickElement(cdp, '#problem-menu-copy');
      await sleep(300);
      texts = await spy.texts();
      afterCopy = await readMenu();
    } finally {
      await spy.restore();
    }
    await askAt(cdp, BANNER_TARGET);
    await clickElement(cdp, '#problem-menu-dismiss');
    const afterDismiss = await readMenu();
    report(
      'banner menu: Copy writes the error and Dismiss hides the banner',
      JSON.stringify(texts) === JSON.stringify([full]) && afterCopy.hidden === true && afterCopy.bannerHidden === false &&
        afterDismiss.hidden === true && afterDismiss.bannerHidden === true,
      JSON.stringify({ texts, full, afterCopy: [afterCopy.hidden, afterCopy.bannerHidden], afterDismiss: [afterDismiss.hidden, afterDismiss.bannerHidden] }),
    );
  }

  // A right-click anywhere else still opens the Ask box as before.
  {
    await fail('menu probe: elsewhere', 'banner menu: elsewhere');
    const [elsewhere] = await atWidths(cdp, [1920], () => askAt(cdp, '#product-name'));
    const menu = await readMenu();
    await clearAsk();
    await dismiss();
    report(
      'banner menu: a right-click elsewhere still opens the Ask box',
      elsewhere.prevented === true && elsewhere.open === true && elsewhere.chip === ASK_COPY.wholeSession && menu.hidden === true,
      JSON.stringify({ elsewhere, menuHidden: menu.hidden }),
    );
  }

  await setEditor(BAR_CODE);
  await resetPlaying('probe banner end reset');
}

/**
 * The tempo readout against the live page. `context` is { cdp, client, report }.
 * The readout is always displayed: a dash while nothing plays, the number while it does, and '120 → 180 BPM' while a
 * timed change with a new tempo waits. The page is left playing the quiet bar pattern.
 */
export async function tempoBlocks(context) {
  const { cdp, client, report } = context;
  const BAR_CODE = 'setcps(0.5)\nbar_probe: s("bd*4").gain(0)';
  const idle = tempoText({ playing: false });
  const readTempo = () =>
    evaluateExpr(
      cdp,
      `(() => {
        const t = document.getElementById('tempo-readout');
        const num = t.querySelector('.tempo-num');
        const unit = t.querySelector('.tempo-unit');
        const resolve = (name) => {
          const el = document.createElement('span');
          el.style.color = 'var(' + name + ')';
          document.body.appendChild(el);
          const color = getComputedStyle(el).color;
          el.remove();
          return color;
        };
        const style = getComputedStyle(num);
        return {
          text: t.innerText.trim(),
          displayed: !t.hidden && t.getClientRects().length > 0,
          hiddenAttribute: t.hasAttribute('hidden'),
          idle: t.dataset.idle ?? null,
          num: num.textContent,
          arrow: t.querySelector('.tempo-arrow').textContent,
          label: t.getAttribute('aria-label'),
          title: t.title,
          numColor: style.color,
          muted: resolve('--text-muted'),
          text_: resolve('--text'),
          tabular: style.fontVariantNumeric.includes('tabular-nums'),
          numWidth: num.getBoundingClientRect().width,
          unitLeft: unit.getBoundingClientRect().left,
        };
      })()`,
    );
  const waitTempo = async (predicate, what, timeoutMs = 8000) => {
    const deadline = Date.now() + timeoutMs;
    let state = await readTempo();
    while (!predicate(state) && Date.now() < deadline) {
      await sleep(100);
      state = await readTempo();
    }
    if (!predicate(state)) throw new Error(`${what}: the tempo readout is ${JSON.stringify(state)}`);
    return state;
  };
  const cycleOfReply = (reply) => {
    const match = /takes over at cycle (\d+)/.exec(reply);
    return match === null ? null : Number(match[1]);
  };

  {
    const at120 = await waitTempo((state) => state.text === '120 BPM', 'tempo: the readout follows the music (playing)');
    await stopMusic(cdp);
    const stopped = await waitTempo((state) => state.text === idle.text, 'tempo: the readout follows the music (stopped)');
    await playMusic(cdp);
    const back = await waitTempo((state) => state.text === '120 BPM', 'tempo: the readout follows the music (played again)');
    // A timed change with a new tempo: the coming tempo shows after an arrow, then lands.
    const reply = await callTool(client, 'set_code', {
      code: 'setcps(0.75)\nbar_probe: s("bd*4").gain(0)',
      label: 'probe tempo waiting',
      at: 'phrase',
      phraseCycles: 4,
    });
    const waiting = await waitTempo((state) => state.text === '120 → 180 BPM', 'tempo: the readout follows the music (waiting)', 6000);
    const landed = await waitTempo((state) => state.text === '180 BPM', 'tempo: the readout follows the music (landed)', 16000);
    // 96 BPM has two digits: the unit stays where it was for three.
    await callTool(client, 'set_code', { code: 'setcpm(24)\nbar_probe: s("bd*4").gain(0)', label: 'probe tempo two digits' });
    const twoDigits = await waitTempo((state) => state.text === '96 BPM', 'tempo: the readout follows the music (two digits)');
    // Stop while a change waits: the arrow and the number go together.
    await callTool(client, 'set_code', { code: 'setcps(0.5)\nbar_probe: s("bd*4").gain(0)', label: 'probe tempo before stop' });
    await waitTempo((state) => state.text === '120 BPM', 'tempo: the readout follows the music (before the last stop)');
    await callTool(client, 'set_code', { code: 'setcps(0.75)\nbar_probe: s("bd*4").gain(0)', label: 'probe tempo waiting for stop', at: 'phrase', phraseCycles: 8 });
    const waitingAgain = await waitTempo((state) => state.arrow !== '', 'tempo: the readout follows the music (waiting before the last stop)', 6000);
    await stopMusic(cdp);
    const finalStop = await waitTempo((state) => state.text === idle.text, 'tempo: the readout follows the music (after the last stop)');
    await callTool(client, 'set_code', { code: BAR_CODE, label: 'probe tempo reset' });
    const playingAgain = await waitFor(cdp, `(() => (${STATE_WORD_EXPR}) === ${JSON.stringify(SOUND_LABELS.playing)} ? true : null)()`, 8000);
    report(
      'tempo: the readout follows the music',
      at120.displayed && at120.idle === 'false' && at120.label === tempoText({ playing: true, bpm: 120 }).name && at120.title === BAR_COPY.tempoTitle &&
        at120.tabular === true && at120.numColor === at120.text_ && at120.hiddenAttribute === false &&
        stopped.displayed && stopped.hiddenAttribute === false && stopped.idle === 'true' && stopped.num === idle.num && stopped.numColor === stopped.muted &&
        stopped.label === idle.name && stopped.title === idle.title &&
        back.text === '120 BPM' &&
        cycleOfReply(reply) !== null &&
        waiting.arrow.trim() === '→ 180' && waiting.label === tempoText({ playing: true, bpm: 120, waitingBpm: 180 }).name &&
        landed.arrow === '' && landed.label === tempoText({ playing: true, bpm: 180 }).name &&
        Math.abs(twoDigits.numWidth - landed.numWidth) < 0.5 && Math.abs(twoDigits.unitLeft - landed.unitLeft) < 0.5 &&
        waitingAgain.arrow !== '' && finalStop.arrow === '' && finalStop.displayed &&
        playingAgain === true,
      JSON.stringify({ at120: at120.text, stopped: [stopped.text, stopped.idle, stopped.numColor === stopped.muted], back: back.text, waiting: [waiting.text, waiting.label], landed: [landed.text, landed.arrow], widths: [landed.numWidth, twoDigits.numWidth], unitLeft: [landed.unitLeft, twoDigits.unitLeft], finalStop: [finalStop.text, finalStop.arrow] }),
    );
  }

  // The longest text (118.5 → 1000.5 BPM) stays whole and on one line inside the bar at 1920.
  {
    const [measured] = await atWidths(cdp, [1920], async () => {
      const saved = await setWorstCase(cdp);
      try {
        return await evaluateExpr(
          cdp,
          `(() => {
            const t = document.getElementById('tempo-readout');
            const bar = document.getElementById('top-bar');
            const line = parseFloat(getComputedStyle(t).lineHeight);
            return {
              text: t.textContent,
              whole: t.scrollWidth <= t.clientWidth,
              oneLine: t.offsetHeight < line * 1.5,
              inside: t.getBoundingClientRect().right <= bar.getBoundingClientRect().right,
              displayed: !t.hidden && t.getClientRects().length > 0,
              fit: bar.dataset.fit ?? null,
            };
          })()`,
        );
      } finally {
        await restoreWorstCase(cdp, saved);
      }
    });
    report(
      'tempo: the longest text whole at 1920',
      measured.text === WORST_CASE.tempo && measured.whole && measured.oneLine && measured.inside && measured.displayed,
      JSON.stringify(measured),
    );
    await sleep(400);
  }
}

/**
 * The Views and Layout buttons against the live page (invariants
 * I5 for the nine buttons and I6, Tab order equals visual order). `context` is { cdp, client, report, port, pageUrl }, the
 * same object barBlocks gets. It leaves the page as it found it: no view open, layout a, no focus, the viewport override
 * cleared.
 */
async function controlsBlocks(context) {
  const { cdp, report } = context;
  const blur = () => evaluateExpr(cdp, `(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); return true; })()`);
  const workspace = (field) => evaluateExpr(cdp, `document.getElementById('workspace').dataset.${field}`);
  const viewIs = (view) => waitFor(cdp, `document.getElementById('workspace').dataset.view === ${JSON.stringify(view)} ? true : null`, 3000);
  const layoutIs = (layout) => waitFor(cdp, `document.getElementById('workspace').dataset.layout === ${JSON.stringify(layout)} ? true : null`, 3000);
  const reset = async () => {
    await closeDrawer(cdp);
    await blur();
    if ((await workspace('view')) !== 'none') await pressKey(cdp, 'Escape');
    await blur();
    await pressKey(cdp, 'a');
    await blur();
  };
  const parts = [...viewButtonParts(), ...layoutButtonParts()];

  await reset();

  // The nine buttons: at least 24 x 24 CSS px at three widths, the right names, and the pressed state follows the view and the layout.
  {
    await pressKey(cdp, '4');
    await viewIs('parts');
    await pressKey(cdp, 'b');
    await layoutIs('b');
    const measured = await atWidths(cdp, [1024, 1366, 1920], () =>
      evaluateExpr(
        cdp,
        `(() => {
          const bar = document.getElementById('top-bar');
          const buttons = [...document.querySelectorAll('#view-buttons button, #layout-buttons button')];
          return {
            fit: bar.dataset.fit,
            groups: [document.getElementById('view-buttons').getAttribute('aria-label'), document.getElementById('layout-buttons').getAttribute('aria-label')],
            groupRoles: [document.getElementById('view-buttons').getAttribute('role'), document.getElementById('layout-buttons').getAttribute('role')],
            buttons: buttons.map((button) => {
              const r = button.getBoundingClientRect();
              // The visible text: every span (or the button itself) that is displayed with a box.
              const visible = (button.querySelector('span') === null ? [button] : [...button.querySelectorAll('span')])
                .filter((el) => el.getClientRects().length > 0 && getComputedStyle(el).display !== 'none')
                .map((el) => el.textContent);
              return {
                key: button.dataset.key,
                type: button.type,
                width: Math.round(r.width * 100) / 100,
                height: Math.round(r.height * 100) / 100,
                pressed: button.getAttribute('aria-pressed'),
                label: button.getAttribute('aria-label'),
                title: button.title,
                visible,
              };
            }),
          };
        })()`,
      ),
    );
    const problems = [];
    for (const [index, width] of [1024, 1366, 1920].entries()) {
      const m = measured[index];
      if (m.buttons.length !== 9) problems.push(`${width}: ${m.buttons.length} buttons`);
      if (m.groups.join('|') !== 'Views|Layout' || m.groupRoles.join('|') !== 'group|group') problems.push(`${width}: groups ${m.groups} ${m.groupRoles}`);
      m.buttons.forEach((b, i) => {
        const part = parts[i];
        if (b.key !== part.key) problems.push(`${width}: button ${i} has key ${b.key}, wanted ${part.key}`);
        if (b.type !== 'button') problems.push(`${width}: ${b.key} is type ${b.type}`);
        if (b.width < 24 || b.height < 24) problems.push(`${width}: ${b.key} is ${b.width}x${b.height}`);
        if (b.label !== part.label) problems.push(`${width}: ${b.key} is named ${JSON.stringify(b.label)}, wanted ${JSON.stringify(part.label)}`);
        if (b.visible.length === 0 || !b.visible.every((text) => b.label.includes(text))) problems.push(`${width}: ${b.key} shows ${JSON.stringify(b.visible)}, not contained in ${JSON.stringify(b.label)}`);
        const wantPressed = b.key === '4' || b.key === 'b';
        if (b.pressed !== String(wantPressed)) problems.push(`${width}: ${b.key} aria-pressed is ${b.pressed}`);
      });
      const names = m.buttons.filter((b) => /^[a-c]$/.test(b.key)).map((b) => b.label);
      if (names.join('|') !== 'Layout a: bottom strip|Layout b: side panel|Layout c: full screen over faint code') problems.push(`${width}: layout names ${names}`);
    }
    report(
      'controls: view and layout buttons are at least 24x24 and pressed state follows the view and the layout',
      problems.length === 0,
      JSON.stringify({ problems, fits: measured.map((m) => m.fit), smallest: measured.map((m) => Math.min(...m.buttons.map((b) => Math.min(b.width, b.height)))) }),
    );
    await reset();
  }

  // Pressing the pressed view closes it, pressing again brings it back, and the keys still work after a click.
  {
    const panelHidden = () => evaluateExpr(cdp, `document.getElementById('view-panel').hidden`);
    const pressedViews = () => evaluateExpr(cdp, `[...document.querySelectorAll('#view-buttons button[aria-pressed="true"]')].map((b) => b.dataset.key)`);
    await clickElement(cdp, '#view-buttons button[data-key="4"]');
    const opened = (await viewIs('parts')) === true && (await panelHidden()) === false && JSON.stringify(await pressedViews()) === '["4"]';
    await clickElement(cdp, '#view-buttons button[data-key="4"]');
    // The panel fades out before it is hidden, so its hidden flag is waited for.
    const closed = (await viewIs('none')) === true && (await waitFor(cdp, `document.getElementById('view-panel').hidden ? true : null`, 2000)) === true && (await pressedViews()).length === 0;
    await clickElement(cdp, '#view-buttons button[data-key="4"]');
    const reopened = (await viewIs('parts')) === true && (await panelHidden()) === false && JSON.stringify(await pressedViews()) === '["4"]';
    // After a mouse click the button gave up focus, so the keys work at once.
    const bodyFocused = await evaluateExpr(cdp, 'document.activeElement === document.body');
    const keyResults = {};
    for (const key of ['1', '2', '3', '4', '5', '6']) {
      await pressKey(cdp, key);
      const wanted = VIEW_KEYS[key];
      keyResults[key] = (await viewIs(wanted)) === true && JSON.stringify(await pressedViews()) === JSON.stringify([key]);
      await pressKey(cdp, key);
      keyResults[`${key} again`] = (await viewIs('none')) === true;
    }
    for (const key of ['b', 'c', 'a']) {
      await pressKey(cdp, key);
      keyResults[key] = (await layoutIs(key)) === true && (await evaluateExpr(cdp, `document.querySelector('#layout-buttons button[aria-pressed="true"]').dataset.key`)) === key;
    }
    await pressKey(cdp, '5');
    await viewIs('jam');
    await pressKey(cdp, 'Escape');
    keyResults.Escape = (await viewIs('none')) === true;
    report(
      'controls: pressing the pressed view closes it and again brings it back',
      opened && closed && reopened && bodyFocused === true && Object.values(keyResults).every((ok) => ok === true),
      JSON.stringify({ opened, closed, reopened, bodyFocused, keyResults }),
    );
    await reset();
  }

  // I6: Tab reaches every bar control in visual order (the DOM order is the visual order).
  {
    await evaluateExpr(
      cdp,
      `(() => {
        if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
        document.body.setAttribute('tabindex', '-1');
        document.body.focus();
        document.body.removeAttribute('tabindex');
        return true;
      })()`,
    );
    const visited = [];
    for (let i = 0; i < 16; i += 1) {
      await pressKey(cdp, 'Tab');
      const now = await evaluateExpr(
        cdp,
        `(() => { const el = document.activeElement; if (el === null || el.closest('#top-bar') === null) return null; return el.id !== '' ? el.id : el.dataset.key ?? el.tagName; })()`,
      );
      if (now === null) break;
      visited.push(now);
    }
    const visual = await evaluateExpr(
      cdp,
      `[...document.querySelectorAll('#top-bar button')].filter((b) => b.getClientRects().length > 0).map((b, index) => ({ name: b.id !== '' ? b.id : b.dataset.key, left: b.getBoundingClientRect().left, index })).sort((a, b) => a.left - b.left || a.index - b.index).map((b) => b.name)`,
    );
    report(
      'controls: Tab reaches every bar control in visual order',
      visited.length === 11 && JSON.stringify(visited) === JSON.stringify(visual) && visited[0] === TRANSPORT_ID && visited[10] === 'session-button',
      JSON.stringify({ visited, visual }),
    );
    await reset();
  }

  // Enter and Space activate a focused button, which keeps focus after a keyboard activation; a mouse click gives focus up.
  {
    await evaluateExpr(cdp, `document.querySelector('#layout-buttons button[data-key="b"]').focus()`);
    await pressKey(cdp, 'Enter');
    const enter = (await layoutIs('b')) === true && (await evaluateExpr(cdp, `document.activeElement.dataset.key`)) === 'b';
    await evaluateExpr(cdp, `document.querySelector('#layout-buttons button[data-key="c"]').focus()`);
    await pressKey(cdp, ' ');
    const space = (await layoutIs('c')) === true && (await evaluateExpr(cdp, `document.activeElement.dataset.key`)) === 'c';
    await evaluateExpr(cdp, `document.querySelector('#view-buttons button[data-key="3"]').focus()`);
    await pressKey(cdp, 'Enter');
    const viewEnter = (await viewIs('mixer')) === true && (await evaluateExpr(cdp, `document.activeElement.dataset.key`)) === '3';
    await pressKey(cdp, ' ');
    const viewSpace = (await viewIs('none')) === true && (await evaluateExpr(cdp, `document.activeElement.dataset.key`)) === '3';
    await clickElement(cdp, '#layout-buttons button[data-key="a"]');
    const mouse = (await layoutIs('a')) === true && (await evaluateExpr(cdp, 'document.activeElement === document.body')) === true;
    report(
      'controls: Enter and Space activate a focused button and it keeps focus; a mouse click gives focus up',
      enter && space && viewEnter && viewSpace && mouse,
      JSON.stringify({ enter, space, viewEnter, viewSpace, mouse }),
    );
    await reset();
  }
}

/**
 * The two info buttons of the Session drawer against the live page. `context` is { cdp, client, report, port, pageUrl }, the same object
 * barBlocks gets. The buttons only show while their status shows, so the worst-case fixture shows both for the checks. It
 * leaves the page as it found it: no popover open, the drawer closed, the viewport override cleared.
 */
async function infoButtonsBlocks(context) {
  const { cdp, report } = context;
  const INFO = [
    { id: 'midi-info', help: 'midi-help', name: MIDI_COPY.infoLabel },
    { id: 'page-requests-info', help: 'page-requests-help', name: PAGE_REQUESTS_COPY.infoLabel },
  ];
  const blur = () => evaluateExpr(cdp, `(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); return true; })()`);
  const state = (info) =>
    evaluateExpr(
      cdp,
      `(() => {
        const button = document.getElementById(${JSON.stringify(info.id)});
        const help = document.getElementById(${JSON.stringify(info.help)});
        const active = document.activeElement;
        return { expanded: button.getAttribute('aria-expanded'), hidden: help.hidden, focusOnButton: active === button, focusInside: help.contains(active) || active === help };
      })()`,
    );
  await blur();
  await closeDrawer(cdp);
  await openDrawer(cdp);
  const saved = await setWorstCase(cdp);
  try {
    // Round, at least 24 x 24, the letter i, a native button with its name.
    {
      const measured = await atWidths(cdp, [1024, 1366, 1920], () =>
        evaluateExpr(
          cdp,
          `${JSON.stringify(INFO.map((info) => info.id))}.map((id) => {
            const button = document.getElementById(id);
            const r = button.getBoundingClientRect();
            const style = getComputedStyle(button);
            const root = parseFloat(getComputedStyle(document.documentElement).fontSize);
            return { id, tag: button.tagName, type: button.type, text: button.textContent, label: button.getAttribute('aria-label'), width: Math.round(r.width * 100) / 100, height: Math.round(r.height * 100) / 100, root, radius: style.borderTopLeftRadius, borderWidth: style.borderTopWidth, shown: r.width > 0 && r.height > 0 };
          })`,
        ),
      );
      const problems = [];
      for (const [index, width] of [1024, 1366, 1920].entries()) {
        for (const [position, m] of measured[index].entries()) {
          const label = INFO[position].name;
          if (m.tag !== 'BUTTON' || m.type !== 'button') problems.push(`${width}: ${m.id} is ${m.tag} of type ${m.type}`);
          if (m.text !== 'i') problems.push(`${width}: ${m.id} shows ${JSON.stringify(m.text)}`);
          if (m.label !== label) problems.push(`${width}: ${m.id} is named ${JSON.stringify(m.label)}`);
          if (!m.shown || m.width < 24 || m.height < 24) problems.push(`${width}: ${m.id} is ${m.width}x${m.height}`);
          if (Math.abs(m.width - m.height) > 0.5) problems.push(`${width}: ${m.id} is not square`);
          if (m.radius !== '50%' && parseFloat(m.radius) < m.width / 2 - 0.5) problems.push(`${width}: ${m.id} is not round (${m.radius})`);
          if (m.borderWidth !== '1px') problems.push(`${width}: ${m.id} has a ${m.borderWidth} border`);
        }
      }
      report(
        'controls: the info buttons are round, at least 24x24 and show the letter i',
        problems.length === 0,
        JSON.stringify({ problems, sizes: measured.map((list) => list.map((m) => `${m.width}x${m.height}`)) }),
      );
    }

    // Click, Enter and Space open; Esc closes with focus back; a second click closes. The window is 1920 px wide, where an open
    // popover does not cover its own button (at 1024 it does, and Esc is the way out).
    {
      await cdp('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
      await sleep(300);
      const results = {};
      for (const info of INFO) {
        const selector = `#${info.id}`;
        const r = {};
        // No blur anywhere in this block: the drawer closes when focus leaves it, so each step makes sure it is open instead.
        await openDrawer(cdp);
        await clickElement(cdp, selector);
        await sleep(100);
        r.click = await state(info);
        await pressKey(cdp, 'Escape');
        await sleep(100);
        r.escape = await state(info);
        await evaluateExpr(cdp, `document.getElementById(${JSON.stringify(info.id)}).focus()`);
        await pressKey(cdp, 'Enter');
        await sleep(100);
        r.enter = await state(info);
        await pressKey(cdp, 'Escape');
        await sleep(100);
        await evaluateExpr(cdp, `document.getElementById(${JSON.stringify(info.id)}).focus()`);
        await pressKey(cdp, ' ');
        await sleep(100);
        r.space = await state(info);
        await pressKey(cdp, 'Escape');
        await sleep(100);
        await openDrawer(cdp);
        await clickElement(cdp, selector);
        await sleep(100);
        r.first = await state(info);
        await clickElement(cdp, selector);
        await sleep(200);
        r.second = await state(info);
        results[info.id] = r;
      }
      const problems = [];
      for (const [id, r] of Object.entries(results)) {
        for (const key of ['click', 'enter', 'space', 'first']) {
          if (r[key].expanded !== 'true' || r[key].hidden !== false) problems.push(`${id}: ${key} did not open (${JSON.stringify(r[key])})`);
        }
        if (r.click.focusInside !== true) problems.push(`${id}: focus is not in the popover after the click`);
        if (r.escape.expanded !== 'false' || r.escape.hidden !== true || r.escape.focusOnButton !== true) problems.push(`${id}: Esc left ${JSON.stringify(r.escape)}`);
        if (r.second.expanded !== 'false' || r.second.hidden !== true) problems.push(`${id}: a second click left ${JSON.stringify(r.second)}`);
      }
      await cdp('Emulation.clearDeviceMetricsOverride');
      await sleep(300);
      report(
        'controls: an info button opens on click, Enter and Space, closes on Esc with focus back and on a second click',
        problems.length === 0,
        JSON.stringify({ problems }),
      );
    }

    // A popover opened from the drawer sits under the bar: its top is not above the bar's bottom, at three widths.
    {
      const measured = await atWidths(cdp, [1024, 1366, 1920], async () => {
        const rows = [];
        for (const info of INFO) {
          await evaluateExpr(cdp, `document.getElementById(${JSON.stringify(info.id)}).click()`);
          await sleep(100);
          rows.push(
            await evaluateExpr(
              cdp,
              `(() => {
                const help = document.getElementById(${JSON.stringify(info.help)});
                const bar = document.getElementById('top-bar').getBoundingClientRect();
                const box = help.getBoundingClientRect();
                return { id: ${JSON.stringify(info.id)}, shown: !help.hidden && box.width > 0, top: Math.round(box.top), barBottom: Math.round(bar.bottom) };
              })()`,
            ),
          );
          await pressKey(cdp, 'Escape');
          await sleep(100);
        }
        return rows;
      });
      const problems = [];
      for (const [index, width] of [1024, 1366, 1920].entries()) {
        for (const m of measured[index]) {
          if (!m.shown) problems.push(`${width}: ${m.id} popover not shown`);
          else if (m.top < m.barBottom) problems.push(`${width}: ${m.id} popover top ${m.top} is above the bar bottom ${m.barBottom}`);
        }
      }
      report('controls: a popover opened from the drawer does not overlap the bar', problems.length === 0, JSON.stringify({ problems, measured }));
    }
  } finally {
    await cdp('Emulation.clearDeviceMetricsOverride');
    await sleep(200);
    await blur();
    await restoreWorstCase(cdp, saved);
    await closeDrawer(cdp);
    await blur();
  }
}

/**
 * The Edits timing group of the Settings card against the live page. `context` is { cdp, client,
 * report, port, pageUrl }, the same object barBlocks gets. Three native buttons, one pressed; a press sets the stored setting
 * and says the existing line; a reload keeps it; each is at least 24 x 24. It leaves the setting at now, the drawer closed
 * and the viewport override cleared.
 */
async function editsTimingBlocks(context) {
  const { cdp, report } = context;
  const STORED_KEY = 'moontide.changeTiming';
  const options = timingOptions();
  const read = () =>
    evaluateExpr(
      cdp,
      `(() => {
        const group = document.getElementById('change-timing');
        return {
          tag: group.tagName,
          role: group.getAttribute('role'),
          label: group.getAttribute('aria-label'),
          buttons: [...group.querySelectorAll('button')].map((b) => ({ value: b.dataset.value, text: b.textContent, name: b.getAttribute('aria-label'), type: b.type, pressed: b.getAttribute('aria-pressed') })),
          stored: localStorage.getItem(${JSON.stringify(STORED_KEY)}),
          status: document.getElementById('change-status').textContent,
        };
      })()`,
    );
  const pressedValues = (state) => state.buttons.filter((b) => b.pressed === 'true').map((b) => b.value);

  await closeDrawer(cdp);
  const results = [];
  for (const option of options) {
    await pickTiming(cdp, option.value);
    await sleep(150);
    const state = await read();
    results.push({ value: option.value, pressed: pressedValues(state), stored: state.stored, status: state.status });
  }
  const shape = await read();
  await pickTiming(cdp, 'phrase');
  await sleep(150);
  // Pressing the pressed button again changes nothing and still says the line.
  await evaluateExpr(cdp, `document.getElementById('change-status').textContent = ''`);
  await pickTiming(cdp, 'phrase');
  await sleep(150);
  const again = await read();
  await reloadPage(cdp);
  const afterReload = await read();
  await pickTiming(cdp, 'now');
  await sleep(150);
  const reset = await read();
  const ok =
    shape.tag === 'DIV' &&
    shape.role === 'group' &&
    shape.label === 'Your edits take over' &&
    shape.buttons.length === 3 &&
    shape.buttons.every((b, index) => b.value === options[index].value && b.text === options[index].label && b.name === options[index].name && b.type === 'button') &&
    results.every((r) => r.pressed.join() === r.value && r.stored === r.value && r.status === settingLine(r.value)) &&
    pressedValues(again).join() === 'phrase' && again.status === settingLine('phrase') &&
    pressedValues(afterReload).join() === 'phrase' && afterReload.stored === 'phrase' &&
    pressedValues(reset).join() === 'now' && reset.stored === 'now';
  report(
    'edits timing: three buttons, one pressed, a press sets the setting and says the line',
    ok,
    JSON.stringify({ shape: shape.buttons.map((b) => [b.value, b.text, b.name]), results, again: [pressedValues(again), again.status], afterReload: pressedValues(afterReload), reset: [pressedValues(reset), reset.stored] }),
  );

  await openDrawer(cdp);
  try {
    const measured = await atWidths(cdp, [1024, 1366, 1920], () =>
      evaluateExpr(
        cdp,
        `(() => {
          const group = document.getElementById('change-timing');
          const card = group.closest('.session-card').getBoundingClientRect();
          const box = group.getBoundingClientRect();
          return {
            inside: box.left >= card.left - 1 && box.right <= card.right + 1,
            buttons: [...group.querySelectorAll('button')].map((b) => { const r = b.getBoundingClientRect(); return { value: b.dataset.value, width: Math.round(r.width * 100) / 100, height: Math.round(r.height * 100) / 100 }; }),
          };
        })()`,
      ),
    );
    const problems = [];
    for (const [index, width] of [1024, 1366, 1920].entries()) {
      const m = measured[index];
      if (m.buttons.length !== 3) problems.push(`${width}: ${m.buttons.length} buttons`);
      if (!m.inside) problems.push(`${width}: the group leaves its card`);
      for (const b of m.buttons) if (b.width < 24 || b.height < 24) problems.push(`${width}: ${b.value} is ${b.width}x${b.height}`);
    }
    report('edits timing: the buttons are at least 24x24', problems.length === 0, JSON.stringify({ problems, sizes: measured.map((m) => m.buttons.map((b) => `${b.width}x${b.height}`)) }));
  } finally {
    await cdp('Emulation.clearDeviceMetricsOverride');
    await sleep(300);
    await closeDrawer(cdp);
  }
}

/**
 * Invariant I5 against the live page. `context` is { cdp, client, report, port,
 * pageUrl }, the same object barBlocks gets. At 1024, 1366 and 1920 px every button of the chrome (the bar, the failed-change
 * banner with its menu, the strip, the drawer) and the return banner's Dismiss is at least 24 x 24 CSS px by
 * getBoundingClientRect, and a scan lists every button in #chrome and #midi-banner: one that no SIZED_CONTROLS selector
 * matches fails, so a new button cannot dodge the rule. The failed-change banner is real (a failing hand evaluation) and its
 * menu is the real right-click popover; the quiet states that need a second tab or a MIDI port (the strip, the card's
 * Play in this tab, the return banner, the two info buttons) are shown by layout only, inside the same page evaluation that
 * measures them, and put back at once. It leaves the page as it found it: no banner, the editor's code restored, the drawer
 * closed, the viewport override cleared.
 */
async function sizesBlocks(context) {
  const { cdp, report } = context;
  const BAR_CODE = 'setcps(0.5)\nbar_probe: s("bd*4").gain(0)';
  const FORCED = ['#session-strip', '#strip-take-back', '#midi-banner', '#midi-takeover', '#midi-state', '#page-requests'];
  const WIDTHS = [1024, 1366, 1920];
  const setEditor = (text) => evaluateExpr(cdp, `(() => { document.getElementById('repl').editor.setCode(${JSON.stringify(text)}); return true; })()`);
  const blur = () => evaluateExpr(cdp, `(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); return true; })()`);
  const measure = () =>
    evaluateExpr(
      cdp,
      `(() => {
        const forced = ${JSON.stringify(FORCED)}.map((selector) => ({ el: document.querySelector(selector), hidden: document.querySelector(selector).hidden }));
        for (const { el } of forced) el.hidden = false;
        try {
          const buttons = [...document.querySelectorAll('#chrome button, #midi-banner button')];
          return buttons.map((button) => {
            const r = button.getBoundingClientRect();
            return {
              name: button.id !== '' ? '#' + button.id : button.parentElement.id + ' ' + (button.dataset.key ?? button.dataset.value ?? button.textContent),
              boxed: button.getClientRects().length > 0 && r.width > 0 && r.height > 0,
              width: Math.round(r.width * 100) / 100,
              height: Math.round(r.height * 100) / 100,
              listed: ${JSON.stringify(SIZED_CONTROLS)}.some((selector) => button.matches(selector)),
            };
          });
        } finally {
          for (const { el, hidden } of forced) el.hidden = hidden;
        }
      })()`,
    );

  await blur();
  await closeDrawer(cdp);
  await setEditor(`(() => { throw new Error('sizes probe: a failed change'); })()`);
  await pressCtrl(cdp, 'Enter', 'Enter', 13);
  await waitBanner(cdp, 'sizes: a failed hand evaluation');
  let measured;
  try {
    measured = await atWidths(cdp, WIDTHS, async () => {
      await openDrawer(cdp);
      const first = await measure();
      // The banner's right-click popover; opening it moves focus to its first button, which closes the drawer.
      const asked = await askAt(cdp, '#problem-banner .problem-lead');
      await sleep(150);
      const second = await measure();
      await pressKey(cdp, 'Escape');
      await sleep(100);
      return { first, second, prevented: asked.prevented };
    });
  } finally {
    await cdp('Emulation.clearDeviceMetricsOverride');
    await sleep(300);
    await closeDrawer(cdp);
    await blur();
    if ((await evaluateExpr(cdp, `document.getElementById('problem-banner').hidden`)) === false) {
      await clickElement(cdp, '#problem-dismiss');
      await waitBanner(cdp, 'sizes: dismiss', { shown: false });
    }
    await setEditor(BAR_CODE);
  }
  const problems = [];
  const counts = [];
  for (const [index, width] of WIDTHS.entries()) {
    const { first, second, prevented } = measured[index];
    if (prevented !== true) problems.push(`${width}: the right-click did not open the banner menu`);
    // A button counts at its best box of the two reads (the menu's buttons only have one in the second, the drawer's only in the first).
    const byName = new Map();
    for (const read of [first, second]) {
      for (const b of read) {
        const known = byName.get(b.name);
        if (known === undefined || (b.boxed && !known.boxed)) byName.set(b.name, b);
      }
    }
    counts.push(byName.size);
    for (const b of byName.values()) {
      if (!b.listed) problems.push(`${width}: ${b.name} is a button of the chrome that SIZED_CONTROLS does not list`);
      else if (!b.boxed) problems.push(`${width}: ${b.name} was never displayed, so its size was not measured`);
      else if (b.width < 24 || b.height < 24) problems.push(`${width}: ${b.name} is ${b.width}x${b.height}`);
    }
  }
  report(
    'controls: every button of the bar, banner, menu, strip and drawer is at least 24x24 at 1024, 1366 and 1920, and none escapes SIZED_CONTROLS',
    problems.length === 0 && counts.every((count) => count >= SIZED_CONTROLS.length),
    JSON.stringify({ problems, buttons: counts, listed: SIZED_CONTROLS.length }),
  );
}

/**
 * The fit loop against the live page. `context` is { cdp, client, report, port,
 * pageUrl }, the same object barBlocks gets. The normal state: the music plays, nothing waits, no request status, the
 * drawer closed. The worst case (the longest strings in every item) is checked by the worst-case blocks. It leaves the page as it found it: no
 * view open, layout a, the viewport override cleared.
 */
async function fitBlocks(context) {
  const { cdp, report } = context;
  const blur = () => evaluateExpr(cdp, `(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); return true; })()`);
  const setWidth = async (width, settle = 250) => {
    await cdp('Emulation.setDeviceMetricsOverride', { width, height: 768, deviceScaleFactor: 1, mobile: false });
    await sleep(settle);
  };
  const readFit = async () => Number(await evaluateExpr(cdp, `document.getElementById('top-bar').dataset.fit`));
  const barState = () =>
    evaluateExpr(
      cdp,
      `(() => {
        const bar = document.getElementById('top-bar');
        const buttons = [...document.querySelectorAll('#view-buttons button, #layout-buttons button')];
        return {
          width: window.innerWidth,
          fit: bar.dataset.fit,
          whole: bar.scrollWidth <= bar.clientWidth,
          scrollWidth: bar.scrollWidth,
          clientWidth: bar.clientWidth,
          spacer: document.getElementById('bar-spacer').getBoundingClientRect().width,
          root: parseFloat(getComputedStyle(document.documentElement).fontSize),
          buttonsInside: buttons.length === 9 && buttons.every((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.right <= bar.getBoundingClientRect().right + 0.5; }),
        };
      })()`,
    );

  await blur();
  await closeDrawer(cdp);

  // The normal state is whole at 1024, 1366 and 1920 (the tracer's check; the seven-width sweep is below).
  {
    const measured = await atWidths(cdp, [1024, 1366, 1920], barState);
    report(
      'fit: the bar never overflows at 1024, 1366 and 1920 in the normal state',
      measured.every((m) => m.whole && m.buttonsInside),
      JSON.stringify(measured.map((m) => ({ width: m.width, fit: m.fit, scrollWidth: m.scrollWidth, clientWidth: m.clientWidth, spacer: Math.round(m.spacer) }))),
    );
  }

  // The seven widths; a ResizeObserver loop error is a window error, so it is collected across the sweeps and the rapid width changes.
  {
    await evaluateExpr(
      cdp,
      `(() => { window.__moontideErrors = []; window.addEventListener('error', (event) => window.__moontideErrors.push(String(event.message))); return true; })()`,
    );
    const measured = await atWidths(cdp, BAR_WIDTHS, barState);
    const back = await atWidths(cdp, [...BAR_WIDTHS].reverse(), barState);
    // Rapid changes: no settling time between them, so notifications are still in flight when the next width arrives.
    for (const width of [1100, 1010, 1500, 1024, 1920, 1300, 1050, 1920]) await setWidth(width, 40);
    await sleep(400);
    await cdp('Emulation.clearDeviceMetricsOverride');
    await sleep(300);
    const errors = await evaluateExpr(cdp, 'window.__moontideErrors');
    const fitByWidth = Object.fromEntries(measured.map((m) => [m.width, m.fit]));
    const sameBack = back.every((m) => m.fit === fitByWidth[m.width]);
    report(
      'fit: normal state is whole at 1024, 1280, 1366, 1440, 1920, 2560 and 3840',
      measured.length === 7 && measured.every((m) => m.whole && m.buttonsInside) && back.every((m) => m.whole && m.buttonsInside) && sameBack,
      JSON.stringify({ fitByWidth, sameBack, overflowing: [...measured, ...back].filter((m) => !m.whole).map((m) => [m.width, m.scrollWidth, m.clientWidth]) }),
    );
    report(
      'fit: no ResizeObserver loop error is raised while the width changes',
      Array.isArray(errors) && errors.filter((message) => /ResizeObserver/i.test(message)).length === 0,
      JSON.stringify({ errors }),
    );
  }

  // The spacer at the last step: with every step used at 1024 px the bar keeps at least 2rem free (font differences on
  // Windows and Linux). In the normal state the loop stops before the last step, so the last step is also forced to measure it.
  {
    const [measured] = await atWidths(cdp, [1024], () =>
      evaluateExpr(
        cdp,
        `(() => {
          const bar = document.getElementById('top-bar');
          const spacer = document.getElementById('bar-spacer');
          const root = parseFloat(getComputedStyle(document.documentElement).fontSize);
          const natural = { fit: bar.dataset.fit, spacer: spacer.getBoundingClientRect().width };
          bar.setAttribute('data-fit', '4');
          const lastStep = { spacer: spacer.getBoundingClientRect().width, whole: bar.scrollWidth <= bar.clientWidth };
          bar.setAttribute('data-fit', natural.fit);
          return { root, natural, lastStep };
        })()`,
      ),
    );
    const floor = 2 * measured.root;
    report(
      'fit: the spacer keeps at least 2rem at the last step reached at 1024',
      measured.lastStep.whole && measured.lastStep.spacer >= floor && (Number(measured.natural.fit) < 4 || measured.natural.spacer >= floor),
      JSON.stringify({ floor, natural: measured.natural, lastStep: measured.lastStep }),
    );
    await sleep(300);
  }

  // The order of the steps: the width where each step starts is found by bisection (the step never rises with the width), and
  // just under it the page shows exactly what the contract says.
  {
    await blur();
    await pressKey(cdp, '4');
    await waitFor(cdp, `document.getElementById('workspace').dataset.view === 'parts' ? true : null`, 3000);
    const fitAt = async (width) => {
      await setWidth(width, 220);
      return readFit();
    };
    // The smallest width in (lo, hi] where the step is at most k. The step at lo is above k and at hi it is at most k.
    const boundary = async (k, lo, hi) => {
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        if ((await fitAt(mid)) <= k) hi = mid;
        else lo = mid;
      }
      return hi;
    };
    const looks = () =>
      evaluateExpr(
        cdp,
        `(() => {
          const bar = document.getElementById('top-bar');
          const display = (selector) => [...document.querySelectorAll(selector)].map((el) => getComputedStyle(el).display);
          const barStyle = getComputedStyle(bar);
          const root = parseFloat(getComputedStyle(document.documentElement).fontSize);
          return {
            fit: bar.dataset.fit,
            cycleText: document.getElementById('cycle-beat').textContent,
            wordmark: display('#product-name'),
            cycle: display('#cycle-beat'),
            unselectedNames: display('#view-buttons button[aria-pressed="false"] .view-name'),
            selectedName: display('#view-buttons button[aria-pressed="true"] .view-name'),
            digits: [...document.querySelectorAll('#view-buttons .view-digit')].map((d) => d.getBoundingClientRect().width > 0),
            unit: display('#tempo-readout .tempo-unit'),
            layoutWord: display('#top-bar .layout-word'),
            seps: display('#top-bar .bar-sep'),
            gap: parseFloat(barStyle.columnGap) / root,
            padding: parseFloat(barStyle.paddingLeft) / root,
            whole: bar.scrollWidth <= bar.clientWidth,
          };
        })()`,
      );
    const none = (list) => list.length > 0 && list.every((d) => d === 'none');
    const shown = (list) => list.length > 0 && list.every((d) => d !== 'none');
    const b0 = await boundary(0, 300, 1920);
    const at1 = await fitAt(b0 - 1);
    const look1 = await looks();
    const b1 = await boundary(1, 300, b0 - 1);
    const at2 = await fitAt(b1 - 1);
    const look2 = await looks();
    const b2 = await boundary(2, 300, b1 - 1);
    const at3 = await fitAt(b2 - 1);
    const look3 = await looks();
    const b3 = await boundary(3, 300, b2 - 1);
    const at4 = await fitAt(b3 - 1);
    const look4 = await looks();
    // Step 0 is read 10 px above the bisected edge: the cycle and beat beside the tempo grows by a digit (about 7 px) while the
    // music plays (99.3 to 100.0), so the edge found a moment ago is not exact a few seconds later; what the contract says is that
    // step 0 holds from a width a little above it.
    const at0 = await fitAt(b0 + 10);
    const look0 = await looks();
    report(
      'fit: step 1 drops the wordmark and the cycle first',
      at1 === 1 && look1.fit === '1' && none(look1.wordmark) && none(look1.cycle) && shown(look1.unselectedNames) && shown(look1.unit) && shown(look1.layoutWord) && shown(look1.seps) &&
        at0 === 0 && shown(look0.wordmark) && look0.whole === true,
      JSON.stringify({ b0, at0, at1, look0, look1 }),
    );
    report(
      'fit: the steps come in the order of the contract (1 decoration, 2 names, 3 short forms, 4 spacing)',
      b0 > b1 && b1 > b2 && b2 > b3 &&
        at2 === 2 && look2.fit === '2' && none(look2.wordmark) && none(look2.unselectedNames) && shown(look2.selectedName) && look2.digits.every(Boolean) && shown(look2.unit) && shown(look2.layoutWord) &&
        at3 === 3 && look3.fit === '3' && none(look3.unit) && none(look3.layoutWord) && none(look3.unselectedNames) && shown(look3.selectedName) && shown(look3.seps) && look3.gap === 0.5 && look3.padding === 0.75 &&
        at4 === 4 && look4.fit === '4' && none(look4.seps) && look4.gap === 0.25 && look4.padding === 0.5 && none(look4.unit) && none(look4.layoutWord),
      JSON.stringify({ boundaries: [b0, b1, b2, b3], look2, look3, look4 }),
    );

    // Growing the request status while the bar is already at its last step: the observer on the bar's children (no writer of
    // the page runs here, the text is written straight into the element) brings the bar back inside itself. At the last step
    // the bar has at most what that step gives back (about 64 px) free, so the text grown here is the one-request status, whose
    // short form fits there; the 12-request sentence needs steps 1 to 3 and is measured at its own width by the next block.
    {
      await fitAt(b3 - 1);
      const before = await barState();
      await evaluateExpr(
        cdp,
        `(() => {
          const status = document.getElementById('ask-status');
          status.querySelector('.ask-long').textContent = ${JSON.stringify(ASK_COPY.waiting)};
          status.querySelector('.ask-short').textContent = ${JSON.stringify(waitingShortText(1))};
          status.hidden = false;
          return true;
        })()`,
      );
      await sleep(400);
      const grown = await evaluateExpr(
        cdp,
        `(() => {
          const status = document.getElementById('ask-status');
          const bar = document.getElementById('top-bar');
          return {
            fit: bar.dataset.fit,
            whole: bar.scrollWidth <= bar.clientWidth,
            scrollWidth: bar.scrollWidth,
            clientWidth: bar.clientWidth,
            statusBox: status.getBoundingClientRect().width,
            shortShown: getComputedStyle(status.querySelector('.ask-short')).display !== 'none',
            statusInside: status.getBoundingClientRect().right <= bar.getBoundingClientRect().right,
          };
        })()`,
      );
      await evaluateExpr(
        cdp,
        `(() => {
          const status = document.getElementById('ask-status');
          status.hidden = true;
          status.querySelector('.ask-long').textContent = '';
          status.querySelector('.ask-short').textContent = '';
          return true;
        })()`,
      );
      await sleep(300);
      report(
        'fit: growing the ask status at the last step leaves the bar whole',
        before.fit === '4' && before.whole === true && grown.fit === '4' && grown.whole === true && grown.shortShown === true && grown.statusBox > 0 && grown.statusInside === true,
        JSON.stringify({ width: b3 - 1, before: { fit: before.fit, whole: before.whole }, grown }),
      );
    }

    await cdp('Emulation.clearDeviceMetricsOverride');
    await sleep(300);
    await blur();
    await pressKey(cdp, 'Escape');
    await waitFor(cdp, `document.getElementById('workspace').dataset.view === 'none' ? true : null`, 3000);
  }

  // The request status: nothing to say keeps it hidden and takes no width; at step 3 the worst case shows 12 waiting while the
  // whole sentence stays in the accessibility tree.
  {
    const idle = await evaluateExpr(
      cdp,
      `(() => {
        const status = document.getElementById('ask-status');
        const r = status.getBoundingClientRect();
        return { hidden: status.hidden, display: getComputedStyle(status).display, width: r.width, height: r.height, rects: status.getClientRects().length, long: status.querySelector('.ask-long').textContent, short: status.querySelector('.ask-short').textContent };
      })()`,
    );
    report(
      'ask status: nothing to say keeps it hidden and takes no width',
      idle.hidden === true && idle.display === 'none' && idle.width === 0 && idle.rects === 0 && idle.long === '' && idle.short === '',
      JSON.stringify(idle),
    );

    const saved = await setWorstCase(cdp);
    let m;
    try {
      m = await evaluateExpr(
        cdp,
        `(() => {
          const bar = document.getElementById('top-bar');
          const status = document.getElementById('ask-status');
          const long = status.querySelector('.ask-long');
          const short = status.querySelector('.ask-short');
          const natural = bar.dataset.fit;
          const read = (step) => {
            bar.setAttribute('data-fit', String(step));
            const l = getComputedStyle(long);
            const s = getComputedStyle(short);
            return { step, longDisplay: l.display, longPosition: l.position, longClip: l.clipPath, longWidth: long.getBoundingClientRect().width, shortDisplay: s.display, shortWidth: short.getBoundingClientRect().width };
          };
          const steps = [0, 1, 2, 3, 4].map(read);
          bar.setAttribute('data-fit', natural);
          return { role: status.getAttribute('role'), live: status.getAttribute('aria-live'), hidden: status.hidden, shortAriaHidden: short.getAttribute('aria-hidden'), longAriaHidden: long.getAttribute('aria-hidden'), longText: long.textContent, shortText: short.textContent, steps };
        })()`,
      );
    } finally {
      await restoreWorstCase(cdp, saved);
    }
    await sleep(300);
    const [s0, s1, s2, s3, s4] = m.steps;
    const sentence = (s) => s.shortDisplay === 'none' && s.longDisplay !== 'none' && s.longPosition !== 'absolute' && s.longWidth > 1;
    const shortForm = (s) => s.shortDisplay !== 'none' && s.shortWidth > 0 && s.longDisplay !== 'none' && s.longPosition === 'absolute' && s.longWidth <= 1 && s.longClip.startsWith('inset(');
    report(
      'ask status: at step 3 the worst case shows 12 waiting and the sentence is still in the accessibility tree',
      m.role === 'status' && m.live === 'polite' && m.hidden === false &&
        m.longText === WORST_CASE.askStatus && m.shortText === waitingShortText(12) && m.shortText === '12 waiting' &&
        m.shortAriaHidden === 'true' && m.longAriaHidden === null &&
        [s0, s1, s2].every(sentence) && [s3, s4].every(shortForm),
      JSON.stringify(m),
    );
  }
}

/**
 * Invariant I2 against the live page. `context` is { cdp, client,
 * report, port, pageUrl }, the same object barBlocks gets. The longest real strings of WORST_CASE are written into the page
 * (setWorstCase: 12 waiting requests, the refused connection, different builds, another tab, 118.5 to 1000.5 BPM, Change in
 * 12 bars, v12345 from v12344, the long state word, and both MIDI strings) and nothing is exempted at any width:
 *  - drawer closed, at 1024, 1280, 1366, 1440, 1920, 2560 and 3840 px, the bar's scrollWidth is not above its clientWidth, every
 *    item of the bar is inside it and none overlaps the next, and the tempo readout is whole and on one line;
 *  - the tempo readout is whole and on one line at every fit step, and the BPM unit goes at step 3 with the number and the
 *    arrow staying; at the last step the spacer keeps at least 2rem at 1024;
 *  - the fit step is a function of the width (the sweep down and back up agrees);
 *  - drawer open, the same items are whole in their cards and on their lines, both MIDI strings wrapped inside a 16rem card;
 *  - the strip's builds line, updated line and lost-tab line are whole at 1024, 1366 and their own width.
 * It leaves the page as it found it: the fixture restored, the drawer closed, the viewport override cleared.
 */
async function worstCaseBlocks(context) {
  const { cdp, report } = context;
  const blur = () => evaluateExpr(cdp, `(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); return true; })()`);
  const measureBar = () =>
    evaluateExpr(
      cdp,
      `(() => {
        const bar = document.getElementById('top-bar');
        const barBox = bar.getBoundingClientRect();
        const root = parseFloat(getComputedStyle(document.documentElement).fontSize);
        const lineOf = (node) => parseFloat(getComputedStyle(node).lineHeight);
        const kids = [...bar.children].filter((el) => el.id !== 'change-status' && el.id !== 'bar-spacer' && !el.hidden && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 0);
        const items = kids.map((el) => {
          const r = el.getBoundingClientRect();
          return { name: el.id !== '' ? el.id : el.className, left: r.left, right: r.right, whole: el.scrollWidth <= el.clientWidth + 0.5, oneLine: el.offsetHeight < lineOf(el) * 1.5 || el.matches('#view-buttons, #layout-buttons, button') };
        });
        const sorted = [...items].sort((a, b) => a.left - b.left);
        const overlaps = sorted.slice(1).map((item, index) => ({ a: sorted[index].name, b: item.name, by: sorted[index].right - item.left })).filter((pair) => pair.by > 0.5);
        const tempo = document.getElementById('tempo-readout');
        const unit = tempo.querySelector('.tempo-unit');
        const pending = document.getElementById('pending-change');
        return {
          width: window.innerWidth,
          fit: bar.dataset.fit,
          root,
          barFits: bar.scrollWidth <= bar.clientWidth,
          scrollWidth: bar.scrollWidth,
          clientWidth: bar.clientWidth,
          spacer: document.getElementById('bar-spacer').getBoundingClientRect().width,
          inside: items.every((item) => item.left >= barBox.left - 1 && item.right <= barBox.right + 1),
          overlaps,
          notWhole: items.filter((item) => !item.whole).map((item) => item.name),
          wrapped: items.filter((item) => !item.oneLine).map((item) => item.name),
          tempo: { text: tempo.innerText, whole: tempo.scrollWidth <= tempo.clientWidth + 0.5, oneLine: tempo.offsetHeight < lineOf(tempo) * 1.5, unitShown: getComputedStyle(unit).display !== 'none' },
          pending: pending.hidden ? null : pending.innerText,
          askShown: getComputedStyle(document.getElementById('ask-status').querySelector('.ask-short')).display !== 'none' ? 'short' : 'long',
        };
      })()`,
    );
  const tempoAtSteps = () =>
    evaluateExpr(
      cdp,
      `(() => {
        const bar = document.getElementById('top-bar');
        const natural = bar.dataset.fit;
        const tempo = document.getElementById('tempo-readout');
        const lineOf = parseFloat(getComputedStyle(tempo).lineHeight);
        const rows = [0, 1, 2, 3, 4].map((step) => {
          bar.setAttribute('data-fit', String(step));
          const unit = tempo.querySelector('.tempo-unit');
          const arrow = tempo.querySelector('.tempo-arrow');
          const num = tempo.querySelector('.tempo-num');
          return { step, text: tempo.innerText, whole: tempo.scrollWidth <= tempo.clientWidth + 0.5, oneLine: tempo.offsetHeight < lineOf * 1.5, unitShown: getComputedStyle(unit).display !== 'none', arrowShown: arrow.getBoundingClientRect().width > 0, numShown: num.getBoundingClientRect().width > 0 };
        });
        bar.setAttribute('data-fit', natural);
        return rows;
      })()`,
    );
  const spacerAt1024 = () =>
    evaluateExpr(
      cdp,
      `(() => {
        const bar = document.getElementById('top-bar');
        const spacer = document.getElementById('bar-spacer');
        const root = parseFloat(getComputedStyle(document.documentElement).fontSize);
        const natural = { fit: bar.dataset.fit, spacer: spacer.getBoundingClientRect().width, whole: bar.scrollWidth <= bar.clientWidth };
        bar.setAttribute('data-fit', '4');
        const last = { spacer: spacer.getBoundingClientRect().width, whole: bar.scrollWidth <= bar.clientWidth, free: bar.clientWidth - bar.scrollWidth };
        bar.setAttribute('data-fit', natural.fit);
        return { root, natural, last };
      })()`,
    );
  // The drawer items, measured in their cards: shown, whole, and how many lines they take.
  const drawerRead = () =>
    evaluateExpr(
      cdp,
      `(() => {
        const drawerItem = ${DRAWER_ITEM_JS};
        const ids = ['connection-state', 'build-mismatch', 'midi-takeover', 'midi-state', 'page-requests', 'version-indicator', 'change-timing', 'motion-switch'];
        const items = Object.fromEntries(ids.map((id) => [id, drawerItem(id)]));
        // The Edits timing group is boxes, not text: its "lines" are the rows its three buttons sit on.
        items['change-timing'].lines = new Set([...document.querySelectorAll('#change-timing button')].map((b) => Math.round(b.getBoundingClientRect().top))).size;
        const drawer = document.getElementById('session-drawer');
        const buttons = ['take-back', 'midi-info', 'page-requests-info'].map((id) => { const r = document.getElementById(id).getBoundingClientRect(); const card = document.getElementById(id).closest('.session-card').getBoundingClientRect(); return { id, shown: r.width > 0, inside: r.left >= card.left - 1 && r.right <= card.right + 1 }; });
        const cardWidths = [...document.querySelectorAll('.session-card')].filter((card) => card.getClientRects().length > 0).map((card) => card.getBoundingClientRect().width);
        return { width: window.innerWidth, root: parseFloat(getComputedStyle(document.documentElement).fontSize), items, buttons, drawerFits: drawer.scrollWidth <= drawer.clientWidth, minCard: Math.min(...cardWidths) };
      })()`,
    );
  const setMidi = (kind) =>
    evaluateExpr(
      cdp,
      `(() => {
        const state = document.getElementById('midi-state');
        const dots = document.getElementById('midi-dots');
        const make = (kinds) => dots.replaceChildren(...kinds.map((kind) => { const span = document.createElement('span'); span.className = 'state-dot midi-dot'; span.dataset.kind = kind; return span; }));
        if (${JSON.stringify(kind)} === 'attention') {
          document.getElementById('midi-state-text').textContent = ${JSON.stringify(WORST_CASE.midiAttention)};
          state.dataset.attention = 'true';
          make(['filled', 'hollow', 'filled', 'hollow', 'filled', 'filled']);
        } else {
          document.getElementById('midi-state-text').textContent = ${JSON.stringify(WORST_CASE.midiOff)};
          delete state.dataset.attention;
          make(['filled', 'filled', 'off', 'off', 'off', 'off']);
        }
        return true;
      })()`,
    );

  await blur();
  await closeDrawer(cdp);
  const saved = await setWorstCase(cdp);
  let down;
  let back;
  let steps;
  let spacer;
  let narrowest;
  const drawerPasses = {};
  try {
    down = await atWidths(cdp, BAR_WIDTHS, measureBar);
    back = await atWidths(cdp, [...BAR_WIDTHS].reverse(), measureBar);
    [steps] = await atWidths(cdp, [1366], tempoAtSteps);
    [spacer] = await atWidths(cdp, [1024], spacerAt1024);
    // The narrowest window where the worst-case bar is still whole, by bisection (the step never rises with the width).
    {
      const wholeAt = async (width) => {
        await cdp('Emulation.setDeviceMetricsOverride', { width, height: 768, deviceScaleFactor: 1, mobile: false });
        await sleep(250);
        return evaluateExpr(cdp, `(() => { const bar = document.getElementById('top-bar'); return { whole: bar.scrollWidth <= bar.clientWidth, fit: bar.dataset.fit }; })()`);
      };
      let lo = 300;
      let hi = 1024;
      let atHi = await wholeAt(hi);
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        const read = await wholeAt(mid);
        if (read.whole) {
          hi = mid;
          atHi = read;
        } else lo = mid;
      }
      narrowest = { width: hi, fit: atHi.fit };
    }
    await openDrawer(cdp);
    for (const kind of ['attention', 'off']) {
      await setMidi(kind);
      drawerPasses[kind] = await atWidths(cdp, BAR_WIDTHS, drawerRead);
    }
  } finally {
    await cdp('Emulation.clearDeviceMetricsOverride');
    await sleep(300);
    await closeDrawer(cdp);
    await restoreWorstCase(cdp, saved);
    await sleep(300);
  }

  // The bar: whole at the seven widths with nothing exempted.
  {
    const bad = down.filter((m) => !m.barFits || !m.inside || m.overlaps.length > 0 || m.notWhole.length > 0 || m.wrapped.length > 0 || !m.tempo.whole || !m.tempo.oneLine);
    report(
      'worst case: the bar holds the longest strings whole at 1024, 1280, 1366, 1440, 1920, 2560 and 3840 with nothing exempted',
      down.length === 7 && bad.length === 0,
      JSON.stringify({
        fitByWidth: Object.fromEntries(down.map((m) => [m.width, m.fit])),
        spacerByWidth: Object.fromEntries(down.map((m) => [m.width, Math.round(m.spacer)])),
        tempoByWidth: Object.fromEntries(down.map((m) => [m.width, m.tempo.text])),
        pending: down.map((m) => m.pending),
        bad: bad.map((m) => ({ width: m.width, fit: m.fit, barFits: m.barFits, scrollWidth: m.scrollWidth, clientWidth: m.clientWidth, inside: m.inside, overlaps: m.overlaps, notWhole: m.notWhole, wrapped: m.wrapped, tempo: m.tempo })),
      }),
    );
  }

  // The tempo readout at every fit step, and the step of each width.
  {
    const naturalOk = down.every((m) => m.tempo.text.startsWith('118.5') && m.tempo.text.includes('1000.5') && m.tempo.text.includes('→') && m.tempo.unitShown === (Number(m.fit) < 3) && m.tempo.text.endsWith('BPM') === (Number(m.fit) < 3));
    const stepsOk = steps.every((row) => row.whole && row.oneLine && row.numShown && row.arrowShown && row.unitShown === (row.step < 3) && row.text.startsWith('118.5') && row.text.includes('1000.5') && row.text.endsWith('BPM') === (row.step < 3));
    report(
      'overflow / tempo-readout: 118.5 → 1000.5 BPM is whole and on one line at every fit step; the unit goes at step 3 and the number and arrow stay',
      naturalOk && stepsOk && steps[0].text === WORST_CASE.tempo,
      JSON.stringify({ steps: steps.map((row) => [row.step, row.text, row.whole, row.oneLine, row.unitShown]), natural: down.map((m) => [m.width, m.fit, m.tempo.text]) }),
    );
  }

  // The spacer at 1024.
  {
    const floor = 2 * spacer.root;
    report(
      'worst case: at 1024 the bar is whole and the spacer keeps at least 2rem at the last step',
      spacer.natural.whole && spacer.last.whole && spacer.last.spacer >= floor && (Number(spacer.natural.fit) < 4 || spacer.natural.spacer >= floor),
      JSON.stringify({ floor, natural: spacer.natural, lastStep: spacer.last }),
    );
    report('worst case: the longest strings stay whole below 1024 px (the narrowest whole width is recorded)', narrowest.width < 1024, JSON.stringify({ narrowest }));
  }

  // A function of the width: the sweep down and the sweep back agree, and a wider window never needs a higher step.
  {
    const byWidthDown = Object.fromEntries(down.map((m) => [m.width, Number(m.fit)]));
    const sameBack = back.every((m) => Number(m.fit) === byWidthDown[m.width] && m.barFits);
    const monotone = BAR_WIDTHS.every((width, index) => index === 0 || byWidthDown[width] <= byWidthDown[BAR_WIDTHS[index - 1]]);
    report('worst case: the fit step is a function of the width (down and back up, never higher when wider)', sameBack && monotone, JSON.stringify({ down: byWidthDown, back: Object.fromEntries(back.map((m) => [m.width, Number(m.fit)])) }));
  }

  // The same items in the drawer, open: whole in their cards and on their lines; both MIDI strings wrap inside a card.
  {
    const maxLines = { 'connection-state': 1, 'build-mismatch': 3, 'midi-takeover': 3, 'midi-state': 3, 'page-requests': 3, 'version-indicator': 2, 'change-timing': 1, 'motion-switch': 1 };
    const problems = [];
    for (const kind of ['attention', 'off']) {
      for (const m of drawerPasses[kind]) {
        for (const [id, item] of Object.entries(m.items)) {
          if (!item.shown) problems.push(`${kind} ${m.width}: #${id} is not displayed`);
          else if (!item.whole) problems.push(`${kind} ${m.width}: #${id} is clipped`);
          else if (item.lines > maxLines[id]) problems.push(`${kind} ${m.width}: #${id} takes ${item.lines} lines, more than ${maxLines[id]}`);
        }
        for (const b of m.buttons) if (!b.shown || !b.inside) problems.push(`${kind} ${m.width}: #${b.id} is ${b.shown ? 'outside its card' : 'not displayed'}`);
        if (!m.drawerFits) problems.push(`${kind} ${m.width}: the drawer scrolls sideways`);
      }
    }
    const lines = Object.fromEntries(['attention', 'off'].map((kind) => [kind, drawerPasses[kind].map((m) => `${m.width}:${m.items['midi-state'].lines}`)]));
    report(
      'worst case: with the drawer open the longest strings are whole in their cards, the MIDI strings wrap in a 16rem card',
      problems.length === 0 && drawerPasses.attention.length === 7 && drawerPasses.off.length === 7,
      JSON.stringify({ problems, midiLines: lines, minCard: drawerPasses.attention.map((m) => Math.round(m.minCard)) }),
    );
  }

  // The strip's lines, at 1024, 1366 and a wide window.
  {
    const texts = {
      builds: stripModel({ buildMismatch: true, serverUpdated: false, superseded: false, noActive: false }).text,
      updated: stripModel({ buildMismatch: false, serverUpdated: true, superseded: false, noActive: false }).text,
      lost: stripModel({ buildMismatch: false, serverUpdated: false, superseded: true, noActive: false }).text,
      all: stripModel({ buildMismatch: true, serverUpdated: false, superseded: true, noActive: false }).text,
    };
    const read = () =>
      evaluateExpr(
        cdp,
        `(() => {
          const strip = document.getElementById('session-strip');
          const text = document.getElementById('strip-text');
          const button = document.getElementById('strip-take-back');
          const saved = { hidden: strip.hidden, buttonHidden: button.hidden, text: text.textContent };
          const out = {};
          strip.hidden = false;
          button.hidden = false;
          for (const [name, value] of Object.entries(${JSON.stringify(texts)})) {
            text.textContent = value;
            const r = strip.getBoundingClientRect();
            const t = text.getBoundingClientRect();
            const b = button.getBoundingClientRect();
            out[name] = { whole: strip.scrollWidth <= strip.clientWidth && text.scrollWidth <= text.clientWidth + 0.5, inside: r.left >= 0 && r.right <= window.innerWidth && t.right <= r.right + 1 && b.right <= r.right + 1, lines: Math.round(t.height / parseFloat(getComputedStyle(text).lineHeight)) };
          }
          strip.hidden = saved.hidden;
          button.hidden = saved.buttonHidden;
          text.textContent = saved.text;
          return out;
        })()`,
      );
    let reads;
    try {
      reads = await atWidths(cdp, [1024, 1366, 1920], read);
    } finally {
      await cdp('Emulation.clearDeviceMetricsOverride');
      await sleep(300);
    }
    const problems = [];
    for (const [index, width] of [1024, 1366, 1920].entries()) {
      for (const [name, m] of Object.entries(reads[index])) {
        if (!m.whole || !m.inside) problems.push(`${width}: the ${name} line is ${m.whole ? 'outside the strip' : 'clipped'}`);
      }
    }
    report('worst case: the builds, updated and lost-tab lines of the strip are whole at 1024, 1366 and 1920', problems.length === 0, JSON.stringify({ problems, lines: reads.map((read2) => Object.fromEntries(Object.entries(read2).map(([name, m]) => [name, m.lines]))) }));
  }
}

const SPLIT_STORAGE = Object.freeze({ a: 'moontide.split.a', b: 'moontide.split.b' });

/** The separator's readings in one page evaluation: the ARIA values, the painted share of the view (the view panel's size
 * over the workspace's size along the main axis), the CSS variable, the stored sizes, focus and the boxes a drag needs. */
async function readSplit(cdp) {
  return evaluateExpr(
    cdp,
    `(() => {
      const ws = document.getElementById('workspace');
      const h = document.getElementById('split-handle');
      const p = document.getElementById('view-panel');
      const layout = ws.dataset.layout;
      const wr = ws.getBoundingClientRect();
      const pr = p.getBoundingClientRect();
      const hr = h.getBoundingClientRect();
      const er = document.getElementById('editor-area').getBoundingClientRect();
      const handleShown = !h.hidden && hr.width > 0 && hr.height > 0;
      const panelShown = !p.hidden && pr.width > 0 && pr.height > 0;
      const round = (n) => Math.round(n * 100) / 100;
      return {
        layout,
        view: ws.dataset.view,
        handleShown,
        panelShown,
        now: Number(h.getAttribute('aria-valuenow')),
        text: h.getAttribute('aria-valuetext'),
        label: h.getAttribute('aria-label'),
        role: h.getAttribute('role'),
        tabindex: h.getAttribute('tabindex'),
        controls: h.getAttribute('aria-controls'),
        min: h.getAttribute('aria-valuemin'),
        max: h.getAttribute('aria-valuemax'),
        orientation: h.getAttribute('aria-orientation'),
        share: layout === 'c' || !panelShown ? null : round(((layout === 'a' ? pr.height / wr.height : pr.width / wr.width)) * 100),
        css: ws.style.getPropertyValue('--view-size'),
        stored: { a: localStorage.getItem(${JSON.stringify(SPLIT_STORAGE.a)}), b: localStorage.getItem(${JSON.stringify(SPLIT_STORAGE.b)}) },
        focused: document.activeElement === h,
        readout: document.getElementById('split-readout').textContent,
        readoutShown: getComputedStyle(document.getElementById('split-readout')).visibility === 'visible',
        status: document.getElementById('split-status').textContent,
        dragging: ws.dataset.dragging === 'true',
        handleBox: { x: round(hr.x), y: round(hr.y), width: round(hr.width), height: round(hr.height) },
        workspaceBox: { x: round(wr.x), y: round(wr.y), width: round(wr.width), height: round(wr.height) },
        editorBox: { x: round(er.x), y: round(er.y), width: round(er.width), height: round(er.height) },
        panelBox: { x: round(pr.x), y: round(pr.y), width: round(pr.width), height: round(pr.height) },
        active: document.activeElement === null ? null : { id: document.activeElement.id, key: document.activeElement.dataset.key ?? null, group: document.activeElement.closest('#view-buttons') ? 'views' : document.activeElement.closest('#layout-buttons') ? 'layout' : null },
        historySelected: document.querySelector('#history-list .hist-row[data-selected="true"]')?.dataset.id ?? null,
      };
    })()`,
  );
}

/** Puts the page in `layout` with the view of key `digit` open: closes any open view first (a pressed key toggles), and
 * gives up focus so the view keys reach the page. With `digit` null only the layout changes and an open view stays open.
 * Leaves a quiet moment for the fade. */
async function setSplitState(cdp, layout, digit) {
  await evaluateExpr(cdp, `(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); return true; })()`);
  const open = await evaluateExpr(cdp, `document.getElementById('workspace').dataset.view`);
  if (digit !== null && open !== 'none') {
    await pressKey(cdp, 'Escape');
    await sleep(200);
  }
  await pressKey(cdp, layout);
  if (digit !== null) await pressKey(cdp, digit);
  await sleep(300);
}

/** Drags the handle with real mouse events: presses at its center, moves `delta` px along the main axis in `steps` moves
 * (negative grows the view: up in layout a, left in layout b) and releases. Returns the readings taken just before the release. */
async function dragSplitHandle(cdp, delta, { steps = 8, beforeRelease = null, onMove = null, settle = 120 } = {}) {
  const before = await readSplit(cdp);
  const horizontalLine = before.layout === 'a';
  const startX = before.handleBox.x + before.handleBox.width / 2;
  const startY = before.handleBox.y + before.handleBox.height / 2;
  const at = (distance) => (horizontalLine ? { x: startX, y: startY + distance } : { x: startX + distance, y: startY });
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', ...at(0), button: 'left', buttons: 1, clickCount: 1 });
  for (let step = 1; step <= steps; step += 1) {
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', ...at((delta * step) / steps), button: 'left', buttons: 1 });
    await sleep(30);
    if (onMove) await onMove(step);
  }
  const during = await readSplit(cdp);
  if (beforeRelease) await beforeRelease(during);
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', ...at(delta), button: 'left', buttons: 0, clickCount: 1 });
  if (settle > 0) await sleep(settle);
  return during;
}


/** Gives the handle focus the way a keyboard user would arrive (a script focus after key presses). */
function focusSplitHandle(cdp) {
  return evaluateExpr(cdp, `(() => { const h = document.getElementById('split-handle'); h.focus(); return document.activeElement === h; })()`);
}

/** Presses the keys of `steps` ([key, expected whole percent] pairs) on the focused handle and returns the problems: after each
 * key the aria value, the painted share and the stored number must name the expected size, and the handle keeps focus. */
async function walkSplitKeys(cdp, layout, steps) {
  const problems = [];
  const seen = [];
  for (const [key, expected] of steps) {
    await pressKey(cdp, key);
    await sleep(60);
    const r = await readSplit(cdp);
    seen.push(`${key}:${r.now}`);
    if (r.layout !== layout) problems.push(`${key}: layout is ${r.layout}`);
    if (r.now !== expected) problems.push(`${key}: value ${r.now}, expected ${expected}`);
    if (typeof r.share !== 'number' || Math.abs(r.share - expected) > 1) problems.push(`${key}: painted share ${r.share}, expected ${expected}`);
    if (Math.abs(Number(r.stored[layout]) - expected) > 0.01) problems.push(`${key}: stored ${r.stored[layout]}, expected ${expected}`);
    if (!r.focused) problems.push(`${key}: the handle lost focus`);
  }
  return { problems, seen };
}

/** Mouse click on the handle's center: `clickCount` presses and releases without moving. */
async function clickSplitHandle(cdp, { clicks = 1, moveToSamePoint = false } = {}) {
  const r = await readSplit(cdp);
  const x = r.handleBox.x + r.handleBox.width / 2;
  const y = r.handleBox.y + r.handleBox.height / 2;
  for (let count = 1; count <= clicks; count += 1) {
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: count });
    if (moveToSamePoint) await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 });
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: count });
  }
  await sleep(150);
}

/**
 * The separator against the live page. `context` is
 * { cdp, client, report, port, pageUrl }. It leaves the page in layout a with no view open and no stored size.
 */
async function splitBlocks(context) {
  const { cdp, client, report } = context;
  const near = (a, b, tolerance = 1) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= tolerance;
  const clearStored = () => evaluateExpr(cdp, `(() => { localStorage.removeItem(${JSON.stringify(SPLIT_STORAGE.a)}); localStorage.removeItem(${JSON.stringify(SPLIT_STORAGE.b)}); return true; })()`);

  await clearStored();
  await reloadPage(cdp);

  // Tracer: a drag resizes the view; aria-valuenow, the painted share and the stored value agree; a reload keeps it.
  {
    await setSplitState(cdp, 'a', '2');
    const a0 = await readSplit(cdp);
    await dragSplitHandle(cdp, -90);
    const a1 = await readSplit(cdp);
    await reloadPage(cdp);
    const a2 = await readSplit(cdp);
    await setSplitState(cdp, 'b', null);
    const b0 = await readSplit(cdp);
    await dragSplitHandle(cdp, -170);
    const b1 = await readSplit(cdp);
    await pressKey(cdp, 'a');
    await sleep(250);
    const a3 = await readSplit(cdp);
    await reloadPage(cdp);
    await pressKey(cdp, 'b');
    await sleep(250);
    const b2 = await readSplit(cdp);
    const wsWidth = b0.workspaceBox.width;
    const ok =
      a0.layout === 'a' && a0.view === 'timeline' && a0.handleShown && a0.now === 42 && near(a0.share, 42) && a0.stored.a === null &&
      a1.now > a0.now + 10 && near(a1.share, a1.now) && near(Number(a1.stored.a), a1.now) && a1.css === `${a1.stored.a}%` &&
      a2.now === a1.now && near(a2.share, a2.now) && a2.stored.a === a1.stored.a &&
      b0.layout === 'b' && b0.now === 45 && near(b0.share, 45) &&
      b1.now > b0.now + 10 && near(b1.share, b1.now) && near(Number(b1.stored.b), b1.now) && near(b1.now, 45 + (170 / wsWidth) * 100, 3) && b1.stored.a === a1.stored.a &&
      a3.layout === 'a' && a3.now === a1.now && near(a3.share, a3.now) &&
      b2.layout === 'b' && b2.now === b1.now && near(b2.share, b2.now) && b2.stored.b === b1.stored.b;
    report(
      'split: a drag resizes the view and the three readings agree, a reload keeps it, layout b keeps its own',
      ok,
      JSON.stringify({
        a: [a0.now, a0.share, a0.stored.a, '->', a1.now, a1.share, a1.stored.a, a1.css, 'reload', a2.now, a2.share],
        b: [b0.now, b0.share, '->', b1.now, b1.share, b1.stored.b, 'back to a', a3.now, 'reload, b again', b2.now, b2.share],
      }),
    );
  }

  // Keys per layout: Arrow, Page, Home and End on the focused handle, the size clamped to 15..85 at every step.
  {
    await setSplitState(cdp, 'a', null);
    const focusedA = await focusSplitHandle(cdp);
    const a = await walkSplitKeys(cdp, 'a', [
      ['Home', 15], ['End', 85], ['PageDown', 75], ['PageUp', 85], ['PageDown', 75], ['ArrowUp', 77], ['ArrowDown', 75], ['ArrowDown', 73],
      ['ArrowLeft', 73], ['ArrowRight', 73], ['End', 85], ['ArrowUp', 85], ['Home', 15], ['ArrowDown', 15],
    ]);
    const afterA = await readSplit(cdp);
    await pressKey(cdp, 'PageUp');
    await sleep(60);
    const readoutA = await readSplit(cdp);
    await evaluateExpr(cdp, `(() => { document.activeElement.blur(); return true; })()`);
    await setSplitState(cdp, 'b', null);
    const focusedB = await focusSplitHandle(cdp);
    const b = await walkSplitKeys(cdp, 'b', [
      ['Home', 15], ['ArrowLeft', 17], ['ArrowRight', 15], ['ArrowRight', 15], ['End', 85], ['ArrowLeft', 85], ['ArrowRight', 83],
      ['ArrowUp', 83], ['ArrowDown', 83], ['PageDown', 73], ['PageUp', 83],
    ]);
    const afterB = await readSplit(cdp);
    const problems = [...a.problems.map((p) => `a ${p}`), ...b.problems.map((p) => `b ${p}`)];
    const words =
      readoutA.readout === 'view 25% · kept for layout a' &&
      readoutA.status === 'View size 25 percent, kept for layout a.' &&
      readoutA.readoutShown === true &&
      readoutA.text === 'View 25 percent';
    report(
      'split: keys per layout, Page keys, Home and End, clamp at 15 and 85',
      focusedA && focusedB && problems.length === 0 && words && afterA.orientation === 'horizontal' && afterB.orientation === 'vertical',
      JSON.stringify({ problems, a: a.seen.join(' '), b: b.seen.join(' '), readout: [readoutA.readout, readoutA.status, readoutA.text, readoutA.readoutShown], orientations: [afterA.orientation, afterB.orientation] }),
    );
  }

  // Double-click resets to the default of the layout.
  {
    const results = {};
    for (const [layout, expected] of [['a', 42], ['b', 45]]) {
      await setSplitState(cdp, layout, null);
      await focusSplitHandle(cdp);
      await pressKey(cdp, 'Home');
      await sleep(60);
      const moved = await readSplit(cdp);
      await clickSplitHandle(cdp, { clicks: 2 });
      const reset = await readSplit(cdp);
      results[layout] = { moved: moved.now, now: reset.now, share: reset.share, stored: reset.stored[layout], readout: reset.readout, status: reset.status, focused: reset.focused };
    }
    const ok = [['a', 42], ['b', 45]].every(
      ([layout, expected]) =>
        results[layout].moved === 15 &&
        results[layout].now === expected &&
        near(results[layout].share, expected) &&
        results[layout].stored === String(expected) &&
        results[layout].readout === `view reset to ${expected}%` &&
        results[layout].status === `View size ${expected} percent, kept for layout ${layout}.` &&
        results[layout].focused === false,
    );
    report('split: double-click resets to 42 in layout a and 45 in layout b', ok, JSON.stringify(results));
  }

  // A click without movement leaves the border where it is; after a mouse drag the handle gives up focus, after a key it keeps it.
  {
    await setSplitState(cdp, 'a', null);
    await focusSplitHandle(cdp);
    await pressKey(cdp, 'Home');
    for (let i = 0; i < 4; i += 1) await pressKey(cdp, 'PageUp');
    await sleep(80);
    const set = await readSplit(cdp);
    await evaluateExpr(cdp, `(() => { document.activeElement.blur(); return true; })()`);
    await clickSplitHandle(cdp);
    const afterClick = await readSplit(cdp);
    await clickSplitHandle(cdp, { moveToSamePoint: true });
    const afterStill = await readSplit(cdp);
    await dragSplitHandle(cdp, -40);
    const afterDrag = await readSplit(cdp);
    const ok =
      set.now === 55 &&
      afterClick.now === 55 && afterClick.css === set.css && afterClick.stored.a === set.stored.a && afterClick.focused === false &&
      afterStill.now === 55 && afterStill.css === set.css && afterStill.stored.a === set.stored.a &&
      afterDrag.now > 55 && afterDrag.focused === false;
    report(
      'split: a click without movement does not move the border',
      ok,
      JSON.stringify({ set: [set.now, set.css, set.stored.a], click: [afterClick.now, afterClick.css, afterClick.stored.a, afterClick.focused], stillMove: [afterStill.now, afterStill.css, afterStill.stored.a], dragged: [afterDrag.now, afterDrag.focused] }),
    );
  }

  // Layout c has no handle; closing the view gives the editor the whole workspace; reopening brings back the kept size.
  {
    const kept = {};
    for (const layout of ['a', 'b']) {
      await setSplitState(cdp, layout, null);
      await focusSplitHandle(cdp);
      await pressKey(cdp, 'Home');
      await pressKey(cdp, 'PageUp');
      await pressKey(cdp, 'PageUp');
      await sleep(80);
      kept[layout] = await readSplit(cdp);
      await evaluateExpr(cdp, `(() => { document.activeElement.blur(); return true; })()`);
      await pressKey(cdp, '2');
      await sleep(400);
      kept[`${layout}Closed`] = await readSplit(cdp);
      await pressKey(cdp, '2');
      await sleep(300);
      kept[`${layout}Reopened`] = await readSplit(cdp);
    }
    await setSplitState(cdp, 'c', null);
    const c = await readSplit(cdp);
    const whole = (r) => Math.abs(r.editorBox.height - r.workspaceBox.height) <= 1 && Math.abs(r.editorBox.width - r.workspaceBox.width) <= 1;
    const problems = [];
    for (const layout of ['a', 'b']) {
      const first = kept[layout];
      const closed = kept[`${layout}Closed`];
      const reopened = kept[`${layout}Reopened`];
      if (first.now !== 35) problems.push(`${layout}: set ${first.now}`);
      if (closed.handleShown || closed.panelShown || !whole(closed)) problems.push(`${layout}: closed view leaves the handle ${closed.handleShown}, panel ${closed.panelShown}, editor ${JSON.stringify(closed.editorBox)} in ${JSON.stringify(closed.workspaceBox)}`);
      if (!reopened.handleShown || reopened.now !== 35 || !near(reopened.share, 35) || reopened.stored[layout] !== first.stored[layout]) problems.push(`${layout}: reopened at ${reopened.now} / ${reopened.share}`);
    }
    if (c.layout !== 'c' || c.handleShown || c.css !== '' || !c.panelShown) problems.push(`c: handle ${c.handleShown}, css "${c.css}", panel ${c.panelShown}`);
    if (Math.abs(c.panelBox.width - c.workspaceBox.width) > 1 || Math.abs(c.panelBox.height - c.workspaceBox.height) > 1) problems.push(`c: the view does not cover the code ${JSON.stringify(c.panelBox)} ${JSON.stringify(c.workspaceBox)}`);
    if (c.stored.a !== kept.a.stored.a || c.stored.b !== kept.b.stored.b) problems.push('c: a stored size changed');
    report(
      'split: layout c has no handle and a closed view gives the editor the whole workspace, reopening brings back the kept size',
      problems.length === 0,
      JSON.stringify({ problems, a: [kept.a.now, kept.aClosed.handleShown, kept.aClosed.editorBox.height, kept.aClosed.workspaceBox.height, kept.aReopened.now], b: [kept.b.now, kept.bClosed.handleShown, kept.bClosed.editorBox.width, kept.bClosed.workspaceBox.width, kept.bReopened.now], c: [c.handleShown, c.css, c.panelBox] }),
    );
  }

  // Focus: when the handle has it as its view closes, it moves to the button of the view just closed (or the layout pressed).
  {
    const results = [];
    await setSplitState(cdp, 'a', '2');
    await focusSplitHandle(cdp);
    await pressKey(cdp, '2');
    await sleep(300);
    results.push(['key 2', await readSplit(cdp)]);

    await setSplitState(cdp, 'a', '3');
    await focusSplitHandle(cdp);
    await pressKey(cdp, 'Escape');
    await sleep(300);
    results.push(['Esc', await readSplit(cdp)]);

    await setSplitState(cdp, 'a', '2');
    await focusSplitHandle(cdp);
    await pressKey(cdp, 'c');
    await sleep(300);
    results.push(['layout c', await readSplit(cdp)]);
    await pressKey(cdp, 'a');
    await sleep(200);
    const expected = [
      ['key 2', { group: 'views', key: '2' }],
      ['Esc', { group: 'views', key: '3' }],
      ['layout c', { group: 'layout', key: 'c' }],
    ];
    const problems = [];
    for (const [index, [label, want]] of expected.entries()) {
      const r = results[index][1];
      if (!r.active || r.active.group !== want.group || r.active.key !== want.key) problems.push(`${label}: focus is on ${JSON.stringify(r.active)}`);
      if (r.handleShown) problems.push(`${label}: the handle is still shown`);
    }
    report("split: focus moves to the closed view's button when the handle had it", problems.length === 0, JSON.stringify({ problems, active: results.map(([label, r]) => [label, r.active]) }));
  }

  // Letters, digits and Esc still reach the page handler on the focused handle.
  {
    await setSplitState(cdp, 'a', '2');
    await focusSplitHandle(cdp);
    const seen = [];
    for (const key of ['b', 'a', '3', '2']) {
      await pressKey(cdp, key);
      await sleep(250);
      const r = await readSplit(cdp);
      seen.push([key, r.layout, r.view, r.focused]);
    }
    await pressKey(cdp, 'Escape');
    await sleep(300);
    const closed = await readSplit(cdp);
    const ok =
      JSON.stringify(seen.map(([key, layout, view, focused]) => [key, layout, view, focused])) ===
        JSON.stringify([['b', 'b', 'timeline', true], ['a', 'a', 'timeline', true], ['3', 'a', 'mixer', true], ['2', 'a', 'timeline', true]]) &&
      closed.view === 'none' && closed.handleShown === false;
    report('split: letters, digits and Esc still work on the focused handle', ok, JSON.stringify({ seen, closed: [closed.view, closed.handleShown, closed.active] }));
  }

  // With History open the arrow keys on the focused handle act on the handle only: the History selection does not move.
  {
    const rows = () => evaluateExpr(cdp, `document.querySelectorAll('#history-list .hist-row').length`);
    await setSplitState(cdp, 'a', '1');
    let count = await rows();
    if (count < 2) {
      await callTool(client, 'set_code', { code: 'setcps(0.5)\nbar_probe: s("bd*2").gain(0)', label: 'probe split history' });
      count = await waitFor(cdp, `(() => { const n = document.querySelectorAll('#history-list .hist-row').length; return n >= 2 ? n : null; })()`, 8000);
    }
    await evaluateExpr(cdp, `(() => { document.activeElement.blur(); return true; })()`);
    await pressKey(cdp, 'ArrowDown');
    await sleep(150);
    const control = await readSplit(cdp);
    await focusSplitHandle(cdp);
    await pressKey(cdp, 'ArrowDown');
    await pressKey(cdp, 'ArrowUp');
    await pressKey(cdp, 'ArrowUp');
    await sleep(150);
    const onHandle = await readSplit(cdp);
    const ok = (count ?? 0) >= 2 && control.historySelected !== null && onHandle.historySelected === control.historySelected && onHandle.now === control.now + 2 && onHandle.focused === true;
    report(
      'split: with History open the arrow keys act on the handle only',
      ok,
      JSON.stringify({ rows: count, selectedWithBodyFocus: control.historySelected, selectedWithHandleFocus: onHandle.historySelected, size: [control.now, onHandle.now] }),
    );
    await evaluateExpr(cdp, `(() => { document.activeElement.blur(); return true; })()`);
    await pressKey(cdp, 'Escape');
    await sleep(300);
  }

  // A stored size that is not a number from 15 to 85 is ignored, with one console error per key naming it.
  {
    const recorderSource = `(() => { window.__splitErrors = []; const real = console.error; console.error = (...args) => { window.__splitErrors.push(args.map(String).join(' ')); return real.apply(console, args); }; })()`;
    const recorder = await cdp('Page.addScriptToEvaluateOnNewDocument', { source: recorderSource });
    let result;
    try {
      await evaluateExpr(cdp, `(() => { localStorage.setItem(${JSON.stringify(SPLIT_STORAGE.a)}, '90'); localStorage.setItem(${JSON.stringify(SPLIT_STORAGE.b)}, 'calc(1px)'); localStorage.setItem('moontide.layout', 'a'); localStorage.setItem('moontide.view', 'timeline'); return true; })()`);
      await reloadPage(cdp);
      const a = await readSplit(cdp);
      const errors = await evaluateExpr(cdp, `window.__splitErrors.filter((text) => text.includes('moontide.split'))`);
      await pressKey(cdp, 'b');
      await sleep(250);
      const b = await readSplit(cdp);
      result = { a, b, errors };
    } finally {
      await cdp('Page.removeScriptToEvaluateOnNewDocument', { identifier: recorder.identifier });
      await clearStored();
    }
    const { a, b, errors } = result;
    const ok =
      errors.length === 2 &&
      errors.filter((text) => text.includes(SPLIT_STORAGE.a)).length === 1 &&
      errors.filter((text) => text.includes(SPLIT_STORAGE.b)).length === 1 &&
      a.layout === 'a' && a.now === 42 && near(a.share, 42) && a.css === '42%' &&
      b.layout === 'b' && b.now === 45 && near(b.share, 45) && b.css === '45%';
    report('split: a bad stored size is ignored with one console error naming the key and the default is used', ok, JSON.stringify({ errors, a: [a.now, a.share, a.css], b: [b.now, b.share, b.css] }));
  }

  // I10: the three readings of the size (aria-valuenow, the painted share, the stored number) agree after a
  // drag, a key, a reload and a layout switch, within 1 point.
  {
    await clearStored();
    await reloadPage(cdp);
    await setSplitState(cdp, 'a', '2');
    const moments = [];
    const take = async (label) => {
      const r = await readSplit(cdp);
      const stored = r.stored[r.layout];
      const agree = stored !== null && near(r.now, r.share) && near(r.now, Number(stored)) && r.css === `${stored}%`;
      moments.push({ label, layout: r.layout, now: r.now, share: r.share, stored, css: r.css, agree });
    };
    await dragSplitHandle(cdp, -60);
    await take('a after a drag');
    await focusSplitHandle(cdp);
    await pressKey(cdp, 'PageDown');
    await sleep(80);
    await take('a after a key');
    await reloadPage(cdp);
    await take('a after a reload');
    await evaluateExpr(cdp, `(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); return true; })()`);
    await pressKey(cdp, 'b');
    await sleep(300);
    await dragSplitHandle(cdp, -90);
    await take('b after a drag');
    await pressKey(cdp, 'a');
    await sleep(300);
    await take('a after a layout switch');
    await pressKey(cdp, 'b');
    await sleep(300);
    await take('b after a layout switch');
    await reloadPage(cdp);
    await take('b after a reload');
    report(
      'split: the three readings agree after a drag, a key, a reload and a layout switch',
      moments.length === 7 && moments.every((m) => m.agree),
      JSON.stringify(moments.map((m) => [m.label, m.now, m.share, m.stored, m.css, m.agree])),
    );
  }

  // Leave the page as found: layout a, no view, no stored size.
  await clearStored();
  await reloadPage(cdp);
  await setSplitState(cdp, 'a', null);
  if ((await readSplit(cdp)).view !== 'none') {
    await pressKey(cdp, 'Escape');
    await sleep(300);
  }
}


/** CodeMirror's own measure of the editor against the DOM: layout a compares the height it measured (`viewState.editorHeight`)
 * with the scroller's `clientHeight`, layout b the width it measured (`viewState.contentDOMWidth`) with the content's box.
 * The editor object is the Strudel editor's view: `document.getElementById('repl').editor.editor` (an EditorView). */
function readCodeMirrorMeasure(cdp, layout) {
  return evaluateExpr(
    cdp,
    `(() => {
      const view = document.getElementById('repl').editor.editor;
      const measured = ${layout === 'a'} ? view.viewState.editorHeight : view.viewState.contentDOMWidth;
      const actual = ${layout === 'a'} ? view.scrollDOM.clientHeight : view.contentDOM.getBoundingClientRect().width;
      return { measured, actual, stale: Math.abs(measured - actual) };
    })()`,
  );
}

/** The Mixer's lit strip against its block of code: the light's rectangle and the rows of the label line. */
function readMixerLit(cdp, label) {
  return evaluateExpr(
    cdp,
    `(() => {
      const view = document.getElementById('repl').editor.editor;
      const doc = view.state.doc.toString();
      const lits = [...document.querySelectorAll('.mx-lit')];
      const at = doc.indexOf(${JSON.stringify(label)});
      const found = view.domAtPos(at);
      const node = found.node.nodeType === 3 ? found.node.parentElement : found.node;
      const line = node === null ? null : node.closest('.cm-line');
      const row = line === null ? null : line.getBoundingClientRect();
      const lit = lits.length === 0 ? null : lits[0].getBoundingClientRect();
      const box = view.scrollDOM.getBoundingClientRect();
      return {
        count: lits.length,
        lit: lit === null ? null : { top: lit.top, bottom: lit.bottom, left: lit.left, width: lit.width },
        row: row === null ? null : { top: row.top, bottom: row.bottom },
        scrollWidth: view.scrollDOM.scrollWidth,
        box: { top: box.top, bottom: box.bottom },
      };
    })()`,
  );
}

/**
 * The editor and its neighbors follow the border (invariant I10), in the real page:
 * a long piece (about 300 lines) in the editor, the Mixer open with a strip selected (its code flash on), a real drag in
 * layouts a and b, idle and playing. 250 ms after the release CodeMirror's own measure equals the DOM size (no manual
 * measure call exists in page/), and the Mixer's light still sits on its strip's block. Records how far CodeMirror lags
 * during the drag and how long it takes to be exact after the release. Leaves layout a, no view open, music playing.
 */
async function splitNeighborsBlocks(context) {
  const { cdp, client, report } = context;
  const near = (a, b, tolerance = 1) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= tolerance;
  const LONG_PROGRAM = [
    'setcps(0.5)',
    ...Array.from({ length: 300 }, (_, index) => `// filler line ${index + 1}`),
    'drums: s("bd*4").gain(0)',
    'hats: s("hh*8")',
    '  .fast(2)',
    '  .gain(0)',
  ].join('\n');
  await evaluateExpr(cdp, `(() => { localStorage.removeItem(${JSON.stringify(SPLIT_STORAGE.a)}); localStorage.removeItem(${JSON.stringify(SPLIT_STORAGE.b)}); return true; })()`);
  await reloadPage(cdp);

  // The Timeline's narrow-span flags (a section name that does not fit its span is hidden) are recomputed on release: a
  // span is as wide as the view panel in layout b, so a key to the smallest and to the largest size must flip them.
  {
    const SPAN_PROGRAM = [
      'const one = note("c4").s("sine").gain(0)',
      'const two = note("e4").s("square").gain(0)',
      'const three = note("g4").s("triangle").gain(0)',
      'main: arrange([2, one], [2, two], [2, three])',
    ].join('\n');
    await callTool(client, 'set_code', { code: SPAN_PROGRAM, label: 'probe split spans' });
    await setSplitState(cdp, 'b', '2');
    await waitFor(cdp, `document.getElementById('timeline-view').dataset.state === 'ok' && document.querySelector('#timeline-sections .section-span') ? true : null`, 8000);
    const readFlags = () =>
      evaluateExpr(
        cdp,
        `(() => {
          const spans = [...document.querySelectorAll('#timeline-sections .section-span')];
          // What the rule says for the size now, with each flag taken off while it is measured and put back after.
          const expected = spans.map((span) => {
            const had = span.dataset.narrow;
            delete span.dataset.narrow;
            const narrow = span.scrollWidth > span.clientWidth;
            if (had !== undefined) span.dataset.narrow = had;
            return narrow;
          });
          const actual = spans.map((span) => span.dataset.narrow === 'true');
          return { spans: spans.length, flagged: actual.filter(Boolean).length, expectedFlagged: expected.filter(Boolean).length, match: JSON.stringify(actual) === JSON.stringify(expected) };
        })()`,
      );
    await focusSplitHandle(cdp);
    const reads = {};
    for (const [key, name] of [['End', 'wide'], ['Home', 'narrow'], ['End', 'wide again']]) {
      await pressKey(cdp, key);
      await sleep(250);
      reads[name] = await readFlags();
    }
    const ok =
      reads.wide.spans >= 3 && reads.wide.match && reads.wide.flagged === 0 &&
      reads.narrow.match && reads.narrow.flagged === reads.narrow.spans &&
      reads['wide again'].match && reads['wide again'].flagged === 0;
    report("split: the Timeline's narrow-span flags are recomputed on release", ok, JSON.stringify(reads));
    await evaluateExpr(cdp, `(() => { document.activeElement.blur(); return true; })()`);
    await pressKey(cdp, 'Escape');
    await sleep(300);
  }

  await callTool(client, 'set_code', { code: LONG_PROGRAM, label: 'probe split editor' });
  await waitFor(
    cdp,
    `(() => document.querySelectorAll('#mixer-strips .mx-strip').length >= 0 && document.getElementById('repl').editor.repl.state.activeCode === ${JSON.stringify(LONG_PROGRAM)} && (${STATE_WORD_EXPR}) === ${JSON.stringify(SOUND_LABELS.playing)} ? true : null)()`,
    8000,
  );

  const rows = [];
  const states = [['playing', true], ['idle', false]];
  // Two setups. 'mixer' has the Mixer open with a strip selected (the light is the page's own overlay and its sync asks
  // CodeMirror to measure, which hides CodeMirror's own behavior); 'timeline' has no light at all, so CodeMirror's own
  // ResizeObserver is the only thing that can bring its measure up to date.
  const setups = [['mixer', '3'], ['timeline', '2']];
  try {
    for (const [stateName, playing] of states) {
      if (!playing) await stopMusic(cdp);
      for (const [setupName, digit] of setups) {
        for (const layout of ['a', 'b']) {
          await setSplitState(cdp, layout, null);
          const view = await evaluateExpr(cdp, `document.getElementById('workspace').dataset.view`);
          if (view !== setupName) {
            if (view !== 'none') await pressKey(cdp, 'Escape');
            await sleep(300);
            await pressKey(cdp, digit);
            await sleep(300);
          }
          if (setupName === 'mixer') {
            await waitFor(cdp, `document.querySelectorAll('#mixer-strips .mx-strip').length === 2 && document.getElementById('mixer-notice').hidden ? true : null`, 5000);
            const lit0 = await readMixerLit(cdp, 'drums:');
            if (lit0.count !== 1) {
              await clickElement(cdp, '#mixer-strips .mx-strip[data-track="label:drums"] .mx-name');
              await waitFor(cdp, `document.querySelectorAll('.mx-lit').length === 1 ? true : null`, 3000);
            }
          }
          // Start from a different size each time so the drag always changes it a lot.
          await focusSplitHandle(cdp);
          await pressKey(cdp, 'Home');
          await pressKey(cdp, 'PageUp');
          await pressKey(cdp, 'PageUp');
          await evaluateExpr(cdp, `(() => { document.activeElement.blur(); return true; })()`);
          await sleep(400);
          const before = await readSplit(cdp);
          const delta = layout === 'a' ? -(before.workspaceBox.height * 0.25) : -(before.workspaceBox.width * 0.15);
          let staleMax = 0;
          let litMid = null;
          const during = await dragSplitHandle(cdp, delta, {
            steps: 10,
            settle: 0,
            onMove: async (step) => {
              const m = await readCodeMirrorMeasure(cdp, layout);
              staleMax = Math.max(staleMax, m.stale);
              if (step === 6 && setupName === 'mixer') litMid = await readMixerLit(cdp, 'drums:');
            },
          });
          const releasedAt = Date.now();
          let convergedAfter = null;
          let m = await readCodeMirrorMeasure(cdp, layout);
          while (m.stale > 1 && Date.now() - releasedAt < 600) {
            await sleep(10);
            m = await readCodeMirrorMeasure(cdp, layout);
          }
          if (m.stale <= 1) convergedAfter = Date.now() - releasedAt;
          await sleep(Math.max(0, 250 - (Date.now() - releasedAt)));
          const after = await readSplit(cdp);
          const measure = await readCodeMirrorMeasure(cdp, layout);
          const lit = setupName === 'mixer' ? await readMixerLit(cdp, 'drums:') : null;
          rows.push({ stateName, setupName, layout, before: before.now, after: after.now, share: after.share, staleMax: Math.round(staleMax * 10) / 10, convergedAfter, final: measure, lit, litMid, duringShare: during.share });
        }
      }
    }
  } finally {
    if ((await readStateWord(cdp)) !== SOUND_LABELS.playing) await playMusic(cdp);
  }

  const problems = [];
  for (const row of rows) {
    const name = `${row.stateName} ${row.setupName} ${row.layout}`;
    if (!(row.after > row.before + 5)) problems.push(`${name}: the drag moved ${row.before} to ${row.after}`);
    if (!near(row.final.measured, row.final.actual)) problems.push(`${name}: CodeMirror measured ${row.final.measured}, the DOM is ${row.final.actual}`);
    if (row.convergedAfter === null) problems.push(`${name}: CodeMirror was not exact 600 ms after the release`);
  }
  report(
    'split: the editor measures itself 250 ms after a drag',
    rows.length === 8 && problems.length === 0,
    JSON.stringify({
      access: "document.getElementById('repl').editor.editor.viewState.editorHeight (layout a) / .contentDOMWidth (layout b) against view.scrollDOM.clientHeight / view.contentDOM.getBoundingClientRect().width",
      problems,
      rows: rows.map((row) => ({ state: row.stateName, view: row.setupName, layout: row.layout, size: `${row.before}->${row.after}`, share: row.share, maxStaleDuringDragPx: row.staleMax, exactAfterMs: row.convergedAfter, final: [row.final.measured, row.final.actual] })),
    }),
  );

  const litProblems = [];
  const mixerRows = rows.filter((row) => row.setupName === 'mixer');
  const sits = (litRead) =>
    litRead !== null && litRead.count === 1 && litRead.lit !== null && litRead.row !== null && near(litRead.lit.top, litRead.row.top) && near(litRead.lit.bottom, litRead.row.bottom, 2);
  for (const row of mixerRows) {
    const name = `${row.stateName} ${row.layout}`;
    if (!sits(row.lit)) litProblems.push(`${name}: after the drag ${JSON.stringify(row.lit)}`);
    if (!sits(row.litMid)) litProblems.push(`${name}: during the drag ${JSON.stringify(row.litMid)}`);
    // The light covers the whole width of the editor's content (its write takes the scroller's scroll width).
    if (row.lit !== null && row.lit.lit !== null && !near(row.lit.lit.width, row.lit.scrollWidth, 2)) litProblems.push(`${name}: the light is ${row.lit.lit.width} wide, the content ${row.lit.scrollWidth}`);
  }
  report(
    "split: the Mixer's lit strip still sits on its block after a drag",
    mixerRows.length === 4 && litProblems.length === 0,
    JSON.stringify({ litProblems, lit: mixerRows.map((row) => [row.stateName, row.layout, row.lit && row.lit.lit, row.lit && row.lit.row]) }),
  );

  // Cleanup: layout a, no view, no stored size, the quiet pattern of the bar blocks.
  await evaluateExpr(cdp, `(() => { localStorage.removeItem(${JSON.stringify(SPLIT_STORAGE.a)}); localStorage.removeItem(${JSON.stringify(SPLIT_STORAGE.b)}); return true; })()`);
  await reloadPage(cdp);
  await setSplitState(cdp, 'a', null);
  if ((await readSplit(cdp)).view !== 'none') {
    await pressKey(cdp, 'Escape');
    await sleep(300);
  }
  await callTool(client, 'set_code', { code: 'setcps(0.5)\nbar_probe: s("bd*4").gain(0)', label: 'probe bar invariants' });
  await waitFor(cdp, `(() => (${STATE_WORD_EXPR}) === ${JSON.stringify(SOUND_LABELS.playing)} ? true : null)()`, 8000);
}

/** Writes the PNG of what the page shows now into the screenshots folder. The name is built only from the fixed constants
 * of the matrix (never from page text) and joined to the folder that shotsFolder() validated. Returns the file name. */
async function saveShot(cdp, folder, state, width, height, layout) {
  const file = `bar-${state}-${width}x${height}-layout-${layout}.png`;
  const shot = await cdp('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(folder, file), Buffer.from(shot.data, 'base64'));
  return file;
}

/**
 * The screenshots lane, off unless MOONTIDE_PROBE_SHOTS names a folder outside the repository. `context`
 * is { cdp, client, report }. For each layout and state of the matrix in test/bar-inventory.js it opens the Timeline (so
 * every layout shows a view), sets the state up once, saves one picture per window size, and puts the state back. The
 * pages shown never open the Instruments view, which names the data folder. It leaves the page in layout a with no view
 * open, the music playing and the viewport override cleared.
 */
async function shotsBlocks(context) {
  const { cdp, client, report } = context;
  const folder = shotsFolder();
  if (folder === null) return;
  const BAR_CODE = 'setcps(0.5)\nbar_probe: s("bd*4").gain(0)';
  const playingWord = JSON.stringify(SOUND_LABELS.playing);
  const backToPlaying = async (label) => {
    await callTool(client, 'set_code', { code: BAR_CODE, label });
    const back = await waitFor(
      cdp,
      `(() => (${STATE_WORD_EXPR}) === ${playingWord} && document.getElementById('pending-change').hidden && document.querySelector('#tempo-readout .tempo-arrow').textContent === '' && document.getElementById('problem-banner').hidden ? true : null)()`,
      10000,
    );
    if (back !== true) throw new Error(`shots: the page did not return to the quiet playing pattern after ${label}`);
  };
  const jsString = (text) => `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;
  const failMessage = ['A'.repeat(200), 'second', 'third', 'fourth', 'fifth', 'sixth'].join('\n');
  let worstSaved = null;
  // enter() sets a state up in the layout just chosen; leave() puts it back; ready() runs before each picture (the window size just changed).
  const STATES = {
    stopped: { enter: () => stopMusic(cdp), leave: () => playMusic(cdp) },
    playing: {},
    waiting: {
      // A timed change with a new tempo, so far away (64 cycles) that it cannot land while the pictures are taken.
      enter: async () => {
        await callTool(client, 'set_code', { code: 'setcps(0.75)\nbar_probe: s("bd*4").gain(0)', label: 'probe shots waiting', at: 'phrase', phraseCycles: 64 });
        const waiting = await waitFor(cdp, `document.querySelector('#tempo-readout .tempo-arrow').textContent !== '' && !document.getElementById('pending-change').hidden ? true : null`, 6000);
        if (waiting !== true) throw new Error('shots: the waiting change never showed its arrow and countdown');
      },
      leave: () => backToPlaying('probe shots waiting reset'),
    },
    failed: {
      // A failed hand evaluation whose message has six lines, the first 200 characters long; Details open.
      enter: async () => {
        await evaluateExpr(cdp, `(() => { document.getElementById('repl').editor.setCode(${JSON.stringify(`(() => { throw new Error(${jsString(failMessage)}); })()`)}); return true; })()`);
        await pressCtrl(cdp, 'Enter', 'Enter', 13);
        await waitBanner(cdp, 'shots: a failed change');
        await clickElement(cdp, '#problem-details-toggle');
        const open = await evaluateExpr(cdp, `!document.getElementById('problem-details').hidden`);
        if (open !== true) throw new Error('shots: Details did not open');
      },
      leave: async () => {
        await clickElement(cdp, '#problem-dismiss');
        await waitBanner(cdp, 'shots: dismiss', { shown: false });
        await backToPlaying('probe shots failed reset');
      },
    },
    drawer: { enter: () => openDrawer(cdp), leave: () => closeDrawer(cdp) },
    worst: {
      enter: async () => {
        worstSaved = await setWorstCase(cdp);
      },
      leave: async () => {
        await restoreWorstCase(cdp, worstSaved);
        worstSaved = null;
      },
    },
    'worst-drawer': {
      enter: async () => {
        worstSaved = await setWorstCase(cdp);
        await openDrawer(cdp);
      },
      leave: async () => {
        await restoreWorstCase(cdp, worstSaved);
        worstSaved = null;
        await closeDrawer(cdp);
      },
    },
    split: {
      // The border focused from the keyboard so its readout shows; one step out and back keeps the size where it was.
      enter: async () => {
        const layout = await evaluateExpr(cdp, `document.getElementById('workspace').dataset.layout`);
        const [out, back] = layout === 'a' ? ['ArrowUp', 'ArrowDown'] : ['ArrowLeft', 'ArrowRight'];
        if ((await focusSplitHandle(cdp)) !== true) throw new Error('shots: the border could not be focused');
        await pressKey(cdp, out);
        await pressKey(cdp, back);
      },
      ready: async () => {
        if ((await focusSplitHandle(cdp)) !== true) throw new Error('shots: the border lost focus');
        const readout = await evaluateExpr(cdp, `(() => { const r = document.getElementById('split-readout'); return { text: r.textContent, shown: getComputedStyle(r).visibility === 'visible' }; })()`);
        if (readout.text === '' || readout.shown !== true) throw new Error(`shots: the border's readout is not showing ${JSON.stringify(readout)}`);
      },
    },
  };
  const missing = SHOT_STATES.filter((state) => STATES[state] === undefined);
  if (missing.length > 0 || Object.keys(STATES).length !== SHOT_STATES.length) throw new Error(`shots: the states of the matrix and of the probe differ (${missing.join(', ')})`);

  const written = [];
  try {
    for (const layout of SHOT_LAYOUTS) {
      for (const state of SHOT_STATES) {
        if (SHOT_SKIPPED.some((skip) => skip.state === state && skip.layout === layout)) continue;
        const setup = STATES[state];
        await setSplitState(cdp, layout, '2');
        try {
          await setup.enter?.();
          for (const [width, height] of SHOT_SIZES) {
            await cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
            await sleep(450);
            await setup.ready?.();
            written.push(await saveShot(cdp, folder, state, width, height, layout));
          }
        } catch (err) {
          // A state that failed halfway is put back where it can be, then the error goes on.
          await cdp('Emulation.clearDeviceMetricsOverride').catch(() => {});
          await setup.leave?.().catch(() => {});
          throw err;
        }
        await cdp('Emulation.clearDeviceMetricsOverride');
        await sleep(300);
        await setup.leave?.();
      }
    }
  } finally {
    await cdp('Emulation.clearDeviceMetricsOverride');
    await evaluateExpr(cdp, `(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); return true; })()`);
    if ((await evaluateExpr(cdp, `document.getElementById('workspace').dataset.view`)) !== 'none') {
      await pressKey(cdp, 'Escape');
      await sleep(300);
    }
    await pressKey(cdp, 'a');
    await sleep(300);
  }

  const expected = shotFileNames();
  const problems = [];
  for (const name of expected) {
    const file = path.join(folder, name);
    if (!fs.existsSync(file)) {
      problems.push(`${name} is missing`);
      continue;
    }
    const bytes = fs.readFileSync(file);
    if (bytes.subarray(0, 4).toString('hex') !== '89504e47') problems.push(`${name} is not a PNG`);
    else if (bytes.length <= 5000) problems.push(`${name} is only ${bytes.length} bytes`);
  }
  report(
    'shots: screenshots are saved outside the repository',
    problems.length === 0 && written.length === expected.length && path.relative(REPO_ROOT, folder).startsWith('..'),
    JSON.stringify({ folder, written: written.length, expected: expected.length, problems: problems.slice(0, 5) }),
  );
  report(
    `shots: ${written.length} screenshots saved`,
    written.length === expected.length && JSON.stringify(written) === JSON.stringify(expected),
    JSON.stringify({ folder, states: SHOT_STATES, sizes: SHOT_SIZES, layouts: SHOT_LAYOUTS }),
  );
  console.log(`probe:page screenshots saved in ${folder}`);
}

/**
 * The top bar's contracts against the live page, written before the
 * restyle and kept green through it. `context` is { cdp, client, report, port, pageUrl }. It leaves the page as it
 * found it: the viewport override cleared, a playing quiet pattern set with set_code. The static half of those
 * invariants runs in test/bar-static.test.js.
 */
export async function barBlocks(context) {
  const { cdp, client, report } = context;
  const playingWord = JSON.stringify(SOUND_LABELS.playing);
  const BAR_CODE = 'setcps(0.5)\nbar_probe: s("bd*4").gain(0)';
  await cdp('Emulation.clearDeviceMetricsOverride');
  await callTool(client, 'set_code', { code: BAR_CODE, label: 'probe bar invariants' });
  const started = await waitFor(cdp, `(() => (${STATE_WORD_EXPR}) === ${playingWord} ? true : null)()`, 8000);
  if (started !== true) throw new Error(`barBlocks: the state word is ${JSON.stringify(await readStateWord(cdp))} after set_code, not "Playing"`);

  // I1: every id of the inventory exists once; the ones shown are whole and on one line, at 1920 and at 1366.
  {
    const ids = BAR_INVENTORY.map((entry) => entry.id);
    const measure = () =>
      evaluateExpr(
        cdp,
        `((ids) => ids.map((id) => {
          const matches = document.querySelectorAll('#' + id);
          const el = matches[0] ?? null;
          const shown = el !== null && !el.hidden && el.getClientRects().length > 0;
          const line = el === null ? 0 : parseFloat(getComputedStyle(el).lineHeight);
          return {
            id,
            count: matches.length,
            shown,
            whole: !shown || el.scrollWidth <= el.clientWidth,
            oneLine: !shown || el.offsetHeight < line * 1.5,
          };
        }))(${JSON.stringify(ids)})`,
      );
    const [at1920, at1366] = await atWidths(cdp, [1920, 1366], measure);
    const problems = [];
    for (const [width, items] of [[1920, at1920], [1366, at1366]]) {
      for (const item of items) {
        if (item.count !== 1) problems.push(`${width}: #${item.id} exists ${item.count} times`);
        else if (item.shown && !item.whole) problems.push(`${width}: #${item.id} is clipped`);
        else if (item.shown && !item.oneLine) problems.push(`${width}: #${item.id} wraps`);
      }
    }
    const shownAt1920 = at1920.filter((item) => item.shown).length;
    report(
      'bar invariants I1: every inventory id exists once and is reachable',
      problems.length === 0 && at1920.length === ids.length && shownAt1920 >= 6,
      JSON.stringify({ ids: ids.length, shownAt1920, shownAt1366: at1366.filter((item) => item.shown).length, problems }),
    );
  }

  // I3 and I4 share one Stop and Play cycle: the state word is true, and the accent color means live now.
  {
    const read = () =>
      evaluateExpr(
        cdp,
        `(() => {
          const word = ${STATE_WORD_EXPR};
          const tempo = document.getElementById('tempo-readout');
          const resolve = (name) => {
            const el = document.createElement('span');
            el.style.color = 'var(' + name + ')';
            document.body.appendChild(el);
            const color = getComputedStyle(el).color;
            el.remove();
            return color;
          };
          const accent = resolve('--accent');
          const exempt = ${JSON.stringify([...ACCENT_EXEMPT_TODAY])};
          const bar = document.getElementById('chrome');
          const live = [];
          const exempted = [];
          const stray = [];
          for (const el of [bar, ...bar.querySelectorAll('*')]) {
            const style = getComputedStyle(el);
            const colors = [style.color, style.backgroundColor];
            for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
              if (style['border' + side + 'Style'] !== 'none' && parseFloat(style['border' + side + 'Width']) > 0) colors.push(style['border' + side + 'Color']);
            }
            if (!colors.includes(accent)) continue;
            const name = el.id !== '' ? '#' + el.id : el.tagName.toLowerCase() + (typeof el.className === 'string' && el.className !== '' ? '.' + el.className.split(' ').join('.') : '');
            if (el.closest('#sound-state') !== null) live.push(name);
            else if (exempt.includes(el.id)) exempted.push(name);
            else stray.push(name);
          }
          return { word, tempoShown: !tempo.hidden && tempo.getClientRects().length > 0, tempoText: tempo.innerText.trim(), accent, live, exempted, stray };
        })()`,
      );
    const settle = async (wantPlaying) => {
      // The tempo readout follows the music on its own poll, so wait until it agrees with the word: a number while the
      // music plays, the dash while it does not. The readout itself is displayed in both.
      await waitFor(
        cdp,
        `(() => { const t = document.getElementById('tempo-readout'); const idle = t.innerText.trim() === ${JSON.stringify(tempoText({ playing: false }).text)}; return idle === ${wantPlaying ? 'false' : 'true'} ? true : null; })()`,
        5000,
      );
      return read();
    };
    const idleTempo = tempoText({ playing: false });
    const playing = await settle(true);
    await stopMusic(cdp);
    const stopped = await settle(false);
    await playMusic(cdp);
    const again = await settle(true);

    report(
      'bar invariants I3: the state word is true across Stop and Play',
      playing.word === SOUND_LABELS.playing &&
        playing.tempoShown === true &&
        playing.tempoText !== idleTempo.text &&
        stopped.word === SOUND_LABELS.stopped &&
        stopped.word !== SOUND_LABELS.playing &&
        stopped.tempoShown === true &&
        stopped.tempoText === idleTempo.text &&
        again.word === SOUND_LABELS.playing &&
        again.tempoShown === true &&
        again.tempoText !== idleTempo.text,
      JSON.stringify({ playing: [playing.word, playing.tempoShown, playing.tempoText], stopped: [stopped.word, stopped.tempoShown, stopped.tempoText], again: [again.word, again.tempoShown, again.tempoText] }),
    );

    const liveOk = (state) => state.live.some((name) => name.includes('state-label')) && state.live.some((name) => name.includes('state-dot'));
    report(
      'bar invariants I4: the accent color is on the live state and nowhere else in the bar, the strip and the drawer',
      playing.stray.length === 0 &&
        liveOk(playing) &&
        stopped.stray.length === 0 &&
        stopped.live.length === 0 &&
        again.stray.length === 0 &&
        liveOk(again),
      JSON.stringify({
        accent: playing.accent,
        playing: { live: playing.live, exempt: playing.exempted, stray: playing.stray },
        stopped: { live: stopped.live, exempt: stopped.exempted, stray: stopped.stray },
      }),
    );
  }

  // I7: the fit step is a function of the width: the same state at the same width gives the same step.
  {
    const [first, narrow, last] = await atWidths(cdp, [1920, 1024, 1920], () =>
      evaluateExpr(cdp, `document.getElementById('top-bar').dataset.fit ?? null`),
    );
    report(
      'bar invariants I7: the fit step is a function of the width (1920, 1024, 1920)',
      first !== null && last === first && Number(narrow) >= Number(first),
      JSON.stringify({ at1920: first, at1024: narrow, again1920: last }),
    );
  }

  await transportBlocks(context);
  await tempoBlocks(context);
  await bannerBlocks(context);
  await drawerBlocks(context);
  await controlsBlocks(context);
  await infoButtonsBlocks(context);
  await editsTimingBlocks(context);
  await sizesBlocks(context);
  await fitBlocks(context);
  await worstCaseBlocks(context);
  await splitBlocks(context);
  await splitNeighborsBlocks(context);
  await shotsBlocks(context);

  // The helpers the other bar blocks use, each proven once.
  {
    const width = () => evaluateExpr(cdp, 'window.innerWidth');
    const before = await width();
    const seen = await atWidths(cdp, [1280, 1920, 1024], width);
    const after = await width();
    let thrown = false;
    try {
      await atWidths(cdp, [1366], () => {
        throw new Error('probe: a check that fails inside atWidths');
      });
    } catch {
      thrown = true;
    }
    const afterThrow = await width();
    report(
      'bar helpers: atWidths sets each width and clears the override',
      JSON.stringify(seen) === JSON.stringify([1280, 1920, 1024]) && after === before && thrown === true && afterThrow === before,
      JSON.stringify({ requested: [1280, 1920, 1024], seen, before, after, afterThrow }),
    );
  }

  {
    const snapshot = () =>
      // The cycle and beat is live decoration (it moves with the music), so it is left out of the comparison: its own tag and
      // its text inside the ancestors.
      evaluateExpr(cdp, `(() => { const bar = document.getElementById('chrome'); const cycle = document.getElementById('cycle-beat'); const live = cycle.textContent; return [bar, ...bar.querySelectorAll('*')].map((el) => el === cycle ? 'cycle-beat' : el.outerHTML.slice(0, el.outerHTML.indexOf('>') + 1) + '|' + (live === '' ? el.textContent : el.textContent.replace(live, '')) + '|' + el.hidden); })()`);
    const before = await snapshot();
    const saved = await setWorstCase(cdp);
    await sleep(300);
    const during = await evaluateExpr(
      cdp,
      `(() => {
        const get = (selector) => document.querySelector(selector);
        const shown = (selector) => !get(selector).hidden;
        return {
          ask: get('#ask-status .ask-long').textContent,
          build: get('#build-mismatch').textContent,
          version: get('#version-indicator').textContent,
          requests: get('#page-requests-state').textContent,
          midi: get('#midi-state-text').textContent,
          dots: get('#midi-dots').children.length,
          tempo: get('#tempo-readout').textContent,
          pending: get('#pending-change').textContent,
          allShown: ['#ask-status', '#build-mismatch', '#version-indicator', '#page-requests', '#midi-state', '#tempo-readout', '#pending-change'].every(shown),
        };
      })()`,
    );
    await restoreWorstCase(cdp, saved);
    // The fit step follows the content by itself (a ResizeObserver), so give it a beat before comparing.
    await sleep(400);
    const after = await snapshot();
    const differing = before.map((line, index) => (line === after[index] ? null : { before: line, after: after[index] })).filter((entry) => entry !== null);
    report(
      'bar helpers: the worst-case fixture sets and restores the page',
      during.ask === WORST_CASE.askStatus &&
        during.build === WORST_CASE.build &&
        during.version === WORST_CASE.version &&
        during.requests === WORST_CASE.pageRequests &&
        during.midi === WORST_CASE.midiAttention &&
        during.dots === 6 &&
        during.tempo === WORST_CASE.tempo &&
        during.pending === WORST_CASE.pending &&
        during.allShown === true &&
        before.length === after.length &&
        differing.length === 0,
      JSON.stringify({ during, elements: before.length, differing: differing.slice(0, 3) }),
    );
  }

  {
    const spy = await spyClipboard(cdp);
    let written;
    try {
      await evaluateExpr(cdp, `navigator.clipboard.writeText('spy text one')`);
      written = await spy.texts();
    } finally {
      await spy.restore();
    }
    const rejecting = await spyClipboard(cdp, { reject: true });
    let outcome;
    let rejectedTexts;
    try {
      outcome = await evaluateExpr(cdp, `navigator.clipboard.writeText('spy text two').then(() => 'resolved', (error) => error.name)`);
      rejectedTexts = await rejecting.texts();
    } finally {
      await rejecting.restore();
    }
    const restored = await evaluateExpr(cdp, `Object.hasOwn(navigator.clipboard, 'writeText') === false && window.__moontideClipboardTexts === undefined`);
    report(
      'bar helpers: the clipboard spy sees a written text and a rejection',
      JSON.stringify(written) === JSON.stringify(['spy text one']) &&
        outcome === 'NotAllowedError' &&
        JSON.stringify(rejectedTexts) === JSON.stringify(['spy text two']) &&
        restored === true,
      JSON.stringify({ written, outcome, rejectedTexts, restored }),
    );
  }

  await cdp('Emulation.clearDeviceMetricsOverride');
  await callTool(client, 'set_code', { code: 'setcps(0.5)', label: 'probe bar invariants reset' });
}

/**
 * The harmony declaration against the live page. `context` is
 * { cdp, client, report, port, pageUrl }, the same object barBlocks gets. The spike (H1 to H5) proves that a top-level
 * `const harmony = ...` line plays nothing and adds no Mixer strip, no Timeline lane and no Parts row, that the labeled
 * form does become a track (why it was rejected), that a const alone or last is refused by the engine, and that a track
 * may read the constant. Then the Jam checks J1 to J7: the Declared line and the Heard label next to the heard
 * scale, and no 'No clear scale' anywhere when a harmony is declared. It leaves the page as it found it: no view open,
 * layout a, the viewport override cleared, a quiet pattern left playing through set_code.
 */
export async function harmonyBlocks(context) {
  const { cdp, client, report } = context;
  const playingWord = JSON.stringify(SOUND_LABELS.playing);
  const QUIET = 'setcps(0.5)\nharmony_probe: s("bd*4").gain(0)';
  const BASELINE = 'lead: note("d3 f3 a3").gain(0)';
  const STACK = 'stack(note("d3 f3 a3").gain(0), s("hh*4").gain(0))';
  const HARMONY_VALUES = ["'D4:dorian'", '"<Dm7 G7 C^7>"', 'chord("<Dm7 G7>")'];
  await cdp('Emulation.clearDeviceMetricsOverride');
  const viewOpen = () => evaluateExpr(cdp, `!document.getElementById('view-panel').hidden`);
  // Closes whatever view is open: the editor gives up focus first so the view keys and Escape reach the page.
  const closeViews = async () => {
    await evaluateExpr(cdp, `(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); })()`);
    if (await viewOpen()) await pressKey(cdp, 'Escape');
    await waitFor(cdp, `document.getElementById('view-panel').hidden ? true : null`, 3000);
  };
  const openView = async (digit) => {
    await closeViews();
    await pressKey(cdp, digit);
    await waitFor(cdp, `document.getElementById('view-panel').hidden ? null : true`, 3000);
  };
  const started = async (code) => {
    const found = await waitFor(
      cdp,
      `(() => document.getElementById('repl').editor.repl.state.activeCode === ${JSON.stringify(code)} && (${STATE_WORD_EXPR}) === ${playingWord} ? true : null)()`,
      8000,
    );
    if (found !== true) throw new Error(`harmonyBlocks: the page does not play the program just sent (state word ${JSON.stringify(await readStateWord(cdp))})`);
  };
  // Sends one program and reads what the page makes of it: the reply, the strips, the lanes with their event counts,
  // the Parts message and the state word. Every view is opened fresh, so each read is of the code that plays now.
  const record = async (code, label) => {
    const reply = await callTool(client, 'set_code', { code, label });
    await started(code);
    await openView('3');
    await sleep(300);
    const strips = await evaluateExpr(cdp, `[...document.querySelectorAll('#mixer-strips .mx-strip')].map((el) => el.dataset.track)`);
    await openView('2');
    await waitFor(cdp, `(() => { const s = document.getElementById('timeline-view').dataset.state; return s && s !== 'computing' ? s : null; })()`, 5000);
    const lanes = await evaluateExpr(
      cdp,
      `[...document.querySelectorAll('#timeline-lanes .lane')].map((l) => ({ track: l.dataset.track, events: Number(l.dataset.events) }))`,
    );
    await openView('4');
    await sleep(200);
    const parts = await evaluateExpr(cdp, `document.getElementById('parts-message').textContent`);
    await closeViews();
    const state = await readStateWord(cdp);
    return { reply, strips, lanes, parts, state };
  };
  const shape = (rec) => JSON.stringify({ strips: rec.strips, lanes: rec.lanes, parts: rec.parts, state: rec.state });
  const refused = async (code, label) => {
    try {
      await callTool(client, 'set_code', { code, label });
      return null;
    } catch (err) {
      // The first paragraph only: the rest of an error reply is the shared page-requests hint, which names a local path.
      return (err instanceof Error ? err.message : String(err)).split('\n\n')[0];
    }
  };
  const ENGINE_REFUSAL = 'unexpected ast format without body expression';

  const base = await record(BASELINE, 'probe harmony baseline');
  // H1: the line above a labeled track changes nothing the page shows.
  {
    const results = [];
    for (const value of HARMONY_VALUES) {
      const rec = await record(`const harmony = ${value}\n${BASELINE}`, 'probe harmony line');
      results.push({ value, same: shape(rec) === shape(base), playing: /playing/i.test(rec.reply) && !rec.reply.includes('Evaluation failed') });
    }
    report(
      'harmony spike H1: a const harmony line adds no strip, lane or part',
      base.strips.length === 1 &&
        base.lanes.length === 1 &&
        base.lanes[0].events > 0 &&
        /playing/i.test(base.reply) &&
        results.every((r) => r.same && r.playing),
      JSON.stringify({ base: JSON.parse(shape(base)), results }),
    );
  }
  // H2: an unlabeled stack keeps exactly its branches.
  {
    const plain = await record(STACK, 'probe harmony stack');
    const withLine = await record(`const harmony = 'D4:dorian'\n${STACK}`, 'probe harmony stack line');
    report(
      'harmony spike H2: an unlabeled stack keeps its branches with the line above it',
      plain.lanes.length === 2 && shape(plain) === shape(withLine),
      JSON.stringify({ plain: JSON.parse(shape(plain)), withLine: JSON.parse(shape(withLine)) }),
    );
  }
  // H3: the labeled form is a track, a strip and a lane.
  {
    const rec = await record(`harmony: note("c3 e3").gain(0)\n${BASELINE}`, 'probe harmony labeled');
    const wanted = ['label:harmony', 'label:lead'];
    report(
      'harmony spike H3: the labeled form is a track, a strip and a lane (why it was rejected)',
      JSON.stringify(rec.strips) === JSON.stringify(wanted) && JSON.stringify(rec.lanes.map((l) => l.track)) === JSON.stringify(wanted),
      JSON.stringify({ strips: rec.strips, lanes: rec.lanes.map((l) => l.track) }),
    );
  }
  // H4: a const alone or last is refused by the engine and the music that played stays.
  {
    await record(BASELINE, 'probe harmony baseline again');
    const alone = await refused("const harmony = 'D4:dorian'", 'probe harmony alone');
    const last = await refused(`${BASELINE}\nconst harmony = 'D4:dorian'`, 'probe harmony last');
    const after = await record(BASELINE, 'probe harmony after refusals');
    report(
      'harmony spike H4: a const alone or last is refused and nothing new plays',
      alone !== null && alone.includes(ENGINE_REFUSAL) && last !== null && last.includes(ENGINE_REFUSAL) && shape(after) === shape(base),
      JSON.stringify({ alone, last, same: shape(after) === shape(base) }),
    );
  }
  // H5: a track that reads the constant plays.
  {
    const rec = await record(`const harmony = 'C:major'\nlead: n("0 2 4").scale(harmony).s("triangle").gain(0)`, 'probe harmony read');
    report(
      'harmony spike H5: a track that reads the constant plays',
      rec.strips.length === 1 && rec.lanes.length === 1 && rec.lanes[0].track === 'label:lead' && rec.lanes[0].events > 0,
      JSON.stringify({ strips: rec.strips, lanes: rec.lanes }),
    );
  }

  // --- Jam: the declared harmony next to the heard one (J1 to J7) ---
  {
    const TIE_PADS = 'pads: note("<[a3,c4,e4] [f3,a3,c4] [c4,e4,g4] [g3,b3,d4]>").gain(0)';
    const C_MAJOR = 'lead: n("0 1 2 3 4 5 6 7").scale("C:major").gain(0)';
    const DRUMS = 'drums: s("bd*4").gain(0)';
    const blur = () => evaluateExpr(cdp, `(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); })()`);
    const press = async (key) => {
      await blur();
      await pressKey(cdp, key);
      await sleep(250);
    };
    // Everything the checks read from the Jam view in one object.
    const FACTS = `(() => {
      const el = (id) => document.getElementById(id);
      const view = el('jam-view');
      const texts = [view.textContent];
      for (const node of view.querySelectorAll('*')) {
        texts.push(node.getAttribute('title') || '', node.getAttribute('aria-label') || '');
      }
      return {
        state: view.dataset.state,
        bodyHidden: el('jam-body').hidden,
        messageHidden: el('jam-message').hidden,
        declaredHidden: el('jam-declared').hidden,
        labelHidden: el('jam-scale-label').hidden,
        declaredLabel: el('jam-declared-label').textContent,
        declaredValue: el('jam-declared-value').textContent,
        declaredKind: el('jam-declared').dataset.kind || null,
        declaredTitle: el('jam-declared-value').title,
        declaredChildren: el('jam-declared-value').children.length,
        heardLabel: el('jam-scale-label').textContent,
        name: el('jam-scale-name').textContent,
        kind: el('jam-scale-name').dataset.kind || null,
        sub: el('jam-scale-sub').textContent,
        piano: el('jam-piano').getAttribute('aria-label'),
        guitar: el('jam-guitar').getAttribute('aria-label'),
        verdict: texts.some((text) => /no clear scale/i.test(text)),
      };
    })()`;
    const jamFacts = () => evaluateExpr(cdp, FACTS);
    // Sends a program with the Jam view open and waits for the facts to satisfy `predicate` (an expression over f).
    const jamWith = async (code, label, predicate) => {
      await callTool(client, 'set_code', { code, label });
      await started(code);
      return waitFor(cdp, `(() => { const f = ${FACTS}; return (${predicate}) ? f : null; })()`, 8000);
    };
    const colors = async () =>
      evaluateExpr(
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
          const style = (id) => getComputedStyle(document.getElementById(id)).color;
          return {
            text: resolve('--text'),
            muted: resolve('--text-muted'),
            reserved: ['--accent', '--destructive', '--jam-avoid', '--jam-outside'].map(resolve),
            value: style('jam-declared-value'),
            declaredLabel: style('jam-declared-label'),
            heardLabel: style('jam-scale-label'),
            adjacent: document.getElementById('jam-declared').nextElementSibling === document.getElementById('jam-scale'),
          };
        })()`,
      );
    const tieSentence = (f) => f.name.startsWith('The notes fit ') && f.name.endsWith(' equally.');
    const brief = (f) => (f === null ? null : { ...f, piano: undefined, guitar: undefined });

    await closeViews();
    await callTool(client, 'set_code', { code: QUIET, label: 'probe harmony jam start' });
    await openView('5');

    // J1: without a declaration nothing of the two lines shows; a declaration shows them; removing it hides them again.
    {
      const first = await jamWith(TIE_PADS, 'probe harmony jam tie', `f.state === 'ready' && f.kind === 'ambiguous' && f.name.startsWith('No clear scale')`);
      const declared = await jamWith(`const harmony = 'C:major'\n${TIE_PADS}`, 'probe harmony jam tie declared', `f.state === 'ready' && f.declaredHidden === false && f.kind === 'ambiguous'`);
      const again = await jamWith(TIE_PADS, 'probe harmony jam tie again', `f.state === 'ready' && f.kind === 'ambiguous' && f.declaredHidden === true`);
      report(
        'harmony jam J1: without a declaration the Declared line and the Heard label are hidden and the tie sentence is unchanged',
        first !== null &&
          first.declaredHidden === true &&
          first.labelHidden === true &&
          first.name.startsWith('No clear scale: the notes fit ') &&
          first.name.endsWith(' equally.') &&
          first.piano.endsWith('No clear scale.') &&
          declared !== null &&
          declared.labelHidden === false &&
          again !== null &&
          again.declaredHidden === true &&
          again.labelHidden === true &&
          again.name === first.name &&
          again.piano === first.piano,
        JSON.stringify({ first: brief(first), declaredShown: declared !== null && declared.declaredHidden === false, again: brief(again) }),
      );
    }

    // J2: a declared tie shows two lines and the words No clear scale are nowhere.
    {
      const f = await jamWith(`const harmony = 'C:major'\n${TIE_PADS}`, 'probe harmony jam tie declared', `f.state === 'ready' && f.declaredHidden === false && f.kind === 'ambiguous'`);
      report(
        'harmony jam J2: a declared scale shows two lines, and a tie drops the words No clear scale everywhere',
        f !== null &&
          f.declaredLabel === 'Declared:' &&
          f.declaredValue === 'C major' &&
          f.labelHidden === false &&
          f.heardLabel === 'Heard:' &&
          tieSentence(f) &&
          f.verdict === false &&
          f.piano.endsWith('The heard scale is not clear.') &&
          f.guitar.endsWith('The heard scale is not clear.'),
        JSON.stringify(brief(f)),
      );
    }

    // J3: agree and differ look the same: plain text color, muted labels, nothing between the lines.
    {
      const agree = await jamWith(`const harmony = 'C:major'\n${C_MAJOR}`, 'probe harmony jam agree', `f.state === 'ready' && f.declaredHidden === false && f.kind === 'clear'`);
      const agreeColors = await colors();
      const differ = await jamWith(`const harmony = 'D4:dorian'\n${C_MAJOR}`, 'probe harmony jam differ', `f.state === 'ready' && f.declaredValue === 'D Dorian' && f.kind === 'clear'`);
      const differColors = await colors();
      const same = (c) =>
        c.value === c.text && c.declaredLabel === c.muted && c.heardLabel === c.muted && c.reserved.every((color) => color !== c.value) && c.adjacent === true;
      report(
        'harmony jam J3: declared and heard agree or differ with the same look',
        agree !== null &&
          differ !== null &&
          agree.declaredValue === 'C major' &&
          agree.name === 'C major' &&
          differ.name === 'C major' &&
          same(agreeColors) &&
          same(differColors),
        JSON.stringify({ agree: [agree?.declaredValue, agree?.name], differ: [differ?.declaredValue, differ?.name], agreeColors, differColors }),
      );
    }

    // J4: a chord pattern as written, and the unreadable sentences in muted text.
    {
      const chords = await jamWith(`const harmony = "<Dm7 G7 C^7>"\n${C_MAJOR}`, 'probe harmony jam chords', `f.state === 'ready' && f.declaredKind === 'chords'`);
      const computed = await jamWith(`const harmony = Math.max(1, 2)\n${C_MAJOR}`, 'probe harmony jam computed', `f.state === 'ready' && f.declaredKind === 'unreadable'`);
      const computedColors = await colors();
      const mutable = await jamWith(`let harmony = 'C:major'\n${C_MAJOR}`, 'probe harmony jam let', `f.state === 'ready' && f.declaredKind === 'unreadable' && f.declaredValue.includes('let or var')`);
      const markup = await jamWith(`const harmony = '<b>x</b> <i>y</i>'\n${C_MAJOR}`, 'probe harmony jam markup', `f.state === 'ready' && f.declaredKind === 'unreadable' && f.declaredValue.includes('<b>')`);
      report(
        'harmony jam J4: a chord pattern is shown as written and an unreadable declaration says why in muted text',
        chords !== null &&
          chords.declaredValue === '<Dm7 G7 C^7>' &&
          chords.declaredTitle === 'harmony = <Dm7 G7 C^7>' &&
          computed !== null &&
          computed.declaredValue.startsWith('Not readable: harmony is computed (') &&
          computedColors.value === computedColors.muted &&
          mutable !== null &&
          mutable.declaredValue === 'Not readable: harmony is declared with let or var; the page reads only const.' &&
          markup !== null &&
          markup.declaredChildren === 0,
        JSON.stringify({ chords: chords?.declaredValue, computed: computed?.declaredValue, mutable: mutable?.declaredValue, markup: markup?.declaredValue, markupChildren: markup?.declaredChildren }),
      );
    }

    // J5: a declaration with nothing pitched keeps the body; without one the whole-view message stays.
    {
      const withLine = await jamWith(`const harmony = 'D4:dorian'\n${DRUMS}`, 'probe harmony jam drums declared', `f.state === 'ready' && f.kind === 'none'`);
      const control = await jamWith(DRUMS, 'probe harmony jam drums control', `f.state === 'message'`);
      report(
        'harmony jam J5: a declaration with nothing pitched keeps the body and the Declared line',
        withLine !== null &&
          withLine.bodyHidden === false &&
          withLine.messageHidden === true &&
          withLine.name === 'No notes to read: the playing code has no pitched notes.' &&
          withLine.declaredValue === 'D Dorian' &&
          withLine.declaredHidden === false &&
          withLine.verdict === false &&
          control !== null &&
          control.messageHidden === false &&
          control.bodyHidden === true,
        JSON.stringify({ withLine: brief(withLine), control: control === null ? null : { state: control.state, messageHidden: control.messageHidden, bodyHidden: control.bodyHidden } }),
      );
    }

    // J6: a long declaration is cut at 60 characters and nothing overflows in layouts b and c.
    {
      const text = `<${'Dm7 G7 C^7 Am7 '.repeat(10).trim()}>`;
      const long = await jamWith(`const harmony = "${text}"\n${C_MAJOR}`, 'probe harmony jam long', `f.state === 'ready' && f.declaredKind === 'chords' && f.declaredValue.length < 100`);
      const overflow = `(() => { const v = document.getElementById('jam-view'); return { scroll: v.scrollWidth, client: v.clientWidth, shown: !document.getElementById('jam-declared').hidden }; })()`;
      await press('b');
      const [atB] = await atWidths(cdp, [1024], () => evaluateExpr(cdp, overflow));
      await press('c');
      const [atC] = await atWidths(cdp, [3840], () => evaluateExpr(cdp, overflow));
      await press('a');
      report(
        'harmony jam J6: a long declaration is cut at 60 characters and nothing overflows in layouts b and c',
        long !== null &&
          text.length > 100 &&
          long.declaredValue.length <= 60 &&
          long.declaredValue.endsWith('…') &&
          long.declaredTitle === `harmony = ${text}` &&
          atB.shown === true &&
          atB.scroll <= atB.client &&
          atC.shown === true &&
          atC.scroll <= atC.client,
        JSON.stringify({ length: text.length, shownLength: long?.declaredValue.length, atB, atC }),
      );
    }

    // J7: the Declared line is plain text: not a control, not a live region.
    {
      const facts = await evaluateExpr(
        cdp,
        `(() => {
          const ids = ['jam-declared', 'jam-declared-label', 'jam-declared-value'];
          const els = ids.map((id) => document.getElementById(id));
          return {
            tabindex: els.map((el) => el.hasAttribute('tabindex')),
            controls: els.map((el) => ['BUTTON', 'A', 'INPUT'].includes(el.tagName) || el.querySelector('button, a, input') !== null),
            live: els.map((el) => el.closest('[aria-live]') !== null),
            labelled: document.getElementById('jam-declared').hasAttribute('aria-label'),
            role: els.map((el) => el.getAttribute('role')),
          };
        })()`,
      );
      report(
        'harmony jam J7: the Declared line is not a control and not in a live region',
        facts.tabindex.every((v) => v === false) &&
          facts.controls.every((v) => v === false) &&
          facts.live.every((v) => v === false) &&
          facts.labelled === false &&
          facts.role.every((v) => v === null),
        JSON.stringify(facts),
      );
    }
  }

  // --- Parts: more shapes are read, and the rest say why (P1 to P3) ---
  {
    // Sends one program, opens the Parts view and waits for either rows or a message; returns what is drawn.
    const partsWith = async (code, label) => {
      await callTool(client, 'set_code', { code, label });
      await started(code);
      await openView('4');
      const facts = await waitFor(
        cdp,
        `(() => {
          const msg = document.getElementById('parts-message');
          const cards = [...document.querySelectorAll('#parts-view .part-card')];
          if (cards.length === 0 && msg.hidden) return null;
          return {
            messageHidden: msg.hidden,
            text: msg.textContent,
            names: cards.map((card) => card.dataset.part),
            lengths: cards.map((card) => Number(((card.querySelector('.part-state') || {}).textContent || '').match(/(\\d+) cycles$/)?.[1])),
          };
        })()`,
        5000,
      );
      await closeViews();
      return facts;
    };

    // P1: constant arithmetic, a spread of a const list and a pair held in a const draw rows and no message.
    {
      const code = [
        'const BAR = 2',
        'const sections = [[BAR, s("bd").gain(0)], [BAR * 2, s("hh").gain(0)]]',
        'const verse = [4 + 4, s("sd").gain(0)]',
        'lead: arrange([BAR, s("cp").gain(0)], ...sections, verse)',
      ].join('\n');
      const f = await partsWith(code, 'probe harmony parts spread');
      report(
        'harmony parts P1: constant arithmetic, a spread of a const list and a pair held in a const draw part rows and no message',
        f !== null &&
          f.messageHidden === true &&
          JSON.stringify(f.names) === JSON.stringify(['Part 1', 'Part 2', 'Part 3', 'Part 4']) &&
          JSON.stringify(f.lengths) === JSON.stringify([2, 2, 4, 8]),
        JSON.stringify(f),
      );
    }

    // P2: an arrange the page cannot read says why, with the new clause and the quoted source, then the shape rule.
    {
      const calls = await partsWith(
        ['const probeLen = (n) => n', 'lead: arrange([probeLen(4), s("bd").gain(0)])'].join('\n'),
        'probe harmony parts calls',
      );
      const mutable = await partsWith(
        ['let probeBars = 4', 'lead: arrange([probeBars, s("bd").gain(0)])'].join('\n'),
        'probe harmony parts mutable',
      );
      const callsText = partsEmptyText([{ call: 1, section: 1, reason: 'length-calls', source: 'probeLen(4)' }], 1);
      const mutableText = partsEmptyText([{ call: 1, section: 1, reason: 'length-name-mutable', source: 'probeBars' }], 1);
      report(
        'harmony parts P2: an arrange the page cannot read says why with the new clause',
        calls !== null &&
          mutable !== null &&
          calls.messageHidden === false &&
          calls.names.length === 0 &&
          calls.text === callsText &&
          calls.text.includes('calls a function or reads a property (probeLen(4))') &&
          calls.text.endsWith(PARTS_COPY.shapeRule) &&
          mutable.text === mutableText &&
          mutable.text.includes('probeBars, declared with let or var, so it can change'),
        JSON.stringify({ calls, mutable }),
      );
    }

    // P3: one readable call and one skipped call draw the rows of the first plus the skipped line.
    {
      const code = [
        'const probeSections = [[2, s("bd").gain(0)], [2, s("hh").gain(0)]]',
        'const probePick = (n) => n',
        'one: arrange(...probeSections)',
        'two: arrange([probePick(2), s("sd").gain(0)])',
      ].join('\n');
      const f = await partsWith(code, 'probe harmony parts skipped');
      report(
        'harmony parts P3: one readable call and one skipped call draw rows plus the skipped line',
        f !== null &&
          f.messageHidden === false &&
          f.names.length === 2 &&
          JSON.stringify(f.lengths) === JSON.stringify([2, 2]) &&
          f.text === partsSkippedText([{ call: 2, section: 1, reason: 'length-calls', source: 'probePick(2)' }], 2),
        JSON.stringify(f),
      );
    }
  }

  await closeViews();
  await cdp('Emulation.clearDeviceMetricsOverride');
  await callTool(client, 'set_code', { code: QUIET, label: 'probe harmony reset' });
}

/** The address patterns that block the two pinned scripts of the page (Network.setBlockedURLs wildcards). */
const BLOCK_STRUDEL = '*unpkg.com/@strudel/repl@*';
const BLOCK_ACORN = '*unpkg.com/acorn@*';

/** Page-side source, installed before the page's own scripts run: it logs every text the Claude line of the notice is
 * given, in order, from the very first one. It watches the whole document because the notice module writes its first
 * text before the page has finished loading. */
const CLAUDE_LINE_RECORDER = `(() => {
  window.__claudeLineLog = [];
  new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'characterData') {
        if (record.target.parentElement && record.target.parentElement.id === 'load-failure-claude') window.__claudeLineLog.push(record.target.data);
      } else if (record.target.id === 'load-failure-claude' || (record.target.parentElement && record.target.parentElement.id === 'load-failure-claude')) {
        for (const node of record.addedNodes) window.__claudeLineLog.push(node.textContent);
      }
    }
  }).observe(document, { childList: true, characterData: true, subtree: true });
})()`;

const LOAD_FAILURE_CONTENT_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
});

/** What a Moontide server would answer for one address of the page folder, for the run where no server is listening:
 * the page itself gets a fixed fake token that no server accepts. A missing file is a 404, like the real server. */
function pageFolderAnswer(urlText) {
  const pageDir = path.join(REPO_ROOT, 'page');
  let name = decodeURIComponent(new URL(urlText).pathname);
  if (name === '/') name = '/index.html';
  const resolved = path.resolve(pageDir, `.${name}`);
  const contentType = LOAD_FAILURE_CONTENT_TYPES[path.extname(resolved)];
  if (!resolved.startsWith(pageDir + path.sep) || contentType === undefined || !fs.existsSync(resolved)) {
    return { status: 404, contentType: 'text/plain; charset=utf-8', body: Buffer.from('not found') };
  }
  let body = fs.readFileSync(resolved);
  if (path.basename(resolved) === 'index.html') {
    body = Buffer.from(body.toString('utf8').replace(PAGE_TOKEN_PLACEHOLDER, () => 'probe-token-no-server-accepts'), 'utf8');
  }
  return { status: 200, contentType, body };
}

/** A port nothing listens on right now: a server is opened on port 0 and closed again. */
async function freeLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/**
 * A tab of its own for one load failure run, so a blocked address, a request interception or a window size can never
 * reach the main probe tab. `block` is a list of Network.setBlockedURLs patterns, `recorder` installs the Claude line
 * recorder before the page runs, and `fetchOrigin` ("http://127.0.0.1:<port>") answers every request to that origin
 * from the page folder. `tab.events` holds every CDP event of the tab; `tab.close()` closes the socket and the tab and
 * is safe to call twice.
 */
async function openProbeTab(port, { block = [], recorder = false, fetchOrigin = null } = {}) {
  const tab = { id: null, ws: null, cdp: null, events: [], fetchErrors: [] };
  tab.close = async () => {
    if (tab.ws !== null) {
      try {
        tab.ws.close();
      } catch {
        // already closed
      }
      tab.ws = null;
    }
    if (tab.id !== null) {
      const id = tab.id;
      tab.id = null;
      await fetch(`http://127.0.0.1:${port}/json/close/${id}`).catch(() => {});
    }
  };
  try {
    const created = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' });
    if (!created.ok) throw new Error(`/json/new answered ${created.status}`);
    const info = await created.json();
    tab.id = info.id;
    tab.ws = new WebSocket(info.webSocketDebuggerUrl);
    tab.ws.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
      } catch {
        return;
      }
      if (typeof message.method !== 'string') return;
      tab.events.push(message);
      if (message.method === 'Fetch.requestPaused') {
        const answer = pageFolderAnswer(message.params.request.url);
        tab
          .cdp('Fetch.fulfillRequest', {
            requestId: message.params.requestId,
            responseCode: answer.status,
            responseHeaders: [
              { name: 'Content-Type', value: answer.contentType },
              { name: 'Cache-Control', value: 'no-store' },
            ],
            body: answer.body.toString('base64'),
          })
          .catch((error) => tab.fetchErrors.push(error instanceof Error ? error.message : String(error)));
      }
    });
    await waitSocketOpen(tab.ws);
    tab.cdp = makeCdp(tab.ws);
    await tab.cdp('Runtime.enable');
    await tab.cdp('Page.enable');
    await tab.cdp('Network.enable');
    if (block.length > 0) await tab.cdp('Network.setBlockedURLs', { urls: block });
    if (recorder) await tab.cdp('Page.addScriptToEvaluateOnNewDocument', { source: CLAUDE_LINE_RECORDER });
    if (fetchOrigin !== null) await tab.cdp('Fetch.enable', { patterns: [{ urlPattern: `${fetchOrigin}/*` }] });
  } catch (error) {
    await tab.close();
    throw error;
  }
  return tab;
}

/** Like waitFor, but a failed evaluation (the page is mid-navigation) counts as "not yet"; null when time ran out. */
async function pollPage(cdp, expression, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const value = await evaluateExpr(cdp, expression);
      if (value !== null && value !== undefined) return value;
    } catch {
      // The execution context is gone while the page navigates: try again until the time is up.
    }
    if (Date.now() >= deadline) return null;
    await sleep(100);
  }
}

/** The text of the Claude line once it is no longer the sending text, or null after `timeoutMs`. */
function waitClaudeLineSettled(cdp, timeoutMs) {
  const sending = JSON.stringify(LOAD_FAILURE_COPY.claude.sending);
  return pollPage(
    cdp,
    `(() => { const el = document.getElementById('load-failure-claude'); return el !== null && el.textContent !== '' && el.textContent !== ${sending} ? el.textContent : null; })()`,
    timeoutMs,
  );
}

/** Everything the checks read from the notice and the page around it, in one evaluation. */
function readLoadNotice(cdp) {
  return evaluateExpr(
    cdp,
    `(() => {
      const text = (id) => document.getElementById(id).textContent;
      const display = (id) => getComputedStyle(document.getElementById(id)).display;
      const strip = document.getElementById('load-failure');
      const claude = document.getElementById('load-failure-claude');
      const source = (fragment) => { const el = document.querySelector('script[src*="' + fragment + '"]'); return el === null ? null : el.src; };
      return {
        dataLoad: document.body.getAttribute('data-load'),
        stripHidden: strip.hidden,
        heading: text('load-failure-title'),
        what: text('load-failure-what'),
        todo: text('load-failure-todo'),
        rows: [...document.querySelectorAll('#load-failure-addresses > *')].map((row) => row.textContent),
        claude: claude.textContent,
        claudeWeight: getComputedStyle(claude).fontWeight,
        stripDisplay: getComputedStyle(strip).display,
        stripZIndex: getComputedStyle(strip).zIndex,
        chromeDisplay: display('chrome'),
        workspaceDisplay: display('workspace'),
        overlayDisplay: display('audio-unlock-overlay'),
        dismissHidden: document.getElementById('load-failure-dismiss').hidden,
        title: document.title,
        focusId: document.activeElement === null ? null : document.activeElement.id,
        focusInside: strip.contains(document.activeElement),
        strudelSrc: source('@strudel/repl'),
        acornSrc: source('acorn'),
        alertText: document.getElementById('load-failure-alert').textContent,
      };
    })()`,
  );
}

/** How many times `note` appears in `text`. */
function countOccurrences(text, note) {
  return text.split(note).length - 1;
}

/**
 * The load failure notice in a real browser. Each run uses a tab of its own and closes it: the Strudel script blocked
 * by address (the blocked panel, the recorded Claude line, the note in Claude's next reply), then the other cases.
 * `context` is { cdp, client, report, port, pageUrl }, the same object barBlocks gets. The main tab never has a blocked
 * address, and it is left playing a quiet pattern.
 */
export async function loadFailureBlocks(context) {
  const { cdp, client, report, port, pageUrl } = context;
  const copy = LOAD_FAILURE_COPY;
  const playingWord = JSON.stringify(SOUND_LABELS.playing);
  const QUIET = 'setcps(0.5)\nload_failure_probe: s("bd*4").gain(0)';
  await cdp('Emulation.clearDeviceMetricsOverride');
  await callTool(client, 'set_code', { code: QUIET, label: 'probe load failure start' });
  const mainPlays = await waitFor(cdp, `(() => (${STATE_WORD_EXPR}) === ${playingWord} ? true : null)()`, 8000);
  if (mainPlays !== true) throw new Error('loadFailureBlocks: the main tab does not play the quiet pattern');
  // Claude's next reply carries a told note once; one get_code call empties it so no later check sees an extra line.
  const drainNotes = () => callTool(client, 'get_code', {});

  // --- The Strudel script blocked ---
  {
    const tab = await openProbeTab(port, { block: [BLOCK_STRUDEL], recorder: true });
    let facts = null;
    let log = null;
    let settledMs = null;
    let reply = '';
    try {
      await tab.cdp('Page.navigate', { url: pageUrl });
      const mode = await pollPage(tab.cdp, `document.body && document.body.getAttribute('data-load')`, 10000);
      if (mode === null) throw new Error('load failure: the notice never showed with the Strudel script blocked');
      const shownAt = Date.now();
      const settled = await waitClaudeLineSettled(tab.cdp, 6500);
      settledMs = settled === null ? null : Date.now() - shownAt;
      await sleep(1000);
      facts = await readLoadNotice(tab.cdp);
      log = await evaluateExpr(tab.cdp, 'window.__claudeLineLog');
      reply = await drainNotes();
    } finally {
      await tab.close();
    }
    const note = loadFailureNote(['strudel']);
    report(
      'load failure: with the Strudel script blocked the notice shows the heading, what failed, what to do and the failed address',
      facts !== null &&
        facts.dataLoad === 'failed' &&
        facts.stripHidden === false &&
        facts.heading === copy.blocked.heading &&
        facts.what === copy.blocked.whatStrudel &&
        facts.todo === copy.blocked.todo &&
        facts.strudelSrc !== null &&
        facts.strudelSrc.includes('@strudel/repl') &&
        facts.rows.length === 1 &&
        facts.rows[0] === copy.addressPrefix + facts.strudelSrc,
      JSON.stringify(facts && { dataLoad: facts.dataLoad, heading: facts.heading, what: facts.what, rows: facts.rows }),
    );
    report(
      'load failure: with the Strudel script blocked nothing but the notice is shown, and the tab title and the focus say so',
      facts !== null &&
        facts.chromeDisplay === 'none' &&
        facts.workspaceDisplay === 'none' &&
        facts.overlayDisplay === 'none' &&
        facts.stripDisplay !== 'none' &&
        facts.title === copy.blocked.tabTitle &&
        facts.focusId === 'load-failure-reload',
      JSON.stringify(facts && { chrome: facts.chromeDisplay, workspace: facts.workspaceDisplay, overlay: facts.overlayDisplay, title: facts.title, focus: facts.focusId }),
    );
    report(
      'load failure: the Claude line goes from sending to told exactly once, within five seconds',
      Array.isArray(log) && log.length === 2 && log[0] === copy.claude.sending && log[1] === copy.claude.told && settledMs !== null && settledMs < 5000,
      JSON.stringify({ log, settledMs }),
    );
    report(
      'load failure: Claude\'s next reply holds the note for the blocked Strudel script once',
      countOccurrences(reply, note) === 1,
      JSON.stringify({ occurrences: countOccurrences(reply, note), replyStart: reply.slice(0, 120) }),
    );
  }

  // A tab that loads healthy takes the sound role from the main tab; once it is closed the main tab takes it back the
  // way a person does (Play in this tab) and plays the quiet pattern again.
  const restoreMainTab = async () => {
    const noTab = await waitFor(cdp, `(() => document.getElementById('midi-takeover-text').textContent === ${JSON.stringify(MIDI_COPY.noActiveText)} ? true : null)()`, 8000);
    if (noTab !== true) throw new Error('load failure: the main tab never said that no tab is playing after the other tab closed');
    await evaluateExpr(cdp, `document.getElementById('take-back').click()`);
    const back = await waitFor(cdp, `(() => document.getElementById('midi-takeover').hidden ? true : null)()`, 8000);
    if (back !== true) throw new Error('load failure: Play in this tab did not bring the role back to the main tab');
    await callTool(client, 'set_code', { code: QUIET, label: 'probe load failure restore' });
    const plays = await waitFor(cdp, `(() => (${STATE_WORD_EXPR}) === ${playingWord} ? true : null)()`, 8000);
    if (plays !== true) throw new Error('load failure: the main tab does not play again after taking the role back');
  };
  // Page side: every element of the notice that is wider than its box, and the heights that tell whether it scrolls.
  const OVERFLOW_JS = `(() => {
    const strip = document.getElementById('load-failure');
    const style = getComputedStyle(strip);
    return {
      wide: [strip, ...strip.querySelectorAll('*')].filter((el) => el.scrollWidth > el.clientWidth).map((el) => el.id || el.tagName),
      scrollHeight: strip.scrollHeight,
      clientHeight: strip.clientHeight,
      offsetHeight: strip.offsetHeight,
      overflowY: style.overflowY,
      pageWiderThanWindow: document.documentElement.scrollWidth > window.innerWidth,
      pageTallerThanWindow: document.documentElement.scrollHeight > window.innerHeight,
    };
  })()`;
  const atSize = async (tabCdp, width, height, deviceScaleFactor) => {
    await tabCdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor, mobile: false });
    await sleep(400);
    return evaluateExpr(tabCdp, OVERFLOW_JS);
  };
  const SILENT = 'setcps(0.5)\nload_failure_probe: s("bd*4").gain(0)';
  const mainTitle = await evaluateExpr(cdp, 'document.title');

  // --- Only the acorn script blocked ---
  {
    const tab = await openProbeTab(port, { block: [BLOCK_ACORN], recorder: true });
    let facts = null;
    let log = null;
    let reply = '';
    let small = null;
    let played = null;
    let dismissed = null;
    try {
      await tab.cdp('Page.navigate', { url: pageUrl });
      const mode = await pollPage(tab.cdp, `document.body && document.body.getAttribute('data-load')`, 10000);
      if (mode === null) throw new Error('load failure: the strip never showed with the acorn script blocked');
      await waitConnected(tab.cdp, 15000);
      await waitClaudeLineSettled(tab.cdp, 6500);
      await sleep(500);
      facts = await readLoadNotice(tab.cdp);
      log = await evaluateExpr(tab.cdp, 'window.__claudeLineLog');
      reply = await drainNotes();
      small = await atSize(tab.cdp, 512, 300, 2);
      await tab.cdp('Emulation.clearDeviceMetricsOverride');
      await tab.cdp('Page.bringToFront');
      await clickOverlay(tab.cdp);
      await callTool(client, 'set_code', { code: SILENT, label: 'probe load failure acorn tab' });
      played = await pollPage(tab.cdp, `(() => (${STATE_WORD_EXPR}) === ${playingWord} ? true : null)()`, 8000);
      await clickElement(tab.cdp, '#load-failure-dismiss');
      dismissed = await evaluateExpr(tab.cdp, `(() => { const strip = document.getElementById('load-failure'); return { hidden: strip.hidden, display: getComputedStyle(strip).display }; })()`);
    } finally {
      await tab.close();
    }
    await restoreMainTab();
    report(
      'load failure: with only acorn blocked a strip shows above the sound overlay and the title and focus stay as they were',
      facts !== null &&
        facts.dataLoad === 'degraded' &&
        facts.stripHidden === false &&
        facts.stripDisplay !== 'none' &&
        facts.stripZIndex === '2001' &&
        facts.overlayDisplay !== 'none' &&
        facts.focusInside === false &&
        facts.title === mainTitle &&
        facts.dismissHidden === false &&
        facts.heading === copy.degraded.lead &&
        facts.what === copy.degraded.what &&
        facts.todo === copy.degraded.todo &&
        facts.rows.length === 1 &&
        facts.rows[0] === copy.addressPrefix + facts.acornSrc,
      JSON.stringify(facts && { dataLoad: facts.dataLoad, display: facts.stripDisplay, z: facts.stripZIndex, overlay: facts.overlayDisplay, focus: facts.focusId, title: facts.title, rows: facts.rows }),
    );
    report(
      'load failure: with only acorn blocked the Claude line goes from sending to told once and Claude\'s next reply holds the note',
      Array.isArray(log) && log.length === 2 && log[0] === copy.claude.sending && log[1] === copy.claude.told && countOccurrences(reply, loadFailureNote(['acorn'])) === 1,
      JSON.stringify({ log, occurrences: countOccurrences(reply, loadFailureNote(['acorn'])) }),
    );
    report(
      'load failure: with only acorn blocked, sound plays after the unlock click as on a healthy page, and Dismiss notice hides the strip',
      played === true && dismissed !== null && dismissed.hidden === true && dismissed.display === 'none',
      JSON.stringify({ played, dismissed }),
    );
    report(
      'load failure: the strip is as tall as its content in a 512 by 300 window at double pixel density, with nothing wider than its box',
      small !== null && small.wide.length === 0 && small.offsetHeight >= small.scrollHeight && small.pageWiderThanWindow === false,
      JSON.stringify(small),
    );
  }

  // --- Both scripts blocked ---
  {
    const tab = await openProbeTab(port, { block: [BLOCK_STRUDEL, BLOCK_ACORN] });
    let facts = null;
    let reply = '';
    try {
      await tab.cdp('Page.navigate', { url: pageUrl });
      const mode = await pollPage(tab.cdp, `document.body && document.body.getAttribute('data-load')`, 10000);
      if (mode === null) throw new Error('load failure: the notice never showed with both scripts blocked');
      await waitClaudeLineSettled(tab.cdp, 6500);
      facts = await readLoadNotice(tab.cdp);
      reply = await drainNotes();
    } finally {
      await tab.close();
    }
    const note = loadFailureNote(['strudel', 'acorn']);
    report(
      'load failure: with both scripts blocked the notice names both, Strudel first, and Claude\'s next reply holds the note once',
      facts !== null &&
        facts.dataLoad === 'failed' &&
        facts.heading === copy.blocked.heading &&
        facts.what === copy.blocked.whatBoth &&
        facts.todo === copy.blocked.todo &&
        facts.rows.length === 2 &&
        facts.rows[0] === copy.addressPrefix + facts.strudelSrc &&
        facts.rows[1] === copy.addressPrefix + facts.acornSrc &&
        facts.claude === copy.claude.told &&
        countOccurrences(reply, note) === 1,
      JSON.stringify({ rows: facts && facts.rows, claude: facts && facts.claude, occurrences: countOccurrences(reply, note) }),
    );
  }

  // --- A healthy tab next to a blocked one ---
  {
    const before = await evaluateExpr(cdp, `(() => { const state = document.getElementById('repl').editor.repl.state; return { word: ${STATE_WORD_EXPR}, here: document.querySelector('#sound-state .state-here').textContent, started: state.started === true, code: state.activeCode, takeoverHidden: document.getElementById('midi-takeover').hidden }; })()`);
    const tab = await openProbeTab(port, { block: [BLOCK_STRUDEL] });
    let blockedFacts = null;
    let after = null;
    let clockBefore = null;
    let clockAfter = null;
    let reply = '';
    try {
      await tab.cdp('Page.navigate', { url: pageUrl });
      const mode = await pollPage(tab.cdp, `document.body && document.body.getAttribute('data-load')`, 10000);
      if (mode === null) throw new Error('load failure: the notice never showed in the second tab');
      await waitClaudeLineSettled(tab.cdp, 6500);
      blockedFacts = await readLoadNotice(tab.cdp);
      await sleep(1000);
      clockBefore = await readSchedulerNow(cdp);
      await sleep(1000);
      clockAfter = await readSchedulerNow(cdp);
      after = await evaluateExpr(cdp, `(() => { const state = document.getElementById('repl').editor.repl.state; return { word: ${STATE_WORD_EXPR}, here: document.querySelector('#sound-state .state-here').textContent, started: state.started === true, code: state.activeCode, takeoverHidden: document.getElementById('midi-takeover').hidden }; })()`);
      reply = await drainNotes();
    } finally {
      await tab.close();
    }
    report(
      'load failure: a blocked second tab tells Claude while the healthy tab keeps its role, its sound and its answer to get_code',
      blockedFacts !== null &&
        blockedFacts.claude === copy.claude.told &&
        before.word === SOUND_LABELS.playing &&
        before.started === true &&
        before.here === '' &&
        after !== null &&
        after.word === SOUND_LABELS.playing &&
        after.here === '' &&
        after.started === true &&
        after.code === before.code &&
        after.takeoverHidden === true &&
        clockAfter - clockBefore >= 0.2 &&
        reply.startsWith('setcps(0.5)') &&
        countOccurrences(reply, loadFailureNote(['strudel'])) === 1,
      JSON.stringify({ before, after, claude: blockedFacts && blockedFacts.claude, clock: [clockBefore, clockAfter], noteOccurrences: countOccurrences(reply, loadFailureNote(['strudel'])) }),
    );
  }

  // --- The server is gone ---
  {
    const deadPort = await freeLoopbackPort();
    const origin = `http://127.0.0.1:${deadPort}`;
    const unreachableExpr = `(() => { const el = document.getElementById('load-failure-claude'); return el.textContent === ${JSON.stringify(copy.claude.unreachable)} ? getComputedStyle(el).fontWeight : null; })()`;
    let blocked = null;
    let reloaded = null;
    let degraded = null;
    let dismissedAfter = null;
    let fetchErrors = [];
    const tab = await openProbeTab(port, { block: [BLOCK_STRUDEL], fetchOrigin: origin });
    try {
      await tab.cdp('Page.navigate', { url: `${origin}/` });
      const mode = await pollPage(tab.cdp, `document.body && document.body.getAttribute('data-load')`, 10000);
      if (mode === null) throw new Error('load failure: the notice never showed on the address where no server listens');
      const weight = await pollPage(tab.cdp, unreachableExpr, 5500);
      blocked = { mode, weight };
      await tab.cdp('Page.bringToFront');
      await evaluateExpr(tab.cdp, `(() => { window.__probeReloadMarker = true; })()`);
      await clickElement(tab.cdp, '#load-failure-reload');
      const back = await pollPage(tab.cdp, `window.__probeReloadMarker === undefined && document.body && document.body.getAttribute('data-load') === 'failed' && !document.getElementById('load-failure').hidden ? true : null`, 10000);
      const weightAgain = await pollPage(tab.cdp, unreachableExpr, 5500);
      reloaded = { back, weightAgain };
    } finally {
      fetchErrors = fetchErrors.concat(tab.fetchErrors);
      await tab.close();
    }
    const strip = await openProbeTab(port, { block: [BLOCK_ACORN], fetchOrigin: origin });
    try {
      await strip.cdp('Page.navigate', { url: `${origin}/` });
      const mode = await pollPage(strip.cdp, `document.body && document.body.getAttribute('data-load')`, 10000);
      if (mode === null) throw new Error('load failure: the strip never showed on the address where no server listens');
      const weight = await pollPage(strip.cdp, unreachableExpr, 5500);
      degraded = { mode, weight };
      await strip.cdp('Page.bringToFront');
      await clickElement(strip.cdp, '#load-failure-dismiss');
      dismissedAfter = await evaluateExpr(strip.cdp, `(() => { const el = document.getElementById('load-failure'); return { hidden: el.hidden, display: getComputedStyle(el).display }; })()`);
    } finally {
      fetchErrors = fetchErrors.concat(strip.fetchErrors);
      await strip.close();
    }
    const reply = await drainNotes();
    report(
      'load failure: with Strudel blocked and no server to tell, the Claude line says so in weight 600 and Reload page shows the notice again',
      blocked !== null && blocked.mode === 'failed' && blocked.weight === '600' && reloaded !== null && reloaded.back === true && reloaded.weightAgain === '600',
      JSON.stringify({ blocked, reloaded, fetchErrors }),
    );
    report(
      'load failure: with acorn blocked and no server to tell, the Claude line says so in weight 600 and Dismiss notice hides the strip',
      degraded !== null && degraded.mode === 'degraded' && degraded.weight === '600' && dismissedAfter !== null && dismissedAfter.hidden === true && dismissedAfter.display === 'none',
      JSON.stringify({ degraded, dismissedAfter }),
    );
    report(
      'load failure: nothing reaches Claude when the page could not reach the server',
      !reply.includes('Moontide page: a tab could not load'),
      JSON.stringify({ replyStart: reply.slice(0, 120) }),
    );
  }

  // --- Small windows ---
  {
    const tab = await openProbeTab(port, { block: [BLOCK_STRUDEL] });
    let wide = null;
    let small = null;
    let short = null;
    try {
      await tab.cdp('Page.navigate', { url: pageUrl });
      const mode = await pollPage(tab.cdp, `document.body && document.body.getAttribute('data-load')`, 10000);
      if (mode === null) throw new Error('load failure: the notice never showed for the window size checks');
      await waitClaudeLineSettled(tab.cdp, 6500);
      wide = await atSize(tab.cdp, 1024, 600, 1);
      small = await atSize(tab.cdp, 512, 300, 2);
      // A window shorter than the text: the notice scrolls inside itself and the page around it does not.
      short = await atSize(tab.cdp, 512, 120, 2);
    } finally {
      await tab.close();
    }
    await drainNotes();
    report(
      'load failure: the blocked notice fits a 1024 by 600 window and a 512 by 300 window at double pixel density, and in a window shorter than the text it scrolls inside itself',
      wide !== null &&
        wide.wide.length === 0 &&
        wide.pageWiderThanWindow === false &&
        small !== null &&
        small.wide.length === 0 &&
        small.pageWiderThanWindow === false &&
        small.pageTallerThanWindow === false &&
        short !== null &&
        short.wide.length === 0 &&
        short.scrollHeight > short.clientHeight &&
        short.overflowY === 'auto' &&
        short.pageTallerThanWindow === false,
      JSON.stringify({ wide, small, short }),
    );
  }

  // --- A healthy load opens one connection and shows no notice ---
  {
    const tab = await openProbeTab(port);
    let facts = null;
    let sockets = null;
    try {
      await tab.cdp('Page.navigate', { url: pageUrl });
      await waitConnected(tab.cdp, 15000);
      await sleep(1500);
      facts = await evaluateExpr(tab.cdp, `({ dataLoad: document.body.getAttribute('data-load'), hidden: document.getElementById('load-failure').hidden, claude: document.getElementById('load-failure-claude').textContent })`);
      sockets = tab.events.filter((event) => event.method === 'Network.webSocketCreated' && new URL(event.params.url).pathname === '/ws').length;
    } finally {
      await tab.close();
    }
    await restoreMainTab();
    report(
      'load failure: a healthy page has no load state, keeps the notice hidden and opens exactly one connection to the server',
      facts !== null && facts.dataLoad === null && facts.hidden === true && facts.claude === '' && sockets === 1,
      JSON.stringify({ facts, sockets }),
    );
  }

  await cdp('Page.bringToFront');
  await cdp('Emulation.clearDeviceMetricsOverride');
}

/** The folder of the main probe server. The name is made up, so the label never holds a real folder. */
const IDENTITY_FOLDER = 'my-project';

/** A made-up folder name of exactly 60 characters, longer than the 40 a label keeps. */
const IDENTITY_LONG_FOLDER = 'long-folder-name-'.repeat(4).slice(0, 60);

/**
 * The page names its session: the tab title and the first row of the Session card hold the label of the server (the
 * folder it runs in and the port), the replies of the start tool and of get_code name the same tab title, and a long
 * folder name wraps without clipping from 1024 px to 4K. `context` is { cdp, client, report, port, pageUrl, tempDirs },
 * the same object barBlocks gets plus the list of temp folders to remove at the end. It leaves the main tab as it found
 * it: the Session drawer closed and no window size override. The second server, its client and its tab are closed in
 * the finally block.
 */
export async function identityBlocks(context) {
  const { cdp, client, report, port, pageUrl, tempDirs } = context;
  const boundPort = Number(new URL(pageUrl).port);
  const label = `${IDENTITY_FOLDER} · ${boundPort}`;
  const title = `Moontide · ${label}`;

  const pageTitle = await evaluateExpr(cdp, 'document.title');
  report(
    'identity: the tab title names the folder and the bound port of the server',
    pageTitle === title,
    JSON.stringify({ title: pageTitle, expected: title, boundPort, probedDevToolsPort: port }),
  );

  await openDrawer(cdp);
  const row = await evaluateExpr(
    cdp,
    `(() => {
      const card = document.getElementById('session-card-session');
      const identity = document.getElementById('session-identity');
      const first = card.children[1] || null;
      const key = identity === null ? null : identity.querySelector('.session-key');
      const value = document.getElementById('session-label');
      return {
        firstAfterHeading: first === null ? null : first.id,
        key: key === null ? null : key.textContent,
        value: value === null ? null : value.textContent,
      };
    })()`,
  );
  await closeDrawer(cdp);
  report(
    'identity: the first row of the Session card reads "Folder and port" over the label',
    row.firstAfterHeading === 'session-identity' && row.key === 'Folder and port' && row.value === label,
    JSON.stringify({ row, expectedLabel: label }),
  );

  const startReply = await callTool(client, 'start', {});
  const codeReply = await callTool(client, 'get_code', {});
  const pageLine = `Page: ${pageUrl} (port ${boundPort}), in the browser tab titled "${pageTitle}".`;
  report(
    'identity: the start reply and get_code name the same page address, port and tab title as the page',
    startReply.includes(pageLine) && codeReply.includes(pageLine),
    JSON.stringify({ expected: pageLine, start: startReply.includes(pageLine), getCode: codeReply.includes(pageLine) }),
  );

  // A second server in a made-up folder with a 60-character name, in a tab of its own.
  const longFolder = makeNamedFolder(IDENTITY_LONG_FOLDER, tempDirs);
  let second = null;
  let tab = null;
  try {
    second = await startServerAndClient({ cwd: longFolder });
    tempDirs.push(second.dataDir);
    const secondPort = Number(new URL(second.pageUrl).port);
    const expectedLabel = sessionLabel(IDENTITY_LONG_FOLDER, secondPort);
    tab = await openProbeTab(port);
    await tab.cdp('Page.navigate', { url: second.pageUrl });
    await waitConnected(tab.cdp, 15000);
    const sizes = [
      { width: 1024, height: 768 },
      { width: 3840, height: 2160 },
    ];
    const results = [];
    for (const size of sizes) {
      await tab.cdp('Emulation.setDeviceMetricsOverride', { ...size, deviceScaleFactor: 1, mobile: false });
      await sleep(300);
      await openDrawer(tab.cdp);
      results.push({
        size: `${size.width}x${size.height}`,
        ...(await evaluateExpr(
          tab.cdp,
          `(() => {
            const value = document.getElementById('session-label');
            const card = document.getElementById('session-card-session');
            const drawer = document.getElementById('session-drawer');
            const style = getComputedStyle(value);
            return {
              text: value.textContent,
              cardFits: card.scrollWidth <= card.clientWidth,
              drawerFits: drawer.scrollWidth <= drawer.clientWidth,
              whiteSpace: style.whiteSpace,
              overflowWrap: style.overflowWrap,
              shown: value.getClientRects().length > 0,
            };
          })()`,
        )),
      });
      await closeDrawer(tab.cdp);
    }
    await tab.cdp('Emulation.clearDeviceMetricsOverride');
    const cutLabel = expectedLabel.slice(0, expectedLabel.length - ` · ${secondPort}`.length);
    report(
      'identity: a 60-character folder name shows as the cut label and wraps without clipping at 1024 px and 3840 px',
      cutLabel.length === 40 &&
        cutLabel.endsWith('…') &&
        results.every(
          (r) => r.shown && r.text === expectedLabel && r.cardFits && r.drawerFits && r.whiteSpace === 'normal' && r.overflowWrap === 'anywhere',
        ),
      JSON.stringify({ expectedLabel, results }),
    );
  } finally {
    if (tab !== null) await tab.close();
    if (second !== null) {
      try {
        await second.client.close();
      } catch (err) {
        console.error(`probe:page: failed to close the second MCP client: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
    shotsFolder();
  } catch (err) {
    console.error(`probe:page COULD NOT RUN: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 2;
    return;
  }

  let client;
  let browserChild;
  let ws;
  const tempDirs = [];
  let browserPath = '';
  // The throwaway package copy, its server and its browser tab (closed in the finally block).
  let packageCopy = null;
  let copyClient = null;
  let copyWs = null;
  let copyTabId = null;

  try {
    browserPath = findBrowser(args);

    const { client: mcpClient, pageUrl, dataDir, getStderr } = await startServerAndClient({
      cwd: makeNamedFolder(IDENTITY_FOLDER, tempDirs),
    });
    client = mcpClient;
    tempDirs.push(dataDir);

    const userDataDir = freshDataDir('moontide-probe-browser-');
    tempDirs.push(userDataDir);

    browserChild = spawnBrowser(browserPath, userDataDir, pageUrl, args.headful);
    closeBrowserOnSignal(browserChild, tempDirs, 'probe:page');

    const port = await pollDevToolsPort(userDataDir, 10000);
    const target = await findPageTarget(port, pageUrl, 10000);

    ws = new WebSocket(target.webSocketDebuggerUrl);
    await waitSocketOpen(ws);
    const cdp = makeCdp(ws, { baseViewport: PROBE_VIEWPORT });
    await cdp('Runtime.enable');
    await cdp('Emulation.clearDeviceMetricsOverride');

    await waitConnected(cdp, 15000);
    await clickOverlay(cdp);

    // Clock sanity: the scheduler must actually advance before any check below
    // can mean anything.
    await callTool(client, 'set_code', { code: 's("bd*4").gain(0)', label: 'probe clock check' });
    const clockBefore = await readSchedulerNow(cdp);
    await sleep(1000);
    const clockAfter = await readSchedulerNow(cdp);
    if (clockAfter - clockBefore < 0.2) {
      throw new ProbeCouldNotRun("the page's clock does not advance in this browser mode (try --headful)");
    }

    const checks = [];
    function report(name, pass, detail) {
      checks.push({ name, pass, detail });
      const label = pass ? 'PASS' : 'FAIL';
      console.log(`probe:page ${label}: ${name}: ${detail}`);
    }

    // The verdict line and the exit code, shared by the full run and the `--only bar` quick lane.
    function summarize() {
      const passCount = checks.filter((check) => check.pass).length;
      const failCount = checks.length - passCount;
      if (failCount > 0) {
        console.log(`probe:page FAILED: ${failCount} of ${checks.length} checks failed`);
        process.exitCode = 1;
        return;
      }
      console.log(
        `probe:page OK: ${passCount} checks passed in the real page (${path.basename(browserPath)}, ${args.headful ? 'headful' : 'headless'})`,
      );
      process.exitCode = 0;
    }

    if (args.only === 'bar') {
      await barBlocks({ cdp, client, report, port, pageUrl });
      summarize();
      return;
    }
    if (args.only === 'harmony') {
      await harmonyBlocks({ cdp, client, report, port, pageUrl });
      summarize();
      return;
    }
    if (args.only === 'load-failure') {
      await loadFailureBlocks({ cdp, client, report, port, pageUrl });
      summarize();
      return;
    }
    if (args.only === 'identity') {
      await identityBlocks({ cdp, client, report, port, pageUrl, tempDirs });
      summarize();
      return;
    }

    // --- V1 ---
    const beforeV1 = await readSchedulerNow(cdp);
    await callTool(client, 'set_code', { code: buildProgram([rampCode(1, 'sine'), delayedCode(3), GETTIME_PART]), label: 'probe V1' });
    const afterV1 = await readSchedulerNow(cdp);
    const windowV1 = anchorWindow(beforeV1, afterV1);
    const arcV1 = await readArc(cdp, windowV1[0] - 1, windowV1[1] + 8);

    const sineHap1 = firstBySound(arcV1.haps, 'sine');
    if (!sineHap1) {
      report('a .timeline(id) ramp anchors on a cycle boundary at its change', false, 'no sine ramp events found in the query window');
      throw new Error('probe cannot continue without a sine ramp anchor');
    }
    const rampA1 = computeRampAnchor(sineHap1);
    const A1 = rampA1.anchor;
    const landingCycle = Math.floor(beforeV1);
    const which =
      A1 === landingCycle
        ? 'the start of the cycle the change landed in'
        : A1 === landingCycle + 1
          ? 'the start of the next cycle'
          : 'an unexpected cycle';
    report(
      'a .timeline(id) ramp anchors on a cycle boundary at its change',
      rampA1.consistent && inWindow(A1, windowV1),
      `anchor=${A1} (${which}; before=${beforeV1.toFixed(4)}, fractional cycle at before=${(beforeV1 - landingCycle).toFixed(4)}, raw=${rampA1.rawAnchor.toFixed(4)})`,
    );

    // Recorded for later checks, not printed on their own: E1 (delayed entry point) and G1
    // (getTime anchor), both from this same V1 read.
    const triangleHap1 = firstBySound(arcV1.haps, 'triangle');
    const E1 = triangleHap1 ? triangleHap1.begin : null;
    if (E1 !== null) {
      const impliedAnchor = Math.round(E1 - 2);
      if (!inWindow(impliedAnchor, windowV1) || Math.abs(E1 - 2 - impliedAnchor) > RAMP_TOLERANCE) {
        console.error(
          `probe:page NOTE (diagnostic only): delayed entry E1=${E1} did not land 2 cycles after an anchor inside V1's window`,
        );
      }
    } else {
      console.error("probe:page NOTE (diagnostic only): no triangle (delayed) events found in V1's query window");
    }
    const squareHap1 = firstBySound(arcV1.haps, 'square');
    const G1 = squareHap1 ? computeGettimeAnchor(squareHap1).rawAnchor : null;

    // --- V2 (same id keeps its anchor; a new id anchors at its own change; delayed entry keeps
    // its entry point; a getTime() anchor restarts) ---
    await sleep(3000);
    const beforeV2 = await readSchedulerNow(cdp);
    await callTool(client, 'set_code', {
      code: buildProgram([rampCode(1, 'sine'), delayedCode(3), GETTIME_PART, rampCode(2, 'sawtooth')]),
      label: 'probe V2',
    });
    const afterV2 = await readSchedulerNow(cdp);
    const windowV2 = anchorWindow(beforeV2, afterV2);
    const arcV2 = await readArc(cdp, windowV2[0] - 1, windowV2[1] + 8);

    const sineHap2 = firstBySound(arcV2.haps, 'sine');
    const rampA1b = sineHap2 ? computeRampAnchor(sineHap2) : null;
    report(
      'the same id keeps its anchor across a later change',
      !!rampA1b && rampA1b.consistent && rampA1b.anchor === A1,
      rampA1b ? `anchor now ${rampA1b.anchor}, was ${A1}` : 'no sine ramp events found in the query window',
    );

    const sawHap2 = firstBySound(arcV2.haps, 'sawtooth');
    const rampA2 = sawHap2 ? computeRampAnchor(sawHap2) : null;
    const A2 = rampA2 ? rampA2.anchor : null;
    report(
      'a new id anchors at its own change',
      !!rampA2 && rampA2.consistent && inWindow(A2, windowV2),
      rampA2 ? `anchor=${A2} (window ${windowV2.join('..')})` : 'no sawtooth ramp events found in the query window',
    );

    const triangleHap2 = firstBySound(arcV2.haps, 'triangle');
    const E1b = triangleHap2 ? triangleHap2.begin : null;
    report(
      'a delayed entry written with .timeline(id) keeps its entry point across a later change',
      E1b !== null && E1 !== null && Math.abs(E1b - E1) < RAMP_TOLERANCE,
      E1 === null || E1b === null ? 'no triangle (delayed) events found in one of the query windows' : `entry now ${E1b}, was ${E1}`,
    );

    const squareHap2 = firstBySound(arcV2.haps, 'square');
    const G2 = squareHap2 ? computeGettimeAnchor(squareHap2).rawAnchor : null;
    const gettimeWindow2 = [beforeV2 - 0.1, afterV2 + 0.1];
    report(
      'a getTime() anchor restarts on every change',
      G2 !== null && G1 !== null && G2 >= gettimeWindow2[0] && G2 <= gettimeWindow2[1] && Math.abs(G2 - G1) > 1,
      G1 === null || G2 === null ? 'no square (getTime) events found in one of the query windows' : `G1=${G1.toFixed(4)}, G2=${G2.toFixed(4)} (window ${gettimeWindow2[0].toFixed(4)}..${gettimeWindow2[1].toFixed(4)})`,
    );

    // --- V3 (drop the sawtooth part for one version), V4 (re-add it): an id keeps its anchor
    // across a version that does not use it ---
    await sleep(2000);
    await callTool(client, 'set_code', {
      code: buildProgram([rampCode(1, 'sine'), delayedCode(3), GETTIME_PART]),
      label: 'probe V3',
    });
    await sleep(2000);
    const beforeV4 = await readSchedulerNow(cdp);
    await callTool(client, 'set_code', {
      code: buildProgram([rampCode(1, 'sine'), delayedCode(3), GETTIME_PART, rampCode(2, 'sawtooth')]),
      label: 'probe V4',
    });
    const afterV4 = await readSchedulerNow(cdp);
    const arcV4 = await readArc(cdp, Math.floor(beforeV4) - 1, Math.ceil(afterV4) + 8);
    const sawHap4 = firstBySound(arcV4.haps, 'sawtooth');
    const rampA2b = sawHap4 ? computeRampAnchor(sawHap4) : null;
    report(
      'an id keeps its anchor across a version that does not use it',
      !!rampA2b && rampA2b.consistent && A2 !== null && rampA2b.anchor === A2,
      rampA2b ? `anchor now ${rampA2b.anchor}, was ${A2}` : 'no sawtooth ramp events found in the query window',
    );

    // --- V5 (sine's id 1 written as -1): the opposite id starts a new anchor ---
    const beforeV5 = await readSchedulerNow(cdp);
    await callTool(client, 'set_code', {
      code: buildProgram([rampCode(-1, 'sine'), delayedCode(3), GETTIME_PART, rampCode(2, 'sawtooth')]),
      label: 'probe V5',
    });
    const afterV5 = await readSchedulerNow(cdp);
    const windowV5 = anchorWindow(beforeV5, afterV5);
    const arcV5 = await readArc(cdp, windowV5[0] - 1, windowV5[1] + 8);
    const sineHap5 = firstBySound(arcV5.haps, 'sine');
    const rampA1c = sineHap5 ? computeRampAnchor(sineHap5) : null;
    report(
      'the opposite id starts a new anchor',
      !!rampA1c && rampA1c.consistent && inWindow(rampA1c.anchor, windowV5) && rampA1c.anchor !== A1,
      rampA1c ? `anchor=${rampA1c.anchor} (was ${A1})` : 'no sine ramp events found in the query window',
    );

    // --- two parts sharing one id share one anchor ---
    const beforeShare1 = await readSchedulerNow(cdp);
    await callTool(client, 'set_code', { code: buildProgram([rampCode(5, 'sine')]), label: 'probe shared id 1' });
    const afterShare1 = await readSchedulerNow(cdp);
    const windowShare1 = anchorWindow(beforeShare1, afterShare1);
    const arcShare1 = await readArc(cdp, windowShare1[0] - 1, windowShare1[1] + 8);
    const sineShareHap1 = firstBySound(arcShare1.haps, 'sine');
    const rampShare1 = sineShareHap1 ? computeRampAnchor(sineShareHap1) : null;
    await sleep(2500);
    const beforeShare2 = await readSchedulerNow(cdp);
    await callTool(client, 'set_code', {
      code: buildProgram([rampCode(5, 'sine'), rampCode(5, 'sawtooth')]),
      label: 'probe shared id 2',
    });
    const afterShare2 = await readSchedulerNow(cdp);
    const windowShare2 = anchorWindow(beforeShare2, afterShare2);
    const arcShare2 = await readArc(cdp, windowShare2[0] - 1, windowShare2[1] + 8);
    const sineShareHap2 = firstBySound(arcShare2.haps, 'sine');
    const sawShareHap2 = firstBySound(arcShare2.haps, 'sawtooth');
    const rampShare2Sine = sineShareHap2 ? computeRampAnchor(sineShareHap2) : null;
    const rampShare2Saw = sawShareHap2 ? computeRampAnchor(sawShareHap2) : null;
    report(
      'two parts sharing one id share one anchor',
      !!rampShare1 &&
        rampShare1.consistent &&
        !!rampShare2Sine &&
        rampShare2Sine.consistent &&
        !!rampShare2Saw &&
        rampShare2Saw.consistent &&
        rampShare2Sine.anchor === rampShare1.anchor &&
        rampShare2Saw.anchor === rampShare1.anchor,
      rampShare1 && rampShare2Sine && rampShare2Saw
        ? `first anchor=${rampShare1.anchor}, sine now=${rampShare2Sine.anchor}, sawtooth now=${rampShare2Saw.anchor}`
        : 'missing a sine or sawtooth ramp event in one of the query windows',
    );

    // --- id 0 counts the absolute cycle count ---
    let clockForId0 = await readSchedulerNow(cdp);
    const id0Deadline = Date.now() + 20000;
    while (clockForId0 <= 3 && Date.now() < id0Deadline) {
      await sleep(500);
      clockForId0 = await readSchedulerNow(cdp);
    }
    const beforeId0 = await readSchedulerNow(cdp);
    await callTool(client, 'set_code', { code: buildProgram([rampCode(0, 'sine')]), label: 'probe id 0' });
    const afterId0 = await readSchedulerNow(cdp);
    const windowId0 = anchorWindow(beforeId0, afterId0);
    const arcId0 = await readArc(cdp, windowId0[0] - 1, windowId0[1] + 8);
    const sineHapId0 = firstBySound(arcId0.haps, 'sine');
    const rampId0 = sineHapId0 ? computeRampAnchor(sineHapId0) : null;
    report(
      'id 0 counts the absolute cycle count',
      !!rampId0 && rampId0.consistent && rampId0.anchor === 0 && clockForId0 > 3,
      rampId0
        ? `anchor=${rampId0.anchor} (expected 0), clock waited to reach ${clockForId0.toFixed(4)} (>3) before the change`
        : 'no sine ramp events found in the query window',
    );

    // --- elapsed time is negative before the anchor ---
    const beforeA8 = await readSchedulerNow(cdp);
    await callTool(client, 'set_code', { code: buildProgram([rampCode(8, 'sine')]), label: 'probe id 8' });
    const afterA8 = await readSchedulerNow(cdp);
    const windowA8 = anchorWindow(beforeA8, afterA8);
    const arcA8 = await readArc(cdp, windowA8[0] - 1, windowA8[1] + 8);
    const sineHapA8 = firstBySound(arcA8.haps, 'sine');
    const rampA8 = sineHapA8 ? computeRampAnchor(sineHapA8) : null;
    let negativeElapsedResult = null;
    if (rampA8 && rampA8.consistent) {
      const A8 = rampA8.anchor;
      const arcBeforeA8 = await readArc(cdp, A8 - 2, A8);
      const sineHapsBeforeA8 = arcBeforeA8.haps.filter((hap) => hap.s === 'sine' && hap.begin < A8);
      const negativeElapsedComputed = sineHapsBeforeA8.map(computeRampAnchor);
      const allNegative = negativeElapsedComputed.length > 0 && negativeElapsedComputed.every((r) => r.elapsed < 0);
      const allNearA8 = negativeElapsedComputed.every((r) => Math.abs(r.rawAnchor - A8) < RAMP_TOLERANCE);
      negativeElapsedResult = { A8, count: negativeElapsedComputed.length, allNegative, allNearA8 };
    }
    report(
      'elapsed time is negative before the anchor',
      !!negativeElapsedResult &&
        negativeElapsedResult.count > 0 &&
        negativeElapsedResult.allNegative &&
        negativeElapsedResult.allNearA8,
      negativeElapsedResult
        ? `anchor=${negativeElapsedResult.A8}, haps before the anchor=${negativeElapsedResult.count}, allNegative=${negativeElapsedResult.allNegative}, allNearAnchor=${negativeElapsedResult.allNearA8}`
        : rampA8
          ? `anchor not consistent: raw=${rampA8.rawAnchor}`
          : 'no sine ramp events found in the query window',
    );

    // --- Stop: restarts the cycle count at 0, clears timeline anchors ---
    // Give the absolute cycle count comfortable real time to pass 10 before Stop, so "the cycle
    // before the stop was above 10" is actually true when we check it, not just usually true.
    let cycleBeforeStop = await readSchedulerNow(cdp);
    const stopWaitDeadline = Date.now() + 40000;
    while (cycleBeforeStop <= 11 && Date.now() < stopWaitDeadline) {
      await sleep(1000);
      cycleBeforeStop = await readSchedulerNow(cdp);
    }

    await callTool(client, 'stop', {});
    const beforeStopReplay = await readSchedulerNow(cdp);
    await callTool(client, 'set_code', {
      code: buildProgram([rampCode(1, 'sine'), delayedCode(3), GETTIME_PART]),
      label: 'probe V1 replay after stop',
    });
    const afterStopReplay = await readSchedulerNow(cdp);
    report(
      'Stop restarts the cycle count at 0',
      afterStopReplay < 3 && cycleBeforeStop > 10,
      `cycle before stop=${cycleBeforeStop.toFixed(4)}, after replay=${afterStopReplay.toFixed(4)}`,
    );

    const windowStopReplay = anchorWindow(beforeStopReplay, afterStopReplay);
    const arcStopReplay = await readArc(cdp, windowStopReplay[0] - 1, windowStopReplay[1] + 8);
    const sineHapStop = firstBySound(arcStopReplay.haps, 'sine');
    const rampA1d = sineHapStop ? computeRampAnchor(sineHapStop) : null;
    report(
      'Stop clears timeline anchors',
      !!rampA1d &&
        rampA1d.consistent &&
        inWindow(rampA1d.anchor, windowStopReplay) &&
        rampA1d.anchor !== A1 &&
        Math.abs(rampA1d.anchor) <= 2,
      rampA1d ? `anchor=${rampA1d.anchor} (was ${A1}, expected near 0)` : 'no sine ramp events found in the query window',
    );

    // --- An error from the previous version is labeled earlier and does not taint
    // the next reply ---
    // A signal whose function throws when queried (the suggested vehicle) is caught
    // inside the pinned bundle's own Pattern.queryArc try/catch and logged as "[query] error:
    // ...", not "[cyclist] error:"/"[getTrigger] error: ..." (confirmed live against the pinned
    // bundle, both directly and through this probe). It did not reach the page's strudel.log
    // forwarding when this was written; it is now forwarded, checked in its own steps below, so
    // this step keeps a missing sound name as its vehicle. A missing sample name reliably
    // reaches the page as a real "[getTrigger] error: sound ... not found! Is it loaded?" line
    // (the same mechanism test/e2e.test.js's fake-page cases (n)/(o)/(p) exercise) without
    // changing anything about how sample-loading failures are reported (that stays deferred;
    // this only borrows an existing, unmodified error as the vehicle to prove the tagging).
    const missingSound = `probeEarlierVersion${Date.now()}`;
    const earlierErrorReply = await callTool(client, 'set_code', {
      code: `note("c*16").s("${missingSound}").gain(0)`,
      label: 'probe earlier-version setup',
    });
    const earlierErrorOwnReplyOk =
      earlierErrorReply.includes('Runtime error while playing') && earlierErrorReply.includes(missingSound);
    await sleep(2500);
    const goodAfterEarlierReply = await callTool(client, 'set_code', {
      code: 's("bd*4").gain(0)',
      label: 'probe earlier-version good',
    });
    report(
      'an error from the previous version is labeled earlier and does not taint the next reply',
      earlierErrorOwnReplyOk &&
        goodAfterEarlierReply.startsWith('ok, playing') &&
        // The real server has a history store, so the earlier line now carries a version.
        goodAfterEarlierReply.includes('Runtime error from an earlier version (#') &&
        goodAfterEarlierReply.includes(missingSound),
      `first reply: ${JSON.stringify(earlierErrorReply)}; second reply: ${JSON.stringify(goodAfterEarlierReply)}`,
    );

    // --- An unknown chord inside .voicing() reaches Claude ---
    const unknownChordReply = await callTool(client, 'set_code', {
      code: 'chord("Cfoo").voicing().s("sine").gain(0)',
      label: 'probe unknown chord',
    });
    report(
      'an unknown chord inside .voicing() reaches Claude',
      unknownChordReply.startsWith('Playing, but with runtime errors (see below).') &&
        unknownChordReply.includes('unknown chord "Cfoo" in .voicing(): it plays nothing'),
      `reply: ${JSON.stringify(unknownChordReply)}`,
    );

    // --- code whose first cycle cannot be queried is refused before it takes over ---
    // The vehicle is the shape of a real bug report: a string built in JavaScript with + and .join()
    // and passed to note(). It evaluates fine and throws only when Strudel queries it, so before
    // this check it took over, played nothing, and Claude heard "ok, playing".
    const queryGoodA = 'note("c3 e3").gain(0)';
    const queryBadCode = [
      "const probeList = ['a2', 'e3']",
      `note("c3 e3").add(note('<' + probeList.join(' ') + '>')).gain(0)`,
    ].join('\n');
    const queryGoodSilent = 's("bd*4").gain(0)';
    const replStateExpr =
      `(() => { const s = document.getElementById('repl').editor.repl.state; ` +
      `return { activeCode: s.activeCode, started: !!s.started, evalError: s.evalError ? String(s.evalError.message ?? s.evalError) : null }; })()`;
    await callTool(client, 'set_code', { code: queryGoodA, label: 'probe query-check good A' });
    let queryRefusalError = null;
    try {
      await callTool(client, 'set_code', { code: queryBadCode, label: 'probe query-check bad' });
    } catch (err) {
      queryRefusalError = err instanceof Error ? err.message : String(err);
    }
    const queryStateAfter = await evaluateExpr(cdp, replStateExpr);
    const queryGetCodeAfter = await callTool(client, 'get_code', {});
    report(
      'a change whose first cycle fails when queried is refused and the previous music keeps playing',
      queryRefusalError !== null &&
        queryRefusalError.startsWith('Evaluation failed: ' + QUERY_REFUSAL_LEAD) &&
        // The tool error carries notice lines after the failure text (a blank line apart), so the tail is
        // checked on the failure paragraph.
        queryRefusalError.split('\n\n')[0].endsWith('The previous code is still playing.') &&
        queryStateAfter.activeCode === queryGoodA &&
        queryStateAfter.started === true &&
        queryGetCodeAfter.includes(queryGoodA),
      `error: ${JSON.stringify(queryRefusalError)}; state: ${JSON.stringify(queryStateAfter)}; get_code: ${JSON.stringify(queryGetCodeAfter)}`,
    );
    // Follow-up: the refused program has already run its setcps when the previous music keeps
    // playing; the page puts the previous tempo back, or the old music would play at the refused tempo.
    const tempoGoodCode = 'setcps(0.5)\nnote("c3 e3").gain(0)';
    await callTool(client, 'set_code', { code: tempoGoodCode, label: 'probe tempo good' });
    let tempoRefusal = null;
    try {
      await callTool(client, 'set_code', { code: 'setcps(1)\n' + queryBadCode, label: 'probe tempo refused' });
    } catch (err) {
      tempoRefusal = err instanceof Error ? err.message : String(err);
    }
    // The page's scheduler applies setCps at once, so its cps is the tempo that plays right away.
    const tempoAfter = await evaluateExpr(cdp, `document.getElementById('repl').editor.repl.scheduler.cps`);
    report(
      'a refused change puts the tempo of the music that keeps playing back',
      tempoRefusal !== null && tempoRefusal.includes(QUERY_REFUSAL_LEAD) && tempoAfter === 0.5,
      `error: ${JSON.stringify(tempoRefusal)}; scheduler cps: ${JSON.stringify(tempoAfter)}`,
    );
    // The tempo that plays can also come from a `cps` pattern control, which the scheduler's tick applies
    // without going through setCps. A refused change then restores that tempo, not the last setcps value.
    const schedulerCpsExpr = `document.getElementById('repl').editor.repl.scheduler.cps`;
    await callTool(client, 'set_code', { code: 'setcps(0.5)\nnote("c3 e3").gain(0)', label: 'probe tempo control start' });
    await callTool(client, 'set_code', { code: 'note("c3 e3").cps(0.8).gain(0)', label: 'probe tempo control' });
    const tempoControlPlaying = await waitFor(cdp, `${schedulerCpsExpr} === 0.8 ? true : null`, 8000);
    await callTool(client, 'set_code', { code: 'note("c3 e3").gain(0)', label: 'probe tempo control plain' });
    let tempoControlRefusal = null;
    try {
      await callTool(client, 'set_code', { code: 'setcps(1)\n' + queryBadCode, label: 'probe tempo control refused' });
    } catch (err) {
      tempoControlRefusal = err instanceof Error ? err.message : String(err);
    }
    const tempoControlAfter = await evaluateExpr(cdp, schedulerCpsExpr);
    report(
      'a refused change restores a tempo that a cps control set, not the last setcps value',
      tempoControlPlaying === true &&
        tempoControlRefusal !== null &&
        tempoControlRefusal.includes(QUERY_REFUSAL_LEAD) &&
        tempoControlAfter === 0.8,
      `playing: ${JSON.stringify(tempoControlPlaying)}; error: ${JSON.stringify(tempoControlRefusal)}; scheduler cps: ${JSON.stringify(tempoControlAfter)}`,
    );
    await callTool(client, 'set_code', { code: 'setcps(0.5)\nnote("c3 e3").gain(0)', label: 'probe tempo control reset' });
    await callTool(client, 'set_code', { code: queryGoodSilent, label: 'probe query-check clean' });

    // A hand evaluation (an evaluation with no Moontide flag) of the same code follows the
    // same rule: the old music keeps playing and the page shows the error line.
    await callTool(client, 'set_code', { code: queryGoodA, label: 'probe query-check hand good A' });
    const handBadSource = JSON.stringify(queryBadCode);
    await evaluateExpr(
      cdp,
      `(() => { const editor = document.getElementById('repl').editor; editor.setCode(${handBadSource}); ` +
        `Promise.resolve(editor.evaluate()).catch(() => {}); return true; })()`,
    );
    const handErrorLine = await waitFor(
      cdp,
      `(() => { const el = document.getElementById('eval-error'); return el && !el.hidden && el.textContent ? el.textContent : null; })()`,
      8000,
    );
    const handStateAfter = await evaluateExpr(cdp, replStateExpr);
    const handNextReply = await callTool(client, 'get_code', {});
    const handNoteLine =
      handNextReply.split('\n').find((line) => line.startsWith('Note: an edit evaluated by hand in the page failed:')) ?? null;
    report(
      'a hand evaluation whose first cycle fails when queried keeps the previous music and shows the error line',
      typeof handErrorLine === 'string' &&
        handErrorLine.includes('fails when queried') &&
        handStateAfter.activeCode === queryGoodA &&
        handStateAfter.started === true &&
        handNoteLine !== null &&
        handNoteLine.includes('fails when queried'),
      `error line: ${JSON.stringify(handErrorLine)}; state: ${JSON.stringify(handStateAfter)}; note line: ${JSON.stringify(handNoteLine)}`,
    );
    await callTool(client, 'set_code', { code: queryGoodSilent, label: 'probe query-check hand clean' });

    // Code that passes its first cycle and fails from a later cycle plays fine at first, so
    // set_code answers "ok, playing". getTime() is read at evaluation, so the failure starts two cycles
    // after the change, past the one-cycle test window. The failing cycle logs the same text about once
    // a second; Claude hears it once per change, never once per tick.
    const queryLaterCode = [
      'const probeFrom = getTime()',
      `note("c3 e3").add(note(signal((t) => (t - probeFrom >= 2 ? 'zz' : 0)).segment(2))).gain(0)`,
    ].join('\n');
    const queryLaterSetReply = await callTool(client, 'set_code', { code: queryLaterCode, label: 'probe later query error' });
    // Failing cycles start at about 4 s at the default tempo; three failing cycles are over at about 10 s.
    await sleep(11000);
    const queryLaterFirst = await callTool(client, 'get_code', {});
    const queryLaterFirstLines = queryLaterFirst.split('\n').filter((line) => line.includes(QUERY_ERROR_LEAD));
    await sleep(4000);
    const queryLaterSecond = await callTool(client, 'get_code', {});
    const queryLaterSecondLines = queryLaterSecond.split('\n').filter((line) => line.includes(QUERY_ERROR_LEAD));
    report(
      'a query error that starts later reaches Claude once per change, never once per tick',
      queryLaterSetReply.startsWith('ok, playing') && queryLaterFirstLines.length === 1 && queryLaterSecondLines.length === 0,
      `set_code reply start: ${JSON.stringify(queryLaterSetReply.slice(0, 60))}; first get_code lines: ${JSON.stringify(queryLaterFirstLines)}; second get_code lines: ${JSON.stringify(queryLaterSecondLines)}`,
    );

    // The next good change clears it.
    const queryClearReply = await callTool(client, 'set_code', { code: queryGoodSilent, label: 'probe later query error cleared' });
    await sleep(4000);
    const queryClearNext = await callTool(client, 'get_code', {});
    const queryClearLines = queryClearNext.split('\n').filter((line) => line.includes(QUERY_ERROR_LEAD));
    report(
      'the next good change clears a later query error',
      queryClearReply.startsWith('ok, playing') && queryClearLines.length === 0,
      `set_code reply start: ${JSON.stringify(queryClearReply.slice(0, 60))}; get_code lines: ${JSON.stringify(queryClearLines)}`,
    );

    // The same later failure with a painter in the code. `.punchcard()` registers a painter with
    // the Drawer (onPaint), so the Drawer queries the playing pattern up to two cycles ahead of the scheduler on
    // every animation frame, with no cyclist control, and logs the failing text first; Strudel's 1 s log debounce
    // would then swallow the scheduler's own log of it. The pinned bundle's pianoroll painter runs its own loop
    // instead and registers no Drawer painter, so it did not cover this path. The scheduler's own query errors
    // reach Claude through the query scope's onError, never through Strudel's debounced log, so the report
    // still arrives once.
    const queryPainterCode = [
      'const probeFrom = getTime()',
      `note("c3 e3").add(note(signal((t) => (t - probeFrom >= 2 ? 'zz' : 0)).segment(2))).gain(0).punchcard()`,
    ].join('\n');
    const queryPainterSetReply = await callTool(client, 'set_code', { code: queryPainterCode, label: 'probe later query error with a painter' });
    // The Drawer looks ahead only when the code registered a painter: its draw time is [-2, 2] then, [0, 0] otherwise.
    const queryPainterDrawTime = await evaluateExpr(cdp, "document.getElementById('repl').editor.drawer.drawTime");
    await sleep(11000);
    const queryPainterFirst = await callTool(client, 'get_code', {});
    const queryPainterFirstLines = queryPainterFirst.split('\n').filter((line) => line.includes(QUERY_ERROR_LEAD));
    await sleep(4000);
    const queryPainterSecond = await callTool(client, 'get_code', {});
    const queryPainterSecondLines = queryPainterSecond.split('\n').filter((line) => line.includes(QUERY_ERROR_LEAD));
    report(
      'a query error that starts later reaches Claude once even when a painter queries ahead of the scheduler',
      queryPainterSetReply.startsWith('ok, playing') &&
        Array.isArray(queryPainterDrawTime) &&
        queryPainterDrawTime[1] > 0 &&
        queryPainterFirstLines.length === 1 &&
        queryPainterSecondLines.length === 0,
      `set_code reply start: ${JSON.stringify(queryPainterSetReply.slice(0, 60))}; drawer drawTime: ${JSON.stringify(queryPainterDrawTime)}; first get_code lines: ${JSON.stringify(queryPainterFirstLines)}; second get_code lines: ${JSON.stringify(queryPainterSecondLines)}`,
    );
    await callTool(client, 'set_code', { code: queryGoodSilent, label: 'probe later query error with a painter cleared' });

    // --- a comma-path VCSL sound loads from the pinned jsDelivr host ---
    const vcslBaseCheck = await evaluateExpr(
      cdp,
      `(() => {
        if (typeof globalThis.soundMap?.get !== 'function') {
          return { ok: false, reason: 'globalThis.soundMap.get is not a function' };
        }
        const map = globalThis.soundMap.get();
        const base = ${JSON.stringify(VCSL_SAMPLE_BASE)};
        // .data.samples is an array of URLs for some sets, or an object keyed by note whose
        // values are arrays of URLs (velocity layers) for others (e.g. VCSL's kalimba) —
        // flatten recursively down to the leaf URL strings either way.
        const flattenUrls = (value) => {
          if (Array.isArray(value)) return value.flatMap(flattenUrls);
          if (value && typeof value === 'object') return Object.values(value).flatMap(flattenUrls);
          return [value];
        };
        const urlsOf = (entry) => {
          const samples = entry && entry.data && entry.data.samples;
          return samples === undefined || samples === null ? [] : flattenUrls(samples);
        };
        let offHostCount = 0;
        for (const entry of Object.values(map)) {
          for (const url of urlsOf(entry)) {
            if (typeof url === 'string' && url.includes('/sgossner/VCSL') && !url.startsWith(base)) {
              offHostCount++;
            }
          }
        }
        const kalimbaUrls = urlsOf(map.kalimba).filter((url) => typeof url === 'string');
        const kalimbaAllFromBase = kalimbaUrls.length > 0 && kalimbaUrls.every((url) => url.startsWith(base));
        return { ok: true, offHostCount, kalimbaUrls, kalimbaAllFromBase };
      })()`,
    );
    let kalimbaFetch = { ok: false, status: null };
    if (vcslBaseCheck.ok && vcslBaseCheck.kalimbaUrls.length > 0) {
      kalimbaFetch = await evaluateExpr(
        cdp,
        `fetch(${JSON.stringify(vcslBaseCheck.kalimbaUrls[0])}).then((r) => ({ ok: r.ok, status: r.status })).catch((err) => ({ ok: false, status: null, error: String(err) }))`,
      );
    }
    await callTool(client, 'set_code', { code: 'note("a4").s("kalimba").gain(0)', label: 'probe VCSL kalimba' });
    await sleep(3000);
    const kalimbaGetCode = await callTool(client, 'get_code', {});
    const kalimbaPass =
      vcslBaseCheck.ok &&
      vcslBaseCheck.kalimbaAllFromBase &&
      vcslBaseCheck.offHostCount === 0 &&
      kalimbaFetch.ok &&
      !kalimbaGetCode.includes('failed to load');
    report(
      'a VCSL sound with a comma in its folder name loads from the pinned jsDelivr host',
      kalimbaPass,
      vcslBaseCheck.ok
        ? `kalimbaAllFromBase=${vcslBaseCheck.kalimbaAllFromBase}, offHostCount=${vcslBaseCheck.offHostCount}, fetch=${JSON.stringify(kalimbaFetch)}, get_code mentions a failure=${kalimbaGetCode.includes('failed to load')}`
        : vcslBaseCheck.reason,
    );

    // --- a sound that fails two cycles after set_code answered is named to Claude
    // with its version, on the next tool call ---
    const lateFailureCode = [
      "samples({ probefail: ['probe.wav'] }, 'http://127.0.0.1:9/')",
      'note("c").s("probefail").gain(0).mask(signal((t) => t >= 2).timeline(9))',
    ].join('\n');
    const lateFailureSetCodeReply = await callTool(client, 'set_code', {
      code: lateFailureCode,
      label: 'probe late sound failure',
    });
    const noticeLines = (text) => text.split('\n').filter((line) => line.startsWith('Runtime error'));
    const setCodeReplyHasNoNotice = noticeLines(lateFailureSetCodeReply).length === 0;

    const listHistoryReply = await callTool(client, 'list_history', {});
    const historyLine = listHistoryReply.split('\n').find((line) => line.includes('"probe late sound failure"'));
    const idMatch = historyLine ? /^#(\d+)/.exec(historyLine.trim()) : null;
    const lateFailureId = idMatch ? idMatch[1] : null;

    // Every tool reply drains the notices, so if list_history's own reply already carries the
    // probefail notice (a real "Runtime error ..." line, not just the code text echoed in the
    // history row), it is the reply to check; otherwise poll get_code.
    let lateFailureReply = noticeLines(listHistoryReply).some((line) => line.includes('probefail'))
      ? listHistoryReply
      : null;
    if (!lateFailureReply) {
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline && !lateFailureReply) {
        const poll = await callTool(client, 'get_code', {});
        if (poll.includes('sound "probefail" failed to load')) {
          lateFailureReply = poll;
          break;
        }
        await sleep(1000);
      }
    }
    const probefailNoticeLines = lateFailureReply
      ? noticeLines(lateFailureReply).filter((line) => line.includes('probefail'))
      : [];
    const versionedPattern =
      lateFailureId !== null
        ? new RegExp(`Runtime error while playing #${lateFailureId}: sound "probefail" failed to load \\(Failed to fetch`)
        : null;
    report(
      'a sound that fails after set_code answered is named, with its version, on the next tool call',
      setCodeReplyHasNoNotice &&
        lateFailureSetCodeReply.startsWith('ok, playing') &&
        lateFailureReply !== null &&
        versionedPattern !== null &&
        versionedPattern.test(lateFailureReply) &&
        probefailNoticeLines.length === 1,
      `set_code reply: ${JSON.stringify(lateFailureSetCodeReply)}; history line: ${JSON.stringify(historyLine)}; late reply: ${JSON.stringify(lateFailureReply)}`,
    );
    // Stop the failing pattern before any later check runs.
    await callTool(client, 'set_code', { code: 's("bd*4").gain(0)', label: 'probe stop late failure' });

    // --- Tracks and views ---

    const acornCheck = await evaluateExpr(
      cdp,
      `(() => ({
        version: window.acorn && window.acorn.version,
        hasParse: typeof window.acorn?.parse === 'function',
        hasM: typeof globalThis.m === 'function',
      }))()`,
    );
    report(
      "the page has the pinned parser and Strudel's m() string reader",
      acornCheck.version === '8.18.0' && acornCheck.hasParse === true && acornCheck.hasM === true,
      JSON.stringify(acornCheck),
    );

    const TIMELINE_LABELS_PROGRAM = [
      'setcpm(30)',
      'const low = "<c2 g2>"',
      'one: note("c4 e4 g4 b4").s("triangle").gain(0)',
      'two: note(low).s("sawtooth").gain(0)',
      'three: s("square*8").degradeBy(0.3).gain(0)',
      'four: note("<[c3,e3,g3] [a2,c3,e3]>").s("sine").gain(0)',
    ].join('\n');
    await callTool(client, 'set_code', { code: TIMELINE_LABELS_PROGRAM, label: 'probe timeline labels' });
    await evaluateExpr(cdp, `(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); })()`);
    await pressKey(cdp, '2');
    await waitFor(
      cdp,
      `(() => { const s = document.getElementById('timeline-view').dataset.state; return s && s !== 'computing' ? s : null; })()`,
      5000,
    );
    const timelineLanesDetail = await evaluateExpr(
      cdp,
      `(() => {
        const view = document.getElementById('timeline-view');
        const lanes = [...document.querySelectorAll('#timeline-lanes .lane')];
        return {
          state: view.dataset.state,
          computeMs: view.dataset.computeMs,
          longestSliceMs: view.dataset.longestSliceMs,
          names: lanes.map((l) => l.querySelector('.lane-name').textContent),
          events: lanes.map((l) => Number(l.dataset.events)),
        };
      })()`,
    );
    await pressKey(cdp, '2');
    // Closing now fades out (up to 150ms with motion on) before #view-panel is
    // actually hidden — wait for it instead of reading immediately.
    const panelHiddenAfterClose = await waitFor(
      cdp,
      `(() => (document.getElementById('view-panel').hidden ? true : null))()`,
      1000,
    );
    report(
      'key 2 opens the Timeline with one lane per labeled track, drawn from the real pattern',
      timelineLanesDetail.state === 'ok' &&
        JSON.stringify(timelineLanesDetail.names) === JSON.stringify(['one', 'two', 'three', 'four']) &&
        timelineLanesDetail.events.every((count) => count > 0) &&
        panelHiddenAfterClose === true,
      `state=${timelineLanesDetail.state}, names=${JSON.stringify(timelineLanesDetail.names)}, events=${JSON.stringify(timelineLanesDetail.events)}, data-compute-ms=${timelineLanesDetail.computeMs}, data-longest-slice-ms=${timelineLanesDetail.longestSliceMs}, panelHiddenAfterClose=${panelHiddenAfterClose}`,
    );

    // A key the page does not take (Escape with no view open) reaches it once. When pressKey sent a native key code,
    // Chrome on macOS sent such a key back to the page endlessly, and the page's timers stalled for seconds.
    await evaluateExpr(cdp, `(() => { window.__probeKeydowns = 0; document.addEventListener('keydown', () => { window.__probeKeydowns++; }, true); })()`);
    await pressKey(cdp, 'Escape');
    await sleep(500);
    const keydownsForOneEscape = await evaluateExpr(cdp, 'window.__probeKeydowns');
    report('a key the page does not take reaches it once', keydownsForOneEscape === 1, `keydowns=${keydownsForOneEscape}`);

    // Focus the code, then prove keys are inert there and Escape leaves it. The typed '2' below
    // is an unevaluated edit — the next set_code (in a later check) replaces it, never evaluated.
    await evaluateExpr(cdp, `(() => { const el = document.querySelector('#editor-area .cm-content'); if (el) el.focus(); })()`);
    await pressKey(cdp, '2');
    const panelHiddenWhileTyping = await evaluateExpr(cdp, `document.getElementById('view-panel').hidden`);
    await pressKey(cdp, 'Escape');
    const stillInEditorAfterEscape = await evaluateExpr(
      cdp,
      `document.getElementById('editor-area').contains(document.activeElement)`,
    );
    await pressKey(cdp, '2');
    const panelHiddenAfterEscapeThen2 = await evaluateExpr(cdp, `document.getElementById('view-panel').hidden`);
    await pressKey(cdp, '2');
    report(
      'view keys are inert while the cursor is in the code, and Escape leaves the code',
      panelHiddenWhileTyping === true && stillInEditorAfterEscape === false && panelHiddenAfterEscapeThen2 === false,
      `panelHiddenWhileTyping=${panelHiddenWhileTyping}, stillInEditorAfterEscape=${stillInEditorAfterEscape}, panelHiddenAfterEscapeThen2=${panelHiddenAfterEscapeThen2}`,
    );

    // With no instruments.json, the Instruments view names the real data folder, shown as text.
    // Placed before any block that could leave an instruments.json behind (none writes one). The server of this
    // probe was started with MOONTIDE_DATA_DIR = dataDir, so the page must show exactly path.resolve(dataDir). The
    // detail never prints the path: only whether it matches and how long it is.
    await pressKey(cdp, '6');
    await waitFor(
      cdp,
      `(() => {
        const text = document.getElementById('instruments-message-text');
        const folder = document.getElementById('instruments-folder');
        return text.textContent === ${JSON.stringify(INSTRUMENTS_COPY.absentLeadFolder)} && !folder.hidden ? true : null;
      })()`,
      5000,
    );
    const instrumentsFolderDetail = await evaluateExpr(
      cdp,
      `(() => {
        const folder = document.getElementById('instruments-folder');
        const sub = document.getElementById('instruments-message-sub');
        return {
          lead: document.getElementById('instruments-message-text').textContent,
          folderHidden: folder.hidden,
          folderText: folder.textContent,
          folderChildren: folder.childElementCount,
          sub: sub.hidden ? null : sub.textContent,
          cards: document.querySelectorAll('.instrument-card').length,
        };
      })()`,
    );
    const instrumentsFolderMatches = instrumentsFolderDetail.folderText === path.resolve(dataDir);
    await pressKey(cdp, 'Escape');
    report(
      'instruments view: with no file the sentence names the real data folder',
      instrumentsFolderDetail.lead === INSTRUMENTS_COPY.absentLeadFolder &&
        instrumentsFolderDetail.sub === INSTRUMENTS_COPY.absentSub &&
        instrumentsFolderDetail.folderHidden === false &&
        instrumentsFolderMatches &&
        instrumentsFolderDetail.folderChildren === 0 &&
        instrumentsFolderDetail.cards === 0,
      `lead=${JSON.stringify(instrumentsFolderDetail.lead)}, sub=${JSON.stringify(instrumentsFolderDetail.sub)}, folderHidden=${instrumentsFolderDetail.folderHidden}, folderMatches=${instrumentsFolderMatches}, folderLength=${instrumentsFolderDetail.folderText.length}, folderChildren=${instrumentsFolderDetail.folderChildren}, cards=${instrumentsFolderDetail.cards}`,
    );

    // The key and button, the remembered view and the problem states of the Instruments view.
    await instrumentsViewChecks({ cdp, dataDir, report, client });

    // A three-line program whose solo program cannot reproduce the reassignment (soloSource
    // only keeps declarations, never a later assignment): the real code plays "e3" but the
    // solo pattern for "one" still plays "c3" — the split must not match, and the view must
    // say so instead of drawing a false lane.
    const MISMATCH_PROGRAM = ['let step = "c3"', 'step = "e3"', 'one: note(step).s("sine").gain(0)'].join('\n');
    await callTool(client, 'set_code', { code: MISMATCH_PROGRAM, label: 'probe timeline mismatch' });
    await pressKey(cdp, '2');
    await waitFor(
      cdp,
      `(() => { const s = document.getElementById('timeline-view').dataset.state; return s && s !== 'computing' ? s : null; })()`,
      5000,
    );
    const mismatchDetail = await evaluateExpr(
      cdp,
      `(() => ({
        state: document.getElementById('timeline-view').dataset.state,
        message: document.getElementById('timeline-message').textContent,
        // The ruler/lanes/playhead now hide together as #timeline-body,
        // not #timeline-lanes alone.
        bodyHidden: document.getElementById('timeline-body').hidden,
      }))()`,
    );
    await pressKey(cdp, '2');
    report(
      'a per-track split that does not match the real pattern shows the failed line, never lanes',
      mismatchDetail.state === 'failed' && mismatchDetail.message === TIMELINE_COPY.failed && mismatchDetail.bodyHidden === true,
      JSON.stringify(mismatchDetail),
    );

    // A transition anchored with .timeline(id): the Timeline's drawn begin must come from the
    // real anchor (the cycle the change landed in, or the next one — an earlier check proved this), not
    // from the page start. Wait until the scheduler is at least 3 cycles into its own 32-cycle
    // page, so an anchor taken from the page start and the real one cannot coincide by chance.
    let beforeAnchor = await readSchedulerNow(cdp);
    const anchorWaitDeadline = Date.now() + 20000;
    while (beforeAnchor % 32 < 3 && Date.now() < anchorWaitDeadline) {
      await sleep(500);
      beforeAnchor = await readSchedulerNow(cdp);
    }
    await callTool(client, 'set_code', {
      code: 'one: note("c4*4").s("sine").mask(signal((t) => t >= 2).timeline(7)).gain(0)',
      label: 'probe timeline anchor',
    });
    await pressKey(cdp, '2');
    await waitFor(
      cdp,
      `(() => { const s = document.getElementById('timeline-view').dataset.state; return s === 'ok' ? s : null; })()`,
      5000,
    );
    const anchorDetail = await evaluateExpr(
      cdp,
      `(() => {
        const lane = document.querySelector('#timeline-lanes .lane');
        return { state: document.getElementById('timeline-view').dataset.state, firstBegin: lane ? Number(lane.dataset.firstBegin) : null };
      })()`,
    );
    await pressKey(cdp, '2');
    const expectedMinBegin = Math.floor(beforeAnchor) + 2;
    report(
      'a transition anchored with .timeline(id) is drawn from its real anchor',
      anchorDetail.state === 'ok' && anchorDetail.firstBegin !== null && anchorDetail.firstBegin >= expectedMinBegin,
      `firstBegin=${anchorDetail.firstBegin}, expected at least ${expectedMinBegin} (before=${beforeAnchor.toFixed(4)})`,
    );

    // Every labeled shape at once: all(fn)/each(fn) wrapping, two $: tracks disambiguated by
    // their sound (never a fake "$"), and an underscore-muted label with a real lane but no
    // events. The "c4 e4".fast(2) part proves string methods work through the page's own m().
    const LABEL_SHAPES_PROGRAM = [
      'all(x => x.gain(0))',
      '$: note("c4 e4".fast(2)).s("triangle")',
      '$: note("g3").s("triangle")',
      '_hidden: s("square*2")',
      'each(x => x.room(0.1))',
    ].join('\n');
    await callTool(client, 'set_code', { code: LABEL_SHAPES_PROGRAM, label: 'probe timeline label shapes' });
    await pressKey(cdp, '2');
    await waitFor(
      cdp,
      `(() => { const s = document.getElementById('timeline-view').dataset.state; return s && s !== 'computing' ? s : null; })()`,
      5000,
    );
    const labelShapesDetail = await evaluateExpr(
      cdp,
      `(() => {
        const lanes = [...document.querySelectorAll('#timeline-lanes .lane')];
        return {
          state: document.getElementById('timeline-view').dataset.state,
          names: lanes.map((l) => l.querySelector('.lane-name').textContent),
          events: lanes.map((l) => Number(l.dataset.events)),
        };
      })()`,
    );
    await pressKey(cdp, '2');
    report(
      'labeled shapes ($:, muted, each, all) split exactly like the real pattern',
      labelShapesDetail.state === 'ok' &&
        JSON.stringify(labelShapesDetail.names) === JSON.stringify(['triangle', 'triangle 2', 'hidden']) &&
        labelShapesDetail.events[2] === 0,
      JSON.stringify(labelShapesDetail),
    );

    // --- A program without labels splits by stack() branch, named by its sound ---
    const NO_LABEL_BRANCHES_PROGRAM =
      'stack(note("c4 e4").s("triangle"), s("square*4"), note("<g3 b3>").s("sawtooth")).gain(0)';
    await callTool(client, 'set_code', { code: NO_LABEL_BRANCHES_PROGRAM, label: 'probe timeline branches' });
    await pressKey(cdp, '2');
    await waitFor(
      cdp,
      `(() => { const s = document.getElementById('timeline-view').dataset.state; return s && s !== 'computing' ? s : null; })()`,
      5000,
    );
    const branchesDetail = await evaluateExpr(
      cdp,
      `(() => {
        const lanes = [...document.querySelectorAll('#timeline-lanes .lane')];
        return {
          state: document.getElementById('timeline-view').dataset.state,
          names: lanes.map((l) => l.querySelector('.lane-name').textContent),
        };
      })()`,
    );
    await pressKey(cdp, '2');
    report(
      'a program without labels shows one lane per stack() branch, named by its sound',
      branchesDetail.state === 'ok' && JSON.stringify(branchesDetail.names) === JSON.stringify(['triangle', 'square*4', 'sawtooth']),
      JSON.stringify(branchesDetail),
    );

    // --- Nested stacks open, a runtime-conditional branch is "Unnamed N" ---
    const NESTED_CONDITIONAL_PROGRAM = [
      'const on = true',
      'stack(note("c4").s("sine"), on ? s("square*2") : s("triangle*2"), stack(note("e4").s("sawtooth"), note("g4").s("sine")).fast(2)).gain(0)',
    ].join('\n');
    await callTool(client, 'set_code', { code: NESTED_CONDITIONAL_PROGRAM, label: 'probe timeline nested' });
    await pressKey(cdp, '2');
    await waitFor(
      cdp,
      `(() => { const s = document.getElementById('timeline-view').dataset.state; return s && s !== 'computing' ? s : null; })()`,
      5000,
    );
    const nestedDetail = await evaluateExpr(
      cdp,
      `(() => {
        const lanes = [...document.querySelectorAll('#timeline-lanes .lane')];
        return {
          state: document.getElementById('timeline-view').dataset.state,
          names: lanes.map((l) => l.querySelector('.lane-name').textContent),
        };
      })()`,
    );
    await pressKey(cdp, '2');
    report(
      'nested stacks and a conditional branch split exactly like the real pattern',
      nestedDetail.state === 'ok' && JSON.stringify(nestedDetail.names) === JSON.stringify(['sine', 'Unnamed 1', 'sawtooth', 'sine 2']),
      JSON.stringify(nestedDetail),
    );

    // --- The playhead crosses the 32-cycle page and the page turns at cycle 32.
    // setcps(4) makes a page last 8 real seconds (32 cycles / 4 cycles-per-second) so the turn
    // is observable well inside a short deadline; tempo is set back to the default right after. ---
    const PAGE_TURN_PROGRAM = ['setcps(4)', 'one: note("c4 e4").s("sine").gain(0)', 'two: s("square*2").gain(0)'].join('\n');
    await callTool(client, 'set_code', { code: PAGE_TURN_PROGRAM, label: 'probe timeline page turn' });
    await evaluateExpr(cdp, `(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); })()`);
    await pressKey(cdp, '2');
    await waitFor(
      cdp,
      `(() => { const s = document.getElementById('timeline-view').dataset.state; return s === 'ok' ? s : null; })()`,
      5000,
    );
    const pageTurnStart = await evaluateExpr(cdp, `Number(document.getElementById('timeline-view').dataset.pageStart)`);
    const pageTurnLeft1 = await evaluateExpr(cdp, `document.getElementById('timeline-playhead').style.left`);
    await sleep(300);
    const pageTurnLeft2 = await evaluateExpr(cdp, `document.getElementById('timeline-playhead').style.left`);
    const playheadMoved = pageTurnLeft1 !== pageTurnLeft2;

    const pageTurnDeadline = Date.now() + 12000;
    let nowAtPageTurn = await readSchedulerNow(cdp);
    while (nowAtPageTurn < pageTurnStart + 32.5 && Date.now() < pageTurnDeadline) {
      await sleep(200);
      nowAtPageTurn = await readSchedulerNow(cdp);
    }
    const turnedPageStart = await waitFor(
      cdp,
      `(() => {
        const view = document.getElementById('timeline-view');
        return view.dataset.state === 'ok' && Number(view.dataset.pageStart) === ${pageTurnStart} + 32 ? Number(view.dataset.pageStart) : null;
      })()`,
      1000,
    );
    report(
      'the playhead crosses the page and the page turns at cycle 32',
      playheadMoved && nowAtPageTurn >= pageTurnStart + 32.5 && turnedPageStart === pageTurnStart + 32,
      `pageStart=${pageTurnStart}, left1=${pageTurnLeft1}, left2=${pageTurnLeft2}, nowAtPageTurn=${nowAtPageTurn.toFixed(3)}, turnedPageStart=${turnedPageStart}`,
    );
    await pressKey(cdp, '2');
    await callTool(client, 'set_code', {
      code: ['setcps(0.5)', 'one: s("bd*4").gain(0)'].join('\n'),
      label: 'probe tempo back',
    });

    // --- Notes sit at their pitch and percussion shows as ticks ---
    const TIMELINE_SHAPES_PROGRAM = ['one: note("<c3 c5>").s("sine").gain(0)', 'two: s("square*4").gain(0)'].join('\n');
    await callTool(client, 'set_code', { code: TIMELINE_SHAPES_PROGRAM, label: 'probe timeline shapes' });
    await pressKey(cdp, '2');
    await waitFor(
      cdp,
      `(() => { const s = document.getElementById('timeline-view').dataset.state; return s === 'ok' ? s : null; })()`,
      5000,
    );
    const shapesDetail = await evaluateExpr(
      cdp,
      `(() => {
        const lanes = [...document.querySelectorAll('#timeline-lanes .lane')];
        return lanes.map((lane) => {
          const rects = [...lane.querySelectorAll('rect.event')];
          return {
            kinds: [...new Set(rects.map((r) => r.getAttribute('data-kind')))],
            distinctY: [...new Set(rects.map((r) => r.getAttribute('y')))].length,
            sub: lane.querySelector('.lane-sub').textContent,
            loopMarks: lane.querySelectorAll('line.loop-mark').length,
            color: lane.dataset.color,
          };
        });
      })()`,
    );
    await pressKey(cdp, '2');
    const [laneOneShapes, laneTwoShapes] = shapesDetail;
    report(
      'notes sit at their pitch and percussion shows as ticks',
      !!laneOneShapes &&
        !!laneTwoShapes &&
        JSON.stringify(laneOneShapes.kinds) === JSON.stringify(['note']) &&
        laneOneShapes.distinctY === 2 &&
        laneOneShapes.sub === 'repeats every 2 cycles' &&
        laneOneShapes.loopMarks === 15 &&
        JSON.stringify(laneTwoShapes.kinds) === JSON.stringify(['tick']) &&
        laneTwoShapes.sub === 'repeats every cycle' &&
        laneTwoShapes.loopMarks === 0 &&
        laneOneShapes.color !== laneTwoShapes.color,
      JSON.stringify(shapesDetail),
    );

    // --- Hpf and bpf write hcutoff and bandf, and only signal-driven filters
    // draw a curve ---
    const TIMELINE_CURVES_PROGRAM = [
      'one: note("c4*4").s("sine").hpf(sine.range(200, 800).slow(4)).gain(0)',
      'two: note("e4*4").s("sine").bpf(perlin.range(300, 900)).gain(0)',
      'three: note("g4*4").s("sine").lpf(800).gain(0)',
    ].join('\n');
    await callTool(client, 'set_code', { code: TIMELINE_CURVES_PROGRAM, label: 'probe timeline curves' });
    const curveControlKeys = await evaluateExpr(
      cdp,
      `(() => {
        const repl = document.getElementById('repl').editor.repl;
        const haps = repl.state.pattern.queryArc(0, 1);
        const keys = new Set();
        for (const hap of haps) {
          if (hap.value && typeof hap.value === 'object') Object.keys(hap.value).forEach((k) => keys.add(k));
        }
        return [...keys];
      })()`,
    );
    await pressKey(cdp, '2');
    await waitFor(
      cdp,
      `(() => { const s = document.getElementById('timeline-view').dataset.state; return s === 'ok' ? s : null; })()`,
      5000,
    );
    const curvesDetail = await evaluateExpr(
      cdp,
      `(() => {
        const lanes = [...document.querySelectorAll('#timeline-lanes .lane')];
        return lanes.map((lane) => {
          const curves = [...lane.querySelectorAll('polyline.lane-curve')];
          return {
            curveCount: curves.length,
            curvePoints: curves.length > 0 ? curves[0].getAttribute('points').trim().split(/\\s+/).length : 0,
          };
        });
      })()`,
    );
    await pressKey(cdp, '2');
    const [laneOneCurve, laneTwoCurve, laneThreeCurve] = curvesDetail;
    report(
      'hpf and bpf write hcutoff and bandf, and only signal-driven filters draw a curve',
      curveControlKeys.includes('hcutoff') &&
        curveControlKeys.includes('bandf') &&
        !!laneOneCurve &&
        laneOneCurve.curveCount === 1 &&
        laneOneCurve.curvePoints > 4 &&
        !!laneTwoCurve &&
        laneTwoCurve.curveCount === 1 &&
        laneTwoCurve.curvePoints > 4 &&
        !!laneThreeCurve &&
        laneThreeCurve.curveCount === 0,
      `controlKeys=${JSON.stringify(curveControlKeys)}, lanes=${JSON.stringify(curvesDetail)}`,
    );

    // --- A/b/c move an open view, and a reload keeps layout and view (reported
    // once, below, after the page reload right after it) ---
    await evaluateExpr(cdp, `(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); })()`);
    await pressKey(cdp, '2');
    const layoutADetail = await evaluateExpr(
      cdp,
      `(() => ({ layout: document.getElementById('workspace').dataset.layout, panelHidden: document.getElementById('view-panel').hidden }))()`,
    );
    await pressKey(cdp, 'b');
    const layoutBDetail = await evaluateExpr(
      cdp,
      `(() => {
        const workspace = document.getElementById('workspace');
        const panel = document.getElementById('view-panel');
        return {
          layout: workspace.dataset.layout,
          panelWidth: panel.getBoundingClientRect().width,
          workspaceWidth: workspace.getBoundingClientRect().width,
        };
      })()`,
    );
    await pressKey(cdp, 'c');
    const layoutCDetail = await evaluateExpr(
      cdp,
      `(() => ({
        layout: document.getElementById('workspace').dataset.layout,
        editorOpacity: Number(getComputedStyle(document.getElementById('editor-area')).opacity),
      }))()`,
    );
    await pressKey(cdp, 'b'); // leave the Timeline open in layout b for the reload check below
    const layoutSetupOk =
      layoutADetail.layout === 'a' &&
      layoutADetail.panelHidden === false &&
      layoutBDetail.layout === 'b' &&
      layoutBDetail.panelWidth < layoutBDetail.workspaceWidth &&
      layoutCDetail.layout === 'c' &&
      layoutCDetail.editorOpacity < 1;
    let reloadCompletedForLayoutCheck = false;

    // --- Motion follows the OS until the user picks it, and a reload keeps the
    // pick (reported after the page reload below, alongside the view-key check). The profile
    // is fresh, so no motion is stored yet — the switch follows the emulated OS setting live. ---
    const readMotionState = () =>
      evaluateExpr(
        cdp,
        `(() => ({
          label: document.getElementById('motion-switch').textContent,
          dataMotion: document.documentElement.dataset.motion,
        }))()`,
      );
    // matchMedia's own 'change' event (and the click handler's re-render) land asynchronously
    // relative to the CDP call/evaluation round trip, so poll for the expected label rather
    // than reading once immediately after — same pattern as waitFor's other timing-sensitive
    // page-state polls in this script.
    async function waitForMotionLabel(expectedLabel, timeoutMs = 3000) {
      const deadline = Date.now() + timeoutMs;
      let detail = await readMotionState();
      while (detail.label !== expectedLabel && Date.now() < deadline) {
        await sleep(100);
        detail = await readMotionState();
      }
      return detail;
    }
    await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    const motionReduce1 = await waitForMotionLabel('Motion: off');
    await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
    const motionNoPreference1 = await waitForMotionLabel('Motion: on');
    await evaluateExpr(cdp, `document.getElementById('motion-switch').click()`);
    const motionAfterClick = await waitForMotionLabel('Motion: off');
    await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    const motionAfterClickReduce = await waitForMotionLabel('Motion: off');
    await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
    const motionAfterClickNoPreference = await waitForMotionLabel('Motion: off');
    const barButtonsDetail = await evaluateExpr(
      cdp,
      `[...document.querySelectorAll('#view-buttons button, #layout-buttons button')].map((b) => b.getAttribute('aria-label')).join('|')`,
    );
    const motionBeforeReloadOk =
      motionReduce1.label === 'Motion: off' &&
      motionReduce1.dataMotion === 'off' &&
      motionNoPreference1.label === 'Motion: on' &&
      motionNoPreference1.dataMotion === 'on' &&
      motionAfterClick.label === 'Motion: off' &&
      motionAfterClickReduce.label === 'Motion: off' &&
      motionAfterClickNoPreference.label === 'Motion: off' &&
      barButtonsDetail === [...viewButtonParts(), ...layoutButtonParts()].map((part) => part.label).join('|');

    // --- The base size follows the window: 15px at 1920 wide, 22px at 3840 wide ---
    const baseSizeDetail = { at1920: null, at3840: null };
    try {
      await cdp('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
      baseSizeDetail.at1920 = await evaluateExpr(cdp, `getComputedStyle(document.documentElement).fontSize`);
      await cdp('Emulation.setDeviceMetricsOverride', { width: 3840, height: 2160, deviceScaleFactor: 1, mobile: false });
      baseSizeDetail.at3840 = await evaluateExpr(cdp, `getComputedStyle(document.documentElement).fontSize`);
    } finally {
      await cdp('Emulation.clearDeviceMetricsOverride');
    }
    report(
      'the base size follows the window: 15px at 1920 wide, 22px at 3840 wide',
      baseSizeDetail.at1920 === '15px' && baseSizeDetail.at3840 === '22px',
      JSON.stringify(baseSizeDetail),
    );

    // --- a page reload clears every anchor, and reapplies the VCSL host
    // (a concurrency edge) — run last, because it navigates the page. ---
    let clockForReload = await readSchedulerNow(cdp);
    const reloadClockDeadline = Date.now() + 30000;
    while (clockForReload <= 4 && Date.now() < reloadClockDeadline) {
      await sleep(500);
      clockForReload = await readSchedulerNow(cdp);
    }
    const beforeA6 = await readSchedulerNow(cdp);
    await callTool(client, 'set_code', { code: buildProgram([rampCode(6, 'sine')]), label: 'probe id 6 before reload' });
    const afterA6 = await readSchedulerNow(cdp);
    const windowA6 = anchorWindow(beforeA6, afterA6);
    const arcA6 = await readArc(cdp, windowA6[0] - 1, windowA6[1] + 8);
    const sineHapA6 = firstBySound(arcA6.haps, 'sine');
    const rampA6 = sineHapA6 ? computeRampAnchor(sineHapA6) : null;
    const A6 = rampA6 && rampA6.consistent ? rampA6.anchor : null;

    let vcslAfterReload = { ok: false, reason: 'the reload did not complete' };

    if (A6 === null || A6 < 3) {
      report(
        'a page reload clears every anchor',
        false,
        rampA6
          ? `anchor=${rampA6.anchor}, need at least 3 to mean anything (clock reached ${clockForReload.toFixed(4)} before the change)`
          : 'no sine ramp events found in the query window',
      );
    } else {
      await evaluateExpr(cdp, `(() => { window.__moontideProbeMarker = true; })()`);
      await cdp('Page.reload');
      const markerGoneDeadline = Date.now() + 15000;
      let markerGone = false;
      while (Date.now() < markerGoneDeadline && !markerGone) {
        try {
          if (await evaluateExpr(cdp, `window.__moontideProbeMarker === undefined`)) {
            markerGone = true;
          }
        } catch {
          // Evaluation can transiently fail during navigation (execution context destroyed); retry.
        }
        if (!markerGone) await sleep(200);
      }
      if (!markerGone) {
        report('a page reload clears every anchor', false, 'the reload marker never cleared within 15s');
      } else {
        await waitConnected(cdp, 15000);
        await clickOverlay(cdp);
        reloadCompletedForLayoutCheck = true;
        let clockAfterReload = await readSchedulerNow(cdp);
        const afterReloadDeadline = Date.now() + 15000;
        while (clockAfterReload <= 0.5 && Date.now() < afterReloadDeadline) {
          await sleep(200);
          clockAfterReload = await readSchedulerNow(cdp);
        }
        const arcAfterReload = await readArc(cdp, -1, Math.ceil(clockAfterReload) + 8);
        const sineHapReload = firstBySound(arcAfterReload.haps, 'sine');
        const rampReload = sineHapReload ? computeRampAnchor(sineHapReload) : null;
        report(
          'a page reload clears every anchor',
          !!rampReload && rampReload.consistent && Math.abs(rampReload.anchor) <= 2 && rampReload.anchor !== A6,
          rampReload
            ? `anchor now ${rampReload.anchor} (was ${A6}), clock after reload=${clockAfterReload.toFixed(4)}`
            : 'no sine ramp events found after the reload',
        );

        vcslAfterReload = await evaluateExpr(
          cdp,
          `(() => {
            if (typeof globalThis.soundMap?.get !== 'function') {
              return { ok: false, reason: 'globalThis.soundMap.get is not a function' };
            }
            const map = globalThis.soundMap.get();
            const base = ${JSON.stringify(VCSL_SAMPLE_BASE)};
            // See the earlier VCSL check above: .data.samples can be an array of URLs or an
            // object keyed by note whose values are arrays of URLs — flatten recursively either way.
            const flattenUrls = (value) => {
              if (Array.isArray(value)) return value.flatMap(flattenUrls);
              if (value && typeof value === 'object') return Object.values(value).flatMap(flattenUrls);
              return [value];
            };
            const urlsOf = (entry) => {
              const samples = entry && entry.data && entry.data.samples;
              return samples === undefined || samples === null ? [] : flattenUrls(samples);
            };
            const kalimbaUrls = urlsOf(map.kalimba).filter((url) => typeof url === 'string');
            const allFromBase = kalimbaUrls.length > 0 && kalimbaUrls.every((url) => url.startsWith(base));
            return { ok: true, kalimbaUrls, allFromBase };
          })()`,
        );
      }
    }
    report(
      'a page reload applies the VCSL host again',
      vcslAfterReload.ok === true && vcslAfterReload.allFromBase === true,
      vcslAfterReload.ok
        ? `kalimba urls after reload all from base=${vcslAfterReload.allFromBase} (${vcslAfterReload.kalimbaUrls.length} urls)`
        : vcslAfterReload.reason,
    );

    // --- View keys and layout reload (reported here, after the reload above) ---
    let layoutReloadDetail = null;
    let motionAfterReload = null;
    if (reloadCompletedForLayoutCheck) {
      layoutReloadDetail = await evaluateExpr(
        cdp,
        `(() => ({
          layout: document.getElementById('workspace').dataset.layout,
          timelineShown: document.getElementById('timeline-view').hidden === false,
        }))()`,
      );
      motionAfterReload = await readMotionState();
    }
    report(
      'a/b/c move an open view, and a reload keeps layout and view',
      layoutSetupOk &&
        !!layoutReloadDetail &&
        layoutReloadDetail.layout === 'b' &&
        layoutReloadDetail.timelineShown === true,
      `setup=${JSON.stringify({ layoutADetail, layoutBDetail, layoutCDetail })}, afterReload=${JSON.stringify(layoutReloadDetail)}`,
    );
    report(
      'motion follows the OS until the user picks it, and a reload keeps the pick',
      motionBeforeReloadOk && !!motionAfterReload && motionAfterReload.label === 'Motion: off',
      `beforeReload=${JSON.stringify({ motionReduce1, motionNoPreference1, motionAfterClick, motionAfterClickReduce, motionAfterClickNoPreference, barButtonsDetail })}, afterReload=${JSON.stringify(motionAfterReload)}`,
    );
    // Click the motion switch back to on, and reset the emulated media so later checks (and a
    // human running --headful afterwards) see the browser's own real setting again.
    await evaluateExpr(cdp, `document.getElementById('motion-switch').click()`);
    await cdp('Emulation.setEmulatedMedia', { features: [] });
    // Leave later checks starting from the strip layout with no view open.
    await pressKey(cdp, '2');
    await pressKey(cdp, 'a');

    // --- Launching a part starts it at the next cycle and records a page version ---
    const PARTS_PROGRAM = [
      'const one = note("c4").s("sine").gain(0)',
      'const two = note("e4").s("square").gain(0)',
      'const three = note("g4").s("triangle").gain(0)',
      'main: arrange([2, one], [2, two], [2, three])',
    ].join('\n');
    await callTool(client, 'set_code', { code: PARTS_PROGRAM, label: 'probe parts' });
    await evaluateExpr(cdp, `(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); })()`);
    await pressKey(cdp, '4');
    const partCardNames = await waitFor(
      cdp,
      `(() => {
        const cards = [...document.querySelectorAll('#parts-rows .part-card')];
        if (cards.length !== 3) return null;
        return cards.map((c) => c.querySelector('.part-name').textContent);
      })()`,
      5000,
    );
    const now0 = await readSchedulerNow(cdp);
    await evaluateExpr(
      cdp,
      `(() => {
        const cards = [...document.querySelectorAll('#parts-rows .part-card')];
        const target = cards.find((c) => c.querySelector('.part-name').textContent === 'three');
        target.click();
      })()`,
    );
    const lateOffset = await waitFor(
      cdp,
      `(() => {
        const code = document.getElementById('repl').editor.repl.state.activeCode;
        const m = /\\.late\\((-?\\d+)\\)/.exec(code);
        return m ? Number(m[1]) : null;
      })()`,
      5000,
    );
    let launchLandingCycle = null;
    if (lateOffset !== null) {
      for (let c = Math.floor(now0) + 1; c <= Math.floor(now0) + 4; c++) {
        if (arrangementPosition(c, lateOffset, 6) === 4) {
          launchLandingCycle = c;
          break;
        }
      }
    }
    let launchQueryDetail = null;
    if (launchLandingCycle !== null) {
      launchQueryDetail = await evaluateExpr(
        cdp,
        `(() => {
          const pat = document.getElementById('repl').editor.repl.state.pattern;
          const atLanding = pat.queryArc(${launchLandingCycle}, ${launchLandingCycle + 1}).filter((h) => h.hasOnset()).map((h) => h.value && h.value.s);
          const beforeLanding = pat.queryArc(${launchLandingCycle - 1}, ${launchLandingCycle}).filter((h) => h.hasOnset()).map((h) => h.value && h.value.s);
          return { atLanding, beforeLanding };
        })()`,
      );
    }
    const partLaunchGetCode = await callTool(client, 'get_code', {});
    const partLaunchHistory = await callTool(client, 'list_history', {});
    const partLaunchFirstLine = partLaunchHistory.split('\n')[0] || '';

    // A second launch (a different part) must replace the offset, never stack a second one.
    await evaluateExpr(
      cdp,
      `(() => {
        const cards = [...document.querySelectorAll('#parts-rows .part-card')];
        const target = cards.find((c) => c.querySelector('.part-name').textContent === 'one');
        target.click();
      })()`,
    );
    const oneLateCount = await waitFor(
      cdp,
      `(() => {
        const code = document.getElementById('repl').editor.repl.state.activeCode;
        const count = (code.match(/\\.late\\(/g) || []).length;
        return count > 0 ? count : null;
      })()`,
      5000,
    );
    await pressKey(cdp, '4');

    report(
      'launching a part starts it at the next cycle and records a page version',
      JSON.stringify(partCardNames) === JSON.stringify(['one', 'two', 'three']) &&
        lateOffset !== null &&
        launchLandingCycle !== null &&
        !!launchQueryDetail &&
        launchQueryDetail.atLanding.length > 0 &&
        launchQueryDetail.atLanding.every((s) => s === 'triangle') &&
        !launchQueryDetail.beforeLanding.includes('triangle') &&
        partLaunchGetCode.includes('.late(') &&
        partLaunchFirstLine.includes(' — page — "launched three" — ') &&
        oneLateCount === 1,
      `cards=${JSON.stringify(partCardNames)}, now0=${now0.toFixed(4)}, lateOffset=${lateOffset}, landingCycle=${launchLandingCycle}, query=${JSON.stringify(launchQueryDetail)}, getCodeHasLate=${partLaunchGetCode.includes('.late(')}, historyFirstLine=${JSON.stringify(partLaunchFirstLine)}, oneLateCount=${oneLateCount}`,
    );

    // --- A playing part shows its progress and idle parts their length ---
    // The parts program of the checks above (one/two/three, 2 cycles each) is still playing.
    await pressKey(cdp, '4');
    const livePartsDetail = await waitFor(
      cdp,
      `(() => {
        const cards = [...document.querySelectorAll('#parts-rows .part-card')];
        if (cards.length !== 3) return null;
        const playing = cards.filter((c) => c.dataset.state === 'playing');
        if (playing.length !== 1) return null;
        return cards.map((c) => ({ state: c.dataset.state, text: c.querySelector('.part-state').textContent }));
      })()`,
      3000,
    );
    await evaluateExpr(
      cdp,
      `(() => {
        const cards = [...document.querySelectorAll('#parts-rows .part-card')];
        const target = cards.find((c) => c.querySelector('.part-name').textContent === 'two');
        target.click();
      })()`,
    );
    const queuedTwoDetail = await waitFor(
      cdp,
      `(() => {
        const cards = [...document.querySelectorAll('#parts-rows .part-card')];
        const two = cards.find((c) => c.querySelector('.part-name').textContent === 'two');
        return two && two.dataset.state === 'queued'
          ? { state: two.dataset.state, text: two.querySelector('.part-state').textContent }
          : null;
      })()`,
      1000,
    );
    await pressKey(cdp, '4');

    const playingCards = (livePartsDetail || []).filter((c) => c.state === 'playing');
    const otherCardsOk =
      !!livePartsDetail &&
      livePartsDetail.every((c) => c.state === 'playing' || c.state === 'queued' || (c.state === 'idle' && c.text === 'Idle — 2 cycles'));
    report(
      'a playing part shows its progress and idle parts their length',
      !!livePartsDetail &&
        playingCards.length === 1 &&
        /^Playing — [12]\/2 cycles$/.test(playingCards[0].text) &&
        otherCardsOk &&
        !!queuedTwoDetail &&
        /^Queued — starts in \d+\.\d{1}s$/.test(queuedTwoDetail.text),
      `live=${JSON.stringify(livePartsDetail)}, queuedTwo=${JSON.stringify(queuedTwoDetail)}`,
    );

    // --- The Parts view says plainly when the code has no parts ---
    await callTool(client, 'set_code', { code: 'one: s("square*2").gain(0)', label: 'probe no parts' });
    await pressKey(cdp, '4');
    const noPartsDetail = await waitFor(
      cdp,
      `(() => {
        const msg = document.getElementById('parts-message');
        if (msg.hidden) return null;
        return {
          text: msg.textContent,
          cardCount: document.querySelectorAll('#parts-view .part-card').length,
          buttonCount: document.querySelectorAll('#parts-rows button').length,
          askVisible: !document.getElementById('parts-ask').hidden && document.getElementById('parts-ask').getBoundingClientRect().width > 0,
          askText: document.getElementById('parts-ask').textContent,
        };
      })()`,
      3000,
    );
    await pressKey(cdp, '4');
    report(
      'the Parts view says plainly when the code has no parts',
      !!noPartsDetail &&
        noPartsDetail.text === PARTS_COPY.none &&
        noPartsDetail.cardCount === 0 &&
        noPartsDetail.buttonCount === 0 &&
        noPartsDetail.askVisible === true &&
        noPartsDetail.askText === 'Ask Claude to add sections',
      JSON.stringify(noPartsDetail),
    );

    // --- The Parts view says why it cannot read an arrange() ---
    // A let is never read as a constant, so this check stays true when constants are resolved.
    await callTool(client, 'set_code', {
      code: ['let probeLen = 4', 'main: arrange([probeLen, s("bd").gain(0)], [4, s("hh").gain(0)])'].join('\n'),
      label: 'probe unreadable arrange',
    });
    await pressKey(cdp, '4');
    const unreadableDetail = await waitFor(
      cdp,
      `(() => {
        const msg = document.getElementById('parts-message');
        if (msg.hidden) return null;
        return {
          text: msg.textContent,
          cardCount: document.querySelectorAll('#parts-view .part-card').length,
          askHidden: document.getElementById('parts-ask').hidden || document.getElementById('parts-ask').getBoundingClientRect().width === 0,
        };
      })()`,
      3000,
    );
    await pressKey(cdp, '4');
    report(
      'the Parts view says why it cannot read an arrange()',
      !!unreadableDetail &&
        unreadableDetail.text ===
          partsEmptyText([{ call: 1, section: 1, reason: 'length-name-mutable', source: 'probeLen' }], 1) &&
        unreadableDetail.text.includes('declared with let or var, so it can change') &&
        unreadableDetail.text.includes('Lengths must be plain numbers') &&
        unreadableDetail.cardCount === 0 &&
        unreadableDetail.askHidden === true,
      JSON.stringify(unreadableDetail),
    );

    // --- The Parts view reads a top-level const length and names a skipped arrange() ---
    await callTool(client, 'set_code', {
      code: [
        'const probeA = 4',
        'one: arrange([probeA, s("bd").gain(0)], [8, s("hh").gain(0)])',
        'two: arrange([2.5, s("sd").gain(0)])',
      ].join('\n'),
      label: 'probe const length and skipped arrange',
    });
    await pressKey(cdp, '4');
    const constLengthDetail = await waitFor(
      cdp,
      `(() => {
        const cards = document.querySelectorAll('#parts-view .part-card');
        if (cards.length === 0) return null;
        const msg = document.getElementById('parts-message');
        const ask = document.getElementById('parts-ask');
        return {
          cardCount: cards.length,
          messageVisible: !msg.hidden && msg.getBoundingClientRect().width > 0,
          text: msg.textContent,
          askHidden: ask.hidden || ask.getBoundingClientRect().width === 0,
        };
      })()`,
      3000,
    );
    await pressKey(cdp, '4');
    await callTool(client, 'set_code', { code: 's("bd").gain(0)', label: 'probe silent' });
    report(
      'the Parts view reads a top-level const length and names a skipped arrange()',
      !!constLengthDetail &&
        constLengthDetail.cardCount === 2 &&
        constLengthDetail.messageVisible === true &&
        constLengthDetail.text ===
          partsSkippedText([{ call: 2, section: 1, reason: 'length-not-whole', source: '2.5' }], 2) &&
        constLengthDetail.askHidden === true,
      JSON.stringify(constLengthDetail),
    );

    await callTool(client, 'set_code', { code: PARTS_PROGRAM, label: 'probe sections' });
    await evaluateExpr(cdp, `(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); })()`);
    await pressKey(cdp, '2');
    await waitFor(
      cdp,
      `(() => { const s = document.getElementById('timeline-view').dataset.state; return s === 'ok' ? s : null; })()`,
      5000,
    );
    const sectionSpansDetail = await evaluateExpr(
      cdp,
      `(() => {
        const spans = [...document.querySelectorAll('#timeline-sections .section-span')];
        return { count: spans.length, titles: [...new Set(spans.map((s) => s.title))] };
      })()`,
    );
    await pressKey(cdp, '2');
    report(
      'the Timeline shows the arrange() sections above the lanes',
      sectionSpansDetail.count >= 15 && sectionSpansDetail.titles.every((title) => ['one', 'two', 'three'].includes(title)),
      JSON.stringify(sectionSpansDetail),
    );

    // --- The playhead crosses every lane and the lanes sit right under
    // the ruler, in layouts a, b and c at 1080p, at the user's 1539-wide screen and at 4K. ---
    const geometryBlur = `(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); })()`;
    const timelineOkWith = (laneSelector, minCount) => `(() => {
      const view = document.getElementById('timeline-view');
      const n = document.querySelectorAll('${laneSelector}').length;
      return view.dataset.state === 'ok' && n >= ${minCount} ? n : null;
    })()`;
    const playheadSpansBody = (m) =>
      m.playhead.top >= m.body.top - 1 &&
      m.playhead.top <= m.body.top + 1 &&
      Math.abs(m.playhead.bottom - m.body.bottom) <= 1;
    const geometrySummary = (viewport, m) => ({
      viewport,
      layout: m.layout,
      playheadHeight: m.playhead ? Math.round((m.playhead.bottom - m.playhead.top) * 100) / 100 : null,
      bodyHeight: m.body ? Math.round((m.body.bottom - m.body.top) * 100) / 100 : null,
      gap: m.firstLane && m.ruler ? Math.round((m.firstLane.top - m.ruler.bottom) * 100) / 100 : null,
      sectionsHeight: m.sections ? Math.round((m.sections.bottom - m.sections.top) * 100) / 100 : null,
    });
    const geometryResults = [];
    await callTool(client, 'set_code', { code: GEOMETRY_LANES.join('\n'), label: 'probe timeline geometry' });
    await evaluateExpr(cdp, geometryBlur);
    await pressKey(cdp, '2');
    await waitFor(cdp, timelineOkWith('#timeline-lanes .lane', 4), 5000);
    try {
      for (const [width, height] of [[1920, 1080], [1539, 860], [3840, 2160]]) {
        await cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
        for (const layoutKey of ['a', 'b', 'c']) {
          await pressKey(cdp, layoutKey);
          const m = await measureTimelineGeometry(cdp);
          const okShape = m.state === 'ok' && m.laneCount === 4 && !!m.playhead && !!m.firstLane && !!m.lastLane;
          const pass =
            okShape &&
            playheadSpansBody(m) &&
            m.playhead.bottom >= Math.min(m.lastLane.bottom, m.lanesBox.bottom) - 1 &&
            Math.abs(m.firstLane.top - m.ruler.bottom) <= 1 &&
            m.sections.bottom - m.sections.top <= 0.5;
          geometryResults.push({ pass, ...geometrySummary(`${width}x${height}`, m) });
        }
      }
      // The arrange() regression guard: with sections, the row is exactly as tall as its rows.
      await cdp('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
      await pressKey(cdp, 'a');
      await pressKey(cdp, '2');
      await callTool(client, 'set_code', { code: PARTS_PROGRAM, label: 'probe timeline geometry sections' });
      await evaluateExpr(cdp, geometryBlur);
      await pressKey(cdp, '2');
      await waitFor(cdp, timelineOkWith('#timeline-sections .section-row', 1), 5000);
      const withSections = await measureTimelineGeometry(cdp);
      const sectionsHeight = withSections.sections ? withSections.sections.bottom - withSections.sections.top : 0;
      const sectionsPass =
        withSections.state === 'ok' &&
        !!withSections.playhead &&
        !!withSections.firstLane &&
        withSections.sectionRowCount >= 1 &&
        Math.abs(withSections.sections.top - withSections.ruler.bottom) <= 1 &&
        sectionsHeight > 0 &&
        Math.abs(sectionsHeight - withSections.sectionRowsHeight) <= 1 &&
        Math.abs(withSections.firstLane.top - withSections.sections.bottom) <= 1 &&
        playheadSpansBody(withSections);
      geometryResults.push({ pass: sectionsPass, withSections: true, ...geometrySummary('1920x1080', withSections) });
    } finally {
      await cdp('Emulation.clearDeviceMetricsOverride');
    }
    await pressKey(cdp, '2');
    await pressKey(cdp, 'a');
    report(
      'the playhead crosses every lane and the lanes sit right under the ruler in layouts a, b and c',
      geometryResults.length === 10 && geometryResults.every((r) => r.pass),
      geometryResults.map((r) => JSON.stringify(r)).join(' | '),
    );

    // --- The playhead's cycle reading sits on its own line and never lands
    // on a ruler mark. setcps(4) makes a 32-cycle page last 8 real seconds. The 1539-wide sweeps
    // cover a whole page each (the user's screen, the narrowest columns); the 4K ones sample 4
    // cycles each. ---
    await callTool(client, 'set_code', {
      code: ['setcps(4)', ...GEOMETRY_LANES].join('\n'),
      label: 'probe timeline reading',
    });
    await evaluateExpr(cdp, geometryBlur);
    // The one-decimal reading is the widest: make sure motion is on.
    if ((await evaluateExpr(cdp, `document.documentElement.dataset.motion`)) !== 'on') {
      await evaluateExpr(cdp, `document.getElementById('motion-switch').click()`);
    }
    await pressKey(cdp, '2');
    await waitFor(cdp, timelineOkWith('#timeline-lanes .lane', 4), 5000);
    const readingSweeps = [];
    try {
      for (const [width, height, cycles, timeoutMs] of [[1539, 860, 32.5, 15000], [3840, 2160, 4, 5000]]) {
        await cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
        for (const layoutKey of ['a', 'b', 'c']) {
          await pressKey(cdp, layoutKey);
          const sweep = await sweepPlayheadReading(cdp, cycles, timeoutMs);
          readingSweeps.push({ viewport: `${width}x${height}`, layout: layoutKey, wholePage: width === 1539, ...sweep });
        }
      }
    } finally {
      await cdp('Emulation.clearDeviceMetricsOverride');
    }
    await pressKey(cdp, '2');
    await pressKey(cdp, 'a');
    await callTool(client, 'set_code', {
      code: ['setcps(0.5)', 'one: s("bd*4").gain(0)'].join('\n'),
      label: 'probe geometry tempo back',
    });
    report(
      'the playhead reading never overlaps a ruler mark in layouts a, b and c',
      readingSweeps.length === 6 &&
        readingSweeps.every(
          (s) =>
            s.motion === 'on' &&
            !s.timedOut &&
            s.overlapFrames === 0 &&
            s.outsideRulerFrames === 0 &&
            (s.wholePage
              ? s.frames >= 100 && s.minOffset !== null && s.minOffset <= 0.5 && s.maxOffset >= 31.5
              : s.frames >= 10),
        ),
      readingSweeps
        .map(
          (s) =>
            `${s.viewport} ${s.layout}: frames=${s.frames} skipped=${s.skipped} offsets=${s.minOffset}..${s.maxOffset} overlapFrames=${s.overlapFrames} outsideRulerFrames=${s.outsideRulerFrames} timedOut=${s.timedOut} motion=${s.motion} first=${JSON.stringify(s.overlaps)}`,
        )
        .join(' | '),
    );
    // The same six sweeps, checked against the panel's right edge and the
    // track column's left edge. Near the end of a page the reading must flip to the left of the line.
    report(
      'the playhead reading stays inside the panel across a whole page in layouts a, b and c',
      readingSweeps.length === 6 &&
        readingSweeps.every(
          (s) =>
            !s.timedOut &&
            s.outsidePanelFrames === 0 &&
            s.outsideColumnFrames === 0 &&
            (!s.wholePage || (s.leftSideFrames > 0 && s.rightSideFrames > 0)),
        ),
      readingSweeps
        .map(
          (s) =>
            `${s.viewport} ${s.layout}: frames=${s.frames} left=${s.leftSideFrames} right=${s.rightSideFrames} outsidePanelFrames=${s.outsidePanelFrames} outsideColumnFrames=${s.outsideColumnFrames} first=${JSON.stringify(s.escapes)}`,
        )
        .join(' | '),
    );

    // --- Long code: the code editor scrolls to its last line and the Parts rows scroll to their
    // last row. A 41-line program with three arrange()
    // tracks in a 1440x800 window: in the bottom strip (layout a) only 19 lines and two of the
    // three rows fit. Real mouse-wheel events, so a listener that swallowed the wheel fails it too.
    // The editor sits under the full-screen view in layout c, so only a and b check it. ---
    const SCROLL_LAST_LINE = '// probe long code: last line';
    const SCROLL_PROGRAM = [
      '// probe long code: first line',
      ...['c3', 'e4', 'c2'].flatMap((base, track) =>
        [1, 2, 3, 4].flatMap((i) => [`const p${track}${i} = note("${base} ${base}")`, '  .s("sine")', '  .gain(0)']),
      ),
      'chords: arrange([2, p01], [2, p02], [2, p03], [2, p04])',
      'melody: arrange([2, p11], [2, p12], [2, p13], [2, p14])',
      'bass: arrange([2, p21], [2, p22], [2, p23], [2, p24])',
      SCROLL_LAST_LINE,
    ].join('\n');
    // Everything the check needs, read in one go: how much each box overflows, whether the last
    // line and the last row lie fully inside the boxes that clip them, and whether any row label
    // was squeezed below its own text height.
    const scrollReachExpr = `(() => {
      const inside = (el, box) => {
        const r = el.getBoundingClientRect();
        const b = box.getBoundingClientRect();
        return r.top >= b.top - 1 && r.bottom <= b.bottom + 1;
      };
      const scroller = document.querySelector('#editor-area .cm-scroller');
      const area = document.getElementById('editor-area');
      const panel = document.getElementById('view-panel');
      const rows = document.getElementById('parts-rows');
      const lastLine = [...document.querySelectorAll('#editor-area .cm-line')].find((line) => line.textContent === ${JSON.stringify(SCROLL_LAST_LINE)});
      const rowEls = [...rows.querySelectorAll('.parts-row')];
      const lastRow = rowEls[rowEls.length - 1];
      const labels = [...rows.querySelectorAll('.parts-row-label')];
      return {
        layout: document.getElementById('workspace').dataset.layout,
        editorOverflow: Math.round(scroller.scrollHeight - scroller.clientHeight),
        rowsOverflow: Math.round(rows.scrollHeight - rows.clientHeight),
        lastLineShown: !!lastLine && inside(lastLine, area),
        rowCount: rowEls.length,
        lastLabel: labels.length ? labels[labels.length - 1].textContent : null,
        lastRowShown: !!lastRow && inside(lastRow, rows) && inside(lastRow, panel),
        labelsIntact: labels.length === 3 && labels.every((label) => label.getBoundingClientRect().height >= label.scrollHeight - 1),
      };
    })()`;
    // A real wheel over the middle of an element, scrolling down.
    const wheelOver = async (selector) => {
      const point = await evaluateExpr(
        cdp,
        `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
      );
      await cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x: point.x, y: point.y, deltaX: 0, deltaY: 3000 });
    };
    await callTool(client, 'set_code', { code: SCROLL_PROGRAM, label: 'probe long code' });
    await evaluateExpr(cdp, `(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); })()`);
    if ((await evaluateExpr(cdp, `document.getElementById('workspace').dataset.view`)) !== 'none') {
      await pressKey(cdp, 'Escape');
    }
    const scrollResults = [];
    try {
      await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 800, deviceScaleFactor: 1, mobile: false });
      await pressKey(cdp, 'a');
      await pressKey(cdp, '4');
      await waitFor(cdp, "document.querySelectorAll('#parts-rows .part-card').length === 12 ? true : null", 5000);
      for (const layoutKey of ['a', 'b', 'c']) {
        await pressKey(cdp, layoutKey);
        await evaluateExpr(
          cdp,
          `(() => { document.querySelector('#editor-area .cm-scroller').scrollTop = 0; document.getElementById('parts-rows').scrollTop = 0; })()`,
        );
        const before = await waitFor(cdp, `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(${scrollReachExpr}))))`, 1000);
        await wheelOver('#parts-rows');
        if (layoutKey !== 'c') await wheelOver('#editor-area');
        // Wheel scrolling can be animated: poll until everything is shown, then read once more.
        await waitFor(
          cdp,
          `(() => { const m = ${scrollReachExpr}; return m.lastRowShown && (m.layout === 'c' || m.lastLineShown) ? true : null; })()`,
          3000,
        );
        const after = await evaluateExpr(cdp, scrollReachExpr);
        const pass =
          after.layout === layoutKey &&
          after.rowCount === 3 &&
          after.lastLabel === 'bass' &&
          after.lastRowShown &&
          after.labelsIntact &&
          (layoutKey === 'c' || (before.editorOverflow > 0 && after.lastLineShown)) &&
          (layoutKey !== 'a' || before.rowsOverflow > 0);
        scrollResults.push({ pass, layout: layoutKey, before: { editorOverflow: before.editorOverflow, rowsOverflow: before.rowsOverflow, lastLineShown: before.lastLineShown, lastRowShown: before.lastRowShown }, after });
      }
    } finally {
      await cdp('Emulation.clearDeviceMetricsOverride');
    }
    await pressKey(cdp, '4');
    await pressKey(cdp, 'a');
    report(
      'with long code, the editor scrolls to its last line and the Parts rows to their last row in layouts a, b and c',
      scrollResults.length === 3 && scrollResults.every((r) => r.pass),
      scrollResults.map((r) => JSON.stringify(r)).join(' | '),
    );

    // --- History ---

    // Ids are always read from the DOM: earlier checks recorded versions first, so no absolute
    // id can be assumed here.
    await evaluateExpr(cdp, `(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); })()`);
    const viewBeforeHistory = await evaluateExpr(cdp, `document.getElementById('workspace').dataset.view`);
    if (viewBeforeHistory !== 'none') {
      await pressKey(cdp, 'Escape');
    }
    await pressKey(cdp, 'a');
    await pressKey(cdp, '1');
    const historyOpened = await waitFor(
      cdp,
      `(() => {
        const view = document.getElementById('history-view');
        return !view.hidden && document.querySelectorAll('#history-list .hist-row').length >= 2 ? true : null;
      })()`,
      5000,
    );
    const historyRows = await evaluateExpr(
      cdp,
      `(() => ({
        ids: [...document.querySelectorAll('#history-list .hist-row')].map((row) => Number(row.dataset.id)),
        firstCurrent: document.querySelector('#history-list .hist-row')?.dataset.current,
        indicator: document.getElementById('version-indicator').textContent,
        total: Number((/^(\\d+) versions?$/.exec(document.getElementById('history-count').textContent) ?? [])[1]),
      }))()`,
    );
    const indicatorNumber = Number((/^v(\d+)/.exec(historyRows.indicator) ?? [])[1]);
    report(
      'History opens with key 1 and lists versions newest first',
      historyOpened === true &&
        historyRows.ids.length >= 2 &&
        // The seeded history holds more than one window, so the page starts with the newest 100
        // (plus the versions recorded since) and must not have loaded everything.
        historyRows.ids.length < historyRows.total &&
        historyRows.ids.every((id, i) => i === 0 || id < historyRows.ids[i - 1]) &&
        historyRows.firstCurrent === 'true' &&
        historyRows.ids[0] === indicatorNumber,
      JSON.stringify({ rows: historyRows.ids.length, total: historyRows.total, first: historyRows.ids[0], current: historyRows.firstCurrent, indicator: historyRows.indicator }),
    );

    const layoutDetails = [];
    for (const layoutKey of ['b', 'c', 'a']) {
      await pressKey(cdp, layoutKey);
      const detail = await evaluateExpr(
        cdp,
        `new Promise((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => {
            const view = document.getElementById('history-view');
            const row = document.querySelector('#history-list .hist-row');
            resolve({
              layout: document.getElementById('workspace').dataset.layout,
              hidden: view.hidden,
              viewHeight: view.offsetHeight,
              rowHeight: row ? row.offsetHeight : 0,
            });
          }));
        })`,
      );
      layoutDetails.push(detail);
    }
    report(
      'History shows in layouts a, b and c',
      layoutDetails.map((d) => d.layout).join('') === 'bca' && layoutDetails.every((d) => !d.hidden && d.viewHeight > 0 && d.rowHeight > 0),
      JSON.stringify(layoutDetails),
    );

    // A click on an older version restores it as a new page entry.
    const beforeRestore = await evaluateExpr(
      cdp,
      `(() => {
        const rows = [...document.querySelectorAll('#history-list .hist-row')];
        return { newest: Number(rows[0].dataset.id), third: Number(rows[2].dataset.id) };
      })()`,
    );
    await clickElement(cdp, `#history-list .hist-row[data-id="${beforeRestore.third}"] .hist-main`);
    const restored = await waitFor(
      cdp,
      `(() => {
        const first = document.querySelector('#history-list .hist-row');
        if (!first || Number(first.dataset.id) <= ${beforeRestore.newest}) return null;
        return {
          id: Number(first.dataset.id),
          restoredFrom: first.dataset.restoredFrom,
          origin: first.dataset.origin,
          current: first.dataset.current,
          indicator: document.getElementById('version-indicator').textContent,
        };
      })()`,
      6000,
    );
    const historyAfterRestore = await callTool(client, 'list_history', {});
    const firstHistoryLine = historyAfterRestore.split('\n')[0];
    report(
      'a click on an older version restores it as a new page entry and the top bar names it',
      restored !== null &&
        restored.restoredFrom === String(beforeRestore.third) &&
        restored.origin === 'page' &&
        restored.current === 'true' &&
        restored.indicator === `v${restored.id} · from v${beforeRestore.third}` &&
        firstHistoryLine.includes(` — page — "restored from #${beforeRestore.third}"`),
      JSON.stringify({ clicked: beforeRestore, restored, firstHistoryLine }),
    );

    // Clicking the current version restores nothing: no new entry, no pending mark.
    const beforeCurrentClick = await evaluateExpr(
      cdp,
      `(() => {
        const first = document.querySelector('#history-list .hist-row');
        return {
          id: Number(first.dataset.id),
          status: first.querySelector('.hist-status').textContent,
          disabled: first.querySelector('.hist-main').getAttribute('aria-disabled'),
        };
      })()`,
    );
    await clickElement(cdp, '#history-list .hist-row .hist-main');
    await sleep(1000);
    const afterCurrentClick = await evaluateExpr(
      cdp,
      `(() => ({
        firstId: Number(document.querySelector('#history-list .hist-row').dataset.id),
        pendingRows: document.querySelectorAll('#history-list [data-pending]').length,
        count: document.getElementById('history-count').textContent,
      }))()`,
    );
    report(
      'clicking the current version adds nothing and it reads Current',
      beforeCurrentClick.status === 'Current' &&
        beforeCurrentClick.disabled === 'true' &&
        afterCurrentClick.firstId === beforeCurrentClick.id &&
        afterCurrentClick.pendingRows === 0 &&
        /^\d+ versions?$/.test(afterCurrentClick.count),
      JSON.stringify({ before: beforeCurrentClick, after: afterCurrentClick }),
    );

    // --- History ---

    // Two set_code calls in a row: the second one differs from the first by one changed track
    // and one added track, so its row must say so.
    const newestBeforeChange = await evaluateExpr(
      cdp,
      `Number(document.querySelector('#history-list .hist-row')?.dataset.id ?? 0)`,
    );
    await callTool(client, 'set_code', {
      code: 'drums: s("bd").gain(0)\nhats: s("hh").gain(0)',
      label: 'probe history before',
    });
    await callTool(client, 'set_code', {
      code: 'drums: s("bd*2").gain(0)\nhats: s("hh").gain(0)\nclaps: s("cp").gain(0)',
      label: 'probe history after',
    });
    await pressKey(cdp, 'a');
    const changeRow = await waitFor(
      cdp,
      `(() => {
        const first = document.querySelector('#history-list .hist-row');
        if (!first || Number(first.dataset.id) <= ${newestBeforeChange + 1}) return null;
        const label = first.querySelector('.hist-label');
        if (!label || label.textContent !== 'probe history after') return null;
        return {
          id: Number(first.dataset.id),
          summary: first.querySelector('.hist-summary')?.textContent ?? null,
          added: first.querySelector('.hist-count-add')?.textContent ?? null,
          removed: first.querySelector('.hist-count-remove')?.textContent ?? null,
        };
      })()`,
      6000,
    );
    report(
      'a History row says what changed, by track, with line counts',
      changeRow !== null &&
        changeRow.summary === 'drums changed, claps added' &&
        changeRow.added === '+2' &&
        changeRow.removed === '\u22121',
      JSON.stringify(changeRow),
    );

    // The Changes toggle opens the diff beside the list in layout a and under the row in b,
    // and restores nothing.
    const beforeToggle = await evaluateExpr(
      cdp,
      `(() => {
        const rows = [...document.querySelectorAll('#history-list .hist-row')];
        return { firstId: Number(rows[0].dataset.id), secondId: Number(rows[1].dataset.id), count: rows.length };
      })()`,
    );
    await clickElement(cdp, '#history-list .hist-row .hist-toggle');
    const layoutADiff = await waitFor(
      cdp,
      `(() => {
        const diff = document.querySelector('#history-detail .hist-diff');
        if (!diff) return null;
        const toggle = document.querySelector('#history-list .hist-row .hist-toggle');
        return {
          header: diff.querySelector('.hist-diff-header')?.textContent ?? null,
          adds: diff.querySelectorAll('.hist-diff-line[data-kind="add"]').length,
          dels: diff.querySelectorAll('.hist-diff-line[data-kind="del"]').length,
          toggleText: toggle.textContent,
          expanded: toggle.getAttribute('aria-expanded'),
          detailDisplay: getComputedStyle(document.getElementById('history-detail')).display,
        };
      })()`,
      3000,
    );
    await sleep(1000);
    const afterToggle = await evaluateExpr(
      cdp,
      `(() => ({
        firstId: Number(document.querySelector('#history-list .hist-row').dataset.id),
        count: document.querySelectorAll('#history-list .hist-row').length,
      }))()`,
    );
    await pressKey(cdp, 'b');
    const layoutBDiff = await evaluateExpr(
      cdp,
      `new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => {
          const first = document.querySelector('#history-list .hist-row');
          resolve({
            inRow: first.querySelector('.hist-diff') !== null,
            detailDisplay: getComputedStyle(document.getElementById('history-detail')).display,
            detailDiffs: document.querySelectorAll('#history-detail .hist-diff').length,
            expanded: first.querySelector('.hist-toggle').getAttribute('aria-expanded'),
          });
        }));
      })`,
    );
    await clickElement(cdp, '#history-list .hist-row .hist-toggle');
    const afterCollapse = await evaluateExpr(
      cdp,
      `(() => {
        const first = document.querySelector('#history-list .hist-row');
        return {
          diffs: document.querySelectorAll('#history-list .hist-diff').length,
          toggleText: first.querySelector('.hist-toggle').textContent,
        };
      })()`,
    );
    await pressKey(cdp, 'a');
    report(
      'Changes expands the line diff without restoring, beside the list in layout a and under the row in layout b',
      layoutADiff !== null &&
        layoutADiff.header === `v${beforeToggle.firstId} against v${beforeToggle.secondId}` &&
        layoutADiff.adds === 2 &&
        layoutADiff.dels === 1 &&
        layoutADiff.toggleText === 'Hide' &&
        layoutADiff.expanded === 'true' &&
        layoutADiff.detailDisplay === 'block' &&
        afterToggle.firstId === beforeToggle.firstId &&
        afterToggle.count === beforeToggle.count &&
        layoutBDiff.inRow === true &&
        layoutBDiff.detailDisplay === 'none' &&
        layoutBDiff.detailDiffs === 0 &&
        layoutBDiff.expanded === 'true' &&
        afterCollapse.diffs === 0 &&
        afterCollapse.toggleText === 'Changes',
      JSON.stringify({ beforeToggle, layoutADiff, afterToggle, layoutBDiff, afterCollapse }),
    );

    // --- History ---

    // Show older versions: the list starts with the 100 newest versions of the seeded history, and
    // the control loads the next 100 below without moving what is on screen.
    await pressKey(cdp, 'b');
    const moreReady = await waitFor(
      cdp,
      `(() => {
        const button = document.getElementById('history-more');
        if (!button || button.hidden || button.offsetHeight === 0) return null;
        return { text: button.textContent, rows: document.querySelectorAll('#history-list .hist-row').length };
      })()`,
      6000,
    );
    const moreMatch = moreReady === null ? null : /^Show older versions \((\d+) more\)$/.exec(moreReady.text);
    const readList = () =>
      evaluateExpr(
        cdp,
        `(() => {
          const scroll = document.getElementById('history-scroll');
          const rows = [...document.querySelectorAll('#history-list .hist-row')];
          const button = document.getElementById('history-more');
          return {
            scrollTop: scroll.scrollTop,
            rows: rows.length,
            lastId: rows.length ? Number(rows[rows.length - 1].dataset.id) : 0,
            hasOne: rows.some((row) => row.dataset.id === '1'),
            moreHidden: button.hidden,
            moreText: button.textContent,
            count: document.getElementById('history-count').textContent,
          };
        })()`,
      );
    const moreSteps = [];
    let moreOk = moreMatch !== null;
    if (moreOk) {
      let remaining = Number(moreMatch[1]);
      for (let step = 0; step < 4 && moreOk; step += 1) {
        await evaluateExpr(
          cdp,
          `document.getElementById('history-more').scrollIntoView({ block: 'nearest' })`,
        );
        await sleep(150);
        const before = await readList();
        await clickElement(cdp, '#history-more');
        const after = await waitFor(
          cdp,
          `(() => {
            const rows = document.querySelectorAll('#history-list .hist-row').length;
            return rows > ${before.rows} ? rows : null;
          })()`,
          6000,
        ).then(() => readList());
        const grew = after.rows - before.rows;
        const stepOk =
          grew === Math.min(100, remaining) &&
          after.lastId < before.lastId &&
          Math.abs(after.scrollTop - before.scrollTop) <= 1 &&
          after.count === before.count;
        moreSteps.push({ remaining, grew, lastBefore: before.lastId, lastAfter: after.lastId, scrollBefore: before.scrollTop, scrollAfter: after.scrollTop, count: after.count });
        if (!stepOk) moreOk = false;
        if (after.hasOne) {
          moreOk = moreOk && after.moreHidden === true;
          moreSteps.push({ allLoaded: true, moreHidden: after.moreHidden });
          break;
        }
        remaining = Number((/\((\d+) more\)/.exec(after.moreText) ?? [])[1]);
        if (!Number.isFinite(remaining)) {
          moreOk = false;
          break;
        }
        if (step === 3) moreOk = false;
      }
    }
    report(
      'Show older versions loads the next versions below without moving the list',
      moreOk,
      JSON.stringify({ moreReady, steps: moreSteps }),
    );

    // Sessions and favorites: every version is loaded now, so both seeded sessions are on screen.
    const sessionRows = await evaluateExpr(
      cdp,
      `(() => {
        const afterRow = (id) => {
          const row = document.querySelector('#history-list .hist-row[data-id="' + id + '"]');
          if (!row) return null;
          const divider = row.nextElementSibling;
          const below = divider ? divider.nextElementSibling : null;
          return {
            dividerText: divider && divider.classList.contains('hist-divider') ? divider.querySelector('.hist-divider-text').textContent : null,
            dividerFocusable: divider ? divider.hasAttribute('tabindex') : null,
            belowId: below && below.classList.contains('hist-row') ? Number(below.dataset.id) : null,
          };
        };
        const favorite = document.querySelector('#history-list .hist-row[data-id="60"] .hist-favorite');
        return {
          seedBoundary: afterRow(61),
          probeBoundary: afterRow(${SEED_VERSION_COUNT + 1}),
          dividerCount: document.querySelectorAll('#history-list .hist-divider').length,
          favoriteName: favorite ? favorite.querySelector('.hist-favorite-name').textContent : null,
          starHidden: favorite ? favorite.querySelector('.hist-star').getAttribute('aria-hidden') : null,
          starTitle: favorite ? favorite.querySelector('.hist-star').title : null,
        };
      })()`,
    );
    report(
      'a session divider sits between two sessions and a favorite shows its star and name',
      sessionRows.seedBoundary !== null &&
        sessionRows.seedBoundary.dividerText !== null &&
        sessionRows.seedBoundary.dividerText.startsWith('New session · ') &&
        sessionRows.seedBoundary.dividerFocusable === false &&
        sessionRows.seedBoundary.belowId === 60 &&
        sessionRows.probeBoundary !== null &&
        sessionRows.probeBoundary.dividerText !== null &&
        sessionRows.probeBoundary.dividerText.startsWith('New session · ') &&
        sessionRows.probeBoundary.belowId === SEED_VERSION_COUNT &&
        sessionRows.dividerCount === 2 &&
        sessionRows.favoriteName === 'probe favorite' &&
        sessionRows.starHidden === 'true' &&
        sessionRows.starTitle === 'Favorite',
      JSON.stringify(sessionRows),
    );

    // A favorite Claude sets while the view is open shows without a reload.
    const topRowId = await evaluateExpr(
      cdp,
      `Number(document.querySelector('#history-list .hist-row').dataset.id)`,
    );
    await callTool(client, 'favorite_version', { id: topRowId, name: 'probe live favorite' });
    const liveFavorite = await waitFor(
      cdp,
      `(() => {
        const name = document.querySelector('#history-list .hist-row .hist-favorite-name');
        return name && name.textContent === 'probe live favorite' ? name.textContent : null;
      })()`,
      3000,
    );
    report(
      'a favorite set by Claude shows in the list without a reload',
      liveFavorite === 'probe live favorite',
      JSON.stringify({ topRowId, liveFavorite }),
    );

    // A version arriving while the list is scrolled down leaves the rows on screen where they were;
    // at the top the list grows downward.
    const scrollSetup = await evaluateExpr(
      cdp,
      `(() => {
        const scroll = document.getElementById('history-scroll');
        scroll.scrollTop = 400;
        const box = scroll.getBoundingClientRect();
        const row = [...document.querySelectorAll('#history-list .hist-row')].find((r) => r.getBoundingClientRect().top >= box.top);
        return {
          scrollTop: scroll.scrollTop,
          scrollHeight: scroll.scrollHeight,
          layout: document.getElementById('workspace').dataset.layout,
          rowId: row ? Number(row.dataset.id) : null,
          rowTop: row ? row.getBoundingClientRect().top : null,
          firstId: Number(document.querySelector('#history-list .hist-row').dataset.id),
        };
      })()`,
    );
    await sleep(200);
    await callTool(client, 'set_code', { code: 'drums: s("bd*3").gain(0)', label: 'probe scrolled arrival' });
    const scrolledArrival = await waitFor(
      cdp,
      `(() => {
        const first = document.querySelector('#history-list .hist-row');
        if (!first || Number(first.dataset.id) <= ${scrollSetup.firstId}) return null;
        const row = document.querySelector('#history-list .hist-row[data-id="${scrollSetup.rowId}"]');
        return { firstId: Number(first.dataset.id), scrollTop: document.getElementById('history-scroll').scrollTop, rowTop: row ? row.getBoundingClientRect().top : null };
      })()`,
      6000,
    );
    await sleep(400);
    const settledArrival = await evaluateExpr(
      cdp,
      `(() => {
        const row = document.querySelector('#history-list .hist-row[data-id="${scrollSetup.rowId}"]');
        return { scrollTop: document.getElementById('history-scroll').scrollTop, rowTop: row ? row.getBoundingClientRect().top : null };
      })()`,
    );
    await evaluateExpr(cdp, `document.getElementById('history-scroll').scrollTop = 0`);
    await sleep(200);
    await callTool(client, 'set_code', { code: 'drums: s("bd*5").gain(0)', label: 'probe top arrival' });
    const topArrival = await waitFor(
      cdp,
      `(() => {
        const first = document.querySelector('#history-list .hist-row');
        if (!first || Number(first.dataset.id) <= ${scrolledArrival ? scrolledArrival.firstId : 0}) return null;
        const scroll = document.getElementById('history-scroll');
        return { firstId: Number(first.dataset.id), scrollTop: scroll.scrollTop, rowTop: first.getBoundingClientRect().top, boxTop: scroll.getBoundingClientRect().top };
      })()`,
      6000,
    );
    report(
      'a version arriving while the list is scrolled down does not move the rows on screen',
      scrollSetup.scrollTop > 0 &&
        scrollSetup.rowId !== null &&
        scrolledArrival !== null &&
        scrolledArrival.rowTop !== null &&
        Math.abs(scrolledArrival.rowTop - scrollSetup.rowTop) <= 1 &&
        settledArrival.rowTop !== null &&
        Math.abs(settledArrival.rowTop - scrollSetup.rowTop) <= 1 &&
        scrolledArrival.scrollTop > scrollSetup.scrollTop &&
        topArrival !== null &&
        topArrival.scrollTop === 0 &&
        Math.abs(topArrival.rowTop - topArrival.boxTop) <= 1,
      JSON.stringify({ scrollSetup, scrolledArrival, settledArrival, topArrival }),
    );

    // With motion on a new row starts hidden (data-shown false) and ends visible; with motion off
    // it is simply there (checked above: no data-shown at all).
    const motionNow = await evaluateExpr(cdp, `document.documentElement.dataset.motion`);
    if (motionNow !== 'on') await clickInDrawer(cdp, '#motion-switch');
    const motionOn = await evaluateExpr(cdp, `document.documentElement.dataset.motion`);
    const topBeforeFade = await evaluateExpr(cdp, `Number(document.querySelector('#history-list .hist-row').dataset.id)`);
    await callTool(client, 'set_code', { code: 'drums: s("bd*6").gain(0)', label: 'probe fade arrival' });
    const fadedRow = await waitFor(
      cdp,
      `(() => {
        const first = document.querySelector('#history-list .hist-row');
        if (!first || Number(first.dataset.id) <= ${topBeforeFade}) return null;
        return { id: Number(first.dataset.id), shown: first.dataset.shown ?? null, opacity: getComputedStyle(first).opacity, transition: getComputedStyle(first).transitionDuration };
      })()`,
      6000,
    );
    await sleep(500);
    const fadedSettled = await evaluateExpr(
      cdp,
      `(() => {
        const first = document.querySelector('#history-list .hist-row');
        return { shown: first.dataset.shown ?? null, opacity: getComputedStyle(first).opacity };
      })()`,
    );
    report(
      'with motion on a new History row fades in and ends fully visible',
      motionOn === 'on' &&
        fadedRow !== null &&
        fadedRow.transition === '0.15s' &&
        fadedSettled.shown === 'true' &&
        fadedSettled.opacity === '1',
      JSON.stringify({ motionOn, fadedRow, fadedSettled }),
    );

    // --- History ---

    // Tree mode: press Tree, go back to an older version, change it, and see a new branch. Ids are
    // read from the DOM (the seeded history makes every absolute id meaningless here).
    await pressKey(cdp, 'b');
    await clickElement(cdp, '#history-mode-tree');
    const treeOn = await evaluateExpr(
      cdp,
      `(() => ({
        mode: document.getElementById('history-view').dataset.mode,
        pressed: document.getElementById('history-mode-tree').getAttribute('aria-pressed'),
      }))()`,
    );
    await evaluateExpr(cdp, `document.getElementById('history-scroll').scrollTop = 0`);
    const forkBefore = await evaluateExpr(
      cdp,
      `(() => {
        const rows = [...document.querySelectorAll('#history-list .hist-row')];
        return { top: Number(rows[0].dataset.id), second: Number(rows[1].dataset.id), third: Number(rows[2].dataset.id) };
      })()`,
    );
    await clickElement(cdp, `#history-list .hist-row[data-id="${forkBefore.third}"] .hist-main`);
    const forkRestored = await waitFor(
      cdp,
      `(() => {
        const first = document.querySelector('#history-list .hist-row');
        if (!first || Number(first.dataset.id) <= ${forkBefore.top}) return null;
        return first.dataset.restoredFrom === '${forkBefore.third}' ? Number(first.dataset.id) : null;
      })()`,
      6000,
    );
    await callTool(client, 'set_code', { code: 'drums: s("bd*4").gain(0)', label: 'probe tree change' });
    const forkChanged = await waitFor(
      cdp,
      `(() => {
        const first = document.querySelector('#history-list .hist-row');
        return first && Number(first.dataset.id) > ${forkRestored ?? 0} ? Number(first.dataset.id) : null;
      })()`,
      6000,
    );
    const forkLanes = await evaluateExpr(
      cdp,
      `(() => {
        const get = (id) => {
          const row = document.querySelector('#history-list .hist-row[data-id="' + id + '"]');
          return row ? { lane: row.dataset.lane ?? null, parent: row.dataset.parent ?? null } : null;
        };
        return {
          changed: get(${forkChanged ?? 0}),
          restored: get(${forkRestored ?? 0}),
          oldTop: get(${forkBefore.top}),
          oldSecond: get(${forkBefore.second}),
          third: get(${forkBefore.third}),
        };
      })()`,
    );
    report(
      'Tree mode draws a new branch after going back to an older version and changing it',
      treeOn.mode === 'tree' &&
        treeOn.pressed === 'true' &&
        forkRestored !== null &&
        forkChanged !== null &&
        forkLanes.changed.lane === '1' &&
        forkLanes.changed.parent === String(forkRestored) &&
        forkLanes.restored.lane === '1' &&
        forkLanes.restored.parent === String(forkBefore.third) &&
        forkLanes.oldTop.lane === '2' &&
        forkLanes.oldSecond.lane === '2' &&
        forkLanes.third.lane === '1',
      JSON.stringify({ treeOn, forkBefore, forkRestored, forkChanged, forkLanes }),
    );

    // Lane lines stay continuous: through an expanded inline diff (layout b) and through a session
    // divider. The row in lane 2 is the older tip of the fork drawn above.
    await evaluateExpr(cdp, `document.getElementById('history-scroll').scrollTop = 0`);
    await clickElement(cdp, `#history-list .hist-row[data-id="${forkBefore.top}"] .hist-toggle`);
    const diffOpen = await waitFor(
      cdp,
      `document.querySelector('#history-list .hist-row[data-id="${forkBefore.top}"] .hist-diff') ? true : null`,
      3000,
    );
    const continuity = await evaluateExpr(
      cdp,
      `(() => {
        const spans = (li) => {
          const box = li.getBoundingClientRect();
          const graph = li.querySelector('.hist-graph').getBoundingClientRect();
          const pieces = [...li.querySelectorAll('.hist-graph .hist-lane-line')]
            .map((line) => { const r = line.getBoundingClientRect(); return [r.top, r.bottom]; })
            .sort((a, b) => a[0] - b[0]);
          let coveredTo = box.top;
          let reachesTop = false;
          for (const [top, bottom] of pieces) {
            if (top <= coveredTo + 1) {
              reachesTop = true;
              coveredTo = Math.max(coveredTo, bottom);
            }
          }
          return {
            liHeight: box.height,
            graphHeight: graph.height,
            pieces: pieces.length,
            unbroken: reachesTop && coveredTo >= box.bottom - 1,
          };
        };
        const row = document.querySelector('#history-list .hist-row[data-id="${forkBefore.top}"]');
        const boundary = document.querySelector('#history-list .hist-row[data-id="${SEED_VERSION_COUNT + 1}"]');
        const divider = boundary ? boundary.nextElementSibling : null;
        return {
          row: spans(row),
          diffHeight: row.querySelector('.hist-diff') ? row.querySelector('.hist-diff').getBoundingClientRect().height : 0,
          divider: divider && divider.classList.contains('hist-divider') ? spans(divider) : null,
        };
      })()`,
    );
    await clickElement(cdp, `#history-list .hist-row[data-id="${forkBefore.top}"] .hist-toggle`);
    report(
      'tree lane lines run unbroken through an expanded diff and a session divider',
      diffOpen === true &&
        continuity.diffHeight > 0 &&
        Math.abs(continuity.row.graphHeight - continuity.row.liHeight) <= 1 &&
        continuity.row.unbroken &&
        continuity.divider !== null &&
        continuity.divider.pieces >= 1 &&
        Math.abs(continuity.divider.graphHeight - continuity.divider.liHeight) <= 1 &&
        continuity.divider.unbroken,
      JSON.stringify({ diffOpen, continuity }),
    );

    // The choice of list or tree is stored, and switching leaves the scroll position alone.
    const storedTree = await evaluateExpr(cdp, `localStorage.getItem('moontide.historyMode')`);
    await evaluateExpr(cdp, `document.getElementById('history-scroll').scrollTop = 300`);
    const scrollBeforeSwitch = await evaluateExpr(cdp, `document.getElementById('history-scroll').scrollTop`);
    await clickElement(cdp, '#history-mode-list');
    const listState = await evaluateExpr(
      cdp,
      `(() => ({
        mode: document.getElementById('history-view').dataset.mode,
        stored: localStorage.getItem('moontide.historyMode'),
        lines: document.querySelectorAll('#history-list .hist-lane-line').length,
        scrollTop: document.getElementById('history-scroll').scrollTop,
      }))()`,
    );
    await clickElement(cdp, '#history-mode-tree');
    const treeAgain = await evaluateExpr(
      cdp,
      `(() => ({
        mode: document.getElementById('history-view').dataset.mode,
        stored: localStorage.getItem('moontide.historyMode'),
        lines: document.querySelectorAll('#history-list .hist-lane-line').length,
        scrollTop: document.getElementById('history-scroll').scrollTop,
      }))()`,
    );
    await pressKey(cdp, 'a');
    report(
      'the list or tree choice is remembered',
      storedTree === 'tree' &&
        listState.mode === 'list' &&
        listState.stored === 'list' &&
        listState.lines === 0 &&
        treeAgain.mode === 'tree' &&
        treeAgain.stored === 'tree' &&
        treeAgain.lines > 0 &&
        scrollBeforeSwitch > 0 &&
        listState.scrollTop === scrollBeforeSwitch &&
        treeAgain.scrollTop === scrollBeforeSwitch,
      JSON.stringify({ storedTree, scrollBeforeSwitch, listState, treeAgain }),
    );

    // --- History ---

    // Keyboard: with the cursor not in the editor, Down, Down, Enter brings the selected version back.
    // Ids are read from the DOM (the seeded history makes every absolute id meaningless here).
    await evaluateExpr(cdp, `document.activeElement && document.activeElement.blur && document.activeElement.blur()`);
    if (await evaluateExpr(cdp, `!document.getElementById('history-view').hidden`)) await pressKey(cdp, '1');
    await pressKey(cdp, '1');
    const readSelection = () =>
      evaluateExpr(
        cdp,
        `(() => {
          const rows = [...document.querySelectorAll('#history-list .hist-row')];
          const index = rows.findIndex((row) => row.dataset.selected === 'true');
          const more = document.getElementById('history-more');
          return {
            index,
            id: index === -1 ? null : Number(rows[index].dataset.id),
            current: index === -1 ? null : rows[index].dataset.current,
            selectedCount: rows.filter((row) => row.dataset.selected === 'true').length,
            moreSelected: more.dataset.selected === 'true',
            firstId: rows.length ? Number(rows[0].dataset.id) : null,
            pending: rows.some((row) => row.dataset.pending === 'true'),
          };
        })()`,
      );
    const keyOpen = await waitFor(
      cdp,
      `(() => {
        const first = document.querySelector('#history-list .hist-row');
        return first && first.dataset.selected === 'true' ? true : null;
      })()`,
      3000,
    );
    const keyStart = await readSelection();
    await pressKey(cdp, 'ArrowDown');
    await pressKey(cdp, 'ArrowDown');
    const keyMoved = await readSelection();
    await pressKey(cdp, 'Enter');
    const keyRestored = await waitFor(
      cdp,
      `(() => {
        const first = document.querySelector('#history-list .hist-row');
        if (!first || Number(first.dataset.id) <= ${keyStart.firstId}) return null;
        return first.dataset.restoredFrom === '${keyMoved.id}' && first.dataset.selected === 'true'
          ? { id: Number(first.dataset.id), indicator: document.getElementById('version-indicator').textContent }
          : null;
      })()`,
      6000,
    );
    report(
      'Enter brings the selected version back',
      keyOpen === true &&
        keyStart.index === 0 &&
        keyStart.current === 'true' &&
        keyMoved.index === 2 &&
        keyMoved.selectedCount === 1 &&
        keyRestored !== null &&
        keyRestored.indicator === `v${keyRestored?.id} · from v${keyMoved.id}`,
      JSON.stringify({ keyOpen, keyStart, keyMoved, keyRestored }),
    );

    // Arrow keys walk the rows newest to oldest and skip the session dividers between them.
    const arrowTrail = [];
    let arrowId = keyRestored === null ? null : (await readSelection()).id;
    for (let press = 0; press < 250 && arrowId !== SEED_VERSION_COUNT + 1; press += 1) {
      await pressKey(cdp, 'ArrowDown');
      arrowId = (await readSelection()).id;
      if (press < 3) arrowTrail.push(arrowId);
    }
    const atBoundary = await readSelection();
    await pressKey(cdp, 'ArrowDown');
    const belowBoundary = await readSelection();
    await pressKey(cdp, 'ArrowUp');
    const backAtBoundary = await readSelection();
    report(
      'arrow keys move the History selection and skip dividers',
      atBoundary.id === SEED_VERSION_COUNT + 1 &&
        belowBoundary.id === SEED_VERSION_COUNT &&
        belowBoundary.selectedCount === 1 &&
        backAtBoundary.id === SEED_VERSION_COUNT + 1,
      JSON.stringify({ arrowTrail, atBoundary, belowBoundary, backAtBoundary }),
    );

    // Space opens a version's diff and never restores it, even with the row's own button focused
    // (a native button would click on Space). Enter and Space on the code editor do nothing here.
    await pressKey(cdp, '1');
    await pressKey(cdp, '1');
    await waitFor(
      cdp,
      `(() => {
        const first = document.querySelector('#history-list .hist-row');
        return first && first.dataset.selected === 'true' ? true : null;
      })()`,
      3000,
    );
    const spaceStart = await readSelection();
    await pressKey(cdp, 'ArrowDown');
    const spaceRow = await readSelection();
    const isExpanded = (id) =>
      evaluateExpr(
        cdp,
        `document.querySelector('#history-list .hist-row[data-id="${id}"] .hist-toggle').getAttribute('aria-expanded')`,
      );
    await pressKey(cdp, ' ');
    const expandedByKey = await isExpanded(spaceRow.id);
    await sleep(1000);
    const afterExpand = await readSelection();
    await pressKey(cdp, ' ');
    const collapsedByKey = await isExpanded(spaceRow.id);
    await evaluateExpr(cdp, `document.querySelector('#history-list .hist-row[data-id="${spaceRow.id}"] .hist-main').focus()`);
    await pressKey(cdp, ' ');
    const expandedOnButton = await isExpanded(spaceRow.id);
    await sleep(1000);
    const afterButton = await readSelection();
    await pressKey(cdp, ' ');
    const collapsedOnButton = await isExpanded(spaceRow.id);
    await evaluateExpr(cdp, `document.activeElement && document.activeElement.blur && document.activeElement.blur()`);
    report(
      'Space expands a version without restoring it, even on a focused row button',
      spaceStart.index === 0 &&
        spaceRow.index === 1 &&
        expandedByKey === 'true' &&
        afterExpand.firstId === spaceStart.firstId &&
        collapsedByKey === 'false' &&
        expandedOnButton === 'true' &&
        afterButton.firstId === spaceStart.firstId &&
        afterButton.pending === false &&
        collapsedOnButton === 'false',
      JSON.stringify({ spaceStart, spaceRow, expandedByKey, afterExpand, collapsedByKey, expandedOnButton, afterButton, collapsedOnButton }),
    );

    // --- History accessibility and row hover ---
    {
      await evaluateExpr(cdp, `document.activeElement && document.activeElement.blur && document.activeElement.blur()`);
      if (await evaluateExpr(cdp, `document.getElementById('history-view').hidden`)) await pressKey(cdp, '1');
      await pressKey(cdp, 'b');
      await waitFor(
        cdp,
        `(() => {
          const view = document.getElementById('history-view');
          return !view.hidden && document.querySelectorAll('#history-list .hist-row').length >= 3 ? true : null;
        })()`,
        5000,
      );
      const names = await evaluateExpr(
        cdp,
        `(() => {
          const rows = [...document.querySelectorAll('#history-list .hist-row')];
          const read = rows.map((row) => {
            const id = row.dataset.id;
            const main = row.querySelector('.hist-main');
            const toggle = row.querySelector('.hist-toggle');
            return {
              id,
              current: row.dataset.current,
              mainName: main.getAttribute('aria-label'),
              mainDisabled: main.getAttribute('aria-disabled'),
              toggleName: toggle.getAttribute('aria-label'),
              toggleExpanded: toggle.getAttribute('aria-expanded'),
              toggleText: toggle.textContent,
            };
          });
          const mismatches = read.filter((r) => {
            const isCurrent = r.current === 'true';
            const mainOk = isCurrent
              ? r.mainName === 'Current version v' + r.id && r.mainDisabled === 'true'
              : r.mainName === 'Restore v' + r.id && r.mainDisabled === 'false';
            const toggleOk =
              r.toggleName === 'Show changes in v' + r.id && r.toggleExpanded === 'false' && r.toggleText === 'Changes';
            return !(mainOk && toggleOk);
          });
          const live = (id) => {
            const el = document.getElementById(id);
            return { role: el.getAttribute('role'), live: el.getAttribute('aria-live') };
          };
          return {
            rows: read.length,
            currentCount: read.filter((r) => r.current === 'true').length,
            distinctToggleNames: new Set(read.map((r) => r.toggleName)).size === read.length,
            mismatches: mismatches.slice(0, 5),
            mismatchCount: mismatches.length,
            secondId: read.length > 1 ? read[1].id : null,
            notice: live('history-notice'),
            message: live('history-message'),
            more: live('history-more-status'),
          };
        })()`,
      );
      const toggleState = (id) =>
        evaluateExpr(
          cdp,
          `(() => {
            const t = document.querySelector('#history-list .hist-row[data-id="${id}"] .hist-toggle');
            return { text: t.textContent, name: t.getAttribute('aria-label'), expanded: t.getAttribute('aria-expanded') };
          })()`,
        );
      let opened = null;
      let firstWhileOpen = null;
      let closed = null;
      if (names.secondId !== null) {
        const secondSelector = `#history-list .hist-row[data-id="${names.secondId}"] .hist-toggle`;
        await clickElement(cdp, secondSelector);
        await waitFor(
          cdp,
          `document.querySelector(${JSON.stringify(secondSelector)}).getAttribute('aria-expanded') === 'true' ? true : null`,
          3000,
        );
        opened = await toggleState(names.secondId);
        firstWhileOpen = await evaluateExpr(
          cdp,
          `document.querySelector('#history-list .hist-row .hist-toggle').getAttribute('aria-label')`,
        );
        await clickElement(cdp, secondSelector);
        await sleep(300);
        closed = await toggleState(names.secondId);
      }
      await evaluateExpr(cdp, `document.activeElement && document.activeElement.blur && document.activeElement.blur()`);
      const firstId = await evaluateExpr(cdp, `document.querySelector('#history-list .hist-row').dataset.id`);
      const liveOk = (x) => x.role === 'status' && x.live === 'polite';
      report(
        'History buttons name their version, and the History status lines are live regions',
        names.rows >= 3 &&
          names.currentCount === 1 &&
          names.mismatchCount === 0 &&
          names.distinctToggleNames &&
          opened !== null &&
          opened.text === 'Hide' &&
          opened.name === 'Hide changes in v' + names.secondId &&
          opened.expanded === 'true' &&
          firstWhileOpen === 'Show changes in v' + firstId &&
          closed.text === 'Changes' &&
          closed.name === 'Show changes in v' + names.secondId &&
          closed.expanded === 'false' &&
          liveOk(names.notice) &&
          liveOk(names.message) &&
          liveOk(names.more),
        JSON.stringify({ names, opened, firstWhileOpen, closed }),
      );

      // Whole-row hover. Layout b, no diff open, the second row selected (the toggle click above
      // selected it): T is the first row that is neither current nor selected, C the current row.
      const afterFrames = (body) =>
        `new Promise((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => {
            ${body}
          }));
        })`;
      const hoverPick = await evaluateExpr(
        cdp,
        `(() => {
          const rows = [...document.querySelectorAll('#history-list .hist-row')];
          const target = rows.find((row) => row.dataset.current !== 'true' && row.dataset.selected !== 'true');
          const current = rows.find((row) => row.dataset.current === 'true' && row.dataset.selected !== 'true');
          return {
            targetId: target ? target.dataset.id : null,
            currentId: current ? current.dataset.id : null,
            selectedId: (rows.find((row) => row.dataset.selected === 'true') || { dataset: {} }).dataset.id || null,
          };
        })()`,
      );
      const moveMouse = (x, y) => cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      const rowPoints = (id) =>
        evaluateExpr(
          cdp,
          `(() => {
            const row = document.querySelector('#history-list .hist-row[data-id="${id}"]');
            row.scrollIntoView({ block: 'nearest' });
            const center = (el) => {
              const r = el.getBoundingClientRect();
              return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
            };
            const rowRect = row.getBoundingClientRect();
            const graph = row.querySelector('.hist-graph').getBoundingClientRect();
            return {
              main: center(row.querySelector('.hist-main')),
              gutter: { x: graph.x + graph.width / 2, y: rowRect.y + rowRect.height / 2 },
              toggle: center(row.querySelector('.hist-toggle')),
            };
          })()`,
        );
      const readFill = (id) =>
        evaluateExpr(
          cdp,
          afterFrames(`
            const probe = document.createElement('span');
            probe.style.color = 'var(--surface-2)';
            document.body.appendChild(probe);
            const surface = getComputedStyle(probe).color;
            probe.remove();
            const row = document.querySelector('#history-list .hist-row[data-id="${id}"]');
            resolve({
              row: getComputedStyle(row).backgroundColor,
              main: getComputedStyle(row.querySelector('.hist-main')).backgroundColor,
              toggle: getComputedStyle(row.querySelector('.hist-toggle')).backgroundColor,
              mainDisabled: row.querySelector('.hist-main').getAttribute('aria-disabled'),
              surface,
            });
          `),
        );
      const CLEAR = 'rgba(0, 0, 0, 0)';
      let hoverDetail = { hoverPick };
      let hoverPass = false;
      if (hoverPick.targetId !== null && hoverPick.currentId !== null) {
        const tPoints = await rowPoints(hoverPick.targetId);
        const onMain = (await moveMouse(tPoints.main.x, tPoints.main.y), await readFill(hoverPick.targetId));
        const onGutter = (await moveMouse(tPoints.gutter.x, tPoints.gutter.y), await readFill(hoverPick.targetId));
        const onToggle = (await moveMouse(tPoints.toggle.x, tPoints.toggle.y), await readFill(hoverPick.targetId));
        const cPoints = await rowPoints(hoverPick.currentId);
        const onCurrent = (await moveMouse(cPoints.main.x, cPoints.main.y), await readFill(hoverPick.currentId));
        await moveMouse(1, 1);
        const away = await readFill(hoverPick.targetId);
        const filled = (f) => f.row === f.surface && f.main === CLEAR && f.toggle === CLEAR;
        hoverDetail = { hoverPick, onMain, onGutter, onToggle, onCurrent, away };
        hoverPass =
          filled(onMain) &&
          filled(onGutter) &&
          filled(onToggle) &&
          onCurrent.mainDisabled === 'true' &&
          onCurrent.row === CLEAR &&
          away.row === CLEAR &&
          onMain.surface !== CLEAR;
      }
      await moveMouse(1, 1);
      report(
        'a hovered History row fills whole in --surface-2, gutter and Changes included, but not a row with nothing to restore',
        hoverPass,
        JSON.stringify(hoverDetail),
      );

      // Toggle placement: on line 2 through the row grid, at the row's right end, never over line 2's text.
      const secondSelector2 = `#history-list .hist-row[data-id="${names.secondId}"] .hist-toggle`;
      await clickElement(cdp, secondSelector2);
      await waitFor(
        cdp,
        `document.querySelector(${JSON.stringify(secondSelector2)}).getAttribute('aria-expanded') === 'true' ? true : null`,
        3000,
      );
      const placement = await evaluateExpr(
        cdp,
        afterFrames(`
          const rows = [...document.querySelectorAll('#history-list .hist-row')];
          const secondIndex = rows.findIndex((row) => row.dataset.id === '${names.secondId}');
          const measure = (row) => {
            const toggle = row.querySelector('.hist-toggle').getBoundingClientRect();
            const line2 = row.querySelector('.hist-line2').getBoundingClientRect();
            const status = row.querySelector('.hist-status').getBoundingClientRect();
            const diff = row.querySelector('.hist-diff');
            return {
              bottomGap: toggle.bottom - line2.bottom,
              rightGap: toggle.right - status.right,
              aboveDiff: diff ? diff.getBoundingClientRect().top - toggle.bottom : null,
            };
          };
          const first = measure(rows[0]);
          const second = measure(rows[secondIndex]);
          rows[0].style.paddingTop = '0.75rem';
          const padded = (() => {
            const toggle = rows[0].querySelector('.hist-toggle').getBoundingClientRect();
            const line2 = rows[0].querySelector('.hist-line2').getBoundingClientRect();
            return { bottomGap: toggle.bottom - line2.bottom };
          })();
          rows[0].style.paddingTop = '';
          const offenders = [];
          for (const row of rows) {
            const line2El = row.querySelector('.hist-line2');
            const line2 = line2El.getBoundingClientRect();
            const toggle = row.querySelector('.hist-toggle').getBoundingClientRect();
            const room = parseFloat(getComputedStyle(line2El).paddingRight);
            const statusMin = parseFloat(getComputedStyle(row.querySelector('.hist-status')).minWidth);
            const covers = toggle.left < line2.right - room - 0.5;
            if (covers || Math.abs(room - statusMin) > 0.5) {
              offenders.push({ id: row.dataset.id, covers, room, statusMin });
            }
          }
          resolve({ first, second, padded, offenderCount: offenders.length, offenders: offenders.slice(0, 5), rows: rows.length });
        `),
      );
      await clickElement(cdp, secondSelector2);
      await sleep(300);
      await evaluateExpr(cdp, `document.activeElement && document.activeElement.blur && document.activeElement.blur()`);
      await moveMouse(1, 1);
      const near = (n) => typeof n === 'number' && Math.abs(n) <= 0.5;
      report(
        "the Changes toggle sits on line 2 at the row's right end and never covers line 2's text",
        near(placement.first.bottomGap) &&
          near(placement.first.rightGap) &&
          near(placement.second.bottomGap) &&
          near(placement.second.rightGap) &&
          typeof placement.second.aboveDiff === 'number' &&
          placement.second.aboveDiff >= -0.5 &&
          near(placement.padded.bottomGap) &&
          placement.rows >= 3 &&
          placement.offenderCount === 0,
        JSON.stringify(placement),
      );
    }

    // --- Mixer ---

    // Two neutral tracks, silent (gain 0), so the fader has something to rewrite.
    await callTool(client, 'set_code', { code: 'drums: s("bd*4").gain(0)\nhats: s("hh*8").gain(0)', label: 'probe mixer' });
    await evaluateExpr(cdp, `(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); })()`);
    const viewBeforeMixer = await evaluateExpr(cdp, `document.getElementById('workspace').dataset.view`);
    if (viewBeforeMixer !== 'none') {
      await pressKey(cdp, 'Escape');
    }
    await pressKey(cdp, 'a');
    await pressKey(cdp, '2');
    await waitFor(
      cdp,
      `(() => { const s = document.getElementById('timeline-view').dataset.state; return s && s !== 'computing' ? s : null; })()`,
      5000,
    );
    const mixerTimelineLanes = await evaluateExpr(
      cdp,
      `[...document.querySelectorAll('#timeline-lanes .lane')].map((l) => ({ name: l.querySelector('.lane-name').textContent, color: l.dataset.color }))`,
    );
    await pressKey(cdp, '3');
    const mixerOpened = await waitFor(
      cdp,
      `(() => (!document.getElementById('mixer-view').hidden && document.querySelectorAll('#mixer-strips .mx-strip').length === 2 ? true : null))()`,
      5000,
    );
    const mixerStripDetail = await evaluateExpr(
      cdp,
      `[...document.querySelectorAll('#mixer-strips .mx-strip')].map((el) => ({ name: el.querySelector('.mx-name').textContent, color: el.dataset.color }))`,
    );
    const mixerLayouts = [];
    for (const layoutKey of ['b', 'c', 'a']) {
      await pressKey(cdp, layoutKey);
      mixerLayouts.push(
        await evaluateExpr(
          cdp,
          `new Promise((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => {
              const view = document.getElementById('mixer-view');
              const strips = [...document.querySelectorAll('#mixer-strips .mx-strip')].map((el) => {
                const r = el.getBoundingClientRect();
                return r.width > 0 && r.height > 0;
              });
              resolve({ layout: document.getElementById('workspace').dataset.layout, viewVisible: !view.hidden && view.offsetHeight > 0, strips });
            }));
          })`,
        ),
      );
    }
    report(
      'key 3 opens the Mixer with one strip per track in code order, colored like the Timeline',
      mixerOpened === true &&
        JSON.stringify(mixerStripDetail.map((strip) => strip.name)) === JSON.stringify(['drums', 'hats']) &&
        JSON.stringify(mixerStripDetail) === JSON.stringify(mixerTimelineLanes) &&
        mixerLayouts.map((detail) => detail.layout).join('') === 'bca' &&
        mixerLayouts.every((detail) => detail.viewVisible && detail.strips.length === 2 && detail.strips.every(Boolean)),
      JSON.stringify({ mixerStripDetail, mixerTimelineLanes, mixerLayouts }),
    );

    const newestVersionId = async () => {
      const reply = await callTool(client, 'list_history', {});
      const line = reply.split('\n').find((row) => /^#\d+ /.test(row)) ?? '';
      return { id: Number((/^#(\d+) /.exec(line) ?? [])[1]), line };
    };
    const beforeDrag = await newestVersionId();
    await dragSlider(cdp, '.mx-strip[data-track="label:drums"] .mx-fader', 0.02, 0.72, 8);
    const afterRelease = await waitFor(
      cdp,
      `(() => {
        const flashes = document.querySelectorAll('.mx-flash').length;
        return flashes > 0 ? { flashes, code: document.getElementById('repl').editor.repl.state.activeCode } : null;
      })()`,
      800,
    );
    const idRightAfterRelease = (await newestVersionId()).id;
    await sleep(3000);
    const afterPause = await newestVersionId();
    const flashesAfterPause = await evaluateExpr(cdp, `document.querySelectorAll('.mx-flash').length`);
    const dragCode = afterRelease === null ? '' : afterRelease.code;
    const drumsGain = /^drums: s\("bd\*4"\)\.gain\(([0-9.]+)\)$/m.exec(dragCode);
    report(
      'a fader drag rewrites the gain live and records one page version about 1.5 s after release',
      afterRelease !== null &&
        drumsGain !== null &&
        Number(drumsGain[1]) > 0 &&
        dragCode.split('\n')[1] === 'hats: s("hh*8").gain(0)' &&
        idRightAfterRelease === beforeDrag.id &&
        afterPause.id === beforeDrag.id + 1 &&
        afterPause.line.includes(` — page — "mixer: drums volume ${drumsGain[1]}" — `),
      JSON.stringify({ beforeDrag, idRightAfterRelease, afterPause, dragCode }),
    );
    report(
      'the touched code line lights up and goes dark about 1.5 s after the last move',
      afterRelease !== null && afterRelease.flashes > 0 && flashesAfterPause === 0,
      JSON.stringify({ flashesAfterRelease: afterRelease === null ? 0 : afterRelease.flashes, flashesAfterPause }),
    );
    await pressKey(cdp, 'Escape');

    // --- Mixer ---

    const MIXER_DIRTY_COPY =
      'The editor has changes that are not playing yet. Evaluate them first — the mixer works on the playing code.';
    const replExpr = `document.getElementById('repl').editor`;
    const blurActive = () =>
      evaluateExpr(cdp, `(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); })()`);
    const noticeState = `(() => {
      const n = document.getElementById('mixer-notice');
      const faders = [...document.querySelectorAll('#mixer-strips .mx-fader')];
      return { hidden: n.hidden, text: n.textContent, faders: faders.length, disabled: faders.filter((f) => f.disabled).length };
    })()`;

    await callTool(client, 'set_code', { code: 'drums: s("bd*4").gain(0)\nhats: s("hh*8").gain(0)', label: 'probe mixer 2' });
    await blurActive();
    await pressKey(cdp, '3');
    await waitFor(cdp, `document.querySelectorAll('#mixer-strips .mx-strip').length === 2 ? true : null`, 5000);

    // A hand edit that is typed but not evaluated turns the mixer off and says why; evaluating turns it on.
    await evaluateExpr(cdp, `${replExpr}.editor.dispatch({ changes: { from: 0, insert: '// probe\\n' } })`);
    const dirtyOn = await waitFor(
      cdp,
      `(() => { const st = ${noticeState}; return !st.hidden && st.text === ${JSON.stringify(MIXER_DIRTY_COPY)} && st.faders === 2 && st.disabled === 2 ? st : null; })()`,
      2000,
    );
    await evaluateExpr(cdp, `${replExpr}.evaluate()`);
    const dirtyOff = await waitFor(
      cdp,
      `(() => { const st = ${noticeState}; return st.hidden && st.faders === 2 && st.disabled === 0 ? st : null; })()`,
      3000,
    );
    report(
      'an unevaluated hand edit turns the mixer off with the notice, and evaluating it turns it back on',
      dirtyOn !== null && dirtyOff !== null,
      JSON.stringify({ dirtyOn, dirtyOff }),
    );

    // A track built from a constant is edited at the end of its own chain; a condition is still refused with its reason.
    const sharedCode = ['const beat = s("bd*4").gain(0)', 'kick: beat', 'hats: s("hh*8").gain(0)', 'cond: (1 ? s("cp") : s("bd")).gain(0)'].join('\n');
    await callTool(client, 'set_code', { code: sharedCode, label: 'probe mixer shared code' });
    await waitFor(
      cdp,
      `document.querySelectorAll('#mixer-strips .mx-strip').length === 4 && ${replExpr}.repl.state.activeCode === ${JSON.stringify(sharedCode)} && document.getElementById('mixer-notice').hidden ? true : null`,
      5000,
    );
    const sharedRead = (track) => `(() => {
      const el = document.querySelector('#mixer-strips .mx-strip[data-track="label:${track}"]');
      if (!el) return null;
      const reason = el.querySelector('.mx-reason');
      return { reason: reason && !reason.hidden ? reason.textContent : null, disabled: el.querySelector('.mx-fader').disabled };
    })()`;
    const sharedBefore = {
      kick: await evaluateExpr(cdp, sharedRead('kick')),
      hats: await evaluateExpr(cdp, sharedRead('hats')),
      cond: await evaluateExpr(cdp, sharedRead('cond')),
    };
    await dragSlider(cdp, '.mx-strip[data-track="label:kick"] .mx-fader', 0.02, 0.72, 8);
    const sharedAfter = await waitFor(
      cdp,
      `(() => { const code = ${replExpr}.repl.state.activeCode; return code !== ${JSON.stringify(sharedCode)} ? code : null; })()`,
      3000,
    );
    const sharedLines = (sharedAfter ?? '').split('\n');
    const sharedOriginal = sharedCode.split('\n');
    report(
      'mixer shared code: a track built from a constant is edited at the end of its own chain',
      sharedBefore.kick !== null &&
        sharedBefore.kick.reason === null &&
        sharedBefore.kick.disabled === false &&
        sharedBefore.cond !== null &&
        sharedBefore.cond.reason === MIXER_COPY.reasons.condition &&
        sharedBefore.cond.disabled === true &&
        sharedAfter !== null &&
        sharedLines.length === 4 &&
        /^kick: beat\.postgain\([0-9.]+\)$/.test(sharedLines[1]) &&
        sharedLines[0] === sharedOriginal[0] &&
        sharedLines[2] === sharedOriginal[2] &&
        sharedLines[3] === sharedOriginal[3],
      JSON.stringify({ sharedBefore, sharedAfter }),
    );

    // The strip says it reads only the track's own chain: a muted line on the kick strip, none on the hats strip.
    await callTool(client, 'set_code', { code: sharedCode, label: 'probe mixer shared code line' });
    await waitFor(
      cdp,
      `document.querySelectorAll('#mixer-strips .mx-strip').length === 4 && ${replExpr}.repl.state.activeCode === ${JSON.stringify(sharedCode)} && document.getElementById('mixer-notice').hidden ? true : null`,
      5000,
    );
    const sharedNotes = await evaluateExpr(
      cdp,
      `(() => {
        const read = (track) => {
          const el = document.querySelector('#mixer-strips .mx-strip[data-track="label:' + track + '"] .mx-root-note');
          if (!el) return null;
          return { hidden: el.hidden, shown: el.getClientRects().length > 0, text: el.textContent, title: el.title };
        };
        return { kick: read('kick'), hats: read('hats') };
      })()`,
    );
    report(
      'mixer shared code: the strip says it reads only its own chain',
      sharedNotes.kick !== null &&
        sharedNotes.kick.hidden === false &&
        sharedNotes.kick.shown === true &&
        sharedNotes.kick.text === MIXER_COPY.sharedRoot &&
        sharedNotes.kick.title === MIXER_COPY.sharedRootTitle &&
        sharedNotes.hats !== null &&
        sharedNotes.hats.hidden === true &&
        sharedNotes.hats.shown === false,
      JSON.stringify(sharedNotes),
    );

    // Selecting a strip lights its block of code: the light is one overlay in the editor's scroll container,
    // from the label line to the end of the statement, scrolled into view by a selection and never by anything else.
    const LIT_PROGRAM = [
      ...Array.from({ length: 80 }, (_, index) => `// filler line ${index + 1}`),
      'drums: s("bd*4").gain(0)',
      'hats: s("hh*8")',
      '  .fast(2)',
      '  .gain(0)',
    ].join('\n');
    const litView = `${replExpr}.editor`;
    // The page-side reading of the light: the lit elements, the rows of the label line and of the last line of the
    // program (from the real .cm-line elements, falling back to the editor's own line blocks), the editor's scroller.
    const litSnapshot = (label) => `(() => {
      const view = ${litView};
      const scroller = view.scrollDOM;
      const doc = view.state.doc.toString();
      const rect = (el) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; };
      const rowAt = (pos) => {
        const found = view.domAtPos(pos);
        const node = found.node.nodeType === 3 ? found.node.parentElement : found.node;
        const line = node === null ? null : node.closest('.cm-line');
        if (line !== null) return rect(line);
        const block = view.lineBlockAt(pos);
        return { top: view.documentTop + block.top, bottom: view.documentTop + block.top + block.height };
      };
      const lits = [...document.querySelectorAll('.mx-lit')];
      const selection = view.state.selection.main;
      const stripState = (track) => {
        const el = document.querySelector('#mixer-strips .mx-strip[data-track="label:' + track + '"]');
        return el === null ? null : { selected: el.dataset.selected, pressed: el.querySelector('.mx-name').getAttribute('aria-pressed') };
      };
      return {
        count: lits.length,
        lit: lits.length === 0 ? null : { ...rect(lits[0]), track: lits[0].dataset.track },
        labelRow: doc.indexOf(${JSON.stringify(label)}) === -1 ? null : rowAt(doc.indexOf(${JSON.stringify(label)})),
        lastRow: rowAt(doc.length),
        box: rect(scroller),
        scrollTop: scroller.scrollTop,
        clientHeight: scroller.clientHeight,
        scrollHeight: scroller.scrollHeight,
        anchor: selection.anchor,
        head: selection.head,
        doc,
        activeCode: ${replExpr}.repl.state.activeCode,
        drums: stripState('drums'),
        hats: stripState('hats'),
      };
    })()`;
    await callTool(client, 'set_code', { code: LIT_PROGRAM, label: 'probe mixer lit' });
    await blurActive();
    await waitFor(
      cdp,
      `document.querySelectorAll('#mixer-strips .mx-strip').length === 2 && ${replExpr}.repl.state.activeCode === ${JSON.stringify(LIT_PROGRAM)} && document.getElementById('mixer-notice').hidden ? true : null`,
      5000,
    );
    // A layout where the editor and the Mixer are both visible and the editor scrolls.
    let litLayout = null;
    for (const layoutKey of ['a', 'b', 'c']) {
      await pressKey(cdp, layoutKey);
      const layout = await evaluateExpr(
        cdp,
        `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => {
          const mixer = document.getElementById('mixer-view');
          const scroller = ${litView}.scrollDOM;
          resolve({ layout: document.getElementById('workspace').dataset.layout, mixerVisible: !mixer.hidden && mixer.offsetHeight > 0, clientHeight: scroller.clientHeight, scrollHeight: scroller.scrollHeight });
        })))`,
      );
      if (layout.mixerVisible && layout.clientHeight > 0 && layout.clientHeight < layout.scrollHeight) {
        litLayout = layout;
        break;
      }
    }
    await evaluateExpr(cdp, `(() => { const view = ${litView}; view.dispatch({ selection: { anchor: 5, head: 9 } }); view.scrollDOM.scrollTop = 0; })()`);
    const litBefore = await evaluateExpr(cdp, litSnapshot('hats:'));
    const litBeforeId = (await newestVersionId()).id;
    await clickElement(cdp, '#mixer-strips .mx-strip[data-track="label:hats"] .mx-name');
    const litAfter = await waitFor(cdp, `(() => { const s = ${litSnapshot('hats:')}; return s.count === 1 ? s : null; })()`, 3000);
    const litAfterId = (await newestVersionId()).id;
    const near = (a, b) => Math.abs(a - b) <= 1;
    report(
      'mixer lit: selecting a strip lights its block from the label and scrolls it into view',
      litLayout !== null &&
        litBefore.count === 0 &&
        litAfter !== null &&
        litAfter.count === 1 &&
        near(litAfter.lit.top, litAfter.labelRow.top) &&
        near(litAfter.lit.bottom, litAfter.lastRow.bottom) &&
        litAfter.lit.top >= litAfter.box.top - 1 &&
        litAfter.lit.bottom <= litAfter.box.bottom + 1 &&
        litAfter.scrollTop > 0 &&
        litAfter.anchor === litBefore.anchor &&
        litAfter.head === litBefore.head &&
        litAfter.doc === litBefore.doc &&
        litAfter.activeCode === litBefore.activeCode &&
        litAfterId === litBeforeId &&
        litAfter.hats.selected === 'true' &&
        litAfter.hats.pressed === 'true' &&
        litAfter.drums.selected === 'false' &&
        litAfter.lit.track === 'label:hats',
      JSON.stringify({
        layout: litLayout,
        litBefore: { count: litBefore.count, scrollTop: litBefore.scrollTop, anchor: litBefore.anchor, head: litBefore.head },
        litAfter: litAfter === null ? null : { ...litAfter, doc: undefined, activeCode: undefined },
        litBeforeId,
        litAfterId,
      }),
    );

    // The light is true or absent: an unevaluated hand edit makes the editor differ from the playing code and
    // takes it away; evaluating brings it back at the label line (one line lower); closing the Mixer removes it
    // and keeps the selection; reopening lights it again without scrolling; a second click on the name clears it;
    // touching another strip's fader selects that strip.
    await evaluateExpr(cdp, `${litView}.dispatch({ changes: { from: 0, insert: '// a hand edit\\n' } })`);
    const litGoneOnEdit = await waitFor(cdp, `document.querySelectorAll('.mx-lit').length === 0 ? true : null`, 1000);
    await evaluateExpr(cdp, `${replExpr}.evaluate()`);
    const litAfterEvaluate = await waitFor(
      cdp,
      `(() => { const s = ${litSnapshot('hats:')}; return s.count === 1 && Math.abs(s.lit.top - s.labelRow.top) <= 1 && Math.abs(s.lit.bottom - s.lastRow.bottom) <= 1 ? s : null; })()`,
      3000,
    );
    const litScrollBeforeClose = litAfterEvaluate === null ? null : litAfterEvaluate.scrollTop;
    await blurActive();
    await pressKey(cdp, 'Escape');
    const litGoneOnClose = await waitFor(
      cdp,
      `document.querySelectorAll('.mx-lit').length === 0 && document.getElementById('mixer-view').hidden ? true : null`,
      1500,
    );
    await pressKey(cdp, '3');
    const litAfterReopen = await waitFor(
      cdp,
      `(() => { const s = ${litSnapshot('hats:')}; return s.count === 1 && Math.abs(s.lit.top - s.labelRow.top) <= 1 ? s : null; })()`,
      3000,
    );
    await clickElement(cdp, '#mixer-strips .mx-strip[data-track="label:hats"] .mx-name');
    const litClearedByClick = await waitFor(
      cdp,
      `(() => { const s = ${litSnapshot('hats:')}; return s.count === 0 && s.hats.pressed === 'false' && s.hats.selected === 'false' ? s : null; })()`,
      1500,
    );
    await dragSlider(cdp, '#mixer-strips .mx-strip[data-track="label:drums"] .mx-fader', 0.02, 0.4, 4);
    const litOnDrums = await waitFor(
      cdp,
      `(() => { const s = ${litSnapshot('drums:')}; return s.count === 1 && s.lit.track === 'label:drums' && s.drums.selected === 'true' && Math.abs(s.lit.top - s.labelRow.top) <= 1 ? s : null; })()`,
      4000,
    );
    report(
      'mixer lit: the light follows the playing code',
      litGoneOnEdit === true &&
        litAfterEvaluate !== null &&
        litGoneOnClose === true &&
        litAfterReopen !== null &&
        litScrollBeforeClose !== null &&
        near(litAfterReopen.scrollTop, litScrollBeforeClose) &&
        litClearedByClick !== null &&
        litOnDrums !== null,
      JSON.stringify({
        litGoneOnEdit,
        litAfterEvaluate: litAfterEvaluate === null ? null : { lit: litAfterEvaluate.lit, labelRow: litAfterEvaluate.labelRow, scrollTop: litAfterEvaluate.scrollTop },
        litGoneOnClose,
        litAfterReopen: litAfterReopen === null ? null : { lit: litAfterReopen.lit, labelRow: litAfterReopen.labelRow, scrollTop: litAfterReopen.scrollTop },
        litClearedByClick: litClearedByClick !== null,
        litOnDrums: litOnDrums === null ? null : { lit: litOnDrums.lit, labelRow: litOnDrums.labelRow },
      }),
    );

    // One overlay that moves, never one that blinks: through playback and a viewport change it stays the same node.
    await sleep(2000);
    await evaluateExpr(cdp, `document.querySelector('.mx-lit').__probeLitMark = 'same node'`);
    await sleep(2000);
    await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 760, deviceScaleFactor: 1, mobile: false });
    await sleep(500);
    await cdp('Emulation.clearDeviceMetricsOverride');
    const litAfterResize = await waitFor(
      cdp,
      `(() => { const s = ${litSnapshot('drums:')}; const node = document.querySelector('.mx-lit'); return s.count === 1 && node.__probeLitMark === 'same node' && Math.abs(s.lit.top - s.labelRow.top) <= 1 ? s : null; })()`,
      3000,
    );
    report(
      'mixer lit: one overlay that moves, never blinks',
      litAfterResize !== null,
      JSON.stringify(litAfterResize === null ? { count: await evaluateExpr(cdp, `document.querySelectorAll('.mx-lit').length`), marked: await evaluateExpr(cdp, `(document.querySelector('.mx-lit') || {}).__probeLitMark ?? null`) } : { lit: litAfterResize.lit, labelRow: litAfterResize.labelRow }),
    );

    // No motion, and the change flash of a Mixer move is drawn above the light without removing it.
    const litStyleNow = `(() => {
      const style = getComputedStyle(document.querySelector('.mx-lit'));
      return { motion: document.documentElement.dataset.motion, transitionDuration: style.transitionDuration, animationName: style.animationName };
    })()`;
    const litMotionStart = await evaluateExpr(cdp, `document.documentElement.dataset.motion`);
    const litStyles = {};
    for (const wanted of ['on', 'off']) {
      if ((await evaluateExpr(cdp, `document.documentElement.dataset.motion`)) !== wanted) await clickInDrawer(cdp, '#motion-switch');
      litStyles[wanted] = await evaluateExpr(cdp, litStyleNow);
    }
    if ((await evaluateExpr(cdp, `document.documentElement.dataset.motion`)) !== 'on') await clickInDrawer(cdp, '#motion-switch');
    await dragSlider(cdp, '#mixer-strips .mx-strip[data-track="label:drums"] .mx-fader', 0.4, 0.5, 3);
    const litWithFlash = await waitFor(
      cdp,
      `(() => {
        const lit = document.querySelector('.mx-lit');
        const flashes = [...document.querySelectorAll('.mx-flash')];
        if (lit === null || flashes.length === 0) return null;
        return {
          sameNode: lit.__probeLitMark === 'same node',
          litCount: document.querySelectorAll('.mx-lit').length,
          flashes: flashes.length,
          allAbove: flashes.every((flash) => (lit.compareDocumentPosition(flash) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0),
        };
      })()`,
      1500,
    );
    if (litMotionStart !== 'on' && (await evaluateExpr(cdp, `document.documentElement.dataset.motion`)) === 'on') await clickInDrawer(cdp, '#motion-switch');
    report(
      'mixer lit: no motion, and the change flash draws above it',
      litStyles.on.motion === 'on' &&
        litStyles.off.motion === 'off' &&
        [litStyles.on, litStyles.off].every((style) => style.transitionDuration === '0s' && style.animationName === 'none') &&
        litWithFlash !== null &&
        litWithFlash.sameNode &&
        litWithFlash.litCount === 1 &&
        litWithFlash.allAbove,
      JSON.stringify({ litStyles, litWithFlash }),
    );
    // The light is never drawn on the wrong lines: a click on a strip name selects it and schedules the measure, and the
    // text is shifted three lines before the frame runs it. The measure then finds another document, so after two frames
    // the light is absent (or on the right row), never on the old offsets. Once the text is back it is lit again.
    const litRace = await evaluateExpr(
      cdp,
      `new Promise((resolve) => {
        const view = ${litView};
        const errors = [];
        const realError = console.error;
        const onError = (event) => errors.push(String(event.message || event.error));
        console.error = (...args) => errors.push(args.map(String).join(' '));
        window.addEventListener('error', onError);
        const shift = '// shifted\\n// shifted\\n// shifted\\n';
        document.querySelector('#mixer-strips .mx-strip[data-track="label:hats"] .mx-name').click();
        view.dispatch({ changes: { from: 0, insert: shift } });
        requestAnimationFrame(() => requestAnimationFrame(() => {
          const snapshot = ${litSnapshot('hats:')};
          console.error = realError;
          window.removeEventListener('error', onError);
          view.dispatch({ changes: { from: 0, to: shift.length, insert: '' } });
          resolve({ errors, count: snapshot.count, lit: snapshot.lit, labelRow: snapshot.labelRow });
        }));
      })`,
    );
    const litAfterRace = await waitFor(
      cdp,
      `(() => { const s = ${litSnapshot('hats:')}; return s.count === 1 && s.lit.track === 'label:hats' && Math.abs(s.lit.top - s.labelRow.top) <= 1 && Math.abs(s.lit.bottom - s.lastRow.bottom) <= 1 ? s : null; })()`,
      4000,
    );
    report(
      'mixer lit: a document that changes before the measure runs is never measured, and the light comes back on the right lines',
      litRace.errors.length === 0 &&
        (litRace.count === 0 || (litRace.count === 1 && litRace.labelRow !== null && near(litRace.lit.top, litRace.labelRow.top))) &&
        litAfterRace !== null,
      JSON.stringify({ litRace, litAfterRace: litAfterRace === null ? null : { lit: litAfterRace.lit, labelRow: litAfterRace.labelRow, lastRow: litAfterRace.lastRow } }),
    );
    // Back to the layout the following Mixer checks start from.
    await blurActive();
    await pressKey(cdp, 'a');

    // No gain shows the default; a moving gain makes the fader write a level after it.
    await callTool(client, 'set_code', {
      code: 'drums: s("bd*4")\nhats: s("hh*8").gain(sine.range(0, 0.1))',
      label: 'probe mixer lines',
    });
    const stripLines = await waitFor(
      cdp,
      `(() => {
        const read = (track) => {
          const el = document.querySelector('#mixer-strips .mx-strip[data-track="label:' + track + '"]');
          if (!el) return null;
          const line = el.querySelector('.mx-fader-line');
          return { line: line ? line.textContent : null, title: line ? line.title : null, readout: el.querySelector('.mx-readout').textContent };
        };
        const drums = read('drums');
        const hats = read('hats');
        return drums && hats && drums.line !== null && hats.line !== null ? { drums, hats } : null;
      })()`,
      3000,
    );
    await dragSlider(cdp, '.mx-strip[data-track="label:hats"] .mx-fader', 0.5, 0.6, 4);
    const postgainCode = await waitFor(
      cdp,
      `(() => { const code = ${replExpr}.repl.state.activeCode; return /\\.postgain\\(/.test(code) ? code : null; })()`,
      2000,
    );
    const postgainHats = (postgainCode ?? '').split('\n')[1] ?? '';
    report(
      'a track with no gain shows 1.00 default, a moving gain shows after gain',
      stripLines !== null &&
        stripLines.drums.line === 'default' &&
        stripLines.drums.title === MIXER_COPY.faderDefaultTitle &&
        stripLines.drums.readout === '1.00' &&
        stripLines.hats.line === 'after gain' &&
        stripLines.hats.title === 'The gain moves in the code, so this fader sets a level after it.' &&
        /^hats: s\("hh\*8"\)\.gain\(sine\.range\(0, 0\.1\)\)\.postgain\([0-9.]+\)$/.test(postgainHats),
      JSON.stringify({ stripLines, postgainHats }),
    );
    await sleep(2000);

    // Mixer dynamics: in this Strudel a track-level .gain replaces the gains set inside the
    // track, so the fader writes .postgain and keeps the loud-to-quiet ratio. Both facts are read
    // from the real pattern, not from the code text.
    const dynamicsExpr = `(() => {
      const haps = ${replExpr}.repl.state.pattern.queryArc(0, 1);
      return haps.map((h) => ({ s: h.value.s, gain: h.value.gain ?? null, postgain: h.value.postgain ?? null }));
    })()`;
    const DYNAMICS_STACK = 'stack(s("bd").gain(1), s("hh*4").gain(.3))';
    const playsCode = (code) =>
      waitFor(cdp, `${replExpr}.repl.state.activeCode === ${JSON.stringify(code)} ? true : null`, 5000);

    const replacingCode = `drums: ${DYNAMICS_STACK}.gain(0.5)`;
    await callTool(client, 'set_code', { code: replacingCode, label: 'probe mixer dynamics replace' });
    await playsCode(replacingCode);
    const replacedHaps = await evaluateExpr(cdp, dynamicsExpr);
    report(
      'mixer dynamics: a track-level .gain replaces the per-note gains in this Strudel',
      replacedHaps.length === 5 && replacedHaps.every((hap) => hap.gain === 0.5),
      JSON.stringify(replacedHaps),
    );

    const scaledStart = `drums: ${DYNAMICS_STACK}`;
    await callTool(client, 'set_code', { code: scaledStart, label: 'probe mixer dynamics scale' });
    await playsCode(scaledStart);
    await waitFor(cdp, `document.querySelector('#mixer-strips .mx-strip[data-track="label:drums"] .mx-fader') ? true : null`, 5000);
    const beforeScale = await evaluateExpr(cdp, dynamicsExpr);
    await dragSlider(cdp, '.mx-strip[data-track="label:drums"] .mx-fader', 0.8, 0.45, 6);
    const scaledCode = await waitFor(
      cdp,
      `(() => { const code = ${replExpr}.repl.state.activeCode; return /^drums: stack\\(s\\("bd"\\)\\.gain\\(1\\), s\\("hh\\*4"\\)\\.gain\\(\\.3\\)\\)\\.postgain\\([0-9.]+\\)$/.test(code) ? code : null; })()`,
      3000,
    );
    const afterScale = await evaluateExpr(cdp, dynamicsExpr);
    const writtenPostgain = scaledCode === null ? NaN : Number(/\.postgain\(([0-9.]+)\)$/.exec(scaledCode)[1]);
    const sorted = (haps) => [...haps].sort((a, b) => a.s.localeCompare(b.s));
    const keptRatio = (haps) =>
      haps.length === 5 && haps.filter((hap) => hap.s === 'bd').every((hap) => hap.gain === 1) && haps.filter((hap) => hap.s === 'hh').length === 4 && haps.filter((hap) => hap.s === 'hh').every((hap) => hap.gain === 0.3);
    report(
      'mixer dynamics: a fader drag keeps the per-note gains',
      scaledCode !== null &&
        Number.isFinite(writtenPostgain) &&
        scaledCode.split('.postgain(').length === 2 &&
        beforeScale.length === 5 &&
        beforeScale.every((hap) => hap.postgain === null) &&
        keptRatio(beforeScale) &&
        keptRatio(afterScale) &&
        afterScale.every((hap) => hap.postgain === writtenPostgain),
      JSON.stringify({ before: sorted(beforeScale), after: sorted(afterScale), code: scaledCode }),
    );

    // A move while the page is stopped rewrites the code, stays silent and still records one version.
    await callTool(client, 'set_code', { code: 'drums: s("bd*4").gain(0)', label: 'probe mixer stopped' });
    await callTool(client, 'stop', {});
    await waitFor(cdp, `document.querySelector('#sound-state .state-label').textContent === 'Stopped' ? true : null`, 3000);
    const beforeStoppedDrag = await newestVersionId();
    await dragSlider(cdp, '.mx-strip[data-track="label:drums"] .mx-fader', 0.02, 0.72, 8);
    await sleep(3000);
    const afterStoppedDrag = await newestVersionId();
    const stoppedState = await evaluateExpr(
      cdp,
      `(() => ({
        code: ${replExpr}.repl.state.activeCode,
        started: ${replExpr}.repl.scheduler.started,
        label: document.querySelector('#sound-state .state-label').textContent,
      }))()`,
    );
    const stoppedGain = /^drums: s\("bd\*4"\)\.gain\(([0-9.]+)\)$/m.exec(stoppedState.code);
    report(
      'a fader move while the page is stopped stays silent and still records one version',
      stoppedGain !== null &&
        Number(stoppedGain[1]) > 0 &&
        stoppedState.started === false &&
        stoppedState.label !== 'Playing' &&
        afterStoppedDrag.id === beforeStoppedDrag.id + 1 &&
        afterStoppedDrag.line.includes(' — page — "mixer: drums volume '),
      JSON.stringify({ beforeStoppedDrag, afterStoppedDrag, stoppedState }),
    );

    // A program with no tracks says so.
    await callTool(client, 'set_code', { code: 'setcps(0.5)', label: 'probe mixer empty' });
    const emptyMixer = await waitFor(
      cdp,
      `(() => {
        const message = document.getElementById('mixer-message');
        const body = document.getElementById('mixer-body');
        return !message.hidden && message.textContent === 'Nothing is playing yet.' && body.hidden ? true : null;
      })()`,
      3000,
    );
    report('the Mixer says Nothing is playing yet when the code has no tracks', emptyMixer === true, JSON.stringify({ emptyMixer }));

    // Claude's code updates the strips in place: the strip elements are reused.
    const stripReadout = (track) =>
      `(() => { const el = document.querySelector('#mixer-strips .mx-strip[data-track="label:${track}"]'); return el ? el.querySelector('.mx-readout').textContent : null; })()`;
    await callTool(client, 'set_code', {
      code: 'drums: s("bd*4").gain(0)\nhats: s("hh*8").gain(0)',
      label: 'probe in place base',
    });
    await waitFor(cdp, `document.querySelectorAll('#mixer-strips .mx-strip').length === 2 ? true : null`, 3000);
    await evaluateExpr(
      cdp,
      `document.querySelectorAll('#mixer-strips .mx-strip').forEach((el, i) => { el.__probeMark = 'mark' + i; })`,
    );
    await callTool(client, 'set_code', {
      code: 'drums: s("bd*4").gain(0)\nhats: s("hh*8").gain(0.2)',
      label: 'probe in place',
    });
    const hatsReadout = await waitFor(cdp, `${stripReadout('hats')} === '0.20' ? true : null`, 3000);
    const inPlaceMarks = await evaluateExpr(
      cdp,
      `[...document.querySelectorAll('#mixer-strips .mx-strip')].map((el) => el.__probeMark ?? null)`,
    );
    report(
      'Claude changes update the strips in place and keep the strip elements',
      hatsReadout === true && JSON.stringify(inPlaceMarks) === JSON.stringify(['mark0', 'mark1']),
      JSON.stringify({ hatsReadout, inPlaceMarks }),
    );

    // Claude's code right after a fader gesture: the gesture is recorded first, then Claude's version, linked.
    const readVersions = () =>
      fs
        .readFileSync(path.join(dataDir, 'history.jsonl'), 'utf8')
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line))
        .filter((entry) => entry.type === 'version');
    await dragSlider(cdp, '.mx-strip[data-track="label:hats"] .mx-fader', 0.3, 0.6, 6);
    await callTool(client, 'set_code', {
      code: 'drums: s("bd*4").gain(0)\nhats: s("hh*8").gain(0.2)\ncp: s("cp").gain(0)',
      label: 'probe after mixer',
    });
    const orderVersions = readVersions();
    const [pageVersion, claudeVersion] = orderVersions.slice(-2);
    await sleep(2000);
    const laterVersions = readVersions();
    report(
      'Claude set_code during a fader gesture records the gesture first, then Claude version, linked',
      pageVersion !== undefined &&
        claudeVersion !== undefined &&
        pageVersion.origin === 'page' &&
        typeof pageVersion.label === 'string' &&
        pageVersion.label.startsWith('mixer: hats volume') &&
        claudeVersion.origin === 'claude' &&
        claudeVersion.label === 'probe after mixer' &&
        claudeVersion.parent === pageVersion.id &&
        laterVersions.length === orderVersions.length,
      JSON.stringify({ pageVersion, claudeVersion, before: orderVersions.length, after: laterVersions.length }),
    );

    // The touched-line highlight sits on the edited line and leaves the selection and scroll alone.
    await callTool(client, 'set_code', {
      code: 'drums: s("bd*4").gain(0)\nhats: s("hh*8").gain(0)',
      label: 'probe mixer flash',
    });
    await waitFor(cdp, `document.querySelectorAll('#mixer-strips .mx-strip').length === 2 ? true : null`, 3000);
    await sleep(500);
    await evaluateExpr(cdp, `${replExpr}.editor.dispatch({ selection: { anchor: 3, head: 7 } })`);
    const editorBefore = await evaluateExpr(
      cdp,
      `(() => ({ scrollTop: ${replExpr}.editor.scrollDOM.scrollTop, selection: [${replExpr}.editor.state.selection.main.from, ${replExpr}.editor.state.selection.main.to] }))()`,
    );
    await dragSlider(cdp, '.mx-strip[data-track="label:drums"] .mx-fader', 0.02, 0.72, 8);
    const flashRead = await waitFor(
      cdp,
      `(() => {
        const flash = document.querySelector('.mx-flash');
        if (!flash) return null;
        const line = document.querySelector('.cm-content .cm-line');
        const f = flash.getBoundingClientRect();
        const l = line.getBoundingClientRect();
        const view = ${replExpr}.editor;
        return {
          flashTop: f.top, flashHeight: f.height, lineTop: l.top, lineHeight: l.height, lineText: line.textContent,
          scrollTop: view.scrollDOM.scrollTop, selection: [view.state.selection.main.from, view.state.selection.main.to],
        };
      })()`,
      500,
    );
    await callTool(client, 'set_code', {
      code: 'drums: s("bd*4").gain(0)\nhats: s("hh*8").gain(0)',
      label: 'probe flash cleared',
    });
    const flashesAfterClaude = await evaluateExpr(cdp, `document.querySelectorAll('.mx-flash').length`);
    report(
      'the touched-line highlight sits on the edited line and leaves the selection and scroll unchanged',
      flashRead !== null &&
        flashRead.lineText.startsWith('drums:') &&
        Math.abs(flashRead.flashTop - flashRead.lineTop) <= 1 &&
        Math.abs(flashRead.flashHeight - flashRead.lineHeight) <= 1 &&
        JSON.stringify(flashRead.selection) === JSON.stringify([3, 7]) &&
        JSON.stringify(editorBefore.selection) === JSON.stringify([3, 7]) &&
        flashRead.scrollTop === editorBefore.scrollTop &&
        flashesAfterClaude === 0,
      JSON.stringify({ editorBefore, flashRead, flashesAfterClaude }),
    );

    await pressKey(cdp, 'Escape');

    // --- Mixer ---

    // The sounds that play in the next second, from the page's own pattern (a read, no side effect).
    const soundsNow = async () => {
      const now = await readSchedulerNow(cdp);
      const arc = await readArc(cdp, now, now + 1);
      return [...new Set(arc.haps.map((hap) => hap.s))].sort();
    };
    const activeCodeExpr = `document.getElementById('repl').editor.repl.state.activeCode`;
    const waitForCode = (test) =>
      waitFor(cdp, `(() => { const code = ${activeCodeExpr}; return ${test} ? code : null; })()`, 4000);
    const stripDetail = () =>
      evaluateExpr(
        cdp,
        `[...document.querySelectorAll('#mixer-strips .mx-strip')].map((el) => ({
          name: el.querySelector('.mx-name').textContent,
          color: el.dataset.color,
          sounding: el.dataset.sounding,
          mute: el.querySelector('.mx-mute').getAttribute('aria-pressed'),
          solo: el.querySelector('.mx-solo').getAttribute('aria-pressed'),
        }))`,
      );

    await callTool(client, 'set_code', { code: 'drums: s("bd*4").gain(0)\nhats: s("hh*8").gain(0)', label: 'probe mixer 3' });
    await blurActive();
    await pressKey(cdp, '3');
    await waitFor(cdp, `document.querySelectorAll('#mixer-strips .mx-strip').length === 2 ? true : null`, 5000);
    const msColorsBefore = (await stripDetail()).map((strip) => strip.color);

    await clickElement(cdp, '.mx-strip[data-track="label:drums"] .mx-mute');
    const afterMute = await waitForCode(`/^_drums:/m.test(code) && /^hats:/m.test(code)`);
    await clickElement(cdp, '.mx-strip[data-track="label:hats"] .mx-solo');
    const afterSoloHats = await waitForCode(`/^_drums:/m.test(code) && /^S_hats:/m.test(code)`);
    const soundsHatsSolo = await soundsNow();
    await clickElement(cdp, '.mx-strip[data-track="label:drums"] .mx-solo');
    const afterSoloDrums = await waitForCode(`/^S_drums:/m.test(code) && /^S_hats:/m.test(code) && !/^_drums/m.test(code)`);
    const soundsBothSolo = await soundsNow();
    await clickElement(cdp, '.mx-strip[data-track="label:hats"] .mx-mute');
    const afterMuteSoloed = await waitForCode(`/^S_drums:/m.test(code) && /^_hats:/m.test(code) && !code.includes('S_hats')`);
    const msStrips = await stripDetail();
    let historyLines = [];
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const reply = await callTool(client, 'list_history', {});
      historyLines = reply.split('\n').filter((row) => /^#\d+ /.test(row)).slice(0, 4).reverse();
      if (historyLines[3] && historyLines[3].includes('mixer: hats muted')) break;
      await sleep(100);
    }
    const historyOrder = ['mixer: drums muted', 'mixer: hats solo on', 'mixer: drums solo on', 'mixer: hats muted'];
    report(
      'M and S rewrite the label, several tracks can be soloed, and M on a soloed track drops the solo',
      afterMute !== null &&
        afterSoloHats !== null &&
        JSON.stringify(soundsHatsSolo) === JSON.stringify(['hh']) &&
        afterSoloDrums !== null &&
        JSON.stringify(soundsBothSolo) === JSON.stringify(['bd', 'hh']) &&
        afterMuteSoloed !== null &&
        JSON.stringify(msStrips.map((strip) => strip.name)) === JSON.stringify(['drums', 'hats']) &&
        JSON.stringify(msStrips.map((strip) => strip.color)) === JSON.stringify(msColorsBefore) &&
        historyLines.length === 4 &&
        historyOrder.every((text, i) => historyLines[i].includes(`"${text}"`)),
      JSON.stringify({ afterMute, afterSoloHats, soundsHatsSolo, afterSoloDrums, soundsBothSolo, afterMuteSoloed, msStrips, msColorsBefore, historyLines }),
    );

    // The real bundle's own rules, as the strips report them: S_ plays alone, a trailing _ is silent, .hush() silences.
    const stripsFor = async (code, count) => {
      await callTool(client, 'set_code', { code, label: 'probe mixer truth' });
      await waitFor(
        cdp,
        `document.querySelectorAll('#mixer-strips .mx-strip').length === ${count} && ${activeCodeExpr} === ${JSON.stringify(code)} ? true : null`,
        4000,
      );
      const sounds = await soundsNow();
      return { sounds, strips: await stripDetail() };
    };
    const truthMarker = await stripsFor('S_a: s("bd").gain(0)\nb: s("hh").gain(0)', 2);
    const truthTrailing = await stripsFor('Sa_: s("bd").gain(0)\nb: s("hh").gain(0)', 2);
    const truthHush = await stripsFor('stack(s("bd").gain(0).hush(), s("hh").gain(0))', 2);
    const soundingOf = (detail) => detail.strips.map((strip) => strip.sounding).join(',');
    report(
      'the S_ solo marker plays alone, a label ending in _ is silent, and .hush() silences a branch (real bundle)',
      JSON.stringify(truthMarker.sounds) === JSON.stringify(['bd']) &&
        soundingOf(truthMarker) === 'true,false' &&
        truthMarker.strips[0].name === 'a' &&
        JSON.stringify(truthTrailing.sounds) === JSON.stringify(['hh']) &&
        soundingOf(truthTrailing) === 'false,true' &&
        truthTrailing.strips[0].name === 'Sa' &&
        JSON.stringify(truthHush.sounds) === JSON.stringify(['hh']) &&
        soundingOf(truthHush) === 'false,true',
      JSON.stringify({ truthMarker, truthTrailing, truthHush }),
    );

    // An unlabeled branch: S is off and says why; M adds .hush() inside that branch only, M again removes it.
    const branchCode = 'stack(s("bd").gain(0), s("hh").gain(0))';
    await stripsFor(branchCode, 2);
    const branchButtons = await evaluateExpr(
      cdp,
      `[...document.querySelectorAll('#mixer-strips .mx-strip')].map((el) => ({
        soloDisabled: el.querySelector('.mx-solo').disabled,
        muteDisabled: el.querySelector('.mx-mute').disabled,
        note: el.querySelector('.mx-note').hidden ? null : el.querySelector('.mx-note').textContent,
      }))`,
    );
    await clickElement(cdp, '.mx-strip[data-track="s:bd"] .mx-mute');
    const branchHushed = await waitForCode(`code === 'stack(s("bd").gain(0).hush(), s("hh").gain(0))'`);
    const soundsBranchMuted = await soundsNow();
    await clickElement(cdp, '.mx-strip[data-track="s:bd"] .mx-mute');
    const branchUnhushed = await waitForCode(`code === ${JSON.stringify(branchCode)}`);
    report(
      'an unlabeled branch mutes with .hush() and its S button says why it is off',
      branchButtons.length === 2 &&
        branchButtons.every(
          (button) => button.soloDisabled && !button.muteDisabled && button.note === 'Solo needs a label — ask Claude to name this track.',
        ) &&
        branchHushed !== null &&
        JSON.stringify(soundsBranchMuted) === JSON.stringify(['hh']) &&
        branchUnhushed !== null,
      JSON.stringify({ branchButtons, branchHushed, soundsBranchMuted, branchUnhushed }),
    );

    // A name that starts with a capital S plays alone by Strudel's own rule: shown as such, never renamed.
    await stripsFor('Snare: s("sd").gain(0)\nhats: s("hh").gain(0)', 2);
    const snareState = () =>
      evaluateExpr(
        cdp,
        `(() => {
          const el = document.querySelector('#mixer-strips .mx-strip[data-track="label:Snare"]');
          const note = el.querySelector('.mx-note');
          return {
            name: el.querySelector('.mx-name').textContent,
            soloPressed: el.querySelector('.mx-solo').getAttribute('aria-pressed'),
            soloDisabled: el.querySelector('.mx-solo').disabled,
            mutePressed: el.querySelector('.mx-mute').getAttribute('aria-pressed'),
            note: note.hidden ? null : note.textContent,
            hatsSounding: document.querySelector('#mixer-strips .mx-strip[data-track="label:hats"]').dataset.sounding,
          };
        })()`,
      );
    const snareBefore = await snareState();
    await clickElement(cdp, '.mx-strip[data-track="label:Snare"] .mx-mute');
    const snareMuted = await waitForCode(`/^_Snare:/m.test(code)`);
    const snareMutedState = await waitFor(cdp, `(() => { const el = document.querySelector('#mixer-strips .mx-strip[data-track="label:Snare"] .mx-mute'); return el.getAttribute('aria-pressed') === 'true' ? true : null; })()`, 3000);
    const snareMutedDetail = await snareState();
    await clickElement(cdp, '.mx-strip[data-track="label:Snare"] .mx-mute');
    const snareBack = await waitForCode(`/^Snare:/m.test(code) && !code.includes('S_Snare')`);
    await waitFor(cdp, `(() => { const el = document.querySelector('#mixer-strips .mx-strip[data-track="label:Snare"] .mx-mute'); return el.getAttribute('aria-pressed') === 'false' ? true : null; })()`, 3000);
    const snareAfter = await snareState();
    const SNARE_NOTE = 'Starts with a capital S — Strudel plays this track alone.';
    report(
      'a label that starts with a capital S shows as soloed with the warning and is never renamed',
      snareBefore.name === 'Snare' &&
        snareBefore.soloPressed === 'true' &&
        snareBefore.soloDisabled === true &&
        snareBefore.note === SNARE_NOTE &&
        snareBefore.hatsSounding === 'false' &&
        snareMuted !== null &&
        snareMutedState === true &&
        snareMutedDetail.soloPressed === 'false' &&
        snareMutedDetail.note === null &&
        snareBack !== null &&
        snareAfter.soloPressed === 'true' &&
        snareAfter.note === SNARE_NOTE &&
        snareAfter.name === 'Snare',
      JSON.stringify({ snareBefore, snareMuted, snareMutedDetail, snareBack, snareAfter }),
    );
    await pressKey(cdp, 'Escape');

    // The Timeline names a soloed track without the marker.
    await callTool(client, 'set_code', { code: 'S_drums: s("bd*4").gain(0)\nhats: s("hh*8").gain(0)', label: 'probe mixer timeline' });
    await blurActive();
    await pressKey(cdp, '2');
    await waitFor(
      cdp,
      `(() => { const s = document.getElementById('timeline-view').dataset.state; return s && s !== 'computing' ? s : null; })()`,
      5000,
    );
    const soloLaneNames = await waitFor(
      cdp,
      `(() => { const names = [...document.querySelectorAll('#timeline-lanes .lane .lane-name')].map((el) => ({ text: el.textContent, title: el.title })); return names.length === 2 ? names : null; })()`,
      4000,
    );
    report(
      'the Timeline names a soloed track without the S_ marker',
      soloLaneNames !== null &&
        JSON.stringify(soloLaneNames.map((lane) => lane.text)) === JSON.stringify(['drums', 'hats']) &&
        JSON.stringify(soloLaneNames.map((lane) => lane.title)) === JSON.stringify(['drums', 'hats']),
      JSON.stringify({ soloLaneNames }),
    );
    await pressKey(cdp, '2');

    // --- Mixer ---

    const chainNames = () =>
      evaluateExpr(
        cdp,
        `[...document.querySelectorAll('.mx-strip[data-track="label:drums"] .mx-chip .mx-chip-name')].map((el) => el.textContent)`,
      );
    const chipValues = () =>
      evaluateExpr(
        cdp,
        `[...document.querySelectorAll('.mx-strip[data-track="label:drums"] .mx-chip')].map((el) => ({
          effect: el.dataset.effect,
          value: el.querySelector('.mx-chip-value').textContent,
          selected: el.dataset.selected,
          bypassed: el.dataset.bypassed ?? null,
          dotPressed: el.querySelector('.mx-chip-dot').getAttribute('aria-pressed'),
          dotDisabled: el.querySelector('.mx-chip-dot').disabled,
          dotTitle: el.querySelector('.mx-chip-dot').title,
        }))`,
      );
    const mixerHistoryRows = async (count, stop) => {
      let rows = [];
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const reply = await callTool(client, 'list_history', {});
        rows = reply.split('\n').filter((row) => /^#\d+ /.test(row)).slice(0, count);
        if (stop(rows)) break;
        await sleep(100);
      }
      return rows;
    };

    await callTool(client, 'set_code', { code: 'drums: s("bd*4").crush(8).lpf(1200).gain(0)', label: 'probe mixer 4' });
    await blurActive();
    await pressKey(cdp, '3');
    await waitFor(cdp, `document.querySelectorAll('#mixer-strips .mx-strip').length === 1 ? true : null`, 5000);
    const chainBefore = await chainNames();
    await clickElement(cdp, '.mx-strip[data-track="label:drums"] .mx-add');
    const addListNames = await evaluateExpr(
      cdp,
      `(() => {
        const list = document.querySelector('.mx-strip[data-track="label:drums"] .mx-add-list');
        return { hidden: list.hidden, names: [...list.querySelectorAll('.mx-add-item > span:first-child')].map((el) => el.textContent) };
      })()`,
    );
    await clickElement(cdp, '.mx-strip[data-track="label:drums"] .mx-add-item[data-effect="hpf"]');
    const withHighpass = await waitForCode(`code.includes('.lpf(1200).hpf(300)')`);
    const chainAfter = await waitFor(
      cdp,
      `(() => { const names = [...document.querySelectorAll('.mx-strip[data-track="label:drums"] .mx-chip .mx-chip-name')].map((el) => el.textContent); return names.length === 3 ? names : null; })()`,
      3000,
    );
    const chipsAfterAdd = await chipValues();
    const listAfterPick = await evaluateExpr(cdp, `document.querySelector('.mx-strip[data-track="label:drums"] .mx-add-list').hidden`);
    const addRows = await mixerHistoryRows(1, (rows) => rows[0] && rows[0].includes('mixer: drums added highpass'));
    report(
      'Add effect lists only missing effects and adds the chip in chain order',
      JSON.stringify(chainBefore) === JSON.stringify(['Lowpass', 'Crush']) &&
        addListNames.hidden === false &&
        JSON.stringify(addListNames.names) ===
          JSON.stringify(['Highpass', 'Bandpass', 'Vowel', 'Coarse', 'Distort', 'Tremolo', 'Compressor', 'Pan', 'Phaser']) &&
        withHighpass !== null &&
        JSON.stringify(chainAfter) === JSON.stringify(['Lowpass', 'Highpass', 'Crush']) &&
        chipsAfterAdd.find((chip) => chip.effect === 'hpf')?.selected === 'true' &&
        chipsAfterAdd.find((chip) => chip.effect === 'hpf')?.value === '300 Hz' &&
        listAfterPick === true &&
        addRows.length === 1 &&
        addRows[0].includes(' — page — "mixer: drums added highpass" — '),
      JSON.stringify({ chainBefore, addListNames, withHighpass, chainAfter, chipsAfterAdd, listAfterPick, addRows }),
    );
    await pressKey(cdp, 'Escape');

    // Bypass takes the effect out of the code and keeps its values in the page; turning it back on restores them.
    const LOWPASS_DOT = '.mx-strip[data-track="label:drums"] .mx-chip[data-effect="lpf"] .mx-chip-dot';
    const storedBypass = () =>
      evaluateExpr(cdp, `JSON.parse(window.localStorage.getItem('moontide.mixerBypass') ?? '[]')`);
    await callTool(client, 'set_code', { code: 'drums: s("bd*4").gain(0).lpf(800).lpq(4)', label: 'probe mixer bypass' });
    await blurActive();
    await pressKey(cdp, '3');
    await waitFor(cdp, `document.querySelector('${LOWPASS_DOT}') ? true : null`, 5000);
    const chipBeforeBypass = (await chipValues()).find((chip) => chip.effect === 'lpf');
    await clickElement(cdp, LOWPASS_DOT);
    const bypassedCode = await waitForCode(`!code.includes('lpf') && !code.includes('lpq')`);
    const chipOff = await waitFor(
      cdp,
      `(() => { const chip = document.querySelector('.mx-strip[data-track="label:drums"] .mx-chip[data-effect="lpf"]'); return chip && chip.dataset.bypassed === 'true' ? true : null; })()`,
      3000,
    );
    const chipsWhileOff = await chipValues();
    const offListHasLowpass = await evaluateExpr(cdp, `document.querySelector('.mx-strip[data-track="label:drums"] .mx-add-item[data-effect="lpf"]') !== null`);
    const recordsWhileOff = await storedBypass();
    await clickElement(cdp, LOWPASS_DOT);
    const restoredCode = await waitForCode(`code.includes('.lpf(800).lpq(4)')`);
    const chipsOn = await waitFor(
      cdp,
      `(() => { const chip = document.querySelector('.mx-strip[data-track="label:drums"] .mx-chip[data-effect="lpf"]'); return chip && chip.dataset.bypassed === undefined ? true : null; })()`,
      3000,
    );
    const recordsAfterOn = await storedBypass();
    const bypassRows = await mixerHistoryRows(2, (rows) => rows[0] && rows[0].includes('mixer: drums lowpass back on'));
    const lowpassOff = chipsWhileOff.find((chip) => chip.effect === 'lpf');
    report(
      'bypass removes the effect from the code and turning it back on restores it exactly',
      chipBeforeBypass?.value === '800 Hz +1' &&
        chipBeforeBypass.dotPressed === 'true' &&
        bypassedCode !== null &&
        chipOff === true &&
        lowpassOff?.value === 'off' &&
        lowpassOff.dotPressed === 'false' &&
        offListHasLowpass === false &&
        recordsWhileOff.length === 1 &&
        recordsWhileOff[0].identity === 'label:drums' &&
        recordsWhileOff[0].effect === 'lpf' &&
        JSON.stringify(recordsWhileOff[0].calls) === JSON.stringify([{ method: 'lpf', value: 800 }, { method: 'lpq', value: 4 }]) &&
        restoredCode === 'drums: s("bd*4").gain(0).lpf(800).lpq(4)' &&
        chipsOn === true &&
        recordsAfterOn.length === 0 &&
        bypassRows.length === 2 &&
        bypassRows[0].includes('"mixer: drums lowpass back on"') &&
        bypassRows[1].includes('"mixer: drums bypassed lowpass"'),
      JSON.stringify({ chipBeforeBypass, bypassedCode, chipsWhileOff, offListHasLowpass, recordsWhileOff, restoredCode, recordsAfterOn, bypassRows }),
    );

    // An effect whose value moves in the code cannot be bypassed, and the dot says why.
    await callTool(client, 'set_code', { code: 'drums: s("bd*4").gain(0).lpf(sine.range(400, 2000))', label: 'probe mixer moving' });
    const movingChip = await waitFor(
      cdp,
      `(() => { const chip = document.querySelector('.mx-strip[data-track="label:drums"] .mx-chip[data-effect="lpf"]'); return chip && chip.querySelector('.mx-chip-value').textContent === 'moving' ? { value: chip.querySelector('.mx-chip-value').textContent, disabled: chip.querySelector('.mx-chip-dot').disabled, title: chip.querySelector('.mx-chip-dot').title } : null; })()`,
      5000,
    );
    report(
      'bypass is off for an effect that moves in the code, and says why',
      movingChip !== null &&
        movingChip.disabled === true &&
        movingChip.title === 'Bypass needs fixed values; use a fixed value first, or Remove.',
      JSON.stringify({ movingChip }),
    );
    await pressKey(cdp, 'Escape');

    // --- Mixer ---

    const DRUMS = '.mx-strip[data-track="label:drums"]';
    const inspectorState = () =>
      evaluateExpr(
        cdp,
        `(() => {
          const el = document.getElementById('mixer-inspector');
          return {
            hidden: el.hidden,
            title: el.querySelector('.mx-insp-title') ? el.querySelector('.mx-insp-title').textContent : null,
            written: el.querySelector('.mx-written-code') ? el.querySelector('.mx-written-code').textContent : null,
          };
        })()`,
      );
    const openDrums = async (code, label) => {
      await callTool(client, 'set_code', { code, label });
      await blurActive();
      const view = await evaluateExpr(cdp, `document.getElementById('workspace').dataset.view`);
      if (view !== 'mixer') await pressKey(cdp, '3');
      await waitFor(cdp, `document.querySelectorAll('#mixer-strips .mx-strip').length === 1 ? true : null`, 5000);
      // The new code plays and the Mixer is writable again (its controls stay off until then).
      await waitFor(
        cdp,
        `${activeCodeExpr} === ${JSON.stringify(code)} && document.getElementById('mixer-notice').hidden ? true : null`,
        5000,
      );
    };

    // The tracer: click the Lowpass chip, drag Cutoff, get one version; then Remove.
    await pressKey(cdp, 'a');
    await openDrums('drums: s("bd*4").gain(0).lpf(1200)', 'probe mixer inspector');
    await waitFor(cdp, `document.querySelector('${DRUMS} .mx-chip[data-effect="lpf"] .mx-chip-body') ? true : null`, 5000);
    await clickElement(cdp, `${DRUMS} .mx-chip[data-effect="lpf"] .mx-chip-body`);
    const opened = await waitFor(cdp, `document.getElementById('mixer-inspector').hidden ? null : true`, 3000);
    const inspectorOpen = await inspectorState();
    const beforeCutoff = await newestVersionId();
    await dragSlider(cdp, '#mixer-inspector .mx-param-slider[data-param="cutoff"]', 0.5, 0.3, 8);
    const cutoffLive = await waitFor(
      cdp,
      `(() => { const m = /\\.lpf\\(([0-9.]+)\\)/.exec(${activeCodeExpr}); return m && Number(m[1]) !== 1200 ? Number(m[1]) : null; })()`,
      600,
    );
    const idRightAfterCutoff = (await newestVersionId()).id;
    await sleep(3000);
    const afterCutoff = await newestVersionId();
    const cutoffCode = await evaluateExpr(cdp, activeCodeExpr);
    const cutoffCodeValue = /\.lpf\(([0-9.]+)\)/.exec(cutoffCode);
    report(
      'a chip opens its parameters beside the strips and a cutoff drag records one version',
      opened === true &&
        inspectorOpen.hidden === false &&
        inspectorOpen.title === 'Lowpass · drums' &&
        inspectorOpen.written === '.lpf(1200)' &&
        cutoffLive !== null &&
        cutoffLive < 1200 &&
        idRightAfterCutoff === beforeCutoff.id &&
        afterCutoff.id === beforeCutoff.id + 1 &&
        cutoffCodeValue !== null &&
        afterCutoff.line.includes(` — page — "mixer: drums lowpass cutoff ${cutoffCodeValue[1]}" — `),
      JSON.stringify({ opened, inspectorOpen, beforeCutoff, cutoffLive, idRightAfterCutoff, afterCutoff, cutoffCode }),
    );

    await clickElement(cdp, '#mixer-inspector .mx-remove');
    const removedCode = await waitForCode(`!code.includes('lpf')`);
    const inspectorAfterRemove = await inspectorState();
    const removeRows = await mixerHistoryRows(1, (rows) => rows[0] && rows[0].includes('mixer: drums removed lowpass'));
    report(
      'Remove deletes the effect and its parameters',
      removedCode === 'drums: s("bd*4").gain(0)' &&
        inspectorAfterRemove.hidden === true &&
        removeRows.length === 1 &&
        removeRows[0].includes(' — page — "mixer: drums removed lowpass" — '),
      JSON.stringify({ removedCode, inspectorAfterRemove, removeRows }),
    );
    await pressKey(cdp, 'Escape');

    // More, Default and the compressor fields write only what was touched.
    const typeInto = async (selector, text) => {
      await evaluateExpr(cdp, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.focus(); el.select(); })()`);
      for (const key of text) await pressKey(cdp, key);
      await pressKey(cdp, 'Enter');
    };
    const moreState = () =>
      evaluateExpr(
        cdp,
        `(() => {
          const toggle = document.querySelector('#mixer-inspector .mx-more-toggle');
          const more = document.querySelector('#mixer-inspector .mx-more');
          return toggle ? { text: toggle.textContent, expanded: toggle.getAttribute('aria-expanded'), hidden: more.hidden } : null;
        })()`,
      );
    await openDrums('drums: s("bd*4").gain(0).lpf(1200)', 'probe mixer more');
    await waitFor(cdp, `document.querySelector('${DRUMS} .mx-chip[data-effect="lpf"] .mx-chip-body') ? true : null`, 5000);
    await clickElement(cdp, `${DRUMS} .mx-chip[data-effect="lpf"] .mx-chip-body`);
    await waitFor(cdp, `document.getElementById('mixer-inspector').hidden ? null : true`, 3000);
    const moreClosed = await moreState();
    const resonanceUntouched = await evaluateExpr(
      cdp,
      `(() => { const row = document.querySelector('#mixer-inspector .mx-row[data-param="resonance"]'); return { defaultLine: row.querySelector('.mx-row-sub').textContent, value: row.querySelector('.mx-param-number').value, muted: row.dataset.default }; })()`,
    );
    const codeAfterOpen = await evaluateExpr(cdp, activeCodeExpr);
    await clickElement(cdp, '#mixer-inspector .mx-more-toggle');
    const moreOpened = await moreState();
    await typeInto('#mixer-inspector .mx-param-number[data-param="resonance"]', '4');
    const withResonance = await waitForCode(`code.includes('.lpf(1200).lpq(4)')`);
    const resonanceRow = await evaluateExpr(
      cdp,
      `(() => { const row = document.querySelector('#mixer-inspector .mx-row[data-param="resonance"]'); return { hasDefaultButton: row.querySelector('.mx-default') !== null, muted: row.dataset.default }; })()`,
    );
    await clickElement(cdp, '#mixer-inspector .mx-default[data-param="resonance"]');
    const withoutResonance = await waitForCode(`!code.includes('lpq')`);
    await clickElement(cdp, '#mixer-inspector .mx-insp-close');
    await clickElement(cdp, `${DRUMS} .mx-add`);
    await clickElement(cdp, `${DRUMS} .mx-add-item[data-effect="compressor"]`);
    const withCompressor = await waitForCode(`code.includes('.compressor("-20:4")')`);
    await waitFor(cdp, `document.querySelector('#mixer-inspector .mx-row[data-param="knee"]') ? true : null`, 3000);
    const compressorMoreClosed = await moreState();
    await clickElement(cdp, '#mixer-inspector .mx-more-toggle');
    await typeInto('#mixer-inspector .mx-param-number[data-param="knee"]', '6');
    const withKnee = await waitForCode(`code.includes('.compressor("-20:4:6")')`);
    const compressorRows = await evaluateExpr(
      cdp,
      `[...document.querySelectorAll('#mixer-inspector .mx-row')].map((row) => row.dataset.param)`,
    );
    report(
      'parameters the user never touched stay out of the code, and More, Default and the compressor fields write only what was touched',
      moreClosed?.text === 'More parameters (1)' &&
        moreClosed.expanded === 'false' &&
        moreClosed.hidden === true &&
        resonanceUntouched.defaultLine === 'default' &&
        resonanceUntouched.value === '1' &&
        resonanceUntouched.muted === 'true' &&
        codeAfterOpen === 'drums: s("bd*4").gain(0).lpf(1200)' &&
        moreOpened?.text === 'Fewer parameters' &&
        moreOpened.expanded === 'true' &&
        moreOpened.hidden === false &&
        withResonance === 'drums: s("bd*4").gain(0).lpf(1200).lpq(4)' &&
        resonanceRow.hasDefaultButton === true &&
        resonanceRow.muted === 'false' &&
        withoutResonance === 'drums: s("bd*4").gain(0).lpf(1200)' &&
        withCompressor === 'drums: s("bd*4").gain(0).lpf(1200).compressor("-20:4")' &&
        compressorMoreClosed?.text === 'More parameters (3)' &&
        compressorMoreClosed.hidden === true &&
        withKnee === 'drums: s("bd*4").gain(0).lpf(1200).compressor("-20:4:6")' &&
        JSON.stringify(compressorRows) === JSON.stringify(['threshold', 'ratio', 'knee', 'attack', 'release']),
      JSON.stringify({ moreClosed, resonanceUntouched, codeAfterOpen, moreOpened, withResonance, resonanceRow, withoutResonance, withCompressor, compressorMoreClosed, withKnee, compressorRows }),
    );

    // A parameter Claude wrote as a pattern says so, and Use a fixed value replaces it.
    await openDrums('drums: s("bd*4").gain(0).lpf(1200).lpq(sine.range(1, 8))', 'probe mixer moving');
    await waitFor(cdp, `document.querySelector('${DRUMS} .mx-chip[data-effect="lpf"] .mx-chip-body') ? true : null`, 5000);
    await clickElement(cdp, `${DRUMS} .mx-chip[data-effect="lpf"] .mx-chip-body`);
    await waitFor(cdp, `document.getElementById('mixer-inspector').hidden ? null : true`, 3000);
    await clickElement(cdp, '#mixer-inspector .mx-more-toggle');
    const movingRow = await waitFor(
      cdp,
      `(() => {
        const row = document.querySelector('#mixer-inspector .mx-row[data-param="resonance"]');
        const text = row && row.querySelector('.mx-moving-text');
        return text ? { text: text.textContent, button: row.querySelector('.mx-use-fixed').textContent, sliders: row.querySelectorAll('.mx-param-slider, .mx-param-number').length } : null;
      })()`,
      3000,
    );
    await clickElement(cdp, '#mixer-inspector .mx-use-fixed[data-param="resonance"]');
    const fixedCode = await waitForCode(`code === 'drums: s("bd*4").gain(0).lpf(1200).lpq(1)'`);
    const fixedRows = await mixerHistoryRows(1, (rows) => rows[0] && rows[0].includes('mixer: drums lowpass resonance 1'));
    report(
      'a parameter Claude wrote as a pattern shows Moving (from code) and Use a fixed value replaces it',
      movingRow !== null &&
        movingRow.text === 'Moving (from code)' &&
        movingRow.button === 'Use a fixed value' &&
        movingRow.sliders === 0 &&
        fixedCode !== null &&
        fixedRows.length === 1 &&
        fixedRows[0].includes(' — page — "mixer: drums lowpass resonance 1" — '),
      JSON.stringify({ movingRow, fixedCode, fixedRows }),
    );
    await pressKey(cdp, 'Escape');

    // The keyboard stays safe in text fields, and Esc closes only the inspector.
    const openLowpass = async () => {
      await openDrums('drums: s("bd*4").gain(0).lpf(1200)', 'probe mixer keyboard');
      await waitFor(cdp, `document.querySelector('${DRUMS} .mx-chip[data-effect="lpf"] .mx-chip-body') ? true : null`, 5000);
      // A chip click toggles its inspector, and the selection outlives the view: click only when it is closed.
      const alreadyOpen = await evaluateExpr(cdp, `!document.getElementById('mixer-inspector').hidden`);
      if (!alreadyOpen) await clickElement(cdp, `${DRUMS} .mx-chip[data-effect="lpf"] .mx-chip-body`);
      await waitFor(cdp, `document.getElementById('mixer-inspector').hidden ? null : true`, 3000);
      // The fields stay off for a moment while the page settles on the new code; focus needs them on.
      await waitFor(cdp, `(() => { const el = document.querySelector('#mixer-inspector .mx-param-number[data-param="cutoff"]'); return el && !el.disabled ? true : null; })()`, 3000);
    };
    const workspaceState = () =>
      evaluateExpr(cdp, `(() => { const w = document.getElementById('workspace'); return { layout: w.dataset.layout, view: w.dataset.view }; })()`);
    await pressKey(cdp, 'a');
    await openLowpass();
    const beforeKeys = await workspaceState();
    const versionBeforeKeys = await newestVersionId();
    // Click into the field like a user would, and make sure it holds focus before any key goes out.
    await clickElement(cdp, '#mixer-inspector .mx-param-number[data-param="cutoff"]');
    const focusHeld = await waitFor(cdp, `document.activeElement && document.activeElement.dataset.param === 'cutoff' && document.activeElement.classList.contains('mx-param-number') ? true : null`, 2000);
    await pressKey(cdp, 'a');
    await pressKey(cdp, '3');
    await pressKey(cdp, 'b');
    await pressKey(cdp, 'c');
    const afterKeys = await workspaceState();
    const typedValue = await evaluateExpr(cdp, `document.querySelector('#mixer-inspector .mx-param-number[data-param="cutoff"]').value`);
    await pressKey(cdp, 'Escape');
    const afterEsc = await workspaceState();
    const inspectorAfterEsc = await inspectorState();
    const focusAfterEsc = await evaluateExpr(cdp, `document.activeElement ? document.activeElement.className : null`);
    await sleep(400);
    const codeAfterEsc = await evaluateExpr(cdp, activeCodeExpr);
    const versionAfterEsc = await newestVersionId();
    report(
      'a number field takes a and 3 without switching layout or view, and Esc closes only the inspector',
      focusHeld === true &&
        beforeKeys.view === 'mixer' &&
        JSON.stringify(afterKeys) === JSON.stringify(beforeKeys) &&
        /^\d{5}$/.test(typedValue) &&
        typedValue.includes('3') &&
        afterEsc.view === 'mixer' &&
        afterEsc.layout === beforeKeys.layout &&
        inspectorAfterEsc.hidden === true &&
        focusAfterEsc === 'mx-chip-body' &&
        codeAfterEsc === 'drums: s("bd*4").gain(0).lpf(1200)' &&
        versionAfterEsc.id === versionBeforeKeys.id,
      JSON.stringify({ focusHeld, beforeKeys, afterKeys, typedValue, afterEsc, inspectorAfterEsc, focusAfterEsc, codeAfterEsc, versionBeforeKeys, versionAfterEsc }),
    );
    await pressKey(cdp, 'Escape');
    const afterSecondEsc = await workspaceState();

    // The pane sits beside the strips (a, c) or under them (b) and never covers the code.
    await openLowpass();
    const rectsIn = async () =>
      evaluateExpr(
        cdp,
        `new Promise((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => {
            const box = (id) => { const r = document.getElementById(id).getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
            resolve({ layout: document.getElementById('workspace').dataset.layout, rem: parseFloat(getComputedStyle(document.documentElement).fontSize), strips: box('mixer-strips'), inspector: box('mixer-inspector'), editor: box('editor-area'), panel: box('mixer-view') });
          }));
        })`,
      );
    const meets = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    const layoutRects = [];
    for (const key of ['a', 'b', 'c']) {
      await pressKey(cdp, key);
      layoutRects.push(await rectsIn());
    }
    await pressKey(cdp, 'a');
    const [rectA, rectB, rectC] = layoutRects;
    report(
      'the inspector sits beside the strips in layouts a and c and under them in b, never over the code',
      layoutRects.map((rect) => rect.layout).join('') === 'abc' &&
        rectA.inspector.left >= rectA.strips.right - 0.5 &&
        rectC.inspector.left >= rectC.strips.right - 0.5 &&
        rectB.inspector.top >= rectB.strips.bottom - 0.5 &&
        rectB.inspector.height <= rectB.panel.height * 0.5 + 1 &&
        !meets(rectA.inspector, rectA.editor) &&
        !meets(rectB.inspector, rectB.editor) &&
        Math.abs(rectA.inspector.width - 22 * rectA.rem) < 2,
      JSON.stringify({ layoutRects }),
    );

    // The effect leaves the code: the pane says so and offers Close.
    await callTool(client, 'set_code', { code: 'drums: s("bd*4").gain(0)', label: 'probe mixer gone' });
    const goneState = await waitFor(
      cdp,
      `(() => {
        const el = document.getElementById('mixer-inspector');
        const gone = el.querySelector('.mx-insp-gone');
        const close = el.querySelector('.mx-insp-close');
        return !el.hidden && gone && !gone.hidden ? { text: gone.textContent, close: close.textContent, rows: el.querySelectorAll('.mx-row').length, written: el.querySelector('.mx-written').hidden, remove: el.querySelector('.mx-insp-footer').hidden } : null;
      })()`,
      5000,
    );
    await clickElement(cdp, '#mixer-inspector .mx-insp-close');
    const goneClosed = await inspectorState();
    report(
      'the inspector says when its effect is no longer in the code',
      goneState !== null &&
        goneState.text === 'This effect is no longer in the code.' &&
        goneState.close === 'Close' &&
        goneState.rows === 0 &&
        goneState.written === true &&
        goneState.remove === true &&
        goneClosed.hidden === true &&
        afterSecondEsc.view === 'none',
      JSON.stringify({ goneState, goneClosed, afterSecondEsc }),
    );
    await pressKey(cdp, 'Escape');

    // --- Mixer ---

    // A filter move: Moves, From, To, Over and Shape write sine.range(from, to).slow(N); the Timeline draws it.
    const openLowpassInspector = async (code, label) => {
      await openDrums(code, label);
      await waitFor(cdp, `document.querySelector('${DRUMS} .mx-chip[data-effect="lpf"] .mx-chip-body') ? true : null`, 5000);
      // A chip click toggles its inspector, and the selection outlives the view: click only when it is closed.
      const alreadyOpen = await evaluateExpr(cdp, `!document.getElementById('mixer-inspector').hidden`);
      if (!alreadyOpen) await clickElement(cdp, `${DRUMS} .mx-chip[data-effect="lpf"] .mx-chip-body`);
      await waitFor(cdp, `document.getElementById('mixer-inspector').hidden ? null : true`, 3000);
      await waitFor(cdp, `(() => { const el = document.querySelector('#mixer-inspector .mx-move-mode'); return el && !el.disabled ? true : null; })()`, 3000);
    };
    await pressKey(cdp, 'a');
    await openLowpassInspector('drums: s("bd*4").gain(0).lpf(1000)', 'probe mixer move');
    await clickElement(cdp, '#mixer-inspector .mx-move-mode[data-mode="moves"]');
    const movesCode = await waitForCode(`code.includes('.lpf(sine.range(500, 2000).slow(8))')`);
    const movesFields = await waitFor(
      cdp,
      `(() => {
        const field = (name) => document.querySelector('#mixer-inspector .mx-param-number[data-field="' + name + '"]');
        const from = field('from');
        const shape = document.querySelector('#mixer-inspector .mx-param-select[data-field="shape"]');
        if (!from || from.disabled || !shape) return null;
        return {
          from: from.value, to: field('to').value, over: field('over').value, shape: shape.value,
          shapes: [...shape.options].map((option) => option.value),
          pressed: [...document.querySelectorAll('#mixer-inspector .mx-move-mode')].map((button) => button.dataset.mode + ':' + button.getAttribute('aria-pressed')),
          group: document.querySelector('#mixer-inspector .mx-move-switch').getAttribute('aria-label'),
        };
      })()`,
      3000,
    );
    await typeInto('#mixer-inspector .mx-param-number[data-field="from"]', '400');
    const fromCode = await waitForCode(`code.includes('.lpf(sine.range(400, 2000).slow(8))')`);
    await typeInto('#mixer-inspector .mx-param-number[data-field="over"]', '16');
    const overCode = await waitForCode(`code.includes('.lpf(sine.range(400, 2000).slow(16))')`);
    const moveRows = await mixerHistoryRows(1, (rows) => rows[0] && rows[0].includes('mixer: drums lowpass moves 400 to 2000 over 16 cycles'));
    const moveChip = (await chipValues()).find((chip) => chip.effect === 'lpf');
    await blurActive();
    await pressKey(cdp, '2');
    await waitFor(cdp, `(() => { const s = document.getElementById('timeline-view').dataset.state; return s === 'ok' ? s : null; })()`, 5000);
    const moveCurve = await waitFor(
      cdp,
      `(() => {
        const lane = document.querySelector('#timeline-lanes .lane');
        const curves = lane ? [...lane.querySelectorAll('polyline.lane-curve')] : [];
        return curves.length === 1 ? curves[0].getAttribute('points').trim().split(/\\s+/).length : null;
      })()`,
      5000,
    );
    await pressKey(cdp, '2');
    report(
      'a filter move writes sine.range(from, to).slow(N) and the Timeline draws its curve',
      movesCode !== null &&
        movesFields !== null &&
        movesFields.from === '500' &&
        movesFields.to === '2000' &&
        movesFields.over === '8' &&
        movesFields.shape === 'sine' &&
        JSON.stringify(movesFields.shapes) === JSON.stringify(['sine', 'tri', 'saw']) &&
        JSON.stringify(movesFields.pressed) === JSON.stringify(['fixed:false', 'moves:true']) &&
        movesFields.group === 'Lowpass cutoff' &&
        fromCode !== null &&
        overCode === 'drums: s("bd*4").gain(0).lpf(sine.range(400, 2000).slow(16))' &&
        moveRows.length === 1 &&
        moveRows[0].includes(' — page — "mixer: drums lowpass moves 400 to 2000 over 16 cycles" — ') &&
        moveChip?.value === '400\u20132000 Hz' &&
        moveCurve !== null &&
        moveCurve > 4,
      JSON.stringify({ movesCode, movesFields, fromCode, overCode, moveRows, moveChip, moveCurve }),
    );

    // A move Claude wrote opens in Moves; any other pattern stays Moving (from code).
    const HATS = '.mx-strip[data-track="label:hats"]';
    const TWO_FILTERS_PROGRAM = 'drums: s("bd*4").gain(0).lpf(tri.range(300, 3000).slow(4))\nhats: s("hh*8").gain(0).lpf(perlin.range(300, 3000))';
    await callTool(client, 'set_code', { code: TWO_FILTERS_PROGRAM, label: 'probe mixer move read' });
    await blurActive();
    if ((await evaluateExpr(cdp, `document.getElementById('workspace').dataset.view`)) !== 'mixer') await pressKey(cdp, '3');
    await waitFor(
      cdp,
      `document.querySelectorAll('#mixer-strips .mx-strip').length === 2 && ${activeCodeExpr} === ${JSON.stringify(TWO_FILTERS_PROGRAM)} && document.getElementById('mixer-notice').hidden ? true : null`,
      5000,
    );
    const openLowpassOf = async (strip, title) => {
      await waitFor(cdp, `document.querySelector('${strip} .mx-chip[data-effect="lpf"] .mx-chip-body') ? true : null`, 5000);
      const openTitle = await inspectorState();
      const showing = !openTitle.hidden && openTitle.title === title;
      if (!showing) await clickElement(cdp, `${strip} .mx-chip[data-effect="lpf"] .mx-chip-body`);
      await waitFor(cdp, `(() => { const el = document.getElementById('mixer-inspector'); return !el.hidden && el.querySelector('.mx-insp-title').textContent === ${JSON.stringify(title)} ? true : null; })()`, 3000);
    };
    const cutoffEditor = () =>
      evaluateExpr(
        cdp,
        `(() => {
          const el = document.getElementById('mixer-inspector');
          const value = (field) => { const input = el.querySelector('.mx-param-number[data-field="' + field + '"]'); return input ? input.value : null; };
          const shape = el.querySelector('.mx-param-select[data-field="shape"]');
          const moving = el.querySelector('.mx-moving-text');
          const useFixed = el.querySelector('.mx-use-fixed');
          return {
            pressed: [...el.querySelectorAll('.mx-move-mode')].map((button) => button.dataset.mode + ':' + button.getAttribute('aria-pressed')),
            from: value('from'), to: value('to'), over: value('over'), shape: shape ? shape.value : null,
            moving: moving ? moving.textContent : null, useFixed: useFixed ? useFixed.textContent : null,
            switches: el.querySelectorAll('.mx-move-switch').length,
          };
        })()`,
      );
    await openLowpassOf(DRUMS, 'Lowpass \u00b7 drums');
    await waitFor(cdp, `document.querySelector('#mixer-inspector .mx-param-select[data-field="shape"]') ? true : null`, 3000);
    const drumsEditor = await cutoffEditor();
    await openLowpassOf(HATS, 'Lowpass \u00b7 hats');
    const hatsEditor = await cutoffEditor();
    report(
      'a move Claude wrote opens in Moves, and any other pattern stays Moving (from code)',
      JSON.stringify(drumsEditor.pressed) === JSON.stringify(['fixed:false', 'moves:true']) &&
        drumsEditor.from === '300' &&
        drumsEditor.to === '3000' &&
        drumsEditor.over === '4' &&
        drumsEditor.shape === 'tri' &&
        hatsEditor.moving === 'Moving (from code)' &&
        hatsEditor.useFixed === 'Use a fixed value' &&
        hatsEditor.switches === 0 &&
        hatsEditor.from === null,
      JSON.stringify({ drumsEditor, hatsEditor }),
    );

    // Fixed brings back the midpoint of From and To, as one version.
    await openLowpassOf(DRUMS, 'Lowpass \u00b7 drums');
    await waitFor(cdp, `(() => { const el = document.querySelector('#mixer-inspector .mx-move-mode'); return el && !el.disabled ? true : null; })()`, 3000);
    await clickElement(cdp, '#mixer-inspector .mx-move-mode[data-mode="fixed"]');
    const fixedBack = await waitForCode(`code.startsWith('drums: s("bd*4").gain(0).lpf(1650)\\n')`);
    const fixedBackRows = await mixerHistoryRows(1, (rows) => rows[0] && rows[0].includes('mixer: drums lowpass cutoff 1650'));
    const fixedEditor = await waitFor(
      cdp,
      `(() => { const el = document.querySelector('#mixer-inspector .mx-param-number[data-param="cutoff"]:not([data-field])'); return el && el.value === '1650' ? el.value : null; })()`,
      3000,
    );
    const fixedPressed = await cutoffEditor();
    report(
      'Fixed brings back the midpoint of From and To as one version',
      fixedBack !== null &&
        fixedBackRows.length === 1 &&
        fixedBackRows[0].includes(' — page — "mixer: drums lowpass cutoff 1650" — ') &&
        fixedEditor === '1650' &&
        JSON.stringify(fixedPressed.pressed) === JSON.stringify(['fixed:true', 'moves:false']),
      JSON.stringify({ fixedBack, fixedBackRows, fixedEditor, fixedPressed }),
    );
    await pressKey(cdp, 'Escape');

    // --- Mixer ---

    // A send drag writes .room(v) live and records one version; the Reverb bus strip names its sender.
    const TRACK_STRIPS = '#mixer-strips .mx-strip:not(.mx-bus)';
    const twoTracksReady = (program) =>
      waitFor(
        cdp,
        `document.querySelectorAll('${TRACK_STRIPS}').length === 2 && ${activeCodeExpr} === ${JSON.stringify(program)} && document.getElementById('mixer-notice').hidden ? true : null`,
        5000,
      );
    const showTwoTracks = async (program, label) => {
      await callTool(client, 'set_code', { code: program, label });
      await blurActive();
      if ((await evaluateExpr(cdp, `document.getElementById('workspace').dataset.view`)) !== 'mixer') await pressKey(cdp, '3');
      return twoTracksReady(program);
    };
    const busStrips = () =>
      evaluateExpr(
        cdp,
        `[...document.querySelectorAll('#mixer-strips .mx-strip.mx-bus')].map((el) => ({
          bus: el.dataset.bus,
          orbit: el.dataset.orbit,
          title: el.querySelector('.mx-name').textContent,
          fedBy: el.querySelector('.mx-fedby').textContent,
          warning: el.querySelector('.mx-warning').hidden ? null : el.querySelector('.mx-warning').textContent,
          chips: [...el.querySelectorAll('.mx-chip')].map((chip) => chip.querySelector('.mx-chip-name').textContent + '=' + chip.querySelector('.mx-chip-value').textContent),
        }))`,
      );
    const SEND_PROGRAM = 'drums: s("bd*4").gain(0)\nhats: s("hh*8").gain(0)';
    await showTwoTracks(SEND_PROGRAM, 'probe mixer send');
    const beforeSend = await newestVersionId();
    await dragSlider(cdp, `${DRUMS} .mx-send-slider[data-bus="reverb"]`, 0.05, 0.4, 8);
    const sendLive = await waitFor(
      cdp,
      `(() => { const m = /^drums:.*\\.room\\(([0-9.]+)\\)/m.exec(${activeCodeExpr}); return m && Number(m[1]) > 0 ? Number(m[1]) : null; })()`,
      600,
    );
    const idRightAfterSend = (await newestVersionId()).id;
    await sleep(3000);
    const afterSend = await newestVersionId();
    const sendCode = await evaluateExpr(cdp, activeCodeExpr);
    const sendValue = /\.room\(([0-9.]+)\)/.exec(sendCode);
    const sendBuses = await waitFor(cdp, `document.querySelector('#mixer-strips .mx-strip.mx-bus') ? true : null`, 3000).then(busStrips);
    const sendRowState = await evaluateExpr(
      cdp,
      `(() => {
        const rows = [...document.querySelectorAll('${DRUMS} .mx-send')].map((row) => ({
          bus: row.dataset.bus,
          label: row.querySelector('.mx-send-label').textContent,
          aria: row.querySelector('.mx-send-slider').getAttribute('aria-label'),
          value: row.querySelector('.mx-send-value').textContent,
        }));
        const strip = document.querySelector('${DRUMS}');
        const order = [...strip.children].map((el) => el.className);
        return { rows, order };
      })()`,
    );
    report(
      'a reverb send drag writes .room live and records one version; the Reverb bus strip names its sender',
      sendLive !== null &&
        idRightAfterSend === beforeSend.id &&
        afterSend.id === beforeSend.id + 1 &&
        sendValue !== null &&
        afterSend.line.includes(` — page — "mixer: drums reverb send ${sendValue[1]}" — `) &&
        sendBuses.length === 1 &&
        sendBuses[0].title === 'Reverb bus' &&
        sendBuses[0].fedBy === 'Fed by drums' &&
        sendRowState.rows.length === 2 &&
        sendRowState.rows[0].label === 'Reverb' &&
        sendRowState.rows[0].aria === 'drums reverb send' &&
        sendRowState.rows[1].label === 'Delay' &&
        sendRowState.rows[1].value === '0.00' &&
        sendRowState.order.findIndex((name) => name === 'mx-sends') > sendRowState.order.findIndex((name) => name === 'mx-chain') &&
        sendRowState.order.findIndex((name) => name === 'mx-sends') < sendRowState.order.findIndex((name) => name === 'mx-fader-section'),
      JSON.stringify({ sendLive, beforeSend, idRightAfterSend, afterSend, sendCode, sendBuses, sendRowState }),
    );

    // A costly reverb slider changes nothing until release, then lands on every sending track.
    const REVERB_PROGRAM = 'drums: s("bd*4").gain(0).room(0.3)\nhats: s("hh*8").gain(0).room(0.2)';
    const openBusInspector = async (strip, bus, title) => {
      const shown = await inspectorState();
      if (shown.hidden || shown.title !== title) await clickElement(cdp, `${strip} .mx-send-label[data-bus="${bus}"]`);
      await waitFor(cdp, `(() => { const el = document.getElementById('mixer-inspector'); return !el.hidden && el.querySelector('.mx-insp-title').textContent === ${JSON.stringify(title)} ? true : null; })()`, 3000);
      await waitFor(cdp, `(() => { const el = document.querySelector('#mixer-inspector .mx-param-slider'); return el && !el.disabled ? true : null; })()`, 3000);
    };
    const lineOf = (name) => `(() => { const line = ${activeCodeExpr}.split('\\n').find((row) => row.startsWith(${JSON.stringify(name + ':')})); return line === undefined ? null : line; })()`;
    await showTwoTracks(REVERB_PROGRAM, 'probe mixer bus');
    await openBusInspector(DRUMS, 'reverb', 'Reverb bus');
    const busInspector = await evaluateExpr(
      cdp,
      `(() => {
        const el = document.getElementById('mixer-inspector');
        return {
          rows: [...el.querySelectorAll('.mx-row')].map((row) => row.dataset.param),
          note: el.querySelector('.mx-insp-note').textContent,
          noteHidden: el.querySelector('.mx-insp-note').hidden,
          remove: el.querySelector('.mx-remove') !== null,
          written: el.querySelector('.mx-written').hidden,
          moreToggle: el.querySelector('.mx-more-toggle') ? el.querySelector('.mx-more-toggle').textContent : null,
        };
      })()`,
    );
    const beforeSize = await newestVersionId();
    let sizeMidDrag = null;
    await dragSlider(cdp, '#mixer-inspector .mx-param-slider[data-bus="reverb"][data-param="size"]', 0.2, 0.5, 8, async () => {
      await sleep(400);
      sizeMidDrag = {
        code: await evaluateExpr(cdp, activeCodeExpr),
        number: await evaluateExpr(cdp, `document.querySelector('#mixer-inspector .mx-param-number[data-bus="reverb"][data-param="size"]').value`),
      };
    });
    const sizeLanded = await waitFor(
      cdp,
      `(() => {
        const code = ${activeCodeExpr};
        const d = /^drums:.*\\.room\\(0\\.3\\)\\.roomsize\\(([0-9.]+)\\)/m.exec(code);
        const h = /^hats:.*\\.room\\(0\\.2\\)\\.roomsize\\(([0-9.]+)\\)/m.exec(code);
        return d && h && d[1] === h[1] ? { drums: d[1], hats: h[1] } : null;
      })()`,
      3000,
    );
    const idRightAfterSize = (await newestVersionId()).id;
    await sleep(3000);
    const afterSize = await newestVersionId();
    report(
      'a costly reverb slider changes nothing until release, then lands on every sending track',
      busInspector.rows.join(',') === 'size,fade,lowpass,damping' &&
        busInspector.note === 'Size, fade, lowpass and damping recalculate the reverb, so they apply when you let go.' &&
        busInspector.noteHidden === false &&
        busInspector.remove === false &&
        busInspector.written === true &&
        sizeMidDrag !== null &&
        sizeMidDrag.code === REVERB_PROGRAM &&
        Number(sizeMidDrag.number) > 0.2 * 10 &&
        sizeLanded !== null &&
        idRightAfterSize === beforeSize.id &&
        afterSize.id === beforeSize.id + 1 &&
        afterSize.line.includes(` — page — "mixer: reverb size ${sizeLanded.drums}" — `),
      JSON.stringify({ busInspector, beforeSize, sizeMidDrag, sizeLanded, idRightAfterSize, afterSize }),
    );

    // A send at 0 leaves the code with its bus values, and a new sender takes them.
    const hatsSend = `${HATS} .mx-send-slider[data-bus="reverb"]`;
    await dragSlider(cdp, hatsSend, 0.2, 0, 6);
    const hatsOffCode = await waitForCode(`!code.split('\\n').find((row) => row.startsWith('hats:')).includes('room')`);
    const busAfterOff = await busStrips();
    const hatsOffValue = await evaluateExpr(cdp, `document.querySelector('${HATS} .mx-send-value').textContent`);
    await sleep(2000);
    await dragSlider(cdp, hatsSend, 0.02, 0.4, 8);
    const hatsOnCode = await waitFor(
      cdp,
      `(() => { const m = /^hats:.*\\.room\\(([0-9.]+)\\)\\.roomsize\\(([0-9.]+)\\)/m.exec(${activeCodeExpr}); return m && Number(m[1]) > 0 ? { send: m[1], size: m[2] } : null; })()`,
      3000,
    );
    const drumsLine = await evaluateExpr(cdp, lineOf('drums'));
    report(
      'a send set to 0 leaves the code with its bus values, and a new sender takes the bus values',
      hatsOffCode !== null &&
        hatsOffCode.includes('drums: s("bd*4").gain(0).room(0.3).roomsize(') &&
        busAfterOff.length === 1 &&
        busAfterOff[0].fedBy === 'Fed by drums' &&
        hatsOffValue === '0.00' &&
        hatsOnCode !== null &&
        sizeLanded !== null &&
        hatsOnCode.size === sizeLanded.drums &&
        drumsLine.includes(`.roomsize(${sizeLanded.drums})`),
      JSON.stringify({ hatsOffCode, busAfterOff, hatsOffValue, hatsOnCode, sizeLanded, drumsLine }),
    );
    await pressKey(cdp, 'Escape');

    // Two different reverb sizes show the warning, and the first change aligns them.
    const waitBusStrips = async (test) => {
      let last = [];
      for (let attempt = 0; attempt < 40; attempt += 1) {
        last = await busStrips();
        if (test(last)) break;
        await sleep(100);
      }
      return last;
    };
    const DISAGREE_PROGRAM = 'drums: s("bd*4").gain(0).room(0.3).roomsize(2)\nhats: s("hh*8").gain(0).room(0.2).roomsize(6)';
    await showTwoTracks(DISAGREE_PROGRAM, 'probe mixer disagree');
    const disagreeBuses = await waitBusStrips((buses) => buses.length === 1 && buses[0].warning !== null);
    await openBusInspector(DRUMS, 'reverb', 'Reverb bus');
    const mixedRow = await evaluateExpr(
      cdp,
      `(() => { const row = document.querySelector('#mixer-inspector .mx-row[data-param="size"]'); return { sub: row.querySelector('.mx-row-sub').textContent, value: row.querySelector('.mx-param-number').value }; })()`,
    );
    await typeInto('#mixer-inspector .mx-param-number[data-bus="reverb"][data-param="fade"]', '1');
    const alignedCode = await waitForCode(
      `code.split('\\n').every((row) => row.includes('.roomfade(1)')) && code.split('\\n').find((row) => row.startsWith('hats:')).includes('.roomsize(2)')`,
    );
    const alignedBuses = await waitBusStrips((buses) => buses.length === 1 && buses[0].warning === null);
    const alignedRows = await mixerHistoryRows(1, (rows) => rows[0] && rows[0].includes('mixer: reverb fade 1'));
    report(
      'two different reverb sizes show the warning and the first change aligns them',
      disagreeBuses.length === 1 &&
        disagreeBuses[0].warning === 'Tracks disagree on size. Changing any value here sets it on every sending track.' &&
        disagreeBuses[0].chips[0] === 'Size=mixed' &&
        mixedRow.sub === 'mixed' &&
        mixedRow.value === '' &&
        alignedCode === 'drums: s("bd*4").gain(0).room(0.3).roomsize(2).roomfade(1)\nhats: s("hh*8").gain(0).room(0.2).roomsize(2).roomfade(1)' &&
        alignedBuses.length === 1 &&
        alignedBuses[0].warning === null &&
        alignedBuses[0].chips[0] === 'Size=2' &&
        alignedBuses[0].chips[1] === 'Fade=1 s' &&
        alignedRows.length === 1 &&
        alignedRows[0].includes(' — page — "mixer: reverb fade 1" — '),
      JSON.stringify({ disagreeBuses, mixedRow, alignedCode, alignedBuses, alignedRows }),
    );

    // Each bus is judged by Strudel's own rule, and each orbit gets its own bus strips.
    await pressKey(cdp, 'Escape');
    await showTwoTracks('drums: s("bd*4").gain(0).delay(0.3).delayfeedback(0.5)\nhats: s("hh*8").gain(0).delay(0.2)', 'probe mixer delay agree');
    const delayAgree = await waitBusStrips((buses) => buses.length === 1 && buses[0].bus === 'delay');
    await showTwoTracks('drums: s("bd*4").gain(0).delay(0.3).delaytime(0.2)\nhats: s("hh*8").gain(0).delay(0.2)', 'probe mixer delay time');
    const delayTime = await waitBusStrips((buses) => buses.length === 1 && buses[0].bus === 'delay' && buses[0].warning !== null);
    await showTwoTracks('drums: s("bd*4").gain(0).room(0.3)\nhats: s("hh*8").gain(0).orbit(2).room(0.2)', 'probe mixer orbits');
    const orbitBuses = await waitBusStrips((buses) => buses.length === 2);
    const hatsOrbitSends = await evaluateExpr(cdp, `[...document.querySelectorAll('${HATS} .mx-send-slider')].map((el) => el.disabled)`);
    report(
      "bus warnings follow Strudel's rules per bus, and each orbit gets its own bus strips",
      delayAgree.length === 1 &&
        delayAgree[0].warning === null &&
        delayAgree[0].chips[1] === 'Feedback=0.5' &&
        delayTime.length === 1 &&
        delayTime[0].warning === 'Tracks disagree on time. Changing any value here sets it on every sending track.' &&
        orbitBuses.map((bus) => bus.title).join('|') === 'Reverb bus \u00b7 orbit 1|Reverb bus \u00b7 orbit 2' &&
        orbitBuses.map((bus) => bus.fedBy).join('|') === 'Fed by drums|Fed by hats' &&
        hatsOrbitSends.every((disabled) => disabled === false),
      JSON.stringify({ delayAgree, delayTime, orbitBuses, hatsOrbitSends }),
    );

    // --- Mixer layout polish ---
    {
      const POLISH_PROGRAM = [
        'drums: s("bd*4").gain(0).lpf(sine.range(300, 1800).slow(8)).room(0.2).delay(0.2)',
        'hats: s("hh*8").gain(0).lpf(1200).lpq(4).room(0.2).delay(0.2)',
        'bass: note("c2 g1").s("sawtooth").gain(0).lpf(sine.range(1000, 12000).slow(8)).room(0.2).delay(0.2)',
        'pad: note("c4 e4").s("triangle").gain(0).room(0.2).delay(0.2)',
      ].join('\n');
      const startLayout = await evaluateExpr(cdp, `document.getElementById('workspace').dataset.layout`);
      const insideOpen = [];
      try {
        await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 760, deviceScaleFactor: 1, mobile: false });
        await callTool(client, 'set_code', { code: POLISH_PROGRAM, label: 'probe mixer polish' });
        await blurActive();
        if ((await evaluateExpr(cdp, `document.getElementById('workspace').dataset.view`)) !== 'mixer') await pressKey(cdp, '3');
        await waitFor(
          cdp,
          `document.querySelectorAll('#mixer-strips .mx-strip:not(.mx-bus)').length === 4 && document.querySelectorAll('#mixer-strips .mx-strip.mx-bus').length === 2 && ${activeCodeExpr} === ${JSON.stringify(POLISH_PROGRAM)} && document.getElementById('mixer-notice').hidden ? true : null`,
          5000,
        );
        for (const layoutKey of ['c', 'a']) {
          await pressKey(cdp, layoutKey);
          await clickElement(cdp, '#mixer-strips .mx-bus[data-bus="delay"] .mx-chip-body');
          await waitFor(cdp, `document.getElementById('mixer-inspector').hidden ? null : true`, 3000);
          insideOpen.push(
            await evaluateExpr(
              cdp,
              `new Promise((resolve) => {
                requestAnimationFrame(() => requestAnimationFrame(() => {
                  const box = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; };
                  const strips = document.getElementById('mixer-strips');
                  const s = strips.getBoundingClientRect();
                  const visible = { left: s.left + strips.clientLeft, right: s.left + strips.clientLeft + strips.clientWidth, top: s.top + strips.clientTop, bottom: s.top + strips.clientTop + strips.clientHeight };
                  const insp = box(document.getElementById('mixer-inspector'));
                  const delay = document.querySelector('#mixer-strips .mx-bus[data-bus="delay"]');
                  const delayRect = box(delay);
                  let overlapPx = 0;
                  for (const el of strips.querySelectorAll('.mx-strip')) {
                    const r = box(el);
                    const cut = { left: Math.max(r.left, visible.left), right: Math.min(r.right, visible.right), top: Math.max(r.top, visible.top), bottom: Math.min(r.bottom, visible.bottom) };
                    if (cut.right <= cut.left || cut.bottom <= cut.top) continue;
                    if (cut.top < insp.bottom && insp.top < cut.bottom) overlapPx = Math.max(overlapPx, Math.min(cut.right, insp.right) - Math.max(cut.left, insp.left));
                  }
                  resolve({
                    layout: document.getElementById('workspace').dataset.layout,
                    rem: parseFloat(getComputedStyle(document.documentElement).fontSize),
                    overflowing: strips.scrollWidth > strips.clientWidth + 1,
                    scrollLeft: strips.scrollLeft,
                    visible,
                    inspector: insp,
                    delay: delayRect,
                    delaySelected: delay.dataset.selected,
                    overlapPx,
                    gap: insp.left - visible.right,
                    stripsRight: s.right,
                  });
                }));
              })`,
            ),
          );
          await clickElement(cdp, '#mixer-inspector .mx-insp-close');
          await waitFor(cdp, `document.getElementById('mixer-inspector').hidden ? true : null`, 3000);
        }
        report(
          'mixer polish: the inspector sits beside the strips in layouts c and a at 1280x760, the clicked last strip stays whole, no strip shows under the pane, and a 1rem gap separates them',
          insideOpen.length === 2 &&
            insideOpen.map((m) => m.layout).join('') === 'ca' &&
            insideOpen.every(
              (m) =>
                m.overflowing === true &&
                m.delaySelected === 'true' &&
                m.delay.left >= m.visible.left - 0.5 &&
                m.delay.right <= m.visible.right + 0.5 &&
                m.overlapPx <= 0.5 &&
                m.inspector.left - m.stripsRight >= m.rem - 0.5,
            ),
          JSON.stringify({ insideOpen }),
        );

        // With the pane closed: the fader cap, the strip fill and the whole chip values, in layouts c and a.
        const closedRuns = [];
        for (const layoutKey of ['c', 'a']) {
          await pressKey(cdp, layoutKey);
          closedRuns.push(
            await evaluateExpr(
              cdp,
              `new Promise((resolve) => {
                requestAnimationFrame(() => requestAnimationFrame(() => {
                  const box = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, height: r.height }; };
                  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
                  const drums = document.querySelector('.mx-strip[data-track="label:drums"]');
                  const fader = box(drums.querySelector('.mx-fader'));
                  const ms = box(drums.querySelector('.mx-ms'));
                  const paneFill = getComputedStyle(document.getElementById('mixer-inspector')).backgroundColor;
                  const fills = [...document.querySelectorAll('#mixer-strips .mx-strip')].map((el) => getComputedStyle(el).backgroundColor);
                  const chipRows = [...document.querySelectorAll('#mixer-strips .mx-chip')].map((chip) => {
                    const value = chip.querySelector('.mx-chip-value');
                    const body = box(chip.querySelector('.mx-chip-body'));
                    const v = box(value);
                    return {
                      text: value.textContent,
                      valueWidth: value.clientWidth,
                      valueScroll: value.scrollWidth,
                      bodyWidth: body.right - body.left,
                      cut: value.scrollWidth > value.clientWidth + 1,
                      inside: v.left >= body.left - 0.5 && v.right <= body.right + 0.5 && v.top >= body.top - 0.5 && v.bottom <= body.bottom + 0.5,
                    };
                  });
                  const strips = [...document.querySelectorAll('#mixer-strips .mx-strip')].map((el) => {
                    const strip = box(el);
                    const trackFader = el.querySelector('.mx-fader');
                    const readout = el.querySelector('.mx-readout');
                    const trackMs = el.querySelector('.mx-ms');
                    return {
                      nameHeight: box(el.querySelector('.mx-name')).height,
                      readoutClear: trackFader === null || box(readout).top >= box(trackFader).bottom - 0.5,
                      msInside: trackMs === null || box(trackMs).bottom <= strip.bottom + 0.5,
                    };
                  });
                  const valueOf = (track) => [...document.querySelectorAll('.mx-strip[data-track="label:' + track + '"] .mx-chip')].map((chip) => chip.querySelector('.mx-chip-name').textContent + '=' + chip.querySelector('.mx-chip-value').textContent);
                  resolve({
                    layout: document.getElementById('workspace').dataset.layout,
                    rem,
                    faderHeight: fader.height,
                    readoutGap: ms.top - fader.bottom,
                    strips,
                    paneFill,
                    fills,
                    chipRows,
                    drumsChips: valueOf('drums'),
                    hatsChips: valueOf('hats'),
                    bassChips: valueOf('bass'),
                  });
                }));
              })`,
            ),
          );
        }
        const [runC, runA] = closedRuns;
        report(
          'mixer polish: the fader stops at 12rem with its readout and M and S right under it in layout c, and keeps its 6rem minimum in layout a',
          runC.layout === 'c' &&
            runA.layout === 'a' &&
            runC.faderHeight <= 12 * runC.rem + 1 &&
            runC.faderHeight >= 6 * runC.rem - 1 &&
            runC.readoutGap <= 4 * runC.rem &&
            runA.faderHeight >= 6 * runA.rem - 1,
          JSON.stringify({ c: { faderHeight: runC.faderHeight, readoutGap: runC.readoutGap, rem: runC.rem }, a: { faderHeight: runA.faderHeight, rem: runA.rem } }),
        );
        report(
          'mixer polish: a short strip grows instead of squashing its name, readout or M and S (layouts c and a)',
          closedRuns.every(
            (run) =>
              run.strips.length === 6 &&
              run.strips.every((strip) => strip.nameHeight >= run.rem - 1 && strip.readoutClear && strip.msInside),
          ),
          JSON.stringify(closedRuns.map((run) => ({ layout: run.layout, strips: run.strips }))),
        );
        report(
          'mixer polish: in layout c every strip has the opaque panel fill, so the faint code no longer shows under chips, Add effect and sends',
          runC.fills.length === 6 &&
            runC.fills.every((fill) => fill === runC.paneFill && fill !== 'rgba(0, 0, 0, 0)' && fill !== 'transparent'),
          JSON.stringify({ paneFill: runC.paneFill, fills: runC.fills }),
        );
        report(
          'mixer polish: chip values show in full at the 11rem strip width and never spill out of their chip',
          closedRuns.every(
            (run) =>
              run.drumsChips.includes('Lowpass=300–1800 Hz') === true &&
              run.hatsChips.includes('Lowpass=1200 Hz +1') === true &&
              run.bassChips.includes('Lowpass=1000\u201312000 Hz') === true &&
              run.chipRows.length > 0 &&
              run.chipRows.every((chip) => chip.cut === false && chip.inside === true),
          ),
          JSON.stringify({ closedRuns: closedRuns.map((run) => ({ layout: run.layout, drumsChips: run.drumsChips, hatsChips: run.hatsChips, bassChips: run.bassChips, spilled: run.chipRows.filter((chip) => chip.cut || !chip.inside), widths: run.chipRows.map((chip) => [chip.text, chip.valueWidth, chip.valueScroll, chip.bodyWidth]) })) }),
        );
      } finally {
        await cdp('Emulation.clearDeviceMetricsOverride');
        if (startLayout && (await evaluateExpr(cdp, `document.getElementById('workspace').dataset.layout`)) !== startLayout) await pressKey(cdp, startLayout);
      }
    }

    // --- Ask Claude ---
    const REQUEST_PREFIX = 'Request from the Moontide page: ';
    const statusText = (wanted) => `(() => { const el = document.getElementById('ask-status'); return !el.hidden && el.querySelector('.ask-long').textContent === ${JSON.stringify(wanted)} ? true : null; })()`;
    const askTypeAndSend = async (text) => {
      await cdp('Input.insertText', { text });
      await pressKey(cdp, 'Enter');
    };
    {
      const firstReply = await callTool(client, 'get_code', {});
      const listener = spawnListener(firstReply);
      const armedWithCommand = listener !== null;
      let silentOnConnect = false;
      let armingGone = false;
      if (listener !== null) {
        await sleep(500);
        silentOnConnect = listener.lines.length === 0;
        const secondReply = await callTool(client, 'get_code', {});
        armingGone = !secondReply.includes('Page requests: no listener');
      }
      const opened = await askAt(cdp, '#product-name');
      const focusInField = await evaluateExpr(cdp, "document.activeElement && document.activeElement.id === 'ask-field'");
      await askTypeAndSend('make the drums shorter');
      const started = Date.now();
      while (listener !== null && listener.lines.length === 0 && Date.now() - started < 3000) await sleep(100);
      const printed = listener === null ? undefined : listener.lines[0];
      let parsed = null;
      if (printed !== undefined && printed.startsWith(REQUEST_PREFIX)) {
        try {
          parsed = JSON.parse(printed.slice(REQUEST_PREFIX.length));
        } catch {
          parsed = null;
        }
      }
      const receivedShown = await waitFor(cdp, statusText('Claude received it'), 2000);
      const boxHiddenAfterSend = await evaluateExpr(cdp, "document.getElementById('ask-box').hidden");
      report(
        'a request typed in the page reaches the listener started from the arming line, as one line',
        armedWithCommand &&
          silentOnConnect &&
          armingGone &&
          opened.prevented === true &&
          opened.open === true &&
          opened.chip === 'Whole session' &&
          focusInField === true &&
          parsed !== null &&
          listener.lines.length === 1 &&
          parsed.text === 'make the drums shorter' &&
          parsed.context.kind === 'session' &&
          parsed.chip === 'Whole session' &&
          typeof parsed.current === 'number' &&
          boxHiddenAfterSend === true &&
          receivedShown === true,
        JSON.stringify({ armedWithCommand, silentOnConnect, armingGone, opened, focusInField, printed, receivedShown, boxHiddenAfterSend }),
      );

      // With no listener the request waits and arrives in the next tool reply.
      if (listener !== null) {
        listener.child.kill();
        await listener.exited;
        await sleep(300);
      }
      const reopened = await askAt(cdp, '#product-name');
      await askTypeAndSend('make the hats quieter');
      const waitingShown = await waitFor(cdp, statusText('Claude will see it on its next action'), 3000);
      const nextReply = await callTool(client, 'get_code', {});
      const replyLines = nextReply.split('\n');
      const requestLines = replyLines.filter((line) => line.startsWith(REQUEST_PREFIX));
      let waitingText = null;
      try {
        waitingText = requestLines.length === 1 ? JSON.parse(requestLines[0].slice(REQUEST_PREFIX.length)).text : null;
      } catch {
        waitingText = null;
      }
      const lastLine = replyLines[replyLines.length - 1] ?? '';
      const handedOver = await waitFor(cdp, statusText('Claude received it'), 2000);
      report(
        'with no listener the request waits and arrives in the next tool reply, and the arming line comes back',
        reopened.open === true &&
          waitingShown === true &&
          waitingText === 'make the hats quieter' &&
          lastLine.startsWith('Page requests: no listener is connected.') &&
          handedOver === true,
        JSON.stringify({ reopened, waitingShown, waitingText, lastLine: lastLine.slice(0, 60), handedOver }),
      );
    }

    // --- Ask Claude: refusals ---
    {
      const ERROR_RATE_LIMIT = 'Error: too many requests \u2014 wait a moment, then send again.';
      const ERROR_STALE_TOKEN = "Error: Moontide refused this page's token \u2014 reload the page.";
      const errorLineText = () =>
        evaluateExpr(cdp, "(() => { const el = document.getElementById('eval-error'); return el.hidden ? '' : el.textContent; })()");
      const waitForStderr = async (needle, timeoutMs) => {
        const deadline = Date.now() + timeoutMs;
        while (!getStderr().includes(needle) && Date.now() < deadline) await sleep(50);
        return getStderr().includes(needle);
      };
      const moontidePort = new URL(pageUrl).port;

      // A listener holding the wrong token.
      {
        const reply = await callTool(client, 'get_code', {});
        const command = /node '([^']+)' (\d+) ([0-9a-f]{64})/.exec(reply);
        let lines = [];
        let exitCode = null;
        if (command !== null) {
          const child = spawn(process.execPath, [command[1], command[2], '0'.repeat(64)], { stdio: ['ignore', 'pipe', 'pipe'] });
          spawnedListeners.push(child);
          let stdout = '';
          child.stdout.on('data', (chunk) => {
            stdout += chunk.toString();
          });
          const exit = await new Promise((resolve) => {
            const timer = setTimeout(() => resolve('timeout'), 5000);
            child.once('exit', (code) => {
              clearTimeout(timer);
              resolve(code);
            });
          });
          exitCode = exit;
          lines = stdout === '' ? [] : stdout.replace(/\n$/, '').split('\n');
        }
        const logged = await waitForStderr('Refused a listener connection: missing or wrong listener token', 2000);
        report(
          'a listener without the current token is refused, says so on its output, and the server logs it',
          command !== null &&
            lines.length === 1 &&
            lines[0].includes('refused') &&
            lines[0].includes('401') &&
            !lines[0].includes('0'.repeat(64)) &&
            exitCode === 1 &&
            logged,
          JSON.stringify({ hadCommand: command !== null, lines, exitCode, logged }),
        );
      }

      // A page from another origin: a second local web server, so the browser sends its Origin.
      // (A data: page was tried first: Chrome never sent its socket attempt to the server, so the
      // server could not log it.)
      {
        let outcome = 'not run';
        let targetId = null;
        let otherWs = null;
        const otherServer = http.createServer((req, res) => {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<title>other origin</title>');
        });
        await new Promise((resolve, reject) => {
          otherServer.once('error', reject);
          otherServer.listen(0, '127.0.0.1', resolve);
        });
        const otherOrigin = `http://127.0.0.1:${otherServer.address().port}`;
        try {
          const created = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(`${otherOrigin}/`)}`, {
            method: 'PUT',
          });
          if (!created.ok) throw new Error(`/json/new answered ${created.status}`);
          const other = await created.json();
          targetId = other.id;
          otherWs = new WebSocket(other.webSocketDebuggerUrl);
          await waitSocketOpen(otherWs);
          const otherCdp = makeCdp(otherWs);
          await otherCdp('Runtime.enable');
          const loadedBy = Date.now() + 5000;
          let loaded = false;
          while (!loaded && Date.now() < loadedBy) {
            try {
              loaded = (await evaluateExpr(otherCdp, 'document.title')) === 'other origin';
            } catch {
              // The context can still be starting; retry.
            }
            if (!loaded) await sleep(100);
          }
          if (!loaded) throw new Error('the other-origin page never loaded');
          // The attempt reports through a window variable that is polled, not through an awaited evaluate
          // promise: with this Chrome the awaited promise's reply never arrived, and the check hung.
          await evaluateExpr(
            otherCdp,
            `(() => {
              window.__moontideProbeOutcome = null;
              const timer = setTimeout(() => { window.__moontideProbeOutcome = 'refused'; }, 3000);
              const finish = (value) => { clearTimeout(timer); window.__moontideProbeOutcome = value; };
              let socket;
              try {
                socket = new WebSocket('ws://127.0.0.1:${moontidePort}/ws');
              } catch (err) {
                finish('threw: ' + err.message);
                return 'started';
              }
              socket.onopen = () => { socket.close(); finish('open'); };
              socket.onerror = () => finish('refused');
              socket.onclose = () => finish('refused');
              return 'started';
            })()`,
          );
          outcome = await waitFor(otherCdp, 'window.__moontideProbeOutcome', 6000);
        } catch (err) {
          outcome = `check error: ${err instanceof Error ? err.message : String(err)}`;
        } finally {
          if (otherWs !== null) {
            try {
              otherWs.close();
            } catch {
              // already closed
            }
          }
          if (targetId !== null) {
            await fetch(`http://127.0.0.1:${port}/json/close/${targetId}`).catch(() => {});
          }
          // The browser may still hold a keep-alive connection: drop it, or close() waits for it forever.
          otherServer.closeAllConnections();
          await new Promise((resolve) => otherServer.close(resolve));
        }
        const logged = await waitForStderr(`Refused a WebSocket connection from origin "${otherOrigin}"`, 2000);
        report(
          'a page from another origin cannot open the Moontide socket, and the server logs its origin',
          outcome === 'refused' && logged,
          JSON.stringify({ outcome, logged }),
        );
      }

      // A burst from the real page.
      {
        await sleep(1100);
        let sawRateLimit = false;
        let rounds = 0;
        let lastError = '';
        for (let round = 1; round <= 10 && !sawRateLimit; round++) {
          rounds = round;
          await askAt(cdp, '#product-name');
          await cdp('Input.insertText', { text: `burst ${round}` });
          await pressKey(cdp, 'Enter');
          const deadline = Date.now() + 60;
          do {
            lastError = await errorLineText();
            if (lastError === ERROR_RATE_LIMIT) {
              sawRateLimit = true;
              break;
            }
            await sleep(10);
          } while (Date.now() < deadline);
        }
        // Hand the accepted burst requests over, so none lingers.
        await callTool(client, 'get_code', {});
        report(
          'a burst of requests is refused with the rate-limit line',
          sawRateLimit,
          JSON.stringify({ rounds, lastError }),
        );
      }

      // A page holding a stale page token.
      {
        const staleSource = `(() => {
          const stale = () => {
            const meta = document.querySelector('meta[name="moontide-page-token"]');
            if (!meta) return false;
            meta.setAttribute('content', '0'.repeat(64));
            return true;
          };
          if (stale()) return;
          const observer = new MutationObserver(() => { if (stale()) observer.disconnect(); });
          observer.observe(document, { childList: true, subtree: true });
        })()`;
        // A watcher that notes whether the token line showed before any request was sent.
        const watchSource = `(() => {
          const expected = ${JSON.stringify(ERROR_STALE_TOKEN)};
          const seen = () => {
            const el = document.getElementById('eval-error');
            return el !== null && !el.hidden && el.textContent === expected;
          };
          const observer = new MutationObserver(() => {
            if (seen()) {
              window.__probeTokenLineAtConnect = true;
              observer.disconnect();
            }
          });
          observer.observe(document, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['hidden'] });
        })()`;
        await cdp('Page.enable');
        const added = await cdp('Page.addScriptToEvaluateOnNewDocument', { source: staleSource });
        const watcher = await cdp('Page.addScriptToEvaluateOnNewDocument', { source: watchSource });
        let staleShown = false;
        let refusedLabelShown = false;
        let staleReplyArmed = null;
        let cleanReplyArmed = false;
        let atConnect = null;
        let onOpen = null;
        try {
          // The server no longer attaches a page that did not present the current token, so the
          // page must show the refused label instead of Connected.
          await reloadPage(cdp, { expectedLabel: CONNECTION_LABELS.refused });
          refusedLabelShown = true;
          atConnect = await waitFor(cdp, 'window.__probeTokenLineAtConnect === true ? true : null', 3000);
          // Open the box and read the error line in the same evaluation, so no later
          // evaluation can race the read.
          onOpen = await evaluateExpr(
            cdp,
            `(() => {
              const el = document.getElementById('product-name');
              const r = el.getBoundingClientRect();
              el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, button: 2 }));
              const line = document.getElementById('eval-error');
              return { open: !document.getElementById('ask-box').hidden, hidden: line.hidden, text: line.textContent };
            })()`,
          );
          await cdp('Input.insertText', { text: 'stale page request' });
          await pressKey(cdp, 'Enter');
          const deadline = Date.now() + 3000;
          while (!staleShown && Date.now() < deadline) {
            staleShown = (await errorLineText()) === ERROR_STALE_TOKEN;
            if (!staleShown) await sleep(50);
          }
          const staleReply = await callTool(client, 'get_code', {});
          staleReplyArmed = staleReply.includes('Page requests: no listener is connected');
        } finally {
          await cdp('Page.removeScriptToEvaluateOnNewDocument', { identifier: added.identifier });
          await cdp('Page.removeScriptToEvaluateOnNewDocument', { identifier: watcher.identifier });
        }
        await reloadPage(cdp);
        const armedBy = Date.now() + 3000;
        while (!cleanReplyArmed && Date.now() < armedBy) {
          const reply = await callTool(client, 'get_code', {});
          cleanReplyArmed = reply.includes('Page requests: no listener is connected');
          if (!cleanReplyArmed) await sleep(100);
        }
        const logged = await waitForStderr("Refused a page's token", 2000);
        report(
          'a page holding a stale token is refused, shows the refused label and the token line, and no reply arms a listener for it',
          refusedLabelShown && staleShown && logged && staleReplyArmed === false && cleanReplyArmed,
          JSON.stringify({ refusedLabelShown, staleShown, logged, staleReplyArmed, cleanReplyArmed }),
        );
        // The refusal is on the error line at connect, before any request, and again on open.
        report(
          'a refused page token shows the reload line before any request and again when the box opens',
          atConnect === true && onOpen !== null && onOpen.open === true && onOpen.hidden === false && onOpen.text === ERROR_STALE_TOKEN,
          JSON.stringify({ atConnect, onOpen }),
        );
      }
    }

    // --- Ask Claude: contexts ---
    {
      const askBoxOpen = () => evaluateExpr(cdp, "!document.getElementById('ask-box').hidden");
      const closeAsk = async () => {
        if (await askBoxOpen()) await pressKey(cdp, 'Escape');
        await waitFor(cdp, "document.getElementById('ask-box').hidden ? true : null", 2000);
      };
      const currentView = () => evaluateExpr(cdp, "document.getElementById('workspace').dataset.view");
      // Leaves the page with no view open and no focus in a field, so the next key press is a view key.
      const clearViews = async () => {
        await closeAsk();
        await blurActive();
        if ((await currentView()) !== 'none') await pressKey(cdp, 'Escape');
        await blurActive();
      };
      const requestLinesOf = (reply) =>
        reply
          .split('\n')
          .filter((line) => line.startsWith(REQUEST_PREFIX))
          .map((line) => {
            try {
              return JSON.parse(line.slice(REQUEST_PREFIX.length));
            } catch {
              return null;
            }
          });
      // The rate limit counts a rolling second across pages: start this block clear of the earlier bursts.
      await sleep(1200);
      await callTool(client, 'get_code', {});

      // History: a row, its diff pane, and Enter inside the box.
      {
        await clearViews();
        await pressKey(cdp, 'a');
        await pressKey(cdp, '1');
        const rowsReady = await waitFor(
          cdp,
          "document.querySelectorAll('#history-list .hist-row').length >= 2 ? true : null",
          5000,
        );
        const ids = await evaluateExpr(cdp, "[...document.querySelectorAll('#history-list .hist-row')].map((row) => Number(row.dataset.id))");
        const firstRow = await askAt(cdp, '#history-list .hist-row .hist-main');
        await closeAsk();
        // The inline diff and the layout a diff pane both belong to the row they show.
        await evaluateExpr(cdp, "document.querySelector('#history-list .hist-row .hist-toggle').click()");
        const paneReady = await waitFor(cdp, "document.querySelector('#history-detail .hist-diff[data-id]') ? true : null", 3000);
        const paneId = await evaluateExpr(cdp, "Number(document.querySelector('#history-detail .hist-diff').dataset.id)");
        const pane = await askAt(cdp, '#history-detail .hist-diff');
        await closeAsk();
        const divider = await askAt(cdp, '#history-header');
        await closeAsk();
        // Focus a row that is not the current one (focus selects it), open the box from it, send with Enter.
        const newestBefore = await newestVersionId();
        await evaluateExpr(cdp, "document.querySelectorAll('#history-list .hist-row .hist-main')[1].focus()");
        const secondId = ids[1];
        const fromRow = await askAt(cdp, '#history-list .hist-row:nth-child(2) .hist-main');
        await cdp('Input.insertText', { text: 'history enter check' });
        await pressKey(cdp, 'Enter');
        await sleep(1000);
        // Any tool reply hands waiting requests over, so one reply serves for the history and the request.
        const reply = await callTool(client, 'list_history', {});
        const newestAfter = { id: Number((/^#(\d+) /m.exec(reply) ?? [])[1]) };
        const request = requestLinesOf(reply).find((entry) => entry !== null && entry.text === 'history enter check');
        report(
          'a History row gives its version, and Enter in the box restores nothing',
          rowsReady === true &&
            firstRow.open === true &&
            firstRow.chip.startsWith(`Version v${ids[0]}`) &&
            paneReady === true &&
            pane.chip.startsWith(`Version v${paneId}`) &&
            paneId === ids[0] &&
            divider.chip === 'Whole session' &&
            fromRow.chip.startsWith(`Version v${secondId}`) &&
            newestAfter.id === newestBefore.id &&
            request !== undefined &&
            request.context.kind === 'version' &&
            request.context.id === secondId,
          JSON.stringify({ ids, firstRow, paneId, pane, divider, fromRow, newestBefore: newestBefore.id, newestAfter: newestAfter.id, request }),
        );
        await evaluateExpr(cdp, "document.querySelector('#history-list .hist-row .hist-toggle').click()");
      }

      // Code lines: the text row, the line-number cell, the blank line, below the last line.
      {
        await clearViews();
        await callTool(client, 'set_code', { code: 'drums: s("bd*4").gain(0)\n\nhats: s("hh*8").gain(0)', label: 'probe ask code' });
        await waitFor(cdp, `${activeCodeExpr}.includes('hats:') ? true : null`, 5000);
        await blurActive();
        const lineCount = await waitFor(cdp, "document.querySelectorAll('#editor-area .cm-line').length === 3 ? true : null", 5000);
        // Each target is looked up inside its own right-click's evaluation: CodeMirror rebuilds line elements,
        // and clears attributes it did not set, on its next view update. The number cell is matched by its
        // text, not its index, because the number gutter starts with a hidden spacer cell.
        const blank = await askAt(cdp, '#editor-area .cm-line', { index: 1 });
        await closeAsk();
        const blankNumber = await askAt(cdp, '#editor-area .cm-lineNumbers .cm-gutterElement', { text: '2' });
        await closeAsk();
        const first = await askAt(cdp, '#editor-area .cm-line', { index: 0 });
        await closeAsk();
        const below = await askAtPoint(cdp, '#editor-area .cm-content', '[r.x + r.width / 2, r.y + r.height - 2]');
        await closeAsk();
        // A pointer below the last block on a line element still finds no line.
        const belowLine = await askAtPoint(cdp, '#editor-area .cm-line', '[r.x + r.width / 2, r.y + r.height + 400]', { index: 2 });
        await closeAsk();
        report(
          'a code line and its number give the line; below the last line is the whole session',
          lineCount === true &&
            blank.chip === 'Line 2 (empty)' &&
            blankNumber.chip === 'Line 2 (empty)' &&
            first.chip === 'Line 1 · drums: s("bd*4").gain(0)' &&
            below.chip === 'Whole session' &&
            belowLine.chip === 'Whole session',
          JSON.stringify({ lineCount, blank, blankNumber, first, below, belowLine }),
        );
        const codeAfter = await evaluateExpr(cdp, activeCodeExpr);

        // One real right-click: a CDP right mouse press is assumed to fire contextmenu.
        const center = await evaluateExpr(
          cdp,
          `(() => { const r = document.querySelectorAll('#editor-area .cm-line')[0].getBoundingClientRect(); return { x: r.x + Math.min(40, r.width / 2), y: r.y + r.height / 2 }; })()`,
        );
        await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: center.x, y: center.y, button: 'right', buttons: 2, clickCount: 1 });
        await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: center.x, y: center.y, button: 'right', buttons: 0, clickCount: 1 });
        const realOpened = await waitFor(cdp, "!document.getElementById('ask-box').hidden ? document.getElementById('ask-context-chip').textContent : null", 2000);
        const codeUntouched = (await evaluateExpr(cdp, activeCodeExpr)) === codeAfter;
        report(
          'a real right-click on a code line opens the box with that line',
          typeof realOpened === 'string' && realOpened.startsWith('Line 1 · ') && codeUntouched,
          JSON.stringify({ realOpened, codeUntouched }),
        );
        await closeAsk();
      }

      // Mixer controls, most specific first.
      {
        await clearViews();
        const MIXER_ASK_PROGRAM = 'drums: s("bd*4").gain(0).lpf(1200).room(0.3)\nhats: s("hh*8").gain(0)';
        const ready = await showTwoTracks(MIXER_ASK_PROGRAM, 'probe ask mixer');
        const text = (selector) => evaluateExpr(cdp, `document.querySelector(${JSON.stringify(selector)}).textContent`);
        const readout = await text(`${DRUMS} .mx-readout`);
        const sendValue = await text(`${DRUMS} .mx-send[data-bus="reverb"] .mx-send-value`);
        const fader = await askAt(cdp, `${DRUMS} .mx-fader`);
        await closeAsk();
        const faderReadout = await askAt(cdp, `${DRUMS} .mx-readout`);
        await closeAsk();
        const send = await askAt(cdp, `${DRUMS} .mx-send[data-bus="reverb"] .mx-send-slider`);
        await closeAsk();
        const chip = await askAt(cdp, `${DRUMS} .mx-chip[data-effect="lpf"] .mx-chip-body`);
        await closeAsk();
        const name = await askAt(cdp, `${DRUMS} .mx-name`);
        await closeAsk();
        const muteButton = await askAt(cdp, `${DRUMS} .mx-mute`);
        await closeAsk();
        const busChip = await askAt(cdp, '#mixer-strips .mx-bus[data-bus="reverb"] .mx-chip');
        await closeAsk();
        const busTitle = await askAt(cdp, '#mixer-strips .mx-bus[data-bus="reverb"] .mx-name');
        await closeAsk();
        await clickElement(cdp, `${DRUMS} .mx-chip[data-effect="lpf"] .mx-chip-body`);
        const inspectorOpen = await waitFor(cdp, "document.querySelector('#mixer-inspector .mx-row[data-param=\"cutoff\"]') ? true : null", 3000);
        const cutoff = await askAt(cdp, '#mixer-inspector .mx-row[data-param="cutoff"]');
        await closeAsk();
        const modeSwitch = await askAt(cdp, '#mixer-inspector .mx-move-mode[data-mode="fixed"]');
        await closeAsk();
        const inspectorTitle = await askAt(cdp, '#mixer-inspector .mx-insp-title');
        await closeAsk();
        const remove = await askAt(cdp, '#mixer-inspector .mx-remove');
        await closeAsk();
        await clickElement(cdp, '#mixer-inspector .mx-insp-close');
        const codeAfter = await evaluateExpr(cdp, activeCodeExpr);
        report(
          'every Mixer control gives its own context, most specific first',
          ready === true &&
            sendValue === '0.30' &&
            fader.chip === `drums · fader ${readout}` &&
            faderReadout.chip === `drums · fader ${readout}` &&
            send.chip === `drums · reverb send ${sendValue}` &&
            chip.chip.startsWith('drums · Lowpass') &&
            name.chip === 'Track drums' &&
            muteButton.chip === 'Track drums' &&
            busChip.chip.startsWith('Reverb bus · ') &&
            busTitle.chip === 'Reverb bus' &&
            inspectorOpen === true &&
            cutoff.chip === 'drums · Lowpass · Cutoff 1200 Hz' &&
            modeSwitch.chip === 'drums · Lowpass · Cutoff 1200 Hz' &&
            inspectorTitle.chip === 'drums · Lowpass' &&
            remove.chip === 'drums · Lowpass' &&
            codeAfter === MIXER_ASK_PROGRAM,
          JSON.stringify({ readout, sendValue, fader, faderReadout, send, chip, name, muteButton, busChip, busTitle, cutoff, modeSwitch, inspectorTitle, remove, codeChanged: codeAfter !== MIXER_ASK_PROGRAM }),
        );
      }

      // Parts, sections and lanes.
      let laneProbe = null;
      {
        await clearViews();
        await callTool(client, 'set_code', { code: PARTS_PROGRAM, label: 'probe ask parts' });
        await blurActive();
        await pressKey(cdp, '4');
        const cardsReady = await waitFor(cdp, "document.querySelectorAll('#parts-rows .part-card').length === 3 ? true : null", 5000);
        const card = await askAt(cdp, '#parts-rows .part-card:nth-child(2)');
        await closeAsk();
        await blurActive();
        await pressKey(cdp, '2');
        const timelineReady = await waitFor(cdp, "document.getElementById('timeline-view').dataset.state === 'ok' && document.querySelector('#timeline-sections .section-span') ? true : null", 8000);
        // The section header's pointer is its own center; its moment reads the first lane's event area.
        const sectionPointer = await evaluateExpr(
          cdp,
          `(() => {
            const span = document.querySelector('#timeline-sections .section-span');
            const svg = document.querySelector('#timeline-lanes .lane .lane-events');
            const s = span.getBoundingClientRect();
            const r = svg.getBoundingClientRect();
            return { x: s.x + s.width / 2, fraction: (s.x + s.width / 2 - r.x) / r.width };
          })()`,
        );
        const section = await askAt(cdp, '#timeline-sections .section-span');
        await closeAsk();
        const pageStart = await evaluateExpr(cdp, "Number(document.getElementById('timeline-lanes').dataset.pageStart)");
        const laneName = await evaluateExpr(cdp, "document.querySelector('#timeline-lanes .lane .lane-name').textContent");
        // 27% of the width is cycle 8.64: a pointer at exactly 25% sits on the edge of cycle 8, where a rounding of a
        // fraction of a pixel would read cycle 7. PARTS_PROGRAM's one lane draws one whole-cycle note per cycle, so one
        // note sounds there and none starts in that sixteenth (the instant is 0.64 cycles into the cycle, beat 3).
        const lane = await askAtPoint(cdp, '#timeline-lanes .lane .lane-events', '[r.x + 0.27 * r.width, r.y + r.height / 2]');
        await closeAsk();
        const gutter = await askAt(cdp, '#timeline-lanes .lane .lane-gutter');
        await closeAsk();
        laneProbe = { name: laneName, cycle: pageStart + 8 };
        const sectionCycle = Number.isInteger(pageStart) ? cycleAt({ pageStart, fraction: sectionPointer.fraction }) : null;
        const sectionMatch = /^Part "one" · cycle (\d+), beat \d · (no notes|1 note|\d+ notes)$/.exec(section.chip);
        report(
          'a part, a section and a lane at a cycle give their context',
          cardsReady === true &&
            card.chip === 'Part "two"' &&
            timelineReady === true &&
            sectionMatch !== null &&
            Number(sectionMatch[1]) === sectionCycle &&
            Number.isInteger(pageStart) &&
            lane.chip === `Lane ${laneName} · cycle ${pageStart + 8}, beat 3 · 1 note` &&
            gutter.chip === `Lane ${laneName}`,
          JSON.stringify({ cardsReady, card, timelineReady, section, sectionPointer, sectionCycle, pageStart, laneName, lane, gutter }),
        );
        // The ruler, the space under the last lane and the corner: the first two give the lane's moment at the same x
        // (without the lane's name), the corner left of the lanes' event area stays the whole session.
        const spots = await evaluateExpr(
          cdp,
          `(() => {
            const svg = document.querySelector('#timeline-lanes .lane .lane-events');
            const r = svg.getBoundingClientRect();
            const x = r.x + 0.27 * r.width;
            const ruler = document.getElementById('timeline-ruler').getBoundingClientRect();
            const lanes = [...document.querySelectorAll('#timeline-lanes .lane')];
            const last = lanes[lanes.length - 1].getBoundingClientRect();
            const view = document.getElementById('timeline-view').getBoundingClientRect();
            const gapY = Math.min(last.bottom + 3, view.bottom - 1);
            const at = document.elementFromPoint(x, gapY);
            return {
              x,
              rulerY: ruler.y + ruler.height / 2,
              rulerLeft: ruler.x + 1,
              gapY,
              gapInside: at !== null && at.closest('#timeline-view') !== null,
              gapTag: at === null ? null : at.id || at.className || at.tagName,
              lastBottom: last.bottom,
              viewBottom: view.bottom,
            };
          })()`,
        );
        const onRuler = await askAtCoords(cdp, spots.x, spots.rulerY);
        await closeAsk();
        const inGap = await askAtCoords(cdp, spots.x, spots.gapY);
        await closeAsk();
        const inCorner = await askAtCoords(cdp, spots.rulerLeft, spots.rulerY);
        await closeAsk();
        const laneText = lane.chip.slice(`Lane ${laneName} · `.length);
        report(
          'the ruler, a gap and the corner of the Timeline',
          spots.gapInside === true &&
            lane.chip.startsWith(`Lane ${laneName} · `) &&
            onRuler.chip === `Moment · ${laneText}` &&
            inGap.chip === `Moment · ${laneText}` &&
            inCorner.chip === 'Whole session',
          JSON.stringify({ spots, laneText, onRuler, inGap, inCorner }),
        );
      }

      // The top bar, Shift and the box's own field.
      {
        const topBar = await askAt(cdp, '#top-bar');
        const fieldInside = await askAt(cdp, '#ask-field');
        await closeAsk();
        const shifted = await askAt(cdp, '#top-bar', { shiftKey: true });
        report(
          'Shift + right-click and a right-click inside the box keep the browser menu',
          topBar.prevented === true &&
            topBar.chip === 'Whole session' &&
            fieldInside.prevented === false &&
            shifted.prevented === false &&
            shifted.open === false,
          JSON.stringify({ topBar, fieldInside, shifted }),
        );
      }

      // The structured context reaches Claude through a listener started from the arming line.
      {
        const armReply = await callTool(client, 'get_code', {});
        const listener = spawnListener(armReply);
        let parsed = null;
        let printed;
        let drawn = null;
        if (listener !== null && laneProbe !== null) {
          await sleep(500);
          await askAtPoint(cdp, '#timeline-lanes .lane .lane-events', '[r.x + 0.27 * r.width, r.y + r.height / 2]');
          await cdp('Input.insertText', { text: 'lane check' });
          await pressKey(cdp, 'Enter');
          const started = Date.now();
          while (listener.lines.length === 0 && Date.now() - started < 3000) await sleep(100);
          // What the first lane drew, in cycles from the page start: the notes the moment must be made of.
          drawn = await evaluateExpr(
            cdp,
            `(() => ({
              pageStart: Number(document.getElementById('timeline-lanes').dataset.pageStart),
              rects: [...document.querySelectorAll('#timeline-lanes .lane:first-child rect.event')].map((rect) => ({
                x: Number(rect.getAttribute('x')),
                width: Number(rect.getAttribute('width')),
              })),
            }))()`,
          );
          printed = listener.lines[0];
          if (printed !== undefined && printed.startsWith(REQUEST_PREFIX)) {
            try {
              parsed = JSON.parse(printed.slice(REQUEST_PREFIX.length));
            } catch {
              parsed = null;
            }
          }
        }
        if (listener !== null) {
          listener.child.kill();
          await listener.exited;
        }
        const moment = parsed === null ? undefined : parsed.moment;
        const momentNote = moment !== undefined && moment !== null && Array.isArray(moment.notes) ? moment.notes[0] : undefined;
        // The note in the moment is the rect the lane draws under the pointer: same start, and the rect still
        // reaches past the instant.
        const underPointer =
          momentNote !== undefined &&
          drawn !== null &&
          drawn.rects.some(
            (rect) => Math.abs(drawn.pageStart + rect.x - momentNote.start) < 0.001 && drawn.pageStart + rect.x + rect.width > moment.at,
          );
        report(
          'the structured context reaches Claude',
          parsed !== null &&
            parsed.text === 'lane check' &&
            parsed.context.kind === 'lane' &&
            parsed.context.track === laneProbe.name &&
            parsed.context.cycle === laneProbe.cycle &&
            parsed.chip === `Lane ${laneProbe.name} · cycle ${laneProbe.cycle}, beat 3 · 1 note` &&
            JSON.stringify(Object.keys(parsed)) === JSON.stringify(['id', 'text', 'context', 'chip', 'current', 'moment']) &&
            moment !== undefined &&
            moment.cycle === laneProbe.cycle &&
            moment.cycle === parsed.context.cycle &&
            moment.beat === 3 &&
            moment.version === parsed.current &&
            moment.more === 0 &&
            moment.notes.length === 1 &&
            momentNote.track === laneProbe.name &&
            momentNote.state === 'sounding' &&
            typeof momentNote.velocity === 'number' &&
            momentNote.start <= moment.at &&
            moment.at < momentNote.end &&
            underPointer,
          JSON.stringify({ hadListener: listener !== null, printed, moment, drawnRects: drawn === null ? null : drawn.rects.length }),
        );
        await closeAsk();
        // Nothing may linger for the checks that follow.
        await callTool(client, 'get_code', {});
        await clearViews();
      }

      // The notes of a moment are the notes the Timeline draws (MOMENT, HELD). Three lanes whose sound is silenced
      // with postgain, so gain and velocity stay on the events: chords (gain 0.5), drums (nothing set) and a
      // triplet lead (gain 0.5 x velocity 0.6).
      {
        await clearViews();
        const MOMENT_PROGRAM = [
          'chords: note("<[c3,e3,g3] [a2,c3,e3]>").s("triangle").gain(0.5).postgain(0)',
          'drums: s("bd*4, hh*8").postgain(0)',
          'lead: note("c5 e5 g5").s("sine").gain(0.5).velocity(0.6).postgain(0)',
        ].join('\n');
        await callTool(client, 'set_code', { code: MOMENT_PROGRAM, label: 'probe moment' });
        await blurActive();
        await pressKey(cdp, '2');
        const lanesReady = await waitFor(
          cdp,
          "document.getElementById('timeline-view').dataset.state === 'ok' && document.querySelectorAll('#timeline-lanes .lane').length === 3 && document.querySelectorAll('#timeline-lanes .lane:last-child rect.event').length > 0 ? true : null",
          10000,
        );
        // A6: every lane's event area has the first one's left edge and width, so one reference rect serves the Timeline.
        const extents = await evaluateExpr(
          cdp,
          `(() => {
            const svgs = [...document.querySelectorAll('#timeline-lanes .lane .lane-events')];
            const first = svgs[0].getBoundingClientRect();
            const last = svgs[svgs.length - 1].getBoundingClientRect();
            return { lanes: svgs.length, first: { left: first.left, width: first.width }, last: { left: last.left, width: last.width } };
          })()`,
        );
        report(
          'the lanes share one event area',
          lanesReady === true &&
            extents.lanes === 3 &&
            Math.abs(extents.first.left - extents.last.left) <= 0.5 &&
            Math.abs(extents.first.width - extents.last.width) <= 0.5,
          JSON.stringify({ lanesReady, extents }),
        );

        // What the Timeline draws now, lane by lane, and where each kind of spot is, read at click time.
        const drawnLanes = () =>
          evaluateExpr(
            cdp,
            `(() => ({
              pageStart: Number(document.getElementById('timeline-lanes').dataset.pageStart),
              lanes: [...document.querySelectorAll('#timeline-lanes .lane')].map((lane) => ({
                track: lane.querySelector('.lane-name').textContent,
                rects: [...lane.querySelectorAll('rect.event')].map((rect) => ({ x: Number(rect.getAttribute('x')), width: Number(rect.getAttribute('width')) })),
              })),
            }))()`,
          );
        const spotsNow = () =>
          evaluateExpr(
            cdp,
            `(() => {
              const svg = document.querySelector('#timeline-lanes .lane .lane-events');
              const r = svg.getBoundingClientRect();
              const ruler = document.getElementById('timeline-ruler').getBoundingClientRect();
              const lanes = [...document.querySelectorAll('#timeline-lanes .lane')];
              const last = lanes[lanes.length - 1].getBoundingClientRect();
              const view = document.getElementById('timeline-view').getBoundingClientRect();
              const gapY = last.bottom + 3;
              const at = document.elementFromPoint(r.x + 0.5 * r.width, gapY);
              return {
                left: r.x,
                width: r.width,
                laneY: r.y + r.height / 2,
                rulerY: ruler.y + ruler.height / 2,
                gapY,
                gapInside: gapY < view.bottom && at !== null && at.closest('#timeline-view') !== null,
              };
            })()`,
          );
        const round3 = (value) => Math.round(value * 1000) / 1000;
        // The pointer lands on a whole pixel (a synthetic mouse event truncates its position), and one pixel is about
        // 0.05 cycles. The targets are cycles into the page, none on the edge of a sixteenth or of a note: 8.625 is the
        // start of the sixteenth where the lead's second note begins (8 + 2/3 = 8.667) later, so the first position has
        // a note that starts after the instant; the pixel is the first one at or after the target.
        const positions = [
          { target: 8.625, spot: 'lane', text: 'moment check 1' },
          { target: 12.8, spot: 'ruler', text: 'moment check 2' },
          { target: 20.16, spot: 'gap', text: 'moment check 3' },
          { target: 22.4, spot: 'lane', text: 'moment check 4' },
        ];
        const sentAt = [];
        for (const position of positions) {
          await closeAsk();
          const spots = await spotsNow();
          const y = position.spot === 'lane' ? spots.laneY : position.spot === 'ruler' ? spots.rulerY : spots.gapY;
          const opened = await askAtCoords(cdp, Math.ceil(spots.left + (position.target / 32) * spots.width), y);
          await cdp('Input.insertText', { text: position.text });
          await pressKey(cdp, 'Enter');
          sentAt.push({ ...position, spots, opened, drawn: await drawnLanes() });
          await sleep(300);
        }
        const reply = await callTool(client, 'get_code', {});
        const requests = requestLinesOf(reply).filter((entry) => entry !== null);
        const checks = sentAt.map((sent) => {
          const request = requests.find((entry) => entry.text === sent.text);
          const moment = request === undefined ? undefined : request.moment;
          if (moment === undefined) return { text: sent.text, spot: sent.spot, ok: false, why: 'no moment in the request' };
          const offset = moment.at - sent.drawn.pageStart;
          const cell = Math.floor(offset * 16) / 16;
          const velocities = { chords: 0.5, drums: 0.8, lead: 0.3 };
          const perLane = sent.drawn.lanes.map((lane) => {
            const expected = [];
            for (const rect of lane.rects) {
              const sounding = rect.x <= offset && offset < rect.x + rect.width;
              if (sounding) expected.push({ start: round3(rect.x), state: 'sounding' });
              else if (rect.x > offset && rect.x < cell + 1 / 16) expected.push({ start: round3(rect.x), state: 'starts' });
            }
            const got = moment.notes
              .filter((note) => note.track === lane.track)
              .map((note) => ({ start: round3(note.start - sent.drawn.pageStart), state: note.state }));
            const order = (a, b) => a.start - b.start || a.state.localeCompare(b.state);
            const same = JSON.stringify([...expected].sort(order)) === JSON.stringify([...got].sort(order));
            const velocityOk = moment.notes
              .filter((note) => note.track === lane.track)
              .every((note) => Math.abs(note.velocity - velocities[lane.track]) < 0.001);
            return { track: lane.track, expected, got, same, velocityOk };
          });
          const known = new Set(sent.drawn.lanes.map((lane) => lane.track));
          return {
            text: sent.text,
            spot: sent.spot,
            ok:
              perLane.every((lane) => lane.same && lane.velocityOk) &&
              moment.notes.every((note) => known.has(note.track)) &&
              sent.opened.chip.startsWith('Moment · ') === (sent.spot !== 'lane') &&
              (sent.spot !== 'gap' || sent.spots.gapInside === true),
            starts: moment.notes.filter((note) => note.state === 'starts').length,
            moment,
            perLane,
          };
        });
        report(
          'moment: the notes are the ones the Timeline draws',
          lanesReady === true &&
            checks.length === positions.length &&
            checks.every((check) => check.ok) &&
            checks[0].starts >= 1 &&
            checks.reduce((total, check) => total + (check.moment === undefined ? 0 : check.moment.notes.length), 0) > 0,
          JSON.stringify({ checks, chips: sentAt.map((sent) => sent.opened.chip), gap: sentAt[2].spots }),
        );
        await closeAsk();
        await clearViews();
      }
    }

    // --- Ask Claude: the box and the Parts button ---
    {
      const askBoxOpen = () => evaluateExpr(cdp, "!document.getElementById('ask-box').hidden");
      const closeAsk = async () => {
        if (await askBoxOpen()) await pressKey(cdp, 'Escape');
        await waitFor(cdp, "document.getElementById('ask-box').hidden ? true : null", 2000);
      };
      const layoutAndView = () =>
        evaluateExpr(
          cdp,
          "({ layout: document.getElementById('workspace').dataset.layout, view: document.getElementById('workspace').dataset.view })",
        );
      // Leaves the page with no view open and no focus in a field, so the next key press is a view key.
      const clearViews = async () => {
        await closeAsk();
        await blurActive();
        if ((await evaluateExpr(cdp, "document.getElementById('workspace').dataset.view")) !== 'none') await pressKey(cdp, 'Escape');
        await blurActive();
      };
      // Empties the field the way a person would, then closes the box.
      const clearField = () =>
        evaluateExpr(
          cdp,
          "(() => { const f = document.getElementById('ask-field'); f.value = ''; f.dispatchEvent(new Event('input', { bubbles: true })); })()",
        );
      const stopListeners = async () => {
        for (const child of spawnedListeners) {
          if (child.exitCode === null && child.signalCode === null) {
            const exited = new Promise((resolve) => child.once('exit', resolve));
            child.kill();
            await exited;
          }
        }
        await sleep(300);
      };
      const requestsOf = (reply) =>
        reply
          .split('\n')
          .filter((line) => line.startsWith(REQUEST_PREFIX))
          .map((line) => {
            try {
              return JSON.parse(line.slice(REQUEST_PREFIX.length));
            } catch {
              return null;
            }
          });
      const readField = () =>
        evaluateExpr(
          cdp,
          "(() => { const f = document.getElementById('ask-field'); return { value: f.value, start: f.selectionStart, end: f.selectionEnd, focused: document.activeElement === f }; })()",
        );
      const boxRect = () =>
        evaluateExpr(
          cdp,
          `(() => {
            const r = document.getElementById('ask-box').getBoundingClientRect();
            return {
              left: r.left,
              top: r.top,
              right: r.right,
              bottom: r.bottom,
              width: window.innerWidth,
              height: window.innerHeight,
              rootPx: parseFloat(getComputedStyle(document.documentElement).fontSize),
            };
          })()`,
        );
      const insideWindow = (r) => {
        const margin = r.rootPx * 0.5 - 0.5;
        return r.left >= margin && r.top >= margin && r.right <= r.width - margin && r.bottom <= r.height - margin;
      };
      // The rate limit counts a rolling second across pages: start this block clear of the earlier bursts.
      await sleep(1200);
      await stopListeners();
      await callTool(client, 'get_code', {});
      await clearViews();

      // Esc closes without sending, and the draft comes back selected.
      {
        await askAt(cdp, '#product-name');
        await cdp('Input.insertText', { text: 'draft check' });
        await pressKey(cdp, 'Escape');
        const hiddenAfterEsc = await evaluateExpr(cdp, "document.getElementById('ask-box').hidden");
        const reply = await callTool(client, 'get_code', {});
        const sentAnyway = requestsOf(reply).some((entry) => entry !== null && entry.text === 'draft check');
        await askAt(cdp, '#product-name');
        const back = await readField();
        await clearField();
        await closeAsk();
        report(
          'Esc closes without sending, and the draft comes back selected',
          hiddenAfterEsc === true && sentAnyway === false && back.value === 'draft check' && back.start === 0 && back.end === 11 && back.focused === true,
          JSON.stringify({ hiddenAfterEsc, sentAnyway, back }),
        );
      }

      // Shift+Enter, the layout keys and the length limit, with a live listener.
      const armReply = await callTool(client, 'get_code', {});
      const listener = spawnListener(armReply);
      if (listener === null) throw new Error('Ask Claude: the arming line held no listener command.');
      await sleep(600);
      {
        await askAt(cdp, '#product-name');
        await cdp('Input.insertText', { text: 'first' });
        await pressKey(cdp, 'Enter', { shift: true });
        await cdp('Input.insertText', { text: 'second' });
        const midway = await readField();
        const stillOpen = await askBoxOpen();
        await pressKey(cdp, 'Enter');
        const started = Date.now();
        while (listener.lines.length === 0 && Date.now() - started < 3000) await sleep(100);
        let parsed = null;
        try {
          parsed = JSON.parse(listener.lines[0].slice(REQUEST_PREFIX.length));
        } catch {
          parsed = null;
        }
        report(
          'Shift+Enter adds a line and Enter sends both lines as one request',
          stillOpen === true && midway.value === 'first\nsecond' && listener.lines.length === 1 && parsed !== null && parsed.text === 'first\nsecond',
          JSON.stringify({ stillOpen, midway, lines: listener.lines.length, parsed }),
        );
        await closeAsk();
      }

      {
        const before = await layoutAndView();
        await askAt(cdp, '#product-name');
        await pressKey(cdp, 'a');
        await pressKey(cdp, '3');
        await pressKey(cdp, ' ');
        const after = await layoutAndView();
        const typed = await readField();
        await clearField();
        await closeAsk();
        report(
          'typing a, 3 and a space in the box switches nothing',
          before.layout === after.layout && before.view === after.view && typed.value.endsWith('a3 ') && typed.focused === true,
          JSON.stringify({ before, after, typed: typed.value }),
        );
      }

      {
        const linesBefore = listener.lines.length;
        await askAt(cdp, '#product-name');
        const oneLine = await boxRect();
        await cdp('Input.insertText', { text: 'x'.repeat(1800) });
        const counter = await evaluateExpr(cdp, "document.getElementById('ask-message').textContent");
        // The field grew to its six-line height and scrolls inside itself; the box opened below the pointer
        // and kept its top.
        const grown = await evaluateExpr(
          cdp,
          `(() => {
            const field = document.getElementById('ask-field');
            const style = getComputedStyle(field);
            return { height: field.getBoundingClientRect().height, max: parseFloat(style.maxHeight), scrolls: field.scrollHeight > field.clientHeight };
          })()`,
        );
        const sameBox = await boxRect();
        await cdp('Input.insertText', { text: 'x'.repeat(201) });
        const tooLong = await evaluateExpr(
          cdp,
          `(() => ({
            message: document.getElementById('ask-message').textContent,
            invalid: document.getElementById('ask-field').getAttribute('aria-invalid'),
            length: document.getElementById('ask-field').value.length,
          }))()`,
        );
        await pressKey(cdp, 'Enter');
        await sleep(1000);
        const stillOpen = await askBoxOpen();
        await clearField();
        await closeAsk();
        report(
          'a request over 2000 characters is not sent and says why',
          counter === '1800 / 2000' &&
            Math.abs(grown.height - grown.max) < 1 &&
            grown.scrolls === true &&
            sameBox.left === oneLine.left &&
            sameBox.top === oneLine.top &&
            tooLong.message === '2001 / 2000 — too long. Shorten it to send.' &&
            tooLong.invalid === 'true' &&
            tooLong.length === 2001 &&
            stillOpen === true &&
            listener.lines.length === linesBefore,
          JSON.stringify({ counter, grown, tooLong, stillOpen, linesBefore, linesAfter: listener.lines.length }),
        );
      }

      // 2000 control characters are within the character limit, but JSON writes each
      // as six bytes, so the line cannot fit 8192 bytes. The box says why and sends nothing.
      {
        const linesBefore = listener.lines.length;
        await askAt(cdp, '#product-name');
        await evaluateExpr(
          cdp,
          `(() => {
            const field = document.getElementById('ask-field');
            field.value = '\\u0001'.repeat(2000);
            field.dispatchEvent(new Event('input', { bubbles: true }));
          })()`,
        );
        const shown = await evaluateExpr(
          cdp,
          `(() => ({
            message: document.getElementById('ask-message').textContent,
            invalid: document.getElementById('ask-field').getAttribute('aria-invalid'),
            length: document.getElementById('ask-field').value.length,
          }))()`,
        );
        await pressKey(cdp, 'Enter');
        await sleep(1000);
        const stillOpen = await askBoxOpen();
        await clearField();
        await closeAsk();
        report(
          'a text within 2000 characters whose line cannot fit is not sent and says it is too long to send',
          shown.length === 2000 &&
            shown.message.startsWith('request too long to send') &&
            shown.invalid === 'true' &&
            stillOpen === true &&
            listener.lines.length === linesBefore,
          JSON.stringify({ shown, stillOpen, linesBefore, linesAfter: listener.lines.length }),
        );
      }

      // A right-click whose context cannot be read opens on the whole session and says so on
      // the error line; the next readable right-click clears that line.
      {
        const detail = {};
        try {
          detail.bad = await evaluateExpr(
            cdp,
            `(() => {
              const el = document.createElement('div');
              el.id = 'probe-bad-part';
              el.className = 'part-card';
              el.setAttribute('data-part', '');
              el.style.position = 'fixed';
              el.style.left = '200px';
              el.style.top = '200px';
              el.style.width = '40px';
              el.style.height = '20px';
              document.body.appendChild(el);
              el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 220, clientY: 210, button: 2 }));
              const line = document.getElementById('eval-error');
              return {
                open: !document.getElementById('ask-box').hidden,
                chip: document.getElementById('ask-context-chip').textContent,
                text: line.textContent,
                hidden: line.hidden,
                title: line.getAttribute('title'),
              };
            })()`,
          );
          await askAt(cdp, '#product-name');
          detail.hiddenAfter = await evaluateExpr(cdp, "document.getElementById('eval-error').hidden");
        } finally {
          await evaluateExpr(cdp, "(() => { const el = document.getElementById('probe-bad-part'); if (el) el.remove(); })()");
          await closeAsk();
        }
        const bad = detail.bad;
        report(
          'a right-click whose context cannot be read opens on Whole session and says so on the error line',
          bad !== undefined &&
            bad.open === true &&
            bad.chip === 'Whole session' &&
            bad.hidden === false &&
            bad.text === 'Error: could not read what was right-clicked \u2014 this request is about the whole session.' &&
            typeof bad.title === 'string' &&
            bad.title.includes('needs a non-empty name') &&
            detail.hiddenAfter === true,
          JSON.stringify(detail),
        );
      }

      // The box stays inside the window at every corner and after a resize.
      {
        const detail = { corners: [], resized: null };
        try {
          await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
          for (const [x, y] of [
            [2, 2],
            [1278, 2],
            [2, 798],
            [1278, 798],
          ]) {
            await closeAsk();
            const result = await askAtCoords(cdp, x, y);
            const rect = await boxRect();
            detail.corners.push({ x, y, open: result.open, inside: insideWindow(rect), rect });
          }
          // Open at the bottom-right of a large window, then shrink the window under the open box.
          await closeAsk();
          await cdp('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
          await askAtCoords(cdp, 1398, 898);
          await cdp('Emulation.setDeviceMetricsOverride', { width: 900, height: 600, deviceScaleFactor: 1, mobile: false });
          detail.resized = await waitFor(
            cdp,
            `(() => {
              const r = document.getElementById('ask-box').getBoundingClientRect();
              return window.innerWidth === 900 && r.right <= 900 ? { right: r.right, bottom: r.bottom, left: r.left, top: r.top } : null;
            })()`,
            3000,
          );
          detail.resizedRect = await boxRect();
        } finally {
          await cdp('Emulation.clearDeviceMetricsOverride');
          await closeAsk();
        }
        report(
          'the box stays inside the window at every corner and after a resize',
          detail.corners.length === 4 &&
            detail.corners.every((corner) => corner.open === true && corner.inside === true) &&
            detail.resized !== null &&
            insideWindow(detail.resizedRect),
          JSON.stringify(detail),
        );
      }

      // The field's description lists the message line only while it shows.
      {
        const described = () =>
          evaluateExpr(
            cdp,
            "({ describedBy: document.getElementById('ask-field').getAttribute('aria-describedby'), messageHidden: document.getElementById('ask-message').hidden })",
          );
        const detail = {};
        try {
          await closeAsk();
          await askAt(cdp, '#product-name');
          await clearField();
          detail.empty = await described();
          await cdp('Input.insertText', { text: 'x'.repeat(1800) });
          detail.long = await described();
        } finally {
          await clearField();
          await closeAsk();
        }
        report(
          "the field's description lists the message line only while it shows",
          detail.empty !== undefined &&
            detail.empty.describedBy === 'ask-context-chip ask-hint' &&
            detail.empty.messageHidden === true &&
            detail.long !== undefined &&
            detail.long.describedBy === 'ask-context-chip ask-message ask-hint' &&
            detail.long.messageHidden === false,
          JSON.stringify(detail),
        );
      }

      // Near the bottom edge the box sits right above the pointer (its bottom within the
      // offset) and grows upward while the field fills, inside the window; a short window keeps it inside too.
      {
        const eightLines = Array.from({ length: 8 }, (_, index) => `line ${index + 1}`).join('\n');
        const fillField = () =>
          evaluateExpr(
            cdp,
            `(() => { const f = document.getElementById('ask-field'); f.value = ${JSON.stringify(eightLines)}; f.dispatchEvent(new Event('input', { bubbles: true })); })()`,
          );
        const detail = { bottom: [], short: null };
        try {
          await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
          for (const [x, y] of [
            [2, 798],
            [1278, 798],
          ]) {
            await closeAsk();
            const result = await askAtCoords(cdp, x, y);
            const before = await boxRect();
            await fillField();
            const after = await boxRect();
            await clearField();
            await closeAsk();
            detail.bottom.push({
              x,
              y,
              open: result.open,
              gap: y - before.bottom,
              gapAfter: y - after.bottom,
              before,
              after,
              insideBefore: insideWindow(before),
              insideAfter: insideWindow(after),
            });
          }
          await cdp('Emulation.setDeviceMetricsOverride', { width: 900, height: 300, deviceScaleFactor: 1, mobile: false });
          await waitFor(cdp, 'window.innerHeight === 300 ? true : null', 3000);
          const shortResult = await askAtCoords(cdp, 2, 150);
          await fillField();
          const shortRect = await boxRect();
          detail.short = { open: shortResult.open, rect: shortRect, inside: insideWindow(shortRect) };
        } finally {
          await cdp('Emulation.clearDeviceMetricsOverride');
          await clearField();
          await closeAsk();
        }
        report(
          'near the bottom edge the box sits right above the pointer and grows upward while typing, inside the window',
          detail.bottom.length === 2 &&
            detail.bottom.every(
              (entry) =>
                entry.open === true &&
                entry.gap >= 0 &&
                entry.gap <= entry.before.rootPx * 0.5 + 1 &&
                Math.abs(entry.after.bottom - entry.before.bottom) <= 1 &&
                entry.after.top < entry.before.top &&
                entry.insideBefore === true &&
                entry.insideAfter === true,
            ) &&
            detail.short !== null &&
            detail.short.open === true &&
            detail.short.inside === true,
          JSON.stringify(detail),
        );
      }

      // Clicking elsewhere closes the box and keeps the draft; a second right-click moves it and keeps the text.
      {
        const detail = {};
        try {
          await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
          await askAt(cdp, '#product-name');
          await cdp('Input.insertText', { text: 'moving check' });
          const first = await boxRect();
          const viewsRect = await evaluateExpr(
            cdp,
            "(() => { const r = document.getElementById('view-buttons').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()",
          );
          await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: viewsRect.x, y: viewsRect.y, button: 'right', buttons: 2, clickCount: 1 });
          await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: viewsRect.x, y: viewsRect.y, button: 'right', buttons: 0, clickCount: 1 });
          await sleep(200);
          const second = await boxRect();
          detail.moved = second.left !== first.left || second.top !== first.top;
          detail.open = await askBoxOpen();
          detail.field = await readField();
          await clickElement(cdp, '#product-name');
          detail.closedByClick = (await waitFor(cdp, "document.getElementById('ask-box').hidden ? true : null", 2000)) === true;
          await askAt(cdp, '#product-name');
          detail.draft = await readField();
        } finally {
          await cdp('Emulation.clearDeviceMetricsOverride');
          await clearField();
          await closeAsk();
        }
        report(
          'clicking elsewhere closes the box and keeps the draft; a second right-click moves it and keeps the text',
          detail.moved === true &&
            detail.open === true &&
            detail.field.value === 'moving check' &&
            detail.field.focused === true &&
            detail.closedByClick === true &&
            detail.draft.value === 'moving check' &&
            detail.draft.start === 0 &&
            detail.draft.end === 12,
          JSON.stringify(detail),
        );
      }

      // The status sequence, with a listener and then without.
      {
        await sleep(4500);
        await evaluateExpr(
          cdp,
          `(() => {
            window.__askStatusLog = [];
            const el = document.getElementById('ask-status');
            new MutationObserver(() => {
              const text = el.querySelector('.ask-long').textContent;
              if (!el.hidden && text !== '') window.__askStatusLog.push(text);
            }).observe(el, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
          })()`,
        );
        await askAt(cdp, '#product-name');
        await cdp('Input.insertText', { text: 'status check one' });
        await pressKey(cdp, 'Enter');
        const log = await waitFor(cdp, "window.__askStatusLog.includes('Claude received it') ? window.__askStatusLog.slice() : null", 3000);
        const deduped = (log ?? []).filter((text, index, all) => index === 0 || text !== all[index - 1]);

        await stopListeners();
        await sleep(1200);
        await askAt(cdp, '#product-name');
        await cdp('Input.insertText', { text: 'wait one' });
        await pressKey(cdp, 'Enter');
        await sleep(700);
        await askAt(cdp, '#product-name');
        await cdp('Input.insertText', { text: 'wait two' });
        await pressKey(cdp, 'Enter');
        const waitingForTwo = await waitFor(cdp, statusText('Claude will see 2 requests on its next action'), 3000);
        const reply = await callTool(client, 'get_code', {});
        const twoDelivered = requestsOf(reply).filter((entry) => entry !== null && (entry.text === 'wait one' || entry.text === 'wait two')).length;
        const receivedTwo = await waitFor(cdp, statusText('Claude received 2 requests'), 2000);
        report(
          'the status shows Sent to Claude before Claude received it; waiting requests use the count form',
          deduped.length === 2 &&
            deduped[0] === 'Sent to Claude' &&
            deduped[1] === 'Claude received it' &&
            waitingForTwo === true &&
            twoDelivered === 2 &&
            receivedTwo === true,
          JSON.stringify({ deduped, waitingForTwo, twoDelivered, receivedTwo }),
        );
      }

      // The Parts view's button.
      {
        await sleep(4200);
        await clearViews();
        await callTool(client, 'set_code', { code: 'one: s("hh*2").gain(0)', label: 'probe ask parts button' });
        await pressKey(cdp, '4');
        const shown = await waitFor(
          cdp,
          `(() => {
            const button = document.getElementById('parts-ask');
            return !button.hidden && button.getBoundingClientRect().width > 0
              ? { text: button.textContent, disabled: button.disabled, line: document.getElementById('parts-ask-status').hidden }
              : null;
          })()`,
          3000,
        );
        const onButton = await askAt(cdp, '#parts-ask');
        const boxOpenedByRightClick = await askBoxOpen();
        await closeAsk();
        const stillIdle = await evaluateExpr(cdp, "!document.getElementById('parts-ask').disabled");
        await clickElement(cdp, '#parts-ask');
        const pending = await waitFor(
          cdp,
          `(() => {
            const button = document.getElementById('parts-ask');
            const line = document.getElementById('parts-ask-status');
            return button.disabled && !line.hidden && line.textContent === 'Claude will see it on its next action' ? true : null;
          })()`,
          3000,
        );
        const reply = await callTool(client, 'get_code', {});
        const requests = requestsOf(reply).filter((entry) => entry !== null);
        const canned = requests.find((entry) => entry.text === 'Organize this code into sections with arrange()');
        const settled = await waitFor(
          cdp,
          "!document.getElementById('parts-ask').disabled && document.getElementById('parts-ask-status').hidden ? true : null",
          2000,
        );
        await callTool(client, 'set_code', { code: PARTS_PROGRAM, label: 'probe ask parts button sections' });
        const hiddenWithSections = await waitFor(cdp, "document.getElementById('parts-ask').hidden ? true : null", 3000);
        await pressKey(cdp, '4');
        report(
          'the Parts view offers to ask for sections only when the code has none, and sends exactly the canned request',
          !!shown &&
            shown.text === 'Ask Claude to add sections' &&
            shown.disabled === false &&
            shown.line === true &&
            onButton.chip === 'Whole session' &&
            onButton.prevented === true &&
            boxOpenedByRightClick === true &&
            stillIdle === true &&
            pending === true &&
            requests.length === 1 &&
            !!canned &&
            canned.context.kind === 'session' &&
            canned.chip === 'Whole session' &&
            settled === true &&
            hiddenWithSections === true,
          JSON.stringify({ shown, onButton, boxOpenedByRightClick, stillIdle, pending, requests, settled, hiddenWithSections }),
        );
      }

      // The audio-unlock overlay stays above the box, and a right-click on it opens nothing.
      {
        await clearViews();
        await askAt(cdp, '#product-name');
        await evaluateExpr(cdp, "document.getElementById('audio-unlock-overlay').hidden = false");
        const detail = await evaluateExpr(
          cdp,
          `(() => {
            const box = document.getElementById('ask-box').getBoundingClientRect();
            const top = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
            const overlay = document.getElementById('audio-unlock-overlay');
            return { overlayOnTop: top === overlay || overlay.contains(top) };
          })()`,
        );
        await closeAsk();
        const onOverlay = await askAt(cdp, '#audio-unlock-overlay');
        await evaluateExpr(cdp, "document.getElementById('audio-unlock-overlay').hidden = true");
        await closeAsk();
        report(
          'the audio-unlock overlay stays above the box, and a right-click on it opens nothing',
          detail.overlayOnTop === true && onOverlay.prevented === false && onOverlay.open === false,
          JSON.stringify({ detail, onOverlay }),
        );
      }

      // At a 1280-pixel window the bar gives up text before it clips; the status and the transport button stay whole.
      {
        await sleep(1200);
        await askAt(cdp, '#product-name');
        await cdp('Input.insertText', { text: 'width check' });
        await pressKey(cdp, 'Enter');
        const waiting = await waitFor(cdp, statusText('Claude will see it on its next action'), 3000);
        const detail = {};
        try {
          await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
          // The page-requests status lives in the Session drawer; it is measured there, shown and whole in its card.
          await openDrawer(cdp);
          Object.assign(
            detail,
            await evaluateExpr(
              cdp,
              `(() => {
                const bar = document.getElementById('top-bar').getBoundingClientRect();
                const whole = (id) => {
                  const el = document.getElementById(id);
                  const r = el.getBoundingClientRect();
                  return el.scrollWidth <= el.clientWidth && r.left >= bar.left && r.right <= bar.right;
                };
                const drawerItem = ${DRAWER_ITEM_JS};
                const requests = drawerItem('page-requests');
                return {
                  statusWhole: whole('ask-status'),
                  stopWhole: whole(${JSON.stringify(TRANSPORT_ID)}),
                  pageRequestsShown: requests.shown,
                  pageRequestsWhole: requests.whole,
                  // The Shift + right-click title lives on the Session card's hint.
                  hintTitle: document.querySelector('[data-copy="rightClickHint"]').title,
                };
              })()`,
            ),
          );
        } finally {
          await cdp('Emulation.clearDeviceMetricsOverride');
          await sleep(300);
          await closeDrawer(cdp);
        }
        await callTool(client, 'get_code', {});
        report(
          'at a 1280-pixel window the bar gives up text before it clips; the status and the transport button stay whole',
          waiting === true &&
            detail.statusWhole === true &&
            detail.stopWhole === true &&
            detail.pageRequestsShown === true &&
            detail.pageRequestsWhole === true &&
            detail.hintTitle === "Shift + right-click keeps the browser's own menu.",
          JSON.stringify({ waiting, detail }),
        );
        // Nothing may linger for anything that follows.
        await waitFor(cdp, "document.getElementById('ask-status').hidden ? true : null", 6000);
        await clearViews();
      }
    }

    // --- The top-bar view and layout buttons, carried to the real buttons ---
    {
      const workspaceExpr = `document.getElementById('workspace').dataset`;
      const codeExpr = `document.getElementById('repl').editor.editor.state.doc.toString()`;
      const focusCode = async () => {
        await evaluateExpr(cdp, `document.querySelector('#editor-area .cm-content').focus()`);
        return evaluateExpr(cdp, `document.getElementById('editor-area').contains(document.activeElement)`);
      };
      const hintAttr = (key, attr) =>
        evaluateExpr(cdp, `document.querySelector('#view-buttons button[data-key="${key}"], #layout-buttons button[data-key="${key}"]').getAttribute('${attr}')`);
      try {
        await cdp('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
        await blurActive();
        if ((await evaluateExpr(cdp, `${workspaceExpr}.view`)) !== 'none') await pressKey(cdp, 'Escape');
        await pressKey(cdp, 'a');
        await blurActive();
        const codeBefore = await evaluateExpr(cdp, codeExpr);

        const focusedBeforeC = await focusCode();
        await clickElement(cdp, '#layout-buttons button[data-key="c"]');
        const layoutAfterC = await evaluateExpr(cdp, `${workspaceExpr}.layout`);
        const pressedAfterC = {
          a: await hintAttr('a', 'aria-pressed'),
          b: await hintAttr('b', 'aria-pressed'),
          c: await hintAttr('c', 'aria-pressed'),
        };

        const focusedBeforeOpen = await focusCode();
        await clickElement(cdp, '#view-buttons button[data-key="2"]');
        const viewAfterOpen = await evaluateExpr(cdp, `${workspaceExpr}.view`);
        const panelHiddenAfterOpen = await evaluateExpr(cdp, `document.getElementById('view-panel').hidden`);
        const pressedAfterOpen = { two: await hintAttr('2', 'aria-pressed'), one: await hintAttr('1', 'aria-pressed') };

        const focusedBeforeClose = await focusCode();
        await clickElement(cdp, '#view-buttons button[data-key="2"]');
        const viewAfterClose = await evaluateExpr(cdp, `${workspaceExpr}.view`);
        const afterClose = {
          twoPressed: await hintAttr('2', 'aria-pressed'),
          // The Esc closes button is gone: no element carries the Escape key any more.
          noEscapeButton: await evaluateExpr(cdp, `document.querySelector('[data-key="Escape"]') === null`),
          nonePressed: await evaluateExpr(cdp, `document.querySelectorAll('#view-buttons button[aria-pressed="true"]').length === 0`),
        };

        // The buttons are exactly the parts of page/views.js, in the order of the bar: six views, then the three layouts.
        const buttonLabels = await evaluateExpr(
          cdp,
          `[...document.querySelectorAll('#view-buttons button, #layout-buttons button')].map((b) => b.getAttribute('aria-label'))`,
        );
        const buttonKeys = await evaluateExpr(
          cdp,
          `[...document.querySelectorAll('#view-buttons button[data-key], #layout-buttons button[data-key]')].map((b) => b.dataset.key)`,
        );
        const codeAfter = await evaluateExpr(cdp, codeExpr);
        const expectedParts = [...viewButtonParts(), ...layoutButtonParts()];
        report(
          'a click on a top-bar button switches layout and view even while the code has focus',
          focusedBeforeC === true &&
            focusedBeforeOpen === true &&
            focusedBeforeClose === true &&
            layoutAfterC === 'c' &&
            viewAfterOpen === 'timeline' &&
            panelHiddenAfterOpen === false &&
            viewAfterClose === 'none' &&
            codeAfter === codeBefore &&
            JSON.stringify(buttonLabels) === JSON.stringify(expectedParts.map((part) => part.label)) &&
            JSON.stringify(buttonKeys) === JSON.stringify(expectedParts.map((part) => part.key)),
          JSON.stringify({
            focusedBeforeC,
            focusedBeforeOpen,
            focusedBeforeClose,
            layoutAfterC,
            viewAfterOpen,
            panelHiddenAfterOpen,
            viewAfterClose,
            codeUnchanged: codeAfter === codeBefore,
            buttonLabels,
            buttonKeys,
          }),
        );

        // Pressing the pressed view button closes the view (the Esc closes button of the old hint is this and the Esc key);
        // a mouse click leaves nothing focused, so the keys work at once.
        await clickElement(cdp, '#view-buttons button[data-key="4"]');
        const viewAfterParts = await evaluateExpr(cdp, `${workspaceExpr}.view`);
        await clickElement(cdp, '#view-buttons button[data-key="4"]');
        const viewAfterPressedAgain = await evaluateExpr(cdp, `${workspaceExpr}.view`);
        await clickElement(cdp, '#view-buttons button[data-key="4"]');
        const viewReopened = await evaluateExpr(cdp, `${workspaceExpr}.view`);
        await blurActive();
        await pressKey(cdp, 'Escape');
        const viewAfterEscape = await evaluateExpr(cdp, `${workspaceExpr}.view`);
        await clickElement(cdp, '#view-buttons button[data-key="4"]');
        const bodyFocusedAfterClick = await evaluateExpr(cdp, `document.activeElement === document.body`);
        await clickElement(cdp, '#view-buttons button[data-key="4"]');
        await pressKey(cdp, 'a');
        const layoutAfterKey = await evaluateExpr(cdp, `${workspaceExpr}.layout`);
        const aPressedAfterKey = await hintAttr('a', 'aria-pressed');
        const codeAfterKeys = await evaluateExpr(cdp, codeExpr);
        report(
          'the top-bar buttons show the current layout and view, a pressed view closes, and keys work after a click',
          pressedAfterC.a === 'false' &&
            pressedAfterC.b === 'false' &&
            pressedAfterC.c === 'true' &&
            pressedAfterOpen.two === 'true' &&
            pressedAfterOpen.one === 'false' &&
            afterClose.twoPressed === 'false' &&
            afterClose.noEscapeButton === true &&
            afterClose.nonePressed === true &&
            viewAfterParts === 'parts' &&
            viewAfterPressedAgain === 'none' &&
            viewReopened === 'parts' &&
            viewAfterEscape === 'none' &&
            bodyFocusedAfterClick === true &&
            layoutAfterKey === 'a' &&
            aPressedAfterKey === 'true' &&
            codeAfterKeys === codeBefore,
          JSON.stringify({
            pressedAfterC,
            pressedAfterOpen,
            afterClose,
            viewAfterParts,
            viewAfterPressedAgain,
            viewReopened,
            viewAfterEscape,
            bodyFocusedAfterClick,
            layoutAfterKey,
            aPressedAfterKey,
            codeUnchanged: codeAfterKeys === codeBefore,
          }),
        );

        // One line at 1080p, and the bar gives up the names of its unselected views before anything else of the buttons.
        const barState = () =>
          evaluateExpr(
            cdp,
            `(() => {
              const bar = document.getElementById('top-bar');
              const barBox = bar.getBoundingClientRect();
              const buttons = [...document.querySelectorAll('#view-buttons button, #layout-buttons button')];
              const inside = (id) => {
                const r = document.getElementById(id).getBoundingClientRect();
                return r.left >= barBox.left && r.right <= barBox.right;
              };
              // The motion switch and the page-requests status live in the Session drawer (open for this read);
              // they must be shown, whole in their card, and on their lines (the switch on one line, the status on at most two).
              const drawerItem = ${DRAWER_ITEM_JS};
              const motion = drawerItem('motion-switch');
              const requests = drawerItem('page-requests');
              const fit = Number(bar.dataset.fit);
              const names = [...document.querySelectorAll('#view-buttons button[aria-pressed="false"] .view-name')];
              const digits = [...document.querySelectorAll('#view-buttons .view-digit')];
              return {
                fit,
                barFits: bar.scrollWidth <= bar.clientWidth,
                // No button wraps onto a second line: none is taller than the bar.
                noWrap: buttons.length === 9 && buttons.every((b) => b.getBoundingClientRect().height <= barBox.height + 1),
                // From step 2 on the unselected names are gone and the digits stay; each button keeps digit and name in its accessible name.
                namesGoAtStep2: fit < 2 || names.every((n) => getComputedStyle(n).display === 'none'),
                namesShownBeforeStep2: fit >= 2 || names.every((n) => getComputedStyle(n).display !== 'none'),
                digitsStay: digits.length === 6 && digits.every((d) => d.getBoundingClientRect().width > 0),
                namesKept: [...document.querySelectorAll('#view-buttons button')].every((b) => b.getAttribute('aria-label').startsWith(b.querySelector('.view-digit').textContent + ' ') && b.getAttribute('aria-label').endsWith(b.querySelector('.view-name').textContent)),
                motionShown: motion.shown,
                motionInside: motion.whole,
                stopInside: inside(${JSON.stringify(TRANSPORT_ID)}),
                // Each control stays on its lines: Stop is no taller than the bar, the motion switch is one line, the status at most two.
                controlsOneLine:
                  document.getElementById(${JSON.stringify(TRANSPORT_ID)}).getBoundingClientRect().height <= barBox.height &&
                  motion.lines <= 1 &&
                  requests.lines <= 2,
                // The page-requests status stays whole.
                pageRequestsShown: requests.shown,
                pageRequestsInside: requests.whole,
                pageRequestsWhole: requests.whole,
                pageRequestsWidth: requests.width,
              };
            })()`,
          );
        await openDrawer(cdp);
        const wide = await barState();
        // The hit area: every button is at least 24 x 24 CSS pixels (stricter than the old padded hint buttons), its edges
        // hit the button and not a neighbour, and nothing in the bar moves when the selected view changes (the selection is a
        // fill and a ring, never a width).
        const hitArea = await evaluateExpr(
          cdp,
          `(() => {
            const buttons = [...document.querySelectorAll('#view-buttons button, #layout-buttons button')];
            const session = document.getElementById('session-button');
            const sizes = buttons.map((button) => { const r = button.getBoundingClientRect(); return [Math.round(r.width * 10) / 10, Math.round(r.height * 10) / 10]; });
            const lefts = () => [...buttons.map((button) => button.getBoundingClientRect().left), session.getBoundingClientRect().left];
            const hitAt = (button, edge) => {
              const box = button.getBoundingClientRect();
              const x = edge === 'left' ? box.left + 1 : box.right - 1;
              return document.elementFromPoint(x, box.top + box.height / 2) === button || button.contains(document.elementFromPoint(x, box.top + box.height / 2));
            };
            return { sizes, lefts: lefts(), firstLeftHit: hitAt(buttons[0], 'left'), lastRightHit: hitAt(buttons[buttons.length - 1], 'right'), count: buttons.length };
          })()`,
        );
        await pressKey(cdp, '3');
        const leftsWithMixer = await evaluateExpr(
          cdp,
          `[...document.querySelectorAll('#view-buttons button, #layout-buttons button'), document.getElementById('session-button')].map((el) => el.getBoundingClientRect().left)`,
        );
        await pressKey(cdp, '3');
        const shift = Math.max(...hitArea.lefts.map((left, i) => Math.abs(left - leftsWithMixer[i])));
        // A common laptop-ish width where the controls used to wrap (motion switch on two lines).
        // The fit step follows a width change through a ResizeObserver, so each new width gets time to settle before it is read.
        await cdp('Emulation.setDeviceMetricsOverride', { width: 1024, height: 768, deviceScaleFactor: 1, mobile: false });
        await sleep(300);
        const mid = await barState();
        await cdp('Emulation.setDeviceMetricsOverride', { width: 640, height: 800, deviceScaleFactor: 1, mobile: false });
        await sleep(300);
        const narrow = await barState();
        report(
          'the top-bar buttons are at least 24x24 with a hit area to their edges and nothing in the bar moves',
          hitArea.count === 9 &&
            hitArea.sizes.every(([width, height]) => width >= 24 && height >= 24) &&
            shift <= 0.5 &&
            hitArea.firstLeftHit === true &&
            hitArea.lastRightHit === true,
          JSON.stringify({ hitArea, shift }),
        );
        report(
          'with buttons, the bar stays one line and gives up the names of its unselected views first (step 2)',
          wide.barFits === true &&
            wide.noWrap === true &&
            wide.motionShown === true &&
            wide.motionInside === true &&
            wide.stopInside === true &&
            wide.controlsOneLine === true &&
            wide.namesGoAtStep2 === true &&
            wide.namesShownBeforeStep2 === true &&
            wide.digitsStay === true &&
            wide.namesKept === true &&
            mid.controlsOneLine === true &&
            mid.barFits === true &&
            mid.namesGoAtStep2 === true &&
            mid.namesShownBeforeStep2 === true &&
            mid.namesKept === true &&
            wide.pageRequestsShown === true &&
            wide.pageRequestsInside === true &&
            wide.pageRequestsWhole === true &&
            narrow.pageRequestsShown === true &&
            narrow.pageRequestsInside === true &&
            narrow.pageRequestsWhole === true &&
            // At 640 px the bar is far narrower than the 1024 px guarantee: every step is used, the names are gone, the digits stay.
            narrow.fit >= 2 &&
            narrow.namesGoAtStep2 === true &&
            narrow.digitsStay === true &&
            narrow.namesKept === true &&
            narrow.noWrap === true &&
            // At 640 px the bar is outside the guarantee of the bar (1024 px and up), so only the transport button and
            // the one-line controls are pinned here.
            narrow.stopInside === true &&
            narrow.controlsOneLine === true,
          JSON.stringify({ wide, mid, narrow }),
        );
      } finally {
        await cdp('Emulation.clearDeviceMetricsOverride');
        await sleep(300);
        await closeDrawer(cdp);
        await blurActive();
        if ((await evaluateExpr(cdp, `${workspaceExpr}.view`)) !== 'none') await pressKey(cdp, 'Escape');
        await pressKey(cdp, 'a');
        await blurActive();
      }
    }

    // --- Page requests status ---
    {
      const stopAllListeners = async () => {
        for (const child of spawnedListeners) {
          if (child.exitCode === null && child.signalCode === null) {
            const exited = new Promise((resolve) => child.once('exit', resolve));
            child.kill();
            await exited;
          }
        }
      };
      const stateIs = (wanted) =>
        `(() => {
          const box = document.getElementById('page-requests');
          const state = document.getElementById('page-requests-state');
          return !box.hidden && state.textContent === ${JSON.stringify(wanted)} ? true : null;
        })()`;
      const readStatus = () =>
        evaluateExpr(
          cdp,
          `(() => {
            const box = document.getElementById('page-requests');
            const state = document.getElementById('page-requests-state');
            const meta = document.querySelector('meta[name="moontide-page-token"]');
            return {
              stateColor: getComputedStyle(state).color,
              // The resolved --text-muted color (a muted rule on the box itself loses to #top-bar > span).
              mutedColor: (() => {
                const probe = document.createElement('span');
                probe.style.color = 'var(--text-muted)';
                document.body.appendChild(probe);
                const color = getComputedStyle(probe).color;
                probe.remove();
                return color;
              })(),
              hasAccent: box.hasAttribute('data-accent') || state.hasAttribute('data-accent'),
              text: state.textContent,
              boxText: box.textContent,
              pageToken: meta ? meta.getAttribute('content') : null,
            };
          })()`,
        );

      // The Ask Claude section may have left a listener running: the status must start from none.
      await stopAllListeners();
      const waitingAtStart = await waitFor(cdp, stateIs(PAGE_REQUESTS_COPY.waiting), 3000);
      const atStart = await readStatus();

      const armed = await callTool(client, 'get_code', {});
      const listener = spawnListener(armed);
      const liveAfterConnect = listener === null ? null : await waitFor(cdp, stateIs(PAGE_REQUESTS_COPY.live), 3000);
      const whileLive = await readStatus();
      let listenerToken = null;
      if (listener !== null) {
        listenerToken = /node '[^']+' \d+ ([0-9a-f]{64})/.exec(armed)[1];
        listener.child.kill();
        await listener.exited;
      }
      const waitingAfterDrop = await waitFor(cdp, stateIs(PAGE_REQUESTS_COPY.waiting), 3000);
      const afterDrop = await readStatus();

      const clean = (read) =>
        read.stateColor === read.mutedColor &&
        read.hasAccent === false &&
        !/listen/i.test(read.boxText) &&
        typeof read.pageToken === 'string' &&
        read.pageToken.length === 64 &&
        !read.boxText.includes(read.pageToken) &&
        (listenerToken === null || !read.boxText.includes(listenerToken));
      report(
        'the top bar shows whether page requests are live and follows a monitor connecting and dropping',
        waitingAtStart === true &&
          listener !== null &&
          liveAfterConnect === true &&
          waitingAfterDrop === true &&
          atStart.text === PAGE_REQUESTS_COPY.waiting &&
          whileLive.text === PAGE_REQUESTS_COPY.live &&
          afterDrop.text === PAGE_REQUESTS_COPY.waiting &&
          clean(atStart) &&
          clean(whileLive) &&
          clean(afterDrop),
        JSON.stringify({
          waitingAtStart,
          listenerStarted: listener !== null,
          liveAfterConnect,
          waitingAfterDrop,
          atStart: { ...atStart, pageToken: undefined },
          whileLive: { ...whileLive, pageToken: undefined },
          afterDrop: { ...afterDrop, pageToken: undefined },
        }),
      );
      await stopAllListeners();

      // The (i): a real button that opens a short explanation naming both commands; Escape, a click
      // elsewhere or a second click closes it; Escape never closes the open view.
      {
        const workspaceView = () => evaluateExpr(cdp, `document.getElementById('workspace').dataset.view`);
        const infoState = () =>
          evaluateExpr(
            cdp,
            `(() => {
              const info = document.getElementById('page-requests-info');
              const help = document.getElementById('page-requests-help');
              const active = document.activeElement;
              return {
                expanded: info.getAttribute('aria-expanded'),
                hidden: help.hidden,
                active: active ? active.id || active.tagName : null,
                focusInside: help.contains(active),
                view: document.getElementById('workspace').dataset.view,
              };
            })()`,
          );
        await blurActive();
        if ((await workspaceView()) !== 'none') await pressKey(cdp, 'Escape');
        await pressKey(cdp, '2');
        const openView = await workspaceView();
        const button = await evaluateExpr(
          cdp,
          `(() => {
            const info = document.getElementById('page-requests-info');
            return {
              tag: info.tagName,
              type: info.type,
              expanded: info.getAttribute('aria-expanded'),
              controls: info.getAttribute('aria-controls'),
              label: info.getAttribute('aria-label'),
              title: info.title,
              text: info.textContent,
              helpRole: document.getElementById('page-requests-help').getAttribute('role'),
            };
          })()`,
        );
        // The (i) lives in the Session drawer's Page requests card, so the drawer opens first.
        await openDrawer(cdp);
        await clickElement(cdp, '#page-requests-info');
        await sleep(100);
        const afterClick = await infoState();
        const helpText = await evaluateExpr(cdp, `document.getElementById('page-requests-help').textContent`);
        const helpParagraphs = await evaluateExpr(cdp, `document.querySelectorAll('#page-requests-help p').length`);
        await pressKey(cdp, 'Escape');
        await sleep(100);
        const afterEscape = await infoState();
        await pressKey(cdp, 'Enter');
        await sleep(100);
        const afterEnter = await infoState();
        await clickElement(cdp, '#product-name');
        await sleep(200);
        const afterOutside = await infoState();
        // The press outside closed the drawer too; it opens again for the (i). The second click is made in a 1920-pixel
        // window: below about 1000 px the open popover (anchored at the right, under the bar) floats over the (i) that
        // opened it, so there Esc or a click elsewhere closes it and a second click lands on the popover itself.
        await cdp('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
        await sleep(300);
        await openDrawer(cdp);
        await clickElement(cdp, '#page-requests-info');
        await sleep(100);
        const afterFirst = await infoState();
        await clickElement(cdp, '#page-requests-info');
        await sleep(200);
        const afterSecond = await infoState();
        await cdp('Emulation.clearDeviceMetricsOverride');
        await sleep(300);
        await closeDrawer(cdp);
        await blurActive();
        if ((await workspaceView()) !== 'none') await pressKey(cdp, 'Escape');
        const viewAfterCleanup = await workspaceView();
        report(
          'the page-requests (i) opens with both commands and closes with Escape, a click elsewhere or a second click, keeping the open view',
          openView !== 'none' &&
            button.tag === 'BUTTON' &&
            button.type === 'button' &&
            button.expanded === 'false' &&
            button.controls === 'page-requests-help' &&
            button.label === PAGE_REQUESTS_COPY.infoLabel &&
            button.helpRole === 'dialog' &&
            afterClick.expanded === 'true' &&
            afterClick.hidden === false &&
            afterClick.focusInside === true &&
            helpText.includes(PAGE_REQUESTS_COPY.onCommand) &&
            helpText.includes(PAGE_REQUESTS_COPY.offCommand) &&
            helpText.includes(PAGE_REQUESTS_COPY.appText) &&
            helpText.includes(PAGE_REQUESTS_COPY.monitorText) &&
            helpParagraphs === 4 &&
            afterEscape.expanded === 'false' &&
            afterEscape.hidden === true &&
            afterEscape.active === 'page-requests-info' &&
            afterEscape.view === openView &&
            afterEnter.expanded === 'true' &&
            afterEnter.hidden === false &&
            afterEnter.focusInside === true &&
            afterOutside.expanded === 'false' &&
            afterOutside.hidden === true &&
            afterOutside.view === openView &&
            afterFirst.hidden === false &&
            afterSecond.expanded === 'false' &&
            afterSecond.hidden === true &&
            viewAfterCleanup === 'none',
          JSON.stringify({
            openView,
            button,
            afterClick,
            helpText,
            helpParagraphs,
            afterEscape,
            afterEnter,
            afterOutside,
            afterFirst,
            afterSecond,
            viewAfterCleanup,
          }),
        );
      }

      // The popover shows all of its text at the usual size and in a short window, and scrolls instead
      // of being cut off in a very short one (max-height). Sizes are put back with the override cleared.
      {
        const measurePopover = () =>
          evaluateExpr(
            cdp,
            `(() => {
              const help = document.getElementById('page-requests-help');
              const box = help.getBoundingClientRect();
              return {
                hidden: help.hidden,
                scrollHeight: help.scrollHeight,
                clientHeight: help.clientHeight,
                bottom: Math.round(box.bottom),
                innerHeight: window.innerHeight,
              };
            })()`,
          );
        const fits = {};
        try {
          // The (i) lives in the Session drawer, which stays open across the three window sizes.
          await openDrawer(cdp);
          for (const [name, size] of [
            ['usual', null],
            ['1280x480', { width: 1280, height: 480 }],
            ['1280x300', { width: 1280, height: 300 }],
          ]) {
            if (size !== null) {
              await cdp('Emulation.setDeviceMetricsOverride', { ...size, deviceScaleFactor: 1, mobile: false });
              await sleep(100);
            }
            await clickElement(cdp, '#page-requests-info');
            await sleep(100);
            fits[name] = await measurePopover();
            // Esc closes it (focus is inside): in a narrow window the open popover covers its own (i).
            await pressKey(cdp, 'Escape');
            await sleep(100);
          }
        } finally {
          await cdp('Emulation.clearDeviceMetricsOverride');
          await sleep(300);
          await closeDrawer(cdp);
        }
        const shownWhole = (m) => m.hidden === false && m.scrollHeight <= m.clientHeight + 1 && m.bottom <= m.innerHeight;
        report(
          'the page-requests popover fits the window',
          shownWhole(fits.usual) &&
            shownWhole(fits['1280x480']) &&
            fits['1280x300'].hidden === false &&
            fits['1280x300'].bottom <= fits['1280x300'].innerHeight,
          JSON.stringify(fits),
        );
        await blurActive();
        if ((await evaluateExpr(cdp, `document.getElementById('workspace').dataset.view`)) !== 'none') await pressKey(cdp, 'Escape');
      }

      // page-requests-on from a real MCP client drives the page. Never page-requests-off in this probe:
      // it would pause the arming line that later checks read from tool replies.
      {
        const promptText = async () => {
          const result = await client.getPrompt({ name: 'page-requests-on' });
          return result.messages.map((message) => message.content.text).join('\n');
        };
        const onText = await promptText();
        const onListener = spawnListener(onText);
        const onToken = /node '[^']+' \d+ ([0-9a-f]{64})/.exec(onText)?.[1] ?? null;
        const liveFromPrompt = onListener === null ? null : await waitFor(cdp, stateIs(PAGE_REQUESTS_COPY.live), 3000);
        const alreadyOn = await promptText();
        const pageTexts = async () =>
          evaluateExpr(
            cdp,
            `(() => {
              const info = document.getElementById('page-requests-info');
              const meta = document.querySelector('meta[name="moontide-page-token"]');
              return {
                texts: [
                  document.getElementById('page-requests').textContent,
                  document.getElementById('page-requests-help').textContent,
                  info.getAttribute('aria-label'),
                  info.title,
                ],
                pageToken: meta ? meta.getAttribute('content') : null,
              };
            })()`,
          );
        const whileLive = await pageTexts();
        if (onListener !== null) {
          onListener.child.kill();
          await onListener.exited;
        }
        const waitingAgain = await waitFor(cdp, stateIs(PAGE_REQUESTS_COPY.waiting), 3000);
        const afterDrop = await pageTexts();
        const cleanTexts = (read) =>
          typeof read.pageToken === 'string' &&
          read.pageToken.length === 64 &&
          read.texts.every(
            (text) =>
              typeof text === 'string' &&
              !/listen/i.test(text) &&
              !text.includes(read.pageToken) &&
              (onToken === null || !text.includes(onToken)),
          );
        report(
          'page-requests-on from a real MCP client makes the page status live, and the page never shows the word listen or a token',
          onListener !== null &&
            onToken !== null &&
            liveFromPrompt === true &&
            !alreadyOn.includes('node ') &&
            waitingAgain === true &&
            cleanTexts(whileLive) &&
            cleanTexts(afterDrop),
          JSON.stringify({
            listenerStarted: onListener !== null,
            liveFromPrompt,
            alreadyOnHasCommand: alreadyOn.includes('node '),
            waitingAgain,
            whileLive: whileLive.texts,
            afterDrop: afterDrop.texts,
          }),
        );
        await stopAllListeners();
      }

      // set_page_requests from a real MCP client drives the page status both ways. The last call is on
      // again (no monitor started): the later checks read the arming line from tool replies, and the
      // switch must not stay paused.
      {
        const firstLine = (text) => text.split('\n')[0];
        const onText = await callTool(client, 'set_page_requests', { state: 'on' });
        const toolListener = spawnListener(onText);
        const liveFromTool = toolListener === null ? null : await waitFor(cdp, stateIs(PAGE_REQUESTS_COPY.live), 3000);
        const offText = await callTool(client, 'set_page_requests', { state: 'off' });
        if (toolListener !== null) {
          toolListener.child.kill();
          await toolListener.exited;
        }
        const waitingFromTool = await waitFor(cdp, stateIs(PAGE_REQUESTS_COPY.waiting), 3000);
        const onAgainText = await callTool(client, 'set_page_requests', { state: 'on' });
        report(
          'set_page_requests from a real MCP client switches the page status',
          toolListener !== null &&
            liveFromTool === true &&
            offText.includes('TaskStop') &&
            !/[0-9a-f]{64}/.test(offText) &&
            waitingFromTool === true &&
            /node '[^']+' \d+ [0-9a-f]{64}/.test(onAgainText),
          JSON.stringify({
            liveFromTool,
            waitingFromTool,
            onFirstLine: firstLine(onText),
            offFirstLine: firstLine(offText),
            onAgainFirstLine: firstLine(onAgainText),
          }),
        );
        await stopAllListeners();
      }

      // At 1920x1080 the whole top bar fits on one line, with a waiting request status showing.
      {
        await sleep(1200);
        await askAt(cdp, '#product-name');
        await cdp('Input.insertText', { text: 'fit check' });
        await pressKey(cdp, 'Enter');
        const requestWaiting = await waitFor(cdp, statusText('Claude will see it on its next action'), 3000);
        const fit = {};
        try {
          await cdp('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
          await sleep(100);
          // The page-requests status and its (i) live in the Session drawer; they are measured there, shown and whole.
          await openDrawer(cdp);
          Object.assign(
            fit,
            await evaluateExpr(
              cdp,
              `(() => {
                const bar = document.getElementById('top-bar');
                const barBox = bar.getBoundingClientRect();
                const inside = (el) => {
                  const r = el.getBoundingClientRect();
                  return r.left >= barBox.left && r.right <= barBox.right && r.top >= barBox.top && r.bottom <= barBox.bottom;
                };
                const whole = (id) => {
                  const el = document.getElementById(id);
                  return !el.hidden && el.scrollWidth <= el.clientWidth && inside(el);
                };
                const drawerItem = ${DRAWER_ITEM_JS};
                const requests = drawerItem('page-requests');
                const requestsInfo = drawerItem('page-requests-info');
                const views = document.getElementById('view-buttons');
                const layout = document.getElementById('layout-buttons');
                const sixButton = views.querySelector('button[data-key="6"]');
                return {
                  barFits: bar.scrollWidth <= bar.clientWidth,
                  hintWhole: [views, layout].every((group) => group.scrollWidth <= group.clientWidth && inside(group)),
                  fitStep: bar.dataset.fit,
                  viewTexts: [...views.querySelectorAll('button')].map((button) => button.textContent),
                  sixText: sixButton === null ? null : sixButton.textContent,
                  sixInsideHint: (() => {
                    if (sixButton === null) return false;
                    const sixBox = sixButton.getBoundingClientRect();
                    const groupBox = views.getBoundingClientRect();
                    return sixBox.left >= groupBox.left && sixBox.right <= groupBox.right && sixBox.width > 0;
                  })(),
                  pageRequestsShown: requests.shown && requestsInfo.shown,
                  pageRequestsWhole: requests.whole && requests.lines <= 1,
                  askStatusWhole: whole('ask-status'),
                  infoInside: requestsInfo.whole,
                  stateText: document.getElementById('page-requests-state').textContent,
                  widths: {
                    bar: barBox.width,
                    views: views.getBoundingClientRect().width,
                    pageRequests: requests.width,
                    askStatus: document.getElementById('ask-status').getBoundingClientRect().width,
                  },
                };
              })()`,
            ),
          );
        } finally {
          await cdp('Emulation.clearDeviceMetricsOverride');
          await sleep(300);
          await closeDrawer(cdp);
        }
        await callTool(client, 'get_code', {});
        report(
          'at 1920x1080 the top bar holds the view and layout buttons whole, the request status and the page-requests status with its (i), on one line',
          requestWaiting === true &&
            fit.barFits === true &&
            fit.hintWhole === true &&
            fit.pageRequestsShown === true &&
            fit.pageRequestsWhole === true &&
            fit.askStatusWhole === true &&
            fit.infoInside === true &&
            fit.stateText === PAGE_REQUESTS_COPY.waiting,
          JSON.stringify({ requestWaiting, fit }),
        );
        // With the sixth view the hint still ends as written and the 6 Instruments button is whole inside it.
        report(
          'instruments view: the view buttons, 6 Instruments included, are visible and whole at 1920x1080',
          requestWaiting === true &&
            fit.hintWhole === true &&
            fit.sixInsideHint === true &&
            // At 1920 the bar needs no step: every name is shown, so the button text is the digit and the name.
            fit.fitStep === '0' &&
            fit.sixText === '6Instruments' &&
            JSON.stringify(fit.viewTexts) === JSON.stringify(viewButtonParts().map((part) => `${part.digit}${part.name}`)),
          JSON.stringify({ requestWaiting, hintWhole: fit.hintWhole, sixInsideHint: fit.sixInsideHint, sixText: fit.sixText, viewTexts: fit.viewTexts, fitStep: fit.fitStep }),
        );
        await waitFor(cdp, "document.getElementById('ask-status').hidden ? true : null", 6000);
        await blurActive();
      }
      await stopAllListeners();
    }

    // --- Jam ---
    {
      const askBoxOpen = () => evaluateExpr(cdp, "!document.getElementById('ask-box').hidden");
      const closeAsk = async () => {
        if (await askBoxOpen()) await pressKey(cdp, 'Escape');
        await waitFor(cdp, "document.getElementById('ask-box').hidden ? true : null", 2000);
      };
      const blurActive = () =>
        evaluateExpr(cdp, `(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); })()`);
      // Leaves the page with no view open and no focus in a field, so the next key press is a view key.
      const clearViews = async () => {
        await closeAsk();
        await blurActive();
        if ((await evaluateExpr(cdp, "document.getElementById('workspace').dataset.view")) !== 'none') await pressKey(cdp, 'Escape');
        await blurActive();
      };
      const JAM_DORIAN_PROGRAM = ['bass: note("d2").gain(0)', 'lead: n("0 1 2 3 4 5 6 7").scale("D:dorian").gain(0)'].join('\n');
      const jamReply = await callTool(client, 'set_code', { code: JAM_DORIAN_PROGRAM, label: 'probe jam dorian' });
      const jamEvaluated = !/runtime error/i.test(jamReply);
      await clearViews();
      await pressKey(cdp, 'a');
      await pressKey(cdp, '5');
      const jamReady = await waitFor(
        cdp,
        `document.getElementById('jam-view').dataset.state === 'ready' && document.getElementById('jam-scale-name').textContent === 'D Dorian' ? true : null`,
        6000,
      );
      const jamChips = await evaluateExpr(
        cdp,
        `[...document.querySelectorAll('#jam-degrees .jam-degree')].map((chip) => ({
          note: chip.querySelector('.jam-degree-note').textContent,
          degree: chip.querySelector('.jam-degree-num').textContent,
          role: chip.dataset.role,
        }))`,
      );
      const jamNotes = jamChips.map((chip) => chip.note);
      const jamDegrees = jamChips.map((chip) => chip.degree);
      const jamRoles = jamChips.map((chip) => chip.role);
      report(
        'key 5 opens Jam and names the scale of the playing code with its seven degrees',
        jamEvaluated &&
          jamReady === true &&
          JSON.stringify(jamNotes) === JSON.stringify(['D', 'E', 'F', 'G', 'A', 'B', 'C']) &&
          JSON.stringify(jamDegrees) === JSON.stringify(['1', '2', '♭3', '4', '5', '6', '♭7']) &&
          JSON.stringify(jamRoles) === JSON.stringify(['root', 'scale', 'scale', 'scale', 'scale', 'scale', 'scale']),
        JSON.stringify({ jamEvaluated, jamReady, jamNotes, jamDegrees, jamRoles }),
      );

      // Jam then the Timeline: the same page, read once. A page turn between the two reads repeats the check once.
      const readBoth = async () => {
        const jam = await waitFor(
          cdp,
          `(() => { const v = document.getElementById('jam-view'); return v.dataset.state === 'ready' && v.dataset.computeMs ? { pageStart: v.dataset.pageStart, computeMs: v.dataset.computeMs } : null; })()`,
          6000,
        );
        await pressKey(cdp, '2');
        const timeline = await waitFor(
          cdp,
          `(() => { const v = document.getElementById('timeline-view'); return v.dataset.state === 'ok' ? { pageStart: v.dataset.pageStart, computeMs: v.dataset.computeMs } : null; })()`,
          8000,
        );
        return { jam, timeline };
      };
      let both = await readBoth();
      const same = (pair) =>
        pair.jam !== null &&
        pair.timeline !== null &&
        pair.jam.pageStart === pair.timeline.pageStart &&
        pair.jam.computeMs === pair.timeline.computeMs;
      let attempts = 1;
      if (!same(both) && both.jam !== null && both.timeline !== null && both.jam.pageStart !== both.timeline.pageStart) {
        await pressKey(cdp, '5');
        both = await readBoth();
        attempts = 2;
      }
      report(
        'the Timeline opened after Jam reuses the same reading',
        same(both),
        JSON.stringify({ both, attempts }),
      );

      // 5 twice from the Timeline: opens Jam, then closes it.
      await pressKey(cdp, '5');
      const jamOpenedAgain = await waitFor(cdp, `document.getElementById('jam-view').hidden ? null : true`, 3000);
      await pressKey(cdp, '5');
      const jamClosed = await evaluateExpr(
        cdp,
        `({ hidden: document.getElementById('jam-view').hidden, view: document.getElementById('workspace').dataset.view })`,
      );
      report(
        'key 5 again closes the Jam view',
        jamOpenedAgain === true && jamClosed.hidden === true && jamClosed.view === 'none',
        JSON.stringify({ jamOpenedAgain, jamClosed }),
      );
      await clearViews();
    }

    // --- Jam: scale states ---
    {
      const askBoxOpen = () => evaluateExpr(cdp, "!document.getElementById('ask-box').hidden");
      const closeAsk = async () => {
        if (await askBoxOpen()) await pressKey(cdp, 'Escape');
        await waitFor(cdp, "document.getElementById('ask-box').hidden ? true : null", 2000);
      };
      const blurActive = () =>
        evaluateExpr(cdp, `(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); })()`);
      const clearViews = async () => {
        await closeAsk();
        await blurActive();
        if ((await evaluateExpr(cdp, "document.getElementById('workspace').dataset.view")) !== 'none') await pressKey(cdp, 'Escape');
        await blurActive();
      };
      const scaleFacts = `(() => {
        const name = document.getElementById('jam-scale-name');
        return {
          state: document.getElementById('jam-view').dataset.state,
          kind: name.dataset.kind,
          name: name.textContent,
          sub: document.getElementById('jam-scale-sub').textContent,
          degreesHidden: document.getElementById('jam-degrees').hidden,
        };
      })()`;

      // A tie: the four-pad loop fits several scales equally, so the view says so and draws no degrees.
      await clearViews();
      await pressKey(cdp, 'a');
      await pressKey(cdp, '5');
      const tieReply = await callTool(client, 'set_code', {
        code: 'pads: note("<[a3,c4,e4] [f3,a3,c4] [c4,e4,g4] [g3,b3,d4]>").gain(0)',
        label: 'probe jam tie',
      });
      const tieFacts = await waitFor(
        cdp,
        `(() => { const f = ${scaleFacts}; return f.kind === 'ambiguous' ? f : null; })()`,
        6000,
      );
      report(
        'an ambiguous reading says so plainly and draws no degrees',
        !/runtime error/i.test(tieReply) &&
          tieFacts !== null &&
          tieFacts.name.startsWith('No clear scale: the notes fit ') &&
          tieFacts.name.includes('C major') &&
          tieFacts.name.endsWith(' equally.') &&
          tieFacts.sub === 'Warnings are off until the scale is clear.' &&
          tieFacts.degreesHidden === true,
        JSON.stringify(tieFacts),
      );

      // Drums only: nothing pitched to read.
      await callTool(client, 'set_code', { code: 'drums: s("bd*4").gain(0)', label: 'probe jam drums' });
      const drumsFacts = await waitFor(
        cdp,
        `(() => {
          const message = document.getElementById('jam-message');
          if (message.hidden || document.getElementById('jam-message-text').textContent !== 'No notes to read: the playing code has no pitched notes.') return null;
          return {
            text: document.getElementById('jam-message-text').textContent,
            sub: document.getElementById('jam-message-sub').textContent,
            subHidden: document.getElementById('jam-message-sub').hidden,
            bodyHidden: document.getElementById('jam-body').hidden,
          };
        })()`,
        6000,
      );
      report(
        'a drums-only pattern says there are no notes to read',
        drumsFacts !== null &&
          drumsFacts.sub === 'Only notes with a pitch count; drums are ignored.' &&
          drumsFacts.subHidden === false &&
          drumsFacts.bodyHidden === true,
        JSON.stringify(drumsFacts),
      );

      // Parts: the scale follows the part that plays (4 cycles each at one cycle per second).
      const JAM_PARTS_PROGRAM = [
        'setcps(1)',
        'const calm = n("0 1 2 3 4 5 6 7").scale("D:dorian").gain(0)',
        'const bright = n("0 1 2 3 4 5 6 7").scale("E:harmonic:minor").gain(0)',
        'bass: note("<d2!4 e2!4>").gain(0)',
        'lead: arrange([4, calm], [4, bright])',
      ].join('\n');
      const partsReply = await callTool(client, 'set_code', { code: JAM_PARTS_PROGRAM, label: 'probe jam parts' });
      const seen = { calm: null, bright: null };
      const partsDeadline = Date.now() + 12000;
      while ((seen.calm === null || seen.bright === null) && Date.now() < partsDeadline) {
        const facts = await evaluateExpr(cdp, scaleFacts);
        if (facts.name === 'D Dorian' && facts.sub === 'Part "calm" · read from this part') seen.calm = facts;
        if (facts.name === 'E harmonic minor' && facts.sub === 'Part "bright" · read from this part') seen.bright = facts;
        if (seen.calm === null || seen.bright === null) await sleep(250);
      }
      report(
        'the scale follows the part that is playing',
        !/runtime error/i.test(partsReply) && seen.calm !== null && seen.bright !== null,
        JSON.stringify(seen),
      );

      // Leave the default tempo behind so nothing after this block depends on a changed one.
      await callTool(client, 'set_code', { code: 'setcps(0.5)', label: 'probe jam reset tempo' });
      await clearViews();
    }

    // --- Jam: the status line ---
    {
      const askBoxOpen = () => evaluateExpr(cdp, "!document.getElementById('ask-box').hidden");
      const closeAsk = async () => {
        if (await askBoxOpen()) await pressKey(cdp, 'Escape');
        await waitFor(cdp, "document.getElementById('ask-box').hidden ? true : null", 2000);
      };
      const blurActive = () =>
        evaluateExpr(cdp, `(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); })()`);
      const clearViews = async () => {
        await closeAsk();
        await blurActive();
        if ((await evaluateExpr(cdp, "document.getElementById('workspace').dataset.view")) !== 'none') await pressKey(cdp, 'Escape');
        await blurActive();
      };
      const statusFacts = `(() => {
        const box = document.getElementById('jam-status');
        const time = document.getElementById('jam-status-time');
        const avoidChip = document.querySelector('#jam-degrees .jam-degree[data-note="C"]');
        return {
          hidden: box.hidden,
          state: box.dataset.state ?? null,
          warning: box.getAttribute('data-warning'),
          tabindex: box.getAttribute('tabindex'),
          lead: document.getElementById('jam-status-lead').textContent,
          rest: document.getElementById('jam-status-rest').textContent,
          time: time.textContent,
          timeHidden: time.hidden,
          timeAriaHidden: time.getAttribute('aria-hidden'),
          timeTitle: time.title,
          chipRole: avoidChip ? avoidChip.dataset.role : null,
        };
      })()`;
      // Neutral, silent, eight-cycle loop at one cycle per second: a D pedal, a pad (Dm7, with an A7 on
      // cycles 2 and 3 of each eight) and an eighth-note D Dorian melody.
      const JAM_WARNING_PROGRAM = [
        'setcps(1)',
        'bass: note("d2").gain(0)',
        'pad: note("<[d3,f3,a3,c4]!2 [a2,c#3,e3,g3]!2 [d3,f3,a3,c4]!4>").gain(0)',
        'lead: n("0 1 2 3 4 5 6 7").scale("D:dorian").gain(0)',
      ].join('\n');
      const warnReply = await callTool(client, 'set_code', { code: JAM_WARNING_PROGRAM, label: 'probe jam warning' });
      await clearViews();
      await pressKey(cdp, 'a');
      await pressKey(cdp, '5');
      const warnSeen = await waitFor(cdp, `document.querySelector('#jam-status[data-warning]') ? true : null`, 12000);
      const warnClock = await readSchedulerNow(cdp);
      const warnFacts = await evaluateExpr(cdp, statusFacts);
      // The spoken copy: a visually hidden child of the live region, written when a warning starts or
      // ends and never on a tick. The observers count every write to it and to the drawn time.
      const spokenFacts = await evaluateExpr(
        cdp,
        `(() => {
          const box = document.getElementById('jam-status');
          const spoken = document.getElementById('jam-status-spoken');
          const time = document.getElementById('jam-status-time');
          const probeText = document.createElement('span');
          probeText.style.color = 'var(--text)';
          document.body.appendChild(probeText);
          const textColor = getComputedStyle(probeText).color;
          probeText.remove();
          const rect = spoken ? spoken.getBoundingClientRect() : null;
          const facts = {
            exists: spoken !== null,
            inside: spoken !== null && box.contains(spoken),
            ariaHidden: spoken ? spoken.getAttribute('aria-hidden') : null,
            live: box.getAttribute('aria-live'),
            width: rect ? rect.width : null,
            height: rect ? rect.height : null,
            text: spoken ? spoken.textContent : null,
            timeAriaHidden: time.getAttribute('aria-hidden'),
            timeColor: getComputedStyle(time).color,
            textColor,
          };
          if (spoken) {
            window.__spokenWrites = 0;
            window.__timeWrites = 0;
            const options = { childList: true, characterData: true, subtree: true };
            window.__spokenObserver = new MutationObserver((records) => { window.__spokenWrites += records.length; });
            window.__timeObserver = new MutationObserver((records) => { window.__timeWrites += records.length; });
            window.__spokenObserver.observe(spoken, options);
            window.__timeObserver.observe(time, options);
          }
          return facts;
        })()`,
      );
      const timeMatch = /^back in key in (\d+)\u00A0s$/.exec(warnFacts.time);
      const loopPosition = warnClock % 8;
      const warnOk =
        !/runtime error/i.test(warnReply) &&
        warnSeen === true &&
        warnFacts.state === 'warning' &&
        warnFacts.lead === 'The harmony leaves the scale:' &&
        warnFacts.rest === ' A7/D contains C#, avoid C' &&
        timeMatch !== null &&
        (timeMatch[1] === '1' || timeMatch[1] === '2') &&
        loopPosition >= 2 &&
        loopPosition <= 4.5 &&
        warnFacts.timeAriaHidden === 'true' &&
        warnFacts.timeTitle === warnFacts.time &&
        warnFacts.tabindex === '0' &&
        warnFacts.chipRole === 'avoid';
      const safeSeen = await waitFor(cdp, `document.getElementById('jam-status').dataset.state === 'safe' ? true : null`, 8000);
      const safeFacts = await evaluateExpr(cdp, statusFacts);
      const readCounters = `({
        spokenWrites: window.__spokenWrites ?? null,
        timeWrites: window.__timeWrites ?? null,
        text: document.getElementById('jam-status-spoken') ? document.getElementById('jam-status-spoken').textContent : null,
      })`;
      const toSafeCounters = await evaluateExpr(cdp, readCounters);
      await evaluateExpr(cdp, `(() => { window.__spokenWrites = 0; window.__timeWrites = 0; })()`);
      await sleep(2500);
      const tickCounters = await evaluateExpr(cdp, readCounters);
      await evaluateExpr(
        cdp,
        `(() => {
          if (window.__spokenObserver) window.__spokenObserver.disconnect();
          if (window.__timeObserver) window.__timeObserver.disconnect();
          delete window.__spokenObserver;
          delete window.__timeObserver;
          delete window.__spokenWrites;
          delete window.__timeWrites;
        })()`,
      );
      const safeOk =
        safeSeen === true &&
        safeFacts.lead === 'All safe' &&
        safeFacts.rest === ' \u2014 every note of D Dorian works with the harmony right now.' &&
        safeFacts.time.startsWith('Next warning in ') &&
        safeFacts.warning === null &&
        safeFacts.tabindex === null &&
        safeFacts.chipRole === 'scale';
      report(
        'an outside chord makes the status warn in time, then say all safe',
        warnOk && safeOk,
        JSON.stringify({ warnClock, loopPosition, warnFacts, safeFacts }),
      );
      const spokenOk =
        spokenFacts.exists === true &&
        spokenFacts.inside === true &&
        spokenFacts.ariaHidden === null &&
        spokenFacts.live === 'polite' &&
        spokenFacts.width <= 1 &&
        spokenFacts.height <= 1 &&
        /^back in key in \d+\u00A0s$/.test(spokenFacts.text ?? '') &&
        spokenFacts.timeAriaHidden === 'true' &&
        spokenFacts.timeColor === spokenFacts.textColor &&
        toSafeCounters.spokenWrites !== null &&
        toSafeCounters.spokenWrites <= 1 &&
        /^Next warning in \d+\u00A0s$/.test(toSafeCounters.text ?? '') &&
        tickCounters.timeWrites !== null &&
        tickCounters.timeWrites >= 2 &&
        tickCounters.spokenWrites === 0;
      report(
        'the status box speaks its countdown when a warning starts and ends, never on each tick, and the warning time reads in the text color',
        spokenOk,
        JSON.stringify({ spokenFacts, toSafeCounters, tickCounters }),
      );

      // Leave the default tempo behind so nothing after this block depends on a changed one.
      await callTool(client, 'set_code', { code: 'setcps(0.5)', label: 'probe jam status reset tempo' });
      await clearViews();
    }

    // --- Jam: coming up ---
    {
      const askBoxOpen = () => evaluateExpr(cdp, "!document.getElementById('ask-box').hidden");
      const closeAsk = async () => {
        if (await askBoxOpen()) await pressKey(cdp, 'Escape');
        await waitFor(cdp, "document.getElementById('ask-box').hidden ? true : null", 2000);
      };
      const blurActive = () =>
        evaluateExpr(cdp, `(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); })()`);
      const clearViews = async () => {
        await closeAsk();
        await blurActive();
        if ((await evaluateExpr(cdp, "document.getElementById('workspace').dataset.view")) !== 'none') await pressKey(cdp, 'Escape');
        await blurActive();
      };
      const rowFacts = `[...document.querySelectorAll('#jam-rows .jam-row')].map((row) => ({
        time: row.querySelector('.jam-row-time').textContent,
        kind: row.querySelector('.jam-row-kind').textContent,
        kindData: row.querySelector('.jam-row-kind').dataset.kind,
        text: row.querySelector('.jam-row-text').textContent,
        warning: row.getAttribute('data-warning'),
        part: row.getAttribute('data-part'),
        tabindex: row.getAttribute('tabindex'),
      }))`;
      const secondsOf = (row) => {
        const match = /^(\d+)\u00A0s$/.exec(row.time);
        return match === null ? null : Number(match[1]);
      };
      const JAM_WARNING_PROGRAM = [
        'setcps(1)',
        'bass: note("d2").gain(0)',
        'pad: note("<[d3,f3,a3,c4]!2 [a2,c#3,e3,g3]!2 [d3,f3,a3,c4]!4>").gain(0)',
        'lead: n("0 1 2 3 4 5 6 7").scale("D:dorian").gain(0)',
      ].join('\n');
      const warnReply = await callTool(client, 'set_code', { code: JAM_WARNING_PROGRAM, label: 'probe jam coming up' });
      await clearViews();
      await pressKey(cdp, 'a');
      await pressKey(cdp, '5');
      await waitFor(cdp, `document.getElementById('jam-status').dataset.state === 'safe' ? true : null`, 12000);
      const firstRows = await waitFor(cdp, `(() => { const r = ${rowFacts}; return r.some((x) => x.warning !== null) ? r : null; })()`, 6000);
      const firstWarning = firstRows === null ? null : firstRows.find((row) => row.warning !== null);
      const firstSeconds = firstWarning ? secondsOf(firstWarning) : null;
      const firstTimes = firstRows === null ? [] : firstRows.map(secondsOf);
      await sleep(1500);
      const laterRows = await evaluateExpr(cdp, rowFacts);
      const laterWarning = laterRows.find((row) => row.warning !== null);
      const laterSeconds = laterWarning ? secondsOf(laterWarning) : null;
      report(
        'the coming-up list counts down to the next warning',
        !/runtime error/i.test(warnReply) &&
          firstRows !== null &&
          firstRows.length <= 3 &&
          firstWarning.kind === 'Warning' &&
          firstWarning.kindData === 'warning' &&
          firstWarning.text === 'A7/D brings C#, avoid C, lasts 2 cycles' &&
          firstWarning.tabindex === '0' &&
          firstTimes.every((value, i) => value !== null && (i === 0 || value > firstTimes[i - 1])) &&
          firstSeconds !== null &&
          laterSeconds !== null &&
          laterSeconds !== firstSeconds,
        JSON.stringify({ firstRows, laterRows }),
      );

      // Nothing outside the scale: all safe, no warning ahead, one calm row.
      const JAM_CALM_PROGRAM = [
        'setcps(1)',
        'bass: note("d2").gain(0)',
        'lead: n("0 1 2 3 4 5 6 7").scale("D:dorian").gain(0)',
      ].join('\n');
      const calmReply = await callTool(client, 'set_code', { code: JAM_CALM_PROGRAM, label: 'probe jam calm' });
      const calmFacts = await waitFor(
        cdp,
        `(() => {
          const rows = ${rowFacts};
          if (rows.length !== 1 || rows[0].kindData !== 'calm') return null;
          return { rows, lead: document.getElementById('jam-status-lead').textContent, time: document.getElementById('jam-status-time').textContent };
        })()`,
        8000,
      );
      report(
        'with nothing outside the scale the view says all safe and no warning ahead',
        !/runtime error/i.test(calmReply) &&
          calmFacts !== null &&
          calmFacts.lead === 'All safe' &&
          calmFacts.time === 'No warning ahead' &&
          calmFacts.rows[0].time === '\u2013' &&
          calmFacts.rows[0].text === 'No warning ahead \u2014 nothing leaves D Dorian in the next 32\u00A0s.' &&
          calmFacts.rows[0].warning === null &&
          calmFacts.rows[0].tabindex === null,
        JSON.stringify(calmFacts),
      );

      // Parts: a part change is listed with what happens to the scale.
      const JAM_PARTS_PROGRAM = [
        'setcps(1)',
        'const calm = n("0 1 2 3 4 5 6 7").scale("D:dorian").gain(0)',
        'const bright = n("0 1 2 3 4 5 6 7").scale("E:harmonic:minor").gain(0)',
        'bass: note("<d2!4 e2!4>").gain(0)',
        'lead: arrange([4, calm], [4, bright])',
      ].join('\n');
      const partsReply = await callTool(client, 'set_code', { code: JAM_PARTS_PROGRAM, label: 'probe jam coming parts' });
      const partRow = await waitFor(
        cdp,
        `(() => {
          const rows = ${rowFacts};
          return rows.find((row) => row.part !== null && row.kind === 'Part' &&
            (row.text === '"bright" starts (4 cycles) \u2014 scale changes to E harmonic minor' ||
             row.text === '"calm" starts (4 cycles) \u2014 scale changes to D Dorian')) ?? null;
        })()`,
        12000,
      );
      report(
        'a part change is listed with its scale',
        !/runtime error/i.test(partsReply) && partRow !== null && partRow.tabindex === '0' && partRow.kindData === 'part',
        JSON.stringify(partRow),
      );

      // Stop: the countdowns pause, the reading stays, and everything picks up when the music plays again.
      await callTool(client, 'set_code', { code: JAM_WARNING_PROGRAM, label: 'probe jam coming up again' });
      await waitFor(
        cdp,
        `(() => { const r = ${rowFacts}; return r.some((x) => x.warning !== null) && r.every((x) => /^\\d+\u00A0s$/.test(x.time)) ? true : null; })()`,
        12000,
      );
      await callTool(client, 'stop', {});
      const pausedFacts = await waitFor(
        cdp,
        `(() => {
          const paused = document.getElementById('jam-paused');
          if (paused.hidden) return null;
          const rows = ${rowFacts};
          return { text: paused.textContent, times: rows.map((row) => row.time), timeHidden: document.getElementById('jam-status-time').hidden, count: rows.length };
        })()`,
        6000,
      );
      await callTool(client, 'set_code', { code: JAM_WARNING_PROGRAM, label: 'probe jam coming up resumed' });
      const resumedFacts = await waitFor(
        cdp,
        `(() => {
          const rows = ${rowFacts};
          const paused = document.getElementById('jam-paused');
          return paused.hidden && rows.length > 0 && rows.every((row) => /^\\d+\u00A0s$/.test(row.time)) ? rows.map((row) => row.time) : null;
        })()`,
        12000,
      );
      report(
        'countdowns pause while the music is stopped',
        pausedFacts !== null &&
          pausedFacts.text === 'Not playing \u2014 countdowns are paused.' &&
          pausedFacts.count > 0 &&
          pausedFacts.times.every((time) => time === '\u2013') &&
          pausedFacts.timeHidden === true &&
          resumedFacts !== null,
        JSON.stringify({ pausedFacts, resumedFacts }),
      );

      // Leave the default tempo behind so nothing after this block depends on a changed one.
      await callTool(client, 'set_code', { code: 'setcps(0.5)', label: 'probe jam coming up reset tempo' });
      await clearViews();
    }

    // --- Jam: the piano ---
    {
      const askBoxOpen = () => evaluateExpr(cdp, "!document.getElementById('ask-box').hidden");
      const closeAsk = async () => {
        if (await askBoxOpen()) await pressKey(cdp, 'Escape');
        await waitFor(cdp, "document.getElementById('ask-box').hidden ? true : null", 2000);
      };
      const blurActive = () =>
        evaluateExpr(cdp, `(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); })()`);
      const clearViews = async () => {
        await closeAsk();
        await blurActive();
        if ((await evaluateExpr(cdp, "document.getElementById('workspace').dataset.view")) !== 'none') await pressKey(cdp, 'Escape');
        await blurActive();
      };
      const pianoFacts = `(() => {
        const piano = document.getElementById('jam-piano');
        const keys = [...piano.querySelectorAll('.jam-key')];
        const notesOf = (role) => keys.filter((key) => key.dataset.role === role).map((key) => key.dataset.note);
        return {
          count: keys.length,
          white: keys.filter((key) => key.dataset.black === 'false').length,
          root: notesOf('root'),
          scale: notesOf('scale'),
          off: notesOf('off').length,
          cLabels: keys.filter((key) => key.dataset.note === 'C').map((key) => key.querySelector('.jam-key-label').textContent),
          label: piano.getAttribute('aria-label'),
          role: piano.getAttribute('role'),
        };
      })()`;
      const markFacts = (note) => `(() => {
        const keys = [...document.querySelectorAll('#jam-piano .jam-key[data-note=${JSON.stringify(note)}]')];
        return keys.map((key) => ({
          role: key.dataset.role,
          border: getComputedStyle(key).borderTopStyle,
          cross: getComputedStyle(key, '::after').content,
          label: key.querySelector('.jam-key-label').textContent,
        }));
      })()`;
      const JAM_WARNING_PROGRAM = [
        'setcps(1)',
        'bass: note("d2").gain(0)',
        'pad: note("<[d3,f3,a3,c4]!2 [a2,c#3,e3,g3]!2 [d3,f3,a3,c4]!4>").gain(0)',
        'lead: n("0 1 2 3 4 5 6 7").scale("D:dorian").gain(0)',
      ].join('\n');
      const pianoReply = await callTool(client, 'set_code', { code: JAM_WARNING_PROGRAM, label: 'probe jam piano' });
      await clearViews();
      await pressKey(cdp, 'a');
      await pressKey(cdp, '5');
      await waitFor(cdp, `!document.getElementById('jam-body').hidden && document.getElementById('jam-status').dataset.state === 'safe' ? true : null`, 12000);
      const safePiano = await evaluateExpr(cdp, pianoFacts);
      const sameList = (a, b) => a.length === b.length && [...a].sort().join() === [...b].sort().join();
      const safeOk =
        safePiano.count === 24 &&
        safePiano.white === 14 &&
        safePiano.role === 'img' &&
        sameList(safePiano.root, ['D', 'D']) &&
        sameList(safePiano.scale, ['E', 'E', 'F', 'F', 'G', 'G', 'A', 'A', 'B', 'B', 'C', 'C']) &&
        safePiano.off === 10 &&
        sameList(safePiano.cLabels, ['C3', 'C4']) &&
        typeof safePiano.label === 'string' &&
        safePiano.label.endsWith('Avoid: none.');
      const warnSeen = await waitFor(cdp, `document.querySelector('#jam-status[data-warning]') ? true : null`, 12000);
      const avoidMarks = await evaluateExpr(cdp, markFacts('C'));
      const outsideMarks = await evaluateExpr(cdp, markFacts('C#'));
      const warnLabel = await evaluateExpr(cdp, `document.getElementById('jam-piano').getAttribute('aria-label')`);
      const warnOk =
        warnSeen === true &&
        avoidMarks.length === 2 &&
        avoidMarks.every((mark) => mark.role === 'avoid' && mark.border === 'solid' && mark.cross !== 'none' && mark.label === 'C') &&
        outsideMarks.length === 2 &&
        outsideMarks.every((mark) => mark.role === 'outside' && mark.border === 'dashed' && mark.cross === 'none') &&
        typeof warnLabel === 'string' &&
        warnLabel.includes('Avoid: C.');
      report(
        'the piano marks the scale, the root, the note to avoid and the outside note',
        !/runtime error/i.test(pianoReply) && safeOk && warnOk,
        JSON.stringify({ safePiano, avoidMarks, outsideMarks, warnLabel }),
      );

      // The legend's Root swatch: two inset layers, a text-colored ring on top of a page-colored one, so
      // it reads as a ring (light edge, dark ring, light center) and differs from the Scale swatch.
      const rootMark = await evaluateExpr(
        cdp,
        `(() => {
          const mark = document.querySelector('#jam-legend .jam-legend-mark[data-role="root"]');
          if (mark === null) return null;
          const colorOf = (name) => {
            const el = document.createElement('span');
            el.style.color = 'var(' + name + ')';
            document.body.appendChild(el);
            const color = getComputedStyle(el).color;
            el.remove();
            return color;
          };
          const layers = [];
          let depth = 0;
          let current = '';
          for (const ch of getComputedStyle(mark).boxShadow) {
            if (ch === '(') depth += 1;
            if (ch === ')') depth -= 1;
            if (ch === ',' && depth === 0) { layers.push(current.trim()); current = ''; } else current += ch;
          }
          layers.push(current.trim());
          return {
            layers: layers.map((layer) => ({
              color: (/rgba?\\([^)]*\\)/.exec(layer) || [null])[0],
              spread: parseFloat((layer.replace(/rgba?\\([^)]*\\)/, '').match(/-?[\\d.]+px/g) || [])[3]),
              inset: layer.includes('inset'),
            })),
            text: colorOf('--text'),
            dominant: colorOf('--dominant'),
          };
        })()`,
      );
      report(
        "the legend's Root mark draws a ring inside its swatch",
        rootMark !== null &&
          rootMark.layers.length === 2 &&
          rootMark.layers.every((layer) => layer.inset) &&
          rootMark.layers[0].color === rootMark.text &&
          rootMark.layers[1].color === rootMark.dominant &&
          rootMark.layers[0].spread < rootMark.layers[1].spread,
        JSON.stringify(rootMark),
      );

      // Leave the default tempo behind so nothing after this block depends on a changed one.
      await callTool(client, 'set_code', { code: 'setcps(0.5)', label: 'probe jam piano reset tempo' });
      await clearViews();
    }

    // --- Jam: the guitar and the switch ---
    {
      const askBoxOpen = () => evaluateExpr(cdp, "!document.getElementById('ask-box').hidden");
      const closeAsk = async () => {
        if (await askBoxOpen()) await pressKey(cdp, 'Escape');
        await waitFor(cdp, "document.getElementById('ask-box').hidden ? true : null", 2000);
      };
      const blurActive = () =>
        evaluateExpr(cdp, `(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); })()`);
      const clearViews = async () => {
        await closeAsk();
        await blurActive();
        if ((await evaluateExpr(cdp, "document.getElementById('workspace').dataset.view")) !== 'none') await pressKey(cdp, 'Escape');
        await blurActive();
      };
      const switchFacts = `(() => ({
        pianoPressed: document.getElementById('jam-instrument-piano').getAttribute('aria-pressed'),
        guitarPressed: document.getElementById('jam-instrument-guitar').getAttribute('aria-pressed'),
        pianoHidden: document.getElementById('jam-piano').hidden,
        guitarHidden: document.getElementById('jam-guitar').hidden,
        stored: localStorage.getItem('moontide.jamInstrument'),
      }))()`;
      const JAM_WARNING_PROGRAM = [
        'setcps(1)',
        'bass: note("d2").gain(0)',
        'pad: note("<[d3,f3,a3,c4]!2 [a2,c#3,e3,g3]!2 [d3,f3,a3,c4]!4>").gain(0)',
        'lead: n("0 1 2 3 4 5 6 7").scale("D:dorian").gain(0)',
      ].join('\n');
      const guitarReply = await callTool(client, 'set_code', { code: JAM_WARNING_PROGRAM, label: 'probe jam guitar' });
      await clearViews();
      await pressKey(cdp, 'a');
      await pressKey(cdp, '5');
      await waitFor(cdp, `!document.getElementById('jam-body').hidden && document.getElementById('jam-status').dataset.state === 'safe' ? true : null`, 12000);
      const before = await evaluateExpr(cdp, switchFacts);
      await clickElement(cdp, '#jam-instrument-guitar');
      const guitarFacts = await waitFor(
        cdp,
        `(() => {
          const facts = ${switchFacts};
          if (facts.guitarHidden) return null;
          const guitar = document.getElementById('jam-guitar');
          const rows = [...guitar.querySelectorAll('.jam-string')];
          const cell = (string, fret) => guitar.querySelector('.jam-string[data-string="' + string + '"] .jam-fret[data-fret="' + fret + '"]');
          const widthOf = (fret) => cell(0, fret).getBoundingClientRect().width;
          const aString = cell(4, 5);
          const bString = cell(1, 4);
          return {
            ...facts,
            role: guitar.getAttribute('role'),
            label: guitar.getAttribute('aria-label'),
            rows: rows.length,
            cells: rows.map((row) => row.querySelectorAll('.jam-fret').length),
            names: rows.map((row) => row.querySelector('.jam-string-name').textContent).join(''),
            numbers: [...guitar.querySelectorAll('.jam-fret-number')].map((el) => el.textContent).filter((text) => text !== '').join(' '),
            aNote: aString.dataset.note,
            aRole: aString.dataset.role,
            aDot: aString.querySelector('.jam-dot').textContent,
            bNote: bString.dataset.note,
            bRole: bString.dataset.role,
            ratio: widthOf(12) / widthOf(1),
          };
        })()`,
        4000,
      );
      const guitarOk =
        before.pianoPressed === 'true' &&
        before.guitarPressed === 'false' &&
        before.guitarHidden === true &&
        guitarFacts !== null &&
        guitarFacts.pianoHidden === true &&
        guitarFacts.pianoPressed === 'false' &&
        guitarFacts.guitarPressed === 'true' &&
        guitarFacts.role === 'img' &&
        guitarFacts.label === 'Guitar fretboard, standard tuning, 12 frets. Scale notes: D, E, F, G, A, B, C. Root D. Avoid: none.' &&
        guitarFacts.rows === 6 &&
        guitarFacts.cells.every((count) => count === 13) &&
        guitarFacts.names === 'eBGDAE' &&
        guitarFacts.numbers === '3 5 7 9 12' &&
        guitarFacts.aNote === 'D' &&
        guitarFacts.aRole === 'root' &&
        guitarFacts.aDot === 'D' &&
        guitarFacts.bNote === 'Eb' &&
        guitarFacts.bRole === 'off' &&
        guitarFacts.ratio >= 0.5 &&
        guitarFacts.ratio <= 0.56 &&
        guitarFacts.stored === 'guitar';
      // The choice survives a reload: leave no view open so pressing 5 opens the Jam view again.
      await clearViews();
      await reloadPage(cdp);
      await pressKey(cdp, '5');
      const reloaded = await waitFor(
        cdp,
        `(() => { const facts = ${switchFacts}; return document.getElementById('workspace').dataset.view === 'jam' && facts.guitarPressed === 'true' ? facts : null; })()`,
        8000,
      );
      const reloadOk = reloaded !== null && reloaded.guitarHidden === false && reloaded.pianoHidden === true && reloaded.stored === 'guitar';
      // The switch is inside the body, which shows once the reading is ready: wait for it before clicking.
      await waitFor(cdp, `document.getElementById('jam-body').hidden ? null : true`, 12000);
      await clickElement(cdp, '#jam-instrument-piano');
      const backFacts = await waitFor(cdp, `(() => { const facts = ${switchFacts}; return facts.pianoPressed === 'true' ? facts : null; })()`, 4000);
      const backOk = backFacts !== null && backFacts.guitarHidden === true && backFacts.pianoHidden === false && backFacts.stored === 'piano';
      report(
        'the guitar shows the same marks and the Piano / Guitar choice survives a reload',
        !/runtime error/i.test(guitarReply) && guitarOk && reloadOk && backOk,
        JSON.stringify({ before, guitarFacts, reloaded, backFacts }),
      );

      // Leave the default tempo behind so nothing after this block depends on a changed one.
      await callTool(client, 'set_code', { code: 'setcps(0.5)', label: 'probe jam guitar reset tempo' });
      await clearViews();
    }

    // --- Jam: chord tones ---
    {
      const askBoxOpen = () => evaluateExpr(cdp, "!document.getElementById('ask-box').hidden");
      const closeAsk = async () => {
        if (await askBoxOpen()) await pressKey(cdp, 'Escape');
        await waitFor(cdp, "document.getElementById('ask-box').hidden ? true : null", 2000);
      };
      const blurActive = () =>
        evaluateExpr(cdp, `(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); })()`);
      const clearViews = async () => {
        await closeAsk();
        await blurActive();
        if ((await evaluateExpr(cdp, "document.getElementById('workspace').dataset.view")) !== 'none') await pressKey(cdp, 'Escape');
        await blurActive();
      };
      const chordFacts = `(() => ({
        checked: document.getElementById('jam-chord-tones').checked,
        lineHidden: document.getElementById('jam-chord').hidden,
        line: document.getElementById('jam-chord').textContent,
        marked: document.querySelectorAll('#jam-view [data-chord="true"]').length,
        keys: [...document.querySelectorAll('#jam-piano .jam-key[data-chord="true"]')].map((el) => el.dataset.note),
        chips: [...document.querySelectorAll('#jam-degrees .jam-degree[data-chord="true"]')].map((el) => el.dataset.note),
        legendHidden: document.getElementById('jam-legend-chord').hidden,
        legend: document.getElementById('jam-legend-chord').textContent,
        legendCount: document.querySelectorAll('#jam-legend .jam-legend-entry:not([hidden])').length,
        stored: localStorage.getItem('moontide.jamChordTones'),
      }))()`;
      const JAM_WARNING_PROGRAM = [
        'setcps(1)',
        'bass: note("d2").gain(0)',
        'pad: note("<[d3,f3,a3,c4]!2 [a2,c#3,e3,g3]!2 [d3,f3,a3,c4]!4>").gain(0)',
        'lead: n("0 1 2 3 4 5 6 7").scale("D:dorian").gain(0)',
      ].join('\n');
      const chordReply = await callTool(client, 'set_code', { code: JAM_WARNING_PROGRAM, label: 'probe jam chord tones' });
      await clearViews();
      await pressKey(cdp, 'a');
      await pressKey(cdp, '5');
      await waitFor(cdp, `!document.getElementById('jam-body').hidden && document.getElementById('jam-status').dataset.state === 'safe' ? true : null`, 12000);
      const offFacts = await evaluateExpr(cdp, chordFacts);
      const offOk =
        offFacts.checked === false &&
        offFacts.lineHidden === true &&
        offFacts.marked === 0 &&
        offFacts.legendHidden === true &&
        offFacts.legendCount === 4 &&
        offFacts.stored === null;
      await clickElement(cdp, '#jam-chord-tones');
      const onFacts = await waitFor(
        cdp,
        `(() => { const facts = ${chordFacts}; return facts.line === 'Chord now: Dm7 · D F A C' ? facts : null; })()`,
        12000,
      );
      const sameNotes = (list, wanted) => list.length === wanted.length && [...list].sort().join() === [...wanted].sort().join();
      const onOk =
        onFacts !== null &&
        onFacts.checked === true &&
        onFacts.lineHidden === false &&
        onFacts.marked >= 8 + 4 &&
        sameNotes(onFacts.keys, ['D', 'F', 'A', 'C', 'D', 'F', 'A', 'C']) &&
        sameNotes(onFacts.chips, ['D', 'F', 'A', 'C']) &&
        onFacts.legendHidden === false &&
        onFacts.legend === 'Chord tone' &&
        onFacts.legendCount === 5 &&
        onFacts.stored === 'on';
      // Remembered: leave no view open so pressing 5 opens the Jam view again after the reload.
      await clearViews();
      await reloadPage(cdp);
      await pressKey(cdp, '5');
      const reloaded = await waitFor(
        cdp,
        `(() => { const facts = ${chordFacts}; return document.getElementById('workspace').dataset.view === 'jam' && facts.checked ? facts : null; })()`,
        8000,
      );
      const reloadOk = reloaded !== null && reloaded.stored === 'on';
      await waitFor(cdp, `document.getElementById('jam-body').hidden ? null : true`, 12000);
      await clickElement(cdp, '#jam-chord-tones');
      const backFacts = await waitFor(
        cdp,
        `(() => { const facts = ${chordFacts}; return facts.checked === false && facts.lineHidden ? facts : null; })()`,
        4000,
      );
      const backOk = backFacts !== null && backFacts.marked === 0 && backFacts.legendHidden === true && backFacts.stored === 'off';
      report(
        'Chord tones is off by default, marks the chord sounding now and survives a reload',
        !/runtime error/i.test(chordReply) && offOk && onOk && reloadOk && backOk,
        JSON.stringify({ offFacts, onFacts, reloaded, backFacts }),
      );

      // Leave the default tempo behind so nothing after this block depends on a changed one.
      await callTool(client, 'set_code', { code: 'setcps(0.5)', label: 'probe jam chord tones reset tempo' });
      await clearViews();
    }

    // --- Jam: warning contexts ---
    {
      const askBoxOpen = () => evaluateExpr(cdp, "!document.getElementById('ask-box').hidden");
      const closeAsk = async () => {
        if (await askBoxOpen()) await pressKey(cdp, 'Escape');
        await waitFor(cdp, "document.getElementById('ask-box').hidden ? true : null", 2000);
      };
      const blurActive = () =>
        evaluateExpr(cdp, `(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); })()`);
      const clearViews = async () => {
        await closeAsk();
        await blurActive();
        if ((await evaluateExpr(cdp, "document.getElementById('workspace').dataset.view")) !== 'none') await pressKey(cdp, 'Escape');
        await blurActive();
      };
      const requestsOf = (reply) =>
        reply
          .split('\n')
          .filter((line) => line.startsWith(REQUEST_PREFIX))
          .map((line) => {
            try {
              return JSON.parse(line.slice(REQUEST_PREFIX.length));
            } catch {
              return null;
            }
          });
      // A live listener would take the request before the next tool reply can carry it: stop them all.
      for (const child of spawnedListeners) {
        if (child.exitCode === null && child.signalCode === null) {
          const exited = new Promise((resolve) => child.once('exit', resolve));
          child.kill();
          await exited;
        }
      }
      // The rate limit counts a rolling second across pages.
      await sleep(1200);
      const JAM_WARNING_PROGRAM = [
        'setcps(1)',
        'bass: note("d2").gain(0)',
        'pad: note("<[d3,f3,a3,c4]!2 [a2,c#3,e3,g3]!2 [d3,f3,a3,c4]!4>").gain(0)',
        'lead: n("0 1 2 3 4 5 6 7").scale("D:dorian").gain(0)',
      ].join('\n');
      const askReply = await callTool(client, 'set_code', { code: JAM_WARNING_PROGRAM, label: 'probe jam warning contexts' });
      await clearViews();
      await pressKey(cdp, 'a');
      await pressKey(cdp, '5');
      // The rows of an earlier block may still be in the DOM while the view reads again: wait for the ready state.
      const rowSeen = await waitFor(
        cdp,
        `document.getElementById('jam-view').dataset.state === 'ready' && document.querySelector('#jam-view .jam-row[data-warning]') ? true : null`,
        12000,
      );
      const onRow = rowSeen === true ? await askAt(cdp, '#jam-view .jam-row[data-warning]') : null;
      const rowChip = onRow === null ? null : /^Warning · A7\/D brings C#, avoid C, in (\d+) s$/.exec(onRow.chip);
      await closeAsk();
      const statusSeen = await waitFor(cdp, `document.querySelector('#jam-status[data-warning]') ? true : null`, 12000);
      const onStatus = statusSeen === true ? await askAt(cdp, '#jam-status[data-warning]') : null;
      await cdp('Input.insertText', { text: 'jam warning check' });
      await pressKey(cdp, 'Enter');
      const sentReply = await callTool(client, 'get_code', {});
      const sent = requestsOf(sentReply).find((entry) => entry !== null && entry.text === 'jam warning check');
      await closeAsk();
      report(
        'a right-click on a warning asks Claude with the warning context',
        !/runtime error/i.test(askReply) &&
          onRow !== null &&
          onRow.prevented === true &&
          onRow.open === true &&
          rowChip !== null &&
          onStatus !== null &&
          onStatus.prevented === true &&
          onStatus.open === true &&
          onStatus.chip === 'Warning · A7/D brings C#, avoid C, now' &&
          sent !== undefined &&
          JSON.stringify(sent.context) ===
            JSON.stringify({ kind: 'warning', chord: 'A7/D', outside: 'C#', avoid: 'C', seconds: 0, scale: 'D Dorian' }) &&
          sent.chip === 'Warning · A7/D brings C#, avoid C, now',
        JSON.stringify({ onRow, onStatus, sent }),
      );

      // Leave the default tempo behind so nothing after this block depends on a changed one.
      await callTool(client, 'set_code', { code: 'setcps(0.5)', label: 'probe jam warning contexts reset tempo' });
      await clearViews();
    }

    // --- Jam: note contexts ---
    {
      const askBoxOpen = () => evaluateExpr(cdp, "!document.getElementById('ask-box').hidden");
      const closeAsk = async () => {
        if (await askBoxOpen()) await pressKey(cdp, 'Escape');
        await waitFor(cdp, "document.getElementById('ask-box').hidden ? true : null", 2000);
      };
      const blurActive = () =>
        evaluateExpr(cdp, `(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); })()`);
      const clearViews = async () => {
        await closeAsk();
        await blurActive();
        if ((await evaluateExpr(cdp, "document.getElementById('workspace').dataset.view")) !== 'none') await pressKey(cdp, 'Escape');
        await blurActive();
      };
      // Right-clicks `selector`, closes the box and says whether the page took the event and the chip read `wanted`
      // (a string, or a function of the chip text).
      const chipAt = async (selector, wanted) => {
        const result = await askAt(cdp, selector);
        await closeAsk();
        const chipOk = typeof wanted === 'function' ? wanted(result.chip) : result.chip === wanted;
        return { selector, chip: result.chip, ok: result.prevented === true && result.open === true && chipOk };
      };
      // A right-click in the warning state: waits for the status to warn, asks at once, and tries once more
      // when the warning ended in between.
      const chipInWarning = async (selector, wanted) => {
        let last = null;
        for (let attempt = 0; attempt < 2; attempt++) {
          await waitFor(cdp, `document.querySelector('#jam-status[data-warning]') ? true : null`, 12000);
          last = await chipAt(selector, wanted);
          if (last.ok) return last;
        }
        return last;
      };
      const JAM_WARNING_PROGRAM = [
        'setcps(1)',
        'bass: note("d2").gain(0)',
        'pad: note("<[d3,f3,a3,c4]!2 [a2,c#3,e3,g3]!2 [d3,f3,a3,c4]!4>").gain(0)',
        'lead: n("0 1 2 3 4 5 6 7").scale("D:dorian").gain(0)',
      ].join('\n');
      const noteReply = await callTool(client, 'set_code', { code: JAM_WARNING_PROGRAM, label: 'probe jam note contexts' });
      await clearViews();
      await pressKey(cdp, 'a');
      await pressKey(cdp, '5');
      await waitFor(
        cdp,
        `document.getElementById('jam-view').dataset.state === 'ready' && document.getElementById('jam-status').dataset.state === 'safe' && document.getElementById('jam-scale-name').textContent === 'D Dorian' ? true : null`,
        12000,
      );
      await clickElement(cdp, '#jam-instrument-piano');
      const checks04 = [];
      checks04.push(await chipAt('#jam-piano .jam-key[data-note="D"]', 'Note D · root of D Dorian'));
      checks04.push(await chipAt('#jam-piano .jam-key[data-note="B"]', 'Note B · in D Dorian'));
      checks04.push(await chipAt('#jam-piano .jam-key[data-note="Eb"]', 'Note Eb · not in D Dorian'));
      checks04.push(await chipAt('#jam-degrees .jam-degree[data-note="A"]', 'Note A · in D Dorian'));
      // The rest of the Jam view is the whole session.
      checks04.push(await chipAt('#jam-status', 'Whole session'));
      checks04.push(await chipAt('#jam-scale-name', 'Whole session'));
      checks04.push(await chipAt('#jam-legend', 'Whole session'));
      // In the warning state the note to avoid and the outside note say so.
      checks04.push(await chipInWarning('#jam-piano .jam-key[data-note="C"]', 'Note C · to avoid in D Dorian'));
      checks04.push(await chipInWarning('#jam-piano .jam-key[data-note="C#"]', 'Note C# · outside D Dorian'));
      // The fretboard: an empty cell and a root cell.
      await clickElement(cdp, '#jam-instrument-guitar');
      await waitFor(cdp, `document.getElementById('jam-guitar').hidden ? null : true`, 2000);
      checks04.push(await chipAt('#jam-guitar .jam-string[data-string="1"] .jam-fret[data-fret="4"]', 'Note Eb · not in D Dorian'));
      checks04.push(await chipAt('#jam-guitar .jam-string[data-string="4"] .jam-fret[data-fret="5"]', 'Note D · root of D Dorian'));
      await clickElement(cdp, '#jam-instrument-piano');
      await waitFor(cdp, `document.getElementById('jam-piano').hidden ? null : true`, 2000);
      // The scale is not clear: the bare note.
      await callTool(client, 'set_code', {
        code: 'pads: note("<[a3,c4,e4] [f3,a3,c4] [c4,e4,g4] [g3,b3,d4]>").gain(0)',
        label: 'probe jam note contexts tie',
      });
      await waitFor(cdp, `document.getElementById('jam-scale-name').dataset.kind === 'ambiguous' ? true : null`, 8000);
      checks04.push(await chipAt('#jam-piano .jam-key[data-note="D"]', 'Note D'));
      report(
        'a right-click on a key, a fretboard cell or a degree chip gives the note, its role and the scale',
        !/runtime error/i.test(noteReply) && checks04.every((entry) => entry.ok),
        JSON.stringify(checks04.map((entry) => `${entry.ok ? 'ok' : 'FAIL'} ${entry.chip}`)),
      );

      // A part row gives its part.
      const JAM_PARTS_PROGRAM = [
        'setcps(1)',
        'const calm = n("0 1 2 3 4 5 6 7").scale("D:dorian").gain(0)',
        'const bright = n("0 1 2 3 4 5 6 7").scale("E:harmonic:minor").gain(0)',
        'bass: note("<d2!4 e2!4>").gain(0)',
        'lead: arrange([4, calm], [4, bright])',
      ].join('\n');
      await callTool(client, 'set_code', { code: JAM_PARTS_PROGRAM, label: 'probe jam note contexts parts' });
      const partRow = await waitFor(
        cdp,
        `document.getElementById('jam-view').dataset.state === 'ready' && document.getElementById('jam-scale-sub').textContent.startsWith('Part "') && document.querySelector('#jam-view .jam-row[data-part]') ? true : null`,
        12000,
      );
      const onPart = partRow === true ? await chipAt('#jam-view .jam-row[data-part]', (chip) => chip.startsWith('Part "')) : null;
      report(
        'a part row gives its part and the rest of the Jam view the whole session',
        onPart !== null && onPart.ok && checks04.slice(4, 7).every((entry) => entry.ok),
        JSON.stringify({ onPart, whole: checks04.slice(4, 7) }),
      );

      // Leave the default tempo behind so nothing after this block depends on a changed one.
      await callTool(client, 'set_code', { code: 'setcps(0.5)', label: 'probe jam note contexts reset tempo' });
      await clearViews();
    }

    // --- Jam: layouts and motion ---
    {
      const askBoxOpen = () => evaluateExpr(cdp, "!document.getElementById('ask-box').hidden");
      const closeAsk = async () => {
        if (await askBoxOpen()) await pressKey(cdp, 'Escape');
        await waitFor(cdp, "document.getElementById('ask-box').hidden ? true : null", 2000);
      };
      const blurActive = () =>
        evaluateExpr(cdp, `(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); })()`);
      const clearViews = async () => {
        await closeAsk();
        await blurActive();
        if ((await evaluateExpr(cdp, "document.getElementById('workspace').dataset.view")) !== 'none') await pressKey(cdp, 'Escape');
        await blurActive();
      };
      const JAM_WARNING_PROGRAM = [
        'setcps(1)',
        'bass: note("d2").gain(0)',
        'pad: note("<[d3,f3,a3,c4]!2 [a2,c#3,e3,g3]!2 [d3,f3,a3,c4]!4>").gain(0)',
        'lead: n("0 1 2 3 4 5 6 7").scale("D:dorian").gain(0)',
      ].join('\n');
      // The Jam view's boxes at this moment, with the view scrolled to the top.
      const jamGeometry = `(() => {
        const box = (id) => {
          const b = document.getElementById(id).getBoundingClientRect();
          return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width };
        };
        const view = document.getElementById('jam-view');
        view.scrollTop = 0;
        const clipped = (selector) =>
          [...document.querySelectorAll(selector)]
            .filter((el) => el.textContent !== '' && el.clientWidth > 0)
            .filter((el) => el.scrollWidth > el.clientWidth)
            .map((el) => el.textContent);
        return {
          scrollWidth: view.scrollWidth,
          clientWidth: view.clientWidth,
          view: box('jam-view'),
          board: box('jam-board'),
          instrument: box('jam-instrument'),
          piano: box('jam-piano'),
          guitar: box('jam-guitar'),
          root: parseFloat(getComputedStyle(document.documentElement).fontSize),
          clippedKeys: clipped('#jam-piano .jam-key-label'),
          clippedDots: clipped('#jam-guitar .jam-dot'),
          rowBottoms: [...document.querySelectorAll('#jam-rows .jam-row')].map((row) => row.getBoundingClientRect().bottom),
          statusState: document.getElementById('jam-status').dataset.state ?? null,
        };
      })()`;
      // One reading of the Coming up rows against the strip's bottom.
      const rowsFit = [];
      const noteRowsFit = (at, g) => {
        const overflow = g.rowBottoms.length === 0 ? null : Math.max(...g.rowBottoms) - g.view.bottom;
        rowsFit.push({ at, state: g.statusState, rows: g.rowBottoms.length, overflow: overflow === null ? null : fmt(overflow), ok: g.rowBottoms.length === 3 && overflow <= 1 });
      };
      const pick = async (instrument) => {
        await clickElement(cdp, `#jam-instrument-${instrument}`);
        await waitFor(cdp, `document.getElementById('jam-${instrument}').hidden ? null : true`, 2000);
        await blurActive();
      };
      const layoutReply = await callTool(client, 'set_code', { code: JAM_WARNING_PROGRAM, label: 'probe jam layouts' });
      await clearViews();
      await pressKey(cdp, 'a');
      await pressKey(cdp, '5');
      await waitFor(
        cdp,
        `document.getElementById('jam-view').dataset.state === 'ready' && document.getElementById('jam-scale-name').textContent === 'D Dorian' ? true : null`,
        12000,
      );
      const fits = [];
      const tight = {};
      const fmt = (value) => Math.round(value * 10) / 10;
      try {
        for (const [width, height] of [[1920, 1080], [1366, 768], [3840, 2160]]) {
          await cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
          for (const layoutKey of ['a', 'b', 'c']) {
            await pressKey(cdp, layoutKey);
            for (const instrument of ['piano', 'guitar']) {
              await pick(instrument);
              const g = await evaluateExpr(cdp, jamGeometry);
              const inside =
                g.board.left >= g.view.left - 1 && g.board.right <= g.view.right + 1;
              const noSideScroll = g.scrollWidth <= g.clientWidth + 1;
              const labelsOk = g.clippedKeys.length === 0 && g.clippedDots.length === 0;
              fits.push({ ok: inside && noSideScroll && labelsOk, at: `${layoutKey} ${width}x${height} ${instrument}`, scrollWidth: g.scrollWidth, clientWidth: g.clientWidth, inside, clipped: g.clippedKeys.concat(g.clippedDots) });
              // Layout a at 1366 x 768: the instrument column is fully visible without scrolling.
              if (layoutKey === 'a' && width === 1366) {
                tight[`a-${instrument}`] = { instrumentBottom: fmt(g.instrument.bottom), viewBottom: fmt(g.view.bottom), ok: g.instrument.bottom <= g.view.bottom + 1 };
                noteRowsFit(instrument, g);
              }
            }
            // Layout a at 1366 x 768: the rows are inside the strip both while the box warns and while it says all safe.
            if (layoutKey === 'a' && width === 1366) {
              for (const state of ['warning', 'safe']) {
                await waitFor(cdp, `document.getElementById('jam-status').dataset.state === '${state}' ? true : null`, 9000);
                noteRowsFit(`wait ${state}`, await evaluateExpr(cdp, jamGeometry));
              }
            }
          }
        }
        // Layout b at 1280 x 720: the piano is at least 28rem wide and the fretboard at least 30rem.
        await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
        await pressKey(cdp, 'b');
        await pick('piano');
        const pianoB = await evaluateExpr(cdp, jamGeometry);
        await pick('guitar');
        const guitarB = await evaluateExpr(cdp, jamGeometry);
        tight.b = {
          pianoRem: fmt(pianoB.piano.width / pianoB.root),
          guitarRem: fmt(guitarB.guitar.width / guitarB.root),
          ok: pianoB.piano.width >= 28 * pianoB.root - 0.5 && guitarB.guitar.width >= 30 * guitarB.root - 0.5,
        };
      } finally {
        await cdp('Emulation.clearDeviceMetricsOverride');
      }
      // Leave layout a and the piano chosen.
      await pressKey(cdp, 'a');
      await pick('piano');
      // Nothing inside the Jam view has a transition or an animation.
      const moving = await evaluateExpr(
        cdp,
        `[...document.querySelectorAll('#jam-view, #jam-view *')]
          .map((el) => {
            const style = getComputedStyle(el);
            return { el: el.id || el.className || el.tagName, duration: style.transitionDuration, animation: style.animationName };
          })
          .filter((entry) => entry.duration.split(',').some((part) => part.trim() !== '0s') || entry.animation !== 'none')`,
      );
      report(
        'the Jam view fits every layout and window, and nothing in it animates',
        !/runtime error/i.test(layoutReply) &&
          fits.length === 18 &&
          fits.every((entry) => entry.ok) &&
          tight['a-piano'].ok &&
          tight['a-guitar'].ok &&
          tight.b.ok &&
          moving.length === 0,
        JSON.stringify({ failing: fits.filter((entry) => !entry.ok), tight, moving: moving.slice(0, 5) }),
      );

      report(
        'in layout a at 1366x768 every Coming up row is inside the strip, warning or all safe',
        rowsFit.length === 4 &&
          rowsFit.every((entry) => entry.ok) &&
          rowsFit.some((entry) => entry.state === 'warning') &&
          rowsFit.some((entry) => entry.state === 'safe'),
        JSON.stringify(rowsFit),
      );

      // Leave the default tempo behind so nothing after this block depends on a changed one.
      await callTool(client, 'set_code', { code: 'setcps(0.5)', label: 'probe jam layouts reset tempo' });
      await clearViews();
    }

    // --- String forms ---
    // Proves, in the real page, which JavaScript string forms the pinned transpiler turns into
    // mini-notation. The Strings section of reference/tidal-differences.md and the check:reference
    // string-forms claim rest on these facts. Every case is its own set_code call, stores the tested
    // value on window.__moontideStringForm and plays a silent line. Names start with "string forms: ".
    {
      const SILENT = 's("bd").gain(0)';
      const stringFormCase = async (caseName, lines) => {
        await evaluateExpr(cdp, 'window.__moontideStringForm = undefined');
        try {
          await callTool(client, 'set_code', {
            code: [...lines, SILENT].join('\n'),
            label: `probe string forms ${caseName}`,
          });
        } catch (err) {
          return { evaluated: false, message: err instanceof Error ? err.message : String(err) };
        }
        const summary = await evaluateExpr(
          cdp,
          `(() => {
            const value = window.__moontideStringForm;
            if (value && value._Pattern) {
              const onsets = value.queryArc(0, 1)
                .filter((h) => h.hasOnset())
                .map((h) => (h.value && typeof h.value === 'object' ? h.value.note : h.value));
              return { kind: 'pattern', onsets };
            }
            return { kind: typeof value, text: String(value) };
          })()`,
        );
        return { evaluated: true, ...summary };
      };
      const isPatternOf = (result, onsets) =>
        result.evaluated === true && result.kind === 'pattern' && JSON.stringify(result.onsets) === JSON.stringify(onsets);
      const isOnePlainValue = (result, text) =>
        result.evaluated === true &&
        result.kind === 'pattern' &&
        result.onsets.length === 1 &&
        result.onsets[0] === text;

      const formDouble = await stringFormCase('double', ['window.__moontideStringForm = note("c3 e3")']);
      const formBacktick = await stringFormCase('backtick plain', ['window.__moontideStringForm = note(`c3 e3`)']);
      const formInterpolated = await stringFormCase('backtick interpolated', [
        "const probeNote = 'e3'",
        'window.__moontideStringForm = note(`c3 ${probeNote} g3`)',
      ]);
      const formSingle = await stringFormCase('single', ["window.__moontideStringForm = note('c3 e3')"]);
      const formSingleBuilt = await stringFormCase('single built', [
        "window.__moontideStringForm = note('[' + ['c3', '~', 'e3'].join(' ') + ']')",
      ]);
      const formSingleMini = await stringFormCase('single mini', [
        "window.__moontideStringForm = note(mini('c3 ' + ['e3', 'g3'].join(' ')))",
      ]);
      const formHelperDouble = await stringFormCase('helper double', [
        'const probeWord = () => "c3"',
        'window.__moontideStringForm = probeWord()',
      ]);
      const formHelperJoin = await stringFormCase('helper join', [
        'const probeSep = () => " "',
        "window.__moontideStringForm = ['c3', 'e3'].join(probeSep())",
      ]);
      const formInvalidFirst = await stringFormCase('backtick invalid first piece', [
        "const probeRoot = 'c3'",
        'window.__moontideStringForm = note(`[${probeRoot} ~]`)',
      ]);
      const formNeverCalled = await stringFormCase('never called', ['const probeUnused = () => "["']);

      report(
        'string forms: double-quoted and untagged backtick strings are mini-notation',
        isPatternOf(formDouble, ['c3', 'e3']) && isPatternOf(formBacktick, ['c3', 'e3']),
        JSON.stringify({ double: formDouble, backtick: formBacktick }),
      );
      report(
        'string forms: a backtick string keeps only the text before its first ${',
        isPatternOf(formInterpolated, ['c3']),
        JSON.stringify({ interpolated: formInterpolated }),
      );
      report(
        'string forms: a single-quoted string reaches a pattern function as one plain value, even when built with + and .join()',
        isOnePlainValue(formSingle, 'c3 e3') && isOnePlainValue(formSingleBuilt, '[c3 ~ e3]'),
        JSON.stringify({ single: formSingle, singleBuilt: formSingleBuilt }),
      );
      report(
        'string forms: mini() turns a string built from single-quoted pieces into mini-notation',
        isPatternOf(formSingleMini, ['c3', 'e3', 'g3']),
        JSON.stringify({ singleMini: formSingleMini }),
      );
      report(
        'string forms: a double-quoted string inside a helper is transpiled too',
        formHelperDouble.evaluated === true &&
          formHelperDouble.kind === 'pattern' &&
          (formHelperJoin.evaluated === false || formHelperJoin.text !== 'c3 e3'),
        JSON.stringify({ helperDouble: formHelperDouble, helperJoin: formHelperJoin }),
      );
      report(
        'string forms: a string that is not valid mini-notation fails the evaluation with a [mini] parse error, even in a helper never called',
        formInvalidFirst.evaluated === false &&
          /\[mini\] parse error/.test(formInvalidFirst.message) &&
          /The previous code is still playing/.test(formInvalidFirst.message) &&
          formNeverCalled.evaluated === false &&
          /\[mini\] parse error/.test(formNeverCalled.message),
        JSON.stringify({ invalidFirstPiece: formInvalidFirst, neverCalled: formNeverCalled }),
      );

      await callTool(client, 'set_code', { code: SILENT, label: 'probe string forms reset' });
      await evaluateExpr(cdp, 'delete window.__moontideStringForm');
    }

    // --- a page newer than its server ---
    {
      packageCopy = makePackageCopy();
      tempDirs.push(packageCopy);
      const copyMain = path.join(packageCopy, 'page', 'main.js');
      const originalBytes = fs.readFileSync(copyMain);
      const started = await startServerAndClient({ entry: path.join(packageCopy, 'dist', 'index.js') });
      copyClient = started.client;
      tempDirs.push(started.dataDir);
      const copyUrl = started.pageUrl;

      const created = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(copyUrl)}`, { method: 'PUT' });
      if (!created.ok) throw new Error(`/json/new answered ${created.status}`);
      const copyTarget = await created.json();
      copyTabId = copyTarget.id;
      copyWs = new WebSocket(copyTarget.webSocketDebuggerUrl);
      await waitSocketOpen(copyWs);
      const copyCdp = makeCdp(copyWs);
      await copyCdp('Runtime.enable');
      let grantNote = 'the MIDI permission was granted';
      try {
        await copyCdp('Browser.grantPermissions', { origin: new URL(copyUrl).origin, permissions: ['midi'] });
      } catch (err) {
        grantNote = `the browser refused the MIDI permission grant (${err instanceof Error ? err.message : String(err)})`;
      }
      await waitConnected(copyCdp, 15000);
      await clickOverlay(copyCdp);
      await callTool(copyClient, 'set_code', { code: 's("bd").gain(0)', label: 'probe build copy silent' });
      const mismatchHidden = (cdp2) => evaluateExpr(cdp2, `document.getElementById('build-mismatch').hidden`);
      // The visible line starts with the action, so it must never be clipped: at the probe's own window, at a 1366 px
      // laptop and at 1024 px it is whole in the session strip (drawer closed) and whole in the Session card (drawer
      // open), both shown with a box (a hidden element never passes), and no control is pushed off-screen.
      const mismatchFit = async (cdp2, expectedLine) => {
        const measure = async () => {
          await closeDrawer(cdp2);
          const strip = await evaluateExpr(
            cdp2,
            `(() => {
              const el = document.getElementById('strip-text');
              const strip = document.getElementById('session-strip');
              const box = el.getBoundingClientRect();
              const stripBox = strip.getBoundingClientRect();
              const bar = document.getElementById('top-bar');
              const visible = [...bar.children].filter((c) => !c.hidden && c.getClientRects().length > 0);
              const shown = !strip.hidden && box.width > 0 && box.height > 0;
              return {
                shown,
                text: el.textContent,
                whole: shown && el.scrollWidth <= el.clientWidth && box.left >= stripBox.left - 1 && box.right <= stripBox.right + 1,
                barRight: Math.round(bar.getBoundingClientRect().right),
                lastRight: Math.round(Math.max(...visible.map((c) => c.getBoundingClientRect().right))),
                innerWidth: window.innerWidth,
              };
            })()`,
          );
          await openDrawer(cdp2);
          const card = await evaluateExpr(cdp2, `(${DRAWER_ITEM_JS})('build-mismatch')`);
          await closeDrawer(cdp2);
          return { strip, card };
        };
        const results = { own: await measure() };
        for (const width of [1366, 1024]) {
          await cdp2('Emulation.setDeviceMetricsOverride', { width, height: 768, deviceScaleFactor: 1, mobile: false });
          await new Promise((resolve) => setTimeout(resolve, 300));
          results[width] = await measure();
        }
        await cdp2('Emulation.clearDeviceMetricsOverride');
        await new Promise((resolve) => setTimeout(resolve, 300));
        // Below 1024 px the bar is outside the guarantee of the bar (the tempo and the hand-edit setting, shown while
        // music plays, take room the bar no longer has): the line itself is still never clipped there.
        const whole = (m, key) =>
          m.strip.shown && m.strip.text.startsWith(expectedLine) && m.strip.whole && m.card.shown && m.card.whole && (key === 'own' || m.strip.lastRight <= m.strip.barRight + 1);
        return { pass: Object.entries(results).every(([key, m]) => whole(m, key)), results };
      };
      const sameBuildHidden = await mismatchHidden(copyCdp);
      const sameBuildReply = await callTool(copyClient, 'get_code', {});

      fs.appendFileSync(copyMain, '\n// probe: a newer page than the running server\n');
      await reloadPage(copyCdp);
      const lineState = await evaluateExpr(
        copyCdp,
        `(() => { const el = document.getElementById('build-mismatch'); return { hidden: el.hidden, text: el.textContent }; })()`,
      );
      const mismatchFitState = await mismatchFit(copyCdp, BUILD_MISMATCH_COPY.line);
      const firstReply = await callTool(copyClient, 'get_code', {});
      const secondReply = await callTool(copyClient, 'get_code', {});
      const phrase = 'the server and the page come from different builds, restart the server';
      report(
        'a page newer than the server shows the different-builds line and Claude is told once',
        sameBuildHidden === true &&
          !sameBuildReply.includes('different builds') &&
          lineState.hidden === false &&
          lineState.text === BUILD_MISMATCH_COPY.line &&
          firstReply.includes(phrase) &&
          !secondReply.includes(phrase),
        JSON.stringify({ sameBuildHidden, lineState, firstHasNote: firstReply.includes(phrase), secondHasNote: secondReply.includes(phrase) }),
      );

      // The Instruments view in that page says the same thing, never that the file is invalid. The copy's own
      // data folder holds no instruments.json, so only the build mismatch can explain the message.
      await evaluateExpr(copyCdp, `(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); })()`);
      if ((await evaluateExpr(copyCdp, `document.getElementById('workspace').dataset.view`)) !== 'none') await pressKey(copyCdp, 'Escape');
      await pressKey(copyCdp, '6');
      await waitFor(copyCdp, `document.getElementById('workspace').dataset.view === 'instruments' ? true : null`, 3000);
      const copyInstruments = await evaluateExpr(
        copyCdp,
        `(() => {
          const el = (id) => document.getElementById(id);
          return {
            open: el('workspace').dataset.view === 'instruments',
            lead: el('instruments-message').hidden ? null : el('instruments-message-text').textContent,
            sub: el('instruments-message-sub').hidden ? null : el('instruments-message-sub').textContent,
            cards: document.querySelectorAll('.instrument-card').length,
            text: el('instruments-view').textContent,
          };
        })()`,
      );
      await pressKey(copyCdp, 'Escape');
      report(
        'instruments view: a build mismatch says Restart Claude: different builds, never that the file is invalid',
        copyInstruments.open === true &&
          copyInstruments.lead === BUILD_MISMATCH_COPY.line &&
          copyInstruments.sub === INSTRUMENTS_COPY.buildMismatchSub &&
          copyInstruments.cards === 0 &&
          !copyInstruments.text.includes('instruments.json is invalid') &&
          !copyInstruments.text.includes(MIDI_COPY.popSetupInvalidLead),
        JSON.stringify({ open: copyInstruments.open, lead: copyInstruments.lead, sub: copyInstruments.sub, cards: copyInstruments.cards }),
      );

      report(
        'the different-builds line is not clipped at the probe window, at 1366 px and at 1024 px, and no control is pushed off-screen',
        mismatchFitState.pass,
        JSON.stringify(mismatchFitState.results),
      );

      const okReply = await callTool(copyClient, 'set_code', { code: 's("bd").gain(0)', label: 'probe build mismatch plain' });
      let midiRefusal = null;
      try {
        await callTool(copyClient, 'set_code', { code: `note("c3").midi('Port A').gain(0)`, label: 'probe build mismatch midi' });
      } catch (err) {
        midiRefusal = err instanceof Error ? err.message : String(err);
      }
      const indicatorText = await evaluateExpr(copyCdp, `document.getElementById('midi-state-text').textContent`);
      report(
        'with a build mismatch, code with .midi( is refused without blaming instruments.json and other code still plays',
        okReply.startsWith('ok, playing') &&
          midiRefusal !== null &&
          midiRefusal.includes('different builds') &&
          !midiRefusal.includes('instruments.json') &&
          !indicatorText.includes('instruments.json'),
        JSON.stringify({ plainReply: okReply.slice(0, 40), midiRefusal, indicatorText, expectedIndicator: MIDI_COPY.indicatorBuildMismatch, grant: grantNote }),
      );

      await callTool(copyClient, 'set_code', { code: 's("bd").gain(0)', label: 'probe build copy silent again' });
      fs.writeFileSync(copyMain, originalBytes);
      await reloadPage(copyCdp);
      const restoredHidden = await mismatchHidden(copyCdp);
      const restoredReply = await callTool(copyClient, 'get_code', {});
      report(
        'the same bytes again are not a build mismatch',
        restoredHidden === true && !restoredReply.includes('different builds'),
        JSON.stringify({ hidden: restoredHidden, replyHasNote: restoredReply.includes('different builds') }),
      );

      // A change in the compiled server code alone leaves the page and the server matching: the page shows
      // the softer "Moontide was updated" line and keeps .midi( code, and Claude is told once to restart to
      // use the update.
      const copyDistFile = path.join(packageCopy, 'dist', 'build-id.js');
      fs.appendFileSync(copyDistFile, '\n// probe: newer server code than the running server\n');
      await reloadPage(copyCdp);
      const serverOnlyLine = await evaluateExpr(
        copyCdp,
        `(() => { const el = document.getElementById('build-mismatch'); return { hidden: el.hidden, text: el.textContent, title: el.title }; })()`,
      );
      const serverOnlyFit = await mismatchFit(copyCdp, SERVER_UPDATED_COPY.line);
      const serverOnlyFirst = await callTool(copyClient, 'get_code', {});
      const serverOnlySecond = await callTool(copyClient, 'get_code', {});
      let serverOnlyMidiRefusal = null;
      try {
        await callTool(copyClient, 'set_code', { code: `note("c3").midi('Port A').gain(0)`, label: 'probe server-only midi' });
      } catch (err) {
        serverOnlyMidiRefusal = err instanceof Error ? err.message : String(err);
      }
      const updatedPhrase = 'Moontide was updated since this server started';
      report(
        'a server older than its own code files alone shows the updated line (not the different-builds one), refuses nothing for it, and Claude is told once',
        serverOnlyLine.hidden === false &&
          serverOnlyLine.text === SERVER_UPDATED_COPY.line &&
          serverOnlyLine.title === SERVER_UPDATED_COPY.title &&
          serverOnlyFirst.includes(updatedPhrase) &&
          !serverOnlyFirst.includes('come from different builds, restart the server') &&
          !serverOnlySecond.includes(updatedPhrase) &&
          (serverOnlyMidiRefusal === null || !serverOnlyMidiRefusal.includes('different builds')),
        JSON.stringify({ line: serverOnlyLine, firstHasNote: serverOnlyFirst.includes(updatedPhrase), secondHasNote: serverOnlySecond.includes(updatedPhrase), midiRefusal: serverOnlyMidiRefusal }),
      );

      report(
        'the updated line is not clipped at the probe window, at 1366 px and at 1024 px, and no control is pushed off-screen',
        serverOnlyFit.pass,
        JSON.stringify(serverOnlyFit.results),
      );

      try {
        copyWs.close();
      } catch {
        // already closed
      }
      copyWs = null;
      await fetch(`http://127.0.0.1:${port}/json/close/${copyTabId}`).catch(() => {});
      copyTabId = null;
      await copyClient.close();
      copyClient = null;
      removePackageCopyLink(packageCopy);
    }

    // --- a change asked for the next bar takes over on the bar line ---
    {
      // Both versions log every event they trigger (onTrigger with dominant true plays nothing else): the
      // version tag, the event's cycle position and its audio target time. The pattern itself is a double-quoted
      // string on purpose (that is the mini-notation, 8 events per cycle); the tag is a number, because a
      // double-quoted tag would be mini-notation too. Fractions are read as plain numbers before leaving the page.
      const takeoverCode = (version, withTempo) =>
        `${withTempo ? 'setcps(0.5);\n' : ''}ticks: s("hh*8").onTrigger((hap, now, cps, targetTime) => { (window.__takeoverLog = window.__takeoverLog || []).push({ v: ${version}, begin: hap.whole.begin.valueOf(), target: targetTime, cps }); }, true)`;
      const takeoverLabel = 'probe takeover bar';
      await evaluateExpr(cdp, `(() => { window.__takeoverLog = []; })()`);
      await callTool(client, 'set_code', { code: takeoverCode(1, true), label: 'probe takeover old' });
      // One full cycle at 0.5 cps is 2 s: wait for a few so the old code plays and the scheduler runs ahead of it.
      await sleep(3500);
      const takeoverRequestedAt = Date.now();
      const takeoverReply = await callTool(client, 'set_code', { code: takeoverCode(2, false), label: takeoverLabel, at: 'bar' });
      const takeoverReplyMs = Date.now() - takeoverRequestedAt;
      const takeoverMatch = /takes over at cycle (\d+)/.exec(takeoverReply);
      const takeoverCycle = takeoverMatch === null ? null : Number(takeoverMatch[1]);
      // After the reply and before the line: the old code, and no history entry for the change yet.
      const takeoverCodeBefore = await callTool(client, 'get_code', {});
      const takeoverHistoryBefore = await callTool(client, 'list_history', {});
      const takeoverNowAtReply = await readSchedulerNow(cdp);
      if (takeoverCycle === null) {
        report('takeover bar: no old event at or after the line', false, `the reply has no cycle: ${JSON.stringify(takeoverReply.slice(0, 200))}`);
        report('takeover bar: no new event before the line', false, 'no cycle to compare');
        report('takeover bar: the first new event is one grid step after the last old one', false, 'no cycle to compare');
        report('takeover bar: get_code and the history follow the line', false, 'no cycle to compare');
      } else {
        // Wait until the scheduler is a whole cycle past the line, then read the log.
        const takeoverDeadline = Date.now() + 30000;
        while ((await readSchedulerNow(cdp)) < takeoverCycle + 1 && Date.now() < takeoverDeadline) await sleep(100);
        await sleep(400);
        const takeoverLog = await evaluateExpr(
          cdp,
          `window.__takeoverLog.map((e) => ({ v: e.v, begin: Number(e.begin), target: Number(e.target), cps: Number(e.cps) }))`,
        );
        const oldEvents = takeoverLog.filter((e) => e.v === 1);
        const newEvents = takeoverLog.filter((e) => e.v === 2);
        const oldAtOrAfter = oldEvents.filter((e) => e.begin >= takeoverCycle);
        const newBefore = newEvents.filter((e) => e.begin < takeoverCycle);
        report(
          'takeover bar: no old event at or after the line',
          oldEvents.length > 0 && oldAtOrAfter.length === 0,
          JSON.stringify({ line: takeoverCycle, oldEvents: oldEvents.length, atOrAfter: oldAtOrAfter.length, replyMs: takeoverReplyMs, nowAtReply: takeoverNowAtReply }),
        );
        report(
          'takeover bar: no new event before the line',
          newEvents.length > 0 && newBefore.length === 0,
          JSON.stringify({ line: takeoverCycle, newEvents: newEvents.length, before: newBefore.length }),
        );
        const lastOld = oldEvents.reduce((best, e) => (best === null || e.begin > best.begin ? e : best), null);
        const firstNew = newEvents.reduce((best, e) => (best === null || e.begin < best.begin ? e : best), null);
        let stepDetail = 'no events to compare';
        let stepPass = false;
        if (lastOld !== null && firstNew !== null) {
          const gap = firstNew.target - lastOld.target;
          const spacing = 1 / 8 / firstNew.cps;
          stepPass = Math.abs(gap - spacing) < 0.001 && firstNew.begin === takeoverCycle;
          stepDetail = JSON.stringify({ gapSeconds: gap, gridSeconds: spacing, firstNewBegin: firstNew.begin, lastOldBegin: lastOld.begin });
        }
        report('takeover bar: the first new event is one grid step after the last old one', stepPass, stepDetail);
        const takeoverCodeAfter = await callTool(client, 'get_code', {});
        const takeoverHistoryAfter = await callTool(client, 'list_history', {});
        const followPass =
          takeoverCodeBefore.includes('v: 1') &&
          !takeoverCodeBefore.includes('v: 2') &&
          !takeoverHistoryBefore.includes(takeoverLabel) &&
          takeoverCodeAfter.includes('v: 2') &&
          !takeoverCodeAfter.includes('v: 1') &&
          takeoverHistoryAfter.includes(takeoverLabel);
        report(
          'takeover bar: get_code and the history follow the line',
          followPass,
          JSON.stringify({
            codeBeforeHasOld: takeoverCodeBefore.includes('v: 1'),
            codeBeforeHasNew: takeoverCodeBefore.includes('v: 2'),
            historyBeforeHasLabel: takeoverHistoryBefore.includes(takeoverLabel),
            codeAfterHasNew: takeoverCodeAfter.includes('v: 2'),
            historyAfterHasLabel: takeoverHistoryAfter.includes(takeoverLabel),
          }),
        );
      }
    }

    // --- the tempo of a waiting change, the phrase line, Stop, replacement and refusal ---
    {
      // Same instrumentation as the "takeover bar" block: every event the version triggers is logged with its
      // version tag, its cycle position, its audio target time and the tempo the scheduler handed it.
      const timedCode = (version, head) =>
        `${head}ticks: s("hh*8").onTrigger((hap, now, cps, targetTime) => { (window.__takeoverLog = window.__takeoverLog || []).push({ v: ${version}, begin: hap.whole.begin.valueOf(), target: targetTime, cps }); }, true)`;
      const resetTimedLog = () => evaluateExpr(cdp, `(() => { window.__takeoverLog = []; })()`);
      const readTimedLog = () =>
        evaluateExpr(
          cdp,
          `window.__takeoverLog.map((e) => ({ v: e.v, begin: Number(e.begin), target: Number(e.target), cps: Number(e.cps) }))`,
        );
      const readPageCps = () => evaluateExpr(cdp, `document.getElementById('repl').editor.repl.scheduler.cps`);
      const cycleOf = (reply) => {
        const match = /takes over at cycle (\d+)/.exec(reply);
        return match === null ? null : Number(match[1]);
      };
      const firstEventOf = (log, version) =>
        log.filter((e) => e.v === version).reduce((best, e) => (best === null || e.begin < best.begin ? e : best), null);
      // Waits until the scheduler is past a cycle line, then lets the slice that crosses it finish.
      const waitPast = async (cycle, extra = 0.5) => {
        const deadline = Date.now() + 40000;
        while ((await readSchedulerNow(cdp)) < cycle + extra && Date.now() < deadline) await sleep(100);
        await sleep(400);
      };
      const countOf = (text, phrase) => text.split(phrase).length - 1;

      // The tempo: the old bars keep their tempo until the line, and the downbeat stays on the line.
      {
        await resetTimedLog();
        await callTool(client, 'set_code', { code: timedCode(1, 'setcps(0.5);\n'), label: 'probe timed tempo old' });
        await sleep(3500);
        const reply = await callTool(client, 'set_code', {
          code: timedCode(2, 'setcpm(45);\n'),
          label: 'probe timed tempo new',
          at: 'bar',
        });
        const cycle = cycleOf(reply);
        const cpsAtReply = await readPageCps();
        const tempoLine = /Tempo from cycle (\d+): 180 BPM\./.exec(reply);
        report(
          'takeover tempo: the old bars keep their tempo until the line',
          cycle !== null && cpsAtReply === 0.5 && tempoLine !== null && Number(tempoLine[1]) === cycle,
          JSON.stringify({ line: cycle, cpsAtReply, tempoLine: tempoLine === null ? null : tempoLine[0], reply: reply.slice(0, 240) }),
        );
        if (cycle === null) {
          report('takeover tempo: the downbeat stays on the line', false, 'no cycle to compare');
        } else {
          await waitPast(cycle + 1);
          const cpsAfter = await readPageCps();
          const log = await readTimedLog();
          const lastOld = log
            .filter((e) => e.v === 1)
            .reduce((best, e) => (best === null || e.begin > best.begin ? e : best), null);
          const firstNew = firstEventOf(log, 2);
          let pass = false;
          let detail = JSON.stringify({ line: cycle, cpsAfter, oldEvents: log.filter((e) => e.v === 1).length, newEvents: log.filter((e) => e.v === 2).length });
          if (lastOld !== null && firstNew !== null) {
            // The line is one old grid step after the last old event (1/8 cycle at 0.5 cps).
            const expected = lastOld.target + 1 / 8 / 0.5;
            const offsetMs = (firstNew.target - expected) * 1000;
            pass = cpsAfter === 0.75 && firstNew.begin === cycle && Math.abs(offsetMs) < 1;
            detail = JSON.stringify({ line: cycle, cpsAfter, firstNewBegin: firstNew.begin, offsetMs, lastOldBegin: lastOld.begin });
          }
          report('takeover tempo: the downbeat stays on the line', pass, detail);
        }
      }

      // The phrase line: a multiple of 4 by default, a multiple of 8 when Claude asks for 8.
      {
        await resetTimedLog();
        await callTool(client, 'set_code', { code: timedCode(1, 'setcps(1);\n'), label: 'probe timed phrase old' });
        await sleep(2500);
        const replyFour = await callTool(client, 'set_code', { code: timedCode(2, ''), label: 'probe timed phrase four', at: 'phrase' });
        const cycleFour = cycleOf(replyFour);
        let fourPass = false;
        let fourDetail = `the reply has no cycle: ${JSON.stringify(replyFour.slice(0, 200))}`;
        if (cycleFour !== null) {
          await waitPast(cycleFour);
          const firstNew = firstEventOf(await readTimedLog(), 2);
          fourPass = cycleFour % 4 === 0 && firstNew !== null && firstNew.begin === cycleFour;
          fourDetail = JSON.stringify({ line: cycleFour, firstNewBegin: firstNew === null ? null : firstNew.begin });
        }
        const replyEight = await callTool(client, 'set_code', {
          code: timedCode(3, ''),
          label: 'probe timed phrase eight',
          at: 'phrase',
          phraseCycles: 8,
        });
        const cycleEight = cycleOf(replyEight);
        let eightPass = false;
        let eightDetail = `the reply has no cycle: ${JSON.stringify(replyEight.slice(0, 200))}`;
        if (cycleEight !== null) {
          await waitPast(cycleEight);
          const firstNew = firstEventOf(await readTimedLog(), 3);
          eightPass = cycleEight % 8 === 0 && firstNew !== null && firstNew.begin === cycleEight;
          eightDetail = JSON.stringify({ line: cycleEight, firstNewBegin: firstNew === null ? null : firstNew.begin });
        }
        report(
          'takeover phrase: a phrase change lands on a multiple of 4, and with phraseCycles 8 on a multiple of 8',
          fourPass && eightPass,
          JSON.stringify({ four: fourDetail, eight: eightDetail }),
        );
      }

      // Stop cancels a waiting change: the old code stays, the new text stays in the editor, Claude is told once.
      {
        await resetTimedLog();
        await callTool(client, 'set_code', { code: timedCode(1, 'setcps(1);\n'), label: 'probe timed stop old' });
        await sleep(2500);
        const stoppedLabel = 'probe timed stop new';
        const waitingReply = await callTool(client, 'set_code', {
          code: timedCode(2, ''),
          label: stoppedLabel,
          at: 'phrase',
          phraseCycles: 8,
        });
        const stopReply = await callTool(client, 'stop', {});
        const codeAfter = await callTool(client, 'get_code', {});
        const historyAfter = await callTool(client, 'list_history', {});
        const editorText = await evaluateExpr(cdp, `document.getElementById('repl').editor.code`);
        const notice = 'did not take over: the music was stopped';
        const told = countOf(stopReply, notice) + countOf(codeAfter, notice) + countOf(historyAfter, notice);
        report(
          'takeover stop: Stop cancels the waiting change',
          cycleOf(waitingReply) !== null &&
            codeAfter.includes('v: 1') &&
            !codeAfter.includes('v: 2') &&
            editorText.includes('v: 2') &&
            !historyAfter.includes(stoppedLabel) &&
            told === 1,
          JSON.stringify({
            toldTimes: told,
            codeHasOld: codeAfter.includes('v: 1'),
            codeHasNew: codeAfter.includes('v: 2'),
            editorHasNew: editorText.includes('v: 2'),
            historyHasLabel: historyAfter.includes(stoppedLabel),
            stopReply: stopReply.slice(0, 240),
          }),
        );
      }

      // A newer change replaces the waiting one: Claude is told once, the replaced change never plays or records.
      {
        await resetTimedLog();
        await callTool(client, 'set_code', { code: timedCode(1, 'setcps(1);\n'), label: 'probe timed replaced old' });
        await sleep(2500);
        const replacedLabel = 'probe timed replaced one';
        const newerLabel = 'probe timed replaced two';
        const firstReply = await callTool(client, 'set_code', {
          code: timedCode(2, ''),
          label: replacedLabel,
          at: 'phrase',
          phraseCycles: 8,
        });
        const secondReply = await callTool(client, 'set_code', { code: timedCode(3, ''), label: newerLabel, at: 'bar' });
        const cycle = cycleOf(secondReply);
        const note = 'a newer change replaced it';
        let pass = false;
        let detail = `the second reply has no cycle: ${JSON.stringify(secondReply.slice(0, 200))}`;
        if (cycle !== null) {
          await waitPast(cycle);
          const log = await readTimedLog();
          const firstNew = firstEventOf(log, 3);
          const replacedEvents = log.filter((e) => e.v === 2).length;
          const codeAfter = await callTool(client, 'get_code', {});
          const historyAfter = await callTool(client, 'list_history', {});
          pass =
            cycleOf(firstReply) !== null &&
            firstNew !== null &&
            firstNew.begin === cycle &&
            replacedEvents === 0 &&
            codeAfter.includes('v: 3') &&
            !historyAfter.includes(replacedLabel) &&
            historyAfter.includes(newerLabel) &&
            countOf(secondReply, note) === 1 &&
            countOf(codeAfter, note) === 0 &&
            countOf(historyAfter, note) === 0;
          detail = JSON.stringify({
            line: cycle,
            firstNewBegin: firstNew === null ? null : firstNew.begin,
            replacedEvents,
            toldInSecondReply: countOf(secondReply, note),
            toldAgain: countOf(codeAfter, note) + countOf(historyAfter, note),
            historyHasReplaced: historyAfter.includes(replacedLabel),
            historyHasNewer: historyAfter.includes(newerLabel),
            secondReply: secondReply.slice(0, 300),
          });
        }
        report('takeover replaced: a newer change replaces the waiting one', pass, detail);
      }

      // A refused newer change (a syntax error) leaves the waiting change in place.
      {
        await resetTimedLog();
        await callTool(client, 'set_code', { code: timedCode(1, 'setcps(1);\n'), label: 'probe timed refused old' });
        await sleep(2500);
        const waitingReply = await callTool(client, 'set_code', { code: timedCode(2, ''), label: 'probe timed refused waiting', at: 'phrase' });
        const cycle = cycleOf(waitingReply);
        let refusal = null;
        try {
          await callTool(client, 'set_code', { code: 'ticks: s("hh*8"', label: 'probe timed refused broken', at: 'bar' });
        } catch (err) {
          refusal = err instanceof Error ? err.message : String(err);
        }
        let pass = false;
        let detail = `the waiting reply has no cycle: ${JSON.stringify(waitingReply.slice(0, 200))}`;
        if (cycle !== null) {
          await waitPast(cycle);
          const firstNew = firstEventOf(await readTimedLog(), 2);
          const codeAfter = await callTool(client, 'get_code', {});
          pass = refusal !== null && firstNew !== null && firstNew.begin === cycle && codeAfter.includes('v: 2');
          detail = JSON.stringify({
            line: cycle,
            refused: refusal !== null,
            firstNewBegin: firstNew === null ? null : firstNew.begin,
            codeHasWaiting: codeAfter.includes('v: 2'),
          });
        }
        report('takeover refused: a refused change leaves the waiting change in place', pass, detail);
      }

      // A change that arrives after the gate passed its line (the new code is already queued from the line on,
      // the line is not audible yet) finds a change that plays: it is recorded, and Claude is not told it was replaced.
      {
        await resetTimedLog();
        await callTool(client, 'set_code', { code: timedCode(1, 'setcps(1);\n'), label: 'probe timed reached old' });
        await sleep(2500);
        const reachedLabel = 'probe timed reached one';
        const reply = await callTool(client, 'set_code', { code: timedCode(2, ''), label: reachedLabel, at: 'bar' });
        const cycle = cycleOf(reply);
        let pass = false;
        let detail = `the reply has no cycle: ${JSON.stringify(reply.slice(0, 200))}`;
        if (cycle !== null) {
          // A hand evaluation (Ctrl+Enter, stored setting: now) in the page, the moment the scheduler's frontier passes the line.
          const handCode = timedCode(3, '// probereachedhand\nsetcps(1);\n');
          const fired = await evaluateExpr(
            cdp,
            `new Promise((resolve) => {
              const ed = document.getElementById('repl').editor;
              const scheduler = ed.repl.scheduler;
              const timer = setInterval(() => {
                if (scheduler.lastEnd > ${cycle}) {
                  clearInterval(timer);
                  const now = scheduler.now();
                  ed.setCode(${JSON.stringify(handCode)});
                  ed.evaluate();
                  resolve({ now });
                }
              }, 4);
              setTimeout(() => { clearInterval(timer); resolve(null); }, 20000);
            })`,
          );
          await waitPast(cycle, 1);
          const log = await readTimedLog();
          const codeAfter = await callTool(client, 'get_code', {});
          const historyAfter = await callTool(client, 'list_history', {});
          const note = 'a newer change replaced it';
          const told = countOf(codeAfter, note) + countOf(historyAfter, note);
          const firstReached = firstEventOf(log, 2);
          const firstHand = firstEventOf(log, 3);
          pass =
            fired !== null &&
            fired.now < cycle &&
            firstReached !== null &&
            firstReached.begin === cycle &&
            firstHand !== null &&
            firstHand.begin > cycle &&
            codeAfter.includes('probereachedhand') &&
            historyAfter.includes(reachedLabel) &&
            told === 0;
          detail = JSON.stringify({
            line: cycle,
            handEvaluatedAt: fired === null ? null : fired.now,
            firstReachedBegin: firstReached === null ? null : firstReached.begin,
            firstHandBegin: firstHand === null ? null : firstHand.begin,
            codeHasHand: codeAfter.includes('probereachedhand'),
            historyHasReached: historyAfter.includes(reachedLabel),
            toldReplaced: told,
          });
        }
        report('takeover reached: a change that arrives after the gate passed the line is recorded, not replaced', pass, detail);
      }

      // A painter in the code makes the Drawer query the pattern up to two cycles ahead of the
      // scheduler, inside the change's own evaluation and on every animation frame. Those queries carry no `cyclist`
      // control and must not count as "the line is reached": the takeover lands on the line, the tempo of the waiting
      // code applies there, and a second change before the line still cancels the first instead of finishing it early.
      // `.punchcard()` registers a painter with the Drawer (onPaint); in the pinned bundle `.pianoroll()` does not (it
      // runs its own animation loop on the code's own pattern), so it would not exercise the Drawer's queries.
      {
        const painted = (version, head) => `${timedCode(version, head)}.punchcard()`;
        // The tempo of a waiting change that has a painter: the old tempo until the line, the new one from it.
        await resetTimedLog();
        await callTool(client, 'set_code', { code: painted(1, 'setcps(0.5);\n'), label: 'probe painter tempo old' });
        await sleep(3500);
        const reply = await callTool(client, 'set_code', { code: painted(2, 'setcpm(45);\n'), label: 'probe painter tempo new', at: 'bar' });
        const cycle = cycleOf(reply);
        const cpsAtReply = await readPageCps();
        const codeAtReply = await callTool(client, 'get_code', {});
        let tempoPass = false;
        let tempoDetail = `the reply has no cycle: ${JSON.stringify(reply.slice(0, 200))}`;
        if (cycle !== null) {
          await waitPast(cycle + 1);
          const cpsAfter = await readPageCps();
          const log = await readTimedLog();
          const lastOld = log.filter((e) => e.v === 1).reduce((best, e) => (best === null || e.begin > best.begin ? e : best), null);
          const firstNew = firstEventOf(log, 2);
          if (lastOld !== null && firstNew !== null) {
            const expected = lastOld.target + 1 / 8 / 0.5;
            const offsetMs = (firstNew.target - expected) * 1000;
            tempoPass =
              cpsAtReply === 0.5 && codeAtReply.includes('v: 1') && !codeAtReply.includes('v: 2') && cpsAfter === 0.75 && firstNew.begin === cycle && Math.abs(offsetMs) < 1;
            tempoDetail = JSON.stringify({ line: cycle, cpsAtReply, cpsAfter, firstNewBegin: firstNew.begin, offsetMs, codeAtReplyHasNew: codeAtReply.includes('v: 2') });
          } else {
            tempoDetail = JSON.stringify({ line: cycle, oldEvents: log.filter((e) => e.v === 1).length, newEvents: log.filter((e) => e.v === 2).length });
          }
        }
        report('takeover painter: a change with a painter lands on the line and its tempo applies there', tempoPass, tempoDetail);

        // A second change before the line replaces the first (which never plays or records) instead of finishing it early.
        await resetTimedLog();
        await callTool(client, 'set_code', { code: painted(1, 'setcps(0.5);\n'), label: 'probe painter replaced old' });
        await sleep(3500);
        const firstLabel = 'probe painter replaced one';
        const secondLabel = 'probe painter replaced two';
        const firstReply = await callTool(client, 'set_code', { code: painted(2, ''), label: firstLabel, at: 'bar' });
        const secondReply = await callTool(client, 'set_code', { code: painted(3, ''), label: secondLabel, at: 'bar' });
        const secondCycle = cycleOf(secondReply);
        let replacedPass = false;
        let replacedDetail = `the second reply has no cycle: ${JSON.stringify(secondReply.slice(0, 200))}`;
        if (secondCycle !== null) {
          await waitPast(secondCycle, 1);
          const log = await readTimedLog();
          const firstNew = firstEventOf(log, 3);
          const replacedEvents = log.filter((e) => e.v === 2).length;
          const beforeLine = log.filter((e) => e.v === 3 && e.begin < secondCycle).length;
          const codeAfter = await callTool(client, 'get_code', {});
          const historyAfter = await callTool(client, 'list_history', {});
          replacedPass =
            cycleOf(firstReply) !== null &&
            firstNew !== null &&
            firstNew.begin === secondCycle &&
            beforeLine === 0 &&
            replacedEvents === 0 &&
            codeAfter.includes('v: 3') &&
            !historyAfter.includes(firstLabel) &&
            historyAfter.includes(secondLabel) &&
            countOf(secondReply, 'a newer change replaced it') === 1;
          replacedDetail = JSON.stringify({
            line: secondCycle,
            firstNewBegin: firstNew === null ? null : firstNew.begin,
            replacedEvents,
            newBeforeLine: beforeLine,
            historyHasReplaced: historyAfter.includes(firstLabel),
            historyHasNewer: historyAfter.includes(secondLabel),
          });
        }
        report('takeover painter: a second change before the line replaces the first, which never plays', replacedPass, replacedDetail);
        await callTool(client, 'set_code', { code: 'setcps(1);\n', label: 'probe painter reset' });
      }

      // The line is measured at the tempo that plays, not at the tempo the waiting code sets. A change from a fast
      // tempo to a slow one used to get a line as close as an eighth of the minimum lead, because the slow tempo had
      // already reached the scheduler when the line was computed.
      {
        const secondsOf = (reply) => {
          const match = /in about (\d+(?:\.\d+)?) s/.exec(reply);
          return match === null ? null : Number(match[1]);
        };
        const seen = [];
        let pass = true;
        for (let round = 0; round < 4; round++) {
          await resetTimedLog();
          await callTool(client, 'set_code', { code: timedCode(1, 'setcps(2);\n'), label: 'probe timed lead old' });
          await sleep(1200 + round * 130);
          const reply = await callTool(client, 'set_code', { code: timedCode(2, 'setcps(0.25);\n'), label: 'probe timed lead slow', at: 'bar' });
          const seconds = secondsOf(reply);
          const cycle = cycleOf(reply);
          seen.push({ cycle, seconds });
          if (seconds === null || cycle === null || seconds < 0.4) pass = false;
          if (cycle !== null) await waitPast(cycle, 0.5);
        }
        report('takeover lead: the line is at least half a second ahead at the tempo that plays, also into a slower tempo', pass, JSON.stringify({ seen }));
      }

      // A tempo above what a reply can state (500 cps is 120000 BPM) never costs the whole reply: the server's
      // schema would drop it and set_code would time out while the code plays. The reply arrives without a tempo line.
      {
        await callTool(client, 'set_code', { code: 'setcps(1);\nnote("c").gain(0)', label: 'probe huge tempo old' });
        let reply = null;
        let failure = null;
        try {
          reply = await callTool(client, 'set_code', { code: 'setcps(500);\nnote("c").gain(0)', label: 'probe huge tempo' });
        } catch (err) {
          failure = err instanceof Error ? err.message : String(err);
        }
        await callTool(client, 'set_code', { code: 'setcps(1);\nnote("c").gain(0)', label: 'probe huge tempo back' });
        report(
          'takeover reply: a tempo above what a reply can state does not cost the reply',
          reply !== null && reply.startsWith('ok, playing') && !reply.includes('Tempo:'),
          JSON.stringify({ failure, reply: reply === null ? null : reply.slice(0, 200) }),
        );
      }

      // A tempo that rounds to 0.0 BPM (cps 0.0001) is the lower bound of the same problem: the
      // server's schema wants a tempo above 0, so the reply leaves it out instead of being dropped whole.
      {
        await callTool(client, 'set_code', { code: 'setcps(1);\nnote("c").gain(0)', label: 'probe tiny tempo old' });
        let reply = null;
        let failure = null;
        try {
          reply = await callTool(client, 'set_code', { code: 'setcps(0.0001);\nnote("c").gain(0)', label: 'probe tiny tempo' });
        } catch (err) {
          failure = err instanceof Error ? err.message : String(err);
        }
        await callTool(client, 'set_code', { code: 'setcps(1);\nnote("c").gain(0)', label: 'probe tiny tempo back' });
        report(
          'takeover reply: a tempo that rounds to 0.0 BPM does not cost the reply',
          reply !== null && reply.startsWith('ok, playing') && !reply.includes('Tempo:'),
          JSON.stringify({ failure, reply: reply === null ? null : reply.slice(0, 200) }),
        );
      }

      // A change that waits is replaced by a hand evaluation that was queued behind it while it evaluated (a slow
      // program): its reply says it waited, and Claude is told once that a newer change replaced it. The page cannot
      // be made to run the replacing evaluation before the reply is answered (a few promise hops decide it), so this
      // checks the visible result of both orders; the unit tests pin the record's cancel reason the reply relies on.
      {
        await resetTimedLog();
        await callTool(client, 'set_code', { code: timedCode(1, 'setcps(1);\n'), label: 'probe timed slow old' });
        await sleep(2500);
        const slowLabel = 'probe timed slow one';
        const slowCode = `await new Promise((resolve) => setTimeout(resolve, 1200));\n${timedCode(2, '')}`;
        const slowReply = callTool(client, 'set_code', { code: slowCode, label: slowLabel, at: 'phrase', phraseCycles: 8 });
        await sleep(500);
        // A hand evaluation (Ctrl+Enter), queued behind the slow one while it still evaluates.
        await evaluateExpr(
          cdp,
          `(() => { const ed = document.getElementById('repl').editor; ed.setCode(${JSON.stringify(timedCode(3, '// probeslowhand\nsetcps(1);\n'))}); ed.evaluate(); return true; })()`,
        );
        const reply = await slowReply;
        await sleep(600);
        const codeAfter = await callTool(client, 'get_code', {});
        const historyAfter = await callTool(client, 'list_history', {});
        const note = 'a newer change replaced it';
        const told = countOf(reply, note) + countOf(codeAfter, note) + countOf(historyAfter, note);
        const log = await readTimedLog();
        const pass =
          !reply.includes('ok, playing') &&
          cycleOf(reply) !== null &&
          codeAfter.includes('probeslowhand') &&
          !historyAfter.includes(slowLabel) &&
          log.filter((e) => e.v === 2).length === 0 &&
          told === 1;
        report(
          'takeover replaced: a waiting change replaced before its reply is answered still tells Claude once',
          pass,
          JSON.stringify({
            reply: reply.slice(0, 300),
            codeHasHand: codeAfter.includes('probeslowhand'),
            historyHasSlow: historyAfter.includes(slowLabel),
            slowEvents: log.filter((e) => e.v === 2).length,
            toldTimes: told,
          }),
        );
      }

      // The order the check above (a waiting change replaced by a hand evaluation) cannot force. The reply of the waiting change is held back in
      // the page (its evaluation promise resolves late) while a hand evaluation, queued behind it, replaces it. The
      // handleEvaluate branch for a change replaced before its reply then runs: the reply says the change waited, and the
      // cancel follows it exactly once. The frames the page sends, with a marker for the moment the hand evaluation was
      // installed, prove the order: the marker comes before the reply of the waiting change, which is followed by one
      // cancel with the reason replaced. (While the reply is held, the page still counts its run as in flight, so it does
      // not report the hand evaluation to the server; the page's own code is what is checked.)
      {
        await resetTimedLog();
        await callTool(client, 'set_code', { code: timedCode(1, 'setcps(1);\n'), label: 'probe forced old' });
        await sleep(2500);
        const forcedLabel = 'probe forced one';
        const handCode = timedCode(3, '// probeforcedhand\nsetcps(1);\n');
        await evaluateExpr(
          cdp,
          `(() => {
            const ed = document.getElementById('repl').editor;
            const original = ed.repl.evaluate;
            const nativeSend = WebSocket.prototype.send;
            window.__forcedSent = [];
            WebSocket.prototype.send = function (data) {
              try {
                const message = JSON.parse(data);
                window.__forcedSent.push({ type: message.type, id: message.id, reason: message.reason });
              } catch {
                // not a JSON frame
              }
              return nativeSend.call(this, data);
            };
            window.__restoreForced = () => {
              ed.repl.evaluate = original;
              WebSocket.prototype.send = nativeSend;
            };
            ed.repl.evaluate = function (code, ...rest) {
              const run = original.call(this, code, ...rest);
              if (typeof code !== 'string' || !code.includes('probeforcedone')) return run;
              // The hand evaluation (Ctrl+Enter) queues behind this run while it evaluates; its promise marks, in the same
              // list as the frames, when the replacing change was installed.
              setTimeout(() => {
                ed.setCode(${JSON.stringify(handCode)});
                ed.evaluate().then(() => window.__forcedSent.push({ type: 'marker:hand-installed' }));
              }, 20);
              return run.then((value) => new Promise((resolve) => setTimeout(() => resolve(value), 1500)));
            };
            return true;
          })()`,
        );
        let reply = null;
        let sent = [];
        try {
          reply = await callTool(client, 'set_code', {
            code: timedCode(2, '// probeforcedone\n'),
            label: forcedLabel,
            at: 'phrase',
            phraseCycles: 8,
          });
          await sleep(600);
          sent = await evaluateExpr(cdp, `window.__forcedSent`);
        } finally {
          await evaluateExpr(cdp, `(() => { window.__restoreForced(); return true; })()`);
        }
        const codeAfter = await callTool(client, 'get_code', {});
        const historyAfter = await callTool(client, 'list_history', {});
        const log = await readTimedLog();
        const note = 'a newer change replaced it';
        const handAt = sent.findIndex((message) => message.type === 'marker:hand-installed');
        const pageCode = await evaluateExpr(cdp, `document.getElementById('repl').editor.repl.state.activeCode`);
        const evaluatedAt = sent.findIndex((message) => message.type === 'evaluated');
        const cancels = sent.filter((message) => message.type === 'takeover-canceled');
        const cancelAt = sent.findIndex((message) => message.type === 'takeover-canceled');
        const pass =
          reply !== null &&
          !reply.includes('ok, playing') &&
          cycleOf(reply) !== null &&
          handAt >= 0 &&
          evaluatedAt > handAt &&
          cancels.length === 1 &&
          cancels[0].reason === 'replaced' &&
          cancels[0].id === sent[evaluatedAt].id &&
          cancelAt > evaluatedAt &&
          countOf(reply, note) + countOf(codeAfter, note) + countOf(historyAfter, note) === 1 &&
          pageCode.includes('probeforcedhand') &&
          !historyAfter.includes(forcedLabel) &&
          log.filter((e) => e.v === 2).length === 0;
        report(
          'takeover replaced: a change replaced before its reply is answered as waiting, then canceled once',
          pass,
          JSON.stringify({
            reply: reply === null ? null : reply.slice(0, 300),
            order: sent.map((message) => `${message.type}${message.reason ? `:${message.reason}` : ''}`),
            cancels: cancels.length,
            pageCodeHasHand: pageCode.includes('probeforcedhand'),
            historyHasForced: historyAfter.includes(forcedLabel),
            forcedEvents: log.filter((e) => e.v === 2).length,
          }),
        );
        await callTool(client, 'set_code', { code: 'setcps(1);\nnote("c").gain(0)', label: 'probe forced reset' });
      }

      // A waiting change that takes over inside a newer Claude evaluation must not make the newer
      // code's runtime errors read as "from an earlier version". The newer evaluation is held in the page until the waiting
      // change's gate has passed its line, so the takeover falls inside it (settled by the newer change, or by the timer).
      {
        await resetTimedLog();
        await callTool(client, 'set_code', { code: timedCode(1, 'setcps(0.5);\n'), label: 'probe tag old' });
        await sleep(3500);
        const waitingLabel = 'probe tag waiting';
        const waitingReply = await callTool(client, 'set_code', { code: timedCode(2, ''), label: waitingLabel, at: 'bar' });
        const cycle = cycleOf(waitingReply);
        let pass = false;
        let detail = `the reply has no cycle: ${JSON.stringify(waitingReply.slice(0, 200))}`;
        if (cycle !== null) {
          await evaluateExpr(
            cdp,
            `(() => {
              const ed = document.getElementById('repl').editor;
              const original = ed.repl.evaluate;
              window.__restoreTagEvaluate = () => { ed.repl.evaluate = original; };
              ed.repl.evaluate = function (code, ...rest) {
                if (typeof code !== 'string' || !code.includes('probetagnewer')) return original.call(this, code, ...rest);
                return new Promise((resolve, reject) => {
                  const go = () => {
                    clearInterval(timer);
                    clearTimeout(giveUp);
                    original.call(this, code, ...rest).then(resolve, reject);
                  };
                  const timer = setInterval(() => { if (ed.repl.scheduler.lastEnd > ${cycle}) go(); }, 4);
                  const giveUp = setTimeout(go, 20000);
                });
              };
              return true;
            })()`,
          );
          const newerCode = [
            '// probetagnewer',
            'const probeFrom = getTime()',
            `note("c3 e3").add(note(signal((t) => (t - probeFrom >= 2 ? 'zz' : 0)).segment(2))).gain(0)`,
          ].join('\n');
          let newerReply = null;
          try {
            newerReply = await callTool(client, 'set_code', { code: newerCode, label: 'probe tag newer' });
          } finally {
            await evaluateExpr(cdp, `(() => { window.__restoreTagEvaluate(); return true; })()`);
          }
          // The failing cycles start two cycles after the newer change (4 s at 0.5 cps); wait until they are over.
          await sleep(8000);
          const codeAfter = await callTool(client, 'get_code', {});
          const historyAfter = await callTool(client, 'list_history', {});
          const lines = codeAfter.split('\n').filter((line) => line.includes(QUERY_ERROR_LEAD));
          pass =
            newerReply.startsWith('ok, playing') &&
            lines.length === 1 &&
            lines[0].startsWith('Runtime error while playing') &&
            !lines[0].includes('earlier version') &&
            historyAfter.includes(waitingLabel);
          detail = JSON.stringify({ line: cycle, reply: newerReply.slice(0, 80), errorLines: lines, historyHasWaiting: historyAfter.includes(waitingLabel) });
        }
        report('takeover tag: a change that takes over inside a newer evaluation does not make its runtime errors read as an earlier version', pass, detail);
        await callTool(client, 'set_code', { code: 'setcps(1);\nnote("c").gain(0)', label: 'probe tag reset' });
      }

      // Stop in the moment between the gate's first query past the line and the line itself cancels
      // the change, whose tempo was already applied. The tempo of the music that played goes back with the cancel.
      {
        await resetTimedLog();
        await callTool(client, 'set_code', { code: timedCode(1, 'setcps(0.5);\n'), label: 'probe stop tempo old' });
        await sleep(3500);
        const reply = await callTool(client, 'set_code', { code: timedCode(2, 'setcpm(45);\n'), label: 'probe stop tempo new', at: 'bar' });
        const cycle = cycleOf(reply);
        let pass = false;
        let detail = `the reply has no cycle: ${JSON.stringify(reply.slice(0, 200))}`;
        if (cycle !== null) {
          const stopped = await evaluateExpr(
            cdp,
            `new Promise((resolve) => {
              const scheduler = document.getElementById('repl').editor.repl.scheduler;
              const timer = setInterval(() => {
                if (scheduler.lastEnd > ${cycle}) {
                  clearInterval(timer);
                  const seen = { now: scheduler.now(), cps: scheduler.cps };
                  document.querySelector(${JSON.stringify(TRANSPORT_SELECTOR)}).click();
                  resolve(seen);
                }
              }, 4);
              setTimeout(() => { clearInterval(timer); resolve(null); }, 20000);
            })`,
          );
          await sleep(600);
          const cpsAfter = await readPageCps();
          pass = stopped !== null && stopped.now < cycle && stopped.cps === 0.75 && cpsAfter === 0.5;
          detail = JSON.stringify({ line: cycle, atStop: stopped, cpsAfterStop: cpsAfter });
        }
        report('takeover stop: a change canceled after its tempo was applied gives the tempo that played back', pass, detail);
        await callTool(client, 'set_code', { code: 'setcps(1);\nnote("c").gain(0)', label: 'probe stop tempo reset' });
      }

      // Stop before a waiting change's line puts back the music that played (here the music of an earlier timed
      // change, A). The scheduler restarts it from cycle 0 on Play without an evaluation (Strudel's own repl start, which
      // no page control does yet), and a query error of that music must still reach Claude once. A fails only for
      // spans below cycle 1: its test query from its line (cycle 3 or later) and its playing pass, the restart fails.
      {
        await resetTimedLog();
        await callTool(client, 'set_code', { code: timedCode(1, 'setcps(1);\n'), label: 'probe restored old' });
        await sleep(2500);
        const restoredCodeA = [
          '// proberestoreda',
          `note("c3 e3").add(note(signal((t) => (t < 1 ? 'zz' : 0)).segment(2))).gain(0)`,
        ].join('\n');
        const aReply = await callTool(client, 'set_code', { code: restoredCodeA, label: 'probe restored a', at: 'bar' });
        const aLine = cycleOf(aReply);
        let pass = false;
        let detail = `the reply of A has no cycle: ${JSON.stringify(aReply.slice(0, 200))}`;
        if (aLine !== null) {
          await waitPast(aLine);
          const codeAfterA = await callTool(client, 'get_code', {});
          const bReply = await callTool(client, 'set_code', {
            code: timedCode(2, '// proberestoredb\n'),
            label: 'probe restored b',
            at: 'phrase',
            phraseCycles: 8,
          });
          const bLine = cycleOf(bReply);
          const stopReply = await callTool(client, 'stop', {});
          const codeAfterStop = await callTool(client, 'get_code', {});
          const playStarted = await evaluateExpr(
            cdp,
            `(async () => {
              await globalThis.getAudioContext().resume();
              const editor = document.getElementById('repl').editor;
              await editor.repl.start();
              return editor.repl.scheduler.started === true;
            })()`,
          );
          await waitPast(1);
          const playFirst = await callTool(client, 'get_code', {});
          await sleep(3000);
          const playSecond = await callTool(client, 'get_code', {});
          const errorLines = (text) => text.split('\n').filter((line) => line.includes(QUERY_ERROR_LEAD));
          const afterAErrors = errorLines(codeAfterA);
          const afterStopErrors = errorLines(codeAfterStop);
          const firstErrors = errorLines(playFirst);
          const secondErrors = errorLines(playSecond);
          const notice = 'did not take over: the music was stopped';
          const told = countOf(stopReply, notice) + countOf(codeAfterStop, notice);
          pass =
            bLine !== null &&
            codeAfterA.includes('proberestoreda') &&
            afterAErrors.length === 0 &&
            codeAfterStop.includes('proberestoreda') &&
            !codeAfterStop.includes('proberestoredb') &&
            afterStopErrors.length === 0 &&
            told === 1 &&
            playStarted === true &&
            firstErrors.length === 1 &&
            firstErrors[0].startsWith('Runtime error while playing') &&
            !firstErrors[0].includes('repeated') &&
            !firstErrors[0].includes('earlier version') &&
            secondErrors.length === 0;
          detail = JSON.stringify({
            aLine,
            bLine,
            codeAfterAHasA: codeAfterA.includes('proberestoreda'),
            codeAfterStopHasA: codeAfterStop.includes('proberestoreda'),
            codeAfterStopHasB: codeAfterStop.includes('proberestoredb'),
            toldStopped: told,
            playStarted,
            afterAErrors,
            afterStopErrors,
            firstErrors,
            secondErrors,
          });
        }
        report('takeover restored: after Stop puts back the music that played, its query error after Play reaches Claude once', pass, detail);
        await callTool(client, 'stop', {});
        await callTool(client, 'set_code', { code: 'setcps(1);\nnote("c").gain(0)', label: 'probe restored reset' });
      }
    }

    // --- edit_code in the real page ---
    // Placed before the first block that changes the stored hand-evaluation setting, so a hand evaluation takes over at once.
    {
      const cycleOf = (reply) => {
        const match = /takes over at cycle (\d+)/.exec(reply);
        return match === null ? null : Number(match[1]);
      };
      const waitPast = async (cycle, extra = 0.5) => {
        const deadline = Date.now() + 40000;
        while ((await readSchedulerNow(cdp)) < cycle + extra && Date.now() < deadline) await sleep(100);
        await sleep(400);
      };
      const countOf = (text, phrase) => text.split(phrase).length - 1;
      const handEvaluate = (code) =>
        evaluateExpr(
          cdp,
          `(() => { const ed = document.getElementById('repl').editor; ed.setCode(${JSON.stringify(code)}); ed.evaluate(); return true; })()`,
        );
      const editorText = () => evaluateExpr(cdp, `document.getElementById('repl').editor.code`);
      const editCode = (edits, extra = {}) => callTool(client, 'edit_code', { edits, ...extra });
      const swap = (from, to) => [{ old_string: from, new_string: to }];
      // The program the page should hold; updated by splitting and joining on the unique replaced text.
      const EDIT_PIECE = [
        'setcps(1);',
        ...[1101, 1202, 1303, 1404].flatMap((value, i) => [
          `t${i + 1}: note("c3 e3 g3")`,
          '  .s("sawtooth")',
          `  .lpf(${value})`,
          '  .room(0.1)',
          '  .gain(0)',
        ]),
      ].join('\n');
      let current = EDIT_PIECE;
      const replaceIn = (text, from, to) => text.split(from).join(to);

      // A one-value edit on a long piece: the reply shows only the changed lines, the page holds the edited program.
      {
        await callTool(client, 'set_code', { code: EDIT_PIECE, label: 'probe edit base' });
        await sleep(1500);
        const reply = await editCode(swap('.lpf(1202)', '.lpf(1222)'), { label: 'probe edit one' });
        current = replaceIn(current, '.lpf(1202)', '.lpf(1222)');
        const got = await callTool(client, 'get_code', {});
        const editor = await editorText();
        const checks = {
          starts: reply.startsWith('ok, playing'),
          head: reply.includes('Edited 1 place in the code playing now'),
          shows: reply.includes('.lpf(1222)'),
          noOthers: ['.lpf(1101)', '.lpf(1404)', 't1: note', 't3: note', 't4: note'].every((text) => !reply.includes(text)),
          getCodeStarts: got.startsWith(current),
          getCodeHint: got.includes('edit_code sends only the change'),
          editorEquals: editor === current,
        };
        report(
          'edit_code real page: a one-value edit on a long piece takes over, the reply shows only the changed lines, get_code and the editor hold the edited program',
          Object.values(checks).every(Boolean),
          JSON.stringify({ ...checks, replyChars: reply.length, programChars: current.length }),
        );
      }

      // CRLF in old_string matches the LF code.
      {
        let reply = '';
        let error = null;
        try {
          reply = await editCode(swap('.lpf(1303)\r\n  .room(0.1)', '.lpf(1333)\r\n  .room(0.1)'));
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
        }
        current = replaceIn(current, '.lpf(1303)', '.lpf(1333)');
        const got = await callTool(client, 'get_code', {});
        const pass = error === null && got.includes('.lpf(1333)') && !got.includes('\r') && got.startsWith(current);
        report(
          'edit_code real page: an old_string with CRLF line ends matches the LF code',
          pass,
          JSON.stringify({ error, replyStart: reply.slice(0, 120), hasNewValue: got.includes('.lpf(1333)'), hasCr: got.includes('\r') }),
        );
      }

      // A hand edit evaluated in the page stays, and the reply says the edit was applied on top of it.
      {
        await handEvaluate(`${current}\n// probeedithand`);
        await sleep(600);
        current = `${current}\n// probeedithand`;
        let reply = '';
        let error = null;
        try {
          reply = await editCode(swap('.lpf(1101)', '.lpf(1111)'));
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
        }
        current = replaceIn(current, '.lpf(1101)', '.lpf(1111)');
        const got = await callTool(client, 'get_code', {});
        const checks = {
          noError: error === null,
          said: reply.includes('your edit was applied on top of it'),
          handKept: got.includes('// probeedithand'),
          editApplied: got.includes('.lpf(1111)'),
        };
        report(
          'edit_code real page: a hand edit evaluated in the page stays and the reply says the edit was applied on top of it',
          Object.values(checks).every(Boolean),
          JSON.stringify({ ...checks, error, replyStart: reply.slice(0, 200) }),
        );
      }

      // A refused edit changes nothing: not the editor, not get_code.
      {
        const editorBefore = await editorText();
        const codeBefore = await callTool(client, 'get_code', {});
        const result = await client.callTool({
          name: 'edit_code',
          arguments: { edits: swap('.lpf(9999)', '.lpf(9998)') },
        });
        const text = (result.content ?? []).map((entry) => entry.text ?? '').join('\n');
        const editorAfter = await editorText();
        const codeAfter = await callTool(client, 'get_code', {});
        const checks = {
          isError: result.isError === true,
          nowhere: text.includes('matches nowhere'),
          editorSame: editorAfter === editorBefore,
          getCodeSame: codeAfter === codeBefore,
        };
        report(
          'edit_code real page: a refused edit leaves the editor and get_code unchanged',
          Object.values(checks).every(Boolean),
          JSON.stringify({ ...checks, replyStart: text.slice(0, 200) }),
        );
      }

      // An edit of a change that waits for its phrase line keeps that change's code and takes over at its line.
      {
        const waitingCode = `${current}\n// probeeditwaiting`;
        const reply = await callTool(client, 'set_code', {
          code: waitingCode,
          label: 'probe edit waiting',
          at: 'phrase',
          phraseCycles: 8,
        });
        const lineA = cycleOf(reply);
        const reply2 = await editCode(swap('.lpf(1222)', '.lpf(1232)'), { at: 'phrase', phraseCycles: 8 });
        const lineB = cycleOf(reply2);
        const duringWait = await callTool(client, 'get_code', {});
        let after = '';
        if (typeof lineB === 'number') {
          await waitPast(lineB);
          after = await callTool(client, 'get_code', {});
        }
        const checks = {
          linesAreNumbers: typeof lineA === 'number' && typeof lineB === 'number',
          namesTheWaitingChange: reply2.includes(`in the change waiting for cycle ${lineA}`),
          replacedNoticeOnce: countOf(reply2, 'a newer change replaced it') === 1,
          waitingNotShown: !duringWait.includes('probeeditwaiting'),
          afterHasWaitingCode: after.includes('// probeeditwaiting') && after.includes('.lpf(1232)'),
        };
        report(
          "edit_code real page: an edit of a change waiting for its phrase line keeps that change's code and takes over at its line",
          Object.values(checks).every(Boolean),
          JSON.stringify({ ...checks, lineA, lineB, reply2Start: reply2.slice(0, 260) }),
        );
        current = replaceIn(waitingCode, '.lpf(1222)', '.lpf(1232)');
      }

      // The takeover of a timed edit built on a hand edit that was just evaluated never claims it replaced that
      // hand edit. The same takeover of a timed set_code does, and that control run shows the note can reach this
      // check, so the first assertion can fail when the suppression regresses.
      {
        const NOTE = 'replaced code that had been edited by hand';
        await callTool(client, 'get_code', {}); // drains the notes of the earlier blocks

        await handEvaluate(`${current}\n// probehandtimed`);
        await sleep(600);
        current = `${current}\n// probehandtimed`;
        const editReply = await editCode(swap('.lpf(1232)', '.lpf(1242)'), { at: 'phrase', phraseCycles: 8 });
        const editLine = cycleOf(editReply);
        let editAfter = '';
        if (typeof editLine === 'number') {
          await waitPast(editLine);
          editAfter = await callTool(client, 'get_code', {});
        }
        current = replaceIn(current, '.lpf(1232)', '.lpf(1242)');
        const editChecks = {
          lineIsNumber: typeof editLine === 'number',
          saidKept: editReply.includes('your edit was applied on top of it'),
          takenOver: editAfter.includes('.lpf(1242)') && editAfter.includes('// probehandtimed'),
          noFalseHandEditNote: !editAfter.includes(NOTE),
        };
        report(
          'edit_code real page: a timed edit built on a hand edit takes over without claiming it replaced the hand edit',
          Object.values(editChecks).every(Boolean),
          JSON.stringify({ ...editChecks, editLine, editReplyStart: editReply.slice(0, 260) }),
        );

        await handEvaluate(`${current}\n// probehandcontrol`);
        await sleep(600);
        const controlCode = `${current}\n// probecontrolsetcode`;
        const controlReply = await callTool(client, 'set_code', { code: controlCode, at: 'phrase', phraseCycles: 8 });
        const controlLine = cycleOf(controlReply);
        let controlAfter = '';
        if (typeof controlLine === 'number') {
          await waitPast(controlLine);
          controlAfter = await callTool(client, 'get_code', {});
        }
        current = controlCode;
        const controlChecks = {
          lineIsNumber: typeof controlLine === 'number',
          takenOver: controlAfter.includes('// probecontrolsetcode'),
          noteShown: controlAfter.includes(NOTE),
        };
        report(
          'edit_code real page: control, a timed set_code over a hand edit does say it replaced the hand edit',
          Object.values(controlChecks).every(Boolean),
          JSON.stringify({ ...controlChecks, controlLine, controlReplyStart: controlReply.slice(0, 200) }),
        );
      }

      await callTool(client, 'set_code', { code: 'setcps(1);\nnote("c").gain(0)', label: 'probe edit reset' });
    }

    // --- hand evaluations follow the stored setting; the views, Mixer and Parts follow what plays ---
    {
      const STORED_KEY = 'moontide.changeTiming';
      const timedCode = (version, head) =>
        `${head}ticks: s("hh*8").onTrigger((hap, now, cps, targetTime) => { (window.__takeoverLog = window.__takeoverLog || []).push({ v: ${version}, begin: hap.whole.begin.valueOf(), target: targetTime, cps }); }, true)`;
      const resetLog = () => evaluateExpr(cdp, `(() => { window.__takeoverLog = []; })()`);
      const readLog = () =>
        evaluateExpr(cdp, `window.__takeoverLog.map((e) => ({ v: e.v, begin: Number(e.begin), target: Number(e.target), cps: Number(e.cps) }))`);
      const cycleOf = (reply) => {
        const match = /takes over at cycle (\d+)/.exec(reply);
        return match === null ? null : Number(match[1]);
      };
      const countOf = (text, phrase) => text.split(phrase).length - 1;
      const waitPast = async (cycle, extra = 0.5) => {
        const deadline = Date.now() + 40000;
        while ((await readSchedulerNow(cdp)) < cycle + extra && Date.now() < deadline) await sleep(100);
        await sleep(400);
      };
      // Stores the setting under the key the page reads, then reloads so the page starts from it.
      const storeTiming = async (value) => {
        await evaluateExpr(cdp, `(() => { localStorage.setItem(${JSON.stringify(STORED_KEY)}, ${JSON.stringify(value)}); })()`);
        await reloadPage(cdp);
      };
      // A hand evaluation: the editor text is set and editor.evaluate() runs, like Ctrl+Enter (no armed run).
      const handEvaluate = (code) =>
        evaluateExpr(
          cdp,
          `(() => { const ed = document.getElementById('repl').editor; ed.setCode(${JSON.stringify(code)}); ed.evaluate(); return true; })()`,
        );
      // Waits until the scheduler is just past a multiple of `cycles`, so the next line of that length is far away.
      const alignAfterLine = async (cycles) => {
        const deadline = Date.now() + 40000;
        for (;;) {
          const now = await readSchedulerNow(cdp);
          const into = now % cycles;
          if (into > 0.1 && into < 0.6) return now;
          if (Date.now() > deadline) throw new ProbeCouldNotRun('the scheduler never came just past a phrase line');
          await sleep(40);
        }
      };
      // The id of the newest version row of a list_history reply (the list is capped, so a count would not move).
      const topId = (text) => {
        const match = /^#(\d+) /m.exec(text);
        return match === null ? null : Number(match[1]);
      };
      const blurEditor = () =>
        evaluateExpr(cdp, `(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); })()`);
      // Opens the view of `key` ('2' Timeline, '3' Mixer, '4' Parts) whatever view is open now.
      const openView = async (key, name) => {
        await blurEditor();
        if ((await evaluateExpr(cdp, `document.getElementById('workspace').dataset.view`)) !== 'none') await pressKey(cdp, 'Escape');
        await pressKey(cdp, key);
        const shown = await waitFor(cdp, `document.getElementById('workspace').dataset.view === ${JSON.stringify(name)} ? true : null`, 3000);
        if (shown !== true) throw new ProbeCouldNotRun(`the ${name} view did not open`);
      };
      const evalErrorHidden = () => evaluateExpr(cdp, `document.getElementById('eval-error').hidden`);

      // A hand evaluation under the stored setting lands on the line (next bar, next phrase) and reaches the history there.
      const handLine = async (timing, multiple) => {
        const token = `probehand${timing}`;
        await storeTiming(timing);
        await resetLog();
        await callTool(client, 'set_code', { code: timedCode(1, 'setcps(1);\n'), label: `probe hand ${timing} old` });
        await sleep(2500);
        // A phrase is told from a bar only when the request comes just after a phrase line.
        if (multiple > 1) await alignAfterLine(multiple);
        const nowAtRequest = await readSchedulerNow(cdp);
        await handEvaluate(timedCode(2, `// ${token}\nsetcps(1);\n`));
        await sleep(300);
        const codeBefore = await callTool(client, 'get_code', {});
        const historyBefore = await callTool(client, 'list_history', {});
        const deadline = Date.now() + 30000;
        let log = await readLog();
        while (!log.some((e) => e.v === 2) && Date.now() < deadline) {
          await sleep(200);
          log = await readLog();
        }
        const oldEvents = log.filter((e) => e.v === 1);
        const newEvents = log.filter((e) => e.v === 2);
        const lastOld = oldEvents.reduce((best, e) => (best === null || e.begin > best.begin ? e : best), null);
        const firstNew = newEvents.reduce((best, e) => (best === null || e.begin < best.begin ? e : best), null);
        if (lastOld === null || firstNew === null) {
          return { pass: false, detail: JSON.stringify({ oldEvents: oldEvents.length, newEvents: newEvents.length }) };
        }
        const line = Math.round(lastOld.begin + 1 / 8);
        await waitPast(line, 1);
        let historyAfter = await callTool(client, 'list_history', {});
        const historyDeadline = Date.now() + 5000;
        while (!historyAfter.includes(token) && Date.now() < historyDeadline) {
          await sleep(200);
          historyAfter = await callTool(client, 'list_history', {});
        }
        log = await readLog();
        const oldAtOrAfter = log.filter((e) => e.v === 1 && e.begin >= line);
        const newBefore = log.filter((e) => e.v === 2 && e.begin < line);
        const first = log.filter((e) => e.v === 2).reduce((best, e) => (best === null || e.begin < best.begin ? e : best), null);
        const pass =
          line % multiple === 0 &&
          (multiple === 1 || line - nowAtRequest >= 2.5) &&
          first !== null &&
          first.begin === line &&
          oldAtOrAfter.length === 0 &&
          newBefore.length === 0 &&
          lastOld.begin >= nowAtRequest + 0.25 &&
          codeBefore.includes('v: 1') &&
          !codeBefore.includes('v: 2') &&
          !historyBefore.includes(token) &&
          historyAfter.includes(token);
        return {
          pass,
          detail: JSON.stringify({
            line,
            multiple,
            nowAtRequest,
            firstNewBegin: first === null ? null : first.begin,
            lastOldBegin: lastOld.begin,
            oldAtOrAfter: oldAtOrAfter.length,
            newBefore: newBefore.length,
            codeBeforeHasOld: codeBefore.includes('v: 1'),
            codeBeforeHasNew: codeBefore.includes('v: 2'),
            historyBeforeHasHand: historyBefore.includes(token),
            historyAfterHasHand: historyAfter.includes(token),
          }),
        };
      };
      const bar = await handLine('bar', 1);
      report('takeover hand: a hand edit under next bar lands on the line', bar.pass, bar.detail);
      const phrase = await handLine('phrase', 4);
      report('takeover hand: a hand edit under next phrase lands on a multiple of 4', phrase.pass, phrase.detail);

      // Claude's timing and the hand setting never cross.
      {
        await storeTiming('bar');
        await resetLog();
        await callTool(client, 'set_code', { code: timedCode(1, 'setcps(1);\n'), label: 'probe hand cross old' });
        await sleep(2000);
        const plainReply = await callTool(client, 'set_code', { code: timedCode(2, ''), label: 'probe hand cross plain' });
        const plainCode = await callTool(client, 'get_code', {});
        const plainPass = cycleOf(plainReply) === null && !plainReply.includes('takes over at') && plainCode.includes('v: 2');
        await storeTiming('now');
        await resetLog();
        await callTool(client, 'set_code', { code: timedCode(1, 'setcps(1);\n'), label: 'probe hand cross old again' });
        await sleep(2000);
        await alignAfterLine(8);
        const waitingLabel = 'probe hand cross phrase';
        const waitingReply = await callTool(client, 'set_code', { code: timedCode(3, ''), label: waitingLabel, at: 'phrase', phraseCycles: 8 });
        const waitingLine = cycleOf(waitingReply);
        await handEvaluate(timedCode(4, '// probehandcross\nsetcps(1);\n'));
        const replies = [];
        let codeNow = '';
        const codeDeadline = Date.now() + 6000;
        while (!codeNow.includes('probehandcross') && Date.now() < codeDeadline) {
          await sleep(200);
          codeNow = await callTool(client, 'get_code', {});
          replies.push(codeNow);
        }
        let pass = false;
        let detail = `the phrase reply has no cycle: ${JSON.stringify(waitingReply.slice(0, 200))}`;
        if (waitingLine !== null) {
          await waitPast(waitingLine, 1);
          const log = await readLog();
          const history = await callTool(client, 'list_history', {});
          replies.push(history);
          const note = 'a newer change replaced it';
          const told = replies.reduce((sum, text) => sum + countOf(text, note), 0);
          pass =
            plainPass &&
            codeNow.includes('probehandcross') &&
            log.filter((e) => e.v === 3).length === 0 &&
            log.filter((e) => e.v === 4).length > 0 &&
            !history.includes(waitingLabel) &&
            history.includes('probehandcross') &&
            told === 1;
          detail = JSON.stringify({
            plainPass,
            handTookOverAtOnce: codeNow.includes('probehandcross'),
            phraseEvents: log.filter((e) => e.v === 3).length,
            handEvents: log.filter((e) => e.v === 4).length,
            historyHasPhrase: history.includes(waitingLabel),
            toldTimes: told,
          });
        }
        report("takeover hand: Claude's timing and the hand setting never cross", pass, detail);
      }

      // From here on the setting stays at now: Claude's own timing is what makes a change wait.
      await storeTiming('now');
      const VIEW_BASE = 'setcps(1)\nkeys: s("hh*8").gain(0)';
      const VIEW_NEW = `${VIEW_BASE}\nbass: s("bd*2").gain(0)`;
      const waitingSetup = async (oldCode, newCode, label) => {
        await callTool(client, 'set_code', { code: oldCode, label: `${label} old` });
        await sleep(1500);
        await alignAfterLine(8);
        const reply = await callTool(client, 'set_code', { code: newCode, label, at: 'phrase', phraseCycles: 8 });
        return { reply, line: cycleOf(reply) };
      };

      // The Timeline reads the playing code while a change waits.
      {
        await callTool(client, 'set_code', { code: VIEW_BASE, label: 'probe views base' });
        await openView('2', 'timeline');
        const laneNames = `[...document.querySelectorAll('#timeline-lanes .lane-name')].map((el) => el.textContent)`;
        await waitFor(cdp, `${laneNames}.length === 1 ? true : null`, 8000);
        const { line } = await waitingSetup(VIEW_BASE, VIEW_NEW, 'probe views new');
        let pass = false;
        let detail = 'the change has no line';
        if (line !== null) {
          await sleep(1500);
          const nowDuring = await readSchedulerNow(cdp);
          const during = await evaluateExpr(cdp, laneNames);
          await waitPast(line, 0.5);
          const after = await waitFor(cdp, `${laneNames}.includes('bass') ? ${laneNames} : null`, 15000);
          pass = nowDuring < line && during.length === 1 && during[0] === 'keys' && after !== null && after.includes('bass');
          detail = JSON.stringify({ line, nowDuring, during, after });
        }
        report('takeover views: the Timeline reads the playing code while a change waits', pass, detail);
      }

      // The Mixer waits with a calm notice: off while the change waits, neutral, not on the red error line.
      {
        const MIXER_BASE = 'setcps(1)\ndrums: s("bd*4").gain(0)\nhats: s("hh*8").gain(0)';
        const MIXER_NEW = `${MIXER_BASE}\nperc: s("cp*2").gain(0)`;
        await callTool(client, 'set_code', { code: MIXER_BASE, label: 'probe mixer wait base' });
        await openView('3', 'mixer');
        await waitFor(cdp, `document.querySelectorAll('#mixer-strips .mx-strip').length === 2 ? true : null`, 5000);
        const { line } = await waitingSetup(MIXER_BASE, MIXER_NEW, 'probe mixer wait new');
        let pass = false;
        let detail = 'the change has no line';
        if (line !== null) {
          const state = `(() => {
            const n = document.getElementById('mixer-notice');
            const faders = [...document.querySelectorAll('#mixer-strips .mx-fader')];
            return { hidden: n.hidden, text: n.textContent, faders: faders.length, disabled: faders.filter((f) => f.disabled).length, strips: document.querySelectorAll('#mixer-strips .mx-strip').length };
          })()`;
          const during = await waitFor(
            cdp,
            `(() => { const st = ${state}; return !st.hidden && st.text === ${JSON.stringify(MIXER_COPY.waiting)} ? st : null; })()`,
            3000,
          );
          const errorHiddenDuring = await evalErrorHidden();
          await waitPast(line, 0.5);
          const after = await waitFor(cdp, `(() => { const st = ${state}; return st.hidden && st.strips === 3 ? st : null; })()`, 8000);
          pass =
            during !== null &&
            during.faders === 2 &&
            during.disabled === 2 &&
            during.strips === 2 &&
            errorHiddenDuring === true &&
            after !== null;
          detail = JSON.stringify({ line, during, errorHiddenDuring, after });
        }
        report('takeover mixer: the Mixer waits with a calm notice', pass, detail);
      }

      // A part launch waits with a calm notice and records nothing.
      {
        const PARTS_BASE = 'setcps(1)\nmain: arrange([4, s("bd").gain(0)], [4, s("hh").gain(0)])';
        const PARTS_NEW = `${PARTS_BASE}\nextra: s("cp*2").gain(0)`;
        await callTool(client, 'set_code', { code: PARTS_BASE, label: 'probe parts wait base' });
        await openView('4', 'parts');
        await waitFor(cdp, `document.querySelectorAll('#parts-rows .part-card').length === 2 ? true : null`, 5000);
        const { line } = await waitingSetup(PARTS_BASE, PARTS_NEW, 'probe parts wait new');
        let pass = false;
        let detail = 'the change has no line';
        if (line !== null) {
          const historyBefore = await callTool(client, 'list_history', {});
          await clickElement(cdp, '#parts-rows .part-card:nth-child(2)');
          await sleep(800);
          const messageDuring = await evaluateExpr(
            cdp,
            `(() => { const m = document.getElementById('parts-message'); return { hidden: m.hidden, text: m.textContent }; })()`,
          );
          const errorHiddenDuring = await evalErrorHidden();
          const historyDuring = await callTool(client, 'list_history', {});
          await waitPast(line, 0.5);
          const historyAfter = await callTool(client, 'list_history', {});
          pass =
            messageDuring.hidden === false &&
            messageDuring.text === PARTS_COPY.waiting &&
            errorHiddenDuring === true &&
            topId(historyBefore) !== null &&
            topId(historyDuring) === topId(historyBefore) &&
            historyAfter.includes('probe parts wait new') &&
            topId(historyAfter) === topId(historyBefore) + 1;
          detail = JSON.stringify({
            line,
            messageDuring,
            errorHiddenDuring,
            newestBefore: topId(historyBefore),
            newestDuring: topId(historyDuring),
            newestAfter: topId(historyAfter),
          });
        }
        report('takeover parts: a part launch waits with a calm notice', pass, detail);
      }

      // A restore takes over at once and replaces a waiting change.
      {
        const oldLabel = 'probe restore old';
        await resetLog();
        await callTool(client, 'set_code', { code: timedCode(1, 'setcps(1);\n'), label: oldLabel });
        const listing = await callTool(client, 'list_history', {});
        const oldRow = listing.split('\n').find((row) => row.includes(oldLabel));
        const oldId = oldRow === undefined ? null : Number((/^#(\d+) /.exec(oldRow) ?? [])[1]);
        await sleep(1500);
        await alignAfterLine(8);
        const waitingLabel = 'probe restore waiting';
        const waitingReply = await callTool(client, 'set_code', { code: timedCode(2, ''), label: waitingLabel, at: 'phrase', phraseCycles: 8 });
        let pass = false;
        let detail = `no id for the old version or no waiting line: ${JSON.stringify({ oldId, waitingReply: waitingReply.slice(0, 120) })}`;
        if (oldId !== null && Number.isInteger(oldId) && cycleOf(waitingReply) !== null) {
          const restoreReply = await callTool(client, 'restore_version', { id: oldId });
          const codeNow = await callTool(client, 'get_code', {});
          const history = await callTool(client, 'list_history', {});
          const note = 'a newer change replaced it';
          const told = countOf(restoreReply, note) + countOf(codeNow, note) + countOf(history, note);
          await waitPast(cycleOf(waitingReply), 0.5);
          const log = await readLog();
          pass =
            !restoreReply.includes('takes over at cycle') &&
            codeNow.includes('v: 1') &&
            !codeNow.includes('v: 2') &&
            told === 1 &&
            !history.includes(waitingLabel) &&
            log.filter((e) => e.v === 2).length === 0;
          detail = JSON.stringify({
            restoreHasPending: restoreReply.includes('takes over at cycle'),
            codeHasRestored: codeNow.includes('v: 1'),
            codeHasWaiting: codeNow.includes('v: 2'),
            toldTimes: told,
            historyHasWaiting: history.includes(waitingLabel),
            waitingEvents: log.filter((e) => e.v === 2).length,
          });
        }
        report('takeover restore: a restore replaces a waiting change at once', pass, detail);
      }

      // After Stop cancels a waiting change, the new text is an unevaluated edit for the Mixer.
      {
        const STOP_BASE = 'setcps(1)\ndrums: s("bd*4").gain(0)\nhats: s("hh*8").gain(0)';
        const STOP_NEW = `${STOP_BASE}\nperc: s("cp*2").gain(0)`;
        await callTool(client, 'set_code', { code: STOP_BASE, label: 'probe stop mixer base' });
        await sleep(1500);
        await alignAfterLine(8);
        const waitingReply = await callTool(client, 'set_code', { code: STOP_NEW, label: 'probe stop mixer new', at: 'phrase', phraseCycles: 8 });
        await stopMusic(cdp);
        await sleep(500);
        const codeAfter = await callTool(client, 'get_code', {});
        await openView('3', 'mixer');
        const notice = await waitFor(
          cdp,
          `(() => {
            const n = document.getElementById('mixer-notice');
            const faders = [...document.querySelectorAll('#mixer-strips .mx-fader')];
            return !n.hidden && n.textContent === ${JSON.stringify(MIXER_COPY.dirty)} ? { text: n.textContent, faders: faders.length, disabled: faders.filter((f) => f.disabled).length, strips: document.querySelectorAll('#mixer-strips .mx-strip').length } : null;
          })()`,
          5000,
        );
        report(
          'takeover stop: after Stop the Mixer treats the new text as an unevaluated edit',
          cycleOf(waitingReply) !== null &&
            notice !== null &&
            notice.strips === 2 &&
            notice.faders === notice.disabled &&
            codeAfter.includes('drums:') &&
            !codeAfter.includes('perc:'),
          JSON.stringify({ waitingReply: waitingReply.slice(0, 120), notice, codeHasOld: codeAfter.includes('drums:'), codeHasNew: codeAfter.includes('perc:') }),
        );
        await pressKey(cdp, 'Escape');
      }

      // Later checks start from the setting at now and music that plays.
      await evaluateExpr(cdp, `(() => { localStorage.setItem('moontide.changeTiming', 'now'); })()`);
      await callTool(client, 'set_code', { code: 'setcps(0.5)', label: 'probe takeover hand reset tempo' });
    }

    // --- the top bar shows the tempo, the countdown and the hand-edit setting ---
    {
      const STORED_KEY = 'moontide.changeTiming';
      const BAR_BASE = 'setcps(1)\nticks: s("hh*8").gain(0)';
      const cycleOf = (reply) => {
        const match = /takes over at cycle (\d+)/.exec(reply);
        return match === null ? null : Number(match[1]);
      };
      const waitPast = async (cycle, extra = 0.5) => {
        const deadline = Date.now() + 40000;
        while ((await readSchedulerNow(cdp)) < cycle + extra && Date.now() < deadline) await sleep(100);
        await sleep(400);
      };
      // Waits until the scheduler is just past a multiple of `cycles`, so the next line of that length is far away.
      const alignAfterLine = async (cycles) => {
        const deadline = Date.now() + 40000;
        for (;;) {
          const now = await readSchedulerNow(cdp);
          const into = now % cycles;
          if (into > 0.1 && into < 0.6) return now;
          if (Date.now() > deadline) throw new ProbeCouldNotRun('the scheduler never came just past a phrase line');
          await sleep(40);
        }
      };
      // What the top bar shows: the visible text (innerText leaves out the squeezed parts), or null while hidden.
      const barState = () =>
        evaluateExpr(
          cdp,
          `(() => {
            const el = (id) => document.getElementById(id);
            const shown = (e) => (e.hidden ? null : e.innerText);
            // The readout is always displayed: the dash stands for "no tempo" and reads as null here, with
            // the raw text and whether it is displayed kept beside it, so a check can require both.
            const tempoEl = el('tempo-readout');
            const tempoRaw = tempoEl.innerText.trim();
            return {
              tempo: tempoRaw === ${JSON.stringify(tempoText({ playing: false }).text)} ? null : tempoRaw,
              tempoRaw,
              tempoDisplayed: !tempoEl.hidden && tempoEl.getClientRects().length > 0,
              tempoName: tempoEl.getAttribute('aria-label'),
              pending: shown(el('pending-change')),
              pendingTitle: el('pending-change').title,
              pendingCount: document.querySelectorAll('#pending-change').length,
              status: el('change-status').textContent,
              evalErrorHidden: el('eval-error').hidden,
            };
          })()`,
        );
      const waitBar = async (predicate, timeoutMs = 5000) => {
        const deadline = Date.now() + timeoutMs;
        let state = await barState();
        while (!predicate(state) && Date.now() < deadline) {
          await sleep(100);
          state = await barState();
        }
        return { ok: predicate(state), state };
      };
      // The texts below are the full forms, so the page is as wide as a 1920 px screen unless a check narrows it.
      const WIDE = { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false };
      await cdp('Emulation.setDeviceMetricsOverride', WIDE);
      const setTiming = async (value) => {
        await evaluateExpr(cdp, `(() => { localStorage.setItem(${JSON.stringify(STORED_KEY)}, ${JSON.stringify(value)}); })()`);
        await reloadPage(cdp);
      };

      // The setting: three buttons now, next bar, next phrase, one pressed; a press sets it and says the line; remembered across a reload.
      {
        await setTiming('now');
        const options = timingOptions();
        // The pointer is moved away first: hovering a button brightens it, which would hide the quiet color of an unpressed one.
        const read = async () => {
          await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 600 });
          await sleep(100);
          return evaluateExpr(
            cdp,
            `(() => {
              const group = document.getElementById('change-timing');
              const resolve = (name) => {
                const el = document.createElement('span');
                el.style.color = 'var(' + name + ')';
                document.body.appendChild(el);
                const color = getComputedStyle(el).color;
                el.remove();
                return color;
              };
              const buttons = [...group.querySelectorAll('button')].map((button) => ({
                value: button.dataset.value,
                text: button.textContent,
                name: button.getAttribute('aria-label'),
                type: button.type,
                pressed: button.getAttribute('aria-pressed'),
                color: getComputedStyle(button).color,
                background: getComputedStyle(button).backgroundColor,
              }));
              return {
                role: group.getAttribute('role'),
                label: group.getAttribute('aria-label'),
                title: group.title,
                tag: group.tagName,
                buttons,
                stored: localStorage.getItem(${JSON.stringify(STORED_KEY)}),
                text: resolve('--text'),
                muted: resolve('--text-muted'),
                status: document.getElementById('change-status').textContent,
              };
            })()`,
          );
        };
        const one = (state, value) => state.buttons.filter((b) => b.pressed === 'true').map((b) => b.value).join() === value && state.buttons.filter((b) => b.pressed === 'false').length === 2;
        const first = await read();
        const states = [first];
        const order = ['bar', 'phrase', 'now'];
        for (const value of order) {
          await pickTiming(cdp, value);
          await sleep(150);
          states.push(await read());
        }
        await pickTiming(cdp, 'bar');
        await sleep(150);
        const beforeReload = await read();
        await reloadPage(cdp);
        const afterReload = await read();
        // Back to the default for everything that follows (bar, phrase, now).
        await pickTiming(cdp, 'now');
        await sleep(150);
        const reset = await read();
        const values = ['now', ...order];
        const spoken = ['', settingLine('bar'), settingLine('phrase'), settingLine('now')];
        const shape =
          first.tag === 'DIV' &&
          first.role === 'group' &&
          first.label === 'Your edits take over' &&
          first.title === CHANGE_COPY.timingTitle &&
          first.buttons.length === 3 &&
          first.buttons.every((b, index) => b.value === options[index].value && b.text === options[index].label && b.name === options[index].name && b.type === 'button');
        const presses = states.every(
          (state, index) =>
            one(state, values[index]) &&
            state.stored === values[index] &&
            state.buttons.every((b) => (b.pressed === 'true' ? b.color === state.text && b.background !== state.buttons.find((o) => o.pressed === 'false').background : b.color === state.muted)) &&
            (index === 0 || state.status === spoken[index]),
        );
        const persists = beforeReload.stored === 'bar' && one(beforeReload, 'bar') && one(afterReload, 'bar') && afterReload.stored === 'bar';
        report(
          'top bar: the three timing buttons set the setting, say the line and persist across a reload',
          shape && presses && persists && one(reset, 'now') && reset.stored === 'now',
          JSON.stringify({ shape, presses, persists, pressed: states.map((state) => state.buttons.find((b) => b.pressed === 'true').value), stored: states.map((state) => state.stored), afterReload: afterReload.buttons.map((b) => b.pressed), reset: reset.buttons.map((b) => b.pressed), spoken: states.map((state) => state.status) }),
        );
      }

      // Records every text the readout and the countdown ever show, so a check can read the whole sequence.
      await evaluateExpr(
        cdp,
        `(() => {
          window.__bar = { tempo: [], pending: [] };
          const watch = (id, list) => {
            const el = document.getElementById(id);
            new MutationObserver(() => { list.push(el.hidden ? null : el.innerText); })
              .observe(el, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['hidden'] });
          };
          watch('tempo-readout', window.__bar.tempo);
          watch('pending-change', window.__bar.pending);
        })()`,
      );
      const seen = () => evaluateExpr(cdp, `({ tempo: window.__bar.tempo.slice(), pending: window.__bar.pending.slice() })`);
      const hasTempo = (text) => (state) => state.tempo === text;
      // The idle readout: the dash and BPM, in the bar, displayed (so an always-visible readout is proven, not assumed).
      const IDLE_TEMPO = tempoText({ playing: false }).text;
      const isIdleShown = (state) => state.tempo === null && state.tempoRaw === IDLE_TEMPO && state.tempoDisplayed === true;

      // The tempo follows Claude's changes, a pattern control, a hand edit and a restore.
      {
        const results = {};
        const expectTempo = async (name, text) => {
          const { ok, state } = await waitBar(hasTempo(text), 6000);
          results[name] = { ok, shown: state.tempo, name: state.tempoName };
          return ok;
        };
        await callTool(client, 'set_code', { code: 'setcps(0.5)\nticks: s("hh*8").gain(0)', label: 'probe top bar tempo 120' });
        await expectTempo('setcps 0.5', '120 BPM');
        const nameOk = results['setcps 0.5'].name === tempoText({ playing: true, bpm: 120 }).name;
        // Not redrawn per tick: several polls pass and the readout is not written again.
        const writesBefore = (await seen()).tempo.length;
        await sleep(1300);
        const quiet = (await seen()).tempo.length === writesBefore;
        await callTool(client, 'set_code', { code: 'setcpm(24)\nticks: s("hh*8").gain(0)', label: 'probe top bar tempo 96' });
        await expectTempo('setcpm 24', '96 BPM');
        await callTool(client, 'set_code', { code: 'setcps(0.4025)\nticks: s("hh*8").gain(0)', label: 'probe top bar tempo 96.6' });
        await expectTempo('setcps 0.4025', '96.6 BPM');
        await callTool(client, 'set_code', { code: 'setcps(0.5)\nticks: s("hh*8").gain(0).cps(0.75)', label: 'probe top bar tempo pattern' });
        await expectTempo('pattern cps 0.75', '180 BPM');
        await evaluateExpr(
          cdp,
          `(() => { const ed = document.getElementById('repl').editor; ed.setCode('setcps(0.25)\\nticks: s("hh*8").gain(0)'); ed.evaluate(); return true; })()`,
        );
        await expectTempo('hand edit 0.25', '60 BPM');
        const oldLabel = 'probe top bar restore old';
        await callTool(client, 'set_code', { code: 'setcps(0.5)\nticks: s("hh*8").gain(0)', label: oldLabel });
        const listing = await callTool(client, 'list_history', {});
        const oldRow = listing.split('\n').find((row) => row.includes(oldLabel));
        const oldId = oldRow === undefined ? null : Number((/^#(\d+) /.exec(oldRow) ?? [])[1]);
        await callTool(client, 'set_code', { code: 'setcps(0.75)\nticks: s("hh*8").gain(0)', label: 'probe top bar restore newer' });
        await expectTempo('newer 0.75', '180 BPM');
        if (oldId !== null && Number.isInteger(oldId)) {
          await callTool(client, 'restore_version', { id: oldId });
          await expectTempo('restore', '120 BPM');
        } else {
          results.restore = { ok: false, shown: null, name: `no id for the old version: ${JSON.stringify(oldRow ?? null)}` };
        }
        const all = (await seen()).tempo;
        const shapeOk = all.every((text) => text === null || text === IDLE_TEMPO || /^\d+(\.\d)? BPM$/.test(text));
        report(
          'top bar: the tempo follows the music',
          Object.values(results).every((entry) => entry.ok) && nameOk && quiet && shapeOk,
          JSON.stringify({ results, nameOk, quiet, shapeOk, distinct: [...new Set(all)] }),
        );
      }

      // A value like 1000.5 BPM stays on one line inside the bar, with tabular digits, even at 1024 px.
      {
        await callTool(client, 'set_code', { code: 'setcps(4.16875)\nticks: s("hh*8").gain(0)', label: 'probe top bar tempo 1000.5' });
        const long = await waitBar(hasTempo('1000.5 BPM'), 6000);
        await cdp('Emulation.setDeviceMetricsOverride', { width: 1024, height: 768, deviceScaleFactor: 1, mobile: false });
        await sleep(300);
        const geometry = await evaluateExpr(
          cdp,
          `(() => {
            const el = document.getElementById('tempo-readout');
            const bar = document.getElementById('top-bar');
            const lineHeight = parseFloat(getComputedStyle(el).lineHeight);
            return {
              oneLine: el.offsetHeight < lineHeight * 1.5,
              whole: el.scrollWidth <= el.clientWidth,
              inside: el.getBoundingClientRect().right <= bar.getBoundingClientRect().right,
              tabular: getComputedStyle(el.querySelector('.tempo-num')).fontVariantNumeric.includes('tabular-nums'),
              text: el.innerText,
            };
          })()`,
        );
        await cdp('Emulation.setDeviceMetricsOverride', WIDE);
        await callTool(client, 'set_code', { code: BAR_BASE, label: 'probe top bar tempo back' });
        report(
          'top bar: a 1000.5 BPM readout stays on one line inside the bar with tabular digits',
          long.ok && geometry.oneLine && geometry.whole && geometry.inside && geometry.tabular,
          JSON.stringify(geometry),
        );
      }

      // A waiting change shows the countdown, replaced in place by a newer one, and it ends at the line.
      {
        await callTool(client, 'set_code', { code: BAR_BASE, label: 'probe top bar countdown base' });
        await waitBar(hasTempo('240 BPM'), 6000);
        const idle = await barState();
        await alignAfterLine(8);
        const firstReply = await callTool(client, 'set_code', {
          code: `${BAR_BASE}\n// waiting one`,
          label: 'probe top bar waiting phrase',
          at: 'phrase',
          phraseCycles: 8,
        });
        const first = await waitBar((state) => state.pending !== null, 3000);
        const secondReply = await callTool(client, 'set_code', { code: `${BAR_BASE}\n// waiting two`, label: 'probe top bar waiting bar', at: 'bar' });
        const second = await waitBar((state) => state.pending !== null && state.pendingTitle.includes('next bar'), 3000);
        const line = cycleOf(secondReply);
        let ended = { ok: false, state: second.state };
        if (line !== null) {
          await waitPast(line, 0.5);
          ended = await waitBar((state) => state.pending === null && state.status === '', 4000);
        }
        // Every wait is one run of texts between two hidden moments; each run only counts down.
        const sequence = (await seen()).pending;
        const runs = [];
        let run = [];
        for (const text of sequence) {
          if (text === null) {
            if (run.length > 0) runs.push(run);
            run = [];
          } else {
            run.push(text);
          }
        }
        if (run.length > 0) runs.push(run);
        const rank = (text) => {
          const bars = /^Change in (\d+) bars$/.exec(text);
          if (bars) return [2, Number(bars[1])];
          const beats = /^Change in (\d+) beats$/.exec(text);
          if (beats) return [1, Number(beats[1])];
          return text === 'Change in 1 beat' ? [0, 1] : null;
        };
        const countsDown = runs.every((texts) => {
          const ranks = texts.map(rank);
          if (ranks.some((entry) => entry === null)) return false;
          return ranks.every((entry, index) => index === 0 || entry[0] < ranks[index - 1][0] || (entry[0] === ranks[index - 1][0] && entry[1] <= ranks[index - 1][1]));
        });
        const neverOneBar = sequence.every((text) => text === null || !/\b1 bar\b/.test(text));
        report(
          'top bar: the countdown shows only while a change waits',
          idle.pending === null &&
            !idle.status.startsWith('Change waiting') &&
            cycleOf(firstReply) !== null &&
            first.ok &&
            first.state.pendingTitle === 'A code change is waiting. It takes over on the next phrase.' &&
            first.state.status === queuedLine('phrase') &&
            second.ok &&
            second.state.pendingCount === 1 &&
            second.state.status === queuedLine('bar') &&
            line !== null &&
            ended.ok &&
            countsDown &&
            neverOneBar,
          JSON.stringify({
            idle: idle.pending,
            first: { text: first.state.pending, title: first.state.pendingTitle, status: first.state.status },
            second: { text: second.state.pending, title: second.state.pendingTitle, status: second.state.status, elements: second.state.pendingCount },
            endedPending: ended.state.pending,
            endedStatus: ended.state.status,
            runs: runs.length,
            countsDown,
            neverOneBar,
            lastTexts: sequence.slice(-6),
          }),
        );
      }

      // A change the check refuses never shows a countdown, and the old music keeps playing.
      {
        let refusal = null;
        try {
          await callTool(client, 'set_code', { code: 'ticks: s("hh*8"', label: 'probe top bar refused', at: 'bar' });
        } catch (err) {
          refusal = err instanceof Error ? err.message : String(err);
        }
        await sleep(600);
        const state = await barState();
        report(
          'top bar: a refused timed change shows no countdown',
          refusal !== null && state.pending === null && state.evalErrorHidden === false && state.tempo === '240 BPM' && state.status === '',
          JSON.stringify({ refused: refusal !== null, pending: state.pending, evalErrorHidden: state.evalErrorHidden, tempo: state.tempo, status: state.status }),
        );
        await callTool(client, 'set_code', { code: BAR_BASE, label: 'probe top bar after refusal' });
      }

      // Nothing clips from 1024 to 1920 px with everything shown, and the fit step is a function of the width.
      let waitingForStop = false;
      {
        // The setting at next phrase (the longest form), and a change that waits a long time.
        await pickTiming(cdp, 'phrase');
        await sleep(150);
        const longWait = await callTool(client, 'set_code', { code: `${BAR_BASE}\n// long wait`, label: 'probe top bar long wait', at: 'phrase', phraseCycles: 32 });
        waitingForStop = cycleOf(longWait) !== null;
        await waitBar((state) => state.pending !== null, 3000);
        // Layout-only setup of the widest case: the build line, "wait for Claude", a single-port MIDI indicator.
        const saved = await evaluateExpr(
          cdp,
          `(() => {
            const el = (id) => document.getElementById(id);
            const saved = {
              build: { hidden: el('build-mismatch').hidden, text: el('build-mismatch').textContent },
              requests: { hidden: el('page-requests').hidden, text: el('page-requests-state').textContent },
              midi: { hidden: el('midi-state').hidden, text: el('midi-state-text').textContent },
              dots: { hidden: el('midi-dots').hidden, html: el('midi-dots').innerHTML },
            };
            el('build-mismatch').textContent = ${JSON.stringify(BUILD_MISMATCH_COPY.line)};
            el('build-mismatch').hidden = false;
            el('page-requests-state').textContent = ${JSON.stringify(PAGE_REQUESTS_COPY.waiting)};
            el('page-requests').hidden = false;
            el('midi-state-text').textContent = 'MIDI: sub connected';
            el('midi-state').hidden = false;
            return saved;
          })()`,
        );
        const measure = () =>
          evaluateExpr(
            cdp,
            `(() => {
              const el = (id) => document.getElementById(id);
              const bar = el('top-bar');
              const root = parseFloat(getComputedStyle(document.documentElement).fontSize);
              const lineOf = (node) => parseFloat(getComputedStyle(node).lineHeight);
              const items = {};
              // The bar's own items: whole and on one line, as before.
              for (const id of [${JSON.stringify(TRANSPORT_ID)}, 'tempo-readout', 'pending-change']) {
                const node = el(id);
                items[id] = { whole: node.scrollWidth <= node.clientWidth, oneLine: node.offsetHeight < lineOf(node) * 1.5, shown: !node.hidden };
              }
              // The items that moved into the Session drawer (open for this read) are shown with a box (an item that is
              // hidden or undisplayed never passes), whole in their card, and on their lines: the setting button on one line, the
              // texts wrapped by design (at most three lines) but never clipped.
              const drawerItem = ${DRAWER_ITEM_JS};
              for (const id of ['change-timing', 'midi-state', 'page-requests', 'build-mismatch']) {
                const measured = drawerItem(id);
                items[id] = { whole: measured.whole, oneLine: id === 'change-timing' ? measured.lines <= 1 : measured.lines <= 3, shown: measured.shown, lines: measured.lines };
              }
              // The Edits timing group is boxes, not text: its "lines" are the rows its three buttons sit on.
              const timingRows = new Set([...document.querySelectorAll('#change-timing button')].map((b) => Math.round(b.getBoundingClientRect().top))).size;
              items['change-timing'].oneLine = timingRows === 1;
              items['change-timing'].lines = timingRows;
              const motion = drawerItem('motion-switch');
              const barRect = bar.getBoundingClientRect();
              const session = el('session-button').getBoundingClientRect();
              const layoutButtons = [...document.querySelectorAll('#layout-buttons button')];
              return {
                width: window.innerWidth,
                fit: bar.dataset.fit,
                items,
                // The bar's own overflow (the fit loop's measure) replaces the old floor test; the spacer is what is left.
                barFits: bar.scrollWidth <= bar.clientWidth,
                spacer: el('bar-spacer').getBoundingClientRect().width,
                root,
                midiLines: items['midi-state'].lines,
                layoutInside: layoutButtons.length === 3 && layoutButtons.every((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.left >= barRect.left - 1 && r.right <= barRect.right + 1; }),
                // The Session button ends the bar: its right edge is inside it.
                sessionInside: session.width > 0 && session.left >= barRect.left - 1 && session.right <= barRect.right + 1,
                motionShown: motion.shown && motion.whole,
                settingName: el('change-timing').querySelector('button[aria-pressed="true"]').getAttribute('aria-label'),
                settingText: el('change-timing').querySelector('button[aria-pressed="true"]').textContent,
                countdown: el('pending-change').innerText,
              };
            })()`,
          );
        // The widest case ("full") has the build line; the normal case at 1024 px has none, and there the bar must
        // also fit. The version indicator is shown too, as it always is while music plays.
        const steps = [
          ['1920', 1920, true],
          ['1366', 1366, true],
          ['1024 full', 1024, true],
          ['1024 normal', 1024, false],
          ['again1920', 1920, true],
        ];
        const measureSteps = async () => {
          const measuredSteps = {};
          for (const [key, width, withBuildLine] of steps) {
            await evaluateExpr(cdp, `(() => { document.getElementById('build-mismatch').hidden = ${JSON.stringify(!withBuildLine)}; })()`);
            await cdp('Emulation.setDeviceMetricsOverride', { width, height: 768, deviceScaleFactor: 1, mobile: false });
            await sleep(300);
            measuredSteps[key] = await measure();
          }
          return measuredSteps;
        };
        // The drawer stays open through the three passes: every moved item is measured in its card.
        await openDrawer(cdp);
        const results = await measureSteps();
        // The same five steps with the longest text of the off indicator and six dots, four of them crossed.
        await evaluateExpr(
          cdp,
          `(() => {
            document.getElementById('midi-state-text').textContent = 'MIDI: 12 instruments on, 4 off';
            const dots = document.getElementById('midi-dots');
            dots.replaceChildren(...['filled', 'filled', 'off', 'off', 'off', 'off'].map((kind) => {
              const span = document.createElement('span');
              span.className = 'state-dot midi-dot';
              span.dataset.kind = kind;
              return span;
            }));
            dots.hidden = false;
          })()`,
        );
        const offResults = await measureSteps();
        // The widest indicator that exists without an off instrument, for comparison: the attention text of 39 characters in
        // weight 600 (data-attention) with six dots. The new longest text must not be wider than it.
        await evaluateExpr(
          cdp,
          `(() => {
            document.getElementById('midi-state-text').textContent = 'MIDI: 2 of 6 instruments need attention';
            document.getElementById('midi-state').dataset.attention = 'true';
            document.getElementById('midi-dots').replaceChildren(...['filled', 'hollow', 'filled', 'hollow', 'filled', 'filled'].map((kind) => {
              const span = document.createElement('span');
              span.className = 'state-dot midi-dot';
              span.dataset.kind = kind;
              return span;
            }));
          })()`,
        );
        const referenceResults = await measureSteps();
        await evaluateExpr(cdp, `delete document.getElementById('midi-state').dataset.attention`);
        await cdp('Emulation.setDeviceMetricsOverride', WIDE);
        await evaluateExpr(
          cdp,
          `(() => {
            const el = (id) => document.getElementById(id);
            const saved = ${JSON.stringify(saved)};
            el('build-mismatch').textContent = saved.build.text;
            el('build-mismatch').hidden = saved.build.hidden;
            el('page-requests-state').textContent = saved.requests.text;
            el('page-requests').hidden = saved.requests.hidden;
            el('midi-state-text').textContent = saved.midi.text;
            el('midi-state').hidden = saved.midi.hidden;
            el('midi-dots').innerHTML = saved.dots.html;
            el('midi-dots').hidden = saved.dots.hidden;
          })()`,
        );
        await sleep(300);
        await closeDrawer(cdp);
        const measured = Object.values(results);
        // No step is exempt from the overflow test any more (the 1024 step used to be); the bar's own overflow is tested at all five.
        const overflowChecked = (all) => all.every((m) => m.barFits);
        const nothingClips =
          measured.every((m) => Object.entries(m.items).every(([id, item]) => (id === 'build-mismatch' && !item.shown) || (item.shown && item.whole && item.oneLine)) && m.layoutInside && m.sessionInside && m.motionShown) &&
          overflowChecked(measured);
        report(
          'top bar: nothing clips at 1920, 1366 and 1024 px with every item shown',
          nothingClips,
          JSON.stringify(
            Object.fromEntries(
              Object.entries(results).map(([key, m]) => [
                key,
                {
                  fit: m.fit,
                  barFits: m.barFits,
                  spacer: Math.round(m.spacer),
                  layoutInside: m.layoutInside,
                  sessionInside: m.sessionInside,
                  unclipped: Object.entries(m.items).filter(([, item]) => item.shown && (!item.whole || !item.oneLine)).map(([id]) => id),
                },
              ]),
            ),
          ),
        );
        const offMeasured = Object.values(offResults);
        const referenceMeasured = Object.values(referenceResults);
        const offNothingClips =
          offMeasured.every((m) => Object.entries(m.items).every(([id, item]) => (id === 'build-mismatch' && !item.shown) || (item.shown && item.whole && item.oneLine))) &&
          overflowChecked(offMeasured) &&
          // No taller than the widest indicator that exists without an off instrument (it wraps in its card now), and inside its card wherever that one is.
          offMeasured.every((m, index) => m.midiLines <= referenceMeasured[index].midiLines && ((m.layoutInside && m.sessionInside && m.motionShown) || !(referenceMeasured[index].layoutInside && referenceMeasured[index].sessionInside && referenceMeasured[index].motionShown)));
        report(
          'top bar: nothing clips with the longest off text and six dots',
          offNothingClips,
          JSON.stringify(
            Object.fromEntries(
              Object.entries(offResults).map(([key, m]) => [
                key,
                {
                  fit: m.fit,
                  barFits: m.barFits,
                  spacer: Math.round(m.spacer),
                  midiLines: m.midiLines,
                  widestExistingMidiLines: referenceResults[key].midiLines,
                  layoutInside: m.layoutInside,
                  sessionInside: m.sessionInside,
                  referenceLayoutInside: referenceResults[key].layoutInside && referenceResults[key].sessionInside,
                  unclipped: Object.entries(m.items).filter(([, item]) => item.shown && (!item.whole || !item.oneLine)).map(([id]) => id),
                },
              ]),
            ),
          ),
        );
        report(
          'top bar: the fit step is a function of the width',
          results['1920'].fit === '0' &&
            results.again1920.fit === '0' &&
            Number(results['1024 full'].fit) >= Number(results['1366'].fit) &&
            Number(results['1366'].fit) >= Number(results['1920'].fit) &&
            measured.every((m) => m.settingName === 'Your edits take over at the next phrase') &&
            results['1920'].settingText === 'next phrase' &&
            results['1920'].countdown.startsWith('Change in '),
          JSON.stringify({
            fits: measured.map((m) => `${m.width}:${m.fit}`),
            names: [...new Set(measured.map((m) => m.settingName))],
            text1920: results['1920'].settingText,
            text1024: results['1024 full'].settingText,
            countdown1024: results['1024 full'].countdown,
            // The space the bar has left at the 1024 step with every item shown.
            spacer1024Full: Math.round(results['1024 full'].spacer),
            spacer1024Normal: Math.round(results['1024 normal'].spacer),
          }),
        );
      }

      // Stop clears the countdown and says so once.
      {
        const before = await barState();
        await stopMusic(cdp);
        const after = await waitBar((state) => state.pending === null && state.status === CHANGE_COPY.canceled && isIdleShown(state), 4000);
        report(
          'top bar: Stop clears the countdown and says Change canceled.',
          waitingForStop && before.pending !== null && before.status === queuedLine('phrase') && after.ok,
          JSON.stringify({ before: { pending: before.pending, status: before.status }, after: { pending: after.state.pending, status: after.state.status, tempo: after.state.tempo } }),
        );
      }

      // Back to the default setting for everything that follows (phrase, now).
      await pickTiming(cdp, 'now');
      await sleep(150);
      await evaluateExpr(cdp, `(() => { localStorage.setItem(${JSON.stringify(STORED_KEY)}, 'now'); })()`);

      // A tab that lost the sound role shows neither the tempo nor the countdown.
      {
        await callTool(client, 'set_code', { code: BAR_BASE, label: 'probe top bar superseded base' });
        await waitBar(hasTempo('240 BPM'), 6000);
        await alignAfterLine(8);
        await callTool(client, 'set_code', { code: `${BAR_BASE}\n// waiting before supersede`, label: 'probe top bar superseded wait', at: 'phrase', phraseCycles: 32 });
        const waiting = await waitBar((state) => state.pending !== null && state.tempo !== null, 3000);
        const secondTab = { id: null, ws: null, cdp: null };
        let superseded = null;
        let backAgain = null;
        try {
          const created = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' });
          if (!created.ok) throw new Error(`/json/new answered ${created.status}`);
          const info = await created.json();
          secondTab.id = info.id;
          secondTab.ws = new WebSocket(info.webSocketDebuggerUrl);
          await waitSocketOpen(secondTab.ws);
          secondTab.cdp = makeCdp(secondTab.ws);
          await secondTab.cdp('Runtime.enable');
          await secondTab.cdp('Page.enable');
          await secondTab.cdp('Page.navigate', { url: pageUrl });
          await waitConnected(secondTab.cdp, 15000);
          superseded = await waitBar((state) => state.pending === null && isIdleShown(state), 5000);
          await sleep(700);
          const stillHidden = await barState();
          superseded.stillHidden = stillHidden.pending === null && isIdleShown(stillHidden);
          // The other tab goes away, this one takes the role back and shows the tempo again.
          await secondTab.cdp('Page.navigate', { url: 'about:blank' });
          await waitFor(cdp, `(() => document.getElementById('midi-takeover-text').textContent === 'No tab is playing' ? true : null)()`, 5000);
          await evaluateExpr(cdp, `document.getElementById('take-back').click()`);
          await waitFor(cdp, `(() => document.getElementById('midi-takeover').hidden ? true : null)()`, 8000);
          backAgain = await waitBar((state) => state.tempo !== null, 8000);
        } finally {
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
        }
        report(
          'top bar: no tempo and no countdown when nothing plays or in a superseded tab',
          waiting.ok && superseded !== null && superseded.ok && superseded.stillHidden === true && backAgain !== null && backAgain.ok,
          JSON.stringify({
            before: { tempo: waiting.state.tempo, pending: waiting.state.pending },
            superseded: superseded === null ? null : { tempo: superseded.state.tempo, pending: superseded.state.pending, stillHidden: superseded.stillHidden },
            backAgain: backAgain === null ? null : backAgain.state.tempo,
          }),
        );
      }

      await callTool(client, 'set_code', { code: 'setcps(0.5)', label: 'probe top bar reset tempo' });
      await cdp('Emulation.clearDeviceMetricsOverride');
    }

    await barBlocks({ cdp, client, report, port, pageUrl });
    await identityBlocks({ cdp, client, report, port, pageUrl, tempDirs });
    await harmonyBlocks({ cdp, client, report, port, pageUrl });
    await loadFailureBlocks({ cdp, client, report, port, pageUrl });
    summarize();
  } catch (err) {
    if (err instanceof ProbeCouldNotRun) {
      console.error(`probe:page COULD NOT RUN: ${err.message}`);
      process.exitCode = 2;
      return;
    }
    console.error(`probe:page COULD NOT RUN: unexpected error: ${err instanceof Error ? err.stack || err.message : String(err)}`);
    process.exitCode = 2;
  } finally {
    for (const listenerChild of spawnedListeners) {
      listenerChild.kill();
    }
    if (ws) {
      try {
        ws.close();
      } catch (err) {
        console.error(`probe:page: failed to close the CDP socket: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (browserChild) {
      try {
        await closeBrowser(browserChild);
      } catch (err) {
        console.error(`probe:page: failed to close the browser: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (copyWs) {
      try {
        copyWs.close();
      } catch {
        // already closed
      }
    }
    if (copyClient) {
      try {
        await copyClient.close();
      } catch (err) {
        console.error(`probe:page: failed to close the copy's MCP client: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (client) {
      try {
        await client.close();
      } catch (err) {
        console.error(`probe:page: failed to close the MCP client: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // The copy's node_modules link goes first, by itself, so no recursive removal can follow it into the repo.
    if (packageCopy !== null) {
      try {
        removePackageCopyLink(packageCopy);
      } catch (err) {
        console.error(`probe:page: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    }
    await removeTempDirs(tempDirs, 'probe:page');
  }
}

// Runs only when executed directly (same guard as scripts/check-reference.mjs), so a future test
// could import the pure functions above without spawning a browser or a server.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
