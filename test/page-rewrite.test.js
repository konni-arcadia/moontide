import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';
import { createPageRewrite, PAGE_REWRITE_REFUSALS } from '../page/page-rewrite.js';
import { parseTiming } from '../page/change-timing.js';

// A page in miniature: an editor that holds a string, an evaluation that records what it was asked and a
// counter for every call the module makes outward, so the order and the number of calls can be asserted.
function makeRig(overrides = {}) {
  const rig = {
    text: 'a',
    playing: 'a',
    evaluated: true,
    waiting: null,
    open: true,
    parser: true,
    error: null,
    deferred: null,
    // What a dispatch leaves in the editor when a test wants the write to go wrong.
    dispatchResult: null,
    calls: [],
    evaluateArgs: [],
    reverts: 0,
    marks: 0,
    finishers: [],
    ...overrides,
  };
  const note = (name) => rig.calls.push(name);
  const editor = {
    get code() {
      return rig.text;
    },
    setCode(text) {
      note('setCode');
      rig.text = text;
    },
    dispatch(edits) {
      note('dispatch');
      if (rig.dispatchResult !== null) {
        rig.text = rig.dispatchResult;
        return;
      }
      // Edits are in the coordinates of the text before the write: apply them from the end.
      let text = rig.text;
      for (const edit of [...edits].sort((x, y) => y.from - x.from)) {
        text = text.slice(0, edit.from) + edit.insert + text.slice(edit.to);
      }
      rig.text = text;
    },
  };
  rig.pageRewrite = createPageRewrite({
    editor,
    hasEvaluated: () => rig.evaluated,
    pending: () => rig.waiting,
    playingCode: () => rig.playing,
    socketOpen: () => rig.open,
    parserReady: () => rig.parser,
    async evaluate(args) {
      note('evaluate');
      rig.evaluateArgs.push(args);
      if (rig.evaluateThrows) {
        if (rig.typeDuringEvaluate !== undefined) rig.text = rig.typeDuringEvaluate;
        throw rig.evaluateThrows;
      }
      return { timing: args.timing, deferred: rig.deferred };
    },
    evalError: () => rig.error,
    revertAndReport(error) {
      note('revertAndReport');
      rig.reverts += 1;
      rig.text = rig.playing;
      return { errorText: `failed: ${error.message}`, line: 3 };
    },
    markPageOrigin() {
      note('markPageOrigin');
      rig.marks += 1;
    },
    whenFinished(record, fn) {
      note('whenFinished');
      rig.finishers.push({ record, fn });
    },
    markPageOriginAtTakeover() {},
  });
  return rig;
}

const ADD_B = (base) => ({ code: `${base}b`, edits: [{ from: base.length, to: base.length, insert: 'b' }] });

test('each guard refuses with its own reason, in a fixed order, without touching the editor', async () => {
  const stages = [
    ['not-played', { evaluated: false, waiting: {}, open: false, parser: false, text: 'typed' }],
    ['waiting', { waiting: {}, open: false, parser: false, text: 'typed' }],
    ['closed', { open: false, parser: false, text: 'typed' }],
    ['no-parser', { parser: false, text: 'typed' }],
    ['dirty', { text: 'typed' }],
  ];
  for (const [reason, state] of stages) {
    const rig = makeRig(state);
    let built = 0;
    const result = await rig.pageRewrite.apply({
      build() {
        built += 1;
        return { code: 'x', edits: [] };
      },
    });
    assert.deepEqual(result, { status: 'refused', reason }, reason);
    assert.ok(PAGE_REWRITE_REFUSALS.includes(reason));
    assert.equal(built, 0, `${reason}: nothing is built`);
    assert.deepEqual(rig.calls, [], `${reason}: the editor and the evaluation are untouched`);
  }
});

