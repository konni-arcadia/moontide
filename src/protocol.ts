// This file is the single description of the server<->page protocol.
// page/main.js mirrors these shapes by hand (plain JS, no build step, no shared import).

import { z } from 'zod';

export type AudioState = 'playing' | 'waiting-for-click' | 'stopped';

/** How many of the newest versions the History view loads first. */
export const HISTORY_WINDOW_SIZE = 100;

/**
 * One version row as the page receives it. `origin` mirrors VERSION_ORIGINS in src/history.ts;
 * page/history.js and page/history-view.js mirror this shape by hand.
 */
export interface HistoryVersion {
  id: number;
  at: string;
  origin: 'claude' | 'hand' | 'page';
  label?: string;
  restoredFrom?: number;
  // The RESOLVED parent: omitted for a root (no parent, a parent the history cap
  // dropped, or a malformed one). The page draws the tree from it and never guesses.
  parent?: number;
  // The current favorite name of this version, when it is a favorite.
  favorite?: string;
  // The time of the latest session-start line between the previous version and this one, so
  // the list can draw a "new session" divider above this row.
  sessionStart?: string;
  code: string;
}

/** The version just older than the oldest row sent, so that row still has something to compare against. */
export interface HistoryBeyond {
  id: number;
  code: string;
}

/**
 * A window of the history, newest first. `total` is the number of readable versions on disk;
 * `remaining` is how many are older than the oldest row sent.
 */
export interface HistoryWindow {
  versions: HistoryVersion[];
  beyond: HistoryBeyond | null;
  total: number;
  remaining: number;
}

// MIDI facts the page sends: facts only, never wording; the server words them
// once per change (src/midi-state.ts). page/midi-plan.js mirrors the limits below by hand
// (test/midi-plan.test.js checks both sides).
export type MidiAccessState = 'idle' | 'pending' | 'enabled' | 'denied' | 'unsupported' | 'failed';
export type MidiPortState = 'connected' | 'unplugged' | 'not-found' | 'ambiguous';

/** One port the playing code names: its state and the connected outputs whose name contains it. */
export interface MidiPortFact {
  name: string;
  state: MidiPortState;
  matches: string[];
}

/**
 * Something that happened in the page's MIDI layer that Claude must hear once: each event is sent with
 * one midi-state message and worded once by the server (src/midi-state.ts). page/midi-out.js builds them.
 */
export type MidiEvent =
  | { kind: 'reset'; instrument: string; reason: 'start' | 'reconnect' }
  | { kind: 'sound-cut'; instrument: string; channel: number }
  | { kind: 'sound-kept'; instrument: string; channel: number; sound: string }
  | { kind: 'send-failed'; instrument: string; what: 'reset' | 'setup'; failure: string }
  // The playing code wrote MIDI clock or transport (Strudel's own bytes), and the page dropped them.
  | { kind: 'clock-dropped' };

export interface MidiFacts {
  access: MidiAccessState;
  /** The error name when access is 'failed', else null. */
  failure: string | null;
  /** The code that last evaluated successfully contains a .midi( call. */
  usesMidi: boolean;
  /** The code of the latest evaluation attempt contains a .midi( call. */
  triedMidi: boolean;
  /** Connected output names in the order Strudel searches them. */
  outputs: string[];
  /** The ports the playing code names, in code order. */
  ports: MidiPortFact[];
  /** A .midi() call names no port: the output Strudel uses (null when there is none). */
  noPort: { using: string | null } | null;
  /** A port the page cannot read as a single-quoted name. */
  unreadable: boolean;
  hidden: boolean;
  playing: boolean;
  /** Events since the last message that carried them, at most MAX_MIDI_EVENTS, each sent once. */
  events: MidiEvent[];
}

// Every string in a midi-state is at most MAX_MIDI_NAME_LENGTH characters (the page cuts longer
// names with an ellipsis, the server rejects them and never trims); the arrays and the failure
// name are bounded too.
export const MAX_MIDI_NAME_LENGTH = 200;
export const MAX_MIDI_OUTPUTS = 64;
export const MAX_MIDI_PORTS = 32;
export const MAX_MIDI_FAILURE_LENGTH = 64;
// The page keeps at most this many events for one message (MAX_PAGE_EVENTS in page/midi-out.js).
export const MAX_MIDI_EVENTS = 20;

