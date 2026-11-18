import { expect, it } from "vitest";
import { fileManagerName, isDeleteKey, isUnder, parentDir, repoPath, typeAhead, visibleRows, type Entry } from "./fileOps";

it("deletes on Delete, and on Cmd+Backspace on macOS only", () => {
  expect(isDeleteKey({ key: "Delete", metaKey: false }, false)).toBe(true);
  expect(isDeleteKey({ key: "Backspace", metaKey: true }, true)).toBe(true);
  expect(isDeleteKey({ key: "Backspace", metaKey: true }, false)).toBe(false);
  expect(isDeleteKey({ key: "Backspace", metaKey: false }, true)).toBe(false);
});

it("finds the files a deletion takes with it", () => {
  expect(isUnder("C:\\repo\\src\\a.ts", "C:\\repo\\src")).toBe(true);
  expect(isUnder("C:\\repo\\src", "C:\\repo\\src")).toBe(true);
  expect(isUnder("C:\\repo\\src2\\a.ts", "C:\\repo\\src")).toBe(false);
  expect(isUnder("C:\\repo\\src\\a.ts", "C:/repo/src/")).toBe(true);
  expect(isUnder("/home/me/a.md", "/home/me/a.md")).toBe(true);
});

it("ignores case where the file system does (Windows, macOS), not on Linux", () => {
  expect(isUnder("c:\\repo\\SRC\\a.ts", "C:\\Repo\\src", true)).toBe(true);
  expect(isUnder("/home/me/Docs/a.md", "/home/me/docs", false)).toBe(false);
  expect(isUnder("/home/me/docs/a.md", "/home/me/docs", false)).toBe(true);
});

it("names a file as git does in its repo", () => {
  expect(repoPath("C:\\Repo", "C:\\Repo\\src\\a.ts", true)).toBe("src/a.ts");
  expect(repoPath("C:\\Repo\\", "c:\\repo\\README.md", true)).toBe("README.md");
  expect(repoPath("/home/me/repo", "/home/me/repo/src/a b.ts", false)).toBe("src/a b.ts");
  expect(repoPath("/home/me/repo", "/home/me/other/a.ts", false)).toBeUndefined();
  expect(repoPath("/home/me/repo", "/home/me/repo", false)).toBeUndefined();
});

it("names the file manager of each OS", () => {
  expect(fileManagerName(true, false)).toBe("File Explorer");
  expect(fileManagerName(false, true)).toBe("Finder");
  expect(fileManagerName(false, false)).toBe("file manager");
});

it("goes up one folder, never above a root", () => {
  expect(parentDir("C:\\Dev\\oozz")).toBe("C:\\Dev");
  expect(parentDir("C:\\Dev\\")).toBe("C:\\");
  expect(parentDir("C:\\")).toBe(undefined);
  expect(parentDir("/home/me")).toBe("/home");
  expect(parentDir("/home")).toBe("/");
  expect(parentDir("/")).toBe(undefined);
});

it("lists the rows shown, open folders' entries under them", () => {
  const listings = new Map<string, Entry[] | string>([
    ["C:\\r", [{ name: "src", dir: true }, { name: "lib", dir: true }, { name: "a.md", dir: false }]],
    ["C:\\r\\src", [{ name: "x.ts", dir: false }]],
    ["C:\\r\\lib", "denied"],
  ]);
  const rows = visibleRows("C:\\r", listings, new Set(["C:\\r\\src", "C:\\r\\lib"]));
  expect(rows.map((r) => r.path)).toEqual(["C:\\r\\src", "C:\\r\\src\\x.ts", "C:\\r\\lib", "C:\\r\\a.md"]);
  expect(rows[1].parent).toBe("C:\\r\\src");
  expect(visibleRows("C:\\r", listings, new Set()).map((r) => r.name)).toEqual(["src", "lib", "a.md"]);
  expect(visibleRows("/r", new Map([["/r", [{ name: "a", dir: false }]]]), new Set())[0].path).toBe("/r/a");
});

it("selects by typing, as File Explorer does", () => {
  const names = ["App.tsx", "bench.ts", "Button.tsx", "build", "index.ts"];
  expect(typeAhead(names, -1, "b")).toBe(1);
  expect(typeAhead(names, 1, "b")).toBe(2); // the same letter again: the next one
  expect(typeAhead(names, 3, "b")).toBe(1); // wraps
  expect(typeAhead(names, 1, "bu")).toBe(2);
  expect(typeAhead(names, 2, "bui")).toBe(3);
  expect(typeAhead(names, 2, "bu")).toBe(2); // still matching: stays
  expect(typeAhead(names, 2, "bb")).toBe(3);
  expect(typeAhead(names, 0, "z")).toBe(-1);
});
