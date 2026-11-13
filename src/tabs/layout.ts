// Pure tab-sidebar logic (order, moves, agent status). No DOM, no Solid: unit-tested in layout.test.ts.

/** `color`: the dot and name; `background`: tints the group's block (and wins over its tabs' own colors). */
export type Group = { id: string; name: string; color?: string; background?: string; collapsed: boolean };

/** A coding agent Rift knows (harness id + display name). */
export type Agent = { id: string; name: string };

/** `interrupted`: the user stopped the agent (Esc, Ctrl+C); shown until the agent moves on. */
export type Status = "idle" | "working" | "done" | "blocked" | "interrupted";

export const COLORS = ["#e5534b", "#f0883e", "#d4a72c", "#57ab5a", "#39c5cf", "#539bf5", "#b083f0", "#e275ad"];

type Placed = { group?: string };

/** A sidebar entry: a group with its tabs, or a tab outside any group. */
export type Item<T> = { group: Group; tabs: T[] } | { tab: T };

/**
 * Sidebar entries. The tab order decides everything: a group stands where its first tab is, so groups and
 * ungrouped tabs mix freely. Empty groups come last. Tabs of an unknown group are ungrouped.
 */
export function sidebarItems<T extends Placed>(tabs: T[], groups: Group[]): Item<T>[] {
  const byId = new Map(groups.map((g) => [g.id, g]));
  const items: Item<T>[] = [];
  const placed = new Set<string>();
  for (const t of tabs) {
    const g = t.group ? byId.get(t.group) : undefined;
    if (!g) items.push({ tab: t });
    else if (!placed.has(g.id)) {
      placed.add(g.id);
      items.push({ group: g, tabs: tabs.filter((x) => x.group === g.id) });
    }
  }
  for (const g of groups) if (!placed.has(g.id)) items.push({ group: g, tabs: [] });
  return items;
}

/** Sidebar order, also used by Ctrl+PgUp/PgDn. */
export function visualOrder<T extends Placed>(tabs: T[], groups: Group[]): T[] {
  return sidebarItems(tabs, groups).flatMap((i) => ("tab" in i ? [i.tab] : i.tabs));
}

/**
 * Where a drag ends: next to a tab (a moved tab joins that tab's group), first or last in a group, just
 * outside a group (ungrouped), or at the bottom of the list (ungrouped).
 */
export type Spot<T> =
  | { before: T }
  | { after: T }
  | { start: string }
  | { end: string }
  | { beforeGroup: string }
  | { afterGroup: string }
  | "bottom";

function insertAt<T extends Placed>(rest: T[], spot: Spot<T>): number {
  if (spot === "bottom") return rest.length;
  if ("before" in spot) return rest.indexOf(spot.before);
  if ("after" in spot) return rest.indexOf(spot.after) + 1;
  const id =
    "start" in spot
      ? spot.start
      : "end" in spot
        ? spot.end
        : "beforeGroup" in spot
          ? spot.beforeGroup
          : spot.afterGroup;
  const first = rest.findIndex((t) => t.group === id);
  if (first < 0) return rest.length; // an empty group shows last
  if ("start" in spot || "beforeGroup" in spot) return first;
  let end = first; // a group's tabs are contiguous in sidebar order
  while (rest[end]?.group === id) end++;
  return end;
}

/** Moves `tab` to `spot`. Returns the new tab order and the tab's new group. */
export function moveTab<T extends Placed>(
  tabs: T[],
  groups: Group[],
  tab: T,
  spot: Spot<T>,
): { tabs: T[]; group: string | undefined } {
  const near =
    spot === "bottom" ? undefined : "before" in spot ? spot.before : "after" in spot ? spot.after : undefined;
  if (near === tab) return { tabs, group: tab.group };
  const rest = visualOrder(tabs, groups).filter((t) => t !== tab);
  rest.splice(insertAt(rest, spot), 0, tab);
  return { tabs: rest, group: near ? groups.find((g) => g.id === near.group)?.id : groupOf(spot) };
}

/** The group a spot that is not next to a tab puts a tab in. */
function groupOf<T>(spot: Spot<T>): string | undefined {
  if (spot === "bottom") return undefined;
  return "start" in spot ? spot.start : "end" in spot ? spot.end : undefined;
}

