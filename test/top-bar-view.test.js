// The top bar's view on a fake page (page/top-bar-view.js): the tempo readout writes each part only when it changed, the bar is
// fitted again only when the readout's text length or its idle state changed, and the live region is written each time it
// is told to speak. The model is the real one (page/bar-model.js); the live page is proved by `npm run probe:page`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createTopBarView } from '../page/top-bar-view.js';
import { tempoText } from '../page/bar-model.js';
import { rampLine } from '../page/change-timing.js';
import { fakeDocument } from './fake-document.js';

const VIEW_PATH = new URL('../page/top-bar-view.js', import.meta.url);

/** The markup the view needs, the view itself, and the nodes a test counts writes on. */
function setup() {
  const doc = fakeDocument();
  const root = doc.createElement('div');
  doc.markup.push(root);
  const make = (tagName, id, parent = root, className = '') => {
    const node = doc.createElement(tagName);
    node.id = id;
    node.className = className;
    parent.appendChild(node);
    return node;
  };
  const topBar = make('div', 'top-bar');
  topBar.scrollWidth = 0;
  const readout = make('span', 'tempo-readout', topBar);
  const num = make('span', '', readout, 'tempo-num');
  const arrow = make('span', '', readout, 'tempo-arrow');
  const unit = make('span', '', readout, 'tempo-unit');
  const pending = make('span', 'pending-change', topBar);
  make('span', '', pending, 'pending-lead');
  make('span', '', pending, 'pending-rest');
  make('span', 'cycle-beat', topBar);
  const status = make('span', 'change-status', topBar);
  const observed = [];
  class FakeResizeObserver {
    observe(node) {
      observed.push(node);
    }
  }
  const view = createTopBarView({ document: doc, ResizeObserver: FakeResizeObserver });
  return { doc, view, topBar, readout, num, arrow, unit, status, observed };
}

const ramp = (bpm, targetBpm = 120, barsLeft = 4) => tempoText({ playing: true, bpm, ramp: { targetBpm, barsLeft } });

test('showTempo: the same model twice writes nothing the second time', () => {
  const { doc, view } = setup();
  view.showTempo(ramp(112));
  const before = doc.writes;
  view.showTempo(ramp(112));
  assert.equal(doc.writes, before);
  view.showTempo(tempoText({ playing: true, bpm: 118.5 }));
  const steady = doc.writes;
  view.showTempo(tempoText({ playing: true, bpm: 118.5 }));
  assert.equal(doc.writes, steady);
});

test('showTempo: a ramp reads its parts as the model gives them', () => {
  const { view, num, arrow, unit, readout } = setup();
  view.showTempo(ramp(112));
  assert.equal(num.textContent, '112');
  assert.equal(arrow.textContent, ' → 120');
  assert.equal(unit.textContent, ' BPM');
  assert.equal(readout.getAttribute('aria-label'), 'Tempo 112 BPM, rising to 120 BPM');
  assert.equal(readout.getAttribute('title'), 'Tempo moving up to 120 BPM. 4 bars left.');
  assert.equal(readout.dataset.idle, 'false');
});

test('showTempo: a number that changes inside the same length rewrites it and its name, not the arrow, the unit or the title, and fits nothing', () => {
  const { view, num, arrow, unit, readout, topBar } = setup();
  view.showTempo(ramp(112));
  const fits = topBar.writes;
  const writes = { num: num.writes, arrow: arrow.writes, unit: unit.writes, readout: readout.writes };
  view.showTempo(ramp(113));
  assert.equal(num.textContent, '113');
  assert.equal(num.writes, writes.num + 1);
  assert.equal(arrow.writes, writes.arrow);
  assert.equal(unit.writes, writes.unit);
  // The accessible name carries the number, so it is the only other write; the title did not change.
  assert.equal(readout.writes, writes.readout + 1);
  assert.equal(readout.getAttribute('aria-label'), 'Tempo 113 BPM, rising to 120 BPM');
  assert.equal(topBar.writes, fits, 'the bar was not fitted again');
});

test('showTempo: the title is written once per bar, and the number alone between', () => {
  const { view, readout } = setup();
  view.showTempo(ramp(112, 120, 4));
  const first = readout.writes;
  view.showTempo(ramp(113, 120, 4));
  view.showTempo(ramp(114, 120, 4));
  assert.equal(readout.writes, first + 2, 'two names, no title');
  view.showTempo(ramp(115, 120, 3));
  assert.equal(readout.getAttribute('title'), 'Tempo moving up to 120 BPM. 3 bars left.');
});

test('showTempo: a text that gets longer or shorter fits the bar once; so does the idle form', () => {
  const { view, topBar } = setup();
  view.showTempo(ramp(98, 120));
  let fits = topBar.writes;
  view.showTempo(ramp(99, 120));
  assert.equal(topBar.writes, fits, 'same length');
  view.showTempo(ramp(100, 120));
  assert.equal(topBar.writes, fits + 1, 'the number got a digit longer');
  fits = topBar.writes;
  view.showTempo(tempoText({ playing: true, bpm: 120 }));
  assert.equal(topBar.writes, fits + 1, 'the ramp ended: the text got shorter');
  fits = topBar.writes;
  view.showTempo(tempoText({ playing: false }));
  assert.equal(topBar.writes, fits + 1, 'the idle form');
});

test('showTempo: an idle form of the same length as a tempo still fits, because the state changed', () => {
  const { view, topBar } = setup();
  // The dash reads '— BPM', five characters, as does '9 BPM'.
  view.showTempo(tempoText({ playing: true, bpm: 9 }));
  const fits = topBar.writes;
  view.showTempo(tempoText({ playing: false }));
  assert.equal(topBar.writes, fits + 1);
});

test('showTempo: the ramp ending returns the steady form with nothing of the ramp left', () => {
  const { view, num, arrow, readout } = setup();
  view.showTempo(ramp(119.6, 120, 1));
  assert.equal(arrow.textContent, '');
  view.showTempo(ramp(112));
  assert.equal(arrow.textContent, ' → 120');
  view.showTempo(tempoText({ playing: true, bpm: 120 }));
  assert.equal(num.textContent, '120');
  assert.equal(arrow.textContent, '');
  assert.equal(readout.getAttribute('aria-label'), 'Tempo 120 BPM');
  assert.equal(readout.getAttribute('title'), 'Tempo of the music that plays');
});

test('say: every call writes the live region, also with the same text, and a ramp is spoken at its start and end only', () => {
  const { view, status, doc } = setup();
  const started = rampLine({ kind: 'started', fromBpm: 100, toBpm: 120, bars: 4 });
  view.say(started);
  const afterStart = status.writes;
  assert.equal(status.textContent, 'Tempo ramp started: 100 to 120 BPM over 4 bars.');
  view.say(started);
  assert.equal(status.writes, afterStart + 1, 'the same text is written again');
  // The readout steps through the whole ramp without a write to the live region.
  const spoken = status.writes;
  for (let bpm = 100; bpm <= 120; bpm += 1) view.showTempo(ramp(bpm, 120, Math.max(1, Math.ceil((120 - bpm) / 5))));
  view.showTempo(tempoText({ playing: true, bpm: 120 }));
  assert.equal(status.writes, spoken, 'no step is spoken');
  assert.ok(doc.writes > spoken);
  view.say(rampLine({ kind: 'finished', toBpm: 120 }));
  assert.equal(status.textContent, 'Tempo ramp finished at 120 BPM.');
});

test('the view writes only text and attributes: no markup property is used', () => {
  const source = readFileSync(VIEW_PATH, 'utf8');
  assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
});
