// Owns Moontide's per-user version history: data-dir resolution, the JSON Lines file, and the
// in-memory index built from it.

import { appendFileSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { HistoryVersion, HistoryWindow } from './protocol.js';

export const HISTORY_FILE_NAME = 'history.jsonl';
export const DEFAULT_LIST_LIMIT = 20;
export const HAND_EDIT_LABEL = 'edited by hand';
export const NO_VERSIONS_MESSAGE = 'No versions recorded yet.';
export const MAX_LABEL_LENGTH = 200;
export const MAX_FAVORITE_NAME_LENGTH = 100;
export const EMPTY_FAVORITE_NAME_MESSAGE = 'favorite_version needs a non-empty name.';
export const NO_FAVORITES_MESSAGE = 'No favorites yet.';

/** The history keeps the newest HISTORY_CAP versions plus every favorite; once at least
 * COMPACTION_BATCH versions are neither favorites nor among the newest HISTORY_CAP, they are
 * all dropped in one rewrite (batching trims keeps set_code fast and Windows rename-lock exposure
 * rare, at the cost of at most HISTORY_CAP + COMPACTION_BATCH - 1 versions sitting in the
 * file between trims). */
export const HISTORY_CAP = 1000;
export const COMPACTION_BATCH = 100;

/**
 * A temp-file-then-rename replace can throw EPERM/EBUSY/EACCES on
 * Windows when antivirus or the search indexer transiently locks the destination file. Retried
 * with this backoff (roughly 1.55s total in the worst case) before giving up.
 */
export const RENAME_RETRY_DELAYS_MS = [50, 100, 200, 400, 800];

/** Blocks the calling thread for `ms` — only ever called from inside a synchronous trim, and
 * only when a rename is actually refused (in practice, Windows only). */
export function sleepSync(ms: number): void {
  const sharedBuffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sharedBuffer), 0, 0, ms);
}

/**
 * Renames `from` over `to`, retrying on EPERM/EBUSY/EACCES (Windows lock refusals) with
 * RENAME_RETRY_DELAYS_MS backoff; any other error, or a refusal after the last retry, is
 * thrown. `deps` lets tests inject a fake rename/sleep without any real filesystem or delay.
 */
export function renameWithRetry(
  from: string,
  to: string,
  deps: { rename?: (from: string, to: string) => void; sleep?: (ms: number) => void; delaysMs?: readonly number[] } = {},
): void {
  const rename = deps.rename ?? renameSync;
  const sleep = deps.sleep ?? sleepSync;
  const delaysMs = deps.delaysMs ?? RENAME_RETRY_DELAYS_MS;
  let attempt = 0;
  for (;;) {
    try {
      rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const retryable = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
      if (!retryable || attempt >= delaysMs.length) {
        throw err;
      }
      sleep(delaysMs[attempt]);
      attempt++;
    }
  }
}

/**
 * A third origin exists for page controls — a part launched from the Parts view, a Mixer gesture,
 * a restore from the History view. New origins are still added here and to
 * ORIGIN_LABELS only; never write a two-way conditional elsewhere that assumes only two
 * origins can ever exist.
 */
export const VERSION_ORIGINS = ['claude', 'hand', 'page'] as const;
export type VersionOrigin = (typeof VERSION_ORIGINS)[number];
export const ORIGIN_LABELS: Record<VersionOrigin, string> = {
  claude: 'claude',
  hand: 'hand edit',
  page: 'page',
};

/** The history label of a part launch; part is at most MAX_PART_NAME_LENGTH (100)
 * characters, so the label stays well under MAX_LABEL_LENGTH (200). */
export function partLaunchLabel(part: string): string {
  return `launched ${part}`;
}

/**
 * Resolves the per-user data directory the history file lives in. Reads env/platform/
 * homedir only through its parameters, never process.env/process.platform directly, so every
 * OS branch stays unit-testable from a single machine.
 */
