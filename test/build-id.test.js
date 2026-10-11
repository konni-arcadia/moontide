import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fingerprintDirs, BuildWatch, servedDirs } from '../dist/build-id.js';

function makeDir(t, files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moontide-build-id-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  return dir;
}

test('the fingerprint is stable and ignores rewriting identical bytes', (t) => {
  const dir = makeDir(t, { 'index.html': '<html></html>', 'main.js': 'a' });
  const first = fingerprintDirs([dir]);
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(fingerprintDirs([dir]), first);
  fs.writeFileSync(path.join(dir, 'main.js'), 'a');
  assert.equal(fingerprintDirs([dir]), first);
});

test('the fingerprint changes with one byte, an added, a removed or a renamed served file', (t) => {
  const dir = makeDir(t, { 'main.js': 'abc', 'style.css': 'x' });
  const base = fingerprintDirs([dir]);

  fs.writeFileSync(path.join(dir, 'main.js'), 'abd');
  assert.notEqual(fingerprintDirs([dir]), base);
  fs.writeFileSync(path.join(dir, 'main.js'), 'abc');
  assert.equal(fingerprintDirs([dir]), base);

  fs.writeFileSync(path.join(dir, 'extra.js'), 'e');
  assert.notEqual(fingerprintDirs([dir]), base);
  fs.rmSync(path.join(dir, 'extra.js'));
  assert.equal(fingerprintDirs([dir]), base);

  fs.rmSync(path.join(dir, 'style.css'));
  assert.notEqual(fingerprintDirs([dir]), base);
  fs.writeFileSync(path.join(dir, 'style.css'), 'x');

  fs.renameSync(path.join(dir, 'style.css'), path.join(dir, 'other.css'));
  assert.notEqual(fingerprintDirs([dir]), base);
});

test('other extensions and subfolders are ignored', (t) => {
  const dir = makeDir(t, { 'main.js': 'a' });
  const base = fingerprintDirs([dir]);
  fs.writeFileSync(path.join(dir, 'main.js.map'), 'map');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'notes');
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'sub', 'inner.js'), 'inner');
  assert.equal(fingerprintDirs([dir]), base);
});

test('the same file in another folder of the list gives another fingerprint', (t) => {
  const one = makeDir(t, { 'a.js': 'a' });
  const two = makeDir(t, {});
  assert.notEqual(fingerprintDirs([one, two]), fingerprintDirs([two, one]));
});

function watchDirs(t, pageFiles = { 'main.js': 'one' }, serverFiles = { 'a.js': 'x' }) {
  return { page: makeDir(t, pageFiles), server: makeDir(t, serverFiles) };
}

test('BuildWatch: unchanged at first, the page folder reads as changed after an edit and as unchanged after the original bytes are back', (t) => {
  const dirs = watchDirs(t);
  const lines = [];
  const watch = new BuildWatch(dirs, { log: (line) => lines.push(line) });
  assert.deepEqual(watch.changed(), { page: false, server: false });
  fs.writeFileSync(path.join(dirs.page, 'main.js'), 'two');
  assert.deepEqual(watch.changed(), { page: true, server: false });
  fs.writeFileSync(path.join(dirs.page, 'main.js'), 'one');
  assert.deepEqual(watch.changed(), { page: false, server: false });
  assert.deepEqual(lines, []);
});

test('BuildWatch: a change in the compiled code folder alone is a server change, not a page change', (t) => {
  const dirs = watchDirs(t);
  const watch = new BuildWatch(dirs, { log: () => {} });
  fs.writeFileSync(path.join(dirs.server, 'a.js'), 'y');
  assert.deepEqual(watch.changed(), { page: false, server: true });
  fs.writeFileSync(path.join(dirs.page, 'main.js'), 'two');
  assert.deepEqual(watch.changed(), { page: true, server: true });
});

test('BuildWatch over a missing folder logs one line and is off', (t) => {
  const dirs = watchDirs(t);
  const lines = [];
  const watch = new BuildWatch({ page: path.join(dirs.page, 'missing'), server: dirs.server }, { log: (line) => lines.push(line) });
  assert.equal(lines.length, 1);
  assert.ok(lines[0].startsWith('[moontide]'));
  assert.deepEqual(watch.changed(), { page: false, server: false });
  assert.deepEqual(watch.changed(), { page: false, server: false });
  assert.equal(lines.length, 1);
});

test('BuildWatch: a folder that disappears after a good start counts as changed and logs once', (t) => {
  const dirs = watchDirs(t);
  const lines = [];
  const watch = new BuildWatch(dirs, { log: (line) => lines.push(line) });
  fs.rmSync(dirs.page, { recursive: true, force: true });
  assert.deepEqual(watch.changed(), { page: true, server: false });
  assert.equal(lines.length, 1);
  assert.ok(lines[0].startsWith('[moontide]'));
  assert.deepEqual(watch.changed(), { page: true, server: false });
  assert.equal(lines.length, 1);
});

test('servedDirs names the page folder and the compiled code folder', () => {
  const { page, server } = servedDirs();
  assert.ok(fs.existsSync(path.join(page, 'index.html')));
  assert.ok(fs.existsSync(path.join(server, 'build-id.js')));
});
