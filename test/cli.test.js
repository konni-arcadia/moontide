// The command line of the built entry: --version, the version line at start, and the shape of the bin file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readPackageVersion, PACKAGE_JSON_PATH } from '../dist/version.js';
import { DIST_ENTRY, spawnServer, waitForExit } from './helpers.js';

const REPO_PACKAGE_JSON = fileURLToPath(new URL('../package.json', import.meta.url));
const packageVersion = JSON.parse(fs.readFileSync(REPO_PACKAGE_JSON, 'utf8')).version;

function fixtureDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moontide-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function runCli(args) {
  return spawnSync(process.execPath, [DIST_ENTRY, ...args], {
    encoding: 'utf8',
    env: { ...process.env, MOONTIDE_NO_BROWSER: '1' },
    timeout: 20000,
  });
}

test('version: readPackageVersion reads the version of the package itself', () => {
  assert.equal(PACKAGE_JSON_PATH, REPO_PACKAGE_JSON);
  assert.equal(readPackageVersion(), packageVersion);
});

test('version: a missing package.json is a loud error that says it could not be read', (t) => {
  const dir = fixtureDir(t);
  assert.throws(() => readPackageVersion(path.join(dir, 'package.json')), /package\.json could not be read/);
});

test('version: a package.json without a usable version is a loud error', (t) => {
  const dir = fixtureDir(t);
  const file = path.join(dir, 'package.json');
  for (const text of ['{}', '{"version": ""}', '{"version": 3}', 'null', '[]']) {
    fs.writeFileSync(file, text);
    assert.throws(() => readPackageVersion(file), /version field is missing or empty/, text);
  }
  fs.writeFileSync(file, '{ not json');
  assert.throws(() => readPackageVersion(file), /not valid JSON/);
});

test('--version: prints exactly the package version and a newline on stdout, nothing on stderr, exit 0', () => {
  const run = runCli(['--version']);
  assert.equal(run.status, 0);
  assert.equal(run.stdout, `${packageVersion}\n`);
  assert.equal(run.stderr, '');
});

test('--version: any other argument after it exits 2 with a usage line that lists --version', () => {
  const run = runCli(['--version', 'extra']);
  assert.equal(run.status, 2);
  assert.equal(run.stdout, '');
  assert.match(run.stderr, /Usage: moontide-mcp \[--version \| import-midnam /);
});

test('start: the version line comes once, before the page line, and once the start reply is in the server writes nothing more to stdout', async (t) => {
  const server = await spawnServer();
  t.after(() => server.child.kill());
  // Stdout is the protocol: spawnServer already read the replies of the handshake and the start
  // tool, so only output after them counts here, and there must be none.
  const stdoutAfterReplies = server.stdoutText.length;
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.equal(server.stdoutText.length, stdoutAfterReplies);
  const lines = server.stderrText.split('\n').filter((line) => /^\[moontide\] Version /.test(line));
  assert.deepEqual(lines, [`[moontide] Version ${packageVersion}`]);
  assert.ok(
    server.stderrText.indexOf('[moontide] Version ') < server.stderrText.indexOf('Moontide page:'),
    'the version line comes before the page line',
  );
  server.child.stdin.end();
  const { code } = await waitForExit(server.child, 10000);
  assert.equal(code, 0);
});

test('bin: the built entry starts with an LF-only shebang line and holds no carriage return', () => {
  const bytes = fs.readFileSync(DIST_ENTRY);
  const shebang = Buffer.from('#!/usr/bin/env node\n');
  assert.ok(bytes.subarray(0, shebang.length).equals(shebang), 'dist/index.js must start with the shebang and a single LF');
  assert.equal(bytes.indexOf(0x0d), -1, 'dist/index.js holds a carriage return byte');
});

test('bin: the compiler is told to write LF on every system, so the check above holds off Windows too', () => {
  const tsconfig = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../tsconfig.json', import.meta.url)), 'utf8'));
  assert.equal(tsconfig.compilerOptions.newLine, 'lf');
});
