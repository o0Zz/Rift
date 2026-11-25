import { expect, it } from "vitest";
import { quotePath, windowsPaths } from "./paths";

it("quotes paths only when the shell needs it", () => {
  expect(quotePath("C:\\Dev\\rift\\src\\App.tsx")).toBe("C:\\Dev\\rift\\src\\App.tsx");
  expect(quotePath("/home/me/notes.md")).toBe("/home/me/notes.md");
  expect(quotePath("C:\\My Projects\\a.ts")).toBe('"C:\\My Projects\\a.ts"');
  expect(quotePath("/tmp/a&b")).toBe('"/tmp/a&b"');
  expect(quotePath('/tmp/say "hi"')).toBe('"/tmp/say \\"hi\\""');
});

it("finds Windows paths in a line, without what follows them", () => {
  const paths = (line: string) => windowsPaths(line).map((p) => p.path);
  expect(paths("Wrote C:\\Dev\\rift\\src\\App.tsx")).toEqual(["C:\\Dev\\rift\\src\\App.tsx"]);
  expect(paths("see I:/share/notes.md, then D:\\x")).toEqual(["I:/share/notes.md", "D:\\x"]);
  expect(paths("error at C:\\a\\b.ts:12:5: oops")).toEqual(["C:\\a\\b.ts"]);
  expect(paths("(C:\\a\\b.ts:12).")).toEqual(["C:\\a\\b.ts"]);
  expect(paths('"C:\\a b\\c.txt"')).toEqual(["C:\\a"]); // a space ends it
  expect(paths("ABC:\\x and 12:30 and http://x")).toEqual([]);
  expect(windowsPaths("at C:\\x.")).toEqual([{ path: "C:\\x", start: 3, end: 7 }]);
});
