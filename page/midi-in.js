// Listening to the MIDI inputs the setup file names, for Moontide's browser page. It reads the notes a keyboard plays, places each one on the
// music's cycles by the packet's own time stamp (the rule of page/scratch-model.js: checkStamp, then cycleAtStamp) and hands it to the
// played-note buffer. Every cycle it uses comes from one cycle axis (page/played-buffer.js): the music's own cycle lines while the music
// plays, the scheduler's tempo while it is stopped, so the buffer keeps the last cycles either way. No DOM access and no browser global: the page gives it everything it needs, like page/midi-out.js, so node:test
// imports it directly. It never sends, never touches an output and stores nothing.
//
// The ports belong to Web MIDI, and Strudel's own enable already holds the one access: this module reads that access through
// `getAccess`, and when the user presses the button that offers it, asks for it through `enable`, the very enable the music's MIDI output uses, so
// the browser is asked once. It never asks on its own. webmidi.js owns the `onmidimessage` and `onstatechange` properties of every port and
// of the access, and keeps Strudel's port list up to date with them, so they are never assigned here; the standard event API listens beside
// them, and an added listener does not open a port, so the port is opened here too.

import { checkStamp, cycleAtStamp } from './scratch-model.js';
import { BUFFER_CYCLES, createCycleAxis, parseNoteMessage } from './played-buffer.js';

/** How often the listening tick reads the music's cycle lines while a port is listened to, in milliseconds. */
export const LISTEN_TICK_MS = 50;

/** The words of the setup file's state the page hands to `setInputs`. */
const SETUP_WORDS = ['absent', 'invalid', 'valid'];

/**
 * Builds the listener and returns `{ setInputs, refresh, allow, state, snapshot, live, clearBuffer }`.
 *
 * - `getAccess()` gives the MIDIAccess Strudel's enable created, or null while there is none.
 * - `accessState()` gives the access word of page/midi-out.js ('idle', 'pending', 'enabled', 'denied', 'unsupported' or 'failed'),
 *   `accessFailure()` the name of the failure when it is 'failed' (optional), and `enable()` the one shared enable that asks the browser; it
 *   never rejects. Only `allow()` calls it.
 * - `isVisible()` tells whether this tab is shown and `holdsMusic()` whether this tab is the one that holds the music (not another Moontide tab).
 *   Only a visible tab that holds the music listens, so two tabs never keep two buffers; a tab that does not listen removes every listener,
 *   ends every held note at that moment and stops the tick, and keeps its buffer, so Record that still works on what it holds.
 * - `readCycleLines()` gives the stamps of the two cycle lines around the music's now, `{ a: { c, t }, b: { c, t } }`, or null when the
 *   music's clock cannot give them (the music is stopped, or the clock is warming up). `readCps()` gives the scheduler's cycles per second,
 *   which it keeps while stopped, and `isPlaying()` whether the music plays. All three are read once per kept note, never for a message
 *   that is not a note, and go through the cycle axis.
 * - `perfNow()` is the page clock in milliseconds, the clock event time stamps are on.
 * - `setTimer(fn, ms)` and `clearTimer(handle)` run the listening tick; `buffer` is a played-note buffer (page/played-buffer.js).
 * - `onChange()` is called whenever the state changed; `onError(message)` is called once per kind of refusal and for a port that failed.
 *
 * `setInputs(ports, setup)` takes the exact port names the setup file names and the file's own word ('absent', 'invalid' or 'valid'; a file
 * that is not valid names no port). `refresh()` reads the access again and listens to what is named, and is safe at any time: the page calls
 * it when the access, the rig or the ports change, and the access's own statechange event calls it too, so a plug or an unplug is seen with no
 * reload. A listened port that is gone loses its listener, and every held note is ended at that moment (the buffer itself is kept).
 * `allow()` is the press of the Allow MIDI to listen button: it asks through `enable`, then reads the access again.
 *
 * `state()` gives `{ listen, ports, listened, notOpened, missing, unplugged, several, available, failure, heard, refused, count }`. `listen` is one of
 * 'absent' (no instruments.json), 'invalid' (the file has a problem), 'none' (a valid file with no input), 'needs-permission' (inputs named,
 * MIDI not asked yet), 'pending' (the browser's prompt is open), 'denied', 'unsupported', 'failed' (see `failure`), 'other-tab' (another
 * tab holds the music), 'hidden' (this tab is hidden: the page cannot tell a background tab from a window covered by another), 'not-opened'
 * (a named input is connected but refused to open, and no other is heard), 'ambiguous' (several
 * connected inputs carry exactly a named name, so none of them is listened to), 'unplugged' (a named input seen earlier in this page
 * session is gone), 'missing' (a named input was never seen, it may be misspelled) or 'listening' (at least one named input is heard; the
 * others are in `notOpened`, `missing` or `several`). `listened` holds the names heard (open or opening), `notOpened` those whose port
 * refused to open (asked again at each refresh), `missing` every named name not connected once, `unplugged` those of them seen earlier, `several`
 * those carried by several inputs, and `available` the names of the inputs connected now. `heard` is `{ pitch, velocity, cycle, source }`
 * for the last note-on or null, `source` being 'music' (the music's own cycle lines) or 'free' (the tempo, with the music stopped);
 * `refused` is the reason word of the last note-on that was not kept (a note-off is never refused: see offNow) ('zero', 'not-a-number', 'ahead', 'stale', 'clock' when there are no
 * cycle lines and no tempo above 0, or 'full', the buffer's cap) until the next note is kept. `count` is the notes the buffer holds at the
 * latest cycle. `snapshot()` reads the axis cycle at the present moment and gives the buffer's snapshot at that cycle
 * (page/played-buffer.js), or null when there are no cycle lines and no tempo above 0.
 *
 * `live()` is what the Scratchpad's live view reads on every animation frame: `{ now, revision }`, the axis cycle now and a whole number that
 * grows whenever the buffer's snapshot would read differently apart from time passing: a note is kept, a held note ends, notes leave the
 * window, held notes are closed, the buffer is emptied, or the window starts at a new whole cycle (which changes the cut of a note that
 * reaches into it). It is null when there are no cycle lines and no tempo above 0. `clearBuffer()` empties the buffer, the count and the last
 * heard note, as the press of Record that does once it has taken the notes, and tells the page; a key still held loses its held mark and its
 * later note-off keeps nothing.
 */
