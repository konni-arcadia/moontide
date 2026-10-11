// The MIDI state machine on the server. The page sends the MIDI facts it sees
// (the access state, which ports the playing code names, which outputs are connected, whether the
// tab is hidden) and this module words them once per change: a problem is queued as one line the
// first time it appears, never again while it lasts, and a problem that goes away and comes back is
// told again. The queue is drained into the next tool reply by the session, like the runtime
// errors and the page requests.
//
// Everything Claude reads from here is a fact, never a style or behavior instruction. Names that
// come from the page (devices, code) are cleaned and quoted before they are written into a line.

import type { MidiEvent, MidiFacts } from './protocol.js';

/** At most this many lines wait in the queue; the rest are counted and said in one line. */
export const MAX_MIDI_NOTICES = 20;
/** A port name in a line is cut at this many code points. */
export const MAX_MIDI_NOTICE_NAME = 80;
/** A list of names in a line shows this many, then "and N more". */
export const MAX_MIDI_NOTICE_LIST = 8;

/**
 * The reply text of a request that timed out while the page waits for the user to answer the
 * browser's MIDI permission prompt: the page is not broken, it is waiting.
 */
export const MIDI_PERMISSION_WAIT_MESSAGE =
  "The page is waiting for the user to answer the browser's MIDI permission prompt.";

export const MIDI_DENIED_LINE =
  "MIDI: the browser's MIDI permission was denied, so tracks using .midi() are silent. " +
  "The user can allow it again in the browser's site settings. Other tracks keep playing.";
export const MIDI_UNSUPPORTED_LINE =
  'MIDI: this browser has no Web MIDI, so tracks using .midi() are silent. The user needs Chrome or Edge. Other tracks keep playing.';
export const MIDI_NO_OUTPUTS_LINE =
  'MIDI: no MIDI outputs are connected, so tracks using .midi() are silent. Other tracks keep playing.';
export const MIDI_UNREADABLE_LINE =
  'MIDI: a .midi() port in the code is not a single-quoted name, so the page cannot check it; ' +
  'Stop silences every connected output.';
export const MIDI_CLOCK_DROPPED_LINE =
  'MIDI: the code wrote MIDI clock or transport (a midicmd of clock, start, stop or continue); ' +
  'Moontide sends these itself, so those bytes were dropped.';
export const MIDI_HIDDEN_LINE = 'MIDI timing may break until the tab is in front.';
export const MIDI_VISIBLE_LINE = 'The Moontide tab is in front again.';

/** Removes control characters and line breaks, trims, and cuts at MAX_MIDI_NOTICE_NAME code points. */
export function cleanMidiName(name: string): string {
  // U+0000-U+001F, U+007F-U+009F (C0, DEL, C1), U+2028 and U+2029 (line and paragraph separators).
  const plain = name.replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g, '').trim();
  const points = Array.from(plain);
  return points.length > MAX_MIDI_NOTICE_NAME ? `${points.slice(0, MAX_MIDI_NOTICE_NAME).join('')}…` : plain;
}

/** A page-supplied name as it is written in a line: cleaned, then escaped by JSON.stringify. */
export function quoteMidiName(name: string): string {
  return JSON.stringify(cleanMidiName(name));
}

/** Quoted names joined by ', ' (the first MAX_MIDI_NOTICE_LIST, then "and N more"), or "none". */
export function midiNameList(names: string[]): string {
  if (names.length === 0) return 'none';
  const shown = names.slice(0, MAX_MIDI_NOTICE_LIST).map(quoteMidiName).join(', ');
  const rest = names.length - MAX_MIDI_NOTICE_LIST;
  return rest > 0 ? `${shown}, and ${rest} more` : shown;
}

/** The line for a port the playing code names that no connected output contains. */
export function midiPortNotFoundLine(port: string, outputs: string[]): string {
  return (
    `MIDI: port ${quoteMidiName(port)} was not found. Connected outputs: ${midiNameList(outputs)}. ` +
    'The music keeps playing; notes for this port are not sent until it appears.'
  );
}

/** The line for a port that was connected and is not any more. */
export function midiPortUnpluggedLine(port: string, outputs: string[]): string {
  return (
    `MIDI: port ${quoteMidiName(port)} is unplugged. Connected outputs: ${midiNameList(outputs)}. ` +
    'It plays again by itself when it is back.'
  );
}

/** The line for a port name that is a substring of several connected outputs (Strudel sends to the first). */
export function midiPortAmbiguousLine(port: string, matches: string[]): string {
  return (
    `MIDI: port name ${quoteMidiName(port)} matches several outputs: ${midiNameList(matches)}. ` +
    `Strudel sends to the first one, ${quoteMidiName(matches[0] ?? '')}.`
  );
}

/** The line for a .midi() call with no port: the output Strudel uses. */
export function midiNoPortLine(using: string): string {
  return `MIDI: a .midi() call names no port, so Strudel uses the output ${quoteMidiName(using)}.`;
}

