// The top bar's pure model: the Session count and its copy. Node tests, no DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BAR_COPY, PROBLEM_DRAWN_MAX, SESSION_ISSUE_KEYS, bannerCopy, sessionButtonModel, sessionIssues, stripModel, tempoText, transport } from '../page/bar-model.js';
import { NOTHING_PLAYING_TAIL, STILL_PLAYING_TAIL, STILL_STOPPED_TAIL } from '../dist/session.js';
import { BUILD_MISMATCH_COPY, CONNECTION_LABELS, SERVER_UPDATED_COPY, SOUND_LABELS } from '../page/ui-state.js';
import { MIDI_COPY } from '../page/midi-plan.js';
import { bpmOf } from '../page/change-timing.js';

const CALM = { connection: 'connected', buildMismatch: false, serverUpdated: false, superseded: false, midiAttention: false };
const keys = (input) => sessionIssues({ ...CALM, ...input }).map((issue) => issue.key);

test('sessionIssues: all calm gives an empty list', () => {
  assert.deepEqual(sessionIssues(CALM), []);
});

test('sessionIssues: connecting and connected do not count, disconnected and refused each count once', () => {
  assert.deepEqual(keys({ connection: 'connecting' }), []);
  assert.deepEqual(keys({ connection: 'connected' }), []);
  assert.deepEqual(keys({ connection: 'disconnected' }), ['connection']);
  assert.deepEqual(keys({ connection: 'refused' }), ['connection']);
  const names = ['disconnected', 'refused'].map((connection) => sessionIssues({ ...CALM, connection })[0].name);
  assert.equal(new Set(names).size, 2, 'the two connection problems have different names');
  for (const name of names) assert.ok(name !== '', 'an issue has a name');
});

test('sessionIssues: a build mismatch counts', () => {
  assert.deepEqual(keys({ buildMismatch: true }), ['build']);
});

test('sessionIssues: the softer server-updated line counts, and never together with a build mismatch', () => {
  assert.deepEqual(keys({ serverUpdated: true }), ['updated']);
  assert.deepEqual(keys({ serverUpdated: true, buildMismatch: true }), ['build']);
});

test('sessionIssues: a tab that lost the role counts', () => {
  assert.deepEqual(keys({ superseded: true }), ['tab']);
});

test('sessionIssues: MIDI attention counts', () => {
  assert.deepEqual(keys({ midiAttention: true }), ['midi']);
});

test('sessionIssues: the order is connection, build or updated, tab, midi', () => {
  assert.deepEqual(keys({ connection: 'refused', buildMismatch: true, superseded: true, midiAttention: true }), ['connection', 'build', 'tab', 'midi']);
  assert.deepEqual(keys({ connection: 'disconnected', serverUpdated: true, superseded: true, midiAttention: true }), ['connection', 'updated', 'tab', 'midi']);
  assert.deepEqual(SESSION_ISSUE_KEYS, ['connection', 'build', 'updated', 'tab', 'midi']);
});

test('sessionIssues: a failed-change banner never counts (the function has no input for it)', () => {
  assert.deepEqual(sessionIssues({ ...CALM, failedChange: true }), []);
});

test('sessionIssues: an unknown connection state throws, and so does a flag that is not a boolean', () => {
  assert.throws(() => sessionIssues({ ...CALM, connection: 'asleep' }), /Moontide: .*connection/);
  assert.throws(() => sessionIssues({ ...CALM, connection: undefined }), /Moontide: .*connection/);
  assert.throws(() => sessionIssues({ ...CALM, buildMismatch: 'yes' }), /Moontide: .*buildMismatch/);
  assert.throws(() => sessionIssues({ ...CALM, midiAttention: undefined }), /Moontide: .*midiAttention/);
});

test('sessionButtonModel: zero issues draw no count; the name is Session and there is no title', () => {
  const model = sessionButtonModel([]);
  assert.deepEqual(model, { count: 0, label: 'Session', title: '' });
});

test('sessionButtonModel: the count is the length of the list; the title is "Needs you: " plus the names', () => {
  const issues = sessionIssues({ ...CALM, connection: 'disconnected', midiAttention: true });
  const model = sessionButtonModel(issues);
  assert.equal(model.count, 2);
  assert.equal(model.label, 'Session, 2 need you');
  assert.equal(model.title, `Needs you: ${issues.map((issue) => issue.name).join(', ')}`);
  assert.ok(model.title.startsWith(BAR_COPY.needsYou));
  assert.equal(BAR_COPY.needsYou, 'Needs you: ');
  assert.equal(sessionButtonModel(sessionIssues({ ...CALM, superseded: true })).label, 'Session, 1 need you');
});

