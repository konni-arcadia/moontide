import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { EDIT_NOTHING_PLAYING_MESSAGE, NOT_STARTED_MESSAGE, type EditOutcome, type EvalOutcome, type Session } from './session.js';
import {
  PAGE_WAIT_MS,
  START_INSTRUCTION,
  START_PROMPT,
  START_PROMPT_DESCRIPTION,
  START_PROMPT_TITLE,
  START_TOOL,
  START_TOOL_DESCRIPTION,
  notStartedForRequestsText,
  notStartedForRequestsToolText,
  pageLine,
  startMoontide,
  type Starter,
} from './start.js';
import { MAX_EDITS, changedExcerpt } from './edit-code.js';
import { MAX_PHRASE_CYCLES, MIN_PHRASE_CYCLES, type AudioState, type ChangeTiming } from './protocol.js';
import { MAX_LABEL_LENGTH, MAX_FAVORITE_NAME_LENGTH } from './history.js';
import {
  PAGE_REQUESTS_ALREADY_OFF,
  PAGE_REQUESTS_ALREADY_ON,
  PAGE_REQUESTS_OFF_DESCRIPTION,
  PAGE_REQUESTS_OFF_PROMPT,
  PAGE_REQUESTS_OFF_TEXT,
  PAGE_REQUESTS_OFF_TITLE,
  PAGE_REQUESTS_ON_DESCRIPTION,
  PAGE_REQUESTS_ON_PROMPT,
  PAGE_REQUESTS_ON_TITLE,
  PAGE_REQUESTS_INSTRUCTION,
  PAGE_REQUESTS_STATE_DESCRIPTION,
  PAGE_REQUESTS_TOOL,
  PAGE_REQUESTS_TOOL_DESCRIPTION,
  REQUEST_LINE_FRAMING,
  listenerScriptPath,
  noPageForRequestsText,
  noPageForRequestsToolText,
  pageRequestsOnText,
} from './ask.js';
import {
  REFERENCE_TOPICS,
  REFERENCE_TOPIC_IDS,
  REFERENCE_URI_PREFIX,
  readReferenceTopic,
  referenceIndexText,
  referenceToolDescription,
  structureTemplateText,
} from './reference.js';

export const NOTHING_PLAYING_MESSAGE = 'Nothing is playing yet.';
export const PLAYING_WITH_ERRORS_MESSAGE = 'Playing, but with runtime errors (see below).';
export const STOPPED_MESSAGE = 'ok, stopped. The code stays in the page; call set_code to start playing again.';
export const STOPPED_NOTE = 'Note: sound is stopped. Call set_code to start playing again.';
export const STOPPED_DURING_SET_CODE_MESSAGE =
  'Stopped: the user pressed Stop in the page while this code was starting. The code is loaded; call set_code to play it.';
export const HAND_EDIT_NOTE = 'Note: this code was edited by hand in the page since your last change.';
export const HAND_EDIT_REPLACED_NOTE =
  'Note: the code you replaced had been edited by hand in the page since your last change.';
// Said by edit_code when the code it edited had hand edits evaluated in the page; they are kept, not replaced.
export const HAND_EDIT_KEPT_NOTE =
  'Note: the code you edited had been edited by hand in the page since your last change; your edit was applied on top of it.';
// The page's text is authoritative, as for set_code; when it differs from the composed program the reply says so.
export const EDIT_OTHER_TEXT_NOTE =
  'Note: the page confirmed a text that differs from the edited code, so the lines above may not match what plays; get_code returns what plays.';
// The line above the song structure template get_code shows when nothing plays yet.
export const STRUCTURE_TEMPLATE_INTRO =
  'A song structure to start a new piece from (the structure topic of get_strudel_reference explains it):';

/** The intro line and the template in a js fence, read from the structure topic at call time (a missing block throws). */
function structureTemplateBlock(): string {
  return `${STRUCTURE_TEMPLATE_INTRO}\n\`\`\`js\n${structureTemplateText()}\n\`\`\``;
}

export const GETTIME_ANCHOR_NOTE =
  'Note: this code reads getTime(); an anchor taken from it restarts every time a later change re-sends this code, ' +
  'while a transition anchored with .timeline(id) keeps running across changes (see the transitions topic).';

// A warning only, as a text match: the code is never parsed, evaluated or changed on the server;
// a match inside a comment or a string also counts, by design. No flags: a global flag would make test() keep
// lastIndex between calls and skip matches.
const GETTIME_CALL_RE = /getTime\s*\(/;

/** The note when `code` reads a getTime() anchor, empty otherwise. See GETTIME_CALL_RE above. */
export function getTimeAnchorLines(code: string): string[] {
  return GETTIME_CALL_RE.test(code) ? [GETTIME_ANCHOR_NOTE] : [];
}

export const FLAG_STRING_NOTE =
  'Note: this code gives .when(), .struct() or .mask() a mini-notation string of t and f. ' +
  'In mini-notation t and f are plain strings (f is also a note name), so every one of those steps counts as true: ' +
  'write 1 and 0, and struct and mask also take ~ as a silent step (see the functions topic).';

// A text match only, like GETTIME_CALL_RE: the code is never parsed, evaluated or changed on the
// server, and a match inside a comment or another string also counts, by design. A string "made only of t and f"
// is one whose characters are rests, whitespace and mini-notation structure characters, ? included because it is
// often written without a number (no digit, no other letter),
// with at least one ASCII t or f. The body is a run without t or f, one t or f, then a run: no nested quantifier, so
// a match is linear. The const form anchors at a line start with [ \t]* (never \s*, so a run of blank lines cannot
// make the scan quadratic).
const FLAG_BODY = '[~\\-\\s<>\\[\\]{},.|_!?]*[tf][tf~\\-\\s<>\\[\\]{},.|_!?]*';
// (1) the literal form: .when("t f"), .struct('t f'), .mask(`t f`). No flags, so test() keeps no lastIndex.
const FLAG_LITERAL_RE = new RegExp('\\.(?:when|struct|mask)\\s*\\(\\s*(["\'`])' + FLAG_BODY + '\\1');
// (2) a const declared at the start of a line that holds such a string; (3) a use of a name as the first argument.
// Both are global and read only through matchAll, which copies the regex.
const FLAG_CONST_RE = new RegExp('^[ \\t]*const[ \\t]+([A-Za-z_$][\\w$]*)[ \\t]*=[ \\t]*(["\'`])' + FLAG_BODY + '\\2', 'gm');
const FLAG_USE_RE = /\.(?:when|struct|mask)\s*\(\s*([A-Za-z_$][\w$]*)\s*[,)]/g;

/**
 * The note when `code` gives .when(, .struct( or .mask( a string made only of t and f (and rests), written
 * out or by the name of a const that holds one; empty otherwise. A notice only: the code plays as written.
 */
export function whenFlagLines(code: string): string[] {
  if (FLAG_LITERAL_RE.test(code)) return [FLAG_STRING_NOTE];
  const flagConsts = new Set<string>();
  for (const match of code.matchAll(FLAG_CONST_RE)) flagConsts.add(match[1] as string);
  if (flagConsts.size === 0) return [];
  for (const match of code.matchAll(FLAG_USE_RE)) {
    if (flagConsts.has(match[1] as string)) return [FLAG_STRING_NOTE];
  }
  return [];
}

// The reply line a set_code of a new piece carries when the piece declares no song structure. One plain line, fixed
// text: it holds no code and no page text. The music plays as written; nothing is refused, blocked or rewritten.
export const NO_STRUCTURE_NOTE =
  'Note: this new piece declares no song structure; every new piece declares one once at the top (see the structure topic of get_strudel_reference). It plays as written.';

// A text match only, like GETTIME_CALL_RE: the code is never parsed, evaluated or changed on the server, and a match
// inside a comment or a string counts too, by design. Anchored at a line start with [ \t]* (never \s*, so a run of blank
// lines cannot make the scan quadratic) and ended on a word boundary, so `const songs`, `const song2`, `let song` and a
// commented-out line are not a structure. The m flag only: no global flag, so test() keeps no lastIndex.
const SONG_CONST_RE = /^[ \t]*const[ \t]+song\b/m;

/** The shortest line, in characters after trimming, that counts when telling a new piece from a changed one. */
const NEW_PIECE_MIN_LINE = 8;

/**
 * True when `code` is a new piece compared with `previous`: the previous code is empty, holds no line of
 * NEW_PIECE_MIN_LINE or more characters, or `code` keeps fewer than half of those lines (kept * 2 < total, so keeping
 * exactly half is not new). Lines are compared trimmed, through a Set, so the cost is linear in the two texts.
 */
function isNewPiece(previous: string, code: string): boolean {
  const longLines = previous
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length >= NEW_PIECE_MIN_LINE);
  if (longLines.length === 0) return true;
  const kept = new Set(code.split('\n').map((line) => line.trim()));
  let keptCount = 0;
  for (const line of longLines) {
    if (kept.has(line)) keptCount += 1;
  }
  return keptCount * 2 < longLines.length;
}