// The setup file (instruments.json) and the models behind it travel to the page in one `midi-rig`
// message. page/midi-rig.js mirrors the limits below (RIG_LIMITS) and the message shape
// by hand; test/midi-rig.test.js checks both sides.
export const MAX_RIG_INSTRUMENTS = 16;
export const MAX_RIG_SOUNDS = 512;
// The most controls a model may declare: the model schema's own `.max(32)` of `controls` in
// src/instruments.ts; mirrored by RIG_LIMITS.controls in page/midi-rig.js.
export const MAX_RIG_CONTROLS = 32;
// The most sounds a catalog (catalogs/<model id>.json) may hold; mirrored by RIG_LIMITS.catalogSounds in page/midi-rig.js.
export const MAX_RIG_CATALOG_SOUNDS = 5000;
// The most drum kits a catalog may hold (its kits list); mirrored by RIG_LIMITS.catalogKits in page/midi-rig.js.
export const MAX_RIG_CATALOG_KITS = 512;
export const MAX_RIG_PROBLEMS = 20;
// The most drum maps one instrument carries (the model's own plus built-in ones), the most notes in a map and the
// longest map or drum name; mirrored by RIG_LIMITS.drumMaps, .drumNotes and .drumName in page/midi-rig.js.
export const MAX_RIG_DRUM_MAPS = 16;
export const MAX_RIG_DRUM_NOTES = 128;
export const MAX_RIG_DRUM_NAME = 40;

/** One problem of the setup file: the exact field and the reason, both plain text. */
export interface RigProblem {
  field: string;
  reason: string;
}

export interface RigSound {
  name: string;
  program: number;
  bank?: { msb: number; lsb?: number };
  // Rhythm sounds only, present only when the model or catalog sets it: the id of the kit's drum map, or null when no map is known for the kit.
  noteMap?: string | null;
}

/** A drum map as the page shows it: which note plays which drum, in note order. */
export interface RigDrumMap {
  id: string;
  name: string;
  notes: { note: number; name: string }[];
}

export interface RigChannel {
  channel: number;
  role: 'melodic' | 'rhythm';
}

/** One control a model declares (a CC the page can send), in the instrument's own units. */
export interface RigControl {
  id: string;
  name: string;
  cc: number;
  min: number;
  max: number;
  default: number;
}

/** One instrument of the setup file, already resolved to its model; reset bytes are built on the server. */
export interface RigInstrumentMessage {
  id: string;
  model: string;
  modelName: string;
  port: string;
  channels: RigChannel[];
  bankSelect: 'none' | 'msb' | 'msb-lsb';
  defaultVolume: number;
  // Whether Moontide sends this instrument MIDI clock, Start and Stop while the playing code names it.
  clock: boolean;
  // The model's declared controls in model order; the page reads, sends and edits them.
  controls: RigControl[];
  reset: { messages: number[][]; waitMs: number } | null;
  sounds: { melodic: RigSound[]; rhythm: RigSound[] };
  // The number of catalog sounds that follow the model's own in `sounds.melodic`; 0 without a catalog.
  catalogSounds: number;
  // The drum fields (kits and note maps) form one block, kept together; the fields after it extend the message.
  // True when the model's rhythm channels choose a kit by bank select and program change.
  rhythmBank: boolean;
  // The id of the map the kits take unless they name another, or null when the model has none.
  drumMap: string | null;
  // The model's own drum maps, then the built-in maps it or its kits name; [] when nothing names a map.
  drumMaps: RigDrumMap[];
  // The number of catalog drum kits that follow the model's own in `sounds.rhythm`; 0 without them.
  catalogKits: number;
  // The fields the Instruments view's switch and settings editor read; modelChannels follows enabled.
  // False when the user switched the instrument off in the page (instruments-state.json); it is still a valid instrument of the file.
  enabled: boolean;
  // Every channel of the instrument's model, ascending, with the role the model gives it; `channels` holds the ones in use.
  modelChannels: RigChannel[];
}

/** When a change takes over: at once (the default), on the next bar line or on the next phrase line. */
export type ChangeTiming = 'now' | 'bar' | 'phrase';

/**
 * The shortest and longest phrase, in cycles, that set_code accepts with at: 'phrase'. page/change-timing.js
 * mirrors both by hand (test/protocol.test.js checks both sides).
 */
export const MIN_PHRASE_CYCLES = 2;
export const MAX_PHRASE_CYCLES = 64;

/** The largest tempo the page may report in BPM; a bigger number is not music and the schema refuses it. */
export const MAX_REPORTED_BPM = 100000;

