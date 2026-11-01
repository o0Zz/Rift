import { resized } from "./resize";

/**
 * Drag handle on a box's edge. `edge` is the side of the box it sits on: a left-side panel has its handle on
 * its right edge (dragging right widens it), the right-side git panel on its left edge. A `bottom` handle
 * goes right after its box (in the flow) and sets its height; without a `size` yet it starts from the
 * box's rendered height. A `top` handle sits on the top edge of a box docked at the bottom (dragging up grows it).
 */
export function Resizer(props: {
  edge: "left" | "right" | "top" | "bottom";
  size?: number;
  min: number;
  max: number;
  onResize(size: number): void;
  onDragging?(dragging: boolean): void;
}) {
  function down(e: PointerEvent) {
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const vertical = props.edge === "top" || props.edge === "bottom";
    const at = (ev: PointerEvent) => (vertical ? ev.clientY : ev.clientX);
    const from = at(e);
    const box = (props.edge === "bottom" ? el.previousElementSibling : el.parentElement) as HTMLElement;
    const start = props.size ?? (vertical ? box.offsetHeight : box.offsetWidth);
    props.onDragging?.(true);
    const move = (ev: PointerEvent) => props.onResize(resized(props.edge, start, at(ev) - from, props.min, props.max));
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      props.onDragging?.(false);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  }
  return <div class={`resizer ${props.edge}`} onPointerDown={down} />;
}
