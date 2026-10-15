// Mirrors the message shapes described in src/protocol.ts by hand (plain JS, no build step,
// no shared import — the page is loaded as-is with no bundler, per the locked "no bundler" decision).

import {
  CONNECTION_LABELS,
  COPY,
  BUILD_MISMATCH_COPY,
  SERVER_UPDATED_COPY,
  soundState,
  audioReport,
  FIRST_CYCLE_WATCH_MS,
  RESUME_AFTER_STOP_TIMEOUT_MS,
  versionIndicator,
  runtimeErrorFromLog,
  isQueryErrorText,
  createOncePerChange,
  VCSL_MANIFEST_URL,
  VCSL_SAMPLE_BASE,
  createSoundLoadTracker,
  isFetchFailure,
  soundLoadFailureText,
} from './ui-state.js';
import { extractTracks, soloSource, trackRange } from './tracks.js';
import {
  PAGE_CYCLES,
  PREFETCH_FROM_CYCLE,
  TIMELINE_BUDGET_MS,
  TIMELINE_SLICE_CYCLES,
  TIMELINE_SETTLE_MS,
  TIMELINE_COPY,
  pageStartOf,
  playheadCycle,
  playheadReadingSide,
  rulerMarks,
  laneShapes,
  momentAt,
  rangeNotes,
  drumTrackIndexes,
  sameIndexSet,
  loopPeriod,
  loopLabel,
  createTrackColors,
  curvePoints,
  evaluateSolo,
  computeTimeline,
  drumNoteOf,
  pitchOf,
  toLaneEvent,
  velocityOf,
} from './timeline.js';
import {
  applyKey,
  readViewPrefs,
  writeViewPref,
  initialViewState,
  STORAGE_KEYS,
  viewButtonParts,
  layoutButtonParts,
  hintButtonState,
  MOTION_LABELS,
  toggleMotion,
  setHistoryMode,
  setJamInstrument,
  setJamChordTones,
  motionAfterOsChange,
  setChangeTiming,
  setSongLaunch,
  BUILT_VIEWS,
  VIEW_KEYS,
  VIEW_TITLES,
} from './views.js';
import { createHistoryView } from './history-view.js';
import { MixerRewriteError, applyEdits, touchedRanges, writeBus, writeTrack, writeTracks } from './mixer-rewrite.js';
import { MIXER_COPY, buildMixerModel, clipMixerLabel, forgetBypass, readBypassRecords, rememberBypass, writeBypassRecords } from './mixer-model.js';
import { createGestureRecorder } from './mixer-gesture.js';
import { createPreviewSender, midiTag, readMidiTracks, writeMidiControl } from './midi-controls.js';
import { createMixerView } from './mixer-view.js';
import {
  PARTS_COPY,
  extractArrangements,
  readArrangements,
  partsEmptyText,
  partsSkippedText,
  launchTargetCycle,
  launchOffset,
  applyArrangeOffset,
  rowSignature,
  partLaunchPart,
  partStates,
  sectionSpans,
} from './parts.js';
import { baseTitle, readSessionLabel, renderSessionIdentity } from './session-identity.js';
import { ASK_COPY, PAGE_TOKEN_PLACEHOLDER, cycleAt, describeContext, errorAskPrefill, lineAtY, timelineEditPrefill } from './ask.js';
import { createAskView } from './ask-view.js';
import { buildReading, readingAt, flattenLanes } from './jam-analysis.js';
import { readHarmony } from './harmony.js';
import { SONG_COPY, differsLine, quoted, readStructure, songMessageText, songNoteLines } from './structure.js';
import { checkSections, evaluateDeclared, expectedSource, sectionStarts } from './structure-check.js';
import { collectFit, evaluateFit, fitLookup, fitPairs, fitSource, pairKey } from './song-fit.js';
import { createSongView } from './structure-view.js';
import { buildSongGrid, cellRecordLabel, playingSection, sectionDeclared, songLine } from './song-grid-model.js';
import { SongEditRefusal, cellEdit, checkCell, checkSection, launchLine, launchShift, playResetEdit, sameShift, shiftEdit, textAfterCanceledLaunch } from './song-edit.js';
import { createSongGridView } from './song-grid-view.js';
import { SONG_FOLDS_COPY, isRememberable, readSongFolds, writeSongFolds } from './song-prefs.js';
import { JAM_COPY, buildJamModel, jamStuckFor, jamIsStuck } from './jam-model.js';
import { createJamView } from './jam-view.js';
import { createInstrumentsView } from './instruments-view.js';
import { instrumentsModel, readDataFolder, readInstrumentResult } from './instruments-model.js';
import { createMidiOut, installNoMidiShim, isKnownMidiRejection } from './midi-out.js';
import { installNoteTag, subscribe as subscribeNotes } from './note-tag.js';
import { MIDI_LIGHT_OFFSET_MS, createLights, heardMapper, lightLayout, readOutputPair, usableTempo } from './lights.js';
import {
  hhmm,
  hiddenTransition,
  indicatorModel,
  isStrudelNoDevicesError,
  MIDI_COPY,
  midiTitle,
  returnBannerText,
  TAKE_BACK_CONFIRM_MS,
} from './midi-plan.js';
import { createMidiView } from './midi-view.js';
import { checkFailureText, drumMapFor, parseRigMessage, rigFromReadFailure, withBuildMismatch } from './midi-rig.js';
import { drumLane } from './drum-lane.js';
import { captureQueryTypes, createSchedulerQueryScope, installQueryCheck } from './query-check.js';
import { createTempoGuard } from './tempo-guard.js';
import {
  BEATS_PER_CYCLE,
  CHANGE_COPY,
  MAX_REPORTED_BPM,
  MIN_TAKEOVER_LEAD_SECONDS,
  bpmOf,
  bpmText,
  clampPendingSeconds,
  countdownParts,
  isReportableBpm,
  parseTiming,
  pinnedTiming,
  queuedLine,
  settingLine,
} from './change-timing.js';
import { createTopBarView } from './top-bar-view.js';
import { BAR_COPY, bannerCopy, cycleBeat, sessionIssues, stripModel, tempoText, transport } from './bar-model.js';
import { createProblemView } from './problem-view.js';
import { createSessionView } from './session-view.js';
import { createSplitView } from './split-view.js';
import { SPLIT_COPY, SPLIT_DEFAULTS, clampSplit } from './split-model.js';
import { createTakeover } from './takeover.js';
import { createPageRewrite } from './page-rewrite.js';
import { PLACES_MAX_CYCLES, classifyNote, indexCode, perCycleCount, placesOf, readerCounter, trackScope } from './note-locate.js';
import { NoteEditStop, writeNoteEdit } from './note-edit.js';
import { NOTE_MARK_HEIGHT } from './timeline-gesture.js';
import { createTimelineEditView } from './timeline-edit-view.js';
import { createEvaluateTag } from './evaluate-tag.js';

await customElements.whenDefined('strudel-editor');

const replElement = document.getElementById('repl');
const editor = replElement && replElement.editor;
if (!editor) {
  throw new Error('Moontide: <strudel-editor> did not create its editor instance.');
}

// The MIDI IO layer. It enables Web MIDI right before the first evaluation whose
// code contains .midi( and publishes the MIDI facts (midi-state) to the server. publish stays false
// until the socket has opened and sent page-auth, so `ws` is never read before it exists; pageStopped
// and the document are read lazily, at call time.
let midiPublishReady = false;
// True from the server's `superseded` message (another tab took the active role) until this tab
// takes the role back and gets its hello. While true, this tab plays nothing and refuses every evaluation.
let pageSuperseded = false;
// True while this tab is superseded and the tab that played went away (no tab plays).
let pageNoActive = false;
// Set when the server says it comes from another build than this page; kept until the page
// reloads. While true, every rig this page keeps refuses .midi( code.
let pageBuildMismatch = false;
// Set when the server says its own code was updated since it started (the softer line); kept until the page reloads.
let pageServerUpdated = false;
// What the Session button counts besides the flags above: the socket state as renderConnectionState last drew it,
// and whether the MIDI indicator asked for attention at its last render.
let sessionConnection = 'connecting';
let sessionMidiAttention = false;
// The Instruments view's inputs the page has to remember. instrumentsOpen stays false until
// renderViews() has run, so no redraw hook reads viewState, ws or the view object before they exist.
// pageHelloSeen turns true when the server's hello arrives and is cleared only when the socket closes or
// errors (never by a take-over hello, so a take-back does not flash "Connecting..."); pageRefused is set by
// the ask-auth refusal (nothing reconnects by itself); pageSocket is 'connecting', 'open' or 'closed';
// pageDataFolder stays null until the data folder is sent to the page.
let instrumentsOpen = false;
// True once the Instruments view logged that the parser is missing, so the redraws that follow stay quiet.
let instrumentsParserMissingLogged = false;
let pageHelloSeen = false;
let pageRefused = false;
let pageSocket = 'connecting';
let pageDataFolder = null;
// The one place the page asks whether this browser has Web MIDI; midi-out and the Instruments view share it.
const supportsMidi = () => typeof navigator.requestMIDIAccess === 'function';
const midiOut = createMidiOut({
  getWebMidi: () => globalThis.WebMidi ?? null,
  enableWebMidi: () => {
    if (typeof globalThis.enableWebMidi !== 'function') {
      throw new Error("Moontide: Strudel's enableWebMidi is not available.");
    }
    return globalThis.enableWebMidi();
  },
  supportsMidi,
  // The permission state without a prompt. It asks for SysEx access, as Strudel's own enable does,
  // so the state read here is the one its request will meet.
  queryPermission: () => navigator.permissions.query({ name: 'midi', sysex: true }).then((status) => status.state),
  parse: (...args) => window.acorn.parse(...args),
  isPlaying: () => !pageStopped,
  isHidden: () => document.visibilityState === 'hidden',
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (timer) => clearTimeout(timer),
  // A muted track on a channel another track still plays ends only its own notes: its pattern, from the code that
  // played, is evaluated alone the way the Timeline does it (never the scheduler), and queried around the scheduler's now.
  queryTrackPattern: (code, index) => evaluateSolo(soloSource(code, index, { parse: window.acorn.parse })),
  clock: () => ({ now: editor.repl.scheduler.now(), cps: editor.repl.scheduler.cps }),
  // The MIDI clock reads the scheduler and the shared AudioContext at each pass, never keeping them.
  getScheduler: () => editor.repl.scheduler,
  getAudioContext: () => (typeof globalThis.getAudioContext === 'function' ? globalThis.getAudioContext() : null),
  perfNow: () => performance.now(),
  // A clock state change (a Start waiting, a Start reached, a Stop) re-renders the indicator and its popover rows.
  onClockState: () => renderMidiIndicator(),
  now: () => Date.now(),
  publish: (facts) => {
    // The indicator shows the same facts the server hears, so the page and Claude never disagree; it
    // renders even while the socket is closed, so it can hide.
    renderMidiIndicator(facts);
    if (!midiPublishReady || ws.readyState !== ws.OPEN) return false;
    ws.send(JSON.stringify({ type: 'midi-state', ...facts }));
    return true;
  },
});

// The single evaluation choke point: Claude's evaluate, the hello replay, Ctrl+Enter and Alt+Enter,
// the repl-evaluate event, editor.evaluate(), a Mixer move and a part launch all end in
// editor.repl.evaluate. The wrapper prepares MIDI first (enabling Web MIDI and waiting for the
// answer when the code has a .midi( call), checks the code against the setup file and sends the
// sounds it names, and then calls the original evaluate, with its result unchanged.
// It must never throw: a throw would skip the `evaluated` reply and the request would time out, so a
// MIDI problem is one console error and the evaluation still runs. Evaluations pass one serialized
// queue: a hand evaluation (Ctrl+Enter) can overlap Claude's, and the setup sends of one evaluation
// must never interleave with another's.
// The rig as the page last read it (the Mixer reads the MIDI tracks against it); the midi-rig handler keeps it.
let pageRig = { setup: 'absent' };
const originalReplEvaluate = editor.repl.evaluate;
let evalQueue = Promise.resolve();

// Code can evaluate fine and still throw every time Strudel queries it, which plays
// nothing while the old music is already gone. The repl's evaluate ends in
// `await scheduler.setPattern(pattern, autostart)` inside its own try/catch (pinned @strudel/repl 1.3.0
// bundle, same call through the property), just before it records the new pattern and activeCode. This
// wrapper test-queries the pattern over the next cycle there and throws on a failure. The throw lands in
// that catch, so the previous pattern keeps playing, the evaluation error is recorded and the update
// events fire, exactly as refuseEvaluation relies on. Ctrl+Enter, the hello replay, the Mixer and a part
// launch all pass here too, so a hand evaluation follows the same rule. Checking after evaluate returns
// would be too late: the failing pattern would already be the scheduler's pattern.
const scheduler = editor.repl.scheduler;
// State and TimeSpan are kept from the first evaluation on (captureQueryTypes, called before the user code
// of each evaluation runs), so a hand edit that assigns to those globals cannot change the check.
let queryTypes = { State: undefined, TimeSpan: undefined };
// The [query] error texts already forwarded for the change that is playing. Strudel's own log
// debounce (1 s per identical text) is not a once-per-change guard. A change begins when a pattern takes
// over in the scheduler, not when an evaluation starts: installQueryCheck resets it right before the
// scheduler gets the pattern, so a refused or failed evaluation never resets it (the old music that keeps
// playing must not have its errors forwarded a second time) and the new pattern's first synchronous tick
// already counts in the new change.
const queryErrors = createOncePerChange();
// The page's own queries (the Timeline's pages and solo patterns, the Drawer's lookahead, the MIDI
// stop sweep) log the same `[query] error:` text as the scheduler's, but they are not the music that plays;
// only a query made by the scheduler counts as a failure of the music. The scheduler's queries are run by
// the scope itself and a failure comes straight here (once per change), not through Strudel's log, whose
// 1 s debounce lets a page query hide the scheduler's report. The log listener drops every [query] text.
const schedulerQueries = createSchedulerQueryScope({
  getTypes: () => queryTypes,
  onError(logText) {
    const text = runtimeErrorFromLog(logText);
    if (text !== null && queryErrors.first(text)) sendRuntimeError(text);
  },
});

// The timing of one evaluation run, bound at the editor.repl.evaluate call (see the wrapper below):
// { timing, deferred }. `deferred` is the waiting change the run created (set by the takeover's onArmed), or null.
const NOW_TIMING = parseTiming('now');
let armedRun = null; // set right before a programmatic evaluation and consumed by the wrapper, synchronously
let activeRun = null; // the run whose evaluation is executing now (evaluations are serialized)

// The code and pattern a Stop (or a lost role) left playing when it canceled a waiting change. After the
// cancel the repl still holds the canceled text as committed, so these keep the readers on the music that played.
// Cleared by the next immediate success and by every takeover.
let canceledPlayingCode = null;
let canceledPlayingPattern = null;

/**
 * The code that plays now: the waiting change's playing code while a change waits for its line, else the code a
 * Stop-canceled change left, else the repl's activeCode. Every reader of "the playing code" goes through this, so
 * the views, the Mixer and a part launch never act on a change that has not taken over.
 */
function playingCode() {
  const waiting = takeover.pending();
  if (waiting !== null) return waiting.playingCode;
  if (canceledPlayingCode !== null) return canceledPlayingCode;
  return editor.repl.state.activeCode;
}

/**
 * The text a failed change reverts the editor to: the music that is audible and committed. While a change waits
 * that is the waiting change's own code (it will play, and the editor already shows it); otherwise it is the
 * playing code, which after a Stop-canceled change is the code that played, not the canceled text.
 */
function committedCode() {
  return takeover.pending() !== null ? editor.repl.state.activeCode : playingCode();
}

/** The pattern that plays now, by the same rule as playingCode(). */
function playingPattern() {
  const waiting = takeover.pending();
  if (waiting !== null) return waiting.playingPattern;
  if (canceledPlayingPattern !== null) return canceledPlayingPattern;
  return editor.repl.state.pattern;
}

/** Arms the timing of the next editor.repl.evaluate call; the wrapper takes it synchronously. */
function armRun(timing) {
  const run = { timing, deferred: null, bpm: undefined, midiDeferred: false };
  armedRun = run;
  return run;
}

/** The AudioContext time of a cycle line, from the scheduler's current tempo segment (as a hap's targetTime). */
function audioTimeOfCycle(cycle) {
  return (cycle - scheduler.num_cycles_at_cps_change) / scheduler.cps + scheduler.seconds_at_cps_change + scheduler.latency;
}

/** Milliseconds until a cycle line is audible (0 when it already is). */
function msUntilCycle(cycle) {
  return Math.max(0, (audioTimeOfCycle(cycle) - globalThis.getAudioContext().currentTime) * 1000);
}

// A change asked for a bar or phrase line is checked at once; the scheduler plays a gate (old music
// before the line, new code from it) and what follows the takeover (MIDI facts, views, the server's history
// entry) runs when the line is audible. onReached applies the tempo the waiting code asked for (it was held
// back right after the evaluation). onLead, a little before the line, serves the clock instruments the waiting
// code names and sends its MIDI setup (sounds, controls) stamped on the line; the takeover commits that plan, and
// a cancel drops it (or, once it went out, puts the playing code's sounds back after it). At the request the setup was only checked (evaluateWithSetup): nothing reached an instrument.
const takeover = createTakeover({
  getScheduler: () => scheduler,
  getTypes: () => queryTypes,
  getTiming: () => (activeRun !== null ? activeRun.timing : NOW_TIMING),
  // The old music covers the way to the line at the tempo that plays, not at the tempo the waiting code just set.
  getCps: () => tempoGuard.playing(),
  isPlaying: () => scheduler.started === true && !pageStopped && hasEvaluatedSuccessfully && !!scheduler.pattern,
  msUntil: msUntilCycle,
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (timer) => clearTimeout(timer),
  onArmed(record) {
    if (activeRun !== null) activeRun.deferred = record;
    // The first finisher of the record: the Mixer and Parts stop saying "waiting" and read the new code at the
    // takeover, before the finishers that report it.
    takeover.whenFinished(record, () => {
      canceledPlayingCode = null;
      canceledPlayingPattern = null;
      // The countdown ends in the same turn the new code starts, and its spoken line is cleared silently.
      topBarUi.showCountdown(null);
      topBarUi.clearStatus();
      syncWaitingViews();
    });
    syncWaitingViews();
    // The top bar shows the wait from the moment the change is accepted (checked, and armed behind its line):
    // the countdown at once, the spoken line once for the whole wait (also when this change replaced another).
    record.at = activeRun !== null ? activeRun.timing.at : undefined;
    try {
      topBarUi.say(queuedLine(record.at));
      drawTopBar();
    } catch (err) {
      console.error('Moontide: the top bar could not show the waiting change:', err);
    }
  },
  onLead(record) {
    try {
      if (typeof record.code !== 'string') {
        console.error('Moontide: the MIDI setup of the waiting change could not be prepared: its code is not known.');
        return;
      }
      midiOut.prepareTakeover(record.code);
      const plan = midiOut.prepareSetup(record.code, { atCycle: record.boundary });
      if (plan === null) return;
      if (plan.refusal !== null) {
        // The rig changed since the request: the setup is skipped, the change still takes over, and the MIDI facts
        // report the port problem.
        console.error(`Moontide: the MIDI setup of the waiting change was skipped: ${plan.refusal.split('\n')[0]}`);
        return;
      }
      record.midiPlan = plan;
      void plan.send();
    } catch (err) {
      console.error('Moontide: the MIDI setup of the waiting change could not be prepared:', err);
    }
  },
  onReached(record) {
    // A microtask after the gate's first query past the line: the downbeat is already timestamped on the line
    // and the old bar is untouched. A canceled record never gets here (the takeover skips it).
    if (takeover.pending() !== record || record.newCps === null) return;
    try {
      // Kept for a cancel after this point (Stop before the line is audible): the tempo that played goes back with it.
      record.cpsBefore = tempoGuard.playing();
      tempoGuard.apply(record.newCps);
    } catch (err) {
      console.error('Moontide: the tempo of the waiting change could not be applied:', err);
    }
  },
  onCancel(record, reason) {
    // A section launch that waited for this record is over, whatever the reason.
    const ownLaunch = gridLaunch !== null && gridLaunch.record === record;
    if (ownLaunch) {
      gridLaunch = null;
      gridQueued = null;
    }
    // A cell change that waited for this record is over too: nothing was recorded for it.
    if (gridCellWait !== null && gridCellWait.record === record) gridCellWait = null;
    // The setup that did not go out is forgotten; one that went out (stamped on the line, it cannot be recalled) is
    // answered by the playing code's sounds and controls sent just after it. The clock serves the playing code's
    // instruments only again.
    try {
      record.midiPlan?.drop();
      midiOut.abandonTakeover();
    } catch (err) {
      console.error('Moontide: the MIDI setup of the canceled change could not be dropped:', err);
    }
    // A change whose gate already passed its line has set its tempo (onReached); canceled before the line is audible,
    // the tempo of the music that plays goes back with it, so a later evaluation without a setcps does not inherit it.
    if (typeof record.cpsBefore === 'number') {
      try {
        tempoGuard.apply(record.cpsBefore);
      } catch (err) {
        console.error('Moontide: the tempo of the canceled change could not be taken back:', err);
      }
    }
    // The server learns about a waiting change that was stopped or replaced, but only when it already heard the
    // reply that announced it (a change canceled before its reply says so in the reply itself). Sent here,
    // synchronously, so it goes out before user-stopped and stop-result (sent after stopSoundLocally resolves)
    // and before the reply of the newer change. Any other reason (superseded, unload, canceled) sends nothing: the
    // server drops the change itself on detach and attach.
    if ((reason === 'stop' || reason === 'replaced') && record.evaluateId !== null && record.replied === true) {
      sendIfOpen(JSON.stringify({ type: 'takeover-canceled', id: record.evaluateId, reason }));
    }
    // After Stop the scheduler must not keep the canceled gate: a restart without a new evaluation would play
    // the old code up to the canceled line and the new code after it, with nothing recording it. The new text
    // stays in the editor and plays on the next Play (the same holds for a tab that lost the role or closes). A
    // replaced record's gate is being replaced by the caller.
    if (reason !== 'replaced' && scheduler.pattern === record.gate) scheduler.pattern = record.playingPattern;
    // The repl still holds the canceled change as committed: the readers keep the music that played. A replaced
    // record has a successor that is armed (or takes over at once) in the same turn and clears or keeps this.
    if (reason === 'stop' || reason === 'superseded' || reason === 'unload' || reason === 'canceled') {
      canceledPlayingCode = record.playingCode;
      canceledPlayingPattern = record.playingPattern;
    }
    // The person's own cancel of a waiting section launch: the music keeps playing, and the editor goes back to the code
    // that plays (the launch wrote only the shift into it), unless the person typed over that text meanwhile: typing that
    // was never evaluated is never replaced. Nothing is sent to the server: a launch has no evaluate id and was never
    // recorded. A Stop while the launch of the grid waits does the same: the shift it wrote would never play (Play writes
    // shift 0), and left in the editor it would read as typing that was never evaluated and lock the grid.
    if (reason === 'canceled' || (reason === 'stop' && ownLaunch)) putBackCanceledLaunch(record);
    // A replaced record has a successor that is armed (its onArmed shows the wait again) or takes over at once
    // (its takeover redraws the views): here the Mixer only stops saying "waiting", with no redraw from the code
    // that is being evaluated.
    if (reason === 'replaced') mixerUi.setWaiting(false);
    else syncWaitingViews();
    // The countdown always ends with the wait. Stop says so once; any other reason clears the line silently (a
    // replacing change says its own line right after, an immediate one needs none).
    topBarUi.showCountdown(null);
    if (reason === 'stop' || reason === 'canceled') topBarUi.say(CHANGE_COPY.canceled);
    else topBarUi.clearStatus();
  },
  onError: (text, err) => console.error(text, err),
});
installQueryCheck(scheduler, {
  getTypes: () => queryTypes,
  queryErrors,
  schedulerQueries,
  takeover,
  getPlayingCode: () => (hasEvaluatedSuccessfully ? playingCode() : ''),
});

// The top bar's tempo readout and countdown. The view only writes what changed.
const topBarUi = createTopBarView({
  document,
  ResizeObserver,
});

// A cps that is not usable is logged once per distinct value (the poll runs four times a second), for the playing
// tempo and for the tempo a waiting change brings.
let badTempoLogged;
let badWaitingTempoLogged;

/**
 * Draws the tempo and the countdown from the scheduler's own state (never from a timer of the view): the tempo is
 * the scheduler's cps, which keeps the old value until a waiting change's line, and the countdown is the distance
 * to the waiting change's line in beats of the music. The tempo readout is always shown: while this tab does not
 * play (before the first evaluation, after Stop, with sound off, in a superseded tab) it shows the dash, and a
 * waiting change that carries a new tempo adds it after an arrow ('118 → 124 BPM'). The countdown is hidden while
 * nothing plays. The view redraws only when a text changed.
 */
function drawTopBar() {
  renderTransport();
  const idleTempo = tempoText({ playing: false });
  const plays = currentSoundState === 'playing' && !pageSuperseded && hasEvaluatedSuccessfully;
  if (!plays) {
    topBarUi.showTempo(idleTempo);
    topBarUi.showCycleBeat(null);
    topBarUi.showCountdown(null);
    syncGridQueued(null);
    return;
  }
  const record = takeover.pending();
  const cps = scheduler.cps;
  try {
    const bpm = bpmOf(cps);
    // The tempo a waiting change brings, when it carries one; a bad number is logged once and the arrow is left out.
    let waitingBpm = null;
    if (record !== null && typeof record.newCps === 'number') {
      try {
        const candidate = bpmOf(record.newCps);
        // bpmOf lets a tiny positive cps through as 0; bpmText refuses it here, so only the arrow is dropped and the log names this number.
        bpmText(candidate);
        waitingBpm = candidate;
      } catch (err) {
        if (!Object.is(badWaitingTempoLogged, record.newCps)) {
          badWaitingTempoLogged = record.newCps;
          console.error(`Moontide: the top bar cannot show the tempo of the waiting change, it reports cps ${String(record.newCps)}:`, err);
        }
      }
    }
    topBarUi.showTempo(tempoText({ playing: true, bpm, waitingBpm }));
  } catch (err) {
    topBarUi.showTempo(idleTempo);
    if (!Object.is(badTempoLogged, cps)) {
      badTempoLogged = cps;
      console.error(`Moontide: the top bar cannot show the tempo, the scheduler reports cps ${String(cps)}:`, err);
    }
  }
  const raw = scheduler.now();
  const now = Number.isFinite(raw) && raw > 0 ? raw : 0;
  topBarUi.showCycleBeat(cycleBeat(now));
  if (record === null || record.at === undefined || record.boundary - now <= 0) {
    topBarUi.showCountdown(null);
    syncGridQueued(now);
    return;
  }
  topBarUi.showCountdown({ beatsLeft: (record.boundary - now) * BEATS_PER_CYCLE, at: record.at });
  syncGridQueued(now);
}

/**
 * Hands the queued section header of the Song grid its countdown for this poll: the rest of the top bar's text
 * (`in 3 bars`, `in 2 beats`, `in 1 beat`) from the same record and the same cycle `now` the bar just drew, so the two
 * never disagree. `now` is null while nothing plays. The grid is written in the same turn when the text changed.
 */
function syncGridQueued(now) {
  let next = null;
  if (now !== null && gridLaunch !== null && takeover.pending() === gridLaunch.record && gridLaunch.record.boundary - now > 0) {
    next = {
      index: gridLaunch.index,
      countdownText: countdownParts((gridLaunch.record.boundary - now) * BEATS_PER_CYCLE).rest,
      line: gridLaunch.record.boundary,
    };
  } else if (now !== null && gridAlready !== null && gridAlready.line - now > 0) {
    // A launch that needs no code change counts down to its natural arrival with the same words.
    next = { index: gridAlready.index, countdownText: countdownParts((gridAlready.line - now) * BEATS_PER_CYCLE).rest, line: gridAlready.line };
  }
  const same = gridQueued === next || (gridQueued !== null && next !== null && gridQueued.index === next.index && gridQueued.countdownText === next.countdownText && gridQueued.line === next.line);
  if (same) return;
  gridQueued = next;
  if (songGridReading !== null) updateSongGridLive();
}

// The always-on page poll (every 250 ms, for the life of the page). It finishes a waiting change whose line the
// scheduler has reached when the finish timer was late (a throttled tab), then draws the top bar. The clamp is the
// one the page uses for every scheduler.now() read. A throttled hidden tab recomputes from the cycle position on
// return, never from accumulated ticks.
setInterval(() => {
  const raw = scheduler.now();
  takeover.finishIfDue(Number.isFinite(raw) && raw > 0 ? raw : 0);
  try {
    drawTopBar();
  } catch (err) {
    console.error('Moontide: the top bar could not be drawn:', err);
  }
  try {
    pollSongGrid();
  } catch (err) {
    console.error('Moontide: the song grid could not follow the page:', err);
  }
  try {
    pollTimelineEdit();
  } catch (err) {
    console.error('Moontide: the Timeline note panel could not follow the page:', err);
  }
}, 250);

// The program has already run when the check refuses it (or when evaluate fails later), so a
// top-level setcps/setcpm of the refused code has already reached the scheduler while the previous music
// keeps playing. The guard puts the previous tempo back when an evaluation fails.
const tempoGuard = createTempoGuard(scheduler);

/** The tempo in BPM for a reply, or undefined (with one console line) when the cps is not a usable number. */
function bpmForReply(cps) {
  try {
    const bpm = bpmOf(cps);
    if (!isReportableBpm(bpm)) {
      // The server's schema would drop the whole reply for it (above the maximum, or a tempo that rounds to 0.0 BPM): the
      // tempo is left out of the reply, loudly here.
      console.error(`Moontide: the tempo (${bpm} BPM) is outside what a reply can state (above 0 up to ${MAX_REPORTED_BPM} BPM), so the reply leaves it out.`);
      return undefined;
    }
    return bpm;
  } catch (err) {
    console.error(`Moontide: the tempo for the reply is not usable (cps ${String(cps)}):`, err);
    return undefined;
  }
}

/** The wait of a waiting change in seconds for its reply, clamped into what the server accepts (one console line when it was). */
function pendingSecondsForReply(boundary) {
  const seconds = msUntilCycle(boundary) / 1000;
  const sent = clampPendingSeconds(seconds);
  if (!Object.is(sent, seconds)) {
    console.error(`Moontide: the wait of the waiting change (${String(seconds)} s) is outside what a reply can state, so ${sent} s is reported.`);
  }
  return sent;
}

/**
 * Fails an evaluation with `text` as its error, through the library's own failure path: the original
 * evaluate catches the throw, records it as the evaluation error and fires its update events (pending
 * true then false), so Claude's evaluate, the hello replay, a hand evaluation, the Mixer and a part
 * launch all see a normal failed evaluation, and the music that played keeps playing. The source must
 * be an expression (a bare throw statement fails in Strudel's transpiler), and the text travels
 * through a global so quotes and line breaks never enter the evaluated source.
 */
async function refuseEvaluation(text, rest) {
  globalThis.__moontideRefusal = text;
  try {
    await originalReplEvaluate.call(editor.repl, '(() => { throw new Error(globalThis.__moontideRefusal); })()', ...rest);
  } finally {
    delete globalThis.__moontideRefusal;
  }
  return undefined;
}

