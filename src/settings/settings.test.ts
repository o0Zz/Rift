import { describe, expect, it } from "vitest";
import {
  actionFor,
  bind,
  comboOf,
  DEFAULT_KEYS,
  DEFAULTS,
  defaultKeys,
  displayVersion,
  isReloadKey,
  isValidShortcut,
  mergeSettings,
  resolveTheme,
} from "./settings";

const key = (key: string, mods: { ctrl?: boolean; shift?: boolean; alt?: boolean } = {}) => ({
  key,
  ctrlKey: mods.ctrl ?? true,
  shiftKey: mods.shift ?? false,
  altKey: mods.alt ?? false,
  metaKey: false,
});

describe("comboOf", () => {
  it("names key presses", () => {
    expect(comboOf(key("t", { shift: true }))).toBe("Ctrl+Shift+T");
    expect(comboOf(key("PageDown"))).toBe("Ctrl+PageDown");
    expect(comboOf(key(","))).toBe("Ctrl+,");
    expect(comboOf(key(" ", { ctrl: false, alt: true }))).toBe("Alt+Space");
    expect(comboOf(key("Control"))).toBeUndefined();
  });
});

describe("actionFor with the default keys", () => {
  it("maps the default shortcuts", () => {
    expect(actionFor(key("PageDown"), DEFAULT_KEYS)).toBe("nextTab");
    expect(actionFor(key("Tab"), DEFAULT_KEYS)).toBe("nextTab");
    expect(actionFor(key("Tab", { shift: true }), DEFAULT_KEYS)).toBe("prevTab");
    expect(actionFor(key("PageUp"), DEFAULT_KEYS)).toBe("prevTab");
    expect(actionFor(key("T", { shift: true }), DEFAULT_KEYS)).toBe("newTab");
    expect(actionFor(key("W", { shift: true }), DEFAULT_KEYS)).toBe("closeTab");
    expect(actionFor(key("E", { shift: true }), DEFAULT_KEYS)).toBe("toggleFiles");
    expect(actionFor(key("G", { shift: true }), DEFAULT_KEYS)).toBe("toggleGit");
    expect(actionFor(key("O", { shift: true }), DEFAULT_KEYS)).toBe("togglePrompts");
    expect(actionFor(key("J", { shift: true }), DEFAULT_KEYS)).toBe("toggleTerminal");
    expect(actionFor(key("K", { shift: true }), DEFAULT_KEYS)).toBe("newTerminal");
    expect(actionFor(key(","), DEFAULT_KEYS)).toBe("settings");
    expect(actionFor({ key: "ArrowLeft", ctrlKey: false, shiftKey: false, altKey: true, metaKey: false }, DEFAULT_KEYS)).toBe("focusLeft");
    expect(actionFor({ key: "ArrowDown", ctrlKey: false, shiftKey: false, altKey: true, metaKey: false }, DEFAULT_KEYS)).toBe("focusDown");
    expect(actionFor(key("U", { shift: true }), DEFAULT_KEYS)).toBe("nextAttention");
    expect(actionFor(key("F", { shift: true }), DEFAULT_KEYS)).toBe("find");
    expect(actionFor(key("="), DEFAULT_KEYS)).toBe("zoomIn");
    expect(actionFor(key("+"), DEFAULT_KEYS)).toBe("zoomIn"); // numeric keypad
    expect(actionFor(key("-"), DEFAULT_KEYS)).toBe("zoomOut");
    expect(actionFor(key("0"), DEFAULT_KEYS)).toBe("zoomReset");
    expect(actionFor({ key: "F2", ctrlKey: false, shiftKey: false, altKey: false, metaKey: false }, DEFAULT_KEYS)).toBe("renameTab");
    expect(actionFor({ key: "F5", ctrlKey: false, shiftKey: false, altKey: false, metaKey: false }, DEFAULT_KEYS)).toBe("refreshPanels");
  });

  it("leaves shell keys alone", () => {
    for (const k of ["w", "t", "c", "v", "r", "f", "u"]) expect(actionFor(key(k), DEFAULT_KEYS)).toBeUndefined();
    expect(actionFor(key("PageDown", { ctrl: false }), DEFAULT_KEYS)).toBeUndefined();
    expect(actionFor(key("PageDown", { alt: true }), DEFAULT_KEYS)).toBeUndefined();
  });
});

describe("bind", () => {
  it("adds a shortcut and takes it away from another action", () => {
    const r = bind(DEFAULT_KEYS, "toggleGit", "Ctrl+Shift+E");
    expect(r.takenFrom).toBe("toggleFiles");
    expect(r.keys.toggleFiles).toEqual([]);
    expect(r.keys.toggleGit).toEqual(["Ctrl+Shift+G", "Ctrl+Shift+E"]);
    expect(actionFor(key("E", { shift: true }), r.keys)).toBe("toggleGit");
  });

  it("does not duplicate an existing binding", () => {
    expect(bind(DEFAULT_KEYS, "newTab", "ctrl+shift+t").keys.newTab).toEqual(["Ctrl+Shift+T"]);
  });
});

