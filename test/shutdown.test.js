import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnServer, waitForExit, isPortClosed, connectPage } from './helpers.js';

function killIfAlive(child) {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
  }
}

test('stdin end: exits 0 within 3s and frees the port', async (t) => {
  const { child, port } = await spawnServer();
  t.after(() => killIfAlive(child));

  child.stdin.end();
  const { code, signal } = await waitForExit(child, 3000);
  assert.equal(code, 0);
  assert.equal(signal, null);
  const closed = await isPortClosed(port);
  assert.ok(closed, 'expected the port to be free after shutdown');
});

// Moontide starts only on request, so a server nobody started has nothing to close.
test('stdin end before any start: exits 0 within 3s and never printed a page line', async (t) => {
  const server = await spawnServer({ start: false });
  t.after(() => killIfAlive(server.child));

  server.child.stdin.end();
  const { code, signal } = await waitForExit(server.child, 3000);
  assert.equal(code, 0);
  assert.equal(signal, null);
  assert.ok(!server.stderrText.includes('Moontide page:'), 'no page line was printed');
});

test('stdin end with a page connected: exits 0 and the page receives close', async (t) => {
  const { child, port } = await spawnServer();
  t.after(() => killIfAlive(child));

  const ws = await connectPage(port);
  t.after(() => ws.close());
  const closedPromise = new Promise((resolve) => ws.once('close', resolve));

  child.stdin.end();
  const { code } = await waitForExit(child, 3000);
  assert.equal(code, 0);
  await Promise.race([
    closedPromise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('page did not receive a close event')), 1000)),
  ]);
});

test('SIGTERM: exits 0 within 3s and frees the port', { skip: process.platform === 'win32' }, async (t) => {
  const { child, port } = await spawnServer();
  t.after(() => killIfAlive(child));

  child.kill('SIGTERM');
  const { code, signal } = await waitForExit(child, 3000);
  assert.equal(code, 0);
  assert.equal(signal, null);
  const closed = await isPortClosed(port);
  assert.ok(closed, 'expected the port to be free after shutdown');
});

// Needs port 5757 free, so it fails while another Moontide holds that port.
test('restart: a new server after a clean exit reuses the same default port', async (t) => {
  const first = await spawnServer();
  t.after(() => killIfAlive(first.child));
  first.child.stdin.end();
  await waitForExit(first.child, 3000);

  const second = await spawnServer();
  t.after(() => killIfAlive(second.child));
  assert.equal(second.port, first.port);
  second.child.stdin.end();
  await waitForExit(second.child, 3000);
});
