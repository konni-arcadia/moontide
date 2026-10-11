// Test helpers shared by test/*.test.js. Imports compiled output from ../dist, never src/.
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import WebSocket from 'ws';
import { PAGE_LINE_PREFIX } from '../dist/start.js';

export const DIST_ENTRY = fileURLToPath(new URL('../dist/index.js', import.meta.url));
export const PAGE_URL_PATTERN = /Moontide page: (http:\/\/localhost:(\d+))/;

/** Waits for the page line on stderr, which reaches the test through a pipe and can trail a tool reply. */
export function waitForUrl(getStderr, timeoutMs) {
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
        reject(
          new Error(`Timed out waiting for the Moontide page URL after ${timeoutMs}ms.\n--- stderr ---\n${text}`),
        );
        return;
      }
      setTimeout(check, 25);
    };
    check();
  });
}

/** A fresh temp directory per spawned server, so no test ever touches the real per-user history. */
function freshDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'moontide-test-'));
}

/**
 * A folder named `folderName` inside a new OS temp folder. Servers run there, so their session label
 * is made up (the label is local data and never written to a fixture).
 */
export function freshCwd(folderName = 'my-project') {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'moontide-cwd-'));
  const dir = path.join(parent, folderName);
  fs.mkdirSync(dir);
  return dir;
}

/**
 * Starts the server through a real MCP stdio client. Connects, then starts Moontide with the start
 * tool and waits for the page URL. With start: false nothing is started and url and port are null.
 */
export async function startMcpClient({ env, start = true, folderName = 'my-project' } = {}) {
  const dataDir = freshDataDir();
  const cwd = freshCwd(folderName);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [DIST_ENTRY],
    cwd,
    env: { ...process.env, MOONTIDE_NO_BROWSER: '1', MOONTIDE_DATA_DIR: dataDir, ...env },
    stderr: 'pipe',
  });

  let stderrText = '';
  transport.stderr?.on('data', (chunk) => {
    stderrText += chunk.toString();
  });

  const client = new Client({ name: 'moontide-test-client', version: '0.0.0' });
  let url = null;
  let port = null;
  try {
    await client.connect(transport);
    // Moontide starts only on the start tool or a music request, never with the process.
    if (start) {
      const reply = await client.callTool({ name: 'start', arguments: {} });
      if (reply.isError) {
        throw new Error(`The start tool failed: ${JSON.stringify(reply.content)}`);
      }
      ({ url, port } = await waitForUrl(() => stderrText, 10000));
    }
  } catch (error) {
    // A failed start must not leave the server child alive, holding a port and its pipes open.
    await client.close().catch(() => {});
    throw error;
  }

  return {
    client,
    transport,
    url,
    port,
    dataDir,
    cwd,
    get stderrText() {
      return stderrText;
    },
  };
}

/** Reads newline-terminated JSON messages from a child's stdout until the response with `id`. */
function waitForResponse(getStdout, id, getStderr, timeoutMs) {
  return new Promise((resolve, reject) => {
    const begin = Date.now();
    const check = () => {
      for (const line of getStdout().split('\n')) {
        if (line.trim() === '') continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id === id) {
          resolve(message);
          return;
        }
      }
      if (Date.now() - begin > timeoutMs) {
        reject(
          new Error(`Timed out waiting for response ${id} after ${timeoutMs}ms.\n--- stderr ---\n${getStderr()}`),
        );
        return;
      }
      setTimeout(check, 25);
    };
    check();
  });
}

/**
 * Spawns the server as a plain child process. With start true (the default) it speaks just enough
 * raw MCP over stdin to call the start tool, then waits for the page URL; stdin stays open (tests
 * end it to test shutdown). With start: false nothing is written and url and port are null.
 */
export async function spawnServer({ env, start = true, folderName = 'my-project' } = {}) {
  const dataDir = freshDataDir();
  const cwd = freshCwd(folderName);
  const child = spawn(process.execPath, [DIST_ENTRY], {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd,
    env: { ...process.env, MOONTIDE_NO_BROWSER: '1', MOONTIDE_DATA_DIR: dataDir, ...env },
  });

  let stderrText = '';
  child.stderr.on('data', (chunk) => {
    stderrText += chunk.toString();
  });
  let stdoutText = '';
  child.stdout.on('data', (chunk) => {
    stdoutText += chunk.toString();
  });

  let url = null;
  let port = null;
  // Moontide starts only on the start tool or a music request, never with the process.
  if (start) {
    try {
      const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
      send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'moontide-test-raw', version: '0.0.0' },
        },
      });
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'start', arguments: {} } });
      const reply = await waitForResponse(() => stdoutText, 2, () => stderrText, 10000);
      if (reply.error || reply.result?.isError) {
        throw new Error(`The start tool failed: ${JSON.stringify(reply.error ?? reply.result)}`);
      }
      ({ url, port } = await waitForUrl(() => stderrText, 10000));
    } catch (error) {
      // A failed start must not leave the server child alive, holding a port and its pipes open.
      child.kill();
      throw error;
    }
  }

  return {
    child,
    url,
    port,
    dataDir,
    cwd,
    get stderrText() {
      return stderrText;
    },
    get stdoutText() {
      return stdoutText;
    },
  };
}

