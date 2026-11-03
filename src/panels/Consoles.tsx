import { createEffect, on, Show } from "solid-js";
import type { TermLook } from "../terminal/TermView";
import { folderName } from "../tabs/layout";
import type { Shell } from "../tabs/Shell";
import type { Tab } from "../tabs/Tab";
import { Icon } from "../ui/Icon";
import { groupOf, insert, MAIN, remove, show, type Pane, type PanelId, type Target } from "./panes";

/**
 * Terminal panels: places in the layout (shared by every tab) for a tab's extra shells (a dev server, logs,
 * another agent...). The shells belong to the tabs (`Tab.shells`, like the tab's own terminal): a panel shows
 * the active tab's shell there, or a "Start a terminal here" button. A shell starts only on a click, never on a
 * tab switch; a switch only toggles which terminal is displayed. A panel goes away once no tab has a shell in
 * it. Not restored with the session.
 */
export function createConsoles(o: {
  panes(): Pane;
  setPanes(root: Pane): void;
  tabs(): Tab[];
  active(): Tab | undefined;
  /** Builds a tab's shell at `place`, its terminal in `host` (the same for every shell of every tab). */
  create(tab: Tab, place: PanelId, host: HTMLElement): Shell;
  look(): TermLook;
  /** Refits the terminals when their area changes size (also when a hidden one is displayed again). */
  sizes(): ResizeObserver | undefined;
}) {
  /** The panels' elements, by place (set once mounted). */
  const slots = new Map<PanelId, HTMLDivElement | undefined>();
  let last: PanelId | undefined; // where the next new panel goes: beside the last one used
  const mine = (id: PanelId) => o.active()?.at(id);

  /** Starts the active tab's shell in panel `id`, in the tab's folder, with the tab's shell profile. */
  function start(id: PanelId) {
    const tab = o.active();
    if (!tab || !slots.has(id) || tab.at(id)) return;
    const shell = o.create(tab, id, slots.get(id) ?? document.createElement("div"));
    shell.view.el.addEventListener("focusin", () => (last = id));
    o.sizes()?.observe(shell.view.el);
    tab.shells = [...tab.shells, shell];
    last = id;
    // Next frame: the panel is in the page, so the terminal can measure itself.
    requestAnimationFrame(() => shell.view.start(tab.cwd, undefined, undefined, tab.shell).then(() => shell.view.focus()));
  }

  /** A new terminal for the active tab: in a panel where it has none yet, else in a new panel. */
  function open() {
    const tab = o.active();
    if (!tab) return;
    const free = [...slots.keys()].find((id) => !tab.at(id));
    if (free) {
      // Shown first (it may be a hidden tab of its group), so the terminal mounts and can measure itself.
      if (groupOf(o.panes(), free)?.shown !== free) o.setPanes(show(o.panes(), free));
      return start(free);
    }
    let n = 1;
    while (slots.has(`term:${n}`)) n++;
    const id: PanelId = `term:${n}`;
    slots.set(id, undefined);
    const at: Target = last && groupOf(o.panes(), last) ? { pane: groupOf(o.panes(), last)!.id, at: "tab" } : { pane: MAIN, at: "bottom" };
    o.setPanes(insert(o.panes(), id, at));
    last = id;
    // The panel mounts with this change (attach), then the shell starts in it.
    queueMicrotask(() => start(id));
  }

  /** Ends one tab's shell in panel `id` (the active tab's by default); the panel leaves once no tab has one. */
  function close(id: PanelId, tab = o.active()) {
    const shell = tab?.at(id);
    if (!tab || !shell) return;
    o.sizes()?.unobserve(shell.view.el);
    shell.view.dispose();
    tab.shells = tab.shells.filter((s) => s !== shell);
    if (!o.tabs().some((t) => t.at(id))) {
      slots.delete(id);
      if (last === id) last = [...slots.keys()].pop();
      o.setPanes(remove(o.panes(), id));
    }
  }

  /** A tab closed: its panel shells end with it. */
  function dropTab(tab: Tab) {
    for (const s of tab.shells) if (s.place !== "main") close(s.place, tab);
  }

  // A tab switch only changes which terminal each panel displays (no shell starts, nothing is rebuilt).
  createEffect(
    on(o.active, (tab, prev) => {
      for (const s of prev?.shells ?? []) if (s.place !== "main") s.view.el.style.display = "none";
      for (const s of tab?.shells ?? []) if (s.place !== "main") s.view.el.style.display = "";
    }),
  );

  /** The panel (re)mounts, e.g. after a move: its terminals go into the new element. */
  function attach(id: PanelId, el: HTMLDivElement) {
    if (!slots.has(id)) return;
    slots.set(id, el);
    const tab = o.active();
    for (const t of o.tabs()) {
      const s = t.at(id);
      if (!s) continue;
      s.view.el.style.display = t === tab ? "" : "none";
      el.appendChild(s.view.el);
    }
  }

  function render(id: PanelId, title: string) {
    return (
      <aside class="panel terminal" data-zoom="terminal">
        <div class="panel-head">
          <span class="panel-title" title={mine(id)?.cwd}>
            <Show when={mine(id)?.status && mine(id)!.status !== "idle"}>
              <span class={`badge ${mine(id)!.status}`} title={mine(id)!.status} />
            </Show>
            {title}
            {mine(id)?.cwd ? ` · ${folderName(mine(id)!.cwd!)}` : ""}
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
    /** Shows panel `id` (a hidden tab of its group) and focuses the active tab's shell there. */
    reveal(id: PanelId) {
      if (groupOf(o.panes(), id)?.shown !== id) o.setPanes(show(o.panes(), id));
      requestAnimationFrame(() => mine(id)?.view.focus());
    },
    /** The active tab's terminal in panel `id`. */
    view: (id: PanelId) => mine(id)?.view,
    /** A tab's first terminal panel (bench). */
    viewOf: (tab: Tab) => tab.shells.find((s) => s.place !== "main")?.view,
    views: () => o.tabs().flatMap((t) => t.shells.filter((s) => s.place !== "main").map((s) => s.view)),
  };
}