test('sessionButtonModel: the five issues give a count of five', () => {
  const all = [
    ...sessionIssues({ ...CALM, connection: 'refused', buildMismatch: true, superseded: true, midiAttention: true }),
    ...sessionIssues({ ...CALM, serverUpdated: true }),
  ];
  assert.equal(sessionButtonModel(all).count, 5);
});

test('BAR_COPY holds the Ask Claude and popover words exactly', () => {
  assert.equal(BAR_COPY.ask, 'Ask Claude');
  assert.equal(BAR_COPY.askName, 'Ask Claude about this error');
  assert.ok(BAR_COPY.askName.toLowerCase().includes(BAR_COPY.ask.toLowerCase()), 'the visible word is contained in the accessible name');
  assert.equal(BAR_COPY.menuName, 'Error actions');
  assert.equal(BAR_COPY.menuCopy, 'Copy the error');
  assert.equal(BAR_COPY.menuAsk, 'Ask Claude about it');
  assert.equal(BAR_COPY.menuDismiss, 'Dismiss');
});

test('BAR_COPY holds the exact Session words', () => {
  assert.equal(BAR_COPY.session, 'Session');
  assert.equal(BAR_COPY.noChange, 'No change yet.');
  assert.equal(BAR_COPY.rightClickHint, 'Right-click anything to ask Claude.');
  assert.equal(BAR_COPY.midiHint, 'Instruments view: key 6.');
  assert.equal(BAR_COPY.settingsLabel, 'Your edits take over');
  assert.equal(BAR_COPY.timingNote, "Claude's changes say their own timing.");
  assert.equal(BAR_COPY.motionNote, 'Off stops the moving parts of the page.');
  assert.deepEqual([BAR_COPY.cardSession, BAR_COPY.cardMidi, BAR_COPY.cardRequests, BAR_COPY.cardSettings, BAR_COPY.cardChange], ['Session', 'MIDI', 'Page requests', 'Settings', 'Last change']);
  assert.equal(BAR_COPY.takeBack, MIDI_COPY.takeBack);
  assert.equal(BAR_COPY.takingOver, MIDI_COPY.takingOver);
});

test('stripModel: nothing to say gives no strip', () => {
  assert.deepEqual(stripModel({ buildMismatch: false, serverUpdated: false, superseded: false, noActive: false }), { visible: false, text: '', takeBack: false });
});

test('stripModel: the build line, the updated line and the lost-tab line, with the button only for the lost tab', () => {
  const build = stripModel({ buildMismatch: true, serverUpdated: false, superseded: false, noActive: false });
  assert.deepEqual(build, { visible: true, text: `${BUILD_MISMATCH_COPY.line}.${BAR_COPY.stripMidiRefused}`, takeBack: false });
  assert.ok(build.text.endsWith(' MIDI code is refused until then.'));
  const updated = stripModel({ buildMismatch: false, serverUpdated: true, superseded: false, noActive: false });
  assert.deepEqual(updated, { visible: true, text: `${SERVER_UPDATED_COPY.line}.`, takeBack: false });
  const tab = stripModel({ buildMismatch: false, serverUpdated: false, superseded: true, noActive: false });
  assert.deepEqual(tab, { visible: true, text: `${MIDI_COPY.takeoverText}.`, takeBack: true });
});

test('stripModel: a build mismatch wins over the updated line; no active tab changes the lost-tab sentence', () => {
  assert.equal(stripModel({ buildMismatch: true, serverUpdated: true, superseded: false, noActive: false }).text, `${BUILD_MISMATCH_COPY.line}.${BAR_COPY.stripMidiRefused}`);
  const noActive = stripModel({ buildMismatch: false, serverUpdated: false, superseded: true, noActive: true });
  assert.equal(noActive.text, `${MIDI_COPY.noActiveText}.`);
  const both = stripModel({ buildMismatch: true, serverUpdated: false, superseded: true, noActive: false });
  assert.equal(both.text, `${BUILD_MISMATCH_COPY.line}.${BAR_COPY.stripMidiRefused} ${MIDI_COPY.takeoverText}.`);
  assert.equal(both.takeBack, true);
});

