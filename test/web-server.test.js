import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startWebServer, isAllowedHost, HOST } from '../dist/web-server.js';
import { Session, noPageMessage } from '../dist/session.js';
import WebSocket from 'ws';
import { authenticatePage, connectListener, connectPage, fetchPageToken, nextMessage } from './helpers.js';

/** Occupies a port on HOST until closed, without accepting the WebSocket/HTTP protocol. */
function occupyPort(port) {
  return new Promise((resolve, reject) => {
    const blocker = net.createServer();
    blocker.on('error', reject);
    blocker.listen(port, HOST, () => resolve(blocker));
  });
}

/** Sends a raw, unnormalized request so the client does not clean up '..' or '%2e%2e' itself. */
function rawRequest(port, requestPath, method = 'GET', extraOptions = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: HOST, port, path: requestPath, method, ...extraOptions }, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('web-server: port fallback, origin allowlist, static-file guard and method checks', async (t) => {
  const toClose = [];
  t.after(async () => {
    for (const closeable of toClose) {
      await closeable();
    }
  });

  const blockedPort = 39217; // unlikely to collide with a real dev server; freed after this test.
  const blocker = await occupyPort(blockedPort);
  toClose.push(() => new Promise((resolve) => blocker.close(resolve)));

  const session = new Session();
  let stderrText = '';
  const originalError = console.error;
  console.error = (...args) => {
    stderrText += args.join(' ') + '\n';
    originalError(...args);
  };

  let web;
  try {
    web = await startWebServer({ session, port: blockedPort });
  } finally {
    console.error = originalError;
  }
  toClose.push(() => web.close());

  await t.test('resolves on a different port than the busy one, with a matching url', () => {
    assert.notEqual(web.port, blockedPort);
    assert.equal(web.url, `http://localhost:${web.port}`);
  });

  await t.test('stderr reports the busy port and the actual port', () => {
    assert.ok(
      stderrText.includes(`Port ${blockedPort} is busy, using port ${web.port} instead.`),
      `expected the busy-port line in stderr, got: ${stderrText}`,
    );
  });

  await t.test('the blocking server still accepts TCP connections afterwards', async () => {
    await new Promise((resolve, reject) => {
      const socket = net.connect({ host: HOST, port: blockedPort }, () => {
        socket.destroy();
        resolve();
      });
      socket.once('error', reject);
    });
  });

  await t.test('every URL check uses the actual bound port, never the requested one', async () => {
    session.setPageUrl(web.url);
    await assert.rejects(
      () => session.evaluate('s("bd")'),
      (err) => {
        assert.ok(err.message.includes(web.url));
        return true;
      },
    );
  });

  await t.test('WebSocket upgrade: correct-port origin accepted, busy-port origin and wrong path rejected', async () => {
    const okWs = new WebSocket(`ws://127.0.0.1:${web.port}/ws`, {
      headers: { origin: `http://localhost:${web.port}` },
    });
    await new Promise((resolve, reject) => {
      okWs.once('open', resolve);
      okWs.once('error', reject);
    });
    okWs.close();

    const badOriginWs = new WebSocket(`ws://127.0.0.1:${web.port}/ws`, {
      headers: { origin: `http://localhost:${blockedPort}` },
    });
    await assert.rejects(
      () =>
        new Promise((resolve, reject) => {
          badOriginWs.once('open', resolve);
          badOriginWs.once('unexpected-response', (_req, res) => reject(new Error(`status ${res.statusCode}`)));
          badOriginWs.once('error', reject);
        }),
      /403/,
    );

    const badPathWs = new WebSocket(`ws://127.0.0.1:${web.port}/other`, {
      headers: { origin: `http://localhost:${web.port}` },
    });
    await assert.rejects(
      () =>
        new Promise((resolve, reject) => {
          badPathWs.once('open', resolve);
          badPathWs.once('unexpected-response', (_req, res) => reject(new Error(`status ${res.statusCode}`)));
          badPathWs.once('error', reject);
        }),
      /403/,
    );
  });

  await t.test('raw traversal paths and missing files answer 404; index and static files behave', async () => {
    const dotdot = await rawRequest(web.port, '/../package.json');
    assert.equal(dotdot.status, 404);

    const encodedDotdot = await rawRequest(web.port, '/%2e%2e/package.json');
    assert.equal(encodedDotdot.status, 404);

    const index = await rawRequest(web.port, '/index.html');
    assert.equal(index.status, 200);

    const missingJs = await rawRequest(web.port, '/missing.js');
    assert.equal(missingJs.status, 404);

    const notesTxt = await rawRequest(web.port, '/notes.txt');
    assert.equal(notesTxt.status, 404);
  });

  await t.test('POST / is rejected with 405', async () => {
    const res = await rawRequest(web.port, '/', 'POST');
    assert.equal(res.status, 405);
  });
});

