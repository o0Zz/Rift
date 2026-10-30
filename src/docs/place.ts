/** Same file? Paths compare without case and with either separator (Windows). */
export function sameFile(a: string, b: string) {
  const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase();
  return norm(a) === norm(b);
}

/**
 * Where a file opened in a tab goes: the document already showing it, else (one document at a time) in
 * place of the shown or last document, unless it has unsaved changes, else a new document at the end.
 * `current` = index of the shown document, -1 = the terminal.
 */
export function placeDoc(
  docs: { path: string; dirty: boolean }[],
  current: number,
  path: string,
  single: boolean,
): { index: number; replace: boolean } {
  const open = docs.findIndex((d) => sameFile(d.path, path));
  if (open >= 0) return { index: open, replace: false };
  const target = current >= 0 ? current : docs.length - 1;
  if (single && target >= 0 && !docs[target].dirty) return { index: target, replace: true };
  return { index: docs.length, replace: false };
}

/** The document to show after closing `closed`: the one before it, or the terminal (-1). */
export function afterClose(current: number, closed: number): number {
  if (current > closed) return current - 1;
  if (current < closed) return current;
  return closed - 1;
}
