// Where the panels sit: one tree of splits for the whole window (saved in `layout.panes`), the same for every
// tab. A split lays its children out in a row or a column; a leaf is a group: tabs showing one panel at a time.
// "main" (the tab's own terminal and documents) is one leaf like the others, always there, alone in its group.
// Pure: unit-tested in panes.test.ts.

/** Files, git and prompts always exist; terminals (`term:<n>`) only while their shell runs. */
export const FIXED = ["explorer", "git", "prompts"] as const;
export type PanelId = (typeof FIXED)[number] | `term:${number}` | "main";
export const isTerminal = (id: PanelId): id is `term:${number}` => id.startsWith("term:");
/** `shown` undefined = the group is closed (it keeps its place, the others take its room). */
export type Group = { id: string; panels: PanelId[]; shown?: PanelId };
/** `sizes`: one flex weight per child. */
export type Split = { id: string; dir: "row" | "col"; children: Pane[]; sizes: number[] };
export type Pane = Group | Split;
export type Edge = "left" | "right" | "top" | "bottom";
/** Where a dropped panel goes: beside a pane (`at` an edge of it, "root" = the whole window), or a tab of a group. */
export type Target = { pane: string; at: Edge | "tab" };

export const isGroup = (p: Pane): p is Group => "panels" in p;
export const MAIN = "main"; // id of the group holding the tab's own terminal

export const DEFAULT_PANES: Split = {
  id: "root",
  dir: "row",
  children: [
    { id: "g1", panels: ["explorer"] },
    { id: MAIN, panels: ["main"], shown: "main" },
    { id: "g2", panels: ["git", "prompts"] },
  ],
  sizes: [240, 900, 440],
};

/** Every pane by id. */
export function index(root: Pane, into = new Map<string, Pane>()): Map<string, Pane> {
  into.set(root.id, root);
  if (!isGroup(root)) for (const c of root.children) index(c, into);
  return into;
}

export const groupOf = (root: Pane, id: PanelId): Group | undefined => {
  for (const p of index(root).values()) if (isGroup(p) && p.panels.includes(id)) return p;
};
export const isShown = (root: Pane, id: PanelId) => groupOf(root, id)?.shown === id;
/** A pane takes room when it shows something. */
export const isOpen = (p: Pane): boolean => (isGroup(p) ? !!p.shown : p.children.some(isOpen));

function newId(root: Pane, taken?: string) {
  let n = 1;
  const ids = index(root);
  while (ids.has(`p${n}`) || `p${n}` === taken) n++;
  return `p${n}`;
}

/** Copies the tree with `f` applied to every pane, children first; `f` returning null removes the pane. */
function mapTree(p: Pane, f: (p: Pane) => Pane | null): Pane | null {
  if (isGroup(p)) return f(p);
  const kept = p.children.map((c, i) => [mapTree(c, f), p.sizes[i]] as const).filter(([c]) => c);
  if (!kept.length) return null;
  if (kept.length === 1) return f(kept[0][0]!); // a split of one is that one
  return f({ ...p, children: kept.map(([c]) => c!), sizes: kept.map(([, s]) => s) });
}

function setGroup(root: Pane, id: PanelId, shown: (g: Group) => PanelId | undefined): Pane {
  return mapTree(root, (p) => (isGroup(p) && p.panels.includes(id) ? { ...p, shown: shown(p) } : p))!;
}
/** Shows the panel in its group, or closes the group if that panel is the one shown. */
export const toggle = (root: Pane, id: PanelId) => setGroup(root, id, (g) => (g.shown === id ? undefined : id));
export const show = (root: Pane, id: PanelId) => setGroup(root, id, () => id);

/** Takes the panel out: its group shows the next one if it was shown, and goes away once empty. */
export function remove(root: Pane, id: PanelId): Pane {
  return mapTree(root, (p) => {
    if (!isGroup(p) || !p.panels.includes(id)) return p;
    const rest = p.panels.filter((x) => x !== id);
    return rest.length ? { ...p, panels: rest, shown: p.shown === id ? rest[0] : p.shown } : null;
  })!;
}