test('web-server: isAllowedHost accepts only the loopback names with the bound port', () => {
  const port = 5757;
  for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`, `LOCALHOST:${port}`]) {
    assert.equal(isAllowedHost(host, port), true, host);
  }
  for (const host of [
    undefined,
    '',
    'localhost',
    `localhost:${port + 1}`,
    `evil.example:${port}`,
    `localhost.:${port}`,
    `127.0.0.2:${port}`,
  ]) {
    assert.equal(isAllowedHost(host, port), false, String(host));
  }
});

test('web-server: a page request under another name is refused before the page and its token are read', async (t) => {
  const session = new Session();
  const originalError = console.error;
  console.error = () => {};
  t.after(() => {
    console.error = originalError;
  });
  const web = await startWebServer({ session, port: 0 });
  t.after(() => web.close());

  await t.test('GET / with Host evil.example answers 403 in plain text and never holds the page token', async () => {
    const res = await rawRequest(web.port, '/', 'GET', { headers: { host: `evil.example:${web.port}` } });
    assert.equal(res.status, 403);
    assert.equal(res.headers['content-type'], 'text/plain; charset=utf-8');
    assert.equal(res.body, 'Forbidden\n');
    assert.ok(!res.body.includes(session.ask.pageToken), 'a refused response must never hold the page token');
  });

  await t.test('GET / with Host 127.0.0.1 and the bound port is still served with the page token', async () => {
    const res = await rawRequest(web.port, '/', 'GET', { headers: { host: `127.0.0.1:${web.port}` } });
    assert.equal(res.status, 200);
    assert.ok(res.body.includes(session.ask.pageToken));
  });
});

test('web-server: an invalid port makes startWebServer reject with the real error', async () => {
  const session = new Session();
  await assert.rejects(() => startWebServer({ session, port: 70000 }));
});

/** Tries a WebSocket upgrade and answers 'open' or the HTTP status of the refusal. */
function upgradeStatus(port, requestPath, headers) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${requestPath}`, { headers });
    ws.once('open', () => {
      ws.close();
      resolve('open');
    });
    ws.once('unexpected-response', (_req, res) => resolve(res.statusCode));
    ws.once('error', reject);
  });
}

