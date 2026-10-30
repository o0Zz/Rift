import { createEffect, createSignal, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { createMenu } from "../ui/Menu";
import { folderName } from "../tabs/layout";
import { fileBadge } from "./fileIcons";
import { PATH_DRAG_TYPE } from "../terminal/TermView";

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
export function Explorer(props: { root?: string; onClose(): void }) {
  const [listings, setListings] = createSignal(new Map<string, Entry[] | string>());
  const [expanded, setExpanded] = createSignal(new Set<string>());
  const menu = createMenu();

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

  function fileMenu(e: MouseEvent, path: string) {
    menu.open(e, [
      { label: "Open", run: () => invoke("fs_open", { path }) },
      { label: "Reveal in File Explorer", run: () => invoke("fs_reveal", { path }) },
      { label: "Copy path", run: () => navigator.clipboard.writeText(path) },
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
                      style={{ "padding-left": `${p.depth * 12 + 8}px` }}
                      title={path}
                      draggable={true}
                      onDragStart={(e) => {
                        e.dataTransfer!.setData(PATH_DRAG_TYPE, path);
                        e.dataTransfer!.setData("text/plain", path);
                        e.dataTransfer!.effectAllowed = "copy";
                      }}
                      onClick={() => (entry.dir ? toggle(path) : invoke("fs_open", { path }))}
                      onContextMenu={(e) => fileMenu(e, path)}
                    >
                      <span class="tree-chev">{entry.dir ? (open() ? "▾" : "▸") : ""}</span>
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
    <aside class="panel explorer" onContextMenu={(e) => e.preventDefault()}>
      <div class="panel-head">
        <span class="panel-title" title={props.root}>
          {props.root ? folderName(props.root) : "Files"}
        </span>
        <span class="head-buttons">
          <button class="icon-btn" title="Refresh" onClick={refresh}>
            ⟳
          </button>
          <button class="icon-btn" title="Close (Ctrl+Shift+E)" onClick={() => props.onClose()}>
            ×
          </button>
        </span>
      </div>
      <div class="panel-body">
        <Show when={props.root} fallback={<div class="tree-note">No folder</div>}>
          {(root) => <Folder dir={root()} depth={0} />}
        </Show>
      </div>
      <menu.Menu />
    </aside>
  );
}
