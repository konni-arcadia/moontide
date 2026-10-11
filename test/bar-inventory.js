// The top bar's contracts as data: the ids the bar shows and where each lives, the widths the
// bar is measured at, the names of the ten invariants, the controls that must be at least 24 px, and the longest
// real strings. A plain module, not a test file (no `.test.js` in its name), imported by test/bar-static.test.js
// and by both probes (scripts/probe-page.mjs, scripts/probe-midi.mjs). A change that moves, renames or removes an
// item edits its entry in the same change, so a failing contract names the broken item.
import { BUILD_MISMATCH_COPY, CONNECTION_LABELS } from '../page/ui-state.js';
import { PAGE_REQUESTS_COPY, waitingText } from '../page/ask.js';
import { timingOptions } from '../page/change-timing.js';

/** Every id the top bar shows or reaches, and its home: 'bar' is inside #top-bar, 'drawer' inside #session-drawer
 * (a card), 'strip' inside #session-strip. An item that moves needs its home edited here. */
const HOMES = {
  'product-name': 'bar',
  'connection-state': 'drawer',
  'build-mismatch': 'drawer',
  'sound-state': 'bar',
  'midi-takeover': 'drawer',
  'take-back': 'drawer',
  'version-indicator': 'drawer',
  'transport-button': 'bar',
  'tempo-readout': 'bar',
  'cycle-beat': 'bar',
  'pending-change': 'bar',
  'change-status': 'bar',
  // The key hint was replaced by real buttons: the Views and Layout groups (their buttons are made by page/main.js
  // with data-key), the flexible spacer between them, and the cycle and beat beside the tempo.
  'view-buttons': 'bar',
  'bar-spacer': 'bar',
  'layout-buttons': 'bar',
  'ask-status': 'bar',
  'midi-state': 'drawer',
  'midi-dots': 'drawer',
  'midi-state-text': 'drawer',
  'midi-info': 'drawer',
  'page-requests': 'drawer',
  'page-requests-state': 'drawer',
  'page-requests-info': 'drawer',
  'change-timing': 'drawer',
  'motion-switch': 'drawer',
  // The failed-change banner under the bar, the error line it holds and its alert region.
  'problem-banner': 'banner',
  'eval-error': 'banner',
  'problem-details-toggle': 'banner',
  'problem-copy': 'banner',
  'problem-ask': 'banner',
  'problem-dismiss': 'banner',
  'problem-copy-failure': 'banner',
  'problem-details': 'banner',
  'problem-alert': 'banner',
  // The right-click popover of the banner (it sits between the alert region and the strip).
  'problem-menu': 'banner',
  'problem-menu-copy': 'banner',
  'problem-menu-ask': 'banner',
  'problem-menu-dismiss': 'banner',
  // The Session button and its drawer and strip.
  'session-button': 'bar',
  'session-drawer': 'drawer',
  'session-strip': 'strip',
  'strip-text': 'strip',
  'strip-take-back': 'strip',
};

// Parts of an item that are classes, not ids: the transport button holds .transport-mark and .transport-word,
// the state holds .state-dot, .state-label and .state-here (the ' here' of a tab that lost the role), and the tempo
// readout holds .tempo-num, .tempo-arrow and .tempo-unit. Their ids' homes above cover them; the probes read them by class.

export const BAR_INVENTORY = Object.freeze(Object.entries(HOMES).map(([id, home]) => Object.freeze({ id, home })));

/** The widths of the bar sweep, in CSS px at device scale factor 1 (the root is 15 px up to 1923 px, then 0.78vw). */
export const BAR_WIDTHS = Object.freeze([1024, 1280, 1366, 1440, 1920, 2560, 3840]);

/** The ten invariants of the top bar, each checked by the static tests or by the probe. */
export const INVARIANTS = Object.freeze(['I1', 'I2', 'I3', 'I4', 'I5', 'I6', 'I7', 'I8', 'I9', 'I10']);

/** I10: the separator's three readings of the view's size agree. The value is the view panel's share of the
 * workspace's main axis; the probe compares `aria-valuenow`, the painted share (panel size over workspace size) and the stored
 * number under `moontide.split.a` / `moontide.split.b`, within 1 point, after a drag, a key, a reload and a layout switch. */
export const SPLIT_READINGS_TOLERANCE = 1;

/** Ids that carry the accent color without being the live state. Empty since Connected became plain text in the
 * Session card; I4 (the accent means live now) tolerates only the ids listed here. */