export type ServerMessage =
  | { type: 'hello'; code: string; stopped: boolean }
  // `at` asks for the change to take over on the next bar or phrase line; absent or 'now' takes over
  // at once. page/main.js mirrors it by hand (parseTiming in page/change-timing.js).
  // `phraseCycles` (2 to 64) is the length of the phrase for at: 'phrase'; it is sent only with that timing.
  | { type: 'evaluate'; id: string; code: string; at?: ChangeTiming; phraseCycles?: number }
  | { type: 'stop'; id: string }
  // The history id of the code the page has loaded; null when that code could not be saved
  // to history. Sent after every confirmed success and right after hello when a version is
  // already loaded. `restoredFrom` is present only when
  // that version is a restore, and rides the same message as the id so the page never shows a
  // wrong "from".
  | { type: 'version'; id: number | null; restoredFrom?: number }
  // The history feed. Sent only to pages that sent history-request: the first window,
  // then one history-add per newly recorded version, or history-error when the list cannot be read.
  | ({ type: 'history' } & HistoryWindow)
  | { type: 'history-add'; version: HistoryVersion; total: number }
  // The answer to history-more: the next older versions, newest first, with what remains.
  | { type: 'history-older'; versions: HistoryVersion[]; beyond: HistoryBeyond | null; remaining: number }
  // A version was kept as a favorite or renamed: pushed to every page that asked for the history.
  | { type: 'history-favorite'; id: number; name: string }
  // The list cannot be read at all: the page shows its terminal "reload the page" message.
  | { type: 'history-error' }
  // The answer to a history-more that could not be read: the page keeps the versions it already
  // holds and offers "try again" (unlike history-error, which replaces the whole list).
  | { type: 'history-older-error' }
  // The answer to data-folder-request, sent only to a connection that presented the page
  // token. `path` is the whole Moontide data folder, or null when the folder is unknown or unusable (no
  // setup store, cannot be resolved, a control character, longer than MAX_DATA_FOLDER_LENGTH). The server
  // never cuts a path and never sends this unasked. page/main.js mirrors this shape by hand.
  | { type: 'data-folder'; path: string | null }
  // The answer to page-auth; ok false means the token is not the current one (a page from
  // an earlier start, or one not served by this Moontide).
  | { type: 'ask-auth'; ok: boolean }
  // The answer to load-failed, sent on the same connection only: ok true means the server kept the report
  // for Claude, ok false means the token is not the current one. Never followed by hello. The page's
  // load-failure module (page/load-failure-view.js) mirrors this shape by hand.
  | { type: 'load-failed-result'; ok: boolean }
  // A listener took the request and wrote it (Claude received it).
  | { type: 'ask-result'; id: string; status: 'received' }
  // Nobody listens; the request waits on the server. `waiting` counts the requests waiting
  // after this one.
  | { type: 'ask-result'; id: string; status: 'waiting'; waiting: number }
  // The server refused the request, with a short reason the page maps to its copy.
  | { type: 'ask-result'; id: string; status: 'refused'; reason: AskRefusalReason; detail?: string }
  // Requests that were waiting have just been handed to Claude (a tool reply or a listener).
  | { type: 'ask-received'; ids: string[] }
  // Whether page requests reach Claude live. Pushed to authenticated pages only,
  // right after ask-auth ok and whenever a listener connects or the connected one goes; live is true
  // while a listener is connected. It never carries a token. page/main.js mirrors it by hand.
  | { type: 'page-requests'; live: boolean }
  // Sent to the page that just lost the active role because another page authenticated (or took the
  // role over). It stops locally with the MIDI panic and plays nothing until it takes the role back
  // with take-over. It is sent before the new page's hello. It is sent again to a page that is already
  // superseded when a page becomes active while nobody was (the page only updates its text then).
  // page/main.js mirrors it by hand.
  | { type: 'superseded' }
  // Sent to every superseded page when the active page goes away and no other page took the role: no
  // tab plays any more. The page keeps its stopped state and says so; "Play in this tab" still works.
  // page/main.js mirrors it by hand.
  | { type: 'no-active-page' }
  // Sent to a page right after it authenticated, before midi-rig and hello, when the page files
  // the server serves (page/) differ from the ones it started with: the running server is older than the
  // page. A change in the compiled server code alone does not send it, because the page is then still the
  // one this server started with. It carries no hash, no file name and no path. page/main.js mirrors it
  // by hand.
  | { type: 'build-mismatch' }
  // Sent instead of build-mismatch when only the compiled server code differs from the one this
  // server started with: the server's own code was updated since it started, while the page it serves is
  // still the one it started with. The page shows a softer persistent line (restart Claude to use the
  // update) and refuses nothing. It carries no hash, no file name and no path. page/main.js mirrors it by
  // hand.
  | { type: 'server-updated' }
  // The state of the setup file (instruments.json) and the instruments it describes. Pushed to
  // the active page before hello and before an evaluate, only when a setup file exists or its state
  // changed since the last push to that page (a page that never saw a file hears nothing). A message
  // the page cannot read makes the page refuse code with .midi(). page/midi-rig.js (parseRigMessage)
  // mirrors it by hand.
  | { type: 'midi-rig'; setup: 'absent' }
  | { type: 'midi-rig'; setup: 'invalid'; problems: RigProblem[]; more: number }
  | { type: 'midi-rig'; setup: 'valid'; instruments: RigInstrumentMessage[] }
  // The answer to an instrument-switch (and to a settings edit), sent to the page that
  // asked. It follows the midi-rig push the change caused, so the page applies the new rig before it clears its pending
  // look. ok false: 'refused' (a plain reason, nothing changed), 'write-failed' (the file could not be saved; nothing
  // changed) or 'invalid' (the problems of an edit). page/main.js mirrors it by hand.
  | { type: 'instrument-result'; id: string; ok: true }
  | { type: 'instrument-result'; id: string; ok: false; kind: 'refused' | 'write-failed'; reason: string }
  | { type: 'instrument-result'; id: string; ok: false; kind: 'invalid'; problems: RigProblem[]; more: number };

