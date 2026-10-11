import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONNECTION_LABELS,
  SOUND_LABELS,
  COPY,
  BUILD_MISMATCH_COPY,
  SERVER_UPDATED_COPY,
  soundState,
  audioReport,
  errorLineText,
  FIRST_CYCLE_WATCH_MS,
  RESUME_AFTER_STOP_TIMEOUT_MS,
  versionIndicator,
  runtimeErrorFromLog,
  sampleLoadName,
  isFetchFailure,
  soundLoadFailureText,
  createSoundLoadTracker,
  QUERY_ERROR_LEAD,
  isQueryErrorText,
  createOncePerChange,
} from '../page/ui-state.js';

test('BUILD_MISMATCH_COPY pins the exact copy', () => {
  assert.equal(BUILD_MISMATCH_COPY.line, 'Restart Claude: different builds');
  assert.ok(BUILD_MISMATCH_COPY.line.length <= 40 && SERVER_UPDATED_COPY.line.length <= 40, 'short enough for a laptop top bar');
  assert.equal(
    BUILD_MISMATCH_COPY.title,
    'The server and the page come from different builds. Moontide was updated since this server started. Restart Claude (which runs the server), then reload this page.',
  );
});

test('SERVER_UPDATED_COPY pins the exact copy, says Moontide was updated and Claude must restart, and never claims a refusal or different builds', () => {
  assert.equal(SERVER_UPDATED_COPY.line, 'Restart Claude: Moontide was updated');
  assert.ok(SERVER_UPDATED_COPY.title.includes('The page and the server still match, so nothing is refused'));
  assert.ok(SERVER_UPDATED_COPY.title.includes('Restart Claude'));
  assert.ok(!/different builds/i.test(SERVER_UPDATED_COPY.line + SERVER_UPDATED_COPY.title));
});

test('CONNECTION_LABELS pins the exact copy', () => {
  assert.equal(CONNECTION_LABELS.connecting, 'Connecting…');
  assert.equal(CONNECTION_LABELS.connected, 'Connected');
  assert.equal(CONNECTION_LABELS.disconnected, 'Disconnected');
  assert.equal(CONNECTION_LABELS.refused, 'Refused — reload the page');
});

test('SOUND_LABELS pins the exact copy', () => {
  assert.equal(SOUND_LABELS.off, 'Sound off');
  assert.equal(SOUND_LABELS.silent, 'Silent');
  assert.equal(SOUND_LABELS.playing, 'Playing');
});

test('COPY pins the exact strings, including the ellipsis and em dash', () => {
  assert.equal(COPY.name, 'Moontide');
  assert.equal(COPY.cta, 'Click to start sound');
  assert.equal(COPY.audioBlocked, "Couldn't start audio — click again.");
});

test('soundState covers all four audioRunning/started combinations', () => {
  assert.equal(soundState({ audioRunning: false, started: false }), 'off');
  assert.equal(soundState({ audioRunning: false, started: true }), 'off');
  assert.equal(soundState({ audioRunning: true, started: false }), 'silent');
  assert.equal(soundState({ audioRunning: true, started: true }), 'playing');
});

test('audioReport maps AudioContext state to the page report value', () => {
  assert.equal(audioReport('running'), 'playing');
  assert.equal(audioReport('suspended'), 'waiting-for-click');
  assert.equal(audioReport('interrupted'), 'waiting-for-click');
});

test('errorLineText prefixes the message with "Error: "', () => {
  assert.equal(errorLineText('unexpected token at line 3'), 'Error: unexpected token at line 3');
});

test('errorLineText keeps only the first line of a multi-line message', () => {
  assert.equal(errorLineText('first line\nsecond line'), 'Error: first line');
});

test('errorLineText skips leading blank lines and trims the first non-empty one', () => {
  assert.equal(errorLineText('\n  \nreal message'), 'Error: real message');
});

test('errorLineText falls back to "unknown error" for empty or whitespace-only input', () => {
  assert.equal(errorLineText(''), 'Error: unknown error');
  assert.equal(errorLineText('   '), 'Error: unknown error');
});

test('SOUND_LABELS.stopped pins the exact copy', () => {
  assert.equal(SOUND_LABELS.stopped, 'Stopped');
});

