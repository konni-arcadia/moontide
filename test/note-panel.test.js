// The words of the note panel under the Timeline lanes: every sentence comes from TIMELINE_COPY, an id the module does not know
// throws, and names that come from the code are cut before they reach a sentence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TIMELINE_COPY } from '../page/timeline.js';
import { NOTE_REASONS } from '../page/note-locate.js';
import { MAX_MIXER_LABEL_LENGTH } from '../page/mixer-model.js';
import {
  activeCursorName,
  activeNoteName,
  changeDroppedText,
  changeNotWrittenText,
  cursorPositionText,
  editTimeoutText,
  deltaText,
  hintText,
  limitText,
  namedText,
  noneText,
  noteHistoryLabel,
  noticeText,
  notesWords,
  pitchValueText,
  placesText,
  placesWords,
  positionText,
  previewText,
  rangePositionText,
  rangeWhereText,
  reasonText,
  refusalText,
  refusedPreviewText,
  requestReadyText,
  resultText,
  sectionList,
  standingText,
  stateWord,
  stepsDroppedText,
  stepsNotWrittenText,
  velocityFixedText,
  velocityLimitText,
  velocityPreviewText,
  velocityRefusalText,
  velocityValueText,
} from '../page/note-panel.js';

const EXPECTED_REASONS = {
  'no-token':
    'Made by a function or by chance, or written in a single-quoted string, so no single place in the code holds this note. Ask Claude to change it.',
  'no-pitch': 'This is a sample, not a pitched note, so there is no pitch to change. Ask Claude to change it.',
  several: 'Shaped by several places in the code (an added note or a factor like *2), so no one place can be edited. Ask Claude to change it.',
  degrees: "Written in degrees. The page doesn't edit those directly yet. Ask Claude to change it.",
  escape: "The string that holds this note has an escape sequence, so the page can't find the note in the code. Ask Claude to change it.",
  shifted: 'The pitch you hear is not the pitch written: something adds to it or copies it. Ask Claude to change it.',
  outside:
    "Written outside this track's own code (its statement, or its variations in a song), so the page doesn't edit it here. Ask Claude to change it.",
  shared: 'Comes from code shared by several tracks, so an edit here would change them too. Ask Claude to change it.',
};

test('every reason a note cannot be edited has its sentence, and an unknown one throws', () => {
  assert.deepEqual(Object.keys(TIMELINE_COPY.noteReasons), Object.keys(EXPECTED_REASONS));
  assert.deepEqual([...NOTE_REASONS].sort(), Object.keys(TIMELINE_COPY.noteReasons).sort());
  for (const id of NOTE_REASONS) assert.equal(reasonText(id), EXPECTED_REASONS[id], id);
  assert.throws(() => reasonText('nope'), /unknown reason 'nope'/);
  assert.throws(() => reasonText('toString'), /unknown reason 'toString'/);
  assert.throws(() => reasonText(undefined), /unknown reason/);
});

test('no sentence of the note panel judges the person: wrong, error, should and try are not used as words', () => {
  const strings = Object.entries(TIMELINE_COPY)
    .filter(([key]) => key.startsWith('note'))
    .flatMap(([, value]) => (typeof value === 'string' ? [value] : Object.values(value)));
  assert.ok(strings.length > 30);
  for (const text of strings) assert.doesNotMatch(text, /\b(wrong|errors?|should|try|tries)\b/i, text);
});

test('the identity of a note: the lane, where it is, the section of a song, and whether it can be edited', () => {
  assert.equal(noneText(), 'No note selected');
  assert.equal(positionText({ cycle: 12, beat: 3, section: null }), ' · cycle 12, beat 3');
  assert.equal(positionText({ cycle: 12, beat: 3 }), ' · cycle 12, beat 3');
  assert.equal(positionText({ cycle: 0, beat: 1, section: 'y' }), " · cycle 0, beat 1 · section 'y'");
  assert.equal(stateWord({ editable: true }), 'Editable');
  assert.equal(stateWord({ editable: false }), 'Not editable');
  // A section name from the code is cut like every name in a sentence.
  assert.match(positionText({ cycle: 1, beat: 1, section: 'x'.repeat(100) }), /section 'x{39}…'$/);
});

