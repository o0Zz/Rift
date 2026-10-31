// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { localImage, renderMarkdown } from "./markdown";

describe("localImage", () => {
  it("resolves relative images next to the Markdown file", () => {
    expect(localImage("docs/shot%201.png", "C:\\repo\\README.md")).toBe("C:\\repo\\docs/shot 1.png");
    expect(localImage("../x.svg?raw", "/home/me/repo/docs/a.md")).toBe("/home/me/repo/docs/../x.svg");
  });

  it("leaves web, data and absolute images alone", () => {
    for (const src of ["https://x.dev/a.png", "data:image/png;base64,AA", "/abs.png", "#x", ""]) {
      expect(localImage(src, "C:\\repo\\README.md")).toBeUndefined();
    }
  });
});

describe("renderMarkdown", () => {
  it("renders headings, tables and inline code", () => {
    const html = renderMarkdown("# Title\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nrun `npm test`");
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<td>1</td>");
    expect(html).toContain("<code>npm test</code>");
  });

  it("never lets a file bring scripts, handlers or javascript: links into Rift", () => {
    const html = renderMarkdown(
      [
        "<script>alert(1)</script>",
        '<img src="x" onerror="alert(2)">',
        "[click](javascript:alert(3))",
        '<a href="javascript:alert(4)">a</a>',
        '<iframe src="https://example.com"></iframe>',
        '<form action="x"><input></form>',
        '<p style="position:fixed">x</p>',
      ].join("\n\n"),
    );
    expect(html).not.toMatch(/<script|onerror|javascript:|<iframe|<form|style=/i);
  });
});