test('soundState({ stopped: true }) is "stopped" for all four audioRunning/started combinations', () => {
  assert.equal(soundState({ audioRunning: false, started: false, stopped: true }), 'stopped');
  assert.equal(soundState({ audioRunning: false, started: true, stopped: true }), 'stopped');
  assert.equal(soundState({ audioRunning: true, started: false, stopped: true }), 'stopped');
  assert.equal(soundState({ audioRunning: true, started: true, stopped: true }), 'stopped');
});

test('soundState with stopped false (or missing) keeps the original mapping for all four combinations', () => {
  assert.equal(soundState({ audioRunning: false, started: false, stopped: false }), 'off');
  assert.equal(soundState({ audioRunning: false, started: true, stopped: false }), 'off');
  assert.equal(soundState({ audioRunning: true, started: false, stopped: false }), 'silent');
  assert.equal(soundState({ audioRunning: true, started: true, stopped: false }), 'playing');
  // stopped omitted entirely (the original call sites never pass it)
  assert.equal(soundState({ audioRunning: false, started: false }), 'off');
  assert.equal(soundState({ audioRunning: true, started: true }), 'playing');
});

test('FIRST_CYCLE_WATCH_MS + RESUME_AFTER_STOP_TIMEOUT_MS is at most 1000ms', () => {
  assert.ok(
    FIRST_CYCLE_WATCH_MS + RESUME_AFTER_STOP_TIMEOUT_MS <= 1000,
    `expected the combined watch/resume budget to leave at least 1s of the 2s set_code budget, got ${FIRST_CYCLE_WATCH_MS + RESUME_AFTER_STOP_TIMEOUT_MS}ms`,
  );
});

// The top-bar version indicator ("v42").

test('versionIndicator is hidden with no text when versionId is null, whatever the sound state or hasPlayed', () => {
  assert.deepEqual(versionIndicator({ versionId: null, soundState: 'playing', hasPlayed: true }), {
    hidden: true,
    text: '',
  });
});

test('versionIndicator is hidden before anything has played: waiting for the click ("off") or nothing played yet ("silent")', () => {
  assert.deepEqual(versionIndicator({ versionId: 42, soundState: 'off', hasPlayed: false }), {
    hidden: true,
    text: '',
  });
  assert.deepEqual(versionIndicator({ versionId: 42, soundState: 'silent', hasPlayed: false }), {
    hidden: true,
    text: '',
  });
});

test('versionIndicator is visible with "v{id}" while playing or stopped, even before hasPlayed catches up', () => {
  assert.deepEqual(versionIndicator({ versionId: 42, soundState: 'playing', hasPlayed: false }), {
    hidden: false,
    text: 'v42',
  });
  assert.deepEqual(versionIndicator({ versionId: 42, soundState: 'stopped', hasPlayed: false }), {
    hidden: false,
    text: 'v42',
  });
});

test('versionIndicator never reverts to hidden once a version has played, even back in "off" or "silent"', () => {
  assert.deepEqual(versionIndicator({ versionId: 42, soundState: 'off', hasPlayed: true }), {
    hidden: false,
    text: 'v42',
  });
  assert.deepEqual(versionIndicator({ versionId: 42, soundState: 'silent', hasPlayed: true }), {
    hidden: false,
    text: 'v42',
  });
});

test('versionIndicator text is always "v" plus the numeric id, with no other content, even for a large id', () => {
  const result = versionIndicator({ versionId: 123456, soundState: 'playing', hasPlayed: true });
  assert.equal(result.text, 'v123456');
  assert.match(result.text, /^v\d+$/);
});

// A restored version reads "v{id} · from v{N}".

test('versionIndicator adds " · from v{N}" for a restored version', () => {
  assert.deepEqual(versionIndicator({ versionId: 42, soundState: 'playing', hasPlayed: true, restoredFrom: 12 }), {
    hidden: false,
    text: 'v42 · from v12',
  });
});

test('versionIndicator stays plain "v{id}" when restoredFrom is null or absent', () => {
  assert.equal(versionIndicator({ versionId: 42, soundState: 'playing', hasPlayed: true, restoredFrom: null }).text, 'v42');
  assert.equal(versionIndicator({ versionId: 42, soundState: 'playing', hasPlayed: true }).text, 'v42');
});

test('versionIndicator keeps every hidden rule when restoredFrom is present', () => {
  const hidden = { hidden: true, text: '' };
  assert.deepEqual(versionIndicator({ versionId: null, soundState: 'playing', hasPlayed: true, restoredFrom: 12 }), hidden);
  assert.deepEqual(versionIndicator({ versionId: 42, soundState: 'off', hasPlayed: false, restoredFrom: 12 }), hidden);
  assert.deepEqual(versionIndicator({ versionId: 42, soundState: 'silent', hasPlayed: false, restoredFrom: 12 }), hidden);
});

