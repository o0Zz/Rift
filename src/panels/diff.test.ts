// @vitest-environment node
import { expect, it } from "vitest";
import { diffLineClass } from "./diff";

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
