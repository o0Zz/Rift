// @vitest-environment node
import { describe, expect, it } from "vitest";
import { neighbour, tabAction } from "./nav";

const key = (key: string, mods: { shift?: boolean; alt?: boolean; ctrl?: boolean } = {}) => ({
  key,
  ctrlKey: mods.ctrl ?? true,
  shiftKey: mods.shift ?? false,
  altKey: mods.alt ?? false,
});

describe("neighbour", () => {
  it("wraps forward and backward", () => {
    expect(neighbour(2, 3, 1)).toBe(0);
    expect(neighbour(0, 3, -1)).toBe(2);
    expect(neighbour(1, 3, 1)).toBe(2);
  });
});

describe("tabAction", () => {
  it("switches with Ctrl+PgUp/PgDn and Ctrl+(Shift+)Tab", () => {
    expect(tabAction(key("PageDown"))).toBe("next");
    expect(tabAction(key("PageUp"))).toBe("prev");
    expect(tabAction(key("Tab"))).toBe("next");
    expect(tabAction(key("Tab", { shift: true }))).toBe("prev");
  });

  it("opens and closes with Ctrl+Shift+T/W", () => {
    expect(tabAction(key("T", { shift: true }))).toBe("new");
    expect(tabAction(key("W", { shift: true }))).toBe("close");
  });

  it("leaves shell keys alone", () => {
    expect(tabAction(key("w"))).toBeUndefined();
    expect(tabAction(key("t"))).toBeUndefined();
    expect(tabAction(key("c"))).toBeUndefined();
    expect(tabAction(key("PageDown", { ctrl: false }))).toBeUndefined();
    expect(tabAction(key("PageDown", { alt: true }))).toBeUndefined();
  });
});
