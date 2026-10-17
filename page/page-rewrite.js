// The one path through which the page itself changes the code: a Mixer move, a part launch, a grid
// gesture. It runs the guards in a fixed order, writes the new text and checks the write, makes one
// evaluation and, when that fails, sets the editor back and shows the failed-change banner through the
// same helper every other failure uses. Each caller keeps its own wording for a refusal and sends its own
// message to the server; this module only decides whether the text may change and whether it played.
// No DOM access at import time and every dependency injected, so node:test can import it with fakes.

import { parseTiming } from './change-timing.js';

// The reasons a change is refused before anything is written. A refusal never touches the editor, except
// write-mismatch, which sets the editor back to the text it had before the write.
export const PAGE_REWRITE_REFUSALS = Object.freeze(['not-played', 'waiting', 'closed', 'no-parser', 'dirty', 'write-mismatch']);

// The guards, in the order they run. Each one is on unless the request turns it off.
const GUARD_KEYS = Object.freeze(['played', 'waiting', 'socket', 'parser', 'dirty']);

const WRITES = Object.freeze(['dispatch', 'replace']);

const DEP_FUNCTIONS = Object.freeze([
  'hasEvaluated',
  'pending',
  'playingCode',
  'socketOpen',
  'parserReady',
  'evaluate',
  'evalError',
  'revertAndReport',
  'markPageOrigin',
  'whenFinished',
  'markPageOriginAtTakeover',
]);

function refused(reason) {
  return Object.freeze({ status: 'refused', reason });
}

/**
 * Builds the page's rewrite path around its dependencies:
 *   editor { code, setCode(text), dispatch(edits) }: the text the user sees; dispatch applies a list of
 *     { from, to, insert } edits in the coordinates of the text before the write, keeping selection and scroll,
 *   hasEvaluated() -> true once some code has played, pending() -> the waiting change or null,
 *   playingCode() -> the code that plays now, socketOpen() -> true while the server socket is open,
 *   parserReady() -> true when the code parser is loaded,
 *   evaluate({ code, timing, autostart, flash }) -> promise of the run ({ timing, deferred, ... }); flash true
 *     evaluates through the editor (it flashes), flash false through the repl directly,
 *   evalError() -> the evaluation's error or null,
 *   revertAndReport(error) -> { errorText, line }: sets the editor back to the committed code and shows the banner,
 *   markPageOrigin() -> the playing code now has no Claude evaluate id,
 *   whenFinished(record, fn) -> runs fn when the waiting change takes over; never when it is canceled (replaced or stopped),
 *   markPageOriginAtTakeover() -> the same mark, for the moment a waiting change takes over.
 */
