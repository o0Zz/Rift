import { For, Show } from "solid-js";
import { Icon } from "../ui/Icon";
import { GitStatsView } from "./GitStats";
import { displayTitle } from "./layout";
import type { Tab } from "./Tab";
import { limitsLabel, limitsTitle, type Limits } from "./usage";

/**
 * Above the tab's terminal (like Warp): its title, or sub-tabs `Terminal | file × | ...` once it has documents;
 * Edit/Read for a Markdown one; the plan usage; + (new terminal), prompts, and the branch with its changes
 * (opens the git panel). Same height either way: showing sub-tabs never refits the terminal.
 */
export function TopBar(p: {
  tab?: Tab;
  limits: Limits;
  promptsShown: boolean;
  gitShown: boolean;
  onShowDoc(tab: Tab, index: number): void;
  onCloseDoc(tab: Tab, index: number): void;
  onNewTerminal(): void;
  onTogglePrompts(): void;
  onToggleGit(): void;
}) {
  return (
    <div class="topbar">
      <Show when={p.tab?.docs.length ? p.tab : undefined} fallback={<span class="topbar-title">{p.tab ? displayTitle(p.tab) : ""}</span>}>
        {(tab) => (
          <div class="doc-tabs">
            <button class="doc-tab" classList={{ on: tab().current < 0 }} onClick={() => p.onShowDoc(tab(), -1)}>
              Terminal
            </button>
            <For each={tab().docs}>
              {(doc, i) => (
                <div
                  class="doc-tab"
                  classList={{ on: tab().current === i() }}
                  title={doc.path}
                  onClick={() => p.onShowDoc(tab(), i())}
                  onAuxClick={(e) => e.button === 1 && p.onCloseDoc(tab(), i())}
                >
                  <span class="doc-name">{doc.name}</span>
                  <Show when={doc.dirty}>
                    <span class="doc-dirty" title="Unsaved (Ctrl+S)" />
                  </Show>
                  <button class="doc-close" title="Close" onClick={(e) => (e.stopPropagation(), p.onCloseDoc(tab(), i()))}>
                    <Icon name="close" size={10} />
                  </button>
                </div>
              )}
            </For>
          </div>
        )}
      </Show>
      <Show when={p.tab?.docs[p.tab!.current]?.markdown && p.tab!.docs[p.tab!.current]}>
        {(doc) => (
          <button class="doc-mode" onClick={() => doc().toggleEdit()}>
            {doc().editing ? "Read" : "Edit"}
          </button>
        )}
      </Show>
      <Show when={limitsLabel(p.limits)}>
        {(label) => (
          <span class="usage" title={limitsTitle(p.limits)}>
            {label()}
          </span>
        )}
      </Show>
      <button class="icon-btn" onClick={() => p.onNewTerminal()} title="New terminal (Ctrl+Shift+K)">
        <Icon name="plus" />
      </button>
      <button class="icon-btn" classList={{ on: p.promptsShown }} onClick={() => p.onTogglePrompts()} title="Prompts (Ctrl+Shift+O)">
        <Icon name="list" />
      </button>
      <button class="git-button" classList={{ on: p.gitShown }} onClick={() => p.onToggleGit()} title="Git changes (Ctrl+Shift+G)">
        <Icon name="branch" size={14} />
        <span>{p.tab?.branch ?? "Git"}</span>
        <GitStatsView stats={p.tab?.stats} />
      </button>
    </div>
  );
}
