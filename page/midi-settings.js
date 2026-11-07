// The bytes of the settings written in `.midi()`, and the check that keeps every system exclusive message to an
// instrument inside the areas that hold nothing for good. Pure: no DOM at import and no import of the server's
// build, so node:test, page/midi-out.js, the probe and the bench can all load it.
//
// A setting is sent as one Roland data set. Its address comes from the model file (part 1's address for a tone or
// a part setting); this module adds the part, cuts the value into 4-bit pieces and adds the checksum. Before any
// byte leaves the page the same check reads the finished message again: a message that would write outside the
// instrument's temporary scene and temporary tones is never sent, whoever made it.
//
// A model may instead map a setting to an NRPN of the family it names (`nrpnFamily`). The page knows one family, the
// part offsets of the Roland GS family, and sends an NRPN only for a pair that family lists, as the five channel
// messages the manual documents. The same module checks those bytes again before they are sent (nrpnProblem).

import { fill } from './midi-plan.js';

/**
 * The words of a refusal. The first lines of a refused evaluation are built from these (the closing line is added by
 * the caller); the last four are single lines for the page's own log.
 */
export const SETTINGS_COPY = Object.freeze({
  kindNotSent: '"{setting}" of {id} is {kind} in its model, and Moontide sends only Roland data sets and the NRPN offsets it knows.',
  unguarded: 'Moontide does not know which addresses of {id} are temporary, so it sends none of its settings.',
  temporaryOnly: "Moontide sends a setting only where it can check that nothing is written to the instrument's memory.",
  partAddress: '"{setting}" in {level} for {id} has no address for part {part} (channel {channel}).',
  addressLength: '"{setting}" in {level} for {id} has an address of {length} bytes, and the data sets of this instrument take addresses of {size} bytes.',
  memoryWrite: '"{setting}" in {level} for {id} would write outside the temporary scene and tones of the instrument (address {address}), so it is not sent.',
  sendRefused: 'Moontide: a {level} setting for "{id}" was not sent: {reason}.',
  resetRefused: 'Moontide: the reset of "{id}" was not sent: {reason}.',
  sysexDropped: 'Moontide: a system exclusive message from the code to "{id}" was not sent: {reason}.',
  messageDropped: 'Moontide: a MIDI message from the code to "{id}" was not sent: {reason}, so Moontide cannot check that it writes nothing to the memory of the instrument.',
  nrpnUnknown: '"{setting}" of {id} is an NRPN in its model, and the model names no NRPN family Moontide knows.',
  nrpnNotListed: '"{setting}" of {id} maps to NRPN {pair}, which is not a part offset of the {family} family.',
  nrpnRange: '"{setting}" of {id} is an offset of the {family} family and takes whole numbers from {min} to {max}, not {value}.',
  nrpnRhythm: '"{setting}" of {id} is an offset of a melodic part, and channel {channel} is a rhythm channel of its model.',
  nrpnScene: '"{setting}" of {id} is an NRPN, which reaches one channel, so it is not a scene setting.',
  engineRow: '"{setting}" has a row for each engine of {id}, and Moontide cannot tell which one reaches the sound on channel {channel}.',
});

// The refusals that mean Moontide cannot check that a setting writes nothing to the memory of the instrument: they add the
// temporaryOnly line.
const GUARD_KEYS = new Set(['unguarded', 'memoryWrite', 'nrpnUnknown', 'nrpnNotListed']);

// One address range, first and last address included, as 7-bit bytes, with the step between two parts of a tone or part
// setting whose part 1 address lies in it (in address units, so base 128: 0 means no per-part setting may point there).
const range = (first, last, partStep) => Object.freeze({ first: Object.freeze(first), last: Object.freeze(last), partStep });

