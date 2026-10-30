import { batch, createEffect, createSignal, For, on, onCleanup, onMount, Show, untrack } from "solid-js";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { sendNotification } from "@tauri-apps/plugin-notification";
import { TermView, type AgentSession, type TermLook } from "./terminal/TermView";
import { TERMINAL_THEMES } from "./terminal/themes";
import { neighbour } from "./tabs/nav";
import { actionFor, DEFAULTS, mergeSettings, resolveTheme, type Settings } from "./settings/settings";
import { SettingsPage } from "./settings/SettingsPage";
import { startUpdates } from "./update";
import { displayTitle, moveGroup, moveTab, shouldNotify, visualOrder, type Drop, type Group, type Status } from "./tabs/layout";
import { Tab } from "./tabs/Tab";
import { Sidebar } from "./tabs/Sidebar";
import { Explorer } from "./panels/Explorer";
import { GitPanel } from "./panels/GitPanel";
import { Resizer } from "./ui/Resizer";
import "./App.css";

type TabUi = { name?: string; color?: string; group?: string };
type SavedTab = { cwd?: string; title: string; agent?: AgentSession; ui?: TabUi };
type Panels = { explorer: boolean; git: boolean };
type Widths = { tabs: number; explorer: number; git: number };
type Saved = { tabs: SavedTab[]; active: number; layout?: { groups?: Group[]; panels?: Panels; widths?: Widths } };
type Integration = { id: string; name: string; installed: boolean };
type AgentStatus = { pty: number; harness: string; status: Status | null; message: string | null };

