// What became of each request the user sent from this page. A pure module: no DOM access at import or anywhere
// else, and every clock is injected (page/main.js passes Date.now and setTimeout, the tests pass a fake time).
// The server says what it knows (src/request-status.ts, src/protocol.ts: ask-result, ask-received, ask-status and
// ask-board); this tracker keeps one row per request id, moves a row only forward, and words each state. The view
// (page/request-status-view.js) draws the model and never decides anything.
//
// The page says what it observed, never more: Applied and Waiting for its line come only from a message that links
// a change to the request, and a request nobody answers is "No change yet", never a failure.

import { ASK_CONFIRM_TIMEOUT_MS, refusalText } from './ask.js';

/** After this long without news a request that is not at its line and not finished reads "No change yet". */
export const QUIET_AFTER_MS = 30000;

/** A finished request stays in the list this long, then moves to the Recent group. */
export const FINISHED_SHOWN_MS = 30000;

/** How many finished requests the Recent group keeps; the oldest drops off the page. */
export const RECENT_MAX = 5;

/** A request's row text: its first characters (by code point), then an ellipsis. */
export const ROW_TEXT_MAX = 40;

/** A failure reason in a row: its first line, cut here. */
export const REASON_ROW_MAX = 80;

/** A request's text inside a spoken sentence. */
export const LIVE_TEXT_MAX = 40;

/** At most this many sentences are spoken together; the rest are counted. */
export const LIVE_JOIN_MAX = 3;

/** The request text in an opened row's detail. */
export const DETAIL_TEXT_MAX = 200;

/**
 * Whether the page shows what only a change that names its request can say: Waiting for its line, Applied as vN,
 * Failed, Replaced and Canceled. True because it was measured in fresh Claude sessions before this shipped: Claude
 * named the request in at least four of five changes made for a request. A state that is not promised is never
 * shown: its message is ignored with one console line and the row stays on its last honest state.
 */
export const LINK_PROMISED = true;

/**
 * Whether the page shows what only the closing tool can say: Answered and Declined with Claude's sentence. True
 * because it was measured in fresh Claude sessions before this shipped: Claude closed at least four of five
 * requests that needed no change to the music.
 */
export const CLOSE_PROMISED = true;

/** The states the server names, in the order a request moves through them. page/request-status.js mirrors src/request-status.ts by hand. */
export const SERVER_REQUEST_STATES = Object.freeze([
  'sent',
  'waiting',
  'received',
  'started',
  'line',
  'applied',
  'failed',
  'replaced',
  'canceled',
  'answered',
  'declined',
]);

/** The states that only a message linking a change to the request can bring. */
export const LINK_STATES = Object.freeze(['line', 'applied', 'failed', 'replaced', 'canceled']);

/** The states that only the closing tool can bring. */
export const CLOSE_STATES = Object.freeze(['answered', 'declined']);

// Rows end in one of these; nothing follows. notsent and lost are the page's own: the server refused or never
// confirmed the request, or the connection closed while it was open.
const FINAL_STATES = Object.freeze(['applied', 'failed', 'replaced', 'canceled', 'answered', 'declined', 'notsent', 'lost']);

const ORDER = Object.freeze(['sent', 'waiting', 'received', 'started', 'line']);

