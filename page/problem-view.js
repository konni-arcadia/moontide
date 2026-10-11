// The failed-change banner under the top bar: the lead, the one
// sentence that is true about the music, the first line of the error (#eval-error, the id every probe reads) and the
// buttons. The banner sits in flow, takes no focus when it appears and has no role of its own; a separate, visually
// hidden role="alert" region announces a failed change once. Every text reaches the page through textContent, title and
// setAttribute, never as markup (an error message can carry user code, track names and sample names). The view never
// sends and never stores: page/main.js feeds it the model that page/bar-model.js (bannerCopy) computed and gives it
// the clipboard as a callback. No DOM access at import time: main.js calls createProblemView() with its document.
//
// Details opens the whole text in place (a scrolling box, drawn cut at PROBLEM_DRAWN_MAX characters). Copy writes the
// uncut text and says out loud when the clipboard refuses: the failure is shown in the banner, Details opens so the
// text can be selected by hand, and one console.error names the cause. No legacy copy fallback is used.
//
// Ask Claude (a failed change only) hands the pointer and the full message to onAsk, which opens the Ask box in
// main.js. A right-click on the banner opens a small popover of three plain buttons (Copy the error, Ask Claude about it,
// Dismiss) with the same actions: not an ARIA menu, so there is no arrow-key code; Tab moves between the buttons, Esc
// closes only the popover and returns focus to the banner, and focus leaving it or a press outside closes it.

import { BAR_COPY } from './bar-model.js';

/** How long the Copy button says Copied. */
const COPIED_MS = 2000;

/**
 * Creates the view. `document` is the page's document (named so on purpose: every element lookup below reads
 * `document.getElementById`, the shape test/page-hidden.test.js scans); `writeText(text)` writes to the clipboard and
 * returns a promise (main.js passes the platform call; a probe spies on it); `setTimer` and `clearTimer` are the
 * page's timers (the Copied word goes back after COPIED_MS); `onAsk({ x, y, text })` is called when the user asks Claude
 * about the failed change, with the center of the pressed button and the uncut message; `onReleaseFocus()` is called when
 * the banner (or its popover) is hidden while it holds focus, and moves focus to a stable control of the top bar so it
 * never falls to the page body.
 */