test('the connection labels the Session card shows are the existing ones', () => {
  assert.equal(CONNECTION_LABELS.refused, 'Refused — reload the page');
});

// The transport (one Play/Stop button and the state word). The matrix runs over every input value.
const SOUND_STATES = ['off', 'silent', 'playing', 'stopped'];
const BOOLS = [false, true];
const ENABLED_PLAY_TITLE = 'Play: run the code in the editor (same as Ctrl+Enter)';
const STOP_TITLE = 'Stop: silence the music';

test('transport: playing is exactly the page rule over the whole matrix', () => {
  let cases = 0;
  for (const soundState of SOUND_STATES) {
    for (const superseded of BOOLS) {
      for (const hasEvaluatedSuccessfully of BOOLS) {
        for (const editorHasCode of BOOLS) {
          const model = transport({ soundState, superseded, hasEvaluatedSuccessfully, editorHasCode });
          const plays = soundState === 'playing' && !superseded && hasEvaluatedSuccessfully;
          const where = JSON.stringify({ soundState, superseded, hasEvaluatedSuccessfully, editorHasCode });
          assert.equal(model.playing, plays, `playing ${where}`);
          assert.equal(model.word, plays ? 'Playing' : 'Stopped', `word ${where}`);
          assert.equal(model.here, superseded, `here ${where}`);
          assert.equal(model.label, plays ? 'Stop' : 'Play', `label ${where}`);
          assert.equal(model.action, plays ? 'stop' : 'play', `action ${where}`);
          if (plays) {
            assert.equal(model.disabledReason, null, `Stop is never disabled ${where}`);
            assert.equal(model.title, STOP_TITLE, `title ${where}`);
          } else if (superseded) {
            assert.equal(model.disabledReason, 'This tab is silent: Moontide plays in another tab.', `reason ${where}`);
            assert.equal(model.title, model.disabledReason, `title ${where}`);
          } else if (!editorHasCode) {
            assert.equal(model.disabledReason, 'Nothing to play: the editor is empty.', `reason ${where}`);
            assert.equal(model.title, model.disabledReason, `title ${where}`);
          } else {
            assert.equal(model.disabledReason, null, `reason ${where}`);
            assert.equal(model.title, ENABLED_PLAY_TITLE, `title ${where}`);
          }
          assert.ok(!/space/i.test(model.title), `no title holds the word Space ${where}`);
          cases += 1;
        }
      }
    }
  }
  assert.equal(cases, 32);
});

test('transport: the word is Playing or Stopped only; Sound off and Silent are never shown', () => {
  const words = new Set();
  for (const soundState of SOUND_STATES) {
    for (const superseded of BOOLS) {
      for (const hasEvaluatedSuccessfully of BOOLS) {
        words.add(transport({ soundState, superseded, hasEvaluatedSuccessfully, editorHasCode: true }).word);
      }
    }
  }
  assert.deepEqual([...words].sort(), [SOUND_LABELS.playing, SOUND_LABELS.stopped].sort());
  assert.ok(!words.has(SOUND_LABELS.off) && !words.has(SOUND_LABELS.silent));
});

test('transport: the lost-tab reason wins over the empty-editor reason, and playing wins over both', () => {
  const both = transport({ soundState: 'stopped', superseded: true, hasEvaluatedSuccessfully: true, editorHasCode: false });
  assert.equal(both.disabledReason, BAR_COPY.playDisabledTab);
  const live = transport({ soundState: 'playing', superseded: false, hasEvaluatedSuccessfully: true, editorHasCode: false });
  assert.equal(live.disabledReason, null);
  assert.equal(live.action, 'stop');
});

test('transport: a state the page cannot be in, or a flag that is not a boolean, throws', () => {
  const ok = { soundState: 'stopped', superseded: false, hasEvaluatedSuccessfully: false, editorHasCode: true };
  assert.throws(() => transport({ ...ok, soundState: 'asleep' }), /Moontide: .*soundState/);
  assert.throws(() => transport({ ...ok, soundState: undefined }), /Moontide: .*soundState/);
  assert.throws(() => transport({ ...ok, superseded: 'no' }), /Moontide: .*superseded/);
  assert.throws(() => transport({ ...ok, hasEvaluatedSuccessfully: undefined }), /Moontide: .*hasEvaluatedSuccessfully/);
  assert.throws(() => transport({ ...ok, editorHasCode: 1 }), /Moontide: .*editorHasCode/);
});

