import { describe, expect, it } from "vitest";
import {
  displayTitle,
  folderName,
  filteredTabs,
  matchesFilter,
  moveGroup,
  moveTab,
  lead,
  needsAttention,
  nextNeedingAttention,
  ownRowColor,
  shouldNotify,
  sidebarItems,
  isInterruptKey,
  statusAfterInterrupt,
  statusFromHook,
  visualOrder,
  type Group,
  type Status,
} from "./layout";

const g = (id: string, collapsed = false): Group => ({ id, name: id, collapsed });
const t = (name: string, group?: string) => ({ name, group });
const names = (list: { name: string }[]) => list.map((x) => x.name);

describe("visualOrder", () => {
  it("puts each group where its first tab is, so groups and ungrouped tabs mix", () => {
    const tabs = [t("a"), t("b", "G2"), t("c", "G1"), t("d"), t("e", "G2")];
    expect(names(visualOrder(tabs, [g("G1"), g("G2")]))).toEqual(["a", "b", "e", "c", "d"]);
  });

  it("treats tabs of a deleted group as ungrouped", () => {
    expect(names(visualOrder([t("a", "gone"), t("b")], []))).toEqual(["a", "b"]);
  });

  it("lists empty groups last", () => {
    const items = sidebarItems([t("a", "G1")], [g("G2"), g("G1")]);
    expect(items.map((i) => ("tab" in i ? i.tab.name : i.group.id))).toEqual(["G1", "G2"]);
  });
});

describe("moveTab", () => {
  // Sidebar: x, [G: a, b], y
  const gs = [g("G")];
  const setup = () => [t("x"), t("a", "G"), t("b", "G"), t("y")];

  it("drops before or after a tab and joins its group", () => {
    const [x, a, b, y] = setup();
    expect(moveTab([x, a, b, y], gs, y, { before: b })).toEqual({ tabs: [x, a, y, b], group: "G" });
    expect(moveTab([x, a, b, y], gs, x, { after: b })).toEqual({ tabs: [a, b, x, y], group: "G" });
  });

  it("drops after the last tab of a group, still in the group", () => {
    const [x, a, b, y] = setup();
    expect(moveTab([x, a, b, y], gs, a, { after: b })).toEqual({ tabs: [x, b, a, y], group: "G" });
    expect(moveTab([x, a, b, y], gs, y, { end: "G" })).toEqual({ tabs: [x, a, b, y], group: "G" });
  });

  it("drops a tab between groups, outside both", () => {
    const tabs = [t("a", "A"), t("b", "B"), t("c", "B")];
    const r = moveTab(tabs, [g("A"), g("B")], tabs[2], { beforeGroup: "B" });
    expect(names(r.tabs)).toEqual(["a", "c", "b"]);
    expect(r.group).toBeUndefined();
    tabs[2].group = r.group;
    expect(sidebarItems(r.tabs, [g("A"), g("B")]).map((i) => ("tab" in i ? i.tab.name : i.group.id))).toEqual(["A", "c", "B"]);
  });

  it("drops first in a group, after a group, or at the bottom", () => {
    const [x, a, b, y] = setup();
    expect(moveTab([x, a, b, y], gs, y, { start: "G" })).toEqual({ tabs: [x, y, a, b], group: "G" });
    expect(moveTab([x, a, b, y], gs, a, { afterGroup: "G" })).toEqual({ tabs: [x, b, a, y], group: undefined });
    expect(moveTab([x, a, b, y], gs, a, "bottom")).toEqual({ tabs: [x, b, y, a], group: undefined });
  });

  it("dropping a tab next to itself changes nothing", () => {
    const [x, a, b, y] = setup();
    expect(moveTab([x, a, b, y], gs, a, { before: a })).toEqual({ tabs: [x, a, b, y], group: "G" });
    expect(moveTab([x, a, b, y], gs, a, { after: a })).toEqual({ tabs: [x, a, b, y], group: "G" });
  });
});

