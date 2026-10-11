// The top bar's pure model: what the Session button counts and says, and the session strip's line.
// No DOM access at import time, so node:test imports it directly and page/main.js feeds it facts. The words the
// bar adds live here; the words it reuses (connection labels, build lines, the tab role text) are imported, never
// copied, so a reworded sentence changes in one place. It also holds the words of the transport, the tempo and
// the banner.

import { ASK_COPY } from './ask.js';
import { MIDI_COPY } from './midi-plan.js';
import { BEATS_PER_CYCLE, bpmText } from './change-timing.js';
import { BUILD_MISMATCH_COPY, CONNECTION_LABELS, SERVER_UPDATED_COPY, SOUND_LABELS, errorLineText } from './ui-state.js';

/** The copy the bar and the Session drawer add. */
export const BAR_COPY = Object.freeze({
  session: 'Session',
  // The title of the Session button lists what needs the user: this lead plus the names, joined by ', '.
  needsYou: 'Needs you: ',
  // The names of the things that need the user, as the title lists them.
  issueDisconnected: 'Disconnected',
  issueRefused: 'Refused',
  issueBuild: 'Different builds',
  issueUpdated: 'Server updated',
  issueTab: 'Other tab',
  issueMidi: 'MIDI',
  // The strip repeats the build line with this sentence after it.
  stripMidiRefused: ' MIDI code is refused until then.',
  cardSession: 'Session',
  cardMidi: 'MIDI',
  cardRequests: 'Page requests',
  cardSettings: 'Settings',
  cardChange: 'Last change',
  rightClickHint: 'Right-click anything to ask Claude.',
  rightClickHintTitle: ASK_COPY.shiftRightClickTitle,
  midiHint: 'Instruments view: key 6.',
  settingsLabel: 'Your edits take over',
  timingNote: "Claude's changes say their own timing.",
  motionNote: 'Off stops the moving parts of the page.',
  noChange: 'No change yet.',
  takeBack: MIDI_COPY.takeBack,
  takingOver: MIDI_COPY.takingOver,
  // The transport: the button says the action, the state word says the fact. Two honest states, no pause.
  play: 'Play',
  stop: 'Stop',
  // The visible word before the layout buttons (the group is named by the same word).
  layoutWord: 'Layout',
  // The long part of the state word in a tab that lost the role: 'Stopped' plus this.
  stateHere: ' here',
  playTitle: 'Play: run the code in the editor (same as Ctrl+Enter)',
  stopTitle: 'Stop: silence the music',
  playDisabledEmpty: 'Nothing to play: the editor is empty.',
  playDisabledTab: 'This tab is silent: Moontide plays in another tab.',
  // A press on a disabled Play in a lost tab says the reason and then this sentence.
  playUseTakeBack: 'Use Play in this tab.',
  // The polite lines a press says through the status line.
  saidStopped: 'Stopped.',
  saidPlaying: 'Playing.',
  // The tempo readout: the dash stands for no tempo; the arrow leads the tempo a waiting change brings.
  tempoNone: '—',
  tempoUnit: 'BPM',
  tempoArrow: '→',
  tempoTitle: 'Tempo of the music that plays',
  tempoTitleIdle: 'Nothing plays',
  tempoNameIdle: 'No tempo, nothing plays',
  // The failed-change banner: the lead of each kind, and the three sentences about the music. The first two
  // equal the server's NOTHING_PLAYING_TAIL and STILL_STOPPED_TAIL; the third is the user-facing wording of
  // STILL_PLAYING_TAIL ('The previous code is still playing.' stays the server's text for Claude). A test pins all three.
  leadChange: 'Change failed.',
  leadNotice: 'Problem.',
  consequenceNothing: 'Nothing is playing yet.',
  consequenceStopped: 'Sound is still stopped.',
  consequencePlaying: 'The previous music keeps playing.',
  // The visible words stay short; the accessible names and titles carry the noun.
  detailsShow: 'Details',
  detailsHide: 'Hide details',
  detailsShowName: 'Show error details',
  detailsHideName: 'Hide error details',
  copy: 'Copy',
  copied: 'Copied',
  copyName: 'Copy error text',
  dismiss: 'Dismiss',
  dismissName: 'Dismiss error banner',
  // Said in the hidden alert region after a successful Copy, and shown (loud) when the clipboard refuses.
  copiedAnnouncement: 'Error copied.',
  copyFailed: 'Could not copy — select the text and copy it yourself.',
  // Ask Claude with the error attached, and the right-click popover of the banner (three plain buttons).
  ask: 'Ask Claude',
  askName: 'Ask Claude about this error',
  menuName: 'Error actions',
  menuCopy: 'Copy the error',
  menuAsk: 'Ask Claude about it',
  menuDismiss: 'Dismiss',
});

