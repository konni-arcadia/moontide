// Sound catalogs: for an instrument with too many sounds to remember, a list in the user's data folder
// (`catalogs/<model id>.json`, one file per model, attached to a model by its file name). It never
// lives in the repo or the package. It holds melodic sounds and, for a model whose rhythm channels
// take a bank, drum kits in a separate `kits` list (the file keeps the two roles apart; the page
// receives the kits appended to the model's own rhythm sounds). Everything Claude reads from here is
// a fact (a name, a program, a bank, a category, a drum map), never a taste. No sound name is ever exported as a string constant from this module,
// because test/guidance.test.js scans the exported strings of the modules it loads.

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { drumMapById, kitDrumMap, unknownMapReason } from './drum-maps.js';
import { renameWithRetry } from './history.js';
import type { InstrumentModel } from './instruments.js';
import { MAX_RIG_CATALOG_KITS, MAX_RIG_CATALOG_SOUNDS, MAX_RIG_PROBLEMS } from './protocol.js';
import {
  CONTROL_CHARS,
  cleanProblemText,
  dataByteSchema,
  errnoCode,
  idSchema,
  modelIdSchema,
  parseJsonText,
  problemsFromZod,
  soundKey,
  type Problem,
} from './rig-util.js';

export const CATALOGS_DIR_NAME = 'catalogs';
export const MAX_CATALOG_SOUNDS = MAX_RIG_CATALOG_SOUNDS;
export const MAX_CATALOG_KITS = MAX_RIG_CATALOG_KITS;
export const MAX_CATALOG_FILE_BYTES = 2097152;
export const MAX_SEARCH_RESULTS = 25;
/** A call of save_midi_catalog carries at most this many sounds; a session holds at most MAX_CATALOG_DRAFTS drafts. */
export const MAX_PART_SOUNDS = 500;
export const MAX_CATALOG_DRAFTS = 3;

const catalogSoundSchema = z.strictObject({
  name: z.string().min(1, 'must not be empty').max(80, 'at most 80 characters'),
  category: z.string().min(1, 'must not be empty').max(60, 'at most 60 characters').optional(),
  program: dataByteSchema,
  bank: z.strictObject({ msb: dataByteSchema, lsb: dataByteSchema.optional() }).optional(),
});

/** A drum kit of a catalog: a sound that also may name its drum map (null: no map is known for the kit). */
const catalogKitSchema = catalogSoundSchema.extend({ noteMap: idSchema.nullable().optional() });

/** A catalog file: the model it extends (equal to the file name), where the list came from, the sounds and the drum kits. */
export const catalogSchema = z.strictObject({
  model: modelIdSchema,
  source: z.string().min(1, 'must not be empty').max(200, 'at most 200 characters'),
  // At least one sound or one kit is required: catalogProblems checks that, with the words of a catalog without sounds.
  sounds: z.array(catalogSoundSchema).max(MAX_CATALOG_SOUNDS, 'at most 5000 sounds'),
  kits: z.array(catalogKitSchema).max(MAX_CATALOG_KITS, 'at most 512 kits').optional(),
});

export type Catalog = z.infer<typeof catalogSchema>;
export type CatalogSound = Catalog['sounds'][number];
export type CatalogKit = z.infer<typeof catalogKitSchema>;

