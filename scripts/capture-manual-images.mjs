#!/usr/bin/env node
// Maker's tool: takes the pictures of the user manual (the screenshots and short GIFs under site/images/)
// from a real Moontide page, so they can be taken again at a release.
//
//   npm run build
//   node scripts/capture-manual-images.mjs --out <empty folder outside the repository> [--only name[,name]] [--ffmpeg <path>]
//
// It needs `npm run build` first (it runs dist/) and the network, because the page loads its pinned Strudel
// bundle, exactly as scripts/probe-page.mjs does. It starts Moontide with a temporary data folder that holds
// one invented instrument, an SC-55 on a port called "SC-55", and one invented keyboard input called
// "My Keyboard"; the session folder is a made-up name. A headless Chrome opens the page with its sound muted
// and a fake Web MIDI installed before any page script runs, so the page never sees a real MIDI device and
// nothing reaches one. The demo piece plays on the fake SC-55 only. Nothing is heard.
//
// It never reads or changes the user's data folder, their MIDI devices or the publish gate's denylist. Before
// each picture it reads the visible text of the page and refuses the picture if that text holds the user
// name, the host name, the home folder, the repository folder or a temporary folder of the run.
//
// The pictures land in --out, never in the repository: a person looks at every picture, all of it, and only
// then copies it into site/images/. Exit codes: 0 every picture asked for was written, 1 a picture was
// refused (a forbidden word in the page, a limit), 2 the script could not run.
//
// Node built-ins, the project's own MCP client and the helpers of scripts/probe-page.mjs only: no new
// dependency. ffmpeg, which the GIF recipes need, is a tool of the person who takes the pictures, never a
// dependency of the project: it is found on the path or given with --ffmpeg, and it is run with an argument
// array and no shell.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  SONG_HELPER_TEXT,
  askAtCoords,
  callTool,
  clickOverlay,
  closeBrowser,
  closeBrowserOnSignal,
  evaluateExpr,
  findBrowser,
  findPageTarget,
  freshDataDir,
  makeCdp,
  makeNamedFolder,
  pollDevToolsPort,
  pressKey,
  reloadPage,
  removeTempDirs,
  shotsSavedOutside,
  sleep,
  waitConnected,
  waitFor,
  waitSocketOpen,
} from './probe-page.mjs';
import { FAKE_MIDI_SOURCE, SCENARIO_KEY } from './probe-midi.mjs';
import {
  IMAGE_NAME,
  PNG_SAFE_CHUNKS,
  isGraphicControl,
  isNetscapeLoop,
  pngChunkLengthOk,
  readImage,
  readSubBlocks,
} from './build-site.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST_ENTRY = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const PAGE_URL_PATTERN = /Moontide page: (http:\/\/localhost:(\d+))/;
const PROGRAM = 'capture';

// What the manual's pictures may show of the setup: the instrument's own name, the manual's own example
// keyboard, a made-up session folder. The owner's real ports can never reach a picture because the page gets a
// fake Web MIDI and a temporary data folder.
export const DEMO_PORT = 'SC-55';
export const DEMO_KEYBOARD = 'My Keyboard';
export const DEMO_SESSION_FOLDER = 'my-music';

// The publish gate takes a picture of at most this many bytes (the stricter, decimal reading of 400 KB).
export const MAX_IMAGE_BYTES = 400000;

// The size of the page's window: the pictures are taken at device scale 1, so the view is as wide as the
// window and a screenshot stays under the width limit without being scaled.
const VIEWPORT = Object.freeze({ width: 1000, height: 1060, deviceScaleFactor: 1, mobile: false });

/** A picture the script will not write (a forbidden word in the page, a limit): exit 1. */
export class ImageRefused extends Error {}

/** The script could not run (a usage error, no browser, a page that did not come up): exit 2. */
export class CaptureCouldNotRun extends Error {}

// ---- The demo piece ----

// Neutral music for the SC-55, in the form of the structure topic of the reference: one declaration of four
// sections and two groups, the helper lines, then four tracks that each play on the fake SC-55 through
// .midi(), the drums on channel 10. It is MIDI only: no sound of the page's own synth is used, so nothing makes
// a sound even without the muted browser.
export const DEMO_PIECE = [
  'setcps(0.5)',
  "const harmony = 'C3:major'",
  'const song = {',
  '  shift: 0,',
  "  sections: [['intro', 2], ['main', 4], ['break', 2], ['main', 4]],",
  '  plan: {',
  "    intro: { drums: 'soft', bass: '-', keys: '-', pad: 'low' },",
  "    main: { drums: 'full', bass: 'line', keys: 'chords', pad: 'low' },",
  "    break: { drums: '-', bass: '-', keys: 'chords', pad: 'high' },",
  '  },',
  "  groups: { rhythm: ['drums', 'bass'], harmony: ['keys', 'pad'] },",
  '};',
  SONG_HELPER_TEXT,
  'const drums = {',
  '  soft: note("36 ~ 42 ~ 38 ~ 42 ~"),',
  '  full: note("36 42 38 42 36 42 38 [42 42]"),',
  '};',
  'const bass = { line: note("c2 ~ g2 ~ a2 ~ g2 ~") };',
  'const keys = { chords: (h) => n("[0,2,4] ~ [0,2,4] ~").scale(h) };',
  'const pad = {',
  '  low: note("<[c3,g3,e4] [a2,e3,c4]>"),',
  '  high: note("<[e4,g4,c5] [f4,a4,c5]>"),',
  '};',
  "drums: play('drums', drums).midi('SC-55', { midichannel: 10, sound: 'Standard Set' })",
  "bass: play('bass', bass).midi('SC-55', { midichannel: 2, sound: 'Electric Bass (finger)' })",
  "keys: play('keys', keys).midi('SC-55', { midichannel: 3, sound: 'Electric Piano 1' })",
  "pad: play('pad', pad).midi('SC-55', { midichannel: 4, sound: 'Pad 2 (warm)' })",
].join('\n');

// The setup the server reads from its data folder: one invented instrument and one invented input.
export const DEMO_RIG = Object.freeze({
  instruments: Object.freeze([Object.freeze({ id: 'sc55', model: 'sc55', port: DEMO_PORT })]),
  inputs: Object.freeze([Object.freeze({ port: DEMO_KEYBOARD })]),
});

// The scenario the fake Web MIDI reads from localStorage: access granted, the SC-55 as the only output and the
// example keyboard as the only input.
export const DEMO_SCENARIO = Object.freeze({
  permission: 'granted',
  outputs: Object.freeze([DEMO_PORT]),
  inputs: Object.freeze([DEMO_KEYBOARD]),
});

// ---- The browser ----

/** The arguments of the browser: the ones scripts/probe-page.mjs uses, with the sound muted. The browser speaks
 * DevTools over a port and a pipe that is only a lifeline (it closes when the script ends). */