/** Opens a WebSocket to the server's /ws endpoint, as a fake page would. */
export function connectPage(port, { origin } = {}) {
  const resolvedOrigin = origin ?? `http://localhost:${port}`;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { origin: resolvedOrigin } });
    // Buffer every incoming message from the moment the socket is constructed, not from
    // whenever a caller later attaches its own listener. The server sends `hello` right
    // after a successful page-auth; a reply can arrive combined with the HTTP upgrade
    // response or before the 'open' event's promise continuation gets a chance to run, so a
    // caller that waits for connectPage() to resolve and only then calls nextMessage() could
    // miss a frame entirely.
    ws.__moontideQueue = [];
    ws.__moontideWaiters = [];
    ws.on('message', (data) => {
      let parsed;
      try {
        parsed = JSON.parse(data.toString());
      } catch (err) {
        console.error('Test helper: received malformed message from page socket:', err);
        return;
      }
      const waiter = ws.__moontideWaiters.shift();
      if (waiter) {
        waiter(parsed);
      } else {
        ws.__moontideQueue.push(parsed);
      }
    });
    ws.once('open', () => resolve(ws));
    ws.once('error', (err) => reject(err));
    ws.once('unexpected-response', (_req, res) => {
      reject(new Error(`Unexpected response from WebSocket upgrade: ${res.statusCode}`));
    });
  });
}

/** The page token the server embeds in the page it serves (read at runtime, never written down). */
export async function fetchPageToken(port) {
  const res = await fetch(`http://127.0.0.1:${port}/`);
  const body = await res.text();
  const match = /<meta name="moontide-page-token" content="([0-9a-f]{64})">/.exec(body);
  if (!match) {
    throw new Error(`No page token in the page served on port ${port} (status ${res.status}); it starts: ${body.slice(0, 200)}`);
  }
  return match[1];
}

/**
 * Presents the current page token on a fresh page socket, the way the real page does on open:
 * page-auth, then ask-auth ok true, then hello. Returns the hello frame; throws on anything else.
 * The page-requests state follows hello (after the version frame, when there is one).
 */
export async function authenticatePage(ws, port) {
  const token = await fetchPageToken(port);
  ws.send(JSON.stringify({ type: 'page-auth', token }));
  const auth = await nextMessage(ws);
  if (auth.type !== 'ask-auth' || auth.ok !== true) {
    throw new Error(`Expected ask-auth ok true after page-auth, got: ${JSON.stringify(auth)}`);
  }
  const hello = await nextMessage(ws);
  if (hello.type !== 'hello') {
    throw new Error(`Expected hello after ask-auth, got: ${JSON.stringify(hello)}`);
  }
  return hello;
}

/**
 * Like authenticatePage, for a data folder that has an instruments.json: the server pushes one
 * midi-rig frame between ask-auth and hello. Returns { rig, hello } (rig is null when no frame came);
 * throws on anything else, like authenticatePage.
 */
export async function authenticatePageWithRig(ws, port) {
  const token = await fetchPageToken(port);
  ws.send(JSON.stringify({ type: 'page-auth', token }));
  const auth = await nextMessage(ws);
  if (auth.type !== 'ask-auth' || auth.ok !== true) {
    throw new Error(`Expected ask-auth ok true after page-auth, got: ${JSON.stringify(auth)}`);
  }
  let next = await nextMessage(ws);
  let rig = null;
  if (next.type === 'midi-rig') {
    rig = next;
    next = await nextMessage(ws);
  }
  if (next.type !== 'hello') {
    throw new Error(`Expected hello after ask-auth (and an optional midi-rig), got: ${JSON.stringify(next)}`);
  }
  return { rig, hello: next };
}

/** The start of the arming line a tool reply carries while a page is authenticated and no listener is connected. */
export const ARMING_LINE_PREFIX = 'Page requests: no listener is connected.';

/**
 * Removes the arming line from a tool reply text, so an exact-text assertion keeps its strength
 * while proving the line is there. Throws unless exactly one line starts with the arming prefix.
 * The blank separator before a trailing arming line goes with it.
 */
export function withoutArmingLine(text) {
  const lines = text.split('\n');
  const indexes = lines.flatMap((line, i) => (line.startsWith(ARMING_LINE_PREFIX) ? [i] : []));
  if (indexes.length !== 1) {
    throw new Error(`Expected exactly one arming line, found ${indexes.length} in: ${JSON.stringify(text)}`);
  }
  const at = indexes[0];
  lines.splice(at, 1);
  if (at === lines.length && at > 0 && lines[at - 1] === '') {
    lines.pop();
  }
  return lines.join('\n');
}

