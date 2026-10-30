import type { ITheme } from "@xterm/xterm";

export const TERMINAL_THEMES: Record<"dark" | "light", ITheme> = {
  dark: {
    background: "#1e1e1e",
    foreground: "#cccccc",
    cursor: "#ffffff",
    selectionBackground: "#264f78",
  },
  // Light: ANSI colors darkened so yellow, cyan and white stay readable on white.
  light: {
    background: "#ffffff",
    foreground: "#1f2328",
    cursor: "#1f2328",
    cursorAccent: "#ffffff",
    selectionBackground: "#b6d6fd",
    black: "#24292f",
    red: "#cf222e",
    green: "#116329",
    yellow: "#7d4e00",
    blue: "#0550ae",
    magenta: "#8250df",
    cyan: "#1b7c83",
    white: "#6e7781",
    brightBlack: "#57606a",
    brightRed: "#a40e26",
    brightGreen: "#1a7f37",
    brightYellow: "#633c01",
    brightBlue: "#218bff",
    brightMagenta: "#a475f9",
    brightCyan: "#3192aa",
    brightWhite: "#8c959f",
  },
};
