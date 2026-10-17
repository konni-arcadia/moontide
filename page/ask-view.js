// The Ask Claude box's DOM: the small box a right-click opens near the pointer, its
// chips, its field, its message line and the top-bar page-requests
// status (whether page requests reach Claude live) with its (i) button and the
// short popover the (i) opens, and a refused page token on the top-bar error line as soon as the
// server says so. Every text reaches the page through
// textContent, title, placeholder or setAttribute, never as markup: the chips carry names and code
// written by a person or by Claude. No DOM access at import time: main.js calls createAskView() with
// its document and a send function. The pure rules (copy, limits, placement) live in page/ask.js. What became of
// each request is the Requests list's business (page/request-status-view.js): this module hands every request and
// every answer to the request tracker, and shows only the line under the Parts button.

import {
  ASK_COPY,
  BOX_GAP_REM,
  MAX_ASK_TEXT_LENGTH,
  PAGE_REQUESTS_COPY,
  pageRequestsText,
  askMessage,
  askTextProblem,
  cutText,
  describeContext,
  fitGestureToLine,
  fitMomentToLine,
  newAskId,
  partsAskState,
  placeBox,
  refusalText,
  requestFitsLine,
} from './ask.js';

/**
 * Creates the box controller. `document` is the page's document (named so on purpose: every element
 * lookup below reads `document.getElementById`, the shape test/page-hidden.test.js scans); `send`
 * sends one JSON-able message to the server; `reportError` and `clearError` write and clear the
 * top-bar error line; `setTimer`, `clearTimer` and `now` are the page's clock. `requests` is the per-request tracker
 * of page/request-status.js: every request sent is handed to it, and so is every server answer to one. The tracker
 * tells the page (main.js) when a request was never confirmed; the page then calls `notConfirmed(id)` here.
 */