/** The checks that need more than one field, or the model; the shape is already valid. Paths are bare (no file prefix). */
function catalogProblems(catalog: Catalog, model: InstrumentModel, file: string | undefined): Problem[] {
  const problems: Problem[] = [];
  const add = (field: string, reason: string): void => {
    problems.push({ field, reason });
  };
  if (catalog.model !== model.id) {
    add('model', file === undefined ? `must be the id of the model it extends ("${model.id}")` : `must equal the file name ("${model.id}")`);
  }
  const noControl = (field: string, text: string): void => {
    if (CONTROL_CHARS.test(text)) add(field, 'contains a control character');
  };
  noControl('source', catalog.source);
  const kits = catalog.kits ?? [];
  if (catalog.sounds.length === 0 && kits.length === 0) add('sounds', 'at least one sound is required');
  // Sounds are melodic, so only the model's melodic names are taken; kits are checked below against its rhythm names.
  const modelKeys = new Map(model.sounds.melodic.map((own) => [soundKey(own.name), own.name]));
  const firstByKey = new Map<string, number>();
  catalog.sounds.forEach((sound, index) => {
    const at = `sounds[${index}]`;
    noControl(`${at}.name`, sound.name);
    if (sound.category !== undefined) noControl(`${at}.category`, sound.category);
    const key = soundKey(sound.name);
    const first = firstByKey.get(key);
    if (first === undefined) {
      firstByKey.set(key, index);
      const own = modelKeys.get(key);
      if (own !== undefined) add(`${at}.name`, `same name as a sound of model ${model.id} ("${own}")`);
    } else {
      add(`${at}.name`, `same name as sounds[${first}] ("${(catalog.sounds[first] as CatalogSound).name}")`);
    }
    if (sound.bank === undefined) return;
    if (model.bankSelect === 'none') add(`${at}.bank`, 'this model has no bank select');
    else if (model.bankSelect === 'msb' && sound.bank.lsb !== undefined) add(`${at}.bank.lsb`, 'this model takes a bank MSB only');
  });
  if (kits.length > 0 && model.rhythmBank !== true) {
    // A kit with a bank on a drum channel that takes none would send a bank select where the model expects none.
    add('kits', "this model's rhythm channels take no bank, so its kits are listed in the model");
    return problems;
  }
  const ownKitKeys = new Map(model.sounds.rhythm.map((own) => [soundKey(own.name), own.name]));
  const firstKitByKey = new Map<string, number>();
  kits.forEach((kit, index) => {
    const at = `kits[${index}]`;
    noControl(`${at}.name`, kit.name);
    if (kit.category !== undefined) noControl(`${at}.category`, kit.category);
    const key = soundKey(kit.name);
    const first = firstKitByKey.get(key);
    if (first === undefined) {
      firstKitByKey.set(key, index);
      const own = ownKitKeys.get(key);
      if (own !== undefined) add(`${at}.name`, `same name as a sound of model ${model.id} ("${own}")`);
    } else {
      add(`${at}.name`, `same name as kits[${first}] ("${(kits[first] as CatalogKit).name}")`);
    }
    // A kit with no bank would go out as bank 0/0, a melodic tone on the drum part: refused instead.
    if (kit.bank === undefined) add(`${at}.bank`, 'required: the rhythm channels of this model take a bank');
    else if (model.bankSelect === 'msb' && kit.bank.lsb !== undefined) add(`${at}.bank.lsb`, 'this model takes a bank MSB only');
    if (typeof kit.noteMap === 'string' && drumMapById(model.drumMaps ?? [], kit.noteMap) === null) {
      add(`${at}.noteMap`, unknownMapReason(model.drumMaps ?? [], kit.noteMap));
    }
  });
  return problems;
}

/**
 * Checks a catalog value against the model it extends: the shape with its limits, then the
 * cross-checks. `file` names the catalog file for the problems (`catalogs/<id>.json:<path>`).
 */
export function parseCatalog(
  value: unknown,
  model: InstrumentModel,
  file?: string,
): { ok: true; catalog: Catalog } | { ok: false; problems: Problem[] } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, problems: [{ field: file ?? 'catalog', reason: 'must be an object' }] };
  }
  const parsed = catalogSchema.safeParse(value);
  if (!parsed.success) return { ok: false, problems: problemsFromZod(parsed.error, file) };
  const problems = catalogProblems(parsed.data, model, file).map((problem) =>
    file === undefined ? problem : { ...problem, field: `${file}:${problem.field}` },
  );
  return problems.length > 0 ? { ok: false, problems } : { ok: true, catalog: parsed.data };
}

/**
 * Reads `<data>/catalogs/<model id>.json` for a model. Never throws: no file (or no folder) is no
 * catalog and no problem; any other trouble is a problem naming the file. The path is built only from
 * a model id the model schema already validated, so it cannot leave the catalogs folder.
 */
export function readCatalogFile(dataDir: string, model: InstrumentModel): { catalog: Catalog | null; problems: Problem[] } {
  const where = `${CATALOGS_DIR_NAME}/${model.id}.json`;
  let text: string;
  try {
    text = readFileSync(path.join(dataDir, CATALOGS_DIR_NAME, `${model.id}.json`), 'utf8');
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return { catalog: null, problems: [] };
    return { catalog: null, problems: [{ field: where, reason: `could not be read: ${errnoCode(err)}` }] };
  }
  const json = parseJsonText(text, MAX_CATALOG_FILE_BYTES);
  if (!json.ok) return { catalog: null, problems: [{ field: where, reason: json.reason }] };
  const parsed = parseCatalog(json.value, model, where);
  return parsed.ok ? { catalog: parsed.catalog, problems: [] } : { catalog: null, problems: parsed.problems };
}

