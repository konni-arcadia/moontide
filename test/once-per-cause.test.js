// Each of these failures is said once per cause and never on a path that repeats. The page code runs in a browser, so
// these tests read the page source; the live behavior of the song checks is proved by `npm run probe:page -- --only song`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SONG_COPY } from '../page/structure.js';

const source = readFileSync(fileURLToPath(new URL('../page/main.js', import.meta.url)), 'utf8');

/** The text of a top-level function, from its first line to the closing brace at column 0. */
function functionText(name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  assert.notEqual(start, -1, `page/main.js has no function ${name}`);
  const end = source.indexOf('\n}\n', start);
  assert.notEqual(end, -1, `function ${name} does not end`);
  return source.slice(start, end + 3);
}

test('a stored launch choice outside the list is reported by one top-level line at page load', () => {
  const line = 'console.error(VIEW_PREFS_COPY.badSongLaunch)';
  assert.equal(source.split(line).length - 1, 1, 'the line appears exactly once');
  // Column 0, guarded by the flag from readViewPrefs: top-level code runs once per page load, never inside a function.
  assert.match(source, /^if \(initialPrefs\.songLaunchRejected\) console\.error\(VIEW_PREFS_COPY\.badSongLaunch\);$/m);
});

test('Play says once per page load that it could not reset the shift without the code parser, and still plays', () => {
  const text = functionText('resetSongShiftForPlay');
  assert.match(source, /^let playShiftNoParserSaid = false;$/m, 'a module-level latch');
  const sentence = 'Moontide: Play could not reset the shift of the song because the code parser is not loaded; the code plays as written.';
  assert.equal(source.split(sentence).length - 1, 1, 'the sentence is written once');
  assert.ok(text.includes(sentence), 'resetSongShiftForPlay says it');
  assert.ok(text.includes('playShiftNoParserSaid = true'), 'the latch is set when it is said');
  assert.equal(text.includes('throw '), false, 'nothing is thrown into Play');
});

test('a MIDI note without a port timestamp and without the audio clock is said once per page load and still reaches the lights', () => {
  const text = functionText('sayMidiNoteWithoutClock');
  assert.match(source, /^let midiNoteNoClockSaid = false;$/m, 'a module-level latch');
  assert.ok(text.includes('if (midiNoteNoClockSaid) return;'), 'the latch is read first');
  assert.ok(text.includes('midiNoteNoClockSaid = true'), 'the latch is set when it is said');
  assert.equal(text.includes('throw '), false, 'nothing is thrown into the scheduler');
  assert.equal(source.split('sayMidiNoteWithoutClock();').length - 1, 1, 'one call site');
  const subscriber = source.slice(source.indexOf('subscribeNotes((event) => {'));
  const body = subscriber.slice(0, subscriber.indexOf('\n});\n'));
  assert.ok(body.includes('sayMidiNoteWithoutClock();\n  }\n  lights.noteSeen(event.key, { target: event.target });'), 'the note is still timed as a browser sound after it is said');
});

test('a song check that stopped on an error and one that ran over its budget give two sentences and two data-check values', () => {
  assert.ok(functionText('songCheckEntry').includes('SONG_COPY.checkTooSlow'));
  assert.ok(functionText('songCheckEntry').includes('SONG_COPY.checkFailed'));
  const run = functionText('runSongCheck');
  assert.ok(run.includes("'too-slow'"), "runSongCheck writes 'too-slow' to data-check");
  assert.match(run, /songNotesEl\.dataset\.check = /);
  assert.notEqual(SONG_COPY.checkFailed, SONG_COPY.checkTooSlow);
  for (const line of [SONG_COPY.checkFailed, SONG_COPY.checkTooSlow]) {
    assert.ok(line.startsWith('The page could not check what plays against the declaration:'), line);
  }
});