test('web-server: listener endpoint and page token', async (t) => {
  const session = new Session();
  const logged = [];
  const originalError = console.error;
  console.error = (...args) => {
    logged.push(args.join(' '));
  };
  t.after(() => {
    console.error = originalError;
  });
  const web = await startWebServer({ session, port: 0 });
  t.after(() => web.close());
  const logsWith = (needle) => logged.filter((line) => line.includes(needle));
  const goodOrigin = `http://localhost:${web.port}`;
  const listenerToken = session.ask.listenerToken;

  await t.test('/listen with the right bearer and an Origin header is refused 403 and logged', async () => {
    const status = await upgradeStatus(web.port, '/listen', {
      Authorization: `Bearer ${listenerToken}`,
      Origin: goodOrigin,
    });
    assert.equal(status, 403);
    assert.equal(logsWith('Refused a listener connection that carried an Origin header').length, 1);
    assert.equal(session.ask.hasListener(), false);
  });

  await t.test('/listen without Authorization, with an empty bearer or with a wrong token is refused 401 and logged once for the burst', async () => {
    const before = logsWith('Refused a listener connection: missing or wrong listener token').length;
    const wrongToken = listenerToken.split('').reverse().join('');
    assert.notEqual(wrongToken, listenerToken);
    assert.equal(await upgradeStatus(web.port, '/listen', {}), 401);
    assert.equal(await upgradeStatus(web.port, '/listen', { Authorization: 'Bearer ' }), 401);
    assert.equal(await upgradeStatus(web.port, '/listen', { Authorization: `Bearer ${wrongToken}` }), 401);
    const after = logsWith('Refused a listener connection: missing or wrong listener token');
    // Three refusals in a burst make one log line: a loop of bad attempts cannot flood stderr.
    assert.equal(after.length - before, 1);
    for (const line of after) {
      assert.ok(!line.includes(wrongToken), 'a refusal line must never repeat the given token');
    }
    assert.equal(session.ask.hasListener(), false);
  });

  await t.test('/listen with the right bearer and no Origin opens, and the listener is gone after close', async () => {
    const ws = await connectListener(web.port, listenerToken);
    assert.equal(session.ask.hasListener(), true);
    await new Promise((resolve) => {
      ws.once('close', resolve);
      ws.close();
    });
    for (let i = 0; i < 100 && session.ask.hasListener(); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(session.ask.hasListener(), false);
  });

  await t.test('a plain GET /listen answers 404', async () => {
    const res = await rawRequest(web.port, '/listen');
    assert.equal(res.status, 404);
  });

  await t.test('GET / carries the page token, no placeholder, and is never cached', async () => {
    const res = await rawRequest(web.port, '/');
    assert.equal(res.status, 200);
    const match = /<meta name="moontide-page-token" content="([^"]*)">/.exec(res.body);
    assert.ok(match, 'the served page must carry the page-token meta tag');
    assert.match(match[1], /^[0-9a-f]{64}$/);
    assert.equal(match[1], session.ask.pageToken);
    assert.ok(!res.body.includes('__MOONTIDE_PAGE_TOKEN__'), 'no placeholder may reach the browser');
    assert.equal(res.headers['cache-control'], 'no-store');
  });

  await t.test('HEAD / answers 200 with an empty body', async () => {
    const res = await rawRequest(web.port, '/', 'HEAD');
    assert.equal(res.status, 200);
    assert.equal(res.body, '');
  });

  await t.test('two sessions never share a page token or a listener token', () => {
    const other = new Session();
    const tokens = [session.ask.pageToken, session.ask.listenerToken, other.ask.pageToken, other.ask.listenerToken];
    assert.equal(new Set(tokens).size, 4);
  });

  await t.test('/ws from a foreign origin is refused 403; one log line per distinct origin', async () => {
    const first = 'http://first.example';
    assert.equal(await upgradeStatus(web.port, '/ws', { Origin: first }), 403);
    assert.equal(await upgradeStatus(web.port, '/ws', { Origin: first }), 403);
    assert.equal(logsWith(`from origin ${JSON.stringify(first)} (only this Moontide page may connect)`).length, 1);
    assert.equal(await upgradeStatus(web.port, '/ws', { Origin: 'http://second.example' }), 403);
    assert.equal(logsWith('Refused a WebSocket connection from origin').length, 2);
    assert.ok(logsWith('Refused a WebSocket connection from origin')[0].startsWith('[moontide] '));
  });

  await t.test('/ws with no Origin header is refused 403 and logged as origin none', async () => {
    assert.equal(await upgradeStatus(web.port, '/ws', {}), 403);
    assert.equal(logsWith('from origin "none"').length, 1);
  });

  await t.test('a page whose origin is the string null is refused 403 and logged as "null"', async () => {
    assert.equal(await upgradeStatus(web.port, '/ws', { Origin: 'null' }), 403);
    assert.equal(logsWith('from origin "null"').length, 1);
  });

  await t.test('a wrong path with an allowed origin stays a silent 403', async () => {
    const before = logsWith('Refused a WebSocket connection from origin').length;
    assert.equal(await upgradeStatus(web.port, '/other', { Origin: goodOrigin }), 403);
    assert.equal(logsWith('Refused a WebSocket connection from origin').length, before);
  });

  await t.test('after 20 distinct origins one closing line is logged, and no origin is logged after it', async () => {
    for (let i = 0; i < 25; i++) {
      assert.equal(await upgradeStatus(web.port, '/ws', { Origin: `http://flood-${i}.example` }), 403);
    }
    assert.equal(logsWith('Refused a WebSocket connection from origin').length, 20);
    assert.equal(logsWith('Refusing WebSocket connections from more origins; further ones are not logged').length, 1);
    assert.equal(logsWith('http://flood-24.example').length, 0);
  });

  await t.test('an overlong Origin header is cut to 100 characters in the log', async () => {
    // The log is already at its cap by now, so use a fresh server for this case.
    const other = new Session();
    const otherWeb = await startWebServer({ session: other, port: 0 });
    try {
      const long = `http://${'a'.repeat(300)}.example`;
      assert.equal(await upgradeStatus(otherWeb.port, '/ws', { Origin: long }), 403);
      const line = logsWith('Refused a WebSocket connection from origin').at(-1);
      assert.ok(line.includes(JSON.stringify(long.slice(0, 100))));
      assert.ok(!line.includes('a'.repeat(101)));
    } finally {
      await otherWeb.close();
    }
  });
});

