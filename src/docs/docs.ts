import { batch } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { Tab } from "../tabs/Tab";
import { DocView } from "./DocView";
import { afterClose, placeDoc } from "./place";

/**
 * Documents: files opened from the files panel, shown in the tab instead of its terminal (top bar sub-tabs).
 * `host` is the element they mount in (the tabs' terminal area), `single` the "one document at a time" setting.
 */
export function createDocs(o: { host(): HTMLElement; active(): Tab | undefined; single(): boolean }) {
  // `fromLink`: reached by a link in a Markdown file, which anyone may have written: a file that is not text is
  // shown in the file manager, never opened (a link to an .exe would run it).
  function make(tab: Tab, path: string, fromLink = false): DocView {
    const doc: DocView = new DocView(o.host(), path, {
      // Not text (binary, too big): the default app opens it instead.
      onNotText: () => {
        invoke(fromLink ? "fs_reveal" : "fs_open", { path });
        const i = tab.docs.indexOf(doc);
        if (i >= 0) close(tab, i, true);
      },
      onOpenFile: (p) => open(p, tab, true),
    });
    return doc;
  }

  /** Shows document `index` of the tab, or its terminal (-1). */
  function show(tab: Tab, index: number) {
    const front = tab === o.active();
    if (front) tab.shown.hide();
    tab.current = index;
    if (!front) return;
    tab.shown.show();
    tab.shown.focus();
  }

  function open(path: string, tab = o.active(), fromLink = false) {
    if (!tab) return;
    const { index, replace } = placeDoc(tab.docs, tab.current, path, o.single());
    if (index < tab.docs.length && !replace) return show(tab, index);
    const docs = [...tab.docs];
    const [old] = docs.splice(index, replace ? 1 : 0, make(tab, path, fromLink));
    old?.dispose();
    tab.docs = docs;
    show(tab, index);
  }

  function close(tab: Tab, index: number, force = false) {
    const doc = tab.docs[index];
    if (!force && doc.dirty && !confirm(`Discard unsaved changes to ${doc.name}?`)) return;
    const shown = tab.current === index;
    batch(() => {
      tab.current = afterClose(tab.current, index);
      tab.docs = tab.docs.filter((d) => d !== doc);
    });
    doc.dispose();
    if (shown && tab === o.active()) {
      tab.shown.show();
      tab.shown.focus();
    }
  }

  return { make, show, open, close };
}