/** The one copy object of the Requests list. Words in braces are filled by fill(). */
export const REQUEST_STATUS_COPY = Object.freeze({
  chipWord: 'Requests',
  chipTitle: 'Requests sent from this page',
  chipNameNone: 'Requests, none in flight',
  chipNameFlight: 'Requests, {n} in flight',
  panelName: 'Requests',
  recentHead: 'Recent · {n}',
  recentName: 'Recent requests, {n}',
  recentOpen: '▾',
  recentFolded: '▸',
  notConfirmed: 'Moontide did not confirm the request.',
  startedBasis: 'Claude made a call after this request arrived.',
  basisLead: 'Basis: ',
  phrases: Object.freeze({
    sent: 'Sent',
    received: 'Received',
    waiting: "Waiting for Claude's next action",
    started: 'Claude has started on it',
    line: 'Waiting for its line',
    applied: 'Applied as v{n}',
    appliedNoVersion: 'Applied',
    answered: 'Answered: {sentence}',
    declined: 'Declined: {sentence}',
    failed: 'Failed: {reason}',
    quiet: 'No change yet · {elapsed}',
    replaced: 'Replaced by a newer change',
    canceled: 'Canceled',
    notsent: 'Not sent: {reason}',
    lost: 'Connection lost',
  }),
  elapsedSeconds: '{n} s',
  elapsedMinutes: '{n} min',
  elapsedHours: '{h} h',
  elapsedHoursMinutes: '{h} h {m} min',
  took: 'Took {elapsed}',
  about: 'About: {chip}',
  meanings: Object.freeze({
    sent: 'Moontide accepted the request.',
    received: 'Claude was handed the request.',
    waiting: "The request waits until Claude's next Moontide call.",
    line: "Claude's change is ready and takes over at its line.",
    lineBar: ' Next bar.',
    linePhrase: ' Next phrase.',
    applied: 'Claude linked version v{n} to this request.',
    appliedNoVersion: 'Claude linked a change to this request; the history could not save it, so it has no version number.',
    quiet: 'Claude has not linked a change or an answer to this request.',
    replaced: 'A newer change took its place before it reached its line.',
    canceled: 'The change was canceled before it reached its line.',
    lost: 'Moontide lost the connection, so the page cannot tell what happened to this request.',
  }),
  live: Object.freeze({
    sent: 'Request "{text}": sent.',
    received: 'Request "{text}": received.',
    waiting: 'Request "{text}": waiting for Claude\'s next action.',
    started: 'Request "{text}": Claude has started on it.',
    line: 'Request "{text}": waiting for its line.',
    applied: 'Request "{text}": applied as v{n}.',
    appliedNoVersion: 'Request "{text}": applied.',
    answered: 'Request "{text}" answered: {sentence}',
    declined: 'Request "{text}" declined: {sentence}',
    quiet: 'Request "{text}": no change yet.',
    replaced: 'Request "{text}": replaced by a newer change.',
    canceled: 'Request "{text}": canceled.',
    lostOne: 'Connection lost. The page cannot tell what happened to 1 open request.',
    lostMany: 'Connection lost. The page cannot tell what happened to {n} open requests.',
    moreOne: 'and 1 more update.',
    moreMany: 'and {k} more updates.',
  }),
});

/** Fills the words in braces of `template` from `values`; a word with no value is a loud error. */
function fill(template, values) {
  return template.replace(/\{(\w+)\}/g, (_, key) => {
    if (!(key in values)) throw new Error(`Moontide: the request wording "${template}" needs ${key}.`);
    return String(values[key]);
  });
}

/** True for a state a request ends in. */
export function isFinalState(state) {
  return FINAL_STATES.includes(state);
}

/**
 * Where a state stands: sent 0, waiting 1, received 2, started 3, line 4 and every final state 5. A message that
 * does not raise the rank changes nothing. An unknown state is a loud error.
 */
export function stateRank(state) {
  if (isFinalState(state)) return ORDER.length;
  const rank = ORDER.indexOf(state);
  if (rank === -1) throw new Error(`Moontide: unknown request state "${state}".`);
  return rank;
}

/** `text` cut to at most `max` code points, the cut marked with an ellipsis; a surrogate pair is never split. */
export function cutCodePoints(text, max) {
  const points = Array.from(text);
  if (points.length <= max) return text;
  return `${points.slice(0, max).join('')}…`;
}

/** The text of a row: whitespace and line breaks collapsed to single spaces, then cut to ROW_TEXT_MAX code points. */
export function rowText(text) {
  return cutCodePoints(text.replace(/\s+/gu, ' ').trim(), ROW_TEXT_MAX);
}

