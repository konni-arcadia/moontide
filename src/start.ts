import type { Session } from './session.js';
import { startWebServer, type WebServer } from './web-server.js';
import { openBrowser } from './open-browser.js';
import { tabTitle } from './session-label.js';
import { PAGE_REQUESTS_ON_PROMPT, PAGE_REQUESTS_TOOL } from './ask.js';

// Moontide starts on demand. The MCP process stays quiet (no web server, no port, no browser tab)
// until something asks for a start: the start tool or the first music request. There is one
// start per process, shared by callers that arrive at the same time or later. All logging goes to
// stderr, because stdout is the MCP protocol.

export const START_TOOL = 'start';
export const START_TOOL_DESCRIPTION =
  'Starts Moontide: its web server on this computer and its page, which opens in a new browser tab; ' +
  'one click in that tab turns the sound on. ' +
  'Call it when the user asks, in any words, to start or open Moontide, or asks which tab or port is yours. ' +
  'Calling it again is safe: it gives the page address, the port and the tab title, and opens a new tab only when no page is connected. ' +
  'set_code starts Moontide by itself, and so does restore_version for a version that exists, so there is no need to call it before them. ' +
  'edit_code changes music that already plays and starts nothing. ' +
  'The start prompt does the same where the client offers MCP prompts.';

// The one sentence of the server instructions about starting. Nothing starts with the session; the details
// (what each tool does before the start, the wait for the page) are in the tool descriptions.
export const START_INSTRUCTION = 'The start tool or the first change of the music starts Moontide and opens its page.';

// The start prompt, shown by Claude Code as the slash command /mcp__moontide__start. It and the start tool
// call the same function (startMoontide), the way the page-requests prompts and tool share one switch.
export const START_PROMPT = 'start';
export const START_PROMPT_TITLE = 'Start Moontide';
export const START_PROMPT_DESCRIPTION =
  'Start Moontide and open its page in a new browser tab, or say where its page is when it already runs.';

export const PAGE_LINE_PREFIX = 'Page: ';

// How long a music request waits for the page of the tab it just opened. A browser that is not running
// yet has to open and load the page, which can take many seconds; the limit stays below the 60 s default
// request limit of MCP clients, so the reply is ours and not a client timeout.
export const PAGE_WAIT_MS = 30000;

/** The failure of a music request whose page did not connect in time. Nothing was sent to the page. */
export function pageWaitTimeoutMessage(server: StartedServer, waitMs: number): string {
  const seconds = Math.ceil(waitMs / 1000);
  return (
    `No page connected within ${seconds} s: Moontide opened ${server.url} in a new browser tab, but that page did not connect. ` +
    'Open the address in a browser or reload its tab, click once in it, then send the change again. Nothing was sent to the page.'
  );
}

export interface StartedServer {
  url: string;
  port: number;
  /** The folder name and the port (see session-label.ts); the page shows it in its tab title. */
  label: string;
}

// opened: this start opened the tab. no-browser: no tab was opened, on purpose (MOONTIDE_NO_BROWSER=1).
// connected: Moontide was started before and its page is connected. on-its-way: a tab was opened less than the
// wait limit ago and has not connected yet. reopened: Moontide was started before, no page is connected and
// no tab is on its way, so a new tab was opened.
export type TabOutcome = 'opened' | 'no-browser' | 'connected' | 'on-its-way' | 'reopened';

export interface StartOutcome {
  server: StartedServer;
  startedNow: boolean;
  tab: TabOutcome;
}

export interface StarterOptions {
  session: Session;
  /** True when a start must not open a browser tab (MOONTIDE_NO_BROWSER=1: tests and probes). */
  noBrowser: boolean;
  openBrowser?: (url: string) => void;
  startWebServer?: typeof startWebServer;
  port?: number;
  pageDir?: string;
  /** The folder name for the session label; tests give a made-up one. Defaults to the process folder. */
  folder?: string;
  /** How long waitForPage waits for the page of a tab it opened. Defaults to PAGE_WAIT_MS. */
  pageWaitMs?: number;
  /** The clock, for tests. Defaults to Date.now. */
  now?: () => number;
}

export interface Starter {
  /** Starts Moontide once; every later or concurrent call shares that start. Rejects loudly on failure. */
  start(): Promise<StartOutcome>;
  /**
   * The same start as start(), for a caller that only needs Moontide running (a music request): it shares the
   * one start and never opens another tab.
   */
  ensureStarted(): Promise<{ server: StartedServer; startedNow: boolean }>;
  /**
   * Resolves at once when a page is connected or no tab is on its way. Otherwise waits for the page of the tab
   * that was opened, at most pageWaitMs after it opened, and rejects with pageWaitTimeoutMessage.
   */
  waitForPage(): Promise<void>;
  /** The started server, or null before a start, while one is in flight and after a failed one. */
  current(): StartedServer | null;
  /** Closes the web server if one was started (waits for a start in flight first). */
  close(): Promise<void>;
}

/** The one string the start reply and get_code share: where the page is and which tab it is. */
export function pageLine(server: StartedServer): string {
  return `${PAGE_LINE_PREFIX}${server.url} (port ${server.port}), in the browser tab titled "${tabTitle(server.label)}".`;
}

const TAB_SENTENCES: Record<TabOutcome, string> = {
  opened: 'A new browser tab opened on it; one click there turns the sound on.',
  'no-browser':
    'No tab was opened (MOONTIDE_NO_BROWSER=1): open the page yourself; one click there turns the sound on.',
  connected: 'Its page is connected; no new tab was opened.',
  'on-its-way': 'The tab opened for it has not connected yet; no second tab was opened.',
  reopened: 'No page was connected, so a new browser tab opened on it; one click there turns the sound on.',
};

