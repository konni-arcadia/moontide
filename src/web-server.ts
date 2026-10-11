import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Session, PageConnection } from './session.js';
import { parsePageMessage } from './protocol.js';
import { folderName, sessionLabel, tabTitle } from './session-label.js';
import { askIdOf, makeThrottledLog, type ListenerConnection } from './ask.js';

export const DEFAULT_PORT = 5757;
export const HOST = '127.0.0.1';
export const WS_PATH = '/ws';
export const MAX_PAYLOAD_BYTES = 1048576;
// The endpoint Claude's listener connects to. Frames from it are tiny acknowledgements.
export const LISTEN_PATH = '/listen';
export const LISTEN_MAX_PAYLOAD_BYTES = 1024;
// A website opening sockets in a loop must not flood stderr: log this many distinct refused origins.
export const MAX_LOGGED_REFUSED_ORIGINS = 20;
const MAX_LOGGED_ORIGIN_LENGTH = 100;
// Refused /listen attempts and invalid page frames are logged at most once per this many ms for each kind.
export const LISTEN_REFUSAL_LOG_WINDOW_MS = 1000;
// The served index.html carries this in its page-token meta tag; the server swaps in the real
// per-start token. page/ask.js mirrors it by hand (test/ask.test.js checks both sides).
export const PAGE_TOKEN_PLACEHOLDER = '__MOONTIDE_PAGE_TOKEN__';
// The served index.html also carries these two, and the server fills them in for each start: the
// placeholder is the content of the session-label meta tag, and the static title becomes the
// tab title with the label. page/session-identity.js mirrors the placeholder by hand (test/session-identity.test.js
// checks both sides).
export const SESSION_LABEL_PLACEHOLDER = '__MOONTIDE_SESSION_LABEL__';
export const STATIC_TITLE = '<title>Moontide</title>';

export interface WebServer {
  url: string;
  port: number;
  /** The folder name and the bound port (see session-label.ts); the same string the page shows. */
  label: string;
  close(): Promise<void>;
}

// Sent with every response, errors included, so no case can forget them: no other site may frame the
// page, and no request leaves it with a Referer. Nothing else goes into the policy: Strudel evaluates
// code, so a script rule would break the page without a visible error.
const SECURITY_HEADERS = {
  'Content-Security-Policy': "frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
};

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

/**
 * True only when the Host header names this server's own loopback address and the port it is bound to.
 * A website that points its own name at 127.0.0.1 (DNS rebinding) sends its own name here, so it is refused.
 * The name is compared without regard to case; the port, a trailing dot or any other form must match exactly.
 */
export function isAllowedHost(host: string | undefined, port: number): boolean {
  if (host === undefined) {
    return false;
  }
  const lowered = host.toLowerCase();
  return lowered === `localhost:${port}` || lowered === `127.0.0.1:${port}` || lowered === `[::1]:${port}`;
}

// One fixed line for every Host refusal: it never repeats the header, which a hostile page chooses.
const HOST_REFUSAL_LOG =
  '[moontide] Refused a request whose Host header is not this server\'s own address (a page reached under another name, the shape of a DNS rebinding attack)';

