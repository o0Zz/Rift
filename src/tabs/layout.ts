// Pure tab-sidebar logic (order, moves, agent status). No DOM, no Solid: unit-tested in layout.test.ts.

export type Group = { id: string; name: string; color?: string; collapsed: boolean };

/** A coding agent Rift knows (harness id + display name). */
export type Agent = { id: string; name: string };

/** `interrupted`: the user stopped the agent (Esc, Ctrl+C); shown until the agent moves on. */
export type Status = "idle" | "working" | "done" | "blocked" | "interrupted";

export const COLORS = ["#e5534b", "#f0883e", "#d4a72c", "#57ab5a", "#39c5cf", "#539bf5", "#b083f0", "#e275ad"];

type Placed = { group?: string };

/** Sidebar order, also used by Ctrl+PgUp/PgDn: each group's tabs (groups in order), then ungrouped tabs. */
export function visualOrder<T extends Placed>(tabs: T[], groups: Group[]): T[] {
  const known = new Set(groups.map((g) => g.id));
  return [
    ...groups.flatMap((g) => tabs.filter((t) => t.group === g.id)),
    ...tabs.filter((t) => !t.group || !known.has(t.group)),
  ];
}

export type Drop<T> = { before: T } | { group: string | undefined };

/**
 * Moves `tab` before another tab (joining that tab's group) or to the end of a group
 * (`undefined` = ungrouped). Returns the new tab order and the moved tab's new group.
 */
export function moveTab<T extends Placed>(tabs: T[], tab: T, drop: Drop<T>): { tabs: T[]; group: string | undefined } {
  const rest = tabs.filter((t) => t !== tab);
  if ("before" in drop) {
    if (drop.before === tab) return { tabs, group: tab.group };
    rest.splice(rest.indexOf(drop.before), 0, tab);
    return { tabs: rest, group: drop.before.group };
  }
  return { tabs: [...rest, tab], group: drop.group };
}

/** Moves group `id` before group `before` (or to the end). */
export function moveGroup(groups: Group[], id: string, before?: string): Group[] {
  const moving = groups.find((g) => g.id === id);
  if (!moving || id === before) return groups;
  const rest = groups.filter((g) => g !== moving);
  const at = before ? rest.findIndex((g) => g.id === before) : -1;
  rest.splice(at < 0 ? rest.length : at, 0, moving);
  return rest;
}

/**
 * The color a tab's own row shows. A colored group always wins: its tabs take the group color (the group
 * block is tinted, rows stay plain). The tab's own color only shows outside a group or in a colorless one;
 * it is kept, so it comes back when the tab leaves the colored group.
 */
export function ownRowColor(tabColor: string | undefined, groupColor: string | undefined): string | undefined {
  return groupColor ? undefined : tabColor;
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
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;
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
  e: { key: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean },
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
export function statusFromHook(current: Status | undefined, next: Status | undefined, continued: boolean): Status | undefined {
  return continued && current === "interrupted" ? current : next;
}

const URGENCY: Record<Status, number> = { idle: 1, interrupted: 2, working: 3, done: 4, blocked: 5 };

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

/** The next tab that needs the user after `current`, in sidebar order, wrapping; blocked ones first. */
export function nextNeedingAttention<T extends { status?: Status; unread: boolean }>(order: T[], current: T | undefined): T | undefined {
  const start = current ? order.indexOf(current) : -1;
  const after = [...order.slice(start + 1), ...order.slice(0, start + 1)].filter((t) => t !== current);
  return after.find((t) => t.status === "blocked") ?? after.find(needsAttention);
}
