// The MIDI part of the page: the segment a tab shows after it lost the active role to another Moontide
// tab ("Moontide is playing in another tab") and its button "Play in this tab", and the top-bar
// port indicator with its dots and its (i) popover, and the return banner. Every text reaches the page through textContent, title and
// setAttribute, never as markup. No DOM access at import time: main.js calls createMidiView() with its
// document and the click handler. The copy and the pure model live in page/midi-plan.js.

import { createBannerTimer, MIDI_BANNER_FADE_OUT_MS, MIDI_COPY } from './midi-plan.js';

/** The dot kinds the view can draw (the model's `dots[].kind`); any other kind throws. */
const DOT_KINDS = ['filled', 'hollow', 'off'];

/**
 * Creates the view. `document` is the page's document (named so on purpose: every element lookup below
 * reads `document.getElementById`, the shape test/page-hidden.test.js scans); `onTakeBack` runs on every
 * click of the button (a native button, so Enter and Space work too); `setTimer` is the page's timer (the
 * popover's focusout check runs on the next tick, like the page-requests one); `clearTimer` cancels one;
 * `isMotionOn` says whether the banner fades out (motion on) or is simply gone (motion off).
 */
export function createMidiView({ document, onTakeBack, setTimer, clearTimer, isMotionOn }) {
  const midiTakeover = document.getElementById('midi-takeover');
  const midiTakeoverText = document.getElementById('midi-takeover-text');
  const takeBack = document.getElementById('take-back');
  const midiState = document.getElementById('midi-state');
  const midiDots = document.getElementById('midi-dots');
  const midiStateText = document.getElementById('midi-state-text');
  const midiInfo = document.getElementById('midi-info');
  const midiHelp = document.getElementById('midi-help');
  const midiBanner = document.getElementById('midi-banner');
  const midiBannerText = document.getElementById('midi-banner-text');
  const midiBannerDismiss = document.getElementById('midi-banner-dismiss');
  if (!midiTakeover || !midiTakeoverText || !takeBack || !midiState || !midiDots || !midiStateText || !midiInfo || !midiHelp || !midiBanner || !midiBannerText || !midiBannerDismiss) {
    throw new Error('Moontide: the MIDI markup is missing from the page.');
  }

  midiTakeoverText.textContent = MIDI_COPY.takeoverText;
  takeBack.textContent = MIDI_COPY.takeBack;
  takeBack.addEventListener('click', () => onTakeBack());
  midiInfo.textContent = MIDI_COPY.infoText;
  midiInfo.setAttribute('aria-label', MIDI_COPY.infoLabel);
  midiInfo.setAttribute('title', MIDI_COPY.infoLabel);
  midiHelp.setAttribute('aria-label', MIDI_COPY.helpLabel);
  midiBannerDismiss.textContent = MIDI_COPY.bannerDismiss;

  // What the indicator shows now, so only what changed is written (no rebuild on every render).
  let shownText = null;
  let shownTitle = null;
  let shownDots = null;

  /** The text of the indicator, written only when it differs. */
  function setText(text, title) {
    if (text !== shownText) {
      midiStateText.textContent = text;
      shownText = text;
    }
    if (title !== shownTitle) {
      midiState.setAttribute('title', title);
      shownTitle = title;
    }
  }

  /**
   * One span per dot, rebuilt only when the list changed. A filled dot is a connected port, a hollow ring a missing
   * one, a crossed grey dot an instrument switched off. A dot without one of these kinds throws.
   */
  function setDots(dots) {
    const key = JSON.stringify(dots);
    if (key === shownDots) return;
    midiDots.replaceChildren(
      ...dots.map((dot) => {
        if (!DOT_KINDS.includes(dot.kind)) throw new Error('Moontide: a MIDI dot needs a kind of filled, hollow or off.');
        const span = document.createElement('span');
        span.className = 'state-dot midi-dot';
        span.dataset.kind = dot.kind;
        span.setAttribute('title', dot.title);
        return span;
      }),
    );
    shownDots = key;
    midiDots.hidden = dots.length === 0;
  }

  // The popover content on screen, as JSON, so it is rebuilt only when it changed (also while open).
  let shownPopover = null;

  function paragraph(text, className) {
    const element = document.createElement('p');
    element.textContent = text;
    if (className !== undefined) element.className = className;
    return element;
  }

  function codeElement(text) {
    const element = document.createElement('code');
    element.textContent = text;
    return element;
  }

  /**
   * One row of the popover: `{ text }` is a plain line ("and N more"); `{ name, port, stateText }` is an
   * instrument (its id and its port each in a code element); `{ name, stateText }` is a port or a problem
   * of the setup file. The text of the setup file is user-controlled, so it goes in as text only.
   */
  function rowItem(row) {
    const item = document.createElement('li');
    if (typeof row.text === 'string') {
      item.textContent = row.text;
      return item;
    }
    const separator = MIDI_COPY.rowSeparator;
    if (typeof row.port === 'string') {
      item.append(codeElement(row.name), document.createTextNode(separator), codeElement(row.port), document.createTextNode(`${separator}${row.stateText}`));
    } else {
      item.append(codeElement(row.name), document.createTextNode(`${separator}${row.stateText}`));
    }
    return item;
  }

  /** Builds the popover from created elements only: paragraphs, a list with a code element per port name. */
  function setPopover(popover) {
    const key = JSON.stringify(popover);
    if (key === shownPopover) return;
    shownPopover = key;
    const nodes = [paragraph(popover.lead)];
    if (popover.rows.length > 0) {
      const list = document.createElement('ul');
      for (const row of popover.rows) list.appendChild(rowItem(row));
      nodes.push(list);
    }
    if (popover.outputsLine !== null) nodes.push(paragraph(popover.outputsLine, 'midi-outputs'));
    if (typeof popover.note === 'string') nodes.push(paragraph(popover.note, 'midi-outputs'));
    if (typeof popover.clockNote === 'string') nodes.push(paragraph(popover.clockNote, 'midi-outputs'));
    if (typeof popover.offNote === 'string') nodes.push(paragraph(popover.offNote, 'midi-outputs'));
    nodes.push(paragraph(popover.closing));
    midiHelp.replaceChildren(...nodes);
  }

  // The (i) and its popover: the page-requests non-modal pattern (page/ask-view.js). Focus moves in on
  // open and back to the (i) on Esc; focus leaving closes it, unless the window itself lost focus.
  function openHelp() {
    midiHelp.hidden = false;
    midiInfo.setAttribute('aria-expanded', 'true');
    midiHelp.focus();
  }

  function closeHelp({ focusInfo = false } = {}) {
    if (midiHelp.hidden) return;
    midiHelp.hidden = true;
    midiInfo.setAttribute('aria-expanded', 'false');
    if (focusInfo) midiInfo.focus();
  }

  // Keeps the editor's focus on a press, so a second click toggles the popover closed instead of the
  // focusout closing it first and the click opening it again.
  midiInfo.addEventListener('mousedown', (event) => event.preventDefault());
  midiInfo.addEventListener('click', () => {
    if (midiHelp.hidden) openHelp();
    else closeHelp({ focusInfo: true });
  });

  const onHelpKeydown = (event) => {
    if (event.key !== 'Escape' || midiHelp.hidden) return;
    // Esc closes the popover only, never an open view.
    event.preventDefault();
    event.stopPropagation();
    closeHelp({ focusInfo: true });
  };
  midiInfo.addEventListener('keydown', onHelpKeydown);
  midiHelp.addEventListener('keydown', onHelpKeydown);

  const onHelpFocusout = () => {
    setTimer(() => {
      if (midiHelp.hidden || !document.hasFocus()) return;
      const active = document.activeElement;
      if (active === midiInfo || midiHelp.contains(active)) return;
      closeHelp();
    }, 0);
  };
  midiInfo.addEventListener('focusout', onHelpFocusout);
  midiHelp.addEventListener('focusout', onHelpFocusout);

  // The return banner. It never takes focus and floats over the page (position: fixed), so nothing
  // moves when it opens. It fades by itself after 20 s, paused while the pointer is over it or focus is
  // inside it; Dismiss and Esc hide it; with motion on it fades out over 150 ms first.
  let leavingTimer = null;

  function finishHide() {
    leavingTimer = null;
    midiBanner.hidden = true;
    delete midiBanner.dataset.leaving;
  }

  function hideReturnBanner() {
    bannerTimer.stop();
    if (midiBanner.hidden) return;
    if (leavingTimer !== null) return;
    if (isMotionOn()) {
      midiBanner.dataset.leaving = 'true';
      leavingTimer = setTimer(finishHide, MIDI_BANNER_FADE_OUT_MS);
      return;
    }
    finishHide();
  }

  const bannerTimer = createBannerTimer({ setTimer, clearTimer, onExpire: hideReturnBanner });

  /** Shows the banner with `text` without moving focus; a second call replaces the text and restarts the 20 s. */
  function showReturnBanner(text) {
    if (leavingTimer !== null) {
      clearTimer(leavingTimer);
      leavingTimer = null;
      delete midiBanner.dataset.leaving;
    }
    midiBannerText.textContent = text;
    midiBanner.hidden = false;
    bannerTimer.start();
  }

  /** Removes the banner at once, with no fade (the tab was superseded or the socket closed). */
  function dropReturnBanner() {
    bannerTimer.stop();
    if (leavingTimer !== null) clearTimer(leavingTimer);
    finishHide();
  }

  midiBannerDismiss.addEventListener('click', hideReturnBanner);
  midiBanner.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || midiBanner.hidden) return;
    // Esc closes the banner only, never an open view.
    event.preventDefault();
    event.stopPropagation();
    hideReturnBanner();
  });
  midiBanner.addEventListener('pointerenter', () => bannerTimer.pause('pointer'));
  midiBanner.addEventListener('pointerleave', () => bannerTimer.resume('pointer'));
  midiBanner.addEventListener('focusin', () => bannerTimer.pause('focus'));
  midiBanner.addEventListener('focusout', () => bannerTimer.resume('focus'));

  /** The indicator goes away, and its popover with it. */
  function hideIndicator() {
    midiState.hidden = true;
    closeHelp();
  }

  /** The button reads "Play in this tab" and can be clicked, or reads "Taking over…" and cannot. */
  function setTakeBackPending(pending) {
    takeBack.textContent = pending ? MIDI_COPY.takingOver : MIDI_COPY.takeBack;
    takeBack.disabled = pending;
  }

  return {
    /** Shows the indicator from `model` (page/midi-plan.js indicatorModel), or hides it. No animation. */
    render(model) {
      if (!model.visible) {
        hideIndicator();
        return;
      }
      setText(model.text, model.title);
      if (model.attention) midiState.dataset.attention = 'true';
      else delete midiState.dataset.attention;
      setDots(model.dots);
      setPopover(model.popover);
      midiState.hidden = false;
    },
    /** The socket state: anything but 'connected' hides the indicator (the last facts are stale then). */
    setConnected(state) {
      if (state === 'connected') return;
      hideIndicator();
      dropReturnBanner();
    },
    /** Closes the (i) popover if it is open (the Session drawer calls it when it opens); focus stays where it is. */
    closeHelp: () => closeHelp(),
    showReturnBanner,
    hideReturnBanner,
    /** Sets the tab title, only when it differs. */
    setTitle(text) {
      if (document.title !== text) document.title = text;
    },
    /** This tab lost the active role: the segment shows, with the button ready. */
    showSuperseded() {
      setTakeBackPending(false);
      hideIndicator();
      dropReturnBanner();
      midiTakeoverText.textContent = MIDI_COPY.takeoverText;
      midiTakeover.hidden = false;
    },
    /** The segment of a superseded tab after the active tab went away: no tab plays, the button stays. */
    showNoActivePage() {
      midiTakeoverText.textContent = MIDI_COPY.noActiveText;
    },
    /** This tab is the active page again (or never lost the role): the segment hides. */
    hideSuperseded() {
      midiTakeover.hidden = true;
      midiTakeoverText.textContent = MIDI_COPY.takeoverText;
      setTakeBackPending(false);
    },
    setTakeBackPending,
  };
}
