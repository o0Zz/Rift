import { expect, it } from "vitest";
import { quotePath } from "./paths";

it("quotes paths only when the shell needs it", () => {
  expect(quotePath("C:\\Dev\\rift\\src\\App.tsx")).toBe("C:\\Dev\\rift\\src\\App.tsx");
  expect(quotePath("/home/me/notes.md")).toBe("/home/me/notes.md");
  expect(quotePath("C:\\My Projects\\a.ts")).toBe('"C:\\My Projects\\a.ts"');
  expect(quotePath("/tmp/a&b")).toBe('"/tmp/a&b"');
  expect(quotePath('/tmp/say "hi"')).toBe('"/tmp/say \\"hi\\""');
});
