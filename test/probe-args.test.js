// Unit tests of the argument reader the two probes share (scripts/probe-page.mjs parseArgs): the group list of each
// probe, and the flags that run one named check several times alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PAGE_CHECK_NAMES, PAGE_GROUPS, ProbeCouldNotRun, parseArgs } from '../scripts/probe-page.mjs';
import { MIDI_GROUPS } from '../scripts/probe-midi.mjs';

function refusal(pattern) {
  return (err) => err instanceof ProbeCouldNotRun && pattern.test(err.message);
}

test('parseArgs: no flag gives a full run of one pass with no check', () => {
  assert.deepEqual(parseArgs([]), { headful: false, browserPath: null, only: null, check: null, times: 1 });
});

test('parseArgs: --check with --times reads both', () => {
  const args = parseArgs(['--check', 'ask-box-moves', '--times', '30']);
  assert.equal(args.check, 'ask-box-moves');
  assert.equal(args.times, 30);
  assert.equal(args.only, null);
});

test('parseArgs: --check alone runs the check once', () => {
  const args = parseArgs(['--check', 'ask-box-moves']);
  assert.equal(args.check, 'ask-box-moves');
  assert.equal(args.times, 1);
});

test('parseArgs: --times without --check is refused', () => {
  assert.throws(() => parseArgs(['--times', '3']), refusal(/--times needs --check/));
});

test('parseArgs: an unknown or missing check name is refused and the known names are listed', () => {
  for (const argv of [['--check', 'nope'], ['--check']]) {
    assert.throws(
      () => parseArgs(argv),
      (err) => err instanceof ProbeCouldNotRun && PAGE_CHECK_NAMES.every((name) => err.message.includes(`"${name}"`)),
    );
  }
});

test('parseArgs: --times accepts only a whole number from 1 to 200', () => {
  for (const bad of ['0', '-1', '1.5', 'x', '201']) {
    assert.throws(() => parseArgs(['--check', 'ask-box-moves', '--times', bad]), refusal(/--times needs a whole number from 1 to 200/), bad);
  }
  assert.throws(() => parseArgs(['--check', 'ask-box-moves', '--times']), refusal(/--times needs a whole number from 1 to 200/));
  assert.equal(parseArgs(['--check', 'ask-box-moves', '--times', '1']).times, 1);
  assert.equal(parseArgs(['--check', 'ask-box-moves', '--times', '200']).times, 200);
});

test('parseArgs: --check and --only cannot be combined, in either order', () => {
  assert.throws(() => parseArgs(['--only', 'bar', '--check', 'ask-box-moves']), refusal(/--check and --only cannot be combined/));
  assert.throws(() => parseArgs(['--check', 'ask-box-moves', '--only', 'bar']), refusal(/--check and --only cannot be combined/));
});

test('parseArgs: every check name of the page probe is accepted by --check', () => {
  assert.ok(PAGE_CHECK_NAMES.length > 0);
  for (const name of PAGE_CHECK_NAMES) assert.equal(parseArgs(['--check', name]).check, name);
});

test('parseArgs: every group of the page probe is accepted by --only and another name is refused', () => {
  for (const group of PAGE_GROUPS) assert.equal(parseArgs(['--only', group]).only, group);
  assert.throws(() => parseArgs(['--only', 'nope']), refusal(/--only needs a group name/));
});

test('parseArgs: the MIDI probe reads its own groups and refuses the others by name', () => {
  const options = { groups: MIDI_GROUPS, checks: [] };
  assert.deepEqual([...MIDI_GROUPS], ['song', 'mixer', 'timeline', 'ramp', 'ramp-measure', 'ramp-measure-late', 'ramp-gestures']);
  assert.equal(parseArgs(['--only', 'mixer'], options).only, 'mixer');
  assert.throws(
    () => parseArgs(['--only', 'bar'], options),
    (err) => err instanceof ProbeCouldNotRun && /"song"/.test(err.message) && /"mixer"/.test(err.message) && /"timeline"/.test(err.message) && /"ramp-measure-late"/.test(err.message),
  );
});

test('parseArgs: the MIDI probe has no check that runs alone', () => {
  assert.throws(() => parseArgs(['--check', 'x'], { groups: MIDI_GROUPS, checks: [] }), refusal(/no check of this probe runs alone/));
});
