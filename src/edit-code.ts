/**
 * A pure exact-match edit set over the program text. No I/O and no Session import.
 *
 * Every replacement is built with indexOf, slice and string concatenation, never with String.prototype.replace
 * or replaceAll and never with a regular expression made from Claude's text: Strudel code holds `$:` and `${...}`,
 * and a replacement pattern would rewrite `$&`, `$1` and `$$`. indexOf is linear and needs no escaping, so a large
 * old_string or many matches stays bounded by the program size.
 */

export interface EditInput {
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

/** The offsets of one replacement's new text in the composed code, end exclusive; start === end for a deletion. */
export interface EditRange {
  start: number;
  end: number;
}

export type EditResult = { ok: true; code: string; ranges: EditRange[] } | { ok: false; problems: string[] };

/** The most edits one call may carry (also the zod cap of the tool). */
export const MAX_EDITS = 50;
/** Lines shown on each side of a changed line in the reply. */
export const EXCERPT_CONTEXT_LINES = 2;
/** The most refusal lines one refusal lists. */
export const MAX_LISTED_PROBLEMS = 5;
/** The most line numbers one refusal lists for one edit. */
export const MAX_LISTED_LINES = 5;
/** The most code points of old_string a refusal echoes. */
export const MAX_ECHO_CHARS = 80;
/** The most separate windows the reply excerpt shows. */
export const MAX_EXCERPT_HUNKS = 8;
/** The most characters the reply excerpt holds before it is cut. */
export const MAX_EXCERPT_CHARS = 1500;
/** The most code points of one excerpt line. */
export const MAX_EXCERPT_LINE_CHARS = 200;

const EXCERPT_HEADER = 'Lines of the code that will play (> marks a changed line):';
const EXCERPT_GAP = '  ...';
const EXCERPT_CUT = '  ... cut here; get_code returns the whole program.';

interface PlannedRange {
  start: number;
  end: number;
  edit: number;
  text: string;
}

/** CRLF counts as LF; a lone CR is left alone. Split and join: no pattern is involved. */
function toLf(text: string): string {
  return text.split('\r\n').join('\n');
}

/** The text of old_string as a JSON string, cut to MAX_ECHO_CHARS code points with an ellipsis inside the quotes. */
function echoOf(text: string): string {
  const points = Array.from(text);
  if (points.length <= MAX_ECHO_CHARS) return JSON.stringify(text);
  return `"${JSON.stringify(points.slice(0, MAX_ECHO_CHARS).join('')).slice(1, -1)}…"`;
}

/** Every start offset of the non-empty `needle` in `base`, stepping by one so overlapping matches of the same text count. */
function matchesOf(base: string, needle: string): number[] {
  const found: number[] = [];
  for (let at = base.indexOf(needle); at !== -1; at = base.indexOf(needle, at + 1)) found.push(at);
  return found;
}

/** The start offset of every line of `code`. */
function lineStarts(code: string): number[] {
  const starts = [0];
  for (let at = code.indexOf('\n'); at !== -1; at = code.indexOf('\n', at + 1)) starts.push(at + 1);
  return starts;
}

/** The 0-based index of the line that holds `offset`. */
function lineIndexOf(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if ((starts[mid] as number) <= offset) low = mid;
    else high = mid - 1;
  }
  return low;
}

/** `line 4`, `lines 2, 5, 9`, or `lines 1, 2, 3, 4, 5 and 3 more`: the distinct lines of the matches, in order. */
function linesText(starts: readonly number[], matches: readonly number[]): string {
  const distinct: number[] = [];
  for (const match of matches) {
    const line = lineIndexOf(starts, match) + 1;
    if (distinct[distinct.length - 1] !== line) distinct.push(line);
  }
  if (distinct.length === 1) return `line ${distinct[0]}`;
  const shown = distinct.slice(0, MAX_LISTED_LINES).join(', ');
  const more = distinct.length - MAX_LISTED_LINES;
  return more > 0 ? `lines ${shown} and ${more} more` : `lines ${shown}`;
}

/** At most MAX_LISTED_PROBLEMS problems, then a count of the rest. */
function capProblems(problems: string[]): string[] {
  if (problems.length <= MAX_LISTED_PROBLEMS) return problems;
  const more = problems.length - MAX_LISTED_PROBLEMS;
  return [...problems.slice(0, MAX_LISTED_PROBLEMS), `and ${more} more refused ${more === 1 ? 'edit' : 'edits'}`];
}

/**
 * Applies the edits all together or not at all. Each edit is matched against the code as it is before the call,
 * never against another edit's output; the result is built left to right from slices. CRLF counts as LF.
 */