describe("macOS", () => {
  const cmd = (k: string, shift = false) => ({ key: k, ctrlKey: false, shiftKey: shift, altKey: false, metaKey: true });
  const mac = defaultKeys(true);

  it("names the Meta key Cmd, first", () => {
    expect(comboOf(cmd("t"), true)).toBe("Cmd+T");
    expect(comboOf({ ...cmd("p", true), ctrlKey: true }, true)).toBe("Cmd+Ctrl+Shift+P");
    expect(comboOf(cmd("t"), false)).toBe("Win+T");
  });

  it("uses native Cmd shortcuts and leaves Ctrl to the shell", () => {
    expect(actionFor(cmd("t"), mac, true)).toBe("newTab");
    expect(actionFor(cmd("w"), mac, true)).toBe("closeTab");
    expect(actionFor(cmd("f"), mac, true)).toBe("find");
    expect(actionFor(cmd("}", true), mac, true)).toBe("nextTab");
    expect(actionFor(cmd(","), mac, true)).toBe("settings");
    expect(actionFor({ key: "c", ctrlKey: true, shiftKey: false, altKey: false, metaKey: false }, mac, true)).toBeUndefined();
  });

  it("covers every action on both platforms", () => {
    for (const keys of [mac, defaultKeys(false)]) {
      for (const combos of Object.values(keys)) expect(combos.length).toBeGreaterThan(0);
    }
  });
});

it("recognizes the webview's reload keys", () => {
  const k = (key: string, mods: Partial<Record<"ctrlKey" | "shiftKey" | "metaKey", boolean>> = {}) => ({
    key, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...mods,
  });
  expect(isReloadKey(k("F5"), false)).toBe(true);
  expect(isReloadKey(k("F5", { ctrlKey: true }), false)).toBe(true);
  expect(isReloadKey(k("r", { ctrlKey: true }), false)).toBe(true);
  expect(isReloadKey(k("R", { ctrlKey: true, shiftKey: true }), false)).toBe(true);
  expect(isReloadKey(k("r", { metaKey: true }), true)).toBe(true);
  expect(isReloadKey(k("r", { ctrlKey: true }), true)).toBe(false); // macOS: Ctrl+R is the shell's
  expect(isReloadKey(k("r"), false)).toBe(false);
});

it("rejects shortcuts that would steal typing", () => {
  expect(isValidShortcut("Ctrl+Shift+T")).toBe(true);
  expect(isValidShortcut("Alt+1")).toBe(true);
  expect(isValidShortcut("Shift+T")).toBe(false);
  expect(isValidShortcut("T")).toBe(false);
  expect(isValidShortcut("Cmd+T")).toBe(true);
  expect(isValidShortcut("F2")).toBe(true); // function keys type nothing
  expect(isValidShortcut("Shift+F5")).toBe(true);
  expect(isValidShortcut("F13")).toBe(false);
});

describe("mergeSettings", () => {
  it("falls back to defaults for missing or invalid values", () => {
    expect(mergeSettings(null)).toEqual(DEFAULTS);
    expect(DEFAULTS.fontSize).toBe(12);
    const s = mergeSettings({ theme: "neon", fontSize: 200, fontFamily: " ", docs: "x", tabSize: "huge", keys: { newTab: "oops" } });
    expect(s).toEqual(DEFAULTS);
  });

  it("keeps valid saved values, including an action with no shortcut", () => {
    const s = mergeSettings({
      theme: "light",
      fontSize: 12,
      docs: "tabs",
      tabSize: "large",
      keys: { newTab: ["Alt+N"], closeTab: [] },
    });
    expect(s.theme).toBe("light");
    expect(s.tabSize).toBe("large");
    expect(s.docs).toBe("tabs");
    expect(s.fontSize).toBe(12);
    expect(s.keys.newTab).toEqual(["Alt+N"]);
    expect(s.keys.closeTab).toEqual([]);
    expect(s.keys.nextTab).toEqual(DEFAULT_KEYS.nextTab);
  });
});

it("resolves the system theme", () => {
  expect(resolveTheme("system", true)).toBe("dark");
  expect(resolveTheme("system", false)).toBe("light");
  expect(resolveTheme("light", true)).toBe("light");
});

it("shows the CI run number as a 4th version number", () => {
  expect(displayVersion("1.2.3+45")).toBe("1.2.3.45");
  expect(displayVersion("0.0.0+7")).toBe("0.0.0.7");
  expect(displayVersion("0.0.0")).toBe("0.0.0");
});