test('BAR_COPY holds the exact transport words', () => {
  assert.equal(BAR_COPY.play, 'Play');
  assert.equal(BAR_COPY.stop, 'Stop');
  assert.equal(BAR_COPY.stateHere, ' here');
  assert.equal(BAR_COPY.playTitle, ENABLED_PLAY_TITLE);
  assert.equal(BAR_COPY.stopTitle, STOP_TITLE);
  assert.equal(BAR_COPY.playDisabledEmpty, 'Nothing to play: the editor is empty.');
  assert.equal(BAR_COPY.playDisabledTab, 'This tab is silent: Moontide plays in another tab.');
  assert.equal(BAR_COPY.playUseTakeBack, 'Use Play in this tab.');
});

// The tempo readout (always in the bar). The numbers come from bpmOf's rounding; the text is built here.
test('tempoText: nothing plays is a dash, in muted text, and a bpm given anyway is ignored', () => {
  const idle = { idle: true, num: '—', arrow: '', unit: 'BPM', text: '— BPM', name: 'No tempo, nothing plays', title: 'Nothing plays' };
  assert.deepEqual(tempoText({ playing: false }), idle);
  assert.deepEqual(tempoText({ playing: false, bpm: 118, waitingBpm: 124 }), idle);
});

test('tempoText: a tempo that plays is the number and BPM, with one decimal at most', () => {
  const whole = tempoText({ playing: true, bpm: 118 });
  assert.deepEqual(whole, { idle: false, num: '118', arrow: '', unit: 'BPM', text: '118 BPM', name: 'Tempo 118 BPM', title: 'Tempo of the music that plays' });
  assert.equal(tempoText({ playing: true, bpm: 118.5 }).text, '118.5 BPM');
  assert.equal(tempoText({ playing: true, bpm: 118.5 }).name, 'Tempo 118.5 BPM');
  assert.equal(tempoText({ playing: true, bpm: 118.04 }).text, '118 BPM', 'one decimal, a trailing .0 dropped');
  assert.equal(tempoText({ playing: true, bpm: bpmOf(0.5) }).text, '120 BPM');
});

test('tempoText: a waiting change with a new tempo shows the arrow, and the new tempo alone once it landed', () => {
  const waiting = tempoText({ playing: true, bpm: 118, waitingBpm: 124 });
  assert.equal(waiting.text, '118 → 124 BPM');
  assert.equal(waiting.num, '118');
  assert.equal(waiting.arrow, '→ 124');
  assert.equal(waiting.name, 'Tempo 118 BPM, changing to 124 BPM');
  const landed = tempoText({ playing: true, bpm: 124, waitingBpm: null });
  assert.equal(landed.text, '124 BPM');
  assert.equal(landed.arrow, '');
  assert.equal(tempoText({ playing: true, bpm: 118, waitingBpm: undefined }).arrow, '');
});

test('tempoText: a waiting tempo equal to the playing one after the rounding shows no arrow', () => {
  assert.equal(tempoText({ playing: true, bpm: 118.5, waitingBpm: 118.5 }).arrow, '');
  assert.equal(tempoText({ playing: true, bpm: 118.5, waitingBpm: 118.52 }).text, '118.5 BPM');
  assert.equal(tempoText({ playing: true, bpm: 118, waitingBpm: 118.4 }).text, '118 → 118.4 BPM');
});

test('tempoText: the longest text keeps one decimal on both numbers', () => {
  const longest = tempoText({ playing: true, bpm: 118.5, waitingBpm: 1000.5 });
  assert.equal(longest.text, '118.5 → 1000.5 BPM');
  assert.equal(longest.arrow, '→ 1000.5');
});

test('tempoText: a tempo bpmOf cannot format throws, for both numbers', () => {
  for (const bad of [0, -1, NaN, Infinity, '118', null, undefined]) {
    assert.throws(() => tempoText({ playing: true, bpm: bad }), /Moontide: /, `bpm ${String(bad)}`);
  }
  assert.throws(() => tempoText({ playing: true, bpm: 118, waitingBpm: 0 }), /Moontide: /);
  assert.throws(() => tempoText({ playing: true, bpm: 118, waitingBpm: NaN }), /Moontide: /);
  assert.throws(() => tempoText({ playing: 'yes', bpm: 118 }), /Moontide: .*playing/);
});

