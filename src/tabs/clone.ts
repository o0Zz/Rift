// "Clone a repository": where a clone goes. Pure: unit-tested in clone.test.ts.

import { joinPath, parentDir } from "../panels/fileOps";

/** The folder git names a clone of `url` (`.../Rift.git` → `Rift`); undefined when the URL has none. */
export function repoName(url: string): string | undefined {
  const last = url.replace(/[\\/]+$/, "").split(/[\\/:]/).pop() ?? "";
  return last.replace(/\.git$/i, "") || undefined;
}

/** Where clones go by default: next to the tab's repo, else in its folder. */
export function cloneBase(tab: { root?: string; cwd?: string }): string | undefined {
  return tab.root ? (parentDir(tab.root) ?? tab.root) : tab.cwd;
}

/**
 * What the clone dialog's `url [folder]` asks for, as `git clone <url> [<folder>]`: the clone goes in `folder`
 * (absolute, or relative to `base`), else in `base`, named after the repository. The new tab opens in `parent`
 * and clones into `name` there. Undefined without a URL or a folder name.
 */
export function clonePlan(input: string, base: string): { url: string; parent: string; name: string } | undefined {
  const [url, ...rest] = input.trim().split(/\s+/);
  if (!url) return undefined;
  const folder = rest.join(" ").replace(/^["']|["']$/g, "");
  if (!folder) {
    const name = repoName(url);
    return name ? { url, parent: base, name } : undefined;
  }
  const full = /^([A-Za-z]:[\\/]|[\\/])/.test(folder) ? folder : joinPath(base, folder);
  const parent = parentDir(full);
  const name = full.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
  return parent && name ? { url, parent, name } : undefined;
}
