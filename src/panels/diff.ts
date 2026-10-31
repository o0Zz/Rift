/** Class of a unified-diff line, for coloring. */
export function diffLineClass(line: string): string {
  if (line.startsWith("@@")) return "hunk";
  if (/^(diff |index |--- |\+\+\+ |new file|deleted file|similarity|rename )/.test(line)) return "meta";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "";
}

export type Change = { path: string; status: string; orig?: string };

/** Checked files after a reload: unchecked ones stay unchecked, new ones come checked. */
export function keepChecked(checked: Set<string>, before: Change[], after: Change[]): Set<string> {
  const known = new Set(before.map((c) => c.path));
  return new Set(after.map((c) => c.path).filter((p) => checked.has(p) || !known.has(p)));
}

/** `(path, untracked)` pairs for the backend; a rename also commits its old path. */
export function commitFiles(changes: Change[]): [string, boolean][] {
  return changes.flatMap((c) => [
    [c.path, c.status === "?"] as [string, boolean],
    ...(c.orig ? [[c.orig, false] as [string, boolean]] : []),
  ]);
}
