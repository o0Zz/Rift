// Settings model and keyboard shortcuts. Pure: unit-tested in settings.test.ts.

export type ThemeChoice = "dark" | "light" | "system";

export const ACTIONS = {
  newTab: "New tab",
  closeTab: "Close tab",
  nextTab: "Next tab",
  prevTab: "Previous tab",
  toggleFiles: "Show / hide files panel",
  toggleGit: "Show / hide git panel",
  togglePrompts: "Show / hide prompts panel",
  toggleTerminal: "Show / hide terminal panel",
  nextAttention: "Next tab that needs me",
  find: "Find in terminal",
  zoomIn: "Zoom in",
  zoomOut: "Zoom out",
  zoomReset: "Reset zoom",
  renameTab: "Rename tab",
  refreshPanels: "Refresh files and git panels",
  settings: "Open settings",
} as const;

export type Action = keyof typeof ACTIONS;
export type Keymap = Record<Action, string[]>;

export type Settings = {
  theme: ThemeChoice;
  fontSize: number;
  fontFamily: string;
  /** Default shell profile id; "" = the platform default (PowerShell 7 / $SHELL). */
  shell: string;
  /** Opening a file: "single" replaces the shown document, "tabs" adds one each time. */
  docs: "single" | "tabs";
  /** Height of a sidebar tab row. */
  tabSize: TabSize;
  keys: Keymap;
};

export type TabSize = "compact" | "comfortable" | "large";
/** Tab row height in px per size (compact = the original 36 px). */
export const TAB_ROW_HEIGHT: Record<TabSize, number> = { compact: 36, comfortable: 44, large: 52 };

export const IS_MAC = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);

/**
 * Default shortcuts. Windows/Linux: Ctrl+T/W/F belong to the shell (Ctrl+W deletes a word), hence the
 * Shift variants. macOS: Cmd never reaches the shell, so the native Cmd+T/W/F are free.
 */
export function defaultKeys(mac: boolean): Keymap {
  if (mac) {
    return {
      newTab: ["Cmd+T"],
      closeTab: ["Cmd+W"],
      nextTab: ["Cmd+Shift+}", "Cmd+Alt+ArrowRight", "Ctrl+Tab"],
      prevTab: ["Cmd+Shift+{", "Cmd+Alt+ArrowLeft", "Ctrl+Shift+Tab"],
      toggleFiles: ["Cmd+Shift+E"],
      toggleGit: ["Cmd+Shift+G"],
      togglePrompts: ["Cmd+Shift+O"],
      toggleTerminal: ["Cmd+Shift+J"],
      nextAttention: ["Cmd+Shift+U"],
      find: ["Cmd+F"],
      zoomIn: ["Cmd+=", "Cmd++", "Cmd+Shift++"],
      zoomOut: ["Cmd+-"],
      zoomReset: ["Cmd+0"],
      renameTab: ["F2"],
      refreshPanels: ["F5"],
      settings: ["Cmd+,"],
    };
  }
  return {
    newTab: ["Ctrl+Shift+T"],
    closeTab: ["Ctrl+Shift+W"],
    nextTab: ["Ctrl+PageDown", "Ctrl+Tab"],
    prevTab: ["Ctrl+PageUp", "Ctrl+Shift+Tab"],
    toggleFiles: ["Ctrl+Shift+E"],
    toggleGit: ["Ctrl+Shift+G"],
    togglePrompts: ["Ctrl+Shift+O"],
    toggleTerminal: ["Ctrl+Shift+J"],
    nextAttention: ["Ctrl+Shift+U"],
    find: ["Ctrl+Shift+F"], // Ctrl+F is the shell's (bash: forward one character)
    zoomIn: ["Ctrl+=", "Ctrl++", "Ctrl+Shift++"],
    zoomOut: ["Ctrl+-"],
    zoomReset: ["Ctrl+0"],
    renameTab: ["F2"], // note: PowerShell 7 uses F2 to switch its prediction view; rebindable
    refreshPanels: ["F5"],
    settings: ["Ctrl+,"],
  };
}

export const DEFAULT_KEYS: Keymap = defaultKeys(IS_MAC);

export const DEFAULTS: Settings = {
  theme: "dark",
  fontSize: 14,
  // Windows, macOS, Linux defaults, then whatever monospace font the system has.
  fontFamily: "'Cascadia Mono', Consolas, Menlo, 'DejaVu Sans Mono', monospace",
  shell: "",
  docs: "single",
  tabSize: "comfortable",
  keys: DEFAULT_KEYS,
};