test('an evaluation that throws sets the editor back to the base text and passes the error on', async () => {
  const boom = new Error('the repl broke');
  const rig = makeRig({ evaluateThrows: boom });
  await assert.rejects(rig.pageRewrite.apply({ build: ADD_B }), (err) => err === boom);
  assert.equal(rig.text, 'a', 'the written text is taken back');
  assert.equal(boom.restored, true, 'the error says the editor holds the base text again');
  assert.deepEqual(rig.calls, ['dispatch', 'evaluate', 'setCode']);
  assert.equal(rig.marks, 0, 'nothing is marked as played');

  const replaced = makeRig({ evaluateThrows: boom });
  await assert.rejects(replaced.pageRewrite.apply({ write: 'replace', build: () => ({ code: 'new', edits: null }) }), (err) => err === boom);
  assert.equal(replaced.text, 'a');
});

test('an evaluation that throws leaves the editor alone when the person typed over the written text meanwhile', async () => {
  const boom = new Error('the repl broke');
  const rig = makeRig({ evaluateThrows: boom, typeDuringEvaluate: 'ab and more typing' });
  await assert.rejects(rig.pageRewrite.apply({ build: ADD_B }), (err) => err === boom);
  assert.equal(rig.text, 'ab and more typing');
  assert.equal(boom.restored, undefined, 'the editor does not hold the base text: the error is not marked');
  assert.deepEqual(rig.calls, ['dispatch', 'evaluate']);
});

test('the refusal reasons are a frozen list', () => {
  assert.deepEqual([...PAGE_REWRITE_REFUSALS], ['not-played', 'waiting', 'closed', 'no-parser', 'dirty', 'write-mismatch']);
  assert.ok(Object.isFrozen(PAGE_REWRITE_REFUSALS));
});

test('a guard that is turned off lets its case through; an unknown guard is an error', async () => {
  const dirty = makeRig({ text: 'a typed' });
  const dirtyResult = await dirty.pageRewrite.apply({
    guards: { dirty: false },
    write: 'replace',
    build: () => ({ code: 'new', edits: null }),
  });
  assert.equal(dirtyResult.status, 'played');
  assert.equal(dirty.text, 'new');

  const waiting = makeRig({ waiting: {} });
  const waitingResult = await waiting.pageRewrite.apply({ guards: { waiting: false }, build: ADD_B });
  assert.equal(waitingResult.status, 'played');

  const rig = makeRig();
  await assert.rejects(
    rig.pageRewrite.apply({ guards: { sleepy: false }, build: ADD_B }),
    (err) => err instanceof Error && err.message.startsWith('Moontide: ') && err.message.includes('sleepy'),
  );
  assert.deepEqual(rig.calls, []);
});

test('writing by edits changes the text, evaluates it and reports the edits', async () => {
  const rig = makeRig();
  const result = await rig.pageRewrite.apply({ build: ADD_B });
  assert.equal(result.status, 'played');
  assert.equal(result.code, 'ab');
  assert.deepEqual(result.edits, [{ from: 1, to: 1, insert: 'b' }]);
  assert.equal(rig.text, 'ab');
  assert.deepEqual(rig.calls, ['dispatch', 'evaluate', 'markPageOrigin']);
  assert.equal(rig.evaluateArgs[0].code, 'ab');
});

test('a write that leaves another text sets the editor back and refuses without evaluating', async () => {
  const rig = makeRig({ dispatchResult: 'something else' });
  const result = await rig.pageRewrite.apply({ build: ADD_B });
  assert.deepEqual(result, { status: 'refused', reason: 'write-mismatch' });
  assert.equal(rig.text, 'a');
  assert.deepEqual(rig.calls, ['dispatch', 'setCode']);
});

test('writing the whole text sets it; a build that returns the base text gives unchanged', async () => {
  const rig = makeRig();
  const played = await rig.pageRewrite.apply({ write: 'replace', build: () => ({ code: 'whole', edits: null }) });
  assert.equal(played.status, 'played');
  assert.equal(rig.text, 'whole');
  assert.deepEqual(rig.calls, ['setCode', 'evaluate', 'markPageOrigin']);

  const same = makeRig();
  const unchanged = await same.pageRewrite.apply({ build: (base) => ({ code: base, edits: [] }) });
  assert.deepEqual(unchanged, { status: 'unchanged', code: 'a' });
  assert.deepEqual(same.calls, []);

  const evaluated = makeRig();
  const again = await evaluated.pageRewrite.apply({
    write: 'replace',
    evaluateUnchanged: true,
    build: (base) => ({ code: base, edits: null }),
  });
  assert.equal(again.status, 'played');
  assert.deepEqual(evaluated.calls, ['setCode', 'evaluate', 'markPageOrigin']);
});