test('tempoText: the number part of the idle form and of a tempo share one rounding with bpmOf', () => {
  for (const cps of [0.5, 0.4917, 0.5183, 0.25, 2.5]) {
    const bpm = bpmOf(cps);
    assert.equal(tempoText({ playing: true, bpm }).num, String(bpm));
  }
});

// The tempo readout while a tempo ramp runs: the live tempo to a whole BPM, the arrow and the target, the bars left in the title.
test('tempoText: a ramp that rises reads the whole live number, the arrow and the target, with the bars left in the title', () => {
  const ramp = tempoText({ playing: true, bpm: 111.6, ramp: { targetBpm: 120, barsLeft: 3 } });
  assert.deepEqual(ramp, {
    idle: false,
    num: '112',
    arrow: '→ 120',
    unit: 'BPM',
    text: '112 → 120 BPM',
    name: 'Tempo 112 BPM, rising to 120 BPM',
    title: 'Tempo moving up to 120 BPM. 3 bars left.',
  });
});

test('tempoText: a ramp that falls says falling and moving down', () => {
  const ramp = tempoText({ playing: true, bpm: 108.2, ramp: { targetBpm: 100, barsLeft: 2 } });
  assert.equal(ramp.text, '108 → 100 BPM');
  assert.equal(ramp.name, 'Tempo 108 BPM, falling to 100 BPM');
  assert.equal(ramp.title, 'Tempo moving down to 100 BPM. 2 bars left.');
});

test('tempoText: a ramp keeps the decimal of its target and drops the arrow when the number reads like the target', () => {
  const half = tempoText({ playing: true, bpm: 119.6, ramp: { targetBpm: 120.5, barsLeft: 1 } });
  assert.equal(half.text, '120 → 120.5 BPM');
  const last = tempoText({ playing: true, bpm: 119.6, ramp: { targetBpm: 120, barsLeft: 1 } });
  assert.equal(last.num, '120');
  assert.equal(last.arrow, '');
  assert.equal(last.text, '120 BPM');
  assert.equal(last.name, 'Tempo 120 BPM, rising to 120 BPM');
  assert.equal(last.title, 'Tempo moving up to 120 BPM. 1 bar left.');
});

test('tempoText: a ramp that says its direction keeps it when the live tempo reads like the target', () => {
  const rising = tempoText({ playing: true, bpm: 120, ramp: { targetBpm: 120, barsLeft: 1, rising: true } });
  assert.equal(rising.name, 'Tempo 120 BPM, rising to 120 BPM');
  const falling = tempoText({ playing: true, bpm: 100, ramp: { targetBpm: 100, barsLeft: 1, rising: false } });
  assert.equal(falling.title, 'Tempo moving down to 100 BPM. 1 bar left.');
  assert.throws(() => tempoText({ playing: true, bpm: 110, ramp: { targetBpm: 120, barsLeft: 1, rising: 'up' } }), /Moontide: .*rising/);
});

test('tempoText: the bars left are a whole number from 1, singular for one', () => {
  assert.equal(tempoText({ playing: true, bpm: 110, ramp: { targetBpm: 120, barsLeft: 1 } }).title, 'Tempo moving up to 120 BPM. 1 bar left.');
  assert.equal(tempoText({ playing: true, bpm: 110, ramp: { targetBpm: 120, barsLeft: 64 } }).title, 'Tempo moving up to 120 BPM. 64 bars left.');
  for (const bad of [0, 2.5, -1, NaN, Infinity, '3', null, undefined]) {
    assert.throws(() => tempoText({ playing: true, bpm: 110, ramp: { targetBpm: 120, barsLeft: bad } }), /Moontide: .*bars left/, `barsLeft ${String(bad)}`);
  }
});

test('tempoText: a ramp with a bad target or a bad live tempo throws', () => {
  for (const bad of [0, -1, NaN, Infinity, '120', null, undefined]) {
    assert.throws(() => tempoText({ playing: true, bpm: 110, ramp: { targetBpm: bad, barsLeft: 2 } }), /Moontide: /, `target ${String(bad)}`);
    assert.throws(() => tempoText({ playing: true, bpm: bad, ramp: { targetBpm: 120, barsLeft: 2 } }), /Moontide: /, `bpm ${String(bad)}`);
  }
  assert.throws(() => tempoText({ playing: true, bpm: 110, ramp: 'up' }), /Moontide: .*ramp/);
});

