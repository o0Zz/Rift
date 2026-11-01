import { For, Show, type JSX } from "solid-js";
import { createMenu } from "../ui/Menu";
import { Resizer } from "../ui/Resizer";
import { PANEL_NAMES, SIDES, type Dock, type PanelId, type Side } from "./docks";

/** Drag type of a dock tab being moved to another dock. */
export const PANEL_DRAG_TYPE = "application/x-rift-panel";

const LIMITS: Record<Side, [number, number]> = { left: [160, 800], right: [220, 1000], bottom: [80, 900] };
const HANDLE: Record<Side, "left" | "right" | "top"> = { left: "right", right: "left", bottom: "top" };

/**
 * One dock: its shown panel, a row of tabs when it holds several, a resize handle on its inner edge.
 * Right-click a tab or a panel's header: "Move to…"; or drag a tab onto another side of the window.
 * Only the shown panel is mounted (panels load when shown); the terminal panel keeps its own shell alive.
 */
export function DockView(props: {
  side: Side;
  dock: Dock;
  render(id: PanelId): JSX.Element;
  onShow(id: PanelId): void;
  onMove(id: PanelId, to: Side): void;
  onResize(size: number): void;
  onDragging(dragging: boolean): void;
  onDragPanel(id: PanelId | undefined): void;
}) {
  const menu = createMenu();
  const moveMenu = (e: MouseEvent, id: PanelId) =>
    menu.open(
      e,
      SIDES.filter((s) => s !== props.side).map((s) => ({ label: `Move to ${s}`, run: () => props.onMove(id, s) })),
    );
  const size = () => (props.side === "bottom" ? { height: `${props.dock.size}px` } : { width: `${props.dock.size}px` });

  return (
    <Show when={props.dock.shown}>
      {(shown) => (
        <div
          class={`pane dock ${props.side}`}
          style={size()}
          onContextMenu={(e) => (e.target as Element).closest(".panel-head") && moveMenu(e, shown())}
        >
          <Resizer
            edge={HANDLE[props.side]}
            size={props.dock.size}
            min={LIMITS[props.side][0]}
            max={LIMITS[props.side][1]}
            onResize={props.onResize}
            onDragging={props.onDragging}
          />
          <Show when={props.dock.panels.length > 1}>
            <div class="dock-tabs">
              <For each={props.dock.panels}>
                {(id) => (
                  <button
                    class="dock-tab"
                    classList={{ on: id === shown() }}
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
                    {PANEL_NAMES[id]}
                  </button>
                )}
              </For>
            </div>
          </Show>
          <Show when={shown()} keyed>
            {(id) => props.render(id)}
          </Show>
          <menu.Menu />
        </div>
      )}
    </Show>
  );
}