export function browserArgs(userDataDir, pageUrl, headful) {
  const args = [
    `--user-data-dir=${userDataDir}`,
    '--remote-debugging-port=0',
    '--remote-debugging-pipe',
    '--no-first-run',
    '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required',
    '--mute-audio',
  ];
  if (!headful) args.push('--headless=new');
  args.push(pageUrl);
  return args;
}

// ---- Nothing personal in a picture ----

/** The things that must not be in a picture, as { kind, value } pairs: the user name, the host name and its
 * first label, the home folder, the repository folder and each temporary folder of the run. `kind` is what a
 * refusal may say; `value` is never printed. An empty value is left out. */
export function privateNeedles(tempDirs = [], { root = REPO_ROOT } = {}) {
  const list = [];
  const add = (kind, value) => {
    if (typeof value === 'string' && value.trim() !== '') list.push({ kind, value: value.trim() });
  };
  let user = '';
  try {
    user = os.userInfo().username;
  } catch {
    user = process.env.USER ?? process.env.USERNAME ?? '';
  }
  add('the user name', user);
  const host = os.hostname();
  add('the host name', host);
  add('the host name', host.split('.')[0]);
  add('the home folder', os.homedir());
  add('the repository folder', path.resolve(root));
  for (const dir of tempDirs) add('a temporary folder', dir);
  return list;
}

/** The kinds of private things found in `text`, compared without letter case: each kind once, in the order of
 * `needles`. It gives kinds, never the matched text. */
export function forbiddenFound(text, needles) {
  const lowered = String(text).toLowerCase();
  const kinds = [];
  for (const { kind, value } of needles) {
    if (value !== '' && lowered.includes(value.toLowerCase()) && !kinds.includes(kind)) kinds.push(kind);
  }
  return kinds;
}

// ---- PNG ----

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// The chunks without which the picture is not a PNG: when one has a length it cannot have, the bytes are refused
// rather than patched.
const PNG_NEEDED_CHUNKS = Object.freeze(['IHDR', 'PLTE', 'IEND']);

/** Copies the PNG signature and every chunk whose type is in PNG_SAFE_CHUNKS and whose length that type can have,
 * unchanged and with its CRC, and drops all others (text, time, camera data, a colour profile, and a colour chunk
 * that is longer than its few numbers, where text could ride). Throws when the bytes are not a whole PNG, or when
 * IHDR, PLTE or IEND has a length it cannot have. */
export function keepSafePngChunks(bytes) {
  if (bytes.length < PNG_SIGNATURE.length || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new CaptureCouldNotRun('the browser did not give a PNG');
  }
  const kept = [PNG_SIGNATURE];
  let at = PNG_SIGNATURE.length;
  for (;;) {
    if (at + 12 > bytes.length) throw new CaptureCouldNotRun('the PNG from the browser is cut short');
    const length = bytes.readUInt32BE(at);
    const type = bytes.toString('latin1', at + 4, at + 8);
    const end = at + 12 + length;
    if (end > bytes.length) throw new CaptureCouldNotRun('the PNG from the browser is cut short');
    if (PNG_SAFE_CHUNKS.includes(type)) {
      if (pngChunkLengthOk(type, length)) kept.push(bytes.subarray(at, end));
      else if (PNG_NEEDED_CHUNKS.includes(type)) {
        throw new CaptureCouldNotRun(`the PNG from the browser has a ${type} chunk of ${length} bytes, which is not a length it has`);
      }
    }
    at = end;
    if (type === 'IEND') break;
  }
  return Buffer.concat(kept);
}

// ---- GIF ----

// How a GIF is made: the frames of the page are taken about ten times a second, ffmpeg makes one palette for the
// whole clip, and the result is at most 720 px wide and 6 s long. A recipe may ask for a lower rate or fewer
// colours when its GIF would weigh too much.
export const GIF_SETTINGS = Object.freeze({ maxWidth: 720, maxMs: 6000, fps: 10, colors: 128 });

/** Refuses a recording longer than a GIF of the manual may be (6 s), before ffmpeg runs. `ms` is the length of the
 * recording in milliseconds. */
export function checkRecordingLength(ms) {
  if (!Number.isFinite(ms) || ms <= 0) throw new ImageRefused('the recording holds no time');
  if (ms > GIF_SETTINGS.maxMs) {
    throw new ImageRefused(`the recording is ${(ms / 1000).toFixed(2)} s long; a GIF of the manual is at most ${GIF_SETTINGS.maxMs / 1000} s`);
  }
}

/** The frames of a recording with the time each one is shown: `frames` are { at } in milliseconds in the order they
 * were taken, `endAt` is when the recording stopped. A frame is shown until the next one; the last until `endAt`.
 * Gives [{ index, ms }] and the total. */
export function frameDurations(frames, endAt) {
  if (frames.length === 0) throw new ImageRefused('the recording holds no frame');
  const shown = frames.map((frame, index) => {
    const next = index + 1 < frames.length ? frames[index + 1].at : endAt;
    return { index, ms: Math.max(1, next - frame.at) };
  });
  return { shown, totalMs: endAt - frames[0].at };
}

/** The text of the concat list ffmpeg reads: bare file names (ffmpeg runs in the folder of the frames), each with
 * its time in seconds, and the last file listed once more so that its time counts. */
export function concatList(names, shown) {
  const lines = [];
  for (const { index, ms } of shown) {
    lines.push(`file '${names[index]}'`, `duration ${(ms / 1000).toFixed(3)}`);
  }
  lines.push(`file '${names[shown.at(-1).index]}'`);
  return `${lines.join('\n')}\n`;
}

/** The arguments of the ffmpeg run that turns the frames into a looping GIF: the rate capped, the width capped with
 * lanczos, one palette for the whole clip (stats_mode diff) used with diff_mode rectangle. The names are bare: the
 * run happens in the folder of the frames. There is no shell, so the filter text is one argument. */
export function gifArgs({ list = 'frames.txt', out = 'clip.gif', fps = GIF_SETTINGS.fps, colors = GIF_SETTINGS.colors, width = GIF_SETTINGS.maxWidth } = {}) {
  const filter = [
    `fps=${fps}`,
    `scale='min(${width},iw)':-2:flags=lanczos`,
    'split[raw][forpalette]',
  ].join(',');
  const graph = `${filter};[forpalette]palettegen=stats_mode=diff:max_colors=${colors}[palette];[raw][palette]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`;
  return ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-i', list, '-vf', graph, '-loop', '0', out];
}

// How long ffmpeg may run: a clip of at most 6 s takes a few seconds, so two minutes only ever means it is stuck.
// The run blocks the script (spawnSync), so without a limit a stuck ffmpeg would also keep the script from answering
// Ctrl-C and from cleaning up.
export const FFMPEG_TIMEOUT_MS = 120000;
const FFMPEG_PROBE_TIMEOUT_MS = 15000;

