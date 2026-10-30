// Markdown reader of a document tab. Loaded on first use.
import { marked } from "marked";
import DOMPurify from "dompurify";

/**
 * Markdown → HTML, sanitized: the page can call Rift's commands (type into a shell...), so a file must
 * never bring scripts, event handlers or forms with it.
 */
export function renderMarkdown(text: string): string {
  const html = marked.parse(text, { gfm: true, async: false }) as string;
  return DOMPurify.sanitize(html, { FORBID_TAGS: ["style", "form", "iframe"], FORBID_ATTR: ["style"] });
}