test('the pitch is the note as written, then its number; a number stays a number; a drum lane adds the drum', () => {
  assert.equal(pitchValueText({ noteText: 'c3', midi: 48, drum: null }), 'c3 · 48');
  assert.equal(pitchValueText({ noteText: 'C#4', midi: 61 }), 'C#4 · 61');
  assert.equal(pitchValueText({ noteText: 48, midi: 48, drum: null }), '48');
  assert.equal(pitchValueText({ noteText: 36, midi: 36, drum: 'Kick' }), '36 · Kick');
  assert.equal(pitchValueText({ noteText: 'c2', midi: 36, drum: 'Kick' }), 'c2 · 36 · Kick');
});

test('the velocity is shown with two decimals, and a velocity the Timeline cannot compute says so', () => {
  assert.equal(velocityValueText(0.8), '0.80');
  assert.equal(velocityValueText(1), '1.00');
  assert.equal(velocityValueText(0.125), '0.13');
  assert.equal(velocityValueText(undefined), 'unknown');
  assert.equal(velocityValueText(NaN), 'unknown');
});

test('the standing sentence names the token to rewrite, or gives the reason the note is refused', () => {
  assert.equal(standingText({ editable: true, seen: { token: { text: 'c3' } } }), 'An edit rewrites one token in the code: c3.');
  assert.equal(standingText({ editable: false, reason: 'degrees' }), EXPECTED_REASONS.degrees);
  assert.throws(() => standingText({ editable: false, reason: 'nope' }), /unknown reason/);
});

test('the hints: one for nothing selected, one for a note that can be edited, one for a refused note, one for a range', () => {
  assert.equal(hintText('none'), 'Click a note to edit it. Drag across an empty part of a lane to ask Claude about those cycles.');
  assert.match(hintText('editable'), /^Drag the note or press Up \/ Down/);
  assert.equal(hintText('refused'), 'Up, Down, Make a rest, − and + prepare a request for Claude. Nothing is sent until you press Enter.');
  assert.equal(hintText('range'), 'Press Enter or Ask Claude to ask about these cycles. Esc clears the range.');
  assert.equal(hintText('cursor'), 'Press Enter or Ask Claude to ask about this lane. Shift+Left or Shift+Right selects cycles.');
  assert.throws(() => hintText('lane'), /unknown note panel hint 'lane'/);
});

test('the name a screen reader gives the active note: lane, cycle, beat, note, velocity, then Editable or Not editable with the reason', () => {
  const editable = { track: 't1', cycle: 0, beat: 1, noteText: 'c3', velocity: 0.8, editable: true, reason: null };
  assert.equal(activeNoteName(editable), 't1, cycle 0, beat 1: note c3, velocity 0.80. Editable.');
  assert.equal(
    activeNoteName({ ...editable, track: 'a very long lane name that is shown whole', cycle: 12, beat: 3, noteText: '48', editable: false, reason: 'degrees' }),
    `a very long lane name that is shown whole, cycle 12, beat 3: note 48, velocity 0.80. Not editable. ${EXPECTED_REASONS.degrees}`,
  );
  assert.equal(activeNoteName({ ...editable, velocity: undefined }), 't1, cycle 0, beat 1: note c3, velocity unknown. Editable.');
  assert.throws(() => activeNoteName({ ...editable, editable: false, reason: 'nope' }), /unknown reason/);
});

test('the keyboard cursor on a lane without notes: the identity line and the name a screen reader gives it', () => {
  assert.equal(cursorPositionText(), ' · no notes on this page');
  assert.equal(activeCursorName({ lane: 'bass', cycle: 12 }), 'bass, cycle 12: no notes on this page.');
  assert.throws(() => activeCursorName({ lane: '', cycle: 1 }), /name of its lane/);
  assert.throws(() => activeCursorName({ lane: 'bass', cycle: 1.5 }), /whole cycle/);
});

