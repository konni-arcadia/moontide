import { randomUUID } from 'node:crypto';
import { AskChannel, listenerScriptPath } from './ask.js';
import { NOT_OPEN_REQUEST_MESSAGE, RequestStatusBoard, cleanAnswerText } from './request-status.js';
import { MIDI_PERMISSION_WAIT_MESSAGE, MidiChannel } from './midi-state.js';
import { applyEdits, type EditInput, type EditRange } from './edit-code.js';
import {
  CatalogSaveError,
  MAX_CATALOG_DRAFTS,
  MAX_CATALOG_KITS,
  MAX_CATALOG_SOUNDS,
  MAX_PART_SOUNDS,
  catalogFileExists,
  countText,
  flattenCatalogPart,
  parseCatalog,
  problemsText,
  saveCatalog,
  summarizeCatalog,
  type CatalogPartGroup,
  type CatalogKit,
  type CatalogSound,
  type ProgramNumbering,
} from './catalog.js';
import {
  RIG_FILE_NAME,
  connectionOf,
  describeInstrument,
  describeRig,
  describeSearch,
  rigInvalidLine,
  rigMessage,
  rigOffAtStartLine,
  rigRemovedLine,
  rigSwitchedOffLine,
  rigSwitchedOnLine,
  rigValidAgainLine,
  ModelSaveError,
  invalidModelText,
  parseModel,
  saveUserModel,
  writeRigState,
  RigStateSaveError,
  applyInstrumentSettings,
  rigSettingsLine,
  shippedIdText,
  summarizeDraft,
  type RigState,
  type RigStore,
} from './instruments.js';
import { CONTROL_CHARS, cleanProblemText, modelIdSchema } from './rig-util.js';
import type { BuildCheck } from './build-id.js';
import {
  HISTORY_WINDOW_SIZE,
  MAX_DATA_FOLDER_LENGTH,
  type AudioState,
  type ChangeTiming,
  type GlideReport,
  type LoadFailedScript,
  type MidiFacts,
  type PageMessage,
  type PendingChange,
  type ServerMessage,
} from './protocol.js';
import {
  HistoryStore,
  HAND_EDIT_LABEL,
  historyUnavailableMessage,
  historyWriteFailedNote,
  versionNotFoundMessage,
  restoredLabel,
  favoriteSavedMessage,
  favoriteRenamedMessage,
  normalizeText,
  HistoryError,
  partLaunchLabel,
  type VersionOrigin,
} from './history.js';

export const REPLY_TIMEOUT_MS = 5000;

// The notes Claude gets once when the files this server serves changed since it started. The page
// folder changing is a mismatch between the page and the server; the compiled code folder alone changing
// only means the running server is older than its files, and the page it serves is still its own.
export const BUILD_MISMATCH_NOTE =
  'Note: the server and the page come from different builds, restart the server. Moontide was updated since this server started; restart Claude (which runs the server) to use the update.';
export const BUILD_UPDATED_NOTE =
  'Note: Moontide was updated since this server started; restart Claude (which runs the server) to use the update. The page and the server still come from the same build, so nothing is refused meanwhile.';

// A late reply's label is kept by request id independently of the reply-timeout window (it
// must still be there when a late reply eventually arrives); this bounds that map's lifetime
// so a request that never gets any reply at all doesn't leak forever.
export const RECORD_INTENT_TTL_MS = 60000;

/** A connection to the active browser page. `send` throws when the socket is not open. */
export interface PageConnection {
  send(data: string): void;
}

export interface EvalOutcome {
  code: string;
  audio: AudioState;
  replacedHandEdit: boolean;
  /** The history id this evaluation was recorded as; null without a store or on a write failure. */
  versionId: number | null;
  /** Present when the change was accepted but waits for a bar or phrase line; nothing is recorded yet. */
  pending?: PendingChange;
  /**
   * The tempo in BPM the page reported for this change, rounded to one decimal; null when the page sent none.
   * For a waiting change it is the tempo from the line on.
   */
  bpm: number | null;
  /** True when `bpm` differs from the last tempo a reply stated (and on the first one); the caller says it once. */
  tempoChanged: boolean;
  /** Present when this change started a tempo ramp; the reply says the ramp in place of the tempo. */
  glide?: GlideReport;
}

/** Which code an edit_code call was applied to. */
export type EditBase =
  | { kind: 'playing'; versionId: number | null }
  | { kind: 'waiting'; cycle: number; at: ChangeTiming };

/** What Session.editCode returns: the page's outcome plus the composed code, its changed ranges and the base. */
export interface EditOutcome {
  outcome: EvalOutcome;
  /** The program the edits composed and sent (the page's confirmed text is in `outcome.code`). */
  code: string;
  ranges: EditRange[];
  base: EditBase;
  /**
   * True when the edit was built on a hand-edited playing code, so the user's text is still in what plays;
   * the reply says the edit was applied on top of it instead of claiming it replaced it.
   */
  carriesHandEdit: boolean;
}

export const EDIT_NOTHING_PLAYING_MESSAGE = 'Nothing is playing yet, so there is no code to edit: use set_code for a new piece.';

/**
 * The refusal of an edit_code call while an evaluate request the server sent (a set_code, an edit_code, a
 * restore_version, a restore started from the page) has not been answered by the page yet. The edit would be composed
 * on code that is about to change, and the page would play the later whole program, so the earlier change would
 * vanish while both replies said "done". Changes that start in the page (Mixer moves, part launches, hand
 * evaluations) create no pending request, so they never block an edit; their race with set_code stays accepted.
 */
export const EDIT_IN_FLIGHT_MESSAGE =
  'edit_code applied nothing and sent nothing to the page: another change is still reaching the page, and an edit built now would be built on code that is about to change. Wait for the reply of that change, then call get_code and edit again.';

/** The refusal of a whole edit_code call; `where` names the code the edits were matched against. */
export function editRefusedMessage(where: string, problems: readonly string[]): string {
  return [
    `edit_code applied nothing and sent nothing to the page, so what plays is unchanged. The edits were matched against ${where}:`,
    ...problems.map((problem) => `- ${problem}`),
  ].join('\n');
}

/** The refusal of an edit_code call whose base version is not the one playing now. */
export function baseMovedMessage(base: number, current: number): string {
  return `edit_code applied nothing and sent nothing to the page: the music moved on since version #${base}, and #${current} plays now. Call get_code and edit again.`;
}

/** The refusal of an edit_code call with a base version when no version is known to compare it to. */
export function baseUnknownMessage(base: number): string {
  return `edit_code applied nothing and sent nothing to the page: the version playing now is not known, so base #${base} cannot be checked. Call get_code, and edit again without base when it shows no version.`;
}

export function noPageMessage(pageUrl: string): string {
  return `No page connected — open ${pageUrl} and click to start sound.`;
}

/** What a request that needs the page says before Moontide is started: no page is open yet. */
export const NOT_STARTED_MESSAGE =
  'Moontide is not started yet: no page is open and nothing plays. Call start to open the page, or set_code, which starts Moontide by itself.';

export const NOT_RESPONDING_MESSAGE = "The page isn't responding — check that it's still open and try again.";

export const STILL_PLAYING_TAIL = 'The previous code is still playing.';
export const NOTHING_PLAYING_TAIL = 'Nothing is playing yet.';
export const STILL_STOPPED_TAIL = 'Sound is still stopped.';
export const UNKNOWN_ERROR_DETAIL = 'unknown error (the page gave no message)';
export const MAX_DETAIL_CODE_POINTS = 500;
export const STALE_PAGE_MESSAGE =
  'The page that received this request is no longer the active page, so nothing changed. Try again.';

/**
 * Cleans page-supplied error text for display: trims; substitutes UNKNOWN_ERROR_DETAIL for
 * empty/whitespace-only input; strips trailing periods (the caller adds its own); cuts text
 * longer than MAX_DETAIL_CODE_POINTS code points at a code point boundary (Array.from never
 * splits a surrogate pair) and appends an ellipsis.
 */
export function cleanErrorDetail(detail: string): string {
  const trimmed = detail.trim();
  if (trimmed === '') {
    return UNKNOWN_ERROR_DETAIL;
  }
  const withoutTrailingPeriods = trimmed.replace(/\.+$/, '');
  const codePoints = Array.from(withoutTrailingPeriods);
  if (codePoints.length <= MAX_DETAIL_CODE_POINTS) {
    return withoutTrailingPeriods;
  }
  return codePoints.slice(0, MAX_DETAIL_CODE_POINTS).join('') + '…';
}

/** The page's refusal text of a tempo ramp it could not make, trimmed and cut like any error detail but kept as a sentence. */
function cleanRefusal(text: string): string {
  const trimmed = text.trim();
  if (trimmed === '') return UNKNOWN_ERROR_DETAIL;
  const codePoints = Array.from(trimmed);
  return codePoints.length <= MAX_DETAIL_CODE_POINTS ? trimmed : codePoints.slice(0, MAX_DETAIL_CODE_POINTS).join('') + '…';
}

/**
 * Builds the tool-response text for a failed evaluation: Strudel's message, the line when
 * known, and a truthful note about what is (or isn't) still playing.
 */
export function evalFailedMessage(detail: string, line: number | undefined, tail: string): string {
  const clean = cleanErrorDetail(detail);
  const lineText = line !== undefined ? `, line ${line}` : '';
  return `Evaluation failed: ${clean}${lineText}. ${tail}`;
}

/**
 * Builds the tool-response notice line for a hand evaluation (Ctrl+Enter/Alt+Enter in the
 * page) that failed: same shape as evalFailedMessage, worded as a note (never a tool error —
 * only the failing evaluation itself, still visible in the editor, needs the user's
 * attention) and prefixed to distinguish it from a Claude-sent evaluation's own failure.
 */
export function handEvalFailedLine(detail: string, line: number | undefined, tail: string): string {
  const clean = cleanErrorDetail(detail);
  const lineText = line !== undefined ? `, line ${line}` : '';
  return `Note: an edit evaluated by hand in the page failed: ${clean}${lineText}. ${tail}`;
}

/**
 * Builds the tool-response notice line for a failed reconnect auto-replay (page/main.js's
 * 'hello' handler) — the page reverted its editor to blank and nothing is actually playing, so
 * the tail is always NOTHING_PLAYING_TAIL (unlike handEvalFailedLine, whose tail depends on
 * whatever else was already playing).
 */
export function reconnectEvalFailedLine(detail: string, line: number | undefined): string {
  const clean = cleanErrorDetail(detail);
  const lineText = line !== undefined ? `, line ${line}` : '';
  return `Note: reconnecting to the page failed to restore the last code: ${clean}${lineText}. ${NOTHING_PLAYING_TAIL}`;
}

export const EMPTY_CODE_MESSAGE = 'set_code needs non-empty Strudel code.';

export const MAX_RUNTIME_ERRORS = 10;

// A second, smaller cap on the *overflow* messages themselves — large enough that a
// page flooding a handful of distinct errors past MAX_RUNTIME_ERRORS still gets an exact
// "N more distinct" count, small enough that a runaway flood of many distinct messages can't
// grow memory without bound (each stored string can be up to MAX_DETAIL_CODE_POINTS long).
export const MAX_DROPPED_RUNTIME_ERRORS = 50;

// Bounded map of evaluate id -> recorded version id, so a runtime-error's
// version can be looked up at drain time without growing without bound over a long session.
export const MAX_TRACKED_EVALUATE_IDS = 50;

/**
 * Formats one drained runtime-error notice line. `message` is
 * already cleaned (see cleanErrorDetail) — this only adds the "repeated N times" prefix
 * and the trailing period. With a non-null versionId (the version whose evaluate
 * recorded this history entry), the line names it so Claude can tell which version a late
 * failure belongs to.
 */
export function runtimeErrorLine(message: string, count: number, versionId: number | null = null): string {
  if (versionId === null) {
    return count > 1
      ? `Runtime error while playing (repeated ${count} times): ${message}.`
      : `Runtime error while playing: ${message}.`;
  }
  return count > 1
    ? `Runtime error while playing #${versionId} (repeated ${count} times): ${message}.`
    : `Runtime error while playing #${versionId}: ${message}.`;
}

/**
 * Formats a drained runtime-error notice line for an error whose tag does not match
 * the evaluate id currently playing — it came from a version that already stopped playing, so
 * Claude must not treat it as a problem with the new code. With a
 * non-null versionId, names which earlier version it came from.
 */
export function earlierRuntimeErrorLine(message: string, count: number, versionId: number | null = null): string {
  if (versionId === null) {
    return count > 1
      ? `Runtime error from an earlier version (not the code playing now, repeated ${count} times): ${message}.`
      : `Runtime error from an earlier version (not the code playing now): ${message}.`;
  }
  return count > 1
    ? `Runtime error from an earlier version (#${versionId}, not the code playing now, repeated ${count} times): ${message}.`
    : `Runtime error from an earlier version (#${versionId}, not the code playing now): ${message}.`;
}

/** Every structure-note line in a reply starts with this, so no line of the page can start a reply line itself. */
export const STRUCTURE_NOTE_LEAD = 'Song structure';

/**
 * Cleans one structure-note line from the page: every run of whitespace, control, format, line and paragraph
 * separator characters becomes one space, then the text is cleaned like an error detail (trailing periods off, cut at
 * MAX_DETAIL_CODE_POINTS code points). Returns null for a line with nothing left, which is dropped.
 */
