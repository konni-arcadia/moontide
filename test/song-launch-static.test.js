// The launch of a section from the Song grid lives in page/main.js, which no unit test can run. These tests read its source
// (comments blanked out, so a comment can neither satisfy nor break a check) and pin the rules the launch must keep; the
// live behavior is proved by `npm run probe:page -- --only grid` in real Chrome.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const raw = readFileSync(fileURLToPath(new URL('../page/main.js', import.meta.url)), 'utf8');
const source = raw.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' ')).replace(/^\s*\/\/.*$/gm, '');

/** The text of a top-level function, from its first line to the closing brace at column 0. */
function functionText(name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  assert.notEqual(start, -1, `page/main.js has no function ${name}`);
  const end = source.indexOf('\n}\n', start);
  assert.notEqual(end, -1, `function ${name} does not end`);
  return source.slice(start, end + 3);
}

/** The takeover's onCancel handler. */
function onCancelText() {
  const start = source.indexOf('onCancel(record, reason) {');
  assert.notEqual(start, -1, 'page/main.js has no onCancel');
  const end = source.indexOf('onError: (text, err)', start);
  assert.notEqual(end, -1, 'onCancel does not end');
  return source.slice(start, end);
}

test('a canceled launch puts the playing code back only through putBackCanceledLaunch, which never replaces typing', () => {
  const cancel = onCancelText();
  assert.doesNotMatch(cancel, /editor\.setCode\(/, 'onCancel never writes the editor by itself');
  assert.match(cancel, /putBackCanceledLaunch\(record\)/);
  const putBack = functionText('putBackCanceledLaunch');
  assert.match(putBack, /textAfterCanceledLaunch\(\{ editorCode: editor\.code, launchCode: record\.code, playingCode: record\.playingCode \}\)/);
  assert.match(putBack, /console\.error\(/, 'leaving the editor alone is said on the console');
  assert.equal((source.match(/editor\.setCode\(record\.playingCode\)/g) ?? []).length, 0, 'no direct reset of the editor to the playing code');
});

test('a launch evaluates without autostart, so a Stop during its preparation cannot start the scheduler again', () => {
  const launch = functionText('launchSectionNow');
  const call = launch.slice(launch.indexOf('pageRewrite.apply('), launch.indexOf("outcome.status === 'refused'"));
  assert.match(call, /autostart: false,/);
  assert.doesNotMatch(call, /autostart: true/);
  // The launch that starts a stopped piece is the one that wants the scheduler started.
  assert.match(functionText('launchStoppedSection'), /autostart: true,/);
});

test('a click on a launch whose line the scheduler has passed does nothing: before the cancel and before the replacement', () => {
  const launch = functionText('launchSectionNow');
  const guard = launch.indexOf('ours.record.reached');
  assert.notEqual(guard, -1, 'the launch looks at record.reached');
  assert.ok(guard < launch.indexOf("takeover.cancel('canceled')"), 'before the cancel of the same header');
  assert.ok(guard < launch.indexOf('pageRewrite.apply('), 'and before the replacement built on the waiting code');
  assert.match(launch.slice(guard, guard + 400), /console\.error\([^)]*too close to its line[^)]*\);\s*return;/);
});

test('a Stop with a waiting launch of the grid puts the playing code back as a cancel does, also for a launch canceled before it was registered', () => {
  const cancel = onCancelText();
  const own = cancel.indexOf('const ownLaunch = gridLaunch !== null && gridLaunch.record === record;');
  assert.notEqual(own, -1, 'onCancel recognises the launch of the grid');
  assert.ok(own < cancel.indexOf('gridLaunch = null'), 'before it forgets the launch');
  assert.match(cancel, /reason === 'canceled' \|\| \(reason === 'stop' && ownLaunch\)\) putBackCanceledLaunch\(record\)/);
  const launch = functionText('launchSectionNow');
  assert.match(launch, /record\.canceled[\s\S]*record\.cancelReason === 'stop'[\s\S]*putBackCanceledLaunch\(record\)/);
});

test('a launch that a Stop interrupted tells the server about the Stop again right after its part-launch', () => {
  const launch = functionText('launchSectionNow');
  const taken = launch.slice(launch.indexOf('record === null || record === undefined'), launch.indexOf('if (record.canceled)'));
  const send = taken.indexOf("type: 'part-launch'");
  const again = taken.indexOf("if (pageStopped) sendIfOpen(JSON.stringify({ type: 'user-stopped' }))");
  assert.notEqual(send, -1, 'the code that was evaluated is still reported');
  assert.notEqual(again, -1, 'a stopped page says the Stop again');
  assert.ok(send < again, 'the Stop comes after the launch, so it is the last word');
});