test('the identity line of a range: the lane, the cycles (cycle for one), the section or the two sections, and the notes', () => {
  assert.equal(rangeWhereText('t1'), 'Range · t1');
  assert.equal(rangePositionText({ from: 2, to: 5, count: 3 }), ' · cycles 2 to 5 · 3 notes');
  assert.equal(`${rangeWhereText('t1')}${rangePositionText({ from: 2, to: 5, count: 3 })}`, 'Range · t1 · cycles 2 to 5 · 3 notes');
  assert.equal(rangePositionText({ from: 12, to: 12, count: 1 }), ' · cycle 12 · 1 note');
  assert.equal(rangePositionText({ from: 12, to: 12, count: 0 }), ' · cycle 12 · no notes');
  assert.equal(rangePositionText({ from: 12, to: 15, section: 'y', count: 14 }), " · cycles 12 to 15 · section 'y' · 14 notes");
  assert.equal(rangePositionText({ from: 12, to: 15, section: 'x', sectionTo: 'z', count: 0 }), " · cycles 12 to 15 · sections 'x' to 'z' · no notes");
  assert.equal(rangePositionText({ from: 12, to: 15, section: null, sectionTo: null, count: 2 }), ' · cycles 12 to 15 · 2 notes');
  // Names from the code are cut and cleaned like every name in a sentence.
  assert.ok(rangePositionText({ from: 1, to: 2, section: 's'.repeat(80), count: 1 }).includes(`'${'s'.repeat(39)}…'`));
  // A range that cannot be told throws, never a blank.
  assert.throws(() => rangeWhereText(''), /name of its lane/);
  assert.throws(() => rangePositionText({ from: 5, to: 4, count: 1 }), /whole cycles/);
  assert.throws(() => rangePositionText({ from: 1.5, to: 4, count: 1 }), /whole cycles/);
  assert.throws(() => rangePositionText({ from: 1, to: 4, count: -1 }), /count of notes/);
  assert.throws(() => rangePositionText({ from: 1, to: 4, sectionTo: 'z', count: 1 }), /first one/);
});

test('the notices come in the order of the Mixer and an unknown one throws', () => {
  assert.equal(noticeText('disconnected'), 'Disconnected — editing is off until Moontide reconnects.');
  assert.equal(noticeText('waiting'), 'A change is waiting for its bar line. Editing works again when it takes over.');
  assert.equal(noticeText('unevaluated'), 'The editor has changes that are not playing yet. Evaluate them first — editing works on the playing code.');
  assert.throws(() => noticeText('other'), /unknown note panel notice 'other'/);
});

