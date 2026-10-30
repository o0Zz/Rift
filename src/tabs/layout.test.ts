import { describe, expect, it } from "vitest";
import { displayTitle, folderName, moveGroup, moveTab, ownRowColor, shouldNotify, visualOrder, type Group } from "./layout";

const g = (id: string, collapsed = false): Group => ({ id, name: id, collapsed });
const t = (name: string, group?: string) => ({ name, group });
const names = (list: { name: string }[]) => list.map((x) => x.name);

describe("visualOrder", () => {
  it("lists groups in order with their tabs, then ungrouped tabs", () => {
    const tabs = [t("a"), t("b", "G2"), t("c", "G1"), t("d"), t("e", "G2")];
    expect(names(visualOrder(tabs, [g("G1"), g("G2")]))).toEqual(["c", "b", "e", "a", "d"]);
  });

  it("treats tabs of a deleted group as ungrouped", () => {
    expect(names(visualOrder([t("a", "gone"), t("b")], []))).toEqual(["a", "b"]);
  });
});

describe("moveTab", () => {
  it("drops before a tab and joins its group", () => {
    const [a, b, c] = [t("a"), t("b", "G"), t("c", "G")];
    const r = moveTab([a, b, c], a, { before: c });
    expect(names(r.tabs)).toEqual(["b", "a", "c"]);
    expect(r.group).toBe("G");
  });

  it("drops at the end of a group or ungrouped", () => {
    const [a, b] = [t("a", "G"), t("b")];
    expect(moveTab([a, b], a, { group: undefined })).toEqual({ tabs: [b, a], group: undefined });
    expect(moveTab([a, b], b, { group: "G" })).toEqual({ tabs: [a, b], group: "G" });
  });

  it("dropping a tab on itself changes nothing", () => {
    const [a, b] = [t("a", "G"), t("b")];
    expect(moveTab([a, b], a, { before: a })).toEqual({ tabs: [a, b], group: "G" });
  });
});

describe("moveGroup", () => {
  it("moves before another group or to the end", () => {
    const gs = [g("A"), g("B"), g("C")];
    expect(moveGroup(gs, "C", "A").map((x) => x.id)).toEqual(["C", "A", "B"]);
    expect(moveGroup(gs, "A").map((x) => x.id)).toEqual(["B", "C", "A"]);
    expect(moveGroup(gs, "B", "B")).toBe(gs);
  });
});

describe("displayTitle", () => {
  it("prefers the user's name, then the agent's title, then the folder", () => {
    expect(displayTitle({ name: "api", title: "x", cwd: "C:\\a" })).toBe("api");
    expect(displayTitle({ title: "✳ Fix login", cwd: "C:\\repo", status: "working" })).toBe("✳ Fix login");
    expect(displayTitle({ title: "C:\\Program Files\\PowerShell\\7\\pwsh.exe", cwd: "C:\\Dev\\rift\\" })).toBe("rift");
    expect(displayTitle({ title: "shell" })).toBe("shell");
  });

  it("ignores the shell's exe path as title, even with an agent", () => {
    const pwsh = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
    expect(displayTitle({ title: pwsh, cwd: "C:\\repo", status: "working" })).toBe("repo");
    expect(displayTitle({ title: pwsh })).toBe("shell");
  });

  it("names drive roots", () => {
    expect(folderName("C:\\")).toBe("C:");
  });
});

describe("shouldNotify", () => {
  it("notifies done/blocked only when the tab is not in front", () => {
    expect(shouldNotify("done", false)).toBe(true);
    expect(shouldNotify("blocked", false)).toBe(true);
    expect(shouldNotify("done", true)).toBe(false);
    expect(shouldNotify("working", false)).toBe(false);
    expect(shouldNotify(undefined, false)).toBe(false);
  });
});

describe("ownRowColor", () => {
  it("lets a colored group override the tab color", () => {
    expect(ownRowColor("#red", "#blue")).toBeUndefined();
    expect(ownRowColor(undefined, "#blue")).toBeUndefined();
  });

  it("shows the tab color outside a group or in a colorless group", () => {
    expect(ownRowColor("#red", undefined)).toBe("#red");
    expect(ownRowColor(undefined, undefined)).toBeUndefined();
  });
});
