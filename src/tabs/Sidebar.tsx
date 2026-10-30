import { createEffect, createSignal, For, Show, onMount, type JSX } from "solid-js";
import { displayTitle, matchesFilter, ownRowColor, visualOrder, type Drop, type Group, type TabFilter } from "./layout";
import { createMenu, type MenuItem } from "../ui/Menu";
import type { Tab } from "./Tab";
import { TabIcon } from "./icons";
import { Icon } from "../ui/Icon";

export type SidebarProps = {
  tabs: Tab[];
  groups: Group[];
  active?: Tab;
  onActivate(tab: Tab): void;
  onClose(tab: Tab): void;
  onNewTab(): void;
  onMoveTab(tab: Tab, drop: Drop<Tab>): void;
  onMoveGroup(id: string, before?: string): void;
  onNewGroup(tab: Tab): void;
  onUpdateGroup(id: string, patch: Partial<Group>): void;
  onDeleteGroup(id: string): void;
  onCloseGroup(id: string): void;
  panels: { explorer: boolean; git: boolean };
  onTogglePanel(panel: "explorer" | "git"): void;
  onOpenSettings(): void;
  /** Sidebar filter: all tabs, those that need the user, or those whose agent is working. */
  filter: TabFilter;
  onFilter(filter: TabFilter): void;
  onNewWorktree(tab: Tab): void;
  /** Gives the keyboard back to the active terminal. */
  onFocusTerminal(): void;
  /** Set to start renaming a tab (F2); a new object each time. */
  rename?: { tab: Tab };
};

type Dragged = { tab: Tab } | { group: string };