test('tempoText: a ramp wins over a waiting change, and nothing plays is still the dash', () => {
  const both = tempoText({ playing: true, bpm: 111.6, waitingBpm: 90, ramp: { targetBpm: 120, barsLeft: 3 } });
  assert.equal(both.text, '112 → 120 BPM');
  assert.deepEqual(tempoText({ playing: false, bpm: 110, ramp: { targetBpm: 120, barsLeft: 3 } }), tempoText({ playing: false }));
});

test('tempoText: a call with no ramp returns what it returned before, for a null or an absent ramp', () => {
  for (const args of [{ playing: true, bpm: 118 }, { playing: true, bpm: 118.5, waitingBpm: 124 }, { playing: true, bpm: 118, waitingBpm: null }]) {
    assert.deepEqual(tempoText({ ...args, ramp: null }), tempoText(args));
    assert.deepEqual(tempoText({ ...args, ramp: undefined }), tempoText(args));
  }
});

test('tempoText: the ramp form is no wider than the widest waiting form', () => {
  const widest = tempoText({ playing: true, bpm: 118.5, waitingBpm: 1000.5 }).text.length;
  assert.ok(tempoText({ playing: true, bpm: 999.6, ramp: { targetBpm: 1000.5, barsLeft: 64 } }).text.length <= widest);
});

// The failed-change banner: the lead, the one sentence that is true about the music, the line, the capped
// text. The consequence is chosen in a fixed order and mirrors the server's three tails by hand.
const FAILED = { kind: 'change', message: 'SyntaxError: Unexpected token', plays: true, pageStopped: false, hasEvaluatedSuccessfully: true };

test('bannerCopy: a failed change that stopped nothing says the previous music keeps playing', () => {
  const model = bannerCopy(FAILED);
  assert.equal(model.kind, 'change');
  assert.equal(model.lead, 'Change failed.');
  assert.equal(model.consequence, 'The previous music keeps playing.');
  assert.equal(model.showAsk, true);
  assert.equal(model.alert, 'Change failed. The previous music keeps playing.');
});

test('bannerCopy: the consequence is chosen in a fixed order, never the playing sentence unless it is true', () => {
  const of = (input) => bannerCopy({ ...FAILED, ...input }).consequence;
  // Never evaluated wins over everything.
  assert.equal(of({ hasEvaluatedSuccessfully: false, pageStopped: true, plays: false }), 'Nothing is playing yet.');
  assert.equal(of({ hasEvaluatedSuccessfully: false, pageStopped: false, plays: false }), 'Nothing is playing yet.');
  // Stopped by the user comes before playing.
  assert.equal(of({ pageStopped: true, plays: false }), 'Sound is still stopped.');
  assert.equal(of({ pageStopped: true, plays: true }), 'Sound is still stopped.');
  // Playing.
  assert.equal(of({ pageStopped: false, plays: true }), 'The previous music keeps playing.');
  // Anything else (sound blocked, another tab): no sentence.
  assert.equal(of({ pageStopped: false, plays: false }), null);
});

test('bannerCopy: with no consequence the alert is the lead alone', () => {
  const model = bannerCopy({ ...FAILED, plays: false });
  assert.equal(model.consequence, null);
  assert.equal(model.alert, 'Change failed.');
});

test('bannerCopy: a notice has its own lead, no consequence, no Ask and nothing to announce', () => {
  const model = bannerCopy({ ...FAILED, kind: 'notice' });
  assert.equal(model.kind, 'notice');
  assert.equal(model.lead, 'Problem.');
  assert.equal(model.consequence, null);
  assert.equal(model.showAsk, false);
  assert.equal(model.alert, '');
});

test('bannerCopy: the two sentences equal the server tails, the playing one is the user-facing wording of the third', () => {
  const of = (input) => bannerCopy({ ...FAILED, ...input }).consequence;
  assert.equal(of({ hasEvaluatedSuccessfully: false }), NOTHING_PLAYING_TAIL);
  assert.equal(of({ pageStopped: true }), STILL_STOPPED_TAIL);
  assert.equal(STILL_PLAYING_TAIL, 'The previous code is still playing.', 'the server keeps its own wording');
  assert.equal(of({}), 'The previous music keeps playing.');
  assert.notEqual(of({}), STILL_PLAYING_TAIL);
  assert.equal(BAR_COPY.consequencePlaying, 'The previous music keeps playing.');
});