describe("moveGroup", () => {
  // Sidebar: [A: a1, a2], x, [B: b]
  const gs = [g("A"), g("B")];
  const setup = () => [t("a1", "A"), t("a2", "A"), t("x"), t("b", "B")];

  it("moves a group with its tabs next to an ungrouped tab", () => {
    const tabs = setup();
    expect(names(moveGroup(tabs, gs, "A", { after: tabs[2] }))).toEqual(["x", "a1", "a2", "b"]);
    expect(names(moveGroup(tabs, gs, "B", { before: tabs[2] }))).toEqual(["a1", "a2", "b", "x"]);
  });

  it("moves a group before or after another group, or to the bottom", () => {
    const tabs = setup();
    expect(names(moveGroup(tabs, gs, "B", { beforeGroup: "A" }))).toEqual(["b", "a1", "a2", "x"]);
    expect(names(moveGroup(tabs, gs, "A", { afterGroup: "B" }))).toEqual(["x", "b", "a1", "a2"]);
    expect(names(moveGroup(tabs, gs, "A", "bottom"))).toEqual(["x", "b", "a1", "a2"]);
  });

  it("leaves an empty group where it is", () => {
    const tabs = setup();
    expect(moveGroup(tabs, [...gs, g("E")], "E", { beforeGroup: "A" })).toBe(tabs);
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
  it("lets a group background override the tab color", () => {
    expect(ownRowColor("#red", "#blue")).toBeUndefined();
    expect(ownRowColor(undefined, "#blue")).toBeUndefined();
  });

  it("shows the tab color outside a group or in a group without background", () => {
    expect(ownRowColor("#red", undefined)).toBe("#red");
    expect(ownRowColor(undefined, undefined)).toBeUndefined();
  });
});

describe("interrupts", () => {
  const key = (key: string, mods: Partial<Record<"ctrlKey" | "altKey" | "shiftKey" | "metaKey", boolean>> = {}) => ({
    key,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ...mods,
  });

  it("takes Esc and Ctrl+C as an interrupt, not a copy or another key", () => {
    expect(isInterruptKey(key("Escape"), false)).toBe(true);
    expect(isInterruptKey(key("Escape"), true)).toBe(true);
    expect(isInterruptKey(key("c", { ctrlKey: true }), false)).toBe(true);
    expect(isInterruptKey(key("C", { ctrlKey: true }), false)).toBe(true); // Caps Lock
    expect(isInterruptKey(key("c", { ctrlKey: true }), true)).toBe(false); // copies the selection
    expect(isInterruptKey(key("c", { ctrlKey: true, shiftKey: true }), false)).toBe(false);
    expect(isInterruptKey(key("c", { metaKey: true }), false)).toBe(false); // Cmd+C copies on macOS
    expect(isInterruptKey(key("c"), false)).toBe(false);
    expect(isInterruptKey(key("Escape", { shiftKey: true }), false)).toBe(false);
    expect(isInterruptKey(key("Escape", { ctrlKey: true }), false)).toBe(false);
  });

  it("marks a working or blocked agent interrupted, leaves the rest", () => {
    expect(statusAfterInterrupt("working")).toBe("interrupted");
    expect(statusAfterInterrupt("blocked")).toBe("interrupted");
    expect(statusAfterInterrupt("done")).toBe("done");
    expect(statusAfterInterrupt("idle")).toBe("idle");
    expect(statusAfterInterrupt(undefined)).toBeUndefined();
  });

  it("keeps an interrupted agent interrupted until a new prompt, the end of a turn or a question", () => {
    expect(statusFromHook("interrupted", "working", true)).toBe("interrupted"); // late tool report
    expect(statusFromHook("interrupted", "working", false)).toBe("working"); // a new prompt
    expect(statusFromHook("interrupted", "done", false)).toBe("done");
    expect(statusFromHook("interrupted", "blocked", false)).toBe("blocked");
    expect(statusFromHook("interrupted", undefined, false)).toBeUndefined(); // the agent exited
    expect(statusFromHook("blocked", "working", true)).toBe("working"); // a permission granted
    expect(statusFromHook("working", "working", true)).toBe("working");
  });

  it("ranks an interrupted shell below a working one in the sidebar", () => {
    const s = (name: string, status?: Status) => ({ name, status });
    expect(lead([s("main", "interrupted"), s("a", "working")]).name).toBe("a");
    expect(lead([s("main"), s("a", "interrupted")]).name).toBe("a");
  });
});

describe("attention", () => {
  const tab = (name: string, status?: Status, unread = false) => ({ name, status, unread });

  it("needs the user when blocked, or done and not seen", () => {
    expect(needsAttention(tab("a", "blocked"))).toBe(true);
    expect(needsAttention(tab("a", "done", true))).toBe(true);
    expect(needsAttention(tab("a", "done", false))).toBe(false);
    expect(needsAttention(tab("a", "working", true))).toBe(false);
  });

  it("filters the sidebar", () => {
    const tabs = [tab("w", "working"), tab("b", "blocked"), tab("d", "done", true), tab("s")];
    expect(tabs.filter((t) => matchesFilter(t, "attention")).map((t) => t.name)).toEqual(["b", "d"]);
    expect(tabs.filter((t) => matchesFilter(t, "working")).map((t) => t.name)).toEqual(["w"]);
    expect(tabs.filter((t) => matchesFilter(t, "all"))).toHaveLength(4);
  });

  it("keeps the active tab in a filtered sidebar once seen", () => {
    const tabs = [tab("w", "working"), tab("b", "blocked"), tab("d", "done", true), tab("s")];
    const [, , d, s] = tabs;
    expect(filteredTabs(tabs, "attention", d).map((t) => t.name)).toEqual(["b", "d"]);
    d.unread = false; // seen: no longer needs the user, still the one on screen
    expect(filteredTabs(tabs, "attention", d).map((t) => t.name)).toEqual(["b", "d"]);
    expect(filteredTabs(tabs, "attention", s).map((t) => t.name)).toEqual(["b", "s"]);
    expect(filteredTabs(tabs, "working").map((t) => t.name)).toEqual(["w"]);
  });

  it("goes to the next tab that needs the user, blocked first, wrapping", () => {
    const [a, b, c, d] = [tab("a"), tab("b", "done", true), tab("c"), tab("d", "blocked")];
    const order = [a, b, c, d];
    expect(nextNeedingAttention(order, a)?.name).toBe("d"); // blocked wins over the nearer done
    d.status = "working";
    expect(nextNeedingAttention(order, c)?.name).toBe("b"); // wraps around
    expect(nextNeedingAttention(order, b)).toBeUndefined(); // only itself
    expect(nextNeedingAttention([], undefined)).toBeUndefined();
  });
});

describe("lead", () => {
  const s = (name: string, status?: Status) => ({ name, status });

  it("is the first shell when none runs an agent", () => {
    expect(lead([s("main"), s("term:1")]).name).toBe("main");
  });

  it("is the most urgent shell: blocked, then done, then working", () => {
    expect(lead([s("main", "working"), s("a", "done"), s("b", "blocked")]).name).toBe("b");
    expect(lead([s("main", "working"), s("a", "done")]).name).toBe("a");
    expect(lead([s("main"), s("a", "working")]).name).toBe("a");
    expect(lead([s("main", "idle"), s("a")]).name).toBe("main");
  });

  it("keeps the first of equally urgent shells", () => {
    expect(lead([s("main", "working"), s("a", "working")]).name).toBe("main");
  });
});
