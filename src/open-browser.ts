import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

// The server only ever passes its own loopback URL here (never user/network input), so this
// pattern is defense-in-depth against command injection, not user-input validation.
const LOOPBACK_URL_PATTERN = /^http:\/\/localhost:\d{1,5}$/;

export interface OpenCommand {
  command: string;
  args: string[];
  options?: SpawnOptions;
}

/**
 * Builds the platform-specific command that opens `url` in the default browser: `open` on
 * macOS, `xdg-open` everywhere else except Windows, `cmd /c start` on Windows.
 * Throws if `url` is anything other than the server's own loopback URL shape.
 */
export function buildOpenCommand(url: string, platform: NodeJS.Platform = process.platform): OpenCommand {
  if (!LOOPBACK_URL_PATTERN.test(url)) {
    throw new Error(`Refusing to open unexpected URL: ${url}`);
  }
  if (platform === 'darwin') {
    return { command: 'open', args: [url] };
  }
  if (platform === 'win32') {
    // The empty "" is a required placeholder for the window-title argument; without it,
    // `start` may treat the URL itself as the title (especially with `&` in the URL).
    // windowsVerbatimArguments stops Node from re-escaping that empty title.
    return {
      command: 'cmd',
      args: ['/c', 'start', '""', url],
      options: { windowsVerbatimArguments: true },
    };
  }
  return { command: 'xdg-open', args: [url] };
}

export interface OpenBrowserDeps {
  platform?: NodeJS.Platform;
  spawn?: typeof nodeSpawn;
}

/**
 * Opens `url` in the default browser. Never throws on a launch failure: the URL was already
 * printed by the caller, so a missing launcher or a failed spawn only degrades to "open it
 * manually".
 */
export function openBrowser(url: string, deps: OpenBrowserDeps = {}): void {
  const platform = deps.platform ?? process.platform;
  const spawn = deps.spawn ?? nodeSpawn;
  const { command, args, options } = buildOpenCommand(url, platform);

  const fallback = (reason: string): void => {
    console.error(`[moontide] Could not open the browser automatically (${reason}). Open ${url} manually.`);
  };

  try {
    const child: ChildProcess = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      ...options,
    });
    child.on('error', (err) => fallback(err.message));
    child.unref();
  } catch (err) {
    fallback(err instanceof Error ? err.message : String(err));
  }
}