// runtimeErrorFromLog decides what strudel.log messages reach Claude.

test('runtimeErrorFromLog forwards a cyclist error trimmed, unchanged from before this function existed', () => {
  assert.equal(runtimeErrorFromLog('[cyclist] error: sound nosuch not found! Is it loaded?'), 'sound nosuch not found! Is it loaded?');
});

test('runtimeErrorFromLog forwards a getTrigger error trimmed, including a multi-line message', () => {
  assert.equal(runtimeErrorFromLog('[getTrigger] error: boom\n  at somewhere'), 'boom\n  at somewhere');
});

test('runtimeErrorFromLog trims leading/trailing whitespace around the detail, same as the old page/main.js regex did', () => {
  assert.equal(runtimeErrorFromLog('[cyclist] error:   boom   '), 'boom');
});

test('runtimeErrorFromLog forwards an unknown chord inside .voicing() as a line naming it and saying it plays nothing', () => {
  assert.equal(
    runtimeErrorFromLog('[voicing]: unknown chord "Cfoo"'),
    'unknown chord "Cfoo" in .voicing(): it plays nothing',
  );
});

test('runtimeErrorFromLog returns null for an ordinary log line', () => {
  assert.equal(runtimeErrorFromLog('[eval] code updated'), null);
});

test('runtimeErrorFromLog returns null for undefined and for a non-string message', () => {
  assert.equal(runtimeErrorFromLog(undefined), null);
  assert.equal(runtimeErrorFromLog(42), null);
  assert.equal(runtimeErrorFromLog({ message: 'not a string' }), null);
});

// Naming a failed sound honestly, and every version shape.

test('sampleLoadName strips every trailing :<digits> segment from a load-sound line', () => {
  assert.equal(sampleLoadName('[sampler] load sound "kalimba:0:0"..'), 'kalimba');
  assert.equal(sampleLoadName('[sampler] load sound "kalimba:3:0"..'), 'kalimba');
  assert.equal(sampleLoadName('[sampler] load sound "probefail:0:0"..'), 'probefail');
});

test('sampleLoadName returns null for the done line, an unnamed sample line, and a non-string message', () => {
  assert.equal(sampleLoadName('[sampler] load sound "kalimba:0:0"... done! loaded 1.2 MB in 300ms'), null);
  assert.equal(sampleLoadName('[sampler] load sample..'), null);
  assert.equal(sampleLoadName(undefined), null);
  assert.equal(sampleLoadName(42), null);
});

test('isFetchFailure is true for the Chrome/Edge, Safari and Firefox fetch-failure prefixes, with detail appended', () => {
  assert.equal(isFetchFailure('Failed to fetch'), true);
  assert.equal(isFetchFailure('Load failed'), true);
  assert.equal(isFetchFailure('NetworkError when attempting to fetch resource.'), true);
  assert.equal(isFetchFailure('Failed to fetch (cdn.jsdelivr.net)'), true);
});

test('isFetchFailure is false for a non-fetch error, a decode error and an empty string', () => {
  assert.equal(isFetchFailure('sound nosuch not found! Is it loaded?'), false);
  assert.equal(isFetchFailure('Unable to decode audio data'), false);
  assert.equal(isFetchFailure(''), false);
});

test('soundLoadFailureText names the single distinct candidate, de-duplicated', () => {
  assert.equal(
    soundLoadFailureText('Failed to fetch', ['kalimba', 'kalimba']),
    'sound "kalimba" failed to load (Failed to fetch); it plays nothing until the page is reloaded',
  );
});

test('soundLoadFailureText lists several distinct candidates sorted, regardless of input order', () => {
  const expected =
    'one of these sounds failed to load (Failed to fetch): kalimba, steinway; the one that failed plays nothing until the page is reloaded';
  assert.equal(soundLoadFailureText('Failed to fetch', ['steinway', 'kalimba', 'steinway']), expected);
  assert.equal(soundLoadFailureText('Failed to fetch', ['kalimba', 'steinway']), expected);
});

