import { expect, it } from "vitest";
import { fileManagerName, isDeleteKey, isUnder, repoPath } from "./fileOps";

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
