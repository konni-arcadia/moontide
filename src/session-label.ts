import path from 'node:path';

// The label tells two Moontide servers apart: the name of the folder the process runs in and the
// port it is bound to. It is local data, shown only in the local page and in tool replies, never
// logged or written to a file. It goes through the path API, so it works with / and with \.

export const LABEL_FOLDER_MAX = 40;
export const LABEL_SEPARATOR = ' · ';

const ELLIPSIS = '…';
// C0 and C1 control characters: a folder name can hold them, and none may reach a title or a reply.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;

/** The last part of the folder path; empty for a filesystem root or a drive root. */
export function folderName(cwd: string, pathApi: path.PlatformPath = path): string {
  return pathApi.basename(cwd);
}

/**
 * Makes a folder name fit a tab title: control characters become spaces, runs of white space
 * collapse to one space, the ends are trimmed, and a name longer than LABEL_FOLDER_MAX code points
 * is cut so that it ends with an ellipsis (never inside a character made of two code units).
 */
export function cleanFolderName(name: string): string {
  const cleaned = name.replace(CONTROL_CHARACTERS, ' ').replace(/\s+/g, ' ').trim();
  const points = Array.from(cleaned);
  if (points.length <= LABEL_FOLDER_MAX) {
    return cleaned;
  }
  return points.slice(0, LABEL_FOLDER_MAX - 1).join('') + ELLIPSIS;
}

/** The cleaned folder name, a middle dot and the port; the port alone when the folder gives no name. */
export function sessionLabel(folder: string, port: number): string {
  const name = cleanFolderName(folder);
  return name === '' ? String(port) : `${name}${LABEL_SEPARATOR}${port}`;
}

/** The title of the browser tab. */
export function tabTitle(label: string): string {
  return `Moontide${LABEL_SEPARATOR}${label}`;
}