export function cleanStructureLine(text: string): string | null {
  const collapsed = text.replace(/[\s\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ').trim();
  if (collapsed === '') {
    return null;
  }
  return cleanErrorDetail(collapsed);
}

/** One structure-note line as it appears in a reply: the fixed lead, the version when it is known, the cleaned sentence. */
export function structureNoteLine(line: string, versionId: number | null = null): string {
  return versionId === null ? `${STRUCTURE_NOTE_LEAD}: ${line}.` : `${STRUCTURE_NOTE_LEAD} in #${versionId}: ${line}.`;
}

/**
 * The note Claude gets, once per distinct report, when a page could not load a script from unpkg.com. The fix is on
 * the user's side, so the note says so: Claude cannot repair a blocked network.
 */
export function loadFailureNote(failed: readonly LoadFailedScript[]): string {
  const head = 'Moontide page: a tab could not load';
  if (!failed.includes('strudel')) {
    return `${head} the acorn script from unpkg.com, so sound still plays there but the Timeline, Mixer, Parts, Jam and Instruments views cannot read the code. The fix is on the user's side: check that nothing blocks unpkg.com, then reload the page.`;
  }
  const scripts = failed.includes('acorn') ? 'the Strudel and acorn scripts' : 'the Strudel script';
  return `${head} ${scripts} from unpkg.com, so it shows a notice instead of the editor and cannot play. The fix is on the user's side: check the internet connection and that nothing blocks unpkg.com (an ad blocker, a firewall or a proxy), then reload the page.`;
}

/**
 * The note Claude gets, once, when a change it asked for a line did not take over. The cause is why:
 * Stop canceled it, a newer change replaced it, or the page that held it went away.
 */
export function takeoverCanceledLine(cycle: number, reason: 'stop' | 'replaced' | 'page'): string {
  const head = `Note: the change you sent for cycle ${cycle} did not take over:`;
  if (reason === 'stop') {
    return `${head} the music was stopped before then. get_code returns the code that played; the page editor still shows your change.`;
  }
  if (reason === 'replaced') {
    return `${head} a newer change replaced it before then.`;
  }
  return `${head} the page was closed, reloaded or replaced by another tab before then. get_code returns the code from before it.`;
}

/**
 * The note Claude gets, once, when a tempo ramp ended without Claude asking for it: a program stated another tempo, a
 * program stated no tempo, a step failed, or the page that ran it was closed, reloaded or replaced by another tab.
 * Stop, a finished ramp and a replaced ramp say nothing. Only the cause (a fixed word) and a number come in: no
 * page text. `bpm` is the tempo that plays after the end; the wording leaves it out when the page gave none.
 */
export function glideEndedLine(reason: 'other-tempo' | 'no-tempo' | 'error' | 'page', bpm?: number): string {
  const shown = bpm === undefined ? undefined : Number.isInteger(bpm) ? String(bpm) : bpm.toFixed(1);
  const head = 'Note: the tempo ramp ended early:';
  if (reason === 'other-tempo') {
    return `${head} a program stated another tempo${shown === undefined ? '' : `, and ${shown} BPM plays now`}.`;
  }
  if (reason === 'no-tempo') {
    return `${head} a program stated no tempo${shown === undefined ? '' : `, so the tempo stays at ${shown} BPM, where the ramp had got to`}.`;
  }
  if (reason === 'error') {
    return `${head} a step failed in the page${shown === undefined ? '' : `, so the tempo stays at ${shown} BPM`}.`;
  }
  return `${head} the page was closed, reloaded or replaced by another tab, so the tempo of the code plays.`;
}

/**
 * The note when a change that waited for its line took over and replaced code that had been edited by hand
 * in the page. Said at the takeover, never at the request: until the line the hand edit is still what plays, and a
 * change that is canceled or replaced replaces nothing.
 */
export function takeoverReplacedHandEditLine(cycle: number): string {
  return `Note: the change you sent for cycle ${cycle} took over and replaced code that had been edited by hand in the page since your last change.`;
}

type PendingKind = 'evaluate' | 'stop';

interface PendingRequest {
  kind: PendingKind;
  resolve(value: unknown): void;
  reject(err: Error): void;
  timer: NodeJS.Timeout;
  conn: PageConnection;
}

export interface DrainedNotices {
  lines: string[];
  hadRuntimeErrors: boolean;
}

/**
 * What a recorded version should carry, kept server-side by request id since the page's
 * `evaluated` reply never echoes it back.
 */
interface RecordIntent {
  label?: string;
  restoredFrom?: number;
  // Who caused this version: absent means Claude (set_code, restore_version); a restore asked
  // for from the page's History view carries 'page'.
  origin?: VersionOrigin;
  force: boolean;
  // When Claude asked the change to take over (absent means now).
  at?: ChangeTiming;
  // The phrase length Claude asked for with at: 'phrase' (absent means the default).
  phraseCycles?: number;
  // The number of bars Claude asked the tempo to move over (absent means no ramp).
  glideBars?: number;
  // The id of the page request this change answers, named by Claude (absent means it answers none).
  answering?: string;
  // The change is an edit applied on top of a hand-edited playing code, so at its takeover it carries the
  // hand edit instead of replacing it (absent means false).
  carriesHandEdit?: boolean;
  createdAt: number;
}

/**
 * The change that was accepted by the page and waits for its line. It keeps its own record intent
 * (the 60 s intent pruning cannot drop its label) and the code the page confirmed in the pending reply: the
 * takeover message carries only the id, so the history records this code and nothing the page sends later.
 */
interface WaitingChange {
  id: string;
  code: string;
  cycle: number;
  /** The timing Claude asked for; 'bar' when the intent was lost (the cycle is what matters then). */
  at: ChangeTiming;
  intent: RecordIntent | undefined;
  /** The ramp the page reported for this change (it starts at the line); becomes the recorded ramp at the takeover. */
  glide?: Extract<GlideReport, { state: 'at-line' }>;
}

/**
 * Owns the in-memory state Moontide's server needs: the last page-confirmed code,
 * the active page connection, and the pending evaluate requests.
 */
/** How many summarized drafts a session remembers. */
const MAX_SUMMARIZED_DRAFTS = 20;

/** A catalog drafted from a sound list, kept in the session until the user's yes. */
interface CatalogDraft {
  source: string;
  numbering: ProgramNumbering;
  overwrite: boolean;
  sounds: CatalogSound[];
  /** The drum kits of the draft, for a model whose rhythm channels take a bank. */
  kits: CatalogKit[];
  /** The summary of exactly these sounds was produced; every accepted part clears it. */
  summarized: boolean;
}

const lostCatalogDraftText = (id: string): string =>
  `No catalog draft for model "${id}" in this session (a draft is lost when the Moontide server restarts). Start again with the first part.`;

export class Session {
  private code = '';
  private activePage: PageConnection | null = null;
  private pageUrl = '';
  // Called after a page has become the active page; the starter uses it to end its bounded wait.
  private readonly pageAttachedListeners = new Set<() => void>();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly replyTimeoutMs: number;
  // The evaluate id whose code is playing now; null before any tagged success or
  // after a hand evaluation / reconnect replay (see attachPage, handleHandEval,
  // handleReconnectEvalFailed, handleEvaluated). Entries in runtimeErrors are formatted
  // against this value at drain time, not at arrival time (the new code's own errors can
  // arrive before its evaluated reply).
  private playingEvaluateId: string | null = null;
  // Insertion order = first-seen order (re-setting an existing Map key keeps its position).
  // Distinct entries are the pair (tag, cleaned message) — see handleRuntimeError.
  private readonly runtimeErrors = new Map<string, { tag: string | null; message: string; count: number }>();
  // Distinct messages that arrived after `runtimeErrors` filled up, so the "N more
  // distinct runtime errors" note stays accurate even when the same overflow message repeats
  // (a plain counter would count every repeat instead of every distinct message).
  // Bounded by MAX_DROPPED_RUNTIME_ERRORS so a flood of many distinct
  // overflow messages still can't grow memory without bound.
  private readonly droppedRuntimeErrors = new Set<string>();
  // The version each evaluate id recorded, looked up at drain time (see
  // rememberVersion/drainNotices) rather than stored on the runtime-error entry itself, since
  // the version isn't known until recordConfirmed returns, which can happen after the error
  // already arrived.
  private readonly versionByEvaluateId = new Map<string, number>();
  // A message that overflows both caps: it can no longer be told apart from a repeat of an
  // already-counted overflow message, so it's just tallied — this only slightly over-counts
  // the rare tail past MAX_RUNTIME_ERRORS + MAX_DROPPED_RUNTIME_ERRORS distinct messages.
  private droppedRuntimeErrorOverflowCount = 0;
  // The latest structure note of the active page (see handleStructureNote): one slot, replaced by every note and
  // emptied by the drain. The lines are already cleaned; the version id is looked up at drain time.
  private structureNote: { tag: string | null; lines: string[] } | null = null;
  // True once a stop is confirmed by the page; cleared by the next
  // successful evaluate() reply from the active page.
  private stopped = false;
  // True once a hand evaluation (Ctrl+Enter/Alt+Enter) changed the current
  // code; cleared by the next evaluate() reply from the active page, on time or late (the
  // stored code is Claude's again either way).
  private editedByHand = false;
  // When a Mixer message (not a hand evaluation) is what set editedByHand, the code from
  // before it and the code it left: a drag that ends where it began puts the code back, and the
  // flag goes with it. Only trusted while the stored code is still `after`.
  private mixerBaseline: { before: string; after: string } | null = null;
  // The newest failed hand evaluation's notice line, drained (and cleared) on the
  // next tool response; also cleared without emitting by a later successful hand-eval or
  // evaluate() reply (the failure no longer matters at that point).
  private handFailureLine: string | null = null;
  private readonly history: HistoryStore | null;
  private readonly recordIntents = new Map<string, RecordIntent>();
  // The change that waits for its line; get_code, the history and the version follow its takeover
  // message, never the request. One at most (last wins).
  private pendingChange: WaitingChange | null = null;
  // The notes of waiting changes that did not take over, queued once and drained once, like historyNotes.
  private readonly takeoverNotes: string[] = [];
  // The tempo ramp the page runs, as far as the server knows: set when a reply says a ramp started (or the takeover of a
  // change whose ramp starts at its line), cleared by Stop, a page end and a page loss. Null when none runs.
  private glide: { toBpm: number } | null = null;
  // The notes of a ramp that ended early, queued once and drained once, like takeoverNotes.
  private readonly glideNotes: string[] = [];
  // The notes of load failure reports a page sent, one per distinct text (at most three), drained once.
  private readonly loadFailureNotes = new Set<string>();
  // BPM: the tempo (rounded to one decimal) the last set_code or restore_version reply stated; null before any.
  private lastToldBpm: number | null = null;
  private readonly recordIntentTtlMs: number;
  // History-write-failure notes: queued once, drained once, same
  // "read once then clear" shape as handFailureLine.
  private readonly historyNotes: string[] = [];
  // The history id of the code currently loaded, pushed to the page as
  // { type: 'version', id }; null before any version has been recorded, or without a store.
  private currentVersionId: number | null = null;
  // Pages that sent history-request; each gets a history-add after every recorded
  // version. A page that never asked receives no history frame at all.
  private readonly historySubscribers = new Set<PageConnection>();
  // The pages that lost the active role to another page and are still connected (they were sent
  // `superseded`). They are told when no page is active, and again when one becomes active.
  private readonly supersededPages = new Set<PageConnection>();
  /** The page-to-Claude channel (tokens, trust, limits, queue, listener). */
  readonly ask: AskChannel;
  /** What became of each page request: started, waiting for its line, applied and the other states. */
  readonly requests: RequestStatusBoard;
  /** The MIDI facts of the active page, worded once per change into notice lines. */
  readonly midi: MidiChannel;
  // The setup file's store (null without one), the JSON of the last midi-rig each page was
  // sent (a push goes out only when it changed), and the state read last.
  private readonly rig: RigStore | null;
  private readonly rigPushed = new WeakMap<PageConnection, string>();
  private lastRig: RigState = { setup: 'absent' };
  // The setup file is worded once per change of its state: the notes wait here for the next tool
  // reply, and the key of the state said last (null before the first read) decides what is new.
  private readonly rigNotes: string[] = [];
  private lastRigKey: string | null = null;
  // The ids the user had switched off at the last valid read (file order); null before the first valid read.
  private lastOff: string[] | null = null;
  // Which served folders differ from the ones this server started with (null without a check, so
  // a Session built without one behaves as before). Asked at each page connection; the note waits for the
  // next tool reply and is queued once per transition into a changed state.
  private readonly build: BuildCheck | null;
  private readonly buildNotes: string[] = [];
  private lastBuildState: 'same' | 'server' | 'page' = 'same';
  // The canonical JSON of the last models whose summary was produced; a save is refused for any other model.
  private readonly summarizedDrafts: string[] = [];
  // Drafts of catalogs sent in parts live here for the session only; nothing is written before the yes.
  private readonly catalogDrafts = new Map<string, CatalogDraft>();
  // The last MIDI facts of the active page, kept to say whether a port is connected right now.
  private lastMidiFacts: MidiFacts | null = null;

  constructor(options?: {
    replyTimeoutMs?: number;
    history?: HistoryStore;
    recordIntentTtlMs?: number;
    askAckTimeoutMs?: number;
    rig?: RigStore;
    build?: BuildCheck;
  }) {
    this.replyTimeoutMs = options?.replyTimeoutMs ?? REPLY_TIMEOUT_MS;
    this.history = options?.history ?? null;
    this.rig = options?.rig ?? null;
    this.build = options?.build ?? null;
    this.recordIntentTtlMs = options?.recordIntentTtlMs ?? RECORD_INTENT_TTL_MS;
    const send = (conn: PageConnection, msg: ServerMessage, what: string): void => this.sendToPage(conn, msg, what);
    this.requests = new RequestStatusBoard({ send });
    this.ask = new AskChannel({
      send,
      board: this.requests,
      ackTimeoutMs: options?.askAckTimeoutMs,
    });
    this.midi = new MidiChannel();
  }

  /** A Moontide tool call began: the requests already handed to Claude are being worked on. */
  noteToolCall(): void {
    this.requests.noteToolCall();
  }

  /**
   * Claude closes an open page request in words. The sentence is cleaned first; one that is empty after
   * cleaning, and an id that is not an open request, are refused with a plain error and change nothing.
   */
  answerRequest(id: string, outcome: 'answered' | 'declined', text: string): void {
    const sentence = cleanAnswerText(text);
    if (sentence === '') {
      throw new Error('The sentence is empty after removing spaces and control characters; give one sentence of words.');
    }
    if (!this.requests.closed(id, outcome, sentence)) {
      throw new Error(NOT_OPEN_REQUEST_MESSAGE);
    }
  }

  /** Whether a page request with this id is on the board and not finished. */
  requestIsOpen(id: string): boolean {
    return this.requests.isOpen(id);
  }

  setPageUrl(url: string): void {
    this.pageUrl = url;
  }

  getPageUrl(): string {
    return this.pageUrl;
  }

  /** True while a page holds the active role. */
  hasActivePage(): boolean {
    return this.activePage !== null;
  }

  /**
   * Calls `listener` every time a page becomes the active page (after hello and the version push).
   * Returns a function that removes the listener.
   */
  onPageAttached(listener: () => void): () => void {
    this.pageAttachedListeners.add(listener);
    return () => {
      this.pageAttachedListeners.delete(listener);
    };
  }

  /**
   * The rejection of every request that needs a page. Loud in both cases: before the page URL is known
   * Moontide is not started, so the text says how to start it instead of naming an empty address.
   */
  private noPageError(): Error {
    return new Error(this.pageUrl === '' ? NOT_STARTED_MESSAGE : noPageMessage(this.pageUrl));
  }

  getCode(): string {
    return this.code;
  }

  /** The line of the change that waits to take over and the timing asked for; null when none waits. */
  waitingChange(): { cycle: number; at: ChangeTiming } | null {
    const waiting = this.pendingChange;
    return waiting === null ? null : { cycle: waiting.cycle, at: waiting.at };
  }

  /**
   * The waiting change did not take over. Queues its one note for the next tool reply. A no-op when
   * nothing waits, so a second cause (Stop, then a closing page) never adds a second line.
   */
  private dropWaitingChange(reason: 'stop' | 'replaced' | 'page'): void {
    const waiting = this.pendingChange;
    if (waiting === null) return;
    this.pendingChange = null;
    this.takeoverNotes.push(takeoverCanceledLine(waiting.cycle, reason));
    const answering = waiting.intent?.answering;
    if (answering === undefined) return;
    if (reason !== 'replaced') {
      this.requests.canceled(answering);
    } else if (!this.answeringStillCarried(answering, waiting.id)) {
      this.requests.replaced(answering);
    }
  }

  /**
   * The ramp ended. Clears the record and queues its one note for the next tool reply, except for a finished ramp and
   * for Stop, which are not told. A no-op when no ramp is recorded, so a second cause (a cancel, then a closing page)
   * never adds a second line.
   */
  private dropGlide(reason: 'finished' | 'stop' | 'other-tempo' | 'no-tempo' | 'error' | 'page', bpm?: number): void {
    if (this.glide === null) return;
    this.glide = null;
    if (reason === 'finished' || reason === 'stop') return;
    this.glideNotes.push(glideEndedLine(reason, bpm));
  }

  /**
   * Whether a change other than this one still in flight answers the same request. A newer change that
   * names the request carries its answer on, so the request must not end as replaced while that answer is
   * still coming: the newer change settles it (applied, failed or replaced in its turn).
   */
  private answeringStillCarried(answering: string, exceptEvaluateId: string): boolean {
    for (const [evaluateId, entry] of this.pending) {
      if (entry.kind === 'evaluate' && evaluateId !== exceptEvaluateId) {
        if (this.recordIntents.get(evaluateId)?.answering === answering) return true;
      }
    }
    return false;
  }

  /**
   * Keeps the change the page accepted for its line. One at most (last wins): a change that is
   * already waiting is replaced, with one stderr line and no notice, because the page reports replacements
   * itself (takeover-canceled 'replaced').
   */
  private keepWaitingChange(change: WaitingChange): void {
    const replaced = this.pendingChange;
    if (replaced !== null && replaced.id !== change.id) {
      console.error(
        `[moontide] A waiting change (${replaced.id}) was replaced by request ${change.id} without a cancel message`,
      );
      // The same rule as a cancel message: the request ends as replaced unless the new change answers it too.
      const answering = replaced.intent?.answering;
      if (answering !== undefined && answering !== change.intent?.answering) {
        this.requests.replaced(answering);
      }
    }
    this.pendingChange = change;
    if (change.intent?.answering !== undefined) {
      this.requests.line(change.intent.answering, change.at === 'phrase' ? 'phrase' : 'bar');
    }
  }

  /**
   * BPM: rounds the tempo of a reply to one decimal and says whether it differs from the last tempo a reply
   * stated. A reply without a tempo leaves the last told tempo alone.
   */
  private noteTempo(bpm: number | undefined, glide?: GlideReport): { bpm: number | null; tempoChanged: boolean } {
    // A reply that states a ramp says the ramp, not a tempo change: the ramp's target is the tempo told from here on, so the
    // next reply never announces it as a change when the ramp gets there.
    if (glide !== undefined) {
      const target = Math.round(glide.toBpm * 10) / 10;
      this.lastToldBpm = target;
      return { bpm: bpm === undefined ? null : Math.round(bpm * 10) / 10, tempoChanged: false };
    }
    if (bpm === undefined) return { bpm: null, tempoChanged: false };
    const rounded = Math.round(bpm * 10) / 10;
    const tempoChanged = this.lastToldBpm === null || this.lastToldBpm !== rounded;
    this.lastToldBpm = rounded;
    return { bpm: rounded, tempoChanged };
  }

  /**
   * The page becomes the active page once it has authenticated with page-auth (the last page to
   * authenticate wins); sends hello with the current confirmed code and the current
   * stopped flag — a page attaching while stopped must not auto-replay into sound.
   * The page that loses the role is told with `superseded` first, so it stops with
   * the MIDI panic instead of playing on beside the new page (two tabs would double every note).
   */
  private attachPage(conn: PageConnection): void {
    const previous = this.activePage;
    // A different page reports its own facts; the old page's state no longer applies.
    if (previous !== null && previous !== conn) {
      this.midi.clear();
      this.lastMidiFacts = null;
    }
    this.activePage = conn;
    // A change that waits does not survive a page taking the role: the page that held its gate is
    // gone or replays its code, so Claude is told once (the line is queued once however many causes meet).
    this.dropWaitingChange('page');
    this.dropGlide('page');
    this.supersededPages.delete(conn);
    if (previous !== null && previous !== conn) {
      this.supersededPages.add(previous);
      this.sendToPage(previous, { type: 'superseded' }, 'the superseded notice');
    } else if (previous === null) {
      // Nobody was active: the pages that were told so learn that a tab plays again.
      for (const page of this.supersededPages) {
        this.sendToPage(page, { type: 'superseded' }, 'the superseded notice');
      }
    }
    // A new page replays without a tag — it hasn't evaluated anything of its own yet.
    this.playingEvaluateId = null;
    // The mismatch, then the instruments, reach the page before hello (same socket, so the order
    // is guaranteed). Only a changed page folder is a mismatch for the page: it is then not the page this
    // server started with. The compiled code changing alone leaves the page and the server matching, so the
    // page gets the softer server-updated line (nothing is refused) and Claude is told to restart. The note
    // is queued once per transition into a changed state, not once per page.
    const change = this.build !== null ? this.build.changed() : { page: false, server: false };
    const state = change.page ? 'page' : change.server ? 'server' : 'same';
    if (state === 'page') this.sendToPage(conn, { type: 'build-mismatch' }, 'the build mismatch');
    else if (state === 'server') this.sendToPage(conn, { type: 'server-updated' }, 'the server-updated notice');
    if (state !== 'same' && state !== this.lastBuildState) {
      this.buildNotes.push(state === 'page' ? BUILD_MISMATCH_NOTE : BUILD_UPDATED_NOTE);
    }
    this.lastBuildState = state;
    this.syncRig();
    const hello: ServerMessage = { type: 'hello', code: this.code, stopped: this.stopped };
    conn.send(JSON.stringify(hello));
    if (this.history && this.currentVersionId !== null) {
      this.pushVersion(conn, this.currentVersionId);
    }
    // Last, so a listener sees a page that has already been told hello. A throwing listener never breaks the attach.
    for (const listener of [...this.pageAttachedListeners]) {
      try {
        listener();
      } catch (err) {
        console.error('[moontide] A page-attached listener failed:', err);
      }
    }
  }

  /**
   * Clears the active page only if it is this connection, and immediately rejects
   * every pending request that was sent on this connection — a tab closing mid-request must
   * not cost the caller the full reply timeout.
   */
  detachPage(conn: PageConnection): void {
    this.supersededPages.delete(conn);
    if (this.activePage === conn) {
      this.activePage = null;
      this.dropWaitingChange('page');
      this.dropGlide('page');
      this.midi.clear();
      this.lastMidiFacts = null;
      // A superseded tab says "playing in another tab": tell it that no tab plays any more, or it
      // stays in a dead end (Claude's tools say "no page" while a page is open).
      for (const page of this.supersededPages) {
        this.sendToPage(page, { type: 'no-active-page' }, 'the no-active-page notice');
      }
    }
    this.historySubscribers.delete(conn);
    this.ask.detachPage(conn);
    for (const [id, entry] of this.pending) {
      if (entry.conn === conn) {
        clearTimeout(entry.timer);
        this.pending.delete(id);
        entry.reject(this.noPageError());
      }
    }
  }

  /** Number of evaluate/stop requests still awaiting a reply, timeout, or detach. For tests/leak checks. */
  pendingCount(): number {
    return this.pending.size;
  }

  /** True once a stop is confirmed, cleared by the next successful evaluate. */
  isStopped(): boolean {
    return this.stopped;
  }

  /** True while the current code was last set by a hand evaluation, not Claude. */
  wasEditedByHand(): boolean {
    return this.editedByHand;
  }

  /** The history id of the code currently loaded; null before any version is recorded. */
  getCurrentVersionId(): number | null {
    return this.currentVersionId;
  }

  /** Number of record intents kept for in-flight or recently-timed-out evaluate requests. For leak tests. */
  recordIntentCount(): number {
    return this.recordIntents.size;
  }

  /** Number of evaluate ids currently mapped to a recorded version. For leak tests. */
  trackedEvaluateIdCount(): number {
    return this.versionByEvaluateId.size;
  }

  /**
   * Remembers which version an evaluate id recorded, so a runtime-error tagged with
   * that id can be labeled with its version at drain time. Skipped without a versionId (no
   * store, or a write failure). Re-setting an existing key moves it to the newest position
   * (insertion order), so the oldest MAX_TRACKED_EVALUATE_IDS-th entry is always the one
   * actually oldest by last-touched, not by first-touched.
   */
  private rememberVersion(evaluateId: string, versionId: number | null): void {
    if (versionId === null) return;
    this.versionByEvaluateId.delete(evaluateId);
    this.versionByEvaluateId.set(evaluateId, versionId);
    while (this.versionByEvaluateId.size > MAX_TRACKED_EVALUATE_IDS) {
      const oldestKey = this.versionByEvaluateId.keys().next().value;
      if (oldestKey === undefined) break;
      this.versionByEvaluateId.delete(oldestKey);
    }
  }

  /**
   * `conn` is the connection the message arrived on — required to tell a late reply from the
   * currently active page apart from one sent by a stale page that is still connected (a
   * previous page is not disconnected when a new one becomes active).
   *
   * The page token gates every message: page-auth with the current token trusts the
   * connection and attaches it as the active page; from a connection that has not presented the
   * token, an ask is answered with its token refusal and every other message is logged and ignored.
   */
  handlePageMessage(conn: PageConnection, msg: PageMessage): void {
    if (msg.type === 'page-auth') {
      const wasTrusted = this.ask.isTrusted(conn);
      this.ask.authenticate(conn, msg.token, () => {
        if (!wasTrusted) this.attachPage(conn);
      });
      return;
    }
    if (msg.type === 'load-failed') {
      // Before the trust gate on purpose: the report carries the page token itself, and answering it never
      // trusts or attaches the connection, so a failing tab cannot take the sound from a healthy one.
      const ok = this.ask.acceptReportToken(msg.token);
      if (ok) this.loadFailureNotes.add(loadFailureNote(msg.failed));
      this.sendToPage(conn, { type: 'load-failed-result', ok }, 'the load failure answer');
      return;
    }
    if (!this.ask.isTrusted(conn)) {
      if (msg.type === 'ask') {
        this.ask.handleAsk(conn, msg);
      } else {
        this.ask.refuseUntrusted(msg.type);
      }
      return;
    }
    // A take-over comes from a page that is not the active one, by design, so it has no
    // active-page guard. attachPage supersedes the current active page and answers with hello; from the
    // page that is already active it only re-sends hello.
    if (msg.type === 'take-over') {
      this.attachPage(conn);
      return;
    }
    if (msg.type === 'runtime-error') {
      this.handleRuntimeError(conn, msg);
      return;
    }
    if (msg.type === 'structure-note') {
      this.handleStructureNote(conn, msg);
      return;
    }
    if (msg.type === 'stop-result') {
      this.handleStopResult(conn, msg);
      return;
    }
    if (msg.type === 'takeover') {
      this.handleTakeover(conn, msg);
      return;
    }
    if (msg.type === 'takeover-canceled') {
      this.handleTakeoverCanceled(conn, msg);
      return;
    }
    if (msg.type === 'glide-ended') {
      this.handleGlideEnded(conn, msg);
      return;
    }
    if (msg.type === 'user-stopped') {
      this.handleUserStopped(conn);
      return;
    }
    if (msg.type === 'midi-state') {
      this.handleMidiState(conn, msg);
      return;
    }
    if (msg.type === 'hand-eval') {
      this.handleHandEval(conn, msg);
      return;
    }
    if (msg.type === 'reconnect-eval-failed') {
      this.handleReconnectEvalFailed(conn, msg);
      return;
    }
    if (msg.type === 'part-launch') {
      this.handlePartLaunch(conn, msg);
      return;
    }
    if (msg.type === 'mixer-live') {
      this.handleMixerLive(conn, msg);
      return;
    }
    if (msg.type === 'mixer-record') {
      this.handleMixerRecord(conn, msg);
      return;
    }
    if (msg.type === 'instrument-switch') {
      this.handleInstrumentSwitch(conn, msg);
      return;
    }
    if (msg.type === 'instrument-settings') {
      this.handleInstrumentSettings(conn, msg);
      return;
    }
    // An ask is not gated by conn === activePage (any authenticated tab may ask).
    if (msg.type === 'ask') {
      this.ask.handleAsk(conn, msg);
      return;
    }
    if (msg.type === 'ask-board-request') {
      const requests = this.requests.snapshotFor(conn);
      // The board told the page where each request stands; the hand-over messages that follow reach it too.
      this.ask.adoptOrigin(conn, requests.map((row) => row.id));
      this.sendToPage(conn, { type: 'ask-board', requests }, 'the request board');
      return;
    }
    if (msg.type === 'history-request') {
      this.handleHistoryRequest(conn);
      return;
    }
    if (msg.type === 'data-folder-request') {
      this.handleDataFolderRequest(conn);
      return;
    }
    if (msg.type === 'history-restore') {
      this.handleHistoryRestore(conn, msg.id);
      return;
    }
    if (msg.type === 'history-more') {
      this.handleHistoryMore(conn, msg.before);
      return;
    }
    this.handleEvaluated(conn, msg);
  }

  /**
   * A page asks for the history. It is subscribed to live additions and answered with
   * the newest window. Read-only, so a request from a page that is not the active one is still
   * answered: it only receives code it already saw through hello.
   */
  private handleHistoryRequest(conn: PageConnection): void {
    this.historySubscribers.add(conn);
    this.sendHistoryWindow(conn);
  }

  /**
   * A page that presented the page token asks where the Moontide data folder is, so the
   * Instruments view can say where to create instruments.json. Read-only, so a trusted page that is not the
   * active one is answered too, like history-request. The path is whole or null, never cut: null when there is
   * no setup store, when the folder cannot be resolved, when it holds a control character or when it is longer
   * than MAX_DATA_FOLDER_LENGTH. Each null case logs its cause and never the path (the folder can hold the OS
   * user name).
   */
  private handleDataFolderRequest(conn: PageConnection): void {
    let path: string | null = null;
    if (this.rig !== null) {
      let folder: string | null = null;
      try {
        folder = this.rig.resolveDataDir();
      } catch {
        console.error('[moontide] The data folder was requested but it could not be resolved');
      }
      if (folder !== null) {
        if (CONTROL_CHARS.test(folder)) {
          console.error('[moontide] The data folder was requested but its path holds a control character');
        } else if (folder.length > MAX_DATA_FOLDER_LENGTH) {
          console.error(`[moontide] The data folder was requested but its path is longer than ${MAX_DATA_FOLDER_LENGTH} characters`);
        } else if (folder === '') {
          console.error('[moontide] The data folder was requested but its path is empty');
        } else {
          path = folder;
        }
      }
    }
    this.sendToPage(conn, { type: 'data-folder', path }, 'the data folder');
  }

  /**
   * A page asks for the versions older than the oldest row it holds. Read-only, so a
   * page that is not the active one is answered too. A cursor that is no longer in the file (a
   * compaction dropped it) is logged and answered with a fresh window, never an error. A file that
   * cannot be read is answered with history-older-error, so the page keeps the rows it holds.
   */
  private handleHistoryMore(conn: PageConnection, before: number): void {
    if (!this.history) {
      console.error('[moontide] Older history was requested but no history store is configured');
      this.sendToPage(conn, { type: 'history-error' }, 'the history error');
      return;
    }
    let msg: ServerMessage;
    try {
      const window = this.history.readWindow({ before, limit: HISTORY_WINDOW_SIZE });
      if (window === null) {
        console.error(
          `[moontide] The page asked for versions older than #${before}, which is no longer in the history; sending a fresh list`,
        );
        this.sendHistoryWindow(conn);
        return;
      }
      msg = { type: 'history-older', versions: window.versions, beyond: window.beyond, remaining: window.remaining };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[moontide] Could not read older history for the page: ${reason}`);
      this.sendToPage(conn, { type: 'history-older-error' }, 'the older history error');
      return;
    }
    this.sendToPage(conn, msg, 'older history');
  }

  /** Sends one page the newest window of the history, or history-error when it cannot be read. */
  private sendHistoryWindow(conn: PageConnection): void {
    if (!this.history) {
      console.error('[moontide] History was requested but no history store is configured');
      this.sendToPage(conn, { type: 'history-error' }, 'the history error');
      return;
    }
    let msg: ServerMessage;
    try {
      msg = { type: 'history', ...this.history.readWindow({ limit: HISTORY_WINDOW_SIZE }) };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[moontide] Could not read the history for the page: ${reason}`);
      this.sendToPage(conn, { type: 'history-error' }, 'the history error');
      return;
    }
    this.sendToPage(conn, msg, 'the history');
  }

  /**
   * A version brought back from the page's History view. Only the active page's
   * request is trusted (same rule as a hand edit or a part launch). It goes through the exact
   * path restore_version uses, recorded as a new entry with origin 'page' — never a rewrite of
   * history. No tool call waits on it, so a failure is logged here and the page shows the
   * evaluation error itself.
   */
  private handleHistoryRestore(conn: PageConnection, id: number): void {
    if (conn !== this.activePage) {
      console.error('[moontide] Ignoring history restore from a non-active page');
      return;
    }
    if (!this.history) {
      console.error('[moontide] The page asked to restore a version but no history store is configured');
      this.sendToPage(conn, { type: 'history-error' }, 'the history error');
      return;
    }
    let known: boolean;
    try {
      known = this.history.getVersion(id) !== null;
    } catch (err) {
      // An unreadable store is a real fault, not an unknown id: say so, never "not in the history".
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[moontide] Could not look up #${id} for a page restore: ${reason}`);
      this.sendToPage(conn, { type: 'history-error' }, 'the history error');
      return;
    }
    if (!known) {
      console.error(`[moontide] The page asked to restore #${id}, which is not in the history`);
      this.sendHistoryWindow(conn);
      return;
    }
    this.restoreVersion(id, { origin: 'page' }).catch((err: unknown) => {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[moontide] Page restore of #${id} did not complete: ${reason}`);
    });
  }

  /**
   * Reads the setup file now and pushes it to the active page when it is not absent or its
   * state changed since the last push to that page (a page that never saw a file hears nothing, so a
   * setup without a file behaves exactly as before). Never throws: a failing read is an invalid state.
   * Called when a page attaches and before every evaluation, so a fixed file applies on the next change.
   */
  syncRig(): RigState {
    if (this.rig === null) return { setup: 'absent' };
    let state: RigState;
    let message;
    try {
      state = this.rig.read();
      message = rigMessage(state);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      state = { setup: 'invalid', problems: [{ field: RIG_FILE_NAME, reason: `could not be checked: ${reason}` }], more: 0 };
      message = rigMessage(state);
    }
    this.lastRig = state;
    // The port lines of the notices name the instrument of a valid file; without one they stay as they were.
    this.midi.setInstruments(new Map(state.setup === 'valid' ? state.instruments.map((instrument) => [instrument.port, instrument.id]) : []));
    this.noteRigChange(state);
    this.noteOffChange(state);
    // Claude hears no port notice about an instrument the user switched off.
    this.midi.setSwitchedOff(new Set(state.setup === 'valid' ? state.instruments.filter((instrument) => !instrument.enabled).map((instrument) => instrument.port) : []));
    const conn = this.activePage;
    if (conn !== null) {
      const json = JSON.stringify(message);
      const before = this.rigPushed.get(conn);
      if (json !== before && (before !== undefined || state.setup !== 'absent')) {
        this.sendToPage(conn, message, 'the MIDI rig');
        this.rigPushed.set(conn, json);
      }
    }
    return state;
  }

  /**
   * Queues one line for Claude when the setup file's state changed since it was last read: an invalid
   * file (at first sight or with other problems), a file valid again after an invalid one, a file
   * removed after it was there. A first valid or first absent read says nothing, and the same state
   * again says nothing.
   */
  private noteRigChange(state: RigState): void {
    const key = state.setup === 'invalid' ? `invalid:${JSON.stringify([state.problems, state.more])}` : state.setup;
    if (key === this.lastRigKey) return;
    const before = this.lastRigKey;
    this.lastRigKey = key;
    if (state.setup === 'invalid') {
      this.rigNotes.push(rigInvalidLine(state.problems, state.more));
    } else if (state.setup === 'valid' && before !== null && before.startsWith('invalid:')) {
      this.rigNotes.push(rigValidAgainLine(state.instruments.length));
    } else if (state.setup === 'absent' && before !== null) {
      this.rigNotes.push(rigRemovedLine());
    }
  }

  /**
   * Queues what changed in the user's on/off choice, once. A valid state compares the ids that
   * are off now (file order) with the last valid read: the first read says the ids already off in one line, a later
   * read says the ids newly off, then the ids newly on that are still in the file. An invalid state changes nothing
   * (the last valid set stays the base); an absent state forgets it, so the next valid read is a first read again.
   */
  private noteOffChange(state: RigState): void {
    if (state.setup === 'absent') {
      this.lastOff = null;
      return;
    }
    if (state.setup !== 'valid') return;
    const off = state.instruments.filter((instrument) => !instrument.enabled).map((instrument) => instrument.id);
    const before = this.lastOff;
    this.lastOff = off;
    if (before === null) {
      if (off.length > 0) this.rigNotes.push(rigOffAtStartLine(off));
      return;
    }
    const nowOff = off.filter((id) => !before.includes(id));
    const nowOn = before.filter((id) => !off.includes(id) && state.instruments.some((instrument) => instrument.id === id));
    if (nowOff.length > 0) this.rigNotes.push(rigSwitchedOffLine(nowOff));
    if (nowOn.length > 0) this.rigNotes.push(rigSwitchedOnLine(nowOn));
  }

  /** Sends one server message to a page; a closed socket logs instead of throwing. */
  private sendToPage(conn: PageConnection, msg: ServerMessage, what: string): void {
    try {
      conn.send(JSON.stringify(msg));
    } catch {
      console.error(`[moontide] Could not send ${what} to the page`);
    }
  }

  /**
   * An unsolicited report that the user evaluated code by hand in the
   * page (Ctrl+Enter/Alt+Enter). Only the active page's report is trusted — a stale page's
   * report doesn't reflect what is actually playing, same rule as handleUserStopped.
   * A success becomes the current code (the flag is set only when it actually differs, so
   * re-evaluating unchanged code by hand adds no note) and resumes sound (the user's own
   * evaluation always brings it back, mirroring the page's resume-after-stop step). A
   * failure stores handEvalFailedLine's notice, drained by the next tool response
   * (drainNotices); the tail is computed now, from the state at the moment the failure
   * arrives, not when it's later drained.
   *
   * Empty or whitespace-only code (clearing the editor and pressing Ctrl+Enter) is
   * never recorded. A version is code that actually played, and empty code
   * plays nothing. The reader's schema stays strict on purpose — this guard just makes sure
   * recordConfirmed is never called with it, so the reader is never asked to accept a line it
   * would reject.
   */
  private handleHandEval(conn: PageConnection, msg: Extract<PageMessage, { type: 'hand-eval' }>): void {
    if (conn !== this.activePage) {
      console.error('[moontide] Ignoring hand edit from a non-active page');
      return;
    }
    if (msg.ok) {
      if (msg.code.trim() === '') {
        if (this.code !== '') {
          this.editedByHand = true;
        }
        this.code = '';
        this.stopped = false;
        this.handFailureLine = null;
        this.playingEvaluateId = null;
        if (this.history) {
          // The page's editor no longer shows any recorded version — tell it so, the same
          // way a history write failure does (recordConfirmed's pushVersion(conn, null)).
          this.currentVersionId = null;
          this.pushVersion(conn, null);
        }
        return;
      }
      if (msg.code !== this.code) {
        this.editedByHand = true;
      }
      this.code = msg.code;
      this.stopped = false;
      this.handFailureLine = null;
      // A hand evaluation carries no tag of its own — its errors (and any error still
      // to come from the code it replaced) are untagged/earlier from here on.
      this.playingEvaluateId = null;
      // Hand edits are recorded too (the store's same-code rule makes
      // re-evaluating unchanged code by hand a no-op on disk).
      this.recordConfirmed(conn, msg.code, 'hand', { label: HAND_EDIT_LABEL, force: false });
      return;
    }
    const tail = this.code === '' ? NOTHING_PLAYING_TAIL : this.stopped ? STILL_STOPPED_TAIL : STILL_PLAYING_TAIL;
    this.handFailureLine = handEvalFailedLine(msg.error, msg.line, tail);
  }

  /**
   * An unsolicited report that a part was launched from the page's Parts view.
   * Mirrors handleHandEval above: only the active page's launch is trusted,
   * and the empty-code rule applies (a version is code that played). Unlike a hand edit,
   * this is recorded with its own origin 'page' and a 'launched <part>' label, so it reads
   * differently in history — but it still counts as a hand-made change to the code (the user
   * changed the code from the page), so the existing hand-edit notes stay truthful.
   */
  private handlePartLaunch(conn: PageConnection, msg: Extract<PageMessage, { type: 'part-launch' }>): void {
    if (conn !== this.activePage) {
      console.error('[moontide] Ignoring part launch from a non-active page');
      return;
    }
    if (msg.code.trim() === '') {
      console.error('[moontide] Ignoring part launch with empty code');
      return;
    }
    if (msg.code !== this.code) {
      this.editedByHand = true;
    }
    this.code = msg.code;
    this.stopped = false;
    this.handFailureLine = null;
    this.playingEvaluateId = null;
    this.recordConfirmed(conn, msg.code, 'page', { label: partLaunchLabel(msg.part), force: false });
  }

  /**
   * The user's switch on an instrument card. Behind the trust gate, and only the active page
   * may change the state (a stale tab must not switch an instrument while another tab plays). The message
   * sets the state, it never toggles, so a repeated request cannot flip twice. The order is: write the
   * state file, push the rig (syncRig), then answer, so the page applies the new rig before it clears its
   * pending look. Every request is answered once, loudly: a page that is not the active one, a missing or invalid
   * instruments.json, an unknown instrument and a data folder that cannot be found are 'refused' with a plain
   * reason; a state file that cannot be written is 'write-failed' and changes nothing (no rig push). No reply
   * and no log line holds the data folder path (it can hold the OS user name). A request equal to the current
   * state is answered ok with no write and no push.
   */
  private handleInstrumentSwitch(conn: PageConnection, msg: Extract<PageMessage, { type: 'instrument-switch' }>): void {
    const refuse = (reason: string): void => {
      this.sendToPage(conn, { type: 'instrument-result', id: msg.id, ok: false, kind: 'refused', reason: cleanProblemText(reason) }, 'the instrument switch result');
    };
    if (conn !== this.activePage) {
      console.error('[moontide] Refused an instrument switch from a non-active page');
      refuse('this tab is not the one that plays, so nothing was switched');
      return;
    }
    const state = this.syncRig();
    if (this.rig === null || state.setup === 'absent') {
      refuse('there is no instruments.json, so there is nothing to switch');
      return;
    }
    if (state.setup === 'invalid') {
      refuse('instruments.json has a problem, so nothing was switched');
      return;
    }
    const instrument = state.instruments.find((candidate) => candidate.id === msg.instrument);
    if (instrument === undefined) {
      refuse(`there is no instrument "${cleanProblemText(msg.instrument)}" in instruments.json`);
      return;
    }
    if (instrument.enabled === msg.enabled) {
      this.sendToPage(conn, { type: 'instrument-result', id: msg.id, ok: true }, 'the instrument switch result');
      return;
    }
    // The off list keeps file order: every instrument that is off after the change, the asked one by the request.
    // Ids the state file held for instruments the file no longer has are dropped here.
    const off = state.instruments
      .filter((candidate) => (candidate.id === msg.instrument ? !msg.enabled : !candidate.enabled))
      .map((candidate) => candidate.id);
    let dataDir: string;
    try {
      dataDir = this.rig.resolveDataDir();
    } catch {
      // The cause can name the data folder, which can hold the OS user name: it is not logged.
      console.error('[moontide] An instrument switch could not find the Moontide data folder');
      refuse('the Moontide data folder could not be found, so nothing was switched');
      return;
    }
    try {
      writeRigState({ dataDir, off });
    } catch (err) {
      const reason = err instanceof RigStateSaveError ? err.message : 'the choice could not be saved (unknown error); nothing changed';
      // RigStateSaveError carries an error code and never a path; any other error is answered, then rethrown.
      if (err instanceof RigStateSaveError) console.error(`[moontide] An instrument switch could not be saved: ${err.code}`);
      this.sendToPage(conn, { type: 'instrument-result', id: msg.id, ok: false, kind: 'write-failed', reason }, 'the instrument switch result');
      if (!(err instanceof RigStateSaveError)) throw err;
      return;
    }
    this.syncRig();
    this.sendToPage(conn, { type: 'instrument-result', id: msg.id, ok: true }, 'the instrument switch result');
  }

  /**
   * The user's edit of an instrument's port, channels and clock. Behind the trust gate, and only the
   * active page may write the user's instruments.json (with one writer, the last valid write wins). Only the
   * active page gets the rig push (syncRig); a superseded tab shows no cards, only the notice that another tab
   * plays, and sees the current rig when it takes the role back. applyInstrumentSettings validates with the code that reads the file and
   * writes atomically; this maps its outcome to the one instrument-result the page gets. A saved edit queues one
   * line for Claude, pushes the new rig and then answers, so the page applies the rig first. Reasons pass
   * cleanProblemText and carry no path: the data folder can hold the OS user name.
   */
  private handleInstrumentSettings(conn: PageConnection, msg: Extract<PageMessage, { type: 'instrument-settings' }>): void {
    const answer = (result: Extract<ServerMessage, { type: 'instrument-result' }>): void => {
      this.sendToPage(conn, result, 'the instrument settings result');
    };
    const refuse = (reason: string): void => {
      answer({ type: 'instrument-result', id: msg.id, ok: false, kind: 'refused', reason: cleanProblemText(reason) });
    };
    if (conn !== this.activePage) {
      console.error('[moontide] Refused an instrument settings edit from a non-active page');
      refuse('this tab is not the one that plays, so nothing was saved');
      return;
    }
    if (this.rig === null) {
      refuse('there is no instruments.json, so there is nothing to change');
      return;
    }
    const outcome = applyInstrumentSettings(this.rig, msg.instrument, msg.settings);
    if (outcome.kind === 'saved') {
      this.rigNotes.push(rigSettingsLine(outcome.before, outcome.after));
      this.syncRig();
      answer({ type: 'instrument-result', id: msg.id, ok: true });
    } else if (outcome.kind === 'unchanged') {
      answer({ type: 'instrument-result', id: msg.id, ok: true });
    } else if (outcome.kind === 'invalid') {
      answer({ type: 'instrument-result', id: msg.id, ok: false, kind: 'invalid', problems: outcome.problems, more: outcome.more });
    } else if (outcome.kind === 'write-failed') {
      console.error(`[moontide] Instrument settings could not be saved: ${cleanProblemText(outcome.reason)}`);
      answer({ type: 'instrument-result', id: msg.id, ok: false, kind: 'write-failed', reason: cleanProblemText(outcome.reason) });
    } else {
      refuse(outcome.reason);
    }
  }

  /**
   * The code playing during a Mixer gesture. The page has already evaluated it and
   * records nothing per movement, so this only keeps get_code truthful: no history line,
   * no version push. Same trust rule as handlePartLaunch above (only the active page's message
   * counts, and the empty-code rule applies). `stopped` is left alone: a mixer move is
   * not a request to play, and the page evaluates it without restarting sound while stopped.
   */
  private handleMixerLive(conn: PageConnection, msg: Extract<PageMessage, { type: 'mixer-live' }>): void {
    if (conn !== this.activePage) {
      console.error('[moontide] Ignoring mixer change from a non-active page');
      return;
    }
    if (msg.code.trim() === '') {
      console.error('[moontide] Ignoring mixer change with empty code');
      return;
    }
    this.noteMixerCode(msg.code);
    this.code = msg.code;
    this.handFailureLine = null;
    this.playingEvaluateId = null;
  }

  /**
   * The editedByHand flag for a Mixer message carrying `code`, called before `this.code` is
   * replaced. A message that changes the code sets the flag, like a part launch; when the flag was
   * clear before it, the old code is remembered so that a later message bringing it back (a drag
   * that ends where it began) clears the flag again. A flag set by a hand evaluation stays set.
   */
  private noteMixerCode(code: string): void {
    if (code === this.code) return;
    const baseline = this.mixerBaseline;
    if (!this.editedByHand) {
      this.mixerBaseline = { before: this.code, after: code };
    } else if (baseline !== null && baseline.after === this.code) {
      baseline.after = code;
    } else {
      this.mixerBaseline = null;
    }
    this.editedByHand = true;
    if (this.mixerBaseline !== null && code === this.mixerBaseline.before) {
      this.editedByHand = false;
      this.mixerBaseline = null;
    }
  }

  /**
   * One Mixer gesture, sent about 1.5 s after its last move. Mirrors
   * handlePartLaunch: origin 'page' with the gesture's own label, and the parent link comes from
   * recordConfirmed. Unlike a part launch it leaves `stopped` alone (a move while the page is
   * stopped is evaluated without restarting sound). The store's same-code rule makes a drag that
   * ends where it began a no-op.
   */
  private handleMixerRecord(conn: PageConnection, msg: Extract<PageMessage, { type: 'mixer-record' }>): void {
    if (conn !== this.activePage) {
      console.error('[moontide] Ignoring mixer record from a non-active page');
      return;
    }
    if (msg.code.trim() === '') {
      console.error('[moontide] Ignoring mixer record with empty code');
      return;
    }
    this.noteMixerCode(msg.code);
    this.code = msg.code;
    this.handFailureLine = null;
    this.playingEvaluateId = null;
    this.recordConfirmed(conn, msg.code, 'page', { label: msg.label, force: false });
  }

  /**
   * An unsolicited report that the 'hello' auto-replay evaluation failed on
   * reconnect (page/main.js reverted its editor to blank rather than leave broken code
   * showing as if it were playing). Only the active page's report is trusted, same
   * rule as every other unsolicited page message. `this.code` is cleared so a subsequent
   * get_code/set_code sees the truth ("nothing is playing"), matching what the page itself
   * now shows; the failure is queued as a notice, drained by the next tool response, the
   * same way a failed hand evaluation is (handleHandEval above).
   */
  private handleReconnectEvalFailed(
    conn: PageConnection,
    msg: Extract<PageMessage, { type: 'reconnect-eval-failed' }>,
  ): void {
    if (conn !== this.activePage) {
      console.error('[moontide] Ignoring reconnect-eval-failed from a non-active page');
      return;
    }
    this.code = '';
    this.editedByHand = false;
    this.handFailureLine = reconnectEvalFailedLine(msg.error, msg.line);
    this.currentVersionId = null;
    // Nothing of Claude's is playing after a reverted replay — no tag applies.
    this.playingEvaluateId = null;
  }

  /**
   * An unsolicited report that the user stopped sound in the page itself
   * (the Stop button, or Strudel's own Ctrl+./Alt+. shortcut). Only the active page's report
   * is trusted — a stale page's report doesn't reflect what is actually playing.
   */
  private handleUserStopped(conn: PageConnection): void {
    if (conn !== this.activePage) {
      console.error('[moontide] Ignoring stop report from a non-active page');
      return;
    }
    this.stopped = true;
    // Stop ends a ramp too; it is the user's own act, so Claude is not told.
    this.dropGlide('stop');
    // A stop the page reports ends a wait too; the page's takeover-canceled for the same id (sent
    // just before) already queued the line, and a second cause adds nothing.
    this.dropWaitingChange('stop');
  }

  private handleEvaluated(conn: PageConnection, msg: Extract<PageMessage, { type: 'evaluated' }>): void {
    const entry = this.pending.get(msg.id);
    if (!entry) {
      // Late reply: arrived after the request already timed out or its page detached. The
      // record intent is taken (read and deleted) in every late case — a pruned or missing
      // intent still records, just without a label.
      const lateIntent = this.recordIntents.get(msg.id);
      this.recordIntents.delete(msg.id);
      if (msg.ok && conn === this.activePage && msg.pending !== undefined) {
        // A late reply of a change that waits for its line: it does not play yet, so it is kept
        // for its takeover message like an on-time one (nothing is stored or recorded now).
        this.keepWaitingChange({
          id: msg.id,
          code: msg.code,
          cycle: msg.pending.cycle,
          at: lateIntent?.at ?? 'bar',
          intent: lateIntent,
          ...(msg.glide?.state === 'at-line' ? { glide: msg.glide } : {}),
        });
        console.error(`[moontide] Late pending confirmation kept for request ${msg.id}`);
      } else if (msg.ok && conn === this.activePage) {
        // A late success still reflects what actually plays now — keep it truthful.
        const previousCode = this.code;
        this.code = msg.code;
        // This request's id is now the tag for "the code playing now".
        this.playingEvaluateId = msg.id;
        // Same rule as the on-time success path below — the page's own
        // audio value is authoritative, including when a stop landed while this late reply
        // was still in flight.
        this.stopped = msg.audio === 'stopped';
        // The stored code is Claude's again, whether or not the previous code was a
        // hand edit — no pending entry means no EvalOutcome to carry replacedHandEdit on.
        // Except a restore asked for from the page — the user changed the music, so
        // the flag is set when the code differs and otherwise left as it was.
        const lateOrigin = lateIntent?.origin ?? 'claude';
        this.editedByHand = this.editedByHandAfter(lateOrigin, previousCode, msg.code);
        this.handFailureLine = null;
        const lateVersionId = this.recordConfirmed(conn, msg.code, lateOrigin, lateIntent);
        this.rememberVersion(msg.id, lateVersionId);
        // A reply whose audio is stopped records no ramp: Stop ends every ramp, so none runs.
        // An at-line report on a reply with no pending line is a waiting change that already took over: its ramp started at its line.
        if ((msg.glide?.state === 'started' || msg.glide?.state === 'at-line') && msg.audio !== 'stopped') {
          this.glide = { toBpm: msg.glide.toBpm };
        }
        // This branch does not pass through confirmSuccess, so it tells the page itself.
        if (lateIntent?.answering !== undefined) {
          this.requests.applied(lateIntent.answering, lateVersionId);
        }
        console.error(`[moontide] Late confirmation stored for request ${msg.id}`);
      } else if (msg.ok) {
        // Came from a page that is no longer active: it doesn't reflect what the active
        // page is playing, so discard it rather than overwrite the confirmed code.
        console.error(`[moontide] Ignoring late success for request ${msg.id} from a non-active page`);
      } else {
        console.error(`[moontide] Ignoring late failure for request ${msg.id}: ${msg.error}`);
      }
      return;
    }
    if (entry.kind !== 'evaluate') {
      // A reply of the wrong kind must never resolve the wrong request.
      console.error(
        `[moontide] Ignoring 'evaluated' reply for request ${msg.id}: pending request is a '${entry.kind}', not an 'evaluate'`,
      );
      return;
    }
    clearTimeout(entry.timer);
    this.pending.delete(msg.id);
    if (msg.ok) {
      if (conn === this.activePage) {
        const intent = this.recordIntents.get(msg.id);
        this.recordIntents.delete(msg.id);
        if (msg.pending !== undefined) {
          // Accepted, but the old code still plays until the line: nothing is stored or recorded
          // yet (code, history, stopped, editedByHand and the playing evaluate id stay as they are). The
          // takeover message does that, with the code and the intent kept here.
          this.keepWaitingChange({
            id: msg.id,
            code: msg.code,
            cycle: msg.pending.cycle,
            at: intent?.at ?? 'bar',
            intent,
            ...(msg.glide?.state === 'at-line' ? { glide: msg.glide } : {}),
          });
          entry.resolve({
            code: msg.code,
            audio: msg.audio,
            // Nothing is replaced yet: the takeover says so when the hand edit really was replaced.
            replacedHandEdit: false,
            versionId: null,
            pending: msg.pending,
            ...this.noteTempo(msg.bpm, msg.glide),
            ...(msg.glide !== undefined ? { glide: msg.glide } : {}),
          });
        } else {
          const { replacedHandEdit, versionId } = this.confirmSuccess(conn, msg.id, msg.code, msg.audio, intent);
          // A reply whose audio is stopped states and records no ramp: Stop ends every ramp, so none runs.
          const glide = msg.audio === 'stopped' ? undefined : msg.glide;
          // A ramp this change started is the one the server tells about when it ends early; a running report leaves the record.
          // An at-line report here is a waiting change that already took over when it was answered: its ramp started at its line.
          if (glide?.state === 'started' || glide?.state === 'at-line') this.glide = { toBpm: glide.toBpm };
          entry.resolve({
            code: msg.code,
            audio: msg.audio,
            replacedHandEdit,
            versionId,
            ...this.noteTempo(msg.bpm, glide),
            ...(glide !== undefined ? { glide } : {}),
          });
        }
      } else {
        // Came from a page that stopped being active while the request was still
        // pending: it doesn't reflect what the active page is playing, so
        // reject rather than silently hand the caller a false "ok" (same defect
        // class as the late-reply case above).
        console.error(`[moontide] Ignoring success for request ${msg.id} from a non-active page`);
        this.recordIntents.delete(msg.id);
        entry.reject(new Error(STALE_PAGE_MESSAGE));
      }
    } else {
      const failedIntent = this.recordIntents.get(msg.id);
      this.recordIntents.delete(msg.id);
      const failedFor = failedIntent?.answering;
      // The same rule as a replaced change: an earlier change for the same request that still waits for
      // its line, or is still on its way, carries the answer on and settles the request in its turn.
      // A ramp the page refused was refused whole and nothing changed, so the request stays open for the change Claude sends
      // next (without glideBars), which can still answer it.
      if (
        msg.glideRefused !== true &&
        failedFor !== undefined &&
        this.pendingChange?.intent?.answering !== failedFor &&
        !this.answeringStillCarried(failedFor, msg.id)
      ) {
        this.requests.failed(failedFor, cleanErrorDetail(msg.error));
      }
      if (msg.glideRefused === true) {
        // The page's own refusal text, whole: it already says that nothing was changed, so no evaluation-failure tail is added.
        entry.reject(new Error(cleanRefusal(msg.error)));
        return;
      }
      const tail = this.code === '' ? NOTHING_PLAYING_TAIL : this.stopped ? STILL_STOPPED_TAIL : STILL_PLAYING_TAIL;
      entry.reject(new Error(evalFailedMessage(msg.error, msg.line, tail)));
    }
  }

  /**
   * The bookkeeping of a change that plays now, shared by an on-time evaluated reply and by the takeover of a
   * waiting change (never by a late reply, which keeps its own log line). Store only what the page
   * confirmed as successfully evaluated. This request's id is now the tag for "the code playing now".
   * The page's own audio value is authoritative: a stop that landed while this evaluate was in
   * flight re-silences the just-autostarted scheduler and reports audio 'stopped', so trust it over assuming
   * success clears the stop. Whatever the code replaced, including a hand edit, is captured and then the
   * flag is cleared: the stored code is Claude's again either way.
   */
  private confirmSuccess(
    conn: PageConnection,
    id: string,
    code: string,
    audio: AudioState,
    intent: RecordIntent | undefined,
  ): { replacedHandEdit: boolean; versionId: number | null } {
    const previousCode = this.code;
    this.code = code;
    this.playingEvaluateId = id;
    this.stopped = audio === 'stopped';
    const replacedHandEdit = this.editedByHand;
    const origin = intent?.origin ?? 'claude';
    this.editedByHand = this.editedByHandAfter(origin, previousCode, code);
    this.handFailureLine = null;
    const versionId = this.recordConfirmed(conn, code, origin, intent);
    this.rememberVersion(id, versionId);
    if (intent?.answering !== undefined) {
      this.requests.applied(intent.answering, versionId);
    }
    return { replacedHandEdit, versionId };
  }

  /**
   * The page says the waiting change is audible now. Accepted only from the active page and only for
   * the id of the change that waits; anything else is one stderr line and changes nothing. The message carries
   * the id and, when the ramp the waiting change started at its line still runs, `glideRuns: true`; the recorded code
   * is the one stored from the pending reply, and the ramp record is set from `glideRuns` (or cleared without it) for a
   * change that asked for a ramp.
   */
  private handleTakeover(conn: PageConnection, msg: Extract<PageMessage, { type: 'takeover' }>): void {
    if (conn !== this.activePage) {
      console.error('[moontide] Ignoring takeover from a non-active page');
      return;
    }
    const waiting = this.pendingChange;
    if (waiting === null || waiting.id !== msg.id) {
      console.error(`[moontide] Ignoring takeover for request ${msg.id}: no such change is waiting`);
      return;
    }
    this.pendingChange = null;
    const { replacedHandEdit } = this.confirmSuccess(conn, waiting.id, waiting.code, 'playing', waiting.intent);
    // A change that asked for a ramp at its line ended any older ramp there. Its own ramp is the recorded ramp from here on only
    // when the page says it still runs; otherwise none runs (nothing to ramp between, or it already ended) and the record is
    // cleared with no line. A change replaced or canceled before its line never gets here.
    if (waiting.glide !== undefined) this.glide = msg.glideRuns === true ? { toBpm: waiting.glide.toBpm } : null;
    // An edit that carried a hand edit replaced nothing of it: the Mixer and Parts refuse while a change
    // waits and a hand evaluation cancels the wait, so the code playing at this takeover is still the hand-edited
    // text the edit was built on, and the note would be false.
    if (replacedHandEdit && waiting.intent?.carriesHandEdit !== true) {
      this.takeoverNotes.push(takeoverReplacedHandEditLine(waiting.cycle));
    }
  }

  /**
   * The page says the waiting change will not take over (Stop, or a newer change). Accepted only from
   * the active page and only for the id of the change that waits (so a cancel that arrives after the server
   * already dropped the change for the same cause queues nothing more); the notice wording is the server's.
   */
  private handleTakeoverCanceled(conn: PageConnection, msg: Extract<PageMessage, { type: 'takeover-canceled' }>): void {
    if (conn !== this.activePage) {
      console.error('[moontide] Ignoring takeover-canceled from a non-active page');
      return;
    }
    const waiting = this.pendingChange;
    if (waiting === null || waiting.id !== msg.id) {
      console.error(`[moontide] Ignoring takeover-canceled for request ${msg.id}: no such change is waiting`);
      return;
    }
    this.dropWaitingChange(msg.reason);
  }

  /**
   * The page says its tempo ramp ended on its own. Only the active page is trusted; the numbers are bounded by the
   * protocol schema and the wording is the server's.
   */
  private handleGlideEnded(conn: PageConnection, msg: Extract<PageMessage, { type: 'glide-ended' }>): void {
    if (conn !== this.activePage) {
      console.error('[moontide] Ignoring glide-ended from a non-active page');
      return;
    }
    this.dropGlide(msg.reason, msg.bpm === undefined ? undefined : Math.round(msg.bpm * 10) / 10);
  }

  /**
   * The editedByHand flag after a confirmed evaluation: Claude's code makes the stored code
   * Claude's again (false). A change made from the page (origin 'page') is the user's:
   * the flag is set only when the code actually differs, and otherwise left as it was, the same
   * rule handlePartLaunch applies, so the hand-edit notes stay truthful.
   */
  private editedByHandAfter(origin: VersionOrigin, previousCode: string, newCode: string): boolean {
    if (origin !== 'page') return false;
    return newCode !== previousCode ? true : this.editedByHand;
  }

  /**
   * Records a confirmed version and pushes its id to the page;
   * returns null without a store configured. A write failure never fails the calling
   * evaluation — it queues a one-shot note instead, drained by the
   * next tool response, logs to stderr, and still pushes { type: 'version', id: null }.
   */
  private recordConfirmed(
    conn: PageConnection,
    code: string,
    origin: VersionOrigin,
    intent: RecordIntent | { label?: string; restoredFrom?: number; force: boolean } | undefined,
  ): number | null {
    if (!this.history) return null;
    let versionId: number | null;
    let recorded = false;
    let compacted = false;
    try {
      const result = this.history.recordVersion({
        code,
        origin,
        label: intent?.label,
        restoredFrom: intent?.restoredFrom,
        // A restore hangs off what it restored; otherwise the version playing now. With
        // nothing loaded the store falls back to the newest version in the file, which is how a
        // new session continues its branch (a restart replays no code).
        parent: intent?.restoredFrom ?? this.currentVersionId ?? undefined,
        force: intent?.force,
      });
      versionId = result.id;
      recorded = result.recorded;
      compacted = result.dropped !== undefined;
      // A dropped-versions or trim-failed note rides the response of whichever tool
      // recorded this version, or the next tool response after a hand edit — same one-shot
      // queue as historyWriteFailedNote below.
      for (const note of result.notes) {
        this.historyNotes.push(note);
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.historyNotes.push(historyWriteFailedNote(reason));
      console.error(`[moontide] Could not save version to history: ${reason}`);
      versionId = null;
    }
    this.currentVersionId = versionId;
    this.pushVersion(conn, versionId);
    if (versionId !== null && recorded) {
      if (compacted) {
        // A compaction dropped old versions: every subscriber gets a fresh window so its list
        // never shows a version the file no longer has, instead of one more row.
        for (const subscriber of this.historySubscribers) this.sendHistoryWindow(subscriber);
      } else {
        this.pushHistoryAdd();
      }
    }
    return versionId;
  }

  /**
   * Pushes the page its version id. A closed socket logs instead of throwing. A restored
   * version carries `restoredFrom` in the same message, so the top bar never shows a
   * wrong "from"; every other version stays exactly { type: 'version', id }.
   */
  private pushVersion(conn: PageConnection, id: number | null): void {
    const msg: ServerMessage = { type: 'version', id };
    if (id !== null && this.history) {
      try {
        const restoredFrom = this.history.getVersion(id)?.restoredFrom;
        if (restoredFrom !== undefined) msg.restoredFrom = restoredFrom;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.error(`[moontide] Could not look up where version #${id} came from: ${reason}`);
      }
    }
    try {
      conn.send(JSON.stringify(msg));
    } catch {
      console.error('[moontide] Could not send the version id to the page');
    }
  }

  /**
   * After a newly recorded version, sends the newest row to every page that asked for the
   * history. When that row cannot be read, each page gets a fresh window instead (which is
   * history-error only if the list really cannot be read), so one failed read never leaves a list
   * the page had already loaded stuck in the terminal error state.
   */
  private pushHistoryAdd(): void {
    if (this.historySubscribers.size === 0 || !this.history) return;
    let msg: ServerMessage;
    try {
      const window = this.history.readWindow({ limit: 1 });
      msg = { type: 'history-add', version: window.versions[0], total: window.total };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[moontide] Could not read the history for the page: ${reason}`);
      for (const subscriber of this.historySubscribers) {
        this.sendHistoryWindow(subscriber);
      }
      return;
    }
    for (const subscriber of this.historySubscribers) {
      this.sendToPage(subscriber, msg, 'the history update');
    }
  }

  /** Without a store, history has nothing useful to do, so this is a tool error. */
  listHistory(options: { limit?: number; filter?: string; favoritesOnly?: boolean } = {}): string {
    if (!this.history) {
      throw new Error(historyUnavailableMessage('no history store is configured'));
    }
    try {
      return this.history.listText(options);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(historyUnavailableMessage(reason));
    }
  }

  /**
   * Keeps a version as a named favorite, or renames it if it already had one. A
   * HistoryError (disk read/write failure) becomes the same history-unavailable text
   * list_history and restore_version use; a not-found id or an empty name pass through
   * unchanged (those are the caller's own mistake, not a history-availability problem).
   */
  favoriteVersion(id: number, name: string): string {
    if (!this.history) {
      throw new Error(historyUnavailableMessage('no history store is configured'));
    }
    try {
      const { renamed } = this.history.favorite(id, name);
      const normalized = normalizeText(name);
      // Pages that asked for the history learn the new favorite name at once.
      for (const subscriber of this.historySubscribers) {
        this.sendToPage(subscriber, { type: 'history-favorite', id, name: normalized }, 'the favorite update');
      }
      return renamed ? favoriteRenamedMessage(id, normalized) : favoriteSavedMessage(id, normalized);
    } catch (err) {
      if (err instanceof HistoryError) {
        throw new Error(historyUnavailableMessage(err.message));
      }
      throw err;
    }
  }

  /**
   * Reply to a stop() request. Mirrors handleEvaluated's late-reply,
   * wrong-kind and stale-page handling, generalized to a void-outcome request.
   */
  private handleStopResult(conn: PageConnection, msg: Extract<PageMessage, { type: 'stop-result' }>): void {
    const entry = this.pending.get(msg.id);
    if (!entry) {
      // Late reply: arrived after the request already timed out or its page detached.
      if (conn === this.activePage) {
        // A late stop confirmation still reflects reality — the page did stop.
        this.stopped = true;
        this.dropGlide('stop');
        this.dropWaitingChange('stop');
        console.error(`[moontide] Late stop confirmation stored for request ${msg.id}`);
      } else {
        console.error(`[moontide] Ignoring late stop confirmation for request ${msg.id} from a non-active page`);
      }
      return;
    }
    if (entry.kind !== 'stop') {
      // A reply of the wrong kind must never resolve the wrong request.
      console.error(
        `[moontide] Ignoring 'stop-result' reply for request ${msg.id}: pending request is a '${entry.kind}', not a 'stop'`,
      );
      return;
    }
    clearTimeout(entry.timer);
    this.pending.delete(msg.id);
    if (conn === this.activePage) {
      this.stopped = true;
      this.dropGlide('stop');
      this.dropWaitingChange('stop');
      entry.resolve(undefined);
    } else {
      // Came from a page that stopped being active while the request was still pending:
      // same defect class as handleEvaluated's stale-page rejection above.
      console.error(`[moontide] Ignoring stop confirmation for request ${msg.id} from a non-active page`);
      entry.reject(new Error(STALE_PAGE_MESSAGE));
    }
  }

  /**
   * An unsolicited runtime error while a pattern plays. Recorded only from
   * the active page — a stale page's report doesn't reflect what is actually
   * playing. Distinct (tag, cleaned message) pairs are kept in first-seen order (cleaned via
   * cleanErrorDetail), capped at MAX_RUNTIME_ERRORS; beyond the cap, the extra
   * distinct pairs are only counted, not stored in full (see drainNotices' dropped-count
   * note) — a repeat of an already-overflowed pair counts once, not once per occurrence.
   * The tag itself is kept as-is (not compared to playingEvaluateId here) — whether
   * an entry is "current" or "from an earlier version" is decided at drain time, in
   * drainNotices, since the new code's own errors can arrive before its evaluated reply.
   */
  private handleRuntimeError(conn: PageConnection, msg: Extract<PageMessage, { type: 'runtime-error' }>): void {
    if (conn !== this.activePage) {
      console.error('[moontide] Ignoring runtime error from a non-active page');
      return;
    }
    const cleaned = cleanErrorDetail(msg.message);
    const tag = msg.evaluateId ?? null;
    // evaluateId is validated to be 1-64 characters (never ''), so '' safely stands in for
    // "no tag" in this composite key without ever colliding with a real tag.
    const key = `${tag ?? ''}\u0000${cleaned}`;
    const existing = this.runtimeErrors.get(key);
    if (existing !== undefined) {
      existing.count++;
    } else if (this.runtimeErrors.size < MAX_RUNTIME_ERRORS) {
      this.runtimeErrors.set(key, { tag, message: cleaned, count: 1 });
    } else if (this.droppedRuntimeErrors.has(key)) {
      // Already counted as one distinct overflow entry — a repeat adds nothing.
    } else if (this.droppedRuntimeErrors.size < MAX_DROPPED_RUNTIME_ERRORS) {
      this.droppedRuntimeErrors.add(key);
    } else {
      this.droppedRuntimeErrorOverflowCount++;
    }
  }

  /**
   * What the page read from the song structure of the code that plays. Accepted only from the active page, like a
   * runtime error. The latest note replaces the earlier one (an empty list clears it); every line is cleaned here and
   * the drain puts a fixed lead and the version in front of it. A note is a fact about the structure, never a runtime
   * error, so it never changes the status of a reply.
   */
  private handleStructureNote(conn: PageConnection, msg: Extract<PageMessage, { type: 'structure-note' }>): void {
    if (conn !== this.activePage) {
      console.error('[moontide] Ignoring a structure note from a non-active page');
      return;
    }
    const lines: string[] = [];
    for (const raw of msg.lines) {
      const cleaned = cleanStructureLine(raw);
      if (cleaned !== null) {
        lines.push(cleaned);
      }
    }
    this.structureNote = { tag: msg.evaluateId ?? null, lines };
  }

  /**
   * The MIDI facts of the page. Used only from the active page, like a runtime error:
   * a stale page's facts do not describe what is playing.
   */
  private handleMidiState(conn: PageConnection, msg: Extract<PageMessage, { type: 'midi-state' }>): void {
    if (conn !== this.activePage) {
      console.error('[moontide] Ignoring a MIDI state from a non-active page');
      return;
    }
    this.midi.update(msg);
    this.lastMidiFacts = msg;
  }

  /**
   * What get_midi_instruments says. The setup file is read now (syncRig also gives the page
   * the same state), then worded as facts; "connected right now" comes from the last facts of the
   * active page. Throws only for an instrument id the file does not hold.
   */
  instrumentsReply(instrument?: string): string {
    const state = this.syncRig();
    const options = {
      connection: (port: string) => connectionOf(port, this.lastMidiFacts),
      shipped: this.rig?.shippedModelList() ?? [],
      dataDirText: this.rig?.dataDirText() ?? 'unknown',
    };
    return instrument === undefined ? describeRig(state, options) : describeInstrument(state, instrument, options);
  }

  /**
   * What search_midi_sounds says. The setup file is read now (as for get_midi_instruments), then
   * the catalog of the instrument is searched and worded as facts. Throws a reason when there is
   * nothing to search: no instruments, an unknown instrument, no catalog, no words, an unknown category.
   */
  searchMidiSounds(options: { instrument: string; query?: string; category?: string }): string {
    const state = this.syncRig();
    return describeSearch(state, options, {
      connection: (port: string) => connectionOf(port, this.lastMidiFacts),
      shipped: this.rig?.shippedModelList() ?? [],
      dataDirText: this.rig?.dataDirText() ?? 'unknown',
    });
  }

  /**
   * The two steps of saving an instrument model drafted from a manual. The model is checked
   * with the same schema as every model. With confirmed false the summary comes back and the model is
   * remembered; with confirmed true only a model whose summary was produced earlier in this session is
   * saved, into the data folder, then the setup file is read again so a rig that names it applies at once.
   * Throws the reply text on every refusal. No instruments.json is ever written here.
   */
  saveMidiModel(options: { model: Record<string, unknown>; confirmed: boolean; overwrite?: boolean }): string {
    const parsed = parseModel(options.model);
    if (!parsed.ok) throw new Error(invalidModelText(parsed.problems));
    const { model } = parsed;
    if (this.rig?.shippedModelIds().includes(model.id)) throw new Error(shippedIdText(model.id));
    const key = JSON.stringify(model);
    if (!options.confirmed) {
      if (!this.summarizedDrafts.includes(key)) {
        this.summarizedDrafts.push(key);
        if (this.summarizedDrafts.length > MAX_SUMMARIZED_DRAFTS) this.summarizedDrafts.shift();
      }
      return `${summarizeDraft(model)}\nNot saved. Show this summary to the user; call save_midi_model again with the same model and confirmed: true after they say yes.`;
    }
    if (!this.summarizedDrafts.includes(key)) {
      throw new Error('Call save_midi_model with confirmed: false first, show the summary to the user, and save only after they say yes.');
    }
    let dataDir: string;
    try {
      if (this.rig === null) throw new Error('no setup store');
      dataDir = this.rig.resolveDataDir();
    } catch {
      throw new Error('The Moontide data folder is not available, so the model cannot be saved.');
    }
    try {
      saveUserModel({ dataDir, model, overwrite: options.overwrite === true });
    } catch (err) {
      if (err instanceof ModelSaveError) throw new Error(err.message);
      throw err;
    }
    this.syncRig();
    return `Saved model "${model.id}" in the Moontide data folder (models/${model.id}.json). instruments.json can now use it with "model": "${model.id}".`;
  }

  /**
   * The two steps of saving a sound catalog drafted from a sound list the user gave Claude. A
   * part (a call without confirmed true) is checked with the same rules as a catalog file and kept in
   * the draft of its model; the last part answers a summary and marks the draft summarized. A confirm
   * carries no sound: it saves only a draft whose summary was produced and not changed since, into the
   * data folder, then the setup file is read again so the rig and the page get the catalog at once.
   * Throws the reply text on every refusal. No instruments.json and no model file is ever written here.
   */
  saveMidiCatalog(options: {
    model: string;
    confirmed?: boolean;
    append?: boolean;
    more?: boolean;
    source?: string;
    programNumbering?: ProgramNumbering;
    overwrite?: boolean;
    banks?: CatalogPartGroup[];
  }): string {
    const idCheck = modelIdSchema.safeParse(options.model);
    if (!idCheck.success) throw new Error(`model: ${idCheck.error.issues[0]?.message ?? 'is not a model id'}`);
    const id = idCheck.data;
    const rig = this.rig;
    let dataDir: string;
    try {
      if (rig === null) throw new Error('no setup store');
      dataDir = rig.resolveDataDir();
    } catch {
      throw new Error('The Moontide data folder is not available, so the catalog cannot be saved.');
    }
    const found = rig.modelFor(id);
    if (!found.ok) throw new Error(problemsText(`Model "${id}" cannot be used for a catalog:`, found.problems));
    const { model } = found;

    if (options.confirmed === true) {
      const extras = [options.banks, options.source, options.programNumbering, options.append, options.more, options.overwrite];
      if (extras.some((extra) => extra !== undefined)) {
        throw new Error('A confirmation takes only model and confirmed: true; the sounds are already in the draft.');
      }
      const draft = this.catalogDrafts.get(id);
      if (draft === undefined) throw new Error(lostCatalogDraftText(id));
      if (!draft.summarized) {
        throw new Error('Call save_midi_catalog with the last part first, show the summary to the user, and save only after they say yes.');
      }
      const checked = parseCatalog({ model: id, source: draft.source, sounds: draft.sounds, ...(draft.kits.length > 0 ? { kits: draft.kits } : {}) }, model);
      if (!checked.ok) throw new Error(problemsText(`The draft no longer fits model "${id}":`, checked.problems));
      try {
        saveCatalog({ dataDir, catalog: checked.catalog, replace: draft.overwrite });
      } catch (err) {
        if (err instanceof CatalogSaveError) {
          throw new Error(
            err.code === 'exists'
              ? `catalogs/${id}.json already exists in the Moontide data folder; start the draft again with overwrite: true to replace it.`
              : `The catalog of model "${id}" could not be saved: ${err.code}.`,
          );
        }
        throw err;
      }
      this.catalogDrafts.delete(id);
      this.syncRig();
      return (
        `Saved the catalog of model "${id}" in the Moontide data folder (catalogs/${id}.json): ${draft.kits.length === 0 ? `${draft.sounds.length} sounds` : countText(draft.sounds.length, draft.kits.length)}. ` +
        `An instrument of instruments.json with "model": "${id}" can now choose them, and search_midi_sounds finds them.`
      );
    }

    const { banks } = options;
    if (banks === undefined || banks.every((group) => group.sounds.length === 0)) {
      throw new Error('Send the sounds in banks: [{ category, bank, sounds: [{ program, name }] }], at most 500 sounds per call.');
    }
    const inPart = banks.reduce((total, group) => total + group.sounds.length, 0);
    if (inPart > MAX_PART_SOUNDS) throw new Error(`This part holds ${inPart} sounds; send at most 500 per call.`);

    // The draft this part would extend: the model's own when appending, a new one when starting. A
    // starting part replaces the model's older draft only once it is accepted.
    let base: CatalogDraft;
    if (options.append === true) {
      const existing = this.catalogDrafts.get(id);
      if (existing === undefined) throw new Error(lostCatalogDraftText(id));
      const same = (field: string, given: unknown, have: unknown): void => {
        if (given !== undefined && given !== have) throw new Error(`This part says ${field} ${JSON.stringify(given)} but the draft has ${JSON.stringify(have)}.`);
      };
      same('source', options.source, existing.source);
      same('programNumbering', options.programNumbering, existing.numbering);
      same('overwrite', options.overwrite, existing.overwrite);
      base = existing;
    } else {
      if (options.source === undefined || options.programNumbering === undefined) {
        throw new Error('A new draft needs source and programNumbering ("from-0" or "from-1").');
      }
      if (options.overwrite !== true && catalogFileExists(dataDir, id)) {
        throw new Error(`catalogs/${id}.json already exists in the Moontide data folder; start the draft with overwrite: true to replace it.`);
      }
      base = { source: options.source, numbering: options.programNumbering, overwrite: options.overwrite === true, sounds: [], kits: [], summarized: false };
    }

    // The part is checked with the draft so far, by the rules of a catalog file; a refusal leaves the draft as it was.
    const flat = flattenCatalogPart(banks, base.numbering);
    const total = base.sounds.length + flat.sounds.length;
    if (total > MAX_CATALOG_SOUNDS) throw new Error(`The draft would hold ${total} sounds; a catalog holds at most ${MAX_CATALOG_SOUNDS}.`);
    const totalKits = base.kits.length + flat.kits.length;
    if (totalKits > MAX_CATALOG_KITS) throw new Error(`The draft would hold ${totalKits} drum kits; a catalog holds at most ${MAX_CATALOG_KITS}.`);
    if (flat.problems.length > 0) throw new Error(problemsText('The part was not added:', flat.problems));
    const sounds = [...base.sounds, ...flat.sounds];
    const kits = [...base.kits, ...flat.kits];
    const checked = parseCatalog({ model: id, source: base.source, sounds, ...(kits.length > 0 ? { kits } : {}) }, model);
    if (!checked.ok) {
      // A sound or kit of this part is named where the call put it (banks[g].sounds[j]), not by its place in the draft.
      const own = checked.problems.map((problem) => {
        const at = /^(sounds|kits)\[(\d+)\](.*)$/.exec(problem.field);
        if (at === null) return problem;
        const isKit = at[1] === 'kits';
        const where = (isKit ? flat.kitPaths : flat.paths)[Number(at[2]) - (isKit ? base.kits.length : base.sounds.length)];
        return where === undefined ? problem : { ...problem, field: `${where}${at[3]}` };
      });
      throw new Error(problemsText('The part was not added:', own));
    }

    // Accepted: every accepted part clears the summarized mark; only a last part sets it again.
    const draft: CatalogDraft = { ...base, sounds, kits, summarized: options.more !== true };
    let dropped = '';
    if (options.append !== true) {
      this.catalogDrafts.delete(id);
      if (this.catalogDrafts.size >= MAX_CATALOG_DRAFTS) {
        const [oldest] = this.catalogDrafts.keys();
        if (oldest !== undefined) {
          this.catalogDrafts.delete(oldest);
          dropped = `\nThe draft for model "${oldest}" was dropped: a session holds at most ${MAX_CATALOG_DRAFTS} catalog drafts.`;
        }
      }
    }
    this.catalogDrafts.set(id, draft);
    if (options.more === true) {
      return `Draft catalog for model "${id}": ${kits.length === 0 ? `${sounds.length} sounds` : countText(sounds.length, kits.length)} so far, not saved. Send the next part with append: true, and more: true while parts remain.${dropped}`;
    }
    const summary = summarizeCatalog({
      catalog: checked.catalog,
      model,
      numbering: draft.numbering,
      replaces: draft.overwrite && catalogFileExists(dataDir, id),
    });
    return `${summary}\nNot saved. Show this summary to the user; call save_midi_catalog again with model "${id}" and confirmed: true after they say yes.${dropped}`;
  }

  /**
   * Drains every notice collected since the last call: the newest failed-hand-evaluation
   * line first, then one line per distinct runtime error (with its repeat count),
   * then a dropped-count note if any distinct message overflowed MAX_RUNTIME_ERRORS. Every
   * tool response appends these lines. Each runtime-error entry is formatted
   * here, at drain time, not at arrival time — the new code's own errors can arrive before
   * its evaluated reply sets playingEvaluateId. An entry whose tag matches playingEvaluateId
   * is current (runtimeErrorLine); any other entry — including an untagged one while some
   * other tagged code plays — is from an earlier version (earlierRuntimeErrorLine).
   * hadRuntimeErrors is true only when at least one entry matches playingEvaluateId, so
   * Claude is never told the new code has errors that actually belong to an earlier one.
   */
  drainNotices(): DrainedNotices {
    const lines: string[] = [...this.loadFailureNotes];
    this.loadFailureNotes.clear();
    if (this.handFailureLine !== null) {
      lines.push(this.handFailureLine);
      this.handFailureLine = null;
    }
    let hadRuntimeErrors = false;
    for (const { tag, message, count } of this.runtimeErrors.values()) {
      // Looked up at drain time, not arrival time — the version an evaluate id
      // recorded may not be known yet when its error first arrives.
      const versionId = tag !== null ? this.versionByEvaluateId.get(tag) ?? null : null;
      if (tag === this.playingEvaluateId) {
        hadRuntimeErrors = true;
        lines.push(runtimeErrorLine(message, count, versionId));
      } else {
        lines.push(earlierRuntimeErrorLine(message, count, versionId));
      }
    }
    const n = this.droppedRuntimeErrors.size + this.droppedRuntimeErrorOverflowCount;
    if (n > 0) {
      lines.push(
        n === 1
          ? 'Note: 1 more distinct runtime error was not shown.'
          : `Note: ${n} more distinct runtime errors were not shown.`,
      );
    }
    if (this.structureNote !== null) {
      const { tag, lines: noteLines } = this.structureNote;
      const versionId = tag !== null ? this.versionByEvaluateId.get(tag) ?? null : null;
      for (const line of noteLines) {
        lines.push(structureNoteLine(line, versionId));
      }
      this.structureNote = null;
    }
    this.runtimeErrors.clear();
    this.droppedRuntimeErrors.clear();
    this.droppedRuntimeErrorOverflowCount = 0;
    // The unreadable-lines note (from the most recent load) is appended right before the
    // queued history notes, so the first tool response after the file is read carries it once.
    const unreadableNote = this.history?.takeUnreadableNote() ?? null;
    if (unreadableNote !== null) {
      lines.push(unreadableNote);
    }
    for (const note of this.historyNotes) {
      lines.push(note);
    }
    this.historyNotes.length = 0;
    // A change that waited for a line and did not take over, told once.
    lines.push(...this.takeoverNotes);
    this.takeoverNotes.length = 0;
    // A tempo ramp that ended early, told once.
    lines.push(...this.glideNotes);
    this.glideNotes.length = 0;
    // The build line comes before the setup file lines, then the MIDI lines, then the ask
    // lines (the arming line stays last). Runtime error lines and the history notes come earlier.
    lines.push(...this.buildNotes);
    this.buildNotes.length = 0;
    lines.push(...this.rigNotes);
    this.rigNotes.length = 0;
    lines.push(...this.midi.drainLines());
    // Waiting page requests first, then the arming line. The arming line is gated on an
    // authenticated page, so replies to clients with no page keep their exact text.
    lines.push(...this.ask.drainLines({ scriptPath: listenerScriptPath(), port: this.pagePort() }));
    return { lines, hadRuntimeErrors };
  }

  /** The port of the page address, or null when it is not known (an empty or unparsable address). */
  pagePort(): number | null {
    try {
      const port = Number(new URL(this.pageUrl).port);
      return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
    } catch {
      return null;
    }
  }

  /**
   * Shared request/reply core for both evaluate() and stop(): no active page rejects
   * immediately; otherwise sends `buildMessage(id)`, tracks a pending entry (recording the
   * connection and `kind` so a reply can never resolve the wrong kind of request), and
   * times out after replyTimeoutMs. A throwing send clears the timer/entry and rejects with
   * the same no-page message (the socket turned out not to be usable after all).
   */
  private sendRequest<T>(kind: PendingKind, buildMessage: (id: string) => ServerMessage): Promise<T> {
    const page = this.activePage;
    if (!page) {
      return Promise.reject(this.noPageError());
    }
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // A reply that outlasts the budget while the page waits for the MIDI permission
        // prompt says so, instead of the not-responding text.
        reject(new Error(this.midi.isAwaitingPermission() ? MIDI_PERMISSION_WAIT_MESSAGE : NOT_RESPONDING_MESSAGE));
      }, this.replyTimeoutMs);
      this.pending.set(id, {
        kind,
        resolve: resolve as unknown as (value: unknown) => void,
        reject,
        timer,
        conn: page,
      });
      const message = buildMessage(id);
      try {
        page.send(JSON.stringify(message));
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(this.noPageError());
      }
    });
  }

  evaluate(
    code: string,
    options?: { label?: string; at?: ChangeTiming; phraseCycles?: number; glideBars?: number; answering?: string },
  ): Promise<EvalOutcome> {
    if (code.trim() === '') {
      return Promise.reject(new Error(EMPTY_CODE_MESSAGE));
    }
    return this.sendEvaluate(code, {
      label: options?.label,
      force: false,
      at: options?.at,
      phraseCycles: options?.phraseCycles,
      glideBars: options?.glideBars,
      answering: options?.answering,
    });
  }

  /**
   * Changes part of the code that will play by exact replacements, all or none. The base is the
   * newest code that will play: the waiting change's code when a change waits for its bar or phrase line, else the
   * confirmed code, which already holds evaluated hand edits, part launches and Mixer moves. Text typed in the page
   * but not evaluated is replaced by the page, as for set_code. One path with set_code: the composed program goes
   * through sendEvaluate, so the checks, the timing, the history entry and the notices are the same.
   */
  editCode(
    edits: readonly EditInput[],
    options?: { base?: number; label?: string; at?: ChangeTiming; phraseCycles?: number; glideBars?: number; answering?: string },
  ): Promise<EditOutcome> {
    // First, so the text and the speed equal set_code's.
    if (this.activePage === null) {
      return Promise.reject(this.noPageError());
    }
    // An evaluate the page has not answered yet moves the code that will play, but only at its reply. An edit composed
    // now would be built on the old code, and the page would play the later whole program: one change would vanish
    // while both replies said "done". Refuse loudly instead (a set_code still in flight counts too).
    for (const entry of this.pending.values()) {
      if (entry.kind === 'evaluate') {
        return Promise.reject(new Error(EDIT_IN_FLIGHT_MESSAGE));
      }
    }
    const waiting = this.pendingChange;
    const baseText = waiting !== null ? waiting.code : this.code;
    if (baseText.trim() === '') {
      return Promise.reject(new Error(EDIT_NOTHING_PLAYING_MESSAGE));
    }
    // A given base is never ignored (loud errors over silent fallbacks). It is compared to the version
    // playing now even while a change waits: the waiting change has no version until its takeover, and anything that
    // moves the playing code (hand edit, part launch, Mixer record, restore) precedes or cancels the wait.
    const given = options?.base;
    if (given !== undefined) {
      if (this.currentVersionId === null) {
        return Promise.reject(new Error(baseUnknownMessage(given)));
      }
      if (given !== this.currentVersionId) {
        return Promise.reject(new Error(baseMovedMessage(given, this.currentVersionId)));
      }
    }
    const result = applyEdits(baseText, edits);
    if (!result.ok) {
      const where =
        waiting === null
          ? 'the code playing now'
          : `the change waiting for cycle ${waiting.cycle} (${waiting.at === 'phrase' ? 'next phrase' : 'next bar'}), which get_code does not show: it returns the code playing until then`;
      return Promise.reject(new Error(editRefusedMessage(where, result.problems)));
    }
    const base: EditBase =
      waiting === null
        ? { kind: 'playing', versionId: this.currentVersionId }
        : { kind: 'waiting', cycle: waiting.cycle, at: waiting.at };
    // The edit builds on a hand-edited playing code (not on a waiting change, which replaces that code at its
    // takeover). confirmSuccess clears editedByHand after a Claude change, yet the user's text is still in the code:
    // the edit_code reply says so (HAND_EDIT_KEPT_NOTE), and the takeover of a timed edit stays silent about it.
    const carriesHandEdit = waiting === null && this.editedByHand;
    return this.sendEvaluate(result.code, {
      label: options?.label,
      force: false,
      at: options?.at,
      phraseCycles: options?.phraseCycles,
      glideBars: options?.glideBars,
      answering: options?.answering,
      carriesHandEdit,
    }).then((outcome) => ({ outcome, code: result.code, ranges: result.ranges, base, carriesHandEdit }));
  }

  /**
   * Reads the history only: throws the same errors restoreVersion would throw for a missing store, an unreadable
   * history or an unknown id. The restore_version tool calls it before it starts Moontide, so an id that can never
   * play does not open a tab.
   */
  assertVersionExists(id: number): void {
    this.requireVersion(id);
  }

  private requireVersion(id: number) {
    if (!this.history) {
      throw new Error(historyUnavailableMessage('no history store is configured'));
    }
    let entry;
    try {
      entry = this.history.getVersion(id);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(historyUnavailableMessage(reason));
    }
    if (entry === null) {
      throw new Error(versionNotFoundMessage(id));
    }
    return entry;
  }

  /**
   * Plays a past version again, through the exact path evaluate() uses
   * so no page/timeout/late-reply/stale-page/evaluation-failure
   * behaves any differently from set_code. `force: true` makes this restore a new
   * entry even when its code equals the last recorded version; the
   * source id rides `restoredFrom`, machine-readable independently of the label text.
   */
  restoreVersion(id: number, options?: { origin?: VersionOrigin; answering?: string }): Promise<EvalOutcome> {
    let entry;
    try {
      entry = this.requireVersion(id);
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
    return this.sendEvaluate(entry.code, {
      label: restoredLabel(id),
      restoredFrom: id,
      origin: options?.origin,
      answering: options?.answering,
      force: true,
    });
  }

  /**
   * Shared by evaluate() and restore_version. The record intent is
   * stored keyed by the request id right when the id is generated (inside sendRequest's
   * buildMessage callback) so it survives independently of the pending/timeout entry.
   */
  private sendEvaluate(
    code: string,
    intent: {
      label?: string;
      restoredFrom?: number;
      origin?: VersionOrigin;
      force: boolean;
      at?: ChangeTiming;
      phraseCycles?: number;
      glideBars?: number;
      answering?: string;
      carriesHandEdit?: boolean;
    },
  ): Promise<EvalOutcome> {
    this.pruneRecordIntents();
    // The setup file is read again before every evaluation, so a fixed file applies at once.
    this.syncRig();
    return this.sendRequest<EvalOutcome>('evaluate', (id) => {
      this.recordIntents.set(id, { ...intent, createdAt: Date.now() });
      const message: ServerMessage = { type: 'evaluate', id, code };
      if (intent.at !== undefined) message.at = intent.at;
      if (intent.phraseCycles !== undefined) message.phraseCycles = intent.phraseCycles;
      if (intent.glideBars !== undefined) message.glideBars = intent.glideBars;
      return message;
    });
  }

  /** Belt-and-suspenders leak guard: drops intents whose request never got any reply at all. */
  private pruneRecordIntents(): void {
    const cutoff = Date.now() - this.recordIntentTtlMs;
    for (const [id, intent] of this.recordIntents) {
      if (intent.createdAt < cutoff) {
        this.recordIntents.delete(id);
      }
    }
  }

  /** Silences all sound immediately, even when the current code is broken. */
  stop(): Promise<void> {
    return this.sendRequest<void>('stop', (id) => ({ type: 'stop', id }));
  }
}