/** Runs ffmpeg once with an argument array and no shell, and stops it for good (SIGKILL) when it has not ended after
 * `timeoutMs`. Gives the result of spawnSync; throws a plain error (exit 2) when it had to be stopped. */
export function runFfmpeg(ffmpegPath, args, { cwd, timeoutMs = FFMPEG_TIMEOUT_MS } = {}) {
  const ran = spawnSync(ffmpegPath, args, { cwd, encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL' });
  if (ran.error && ran.error.code === 'ETIMEDOUT') {
    throw new CaptureCouldNotRun(`${PROGRAM}: ffmpeg did not finish within ${timeoutMs / 1000} s and was stopped`);
  }
  return ran;
}

/** Checks that ffmpeg runs, or stops the script (exit 2) with a plain message. */
export function checkFfmpeg(ffmpegPath, { timeoutMs = FFMPEG_PROBE_TIMEOUT_MS } = {}) {
  const probe = runFfmpeg(ffmpegPath, ['-version'], { timeoutMs });
  if (probe.error || probe.status !== 0) {
    throw new CaptureCouldNotRun(
      `${PROGRAM}: ffmpeg not found; install it or pass --ffmpeg <path> (ffmpeg is a tool of the person taking the pictures, not a dependency of Moontide)`,
    );
  }
}

/** Writes the frames into `workDir`, runs ffmpeg there and gives the bytes of the GIF it made. `frames` are
 * { at, data } with data the PNG bytes; `endAt` is when the recording stopped. */
export function makeGif({ ffmpegPath, frames, endAt, workDir, settings = {}, timeoutMs = FFMPEG_TIMEOUT_MS }) {
  const { shown, totalMs } = frameDurations(frames, endAt);
  checkRecordingLength(totalMs);
  const names = frames.map((_, index) => `f${String(index + 1).padStart(4, '0')}.png`);
  frames.forEach((frame, index) => fs.writeFileSync(path.join(workDir, names[index]), frame.data));
  fs.writeFileSync(path.join(workDir, 'frames.txt'), concatList(names, shown));
  const args = gifArgs({ ...settings });
  const made = runFfmpeg(ffmpegPath, args, { cwd: workDir, timeoutMs });
  if (made.error || made.status !== 0) {
    const why = made.error ? made.error.message : (made.stderr ?? '').trim().split('\n').slice(0, 3).join(' ');
    throw new CaptureCouldNotRun(`${PROGRAM}: ffmpeg could not make the GIF: ${why}`);
  }
  return fs.readFileSync(path.join(workDir, 'clip.gif'));
}

const gifCutShort = () => new CaptureCouldNotRun('the GIF from ffmpeg is cut short');

/** Copies the GIF header, its colours, every graphic control block and every image block unchanged, and drops all
 * extension blocks that can carry text: a comment, a plain-text block and any application block but the NETSCAPE2.0
 * loop, and a NETSCAPE2.0 block with more in it than the loop count. Throws when the bytes are not a whole GIF, or
 * when a graphic control block is not the one 4-byte block it is. */
export function keepSafeGifBlocks(bytes) {
  const header = bytes.toString('latin1', 0, 6);
  if (bytes.length < 13 || (header !== 'GIF87a' && header !== 'GIF89a')) throw new CaptureCouldNotRun('ffmpeg did not give a GIF');
  const tableSize = (packed) => 3 * 2 ** ((packed & 7) + 1);
  let at = 13;
  if (bytes[10] & 0x80) at += tableSize(bytes[10]);
  if (at > bytes.length) throw gifCutShort();
  const kept = [bytes.subarray(0, at)];
  for (;;) {
    if (at >= bytes.length) throw gifCutShort();
    const block = bytes[at];
    if (block === 0x3b) {
      kept.push(bytes.subarray(at, at + 1));
      at += 1;
      break;
    }
    if (block === 0x21) {
      if (at + 2 > bytes.length) throw gifCutShort();
      const label = bytes[at + 1];
      const sub = readSubBlocks(bytes, at + 2, gifCutShort);
      if (label === 0xf9 && !isGraphicControl(sub)) {
        throw new CaptureCouldNotRun('the GIF from ffmpeg has a graphic control block that is not one block of 4 bytes');
      }
      if (label === 0xf9 || (label === 0xff && isNetscapeLoop(sub))) kept.push(bytes.subarray(at, sub.next));
      at = sub.next;
    } else if (block === 0x2c) {
      if (at + 10 > bytes.length) throw gifCutShort();
      const packed = bytes[at + 9];
      let end = at + 10;
      if (packed & 0x80) end += tableSize(packed);
      end = readSubBlocks(bytes, end + 1, gifCutShort).next;
      kept.push(bytes.subarray(at, end));
      at = end;
    } else {
      throw new CaptureCouldNotRun('the GIF from ffmpeg holds a block that is not part of a GIF');
    }
  }
  return Buffer.concat(kept);
}

/** Takes a frame about every `intervalMs` while `gesture()` runs, then holds the end state for `holdMs`. `shoot()` gives
 * the PNG bytes of one frame; a frame equal to the one before is not kept. Gives { frames: [{ at, data }], endAt }
 * (milliseconds from the start). The frame loop runs beside the gesture, so its failure is caught at once (an
 * unhandled rejection would end the process and skip every cleanup of run()) and thrown after the gesture, unless the
 * gesture failed too: then the gesture's error, the more useful one, is the one that goes on. */
export async function recordFrames({ shoot, gesture, holdMs, intervalMs = 100 }) {
  const frames = [];
  let running = true;
  let loopError = null;
  const startedAt = Date.now();
  const loop = (async () => {
    while (running) {
      const tookAt = Date.now();
      const data = await shoot();
      const last = frames.at(-1);
      if (!last || !last.data.equals(data)) frames.push({ at: Date.now() - startedAt, data });
      const wait = intervalMs - (Date.now() - tookAt);
      if (wait > 0) await sleep(wait);
    }
  })().catch((error) => {
    loopError = error;
    running = false;
  });
  try {
    await gesture();
    await sleep(holdMs);
  } finally {
    running = false;
    await loop;
  }
  if (loopError) throw loopError;
  return { frames, endAt: Date.now() - startedAt };
}

// ---- The drawn pointer ----

// A headless screenshot shows no mouse, so a GIF would not show where a gesture happens. For the capture only, the
// script adds an arrow and, at each click, a short ring to the page. They ignore the mouse and sit above
// everything; the real mouse events still do the gesture.
const POINTER_JS = `(() => {
  if (document.getElementById('capture-pointer')) return true;
  const arrow = document.createElement('div');
  arrow.id = 'capture-pointer';
  arrow.setAttribute('aria-hidden', 'true');
  arrow.style.cssText = 'position:fixed;left:0;top:0;width:26px;height:26px;pointer-events:none;z-index:2147483647;transform:translate(-100px,-100px);filter:drop-shadow(0 1px 2px rgba(0,0,0,.6))';
  arrow.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 24 24"><path d="M3 2 L3 19 L7.5 14.8 L10.8 21.8 L14 20.3 L10.8 13.6 L17 13.4 Z" fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  document.body.appendChild(arrow);
  window.__capturePointerMove = (x, y) => { arrow.style.transform = 'translate(' + (x - 3) + 'px,' + (y - 2) + 'px)'; };
  window.__capturePointerRing = (x, y) => {
    const ring = document.createElement('div');
    ring.setAttribute('aria-hidden', 'true');
    ring.style.cssText = 'position:fixed;left:' + (x - 17) + 'px;top:' + (y - 17) + 'px;width:34px;height:34px;box-sizing:border-box;border-radius:50%;border:3px solid #fff;box-shadow:0 0 0 2px rgba(0,0,0,.5);pointer-events:none;z-index:2147483646';
    document.body.appendChild(ring);
    ring.animate([{ transform: 'scale(.35)', opacity: 1 }, { transform: 'scale(1.25)', opacity: 0 }], { duration: 550, easing: 'ease-out' }).onfinish = () => ring.remove();
  };
  return true;
})()`;

// ---- The pictures ----

// The rate and the colours the GIFs of the manual are made with: a lower rate and fewer colours than the most the
// script allows, which keeps each one well under the weight the publish gate accepts.
const GIF_TUNING = Object.freeze({ fps: 8, colors: 112 });

// The window a GIF is taken in: as wide as a GIF may be, so its text is not scaled down.
const GIF_VIEWPORT = Object.freeze({ width: 720, height: 500, deviceScaleFactor: 1, mobile: false });

/** Every picture of the manual: its name (the file name without its extension), its file, its kind (png or
 * gif), the site page that shows it, the "##" heading it sits under there, one plain line on what it shows, and
 * `capture(session)`, which returns the bytes. A picture is added here and on its page, never one without the
 * other: test/capture-images.test.js ties the recipes, the files and the pages together. */
export const IMAGES = Object.freeze([
  Object.freeze({
    name: 'song-grid',
    file: 'song-grid.png',
    kind: 'png',
    page: 'song-structure.md',
    section: 'The Song grid',
    shows: 'the Parts view of the demo piece, which is the Song grid, taken while its second section plays',
    capture: async (session) => {
      await session.openView(4);
      const grid = await waitFor(
        session.cdp,
        `(() => {
          const heads = [...document.querySelectorAll('#parts-rows .song-head')];
          const at = heads.findIndex((head) => head.dataset.state === 'playing');
          return heads.length === 4 && at === 1 && heads[1].textContent.includes('Playing 2/4') ? true : null;
        })()`,
        40000,
      );
      if (grid !== true) throw new CaptureCouldNotRun('the Song grid never showed its second section playing');
      return session.screenshot('#view-panel');
    },
  }),
  Object.freeze({
    name: 'timeline',
    file: 'timeline.png',
    kind: 'png',
    page: 'editing.md',
    section: 'Edit notes on the Timeline',
    shows: 'the Timeline with the lanes of the four tracks of the demo piece and one note selected by a real click, so the panel under the lanes says what can be done with it',
    capture: async (session) => {
      await session.openView(2);
      const drawn = await waitFor(
        session.cdp,
        `(() => { const view = document.getElementById('timeline-view'); return view.dataset.state === 'ok' && document.querySelectorAll('#timeline-lanes .lane').length === 4 ? true : null; })()`,
        15000,
      );
      if (drawn !== true) throw new CaptureCouldNotRun('the Timeline never drew the four lanes of the demo piece');
      // A real click on the first note of the bass lane: its panel says that the note plays in two places.
      const point = await evaluateExpr(
        session.cdp,
        `(() => {
          const rect = document.querySelectorAll('#timeline-lanes .lane')[1].querySelectorAll('rect.event[data-kind="note"]')[0];
          if (!rect) return null;
          const r = rect.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        })()`,
      );
      if (point === null) throw new CaptureCouldNotRun('the bass lane of the Timeline holds no note to click');
      await session.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 });
      await session.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 });
      const selected = await waitFor(
        session.cdp,
        `document.querySelector('#timeline-note .tl-note-state') && document.querySelector('#timeline-note .tl-note-position').textContent.startsWith(' · cycle') ? true : null`,
        5000,
      );
      if (selected !== true) throw new CaptureCouldNotRun('the click did not select a note of the Timeline');
      // Park the real mouse out of the way, so no hover marks the picture.
      await session.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5, button: 'none', buttons: 0 });
      return session.screenshot('#view-panel');
    },
  }),
  Object.freeze({
    name: 'mixer',
    file: 'mixer.png',
    kind: 'png',
    page: 'editing.md',
    section: 'Move the Mixer',
    shows: 'the Mixer of the demo piece: one strip for each track with its fader, mute and solo, the frames of the two groups, and a light lit by a note that the SC-55 plays',
    capture: async (session) => {
      // The strips are tall: a taller window gives the view the room to show each fader whole.
      await session.setViewport({ ...VIEWPORT, height: 1500 });
      await session.openView(3);
      const strips = await waitFor(session.cdp, `document.querySelectorAll('#mixer-strips .mx-strip').length >= 4 ? true : null`, 15000);
      if (strips !== true) throw new CaptureCouldNotRun('the Mixer never showed a strip for each track');
      // Wait for a moment when a light is lit by a note, then take the picture at once.
      const lit = await waitFor(
        session.cdp,
        `[...document.querySelectorAll('#mixer-strips .mx-light-fill')].some((el) => Number(getComputedStyle(el).opacity) > 0.6) ? true : null`,
        20000,
      );
      if (lit !== true) throw new CaptureCouldNotRun('no light of the Mixer was lit by a note within 20 s');
      return session.screenshot('#view-panel');
    },
  }),
  Object.freeze({
    name: 'scratchpad',
    file: 'scratchpad.png',
    kind: 'png',
    page: 'scratchpad.md',
    section: 'The roll',
    shows: 'the Scratchpad with a short motif written by double-clicks on the grid, the velocity lane under the roll and the line that says what the selected note is',
    capture: async (session) => {
      await session.openView(7);
      const notes = [
        [0, 60],
        [4, 64],
        [8, 67],
        [12, 64],
        [16, 62],
        [20, 65],
        [24, 69],
        [28, 65],
      ];
      for (const [step, pitch] of notes) {
        const point = await evaluateExpr(
          session.cdp,
          `(() => {
            const view = document.getElementById('scratch-view');
            const grid = document.getElementById('scratch-grid').getBoundingClientRect();
            const rows = Number(view.dataset.rows);
            const high = Number(view.dataset.rowHigh);
            const steps = Number(view.dataset.cycles) * 16;
            return { x: grid.x + ((${step} + 0.5) / steps) * grid.width, y: grid.y + ((high - ${pitch} + 0.5) / rows) * grid.height };
          })()`,
        );
        const press = (clickCount, type) => session.cdp('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount });
        await press(1, 'mousePressed');
        await press(1, 'mouseReleased');
        await press(2, 'mousePressed');
        await press(2, 'mouseReleased');
        await sleep(120);
      }
      const written = await waitFor(session.cdp, `Number(document.getElementById('scratch-view').dataset.notes) === ${notes.length} ? true : null`, 5000);
      if (written !== true) throw new CaptureCouldNotRun('the double-clicks did not write the motif on the Scratchpad');
      await session.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5, button: 'none', buttons: 0 });
      return session.screenshot('#view-panel');
    },
  }),
  Object.freeze({
    name: 'views-tour',
    file: 'views-tour.gif',
    kind: 'gif',
    page: 'the-page.md',
    section: 'The views',
    shows: 'a tour of the views: the pointer clicks the view buttons of the top bar one after another while the demo piece plays',
    capture: async (session) => {
      await session.setViewport(GIF_VIEWPORT);
      await session.evaluateBlur();
      await pressKey(session.cdp, 'Escape');
      await pressKey(session.cdp, 'c');
      await sleep(400);
      await session.ensurePointer();
      const buttons = '#view-buttons button';
      const first = await session.centerOf(buttons, 1);
      await session.moveTo(first.x - 50, first.y + 12, 25);
      return session.recordGif('html', async () => {
        for (const nth of [1, 2, 3, 4, 6]) {
          const point = await session.centerOf(buttons, nth);
          await session.moveTo(point.x, point.y, 300);
          await session.click();
          await sleep(420);
        }
      }, { holdMs: 600, settings: GIF_TUNING });
    },
  }),
  Object.freeze({
    name: 'draw-note',
    file: 'draw-note.gif',
    kind: 'gif',
    page: 'scratchpad.md',
    section: 'Select first, then draw',
    shows: 'the Scratchpad: Draw is turned on with its button, two notes of different lengths are dragged onto the grid, and Draw is turned off again',
    capture: async (session) => {
      await session.setViewport(GIF_VIEWPORT);
      await session.openView(7, 'c');
      await sleep(700);
      await session.ensurePointer();
      const cell = (step, pitch) =>
        evaluateExpr(
          session.cdp,
          `(() => {
            const view = document.getElementById('scratch-view');
            const grid = document.getElementById('scratch-grid').getBoundingClientRect();
            const rows = Number(view.dataset.rows);
            const high = Number(view.dataset.rowHigh);
            const steps = Number(view.dataset.cycles) * 16;
            return { x: grid.x + (${step} / steps) * grid.width, y: grid.y + ((high - ${pitch} + 0.5) / rows) * grid.height };
          })()`,
        );
      const draw = await session.centerOf('#scratch-draw');
      await session.moveTo(draw.x + 40, draw.y + 60, 25);
      return session.recordGif('html', async () => {
        await session.moveTo(draw.x, draw.y, 450);
        await session.click();
        await sleep(250);
        const firstStart = await cell(3.5, 64);
        await session.moveTo(firstStart.x, firstStart.y, 400);
        const firstEnd = await cell(7.5, 64);
        await session.dragTo(firstEnd.x, firstEnd.y, 400);
        await sleep(200);
        const secondStart = await cell(13.5, 67);
        await session.moveTo(secondStart.x, secondStart.y, 400);
        const secondEnd = await cell(23.5, 67);
        await session.dragTo(secondEnd.x, secondEnd.y, 500);
        await sleep(200);
        await session.moveTo(draw.x, draw.y, 450);
        await session.click();
        await session.moveTo(draw.x + 90, draw.y + 80, 350);
        await sleep(100);
        const done = await waitFor(
          session.cdp,
          `Number(document.getElementById('scratch-view').dataset.notes) === 2 && document.getElementById('scratch-draw').getAttribute('aria-pressed') === 'false' ? true : null`,
          3000,
        );
        if (done !== true) throw new CaptureCouldNotRun('the drags did not leave two notes on the roll with Draw off');
      }, { holdMs: 800, settings: GIF_TUNING });
    },
  }),
  Object.freeze({
    name: 'record-that',
    file: 'record-that.gif',
    kind: 'gif',
    page: 'keyboard-input.md',
    section: 'Record that',
    shows: 'a short phrase arrives from the example keyboard and shows on the Scratchpad as it is played, then the pointer presses Record that and the notes stand on the roll with the line that says how many were recorded',
    capture: async (session) => {
      // Taller than the others, so the line under the roll that says how many notes were recorded is in the picture.
      await session.setViewport({ ...GIF_VIEWPORT, height: 640 });
      await session.openView(7, 'c');
      await sleep(700);
      await session.ensurePointer();
      const listening = await waitFor(session.cdp, `document.getElementById('scratch-view').dataset.live === 'armed' ? true : null`, 10000);
      if (listening !== true) throw new CaptureCouldNotRun(`the Scratchpad is not listening to ${DEMO_KEYBOARD}`);
      const playIn = (bytes) => evaluateExpr(session.cdp, `window.__playIn(${JSON.stringify(DEMO_KEYBOARD)}, ${JSON.stringify(bytes)})`);
      const record = await session.centerOf('#scratch-record');
      await session.moveTo(record.x + 60, record.y + 70, 25);
      return session.recordGif('html', async () => {
        for (const [pitch, velocity, held] of [[60, 100, 380], [64, 90, 380], [67, 100, 380], [72, 110, 520]]) {
          await playIn([0x90, pitch, velocity]);
          await sleep(held);
          await playIn([0x80, pitch, 0]);
          await sleep(90);
        }
        await sleep(150);
        await session.moveTo(record.x, record.y, 400);
        await session.click();
        const kept = await waitFor(
          session.cdp,
          `Number(document.getElementById('scratch-view').dataset.notes) === 4 && document.getElementById('scratch-note-spoken').textContent.startsWith('Recorded 4 notes') ? true : null`,
          3000,
        );
        if (kept !== true) throw new CaptureCouldNotRun('Record that did not put the four notes played in on the roll');
      }, { holdMs: 1000, settings: GIF_TUNING });
    },
  }),
  // Last on purpose: the request it sends stays in the page's list, and a picture taken after it would show the
  // Requests button in the top bar.
  Object.freeze({
    name: 'ask-right-click',
    file: 'ask-right-click.gif',
    kind: 'gif',
    page: 'page-requests.md',
    section: 'Right-click to ask',
    shows: 'a right-click on a note of the Timeline, the Ask box that opens, a short request typed in it, Enter, and the Requests button that appears in the top bar',
    capture: async (session) => {
      await session.setViewport(GIF_VIEWPORT);
      await session.openView(2, 'c');
      await sleep(700);
      const drawn = await waitFor(
        session.cdp,
        `(() => { const view = document.getElementById('timeline-view'); return view.dataset.state === 'ok' && document.querySelectorAll('#timeline-lanes .lane').length === 4 ? true : null; })()`,
        15000,
      );
      if (drawn !== true) throw new CaptureCouldNotRun('the Timeline never drew the lanes of the demo piece');
      await session.ensurePointer();
      // The first bass note that lies well inside the window.
      const target = await evaluateExpr(
        session.cdp,
        `(() => {
          const notes = [...document.querySelectorAll('#timeline-lanes .lane')[1].querySelectorAll('rect.event[data-kind="note"]')];
          const inside = notes.map((el) => el.getBoundingClientRect()).find((r) => r.x > 220 && r.right < 640);
          return inside ? { x: inside.x + inside.width / 2, y: inside.y + inside.height / 2 } : null;
        })()`,
      );
      if (target === null) throw new CaptureCouldNotRun('no bass note of the Timeline lies inside the window');
      await session.moveTo(target.x + 130, target.y + 90, 25);
      return session.recordGif('html', async () => {
        await session.moveTo(target.x, target.y, 500);
        await sleep(150);
        const asked = await session.rightClick();
        if (asked.open !== true) throw new CaptureCouldNotRun('the right-click did not open the Ask box');
        await sleep(400);
        await session.typeText('make this a little softer', 70);
        await sleep(250);
        await pressKey(session.cdp, 'Enter');
        const shown = await waitFor(session.cdp, `document.getElementById('requests-toggle') && !document.getElementById('requests-toggle').hidden ? true : null`, 8000);
        if (shown !== true) throw new CaptureCouldNotRun('the Requests button never appeared in the top bar');
      }, { holdMs: 900, settings: GIF_TUNING });
    },
  }),
]);