/** The line for a port that was unplugged and is connected again. */
export function midiPortBackLine(port: string): string {
  return `MIDI: port ${quoteMidiName(port)} is connected again. Playing resumed.`;
}

/** The line for a port that was not found or ambiguous and is connected now. */
export function midiPortConnectedLine(port: string): string {
  return `MIDI: port ${quoteMidiName(port)} is connected now.`;
}

// With a setup file the port lines name the instrument first. The port in them is the one the
// file gives, quoted like every page-supplied name.

/** The line for an instrument whose port was connected and is not any more. */
export function midiInstrumentUnpluggedLine(id: string, port: string, outputs: string[]): string {
  return (
    `MIDI: instrument ${quoteMidiName(id)} (port ${quoteMidiName(port)}) is unplugged. Connected outputs: ${midiNameList(outputs)}. ` +
    'It plays again by itself when it is back, and is reset to its known state.'
  );
}

/** The line for an instrument whose port no connected output contains. */
export function midiInstrumentNotFoundLine(id: string, port: string, outputs: string[]): string {
  return (
    `MIDI: instrument ${quoteMidiName(id)}: no output is named ${quoteMidiName(port)}. Connected outputs: ${midiNameList(outputs)}. ` +
    'The music keeps playing; notes for this instrument are not sent until it appears.'
  );
}

/** The line for an instrument whose port name is a substring of several connected outputs. */
export function midiInstrumentAmbiguousLine(id: string, port: string, matches: string[]): string {
  return (
    `MIDI: instrument ${quoteMidiName(id)}: port name ${quoteMidiName(port)} matches several outputs: ${midiNameList(matches)}. ` +
    `Strudel sends to the first one, ${quoteMidiName(matches[0] ?? '')}.`
  );
}

/** The line for an instrument that was unplugged and is connected again. */
export function midiInstrumentBackLine(id: string): string {
  return `MIDI: instrument ${quoteMidiName(id)} is connected again. Playing resumed.`;
}

/** The line for an instrument that was not found or ambiguous and is connected now. */
export function midiInstrumentConnectedLine(id: string): string {
  return `MIDI: instrument ${quoteMidiName(id)} is connected now.`;
}

/** The line for a Web MIDI start that failed for a reason other than a denied permission. */
export function midiFailedLine(failure: string | null): string {
  const reason = failure === null ? '' : ` (${quoteMidiName(failure)})`;
  return `MIDI: Web MIDI could not start${reason}, so tracks using .midi() are silent. Other tracks keep playing.`;
}

/**
 * The line of one event the page sent: a reset of an instrument, a sound change that may
 * cut a note, a sound kept after a failed evaluation, a send that failed, and clock or transport the
 * code wrote and the page dropped. Instrument ids, sound names and failure names come from the page and are
 * cleaned and quoted; the clock-dropped line is fixed text. Facts only, never an instruction.
 */
export function midiEventLine(event: MidiEvent): string {
  switch (event.kind) {
    case 'reset': {
      const id = quoteMidiName(event.instrument);
      return event.reason === 'start'
        ? `MIDI: instrument ${id} was reset to its known state when the page connected.`
        : `MIDI: instrument ${id} was reset to its known state after reconnecting.`;
    }
    case 'sound-cut': {
      const id = quoteMidiName(event.instrument);
      return `MIDI: changing the sound of ${id} channel ${event.channel} may cut a note that is still sounding.`;
    }
    case 'sound-kept': {
      const id = quoteMidiName(event.instrument);
      return (
        `MIDI: the evaluation failed after ${id} channel ${event.channel} changed to ${quoteMidiName(event.sound)}; ` +
        'it had no earlier sound to send back, so the channel keeps this sound until the next change.'
      );
    }
    case 'send-failed': {
      const id = quoteMidiName(event.instrument);
      const what = event.what === 'reset' ? 'the reset' : 'the sound setup';
      return `MIDI: ${what} could not be sent to instrument ${id} (${quoteMidiName(event.failure)}).`;
    }
    case 'clock-dropped':
      return MIDI_CLOCK_DROPPED_LINE;
  }
}

/** The line that says how many changes did not fit in the queue. */
export function midiOverflowLine(count: number): string {
  return count === 1 ? 'MIDI: 1 more change was not shown.' : `MIDI: ${count} more changes were not shown.`;
}

export class MidiChannel {
  private queue: string[] = [];
  // Changes that did not fit in the queue since the last drain.
  private overflow = 0;
  // The problems present in the last facts (by key).
  private keys = new Set<string>();
  // The keys whose line was queued; a key that is present and not in here still waits for its
  // line (a port line is held back while "no outputs" covers it).
  private told = new Set<string>();
  private last: MidiFacts | null = null;
  // The instruments of a valid setup file: exact port to instrument id. It comes from the file, not from
  // the page, so clear() keeps it.
  private instruments = new Map<string, string>();