/** The note when `code` replaces `previousCode` as a new piece and declares no song structure, empty otherwise. */
export function newPieceWithoutStructureLines(previousCode: string, code: string): string[] {
  if (SONG_CONST_RE.test(code)) return [];
  return isNewPiece(previousCode, code) ? [NO_STRUCTURE_NOTE] : [];
}

export function waitingForClickMessage(pageUrl: string): string {
  return `Waiting for the user's click: the code is loaded and will start playing after one click on the page at ${pageUrl}.`;
}

/** The shape of a prompt result: one user message holding `text`. */
function userMessage(text: string) {
  return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }] };
}

/** Appends drained notice lines (runtime errors, dropped-count note) after a blank line. */
function withNoticeLines(text: string, lines: string[]): string {
  return lines.length > 0 ? `${text}\n\n${lines.join('\n')}` : text;
}

/**
 * The reply status of a change that waits for its line: the cycle it takes over on, which line it is
 * and about how many seconds away. The numbers come from the page (bounded by the protocol schema) and only
 * numbers are formatted here, so no page text enters the reply. One decimal below 10 s, whole seconds from 10.
 */
export function pendingStatus(cycle: number, at: 'bar' | 'phrase', seconds: number): string {
  const line = at === 'phrase' ? 'next phrase' : 'next bar';
  const about = seconds < 10 ? seconds.toFixed(1) : String(Math.round(seconds));
  return `ok. The change takes over at cycle ${cycle} (${line}), in about ${about} s. The music keeps playing until then.`;
}

/**
 * The reply status of a change that waits for its line, by the audio state of the page. While the audio is playing
 * it is `pendingStatus`. While it is not (the page has not been clicked yet, so the AudioContext does not run and the
 * scheduler's clock does not count), the music does not keep playing and the line does not come by itself: the reply
 * says so and carries the same instruction as every other reply of that state, never a promise of a takeover in
 * seconds.
 */
export function pendingReplyStatus(
  pending: { cycle: number; seconds: number },
  at: 'bar' | 'phrase',
  audio: AudioState,
  hadRuntimeErrors: boolean,
  pageUrl: string,
): string {
  if (audio === 'playing') return pendingStatus(pending.cycle, at, pending.seconds);
  const line = at === 'phrase' ? 'next phrase' : 'next bar';
  return `ok. The change is checked and takes over at cycle ${pending.cycle} (${line}), but the audio is not running, so the clock does not count and the line does not come until it runs. ${playStatus(audio, hadRuntimeErrors, pageUrl)}`;
}

/** The note when a change asked for a bar or phrase line took over at once because nothing was playing. */
export const AT_ONCE_NOTE = 'Note: nothing was playing, so the change took over at once.';

/**
 * BPM: the one-line tempo of a reply, said only when the tempo differs from the last one a reply stated. The
 * number comes from the page, bounded by the protocol schema and rounded to one decimal by the session; only
 * a number is formatted here, so no page text enters the reply. `pendingCycle` is set for a waiting change.
 */
export function tempoLine(bpm: number, pendingCycle?: number): string {
  const shown = Number.isInteger(bpm) ? String(bpm) : bpm.toFixed(1);
  return pendingCycle === undefined ? `Tempo: ${shown} BPM.` : `Tempo from cycle ${pendingCycle}: ${shown} BPM.`;
}

/**
 * The first note of get_code while a change waits to take over: the code the reply shows is the code
 * that plays until the line.
 */
export function waitingLine(cycle: number, at: ChangeTiming): string {
  const line = at === 'phrase' ? 'next phrase' : 'next bar';
  return `Note: a change waits to take over at cycle ${cycle} (${line}); the code above plays until then.`;
}

/**
 * The same status choice set_code has always made, shared with restore_version
 * so both tools reuse one truthful mapping from audio + runtime errors to text.
 */
export function playStatus(audio: AudioState, hadRuntimeErrors: boolean, pageUrl: string): string {
  return audio === 'stopped'
    ? STOPPED_DURING_SET_CODE_MESSAGE
    : audio === 'playing'
      ? hadRuntimeErrors
        ? PLAYING_WITH_ERRORS_MESSAGE
        : 'ok, playing'
      : waitingForClickMessage(pageUrl);
}

