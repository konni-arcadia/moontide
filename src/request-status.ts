// The request status board: what became of each request a page sent to Claude.
//
// The board holds one row per request the page sent, keyed by the id the page made up: the page that
// sent it, its state and the start of the text and the chip, kept in memory only so a reloaded page can
// show what it asked. Nothing is ever written to disk and the board holds at most MAX_BOARD_REQUESTS
// rows (the oldest finished row goes first, an open one only when every row is open). A state only
// moves forward: a repeat, a step back and any change after a final state are ignored, so the page is
// never told the same thing twice and never told something that undoes what it was told. A state
// reaches only the page that sent the request; once that page has gone the row keeps its state and
// nothing is sent.
//
// The page already learns "sent", "waiting" and "received" from the ask-result and ask-received
// messages. The board adds the states that come later and sends them as ask-status.

import type { AskSend } from './ask.js';
import { MAX_ASK_CONTEXT_LENGTH, type AskBoardEntry } from './protocol.js';
import type { PageConnection } from './session.js';

/** How many requests the board keeps; the oldest finished row is dropped first. */
export const MAX_BOARD_REQUESTS = 50;

// In the order a request moves through them. page/request-status.js mirrors this list by hand.
export const REQUEST_STATES = [
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
] as const;

export type RequestState = (typeof REQUEST_STATES)[number];

/** A request in one of these is finished: nothing follows it. */
export const FINAL_REQUEST_STATES: readonly RequestState[] = [
  'applied',
  'failed',
  'replaced',
  'canceled',
  'answered',
  'declined',
];

/** Said when a request is closed by its id and the id is not an open request. */
export const NOT_OPEN_REQUEST_MESSAGE =
  'No open page request has this id: it is unknown or already closed. Nothing changed in the page.';

// Whitespace, C0 and C1 control characters, the line and paragraph separators and the bidirectional
// override and isolate characters: none of them belongs in a sentence the page shows to the user.
const ANSWER_NOISE = /[\s\u0000-\u001F\u007F-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069]+/gu;

/** The sentence Claude closes a request with, as the page shows it: each run of noise becomes one space. */
export function cleanAnswerText(text: string): string {
  return text.replace(ANSWER_NOISE, ' ').trim();
}

/** Where a state stands in the order: 0 to 4 for sent to line, 5 for every final state. */
export function requestRank(state: RequestState): number {
  if (FINAL_REQUEST_STATES.includes(state)) {
    return 5;
  }
  return REQUEST_STATES.indexOf(state);
}

interface BoardRow {
  /** The page that sent the request; null once that page has gone. */
  origin: PageConnection | null;
  state: RequestState;
  /** The start of the request text, kept in memory only; never written anywhere. */
  text: string;
  chip: string;
  openedAt: number;
  /** When the state last moved. */
  newsAt: number;
  /** The message that carried the current state, for its detail (version, line, reason, answer). */
  last: StatusMessage | undefined;
}

/** The start of a request text: at most MAX_ASK_CONTEXT_LENGTH code points, an ellipsis when it was cut. */
function textStart(text: string): string {
  const points = Array.from(text);
  return points.length <= MAX_ASK_CONTEXT_LENGTH ? text : `${points.slice(0, MAX_ASK_CONTEXT_LENGTH).join('')}\u2026`;
}

type StatusMessage = Extract<Parameters<AskSend>[1], { type: 'ask-status' }>;

export class RequestStatusBoard {
  private readonly send: AskSend;
  private readonly max: number;
  private readonly now: () => number;
  // Insertion order is arrival order, so the first key is the oldest request.
  private readonly rows = new Map<string, BoardRow>();

  constructor(options: { send: AskSend; max?: number; now?: () => number }) {
    this.send = options.send;
    this.max = options.max ?? MAX_BOARD_REQUESTS;
    this.now = options.now ?? Date.now;
  }

  /** A request was accepted: it is sent to a listener, or queued until a tool reply. */
  opened(id: string, origin: PageConnection, options: { queued: boolean; text: string; chip: string }): void {
    // The channel refuses an id the board holds before it gets here, so a row is never silently reset.
    if (this.rows.has(id)) {
      throw new Error(`The request id ${JSON.stringify(id)} is already on the request board`);
    }
    const at = this.now();
    this.rows.set(id, {
      origin,
      state: options.queued ? 'waiting' : 'sent',
      text: textStart(options.text),
      chip: options.chip,
      openedAt: at,
      newsAt: at,
      last: undefined,
    });
    // The bound caps memory, not live work: the oldest finished row goes first. Only when every row is
    // still open does the oldest open row go.
    while (this.rows.size > this.max) {
      let victim: string | undefined;
      for (const [rowId, row] of this.rows) {
        if (FINAL_REQUEST_STATES.includes(row.state)) {
          victim = rowId;
          break;
        }
      }
      victim ??= this.rows.keys().next().value;
      if (victim === undefined) break;
      this.rows.delete(victim);
    }
  }

