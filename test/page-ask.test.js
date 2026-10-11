import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ASK_COPY,
  COUNTER_FROM,
  MAX_ASK_CONTEXT_LENGTH,
  askMessage,
  askTextProblem,
  counterText,
  createAskStatus,
  cutText,
  describeContext,
  cycleAt,
  lineAtY,
  placeBox,
  receivedText,
  refusalText,
  waitingText,
} from '../page/ask.js';
// Namespace import for partsAskState: a named import of a missing export is a
// module-load SyntaxError that crashes the whole file.
import * as ask from '../page/ask.js';
import { errorLineText } from '../page/ui-state.js';

// A code point outside the BMP: two UTF-16 units.
const PAIR = '\u{1F3B5}';

test('cutText leaves a string of exactly 200 units unchanged', () => {
  const text = 'a'.repeat(200);
  assert.equal(cutText(text), text);
});

test('cutText cuts a 201-unit string to 200 units ending with an ellipsis', () => {
  const cut = cutText('a'.repeat(201));
  assert.equal(cut.length, 200);
  assert.equal(cut, `${'a'.repeat(199)}…`);
});

test('cutText never splits a surrogate pair', () => {
  // 198 units, then a pair on units 199 and 200, then more.
  const cut = cutText(`${'a'.repeat(198)}${PAIR}bbb`);
  assert.ok(cut.length <= 200);
  assert.equal(cut, `${'a'.repeat(198)}…`);
  assert.doesNotMatch(cut, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  assert.doesNotMatch(cut, /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
});

test('cutText keeps an empty string empty', () => {
  assert.equal(cutText(''), '');
});

test('describeContext session gives Whole session', () => {
  assert.deepEqual(describeContext({ kind: 'session' }), { context: { kind: 'session' }, chip: 'Whole session' });
});

test('describeContext version with a label', () => {
  assert.deepEqual(describeContext({ kind: 'version', id: 12, label: 'slower drums' }), {
    context: { kind: 'version', id: 12, label: 'slower drums' },
    chip: 'Version v12 · slower drums',
  });
});

test('describeContext version without a label leaves the field out', () => {
  for (const label of [undefined, '']) {
    const { context, chip } = describeContext({ kind: 'version', id: 12, label });
    assert.equal(chip, 'Version v12');
    assert.deepEqual(context, { kind: 'version', id: 12 });
  }
});

test('describeContext version cuts a 300-character label in the field and the chip', () => {
  const { context, chip } = describeContext({ kind: 'version', id: 7, label: 'x'.repeat(300) });
  assert.equal(context.label.length, 200);
  assert.ok(context.label.endsWith('…'));
  assert.equal(chip.length, 200);
  assert.ok(chip.startsWith('Version v7 · '));
  assert.ok(chip.endsWith('…'));
});

test('describeContext line trims the text', () => {
  assert.deepEqual(describeContext({ kind: 'line', line: 3, text: '  note("c4 e4").s("piano")  ' }), {
    context: { kind: 'line', line: 3, text: 'note("c4 e4").s("piano")' },
    chip: 'Line 3 · note("c4 e4").s("piano")',
  });
});

test('describeContext line reads (empty) for a blank or spaces-only line', () => {
  for (const text of ['', '   ']) {
    assert.deepEqual(describeContext({ kind: 'line', line: 3, text }), {
      context: { kind: 'line', line: 3, text: '' },
      chip: 'Line 3 (empty)',
    });
  }
});

test('describeContext line keeps its number in front of a 500-character line', () => {
  const { context, chip } = describeContext({ kind: 'line', line: 3, text: 'y'.repeat(500) });
  assert.equal(context.text.length, 200);
  assert.equal(chip.length, 200);
  assert.ok(chip.startsWith('Line 3 · '));
});

test('describeContext track', () => {
  assert.deepEqual(describeContext({ kind: 'track', track: 'drums' }), {
    context: { kind: 'track', track: 'drums' },
    chip: 'Track drums',
  });
});

test('describeContext instrument gives the Instrument chip and the id as the context', () => {
  assert.deepEqual(describeContext({ kind: 'instrument', id: 'mt32' }), {
    context: { kind: 'instrument', id: 'mt32' },
    chip: 'Instrument mt32',
  });
});

test('describeContext error gives the Failed change chip and the first non-empty line as the context', () => {
  assert.deepEqual(describeContext({ kind: 'error', text: 'SyntaxError: x\nmore' }), {
    context: { kind: 'error', text: 'SyntaxError: x' },
    chip: 'Failed change \u00B7 SyntaxError: x',
  });
  assert.deepEqual(describeContext({ kind: 'error', text: '\n  \n   Error: padded   \nsecond' }), {
    context: { kind: 'error', text: 'Error: padded' },
    chip: 'Failed change \u00B7 Error: padded',
  });
});

test('describeContext error cuts a 500-character first line to 200 with an ellipsis and keeps the chip within 200', () => {
  const described = describeContext({ kind: 'error', text: 'e'.repeat(500) });
  assert.equal(described.context.text.length, MAX_ASK_CONTEXT_LENGTH);
  assert.ok(described.context.text.endsWith('\u2026'));
  assert.ok(described.chip.length <= MAX_ASK_CONTEXT_LENGTH);
  assert.ok(described.chip.startsWith('Failed change \u00B7 '));
  assert.ok(described.chip.endsWith('\u2026'));
});

test('describeContext error with no non-empty line says unknown error, and a text that is not a string throws', () => {
  for (const text of ['', ' \n \n\t']) {
    assert.deepEqual(describeContext({ kind: 'error', text }), {
      context: { kind: 'error', text: 'unknown error' },
      chip: 'Failed change \u00B7 unknown error',
    });
  }
  for (const bad of [{ kind: 'error' }, { kind: 'error', text: 12 }, { kind: 'error', text: null }]) {
    assert.throws(() => describeContext(bad), /^Error: Moontide:.*error.*text/, JSON.stringify(bad));
  }
  assert.throws(() => describeContext({ kind: 'error', text: 'x', moment: sampleMoment() }), /cannot carry a moment/);
});

test('errorAskPrefill is the lead, a blank line, the text and two newlines; a long text is cut at 1500 with an ellipsis', () => {
  const lead = 'The last change failed with this error:';
  assert.equal(ask.ASK_COPY.errorPrefillLead, lead);
  assert.equal(ask.ASK_COPY.errorChipLead, 'Failed change');
  assert.equal(ask.MAX_ERROR_PREFILL, 1500);
  assert.equal(ask.errorAskPrefill('Error: x\nline 2'), `${lead}\n\nError: x\nline 2\n\n`);
  const exact = 'a'.repeat(1500);
  assert.equal(ask.errorAskPrefill(exact), `${lead}\n\n${exact}\n\n`);
  const long = ask.errorAskPrefill('b'.repeat(5000));
  assert.equal(long, `${lead}\n\n${'b'.repeat(1499)}\u2026\n\n`);
  assert.ok(long.length < 2000);
  assert.throws(() => ask.errorAskPrefill(5), /^Error: Moontide:/);
});

test('describeContext fader with a value and with default', () => {
  assert.deepEqual(describeContext({ kind: 'fader', track: 'drums', value: '0.80' }), {
    context: { kind: 'fader', track: 'drums', value: '0.80' },
    chip: 'drums · fader 0.80',
  });
  assert.equal(describeContext({ kind: 'fader', track: 'drums', value: 'default' }).chip, 'drums · fader default');
});

test('describeContext send for reverb with a value and for delay moving', () => {
  assert.deepEqual(describeContext({ kind: 'send', track: 'drums', bus: 'reverb', value: '0.30' }), {
    context: { kind: 'send', track: 'drums', bus: 'reverb', value: '0.30' },
    chip: 'drums · reverb send 0.30',
  });
  assert.equal(
    describeContext({ kind: 'send', track: 'drums', bus: 'delay', value: 'moving' }).chip,
    'drums · delay send moving',
  );
});

test('describeContext effect shows (off) only while bypassed and keeps bypassed a boolean', () => {
  const on = describeContext({ kind: 'effect', track: 'bass', effect: 'Lowpass', bypassed: false });
  assert.equal(on.chip, 'bass · Lowpass');
  assert.deepEqual(on.context, { kind: 'effect', track: 'bass', effect: 'Lowpass', bypassed: false });
  const off = describeContext({ kind: 'effect', track: 'bass', effect: 'Lowpass', bypassed: true });
  assert.equal(off.chip, 'bass · Lowpass (off)');
  assert.equal(off.context.bypassed, true);
});

test('describeContext effect-param with a value, default, moving and a filter-move row', () => {
  assert.deepEqual(
    describeContext({ kind: 'effect-param', track: 'bass', effect: 'Lowpass', parameter: 'Cutoff', value: '1200 Hz' }),
    {
      context: { kind: 'effect-param', track: 'bass', effect: 'Lowpass', parameter: 'Cutoff', value: '1200 Hz' },
      chip: 'bass · Lowpass · Cutoff 1200 Hz',
    },
  );
  for (const value of ['default', 'moving']) {
    assert.equal(
      describeContext({ kind: 'effect-param', track: 'bass', effect: 'Lowpass', parameter: 'Resonance', value }).chip,
      `bass · Lowpass · Resonance ${value}`,
    );
  }
  assert.equal(
    describeContext({ kind: 'effect-param', track: 'bass', effect: 'Lowpass', parameter: 'From', value: '400 Hz' }).chip,
    'bass · Lowpass · From 400 Hz',
  );
});

test('describeContext bus with one orbit and with several, never carrying multipleOrbits', () => {
  const one = describeContext({ kind: 'bus', bus: 'reverb', orbit: 1, multipleOrbits: false });
  assert.equal(one.chip, 'Reverb bus');
  assert.deepEqual(one.context, { kind: 'bus', bus: 'reverb', orbit: 1 });
  const many = describeContext({ kind: 'bus', bus: 'reverb', orbit: 2, multipleOrbits: true });
  assert.equal(many.chip, 'Reverb bus · orbit 2');
  assert.deepEqual(many.context, { kind: 'bus', bus: 'reverb', orbit: 2 });
});

test('describeContext bus-param with values and with several orbits', () => {
  assert.deepEqual(describeContext({ kind: 'bus-param', bus: 'delay', orbit: 1, parameter: 'Feedback', value: '0.50' }), {
    context: { kind: 'bus-param', bus: 'delay', orbit: 1, parameter: 'Feedback', value: '0.50' },
    chip: 'Delay bus · Feedback 0.50',
  });
  for (const value of ['mixed', 'default']) {
    assert.equal(
      describeContext({ kind: 'bus-param', bus: 'reverb', orbit: 1, parameter: 'Size', value }).chip,
      `Reverb bus · Size ${value}`,
    );
  }
  const many = describeContext({
    kind: 'bus-param',
    bus: 'reverb',
    orbit: 2,
    parameter: 'Size',
    value: '4',
    multipleOrbits: true,
  });
  assert.equal(many.chip, 'Reverb bus · orbit 2 · Size 4');
  assert.equal('multipleOrbits' in many.context, false);
});

test('describeContext part with and without an owner', () => {
  assert.deepEqual(describeContext({ kind: 'part', name: 'verse' }), {
    context: { kind: 'part', name: 'verse' },
    chip: 'Part "verse"',
  });
  assert.deepEqual(describeContext({ kind: 'part', name: 'verse', owner: 'drums' }), {
    context: { kind: 'part', name: 'verse', owner: 'drums' },
    chip: 'Part "verse" · drums',
  });
});

test('describeContext lane with a cycle and on the gutter', () => {
  assert.deepEqual(describeContext({ kind: 'lane', track: 'hats', cycle: 17 }), {
    context: { kind: 'lane', track: 'hats', cycle: 17 },
    chip: 'Lane hats · cycle 17',
  });
  assert.deepEqual(describeContext({ kind: 'lane', track: 'hats' }), {
    context: { kind: 'lane', track: 'hats' },
    chip: 'Lane hats',
  });
});

test('describeContext note: each role gives its phrase and the fields it sends', () => {
  const phrases = {
    root: 'Note D \u00B7 root of D Dorian',
    scale: 'Note A \u00B7 in D Dorian',
    avoid: 'Note B \u00B7 to avoid in D Dorian',
    outside: 'Note Bb \u00B7 outside D Dorian',
    off: 'Note C# \u00B7 not in D Dorian',
  };
  const notes = { root: 'D', scale: 'A', avoid: 'B', outside: 'Bb', off: 'C#' };
  for (const [role, chip] of Object.entries(phrases)) {
    assert.deepEqual(describeContext({ kind: 'note', note: notes[role], role, scale: 'D Dorian' }), {
      context: { kind: 'note', note: notes[role], role, scale: 'D Dorian' },
      chip,
    });
  }
});

test('describeContext note: no role and no scale gives the bare note; only one of them throws', () => {
  assert.deepEqual(describeContext({ kind: 'note', note: 'D' }), { context: { kind: 'note', note: 'D' }, chip: 'Note D' });
  assert.throws(() => describeContext({ kind: 'note', note: 'D', role: 'root' }), /^Error: Moontide:.*note.*role and scale/);
  assert.throws(() => describeContext({ kind: 'note', note: 'D', scale: 'D Dorian' }), /^Error: Moontide:.*note.*role and scale/);
  assert.throws(() => describeContext({ kind: 'note', note: 'D', role: 'maybe', scale: 'D Dorian' }), /^Error: Moontide:.*note.*role/);
  assert.throws(() => describeContext({ kind: 'note', note: '' }), /^Error: Moontide:.*note/);
});

test('describeContext warning: a countdown, now, and no note to avoid', () => {
  assert.deepEqual(describeContext({ kind: 'warning', chord: 'Gm7', outside: 'Bb', avoid: 'B', seconds: 4, scale: 'D Dorian' }), {
    context: { kind: 'warning', chord: 'Gm7', outside: 'Bb', avoid: 'B', seconds: 4, scale: 'D Dorian' },
    chip: 'Warning \u00B7 Gm7 brings Bb, avoid B, in 4 s',
  });
  assert.equal(
    describeContext({ kind: 'warning', chord: 'Gm7', outside: 'Bb', avoid: 'B', seconds: 0, scale: 'D Dorian' }).chip,
    'Warning \u00B7 Gm7 brings Bb, avoid B, now',
  );
  assert.deepEqual(describeContext({ kind: 'warning', chord: 'Gm7', outside: 'Bb', seconds: 4, scale: 'D Dorian' }), {
    context: { kind: 'warning', chord: 'Gm7', outside: 'Bb', seconds: 4, scale: 'D Dorian' },
    chip: 'Warning \u00B7 Gm7 brings Bb, in 4 s',
  });
});

test('describeContext warning throws loudly on an empty chord, outside or scale and on a bad seconds value', () => {
  const ok = { kind: 'warning', chord: 'Gm7', outside: 'Bb', seconds: 4, scale: 'D Dorian' };
  assert.throws(() => describeContext({ ...ok, chord: '' }), /^Error: Moontide:.*warning.*chord/);
  assert.throws(() => describeContext({ ...ok, outside: '' }), /^Error: Moontide:.*warning.*outside/);
  assert.throws(() => describeContext({ ...ok, scale: '' }), /^Error: Moontide:.*warning.*scale/);
  assert.throws(() => describeContext({ ...ok, seconds: 2.5 }), /^Error: Moontide:.*warning.*seconds/);
  assert.throws(() => describeContext({ ...ok, seconds: -1 }), /^Error: Moontide:.*warning.*seconds/);
  assert.throws(() => describeContext({ ...ok, seconds: undefined }), /^Error: Moontide:.*warning.*seconds/);
});

test('describeContext throws loudly on an unknown kind', () => {
  assert.throws(() => describeContext({ kind: 'jam-note' }), /^Error: Moontide: unknown ask context kind/);
  assert.throws(() => describeContext(null), /^Error: Moontide: unknown ask context kind/);
});

test('describeContext throws loudly on a missing required name or number', () => {
  assert.throws(() => describeContext({ kind: 'track', track: '' }), /^Error: Moontide:.*track/);
  assert.throws(() => describeContext({ kind: 'instrument', id: '' }), /^Error: Moontide:.*instrument.*id/);
  assert.throws(() => describeContext({ kind: 'instrument' }), /^Error: Moontide:.*instrument.*id/);
  assert.throws(() => describeContext({ kind: 'fader', track: 'drums' }), /^Error: Moontide:.*fader.*value/);
  assert.throws(() => describeContext({ kind: 'version', label: 'x' }), /^Error: Moontide:.*version.*id/);
  assert.throws(() => describeContext({ kind: 'line', text: 'x' }), /^Error: Moontide:.*line/);
  assert.throws(() => describeContext({ kind: 'part' }), /^Error: Moontide:.*part.*name/);
});

test('every chip and string field is at most 200 units for 1000-character inputs', () => {
  const big = 'z'.repeat(1000);
  const descriptors = [
    { kind: 'version', id: 1, label: big },
    { kind: 'line', line: 1, text: big },
    { kind: 'track', track: big },
    { kind: 'instrument', id: big },
    { kind: 'error', text: big },
    { kind: 'fader', track: big, value: big },
    { kind: 'send', track: big, bus: 'reverb', value: big },
    { kind: 'effect', track: big, effect: big, bypassed: true },
    { kind: 'effect-param', track: big, effect: big, parameter: big, value: big },
    { kind: 'bus-param', bus: 'delay', orbit: 1, parameter: big, value: big, multipleOrbits: true },
    { kind: 'part', name: big, owner: big },
    { kind: 'lane', track: big, cycle: 3 },
    { kind: 'note', note: big, role: 'scale', scale: big },
    { kind: 'warning', chord: big, outside: big, avoid: big, seconds: 3, scale: big },
  ];
  for (const descriptor of descriptors) {
    const { context, chip } = describeContext(descriptor);
    assert.ok(chip.length <= MAX_ASK_CONTEXT_LENGTH, `${descriptor.kind} chip is ${chip.length} units`);
    for (const [key, value] of Object.entries(context)) {
      if (typeof value === 'string') {
        assert.ok(value.length <= MAX_ASK_CONTEXT_LENGTH, `${descriptor.kind}.${key} is ${value.length} units`);
      }
    }
  }
});

test('cycleAt maps the pointer fraction to a cycle inside the page', () => {
  assert.equal(cycleAt({ pageStart: 32, fraction: 0 }), 32);
  assert.equal(cycleAt({ pageStart: 32, fraction: 0.5 }), 48);
  assert.equal(cycleAt({ pageStart: 32, fraction: 0.9999 }), 63);
  assert.equal(cycleAt({ pageStart: 32, fraction: 1 }), 63);
  assert.equal(cycleAt({ pageStart: 32, fraction: 1.2 }), 63);
  assert.equal(cycleAt({ pageStart: 32, fraction: -0.1 }), 32);
});

test('lineAtY finds the 1-based line whose block holds y, else null', () => {
  const blocks = [
    { top: 0, height: 20 },
    { top: 20, height: 40 },
  ];
  assert.equal(lineAtY(blocks, 0), 1);
  assert.equal(lineAtY(blocks, 19.9), 1);
  assert.equal(lineAtY(blocks, 20), 2);
  assert.equal(lineAtY(blocks, 59), 2);
  assert.equal(lineAtY(blocks, 60), null);
  assert.equal(lineAtY(blocks, -1), null);
});

// --- Copy, counts, length rule, message priority, status timing, placement, Parts state ---

test('every ASK_COPY string equals its pinned text exactly', () => {
  assert.deepEqual(ASK_COPY, {
    boxLabel: 'Ask Claude',
    fieldLabel: 'Request for Claude',
    placeholder: 'Ask Claude…',
    hint: 'Enter sends · Shift+Enter new line · Esc closes',
    wholeSession: 'Whole session',
    currentChip: 'Current v',
    disconnected: 'Disconnected — asking Claude is off until Moontide reconnects.',
    notSent: 'This request was not sent. Press Enter to try again.',
    notSentToken: 'This request was not sent.',
    sent: 'Sent to Claude',
    received: 'Claude received it',
    waiting: 'Claude will see it on its next action',
    tooLong: 'request too long — 2000 characters at most.',
    lineTooLong: 'request too long to send — some characters take extra room, so shorten the text.',
    rateLimit: 'too many requests — wait a moment, then send again.',
    queueFull: 'Claude has too many requests waiting — send again after it has read them.',
    token: "Moontide refused this page's token — reload the page.",
    didNotConfirm: 'Moontide did not confirm the request — try again.',
    contextUnreadable: 'could not read what was right-clicked — this request is about the whole session.',
    partsAsk: 'Ask Claude to add sections',
    partsRequest: 'Organize this code into sections with arrange()',
    shiftRightClickTitle: "Shift + right-click keeps the browser's own menu.",
    errorChipLead: 'Failed change',
    errorPrefillLead: 'The last change failed with this error:',
  });
});

test('every refusal reaches the error line with its pinned copy', () => {
  assert.equal(errorLineText(refusalText('too-long')), 'Error: request too long — 2000 characters at most.');
  assert.equal(
    errorLineText(refusalText('line-too-long')),
    'Error: request too long to send — some characters take extra room, so shorten the text.',
  );
  assert.equal(errorLineText(refusalText('rate-limit')), 'Error: too many requests — wait a moment, then send again.');
  assert.equal(
    errorLineText(refusalText('queue-full')),
    'Error: Claude has too many requests waiting — send again after it has read them.',
  );
  assert.equal(errorLineText(refusalText('token')), "Error: Moontide refused this page's token — reload the page.");
  assert.equal(errorLineText(refusalText('invalid', 'bad context')), 'Error: Moontide refused the request (bad context).');
  assert.equal(errorLineText(ASK_COPY.didNotConfirm), 'Error: Moontide did not confirm the request — try again.');
});

test('an unreadable right-click context reaches the error line as one plain line, the thrown message only in the title', () => {
  const line = 'Error: could not read what was right-clicked — this request is about the whole session.';
  assert.equal(errorLineText(ASK_COPY.contextUnreadable), line);
  assert.equal(errorLineText(`${ASK_COPY.contextUnreadable}\nMoontide: ask context part needs a non-empty name`), line);
});

test('receivedText and waitingText use the singular copy for one and a count for several', () => {
  assert.equal(receivedText(1), 'Claude received it');
  assert.equal(waitingText(1), 'Claude will see it on its next action');
  assert.equal(receivedText(3), 'Claude received 3 requests');
  assert.equal(waitingText(2), 'Claude will see 2 requests on its next action');
});

test('askTextProblem: empty, too long, or fine, counted on the trimmed text', () => {
  assert.equal(askTextProblem(''), 'empty');
  assert.equal(askTextProblem('   \n '), 'empty');
  assert.equal(askTextProblem('x'.repeat(2000)), null);
  assert.equal(askTextProblem('x'.repeat(2001)), 'too-long');
  assert.equal(askTextProblem('  hi  '), null);
});

test('counterText shows from 1800 characters and says too long above 2000', () => {
  assert.equal(COUNTER_FROM, 1800);
  assert.equal(counterText(1799), null);
  assert.equal(counterText(1800), '1800 / 2000');
  assert.equal(counterText(2000), '2000 / 2000');
  assert.equal(counterText(2001), '2001 / 2000 — too long. Shorten it to send.');
});

test('askMessage shows at most one line, in the order disconnected, counter, not sent', () => {
  assert.equal(askMessage({ connected: false, length: 2500, notSent: true, tokenRefused: false }), ASK_COPY.disconnected);
  assert.equal(askMessage({ connected: true, length: 1900, notSent: true, tokenRefused: false }), '1900 / 2000');
  assert.equal(askMessage({ connected: true, length: 5, notSent: true, tokenRefused: false }), ASK_COPY.notSent);
  assert.equal(askMessage({ connected: true, length: 5, notSent: true, tokenRefused: true }), ASK_COPY.notSentToken);
  assert.equal(askMessage({ connected: true, length: 5, notSent: false, tokenRefused: false }), null);
  // A text within the limit whose line cannot fit says so, not "2000 characters at most", and a counter
  // below the limit gives way to it; over the limit the counter still says too long.
  assert.equal(askMessage({ connected: true, length: 2000, notSent: false, tokenRefused: false, lineTooLong: true }), ASK_COPY.lineTooLong);
  assert.equal(askMessage({ connected: true, length: 5, notSent: false, tokenRefused: false, lineTooLong: true }), ASK_COPY.lineTooLong);
  assert.equal(
    askMessage({ connected: true, length: 2001, notSent: false, tokenRefused: false, lineTooLong: true }),
    '2001 / 2000 — too long. Shorten it to send.',
  );
  assert.equal(askMessage({ connected: false, length: 5, notSent: false, tokenRefused: false, lineTooLong: true }), ASK_COPY.disconnected);
  assert.doesNotMatch(ASK_COPY.lineTooLong, /2000/);
});

/** A manual clock and timer list for the status machine: timers fire in time order. */
function statusHarness() {
  let clock = 0;
  let nextTimer = 1;
  const timers = new Map();
  const shown = [];
  const timedOut = [];
  const status = createAskStatus({
    render: (text) => shown.push({ at: clock, text }),
    onTimeout: (id) => timedOut.push(id),
    setTimer: (fn, ms) => {
      const id = nextTimer++;
      timers.set(id, { fn, at: clock + ms });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    now: () => clock,
  });
  function advance(ms) {
    const end = clock + ms;
    for (;;) {
      let dueId = null;
      let dueAt = Infinity;
      for (const [id, timer] of timers) {
        if (timer.at <= end && timer.at < dueAt) {
          dueId = id;
          dueAt = timer.at;
        }
      }
      if (dueId === null) break;
      const { fn } = timers.get(dueId);
      timers.delete(dueId);
      clock = dueAt;
      fn();
    }
    clock = end;
  }
  return { status, advance, shown, timedOut, timers, at: () => clock };
}

test('status: sent shows Sent to Claude at once', () => {
  const h = statusHarness();
  h.status.sent('a');
  assert.deepEqual(h.shown, [{ at: 0, text: 'Sent to Claude' }]);
});

test('status: Claude received it waits for the 600 ms minimum, then hides 4 s later', () => {
  const h = statusHarness();
  h.status.sent('a');
  h.advance(5);
  h.status.answered({ id: 'a', status: 'received' });
  h.advance(594);
  assert.equal(h.shown.length, 1, 'Sent to Claude is still the text on screen at 599 ms');
  h.advance(1);
  assert.deepEqual(h.shown[1], { at: 600, text: 'Claude received it' });
  h.advance(3999);
  assert.equal(h.shown.length, 2);
  h.advance(1);
  assert.deepEqual(h.shown[2], { at: 4600, text: null });
});

test('status: several waiting requests read the count form and stay past 10 s', () => {
  const h = statusHarness();
  h.status.sent('a');
  h.advance(700);
  h.status.answered({ id: 'a', status: 'waiting', waiting: 2 });
  assert.deepEqual(h.shown[1], { at: 700, text: 'Claude will see 2 requests on its next action' });
  h.advance(10000);
  assert.equal(h.shown.length, 2, 'the waiting text is never hidden by a timer');
});

test('status: a hand-over after waiting shows Claude received it at least 600 ms after the waiting text', () => {
  const h = statusHarness();
  h.status.sent('a');
  h.advance(700);
  h.status.answered({ id: 'a', status: 'waiting', waiting: 1 });
  h.advance(100);
  h.status.handedOver(['a']);
  h.advance(500);
  assert.deepEqual(h.shown[2], { at: 1300, text: 'Claude received it' });
  h.advance(4000);
  assert.deepEqual(h.shown[3], { at: 5300, text: null });
});

test('status: a hand-over of two requests reads Claude received 2 requests', () => {
  const h = statusHarness();
  h.status.sent('a');
  h.advance(700);
  h.status.answered({ id: 'a', status: 'waiting', waiting: 1 });
  h.advance(700);
  h.status.sent('b');
  h.advance(700);
  h.status.answered({ id: 'b', status: 'waiting', waiting: 2 });
  h.advance(700);
  h.status.handedOver(['a', 'b']);
  assert.equal(h.shown.at(-1).text, 'Claude received 2 requests');
});

test('status: a refusal hides at once and cancels a scheduled text', () => {
  const h = statusHarness();
  h.status.sent('a');
  h.advance(5);
  h.status.answered({ id: 'a', status: 'received' });
  h.advance(100);
  h.status.sent('b');
  h.status.answered({ id: 'b', status: 'refused', reason: 'rate-limit' });
  assert.equal(h.shown.at(-1).text, null);
  const count = h.shown.length;
  h.advance(10000);
  assert.equal(h.shown.length, count, 'nothing scheduled comes back after the refusal');
  assert.equal(h.timers.size, 0);
});

test('status: no answer within 5000 ms calls onTimeout and hides', () => {
  const h = statusHarness();
  h.status.sent('a');
  h.advance(4999);
  assert.deepEqual(h.timedOut, []);
  h.advance(1);
  assert.deepEqual(h.timedOut, ['a']);
  assert.equal(h.shown.at(-1).text, null);
});

test('status: an answer for an older id clears its timer but does not change the display', () => {
  const h = statusHarness();
  h.status.sent('a');
  h.advance(10);
  h.status.sent('b');
  h.advance(700);
  const count = h.shown.length;
  h.status.answered({ id: 'a', status: 'received' });
  h.advance(700);
  assert.equal(h.shown.length, count, 'the display still describes the latest request');
  h.advance(4000);
  assert.deepEqual(h.timedOut, ['b'], 'only the latest request is left to time out');
});

test('status: dropAll calls onTimeout for each unconfirmed id and hides', () => {
  const h = statusHarness();
  h.status.sent('a');
  h.advance(10);
  h.status.sent('b');
  h.status.dropAll();
  assert.deepEqual(h.timedOut.sort(), ['a', 'b']);
  assert.equal(h.shown.at(-1).text, null);
  assert.equal(h.timers.size, 0);
});

// boxHeight is the box's height now (one field line); maxBoxHeight its height at six field lines.
const BOX = { boxWidth: 360, boxHeight: 120, maxBoxHeight: 300, viewportWidth: 1280, viewportHeight: 800, margin: 8, offset: 8 };

test('placeBox opens right of and below the pointer', () => {
  assert.deepEqual(placeBox({ ...BOX, pointerX: 100, pointerY: 100 }), { left: 108, top: 108, above: false });
});

test('placeBox opens left near the right edge', () => {
  assert.deepEqual(placeBox({ ...BOX, pointerX: 1270, pointerY: 100 }), { left: 1270 - 8 - 360, top: 108, above: false });
});

test('placeBox near the bottom edge opens above with its bottom edge right above the pointer', () => {
  const placed = placeBox({ ...BOX, pointerX: 100, pointerY: 790 });
  assert.deepEqual(placed, { left: 108, top: 662, above: true });
  assert.equal(placed.top + BOX.boxHeight, 790 - 8);
});

test('placeBox keeps the bottom edge and grows upward while the box opened above gets taller', () => {
  const placed = placeBox({ ...BOX, boxHeight: 200, above: true, pointerX: 100, pointerY: 790 });
  assert.deepEqual(placed, { left: 108, top: 582, above: true });
  assert.equal(placed.top + 200, 782);
});

test('placeBox opens left and above in the bottom-right corner', () => {
  assert.deepEqual(placeBox({ ...BOX, pointerX: 1270, pointerY: 790 }), { left: 902, top: 662, above: true });
});

test('placeBox chooses the side from the six-line height, not the current one', () => {
  // The one-line box would fit below, the six-line box would not.
  const placed = placeBox({ ...BOX, pointerX: 100, pointerY: 600 });
  assert.deepEqual(placed, { left: 108, top: 472, above: true });
  assert.equal(placed.top + BOX.boxHeight, 592);
});

test('placeBox below the pointer keeps its top while the box gets taller', () => {
  assert.deepEqual(placeBox({ ...BOX, pointerX: 100, pointerY: 400 }), { left: 108, top: 408, above: false });
  assert.deepEqual(placeBox({ ...BOX, boxHeight: 300, above: false, pointerX: 100, pointerY: 400 }), { left: 108, top: 408, above: false });
});

test('placeBox keeps the side it is given and clamps instead of flipping across the pointer', () => {
  assert.deepEqual(placeBox({ ...BOX, boxHeight: 300, above: false, pointerX: 100, pointerY: 500 }), {
    left: 108,
    top: 800 - 300 - 8,
    above: false,
  });
});

test('placeBox at the top-left corner keeps the margin', () => {
  assert.deepEqual(placeBox({ ...BOX, pointerX: 0, pointerY: 0 }), { left: 8, top: 8, above: false });
});

test('placeBox clamps a box larger than the viewport to the margin', () => {
  const placed = placeBox({ ...BOX, viewportWidth: 300, viewportHeight: 200, pointerX: 150, pointerY: 100 });
  assert.equal(placed.left, 8);
  assert.equal(placed.top, 8);
});

test('placeBox in a short window opens above and stays inside while the box grows', () => {
  const short = { ...BOX, viewportHeight: 300, pointerX: 100, pointerY: 150 };
  assert.deepEqual(placeBox(short), { left: 108, top: 22, above: true });
  const grown = placeBox({ ...short, boxHeight: 280, above: true });
  assert.equal(grown.top, 8);
  assert.ok(grown.top + 280 <= 300 - 8);
});

test('placeBox throws loudly without a finite maxBoxHeight', () => {
  for (const bad of [undefined, null, Number.NaN, '300']) {
    assert.throws(
      () => placeBox({ ...BOX, maxBoxHeight: bad, pointerX: 100, pointerY: 100 }),
      (error) => error instanceof Error && error.message.includes('maxBoxHeight'),
    );
  }
});

test('placeBox depends only on the pointer and the sizes it is given', () => {
  const first = placeBox({ ...BOX, pointerX: 640, pointerY: 400 });
  const again = placeBox({ ...BOX, pointerX: 640, pointerY: 400 });
  assert.deepEqual(first, again);
  assert.notDeepEqual(first, placeBox({ ...BOX, boxHeight: 100, pointerX: 640, pointerY: 700 }));
});

test('partsAskState: disconnected disables the button and gives the disconnected line', () => {
  assert.deepEqual(ask.partsAskState({ connected: false, pending: false, statusText: null }), {
    disabled: true,
    line: ASK_COPY.disconnected,
  });
});

test('partsAskState: pending disables the button and repeats the status', () => {
  assert.deepEqual(ask.partsAskState({ connected: true, pending: true, statusText: 'Sent to Claude' }), {
    disabled: true,
    line: 'Sent to Claude',
  });
});

test('partsAskState: connected and idle enables the button with no line', () => {
  assert.deepEqual(ask.partsAskState({ connected: true, pending: false, statusText: null }), {
    disabled: false,
    line: null,
  });
});

// --- the page-requests status ---

test('pageRequestsText gives the live and waiting copy for a boolean and throws loudly for anything else', () => {
  assert.equal(ask.PAGE_REQUESTS_COPY.live, 'Page requests: live');
  assert.equal(ask.PAGE_REQUESTS_COPY.waiting, 'Page requests: wait for Claude');
  assert.equal(ask.pageRequestsText(true), 'Page requests: live');
  assert.equal(ask.pageRequestsText(false), 'Page requests: wait for Claude');
  for (const bad of ['true', 1, null, undefined]) {
    assert.throws(() => ask.pageRequestsText(bad), (error) => error instanceof Error && error.message.startsWith('Moontide:'));
  }
});

test('no PAGE_REQUESTS_COPY text uses the word listen in any form', () => {
  for (const [key, value] of Object.entries(ask.PAGE_REQUESTS_COPY)) {
    assert.doesNotMatch(value, /listen/i, key);
  }
});

test('PAGE_REQUESTS_COPY equals its text exactly: the status words, the (i) and its popover', () => {
  assert.deepEqual(ask.PAGE_REQUESTS_COPY, {
    live: 'Page requests: live',
    waiting: 'Page requests: wait for Claude',
    infoText: 'i',
    infoLabel: 'How page requests work',
    helpIntro: 'Page requests are what you ask Claude with a right-click in this page.',
    appText: 'In the Code tab of the Claude app, ask Claude to turn page requests on or off.',
    onLead: 'In a terminal, type',
    onCommand: '/mcp__moontide__page-requests-on',
    onRest: 'to make them live, or',
    offCommand: '/mcp__moontide__page-requests-off',
    offRest: 'to make them wait.',
    monitorText:
      'Live, Claude runs a monitor that brings each request right away; a monitor lasts at most 30 minutes, and Claude restarts it when a tool reply asks. Waiting, requests reach Claude with its next action.',
  });
});

// --- describeContext with a moment ---

/** A moment as page/timeline.js builds it, by hand, with neutral names. */
function sampleMoment(overrides = {}) {
  return {
    cycle: 34,
    beat: 3,
    at: 34.5,
    version: 12,
    notes: [
      { track: 'lead', note: 'g4', velocity: 0.35, start: 34.5, end: 34.75, state: 'sounding' },
      { track: 'chords', note: 'c3', velocity: 0.16, start: 34, end: 34.5, state: 'sounding' },
      { track: 'drums', sound: 'bd', velocity: 0.8, start: 34.5, end: 34.6, state: 'starts' },
    ],
    more: 0,
    ...overrides,
  };
}

test('describeContext lane with a moment gives the moment chip and returns the moment', () => {
  const moment = sampleMoment();
  assert.deepEqual(describeContext({ kind: 'lane', track: 'lead', cycle: 34, moment }), {
    context: { kind: 'lane', track: 'lead', cycle: 34 },
    chip: 'Lane lead · cycle 34, beat 3 · 3 notes',
    moment,
  });
});

test('the moment chip counts every note: no notes, 1 note, N notes and the rest in more', () => {
  const chipOf = (moment) => describeContext({ kind: 'lane', track: 'lead', cycle: 34, moment }).chip;
  assert.equal(chipOf(sampleMoment({ notes: [] })), 'Lane lead · cycle 34, beat 3 · no notes');
  assert.equal(chipOf(sampleMoment({ notes: sampleMoment().notes.slice(0, 1) })), 'Lane lead · cycle 34, beat 3 · 1 note');
  const thirty = Array.from({ length: 30 }, () => sampleMoment().notes[0]);
  assert.equal(chipOf(sampleMoment({ notes: thirty, more: 5 })), 'Lane lead · cycle 34, beat 3 · 35 notes');
});

test('a lane without a moment gives exactly what it always gave', () => {
  const described = describeContext({ kind: 'lane', track: 'hats', cycle: 17 });
  assert.deepEqual(Object.keys(described), ['context', 'chip']);
  assert.equal(described.chip, 'Lane hats · cycle 17');
});

test('a 1000-character lane name with a moment keeps the whole moment part in the chip', () => {
  const big = 'z'.repeat(1000);
  const { chip } = describeContext({ kind: 'lane', track: big, cycle: 34, moment: sampleMoment() });
  assert.ok(chip.length <= MAX_ASK_CONTEXT_LENGTH, `chip is ${chip.length} units`);
  assert.ok(chip.endsWith(' · cycle 34, beat 3 · 3 notes'), chip);
  assert.ok(chip.startsWith('Lane z'));
  assert.ok(chip.includes('\u2026'));
});

test('strings inside a moment are cut to 200 units, never through a surrogate pair, and the input is kept', () => {
  const big = 'y'.repeat(1000);
  const pairs = PAIR.repeat(300);
  const note = { track: big, instrument: pairs, sound: pairs + 'x', note: big, velocity: 0.5, start: 1, end: 2, state: 'sounding' };
  const moment = sampleMoment({ notes: [note] });
  const before = JSON.stringify(moment);
  const described = describeContext({ kind: 'lane', track: 'lead', cycle: 34, moment });
  const [cut] = described.moment.notes;
  for (const field of ['track', 'instrument', 'sound', 'note']) {
    assert.ok(cut[field].length <= MAX_ASK_CONTEXT_LENGTH, `${field} is ${cut[field].length} units`);
    assert.ok(cut[field].endsWith('\u2026'), field);
    assert.doesNotMatch(cut[field], /[\uD800-\uDBFF]\u2026$/u, `${field} is cut inside a pair`);
  }
  assert.equal(cut.velocity, 0.5);
  assert.equal(cut.start, 1);
  assert.equal(JSON.stringify(moment), before, 'the descriptor is not mutated');
  assert.equal(describeContext({ kind: 'lane', track: 'lead', cycle: 34, moment: sampleMoment({ notes: [{ ...note, note: 60 }] }) }).moment.notes[0].note, 60);
});

test('a moment note copies drum right after note, cut like sound, and refuses an empty or non-string drum', () => {
  const drumNote = { track: 'kit', instrument: 'mt32 \u00B7 ch 10', note: 36, drum: 'Acoustic Bass Drum', velocity: 0.9, start: 34.5, end: 34.6, state: 'starts' };
  const moment = sampleMoment({ notes: [drumNote] });
  const [copied] = describeContext({ kind: 'lane', track: 'kit', cycle: 34, moment }).moment.notes;
  assert.deepEqual(copied, drumNote);
  assert.deepEqual(Object.keys(copied), ['track', 'instrument', 'note', 'drum', 'velocity', 'start', 'end', 'state']);
  const long = describeContext({ kind: 'lane', track: 'kit', cycle: 34, moment: sampleMoment({ notes: [{ ...drumNote, drum: 'y'.repeat(1000) }] }) });
  assert.ok(long.moment.notes[0].drum.length <= MAX_ASK_CONTEXT_LENGTH && long.moment.notes[0].drum.endsWith('\u2026'));
  for (const bad of ['', 36, null, {}]) {
    assert.throws(
      () => describeContext({ kind: 'lane', track: 'kit', cycle: 34, moment: sampleMoment({ notes: [{ ...drumNote, drum: bad }] }) }),
      (err) => err instanceof Error && err.message.startsWith('Moontide: ask context lane') && err.message.includes('drum'),
      JSON.stringify(bad),
    );
  }
});

test('describeContext refuses a moment the page got wrong, loudly', () => {
  const thirtyThree = Array.from({ length: 33 }, () => sampleMoment().notes[0]);
  const note = sampleMoment().notes[0];
  const bad = [
    ['a lane cycle that differs from the moment cycle', { kind: 'lane', track: 'lead', cycle: 35, moment: sampleMoment() }],
    ['beat 0', { kind: 'lane', track: 'lead', cycle: 34, moment: sampleMoment({ beat: 0 }) }],
    ['beat 5', { kind: 'lane', track: 'lead', cycle: 34, moment: sampleMoment({ beat: 5 }) }],
    ['cycle -1', { kind: 'lane', track: 'lead', cycle: -1, moment: sampleMoment({ cycle: -1 }) }],
    ['version 0', { kind: 'lane', track: 'lead', cycle: 34, moment: sampleMoment({ version: 0 }) }],
    ['33 notes', { kind: 'lane', track: 'lead', cycle: 34, moment: sampleMoment({ notes: thirtyThree }) }],
    ['more -1', { kind: 'lane', track: 'lead', cycle: 34, moment: sampleMoment({ more: -1 }) }],
    ['an empty note track', { kind: 'lane', track: 'lead', cycle: 34, moment: sampleMoment({ notes: [{ ...note, track: '' }] }) }],
    ['a state of later', { kind: 'lane', track: 'lead', cycle: 34, moment: sampleMoment({ notes: [{ ...note, state: 'later' }] }) }],
    ['a start that is not finite', { kind: 'lane', track: 'lead', cycle: 34, moment: sampleMoment({ notes: [{ ...note, start: Number.NaN }] }) }],
    ['a negative velocity', { kind: 'lane', track: 'lead', cycle: 34, moment: sampleMoment({ notes: [{ ...note, velocity: -1 }] }) }],
    ['no cycle on the lane', { kind: 'lane', track: 'lead', moment: sampleMoment() }],
  ];
  for (const [what, descriptor] of bad) {
    assert.throws(() => describeContext(descriptor), (err) => err instanceof Error && err.message.startsWith('Moontide: ask context lane'), what);
  }
  assert.throws(
    () => describeContext({ kind: 'track', track: 'lead', moment: sampleMoment() }),
    (err) => err instanceof Error && err.message === 'Moontide: ask context track cannot carry a moment',
  );
  for (const kind of ['version', 'line', 'note', 'instrument', 'error']) {
    assert.throws(() => describeContext({ kind, moment: sampleMoment() }), /cannot carry a moment/, kind);
  }
});

test('describeContext session with a moment gives the Moment chip and returns the moment', () => {
  const moment = sampleMoment();
  assert.deepEqual(describeContext({ kind: 'session', moment }), {
    context: { kind: 'session' },
    chip: 'Moment · cycle 34, beat 3 · 3 notes',
    moment,
  });
});

test('describeContext session without a moment still gives exactly the whole session', () => {
  assert.deepEqual(describeContext({ kind: 'session' }), { context: { kind: 'session' }, chip: 'Whole session' });
});

test('describeContext part with a moment appends the moment part, the owner stays', () => {
  const moment = sampleMoment();
  assert.deepEqual(describeContext({ kind: 'part', name: 'one', moment }), {
    context: { kind: 'part', name: 'one' },
    chip: 'Part "one" · cycle 34, beat 3 · 3 notes',
    moment,
  });
  assert.deepEqual(describeContext({ kind: 'part', name: 'one', owner: 'drums', moment }), {
    context: { kind: 'part', name: 'one', owner: 'drums' },
    chip: 'Part "one" · drums · cycle 34, beat 3 · 3 notes',
    moment,
  });
  assert.deepEqual(describeContext({ kind: 'part', name: 'one' }), { context: { kind: 'part', name: 'one' }, chip: 'Part "one"' });
});

test('a 1000-character part name with a moment keeps the whole moment part in the chip', () => {
  const big = 'p'.repeat(1000);
  for (const descriptor of [{ kind: 'part', name: big }, { kind: 'part', name: 'one', owner: big }]) {
    const { chip } = describeContext({ ...descriptor, moment: sampleMoment() });
    assert.ok(chip.length <= MAX_ASK_CONTEXT_LENGTH, `chip is ${chip.length} units`);
    assert.ok(chip.endsWith(' · cycle 34, beat 3 · 3 notes'), chip);
    assert.ok(chip.includes('\u2026'));
  }
});

test('describeContext refuses a bad moment on a session or a part, loudly', () => {
  for (const descriptor of [{ kind: 'session' }, { kind: 'part', name: 'one' }]) {
    assert.throws(() => describeContext({ ...descriptor, moment: sampleMoment({ beat: 5 }) }), (err) => err instanceof Error && err.message.startsWith(`Moontide: ask context ${descriptor.kind}`));
    assert.throws(() => describeContext({ ...descriptor, moment: sampleMoment({ notes: Array.from({ length: 33 }, () => sampleMoment().notes[0]) }) }), /at most 32/);
  }
});

// The short forms shown at fit step 3. They are produced where the long text is
// produced, never by matching strings afterwards, and the long strings stay byte for byte.
test('the ask status short forms: Sent, Received, Waiting, and a count for several', () => {
  assert.deepEqual({ ...ask.ASK_SHORT_COPY }, { sent: 'Sent', received: 'Received', waiting: 'Waiting' });
  assert.equal(ask.receivedShortText(1), 'Received');
  assert.equal(ask.waitingShortText(1), 'Waiting');
  assert.equal(ask.receivedShortText(3), '3 received');
  assert.equal(ask.waitingShortText(12), '12 waiting');
  assert.equal(Object.isFrozen(ask.ASK_SHORT_COPY), true);
});

test('the ask status long strings are byte for byte what they were', () => {
  assert.equal(ASK_COPY.sent, 'Sent to Claude');
  assert.equal(ASK_COPY.received, 'Claude received it');
  assert.equal(ASK_COPY.waiting, 'Claude will see it on its next action');
  assert.equal(receivedText(12), 'Claude received 12 requests');
  assert.equal(waitingText(12), 'Claude will see 12 requests on its next action');
});

test('status: the render callback also receives the short form as a second argument', () => {
  let clock = 0;
  const timers = new Map();
  let next = 1;
  const calls = [];
  const status = createAskStatus({
    render: (...args) => calls.push(args),
    onTimeout: () => {},
    setTimer: (fn, ms) => {
      const id = next++;
      timers.set(id, { fn, at: clock + ms });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    now: () => clock,
  });
  const advance = (ms) => {
    clock += ms;
    for (const [id, timer] of [...timers]) {
      if (timer.at <= clock) {
        timers.delete(id);
        timer.fn();
      }
    }
  };
  status.sent('a');
  advance(700);
  status.answered({ id: 'a', status: 'waiting', waiting: 12 });
  advance(700);
  status.handedOver(['a']);
  advance(700);
  assert.deepEqual(calls[0], ['Sent to Claude', 'Sent']);
  assert.deepEqual(calls[1], ['Claude will see 12 requests on its next action', '12 waiting']);
  assert.deepEqual(calls[2], ['Claude received it', 'Received']);
  advance(5000);
  assert.deepEqual(calls[calls.length - 1], [null], 'hiding passes no text and no short form');
});
