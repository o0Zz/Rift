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

/** The folder holding `dir` (the files panel's ".."); undefined at a drive or file system root. */
export function parentDir(dir: string): string | undefined {
  const s = dir.replace(/[\\/]+$/, "");
  const cut = Math.max(s.lastIndexOf("\\"), s.lastIndexOf("/"));
  if (cut < 0) return undefined;
  const parent = s.slice(0, cut);
  if (parent === "") return "/";
  return /^[A-Za-z]:$/.test(parent) ? parent + "\\" : parent;
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

/** Joins with the folder's own separator: `\\` for Windows paths, `/` otherwise. */
export const joinPath = (dir: string, name: string) =>
  `${dir.replace(/[\\/]+$/, "")}${dir.includes("\\") ? "\\" : "/"}${name}`;

export type Entry = { name: string; dir: boolean };
export type Row = Entry & { path: string; parent: string };

/**
 * The rows of the files panel, top to bottom: `root`'s entries, an open folder's entries under it. Only what is
 * listed (`listings`; a string is an error) and open (`expanded`) counts: read on a key press, never kept.
 */
export function visibleRows(root: string, listings: Map<string, Entry[] | string>, expanded: Set<string>): Row[] {
  const rows: Row[] = [];
  const walk = (dir: string) => {
    const list = listings.get(dir);
    if (!Array.isArray(list)) return;
    for (const e of list) {
      const path = joinPath(dir, e.name);
      rows.push({ ...e, path, parent: dir });
      if (e.dir && expanded.has(path)) walk(path);
    }
  };
  walk(root);
  return rows;
}

/**
 * Type to select, as in File Explorer: the row whose name starts with `typed` (any case), searching down from the
 * selected one (`from`, -1 for none) and wrapping. Still matching, the selection stays; the same letter again
 * moves to the next name starting with it. -1 when no name matches.
 */
export function typeAhead(names: string[], from: number, typed: string): number {
  const t = typed.toLowerCase();
  if (!t) return -1;
  const starts = (i: number, p: string) => names[i].toLowerCase().startsWith(p);
  if (t.length > 1 && from >= 0 && starts(from, t)) return from;
  const repeated = [...t].every((c) => c === t[0]);
  const prefix = repeated ? t[0] : t;
  const first = repeated ? from + 1 : Math.max(from, 0);
  for (let i = 0; i < names.length; i++) {
    const j = (first + i) % names.length;
    if (starts(j, prefix)) return j;
  }
  return -1;
}
