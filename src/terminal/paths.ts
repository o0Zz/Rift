/** A path typed into a shell: double-quoted when it holds spaces or shell-special characters. */
export function quotePath(path: string): string {
  return /[\s'"`$&();|<>]/.test(path) ? `"${path.replace(/"/g, '\\"')}"` : path;
}