async function evaluateWithSetup(code, rest) {
  // A tab that lost the active role never restarts its scheduler, so it cannot double the notes
  // of the tab that plays. This is the one place every path ends in: Ctrl+Enter and Alt+Enter, the
  // repl-evaluate event, editor.evaluate(), a Mixer move and a part launch. The hello replay and
  // Claude's evaluate never reach a superseded tab (the server sends them to the active page only), and
  // the take-over hello clears the flag before it replays. Refuse before any MIDI preparation.
  if (pageSuperseded) {
    console.error(`Moontide: evaluation refused: ${pageNoActive ? 'no tab is playing' : 'Moontide is playing in another tab'}.`);
    showMixerProblem(pageNoActive ? MIDI_COPY.refusedNoActive : MIDI_COPY.refusedSuperseded);
    return undefined;
  }
  queryTypes = captureQueryTypes(queryTypes, globalThis);
  try {
    await midiOut.beforeEvaluate(code);
  } catch (err) {
    console.error('Moontide: MIDI preparation failed:', err);
  }
  const run = activeRun;
  let plan = null;
  // A change that waits for its line is only checked now (a refusal fails the evaluation at once and the
  // old music keeps playing); its setup is prepared again and sent at the lead (onLead), so nothing of it reaches an
  // instrument before the line. A throw of plan() is left to the setPattern seam, which fails the evaluation itself.
  let waits = false;
  try {
    waits = takeover.plan() !== null;
  } catch {
    waits = false;
  }
  if (waits) {
    try {
      const refusal = midiOut.checkSetup(code);
      if (refusal !== null) return refuseEvaluation(refusal, rest);
    } catch (err) {
      console.error('Moontide: the MIDI setup could not be checked:', err);
      return refuseEvaluation(checkFailureText(err, !pageStopped), rest);
    }
    if (run !== null) run.midiDeferred = true;
  } else {
    try {
      plan = midiOut.prepareSetup(code);
    } catch (err) {
      // A failing check is loud: it refuses the evaluation and names itself, never a silent skip.
      console.error('Moontide: the MIDI setup could not be checked:', err);
      return refuseEvaluation(checkFailureText(err, !pageStopped), rest);
    }
    if (plan !== null && plan.refusal !== null) return refuseEvaluation(plan.refusal, rest);
    if (plan !== null) await plan.send();
  }
  let result;
  tempoGuard.begin();
  try {
    result = await originalReplEvaluate.call(editor.repl, code, ...rest);
  } catch (err) {
    // A rejected evaluation is a failed one: the tempo and the sounds it sent are rolled back like any other failure.
    tempoGuard.end(true);
    if (plan !== null) await plan.rollback();
    throw err;
  }
  const failed = !!editor.repl.state.evalError;
  const waitingRecord = activeRun !== null ? activeRun.deferred : null;
  // A waiting change must not touch the music that still plays, so its tempo is taken back now and
  // applied at the line (onReached); the reply states it as the tempo from that cycle.
  const { requested } = tempoGuard.end(failed, { hold: !failed && waitingRecord !== null });
  if (!failed && activeRun !== null) {
    if (waitingRecord !== null) {
      waitingRecord.newCps = typeof requested === 'number' ? requested : null;
      activeRun.bpm = bpmForReply(waitingRecord.newCps ?? scheduler.cps);
    } else {
      activeRun.bpm = bpmForReply(scheduler.cps);
    }
  }
  if (plan !== null) {
    if (editor.repl.state.evalError) await plan.rollback();
    else plan.commit();
  } else if (run !== null && run.midiDeferred === true && !failed && run.deferred === null) {
    // The run expected to wait but took over at once (the music stopped during the preparation): the setup goes out
    // now, so no change ever plays without its setup.
    await sendLateSetup(code);
  }
  return result;
}

/** The MIDI setup of a change that took over at once although it was checked as a waiting one. Never throws. */
async function sendLateSetup(code) {
  try {
    const late = midiOut.prepareSetup(code);
    if (late === null) return;
    if (late.refusal !== null) {
      console.error(`Moontide: the change took over at once and its MIDI setup was skipped: ${late.refusal.split('\n')[0]}`);
      return;
    }
    console.error('Moontide: the change was meant to wait for its line but took over at once, so its MIDI setup went out after it.');
    await late.send();
    late.commit();
  } catch (err) {
    console.error('Moontide: the MIDI setup of the change could not be sent:', err);
  }
}

editor.repl.evaluate = (code, ...rest) => {
  // The timing is bound to this run here, synchronously, before the run enters the serial queue: a
  // programmatic caller armed it just before this call (the hello replay, a Mixer move, a part launch and Claude's
  // change each arm their own), so an unarmed run is a hand evaluation and follows the stored page setting.
  const evalRun =
    armedRun !== null
      ? armedRun
      : { timing: parseTiming(viewState.changeTiming), deferred: null, bpm: undefined, midiDeferred: false };
  armedRun = null;
  const run = evalQueue.then(async () => {
    activeRun = evalRun;
    try {
      return await evaluateWithSetup(code, rest);
    } finally {
      activeRun = null;
    }
  });
  evalQueue = run.catch(() => undefined);
  return run;
};

// Strudel's .midi() asks for Web MIDI again on every evaluation while it is not enabled, and each
// denial is an unhandled rejection. After the user denied the permission, that one known rejection
// is one console line (once per page session) instead of a flood; every other rejection keeps the
// browser's default report.
let askedAgainLogged = false;
window.addEventListener('unhandledrejection', (event) => {
  if (!isKnownMidiRejection(event.reason) || midiOut.facts().access !== 'denied') return;
  event.preventDefault();
  if (askedAgainLogged) return;
  askedAgainLogged = true;
  console.error('Moontide: Strudel asked for Web MIDI again after the permission was denied; ignored.');
});

// Clear the '// LOADING' placeholder that <strudel-editor> starts with. The editor stays
// blank until the first code arrives from the server (no custom skeleton).
editor.setCode('');

const productName = document.getElementById('product-name');
const connectionStateEl = document.getElementById('connection-state');
const soundStateEl = document.getElementById('sound-state');
const soundStateLabel = soundStateEl.querySelector('.state-label');
const overlay = document.getElementById('audio-unlock-overlay');
const overlayCta = document.getElementById('audio-unlock-cta');
const overlayError = document.getElementById('audio-error');
const buildMismatchEl = document.getElementById('build-mismatch');
const versionIndicatorEl = document.getElementById('version-indicator');
const transportButton = document.getElementById('transport-button');
const transportWord = transportButton.querySelector('.transport-word');
const stateHereEl = soundStateEl.querySelector('.state-here');
const workspace = document.getElementById('workspace');
const viewPanel = document.getElementById('view-panel');
const timelineView = document.getElementById('timeline-view');
const timelineMessage = document.getElementById('timeline-message');
const timelineBody = document.getElementById('timeline-body');
const timelineRuler = document.getElementById('timeline-ruler');
const timelineSections = document.getElementById('timeline-sections');
const timelineLanes = document.getElementById('timeline-lanes');
const timelinePlayhead = document.getElementById('timeline-playhead');
const timelinePlayheadCycleEl = timelinePlayhead.querySelector('.playhead-cycle');
const historyViewEl = document.getElementById('history-view');
const mixerViewEl = document.getElementById('mixer-view');
const partsView = document.getElementById('parts-view');
const partsMessage = document.getElementById('parts-message');
const partsRows = document.getElementById('parts-rows');
const songNotesEl = document.getElementById('song-notes');
if (!songNotesEl) throw new Error('Moontide: the song notes element is missing from the page.');
// The lines above the song grid in the Parts view; they draw what page/structure.js read from the code.
const songUi = createSongView({ document, notes: songNotesEl });
// The Song grid that replaces the Parts rows for a piece that declares a readable song. Its handlers are added as each
// gesture gets its behaviour; a gesture without one throws, so nothing is ignored silently.
const songGridHandlers = {};
const songBarEl = document.getElementById('song-bar');
const songNowEl = document.getElementById('song-now');
const songLaunchEl = document.getElementById('song-launch');
const songLaunchLabelEl = document.getElementById('song-launch-label');
const songLineEl = document.getElementById('song-line');
const songCellListEl = document.getElementById('song-cell-list');
if (!songBarEl || !songNowEl || !songLaunchEl || !songLaunchLabelEl || !songLineEl || !songCellListEl) throw new Error('Moontide: the song toolbar elements are missing from the page.');
songLaunchLabelEl.textContent = SONG_COPY.launchLabel;
const songGridUi = createSongGridView({ document, rows: partsRows, bar: songBarEl, now: songNowEl, line: songLineEl, launchGroup: songLaunchEl, list: songCellListEl, handlers: songGridHandlers });
// The note panel under the Timeline lanes and the selection on the lanes. A click picks a note, the panel says whether the page
// can edit it, and keys and buttons change its pitch, turn it into a rest or change its velocity when it can. What the panel
// needs to know is read in describeTimelineNote; the edit itself runs on the serial chain (editTimelineNote), further down.
const timelineNotePanel = document.getElementById('timeline-note');
const timelineNoteLine = document.getElementById('timeline-note-line');
if (!timelineNotePanel || !timelineNoteLine) throw new Error('Moontide: the Timeline note panel is missing from the page.');
const timelineEditUi = createTimelineEditView({
  document,
  lanes: timelineLanes,
  panel: timelineNotePanel,
  line: timelineNoteLine,
  rootFontPx: () => parseFloat(getComputedStyle(document.documentElement).fontSize),
  // The pause that gathers the steps of a key or a button runs on the page's own timers.
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => clearTimeout(handle),
  handlers: {
    describe: (laneIndex, eventIndex) => describeTimelineNote(laneIndex, eventIndex),
    // The view hands over one edit at a time and waits for its outcome, which is given back with the same id.
    edit: (info, change, id) => {
      chain = chain.then(() => editTimelineNote(info, change, id)).catch((err) => reportChainError('timeline edit', err));
    },
    // A gesture on a note the page cannot edit becomes a ready-made request in the Ask box; nothing is written or sent.
    prepare: (info, change, point) => askAboutTimelineNote(info, timelineGestureOf(change), point),
    ask: (info, point) => askAboutTimelineNote(info, undefined, point),
    // A range of cycles on one lane opens the Ask box with the lane, the cycles and the notes in them.
    range: (selection, point) => askAboutTimelineRange(selection, point),
    // What the panel says of a range: the lane, the sections of its ends and how many notes start in it.
    describeRange: (selection) => describeTimelineRange(selection),
    // The keyboard cursor on a lane with no note on the page: the lane's own context at the cursor's cycle.
    askLane: (laneIndex, cycle, point) => askAboutTimelineLane(laneIndex, cycle, point),
  },
});
// A drag on the lanes ends with no write when the window loses focus.
window.addEventListener('blur', () => timelineEditUi.cancelGesture());
const jamViewEl = document.getElementById('jam-view');
const instrumentsViewEl = document.getElementById('instruments-view');
const editorArea = document.getElementById('editor-area');
const viewButtonsEl = document.getElementById('view-buttons');
const layoutButtonsEl = document.getElementById('layout-buttons');
const layoutWordEl = document.querySelector('#top-bar .layout-word');
if (!viewButtonsEl || !layoutButtonsEl || !layoutWordEl) throw new Error('Moontide: the view and layout buttons are missing from the page.');
const motionSwitch = document.getElementById('motion-switch');

// The failed-change banner (it holds #eval-error). Created here, before any code path that can write to it.
const problemUi = createProblemView({
  document,
  // The platform call; a refusal reaches the view as a rejection (or a throw) and is shown, never swallowed.
  writeText: (text) => navigator.clipboard.writeText(text),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (timer) => clearTimeout(timer),
  // Focus inside the banner when it hides goes to the Play/Stop button, which is always in the bar.
  onReleaseFocus: () => transportButton.focus(),
  // Ask Claude with the error attached. The context carries the first line of the full message
  // (describeContext cuts it) and the Ask field is prefilled with the error cut at 1500 characters. A descriptor
  // describeContext refuses is a bug: it goes the same way as an unreadable right-click, on the whole session.
  onAsk: ({ x, y, text }) => {
    try {
      describeContext({ kind: 'error', text });
    } catch (err) {
      console.error('Moontide: could not describe the failed change, using the whole session:', err);
      showAskContextProblem(err);
      askUi.open({ kind: 'session' }, { x, y });
      return;
    }
    askUi.open({ kind: 'error', text }, { x, y }, { prefill: errorAskPrefill(text) });
  },
});

// The History view. Created here, before any code path that can call into it.
const historyUi = createHistoryView({
  document,
  send: (message) => sendIfOpen(JSON.stringify(message)),
  reportError: showHistoryProblem,
  getParse: () => (window.acorn && typeof window.acorn.parse === 'function' ? window.acorn.parse : null),
  onModeChange: (mode) => applyViewState(setHistoryMode(viewState, mode), ['historyMode']),
});

// The Jam view's DOM. Created here, before any code path that can call into it.
const jamUi = createJamView({
  document,
  onInstrumentChange: (name) => applyViewState(setJamInstrument(viewState, name), ['jamInstrument']),
  onChordTonesChange: (checked) => {
    applyViewState(setJamChordTones(viewState, checked ? 'on' : 'off'), ['jamChordTones']);
    // Draw the overlay at once; the 250 ms tick would make the checkbox feel slow.
    renderJam();
  },
});

// The Instruments view's DOM. Created here, before any code path that can call into it (its redraw
// hooks stay shut while instrumentsOpen is false, which it is until renderViews() has run). The view
// never sends; a press on a card's switch comes back here, and requestInstrumentSwitch owns the send.
const instrumentsUi = createInstrumentsView({
  document,
  onInstrumentSwitch: (instrument, enabled) => requestInstrumentSwitch(instrument, enabled),
  onInstrumentSettings: (instrument, settings) => requestInstrumentSettings(instrument, settings),
});

// The instrument-switch requests that wait for the server's instrument-result, by request id
// (`instrument-<n>`). Each holds its instrument, its kind and the 5 s timer (TAKE_BACK_CONFIRM_MS, the take-back
// figure); a timer that fires, a closed socket or an answer settles the request exactly once.
const instrumentRequests = new Map();
let instrumentRequestSeq = 0;

/** Ends the pending look of one instrument as "the server did not confirm"; the card then shows its confirmed state. */
function settleUnconfirmed(instrument, kind = 'switch') {
  try {
    instrumentsUi.settle(instrument, { ok: false, kind: 'unconfirmed' }, kind);
  } catch (err) {
    console.error('Moontide: the Instruments view could not end a waiting request:', err);
  }
}

/** Asks the server to set one instrument on or off (a set, never a toggle). Only the playing tab is answered; the card shows the server's state, never a guess. */
function requestInstrumentSwitch(instrument, enabled) {
  if (ws.readyState !== ws.OPEN) {
    console.error('Moontide: could not switch an instrument: the socket is not open.');
    settleUnconfirmed(instrument);
    return;
  }
  instrumentRequestSeq += 1;
  const id = `instrument-${instrumentRequestSeq}`;
  sendIfOpen(JSON.stringify({ type: 'instrument-switch', id, instrument, enabled }));
  const timer = setTimeout(() => {
    instrumentRequests.delete(id);
    settleUnconfirmed(instrument);
  }, TAKE_BACK_CONFIRM_MS);
  instrumentRequests.set(id, { instrument, kind: 'switch', timer });
}

/**
 * Asks the server to set the port, channels and clock of one instrument to what the user chose (the full set,
 * not a difference). The page never validates it: the server's answer carries the reasons the card shows.
 */
function requestInstrumentSettings(instrument, settings) {
  if (ws.readyState !== ws.OPEN) {
    console.error('Moontide: could not save instrument settings: the socket is not open.');
    settleUnconfirmed(instrument, 'settings');
    return;
  }
  instrumentRequestSeq += 1;
  const id = `instrument-${instrumentRequestSeq}`;
  sendIfOpen(JSON.stringify({ type: 'instrument-settings', id, instrument, settings }));
  const timer = setTimeout(() => {
    instrumentRequests.delete(id);
    settleUnconfirmed(instrument, 'settings');
  }, TAKE_BACK_CONFIRM_MS);
  instrumentRequests.set(id, { instrument, kind: 'settings', timer });
}

/** The server's answer to a request of this page. A request that is no longer waiting is ignored. */
function onInstrumentResult(msg) {
  let result;
  try {
    result = readInstrumentResult(msg);
  } catch (err) {
    console.error(err);
    return;
  }
  if (!result.ok && result.missing !== null) console.error(`Moontide: the instrument-result field ${result.missing} is missing.`);
  const request = instrumentRequests.get(result.id);
  // No request: it timed out or the socket closed, and the rig push that came before this answer already updated the card.
  if (request === undefined) return;
  clearTimeout(request.timer);
  instrumentRequests.delete(result.id);
  instrumentsUi.settle(request.instrument, result, request.kind);
}

/** The socket closed or failed: every waiting request ends as "did not confirm". There is no auto-reconnect, so no answer can follow. */
function settleInstrumentRequests() {
  const waiting = [...instrumentRequests.values()];
  instrumentRequests.clear();
  for (const request of waiting) {
    clearTimeout(request.timer);
    settleUnconfirmed(request.instrument, request.kind);
  }
}

// The token the server embedded in the page it served. Read once, sent only to the Moontide
// server in the page-auth message, never logged, shown or put in a title or a URL.
const pageTokenMeta = document.querySelector('meta[name="moontide-page-token"]');
let pageToken = pageTokenMeta ? pageTokenMeta.getAttribute('content') : null;
if (!pageToken || pageToken === PAGE_TOKEN_PLACEHOLDER) {
  console.error(
    'Moontide: this page was not served by the Moontide server, so it has no page token; asking Claude will be refused.',
  );
  pageToken = '';
}

// The label of this page's server (folder and port), written into the page it served. Read once; the
// folder and the port do not change while one server lives, so nothing updates it later.
const sessionLabel = readSessionLabel(document, (text) => console.error(text));
const pageBaseTitle = baseTitle(sessionLabel);
renderSessionIdentity(document, sessionLabel, (text) => console.error(text));

// The Ask Claude box. Created before any code path that can call into it.
const askUi = createAskView({
  document,
  send: (message) => {
    sendIfOpen(JSON.stringify(message));
    // A sent request about a range of the Timeline is done with it: the wash goes.
    if (message.type === 'ask' && message.context.kind === 'range') timelineEditUi.clearRange();
  },
  reportError: showAskProblem,
  clearError: clearAskProblem,
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (timer) => clearTimeout(timer),
  now: () => Date.now(),
  // The status text changes the bar's width: the fit step runs again.
  fit: () => topBarUi.fit(),
});

// The segment a superseded tab shows, with its "Play in this tab" button. takeBackTimer is the
// 5 s wait for the server's hello after a click; it is null while no take-over is pending.
let takeBackTimer = null;

function clearTakeBackTimer() {
  if (takeBackTimer === null) return;
  clearTimeout(takeBackTimer);
  takeBackTimer = null;
}

/** Both Play in this tab buttons (the Session card's and the strip's) read "Taking over…" together. */
function setTakeBackPending(pending) {
  midiUi.setTakeBackPending(pending);
  sessionUi.setTakeBackPending(pending);
}

function onTakeBack() {
  if (takeBackTimer !== null) return;
  if (ws.readyState !== ws.OPEN) {
    console.error('Moontide: could not take the role back: the socket is not open.');
    showMixerProblem(MIDI_COPY.takeBackFailed);
    return;
  }
  // Resume the AudioContext synchronously inside the click, like Stop and the overlay: the browser lets
  // audio resume in a gesture, and the hello replay that follows could not.
  if (typeof globalThis.getAudioContext === 'function') {
    globalThis.getAudioContext().resume().catch((err) => console.error('Moontide: AudioContext.resume() failed:', err));
  }
  ws.send(JSON.stringify({ type: 'take-over' }));
  setTakeBackPending(true);
  takeBackTimer = setTimeout(() => {
    takeBackTimer = null;
    setTakeBackPending(false);
    showMixerProblem(MIDI_COPY.takeBackFailed);
  }, TAKE_BACK_CONFIRM_MS);
}

// The Session button, its drawer and the strip. The strip's button gets the very function the card's button
// gets, so the two cannot differ. Opening the drawer closes an open (i) popover; the popovers are looked up at call time.
const sessionUi = createSessionView({
  document,
  onTakeBack,
  onOpen() {
    midiUi.closeHelp();
    askUi.closeHelp();
  },
  setTimer: (fn, ms) => setTimeout(fn, ms),
  // One of the three Edits timing buttons. The setting is stored by applyViewState (through the closed-set
  // setChangeTiming) and the existing spoken line goes to the status line; the view only shows the pressed state.
  onTimingPick(value) {
    applyViewState(setChangeTiming(viewState, value), ['changeTiming']);
    topBarUi.say(settingLine(viewState.changeTiming));
  },
});

const midiUi = createMidiView({
  document,
  onTakeBack,
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (timer) => clearTimeout(timer),
  // Read at call time: viewState is declared further down and only exists by the time a banner can open.
  isMotionOn: () => viewState.motion === 'on',
});

// The served title already holds the base title; this keeps the page and the server on one string.
midiUi.setTitle(pageBaseTitle);

// The hidden-tab warning. `midiHiddenState` is the start of the current hidden-with-MIDI period
// (page/midi-plan.js hiddenTransition). Moontide only warns: nothing here pauses or stops the music while
// the tab is hidden (Moontide keeps playing while hidden, with no automatic pause).
let midiHiddenState = { since: null };

/**
 * Re-reads the hidden-with-MIDI condition (the page is hidden, the code that plays uses `.midi(`, sound is
 * not stopped and this tab holds the role) and brings everything that follows it up to date: the tab title,
 * the return banner and the facts the server turns into Claude's two notices. Safe to call at any time; the
 * facts are sent only when they changed.
 */
function refreshMidiHidden() {
  const hidden = document.visibilityState === 'hidden';
  const usesMidiNow = midiOut.facts().usesMidi;
  const playing = !pageStopped;
  const hiddenWithMidi = hidden && usesMidiNow && playing && !pageSuperseded;
  midiUi.setTitle(midiTitle({ hidden, usesMidi: usesMidiNow, playing, superseded: pageSuperseded, baseTitle: pageBaseTitle }));
  const step = hiddenTransition(midiHiddenState, { hiddenWithMidi, hidden, now: Date.now() });
  midiHiddenState = step.state;
  if (step.banner !== null) {
    midiUi.showReturnBanner(returnBannerText(hhmm(new Date(step.banner.from)), hhmm(new Date(step.banner.to))));
  }
  midiOut.publishFacts();
}

document.addEventListener('visibilitychange', () => refreshMidiHidden());

/**
 * Draws the top-bar MIDI indicator from the MIDI facts. midiPublishReady is true exactly while the
 * socket is open and authenticated (set on 'open', cleared on 'close' and 'error'), and it is read here
 * instead of `ws` because the first facts can be published before `ws` exists.
 */
function renderMidiIndicator(facts = midiOut.facts()) {
  const model = indicatorModel({ facts, connected: midiPublishReady, superseded: pageSuperseded, rig: midiOut.rigView() });
  sessionMidiAttention = model.visible && model.attention;
  midiUi.render(model);
  renderSession();
  // The Instruments view follows every event that redraws the indicator: a port plugged or unplugged (facts
  // publish), a new rig, the tab role, the clock.
  renderInstrumentsIfOpen(facts);
}

/** Where the page stands with the server, as the Instruments view words it: refused, disconnected, connected (hello seen) or connecting. */
function instrumentsConnection() {
  if (pageRefused) return 'refused';
  if (pageSocket === 'closed') return 'disconnected';
  if (pageHelloSeen) return 'connected';
  return 'connecting';
}

/**
 * Draws the Instruments view from one read of each source: the rig the page keeps, the live
 * ports of midi-out and the code that plays now. It only reads what midi-out already knows and never enables
 * Web MIDI, so opening the view never raises the browser's permission prompt.
 */
function renderInstruments(facts = midiOut.facts()) {
  let parse = null;
  if (window.acorn && typeof window.acorn.parse === 'function') {
    parse = window.acorn.parse;
    instrumentsParserMissingLogged = false;
  } else if (!instrumentsParserMissingLogged) {
    // Once per cause: the view redraws on every facts publish, clock change and hello.
    instrumentsParserMissingLogged = true;
    console.error('Moontide: window.acorn is not available — the Instruments view cannot read the code.');
  }
  instrumentsUi.render(
    instrumentsModel({
      connection: instrumentsConnection(),
      superseded: pageSuperseded,
      noActive: pageNoActive,
      rig: pageRig,
      live: midiOut.rigView(),
      access: facts.access,
      supported: supportsMidi(),
      // The ports the settings editor offers, read without enabling Web MIDI.
      outputs: midiOut.outputNames(),
      code: hasEvaluatedSuccessfully ? playingCode() : '',
      parse,
      dataFolder: pageDataFolder,
    }),
  );
}

/**
 * Draws the Instruments view when it is open; a no-op before renderViews() has run and while another view is open.
 * instrumentsModel() throws loudly on inconsistent input by design, and this runs inside the socket handlers
 * (open, hello, close, error) and the MIDI hooks: a read-only view must never break authentication, the replay or
 * the cleanup, so a failed draw is logged here and the caller carries on.
 */
function renderInstrumentsIfOpen(facts) {
  if (!instrumentsOpen) return;
  try {
    renderInstruments(facts);
  } catch (err) {
    console.error('Moontide: the Instruments view could not be drawn:', err);
  }
}

productName.textContent = COPY.name;
overlayCta.textContent = COPY.cta;
overlayError.textContent = COPY.audioBlocked;
layoutWordEl.textContent = BAR_COPY.layoutWord;

/** Fills the top-bar Views and Layout groups: one native button per built view (a digit and a name) and per layout
 * (a letter), all with data-key. Text comes only from fixed constants in page/views.js and goes in through
 * createElement and textContent, never innerHTML. At a narrow fit step the CSS hides the name of an unselected view;
 * the accessible name (aria-label) always holds digit and name. */
function buildViewButtons() {
  const viewButtons = viewButtonParts().map((part) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.key = part.key;
    const digit = document.createElement('span');
    digit.className = 'view-digit';
    digit.textContent = part.digit;
    const name = document.createElement('span');
    name.className = 'view-name';
    name.textContent = part.name;
    button.append(digit, name);
    button.setAttribute('aria-label', part.label);
    button.title = part.title;
    return button;
  });
  viewButtonsEl.replaceChildren(...viewButtons);
  const layoutButtons = layoutButtonParts().map((part) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.key = part.key;
    button.textContent = part.text;
    button.setAttribute('aria-label', part.label);
    button.title = part.label;
    return button;
  });
  layoutButtonsEl.replaceChildren(...layoutButtons);
}
buildViewButtons();

// The names the top-bar view buttons show now: the Parts view is called Song while the code declares a song.
const viewTitles = { ...VIEW_TITLES };

/** Calls a view by `name` on its top-bar button (the visible name, the accessible name and the tooltip) and lets the bar
 * fit again, since the name may have another width. The key and the view itself do not change. */
function setViewTitle(view, name) {
  if (viewTitles[view] === name) return;
  viewTitles[view] = name;
  const part = viewButtonParts(BUILT_VIEWS, viewTitles).find((candidate) => VIEW_KEYS[candidate.key] === view);
  const button = viewButtonsEl.querySelector(`button[data-key="${part.key}"]`);
  if (button === null) throw new Error(`Moontide: the top-bar button for the '${view}' view is missing.`);
  button.querySelector('.view-name').textContent = part.name;
  button.setAttribute('aria-label', part.label);
  button.title = part.title;
  topBarUi.fit();
}

// True once stopSoundLocally() has run and no successful evaluate has
// restarted playback since. stopCount lets handleEvaluate detect a Stop that
// landed while a set_code was still in flight. Declared here, ahead of refreshSoundState's
// first call below, so that call never reads pageStopped before it's initialized.
let pageStopped = false;
let stopCount = 0;

// Tracks whether any evaluation has completed successfully in this page, so a failed
// evaluation knows whether to revert to the last-playing code or to '' (before any
// success, editor.repl.state.activeCode is still Strudel's '// LOADING' placeholder,
// which must never be shown to the user as "the code that is playing"). Declared here, ahead of
// refreshSoundState's first call below, because renderTransport reads hasEvaluatedSuccessfully.
let wasPending = false;
let hasEvaluatedSuccessfully = false;

// The part launch currently waiting for its target cycle, or null — set by launchPart,
// cleared by onVersionPlaying (a new version starting, including this launch's own evaluate) and
// by stopSoundLocally (a stop cancels any pending launch's countdown).
let pendingLaunch = null;

// The live card refs from the last renderParts() build — one per section, across
// every arrangement row — so the animation loop can update each card's text/data-state/progress
// in place every frame without rebuilding the DOM (a card is only touched when a shown text
// or width changes). Rebuilt on every renderParts() call (a new version, or a fresh view open).
let partsCardRefs = [];

// The reading the Song grid on screen was drawn from, or null while no grid is drawn: the live tick needs its shift and
// lengths to tell which section plays.
let songGridReading = null;
// Whether the last live update found sound playing, so the grid scrolls the playing section into view once at Play.
let songGridWasPlaying = false;
// The section launch that waits for its line, `{ record, index, name, line, at }`: `record` is the takeover's waiting change,
// `line` the cycle it takes over on. Null when none waits. Cleared when the record takes over or is dropped.
let gridLaunch = null;
// The change of a cell that waits for its line, `{ record, track, section, choice, at }`: `section` is the section's name (every
// column of that name shows it), `choice` is `{ key }` or `{ rest: true }`, `at` the timing it waits on. Null when none waits.
// Cleared when the record takes over or is dropped.
let gridCellWait = null;
// What the queued section header shows on this poll, `{ index, countdownText, line }`, or null. Computed once per poll of the
// top bar from the same record and the same cycle as the bar's countdown, so the header and the bar always agree.
let gridQueued = null;
// True while a launch is being written and evaluated: nothing else reads the editor as "unevaluated typing" meanwhile.
let gridBusy = false;
// Why the last gesture on the Song grid was refused, as an id, or null (nothing was changed).
let gridRefused = null;
// A launch that needs no code change, `{ index, name, line }`: the section already starts on the line the person chose, so
// nothing is written or waits in the takeover; the header counts down to the line until the scheduler reaches it.
let gridAlready = null;
// The sentence under the toolbar for this poll (the result of songLine), and whether the editor held text that was not
// evaluated at the last poll that could tell.
let gridLine = null;
let gridDirty = false;

// The song structure read from the code of the version that plays, `{ generation, code, reading }`, or null: read once
// per version in onVersionPlaying (the Parts view uses it, the 250 ms tick never parses). structureNoteSent is true
// while the last structure note sent to the server held lines, so a note that clears them is sent too.
let songReading = null;
let structureNoteSent = false;
// The line the declared-against-played check gave for the version that plays, `{ generation, entry }` (entry is a line for
// #song-notes, or null when what plays agrees with the declaration), or null while the check has not answered.
let songCheck = null;
// Whether the notes of each fixed variation fit the harmony of the sections it plays in, for the version that plays:
// `{ generation, reading, answer }` with the answer of collectFit (variation to masks or reason) once the query has
// answered. It is null while the query is pending, and for a version with no fixed variation: the grid then shows no fit
// words at all.
let songFit = null;

// The history id of the code this page has loaded, and whether a version has ever
// played in this page session — both feed versionIndicator(). Declared here, ahead of
// refreshSoundState's first call below, for the same reason as pageStopped above.
let currentVersionId = null;
// Where the loaded version came from when it is a restore, else null. It rides the same
// server message as currentVersionId, so the top bar never shows a wrong "from".
let currentRestoredFrom = null;
let hasPlayedThisPage = false;
// True while the top-bar error line shows an Ask Claude problem, so sending the next request clears
// that line but never an evaluation error or a mixer problem written after it.
let errorLineIsAsk = false;
// True while the error line shows the unreadable-context line, so the next readable right-click clears only that line.
let errorLineIsAskContext = false;

// True only around a Moontide-initiated evaluation (see runProgrammaticEvaluate
// below), never around Ctrl+Enter/Alt+Enter — the only distinguishing signal, since the
// library calls the identical editor.evaluate() method for both.
let programmaticEvalInFlight = false;

// The id of the Moontide evaluate request whose code is playing now; null while a
// hand evaluation or the reload replay is what's playing instead. Mirrors src/session.ts's
// own playingEvaluateId (server side); set in handleEvaluate (before the evaluate itself, so
// an eager error raised while constructing the new pattern is tagged correctly — reverted on
// failure), in the hello replay, and in trackHandEval below. Never assigned inside the
// strudel.log listener itself — that listener only reads the current value.
let playingEvaluateId = null;
// The tag to give back when a Claude evaluation fails or only waits, and the one a takeover finisher sets while such an
// evaluation runs (page/evaluate-tag.js): a change that takes over inside another evaluation must not overwrite its tag.
const evaluateTag = createEvaluateTag({
  read: () => playingEvaluateId,
  write: (id) => {
    playingEvaluateId = id;
  },
});

// The gesture recorder, created below once `chain` exists. Declared here so
// trackHandEval (registered earlier) never reads it before it is initialized.
let mixerGesture = null;
// The bypass records the page keeps for effects that are off (page/mixer-model.js); loaded once from storage.
let mixerBypassRecords = [];
// The last written values of every bus the mixer has seen, so a bus keeps its settings after its last
// sender was dragged back to 0 (page/mixer-model.js busEntries); session only, never stored.
let mixerBusMemory = new Map();
// True while one Mixer move is being evaluated (inside the serial chain).
let mixerTickInFlight = false;
// The touched-line overlay (flashMixerLines): its elements, its timers and a generation counter
// that drops a measure callback made stale by a newer flash or by clearMixerFlash.
let mixerFlashEls = [];
let mixerFlashFadeTimer = null;
let mixerFlashEndTimer = null;
let mixerFlashGeneration = 0;
// The selected-strip light (syncMixerLit): ONE element, moved and never recreated while it is lit, a generation
// counter that drops a measure callback made stale by a clear, whether the next write scrolls the editor to the block
// (only a strip selection asks for it), and the last range with the text and identity it was computed from.
// Disjoint from the flash's state: the flash is drawn above the light and never removes it.
let mixerLitEl = null;
let mixerLitGeneration = 0;
let mixerLitReveal = false;
let mixerLitMemo = { code: null, identity: null, range: null };

/**
 * The single place in this file that calls the flashing editor.evaluate(). Every Moontide-initiated
 * evaluation — the 'evaluate' message handler and the hello auto-replay — routes through this, so trackHandEval below never mistakes a reload replay
 * or a pushed change for a hand evaluation. (runMixerEvaluate below is the single place that
 * calls the repl directly.)
 */
