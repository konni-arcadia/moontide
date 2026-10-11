// The `import-midnam` command: `moontide-mcp import-midnam <file> --model <id> [--replace]` reads a
// MIDNAM file the user owns and writes the patch names of its banks into `catalogs/<id>.json` of the
// user's data folder, for a model that already exists. Moontide never downloads or ships such a
// file: this command reads only the one path it is given, and it opens no network connection. Every
// check runs before anything is written, so a refused file leaves the data folder as it was.
//
// The command is synchronous and never starts the server, reads stdin or touches the MCP transport:
// `runImportMidnam` takes the two output streams and the rig as arguments and returns the exit code
// (0 imported, 1 refused or failed with nothing written, 2 usage error).

import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { CatalogSaveError, MAX_CATALOG_KITS, MAX_CATALOG_SOUNDS, parseCatalog, saveCatalog, type Catalog } from './catalog.js';
import type { RigStore } from './instruments.js';
import { MidnamError, midnamSounds, readMidnam } from './midnam.js';
import { cleanProblemText, errnoCode, modelIdSchema, type Problem } from './rig-util.js';

const MAX_MIDNAM_BYTES = 8 * 1048576;
const MAX_SHOWN_PROBLEMS = 3;

export interface ImportIo {
  out: (line: string) => void;
  err: (line: string) => void;
  rig: RigStore;
}

const usage = 'Usage: moontide-mcp import-midnam <file> --model <id> [--replace]';

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** The refusal: what was not imported, one line per reason, and that nothing was written. Always exit code 1. */
function refuse(io: ImportIo, name: string, reasons: string[]): number {
  io.err(`Moontide: ${name} was not imported.`);
  for (const reason of reasons) io.err(`- ${cleanProblemText(reason)}`);
  io.err('Nothing was written.');
  return 1;
}

/** Up to three problems, then how many more. A problem inside a sound also names the sound. */
function problemReasons(problems: Problem[], sounds: readonly { name: string }[] = [], kits: readonly { name: string }[] = []): string[] {
  const reasons = problems.slice(0, MAX_SHOWN_PROBLEMS).map((problem) => {
    const at = /:(sounds|kits)\[(\d+)\]/.exec(problem.field);
    const sound = at === null ? undefined : (at[1] === 'kits' ? kits : sounds)[Number(at[2])];
    return sound === undefined ? `${problem.field}: ${problem.reason}` : `${problem.field} (${JSON.stringify(sound.name)}): ${problem.reason}`;
  });
  if (problems.length > MAX_SHOWN_PROBLEMS) reasons.push(`and ${plural(problems.length - MAX_SHOWN_PROBLEMS, 'more problem', 'more problems')}`);
  return reasons;
}

/** A sound as the summary shows it: category, bank, and the program as sent and as numbered from 1. */
function soundLine(sound: Catalog['sounds'][number]): string {
  const parts: string[] = [];
  if (sound.category !== undefined) parts.push(`category ${JSON.stringify(sound.category)}`);
  if (sound.bank !== undefined) parts.push(`bank ${sound.bank.lsb === undefined ? sound.bank.msb : `${sound.bank.msb}/${sound.bank.lsb}`}`);
  parts.push(`program ${sound.program} as sent, ${sound.program + 1} in a manual numbered from 1`);
  return `${JSON.stringify(sound.name)} (${parts.join(', ')})`;
}

function parseArguments(args: string[]) {
  return parseArgs({ args, allowPositionals: true, strict: true, options: { model: { type: 'string' }, replace: { type: 'boolean' } } });
}