export function resolveDataDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  homedir: () => string = os.homedir,
): string {
  if (env.MOONTIDE_DATA_DIR && env.MOONTIDE_DATA_DIR.trim() !== '') {
    return path.resolve(env.MOONTIDE_DATA_DIR);
  }
  const p = platform === 'win32' ? path.win32 : path.posix;
  if (platform === 'darwin') {
    return p.join(homedir(), 'Library', 'Application Support', 'moontide');
  }
  if (platform === 'win32') {
    const base = env.APPDATA && env.APPDATA.trim() !== '' ? env.APPDATA : p.join(homedir(), 'AppData', 'Roaming');
    return p.join(base, 'moontide');
  }
  const base =
    env.XDG_DATA_HOME && p.isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : p.join(homedir(), '.local', 'share');
  return p.join(base, 'moontide');
}

export interface VersionEntry {
  type: 'version';
  id: number;
  at: string;
  origin: VersionOrigin;
  label?: string;
  restoredFrom?: number;
  // The version playing when this one was made (the restored source for a restore).
  // Optional so every older line stays valid; resolved on read by resolveParents and never
  // checked by the schema, so a wrong parent can never make a line unreadable.
  parent?: number;
  code: string;
}

export interface SessionStartEntry {
  type: 'session-start';
  at: string;
}

/**
 * A favorite line marks an existing version id under a name; it never touches the
 * version's own line. Reversibility note: read back on every start, so a future shape
 * change needs a reader that accepts both — treat this as a costly-to-change format.
 */
export interface FavoriteEntry {
  type: 'favorite';
  id: number;
  name: string;
  at: string;
}

export type HistoryEntry = VersionEntry | SessionStartEntry | FavoriteEntry;

interface StoredLine {
  raw: string;
  entry: HistoryEntry | null;
}

// One z.object per type literal, same shape as protocol.ts's pageMessageSchema.
const historyEntrySchema = z.union([
  z.object({
    type: z.literal('version'),
    id: z.number().int().positive(),
    at: z.string().min(1),
    origin: z.enum(VERSION_ORIGINS),
    label: z.string().optional(),
    restoredFrom: z.number().int().positive().optional(),
    parent: z.number().int().positive().optional(),
    code: z.string().min(1),
  }),
  z.object({
    type: z.literal('session-start'),
    at: z.string().min(1),
  }),
  z.object({
    type: z.literal('favorite'),
    id: z.number().int().positive(),
    name: z.string().min(1),
    at: z.string().min(1),
  }),
]);

/** UTC ISO-8601 text without milliseconds, e.g. 2026-09-26T14:32:10Z. */
export function isoSeconds(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** The first non-empty trimmed line of code, cut to 60 code points plus '…' when longer. */
export function firstCodeLine(code: string): string {
  const line =
    code
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l !== '') ?? '';
  const codePoints = Array.from(line);
  if (codePoints.length <= 60) return line;
  return codePoints.slice(0, 60).join('') + '…';
}

/**
 * List row for a version entry, leaving out the label segment entirely when
 * absent, and inserting a favorite segment (' — favorite "{name}"') right after the label
 * (or right after the origin when there is no label) when `favoriteName` is given.
 */
export function formatVersionRow(entry: VersionEntry, favoriteName?: string): string {
  const labelSegment = entry.label ? ` — "${entry.label}"` : '';
  const favoriteSegment = favoriteName ? ` — favorite "${favoriteName}"` : '';
  return `#${entry.id} — ${entry.at} — ${ORIGIN_LABELS[entry.origin]}${labelSegment}${favoriteSegment} — ${firstCodeLine(entry.code)}`;
}

/** List row for a session-start marker, timestamp first. */
export function formatSessionRow(entry: SessionStartEntry): string {
  return `${entry.at} — session started`;
}

/**
 * The one place a version's parent is decided. A stored parent is kept only when it is
 * older than the version and still in the file, and otherwise the version is a root (null): a
 * parent the cap dropped, a missing one and a not-older one never turn into another version. A
 * line without a stored parent (every line written before parents existed) gets its restoredFrom,
 * else the version just before it (id - 1), each only when still in the file. The previous line in
 * the file is never used: after a compaction it can be an unrelated favorite. `malformed` lists
 * the ids whose stored parent is not older than themselves. A duplicate id never throws; the last
 * line for an id wins, like getVersion.
 */