// The areas of an instrument that hold nothing for good, by the Roland model ID of its data sets, the number of bytes of
// its addresses (`addressSize`) and the step between two parts in each area (`partStep`).
//
// The JUPITER-X family (model ID 00 00 00 65, four-byte addresses): its temporary scene 01 00 xx xx, where part n is 128
// further per part (a step of 1 in the third byte), and the temporary tones of parts 1 to 4 of the engines its settings map
// lists (02 00 to 02 03, 02 10 to 02 13, 02 50 to 02 53, and 02 20 for the piano engine, which has part 1 only), 16384 further
// per part (a step of 1 in the second byte). The system block (00), the setup block (00 10), the user scenes and tones (40 to
// 69) and the editor block (7F) keep settings for good or switch the scene, so no data set goes there.
//
// The MT-32 (model ID 16, three-byte addresses): the timbre temporary area of the parts 04 00 00 to 04 0F 2F (246 bytes per
// part), the patch temporary area of the parts 03 00 00 to 03 00 7F (16 bytes per part), the patch area of the rhythm part
// and the rhythm setup 03 01 00 to 03 03 0F, the master tune and reverb of the system area 10 00 00 to 10 00 03 and its master
// volume 10 00 16, and the display 20 00 00 to 20 00 13 and 20 01 00. The rest of the system area, the partial reserve and the
// MIDI channel of each part (10 00 04 to 10 00 15), is left out: one message there could move the parts off the channels the
// setup file plays. No per-part setting may point at the rhythm, system or display areas (a step of 0). The patch memory (05), the
// timbre memory (08), the write request (40) and the timbre area reached through the basic channel (02) keep sounds or copy
// working memory into stored ones, so no data set goes there. `exact` lists the one message that passes outside the ranges
// when the reset of the instrument sends it, though it is not a setting and the code may never send it: the all-parameters
// reset at 7F 00 00 with the data 00, which the shipped MT-32 model sends when the instrument connects.
//
// `parts` is how many parts have an address at the tone and the part level. The guard is keyed on the message: every Roland
// system exclusive message with a model ID of this list is checked, on any port. An instrument whose model ID is not in this
// list gets none of its settings; other system exclusive messages are not Moontide's to check.
export const TEMPORARY_AREAS = Object.freeze([
  Object.freeze({
    model: Object.freeze([0x00, 0x00, 0x00, 0x65]),
    addressSize: 4,
    ranges: Object.freeze([
      range([0x01, 0x00, 0x00, 0x00], [0x01, 0x00, 0x7f, 0x7f], 128),
      range([0x02, 0x00, 0x00, 0x00], [0x02, 0x03, 0x7f, 0x7f], 16384),
      range([0x02, 0x10, 0x00, 0x00], [0x02, 0x13, 0x7f, 0x7f], 16384),
      range([0x02, 0x20, 0x00, 0x00], [0x02, 0x20, 0x7f, 0x7f], 16384),
      range([0x02, 0x50, 0x00, 0x00], [0x02, 0x53, 0x7f, 0x7f], 16384),
    ]),
    parts: Object.freeze({ tone: 4, part: 5 }),
    exact: Object.freeze([]),
  }),
  Object.freeze({
    model: Object.freeze([0x16]),
    addressSize: 3,
    ranges: Object.freeze([
      range([0x04, 0x00, 0x00], [0x04, 0x0f, 0x2f], 246),
      range([0x03, 0x00, 0x00], [0x03, 0x00, 0x7f], 16),
      range([0x03, 0x01, 0x00], [0x03, 0x03, 0x0f], 0),
      range([0x10, 0x00, 0x00], [0x10, 0x00, 0x03], 0),
      range([0x10, 0x00, 0x16], [0x10, 0x00, 0x16], 0),
      range([0x20, 0x00, 0x00], [0x20, 0x00, 0x13], 0),
      range([0x20, 0x01, 0x00], [0x20, 0x01, 0x00], 0),
    ]),
    parts: Object.freeze({ tone: 8, part: 8 }),
    exact: Object.freeze([Object.freeze({ address: Object.freeze([0x7f, 0x00, 0x00]), data: Object.freeze([0x00]) })]),
  }),
]);

