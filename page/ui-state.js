// Pure UI state helpers and the exact page copy for Moontide's browser page.
// No DOM access at import time, so this module can be imported directly by node:test
// and by page/main.js without a build step.

export const CONNECTION_LABELS = {
  connecting: 'Connecting…',
  connected: 'Connected',
  disconnected: 'Disconnected',
  refused: 'Refused — reload the page',
};

export const SOUND_LABELS = {
  off: 'Sound off',
  silent: 'Silent',
  playing: 'Playing',
  stopped: 'Stopped',
};

export const COPY = {
  name: 'Moontide',
  cta: 'Click to start sound',
  audioBlocked: "Couldn't start audio — click again.",
  // The first row of the Session card names this page's server: the key above its label.
  identityFolderKey: 'Folder and port',
  identityPortKey: 'Port',
};

// The top-bar line shown when the server says it is older than this page; it stays until the
// page reloads. The action comes first and the line is short so the top bar never cuts it; the title
// carries the full explanation. The probe imports it.
export const BUILD_MISMATCH_COPY = {
  line: 'Restart Claude: different builds',
  title: 'The server and the page come from different builds. Moontide was updated since this server started. Restart Claude (which runs the server), then reload this page.',
};

// The softer top-bar line for a server whose own code was updated since it started while the page
// it serves is still the one it started with. Nothing is refused for it, so the copy says so; it stays
// until the page reloads, and the stronger BUILD_MISMATCH_COPY line always wins. Action first and short,
// like the mismatch line; the title says nothing is refused. The probe imports it.
export const SERVER_UPDATED_COPY = {
  line: 'Restart Claude: Moontide was updated',
  title: "The server's own code was updated since it started. The page and the server still match, so nothing is refused meanwhile. Restart Claude (which runs the server) to use the update.",
};

/**
 * How long set_code's evaluated reply waits after a successful evaluate() before
 * sending, so a runtime error firing in the first cycle rides the same response. 250ms is
 * comfortably past the scheduler's synchronous first tick plus one more 100ms interval tick, well under the 2s budget.
 */
export const FIRST_CYCLE_WATCH_MS = 250;

// raw.githubusercontent.com sends an unquoted Content-Disposition filename, and
// Chrome refuses files whose VCSL folder name holds a comma. jsDelivr sends no such header.
// Pinned to one commit so the served bytes cannot change silently. Only VCSL moves. There is no fallback host.
export const VCSL_COMMIT = 'c1ea7bcc3c7309650ab0da9d15c9cd1fbc4a4c7e';
// The manifest that lists the VCSL sound names is pinned to one commit too, so the sound names the page
// registers cannot change silently when the repository moves on. `npm run check:reference` fails when
// the main branch no longer lists the same sounds: look up the new commit read-only
// (git ls-remote https://github.com/felixroos/dough-samples refs/heads/main), then change this constant.
export const VCSL_MANIFEST_COMMIT = '9eacfc86ec4393e68a463ff52b01c19cfaa77f38';
export const VCSL_MANIFEST_URL = 'https://raw.githubusercontent.com/felixroos/dough-samples/' + VCSL_MANIFEST_COMMIT + '/vcsl.json';
export const VCSL_SAMPLE_BASE = 'https://cdn.jsdelivr.net/gh/sgossner/VCSL@' + VCSL_COMMIT + '/';

/** What every sound-load failure text ends with; the reply adds the final period. */
const REPLACED_SOUND_DUTY = '; if you replace it, tell the user which one and what replaced it, never silently';

/** How many candidate sound names soundLoadFailureText lists before "and N more". */
export const MAX_NAMED_SOUNDS = 7;

/**
 * How long the page waits for AudioContext.resume() to reach 'running' after
 * a successful evaluate() that follows a stop, before giving up and showing the audio-unlock
 * overlay again. Kept small so FIRST_CYCLE_WATCH_MS + RESUME_AFTER_STOP_TIMEOUT_MS stays at
 * or below 1000ms, leaving at least 1s of the 2s set_code budget for evaluation and
 * the round trip.
 */
export const RESUME_AFTER_STOP_TIMEOUT_MS = 500;

/**
 * Maps AudioContext running state plus the Strudel scheduler's started flag to one of
 * the four sound-state slots. `stopped` wins over everything else: a stop
 * suspends the AudioContext, so without this rule the label would fall back to "Sound off"
 * instead of the dedicated "Stopped" value.
 */
export function soundState({ audioRunning, started, stopped }) {
  if (stopped) return 'stopped';
  if (!audioRunning) return 'off';
  return started ? 'playing' : 'silent';
}

