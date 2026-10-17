import { test } from 'node:test';
import assert from 'node:assert/strict';
import { watchLights, MIXER_LIGHT_WATCH_STOP } from '../scripts/probe-page.mjs';

// A page stand-in that records which watch texts were sent and fails the note count read.
function fakePage({ failCountRead }) {
  const sent = [];
  let running = false;
  const cdp = async (method, params) => {
    assert.equal(method, 'Runtime.evaluate');
    const expression = params.expression;
    sent.push(expression);
    if (expression === MIXER_LIGHT_WATCH_STOP) {
      running = false;
      return { result: { value: { events: {}, notes: [], frames: [] } } };
    }
    if (expression.includes('the light watch is already running')) {
      if (running) return { exceptionDetails: { text: 'the light watch is already running' } };
      running = true;
      return { result: { value: true } };
    }
    if (failCountRead) throw new Error('connection lost');
    return { result: { value: 0 } };
  };
  return { cdp, sent, isRunning: () => running };
}

test('watchLights stops the page-side watch when a read in its loop throws, so a repeated run does not meet a watch left installed', async () => {
  const page = fakePage({ failCountRead: true });
  await assert.rejects(() => watchLights(page.cdp, { t1: '#x' }, ['label:t1'], 5, 10), /connection lost/);
  assert.equal(page.isRunning(), false);
  assert.equal(page.sent.at(-1), MIXER_LIGHT_WATCH_STOP);
});