/** The start of the page line a get_code reply carries after the start (the line itself is built in src/start.ts). */
const PAGE_LINE_START = `${PAGE_LINE_PREFIX}http://localhost:`;

/**
 * Removes the page line from a get_code reply text, so an exact-text assertion keeps its strength while proving
 * the line is there. Throws unless exactly one line starts with the page line prefix. The blank separator before a
 * trailing page line goes with it.
 */
export function withoutPageLine(text) {
  const lines = text.split('\n');
  const indexes = lines.flatMap((line, i) => (line.startsWith(PAGE_LINE_START) ? [i] : []));
  if (indexes.length !== 1) {
    throw new Error(`Expected exactly one page line, found ${indexes.length} in: ${JSON.stringify(text)}`);
  }
  const at = indexes[0];
  lines.splice(at, 1);
  if (at === lines.length && at > 0 && lines[at - 1] === '') {
    lines.pop();
  }
  return lines.join('\n');
}

/** Parses the listener command out of a tool reply: `node '<script>' <port> <token>`. */
export function listenerCommandFrom(text) {
  const match = /node '([^']+)' (\d+) ([0-9a-f]{64})/.exec(text);
  if (!match) {
    throw new Error(`No listener command found in this text: ${text}`);
  }
  return { scriptPath: match[1], port: Number(match[2]), token: match[3] };
}

/**
 * Opens /listen the way the real listener does: only an Authorization header, no Origin. Buffers
 * frames from construction like connectPage. Rejects with the status on a refused upgrade.
 */
export function connectListener(port, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/listen`, { headers: { Authorization: `Bearer ${token}` } });
    ws.__moontideQueue = [];
    ws.__moontideWaiters = [];
    ws.on('message', (data) => {
      let parsed;
      try {
        parsed = JSON.parse(data.toString());
      } catch (err) {
        console.error('Test helper: received malformed message from listener socket:', err);
        return;
      }
      const waiter = ws.__moontideWaiters.shift();
      if (waiter) {
        waiter(parsed);
      } else {
        ws.__moontideQueue.push(parsed);
      }
    });
    ws.once('open', () => resolve(ws));
    ws.once('error', (err) => reject(err));
    ws.once('unexpected-response', (_req, res) => {
      reject(new Error(`Unexpected response from WebSocket upgrade: ${res.statusCode}`));
    });
  });
}

/** Resolves with the next parsed JSON message received on a WebSocket (queue-backed, race-free). */
export function nextMessage(ws) {
  if (ws.__moontideQueue.length > 0) {
    return Promise.resolve(ws.__moontideQueue.shift());
  }
  return new Promise((resolve) => {
    ws.__moontideWaiters.push(resolve);
  });
}

/**
 * Registers a persistent handler for every message that arrives after this call, draining
 * any already-queued messages first (in order). Use after the initial nextMessage() calls
 * that consume expected one-off messages (e.g. `hello`).
 */
export function onEveryMessage(ws, handler) {
  while (ws.__moontideQueue.length > 0) {
    handler(ws.__moontideQueue.shift());
  }
  ws.__moontideWaiters.push(function relay(msg) {
    handler(msg);
    ws.__moontideWaiters.push(relay);
  });
}

/** Resolves with { code, signal } once the child exits, or rejects if it doesn't within ms. */
export function waitForExit(child, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Process did not exit within ${ms}ms`));
    }, ms);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

/** Resolves true once a TCP connect to 127.0.0.1:port is refused (port is free). */
export function isPortClosed(port) {
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

/**
 * Wraps a fake-page WebSocket connection with a swappable evaluate responder and an
 * `send()` for unsolicited frames (runtime-error, etc.). A responder may return a single
 * message, an array of messages (sent in order), a promise of either, or a falsy value
 * (send nothing).
 */
export async function createFakePage(port, options = {}) {
  const ws = await connectPage(port, options);
  let hello;
  let rig = null;
  if (options.rig === true) {
    ({ rig, hello } = await authenticatePageWithRig(ws, port));
  } else {
    hello = await authenticatePage(ws, port);
  }
  // The initial responders are set before the queue drains, so an evaluate sent right after hello is answered.
  let responder = options.responder ?? null;
  let stopResponder = options.stopResponder ?? null;
  onEveryMessage(ws, async (msg) => {
    if (msg.type === 'evaluate' && responder) {
      const result = await responder(msg);
      if (!result) return;
      const messages = Array.isArray(result) ? result : [result];
      for (const m of messages) {
        ws.send(JSON.stringify(m));
      }
    } else if (msg.type === 'stop' && stopResponder) {
      const result = await stopResponder(msg);
      if (!result) return;
      const messages = Array.isArray(result) ? result : [result];
      for (const m of messages) {
        ws.send(JSON.stringify(m));
      }
    }
  });
  return {
    ws,
    hello,
    rig,
    setResponder(fn) {
      responder = fn;
    },
    setStopResponder(fn) {
      stopResponder = fn;
    },
    send(message) {
      ws.send(JSON.stringify(message));
    },
  };
}
