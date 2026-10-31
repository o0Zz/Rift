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

/**
 * The file an image of the Markdown file at `doc` points to, when it is a local relative path
 * (`docs/shot.png`, `../x.svg`); undefined for web, data or absolute URLs, which load as they are.
 */
export function localImage(src: string, doc: string): string | undefined {
  if (!src || /^([a-z][a-z0-9+.-]*:|\/|#)/i.test(src)) return;
  const dir = doc.slice(0, Math.max(doc.lastIndexOf("/"), doc.lastIndexOf("\\")) + 1);
  return dir + decodeURIComponent(src.split(/[?#]/)[0]);
}
