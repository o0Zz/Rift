import { resized } from "./resize";

/**
 * Drag handle on a box's edge: `right` sets the width of the box it sits in (the tab list), `bottom` goes right
 * after its box (in the flow) and sets its height; without a `size` yet it starts from the box's rendered height.
 */
export function Resizer(props: {
  edge: "right" | "bottom";
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
    const vertical = props.edge === "bottom";
    const at = (ev: PointerEvent) => (vertical ? ev.clientY : ev.clientX);
    const from = at(e);
    const start = props.size ?? (el.previousElementSibling as HTMLElement).offsetHeight;
    props.onDragging?.(true);
    const move = (ev: PointerEvent) => props.onResize(resized(start, at(ev) - from, props.min, props.max));
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