test('web-server: every other form of the Host header, and both WebSocket paths, follow the same rule', async (t) => {
  const session = new Session();
  const logged = [];
  const originalError = console.error;
  console.error = (...args) => {
    logged.push(args.join(' '));
  };
  t.after(() => {
    console.error = originalError;
  });
  const web = await startWebServer({ session, port: 0 });
  t.after(() => web.close());
  const port = web.port;
  const goodOrigin = `http://localhost:${port}`;
  const evilHost = `evil.example:${port}`;

  await t.test('a /ws upgrade under another Host is refused 403 even with an allowed Origin', async () => {
    assert.equal(await upgradeStatus(port, '/ws', { Origin: goodOrigin, Host: evilHost }), 403);
  });

  await t.test('a /listen upgrade under another Host is refused 403 even with the right bearer, and no listener attaches', async () => {
    const status = await upgradeStatus(port, '/listen', {
      Authorization: `Bearer ${session.ask.listenerToken}`,
      Host: evilHost,
    });
    assert.equal(status, 403);
    assert.equal(session.ask.hasListener(), false);
  });

  await t.test('a /ws upgrade under Host localhost with the bound port still opens and authenticates', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { origin: goodOrigin, host: `localhost:${port}` } });
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
      ws.once('unexpected-response', (_req, res) => reject(new Error(`status ${res.statusCode}`)));
    });
    ws.close();
    assert.equal(await upgradeStatus(port, '/ws', { Origin: goodOrigin, Host: `[::1]:${port}` }), 'open');
  });

  await t.test('an upgrade with no Host header at all is refused 403', async () => {
    // The ws client always sends one, so send the bare upgrade request over a socket.
    const reply = await new Promise((resolve, reject) => {
      const socket = net.connect({ host: HOST, port }, () => {
        socket.write(
          `GET /ws HTTP/1.1\r\nOrigin: ${goodOrigin}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n` +
            `Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${Buffer.from('sixteen-byte-key').toString('base64')}\r\n\r\n`,
        );
      });
      // The first reply decides: a refusal, or the 101 of an upgrade that went through.
      socket.once('data', (chunk) => {
        resolve(chunk.toString('utf8'));
        socket.destroy();
      });
      socket.once('error', reject);
    });
    assert.ok(reply.startsWith('HTTP/1.1 403 Forbidden'), reply);
  });

  await t.test('five odd Host forms are refused with 403 and "Forbidden"', async () => {
    const forms = [
      { name: 'no Host header', options: { setHost: false } },
      { name: 'a Host without the port', options: { headers: { host: 'localhost' } } },
      { name: 'the right name with another port', options: { headers: { host: `localhost:${port + 1}` } } },
      { name: 'a trailing dot after the name', options: { headers: { host: `localhost.:${port}` } } },
      { name: 'another loopback address', options: { headers: { host: `127.0.0.2:${port}` } } },
    ];
    for (const form of forms) {
      const res = await rawRequest(port, '/', 'GET', form.options);
      assert.equal(res.status, 403, form.name);
      assert.equal(res.body, 'Forbidden\n', form.name);
      assert.ok(!res.body.includes(session.ask.pageToken), form.name);
    }
  });

  await t.test('[::1] and any letter case of the name are served', async () => {
    for (const host of [`[::1]:${port}`, `LOCALHOST:${port}`, `LocalHost:${port}`]) {
      const res = await rawRequest(port, '/', 'GET', { headers: { host } });
      assert.equal(res.status, 200, host);
    }
  });

  await t.test('the existing 400, 404 and 405 answers still come from an allowed Host', async () => {
    assert.equal((await rawRequest(port, '/%zz')).status, 400);
    assert.equal((await rawRequest(port, '/missing.js')).status, 404);
    assert.equal((await rawRequest(port, '/', 'POST')).status, 405);
  });

  await t.test('ten refused requests make one stderr line, and it never holds the refused header', async () => {
    // A fresh server, so no earlier refusal sits in the same log window.
    const other = new Session();
    const otherLogged = [];
    console.error = (...args) => {
      otherLogged.push(args.join(' '));
    };
    const otherWeb = await startWebServer({ session: other, port: 0 });
    try {
      for (let i = 0; i < 10; i++) {
        const res = await rawRequest(otherWeb.port, '/', 'GET', { headers: { host: `evil.example:${otherWeb.port}` } });
        assert.equal(res.status, 403);
      }
      const refusalLines = otherLogged.filter((line) => line.includes('Host header'));
      assert.equal(refusalLines.length, 1, otherLogged.join('\n'));
      assert.ok(!otherLogged.join('\n').includes('evil.example'), 'the refused Host value must never be logged');
      assert.ok(!otherLogged.join('\n').includes(other.ask.pageToken));
    } finally {
      await otherWeb.close();
    }
  });
});