async function runProgrammaticEvaluate(timing = NOW_TIMING) {
  const run = armRun(timing);
  programmaticEvalInFlight = true;
  try {
    const evaluation = editor.evaluate();
    // The pinned StrudelMirror's evaluate calls repl.evaluate synchronously, so the wrapper has taken the run
    // by now. If it did not, the armed timing would leak into the next evaluation: say so, and clear it.
    if (armedRun === run) {
      armedRun = null;
      console.error('Moontide: editor.evaluate() did not reach repl.evaluate synchronously; the change timing was dropped.');
    }
    await evaluation;
  } finally {
    programmaticEvalInFlight = false;
  }
  return run;
}

/**
 * The evaluation behind one Mixer move. The single place in this file that calls
 * editor.repl.evaluate() directly: editor.evaluate() flashes the whole editor on every call, which
 * at ten evaluations per second is a strobe. The programmatic flag
 * keeps trackHandEval from reporting each tick as a hand evaluation, which would record one
 * 'hand' version per tick.
 */
async function runMixerEvaluate(code, autostart, timing = NOW_TIMING) {
  programmaticEvalInFlight = true;
  const run = armRun(timing);
  try {
    await editor.repl.evaluate(code, autostart);
  } finally {
    programmaticEvalInFlight = false;
  }
  return run;
}

/**
 * The one place that writes the error line: the failed-change banner under the bar. `kind` is 'change'
 * when the message reports a failed evaluation of code (the music was not replaced) and 'notice' for every other
 * problem. The sentence about the music is decided here, at the moment of the failure, from the page's own values.
 */
function showProblem(kind, message) {
  problemUi.show(
    bannerCopy({
      kind,
      message,
      plays: currentTransport().playing,
      pageStopped,
      hasEvaluatedSuccessfully,
    }),
  );
  errorLineIsAsk = false;
  errorLineIsAskContext = false;
}

/** Shows a failed evaluation (kind change) with its full message, and the line's first line in the banner. */
function showEvalError(message) {
  showProblem('change', message);
  // The single choke point — a restore waiting for the server will not answer any more.
  historyUi.onEvalError();
}

/**
 * Shows a problem that is not a failed evaluation but still ends a History restore that waited for the server (a
 * Mixer gesture that was not saved, a restore that did not complete): kind notice, with the same History hook
 * showEvalError has.
 */
function showHistoryProblem(message) {
  showProblem('notice', message);
  historyUi.onEvalError();
}

/**
 * Shows a mixer problem (a refused change, a move that failed to apply) as a notice.
 * Unlike showEvalError it does not touch a restore waiting for the server: nothing was evaluated.
 * The next successful evaluation clears it, like any error line.
 */
function showMixerProblem(message) {
  showProblem('notice', message);
}

/**
 * Shows an Ask Claude problem (a refused request, a request the server did not confirm) as a notice.
 * Like showMixerProblem it does not touch a restore waiting for the server.
 */
function showAskProblem(message) {
  showProblem('notice', message);
  errorLineIsAsk = true;
}

/**
 * A right-click whose context could not be read: the box opens on the whole session,
 * and the error line says so. The line shows the copy; its title adds the thrown message on a second line.
 */
function showAskContextProblem(error) {
  const detail = error instanceof Error ? error.message : String(error);
  showAskProblem(`${ASK_COPY.contextUnreadable}\n${detail}`);
  errorLineIsAskContext = true;
}

/** Sending a request clears the error line only when the last thing written to it was an Ask Claude problem. */
function clearAskProblem() {
  if (errorLineIsAsk) clearEvalError();
}

/** Clears the top-bar error line (on the next successful evaluation). */
function clearEvalError() {
  errorLineIsAsk = false;
  errorLineIsAskContext = false;
  problemUi.hide();
}

function renderConnectionState(state) {
  // Plain text in the Session card: the accent stays for what is live in the music.
  connectionStateEl.textContent = CONNECTION_LABELS[state];
  sessionConnection = state;
  renderSession();
}

/**
 * Brings the Session button, its count and the session strip up to date from the facts the page keeps. The
 * view writes only what changed, so this is cheap to call after every event that can change one of them. MIDI
 * attention counts only while the indicator would show (socket open, this tab holds the role).
 */
function renderSession() {
  const midiAttention = sessionMidiAttention && midiPublishReady && !pageSuperseded;
  sessionUi.setIssues(
    sessionIssues({
      connection: sessionConnection,
      buildMismatch: pageBuildMismatch,
      serverUpdated: pageServerUpdated,
      superseded: pageSuperseded,
      midiAttention,
    }),
  );
  sessionUi.setStrip(stripModel({ buildMismatch: pageBuildMismatch, serverUpdated: pageServerUpdated, superseded: pageSuperseded, noActive: pageNoActive }));
  // The count pill changes the Session button's width: the fit step runs again.
  topBarUi.fit();
}

/**
 * The persistent line for a build mismatch. textContent and title only, fixed copy. Nothing
 * else ever hides it, and clearEvalError and showEvalError never touch it.
 */
function renderBuildMismatch() {
  buildMismatchEl.textContent = BUILD_MISMATCH_COPY.line;
  buildMismatchEl.title = BUILD_MISMATCH_COPY.title;
  buildMismatchEl.hidden = false;
  renderSession();
}

/**
 * The softer persistent line for a server whose own code was updated since it started, in the same
 * place as the mismatch line. It never replaces a known build mismatch, which says more and refuses .midi(.
 */
function renderServerUpdated() {
  pageServerUpdated = true;
  if (!pageBuildMismatch) {
    buildMismatchEl.textContent = SERVER_UPDATED_COPY.line;
    buildMismatchEl.title = SERVER_UPDATED_COPY.title;
    buildMismatchEl.hidden = false;
  }
  renderSession();
}

/** Keeps a rig: while a build mismatch is known it passes through withBuildMismatch, so .midi( code stays refused. */
function applyRig(rig) {
  // The drum tracks before the new rig, to know after it whether the Jam reading has to change.
  const jamOpen = viewState.view === 'jam';
  const drumsBefore = jamOpen && timelineTracks !== null ? drumTrackIndexes(timelineTracks, laneTags().drums) : null;
  pageRig = withBuildMismatch(rig, pageBuildMismatch);
  midiOut.setRig(pageRig);
  renderMidiIndicator();
  // The Mixer reads its MIDI tracks against the rig: draw it again when the file changes while it is open.
  if (viewState.view === 'mixer') renderMixer();
  // The Timeline lanes carry the instrument tag: draw the page again from its cached result (no new query).
  redrawTimelineForRig();
  // The Jam reading leaves out the rig's drum tracks: a rig that changes which tracks are drums changes what is
  // counted, and the reading is otherwise built once per version. A rig message that leaves the drum tracks as they
  // were (a reconnect, a build-mismatch message) keeps the reading. Opening Jam always rebuilds; one pass runs at a time.
  if (jamOpen && (drumsBefore === null || !sameIndexSet(drumsBefore, drumTrackIndexes(timelineTracks, laneTags().drums)))) {
    jamReading = null;
    jamStuck = null;
    jamUi.showMessage(JAM_COPY.reading);
    void refreshJam().catch(reportJamRefreshError);
  }
}

// Tracks the current sound-state slot ('off' | 'silent' | 'playing').
let currentSoundState = 'off';

// The lights of the Mixer (page/lights.js holds their state, the Mixer view draws them). They are declared here, before
// refreshSoundState first runs, because that function ends in syncLights. `lightsActive` is true while the loop runs: the Mixer
// is open, the tab is visible and sound is playing. `lightsViewReady` stays false until the view state and the Mixer exist,
// so nothing below touches them too early. `lightsMotion` is the motion the running lights were started with.
const lights = createLights();
let lightsActive = false;
let lightsRafId = null;
let lightsMotion = 'on';
let lightsViewReady = false;
let lightsBroken = false;
// True while the tempo is not above 0: the loop runs and draws nothing. The warning about a missing output timestamp is said once.
let lightsPaused = false;
let lightsPairWarned = false;

/** Applies versionIndicator()'s result — textContent and the hidden property only, never a data-accent (the indicator is never accented). */
function renderVersionIndicator() {
  const { hidden, text } = versionIndicator({
    versionId: currentVersionId,
    soundState: currentSoundState,
    hasPlayed: hasPlayedThisPage,
    restoredFrom: currentRestoredFrom,
  });
  versionIndicatorEl.textContent = text;
  versionIndicatorEl.hidden = hidden;
}

// What the transport button and the state word show now, as the model's JSON, so the DOM is written only when the
// result changed. One writer for both: the sound-state event, the superseded and hello handlers, trackEvalSuccess and
// the 250 ms poll all end here (a second writer of "playing" would let the button and the word disagree).
let shownTransport = null;

/** The transport model for the page as it is now. The editor's text is trimmed: a blank editor has nothing to play. */
function currentTransport() {
  return transport({
    soundState: currentSoundState,
    superseded: pageSuperseded,
    hasEvaluatedSuccessfully,
    editorHasCode: editor.code.trim() !== '',
  });
}

function renderTransport() {
  const model = currentTransport();
  const key = JSON.stringify(model);
  if (key === shownTransport) return;
  shownTransport = key;
  transportWord.textContent = model.label;
  transportButton.dataset.action = model.action;
  transportButton.title = model.title;
  // aria-disabled, never the disabled attribute: the reason stays reachable by title and by a press.
  if (model.disabledReason === null) transportButton.removeAttribute('aria-disabled');
  else transportButton.setAttribute('aria-disabled', 'true');
  soundStateLabel.textContent = model.word;
  stateHereEl.textContent = model.here ? BAR_COPY.stateHere : '';
  // The fit step may hide ' here' from sight; the accessible name keeps the whole fact ('Stopped here').
  soundStateEl.setAttribute('aria-label', `${model.word}${model.here ? BAR_COPY.stateHere : ''}`);
  // The accent means live now: the model's playing, not the sound state alone (a lost tab or an unevaluated page is not live).
  soundStateEl.dataset.accent = String(model.playing);
  // The word, its ' here' part and the button's word change the bar's width: the fit step runs again.
  topBarUi.fit();
}

function renderSoundState() {
  renderTransport();
  if (currentSoundState === 'playing') {
    hasPlayedThisPage = true;
  }
  historyUi.setLive(currentSoundState === 'playing');
  renderVersionIndicator();
}

function refreshSoundState() {
  const audioRunning =
    typeof globalThis.getAudioContext === 'function' && globalThis.getAudioContext().state === 'running';
  const started = !!(editor.repl && editor.repl.state && editor.repl.state.started);
  currentSoundState = soundState({ audioRunning, started, stopped: pageStopped });
  renderSoundState();
  syncLights();
}

renderConnectionState('connecting');
refreshSoundState();
replElement.addEventListener('update', refreshSoundState);

function trackEvalSuccess(e) {
  const state = e.detail;
  if (wasPending && state.pending === false && !state.evalError) {
    hasEvaluatedSuccessfully = true;
    renderTransport();
    clearEvalError();
    const waiting = activeRun !== null ? activeRun.deferred : null;
    if (waiting !== null && takeover.pending() === waiting) {
      // The change waits for its line: what plays now is still the old code, so the MIDI facts and
      // the views follow the takeover, not this success.
      waiting.code = editor.repl.state.activeCode;
      takeover.whenFinished(waiting, () => {
        // The setup prepared at the lead is committed first, so the facts and the clock follow the code that plays.
        waiting.midiPlan?.commit();
        midiOut.recordSuccess(waiting.code);
        refreshMidiHidden();
        onVersionPlaying();
      });
    } else {
      // An immediate success is the music that plays now: nothing canceled is left to read.
      canceledPlayingCode = null;
      canceledPlayingPattern = null;
      // The MIDI facts of the code that plays now. This runs inside repl.evaluate, before
      // handleEvaluate sends `evaluated` on the same socket, so the server has them first.
      midiOut.recordSuccess(editor.repl.state.activeCode);
      refreshMidiHidden();
      onVersionPlaying();
    }
  }
  wasPending = !!state.pending;
}

replElement.addEventListener('update', trackEvalSuccess);

// Detects Strudel's own stop shortcut (Ctrl+./Alt+., and the 'repl-stop' event it fires)
// stopping the scheduler WITHOUT going through Moontide's stopSoundLocally() — the 'update'
// event still fires on that transition (state.started goes true -> false), so this is the
// only signal available. wasStarted is updated BEFORE acting so the handler never re-enters
// on the 'update' event stopSoundLocally()'s own scheduler.stop() call triggers (by then
// pageStopped is already true, since stopSoundLocally sets it before stopping the scheduler).
let wasStarted = false;

function trackShortcutStop(e) {
  const started = !!(e.detail && e.detail.started);
  const stoppedByShortcut = wasStarted && !started && !pageStopped;
  wasStarted = started;
  if (stoppedByShortcut) {
    // Every fire-and-forget chain outside `chain` still gets a .catch(), same as
    // every link on `chain` itself — otherwise a synchronous throw inside stopSoundLocally()
    // (e.g. scheduler.stop()) would leave an unhandled promise rejection and never tell the
    // server the user tried to stop.
    void stopSoundLocally()
      .then(() => sendIfOpen(JSON.stringify({ type: 'user-stopped' })))
      .catch((err) => console.error('Moontide: failed to report a shortcut stop:', err));
  }
}

replElement.addEventListener('update', trackShortcutStop);

// Tracks whether the evaluation currently in flight was started by hand
// (Ctrl+Enter/Alt+Enter) rather than by Moontide. Recorded at the pending false -> true
// transition — programmaticEvalInFlight is already set by the time this fires for a
// Moontide-driven evaluation, since runProgrammaticEvaluate() sets it before calling
// editor.evaluate(), and repl.evaluate() sets pending true synchronously at its own start
// — then read back at the matching true -> false transition. Typing alone
// never flips pending (no transition, so no report), and evaluating an empty editor
// throws before any state change (also no report).
let handEvalWasPending = false;
let currentEvalIsHand = false;
function trackHandEval(e) {
  const state = e.detail;
  if (!handEvalWasPending && state.pending === true) {
    currentEvalIsHand = !programmaticEvalInFlight;
    // A hand evaluation ends any Mixer gesture, recorded before the hand edit is reported.
    if (currentEvalIsHand && mixerGesture) mixerGesture.flushNow();
  }
  if (handEvalWasPending && state.pending === false && currentEvalIsHand) {
    // A successful hand evaluation carries no evaluate id of its own — set this
    // synchronously, before reportHandEval (and therefore before any error the resume step
    // below might raise), so the strudel.log listener never tags a later error with a
    // Moontide evaluate id that no longer describes what's playing.
    // A hand evaluation that waits for its line is reported at its takeover, never at the request (the
    // old code still plays, so its evaluate id stays too); a failed one is reported at once.
    const waiting = !state.evalError && activeRun !== null ? activeRun.deferred : null;
    if (waiting !== null && takeover.pending() === waiting) {
      takeover.whenFinished(waiting, () => {
        evaluateTag.fromTakeover(null);
        // A throw must not become an unhandled rejection.
        void reportHandEval(state, waiting.code).catch((err) => console.error('Moontide: failed to report a hand evaluation:', err));
      });
    } else {
      if (!state.evalError) {
        playingEvaluateId = null;
      }
      // Same reasoning as trackShortcutStop above — a synchronous throw before
      // reportHandEval's own await must not become an unhandled rejection.
      void reportHandEval(state).catch((err) => console.error('Moontide: failed to report a hand evaluation:', err));
    }
  }
  handEvalWasPending = !!state.pending;
}

replElement.addEventListener('update', trackHandEval);

/**
 * The one place in this file that stops the scheduler (the one shared silence path).
 * scheduler.stop() alone leaves already-triggered Web Audio nodes ringing out, so this also
 * suspends the shared AudioContext — the only thing that guarantees silence right away,
 * whatever state the current pattern is in, broken or not.
 *
 * `panicFirst` is for a tab that just lost the active role: another tab is about to play on the same
 * physical ports, so the MIDI silence goes out synchronously, before the suspend is awaited. After the
 * suspend it could land late and cut the first notes of the tab that took over. For the same reason that tab sends
 * no timed sustain release (a message queued ahead that would land after the new tab's setup and lift its hold).
 */
async function stopSoundLocally({ panicFirst = false } = {}) {
  // A change that waits for its line is canceled first: its finish must never run after Stop, and the
  // next Play starts from cycle 0 without the canceled gate.
  takeover.cancel('stop');
  // Retire the webmidi Outputs first (synchronous), so no callback frozen from the stopped
  // code can send between scheduler.stop() and the suspend, or after the next Play.
  midiOut.retireOutputs({ timedRelease: !panicFirst });
  // Every clock port that got its Start gets one Stop now, before anything awaits and before the scheduler stops.
  midiOut.stopClock();
  if (panicFirst) midiOut.panic();
  pageStopped = true;
  stopCount++;
  pendingLaunch = null;
  gridAlready = null;
  editor.repl.scheduler.stop();
  refreshSoundState();
  try {
    if (typeof globalThis.getAudioContext === 'function') {
      try {
        await globalThis.getAudioContext().suspend();
      } catch (err) {
        console.error('Moontide: AudioContext.suspend() failed:', err);
      }
    }
  } finally {
    // The MIDI silence goes out after the suspend settles (unless it already went out first); the
    // finally keeps a failing suspend from skipping it. Playing is false now, so the facts are
    // published again.
    if (!panicFirst) midiOut.panic();
    midiOut.publishFacts();
    refreshMidiHidden();
  }
}

/**
 * Brings sound back after a stop, following a successful evaluate() that
 * followed it — used by both handleEvaluate (a set_code that lands while stopped) and a
 * hand evaluation while stopped (the user's own evaluation resumes sound too).
 * If resume doesn't land in time, shows the audio-unlock overlay again so one click brings
 * the sound back; the caller's own audio value then truthfully reads 'waiting-for-click'
 * instead of a false 'ok, playing'.
 */
async function resumeAfterStop() {
  pageStopped = false;
  // A take-over click may have resumed the AudioContext already, so no statechange comes to redraw the label.
  refreshSoundState();
  midiOut.publishFacts();
  refreshMidiHidden();
  if (typeof globalThis.getAudioContext === 'function') {
    const resumePromise = globalThis.getAudioContext().resume();
    try {
      await Promise.race([resumePromise, new Promise((resolve) => setTimeout(resolve, RESUME_AFTER_STOP_TIMEOUT_MS))]);
    } catch (err) {
      console.error('Moontide: AudioContext.resume() failed:', err);
    }
    if (globalThis.getAudioContext().state !== 'running') {
      overlay.hidden = false;
    }
  }
  refreshSoundState();
}

/**
 * Reports a hand-driven evaluation (Ctrl+Enter/Alt+Enter) to the server —
 * a successful one becomes the server's current code (the server handles that); if the page
 * was stopped, the user's own evaluation brings the sound back too (same resume step a
 * set_code landing while stopped uses). A failed one shows the top-bar error line and reports
 * it, but never reverts the editor: the text is the user's own unevaluated work, same
 * situation as typed-but-not-evaluated edits — reverting would erase what they just typed.
 * The previous pattern keeps playing (Strudel's own behavior on a failed evaluate); the
 * revert-on-failure in handleEvaluate stays for code Claude sent.
 */
async function reportHandEval(state, code = editor.repl.state.activeCode) {
  if (state.evalError) {
    const { errorText, line } = buildEvalErrorReport(state.evalError);
    showEvalError(errorText);
    const payload = { type: 'hand-eval', ok: false, error: errorText };
    if (line !== undefined) {
      payload.line = line;
    }
    sendIfOpen(JSON.stringify(payload));
    return;
  }
  if (pageStopped) {
    await resumeAfterStop();
  }
  sendIfOpen(JSON.stringify({ type: 'hand-eval', ok: true, code }));
}

/**
 * Play after Stop on a piece that declares a song: the scheduler's cycle count restarts at 0 at every Play, so a shift a
 * launch (or a person) left in the code would start the music inside the structure. The shift literal of the editor text is
 * written back to 0 before Play evaluates the text, which then records one hand edit like any other; with the shift already
 * 0 nothing is written and Play records nothing new. Only the shift literal is ever replaced. Text that does not parse or
 * does not read as a song plays as written (the evaluation says what is wrong with it); anything else that throws is
 * reported on the console and Play goes on. Ctrl+Enter in the editor is an evaluation, not a Play, and does not come here.
 */
function resetSongShiftForPlay() {
  if (!window.acorn || typeof window.acorn.parse !== 'function') return;
  const text = editor.code;
  try {
    const reading = readSongOf(text);
    if (reading.state !== 'read') return;
    const edits = playResetEdit(reading);
    if (edits === null) return;
    const expected = applyEdits(text, edits);
    editor.editor.dispatch({ changes: edits });
    if (editor.code !== expected) {
      editor.setCode(text);
      console.error('Moontide: Play could not write shift 0 into the code; the code plays as written.');
    }
  } catch (err) {
    if (err instanceof SyntaxError) return;
    console.error('Moontide: Play could not reset the shift of the song; the code plays as written:', err);
  }
}

// UI Consideration loading/transport-button: Stop is a synchronous local action — the sound
// state flips to 'Stopped' the instant stopSoundLocally() sets pageStopped and calls
// refreshSoundState(), with no network round trip awaited first. Not routed through the
// serial `chain`: it must take effect immediately even if a server message is mid-flight.
// UI Consideration error/transport-button: Stop cannot fail from the page's side; it also
// reports the new state to the server (not awaited) so Claude's next get_code is truthful.
//
// One button, two verbs. The click decides again from the model (never from the attribute), so a
// synthetic click on a disabled Play does nothing but say the reason. Play is the Ctrl+Enter path: the
// audio context is resumed synchronously inside the click (the browser lets audio resume in a gesture only),
// then editor.evaluate() runs as a hand evaluation, which trackHandEval and reportHandEval hand to the server.
transportButton.addEventListener('click', (event) => {
  // A mouse click gives focus up so the History keys keep working; a keyboard activation keeps it.
  if (event.detail > 0) transportButton.blur();
  const model = currentTransport();
  if (model.disabledReason !== null) {
    topBarUi.say(model.here ? `${model.disabledReason} ${BAR_COPY.playUseTakeBack}` : model.disabledReason);
    return;
  }
  if (model.action === 'stop') {
    // A waiting change is canceled by the stop and says so itself ('Change canceled.'); 'Stopped.' would overwrite that
    // line in the same live region, so it is said only when no change was waiting.
    const changeWaiting = takeover.pending() !== null;
    // Same reasoning as trackShortcutStop above.
    void stopSoundLocally()
      .then(() => sendIfOpen(JSON.stringify({ type: 'user-stopped' })))
      .catch((err) => console.error('Moontide: failed to report the Stop button click:', err));
    if (!changeWaiting) topBarUi.say(BAR_COPY.saidStopped);
    return;
  }
  if (typeof globalThis.getAudioContext === 'function') {
    globalThis.getAudioContext().resume().catch((err) => console.error('Moontide: AudioContext.resume() failed:', err));
  }
  // Play after Stop starts a piece that declares a song from its first section.
  if (pageStopped) resetSongShiftForPlay();
  Promise.resolve(editor.evaluate())
    .then(() => {
      // A failed evaluation leaves its error on the repl state (the error line shows it) and the word stays Stopped.
      if (!editor.repl.state.evalError) topBarUi.say(BAR_COPY.saidPlaying);
    })
    .catch((err) => console.error('Moontide: the Play button could not evaluate the editor:', err));
});

// Never resume or create audio outside this click handler (no autoplay
// workarounds). The shipped superdough initAudio never resumes the context itself
// (an operator-precedence bug in it), so the page must
// resume it explicitly, synchronously inside the click gesture's call stack (Safari
// requires the resume call to happen before the first await).
overlay.addEventListener('click', async () => {
  if (typeof globalThis.getAudioContext !== 'function') {
    console.error('Moontide: globalThis.getAudioContext is not available yet.');
    overlayError.hidden = false;
    return;
  }
  const resumePromise = globalThis.getAudioContext().resume();
  try {
    await Promise.race([resumePromise, new Promise((resolve) => setTimeout(resolve, 2000))]);
  } catch (err) {
    console.error('Moontide: AudioContext.resume() failed:', err);
  }
  if (globalThis.getAudioContext().state === 'running') {
    overlay.hidden = true;
    overlayError.hidden = true;
    refreshSoundState();
  } else {
    overlayError.hidden = false;
  }
});

// Wait for prebaked before connecting the WebSocket, so a server push never lands while
// the first-load sample-map fetch is still in flight; the top bar stays 'Connecting…'
// until the socket actually opens.
const prebakeResult = await Promise.allSettled([editor.prebaked]);
if (prebakeResult[0].status === 'rejected') {
  console.error('Moontide: Strudel prebake failed:', prebakeResult[0].reason);
}

// Move the VCSL sample set to its pinned jsDelivr host (no Content-Disposition
// header, so Chrome never refuses the comma-path files raw.githubusercontent.com sends).
// registerSound overwrites by name, so this simply
// replaces prebake's own VCSL registration. It must run before the WebSocket opens, below, so
// no VCSL note can ever be requested from the old host first. No
// fallback on failure — only a loud console error.
if (typeof globalThis.samples !== 'function') {
  console.error('Moontide: the VCSL sounds could not be moved to their pinned jsDelivr host: globalThis.samples is not available.');
} else {
  try {
    await globalThis.samples(VCSL_MANIFEST_URL, VCSL_SAMPLE_BASE);
  } catch (err) {
    console.error('Moontide: could not move the VCSL samples to their pinned jsDelivr host:', err);
  }
}

// Without Web MIDI, Strudel's .midi() throws while the pattern is built and fails the whole
// piece. Strudel's globals exist after prebake; this runs before the socket so the first replay has it.
if (typeof navigator.requestMIDIAccess !== 'function') {
  try {
    installNoMidiShim(globalThis.Pattern);
  } catch (err) {
    console.error(err);
  }
} else {
  // With Web MIDI, Strudel's MIDI messages leave the page NOTE_AHEAD_MS ahead, each with a timestamp from
  // the page clock's mapping, so a busy page does not move the notes. Installed before the socket opens, so the
  // first replay has it; the two installs exclude each other.
  try {
    midiOut.installNoteStamps(globalThis.Pattern);
  } catch (err) {
    console.error(err);
  }
}

// Every note learns which labeled track played it, and the note tag tells whoever subscribes (the lights).
// Installed once, here, because the tag is added when a labeled statement is evaluated: it cannot be switched
// on later for code that already ran. Without Web MIDI no note has a port timestamp.
try {
  installNoteTag(globalThis.Pattern, {
    stampOf: typeof navigator.requestMIDIAccess === 'function' ? (hap) => midiOut.noteStampOf(hap) : () => null,
  });
} catch (err) {
  console.error(err);
}

// Every note of a labeled track goes to the lights while they are active. Otherwise it is dropped at once, so notes played
// while the Mixer is closed, the tab is hidden or the music is stopped never wait to be drawn later. A MIDI note carries the
// time its port got; a browser sound carries the audio time it is due, which the lights map to when it is heard.
subscribeNotes((event) => {
  if (!lightsActive) return;
  lights.noteSeen(event.key, event.stamp !== null ? { at: event.stamp + MIDI_LIGHT_OFFSET_MS } : { target: event.target });
});

// Start enabling Web MIDI at page start only when the browser already says the permission is
// granted (no prompt can appear then). Otherwise the first evaluation whose code has a .midi( call
// asks. Never awaited here: requestMIDIAccess can hang with some device drivers, and the WebSocket
// below must open whatever happens. The first evaluation with a .midi( call waits on the same shared
// enable (beforeEvaluate), bounded by its own ceiling, so the first beat does not depend on this line.
// enableIfGranted never rejects; the catch is a second net.
midiOut.enableIfGranted().catch((err) => console.error('Moontide: Web MIDI could not be enabled at page start:', err));

// globalThis.getAudioContext exists only after prebaked's evalScope step settles.
if (typeof globalThis.getAudioContext === 'function') {
  globalThis.getAudioContext().addEventListener('statechange', refreshSoundState);
  refreshSoundState();
}

const ws = new WebSocket('ws://' + location.host + '/ws');

// The only real hook for errors raised while a pattern plays — @strudel/core's logger() dispatches this
// document-level event for every log call, error or not, so runtimeErrorFromLog (ui-state.js)
// decides which ones are genuine runtime errors to forward. This listener only reports: it
// never stops, pauses, evaluates or edits anything. Registered right after `ws` exists
// so sendIfOpen below never runs before `ws` does.
// Built from superdough's own 'load-sample'/'loaded-sample' logs so a later, nameless
// "Failed to fetch" can be attributed to the sound that requested it.
const soundLoads = createSoundLoadTracker();

document.addEventListener('strudel.log', (event) => {
  soundLoads.observe(event.detail);
  let text = runtimeErrorFromLog(event.detail && event.detail.message);
  if (text === null) return;
  // Strudel logs "No MIDI devices found" on every hap while no output is connected. Zero outputs
  // reach Claude as one line per change (the MIDI notice), so the per-cycle line is dropped here;
  // runtimeErrorFromLog stays unchanged.
  if (isStrudelNoDevicesError(text)) return;
  // A [query] error is never forwarded from this log. A query of the page (the Timeline, the
  // Drawer, the MIDI stop sweep) says nothing about the music that plays, and Strudel drops a log text equal
  // to the last one within a second, so such a query could hide the scheduler's report. The scheduler's own
  // query errors reach sendRuntimeError directly from the scheduler query scope, once per change; cyclist
  // and getTrigger errors keep their per-occurrence forwarding here (the server counts them).
  if (isQueryErrorText(text)) return;
  if (isFetchFailure(text)) {
    // Name the sound (or list candidates / say the page could not tell) instead of
    // forwarding the bare fetch-failure text.
    text = soundLoadFailureText(text, soundLoads.pendingNames());
  }
  sendRuntimeError(text);
});

/**
 * Sends the lines the page read from the song structure of the code that plays (an empty list clears the last note),
 * tagged with the evaluate id whose code was playing (`evaluateId`, which a late caller captured when its version started).
 * The message shape is mirrored by hand from src/protocol.ts. Called from onVersionPlaying, which runs inside repl.evaluate,
 * so the server has the note before the evaluated reply; the check of the declaration sends the version's full lines later.
 */
function sendStructureNote(lines, evaluateId = playingEvaluateId) {
  const payload = { type: 'structure-note', lines };
  if (evaluateId !== null) {
    payload.evaluateId = evaluateId;
  }
  sendIfOpen(JSON.stringify(payload));
  structureNoteSent = lines.length > 0;
}

/** Sends one runtime error to the server, tagged with the evaluate id whose code was playing. */
function sendRuntimeError(text) {
  const payload = { type: 'runtime-error', message: text };
  // Tag the error with the evaluate id whose code was playing when it was raised, so
  // the server can tell an error of the previous version apart from one the new code just
  // caused; omitted for a hand evaluation or the reload replay (playingEvaluateId is null).
  if (playingEvaluateId !== null) {
    payload.evaluateId = playingEvaluateId;
  }
  sendIfOpen(JSON.stringify(payload));
}

ws.addEventListener('open', () => {
  pageSocket = 'open';
  renderInstrumentsIfOpen();
  renderConnectionState('connected');
  // The first message on every connection; without it the server refuses this page's requests.
  sendIfOpen(JSON.stringify({ type: 'page-auth', token: pageToken }));
  midiPublishReady = true;
  midiUi.setConnected('connected');
  midiOut.publishFacts({ force: true });
  historyUi.setConnected('connected');
  mixerUi.setConnected('connected');
  askUi.setConnected('connected');
  // Always ask, whether or not the view is open, so live additions accumulate.
  sendIfOpen(JSON.stringify({ type: 'history-request' }));
  // The data folder is asked once per connection, after page-auth (the server answers only a page that
  // presented its token). The Instruments view shows it when no instruments.json exists.
  sendIfOpen(JSON.stringify({ type: 'data-folder-request' }));
});

// No auto-reconnect: the user reloads the page.
ws.addEventListener('close', () => {
  pageSocket = 'closed';
  pageHelloSeen = false;
  renderInstrumentsIfOpen();
  settleInstrumentRequests();
  midiPublishReady = false;
  clearTakeBackTimer();
  setTakeBackPending(false);
  midiUi.setConnected('disconnected');
  renderConnectionState('disconnected');
  historyUi.setConnected('disconnected');
  mixerUi.setConnected('disconnected');
  askUi.setConnected('disconnected');
});
ws.addEventListener('error', () => {
  pageSocket = 'closed';
  pageHelloSeen = false;
  renderInstrumentsIfOpen();
  settleInstrumentRequests();
  midiPublishReady = false;
  clearTakeBackTimer();
  setTakeBackPending(false);
  midiUi.setConnected('disconnected');
  renderConnectionState('disconnected');
  historyUi.setConnected('disconnected');
  mixerUi.setConnected('disconnected');
  askUi.setConnected('disconnected');
});

