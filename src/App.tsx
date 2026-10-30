import { createSignal, For, onCleanup, onMount, type Accessor, type Setter } from "solid-js";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { TermView } from "./terminal/TermView";
import { neighbour, tabAction } from "./tabs/nav";
import "./App.css";

type Tab = { view: TermView; title: Accessor<string>; setTitle: Setter<string> };

function App() {
  let host!: HTMLDivElement;
  const [tabs, setTabs] = createSignal<Tab[]>([]);
  const [active, setActive] = createSignal<Tab>();

  function activate(tab: Tab) {
    const t0 = performance.now();
    if (active() !== tab) active()?.view.hide();
    tab.view.show();
    setActive(tab);
    if (import.meta.env.DEV) {
      requestAnimationFrame(() => console.debug(`tab switch ${(performance.now() - t0).toFixed(1)} ms`));
    }
  }

  function newTab() {
    const [title, setTitle] = createSignal("shell");
    active()?.view.hide();
    const tab: Tab = { view: new TermView(host, setTitle), title, setTitle };
    setTabs([...tabs(), tab]);
    activate(tab);
    tab.view.start().catch((e) => tab.setTitle(`error: ${e}`));
  }

  function closeTab(tab: Tab) {
    const list = tabs();
    const i = list.indexOf(tab);
    if (i < 0) return;
    tab.view.dispose();
    const rest = list.filter((t) => t !== tab);
    setTabs(rest);
    if (rest.length === 0) {
      getCurrentWindow().close();
    } else if (active() === tab) {
      activate(rest[Math.min(i, rest.length - 1)]);
    }
  }

  function step(dir: 1 | -1) {
    const list = tabs();
    const cur = active();
    if (list.length < 2 || !cur) return;
    activate(list[neighbour(list.indexOf(cur), list.length, dir)]);
  }

  function onKey(e: KeyboardEvent) {
    const action = tabAction(e);
    if (!action) return;
    // Capture phase: handled before xterm sees the key.
    e.preventDefault();
    e.stopPropagation();
    if (action === "new") newTab();
    else if (action === "close") active() && closeTab(active()!);
    else step(action === "next" ? 1 : -1);
  }

  onMount(() => {
    window.addEventListener("keydown", onKey, true);
    const unlisten = listen<number>("pty-exit", (e) => {
      const tab = tabs().find((t) => t.view.ptyId === e.payload);
      if (tab) closeTab(tab);
    });
    let frame = 0;
    const resize = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => active()?.view.refit());
    });
    resize.observe(host);
    newTab();
    onCleanup(() => {
      window.removeEventListener("keydown", onKey, true);
      unlisten.then((f) => f());
      resize.disconnect();
    });
  });

  return (
    <div class="app">
      <div class="tabbar">
        <For each={tabs()}>
          {(tab) => (
            <div
              class="tab"
              classList={{ active: active() === tab }}
              onMouseDown={(e) => (e.button === 1 ? closeTab(tab) : activate(tab))}
              title={tab.title()}
            >
              <span class="tab-title">{tab.title()}</span>
              <span class="tab-close" onMouseDown={(e) => (e.stopPropagation(), closeTab(tab))}>
                ×
              </span>
            </div>
          )}
        </For>
        <div class="tab-new" onClick={newTab} title="New tab (Ctrl+Shift+T)">
          +
        </div>
      </div>
      <div class="terms" ref={host} />
    </div>
  );
}

export default App;
