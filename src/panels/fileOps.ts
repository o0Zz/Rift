// File actions of the files panel. Pure: unit-tested in fileOps.test.ts.

import { IS_MAC, IS_WINDOWS } from "../settings/settings";

/** Where a deleted file goes (it is never deleted for good). */
export const TRASH_NAME = IS_WINDOWS ? "Recycle Bin" : "Trash";

/** Delete (Suppr) deletes the selected file; Cmd+Backspace too on macOS, as in Finder. */
export function isDeleteKey(e: { key: string; metaKey: boolean }, mac = IS_MAC): boolean {
  return e.key === "Delete" || (mac && e.metaKey && e.key === "Backspace");
}

/** `path` is `target` or inside it (a deleted folder takes its files with it). */
export function isUnder(path: string, target: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const p = norm(path);
  const t = norm(target);
  return p === t || p.startsWith(t + "/");
}