test('a failed evaluation is reverted and reported once, and leaves no page-origin mark', async () => {
  const rig = makeRig({ error: new Error('boom') });
  const result = await rig.pageRewrite.apply({ build: ADD_B });
  assert.deepEqual(result, { status: 'failed', errorText: 'failed: boom', line: 3 });
  assert.equal(rig.reverts, 1);
  assert.equal(rig.marks, 0);
  assert.equal(rig.finishers.length, 0);
  assert.equal(rig.text, 'a');
});

test('an immediate success marks the page origin at once; a waiting one marks it at the takeover', async () => {
  const now = makeRig();
  await now.pageRewrite.apply({ build: ADD_B });
  assert.equal(now.marks, 1);
  assert.equal(now.finishers.length, 0);

  const record = { boundary: 8 };
  const later = makeRig({ deferred: record });
  const result = await later.pageRewrite.apply({ build: ADD_B, timing: parseTiming('bar') });
  assert.equal(result.status, 'played');
  assert.equal(result.run.deferred, record);
  assert.equal(later.marks, 0);
  assert.equal(later.finishers.length, 1);
  assert.equal(later.finishers[0].record, record);
  assert.equal(typeof later.finishers[0].fn, 'function');
});

test('timing, autostart and flash reach the evaluation; the defaults are at once, autostart on and no flash', async () => {
  const plain = makeRig();
  await plain.pageRewrite.apply({ build: ADD_B });
  assert.deepEqual(plain.evaluateArgs[0], { code: 'ab', timing: parseTiming('now'), autostart: true, flash: false });

  const timing = parseTiming('phrase');
  const custom = makeRig();
  await custom.pageRewrite.apply({ build: ADD_B, timing, autostart: false, flash: true });
  assert.deepEqual(custom.evaluateArgs[0], { code: 'ab', timing, autostart: false, flash: true });
});

test('the base defaults to the playing code, and a given base is what the dirty guard compares', async () => {
  const seen = [];
  const rig = makeRig({ text: 'queued', playing: 'old' });
  const dirty = await rig.pageRewrite.apply({
    build(base) {
      seen.push(base);
      return { code: base, edits: [] };
    },
  });
  assert.deepEqual(dirty, { status: 'refused', reason: 'dirty' });
  assert.deepEqual(seen, []);

  const clean = await rig.pageRewrite.apply({
    base: 'queued',
    build(base) {
      seen.push(base);
      return { code: `${base}!`, edits: [{ from: 6, to: 6, insert: '!' }] };
    },
  });
  assert.equal(clean.status, 'played');
  assert.deepEqual(seen, ['queued']);

  const defaults = makeRig({ text: 'old', playing: 'old' });
  await defaults.pageRewrite.apply({
    build(base) {
      seen.push(base);
      return { code: base, edits: [] };
    },
  });
  assert.equal(seen[1], 'old');
});

test('an error thrown by the build reaches the caller and nothing was written', async () => {
  const rig = makeRig();
  const boom = new Error('refused by the builder');
  await assert.rejects(
    rig.pageRewrite.apply({
      build() {
        throw boom;
      },
    }),
    (err) => err === boom,
  );
  assert.deepEqual(rig.calls, []);
  assert.equal(rig.text, 'a');
});

test('a page rewrite needs its dependencies and a build function', async () => {
  assert.throws(() => createPageRewrite(null), /Moontide: /);
  assert.throws(() => createPageRewrite({}), /Moontide: /);
  const rig = makeRig();
  await assert.rejects(rig.pageRewrite.apply({}), /Moontide: /);
  await assert.rejects(rig.pageRewrite.apply({ build: ADD_B, write: 'paste' }), /Moontide: .*paste/);
});

test('the legacy part launch configuration evaluates a dirty editor through the flashing route', async () => {
  const rig = makeRig({ text: 'typed but not evaluated', playing: 'playing', evaluated: false, open: false });
  const result = await rig.pageRewrite.apply({
    write: 'replace',
    flash: true,
    guards: { played: false, socket: false, dirty: false },
    build: (base) => ({ code: `${base} shifted`, edits: null }),
  });
  assert.equal(result.status, 'played');
  assert.equal(rig.text, 'playing shifted');
  assert.deepEqual(rig.evaluateArgs[0], { code: 'playing shifted', timing: parseTiming('now'), autostart: true, flash: true });
});