/** A duration in whole units rounded down: 7 s, 42 s, 1 min, 12 min, 1 h, 1 h 5 min. */
export function formatElapsed(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return fill(REQUEST_STATUS_COPY.elapsedSeconds, { n: seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return fill(REQUEST_STATUS_COPY.elapsedMinutes, { n: minutes });
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (rest === 0) return fill(REQUEST_STATUS_COPY.elapsedHours, { h: hours });
  return fill(REQUEST_STATUS_COPY.elapsedHoursMinutes, { h: hours, m: rest });
}

function firstLine(text) {
  return String(text).split(/\r\n|\r|\n/u)[0].trim();
}

/**
 * The words of a row's state. `row` carries `state` (a server state, notsent, lost or quiet) and what the state
 * needs: `version` for applied, `answer` for answered and declined, `reason` for failed and notsent, `quietFor`
 * (milliseconds since the last news) for quiet. An unknown state throws, as the page's other copy lookups do.
 */
export function statePhrase(row) {
  const phrases = REQUEST_STATUS_COPY.phrases;
  switch (row.state) {
    case 'sent':
    case 'received':
    case 'waiting':
    case 'started':
    case 'line':
    case 'replaced':
    case 'canceled':
    case 'lost':
      return phrases[row.state];
    case 'applied':
      return Number.isInteger(row.version) ? fill(phrases.applied, { n: row.version }) : phrases.appliedNoVersion;
    case 'answered':
    case 'declined':
      return fill(phrases[row.state], { sentence: row.answer ?? '' });
    case 'failed':
      return fill(phrases.failed, { reason: cutCodePoints(firstLine(row.reason ?? ''), REASON_ROW_MAX) });
    case 'notsent':
      return fill(phrases.notsent, { reason: row.reason ?? '' });
    case 'quiet':
      return fill(phrases.quiet, { elapsed: formatElapsed(row.quietFor ?? 0) });
    default:
      throw new Error(`Moontide: no wording for the request state "${row.state}".`);
  }
}

/** The shape beside a state's words: flight (still going), done, ended (without a change) or bad (did not work). */
export function stateMark(state) {
  switch (state) {
    case 'sent':
    case 'waiting':
    case 'received':
    case 'started':
    case 'line':
    case 'quiet':
      return 'flight';
    case 'applied':
    case 'answered':
      return 'done';
    case 'declined':
    case 'replaced':
    case 'canceled':
    case 'lost':
      return 'ended';
    case 'failed':
    case 'notsent':
      return 'bad';
    default:
      throw new Error(`Moontide: no mark for the request state "${state}".`);
  }
}

function collapse(text) {
  return String(text).replace(/\s+/gu, ' ').trim();
}

// What the state means, one line under the request in an opened row.
function meaningLine(row) {
  const meanings = REQUEST_STATUS_COPY.meanings;
  switch (row.state) {
    case 'sent':
    case 'received':
    case 'waiting':
    case 'quiet':
    case 'replaced':
    case 'canceled':
    case 'lost':
      return { kind: 'meaning', text: meanings[row.state] };
    case 'started':
      return { kind: 'basis', text: `${REQUEST_STATUS_COPY.basisLead}${REQUEST_STATUS_COPY.startedBasis}` };
    case 'line': {
      const when = row.at === 'bar' ? meanings.lineBar : row.at === 'phrase' ? meanings.linePhrase : '';
      return { kind: 'meaning', text: `${meanings.line}${when}` };
    }
    case 'applied':
      return { kind: 'meaning', text: Number.isInteger(row.version) ? fill(meanings.applied, { n: row.version }) : meanings.appliedNoVersion };
    case 'answered':
    case 'declined':
      return row.answer ? { kind: 'meaning', text: row.answer } : null;
    case 'failed':
      return row.reason ? { kind: 'reason', text: row.reason } : null;
    case 'notsent':
      return row.reason ? { kind: 'meaning', text: row.reason } : null;
    default:
      throw new Error(`Moontide: no detail for the request state "${row.state}".`);
  }
}

/**
 * The lines of an opened row, in order: the request as written (cut to DETAIL_TEXT_MAX), the context it was sent
 * with, and what the state means. A line with nothing to say is left out. `row` carries `text`, `chip`, `state` and
 * what the state needs (`version`, `at`, `answer`, `reason`). Each line is `{ kind, text }`; the kind (request,
 * about, meaning, basis or reason) tells the view how to set it.
 */
export function detailLines(row) {
  const lines = [];
  if (row.text) lines.push({ kind: 'request', text: cutCodePoints(row.text, DETAIL_TEXT_MAX) });
  if (row.chip) lines.push({ kind: 'about', text: fill(REQUEST_STATUS_COPY.about, { chip: row.chip }) });
  const meaning = meaningLine(row);
  if (meaning !== null) lines.push(meaning);
  return lines;
}

/**
 * The sentence the page speaks for one change of a request, or null when the page says nothing: a failure and a
 * refusal already have their own alert. `event` carries `state`, the request's `text` (cut to LIVE_TEXT_MAX) and what
 * the state needs; a lost connection carries `n`, the number of open requests. An unknown state throws.
 */
export function liveSentence(event) {
  const copy = REQUEST_STATUS_COPY.live;
  const { state } = event;
  if (state === 'failed' || state === 'notsent') return null;
  if (state === 'lost') return fill(event.n === 1 ? copy.lostOne : copy.lostMany, { n: event.n });
  const text = cutCodePoints(collapse(event.text ?? ''), LIVE_TEXT_MAX);
  switch (state) {
    case 'sent':
    case 'received':
    case 'waiting':
    case 'started':
    case 'line':
    case 'quiet':
    case 'replaced':
    case 'canceled':
      return fill(copy[state], { text });
    case 'applied':
      return Number.isInteger(event.version) ? fill(copy.applied, { text, n: event.version }) : fill(copy.appliedNoVersion, { text });
    case 'answered':
    case 'declined':
      return fill(copy[state], { text, sentence: event.answer ?? '' });
    default:
      throw new Error(`Moontide: no sentence for the request state "${state}".`);
  }
}

/** The sentences spoken together: at most LIVE_JOIN_MAX, joined with a space, then a count of the rest. */
export function joinLive(sentences) {
  if (sentences.length <= LIVE_JOIN_MAX) return sentences.join(' ');
  const more = sentences.length - LIVE_JOIN_MAX;
  const tail = more === 1 ? REQUEST_STATUS_COPY.live.moreOne : fill(REQUEST_STATUS_COPY.live.moreMany, { k: more });
  return `${sentences.slice(0, LIVE_JOIN_MAX).join(' ')} ${tail}`;
}

/**
 * Creates the tracker. `now()` is the clock in milliseconds; `setTimer(fn, ms)` and `clearTimer(timer)` are the page's
 * timers: the tracker keeps at most one, set for the next change that is due (a request nobody confirmed, a request
 * that reached its quiet wait, a finished request that leaves the list) and never a repeating one. `onChange()` runs
 * after every change of the model. `onNotConfirmed(id)` runs when a request the server never confirmed is given up
 * (it was not confirmed in time, or the connection closed first). `promised` says which groups of states the page may
 * show (default: what was measured).
 */
export function createRequestTracker({
  now,
  setTimer,
  clearTimer,
  onChange = () => {},
  onNotConfirmed = () => {},
  promised = { link: LINK_PROMISED, close: CLOSE_PROMISED },
  confirmTimeoutMs = ASK_CONFIRM_TIMEOUT_MS,
}) {
  if (typeof now !== 'function' || typeof setTimer !== 'function' || typeof clearTimer !== 'function') {
    throw new Error('Moontide: the request tracker needs a clock and timers.');
  }
  // id -> row, in the order the rows were opened.
  const rows = new Map();
  // Console lines already said, one per cause.
  const said = new Set();
  // The sentences queued for the spoken line since takeLive() was last called.
  let spoken = [];
  let timer = null;
  let opened = 0;

  function sayOnce(cause, line) {
    if (said.has(cause)) return;
    said.add(cause);
    console.error(line);
  }

  function makeRow(id, { text, chip }, openedAt) {
    opened += 1;
    return {
      id,
      text,
      chip,
      state: 'sent',
      order: opened,
      openedAt,
      newsAt: openedAt,
      finishedAt: null,
      version: null,
      at: null,
      reason: '',
      answer: '',
      // True once the server has said anything about the request.
      confirmed: false,
      // True once the quiet wait was spoken; news makes it speakable again.
      quietSaid: false,
      // True while the pointer, focus or an open detail keeps a finished row where it is.
      held: false,
      inRecent: false,
      movedAt: 0,
    };
  }

  const isFinal = (row) => isFinalState(row.state);

  /** How long a row has been quiet, or null when it is not: not at its line, not finished, 30 s without news. */
  function quietFor(row, at) {
    if (isFinal(row) || row.state === 'line') return null;
    return at - row.newsAt >= QUIET_AFTER_MS ? at - row.newsAt : null;
  }

  function speak(row, state) {
    const sentence = liveSentence({ state, text: row.text, version: row.version, answer: row.answer });
    if (sentence !== null) spoken.push(sentence);
  }

  function known(id, type) {
    const row = rows.get(id);
    if (row === undefined) sayOnce(`unknown-id:${type}`, `Moontide: a ${type} message names a request this page did not send; it was ignored.`);
    return row;
  }

  /** Moves a row to `state` when that is higher than where it is; returns whether it moved. */
  function advance(row, state, extra = {}, { news = now(), silent = false } = {}) {
    if (stateRank(state) <= stateRank(row.state)) return false;
    row.state = state;
    Object.assign(row, extra);
    row.newsAt = news;
    row.quietSaid = false;
    if (isFinalState(state)) row.finishedAt = news;
    if (!silent && state !== 'lost') speak(row, state);
    return true;
  }

  /** True when the page may show `state`; a state it was not measured to hold is said once and left out. */
  function allowed(state) {
    if (LINK_STATES.includes(state) && !promised.link) {
      sayOnce('unpromised:link', 'Moontide: a request state that only a change naming its request can bring was not measured to hold, so it is not shown; the message was ignored.');
      return false;
    }
    if (CLOSE_STATES.includes(state) && !promised.close) {
      sayOnce('unpromised:close', 'Moontide: a request state that only the closing tool can bring was not measured to hold, so it is not shown; the message was ignored.');
      return false;
    }
    return true;
  }

  function knownState(state) {
    if (SERVER_REQUEST_STATES.includes(state)) return true;
    sayOnce(`unknown-state:${state}`, `Moontide: the server named the request state "${state}", which this page does not know; it was ignored.`);
    return false;
  }

  /** What a state of the server brings along on the row. */
  function extraOf(message) {
    const extra = {};
    if (message.state === 'line') extra.at = message.at ?? null;
    if (message.state === 'applied') extra.version = Number.isInteger(message.version) ? message.version : null;
    if (message.state === 'failed') extra.reason = String(message.reason ?? '');
    if (message.state === 'answered' || message.state === 'declined') extra.answer = String(message.answer ?? '');
    return extra;
  }

  function recentRows() {
    return [...rows.values()].filter((row) => row.inRecent).sort((a, b) => b.movedAt - a.movedAt || b.order - a.order);
  }

  /** Keeps the last RECENT_MAX finished requests; returns whether one was dropped. */
  function trimRecent() {
    const dropped = recentRows().slice(RECENT_MAX);
    for (const row of dropped) rows.delete(row.id);
    return dropped.length > 0;
  }

  /** Applies every change that is due at this moment; returns whether anything changed. */
  function settle() {
    const at = now();
    let changed = false;
    for (const row of rows.values()) {
      if (!row.confirmed && !isFinal(row) && at - row.openedAt >= confirmTimeoutMs) {
        advance(row, 'notsent', { reason: REQUEST_STATUS_COPY.notConfirmed }, { news: at });
        onNotConfirmed(row.id);
        changed = true;
      }
      if (!row.quietSaid && quietFor(row, at) !== null) {
        row.quietSaid = true;
        speak(row, 'quiet');
        changed = true;
      }
      if (isFinal(row) && !row.inRecent && !row.held && at - row.finishedAt >= FINISHED_SHOWN_MS) {
        row.inRecent = true;
        row.movedAt = at;
        changed = true;
      }
    }
    if (trimRecent()) changed = true;
    return changed;
  }

  /** When the next change is due, or Infinity. */
  function nextDue() {
    let due = Infinity;
    for (const row of rows.values()) {
      if (isFinal(row)) {
        if (!row.inRecent && !row.held) due = Math.min(due, row.finishedAt + FINISHED_SHOWN_MS);
        continue;
      }
      if (!row.confirmed) due = Math.min(due, row.openedAt + confirmTimeoutMs);
      if (row.state !== 'line' && !row.quietSaid) due = Math.min(due, row.newsAt + QUIET_AFTER_MS);
    }
    return due;
  }

  function schedule() {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    const due = nextDue();
    if (due === Infinity) return;
    timer = setTimer(() => {
      timer = null;
      if (settle()) onChange();
      schedule();
    }, Math.max(0, due - now()));
  }

  function viewRow(row, at) {
    const quiet = quietFor(row, at);
    const shown = { ...row, state: quiet === null ? row.state : 'quiet', quietFor: quiet };
    const finished = row.finishedAt !== null;
    const elapsed = (finished ? row.finishedAt : at) - row.openedAt;
    const phrase = statePhrase(shown);
    return {
      id: row.id,
      text: rowText(row.text),
      fullText: row.text,
      chip: row.chip,
      state: shown.state,
      phrase,
      phraseTitle: shown.state === 'started' ? REQUEST_STATUS_COPY.startedBasis : phrase,
      shape: stateMark(shown.state),
      finished,
      finishedAgo: finished ? at - row.finishedAt : null,
      held: row.held,
      time: quiet !== null || (finished && elapsed < 1000) ? '' : formatElapsed(elapsed),
      timeTitle: finished && elapsed >= 1000 ? fill(REQUEST_STATUS_COPY.took, { elapsed: formatElapsed(elapsed) }) : '',
      detail: detailLines(shown),
    };
  }

  /** A request the server holds that this page may not know yet (the board a reloaded page gets). */
  function adopt(entry) {
    if (!knownState(entry.state) || !allowed(entry.state)) return false;
    const at = now();
    const newsAt = at - (Number.isFinite(entry.newsAgoMs) ? entry.newsAgoMs : 0);
    const existing = rows.get(entry.id);
    if (existing !== undefined) {
      existing.confirmed = true;
      return advance(existing, entry.state, extraOf(entry), { news: newsAt, silent: true });
    }
    const openedAt = at - (Number.isFinite(entry.openedAgoMs) ? entry.openedAgoMs : 0);
    const row = makeRow(entry.id, { text: String(entry.text ?? ''), chip: String(entry.chip ?? '') }, openedAt);
    row.confirmed = true;
    row.state = entry.state;
    Object.assign(row, extraOf(entry));
    row.newsAt = newsAt;
    if (isFinal(row)) {
      row.finishedAt = newsAt;
      if (at - newsAt >= FINISHED_SHOWN_MS) {
        row.inRecent = true;
        row.movedAt = newsAt + FINISHED_SHOWN_MS;
      }
    }
    // A row that is quiet when it comes back was not quiet "now": nothing is spoken for it.
    row.quietSaid = quietFor(row, at) !== null;
    rows.set(entry.id, row);
    return true;
  }

  function changed() {
    schedule();
    onChange();
  }

  return {
    /** The user sent request `id` with `text` and the context `chip`: a new row at Sent. */
    sent(id, { text, chip }) {
      if (rows.has(id)) return;
      const row = makeRow(id, { text, chip }, now());
      rows.set(id, row);
      speak(row, 'sent');
      changed();
    },

    /** One server message: ask-result, ask-received, ask-status or ask-board. Anything else is ignored. */
    serverMessage(msg) {
      let moved = false;
      if (msg.type === 'ask-result') {
        const row = known(msg.id, msg.type);
        if (row === undefined) return;
        row.confirmed = true;
        if (msg.status === 'received') moved = advance(row, 'received');
        else if (msg.status === 'waiting') moved = advance(row, 'waiting');
        else if (msg.status === 'refused') moved = advance(row, 'notsent', { reason: refusalText(msg.reason, msg.detail) });
        else sayOnce(`unknown-result:${msg.status}`, `Moontide: the server answered a request with "${msg.status}", which this page does not know; it was ignored.`);
      } else if (msg.type === 'ask-received') {
        for (const id of msg.ids) {
          const row = known(id, msg.type);
          if (row === undefined) continue;
          row.confirmed = true;
          if (advance(row, 'received')) moved = true;
        }
      } else if (msg.type === 'ask-status') {
        const row = known(msg.id, msg.type);
        if (row === undefined) return;
        row.confirmed = true;
        if (knownState(msg.state) && allowed(msg.state)) moved = advance(row, msg.state, extraOf(msg));
      } else if (msg.type === 'ask-board') {
        if (!Array.isArray(msg.requests)) {
          sayOnce('bad-board', 'Moontide: the server sent a request board that is not a list; it was ignored.');
          return;
        }
        for (const entry of msg.requests) {
          if (adopt(entry)) moved = true;
        }
        if (trimRecent()) moved = true;
      }
      if (moved) changed();
      else schedule();
    },

    /** The socket closed: every request still open reads Connection lost, and none is waited for any more. */
    connectionLost() {
      let open = 0;
      for (const row of rows.values()) {
        if (isFinal(row)) continue;
        const unconfirmed = !row.confirmed;
        advance(row, 'lost');
        open += 1;
        if (unconfirmed) onNotConfirmed(row.id);
      }
      if (open === 0) return;
      spoken.push(liveSentence({ state: 'lost', n: open }));
      changed();
    },

    /** A finished row stays where it is while the pointer, focus or an open detail holds it; it moves when released. */
    setHeld(id, held) {
      const row = rows.get(id);
      if (row === undefined || row.held === Boolean(held)) return;
      row.held = Boolean(held);
      if (!row.held && settle()) {
        changed();
        return;
      }
      schedule();
    },

    /** The sentences to speak since the last call (see joinLive for how they are joined). */
    takeLive() {
      const taken = spoken;
      spoken = [];
      return taken;
    },

    /** What the view draws: the list newest first, Recent with the latest move first, how many are in flight, and whether the board is empty. */
    model() {
      const at = now();
      const list = [...rows.values()].filter((row) => !row.inRecent).sort((a, b) => b.openedAt - a.openedAt || b.order - a.order);
      return {
        empty: rows.size === 0,
        inFlight: list.filter((row) => !isFinal(row)).length,
        rows: list.map((row) => viewRow(row, at)),
        recent: recentRows().map((row) => viewRow(row, at)),
      };
    },
  };
}