test('soundLoadFailureText caps the list at MAX_NAMED_SOUNDS names, sorted, then "and N more"', () => {
  const names = ['j', 'i', 'h', 'g', 'f', 'e', 'd', 'c', 'b', 'a'];
  assert.equal(names.length, 10);
  const text = soundLoadFailureText('Failed to fetch', names);
  assert.equal(
    text,
    'one of these sounds failed to load (Failed to fetch): a, b, c, d, e, f, g, h and 2 more; the one that failed plays nothing until the page is reloaded',
  );
});

test('soundLoadFailureText says the page could not tell which one, for zero candidates', () => {
  assert.equal(
    soundLoadFailureText('Load failed', []),
    'a sound failed to load (Load failed), and the page could not tell which one',
  );
});

test('createSoundLoadTracker forgets a url once it loads successfully', () => {
  const tracker = createSoundLoadTracker();
  tracker.observe({ type: 'load-sample', message: '[sampler] load sound "kalimba:0:0"..', data: { url: 'u1' } });
  tracker.observe({
    type: 'loaded-sample',
    message: '[sampler] load sound "kalimba:0:0"... done! loaded 1 MB in 5ms',
    data: { url: 'u1' },
  });
  assert.deepEqual(tracker.pendingNames(), []);
});

test('createSoundLoadTracker keeps a pending load until it is confirmed loaded', () => {
  const tracker = createSoundLoadTracker();
  tracker.observe({ type: 'load-sample', message: '[sampler] load sound "kalimba:0:0"..', data: { url: 'u1' } });
  assert.deepEqual(tracker.pendingNames(), ['kalimba']);
});

test('createSoundLoadTracker de-duplicates the same name pending under two urls', () => {
  const tracker = createSoundLoadTracker();
  tracker.observe({ type: 'load-sample', message: '[sampler] load sound "kalimba:0:0"..', data: { url: 'u1' } });
  tracker.observe({ type: 'load-sample', message: '[sampler] load sound "kalimba:1:0"..', data: { url: 'u2' } });
  assert.deepEqual(tracker.pendingNames(), ['kalimba']);
});

test('createSoundLoadTracker ignores an unknown loaded-sample url, a null detail, a detail without data, and a non-load message, without throwing', () => {
  const tracker = createSoundLoadTracker();
  assert.doesNotThrow(() => {
    tracker.observe({ type: 'loaded-sample', data: { url: 'never-seen' } });
    tracker.observe(null);
    tracker.observe({ type: 'load-sample', message: '[sampler] load sound "x:0:0"..' });
    tracker.observe({ type: 'load-sample', message: '[sampler] load sample..', data: { url: 'u3' } });
  });
  assert.deepEqual(tracker.pendingNames(), []);
});

// A pattern that fails when queried logs "[query] error: ..." and plays nothing.

test('runtimeErrorFromLog forwards a query error as QUERY_ERROR_LEAD followed by the detail', () => {
  assert.equal(
    runtimeErrorFromLog('[query] error: cannot parse as numeral: "zz"'),
    QUERY_ERROR_LEAD + 'cannot parse as numeral: "zz"',
  );
});

test('runtimeErrorFromLog trims the detail of a query error like the cyclist branch', () => {
  assert.equal(runtimeErrorFromLog('[query] error:   boom  '), QUERY_ERROR_LEAD + 'boom');
});

test('runtimeErrorFromLog never cuts a 1000-character query error detail in the page', () => {
  const detail = 'x'.repeat(1000);
  assert.equal(runtimeErrorFromLog(`[query] error: ${detail}`), QUERY_ERROR_LEAD + detail);
});

test('runtimeErrorFromLog returns null for a non-string or undefined message', () => {
  assert.equal(runtimeErrorFromLog(undefined), null);
  assert.equal(runtimeErrorFromLog(42), null);
});

test('isQueryErrorText is true only for text that starts with QUERY_ERROR_LEAD', () => {
  assert.equal(isQueryErrorText(QUERY_ERROR_LEAD + 'x'), true);
  assert.equal(isQueryErrorText('sound x not found! Is it loaded?'), false);
  assert.equal(isQueryErrorText(undefined), false);
});

test('createOncePerChange says true only for the first sighting of each text until reset', () => {
  const once = createOncePerChange();
  assert.equal(once.first('a'), true);
  assert.equal(once.first('a'), false);
  assert.equal(once.first('b'), true);
  assert.equal(once.first('a'), false);
  once.reset();
  assert.equal(once.first('a'), true);
  assert.equal(once.first('b'), true);
});
