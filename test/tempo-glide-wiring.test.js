// What the page tells the server about a tempo ramp. The server keeps one record of the ramp that runs and clears it when
// the page says the ramp ended, so a report of a ramp may only leave the page while that ramp runs: every end of it is then
// sent after the report. The page code runs in a browser, so these tests read the page source; the live behavior is
// proved by `npm run probe:page -- --only ramp`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(fileURLToPath(new URL('../page/main.js', import.meta.url)), 'utf8');

/** The text of a top-level function, from its first line to the closing brace at column 0. */
function functionText(name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  assert.notEqual(start, -1, `page/main.js has no function ${name}`);
  const end = source.indexOf('\n}\n', start);
  assert.notEqual(end, -1, `function ${name} does not end`);
  return source.slice(start, end + 3);
}

test('a change that started a ramp reports it in its reply only while that ramp still runs', () => {
  assert.ok(
    functionText('startGlide').includes('run.glidePlan = tempoGlide.start('),
    'the run keeps the plan of the ramp it started',
  );
  const text = functionText('handleEvaluate');
  const last = text.slice(text.lastIndexOf("type: 'evaluated'"));
  assert.ok(text.includes('tempoGlide.runs(run.glidePlan)'), 'the started report is checked against the ramp that runs');
  assert.ok(last.includes('...(glide !== undefined ? { glide } : {})'), 'the final reply sends the checked report');
  assert.ok(!last.includes('{ glide: run.glide }'), 'the final reply never sends the unchecked report');
});

test('a waiting change that already took over when it is answered reports the ramp it started at its line, while it runs', () => {
  const text = functionText('handleEvaluate');
  assert.ok(
    text.includes('} else if (finishedBeforeReply && tempoGlide.runs(waiting.glidePlan)) {\n    glide = atLineGlide(waiting).glide;'),
    'the final reply falls back to the at-line report of the record, checked against the ramp that runs',
  );
});

test('a waiting change answered after it took over sends a silent end, after its reply, when it asked for a ramp and none runs', () => {
  const text = functionText('handleEvaluate');
  const last = text.slice(text.lastIndexOf("type: 'evaluated'"));
  const guard = "if (finishedBeforeReply && typeof waiting.glideBars === 'number' && !tempoGlide.running()) {\n    sendIfOpen(JSON.stringify({ type: 'glide-ended', reason: 'finished' }));";
  assert.ok(last.includes(guard), 'the end follows the final reply, only for a ramp asked for and only while no ramp runs');
});

/** The text of the page's onReached hook of the takeover, up to the next hook. */
function onReachedText() {
  const start = source.indexOf('  onReached(record) {');
  assert.notEqual(start, -1, 'page/main.js has an onReached hook');
  const end = source.indexOf('  onCancel(record, reason) {', start);
  assert.notEqual(end, -1, 'onReached is followed by onCancel');
  return source.slice(start, end);
}

test('a waiting change keeps the plan of the ramp it starts at its line, and ends an older one when it starts none', () => {
  const text = onReachedText();
  assert.ok(text.includes('record.glidePlan = tempoGlide.start('), 'the record keeps the plan of its ramp');
  assert.ok(text.includes("tempoGlide.cancel('replaced');"), 'an older ramp ends when the change starts none');
  assert.ok(!text.includes('glide-ended'), 'the line sends no end of its own: the takeover message says whether a ramp runs');
  assert.match(source, /record\.glidePlan = null;/, 'a record starts with no plan');
});

test('the takeover message says glideRuns only while the ramp the change started at its line runs', () => {
  const text = functionText('handleEvaluate');
  assert.ok(text.includes('const glideRuns = tempoGlide.runs(waiting.glidePlan);'), 'the ramp is checked when the message goes out');
  assert.ok(text.includes("{ type: 'takeover', id: msg.id, ...(glideRuns ? { glideRuns: true } : {}) }"), 'the message carries it');
});