// The longest buffer the memory guard reads from one send of the code (64 KiB, well above any system exclusive dump a
// device takes in one message). A longer one is refused before a byte is read.
export const MAX_GUARDED_BYTES = 65536;

// Why the memory guard refuses a message, by reason (the reason travels to the server, the text goes to the page log).
const GUARD_TEXT = Object.freeze({
  'not-bytes': 'it is not a list of bytes',
  'too-long': `it is longer than ${MAX_GUARDED_BYTES} bytes`,
  incomplete: 'it is not a complete message',
  'not-data-set': 'it is not a Roland data set (command 12) for this instrument',
  'unknown-areas': 'the temporary areas of this instrument are not known',
  checksum: 'the checksum does not match',
});

const refusal = (reason, text = GUARD_TEXT[reason]) => ({ reason, text });

// Device ID 17, the byte the settings map and the server's reset both use.
export const ROLAND_DEVICE = 0x10;

const DATA_SET = 0x12;

/** The hex text of bytes: upper-case, two digits each, joined by single spaces. */
const hexText = (bytes) => bytes.map((byte) => byte.toString(16).toUpperCase().padStart(2, '0')).join(' ');

const sameBytes = (a, b) => a.length === b.length && a.every((byte, index) => byte === b[index]);

/** The checksum that brings the sum of the address and data bytes to a multiple of 128 (0 stays 0). */
function checksumOf(bytes) {
  const sum = bytes.reduce((total, byte) => total + byte, 0);
  return (128 - (sum % 128)) % 128;
}

/** The temporary areas entry whose model ID equals the settings' `rolandModel` byte for byte, else null. */
export function guardOf(settings) {
  if (settings === null || settings === undefined || !Array.isArray(settings.rolandModel)) return null;
  return TEMPORARY_AREAS.find((area) => sameBytes(area.model, settings.rolandModel)) ?? null;
}

/**
 * The part a channel plays, as the instrument numbers its parts: 1 plus the place of the channel among the channels of
 * the model, ascending. A model with melodic channels 1 to 4 and a rhythm channel 10 gives channel 10 part 5.
 */
export function partOf(instrument, channel) {
  const channels = instrument.modelChannels.map((entry) => entry.channel).sort((a, b) => a - b);
  const index = channels.indexOf(channel);
  if (index < 0) throw new Error(`Moontide: channel ${channel} is not a channel of the model of "${instrument.id}".`);
  return index + 1;
}

/**
 * The byte Web MIDI sends for a value that is not an object: the number it converts to, truncated toward zero, modulo
 * 256 (NaN and the infinities give 0), so '240', 496 and -16 are all F0. Converting a primitive runs no code.
 */
function octetOf(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return ((Math.trunc(number) % 256) + 256) % 256;
}

const PRIMITIVE = new Set(['number', 'string', 'boolean', 'undefined']);

/**
 * The bytes a send of the code hands on, read once, exactly as Web MIDI turns them into bytes: { bytes }, or { problem }
 * with a reason and its text. A number is one byte; an array-like is read by its length, which must be a whole number
 * up to MAX_GUARDED_BYTES (checked before any element is read), and no element may be an object, a function, a symbol or
 * a big integer (converting an object could run the code's own functions). Never throws: a getter that throws is a
 * refusal too. The caller
 * hands on these bytes, not the original, so what was checked is what is sent.
 */
export function readSentBytes(data) {
  try {
    if (typeof data === 'number') return { bytes: [octetOf(data)] };
    if (data === null || typeof data !== 'object') return { problem: refusal('not-bytes') };
    const length = data.length;
    if (!Number.isInteger(length) || length < 0) return { problem: refusal('not-bytes') };
    if (length > MAX_GUARDED_BYTES) return { problem: refusal('too-long') };
    const bytes = [];
    for (let index = 0; index < length; index++) {
      const value = data[index];
      if (value !== null && !PRIMITIVE.has(typeof value)) return { problem: refusal('not-bytes') };
      bytes.push(octetOf(value));
    }
    return { bytes };
  } catch {
    return { problem: refusal('not-bytes') };
  }
}

