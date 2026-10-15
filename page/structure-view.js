// DOM builder for the lines above Moontide's Song grid in the Parts view: up to a few plain lines in #song-notes (the
// helper changed or missing, what plays differs, the check failed). The grid itself is drawn by page/song-grid-view.js.
// Everything that comes from the code reaches the page through textContent, title or setAttribute only; the lines are
// read-only text (no listener, no focusable element). `document` is injected, so the module has no DOM access at import
// time and node:test drives it with a tiny fake document.

/**
 * `createSongView({ document, notes })` returns `{ showNotes(lines), clearNotes() }`.
 * `notes` is the element that holds the lines. A line is a string or `{ text, kind }`; kind 'check-failed' is drawn
 * muted. showNotes writes the DOM only when the text of the lines changed.
 */
export function createSongView({ document, notes }) {
  let shownNotes = '';

  function make(tag, className, text) {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function showNotes(lines) {
    const entries = lines.map((line) => (typeof line === 'string' ? { text: line, kind: null } : { text: line.text, kind: line.kind ?? null }));
    const key = entries.map((entry) => `${entry.kind ?? ''}\u0000${entry.text}`).join('\u0001');
    if (key === shownNotes) return;
    shownNotes = key;
    notes.replaceChildren(
      ...entries.map((entry) => {
        const node = make('p', 'song-note', entry.text);
        if (entry.kind !== null) node.setAttribute('data-kind', entry.kind);
        return node;
      }),
    );
    notes.hidden = entries.length === 0;
  }

  return { showNotes, clearNotes: () => showNotes([]) };
}
