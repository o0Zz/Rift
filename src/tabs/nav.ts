/** Index of the neighbouring tab, wrapping around the ends. */
export function neighbour(index: number, count: number, step: 1 | -1): number {
  return (index + step + count) % count;
}

export type TabAction = "new" | "close" | "next" | "prev" | "explorer" | "git";

/** Maps a keydown to a tab action. Ctrl+T/W are left to the shell (Ctrl+W deletes a word). */
export function tabAction(e: Pick<KeyboardEvent, "key" | "ctrlKey" | "shiftKey" | "altKey">): TabAction | undefined {
  if (!e.ctrlKey || e.altKey) return;
  if (e.key === "PageDown" || (e.key === "Tab" && !e.shiftKey)) return "next";
  if (e.key === "PageUp" || (e.key === "Tab" && e.shiftKey)) return "prev";
  if (e.shiftKey && e.key.toLowerCase() === "t") return "new";
  if (e.shiftKey && e.key.toLowerCase() === "w") return "close";
  if (e.shiftKey && e.key.toLowerCase() === "e") return "explorer";
  if (e.shiftKey && e.key.toLowerCase() === "g") return "git";
}