test('web-server: every response forbids framing and sending a referrer, and nothing more', async (t) => {
  const session = new Session();
  const originalError = console.error;
  console.error = () => {};
  t.after(() => {
    console.error = originalError;
  });
  const web = await startWebServer({ session, port: 0 });
  t.after(() => web.close());
  const assertHeaders = (res, label) => {
    // Only frame-ancestors: a script-src rule would stop Strudel from evaluating code.
    assert.equal(res.headers['content-security-policy'], "frame-ancestors 'none'", label);
    assert.equal(res.headers['referrer-policy'], 'no-referrer', label);
  };

  await t.test('the page, a script and a stylesheet carry both headers and keep their cache and sniffing headers', async () => {
    for (const requestPath of ['/', '/main.js', '/style.css']) {
      const res = await rawRequest(web.port, requestPath);
      assert.equal(res.status, 200, requestPath);
      assertHeaders(res, requestPath);
      assert.equal(res.headers['cache-control'], 'no-store', requestPath);
      assert.equal(res.headers['x-content-type-options'], 'nosniff', requestPath);
    }
  });

  await t.test('a HEAD answer carries both headers too', async () => {
    assertHeaders(await rawRequest(web.port, '/', 'HEAD'), 'HEAD /');
  });

  await t.test('a 404, a 405, a 400 and a 403 carry both headers', async () => {
    const missing = await rawRequest(web.port, '/missing.js');
    assert.equal(missing.status, 404);
    assertHeaders(missing, '404');
    const post = await rawRequest(web.port, '/', 'POST');
    assert.equal(post.status, 405);
    assert.equal(post.headers.allow, 'GET, HEAD');
    assertHeaders(post, '405');
    const badEscape = await rawRequest(web.port, '/%zz');
    assert.equal(badEscape.status, 400);
    assertHeaders(badEscape, '400');
    const foreign = await rawRequest(web.port, '/', 'GET', { headers: { host: `evil.example:${web.port}` } });
    assert.equal(foreign.status, 403);
    assertHeaders(foreign, '403');
  });
});

