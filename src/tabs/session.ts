import { createEffect, createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { AgentSession } from "../terminal/TermView";
import type { Pane } from "../panels/panes";
import type { Group } from "./layout";
import type { Tab } from "./Tab";

/** What the backend keeps of a tab, opaque to it. */
export type TabUi = { name?: string; color?: string; group?: string; shell?: string; snap?: string; docs?: string[]; doc?: number };
export type SavedTab = { cwd?: string; title: string; agent?: AgentSession; ui?: TabUi };
export type Saved = { tabs: SavedTab[]; active: number; layout?: { groups?: Group[]; panes?: unknown; widths?: { tabs?: number } } };
/** What `session_restore` returns: `problem` = the file or some tabs could not be read (a copy is kept). */
export type Restored = Saved & { problem?: string | null };

/**
 * Keeps the backend's session (tabs, layout) up to date. Written 300 ms after the last change, never during it:
 * a tab switch changes `active`, and the write (a JSON file, on the backend's main thread) would land in the
 * switch's frame. Nothing is written before `restored()`, so a half-restored state never replaces the saved one.
 */
export function createSessionSave(o: {
  tabs(): Tab[];
  active(): Tab | undefined;
  groups(): Group[];
  panes(): Pane;
  tabsWidth(): number;
}) {
  const [ready, setReady] = createSignal(false);
  let pending: Record<string, unknown> | undefined;
  let timer = 0;

  function save() {
    if (!ready()) return;
    const list = o.tabs();
    pending = {
      tabs: list.map((t) => ({
        pty: t.view.ptyId >= 0 ? t.view.ptyId : null,
        cwd: t.cwd ?? null,
        title: t.title,
        ui: {
          name: t.name,
          color: t.color,
          group: t.group,
          shell: t.shell,
          snap: t.snap,
          docs: t.docs.map((d) => d.path),
          doc: t.current,
        } satisfies TabUi,
      })),
      active: Math.max(0, list.indexOf(o.active()!)),
      layout: { groups: o.groups(), panes: o.panes(), widths: { tabs: o.tabsWidth() } },
    };
    clearTimeout(timer);
    timer = setTimeout(flush, 300);
  }
  createEffect(save);

  /** Writes a pending save now: before Rift closes or updates. */
  async function flush() {
    clearTimeout(timer);
    const args = pending;
    pending = undefined;
    if (args) await invoke("session_update", args);
  }

  return {
    /** Also after a change the effect cannot see (a pty id is not reactive). */
    save,
    flush,
    /** Restored tabs have their shells: saving starts. */
    restored: () => setReady(true),
  };
}

/** Saves every shell tab's history (agent tabs are redisplayed by resuming). Before closing or updating. */
export function saveHistories(tabs: Tab[]) {
  return Promise.all(
    tabs
      .filter((t) => !t.agent)
      .map((t) => invoke("scrollback_save", { id: t.snap, data: t.view.snapshot() }).catch(() => {})),
  );
}
