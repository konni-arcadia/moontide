import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The package.json one level above the built files (dist/), so it is the package's own. */
export const PACKAGE_JSON_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');

/**
 * The version written in package.json, read at run time. Every problem is an Error that names it:
 * a made-up version would hide a broken install.
 */
export function readPackageVersion(file: string = PACKAGE_JSON_PATH): string {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`package.json could not be read: ${reason}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`package.json is not valid JSON: ${reason}`);
  }
  const version = typeof parsed === 'object' && parsed !== null ? (parsed as { version?: unknown }).version : undefined;
  if (typeof version !== 'string' || version === '') {
    throw new Error('package.json has no version: the version field is missing or empty');
  }
  return version;
}