/** The line a waiting change takes over on, and about how many seconds away it is. */
export interface PendingChange {
  cycle: number;
  seconds: number;
}

/** The two scripts the page loads from unpkg.com; a load-failed report names the ones that did not load. */
export const LOAD_FAILED_SCRIPTS = ['strudel', 'acorn'] as const;
export type LoadFailedScript = (typeof LOAD_FAILED_SCRIPTS)[number];

export type PageMessage =
  // `pending` is present when the change was checked and accepted but waits for a bar or phrase line:
  // the cycle it takes over on and about how many seconds away that is. The page sends `takeover` with the same
  // id when the line is audible; the server records the code it stored from this reply, so the message
  // carries only the id. page/main.js mirrors both by hand.
  // `bpm` is the tempo that plays after the change (the held tempo of a waiting change), in beats per minute.
  | { type: 'evaluated'; id: string; ok: true; code: string; audio: AudioState; pending?: PendingChange; bpm?: number }
  | { type: 'evaluated'; id: string; ok: false; code: string; error: string; line?: number }
  // evaluateId: the id of the Moontide evaluate request whose code was playing when this
  // error was raised; absent when that code came from a hand evaluation or the page's
  // reload replay. page/main.js mirrors this field by hand.
  | { type: 'runtime-error'; message: string; evaluateId?: string }
  | { type: 'stop-result'; id: string }
  | { type: 'takeover'; id: string }
  // A waiting change will not take over: Stop canceled it, or a newer change replaced it. The page sends
  // it only for a change whose pending reply went out; a closing or superseded page sends nothing (the server
  // handles both). page/main.js mirrors it by hand.
  | { type: 'takeover-canceled'; id: string; reason: 'stop' | 'replaced' }
  | { type: 'user-stopped' }
  | { type: 'hand-eval'; ok: true; code: string }
  | { type: 'hand-eval'; ok: false; error: string; line?: number }
  | { type: 'reconnect-eval-failed'; error: string; line?: number }
  // A part launched from the page's Parts view. The page has already evaluated the
  // code; page/main.js mirrors this shape by hand.
  | { type: 'part-launch'; code: string; part: string }
  // A drag on a Mixer control. The page has already evaluated the code; page/main.js
  // mirrors these shapes by hand. mixer-live is the code playing during the gesture (never
  // recorded, so get_code stays truthful); mixer-record is sent once, about 1.5 s after the last
  // move, and becomes one history version with its label.
  | { type: 'mixer-live'; code: string }
  | { type: 'mixer-record'; code: string; label: string }
  // history-request subscribes the page to live additions and asks for the first
  // window; history-restore brings a past version back through the restore_version path.
  // page/main.js mirrors these shapes by hand.
  | { type: 'history-request' }
  // Asked once per connection, right after page-auth and history-request; answered with
  // data-folder only to a connection that presented the page token. page/main.js mirrors it by hand.
  | { type: 'data-folder-request' }
  // The "Play in this tab" click of a superseded page: it asks to be the active page again. Accepted only
  // from an authenticated connection and answered with hello (the current code, replayed). page/main.js
  // mirrors this shape by hand.
  | { type: 'take-over' }
  | { type: 'history-restore'; id: number }
  // The id of the oldest row the page holds; answered with history-older.
  | { type: 'history-more'; before: number }
  // The page presents the token the server embedded in the page it served. Sent first on
  // open; a connection that did not authenticate cannot ask.
  | { type: 'page-auth'; token: string }
  // A page whose Strudel or acorn script did not load reports it once. It carries the page token itself and
  // is handled without trusting or attaching the connection, so it never changes which page is active. The
  // page's load-failure module (page/load-failure-view.js) mirrors this shape by hand.
  | { type: 'load-failed'; token: string; failed: LoadFailedScript[] }
  // One request from the page's right-click box. `chip` is the context text the user saw,
  // `current` the version id the top bar showed at Enter (null before any version). `moment` is
  // the Timeline's music under the pointer at the click, facts only (absent when nothing was drawn there).
  | { type: 'ask'; id: string; text: string; context: AskContext; chip: string; current: number | null; moment?: AskMoment }
  // The MIDI facts of the page, sent when they change and before `evaluated`
  // (facts only, never wording). page/main.js mirrors this shape by hand.
  | ({ type: 'midi-state' } & MidiFacts)
  // The user's switch on an instrument card. A set, never a toggle: asking for the state the
  // instrument already has changes nothing. Accepted only from the active page; answered with instrument-result.
  // page/main.js mirrors this shape by hand.
  | { type: 'instrument-switch'; id: string; instrument: string; enabled: boolean }
  // The user's edit of one instrument's port, channels and clock. `settings` is the full choice,
  // not a difference; the server patches those three keys of the entry, checks the result with the code that reads
  // instruments.json and answers with instrument-result. Accepted only from the active page. page/main.js mirrors
  // this shape by hand.
  | { type: 'instrument-settings'; id: string; instrument: string; settings: { port: string; channels: number[]; clock: boolean } };

