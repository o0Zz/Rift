import { createEffect, createSignal, For, on, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { createMenu } from "../ui/Menu";
import { folderName } from "../tabs/layout";
import { fileBadge } from "./fileIcons";
import { Icon } from "../ui/Icon";
import { PATH_DRAG_TYPE } from "../terminal/TermView";
import { isDeleteKey, isUnder, TRASH_NAME } from "./fileOps";

type Entry = { name: string; dir: boolean };

function FileIcon(p: { name: string; dir: boolean; open: boolean }) {
  if (p.dir) {
    return (
      <svg class="file-icon" viewBox="0 0 16 16" width="16" height="16">
        <path
          d={p.open ? "M1.5 4h5l1.5 1.5h6.5v1H4.5L2 13H1.5z M4.5 7h11l-2.5 6.5H2z" : "M1.5 3h5l1.5 1.5h6.5v9h-13z"}
          fill="#dcb67a"
        />
      </svg>
    );
  }
  const badge = fileBadge(p.name);
  return badge ? (
    <span class="file-badge" classList={{ long: badge.label.length > 2 }} style={{ color: badge.color }}>
      {badge.label}
    </span>
  ) : (
    <svg class="file-icon" viewBox="0 0 16 16" width="16" height="16">
      <path d="M3.5 1.5h6l3 3v10h-9z M9.5 1.5v3h3" fill="none" stroke="#8a8a8a" stroke-width="1" />
    </svg>
  );
}

/** Joins with the folder's own separator: `\\` for Windows paths, `/` otherwise. */
const join = (dir: string, name: string) =>
  `${dir.replace(/[\\/]+$/, "")}${dir.includes("\\") ? "\\" : "/"}${name}`;

/** File tree of `root`. Each folder is listed once, when first expanded (cached until ⟳). */
/**
 * Files of the tab's repo (or folder). A click opens a file in the tab (`onOpenFile`), not in another app, and
 * selects it: focus stays here, so Delete moves it to the trash (`onDeleted` closes its documents).
 */
export function Explorer(props: {
  root?: string;
  refresh?: number;
  onOpenFile(path: string): void;
  onDeleted(path: string): void;
  onClose(): void;
}) {
  const [listings, setListings] = createSignal(new Map<string, Entry[] | string>());
  const [expanded, setExpanded] = createSignal(new Set<string>());
  const [selected, setSelected] = createSignal<{ path: string; parent: string }>();
  const menu = createMenu();
  let body!: HTMLDivElement;

  async function load(dir: string) {
    let result: Entry[] | string;
    try {
      result = await invoke<Entry[]>("fs_list", { dir });
    } catch (e) {
      result = String(e);
    }
    setListings(new Map(listings()).set(dir, result));
  }

  createEffect(() => {
    const root = props.root;
    if (root && !listings().has(root)) load(root);
  });

  function toggle(dir: string) {
    const next = new Set(expanded());
    if (next.delete(dir)) return setExpanded(next);
    setExpanded(next.add(dir));
    if (!listings().has(dir)) load(dir);
  }

  function refresh() {
    setListings(new Map());
    const root = props.root;
    if (root) load(root);
    for (const dir of expanded()) load(dir);
  }
  createEffect(on(() => props.refresh, refresh, { defer: true }));

  async function remove(path: string, parent: string) {
    const name = path.split(/[\\/]/).pop();
    if (!confirm(`Move ${name} to the ${TRASH_NAME}?`)) return;
    try {
      await invoke("fs_trash", { path });
    } catch (e) {
      return alert(`Could not delete ${name}: ${e}`);
    }
    setSelected(undefined);
    setExpanded(new Set([...expanded()].filter((dir) => !isUnder(dir, path))));
    load(parent);
    props.onDeleted(path);
  }

  function fileMenu(e: MouseEvent, path: string, parent: string) {
    setSelected({ path, parent });
    menu.open(e, [
      { label: "Open", run: () => props.onOpenFile(path) },
      { label: "Open with default app", run: () => invoke("fs_open", { path }) },
      { label: "Reveal in File Explorer", run: () => invoke("fs_reveal", { path }) },
      { label: "Copy path", run: () => navigator.clipboard.writeText(path) },
      "separator",
      { label: `Delete (move to ${TRASH_NAME})`, run: () => remove(path, parent) },
    ]);
  }

  function Folder(p: { dir: string; depth: number }) {
    const entries = () => listings().get(p.dir);
    return (
      <Show when={entries()} fallback={<div class="tree-note" style={{ "padding-left": `${p.depth * 12 + 22}px` }}>…</div>}>
        {(list) =>
          typeof list() === "string" ? (
            <div class="tree-note error">{list() as string}</div>
          ) : (
            <For each={list() as Entry[]}>
              {(entry) => {
                const path = join(p.dir, entry.name);
                const open = () => expanded().has(path);
                return (
                  <>
                    <div
                      class="tree-row"
                      classList={{ selected: selected()?.path === path }}
                      style={{ "padding-left": `${p.depth * 12 + 8}px` }}
                      title={path}
                      draggable={true}
                      onDragStart={(e) => {
                        e.dataTransfer!.setData(PATH_DRAG_TYPE, path);
                        e.dataTransfer!.setData("text/plain", path);
                        e.dataTransfer!.effectAllowed = "copy";
                      }}
                      onClick={() => {
                        setSelected({ path, parent: p.dir });
                        if (entry.dir) return toggle(path);
                        props.onOpenFile(path);
                        body.focus({ preventScroll: true });
                      }}
                      onContextMenu={(e) => fileMenu(e, path, p.dir)}
                    >
                      <span class="tree-chev">{entry.dir && <Icon name={open() ? "down" : "right"} size={12} />}</span>
                      <FileIcon name={entry.name} dir={entry.dir} open={open()} />
                      <span classList={{ "tree-dir": entry.dir }}>{entry.name}</span>
                    </div>
                    <Show when={entry.dir && open()}>
                      <Folder dir={path} depth={p.depth + 1} />
                    </Show>
                  </>
                );
              }}
            </For>
          )
        }
      </Show>
    );
  }

  return (
    <aside class="panel explorer" data-zoom="files" onContextMenu={(e) => e.preventDefault()}>
      <div class="panel-head">
        <span class="panel-title" title={props.root}>
          {props.root ? folderName(props.root) : "Files"}
        </span>
        <span class="head-buttons">
          <button class="icon-btn" title="Refresh" onClick={refresh}>
            <Icon name="refresh" />
          </button>
          <button class="icon-btn" title="Close (Ctrl+Shift+E)" onClick={() => props.onClose()}>
            <Icon name="close" />
          </button>
        </span>
      </div>
      <div
        class="panel-body"
        ref={body}
        tabIndex={-1}
        onKeyDown={(e) => {
          const sel = selected();
          if (sel && isDeleteKey(e)) {
            e.preventDefault();
            remove(sel.path, sel.parent);
          }
        }}
      >
        <Show when={props.root} fallback={<div class="tree-note">No folder</div>}>
          {(root) => <Folder dir={root()} depth={0} />}
        </Show>
      </div>
      <menu.Menu />
    </aside>
  );
}
