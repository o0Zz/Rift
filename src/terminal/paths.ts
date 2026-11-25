/** A path typed into a shell: double-quoted when it holds spaces or shell-special characters. */
export function quotePath(path: string): string {
  return /[\s'"`$&();|<>]/.test(path) ? `"${path.replace(/"/g, '\\"')}"` : path;
}

/**
 * Windows paths printed in a line (`C:\x\y.ts`, `I:/x`), for Ctrl+click: up to a space or quote, without the
 * punctuation or `:line:col` that follows them. `start` / `end`: string indexes, end exclusive.
 */
export function windowsPaths(line: string): { path: string; start: number; end: number }[] {
  const found = [];
  for (const m of line.matchAll(/(?<![\w])[A-Za-z]:[\\/][^\s"'`<>|*?]*/g)) {
    const path = m[0].replace(/[.,;:)\]}]+$/, "").replace(/(:\d+)+$/, "");
    found.push({ path, start: m.index, end: m.index + path.length });
  }
  return found;
}