// ---- Options ----

const IMAGE_NAMES = IMAGES.map((image) => image.name);

/** Reads the command line. Throws CaptureCouldNotRun (exit 2) with a message that starts with "capture:" for a
 * usage error: no --out, an --out that is not a missing or empty folder outside the repository, an unknown
 * picture name, an unknown option. */
export function parseCaptureArgs(argv) {
  let values;
  try {
    values = parseArgs({
      args: argv,
      options: {
        out: { type: 'string' },
        only: { type: 'string' },
        browser: { type: 'string' },
        ffmpeg: { type: 'string' },
        headful: { type: 'boolean' },
      },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch (error) {
    throw new CaptureCouldNotRun(`${PROGRAM}: ${error.message}`);
  }
  if (values.out === undefined || values.out.trim() === '') {
    throw new CaptureCouldNotRun(`${PROGRAM}: --out <folder> is required: a missing or empty folder outside the repository`);
  }
  let names = IMAGE_NAMES;
  if (values.only !== undefined) {
    names = values.only.split(',').map((name) => name.trim());
    const unknown = names.find((name) => !IMAGE_NAMES.includes(name));
    if (unknown !== undefined) {
      throw new CaptureCouldNotRun(`${PROGRAM}: --only names an unknown picture "${unknown}"; the pictures are ${IMAGE_NAMES.join(', ')}`);
    }
    names = IMAGE_NAMES.filter((name) => names.includes(name));
  }
  const out = path.resolve(values.out);
  if (!shotsSavedOutside(out)) {
    throw new CaptureCouldNotRun(`${PROGRAM}: --out must name a folder outside the repository; a picture reaches site/images/ only by a copy after a look`);
  }
  if (fs.existsSync(out)) {
    if (!fs.statSync(out).isDirectory()) throw new CaptureCouldNotRun(`${PROGRAM}: --out is a file; give a missing or empty folder`);
    if (fs.readdirSync(out).length > 0) throw new CaptureCouldNotRun(`${PROGRAM}: --out is not empty; give a missing or empty folder`);
  }
  const ffmpegPath = values.ffmpeg === undefined || values.ffmpeg.trim() === '' ? 'ffmpeg' : values.ffmpeg;
  return { out, only: names, browserPath: values.browser ?? null, ffmpegPath, headful: values.headful === true };
}

// ---- The run ----

/** The MCP client and the stdio transport that runs the built server in `cwd` with a temporary data folder. */
function makeServerClient(dataDir, cwd) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [DIST_ENTRY],
    env: { ...process.env, MOONTIDE_NO_BROWSER: '1', MOONTIDE_DATA_DIR: dataDir },
    cwd,
    stderr: 'pipe',
  });
  return { client: new Client({ name: 'moontide-capture-client', version: '0.0.0' }), transport };
}

