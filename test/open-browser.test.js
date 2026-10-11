import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOpenCommand, openBrowser } from '../dist/open-browser.js';
import { spawnServer } from './helpers.js';

const URL = 'http://localhost:5757';

/** Runs fn with console.error replaced by a collector, always restoring it afterward. */
async function withCapturedStderr(fn) {
  const lines = [];
  const original = console.error;
  console.error = (...args) => {
    lines.push(args.join(' '));
  };
  try {
    await fn(lines);
  } finally {
    console.error = original;
  }
}

function waitForStderrIncludes(getStderr, text, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (getStderr().includes(text)) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`Timed out waiting for stderr to include: ${text}\n--- stderr ---\n${getStderr()}`));
        return;
      }
      setTimeout(check, 25);
    };
    check();
  });
}

test('buildOpenCommand: darwin uses open', () => {
  assert.deepEqual(buildOpenCommand(URL, 'darwin'), { command: 'open', args: [URL] });
});

test('buildOpenCommand: linux and freebsd use xdg-open', () => {
  assert.deepEqual(buildOpenCommand(URL, 'linux'), { command: 'xdg-open', args: [URL] });
  assert.deepEqual(buildOpenCommand(URL, 'freebsd'), { command: 'xdg-open', args: [URL] });
});

test('buildOpenCommand: win32 uses cmd /c start with an empty-title placeholder and windowsVerbatimArguments', () => {
  const result = buildOpenCommand(URL, 'win32');
  assert.equal(result.command, 'cmd');
  assert.deepEqual(result.args, ['/c', 'start', '""', URL]);
  assert.equal(result.options?.windowsVerbatimArguments, true);
});

test('buildOpenCommand: rejects any URL that is not exactly http://localhost:<digits>', () => {
  const invalid = [
    'http://localhost:5757 & calc',
    'http://evil.example',
    'file:///etc/passwd',
    'http://localhost:5757/x',
  ];
  for (const url of invalid) {
    assert.throws(() => buildOpenCommand(url, 'darwin'), /Refusing to open unexpected URL/);
  }
});

test('openBrowser: spawns detached/ignored/hidden and unrefs the child', () => {
  let capturedArgs;
  let unrefCalled = false;
  const fakeSpawn = (command, args, options) => {
    capturedArgs = { command, args, options };
    return {
      on() {},
      unref() {
        unrefCalled = true;
      },
    };
  };
  openBrowser(URL, { platform: 'darwin', spawn: fakeSpawn });
  assert.equal(capturedArgs.command, 'open');
  assert.deepEqual(capturedArgs.args, [URL]);
  assert.equal(capturedArgs.options.detached, true);
  assert.equal(capturedArgs.options.stdio, 'ignore');
  assert.equal(capturedArgs.options.windowsHide, true);
  assert.ok(unrefCalled, 'expected child.unref() to be called');
});

test('openBrowser: a fake child "error" event writes the fallback line and never throws', async () => {
  let errorHandler;
  const fakeSpawn = () => ({
    on(event, handler) {
      if (event === 'error') {
        errorHandler = handler;
      }
    },
    unref() {},
  });
  await withCapturedStderr((lines) => {
    assert.doesNotThrow(() => openBrowser(URL, { platform: 'darwin', spawn: fakeSpawn }));
    errorHandler(new Error('spawn ENOENT'));
    assert.ok(
      lines.some((l) => l === `[moontide] Could not open the browser automatically (spawn ENOENT). Open ${URL} manually.`),
      `expected the fallback line, got: ${JSON.stringify(lines)}`,
    );
  });
});

test('openBrowser: a spawn that throws synchronously writes the same fallback line and never throws', async () => {
  const fakeSpawn = () => {
    throw new Error('spawn ENOENT');
  };
  await withCapturedStderr((lines) => {
    assert.doesNotThrow(() => openBrowser(URL, { platform: 'darwin', spawn: fakeSpawn }));
    assert.ok(
      lines.some((l) => l === `[moontide] Could not open the browser automatically (spawn ENOENT). Open ${URL} manually.`),
      `expected the fallback line, got: ${JSON.stringify(lines)}`,
    );
  });
});

test('server start with MOONTIDE_NO_BROWSER=1 says so on stderr and never opens a tab', async (t) => {
  // Keep the server object: `stderrText` is a live getter, destructuring it would freeze a snapshot.
  const server = await spawnServer();
  const { child } = server;
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  });
  await waitForStderrIncludes(() => server.stderrText, 'MOONTIDE_NO_BROWSER=1: not opening the browser.');
});