/** An address of 7-bit bytes as one number (the base-128 carry the Roland addresses use). */
const addressNumber = (address) => address.reduce((total, byte) => total * 128 + byte, 0);

/** The `size` 7-bit bytes of an address number. */
const addressBytes = (number, size) => Array.from({ length: size }, (_, index) => Math.floor(number / 128 ** (size - 1 - index)) % 128);

/** The range of the guard that holds an address (as a number), or undefined. */
const rangeOf = (guard, first) => guard.ranges.find((candidate) => first >= addressNumber(candidate.first) && first <= addressNumber(candidate.last));

/**
 * Why one system exclusive message (F0 to F7) may not be sent with this guard, or null. It passes only as a complete
 * Roland data set for the guard's model (with the device ID `device`, any device ID when it is undefined) whose every
 * written address, from the start address to the one of its last data byte, lies inside one of the guard's temporary
 * ranges, with the matching checksum. With `allowExact`, a message that is one of the guard's exact messages (the reset, with
 * its address and data byte for byte) passes too, once its checksum is right.
 */
function dataSetProblem(guard, message, device, allowExact) {
  const head = [0xf0, 0x41, device ?? message[2], ...guard.model, DATA_SET];
  const addressEnd = head.length + guard.addressSize;
  // Room for at least one data byte, the checksum and the end byte.
  if (message.length < addressEnd + 3) return refusal('incomplete');
  for (let index = 1; index < message.length - 1; index++) if (message[index] > 0x7f) return refusal('incomplete');
  if (!head.every((byte, index) => message[index] === byte)) return refusal('not-data-set');
  const address = message.slice(head.length, addressEnd);
  const first = addressNumber(address);
  const last = first + (message.length - addressEnd - 2) - 1;
  const data = message.slice(addressEnd, -2);
  const exact = allowExact && guard.exact.some((candidate) => sameBytes(candidate.address, address) && sameBytes(candidate.data, data));
  if (exact) return checksumOf(message.slice(head.length, -2)) === message[message.length - 2] ? null : refusal('checksum');
  const inside = rangeOf(guard, first);
  if (inside === undefined) return refusal('outside', `address ${hexText(address)} is outside the temporary scene and tones`);
  if (last > addressNumber(inside.last)) {
    return refusal('outside', `the data from address ${hexText(address)} runs past the temporary scene and tones (to ${hexText(addressBytes(last, guard.addressSize))})`);
  }
  if (checksumOf(message.slice(head.length, -2)) !== message[message.length - 2]) return refusal('checksum');
  return null;
}

/** The guard of a system exclusive message: the TEMPORARY_AREAS entry of its Roland model ID (bytes 3 to 6), else null. */
function guardOfMessage(message) {
  if (message[1] !== 0x41 || message.length < 7) return null;
  return TEMPORARY_AREAS.find((area) => area.model.every((byte, index) => message[3 + index] === byte)) ?? null;
}

/**
 * Why a buffer of bytes (as readSentBytes gives them) may not be sent, on any port, or null. The guard is keyed on the
 * message itself: the whole buffer is read, and every system exclusive message in it (from F0 to the next status byte,
 * which must be F7 for a complete message) that is a Roland message with a model ID of TEMPORARY_AREAS must be a complete
 * data set into that model's temporary areas (dataSetProblem, any device ID). Every other message passes untouched: a
 * channel or real-time message, another maker's or another Roland model's system exclusive message (a GS message, for
 * one). The first problem is the answer, { reason, text }, and the whole buffer is refused. Only the reset of an
 * instrument passes `allowReset`, which lets the guard's exact messages through: the code's own messages never do, since
 * the MT-32 all-parameters reset puts the factory contents back.
 */
