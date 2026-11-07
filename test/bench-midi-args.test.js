// Unit tests of the MIDI timing bench's options and the instrument its setup file names (scripts/bench-midi-timing.mjs). No browser,
// no port: only the parsed options and the rig they give.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { benchRig, parseBenchArgs } from '../scripts/bench-midi-timing.mjs';

const rigOf = (...argv) => benchRig(parseBenchArgs(argv));

test('--input names an MT-32 on the port with no clock, so no clock byte reaches the loopback', () => {
  assert.deepEqual(rigOf('--input', '--port', 'Loop'), { id: 'seq', model: 'mt32', port: 'Loop' });
});

test('--clock and --ramp declare the port a clock instrument, --tail does not, and the grid run names none', () => {
  assert.deepEqual(rigOf('--clock', '--port', 'Loop'), { id: 'seq', model: 'mt32', port: 'Loop', clock: true });
  assert.deepEqual(rigOf('--ramp', '80', '--port', 'Loop'), { id: 'seq', model: 'mt32', port: 'Loop', clock: true });
  assert.deepEqual(rigOf('--tail', '--port', 'Loop'), { id: 'seq', model: 'mt32', port: 'Loop' });
  assert.equal(rigOf('--port', 'Loop'), null);
});

test('--input cannot be combined with --clock', () => {
  assert.throws(() => parseBenchArgs(['--input', '--clock']), /--input cannot be combined with --clock/);
});
