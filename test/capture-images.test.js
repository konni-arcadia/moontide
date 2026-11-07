import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import {
  DEMO_KEYBOARD,
  DEMO_PIECE,
  DEMO_PORT,
  DEMO_RIG,
  DEMO_SCENARIO,
  DEMO_SESSION_FOLDER,
  IMAGES,
  GIF_SETTINGS,
  MAX_IMAGE_BYTES,
  browserArgs,
  checkRecordingLength,
  concatList,
  forbiddenFound,
  frameDurations,
  gifArgs,
  keepSafeGifBlocks,
  keepSafePngChunks,
  makeGif,
  parseCaptureArgs,
  privateNeedles,
  recordFrames,
  runFfmpeg,
  startMoontide,
  checkFfmpeg,
} from '../scripts/capture-manual-images.mjs';
import { IMAGE_NAME, PNG_SAFE_CHUNKS, buildSite, readImage } from '../scripts/build-site.mjs';

// This test starts no browser, no server and no ffmpeg: it reads the script's exports and files of the repository.

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const siteDir = path.join(root, 'site');
const imagesDir = path.join(siteDir, 'images');

// ---- the recipes, the images and the pages agree ----

test('every recipe has a unique name by the image name rule, a kind that matches its file, and the fields the script needs', () => {
  assert.ok(IMAGES.length > 0);
  assert.ok(Object.isFrozen(IMAGES));
  const names = new Set();
  for (const image of IMAGES) {
    assert.ok(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(image.name), `${image.name} is an image name`);
    assert.ok(!names.has(image.name), `${image.name} is unique`);
    names.add(image.name);
    assert.ok(['png', 'gif'].includes(image.kind), `${image.name}: png or gif`);
    assert.equal(image.file, `${image.name}.${image.kind}`, `${image.name}: the file ends with its kind`);
    assert.ok(IMAGE_NAME.test(image.file), `${image.file} passes the image name rule of the build`);
    assert.ok(typeof image.shows === 'string' && image.shows.trim().length > 10, `${image.name}: says in plain words what it shows`);
    assert.equal(typeof image.capture, 'function', `${image.name}: has a capture`);
    assert.ok(Object.isFrozen(image), `${image.name}: is frozen`);
  }
});