test('web-server: a page sending invalid frames in a loop makes one stderr line for the burst', async (t) => {
  const session = new Session();
  const logged = [];
  const originalError = console.error;
  console.error = (...args) => {
    logged.push(args.join(' '));
  };
  t.after(() => {
    console.error = originalError;
  });
  const web = await startWebServer({ session, port: 0 });
  t.after(() => web.close());
  const ws = await connectPage(web.port);
  t.after(() => ws.terminate());

  // Three frames that are not JSON, then three asks that fail the schema (no text). The asks are
  // answered, so once the last answer is back the server has handled every earlier frame too.
  for (let i = 0; i < 3; i++) {
    ws.send('not json');
  }
  for (let i = 0; i < 3; i++) {
    ws.send(JSON.stringify({ type: 'ask', id: `bad-${i}` }));
  }
  let answers = 0;
  while (answers < 3) {
    const msg = await nextMessage(ws);
    if (msg.type === 'ask-result') {
      answers += 1;
    }
  }
  const invalidLines = logged.filter((line) => line.includes('Ignoring invalid page message'));
  assert.equal(invalidLines.length, 1, invalidLines.join('\n'));
});

// The page token gates the whole page connection: a socket that has not presented it gets no hello,
// cannot become the active page, and every other message it sends is ignored and logged.

const ASK_SENTINEL = { type: 'ask', id: 'sentinel', text: 'hi', context: { kind: 'session' }, chip: 'Whole session', current: null };

async function startGatedServer(t) {
  const session = new Session();
  const logged = [];
  const originalError = console.error;
  console.error = (...args) => {
    logged.push(args.join(' '));
  };
  t.after(() => {
    console.error = originalError;
  });
  const web = await startWebServer({ session, port: 0 });
  t.after(() => web.close());
  session.setPageUrl(web.url);
  return { session, web, logged };
}

test('page token: an unauthenticated connection gets no hello and never becomes the active page', async (t) => {
  const { session, web } = await startGatedServer(t);
  const ws = await connectPage(web.port);
  t.after(() => ws.terminate());
  ws.send(JSON.stringify(ASK_SENTINEL));
  // Frames on one socket are handled in order: the first frame back is the refusal, so no hello came first.
  const first = await nextMessage(ws);
  assert.deepEqual(first, { type: 'ask-result', id: 'sentinel', status: 'refused', reason: 'token' });
  await assert.rejects(() => session.evaluate('s("bd")'), { message: noPageMessage(web.url) });
});

test('page token: a wrong token is answered ask-auth false, stays unattached and is logged without the token', async (t) => {
  const { session, web, logged } = await startGatedServer(t);
  const ws = await connectPage(web.port);
  t.after(() => ws.terminate());
  const realToken = await fetchPageToken(web.port);
  const wrongToken = (realToken[0] === 'a' ? 'b' : 'a') + realToken.slice(1);
  ws.send(JSON.stringify({ type: 'page-auth', token: wrongToken }));
  ws.send(JSON.stringify(ASK_SENTINEL));
  assert.deepEqual(await nextMessage(ws), { type: 'ask-auth', ok: false });
  assert.deepEqual(await nextMessage(ws), { type: 'ask-result', id: 'sentinel', status: 'refused', reason: 'token' });
  await assert.rejects(() => session.evaluate('s("bd")'), { message: noPageMessage(web.url) });
  assert.ok(logged.some((line) => line.includes("Refused a page's token")), logged.join('\n'));
  assert.ok(!logged.some((line) => line.includes(wrongToken)), 'the wrong token must never be logged');
});

