import { createSignal, For, Show, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import { COLORS } from "../tabs/layout";
import { Icon } from "./Icon";

type Action = { label: string; run(): void };
export type MenuItem = Action | { colors(color: string | undefined): void; heading?: string } | "separator";
const isAction = (item: MenuItem): item is Action => typeof item === "object" && "label" in item;

/**
 * A right-click menu: `open(event, items)` shows it, `<Menu />` renders it. Keyboard: ↑ ↓ to move, Enter to run,
 * Escape (or a click elsewhere) to close. `onClosed` runs after a keyboard choice, e.g. to give focus back.
 */
export function createMenu(onClosed?: () => void) {
  const [menu, setMenu] = createSignal<{ x: number; y: number; items: MenuItem[] }>();
  const [index, setIndex] = createSignal(-1);
  const close = () => setMenu(undefined);

  function open(e: MouseEvent, items: MenuItem[]) {
    e.preventDefault();
    e.stopPropagation();
    setIndex(-1);
    setMenu({ x: e.clientX, y: e.clientY, items });
  }

  function Menu() {
    onMount(() => {
      const onDown = (e: MouseEvent) => !(e.target as Element).closest(".menu") && close();
      window.addEventListener("mousedown", onDown);
      onCleanup(() => window.removeEventListener("mousedown", onDown));
    });
    // In <body>: the sidebar's `contain: paint` would clip a menu rendered inside it.
    return (
      <Portal>
      <Show when={menu()}>
        {(m) => {
          const actions = () => m().items.filter(isAction);
          const choose = (item: Action) => (close(), item.run());
          const onKey = (e: KeyboardEvent) => {
            const n = actions().length;
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              setIndex((i) => (e.key === "ArrowDown" ? (i + 1) % n : (i - 1 + n) % n));
            } else if (e.key === "Enter" && actions()[index()]) {
              e.preventDefault();
              choose(actions()[index()]);
              onClosed?.();
            } else if (e.key === "Escape") {
              close();
              onClosed?.();
            }
            e.stopPropagation();
          };
          return (
            <div
              class="menu"
              tabIndex={-1}
              ref={(el) => queueMicrotask(() => el.focus())}
              onKeyDown={onKey}
              style={{ left: `${m().x}px`, top: `${m().y}px` }}
            >
              <For each={m().items}>
                {(item) =>
                  item === "separator" ? (
                    <div class="menu-sep" />
                  ) : "colors" in item ? (
                    <div class="menu-colors">
                      <Show when={item.heading}>
                        <span class="menu-colors-heading">{item.heading}</span>
                      </Show>
                      <For each={COLORS}>
                        {(c) => <span class="swatch" style={{ background: c }} onClick={() => (item.colors(c), close())} />}
                      </For>
                      <span class="swatch none" title="No color" onClick={() => (item.colors(undefined), close())}>
                        <Icon name="close" size={10} />
                      </span>
                    </div>
                  ) : (
                    <div
                      class="menu-item"
                      classList={{ active: actions().indexOf(item) === index() }}
                      onMouseEnter={() => setIndex(actions().indexOf(item))}
                      onClick={() => choose(item)}
                    >
                      {item.label}
                    </div>
                  )
                }
              </For>
            </div>
          );
        }}
      </Show>
      </Portal>
    );
  }

  return { open, Menu };
}
