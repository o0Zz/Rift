import { createSignal } from "solid-js";
import type { TermView } from "../terminal/TermView";
import type { PanelId } from "../panels/panes";
import type { Status } from "./layout";

export function field<T>(value: T) {
  const [get, set] = createSignal(value);
  return { get, set: (v: T) => set(() => v) };
}

/**
 * One terminal of a tab: the tab's own ("main") or one in a terminal panel. Every shell is the same:
 * its own folder, title and agent (status from hooks, by pty id). Getters read Solid signals.
 */
export class Shell {
  view!: TermView;
  private f = {
    title: field("shell"),
    cwd: field<string | undefined>(undefined),
    status: field<Status | undefined>(undefined),
    agent: field<string | undefined>(undefined),
    context: field<number | undefined>(undefined),
  };

  /** Where it is shown: "main" (the tab's terminal area) or a terminal panel. */
  constructor(readonly place: PanelId) {}

  get title() { return this.f.title.get(); }
  set title(v) { this.f.title.set(v); }
  get cwd() { return this.f.cwd.get(); }
  set cwd(v) { this.f.cwd.set(v); }
  /** Agent status from hooks; undefined = no agent in this shell. */
  get status() { return this.f.status.get(); }
  set status(v) { this.f.status.set(v); }
  /** Harness id of the running agent (e.g. "claude"), for its icon. */
  get agent() { return this.f.agent.get(); }
  set agent(v) { this.f.agent.set(v); }
  /** Percent of the agent's context window in use (its status line); undefined = unknown. */
  get context() { return this.f.context.get(); }
  set context(v) { this.f.context.set(v); }
}
