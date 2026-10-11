// The Session part of the top bar: the Session button with its count,
// the drawer that holds the quiet status items (an overlay under the bar that pushes nothing), and the session strip
// that repeats the facts that must not hide behind a click while the drawer is closed. Every text reaches the page
// through textContent, title and setAttribute, never as markup. The view never sends and never stores: page/main.js
// gives it callbacks and feeds it the facts (page/bar-model.js decides what counts and what the strip says). No DOM
// access at import time: main.js calls createSessionView() with its document.
//
// The drawer is non-modal, like the (i) popovers of page/midi-view.js: opening moves focus into the panel, Esc closes
// only the drawer and returns focus to the Session button, focus leaving closes it unless the window itself lost
// focus, and a press outside closes it.

import { BAR_COPY, sessionButtonModel } from './bar-model.js';
import { CHANGE_COPY, timingOptions } from './change-timing.js';

/** The popovers the drawer's (i) buttons open. They are fixed-position outside the drawer; focus inside one is focus inside the drawer. */
const POPOVER_SELECTOR = '#midi-help, #page-requests-help';

/** The issue keys that put the Session card (connection, build line, tab role) in the "needs you" state. */
const SESSION_CARD_KEYS = ['connection', 'build', 'updated', 'tab'];

/**
 * Creates the view. `document` is the page's document (named so on purpose: every element lookup below reads
 * `document.getElementById`, the shape test/page-hidden.test.js scans); `onTakeBack` runs on every click of the
 * strip's Play in this tab button (main.js passes the same function the card's button gets, so the two cannot
 * differ); `onOpen` runs right before the drawer opens (main.js closes an open (i) popover there); `setTimer` is the
 * page's timer (the focus-out check runs on the next tick, like the popovers'); `onTimingPick(value)` runs on every
 * press of one of the three Edits timing buttons (the page applies the setting and says its line; the view only shows
 * the pressed state it is given through `setTiming`).
 */
