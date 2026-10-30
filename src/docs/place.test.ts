import { describe, expect, it } from "vitest";
import { afterClose, placeDoc, sameFile } from "./place";

const doc = (path: string, dirty = false) => ({ path, dirty });

describe("placeDoc", () => {
  it("shows a file that is already open", () => {
    expect(placeDoc([doc("C:\\r\\a.md"), doc("C:\\r\\b.ts")], -1, "c:/r/B.ts", true)).toEqual({ index: 1, replace: false });
  });

  it("one at a time: replaces the shown document, or the last one when the terminal is shown", () => {
    const docs = [doc("a.md"), doc("b.ts")];
    expect(placeDoc(docs, 0, "c.cpp", true)).toEqual({ index: 0, replace: true });
    expect(placeDoc(docs, -1, "c.cpp", true)).toEqual({ index: 1, replace: true });
    expect(placeDoc([], -1, "c.cpp", true)).toEqual({ index: 0, replace: false });
  });

  it("never replaces a document with unsaved changes", () => {
    expect(placeDoc([doc("a.md", true)], 0, "c.cpp", true)).toEqual({ index: 1, replace: false });
  });

  it("new tab each time: always adds", () => {
    expect(placeDoc([doc("a.md")], 0, "c.cpp", false)).toEqual({ index: 1, replace: false });
  });
});

describe("afterClose", () => {
  it("keeps the shown document, or falls back to the previous one, then the terminal", () => {
    expect(afterClose(2, 0)).toBe(1);
    expect(afterClose(0, 2)).toBe(0);
    expect(afterClose(1, 1)).toBe(0);
    expect(afterClose(0, 0)).toBe(-1);
    expect(afterClose(-1, 0)).toBe(-1);
  });
});

describe("sameFile", () => {
  it("ignores case and separators", () => {
    expect(sameFile("C:\\Repo\\README.md", "c:/repo/readme.md")).toBe(true);
    expect(sameFile("a.md", "b.md")).toBe(false);
  });
});
