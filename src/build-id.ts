// The content fingerprint of the files the server serves (the page folder and its own compiled code),
// and the watcher a Session asks at each page connection. The server serves page/ live from disk but
// keeps its own code in memory, so after an update without a restart the page is newer than the server.
// The fingerprint hashes the bytes, never the size or the modification time: `npm run build` rewrites
// identical bytes with a new time, and that must not read as "restart". This module imports only
// node built-ins.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * What differs from the start. `page` means the page folder changed: the page a browser loads is then not
 * the page this server started with, so page and server come from different builds. `server` means the
 * compiled code folder changed: the running server is older than its files, but the page it serves is
 * still the one it started with.
 */
export interface BuildChange {
  page: boolean;
  server: boolean;
}

/** The question a Session asks at each page connection: which of the served folders differ from the start? */
export interface BuildCheck {
  changed(): BuildChange;
}

/** The two folders whose files make up a build. */
export interface ServedDirs {
  page: string;
  server: string;
}

/**
 * The two folders whose files make up a build: the page folder and the compiled code folder.
 * The page folder mirrors startWebServer's default in src/web-server.ts. Both come from this
 * module's own location, never from a message or a tool argument.
 */
export function servedDirs(): ServedDirs {
  const distDir = path.dirname(fileURLToPath(import.meta.url));
  const pageDir = path.join(distDir, '..', 'page');
  return { page: pageDir, server: distDir };
}

const SERVED_FILE = /\.(html|js|css)$/;

/**
 * SHA-256 (hex) over the sorted names and bytes of the .html, .js and .css files directly in each
 * folder, in the order the folders are given. Other extensions and subfolders are ignored. Throws
 * when a folder or a file cannot be read.
 */
export function fingerprintDirs(dirs: readonly string[]): string {
  const hash = createHash('sha256');
  dirs.forEach((dir, index) => {
    const names = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && SERVED_FILE.test(entry.name))
      .map((entry) => entry.name)
      .sort();
    for (const name of names) {
      hash.update(`${index}\0${name}\0`);
      hash.update(readFileSync(path.join(dir, name)));
      hash.update('\0');
    }
  });
  return hash.digest('hex');
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Takes the fingerprint of each folder when it is built and answers which folders differ from it now.
 * A read failure at the start turns the check off (loudly, once); a read failure later counts as a
 * change of the folder that could not be read (a build may be rewriting the files) and is logged once.
 * Nothing about the files leaves this module except those stderr lines.
 */
export class BuildWatch implements BuildCheck {
  private readonly dirs: ServedDirs;
  private readonly log: (line: string) => void;
  private readonly start: { page: string; server: string } | null;
  private readFailureLogged = false;

  constructor(dirs: ServedDirs, options?: { log?: (line: string) => void }) {
    this.dirs = dirs;
    this.log = options?.log ?? ((line) => console.error(line));
    let start: { page: string; server: string } | null = null;
    try {
      start = { page: fingerprintDirs([dirs.page]), server: fingerprintDirs([dirs.server]) };
    } catch (err) {
      this.log(`[moontide] Build check off: the served files could not be read: ${reasonOf(err)}`);
    }
    this.start = start;
  }

  changed(): BuildChange {
    if (this.start === null) return { page: false, server: false };
    return { page: this.folderChanged('page', this.start.page), server: this.folderChanged('server', this.start.server) };
  }

  private folderChanged(which: keyof ServedDirs, started: string): boolean {
    try {
      return fingerprintDirs([this.dirs[which]]) !== started;
    } catch (err) {
      if (!this.readFailureLogged) {
        this.readFailureLogged = true;
        this.log(`[moontide] Build check: the served files could not be read, so they count as changed: ${reasonOf(err)}`);
      }
      return true;
    }
  }
}
