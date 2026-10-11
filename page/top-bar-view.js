// The top bar's change-timing part: the tempo readout (always shown, a dash while nothing plays), the countdown
// while a change waits, the hidden status line and the fit step that gives text up
// when the bar runs out of width. Every text reaches the page through
// textContent and setAttribute, never as markup. No DOM access at import time: main.js calls createTopBarView()
// with its document. The words and numbers live in the pure modules page/change-timing.js and page/bar-model.js.

import { FIT_STEPS, countdownParts, countdownTitle } from './change-timing.js';
import { tempoText } from './bar-model.js';

/**
 * Creates the view. `document` is the page's document (named so on purpose: every element lookup below reads
 * `document.getElementById`, the shape test/page-hidden.test.js scans); `ResizeObserver` is the page's
 * constructor, watching the bar and every direct child so the fit step follows the width and the content. The hand-edit
 * setting is not here any more: it is the three Edits timing buttons of the Settings card (page/session-view.js).
 */
export function createTopBarView({ document, ResizeObserver }) {
  const topBar = document.getElementById('top-bar');
  const tempoReadout = document.getElementById('tempo-readout');
  const pendingChange = document.getElementById('pending-change');
  const cycleBeatEl = document.getElementById('cycle-beat');
  const changeStatus = document.getElementById('change-status');
  if (!topBar || !tempoReadout || !pendingChange || !cycleBeatEl || !changeStatus) {
    throw new Error('Moontide: the top-bar markup is missing from the page.');
  }
  const tempoNum = tempoReadout.querySelector('.tempo-num');
  const tempoArrow = tempoReadout.querySelector('.tempo-arrow');
  const tempoUnit = tempoReadout.querySelector('.tempo-unit');
  const pendingLead = pendingChange.querySelector('.pending-lead');
  const pendingRest = pendingChange.querySelector('.pending-rest');
  if (!tempoNum || !tempoArrow || !tempoUnit || !pendingLead || !pendingRest) {
    throw new Error('Moontide: the top-bar markup is missing from the page.');
  }

  // What each item shows now, so only what changed is written (no rebuild on every poll).
  let shownTempo = null;
  let shownCountdown = null;
  let shownStatus = '';
  let shownCycleBeat = '';

  /**
   * The fit step: sets data-fit to the first step, then raises it one step at a time while the bar overflows
   * (`scrollWidth` above `clientWidth`) and a step remains, all in one synchronous block, so the result is a pure
   * function of the widths and the content (no oscillation, no state between runs, no paint between steps). The bar
   * has no overflow: hidden, so the measure is its own overflow; there is no pixel or rem constant to drift from the CSS.
   * Every writer that changes a width calls this, and the observer below runs it when the bar or a child changes size.
   */
  function fit() {
    let step = FIT_STEPS[0];
    topBar.setAttribute('data-fit', String(step));
    while (topBar.scrollWidth > topBar.clientWidth && step < FIT_STEPS[FIT_STEPS.length - 1]) {
      step += 1;
      topBar.setAttribute('data-fit', String(step));
    }
  }

  /**
   * The tempo readout from the model (`tempoText` in page/bar-model.js). It is never hidden: nothing playing shows the
   * dash in muted text. The number, the arrow part (only while a change with a new tempo waits), the unit, the
   * accessible name and the title are written only when they changed. The spaces between the parts are written here.
   */
  function showTempo(model) {
    const key = `${model.text}|${model.name}|${model.title}|${model.idle}`;
    if (key === shownTempo) return;
    tempoNum.textContent = model.num;
    tempoArrow.textContent = model.arrow === '' ? '' : ` ${model.arrow}`;
    tempoUnit.textContent = ` ${model.unit}`;
    tempoReadout.dataset.idle = String(model.idle);
    tempoReadout.setAttribute('aria-label', model.name);
    tempoReadout.setAttribute('title', model.title);
    shownTempo = key;
    fit();
  }

  /**
   * The cycle and beat beside the tempo (decoration: aria-hidden, no live region): `model` is cycleBeat()'s result, or null
   * to show nothing. The text and the title are written only when they changed. The bar's width changes only when the
   * text gets longer or shorter (the digits are mono), so fit() runs then and not on every beat.
   */
  function showCycleBeat(model) {
    const text = model === null ? '' : model.text;
    const title = model === null ? '' : model.title;
    const key = `${text}|${title}`;
    if (key === shownCycleBeat) return;
    const lengthChanged = text.length !== shownCycleBeat.split('|')[0].length;
    cycleBeatEl.textContent = text;
    if (title === '') cycleBeatEl.removeAttribute('title');
    else cycleBeatEl.setAttribute('title', title);
    cycleBeatEl.hidden = text === '';
    shownCycleBeat = key;
    if (lengthChanged) fit();
  }

  /** The countdown for a change waiting on `at` ('bar' or 'phrase') with `beatsLeft` beats to go, or null to hide it. */
  function showCountdown(waiting) {
    if (waiting === null) {
      if (shownCountdown !== null) {
        pendingChange.hidden = true;
        shownCountdown = null;
        fit();
      }
      return;
    }
    const parts = countdownParts(waiting.beatsLeft);
    const title = countdownTitle(waiting.at);
    const key = `${parts.lead}${parts.rest}|${title}`;
    if (key === shownCountdown) return;
    pendingLead.textContent = parts.lead;
    pendingRest.textContent = parts.rest;
    pendingChange.setAttribute('title', title);
    pendingChange.hidden = false;
    shownCountdown = key;
    fit();
  }

  /**
   * Writes one line into the hidden live region. Always written, even when the text is the same as before: a
   * newer change that replaces a waiting one is announced again.
   */
  function say(text) {
    changeStatus.textContent = text;
    shownStatus = text;
  }

  /** Empties the live region silently (nothing is announced for an empty text). */
  function clearStatus() {
    if (shownStatus === '') return;
    say('');
  }

  const observer = new ResizeObserver(() => fit());
  observer.observe(topBar);
  for (const child of topBar.children) observer.observe(child);

  // The idle form shows from the first draw, before the first poll.
  showTempo(tempoText({ playing: false }));

  return { showTempo, showCycleBeat, showCountdown, say, clearStatus, fit };
}
