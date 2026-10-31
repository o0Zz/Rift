import { createEffect, createSignal, For, on, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { commitFiles as files, diffLineClass, keepChecked, type Change } from "./diff";
import { Icon } from "../ui/Icon";

/**
 * Branch, changed files, per-file diff, and commit of the checked files.
 * Not live: loads when shown, when the shown repo changes, after a commit, on ⟳, or when `refresh` changes
 * (its agent finished).
 */
export function GitPanel(props: {
  root?: string;
  branch?: string;
  refresh?: number;
  onClose(): void;
  onCommitted?(): void;
}) {
  const [changes, setChanges] = createSignal<Change[] | string>();
  const [checked, setChecked] = createSignal(new Set<string>());
  const [selected, setSelected] = createSignal<Change>();
  const [diff, setDiff] = createSignal<string>();
  const [message, setMessage] = createSignal("");
  const [busy, setBusy] = createSignal<"commit" | "generate">();
  const [note, setNote] = createSignal<{ text: string; error?: boolean }>();
  let request = 0; // drops answers for a repo we already left

  const list = () => (Array.isArray(changes()) ? (changes() as Change[]) : []);
  const picked = () => list().filter((c) => checked().has(c.path));

  /** `keep`: same repo, newer state. The list, checks and open diff stay put instead of starting over. */
  async function load(root: string, keep = false) {
    const id = ++request;
    const before = list();
    const open = selected();
    if (!keep) {
      setChanges(undefined);
      setSelected(undefined);
      setDiff(undefined);
    }
    let result: Change[] | string;
    try {
      result = await invoke<Change[]>("git_status", { root });
    } catch (e) {
      result = String(e);
    }
    if (id !== request) return;
    setChanges(result);
    const now = Array.isArray(result) ? result : [];
    setChecked(keep ? keepChecked(checked(), before, now) : new Set(now.map((c) => c.path)));
    if (!keep) return;
    const still = now.find((c) => c.path === open?.path);
    if (still) show(still);
    else {
      setSelected(undefined);
      setDiff(undefined);
    }
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

  function toggle(path: string) {
    const next = new Set(checked());
    if (!next.delete(path)) next.add(path);
    setChecked(next);
  }

  const allChecked = () => list().length > 0 && picked().length === list().length;
  const toggleAll = () => setChecked(new Set(allChecked() ? [] : list().map((c) => c.path)));

  async function generate() {
    setBusy("generate");
    setNote(undefined);
    try {
      setMessage(await invoke<string>("commit_message", { root: props.root, files: files(picked()) }));
    } catch (e) {
      setNote({ text: String(e), error: true });
    } finally {
      setBusy(undefined);
    }
  }

  async function commit() {
    if (!canCommit()) return;
    setBusy("commit");
    setNote(undefined);
    try {
      const summary = await invoke<string>("git_commit", { root: props.root, files: files(picked()), message: message() });
      setMessage("");
      setNote({ text: summary });
      await load(props.root!);
      props.onCommitted?.();
    } catch (e) {
      setNote({ text: String(e), error: true });
    } finally {
      setBusy(undefined);
    }
  }

  const canCommit = () => !busy() && picked().length > 0 && message().trim() !== "";

  createEffect(() => {
    setNote(undefined);
    if (props.root) load(props.root);
  });
  createEffect(on(() => props.refresh, () => props.root && load(props.root, true), { defer: true }));

  return (
    <aside class="panel git">
      <div class="panel-head">
        <span class="panel-title">
          <Show when={props.branch} fallback="Git">
            <span class="branch">
              <Icon name="branch" size={14} /> {props.branch}
            </span>
          </Show>
        </span>
        <span class="head-buttons">
          <Show when={props.root}>
            <button class="icon-btn" title="Refresh" onClick={() => load(props.root!)}>
              <Icon name="refresh" />
            </button>
          </Show>
          <button class="icon-btn" title="Close (Ctrl+Shift+G)" onClick={() => props.onClose()}>
            <Icon name="close" />
          </button>
        </span>
      </div>
      <Show when={props.root} fallback={<div class="tree-note">Not a git repository</div>}>
        <div class="git-files">
          <Show when={changes()} fallback={<div class="tree-note">Loading…</div>}>
            {(c) =>
              typeof c() === "string" ? (
                <div class="tree-note error">{c() as string}</div>
              ) : list().length === 0 ? (
                <div class="tree-note">No changes</div>
              ) : (
                <>
                  <label class="git-file all">
                    <input type="checkbox" checked={allChecked()} onChange={toggleAll} />
                    <span>
                      {picked().length} of {list().length} files selected
                    </span>
                  </label>
                  <For each={list()}>
                    {(change) => (
                      <div class="git-file" classList={{ active: selected()?.path === change.path }} title={change.path}>
                        <input type="checkbox" checked={checked().has(change.path)} onChange={() => toggle(change.path)} />
                        <span class={`git-status s-${change.status === "?" ? "u" : change.status}`}>
                          {change.status === "?" ? "U" : change.status}
                        </span>
                        <span class="git-path" onClick={() => show(change)}>
                          <bdo dir="ltr">{change.path}</bdo>
                        </span>
                      </div>
                    )}
                  </For>
                </>
              )
            }
          </Show>
        </div>
        <div class="diff">
          <Show when={selected()} fallback={<div class="tree-note">Click a file to see its diff</div>}>
            <Show when={diff() !== undefined} fallback={<div class="tree-note">Loading…</div>}>
              <For each={diff()!.split("\n")}>{(line) => <div class={`diff-line ${diffLineClass(line)}`}>{line || " "}</div>}</For>
            </Show>
          </Show>
        </div>
        <div class="commit-box">
          <textarea
            placeholder="Commit message (Ctrl+Enter to commit)"
            value={message()}
            onInput={(e) => setMessage(e.currentTarget.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter" && e.ctrlKey) commit();
            }}
          />
          <div class="commit-actions">
            <button
              disabled={!!busy() || picked().length === 0}
              onClick={generate}
              title="Write the message from the diff of the selected files (Claude)"
            >
              {busy() === "generate" ? "Generating…" : "✨ Generate"}
            </button>
            <button class="primary" disabled={!canCommit()} onClick={commit}>
              {busy() === "commit" ? "Committing…" : `Commit ${picked().length} file${picked().length === 1 ? "" : "s"}`}
            </button>
          </div>
          <Show when={note()}>
            {(n) => <div class="commit-note" classList={{ error: n().error }}>{n().text}</div>}
          </Show>
        </div>
      </Show>
    </aside>
  );
}