/** Starts the server and gives { client, pageUrl }. Whatever goes wrong after the server child exists, the client is
 * closed (which ends the child) before the error goes on: the caller has no client to close yet, and a child with open
 * pipes would keep the script from ending. `make` and `waitMs` are for the test. */
export async function startMoontide(dataDir, cwd, { make = makeServerClient, waitMs = 10000 } = {}) {
  const { client, transport } = make(dataDir, cwd);
  let stderrText = '';
  transport.stderr?.on('data', (chunk) => {
    stderrText += chunk.toString();
  });
  try {
    await client.connect(transport);
    const started = await client.callTool({ name: 'start', arguments: {} });
    if (started.isError) throw new CaptureCouldNotRun(`${PROGRAM}: the start tool failed: ${JSON.stringify(started.content)}`);
    const deadline = Date.now() + waitMs;
    for (;;) {
      const match = PAGE_URL_PATTERN.exec(stderrText);
      if (match) return { client, pageUrl: match[1] };
      if (Date.now() > deadline) {
        throw new CaptureCouldNotRun(`${PROGRAM}: the Moontide server did not print its page address within ${waitMs / 1000} s`);
      }
      await sleep(25);
    }
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }
}

/** Opens the page and gets it ready: the fake Web MIDI in place, the demo piece playing on the fake SC-55, the
 * window and the colour scheme set. Gives the session the recipes use. */
