// The real listener (dist/listen.js) spawned as Claude's Monitor tool would start it: what it
// prints, when it prints nothing, its exit codes, and the quoting of the command that starts it.
// The server side is in-process (a real Session behind a real startWebServer) so the requests are
// built the way the page builds them; the listener itself is always a separate process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Session } from '../dist/session.js';
import { startWebServer } from '../dist/web-server.js';
import {
  listenerCommand,
  listenerUsageLine,
  newToken,
  REQUEST_LINE_PREFIX,
} from '../dist/ask.js';
import { waitForExit } from './helpers.js';

const LISTEN_ENTRY = fileURLToPath(new URL('../dist/listen.js', import.meta.url));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate, what, timeoutMs = 3000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for ${what}`);
    }
    await sleep(10);
  }
}

/** Spawns the listener with stdout collected. `lines()` returns the complete stdout lines so far. */
function spawnListener(args, cleanup) {
  const child = spawn(process.execPath, [LISTEN_ENTRY, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  cleanup.push(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
    }
  });
  return {
    child,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    lines() {
      return stdout === '' ? [] : stdout.replace(/\n$/, '').split('\n');
    },
  };
}

/** A fake page connection that records every frame the server sends to it. */
function fakePage() {
  const frames = [];
  return {
    frames,
    send(data) {
      frames.push(JSON.parse(data));
    },
  };
}

function askFrom(id, text) {
  return { type: 'ask', id, text, context: { kind: 'session' }, chip: 'Whole session', current: null };
}

/** A real Session behind a real web server on a free port, with one trusted fake page. */
async function startChannel(t) {
  const session = new Session();
  const web = await startWebServer({ session, port: 0 });
  t.after(() => web.close());
  session.setPageUrl(web.url);
  const page = fakePage();
  session.handlePageMessage(page, { type: 'page-auth', token: session.ask.pageToken });
  return { session, web, page };
}

test('listener: usage errors print exactly the usage line and exit 2', async (t) => {
  const cleanup = [];
  t.after(() => cleanup.forEach((fn) => fn()));

  // A port outside 1..65535 would make the WebSocket constructor throw a stack trace on stderr.
  for (const args of [[], ['5757'], ['not-a-port', 'token'], ['99999', 'token'], ['0', 'token'], ['65536', 'token']]) {
    const listener = spawnListener(args, cleanup);
    const { code } = await waitForExit(listener.child, 5000);
    assert.equal(code, 2, `arguments ${JSON.stringify(args)}`);
    assert.deepEqual(listener.lines(), [listenerUsageLine()], `arguments ${JSON.stringify(args)}`);
  }
});

test('listener: a wrong token prints one refusal line naming the status, never the token, and exits 1', async (t) => {
  const cleanup = [];
  t.after(() => cleanup.forEach((fn) => fn()));
  const { session, web } = await startChannel(t);

  let logged = '';
  const originalError = console.error;
  console.error = (...args) => {
    logged += `${args.join(' ')}\n`;
  };
  t.after(() => {
    console.error = originalError;
  });

  const wrongToken = newToken();
  assert.notEqual(wrongToken, session.ask.listenerToken);
  const listener = spawnListener([String(web.port), wrongToken], cleanup);
  const { code } = await waitForExit(listener.child, 5000);
  assert.equal(code, 1);
  const lines = listener.lines();
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes('refused'), lines[0]);
  assert.ok(lines[0].includes('401'), lines[0]);
  assert.ok(!listener.stdout.includes(wrongToken), 'the listener must never print its token');
  assert.ok(logged.includes('Refused a listener connection: missing or wrong listener token'), logged);
  assert.equal(session.ask.hasListener(), false);
});

test('listener: silent on connect, one line per request, each acknowledged, one line when the server ends', async (t) => {
  const cleanup = [];
  t.after(() => cleanup.forEach((fn) => fn()));
  const { session, web, page } = await startChannel(t);

  const listener = spawnListener([String(web.port), session.ask.listenerToken], cleanup);
  await waitUntil(() => session.ask.hasListener(), 'the listener to connect');
  await sleep(300);
  assert.equal(listener.stdout, '', 'the listener must print nothing when it connects');

  const plain = 'make the drums shorter';
  const multiline = 'make the hats quieter\nand shorter';
  session.handlePageMessage(page, askFrom('req-1', plain));
  await waitUntil(() => listener.lines().length === 1, 'the first request line');
  session.handlePageMessage(page, askFrom('req-2', multiline));
  await waitUntil(() => listener.lines().length === 2, 'the second request line');

  const [first, second] = listener.lines();
  assert.ok(first.startsWith(`${REQUEST_LINE_PREFIX} `), first);
  const firstJson = JSON.parse(first.slice(REQUEST_LINE_PREFIX.length + 1));
  assert.equal(firstJson.text, plain);
  assert.deepEqual(firstJson.context, { kind: 'session' });
  assert.equal(firstJson.chip, 'Whole session');
  assert.equal(firstJson.current, null);
  // A newline inside the text stays inside one line: the JSON gives the text back.
  const secondJson = JSON.parse(second.slice(REQUEST_LINE_PREFIX.length + 1));
  assert.equal(secondJson.text, multiline);

  // The ack arrived for each: the page is told received, and nothing stays in flight.
  await waitUntil(
    () => page.frames.filter((f) => f.type === 'ask-result' && f.status === 'received').length === 2,
    'both requests to be acknowledged',
  );
  assert.equal(session.ask.inFlightCount(), 0);
  assert.equal(session.ask.waitingCount(), 0);

  assert.ok(!listener.stdout.includes(session.ask.listenerToken), 'the listener must never print its token');

  await web.close();
  const { code } = await waitForExit(listener.child, 5000);
  assert.equal(code, 1);
  const lines = listener.lines();
  assert.equal(lines.length, 3, `expected exactly one more line, got ${JSON.stringify(lines)}`);
  assert.ok(lines[2].startsWith('Moontide listener ended'), lines[2]);
  assert.ok(!listener.stdout.includes(session.ask.listenerToken));
});

test('listener: a broken Monitor pipe means no ack, so the server keeps the request and never tells the page "received"', async (t) => {
  const cleanup = [];
  t.after(() => cleanup.forEach((fn) => fn()));
  const { session, web, page } = await startChannel(t);

  const listener = spawnListener([String(web.port), session.ask.listenerToken], cleanup);
  await waitUntil(() => session.ask.hasListener(), 'the listener to connect');
  // Claude's end of the pipe goes away: the listener's next stdout write fails.
  listener.child.stdout.destroy();
  await sleep(50);

  session.handlePageMessage(page, askFrom('broken-1', 'make the drums shorter'));
  await waitForExit(listener.child, 5000);
  await waitUntil(() => !session.ask.hasListener(), 'the server to notice the listener is gone');

  assert.equal(
    page.frames.filter((f) => f.type === 'ask-result' && f.status === 'received').length,
    0,
    'a line the pipe did not take must not be reported as received',
  );
  assert.equal(session.ask.waitingCount(), 1, 'the server keeps the request');
  assert.equal(session.ask.inFlightCount(), 0);
});

test('listener: a port with nothing listening prints one line and exits 1', async (t) => {
  const cleanup = [];
  t.after(() => cleanup.forEach((fn) => fn()));

  const holder = net.createServer();
  await new Promise((resolve) => holder.listen(0, '127.0.0.1', resolve));
  const freePort = holder.address().port;
  await new Promise((resolve) => holder.close(resolve));

  const token = newToken();
  const listener = spawnListener([String(freePort), token], cleanup);
  const { code } = await waitForExit(listener.child, 5000);
  assert.equal(code, 1);
  const lines = listener.lines();
  assert.equal(lines.length, 1);
  assert.ok(lines[0].startsWith('Moontide listener could not reach Moontide'), lines[0]);
  assert.ok(!listener.stdout.includes(token));
});

test(
  'listener: the arming command keeps a script path with a space as one argument (POSIX shell)',
  { skip: process.platform === 'win32' ? 'the Windows shell used by Monitor is a hand check' : false },
  async (t) => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'moontide quoting '));
    t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
    const stub = path.join(folder, 'stub.js');
    fs.writeFileSync(stub, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n');

    const token = newToken();
    const command = listenerCommand(stub, 5757, token);
    assert.notEqual(command, null);

    const child = spawn('sh', ['-c', command], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}` },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    const { code } = await waitForExit(child, 5000);
    assert.equal(code, 0, stderr);
    assert.deepEqual(JSON.parse(stdout), ['5757', token]);
  },
);