// Evaluate requests are processed strictly one at a time through this promise chain — never
// concurrently, and the page never halts or restarts the Strudel scheduler around a push.
// Every link is chained with .catch() so one failure (a throwing evaluate(), or a send on a
// closing socket) is reported and logged instead of leaving `chain` permanently rejected,
// which would otherwise silently stop every future message from being applied.
let chain = Promise.resolve();

function reportChainError(context, err) {
  console.error(`Moontide: failed to apply ${context}:`, err);
}

// One Mixer gesture becomes few live evaluations and one record. Every job runs
// on the serial `chain`, so a move never interleaves with Claude's evaluate messages.
mixerGesture = createGestureRecorder({
  enqueue: (fn) => {
    chain = chain.then(fn).catch((err) => reportChainError('mixer change', err));
    return chain;
  },
  applyNow: applyMixerChangeNow,
  sendRecord: sendMixerRecord,
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (timer) => clearTimeout(timer),
  now: () => performance.now(),
  onError: (err) => {
    console.error('Moontide: the last mixer move could not be applied:', err);
    showMixerProblem(MIXER_COPY.moveFailed);
  },
  // A drag of a MIDI control that never wrote the code (a failed or refused release, a pause with no release, a gesture
  // flushed first): the preview must not stay on the instrument, so it goes back to what the playing code holds.
  onPreviewDropped: () => {
    // The sender forgets its last target too, so a nudge back to that value is sent again.
    midiPreview.reset();
    void midiOut.resync();
  },
  // While the pointer still holds a MIDI slider the gesture stays open: the user is listening at that value.
  isHeld: () => mixerUi.midiHeld(),
});
// The CC of a MIDI fader goes straight to the instrument while it is dragged (at most once per PREVIEW_MIN_GAP_MS),
// with no evaluation; the release writes the code.
const midiPreview = createPreviewSender({
  send: (target) => midiOut.previewControl(target),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (timer) => clearTimeout(timer),
  now: () => performance.now(),
});
const mixerUi = createMixerView({
  document,
  gesture: mixerGesture,
  midiPreview,
  onStripSelect: () => syncMixerLit({ reveal: true }),
  onGroupFold: (key) => toggleSongFold(key),
});
mixerUi.setConnected(ws.readyState === ws.OPEN ? 'connected' : 'connecting');
askUi.setConnected(ws.readyState === ws.OPEN ? 'connected' : 'connecting');

// pagehide: record a pending gesture while the socket is still open.
window.addEventListener('pagehide', () => mixerGesture.flushNow());
// A separate listener, so a throw in one never skips the other: MIDI silence on close or reload.
window.addEventListener('pagehide', () => midiOut.onPageHide());
// Its own listener too: a closing page drops its waiting change without a message (the server handles detach).
window.addEventListener('pagehide', () => takeover.cancel('unload'));
// A resize or a layout change moves the lines: the selected-strip light follows (ignored while the Mixer is closed).
window.addEventListener('resize', () => {
  if (viewState.view === 'mixer') syncMixerLit();
});

ws.addEventListener('message', (event) => {
  let msg;
  try {
    msg = JSON.parse(event.data);
  } catch (err) {
    console.error('Moontide: received malformed message from server:', err);
    return;
  }

  if (msg.type === 'superseded') {
    // Mirrors src/protocol.ts by hand: another tab became the active one. Stop here with the MIDI
    // panic (stopSoundLocally), outside the serial `chain` so it never waits behind an evaluation, and
    // never send user-stopped: the playing tab owns the server's stopped flag, and the server ignores a
    // non-active page's reports anyway.
    const alreadySuperseded = pageSuperseded;
    pageSuperseded = true;
    pageNoActive = false;
    // A tab that lost the role resets and sets up no instrument, and its pending resets are cancelled.
    midiOut.setActive(false);
    clearTakeBackTimer();
    midiUi.showSuperseded();
    sessionUi.setTakeBackPending(false);
    renderMidiIndicator();
    refreshMidiHidden();
    drawTopBar();
    // Said again when a tab plays again after none did: this tab is already stopped, only its text changes.
    // No second panic: it could cut the notes of the tab that plays now.
    if (alreadySuperseded) return;
    // A waiting change is dropped without a message: the server drops it itself when this page detaches.
    takeover.cancel('superseded');
    // The panic goes out before the suspend settles (panicFirst): the new active tab's replay can start
    // notes on the same ports at once, and a late CC123 from here would cut them.
    void stopSoundLocally({ panicFirst: true }).catch((err) => console.error('Moontide: failed to stop after another tab took over:', err));
    return;
  }

  if (msg.type === 'no-active-page') {
    // The tab that played went away and no other tab took the role: this superseded tab says so and keeps
    // its button ("Play in this tab" still works). Ignored by a tab that is not superseded.
    // Mirrors src/protocol.ts by hand.
    if (pageSuperseded) {
      pageNoActive = true;
      midiUi.showNoActivePage();
      renderSession();
      renderInstrumentsIfOpen();
    }
    return;
  }

  if (msg.type === 'build-mismatch') {
    // Mirrors src/protocol.ts by hand: the server is older than this page. Handled outside the
    // serial chain like midi-rig; the server sends it before midi-rig and hello on the same socket, so a
    // midi-rig that follows is wrapped by applyRig too.
    pageBuildMismatch = true;
    renderBuildMismatch();
    applyRig(pageRig);
    return;
  }

  if (msg.type === 'server-updated') {
    // Mirrors src/protocol.ts by hand: the server's own code was updated since it started, but the
    // page is still the one it started with. A persistent line only: the rig is not touched, so .midi( code
    // is not refused for it.
    renderServerUpdated();
    return;
  }

  if (msg.type === 'midi-rig') {
    // Mirrors src/protocol.ts by hand: the state of instruments.json and its instruments. Handled
    // outside the serial `chain` (it needs no await) and before hello, which follows it on the same socket.
    // A field the page cannot read is one console.error with its name, and the page refuses code with
    // .midi() until a readable rig arrives: a page that checks nothing must never look checked.
    let rig;
    try {
      rig = parseRigMessage(msg);
    } catch (error) {
      console.error(error);
      rig = rigFromReadFailure();
    }
    applyRig(rig);
    return;
  }

  if (msg.type === 'hello') {
    // The hello is the first moment the page can know there is no instruments.json, so the
    // Instruments view says "Connecting..." until now. Set synchronously, before anything is queued.
    pageHelloSeen = true;
    // The answer to "Play in this tab" (or a plain hello): this tab is the active page again, so
    // it may evaluate. Cleared right when the message arrives, before the replay below is queued.
    const tookRoleBack = pageSuperseded;
    if (tookRoleBack) {
      pageSuperseded = false;
      pageNoActive = false;
      clearTakeBackTimer();
      midiUi.hideSuperseded();
      sessionUi.setTakeBackPending(false);
      renderMidiIndicator();
      renderTransport();
      // No facts until the replay settles: the server cleared its MIDI state for this page, and until the
      // replay has run activeCode is still this tab's old code. The `finally` of the replay releases the
      // hold and publishes them.
      midiOut.holdFacts(true);
      // The shadows are cleared with no reset (another tab may have changed the sounds); the replay sends them again.
      midiOut.setActive(true);
      refreshMidiHidden();
    }
    renderInstrumentsIfOpen();
    chain = chain
      .then(async () => {
        // A pending Mixer gesture is recorded before the replayed code applies.
        await mixerGesture.flushDirect();
        clearMixerFlash();
        editor.setCode(msg.code);
        if (msg.stopped) {
          // Prohibition: the page must not start sound again after a stop until Claude's
          // next set_code or the user's own evaluation — a reload/reconnect stays silent.
          pageStopped = true;
          refreshSoundState();
          refreshMidiHidden();
          return;
        }
        if (msg.code !== '') {
          // The replay re-plays what the server says was playing, so an instrument the user switched off since does
          // not make that code "new" (S3), and the stored code is never cleared by reconnect-eval-failed. A hand
          // evaluation of the same code is still checked against what really plays.
          midiOut.setReplayBase(msg.code);
          try {
            await runProgrammaticEvaluate();
            const evalError = editor.repl.state.evalError;
            if (evalError) {
              // A reconnect whose stored code fails to evaluate must not leave
              // broken code showing as if it were playing — revert exactly like handleEvaluate
              // does (this is the page's first evaluation attempt since (re)load, so
              // hasEvaluatedSuccessfully is still false and the revert target is always '').
              // Report it so the server (and Claude) learn playback is actually silent.
              const { errorText, line } = revertAndReport(evalError);
              const payload = { type: 'reconnect-eval-failed', error: errorText };
              if (line !== undefined) {
                payload.line = line;
              }
              sendIfOpen(JSON.stringify(payload));
              // Nothing from history is loaded any more after a reverted replay.
              currentVersionId = null;
              currentRestoredFrom = null;
              historyUi.setCurrent(null);
              askUi.setCurrentVersion(null);
              renderVersionIndicator();
            } else {
              // A successful replay carries no evaluate id of its own.
              playingEvaluateId = null;
              // Only a take-over brings a hello to a page that stopped itself (superseded): the replay
              // just restarted its scheduler, so bring the sound and the state back. A server-side stop
              // still arrives as msg.stopped above and stays silent.
              if (pageStopped) {
                await resumeAfterStop();
              }
            }
          } finally {
            midiOut.setReplayBase(null);
          }
        }
      })
      .finally(() => {
        // The server cleared its MIDI facts when it switched pages, and facts sent while this tab was
        // superseded were dropped as "non-active page" although publish() reported them as sent. Send
        // them again now that this tab is the active one, so a denied or missing port is not hidden
        // from Claude until something else changes. Sent after the replay has settled (stopped, empty,
        // played or reverted): before it, activeCode is still the old code of this tab and the facts
        // would word port problems of music that does not play any more. Nothing went out while the hold
        // lasted, so this is the first message of the new page.
        if (tookRoleBack) {
          midiOut.holdFacts(false);
          midiOut.publishFacts({ force: true });
        }
      })
      .catch((err) => reportChainError('hello', err));
    return;
  }

  if (msg.type === 'evaluate') {
    chain = chain.then(() => handleEvaluate(msg)).catch((err) => reportChainError(`evaluate ${msg.id}`, err));
    return;
  }

  if (msg.type === 'stop') {
    chain = chain
      .then(async () => {
        await stopSoundLocally();
        sendIfOpen(JSON.stringify({ type: 'stop-result', id: msg.id }));
      })
      .catch((err) => reportChainError(`stop ${msg.id}`, err));
    return;
  }

  if (msg.type === 'version') {
    // A plain text update naming code the page has already confirmed — runs outside
    // the serial `chain` since it needs no await and must never wait behind a pending evaluate.
    currentVersionId = msg.id;
    currentRestoredFrom = msg.restoredFrom ?? null;
    // The lanes drawn in the evaluation this id belongs to show this version (a draw can come first).
    if (timelineDrawn !== null && timelineDrawn.generation === timelineGeneration) timelineDrawn.version = msg.id;
    renderVersionIndicator();
    historyUi.setCurrent(msg.id);
    askUi.setCurrentVersion(msg.id);
    return;
  }

  if (msg.type === 'data-folder') {
    // The answer to data-folder-request (mirrors src/protocol.ts by hand), a plain update that needs no
    // await, so it runs outside the serial `chain`. An invalid value is one console.error naming the problem
    // (never the text) and the folder stays unknown, so the view says "Claude can tell you where the folder is".
    try {
      pageDataFolder = readDataFolder(msg.path);
    } catch (err) {
      console.error(err);
      pageDataFolder = null;
    }
    renderInstrumentsIfOpen();
    return;
  }

  if (
    msg.type === 'history' ||
    msg.type === 'history-add' ||
    msg.type === 'history-older' ||
    msg.type === 'history-favorite' ||
    msg.type === 'history-error' ||
    msg.type === 'history-older-error'
  ) {
    // The history feed, like the version case above it needs no await and runs
    // outside the serial `chain`.
    historyUi.onServerMessage(msg);
    return;
  }

  if (
    msg.type === 'ask-auth' ||
    msg.type === 'ask-result' ||
    msg.type === 'ask-received' ||
    msg.type === 'page-requests'
  ) {
    // The answers to page-auth and to each request, outside the serial `chain` like 'version'.
    // page-requests (mirrors src/protocol.ts by hand): whether page requests reach
    // Claude live, shown in the top bar.
    askUi.onServerMessage(msg);
    if (msg.type === 'ask-auth' && msg.ok === false) {
      // The server did not accept this page's token (a page from an earlier start): it gets no hello
      // and ignores everything else this page sends, so say so in the top bar. askUi stays connected
      // so a request still shows the token refusal line.
      renderConnectionState('refused');
      historyUi.setConnected('disconnected');
      mixerUi.setConnected('disconnected');
      pageRefused = true;
      renderInstrumentsIfOpen();
    }
    return;
  }

  if (msg.type === 'instrument-result') {
    // Mirrors src/protocol.ts by hand: the answer to one instrument-switch of this page. Outside the serial
    // `chain` like the other plain updates; the rig push it follows has already been applied.
    onInstrumentResult(msg);
    return;
  }

  console.error('Moontide: received unknown message type from server:', msg.type);
});

function sendIfOpen(data) {
  if (ws.readyState !== ws.OPEN) {
    console.error('Moontide: dropped a reply because the socket is no longer open.');
    return;
  }
  ws.send(data);
}

function evalErrorLine(evalError) {
  const line = evalError && evalError.loc && evalError.loc.line;
  return Number.isInteger(line) && line > 0 ? line : undefined;
}

/**
 * Builds the {errorText, line} pair reported for a failed evaluation, shared by
 * handleEvaluate's 'evaluated' failure and reportHandEval's 'hand-eval' failure, so both build the error and line exactly alike.
 */
function buildEvalErrorReport(evalError) {
  return { errorText: String(evalError.message || evalError), line: evalErrorLine(evalError) };
}

/**
 * The one place that takes a failed change back out of the editor: sets the text to the committed code (the music
 * that is audible), or to nothing before any code has played, and shows the failed-change banner. Returns the
 * report, so a caller that tells the server about the failure sends the same text and line. Every failed
 * evaluation of code the page wrote or received ends here: Claude's change, the reconnect replay and the page's own
 * rewrites.
 */
function revertAndReport(evalError) {
  editor.setCode(hasEvaluatedSuccessfully ? committedCode() : '');
  const report = buildEvalErrorReport(evalError);
  showEvalError(report.errorText);
  return report;
}

async function handleEvaluate(msg) {
  // An unknown timing is refused before anything changes (the page mirrors src/protocol.ts by hand).
  let timing;
  try {
    timing = parseTiming(msg.at, msg.phraseCycles);
  } catch (err) {
    sendIfOpen(
      JSON.stringify({ type: 'evaluated', id: msg.id, ok: false, code: msg.code, error: err instanceof Error ? err.message : String(err) }),
    );
    return;
  }
  // A pending Mixer gesture is recorded (with the code that played) before Claude's code
  // applies, so the history reads gesture then Claude; the touched lines no longer describe the text.
  await mixerGesture.flushDirect();
  clearMixerFlash();
  const wasStopped = pageStopped;
  const stopCountAtStart = stopCount;
  editor.setCode(msg.code);
  // Tag as playing from the start of this evaluate, before calling evaluate() itself
  // — some errors (a chord/voicing lookup, or the scheduler's own synchronous autostart tick)
  // can be raised by runProgrammaticEvaluate() itself, before this function's own continuation
  // gets to run any statement after the await; tagging any later would leave those errors
  // untagged (or still carrying the previous id) and wrongly labeled as coming from an earlier
  // version. Reverted below on failure — the old code is still what's actually playing then.
  // The tag that plays when this evaluation fails or only waits is `evaluateTag.baseline()`: the one from before it, or
  // the one of a waiting change that took over inside it (settled by this change before it was installed).
  evaluateTag.begin(msg.id);
  let run;
  try {
    run = await runProgrammaticEvaluate(timing);
  } finally {
    evaluateTag.end();
  }
  const evalError = editor.repl.state.evalError;
  if (evalError) {
    // The old code is still playing — restore its tag (A failed evaluation leaves
    // it unchanged, per the on-success comment below).
    playingEvaluateId = evaluateTag.baseline();
    // Never leave Claude's broken code in the editor — revert to what is
    // still audible. Never call editor.evaluate() here: the previous pattern is still
    // playing, re-running it is unnecessary and risks re-triggering audio. A failed
    // evaluate leaves pageStopped and the silence unchanged.
    const { errorText, line } = revertAndReport(evalError);
    const payload = {
      type: 'evaluated',
      id: msg.id,
      ok: false,
      code: msg.code,
      error: errorText,
    };
    if (line !== undefined) {
      payload.line = line;
    }
    sendIfOpen(JSON.stringify(payload));
    return;
  }
  // A successful evaluate already restarted the scheduler (autostart), but
  // Strudel never resumes the AudioContext itself — mirror the explicit resume the initial
  // unlock overlay already does. Skipped entirely if a stop happened
  // since this request started (stopCount changed) — that's handled below instead, since
  // resuming would be pointless.
  if (wasStopped && stopCount === stopCountAtStart) {
    await resumeAfterStop();
  }
  let audio =
    typeof globalThis.getAudioContext === 'function'
      ? audioReport(globalThis.getAudioContext().state)
      : 'waiting-for-click';
  // The change waits for its line. The old code still plays, so its evaluate id stays the tag of the
  // runtime errors, and the takeover (the server's history entry, get_code, the version) is reported when the
  // line is audible. The reply comes at once: the first-cycle watch has nothing to watch yet. A Stop during the
  // evaluation canceled the record, so that case takes the "stopped while starting" path below.
  const waiting = run.deferred;
  // A change that waited and was replaced by a newer evaluation before this reply is answered (the next queued run
  // starts before this code resumes) is answered as a waiting change that did not take over: the reply states its
  // line, and the cancel the page could not send earlier (the server had not heard of it) follows the reply.
  const replacedBeforeReply = waiting !== null && waiting.canceled && waiting.cancelReason === 'replaced' && stopCount === stopCountAtStart;
  if (waiting !== null && (takeover.pending() === waiting || replacedBeforeReply)) {
    if (replacedBeforeReply) {
      // The newer change tagged the runtime errors itself; only this change's own tag is taken back.
      if (playingEvaluateId === msg.id) playingEvaluateId = evaluateTag.baseline();
    } else {
      playingEvaluateId = evaluateTag.baseline();
    }
    waiting.evaluateId = msg.id;
    if (!replacedBeforeReply) {
      takeover.whenFinished(waiting, () => {
        evaluateTag.fromTakeover(msg.id);
        sendIfOpen(JSON.stringify({ type: 'takeover', id: msg.id }));
      });
    }
    sendIfOpen(
      JSON.stringify({
        type: 'evaluated',
        id: msg.id,
        ok: true,
        code: replacedBeforeReply && typeof waiting.code === 'string' ? waiting.code : editor.repl.state.activeCode,
        audio,
        pending: { cycle: waiting.boundary, seconds: pendingSecondsForReply(waiting.boundary) },
        ...(typeof run.bpm === 'number' ? { bpm: run.bpm } : {}),
      }),
    );
    waiting.replied = true;
    if (replacedBeforeReply) sendIfOpen(JSON.stringify({ type: 'takeover-canceled', id: msg.id, reason: 'replaced' }));
    return;
  }
  // Briefly watch the first cycle so a runtime error that fires immediately
  // (the strudel.log listener above) reaches the server, and therefore Claude's response,
  // before this reply — same WebSocket, so frame order is preserved.
  await new Promise((resolve) => setTimeout(resolve, FIRST_CYCLE_WATCH_MS));
  // The Stop button or the shortcut fired while this code was starting (stopSoundLocally()
  // incremented stopCount): the evaluate() above already restarted the scheduler via
  // autostart, so stop it again and tell Claude the truth instead of "ok, playing". The stop
  // MCP tool can never hit this path — it goes through the serial `chain`, so it can't
  // interleave with a still-running handleEvaluate() call.
  if (stopCount !== stopCountAtStart) {
    await stopSoundLocally();
    audio = 'stopped';
  }
  // A change that already took over (a newer change settled it at its line before this reply) is reported with its
  // own code; the editor may already hold the newer change's text.
  const finishedBeforeReply = waiting !== null && waiting.finished === true && typeof waiting.code === 'string';
  sendIfOpen(
    JSON.stringify({
      type: 'evaluated',
      id: msg.id,
      ok: true,
      code: finishedBeforeReply ? waiting.code : editor.repl.state.activeCode,
      audio,
      ...(typeof run.bpm === 'number' ? { bpm: run.bpm } : {}),
    }),
  );
}

// --- the Mixer's writes ---

/** Sends one recorded gesture (about 1.5 s after its last move). A dropped record is loud: the
 * change is playing but did not reach the history. */
function sendMixerRecord(code, label) {
  if (ws.readyState !== ws.OPEN) {
    showHistoryProblem(MIXER_COPY.notSaved);
    return;
  }
  // Mirrors src/protocol.ts's mixer-record by hand.
  ws.send(JSON.stringify({ type: 'mixer-record', code, label: clipMixerLabel(label) }));
}

// The one path through which the page changes the code by itself (page/page-rewrite.js): the Mixer and the
// part launch call it, and each keeps its own wording for a refusal and its own message to the server.
const pageRewrite = createPageRewrite({
  editor: {
    get code() {
      return editor.code;
    },
    setCode(text) {
      editor.setCode(text);
    },
    // The edit list changes the text in place, keeping the selection and the scroll.
    dispatch(edits) {
      editor.editor.dispatch({ changes: edits });
    },
  },
  hasEvaluated: () => hasEvaluatedSuccessfully,
  pending: () => takeover.pending(),
  playingCode,
  socketOpen: () => ws.readyState === ws.OPEN,
  parserReady: () => Boolean(window.acorn) && typeof window.acorn.parse === 'function',
  evaluate({ code, timing, autostart, flash }) {
    return flash ? runProgrammaticEvaluate(timing) : runMixerEvaluate(code, autostart, timing);
  },
  evalError: () => editor.repl.state.evalError,
  revertAndReport,
  // A page-originated evaluation has no Claude evaluate id.
  markPageOrigin() {
    playingEvaluateId = null;
  },
  whenFinished: (record, fn) => takeover.whenFinished(record, fn),
  markPageOriginAtTakeover() {
    evaluateTag.fromTakeover(null);
  },
});

/**
 * Applies ONE Mixer change to the playing code, immediately. Runs only inside the serial `chain`
 * (or from mixerGesture.flushDirect, itself called from inside it), so the editor cannot change
 * between the guard below and the write. Resolves `{ played, code }` when the code is now what
 * plays (played false when the change left the text as it was), or null when nothing was written:
 * nothing has played yet, the socket is closed, or the editor holds text that was not evaluated
 * (the user's typing is never overwritten). A rewrite the mixer refuses is logged with its reason.
 */
async function applyMixerChangeNow(change) {
  // onVersionPlaying clears pendingLaunch on every live tick, but a mixer write never moves a
  // part's offset: a launch still counting down must survive it (set back after the evaluation).
  const launchBefore = pendingLaunch;
  mixerTickInFlight = true;
  let outcome;
  let removed;
  try {
    // A mixer move is not a request to play: never resumeAfterStop(), and no autostart while stopped.
    outcome = await pageRewrite.apply({
      autostart: !pageStopped,
      build(activeCode) {
        // A bus parameter is written on every track that sends to the bus, a MIDI control on every track of its
        // port and channel, and a group's mute or solo on every track it reaches, in one edit list; every other change is one track's.
        const parse = window.acorn.parse;
        let result;
        if (change.type === 'bus-param') result = writeBus(activeCode, change, { parse });
        else if (change.type === 'midi-control') result = writeMidiControl(activeCode, change, { parse });
        else if (change.type === 'group') result = writeTracks(activeCode, change.identities, { type: change.kind, on: change.on }, { parse });
        else result = writeTrack(activeCode, change.identity, change, { parse });
        removed = result.removed;
        return result;
      },
    });
  } catch (err) {
    if (!(err instanceof MixerRewriteError)) {
      console.error('Moontide: the mixer could not read the playing code:', err);
      return null;
    }
    console.error(`Moontide: the mixer refused a change (${err.reason}):`, err.message);
    showMixerProblem(err.message);
    if (viewState.view === 'mixer') renderMixer();
    return null;
  } finally {
    mixerTickInFlight = false;
  }
  if (outcome.status === 'refused') {
    switch (outcome.reason) {
      case 'not-played':
        console.error('Moontide: the mixer has nothing to change yet: no code has played.');
        break;
      case 'waiting':
        // The waiting change must not be played or recorded by a move; the Mixer says so in its notice.
        console.error('Moontide: the mixer change was not applied: a change is waiting for its bar line.');
        break;
      case 'closed':
        console.error('Moontide: the mixer change was not applied: the socket is not open.');
        break;
      case 'no-parser':
        console.error('Moontide: window.acorn is not available — cannot change the mixer.');
        break;
      case 'dirty':
        // The authoritative guard against overwriting a hand edit that was not evaluated.
        console.error('Moontide: the mixer change was not applied: the editor holds a hand edit that was not evaluated.');
        // The poll only explains; this is the authoritative check, so it turns the notice on itself.
        mixerUi.setDirty(true);
        if (viewState.view === 'mixer') renderMixer();
        break;
      default:
        console.error('Moontide: the editor text does not match the mixer rewrite; reverting.');
    }
    return null;
  }
  if (outcome.status === 'unchanged') {
    return { played: false, code: outcome.code };
  }
  if (outcome.status === 'failed') {
    // The old code is still what plays; the shared path already set the editor back and showed the banner.
    return null;
  }
  pendingLaunch = launchBefore;
  updateBypassRecords(change, removed);
  const playing = editor.repl.state.activeCode;
  // Mirrors src/protocol.ts's mixer-live by hand: get_code returns the code that plays now.
  sendIfOpen(JSON.stringify({ type: 'mixer-live', code: playing }));
  flashMixerLines(outcome.edits);
  return { played: true, code: playing };
}

/**
 * Keeps the page's bypass records in step with a change that just played: a bypass stores the
 * calls the rewrite took out of the code (`removed`); turning the effect back on or removing it forgets
 * them. Storage that refuses still works for the session in memory.
 */
function updateBypassRecords(change, removed) {
  if (change.type === 'bypass-effect' && Array.isArray(removed)) {
    mixerBypassRecords = rememberBypass(mixerBypassRecords, { identity: change.identity, effect: change.effect, calls: removed });
  } else if (change.type === 'restore-effect' || change.type === 'remove-effect') {
    mixerBypassRecords = forgetBypass(mixerBypassRecords, change.identity, change.effect);
  } else {
    return;
  }
  if (!writeBypassRecords(storage, mixerBypassRecords)) reportStorageUnavailableOnce();
  // The evaluation already redrew the strips, before the records changed: draw them again.
  if (viewState.view === 'mixer') renderMixer();
}

/** Removes the touched-line overlay at once and cancels its timers. */
function clearMixerFlash() {
  mixerFlashGeneration++;
  if (mixerFlashFadeTimer !== null) clearTimeout(mixerFlashFadeTimer);
  if (mixerFlashEndTimer !== null) clearTimeout(mixerFlashEndTimer);
  mixerFlashFadeTimer = null;
  mixerFlashEndTimer = null;
  for (const el of mixerFlashEls) el.remove();
  mixerFlashEls = [];
}

/**
 * Lights the code lines a Mixer change wrote for about 1.5 s: one
 * neutral overlay element per line inside the editor's scroll container, positioned inside
 * view.requestMeasure so CodeMirror has measured first. An overlay, never a class on a .cm-line
 * (dropped again within a frame during playback), and it never changes the text, selection or
 * scroll. A range the editor cannot map to a line lights nothing and never throws.
 */
function flashMixerLines(edits) {
  const view = editor.editor;
  clearMixerFlash();
  if (!view || typeof view.requestMeasure !== 'function') return;
  const generation = mixerFlashGeneration;
  let lineStarts;
  try {
    const doc = view.state.doc;
    const lines = new Set();
    for (const range of touchedRanges(edits)) {
      let from = range.from;
      // An insert that starts with a newline lights the next line, not the one it continues.
      if (from < range.to && doc.sliceString(from, from + 1) === '\n') from += 1;
      const first = doc.lineAt(from).number;
      const last = doc.lineAt(Math.max(from, range.to)).number;
      for (let n = first; n <= last; n++) lines.add(n);
    }
    lineStarts = [...lines].map((n) => doc.line(n).from);
  } catch (err) {
    console.error('Moontide: could not map the mixer change to a code line:', err);
    return;
  }
  if (lineStarts.length === 0) return;
  view.requestMeasure({
    read(v) {
      return {
        blocks: lineStarts.map((pos) => v.lineBlockAt(pos)),
        docTop: v.documentTop,
        scrollTop: v.scrollDOM.getBoundingClientRect().top,
        scrolled: v.scrollDOM.scrollTop,
        width: v.scrollDOM.scrollWidth,
      };
    },
    write(m, v) {
      if (generation !== mixerFlashGeneration) return;
      for (const block of m.blocks) {
        const el = document.createElement('div');
        el.className = 'mx-flash';
        el.style.top = `${m.docTop - m.scrollTop + m.scrolled + block.top}px`;
        el.style.height = `${block.height}px`;
        el.style.width = `${m.width}px`;
        v.scrollDOM.appendChild(el);
        mixerFlashEls.push(el);
      }
      mixerFlashFadeTimer = setTimeout(() => {
        if (viewState.motion !== 'on') return;
        for (const el of mixerFlashEls) el.dataset.fading = 'true';
      }, 1350);
      mixerFlashEndTimer = setTimeout(clearMixerFlash, 1500);
    },
  });
}

/** Removes the selected-strip light at once and drops any pending measure and scroll. */
function clearMixerLit() {
  mixerLitGeneration++;
  if (mixerLitEl !== null) mixerLitEl.remove();
  mixerLitEl = null;
  mixerLitReveal = false;
}

/**
 * Lights the block of the selected track strip in the editor, from its label to the end of its statement.
 * One overlay element in the editor's scroll container, positioned inside view.requestMeasure (the geometry of
 * flashMixerLines) and MOVED, never recreated, by every render, poll, resize and layout change, so it never blinks.
 * The light is true or absent: it shows only while the Mixer is open and the editor text equals the playing code,
 * since the range is computed from the editor's own text. It only reads geometry: it never changes the text or the
 * selection, never evaluates, and scrolls (once, instantly, by the smallest amount) only when `reveal` asks for it,
 * which only a strip selection does. A failure clears the light and never throws into a render.
 */
function syncMixerLit({ reveal = false } = {}) {
  try {
    mixerLitReveal ||= reveal;
    const identity = mixerUi.selectedStrip();
    const view = editor.editor;
    if (
      !view ||
      typeof view.requestMeasure !== 'function' ||
      identity === null ||
      viewState.view !== 'mixer' ||
      !hasEvaluatedSuccessfully ||
      editor.code !== playingCode() ||
      !window.acorn ||
      typeof window.acorn.parse !== 'function'
    ) {
      clearMixerLit();
      return;
    }
    const code = editor.code;
    if (mixerLitMemo.code !== code || mixerLitMemo.identity !== identity) {
      mixerLitMemo = { code, identity, range: trackRange(code, identity, { parse: window.acorn.parse }) };
    }
    const range = mixerLitMemo.range;
    if (range === null) {
      clearMixerLit();
      return;
    }
    // The current element stays until the write moves it: a relight never shows a blank frame.
    const generation = mixerLitGeneration;
    // The range belongs to this document: the measure runs a frame later, and a Mixer write or a keystroke in between
    // changes the text. A measure that finds another document reads nothing and takes the light away (no light rather
    // than one on the wrong lines); the next render or poll relights it, or clears it while the texts differ.
    const doc = view.state.doc;
    view.requestMeasure({
      key: 'mx-lit',
      read(v) {
        if (v.state.doc !== doc) return null;
        return {
          first: v.lineBlockAt(range.from),
          last: v.lineBlockAt(range.to),
          docTop: v.documentTop,
          boxTop: v.scrollDOM.getBoundingClientRect().top,
          scrolled: v.scrollDOM.scrollTop,
          width: v.scrollDOM.scrollWidth,
          viewHeight: v.scrollDOM.clientHeight,
        };
      },
      write(m, v) {
        if (generation !== mixerLitGeneration) return;
        if (m === null) {
          // The pending reveal stays: the relight that follows still scrolls to the selected block.
          if (mixerLitEl !== null) mixerLitEl.remove();
          mixerLitEl = null;
          return;
        }
        if (mixerLitEl === null || mixerLitEl.parentNode !== v.scrollDOM) {
          if (mixerLitEl !== null) mixerLitEl.remove();
          mixerLitEl = document.createElement('div');
          mixerLitEl.className = 'mx-lit';
          // Inserted before the flash, so the flash of a Mixer move is drawn above it.
          v.scrollDOM.insertBefore(mixerLitEl, v.scrollDOM.querySelector('.mx-flash'));
        }
        const top = m.docTop - m.boxTop + m.scrolled + m.first.top;
        const height = m.last.top + m.last.height - m.first.top;
        mixerLitEl.dataset.track = identity;
        mixerLitEl.style.top = `${top}px`;
        mixerLitEl.style.height = `${height}px`;
        mixerLitEl.style.width = `${m.width}px`;
        if (mixerLitReveal) {
          // Only a selection scrolls, and only an editor that is visible in this layout: the smallest scroll that
          // shows the whole block (top-aligned when the block is taller than the editor), instant, no selection change.
          mixerLitReveal = false;
          if (m.viewHeight > 0) {
            // scrollTop is a whole number of pixels while line heights are not: round toward the side that keeps the block whole.
            if (height >= m.viewHeight || top < m.scrolled) v.scrollDOM.scrollTop = Math.floor(top);
            else if (top + height > m.scrolled + m.viewHeight) v.scrollDOM.scrollTop = Math.ceil(top + height - m.viewHeight);
          }
        }
      },
    });
  } catch (err) {
    console.error("Moontide: could not light the selected track's code:", err);
    clearMixerLit();
  }
}

