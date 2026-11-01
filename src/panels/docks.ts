// Where the panels sit: three docks (left, right, bottom), each a row of tabs showing one panel at a time.
// One arrangement for the whole window (saved in `layout`). Pure: unit-tested in docks.test.ts.

export const PANELS = ["explorer", "git", "prompts", "terminal"] as const;
export type PanelId = (typeof PANELS)[number];
export const SIDES = ["left", "right", "bottom"] as const;
export type Side = (typeof SIDES)[number];
/** `shown` undefined = the dock is closed. `size` = width (left/right) or height (bottom), in px. */
export type Dock = { panels: PanelId[]; shown?: PanelId; size: number };
export type Docks = Record<Side, Dock>;

export const PANEL_NAMES: Record<PanelId, string> = { explorer: "Files", git: "Git", prompts: "Prompts", terminal: "Terminal" };

export const DEFAULT_DOCKS: Docks = {
  left: { panels: ["explorer"], size: 240 },
  right: { panels: ["git", "prompts"], size: 440 },
  bottom: { panels: ["terminal"], size: 240 },
};

export const sideOf = (docks: Docks, id: PanelId): Side => SIDES.find((s) => docks[s].panels.includes(id))!;
export const isShown = (docks: Docks, id: PanelId) => docks[sideOf(docks, id)].shown === id;

/** Shows the panel in its dock, or closes the dock if that panel is the one shown. */
export function toggle(docks: Docks, id: PanelId): Docks {
  const side = sideOf(docks, id);
  return { ...docks, [side]: { ...docks[side], shown: isShown(docks, id) ? undefined : id } };
}

/** Moves the panel to the end of the `to` dock and shows it there; the dock it left shows its next panel, if any was shown. */
export function move(docks: Docks, id: PanelId, to: Side): Docks {
  const from = sideOf(docks, id);
  if (from === to) return docks;
  const left = docks[from].panels.filter((p) => p !== id);
  const wasShown = docks[from].shown;
  return {
    ...docks,
    [from]: { ...docks[from], panels: left, shown: wasShown && wasShown !== id ? wasShown : wasShown && left[0] },
    [to]: { ...docks[to], panels: [...docks[to].panels, id], shown: id },
  };
}

/**
 * Any saved shape → valid docks: every panel exactly once, unknown ones dropped. Before docks, `layout` had
 * `panels` (open flags) and `widths`: files on the left, git and prompts on the right.
 */
export function mergeDocks(saved: unknown, old?: { panels?: Partial<Record<string, boolean>>; widths?: Partial<Record<string, number>> }): Docks {
  const docks: Docks = {
    left: { ...DEFAULT_DOCKS.left, panels: [] },
    right: { ...DEFAULT_DOCKS.right, panels: [] },
    bottom: { ...DEFAULT_DOCKS.bottom, panels: [] },
  };
  const placed = new Set<PanelId>();
  const isPanel = (p: unknown): p is PanelId => PANELS.includes(p as PanelId) && !placed.has(p as PanelId);
  const s = (saved && typeof saved === "object" ? saved : {}) as Partial<Record<Side, Partial<Dock>>>;
  for (const side of SIDES) {
    const d = s[side];
    if (!d || typeof d !== "object") continue;
    for (const p of Array.isArray(d.panels) ? d.panels : []) if (isPanel(p)) (placed.add(p), docks[side].panels.push(p));
    if (typeof d.size === "number" && d.size > 0) docks[side].size = d.size;
    if (docks[side].panels.includes(d.shown as PanelId)) docks[side].shown = d.shown;
  }
  for (const side of SIDES) for (const p of DEFAULT_DOCKS[side].panels) if (!placed.has(p)) docks[side].panels.push(p);
  if (!saved && old) {
    if (old.widths?.explorer) docks.left.size = old.widths.explorer;
    if (old.widths?.git) docks.right.size = old.widths.git;
    if (old.panels?.explorer) docks.left.shown = "explorer";
    docks.right.shown = old.panels?.git ? "git" : old.panels?.prompts ? "prompts" : undefined;
  }
  return docks;
}