  /** The instruments of the setup file (exact port to id; empty without a valid file). Port lines name them first. */
  setInstruments(instruments: Map<string, string>): void {
    this.instruments = new Map(instruments);
  }

  // The ports of instruments the user switched off. Like the instrument map it comes from the server's files, so clear() keeps it.
  private switchedOff = new Set<string>();

  /** The exact ports of the instruments the user switched off: their port notices are not news for Claude. */
  setSwitchedOff(ports: Set<string>): void {
    this.switchedOff = new Set(ports);
  }

  /** Takes the facts the active page just sent and queues one line per change. */
  update(facts: MidiFacts): void {
    const keys = new Set<string>();
    const told = new Set<string>();
    const add = (key: string, line: () => string, covered = false): void => {
      keys.add(key);
      if (covered) return;
      told.add(key);
      if (!this.told.has(key)) this.push(line());
    };

    // Code that neither plays nor tries .midi( gets no notice at all.
    if (facts.usesMidi || facts.triedMidi) {
      if (facts.access === 'denied') add('access:denied', () => MIDI_DENIED_LINE);
      else if (facts.access === 'unsupported') add('access:unsupported', () => MIDI_UNSUPPORTED_LINE);
      else if (facts.access === 'failed') {
        add(`access:failed:${facts.failure ?? ''}`, () => midiFailedLine(facts.failure));
      }

      if (facts.access === 'enabled') {
        const noOutputs = facts.outputs.length === 0;
        if (noOutputs) add('outputs:none', () => MIDI_NO_OUTPUTS_LINE);
        for (const port of facts.ports) {
          // The user switched this instrument off: its port state is not news for Claude. The key is not recorded,
          // so the line comes when it is switched on and the port is still missing.
          if (this.switchedOff.has(port.name)) continue;
          if (port.state === 'connected') {
            // The port was a problem and is fine now: say so once.
            for (const state of ['unplugged', 'not-found', 'ambiguous'] as const) {
              if (!this.keys.has(`port:${port.name}:${state}`)) continue;
              const id = this.instruments.get(port.name);
              if (id !== undefined) this.push(state === 'unplugged' ? midiInstrumentBackLine(id) : midiInstrumentConnectedLine(id));
              else this.push(state === 'unplugged' ? midiPortBackLine(port.name) : midiPortConnectedLine(port.name));
              break;
            }
            continue;
          }
          const id = this.instruments.get(port.name);
          const line =
            id !== undefined
              ? port.state === 'ambiguous'
                ? () => midiInstrumentAmbiguousLine(id, port.name, port.matches)
                : port.state === 'unplugged'
                  ? () => midiInstrumentUnpluggedLine(id, port.name, facts.outputs)
                  : () => midiInstrumentNotFoundLine(id, port.name, facts.outputs)
              : port.state === 'ambiguous'
                ? () => midiPortAmbiguousLine(port.name, port.matches)
                : port.state === 'unplugged'
                  ? () => midiPortUnpluggedLine(port.name, facts.outputs)
                  : () => midiPortNotFoundLine(port.name, facts.outputs);
          // With no output at all the "no outputs" line covers every port line.
          add(`port:${port.name}:${port.state}`, line, noOutputs);
        }
        const using = facts.noPort?.using ?? null;
        if (using !== null) add(`noport:${using}`, () => midiNoPortLine(using));
      }

      if (facts.usesMidi && facts.unreadable) add('unreadable', () => MIDI_UNREADABLE_LINE);
      if (facts.usesMidi && facts.hidden && facts.playing) add('hidden', () => MIDI_HIDDEN_LINE);
      if (facts.usesMidi && !facts.hidden && this.keys.has('hidden')) this.push(MIDI_VISIBLE_LINE);
    }

    // Events are not keyed: the page sends each one once, and each is said once, whatever the code uses.
    for (const event of facts.events) this.push(midiEventLine(event));

    this.keys = keys;
    this.told = told;
    this.last = facts;
  }

  private push(line: string): void {
    if (this.queue.length < MAX_MIDI_NOTICES) this.queue.push(line);
    else this.overflow++;
  }

  /** Takes the queued lines (once) and empties the queue. */
  drainLines(): string[] {
    const lines = this.queue;
    if (this.overflow > 0) lines.push(midiOverflowLine(this.overflow));
    this.queue = [];
    this.overflow = 0;
    return lines;
  }

  /** True while the page asks for MIDI access and the user has not answered yet. */
  isAwaitingPermission(): boolean {
    return this.last !== null && this.last.triedMidi && this.last.access === 'pending';
  }

  /** Forgets everything: the page that sent the facts is gone. */
  clear(): void {
    this.queue = [];
    this.overflow = 0;
    this.keys = new Set();
    this.told = new Set();
    this.last = null;
  }
}