  /** A request that was sent to a listener went back to the queue. */
  waiting(id: string): void {
    this.advance(id, 'waiting');
  }

  /** Requests were handed to Claude, by a listener or in a tool reply. */
  delivered(ids: readonly string[]): void {
    for (const id of ids) {
      this.advance(id, 'received');
    }
  }

  /**
   * A Moontide tool call began. Every request already handed to Claude is now being worked on: Claude
   * made a call after the request arrived. A request handed over by this very call is still waiting to
   * be marked, because the mark comes before the reply hands it over.
   */
  noteToolCall(): void {
    for (const [id, row] of this.rows) {
      if (row.state === 'received') {
        this.advance(id, 'started', { type: 'ask-status', id, state: 'started' });
      }
    }
  }

  /** On the board, open or finished. */
  has(id: string): boolean {
    return this.rows.has(id);
  }

  /** On the board and not finished. */
  isOpen(id: string): boolean {
    const row = this.rows.get(id);
    return row !== undefined && !FINAL_REQUEST_STATES.includes(row.state);
  }

  /** The change that answers this request is playing, as the history version it was recorded as. */
  applied(id: string, version: number | null): void {
    this.advance(id, 'applied', { type: 'ask-status', id, state: 'applied', version });
  }

  /** A change that answers this request waits for its bar or phrase line. */
  line(id: string, at: 'bar' | 'phrase'): void {
    this.advance(id, 'line', { type: 'ask-status', id, state: 'line', at });
  }

  /** The change that answers this request could not be evaluated; the reason is already cleaned. */
  failed(id: string, reason: string): void {
    this.advance(id, 'failed', { type: 'ask-status', id, state: 'failed', reason });
  }

  /** A newer change took the place of the waiting one that answered this request. */
  replaced(id: string): void {
    this.advance(id, 'replaced', { type: 'ask-status', id, state: 'replaced' });
  }

  /** Stop, or the page leaving, ended the wait of the change that answered this request. */
  canceled(id: string): void {
    this.advance(id, 'canceled', { type: 'ask-status', id, state: 'canceled' });
  }

  /**
   * Claude closed this request in words, without a change to the music. Returns false when the id is not
   * an open request, so the caller can refuse it loudly.
   */
  closed(id: string, outcome: 'answered' | 'declined', answer: string): boolean {
    if (!this.isOpen(id)) {
      return false;
    }
    this.advance(id, outcome, { type: 'ask-status', id, state: outcome, answer });
    return true;
  }

  /**
   * What a page that asks for the board is told: the requests whose page has gone and the ones it sent
   * itself, oldest first. The gone ones now belong to it, so their next states reach it. A request of
   * another page that is still connected is never listed.
   */
  snapshotFor(conn: PageConnection): AskBoardEntry[] {
    const at = this.now();
    const entries: AskBoardEntry[] = [];
    for (const [id, row] of this.rows) {
      if (row.origin !== null && row.origin !== conn) {
        continue;
      }
      row.origin = conn;
      const entry: AskBoardEntry = {
        id,
        text: row.text,
        chip: row.chip,
        state: row.state,
        openedAgoMs: at - row.openedAt,
        newsAgoMs: at - row.newsAt,
      };
      const last = row.last;
      if (last?.state === 'applied') entry.version = last.version;
      if (last?.state === 'line') entry.at = last.at;
      if (last?.state === 'failed') entry.reason = last.reason;
      if (last?.state === 'answered' || last?.state === 'declined') entry.answer = last.answer;
      entries.push(entry);
    }
    return entries;
  }

  /** The page that sent these requests has gone: the rows keep their state and nothing more is sent. */
  pageGone(conn: PageConnection): void {
    for (const row of this.rows.values()) {
      if (row.origin === conn) {
        row.origin = null;
      }
    }
  }

  // The one place a state changes. It does nothing for an unknown id or a state that is not higher.
  private advance(id: string, state: RequestState, message?: StatusMessage): void {
    const row = this.rows.get(id);
    if (row === undefined || requestRank(state) <= requestRank(row.state)) {
      return;
    }
    row.state = state;
    row.newsAt = this.now();
    row.last = message;
    if (message !== undefined && row.origin !== null) {
      this.send(row.origin, message, 'the request status');
    }
  }
}