function App() {
  let host!: HTMLDivElement;
  const [tabs, setTabs] = createSignal<Tab[]>([]);
  const [groups, setGroups] = createSignal<Group[]>([]);
  const [active, setActive] = createSignal<Tab>();
  const [missing, setMissing] = createSignal<Integration[]>([]);
  const [update, setUpdate] = createSignal<{ version: string; restart: () => Promise<void> }>();
  // From Tauri's window events: document.hasFocus() is not reliable in WebView2.
  const [windowFocused, setWindowFocused] = createSignal(true);
  const [settings, setSettings] = createSignal<Settings>(DEFAULTS);
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  const systemDark = window.matchMedia("(prefers-color-scheme: dark)");
  const [systemIsDark, setSystemIsDark] = createSignal(systemDark.matches);
  const theme = () => resolveTheme(settings().theme, systemIsDark());
  const look = (): TermLook => ({
    theme: TERMINAL_THEMES[theme()],
    fontSize: settings().fontSize,
    fontFamily: settings().fontFamily,
  });
  createEffect(() => (document.documentElement.dataset.theme = theme()));
  // Live: theme/font changes reach every terminal. A font change alters the cell size, so the
  // visible tab refits now and hidden ones in idle time (same path as a panel resize).
  // Tracks only the three values (editing a shortcut or adding a tab must not re-render every terminal).
  createEffect(
    on(
      [theme, () => settings().fontSize, () => settings().fontFamily],
      () =>
        untrack(() => {
          const l = look();
          for (const t of tabs()) t.view.setLook(l);
          active()?.view.refit();
          resizeHiddenTabs();
        }),
      { defer: true },
    ),
  );

  function changeSettings(s: Settings) {
    setSettings(s);
    invoke("settings_save", { value: s });
  }

  const [panels, setPanels] = createSignal<Panels>({ explorer: false, git: false });
  const [widths, setWidths] = createSignal<Widths>({ tabs: 240, explorer: 240, git: 440 });
  // While a panel edge is dragged the terminal is not re-wrapped (100+ ms each): only on release.
  let dragging = false;
  const resizeWidth = (key: keyof Widths) => (w: number) => setWidths({ ...widths(), [key]: w });
  const onDragging = (d: boolean) => {
    dragging = d;
    if (!d) {
      active()?.view.refit();
      resizeHiddenTabs();
    }
  };
  // The tab the side panels show. Follows the active tab only once it stays put for a moment,
  // so holding Ctrl+PgDn never makes the panels load each tab it passes.
  const [panelTab, setPanelTab] = createSignal<Tab>();
  let panelTimer = 0;
  createEffect(() => {
    const tab = active();
    clearTimeout(panelTimer);
    panelTimer = setTimeout(() => setPanelTab(tab), 150);
  });
  // Saving starts once restored tabs have their shells, so a half-restored state is never written.
  const [restored, setRestored] = createSignal(false);

  function save() {
    if (!restored()) return;
    const list = tabs();
    invoke("session_update", {
      tabs: list.map((t) => ({
        pty: t.view.ptyId >= 0 ? t.view.ptyId : null,
        cwd: t.cwd ?? null,
        title: t.title,
        ui: { name: t.name, color: t.color, group: t.group } satisfies TabUi,
      })),
      active: Math.max(0, list.indexOf(active()!)),
      layout: { groups: groups(), panels: panels(), widths: widths() },
    });
  }
  createEffect(save);

  function activate(tab: Tab) {
    const t0 = performance.now();
    if (active() !== tab) active()?.view.hide();
    tab.view.show();
    setActive(tab);
    tab.unread = false;
    const g = groups().find((g) => g.id === tab.group);
    if (g?.collapsed) updateGroup(g.id, { collapsed: false });
    if (import.meta.env.DEV) {
      requestAnimationFrame(() => console.debug(`tab switch ${(performance.now() - t0).toFixed(1)} ms`));
    }
  }

  /** New tabs open right after the active one, in its group. */
  function newTab(saved?: SavedTab): Promise<void> {
    const tab = new Tab();
    tab.title = saved?.title ?? "shell";
    tab.cwd = saved?.cwd;
    tab.name = saved?.ui?.name;
    tab.color = saved?.ui?.color;
    tab.group = saved ? saved.ui?.group : active()?.group;
    const onCwd = (cwd: string) => {
      tab.cwd = cwd;
      // At every prompt: also catches `git checkout` (same cwd, new branch).
      invoke<{ root: string; branch: string } | null>("git_head", { cwd }).then((head) =>
        batch(() => {
          tab.root = head?.root;
          tab.branch = head?.branch;
        }),
      );
    };
    if (saved?.cwd) onCwd(saved.cwd);
    tab.view = new TermView(host, { onTitle: (v) => (tab.title = v), onCwd }, look());

    const list = [...tabs()];
    const after = saved ? -1 : list.indexOf(active()!);
    list.splice(after < 0 ? list.length : after + 1, 0, tab);
    active()?.view.hide();
    setTabs(list);
    activate(tab);
    return tab.view
      .start(saved?.cwd, saved?.agent)
      .then(save) // the pty id is not reactive
      .catch((e) => void (tab.title = `error: ${e}`));
  }

  async function restore() {
    const saved = await invoke<Saved>("session_restore");
    setGroups(saved.layout?.groups ?? []);
    if (saved.layout?.panels) setPanels(saved.layout.panels);
    if (saved.layout?.widths) setWidths(saved.layout.widths);
    const starts = batch(() => (saved.tabs.length ? saved.tabs : [undefined]).map(newTab));
    const list = tabs();
    activate(list[Math.min(saved.active, list.length - 1)]);
    await Promise.all(starts);
    setRestored(true);
    // Launched from Explorer's "Open in Rift": that folder opens as a new tab, after the restored ones.
    const dir = await invoke<string | null>("startup_dir");
    if (dir) newTab({ cwd: dir, title: "" });
  }

  function closeTab(tab: Tab) {
    const order = visualOrder(tabs(), groups());
    const i = order.indexOf(tab);
    if (i < 0) return;
    tab.view.dispose();
    const rest = order.filter((t) => t !== tab);
    setTabs(tabs().filter((t) => t !== tab));
    if (rest.length === 0) {
      getCurrentWindow().close();
    } else if (active() === tab) {
      activate(rest[Math.min(i, rest.length - 1)]);
    }
  }

  function step(dir: 1 | -1) {
    const order = visualOrder(tabs(), groups());
    const cur = active();
    if (order.length < 2 || !cur) return;
    activate(order[neighbour(order.indexOf(cur), order.length, dir)]);
  }

  function move(tab: Tab, drop: Drop<Tab>) {
    const r = moveTab(tabs(), tab, drop);
    batch(() => {
      tab.group = r.group;
      setTabs(r.tabs);
    });
  }

  function updateGroup(id: string, patch: Partial<Group>) {
    setGroups(groups().map((g) => (g.id === id ? { ...g, ...patch } : g)));
  }

  function newGroup(tab: Tab) {
    const id = `g${Date.now()}`;
    batch(() => {
      setGroups([...groups(), { id, name: `Group ${groups().length + 1}`, collapsed: false }]);
      move(tab, { group: id });
    });
  }

  function deleteGroup(id: string) {
    batch(() => {
      for (const t of tabs()) if (t.group === id) t.group = undefined;
      setGroups(groups().filter((g) => g.id !== id));
    });
  }

  // Re-wrapping a terminal's scrollback to a new width costs ~100+ ms. After a width change (panel toggle,
  // window resize), hidden tabs are resized in idle time, nearest first, instead of on their next switch.
  let idleJob = 0;
  function resizeHiddenTabs() {
    cancelIdleCallback(idleJob);
    const cur = active();
    if (!cur) return;
    const { cols, rows } = cur.view.term;
    const order = visualOrder(tabs(), groups());
    const at = order.indexOf(cur);
    const pending = order
      .filter((t) => t !== cur)
      .sort((a, b) => Math.abs(order.indexOf(a) - at) - Math.abs(order.indexOf(b) - at));
    const step = () => {
      pending.shift()?.view.resizeTo(cols, rows);
      if (pending.length) idleJob = requestIdleCallback(step);
    };
    idleJob = requestIdleCallback(step);
  }

  function togglePanel(panel: keyof Panels) {
    setPanels({ ...panels(), [panel]: !panels()[panel] });
  }

  function onAgentStatus({ pty, harness, status, message }: AgentStatus) {
    const tab = tabs().find((t) => t.view.ptyId === pty);
    if (!tab) return;
    batch(() => {
      tab.status = status ?? undefined;
      tab.agent = status ? harness : undefined;
    });
    const visible = active() === tab && windowFocused();
    if (!shouldNotify(tab.status, visible)) return;
    tab.unread = true;
    sendNotification({
      title: `${tab.status === "done" ? "✓" : "■"} ${displayTitle(tab)}`,
      body: tab.status === "done" ? "Agent finished" : message || "Agent needs your input",
    });
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

  function onKey(e: KeyboardEvent) {
    if (settingsOpen()) return; // the settings page owns the keyboard (shortcut recording, Esc)
    const action = actionFor(e, settings().keys);
    if (!action) return;
    // Capture phase: handled before xterm sees the key.
    e.preventDefault();
    e.stopPropagation();
    if (action === "newTab") newTab();
    else if (action === "closeTab") active() && closeTab(active()!);
    else if (action === "nextTab" || action === "prevTab") step(action === "nextTab" ? 1 : -1);
    else if (action === "toggleFiles") togglePanel("explorer");
    else if (action === "toggleGit") togglePanel("git");
    else if (action === "settings") setSettingsOpen(true);
  }

  onMount(() => {
    window.addEventListener("keydown", onKey, true);
    const win = getCurrentWindow();
    win.isFocused().then(setWindowFocused);
    const unlisten = [
      win.onFocusChanged(({ payload: focused }) => {
        setWindowFocused(focused);
        if (focused && active()) active()!.unread = false;
      }),
      listen<number>("pty-exit", (e) => {
        const tab = tabs().find((t) => t.view.ptyId === e.payload);
        if (tab) closeTab(tab);
      }),
      listen<AgentStatus>("agent-status", (e) => onAgentStatus(e.payload)),
      // Another `rift.exe <dir>` was launched (Explorer menu): single-instance forwards the folder here.
      listen<string>("open-dir", (e) => newTab({ cwd: e.payload, title: "" })),
    ];
    let frame = 0;
    const resize = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      if (dragging) return;
      frame = requestAnimationFrame(() => {
        active()?.view.refit();
        resizeHiddenTabs();
      });
    });
    resize.observe(host);
    const onSystemTheme = (e: MediaQueryListEvent) => setSystemIsDark(e.matches);
    systemDark.addEventListener("change", onSystemTheme);
    // Settings first: restored terminals are created with the right theme and font.
    invoke("settings_load")
      .then((saved) => setSettings(mergeSettings(saved)))
      .finally(restore);
    checkIntegrations();
    invoke<string[] | null>("bench_dirs").then(async (dirs) => {
      if (!dirs) {
        // Not in dev (would offer the latest release over local work) nor in the bench.
        if (!import.meta.env.DEV) startUpdates((version, restart) => setUpdate({ version, restart }));
        return;
      }
      const bench = await import("./bench");
      bench.run({
        // Alternate between the bench repos so every switch changes repo (worst case for the panels).
        newTab: () => newTab(dirs.length ? { cwd: dirs[tabs().length % dirs.length], title: "" } : undefined),
        views: () => tabs().map((t) => t.view),
        activate: (i) => activate(tabs()[i]),
        setPanels: (open) => setPanels({ explorer: open, git: open }),
      });
    });
    onCleanup(() => {
      window.removeEventListener("keydown", onKey, true);
      systemDark.removeEventListener("change", onSystemTheme);
      unlisten.forEach((u) => u.then((f) => f()));
      resize.disconnect();
    });
  });

  return (
    <div class="app">
      <div class="pane" style={{ width: `${widths().tabs}px` }}>
      <Sidebar
        tabs={tabs()}
        groups={groups()}
        active={active()}
        onActivate={activate}
        onClose={closeTab}
        onNewTab={() => newTab()}
        onMoveTab={move}
        onMoveGroup={(id, before) => setGroups(moveGroup(groups(), id, before))}
        onNewGroup={newGroup}
        onUpdateGroup={updateGroup}
        onDeleteGroup={deleteGroup}
        panels={panels()}
        onTogglePanel={togglePanel}
        onOpenSettings={() => setSettingsOpen(true)}
      />
        <Resizer edge="right" width={widths().tabs} min={160} max={480} onResize={resizeWidth("tabs")} onDragging={onDragging} />
      </div>
      <Show when={panels().explorer}>
        <div class="pane" style={{ width: `${widths().explorer}px` }}>
          <Explorer root={panelTab()?.root ?? panelTab()?.cwd} onClose={() => togglePanel("explorer")} />
          <Resizer
            edge="right"
            width={widths().explorer}
            min={160}
            max={600}
            onResize={resizeWidth("explorer")}
            onDragging={onDragging}
          />
        </div>
      </Show>
      <Show when={settingsOpen()}>
        <SettingsPage
          settings={settings()}
          onChange={changeSettings}
          onClose={() => (setSettingsOpen(false), active()?.view.show())}
        />
      </Show>
      <main class="main">
        <Show when={update()}>
          {(u) => (
            <div class="banner">
              <span>
                Rift <b>{u().version}</b> is ready. It installs when you close Rift, or now:
              </span>
              <button onClick={() => u().restart()}>Restart now</button>
            </div>
          )}
        </Show>
        <For each={missing()}>
          {(i) => (
            <div class="banner">
              <span>
                Enable <b>{i.name}</b> integration: tab status icons, notifications, and each tab's session restored on
                restart. Adds Rift hooks to its settings (a .bak copy is kept).
              </span>
              <button onClick={() => enable(i.id)}>Enable</button>
              <button onClick={() => setMissing(missing().filter((m) => m !== i))}>Not now</button>
            </div>
          )}
        </For>
        <div class="terms" ref={host} />
      </main>
      <Show when={panels().git}>
        <div class="pane" style={{ width: `${widths().git}px` }}>
          <Resizer edge="left" width={widths().git} min={280} max={1000} onResize={resizeWidth("git")} onDragging={onDragging} />
          <GitPanel root={panelTab()?.root} branch={panelTab()?.branch} onClose={() => togglePanel("git")} />
        </div>
      </Show>
    </div>
  );
}

export default App;
