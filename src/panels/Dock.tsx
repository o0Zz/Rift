import { For, Index, Show, type JSX } from "solid-js";
import { createMenu } from "../ui/Menu";
import { Resizer } from "../ui/Resizer";
import type { Dock, PanelId, Side, Target } from "./docks";

/** Drag type of a dock tab being moved elsewhere. */
export const PANEL_DRAG_TYPE = "application/x-rift-panel";

const LIMITS: Record<Side, [number, number]> = { left: [160, 800], right: [220, 1000], bottom: [80, 900] };
const HANDLE: Record<Side, "left" | "right" | "top"> = { left: "right", right: "left", bottom: "top" };

/**
 * One dock: up to two groups (stacked on the sides, side by side at the bottom), each showing one panel with a
 * row of tabs when it holds several. Right-click a tab or a panel's header: "Move to…"; or drag a tab onto a
 * side of the window. Only shown panels are mounted (panels load when shown); terminals keep their shell alive.
 */
export function DockView(props: {
  side: Side;
  dock: Dock;
  name(id: PanelId): string;
  render(id: PanelId): JSX.Element;
  choices(id: PanelId): { label: string; target: Target }[];
  onShow(id: PanelId): void;
  onMove(id: PanelId, to: Target): void;
  onResize(size: number): void;
  onSplit(size: number): void;
  onDragging(dragging: boolean): void;
  onDragPanel(id: PanelId | undefined): void;
}) {
  const menu = createMenu();
  const moveMenu = (e: MouseEvent, id: PanelId) =>
    menu.open(e, props.choices(id).map((c) => ({ label: c.label, run: () => props.onMove(id, c.target) })));
  const open = () => props.dock.groups.filter((g) => g.shown);
  const both = () => open().length === 2;
  const across = () => props.side === "bottom"; // groups side by side
  const size = () => (across() ? { height: `${props.dock.size}px` } : { width: `${props.dock.size}px` });
  const first = (): JSX.CSSProperties =>
    both() && props.dock.split ? { flex: `0 0 ${props.dock.split}px` } : { flex: "1 1 0" };

  return (
    <Show when={open().length}>
      <div class={`pane dock ${props.side}`} style={size()}>
        <Resizer
          edge={HANDLE[props.side]}
          size={props.dock.size}
          min={LIMITS[props.side][0]}
          max={LIMITS[props.side][1]}
          onResize={props.onResize}
          onDragging={props.onDragging}
        />
        <div class="dock-groups" classList={{ across: across() }}>
          <Index each={open()}>
            {(group, i) => (
              <>
                <div
                  class="dock-group"
                  style={i === 0 ? first() : { flex: "1 1 0" }}
                  onContextMenu={(e) => (e.target as Element).closest(".panel-head") && moveMenu(e, group().shown!)}
                >
                  <Show when={i === 0 && both() && across()}>
                    <Resizer edge="right" size={props.dock.split} min={120} max={2000} onResize={props.onSplit} onDragging={props.onDragging} />
                  </Show>
                  <Show when={group().panels.length > 1}>
                    <div class="dock-tabs">
                      <For each={group().panels}>
                        {(id) => (
                          <button
                            class="dock-tab"
                            classList={{ on: id === group().shown }}
                            draggable={true}
                            onClick={() => props.onShow(id)}
                            onContextMenu={(e) => moveMenu(e, id)}
                            onDragStart={(e) => {
                              e.dataTransfer!.setData(PANEL_DRAG_TYPE, id);
                              e.dataTransfer!.effectAllowed = "move";
                              // Next tick: changing the DOM during dragstart cancels the drag.
                              setTimeout(() => props.onDragPanel(id));
                            }}
                            onDragEnd={() => props.onDragPanel(undefined)}
                          >
                            {props.name(id)}
                          </button>
                        )}
                      </For>
                    </div>
                  </Show>
                  <Show when={group().shown} keyed>
                    {(id) => props.render(id)}
                  </Show>
                </div>
                <Show when={i === 0 && both() && !across()}>
                  <Resizer edge="bottom" size={props.dock.split} min={80} max={2000} onResize={props.onSplit} onDragging={props.onDragging} />
                </Show>
              </>
            )}
          </Index>
        </div>
        <menu.Menu />
      </div>
    </Show>
  );
}