/**
 * Turns the Mixer off while the editor holds a hand edit that was not evaluated. Typing
 * fires no event the page can hear, so this is polled every 250 ms while
 * the Mixer is open. It skips while a Mixer tick or any programmatic evaluation is in flight (the
 * editor legitimately differs from the playing code then). The write guard in applyMixerChangeNow
 * re-checks on its own, inside the serial chain: this poll only explains.
 */
function checkMixerDirty() {
  if (mixerTickInFlight || programmaticEvalInFlight) return;
  mixerUi.setDirty(hasEvaluatedSuccessfully && editor.code !== playingCode());
}

/** The Mixer's 250 ms poll: the dirty check, and a fader that kept its own value while it was held
 * takes the model's value once it is released. */
function mixerPoll() {
  checkMixerDirty();
  if (mixerUi.hasStale()) renderMixer();
  // The light follows a typed edit, a wrap change or a layout change within one poll; it stays as it is while an
  // evaluation is in flight (the editor legitimately differs from the playing code then).
  if (!mixerTickInFlight && !programmaticEvalInFlight) syncMixerLit();
}

let mixerDirtyTimer = null;

/**
 * The Mixer and Parts follow whether a change waits for its line: the Mixer shows its neutral notice and
 * the Parts view its waiting line, and the open one is drawn again (from the code that plays, see playingCode()).
 */
function syncWaitingViews() {
  try {
    mixerUi.setWaiting(takeover.pending() !== null);
    if (viewState.view === 'mixer') renderMixer();
    else if (viewState.view === 'parts') renderParts();
    renderInstrumentsIfOpen();
  } catch (err) {
    // Called from the takeover's hooks, which must never break an evaluation or a takeover.
    console.error('Moontide: the views could not follow the waiting change:', err);
  }
}

/**
 * The song structure the Mixer draws groups from, for `code`: the reading made when this version took over when it belongs
 * to the same text, else a new reading. Code the page cannot read counts as a piece without a song, so the Mixer stays flat.
 */
function mixerSongReading(code) {
  if (songReading !== null && songReading.code === code) return songReading.reading;
  if (code === '') return { state: 'none' };
  try {
    const parse = window.acorn.parse;
    return readStructure(code, { parse, tracks: extractTracks(code, { parse }) });
  } catch (err) {
    console.error('Moontide: the mixer could not read the song structure:', err);
    return { state: 'none' };
  }
}

/** Draws the Mixer for the code that is playing now. */
function renderMixer() {
  checkMixerDirty();
  if (!window.acorn || typeof window.acorn.parse !== 'function') {
    console.error('Moontide: window.acorn is not available — the mixer cannot read the code.');
    mixerUi.render({ status: 'unreadable', strips: [] });
    lights.setLayout(lightLayout({ status: 'unreadable', strips: [] }, { webMidi: false }));
    syncMixerLit();
    return;
  }
  const code = hasEvaluatedSuccessfully ? playingCode() : '';
  const model = buildMixerModel({
    code,
    parse: window.acorn.parse,
    colorOf: (identity) => trackColors.colorOf(identity),
    bypassRecords: mixerBypassRecords,
    busMemory: mixerBusMemory,
    keepBus: mixerUi.selectedBus(),
    rig: pageRig,
    song: mixerSongReading(code),
    folds: songFolds,
  });
  mixerBusMemory = model.busMemory;
  if (model.error) console.error('Moontide: the mixer could not read the playing code:', model.error);
  // The code wins: a record whose effect is back in the code (Claude wrote it again) is dropped.
  if (model.staleRecords && model.staleRecords.length > 0) {
    for (const { identity, effect } of model.staleRecords) mixerBypassRecords = forgetBypass(mixerBypassRecords, identity, effect);
    if (!writeBypassRecords(storage, mixerBypassRecords)) reportStorageUnavailableOnce();
  }
  mixerUi.render(model);
  // The lights learn which tracks the Mixer shows, which of them sound, and which groups hold them.
  lights.setLayout(lightLayout(model, { webMidi: typeof navigator.requestMIDIAccess === 'function' }));
  // Every render moves the one light onto the selected strip's block (or clears it): the strip may have left the model.
  syncMixerLit();
}

// Which layout and view are open, and the motion switch. Layout and view
// switching is by key or by the Views and Layout buttons in the top bar — the same key (or Escape)
// closes the view that key opened. Shortcuts are inert while the cursor is in the code editor
// (page/views.js applyKey), so typing code never switches a view. A top-bar button click runs
// the same applyKey decision with focus treated as outside the editor, so it works whatever
// holds focus, including the code editor.

// The storage getter itself can throw (private window, blocked storage), not just
// its methods, so this is wrapped too.
let storage = null;
try {
  storage = window.localStorage;
} catch {
  storage = null;
}

// Logged at most once per page session (no error UI for this).
let storageUnavailableLogged = false;
function reportStorageUnavailableOnce() {
  if (storageUnavailableLogged) return;
  storageUnavailableLogged = true;
  console.error('Moontide: browser storage is unavailable; layout, view, motion, History display, Jam instrument, Jam chord tones, change timing, the song launch choice and folded song groups will not be remembered.');
}

const initialPrefs = readViewPrefs(storage);
if (!initialPrefs.available) reportStorageUnavailableOnce();
// The parameters of bypassed effects, per track identity (validated against the registry on read).
const initialBypass = readBypassRecords(storage);
mixerBypassRecords = initialBypass.records;
if (!initialBypass.available) reportStorageUnavailableOnce();
// The groups of the Song grid that are folded, as group keys. A stored value that cannot be read is reported once and
// ignored, so every group starts open.
const initialFolds = readSongFolds(storage);
if (!initialFolds.available) reportStorageUnavailableOnce();
else if (initialFolds.rejected) console.error(SONG_FOLDS_COPY.badStored);
let songFolds = new Set(initialFolds.value);
// Whether the sentence for a fold that cannot be remembered was already logged in this page session.
let notRememberedSaid = false;
const reduceMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
let viewState = initialViewState({ prefs: initialPrefs, prefersReducedMotion: reduceMotionQuery.matches });

// The size of the view in layout a and in layout b, as a percent of the workspace. A stored size that is
// not a number from 15 to 85 was refused by readViewPrefs: say so once per key (loud), and use the default.
const splitSizes = { a: initialPrefs.splitA ?? SPLIT_DEFAULTS.a, b: initialPrefs.splitB ?? SPLIT_DEFAULTS.b };
for (const key of initialPrefs.rejected) {
  console.error(SPLIT_COPY.badStored(key, key === STORAGE_KEYS.splitA ? SPLIT_DEFAULTS.a : SPLIT_DEFAULTS.b));
}
const splitStorageKeys = { a: STORAGE_KEYS.splitA, b: STORAGE_KEYS.splitB };

// The border between the editor and the view. The view only draws and listens; this is the one place that applies a size
// (the CSS variable on the workspace, written from the clamped number and never from stored text), stores it per layout,
// and refreshes what listens only to the window.
const splitUi = createSplitView({
  document,
  onSize: (value, { final }) => applySplit(value, { final }),
  onReset() {
    const layout = viewState.layout;
    if (layout === 'c') return;
    applySplit(SPLIT_DEFAULTS[layout], { final: true, reset: true });
  },
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (timer) => clearTimeout(timer),
});

let splitFrame = 0;

/** Marks the Timeline's section names that do not fit their span (the name is hidden, the tooltip keeps it). The mark is
 * taken off first: a hidden name has no width to measure, so a span that now fits would never lose its mark. */
function markNarrowSpans() {
  const spans = [...timelineSections.querySelectorAll('.section-span')];
  for (const spanEl of spans) delete spanEl.dataset.narrow;
  const narrow = spans.filter((spanEl) => spanEl.scrollWidth > spanEl.clientWidth);
  for (const spanEl of narrow) spanEl.dataset.narrow = 'true';
}

/** The things that listen only to the window follow a new size: the Mixer's lit strip once per animation
 * frame while a drag moves and on release, the Timeline's narrow-span marks on release. CodeMirror needs nothing: it
 * measures itself (its own ResizeObserver), and no manual measure call is made here. */
function refreshAfterSize({ final }) {
  if (final) {
    if (splitFrame !== 0) cancelAnimationFrame(splitFrame);
    splitFrame = 0;
    if (viewState.view === 'mixer') syncMixerLit();
    if (viewState.view === 'timeline') markNarrowSpans();
    return;
  }
  if (splitFrame !== 0) return;
  splitFrame = requestAnimationFrame(() => {
    splitFrame = 0;
    if (viewState.view === 'mixer') syncMixerLit();
  });
}

/** Applies a size of the view for the current layout: the CSS variable, the separator's values and, on a final change
 * (release, key step, reset), the stored size and the polite announcement. Layout c has no border. */
function applySplit(value, { final = false, reset = false } = {}) {
  const layout = viewState.layout;
  if (layout !== 'a' && layout !== 'b') return;
  const size = Math.round(clampSplit(value) * 10) / 10;
  splitSizes[layout] = size;
  workspace.style.setProperty('--view-size', `${size}%`);
  splitUi.setValue(size);
  if (final) {
    if (!writeViewPref(storage, splitStorageKeys[layout], String(size))) reportStorageUnavailableOnce();
    splitUi.say(reset ? 'reset' : 'kept', size, layout);
  }
  refreshAfterSize({ final });
}

// While the user has never pressed the motion switch, motion keeps following the OS live;
// once pressed, motionAfterOsChange returns the state
// unchanged (see page/views.js), so this is a no-op after that.
reduceMotionQuery.addEventListener('change', (event) => {
  const next = motionAfterOsChange(viewState, event.matches);
  if (next !== viewState) {
    viewState = next;
    renderViews();
  }
});

motionSwitch.addEventListener('click', () => {
  applyViewState(toggleMotion(viewState), ['motion']);
});

/** Applies a new view state, persisting only the keys that actually changed (never more than
 * one console.error for a blocked/throwing store — reportStorageUnavailableOnce above). */
function applyViewState(nextState, changedKeys) {
  viewState = nextState;
  for (const key of changedKeys) {
    const written = writeViewPref(storage, STORAGE_KEYS[key], nextState[key]);
    if (!written) reportStorageUnavailableOnce();
  }
  renderViews();
}

/** Commits the state an applyKey decision returned, if it changed: works out which of layout and
 * view changed and applies them. Shared by the keydown listener and the top-bar buttons so the
 * two paths cannot drift. */
function commitKeyResult(result) {
  if (result.state === viewState) return;
  const changedKeys = ['layout', 'view'].filter((key) => result.state[key] !== viewState[key]);
  applyViewState(result.state, changedKeys);
}

// A Views or Layout button does exactly what its key does: the same applyKey decision, with focus treated as outside
// the editor. Pressing the pressed view button closes the view (applyKey toggles). After a mouse click the button gives
// up focus, so the page is as after pressing the key with nothing focused (letter and number keys work at once, and the
// History list gets its arrows and Enter); a keyboard press on the focused button keeps focus. One handler serves both
// groups.
function onViewButtonClick(event) {
  const button = event.target instanceof Element ? event.target.closest('button[data-key]') : null;
  if (!button || !event.currentTarget.contains(button)) return;
  const result = applyKey(viewState, {
    key: button.dataset.key,
    focusInEditor: false,
    focusInTextEntry: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
  });
  // A button that does nothing is a bug: say so loudly.
  if (!result.handled) console.error(`Moontide: the '${button.dataset.key}' top-bar button did nothing`);
  commitKeyResult(result);
  if (event.detail > 0) button.blur();
}
viewButtonsEl.addEventListener('click', onViewButtonClick);
layoutButtonsEl.addEventListener('click', onViewButtonClick);

// Bumped by every successful evaluation (Claude, hand edit, reload replay) so a
// Timeline computation started for an older version can tell it is now stale and drop its
// own result instead of overwriting a newer one. versionPlayingAt records when the current
// version started playing (performance.now()), so refreshTimeline can wait out
// TIMELINE_SETTLE_MS only when it is actually racing a version that just started.
let timelineGeneration = 0;
// The song check and the song reading belong to one version of the music, so they use their own token: only a new
// version that plays bumps it, and closing the Timeline or Jam view (which bumps timelineGeneration) leaves them alone.
let songVersion = 0;
let versionPlayingAt = 0;

// The current version's own tracks/code/parser, set once per refreshTimeline() call and read by
// every page compute for that version (drawn page or a background prefetch alike).
let timelineTracks = null;
let timelineCode = null;
let timelineParse = null;
// The strings of timelineCode with the scope of every track, made on the first note picked on the version and dropped with it.
let timelineIndex = null;
// Where tokens play, worked out on demand for the version drawn: the evaluated pattern of each track and the answer for each
// token, both as promises, dropped with the version.
let timelinePlaces = { patterns: new Map(), answers: new Map() };
// One color per track identity, kept for the whole page session — never reset per version or
// per Timeline open/close.
const trackColors = createTrackColors();
// The shared reading: the Timeline and the Jam view read the playing
// pattern through one preparation and one page cache, so a page is queried once per version.
// readingVersion is bumped only in onVersionPlaying, which also empties everything below.
let readingVersion = 0;
// { version, promise } of the one prepareReading() for the current readingVersion.
let readingPreparation = null;
// pageStart -> computeTimeline 'ok' result, cleared by onVersionPlaying (a new version).
// Only 'ok' results are cached — a too-slow/failed/cancelled page is retried on its next visit.
let timelineCache = new Map();
// pageStart -> { generation, promise } for every computePage() call running, so the Timeline, the
// Jam view and a prefetch never start two queries for the same page.
let timelinePending = new Map();
// True while the lanes had the keyboard focus when the Timeline hid its body to compute again; any other element taking the focus
// clears it.
let timelineLanesWantFocus = false;
document.addEventListener('focusin', (event) => {
  if (event.target !== timelineLanes) timelineLanesWantFocus = false;
});
// The pageStart currently drawn in #timeline-lanes, or null while nothing has drawn yet.
let timelineDrawnPageStart = null;
// What the lanes on screen were drawn from: { pageStart, lanes: [{ track, midi, instrument, events }], version,
// generation }, the events exactly as the Timeline queried them, or null while the Timeline shows a message
// instead of lanes. A moment is read from this, so it is by construction what is drawn and never a second
// query. `version` is the history id of the music the lanes show: the one known when they were drawn, and the
// one the server announces afterwards while no newer evaluation has started (`generation` is the
// timelineGeneration they were drawn in), so a slow history write never pairs the lanes with an older id.
let timelineDrawn = null;
let timelinePlayheadLeftShown = null;
let timelinePlayheadLabelShown = null;
let timelinePlayheadSideShown = null;
let timelineRafId = null;

// The Jam view's state. jamReading is { reading, version }: the reading on screen and the
// readingVersion it was built for. jamStuck is the record of a failure (see jamStuckFor in
// page/jam-model.js: version, pageStart or null for a whole version, retry count and time): a rebuild
// cannot change a handled failure until the version or the page changes, so the 250 ms tick does not
// retry it four times a second; only a too-slow query is retried, once, after a pause.
let jamReading = null;
let jamTimer = null;
let jamRefreshRunning = false;
let jamRefreshAgain = false;
let jamLastPlayingCycle = null;
let jamStuck = null;
// True once the page after the reading's window has been prefetched (reset with each new reading).
let jamPrefetched = false;
// The console is told once per bad tempo and once per reading that cannot be drawn, not every 250 ms tick.
let jamTempoErrorLogged = false;
let jamDrawErrorLoggedFor = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True while a number field, a text field, a select or a text area holds focus (and the code editor
 * does not: it has its own rule). Range sliders, checkboxes and buttons do not count, so the view
 * keys keep working after a slider drag. */
function isTextEntryFocused() {
  const el = document.activeElement;
  if (!el || editorArea.contains(el)) return false;
  // Any control of an Instruments settings editor counts, so typing a channel number or a
  // port letter never changes the view or the layout.
  if (el.closest('.instrument-editor') !== null) return true;
  const tag = el.tagName;
  if (tag === 'SELECT' || tag === 'TEXTAREA') return true;
  if (tag === 'INPUT') return !['range', 'checkbox', 'radio', 'button', 'submit'].includes(el.type);
  return el.isContentEditable === true;
}

document.addEventListener('keydown', (event) => {
  const focusInEditor = editorArea.contains(document.activeElement);
  const focusInTextEntry = isTextEntryFocused();
  const result = applyKey(viewState, {
    key: event.key,
    focusInEditor,
    focusInTextEntry,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    altKey: event.altKey,
  });
  if (result.blurEditor && document.activeElement && typeof document.activeElement.blur === 'function') {
    document.activeElement.blur();
  }
  if (result.handled) {
    event.preventDefault();
  }
  commitKeyResult(result);
  // Arrows, Enter and Space: the History view takes them when the view keys did not, with the same editor check.
  if (!result.handled) {
    // Typing in a number field keeps its Enter, Space and arrows too: the History path ignores them there.
    historyUi.handleKeydown(event, { focusInEditor: focusInEditor || focusInTextEntry });
  }
});

/**
 * The code line under a pointer height, as `{ line, text }` (1-based, the text as the editor shows it), or
 * null below the last line. Finds the line by the height of each line block, never by the nearest
 * position, so a click in the empty space under the code is not a click on the last line. It only reads
 * the editor: nothing is selected, focused or scrolled.
 */
function codeLineAt(clientY) {
  try {
    const view = editor.editor;
    const doc = view.state.doc;
    const blocks = [];
    for (let n = 1; n <= doc.lines; n++) blocks.push(view.lineBlockAt(doc.line(n).from));
    const line = lineAtY(blocks, clientY - view.documentTop);
    return line === null ? null : { line, text: doc.line(line).text };
  } catch (err) {
    console.error('Moontide: could not find the code line under the pointer:', err);
    return null;
  }
}

/**
 * The moment of the music under the pointer, read from the lanes on screen, or null when nothing is
 * drawn (a message instead of lanes, a hidden Timeline) or the pointer is left of the lanes' event area
 * (the gutter). `svg` is the lane's own event area, the one reference for the pointer: the ruler sits
 * 2 px off it. A pointer right of the area is clamped by momentAt. `focusTrack` is the shown name of the lane
 * the pointer is on (undefined elsewhere): its notes come first, so the note cap never drops them.
 */
function timelineMomentAt(event, svg, focusTrack) {
  if (timelineDrawn === null || timelineBody.hidden) return null;
  const rect = svg.getBoundingClientRect();
  if (!(rect.width > 0) || event.clientX < rect.left) return null;
  return momentAt({
    pageStart: timelineDrawn.pageStart,
    fraction: (event.clientX - rect.left) / rect.width,
    lanes: timelineDrawn.lanes,
    version: timelineDrawn.version,
    focusTrack,
  });
}

/**
 * The first lane's event area: one reference for every pointer on the Timeline outside a lane (the ruler,
 * the part headers, the gaps). All lanes share one grid column, so the first stands for them all.
 */
function firstLaneEvents() {
  return timelineLanes.querySelector('svg.lane-events');
}

/**
 * What a right-click pointed at, as the descriptor page/ask.js describes, most specific first. The
 * views only describe an element (`askTarget`); this is the one place that decides which view owns
 * it. Anything that finds nothing is the whole session.
 */
function resolveAskTarget(event) {
  const session = { kind: 'session' };
  const target = event.target;
  if (!(target instanceof Element)) return session;
  if (editorArea.contains(target)) {
    if (target.closest('.cm-line, .cm-gutterElement') === null) return session;
    const found = codeLineAt(event.clientY);
    return found === null ? session : { kind: 'line', ...found };
  }
  if (target.closest('#history-view') !== null) return historyUi.askTarget(target) ?? session;
  if (target.closest('#mixer-view') !== null) return mixerUi.askTarget(target) ?? session;
  if (target.closest('#instruments-view') !== null) return instrumentsUi.askTarget(target) ?? session;
  // The Song grid knows its own headers, cells, group rows and track names, and a cell is a more specific target than the
  // header-like card around it, so it answers before the generic part match below. Anything else in the grid falls through.
  if (target.closest('table.song-grid') !== null) {
    const inGrid = songGridUi.askTarget(target);
    if (inGrid !== null) return inGrid;
  }
  const partEl = target.closest('.part-card[data-part], .section-span[data-part], .jam-row[data-part]');
  if (partEl !== null) {
    const owner = partEl.dataset.owner;
    const part = owner === undefined ? { kind: 'part', name: partEl.dataset.part } : { kind: 'part', name: partEl.dataset.part, owner };
    // Only a part header over the lanes carries the moment; a Parts view card and a Jam row never do.
    if (!partEl.matches('.section-span') || partEl.closest('#timeline-view') === null) return part;
    const svg = firstLaneEvents();
    const moment = svg === null ? null : timelineMomentAt(event, svg);
    return moment === null ? part : { ...part, moment };
  }
  const laneEl = target.closest('.lane[data-track]');
  if (laneEl !== null) {
    const track = laneEl.querySelector('.lane-name').textContent;
    const svg = target.closest('svg.lane-events');
    if (svg === null) return { kind: 'lane', track };
    const rect = svg.getBoundingClientRect();
    const fraction = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0;
    const cycle = cycleAt({ pageStart: Number(timelineLanes.dataset.pageStart), fraction });
    const moment = timelineMomentAt(event, svg, track);
    return moment === null ? { kind: 'lane', track, cycle } : { kind: 'lane', track, cycle, moment };
  }
  if (target.closest('#jam-view') !== null) return jamUi.askTarget(target) ?? session;
  // The rest of the Timeline (the ruler, the section row, the space between and under the lanes) is the moment
  // under the pointer; left of the lanes' event area timelineMomentAt finds nothing and it stays the session.
  if (target.closest('#timeline-view') !== null) {
    const svg = firstLaneEvents();
    const moment = svg === null ? null : timelineMomentAt(event, svg);
    if (moment !== null) return { ...session, moment };
  }
  return session;
}

/**
 * Opens the Ask box for what `describeTarget()` finds, at `point`: the one place both the right-click and the grid's
 * keyboard route go through. A target that cannot be resolved or described is a bug: it is said on the error line and in the
 * console, and the box opens on the whole session. A descriptor with a `prefill` (a fixed variation whose notes do not fit)
 * puts that request in the field; an existing draft is kept and the request follows it. Nothing is sent, evaluated or
 * recorded here, and an open cell list is closed first. Gives false when the target could not be described (the box then holds the
 * whole session and no request), true otherwise.
 */
function openAskFor(describeTarget, point) {
  let descriptor;
  let readable = true;
  try {
    descriptor = describeTarget();
    describeContext(descriptor);
  } catch (err) {
    // A view could not resolve or describe what was right-clicked: say so on the error line and in the
    // console, and still open the box on the whole session.
    console.error('Moontide: could not describe what was right-clicked, using the whole session:', err);
    descriptor = { kind: 'session' };
    showAskContextProblem(err);
    readable = false;
  }
  // This context reads fine: a stale "could not read" line would contradict the chip.
  if (readable && errorLineIsAskContext) clearEvalError();
  if (songGridUi.isListOpen()) songGridUi.closeList();
  if (typeof descriptor.prefill === 'string') askUi.open(descriptor, point, { prefill: descriptor.prefill });
  else askUi.open(descriptor, point);
  return readable;
}

/** The gesture field of a request for a change of the Timeline's note panel: a pitch change, a rest or a velocity step. */
function timelineGestureOf(change) {
  switch (change.kind) {
    case 'pitch':
      return { kind: 'pitch', semitones: change.semitones };
    case 'rest':
      return { kind: 'rest' };
    case 'velocity':
      return { kind: 'velocity', direction: change.steps > 0 ? 'louder' : 'softer' };
    default:
      throw new Error(`Moontide: unknown kind of Timeline change ${String(change.kind)}`);
  }
}

/**
 * Opens the Ask box for one note of the Timeline, at `point`: the lane context with the moment taken where the note starts (so the
 * note is among the moment's notes and the cycle of the text and of the moment are one number). With a `gesture` the box also
 * holds the ready-made request for it and the gesture rides on the message; without one the field stays as it is. Nothing is
 * written, evaluated or sent: only the person's Enter in the box sends. Gives false when nothing opened (the audio-unlock overlay
 * shows, or the note could not be described), so the panel does not say a request is ready.
 */
function askAboutTimelineNote(info, gesture, point) {
  if (!overlay.hidden) return false;
  return openAskFor(() => {
    if (timelineDrawn === null) throw new Error('Moontide: a note of the Timeline was asked about while no lanes are drawn.');
    const lane = timelineDrawn.lanes[info.laneIndex];
    const event = lane.events[info.eventIndex];
    const moment = momentAt({
      pageStart: timelineDrawn.pageStart,
      fraction: (event.begin - timelineDrawn.pageStart) / PAGE_CYCLES,
      lanes: timelineDrawn.lanes,
      version: timelineDrawn.version,
      focusTrack: lane.track,
    });
    const descriptor = { kind: 'lane', track: lane.track, cycle: moment.cycle, moment };
    if (gesture === undefined) return descriptor;
    return {
      ...descriptor,
      gesture,
      prefill: timelineEditPrefill({ ...gesture, note: info.noteText, cycle: moment.cycle, beat: moment.beat, track: lane.track }),
    };
  }, point);
}

/**
 * Opens the Ask box for a lane of the Timeline that has no note on the page, at `point`: the lane context with the moment taken at
 * the start of `cycle`, as a right-click there gives it. The field stays as it is. Nothing is written, evaluated or sent: only the
 * person's Enter in the box sends. Gives false when nothing opened.
 */
function askAboutTimelineLane(laneIndex, cycle, point) {
  if (!overlay.hidden) return false;
  return openAskFor(() => {
    if (timelineDrawn === null) throw new Error('Moontide: a lane of the Timeline was asked about while no lanes are drawn.');
    const lane = timelineDrawn.lanes[laneIndex];
    if (lane === undefined) throw new Error(`Moontide: the Timeline draws no lane ${laneIndex} to ask about.`);
    const moment = momentAt({
      pageStart: timelineDrawn.pageStart,
      fraction: (cycle - timelineDrawn.pageStart) / PAGE_CYCLES,
      lanes: timelineDrawn.lanes,
      version: timelineDrawn.version,
      focusTrack: lane.track,
    });
    return { kind: 'lane', track: lane.track, cycle: moment.cycle, moment };
  }, point);
}

/**
 * The section of the first and of the last cycle of a range as `{ section, sectionTo }`, for a piece with a song: `section` is
 * the section of the first cycle and `sectionTo` the section of the last only when it is another one. A piece without a song (or
 * with only arrange()) gives `{}`.
 */
function timelineRangeSections(from, to) {
  const reading = timelineSongReading();
  if (reading.state !== 'read') return {};
  const sectionAt = (cycle) => String(reading.sections[playingSection(reading, cycle).index].name);
  const first = sectionAt(from);
  const last = sectionAt(to);
  return last === first ? { section: first } : { section: first, sectionTo: last };
}

/** The lane of a range of the lanes drawn, or a loud error when the range names none. */
function timelineRangeLane(selection) {
  if (timelineDrawn === null) throw new Error('Moontide: a range of the Timeline was asked about while no lanes are drawn.');
  const lane = timelineDrawn.lanes[selection.laneIndex];
  if (lane === undefined) throw new Error(`Moontide: the range names lane ${selection.laneIndex}, which is not drawn.`);
  return lane;
}

/**
 * What the note panel says of a range: `{ track, section, sectionTo, count }` (the sections only for a piece with a song, the
 * count of the notes that start in the cycles). Reads the lanes and the code only.
 */
function describeTimelineRange(selection) {
  const lane = timelineRangeLane(selection);
  const { notes, more } = rangeNotes(lane, selection.from, selection.to);
  const { section = null, sectionTo = null } = timelineRangeSections(selection.from, selection.to);
  return { track: lane.track, section, sectionTo, count: notes.length + more };
}

/**
 * The descriptor of a range of cycles on one lane of the lanes drawn: the lane's shown name, the first and last cycle, the section
 * of each end when the playing code is a song (the second only when it differs), the notes of the lane that start in those cycles
 * with the version drawn, and the cut when the pointer left the page. Reads the lanes and the code only.
 */
function timelineRangeDescriptor(selection) {
  const lane = timelineRangeLane(selection);
  const { notes, more } = rangeNotes(lane, selection.from, selection.to);
  const descriptor = {
    kind: 'range',
    track: lane.track,
    from: selection.from,
    to: selection.to,
    ...timelineRangeSections(selection.from, selection.to),
    gesture: { kind: 'range', version: timelineDrawn.version, notes, more },
  };
  if (selection.cut !== null) descriptor.cut = selection.cut;
  return descriptor;
}

/**
 * Opens the Ask box for a range of cycles of the Timeline, at `point`, with an empty field (a draft in it is kept). Nothing is
 * written, evaluated or sent: only the person's Enter in the box sends. Gives false when nothing opened.
 */
function askAboutTimelineRange(selection, point) {
  if (!overlay.hidden) return false;
  return openAskFor(() => timelineRangeDescriptor(selection), point);
}

// The Menu key and Shift+F10 on a control of the Song grid: the same box as a right-click, at the centre of the control. The
// page's contextmenu listener leaves a Shift press to the browser, so the grid reports the key itself. The audio-unlock overlay
// is a gate to start sound, not part of the page's work, so the key does nothing while it shows.
songGridHandlers.ask = (descriptor, point) => {
  if (!overlay.hidden) return;
  openAskFor(() => descriptor, point);
};

// The one contextmenu listener of the page; no view module has its own. Shift + right-click keeps
// the browser's own menu, and so does a right-click inside the box (the user can paste) or while the
// audio-unlock overlay shows (it is a gate to start sound, not part of the page's work). The right-click
// never evaluates, records or changes the editor's text, selection or scroll.
document.addEventListener('contextmenu', (event) => {
  if (event.shiftKey || !overlay.hidden || askUi.contains(event.target)) return;
  event.preventDefault();
  // A right-click on the failed-change banner (or on its own popover) offers the banner's actions.
  if (event.target instanceof Node && (problemUi.contains(event.target) || problemUi.menuContains(event.target))) {
    problemUi.openMenu({ x: event.clientX, y: event.clientY });
    return;
  }
  openAskFor(() => resolveAskTarget(event), { x: event.clientX, y: event.clientY });
});

// A right press outside the open box must not move focus out of its field: the contextmenu that follows
// then moves the box and swaps its chip while the text and the caret stay. Shift keeps the browser's own
// behavior (and its menu), so it is left alone.
document.addEventListener('mousedown', (event) => {
  if (event.button !== 2 || event.shiftKey || !askUi.isOpen()) return;
  if (event.target instanceof Node && askUi.contains(event.target)) return;
  event.preventDefault();
}, true);

// A Space keyup never clicks a focused button when the History path handled its keydown.
document.addEventListener('keyup', (event) => {
  historyUi.handleKeyup(event);
});

// Set once renderViews has run at least once, so the very first render reflects the restored
// state plainly (no fade-in on load) instead of treating "no prior state" as a close-to-open
// transition. Read/written only by renderViews below.
let previousViewState = null;

/**
 * The border for the current state: its orientation, the stored size of the layout just switched to, and whether
 * it shows (only while a view is open in layout a or b). If it had focus and goes away (its view closed, or layout c
 * took over), focus goes to the button that did it: the button of the view just closed, or the layout button. Returns true
 * when a new size was applied for a layout switch, so renderViews refreshes the neighbors once the panel is laid out.
 */
function renderSplit(isOpen) {
  const layout = viewState.layout;
  const shown = isOpen && layout !== 'c';
  const hadFocus = splitUi.focusIsInside();
  const layoutChanged = previousViewState === null || previousViewState.layout !== layout;
  splitUi.setLayout(layout);
  if (layoutChanged) {
    if (layout === 'c') {
      workspace.style.removeProperty('--view-size');
    } else {
      workspace.style.setProperty('--view-size', `${splitSizes[layout]}%`);
      splitUi.setValue(splitSizes[layout]);
    }
  }
  splitUi.setHidden(!shown);
  if (hadFocus && !shown) {
    const closedDigit = previousViewState === null ? undefined : Object.keys(VIEW_KEYS).find((digit) => VIEW_KEYS[digit] === previousViewState.view);
    const selector =
      layout === 'c' && layoutChanged
        ? `#layout-buttons button[data-key="${layout}"]`
        : closedDigit === undefined
          ? null
          : `#view-buttons button[data-key="${closedDigit}"]`;
    const target = selector === null ? null : document.querySelector(selector);
    if (target !== null) target.focus();
  }
  return layoutChanged && layout !== 'c';
}