test('the sentence of an outcome: changed, waiting for a bar or a phrase, a limit, a refusal, a failed evaluation', () => {
  assert.deepEqual(resultText({ kind: 'written', label: 'x', from: 'c3', to: 'c#3' }), { kind: 'result', text: 'Changed c3 to c#3.' });
  assert.deepEqual(resultText({ kind: 'waiting', label: 'x', from: 'c3', to: 'd3', at: 'bar' }), { kind: 'result', text: 'Waiting for the next bar — c3 becomes d3.' });
  assert.deepEqual(resultText({ kind: 'waiting', label: 'x', from: 'c3', to: 'd3', at: 'phrase' }), { kind: 'result', text: 'Waiting for the next phrase — c3 becomes d3.' });
  assert.throws(() => resultText({ kind: 'waiting', from: 'c3', to: 'd3', at: 'now' }), /timing 'bar' or 'phrase'/);
  assert.deepEqual(resultText({ kind: 'unchanged', limit: 'lowest' }), { kind: 'result', text: 'Already the lowest note.' });
  assert.deepEqual(resultText({ kind: 'unchanged', limit: 'highest' }), { kind: 'result', text: 'Already the highest note.' });
  assert.equal(resultText({ kind: 'unchanged' }), null);
  assert.deepEqual(resultText({ kind: 'failed' }), { kind: 'refused', text: 'The change did not evaluate, so the code is as it was. Ask Claude to make it.' });
  assert.deepEqual(resultText({ kind: 'refused', reason: 'stale' }), {
    kind: 'refused',
    text: 'That note changed in the code since you selected it. Nothing was changed. Select it again, or ask Claude.',
  });
  // An error nobody planned for is a sentence of the panel too.
  assert.deepEqual(resultText({ kind: 'refused', reason: 'error' }), {
    kind: 'refused',
    text: 'The page ran into a problem before it changed this note, so the code is as it was. Ask Claude to make the change.',
  });
  // An error at or after the write does not say the code is as it was, and does not send the person to Claude for it.
  assert.deepEqual(resultText({ kind: 'refused', reason: 'error', afterWrite: true }), {
    kind: 'refused',
    text: 'The page ran into a problem after it wrote this change, so check the code.',
  });
  assert.throws(() => resultText({ kind: 'nope' }), /unknown outcome 'nope'/);
});

test('the sentence of a rest: changed to a rest, waiting for a bar or a phrase; the kind of change must be known', () => {
  assert.deepEqual(resultText({ kind: 'written', what: 'rest', label: 'x', from: 'c3', to: '~' }), { kind: 'result', text: 'Changed c3 to a rest.' });
  assert.deepEqual(resultText({ kind: 'waiting', what: 'rest', label: 'x', from: 'c3', to: '~', at: 'bar' }), { kind: 'result', text: 'Waiting for the next bar — c3 becomes a rest.' });
  assert.deepEqual(resultText({ kind: 'waiting', what: 'rest', label: 'x', from: 'c3', to: '~', at: 'phrase' }), { kind: 'result', text: 'Waiting for the next phrase — c3 becomes a rest.' });
  assert.deepEqual(resultText({ kind: 'written', what: 'pitch', label: 'x', from: 'c3', to: 'd3' }), { kind: 'result', text: 'Changed c3 to d3.' });
  assert.throws(() => resultText({ kind: 'written', what: 'octave', from: 'c3', to: 'c4' }), /unknown kind of change 'octave'/);
});

test('every refusal has a sentence: the two of the edit and the six of the shared rewrite path; an unknown one throws', () => {
  assert.equal(refusalText('read-back'), "The page couldn't confirm this edit, so the code is as it was. Ask Claude to make it.");
  assert.equal(refusalText('closed'), noticeText('disconnected'));
  assert.equal(refusalText('waiting'), noticeText('waiting'));
  assert.equal(refusalText('dirty'), noticeText('unevaluated'));
  for (const reason of ['write-mismatch', 'not-played', 'no-parser']) assert.equal(refusalText(reason), TIMELINE_COPY.noteReadBack, reason);
  assert.equal(refusalText('error'), TIMELINE_COPY.noteEditError);
  assert.throws(() => refusalText('nope'), /unknown refusal 'nope'/);
});

test('the history entry names the track and the change, with names cut and the whole kept to the length the server keeps', () => {
  assert.equal(noteHistoryLabel({ track: 't1', from: 'c3', to: 'c#3' }), 'changed t1: c3 to c#3');
  assert.equal(noteHistoryLabel({ track: 't1', from: 'c3', rest: true }), 'changed t1: c3 to a rest');
  assert.equal(noteHistoryLabel({ track: 'x'.repeat(100), from: 'c3', to: 'd3' }), `changed ${'x'.repeat(39)}…: c3 to d3`);
  assert.ok(noteHistoryLabel({ track: 't1', from: 'c3', to: 'd3' }).length <= MAX_MIXER_LABEL_LENGTH);
});