export interface SearchResult {
  matches: CatalogKit[];
  /** Aligned with `matches`: true where the match is a drum kit. */
  kits: boolean[];
  total: number;
  /** A category was asked for and no sound or kit of the catalog has it. */
  unknownCategory: boolean;
}

/**
 * The sounds and drum kits whose name or category holds every word of the query, in any order, case
 * and spaces ignored (the same key as sound names), kept to the category when one is given. Ranking:
 * the exact name, then names that start with the words as typed, then names that contain every word,
 * then entries matched only through their category; ties keep catalog order, sounds before kits.
 * No fuzzy matching. `matches` holds the first MAX_SEARCH_RESULTS and `total` counts all.
 */
export function searchCatalog(catalog: Catalog, search: { query?: string; category?: string }): SearchResult {
  const queryKey = soundKey(search.query ?? '');
  const words = (search.query ?? '')
    .split(/\s+/)
    .map(soundKey)
    .filter((word) => word !== '');
  const categoryKey = soundKey(search.category ?? '');
  type Item = { entry: CatalogKit; kit: boolean };
  const items: Item[] = [
    ...catalog.sounds.map((entry) => ({ entry, kit: false })),
    ...(catalog.kits ?? []).map((entry) => ({ entry, kit: true })),
  ];
  const inCategory = (entry: CatalogKit): boolean => categoryKey === '' || soundKey(entry.category ?? '') === categoryKey;
  if (categoryKey !== '' && !items.some((item) => inCategory(item.entry))) return { matches: [], kits: [], total: 0, unknownCategory: true };
  const tiers: Item[][] = [[], [], [], []];
  for (const item of items) {
    const { entry } = item;
    if (!inCategory(entry)) continue;
    const nameKey = soundKey(entry.name);
    const ownCategoryKey = soundKey(entry.category ?? '');
    if (!words.every((word) => nameKey.includes(word) || ownCategoryKey.includes(word))) continue;
    let tier = 3;
    if (words.length === 0) tier = 3;
    else if (nameKey === queryKey) tier = 0;
    else if (nameKey.startsWith(queryKey)) tier = 1;
    else if (words.every((word) => nameKey.includes(word))) tier = 2;
    (tiers[tier] as Item[]).push(item);
  }
  const ranked = tiers.flat();
  const shown = ranked.slice(0, MAX_SEARCH_RESULTS);
  return { matches: shown.map((item) => item.entry), kits: shown.map((item) => item.kit), total: ranked.length, unknownCategory: false };
}

/** The categories of a catalog with their counts of sounds and kits, in first-seen order; a category is one per sound key. */
export function categoryCounts(catalog: Catalog): { name: string; count: number }[] {
  const counts = new Map<string, { name: string; count: number }>();
  for (const sound of [...catalog.sounds, ...(catalog.kits ?? [])]) {
    if (sound.category === undefined) continue;
    const key = soundKey(sound.category);
    const seen = counts.get(key);
    if (seen === undefined) counts.set(key, { name: sound.category, count: 1 });
    else seen.count++;
  }
  return Array.from(counts.values());
}

/** `"Name" (count)` for each of the first `limit` categories, joined by commas, then `, and N more`. */
export function categoryList(counts: { name: string; count: number }[], limit: number): string {
  const shown = counts.slice(0, limit).map((entry) => `${quote(entry.name)} (${entry.count})`);
  return counts.length > limit ? `${shown.join(', ')}, and ${counts.length - limit} more` : shown.join(', ');
}

/** `N sounds`, `K drum kits` or `N sounds and K drum kits`, in the singular for one; an empty list is left out. */
export function countText(sounds: number, kits: number): string {
  const parts: string[] = [];
  if (sounds > 0) parts.push(`${sounds} ${sounds === 1 ? 'sound' : 'sounds'}`);
  if (kits > 0) parts.push(`${kits} ${kits === 1 ? 'drum kit' : 'drum kits'}`);
  return parts.join(' and ');
}

