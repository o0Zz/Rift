import { IS_WINDOWS } from "../settings/settings";

/** A path typed into a shell: double-quoted when it holds spaces or shell-special characters. */
export function quotePath(path: string): string {
  return /[\s'"`$&();|<>]/.test(path) ? `"${path.replace(/"/g, '\\"')}"` : path;
}

/** The local path of a `file://` address (percent-decoded), or undefined (another host, not this OS's kind). */
export function fileUrlPath(uri: string, windows = IS_WINDOWS): string | undefined {
  const m = /^file:\/\/(?:localhost)?(\/[^?#]*)$/i.exec(uri);
  if (!m) return;
  let path: string;
  try {
    path = decodeURIComponent(m[1]);
  } catch {
    return;
  }
  if (!windows) return path;
  return /^\/[A-Za-z]:/.test(path) ? path.slice(1) : undefined;
}

const STOP = "\\s\"'`<>|*?";
// file:// addresses | drive paths (C:\x, I:/x) | absolute Unix paths of two parts or more, after a space, a quote,
// ( [ or = (so `and/or`, `1/2` and a URL's path are not paths).
const PRINTED = new RegExp(
  `file://[^${STOP}]+|(?<![\\w])[A-Za-z]:[\\\\/][^${STOP}]*|(?<![^\\s"'(\\[=])/[\\w.~-]+/[^${STOP}]*`,
  "g",
);

/**
 * Paths printed in a line, for Ctrl+click: up to a space or quote, without the punctuation or `:line:col` after
 * them. Windows: drive paths, Git Bash's `/c/x` (as `C:\x`) and file:// addresses; elsewhere: `/x/y` and file://.
 * `start` / `end`: string indexes of the text, end exclusive; `path`: what to open.
 */
export function printedPaths(line: string, windows = IS_WINDOWS): { path: string; start: number; end: number }[] {
  const found = [];
  for (const m of line.matchAll(PRINTED)) {
    const text = m[0].replace(/[.,;:)\]}]+$/, "").replace(/(:\d+)+$/, "");
    const path = text.startsWith("file:") ? fileUrlPath(text, windows) : windows ? windowsPath(text) : unixPath(text);
    if (path) found.push({ path, start: m.index, end: m.index + text.length });
  }
  return found;
}

function windowsPath(text: string): string | undefined {
  if (/^[A-Za-z]:/.test(text)) return text;
  const msys = /^\/([a-zA-Z])(\/.*)$/.exec(text);
  return msys ? `${msys[1].toUpperCase()}:${msys[2].replace(/\//g, "\\")}` : undefined;
}

function unixPath(text: string): string | undefined {
  return text.startsWith("/") ? text : undefined;
}