/** Puts a panel that is in no group at `to`, shown: a tab of that group, or a new group beside that pane. */
export function insert(root: Pane, id: PanelId, to: Target): Pane {
  if (to.at === "tab")
    return mapTree(root, (p) => (p.id === to.pane && isGroup(p) ? { ...p, panels: [...p.panels, id], shown: id } : p))!;
  const dir = to.at === "left" || to.at === "right" ? "row" : "col";
  const before = to.at === "left" || to.at === "top";
  const group: Group = { id: newId(root), panels: [id], shown: id };
  const target = to.pane === "root" ? root.id : to.pane;
  // Beside a pane whose parent runs the same way: one more child there, taking half of that pane's room.
  const parent = [...index(root).values()].find((p) => !isGroup(p) && p.dir === dir && p.children.some((c) => c.id === target)) as Split | undefined;
  if (parent && to.pane !== "root")
    return mapTree(root, (p) => {
      if (p.id !== parent.id) return p;
      const s = p as Split;
      const i = s.children.findIndex((c) => c.id === target);
      const half = s.sizes[i] / 2;
      const children = [...s.children];
      const sizes = [...s.sizes];
      sizes[i] = half;
      children.splice(before ? i : i + 1, 0, group);
      sizes.splice(before ? i : i + 1, 0, half);
      return { ...s, children, sizes };
    })!;
  // The whole window, along its own direction: a new first or last child, a quarter of the room.
  if (to.pane === "root" && !isGroup(root) && root.dir === dir) {
    const size = root.sizes.reduce((a, b) => a + b, 0) / 3;
    return before
      ? { ...root, children: [group, ...root.children], sizes: [size, ...root.sizes] }
      : { ...root, children: [...root.children, group], sizes: [...root.sizes, size] };
  }
  // Else the pane and the new group share a new split in its place.
  const wrap = (p: Pane): Split => ({
    id: newId(root, group.id),
    dir,
    children: before ? [group, p] : [p, group],
    sizes: to.pane === "root" ? (before ? [1, 3] : [3, 1]) : [1, 1],
  });
  if (target === root.id) return wrap(root);
  return mapTree(root, (p) => (p.id === target ? wrap(p) : p))!;
}

/** Whether dropping panel `id` at `to` leaves it where it is: on its own group, where it is alone. */
export function sameSpot(root: Pane, id: PanelId, to: Target): boolean {
  const from = groupOf(root, id);
  return from?.id === to.pane && from.panels.length === 1;
}

/** Moves a panel; nothing happens when it would land where it is (`sameSpot`). */
export function move(root: Pane, id: PanelId, to: Target): Pane {
  if (sameSpot(root, id, to)) return root;
  const rest = remove(root, id);
  if (to.pane !== "root" && !index(rest).has(to.pane)) return root;
  return insert(rest, id, to);
}

export function setSizes(root: Pane, split: string, sizes: number[]): Pane {
  return mapTree(root, (p) => (p.id === split ? { ...p, sizes } : p))!;
}

export type Box = { left: number; top: number; width: number; height: number };

/**
 * Where a drop at (x, y) on a pane lands: its outer quarter on each side = beside it on that side, else a tab
 * (or undefined where a tab is not allowed: the tab's own terminal).
 */
export function zoneAt(box: Box, x: number, y: number, tabs: boolean): Edge | "tab" | undefined {
  const fx = (x - box.left) / box.width;
  const fy = (y - box.top) / box.height;
  const near = Math.min(fx, 1 - fx, fy, 1 - fy);
  if (near >= 0.25) return tabs ? "tab" : undefined;
  return near === fx ? "left" : near === 1 - fx ? "right" : near === fy ? "top" : "bottom";
}

