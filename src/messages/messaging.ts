// Agent messaging in the app: answers the agents' MCP calls (`mcp-call` events), queues messages until the
// receiver is idle, types them in as its next prompt, and keeps the log the messages panel shows.

import { createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { Tab } from "../tabs/Tab";
import { field, type Shell } from "../tabs/Shell";
import { displayTitle, type Agent } from "../tabs/layout";
import { addEntry, agentList, canReceive, messageArgs, nextFor, promptFor, startArgs, startRefusal, tally, type Entry } from "./bus";

/** A tool call from an agent, as Rust forwards it. */
export type McpCall = { id: number; tab: number; tool: string; args: unknown };

/**
 * Wait after an agent becomes idle before typing into it: a new agent reports itself before its input box is
 * ready, and a finished turn may still be redrawing.
 */
const DELIVERY_DELAY = 1500;

export function createMessaging(d: {
  /** Whether the user turned agent messaging on (Settings). */
  enabled(): boolean;
  tabs(): Tab[];
  shellOf(pty: number): { tab: Tab; shell: Shell } | undefined;
  /** The agents used on this machine: those an agent may start. */
  agents(): Agent[];
  /** Opens a tab next to `from`, in its group, without switching to it, running agent `agent`. */
  startAgent(from: Tab, o: { cwd?: string; name?: string; agent: string }): Promise<Tab>;
  /** A new branch + worktree of `from`'s repo; its folder. */
  worktree(from: Tab, branch: string): Promise<string>;
}) {
  const [entries, setEntries] = createSignal<Entry[]>([]);
  let nextId = 0;
  /** When the user last left each tab: its badge counts the messages since. */
  const leftAt = new Map<Tab, ReturnType<typeof field<number>>>();
  const leftOf = (tab: Tab) => leftAt.get(tab) ?? leftAt.set(tab, field(0)).get(tab)!;
  /** Agents each tab started (MAX_STARTS). */
  const started = new Map<Tab, number>();

  const nameOf = (tab: Tab, shell: Shell) =>
    displayTitle({ name: tab.name, title: shell.title, cwd: shell.cwd, status: shell.status }) +
    (shell.place === "main" ? "" : ` (${shell.place.replace("term:", "terminal ")})`);
  const update = (id: number, patch: Partial<Entry>) =>
    setEntries(entries().map((e) => (e.id === id ? { ...e, ...patch } : e)));

  function log(e: Omit<Entry, "id" | "time" | "state">) {
    setEntries(addEntry(entries(), { ...e, id: ++nextId, time: Date.now(), state: "queued" }));
  }

  /** Types the next message waiting for `pty` once its agent is idle (checked again after a short wait). */
  function flush(pty: number) {
    setTimeout(() => {
      const e = nextFor(entries(), pty);
      if (!e) return;
      const hit = d.shellOf(pty);
      if (!hit) return update(e.id, { state: "failed", note: "its tab was closed" });
      if (!canReceive(hit.shell.status)) return;
      hit.shell.view.submit(promptFor(e));
      hit.shell.status = "working"; // until its own hook says so: no second delivery meanwhile
      update(e.id, { state: "delivered" });
    }, DELIVERY_DELAY);
  }

  async function run(c: McpCall): Promise<string> {
    if (!d.enabled()) throw "Agent messaging is turned off in Rift (Settings → Agents).";
    const me = d.shellOf(c.tab);
    if (!me) throw "Rift does not know your tab.";
    const myName = nameOf(me.tab, me.shell);

    if (c.tool === "list_agents") {
      const rows = d.tabs().flatMap((tab) =>
        tab.shells
          .filter((s) => s.agent)
          .map((s) => ({
            id: s.view.ptyId,
            name: nameOf(tab, s),
            agent: s.agent!,
            status: s.status ?? "idle",
            folder: s.cwd,
            ...(s === me.shell ? { you: true as const } : {}),
            ...(tab.startedBy && s.place === "main" ? { startedBy: tab.startedBy } : {}),
          })),
      );
      return agentList(rows);
    }

    if (c.tool === "send_message") {
      const a = messageArgs(c.args);
      if (typeof a === "string") throw a;
      const to = d.shellOf(a.to);
      if (!to?.shell.agent) throw `No agent with id ${a.to}: see list_agents.`;
      if (to.shell === me.shell) throw "That is you.";
      const toName = nameOf(to.tab, to.shell);
      log({ kind: "message", from: c.tab, fromName: myName, to: a.to, toName, text: a.message });
      flush(a.to);
      const when = canReceive(to.shell.status) ? "now" : `when its turn ends (it is ${to.shell.status})`;
      return `Sent to ${toName} (agent ${a.to}): it gets it as its next prompt ${when}. Its answer, if any, arrives later as a prompt in your terminal.`;
    }

    if (c.tool === "start_agent") {
      const a = startArgs(c.args);
      if (typeof a === "string") throw a;
      const refusal = startRefusal(!!me.tab.startedBy, started.get(me.tab) ?? 0);
      if (refusal) throw refusal;
      const agent = a.agent ?? me.shell.agent!;
      if (!d.agents().some((x) => x.id === agent)) {
        throw `Unknown agent "${agent}". Available here: ${d.agents().map((x) => x.id).join(", ") || "none"}.`;
      }
      let cwd = a.cwd ?? me.shell.cwd;
      if (a.worktree) {
        if (!me.tab.root) throw "`worktree` needs your tab to be in a git repository.";
        cwd = await d.worktree(me.tab, a.worktree);
      }
      started.set(me.tab, (started.get(me.tab) ?? 0) + 1);
      const tab = await d.startAgent(me.tab, { cwd, name: a.name ?? a.worktree, agent });
      tab.startedBy = myName;
      const pty = tab.view.ptyId;
      if (pty < 0) throw `The new tab could not start: ${tab.main.title}`;
      const toName = nameOf(tab, tab.main);
      log({ kind: "start", from: c.tab, fromName: myName, to: pty, toName, text: a.prompt });
      return `Started ${agent} in a new tab "${toName}" (agent ${pty}, in ${cwd ?? "your folder"}). It gets your task once ready and can answer you with send_message.`;
    }

    throw `Unknown tool ${c.tool}.`;
  }

  return {
    entries,
    clear: () => setEntries(entries().filter((e) => e.state === "queued")),
    /** Messages waiting for one of the tab's shells. */
    /** The tab's messages sent and received since the user last left it, and those waiting for it. */
    counts: (tab: Tab) => tally(entries(), tab.shells.map((s) => s.view.ptyId), leftOf(tab).get()),
    /** The user left `tab`: its counts start again from zero. */
    leave: (tab: Tab) => leftOf(tab).set(Date.now()),
    /** An MCP call: answered with `mcp_reply`, an error as a tool error the agent reads. */
    async call(c: McpCall) {
      let ok = true;
      let text: string;
      try {
        text = await run(c);
      } catch (e) {
        ok = false;
        text = e instanceof Error ? e.message : String(e);
      }
      invoke("mcp_reply", { id: c.id, ok, text });
    },
    /** An agent's status changed: maybe a message can go in now. */
    statusChanged: (pty: number) => nextFor(entries(), pty) && flush(pty),
  };
}
