import { expect, it } from "vitest";
import { commitFiles, diffLineClass } from "./diff";

it("classifies unified diff lines", () => {
  const diff = [
    "diff --git a/x b/x",
    "index 1..2 100644",
    "--- a/x",
    "+++ b/x",
    "@@ -1,2 +1,2 @@",
    " one",
    "-two",
    "+TWO",
  ];
  expect(diff.map(diffLineClass)).toEqual(["meta", "meta", "meta", "meta", "hunk", "", "del", "add"]);
});

it("lists files to commit, with both sides of a rename", () => {
  expect(
    commitFiles([
      { path: "a.ts", status: "M" },
      { path: "new.ts", status: "?" },
      { path: "b2.ts", status: "R", orig: "b.ts" },
    ]),
  ).toEqual([
    ["a.ts", false],
    ["new.ts", true],
    ["b2.ts", false],
    ["b.ts", false],
  ]);
});
