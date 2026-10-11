import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEvaluateTag } from '../page/evaluate-tag.js';

function makeTag(initial = null) {
  const cell = { value: initial };
  const tag = createEvaluateTag({ read: () => cell.value, write: (id) => (cell.value = id) });
  return { tag, cell };
}

test('begin tags the new code and remembers the tag that played; end keeps the baseline for the branches after it', () => {
  const { tag, cell } = makeTag('#1');
  tag.begin('#2');
  assert.equal(cell.value, '#2');
  assert.equal(tag.baseline(), '#1');
  tag.end();
  assert.equal(tag.baseline(), '#1');
  assert.equal(cell.value, '#2');
});

test('a takeover finisher outside an evaluation writes the live tag', () => {
  const { tag, cell } = makeTag('#1');
  tag.fromTakeover('#3');
  assert.equal(cell.value, '#3');
  tag.begin('#4');
  tag.end();
  assert.equal(tag.baseline(), '#3');
  tag.fromTakeover(null);
  assert.equal(cell.value, null, 'a hand evaluation that took over has no id');
});

test('a takeover inside an evaluation moves the baseline and leaves the live tag of the new code', () => {
  const { tag, cell } = makeTag('#1');
  tag.begin('#5');
  tag.fromTakeover('#2');
  assert.equal(cell.value, '#5', 'the errors of the new code are still tagged with its own id');
  assert.equal(tag.baseline(), '#2', 'what plays if the new code fails or only waits is the settled change');
  tag.end();
  assert.equal(cell.value, '#5', 'an immediate success keeps its own tag');
});

test('a takeover of a hand evaluation inside an evaluation makes the baseline null', () => {
  const { tag, cell } = makeTag('#1');
  tag.begin('#5');
  tag.fromTakeover(null);
  assert.equal(tag.baseline(), null);
  assert.equal(cell.value, '#5');
});

test('every evaluation starts from the live tag, not from the last baseline', () => {
  const { tag, cell } = makeTag('#1');
  tag.begin('#2');
  tag.fromTakeover('#9');
  tag.end();
  cell.value = '#7';
  tag.begin('#8');
  assert.equal(tag.baseline(), '#7');
});