test('every recipe has its file in site/images and its page names that file under the recipe\'s section heading', () => {
  for (const image of IMAGES) {
    assert.ok(fs.existsSync(path.join(imagesDir, image.file)), `${image.file} is in site/images`);
    const page = fs.readFileSync(path.join(siteDir, image.page), 'utf8');
    const lines = page.split(/\r?\n/);
    const start = lines.findIndex((line) => line === `## ${image.section}`);
    assert.ok(start >= 0, `${image.page} has the heading "${image.section}"`);
    let end = lines.findIndex((line, index) => index > start && /^## /.test(line));
    if (end < 0) end = lines.length;
    const section = lines.slice(start, end).join('\n');
    assert.ok(section.includes(`](images/${image.file})`), `${image.page}: "${image.section}" shows images/${image.file}`);
  }
});

test('every file of site/images has a recipe, so a picture can be taken again', () => {
  const recipes = new Set(IMAGES.map((image) => image.file));
  for (const name of fs.readdirSync(imagesDir)) assert.ok(recipes.has(name), `${name} has a recipe in scripts/capture-manual-images.mjs`);
});

test('the pictures in site/images match their recipe\'s kind and the limits of the gate', () => {
  for (const image of IMAGES) {
    const bytes = fs.readFileSync(path.join(imagesDir, image.file));
    assert.equal(readImage(bytes, image.file).kind, image.kind);
    assert.ok(bytes.length <= MAX_IMAGE_BYTES, `${image.file} weighs ${bytes.length} bytes`);
  }
  assert.equal(MAX_IMAGE_BYTES, 400000);
});

// ---- the demo piece ----

const labeled = DEMO_PIECE.split('\n').filter((line) => /^[a-z][A-Za-z0-9_]*: /.test(line));

test('the demo piece declares four sections and two groups and four tracks, in the form of the reference', () => {
  assert.match(DEMO_PIECE, /^setcps\(/);
  assert.match(DEMO_PIECE, /const song = \{/);
  const sections = /sections: \[(.*)\],/.exec(DEMO_PIECE)[1];
  assert.equal(sections.match(/\['[a-z]+', \d+\]/g).length, 4);
  const groups = /groups: \{(.*)\},/.exec(DEMO_PIECE)[1];
  assert.equal(groups.match(/[a-z]+: \[/g).length, 2);
  assert.equal(labeled.length, 4);
  for (const line of labeled) assert.match(line, /^([a-z]+): play\('\1', \1\)/, `${line} is a labeled statement named as its track`);
});

test('the demo piece plays every labeled track through .midi on the SC-55 and calls no web audio sound', () => {
  for (const line of labeled) assert.ok(line.includes(`.midi('${DEMO_PORT}'`), `${line} plays on the SC-55`);
  assert.equal(DEMO_PIECE.match(/\.midi\(/g).length, labeled.length, 'no other .midi call');
  for (const pattern of [/\.s\(/, /(^|[^\w.])s\(/, /\.sound\(/, /\bsound\(/, /\.bank\(/, /\.gain\(/, /\.postgain\(/, /examples[/]/i]) {
    assert.doesNotMatch(DEMO_PIECE, pattern, `the demo piece does not match ${pattern}`);
  }
  assert.match(labeled.find((line) => line.startsWith('drums:')), /midichannel: 10/);
  const channels = labeled.map((line) => /midichannel: (\d+)/.exec(line)[1]);
  assert.equal(new Set(channels).size, channels.length, 'each track has its own channel');
});

test('the sounds of the demo piece are sounds of the shipped SC-55 model, and the setup names only the demo ports', () => {
  const model = JSON.parse(fs.readFileSync(path.join(root, 'instruments', 'sc55.json'), 'utf8'));
  const known = new Set([...model.sounds.melodic, ...model.sounds.rhythm].map((sound) => sound.name));
  for (const line of labeled) {
    const sound = /sound: '([^']+)'/.exec(line)[1];
    assert.ok(known.has(sound), `${sound} is a sound of the sc55 model`);
  }
  assert.deepEqual(DEMO_RIG, { instruments: [{ id: 'sc55', model: 'sc55', port: DEMO_PORT }], inputs: [{ port: DEMO_KEYBOARD }] });
  assert.deepEqual(DEMO_SCENARIO, { permission: 'granted', outputs: [DEMO_PORT], inputs: [DEMO_KEYBOARD] });
  assert.equal(DEMO_PORT, 'SC-55');
  assert.equal(DEMO_KEYBOARD, 'My Keyboard');
  assert.ok(/^[a-z-]+$/.test(DEMO_SESSION_FOLDER), 'the session folder is a made-up plain name');
});

// ---- the browser ----

test('the browser is muted, headless unless asked for a window, and ends with the page address', () => {
  const quiet = browserArgs('/profile', 'http://localhost:1234', false);
  assert.ok(quiet.includes('--mute-audio'));
  assert.ok(quiet.includes('--headless=new'));
  assert.ok(quiet.includes('--user-data-dir=/profile'));
  assert.equal(quiet.at(-1), 'http://localhost:1234');
  const shown = browserArgs('/profile', 'http://localhost:1234', true);
  assert.ok(shown.includes('--mute-audio'), 'a window is muted too');
  assert.ok(!shown.includes('--headless=new'));
  assert.equal(shown.at(-1), 'http://localhost:1234');
});

// ---- the options ----

test('the options refuse a missing --out, an --out inside the repository, an unknown --only name and an unknown flag', () => {
  const refused = (argv) => {
    assert.throws(() => parseCaptureArgs(argv), (error) => {
      assert.match(error.message, /^capture: /);
      return true;
    });
  };
  refused([]);
  refused(['--only', 'song-grid']);
  refused(['--out', '']);
  refused(['--out', path.join(root, 'site', 'images-new')]);
  refused(['--out', path.join(root, 'site', 'images')]);
  refused(['--out', root]);
  refused(['--out', path.join(os.tmpdir(), 'moontide-capture-test-missing'), '--only', 'no-such-picture']);
  refused(['--out', path.join(os.tmpdir(), 'moontide-capture-test-missing'), '--nope']);
  refused(['--out', path.join(os.tmpdir(), 'moontide-capture-test-missing'), 'extra']);
  try {
    parseCaptureArgs(['--out', path.join(os.tmpdir(), 'moontide-capture-test-missing'), '--only', 'no-such-picture']);
    assert.fail('expected a refusal');
  } catch (error) {
    assert.ok(error.message.includes('no-such-picture'));
    for (const image of IMAGES) assert.ok(error.message.includes(image.name), 'the refusal lists the names');
  }
});

test('the options accept a missing or empty folder outside the repository and refuse one that holds something', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moontide-capture-test-'));
  try {
    const missing = path.join(dir, 'new');
    const args = parseCaptureArgs(['--out', missing, '--only', IMAGES[0].name, '--browser', '/some/browser', '--headful']);
    assert.deepEqual(args, { out: missing, only: [IMAGES[0].name], browserPath: '/some/browser', ffmpegPath: 'ffmpeg', headful: true });
    assert.equal(parseCaptureArgs(['--out', missing, '--ffmpeg', '/some/ffmpeg']).ffmpegPath, '/some/ffmpeg');
    fs.mkdirSync(missing);
    assert.equal(parseCaptureArgs(['--out', missing]).headful, false);
    assert.deepEqual(parseCaptureArgs(['--out', missing]).only, IMAGES.map((image) => image.name));
    fs.writeFileSync(path.join(missing, 'x'), 'x');
    assert.throws(() => parseCaptureArgs(['--out', missing]), /^Error: capture: --out is not empty|capture: --out is not empty/);
    assert.throws(() => parseCaptureArgs(['--out', path.join(missing, 'x')]), /capture: --out is (a file|not empty)/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- nothing personal in a picture ----

test('forbiddenFound finds each kind of needle in any letter case and returns kinds, never text', () => {
  const needles = [
    { kind: 'the user name', value: 'Someone' },
    { kind: 'the host name', value: 'Some-Host.local' },
    { kind: 'the host name', value: 'Some-Host' },
    { kind: 'the home folder', value: '/srv/people/someone' },
    { kind: 'the repository folder', value: '/work/repo' },
    { kind: 'a temporary folder', value: '/tmp/run-1' },
  ];
  assert.deepEqual(forbiddenFound('nothing here, only my-music and SC-55', needles), []);
  assert.deepEqual(forbiddenFound('hello SOMEONE', needles), ['the user name']);
  assert.deepEqual(forbiddenFound('on some-host today', needles), ['the host name']);
  assert.deepEqual(forbiddenFound('SOME-HOST.LOCAL and some-host', needles), ['the host name'], 'a kind is named once');
  assert.deepEqual(forbiddenFound('/SRV/People/Someone/music', needles), ['the user name', 'the home folder']);
  assert.deepEqual(forbiddenFound('in /Work/Repo/scripts', needles), ['the repository folder']);
  assert.deepEqual(forbiddenFound('saved to /TMP/run-1/x', needles), ['a temporary folder']);
  const everything = forbiddenFound('someone some-host /srv/people/someone /work/repo /tmp/run-1', needles);
  assert.deepEqual(everything, ['the user name', 'the host name', 'the home folder', 'the repository folder', 'a temporary folder']);
  for (const hit of everything) assert.ok(needles.every((needle) => needle.value !== hit), 'a result is a kind, not the matched text');
  assert.deepEqual(forbiddenFound('anything', [{ kind: 'empty', value: '' }]), [], 'an empty needle matches nothing');
});

test('privateNeedles holds the user, the host and its first label, the home, the repository and each temporary folder of the run', () => {
  const needles = privateNeedles(['/tmp/run-a', '/tmp/run-b'], { root: '/work/repo' });
  const kinds = new Set(needles.map((needle) => needle.kind));
  for (const kind of ['the user name', 'the host name', 'the home folder', 'the repository folder', 'a temporary folder']) assert.ok(kinds.has(kind), kind);
  const values = needles.map((needle) => needle.value);
  assert.ok(values.includes(os.hostname().split('.')[0]));
  assert.ok(values.includes(os.homedir()));
  assert.ok(values.includes(path.resolve('/work/repo')));
  assert.ok(values.includes('/tmp/run-a') && values.includes('/tmp/run-b'));
  assert.ok(needles.every((needle) => needle.value !== ''));
});

// ---- PNG chunks ----

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data = Buffer.alloc(0)) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const header = Buffer.alloc(13);
header.writeUInt32BE(2, 0);
header.writeUInt32BE(1, 4);
header.set([8, 2, 0, 0, 0], 8);
const IHDR = chunk('IHDR', header);
const IDAT = chunk('IDAT', zlib.deflateSync(Buffer.from([0, 255, 0, 0, 0, 255, 0])));
const IEND = chunk('IEND');
const TEXT = chunk('tEXt', Buffer.from('Comment\0secret'));

test('keepSafePngChunks drops a text chunk, keeps IHDR, IDAT and IEND byte for byte, and its output passes readImage while its input does not', () => {
  const dirty = Buffer.concat([SIGNATURE, IHDR, TEXT, chunk('tIME', Buffer.alloc(7)), IDAT, chunk('eXIf', Buffer.from('x')), IEND]);
  assert.throws(() => readImage(dirty, 'a.png'), /tEXt chunk/);
  const clean = keepSafePngChunks(dirty);
  assert.ok(clean.equals(Buffer.concat([SIGNATURE, IHDR, IDAT, IEND])));
  assert.deepEqual(readImage(clean, 'a.png'), { kind: 'png', width: 2, height: 1, durationMs: 0 });
  assert.ok(keepSafePngChunks(clean).equals(clean), 'a clean PNG is unchanged');
});

test('keepSafePngChunks keeps every safe chunk and refuses what is not a whole PNG', () => {
  const lengths = { PLTE: 3, tRNS: 3, sRGB: 1, gAMA: 4, cHRM: 32, pHYs: 9 };
  const safe = PNG_SAFE_CHUNKS.filter((type) => !['IHDR', 'IDAT', 'IEND'].includes(type)).map((type) => chunk(type, Buffer.alloc(lengths[type])));
  const all = Buffer.concat([SIGNATURE, IHDR, ...safe, IDAT, IEND]);
  assert.ok(keepSafePngChunks(all).equals(all));
  assert.throws(() => keepSafePngChunks(Buffer.from('not a png')), /did not give a PNG/);
  assert.throws(() => keepSafePngChunks(Buffer.concat([SIGNATURE, IHDR, IDAT])), /cut short/);
  assert.throws(() => keepSafePngChunks(Buffer.concat([SIGNATURE, IHDR, IDAT, IEND]).subarray(0, 40)), /cut short/);
});

test('keepSafePngChunks drops a colour chunk that is longer than its numbers, and refuses an IHDR, PLTE or IEND of the wrong length', () => {
  const text = Buffer.from('Comment: a made-up path and an address');
  for (const type of ['sRGB', 'gAMA', 'cHRM', 'pHYs', 'tRNS']) {
    const length = { sRGB: 1, gAMA: 4, cHRM: 32, pHYs: 9, tRNS: 257 }[type];
    const dirty = Buffer.concat([SIGNATURE, IHDR, chunk(type, type === 'tRNS' ? Buffer.alloc(length) : text), IDAT, IEND]);
    assert.ok(keepSafePngChunks(dirty).equals(Buffer.concat([SIGNATURE, IHDR, IDAT, IEND])), `${type} with text is dropped`);
    assert.ok(!keepSafePngChunks(dirty).includes('Comment'), type);
  }
  assert.throws(() => keepSafePngChunks(Buffer.concat([SIGNATURE, IHDR, IDAT, chunk('IEND', text)])), /IEND chunk of \d+ bytes/);
  assert.throws(() => keepSafePngChunks(Buffer.concat([SIGNATURE, IHDR, chunk('PLTE', Buffer.alloc(4)), IDAT, IEND])), /PLTE chunk of 4 bytes/);
  const longHeader = chunk('IHDR', Buffer.concat([header, text]));
  assert.throws(() => keepSafePngChunks(Buffer.concat([SIGNATURE, longHeader, IDAT, IEND])), /IHDR chunk/);
});

// ---- GIF blocks ----

const gifBlock = (label, ...subBlocks) => Buffer.concat([Buffer.from([0x21, label]), ...subBlocks.map((data) => Buffer.concat([Buffer.from([data.length]), data])), Buffer.from([0])]);
const GIF_HEAD = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.from([2, 0, 1, 0, 0x80, 0, 0]), Buffer.from([0, 0, 0, 255, 255, 255])]);
const GIF_LOOP = gifBlock(0xff, Buffer.from('NETSCAPE2.0'), Buffer.from([1, 0, 0]));
const GIF_COMMENT = gifBlock(0xfe, Buffer.from('a secret comment'));
const GIF_XMP = gifBlock(0xff, Buffer.from('XMP DataXMP'), Buffer.from('<x:xmpmeta>who and where</x:xmpmeta>'));
const GIF_PLAIN_TEXT = gifBlock(0x01, Buffer.alloc(12), Buffer.from('hidden words'));
const gifControl = (delay) => gifBlock(0xf9, Buffer.from([0, delay & 0xff, delay >> 8, 0]));
const GIF_IMAGE = Buffer.concat([Buffer.from([0x2c, 0, 0, 0, 0, 2, 0, 1, 0, 0]), Buffer.from([2]), Buffer.from([2, 0x4c, 0x01]), Buffer.from([0])]);
const GIF_END = Buffer.from([0x3b]);

test('keepSafeGifBlocks drops a comment, a plain-text block and a foreign application block, keeps the NETSCAPE2.0 loop, every graphic control and image block unchanged, and its output passes readImage while its input does not', () => {
  const dirty = Buffer.concat([GIF_HEAD, GIF_XMP, GIF_LOOP, GIF_COMMENT, gifControl(40), GIF_PLAIN_TEXT, GIF_IMAGE, GIF_COMMENT, gifControl(20), GIF_IMAGE, GIF_END]);
  assert.throws(() => readImage(dirty, 'a.gif'), /(application block|comment block|plain-text block)/);
  const clean = keepSafeGifBlocks(dirty);
  assert.ok(clean.equals(Buffer.concat([GIF_HEAD, GIF_LOOP, gifControl(40), GIF_IMAGE, gifControl(20), GIF_IMAGE, GIF_END])));
  assert.deepEqual(readImage(clean, 'a.gif'), { kind: 'gif', width: 2, height: 1, durationMs: 600 });
  assert.ok(keepSafeGifBlocks(clean).equals(clean), 'a clean GIF is unchanged');
  for (const [name, block] of [['comment', GIF_COMMENT], ['plain-text', GIF_PLAIN_TEXT], ['XMP', GIF_XMP]]) {
    assert.ok(!clean.includes(block), `the ${name} block is gone`);
  }
});

test('keepSafeGifBlocks drops a NETSCAPE2.0 block with more than the loop count and refuses a graphic control block with more than its 4 bytes', () => {
  const loopWithText = gifBlock(0xff, Buffer.from('NETSCAPE2.0'), Buffer.from([1, 0, 0]), Buffer.from('a path and an address'));
  const loopOnly = gifBlock(0xff, Buffer.from('NETSCAPE2.0'));
  const dirty = Buffer.concat([GIF_HEAD, loopWithText, loopOnly, gifControl(10), GIF_IMAGE, GIF_END]);
  const clean = keepSafeGifBlocks(dirty);
  assert.ok(clean.equals(Buffer.concat([GIF_HEAD, gifControl(10), GIF_IMAGE, GIF_END])));
  assert.deepEqual(readImage(clean, 'a.gif'), { kind: 'gif', width: 2, height: 1, durationMs: 100 });
  const control = gifBlock(0xf9, Buffer.from([0, 10, 0, 0]), Buffer.from('a path and an address'));
  assert.throws(() => keepSafeGifBlocks(Buffer.concat([GIF_HEAD, control, GIF_IMAGE, GIF_END])), /graphic control block that is not one block of 4 bytes/);
  assert.throws(() => keepSafeGifBlocks(Buffer.concat([GIF_HEAD, gifBlock(0xf9), GIF_IMAGE, GIF_END])), /graphic control block/);
});

test('keepSafeGifBlocks refuses what is not a whole GIF', () => {
  assert.throws(() => keepSafeGifBlocks(Buffer.from('not a gif at all')), /did not give a GIF/);
  assert.throws(() => keepSafeGifBlocks(Buffer.concat([GIF_HEAD, gifControl(10), GIF_IMAGE])), /cut short/);
  assert.throws(() => keepSafeGifBlocks(Buffer.concat([GIF_HEAD, gifControl(10), GIF_IMAGE.subarray(0, 8)])), /cut short/);
  assert.throws(() => keepSafeGifBlocks(Buffer.concat([GIF_HEAD, Buffer.from([0x99]), GIF_END])), /not part of a GIF/);
});

// ---- the GIF recording and the ffmpeg run ----

test('gifArgs loops the GIF, caps the width at 720 px, makes one palette for the whole clip and holds no shell operator', () => {
  const args = gifArgs();
  assert.ok(args.every((arg) => typeof arg === 'string'));
  const at = args.indexOf('-loop');
  assert.ok(at >= 0 && args[at + 1] === '0', '-loop 0 makes it loop');
  const graph = args[args.indexOf('-vf') + 1];
  assert.match(graph, /scale='min\(720,iw\)':-2:flags=lanczos/);
  assert.match(graph, /fps=10/);
  assert.match(graph, /palettegen=stats_mode=diff/);
  assert.match(graph, /paletteuse=[^\[]*diff_mode=rectangle/);
  assert.equal(GIF_SETTINGS.maxWidth, 720);
  assert.equal(GIF_SETTINGS.maxMs, 6000);
  for (const arg of args) assert.doesNotMatch(arg, /^(&&|\|\||\||>|>>|<|&)$/, 'no shell operator is an argument of its own');
  const named = [args[args.indexOf('-i') + 1], args.at(-1)];
  for (const name of named) assert.match(name, /^[a-z0-9.-]+$/, `${name} is a bare file name`);
  const lower = gifArgs({ fps: 8, colors: 64 });
  assert.match(lower[lower.indexOf('-vf') + 1], /fps=8,/);
  assert.match(lower[lower.indexOf('-vf') + 1], /max_colors=64/);
  assert.match(gifArgs({ width: 9999 })[gifArgs({ width: 9999 }).indexOf('-vf') + 1], /min\(9999,iw\)/, 'the builder takes the width it is given; the build refuses a wide GIF');
});

test('the recording length check refuses 6.01 s and accepts 6 s, and a recording holds time', () => {
  assert.doesNotThrow(() => checkRecordingLength(6000));
  assert.throws(() => checkRecordingLength(6010), /6\.01 s long; a GIF of the manual is at most 6 s/);
  assert.throws(() => checkRecordingLength(0), /holds no time/);
  assert.throws(() => checkRecordingLength(Number.NaN), /holds no time/);
});

test('frame times run to the next frame and the last to the end, and the concat list names bare files and lists the last one twice', () => {
  const { shown, totalMs } = frameDurations([{ at: 100 }, { at: 400 }, { at: 1000 }], 2100);
  assert.deepEqual(shown, [{ index: 0, ms: 300 }, { index: 1, ms: 600 }, { index: 2, ms: 1100 }]);
  assert.equal(totalMs, 2000);
  assert.throws(() => frameDurations([], 10), /no frame/);
  const list = concatList(['f0001.png', 'f0002.png', 'f0003.png'], shown);
  assert.equal(list, "file 'f0001.png'\nduration 0.300\nfile 'f0002.png'\nduration 0.600\nfile 'f0003.png'\nduration 1.100\nfile 'f0003.png'\n");
  assert.doesNotMatch(list, /[\\/]/, 'no folder in the list');
});

test('ffmpeg is run with an argument array and never through a shell', () => {
  const source = fs.readFileSync(path.join(root, 'scripts', 'capture-manual-images.mjs'), 'utf8');
  const calls = [...source.matchAll(/(?<![.\w])(spawnSync|spawn|exec|execSync|execFile|execFileSync)\(/g)].map((match) => match[1]);
  assert.ok(calls.includes('spawnSync'));
  assert.ok(!calls.some((name) => /^exec/.test(name)), 'no exec call');
  assert.doesNotMatch(source, /shell:\s*true/);
  assert.match(source, /ffmpeg not found; install it or pass --ffmpeg <path> \(ffmpeg is a tool of the person taking the pictures, not a dependency of Moontide\)/);
});

// ---- the frame loop, the server start and the ffmpeg run fail in a way that lets the script clean up ----

const pngOf = (n) => Buffer.from([n]);

test('recordFrames keeps a frame only when it differs from the one before, and gives the time the recording ended', async () => {
  const shots = [1, 1, 2, 2, 2, 3];
  let taken = 0;
  const { frames, endAt } = await recordFrames({
    shoot: async () => pngOf(shots[Math.min(taken++, shots.length - 1)]),
    gesture: async () => {},
    holdMs: 150,
    intervalMs: 10,
  });
  assert.deepEqual(frames.map((frame) => frame.data[0]), [1, 2, 3]);
  assert.ok(endAt >= 150);
});

test('recordFrames: a screenshot that fails during the gesture reaches the caller as a rejection, with the loop stopped and no unhandled rejection', async () => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    let taken = 0;
    let gestureEnded = false;
    await assert.rejects(
      recordFrames({
        shoot: async () => {
          taken += 1;
          if (taken === 2) throw new Error('screenshot timed out');
          return pngOf(taken);
        },
        gesture: async () => {
          await new Promise((resolve) => setTimeout(resolve, 150));
          gestureEnded = true;
        },
        holdMs: 10,
        intervalMs: 10,
      }),
      /screenshot timed out/,
    );
    assert.ok(gestureEnded, 'the gesture was not cut off by the loop');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(taken, 2, 'the loop stopped after its failure');
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('recordFrames: when the gesture fails too, the gesture\'s error is the one that goes on', async () => {
  let taken = 0;
  await assert.rejects(
    recordFrames({
      shoot: async () => {
        taken += 1;
        if (taken === 2) throw new Error('screenshot timed out');
        return pngOf(taken);
      },
      gesture: async () => {
        await new Promise((resolve) => setTimeout(resolve, 80));
        throw new Error('the click found nothing');
      },
      holdMs: 10,
      intervalMs: 10,
    }),
    /the click found nothing/,
  );
});

// A stand-in for the MCP client and its transport: the server child is the thing that must end.
function fakeServer({ startResult = { content: [] }, startError = null, connectError = null, stderrText = null } = {}) {
  const transport = new EventEmitter();
  transport.stderr = new EventEmitter();
  const state = { closed: 0 };
  const client = {
    async connect() {
      if (connectError) throw connectError;
    },
    async callTool() {
      if (startError) throw startError;
      if (stderrText !== null) setTimeout(() => transport.stderr.emit('data', Buffer.from(stderrText)), 20);
      return startResult;
    },
    async close() {
      state.closed += 1;
    },
  };
  return { make: () => ({ client, transport }), state, client };
}

test('startMoontide gives the client and the page address, and leaves the client open', async () => {
  const fake = fakeServer({ stderrText: 'Moontide page: http://localhost:5999\n' });
  const started = await startMoontide('data', 'cwd', { make: fake.make });
  assert.equal(started.pageUrl, 'http://localhost:5999');
  assert.equal(started.client, fake.client);
  assert.equal(fake.state.closed, 0);
});

test('startMoontide closes the client, so the server child ends, when the start tool answers with an error, when the call rejects, when connecting fails and when no address comes', async () => {
  const cases = [
    [fakeServer({ startResult: { isError: true, content: [{ type: 'text', text: 'no' }] } }), /the start tool failed/],
    [fakeServer({ startError: new Error('transport closed') }), /transport closed/],
    [fakeServer({ connectError: new Error('spawn failed') }), /spawn failed/],
    [fakeServer(), /did not print its page address/],
  ];
  for (const [fake, message] of cases) {
    await assert.rejects(startMoontide('data', 'cwd', { make: fake.make, waitMs: 100 }), message);
    assert.equal(fake.state.closed, 1, `${message}: the client was closed once`);
  }
});

test('ffmpeg is stopped when it runs too long, with a plain message, and an ffmpeg that ends in time is untouched', () => {
  // The running node stands in for ffmpeg: it takes the arguments the test gives it.
  const slow = ['-e', 'setTimeout(() => {}, 60000)'];
  const started = Date.now();
  assert.throws(() => runFfmpeg(process.execPath, slow, { timeoutMs: 300 }), /ffmpeg did not finish within 0\.3 s and was stopped/);
  assert.ok(Date.now() - started < 20000, 'the stuck process was killed');
  const quick = runFfmpeg(process.execPath, ['-e', 'process.stdout.write("done")'], { timeoutMs: 20000 });
  assert.equal(quick.status, 0);
  assert.equal(quick.stdout, 'done');
  assert.throws(() => checkFfmpeg(path.join(os.tmpdir(), 'no-such-ffmpeg-here')), /ffmpeg not found/);
});

test('makeGif passes its time limit to ffmpeg and reports a run that was stopped', () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moontide-capture-test-'));
  try {
    const frames = [{ at: 0, data: Buffer.from([1]) }, { at: 200, data: Buffer.from([2]) }];
    // node reads the ffmpeg arguments as its own and stops at once: that is a run that ended, not one that hung.
    assert.throws(() => makeGif({ ffmpegPath: process.execPath, frames, endAt: 400, workDir, timeoutMs: 20000 }), /ffmpeg could not make the GIF/);
    const source = fs.readFileSync(path.join(root, 'scripts', 'capture-manual-images.mjs'), 'utf8');
    assert.equal(source.match(/spawnSync\(/g).length, 1, 'every ffmpeg run goes through runFfmpeg');
    assert.match(source, /timeout: timeoutMs, killSignal: 'SIGKILL'/);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

// ---- what the script may import ----

test('the script imports only node: built-ins, the MCP client the probes use, and the scripts of the probes and the build', () => {
  const source = fs.readFileSync(path.join(root, 'scripts', 'capture-manual-images.mjs'), 'utf8');
  const specifiers = [...source.matchAll(/^import [^;]*? from '([^']+)';$/gms)].map((m) => m[1]);
  assert.ok(specifiers.length > 5);
  const allowed = new Set([
    '@modelcontextprotocol/sdk/client/index.js',
    '@modelcontextprotocol/sdk/client/stdio.js',
    './probe-page.mjs',
    './probe-midi.mjs',
    './build-site.mjs',
  ]);
  for (const specifier of specifiers) assert.ok(specifier.startsWith('node:') || allowed.has(specifier), `${specifier} is an allowed import`);
  const dependencies = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).dependencies;
  assert.deepEqual(Object.keys(dependencies).sort(), ['@modelcontextprotocol/sdk', 'ws', 'zod']);
});

// ---- the finished set ----

test('the manual holds six to eight images, each shown once under its section with its own size, a text alternative and a caption, kept within the column', () => {
  const files = fs.readdirSync(imagesDir).sort();
  assert.ok(files.length >= 6, `the manual holds ${files.length} images; it needs at least 6`);
  assert.ok(files.length <= 8, `the manual holds ${files.length} images; it holds at most 8`);

  const pages = fs.readdirSync(siteDir).filter((name) => name.endsWith('.md'));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'moontide-images-'));
  try {
    buildSite({ siteDir, outDir: path.join(out, 'site') });
    for (const file of files) {
      const shownBy = pages.filter((page) => fs.readFileSync(path.join(siteDir, page), 'utf8').includes(`](images/${file})`));
      assert.equal(shownBy.length, 1, `${file} must be shown by exactly one page; it is shown by ${shownBy.length} (${shownBy.join(', ') || 'none'})`);

      const recipe = IMAGES.find((image) => image.file === file);
      assert.ok(recipe, `${file} has no recipe in scripts/capture-manual-images.mjs`);
      assert.equal(shownBy[0], recipe.page, `${file} is shown on ${shownBy[0]} but its recipe names ${recipe.page}`);

      const lines = fs.readFileSync(path.join(siteDir, recipe.page), 'utf8').split(/\r?\n/);
      const start = lines.findIndex((line) => line === `## ${recipe.section}`);
      assert.ok(start >= 0, `${recipe.page} has no section "${recipe.section}" for ${file}`);
      let end = lines.findIndex((line, index) => index > start && /^## /.test(line));
      if (end < 0) end = lines.length;
      assert.ok(lines.slice(start, end).join('\n').includes(`](images/${file})`), `${file} is not under the section "${recipe.section}" of ${recipe.page}`);

      const html = fs.readFileSync(path.join(out, 'site', recipe.page.replace(/\.md$/, '.html')), 'utf8');
      const figures = [...html.matchAll(/<figure>\n<img src="images\/([^"]+)" alt="([^"]*)" width="(\d+)" height="(\d+)"[^>]*>\n<figcaption>([\s\S]*?)<\/figcaption>\n<\/figure>/g)].filter((m) => m[1] === file);
      assert.equal(figures.length, 1, `${recipe.page} builds ${figures.length} figures for ${file}; it needs exactly one`);
      const [, , alt, width, height, caption] = figures[0];
      const facts = readImage(fs.readFileSync(path.join(imagesDir, file)), file);
      assert.equal(Number(width), facts.width, `${file}: the figure says width ${width}, the image is ${facts.width}`);
      assert.equal(Number(height), facts.height, `${file}: the figure says height ${height}, the image is ${facts.height}`);
      assert.ok(alt.trim().length > 0, `${file} has no text alternative`);
      assert.ok(caption.trim().length > 0, `${file} has no caption`);
    }
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }

  const css = fs.readFileSync(path.join(siteDir, 'style.css'), 'utf8');
  const rule = /(?:^|\})\s*figure img\s*\{([^}]*)\}/m.exec(css);
  assert.ok(rule, 'site/style.css has no rule for "figure img"');
  assert.match(rule[1], /max-width:\s*100%/, 'site/style.css must keep a figure image within the column (max-width: 100%)');
  assert.match(rule[1], /height:\s*auto/, 'site/style.css must keep a figure image in proportion (height: auto)');
});
