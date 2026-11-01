// Where the panels sit: three docks (left, right, bottom), each split in up to two groups (stacked on the
// sides, side by side at the bottom); a group is a row of tabs showing one panel at a time. One arrangement
// for the whole window (saved in `layout`). Pure: unit-tested in docks.test.ts.

/** Files, git and prompts always exist; terminals (`term:<n>`) only while their shell runs. */
export const FIXED = ["explorer", "git", "prompts"] as const;
export type PanelId = (typeof FIXED)[number] | `term:${number}`;
export const isTerminal = (id: PanelId): id is `term:${number}` => id.startsWith("term:");
export const SIDES = ["left", "right", "bottom"] as const;
export type Side = (typeof SIDES)[number];
/** `shown` undefined = the group is closed. */
export type Group = { panels: PanelId[]; shown?: PanelId };
/** `size` = width (left/right) or height (bottom); `split` = the first group's height (or width), when both show. */
export type Dock = { groups: Group[]; size: number; split?: number };
export type Docks = Record<Side, Dock>;
/** Where a panel goes: a new group at one end of the dock (or that end's group if it has two), or a tab of a group. */
export type Target = { side: Side; at: "start" | "end" | "tab" } | { side: Side; with: PanelId };

const ENDS: Record<Side, [string, string]> = { left: ["top", "bottom"], right: ["top", "bottom"], bottom: ["left", "right"] };
/** "top", "bottom", "left" or "right": what an end of a dock is called. */
export const endName = (side: Side, at: "start" | "end") => ENDS[side][at === "start" ? 0 : 1];

export const DEFAULT_DOCKS: Docks = {
  left: { groups: [{ panels: ["explorer"] }], size: 240 },
  right: { groups: [{ panels: ["git", "prompts"] }], size: 440 },
  bottom: { groups: [], size: 240 },
};

function find(docks: Docks, id: PanelId): [Side, number] {
  for (const side of SIDES) {
    const i = docks[side].groups.findIndex((g) => g.panels.includes(id));
    if (i >= 0) return [side, i];
  }
  throw new Error(`panel ${id} is in no dock`);
}

export const sideOf = (docks: Docks, id: PanelId): Side => find(docks, id)[0];
export const isShown = (docks: Docks, id: PanelId) => {
  const [side, i] = find(docks, id);
  return docks[side].groups[i].shown === id;
};

function setShown(docks: Docks, id: PanelId, shown: (g: Group) => PanelId | undefined): Docks {
  const [side, i] = find(docks, id);
  const groups = docks[side].groups.map((g, j) => (j === i ? { ...g, shown: shown(g) } : g));
  return { ...docks, [side]: { ...docks[side], groups } };
}

/** Shows the panel in its group, or closes the group if that panel is the one shown. */
export const toggle = (docks: Docks, id: PanelId) => setShown(docks, id, (g) => (g.shown === id ? undefined : id));
export const show = (docks: Docks, id: PanelId) => setShown(docks, id, () => id);

/** Takes the panel out. Its group shows the next panel if it was the one shown, and goes away once empty. */
export function remove(docks: Docks, id: PanelId): Docks {
  const [side, i] = find(docks, id);
  const src = docks[side].groups[i];
  const rest = src.panels.filter((p) => p !== id);
  const left = rest.length ? [{ panels: rest, shown: src.shown === id ? rest[0] : src.shown }] : [];
  return { ...docks, [side]: { ...docks[side], groups: docks[side].groups.flatMap((g, j) => (j === i ? left : [g])) } };
}

/** Puts a panel that is in no dock at `to`, shown. */
export function insert(docks: Docks, id: PanelId, to: Target): Docks {
  const gs = docks[to.side].groups;
  const j =
    "with" in to
      ? gs.findIndex((g) => g.panels.includes(to.with))
      : to.at === "tab"
        ? (gs.length ? 0 : -1)
        : gs.length >= 2
          ? (to.at === "start" ? 0 : gs.length - 1)
          : -1;
  const groups =
    j >= 0
      ? gs.map((g, k) => (k === j ? { panels: [...g.panels, id], shown: id } : g))
      : "at" in to && to.at === "start"
        ? [{ panels: [id], shown: id }, ...gs]
        : [...gs, { panels: [id], shown: id }];
  return { ...docks, [to.side]: { ...docks[to.side], groups } };
}

