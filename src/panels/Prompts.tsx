import { createSignal, For, Show } from "solid-js";
import { folderName } from "../tabs/layout";
import { Icon } from "../ui/Icon";

/**
 * Prompts prepared in advance for the shown tab's repo. Click one: it is pasted into the active terminal
 * (not sent: Enter stays the user's) and leaves the list.
 */
export function Prompts(props: {
  repo?: string;
  prompts: string[];
  onAdd(text: string): void;
  onEdit(index: number, text: string): void;
  onRemove(index: number): void;
  onSend(index: number): void;
  onClose(): void;
}) {
  const [draft, setDraft] = createSignal("");
  const [editing, setEditing] = createSignal<number>();

  function add() {
    if (!draft().trim()) return;
    props.onAdd(draft());
    setDraft("");
  }

  function finishEdit(index: number, text: string) {
    if (editing() !== index) return;
    setEditing(undefined);
    props.onEdit(index, text);
  }

  return (
    <aside class="panel prompts">
      <div class="panel-head">
        <span class="panel-title" title={props.repo}>
          Prompts{props.repo ? ` · ${folderName(props.repo)}` : ""}
        </span>
        <span class="head-buttons">
          <button class="icon-btn" title="Close (Ctrl+Shift+O)" onClick={() => props.onClose()}>
            <Icon name="close" />
          </button>
        </span>
      </div>
      <Show when={props.repo} fallback={<div class="tree-note">No folder</div>}>
        <div class="prompt-list">
          <Show when={props.prompts.length} fallback={<div class="tree-note">No prompts yet: write one below.</div>}>
            <For each={props.prompts}>
              {(text, i) => (
                <Show
                  when={editing() === i()}
                  fallback={
                    <div class="prompt" title="Click to paste into the terminal" onClick={() => props.onSend(i())}>
                      <span class="prompt-text">{text}</span>
                      <span class="prompt-buttons">
                        <button
                          class="icon-btn"
                          title="Edit"
                          onClick={(e) => (e.stopPropagation(), setEditing(i()))}
                        >
                          <Icon name="edit" size={14} />
                        </button>
                        <button
                          class="icon-btn"
                          title="Delete"
                          onClick={(e) => (e.stopPropagation(), props.onRemove(i()))}
                        >
                          <Icon name="close" size={14} />
                        </button>
                      </span>
                    </div>
                  }
                >
                  <textarea
                    class="prompt-edit"
                    ref={(el) => queueMicrotask(() => el.focus())}
                    value={text}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") setEditing(undefined);
                      else if (e.key === "Enter" && e.ctrlKey) finishEdit(i(), e.currentTarget.value);
                    }}
                    onBlur={(e) => finishEdit(i(), e.currentTarget.value)}
                  />
                </Show>
              )}
            </For>
          </Show>
        </div>
        <div class="commit-box">
          <textarea
            placeholder="New prompt (Ctrl+Enter to add)"
            value={draft()}
            onInput={(e) => setDraft(e.currentTarget.value)}
            onKeyDown={(e) => e.key === "Enter" && e.ctrlKey && add()}
          />
          <div class="commit-actions">
            <button class="primary" disabled={!draft().trim()} onClick={add}>
              Add
            </button>
          </div>
        </div>
      </Show>
    </aside>
  );
}