/** What is drawn of an error text is cut here (with an ellipsis); Copy always writes the uncut text. */
export const PROBLEM_DRAWN_MAX = 4000;

/** The keys of the things that can need the user, in the order the count lists them. */
export const SESSION_ISSUE_KEYS = Object.freeze(['connection', 'build', 'updated', 'tab', 'midi']);

const CONNECTION_STATES = Object.freeze(Object.keys(CONNECTION_LABELS));

function requireBoolean(name, value) {
  if (typeof value !== 'boolean') {
    throw new Error(`Moontide: ${name} must be true or false, got ${JSON.stringify(value)}.`);
  }
}

/**
 * The things that need the user, in a fixed order: [{ key, name }]. `connection` is the socket state
 * ('connecting' and 'connected' are calm, 'disconnected' and 'refused' count); `buildMismatch` is the server older
 * than the page; `serverUpdated` is the softer line (it counts, but never together with a build mismatch, which says
 * more); `superseded` is a tab that lost the role; `midiAttention` is the MIDI indicator asking for attention. A
 * failed-change banner is not an input on purpose: it has its own place and never counts. An unknown connection
 * state or a flag that is not a boolean throws.
 */
export function sessionIssues({ connection, buildMismatch, serverUpdated, superseded, midiAttention }) {
  if (!CONNECTION_STATES.includes(connection)) {
    throw new Error(`Moontide: the connection state must be one of ${CONNECTION_STATES.join(', ')}, got ${JSON.stringify(connection)}.`);
  }
  requireBoolean('buildMismatch', buildMismatch);
  requireBoolean('serverUpdated', serverUpdated);
  requireBoolean('superseded', superseded);
  requireBoolean('midiAttention', midiAttention);
  const issues = [];
  if (connection === 'disconnected') issues.push({ key: 'connection', name: BAR_COPY.issueDisconnected });
  if (connection === 'refused') issues.push({ key: 'connection', name: BAR_COPY.issueRefused });
  if (buildMismatch) issues.push({ key: 'build', name: BAR_COPY.issueBuild });
  else if (serverUpdated) issues.push({ key: 'updated', name: BAR_COPY.issueUpdated });
  if (superseded) issues.push({ key: 'tab', name: BAR_COPY.issueTab });
  if (midiAttention) issues.push({ key: 'midi', name: BAR_COPY.issueMidi });
  return issues;
}

/**
 * The Session button from the list of issues: `count` (the length, the pill is drawn only above zero), `label` (the
 * accessible name: "Session" or "Session, 2 need you") and `title` (empty at zero, else "Needs you: " plus the names).
 */
export function sessionButtonModel(issues) {
  const count = issues.length;
  if (count === 0) return { count, label: BAR_COPY.session, title: '' };
  return {
    count,
    label: `${BAR_COPY.session}, ${count} need you`,
    title: `${BAR_COPY.needsYou}${issues.map((issue) => issue.name).join(', ')}`,
  };
}

/**
 * The session strip under the bar (shown only while the drawer is closed): one muted line that repeats the build
 * line (or, softer, the updated line) and the lost-tab line, and whether its Play in this tab button shows.
 * `noActive` is the lost-tab state where no tab plays at all. Returns { visible, text, takeBack }.
 */