test('bannerCopy: line is the error line text, full is the message as given', () => {
  const message = '\n  \n  SyntaxError: bad token (line 9)\nsecond line\n';
  const model = bannerCopy({ ...FAILED, message });
  assert.equal(model.line, 'Error: SyntaxError: bad token (line 9)');
  assert.equal(model.full, message);
  assert.equal(model.multiline, true);
  assert.equal(bannerCopy({ ...FAILED, message: '   \n  ' }).line, 'Error: unknown error');
});

test('bannerCopy: what is drawn is cut at 4000 characters with an ellipsis, the full text never', () => {
  assert.equal(PROBLEM_DRAWN_MAX, 4000);
  const long = bannerCopy({ ...FAILED, message: 'x'.repeat(5000) });
  assert.equal(long.drawn.length, 4000);
  assert.ok(long.drawn.endsWith('…'));
  assert.equal(long.drawn, `${'x'.repeat(3999)}…`);
  assert.equal(long.full.length, 5000);
  const exact = bannerCopy({ ...FAILED, message: 'y'.repeat(4000) });
  assert.equal(exact.drawn, exact.full);
  assert.equal(exact.drawn.length, 4000);
});

test('bannerCopy: multiline is true for two non-empty lines and false for one line with whitespace around it', () => {
  const multi = (message) => bannerCopy({ ...FAILED, message }).multiline;
  assert.equal(multi('a\nb'), true);
  assert.equal(multi('a\n\n'), false);
  assert.equal(multi('  a  \n   '), false);
  assert.equal(multi('\n\na\n\nb'), true);
  assert.equal(multi('single'), false);
});

test('bannerCopy: an unknown kind, a non-boolean flag or a non-string message throws', () => {
  assert.throws(() => bannerCopy({ ...FAILED, kind: 'warning' }), /Moontide: .*kind/);
  assert.throws(() => bannerCopy({ ...FAILED, kind: undefined }), /Moontide: .*kind/);
  assert.throws(() => bannerCopy({ ...FAILED, plays: 'yes' }), /Moontide: .*plays/);
  assert.throws(() => bannerCopy({ ...FAILED, pageStopped: 1 }), /Moontide: .*pageStopped/);
  assert.throws(() => bannerCopy({ ...FAILED, hasEvaluatedSuccessfully: null }), /Moontide: .*hasEvaluatedSuccessfully/);
  assert.throws(() => bannerCopy({ ...FAILED, message: 42 }), /Moontide: .*message/);
});

// The cycle and beat beside the tempo, a pure formatter. Namespace import so a missing export fails inside each
// test and not at module load.
import * as barModel from '../page/bar-model.js';

test('cycleBeat: the cycle is the whole part and the beat is 1 to 4 within it', () => {
  assert.deepEqual(barModel.cycleBeat(34.3), { cycle: 34, beat: 2, text: '34.2', title: 'Cycle 34, beat 2' });
  assert.equal(barModel.cycleBeat(34.0).beat, 1);
  assert.equal(barModel.cycleBeat(34.99).beat, 4);
  assert.equal(barModel.cycleBeat(34.25).beat, 2, 'a beat starts exactly on its quarter');
  assert.equal(barModel.cycleBeat(34.75).beat, 4);
  assert.deepEqual(barModel.cycleBeat(0), { cycle: 0, beat: 1, text: '0.1', title: 'Cycle 0, beat 1' });
  assert.equal(barModel.cycleBeat(1234.5).text, '1234.3');
});

test('cycleBeat: a negative, NaN or infinite input is clamped to cycle 0, beat 1 and never throws', () => {
  for (const input of [-1, -0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.deepEqual(barModel.cycleBeat(input), { cycle: 0, beat: 1, text: '0.1', title: 'Cycle 0, beat 1' }, String(input));
  }
});

test('cycleBeat: the beat is always a whole number from 1 to 4, also just below a cycle line', () => {
  for (let i = 0; i < 4000; i += 1) {
    const { beat } = barModel.cycleBeat(i / 100 + 0.999999999);
    assert.ok(Number.isInteger(beat) && beat >= 1 && beat <= 4, `beat ${beat}`);
  }
});