export function createProblemView({ document, writeText, setTimer, clearTimer, onAsk, onReleaseFocus }) {
  const banner = document.getElementById('problem-banner');
  const evalError = document.getElementById('eval-error');
  const dismissButton = document.getElementById('problem-dismiss');
  const detailsToggle = document.getElementById('problem-details-toggle');
  const detailsBox = document.getElementById('problem-details');
  const copyButton = document.getElementById('problem-copy');
  const copyFailure = document.getElementById('problem-copy-failure');
  const alertRegion = document.getElementById('problem-alert');
  const askButton = document.getElementById('problem-ask');
  const menu = document.getElementById('problem-menu');
  const menuCopy = document.getElementById('problem-menu-copy');
  const menuAsk = document.getElementById('problem-menu-ask');
  const menuDismiss = document.getElementById('problem-menu-dismiss');
  if (typeof onAsk !== 'function') throw new Error('Moontide: the failed-change banner needs an onAsk callback.');
  if (typeof onReleaseFocus !== 'function') throw new Error('Moontide: the failed-change banner needs an onReleaseFocus callback.');
  if (
    !banner || !evalError || !dismissButton || !detailsToggle || !detailsBox || !copyButton || !copyFailure || !alertRegion ||
    !askButton || !menu || !menuCopy || !menuAsk || !menuDismiss
  ) {
    throw new Error('Moontide: the failed-change banner markup is missing from the page.');
  }
  const lead = banner.querySelector('.problem-lead');
  const consequence = banner.querySelector('.problem-consequence');
  if (!lead || !consequence) {
    throw new Error('Moontide: the failed-change banner markup is missing from the page.');
  }

  // The visible word is short; the accessible name and the title carry the noun (and contain the word).
  dismissButton.textContent = BAR_COPY.dismiss;
  dismissButton.setAttribute('aria-label', BAR_COPY.dismissName);
  dismissButton.setAttribute('title', BAR_COPY.dismissName);
  dismissButton.addEventListener('click', () => hide());
  copyButton.textContent = BAR_COPY.copy;
  copyButton.setAttribute('aria-label', BAR_COPY.copyName);
  copyButton.setAttribute('title', BAR_COPY.copyName);
  copyButton.addEventListener('click', () => copyText());
  askButton.textContent = BAR_COPY.ask;
  askButton.setAttribute('aria-label', BAR_COPY.askName);
  askButton.setAttribute('title', BAR_COPY.askName);
  askButton.addEventListener('click', () => askAbout(askButton.getBoundingClientRect()));
  detailsToggle.addEventListener('click', () => (detailsBox.hidden ? openDetails() : closeDetails()));
  // A button gives up focus after a mouse click (detail > 0) and keeps it after a keyboard activation
  // (detail 0), so the History keys are not held by a button the user only clicked. Runs after the button's own handler.
  banner.addEventListener('click', (event) => {
    if (event.detail <= 0 || !(event.target instanceof Element)) return;
    const button = event.target.closest('button');
    if (button !== null && banner.contains(button)) button.blur();
  });

  // The model that is on screen now; null while the banner is hidden. A Copy that finishes after the banner moved on
  // (dismissed, or replaced by a newer failure) must not write into the new state.
  let current = null;
  let copiedTimer = null;

  function stopCopiedTimer() {
    if (copiedTimer !== null) clearTimer(copiedTimer);
    copiedTimer = null;
    copyButton.textContent = BAR_COPY.copy;
  }

  function openDetails() {
    detailsBox.textContent = current === null ? '' : current.drawn;
    detailsBox.hidden = false;
    detailsToggle.setAttribute('aria-expanded', 'true');
    detailsToggle.textContent = BAR_COPY.detailsHide;
    detailsToggle.setAttribute('aria-label', BAR_COPY.detailsHideName);
    detailsToggle.setAttribute('title', BAR_COPY.detailsHideName);
  }

  function closeDetails() {
    detailsBox.hidden = true;
    detailsBox.textContent = '';
    detailsToggle.setAttribute('aria-expanded', 'false');
    detailsToggle.textContent = BAR_COPY.detailsShow;
    detailsToggle.setAttribute('aria-label', BAR_COPY.detailsShowName);
    detailsToggle.setAttribute('title', BAR_COPY.detailsShowName);
  }

  closeDetails();

  // The popover. The visible words are the whole accessible name here (they already say the noun).
  menu.setAttribute('aria-label', BAR_COPY.menuName);
  menuCopy.textContent = BAR_COPY.menuCopy;
  menuAsk.textContent = BAR_COPY.menuAsk;
  menuDismiss.textContent = BAR_COPY.menuDismiss;

  /** Calls onAsk with the center of the pressed button (its rect) and the uncut message of the banner on screen. */
  function askAbout(rect) {
    if (current === null) return;
    onAsk({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, text: current.full });
  }

  /** When focus is inside the banner or its popover and they are about to disappear, hands it to a stable bar control. */
  function releaseFocus() {
    const active = document.activeElement;
    if (active && (banner.contains(active) || menu.contains(active))) onReleaseFocus();
  }

  /** Opens the popover at the pointer, clamped inside the viewport, and moves focus to its first button. */
  function openMenu(point) {
    if (current === null) return;
    menuAsk.hidden = !current.showAsk;
    menu.hidden = false;
    const view = document.defaultView;
    const rect = menu.getBoundingClientRect();
    const left = Math.max(0, Math.min(point.x, view.innerWidth - rect.width));
    const top = Math.max(0, Math.min(point.y, view.innerHeight - rect.height));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menuCopy.focus();
  }

  /** Closes the popover; with `focusBanner` the focus goes back to the banner (the Esc and the item paths). */
  function closeMenu({ focusBanner = false } = {}) {
    if (menu.hidden) return;
    menu.hidden = true;
    if (focusBanner && !banner.hidden) banner.focus();
  }

  /** An item runs the banner button's action and closes the popover; the focus goes back to the banner first. */
  function chooseItem(button, action) {
    const rect = button.getBoundingClientRect();
    closeMenu({ focusBanner: true });
    action(rect);
  }
  menuCopy.addEventListener('click', () => chooseItem(menuCopy, () => copyText()));
  menuAsk.addEventListener('click', () => chooseItem(menuAsk, askAbout));
  menuDismiss.addEventListener('click', () => chooseItem(menuDismiss, () => hide()));

  // Esc closes the popover only, never the banner, the drawer or an open view.
  menu.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    closeMenu({ focusBanner: true });
  });

  // Focus leaving the popover closes it, unless the window itself lost focus (the midi-view pattern).
  menu.addEventListener('focusout', () => {
    setTimer(() => {
      if (menu.hidden || !document.hasFocus() || menu.contains(document.activeElement)) return;
      closeMenu();
    }, 0);
  });

  // A press outside the popover closes it.
  document.addEventListener(
    'mousedown',
    (event) => {
      if (menu.hidden || (event.target instanceof Node && menu.contains(event.target))) return;
      closeMenu();
    },
    true,
  );

  /** Writes the uncut text. A refusal is shown in the banner, opens Details and is logged; it is never swallowed. */
  async function copyText() {
    const model = current;
    if (model === null) return;
    try {
      await writeText(model.full);
    } catch (err) {
      console.error('Moontide: could not copy the error:', err);
      if (current !== model) return;
      stopCopiedTimer();
      copyFailure.textContent = BAR_COPY.copyFailed;
      copyFailure.hidden = false;
      // The failure is announced like a success is: cleared first so a second refusal is read again.
      alertRegion.textContent = '';
      alertRegion.textContent = BAR_COPY.copyFailed;
      openDetails();
      return;
    }
    if (current !== model) return;
    copyFailure.hidden = true;
    copyFailure.textContent = '';
    stopCopiedTimer();
    copyButton.textContent = BAR_COPY.copied;
    copiedTimer = setTimer(stopCopiedTimer, COPIED_MS);
    alertRegion.textContent = '';
    alertRegion.textContent = BAR_COPY.copiedAnnouncement;
  }

  /** Shows the banner for a model from bannerCopy: kind, lead, consequence (an empty element when none) and the line. */
  function show(model) {
    current = model;
    stopCopiedTimer();
    copyFailure.hidden = true;
    copyFailure.textContent = '';
    // Details is offered for every failed change, and for a notice only when it has more than one line to show.
    detailsToggle.hidden = !(model.kind === 'change' || model.multiline);
    // Ask Claude is offered for a failed change only (a notice has no error context kind).
    askButton.hidden = !model.showAsk;
    // A button that just disappeared must not leave focus on the page body: the banner itself stays and takes it.
    const active = document.activeElement;
    if ((active === detailsToggle && detailsToggle.hidden) || (active === askButton && askButton.hidden)) banner.focus();
    closeMenu();
    closeDetails();
    // The alert region is cleared and then set, so an identical second failure is announced again. Focus never moves.
    alertRegion.textContent = '';
    if (model.alert !== '') alertRegion.textContent = model.alert;
    banner.dataset.kind = model.kind;
    lead.textContent = model.lead;
    consequence.textContent = model.consequence === null ? '' : model.consequence;
    evalError.textContent = model.line;
    // The hover text is what is drawn, so an oversized message cannot become an oversized tooltip.
    evalError.setAttribute('title', model.drawn);
    evalError.hidden = false;
    banner.hidden = false;
  }

  /** Hides the banner and the error line. Nothing else changes: the music, the word and the tempo are not this view's. */
  function hide() {
    releaseFocus();
    current = null;
    closeMenu();
    stopCopiedTimer();
    copyFailure.hidden = true;
    copyFailure.textContent = '';
    closeDetails();
    alertRegion.textContent = '';
    banner.hidden = true;
    evalError.hidden = true;
    evalError.textContent = '';
    evalError.removeAttribute('title');
  }

  return {
    show,
    hide,
    isShown: () => !banner.hidden,
    contains: (node) => banner.contains(node),
    openMenu,
    closeMenu,
    menuContains: (node) => menu.contains(node),
  };
}