async function prepare({ client, cdp, tempDirs }) {
  await cdp('Runtime.enable');
  await waitConnected(cdp, 15000);
  await clickOverlay(cdp);

  // The fake Web MIDI exists before any page script runs, and the scenario names the only ports it holds. The code
  // the server holds has no .midi() yet, so the first page never asks for MIDI access.
  await cdp('Page.enable');
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: FAKE_MIDI_SOURCE });
  await callTool(client, 'set_code', { code: 's("bd").gain(0)', label: 'silent start' });
  await evaluateExpr(cdp, `localStorage.setItem(${JSON.stringify(SCENARIO_KEY)}, ${JSON.stringify(JSON.stringify(DEMO_SCENARIO))})`);
  await reloadPage(cdp);
  const fake = await evaluateExpr(
    cdp,
    `(async () => {
      if (!Array.isArray(window.__midiLog)) return null;
      const access = await navigator.requestMIDIAccess({ sysex: true });
      return { outputs: [...access.outputs.values()].map((port) => port.name), inputs: [...access.inputs.values()].map((port) => port.name) };
    })()`,
  );
  if (fake === null) throw new CaptureCouldNotRun(`${PROGRAM}: the fake Web MIDI is not in the page; refusing to go on, a real device could be listed`);
  if (JSON.stringify(fake) !== JSON.stringify({ outputs: [DEMO_PORT], inputs: [DEMO_KEYBOARD] })) {
    throw new CaptureCouldNotRun(`${PROGRAM}: the fake Web MIDI lists other ports than the demo ones; refusing to go on`);
  }

  await cdp('Emulation.setDeviceMetricsOverride', VIEWPORT);
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });

  await callTool(client, 'set_code', { code: DEMO_PIECE, label: 'demo piece' });
  const playing = await waitFor(
    cdp,
    `window.__midiLog.some((entry) => entry.bytes.length === 3 && (entry.bytes[0] & 0xf0) === 0x90 && entry.bytes[2] > 0) ? true : null`,
    30000,
  );
  if (playing !== true) throw new CaptureCouldNotRun(`${PROGRAM}: the demo piece never played a note on the fake ${DEMO_PORT}`);

  const needles = privateNeedles(tempDirs);

  /** The views open from the keyboard: leave the editor, close any view, press the view's key. */
  const views = { 1: 'history', 2: 'timeline', 3: 'mixer', 4: 'parts', 5: 'jam', 6: 'instruments', 7: 'scratchpad' };
  const session = {
    cdp,
    client,
    async openView(key, layout = 'a') {
      await evaluateExpr(cdp, `(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); })()`);
      await pressKey(cdp, 'Escape');
      await pressKey(cdp, layout);
      await pressKey(cdp, String(key));
      const open = await waitFor(cdp, `document.getElementById('workspace').dataset.view === ${JSON.stringify(views[key])} ? true : null`, 3000);
      if (open !== true) throw new CaptureCouldNotRun(`${PROGRAM}: view ${key} did not open`);
    },
    /** Refuses the picture when the visible text of the page, or the text of the editor, holds anything private. */
    async assertClean() {
      const text = await evaluateExpr(
        cdp,
        `document.body.innerText + '\\n' + (document.getElementById('repl').editor.editor ? document.getElementById('repl').editor.editor.state.doc.toString() : '')`,
      );
      const kinds = forbiddenFound(text, needles);
      if (kinds.length > 0) throw new ImageRefused(`the page text holds ${kinds.join(' and ')}`);
    },
    /** A PNG of the box of the first element that matches `selector`, after the text check. */
    async screenshot(selector) {
      await session.assertClean();
      const rect = await evaluateExpr(
        cdp,
        `(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height };
        })()`,
      );
      if (rect === null) throw new CaptureCouldNotRun(`${PROGRAM}: no element matches ${selector}`);
      const shot = await cdp('Page.captureScreenshot', {
        format: 'png',
        clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 1 },
        captureBeyondViewport: false,
      });
      return Buffer.from(shot.data, 'base64');
    },
    /** The ports that got any message from the page so far: only the demo instrument may be among them. */
    async portsUsed() {
      return evaluateExpr(cdp, `[...new Set(window.__midiLog.map((entry) => entry.port))]`);
    },
    /** A new page of the same music, so a recipe starts from a known state: the page reloaded, the window set,
     * the demo piece playing on the fake SC-55 again. */
    async freshPage(viewport = VIEWPORT) {
      await reloadPage(cdp);
      await cdp('Emulation.setDeviceMetricsOverride', viewport);
      await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
      const again = await waitFor(
        cdp,
        `Array.isArray(window.__midiLog) && window.__midiLog.some((entry) => entry.bytes.length === 3 && (entry.bytes[0] & 0xf0) === 0x90 && entry.bytes[2] > 0) ? true : null`,
        30000,
      );
      if (again !== true) throw new CaptureCouldNotRun(`${PROGRAM}: the demo piece did not play again on the fake ${DEMO_PORT} after a reload`);
      session.pointer = { x: -100, y: -100 };
    },
    async evaluateBlur() {
      await evaluateExpr(cdp, `(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); })()`);
    },
    async setViewport(viewport) {
      await cdp('Emulation.setDeviceMetricsOverride', viewport);
      await sleep(250);
    },
    // ---- the drawn pointer and the gestures a GIF shows ----
    pointer: { x: -100, y: -100 },
    /** Puts the drawn pointer in the page (once per page). */
    async ensurePointer() {
      await evaluateExpr(cdp, POINTER_JS);
    },
    /** The centre of the `nth` element that matches `selector`, in viewport pixels, after the page took the text
     * check. Throws when nothing matches. */
    async centerOf(selector, nth = 0) {
      const point = await evaluateExpr(
        cdp,
        `(() => {
          const el = document.querySelectorAll(${JSON.stringify(selector)})[${nth}];
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        })()`,
      );
      if (point === null) throw new CaptureCouldNotRun(`${PROGRAM}: no element matches ${selector} at ${nth}`);
      return point;
    },
    /** Moves the drawn pointer and the real mouse together to (x, y) in small steps over `ms`. */
    async moveTo(x, y, ms = 450) {
      const from = session.pointer;
      const steps = Math.max(1, Math.round(ms / 25));
      for (let step = 1; step <= steps; step += 1) {
        const t = step / steps;
        const eased = t * t * (3 - 2 * t);
        const px = from.x + (x - from.x) * eased;
        const py = from.y + (y - from.y) * eased;
        await Promise.all([
          evaluateExpr(cdp, `window.__capturePointerMove(${px}, ${py})`),
          cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px, y: py, button: 'none', buttons: 0 }),
        ]);
        await sleep(25);
      }
      session.pointer = { x, y };
    },
    /** A left click at the pointer, with the ring that shows it. */
    async click() {
      const { x, y } = session.pointer;
      await evaluateExpr(cdp, `window.__capturePointerRing(${x}, ${y})`);
      await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
      await sleep(70);
      await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
    },
    /** A right click at the pointer, the way the probes make it (one contextmenu event), with the ring. */
    async rightClick() {
      const { x, y } = session.pointer;
      await evaluateExpr(cdp, `window.__capturePointerRing(${x}, ${y})`);
      return askAtCoords(cdp, x, y);
    },
    /** A drag with the left button from the pointer to (x, y), the pointer drawn all along. */
    async dragTo(x, y, ms = 500) {
      const { x: fromX, y: fromY } = session.pointer;
      await evaluateExpr(cdp, `window.__capturePointerRing(${fromX}, ${fromY})`);
      await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: fromX, y: fromY, button: 'left', buttons: 1, clickCount: 1 });
      const steps = Math.max(1, Math.round(ms / 25));
      for (let step = 1; step <= steps; step += 1) {
        const px = fromX + ((x - fromX) * step) / steps;
        const py = fromY + ((y - fromY) * step) / steps;
        await Promise.all([
          evaluateExpr(cdp, `window.__capturePointerMove(${px}, ${py})`),
          cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px, y: py, button: 'left', buttons: 1 }),
        ]);
        await sleep(25);
      }
      await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
      session.pointer = { x, y };
    },
    /** Types `text` one character at a time, `perCharMs` apart, at a reading pace. */
    async typeText(text, perCharMs = 85) {
      for (const char of text) {
        await cdp('Input.insertText', { text: char });
        await sleep(perCharMs);
      }
    },
    /** Records the box of the first element that matches `selector` while `gesture()` runs, then holds the end
     * state for `holdMs`, and gives the bytes of a GIF made with ffmpeg. The text of the page is checked before the
     * gesture and after the hold. */
    async recordGif(selector, gesture, { holdMs = 1000, settings = {} } = {}) {
      await session.assertClean();
      await session.ensurePointer();
      const rect = await evaluateExpr(
        cdp,
        `(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { x: Math.floor(r.x), y: Math.floor(r.y), width: Math.floor(r.width), height: Math.floor(r.height) };
        })()`,
      );
      if (rect === null) throw new CaptureCouldNotRun(`${PROGRAM}: no element matches ${selector}`);
      const { frames, endAt } = await recordFrames({
        shoot: async () => {
          const shot = await cdp('Page.captureScreenshot', {
            format: 'png',
            clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 1 },
            captureBeyondViewport: false,
          });
          return Buffer.from(shot.data, 'base64');
        },
        gesture,
        holdMs,
      });
      await session.assertClean();
      const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moontide-capture-frames-'));
      tempDirs.push(workDir);
      try {
        return makeGif({ ffmpegPath: session.ffmpegPath, frames, endAt, workDir, settings });
      } finally {
        fs.rmSync(workDir, { recursive: true, force: true });
      }
    },
    ffmpegPath: 'ffmpeg',
  };
  return session;
}

