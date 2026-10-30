/**
 * Drag handle on a panel's edge. `edge` is the side of the panel it sits on: a left-side panel has its
 * handle on its right edge (dragging right widens it), the right-side git panel on its left edge.
 */
export function Resizer(props: {
  edge: "left" | "right";
  width: number;
  min: number;
  max: number;
  onResize(width: number): void;
  onDragging(dragging: boolean): void;
}) {
  function down(e: PointerEvent) {
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startWidth = props.width;
    const sign = props.edge === "right" ? 1 : -1;
    props.onDragging(true);
    const move = (ev: PointerEvent) =>
      props.onResize(Math.min(props.max, Math.max(props.min, startWidth + sign * (ev.clientX - startX))));
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      props.onDragging(false);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  }
  return <div class={`resizer ${props.edge}`} onPointerDown={down} />;
}