export function createMidiIn({
  getAccess,
  accessState,
  accessFailure = () => null,
  enable,
  isVisible,
  holdsMusic,
  readCycleLines,
  readCps,
  isPlaying,
  perfNow,
  setTimer,
  clearTimer,
  buffer,
  onChange = () => {},
  onError = () => {},
}) {
  for (const [name, value] of Object.entries({ getAccess, accessState, accessFailure, enable, isVisible, holdsMusic, readCycleLines, readCps, isPlaying, perfNow, setTimer, clearTimer })) {
    if (typeof value !== 'function') throw new TypeError(`Moontide: the MIDI input listener needs ${name}, a function.`);
  }
  if (buffer === null || typeof buffer !== 'object') throw new TypeError('Moontide: the MIDI input listener needs a played-note buffer.');

  let ports = [];
  let setup = 'absent';
  // The native ports that carry the handler now, by name, and the ports whose open() was asked for (once each).
  const listened = new Map();
  const opening = new WeakSet();
  // The listened names whose open() was refused: they carry the handler but cannot be heard, so they do not count as listening.
  const notOpened = new Set();
  // The access objects that carry the statechange listener (one each), and the names seen connected at any time in this page session.
  const watched = new WeakSet();
  const seen = new Set();
  let missing = [];
  let unplugged = [];
  let several = [];
  let available = [];
  let hasAccess = false;
  let heard = null;
  let refused = null;
  let timer = null;
  let lastCount = 0;
  // Grows whenever the buffer reads differently (see `live`), and the first cycle of the window the last live read saw.
  let revision = 0;
  let lastWindow = null;
  // The latest cycle the axis gave, to end held notes when the axis cannot be read any more.
  let lastCycle = null;
  const axis = createCycleAxis();
  const reported = new Set();

  const reportOnce = (key, message) => {
    if (reported.has(key)) return;
    reported.add(key);
    onError(message);
  };

  function refuse(reason, message) {
    refused = reason;
    reportOnce(reason, message);
  }

  // The axis cycle at the moment `h`, with the anchors it was placed on, or null when there are no cycle lines and no tempo above 0.
  const readAxis = (h) => {
    const placed = axis.at(h, { music: readCycleLines(), cps: readCps(), playing: isPlaying() });
    if (placed !== null) lastCycle = placed.now;
    return placed;
  };

  // A note-off is never thrown away: one whose stamp is refused or that the axis cannot place still ends its held note, at the present
  // cycle (or the last cycle the axis gave), so a late off does not leave a key held to the end of the window. It is not a refusal.
  function offNow(h, pitch) {
    const placed = readAxis(h);
    const at = placed === null ? lastCycle : placed.now;
    if (at !== null) endHeld(at, pitch);
    lastCount = buffer.count();
  }

  // Ends the held note of a pitch, and moves the revision on only when there was one.
  function endHeld(cycle, pitch) {
    if (buffer.notes().some((note) => note.pitch === pitch && note.end === null)) revision += 1;
    buffer.noteOff(cycle, pitch);
  }

  function onMessage(event) {
    // The handler's own clock first, then the bytes: a message that is not a note (clock, active sensing, a controller) ends here, before
    // any cycle line is read.
    const h = perfNow();
    const note = parseNoteMessage(event.data);
    if (note === null) return;
    // The packet's own stamp decides where the note lands, never the time this code runs.
    const ts = event.timeStamp;
    const reason = checkStamp(ts, h);
    if (reason !== null) {
      if (note.kind === 'off') offNow(h, note.pitch);
      else refuse(reason, `Moontide: a note from a MIDI input was not kept, its time stamp was refused (${reason}).`);
      onChange();
      return;
    }
    const placed = readAxis(h);
    if (placed === null) {
      if (note.kind === 'off') offNow(h, note.pitch);
      else refuse('clock', 'Moontide: a note from a MIDI input was not kept, the music gives no cycle and the tempo is not above 0.');
      onChange();
      return;
    }
    const cycle = cycleAtStamp(ts, placed.anchors.a, placed.anchors.b);
    // A full buffer keeps saying so until a note is kept again; a note-off does not wipe the sentence.
    if (note.kind === 'on' || refused !== 'full') refused = null;
    if (note.kind === 'on') {
      const result = buffer.noteOn(cycle, note.pitch, note.velocity, placed.source === 'music' ? placed.offset : null);
      if (result.kept === false) {
        refuse('full', 'Moontide: the keyboard buffer is full (2000 notes), so the newest notes were not kept.');
      } else {
        heard = { pitch: note.pitch, velocity: note.velocity, cycle, source: placed.source };
        revision += 1;
      }
    } else {
      endHeld(cycle, note.pitch);
    }
    lastCount = buffer.count();
    onChange();
  }

  // Ends every held note at this moment. The buffer keeps its notes: only the ones still held get an end, so a key held down when the cable
  // goes does not stay held for ever.
  function closeHeld() {
    if (!buffer.notes().some((note) => note.end === null)) return;
    const placed = readAxis(perfNow());
    const at = placed === null ? lastCycle : placed.now;
    if (at !== null) {
      buffer.closeAll(at);
      revision += 1;
    }
    lastCount = buffer.count();
  }

  // Takes the handler off a port; true when the port carried it. The port is only unlistened, never closed: Strudel may use it.
  function detach(name) {
    const native = listened.get(name);
    listened.delete(name);
    notOpened.delete(name);
    if (native === undefined) return false;
    native.removeEventListener('midimessage', onMessage);
    return true;
  }

  function attach(name, native) {
    if (listened.get(name) === native) {
      // A port whose open() failed is asked again at each refresh (a plug, a rig change, the tab shown again).
      if (!opening.has(native)) startOpen(name, native);
      return false;
    }
    const replaced = detach(name);
    native.addEventListener('midimessage', onMessage);
    listened.set(name, native);
    if (!opening.has(native)) startOpen(name, native);
    return replaced;
  }

  // Opens a listened port. A refusal (another program may hold the input) is not listening: the name goes to `notOpened` until a later
  // open succeeds, and the console says it once per name.
  function startOpen(name, native) {
    opening.add(native);
    notOpened.delete(name);
    Promise.resolve(native.open()).catch((err) => {
      opening.delete(native);
      if (listened.get(name) !== native) return;
      notOpened.add(name);
      reportOnce(`open:${name}`, `Moontide: the MIDI input "${name}" could not be opened: ${err instanceof Error ? err.message : String(err)}`);
      onChange();
    });
  }

  function snapshot() {
    const placed = readAxis(perfNow());
    return placed === null ? null : buffer.snapshot(placed.now);
  }

  // The axis cycle now and the revision, for the live view's frame. A new first cycle of the window moves the revision on, because the
  // window cuts the notes that reach into it.
  function live() {
    const placed = readAxis(perfNow());
    if (placed === null) return null;
    const window = Math.floor(placed.now) + 1 - BUFFER_CYCLES;
    if (lastWindow !== null && window !== lastWindow) revision += 1;
    lastWindow = window;
    return { now: placed.now, revision };
  }

  // Empties the buffer after Record that took what it held. The heard note and the count go with it, so the strip does not speak of notes
  // that are gone.
  function clearBuffer() {
    buffer.clear();
    heard = null;
    lastCount = 0;
    revision += 1;
    onChange();
  }

  // The tick runs whenever a port is listened to, with the music playing or not. It reads the axis, which keeps the page clock warm on a page
  // with no MIDI track (without it the first notes would meet a cold clock) and lets a Stop or a Play be seen within one tick, and tells
  // the page when the count of kept notes changed.
  function tick() {
    timer = null;
    if (listened.size === 0) return;
    const placed = readAxis(perfNow());
    // The count is taken at the present cycle, so notes that left the window are gone from it.
    const count = placed === null ? buffer.count() : buffer.count(placed.now);
    if (count !== lastCount) {
      lastCount = count;
      revision += 1;
      onChange();
    }
    timer = setTimer(tick, LISTEN_TICK_MS);
  }

  function syncTick() {
    if (listened.size > 0 && timer === null) timer = setTimer(tick, LISTEN_TICK_MS);
    if (listened.size === 0 && timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  }

  // One listener on the access, by the standard event API: webmidi.js keeps the access's own handler property. Chrome fires several events for
  // one plug; refresh is idempotent, so the extra ones change nothing.
  function watch(access) {
    if (watched.has(access) || typeof access.addEventListener !== 'function') return;
    watched.add(access);
    access.addEventListener('statechange', refresh);
  }

  function refresh() {
    const access = getAccess();
    hasAccess = access !== null && access !== undefined && typeof access === 'object' && access.inputs !== undefined && access.inputs !== null;
    missing = [];
    unplugged = [];
    several = [];
    available = [];
    let lost = false;
    const drop = (name) => {
      if (detach(name)) lost = true;
    };
    if (hasAccess) watch(access);
    if (!hasAccess || ports.length === 0) {
      for (const name of [...listened.keys()]) drop(name);
    } else {
      const connected = [...access.inputs.values()].filter((input) => input !== null && typeof input === 'object' && input.state === 'connected');
      available = connected.map((input) => String(input.name));
      for (const name of available) seen.add(name);
      for (const name of [...listened.keys()]) if (!ports.includes(name)) drop(name);
      const away = !holdsMusic() || !isVisible();
      // A tab that is hidden or has lost the music listens to nothing, so no note is kept twice.
      if (away) for (const name of [...listened.keys()]) drop(name);
      const toMatch = away ? [] : ports;
      for (const name of toMatch) {
        // A name is matched exactly and in full, never by a part of it.
        const matches = connected.filter((input) => input.name === name);
        if (matches.length === 1) {
          if (attach(name, matches[0])) lost = true;
        } else {
          drop(name);
          missing.push(name);
          if (matches.length === 0) {
            if (seen.has(name)) unplugged.push(name);
          } else {
            several.push(name);
            reportOnce(`several:${name}`, `Moontide: several MIDI inputs are named exactly "${name}", so none is listened to.`);
          }
        }
      }
    }
    if (lost) closeHeld();
    syncTick();
    onChange();
  }

  function setInputs(names, setupWord) {
    if (!Array.isArray(names) || names.some((name) => typeof name !== 'string')) throw new TypeError('Moontide: the MIDI inputs must be a list of port names.');
    if (!SETUP_WORDS.includes(setupWord)) throw new TypeError(`Moontide: the setup file's state must be one of ${SETUP_WORDS.join(', ')}, got ${JSON.stringify(setupWord)}.`);
    const next = setupWord === 'valid' ? [...names] : [];
    const changed = setupWord !== setup || next.length !== ports.length || next.some((name, index) => name !== ports[index]);
    setup = setupWord;
    ports = next;
    // A rig change ends the held notes at that moment, whatever port they came from.
    if (changed) closeHeld();
  }

  async function allow() {
    try {
      await enable();
    } catch (err) {
      onError(`Moontide: the MIDI permission could not be asked for: ${err instanceof Error ? err.message : String(err)}`);
    }
    refresh();
  }

  // The listened names whose port is open or still opening: the ones a note can come from.
  const heardNames = () => [...listened.keys()].filter((name) => !notOpened.has(name));

  function listenWord() {
    if (setup === 'absent') return 'absent';
    if (setup === 'invalid') return 'invalid';
    if (ports.length === 0) return 'none';
    const access = accessState();
    if (access === 'idle') return 'needs-permission';
    if (access !== 'enabled') return access;
    // The access is said to be on but the page cannot read it: that is a failure to start, not a wait.
    if (!hasAccess) return 'failed';
    if (!holdsMusic()) return 'other-tab';
    if (!isVisible()) return 'hidden';
    if (heardNames().length > 0) return 'listening';
    if (notOpened.size > 0) return 'not-opened';
    if (several.length > 0) return 'ambiguous';
    if (unplugged.length > 0) return 'unplugged';
    return 'missing';
  }

  function state() {
    const listen = listenWord();
    let failure = null;
    if (listen === 'failed') failure = accessState() === 'failed' ? accessFailure() ?? 'Error' : 'NoAccess';
    return {
      listen,
      ports: [...ports],
      listened: heardNames(),
      notOpened: [...listened.keys()].filter((name) => notOpened.has(name)),
      missing: [...missing],
      unplugged: [...unplugged],
      several: [...several],
      available: [...available],
      failure,
      heard: heard === null ? null : { ...heard },
      refused,
      count: buffer.count(),
    };
  }

  return { setInputs, refresh, allow, state, snapshot, live, clearBuffer };
}
