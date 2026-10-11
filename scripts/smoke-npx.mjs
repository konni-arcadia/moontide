#!/usr/bin/env node
// Packs the project as npm would for publishing, then installs and runs it exactly the way a
// user's `npx -y` would — from a new empty folder, through the real npx resolution: first
// `--version`, then the server itself. The package comes from the packed tarball, not the registry.
// Cross-platform: no shell-specific syntax, only Node's own child_process/fs/path/os/net APIs.
// It tests the local tarball; publishing to npm is a separate step.

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

class SmokeFailure extends Error {}

function fail(message) {
  throw new SmokeFailure(message);
}

function isPortClosed(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', (err) => {
      socket.destroy();
      resolve(err.code === 'ECONNREFUSED');
    });
  });
}

async function main() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

  // 1. This script must run through `npm run smoke:npx` so npm_execpath is available.
  const npmExecPath = process.env.npm_execpath;
  if (!npmExecPath) {
    fail('run this through npm run smoke:npx');
  }

  // 2. A tarball always carries a fresh build.
  console.error('[smoke:npx] Building...');
  execFileSync(process.execPath, [npmExecPath, 'run', 'build'], { cwd: repoRoot, stdio: 'inherit' });

  // 3. Pack into a temp dir and verify the file list.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moontide-smoke-'));

  console.error('[smoke:npx] Packing...');
  const packOutput = execFileSync(
    process.execPath,
    [npmExecPath, 'pack', '--ignore-scripts', '--json', '--pack-destination', tmpDir],
    { cwd: repoRoot },
  ).toString();
  const [entry] = JSON.parse(packOutput);
  if (!entry) {
    fail('npm pack produced no output entry');
  }
  const filePaths = entry.files.map((f) => f.path);
  for (const required of ['dist/index.js', 'dist/listen.js', 'page/index.html', 'page/main.js']) {
    if (!filePaths.includes(required)) {
      fail(`packed tarball is missing ${required}`);
    }
  }
  // Every reference/*.md file the repo ships must be in the tarball too.
  const referenceFiles = fs
    .readdirSync(path.join(repoRoot, 'reference'))
    .filter((name) => name.endsWith('.md'))
    .map((name) => `reference/${name}`);
  for (const required of referenceFiles) {
    if (!filePaths.includes(required)) {
      fail(`packed tarball is missing ${required}`);
    }
  }
  // Every shipped instrument model must be in the tarball too.
  const instrumentFiles = fs
    .readdirSync(path.join(repoRoot, 'instruments'))
    .filter((name) => name.endsWith('.json'))
    .map((name) => `instruments/${name}`);
  for (const required of instrumentFiles) {
    if (!filePaths.includes(required)) {
      fail(`packed tarball is missing ${required}`);
    }
  }
  // The tarball holds only what package.json publishes through its "files" list, plus the three
  // files npm always adds. Anything else fails, so a new top-level folder cannot slip in.
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const allowedPrefixes = packageJson.files.map((entry) => `${entry}/`);
  const allowedExact = new Set(['package.json', 'README.md', 'LICENSE']);
  const unexpected = filePaths.filter(
    (p) => !allowedExact.has(p) && !allowedPrefixes.some((prefix) => p.startsWith(prefix)),
  );
  if (unexpected.length > 0) {
    fail(`packed tarball must not contain: ${unexpected.join(', ')}`);
  }
  // Moontide never ships a third-party patch list, so no MIDNAM file and no catalog is in the package.
  const patchLists = filePaths.filter((p) => p.toLowerCase().endsWith('.midnam') || p.startsWith('catalogs/'));
  if (patchLists.length > 0) {
    fail(`packed tarball must not contain a patch list: ${patchLists.join(', ')}`);
  }
  const tarballPath = path.join(tmpDir, entry.filename);
  if (!fs.existsSync(tarballPath)) {
    fail(`expected tarball at ${tarballPath}, but it does not exist`);
  }

  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('npm_')) delete env[key];
  }
  env.MOONTIDE_NO_BROWSER = '1';
  // The smoke run must never read or write the user's real per-user history.
  env.MOONTIDE_DATA_DIR = path.join(tmpDir, 'data');

  // 3b. The import command works after an install. The file is the one written for the
  // project's tests, copied into a folder whose name holds a space (a path a user may type), and the
  // data folder is the isolated one above. No shell string: the arguments reach the command as given,
  // on every platform.
  console.error('[smoke:npx] Importing a MIDNAM file through the packed command...');
  const fixtureCopy = path.join(tmpDir, 'patch files', 'moontide test.midnam');
  fs.mkdirSync(path.dirname(fixtureCopy), { recursive: true });
  fs.copyFileSync(path.join(repoRoot, 'test', 'fixtures', 'moontide-test.midnam'), fixtureCopy);
  const runImport = () => {
    const args = [
      npmExecPath,
      'exec',
      '--yes',
      `--package=file:${tarballPath}`,
      '--',
      'moontide-mcp',
      'import-midnam',
      fixtureCopy,
      '--model',
      'sc55',
    ];
    try {
      const stdout = execFileSync(process.execPath, args, { cwd: tmpDir, env, encoding: 'utf8', stdio: 'pipe' });
      return { status: 0, stdout, stderr: '' };
    } catch (err) {
      return { status: err.status, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? '') };
    }
  };
  const first = runImport();
  if (first.status !== 0 || !first.stdout.includes('Imported ')) {
    fail(`import-midnam through the packed command failed (exit ${first.status}):\n${first.stdout}\n${first.stderr}`);
  }
  const catalogPath = path.join(env.MOONTIDE_DATA_DIR, 'catalogs', 'sc55.json');
  if (!fs.existsSync(catalogPath)) {
    fail(`import-midnam did not write ${catalogPath}`);
  }
  const imported = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  if (imported.model !== 'sc55' || !Array.isArray(imported.sounds) || imported.sounds.length < 1) {
    fail('the imported catalog is not a catalog of sc55 with at least one sound');
  }
  const second = runImport();
  if (second.status !== 1 || !second.stderr.includes('already exists')) {
    fail(`a second import without --replace should exit 1 with "already exists" (exit ${second.status}):\n${second.stderr}`);
  }

  // 3c. A new empty folder, as a user's first run would start in. `--version` must answer the package
  // version and a newline, and nothing else, and the run must leave the folder empty.
  const emptyCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'moontide-empty-'));
  console.error('[smoke:npx] Asking the packed command for --version from an empty folder...');
  let versionOutput;
  try {
    versionOutput = execFileSync(
      process.execPath,
      [npmExecPath, 'exec', '--yes', `--package=file:${tarballPath}`, '--', 'moontide-mcp', '--version'],
      { cwd: emptyCwd, env, encoding: 'utf8', stdio: 'pipe' },
    );
  } catch (err) {
    fail(`--version through the packed command failed (exit ${err.status}):\n${String(err.stdout ?? '')}\n${String(err.stderr ?? '')}`);
  }
  if (versionOutput !== `${packageJson.version}\n`) {
    fail(`--version answered ${JSON.stringify(versionOutput)}, expected ${JSON.stringify(`${packageJson.version}\n`)}`);
  }

  // 4. Start the packed server exactly as a user would: npx --yes <tarball>, from the empty folder.
  console.error('[smoke:npx] Installing and starting via npx (first run may download deps)...');

  // A bare absolute path (no `file:` prefix) is misresolved by npx on some npm versions —
  // it gets treated as a package specifier rather than a filesystem path and npx tries to
  // execute the tarball itself, failing with EACCES ("Permission denied"). The standard,
  // version-independent way to pass an explicit local path is the `file:` URI form, which
  // resolves correctly from any cwd (verified here from an unrelated directory).
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['--yes', `file:${tarballPath}`],
    cwd: emptyCwd,
    env,
    stderr: 'pipe',
  });

  let stderrText = '';
  transport.stderr?.on('data', (chunk) => {
    stderrText += chunk.toString();
  });

  const client = new Client({ name: 'moontide-smoke-client', version: '0.0.0' });
  await client.connect(transport, { timeout: 180000 });

  try {
    // 5. The packed server stays quiet until a start; then tools must be present and the page served.
    if (/Moontide page: /.test(stderrText)) {
      fail(`the packed server started its page before any start:\n${stderrText}`);
    }
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    if (!names.includes('get_code') || !names.includes('set_code')) {
      fail(`expected tools get_code and set_code, got: ${names.join(', ')}`);
    }
    if (!names.includes('get_strudel_reference')) {
      fail(`expected tool get_strudel_reference, got: ${names.join(', ')}`);
    }

    // The installed package must resolve its own bundled reference directory.
    const referenceResult = await client.callTool({
      name: 'get_strudel_reference',
      arguments: { topic: 'tidal-differences' },
    });
    if (referenceResult.isError || !referenceResult.content[0].text.includes('@strudel/repl 1.3.0')) {
      fail(`get_strudel_reference did not return the expected reference text: ${JSON.stringify(referenceResult)}`);
    }

    // Nothing runs until the start tool; its reply must name the page address.
    const startResult = await client.callTool({ name: 'start', arguments: {} });
    if (startResult.isError || !startResult.content[0].text.includes('http://localhost:')) {
      fail(`the start tool did not give the page address: ${JSON.stringify(startResult)}`);
    }

    const match = /Moontide page: (http:\/\/localhost:(\d+))/.exec(stderrText);
    if (!match) {
      fail(`could not find the page URL in server stderr:\n${stderrText}`);
    }
    const [, url, portStr] = match;
    const port = Number(portStr);

    const res = await fetch(`${url}/`);
    if (res.status !== 200) {
      fail(`expected the page to respond 200, got ${res.status}`);
    }
    const body = await res.text();
    if (!body.includes('<strudel-editor')) {
      fail('served page did not contain <strudel-editor');
    }
    // The packed server must template the per-start page token into the page it serves.
    if (!/<meta name="moontide-page-token" content="[0-9a-f]{64}">/.test(body)) {
      fail('served page did not carry a 64-hex page token (is the token placeholder templated?)');
    }

    // 6. After the client disconnects, the server process must not linger (no orphan).
    await client.close();
    const deadline = Date.now() + 5000;
    let closed = false;
    while (Date.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop
      closed = await isPortClosed(port);
      if (closed) break;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!closed) {
      fail('server still listening after the client closed (orphan process)');
    }
    if (fs.readdirSync(emptyCwd).length > 0) {
      fail('the npx run left files in the empty folder');
    }
  } finally {
    await transport.close().catch(() => {});
  }

  // 7. Clean up and report success.
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(emptyCwd, { recursive: true, force: true });
  console.log(`smoke:npx OK (${entry.filename}; --version ${packageJson.version} from an empty folder)`);
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[smoke:npx] FAILED: ${message}`);
  process.exit(1);
});
