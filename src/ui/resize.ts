/** New size of a box while dragging its handle (right or bottom edge) by `delta` px, within its limits. */
export function resized(start: number, delta: number, min: number, max: number) {
  return Math.min(max, Math.max(min, start + delta));
}
