// The check of the song declaration belongs to one version of the music. Closing the Timeline or the Jam view bumps the
// counter those views use to drop stale work, so the check and the song reading must not share that counter: a version
// that did not change keeps its check and its answer. These tests read the page source; the live behavior is proved by
// `npm run probe:page -- --only song` in real Chrome.
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

test('the song check, the song lines and the song reading never read the Timeline counter', () => {
  for (const name of ['runSongCheck', 'runSongFit', 'songNoteEntries']) {
    assert.equal(functionText(name).includes('timelineGeneration'), false, `${name} must not use timelineGeneration`);
  }
  const playing = functionText('onVersionPlaying');
  assert.match(playing, /songVersion\+\+/);
  assert.match(playing, /generation: songVersion/);
  assert.match(playing, /runSongCheck\(songVersion,/);
});

test('only a new version that plays bumps the song version', () => {
  assert.equal(source.match(/songVersion\+\+/g)?.length, 1);
  assert.equal(functionText('renderViews').includes('songVersion'), false);
});
