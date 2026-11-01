import { describe, expect, it } from "vitest";
import { DEFAULT_PANES, groupOf, index, isGroup, isOpen, isShown, mergePanes, move, nextPane, previewBox, remove, setSizes, show, toggle, zoneAt, type Pane } from "./panes";

/** The tree without ids or sizes: [row: ...], [col: ...], groups as their panels ("*" = shown). */
function shape(p: Pane): unknown {
  if (isGroup(p)) return p.panels.map((x) => (x === p.shown ? `*${x}` : x)).join(" ");
  return { [p.dir]: p.children.map(shape) };
}

const open = show(show(DEFAULT_PANES, "explorer"), "git");

describe("panes", () => {
  it("shows and hides a panel; a closed group keeps its place", () => {
    expect(shape(open)).toEqual({ row: ["*explorer", "*main", "*git prompts"] });
    const d = toggle(open, "git");
    expect(isOpen(groupOf(d, "git")!)).toBe(false);
    expect(shape(toggle(d, "prompts"))).toEqual({ row: ["*explorer", "*main", "git *prompts"] });
    expect(isShown(toggle(toggle(d, "git"), "git"), "git")).toBe(false);
  });

  it("splits any pane on any side, the way the user asked: two terminals side by side above a full-width one", () => {
    let d = move(open, "term:1" as never, { pane: "main", at: "bottom" });
    expect(shape(d)).toEqual({ row: ["*explorer", { col: ["*main", "*term:1"] }, "*git prompts"] });
    d = move(d, "term:2" as never, { pane: groupOf(d, "term:1")!.id, at: "right" });
    expect(shape(d)).toEqual({ row: ["*explorer", { col: ["*main", { row: ["*term:1", "*term:2"] }] }, "*git prompts"] });
    // Git across the whole bottom of the window.
    d = move(d, "git", { pane: "root", at: "bottom" });
    expect(shape(d)).toEqual({ col: [{ row: ["*explorer", { col: ["*main", { row: ["*term:1", "*term:2"] }] }, "*prompts"] }, "*git"] });
  });

  it("adds a sibling when the parent already runs that way, sharing the pane's room", () => {
    const d = move(open, "prompts", { pane: "main", at: "left" });
    expect(shape(d)).toEqual({ row: ["*explorer", "*prompts", "*main", "*git"] });
    const root = d as Extract<Pane, { sizes: number[] }>;
    expect(root.sizes).toEqual([240, 450, 450, 440]);
  });

  it("joins a group as a tab, and collapses what a move leaves empty", () => {
    let d = move(open, "explorer", { pane: groupOf(open, "git")!.id, at: "tab" });
    expect(shape(d)).toEqual({ row: ["*main", "git prompts *explorer"] });
    d = move(open, "term:1" as never, { pane: "main", at: "bottom" });
    d = move(d, "term:1" as never, { pane: groupOf(d, "git")!.id, at: "tab" });
    expect(shape(d)).toEqual({ row: ["*explorer", "*main", "git prompts *term:1"] }); // the column of one is gone
    expect(shape(remove(d, "term:1" as never))).toEqual({ row: ["*explorer", "*main", "*git prompts"] });
  });

  it("does nothing when a panel is dropped on its own lone group", () => {
    expect(move(open, "explorer", { pane: groupOf(open, "explorer")!.id, at: "left" })).toBe(open);
  });

  it("resizes one split", () => {
    expect((setSizes(open, "root", [1, 2, 3]) as { sizes: number[] }).sizes).toEqual([1, 2, 3]);
  });

  it("reads where a drop lands: an outer quarter = beside on that side, else a tab (none on the tab's terminal)", () => {
    const box = { left: 0, top: 0, width: 400, height: 400 };
    expect(zoneAt(box, 50, 200, true)).toBe("left");
    expect(zoneAt(box, 380, 200, true)).toBe("right");
    expect(zoneAt(box, 200, 20, true)).toBe("top");
    expect(zoneAt(box, 200, 390, true)).toBe("bottom");
    expect(zoneAt(box, 200, 200, true)).toBe("tab");
    expect(zoneAt(box, 200, 200, false)).toBeUndefined();
    expect(previewBox(box, "bottom")).toEqual({ left: 0, top: 200, width: 400, height: 200 });
    expect(previewBox(box, "right", 0.25)).toEqual({ left: 300, top: 0, width: 100, height: 400 });
    // What the app passes: a DOMRect, whose fields are getters (a spread copies none of them).
    class Rect { get left() { return 0; } get top() { return 0; } get width() { return 400; } get height() { return 400; } }
    expect(previewBox(new Rect(), "top")).toEqual({ left: 0, top: 0, width: 400, height: 200 });
  });

  it("finds the pane to focus with Alt+arrows", () => {
    // [a | b], c below both.
    const boxes = [
      { left: 0, top: 0, width: 100, height: 100 },
      { left: 101, top: 0, width: 100, height: 100 },
      { left: 0, top: 101, width: 201, height: 100 },
    ];
    expect(nextPane(boxes, 0, "right")).toBe(1);
    expect(nextPane(boxes, 1, "left")).toBe(0);
    expect(nextPane(boxes, 1, "down")).toBe(2);
    expect(nextPane(boxes, 2, "up")).toBe(0); // both face it as much: the first
    expect(nextPane(boxes, 0, "left")).toBeUndefined();
  });

  it("repairs any saved tree: every panel once, main always there, unknown and terminals dropped", () => {
    expect(mergePanes(undefined)).toEqual(DEFAULT_PANES);
    expect(mergePanes("junk")).toEqual(DEFAULT_PANES);
    const d = mergePanes({
      dir: "col",
      children: [{ panels: ["main", "git"] }, { dir: "row", children: [{ panels: ["git", "nope", "term:3"], shown: "git" }, { panels: [] }] }],
      sizes: [3, "x"],
    });
    expect(shape(d)).toEqual({ row: ["explorer", { col: ["*main", "*git"] }, "prompts"] }); // missing ones added, closed
    expect((index(d).get(groupOf(d, "git")!.id) as { shown?: string }).shown).toBe("git");
  });

  it("reads the docks layout it replaces", () => {
    const d = mergePanes(undefined, {
      left: { groups: [{ panels: ["prompts"], shown: "prompts" }], size: 300 },
      right: { groups: [{ panels: ["git"], shown: "git" }, { panels: ["explorer"] }], size: 500 },
      bottom: { groups: [], size: 200 },
    });
    expect(shape(d)).toEqual({ row: ["*prompts", "*main", { col: ["*git", "explorer"] }] });
    expect((d as { sizes: number[] }).sizes).toEqual([300, 900, 500]);
  });
});