export const MAX_PART_NAME_LENGTH = 100;

// Equals MAX_LABEL_LENGTH in src/history.ts; page/mixer-model.js mirrors it by hand
// (test/mixer-model.test.js checks both).
export const MAX_MIXER_LABEL_LENGTH = 200;

// The longest data folder path the server sends to the page (Windows long paths can pass 260); a longer
// path is answered as unknown, never cut. page/instruments-model.js mirrors it by hand
// (test/instruments-model.test.js checks both).
export const MAX_DATA_FOLDER_LENGTH = 1024;

// The most characters one request may carry. page/ask.js mirrors it by hand
// (test/ask.test.js checks both sides).
export const MAX_ASK_TEXT_LENGTH = 2000;

// Every string inside a request's context (and the chip text) is at most this long; the page cuts
// longer ones with an ellipsis, the server rejects them and never trims. page/ask.js mirrors it by
// hand (test/ask.test.js checks both sides).
export const MAX_ASK_CONTEXT_LENGTH = 200;

// The most notes one moment carries; the rest are counted in `more`. page/timeline.js mirrors it by
// hand (test/ask.test.js checks both sides).
export const MAX_MOMENT_NOTES = 32;

// The most bytes (UTF-8) one request line may have, the whole line Claude's Monitor reads: the prefix and the
// JSON with the text, the context, the chip and the moment. Text of 2000 characters in a script that takes 3
// bytes per character still fits with the rest of the line, but not every text of MAX_ASK_TEXT_LENGTH characters
// does: JSON writes a control character or U+2028 as six bytes. The page cuts notes off the end of a moment (and
// counts them in `more`) until the line fits, and does not send a text whose line cannot fit even then; the
// server refuses a longer line as 'line-too-long' and never cuts JSON. page/ask.js mirrors it by hand
// (test/ask.test.js checks both sides).
export const MAX_REQUEST_LINE_BYTES = 8192;

// Beats in one bar. Equals BEATS_PER_CYCLE in page/change-timing.js (test/ask.test.js checks both).
export const MOMENT_BEATS = 4;

// The most characters in a request id (the page makes the id up so answers can be matched).
export const MAX_ASK_ID_LENGTH = 64;

// The kinds of thing a right-click can point at. The Jam view is
// the source of 'note' (a pitch class with its role in the scale) and 'warning' (a chord that leaves it).
export const ASK_CONTEXT_KINDS = [
  'session',
  'version',
  'line',
  'track',
  'fader',
  'send',
  'effect',
  'effect-param',
  'bus',
  'bus-param',
  'part',
  'lane',
  'note',
  'warning',
  'instrument',
  'error',
] as const;

