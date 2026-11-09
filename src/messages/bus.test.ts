import { describe, expect, it } from "vitest";
import { addEntry, agentList, canReceive, MAX_ENTRIES, messageArgs, nextFor, promptFor, startArgs, startRefusal, waitingFor, type Entry } from "./bus";

const entry = (id: number, to: number, state: Entry["state"] = "queued"): Entry => ({
  id,
  time: 0,
  kind: "message",
  from: 1,
  fromName: "Butler",
  to,
  toName: "Rift",
  text: `m${id}`,
  state,
});

describe("delivery", () => {
  it("waits for the end of a turn", () => {
    expect(canReceive("idle")).toBe(true);
    expect(canReceive("done")).toBe(true);
    for (const s of ["working", "blocked", "interrupted", undefined] as const) expect(canReceive(s)).toBe(false);
  });

  it("delivers oldest first, only queued ones", () => {
    const list = [entry(1, 5, "delivered"), entry(2, 6), entry(3, 5), entry(4, 5)];
    expect(nextFor(list, 5)?.id).toBe(3);
    expect(nextFor(list, 7)).toBeUndefined();
    expect(waitingFor(list, [5, 6])).toBe(3);
    expect(waitingFor(list, [6])).toBe(1);
  });

  it("names the sender and how to answer", () => {
    const p = promptFor({ kind: "message", from: 12, fromName: "Butler", text: "Tests pass?" });
    expect(p).toBe("── Message from Butler (agent 12) via Rift ──\nTests pass?\n── To answer, use Rift's send_message tool with to: 12 ──");
    expect(promptFor({ kind: "start", from: 3, fromName: "Rift", text: "x" })).toContain("who started this tab");
  });

  it("drops the oldest finished entries, never a queued one", () => {
    let list: Entry[] = [entry(0, 1)];
    for (let i = 1; i <= MAX_ENTRIES; i++) list = addEntry(list, entry(i, 1, "delivered"));
    expect(list).toHaveLength(MAX_ENTRIES);
    expect(list[0].id).toBe(0);
    expect(list[1].id).toBe(2);
  });
});

describe("limits", () => {
  it("lets an agent start 5 agents, and none started by an agent", () => {
    expect(startRefusal(false, 4)).toBeUndefined();
    expect(startRefusal(false, 5)).toMatch(/limit/);
    expect(startRefusal(true, 0)).toMatch(/cannot start/);
  });
});

describe("arguments", () => {
  it("checks send_message", () => {
    expect(messageArgs({ to: 4, message: " hi " })).toEqual({ to: 4, message: "hi" });
    expect(messageArgs({ to: "4", message: "hi" })).toEqual({ to: 4, message: "hi" });
    expect(messageArgs({ to: "x", message: "hi" })).toMatch(/agent id/);
    expect(messageArgs({ to: 4, message: "  " })).toMatch(/empty/);
    expect(messageArgs({ to: 4, message: "a".repeat(20_001) })).toMatch(/too long/);
    expect(messageArgs(undefined)).toMatch(/agent id/);
  });

  it("checks start_agent", () => {
    expect(startArgs({ prompt: "do it", agent: "codex", cwd: "", worktree: "fix-1" })).toEqual({
      prompt: "do it",
      agent: "codex",
      cwd: undefined,
      name: undefined,
      worktree: "fix-1",
    });
    expect(startArgs({})).toMatch(/empty/);
  });

  it("lists agents", () => {
    expect(agentList([])).toMatch(/No agent/);
    expect(JSON.parse(agentList([{ id: 3, name: "Rift", agent: "claude", status: "idle", you: true }]))).toEqual([
      { id: 3, name: "Rift", agent: "claude", status: "idle", you: true },
    ]);
  });
});