export function sysexProblem(bytes, { allowReset = false } = {}) {
  let index = bytes.indexOf(0xf0);
  while (index >= 0) {
    let end = index + 1;
    while (end < bytes.length && bytes[end] < 0x80) end++;
    const complete = end < bytes.length && bytes[end] === 0xf7;
    const message = bytes.slice(index, complete ? end + 1 : end);
    const guard = guardOfMessage(message);
    if (guard !== null) {
      if (!complete) return refusal('incomplete');
      const problem = dataSetProblem(guard, message, undefined, allowReset === true);
      if (problem !== null) return problem;
    }
    index = bytes.indexOf(0xf0, end);
  }
  return null;
}

/**
 * Why a message Moontide built for an instrument with this guard (a setting) may not be sent, as { reason, text }, or
 * null. Stricter than sysexProblem: every F0 in it must start a complete data set for exactly this guard's model and
 * device ID 17. Throws when there is no guard. The guard's exact messages (the reset) are not settings and do not pass here.
 */
export function ownMessageProblem(guard, bytes) {
  if (guard === null || guard === undefined) throw new Error('Moontide: the memory check needs the temporary areas of the instrument.');
  const message = Array.from(bytes);
  let index = message.indexOf(0xf0);
  while (index >= 0) {
    const end = message.indexOf(0xf7, index + 1);
    if (end < 0) return refusal('incomplete');
    const problem = dataSetProblem(guard, message.slice(index, end + 1), ROLAND_DEVICE, false);
    if (problem !== null) return problem;
    index = message.indexOf(0xf0, end + 1);
  }
  return null;
}

/** ownMessageProblem as a text, or null. Throws when there is no guard. */
export function memoryWriteProblem(guard, bytes) {
  return ownMessageProblem(guard, bytes)?.text ?? null;
}

// The NRPN families Moontide knows, by the name a model gives. `gs`: the eight part offsets of the Roland GS family
// (tone modify 1 to 8 of the SC-55 manual's NRPN list), as [MSB, LSB]. Data goes from 14 to 114 and 64 means no change; the
// values are offsets from the normal sound of the instrument, so the lowest value moves the sound down and closes nothing.
export const KNOWN_NRPNS = Object.freeze({
  gs: Object.freeze({
    min: 14,
    max: 114,
    pairs: Object.freeze([
      Object.freeze([0x01, 0x08]),
      Object.freeze([0x01, 0x09]),
      Object.freeze([0x01, 0x0a]),
      Object.freeze([0x01, 0x20]),
      Object.freeze([0x01, 0x21]),
      Object.freeze([0x01, 0x63]),
      Object.freeze([0x01, 0x64]),
      Object.freeze([0x01, 0x66]),
    ]),
  }),
});

// The control changes of one NRPN set, in the order the manual documents them: parameter MSB, parameter LSB, data entry, and
// the null pair (RPN 127 127) that closes the parameter. There is no control 38.
const NRPN_MSB = 99;
const NRPN_LSB = 98;
const DATA_ENTRY = 6;
const NRPN_NULL_MSB = 101;
const NRPN_NULL_LSB = 100;
const NRPN_SET_BYTES = 15;

const NRPN_TEXT = Object.freeze({
  family: 'the NRPN family of this instrument is not known',
  shape: 'it is not the five control changes of one NRPN set, on one channel, in the documented order',
  notListed: 'it is not a part offset of the NRPN family of this instrument',
  range: 'its value is outside the range of the NRPN family of this instrument',
  closed: 'the null that closes the NRPN is not 127',
  rhythm: 'it is an offset of a melodic part sent to a rhythm channel',
  scene: 'an NRPN reaches one channel, so it is not a scene setting',
});

const nrpnRefusal = (key) => refusal('nrpn', NRPN_TEXT[key]);

/**
 * The fifteen bytes of one NRPN set on a channel (1 to 16): control 99 the MSB, control 98 the LSB, control 6 the value, then
 * control 101 and control 100 at 127. Builds what it is given: whether the pair and the value are allowed is nrpnProblem's.
 */
