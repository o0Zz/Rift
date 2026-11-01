import { describe, expect, it } from "vitest";
import { DEFAULT_DOCKS, insert, isShown, mergeDocks, move, remove, show, sideOf, toggle, type Docks } from "./docks";

const open: Docks = {
  ...DEFAULT_DOCKS,
  right: { ...DEFAULT_DOCKS.right, groups: [{ panels: ["git", "prompts"], shown: "prompts" }] },
  bottom: { ...DEFAULT_DOCKS.bottom, groups: [{ panels: ["term:1"] }] },
};

describe("docks", () => {
  it("toggles a panel: shows it in its group, closes the group when it is the one shown", () => {
    let d = toggle(DEFAULT_DOCKS, "prompts");
    expect(d.right.groups[0].shown).toBe("prompts");
    d = toggle(d, "git"); // same group: switches tab
    expect(isShown(d, "git")).toBe(true);
    expect(isShown(d, "prompts")).toBe(false);
    d = toggle(d, "git");
    expect(d.right.groups[0].shown).toBeUndefined();
    expect(show(d, "prompts").right.groups[0].shown).toBe("prompts");
  });

  it("splits a dock: a panel moved to an end gets its own group, the one it left keeps showing", () => {
    const d = move(open, "prompts", { side: "right", at: "end" });
    expect(d.right.groups).toEqual([
      { panels: ["git"], shown: "git" },
      { panels: ["prompts"], shown: "prompts" },
    ]);
    // Two groups: an end joins that end's group instead of a third one.
    const e = move(d, "explorer", { side: "right", at: "start" });
    expect(e.right.groups[0]).toEqual({ panels: ["git", "explorer"], shown: "explorer" });
    expect(e.left.groups).toEqual([]);
    // Moved to the start of another dock.
    const f = move(d, "prompts", { side: "bottom", at: "start" });
    expect(f.bottom.groups.map((g) => g.panels)).toEqual([["prompts"], ["term:1"]]);
    expect(f.right.groups).toHaveLength(1);
  });

  it("joins a group as a tab", () => {
    const d = move(open, "explorer", { side: "right", with: "git" });
    expect(sideOf(d, "explorer")).toBe("right");
    expect(d.right.groups).toEqual([{ panels: ["git", "prompts", "explorer"], shown: "explorer" }]);
    expect(move(DEFAULT_DOCKS, "git", { side: "left", at: "tab" }).left.groups[0].panels).toEqual(["explorer", "git"]);
    expect(move(move(DEFAULT_DOCKS, "explorer", { side: "right", at: "tab" }), "git", { side: "left", at: "tab" }).left.groups).toEqual([
      { panels: ["git"], shown: "git" },
    ]);
  });

  it("repairs any saved shape: every panel once, at most two groups, unknown ones dropped", () => {
    expect(mergeDocks(undefined)).toEqual(DEFAULT_DOCKS);
    expect(mergeDocks("junk")).toEqual(DEFAULT_DOCKS);
    const d = mergeDocks({
      left: { groups: [{ panels: ["prompts", "nope", "prompts"], shown: "prompts" }, { panels: [] }, { panels: ["git"] }, { panels: ["explorer"] }], size: 300 },
      right: { groups: "x", split: 200 },
      bottom: { groups: [{ panels: ["term:3", "git"], shown: "term:3" }], size: -1 },
    });
    // Empty groups skipped, a third one dropped: its panel goes back to its default dock (left), last group.
    expect(d.left).toEqual({ groups: [{ panels: ["prompts"], shown: "prompts" }, { panels: ["git", "explorer"], shown: undefined }], size: 300 });
    expect(d.right).toEqual({ groups: [], size: 440, split: 200 });
    expect(d.bottom).toEqual({ groups: [], size: 240 }); // terminals are not restored
  });

  it("adds and removes terminals; a group goes away once empty", () => {
    let d = insert(DEFAULT_DOCKS, "term:1", { side: "bottom", at: "tab" });
    expect(d.bottom.groups).toEqual([{ panels: ["term:1"], shown: "term:1" }]);
    d = insert(d, "term:2", { side: "bottom", with: "term:1" });
    expect(d.bottom.groups).toEqual([{ panels: ["term:1", "term:2"], shown: "term:2" }]);
    d = remove(d, "term:2");
    expect(d.bottom.groups).toEqual([{ panels: ["term:1"], shown: "term:1" }]);
    expect(remove(d, "term:1").bottom.groups).toEqual([]);
  });

  it("reads the first docks (one group per dock) and the layout before docks", () => {
    const d = mergeDocks({ right: { panels: ["prompts"], shown: "prompts", size: 380 } });
    expect(d.right).toEqual({ groups: [{ panels: ["prompts", "git"], shown: "prompts" }], size: 380 });
    const e = mergeDocks(undefined, { panels: { explorer: true, prompts: true }, widths: { explorer: 200, git: 500 } });
    expect(e.left).toMatchObject({ groups: [{ shown: "explorer" }], size: 200 });
    expect(e.right).toMatchObject({ groups: [{ shown: "prompts" }], size: 500 });
  });
});