// One note of a moment: an event the Timeline drew at the instant. `track` is the lane's shown name,
// `instrument` the MIDI instrument and channel text of a MIDI lane, `note` and `sound` are what the event
// has (`drum` is the drum name the lane's drum map gives the note, absent when no map names it), `velocity` is gain x velocity, `start` and `end` are in cycles (the event's own span), `state` says
// whether the note is sounding at the instant (its drawn span holds it: a note shorter than 0.05 cycles is
// drawn, and counted, 0.05 wide, so `end` can come before the instant) or starts later in the same sixteenth
// of the bar. A note that began earlier in that sixteenth and already ended is not in a moment.
export type AskMomentNote = {
  track: string;
  instrument?: string;
  note?: string | number;
  drum?: string;
  sound?: string;
  velocity?: number;
  start: number;
  end: number;
  state: 'sounding' | 'starts';
};

// The music under the pointer when the user right-clicked the Timeline: the cycle, the beat in the bar (1-4),
// the instant in cycles (`at`), the version that was playing (null when unknown), the notes (at most
// MAX_MOMENT_NOTES) and how many more there were.
export type AskMoment = {
  cycle: number;
  beat: number;
  at: number;
  version: number | null;
  notes: AskMomentNote[];
  more: number;
};

// `track`, `effect`, `parameter`, `name` and `owner` are the names the views show (display names,
// never the `label:` identity); `value` is the text the control shows.
export type AskContext =
  | { kind: 'session' }
  | { kind: 'version'; id: number; label?: string }
  | { kind: 'line'; line: number; text: string }
  | { kind: 'track'; track: string }
  // A card of the Instruments view; `id` is the instrument's id from instruments.json.
  | { kind: 'instrument'; id: string }
  // A failed change sent to Claude from the banner; `text` is the error's first line, cut at 200.
  | { kind: 'error'; text: string }
  | { kind: 'fader'; track: string; value: string }
  | { kind: 'send'; track: string; bus: 'reverb' | 'delay'; value: string }
  | { kind: 'effect'; track: string; effect: string; bypassed: boolean }
  | { kind: 'effect-param'; track: string; effect: string; parameter: string; value: string }
  | { kind: 'bus'; bus: 'reverb' | 'delay'; orbit: number }
  | { kind: 'bus-param'; bus: 'reverb' | 'delay'; orbit: number; parameter: string; value: string }
  | { kind: 'part'; name: string; owner?: string }
  | { kind: 'lane'; track: string; cycle?: number }
  | { kind: 'note'; note: string; role?: 'root' | 'scale' | 'avoid' | 'outside' | 'off'; scale?: string }
  | { kind: 'warning'; chord: string; outside: string; avoid?: string; seconds: number; scale: string };

// Why the server refused a request; the page maps each to its own line.
// 'too-long' is the text over MAX_ASK_TEXT_LENGTH characters; 'line-too-long' is a whole line over
// MAX_REQUEST_LINE_BYTES bytes, which a text within the character limit can still cause (JSON writes some
// characters in six bytes, and a character of some scripts takes three).
export type AskRefusalReason = 'too-long' | 'line-too-long' | 'rate-limit' | 'queue-full' | 'token' | 'invalid';

const audioStateSchema = z.enum(['playing', 'waiting-for-click', 'stopped']);

const midiName = z.string().max(MAX_MIDI_NAME_LENGTH);
const midiChannel = z.number().int().min(1).max(16);

// A longer string is rejected, never trimmed (the page cuts before it sends).
const askString = z.string().max(MAX_ASK_CONTEXT_LENGTH);
const askName = askString.min(1);
const askBus = z.enum(['reverb', 'delay']);
// The role of a note in the scale the Jam view shows: the root, another scale note, a note to avoid,
// a chord note outside the scale, or a note that is not in the scale.
const askNoteRole = z.enum(['root', 'scale', 'avoid', 'outside', 'off']);

// The keys of one moment note. z.object drops a key it does not name (like every page message here), so
// test/ask.test.js pins these keys equal to the ones page/ask.js's MOMENT_NOTE_FIELDS may copy.
export const askMomentNoteShape = {
  track: askName,
  instrument: askName.optional(),
  note: z.union([askName, z.number().finite()]).optional(),
  drum: askName.optional(),
  sound: askName.optional(),
  velocity: z.number().finite().nonnegative().optional(),
  start: z.number().finite().nonnegative(),
  end: z.number().finite().nonnegative(),
  state: z.enum(['sounding', 'starts']),
};

const askMomentNote = z.object(askMomentNoteShape);

