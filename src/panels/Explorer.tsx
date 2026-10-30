import { createEffect, createSignal, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { createMenu } from "../ui/Menu";
import { folderName } from "../tabs/layout";

type Entry = { name: string; dir: boolean };

const join = (dir: string, name: string) => `${dir.replace(/[\\/]+$/, "")}\\${name}`;

/** File tree of `root`. Each folder is listed once, when first expanded (cached until ⟳). */
export function Explorer(props: { root?: string }) {
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
                      onClick={() => (entry.dir ? toggle(path) : invoke("fs_open", { path }))}
                      onContextMenu={(e) => fileMenu(e, path)}
                    >
                      <span class="tree-chev">{entry.dir ? (open() ? "▾" : "▸") : ""}</span>
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
        <button class="icon-btn" title="Refresh" onClick={refresh}>
          ⟳
        </button>
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