function refuseHost(res: http.ServerResponse): void {
  res.writeHead(403, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' }).end('Forbidden\n');
}

/** Escapes text for HTML text and attribute values; & first, so the other replacements stay whole. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isEaddrinuse(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'EADDRINUSE';
}

/**
 * Starts the static page server and the WebSocket upgrade endpoint on 127.0.0.1 only.
 *
 * If the requested port is busy (EADDRINUSE), falls back once to an OS-assigned port
 * (listen(0)) and prints the actual URL to stderr. The process holding the busy port is never
 * inspected, signalled or connected to — a busy port only moves Moontide, nothing else.
 */
export function startWebServer(options: {
  session: Session;
  port?: number;
  pageDir?: string;
  /** The folder name for the session label; defaults to the folder this process runs in. */
  folder?: string;
}): Promise<WebServer> {
  const { session } = options;
  const pageDir = options.pageDir ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'page');
  const requestedPort = options.port ?? DEFAULT_PORT;
  let folder = options.folder ?? '';
  if (options.folder === undefined) {
    try {
      folder = folderName(process.cwd());
    } catch (err) {
      // The folder name itself is never logged (it is local data), only that it could not be read.
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[moontide] Could not read the working folder (${reason}); the label shows the port alone.`);
    }
  }

  return new Promise((resolve, reject) => {
    let boundPort = requestedPort;
    let settled = false;
    let usedFallback = false;
    // Set once the port is final, before the first request can arrive.
    let label = '';

    // requireHostHeader is off so a request with no Host header reaches the check below and gets the
    // same plain 403 as any other foreign name, instead of Node's own 400.
    const server = http.createServer({ requireHostHeader: false }, (req, res) => {
      // First of all, before the page and its token are read: boundPort changes after a port fallback.
      if (!isAllowedHost(req.headers.host, boundPort)) {
        logThrottled('host', HOST_REFUSAL_LOG);
        refuseHost(res);
        return;
      }
      void handleRequest(req, res, pageDir, session.ask.pageToken, label);
    });

    // Refused /ws origins already logged by this server, so each distinct one is logged once.
    const loggedRefusedOrigins = new Set<string>();
    let refusedOriginCapLogged = false;
    const logRefusedOrigin = (header: string | undefined): void => {
      const value = header === undefined ? 'none' : header.slice(0, MAX_LOGGED_ORIGIN_LENGTH);
      if (loggedRefusedOrigins.has(value)) {
        return;
      }
      if (loggedRefusedOrigins.size >= MAX_LOGGED_REFUSED_ORIGINS) {
        if (!refusedOriginCapLogged) {
          refusedOriginCapLogged = true;
          console.error('[moontide] Refusing WebSocket connections from more origins; further ones are not logged');
        }
        return;
      }
      loggedRefusedOrigins.add(value);
      console.error(
        `[moontide] Refused a WebSocket connection from origin ${JSON.stringify(value)} (only this Moontide page may connect)`,
      );
    };

    // Refused /listen attempts and invalid page frames: one log line per window for each kind, then a count of the ones left out.
    const logThrottled = makeThrottledLog(LISTEN_REFUSAL_LOG_WINDOW_MS);

    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });
    const listenWss = new WebSocketServer({ noServer: true, maxPayload: LISTEN_MAX_PAYLOAD_BYTES });

    server.on('upgrade', (req, socket, head) => {
      // Before the path, Origin and token rules: a page reached under another name gets nothing from them.
      if (!isAllowedHost(req.headers.host, boundPort)) {
        logThrottled('host', HOST_REFUSAL_LOG);
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === LISTEN_PATH) {
        // A browser always sends Origin, so no website can become the listener, token or not.
        if (req.headers.origin !== undefined) {
          logThrottled(
            'origin',
            '[moontide] Refused a listener connection that carried an Origin header (a browser page can never be the listener)',
          );
          socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
          socket.destroy();
          return;
        }
        const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
        if (bearer === undefined || !session.ask.checkListenerToken(bearer)) {
          logThrottled('token', '[moontide] Refused a listener connection: missing or wrong listener token');
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
        listenWss.handleUpgrade(req, socket, head, (ws) => {
          const conn: ListenerConnection = {
            send(data: string) {
              if (ws.readyState !== ws.OPEN) {
                throw new Error('Listener socket is not open');
              }
              ws.send(data);
            },
            close(code: number, reason: string) {
              ws.close(code, reason);
            },
          };
          session.ask.attachListener(conn);
          ws.on('message', (data) => {
            session.ask.handleListenerMessage(conn, data.toString());
          });
          ws.on('close', () => {
            session.ask.detachListener(conn);
          });
          ws.on('error', (err) => {
            console.error(`[moontide] Listener WebSocket error: ${err.message}`);
          });
        });
        return;
      }
      const origin = req.headers.origin;
      const allowedOrigins = [`http://localhost:${boundPort}`, `http://127.0.0.1:${boundPort}`];
      if (url.pathname !== WS_PATH || !origin || !allowedOrigins.includes(origin)) {
        // A wrong path from an allowed origin stays silent; a wrong origin is always loud.
        if (!origin || !allowedOrigins.includes(origin)) {
          logRefusedOrigin(origin);
        }
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    });

    wss.on('connection', (ws: WebSocket) => {
      const conn: PageConnection = {
        send(data: string) {
          if (ws.readyState !== ws.OPEN) {
            throw new Error('Page socket is not open');
          }
          ws.send(data);
        },
      };
      // The connection is attached only once it presents the page token (page-auth, handled in
      // session.handlePageMessage): until then it gets no hello and cannot become the active page.
      ws.on('message', (data) => {
        const text = data.toString();
        try {
          const msg = parsePageMessage(text);
          session.handlePageMessage(conn, msg);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          // A request that did not pass the schema is still answered, so the page can say so.
          const askId = askIdOf(text);
          if (askId !== null) {
            session.ask.refuseInvalid(conn, askId, reason);
          }
          logThrottled('invalid-message', `[moontide] Ignoring invalid page message: ${reason}`);
        }
      });
      ws.on('close', () => {
        session.detachPage(conn);
      });
      ws.on('error', (err) => {
        console.error(`[moontide] Page WebSocket error: ${err.message}`);
      });
    });

    server.on('error', (err) => {
      if (settled) {
        return;
      }
      if (!usedFallback && isEaddrinuse(err)) {
        usedFallback = true;
        // Never inspect, signal or connect to whatever holds requestedPort — just move.
        server.listen(0, HOST);
        return;
      }
      settled = true;
      reject(err);
    });

    server.on('listening', () => {
      if (settled) {
        return;
      }
      const address = server.address();
      boundPort = address && typeof address === 'object' ? address.port : requestedPort;
      if (usedFallback) {
        console.error(`[moontide] Port ${requestedPort} is busy, using port ${boundPort} instead.`);
      }
      label = sessionLabel(folder, boundPort);
      settled = true;
      resolve({
        url: `http://localhost:${boundPort}`,
        port: boundPort,
        label,
        async close() {
          for (const client of wss.clients) {
            client.terminate();
          }
          for (const client of listenWss.clients) {
            client.terminate();
          }
          await new Promise<void>((res) => wss.close(() => res()));
          await new Promise<void>((res) => listenWss.close(() => res()));
          server.closeAllConnections();
          await new Promise<void>((res) => server.close(() => res()));
        },
      });
    });

    server.listen(requestedPort, HOST);
  });
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pageDir: string,
  pageToken: string,
  label: string,
): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { ...SECURITY_HEADERS, Allow: 'GET, HEAD' }).end();
    return;
  }

  const url = new URL(req.url ?? '/', 'http://localhost');
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400, SECURITY_HEADERS).end();
    return;
  }
  if (pathname === '/') {
    pathname = '/index.html';
  }

  const resolvedPath = path.resolve(pageDir, '.' + pathname);
  if (!resolvedPath.startsWith(pageDir + path.sep)) {
    res.writeHead(404, SECURITY_HEADERS).end();
    return;
  }

  const ext = path.extname(resolvedPath);
  const contentType = CONTENT_TYPES[ext];
  if (!contentType) {
    res.writeHead(404, SECURITY_HEADERS).end();
    return;
  }

  try {
    let data = await fs.readFile(resolvedPath);
    if (path.basename(resolvedPath) === 'index.html') {
      // The page token is embedded in the page the server serves; it changes at every start.
      const text = data.toString('utf8');
      // A packaging bug is loud: a page without a token could never ask, and a page without its
      // label slots would be half filled. Each of the three must occur exactly once.
      const missing: string[] = [];
      if (text.split(PAGE_TOKEN_PLACEHOLDER).length !== 2) missing.push('page-token placeholder');
      if (text.split(SESSION_LABEL_PLACEHOLDER).length !== 2) missing.push('session-label placeholder');
      if (text.split(STATIC_TITLE).length !== 2) missing.push('static title');
      if (missing.length > 0) {
        console.error(`[moontide] page/index.html has no ${missing.join(' and no ')}`);
        res.writeHead(500, SECURITY_HEADERS).end();
        return;
      }
      // The function form of replace, so a $ in a folder name is never a replacement pattern.
      data = Buffer.from(
        text
          .replace(PAGE_TOKEN_PLACEHOLDER, () => pageToken)
          .replace(SESSION_LABEL_PLACEHOLDER, () => escapeHtml(label))
          .replace(STATIC_TITLE, () => `<title>${escapeHtml(tabTitle(label))}</title>`),
        'utf8',
      );
    }
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': contentType,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') {
      res.end();
    } else {
      res.end(data);
    }
  } catch (err) {
    if (isEnoent(err)) {
      res.writeHead(404, SECURITY_HEADERS).end();
    } else {
      console.error(
        `[moontide] Error reading ${resolvedPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
      res.writeHead(500, SECURITY_HEADERS).end();
    }
  }
}

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: string }).code === 'ENOENT';
}
