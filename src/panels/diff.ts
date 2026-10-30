/** Class of a unified-diff line, for coloring. */
export function diffLineClass(line: string): string {
  if (line.startsWith("@@")) return "hunk";
  if (/^(diff |index |--- |\+\+\+ |new file|deleted file|similarity|rename )/.test(line)) return "meta";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "";
}

export type Change = { path: string; status: string; orig?: string };

/** `(path, untracked)` pairs for the backend; a rename also commits its old path. */
export function commitFiles(changes: Change[]): [string, boolean][] {
  return changes.flatMap((c) => [
    [c.path, c.status === "?"] as [string, boolean],
    ...(c.orig ? [[c.orig, false] as [string, boolean]] : []),
  ]);
}
