import { createSignal, For, Show, onCleanup, onMount, type JSX } from "solid-js";
import { COLORS, displayTitle, visualOrder, type Drop, type Group } from "./layout";
import type { Tab } from "./Tab";

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
};

type MenuItem = { label: string; run(): void } | { colors(color: string | undefined): void } | "separator";
type Menu = { x: number; y: number; items: MenuItem[] };
type Dragged = { tab: Tab } | { group: string };

export function Sidebar(props: SidebarProps) {
  const [menu, setMenu] = createSignal<Menu>();
  const [editing, setEditing] = createSignal<Tab | Group>();
  const [dragged, setDragged] = createSignal<Dragged>();
  const [dropTarget, setDropTarget] = createSignal<unknown>();

  const groupOf = (tab: Tab) => props.groups.find((g) => g.id === tab.group);
  const inGroup = (g: Group) => visualOrder(props.tabs, props.groups).filter((t) => t.group === g.id);
  const ungrouped = () => visualOrder(props.tabs, props.groups).filter((t) => !groupOf(t));

  const closeMenu = () => setMenu(undefined);
  onMount(() => {
    const onDown = (e: MouseEvent) => !(e.target as Element).closest(".menu") && closeMenu();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closeMenu();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    onCleanup(() => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    });
  });

  function openMenu(e: MouseEvent, items: MenuItem[]) {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, items });
  }

  function tabMenu(e: MouseEvent, tab: Tab) {
    openMenu(e, [
      { label: "Rename", run: () => setEditing(tab) },
      { colors: (c) => (tab.color = c) },
      "separator",
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
        }}
        onBlur={() => editing() && done(input.value.trim() || undefined)}
      />
    );
  }

  function TabRow(p: { tab: Tab }) {
    const tab = p.tab;
    const title = () => displayTitle(tab);
    return (
      <div
        class="tab-row"
        classList={{ active: props.active === tab, "drop-before": dropTarget() === tab }}
        style={{ "--tab-color": tab.color ?? groupOf(tab)?.color ?? "transparent" }}
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
        <span class="tab-icon" classList={{ agent: !!tab.status }}>
          {tab.status ? "✻" : ">_"}
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
              <bdo dir="ltr">{tab.cwd}</bdo>
            </span>
          </Show>
        </span>
        <Show when={tab.unread}>
          <span class="unread" title="New agent activity" />
        </Show>
        <span class="tab-close" onMouseDown={(e) => (e.stopPropagation(), props.onClose(tab))}>
          ×
        </span>
      </div>
    );
  }

  return (
    <aside class="sidebar" onContextMenu={(e) => e.preventDefault()}>
      <div class="sidebar-head">
        <span>Tabs</span>
        <button class="icon-btn" onClick={() => props.onNewTab()} title="New tab (Ctrl+Shift+T)">
          +
        </button>
      </div>
      <div
        class="sidebar-list"
        onDragOver={(e) => "tab" in (dragged() ?? {}) && dragOver(e, "ungrouped")}
        onDrop={(e) => drop(e, (d) => "tab" in d && props.onMoveTab(d.tab, { group: undefined }))}
      >
        <For each={props.groups}>
          {(g) => (
            <div class="group">
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
                <span class="chev">{g.collapsed ? "▸" : "▾"}</span>
                <span class="dot" style={{ background: g.color ?? "#777" }} />
                <Show when={editing() === g} fallback={<span class="group-name">{g.name}</span>}>
                  <Rename value={g.name} commit={(v) => v && props.onUpdateGroup(g.id, { name: v })} />
                </Show>
                <span class="count">{inGroup(g).length}</span>
              </div>
              <Show when={!g.collapsed}>
                <For each={inGroup(g)}>{(tab) => <TabRow tab={tab} />}</For>
              </Show>
            </div>
          )}
        </For>
        <For each={ungrouped()}>{(tab) => <TabRow tab={tab} />}</For>
        <div class="drop-zone" classList={{ active: dropTarget() === "ungrouped" }} />
      </div>

      <Show when={menu()}>
        {(m) => (
          <div class="menu" style={{ left: `${m().x}px`, top: `${m().y}px` }}>
            <For each={m().items}>
              {(item) =>
                item === "separator" ? (
                  <div class="menu-sep" />
                ) : "colors" in item ? (
                  <div class="menu-colors">
                    <For each={COLORS}>
                      {(c) => <span class="swatch" style={{ background: c }} onClick={() => (item.colors(c), closeMenu())} />}
                    </For>
                    <span class="swatch none" title="No color" onClick={() => (item.colors(undefined), closeMenu())}>
                      ×
                    </span>
                  </div>
                ) : (
                  <div class="menu-item" onClick={() => (closeMenu(), item.run())}>
                    {item.label}
                  </div>
                )
              }
            </For>
          </div>
        )}
      </Show>
    </aside>
  );
}
