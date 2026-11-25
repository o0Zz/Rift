import { describe, expect, it } from "vitest";
import { fileUrlPath, printedPaths, quotePath } from "./paths";

it("quotes paths only when the shell needs it", () => {
  expect(quotePath("C:\\Dev\\rift\\src\\App.tsx")).toBe("C:\\Dev\\rift\\src\\App.tsx");
  expect(quotePath("/home/me/notes.md")).toBe("/home/me/notes.md");
  expect(quotePath("C:\\My Projects\\a.ts")).toBe('"C:\\My Projects\\a.ts"');
  expect(quotePath("/tmp/a&b")).toBe('"/tmp/a&b"');
  expect(quotePath('/tmp/say "hi"')).toBe('"/tmp/say \\"hi\\""');
});

it("turns file:// addresses into local paths", () => {
  expect(fileUrlPath("file:///C:/My%20Docs/a.md", true)).toBe("C:/My Docs/a.md");
  expect(fileUrlPath("file://localhost/C:/x", true)).toBe("C:/x");
  expect(fileUrlPath("file:///var/log/x.log", false)).toBe("/var/log/x.log");
  expect(fileUrlPath("file:///var/log/x.log", true)).toBeUndefined(); // not a Windows path
  expect(fileUrlPath("file://server/share/x", true)).toBeUndefined(); // another host
  expect(fileUrlPath("file:///bad%E0", false)).toBeUndefined();
  expect(fileUrlPath("https://x.com/a", false)).toBeUndefined();
});

describe("printedPaths", () => {
  const paths = (line: string, windows: boolean) => printedPaths(line, windows).map((p) => p.path);

  it("finds drive paths of any letter on Windows, without what follows them", () => {
    expect(paths("Wrote C:\\Dev\\rift\\src\\App.tsx", true)).toEqual(["C:\\Dev\\rift\\src\\App.tsx"]);
    expect(paths("see i:/share/notes.md, then Z:\\x", true)).toEqual(["i:/share/notes.md", "Z:\\x"]);
    expect(paths("error at C:\\a\\b.ts:12:5: oops", true)).toEqual(["C:\\a\\b.ts"]);
    expect(paths("(C:\\a\\b.ts:12).", true)).toEqual(["C:\\a\\b.ts"]);
    expect(paths('"C:\\a b\\c.txt"', true)).toEqual(["C:\\a"]); // a space ends it
    expect(paths("ABC:\\x and 12:30 and http://x", true)).toEqual([]);
    expect(printedPaths("at C:\\x.", true)).toEqual([{ path: "C:\\x", start: 3, end: 7 }]);
  });

  it("reads Git Bash paths and file:// addresses on Windows, not Unix paths", () => {
    expect(paths("cd /c/Dev/rift", true)).toEqual(["C:\\Dev\\rift"]);
    expect(paths("open file:///D:/My%20Docs/a.md.", true)).toEqual(["D:/My Docs/a.md"]);
    expect(paths("/var/cache/x and /usr/bin", true)).toEqual([]);
    const [url] = printedPaths("go file:///C:/x now", true);
    expect(url).toEqual({ path: "C:/x", start: 3, end: 15 });
  });

  it("finds absolute paths elsewhere, never parts of words or URLs", () => {
    expect(paths("log in /var/cache/app/x.log:3", false)).toEqual(["/var/cache/app/x.log"]);
    expect(paths('"/home/me/a.md" (/tmp/b) --out=/srv/c/', false)).toEqual(["/home/me/a.md", "/tmp/b", "/srv/c/"]);
    expect(paths("/etc/hosts", false)).toEqual(["/etc/hosts"]);
    expect(paths("file:///var/log/x.log", false)).toEqual(["/var/log/x.log"]);
    expect(paths("and/or 1/2 https://x.com/a/b /tmp a / b", false)).toEqual([]);
    expect(paths("C:\\x", false)).toEqual([]);
  });
});