test('the sentence of a drag names the note it comes from and the one it lands on, and the size of the change', () => {
  assert.equal(previewText({ from: 'c3', to: 'd3', semitones: 2 }), 'c3 → d3 (+2 semitones). Release to write.');
  assert.equal(previewText({ from: 'e3', to: 'd#3', semitones: -1 }), 'e3 → d#3 (-1 semitone). Release to write.');
  assert.equal(previewText({ from: 'c3', to: 'c4', semitones: 12 }), 'c3 → c4 (+1 octave). Release to write.');
  assert.equal(previewText({ from: 'c3', to: 'c1', semitones: -24 }), 'c3 → c1 (-2 octaves). Release to write.');
});

test('the size of a change reads in semitones, or in octaves when it is a whole number of them', () => {
  assert.deepEqual([1, 2, 11, 13, -1, -3].map(deltaText), ['+1 semitone', '+2 semitones', '+11 semitones', '+13 semitones', '-1 semitone', '-3 semitones']);
  assert.deepEqual([12, 24, -12, -36].map(deltaText), ['+1 octave', '+2 octaves', '-1 octave', '-3 octaves']);
  // No change and a fraction have no words: they throw, so they cannot be shown as a blank.
  assert.throws(() => deltaText(0), /other than 0/);
  assert.throws(() => deltaText(1.5), /whole number/);
});

test('the sentence while a refused note is dragged offers the request: raise or lower, by semitones or octaves', () => {
  assert.equal(refusedPreviewText(2), 'Release to ask Claude: raise this note by 2 semitones.');
  assert.equal(refusedPreviewText(1), 'Release to ask Claude: raise this note by 1 semitone.');
  assert.equal(refusedPreviewText(-12), 'Release to ask Claude: lower this note by 1 octave.');
  assert.equal(refusedPreviewText(-24), 'Release to ask Claude: lower this note by 2 octaves.');
  assert.equal(refusedPreviewText(-5), 'Release to ask Claude: lower this note by 5 semitones.');
  assert.throws(() => refusedPreviewText(0), /other than 0/);
  assert.throws(() => refusedPreviewText(1.5), /whole number/);
  assert.equal(requestReadyText(), 'Request ready in the Ask box. Nothing is sent until you press Enter.');
});

test('on a drum lane the preview names the drums at both ends, and a note the map does not name reads as the drum rows do', () => {
  assert.equal(
    previewText({ from: '36', to: '38', semitones: 2, drumFrom: 'Kick', drumTo: 'Snare' }),
    '36 Kick → 38 Snare (+2 semitones). Release to write.',
  );
  assert.equal(
    previewText({ from: '36', to: '37', semitones: 1, drumFrom: 'Kick', drumTo: { map: 'GM' } }),
    '36 Kick → 37 · not in GM (+1 semitone). Release to write.',
  );
  assert.equal(previewText({ from: '35', to: '36', semitones: 1, drumFrom: { map: 'GM' }, drumTo: 'Kick' }), '35 · not in GM → 36 Kick (+1 semitone). Release to write.');
});

test('the two limit sentences are the words of the contract and an unknown limit throws', () => {
  assert.equal(limitText('highest'), 'Already the highest note.');
  assert.equal(limitText('lowest'), 'Already the lowest note.');
  assert.throws(() => limitText('middle'), /unknown limit/);
});

test('names that come from the code are cut and kept as text in the preview', () => {
  const long = 'x'.repeat(100);
  const text = previewText({ from: long, to: 'd3', semitones: 1 });
  assert.ok(text.length < 100);
});

