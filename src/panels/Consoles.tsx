import { createSignal } from "solid-js";
import { TermView, type TermLook } from "../terminal/TermView";
import { folderName } from "../tabs/layout";
import { Icon } from "../ui/Icon";
import { groupOf, insert, MAIN, remove, type Pane, type PanelId, type Target } from "./panes";

type Console = { view?: TermView; cwd(): string | undefined; setCwd(cwd: string): void };

/**
 * Terminal panels: shells shared by every tab (a dev server, logs...), as many as wanted, anywhere in the tree.
 * A new one opens next to the last one used, in its folder; it starts when first shown, keeps running while
 * hidden or moved, and goes away when closed or when its shell exits. Not restored with the session.
 */
export function createConsoles(o: {
  panes(): Pane;
  setPanes(root: Pane): void;
  /** The folder of the first one: the active tab's. */
  cwd(): string | undefined;
  look(): TermLook;
  /** Refits the terminals when their area changes size. */
  sizes(): ResizeObserver | undefined;
}) {
  const consoles = new Map<PanelId, Console>();
  let last: PanelId | undefined;

  function open() {
    let n = 1;
    while (consoles.has(`term:${n}`)) n++;
    const id: PanelId = `term:${n}`;
    const from = last && consoles.get(last);
    const [cwd, setCwd] = createSignal(from ? from.cwd() : o.cwd());
    consoles.set(id, { cwd, setCwd });
    const at: Target = last ? { pane: groupOf(o.panes(), last)!.id, at: "tab" } : { pane: MAIN, at: "bottom" };
    o.setPanes(insert(o.panes(), id, at));
    last = id;
  }

  function close(id: PanelId) {
    const view = consoles.get(id)?.view;
    if (view) {
      o.sizes()?.unobserve(view.el);
      view.dispose();
    }
    consoles.delete(id);
    if (last === id) last = [...consoles.keys()].pop();
    o.setPanes(remove(o.panes(), id));
  }

  function attach(id: PanelId, el: HTMLDivElement) {
    const c = consoles.get(id)!;
    if (!c.view) {
      c.view = new TermView(el, { onTitle() {}, onCwd: c.setCwd, isAgent: () => false, onEscape() {} }, o.look());
      c.view.el.addEventListener("focusin", () => (last = id));
      o.sizes()?.observe(c.view.el);
    }
    const view = c.view;
    el.appendChild(view.el);
    last = id;
    // Next frame: the panel is in the page, so the terminal can measure itself.
    requestAnimationFrame(() => (view.ptyId < 0 ? view.start(c.cwd()).then(() => view.focus()) : view.show()));
  }

  function render(id: PanelId, title: string) {
    const cwd = consoles.get(id)?.cwd;
    return (
      <aside class="panel terminal">
        <div class="panel-head">
          <span class="panel-title" title={cwd?.()}>
            {title}
            {cwd?.() ? ` · ${folderName(cwd()!)}` : ""}
          </span>
          <span class="head-buttons">
            <button class="icon-btn" title="New terminal in this folder (Ctrl+Shift+K)" onClick={() => ((last = id), open())}>
              <Icon name="plus" />
            </button>
            <button class="icon-btn" title="Close this terminal (ends its shell)" onClick={() => close(id)}>
              <Icon name="close" />
            </button>
          </span>
        </div>
        <div class="pane-term" ref={(el) => attach(id, el)} />
      </aside>
    );
  }

  return {
    open,
    close,
    render,
    view: (id: PanelId) => consoles.get(id)?.view,
    /** The terminal panel whose shell is `pty`, if any. */
    byPty: (pty: number) => [...consoles].find(([, c]) => c.view?.ptyId === pty)?.[0],
    views: () => [...consoles.values()].flatMap((c) => (c.view ? [c.view] : [])),
  };
}