/** Runs the recipes asked for and writes their pictures into `out`. Gives the exit code. */
async function run(args) {
  const tempDirs = [];
  let client = null;
  let browserChild = null;
  let ws = null;
  let exitCode = 0;
  try {
    const wanted = IMAGES.filter((one) => args.only.includes(one.name));
    if (wanted.some((one) => one.kind === 'gif')) checkFfmpeg(args.ffmpegPath);
    const browserPath = findBrowser({ browserPath: args.browserPath });
    const dataDir = freshDataDir('moontide-capture-data-');
    tempDirs.push(dataDir);
    fs.writeFileSync(path.join(dataDir, 'instruments.json'), JSON.stringify(DEMO_RIG));
    const sessionFolder = makeNamedFolder(DEMO_SESSION_FOLDER, tempDirs);

    const started = await startMoontide(dataDir, sessionFolder);
    client = started.client;

    const userDataDir = freshDataDir('moontide-capture-browser-');
    tempDirs.push(userDataDir);
    browserChild = spawn(browserPath, browserArgs(userDataDir, started.pageUrl, args.headful), {
      stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
    });
    closeBrowserOnSignal(browserChild, tempDirs, PROGRAM);

    const port = await pollDevToolsPort(userDataDir, 10000);
    const target = await findPageTarget(port, started.pageUrl, 10000);
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await waitSocketOpen(ws);
    const cdp = makeCdp(ws);

    const session = await prepare({ client, cdp, tempDirs });
    session.ffmpegPath = args.ffmpegPath;
    fs.mkdirSync(args.out, { recursive: true });

    let written = 0;
    for (const image of wanted) {
      try {
        await session.freshPage();
        const taken = await image.capture(session);
        const bytes = image.kind === 'png' ? keepSafePngChunks(taken) : keepSafeGifBlocks(taken);
        if (!IMAGE_NAME.test(image.file)) throw new ImageRefused(`${image.file} is not an image name the manual accepts`);
        let info;
        try {
          info = readImage(bytes, image.file);
        } catch (error) {
          throw new ImageRefused(error.message);
        }
        if (bytes.length > MAX_IMAGE_BYTES) {
          throw new ImageRefused(`${image.file} weighs ${bytes.length} bytes; the limit is ${MAX_IMAGE_BYTES}`);
        }
        const wrong = (await session.portsUsed()).filter((name) => name !== DEMO_PORT);
        if (wrong.length > 0) throw new ImageRefused('a port other than the demo instrument got a message');
        fs.writeFileSync(path.join(args.out, image.file), bytes);
        const length = info.kind === 'gif' ? ` ${(info.durationMs / 1000).toFixed(1)} s` : '';
        console.log(`${PROGRAM}: ${image.name} ${info.width}x${info.height}${length} ${bytes.length} bytes`);
        written += 1;
      } catch (error) {
        if (!(error instanceof ImageRefused)) throw error;
        console.error(`${PROGRAM}: ${image.name} refused: ${error.message}`);
        exitCode = 1;
      }
    }
    const asked = args.only.length;
    if (exitCode === 0) {
      console.log(`${PROGRAM}: ${written} ${written === 1 ? 'image' : 'images'} written to ${args.out}`);
    } else {
      console.error(`${PROGRAM}: ${written} of ${asked} images written to ${args.out}`);
    }
    return exitCode;
  } catch (error) {
    console.error(`${PROGRAM}: ${error instanceof Error ? error.message.replace(new RegExp(`^${PROGRAM}: `), '') : String(error)}`);
    return 2;
  } finally {
    if (ws !== null) {
      try {
        ws.close();
      } catch {
        // The socket may already be closed.
      }
    }
    if (browserChild !== null) {
      try {
        await closeBrowser(browserChild);
      } catch (error) {
        console.error(`${PROGRAM}: failed to close the browser: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (client !== null) {
      try {
        await client.close();
      } catch (error) {
        console.error(`${PROGRAM}: failed to close the MCP client: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await removeTempDirs(tempDirs, PROGRAM);
  }
}

export async function main(argv) {
  let args;
  try {
    args = parseCaptureArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  return run(args);
}

// Runs only when executed directly, like scripts/probe-page.mjs.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