/** Shows or hides the view panel and the Timeline for the current viewState, sets the layout/
 * view/motion attributes CSS reads, fades the panel in/out, and
 * refreshes the Timeline's own content when it is the view that just opened. */
function renderViews() {
  const isOpen = viewState.view !== 'none';
  const wasTimelineOpen = previousViewState !== null && previousViewState.view === 'timeline';
  const wasPartsOpen = previousViewState !== null && previousViewState.view === 'parts';
  const isTimelineOpen = viewState.view === 'timeline';
  const isPartsOpen = viewState.view === 'parts';
  const isHistoryOpen = viewState.view === 'history';
  const isMixerOpen = viewState.view === 'mixer';
  const wasJamOpen = previousViewState !== null && previousViewState.view === 'jam';
  const isJamOpen = viewState.view === 'jam';

  if ((wasTimelineOpen || wasJamOpen) && !isTimelineOpen && !isJamOpen) {
    // The Timeline or the Jam view just closed and neither is open now (without a new version
    // starting, which already bumps this in onVersionPlaying): bump the generation so any
    // computePage() still running in the background for them — the page currently drawn, or a
    // prefetch — is dropped on its next isCancelled() check instead of burning CPU/audio budget
    // for a view nobody is looking at. A Timeline-to-Jam switch keeps the
    // cache and the pages in flight: both views read them.
    timelineGeneration++;
  }

  workspace.dataset.layout = viewState.layout;
  workspace.dataset.view = viewState.view;
  const splitSizeChanged = renderSplit(isOpen);
  document.documentElement.dataset.motion = viewState.motion;
  motionSwitch.textContent = MOTION_LABELS[viewState.motion];
  motionSwitch.setAttribute('aria-pressed', String(viewState.motion === 'on'));
  sessionUi.setTiming(viewState.changeTiming);
  for (const button of document.querySelectorAll('#view-buttons button[data-key], #layout-buttons button[data-key]')) {
    const { pressed } = hintButtonState(viewState, button.dataset.key);
    button.setAttribute('aria-pressed', String(pressed));
  }
  // The pressed state decides which view names the narrow fit step hides, so the width is checked again.
  topBarUi.fit();
  timelineView.hidden = !isTimelineOpen;
  partsView.hidden = !isPartsOpen;
  historyViewEl.hidden = !isHistoryOpen;
  mixerViewEl.hidden = !isMixerOpen;
  jamViewEl.hidden = !isJamOpen;
  const isInstrumentsOpen = viewState.view === 'instruments';
  instrumentsViewEl.hidden = !isInstrumentsOpen;
  instrumentsOpen = isInstrumentsOpen;
  jamUi.setPreferences({ instrument: viewState.jamInstrument, chordTones: viewState.jamChordTones });
  historyUi.setViewContext({ open: isHistoryOpen, layout: viewState.layout, mode: viewState.historyMode });

  if (previousViewState === null) {
    // First render (page load): reflect the restored layout/view plainly, no fade.
    viewPanel.hidden = !isOpen;
    viewPanel.dataset.shown = String(isOpen);
  } else {
    const wasOpen = previousViewState.view !== 'none';
    const layoutChanged = viewState.layout !== previousViewState.layout;
    const viewChanged = viewState.view !== previousViewState.view;
    if (isOpen && (viewChanged || layoutChanged)) {
      viewPanel.hidden = false;
      viewPanel.dataset.shown = 'false';
      requestAnimationFrame(() => {
        viewPanel.dataset.shown = 'true';
      });
    } else if (!isOpen && wasOpen) {
      viewPanel.dataset.shown = 'false';
      if (viewState.motion === 'on') {
        setTimeout(() => {
          if (viewState.view === 'none') viewPanel.hidden = true;
        }, 150);
      } else {
        viewPanel.hidden = true;
      }
    }
  }
  previousViewState = viewState;
  if (splitSizeChanged) refreshAfterSize({ final: true });

  // The animation loop runs while
  // either the Timeline or the Parts view is open: a fresh Timeline open (including the very
  // first render, when a session restored view: 'timeline') starts a full refreshTimeline(),
  // which starts the loop itself; a layout or motion change while it stays open must never
  // restart it (the loop already tracks the live clock on its own, every frame — see
  // timelineTick below). Parts has no async computation, so opening it starts the loop directly.
  // A closed Timeline hands no edit over: steps and edits that wait are dropped, and the panel says so when it shows again.
  if (wasTimelineOpen && !isTimelineOpen) timelineEditUi.close();
  if (isTimelineOpen && !wasTimelineOpen) {
    void refreshTimeline().catch((err) => {
      console.error('Moontide: failed to refresh the Timeline:', err);
      renderTimelineMessage(TIMELINE_COPY.failed, 'failed');
    });
  }
  // A refusal ends when the view closes.
  if (wasPartsOpen && !isPartsOpen) gridRefused = null;
  if (isPartsOpen) {
    renderParts();
    startTimelineLoop();
  }
  if (isMixerOpen) {
    renderMixer();
    if (mixerDirtyTimer === null) mixerDirtyTimer = setInterval(mixerPoll, 250);
  } else {
    // The view keeps its selected strip; reopening runs renderMixer, which lights it again without scrolling.
    clearMixerLit();
    if (mixerDirtyTimer !== null) {
      clearInterval(mixerDirtyTimer);
      mixerDirtyTimer = null;
    }
  }
  if (isJamOpen) {
    if (jamTimer === null) jamTimer = setInterval(jamPoll, 250);
    if (!wasJamOpen) {
      jamReading = null;
      jamStuck = null;
      void refreshJam().catch(reportJamRefreshError);
    }
  } else if (jamTimer !== null) {
    clearInterval(jamTimer);
    jamTimer = null;
    jamReading = null;
    jamStuck = null;
  }
  if (!isTimelineOpen && !isPartsOpen && (wasTimelineOpen || wasPartsOpen)) {
    stopTimelineLoop();
  }
  // No timer: the view follows the events that already redraw the MIDI indicator (see renderMidiIndicator).
  if (isInstrumentsOpen) renderInstruments();
  else instrumentsUi.closed();
  // Opening the Mixer, closing it and switching motion all change whether the lights run, and how.
  syncLights();
}

/**
 * Starts, stops or restarts the lights to match the page: they run only while the Mixer is open, the tab is visible and sound
 * is playing. Starting (and a switch of motion while running) forgets every note and takes every light to unlit, so lights
 * follow only the notes that come after; stopping does the same and ends the loop.
 */
function syncLights() {
  if (!lightsViewReady) return;
  // A failure ends the lights only until the music stops: the next Start tries again.
  if (currentSoundState !== 'playing') lightsBroken = false;
  const wanted = !lightsBroken && viewState.view === 'mixer' && document.visibilityState === 'visible' && currentSoundState === 'playing';
  if (!wanted) {
    stopLights();
    return;
  }
  if (lightsActive && lightsMotion === viewState.motion) return;
  lights.reset();
  mixerUi.clearLights();
  lightsMotion = viewState.motion;
  lightsActive = true;
  lightsPaused = false;
  if (lightsRafId === null) lightsRafId = requestAnimationFrame(lightsTick);
}

/** Ends the loop and takes every light to unlit. Does nothing to the document when the lights were not running. */
function stopLights() {
  if (lightsRafId !== null) {
    cancelAnimationFrame(lightsRafId);
    lightsRafId = null;
  }
  if (!lightsActive) return;
  lightsActive = false;
  lights.reset();
  mixerUi.clearLights();
}

/** One animation frame of the lights: the notes heard by now light their tracks, and only the lights that changed are written. */
function lightsTick(ts) {
  lightsRafId = null;
  if (!lightsActive) return;
  try {
    const cps = editor.repl.scheduler.cps;
    if (!usableTempo(cps)) {
      // The tempo is 0 (or not a number) for now: draw nothing, take lit lights dark once and keep the loop for when it returns.
      if (!lightsPaused) {
        lightsPaused = true;
        lights.reset();
        mixerUi.clearLights();
      }
      lightsRafId = requestAnimationFrame(lightsTick);
      return;
    }
    if (lightsPaused) {
      // The tempo is back: notes queued while it was 0 are not worth a blink.
      lightsPaused = false;
      lights.reset();
    }
    // One read of the audio context's output timestamp serves every note of this frame.
    const audio = globalThis.getAudioContext();
    const pair = readOutputPair(audio);
    if (pair === null && !lightsPairWarned) {
      lightsPairWarned = true;
      console.warn("Moontide: this browser has no getOutputTimestamp, so the Mixer lights time a note from the audio clock and the context's reported latencies.");
    }
    const toPerf = heardMapper({
      pair,
      currentTime: audio.currentTime,
      baseLatency: audio.baseLatency,
      outputLatency: audio.outputLatency,
      perfNow: performance.now(),
    });
    const changes = lights.frame(ts, { motion: lightsMotion, cps, toPerf });
    if (changes.length > 0) mixerUi.setLights(changes, lightsMotion);
  } catch (err) {
    // Once: the lights end here, and the music is not touched.
    lightsBroken = true;
    console.error('Moontide: the Mixer lights stopped:', err);
    stopLights();
    return;
  }
  lightsRafId = requestAnimationFrame(lightsTick);
}

// A hidden tab draws nothing and drops its notes; coming back, every light starts unlit.
document.addEventListener('visibilitychange', () => syncLights());

// The first render never came from a keydown (nothing changed relative to a prior viewState),
// so it must be triggered explicitly — sets the initial data-layout/data-view/data-motion
// attributes and opens the Timeline if a view was remembered from a previous session.
// The lights may touch the view state and the Mixer from here on: both exist.
lightsViewReady = true;
renderViews();

/**
 * The lines #song-notes shows for a reading: none unless the song is read, else the helper line (when the helper is not the
 * canonical text) and then the line of the check when this version has one. A line is a string, or `{ text, kind }`.
 */
function songNoteEntries(reading) {
  if (reading.state !== 'read') return [];
  const entries = [...songNoteLines(reading)];
  if (songCheck !== null && songCheck.generation === songVersion && songCheck.entry !== null) entries.push(songCheck.entry);
  return entries;
}

/** The line a finished check gives, or null when what plays agrees with the declaration. */
function songCheckEntry(answer) {
  if (answer.state === 'differs') return differsLine({ ...answer.first, more: answer.more });
  if (answer.state === 'failed' || answer.state === 'too-slow') return { text: SONG_COPY.checkFailed, kind: 'check-failed' };
  return null;
}

/**
 * Checks, after the version has settled, what its tracks really play at the start of every section entry against what the
 * song declares, without blocking the music and whether or not the Parts view is open. The answer of an overtaken version is
 * dropped. A difference or a failed check is shown in #song-notes and sent to Claude with the helper line of the version;
 * agreement says nothing. `evaluateId` is the evaluate id captured when the version started.
 */
async function runSongCheck(generation, code, reading, evaluateId) {
  await sleep(TIMELINE_SETTLE_MS);
  if (songVersion !== generation) return;
  let answer;
  try {
    const parse = window.acorn.parse;
    answer = await checkSections({
      reading,
      starts: sectionStarts(reading),
      playedPattern: (track) => evaluateSolo(soloSource(code, track.index, { parse })),
      declared: () => evaluateDeclared(expectedSource(code, reading, { parse })),
      budgetMs: TIMELINE_BUDGET_MS,
      clock: () => performance.now(),
      yieldToPage: () => new Promise((resolve) => setTimeout(resolve, 0)),
      isCancelled: () => songVersion !== generation,
    });
  } catch (err) {
    answer = { state: 'failed', message: err instanceof Error ? err.message : String(err), ms: 0 };
  }
  if (answer.state === 'cancelled' || songVersion !== generation) return;
  if (answer.state === 'failed') console.error('Moontide: the check of the song declaration failed:', answer.message);
  if (answer.state === 'too-slow') console.error(`Moontide: the check of the song declaration ran over its ${TIMELINE_BUDGET_MS} ms budget (${Math.round(answer.ms)} ms).`);
  const entry = songCheckEntry(answer);
  songCheck = { generation, entry };
  songNotesEl.dataset.check = answer.state === 'agrees' || answer.state === 'differs' ? answer.state : 'failed';
  songNotesEl.dataset.checkMs = String(Math.round(answer.ms));
  songUi.showNotes(songNoteEntries(reading));
  if (entry !== null) {
    sendStructureNote([...songNoteLines(reading), typeof entry === 'string' ? entry : entry.text], evaluateId);
  }
}

/**
 * Asks, after the song check of the same version has answered (so the two queries never run at once), which pitch classes
 * each fixed variation plays in each of its first cycles, and keeps the answer for the grid. It reads the code's own
 * constants and never calls its play() helper; a variation it cannot read, or reads too slowly, is a visible reason in the
 * grid. The answer of an overtaken version is dropped. It changes nothing in the code or the music.
 */
async function runSongFit(generation, code, reading) {
  if (songVersion !== generation) return;
  const isCancelled = () => songVersion !== generation;
  const pairs = fitPairs(reading);
  let answer;
  try {
    const patterns = await evaluateFit(fitSource(code, reading, { parse: window.acorn.parse }));
    if (isCancelled()) return;
    answer = await collectFit({
      patterns,
      pairs,
      cycles: Math.max(...reading.sections.map((section) => section.length)),
      budgetMs: TIMELINE_BUDGET_MS,
      clock: () => performance.now(),
      yieldToPage: () => new Promise((resolve) => setTimeout(resolve, 0)),
      isCancelled,
    });
  } catch (err) {
    console.error('Moontide: the page could not read the notes of the fixed variations:', err);
    answer = { state: 'ready', byPair: new Map(pairs.map((pair) => [pairKey(pair.track, pair.key), { reason: 'not-read' }])), failures: [] };
  }
  if (answer.state === 'cancelled' || isCancelled()) return;
  for (const failure of answer.failures) {
    console.error(`Moontide: the page could not read the notes of variation '${String(failure.key)}' of track '${String(failure.track)}': ${failure.message}`);
  }
  songFit = { generation, reading, answer: answer.byPair };
  // The grid is drawn again once with the answer, when the Parts view shows the grid of this very reading.
  if (viewState.view === 'parts' && songGridReading === reading) drawSongGrid();
}

/** Called from trackEvalSuccess right where hasEvaluatedSuccessfully becomes true —
 * every new version that plays bumps the generation and, if the Timeline is open, recomputes it. */
function onVersionPlaying() {
  timelineGeneration++;
  songVersion++;
  // The song structure of the version that plays, read once; a code the parser cannot read counts as a piece without one.
  songReading = null;
  if (window.acorn && typeof window.acorn.parse === 'function') {
    const code = playingCode();
    try {
      const parse = window.acorn.parse;
      songReading = { generation: songVersion, code, reading: readStructure(code, { parse, tracks: extractTracks(code, { parse }) }) };
    } catch (err) {
      console.error('Moontide: failed to read the song structure of the playing code:', err);
    }
  }
  const reading = songReading === null ? { state: 'none' } : songReading.reading;
  // The Parts view is called Song while the code declares a song (readable or not), and Parts otherwise.
  setViewTitle('parts', reading.state === 'none' ? VIEW_TITLES.parts : SONG_COPY.viewTitle);
  if (reading.state !== 'none' || structureNoteSent) sendStructureNote(songNoteLines(reading));
  // The old answer of the check goes with the old version; the new one is shown when it arrives.
  songCheck = null;
  if (reading.state === 'read') {
    songNotesEl.dataset.check = 'pending';
    delete songNotesEl.dataset.checkMs;
  } else {
    delete songNotesEl.dataset.check;
    delete songNotesEl.dataset.checkMs;
  }
  songUi.showNotes(songNoteEntries(reading));
  songFit = null;
  if (reading.state === 'read') {
    const generation = songVersion;
    const { code } = songReading;
    // The fit words come after the check of the declaration has answered, so the two queries never run at once.
    const checked = runSongCheck(songVersion, songReading.code, reading, playingEvaluateId).catch((err) => {
      console.error('Moontide: the check of the song declaration failed:', err);
    });
    if (fitPairs(reading).length > 0) {
      void checked.then(() => runSongFit(generation, code, reading)).catch((err) => {
        console.error('Moontide: the fit of the fixed variations failed:', err);
      });
    }
  }
  // The shared reading belongs to one version: a new one empties the preparation, the page cache
  // and the pages in flight (the Jam view drops its reading and shows the reading message until the new one is built).
  readingVersion++;
  readingPreparation = null;
  timelineTracks = null;
  timelineCode = null;
  timelineParse = null;
  timelineIndex = null;
  timelinePlaces = { patterns: new Map(), answers: new Map() };
  timelineCache = new Map();
  timelinePending = new Map();
  versionPlayingAt = performance.now();
  pendingLaunch = null;
  // A new version can move the sections a countdown or a refusal counted on.
  gridAlready = null;
  gridRefused = null;
  if (viewState.view === 'timeline') {
    void refreshTimeline().catch((err) => {
      console.error('Moontide: failed to refresh the Timeline:', err);
      renderTimelineMessage(TIMELINE_COPY.failed, 'failed');
    });
  }
  if (viewState.view === 'parts') {
    renderParts();
  }
  // After every live tick and every new version the strips follow the playing code.
  if (viewState.view === 'mixer') {
    renderMixer();
  }
  renderInstrumentsIfOpen();
  if (viewState.view === 'jam') {
    // The reading on screen describes the old code: its countdowns, warnings and ask context must not
    // pass for the new music's, so it goes at once and the message stands until the new one is built.
    jamReading = null;
    jamStuck = null;
    jamUi.showMessage(JAM_COPY.reading);
    void refreshJam().catch(reportJamRefreshError);
  }
}

/** Sets the message row's text and the view's data-state, and hides the whole ruler/lanes/
 * playhead body — the shared shape for "nothing playing", "computing" and "failed" (never a
 * partial lane draw). */
function renderTimelineMessage(text, state) {
  // Hiding the body takes the keyboard focus away from the lanes; the lanes get it back when they are drawn again, so a person
  // who edits a note with the keys can go on with the keys.
  if (document.activeElement === timelineLanes) timelineLanesWantFocus = true;
  timelineView.dataset.state = state;
  delete timelineView.dataset.computeMs;
  delete timelineView.dataset.longestSliceMs;
  timelineMessage.textContent = text;
  timelineMessage.hidden = false;
  timelineBody.hidden = true;
  timelineDrawn = null;
  timelineLanes.replaceChildren();
  timelineRuler.replaceChildren();
  timelineSections.replaceChildren();
  timelineEditUi.onRedraw(null);
}

/** Builds the ruler's labeled cycle-number marks (every 4 cycles) for the page starting at
 * `pageStart`, positioned as a percentage of the track column's own width. */
function renderRuler(pageStart) {
  const nodes = rulerMarks(pageStart)
    .filter((mark) => mark.labeled)
    .map((mark) => {
      const el = document.createElement('span');
      el.className = 'ruler-tick';
      el.style.left = `${(mark.x / PAGE_CYCLES) * 100}%`;
      el.textContent = String(mark.cycle);
      return el;
    });
  timelineRuler.replaceChildren(...nodes);
}

/**
 * Builds the `arrange()` section row(s) above the lanes for the page starting at `pageStart`,
 * from the same code (`timelineCode`/`timelineParse`) the drawn page's lanes came from — so the
 * Timeline's own section markers always agree with what the lanes just proved plays.
 * One `.section-row` per arrangement, gutter reading
 * the owner track's name when there are two or more rows, else 'arrange()'. Empty with no
 * arrangement in the code, or when the code can no longer be parsed (never throws: shares the
 * lanes' own "never show something false" guarantee by simply drawing nothing extra).
 */
function renderSections(pageStart) {
  let tracksForSections;
  let arrangements;
  try {
    tracksForSections = extractTracks(timelineCode, { parse: timelineParse });
    arrangements = extractArrangements(timelineCode, { parse: timelineParse, tracks: tracksForSections });
  } catch (err) {
    console.error('Moontide: failed to parse the playing code for the Timeline section row:', err);
    timelineSections.replaceChildren();
    return;
  }
  if (arrangements.length === 0) {
    timelineSections.replaceChildren();
    return;
  }
  const showOwnerName = arrangements.length >= 2;
  const rowNodes = arrangements.map((arrangement) => {
    const rowEl = document.createElement('div');
    rowEl.className = 'section-row';

    const gutterEl = document.createElement('span');
    gutterEl.className = 'section-row-gutter';
    let gutterText = 'arrange()';
    if (showOwnerName) {
      const ownerTrack = arrangement.owner !== null ? tracksForSections.find((track) => track.index === arrangement.owner) : undefined;
      gutterText = ownerTrack ? ownerTrack.name : `arrange() ${arrangement.index + 1}`;
    }
    gutterEl.textContent = gutterText;
    gutterEl.title = gutterText;
    rowEl.appendChild(gutterEl);

    const trackEl = document.createElement('div');
    trackEl.className = 'section-track';
    for (const span of sectionSpans(arrangement, pageStart)) {
      const spanEl = document.createElement('span');
      spanEl.className = 'section-span';
      spanEl.style.left = `${(span.x / PAGE_CYCLES) * 100}%`;
      spanEl.style.width = `${(span.width / PAGE_CYCLES) * 100}%`;
      spanEl.textContent = span.name;
      spanEl.title = span.name;
      spanEl.dataset.part = span.name;
      if (showOwnerName) spanEl.dataset.owner = gutterText;
      trackEl.appendChild(spanEl);
    }
    rowEl.appendChild(trackEl);
    return rowEl;
  });
  timelineSections.replaceChildren(...rowNodes);
  // After layout: a span too narrow for its name shows no text (title tooltip still carries the
  // full name) rather than an illegibly clipped fragment.
  markNarrowSpans();
}

/** Builds one `div.lane` per track: a `span.lane-name` (textContent + title, so an
 * ellipsis-truncated name still has its full text on hover) and an SVG holding one
 * `rect.event` per event, positioned/sized in cycle units against the 32-cycle page. Never
 * builds a node from an HTML string (track/part names can be Claude- or user-authored text). */
const SVG_NS = 'http://www.w3.org/2000/svg';
// A note mark occupies NOTE_MARK_HEIGHT of a lane's own SVG height (viewBox 0 0 32 1), the share page/timeline-gesture.js
// also uses to find the note under a press; a tick (no pitch) always spans the full lane height instead.

/** The MIDI tracks of the code the lanes were read from: `tags`, identity -> midiTag (the same formatter as
 * the Mixer strip, so the two views always agree), `midi`, the identities of every MIDI track even when its
 * port cannot be read, and `drums`, identity -> `{ use }` for every track on a rhythm channel of a rig instrument
 * (`use` is what drumMapFor says: a known map, or unknown); all empty when the code cannot be read. */
function laneTags() {
  const tags = new Map();
  const midi = new Set();
  const drums = new Map();
  if (timelineCode === null || timelineParse === null) return { tags, midi, drums };
  const read = readMidiTracks(timelineCode, { parse: timelineParse, rig: pageRig });
  if (!read.ok) return { tags, midi, drums };
  for (const [identity, track] of read.tracks) {
    midi.add(identity);
    const tag = midiTag(track);
    if (tag === null) continue;
    const channel = track.spine.channel;
    const onRhythm =
      track.instrument !== null && channel !== null && track.instrument.channels.some((entry) => entry.channel === channel && entry.role === 'rhythm');
    if (onRhythm) {
      const use = drumMapFor(track.instrument, track.spine.sound);
      drums.set(identity, { use });
      // Only the Timeline's tag says it; the Mixer strip keeps its own title.
      if (use.state === 'unknown') tag.title += TIMELINE_COPY.drumMapUnknown;
    }
    tags.set(identity, tag);
  }
  return { tags, midi, drums };
}

/** `span.lane-tag` with the name part (ellipsized) and the channel part (never shrinks); text and title only. */
function laneTagElement(tag) {
  const tagEl = document.createElement('span');
  tagEl.className = 'lane-tag';
  tagEl.title = tag.title;
  const nameEl = document.createElement('span');
  nameEl.className = 'lane-tag-name';
  nameEl.textContent = tag.name;
  const channelEl = document.createElement('span');
  channelEl.className = 'lane-tag-channel';
  channelEl.textContent = tag.channel;
  tagEl.appendChild(nameEl);
  tagEl.appendChild(channelEl);
  return tagEl;
}

/** A new rig message: when the Timeline shows a cached page, draw it again so its tags follow instruments.json. */
function redrawTimelineForRig() {
  if (viewState.view !== 'timeline' || timelineTracks === null || timelineDrawnPageStart === null) return;
  const cached = timelineCache.get(timelineDrawnPageStart);
  if (cached) renderTimelineResult(cached, timelineDrawnPageStart, timelineTracks);
}

/** Builds one `div.lane` per track: a `.lane-gutter` holding `.lane-name` plus `.lane-sub` (the
 * loop label, empty when the lane has no detected loop; the filter name follows it),
 * and an SVG holding one `rect.event[data-kind]` per event plus a `line.loop-mark` at every
 * repeat inside the page. `data-color`/`data-muted` drive the lane's own CSS. Never builds a
 * node from an HTML string (track/part names can be Claude- or user-authored text). */
function renderLanes(lanes, pageStart, tracks) {
  const { tags: midiTags, midi: midiIdentities, drums: drumUses } = laneTags();
  const drawnLanes = [];
  const laneNodes = lanes.map((lane) => {
    const track = tracks.find((t) => t.index === lane.index);
    const laneEl = document.createElement('div');
    laneEl.className = 'lane';
    laneEl.dataset.events = String(lane.events.length);
    laneEl.dataset.color = String(trackColors.colorOf(track.identity));
    laneEl.dataset.track = track.identity;
    if (track.muted) laneEl.dataset.muted = 'true';
    if (lane.events.length > 0) {
      laneEl.dataset.firstBegin = String(Math.min(...lane.events.map((event) => event.begin)));
    }

    const gutterEl = document.createElement('div');
    gutterEl.className = 'lane-gutter';

    const nameEl = document.createElement('span');
    nameEl.className = 'lane-name';
    nameEl.textContent = track.displayName ?? track.name;
    nameEl.title = track.displayName ?? track.name;

    // A lane's own moving filter control (if any) is ignored when looking for a note
    // loop underneath it — a slow filter sweep must never hide a real note repeat.
    const period = loopPeriod(lane.events, pageStart, track.curve ? [track.curve.control] : []);
    const subEl = document.createElement('span');
    subEl.className = 'lane-sub';
    subEl.textContent = [track.curve ? track.curve.filter : null, loopLabel(period)].filter(Boolean).join(' · ');

    gutterEl.appendChild(nameEl);
    const tag = midiTags.get(track.identity);
    if (tag !== undefined) gutterEl.appendChild(laneTagElement(tag));
    gutterEl.appendChild(subEl);
    // A rhythm lane whose map is known is drawn as one named row per drum note of this page.
    const drumUse = drumUses.get(track.identity);
    const known = drumUse !== undefined && drumUse.use.state === 'known' ? drumUse.use.map : null;
    const plan = known === null ? null : drumLane(lane.events, pageStart, known);
    // What a moment reads: the lane as shown (the name equals the right-click's lane context).
    const drawnLane = {
      track: track.displayName ?? track.name,
      midi: midiIdentities.has(track.identity),
      instrument: tag === undefined ? null : tag.text,
      events: lane.events,
      drumMap: known === null ? null : { name: known.name, byNote: new Map(known.notes.map((entry) => [entry.note, entry.name])) },
      // What the editable Timeline needs beside what a moment reads: the track the lane belongs to, the shapes the lane is drawn
      // from (one for each event, in the order of the events) and the number of drum rows (null for a lane that is not drums).
      index: track.index,
      identity: track.identity,
      shapes: plan === null ? laneShapes(lane.events, pageStart) : plan.shapes,
      rowCount: plan === null ? null : plan.rows.length,
    };
    drawnLanes.push(drawnLane);

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'lane-events');
    svg.setAttribute('viewBox', `0 0 ${PAGE_CYCLES} 1`);
    svg.setAttribute('preserveAspectRatio', 'none');

    if (plan !== null) {
      laneEl.dataset.drumRows = plan.rowsAttr;
      svg.setAttribute('role', 'img');
      svg.setAttribute('aria-label', plan.ariaLabel);
      const rowCount = plan.rows.length;
      for (const shape of plan.shapes) {
        const rect = document.createElementNS(SVG_NS, 'rect');
        rect.setAttribute('class', 'event');
        rect.setAttribute('data-kind', 'note');
        rect.setAttribute('data-row', String(shape.row));
        rect.setAttribute('x', String(shape.x));
        rect.setAttribute('width', String(shape.width));
        rect.setAttribute('y', String((shape.row + 0.25) / rowCount));
        rect.setAttribute('height', String(0.5 / rowCount));
        svg.appendChild(rect);
      }
    }
    for (const shape of plan === null ? drawnLane.shapes : []) {
      const rect = document.createElementNS(SVG_NS, 'rect');
      rect.setAttribute('class', 'event');
      rect.setAttribute('data-kind', shape.kind);
      rect.setAttribute('x', String(shape.x));
      rect.setAttribute('width', String(shape.width));
      if (shape.kind === 'note') {
        const y = Math.max(0, Math.min(1 - NOTE_MARK_HEIGHT, shape.y - NOTE_MARK_HEIGHT / 2));
        rect.setAttribute('y', String(y));
        rect.setAttribute('height', String(NOTE_MARK_HEIGHT));
      } else {
        rect.setAttribute('y', '0');
        rect.setAttribute('height', '1');
      }
      svg.appendChild(rect);
    }

    if (period !== null && period >= 2 && period <= 16) {
      for (let x = period; x < PAGE_CYCLES; x += period) {
        const line = document.createElementNS(SVG_NS, 'line');
        line.setAttribute('class', 'loop-mark');
        line.setAttribute('x1', String(x));
        line.setAttribute('x2', String(x));
        line.setAttribute('y1', '0');
        line.setAttribute('y2', '1');
        svg.appendChild(line);
      }
    }

    if (track.curve) {
      const points = curvePoints(lane.events, track.curve.control, pageStart);
      if (points.length > 0) {
        const polyline = document.createElementNS(SVG_NS, 'polyline');
        polyline.setAttribute('class', 'lane-curve');
        polyline.setAttribute('points', points.map(([x, y]) => `${x},${y}`).join(' '));
        svg.appendChild(polyline);
      }
    }

    // Tooltips: one transparent band per row, drawn last so it covers its whole row over the marks and loop lines.
    if (plan !== null) {
      plan.rows.forEach((row, index) => {
        const band = document.createElementNS(SVG_NS, 'rect');
        band.setAttribute('class', 'drum-band');
        band.setAttribute('x', '0');
        band.setAttribute('width', String(PAGE_CYCLES));
        band.setAttribute('y', String(index / plan.rows.length));
        band.setAttribute('height', String(1 / plan.rows.length));
        const title = document.createElementNS(SVG_NS, 'title');
        title.textContent = row.tooltip;
        band.appendChild(title);
        svg.appendChild(band);
      });
    }

    laneEl.appendChild(gutterEl);
    laneEl.appendChild(svg);
    if (plan !== null && plan.showLabels) {
      const labelsEl = document.createElement('div');
      labelsEl.className = 'lane-drums';
      labelsEl.setAttribute('aria-hidden', 'true');
      for (const row of plan.rows) {
        const labelEl = document.createElement('span');
        labelEl.className = row.numbered ? 'drum-row-label drum-row-number' : 'drum-row-label';
        labelEl.textContent = row.label;
        labelsEl.appendChild(labelEl);
      }
      laneEl.appendChild(labelsEl);
    }
    return laneEl;
  });
  timelineLanes.dataset.pageStart = String(pageStart);
  timelineDrawn = { pageStart, lanes: drawnLanes, version: currentVersionId, generation: timelineGeneration };
  timelineLanes.replaceChildren(...laneNodes);
  timelineEditUi.onRedraw(timelineDrawn);
}

/** Applies a computeTimeline() result: draws the lanes on 'ok'; shows the too-slow or failed
 * line (logging the reason for every failed result) on 'too-slow'/'failed'; renders nothing
 * at all on 'cancelled' — a newer version is already computing its own result. */
