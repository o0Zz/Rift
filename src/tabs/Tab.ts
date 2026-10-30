import { createSignal } from "solid-js";
import type { TermView } from "../terminal/TermView";
import type { Status } from "./layout";

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
    unread: field(false),
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
  get unread() { return this.f.unread.get(); }
  set unread(v) { this.f.unread.set(v); }
}