export function resolveParents(versions: VersionEntry[]): { parents: Map<number, number | null>; malformed: number[] } {
  const present = new Set<number>();
  for (const v of versions) present.add(v.id);
  const parents = new Map<number, number | null>();
  const malformed: number[] = [];
  for (const v of versions) {
    let parent: number | null;
    if (v.parent !== undefined) {
      if (v.parent < v.id) {
        parent = present.has(v.parent) ? v.parent : null;
      } else {
        parent = null;
        if (!malformed.includes(v.id)) malformed.push(v.id);
      }
    } else if (v.restoredFrom !== undefined && v.restoredFrom < v.id && present.has(v.restoredFrom)) {
      parent = v.restoredFrom;
    } else if (present.has(v.id - 1)) {
      parent = v.id - 1;
    } else {
      parent = null;
    }
    parents.set(v.id, parent);
  }
  return { parents, malformed };
}

export class HistoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HistoryError';
  }
}

export function historyUnavailableMessage(reason: string): string {
  return `History is unavailable right now (${reason}). Music tools still work; try again later.`;
}

export function historyWriteFailedNote(reason: string): string {
  return `Note: this version could not be saved to history (${reason}).`;
}

/** Exact wording telling Claude a trim dropped older, non-favorite versions. */
export function droppedVersionsNote(count: number, oldestKeptId: number, cap: number = HISTORY_CAP): string {
  return `Note: ${count} version(s) older than #${oldestKeptId} were dropped (favorites are never dropped) to stay within the ${cap}-version history limit.`;
}

/** Exact wording when a trim could not complete — nothing was lost, and the version that
 * triggered it is already saved by the append that ran before the trim was attempted. */
export function historyTrimFailedNote(reason: string, cap: number = HISTORY_CAP): string {
  return `Note: the history file could not be trimmed to the ${cap}-version limit (${reason}); nothing was lost, and it will be tried again on the next change.`;
}

/** Exact wording for an unknown id, shared by restore_version and favorite_version. */
export function versionNotFoundMessage(id: number): string {
  return `No version #${id} in history.`;
}

/** The label a restore records, and the structured source it also carries. */
export function restoredLabel(id: number): string {
  return `restored from #${id}`;
}

/** Exact wording when a word filter matches nothing. */
export function noMatchMessage(filter: string): string {
  return `No versions match "${filter}".`;
}

/** Exact wording for favorite_version's two success shapes. */
export function favoriteSavedMessage(id: number, name: string): string {
  return `Saved #${id} as favorite "${name}".`;
}

export function favoriteRenamedMessage(id: number, name: string): string {
  return `Renamed favorite #${id} to "${name}".`;
}

/** Reports how many lines were unreadable and which (first 10, then "and N more"). */
export function unreadableLinesNote(lineNumbers: number[]): string {
  const count = lineNumbers.length;
  const shown = lineNumbers.slice(0, 10).join(', ');
  const overflow = count > 10 ? ` and ${count - 10} more` : '';
  return `Note: ${count} unreadable line(s) in the history file were skipped (line ${shown}${overflow}). Valid entries are unaffected.`;
}

/** Collapses every whitespace run (including line breaks) to one space and trims. */
export function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export interface RecordVersionInput {
  code: string;
  origin: VersionOrigin;
  label?: string;
  restoredFrom?: number;
  /** The version that was playing; wins over restoredFrom and over the newest version in the file. */
  parent?: number;
  force?: boolean;
}

export interface RecordVersionResult {
  id: number;
  recorded: boolean;
  /** Set only when this record pushed the history past the cap and a trim ran. */
  dropped?: { count: number; oldestKeptId: number };
  /** Text(s) the caller should surface to Claude (a dropped-versions note, or a trim-failure note); empty when there is nothing to tell. */
  notes: string[];
}

/**
 * Reads and appends to the per-user version history file (JSON Lines, append-only).
 *
 * Accepted v1 limitation, confirmed by the user: ids come from an in-memory counter, so two
 * Moontide processes writing the same file at once can give two versions the same id; there is
 * no file locking. Two processes trimming at the same time can also replace each other's temp
 * file. Running several sessions at once against one data directory is not supported.
 */