export function createSessionView({ document, onTakeBack, onOpen, setTimer, onTimingPick }) {
  const sessionButton = document.getElementById('session-button');
  const sessionCount = document.getElementById('session-count');
  const sessionDrawer = document.getElementById('session-drawer');
  const sessionCardSession = document.getElementById('session-card-session');
  const sessionCardMidi = document.getElementById('session-card-midi');
  const sessionStrip = document.getElementById('session-strip');
  const stripText = document.getElementById('strip-text');
  const stripTakeBack = document.getElementById('strip-take-back');
  const changeTiming = document.getElementById('change-timing');
  if (!changeTiming || !sessionButton || !sessionCount || !sessionDrawer || !sessionCardSession || !sessionCardMidi || !sessionStrip || !stripText || !stripTakeBack) {
    throw new Error('Moontide: the Session markup is missing from the page.');
  }
  const buttonLabel = sessionButton.querySelector('.session-label');
  const buttonChevron = sessionButton.querySelector('.session-chevron');
  if (!buttonLabel || !buttonChevron) {
    throw new Error('Moontide: the Session markup is missing from the page.');
  }

  // The static words come from BAR_COPY by key, so an unknown key is loud and no sentence is written twice.
  for (const element of sessionDrawer.querySelectorAll('[data-copy]')) {
    const key = element.dataset.copy;
    if (typeof BAR_COPY[key] !== 'string') {
      throw new Error(`Moontide: the Session markup asks for the copy "${key}", which BAR_COPY does not hold.`);
    }
    element.textContent = BAR_COPY[key];
    if (key === 'rightClickHint') element.setAttribute('title', BAR_COPY.rightClickHintTitle);
  }
  // The Edits timing group: three native buttons built from timingOptions, one pressed. Text and attributes only.
  changeTiming.setAttribute('aria-label', BAR_COPY.settingsLabel);
  changeTiming.setAttribute('title', CHANGE_COPY.timingTitle);
  const timingButtons = timingOptions().map((option) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.value = option.value;
    button.textContent = option.label;
    button.setAttribute('aria-label', option.name);
    button.setAttribute('aria-pressed', 'false');
    button.addEventListener('click', () => onTimingPick(option.value));
    return button;
  });
  changeTiming.replaceChildren(...timingButtons);
  buttonLabel.textContent = BAR_COPY.session;
  stripTakeBack.textContent = BAR_COPY.takeBack;
  stripTakeBack.setAttribute('title', BAR_COPY.takeBack);
  stripTakeBack.addEventListener('click', () => onTakeBack());

  // What each part shows now, so only what changed is written (no rebuild on every render).
  let shownIssues = null;
  let stripWanted = false;
  let shownStripText = null;
  let shownStripButton = null;

  function chevron(open) {
    buttonChevron.textContent = open ? '▴' : '▾';
  }
  chevron(false);

  const isOpen = () => !sessionDrawer.hidden;

  /** The strip shows only while the drawer is closed and a condition holds. */
  function renderStrip() {
    sessionStrip.hidden = !stripWanted || isOpen();
  }

  function open() {
    if (isOpen()) return;
    onOpen();
    sessionDrawer.hidden = false;
    sessionButton.setAttribute('aria-expanded', 'true');
    chevron(true);
    renderStrip();
    sessionDrawer.focus();
  }

  function close({ focusButton = false } = {}) {
    if (!isOpen()) return;
    sessionDrawer.hidden = true;
    sessionButton.setAttribute('aria-expanded', 'false');
    chevron(false);
    renderStrip();
    if (focusButton) sessionButton.focus();
  }

  // Keeps focus where it is on a press (the (i) buttons' trick), so a second click toggles the drawer closed instead
  // of the focus-out closing it first and the click opening it again.
  // After a mouse click the bar gives up focus, so the view keys work at once; after a keyboard
  // activation (a click event with no detail) focus returns to the button.
  sessionButton.addEventListener('mousedown', (event) => event.preventDefault());
  sessionButton.addEventListener('click', (event) => {
    if (isOpen()) close({ focusButton: event.detail === 0 });
    else open();
  });

  const onDrawerKeydown = (event) => {
    if (event.key !== 'Escape' || !isOpen()) return;
    // Esc closes the drawer only, never an open view.
    event.preventDefault();
    event.stopPropagation();
    close({ focusButton: true });
  };
  sessionButton.addEventListener('keydown', onDrawerKeydown);
  sessionDrawer.addEventListener('keydown', onDrawerKeydown);

  /** True for a node that belongs to the drawer: the button, the panel or a popover opened from one of its cards. */
  function belongsToDrawer(node) {
    if (node === null || node === undefined) return false;
    if (sessionButton.contains(node) || sessionDrawer.contains(node)) return true;
    return typeof node.closest === 'function' && node.closest(POPOVER_SELECTOR) !== null;
  }

  // Tab away or a click elsewhere closes the drawer; switching to another app (the window loses focus as a whole)
  // leaves it open. Focus is checked after the event settles.
  const onFocusout = () => {
    setTimer(() => {
      if (!isOpen() || !document.hasFocus()) return;
      if (belongsToDrawer(document.activeElement)) return;
      close();
    }, 0);
  };
  sessionButton.addEventListener('focusout', onFocusout);
  sessionDrawer.addEventListener('focusout', onFocusout);

  // A press outside closes it (a press on a part of the page that takes no focus moves no focus at all).
  document.addEventListener('pointerdown', (event) => {
    if (!isOpen() || belongsToDrawer(event.target)) return;
    close();
  });

  /** The Session button and the cards from the list of issues (page/bar-model.js sessionIssues). Written only when it changed. */
  function setIssues(issues) {
    const key = JSON.stringify(issues);
    if (key === shownIssues) return;
    shownIssues = key;
    const model = sessionButtonModel(issues);
    sessionButton.setAttribute('aria-label', model.label);
    if (model.title === '') sessionButton.removeAttribute('title');
    else sessionButton.setAttribute('title', model.title);
    sessionCount.textContent = String(model.count);
    sessionCount.hidden = model.count === 0;
    const keys = issues.map((issue) => issue.key);
    if (keys.length === 0) {
      sessionButton.removeAttribute('data-needs');
      sessionDrawer.removeAttribute('data-issues');
    } else {
      sessionButton.dataset.needs = 'true';
      sessionDrawer.dataset.issues = keys.join(' ');
    }
    sessionCardSession.dataset.needs = String(keys.some((issueKey) => SESSION_CARD_KEYS.includes(issueKey)));
    sessionCardMidi.dataset.needs = String(keys.includes('midi'));
  }

  /** The strip from page/bar-model.js stripModel: { visible, text, takeBack }. */
  function setStrip(model) {
    stripWanted = model.visible;
    if (model.text !== shownStripText) {
      stripText.textContent = model.text;
      shownStripText = model.text;
    }
    if (model.takeBack !== shownStripButton) {
      stripTakeBack.hidden = !model.takeBack;
      shownStripButton = model.takeBack;
    }
    renderStrip();
  }

  /** The strip's button reads "Play in this tab" and can be clicked, or reads "Taking over…" and cannot (as the card's button). */
  function setTakeBackPending(pending) {
    stripTakeBack.textContent = pending ? BAR_COPY.takingOver : BAR_COPY.takeBack;
    stripTakeBack.disabled = pending;
  }

  /** The pressed state of the three Edits timing buttons: exactly the one whose value is `value` is pressed. */
  function setTiming(value) {
    for (const button of timingButtons) button.setAttribute('aria-pressed', String(button.dataset.value === value));
  }

  return { setIssues, setStrip, setTakeBackPending, setTiming, open, close, isOpen };
}