export function Sidebar(props: SidebarProps) {
  // After a keyboard choice in a menu, the keyboard goes back to the terminal.
  const menu = createMenu(() => requestAnimationFrame(() => props.onFocusTerminal()));
  createEffect(() => {
    const r = props.rename;
    if (r) setEditing(r.tab);
  });
  const [editing, setEditing] = createSignal<Tab | Group>();
  const [dragged, setDragged] = createSignal<Dragged>();
  const [dropTarget, setDropTarget] = createSignal<unknown>();

  const groupOf = (tab: Tab) => props.groups.find((g) => g.id === tab.group);
  const shown = () => visualOrder(props.tabs, props.groups).filter((t) => matchesFilter(t, props.filter));
  const inGroup = (g: Group) => shown().filter((t) => t.group === g.id);
  const ungrouped = () => shown().filter((t) => !groupOf(t));
  const count = (f: TabFilter) => props.tabs.filter((t) => matchesFilter(t, f)).length;
  const filters: [TabFilter, string][] = [
    ["all", "All"],
    ["attention", "Needs me"],
    ["working", "Working"],
  ];

  const openMenu = (e: MouseEvent, items: MenuItem[]) => menu.open(e, items);

  function tabMenu(e: MouseEvent, tab: Tab) {
    openMenu(e, [
      { label: "Rename", run: () => setEditing(tab) },
      { colors: (c) => (tab.color = c) },
      "separator",
      ...(tab.root ? [{ label: "New Claude in a worktree…", run: () => props.onNewWorktree(tab) }] : []),
      { label: "New group from this tab", run: () => props.onNewGroup(tab) },
      ...props.groups
        .filter((g) => g.id !== tab.group)
        .map((g) => ({ label: `Move to “${g.name}”`, run: () => props.onMoveTab(tab, { group: g.id }) })),
      ...(tab.group ? [{ label: "Remove from group", run: () => props.onMoveTab(tab, { group: undefined }) }] : []),
      "separator",
      { label: "Close tab", run: () => props.onClose(tab) },
    ]);
  }

  function groupMenu(e: MouseEvent, g: Group) {
    openMenu(e, [
      { label: "Rename group", run: () => setEditing(g) },
      { colors: (c) => props.onUpdateGroup(g.id, { color: c }) },
      "separator",
      { label: "Delete group (keep tabs)", run: () => props.onDeleteGroup(g.id) },
      { label: `Close group and its ${inGroup(g).length} tab${inGroup(g).length === 1 ? "" : "s"}`, run: () => props.onCloseGroup(g.id) },
    ]);
  }

  // Drag and drop: tab → before a tab, into a group (header) or ungrouped (empty area); group → before a group.
  function dragStart(e: DragEvent, what: Dragged) {
    e.stopPropagation();
    e.dataTransfer!.effectAllowed = "move";
    e.dataTransfer!.setData("text/plain", "rift-tab");
    setDragged(what);
  }
  function dragOver(e: DragEvent, target: unknown) {
    if (!dragged()) return;
    e.preventDefault();
    e.stopPropagation();
    setDropTarget(target);
  }
  function drop(e: DragEvent, apply: (d: Dragged) => void) {
    e.preventDefault();
    e.stopPropagation();
    const d = dragged();
    setDragged(undefined);
    setDropTarget(undefined);
    if (d) apply(d);
  }
  const dragEnd = () => (setDragged(undefined), setDropTarget(undefined));

  function Rename(p: { value: string; commit(v: string | undefined): void }): JSX.Element {
    let input!: HTMLInputElement;
    onMount(() => (input.focus(), input.select()));
    const done = (v?: string) => (setEditing(undefined), p.commit(v));
    return (
      <input
        ref={input}
        class="rename"
        value={p.value}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") done(input.value.trim() || undefined);
          if (e.key === "Escape") setEditing(undefined);
          if (e.key === "Enter" || e.key === "Escape") requestAnimationFrame(() => props.onFocusTerminal());
        }}
        onBlur={() => editing() && done(input.value.trim() || undefined)}
      />
    );
  }

  function TabRow(p: { tab: Tab }) {
    const tab = p.tab;
    const title = () => displayTitle(tab);
    const rowColor = () => ownRowColor(tab.color, groupOf(tab)?.color);
    return (
      <div
        class="tab-row"
        classList={{ active: props.active === tab, colored: !!rowColor(), "drop-before": dropTarget() === tab }}
        style={rowColor() ? { "--tab-color": rowColor() } : {}}
        title={tab.cwd ?? tab.title}
        draggable={editing() !== tab}
        onDragStart={(e) => dragStart(e, { tab })}
        onDragOver={(e) => "tab" in (dragged() ?? {}) && dragOver(e, tab)}
        onDrop={(e) => drop(e, (d) => "tab" in d && props.onMoveTab(d.tab, { before: tab }))}
        onDragEnd={dragEnd}
        onMouseDown={(e) => (e.button === 1 ? props.onClose(tab) : e.button === 0 && props.onActivate(tab))}
        onDblClick={() => setEditing(tab)}
        onContextMenu={(e) => tabMenu(e, tab)}
      >
        <span class="tab-icon">
          <TabIcon agent={tab.agent} />
          <Show when={tab.status && tab.status !== "idle"}>
            <span class={`badge ${tab.status}`} title={tab.status} />
          </Show>
        </span>
        <span class="tab-text">
          <Show when={editing() === tab} fallback={<span class="tab-title">{title()}</span>}>
            <Rename value={tab.name ?? title()} commit={(v) => (tab.name = v)} />
          </Show>
          <Show when={tab.cwd}>
            <span class="tab-sub">
              <Show when={tab.branch}>
                <span class="tab-branch">
                  <Icon name="branch" size={11} /> {tab.branch}
                </span>
              </Show>
              <span class="tab-path">
                <bdo dir="ltr">{tab.cwd}</bdo>
              </span>
            </span>
          </Show>
        </span>
        <Show when={tab.unread}>
          <span class="unread" title="New agent activity" />
        </Show>
        <span class="tab-close" onMouseDown={(e) => (e.stopPropagation(), props.onClose(tab))}>
          <Icon name="close" size={12} />
        </span>
      </div>
    );
  }

  return (
    <aside
      class="sidebar"
      onContextMenu={(e) => e.preventDefault()}
      // The browser moves focus to the clicked row after mousedown activated the tab: once the click is
      // over, the keyboard goes back to the terminal, unless the click opened an input (rename).
      onClick={() =>
        requestAnimationFrame(() => {
          if (!(document.activeElement instanceof HTMLInputElement)) props.onFocusTerminal();
        })
      }
    >
      <div class="sidebar-head">
        <span>Tabs</span>
        <span class="head-buttons">
          <button
            class="icon-btn"
            classList={{ on: props.panels.explorer }}
            onClick={() => props.onTogglePanel("explorer")}
            title="Files (Ctrl+Shift+E)"
          >
            <Icon name="folder" />
          </button>
          <button
            class="icon-btn"
            classList={{ on: props.panels.git }}
            onClick={() => props.onTogglePanel("git")}
            title="Git changes (Ctrl+Shift+G)"
          >
            <Icon name="branch" />
          </button>
          <button class="icon-btn" onClick={() => props.onOpenSettings()} title="Settings (Ctrl+,)">
            <Icon name="gear" />
          </button>
          <button class="icon-btn" onClick={() => props.onNewTab()} title="New tab (Ctrl+Shift+T)">
            <Icon name="plus" />
          </button>
        </span>
      </div>
      {/* Shown once an agent runs somewhere (or while filtering): the counts are what matter. */}
      <Show when={props.filter !== "all" || props.tabs.some((t) => t.agent)}>
        <div class="filters">
          <For each={filters}>
            {([f, label]) => (
              <button
                class="filter"
                classList={{ on: props.filter === f, hot: f === "attention" && count(f) > 0 }}
                onClick={() => props.onFilter(f)}
              >
                {label}
                <Show when={f !== "all"}>
                  <span class="filter-count">{count(f)}</span>
                </Show>
              </button>
            )}
          </For>
        </div>
      </Show>
      <div
        class="sidebar-list"
        onDragOver={(e) => "tab" in (dragged() ?? {}) && dragOver(e, "ungrouped")}
        onDrop={(e) => drop(e, (d) => "tab" in d && props.onMoveTab(d.tab, { group: undefined }))}
      >
        <For each={props.groups.filter((g) => props.filter === "all" || inGroup(g).length > 0)}>
          {(g) => (
            <div class="group" classList={{ colored: !!g.color }} style={g.color ? { "--group-color": g.color } : {}}>
              <div
                class="group-head"
                classList={{ "drop-into": dropTarget() === g }}
                draggable={editing() !== g}
                onDragStart={(e) => dragStart(e, { group: g.id })}
                onDragOver={(e) => dragOver(e, g)}
                onDrop={(e) =>
                  drop(e, (d) => ("tab" in d ? props.onMoveTab(d.tab, { group: g.id }) : props.onMoveGroup(d.group, g.id)))
                }
                onDragEnd={dragEnd}
                onClick={() => props.onUpdateGroup(g.id, { collapsed: !g.collapsed })}
                onDblClick={(e) => (e.stopPropagation(), setEditing(g))}
                onContextMenu={(e) => groupMenu(e, g)}
              >
                <span class="chev">
                  <Icon name={g.collapsed ? "right" : "down"} size={12} />
                </span>
                <span class="dot" style={{ background: g.color ?? "#777" }} />
                <Show when={editing() === g} fallback={<span class="group-name">{g.name}</span>}>
                  <Rename value={g.name} commit={(v) => v && props.onUpdateGroup(g.id, { name: v })} />
                </Show>
                <span class="count">{inGroup(g).length}</span>
              </div>
              {/* While filtering, matching tabs show even in a collapsed group. */}
              <Show when={!g.collapsed || props.filter !== "all"}>
                <For each={inGroup(g)}>{(tab) => <TabRow tab={tab} />}</For>
              </Show>
            </div>
          )}
        </For>
        <For each={ungrouped()}>{(tab) => <TabRow tab={tab} />}</For>
        <div class="drop-zone" classList={{ active: dropTarget() === "ungrouped" }} />
      </div>

      <menu.Menu />
    </aside>
  );
}
