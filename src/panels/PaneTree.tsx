import { createMemo, For, Show, type JSX } from "solid-js";
import { isGroup, isOpen, type Group, type Pane, type PanelId, type Split } from "./panes";

/** Drag type of a panel (its header or tab) being moved elsewhere. */
export const PANEL_DRAG_TYPE = "application/x-rift-panel";

type Props = {
  /** Every pane by id: a pane re-renders only when its own entry changes, never because a sibling moved. */
  panes(): Map<string, Pane>;
  name(id: PanelId): string;
  render(id: PanelId): JSX.Element;
  onShow(id: PanelId): void;
  onSizes(split: string, sizes: number[]): void;
  onDragging(dragging: boolean): void;
  onDragPanel(id: PanelId | undefined): void;
};

/**
 * The tree of splits. A split lays out its open children with a drag handle between each two; a group shows
 * one panel, with a row of tabs when it holds several. Drag a panel's header or tab to move it (App lights up
 * where it would go). Only shown panels are mounted (panels load when shown); terminals keep their shell alive.
 */
export function PaneView(props: Props & { id: string; style?: JSX.CSSProperties }) {
  // Keeps the last value while the pane is being removed (its parent drops it in the same update).
  const pane = createMemo<Pane>((last) => props.panes().get(props.id) ?? last, props.panes().get(props.id)!);
  // A pane's kind never changes for its id: a group split in two gets a new parent, it does not become one.
  return isGroup(pane()!) ? (
    <GroupView {...props} group={() => pane() as Group} />
  ) : (
    <SplitView {...props} split={() => pane() as Split} />
  );
}

function SplitView(props: Props & { split(): Split; style?: JSX.CSSProperties }) {
  const open = () => props.split().children.flatMap((c, i) => (isOpen(c) ? [{ id: c.id, i }] : []));
  const ids = () => open().map((o) => o.id);
  const row = () => props.split().dir === "row";
  const weight = (id: string) => props.split().sizes[props.split().children.findIndex((c) => c.id === id)] ?? 1;

  // Moves the boundary before child `id`: the two neighbours trade room, their total weight kept.
  function drag(e: PointerEvent, id: string) {
    e.preventDefault();
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    const a = handle.previousElementSibling as HTMLElement;
    const b = handle.nextElementSibling as HTMLElement;
    const size = (el: HTMLElement) => (row() ? el.offsetWidth : el.offsetHeight);
    const [pa, pb] = [size(a), size(b)];
    const ib = props.split().children.findIndex((c) => c.id === id);
    const ia = props.split().children.findIndex((c) => c.id === open()[open().findIndex((o) => o.id === id) - 1].id);
    const total = props.split().sizes[ia] + props.split().sizes[ib];
    const from = row() ? e.clientX : e.clientY;
    props.onDragging(true);
    const move = (ev: PointerEvent) => {
      const px = Math.min(pa + pb - 80, Math.max(80, pa + (row() ? ev.clientX : ev.clientY) - from));
      const sizes = [...props.split().sizes];
      sizes[ia] = (total * px) / (pa + pb);
      sizes[ib] = total - sizes[ia];
      props.onSizes(props.split().id, sizes);
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      props.onDragging(false);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  }

  return (
    <div class="split" classList={{ row: row(), col: !row() }} style={props.style}>
      <For each={ids()}>
        {(id, i) => (
          <>
            <Show when={i() > 0}>
              <div class="split-handle" onPointerDown={(e) => drag(e, id)} />
            </Show>
            <PaneView {...props} id={id} style={{ flex: `${weight(id)} 1 0` }} />
          </>
        )}
      </For>
    </div>
  );
}

function GroupView(props: Props & { group(): Group; style?: JSX.CSSProperties }) {
  const startDrag = (e: DragEvent, id: PanelId) => {
    e.dataTransfer!.setData(PANEL_DRAG_TYPE, id);
    e.dataTransfer!.effectAllowed = "move";
    // Next tick: changing the DOM during dragstart cancels the drag.
    setTimeout(() => props.onDragPanel(id));
  };
  const isHead = (e: Event) => (e.target as Element).classList?.contains("panel-head");
  return (
    <div
      class="pane-group"
      data-pane={props.group().id}
      style={props.style}
      // The header (each panel renders its own) becomes draggable when pressed outside its buttons.
      onPointerDown={(e) => {
        const head = (e.target as Element).closest<HTMLElement>(".panel-head");
        if (head) head.draggable = !(e.target as Element).closest("button, input, textarea");
      }}
      onDragStart={(e) => isHead(e) && startDrag(e, props.group().shown!)}
      onDragEnd={(e) => isHead(e) && props.onDragPanel(undefined)}
    >
      <Show when={props.group().panels.length > 1}>
        <div class="pane-tabs">
          <For each={props.group().panels}>
            {(id) => (
              <button
                class="pane-tab"
                classList={{ on: id === props.group().shown }}
                draggable={true}
                onClick={() => props.onShow(id)}
                onDragStart={(e) => startDrag(e, id)}
                onDragEnd={() => props.onDragPanel(undefined)}
              >
                {props.name(id)}
              </button>
            )}
          </For>
        </div>
      </Show>
      <Show when={props.group().shown} keyed>
        {(id) => props.render(id)}
      </Show>
    </div>
  );
}