export function applyEdits(rawBase: string, edits: readonly EditInput[]): EditResult {
  const base = toLf(rawBase);
  const starts = lineStarts(base);
  const n = edits.length;
  const problems: string[] = [];
  const planned: PlannedRange[] = [];
  edits.forEach((edit, index) => {
    const i = index + 1;
    const oldText = toLf(edit.old_string);
    const newText = toLf(edit.new_string);
    if (oldText === '') {
      problems.push(`edit ${i} of ${n}: old_string is empty`);
      return;
    }
    if (oldText === newText) {
      problems.push(`edit ${i} of ${n}: old_string and new_string are the same`);
      return;
    }
    const matches = matchesOf(base, oldText);
    const echo = echoOf(oldText);
    if (matches.length === 0) {
      problems.push(`edit ${i} of ${n}: old_string matches nowhere: ${echo}`);
      return;
    }
    if (edit.replace_all !== true) {
      if (matches.length > 1) {
        problems.push(
          `edit ${i} of ${n}: old_string matches ${matches.length} times (${linesText(starts, matches)}); add surrounding text so it matches once, or set replace_all: ${echo}`,
        );
        return;
      }
    } else {
      for (let k = 1; k < matches.length; k++) {
        if ((matches[k] as number) < (matches[k - 1] as number) + oldText.length) {
          problems.push(
            `edit ${i} of ${n}: old_string matches in places that overlap each other (${linesText(starts, [matches[k] as number])}), so replace_all cannot apply it: ${echo}`,
          );
          return;
        }
      }
    }
    for (const start of matches) {
      planned.push({ start, end: start + oldText.length, edit: i, text: newText });
    }
  });
  if (problems.length > 0) return { ok: false, problems: capProblems(problems) };

  planned.sort((a, b) => a.start - b.start || a.edit - b.edit);
  for (let k = 1; k < planned.length; k++) {
    const previous = planned[k - 1] as PlannedRange;
    const current = planned[k] as PlannedRange;
    if (current.start < previous.end) {
      problems.push(
        `edit ${current.edit} of ${n}: overlaps edit ${previous.edit} (${linesText(starts, [current.start])})`,
      );
    }
  }
  if (problems.length > 0) return { ok: false, problems: capProblems(problems) };

  let code = '';
  let cursor = 0;
  const ranges: EditRange[] = [];
  for (const range of planned) {
    code += base.slice(cursor, range.start);
    const start = code.length;
    code += range.text;
    ranges.push({ start, end: code.length });
    cursor = range.end;
  }
  code += base.slice(cursor);
  if (code === base) return { ok: false, problems: ['the edits together change nothing'] };
  if (code.trim() === '') return { ok: false, problems: ['the result would be empty'] };
  return { ok: true, code, ranges };
}

/** A line of the excerpt cut to MAX_EXCERPT_LINE_CHARS code points. */
function clipLine(line: string): string {
  const points = Array.from(line);
  return points.length > MAX_EXCERPT_LINE_CHARS ? `${points.slice(0, MAX_EXCERPT_LINE_CHARS).join('')}…` : line;
}

/**
 * The reply's view of an edit: the changed lines with EXCERPT_CONTEXT_LINES lines around them, never the
 * whole program. A `>` marks a changed line; the line number sits before ` | ` so a gutter is never part of code.
 * It stops at MAX_EXCERPT_HUNKS windows or MAX_EXCERPT_CHARS characters with a pointer to get_code.
 */
export function changedExcerpt(code: string, ranges: readonly EditRange[]): string {
  const lines = code.split('\n');
  const starts = lineStarts(code);
  const changed = new Set<number>();
  const windows: Array<{ from: number; to: number }> = [];
  for (const range of ranges) {
    // A deletion has start === end: the line where the cut landed is the changed line.
    const first = lineIndexOf(starts, range.start);
    const last = lineIndexOf(starts, Math.max(range.start, range.end - 1));
    for (let line = first; line <= last; line++) changed.add(line);
    windows.push({
      from: Math.max(0, first - EXCERPT_CONTEXT_LINES),
      to: Math.min(lines.length - 1, last + EXCERPT_CONTEXT_LINES),
    });
  }
  windows.sort((a, b) => a.from - b.from);
  const merged: Array<{ from: number; to: number }> = [];
  for (const window of windows) {
    const previous = merged[merged.length - 1];
    if (previous !== undefined && window.from <= previous.to + 1) previous.to = Math.max(previous.to, window.to);
    else merged.push({ ...window });
  }

  // First pass: the entries that fit. The budget counts the widest possible number, so it never overshoots.
  type Entry = { gap: true } | { gap: false; line: number; mark: string; text: string };
  const entries: Entry[] = [];
  const widest = String(lines.length).length;
  let chars = EXCERPT_HEADER.length;
  let cut = false;
  let shownChanged = false;
  outer: for (let k = 0; k < merged.length; k++) {
    if (k >= MAX_EXCERPT_HUNKS) {
      cut = true;
      break;
    }
    const window = merged[k] as { from: number; to: number };
    if (k > 0) {
      entries.push({ gap: true });
      chars += 1 + EXCERPT_GAP.length;
    }
    for (let line = window.from; line <= window.to; line++) {
      const text = clipLine(lines[line] as string);
      const size = 1 + 2 + widest + 3 + text.length;
      if (shownChanged && chars + size > MAX_EXCERPT_CHARS) {
        cut = true;
        break outer;
      }
      const isChanged = changed.has(line);
      entries.push({ gap: false, line, mark: isChanged ? '> ' : '  ', text });
      chars += size;
      if (isChanged) shownChanged = true;
    }
  }

  let width = 1;
  for (const entry of entries) if (!entry.gap) width = Math.max(width, String(entry.line + 1).length);
  const out = [EXCERPT_HEADER];
  for (const entry of entries) {
    out.push(entry.gap ? EXCERPT_GAP : `${entry.mark}${String(entry.line + 1).padStart(width)} | ${entry.text}`);
  }
  if (cut) out.push(EXCERPT_CUT);
  return out.join('\n');
}