test('the sentence of steps that wait: pitch with its size, drum names kept, and velocity with two decimals', () => {
  assert.equal(previewText({ from: 'c3', to: 'd3', semitones: 2, waiting: true }), 'c3 → d3 (+2 semitones). Writing in a moment.');
  assert.equal(previewText({ from: 'c3', to: 'c4', semitones: 12, waiting: true }), 'c3 → c4 (+1 octave). Writing in a moment.');
  assert.equal(previewText({ from: 'c3', to: 'd3', semitones: 2 }), 'c3 → d3 (+2 semitones). Release to write.');
  assert.equal(previewText({ from: 'c2', to: 'd2', semitones: 2, drumFrom: 'Kick', drumTo: 'Snare', waiting: true }), 'c2 Kick → d2 Snare (+2 semitones). Writing in a moment.');
  assert.equal(velocityPreviewText({ from: 0.8, to: 0.9 }), 'Velocity 0.80 → 0.90. Writing in a moment.');
  assert.equal(velocityPreviewText({ from: 0.1, to: 0.2 }), 'Velocity 0.10 → 0.20. Writing in a moment.');
  assert.throws(() => velocityPreviewText({ from: undefined, to: 0.9 }), /finite number/);
});

test('the velocity sentences: the two limits, the words after a velocity that is fixed, the refusal, and the result', () => {
  assert.equal(velocityLimitText('lowest'), 'Velocity is already at the lowest (0.10).');
  assert.equal(velocityLimitText('highest'), 'Velocity is already at the highest (1.00).');
  assert.throws(() => velocityLimitText('middle'), /unknown limit 'middle'/);
  assert.equal(velocityFixedText(), 'fixed in the code');
  assert.equal(
    velocityRefusalText(),
    "The velocity of this note comes from something the page can't change here, like a signal or an option of .midi(). Ask Claude to change it.",
  );
  assert.equal(refusalText('velocity-fixed'), velocityRefusalText());
  assert.deepEqual(resultText({ kind: 'written', what: 'velocity', label: 'x', from: 'c3', to: '0.90' }), { kind: 'result', text: 'Velocity of c3 is now 0.90.' });
  assert.deepEqual(resultText({ kind: 'waiting', what: 'velocity', label: 'x', from: 'c3', to: '0.90', at: 'bar' }), { kind: 'result', text: 'Waiting for the next bar — c3 velocity becomes 0.90.' });
  assert.deepEqual(resultText({ kind: 'waiting', what: 'velocity', label: 'x', from: 'c3', to: '0.90', at: 'phrase' }), { kind: 'result', text: 'Waiting for the next phrase — c3 velocity becomes 0.90.' });
  assert.deepEqual(resultText({ kind: 'unchanged', what: 'velocity', limit: 'highest' }), { kind: 'result', text: 'Velocity is already at the highest (1.00).' });
  assert.deepEqual(resultText({ kind: 'unchanged', what: 'velocity', limit: 'lowest' }), { kind: 'result', text: 'Velocity is already at the lowest (0.10).' });
  assert.deepEqual(resultText({ kind: 'unchanged', what: 'pitch', limit: 'highest' }), { kind: 'result', text: 'Already the highest note.' });
  assert.equal(noteHistoryLabel({ track: 't1', from: 'c3', velocity: 0.9 }), 'changed t1: velocity of c3 to 0.90');
  assert.ok(noteHistoryLabel({ track: 'x'.repeat(100), from: 'c3', velocity: 0.9 }).length <= MAX_MIXER_LABEL_LENGTH);
});

// --- where a token plays ---

test('the sections of a token are listed in the words of the sentence and cut from five names on', () => {
  assert.equal(sectionList(['x']), "'x'");
  assert.equal(sectionList(['x', 'z']), "'x' and 'z'");
  assert.equal(sectionList(['x', 'y', 'z']), "'x', 'y' and 'z'");
  assert.equal(sectionList(['a', 'b', 'c', 'd']), "'a', 'b', 'c' and 'd'");
  assert.equal(sectionList(['a', 'b', 'c', 'd', 'e']), "'a', 'b', 'c' and 2 more");
  assert.equal(sectionList(['a', 'b', 'c', 'd', 'e', 'f']), "'a', 'b', 'c' and 3 more");
  assert.throws(() => sectionList([]), /at least one name/);
  // A name from the code is cut like every other.
  assert.ok(sectionList(['n'.repeat(100)]).length < 60);
});

