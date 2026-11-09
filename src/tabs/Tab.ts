import type { TermView } from "../terminal/TermView";
import type { DocView } from "../docs/DocView";
import type { PanelId } from "../panels/panes";
import { lead } from "./layout";
import { field, Shell } from "./Shell";

/** Lines changed against HEAD and commits ahead/behind upstream (git_stats). */
export type GitStats = { added: number; deleted: number; ahead: number; behind: number };

/**
 * A tab's state. Getters read Solid signals, so the sidebar and the save effect update on change.
 * A tab is a list of shells: its own terminal ("main") plus one per terminal panel it started.
 */
export class Tab {
  private f = {
    shells: field<Shell[]>([new Shell("main")]),
    name: field<string | undefined>(undefined),
    color: field<string | undefined>(undefined),
    group: field<string | undefined>(undefined),
    root: field<string | undefined>(undefined),
    branch: field<string | undefined>(undefined),
    unread: field(false),
    shell: field<string | undefined>(undefined),
    stats: field<GitStats | undefined>(undefined),
    snap: field<string>(crypto.randomUUID()),
    docs: field<DocView[]>([]),
    current: field(-1),
  };

  /** Name of the agent that started this tab (agent messaging); set once, when it opens. */
  startedBy?: string;

  get shells() { return this.f.shells.get(); }
  set shells(v) { this.f.shells.set(v); }
  /** The shell shown at `place` ("main" or a terminal panel), if this tab has one there. */
  at(place: PanelId) { return this.shells.find((s) => s.place === place); }
  /** The tab's own terminal: where it opened, what is saved and restored. */
  get main() { return this.at("main")!; }
  get view(): TermView { return this.main.view; }
  /** The shell the sidebar shows: the most urgent agent, else the main one. */
  get lead() { return lead(this.shells); }

  get title() { return this.lead.title; }
  get cwd() { return this.main.cwd; }
  get status() { return this.lead.status; }
  get agent() { return this.lead.agent; }
  get context() { return this.lead.context; }
  /** Set by the user (rename); wins over the shell's title. */
  get name() { return this.f.name.get(); }
  set name(v) { this.f.name.set(v); }
  get color() { return this.f.color.get(); }
  set color(v) { this.f.color.set(v); }
  get group() { return this.f.group.get(); }
  set group(v) { this.f.group.set(v); }
  /** Git repository root containing the main shell's folder, and its branch (read from .git/HEAD at each prompt). */
  get root() { return this.f.root.get(); }
  set root(v) { this.f.root.set(v); }
  get branch() { return this.f.branch.get(); }
  set branch(v) { this.f.branch.set(v); }
  /** Shell profile id (see shell_profiles) of all its shells; undefined = the default shell. */
  get shell() { return this.f.shell.get(); }
  set shell(v) { this.f.shell.set(v); }
  /** Id of the tab's saved history (scrollback_save/load), kept across restarts. */
  get snap() { return this.f.snap.get(); }
  set snap(v) { this.f.snap.set(v); }
  get stats() { return this.f.stats.get(); }
  set stats(v) { this.f.stats.set(v); }
  /** Files open in this tab, and the one shown instead of the terminal (-1 = the terminal). */
  get docs() { return this.f.docs.get(); }
  set docs(v) { this.f.docs.set(v); }
  get current() { return this.f.current.get(); }
  set current(v) { this.f.current.set(v); }
  /** What the tab shows: its terminal or one of its documents. */
  get shown(): TermView | DocView { return this.docs[this.current] ?? this.view; }
  get unread() { return this.f.unread.get(); }
  set unread(v) { this.f.unread.set(v); }
}
