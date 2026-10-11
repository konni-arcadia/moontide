// The helpers that src/instruments.ts and src/catalog.ts share: the sound-name key, the problem
// shape and its texts, the id schemas, and the read of a JSON text. They live in a module of their
// own because a two-way import between those two modules would read zod schema constants before
// they exist (a temporal-dead-zone error at load). This module imports only zod and node built-ins.

import { z } from 'zod';

export const RIG_FILE_NAME = 'instruments.json';
// The user's on/off choice for each instrument, a file of its own so instruments.json stays the user's.
export const RIG_STATE_FILE_NAME = 'instruments-state.json';
export const MAX_RIG_FILE_BYTES = 1048576;

/**
 * The key two sound names are compared by: case, extra spaces and all whitespace do not matter
 * (Roland name fields are fixed width with irregular spacing). page/midi-rig.js holds the same
 * expression; a test pins both on one corpus.
 */
export function soundKey(name: string): string {
  return name.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
}

const ID_MESSAGE = 'must be 1 to 32 lowercase letters, digits, dashes or underscores, starting with a letter or digit';
export const idSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/, ID_MESSAGE);
// A model id is a file name (`<id>.json`), and on Windows these names address a device, not a file.
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/;
export const modelIdSchema = idSchema.refine((id) => !WINDOWS_RESERVED_NAME.test(id), { message: 'is a reserved file name on Windows' });
export const dataByteSchema = z.number().int().min(0).max(127);

export interface Problem {
  field: string;
  reason: string;
}

/**
 * zod issues as problems: a missing field is `required`, an unknown key is `unknown field` at the
 * key's own path (zod reports it at the parent), an empty path is the file itself. `file` is a model
 * file such as `models/synth.json`: its problems read `models/synth.json:<path>`.
 */
export function problemsFromZod(error: z.ZodError, file?: string): Problem[] {
  const where = (dotPath: string): string => {
    if (file === undefined) return dotPath === '' ? RIG_FILE_NAME : dotPath;
    return dotPath === '' ? file : `${file}:${dotPath}`;
  };
  const problems: Problem[] = [];
  for (const issue of error.issues) {
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) problems.push({ field: where(z.core.toDotPath([...issue.path, key])), reason: 'unknown field' });
    } else {
      const reason = issue.message.endsWith('received undefined') ? 'required' : issue.message;
      problems.push({ field: where(z.core.toDotPath(issue.path)), reason });
    }
  }
  return problems;
}

/** A field or a reason is cut at this many characters in a problem. */
const MAX_PROBLEM_TEXT = 200;
export const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/;
const CONTROL_CHARS_ALL = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g;

/** Control characters removed, then cut at MAX_PROBLEM_TEXT characters (a code point is never split). */
export function cleanProblemText(text: string): string {
  const points = Array.from(text.replace(CONTROL_CHARS_ALL, ''));
  return points.length > MAX_PROBLEM_TEXT ? `${points.slice(0, MAX_PROBLEM_TEXT - 1).join('')}…` : points.join('');
}

export function errnoCode(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' ? code : 'unknown error';
}

/** The text of a JSON file as a value, or the one reason it cannot be: BOM stripped, empty, too big, not JSON. */
export function parseJsonText(
  raw: string,
  maxBytes: number = MAX_RIG_FILE_BYTES,
): { ok: true; value: unknown } | { ok: false; reason: string } {
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  if (text.trim() === '') return { ok: false, reason: 'the file is empty' };
  if (Buffer.byteLength(text, 'utf8') > maxBytes) return { ok: false, reason: `the file is larger than ${maxBytes / 1048576} MiB` };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (err) {
    // V8's wording differs between Node versions: only the line is taken from it, when it names a position.
    const message = err instanceof Error ? err.message : '';
    const position = /position (\d+)/.exec(message);
    if (position) return { ok: false, reason: `not valid JSON (line ${text.slice(0, Number(position[1])).split('\n').length})` };
    return { ok: false, reason: 'not valid JSON' };
  }
}