test('the places sentence says where a token plays, and nothing for a token that plays in one place', () => {
  assert.equal(placesText({ count: 3, sections: ['x', 'z'] }), "Plays in 3 places: sections 'x' and 'z'. An edit changes all of them.");
  assert.equal(placesText({ count: 2, sections: ['x'] }), "Plays in 2 places: sections 'x'. An edit changes all of them.");
  assert.equal(placesText({ count: 1, sections: ['x'] }), null);
  assert.equal(placesText({ count: 0, sections: [] }), null);
  assert.equal(
    placesText({ count: 3, sections: ['x', 'z'], onPage: true }),
    "Plays in 3 places on this page: sections 'x' and 'z'. An edit changes every place it plays, on this page and after it.",
  );
  assert.equal(placesText({ perCycle: 2 }), 'This token draws 2 notes in each cycle. An edit changes all of them.');
  assert.equal(placesText({ perCycle: 1 }), null);
  assert.equal(placesText({}), null);
});

test('the standing sentence of an editable note is the places sentence once the places are known', () => {
  const info = { editable: true, seen: { token: { text: 'c3' } } };
  assert.equal(standingText(info), 'An edit rewrites one token in the code: c3.');
  assert.equal(standingText(info, { count: 1, sections: ['x'], onPage: false }), 'An edit rewrites one token in the code: c3.');
  assert.equal(standingText(info, { count: 3, sections: ['x', 'z'], onPage: false }), "Plays in 3 places: sections 'x' and 'z'. An edit changes all of them.");
  assert.equal(standingText({ ...info, perCycle: 2 }), 'This token draws 2 notes in each cycle. An edit changes all of them.');
  assert.equal(standingText({ editable: false, reason: 'degrees' }, { count: 3, sections: ['x'] }), reasonText('degrees'));
});

test('the preview, the result and the history entry repeat the count of places when it is above one', () => {
  assert.equal(placesWords(3), ' in 3 places');
  assert.equal(placesWords(3, true), ' in 3 places on this page');
  assert.equal(placesWords(1), '');
  assert.equal(placesWords(undefined), '');
  assert.equal(previewText({ from: 'c3', to: 'd3', semitones: 2, places: 3 }), 'c3 → d3 (+2 semitones), in 3 places. Release to write.');
  assert.equal(previewText({ from: 'c3', to: 'd3', semitones: 2, places: 3, waiting: true }), 'c3 → d3 (+2 semitones), in 3 places. Writing in a moment.');
  assert.equal(previewText({ from: 'c3', to: 'd3', semitones: 2, places: 3, onPage: true }), 'c3 → d3 (+2 semitones), in 3 places on this page. Release to write.');
  assert.equal(previewText({ from: 'c3', to: 'd3', semitones: 2, places: 1 }), 'c3 → d3 (+2 semitones). Release to write.');
  assert.equal(resultText({ kind: 'written', what: 'pitch', from: 'c3', to: 'd3', places: 3 }).text, 'Changed c3 to d3 in 3 places.');
  assert.equal(resultText({ kind: 'written', what: 'pitch', from: 'c3', to: 'd3' }).text, 'Changed c3 to d3.');
  assert.equal(resultText({ kind: 'written', what: 'rest', from: 'c3', places: 2 }).text, 'Changed c3 to a rest in 2 places.');
  assert.equal(resultText({ kind: 'written', what: 'pitch', from: 'c3', to: 'd3', places: 3, onPage: true }).text, 'Changed c3 to d3 in 3 places on this page.');
  assert.equal(noteHistoryLabel({ track: 't1', from: 'c3', to: 'd3', places: 3 }), 'changed t1: c3 to d3 in 3 places');
  assert.equal(noteHistoryLabel({ track: 't1', from: 'c3', rest: true, places: 3 }), 'changed t1: c3 to a rest in 3 places');
  assert.equal(noteHistoryLabel({ track: 't1', from: 'c3', to: 'd3' }), 'changed t1: c3 to d3');
});

