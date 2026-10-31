// Prompts prepared in advance, one list per repo (prompts.json). Pure: unit-tested in promptLists.test.ts.

/** Repo key → its prompts, in order. */
export type PromptLists = Record<string, string[]>;

/** Same folder whatever the case, separators or trailing slash (Windows paths come both ways). */
export function promptKey(root: string): string {
  return root.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function withList(lists: PromptLists, key: string, list: string[]): PromptLists {
  const next = { ...lists };
  if (list.length) next[key] = list;
  else delete next[key];
  return next;
}

/** Adds a prompt at the end; blank text is ignored. */
export function addPrompt(lists: PromptLists, key: string, text: string): PromptLists {
  return text.trim() ? withList(lists, key, [...(lists[key] ?? []), text.trim()]) : lists;
}

/** Replaces a prompt's text; editing it down to nothing deletes it. */
export function editPrompt(lists: PromptLists, key: string, index: number, text: string): PromptLists {
  const list = [...(lists[key] ?? [])];
  if (text.trim()) list[index] = text.trim();
  else list.splice(index, 1);
  return withList(lists, key, list);
}

export function removePrompt(lists: PromptLists, key: string, index: number): PromptLists {
  return withList(lists, key, (lists[key] ?? []).filter((_, i) => i !== index));
}

/** Enter saves a prompt being written; Shift+Enter is a new line (and nothing fires mid IME composition). */
export function isSaveKey(e: { key: string; shiftKey: boolean; isComposing?: boolean }): boolean {
  return e.key === "Enter" && !e.shiftKey && !e.isComposing;
}

/** Saved prompts (any shape, possibly edited by hand) → valid lists. */
export function mergePrompts(saved: unknown): PromptLists {
  const lists: PromptLists = {};
  if (!saved || typeof saved !== "object") return lists;
  for (const [key, list] of Object.entries(saved)) {
    const texts = Array.isArray(list) ? list.filter((t): t is string => typeof t === "string" && !!t.trim()) : [];
    if (texts.length) lists[key] = texts;
  }
  return lists;
}
