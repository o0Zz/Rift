import { expect, it } from "vitest";
import { commitFiles, commitRange, diffLineClass, discardQuestion, FETCH_EVERY, fetchDue, inRange, keepChecked, pickCommits } from "./diff";

it("fetches a repo at most once per window unless forced", () => {
  const last = new Map<string, number>();
  expect(fetchDue(last, "a", 0)).toBe(true);
  expect(fetchDue(last, "a", FETCH_EVERY - 1)).toBe(false);
  expect(fetchDue(last, "b", 1)).toBe(true); // per repo
  expect(fetchDue(last, "a", 2, true)).toBe(true); // ⟳
  expect(fetchDue(last, "a", 3)).toBe(false); // the forced one counts
  expect(fetchDue(last, "a", 2 + FETCH_EVERY)).toBe(true);
});

it("keeps the user's unchecks across a reload and checks new files", () => {
  const before = [{ path: "a", status: "M" }, { path: "b", status: "M" }, { path: "gone", status: "M" }];
  const after = [{ path: "a", status: "M" }, { path: "b", status: "M" }, { path: "new", status: "?" }];
  expect([...keepChecked(new Set(["a", "gone"]), before, after)]).toEqual(["a", "new"]);
});

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

it("asks before discarding, saying what is lost and what goes to the trash", () => {
  expect(discardQuestion([{ path: "a.ts", status: "M" }], "Trash")).toBe(
    "Discard the changes to a.ts? Their changes are lost for good.",
  );
  expect(discardQuestion([{ path: "n.ts", status: "?" }], "Recycle Bin")).toBe(
    "Discard the changes to n.ts? New files go to the Recycle Bin.",
  );
  expect(
    discardQuestion(
      [
        { path: "a.ts", status: "M" },
        { path: "b.ts", status: "A" },
      ],
      "Trash",
    ),
  ).toBe("Discard the changes to 2 files? Their changes are lost for good. New files go to the Trash.");
});

it("picks one commit, or a range with Shift (oldest to newest, both included)", () => {
  expect(pickCommits([], "b", true)).toEqual(["b"]); // no anchor yet
  expect(pickCommits(["a"], "b", false)).toEqual(["b"]);
  expect(pickCommits(["a"], "b", true)).toEqual(["a", "b"]);
  expect(pickCommits(["a", "b"], "c", true)).toEqual(["a", "c"]); // the anchor stays
  expect(pickCommits(["a"], "a", true)).toEqual(["a"]);

  const order = ["new", "mid", "old", "first"]; // the log, newest first
  expect(commitRange(order, [])).toBeUndefined();
  expect(commitRange(order, ["mid"])).toEqual({ to: "mid", count: 1 });
  expect(commitRange(order, ["new", "old"])).toEqual({ from: "old", to: "new", count: 3 });
  expect(commitRange(order, ["first", "mid"])).toEqual({ from: "first", to: "mid", count: 3 });

  expect(order.filter((h) => inRange(order, ["old", "new"], h))).toEqual(["new", "mid", "old"]);
  expect(order.filter((h) => inRange(order, ["mid"], h))).toEqual(["mid"]);
  expect(order.filter((h) => inRange(order, [], h))).toEqual([]);
});
