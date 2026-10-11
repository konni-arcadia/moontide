#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Session } from './session.js';
import { createMcpServer } from './mcp.js';
import { createStarter } from './start.js';
import { HistoryStore, resolveDataDir } from './history.js';
import { RigStore } from './instruments.js';
import { runImportMidnamCommand } from './import-midnam.js';
import { BuildWatch, servedDirs } from './build-id.js';
import { readPackageVersion } from './version.js';

const FORCE_EXIT_MS = 2000;

async function main(): Promise<void> {
  // First, so a broken install fails the start loudly; stderr only, because stdout is the protocol.
  console.error(`[moontide] Version ${readPackageVersion()}`);
  // The fingerprint of the served files is taken before anything else, so a later difference
  // means the files changed after this server started.
  const build = new BuildWatch(servedDirs());
  // Resolved lazily (a function, not resolveDataDir() called eagerly) so even a
  // missing home directory becomes a history error rather than a crash at construction time.
  const history = new HistoryStore({ dataDir: () => resolveDataDir() });
  try {
    const file = history.load();
    console.error(`[moontide] History file: ${file}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[moontide] History unavailable: ${message}`);
  }

  // The setup file is read at every use, never at construction; the shipped models are loaded here.
  const rig = new RigStore({ dataDir: () => resolveDataDir() });
  const session = new Session({ history, rig, build });
  // Nothing starts with the process: no web server, no port, no browser tab. The start tool starts
  // Moontide, once. MOONTIDE_NO_BROWSER=1 makes that start open no tab (used by tests and probes).
  const starter = createStarter({ session, noBrowser: process.env.MOONTIDE_NO_BROWSER === '1' });
  const mcpServer = createMcpServer({ session, starter });

  // Registered before connecting the MCP transport, so any signal sent from then on goes through
  // the clean shutdown path. Before a start there is no web server to close.
  // The SDK's StdioServerTransport does not detect stdin EOF itself, so shutdown is wired
  // explicitly off stdin and OS signals.
  let shuttingDown = false;
  function shutdown(reason: string): void {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`[moontide] Shutting down (${reason})`);
    const forceExit = setTimeout(() => process.exit(0), FORCE_EXIT_MS);
    forceExit.unref();
    void Promise.allSettled([starter.close(), mcpServer.close()]).then(() => {
      process.exit(0);
    });
  }

  process.stdin.on('end', () => shutdown('stdin end'));
  process.stdin.on('close', () => shutdown('stdin close'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGHUP', () => shutdown('SIGHUP'));

  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
}

// A first argument selects a command. No argument starts the server exactly as before. Behavior change:
// an argument used to be ignored; an unknown one now exits 2 with the usage line.
const [command, ...rest] = process.argv.slice(2);
if (command === undefined) {
  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[moontide] Failed to start: ${message}`);
    process.exit(1);
  });
} else if (command === '--version' && rest.length === 0) {
  // The one line on stdout is the answer itself; a broken package.json is an error, not a made-up version.
  try {
    process.stdout.write(`${readPackageVersion()}\n`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Moontide: ${message}`);
    process.exitCode = 1;
  }
} else if (command === 'import-midnam') {
  // A short-lived command: it never starts the web server, reads stdin or connects the MCP transport.
  process.exitCode = runImportMidnamCommand(rest, {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    rig: new RigStore({ dataDir: () => resolveDataDir() }),
  });
} else {
  console.error(`Moontide: unknown command ${JSON.stringify(command)}.`);
  console.error('Usage: moontide-mcp [--version | import-midnam <file> --model <id> [--replace]]');
  process.exitCode = 2;
}