export function nrpnSet(channel, msb, lsb, value) {
  if (!Number.isInteger(channel) || channel < 1 || channel > 16) throw new Error(`Moontide: channel ${channel} is not a MIDI channel (1 to 16).`);
  const status = 0xb0 | (channel - 1);
  return [status, NRPN_MSB, msb, status, NRPN_LSB, lsb, status, DATA_ENTRY, value, status, NRPN_NULL_MSB, 0x7f, status, NRPN_NULL_LSB, 0x7f];
}

/**
 * Why a buffer may not be sent as the NRPN set of a part offset, as { reason, text }, or null. It must be exactly five control
 * changes on `channel` in the documented order, for a family Moontide knows, a pair that family lists and a value inside the
 * family's range, with both nulls at 127. Every byte after a status byte must be a data byte.
 */
export function nrpnProblem(family, channel, bytes) {
  const known = typeof family === 'string' && Object.hasOwn(KNOWN_NRPNS, family) ? KNOWN_NRPNS[family] : null;
  if (known === null) return nrpnRefusal('family');
  if (!Array.isArray(bytes) || bytes.length !== NRPN_SET_BYTES || !Number.isInteger(channel) || channel < 1 || channel > 16) return nrpnRefusal('shape');
  const status = 0xb0 | (channel - 1);
  const controls = [NRPN_MSB, NRPN_LSB, DATA_ENTRY, NRPN_NULL_MSB, NRPN_NULL_LSB];
  for (let index = 0; index < controls.length; index++) {
    const [first, control, value] = bytes.slice(index * 3, index * 3 + 3);
    if (first !== status || control !== controls[index] || !Number.isInteger(value) || value < 0 || value > 0x7f) return nrpnRefusal('shape');
  }
  if (!known.pairs.some(([msb, lsb]) => msb === bytes[2] && lsb === bytes[5])) return nrpnRefusal('notListed');
  if (bytes[8] < known.min || bytes[8] > known.max) return nrpnRefusal('range');
  if (bytes[11] !== 0x7f || bytes[14] !== 0x7f) return nrpnRefusal('closed');
  return null;
}

/**
 * The refusal of an NRPN set the page is about to send for `instrument` (as the rig holds it now), or null: the checks of
 * nrpnProblem against the family of its model, on the channel of the set, and never on a rhythm channel of the model or at scene level.
 */
export function ownNrpnProblem(instrument, level, bytes) {
  if (level === 'scene') return nrpnRefusal('scene');
  const channel = Array.isArray(bytes) && bytes.length > 0 && (bytes[0] & 0xf0) === 0xb0 ? (bytes[0] & 0x0f) + 1 : undefined;
  const problem = nrpnProblem(instrument.settings?.nrpnFamily ?? null, channel, bytes);
  if (problem !== null) return problem;
  if (instrument.modelChannels.some((entry) => entry.channel === channel && entry.role === 'rhythm')) return nrpnRefusal('rhythm');
  return null;
}

/** The value cut into 4-bit pieces by the size of the row (1, 2 or 4 bytes), the biggest piece first. */
function dataOf(size, value) {
  if (size === 1) return [value];
  if (size === 2) return [(value >> 4) & 15, value & 15];
  return [(value >> 12) & 15, (value >> 8) & 15, (value >> 4) & 15, value & 15];
}

const LARGEST = Object.freeze({ 1: 127, 2: 255, 4: 65535 });

/**
 * The message of an NRPN row: { bytes } (the fifteen bytes of one set), or { problem } with a `key` of SETTINGS_COPY. Refused,
 * in this order: at scene level, for a family Moontide does not know, for a pair the family does not list, for a value outside the
 * family's range (a value past 127, which an NRPN cannot carry, among them), on a rhythm channel of the model. A value that is not
 * a whole number throws: the page check already holds it.
 */