export function stripModel({ buildMismatch, serverUpdated, superseded, noActive }) {
  requireBoolean('buildMismatch', buildMismatch);
  requireBoolean('serverUpdated', serverUpdated);
  requireBoolean('superseded', superseded);
  requireBoolean('noActive', noActive);
  const sentences = [];
  if (buildMismatch) sentences.push(`${BUILD_MISMATCH_COPY.line}.${BAR_COPY.stripMidiRefused}`);
  else if (serverUpdated) sentences.push(`${SERVER_UPDATED_COPY.line}.`);
  if (superseded) sentences.push(`${noActive ? MIDI_COPY.noActiveText : MIDI_COPY.takeoverText}.`);
  return { visible: sentences.length > 0, text: sentences.join(' '), takeBack: superseded };
}

const SOUND_STATES = Object.freeze(Object.keys(SOUND_LABELS));

/**
 * The transport: one decision for the Play/Stop button and the state word.
 * `playing` is exactly the page's own rule: the sound state says playing, this tab did not lose the role, and
 * something was evaluated successfully. The word is `Playing` or `Stopped` only (`Sound off` and `Silent` stay in
 * SOUND_LABELS for their tests but are not shown); `here` is true while this tab lost the role (the view adds the
 * long part ' here'); `label` and `action` name what a press does now. `disabledReason` is null while playing
 * (Stop is never disabled) and otherwise the lost-tab reason, then the empty-editor reason, else null. `title` is
 * the reason when there is one, else the action's title. A state or flag out of range throws.
 */
export function transport({ soundState, superseded, hasEvaluatedSuccessfully, editorHasCode }) {
  if (!SOUND_STATES.includes(soundState)) {
    throw new Error(`Moontide: the soundState must be one of ${SOUND_STATES.join(', ')}, got ${JSON.stringify(soundState)}.`);
  }
  requireBoolean('superseded', superseded);
  requireBoolean('hasEvaluatedSuccessfully', hasEvaluatedSuccessfully);
  requireBoolean('editorHasCode', editorHasCode);
  const playing = soundState === 'playing' && !superseded && hasEvaluatedSuccessfully;
  let disabledReason = null;
  if (!playing) {
    if (superseded) disabledReason = BAR_COPY.playDisabledTab;
    else if (!editorHasCode) disabledReason = BAR_COPY.playDisabledEmpty;
  }
  return {
    playing,
    word: playing ? SOUND_LABELS.playing : SOUND_LABELS.stopped,
    here: superseded,
    label: playing ? BAR_COPY.stop : BAR_COPY.play,
    action: playing ? 'stop' : 'play',
    title: playing ? BAR_COPY.stopTitle : (disabledReason ?? BAR_COPY.playTitle),
    disabledReason,
  };
}

/**
 * The cycle and beat beside the tempo: decoration, drawn from the page's
 * 250 ms poll. `now` is the scheduler's position in cycles; like the page's other reads of it, a negative, NaN or
 * infinite value is clamped to 0, so this never throws. Returns { cycle, beat, text, title }: the cycle is the whole
 * part, the beat runs 1 to BEATS_PER_CYCLE within it, `text` is '34.2' and `title` 'Cycle 34, beat 2'. At tempos above
 * 240 BPM the poll skips some beats on screen; that is accepted.
 */
export function cycleBeat(now) {
  const position = Number.isFinite(now) && now > 0 ? now : 0;
  const cycle = Math.floor(position);
  const beat = Math.min(BEATS_PER_CYCLE, Math.floor((position - cycle) * BEATS_PER_CYCLE) + 1);
  return { cycle, beat, text: `${cycle}.${beat}`, title: `Cycle ${cycle}, beat ${beat}` };
}

/**
 * The tempo readout: always shown. Nothing plays gives the dash (`idle`, shown muted).
 * Otherwise `bpm` is the tempo of the music that plays and `waitingBpm` the tempo a waiting change brings (null or
 * undefined when it carries none). Both numbers go through the page's one rounding (`bpmText`: one decimal, a
 * trailing .0 dropped), so '118' and '118.5' read alike on both sides of the arrow. The arrow part shows only when
 * the waiting tempo differs from the playing one after that rounding. Returns { idle, num, arrow, unit, text, name,
 * title }: `arrow` is '→ 124' or '', `unit` is 'BPM' (the view puts the spaces), `text` the whole line and `name`
 * the accessible name. A number bpmText cannot format throws; the caller logs it and shows the idle form.
 */
