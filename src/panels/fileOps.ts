// File actions of the files panel. Pure: unit-tested in fileOps.test.ts.

import { IS_MAC, IS_WINDOWS } from "../settings/settings";

/** Where a deleted file goes (it is never deleted for good). */
export const TRASH_NAME = IS_WINDOWS ? "Recycle Bin" : "Trash";

/** The OS's file manager, as its users call it. */
export function fileManagerName(windows = IS_WINDOWS, mac = IS_MAC): string {
  return windows ? "File Explorer" : mac ? "Finder" : "file manager";
}
export const FILE_MANAGER = fileManagerName();

/** Delete (Suppr) deletes the selected file; Cmd+Backspace too on macOS, as in Finder. */
export function isDeleteKey(e: { key: string; metaKey: boolean }, mac = IS_MAC): boolean {
  return e.key === "Delete" || (mac && e.metaKey && e.key === "Backspace");
}

/** `path` as git names it in the repo at `root` ("src/a.ts"); undefined when it is outside. */
export function repoPath(root: string, path: string, ignoreCase = IS_WINDOWS || IS_MAC): string | undefined {
  if (!isUnder(path, root, ignoreCase)) return undefined;
  const rel = path.replace(/\\/g, "/").slice(root.replace(/\\/g, "/").replace(/\/+$/, "").length + 1);
  return rel || undefined;
}

/**
 * `path` is `target` or inside it (a deleted folder takes its files with it). Windows and macOS file systems
 * ignore case: `C:\Repo\src` holds `c:\repo\SRC\a.ts`.
 */
export function isUnder(path: string, target: string, ignoreCase = IS_WINDOWS || IS_MAC): boolean {
  const norm = (p: string) => {
    const s = p.replace(/\\/g, "/").replace(/\/+$/, "");
    return ignoreCase ? s.toLowerCase() : s;
  };
  const p = norm(path);
  const t = norm(target);
  return p === t || p.startsWith(t + "/");
}
