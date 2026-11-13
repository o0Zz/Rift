import { createEffect, createMemo, createSignal, For, Show, onMount, type JSX } from "solid-js";
import { displayTitle, filteredTabs, matchesFilter, ownRowColor, sidebarItems, type Agent, type Group, type Spot, type TabFilter } from "./layout";
import { createMenu } from "../ui/Menu";
import { Tab } from "./Tab";
import { TabIcon } from "./icons";
import { Icon } from "../ui/Icon";
import { GitStatsView } from "./GitStats";
import type { Tally } from "../messages/bus";
import { CONTEXT_WARN } from "./usage";

type SidebarProps = {
  tabs: Tab[];
  groups: Group[];
  active?: Tab;
  onActivate(tab: Tab): void;
  onClose(tab: Tab): void;
  onNewTab(shell?: string): void;
  /** Installed shells, for "New tab with…" (right-click on +). */
  shells: { id: string; name: string }[];
  onMoveTab(tab: Tab, spot: Spot<Tab>): void;
  onMoveGroup(id: string, spot: Spot<Tab>): void;
  onNewGroup(tab: Tab): void;
  onUpdateGroup(id: string, patch: Partial<Group>): void;
  onDeleteGroup(id: string): void;
  onCloseGroup(id: string): void;
  filesShown: boolean;
  onToggleFiles(): void;
  onOpenSettings(): void;
  /** Sidebar filter: all tabs, those that need the user, or those whose agent is working. */
  filter: TabFilter;
  onFilter(filter: TabFilter): void;
  /** Agents used on this machine, offered for a new worktree. */
  agents: Agent[];
  onNewWorktree(tab: Tab, agent: Agent): void;
  /** Gives the keyboard back to the active terminal. */
  onFocusTerminal(): void;
  /** Agent messages the tab sent and received since the user last left it, and those waiting for it. */
  messages(tab: Tab): Tally;
  /** Set to start renaming a tab (F2); a new object each time. */
  rename?: { tab: Tab };
};

type Dragged = { tab: Tab } | { group: string };
/** Where a drop would land, and the line that shows it: above/below a row or header, or below a whole group. */
type Hint = { spot: Spot<Tab>; at?: Tab | Group; edge?: "top" | "bottom" | "block" };