/**
 * Maps a raw AudioContext.state string to what the page reports back to the server in
 * an 'evaluated' message.
 */
export function audioReport(contextState) {
  return contextState === 'running' ? 'playing' : 'waiting-for-click';
}

/**
 * Which history id the page has loaded, as "v{id}", or
 * hidden. Hidden while waiting for the audio-unlock click ("off") or before anything has
 * played yet in this page ("silent", hasPlayed false) — no id is confirmed playing, so
 * there is nothing truthful to show. Visible with unchanged text while stopped, and once a
 * version has played once in this page it stays visible for the rest of the page session
 * (never reverts to hidden), including back in "off"/"silent" after a reconnect. The one
 * addition to the plain state table: a null/undefined versionId (the loaded code could not
 * be saved to history) always hides it, so it never shows a wrong or stale number.
 * A restored version reads "v{id} · from v{N}" when `restoredFrom` is a positive
 * integer. The "from" arrives in the same server message as the id, so it is never a wrong or
 * stale source; the hidden rules are the same as for the plain "v{id}".
 */
export function versionIndicator({ versionId, soundState, hasPlayed, restoredFrom }) {
  if (versionId === null || versionId === undefined) {
    return { hidden: true, text: '' };
  }
  if (soundState === 'playing' || soundState === 'stopped' || hasPlayed) {
    const from = Number.isInteger(restoredFrom) && restoredFrom > 0 ? ` · from v${restoredFrom}` : '';
    return { hidden: false, text: `v${versionId}${from}` };
  }
  return { hidden: true, text: '' };
}

// The only real hook for errors raised while a pattern plays — @strudel/core's logger() dispatches a
// document-level 'strudel.log' event for every log call, error or not; only these prefixes are
// genuine runtime errors from the audio engine. Moved here from page/main.js so
// runtimeErrorFromLog can share it with the voicing case below. The pinned bundle's
// queryArc logs `[query] error:` for a pattern that fails when queried (it plays nothing at that
// point); that used to be dropped, which is how Claude heard "ok, playing" over silence.
const RUNTIME_ERROR_RE = /^\[(cyclist|getTrigger|query)\] error: ([\s\S]*)$/;

/**
 * The start of the text forwarded to Claude for a query error, so Claude can tell it from a
 * cyclist error (it says the pattern plays nothing while this lasts, like the unknown-chord line).
 */
export const QUERY_ERROR_LEAD = 'the pattern fails when queried, so it plays nothing while this lasts: ';

/** True when `text` is a forwarded query error (it starts with QUERY_ERROR_LEAD). */
export function isQueryErrorText(text) {
  return typeof text === 'string' && text.startsWith(QUERY_ERROR_LEAD);
}

/**
 * Remembers which texts were already seen for the change that is playing. first(text)
 * is true only the first time each text is seen until reset(); the page resets it when a new
 * pattern takes over in the scheduler. Strudel's own log debounce (1 s per identical text) is not a once-per-change
 * guard: a persistent query error logs about once a second.
 */
export function createOncePerChange() {
  const seen = new Set();
  return {
    first(text) {
      if (seen.has(text)) return false;
      seen.add(text);
      return true;
    },
    reset() {
      seen.clear();
    },
  };
}

// The pinned bundle's voicing catch branch logs exactly `[voicing]: unknown chord
// "${d}"` (theory.md's own Voicings section, confirmed live) then plays silence — Claude
// otherwise hears "ok, playing" for a chord that makes no sound at all.
const UNKNOWN_CHORD_RE = /^\[voicing\]: unknown chord "([\s\S]*)"$/;

/**
 * The text to forward to Claude for one strudel.log message, or null to forward
 * nothing. A cyclist/getTrigger runtime error forwards its trimmed detail, unchanged from
 * before this function existed. A `[query] error:` log (the pattern fails when queried and
 * plays nothing) forwards QUERY_ERROR_LEAD plus its trimmed detail, never cut here (the server's
 * cleanErrorDetail is the only cut). An unknown-chord voicing log forwards a line naming the
 * chord and saying it plays nothing (previously dropped, so a silent chord looked
 * like "ok, playing"). Anything else — including a non-string or undefined message —
 * forwards nothing. The naming of a failed sound (isFetchFailure/
 * soundLoadFailureText below) happens in page/main.js, on top of the text this returns.
 */
export function runtimeErrorFromLog(message) {
  if (typeof message !== 'string') return null;
  const errorMatch = RUNTIME_ERROR_RE.exec(message);
  if (errorMatch) {
    const detail = errorMatch[2].trim();
    return errorMatch[1] === 'query' ? QUERY_ERROR_LEAD + detail : detail;
  }
  const chordMatch = UNKNOWN_CHORD_RE.exec(message);
  if (chordMatch) return `unknown chord "${chordMatch[1]}" in .voicing(): it plays nothing`;
  return null;
}

