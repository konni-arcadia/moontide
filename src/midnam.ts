// MIDNAM: the MIDI Manufacturers Association's XML format for the patch names of an instrument.
// This is a small reader for the one shape Moontide needs, the patch banks, with no XML library.
// Real files hold a raw ">" and "=" inside a quoted name (`Name="Line -> Arrow"`), so the scanner is
// quote-aware and a tag does not end at the first ">". No DTD is processed and nothing is fetched: a
// DOCTYPE with its internal subset is skipped whole, and only the five named entities and numeric
// references are decoded, once; any other entity reference in an attribute is refused with its line.
// The program of a sound is the ProgramChange value as sent (0-127); the Patch Number attribute is a
// label for a person and never the program.
//
// The module is pure: it takes text and gives values or throws a MidnamError whose message is the
// reason, with its line. No file system, no network. No sound name is ever exported as a string
// constant from this module, because test/guidance.test.js scans the exported strings of the modules
// it loads.

import type { CatalogKit, CatalogSound } from './catalog.js';
import type { InstrumentModel } from './instruments.js';
import { CONTROL_CHARS, cleanProblemText, soundKey } from './rig-util.js';

/** A file the reader refuses; the message is the reason, with its line where it has one. */
export class MidnamError extends Error {}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

const REFERENCE = /&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z_:][A-Za-z0-9_:.-]*);/g;

/** One reference as its character, or null when it is not one the reader knows (a DTD or HTML entity, a bad code point). */
function referenceValue(body: string): string | null {
  if (body.startsWith('#')) {
    const point = body[1] === 'x' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
    const valid = Number.isInteger(point) && point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff);
    return valid ? String.fromCodePoint(point) : null;
  }
  return Object.hasOwn(ENTITIES, body) ? (ENTITIES[body] as string) : null;
}

/**
 * The five named entities and numeric references (`&#233;`, `&#xE9;`) in a value. Anything else, a
 * DTD entity or a code point outside the valid range, stays as written. One pass: `&amp;lt;` is `&lt;`.
 * The reader does not accept such a leftover: `tags` refuses it (see `unknownReference`).
 */
export function decodeEntities(text: string): string {
  return text.replace(REFERENCE, (match: string, body: string) => referenceValue(body) ?? match);
}

/** The first reference of a raw value that the reader cannot decode, as written, or null when there is none. */
function unknownReference(raw: string): string | null {
  for (const match of raw.matchAll(REFERENCE)) {
    if (referenceValue(match[1] as string) === null) return match[0];
  }
  return null;
}

/** One element tag: its name, its attributes (entities decoded), whether it closes or is self-closing, and its line. */
export interface Tag {
  name: string;
  attrs: Record<string, string>;
  close: boolean;
  self: boolean;
  line: number;
}