export class HistoryStore {
  private readonly dataDir: string | (() => string);
  private readonly now: () => Date;
  private readonly cap: number;
  private readonly batch: number;
  private lines: StoredLine[] = [];
  private unreadableLines: number[] = [];
  // The unreadable-lines note for the most recent load, taken (read and cleared) once
  // by the next drainNotices — set fresh on every load(), so a retry after a fixed file stops
  // repeating a stale note.
  private pendingUnreadableNote: string | null = null;
  // True when the file's last line has no trailing newline (a crash, or a previous
  // append whose fs call threw partway through) — the next append starts with '\n' so the
  // new entry always begins on its own line and the damaged line keeps its exact bytes.
  private needsLeadingNewline = false;
  private nextId = 1;
  private sessionMarked = false;
  private loaded = false;
  private file = '';
  // Ids already reported as having a parent that is not older than themselves, so the
  // loud note is logged once per process, not on every read.
  private readonly reportedMalformed = new Set<number>();

  constructor(options: { dataDir: string | (() => string); now?: () => Date; cap?: number; batch?: number }) {
    this.dataDir = options.dataDir;
    this.now = options.now ?? (() => new Date());
    this.cap = options.cap ?? HISTORY_CAP;
    this.batch = options.batch ?? COMPACTION_BATCH;
  }

  private resolveDir(): string {
    return typeof this.dataDir === 'function' ? this.dataDir() : this.dataDir;
  }

  /** Reads the history file (an ENOENT file or directory is an empty history) and rebuilds the in-memory index. */
  load(): string {
    const dir = this.resolveDir();
    this.file = path.join(dir, HISTORY_FILE_NAME);
    let text: string;
    try {
      text = readFileSync(this.file, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        text = '';
      } else {
        throw new HistoryError(err instanceof Error ? err.message : String(err));
      }
    }
    const lines: StoredLine[] = [];
    const unreadable: number[] = [];
    let maxId = 0;
    const rawLines = text.split('\n');
    for (let i = 0; i < rawLines.length; i++) {
      const raw = rawLines[i];
      if (raw.trim() === '') continue;
      const lineNumber = i + 1;
      let entry: HistoryEntry | null = null;
      try {
        const parsed: unknown = JSON.parse(raw);
        const result = historyEntrySchema.safeParse(parsed);
        if (result.success) {
          entry = result.data;
        }
      } catch {
        // Invalid JSON — entry stays null, the line is counted as unreadable below.
      }
      if (entry === null) {
        unreadable.push(lineNumber);
      } else if (entry.type === 'version' && entry.id > maxId) {
        maxId = entry.id;
      }
      lines.push({ raw, entry });
    }
    this.lines = lines;
    this.unreadableLines = unreadable;
    this.pendingUnreadableNote = unreadable.length > 0 ? unreadableLinesNote(unreadable) : null;
    if (unreadable.length > 0) {
      console.error(`[moontide] History file has ${unreadable.length} unreadable line(s) (line ${unreadable.join(', ')})`);
    }
    // A non-empty file not ending in '\n' has a half-written last line.
    this.needsLeadingNewline = text.length > 0 && !text.endsWith('\n');
    this.nextId = maxId + 1;
    this.loaded = true;
    return this.file;
  }

  /** A failed startup load leaves `loaded` false, so the next use retries ("try again later" is truthful). */
  private ensureLoaded(): void {
    if (!this.loaded) {
      this.load();
    }
  }

  /** The unreadable-lines note from the most recent load, once — then null until the next load finds more. */
  takeUnreadableNote(): string | null {
    const note = this.pendingUnreadableNote;
    this.pendingUnreadableNote = null;
    return note;
  }

  lastVersion(): VersionEntry | null {
    for (let i = this.lines.length - 1; i >= 0; i--) {
      const entry = this.lines[i].entry;
      if (entry && entry.type === 'version') return entry;
    }
    return null;
  }

  /**
   * Looks up a version by id. When two lines share an id — which only the
   * accepted two-process limitation can cause — the newest
   * line (last in file order) wins, matching favoriteNames' "last entry for this id wins".
   */
  getVersion(id: number): VersionEntry | null {
    this.ensureLoaded();
    let found: VersionEntry | null = null;
    for (const line of this.lines) {
      if (line.entry && line.entry.type === 'version' && line.entry.id === id) {
        found = line.entry;
      }
    }
    return found;
  }

