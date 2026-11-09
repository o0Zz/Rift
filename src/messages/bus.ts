// Agent messaging: what Rift's MCP tools (list_agents, send_message, start_agent) do with tabs, and the log
// the messages panel shows. Pure: unit-tested in bus.test.ts.

import type { Status } from "../tabs/layout";

/** One thing that happened between agents. `to` is the receiver's pty (the new agent's, for a start). */
export type Entry = {
  id: number;
  time: number;
  kind: "message" | "start";
  from: number;
  fromName: string;
  to: number;
  toName: string;
  text: string;
  state: "queued" | "delivered" | "failed";
  /** Why it failed. */
  note?: string;
};

export const MAX_ENTRIES = 500;
/** Agents one agent may start. */
export const MAX_STARTS = 5;
const MAX_TEXT = 20_000;

/** An agent takes a message only between turns: never mid-turn, nor while it waits for the user. */
export const canReceive = (status: Status | undefined) => status === "idle" || status === "done";

/** What the receiver gets as its next prompt: who sends it, and how to answer. */
export function promptFor(e: Pick<Entry, "kind" | "from" | "fromName" | "text">): string {
  const who = `${e.fromName} (agent ${e.from})`;
  const head = e.kind === "start" ? `── Task from ${who}, who started this tab, via Rift ──` : `── Message from ${who} via Rift ──`;
  return `${head}\n${e.text}\n── To answer, use Rift's send_message tool with to: ${e.from} ──`;
}

/** The next message waiting for `to`, oldest first. */
export const nextFor = (entries: Entry[], to: number) => entries.find((e) => e.to === to && e.state === "queued");

export type Tally = { sent: number; received: number; waiting: number };

/**
 * A tab's messages (its shells are `ptys`) logged after `since`: sent by it, received by it (a started agent's
 * task counts), and still waiting for it to be idle (whenever they were sent). A failed one counts nowhere.
 */
export function tally(entries: Entry[], ptys: number[], since: number): Tally {
  const t = { sent: 0, received: 0, waiting: 0 };
  for (const e of entries) {
    if (e.state === "queued" && ptys.includes(e.to)) t.waiting++;
    if (e.state === "failed" || e.time <= since) continue;
    if (ptys.includes(e.from)) t.sent++;
    if (ptys.includes(e.to)) t.received++;
  }
  return t;
}

/** Adds `e`; past MAX_ENTRIES the oldest finished entries go (never a queued one). */
export function addEntry(entries: Entry[], e: Entry): Entry[] {
  const next = [...entries, e];
  while (next.length > MAX_ENTRIES) {
    const old = next.findIndex((x) => x.state !== "queued");
    if (old < 0) break;
    next.splice(old, 1);
  }
  return next;
}

/** Why an agent may not start another one, if it may not. */
export function startRefusal(startedByAgent: boolean, started: number): string | undefined {
  if (startedByAgent) return "An agent started by another agent cannot start agents.";
  if (started >= MAX_STARTS) return `You already started ${MAX_STARTS} agents, the limit.`;
}

const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** send_message's arguments, or what is wrong with them. */
export function messageArgs(args: unknown): { to: number; message: string } | string {
  const a = (args ?? {}) as Record<string, unknown>;
  const to = typeof a.to === "string" ? Number(a.to) : a.to;
  if (typeof to !== "number" || !Number.isInteger(to)) return "`to` must be an agent id from list_agents.";
  const message = text(a.message);
  if (!message) return "`message` is empty.";
  if (message.length > MAX_TEXT) return `\`message\` is too long (at most ${MAX_TEXT} characters).`;
  return { to, message };
}

export type StartArgs = { prompt: string; agent?: string; cwd?: string; name?: string; worktree?: string };

/** start_agent's arguments, or what is wrong with them. */
export function startArgs(args: unknown): StartArgs | string {
  const a = (args ?? {}) as Record<string, unknown>;
  const prompt = text(a.prompt);
  if (!prompt) return "`prompt` is empty.";
  if (prompt.length > MAX_TEXT) return `\`prompt\` is too long (at most ${MAX_TEXT} characters).`;
  return { prompt, agent: text(a.agent), cwd: text(a.cwd), name: text(a.name), worktree: text(a.worktree) };
}

export type AgentRow = { id: number; name: string; agent: string; status: string; folder?: string; you?: true; startedBy?: string };

/** list_agents' answer. */
export function agentList(rows: AgentRow[]): string {
  if (!rows.length) return "No agent is running in Rift.";
  return JSON.stringify(rows, null, 1);
}