export function startReplyText(outcome: StartOutcome): string {
  const head = outcome.startedNow ? 'Moontide started.' : 'Moontide is already started.';
  return `${head} ${pageLine(outcome.server)} ${TAB_SENTENCES[outcome.tab]}`;
}

/** The one function behind the start prompt and the start tool. */
export async function startMoontide(starter: Starter): Promise<string> {
  return startReplyText(await starter.start());
}

/** Why page-requests-on cannot run before the start: no page is open. */
export function notStartedForRequestsText(): string {
  return (
    'Moontide is not started yet, so page requests cannot be turned on: no page is open. ' +
    `Run ${START_PROMPT} (or ask for music), then run ${PAGE_REQUESTS_ON_PROMPT} again.`
  );
}

/** Same as notStartedForRequestsText, for the tool: the way back is calling the tools again. */
export function notStartedForRequestsToolText(): string {
  return (
    'Moontide is not started yet, so page requests cannot be turned on: no page is open. ' +
    `Call ${START_TOOL} (or ask for music), then call ${PAGE_REQUESTS_TOOL} with state on again.`
  );
}

const NO_BROWSER_LINE = '[moontide] MOONTIDE_NO_BROWSER=1: not opening the browser.';

interface Started {
  web: WebServer;
  tab: 'opened' | 'no-browser';
}

export function createStarter(options: StarterOptions): Starter {
  const { session, noBrowser } = options;
  const startServer = options.startWebServer ?? startWebServer;
  const open = options.openBrowser ?? openBrowser;
  const pageWaitMs = options.pageWaitMs ?? PAGE_WAIT_MS;
  const serverOf = (server: WebServer): StartedServer => ({ url: server.url, port: server.port, label: server.label });
  const now = options.now ?? Date.now;

  // The one start. Null before the first call and after a failed start, so a later call retries.
  let starting: Promise<Started> | null = null;
  let web: WebServer | null = null;
  let closed = false;

  // When the tab was opened, until a page connects. A tab is on its way while it was opened less than
  // pageWaitMs ago and no page has connected since.
  let tabOpenedAt: number | null = null;
  // False from the creation of the start until its server is up: a call in that window joins the start.
  let startSettled = false;
  session.onPageAttached(() => {
    tabOpenedAt = null;
  });

  function tabOnItsWay(): boolean {
    return tabOpenedAt !== null && now() - tabOpenedAt < pageWaitMs;
  }

  async function begin(): Promise<Started> {
    let server: WebServer;
    try {
      server = await startServer({
        session,
        port: options.port,
        pageDir: options.pageDir,
        folder: options.folder,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`Moontide could not start its web server: ${reason}`);
    }
    web = server;
    session.setPageUrl(server.url);
    console.error(`[moontide] Moontide page: ${server.url}`);
    if (noBrowser) {
      console.error(NO_BROWSER_LINE);
      startSettled = true;
      return { web: server, tab: 'no-browser' };
    }
    tabOpenedAt = now();
    open(server.url);
    startSettled = true;
    return { web: server, tab: 'opened' };
  }

  // The one start, shared by start() and ensureStarted(). Only the call that creates it reports startedNow.
  async function ensure(): Promise<{ started: Started; startedNow: boolean }> {
    if (starting !== null) {
      return { started: await starting, startedNow: false };
    }
    const creating = begin();
    starting = creating;
    // A failed start is forgotten, so the next call tries again.
    creating.catch(() => {
      if (starting === creating) starting = null;
    });
    return { started: await creating, startedNow: true };
  }

  return {
    async start() {
      if (starting === null) {
        const { started } = await ensure();
        return { server: serverOf(started.web), startedNow: true, tab: started.tab };
      }
      // A call that arrives while the first start is still in flight joins it: that start opens (or skips) the tab.
      const joining = !startSettled;
      const started = await starting;
      const server = serverOf(started.web);
      if (joining) {
        return { server, startedNow: false, tab: started.tab === 'opened' ? 'on-its-way' : 'no-browser' };
      }
      if (session.hasActivePage()) return { server, startedNow: false, tab: 'connected' };
      if (tabOnItsWay()) return { server, startedNow: false, tab: 'on-its-way' };
      if (noBrowser) {
        console.error(NO_BROWSER_LINE);
        return { server, startedNow: false, tab: 'no-browser' };
      }
      // No page and no tab on its way: the page is gone. At most one new tab per wait limit.
      tabOpenedAt = now();
      open(server.url);
      return { server, startedNow: false, tab: 'reopened' };
    },

    async ensureStarted() {
      const { started, startedNow } = await ensure();
      return { server: serverOf(started.web), startedNow };
    },

    async waitForPage() {
      if (session.hasActivePage() || !tabOnItsWay() || tabOpenedAt === null || web === null) return;
      const server = serverOf(web);
      const left = Math.max(0, tabOpenedAt + pageWaitMs - now());
      await new Promise<void>((resolve, reject) => {
        let off: () => void = () => undefined;
        const timer = setTimeout(() => {
          off();
          reject(new Error(pageWaitTimeoutMessage(server, pageWaitMs)));
        }, left);
        off = session.onPageAttached(() => {
          clearTimeout(timer);
          off();
          resolve();
        });
      });
    },

    current() {
      return web === null ? null : serverOf(web);
    },

    async close() {
      if (closed) return;
      closed = true;
      if (starting !== null) {
        await starting.catch(() => undefined);
      }
      if (web !== null) {
        await web.close();
      }
    },
  };
}
