import { createEffect, createSignal, For, on, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { invoke } from "@tauri-apps/api/core";
import { createMenu, type MenuItem } from "../ui/Menu";
import { folderName } from "../tabs/layout";
import { fileBadge } from "./fileIcons";
import { Icon } from "../ui/Icon";
import { Loaded, PanelHead } from "../ui/Panel";
import { PATH_DRAG_TYPE } from "../terminal/TermView";
import { PromptDialog } from "../ui/PromptDialog";
import { clipboardKey, FILE_MANAGER, isDeleteKey, isUnder, joinPath as join, parentDir, TRASH_NAME, typeAhead, visibleRows, type Entry } from "./fileOps";

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

/**
 * File tree of the tab's repo (or folder). Each folder is listed once, when first expanded (cached until ⟳).
 * A click opens a file in the tab (`onOpenFile`), a double-click in the external editor (`onEditFile`); a click
 * selects it: focus stays here, so Delete moves it to the trash and F2 renames it (`onDeleted` closes its documents either way). Keys as in
 * File Explorer: arrows move the selection (Right/Left open/close a folder), Enter opens, typing a name selects it.
 */
export function Explorer(props: {
  root?: string;
  refresh?: number;
  onOpenFile(path: string): void;
  /** In the external editor (double-click). */
  onEditFile(path: string): void;
  onDeleted(path: string): void;
  /** Its git history; only in a repo. */
  onHistory?(path: string): void;
  /** Show this folder instead (".." or "Set as root"); undefined = back to the terminal's folder. */
  onRoot(dir: string | undefined): void;
  /** The root was picked by hand: offers the way back. */
  picked?: boolean;
  /** The tab's git panel follows this folder's repo. */
  onUseForGit(dir: string): void;
  onClose(): void;
}) {
  const [listings, setListings] = createSignal(new Map<string, Entry[] | string>());
  const [expanded, setExpanded] = createSignal(new Set<string>());
  const [selected, setSelected] = createSignal<{ path: string; parent: string }>();
  const menu = createMenu();
  let body!: HTMLDivElement;

  async function load(dir: string) {
    const result = await invoke<Entry[]>("fs_list", { dir }).catch((e) => String(e));
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
    const name = folderName(path);
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

  /** Lists `dir` again, opened, and selects `path` in it. */
  async function showIn(dir: string, path: string) {
    if (dir !== props.root) setExpanded(new Set(expanded()).add(dir));
    await load(dir);
    select({ path, parent: dir });
  }

  /** Where Ctrl+V pastes: the selected folder, else the selected file's folder, else the root. */
  function pasteDir(): string | undefined {
    const sel = selected();
    if (!sel) return props.root;
    const list = listings().get(sel.parent);
    const dir = Array.isArray(list) && list.some((e) => e.dir && join(sel.parent, e.name) === sel.path);
    return dir ? sel.path : sel.parent;
  }

  /** On the OS clipboard as a file: pastes here or in File Explorer / Finder. */
  const copy = (path: string) => invoke("fs_copy", { paths: [path] }).catch((e) => alert(`Could not copy: ${e}`));

  /** The clipboard's files (copied here or in the file manager), or its image as a PNG. */
  async function paste(dir: string) {
    let made: string[];
    try {
      made = await invoke<string[]>("fs_paste", { dir });
    } catch (e) {
      return alert(`Could not paste: ${e}`);
    }
    if (made.length) await showIn(dir, made[0]);
  }

  const [naming, setNaming] = createSignal<string>();
  async function makeDir(parent: string, name: string) {
    setNaming(undefined);
    try {
      await showIn(parent, await invoke<string>("fs_mkdir", { parent, name }));
    } catch (e) {
      alert(`Could not create ${name}: ${e}`);
    }
    body.focus({ preventScroll: true });
  }

  const [renaming, setRenaming] = createSignal<{ path: string; parent: string }>();
  async function rename(path: string, parent: string, name: string) {
    setRenaming(undefined);
    try {
      const to = await invoke<string>("fs_rename", { path, name });
      setExpanded(new Set([...expanded()].filter((dir) => !isUnder(dir, path))));
      props.onDeleted(path);
      await showIn(parent, to);
    } catch (e) {
      alert(`Could not rename ${folderName(path)}: ${e}`);
    }
    body.focus({ preventScroll: true });
  }

  const folderItems = (dir: string): MenuItem[] => [
    { label: "Paste", icon: "paste", run: () => paste(dir) },
    { label: "New folder…", icon: "newFolder", run: () => setNaming(dir) },
  ];

  // Type to select: letters typed within a second of each other make one name.
  let typed = "";
  let typedAt = 0;

  function select(row: { path: string; parent: string }) {
    setSelected({ path: row.path, parent: row.parent });
    body.querySelector(`[data-path="${CSS.escape(row.path)}"]`)?.scrollIntoView({ block: "nearest" });
  }

  function onKey(e: KeyboardEvent) {
    const sel = selected();
    if (sel && isDeleteKey(e)) {
      e.preventDefault();
      return remove(sel.path, sel.parent);
    }
    if (sel && e.key === "F2" && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
      e.preventDefault();
      return setRenaming(sel);
    }
    const clip = clipboardKey(e);
    if (clip) {
      e.preventDefault();
      if (clip === "copy") return sel && copy(sel.path);
      const dir = pasteDir();
      return dir && paste(dir);
    }
    const root = props.root;
    if (!root || e.ctrlKey || e.altKey || e.metaKey) return;
    const rows = visibleRows(root, listings(), expanded());
    const i = rows.findIndex((r) => r.path === sel?.path);
    const row = rows[i];
    const go = (j: number) => rows.length && select(rows[Math.max(0, Math.min(rows.length - 1, j))]);
    if (e.key === "ArrowDown") go(i + 1);
    else if (e.key === "ArrowUp") go(i < 0 ? 0 : i - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(rows.length - 1);
    else if (e.key === "ArrowRight" && row?.dir) {
      if (!expanded().has(row.path)) toggle(row.path);
      else if (rows[i + 1]?.parent === row.path) go(i + 1);
    } else if (e.key === "ArrowLeft" && row) {
      if (row.dir && expanded().has(row.path)) toggle(row.path);
      else go(rows.findIndex((r) => r.path === row.parent));
    } else if (e.key === "Enter" && row) {
      if (row.dir) toggle(row.path);
      else {
        props.onOpenFile(row.path);
        body.focus({ preventScroll: true });
      }
    } else if (e.key.length === 1 && (e.key !== " " || typed)) {
      typed = e.timeStamp - typedAt < 1000 ? typed + e.key : e.key;
      typedAt = e.timeStamp;
      const j = typeAhead(rows.map((r) => r.name), i, typed);
      if (j >= 0) go(j);
    } else return;
    e.preventDefault();
  }

  /** Opening a folder (`fs_open`) shows it in the OS's file manager. */
  const openInFileManager = (dir: string): MenuItem => ({
    label: `Open in ${FILE_MANAGER}`,
    icon: "external",
    run: () => invoke("fs_open", { path: dir }),
  });

  function fileMenu(e: MouseEvent, path: string, parent: string, dir: boolean) {
    setSelected({ path, parent });
    menu.open(e, [
      ...(dir
        ? [
            openInFileManager(path),
            ...folderItems(path),
            { label: "Set as root", icon: "folder", run: () => props.onRoot(path) } as const,
            { label: "Use for git panel", icon: "branch", run: () => props.onUseForGit(path) } as const,
          ]
        : [
            { label: "Open", icon: "file", run: () => props.onOpenFile(path) },
            { label: "Open in external editor", icon: "edit", run: () => props.onEditFile(path) },
            { label: "Open with default app", icon: "external", run: () => invoke("fs_open", { path }) },
            ...(props.onHistory ? [{ label: "Show history", icon: "history", run: () => props.onHistory!(path) } as const] : []),
          ] satisfies MenuItem[]),
      { label: `Reveal in ${FILE_MANAGER}`, icon: "folder", run: () => invoke("fs_reveal", { path }) },
      { label: "Rename… (F2)", icon: "edit", run: () => setRenaming({ path, parent }) },
      { label: "Copy", icon: "copy", run: () => copy(path) },
      ...(dir ? [] : [{ label: "Paste", icon: "paste", run: () => paste(parent) } as const]),
      { label: "Copy path", icon: "copy", run: () => navigator.clipboard.writeText(path) },
      "separator",
      { label: `Delete (move to ${TRASH_NAME})`, icon: "trash", run: () => remove(path, parent) },
    ]);
  }

  function Folder(p: { dir: string; depth: number }) {
    const entries = () => listings().get(p.dir);
    return (
      <Loaded value={entries()} fallback={<div class="tree-note" style={{ "padding-left": `${p.depth * 12 + 22}px` }}>…</div>}>
        {(list) => (
          <For each={list()}>
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
                    data-path={path}
                    onClick={() => {
                      setSelected({ path, parent: p.dir });
                      if (entry.dir) toggle(path);
                      else props.onOpenFile(path);
                      body.focus({ preventScroll: true });
                    }}
                    onDblClick={() => !entry.dir && props.onEditFile(path)}
                    onContextMenu={(e) => fileMenu(e, path, p.dir, entry.dir)}
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
        )}
      </Loaded>
    );
  }

  return (
    <aside class="panel explorer" data-zoom="files" onContextMenu={(e) => e.preventDefault()}>
      <PanelHead
        title={props.root ? folderName(props.root) : "Files"}
        tip={props.root}
        closeTip="Close (Ctrl+Shift+E)"
        onClose={() => props.onClose()}
      >
        <Show when={props.picked}>
          <button class="icon-btn" title="Back to the terminal's folder" onClick={() => props.onRoot(undefined)}>
            <Icon name="terminal" />
          </button>
        </Show>
        <Show when={props.root}>
          {(root) => (
            <button class="icon-btn" title="New folder" onClick={() => setNaming(root())}>
              <Icon name="newFolder" />
            </button>
          )}
        </Show>
        <button class="icon-btn" title="Refresh" onClick={refresh}>
          <Icon name="refresh" />
        </button>
      </PanelHead>
      <div
        class="panel-body"
        ref={body}
        tabIndex={-1}
        onContextMenu={(e) => {
          const root = props.root;
          if (root && !(e.target as Element).closest(".tree-row")) menu.open(e, [openInFileManager(root), ...folderItems(root)]);
        }}
        onKeyDown={onKey}
      >
        <Show when={props.root} fallback={<div class="tree-note">No folder</div>}>
          {(root) => (
            <>
              <Show when={parentDir(root())}>
                {(up) => (
                  <div class="tree-row" style={{ "padding-left": "8px" }} title={`${up()} (double-click)`} onDblClick={() => props.onRoot(up())}>
                    <span class="tree-chev">
                      <Icon name="up" size={12} />
                    </span>
                    <span class="tree-dir">..</span>
                  </div>
                )}
              </Show>
              <Folder dir={root()} depth={0} />
            </>
          )}
        </Show>
      </div>
      <Show when={renaming()}>
        {(r) => (
          <Portal>
            <PromptDialog
              title={`Rename ${folderName(r().path)}`}
              value={folderName(r().path)}
              confirm="Rename"
              onSubmit={(name) => rename(r().path, r().parent, name)}
              onCancel={() => {
                setRenaming(undefined);
                body.focus({ preventScroll: true });
              }}
            />
          </Portal>
        )}
      </Show>
      <Show when={naming()}>
        {(parent) => (
          <Portal>
            <PromptDialog
              title="New folder"
              placeholder="Folder name"
              hint={`In ${parent()}`}
              confirm="Create"
              onSubmit={(name) => makeDir(parent(), name)}
              onCancel={() => {
                setNaming(undefined);
                body.focus({ preventScroll: true });
              }}
            />
          </Portal>
        )}
      </Show>
      <menu.Menu />
    </aside>
  );
}