function nrpnMessage({ nrpnFamily, level, message, channel, rhythm, value }) {
  if (level === 'scene') return { problem: { key: 'nrpnScene' } };
  const family = typeof nrpnFamily === 'string' && Object.hasOwn(KNOWN_NRPNS, nrpnFamily) ? KNOWN_NRPNS[nrpnFamily] : null;
  if (family === null) return { problem: { key: 'nrpnUnknown' } };
  if (!Number.isInteger(value)) throw new Error(`Moontide: the value ${value} does not fit an NRPN (0 to 127).`);
  if (!family.pairs.some(([msb, lsb]) => msb === message.msb && lsb === message.lsb)) {
    return { problem: { key: 'nrpnNotListed', pair: hexText([message.msb, message.lsb]), family: nrpnFamily } };
  }
  if (value < family.min || value > family.max) return { problem: { key: 'nrpnRange', family: nrpnFamily, min: family.min, max: family.max, value } };
  if (rhythm) return { problem: { key: 'nrpnRhythm' } };
  return { bytes: nrpnSet(channel, message.msb, message.lsb, value) };
}

/**
 * The message of one setting: { bytes } for the finished data set or NRPN set, or { problem } with a `key` of SETTINGS_COPY
 * (kindNotSent with its `kind` text, unguarded, partAddress, addressLength with its `length` and `size`, memoryWrite with its
 * `address`, and the NRPN keys). `part` is the part of the channel (ignored for a scene setting). A tone or part setting
 * adds the part step of the area its part 1 address lies in, once per part after the first (counted in base 128, and the
 * result must stay in that same area); a part past the guard's `parts` for the level, an area with no part step and a part
 * after the first with no area have no address (partAddress). A scene setting uses its address as written. An address whose
 * length is not the guard's `addressSize` is addressLength. A value outside the size's range, or an address of neither 3 nor 4
 * bytes, throws: the page check and the reading of the rig already hold both. An NRPN row needs `nrpnFamily` (the family the
 * model names, or null), `channel` and `rhythm` (whether that channel is a rhythm channel of the model); it needs no guard.
 */
export function settingMessage({ guard, level, message, part, value, nrpnFamily = null, channel = 1, rhythm = false }) {
  if (message.kind === 'nrpn') return nrpnMessage({ nrpnFamily, level, message, channel, rhythm, value });
  if (message.kind !== 'roland-dt1') return { problem: { key: 'kindNotSent', kind: 'a control change' } };
  if (guard === null || guard === undefined) return { problem: { key: 'unguarded' } };
  const largest = LARGEST[message.size];
  if (largest === undefined) throw new Error(`Moontide: a data set of ${message.size} bytes is not one of 1, 2 or 4.`);
  if (!Number.isInteger(value) || value < 0 || value > largest) {
    throw new Error(`Moontide: the value ${value} does not fit a data set of ${message.size} bytes (0 to ${largest}).`);
  }
  if (message.address.length !== 3 && message.address.length !== 4) throw new Error('Moontide: the address of a data set must be 3 or 4 bytes.');
  if (message.address.length !== guard.addressSize) {
    return { problem: { key: 'addressLength', length: message.address.length, size: guard.addressSize } };
  }
  let address = [...message.address];
  if (level !== 'scene') {
    const first = addressNumber(address);
    const inside = rangeOf(guard, first);
    // Only the parts the guard's instrument has an address for at this level, and only inside an area that has a part step.
    // An address in no area stays as written for part 1, so the memory check below names it; for a later part it has no address.
    if (inside === undefined) {
      if (part !== 1) return { problem: { key: 'partAddress' } };
    } else {
      if (part > guard.parts[level] || inside.partStep === 0) return { problem: { key: 'partAddress' } };
      const moved = first + inside.partStep * (part - 1);
      if (moved > addressNumber(inside.last)) return { problem: { key: 'partAddress' } };
      address = addressBytes(moved, guard.addressSize);
    }
  }
  const body = [...address, ...dataOf(message.size, value)];
  const bytes = [0xf0, 0x41, ROLAND_DEVICE, ...guard.model, DATA_SET, ...body, checksumOf(body), 0xf7];
  if (memoryWriteProblem(guard, bytes) !== null) return { problem: { key: 'memoryWrite', address: hexText(address) } };
  return { bytes };
}

