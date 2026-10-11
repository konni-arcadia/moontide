import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makePackageCopy, removeTempDirs } from '../scripts/probe-page.mjs';

const repoModules = path.join(fileURLToPath(new URL('..', import.meta.url)), 'node_modules');

async function captureErrors(fn) {
  const lines = [];
  const original = console.error;
  console.error = (...args) => lines.push(args.join(' '));
  try {
    await fn();
  } finally {
    console.error = original;
  }
  return lines;
}

test('removeTempDirs removes a package copy and leaves the repo node_modules intact', async () => {
  const before = fs.readdirSync(repoModules).length;
  const copy = makePackageCopy();
  const lines = await captureErrors(() => removeTempDirs([copy], 'test'));
  assert.deepEqual(lines, []);
  assert.equal(fs.existsSync(copy), false);
  assert.equal(fs.readdirSync(repoModules).length, before);
});

test('removeTempDirs leaves a package copy on disk, and says so, when its link cannot be removed', async () => {
  const copy = makePackageCopy();
  const link = path.join(copy, 'node_modules');
  fs.unlinkSync(link);
  fs.mkdirSync(link);
  fs.writeFileSync(path.join(link, 'keep.txt'), 'x');
  try {
    const lines = await captureErrors(() => removeTempDirs([copy], 'test'));
    assert.equal(fs.existsSync(path.join(link, 'keep.txt')), true);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /NOT removing/);
    assert.ok(lines[0].includes(copy));
  } finally {
    fs.rmSync(copy, { recursive: true, force: true });
  }
});
