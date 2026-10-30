import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Channel, invoke } from "@tauri-apps/api/core";
import "@xterm/xterm/css/xterm.css";

// Browsers cap live WebGL contexts (~16). Only the most recently shown tabs keep one;
// the others fall back to the DOM renderer, which costs nothing while hidden.
const MAX_WEBGL = 8;
const webglTabs: TermView[] = [];

/** One tab's terminal. Stays mounted for the tab's lifetime: switching tabs only hides/shows it. */
export class TermView {
  readonly el = document.createElement("div");
  ptyId = -1;
  // Resolves once the shell is attached. Input waits on it: the spare shell's replayed startup
  // output asks for the cursor position before pty_open returns, and that answer must not be lost.
  private pty: Promise<number>;
  private attached!: (id: number) => void;
  private term = new Terminal({
    fontFamily: "'Cascadia Mono', Consolas, monospace",
    fontSize: 14,
    scrollback: 10000,
    theme: { background: "#1e1e1e" },
  });
  private fit = new FitAddon();
  private webgl?: WebglAddon;

  constructor(host: HTMLElement, onTitle: (title: string) => void) {
    this.pty = new Promise((resolve) => (this.attached = resolve));
    this.el.className = "term";
    host.appendChild(this.el);
    this.term.loadAddon(this.fit);
    this.term.open(this.el);
    this.term.onTitleChange(onTitle);
    this.term.onData((data) => this.pty.then((id) => invoke("pty_write", { id, data })));
    this.term.onResize(({ cols, rows }) => this.pty.then((id) => invoke("pty_resize", { id, cols, rows })));
    this.term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown" || !e.ctrlKey || e.shiftKey || e.altKey) return true;
      if (e.key === "c" && this.term.hasSelection()) {
        navigator.clipboard.writeText(this.term.getSelection());
        this.term.clearSelection();
        return false;
      }
      // Let the browser fire its paste event, which xterm turns into input.
      return e.key !== "v";
    });
  }

  async start(cwd?: string) {
    this.fit.fit();
    const onData = new Channel<ArrayBuffer>();
    onData.onmessage = (buf) => this.term.write(new Uint8Array(buf));
    this.ptyId = await invoke<number>("pty_open", { cwd, cols: this.term.cols, rows: this.term.rows, onData });
    this.attached(this.ptyId);
  }

  show() {
    this.el.style.display = "";
    this.useWebgl();
    this.fit.fit(); // no-op unless the window was resized while hidden
    this.term.focus();
  }

  hide() {
    this.el.style.display = "none";
  }

  refit() {
    this.fit.fit();
  }

  dispose() {
    if (this.ptyId >= 0) invoke("pty_close", { id: this.ptyId });
    this.dropWebgl();
    this.term.dispose();
    this.el.remove();
  }

  private useWebgl() {
    const i = webglTabs.indexOf(this);
    if (i >= 0) webglTabs.splice(i, 1);
    webglTabs.push(this);
    if (!this.webgl) {
      try {
        const addon = new WebglAddon();
        addon.onContextLoss(() => this.dropWebgl());
        this.term.loadAddon(addon);
        this.webgl = addon;
      } catch {
        // No WebGL: the DOM renderer still works.
      }
    }
    while (webglTabs.length > MAX_WEBGL) webglTabs.shift()!.dropWebgl();
  }

  private dropWebgl() {
    const i = webglTabs.indexOf(this);
    if (i >= 0) webglTabs.splice(i, 1);
    this.webgl?.dispose();
    this.webgl = undefined;
  }
}
