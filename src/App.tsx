import { batch, createEffect, createSignal, For, onCleanup, onMount, type Accessor, type Setter } from "solid-js";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { TermView, type AgentSession } from "./terminal/TermView";
import { neighbour, tabAction } from "./tabs/nav";
import "./App.css";

type Tab = { view: TermView; title: Accessor<string>; setTitle: Setter<string>; cwd: Accessor<string | undefined> };
type SavedTab = { cwd?: string; title: string; agent?: AgentSession };
type Integration = { id: string; name: string; installed: boolean };

function App() {
  let host!: HTMLDivElement;
  const [tabs, setTabs] = createSignal<Tab[]>([]);
  const [active, setActive] = createSignal<Tab>();
  const [missing, setMissing] = createSignal<Integration[]>([]);
  // Saving starts once restored tabs have their shells, so a half-restored state is never written.
  const [restored, setRestored] = createSignal(false);

  function save() {
    if (!restored()) return;
    const list = tabs();
    invoke("session_update", {
      tabs: list.map((t) => ({ pty: t.view.ptyId >= 0 ? t.view.ptyId : null, cwd: t.cwd() ?? null, title: t.title() })),
      active: Math.max(0, list.indexOf(active()!)),
    });
  }
  createEffect(save);

  function activate(tab: Tab) {
    const t0 = performance.now();
    if (active() !== tab) active()?.view.hide();
    tab.view.show();
    setActive(tab);
    if (import.meta.env.DEV) {
      requestAnimationFrame(() => console.debug(`tab switch ${(performance.now() - t0).toFixed(1)} ms`));
    }
  }

  function newTab(saved?: SavedTab): Promise<void> {
    const [title, setTitle] = createSignal(saved?.title ?? "shell");
    const [cwd, setCwd] = createSignal(saved?.cwd);
    active()?.view.hide();
    const tab: Tab = { view: new TermView(host, { onTitle: setTitle, onCwd: setCwd }), title, setTitle, cwd };
    setTabs([...tabs(), tab]);
    activate(tab);
    return tab.view
      .start(saved?.cwd, saved?.agent)
      .then(save) // the pty id is not reactive
      .catch((e) => void tab.setTitle(`error: ${e}`));
  }

  async function restore() {
    const saved = await invoke<{ tabs: SavedTab[]; active: number }>("session_restore");
    const starts = batch(() => (saved.tabs.length ? saved.tabs : [undefined]).map(newTab));
    const list = tabs();
    activate(list[Math.min(saved.active, list.length - 1)]);
    await Promise.all(starts);
    setRestored(true);
  }

  async function checkIntegrations() {
    const all = await invoke<Integration[]>("agent_integrations");
    setMissing(all.filter((i) => !i.installed));
  }

  async function enable(id: string) {
    try {
      await invoke("agent_install", { id });
      await checkIntegrations();
    } catch (e) {
      alert(`Could not enable integration: ${e}`);
    }
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
    restore();
    checkIntegrations();
    invoke<boolean>("bench_enabled").then(async (on) => {
      if (!on) return;
      const bench = await import("./bench");
      bench.run({ newTab: () => newTab(), views: () => tabs().map((t) => t.view), activate: (i) => activate(tabs()[i]) });
    });
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
        <div class="tab-new" onClick={() => newTab()} title="New tab (Ctrl+Shift+T)">
          +
        </div>
      </div>
      <For each={missing()}>
        {(i) => (
          <div class="banner">
            <span>
              Enable <b>{i.name}</b> integration to restore each tab's session on restart. Adds Rift hooks to its
              settings (a .bak copy is kept).
            </span>
            <button onClick={() => enable(i.id)}>Enable</button>
            <button onClick={() => setMissing(missing().filter((m) => m !== i))}>Not now</button>
          </div>
        )}
      </For>
      <div class="terms" ref={host} />
    </div>
  );
}

export default App;
