import { createSignal } from "solid-js";
import type { TermView } from "../terminal/TermView";
import type { DocView } from "../docs/DocView";
import type { Status } from "./layout";

/** Lines changed against HEAD and commits ahead/behind upstream (git_stats). */
export type GitStats = { added: number; deleted: number; ahead: number; behind: number };

function field<T>(value: T) {
  const [get, set] = createSignal(value);
  return { get, set: (v: T) => set(() => v) };
}

/** A tab's state. Getters read Solid signals, so the sidebar and the save effect update on change. */
export class Tab {
  view!: TermView;
  private f = {
    title: field("shell"),
    cwd: field<string | undefined>(undefined),
    name: field<string | undefined>(undefined),
    color: field<string | undefined>(undefined),
    group: field<string | undefined>(undefined),
    status: field<Status | undefined>(undefined),
    agent: field<string | undefined>(undefined),
    root: field<string | undefined>(undefined),
    branch: field<string | undefined>(undefined),
    unread: field(false),
    shell: field<string | undefined>(undefined),
    stats: field<GitStats | undefined>(undefined),
    context: field<number | undefined>(undefined),
    snap: field<string>(crypto.randomUUID()),
    docs: field<DocView[]>([]),
    current: field(-1),
  };

  get title() { return this.f.title.get(); }
  set title(v) { this.f.title.set(v); }
  get cwd() { return this.f.cwd.get(); }
  set cwd(v) { this.f.cwd.set(v); }
  /** Set by the user (rename); wins over the shell's title. */
  get name() { return this.f.name.get(); }
  set name(v) { this.f.name.set(v); }
  get color() { return this.f.color.get(); }
  set color(v) { this.f.color.set(v); }
  get group() { return this.f.group.get(); }
  set group(v) { this.f.group.set(v); }
  /** Agent status from hooks; undefined = no agent in this tab. */
  get status() { return this.f.status.get(); }
  set status(v) { this.f.status.set(v); }
  /** Harness id of the running agent (e.g. "claude"), for its icon. */
  get agent() { return this.f.agent.get(); }
  set agent(v) { this.f.agent.set(v); }
  /** Git repository root containing cwd, and its branch (read from .git/HEAD at each prompt). */
  get root() { return this.f.root.get(); }
  set root(v) { this.f.root.set(v); }
  get branch() { return this.f.branch.get(); }
  set branch(v) { this.f.branch.set(v); }
  /** Shell profile id (see shell_profiles); undefined = the default shell. */
  get shell() { return this.f.shell.get(); }
  set shell(v) { this.f.shell.set(v); }
  /** Id of the tab's saved history (scrollback_save/load), kept across restarts. */
  get snap() { return this.f.snap.get(); }
  set snap(v) { this.f.snap.set(v); }
  get stats() { return this.f.stats.get(); }
  set stats(v) { this.f.stats.set(v); }
  /** Percent of the agent's context window in use (its status line); undefined = unknown. */
  get context() { return this.f.context.get(); }
  set context(v) { this.f.context.set(v); }
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
