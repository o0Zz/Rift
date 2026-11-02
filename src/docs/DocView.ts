import { createSignal } from "solid-js";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { Editor } from "./editor";

type Text = { text: string; mtime: number };

const isMarkdown = (path: string) => /\.(md|markdown|mdx)$/i.test(path);
const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;

/**
 * One open file in a tab, shown instead of the terminal. Like `TermView` it stays mounted and switching only
 * toggles `display`. Nothing is read until it is first shown; the editor and the Markdown reader load then.
 */
export class DocView {
  readonly el = document.createElement("div");
  readonly name: string;
  readonly markdown: boolean;
  private dirtySig = createSignal(false);
  private editingSig = createSignal(false);
  private loaded?: Promise<void>;
  private text = "";
  private mtime = 0;
  private editor?: Editor;
  private timer = 0;

  constructor(
    host: HTMLElement,
    readonly path: string,
    private events: { onNotText(): void; onOpenFile(path: string): void },
  ) {
    this.name = fileName(path);
    this.markdown = isMarkdown(path);
    this.editingSig[1](!this.markdown);
    this.el.className = "doc";
    this.el.dataset.zoom = "docs";
    this.el.style.display = "none";
    this.el.addEventListener("click", (e) => this.onLink(e));
    host.appendChild(this.el);
  }

  get dirty() { return this.dirtySig[0](); }
  /** Markdown files open in the reader; the editor otherwise. */
  get editing() { return this.editingSig[0](); }

  /**
   * Shows the document. Reading it (first time) or checking it for outside changes waits until it stays on
   * screen: a restore activates every tab in turn, and holding Ctrl+PgDn passes through many.
   */
  show() {
    this.el.style.display = "";
    clearTimeout(this.timer);
    this.timer = setTimeout(
      () => {
        if (this.el.style.display === "none") return;
        if (!this.loaded) this.loaded = this.load();
        else this.reloadIfChanged();
      },
      this.loaded ? 150 : 0,
    );
  }

  hide() {
    this.el.style.display = "none";
  }

  focus() {
    if (this.editor) this.editor.focus();
    else this.el.focus();
  }

  /** Reader ↔ editor (Markdown). Unsaved edits stay in the text the reader shows. */
  async toggleEdit() {
    this.takeText();
    this.editingSig[1](!this.editing);
    await this.render();
    this.focus();
  }

  async save() {
    this.takeText();
    this.mtime = await invoke<number>("fs_write_text", { path: this.path, text: this.text });
    this.dirtySig[1](false);
  }

  dispose() {
    this.editor?.destroy();
    this.el.remove();
  }

  private async load() {
    const file = await invoke<Text | null>("fs_read_text", { path: this.path }).catch((e) => {
      this.el.textContent = String(e);
      return undefined;
    });
    if (file === null) return this.events.onNotText();
    if (!file) return;
    this.text = file.text;
    this.mtime = file.mtime;
    await this.render();
  }

  /** Changed outside Rift (an agent, git...): shown again, unless the user has unsaved edits here. */
  private async reloadIfChanged() {
    await this.loaded;
    const mtime = await invoke<number>("fs_mtime", { path: this.path }).catch(() => this.mtime);
    if (mtime === this.mtime || this.dirty) return;
    const file = await invoke<Text | null>("fs_read_text", { path: this.path }).catch(() => undefined);
    if (!file) return;
    this.text = file.text;
    this.mtime = file.mtime;
    await this.render(true);
  }

  private takeText() {
    if (this.editor) this.text = this.editor.text();
  }

  private async render(keepScroll = false) {
    const scroll = keepScroll ? this.scroller()?.scrollTop : 0;
    this.editor?.destroy();
    this.editor = undefined;
    this.el.replaceChildren();
    if (this.editing) {
      const { createEditor } = await import("./editor");
      this.editor = createEditor(this.el, this.text, {
        name: this.name,
        wrap: this.markdown, // prose: one paragraph per line
        onChange: () => this.dirtySig[1](true),
        onSave: () => void this.save(),
      });
    } else {
      const { localImage, renderMarkdown } = await import("./markdown");
      const page = document.createElement("article");
      page.className = "md";
      page.innerHTML = renderMarkdown(this.text);
      // Relative images load from disk next to the file (Tauri's asset protocol), not from the app's origin.
      for (const img of page.querySelectorAll("img")) {
        const file = localImage(img.getAttribute("src") ?? "", this.path);
        if (file) img.src = convertFileSrc(file);
      }
      this.el.tabIndex = -1;
      this.el.appendChild(page);
    }
    const scroller = this.scroller();
    if (scroller && scroll) scroller.scrollTop = scroll;
  }

  private scroller(): HTMLElement | undefined {
    return (this.el.querySelector(".cm-scroller") as HTMLElement) ?? (this.editing ? undefined : this.el);
  }

  /** Links in the reader: web links open in the browser, links to other files open here; never navigate the app. */
  private onLink(e: MouseEvent) {
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute("href") ?? "";
    if (/^https?:\/\//i.test(href)) {
      invoke("open_url", { url: href });
    } else if (href.startsWith("#")) {
      this.el.querySelector(`[id="${CSS.escape(decodeURIComponent(href.slice(1)))}"]`)?.scrollIntoView();
    } else if (href && !/^[a-z][a-z0-9+.-]*:/i.test(href)) {
      const dir = this.path.slice(0, Math.max(this.path.lastIndexOf("/"), this.path.lastIndexOf("\\")) + 1);
      this.events.onOpenFile(dir + decodeURIComponent(href.split("#")[0]));
    }
  }
}
