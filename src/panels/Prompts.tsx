import { createSignal, For, Show } from "solid-js";
import { folderName } from "../tabs/layout";
import { PROMPT_DRAG_TYPE } from "../terminal/TermView";
import { Icon } from "../ui/Icon";
import { PanelHead } from "../ui/Panel";
import { isSaveKey } from "./promptLists";

/**
 * Prompts prepared in advance for the shown tab's repo. Click one to edit it; its ✓ (Apply) pastes it into the
 * active terminal (not sent: Enter stays the user's) and it leaves the list.
 */
export function Prompts(props: {
  repo?: string;
  prompts: string[];
  onAdd(text: string): void;
  onEdit(index: number, text: string): void;
  onRemove(index: number): void;
  /** `to` = the gap it was dropped in (0 = before the first), in the list before the move. */
  onMove(from: number, to: number): void;
  onSend(index: number): void;
  onClose(): void;
}) {
  const [draft, setDraft] = createSignal("");
  const [editing, setEditing] = createSignal<number>();
  // A drag inside the list: the dragged prompt and the gap under the cursor (its line shows there).
  let dragFrom: number | undefined;
  let moved = false;
  const [dropAt, setDropAt] = createSignal<number>();

  /** Over a prompt: the gap above it in its top half, below it in its bottom half. */
  function dragOver(e: DragEvent, index: number) {
    if (dragFrom === undefined) return; // a drag from elsewhere (a file): not ours
    e.preventDefault();
    e.dataTransfer!.dropEffect = "move";
    const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setDropAt(e.clientY < box.top + box.height / 2 ? index : index + 1);
  }

  function drop(e: DragEvent) {
    const to = dropAt();
    if (dragFrom === undefined || to === undefined) return;
    e.preventDefault();
    moved = true;
    props.onMove(dragFrom, to);
    setDropAt(undefined);
  }

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
    <aside class="panel prompts" data-zoom="prompts">
      <PanelHead
        title={`Prompts${props.repo ? ` · ${folderName(props.repo)}` : ""}`}
        tip={props.repo}
        closeTip="Close (Ctrl+Shift+O)"
        onClose={() => props.onClose()}
      />
      <Show when={props.repo} fallback={<div class="tree-note">No folder</div>}>
        <div
          class="prompt-list"
          // Between prompts and below the last one: the gap shown stays, the drop still lands there.
          onDragOver={(e) => dragFrom !== undefined && e.preventDefault()}
          onDrop={drop}
          onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setDropAt(undefined)}
        >
          <Show when={props.prompts.length} fallback={<div class="tree-note">No prompts yet: write one below.</div>}>
            <For each={props.prompts}>
              {(text, i) => (
                <Show
                  when={editing() === i()}
                  fallback={
                    <div
                      class="prompt"
                      classList={{
                        "drop-before": dropAt() === i(),
                        "drop-after": i() === props.prompts.length - 1 && dropAt() === props.prompts.length,
                      }}
                      title="Click to edit, drag up or down to reorder, drag onto the terminal to paste"
                      draggable={true}
                      onDragStart={(e) => {
                        dragFrom = i();
                        moved = false;
                        e.dataTransfer!.setData(PROMPT_DRAG_TYPE, text);
                        e.dataTransfer!.effectAllowed = "copyMove";
                      }}
                      onDragOver={(e) => dragOver(e, i())}
                      onDrop={drop}
                      // Dropped on a terminal: it leaves the list, like the arrow. Dropped in the list: moved.
                      onDragEnd={(e) => {
                        const index = dragFrom;
                        dragFrom = undefined;
                        setDropAt(undefined);
                        if (!moved && index !== undefined && e.dataTransfer?.dropEffect !== "none") props.onRemove(index);
                      }}
                      onClick={() => setEditing(i())}
                    >
                      <button
                        class="icon-btn"
                        title="Apply: paste into the terminal (no Enter)"
                        onClick={(e) => (e.stopPropagation(), props.onSend(i()))}
                      >
                        <Icon name="apply" size={14} />
                      </button>
                      <span class="prompt-text">{text}</span>
                      <span class="prompt-buttons">
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
                      else if (isSaveKey(e)) {
                        e.preventDefault();
                        finishEdit(i(), e.currentTarget.value);
                      }
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
            data-autofocus
            placeholder="New prompt (Enter to add, Shift+Enter for a new line)"
            value={draft()}
            onInput={(e) => setDraft(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (isSaveKey(e)) {
                e.preventDefault();
                add();
              }
            }}
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