function renderTimelineResult(result, pageStart, tracks) {
  if (result.state === 'ok') {
    timelineView.dataset.state = 'ok';
    timelineView.dataset.computeMs = String(result.computeMs);
    timelineView.dataset.longestSliceMs = String(result.longestSliceMs);
    timelineMessage.hidden = true;
    timelineBody.hidden = false;
    renderRuler(pageStart);
    renderSections(pageStart);
    renderLanes(result.lanes, pageStart, tracks);
    if (timelineLanesWantFocus) {
      timelineLanesWantFocus = false;
      timelineLanes.focus({ preventScroll: true });
    }
    return;
  }
  if (result.state === 'too-slow') {
    renderTimelineMessage(TIMELINE_COPY.tooSlow, 'too-slow');
    return;
  }
  if (result.state === 'failed') {
    console.error('Moontide: timeline computation failed:', result.reason, result);
    renderTimelineMessage(TIMELINE_COPY.failed, 'failed');
    return;
  }
  // 'cancelled': render nothing — a newer version's own refreshTimeline() is already in flight.
}

/** Stops the Timeline's own requestAnimationFrame loop (it runs only while the Timeline is open). Safe to call when it isn't running. */
function stopTimelineLoop() {
  if (timelineRafId !== null) {
    cancelAnimationFrame(timelineRafId);
    timelineRafId = null;
  }
}

/** Starts the loop if it isn't already running (refreshTimeline always calls stopTimelineLoop
 * first, so at most one loop ever runs at a time). */
function startTimelineLoop() {
  if (timelineRafId !== null) return;
  timelineRafId = requestAnimationFrame(timelineTick);
}

/** Returns the computeTimeline() result for `pageStart`, for the CURRENT version's own tracks/
 * code/parser: the cached 'ok' result, the result of the same page already being computed for
 * this generation, or a new background computation. Used by the Timeline (renders its result when
 * done, if still the drawn page), by the Jam view (reads it) and to prefetch the next page
 * silently (only caches). When a computation started for an older generation is still running
 * for the page, it is waited for first (it ends as 'cancelled' at its next check) and a fresh one
 * starts after it. Resolves to { state: 'cancelled' } when the generation changed meanwhile.
 * Never caches a too-slow/failed result, so a later visit to that page retries instead of
 * repeating a stale failure forever. */
async function computePage(pageStart, generation) {
  const cached = timelineCache.get(pageStart);
  if (cached) return cached;
  const pending = timelinePending.get(pageStart);
  if (pending) {
    if (pending.generation === generation) return pending.promise;
    await pending.promise;
    if (timelineGeneration !== generation) return { state: 'cancelled' };
    return computePage(pageStart, generation);
  }
  if (timelineGeneration !== generation || timelineTracks === null) return { state: 'cancelled' };
  const entry = { generation, promise: null };
  timelinePending.set(pageStart, entry);
  entry.promise = runPageQuery(pageStart, generation, entry, timelineTracks, timelineCode, timelineParse);
  return entry.promise;
}

async function runPageQuery(pageStart, generation, entry, tracks, code, parse) {
  let result;
  try {
    result = await computeTimeline({
      tracks,
      soloPattern: (track) => evaluateSolo(soloSource(code, track.index, { parse })),
      combinedPattern: playingPattern(),
      pageStart,
      pageCycles: PAGE_CYCLES,
      budgetMs: TIMELINE_BUDGET_MS,
      sliceCycles: TIMELINE_SLICE_CYCLES,
      clock: () => performance.now(),
      yieldToPage: () => new Promise((resolve) => setTimeout(resolve, 0)),
      isCancelled: () => timelineGeneration !== generation,
    });
  } finally {
    if (timelinePending.get(pageStart) === entry) timelinePending.delete(pageStart);
  }
  if (timelineGeneration !== generation) return { state: 'cancelled' };
  if (result.state === 'ok') {
    timelineCache.set(pageStart, result);
  }
  if (timelineDrawnPageStart === pageStart && viewState.view === 'timeline' && result.state !== 'cancelled') {
    renderTimelineResult(result, pageStart, tracks);
  }
  return result;
}

/** Marks `pageStart` as the page being drawn and shows it: instantly from the cache when
 * already prefetched (the page turns with little motion: a cut, not a
 * wait, whenever the prefetch already finished), otherwise "Computing timeline…" until
 * computePage's own result lands. */
function drawPage(pageStart, generation) {
  timelineDrawnPageStart = pageStart;
  timelineView.dataset.pageStart = String(pageStart);
  const cached = timelineCache.get(pageStart);
  if (cached) {
    renderTimelineResult(cached, pageStart, timelineTracks);
    return;
  }
  renderTimelineMessage(TIMELINE_COPY.computing, 'computing');
  void computePage(pageStart, generation);
}

/** Sets the playhead's left offset (a percentage of the track column), its cycle label — one
 * decimal with motion on, a whole number with motion off — and the side of the line the label is
 * drawn on, touching the DOM only when a shown value actually changes. */
function updatePlayhead(now) {
  const pageStart = timelineDrawnPageStart ?? pageStartOf(now);
  const cycle = playheadCycle(now, viewState.motion);
  const leftPct = `${((cycle - pageStart) / PAGE_CYCLES) * 100}%`;
  if (leftPct !== timelinePlayheadLeftShown) {
    timelinePlayhead.style.left = leftPct;
    timelinePlayheadLeftShown = leftPct;
  }
  const label = viewState.motion === 'off' ? String(Math.floor(cycle)) : cycle.toFixed(1);
  if (label !== timelinePlayheadLabelShown) {
    timelinePlayheadCycleEl.textContent = label;
    timelinePlayheadLabelShown = label;
  }
  // The reading flips to the left of the line when it would pass the track column's right edge
  // (the ruler spans the column exactly). Measured every frame: a layout key or a window resize
  // changes the column width without moving the playhead's percentage. Written only on a change.
  const side = playheadReadingSide(
    timelinePlayhead.getBoundingClientRect().right,
    timelinePlayheadCycleEl.getBoundingClientRect().width,
    timelineRuler.getBoundingClientRect().right,
  );
  if (side !== timelinePlayheadSideShown) {
    timelinePlayhead.dataset.readingSide = side;
    timelinePlayheadSideShown = side;
  }
}

/** One frame of the Timeline's own animation loop: turns the page when
 * the playhead crosses into a new one, starts prefetching the next page once past
 * PREFETCH_FROM_CYCLE, and moves the playhead. Stops itself (returns without scheduling another
 * frame) once the Timeline is no longer open. */
function timelineTick() {
  timelineRafId = null;
  if (viewState.view !== 'timeline' && viewState.view !== 'parts') return;
  if (viewState.view === 'timeline' && timelineTracks) {
    const generation = timelineGeneration;
    const rawNow = editor.repl.scheduler.now();
    const now = Number.isFinite(rawNow) && rawNow > 0 ? rawNow : 0;
    const pageStart = pageStartOf(now);
    if (pageStart !== timelineDrawnPageStart) {
      drawPage(pageStart, generation);
    }
    if (now - pageStart >= PREFETCH_FROM_CYCLE) {
      void computePage(pageStart + PAGE_CYCLES, generation);
    }
    updatePlayhead(now);
  }
  if (viewState.view === 'parts') {
    updatePartsLive();
    updateSongGridLive();
  }
  timelineRafId = requestAnimationFrame(timelineTick);
}

/**
 * (Re)starts the Timeline for the code that is actually playing — called when the
 * Timeline is freshly opened and on every new version while it stays open. Never queries before
 * the first successful evaluation (activeCode is still Strudel's '// LOADING' placeholder before
 * then) or when the pinned acorn parser or any labeled track is missing — those show their
 * matching TIMELINE_COPY line instead of a query attempt. Drops its own result if a newer
 * version started playing while it was computing (this whole chain carries its own
 * .catch, wired at each call site above).
 */
async function refreshTimeline() {
  const generation = timelineGeneration;
  stopTimelineLoop();
  timelineDrawnPageStart = null;
  timelinePlayheadLeftShown = null;
  timelinePlayheadLabelShown = null;
  timelinePlayheadSideShown = null;

  if (!hasEvaluatedSuccessfully) {
    renderTimelineMessage(TIMELINE_COPY.nothingPlaying, 'empty');
    return;
  }
  renderTimelineMessage(TIMELINE_COPY.computing, 'computing');
  const status = await prepareReading();
  if (timelineGeneration !== generation) return;
  if (status === 'empty') {
    renderTimelineMessage(TIMELINE_COPY.nothingPlaying, 'empty');
    return;
  }
  if (status === 'failed') {
    renderTimelineMessage(TIMELINE_COPY.failed, 'failed');
    return;
  }
  if (status === 'stale') return;

  const rawNow = editor.repl.scheduler.now();
  const now = Number.isFinite(rawNow) && rawNow > 0 ? rawNow : 0;
  const pageStart = pageStartOf(now);
  drawPage(pageStart, generation);
  startTimelineLoop();
}

/**
 * The non-rendering half of starting the Timeline, shared with the Jam view and memoized per
 * readingVersion so they read one preparation. Never queries before the first successful
 * evaluation (activeCode is still Strudel's '// LOADING' placeholder before then) or when the
 * pinned acorn parser or any labeled track is missing. Waits out TIMELINE_SETTLE_MS from the moment
 * the version started, so every .timeline(id) anchor the new version writes has landed. Sets
 * timelineTracks/timelineCode/timelineParse for the version and resolves to 'ready', 'empty'
 * (nothing evaluated yet), 'failed' (logged to the console) or 'stale' (a newer version started
 * while it waited).
 */
function prepareReading() {
  if (readingPreparation !== null && readingPreparation.version === readingVersion) {
    return readingPreparation.promise;
  }
  const version = readingVersion;
  const promise = preparationFor(version);
  readingPreparation = { version, promise };
  return promise;
}

async function preparationFor(version) {
  if (!hasEvaluatedSuccessfully) return 'empty';
  if (!window.acorn || typeof window.acorn.parse !== 'function') {
    console.error('Moontide: window.acorn is not available — the pinned parser script did not load.');
    return 'failed';
  }
  const parse = window.acorn.parse;
  const code = playingCode();
  let tracks;
  try {
    tracks = extractTracks(code, { parse });
  } catch (err) {
    console.error('Moontide: failed to parse the playing code for the Timeline:', err);
    return 'failed';
  }
  if (tracks.length === 0) return 'failed';

  const elapsedSinceVersion = performance.now() - versionPlayingAt;
  if (elapsedSinceVersion < TIMELINE_SETTLE_MS) {
    await sleep(TIMELINE_SETTLE_MS - elapsedSinceVersion);
  }
  if (readingVersion !== version) return 'stale';

  timelineTracks = tracks;
  timelineCode = code;
  timelineParse = parse;
  return 'ready';
}

// --- the Jam view ---

// Records a failed reading of `version` and `pageStart` (null: the whole version); `slow` for a query that
// ran out of time, the one failure worth a retry.
function stickJam(version, pageStart, slow) {
  jamStuck = jamStuckFor({ previous: jamStuck, version, pageStart, slow, now: performance.now() });
}

/**
 * An exception while building the reading (the events, the parts, the analysis or a rejected page
 * query): says it once, drops the reading and sticks, exactly like a handled failure, so the 250 ms
 * tick retries only after a new version, a new page or a reopened view instead of throwing the
 * same error four times a second. `version` is the readingVersion the failed build was for: when a
 * newer version has started since, the newer build owns the screen and this error only logs.
 */
function reportJamRefreshError(err, version = readingVersion) {
  console.error('Moontide: failed to refresh the Jam view:', err);
  if (version !== readingVersion || viewState.view !== 'jam') return;
  let pageStart = null; // the whole version, when even the playing position cannot be read
  try {
    pageStart = pageStartOf(jamPosition().cycle);
  } catch (positionErr) {
    console.error('Moontide: the Jam view could not read the playing position:', positionErr);
  }
  jamReading = null;
  stickJam(version, pageStart, false);
  jamUi.showMessage(JAM_COPY.failed);
}

/** The playing position the Jam view reads: the clamped scheduler clock while sound plays
 * (remembered), else the last cycle that played (the reading stays where the music stopped),
 * else the clamped clock. */
function jamPosition() {
  const playing = currentSoundState === 'playing';
  const rawNow = editor.repl.scheduler.now();
  const now = Number.isFinite(rawNow) && rawNow > 0 ? rawNow : 0;
  if (playing) {
    jamLastPlayingCycle = now;
    return { cycle: now, playing };
  }
  return { cycle: jamLastPlayingCycle ?? now, playing };
}

/**
 * Builds the reading for the page of the playing position and the page after it, from the same
 * pages the Timeline draws (never a query of its own), and renders it. At most one runs at a time;
 * a request while one runs makes it run once more after. A new version drops the old reading at
 * once (onVersionPlaying), so the screen never shows the old music's warnings for the new music.
 */
async function refreshJam() {
  if (jamRefreshRunning) {
    jamRefreshAgain = true;
    return;
  }
  jamRefreshRunning = true;
  try {
    do {
      jamRefreshAgain = false;
      const version = readingVersion;
      try {
        await refreshJamOnce();
      } catch (err) {
        reportJamRefreshError(err, version);
      }
    } while (jamRefreshAgain && viewState.view === 'jam');
  } finally {
    jamRefreshRunning = false;
  }
}

async function refreshJamOnce() {
  const version = readingVersion;
  const generation = timelineGeneration;
  if (jamReading === null) jamUi.showMessage(JAM_COPY.reading);
  const status = await prepareReading();
  if (readingVersion !== version || viewState.view !== 'jam') return;
  if (status === 'stale') return;
  if (status === 'empty' || status === 'failed') {
    jamReading = null;
    stickJam(version, null, false);
    jamUi.showMessage(status === 'empty' ? JAM_COPY.nothingPlaying : JAM_COPY.failed);
    return;
  }
  const pageStart = pageStartOf(jamPosition().cycle);
  const first = await computePage(pageStart, generation);
  if (readingVersion !== version || timelineGeneration !== generation || viewState.view !== 'jam') return;
  if (first.state === 'cancelled') return;
  if (first.state !== 'ok') {
    console.error('Moontide: the Jam view could not read the notes:', first);
    jamReading = null;
    stickJam(version, pageStart, first.state === 'too-slow');
    jamUi.showMessage(JAM_COPY.failed);
    return;
  }
  const second = await computePage(pageStart + PAGE_CYCLES, generation);
  if (readingVersion !== version || timelineGeneration !== generation || viewState.view !== 'jam') return;
  if (second.state === 'cancelled') return;
  // The page after the playing one is only the look-ahead: when it cannot be read the playing page still
  // gives the scale and the status, and the reading says it has no look-ahead (a too-slow page is tried again).
  const partial = second.state !== 'ok';
  if (partial) console.error('Moontide: the Jam view could not read the page after the playing one:', second);
  let arrangements;
  try {
    arrangements = extractArrangements(timelineCode, { parse: timelineParse, tracks: timelineTracks });
  } catch (err) {
    console.error('Moontide: the Jam view could not read the parts:', err);
    jamReading = null;
    stickJam(version, pageStart, false);
    jamUi.showMessage(JAM_COPY.failed);
    return;
  }
  // The harmony the code declares is read once per version, with the arrangements; the 250 ms tick never parses.
  let declared;
  try {
    declared = readHarmony(timelineCode, { parse: timelineParse });
  } catch (err) {
    console.error('Moontide: the Jam view could not read the harmony declaration:', err);
    jamReading = null;
    stickJam(version, pageStart, false);
    jamUi.showMessage(JAM_COPY.failed);
    return;
  }
  // The page before the window, when it is cached (the window of the previous page turn read it), adds
  // the notes that began there and still sound at the window start: a pad or drone must not vanish at
  // every page turn. It is never queried for: without it the reading only starts from the onsets.
  const before = timelineCache.get(pageStart - PAGE_CYCLES);
  // A MIDI drum line is numeric notes (drum-map keys), not pitches: the tracks on a rig rhythm channel are left out.
  // A track whose port cannot be read, or is not in the rig, is not found here and keeps counting.
  const { drums } = laneTags();
  const reading = buildReading({
    events: [...(before ? flattenLanes(before) : []), ...flattenLanes(first), ...(partial ? [] : flattenLanes(second))],
    windowStart: pageStart,
    windowLength: partial ? PAGE_CYCLES : 2 * PAGE_CYCLES,
    arrangements,
    tracks: timelineTracks,
    partial,
    declared,
    excludeTracks: drumTrackIndexes(timelineTracks, drums),
  });
  if (reading.status === 'too-dense') {
    console.error(`Moontide: the Jam view refused a reading of ${reading.count} pitched notes.`);
    jamReading = null;
    stickJam(version, pageStart, false);
    jamUi.showMessage(JAM_COPY.failed);
    return;
  }
  jamReading = { reading, version };
  if (partial) stickJam(version, pageStart, second.state === 'too-slow');
  else jamStuck = null;
  jamPrefetched = false;
  jamViewEl.dataset.pageStart = String(pageStart);
  jamViewEl.dataset.computeMs = String(first.computeMs);
  renderJam();
}

/** Renders the reading on screen at the current position: a lookup, never a rebuild. A tempo that
 * is not a finite positive number cannot give countdowns or follow the music, so it is said loudly
 * (once in the console) instead of guessed. */
function renderJam() {
  if (jamReading === null) return;
  const { cycle, playing } = jamPosition();
  const cps = editor.repl.scheduler.cps;
  if (typeof cps !== 'number' || !Number.isFinite(cps) || cps <= 0) {
    if (!jamTempoErrorLogged) {
      jamTempoErrorLogged = true;
      console.error(`Moontide: the Jam view needs a finite positive tempo, the scheduler reports ${String(cps)}.`);
    }
    jamUi.showMessage(JAM_COPY.failed);
    return;
  }
  jamTempoErrorLogged = false; // a later bad tempo is said again
  try {
    // A piece with sections shows the harmony of the section that plays (the first one while stopped, what Play starts
    // with); any other piece is drawn as it always was.
    const options = {};
    if (songReading !== null && songReading.generation === songVersion && songReading.reading.state === 'read') {
      const song = songReading.reading;
      const index = playing ? playingSection(song, cycle).index : 0;
      options.declaredOverride = sectionDeclared(song.sections[index], jamReading.reading.declared ?? { state: 'none' });
      options.section = quoted(song.sections[index].name);
    }
    jamUi.render(
      buildJamModel({
        position: readingAt(jamReading.reading, { cycle, cps, playing }),
        chordTones: viewState.jamChordTones === 'on',
        ...options,
      }),
    );
  } catch (err) {
    if (jamDrawErrorLoggedFor !== jamReading) {
      jamDrawErrorLoggedFor = jamReading;
      console.error('Moontide: the Jam view could not draw the reading:', err);
    }
    jamUi.showMessage(JAM_COPY.failed);
  }
}

/** The Jam view's 250 ms tick: asks for a rebuild when the reading is missing, belongs to an older
 * version or does not cover the playing page (also backwards, after Stop), otherwise only looks
 * the position up. Skips while the page is hidden and stops with the view. */
function jamPoll() {
  if (document.hidden || viewState.view !== 'jam') return;
  const { cycle } = jamPosition();
  const pageStart = pageStartOf(cycle);
  // A partial reading (no look-ahead) is rebuilt like a stale one, once its retry time has come.
  const stale =
    jamReading === null || jamReading.version !== readingVersion || jamReading.reading.windowStart !== pageStart || jamReading.reading.partial;
  if (stale) {
    const stuck = jamIsStuck(jamStuck, { version: readingVersion, pageStart, now: performance.now() });
    if (!stuck && !jamRefreshRunning) void refreshJam().catch(reportJamRefreshError);
  } else if (!jamPrefetched && cycle - jamReading.reading.windowStart >= PREFETCH_FROM_CYCLE) {
    // Late in the window's first page: read ahead the page a page turn will need (the Timeline's
    // own prefetch rule), so the turn rebuilds the reading from the cache and the look-ahead never
    // runs dry. A silent computation that only fills the cache.
    jamPrefetched = true;
    void computePage(jamReading.reading.windowStart + 2 * PAGE_CYCLES, timelineGeneration);
  }
  renderJam();
}

// --- the Parts view, and launching a part on the next cycle ---

/** Shows `text` in #parts-message and clears any drawn rows — the shared shape for "couldn't
 * read this code" and "no parts". Also drops the live card refs the animation loop updates, so a
 * stale reference from the previous code never gets touched after the rows are gone. */
function showPartsMessage(text) {
  partsMessage.textContent = text;
  partsMessage.hidden = false;
  partsRows.replaceChildren();
  partsCardRefs = [];
}

/** Builds one `.part-card` button for `section` (part `k` of `arrangement`), and returns the live
 * ref (`{ cardEl, stateEl, progressFillEl, arrangement, section, partIndex, signature, shownText,
 * shownWidth }`) updatePartsLive() updates in place every frame. `ownerName` is the row label the view
 * shows, or null; it rides on the card for the Ask Claude box. Starts idle; the first
 * updatePartsLive() call right after renderParts() builds the DOM sets the true initial state. */
function buildPartCard(arrangement, section, k, ownerName) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'part-card';
  button.dataset.part = section.name;
  if (ownerName !== null) button.dataset.owner = ownerName;
  const initialText = `Idle — ${section.length} cycles`;
  button.dataset.state = 'idle';

  const nameEl = document.createElement('span');
  nameEl.className = 'part-name';
  nameEl.textContent = section.name;
  nameEl.title = section.name;

  const stateEl = document.createElement('span');
  stateEl.className = 'part-state';
  stateEl.textContent = initialText;

  const progressEl = document.createElement('span');
  progressEl.className = 'part-progress';
  const progressFillEl = document.createElement('span');
  progressFillEl.className = 'part-progress-fill';
  progressEl.appendChild(progressFillEl);

  button.appendChild(nameEl);
  button.appendChild(stateEl);
  button.appendChild(progressEl);

  const signature = rowSignature(arrangement);
  button.addEventListener('click', () => {
    chain = chain.then(() => launchPart(signature, k)).catch((err) => reportChainError('part launch', err));
  });

  return {
    cardEl: button,
    stateEl,
    progressFillEl,
    arrangement,
    section,
    partIndex: k,
    signature,
    shownText: initialText,
    shownWidth: '0%',
  };
}

/** Builds one `.parts-row` (plus, when `showLabel` is true, a preceding `.parts-row-label` naming
 * the arrangement's owner track — or `arrange() N` when it has none) for `arrangement`. Returns
 * `{ nodes, cardRefs }`: `nodes` is every DOM node to append (label first, then the row);
 * `cardRefs` is one live ref per card, in section order. */
function buildPartsRow(arrangement, tracks, showLabel) {
  const nodes = [];
  let labelText = null;
  if (showLabel) {
    const ownerTrack = arrangement.owner !== null ? tracks.find((track) => track.index === arrangement.owner) : undefined;
    labelText = ownerTrack ? ownerTrack.name : `arrange() ${arrangement.index + 1}`;
    const labelEl = document.createElement('div');
    labelEl.className = 'parts-row-label';
    labelEl.textContent = labelText;
    labelEl.title = labelText;
    nodes.push(labelEl);
  }
  const rowEl = document.createElement('div');
  rowEl.className = 'parts-row';
  const cardRefs = arrangement.sections.map((section, k) => buildPartCard(arrangement, section, k, labelText));
  rowEl.append(...cardRefs.map((ref) => ref.cardEl));
  nodes.push(rowEl);
  return { nodes, cardRefs };
}

/**
 * Renders the Parts view from a synchronous parse of the code that played — no loading state
 * (parts come from a synchronous parse plus the live cycle count).
 * Shows PARTS_COPY.cannotRead when the pinned parser is missing or the parse throws,
 * PARTS_COPY.none when the code has no arrange() calls, the reason (partsEmptyText) when it has
 * arrange() calls but none can be read — and then no "Ask Claude to add sections" offer —
 * otherwise one row per arrangement — with
 * a `.parts-row-label` on each row only when there are two or more arrangements. Ends by running
 * updatePartsLive() once so the fresh cards show their true state immediately, not after the next
 * animation frame.
 */
function renderParts() {
  if (!window.acorn || typeof window.acorn.parse !== 'function') {
    console.error('Moontide: window.acorn is not available — the pinned parser script did not load.');
    songUi.clearNotes();
    hideSongGrid();
    showPartsMessage(PARTS_COPY.cannotRead);
    askUi.setPartsAvailable(false);
    return;
  }
  const parse = window.acorn.parse;
  const code = playingCode();
  let tracks;
  let reading;
  let arrangements;
  let problems;
  let callCount;
  try {
    tracks = extractTracks(code, { parse });
    // The reading made when this version took over, when it belongs to this code; else read it now.
    reading =
      songReading !== null && songReading.generation === songVersion && songReading.code === code
        ? songReading.reading
        : readStructure(code, { parse, tracks });
    if (reading.state === 'none') ({ arrangements, problems, callCount } = readArrangements(code, { parse, tracks }));
  } catch (err) {
    console.error('Moontide: failed to parse the playing code for the Parts view:', err);
    songUi.clearNotes();
    hideSongGrid();
    showPartsMessage(PARTS_COPY.cannotRead);
    askUi.setPartsAvailable(false);
    return;
  }
  if (reading.state === 'read') {
    // A song takes the whole view: its grid replaces any arrange() rows, and the cards they had are gone.
    partsMessage.hidden = true;
    partsCardRefs = [];
    songGridReading = reading;
    drawSongGrid();
    songUi.showNotes(songNoteEntries(reading));
    askUi.setPartsAvailable(false);
    return;
  }
  if (reading.state === 'unreadable') {
    // One line with the reason, the same sentence Claude gets; no grid.
    songUi.clearNotes();
    hideSongGrid();
    showPartsMessage(songMessageText(reading));
    askUi.setPartsAvailable(false);
    return;
  }
  songUi.clearNotes();
  hideSongGrid();
  if (arrangements.length === 0) {
    if (problems.length === 0) {
      showPartsMessage(PARTS_COPY.none);
      askUi.setPartsAvailable(true);
    } else {
      // The code already has an arrange(): say why it is not shown, and do not offer to add sections.
      showPartsMessage(partsEmptyText(problems, callCount));
      askUi.setPartsAvailable(false);
    }
    return;
  }
  if (takeover.pending() !== null) {
    // A change waits for its line: the waiting line stands above the rows (it replaces the skipped-calls
    // line during the wait) and a launch is refused until the takeover.
    partsMessage.textContent = PARTS_COPY.waiting;
    partsMessage.hidden = false;
  } else if (problems.length > 0) {
    // Some arrange() calls were skipped: keep the rows and name each skipped call and why.
    partsMessage.textContent = partsSkippedText(problems, callCount);
    partsMessage.hidden = false;
  } else {
    partsMessage.hidden = true;
  }
  askUi.setPartsAvailable(false);
  const showLabel = arrangements.length >= 2;
  const allNodes = [];
  const allCardRefs = [];
  for (const arrangement of arrangements) {
    const { nodes, cardRefs } = buildPartsRow(arrangement, tracks, showLabel);
    allNodes.push(...nodes);
    allCardRefs.push(...cardRefs);
  }
  partsRows.replaceChildren(...allNodes);
  partsCardRefs = allCardRefs;
  updatePartsLive();
}

/**
 * Updates every live Parts card in place from a fresh partStates() reading — called on every
 * renderParts() (a rebuild) and on every animation-frame tick while the Parts view is open
 * (a card is only touched when a shown text or width changes).
 * Clears `pendingLaunch` once the live cycle reaches its `targetCycle` (its countdown is over,
 * whether or not that arrangement's own row is still on screen).
 */
function updatePartsLive() {
  if (partsCardRefs.length === 0) return;
  const rawNow = editor.repl.scheduler.now();
  const cycle = Number.isFinite(rawNow) && rawNow > 0 ? rawNow : 0;
  if (pendingLaunch !== null && cycle >= pendingLaunch.targetCycle) {
    pendingLaunch = null;
  }
  const cps = editor.repl.scheduler.cps;
  // Card text/progress reflects real playback only while the page is actually making sound
  // (while stopped, every card reads Idle).
  const playing = currentSoundState === 'playing';
  for (const ref of partsCardRefs) {
    const pending = pendingLaunch !== null && pendingLaunch.signature === ref.signature ? pendingLaunch : null;
    const state = partStates({ arrangement: ref.arrangement, cycle, cps, playing, pending })[ref.partIndex];
    if (ref.cardEl.dataset.state !== state.state) {
      ref.cardEl.dataset.state = state.state;
    }
    if (state.text !== ref.shownText) {
      ref.stateEl.textContent = state.text;
      ref.shownText = state.text;
    }
    // Motion off steps the bar once per cycle (the fraction is (elapsed - 1) / length),
    // which is exactly the continuous fraction floored to the current whole cycle.
    const rawProgress =
      state.state !== 'playing' ? 0 : viewState.motion === 'off' ? Math.floor(state.progress * ref.section.length) / ref.section.length : state.progress;
    const width = `${Math.max(0, Math.min(1, rawProgress)) * 100}%`;
    if (width !== ref.shownWidth) {
      ref.progressFillEl.style.width = width;
      ref.shownWidth = width;
    }
  }
}

/** Draws the Song grid of the reading it shows, from the fold state, then hands it the live state. */
function drawSongGrid() {
  const wait = waitingCellEdit();
  const cellWaiting = wait === null ? null : { track: wait.track, section: wait.section, choice: wait.choice, at: wait.at };
  // The fit words come from the answer of the query of this very version and reading; until it answers there are none.
  const fit =
    songFit !== null && songFit.generation === songVersion && songFit.reading === songGridReading
      ? fitLookup({ reading: songGridReading, byPair: songFit.answer })
      : null;
  songGridUi.render(buildSongGrid({ reading: songGridReading, folds: songFolds, launchChoice: viewState.songLaunch, cellWaiting, fit }));
  refreshSongLine();
  updateSongGridLive();
}

// One of the three launch buttons of the toolbar: when a launched section starts. The choice is remembered in this browser
// (applyViewState stores it) and only the titles of the section headers change; the code is not touched.
songGridHandlers.launchChoice = (value) => {
  if (value === viewState.songLaunch) return;
  applyViewState(setSongLaunch(viewState, value), ['songLaunch']);
};

// A click, Enter or Space on a group's fold button, in the Song grid or in the Mixer: the group folds or opens, the one
// fold set both views read changes, the state is remembered in this browser, and the views that are on screen are drawn
// again. Nothing is written to the code, sent to the server or evaluated.
function toggleSongFold(key) {
  const next = new Set(songFolds);
  if (!next.delete(key)) {
    next.add(key);
    // A group the store would refuse (a name over 200 characters) still folds here; say once that a reload forgets it.
    if (!isRememberable(key) && !notRememberedSaid) {
      notRememberedSaid = true;
      console.error(SONG_FOLDS_COPY.notRemembered);
    }
  }
  songFolds = next;
  if (!writeSongFolds(storage, [...songFolds])) reportStorageUnavailableOnce();
  if (songGridReading !== null) drawSongGrid();
  if (viewState.view === 'mixer') renderMixer();
}
songGridHandlers.fold = (key) => toggleSongFold(key);

// A click, Enter or Space on a section header: the section is queued to start on the line the toolbar chose, a second click on
// the queued one cancels it and a click on another header replaces it. What the person saw (the entry's place, name and
// length) and the choice are taken now; the launch itself runs on the serial chain, so it never interleaves with Claude's
// changes or a Mixer move.
songGridHandlers.launch = (index) => {
  const section = songGridReading === null ? undefined : songGridReading.sections[index];
  if (section === undefined) throw new Error(`Moontide: the Song grid has no section ${String(index)} to launch.`);
  const seen = { index, name: section.name, length: section.length, kind: viewState.songLaunch };
  chain = chain.then(() => launchSection(seen)).catch((err) => reportChainError('section launch', err));
};

// A choice in the list that opens on a cell: the one string of the plan for that cell is rewritten, by the person's usual
// hand-edit timing, and the choice is one history entry. What the person saw (the cell and its section) is taken now; the
// change itself runs on the serial chain, so it never interleaves with Claude's changes or a Mixer move.
songGridHandlers.choose = (seen, choice) => {
  chain = chain.then(() => chooseCell(seen, choice)).catch((err) => reportChainError('cell change', err));
};

/** The structure of `code` as the reader gives it (throws when the parser cannot read the text). */
function readSongOf(code) {
  const parse = window.acorn.parse;
  return readStructure(code, { parse, tracks: extractTracks(code, { parse }) });
}

