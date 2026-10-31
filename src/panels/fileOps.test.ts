import { expect, it } from "vitest";
import { isDeleteKey, isUnder } from "./fileOps";

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
