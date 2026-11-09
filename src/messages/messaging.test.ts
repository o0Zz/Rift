import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const replies: { id: number; ok: boolean; text: string }[] = [];
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: { id: number; ok: boolean; text: string }) => {
    if (cmd === "mcp_reply") replies.push(args);
    return Promise.resolve();
  },
}));

import { Tab } from "../tabs/Tab";
import type { TermView } from "../terminal/TermView";
import { createMessaging } from "./messaging";

/** A tab whose main shell is pty `pty`, running `agent`; what is typed into it lands in `typed`. */
function agentTab(pty: number, name: string, agent?: string) {
  const tab = new Tab();
  tab.name = name;
  const typed: string[] = [];
  tab.main.view = { ptyId: pty, submit: (t: string) => typed.push(t) } as unknown as TermView;
  tab.main.agent = agent;
  tab.main.status = agent ? "idle" : undefined;
  tab.main.cwd = "C:/work";
  return { tab, typed };
}

let on = true;
let tabs: Tab[] = [];
let opened: { cwd?: string; agent: string }[] = [];
const bus = () =>
  createMessaging({
    enabled: () => on,
    tabs: () => tabs,
    shellOf: (pty) => {
      for (const tab of tabs) for (const shell of tab.shells) if (shell.view.ptyId === pty) return { tab, shell };
    },
    agents: () => [
      { id: "claude", name: "Claude Code" },
      { id: "codex", name: "Codex" },
    ],
    startAgent: async (_from, o) => {
      opened.push(o);
      const t = agentTab(100 + opened.length, o.name ?? "new");
      tabs.push(t.tab);
      return t.tab;
    },
    worktree: async (_from, branch) => `C:/work.worktrees/${branch}`,
  });

async function call(m: ReturnType<typeof bus>, tab: number, tool: string, args: unknown = {}) {
  await m.call({ id: replies.length + 1000, tab, tool, args });
  return replies[replies.length - 1];
}

beforeEach(() => {
  vi.useFakeTimers();
  replies.length = 0;
  on = true;
  tabs = [];
  opened = [];
});
afterEach(() => vi.useRealTimers());

describe("agent messaging", () => {
  it("lists the agents, marking the caller", async () => {
    const a = agentTab(1, "Butler", "claude");
    const b = agentTab(2, "Rift", "codex");
    tabs = [a.tab, b.tab, agentTab(3, "plain shell").tab];
    const r = await call(bus(), 1, "list_agents");
    expect(r.ok).toBe(true);
    expect(JSON.parse(r.text)).toEqual([
      { id: 1, name: "Butler", agent: "claude", status: "idle", folder: "C:/work", you: true },
      { id: 2, name: "Rift", agent: "codex", status: "idle", folder: "C:/work" },
    ]);
  });

  it("holds a message until the receiver's turn ends, then types it in", async () => {
    const a = agentTab(1, "Butler", "claude");
    const b = agentTab(2, "Rift", "claude");
    b.tab.main.status = "working";
    tabs = [a.tab, b.tab];
    const m = bus();
    const r = await call(m, 1, "send_message", { to: 2, message: "Run the tests" });
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/when its turn ends/);
    expect(m.counts(b.tab)).toEqual({ sent: 0, received: 1, waiting: 1 });
    expect(m.counts(a.tab)).toEqual({ sent: 1, received: 0, waiting: 0 });

    vi.advanceTimersByTime(5000);
    expect(b.typed).toEqual([]); // still working

    b.tab.main.status = "done";
    m.statusChanged(2);
    vi.advanceTimersByTime(5000);
    expect(b.typed).toHaveLength(1);
    expect(b.typed[0]).toMatch(/^── Message from Butler \(agent 1\) via Rift ──\nRun the tests\n/);
    expect(b.tab.main.status).toBe("working");
    expect(m.counts(b.tab)).toEqual({ sent: 0, received: 1, waiting: 0 });
    expect(m.entries()[0]).toMatchObject({ fromName: "Butler", toName: "Rift", state: "delivered" });

    // Leaving a tab clears its counts; the next message counts again.
    m.leave(b.tab);
    expect(m.counts(b.tab)).toEqual({ sent: 0, received: 0, waiting: 0 });
    expect(m.counts(a.tab).sent).toBe(1); // not left: still counted
    vi.advanceTimersByTime(10);
    await call(m, 1, "send_message", { to: 2, message: "And lint?" });
    expect(m.counts(b.tab)).toMatchObject({ received: 1 });
  });

  it("refuses when off, to itself, or to a tab without an agent", async () => {
    const a = agentTab(1, "Butler", "claude");
    tabs = [a.tab, agentTab(2, "shell").tab];
    const m = bus();
    expect((await call(m, 1, "send_message", { to: 1, message: "x" })).ok).toBe(false);
    expect((await call(m, 1, "send_message", { to: 2, message: "x" })).text).toMatch(/No agent/);
    on = false;
    expect((await call(m, 1, "list_agents")).text).toMatch(/turned off/);
  });

  it("starts agents next to the caller, at most 5, and none from a started one", async () => {
    const a = agentTab(1, "Butler", "claude");
    a.tab.root = "C:/work"; // a worktree needs a repository
    tabs = [a.tab];
    const m = bus();
    const r = await call(m, 1, "start_agent", { prompt: "Fix the login", agent: "codex", worktree: "fix-login" });
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/agent 101/);
    expect(opened[0]).toEqual({ cwd: "C:/work.worktrees/fix-login", name: "fix-login", agent: "codex" });
    expect(tabs[1].startedBy).toBe("Butler");
    expect(m.entries()[0]).toMatchObject({ kind: "start", to: 101, state: "queued", text: "Fix the login" });

    // The new agent reports itself idle: it gets its task.
    tabs[1].main.agent = "codex";
    tabs[1].main.status = "idle";
    m.statusChanged(101);
    vi.advanceTimersByTime(5000);
    expect(m.entries()[0].state).toBe("delivered");

    expect((await call(m, 101, "start_agent", { prompt: "more" })).text).toMatch(/cannot start/);
    for (let i = 0; i < 4; i++) expect((await call(m, 1, "start_agent", { prompt: "x" })).ok).toBe(true);
    expect((await call(m, 1, "start_agent", { prompt: "x" })).text).toMatch(/limit/);
  });

  it("starts only agents used here, and a worktree only from a repository", async () => {
    tabs = [agentTab(1, "Butler", "claude").tab];
    const m = bus();
    expect((await call(m, 1, "start_agent", { prompt: "x", agent: "vim" })).text).toMatch(/Unknown agent "vim"/);
    expect((await call(m, 1, "start_agent", { prompt: "x", worktree: "b" })).text).toMatch(/git repository/);
    expect(opened).toEqual([]);
  });
});