test('page token: the current token gives ask-auth ok, then hello, and the page becomes the active page', async (t) => {
  const { session, web } = await startGatedServer(t);
  const ws = await connectPage(web.port);
  t.after(() => ws.terminate());
  const token = await fetchPageToken(web.port);
  ws.send(JSON.stringify({ type: 'page-auth', token }));
  assert.deepEqual(await nextMessage(ws), { type: 'ask-auth', ok: true });
  assert.deepEqual(await nextMessage(ws), { type: 'hello', code: '', stopped: false });
  assert.deepEqual(await nextMessage(ws), { type: 'page-requests', live: false });
  const evaluating = session.evaluate('s("bd")');
  const frame = await nextMessage(ws);
  assert.equal(frame.type, 'evaluate');
  assert.equal(frame.code, 's("bd")');
  ws.send(JSON.stringify({ type: 'evaluated', id: frame.id, ok: true, code: 's("bd")', audio: 'playing' }));
  await evaluating;
});

test('page token: every other message type from an unauthenticated connection is ignored and logged', async (t) => {
  const { session, web, logged } = await startGatedServer(t);
  const ws = await connectPage(web.port);
  t.after(() => ws.terminate());
  const marker = 'FORGED_MARKER';
  const frames = [
    { type: 'evaluated', id: 'x', ok: true, code: marker, audio: 'playing' },
    { type: 'runtime-error', message: marker },
    { type: 'stop-result', id: 'x' },
    { type: 'user-stopped' },
    { type: 'hand-eval', ok: true, code: `s("bd") // ${marker}` },
    { type: 'reconnect-eval-failed', error: marker },
    { type: 'part-launch', code: `s("bd") // ${marker}`, part: 'A' },
    { type: 'mixer-live', code: `s("bd") // ${marker}` },
    { type: 'mixer-record', code: `s("bd") // ${marker}`, label: 'x' },
    { type: 'history-request' },
    { type: 'data-folder-request' },
    { type: 'history-restore', id: 1 },
    { type: 'history-more', before: 5 },
  ];
  for (const frame of frames) {
    ws.send(JSON.stringify(frame));
  }
  ws.send(JSON.stringify(ASK_SENTINEL));
  const received = [await nextMessage(ws)];
  assert.deepEqual(received, [{ type: 'ask-result', id: 'sentinel', status: 'refused', reason: 'token' }]);
  assert.equal(session.getCode(), '');
  assert.equal(session.isStopped(), false);
  assert.equal(session.wasEditedByHand(), false);
  assert.deepEqual(session.drainNotices().lines, []);
  for (const frame of frames) {
    const matching = logged.filter(
      (line) => line.includes(`(${frame.type})`) && line.includes('did not present the page token'),
    );
    assert.equal(matching.length, 1, `${frame.type}: ${logged.join('\n')}`);
  }
  assert.ok(!logged.some((line) => line.includes(marker)), 'the content must never be logged');
});

/** Starts a web server on a free port with console.error captured; returns the server and the captured lines. */
async function startLabelled(t, options) {
  const logged = [];
  const originalError = console.error;
  console.error = (...args) => {
    logged.push(args.join(' '));
  };
  t.after(() => {
    console.error = originalError;
  });
  const web = await startWebServer({ session: new Session(), port: 0, ...options });
  t.after(() => web.close());
  return { web, logged };
}

const labelMetaTags = (body) => body.match(/<meta name="moontide-session-label" content="[^"]*">/g) ?? [];

test('web-server: the served page names its session in a meta tag and the title, before any script', async (t) => {
  const { web } = await startLabelled(t, { folder: 'my-project' });
  assert.equal(web.label, `my-project \u00b7 ${web.port}`);

  const body = (await rawRequest(web.port, '/', 'GET', { headers: { host: `localhost:${web.port}` } })).body;
  assert.deepEqual(labelMetaTags(body), [`<meta name="moontide-session-label" content="my-project \u00b7 ${web.port}">`]);
  const title = `<title>Moontide \u00b7 my-project \u00b7 ${web.port}</title>`;
  assert.equal(body.split(title).length, 2, 'exactly one personalised title');
  assert.ok(body.indexOf(title) < body.indexOf('<script'), 'the title comes before the first script');
  assert.ok(!body.includes('__MOONTIDE_SESSION_LABEL__'));
  assert.ok(!body.includes('<title>Moontide</title>'));
});