/** The line of the instruments tool for an instrument with a catalog: how many sounds and drum kits, which categories, where to search. */
export function catalogLine(id: string, catalog: Catalog): string {
  const total = catalog.sounds.length;
  const kits = catalog.kits?.length ?? 0;
  const counts = categoryCounts(catalog);
  const sounds = kits === 0 ? `${total} ${total === 1 ? 'sound' : 'sounds'}` : countText(total, kits);
  const pointer = `Search them with search_midi_sounds, instrument ${quote(id)}.`;
  if (counts.length === 0) return `Catalog: ${sounds}, with no categories. ${pointer}`;
  const names = counts.slice(0, 12).map((entry) => quote(entry.name));
  const rest = counts.length > 12 ? `, and ${counts.length - 12} more` : '';
  return `Catalog: ${sounds} in ${counts.length} ${counts.length === 1 ? 'category' : 'categories'} (${names.join(', ')}${rest}). ${pointer}`;
}

/** Text as Claude copies it: JSON-quoted, with the line separators escaped too. */
function quote(text: string): string {
  return JSON.stringify(text).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/** The categories sentence that ends a reply that found nothing, or an unknown category. */
export function categoriesSentence(catalog: Catalog, prefix: string): string {
  const counts = categoryCounts(catalog);
  return counts.length === 0 ? 'The catalog has no categories.' : `${prefix}${categoryList(counts, 30)}.`;
}

/** A match line: facts only, in the order name, program, bank, category; a drum kit is marked and ends with its drum map. */
function matchLine(sound: CatalogKit, kit: { model: InstrumentModel } | null): string {
  const bank = sound.bank === undefined ? '' : `, bank ${sound.bank.lsb === undefined ? sound.bank.msb : `${sound.bank.msb}/${sound.bank.lsb}`}`;
  const category = sound.category === undefined ? '' : `, category ${quote(sound.category)}`;
  if (kit === null) return `- ${quote(sound.name)}: program ${sound.program}${bank}${category}`;
  const use = kitDrumMap(kit.model, sound);
  const map = use.state === 'known' ? `, drum map ${quote(use.map.name)} (${use.map.notes.length} notes)` : ', drum map unknown';
  return `- ${quote(sound.name)} (drum kit): program ${sound.program}${bank}${category}${map}`;
}

/** The reply of a search: the catalog, how many sounds matched, the first ones, and how many more there are. */
export function searchReply(options: { id: string; modelName: string; model: InstrumentModel; catalog: Catalog; result: SearchResult }): string {
  const { id, modelName, model, catalog, result } = options;
  const kitCount = catalog.kits?.length ?? 0;
  const held = kitCount === 0 ? `${catalog.sounds.length} sounds` : countText(catalog.sounds.length, kitCount);
  const lines = [`Catalog of ${quote(id)} (${modelName}), from ${quote(catalog.source)}: ${held}; programs as sent (0-127).`];
  if (result.total === 0) {
    lines.push(kitCount === 0 ? 'No sound matches.' : 'No sound or drum kit matches.', categoriesSentence(catalog, 'Categories: '));
    return lines.join('\n');
  }
  if (result.total === 1) lines.push('1 match:');
  else lines.push(result.total > MAX_SEARCH_RESULTS ? `${result.total} matches, first ${MAX_SEARCH_RESULTS}:` : `${result.total} matches:`);
  result.matches.forEach((sound, index) => lines.push(matchLine(sound, result.kits[index] === true ? { model } : null)));
  if (result.total > MAX_SEARCH_RESULTS) lines.push(`${result.total - MAX_SEARCH_RESULTS} more, refine your search.`);
  if (result.matches.some((sound) => /['\\]/.test(sound.name))) {
    lines.push("A name with ' or \\ takes a backslash before that character inside the single quotes of the code.");
  }
  return lines.join('\n');
}

/** A catalog that could not be written: `code` is `exists` (a file is there and was not to be replaced) or the error code of the file system. */
export class CatalogSaveError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

/**
 * The text of a catalog file: the model and source lines, then one sound per line (about 420 KB for
 * 5,000 sounds, where indented JSON is nearly twice that), then the kits list when there are kits,
 * ending with a newline.
 */
export function catalogFileText(catalog: Catalog): string {
  const list = (items: object[]): string => `[\n${items.map((item) => `  ${JSON.stringify(item)}`).join(',\n')}\n  ]`;
  const sounds = catalog.sounds.length === 0 ? '[]' : list(catalog.sounds);
  const kits = catalog.kits === undefined || catalog.kits.length === 0 ? '' : `,\n  "kits": ${list(catalog.kits)}`;
  return `{\n  "model": ${JSON.stringify(catalog.model)},\n  "source": ${JSON.stringify(catalog.source)},\n  "sounds": ${sounds}${kits}\n}\n`;
}

/**
 * Writes `<data>/catalogs/<model id>.json`: the file is written whole beside its name and renamed over
 * it, so a crash never leaves half a catalog for the rig to read. An existing file is replaced only when
 * `replace` is true; nothing is written then. The path is built only from a model id that passes the
 * model id rule, so it cannot leave the catalogs folder. Returns the file written.
 */
export function saveCatalog(options: { dataDir: string; catalog: Catalog; replace: boolean }): string {
  const { dataDir, catalog, replace } = options;
  if (!modelIdSchema.safeParse(catalog.model).success) {
    throw new CatalogSaveError('The catalog does not name a valid model id, so it cannot be saved.', 'invalid id');
  }
  const id = catalog.model;
  const folder = path.join(dataDir, CATALOGS_DIR_NAME);
  const file = path.join(folder, `${id}.json`);
  const failed = (err: unknown): CatalogSaveError => {
    const code = errnoCode(err);
    return new CatalogSaveError(`Catalog "${id}" could not be saved: ${code}.`, code);
  };
  try {
    mkdirSync(folder, { recursive: true });
  } catch (err) {
    throw failed(err);
  }
  if (!replace && existsSync(file)) throw new CatalogSaveError(`${CATALOGS_DIR_NAME}/${id}.json already exists.`, 'exists');
  const temporary = `${file}.tmp`;
  try {
    writeFileSync(temporary, catalogFileText(catalog));
    renameWithRetry(temporary, file);
  } catch (err) {
    try {
      unlinkSync(temporary);
    } catch {
      // The temporary file is not there, or is a folder that is none of ours to remove; the error below is the one to report.
    }
    throw failed(err);
  }
  return file;
}

/** How a sound list numbers its programs: from 0 as sent, or from 1 as most manuals print them. */
export type ProgramNumbering = 'from-0' | 'from-1';

/** One group of a part, as sound lists print them: a category, a bank, and sounds with the program as printed. */
export interface CatalogPartGroup {
  category?: string;
  bank?: { msb: number; lsb?: number };
  /** 'rhythm' for the drum kits of a model whose rhythm channels take a bank; absent or 'melodic' for melodic sounds. */
  role?: 'melodic' | 'rhythm';
  /** Rhythm groups only: the id of the drum map of these kits, or null when no map is known for them. */
  noteMap?: string | null;
  sounds: { program: number; name: string }[];
}

/**
 * Flattens the groups of one part into catalog sounds and drum kits (a group with role rhythm), in order,
 * converting each program to the number sent (a list numbered from 1 stores the program minus one; bank
 * numbers are never converted). `paths[i]` names where `sounds[i]` came from (`banks[g].sounds[j]`), and
 * `kitPaths[i]` the same for `kits[i]`, so a refusal can point into the call. A program outside the
 * numbering is a problem; its sound is still kept so the paths stay aligned.
 */
export function flattenCatalogPart(
  banks: CatalogPartGroup[],
  numbering: ProgramNumbering,
): { sounds: CatalogSound[]; kits: CatalogKit[]; paths: string[]; kitPaths: string[]; problems: Problem[] } {
  const sounds: CatalogSound[] = [];
  const kits: CatalogKit[] = [];
  const paths: string[] = [];
  const kitPaths: string[] = [];
  const problems: Problem[] = [];
  const first = numbering === 'from-1' ? 1 : 0;
  const last = first + 127;
  banks.forEach((group, g) => {
    const rhythm = group.role === 'rhythm';
    if (!rhythm && group.noteMap !== undefined) problems.push({ field: `banks[${g}].noteMap`, reason: 'is only for a group with role rhythm' });
    group.sounds.forEach((entry, j) => {
      const at = `banks[${g}].sounds[${j}]`;
      if (!Number.isInteger(entry.program) || entry.program < first || entry.program > last) {
        let reason = `${entry.program} is not a whole program number`;
        if (Number.isInteger(entry.program) && entry.program > last) reason = `${entry.program} is above ${last} in a list numbered from ${first}`;
        else if (Number.isInteger(entry.program) && entry.program < first) reason = `${entry.program} is not a program number in a list numbered from ${first}`;
        problems.push({ field: `${at}.program`, reason });
      }
      const sound: CatalogKit = { name: entry.name, program: entry.program - first };
      if (group.category !== undefined) sound.category = group.category;
      if (group.bank !== undefined) sound.bank = group.bank.lsb === undefined ? { msb: group.bank.msb } : { msb: group.bank.msb, lsb: group.bank.lsb };
      if (rhythm) {
        if (group.noteMap !== undefined) sound.noteMap = group.noteMap;
        kits.push(sound);
        kitPaths.push(at);
      } else {
        sounds.push(sound);
        paths.push(at);
      }
    });
  });
  return { sounds, kits, paths, kitPaths, problems };
}

/** The part of a sound line that says where it is: the category, the bank and both numberings of the program. */
function summaryLine(label: string, sound: CatalogKit): string {
  const parts: string[] = [];
  if (sound.category !== undefined) parts.push(`category ${quote(sound.category)}`);
  if (sound.bank !== undefined) parts.push(`bank ${sound.bank.lsb === undefined ? sound.bank.msb : `${sound.bank.msb}/${sound.bank.lsb}`}`);
  parts.push(`program ${sound.program} as sent, ${sound.program + 1} in a manual numbered from 1`);
  return `${label}: ${quote(sound.name)} (${parts.join(', ')}).`;
}

/**
 * The summary the user is shown before a catalog drafted from a sound list is saved, one fact per line:
 * the model and the source, how the list numbers programs, the categories with counts, the bank select
 * and the number of banks, the first, middle and last sounds with their program as sent and as a
 * manual numbered from 1 prints it, so a shift by one is visible, and the first and last drum kit the same way.
 * `replaces` says an existing catalog is replaced.
 */
export function summarizeCatalog(options: { catalog: Catalog; model: InstrumentModel; numbering: ProgramNumbering; replaces: boolean }): string {
  const { catalog, model, numbering, replaces } = options;
  const { sounds } = catalog;
  const kits = catalog.kits ?? [];
  const total = sounds.length;
  const held = kits.length === 0 ? `${total} ${total === 1 ? 'sound' : 'sounds'}` : countText(total, kits.length);
  const lines = [`Catalog for model "${catalog.model}" (${model.name}), from ${quote(catalog.source)}: ${held}.`];
  lines.push(
    numbering === 'from-1'
      ? 'Numbering: the list numbers programs from 1; they are stored as sent, from 0.'
      : 'Numbering: the list numbers programs from 0, as sent; they are stored as written.',
  );
  const counts = categoryCounts(catalog);
  lines.push(counts.length === 0 ? 'Categories: none.' : `Categories: ${categoryList(counts, 20)}.`);
  if (model.bankSelect === 'none') {
    lines.push('Bank select: none.');
  } else {
    const banks = new Set([...sounds, ...kits].map((sound) => `${sound.bank?.msb ?? 0}/${sound.bank?.lsb ?? 0}`)).size;
    lines.push(`Bank select: ${model.bankSelect === 'msb' ? 'CC0' : 'CC0 then CC32'}; ${banks} ${banks === 1 ? 'bank' : 'banks'}.`);
  }
  if (total >= 1) lines.push(summaryLine('First', sounds[0] as CatalogSound));
  if (total >= 3) lines.push(summaryLine('Middle', sounds[Math.floor((total - 1) / 2)] as CatalogSound));
  if (total >= 2) lines.push(summaryLine('Last', sounds[total - 1] as CatalogSound));
  if (kits.length > 0) {
    const first = kits[0] as CatalogKit;
    const last = kits[kits.length - 1] as CatalogKit;
    lines.push(
      `Kits: ${kits.length}, from ${quote(first.name)} (program ${first.program} as sent, ${first.program + 1} in a manual numbered from 1) ` +
        `to ${quote(last.name)} (program ${last.program}, ${last.program + 1}).`,
    );
  }
  if (replaces) lines.push(`It replaces the existing ${CATALOGS_DIR_NAME}/${catalog.model}.json.`);
  return lines.join('\n');
}

/** Whether `<data>/catalogs/<model id>.json` exists; the id must already have passed the model id rule. */
export function catalogFileExists(dataDir: string, id: string): boolean {
  return existsSync(path.join(dataDir, CATALOGS_DIR_NAME, `${id}.json`));
}

/** A header and one `- field: reason` line per problem, at most MAX_RIG_PROBLEMS of them, then the rest counted. */
export function problemsText(header: string, problems: Problem[]): string {
  const lines = [header];
  for (const problem of problems.slice(0, MAX_RIG_PROBLEMS)) {
    lines.push(`- ${cleanProblemText(problem.field)}: ${cleanProblemText(problem.reason)}`);
  }
  if (problems.length > MAX_RIG_PROBLEMS) lines.push(`- and ${problems.length - MAX_RIG_PROBLEMS} more problems`);
  return lines.join('\n');
}