/** Saved settings (any shape, possibly from an older version or edited by hand) over the defaults. */
export function mergeSettings(saved: unknown): Settings {
  const s = (saved && typeof saved === "object" ? saved : {}) as Partial<Settings>;
  const keys = { ...DEFAULT_KEYS };
  for (const action of Object.keys(ACTIONS) as Action[]) {
    const combos = s.keys?.[action];
    if (Array.isArray(combos) && combos.every((c) => typeof c === "string")) keys[action] = combos;
  }
  return {
    theme: s.theme === "light" || s.theme === "system" || s.theme === "dark" ? s.theme : DEFAULTS.theme,
    fontSize: typeof s.fontSize === "number" && s.fontSize >= 8 && s.fontSize <= 32 ? s.fontSize : DEFAULTS.fontSize,
    fontFamily: typeof s.fontFamily === "string" && s.fontFamily.trim() ? s.fontFamily : DEFAULTS.fontFamily,
    shell: typeof s.shell === "string" ? s.shell : DEFAULTS.shell,
    docs: s.docs === "tabs" ? "tabs" : DEFAULTS.docs,
    tabSize: s.tabSize && s.tabSize in TAB_ROW_HEIGHT ? s.tabSize : DEFAULTS.tabSize,
    keys,
  };
}

type KeyLike = Pick<KeyboardEvent, "key" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey">;

/** "Ctrl+Shift+T" for a keydown, or undefined for a lone modifier. The Meta key is "Cmd" on macOS. */
export function comboOf(e: KeyLike, mac = IS_MAC): string | undefined {
  if (["Control", "Shift", "Alt", "Meta", "AltGraph"].includes(e.key)) return;
  const meta = mac ? "Cmd" : "Win";
  const mods = [e.metaKey && mac && meta, e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && !mac && meta].filter(Boolean);
  const key = e.key === " " ? "Space" : e.key.length === 1 ? e.key.toUpperCase() : e.key;
  return [...mods, key].join("+");
}

/**
 * A shortcut must use Ctrl, Alt or Cmd, otherwise it would steal normal typing from the terminal.
 * Function keys (F1-F12) type nothing, so they may stand alone or with Shift.
 */
export function isValidShortcut(combo: string): boolean {
  if (/^(Shift\+)?F([1-9]|1[0-2])$/.test(combo)) return true;
  return /^(Cmd|Ctrl|Alt)\+/.test(combo) && !/\+(Control|Shift|Alt|Meta)$/.test(combo);
}

export function actionFor(e: KeyLike, keys: Keymap, mac = IS_MAC): Action | undefined {
  const combo = comboOf(e, mac)?.toLowerCase();
  if (!combo) return;
  return (Object.keys(keys) as Action[]).find((a) => keys[a].some((c) => c.toLowerCase() === combo));
}

/**
 * The webview's reload keys (F5, Ctrl+R, Cmd+R on macOS): they would reload the whole app and restart every
 * shell. Ctrl+R typed in a terminal is the shell's history search; xterm consumes it before the webview.
 */
export function isReloadKey(e: KeyLike, mac = IS_MAC): boolean {
  const key = e.key.toLowerCase();
  return key === "f5" || (key === "r" && (mac ? e.metaKey : e.ctrlKey));
}

/**
 * Adds `combo` to `action`, removing it from any other action that used it.
 * Returns the new keymap and the action it was taken from, if any.
 */
export function bind(keys: Keymap, action: Action, combo: string): { keys: Keymap; takenFrom?: Action } {
  let takenFrom: Action | undefined;
  const next = { ...keys };
  for (const a of Object.keys(next) as Action[]) {
    if (a !== action && next[a].some((c) => c.toLowerCase() === combo.toLowerCase())) {
      next[a] = next[a].filter((c) => c.toLowerCase() !== combo.toLowerCase());
      takenFrom = a;
    }
  }
  if (!next[action].some((c) => c.toLowerCase() === combo.toLowerCase())) next[action] = [...next[action], combo];
  return { keys: next, takenFrom };
}

/** Semver build metadata as a 4th number: "1.2.3+45" -> "1.2.3.45" (CI puts the run number there). */
export function displayVersion(version: string): string {
  return version.replace("+", ".");
}

export function resolveTheme(choice: ThemeChoice, systemDark: boolean): "dark" | "light" {
  return choice === "system" ? (systemDark ? "dark" : "light") : choice;
}