/** The cycle the scheduler is at, never below 0. */
function currentCycle() {
  const raw = scheduler.now();
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

/** True while some version makes sound: the same test the takeover uses to decide whether a change has to wait. */
function playsNow() {
  return scheduler.started === true && !pageStopped && hasEvaluatedSuccessfully && !!scheduler.pattern;
}

/** The launch of the person's own that still waits in the takeover, or null (a stale one is dropped). */
function waitingGridLaunch() {
  if (gridLaunch !== null && takeover.pending() !== gridLaunch.record) gridLaunch = null;
  return gridLaunch;
}

/**
 * Puts the code that plays back in the editor after a launch of the grid ended without taking over. The launch wrote only
 * the shift, so this happens only while the editor still holds exactly the text the launch wrote: text typed since (which
 * the dirty line already reports) is never replaced, and the console says the editor was left alone.
 */
function putBackCanceledLaunch(record) {
  const text = textAfterCanceledLaunch({ editorCode: editor.code, launchCode: record.code, playingCode: record.playingCode });
  if (text !== null) {
    editor.setCode(text);
    return;
  }
  console.error('Moontide: the canceled launch left the editor alone: it holds text that was not evaluated.');
}

/** The change of a cell of the person's own that still waits in the takeover, or null (a stale one is dropped). */
function waitingCellEdit() {
  if (gridCellWait !== null && takeover.pending() !== gridCellWait.record) gridCellWait = null;
  return gridCellWait;
}

/** Stops a cell change before anything is written: `reason` is an id of SONG_COPY.refusals. */
class CellStop extends Error {
  constructor(reason) {
    super(`Moontide: the cell change stopped (${reason}).`);
    this.reason = reason;
  }
}

/**
 * Changes the cell the person chose in the list. Runs only inside the serial `chain`. A pending Mixer gesture is recorded
 * first and the touched-line overlay stops describing the text; the line under the toolbar is brought up to date when the
 * gesture is over.
 */
async function chooseCell(seen, choice) {
  await mixerGesture.flushDirect();
  clearMixerFlash();
  gridRefused = null;
  gridBusy = true;
  try {
    await chooseCellNow(seen, choice);
  } finally {
    gridBusy = false;
    refreshSongLine();
    if (songGridReading !== null) updateSongGridLive();
  }
}

/**
 * The gesture itself: the playing code is read again, the cell is checked against what the person saw (section, cell and
 * variation) and exactly one string of song.plan is rewritten through the shared path with the person's own hand-edit timing.
 * Choosing what the cell holds writes, evaluates and records nothing. At once the change is recorded now; waiting, the grid
 * shows the new name with the words for its line and the change is recorded when it takes over.
 */
async function chooseCellNow(seen, choice) {
  const timing = parseTiming(viewState.changeTiming);
  let outcome;
  try {
    outcome = await pageRewrite.apply({
      timing,
      // A cell change is an edit, not a request to play.
      autostart: !pageStopped,
      flash: false,
      build(text) {
        const reading = readSongOf(text);
        if (reading.state !== 'read') throw new CellStop('section-gone');
        const stale = checkCell(reading, seen, choice);
        if (stale !== null) throw new CellStop(stale);
        const { edits, changed } = cellEdit(reading, { index: seen.index, track: seen.track }, choice);
        return { code: changed ? applyEdits(text, edits) : text, edits };
      },
    });
  } catch (err) {
    if (err instanceof CellStop) {
      console.error(`Moontide: the cell was not changed (${err.reason}); the code changed since the click.`);
      gridRefused = err.reason;
      return;
    }
    if (err instanceof SongEditRefusal) {
      console.error(`Moontide: the cell was not changed (${err.reason}).`);
      gridRefused = err.reason;
      return;
    }
    throw err;
  }
  if (outcome.status === 'refused') {
    reportGridRefusal(outcome.reason, 'the cell was not changed');
    return;
  }
  if (outcome.status === 'unchanged') return;
  if (outcome.status === 'failed') {
    // The old code is still what plays; the shared path set the editor back and showed the banner.
    gridRefused = 'not-evaluated';
    return;
  }
  const label = cellRecordLabel({ track: seen.track, section: seen.name, choice });
  const record = outcome.run.deferred;
  if (record === null || record === undefined) {
    sendMixerRecord(editor.repl.state.activeCode, label);
    flashMixerLines(outcome.edits);
    return;
  }
  gridCellWait = { record, track: seen.track, section: seen.name, choice, at: timing.at };
  takeover.whenFinished(record, () => {
    if (gridCellWait !== null && gridCellWait.record === record) gridCellWait = null;
    sendMixerRecord(typeof record.code === 'string' ? record.code : editor.repl.state.activeCode, label);
    if (songGridReading !== null) drawSongGrid();
  });
  if (songGridReading !== null) drawSongGrid();
}

// --- the Timeline's note edits ---

/** The strings of the code on screen, the song reading and the scope of every track, made once for the version drawn. */
/** The song reading of the code the lanes were drawn from, or `{ state: 'none' }` when the page has read no song from that code. */
function timelineSongReading() {
  return songReading !== null && songReading.code === timelineCode ? songReading.reading : { state: 'none' };
}

function timelineNoteIndex() {
  if (timelineIndex !== null && timelineIndex.code === timelineCode) return timelineIndex;
  const index = indexCode(timelineCode, { parse: timelineParse });
  const reading = timelineSongReading();
  const scopes = timelineTracks.map((track) => trackScope({ track, reading }));
  timelineIndex = { code: timelineCode, index, reading, scopes, readers: readerCounter(index, scopes) };
  return timelineIndex;
}

/** The onset notes of a pattern over `from` to `to`, in the shape of the lane's own events (the places in the code kept). */
function onsetEvents(pattern, from, to) {
  const events = [];
  for (const hap of pattern.queryArc(from, to)) {
    if (hap.whole && hap.hasOnset()) events.push(toLaneEvent(hap));
  }
  return events;
}

/**
 * Where the token of an editable note plays in a song the page has read: one query of the track's own pattern over one pass of
 * the structure, from the first section's start, each note mapped to its section entry with the Song grid's own rule. The
 * evaluated pattern is kept for the version and the track, and the answer for the token. Gives a promise of `{ count, sections,
 * onPage: false, events }` (`events` are the notes of the pass, the read-back compares them), and `span`, the stretch queried.
 */
function timelinePlacesOf({ trackIndex, token, reading }) {
  const cache = timelinePlaces;
  const parse = timelineParse;
  const code = timelineCode;
  const from = ((reading.sections[0].start % reading.total) + reading.total) % reading.total;
  const span = { from, to: from + reading.total };
  const key = `${trackIndex}:${token.start}`;
  if (!cache.answers.has(key)) {
    if (!cache.patterns.has(trackIndex)) {
      const pattern = evaluateSolo(soloSource(code, trackIndex, { parse }));
      // A pattern that failed to evaluate is not kept: the next selection tries again.
      pattern.catch(() => cache.patterns.delete(trackIndex));
      cache.patterns.set(trackIndex, pattern);
    }
    const answer = cache.patterns.get(trackIndex).then((pattern) => {
      const events = onsetEvents(pattern, span.from, span.to);
      return { ...placesOf({ haps: events, token, reading }), onPage: false, events };
    });
    answer.catch(() => cache.answers.delete(key));
    cache.answers.set(key, answer);
  }
  return { places: cache.answers.get(key), span };
}

/**
 * What the panel needs to know of the note the person clicked (lane `laneIndex` of the lanes drawn, event `eventIndex` of the
 * lane): where it is, what it plays, and whether the page can edit it with the reason when it cannot. Reads the code and the
 * lanes only; nothing is written, evaluated or sent. For a note that can be edited `seen` holds what the edit needs of this
 * moment: the code the note was read from, the lane as drawn and the place of the token in the code.
 */
function describeTimelineNote(laneIndex, eventIndex) {
  if (timelineDrawn === null || timelineCode === null || timelineTracks === null) {
    throw new Error('Moontide: a note was picked while no Timeline lanes are drawn.');
  }
  const lane = timelineDrawn.lanes[laneIndex];
  const event = lane.events[eventIndex];
  const { index, reading, scopes, readers } = timelineNoteIndex();
  const scope = scopes.find((candidate) => candidate.index === lane.index);
  const verdict = classifyNote({ code: timelineCode, index, event, scope, scopes, readers, midi: lane.midi === true });
  // The cycle and beat the right-click names for the instant the note begins at: one rule for both.
  const moment = momentAt({ pageStart: timelineDrawn.pageStart, fraction: (event.begin - timelineDrawn.pageStart) / PAGE_CYCLES, lanes: [], version: null });
  const midi = pitchOf(event.value);
  const drumNote = lane.drumMap === null ? null : drumNoteOf(event.value);
  const info = {
    laneIndex,
    eventIndex,
    track: lane.track,
    cycle: moment.cycle,
    beat: moment.beat,
    section: reading.state === 'read' ? reading.sections[playingSection(reading, event.begin).index].name : null,
    noteText: event.value.note ?? midi,
    midi,
    drum: drumNote !== null && lane.drumMap.byNote.has(drumNote) ? lane.drumMap.byNote.get(drumNote) : null,
    velocity: velocityOf(event.value, lane.midi === true),
    // The velocity is writable only where one number of a velocity string in the track holds it (page/note-locate.js).
    velocityWritable: verdict.editable && verdict.velocity.writable,
    editable: verdict.editable,
    reason: verdict.editable ? null : verdict.reason,
    seen: null,
  };
  if (verdict.editable) {
    info.seen = {
      code: timelineCode,
      trackIndex: lane.index,
      track: lane.track,
      event,
      events: lane.events,
      token: verdict.token,
      velocity: verdict.velocity,
      pageStart: timelineDrawn.pageStart,
      places: null,
      placesWindow: null,
      velocityPlaces: null,
      velocityWindow: null,
      perCycle: 0,
    };
    if (reading.state === 'read') {
      // A song: the places are section entries. Over the count limit only the entries the drawn page holds are counted.
      const placesOfToken = (token) =>
        reading.total > PLACES_MAX_CYCLES
          ? { places: { ...placesOf({ haps: lane.events, token, reading }), onPage: true }, span: null }
          : timelinePlacesOf({ trackIndex: lane.index, token, reading });
      const counted = placesOfToken(verdict.token);
      info.seen.places = counted.places;
      info.seen.placesWindow = counted.span;
      // The number that holds the velocity can play in more places than the pitch token does (a variation used by several
      // sections): they are counted for the velocity too, and a velocity edit is read back over all of them.
      if (verdict.velocity.writable) {
        const velocityCounted = placesOfToken(verdict.velocity.token);
        info.seen.velocityPlaces = velocityCounted.places;
        info.seen.velocityWindow = velocityCounted.span;
      }
    } else {
      // No structure: only a token that draws several notes in one cycle is told.
      info.seen.perCycle = perCycleCount({ events: lane.events, token: verdict.token, cycle: Math.floor(event.begin + 1e-9) });
    }
    info.places = info.seen.places;
    info.velocityPlaces = info.seen.velocityPlaces;
    info.perCycle = info.seen.perCycle;
  }
  return info;
}

// The edit of the person's own that waits for its line, `{ record }` (the takeover's waiting change), or null; the Timeline's
// note panel keeps its edit controls off meanwhile and says so with the edit's own sentence.
let timelineEditWait = null;
// True while an edit of the Timeline runs on the serial chain: the editor legitimately differs from the playing code then.
let timelineEditBusy = false;
// What the editor held the last time nothing was in flight: true while it has text that was never evaluated.
let timelineDirty = false;
// The notice the note panel was last told (null, 'closed', 'waiting' or 'dirty'), so it is told again only when it changes.
let timelineNoticeKind = null;

/** Ends the wait of the person's own edit once its record is no longer the waiting change: it took over, or was dropped. */
function syncTimelineWait() {
  if (timelineEditWait === null) return;
  const { record } = timelineEditWait;
  if (takeover.pending() === record) return;
  timelineEditWait = null;
  timelineEditUi.finishWait({ tookOver: record.finished === true });
}

/**
 * The notice that keeps the Timeline's edit controls off, by the Mixer's order: the socket is closed, another change waits for
 * its line, or the editor holds text that was never evaluated. The person's own waiting edit is not a notice (it has its own
 * sentence). The editor is compared with the playing code except while an evaluation is in flight, when it legitimately
 * differs; then the last answer stands.
 */
function timelineNotice() {
  if (ws.readyState !== ws.OPEN) return 'closed';
  const waitingRecord = takeover.pending();
  const ours = timelineEditWait !== null && waitingRecord === timelineEditWait.record ? timelineEditWait : null;
  if (waitingRecord !== null && ours === null) return 'waiting';
  if (hasEvaluatedSuccessfully && !programmaticEvalInFlight && !mixerTickInFlight && !timelineEditBusy) {
    const code = ours !== null && typeof ours.record.code === 'string' ? ours.record.code : playingCode();
    timelineDirty = editor.code !== code;
  }
  return timelineDirty ? 'dirty' : null;
}

/**
 * The Timeline note panel's share of the 250 ms page poll, only while the Timeline is open: the wait of the person's own edit
 * ends when its record is gone, and the panel is told of a notice only when its kind changes.
 */
function pollTimelineEdit() {
  if (viewState.view !== 'timeline') return;
  syncTimelineWait();
  const kind = timelineNotice();
  if (kind === timelineNoticeKind) return;
  timelineNoticeKind = kind;
  timelineEditUi.setNotice(kind);
}

/**
 * Changes the note the person edited on the Timeline. Runs only inside the serial `chain`. A pending Mixer gesture is recorded
 * first and the touched-line overlay stops describing the text. The edited track is read back before anything is written
 * (page/note-edit.js), the write goes through the shared path with the person's usual hand-edit timing, and a written edit
 * is one history entry. The panel is told what happened under the edit's `id`, so the outcome speaks for the edit's own note.
 */
async function editTimelineNote(info, change, id) {
  const seen = info.seen;
  let outcome;
  let evaluated = null;
  timelineEditBusy = true;
  try {
    // Inside the try, like the Mixer flush below: a missing parser or a pending Mixer gesture that fails to record is told in the
    // panel like any other error of the edit, so every edit handed over ends in an outcome.
    const parse = window.acorn.parse;
    await mixerGesture.flushDirect();
    clearMixerFlash();
    outcome = await writeNoteEdit({
      seen,
      change,
      deps: {
        // The edited track alone, over the page the lanes show or over the stretch of the structure the places were counted on, in
        // the shape of the lane's own events. The edited track is evaluated once for both.
        async readBack(code, span) {
          if (evaluated === null || evaluated.code !== code) evaluated = { code, pattern: evaluateSolo(soloSource(code, seen.trackIndex, { parse })) };
          const pattern = await evaluated.pattern;
          return span === undefined ? onsetEvents(pattern, seen.pageStart, seen.pageStart + PAGE_CYCLES) : onsetEvents(pattern, span.from, span.to);
        },
        apply: (request) => pageRewrite.apply(request),
        timing: parseTiming(viewState.changeTiming),
        // An edit is not a request to play.
        autostart: !pageStopped,
        record: sendMixerRecord,
        whenFinished: (record, fn) => takeover.whenFinished(record, fn),
        activeCode: () => editor.repl.state.activeCode,
      },
    });
  } catch (err) {
    if (err instanceof NoteEditStop) {
      outcome = { kind: 'refused', reason: err.reason };
    } else {
      // An error nobody planned for is told in the panel as well as the console: the person is never left with a standing sentence
      // and no word about the edit they asked for.
      console.error('Moontide: the Timeline edit failed:', err);
      outcome = { kind: 'refused', reason: 'error' };
    }
  } finally {
    timelineEditBusy = false;
  }
  // An error the rewrite path gave back is reported here: at or after the write the edit's own code may have changed; an
  // evaluation that threw and was taken back left the code as it was.
  if (outcome.kind === 'refused' && outcome.reason === 'error' && outcome.error !== undefined) {
    console.error(outcome.afterWrite === true ? 'Moontide: the Timeline edit failed after its write:' : 'Moontide: the Timeline edit failed, and its write was taken back:', outcome.error);
  }
  if (outcome.kind === 'refused' && (outcome.reason === 'stale' || outcome.reason === 'read-back')) {
    console.error(`Moontide: the note was not changed (${outcome.reason}${outcome.why === undefined ? '' : `: ${outcome.why}`}).`);
    if (outcome.error !== undefined) console.error('Moontide: the edited track could not be read back:', outcome.error);
  }
  timelineEditUi.showOutcome(id, outcome);
  if (outcome.kind === 'waiting') {
    // The panel keeps the edit controls off until the change takes over; it hears of the takeover (or of its being dropped).
    timelineEditWait = { record: outcome.record };
    takeover.whenFinished(outcome.record, () => syncTimelineWait());
    syncTimelineWait();
  }
}

/**
 * Launches the section the person clicked on. Runs only inside the serial `chain`. A pending Mixer gesture is recorded
 * first, as for a part launch, and the touched-line overlay stops describing the text. The line under the toolbar and the
 * countdown of the header are brought up to date when the gesture is over.
 */
async function launchSection(seen) {
  await mixerGesture.flushDirect();
  clearMixerFlash();
  gridRefused = null;
  gridBusy = true;
  try {
    await launchSectionNow(seen);
  } finally {
    gridBusy = false;
    syncGridQueued(currentSoundState === 'playing' ? currentCycle() : null);
    refreshSongLine();
    if (songGridReading !== null) updateSongGridLive();
  }
}

/**
 * The gesture itself. A click on the header of the launch that waits cancels it (nothing is recorded, the music keeps
 * playing, the editor goes back to the playing code); a click on another header while ours waits replaces it, built on the
 * waiting code; both only until the scheduler has queried past the line, after which a click changes nothing; a click on
 * the header of a launch that needs no code change only hides its countdown. While the sound is stopped the piece starts at
 * that section at once. Otherwise the shift that puts the section on the chosen line is written and evaluated with the
 * takeover pinned to that line, and the server hears of it (one history entry) when the section takes over. The frontier is
 * read, the line and the shift computed, the code written and the evaluation started in one turn:
 * nothing is awaited between reading the frontier and the call that writes, which is what makes the line the takeover takes
 * agree with the line the shift was written for.
 */
async function launchSectionNow(seen) {
  if (!window.acorn || typeof window.acorn.parse !== 'function') {
    console.error('Moontide: window.acorn is not available — cannot launch a section.');
    return;
  }
  const ours = waitingGridLaunch();
  // The countdown of a launch that needs no code change: a second click on its header hides it, nothing else is involved.
  if (gridAlready !== null && gridAlready.index === seen.index && ours === null) {
    gridAlready = null;
    return;
  }
  if (ws.readyState !== ws.OPEN) {
    console.error('Moontide: the section was not launched: the socket is not open.');
    return;
  }
  if (!hasEvaluatedSuccessfully) {
    console.error('Moontide: the section was not launched: no code has played yet.');
    return;
  }
  const waiting = takeover.pending();
  if (waiting !== null && (ours === null || waiting !== ours.record)) {
    console.error('Moontide: the section was not launched: a change is waiting for its bar line.');
    return;
  }
  // The code the gesture builds on, and the text the editor must still hold: while our launch waits that is the waiting
  // code, which differs from the playing code in the shift alone. Typing that was never evaluated is never overwritten, and
  // a cancel never discards it either.
  const playing = playingCode();
  const base = ours !== null ? ours.record.code : playing;
  if (editor.code !== base) {
    console.error('Moontide: the section was not launched: the editor holds a hand edit that was not evaluated.');
    return;
  }
  let reading;
  let baseReading;
  try {
    reading = readSongOf(playing);
    baseReading = ours !== null ? readSongOf(base) : reading;
  } catch (err) {
    console.error('Moontide: failed to parse the code for a section launch:', err);
    return;
  }
  if (reading.state !== 'read' || baseReading.state !== 'read' || checkSection(reading, seen) !== null) {
    console.error('Moontide: the section to launch is gone; the code changed since the click.');
    gridRefused = 'section-gone';
    return;
  }

  // Once the scheduler has queried past the line, the notes of the new section are already scheduled: a cancel would let
  // them sound and then put the old music back in the middle of the section, and a replacement would be built on a
  // playing code that is no longer the one that plays. Nothing is changed; the launch takes over on its line.
  if (ours !== null && ours.record.reached) {
    console.error(`Moontide: the section '${ours.name}' is too close to its line to be canceled or replaced; it takes over.`);
    return;
  }

  if (ours !== null && ours.index === seen.index) {
    takeover.cancel('canceled');
    return;
  }

  if (!playsNow()) {
    await launchStoppedSection(seen, playing, reading);
    return;
  }

  // Another launch replaces the countdown of one that needs no code change.
  gridAlready = null;
  let attempt = 0;
  let from = base;
  let fromReading = baseReading;
  for (;;) {
    attempt += 1;
    // Read the frontier, compute the line and the shift, write and evaluate: no await until the call has started.
    const { line, at } = launchLine({ kind: seen.kind, frontier: scheduler.lastEnd, cps: tempoGuard.playing(), reading, minLeadSeconds: MIN_TAKEOVER_LEAD_SECONDS });
    const shift = launchShift(reading, seen.index, line);
    if (sameShift(shift, reading.shift, reading.total)) {
      // The section already starts on that line: nothing is written. A launch of ours that waits (or the first try of
      // this one, written for a line that moved) is dropped, and the header counts down to the line.
      if (takeover.pending() !== null) takeover.cancel('canceled');
      gridAlready = { index: seen.index, name: seen.name, line };
      return;
    }
    const outcome = await pageRewrite.apply({
      base: from,
      timing: pinnedTiming(at, line),
      // The sound plays (this loop runs only then), so the scheduler is started already. A Stop that lands while the
      // change is prepared must not start it again: the evaluation only swaps the pattern.
      autostart: false,
      flash: false,
      // A waiting change of ours is replaced by this one, so only a change of someone else's keeps it from running.
      guards: from === playing ? undefined : { waiting: false },
      build(text) {
        const edits = shiftEdit(fromReading, shift);
        return { code: applyEdits(text, edits), edits };
      },
    });
    if (outcome.status === 'refused') {
      if (takeover.pending() !== null && attempt > 1) takeover.cancel('canceled');
      reportGridRefusal(outcome.reason);
      return;
    }
    if (outcome.status === 'unchanged') return;
    if (outcome.status === 'failed') {
      // The old code is still what plays; the shared path set the editor back and showed the banner.
      if (takeover.pending() !== null && attempt > 1) takeover.cancel('canceled');
      gridRefused = 'not-evaluated';
      return;
    }
    const record = outcome.run.deferred;
    if (record === null || record === undefined) {
      // The change took over at once (the music stopped while it was prepared, and the evaluation did not start the
      // scheduler again): the code is the music that plays when Play comes, so the server hears of it all the same.
      sendIfOpen(JSON.stringify({ type: 'part-launch', code: editor.repl.state.activeCode, part: partLaunchPart(seen.name) }));
      // The server reads every launch as the sound playing, and the Stop's own report may have reached it before this one:
      // saying the Stop again makes the last word the server hears the true one.
      if (pageStopped) sendIfOpen(JSON.stringify({ type: 'user-stopped' }));
      flashMixerLines(outcome.edits);
      return;
    }
    if (record.canceled) {
      // Stop, or a change of someone else's, canceled it while the evaluation ran. After a Stop its text would read as
      // typing that was never evaluated: it goes back like any launch that ends without taking over.
      if (record.cancelReason === 'stop') putBackCanceledLaunch(record);
      return;
    }
    if (record.boundary === line) {
      gridLaunch = { record, index: seen.index, name: seen.name, line, at };
      takeover.whenFinished(record, () => {
        if (gridLaunch !== null && gridLaunch.record === record) gridLaunch = null;
        gridQueued = null;
        sendIfOpen(JSON.stringify({ type: 'part-launch', code: editor.repl.state.activeCode, part: partLaunchPart(seen.name) }));
        if (songGridReading !== null) {
          updateSongGridLive();
          songGridUi.scrollPlayingIntoView();
        }
      });
      return;
    }
    // The takeover took another line than the one the shift was written for (the frontier moved while the code was
    // prepared). The waiting code is written again for a fresh line, once; the newer change replaces it.
    if (attempt >= 2) {
      takeover.cancel('canceled');
      console.error(`Moontide: the section launch could not be placed on its line (wanted cycle ${line}, the takeover took ${record.boundary}); it was canceled.`);
      gridRefused = 'line-moved';
      return;
    }
    from = record.code;
    try {
      fromReading = readSongOf(from);
    } catch (err) {
      takeover.cancel('canceled');
      console.error('Moontide: failed to parse the waiting code for a section launch:', err);
      return;
    }
  }
}

/**
 * A click on a header while the sound is stopped: the piece starts at that section at once. The shift is written so the
 * section starts at cycle 0 (the count restarts at 0 at every Play), the sound comes back, and the server hears of it. When
 * the shift is already right the text stays as it is and is evaluated all the same, so the sound starts.
 */
async function launchStoppedSection(seen, playing, reading) {
  const shift = launchShift(reading, seen.index, 0);
  const unchanged = sameShift(shift, reading.shift, reading.total);
  const outcome = await pageRewrite.apply({
    base: playing,
    autostart: true,
    flash: false,
    evaluateUnchanged: true,
    build(text) {
      const edits = unchanged ? [] : shiftEdit(reading, shift);
      return { code: applyEdits(text, edits), edits };
    },
  });
  if (outcome.status === 'refused') {
    reportGridRefusal(outcome.reason);
    return;
  }
  if (outcome.status === 'unchanged') return;
  if (outcome.status === 'failed') {
    gridRefused = 'not-evaluated';
    return;
  }
  await resumeAfterStop();
  sendIfOpen(JSON.stringify({ type: 'part-launch', code: editor.repl.state.activeCode, part: partLaunchPart(seen.name) }));
  flashMixerLines(outcome.edits);
}

/**
 * What a launch the shared path refused leaves behind. Most refusals are states the line under the toolbar already says
 * (a waiting change, unevaluated typing, a closed socket); the console names them too, so none is silent.
 */
function reportGridRefusal(reason, subject = 'the section was not launched') {
  switch (reason) {
    case 'not-played':
      console.error(`Moontide: ${subject}: no code has played yet.`);
      break;
    case 'waiting':
      console.error(`Moontide: ${subject}: a change is waiting for its bar line.`);
      break;
    case 'closed':
      console.error(`Moontide: ${subject}: the socket is not open.`);
      break;
    case 'no-parser':
      console.error(`Moontide: window.acorn is not available — ${subject}.`);
      break;
    case 'dirty':
      console.error(`Moontide: ${subject}: the editor holds a hand edit that was not evaluated.`);
      break;
    case 'write-mismatch':
      console.error('Moontide: the editor text does not match the rewrite; the editor was set back.');
      gridRefused = 'not-written';
      break;
    default:
      console.error(`Moontide: ${subject} (${String(reason)}).`);
  }
}

/**
 * Works out the sentence under the toolbar for the state of the page now. The editor is compared with the code the grid
 * works on (the waiting code while our launch waits, else the playing code) except while a gesture or any programmatic
 * evaluation is in flight, when the editor legitimately differs; then the last answer stands. While the editor holds text
 * that was never evaluated, the launch lines give way to the dirty one: no gesture could cancel or replace the launch
 * without discarding that text, so every control is off and the line says why.
 */
function refreshSongLine() {
  if (songGridReading === null || gridBusy) return;
  const waitingRecord = takeover.pending();
  const ours = gridLaunch !== null && waitingRecord === gridLaunch.record ? gridLaunch : null;
  if (hasEvaluatedSuccessfully && !programmaticEvalInFlight && !mixerTickInFlight) {
    gridDirty = editor.code !== (ours !== null ? ours.record.code : playingCode());
  }
  let launch = null;
  if (!gridDirty) {
    if (ours !== null) launch = { kind: 'queued', section: ours.name };
    else if (gridAlready !== null) launch = { kind: 'already', section: gridAlready.name };
  }
  gridLine = songLine({
    connected: ws.readyState === ws.OPEN,
    launch,
    waiting: waitingRecord !== null && (ours === null || waitingRecord !== ours.record),
    dirty: gridDirty,
    refused: gridRefused,
  });
}

/**
 * The Song grid's share of the 250 ms page poll: a launch that needed no code change ends when the scheduler reaches its
 * line (the section it named plays then, and its column comes into view once); another change that starts to wait ends it
 * too; then the sentence under the toolbar is brought up to date.
 */
function pollSongGrid() {
  if (songGridReading === null || viewState.view !== 'parts') return;
  let landed = false;
  if (gridAlready !== null && (currentCycle() >= gridAlready.line || (takeover.pending() !== null && waitingGridLaunch() === null))) {
    landed = currentCycle() >= gridAlready.line;
    gridAlready = null;
    gridQueued = null;
  }
  refreshSongLine();
  if (landed) {
    updateSongGridLive();
    songGridUi.scrollPlayingIntoView();
  }
}

/** Takes the Song grid off the screen (a piece without a readable song shows the Parts view or its message instead). */
function hideSongGrid() {
  songGridUi.hide();
  songGridReading = null;
}

/**
 * Hands the live state to the Song grid: which section plays now, only while the page makes sound. The grid writes only
 * what changed, so calling this every animation frame touches no node while the state is the same.
 */
function updateSongGridLive() {
  if (songGridReading === null) return;
  const rawNow = editor.repl.scheduler.now();
  const cycle = Number.isFinite(rawNow) && rawNow > 0 ? rawNow : 0;
  const stopped = currentSoundState !== 'playing';
  // For at most one poll after a takeover the reading can still describe the previous section: the reading is replaced when
  // the finisher of the new version runs, a moment after the clock has moved on.
  songGridUi.tick({ playing: stopped ? null : playingSection(songGridReading, cycle), stopped, motion: viewState.motion, queued: gridQueued, line: gridLine });
  // The playing column scrolls into view once when the sound starts; after that the grid never follows it sideways.
  if (!stopped && !songGridWasPlaying) songGridUi.scrollPlayingIntoView();
  songGridWasPlaying = !stopped;
}

/** Ends a part launch before anything is written: the playing code cannot be read, or the part is gone. */
class PartLaunchStop extends Error {
  constructor(kind, cause) {
    super(`Moontide: the part launch stopped (${kind}).`);
    this.kind = kind;
    this.cause = cause;
  }
}

/**
 * Launches part `partIndex` of the arrangement whose rowSignature is `signature` — queued on the
 * serial `chain` by its own click handler (buildPartCard), so it never interleaves with Claude's
 * evaluate messages. Re-reads and re-parses activeCode first: the click and this run can be
 * separated by another evaluate landing in between.
 */
async function launchPart(signature, partIndex) {
  // A part launch replaces the music like Claude's code does, so a pending Mixer gesture is
  // recorded first (with the code that played), and the touched lines stop describing the text.
  await mixerGesture.flushDirect();
  clearMixerFlash();
  const wasStopped = pageStopped;
  let section = null;
  let target = 0;
  let outcome;
  try {
    // This launch has always replaced the whole text, with the editor flashing, and never checked for typing that
    // was not evaluated, nor for a closed socket or a first play: those three guards stay off so nothing changes.
    // When the page is stopped, an unchanged text is still evaluated so the sound starts again.
    outcome = await pageRewrite.apply({
      write: 'replace',
      flash: true,
      guards: { played: false, socket: false, dirty: false },
      evaluateUnchanged: wasStopped,
      build(code) {
        const parse = window.acorn.parse;
        let arrangements;
        try {
          const tracks = extractTracks(code, { parse });
          arrangements = extractArrangements(code, { parse, tracks });
        } catch (err) {
          throw new PartLaunchStop('unreadable', err);
        }
        const arrangement = arrangements.find((candidate) => rowSignature(candidate) === signature);
        section = arrangement && arrangement.sections[partIndex];
        if (!section) throw new PartLaunchStop('gone');
        const rawNow = editor.repl.scheduler.now();
        const now = Number.isFinite(rawNow) && rawNow > 0 ? rawNow : 0;
        target = launchTargetCycle({ now, cps: editor.repl.scheduler.cps, stopped: wasStopped });
        const offset = launchOffset(target, section.start, arrangement.total);
        return { code: applyArrangeOffset(code, arrangement, offset), edits: null };
      },
    });
  } catch (err) {
    if (!(err instanceof PartLaunchStop)) throw err;
    if (err.kind === 'unreadable') {
      console.error('Moontide: failed to parse the playing code for a part launch:', err.cause);
    } else {
      console.error('Moontide: the part to launch is gone; the code changed since the click.');
      if (viewState.view === 'parts') renderParts();
    }
    return;
  }
  if (outcome.status === 'refused') {
    if (outcome.reason === 'waiting') {
      // A launch would play (and record) the waiting change; Parts says so in its message line.
      console.error('Moontide: the part was not launched: a change is waiting for its bar line.');
      if (viewState.view === 'parts') renderParts();
    } else {
      console.error('Moontide: window.acorn is not available — cannot launch a part.');
    }
    return;
  }
  if (outcome.status === 'unchanged') {
    // Nothing changes (this part already starts at the target cycle): only record the pending
    // launch and re-render — never evaluate or send anything for a no-op rewrite.
    pendingLaunch = { signature, partIndex, targetCycle: target };
    if (viewState.view === 'parts') renderParts();
    return;
  }
  if (outcome.status === 'failed') {
    // The old code is still what is actually playing; the shared path set the editor back and showed the banner.
    pendingLaunch = null;
    if (viewState.view === 'parts') renderParts();
    return;
  }
  // onVersionPlaying (fired by the evaluate above, via trackEvalSuccess) already cleared
  // pendingLaunch — set the real value now that the evaluate has landed.
  pendingLaunch = { signature, partIndex, targetCycle: target };
  if (wasStopped) {
    await resumeAfterStop();
  }
  sendIfOpen(JSON.stringify({ type: 'part-launch', code: editor.repl.state.activeCode, part: partLaunchPart(section.name) }));
  if (viewState.view === 'parts') renderParts();
}
