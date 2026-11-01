import { describe, expect, it } from "vitest";
import { DEFAULT_DOCKS, isShown, mergeDocks, move, sideOf, toggle } from "./docks";

describe("docks", () => {
  it("toggles a panel: shows it in its dock, closes the dock when it is the one shown", () => {
    let d = toggle(DEFAULT_DOCKS, "prompts");
    expect(d.right.shown).toBe("prompts");
    d = toggle(d, "git"); // same dock: switches tab
    expect(d.right.shown).toBe("git");
    expect(isShown(d, "prompts")).toBe(false);
    d = toggle(d, "git");
    expect(d.right.shown).toBeUndefined();
  });

  it("moves a panel to another dock and shows it there", () => {
    const open = { ...DEFAULT_DOCKS, right: { ...DEFAULT_DOCKS.right, shown: "prompts" as const } };
    const d = move(open, "prompts", "bottom");
    expect(sideOf(d, "prompts")).toBe("bottom");
    expect(d.bottom).toMatchObject({ panels: ["terminal", "prompts"], shown: "prompts" });
    // The dock it left stays open on its other panel.
    expect(d.right).toMatchObject({ panels: ["git"], shown: "git" });
    // A closed dock stays closed; the last panel leaving empties it.
    const e = move(move(DEFAULT_DOCKS, "git", "left"), "prompts", "left");
    expect(e.right).toMatchObject({ panels: [], shown: undefined });
    expect(e.left.panels).toEqual(["explorer", "git", "prompts"]);
    expect(move(d, "git", "right")).toBe(d);
  });

  it("repairs any saved shape: every panel once, unknown ones dropped", () => {
    expect(mergeDocks(undefined)).toEqual(DEFAULT_DOCKS);
    expect(mergeDocks("junk")).toEqual(DEFAULT_DOCKS);
    const d = mergeDocks({
      left: { panels: ["prompts", "nope", "prompts"], shown: "prompts", size: 300 },
      bottom: { panels: [], shown: "git", size: -1 },
    });
    expect(d.left).toEqual({ panels: ["prompts", "explorer"], shown: "prompts", size: 300 });
    expect(d.right.panels).toEqual(["git"]);
    expect(d.bottom).toEqual({ panels: ["terminal"], size: 240 });
  });

  it("keeps what was open before docks existed", () => {
    const d = mergeDocks(undefined, { panels: { explorer: true, prompts: true }, widths: { explorer: 200, git: 500 } });
    expect(d.left).toMatchObject({ shown: "explorer", size: 200 });
    expect(d.right).toMatchObject({ shown: "prompts", size: 500 });
  });
});
