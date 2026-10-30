// Settings model and keyboard shortcuts. Pure: unit-tested in settings.test.ts.

export type ThemeChoice = "dark" | "light" | "system";

export const ACTIONS = {
  newTab: "New tab",
  closeTab: "Close tab",
  nextTab: "Next tab",
  prevTab: "Previous tab",
  toggleFiles: "Show / hide files panel",
  toggleGit: "Show / hide git panel",
  nextAttention: "Next tab that needs me",
  find: "Find in terminal",
  zoomIn: "Zoom in",
  zoomOut: "Zoom out",
  zoomReset: "Reset zoom",
  settings: "Open settings",
} as const;

export type Action = keyof typeof ACTIONS;
export type Keymap = Record<Action, string[]>;

export type Settings = {
  theme: ThemeChoice;
  fontSize: number;
  fontFamily: string;
  keys: Keymap;
};

// Ctrl+T/W are left to the shell (Ctrl+W deletes a word), hence the Shift variants.
export const DEFAULT_KEYS: Keymap = {
  newTab: ["Ctrl+Shift+T"],
  closeTab: ["Ctrl+Shift+W"],
  nextTab: ["Ctrl+PageDown", "Ctrl+Tab"],
  prevTab: ["Ctrl+PageUp", "Ctrl+Shift+Tab"],
  toggleFiles: ["Ctrl+Shift+E"],
  toggleGit: ["Ctrl+Shift+G"],
  nextAttention: ["Ctrl+Shift+U"],
  // Ctrl+F is the shell's (bash: forward one character), like Ctrl+T/W.
  find: ["Ctrl+Shift+F"],
  zoomIn: ["Ctrl+=", "Ctrl++", "Ctrl+Shift++"],
  zoomOut: ["Ctrl+-"],
  zoomReset: ["Ctrl+0"],
  settings: ["Ctrl+,"],
};

export const DEFAULTS: Settings = {
  theme: "dark",
  fontSize: 14,
  // Windows, macOS, Linux defaults, then whatever monospace font the system has.
  fontFamily: "'Cascadia Mono', Consolas, Menlo, 'DejaVu Sans Mono', monospace",
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
    keys,
  };
}

type KeyLike = Pick<KeyboardEvent, "key" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey">;

/** "Ctrl+Shift+T" for a keydown, or undefined for a lone modifier. */
export function comboOf(e: KeyLike): string | undefined {
  if (["Control", "Shift", "Alt", "Meta", "AltGraph"].includes(e.key)) return;
  const mods = [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Win"].filter(Boolean);
  const key = e.key === " " ? "Space" : e.key.length === 1 ? e.key.toUpperCase() : e.key;
  return [...mods, key].join("+");
}

/** A shortcut must use Ctrl or Alt, otherwise it would steal normal typing from the terminal. */
export function isValidShortcut(combo: string): boolean {
  return /^(Ctrl|Alt)\+/.test(combo) && !/\+(Control|Shift|Alt)$/.test(combo);
}

export function actionFor(e: KeyLike, keys: Keymap): Action | undefined {
  const combo = comboOf(e)?.toLowerCase();
  if (!combo) return;
  return (Object.keys(keys) as Action[]).find((a) => keys[a].some((c) => c.toLowerCase() === combo));
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
