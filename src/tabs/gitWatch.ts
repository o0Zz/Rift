import { createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { GitStats, Tab } from "./Tab";

/**
 * When the git panel reloads and the tabs' git stats refresh: on events (a prompt, an agent, a click), never on
 * a tab switch, a timer or a watcher. `panelShows(root)`: the git panel is open on that repo.
 */
export function createGitWatch(o: { panelShows(root: string): boolean }) {
  // Repos where files may have changed since the git panel loaded them: a prompt came back or an agent
  // moved. Switching tabs reloads the panel only for those, so a switch where nothing happened costs nothing.
  const changed = new Set<string>();
  const [refresh, setRefresh] = createSignal(0); // bumped to reload the git panel in place
  const reload = () => setRefresh(refresh() + 1);

  // Git stats per tab (~80 ms of git in the background): after a prompt or an agent status change,
  // coalesced so that a burst of prompts costs one refresh per tab and 1.5 s.
  const statsPending = new WeakSet<Tab>();
  function stats(tab: Tab) {
    if (statsPending.has(tab)) return;
    statsPending.add(tab);
    setTimeout(async () => {
      statsPending.delete(tab);
      const root = tab.root;
      tab.stats = root ? await invoke<GitStats>("git_stats", { root }).catch(() => undefined) : undefined;
    }, 1500);
  }

  // A command finished in a terminal of the repo (`git pull`, a build, an edit): reload the panel in place.
  // Once per burst of prompts, and only while the panel is open on that repo.
  let promptTimer = 0;
  function promptCameBack(root: string) {
    changed.add(root);
    clearTimeout(promptTimer);
    promptTimer = setTimeout(() => {
      if (o.panelShows(root) && changed.delete(root)) reload();
    }, 300);
  }

  return {
    /** Reloads the git panel when it changes. */
    refresh,
    reload,
    stats,
    promptCameBack,
    /** An agent's status changed in `root`; finished there while the panel shows it: reload now. */
    agentMoved(root: string | undefined, done: boolean) {
      if (!root) return;
      changed.add(root);
      if (done && o.panelShows(root)) {
        changed.delete(root);
        reload();
      }
    },
    /** The panels now show a tab of `root`: another repo loads anyway, the same one only if it changed. */
    panelTabChanged(root: string | undefined, sameRepo: boolean) {
      if (root && changed.delete(root) && sameRepo && o.panelShows(root)) reload();
    },
    /** ⟳ / F5: reload now. */
    reloadNow(root: string | undefined) {
      if (root) changed.delete(root);
      reload();
    },
  };
}