test('web-server: an unusable folder gives the port alone in the served page', async (t) => {
  const { web } = await startLabelled(t, { folder: '' });
  assert.equal(web.label, String(web.port));
  const body = (await rawRequest(web.port, '/', 'GET', { headers: { host: `localhost:${web.port}` } })).body;
  assert.deepEqual(labelMetaTags(body), [`<meta name="moontide-session-label" content="${web.port}">`]);
  assert.ok(body.includes(`<title>Moontide \u00b7 ${web.port}</title>`));
});

test('web-server: a hostile folder name is escaped and adds no element', async (t) => {
  const { web } = await startLabelled(t, { folder: 'a"><b>x' });
  const body = (await rawRequest(web.port, '/', 'GET', { headers: { host: `localhost:${web.port}` } })).body;
  assert.ok(body.includes('a&quot;&gt;&lt;b&gt;x'), 'the escaped name is in the page');
  assert.ok(!body.includes('"><b>'), 'the raw markup sequence appears nowhere');
  assert.equal(labelMetaTags(body).length, 1);
});

test('web-server: a dollar sign in the folder name is not a replacement pattern', async (t) => {
  const { web } = await startLabelled(t, { folder: "$&$'x" });
  const body = (await rawRequest(web.port, '/', 'GET', { headers: { host: `localhost:${web.port}` } })).body;
  assert.equal(labelMetaTags(body).length, 1);
  assert.ok(body.includes('$&amp;$&#39;x'), 'the name is written literally, escaped');
});

test('web-server: after the port fallback the label and the served page carry the port actually bound', async (t) => {
  const blockedPort = 39218;
  const blocker = await occupyPort(blockedPort);
  t.after(() => new Promise((resolve) => blocker.close(resolve)));
  const { web } = await startLabelled(t, { folder: 'my-project', port: blockedPort });
  assert.notEqual(web.port, blockedPort);
  assert.equal(web.label, `my-project \u00b7 ${web.port}`);
  const body = (await rawRequest(web.port, '/', 'GET', { headers: { host: `localhost:${web.port}` } })).body;
  assert.deepEqual(labelMetaTags(body), [`<meta name="moontide-session-label" content="my-project \u00b7 ${web.port}">`]);
});

test('web-server: an index.html without a placeholder is a loud 500, never a half-filled page', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moontide-page-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const real = fs.readFileSync(new URL('../page/index.html', import.meta.url), 'utf8');
  fs.writeFileSync(path.join(dir, 'index.html'), real.replace(/<meta name="moontide-session-label"[^>]*>\n?/, ''));
  const { web, logged } = await startLabelled(t, { folder: 'my-project', pageDir: dir });
  const res = await rawRequest(web.port, '/', 'GET', { headers: { host: `localhost:${web.port}` } });
  assert.equal(res.status, 500);
  const lines = logged.filter((line) => line.includes('session-label placeholder'));
  assert.equal(lines.length, 1);
  assert.ok(!res.body.includes('page-token'), 'nothing of the page is sent');
});

test('web-server: an index.html with a different title is a loud 500', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moontide-page-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const real = fs.readFileSync(new URL('../page/index.html', import.meta.url), 'utf8');
  fs.writeFileSync(path.join(dir, 'index.html'), real.replace('<title>Moontide</title>', '<title>Other</title>'));
  const { web, logged } = await startLabelled(t, { folder: 'my-project', pageDir: dir });
  const res = await rawRequest(web.port, '/', 'GET', { headers: { host: `localhost:${web.port}` } });
  assert.equal(res.status, 500);
  assert.equal(logged.filter((line) => line.includes('static title')).length, 1);
});

test('web-server: the label never reaches stderr', async (t) => {
  const { web, logged } = await startLabelled(t, { folder: 'secret-folder-name' });
  await rawRequest(web.port, '/', 'GET', { headers: { host: `localhost:${web.port}` } });
  assert.ok(!logged.some((line) => line.includes('secret-folder-name')));
});