// --- the page keeps one copy of the path ---
//
// These read page/main.js with its comments blanked out (so a comment can neither satisfy nor break a check)
// and look at the syntax tree, not at the text, wherever a name could appear in a string.

const mainSource = readFileSync(fileURLToPath(new URL('../page/main.js', import.meta.url)), 'utf8');

function parseMain() {
  const comments = [];
  const ast = parse(mainSource, { ecmaVersion: 'latest', sourceType: 'module', onComment: comments });
  let code = mainSource;
  for (const comment of comments) {
    code = code.slice(0, comment.start) + code.slice(comment.start, comment.end).replace(/[^\n]/g, ' ') + code.slice(comment.end);
  }
  return { ast, code };
}

function walk(node, visit, ancestors = []) {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit, ancestors);
    return;
  }
  if (typeof node.type !== 'string') return;
  visit(node, ancestors);
  const next = [...ancestors, node];
  for (const [key, child] of Object.entries(node)) {
    if (key === 'type' || key === 'start' || key === 'end') continue;
    walk(child, visit, next);
  }
}

function functionNamed(ast, name) {
  const found = ast.body.find((node) => node.type === 'FunctionDeclaration' && node.id.name === name);
  assert.ok(found, `page/main.js declares ${name}`);
  return found;
}

function callsIn(node, calleeText) {
  const calls = [];
  walk(node, (inner) => {
    if (inner.type !== 'CallExpression') return;
    const callee = inner.callee;
    const text =
      callee.type === 'Identifier'
        ? callee.name
        : callee.type === 'MemberExpression' && callee.object.type === 'Identifier' && !callee.computed
          ? `${callee.object.name}.${callee.property.name}`
          : null;
    if (text === calleeText) calls.push(inner);
  });
  return calls;
}

test('the page sets the editor back to the committed code in exactly one place', () => {
  const { ast, code } = parseMain();
  const revert = functionNamed(ast, 'revertAndReport');
  const expression = "hasEvaluatedSuccessfully ? committedCode() : ''";
  assert.equal(code.split(expression).length - 1, 1, 'the revert expression appears once in the whole file');
  const inside = code.slice(revert.start, revert.end);
  assert.ok(inside.includes(expression), 'and it sits inside revertAndReport');
  const calls = callsIn(ast, 'committedCode');
  assert.equal(calls.length, 1, 'committedCode() is called once');
  assert.ok(calls[0].start >= revert.start && calls[0].end <= revert.end);
});

test('the Mixer and the part launch both go through the shared path', () => {
  const { ast } = parseMain();
  assert.equal(callsIn(functionNamed(ast, 'applyMixerChangeNow'), 'pageRewrite.apply').length, 1);
  assert.equal(callsIn(functionNamed(ast, 'launchPart'), 'pageRewrite.apply').length, 1);
  assert.equal(callsIn(ast, 'createPageRewrite').length, 1, 'one instance is created');
});

test("Claude's change handler and the reconnect replay share the revert helper", () => {
  const { ast } = parseMain();
  assert.equal(callsIn(functionNamed(ast, 'handleEvaluate'), 'revertAndReport').length, 1);
  // The reconnect replay is a block of the socket handler; find the block that builds the reconnect failure message.
  let replayBlocks = 0;
  walk(ast, (node, ancestors) => {
    if (node.type !== 'Literal' || node.value !== 'reconnect-eval-failed') return;
    const block = [...ancestors].reverse().find((ancestor) => ancestor.type === 'BlockStatement');
    assert.ok(block);
    assert.equal(callsIn(block, 'revertAndReport').length, 1, 'the replay reverts through revertAndReport');
    replayBlocks += 1;
  });
  assert.equal(replayBlocks, 1);
  assert.equal(callsIn(ast, 'revertAndReport').length, 2, 'no other place calls it directly: the shared path gets it as a dependency');
});
