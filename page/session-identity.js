// The server writes the label of its session (the folder it runs in and its port) into the page it
// serves: a meta tag and a finished title. This module reads that label once at load and builds the
// tab title from it. The label is local data from the user's file system: it reaches the page only
// through textContent and document.title, never as markup.

import { COPY } from './ui-state.js';

/** The name of the meta tag the server fills with the label. */
export const SESSION_LABEL_META = 'moontide-session-label';

/** Mirrors src/web-server.ts's SESSION_LABEL_PLACEHOLDER by hand (test/session-identity.test.js checks both sides). */
export const SESSION_LABEL_PLACEHOLDER = '__MOONTIDE_SESSION_LABEL__';

/**
 * Reads the label from the meta tag, once. A missing tag, an empty content or the unfilled placeholder
 * means the page was not served by a started Moontide: that is reported once, loudly, and the result
 * is null. The label itself is never logged.
 */
export function readSessionLabel(document, reportError) {
  const meta = document.querySelector(`meta[name="${SESSION_LABEL_META}"]`);
  const content = meta ? meta.getAttribute('content') : null;
  if (!content || content === SESSION_LABEL_PLACEHOLDER) {
    reportError(
      `Moontide: this page has no ${SESSION_LABEL_META} meta tag with a label (was it served by a started Moontide?), so the tab title and the Session card cannot name its server.`,
    );
    return null;
  }
  return content;
}

/** The tab title without any warning: the wordmark, a middle dot, the label; the wordmark alone without a label. */
export function baseTitle(label) {
  return label === null ? 'Moontide' : `Moontide · ${label}`;
}

/** The key above the label: "Port" when the label is the port alone (one to five digits), "Folder and port" otherwise. */
export function identityKey(label) {
  return /^\d{1,5}$/.test(label) ? COPY.identityPortKey : COPY.identityFolderKey;
}

/**
 * Fills the first row of the Session card with the key and the label, as text only. Without a label the
 * row is removed, so no empty row shows (the missing tag was already reported by readSessionLabel).
 * A page without the row is a bug and is reported once.
 */
export function renderSessionIdentity(document, label, reportError) {
  const row = document.getElementById('session-identity');
  if (!row) {
    reportError('Moontide: the Session card has no #session-identity row.');
    return;
  }
  if (label === null) {
    row.remove();
    return;
  }
  row.querySelector('.session-key').textContent = identityKey(label);
  document.getElementById('session-label').textContent = label;
}