/** Moves group `id` (all its tabs) to `spot`: next to an ungrouped tab, next to another group, or the bottom. */
export function moveGroup<T extends Placed>(tabs: T[], groups: Group[], id: string, spot: Spot<T>): T[] {
  const order = visualOrder(tabs, groups);
  const block = order.filter((t) => t.group === id);
  const rest = order.filter((t) => t.group !== id);
  if (!block.length) return tabs;
  rest.splice(insertAt(rest, spot), 0, ...block);
  return rest;
}

/**
 * The color a tab's own row shows. A group background always wins: its tabs take it (the group block is
 * tinted, rows stay plain). The tab's own color shows otherwise; it is kept, so it comes back when the tab
 * leaves the tinted group.
 */
export function ownRowColor(tabColor: string | undefined, groupBackground: string | undefined): string | undefined {
  return groupBackground ? undefined : tabColor;
}

/** Title shown in the sidebar: the user's name, else the agent's title (Claude names the conversation), else the folder. */
export function displayTitle(t: { name?: string; title: string; cwd?: string; status?: Status }): string {
  if (t.name) return t.name;
  // The shell sets its own exe path as title: never useful.
  const title = /\.exe$/i.test(t.title) ? "" : t.title;
  if (t.status && title) return title;
  return t.cwd ? folderName(t.cwd) : title || "shell";
}

export function folderName(path: string): string {
  return (
    path
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() || path
  );
}

/**
 * Whether a status change deserves attention (desktop notification + unread dot):
 * only when the user is not already looking at that tab.
 */
export function shouldNotify(status: Status | undefined, tabVisible: boolean): boolean {
  return (status === "done" || status === "blocked") && !tabVisible;
}

/**
 * Esc or Ctrl+C (without a selection to copy) interrupts a working agent or dismisses its question. Agents
 * report no hook for that: the terminal watches the keys.
 */
export function isInterruptKey(
  e: {
    key: string;
    ctrlKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
    metaKey: boolean;
  },
  hasSelection: boolean,
): boolean {
  if (e.altKey || e.shiftKey || e.metaKey) return false;
  if (e.key === "Escape") return !e.ctrlKey;
  return e.ctrlKey && e.key.toLowerCase() === "c" && !hasSelection;
}

export function statusAfterInterrupt(status: Status | undefined): Status | undefined {
  return status === "working" || status === "blocked" ? "interrupted" : status;
}

/**
 * The status an agent's hook brings. A tool that finished (`continued`) only continues a turn: after an
 * interrupt it is a late report (the tool ran before the key) and the agent stays interrupted. A new prompt,
 * the end of a turn or a question move on.
 */
export function statusFromHook(
  current: Status | undefined,
  next: Status | undefined,
  continued: boolean,
): Status | undefined {
  return continued && current === "interrupted" ? current : next;
}

const URGENCY: Record<Status, number> = {
  idle: 1,
  interrupted: 2,
  working: 3,
  done: 4,
  blocked: 5,
};

/**
 * The shell a tab shows in the sidebar (status, agent icon, title): the most urgent of its shells
 * (blocked, then done, then working), else the first.
 */
export function lead<T extends { status?: Status }>(shells: T[]): T {
  const rank = (s: T) => (s.status ? URGENCY[s.status] : 0);
  return shells.reduce((best, s) => (rank(s) > rank(best) ? s : best));
}

/** A tab needs the user: its agent waits for an answer, or finished and the user has not looked yet. */
export function needsAttention(t: { status?: Status; unread: boolean }): boolean {
  return t.status === "blocked" || (t.status === "done" && t.unread);
}

export type TabFilter = "all" | "attention" | "working";

export function matchesFilter(t: { status?: Status; unread: boolean }, filter: TabFilter): boolean {
  if (filter === "attention") return needsAttention(t);
  if (filter === "working") return t.status === "working";
  return true;
}

/** The sidebar's rows under a filter: the active tab always stays (seeing it clears "needs me", it must not vanish). */
export function filteredTabs<T extends { status?: Status; unread: boolean }>(tabs: T[], filter: TabFilter, active?: T): T[] {
  return tabs.filter((t) => t === active || matchesFilter(t, filter));
}

/** The next tab that needs the user after `current`, in sidebar order, wrapping; blocked ones first. */
export function nextNeedingAttention<T extends { status?: Status; unread: boolean }>(
  order: T[],
  current: T | undefined,
): T | undefined {
  const start = current ? order.indexOf(current) : -1;
  const after = [...order.slice(start + 1), ...order.slice(0, start + 1)].filter((t) => t !== current);
  return after.find((t) => t.status === "blocked") ?? after.find(needsAttention);
}