export function runImportMidnam(args: string[], io: ImportIo): number {
  const usageError = (reason: string): number => {
    io.err(`Moontide: ${cleanProblemText(reason)}`);
    io.err(usage);
    return 2;
  };
  let parsed: ReturnType<typeof parseArguments>;
  try {
    parsed = parseArguments(args);
  } catch (err) {
    return usageError(err instanceof Error ? err.message : String(err));
  }
  const [fileArgument] = parsed.positionals;
  if (parsed.positionals.length !== 1 || fileArgument === undefined) {
    return usageError(parsed.positionals.length === 0 ? 'no MIDNAM file was given.' : `expected one MIDNAM file, got ${parsed.positionals.length}.`);
  }
  const id = parsed.values.model;
  if (id === undefined) return usageError('--model is required.');
  const file = path.resolve(fileArgument);
  const base = cleanProblemText(path.basename(file)) || 'the MIDNAM file';
  const replace = parsed.values.replace === true;

  // The model first: the bank shape of the file is checked against it, and its id becomes part of a path.
  const idCheck = modelIdSchema.safeParse(id);
  if (!idCheck.success) return refuse(io, base, [`--model: ${idCheck.error.issues[0]?.message ?? 'is not a model id'}`]);
  const found = io.rig.modelFor(id);
  if (!found.ok) return refuse(io, base, problemReasons(found.problems));
  const { model } = found;

  let size: number;
  try {
    const stat = statSync(file);
    if (!stat.isFile()) return refuse(io, base, ['is not a file']);
    size = stat.size;
  } catch (err) {
    return refuse(io, base, [`could not be read: ${errnoCode(err)}`]);
  }
  if (size > MAX_MIDNAM_BYTES) return refuse(io, base, ['the file is larger than 8 MiB']);
  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch (err) {
    return refuse(io, base, [`could not be read: ${errnoCode(err)}`]);
  }
  if (bytes.length > MAX_MIDNAM_BYTES) return refuse(io, base, ['the file is larger than 8 MiB']);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return refuse(io, base, ['the file is not valid UTF-8']);
  }

  let built: ReturnType<typeof midnamSounds>;
  try {
    built = midnamSounds(readMidnam(text), model);
  } catch (err) {
    if (err instanceof MidnamError) return refuse(io, base, [err.message]);
    throw err;
  }
  if (built.sounds.length > MAX_CATALOG_SOUNDS) {
    return refuse(io, base, [`the file gives ${built.sounds.length} sounds; a catalog holds at most ${MAX_CATALOG_SOUNDS}`]);
  }
  if (built.kits.length > MAX_CATALOG_KITS) {
    return refuse(io, base, [`the file gives ${built.kits.length} drum kits; a catalog holds at most ${MAX_CATALOG_KITS}`]);
  }

  const value = { model: id, source: base, sounds: built.sounds, ...(built.kits.length > 0 ? { kits: built.kits } : {}) };
  const checked = parseCatalog(value, model, `catalogs/${id}.json`);
  if (!checked.ok) return refuse(io, base, problemReasons(checked.problems, built.sounds, built.kits));

  let dataDir: string;
  try {
    dataDir = io.rig.resolveDataDir();
  } catch (err) {
    return refuse(io, base, [`the data folder could not be found: ${err instanceof Error ? err.message : String(err)}`]);
  }
  let written: string;
  try {
    written = saveCatalog({ dataDir, catalog: checked.catalog, replace });
  } catch (err) {
    if (err instanceof CatalogSaveError) {
      return refuse(io, base, [
        err.code === 'exists' ? `catalogs/${id}.json already exists in the Moontide data folder; pass --replace to replace it.` : err.message,
      ]);
    }
    throw err;
  }

  const { sounds } = checked.catalog;
  const kits = checked.catalog.kits ?? [];
  const { counts } = built;
  const imported = [
    ...(sounds.length > 0 ? [plural(sounds.length, 'sound', 'sounds')] : []),
    ...(kits.length > 0 ? [plural(kits.length, 'drum kit', 'drum kits')] : []),
  ].join(' and ');
  io.out(`Imported ${imported} in ${plural(built.banks, 'bank', 'banks')} from ${base} into ${written} (model ${id}).`);
  if (sounds.length > 0) {
    io.out(`First: ${soundLine(sounds[0] as Catalog['sounds'][number])}.`);
    io.out(`Last: ${soundLine(sounds[sounds.length - 1] as Catalog['sounds'][number])}.`);
  }
  if (kits.length > 0) {
    io.out(`First kit: ${soundLine(kits[0] as Catalog['sounds'][number])}.`);
    io.out(`Last kit: ${soundLine(kits[kits.length - 1] as Catalog['sounds'][number])}.`);
  }
  io.out(
    `Adjusted: ${counts.rhythm} skipped for rhythm channels, ${counts.unnamed} without a name, ${counts.inModel} already in the model; ` +
      `${counts.merged} merged at the same address; ${counts.renamed} renamed by address; ` +
      `${counts.lsbOnly} banks with only an LSB written with MSB 0.`,
  );
  io.out('The server reads it at its next change; no restart is needed.');
  return 0;
}

/**
 * The command as the entry point runs it: `runImportMidnam`, and an error nobody planned for (a bug, not a
 * refusal) ends as one readable line and exit code 1 instead of a stack trace.
 */
export function runImportMidnamCommand(args: string[], io: ImportIo): number {
  try {
    return runImportMidnam(args, io);
  } catch (err) {
    io.err(`Moontide: import-midnam failed: ${cleanProblemText(err instanceof Error ? err.message : String(err))}`);
    return 1;
  }
}