export function createPageRewrite(deps) {
  if (deps === null || typeof deps !== 'object') {
    throw new Error('Moontide: createPageRewrite needs its dependencies.');
  }
  const editor = deps.editor;
  if (
    editor === null ||
    typeof editor !== 'object' ||
    typeof editor.setCode !== 'function' ||
    typeof editor.dispatch !== 'function' ||
    !('code' in editor)
  ) {
    throw new Error('Moontide: createPageRewrite needs an editor with code, setCode and dispatch.');
  }
  for (const name of DEP_FUNCTIONS) {
    if (typeof deps[name] !== 'function') {
      throw new Error(`Moontide: createPageRewrite needs the function ${name}.`);
    }
  }

  function readGuards(guards) {
    const on = {};
    for (const key of GUARD_KEYS) on[key] = true;
    if (guards === undefined) return on;
    if (guards === null || typeof guards !== 'object' || Array.isArray(guards)) {
      throw new Error('Moontide: the guards of a page rewrite are an object.');
    }
    for (const [key, value] of Object.entries(guards)) {
      if (!GUARD_KEYS.includes(key)) {
        throw new Error(`Moontide: unknown guard '${key}' in a page rewrite (expected one of ${GUARD_KEYS.join(', ')}).`);
      }
      if (typeof value !== 'boolean') {
        throw new Error(`Moontide: the guard '${key}' of a page rewrite is true or false.`);
      }
      on[key] = value;
    }
    return on;
  }

  /**
   * Applies one change to the code. See the request fields below; resolves one of
   *   { status: 'played', code, run, edits }  the text that was evaluated; run.deferred is the waiting change
   *       when the change waits for its line, else null,
   *   { status: 'unchanged', code }  the build left the text as it was and the request did not ask to evaluate it,
   *   { status: 'refused', reason }  one of PAGE_REWRITE_REFUSALS; nothing was written,
   *   { status: 'failed', errorText, line }  the evaluation failed; the editor is already set back and the banner shown.
   *
   * Request:
   *   build(base) -> { code, edits }: the new text; edits is a list of { from, to, insert } in the coordinates of
   *     base for write 'dispatch' and may be null for write 'replace'. An error it throws reaches the caller as it is.
   *   base: the text the build starts from and the dirty guard compares with the editor (default: the playing code).
   *   timing: a parsed timing (default: at once). autostart: only used when flash is false (default true).
   *   flash: evaluate through the editor, which flashes (default false).
   *   write: 'dispatch' (default) changes the text by edits and checks the result; 'replace' sets the whole text.
   *   guards: any of played, waiting, socket, parser, dirty set to false to leave that guard out.
   *   evaluateUnchanged: also evaluate when the build left the text as it was (default false).
   */
  async function apply(request) {
    if (request === null || typeof request !== 'object' || typeof request.build !== 'function') {
      throw new Error('Moontide: a page rewrite needs a build function.');
    }
    const write = request.write === undefined ? 'dispatch' : request.write;
    if (!WRITES.includes(write)) {
      throw new Error(`Moontide: unknown write '${String(request.write)}' in a page rewrite (expected one of ${WRITES.join(', ')}).`);
    }
    const guards = readGuards(request.guards);
    const timing = request.timing === undefined ? parseTiming('now') : request.timing;
    const autostart = request.autostart === undefined ? true : request.autostart;
    const flash = request.flash === true;
    const evaluateUnchanged = request.evaluateUnchanged === true;

    if (guards.played && !deps.hasEvaluated()) return refused('not-played');
    if (guards.waiting && deps.pending() !== null) return refused('waiting');
    if (guards.socket && !deps.socketOpen()) return refused('closed');
    if (guards.parser && !deps.parserReady()) return refused('no-parser');
    const base = request.base === undefined ? deps.playingCode() : request.base;
    if (guards.dirty && editor.code !== base) return refused('dirty');

    const built = request.build(base);
    if (built === null || typeof built !== 'object' || typeof built.code !== 'string') {
      throw new Error('Moontide: the build of a page rewrite must return { code, edits }.');
    }
    const code = built.code;
    const edits = Array.isArray(built.edits) ? built.edits : null;
    if (code === base && !evaluateUnchanged) {
      return Object.freeze({ status: 'unchanged', code });
    }

    if (write === 'dispatch') {
      if (edits === null && code !== base) {
        throw new Error('Moontide: a page rewrite that writes by edits needs an edit list from its build.');
      }
      if (edits !== null && edits.length > 0) editor.dispatch(edits);
      if (editor.code !== code) {
        editor.setCode(base);
        return refused('write-mismatch');
      }
    } else {
      editor.setCode(code);
    }

    let run;
    try {
      run = await deps.evaluate({ code, timing, autostart, flash });
    } catch (err) {
      // The evaluation itself threw (not a program error, which is read from evalError below): nothing is armed, so the
      // text written above would sit in the editor as typing that was never evaluated. It is taken back, unless the
      // person typed over it meanwhile; the error goes on to the caller, marked `restored` when the editor holds the base
      // text again, so the caller can say the code is as it was.
      if (code !== base && editor.code === code) editor.setCode(base);
      if (editor.code === base && err !== null && typeof err === 'object' && Object.isExtensible(err)) err.restored = true;
      throw err;
    }
    if (run === null || typeof run !== 'object') {
      throw new Error('Moontide: the evaluation of a page rewrite must give back its run.');
    }
    const evalError = deps.evalError();
    if (evalError) {
      const { errorText, line } = deps.revertAndReport(evalError);
      return Object.freeze({ status: 'failed', errorText, line });
    }
    // A change the page makes by itself has no Claude evaluate id: at once when it plays at once, otherwise at
    // the moment it takes over (the old code, and its id, keep playing until then).
    if (run.deferred === null || run.deferred === undefined) {
      deps.markPageOrigin();
    } else {
      deps.whenFinished(run.deferred, deps.markPageOriginAtTakeover);
    }
    return Object.freeze({ status: 'played', code, run, edits });
  }

  return Object.freeze({ apply });
}
