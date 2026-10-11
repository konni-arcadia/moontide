// The load failure notice of Moontide's browser page: its exact copy and the pure decisions behind it.
// No DOM access at import time, so this module can be imported directly by node:test and by
// page/load-failure-view.js without a build step.

/** How long the report to the server may take before the notice says Claude was not told. */
export const LOAD_FAILURE_REPORT_MS = 5000;

function deepFreeze(value) {
  for (const inner of Object.values(value)) {
    if (inner !== null && typeof inner === 'object') deepFreeze(inner);
  }
  return Object.freeze(value);
}

export const LOAD_FAILURE_COPY = deepFreeze({
  blocked: {
    tabTitle: 'Moontide: Strudel did not load',
    heading: 'Moontide could not load Strudel.',
    whatStrudel: 'The Strudel script from unpkg.com did not load, so the editor and the sound cannot start.',
    whatBoth: 'The Strudel and acorn scripts from unpkg.com did not load, so the editor and the sound cannot start.',
    todo: 'Check your internet connection and that nothing blocks unpkg.com (an ad blocker, a firewall or a proxy), then reload this page.',
  },
  degraded: {
    lead: 'The acorn script did not load.',
    what: 'Sound still plays, but the views that read the code (Timeline, Mixer, Parts, Jam and Instruments) cannot work.',
    todo: 'Check your internet connection and that nothing blocks unpkg.com, then reload this page.',
  },
  addressPrefix: 'Failed: ',
  reload: { label: 'Reload page', title: 'Reload this page' },
  dismiss: { label: 'Dismiss notice', title: 'Dismiss notice' },
  claude: {
    sending: 'Telling Claude…',
    told: 'Claude will see this on its next action.',
    unreachable: 'The Moontide server could not be reached, so Claude was not told. Check that Moontide is running, then reload this page.',
    refused: 'Moontide answered but did not accept this report, so Claude was not told. This page is from an earlier start of Moontide: reload this page.',
  },
});

/**
 * Which notice the page needs, from the state that is settled once the head scripts have run. A Strudel script
 * that loaded without defining the editor element counts as not loaded.
 */
export function loadFailureMode({ strudelDefined, acornDefined }) {
  if (!strudelDefined) return acornDefined ? 'blocked-strudel' : 'blocked-both';
  return acornDefined ? 'none' : 'degraded-acorn';
}

/** The script names a mode reports to the server, Strudel first. */
export function failedScripts(mode) {
  if (mode === 'blocked-strudel') return ['strudel'];
  if (mode === 'blocked-both') return ['strudel', 'acorn'];
  if (mode === 'degraded-acorn') return ['acorn'];
  return [];
}

/**
 * Every text of the notice for a mode, as plain strings (the view writes them with textContent only).
 * `title` is the tab title, or null when the tab title stays as it is. `alert` is what the alert region announces.
 */
export function noticeTexts(mode, { strudelSrc, acornSrc }) {
  const addresses = failedScripts(mode).map(
    (name) => LOAD_FAILURE_COPY.addressPrefix + (name === 'strudel' ? strudelSrc : acornSrc),
  );
  if (mode === 'degraded-acorn') {
    const { lead, what, todo } = LOAD_FAILURE_COPY.degraded;
    return { title: null, heading: lead, what, todo, addresses, alert: [lead, what, todo].join(' ') };
  }
  const { tabTitle, heading, whatStrudel, whatBoth, todo } = LOAD_FAILURE_COPY.blocked;
  const what = mode === 'blocked-both' ? whatBoth : whatStrudel;
  return { title: tabTitle, heading, what, todo, addresses, alert: [heading, what, todo].join(' ') };
}

/**
 * The one-shot outcome of the report to the server. `answer(ok)` is the server's reply and `fail(reason)` is
 * anything else that ends the attempt (an error, a close, the timer, a missing token). `onSettle` is called at most
 * once: with 'told' for a reply of ok true, with 'refused' for a reply of ok false (the server answered and did not
 * keep the report, as when the page token is from an earlier start), and with 'unreachable' for everything else.
 */
export function createReportSettler(onSettle) {
  let settled = false;
  function settle(outcome) {
    if (settled) return;
    settled = true;
    onSettle(outcome);
  }
  return {
    answer(ok) {
      if (ok === true) settle('told');
      else if (ok === false) settle('refused');
      else settle('unreachable');
    },
    fail() {
      settle('unreachable');
    },
  };
}
