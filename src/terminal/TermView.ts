import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Channel, invoke } from "@tauri-apps/api/core";
import "@xterm/xterm/css/xterm.css";
import { cwdFromOsc7, cwdFromOsc9 } from "./osc";
import { quotePath } from "./paths";

export type AgentSession = { harness: string; session_id: string };

/** Visual settings, applied at creation and live from the settings page. */
export type TermLook = { theme: ITheme; fontSize: number; fontFamily: string };

/** Drag type of a path dragged from Rift's files panel; dropped on a terminal, it is typed in. */
export const PATH_DRAG_TYPE = "application/x-rift-path";

export type TermEvents = {
  onTitle(title: string): void;
  /** From the shell's prompt (OSC 9;9, emitted by Rift's PowerShell init). */
  onCwd(cwd: string): void;
  /** Whether an agent (Claude...) runs in this tab: Shift+Enter then inserts a new line. */
  isAgent(): boolean;
  /** Esc pressed: an agent is interrupted (no hook reports it). */
  onEscape(): void;
};

/**
 * One tab's terminal. Stays mounted for the tab's lifetime: switching tabs only hides/shows it.
 * Uses xterm's DOM renderer on purpose: WebGL context creation made tab switching 3-4x slower (npm run bench).
 */
export class TermView {
  readonly el = document.createElement("div");
  ptyId = -1;
  // Resolves once the shell is attached. Input waits on it: the spare shell's replayed startup
  // output asks for the cursor position before pty_open returns, and that answer must not be lost.
  private pty: Promise<number>;
  private attached!: (id: number) => void;
  readonly term: Terminal;
  private fit = new FitAddon();
  private search = new SearchAddon();

  constructor(host: HTMLElement, events: TermEvents, look: TermLook) {
    this.term = new Terminal({ scrollback: 10000, ...look });
    this.pty = new Promise((resolve) => (this.attached = resolve));
    this.el.className = "term";
    host.appendChild(this.el);
    this.term.loadAddon(this.fit);
    this.term.loadAddon(this.search);
    // Ctrl+click opens a link, like VS Code and Windows Terminal: a plain click must not open pages by accident.
    this.term.loadAddon(new WebLinksAddon((e, url) => e.ctrlKey && invoke("open_url", { url })));
    this.term.open(this.el);
    this.term.onTitleChange(events.onTitle);
    // Folder reports: OSC 9;9 from PowerShell, OSC 7 from bash/zsh.
    for (const [code, parse] of [
      [9, cwdFromOsc9],
      [7, cwdFromOsc7],
    ] as const) {
      this.term.parser.registerOscHandler(code, (data) => {
        const cwd = parse(data);
        if (cwd) events.onCwd(cwd);
        return cwd !== undefined;
      });
    }
    this.term.onData((data) => this.write(data));
    this.term.onResize(({ cols, rows }) => this.pty.then((id) => invoke("pty_resize", { id, cols, rows })));
    this.term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      if (e.key === "Escape" && !e.ctrlKey && !e.altKey && !e.shiftKey) events.onEscape();
      // Agents (Claude Code) take Esc+Enter as "new line"; a plain Enter would send the prompt.
      if (e.key === "Enter" && e.shiftKey && !e.ctrlKey && !e.altKey && events.isAgent()) {
        this.write("\x1b\r");
        return false;
      }
      if (!e.ctrlKey || e.shiftKey || e.altKey) return true;
      if (e.key === "c" && this.term.hasSelection()) {
        navigator.clipboard.writeText(this.term.getSelection());
        this.term.clearSelection();
        return false;
      }
      // Let the browser fire its paste event, which xterm turns into input.
      return e.key !== "v";
    });
    // A path dragged from the files panel is typed in at the cursor (quoted when needed).
    this.el.addEventListener("dragover", (e) => {
      if (e.dataTransfer?.types.includes(PATH_DRAG_TYPE)) e.preventDefault();
    });
    this.el.addEventListener("drop", (e) => {
      const path = e.dataTransfer?.getData(PATH_DRAG_TYPE);
      if (!path) return;
      e.preventDefault();
      this.term.paste(quotePath(path) + " ");
      this.term.focus();
    });
  }

  private write(data: string) {
    this.pty.then((id) => invoke("pty_write", { id, data }));
  }

  /**
   * Opens the shell in `cwd`. With `agent`, the shell starts by resuming that agent session;
   * with `startAgent` (harness id), by starting a new one.
   */
  async start(cwd?: string, agent?: AgentSession, startAgent?: string, shell?: string) {
    this.fit.fit();
    const onData = new Channel<ArrayBuffer>();
    onData.onmessage = (buf) => this.term.write(new Uint8Array(buf));
    this.ptyId = await invoke<number>("pty_open", {
      cwd,
      agent,
      startAgent,
      shell,
      cols: this.term.cols,
      rows: this.term.rows,
      onData,
    });
    this.attached(this.ptyId);
  }

  /** Finds `text` in the scrollback; returns whether it was found. */
  find(text: string, backwards = false): boolean {
    return backwards ? this.search.findPrevious(text) : this.search.findNext(text);
  }

  focus() {
    this.term.focus();
  }

  endFind() {
    this.search.clearDecorations();
    this.term.clearSelection();
    this.term.focus();
  }

  show() {
    this.el.style.display = "";
    this.fit.fit(); // no-op unless the window was resized while hidden
    this.term.focus();
  }

  hide() {
    this.el.style.display = "none";
  }

  refit() {
    this.fit.fit();
  }

  /** Theme and font. A font change alters the cell size: the caller refits and resizes hidden tabs. */
  setLook(look: TermLook) {
    this.term.options.theme = look.theme;
    this.term.options.fontSize = look.fontSize;
    this.term.options.fontFamily = look.fontFamily;
  }

  /** For hidden tabs (they cannot measure themselves): take the visible tab's size. */
  resizeTo(cols: number, rows: number) {
    if (this.term.cols !== cols || this.term.rows !== rows) this.term.resize(cols, rows);
  }

  dispose() {
    if (this.ptyId >= 0) invoke("pty_close", { id: this.ptyId });
    this.term.dispose();
    this.el.remove();
  }
}