/**
 * The row of a written name: { row }, or { problem } with the key engineRow. A tone name may have one row per engine, so the
 * row is the one that reaches the engine of the sound (`engine`, from the slot); a name with several rows and no engine to
 * choose by, or no row for that engine, is refused, never sent as the first row. A name the level lacks throws: the page check
 * already holds it.
 */
function rowOf(instrument, level, name, engine) {
  const rows = instrument.settings[level].filter((candidate) => candidate.name === name);
  if (rows.length === 0) throw new Error(`Moontide: "${name}" is not a ${level} setting of "${instrument.id}".`);
  if (level !== 'tone' || rows.length === 1) return { row: rows[0] };
  const row = typeof engine === 'string' ? rows.find((candidate) => candidate.engines !== undefined && candidate.engines.includes(engine)) : undefined;
  if (row === undefined) return { problem: { key: 'engineRow' } };
  return { row };
}

/**
 * The data sets of everything the code writes, built from the Maps checkSetup returned. `settings` (tone and part
 * settings per channel slot) and `scenes` (scene settings per instrument) give back `slots` keyed like `settings`,
 * { instrument, channel, part, toneBytes: [{ name, bytes }], partBytes: [{ name, bytes }] } in written order, and
 * `scenes` keyed by instrument id, { instrument, sceneBytes: [{ name, bytes }] }. `lines` is null, or the lines of the
 * first problem (slots in Map order, tone before part, then the scenes); on a problem `slots` and `scenes` are empty.
 */
export function buildSettings({ rig, settings, scenes }) {
  const slots = new Map();
  const sceneSlots = new Map();
  const refused = (lines) => ({ lines, slots: new Map(), scenes: new Map() });
  const instrumentOf = (id) => rig.instruments.find((candidate) => candidate.id === id);

  /** The lines of a problem of one setting. */
  const linesOf = (problem, values) => {
    const line = fill(SETTINGS_COPY[problem.key], { ...values, ...problem });
    return GUARD_KEYS.has(problem.key) ? [line, SETTINGS_COPY.temporaryOnly] : [line];
  };

  for (const [key, entry] of settings) {
    const instrument = instrumentOf(entry.instrument);
    const guard = guardOf(instrument.settings);
    const part = partOf(instrument, entry.channel);
    const rhythm = instrument.modelChannels.some((candidate) => candidate.channel === entry.channel && candidate.role === 'rhythm');
    const slot = { instrument: entry.instrument, channel: entry.channel, part, toneBytes: [], partBytes: [] };
    for (const level of ['tone', 'part']) {
      for (const [name, value] of entry[level]) {
        const { row, problem } = rowOf(instrument, level, name, entry.engine);
        const result = problem !== undefined ? { problem } : settingMessage({ guard, level, message: row.message, part, value, nrpnFamily: instrument.settings.nrpnFamily, channel: entry.channel, rhythm });
        if (result.problem !== undefined) return refused(linesOf(result.problem, { setting: name, level, id: instrument.id, part, channel: entry.channel }));
        slot[level === 'tone' ? 'toneBytes' : 'partBytes'].push({ name, bytes: result.bytes });
      }
    }
    slots.set(key, slot);
  }

  for (const [id, entry] of scenes) {
    const instrument = instrumentOf(entry.instrument);
    const guard = guardOf(instrument.settings);
    const sceneBytes = [];
    for (const [name, value] of entry.values) {
      const row = instrument.settings.scene.find((candidate) => candidate.name === name);
      const result = settingMessage({ guard, level: 'scene', message: row.message, part: 1, value, nrpnFamily: instrument.settings.nrpnFamily });
      if (result.problem !== undefined) return refused(linesOf(result.problem, { setting: name, level: 'scene', id: instrument.id, part: 1, channel: 1 }));
      sceneBytes.push({ name, bytes: result.bytes });
    }
    sceneSlots.set(id, { instrument: entry.instrument, sceneBytes });
  }
  return { lines: null, slots, scenes: sceneSlots };
}
