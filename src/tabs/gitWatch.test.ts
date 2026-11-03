import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => ({ added: 1, deleted: 0 })) }));
import { createGitWatch } from "./gitWatch";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const watch = (shows = "C:/repo") => createGitWatch({ panelShows: (root) => root === shows });

it("reloads the panel once per burst of prompts in its repo", () => {
  const git = watch();
  git.promptCameBack("C:/repo");
  git.promptCameBack("C:/repo");
  vi.advanceTimersByTime(299);
  expect(git.refresh()).toBe(0);
  vi.advanceTimersByTime(1);
  expect(git.refresh()).toBe(1);
});

it("does not reload for a prompt in another repo, but remembers it changed", () => {
  const git = watch();
  git.promptCameBack("C:/other");
  vi.advanceTimersByTime(300);
  expect(git.refresh()).toBe(0);
  // The panels move to that repo's tab: another repo loads anyway (not a reload in place).
  git.panelTabChanged("C:/other", false);
  expect(git.refresh()).toBe(0);
});

it("on a switch back to the same repo, reloads only if something changed it", () => {
  const git = watch();
  git.panelTabChanged("C:/repo", true);
  expect(git.refresh()).toBe(0);
  git.agentMoved("C:/repo", false); // working: marks the repo, no reload yet
  expect(git.refresh()).toBe(0);
  git.panelTabChanged("C:/repo", true);
  expect(git.refresh()).toBe(1);
  git.panelTabChanged("C:/repo", true); // already reloaded
  expect(git.refresh()).toBe(1);
});

it("reloads at once when an agent finishes in the shown repo", () => {
  const git = watch();
  git.agentMoved("C:/repo", true);
  expect(git.refresh()).toBe(1);
  git.agentMoved("C:/other", true);
  expect(git.refresh()).toBe(1);
});

it("refreshes a tab's stats once per burst, 1.5 s later", async () => {
  const git = watch();
  const tab = { root: "C:/repo", stats: undefined } as unknown as Parameters<typeof git.stats>[0];
  git.stats(tab);
  git.stats(tab);
  await vi.advanceTimersByTimeAsync(1500);
  const { invoke } = await import("@tauri-apps/api/core");
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(tab.stats).toEqual({ added: 1, deleted: 0 });
});
