// The load failure notice of Moontide's browser page: the thin DOM part and the one report to the server.
// Loaded as a module before page/main.js, and it needs nothing from it: when the Strudel script did not load,
// main.js waits for the editor forever, and this notice is the only thing that can say why. Every text is
// written with textContent, title or setAttribute, never as markup. When both scripts loaded it changes nothing.
import { PAGE_TOKEN_PLACEHOLDER } from './ask.js';
import {
  LOAD_FAILURE_COPY,
  LOAD_FAILURE_REPORT_MS,
  createReportSettler,
  failedScripts,
  loadFailureMode,
  noticeTexts,
} from './load-failure.js';

function scriptAddress(fragment) {
  const script = document.querySelector(`script[src*="${fragment}"]`);
  return script ? script.src : '';
}

/** Before the strip hides, give focus to a control that stays on screen, so it does not fall to nothing. */
function keepFocusOnPage() {
  const transport = document.getElementById('transport-button');
  if (transport) {
    transport.focus({ preventScroll: true });
    return;
  }
  document.body.setAttribute('tabindex', '-1');
  document.body.focus({ preventScroll: true });
}

function showNotice(mode, texts) {
  const panel = document.getElementById('load-failure');
  const title = document.getElementById('load-failure-title');
  const what = document.getElementById('load-failure-what');
  const todo = document.getElementById('load-failure-todo');
  const addresses = document.getElementById('load-failure-addresses');
  const claude = document.getElementById('load-failure-claude');
  const reloadButton = document.getElementById('load-failure-reload');
  const dismissButton = document.getElementById('load-failure-dismiss');
  const alertRegion = document.getElementById('load-failure-alert');
  const blocked = mode !== 'degraded-acorn';

  document.body.setAttribute('data-load', blocked ? 'failed' : 'degraded');
  title.textContent = texts.heading;
  what.textContent = texts.what;
  todo.textContent = texts.todo;
  for (const line of texts.addresses) {
    const row = document.createElement('span');
    row.textContent = line;
    addresses.appendChild(row);
  }
  claude.textContent = LOAD_FAILURE_COPY.claude.sending;
  reloadButton.textContent = LOAD_FAILURE_COPY.reload.label;
  reloadButton.setAttribute('title', LOAD_FAILURE_COPY.reload.title);
  reloadButton.addEventListener('click', () => location.reload());
  if (!blocked) {
    dismissButton.textContent = LOAD_FAILURE_COPY.dismiss.label;
    dismissButton.setAttribute('title', LOAD_FAILURE_COPY.dismiss.title);
    dismissButton.addEventListener('click', () => {
      keepFocusOnPage();
      panel.hidden = true;
    });
    dismissButton.hidden = false;
  }
  panel.hidden = false;
  if (texts.title !== null) document.title = texts.title;
  alertRegion.textContent = texts.alert;
  if (blocked) reloadButton.focus();
  return claude;
}

/** One attempt per page load to tell the server, on a socket that never attaches the page. */
function report(failed, claude) {
  let socket = null;
  let timer = null;
  const settler = createReportSettler((outcome) => {
    if (timer !== null) clearTimeout(timer);
    if (outcome === 'told') {
      claude.textContent = LOAD_FAILURE_COPY.claude.told;
    } else if (outcome === 'refused') {
      claude.textContent = LOAD_FAILURE_COPY.claude.refused;
      claude.setAttribute('data-state', 'refused');
    } else {
      claude.textContent = LOAD_FAILURE_COPY.claude.unreachable;
      claude.setAttribute('data-state', 'unreachable');
    }
    if (socket !== null) {
      try {
        socket.close();
      } catch {
        // Already closed: nothing left to do.
      }
    }
  });

  const meta = document.querySelector('meta[name="moontide-page-token"]');
  const token = meta ? meta.getAttribute('content') : null;
  if (!token || token === PAGE_TOKEN_PLACEHOLDER) {
    console.error(
      'Moontide: this page was not served by the Moontide server, so it has no page token and cannot tell Claude that a script did not load.',
    );
    settler.fail();
    return;
  }

  timer = setTimeout(() => settler.fail(), LOAD_FAILURE_REPORT_MS);
  try {
    socket = new WebSocket('ws://' + location.host + '/ws');
  } catch (error) {
    console.error('Moontide: could not open the connection to tell Claude that a script did not load:', error);
    settler.fail();
    return;
  }
  socket.addEventListener('open', () => {
    socket.send(JSON.stringify({ type: 'load-failed', token, failed }));
  });
  socket.addEventListener('message', (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message && message.type === 'load-failed-result') settler.answer(message.ok);
  });
  socket.addEventListener('error', () => settler.fail());
  socket.addEventListener('close', () => settler.fail());
}

const mode = loadFailureMode({
  strudelDefined: customElements.get('strudel-editor') !== undefined,
  acornDefined: typeof window.acorn?.parse === 'function',
});

if (mode !== 'none') {
  const texts = noticeTexts(mode, {
    strudelSrc: scriptAddress('@strudel/repl'),
    acornSrc: scriptAddress('acorn'),
  });
  const claude = showNotice(mode, texts);
  report(failedScripts(mode), claude);
}