  /**
   * Shared append path for both recordVersion and favorite — same directory creation,
   * half-written-last-line repair (needsLeadingNewline) and HistoryError-on-fs-failure
   * behavior, so a favorite line is exactly as crash-safe as a version line.
   */
  private appendEntries(entries: HistoryEntry[]): void {
    const leadingNewline = this.needsLeadingNewline ? '\n' : '';
    const text = leadingNewline + entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
    const dir = this.resolveDir();
    try {
      mkdirSync(dir, { recursive: true });
      appendFileSync(this.file, text);
      this.needsLeadingNewline = false;
    } catch (err) {
      // The fs call may have written part of a line before failing — the next attempt (once
      // the underlying problem is fixed) must still start on its own line.
      this.needsLeadingNewline = true;
      throw new HistoryError(err instanceof Error ? err.message : String(err));
    }
    for (const entry of entries) {
      this.lines.push({ raw: JSON.stringify(entry), entry });
    }
  }

  /**
   * Appends a version (preceded by a session-start line on this run's first
   * record). The same code as the last recorded version is a no-op unless `force` is
   * true (restores bypass this so an intentional restore always adds an entry).
   */
  recordVersion(input: RecordVersionInput): RecordVersionResult {
    this.ensureLoaded();
    const last = this.lastVersion();
    if (!input.force && last !== null && last.code === input.code) {
      return { id: last.id, recorded: false, notes: [] };
    }
    const id = this.nextId;
    const at = isoSeconds(this.now());
    const entry: VersionEntry = { type: 'version', id, at, origin: input.origin, code: input.code };
    const normalizedLabel = input.label !== undefined ? normalizeText(input.label) : undefined;
    if (normalizedLabel) entry.label = normalizedLabel;
    if (input.restoredFrom !== undefined) entry.restoredFrom = input.restoredFrom;
    // An explicit parent, else the restored source, else the newest version in the file
    // (a new session continuing its branch); the very first version of a file has none.
    const parent = input.parent ?? input.restoredFrom ?? last?.id;
    if (parent !== undefined) entry.parent = parent;

    const toAppend: HistoryEntry[] = [];
    if (!this.sessionMarked) {
      toAppend.push({ type: 'session-start', at });
    }
    toAppend.push(entry);
    this.appendEntries(toAppend);
    this.nextId = id + 1;
    this.sessionMarked = true;

    const notes: string[] = [];
    let dropped: RecordVersionResult['dropped'];
    const toTrim = this.candidatesForTrim();
    if (toTrim) {
      const result = this.trim(toTrim.candidates);
      if (result.ok) {
        dropped = { count: toTrim.candidates.size, oldestKeptId: toTrim.oldestKeptId };
        notes.push(droppedVersionsNote(dropped.count, dropped.oldestKeptId, this.cap));
      } else {
        // The version above is already saved; the candidates stay untouched in memory, so
        // the next recorded version's candidatesForTrim() sees them again and retries.
        notes.push(historyTrimFailedNote(result.reason, this.cap));
      }
    }
    return { id, recorded: true, dropped, notes };
  }

  /**
   * The newest `cap` version entries (in file order) are always kept; a favorited
   * version is never a candidate however old. Returns null when there is nothing to trim yet
   * (at or under the cap, or fewer than `batch` candidates so far).
   */
  private candidatesForTrim(): { candidates: Set<VersionEntry>; oldestKeptId: number } | null {
    const versionEntries: VersionEntry[] = [];
    for (const line of this.lines) {
      if (line.entry && line.entry.type === 'version') versionEntries.push(line.entry);
    }
    if (versionEntries.length <= this.cap) return null;
    const newest = versionEntries.slice(versionEntries.length - this.cap);
    const newestSet = new Set(newest);
    const favoriteIds = this.favoriteNames();
    const candidates = new Set<VersionEntry>();
    for (const v of versionEntries) {
      if (newestSet.has(v) || favoriteIds.has(v.id)) continue;
      candidates.add(v);
    }
    if (candidates.size < this.batch) return null;
    return { candidates, oldestKeptId: newest[0].id };
  }