// More notes, a longer string or a number out of range is rejected, never trimmed.
const askMomentSchema = z.object({
  cycle: z.number().int().nonnegative(),
  beat: z.number().int().min(1).max(MOMENT_BEATS),
  at: z.number().finite().nonnegative(),
  version: z.number().int().positive().nullable(),
  notes: z.array(askMomentNote).max(MAX_MOMENT_NOTES),
  more: z.number().int().nonnegative(),
});

const askContextSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('session') }),
  z.object({ kind: z.literal('version'), id: z.number().int().positive(), label: askName.optional() }),
  // The text of a blank line is empty on purpose.
  z.object({ kind: z.literal('line'), line: z.number().int().positive(), text: askString }),
  z.object({ kind: z.literal('track'), track: askName }),
  z.object({ kind: z.literal('instrument'), id: askName }),
  z.object({ kind: z.literal('error'), text: askName }),
  z.object({ kind: z.literal('fader'), track: askName, value: askName }),
  z.object({ kind: z.literal('send'), track: askName, bus: askBus, value: askName }),
  z.object({ kind: z.literal('effect'), track: askName, effect: askName, bypassed: z.boolean() }),
  z.object({
    kind: z.literal('effect-param'),
    track: askName,
    effect: askName,
    parameter: askName,
    value: askName,
  }),
  z.object({ kind: z.literal('bus'), bus: askBus, orbit: z.number().int().nonnegative() }),
  z.object({
    kind: z.literal('bus-param'),
    bus: askBus,
    orbit: z.number().int().nonnegative(),
    parameter: askName,
    value: askName,
  }),
  z.object({ kind: z.literal('part'), name: askName, owner: askName.optional() }),
  z.object({ kind: z.literal('lane'), track: askName, cycle: z.number().int().nonnegative().optional() }),
  // `note` is a pitch class name, never an octave, string or fret; `role` and `scale` are both present or
  // both absent (the page enforces that), absent while the scale is not clear.
  z.object({ kind: z.literal('note'), note: askName, role: askNoteRole.optional(), scale: askName.optional() }),
  // `chord`, `outside` and `avoid` are note or chord names; `seconds` is the whole seconds until the warning
  // starts, 0 for now; `avoid` is left out when no scale note is to be avoided.
  z.object({
    kind: z.literal('warning'),
    chord: askName,
    outside: askName,
    avoid: askName.optional(),
    seconds: z.number().int().nonnegative(),
    scale: askName,
  }),
]);

/** The longest wait the server accepts in a pending reply: a day. */
export const MAX_PENDING_SECONDS = 86400;

const pendingChangeSchema = z.object({
  cycle: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  seconds: z.number().finite().nonnegative().max(MAX_PENDING_SECONDS),
});

