import { createSignal, For, Show, onCleanup, onMount } from "solid-js";
import { COLORS } from "../tabs/layout";

export type MenuItem = { label: string; run(): void } | { colors(color: string | undefined): void } | "separator";

/** A right-click menu: `open(event, items)` shows it, `<Menu />` renders it. Closes on outside click or Escape. */
export function createMenu() {
  const [menu, setMenu] = createSignal<{ x: number; y: number; items: MenuItem[] }>();
  const close = () => setMenu(undefined);

  function open(e: MouseEvent, items: MenuItem[]) {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, items });
  }

  function Menu() {
    onMount(() => {
      const onDown = (e: MouseEvent) => !(e.target as Element).closest(".menu") && close();
      const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
      window.addEventListener("mousedown", onDown);
      window.addEventListener("keydown", onKey);
      onCleanup(() => {
        window.removeEventListener("mousedown", onDown);
        window.removeEventListener("keydown", onKey);
      });
    });
    return (
      <Show when={menu()}>
        {(m) => (
          <div class="menu" style={{ left: `${m().x}px`, top: `${m().y}px` }}>
            <For each={m().items}>
              {(item) =>
                item === "separator" ? (
                  <div class="menu-sep" />
                ) : "colors" in item ? (
                  <div class="menu-colors">
                    <For each={COLORS}>
                      {(c) => <span class="swatch" style={{ background: c }} onClick={() => (item.colors(c), close())} />}
                    </For>
                    <span class="swatch none" title="No color" onClick={() => (item.colors(undefined), close())}>
                      ×
                    </span>
                  </div>
                ) : (
                  <div class="menu-item" onClick={() => (close(), item.run())}>
                    {item.label}
                  </div>
                )
              }
            </For>
          </div>
        )}
      </Show>
    );
  }

  return { open, Menu };
}
