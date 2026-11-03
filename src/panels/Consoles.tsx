import { createEffect, createSignal, on, Show } from "solid-js";
import { TermView, type TermLook } from "../terminal/TermView";
import { folderName } from "../tabs/layout";
import type { Tab } from "../tabs/Tab";
import { Icon } from "../ui/Icon";
import { groupOf, insert, MAIN, remove, show, type Pane, type PanelId, type Target } from "./panes";

type Console = { view: TermView; cwd(): string | undefined };
/** A terminal panel's place in the layout (shared by every tab) and the shell each tab runs there. */
type Slot = { el?: HTMLDivElement; byTab: Map<Tab, Console> };

/**
 * Terminal panels: extra shells (a dev server, logs...) next to a tab's own terminal, anywhere in the tree.
 * The layout is the same for every tab, but each tab has its own shells: a panel shows the active tab's shell
 * there, or a "Start a terminal here" button. A shell starts only on a click, never on a tab switch; a switch
 * only toggles which terminal is displayed, like the tabs' own terminals. A panel goes away once no tab has a
 * shell in it. Not restored with the session.
 */
export function createConsoles(o: {
  panes(): Pane;
  setPanes(root: Pane): void;
  active(): Tab | undefined;
  look(): TermLook;
  /** Refits the terminals when their area changes size (also when a hidden one is displayed again). */
  sizes(): ResizeObserver | undefined;
}) {
  const slots = new Map<PanelId, Slot>();
  let last: PanelId | undefined; // where the next new panel goes: beside the last one used
  // Bumped on every change to the slots: what a panel shows depends on it and on the active tab.
  const [version, setVersion] = createSignal(0);
  const changed = () => setVersion(version() + 1);
  const mine = (id: PanelId) => (version(), slots.get(id)?.byTab.get(o.active()!));

  /** Starts the active tab's shell in panel `id`, in the tab's folder. */
  function start(id: PanelId) {
    const tab = o.active();
    const slot = slots.get(id);
    if (!tab || !slot || slot.byTab.has(tab)) return;
    const [cwd, setCwd] = createSignal(tab.cwd);
    const view = new TermView(
      slot.el ?? document.createElement("div"),
      { onTitle() {}, onCwd: setCwd, isAgent: () => false, onEscape() {} },
      o.look(),
    );
    view.el.addEventListener("focusin", () => (last = id));
    o.sizes()?.observe(view.el);
    slot.byTab.set(tab, { view, cwd });
    last = id;
    changed();
    // Next frame: the panel is in the page, so the terminal can measure itself.
    requestAnimationFrame(() => view.start(cwd()).then(() => view.focus()));
  }

  /** A new terminal for the active tab: in a panel where it has none yet, else in a new panel. */
  function open() {
    const tab = o.active();
    if (!tab) return;
    const free = [...slots].find(([, s]) => !s.byTab.has(tab))?.[0];
    if (free) {
      // Shown first (it may be a hidden tab of its group), so the terminal mounts and can measure itself.
      if (groupOf(o.panes(), free)?.shown !== free) o.setPanes(show(o.panes(), free));
      return start(free);
    }
    let n = 1;
    while (slots.has(`term:${n}`)) n++;
    const id: PanelId = `term:${n}`;
    slots.set(id, { byTab: new Map() });
    const at: Target = last && groupOf(o.panes(), last) ? { pane: groupOf(o.panes(), last)!.id, at: "tab" } : { pane: MAIN, at: "bottom" };
    o.setPanes(insert(o.panes(), id, at));
    last = id;
    changed();
    // The panel mounts with this change (attach), then the shell starts in it.
    queueMicrotask(() => start(id));
  }

  /** Ends one tab's shell in panel `id` (the active tab's by default); the panel leaves once no tab has one. */
  function close(id: PanelId, tab = o.active()) {
    const slot = slots.get(id);
    const c = tab && slot?.byTab.get(tab);
    if (!slot || !c) return;
    o.sizes()?.unobserve(c.view.el);
    c.view.dispose();
    slot.byTab.delete(tab!);
    if (slot.byTab.size === 0) {
      slots.delete(id);
      if (last === id) last = [...slots.keys()].pop();
      o.setPanes(remove(o.panes(), id));
    }
    changed();
  }

  /** A tab closed: its shells end with it. */
  function dropTab(tab: Tab) {
    for (const [id, slot] of [...slots]) if (slot.byTab.has(tab)) close(id, tab);
  }

  // A tab switch only changes which terminal each panel displays (no shell starts, nothing is rebuilt).
  createEffect(
    on(o.active, (tab, prev) => {
      for (const slot of slots.values()) {
        const before = prev && slot.byTab.get(prev);
        if (before) before.view.el.style.display = "none";
        const now = tab && slot.byTab.get(tab);
        if (now) now.view.el.style.display = "";
      }
    }),
  );

  /** The panel (re)mounts, e.g. after a move: its terminals go into the new element. */
  function attach(id: PanelId, el: HTMLDivElement) {
    const slot = slots.get(id);
    if (!slot) return;
    slot.el = el;
    const tab = o.active();
    for (const [owner, c] of slot.byTab) {
      c.view.el.style.display = owner === tab ? "" : "none";
      el.appendChild(c.view.el);
    }
  }

  function render(id: PanelId, title: string) {
    return (
      <aside class="panel terminal" data-zoom="terminal">
        <div class="panel-head">
          <span class="panel-title" title={mine(id)?.cwd()}>
            {title}
            {mine(id)?.cwd() ? ` · ${folderName(mine(id)!.cwd()!)}` : ""}
          </span>
          <span class="head-buttons">
            <button class="icon-btn" title="New terminal for this tab (Ctrl+Shift+K)" onClick={() => ((last = id), open())}>
              <Icon name="plus" />
            </button>
            <Show when={mine(id)}>
              <button class="icon-btn" title="Close this tab's terminal (ends its shell)" onClick={() => close(id)}>
                <Icon name="close" />
              </button>
            </Show>
          </span>
        </div>
        <div class="pane-term" ref={(el) => attach(id, el)}>
          {/* Always here, only its display changes: no <Show>, which would clear the whole element when it hides
              (Solid sets textContent), erasing the terminals added here by hand. */}
          <div class="pane-empty" style={{ display: mine(id) ? "none" : undefined }}>
            <span>No terminal for this tab here</span>
            <button class="pane-start" onClick={() => start(id)}>
              <Icon name="terminal" /> Start a terminal here
            </button>
          </div>
        </div>
      </aside>
    );
  }

  return {
    open,
    close,
    dropTab,
    render,
    /** The active tab's terminal in panel `id`. */
    view: (id: PanelId) => slots.get(id)?.byTab.get(o.active()!)?.view,
    /** The panel and tab whose shell is `pty`, if any. */
    byPty(pty: number): { id: PanelId; tab: Tab } | undefined {
      for (const [id, slot] of slots) {
        for (const [tab, c] of slot.byTab) if (c.view.ptyId === pty) return { id, tab };
      }
    },
    /** A tab's first terminal panel (bench). */
    viewOf: (tab: Tab) => [...slots.values()].find((s) => s.byTab.has(tab))?.byTab.get(tab)?.view,
    views: () => [...slots.values()].flatMap((s) => [...s.byTab.values()].map((c) => c.view)),
  };
}