const TAG_NAME = /[A-Za-z_:][A-Za-z0-9_:.-]*/y;
const ATTRIBUTE = /\s+([A-Za-z_:][A-Za-z0-9_:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/y;

/**
 * The element tags of a document in order. The XML declaration, comments, CDATA sections and the
 * DOCTYPE (with its internal subset) are skipped, and so is all text between tags. One linear pass.
 * Throws a MidnamError for a tag it cannot read, with the line.
 */
export function* tags(text: string): Generator<Tag> {
  let line = 1;
  let nextNewline = text.indexOf('\n');
  if (nextNewline === -1) nextNewline = Infinity;
  // The line of a position; positions are asked for in increasing order, so the scan stays linear.
  const lineOf = (position: number): number => {
    while (nextNewline < position) {
      line++;
      const found = text.indexOf('\n', nextNewline + 1);
      nextNewline = found === -1 ? Infinity : found;
    }
    return line;
  };
  const skipTo = (start: number, open: string, end: string, what: string): number => {
    const stop = text.indexOf(end, start + open.length);
    if (stop === -1) throw new MidnamError(`unterminated ${what} at line ${lineOf(start)}`);
    return stop + end.length;
  };
  // `<!DOCTYPE ... [ internal subset ] >`: brackets and quotes decide where it ends.
  const skipDeclaration = (start: number): number => {
    let depth = 0;
    let quote = '';
    for (let index = start + 2; index < text.length; index++) {
      const char = text[index];
      if (quote !== '') {
        if (char === quote) quote = '';
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === '[') {
        depth++;
      } else if (char === ']') {
        depth = Math.max(0, depth - 1);
      } else if (char === '<' && text.startsWith('<!--', index)) {
        index = skipTo(index, '<!--', '-->', 'comment') - 1;
      } else if (char === '>' && depth === 0) {
        return index + 1;
      }
    }
    throw new MidnamError(`unterminated ${text.startsWith('<!DOCTYPE', start) ? 'DOCTYPE' : 'declaration'} at line ${lineOf(start)}`);
  };

  let at = 0;
  while (at < text.length) {
    const start = text.indexOf('<', at);
    if (start === -1) return;
    if (text.startsWith('<!--', start)) {
      at = skipTo(start, '<!--', '-->', 'comment');
      continue;
    }
    if (text.startsWith('<![CDATA[', start)) {
      at = skipTo(start, '<![CDATA[', ']]>', 'CDATA section');
      continue;
    }
    if (text.startsWith('<?', start)) {
      at = skipTo(start, '<?', '?>', 'processing instruction');
      continue;
    }
    if (text.startsWith('<!', start)) {
      at = skipDeclaration(start);
      continue;
    }
    // An element tag ends at the first ">" outside quotes; a "<" outside quotes inside it is an error.
    let quote = '';
    let end = start + 1;
    for (; end < text.length; end++) {
      const char = text[end];
      if (quote !== '') {
        if (char === quote) quote = '';
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === '<') {
        throw new MidnamError(`"<" inside a tag at line ${lineOf(end)}`);
      } else if (char === '>') {
        break;
      }
    }
    if (end >= text.length) throw new MidnamError(`unterminated tag at line ${lineOf(start)}`);
    const tagLine = lineOf(start);
    const inner = text.slice(start + 1, end);
    at = end + 1;

    const close = inner.startsWith('/');
    TAG_NAME.lastIndex = close ? 1 : 0;
    const found = TAG_NAME.exec(inner);
    if (found === null) throw new MidnamError(`cannot read the tag at line ${tagLine}`);
    const name = found[0];
    let rest = inner.slice(TAG_NAME.lastIndex);
    const self = !close && rest.endsWith('/');
    if (self) rest = rest.slice(0, -1);
    const attrs: Record<string, string> = {};
    let position = 0;
    for (;;) {
      ATTRIBUTE.lastIndex = position;
      const attribute = ATTRIBUTE.exec(rest);
      if (attribute === null) break;
      const key = attribute[1] as string;
      if (Object.hasOwn(attrs, key)) throw new MidnamError(`duplicate attribute "${key}" in <${name}> at line ${tagLine}`);
      const rawValue = attribute[2] ?? attribute[3] ?? '';
      const unknown = unknownReference(rawValue);
      if (unknown !== null) {
        throw new MidnamError(
          `cannot read "${label(unknown)}" in ${key} of <${name}> at line ${tagLine}; only &amp; &lt; &gt; &quot; &apos; and numeric references are read`,
        );
      }
      attrs[key] = decodeEntities(rawValue);
      position = ATTRIBUTE.lastIndex;
    }
    if (rest.slice(position).trim() !== '') {
      throw new MidnamError(
        close ? `cannot read the close tag </${name}> at line ${tagLine}` : `cannot read the attributes of <${name}> at line ${tagLine}`,
      );
    }
    if (close && position > 0) throw new MidnamError(`cannot read the close tag </${name}> at line ${tagLine}`);
    yield { name, attrs, close, self, line: tagLine };
  }
}

/** A patch of a bank: its name as written, the program as sent, the bank select it carries (null when none) and its line. */
export interface MidnamPatch {
  name: string;
  program: number;
  msb: number | null;
  lsb: number | null;
  line: number;
}

/** A patch bank in file order. `channels` are the channels a name set is available on (null when it says nothing). */
export interface MidnamBank {
  name: string;
  line: number;
  channels: number[] | null;
  patches: MidnamPatch[];
}

export interface MidnamFile {
  banks: MidnamBank[];
}

/** A name for a message: control characters removed and cut short, so a reason stays one readable line. */
function label(text: string): string {
  const cleaned = Array.from(cleanProblemText(text));
  return cleaned.length > 60 ? `${cleaned.slice(0, 59).join('')}…` : cleaned.join('');
}

/** A value of a file as a number from 0 to 127, or the reason it is not one (the caller words the rest). */
function byteOf(text: string): { ok: true; value: number } | { ok: false; shown: string; reason: string } {
  if (!/^[0-9]+$/.test(text)) return { ok: false, shown: JSON.stringify(label(text)), reason: 'is not a whole number' };
  const value = Number.parseInt(text, 10);
  if (value > 127) return { ok: false, shown: String(value), reason: 'is not between 0 and 127' };
  return { ok: true, value };
}

interface RawPatch {
  name: string;
  line: number;
  /** The ProgramChange attribute as written, when there is one. */
  program: string | undefined;
  /** The ControlChange commands of its PatchMIDICommands, as written. */
  controls: { control: string; value: string }[];
  /** The ProgramChange commands of its PatchMIDICommands, as written. */
  commands: { number: string }[];
}

interface OpenBank {
  name: string;
  line: number;
  channels: number[] | null;
  /** The MasterDeviceNames it sits in (index), or -1 outside one. */
  device: number;
  msb: number | null;
  lsb: number | null;
  patches: RawPatch[];
  /** The named list it uses (`UsesPatchNameList`), defined anywhere under the same device. */
  uses: { name: string; line: number } | null;
}

/** The patch list a PatchNameList being read fills: a bank's own (inline), a named one under the device, or none. */
type OpenList = { kind: 'inline' } | { kind: 'named'; patches: RawPatch[] };

const MAX_DEPTH = 100;
/** Patches of a file once the lists its banks use are counted per bank; well above the 5000 sounds a catalog holds. */
const MAX_EXPANDED_PATCHES = 100_000;

/** The patch as the catalog needs it: the program and the bank select, the patch's own commands over its bank's. */
function resolvePatch(one: RawPatch, bank: OpenBank): MidnamPatch {
  const own = `patch "${label(one.name)}"`;
  const where = `of ${own} in bank "${label(bank.name)}" (line ${one.line})`;
  let { msb, lsb } = bank;
  for (const { control, value } of one.controls) {
    if (control !== '0' && control !== '32') {
      throw new MidnamError(`ControlChange ${label(control)} in ${own} (line ${one.line}) is not a bank select (only 0 and 32 are read)`);
    }
    const byte = byteOf(value);
    if (!byte.ok) throw new MidnamError(`value ${byte.shown} of ControlChange ${control} ${where} ${byte.reason}`);
    if (control === '0') msb = byte.value;
    else lsb = byte.value;
  }
  const programs: { source: string; value: number }[] = [];
  const addProgram = (source: string, text: string): void => {
    const byte = byteOf(text);
    if (!byte.ok) throw new MidnamError(`program ${byte.shown} ${where} ${byte.reason}`);
    programs.push({ source, value: byte.value });
  };
  if (one.program !== undefined) addProgram('attribute', one.program);
  for (const command of one.commands) addProgram('command', command.number);
  const [first] = programs;
  if (first === undefined) throw new MidnamError(`${own} (line ${one.line}) has no program`);
  const other = programs.find((entry) => entry.value !== first.value);
  if (other !== undefined) {
    const subject = first.source === other.source ? 'ProgramChange commands' : `ProgramChange ${first.source} ${first.value} and ${other.source}`;
    const wording = first.source === other.source ? `${first.value} and ${other.value}` : `${other.value}`;
    throw new MidnamError(`${own} (line ${one.line}): ${subject} ${wording} differ`);
  }
  return { name: one.name, program: first.value, msb, lsb, line: one.line };
}

/**
 * Reads the patch banks of a MIDNAM document in file order. The bank select of a patch comes from its
 * bank's MIDICommands (Control 0 is the MSB, 32 the LSB) and from its own PatchMIDICommands, which win
 * for the same control; the program from the ProgramChange attribute or the ProgramChange command (as
 * sent, 0-127). A bank holds an inline PatchNameList or uses a named one, which may come later in the
 * file. ControlChange and ProgramChange anywhere else are device commands and are ignored. Throws a
 * MidnamError for anything it cannot read as stated: a syntax error, a root that is not
 * MIDINameDocument, a value outside 0-127, a control that is not a bank select, a patch with no
 * program, a list that is not defined, patches under two devices, a file with no patch.
 */
export function readMidnam(raw: string): MidnamFile {
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const declaration = /^\s*<\?xml\s[^?]*?\bencoding\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(text.slice(0, 1000));
  const encoding = declaration === null ? undefined : (declaration[1] ?? declaration[2]);
  if (encoding !== undefined && !/^utf-?8$/i.test(encoding)) {
    throw new MidnamError(`the file declares the encoding "${label(encoding)}"; only UTF-8 is read`);
  }

  const stack: { name: string; line: number }[] = [];
  const banks: OpenBank[] = [];
  const masters: { line: number }[] = [];
  const lists = new Map<string, { line: number; patches: RawPatch[] }>();
  let sawRoot = false;
  let sawExtending = false;
  let device: number | null = null;
  let channelSet: number[] | null = null;
  let bank: OpenBank | null = null;
  let list: OpenList | null = null;
  let patch: RawPatch | null = null;

  const closed = (name: string): void => {
    if (name === 'PatchBank') bank = null;
    else if (name === 'PatchNameList') list = null;
    else if (name === 'Patch') patch = null;
    else if (name === 'ChannelNameSet') channelSet = null;
    else if (name === 'MasterDeviceNames') device = null;
  };

  for (const tag of tags(text)) {
    if (tag.close) {
      const top = stack.pop();
      if (top === undefined) throw new MidnamError(`</${tag.name}> at line ${tag.line} closes nothing`);
      if (top.name !== tag.name) {
        throw new MidnamError(`</${tag.name}> at line ${tag.line} does not close <${top.name}> (line ${top.line})`);
      }
      closed(tag.name);
      continue;
    }
    const parent = stack[stack.length - 1]?.name;
    const grandparent = stack[stack.length - 2]?.name;
    if (parent === undefined) {
      if (sawRoot) throw new MidnamError(`<${tag.name}> at line ${tag.line} is a second root element`);
      if (tag.name !== 'MIDINameDocument') throw new MidnamError(`the root element is <${tag.name}>, not <MIDINameDocument>`);
      sawRoot = true;
    }
    switch (tag.name) {
      case 'MasterDeviceNames':
        masters.push({ line: tag.line });
        device = masters.length - 1;
        break;
      case 'ExtendingDeviceNames':
        sawExtending = true;
        break;
      case 'ChannelNameSet':
        channelSet = null;
        break;
      case 'AvailableForChannels':
        if (parent === 'ChannelNameSet') channelSet = [];
        break;
      case 'AvailableChannel':
        if (channelSet !== null && parent === 'AvailableForChannels' && (tag.attrs.Available ?? '').toLowerCase() === 'true') {
          const channel = tag.attrs.Channel ?? '';
          if (!/^[0-9]+$/.test(channel)) throw new MidnamError(`AvailableChannel at line ${tag.line} has a Channel that is not a whole number`);
          channelSet.push(Number.parseInt(channel, 10));
        }
        break;
      case 'PatchBank':
        bank = { name: tag.attrs.Name ?? '', line: tag.line, channels: channelSet, device: device ?? -1, msb: null, lsb: null, patches: [], uses: null };
        banks.push(bank);
        break;
      case 'ControlChange':
        if (parent === 'MIDICommands' && grandparent === 'PatchBank' && bank !== null) {
          const open: OpenBank = bank;
          const where = `in bank "${label(open.name)}" (line ${open.line})`;
          const control = tag.attrs.Control ?? '';
          if (control !== '0' && control !== '32') {
            throw new MidnamError(`ControlChange ${label(control)} ${where} is not a bank select (only 0 and 32 are read)`);
          }
          const value = byteOf(tag.attrs.Value ?? '');
          if (!value.ok) throw new MidnamError(`value ${value.shown} of ControlChange ${control} ${where} ${value.reason}`);
          if (control === '0') open.msb = value.value;
          else open.lsb = value.value;
        } else if (parent === 'PatchMIDICommands' && patch !== null) {
          (patch as RawPatch).controls.push({ control: tag.attrs.Control ?? '', value: tag.attrs.Value ?? '' });
        }
        break;
      case 'ProgramChange':
        if (parent === 'PatchMIDICommands' && patch !== null) (patch as RawPatch).commands.push({ number: tag.attrs.Number ?? '' });
        break;
      case 'PatchNameList':
        if (bank !== null && parent === 'PatchBank') {
          list = { kind: 'inline' };
        } else if (device !== null && parent === 'MasterDeviceNames' && tag.attrs.Name !== undefined) {
          const key = `${device}:${tag.attrs.Name}`;
          const earlier = lists.get(key);
          if (earlier !== undefined) {
            throw new MidnamError(`two patch lists named "${label(tag.attrs.Name)}" under one MasterDeviceNames (lines ${earlier.line} and ${tag.line})`);
          }
          const entry = { line: tag.line, patches: [] as RawPatch[] };
          lists.set(key, entry);
          list = { kind: 'named', patches: entry.patches };
        }
        break;
      case 'UsesPatchNameList':
        if (bank !== null && parent === 'PatchBank') (bank as OpenBank).uses = { name: tag.attrs.Name ?? '', line: tag.line };
        break;
      case 'Patch':
        if (list !== null && parent === 'PatchNameList') {
          const open: RawPatch = { name: tag.attrs.Name ?? '', line: tag.line, program: tag.attrs.ProgramChange, controls: [], commands: [] };
          patch = open;
          if ((list as OpenList).kind === 'inline') (bank as OpenBank | null)?.patches.push(open);
          else ((list as { kind: 'named'; patches: RawPatch[] }).patches).push(open);
        }
        break;
      default:
        break;
    }
    if (tag.self) {
      closed(tag.name);
    } else {
      if (stack.length >= MAX_DEPTH) throw new MidnamError(`<${tag.name}> at line ${tag.line} is nested more than ${MAX_DEPTH} levels deep`);
      stack.push({ name: tag.name, line: tag.line });
    }
  }
  const unclosed = stack[stack.length - 1];
  if (unclosed !== undefined) throw new MidnamError(`<${unclosed.name}> at line ${unclosed.line} is never closed`);
  if (!sawRoot) throw new MidnamError('the file holds no element');

  // A bank that uses a named list takes its patches after its own, in the bank's place in the file order.
  // Every bank gets its own copy, so the total is counted before each copy and capped: many banks sharing
  // one list would otherwise multiply it. A loop, not a spread: a spread of a big list overflows the stack.
  let expanded = 0;
  for (const entry of banks) {
    expanded += entry.patches.length;
    if (entry.uses !== null) {
      const used = lists.get(`${entry.device}:${entry.uses.name}`);
      if (used === undefined) {
        throw new MidnamError(`bank "${label(entry.name)}" (line ${entry.line}) uses the patch list "${label(entry.uses.name)}", which the file does not define`);
      }
      expanded += used.patches.length;
      if (expanded > MAX_EXPANDED_PATCHES) {
        throw new MidnamError(
          `the file lists more than ${MAX_EXPANDED_PATCHES} patches once the lists its banks use are counted (bank "${label(entry.name)}", line ${entry.line})`,
        );
      }
      for (const one of used.patches) entry.patches.push(one);
    } else if (expanded > MAX_EXPANDED_PATCHES) {
      throw new MidnamError(`the file lists more than ${MAX_EXPANDED_PATCHES} patches once the lists its banks use are counted`);
    }
  }
  const result: MidnamBank[] = banks.map((entry) => ({
    name: entry.name,
    line: entry.line,
    channels: entry.channels,
    patches: entry.patches.map((one) => resolvePatch(one, entry)),
  }));
  const filled = banks.filter((entry) => entry.patches.length > 0);
  if (filled.length === 0) {
    if (masters.length === 0 && sawExtending) {
      throw new MidnamError("the file only extends another device's names (ExtendingDeviceNames) and holds no patch bank of its own");
    }
    throw new MidnamError('no patch found under a PatchBank');
  }
  const devices = new Map<number, number>();
  for (const entry of filled) {
    if (!devices.has(entry.device)) devices.set(entry.device, masters[entry.device]?.line ?? entry.line);
  }
  if (devices.size > 1) {
    const [first, second] = Array.from(devices.values());
    throw new MidnamError(`patches under more than one MasterDeviceNames (lines ${first} and ${second})`);
  }
  return { banks: result };
}

export interface MidnamCounts {
  /** Sounds in name sets that are available on the model's rhythm channels only, skipped because those channels take no bank. */
  rhythm: number;
  /** Patches with an empty name. */
  unnamed: number;
  /** The same name at the same address as an earlier sound, kept once. */
  merged: number;
  /** Sounds renamed with their address, because their name stands at another address too. */
  renamed: number;
  /** Sounds the model already has at the same address. */
  inModel: number;
  /** Banks that give only an LSB, written with MSB 0. */
  lsbOnly: number;
}

/** A name or category as the catalog keeps it: whitespace runs are one space, no control character is left. */
function cleaned(text: string, what: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (CONTROL_CHARS.test(flat)) throw new MidnamError(`${what} has a control character in its name`);
  return flat;
}

const MAX_NAME_LENGTH = 80;

interface Item {
  name: string;
  key: string;
  address: string;
  category: string;
  program: number;
  msb: number | null;
  lsb: number | null;
  bank: MidnamBank;
  /** A patch of a name set for the rhythm channels of a model whose rhythm channels take a bank: a drum kit. */
  kit: boolean;
}

/**
 * The catalog sounds and drum kits of a read file for a model, as that model sends them. Each patch of
 * each bank is a sound with the bank name as its category, except: banks of a name set available only
 * on the model's rhythm channels, patches with no name, and a name the model already has at the same
 * address. The rhythm-only name sets are skipped and counted, unless the model's rhythm channels take a
 * bank (rhythmBank): then their patches are its drum kits, each of which must carry a bank select in
 * the file. A name that stands at two addresses (in the file, or in the file and the model) is renamed
 * with its address so every name means one address; the same name at the same address is kept once.
 * Sounds and kits are kept apart: a name is compared with the model's melodic names for a sound and with
 * its rhythm names for a kit. Every skip, merge and rename is counted. Pure: no file system.
 */
export function midnamSounds(
  file: MidnamFile,
  model: InstrumentModel,
): { sounds: CatalogSound[]; kits: CatalogKit[]; banks: number; counts: MidnamCounts } {
  const counts: MidnamCounts = { rhythm: 0, unnamed: 0, merged: 0, renamed: 0, inModel: 0, lsbOnly: 0 };
  const rhythmChannels = new Set(model.channels.rhythm);
  const addressOf = (msb: number | null, lsb: number | null, program: number): string => {
    if (model.bankSelect === 'none') return `${program}`;
    if (model.bankSelect === 'msb') return `${msb ?? 0}:${program}`;
    return `${msb ?? 0}:${lsb ?? 0}:${program}`;
  };
  const suffixOf = (item: Item): string => {
    if (model.bankSelect === 'none') return ` (program ${item.program})`;
    if (model.bankSelect === 'msb') return ` (bank ${item.msb ?? 0}, program ${item.program})`;
    return ` (bank ${item.msb ?? 0}/${item.lsb ?? 0}, program ${item.program})`;
  };

  const items: Item[] = [];
  let keptPatches = 0;
  for (const entry of file.banks) {
    if (entry.patches.length === 0) continue;
    const rhythmOnly = entry.channels !== null && entry.channels.length > 0 && entry.channels.every((channel) => rhythmChannels.has(channel));
    if (rhythmOnly && model.rhythmBank !== true) {
      counts.rhythm += entry.patches.length;
      continue;
    }
    const category = cleaned(entry.name, `bank at line ${entry.line}`);
    for (const one of entry.patches) {
      if (!rhythmOnly) keptPatches++;
      const name = cleaned(one.name, `patch at line ${one.line}`);
      if (name === '') {
        counts.unnamed++;
        continue;
      }
      if (rhythmOnly && one.msb === null && one.lsb === null) {
        // A kit with no bank would go out as bank 0/0, a melodic tone on the drum part: refused instead.
        throw new MidnamError(
          `patch at line ${one.line} (${JSON.stringify(name)}) serves rhythm channels only and model ${model.id} chooses its kits by bank select, but the file gives it no bank`,
        );
      }
      items.push({
        name,
        key: soundKey(name),
        address: addressOf(one.msb, one.lsb, one.program),
        category,
        program: one.program,
        msb: one.msb,
        lsb: one.lsb,
        bank: entry,
        kit: rhythmOnly,
      });
    }
  }

  const giving = new Set<MidnamBank>();
  const lsbOnly = new Set<MidnamBank>();
  // One list at a time: the sounds against the model's melodic names, the kits against its rhythm names.
  const build = (list: Item[], own: readonly { name: string; program: number; bank?: { msb: number; lsb?: number } | undefined }[]): CatalogSound[] => {
    // One sound per name and address: the same name at the same address is kept once.
    const addressesOfKey = new Map<string, Set<string>>();
    const kept: Item[] = [];
    for (const item of list) {
      const addresses = addressesOfKey.get(item.key) ?? new Set<string>();
      addressesOfKey.set(item.key, addresses);
      if (addresses.has(item.address)) {
        counts.merged++;
        continue;
      }
      addresses.add(item.address);
      kept.push(item);
    }
    const modelAddress = new Map(own.map((entry) => [soundKey(entry.name), addressOf(entry.bank?.msb ?? null, entry.bank?.lsb ?? null, entry.program)]));
    const result: CatalogSound[] = [];
    for (const item of kept) {
      const modelHas = modelAddress.get(item.key);
      if (modelHas === item.address) {
        counts.inModel++;
        continue;
      }
      let name = item.name;
      if (modelHas !== undefined || (addressesOfKey.get(item.key)?.size ?? 0) > 1) {
        const suffix = suffixOf(item);
        let base = name.slice(0, Math.max(0, MAX_NAME_LENGTH - suffix.length));
        if (base.length < name.length && /[\ud800-\udbff]$/.test(base)) base = base.slice(0, -1);
        name = `${base.trimEnd()}${suffix}`;
        counts.renamed++;
      }
      const bank = item.lsb !== null ? { msb: item.msb ?? 0, lsb: item.lsb } : item.msb !== null ? { msb: item.msb } : undefined;
      if (item.lsb !== null && item.msb === null) lsbOnly.add(item.bank);
      giving.add(item.bank);
      result.push({
        name,
        ...(item.category !== '' ? { category: item.category } : {}),
        program: item.program,
        ...(bank !== undefined ? { bank } : {}),
      });
    }
    return result;
  };
  const sounds = build(items.filter((item) => !item.kit), model.sounds.melodic);
  const kits = build(items.filter((item) => item.kit), model.sounds.rhythm);
  counts.lsbOnly = lsbOnly.size;

  if (sounds.length === 0 && kits.length === 0) {
    if (keptPatches === 0 && counts.rhythm > 0) {
      throw new MidnamError(`no melodic sound left: ${counts.rhythm} sounds are in name sets for rhythm channels only`);
    }
    if (items.length === 0) throw new MidnamError('no named patch');
    throw new MidnamError('no sound left: every named patch is already a sound of the model');
  }
  return { sounds, kits, banks: giving.size, counts };
}
