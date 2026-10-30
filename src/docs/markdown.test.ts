// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./markdown";

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
