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

/** History: a click picks one commit; Shift+click picks the range from that one (the anchor) to here. */
export function pickCommits(picks: string[], hash: string, shift: boolean): string[] {
  const anchor = picks[0];
  return shift && anchor && anchor !== hash ? [anchor, hash] : [hash];
}

/**
 * What to show for the picked commits (`order`: the log, newest first): one commit's changes, or the range
 * `from` (oldest) to `to` (newest), both included; `count` commits.
 */
export function commitRange(
  order: string[],
  picks: string[],
): { from?: string; to: string; count: number } | undefined {
  if (picks.length === 1) return { to: picks[0], count: 1 };
  if (picks.length !== 2) return;
  const [i, j] = picks.map((h) => order.indexOf(h)).sort((a, b) => a - b);
  return { from: order[j], to: order[i], count: j - i + 1 };
}

/** Whether a commit of the log is inside the picked range (highlighted). */
export function inRange(order: string[], picks: string[], hash: string): boolean {
  if (picks.length === 1) return picks[0] === hash;
  const k = order.indexOf(hash);
  const [i, j] = picks.map((h) => order.indexOf(h)).sort((a, b) => a - b);
  return picks.length === 2 && k >= i && k <= j;
}

/** The confirm before Discard: names one file, counts several, says what can and cannot be undone. */
export function discardQuestion(changes: Change[], trash: string): string {
  const what = changes.length === 1 ? changes[0].path : `${changes.length} files`;
  const isNew = (c: Change) => c.status === "?" || c.status === "A";
  const lost = changes.some((c) => !isNew(c));
  const fresh = changes.some(isNew);
  const parts = [
    lost ? "Their changes are lost for good." : "",
    fresh ? `New files go to the ${trash}.` : "",
  ].filter(Boolean);
  return `Discard the changes to ${what}? ${parts.join(" ")}`;
}

/** `(path, untracked)` pairs for the backend; a rename also commits its old path. */
export function commitFiles(changes: Change[]): [string, boolean][] {
  return changes.flatMap((c) => [
    [c.path, c.status === "?"] as [string, boolean],
    ...(c.orig ? [[c.orig, false] as [string, boolean]] : []),
  ]);
}

/** At most one background fetch per repo in this window. */
export const FETCH_EVERY = 5 * 60_000;

/** Whether `root` is due a fetch (`force`: an explicit ⟳); marks it fetched when it is. */
export function fetchDue(last: Map<string, number>, root: string, now: number, force = false): boolean {
  const at = last.get(root);
  if (!force && at !== undefined && now - at < FETCH_EVERY) return false;
  last.set(root, now);
  return true;
}