  /**
   * Rewrites history.jsonl.tmp with every kept line (unreadable and favorite lines
   * untouched, in file order) then renames it over history.jsonl (with retries on a Windows
   * lock refusal, see renameWithRetry). A session-start line is kept only if at least one
   * version inside it survives. `history.jsonl` itself is never written in place, and a
   * failure at any point (write or rename) leaves it, and the in-memory lines, unchanged — the
   * temp file is best-effort removed and the caller is told why (no partial
   * write is ever visible, no in-place fallback is ever attempted).
   */
  private trim(candidates: Set<VersionEntry>): { ok: true } | { ok: false; reason: string } {
    const removed: boolean[] = this.lines.map((line) => {
      const entry = line.entry;
      return !!(entry && entry.type === 'version' && candidates.has(entry));
    });
    for (let i = 0; i < this.lines.length; i++) {
      if (this.lines[i].entry?.type !== 'session-start') continue;
      let end = this.lines.length;
      for (let j = i + 1; j < this.lines.length; j++) {
        if (this.lines[j].entry?.type === 'session-start') {
          end = j;
          break;
        }
      }
      let keepsAVersion = false;
      for (let j = i + 1; j < end; j++) {
        const entry = this.lines[j].entry;
        if (entry && entry.type === 'version' && !removed[j]) {
          keepsAVersion = true;
          break;
        }
      }
      if (!keepsAVersion) removed[i] = true;
    }
    const keptLines = this.lines.filter((_, i) => !removed[i]);
    const text = keptLines.map((l) => l.raw).join('\n') + '\n';
    const tmpPath = path.join(this.resolveDir(), HISTORY_FILE_NAME + '.tmp');
    try {
      writeFileSync(tmpPath, text);
      renameWithRetry(tmpPath, this.file);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      try {
        unlinkSync(tmpPath);
      } catch (unlinkErr) {
        const code = (unlinkErr as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') {
          console.error(
            `[moontide] Could not remove the history trim temp file: ${unlinkErr instanceof Error ? unlinkErr.message : String(unlinkErr)}`,
          );
        }
      }
      console.error(`[moontide] Could not trim the history file: ${reason}`);
      return { ok: false, reason };
    }
    this.lines = keptLines;
    return { ok: true };
  }

  /** Current favorite name per id, from favorite lines in file order (newest line wins). */
  favoriteNames(): Map<number, string> {
    this.ensureLoaded();
    const names = new Map<number, string>();
    for (const line of this.lines) {
      if (line.entry && line.entry.type === 'favorite') {
        names.set(line.entry.id, line.entry.name);
      }
    }
    return names;
  }

  /**
   * Keeps a version as a named favorite, or renames it. Never touches an existing line —
   * favoriting only appends a new `favorite` line, same append path recordVersion uses (no
   * session-start line for it though: favoriting is not a new played version).
   *
   * Keeping a version under the name it already has (exact match on the normalized
   * text, so a change of case still counts as a rename) reports `renamed: false` (Saved) and
   * writes no duplicate line — the version already is a favorite under that name. Any other
   * name is a real rename and appends as before.
   */
  favorite(id: number, name: string): { renamed: boolean } {
    this.ensureLoaded();
    const normalized = normalizeText(name);
    if (normalized === '') {
      throw new Error(EMPTY_FAVORITE_NAME_MESSAGE);
    }
    if (this.getVersion(id) === null) {
      throw new Error(versionNotFoundMessage(id));
    }
    const current = this.favoriteNames().get(id);
    if (current === normalized) {
      return { renamed: false };
    }
    const renamed = current !== undefined;
    const entry: FavoriteEntry = { type: 'favorite', id, name: normalized, at: isoSeconds(this.now()) };
    this.appendEntries([entry]);
    return { renamed };
  }