/**
 * The status line of a change reply, shared by set_code and edit_code (the playStatus precedent) so both say the
 * same truthful thing: a change that waits for its line is answered with the line, never as playing.
 */
function changeStatus(
  outcome: EvalOutcome,
  at: ChangeTiming | undefined,
  hadRuntimeErrors: boolean,
  pageUrl: string,
): string {
  return outcome.pending !== undefined && (at === 'bar' || at === 'phrase')
    ? pendingReplyStatus(outcome.pending, at, outcome.audio, hadRuntimeErrors, pageUrl)
    : playStatus(outcome.audio, hadRuntimeErrors, pageUrl);
}

/**
 * The first notes of a change reply, shared by set_code and edit_code: the tempo line first when it changed, then
 * the at-once note when a requested line was skipped because nothing played.
 */
function changeNoteLines(outcome: EvalOutcome, at: ChangeTiming | undefined): string[] {
  const tempo =
    outcome.tempoChanged && outcome.bpm !== null ? [tempoLine(outcome.bpm, outcome.pending?.cycle)] : [];
  const atOnce =
    (at === 'bar' || at === 'phrase') && outcome.pending === undefined && outcome.audio !== 'stopped'
      ? [AT_ONCE_NOTE]
      : [];
  return [...tempo, ...atOnce];
}

const LABEL_FIELD_DESCRIPTION =
  'A few words saying what this change is, for example "added a bass"; shown by list_history';
const AT_FIELD_DESCRIPTION =
  "When the change takes over: 'now' (the default) within a fraction of a second, 'bar' on the next bar line, 'phrase' on the next phrase line (4 cycles, counted from Play). " +
  'The code is checked at once; the reply says the cycle and about how many seconds away it is.';
const PHRASE_CYCLES_FIELD_DESCRIPTION = "How many cycles one phrase lasts, for at: 'phrase' (2 to 64, default 4)";

/**
 * The tool description of edit_code. The when-to-use rule comes first; Claude Code keeps at most 2048
 * characters of a tool description.
 */
export const EDIT_CODE_DESCRIPTION =
  'Changes part of the code that will play by exact text replacement, sending only the change. ' +
  'Use it to change an existing piece; use set_code for a new piece or a rewrite of most of its lines. ' +
  'Each edit has old_string, new_string and optional replace_all, as in your own Edit tool. ' +
  'Every old_string must match exactly once (or set replace_all), and every edit is matched against the code as it is before this call, so edits must not overlap and one edit cannot match text another edit writes. ' +
  'An edit that matches nowhere, matches more than once, overlaps another edit or changes nothing refuses the whole call with the reason and the edit number: nothing is applied and nothing reaches the page. ' +
  'CRLF counts as LF. ' +
  "The edits apply to the newest code that will play: the change waiting for its bar or phrase line when one waits (get_code shows the code playing until then), otherwise the code playing now with the user's evaluated hand edits; text typed in the page but not evaluated is replaced, as with set_code. " +
  'Pass base, the version number get_code shows, to have the edit refused when the music moved on since. ' +
  'at, phraseCycles and label work as in set_code, and the edited program goes through the same checks, history entry and notices. ' +
  'The reply gives the version, when the change takes over and the changed lines with a few lines around them, not the whole program; get_code returns it. ' +
  'Put all replacements for one change in a single call: a second edit_code sent before the first reply is refused. ' +
  'It edits music that already plays, so before Moontide is started it is refused and starts nothing: use set_code first. ' +
  'Call get_code before changing existing music.';

/**
 * A get_code reply adds a version line, pointing to edit_code, for code of this many lines or more. An edit_code call
 * that changes one line sends about 120 to 250 characters (about 60 of JSON wrapper plus the old and the new text);
 * lines of a Moontide piece run about 30 to 60 characters, so from 8 lines the whole program clearly costs more than
 * such an edit, while below it set_code costs about the same and the line would be noise. The bench's 10-line size
 * checks the choice (22-BENCH.md). Existing exact-text tests use shorter programs.
 */
export const EDIT_HINT_MIN_LINES = 8;

/** The get_code line for long code: the version to pass as base and when to use which tool; empty for short code. */
export function editHintLines(code: string, versionId: number | null): string[] {
  if (code === '' || code.split('\n').length < EDIT_HINT_MIN_LINES) return [];
  const rule = 'set_code is for a new piece or a rewrite of most of its lines.';
  if (versionId === null) return [`To change part of this code, edit_code sends only the change; ${rule}`];
  return [`Version #${versionId}. To change part of this code, edit_code sends only the change (base: ${versionId}); ${rule}`];
}

/** The first line of an edit_code reply after the status: how many places, in which code, which version. */
export function editHeadLine(edit: EditOutcome): string {
  const places = edit.ranges.length;
  const word = places === 1 ? 'place' : 'places';
  const { base, outcome } = edit;
  const pending = outcome.pending !== undefined;
  if (base.kind === 'playing') {
    const head = `Edited ${places} ${word} in the code playing now${base.versionId !== null ? ` (#${base.versionId})` : ''}`;
    if (pending) return `${head}; the result is recorded when it takes over.`;
    return outcome.versionId !== null ? `${head}, now #${outcome.versionId}.` : `${head}.`;
  }
  const line = base.at === 'phrase' ? 'next phrase' : 'next bar';
  const head = `Edited ${places} ${word} in the change waiting for cycle ${base.cycle} (${line}); its code is part of this change`;
  if (pending) return `${head}, recorded when it takes over.`;
  return outcome.versionId !== null ? `${head}, now #${outcome.versionId}.` : `${head}.`;
}

function readPackageVersion(): string {
  const packageJsonPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
  const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version: string };
  return pkg.version;
}

/**
 * Claude Code keeps only the first 2048 characters of an MCP server's instructions and cuts the rest
 * mid-sentence ("... [truncated]"). Everything below must fit, most important entries first, and
 * test/guidance.test.js fails when the whole text passes this limit. What a tool already returns (its
 * description, its replies, the reference topics) stays out of here: the entries say only what Claude
 * needs before it has called anything. Keep a margin of a sentence or two (about 150 to 250 characters) so a
 * new standing rule never forces cutting one that matters; make room by moving a fact to the tool
 * description or reply where Claude meets it, never by dropping a rule.
 */
export const CLIENT_INSTRUCTIONS_LIMIT = 2048;