test('a velocity number shared by several notes of the page is told in the preview and the result', () => {
  assert.equal(notesWords(4), ', for 4 notes on this page');
  assert.equal(notesWords(1), '');
  assert.equal(notesWords(0), '');
  assert.equal(velocityPreviewText({ from: 0.5, to: 0.6, notes: 4 }), 'Velocity 0.50 → 0.60, for 4 notes on this page. Writing in a moment.');
  assert.equal(velocityPreviewText({ from: 0.5, to: 0.6 }), 'Velocity 0.50 → 0.60. Writing in a moment.');
  assert.equal(resultText({ kind: 'written', what: 'velocity', from: 'c3', to: '0.60', notes: 4 }).text, 'Velocity of c3 is now 0.60, for 4 notes on this page.');
  assert.equal(resultText({ kind: 'written', what: 'velocity', from: 'c3', to: '0.60' }).text, 'Velocity of c3 is now 0.60.');
});

test('a velocity number that plays in several places names them like the pitch sentence does', () => {
  // The preview and the result say the places the same way, and "on this page" is said once.
  assert.equal(velocityPreviewText({ from: 0.5, to: 0.6, places: 3 }), 'Velocity 0.50 → 0.60 in 3 places. Writing in a moment.');
  assert.equal(velocityPreviewText({ from: 0.5, to: 0.6, places: 3, notes: 4 }), 'Velocity 0.50 → 0.60 in 3 places, for 4 notes on this page. Writing in a moment.');
  assert.equal(velocityPreviewText({ from: 0.5, to: 0.6, places: 3, onPage: true, notes: 4 }), 'Velocity 0.50 → 0.60 in 3 places on this page, for 4 notes. Writing in a moment.');
  assert.equal(velocityPreviewText({ from: 0.5, to: 0.6, places: 1 }), 'Velocity 0.50 → 0.60. Writing in a moment.');
  assert.equal(resultText({ kind: 'written', what: 'velocity', from: 'c3', to: '0.60', places: 3 }).text, 'Velocity of c3 is now 0.60 in 3 places.');
  assert.equal(resultText({ kind: 'written', what: 'velocity', from: 'c3', to: '0.60', places: 3, onPage: true, notes: 2 }).text, 'Velocity of c3 is now 0.60 in 3 places on this page, for 2 notes.');
  assert.equal(notesWords(4, true), ', for 4 notes');
  assert.equal(noteHistoryLabel({ track: 't1', from: 'c3', velocity: 0.6, places: 3 }), 'changed t1: velocity of c3 to 0.60 in 3 places');
  assert.equal(noteHistoryLabel({ track: 't1', from: 'c3', velocity: 0.6 }), 'changed t1: velocity of c3 to 0.60');
});

test('steps that were not written have a sentence of their own', () => {
  assert.equal(stepsNotWrittenText(), TIMELINE_COPY.noteStepsNotWritten);

  assert.equal(stepsDroppedText(), TIMELINE_COPY.noteStepsDropped);
  assert.match(stepsDroppedText(), /not written/);
});

test('a sentence about the edit of another note is named after it, with the note and the lane cut like every name, and the queue has its own sentences', () => {
  assert.equal(namedText({ note: 'c3', lane: 't1', text: 'Changed c3 to c#3.' }), 'c3 on t1: Changed c3 to c#3.');
  assert.equal(namedText({ note: 'c3', lane: 'x'.repeat(100), text: 'Done.' }), `c3 on ${'x'.repeat(39)}…: Done.`);
  assert.throws(() => namedText({ note: 'c3', lane: 't1', text: '' }), /needs its words/);
  assert.equal(changeDroppedText(), 'The change was not written: the note changed in the code. Select it again.');
  assert.equal(changeNotWrittenText(), 'The change you made was not written. Select the note and make it again.');
  assert.equal(editTimeoutText(), 'The page did not answer this edit in time, so check the code.');
});