  /**
   * A window of readable versions for the page's History view, newest first: the newest
   * `limit` versions, or with `before` the up-to-`limit` versions just older than that version in
   * file order (null when no readable version has that id, e.g. after a compaction dropped it;
   * the newest line wins for a duplicated id). `beyond` is the version just older than the oldest
   * row sent (so that row still has something to compare against, or null), `total` the number of
   * readable versions on disk and `remaining` how many are older than the oldest row sent. Rows
   * carry the resolved `parent` (see resolveParents), the current `favorite` name and
   * `sessionStart` (the time of the latest session-start line between the previous version and
   * this one, so repeated session-start lines collapse into one); keys that are unset are left
   * out. A HistoryError from the load propagates; the caller decides how to report it.
   */
  readWindow(options: { limit: number }): HistoryWindow;
  readWindow(options: { before?: number; limit: number }): HistoryWindow | null;
  readWindow(options: { before?: number; limit: number }): HistoryWindow | null {
    this.ensureLoaded();
    const { before, limit } = options;
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error(`readWindow needs a positive integer limit, got ${String(limit)}`);
    }
    const all: VersionEntry[] = [];
    const sessionStarts: (string | undefined)[] = [];
    let pendingSession: string | undefined;
    for (const line of this.lines) {
      const entry = line.entry;
      if (!entry) continue;
      if (entry.type === 'session-start') {
        pendingSession = entry.at;
      } else if (entry.type === 'version') {
        all.push(entry);
        sessionStarts.push(pendingSession);
        pendingSession = undefined;
      }
    }
    let end = all.length;
    if (before !== undefined) {
      let found = -1;
      for (let i = all.length - 1; i >= 0; i--) {
        if (all[i].id === before) {
          found = i;
          break;
        }
      }
      if (found < 0) return null;
      end = found;
    }
    const { parents, malformed } = resolveParents(all);
    for (const id of malformed) {
      if (this.reportedMalformed.has(id)) continue;
      this.reportedMalformed.add(id);
      console.error(`[moontide] History version #${id} has a parent that is not older than itself; showing it as a root`);
    }
    const favorites = this.favoriteNames();
    const total = all.length;
    const firstSent = Math.max(0, end - limit);
    const versions: HistoryVersion[] = [];
    for (let i = end - 1; i >= firstSent; i--) {
      const entry = all[i];
      const row: HistoryVersion = { id: entry.id, at: entry.at, origin: entry.origin, code: entry.code };
      if (entry.label !== undefined) row.label = entry.label;
      if (entry.restoredFrom !== undefined) row.restoredFrom = entry.restoredFrom;
      const parent = parents.get(entry.id);
      if (parent !== null && parent !== undefined) row.parent = parent;
      const favorite = favorites.get(entry.id);
      if (favorite !== undefined) row.favorite = favorite;
      const sessionStart = sessionStarts[i];
      if (sessionStart !== undefined) row.sessionStart = sessionStart;
      versions.push(row);
    }
    const older = firstSent > 0 ? all[firstSent - 1] : null;
    return {
      versions,
      beyond: older ? { id: older.id, code: older.code } : null,
      total,
      remaining: firstSent,
    };
  }

  /**
   * Newest-first rows. Without a filter or favoritesOnly, every version (up to
   * `limit`, default DEFAULT_LIST_LIMIT) plus session markers. With either, session rows are
   * left out and `limit` counts only the versions actually listed; a case-insensitive filter
   * matches the label, the full code, or the current favorite name.
   */
  listText(options: { limit?: number; filter?: string; favoritesOnly?: boolean } = {}): string {
    this.ensureLoaded();
    const hasVersion = this.lines.some((l) => l.entry?.type === 'version');
    if (!hasVersion) return NO_VERSIONS_MESSAGE;

    const limit = options.limit ?? DEFAULT_LIST_LIMIT;
    const favoritesOnly = options.favoritesOnly === true;
    const filterText = (options.filter ?? '').trim();
    const hasFilter = filterText !== '';
    const filterLower = filterText.toLowerCase();
    const names = this.favoriteNames();

    const rows: string[] = [];
    let count = 0;
    for (let i = this.lines.length - 1; i >= 0; i--) {
      const entry = this.lines[i].entry;
      if (!entry) continue;
      if (entry.type === 'version') {
        const favoriteName = names.get(entry.id);
        if (favoritesOnly && favoriteName === undefined) continue;
        if (hasFilter) {
          const haystacks = [entry.label, entry.code, favoriteName].filter((s): s is string => s !== undefined);
          if (!haystacks.some((s) => s.toLowerCase().includes(filterLower))) continue;
        }
        if (count >= limit) break;
        rows.push(formatVersionRow(entry, favoriteName));
        count++;
      } else if (entry.type === 'session-start' && !hasFilter && !favoritesOnly) {
        if (count >= limit) break; // do not surface markers past the version window either
        rows.push(formatSessionRow(entry));
      }
    }
    if (rows.length === 0) {
      if (hasFilter) return noMatchMessage(filterText);
      if (favoritesOnly) return NO_FAVORITES_MESSAGE;
    }
    return rows.join('\n');
  }
}
