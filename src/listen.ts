// The page-request listener: a dumb pipe for Claude Code's Monitor tool. It connects to the
// Moontide server's /listen endpoint and prints one stdout line per request typed in the page.
//
// stdout only, because Monitor does not stream stderr. Silent on success, because every printed line
// wakes Claude: it prints nothing when it connects. On any failure it prints exactly one line and
// ends with a non-zero exit code. Run as: node dist/listen.js <port> <token>

import WebSocket from 'ws';
import {
  listenerBadFrameLine,
  listenerConnectFailedLine,
  listenerEndedLine,
  listenerRefusedLine,
  listenerUsageLine,
} from './ask.js';

/** Connects and pipes requests to stdout. `port` is already checked to be an integer from 1 to 65535. */
function listen(port: number, token: string): void {
  let opened = false;
  let finished = false;

  // Prints the failure line the first time any failure path runs, so exactly one line is ever printed.
  // The exit code is set and the event loop drains: an immediate exit could cut the line.
  const finish = (line: string): void => {
    if (finished) {
      return;
    }
    finished = true;
    process.exitCode = 1;
    process.stdout.write(`${line}\n`);
  };

  let ws: WebSocket;
  try {
    // No origin option: a browser always sends Origin, and the server refuses any listener that does.
    ws = new WebSocket(`ws://127.0.0.1:${port}/listen`, { headers: { Authorization: `Bearer ${token}` } });
  } catch (err) {
    // A throw here would print a stack trace on stderr, which Monitor never shows.
    finish(listenerConnectFailedLine(port, err instanceof Error ? err.message : String(err)));
    return;
  }

  ws.on('open', () => {
    opened = true;
  });

  ws.on('unexpected-response', (req, res) => {
    finish(listenerRefusedLine(res.statusCode));
    req.destroy();
  });

  ws.on('error', (err) => {
    if (!opened) {
      finish(listenerConnectFailedLine(port, err.message));
    }
  });

  ws.on('message', (data) => {
    let frame: { id: string; line: string };
    try {
      const parsed = JSON.parse(data.toString()) as { id?: unknown; line?: unknown };
      if (typeof parsed.id !== 'string' || typeof parsed.line !== 'string') {
        throw new Error('not a request frame');
      }
      frame = { id: parsed.id, line: parsed.line };
    } catch {
      // The server's acknowledgement timer keeps the request.
      process.stdout.write(`${listenerBadFrameLine()}\n`);
      return;
    }
    // Acknowledged only once the line is written: "received" means Claude's pipe took it.
    process.stdout.write(`${frame.line}\n`, (err) => {
      if (err) {
        // The pipe did not take the line, so no ack: the stdout 'error' handler closes the socket and
        // the server keeps the request.
        return;
      }
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ ack: frame.id }));
      }
    });
  });

  ws.on('close', (code, reason) => {
    finish(listenerEndedLine(code, reason.toString()));
  });

  // For example EPIPE when the Monitor pipe is gone: close the socket so the server keeps the request.
  process.stdout.on('error', () => {
    process.exitCode = 1;
    ws.terminate();
  });
}

const [portArg, token] = process.argv.slice(2);
const port = portArg === undefined || !/^\d+$/.test(portArg) ? Number.NaN : Number(portArg);

if (!Number.isInteger(port) || port < 1 || port > 65535 || token === undefined || token === '') {
  process.stdout.write(`${listenerUsageLine()}\n`);
  process.exitCode = 2;
} else {
  listen(port, token);
}