export function Sidebar(props: SidebarProps) {
  // After a keyboard choice in a menu, the keyboard goes back to the terminal.
  const menu = createMenu(() => requestAnimationFrame(() => props.onFocusTerminal()));
  const [editing, setEditing] = createSignal<Tab | Group>();
  const [dragged, setDragged] = createSignal<Dragged>();
  const [hint, setHint] = createSignal<Hint>();
  createEffect(() => {
    const r = props.rename;
    if (r) setEditing(r.tab);
  });

  const groupOf = (tab: Tab) => props.groups.find((g) => g.id === tab.group);
  // Groups and ungrouped tabs in sidebar order, ordered once per change. While filtering, empty groups hide and
  // the active tab stays.
  const items = createMemo(() =>
    // Unfiltered, the active tab is not read: a switch recomputes nothing.
    sidebarItems(props.filter === "all" ? props.tabs : filteredTabs(props.tabs, props.filter, props.active), props.groups).filter((i) => "tab" in i || props.filter === "all" || i.tabs.length > 0),
  );
  // Rows keyed by their tab or group object: a move never rebuilds them.
  const keys = createMemo(() => items().map((i) => ("tab" in i ? i.tab : i.group)));
  const inGroup = (g: Group): Tab[] => {
    const item = items().find((i) => "group" in i && i.group === g);
    return item && "tabs" in item ? item.tabs : [];
  };
  const count = (f: TabFilter) => props.tabs.filter((t) => matchesFilter(t, f)).length;
  const filters: [TabFilter, string][] = [
    ["all", "All"],
    ["attention", "Needs me"],
    ["working", "Working"],
  ];

  function tabMenu(e: MouseEvent, tab: Tab) {
    menu.open(e, [
      { label: "Rename", run: () => setEditing(tab) },
      { colors: (c) => (tab.color = c) },
      "separator",
      ...(tab.root
        ? props.agents.map((agent) => ({
            label: `New ${agent.name} in a worktree…`,
            run: () => props.onNewWorktree(tab, agent),
          }))
        : []),
      { label: "New group from this tab", run: () => props.onNewGroup(tab) },
      ...props.groups
        .filter((g) => g.id !== tab.group)
        .map((g) => ({ label: `Move to “${g.name}”`, run: () => props.onMoveTab(tab, { end: g.id }) })),
      ...(tab.group ? [{ label: "Remove from group", run: () => props.onMoveTab(tab, { afterGroup: tab.group! }) }] : []),
      "separator",
      { label: "Close tab", run: () => props.onClose(tab) },
    ]);
  }

  function groupMenu(e: MouseEvent, g: Group) {
    const all = props.tabs.filter((t) => t.group === g.id).length;
    menu.open(e, [
      { label: "Rename group", run: () => setEditing(g) },
      { heading: "Color", colors: (c) => props.onUpdateGroup(g.id, { color: c }) },
      { heading: "Background", colors: (c) => props.onUpdateGroup(g.id, { background: c }) },
      "separator",
      { label: "Delete group (keep tabs)", run: () => props.onDeleteGroup(g.id) },
      { label: `Close group and its ${all} tab${all === 1 ? "" : "s"}`, run: () => props.onCloseGroup(g.id) },
    ]);
  }

  // Drag and drop. The upper half of a row drops before it, the lower half after it; a tab joins the group of
  // the tab it lands next to. On a group header: upper half = just above the group (outside it), lower half =
  // a tab's first place in the group, or a group's place after this one. A group never lands inside another.
  function dragStart(e: DragEvent, what: Dragged) {
    e.stopPropagation();
    e.dataTransfer!.effectAllowed = "move";
    e.dataTransfer!.setData("text/plain", "rift-tab");
    setDragged(what);
  }
  const upper = (e: DragEvent) => {
    const r = (e.currentTarget as Element).getBoundingClientRect();
    return e.clientY < r.top + r.height / 2;
  };
  function dragOver(e: DragEvent, where: (d: Dragged) => Hint | undefined) {
    const d = dragged();
    if (!d) return;
    e.stopPropagation();
    const h = where(d);
    setHint(h);
    if (h) e.preventDefault(); // no hint: no drop here
  }
  function drop(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    const d = dragged();
    const h = hint();
    dragEnd();
    if (!d || !h) return;
    if ("tab" in d) props.onMoveTab(d.tab, h.spot);
    else props.onMoveGroup(d.group, h.spot);
  }
  const dragEnd = () => (setDragged(undefined), setHint(undefined));
  const lineAt = (at: Tab | Group, edge: Hint["edge"]) => hint()?.at === at && hint()?.edge === edge;

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
    const rowColor = () => ownRowColor(tab.color, groupOf(tab)?.background);
    return (
      <div
        class="tab-row"
        classList={{
          active: props.active === tab,
          colored: !!rowColor(),
          "drop-before": lineAt(tab, "top"),
          "drop-after": lineAt(tab, "bottom"),
        }}
        style={rowColor() ? { "--tab-color": rowColor() } : {}}
        title={tab.cwd ?? tab.title}
        draggable={editing() !== tab}
        onDragStart={(e) => dragStart(e, { tab })}
        onDragOver={(e) =>
          dragOver(e, (d) => {
            if ("group" in d && groupOf(tab)) return undefined;
            const top = upper(e);
            return { spot: top ? { before: tab } : { after: tab }, at: tab, edge: top ? "top" : "bottom" };
          })
        }
        onDrop={drop}
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
                <GitStatsView stats={tab.stats} />
              </Show>
              <Show when={tab.startedBy}>
                <span class="tab-from" title={`Started by ${tab.startedBy}`}>
                  <Icon name="link" size={11} /> {tab.startedBy}
                </span>
              </Show>
              <Show when={tab.agent && tab.context !== undefined}>
                <span class="tab-ctx" classList={{ high: tab.context! >= CONTEXT_WARN }} title="Context window used">
                  ctx {Math.round(tab.context!)}%
                </span>
              </Show>
              <span class="tab-path">
                <bdo dir="ltr">{tab.cwd}</bdo>
              </span>
            </span>
          </Show>
        </span>
        <Show when={props.messages(tab)} keyed>
          {(m) => (
            <Show when={m.sent || m.received || m.waiting}>
              <span
                class="tab-messages"
                title={`Agent messages since you last left this tab: ${m.sent} sent, ${m.received} received${m.waiting ? ` (${m.waiting} waiting for this agent to be idle)` : ""}`}
              >
                <Show when={m.sent}>
                  <span class="msg-count">
                    <Icon name="sent" size={11} />
                    {m.sent}
                  </span>
                </Show>
                <Show when={m.received || m.waiting}>
                  <span class="msg-count" classList={{ waiting: m.waiting > 0 }}>
                    <Icon name="received" size={11} />
                    {m.received}
                  </span>
                </Show>
              </span>
            </Show>
          )}
        </Show>
        <Show when={tab.unread}>
          <span class="unread" title="New agent activity" />
        </Show>
        <span class="tab-close" onMouseDown={(e) => (e.stopPropagation(), props.onClose(tab))}>
          <Icon name="close" size={12} />
        </span>
      </div>
    );
  }

  function GroupBlock(p: { g: Group }) {
    const g = p.g;
    return (
      <div
        class="group"
        classList={{ colored: !!g.background, "drop-after": lineAt(g, "block") }}
        style={g.background ? { "--group-color": g.background } : {}}
      >
        <div
          class="group-head"
          classList={{ labeled: !!g.color, "drop-before": lineAt(g, "top"), "drop-after": lineAt(g, "bottom") }}
          style={g.color ? { "--label-color": g.color } : {}}
          draggable={editing() !== g}
          onDragStart={(e) => dragStart(e, { group: g.id })}
          onDragOver={(e) =>
            dragOver(e, (d) => {
              if ("group" in d && d.group === g.id) return undefined;
              if (upper(e)) return { spot: { beforeGroup: g.id }, at: g, edge: "top" };
              return "tab" in d
                ? { spot: { start: g.id }, at: g, edge: "bottom" }
                : { spot: { afterGroup: g.id }, at: g, edge: "block" };
            })
          }
          onDrop={drop}
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
    );
  }

  return (
    <aside
      class="sidebar"
      data-zoom="sidebar"
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
            classList={{ on: props.filesShown }}
            onClick={() => props.onToggleFiles()}
            title="Files (Ctrl+Shift+E)"
          >
            <Icon name="folder" />
          </button>
          <button class="icon-btn" onClick={() => props.onOpenSettings()} title="Settings (Ctrl+,)">
            <Icon name="gear" />
          </button>
          <button
            class="icon-btn"
            onClick={() => props.onNewTab()}
            onContextMenu={(e) =>
              menu.open(
                e,
                props.shells.map((s) => ({ label: `New tab: ${s.name}`, run: () => props.onNewTab(s.id) })),
              )
            }
            title="New tab (Ctrl+Shift+T) — right-click to choose the shell"
          >
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
      <div class="sidebar-list" onDragOver={(e) => dragOver(e, () => ({ spot: "bottom" }))} onDrop={drop}>
        <For each={keys()}>{(key) => (key instanceof Tab ? <TabRow tab={key} /> : <GroupBlock g={key} />)}</For>
        <div class="drop-zone" classList={{ active: hint()?.spot === "bottom" }} />
      </div>

      <menu.Menu />
    </aside>
  );

}
