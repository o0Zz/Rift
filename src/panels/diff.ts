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

/** History: a click picks one commit; Ctrl+click adds a second one to compare (or unpicks a picked one). */
export function pickCommits(picks: string[], hash: string, add: boolean): string[] {
  if (!add) return [hash];
  if (picks.includes(hash)) return picks.filter((h) => h !== hash);
  return [...picks.slice(-1), hash];
}

/** What to show for the picked commits: one commit's own changes, or older → newer of two (`order`: newest first). */
export function commitRange(order: string[], picks: string[]): { from?: string; to: string } | undefined {
  if (picks.length === 1) return { to: picks[0] };
  if (picks.length !== 2) return;
  const [a, b] = picks;
  return order.indexOf(a) > order.indexOf(b) ? { from: a, to: b } : { from: b, to: a };
}

/** `(path, untracked)` pairs for the backend; a rename also commits its old path. */
export function commitFiles(changes: Change[]): [string, boolean][] {
  return changes.flatMap((c) => [
    [c.path, c.status === "?"] as [string, boolean],
    ...(c.orig ? [[c.orig, false] as [string, boolean]] : []),
  ]);
}