export const SERVER_INSTRUCTIONS = [
  'Moontide plays Strudel code in a browser page; each change takes over within a fraction of a second. ' +
    "Call get_strudel_reference for the functions, sounds and effects of the page's Strudel version.",
  // What a page request line is and who wrote each field, as a fact. It holds no token and no
  // command: those reach Claude only in the arming line of a tool reply (test/guidance.test.js keeps
  // them out of these instructions). First after the opening: it is the trust boundary.
  REQUEST_LINE_FRAMING,
  // One fact, in its own entry. It names the tool and its two states; no command and no token.
  PAGE_REQUESTS_INSTRUCTION,
  // Named tracks, so the page shows real names. No example label on purpose: any example
  // would itself suggest a style; nothing here points to arrange() or any other musical form.
  'Write each layer as a labeled statement, name: pattern, with a name that describes its role — the page displays tracks under these names.',
  // The capital-S label rule, as a fact. Claude names tracks before it ever reads the reference. It is
  // its own entry: the named-tracks sentence above is pinned verbatim by test/guidance.test.js. No
  // example label and no advice, only what Strudel does (proven against the bundle by check:reference).
  // The underscore exception is part of the fact: the bundle silences a label that ends with an
  // underscore and never lets it solo. The solo-label claim of scripts/check-reference.mjs reads
  // this string from the source, so it stays one single-quoted line.
  'A label longer than one character that starts with a capital S plays alone, unless it also ends with an underscore, which silences it instead: while a label that plays alone exists, every other label is silent.',
  // The standing rule for song structure, kept to one short sentence: the full form is the structure topic and the
  // template get_code shows when nothing plays yet, so only the duty and the place to look are said here. No example
  // and no section names: any example would suggest a style.
  'Every new piece declares its song structure once at the top; the structure topic of get_strudel_reference has the form.',
  // Read before editing.
  "Before changing the music, call get_code: it includes the user's hand edits.",
  // A session frame applies to every change, surprises included, until lifted, and a
  // gradual frame means each change, surprises and small edits included, arrives through a transition,
  // not only as a smaller step. No variety rule; nothing says how a surprise should sound.
  'If the user sets a frame of gradual changes, every change, surprises and small edits included, arrives through a ' +
    'transition over several cycles, not only as a smaller step; any other frame is followed the same way ' +
    'until the user changes or lifts it.',
  // One fact about MIDI, pointing at the midi topic and at the two tools; the
  // sound option and the notices are in the tool descriptions and replies. "Call get_midi_instruments before
  // writing MIDI code" stays here and in that tool's description: a guessed port or channel can send notes
  // to the wrong channel of a real instrument. No sound name, no style advice.
  "A track can play a MIDI instrument with .midi('port name'); the midi topic of get_strudel_reference has the " +
    "MIDI facts; before writing MIDI code, call get_midi_instruments; search_midi_sounds finds the user's sounds.",
  // Nothing starts with the session. One sentence; what each tool does before the start is in their descriptions.
  START_INSTRUCTION,
].join('\n\n');

type PageRequestsSwitch = { text: string } | { noPage: true } | { noCommand: string };

/**
 * The one function behind the two page-requests prompts and the set_page_requests tool, so they flip the
 * same switch in any order: on clears the pause and gives the command; off pauses the arming line.
 */
function switchPageRequests(options: { session: Session; state: 'on' | 'off' }): PageRequestsSwitch {
  const { session, state } = options;
  if (state === 'off') {
    session.ask.setArmingPaused(true);
    return { text: session.ask.hasListener() ? PAGE_REQUESTS_OFF_TEXT : PAGE_REQUESTS_ALREADY_OFF };
  }
  // The user asked for live requests: tool replies may carry the command again, in every case, even when no
  // page is connected yet and the call is refused below: the request is remembered, so the arming line comes
  // back as soon as a page connects (the same as the page-requests-on prompt has always done).
  session.ask.setArmingPaused(false);
  if (!session.ask.hasTrustedPage()) {
    return { noPage: true };
  }
  if (session.ask.hasListener()) {
    return { text: PAGE_REQUESTS_ALREADY_ON };
  }
  try {
    return {
      text: pageRequestsOnText({
        scriptPath: listenerScriptPath(),
        port: session.pagePort(),
        token: session.ask.listenerToken,
      }),
    };
  } catch (err) {
    return { noCommand: err instanceof Error ? err.message : String(err) };
  }
}

