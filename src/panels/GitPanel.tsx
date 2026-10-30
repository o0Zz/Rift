import { createEffect, createSignal, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { diffLineClass } from "./diff";

type Change = { path: string; status: string };

/** Branch, changed files and per-file diff of `root`. Not live: loads when shown or on ⟳. */
export function GitPanel(props: { root?: string; branch?: string }) {
  const [changes, setChanges] = createSignal<Change[] | string>();
  const [selected, setSelected] = createSignal<Change>();
  const [diff, setDiff] = createSignal<string>();
  let request = 0; // drops answers for a repo we already left

  async function load(root: string) {
    const id = ++request;
    setChanges(undefined);
    setSelected(undefined);
    setDiff(undefined);
    let result: Change[] | string;
    try {
      result = await invoke<Change[]>("git_status", { root });
    } catch (e) {
      result = String(e);
    }
    if (id === request) setChanges(result);
  }

  async function show(change: Change) {
    const id = ++request;
    setSelected(change);
    setDiff(undefined);
    const text = await invoke<string>("git_diff", {
      root: props.root,
      path: change.path,
      untracked: change.status === "?",
    }).catch((e) => String(e));
    if (id === request) setDiff(text);
  }

  createEffect(() => props.root && load(props.root));

  return (
    <aside class="panel git">
      <div class="panel-head">
        <span class="panel-title">
          <Show when={props.branch} fallback="Git">
            <span class="branch">⎇ {props.branch}</span>
          </Show>
        </span>
        <Show when={props.root}>
          <button class="icon-btn" title="Refresh" onClick={() => load(props.root!)}>
            ⟳
          </button>
        </Show>
      </div>
      <Show when={props.root} fallback={<div class="tree-note">Not a git repository</div>}>
        <div class="git-files">
          <Show when={changes()} fallback={<div class="tree-note">Loading…</div>}>
            {(list) =>
              typeof list() === "string" ? (
                <div class="tree-note error">{list() as string}</div>
              ) : (list() as Change[]).length === 0 ? (
                <div class="tree-note">No changes</div>
              ) : (
                <For each={list() as Change[]}>
                  {(c) => (
                    <div
                      class="git-file"
                      classList={{ active: selected()?.path === c.path }}
                      title={c.path}
                      onClick={() => show(c)}
                    >
                      <span class={`git-status s-${c.status === "?" ? "u" : c.status}`}>{c.status === "?" ? "U" : c.status}</span>
                      <span class="git-path">
                        <bdo dir="ltr">{c.path}</bdo>
                      </span>
                    </div>
                  )}
                </For>
              )
            }
          </Show>
        </div>
        <Show when={selected()}>
          <div class="diff">
            <Show when={diff() !== undefined} fallback={<div class="tree-note">Loading…</div>}>
              <For each={diff()!.split("\n")}>{(line) => <div class={`diff-line ${diffLineClass(line)}`}>{line || " "}</div>}</For>
            </Show>
          </div>
        </Show>
      </Show>
    </aside>
  );
}