// Superdough logs `[sampler] load sound "<label>"..` synchronously the first time a
// sample URL is requested (once per URL, ever — Strudel caches the fetch promise forever), and
// `[sampler] load sound "<label>"... done! loaded ...` once it succeeds. A rejected fetch never
// logs again for that URL; every later trigger only produces a nameless
// "[getTrigger] error: Failed to fetch". These two patterns let createSoundLoadTracker below
// correlate a later nameless failure back to the sound that requested it.
const LOAD_SAMPLE_RE = /^\[sampler\] load sound "([\s\S]*)"\.\.$/;

/**
 * The sound name from a `[sampler] load sound "<label>"..` line, or null for
 * anything else (including the "... done!" success line, an unnamed "[sampler] load
 * sample.." line, or a non-string message). The label is `${name}:${index}` followed by
 * loadBuffer's own `:<slot>`, so every trailing `:<digits>` segment is stripped.
 */
export function sampleLoadName(message) {
  if (typeof message !== 'string') return null;
  const match = LOAD_SAMPLE_RE.exec(message);
  if (!match) return null;
  return match[1].replace(/(:\d+)+$/, '');
}

// Network-failure texts by browser (Chrome/Edge, Safari, Firefox) — a start anchor,
// not whole-text equality, since a browser may append detail after the phrase.
const FETCH_FAILURE_PREFIXES = ['Failed to fetch', 'Load failed', 'NetworkError when attempting to fetch resource'];

/** True when `text` is a fetch-failure message from any of the three browsers above. */
export function isFetchFailure(text) {
  if (typeof text !== 'string') return false;
  return FETCH_FAILURE_PREFIXES.some((prefix) => text.startsWith(prefix));
}

/**
 * The page names a sound only when it is the single candidate — a wrong name misled
 * Claude in an earlier user test. With several it lists them, sorted and de-duplicated so the text is
 * stable for any arrival order, capped at MAX_NAMED_SOUNDS so the server's 500 code point
 * cleanErrorDetail cap never cuts a name in half. With none, it says the page could not tell. Every variant ends
 * with the duty to say which sound was replaced and by what: it lives here, where Claude reads about the failure,
 * and not in the server instructions, which have a fixed length.
 */
export function soundLoadFailureText(detail, names) {
  const distinct = [...new Set(names)].sort();
  if (distinct.length === 1) {
    return `sound "${distinct[0]}" failed to load (${detail}); it plays nothing until the page is reloaded${REPLACED_SOUND_DUTY}`;
  }
  if (distinct.length === 0) {
    return `a sound failed to load (${detail}), and the page could not tell which one${REPLACED_SOUND_DUTY}`;
  }
  const shown = distinct.slice(0, MAX_NAMED_SOUNDS);
  const rest = distinct.length - shown.length;
  const list = rest > 0 ? `${shown.join(', ')} and ${rest} more` : shown.join(', ');
  return `one of these sounds failed to load (${detail}): ${list}; the one that failed plays nothing until the page is reloaded${REPLACED_SOUND_DUTY}`;
}

/**
 * Builds a Map<url, name> from the log pairs above — observe() feeds it every
 * strudel.log detail, pendingNames() returns the distinct names still awaiting their
 * "loaded-sample" confirmation. A URL whose fetch failed is never forgotten (loadBuffer's own
 * cache is permanent too), so it stays a candidate for every later failure until the page
 * reloads.
 */
export function createSoundLoadTracker() {
  const nameByUrl = new Map();
  return {
    observe(detail) {
      if (detail === null || typeof detail !== 'object' || typeof detail.type !== 'string') return;
      const url = detail.data && typeof detail.data === 'object' ? detail.data.url : undefined;
      if (typeof url !== 'string') return;
      if (detail.type === 'load-sample') {
        const name = sampleLoadName(detail.message);
        if (name !== null) nameByUrl.set(url, name);
      } else if (detail.type === 'loaded-sample') {
        nameByUrl.delete(url);
      }
    },
    pendingNames() {
      return [...new Set(nameByUrl.values())].sort();
    },
  };
}

/**
 * Formats the top-bar error line: "Error: " plus the first non-empty, trimmed line of
 * the message, or "Error: unknown error" when there is no non-empty line.
 */
export function errorLineText(message) {
  const lines = String(message).split('\n');
  const firstNonEmpty = lines.map((line) => line.trim()).find((line) => line !== '');
  return `Error: ${firstNonEmpty || 'unknown error'}`;
}
