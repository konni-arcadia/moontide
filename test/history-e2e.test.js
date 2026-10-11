import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMcpClient, createFakePage, withoutArmingLine } from './helpers.js';

test('history: a labeled set_code lands in history.jsonl, list_history shows it, and a new server on the same dir continues it', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moontide-history-test-'));
  t.after(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const { client, port } = await startMcpClient({ env: { MOONTIDE_DATA_DIR: dataDir } });
  const page = await createFakePage(port);
  page.setResponder((msg) => ({ type: 'evaluated', id: msg.id, ok: true, code: msg.code, audio: 'playing' }));

  const setResult = await client.callTool({
    name: 'set_code',
    arguments: { code: 's("bd sd")', label: 'added a bass' },
  });
  assert.ok(!setResult.isError);
  assert.ok(setResult.content[0].text.startsWith('ok, playing'));

  const listResult = await client.callTool({ name: 'list_history', arguments: {} });
  // An authenticated page with no listener arms every tool reply with one extra line.
  const lines = withoutArmingLine(listResult.content[0].text).split('\n');
  assert.match(lines[0], /^#1 — \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z — claude — "added a bass" — s\("bd sd"\)$/);
  assert.ok(lines.at(-1).endsWith(' — session started'));

  const historyPath = path.join(dataDir, 'history.jsonl');
  const fileLines = fs
    .readFileSync(historyPath, 'utf8')
    .trim()
    .split('\n');
  assert.equal(fileLines.length, 2);
  const sessionEntry = JSON.parse(fileLines[0]);
  assert.equal(sessionEntry.type, 'session-start');
  const versionEntry = JSON.parse(fileLines[1]);
  assert.equal(versionEntry.type, 'version');
  assert.equal(versionEntry.id, 1);
  assert.equal(versionEntry.origin, 'claude');
  assert.equal(versionEntry.label, 'added a bass');
  assert.equal(versionEntry.code, 's("bd sd")');

  page.ws.close();
  await client.close();

  // A new server on the same data directory: history and ids continue.
  const second = await startMcpClient({ env: { MOONTIDE_DATA_DIR: dataDir } });
  const listAfterRestart = await second.client.callTool({ name: 'list_history', arguments: {} });
  assert.ok(listAfterRestart.content[0].text.split('\n')[0].startsWith('#1'));

  const page2 = await createFakePage(second.port);
  page2.setResponder((msg) => ({ type: 'evaluated', id: msg.id, ok: true, code: msg.code, audio: 'playing' }));
  const setResult2 = await second.client.callTool({ name: 'set_code', arguments: { code: 's("hh*4")' } });
  assert.ok(!setResult2.isError);

  const listResult2 = await second.client.callTool({ name: 'list_history', arguments: {} });
  const lines2 = listResult2.content[0].text.split('\n');
  assert.match(lines2[0], /^#2 — .+ — claude — s\("hh\*4"\)$/);

  const fileLines2 = fs
    .readFileSync(historyPath, 'utf8')
    .trim()
    .split('\n');
  assert.equal(fileLines2.length, 4);
  assert.equal(JSON.parse(fileLines2[2]).type, 'session-start');
  assert.equal(JSON.parse(fileLines2[3]).id, 2);

  page2.ws.close();
  await second.client.close();
});

test('history: list_history on a fresh empty data dir returns "No versions recorded yet."', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moontide-history-test-'));
  t.after(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const { client } = await startMcpClient({ env: { MOONTIDE_DATA_DIR: dataDir } });
  const result = await client.callTool({ name: 'list_history', arguments: {} });
  assert.equal(result.content[0].text, 'No versions recorded yet.');
  await client.close();
});

test('history: a pre-seeded garbage line is reported once, list_history still shows the valid versions, and the garbage line survives untouched', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moontide-history-test-'));
  t.after(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const historyPath = path.join(dataDir, 'history.jsonl');
  const good = JSON.stringify({ type: 'version', id: 1, at: '2026-01-01T00:00:00Z', origin: 'claude', code: 'A' });
  const garbage = 'not json at all {{{';
  const seeded = good + '\n' + garbage + '\n';
  fs.writeFileSync(historyPath, seeded);

  const { client, port } = await startMcpClient({ env: { MOONTIDE_DATA_DIR: dataDir } });

  const first = await client.callTool({ name: 'get_code', arguments: {} });
  assert.ok(first.content[0].text.includes('Note: 1 unreadable line(s) in the history file were skipped (line 2)'));

  const second = await client.callTool({ name: 'get_code', arguments: {} });
  assert.ok(!second.content[0].text.includes('unreadable line'));

  const listResult = await client.callTool({ name: 'list_history', arguments: {} });
  assert.ok(listResult.content[0].text.includes('#1'));

  const page = await createFakePage(port);
  page.setResponder((msg) => ({ type: 'evaluated', id: msg.id, ok: true, code: msg.code, audio: 'playing' }));
  await client.callTool({ name: 'set_code', arguments: { code: 's("bd")' } });

  const finalContent = fs.readFileSync(historyPath, 'utf8');
  assert.ok(finalContent.includes(garbage), 'the garbage line must still be present, untouched, byte for byte');

  page.ws.close();
  await client.close();
});

test('history: an unreadable history file (a directory named history.jsonl) never blocks set_code/get_code, but list_history is a tool error until it is removed', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moontide-history-test-'));
  t.after(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(dataDir, 'history.jsonl'));

  const { client, port } = await startMcpClient({ env: { MOONTIDE_DATA_DIR: dataDir } });
  const page = await createFakePage(port);
  page.setResponder((msg) => ({ type: 'evaluated', id: msg.id, ok: true, code: msg.code, audio: 'playing' }));

  const setResult = await client.callTool({ name: 'set_code', arguments: { code: 's("bd")' } });
  assert.ok(!setResult.isError);
  assert.ok(setResult.content[0].text.startsWith('ok, playing'));
  assert.ok(setResult.content[0].text.includes('Note: this version could not be saved to history ('));

  const getResult = await client.callTool({ name: 'get_code', arguments: {} });
  assert.ok(!getResult.isError);
  assert.ok(getResult.content[0].text.startsWith('s("bd")'));

  const listResult = await client.callTool({ name: 'list_history', arguments: {} });
  assert.ok(listResult.isError);
  assert.ok(listResult.content[0].text.startsWith('History is unavailable right now ('));

  fs.rmSync(path.join(dataDir, 'history.jsonl'), { recursive: true, force: true });
  const listAfterFix = await client.callTool({ name: 'list_history', arguments: {} });
  assert.equal(withoutArmingLine(listAfterFix.content[0].text), 'No versions recorded yet.');

  page.ws.close();
  await client.close();
});

// Restore_version plays a past version again through set_code's exact path.

test('restore_version: plays a past version again, appends a "restored from #N" entry, and reuses set_code guarantees verbatim', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moontide-history-test-'));
  t.after(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const { client, port, url } = await startMcpClient({ env: { MOONTIDE_DATA_DIR: dataDir } });
  const page = await createFakePage(port);
  // An early assertion failure must still close the page socket and the MCP client (which
  // owns a real spawned server process) — otherwise it stays running and the whole suite
  // (test-isolation=process, concurrency 1) never moves past this file.
  t.after(async () => {
    try {
      page.ws.close();
    } catch {
      // already closed
    }
    await client.close();
  });
  page.setResponder((msg) => ({ type: 'evaluated', id: msg.id, ok: true, code: msg.code, audio: 'playing' }));

  await client.callTool({ name: 'set_code', arguments: { code: 's("bd")', label: 'drums' } });
  await client.callTool({ name: 'set_code', arguments: { code: 's("hh")' } });

  const historyPath = path.join(dataDir, 'history.jsonl');
  const beforeRestore = fs.readFileSync(historyPath, 'utf8');

  const restore1 = await client.callTool({ name: 'restore_version', arguments: { id: 1 } });
  assert.ok(!restore1.isError);
  assert.match(restore1.content[0].text, /^Restored #1 as #3 — now playing\.\n\ns\("bd"\)/);

  const getResult = await client.callTool({ name: 'get_code', arguments: {} });
  assert.ok(getResult.content[0].text.startsWith('s("bd")'));

  const listResult = await client.callTool({ name: 'list_history', arguments: {} });
  const firstRow = listResult.content[0].text.split('\n')[0];
  assert.match(firstRow, /^#3 — .+ — claude — "restored from #1" — s\("bd"\)$/);

  const afterRestore = fs.readFileSync(historyPath, 'utf8');
  assert.ok(afterRestore.startsWith(beforeRestore), 'the earlier lines must be byte-identical after a restore (no rewrite, no reorder)');
  const lastLine = afterRestore.trim().split('\n').at(-1);
  const restoredEntry = JSON.parse(lastLine);
  assert.equal(restoredEntry.type, 'version');
  assert.equal(restoredEntry.id, 3);
  assert.equal(restoredEntry.restoredFrom, 1);
  assert.equal(restoredEntry.label, 'restored from #1');
  assert.equal(restoredEntry.origin, 'claude');
  assert.equal(restoredEntry.code, 's("bd")');

  // Restoring the version that is already playing still appends a new entry.
  const restore2 = await client.callTool({ name: 'restore_version', arguments: { id: 3 } });
  assert.ok(!restore2.isError);
  assert.match(restore2.content[0].text, /^Restored #3 as #4 — now playing\./);

  // Unknown id: fails before anything is sent to the page.
  let evaluateFramesSeen = 0;
  page.setResponder((msg) => {
    evaluateFramesSeen++;
    return { type: 'evaluated', id: msg.id, ok: true, code: msg.code, audio: 'playing' };
  });
  const restoreUnknown = await client.callTool({ name: 'restore_version', arguments: { id: 99 } });
  assert.ok(restoreUnknown.isError);
  assert.equal(withoutArmingLine(restoreUnknown.content[0].text), 'No version #99 in history.');
  assert.equal(evaluateFramesSeen, 0, 'an unknown id must never reach the page');

  // Evaluation failure reuses set_code's exact string; nothing new is recorded.
  page.setResponder((msg) => ({ type: 'evaluated', id: msg.id, ok: false, code: msg.code, error: 'boom' }));
  const restoreFail = await client.callTool({ name: 'restore_version', arguments: { id: 1 } });
  assert.ok(restoreFail.isError);
  assert.match(restoreFail.content[0].text, /^Evaluation failed: boom\. The previous code is still playing\./);
  const listAfterFail = await client.callTool({ name: 'list_history', arguments: {} });
  assert.ok(listAfterFail.content[0].text.split('\n')[0].startsWith('#4'), 'a failed restore must not add a new entry');

  // Waiting for the click.
  page.setResponder((msg) => ({ type: 'evaluated', id: msg.id, ok: true, code: msg.code, audio: 'waiting-for-click' }));
  const restoreWaiting = await client.callTool({ name: 'restore_version', arguments: { id: 1 } });
  assert.ok(!restoreWaiting.isError);
  assert.match(restoreWaiting.content[0].text, /^Restored #1 as #5\. Waiting for the user's click:/);

  // No page connected — intentionally closed here (not in t.after) since the assertion below
  // depends on the page already being gone.
  page.ws.close();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const restoreNoPage = await client.callTool({ name: 'restore_version', arguments: { id: 1 } });
  assert.ok(restoreNoPage.isError);
  assert.equal(restoreNoPage.content[0].text, `No page connected — open ${url} and click to start sound.`);
});

// Restore_version gets the same getTime() warn note as set_code.

test('restore_version: a restored version that reads getTime() ends with the getTime note; one that does not, does not', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moontide-history-test-'));
  t.after(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const { client, port } = await startMcpClient({ env: { MOONTIDE_DATA_DIR: dataDir } });
  const page = await createFakePage(port);
  t.after(async () => {
    try {
      page.ws.close();
    } catch {
      // already closed
    }
    await client.close();
  });
  page.setResponder((msg) => ({ type: 'evaluated', id: msg.id, ok: true, code: msg.code, audio: 'playing' }));

  const NOTE_TEXT =
    'Note: this code reads getTime(); an anchor taken from it restarts every time a later change re-sends this code, ' +
    'while a transition anchored with .timeline(id) keeps running across changes (see the transitions topic).';

  const getTimeCode =
    'const start = getTime()\ns("bd*4").lpf(signal((t) => Math.max(0, Math.min(1, t - start))).range(400, 2000))';
  await client.callTool({ name: 'set_code', arguments: { code: getTimeCode } }); // version #1
  await client.callTool({ name: 'set_code', arguments: { code: 's("hh")' } }); // version #2

  const restore1 = await client.callTool({ name: 'restore_version', arguments: { id: 1 } });
  assert.ok(!restore1.isError);
  assert.ok(restore1.content[0].text.startsWith('Restored #1 as #3'));
  const lines1 = restore1.content[0].text.split('\n');
  assert.equal(lines1.at(-1), NOTE_TEXT);

  const restore2 = await client.callTool({ name: 'restore_version', arguments: { id: 2 } });
  assert.ok(!restore2.isError);
  assert.ok(!restore2.content[0].text.includes('re-sends this code'));
});

// Restore_version gets the same t/f flag note as set_code.

test('restore_version: a restored version with a t/f .mask() ends with the flag note; one without, does not', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moontide-history-test-'));
  t.after(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const { client, port } = await startMcpClient({ env: { MOONTIDE_DATA_DIR: dataDir } });
  const page = await createFakePage(port);
  t.after(async () => {
    try {
      page.ws.close();
    } catch {
      // already closed
    }
    await client.close();
  });
  page.setResponder((msg) => ({ type: 'evaluated', id: msg.id, ok: true, code: msg.code, audio: 'playing' }));

  const FLAG_NOTE_TEXT =
    'Note: this code gives .when(), .struct() or .mask() a mini-notation string of t and f. ' +
    'In mini-notation t and f are plain strings (f is also a note name), so every one of those steps counts as true: ' +
    'write 1 and 0, and struct and mask also take ~ as a silent step (see the functions topic).';

  await client.callTool({ name: 'set_code', arguments: { code: 's("bd*4").mask("t f t t")' } }); // version #1
  await client.callTool({ name: 'set_code', arguments: { code: 's("hh")' } }); // version #2

  const restore1 = await client.callTool({ name: 'restore_version', arguments: { id: 1 } });
  assert.ok(!restore1.isError);
  assert.ok(restore1.content[0].text.startsWith('Restored #1 as #3'));
  assert.equal(restore1.content[0].text.split('\n').at(-1), FLAG_NOTE_TEXT);

  const restore2 = await client.callTool({ name: 'restore_version', arguments: { id: 2 } });
  assert.ok(!restore2.isError);
  assert.ok(!restore2.content[0].text.includes('mini-notation string of t and f'));
});

// Favorite_version, list_history's filter/favorites, and the six-tool list.

test('favorite_version and list_history filter/favorites: naming, renaming, filtering by word, and the exact tool list', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moontide-history-test-'));
  t.after(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const { client, port } = await startMcpClient({ env: { MOONTIDE_DATA_DIR: dataDir } });
  const page = await createFakePage(port);
  // Same reasoning as the restore_version test above: registered before any assertion so a
  // mid-test failure still tears down the spawned server and socket.
  t.after(async () => {
    try {
      page.ws.close();
    } catch {
      // already closed
    }
    await client.close();
  });
  page.setResponder((msg) => ({ type: 'evaluated', id: msg.id, ok: true, code: msg.code, audio: 'playing' }));

  await client.callTool({ name: 'set_code', arguments: { code: 's("bd")', label: 'drums' } });

  const saved = await client.callTool({ name: 'favorite_version', arguments: { id: 1, name: 'Dreamy' } });
  assert.ok(!saved.isError);
  assert.equal(withoutArmingLine(saved.content[0].text), 'Saved #1 as favorite "Dreamy".');

  const renamed = await client.callTool({ name: 'favorite_version', arguments: { id: 1, name: 'Dorian sketch' } });
  assert.ok(!renamed.isError);
  assert.equal(withoutArmingLine(renamed.content[0].text), 'Renamed favorite #1 to "Dorian sketch".');

  const unknown = await client.callTool({ name: 'favorite_version', arguments: { id: 99, name: 'x' } });
  assert.ok(unknown.isError);
  assert.equal(withoutArmingLine(unknown.content[0].text), 'No version #99 in history.');

  const favoritesList = await client.callTool({ name: 'list_history', arguments: { favorites: true } });
  assert.ok(favoritesList.content[0].text.includes(' — favorite "Dorian sketch"'));

  await client.callTool({ name: 'set_code', arguments: { code: 'note("c d").s("marimba")' } });
  const filtered = await client.callTool({ name: 'list_history', arguments: { filter: 'marimba' } });
  const filteredRows = withoutArmingLine(filtered.content[0].text).split('\n');
  assert.equal(filteredRows.length, 1);
  assert.ok(filteredRows[0].includes('marimba'));

  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name).sort();
  // Fourteen tools, including start, set_page_requests, get_strudel_reference, get_midi_instruments, save_midi_model, search_midi_sounds, save_midi_catalog and edit_code.
  assert.deepEqual(names, [
    'edit_code',
    'favorite_version',
    'get_code',
    'get_midi_instruments',
    'get_strudel_reference',
    'list_history',
    'restore_version',
    'save_midi_catalog',
    'save_midi_model',
    'search_midi_sounds',
    'set_code',
    'set_page_requests',
    'start',
    'stop',
  ]);
});

// A change that pushes the history past the 1000-version cap drops the
// oldest non-favorite versions in one rewrite, and Claude reads the note in the same response.

test('a change that pushes the history past 1000 versions drops the oldest non-favorite versions from the file, and Claude is told in that same response', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moontide-history-test-'));
  t.after(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const historyPath = path.join(dataDir, 'history.jsonl');
  const seededLines = [JSON.stringify({ type: 'session-start', at: '2026-01-01T00:00:00Z' })];
  for (let i = 1; i <= 1100; i++) {
    seededLines.push(
      JSON.stringify({ type: 'version', id: i, at: '2026-01-01T00:00:00Z', origin: 'claude', code: `s("bd*${i}")` }),
    );
  }
  seededLines.push(JSON.stringify({ type: 'favorite', id: 5, name: 'old favorite', at: '2026-01-01T00:00:00Z' }));
  fs.writeFileSync(historyPath, seededLines.join('\n') + '\n');

  const { client, port } = await startMcpClient({ env: { MOONTIDE_DATA_DIR: dataDir } });
  const page = await createFakePage(port);
  t.after(async () => {
    try {
      page.ws.close();
    } catch {
      // already closed
    }
    await client.close();
  });
  page.setResponder((msg) => ({ type: 'evaluated', id: msg.id, ok: true, code: msg.code, audio: 'playing' }));

  const setResult = await client.callTool({ name: 'set_code', arguments: { code: 's("new")' } });
  assert.ok(!setResult.isError);
  assert.ok(setResult.content[0].text.startsWith('ok, playing'));
  assert.ok(
    setResult.content[0].text.includes(
      'Note: 100 version(s) older than #102 were dropped (favorites are never dropped) to stay within the 1000-version history limit.',
    ),
  );

  const fileEntries = fs
    .readFileSync(historyPath, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  const versionIds = fileEntries.filter((e) => e.type === 'version').map((e) => e.id);
  const expectedIds = [5, ...Array.from({ length: 1000 }, (_, i) => 102 + i)];
  assert.deepEqual(versionIds, expectedIds);
  assert.ok(fileEntries.some((e) => e.type === 'favorite' && e.id === 5), 'the favorite line must survive the trim');
  assert.ok(fileEntries.some((e) => e.type === 'session-start'), 'a session-start line must survive the trim');
  assert.ok(!fs.existsSync(historyPath + '.tmp'), 'no leftover temp file after the trim');

  const listResult = await client.callTool({ name: 'list_history', arguments: { limit: 2000 } });
  const versionRows = listResult.content[0].text.split('\n').filter((r) => r.startsWith('#'));
  assert.match(versionRows.at(-1), /^#5 — .+ — favorite "old favorite" — s\("bd\*5"\)$/);

  const restoreResult = await client.callTool({ name: 'restore_version', arguments: { id: 5 } });
  assert.ok(!restoreResult.isError);
  assert.ok(restoreResult.content[0].text.startsWith('Restored #5 as #1102 — now playing.'));
  assert.ok(!restoreResult.content[0].text.includes('were dropped'));
});

// A part launched from the page's Parts view lands in history as its own
// origin, reaches get_code with the existing hand-edit note, and survives a server restart.

test('history: a part launch from the page lands as a page version, get_code shows it, and a new server reads it back', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moontide-history-test-'));
  t.after(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const { client, port } = await startMcpClient({ env: { MOONTIDE_DATA_DIR: dataDir } });
  const page = await createFakePage(port);
  // An early assertion failure must still close the page socket and the MCP client (which owns
  // a real spawned server process) — otherwise it stays running and the whole suite
  // (test-isolation=process, concurrency 1) never moves past this file (same reasoning as the
  // restore_version test above).
  t.after(async () => {
    try {
      page.ws.close();
    } catch {
      // already closed
    }
    try {
      await client.close();
    } catch {
      // already closed
    }
  });
  page.setResponder((msg) => ({ type: 'evaluated', id: msg.id, ok: true, code: msg.code, audio: 'playing' }));

  // A raw collector, not nextMessage(): createFakePage() already installed its own permanent
  // 'message' relay (for the evaluate/stop auto-responder above), and that relay would race
  // nextMessage()'s own queue-backed wait for the version push this test needs to observe. A
  // second, independent 'message' listener sees every frame in parallel with the relay, with
  // no shared queue to race, so every version push the server sends is captured in order.
  const pageMessages = [];
  page.ws.on('message', (data) => {
    pageMessages.push(JSON.parse(data.toString()));
  });

  /** Polls pageMessages until one matches `predicate` — the part-launch frame (page to server,
   * over the WebSocket) and a get_code tool call (client to server, over stdio) are two
   * independent channels with no ordering guarantee between them, so a tool call issued right
   * after page.send() cannot assume the launch has already been processed. */
  async function waitForPageMessage(predicate, timeoutMs = 2000) {
    const start = Date.now();
    while (!pageMessages.some(predicate)) {
      if (Date.now() - start > timeoutMs) {
        throw new Error(`Timed out waiting for a matching page message; got ${JSON.stringify(pageMessages)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  const setResult = await client.callTool({
    name: 'set_code',
    arguments: { code: 'arrange([2, s("bd")], [2, s("hh")])', label: 'two parts' },
  });
  assert.ok(!setResult.isError);

  const launchedCode = 'arrange([2, s("bd")], [2, s("hh")]).late(1)';
  page.send({ type: 'part-launch', code: launchedCode, part: 'two' });
  await waitForPageMessage((m) => m.type === 'version' && m.id === 2);

  const getResult = await client.callTool({ name: 'get_code', arguments: {} });
  assert.ok(getResult.content[0].text.startsWith(launchedCode));
  assert.ok(getResult.content[0].text.includes('Note: this code was edited by hand in the page since your last change.'));

  const listResult = await client.callTool({ name: 'list_history', arguments: {} });
  const lines = listResult.content[0].text.split('\n');
  assert.match(lines[0], /^#2 — \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z — page — "launched two" — /);
  assert.ok(lines[0].includes(launchedCode.slice(0, 60)));

  const historyPath = path.join(dataDir, 'history.jsonl');
  const fileLines = fs
    .readFileSync(historyPath, 'utf8')
    .trim()
    .split('\n');
  const secondVersionEntry = JSON.parse(fileLines[2]);
  assert.equal(secondVersionEntry.type, 'version');
  assert.equal(secondVersionEntry.id, 2);
  assert.equal(secondVersionEntry.origin, 'page');
  assert.equal(secondVersionEntry.label, 'launched two');
  assert.equal(secondVersionEntry.code, launchedCode);

  page.ws.close();
  await client.close();

  const second = await startMcpClient({ env: { MOONTIDE_DATA_DIR: dataDir } });
  t.after(async () => {
    try {
      await second.client.close();
    } catch {
      // already closed
    }
  });
  const listAfterRestart = await second.client.callTool({ name: 'list_history', arguments: {} });
  const restartedFirstLine = listAfterRestart.content[0].text.split('\n')[0];
  assert.ok(restartedFirstLine.startsWith('#2'));
  assert.ok(restartedFirstLine.includes(' — page — '));

  await second.client.close();
});

// A Mixer gesture is a burst of mixer-live frames and one mixer-record. get_code
// returns the code that plays during the burst, and history shows exactly one new page version.

test('history: a burst of mixer-live frames then one mixer-record gives one page version, and get_code follows the burst', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moontide-history-test-'));
  t.after(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const { client, port } = await startMcpClient({ env: { MOONTIDE_DATA_DIR: dataDir } });
  const page = await createFakePage(port);
  t.after(async () => {
    try {
      page.ws.close();
    } catch {
      // already closed
    }
    try {
      await client.close();
    } catch {
      // already closed
    }
  });
  page.setResponder((msg) => ({ type: 'evaluated', id: msg.id, ok: true, code: msg.code, audio: 'playing' }));

  // A second, independent listener sees every frame the server sends, in order (see the part
  // launch test above for why nextMessage() would race the auto-responder relay).
  const pageMessages = [];
  page.ws.on('message', (data) => {
    pageMessages.push(JSON.parse(data.toString()));
  });
  async function waitForPageMessage(predicate, timeoutMs = 2000) {
    const start = Date.now();
    while (!pageMessages.some(predicate)) {
      if (Date.now() - start > timeoutMs) {
        throw new Error(`Timed out waiting for a matching page message; got ${JSON.stringify(pageMessages)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  const setResult = await client.callTool({
    name: 'set_code',
    arguments: { code: 'drums: s("bd").gain(0.3)', label: 'a kick' },
  });
  assert.ok(!setResult.isError);

  const codes = ['drums: s("bd").gain(0.3)', 'drums: s("bd").gain(0.5)', 'drums: s("bd").gain(0.7)'];
  page.send({ type: 'mixer-live', code: codes[0].replace('0.3', '0.4') });
  page.send({ type: 'mixer-live', code: codes[1] });
  page.send({ type: 'mixer-live', code: codes[2] });
  // Before the record: get_code already returns the code that plays. The frames and the tool call
  // travel on two channels with no ordering guarantee, so poll until the last live frame landed.
  let duringBurst = '';
  for (let attempt = 0; attempt < 200 && !duringBurst.startsWith(codes[2]); attempt += 1) {
    const reply = await client.callTool({ name: 'get_code', arguments: {} });
    duringBurst = reply.content[0].text;
    if (!duringBurst.startsWith(codes[2])) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(duringBurst.startsWith(codes[2]), `get_code followed the burst before the record: ${duringBurst}`);
  assert.equal(pageMessages.filter((m) => m.type === 'version').length, 1, 'the burst pushed no version');

  page.send({ type: 'mixer-record', code: codes[2], label: 'mixer: drums volume 0.7' });
  await waitForPageMessage((m) => m.type === 'version' && m.id === 2);

  const listResult = await client.callTool({ name: 'list_history', arguments: {} });
  const rows = listResult.content[0].text.split('\n').filter((line) => line.startsWith('#'));
  assert.equal(rows.length, 2, 'the burst added exactly one version');
  assert.match(rows[0], /^#2 — \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z — page — "mixer: drums volume 0.7" — /);
  assert.equal(pageMessages.filter((m) => m.type === 'version').length, 2, 'one version push for the set_code and one for the gesture');

  const versionEntries = fs
    .readFileSync(path.join(dataDir, 'history.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.type === 'version');
  assert.equal(versionEntries.length, 2);
  assert.equal(versionEntries[1].origin, 'page');
  assert.equal(versionEntries[1].parent, 1);
  assert.equal(versionEntries[1].code, codes[2]);
});

// The page asks for the history, restores an older version, and the restore
// lands as a page entry that Claude sees on its next tool call.

test('history: the page asks for the history, restores an older version, and the restore lands as a page entry Claude can see', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moontide-history-test-'));
  t.after(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const { client, port } = await startMcpClient({ env: { MOONTIDE_DATA_DIR: dataDir } });
  const page = await createFakePage(port);
  // Closes the page socket and the MCP client even when an assertion fails early, so the
  // spawned server never outlives the test (same reasoning as the part-launch test above).
  t.after(async () => {
    try {
      page.ws.close();
    } catch {
      // already closed
    }
    try {
      await client.close();
    } catch {
      // already closed
    }
  });
  page.setResponder((msg) => ({ type: 'evaluated', id: msg.id, ok: true, code: msg.code, audio: 'playing' }));

  // A raw collector with its own poller, for the reason given in the part-launch test above.
  const pageMessages = [];
  page.ws.on('message', (data) => {
    pageMessages.push(JSON.parse(data.toString()));
  });
  async function waitForPageMessage(predicate, timeoutMs = 2000) {
    const start = Date.now();
    while (!pageMessages.some(predicate)) {
      if (Date.now() - start > timeoutMs) {
        throw new Error(`Timed out waiting for a matching page message; got ${JSON.stringify(pageMessages)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  for (const code of ['s("bd")', 's("hh")', 's("bd*2")']) {
    const result = await client.callTool({ name: 'set_code', arguments: { code } });
    assert.ok(!result.isError);
  }

  // A page that never asked for the history has received no history frame so far.
  assert.ok(!pageMessages.some((m) => m.type.startsWith('history')));

  page.send({ type: 'history-request' });
  await waitForPageMessage(
    (m) => m.type === 'history' && m.versions.map((v) => v.id).join(',') === '3,2,1' && m.total === 3 && m.remaining === 0 && m.beyond === null,
  );

  page.send({ type: 'history-restore', id: 1 });
  await waitForPageMessage((m) => m.type === 'version' && m.id === 4 && m.restoredFrom === 1);
  await waitForPageMessage(
    (m) =>
      m.type === 'history-add' &&
      m.version.id === 4 &&
      m.version.origin === 'page' &&
      m.version.label === 'restored from #1' &&
      m.version.restoredFrom === 1 &&
      m.total === 4,
  );

  const getResult = await client.callTool({ name: 'get_code', arguments: {} });
  assert.ok(getResult.content[0].text.startsWith('s("bd")'));
  assert.ok(getResult.content[0].text.includes('Note: this code was edited by hand in the page since your last change.'));

  const listResult = await client.callTool({ name: 'list_history', arguments: {} });
  assert.match(
    listResult.content[0].text.split('\n')[0],
    /^#4 — \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z — page — "restored from #1" — /,
  );

  const fileLines = fs
    .readFileSync(path.join(dataDir, 'history.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const versionLines = fileLines.filter((entry) => entry.type === 'version');
  assert.equal(versionLines.length, 4);
  assert.equal(versionLines[3].origin, 'page');
  assert.equal(versionLines[3].restoredFrom, 1);
  assert.deepEqual(
    versionLines.slice(0, 3).map((entry) => [entry.id, entry.origin, entry.code]),
    [
      [1, 'claude', 's("bd")'],
      [2, 'claude', 's("hh")'],
      [3, 'claude', 's("bd*2")'],
    ],
  );
});

// Every new version records its parent, a restore then a change forks, and a
// restarted server continues the branch instead of starting a new root.

test('history: going back to an older version and changing it forks, the rows say so, and a restart continues the branch', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moontide-history-test-'));
  t.after(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const openings = [];
  t.after(async () => {
    for (const { page, client } of openings) {
      try {
        page.ws.close();
      } catch {
        // already closed
      }
      try {
        await client.close();
      } catch {
        // already closed
      }
    }
  });

  async function openSession() {
    const { client, port } = await startMcpClient({ env: { MOONTIDE_DATA_DIR: dataDir } });
    const page = await createFakePage(port);
    openings.push({ page, client });
    page.setResponder((msg) => ({ type: 'evaluated', id: msg.id, ok: true, code: msg.code, audio: 'playing' }));
    const pageMessages = [];
    page.ws.on('message', (data) => {
      pageMessages.push(JSON.parse(data.toString()));
    });
    async function waitForPageMessage(predicate, timeoutMs = 2000) {
      const start = Date.now();
      for (;;) {
        const found = pageMessages.find(predicate);
        if (found) return found;
        if (Date.now() - start > timeoutMs) {
          throw new Error(`Timed out waiting for a matching page message; got ${JSON.stringify(pageMessages)}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    return { client, page, pageMessages, waitForPageMessage };
  }

  const first = await openSession();
  for (const code of ['s("bd")', 's("hh")', 's("bd*2")']) {
    const result = await first.client.callTool({ name: 'set_code', arguments: { code } });
    assert.ok(!result.isError);
  }
  first.page.send({ type: 'history-request' });
  await first.waitForPageMessage((m) => m.type === 'history' && m.total === 3);

  first.page.send({ type: 'history-restore', id: 1 });
  await first.waitForPageMessage((m) => m.type === 'history-add' && m.version.id === 4);
  const forked = await first.client.callTool({ name: 'set_code', arguments: { code: 's("cp")' } });
  assert.ok(!forked.isError);
  await first.waitForPageMessage((m) => m.type === 'history-add' && m.version.id === 5);

  const historiesSeen = first.pageMessages.filter((m) => m.type === 'history').length;
  first.page.send({ type: 'history-request' });
  const fresh = await first.waitForPageMessage(
    (m) => m.type === 'history' && first.pageMessages.filter((x) => x.type === 'history').indexOf(m) >= historiesSeen,
  );
  assert.deepEqual(
    fresh.versions.map((v) => [v.id, v.parent]),
    [
      [5, 4],
      [4, 1],
      [3, 2],
      [2, 1],
      [1, undefined],
    ],
  );
  assert.ok(!('parent' in fresh.versions[4]));

  const historyPath = path.join(dataDir, 'history.jsonl');
  const readVersions = () =>
    fs
      .readFileSync(historyPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.type === 'version');
  assert.deepEqual(
    readVersions().map((v) => [v.id, v.parent]),
    [
      [1, undefined],
      [2, 1],
      [3, 2],
      [4, 1],
      [5, 4],
    ],
  );
  assert.ok(!('parent' in readVersions()[0]));

  first.page.ws.close();
  await first.client.close();

  // A restart replays no code, so the new session continues from the newest version in the file.
  const second = await openSession();
  const continued = await second.client.callTool({ name: 'set_code', arguments: { code: 's("hh*2")' } });
  assert.ok(!continued.isError);
  second.page.send({ type: 'history-request' });
  const afterRestart = await second.waitForPageMessage((m) => m.type === 'history' && m.total === 6);
  assert.equal(afterRestart.versions[0].id, 6);
  assert.equal(afterRestart.versions[0].parent, 5);
});

// The page pages back through a whole history, 100 rows at a time.

test('history: 120 versions arrive as 100 rows, and history-more brings the older 20', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moontide-history-test-'));
  t.after(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const seeded = [JSON.stringify({ type: 'session-start', at: '2026-01-01T00:00:00Z' })];
  for (let i = 1; i <= 120; i++) {
    seeded.push(JSON.stringify({ type: 'version', id: i, at: '2026-01-01T00:00:00Z', origin: 'claude', code: `s("bd*${i}")` }));
  }
  fs.writeFileSync(path.join(dataDir, 'history.jsonl'), seeded.join('\n') + '\n');

  const { client, port } = await startMcpClient({ env: { MOONTIDE_DATA_DIR: dataDir } });
  const page = await createFakePage(port);
  t.after(async () => {
    try {
      page.ws.close();
    } catch {
      // already closed
    }
    try {
      await client.close();
    } catch {
      // already closed
    }
  });
  const pageMessages = [];
  page.ws.on('message', (data) => {
    pageMessages.push(JSON.parse(data.toString()));
  });
  async function waitForPageMessage(predicate, timeoutMs = 2000) {
    const start = Date.now();
    for (;;) {
      const found = pageMessages.find(predicate);
      if (found) return found;
      if (Date.now() - start > timeoutMs) {
        throw new Error(`Timed out waiting for a matching page message; got ${JSON.stringify(pageMessages).slice(0, 500)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  page.send({ type: 'history-request' });
  const first = await waitForPageMessage((m) => m.type === 'history');
  assert.equal(first.versions.length, 100);
  assert.equal(first.versions[0].id, 120);
  assert.equal(first.versions.at(-1).id, 21);
  assert.equal(first.total, 120);
  assert.equal(first.remaining, 20);
  assert.equal(first.beyond.id, 20);

  page.send({ type: 'history-more', before: 21 });
  const older = await waitForPageMessage((m) => m.type === 'history-older');
  assert.equal(older.versions.length, 20);
  assert.equal(older.versions[0].id, 20);
  assert.equal(older.versions.at(-1).id, 1);
  assert.equal(older.remaining, 0);
  assert.equal(older.beyond, null);
  assert.equal(older.versions.at(-1).sessionStart, '2026-01-01T00:00:00Z');
});