export function tempoText({ playing, bpm, waitingBpm }) {
  requireBoolean('playing', playing);
  if (!playing) {
    return {
      idle: true,
      num: BAR_COPY.tempoNone,
      arrow: '',
      unit: BAR_COPY.tempoUnit,
      text: `${BAR_COPY.tempoNone} ${BAR_COPY.tempoUnit}`,
      name: BAR_COPY.tempoNameIdle,
      title: BAR_COPY.tempoTitleIdle,
    };
  }
  const num = bpmText(bpm);
  const hasWaiting = waitingBpm !== null && waitingBpm !== undefined;
  const waiting = hasWaiting ? bpmText(waitingBpm) : null;
  const changing = waiting !== null && waiting !== num;
  return {
    idle: false,
    num,
    arrow: changing ? `${BAR_COPY.tempoArrow} ${waiting}` : '',
    unit: BAR_COPY.tempoUnit,
    text: changing ? `${num} ${BAR_COPY.tempoArrow} ${waiting} ${BAR_COPY.tempoUnit}` : `${num} ${BAR_COPY.tempoUnit}`,
    name: changing ? `Tempo ${num} ${BAR_COPY.tempoUnit}, changing to ${waiting} ${BAR_COPY.tempoUnit}` : `Tempo ${num} ${BAR_COPY.tempoUnit}`,
    title: BAR_COPY.tempoTitle,
  };
}

const BANNER_KINDS = Object.freeze(['change', 'notice']);

/**
 * The failed-change banner. `kind` is 'change' (a failed evaluation: the
 * music was not replaced) or 'notice' (every other problem the error line reports). `message` is the whole error text;
 * `plays`, `pageStopped` and `hasEvaluatedSuccessfully` are the page's own values at the moment of the failure and
 * decide the one sentence that is true about the music, in a fixed order: never evaluated gives 'Nothing is playing
 * yet.', then stopped gives 'Sound is still stopped.', then playing gives 'The previous music keeps playing.', and any
 * other state (sound blocked, another tab) gives no sentence, never a false one. A notice has no sentence at all.
 *
 * Returns { kind, lead, consequence, line, full, drawn, multiline, showAsk, alert }: `line` is the one-line message
 * ('Error: <first line>'), `full` the message as given, `drawn` the text the Details box shows (cut at
 * PROBLEM_DRAWN_MAX with an ellipsis, so it never exceeds the cap), `multiline` whether the trimmed message holds more
 * than one non-empty line, `showAsk` whether the Ask Claude button applies and `alert` the text for the hidden alert
 * region ('' for a notice). An unknown kind, a non-boolean flag or a message that is not a string throws.
 */
export function bannerCopy({ kind, message, plays, pageStopped, hasEvaluatedSuccessfully }) {
  if (!BANNER_KINDS.includes(kind)) {
    throw new Error(`Moontide: the banner kind must be one of ${BANNER_KINDS.join(', ')}, got ${JSON.stringify(kind)}.`);
  }
  requireBoolean('plays', plays);
  requireBoolean('pageStopped', pageStopped);
  requireBoolean('hasEvaluatedSuccessfully', hasEvaluatedSuccessfully);
  if (typeof message !== 'string') {
    throw new Error(`Moontide: the banner message must be a string, got ${JSON.stringify(message)}.`);
  }
  const isChange = kind === 'change';
  let consequence = null;
  if (isChange) {
    if (!hasEvaluatedSuccessfully) consequence = BAR_COPY.consequenceNothing;
    else if (pageStopped) consequence = BAR_COPY.consequenceStopped;
    else if (plays) consequence = BAR_COPY.consequencePlaying;
  }
  const lead = isChange ? BAR_COPY.leadChange : BAR_COPY.leadNotice;
  const lines = message.split('\n').filter((line) => line.trim() !== '');
  return {
    kind,
    lead,
    consequence,
    line: errorLineText(message),
    full: message,
    drawn: message.length > PROBLEM_DRAWN_MAX ? `${message.slice(0, PROBLEM_DRAWN_MAX - 1)}…` : message,
    multiline: lines.length > 1,
    showAsk: isChange,
    alert: isChange ? (consequence === null ? lead : `${lead} ${consequence}`) : '',
  };
}
