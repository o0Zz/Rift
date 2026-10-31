import { expect, it } from "vitest";
import { addPrompt, editPrompt, mergePrompts, promptKey, removePrompt } from "./promptLists";

it("keys a repo the same way whatever the path spelling", () => {
  expect(promptKey("C:\\Dev\\Rift\\")).toBe(promptKey("c:/dev/rift"));
});

it("adds, edits and removes prompts per repo", () => {
  let lists = addPrompt({}, "a", "  fix the bench  ");
  lists = addPrompt(lists, "a", "add tests");
  lists = addPrompt(lists, "b", "other repo");
  lists = addPrompt(lists, "a", "   ");
  expect(lists).toEqual({ a: ["fix the bench", "add tests"], b: ["other repo"] });

  lists = editPrompt(lists, "a", 1, "add e2e tests");
  expect(lists.a).toEqual(["fix the bench", "add e2e tests"]);
  lists = editPrompt(lists, "a", 0, "");
  expect(lists.a).toEqual(["add e2e tests"]);

  lists = removePrompt(lists, "a", 0);
  expect(lists).toEqual({ b: ["other repo"] }); // an emptied list is dropped
});

it("reads any saved shape", () => {
  expect(mergePrompts(null)).toEqual({});
  expect(mergePrompts({ a: ["x", 3, "", "y"], b: "nope", c: [] })).toEqual({ a: ["x", "y"] });
});