export function createMcpServer(options: { session: Session; starter: Starter }): McpServer {
  const { session, starter } = options;

  const server = new McpServer(
    { name: 'moontide', version: readPackageVersion() },
    { instructions: SERVER_INSTRUCTIONS },
  );

  server.registerTool('get_code', {
    description:
      "Reads the Strudel code currently playing in the Moontide page, i.e. the last code the page confirmed, " +
      "including edits the user evaluated by hand; returns 'Nothing is playing yet.' before anything played, with a template of a song structure to start from. " +
      'Before Moontide is started it says so and starts nothing; after the start its reply also names the page address, the port and the tab title. ' +
      'Call it before every change.',
    annotations: { readOnlyHint: true },
  }, async () => {
    // Before the start there is no page and no code: say how to start and start nothing. No drain, so queued
    // notices wait for the next reply.
    const server = starter.current();
    if (server === null) {
      // The first get_code of a fresh session comes before the start, and nothing plays yet either way.
      throw new Error(`${NOT_STARTED_MESSAGE}\n\n${structureTemplateBlock()}`);
    }
    const code = session.getCode();
    const text = code === '' ? `${NOTHING_PLAYING_MESSAGE}\n\n${structureTemplateBlock()}` : code;
    const { lines } = session.drainNotices();
    // STOPPED_NOTE first when both apply, then HAND_EDIT_NOTE, then the version line, then the page line, then drained lines.
    const notices: string[] = [];
    // A change that waits comes first, so Claude never mistakes the code above for the one that comes.
    const waiting = session.waitingChange();
    if (waiting !== null) notices.push(waitingLine(waiting.cycle, waiting.at));
    if (session.isStopped() && code !== '') notices.push(STOPPED_NOTE);
    if (session.wasEditedByHand()) notices.push(HAND_EDIT_NOTE);
    notices.push(...editHintLines(code, session.getCurrentVersionId()));
    // Where the page is, from the one function the start reply uses.
    notices.push(pageLine(server));
    const allLines = [...notices, ...lines];
    return { content: [{ type: 'text' as const, text: withNoticeLines(text, allLines) }] };
  });

  server.registerTool('get_strudel_reference', {
    description: referenceToolDescription(),
    annotations: { readOnlyHint: true },
    inputSchema: {
      topic: z.enum(REFERENCE_TOPIC_IDS).optional().describe('One topic to return; omit it to get the index of topics'),
    },
  }, async ({ topic }) => {
    try {
      const text = topic ? readReferenceTopic(topic) : referenceIndexText();
      return { content: [{ type: 'text' as const, text }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(message);
    }
  });

  server.registerResource(
    'strudel-reference',
    REFERENCE_URI_PREFIX,
    { title: 'Strudel reference', description: 'Index of Strudel reference topics', mimeType: 'text/markdown' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: referenceIndexText() }] }),
  );

  for (const entry of REFERENCE_TOPICS) {
    server.registerResource(
      `strudel-reference-${entry.id}`,
      `${REFERENCE_URI_PREFIX}/${entry.id}`,
      { title: entry.title, description: entry.summary, mimeType: 'text/markdown' },
      async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: readReferenceTopic(entry.id) }] }),
    );
  }

  server.registerTool('set_code', {
    description:
      'Replaces the music in the Moontide page with new Strudel code; the new pattern takes over within a fraction of a second, mid-cycle, without stopping the music. ' +
      'To change part of an existing piece, edit_code sends only the change; set_code is for a new piece or a rewrite of most of its lines. ' +
      "With at: 'bar' or at: 'phrase' the code is checked at once and takes over on the next bar line or the next phrase line instead (a bar is one cycle of 4 beats; a phrase is 4 cycles, or phraseCycles, counted from Play); " +
      'the reply gives the cycle and about how many seconds, a newer change replaces a waiting one, and Stop cancels it. When the tempo changes, the reply gives it in BPM. ' +
      // The getTime()/.timeline(id) rule lives here and in GETTIME_ANCHOR_NOTE, not in SERVER_INSTRUCTIONS (CLIENT_INSTRUCTIONS_LIMIT); the transitions topic has it in full.
      'Every call runs the whole program again, so a getTime() anchor restarts at each change; a transition that must keep running takes .timeline(id), which keeps its anchor as long as the code keeps the same id (see the transitions topic). ' +
      'Double-quoted and backtick strings are parsed as mini-notation wherever they appear, helpers included, while single-quoted strings stay plain JavaScript (see the tidal-differences topic). ' +
      `When Moontide is not started yet, set_code starts it first: its page opens in a new browser tab and the call waits up to ${PAGE_WAIT_MS / 1000} seconds for that page to connect. ` +
      'Before changing existing music, call get_code and build on what it returns, including hand edits. Keep what the user said matters; if a small request ' +
      'needs a full rewrite and the user said what matters, ask first, otherwise rewrite and say so. ' +
      // Moved here from the server instructions (CLIENT_INSTRUCTIONS_LIMIT): Claude meets it where it writes the code.
      'When a request is vague, act on your own reading of it instead of asking first. Returns ' +
      'the code as confirmed by the page. Pass a short label saying what changed; every version that plays is ' +
      'kept in the history. Then tell the user in one line what you chose: the musical terms, plus a short ' +
      'image in plain words.',
    inputSchema: {
      code: z.string().describe('Complete Strudel code to play'),
      label: z.string().max(MAX_LABEL_LENGTH).optional().describe(LABEL_FIELD_DESCRIPTION),
      at: z.enum(['now', 'bar', 'phrase']).optional().describe(AT_FIELD_DESCRIPTION),
      phraseCycles: z
        .number()
        .int()
        .min(MIN_PHRASE_CYCLES)
        .max(MAX_PHRASE_CYCLES)
        .optional()
        .describe(PHRASE_CYCLES_FIELD_DESCRIPTION),
    },
  }, async ({ code, label, at, phraseCycles }) => {
    try {
      // A phrase length means nothing for another timing; refused before anything reaches the page.
      if (phraseCycles !== undefined && at !== 'phrase') {
        throw new Error("phraseCycles applies only with at: 'phrase'.");
      }
      // The first change of the music starts Moontide and waits for the page of the tab it opens.
      await starter.ensureStarted();
      await starter.waitForPage();
      // What played before this call, read before the page changes it: the new-piece note compares the two.
      const previousCode = session.getCode();
      const outcome = await session.evaluate(code, { label, at, phraseCycles });
      const { lines, hadRuntimeErrors } = session.drainNotices();
      // Claude must never be told "ok, playing" when something went wrong —
      // including when the user pressed Stop while this code was still starting.
      // A change that waits for its line is answered with the line, never as playing.
      const status = changeStatus(outcome, at, hadRuntimeErrors, session.getPageUrl());
      // Whatever Claude's code just replaced had been edited by hand since Claude's
      // last change — tell it on this response, since it may not call get_code next.
      // BPM: the tempo line first when it changed; the at-once note when a requested line was skipped
      // because nothing played (both from changeNoteLines, shared with edit_code).
      const notices = outcome.replacedHandEdit ? [HAND_EDIT_REPLACED_NOTE] : [];
      // Order of the reply lines: the change notes, the hand-edit note, the drained notices (structure notes included),
      // the t/f flag note, the new-piece note, then the getTime() warn note, which is always the last line. The new-piece
      // note is for set_code only: edit_code changes part of a piece and restore_version brings an older one back.
      const text = withNoticeLines(`${status}\n\n${outcome.code}`, [
        ...changeNoteLines(outcome, at),
        ...notices,
        ...lines,
        ...whenFlagLines(outcome.code),
        ...newPieceWithoutStructureLines(previousCode, outcome.code),
        ...getTimeAnchorLines(outcome.code),
      ]);
      return { content: [{ type: 'text' as const, text }] };
    } catch (err) {
      // Pending runtime-error notices are appended to a failed set_code too.
      const { lines } = session.drainNotices();
      // A failed set_code doesn't clear a pending hand edit, so keep surfacing it.
      const notices = session.wasEditedByHand() ? [HAND_EDIT_NOTE] : [];
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(withNoticeLines(message, [...notices, ...lines]));
    }
  });

  // Changes part of the code that will play by exact replacements, through the same Session path as
  // set_code. The reply shares set_code's status and note pieces but shows only the changed lines.
  server.registerTool('edit_code', {
    description: EDIT_CODE_DESCRIPTION,
    inputSchema: {
      // No .min(1) on old_string: an empty one is refused in Moontide's words, naming the edit.
      edits: z
        .array(
          z.strictObject({
            old_string: z
              .string()
              .describe('The exact text to replace, without line numbers; matched in the code as it is before this call'),
            new_string: z.string().describe('The text that replaces it'),
            replace_all: z
              .boolean()
              .optional()
              .describe('true to replace every match; otherwise old_string must match exactly once'),
          }),
        )
        .min(1)
        .max(MAX_EDITS)
        .describe(`The replacements, 1 to ${MAX_EDITS}, applied all together or not at all`),
      base: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('The version number get_code shows (#N); the edit is refused when another version plays now'),
      label: z.string().max(MAX_LABEL_LENGTH).optional().describe(LABEL_FIELD_DESCRIPTION),
      at: z.enum(['now', 'bar', 'phrase']).optional().describe(AT_FIELD_DESCRIPTION),
      phraseCycles: z
        .number()
        .int()
        .min(MIN_PHRASE_CYCLES)
        .max(MAX_PHRASE_CYCLES)
        .optional()
        .describe(PHRASE_CYCLES_FIELD_DESCRIPTION),
    },
  }, async ({ edits, base, label, at, phraseCycles }) => {
    try {
      // The same rule and text as set_code, before anything reaches the page.
      if (phraseCycles !== undefined && at !== 'phrase') {
        throw new Error("phraseCycles applies only with at: 'phrase'.");
      }
      // Nothing plays before a start, so there is nothing to edit: refuse before a tab opens for a request that cannot work.
      if (starter.current() === null) {
        throw new Error(EDIT_NOTHING_PLAYING_MESSAGE);
      }
      await starter.ensureStarted();
      await starter.waitForPage();
      const edit = await session.editCode(edits, { base, label, at, phraseCycles });
      const { outcome } = edit;
      const { lines, hadRuntimeErrors } = session.drainNotices();
      const status = changeStatus(outcome, at, hadRuntimeErrors, session.getPageUrl());
      // An edit built on a hand-edited playing code kept that edit, and says so. HAND_EDIT_REPLACED_NOTE only
      // when an at-once edit of a waiting change that did not carry the hand edit replaced it: then it is true.
      const handNotes = edit.carriesHandEdit
        ? [HAND_EDIT_KEPT_NOTE]
        : outcome.replacedHandEdit
          ? [HAND_EDIT_REPLACED_NOTE]
          : [];
      // The page's confirmed text is authoritative; a difference from the composed program is said, never silent.
      const otherText = outcome.code !== edit.code ? [EDIT_OTHER_TEXT_NOTE] : [];
      // Never the whole program.
      const text = withNoticeLines(
        `${status}\n\n${editHeadLine(edit)}\n${changedExcerpt(edit.code, edit.ranges)}`,
        [
          ...changeNoteLines(outcome, at),
          ...handNotes,
          ...otherText,
          ...lines,
          ...whenFlagLines(outcome.code),
          ...getTimeAnchorLines(outcome.code),
        ],
      );
      return { content: [{ type: 'text' as const, text }] };
    } catch (err) {
      const { lines } = session.drainNotices();
      const notices = session.wasEditedByHand() ? [HAND_EDIT_NOTE] : [];
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(withNoticeLines(message, [...notices, ...lines]));
    }
  });

  server.registerTool('list_history', {
    description:
      'Lists the versions of the music that played, newest first, one per row: "#id — time (UTC) — origin — \\"label\\" — first line of code". Ids never change. Rows without "#" mark where a Claude session started. The newest version row is usually what plays now; "the previous version" is the next version row down, "3 changes ago" is three version rows below the newest. Pass limit to see more than 20. Pass filter to find a version by a word from its label, code or favorite name; pass favorites: true to list favorites.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      limit: z.number().int().positive().optional().describe('How many versions to list, newest first (default 20)'),
      filter: z
        .string()
        .optional()
        .describe('Only versions whose label, code or favorite name contains this text (case-insensitive)'),
      favorites: z.boolean().optional().describe('true to list only favorites'),
    },
  }, async ({ limit, filter, favorites }) => {
    try {
      const text = session.listHistory({ limit, filter, favoritesOnly: favorites });
      const { lines } = session.drainNotices();
      return { content: [{ type: 'text' as const, text: withNoticeLines(text, lines) }] };
    } catch (err) {
      const { lines } = session.drainNotices();
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(withNoticeLines(message, lines));
    }
  });

  server.registerTool('favorite_version', {
    description:
      'Keeps a version as a named favorite, by its id from list_history (the version playing now is the one shown as v{id} in the page top bar). Favorites are never dropped from the history. Favoriting the same id again renames it. List favorites with list_history and favorites: true.',
    inputSchema: {
      id: z.number().int().positive().describe('Version id from list_history'),
      name: z
        .string()
        .min(1)
        .max(MAX_FAVORITE_NAME_LENGTH)
        .describe("Name to keep it under, in the user's words"),
    },
  }, async ({ id, name }) => {
    try {
      const text = session.favoriteVersion(id, name);
      const { lines } = session.drainNotices();
      return { content: [{ type: 'text' as const, text: withNoticeLines(text, lines) }] };
    } catch (err) {
      const { lines } = session.drainNotices();
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(withNoticeLines(message, lines));
    }
  });

  server.registerTool('restore_version', {
    description:
      'Plays a past version again, by its id from list_history, in one call: it takes over within a fraction of a second without stopping the music, with the same checks as set_code. The restore is added to the history as a new version ("restored from #id"); nothing is rewritten. Returns the code as confirmed by the page. A restore always takes over at once and replaces a change that waits for a bar or phrase line. The old version replaces the music at once; when the user asked for gradual changes this session, bring it in with set_code and a transition instead. Like set_code, it starts Moontide first when it is not started yet, but only for an id that exists in the history.',
    inputSchema: {
      id: z.number().int().positive().describe('Version id from list_history, for example 41 for #41'),
    },
  }, async ({ id }) => {
    try {
      // The history needs no page: an id that cannot be restored fails before Moontide starts or a tab opens.
      session.assertVersionExists(id);
      await starter.ensureStarted();
      await starter.waitForPage();
      const outcome = await session.restoreVersion(id);
      const { lines, hadRuntimeErrors } = session.drainNotices();
      // versionId is null only on a history-write failure — the write-failure
      // note (queued by the same recordConfirmed path set_code uses) explains why below.
      const head = outcome.versionId !== null ? `Restored #${id} as #${outcome.versionId}` : `Restored #${id}`;
      // Exact copy: "now playing" only when it truthfully is — anything else (waiting
      // for the click, stopped by the user, playing with errors) reuses playStatus verbatim.
      const status =
        outcome.audio === 'playing' && !hadRuntimeErrors
          ? `${head} — now playing.`
          : `${head}. ${playStatus(outcome.audio, hadRuntimeErrors, session.getPageUrl())}`;
      const tempo = outcome.tempoChanged && outcome.bpm !== null ? [tempoLine(outcome.bpm)] : [];
      const notices = outcome.replacedHandEdit ? [HAND_EDIT_REPLACED_NOTE] : [];
      // The same t/f flag note and getTime() warn note as set_code, the getTime() note last.
      const text = withNoticeLines(`${status}\n\n${outcome.code}`, [
        ...tempo,
        ...notices,
        ...lines,
        ...whenFlagLines(outcome.code),
        ...getTimeAnchorLines(outcome.code),
      ]);
      return { content: [{ type: 'text' as const, text }] };
    } catch (err) {
      // set_code's exact catch shape: drained lines, HAND_EDIT_NOTE when applicable,
      // thrown as the tool error — so no page, timeout and evaluation failures reuse the
      // original strings verbatim.
      const { lines } = session.drainNotices();
      const notices = session.wasEditedByHand() ? [HAND_EDIT_NOTE] : [];
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(withNoticeLines(message, [...notices, ...lines]));
    }
  });

  server.registerTool('stop', {
    description:
      'Stops all sound in the Moontide page right away, even when the current code is broken. The code stays in the editor; get_code still returns it, and the next set_code starts playing again. Before Moontide is started it says so and starts nothing.',
    annotations: { destructiveHint: false, idempotentHint: true },
  }, async () => {
    if (starter.current() === null) {
      throw new Error(NOT_STARTED_MESSAGE);
    }
    try {
      await session.stop();
      const { lines } = session.drainNotices();
      // A stop doesn't clear a pending hand edit, so keep surfacing it.
      const notices = session.wasEditedByHand() ? [HAND_EDIT_NOTE] : [];
      return { content: [{ type: 'text' as const, text: withNoticeLines(STOPPED_MESSAGE, [...notices, ...lines]) }] };
    } catch (err) {
      // Pending runtime-error notices are appended to a failed stop too.
      const { lines } = session.drainNotices();
      // A failed stop doesn't clear a pending hand edit either, so keep
      // surfacing it — mirrors set_code's catch block above.
      const notices = session.wasEditedByHand() ? [HAND_EDIT_NOTE] : [];
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(withNoticeLines(message, [...notices, ...lines]));
    }
  });

  server.registerTool('get_midi_instruments', {
    description:
      "When the user has described their instruments, call this before writing MIDI code. Lists the MIDI instruments the user described in instruments.json, as facts: for each one its id, model, exact port name, whether it is connected right now, its channels and their roles, how many sounds it has, its bank select, its reset, whether it follows MIDI clock and its controls. Pass instrument (an id from that list) to get that instrument's full sound list, with the program number sent for each sound and its bank when it has one. A sound is chosen in the code with the sound option of .midi(). An instrument with a sound catalog shows how many sounds the catalog holds and its categories; search_midi_sounds finds them. For an instrument with a rhythm channel it says how a kit goes out and which drum map applies; with instrument set it lists each drum map as note numbers and drum names, a kit's own map only when it differs from the model's, and says when a kit has no known map. Drum notes are written as note numbers in the code. It also says which instruments the user switched off in the page: their notes are silent, and .midi() code newly aimed at them is refused until the user switches them on.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      instrument: z.string().min(1).max(32).optional().describe('An instrument id from instruments.json, to list its sounds'),
    },
  }, async ({ instrument }) => {
    try {
      const text = session.instrumentsReply(instrument);
      const { lines } = session.drainNotices();
      return { content: [{ type: 'text' as const, text: withNoticeLines(text, lines) }] };
    } catch (err) {
      const { lines } = session.drainNotices();
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(withNoticeLines(message, lines));
    }
  });

  server.registerTool('search_midi_sounds', {
    description:
      "Searches the sound catalog of one instrument: a list of the model's sounds kept in the user's data folder, built from a patch-name file or a sound list the user owns. It finds sounds by words in the name or the category, in any order, with case and spaces ignored. It returns at most 25 matches: the exact name first, then names that start with the words, then names that contain them, then matches in the category only. Each match gives the name as the sound option of .midi() takes it, the program as sent (0-127), the bank when there is one and the category. It says how many more matched. A drum kit is marked (drum kit) and gives its drum map, or says the map is unknown.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      instrument: z.string().min(1).max(32).describe('An instrument id from instruments.json whose model has a sound catalog'),
      query: z.string().max(100).optional().describe('Words to find in the sound name or its category, in any order; case and spaces do not matter'),
      category: z.string().max(60).optional().describe('Only sounds of this category; case and spaces do not matter'),
    },
  }, async ({ instrument, query, category }) => {
    try {
      const text = session.searchMidiSounds({ instrument, query, category });
      const { lines } = session.drainNotices();
      return { content: [{ type: 'text' as const, text: withNoticeLines(text, lines) }] };
    } catch (err) {
      const { lines } = session.drainNotices();
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(withNoticeLines(message, lines));
    }
  });

  server.registerTool('save_midi_model', {
    description:
      "Saves an instrument model that you drafted from a page of the instrument's manual the user pasted, into the user's Moontide data folder (models/<id>.json), never into Moontide itself. First call it with confirmed: false: it checks the model and returns a summary (channels, sounds with their program numbers as sent and as numbered in a manual from 1, controls, reset bytes, notes) and saves nothing. Show that summary to the user, and call it again with the same model and confirmed: true only after they say yes. It refuses an id of a model Moontide ships, and an existing model unless overwrite is true. Fields: id (lowercase letters, digits, dashes or underscores, at most 32), name, channels { melodic, rhythm } (lists of channels 1-16), bankSelect (none, msb or msb-lsb), rhythmBank (optional: true when the instrument chooses drum kits by bank select and program change; every rhythm sound then needs a bank), drumMaps (optional, at most 8: [{ id, name, notes: [{ note 0-127, name }] }] typed from the instrument's manual), drumMap (optional: the id of the map of kits without their own; general-midi is built in), a rhythm sound's noteMap (optional: a map id, or null when no map is known for that kit), defaultVolume (0-127), clock (optional: true when the instrument follows MIDI clock, so Moontide sends it the clock, Start and Stop), reset (optional: sysex with at most 4 messages, each { kind: roland-dt1, model, address, data } as hex bytes or { kind: raw, bytes } from F0 to F7 and at most 32 bytes, and waitMs), controls ([{ id, name, cc, min, max, default }]), sounds { melodic, rhythm } ([{ name, program 0-127 as sent, bank { msb, lsb } when the instrument needs one }]) and notes (facts about the instrument, at most 10).",
    inputSchema: {
      model: z.record(z.string(), z.unknown()).describe('The drafted model, as a JSON object'),
      confirmed: z.boolean().describe('false to check and summarize without saving; true only after the user said yes to the summary'),
      overwrite: z.boolean().optional().describe('true to replace an existing user model with the same id'),
    },
  }, async ({ model, confirmed, overwrite }) => {
    try {
      const text = session.saveMidiModel({ model, confirmed, overwrite });
      const { lines } = session.drainNotices();
      return { content: [{ type: 'text' as const, text: withNoticeLines(text, lines) }] };
    } catch (err) {
      const { lines } = session.drainNotices();
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(withNoticeLines(message, lines));
    }
  });

  // The two-step tool for a sound catalog drafted from a sound list; the sounds arrive in parts, the confirm carries none.
  server.registerTool('save_midi_catalog', {
    description:
      "Saves a sound catalog that you drafted from a sound list the user gave you (for example the maker's PDF list), into the user's Moontide data folder (catalogs/<model id>.json), never into Moontide itself. The catalog extends the model named by model. Send the sounds grouped as the list prints them, at most 500 per call: the first call starts the draft (source, programNumbering, and overwrite when it replaces a catalog), later calls add parts with append: true, with more: true while parts remain. The last part checks the whole draft and returns a summary that shows three sounds with their program as sent and as numbered from 1, and saves nothing. Show that summary to the user, then call again with model and confirmed: true, and nothing else, only after they say yes. The draft lives only in this session; a restart of the server loses it. For a model whose rhythm channels take a bank, a group of drum kits takes role: rhythm and may give noteMap; its kits are saved in the catalog's kits list.",
    inputSchema: {
      model: z.string().min(1).max(32).describe('The id of the model the catalog extends: a model Moontide ships or one saved with save_midi_model'),
      confirmed: z.boolean().optional().describe('true only after the user said yes to the summary; send it with model and nothing else'),
      append: z.boolean().optional().describe('true to add this part to the draft of the model; absent or false starts a new draft'),
      more: z.boolean().optional().describe('true while more parts remain; absent or false on the last part'),
      source: z.string().min(1).max(200).optional().describe('The document title and version the list comes from; required when a draft starts'),
      programNumbering: z.enum(['from-0', 'from-1']).optional().describe('How the list numbers programs: from-1 when the first program is printed as 1; required when a draft starts'),
      overwrite: z.boolean().optional().describe('true to replace an existing catalog of the model; read when a draft starts'),
      banks: z
        .array(
          z.strictObject({
            category: z.string().min(1).max(60).optional().describe('The category the list gives these sounds'),
            bank: z
              .strictObject({
                msb: z.number().int().min(0).max(127).describe('Bank select MSB'),
                lsb: z.number().int().min(0).max(127).optional().describe('Bank select LSB'),
              })
              .optional()
              .describe('The bank of these sounds, as the list prints it; leave out when the list gives none'),
            role: z.enum(['melodic', 'rhythm']).optional().describe('rhythm for the drum kits of a model whose rhythm channels take a bank; absent means melodic sounds'),
            noteMap: z.string().min(1).max(32).nullable().optional().describe('For drum kits: the id of their drum map, or null when no map is known'),
            sounds: z
              .array(
                z.strictObject({
                  program: z.number().int().min(0).max(128).describe('The program number as the list prints it'),
                  name: z.string().min(1).max(80).describe('The sound name as the list prints it'),
                }),
              )
              .min(1)
              .max(500),
          }),
        )
        .min(1)
        .max(500)
        .optional()
        .describe('The sounds of this part, grouped by bank and category; at most 500 sounds in the call'),
    },
  }, async ({ model, confirmed, append, more, source, programNumbering, overwrite, banks }) => {
    try {
      const text = session.saveMidiCatalog({ model, confirmed, append, more, source, programNumbering, overwrite, banks });
      const { lines } = session.drainNotices();
      return { content: [{ type: 'text' as const, text: withNoticeLines(text, lines) }] };
    } catch (err) {
      const { lines } = session.drainNotices();
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(withNoticeLines(message, lines));
    }
  });

  // The two prompts and the one tool switch how page requests reach Claude
  // (never about music). The tool serves clients that offer no MCP prompts. None of them can start
  // or stop the monitor itself: Claude runs the command and stops the task. They only flip the server's
  // arming switch (one function, switchPageRequests) and read state.
  server.registerPrompt(PAGE_REQUESTS_ON_PROMPT, {
    title: PAGE_REQUESTS_ON_TITLE,
    description: PAGE_REQUESTS_ON_DESCRIPTION,
  }, () => {
    const result = switchPageRequests({ session, state: 'on' });
    if ('noPage' in result) {
      const notStarted = starter.current() === null;
      throw new McpError(
        ErrorCode.InvalidRequest,
        notStarted ? notStartedForRequestsText() : noPageForRequestsText(session.getPageUrl()),
      );
    }
    if ('noCommand' in result) {
      throw new McpError(ErrorCode.InternalError, result.noCommand);
    }
    return userMessage(result.text);
  });

  server.registerPrompt(PAGE_REQUESTS_OFF_PROMPT, {
    title: PAGE_REQUESTS_OFF_TITLE,
    description: PAGE_REQUESTS_OFF_DESCRIPTION,
  }, () => {
    const result = switchPageRequests({ session, state: 'off' });
    if (!('text' in result)) {
      throw new McpError(ErrorCode.InternalError, 'Turning page requests off gave no text');
    }
    return userMessage(result.text);
  });

  // Never drains notices. The on reply already holds the command, so the arming line would repeat
  // it, and requests waiting for a tool reply should not arrive in a reply about switching.
  server.registerTool(PAGE_REQUESTS_TOOL, {
    description: PAGE_REQUESTS_TOOL_DESCRIPTION,
    annotations: { destructiveHint: false, idempotentHint: true },
    inputSchema: {
      state: z.enum(['on', 'off']).describe(PAGE_REQUESTS_STATE_DESCRIPTION),
    },
  }, async ({ state }) => {
    const result = switchPageRequests({ session, state });
    if ('noPage' in result) {
      throw new Error(starter.current() === null ? notStartedForRequestsToolText() : noPageForRequestsToolText(session.getPageUrl()));
    }
    if ('noCommand' in result) {
      throw new Error(result.noCommand);
    }
    return { content: [{ type: 'text' as const, text: result.text }] };
  });

  // The start prompt and the start tool call one function, like the page-requests prompts and tool.
  // Neither drains notices. A failed start is thrown with its own loud message.
  server.registerPrompt(START_PROMPT, {
    title: START_PROMPT_TITLE,
    description: START_PROMPT_DESCRIPTION,
  }, async () => {
    try {
      return userMessage(await startMoontide(starter));
    } catch (err) {
      throw new McpError(ErrorCode.InternalError, err instanceof Error ? err.message : String(err));
    }
  });

  server.registerTool(START_TOOL, {
    description: START_TOOL_DESCRIPTION,
    annotations: { destructiveHint: false, idempotentHint: true },
  }, async () => {
    const text = await startMoontide(starter);
    return { content: [{ type: 'text' as const, text }] };
  });

  return server;
}
