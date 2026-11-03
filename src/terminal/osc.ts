// Folder reports sent by Rift's shell integration at every prompt.

import { IS_WINDOWS } from "../settings/settings";

/** OSC 9;9 (PowerShell on Windows): `9;"C:\path"`. */
export function cwdFromOsc9(data: string): string | undefined {
  if (!data.startsWith("9;")) return;
  return data.slice(2).replace(/^"(.*)"$/, "$1");
}

/**
 * OSC 7 (bash/zsh): `file://host/path`, percent-encoded. On Windows, Git Bash reports MSYS paths
 * (`/c/Dev/x`): they become Windows paths (`C:\Dev\x`) so the rest of Rift can use them.
 */
export function cwdFromOsc7(data: string, windows = IS_WINDOWS): string | undefined {
  const m = /^file:\/\/[^/]*(\/.*)$/.exec(data);
  if (!m) return;
  let path: string;
  try {
    path = decodeURIComponent(m[1]);
  } catch {
    path = m[1];
  }
  const msys = windows && /^\/([a-zA-Z])(\/.*)?$/.exec(path);
  return msys ? `${msys[1].toUpperCase()}:${(msys[2] ?? "\\").replace(/\//g, "\\")}` : path;
}