export const ACCENT_EXEMPT_TODAY = Object.freeze([]);

/** The sized controls (invariant I5), by family: `rule` is the exact CSS selector of the one shared rule that gives the
 * family `min-height` and `min-width` of at least 1.75rem (26.25 px at the 15 px root, above the 24 px floor), and `controls` are
 * the selectors the probes use to find each button in the page. test/bar-static.test.js finds each `rule` in page/style.css; the
 * probe measures every control with getBoundingClientRect and scans the page for a button that no `controls` selector matches.
 * A change that adds a button adds it to a family (or a family with its rule) in the same change. */
export const SIZED_FAMILIES = Object.freeze([
  { rule: '#transport-button', controls: ['#transport-button'] },
  { rule: '#view-buttons button', controls: ['1', '2', '3', '4', '5', '6'].map((key) => `#view-buttons button[data-key="${key}"]`) },
  { rule: '#layout-buttons button', controls: ['a', 'b', 'c'].map((key) => `#layout-buttons button[data-key="${key}"]`) },
  { rule: '#change-timing button', controls: ['now', 'bar', 'phrase'].map((value) => `#change-timing button[data-value="${value}"]`) },
  { rule: '#session-button', controls: ['#session-button'] },
  { rule: '#strip-take-back', controls: ['#strip-take-back'] },
  { rule: '#take-back', controls: ['#take-back'] },
  { rule: '#motion-switch', controls: ['#motion-switch'] },
  { rule: '#problem-banner button', controls: ['#problem-details-toggle', '#problem-copy', '#problem-ask', '#problem-dismiss'] },
  { rule: '#problem-menu button', controls: ['#problem-menu-copy', '#problem-menu-ask', '#problem-menu-dismiss'] },
  { rule: '#midi-banner-dismiss', controls: ['#midi-banner-dismiss'] },
  { rule: '#midi-info', controls: ['#midi-info'] },
  { rule: '#page-requests-info', controls: ['#page-requests-info'] },
]);

/** Selectors of the controls that must be at least 24x24 px: every control of every family. */
export const SIZED_CONTROLS = Object.freeze(SIZED_FAMILIES.flatMap((family) => family.controls));

/** The longest strings the real code can produce, for the width sweeps. The copy constants come from the page
 * modules, so a rename there fails loudly in test/bar-static.test.js. */
export const WORST_CASE = Object.freeze({
  tempo: '118.5 → 1000.5 BPM',
  pending: 'Change in 12 bars',
  version: 'v12345 · from v12344',
  askStatus: waitingText(12),
  connection: CONNECTION_LABELS.refused,
  build: BUILD_MISMATCH_COPY.line,
  takeover: 'Moontide is playing in another tab',
  pageRequests: PAGE_REQUESTS_COPY.waiting,
  midiAttention: 'MIDI: 2 of 6 instruments need attention',
  midiOff: 'MIDI: 12 instruments on, 4 off',
  // The control is three buttons now; the longest of them is the one measured (the group of three must stay whole in its card).
  editsTiming: timingOptions().find((option) => option.value === 'phrase').label,
  motion: 'Motion: off',
});

/** The screenshot matrix of the probe's shots lane (MOONTIDE_PROBE_SHOTS): the states, the window sizes (width, height)
 * and the layouts the user judges the built look in. The border exists only in layouts a and b, so the split state skips layout c.
 * Files are named `bar-{state}-{width}x{height}-layout-{layout}.png`; the names come only from these constants. */
export const SHOT_STATES = Object.freeze(['stopped', 'playing', 'waiting', 'failed', 'drawer', 'worst', 'worst-drawer', 'split']);
export const SHOT_SIZES = Object.freeze([
  Object.freeze([1024, 768]),
  Object.freeze([1366, 768]),
  Object.freeze([1920, 1080]),
  Object.freeze([3840, 2160]),
]);
export const SHOT_LAYOUTS = Object.freeze(['a', 'b', 'c']);
export const SHOT_SKIPPED = Object.freeze([{ state: 'split', layout: 'c' }]);

/** Every file name the matrix produces, in the order the probe writes them (layout, state, size). */
export function shotFileNames() {
  const names = [];
  for (const layout of SHOT_LAYOUTS) {
    for (const state of SHOT_STATES) {
      if (SHOT_SKIPPED.some((skip) => skip.state === state && skip.layout === layout)) continue;
      for (const [width, height] of SHOT_SIZES) names.push(`bar-${state}-${width}x${height}-layout-${layout}.png`);
    }
  }
  return names;
}
