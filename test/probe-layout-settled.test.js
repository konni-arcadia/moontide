import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutSettled, ProbeCouldNotRun } from '../scripts/probe-page.mjs';

// A page stand-in that answers the settle wait with a fixed result.
const pageAnswering = (value) => async () => ({ result: { value } });

test('layoutSettled returns what the page saw when the layout settled', async () => {
  const seen = await layoutSettled(pageAnswering({ settled: true, fit: 'full', frames: 4 }), 1280, 800);
  assert.deepEqual(seen, { settled: true, fit: 'full', frames: 4 });
});

test('layoutSettled throws ProbeCouldNotRun naming the size and the bar when the layout never settled, so a check cannot pass on it', async () => {
  await assert.rejects(
    () => layoutSettled(pageAnswering({ settled: false, fit: 'compact', frames: 180 }), 900, 300),
    (err) => err instanceof ProbeCouldNotRun && /900x300/.test(err.message) && /compact/.test(err.message) && /180 frames/.test(err.message),
  );
});