/** The box a drop beside `box` on `at` would fill (half of it; a quarter of the window for the whole window). */
export function previewBox(box: Box, at: Edge | "tab", share = 0.5): Box {
  const b = { left: box.left, top: box.top, width: box.width, height: box.height }; // not a spread: a DOMRect has getters
  if (at === "left" || at === "right") b.width *= share;
  if (at === "top" || at === "bottom") b.height *= share;
  if (at === "right") b.left += box.width - b.width;
  if (at === "bottom") b.top += box.height - b.height;
  return b;
}

/**
 * The pane to focus from `from` going `dir`: the nearest one on that side that faces it (overlaps it across),
 * the one facing it most on a tie.
 */
export function nextPane(boxes: Box[], from: number, dir: "left" | "right" | "up" | "down"): number | undefined {
  const f = boxes[from];
  const end = (b: Box) => ({ right: b.left + b.width, bottom: b.top + b.height });
  let best: number | undefined;
  let bestGap = Infinity;
  let bestOverlap = 0;
  boxes.forEach((b, i) => {
    if (i === from) return;
    const across = dir === "left" || dir === "right";
    const gap =
      dir === "left" ? f.left - end(b).right : dir === "right" ? b.left - end(f).right : dir === "up" ? f.top - end(b).bottom : b.top - end(f).bottom;
    const overlap = across
      ? Math.min(end(f).bottom, end(b).bottom) - Math.max(f.top, b.top)
      : Math.min(end(f).right, end(b).right) - Math.max(f.left, b.left);
    if (gap < -2 || overlap <= 0) return;
    if (gap < bestGap - 2 || (Math.abs(gap - bestGap) <= 2 && overlap > bestOverlap)) [best, bestGap, bestOverlap] = [i, gap, overlap];
  });
  return best;
}

/**
 * Any saved shape → a valid tree: files, git, prompts and main exactly once, unknown panels and terminals (their
 * shells are not restored) dropped, empty splits gone. No valid tree: the default one.
 */
export function mergePanes(saved: unknown): Pane {
  const placed = new Set<PanelId>();
  let n = 0;
  const read = (v: unknown): Pane | null => {
    if (!v || typeof v !== "object") return null;
    const o = v as Record<string, unknown>;
    const id = typeof o.id === "string" ? o.id : `r${++n}`;
    if (Array.isArray(o.panels)) {
      if (o.panels.includes("main") && !placed.has("main")) {
        placed.add("main");
        return { id: MAIN, panels: ["main"], shown: "main" }; // alone: the others in its group go back to their default place
      }
      const panels: PanelId[] = [];
      for (const p of o.panels) if (FIXED.includes(p) && !placed.has(p)) (placed.add(p), panels.push(p));
      if (!panels.length) return null;
      return { id, panels, shown: panels.includes(o.shown as PanelId) ? (o.shown as PanelId) : undefined };
    }
    if (!Array.isArray(o.children)) return null;
    const sizes = Array.isArray(o.sizes) ? o.sizes : [];
    const kept = o.children
      .map((c, i) => [read(c), typeof sizes[i] === "number" && sizes[i] > 0 ? sizes[i] : 1] as const)
      .filter(([c]) => c);
    if (!kept.length) return null;
    if (kept.length === 1) return kept[0][0];
    return { id, dir: o.dir === "col" ? "col" : "row", children: kept.map(([c]) => c!), sizes: kept.map(([, s]) => s as number) };
  };
  let root = read(saved);
  if (!root || !placed.has("main")) return DEFAULT_PANES;
  // Ids unique (a hand-edited file could repeat one).
  const seen = new Set<string>();
  root = mapTree(root, (p) => {
    if (!seen.has(p.id)) return seen.add(p.id), p;
    const id = `r${++n}`;
    seen.add(id);
    return { ...p, id };
  })!;
  const missing = FIXED.filter((p) => !placed.has(p));
  for (const p of missing) root = insert(root, p, { pane: "root", at: p === "explorer" ? "left" : "right" });
  for (const p of missing) root = setGroup(root, p, () => undefined);
  return root;
}