export const move = (docks: Docks, id: PanelId, to: Target) => insert(remove(docks, id), id, to);

/** The "Move to…" menu of a panel: a tab next to each other group, and each free end of each dock. */
export function moveChoices(docks: Docks, id: PanelId, name: (id: PanelId) => string): { label: string; target: Target }[] {
  const choices: { label: string; target: Target }[] = [];
  for (const side of SIDES) {
    const groups = docks[side].groups;
    const remaining = groups.filter((g) => g.panels.some((p) => p !== id)).length;
    for (const g of groups.filter((g) => !g.panels.includes(id))) {
      choices.push({ label: `Move to ${side}, next to ${g.panels.map(name).join(", ")}`, target: { side, with: g.panels[0] } });
    }
    if (remaining === 0 && !groups.some((g) => g.panels.includes(id))) choices.push({ label: `Move to ${side}`, target: { side, at: "end" } });
    else if (remaining === 1) {
      for (const at of ["start", "end"] as const) choices.push({ label: `Move to ${side}, ${endName(side, at)}`, target: { side, at } });
    }
  }
  return choices;
}

/**
 * Any saved shape → valid docks: files, git and prompts exactly once, at most two groups per dock. Terminals
 * are dropped (their shells are not restored). Reads the first docks (one group per dock: `panels`/`shown` on
 * the dock) and, before docks, `layout.panels` (open flags) and `widths`: files on the left, git and prompts on the right.
 */
export function mergeDocks(saved: unknown, old?: { panels?: Partial<Record<string, boolean>>; widths?: Partial<Record<string, number>> }): Docks {
  const docks: Docks = { left: { groups: [], size: 240 }, right: { groups: [], size: 440 }, bottom: { groups: [], size: 240 } };
  const placed = new Set<PanelId>();
  const s = (saved && typeof saved === "object" ? saved : {}) as Record<string, Record<string, unknown> | undefined>;
  for (const side of SIDES) {
    const d = s[side];
    if (!d || typeof d !== "object") continue;
    const groups = (Array.isArray(d.groups) ? d.groups : [d]) as Record<string, unknown>[];
    for (const g of groups) {
      if (!g || typeof g !== "object" || docks[side].groups.length === 2) continue;
      const panels: PanelId[] = [];
      for (const p of Array.isArray(g.panels) ? g.panels : []) if (FIXED.includes(p) && !placed.has(p)) (placed.add(p), panels.push(p));
      if (panels.length) docks[side].groups.push({ panels, shown: panels.includes(g.shown as PanelId) ? (g.shown as PanelId) : undefined });
    }
    if (typeof d.size === "number" && d.size > 0) docks[side].size = d.size;
    if (typeof d.split === "number" && d.split > 0) docks[side].split = d.split;
  }
  for (const side of SIDES) {
    const missing = (DEFAULT_DOCKS[side].groups[0]?.panels ?? []).filter((p) => !placed.has(p));
    if (!missing.length) continue;
    const gs = docks[side].groups;
    if (gs.length) gs[gs.length - 1] = { ...gs[gs.length - 1], panels: [...gs[gs.length - 1].panels, ...missing] };
    else gs.push({ panels: missing });
  }
  if (!saved && old) {
    if (old.widths?.explorer) docks.left.size = old.widths.explorer;
    if (old.widths?.git) docks.right.size = old.widths.git;
    if (old.panels?.explorer) docks.left.groups[0].shown = "explorer";
    docks.right.groups[0].shown = old.panels?.git ? "git" : old.panels?.prompts ? "prompts" : undefined;
  }
  return docks;
}