// A plain z.union (not discriminatedUnion): 'runtime-error' has no 'ok' field, so the
// single-key discriminant used for the two 'evaluated' variants can't cover it.
const pageMessageSchema = z.union([
  z.object({
    type: z.literal('evaluated'),
    id: z.string(),
    ok: z.literal(true),
    code: z.string(),
    audio: audioStateSchema,
    pending: pendingChangeSchema.optional(),
    bpm: z.number().finite().positive().max(MAX_REPORTED_BPM).optional(),
  }),
  z.object({
    type: z.literal('takeover'),
    id: z.string().min(1).max(64),
  }),
  z.object({
    type: z.literal('takeover-canceled'),
    id: z.string().min(1).max(64),
    reason: z.enum(['stop', 'replaced']),
  }),
  z.object({
    type: z.literal('evaluated'),
    id: z.string(),
    ok: z.literal(false),
    code: z.string(),
    error: z.string(),
    line: z.number().int().positive().optional(),
  }),
  z.object({
    type: z.literal('runtime-error'),
    message: z.string(),
    evaluateId: z.string().min(1).max(64).optional(),
  }),
  z.object({
    type: z.literal('stop-result'),
    id: z.string(),
  }),
  z.object({
    type: z.literal('user-stopped'),
  }),
  z.object({
    type: z.literal('hand-eval'),
    ok: z.literal(true),
    code: z.string(),
  }),
  z.object({
    type: z.literal('hand-eval'),
    ok: z.literal(false),
    error: z.string(),
    line: z.number().int().positive().optional(),
  }),
  z.object({
    type: z.literal('reconnect-eval-failed'),
    error: z.string(),
    line: z.number().int().positive().optional(),
  }),
  z.object({
    type: z.literal('part-launch'),
    code: z.string().min(1),
    part: z.string().min(1).max(MAX_PART_NAME_LENGTH),
  }),
  z.object({ type: z.literal('mixer-live'), code: z.string().min(1) }),
  z.object({
    type: z.literal('mixer-record'),
    code: z.string().min(1),
    label: z.string().min(1).max(MAX_MIXER_LABEL_LENGTH),
  }),
  z.object({ type: z.literal('history-request') }),
  z.object({ type: z.literal('data-folder-request') }),
  z.object({ type: z.literal('take-over') }),
  z.object({ type: z.literal('history-restore'), id: z.number().int().positive() }),
  z.object({ type: z.literal('history-more'), before: z.number().int().positive() }),
  z.object({ type: z.literal('page-auth'), token: z.string().max(128) }),
  z.object({
    type: z.literal('load-failed'),
    token: z.string().max(128),
    failed: z
      .array(z.enum(LOAD_FAILED_SCRIPTS))
      .min(1)
      .max(LOAD_FAILED_SCRIPTS.length)
      .refine((names) => new Set(names).size === names.length, { message: 'a script is named twice' }),
  }),
  z.object({
    type: z.literal('ask'),
    id: z.string().min(1).max(MAX_ASK_ID_LENGTH),
    // No max on purpose: the server answers the specific 'too-long' refusal itself, and the 1 MiB
    // frame cap still bounds it.
    text: z.string(),
    context: askContextSchema,
    chip: z.string().min(1).max(MAX_ASK_CONTEXT_LENGTH),
    current: z.number().int().positive().nullable(),
    // z.object drops a key it does not name, so the moment must be named here to reach Claude.
    moment: askMomentSchema.optional(),
  }),
  z.object({
    type: z.literal('midi-state'),
    access: z.enum(['idle', 'pending', 'enabled', 'denied', 'unsupported', 'failed']),
    failure: z.string().max(MAX_MIDI_FAILURE_LENGTH).nullable(),
    usesMidi: z.boolean(),
    triedMidi: z.boolean(),
    outputs: z.array(midiName).max(MAX_MIDI_OUTPUTS),
    ports: z
      .array(
        z.object({
          name: midiName,
          state: z.enum(['connected', 'unplugged', 'not-found', 'ambiguous']),
          matches: z.array(midiName).max(MAX_MIDI_OUTPUTS),
        }),
      )
      .max(MAX_MIDI_PORTS),
    noPort: z.object({ using: midiName.nullable() }).nullable(),
    unreadable: z.boolean(),
    hidden: z.boolean(),
    playing: z.boolean(),
    // The default keeps a frame without events valid (an older page, a hand-built test frame).
    events: z
      .array(
        z.discriminatedUnion('kind', [
          z.object({ kind: z.literal('reset'), instrument: midiName, reason: z.enum(['start', 'reconnect']) }),
          z.object({ kind: z.literal('sound-cut'), instrument: midiName, channel: midiChannel }),
          z.object({ kind: z.literal('sound-kept'), instrument: midiName, channel: midiChannel, sound: midiName }),
          z.object({
            kind: z.literal('send-failed'),
            instrument: midiName,
            what: z.enum(['reset', 'setup']),
            failure: z.string().max(MAX_MIDI_FAILURE_LENGTH),
          }),
          z.object({ kind: z.literal('clock-dropped') }),
        ]),
      )
      .max(MAX_MIDI_EVENTS)
      .default([]),
  }),
  z.object({
    type: z.literal('instrument-switch'),
    id: z.string().min(1).max(MAX_ASK_ID_LENGTH),
    // The longest instrument id is 32 characters (idSchema in src/rig-util.ts).
    instrument: z.string().min(1).max(32),
    enabled: z.boolean(),
  }),
  z.object({
    type: z.literal('instrument-settings'),
    id: z.string().min(1).max(MAX_ASK_ID_LENGTH),
    instrument: z.string().min(1).max(32),
    // Sizes are bounded here and nothing else: an empty port or an empty channel list is accepted so that the
    // server's own validator, the one that reads instruments.json, gives the reason instead of a dropped message.
    settings: z.object({
      port: z.string().max(MAX_MIDI_NAME_LENGTH),
      channels: z.array(z.number().int()).max(16),
      clock: z.boolean(),
    }),
  }),
]);

/**
 * Parses a raw WebSocket text frame from the page into a validated PageMessage.
 * Throws an Error with a readable reason on invalid JSON or an invalid shape.
 */
export function parsePageMessage(raw: string): PageMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON from page: ${err instanceof Error ? err.message : String(err)}`);
  }
  const result = pageMessageSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Invalid page message shape: ${result.error.message}`);
  }
  return result.data;
}