export function createAskView({ document, send, reportError, clearError, setTimer, clearTimer, now, requests }) {
  const askBox = document.getElementById('ask-box');
  const askContextChip = document.getElementById('ask-context-chip');
  const askCurrentChip = document.getElementById('ask-current-chip');
  const askField = document.getElementById('ask-field');
  const askMessageEl = document.getElementById('ask-message');
  const askHint = document.getElementById('ask-hint');
  const partsAsk = document.getElementById('parts-ask');
  const partsAskStatus = document.getElementById('parts-ask-status');
  const pageRequests = document.getElementById('page-requests');
  const pageRequestsState = document.getElementById('page-requests-state');
  const pageRequestsInfo = document.getElementById('page-requests-info');
  const pageRequestsHelp = document.getElementById('page-requests-help');
  if (
    !askBox ||
    !askContextChip ||
    !askCurrentChip ||
    !askField ||
    !askMessageEl ||
    !askHint ||
    !partsAsk ||
    !partsAskStatus ||
    !pageRequests ||
    !pageRequestsState ||
    !pageRequestsInfo ||
    !pageRequestsHelp
  ) {
    throw new Error('Moontide: the Ask Claude markup is missing from the page.');
  }
  if (requests === undefined || typeof requests.sent !== 'function' || typeof requests.serverMessage !== 'function') {
    throw new Error('Moontide: createAskView needs the request tracker.');
  }

  // The field's description lists the message line only while it shows, so it is never empty.
  const DESCRIBED_WITH_MESSAGE = 'ask-context-chip ask-message ask-hint';
  const DESCRIBED_WITHOUT_MESSAGE = 'ask-context-chip ask-hint';

  askBox.setAttribute('aria-label', ASK_COPY.boxLabel);
  askField.setAttribute('aria-label', ASK_COPY.fieldLabel);
  askField.setAttribute('placeholder', ASK_COPY.placeholder);
  askHint.textContent = ASK_COPY.hint;
  partsAsk.textContent = ASK_COPY.partsAsk;
  pageRequestsInfo.textContent = PAGE_REQUESTS_COPY.infoText;
  pageRequestsInfo.setAttribute('aria-label', PAGE_REQUESTS_COPY.infoLabel);
  pageRequestsInfo.setAttribute('title', PAGE_REQUESTS_COPY.infoLabel);
  pageRequestsHelp.setAttribute('aria-label', PAGE_REQUESTS_COPY.infoLabel);
  // The popover's text, built once: a paragraph per step, each command in its own code element.
  for (const parts of [
    [PAGE_REQUESTS_COPY.helpIntro],
    [PAGE_REQUESTS_COPY.appText],
    [
      PAGE_REQUESTS_COPY.onLead,
      { code: PAGE_REQUESTS_COPY.onCommand },
      PAGE_REQUESTS_COPY.onRest,
      { code: PAGE_REQUESTS_COPY.offCommand },
      PAGE_REQUESTS_COPY.offRest,
    ],
    [PAGE_REQUESTS_COPY.monitorText],
  ]) {
    const paragraph = document.createElement('p');
    parts.forEach((part, index) => {
      if (index > 0) paragraph.appendChild(document.createTextNode(' '));
      if (typeof part === 'string') {
        paragraph.appendChild(document.createTextNode(part));
      } else {
        const code = document.createElement('code');
        code.textContent = part.code;
        paragraph.appendChild(code);
      }
    });
    pageRequestsHelp.appendChild(paragraph);
  }

  let connected = false;
  // The version id the top bar shows, or null before any version.
  let currentVersion = null;
  // What the right-click pointed at, snapshotted when the box opened: { context, chip } and, when the
  // Timeline showed the music there, the moment captured at the click, and, when a gesture on a note opened the box,
  // that gesture; for a range, the cycles it was cut to when the pointer left the page (`rangeCut`).
  let snapshot = null;
  // The last request sent: { id, text }, so an accepted request clears its own draft.
  let lastSent = null;
  // True after a refusal or a lost confirmation, until the next send: the draft came back.
  let notSent = false;
  let tokenRefused = false;
  // The server refused this page's token at connect; true for the life of the page (it never
  // re-authenticates without a reload).
  let authRefused = false;
  // Where focus was before the box opened, so closing gives it back.
  let returnFocusTo = null;
  let counter = 0;
  // Where the box was last placed from, so a window resize can run the same rules again.
  let lastPoint = null;
  // The side the box opened on (above the pointer or below), kept while its height changes; null
  // means choose again.
  let placedAbove = null;
  // The Parts view's button: whether the code has no sections (so the button shows) and the id of its
  // request while it waits for Claude to take it.
  let partsAvailable = false;
  let partsPendingId = null;

  /** The fields of the request the box would send for `text` (trimmed), the id measured with the next one's shape. */
  function requestFields(text) {
    return {
      id: newAskId(counter + 1, now()),
      text,
      context: snapshot.context,
      chip: snapshot.chip,
      current: currentVersion,
      moment: snapshot.moment,
      gesture: snapshot.gesture,
    };
  }

  /** True when the text is within the character limit but its line cannot fit, whatever the moment is cut to. */
  function lineTooLong() {
    const text = askField.value.trim();
    return snapshot !== null && text !== '' && text.length <= MAX_ASK_TEXT_LENGTH && !requestFitsLine(requestFields(text));
  }

  function renderMessage() {
    const length = askField.value.trim().length;
    const tooLongLine = lineTooLong();
    const text = askMessage({ connected, length, notSent, tokenRefused, lineTooLong: tooLongLine, rangeCut: snapshot === null ? null : (snapshot.rangeCut ?? null) });
    askMessageEl.textContent = text ?? '';
    askMessageEl.hidden = text === null;
    askField.setAttribute('aria-describedby', askMessageEl.hidden ? DESCRIBED_WITHOUT_MESSAGE : DESCRIBED_WITH_MESSAGE);
    if (askTextProblem(askField.value) === 'too-long' || tooLongLine) askField.setAttribute('aria-invalid', 'true');
    else askField.removeAttribute('aria-invalid');
    // A message line appearing or leaving changes the box's height.
    refit();
  }

  /** The state phrase of the Parts request's row in the Requests list, or null when it has no row. */
  function partsRowPhrase() {
    if (partsPendingId === null) return null;
    const model = requests.model();
    const row = [...model.rows, ...model.recent].find((candidate) => candidate.id === partsPendingId);
    return row === undefined ? null : row.phrase;
  }

  /** The Parts button and the line under it, from partsAskState. */
  function renderPartsAsk() {
    partsAsk.hidden = !partsAvailable;
    if (!partsAvailable) {
      partsAskStatus.textContent = '';
      partsAskStatus.hidden = true;
      return;
    }
    const state = partsAskState({ connected, pending: partsPendingId !== null, statusText: partsRowPhrase() });
    partsAsk.disabled = state.disabled;
    partsAskStatus.textContent = state.line ?? '';
    partsAskStatus.hidden = state.line === null;
  }

  /** The field is as tall as its text, up to its six-line max-height; beyond that it scrolls inside itself. */
  function growField() {
    if (askBox.hidden) return;
    const style = document.defaultView.getComputedStyle(askField);
    const maxPx = parseFloat(style.maxHeight);
    const borderPx = (parseFloat(style.borderTopWidth) || 0) + (parseFloat(style.borderBottomWidth) || 0);
    askField.style.height = 'auto';
    const wanted = askField.scrollHeight + borderPx;
    askField.style.height = `${Number.isFinite(maxPx) ? Math.min(wanted, maxPx) : wanted}px`;
  }

  /**
   * Puts the box near the pointer. The side (above or below) is chosen from the box's height at six
   * field lines when placedAbove is null, then kept; the edge next to the pointer stays while the
   * box's height changes, so a box above the pointer grows upward.
   */
  function place(point) {
    lastPoint = point;
    const view = document.defaultView;
    const rootFontPx = parseFloat(view.getComputedStyle(document.documentElement).fontSize) || 16;
    const gap = BOX_GAP_REM * rootFontPx;
    const boxRect = askBox.getBoundingClientRect();
    const fieldRect = askField.getBoundingClientRect();
    const fieldMaxPx = parseFloat(view.getComputedStyle(askField).maxHeight) || fieldRect.height;
    const { left, top, above } = placeBox({
      pointerX: point.x,
      pointerY: point.y,
      boxWidth: boxRect.width,
      boxHeight: boxRect.height,
      maxBoxHeight: boxRect.height - fieldRect.height + fieldMaxPx,
      viewportWidth: view.innerWidth,
      viewportHeight: view.innerHeight,
      margin: gap,
      offset: gap,
      above: placedAbove ?? undefined,
    });
    placedAbove = above;
    askBox.style.left = `${left}px`;
    askBox.style.top = `${top}px`;
  }

  /** After any height change of the open box: grow the field, then place the box again on its kept side. */
  function refit() {
    if (askBox.hidden || lastPoint === null) return;
    growField();
    place(lastPoint);
  }

  /**
   * Puts a prefill in the field (a failed change sent to Claude). An empty field is simply filled. A field that
   * already holds a draft keeps it: the prefill follows after a blank line, cut so the whole field stays within
   * MAX_ASK_TEXT_LENGTH, and is not added again when the draft already ends with it. The caret goes to the end so the
   * user types the question after it. When the draft leaves no room at all, the draft stays as it is (the chip still
   * names the error).
   */
  function applyPrefill(prefill) {
    const draft = askField.value;
    if (draft === '') {
      askField.value = prefill;
    } else if (draft.endsWith(prefill)) {
      // The request is already there (the same target was asked about twice, or the browser raised a right-click after
      // a key press that had already opened the box): it is not added a second time.
    } else {
      const room = MAX_ASK_TEXT_LENGTH - draft.length - 2;
      if (room < 1) return;
      askField.value = `${draft}\n\n${cutText(prefill, room)}`;
    }
    askField.setSelectionRange(askField.value.length, askField.value.length);
  }

  /**
   * Opens the box for what was right-clicked, or moves it when it is already open (text and caret stay). With
   * `{ prefill }` the field also receives that text (see applyPrefill); without it nothing about the field changes.
   */
  function open(descriptor, point, { prefill } = {}) {
    const { context, chip, moment, gesture, rangeCut } = describeContext(descriptor);
    snapshot = { context, chip, ...(moment === undefined ? {} : { moment }), ...(gesture === undefined ? {} : { gesture }), ...(rangeCut === undefined ? {} : { rangeCut }) };
    askContextChip.textContent = chip;
    askContextChip.setAttribute('title', chip);
    const wasHidden = askBox.hidden;
    if (wasHidden) {
      returnFocusTo = document.activeElement;
      askBox.hidden = false;
    }
    // A new pointer chooses its side again; renderMessage measures the box with its message line.
    lastPoint = point;
    placedAbove = null;
    if (prefill !== undefined) applyPrefill(prefill);
    renderMessage();
    askField.focus();
    if (prefill !== undefined) {
      askField.setSelectionRange(askField.value.length, askField.value.length);
      // A long prefill scrolls inside the field: show the end, where the question goes.
      askField.scrollTop = askField.scrollHeight;
    } else if (wasHidden && askField.value !== '') askField.select();
    // A successful evaluation may have cleared the token line: keep the reason on screen whenever the
    // user starts to ask.
    if (authRefused) reportError(ASK_COPY.token);
  }

  /**
   * Closes the box; the field text stays as the draft. Focus goes back to where it was unless the
   * user already moved it somewhere else (`restoreFocus: false`).
   */
  function close({ restoreFocus = true } = {}) {
    if (askBox.hidden) return;
    askBox.hidden = true;
    const target = returnFocusTo;
    returnFocusTo = null;
    if (restoreFocus && target && target.isConnected && typeof target.focus === 'function') target.focus();
  }

  /** Sends one ask with the current version and starts its status; returns the request id. */
  function transmit(text, describedContext) {
    const id = newAskId(++counter, now());
    const frame = { type: 'ask', id, text, context: describedContext.context, chip: describedContext.chip, current: currentVersion };
    // The moment rides after `current`, and only when there is one: a frame without it is as it always was.
    // Notes come off its end until the whole line fits what the server takes (the rest counts in `more`).
    const fields = { ...frame, moment: describedContext.moment, gesture: describedContext.gesture };
    const moment = fitMomentToLine(fields);
    if (moment !== undefined) frame.moment = moment;
    // The gesture follows the moment, and only when the box was opened by one. The notes of a range gesture come off its end the
    // same way; any other gesture is sent as it is.
    const gesture = fitGestureToLine({ ...fields, moment });
    if (gesture !== undefined) frame.gesture = gesture;
    send(frame);
    // While the token is refused the line stays: the server's 'token' refusal writes it again, so it never blinks off.
    if (!authRefused) clearError();
    requests.sent(id, { text, chip: describedContext.chip });
    return id;
  }

  function submit() {
    const problem = askTextProblem(askField.value);
    if (problem === 'empty') return;
    if (problem === 'too-long' || !connected || lineTooLong()) {
      // Nothing is sent; the message line says why (the counter, the line that cannot fit, or the disconnected copy).
      renderMessage();
      return;
    }
    const text = askField.value.trim();
    notSent = false;
    tokenRefused = false;
    close();
    lastSent = { id: transmit(text, snapshot), text };
    renderMessage();
  }

  askField.addEventListener('keydown', (event) => {
    if (event.isComposing) return;
    if (event.key === 'Enter' && !event.shiftKey) {
      // The History view must never see this Enter, even after focus moves back to a row.
      event.preventDefault();
      event.stopPropagation();
      // A held key that opened the box (the auto-repeat lands here once focus has moved) must not also send what is in it.
      if (event.repeat) return;
      submit();
    } else if (event.key === 'Escape') {
      // Esc closes the box only, never an open view.
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  });

  // renderMessage grows the field and places the box again.
  askField.addEventListener('input', () => {
    renderMessage();
  });

  // Tab away or a click elsewhere closes the box and keeps the draft; switching to another app
  // (the document loses focus as a whole) leaves it open. Focus is checked after the event settles.
  askBox.addEventListener('focusout', () => {
    setTimer(() => {
      if (askBox.hidden || !document.hasFocus() || askBox.contains(document.activeElement)) return;
      close({ restoreFocus: false });
    }, 0);
  });

  // The page-requests (i) and its popover: the Ask box's non-modal pattern (focus moves in on open
  // and back to (i) on close; it closes when focus leaves it unless the window itself lost focus)
  // plus the Mixer "Add effect" list's Escape rule (Escape closes only the popover, never a view).
  function openHelp() {
    pageRequestsHelp.hidden = false;
    pageRequestsInfo.setAttribute('aria-expanded', 'true');
    // Focus inside, so a click in the popover (to select a command) keeps it open.
    pageRequestsHelp.focus();
  }

  function closeHelp({ focusInfo = false } = {}) {
    if (pageRequestsHelp.hidden) return;
    pageRequestsHelp.hidden = true;
    pageRequestsInfo.setAttribute('aria-expanded', 'false');
    if (focusInfo) pageRequestsInfo.focus();
  }

  // Keeps focus where it is on a press (the main.js mousedown precedent), so a second click toggles
  // the popover closed instead of the focusout closing it first and the click opening it again.
  pageRequestsInfo.addEventListener('mousedown', (event) => event.preventDefault());
  pageRequestsInfo.addEventListener('click', () => {
    if (pageRequestsHelp.hidden) openHelp();
    else closeHelp({ focusInfo: true });
  });

  const onHelpKeydown = (event) => {
    if (event.key !== 'Escape' || pageRequestsHelp.hidden) return;
    // Esc closes the popover only, never an open view.
    event.preventDefault();
    event.stopPropagation();
    closeHelp({ focusInfo: true });
  };
  pageRequestsInfo.addEventListener('keydown', onHelpKeydown);
  pageRequestsHelp.addEventListener('keydown', onHelpKeydown);

  // Tab away or a click elsewhere closes it; switching to another app leaves it open.
  const onHelpFocusout = () => {
    setTimer(() => {
      if (pageRequestsHelp.hidden || !document.hasFocus()) return;
      const active = document.activeElement;
      if (active === pageRequestsInfo || pageRequestsHelp.contains(active)) return;
      closeHelp();
    }, 0);
  };
  pageRequestsInfo.addEventListener('focusout', onHelpFocusout);
  pageRequestsHelp.addEventListener('focusout', onHelpFocusout);

  // A resize runs the placement rules again from the same pointer, side included.
  document.defaultView.addEventListener('resize', () => {
    placedAbove = null;
    refit();
  });

  // The Parts view's button: one canned request about the whole session, through the same channel.
  partsAsk.addEventListener('click', () => {
    if (partsAsk.disabled || partsPendingId !== null || !connected) return;
    partsPendingId = transmit(ASK_COPY.partsRequest, describeContext({ kind: 'session' }));
    renderPartsAsk();
  });

  /** The server's answers: token result, one result per request, and hand-overs of waiting requests. */
  function onServerMessage(msg) {
    if (msg.type === 'ask-auth') {
      authRefused = !msg.ok;
      if (!msg.ok) {
        console.error(
          "Moontide: the server refused this page's token; requests to Claude will be refused until the page is reloaded.",
        );
        reportError(ASK_COPY.token);
      }
      return;
    }
    if (msg.type === 'page-requests') {
      // Hidden until the server says the state: the page cannot know it before.
      try {
        pageRequestsState.textContent = pageRequestsText(msg.live);
        pageRequests.hidden = false;
      } catch (error) {
        console.error(error);
      }
      return;
    }
    if (msg.type === 'ask-received') {
      requests.serverMessage(msg);
      if (partsPendingId !== null && msg.ids.includes(partsPendingId)) partsPendingId = null;
      renderPartsAsk();
      return;
    }
    if (msg.type !== 'ask-result') return;
    requests.serverMessage(msg);
    const fromParts = msg.id === partsPendingId;
    if (msg.status === 'refused') {
      reportError(refusalText(msg.reason, msg.detail));
      if (fromParts) {
        partsPendingId = null;
      } else {
        notSent = true;
        tokenRefused = msg.reason === 'token';
      }
    } else if (fromParts) {
      if (msg.status === 'received') partsPendingId = null;
    } else if (lastSent !== null && msg.id === lastSent.id && askField.value.trim() === lastSent.text) {
      // The server accepted the request: the draft is gone.
      askField.value = '';
      growField();
    }
    renderMessage();
    renderPartsAsk();
  }

  /**
   * The tracker gave up on request `id`: the server never confirmed it, or the connection closed first. The error line
   * says so, and the draft comes back (or, for the Parts button's canned request, the button is released).
   */
  function notConfirmed(id) {
    reportError(ASK_COPY.didNotConfirm);
    if (id === partsPendingId) {
      // The canned request needs no draft: the button just comes back.
      partsPendingId = null;
      renderPartsAsk();
      return;
    }
    notSent = true;
    renderMessage();
  }

  function setConnected(state) {
    connected = state === 'connected';
    if (state === 'disconnected') {
      partsPendingId = null;
      // The state is unknown once the socket is gone (the page does not reconnect by itself).
      pageRequests.hidden = true;
      closeHelp();
    }
    renderMessage();
    renderPartsAsk();
  }

  /** The Parts view shows the button only while the code has no sections. */
  function setPartsAvailable(available) {
    partsAvailable = available;
    renderPartsAsk();
  }

  function setCurrentVersion(id) {
    currentVersion = typeof id === 'number' ? id : null;
    askCurrentChip.textContent = currentVersion === null ? '' : `${ASK_COPY.currentChip}${currentVersion}`;
    askCurrentChip.hidden = currentVersion === null;
    // A longer chip can wrap and change the box's height.
    refit();
  }

  return {
    open,
    close,
    /** Closes the page-requests (i) popover if it is open (the Session drawer calls it when it opens); focus stays where it is. */
    closeHelp: () => closeHelp(),
    isOpen: () => !askBox.hidden,
    contains: (node) => askBox.contains(node),
    setConnected,
    setCurrentVersion,
    setPartsAvailable,
    onServerMessage,
    notConfirmed,
    /** Draws the line under the Parts button again from its request's row; the page calls it after every tracker change. */
    refreshPartsLine: () => renderPartsAsk(),
  };
}
