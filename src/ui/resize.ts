/** New size of a box while dragging the handle on its `edge` by `delta` px (x for left/right, y for top/bottom). */
export function resized(edge: "left" | "right" | "top" | "bottom", start: number, delta: number, min: number, max: number) {
  return Math.min(max, Math.max(min, start + (edge === "left" || edge === "top" ? -delta : delta)));
}
