import { batch, createEffect, createSignal, For, on, onCleanup, onMount, Show, untrack } from "solid-js";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { onAction, sendNotification } from "@tauri-apps/plugin-notification";
import { TermView, type TermLook } from "./terminal/TermView";
import { TERMINAL_THEMES } from "./terminal/themes";
import { neighbour } from "./tabs/nav";
import {
  actionFor,
  DEFAULTS,
  isReloadKey,
  mergeSettings,
  resolveTheme,
  TAB_ROW_HEIGHT,
  type Action,
  wheelSteps,
  zoomed,
  type Settings,
  type ZoomArea,
} from "./settings/settings";
import { SettingsPage } from "./settings/SettingsPage";
import { startUpdates, type Updater } from "./update";
import {
  displayTitle,
  moveGroup,
  moveTab,
  needsAttention,
  nextNeedingAttention,
  shouldNotify,
  statusAfterInterrupt,
  statusFromHook,
  visualOrder,
  type Agent,
  type Spot,
  type Group,
  type Status,
  type TabFilter,
} from "./tabs/layout";
import { Tab } from "./tabs/Tab";
import { Shell } from "./tabs/Shell";
import { createSessionSave, saveHistories, type Saved, type SavedTab } from "./tabs/session";
import { createGitWatch } from "./tabs/gitWatch";
import { TopBar } from "./tabs/TopBar";
import { createDocs } from "./docs/docs";
import { Sidebar } from "./tabs/Sidebar";
import type { Limit, Limits } from "./tabs/usage";
import { Explorer } from "./panels/Explorer";
import { isUnder, repoPath } from "./panels/fileOps";
import { GitPanel } from "./panels/GitPanel";
import { Prompts } from "./panels/Prompts";
import { Messages } from "./panels/Messages";
import { createMessaging, type McpCall } from "./messages/messaging";
import {
  addPrompt,
  editPrompt,
  mergePrompts,
  movePrompt,
  promptKey,
  removePrompt,
  type PromptLists,
} from "./panels/promptLists";
import { Resizer } from "./ui/Resizer";
import { Panes, paneBeside } from "./panels/PaneTree";
import { createConsoles } from "./panels/Consoles";
import { DEFAULT_PANES, index, isGroup, isShown, isTerminal, mergePanes, show as showPanel, toggle, type Pane, type PanelId } from "./panels/panes";
import { FindBar } from "./ui/FindBar";
import { PromptDialog } from "./ui/PromptDialog";
import "./App.css";

type Integration = { id: string; name: string; detected: boolean; installed: boolean; setup: string };
type AgentStatus = { pty: number; harness: string; status: Status | null; message: string | null; continued: boolean };
type AgentUsage = { pty: number; context: number | null } & { [K in keyof Limits]: Limit | null };

function App() {
  let host!: HTMLDivElement;
  let panesEl!: HTMLDivElement;
  const [tabs, setTabs] = createSignal<Tab[]>([]);
  const [groups, setGroups] = createSignal<Group[]>([]);
  const [active, setActive] = createSignal<Tab>();
  const [missing, setMissing] = createSignal<Integration[]>([]);
  const [agents, setAgents] = createSignal<Integration[]>([]);
  const [shells, setShells] = createSignal<{ id: string; name: string }[]>([]);
  invoke<{ id: string; name: string }[]>("shell_profiles").then(setShells);
  const [update, setUpdate] = createSignal<{ version: string; restart: () => Promise<void> }>();
  // Plan limits from the latest status line (they are per account, not per tab).
  const [limits, setLimits] = createSignal<Limits>({});
  // From Tauri's window events: document.hasFocus() is not reliable in WebView2.
  const [windowFocused, setWindowFocused] = createSignal(true);
  const [settings, setSettings] = createSignal<Settings>(DEFAULTS);
  // The default shell (settings) is the backend's: spare shells start with it.
  createEffect(on(() => settings().shell, (id) => invoke("shell_set_default", { id: id || null }), { defer: true }));
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  const [finding, setFinding] = createSignal(false);
  // The last shell the user typed in: Find searches it (a terminal panel's shell, or the tab's own).
  let focusedShell: Shell | undefined;
  const [filter, setFilter] = createSignal<TabFilter>("all");
  const [renameRequest, setRenameRequest] = createSignal<{ tab: Tab }>();
  // The top bar follows the active tab one frame later: the switch frame only shows the new terminal.
  const [barTab, setBarTab] = createSignal<Tab>();
  createEffect(() => {
    const tab = active();
    requestAnimationFrame(() => setBarTab(tab));
  });
  const [worktreeFrom, setWorktreeFrom] = createSignal<{ tab: Tab; agent: Agent }>();
  let updater: Updater | undefined;

  // Window title: version, plus how many tabs need the user ("Rift 1.2.3+4 — 2 waiting").
  const [version, setVersion] = createSignal("");
  getVersion().then(setVersion);
  createEffect(() => {
    if (!version()) return;
    const waiting = tabs().filter(needsAttention).length;
    getCurrentWindow().setTitle(`Rift ${version()}${waiting ? ` — ${waiting} waiting` : ""}`);
  });
  const systemDark = window.matchMedia("(prefers-color-scheme: dark)");
  const [systemIsDark, setSystemIsDark] = createSignal(systemDark.matches);
  const theme = () => resolveTheme(settings().theme, systemIsDark());
  const look = (): TermLook => ({
    theme: TERMINAL_THEMES[theme()],
    fontSize: settings().fontSize,
    fontFamily: settings().fontFamily,
  });
  createEffect(() => (document.documentElement.dataset.theme = theme()));
  // The document editor uses the terminal font (CSS variables: no work per open document).
  createEffect(() => {
    document.documentElement.style.setProperty("--doc-mono", settings().fontFamily);
    document.documentElement.style.setProperty("--doc-mono-size", `${settings().fontSize}px`);
  });
  // Panel and document text scales (Ctrl+wheel over one): CSS variables, no work per panel or document.
  createEffect(() => {
    for (const [area, scale] of Object.entries(settings().scale)) {
      document.documentElement.style.setProperty(`--scale-${area}`, String(scale));
    }
  });
  createEffect(() =>
    document.documentElement.style.setProperty("--tab-row", `${TAB_ROW_HEIGHT[settings().tabSize]}px`),
  );
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
          for (const v of consoles.views()) v.setLook(l);
          refitAll();
        }),
      { defer: true },
    ),
  );

  function changeSettings(s: Settings) {
    setSettings(s);
    invoke("settings_save", { value: s });
  }

  // Panels in one tree of splits, the same for every tab; the tab's own terminal is one of its leaves ("main").
  const [panes, setPanes] = createSignal<Pane>(DEFAULT_PANES);
  const shown = (id: PanelId) => isShown(panes(), id);
  const [tabsWidth, setTabsWidth] = createSignal(240);
  // Prompts prepared in advance, per repo; saved on each change (a user action, never in the background).
  const [promptLists, setPromptLists] = createSignal<PromptLists>({});
  const promptRepo = () => panelTab()?.root ?? panelTab()?.cwd;
  const changePrompts = (next: PromptLists) => {
    setPromptLists(next);
    invoke("prompts_save", { value: next });
  };
  // While a panel edge is dragged the terminal is not re-wrapped (100+ ms each): only on release.
  let dragging = false;
  const onDragging = (d: boolean) => {
    dragging = d;
    if (!d) refitAll();
  };
  // The tab the side panels show. Follows the active tab only once it stays put for a moment,
  // so holding Ctrl+PgDn never makes the panels load each tab it passes.
  const [panelTab, setPanelTab] = createSignal<Tab>();
  let panelTimer = 0;
  createEffect(() => {
    const tab = active();
    clearTimeout(panelTimer);
    panelTimer = setTimeout(() => {
      const root = tab?.root;
      const same = root === panelTab()?.root;
      setPanelTab(tab);
      git.panelTabChanged(root, same);
    }, 150);
  });
  const git = createGitWatch({ panelShows: (root) => shown("git") && panelTab()?.root === root });
  const [filesRefresh, setFilesRefresh] = createSignal(0); // bumped to reload the files panel (F5)
  // Keep the spare shell in the active tab's folder, so a new tab there (which opens in the same
  // folder) is instant. Only once the tab and its folder stay put: each move costs a shell start.
  let prewarmTimer = 0;
  createEffect(() => {
    const cwd = active()?.cwd;
    clearTimeout(prewarmTimer);
    prewarmTimer = setTimeout(() => invoke("pty_prewarm", { cwd: cwd ?? null }), 1000);
  });
  const session = createSessionSave({ tabs, active, groups, panes, tabsWidth });

  /** A finished agent the user has now seen goes back to the plain agent icon after a moment. */
  function fadeDoneWhenSeen(tab: Tab) {
    for (const shell of tab.shells) {
      if (shell.status !== "done") continue;
      setTimeout(() => {
        if (shell.status === "done" && active() === tab && windowFocused()) shell.status = "idle";
      }, 3000);
    }
  }

  function activate(tab: Tab) {
    const t0 = performance.now();
    const left = active();
    if (left && left !== tab) {
      left.shown.hide();
      // Its message counts restart from zero, after the switch (nothing but showing the tab runs on it).
      setTimeout(() => messaging.leave(left));
    }
    tab.shown.show();
    setActive(tab);
    tab.unread = false;
    fadeDoneWhenSeen(tab);
    const g = groups().find((g) => g.id === tab.group);
    if (g?.collapsed) updateGroup(g.id, { collapsed: false });
    if (import.meta.env.DEV) {
      requestAnimationFrame(() => console.debug(`tab switch ${(performance.now() - t0).toFixed(1)} ms`));
    }
  }

  /** A shell's folder, from its prompt: also catches `git checkout` (same cwd, new branch). */
  function onShellCwd(tab: Tab, shell: Shell, cwd: string) {
    shell.cwd = cwd;
    invoke<{ root: string; branch: string } | null>("git_head", { cwd }).then((head) =>
      batch(() => {
        // The tab's repo is its main shell's.
        if (shell === tab.main) {
          tab.root = head?.root;
          tab.branch = head?.branch;
        }
        if (head) git.promptCameBack(head.root);
        git.stats(tab);
      }),
    );
  }

  /** Every shell of a tab (its own or in a terminal panel) gets the same terminal: agent keys, folder, title. */
  function buildShell(tab: Tab, shell: Shell, el: HTMLElement): Shell {
    shell.view = new TermView(
      el,
      {
        onTitle: (v) => (shell.title = v),
        onCwd: (cwd) => onShellCwd(tab, shell, cwd),
        isAgent: () => !!shell.agent,
        onInterrupt: () => (shell.status = statusAfterInterrupt(shell.status)),
      },
      look(),
    );
    shell.view.el.addEventListener("focusin", () => (focusedShell = shell));
    return shell;
  }

  /** The tab and shell running pty `pty`. */
  function shellOf(pty: unknown): { tab: Tab; shell: Shell } | undefined {
    for (const tab of tabs()) {
      const shell = tab.shells.find((s) => s.view.ptyId === pty);
      if (shell) return { tab, shell };
    }
  }

  /** New tabs open right after the active one, in its group and its folder. */
  /** With `opts.behind`, the new tab opens after that tab and stays in the background (started by an agent). */
  function newTab(
    saved?: SavedTab,
    opts: { cwd?: string; name?: string; group?: string; startAgent?: string; shell?: string; behind?: Tab } = {},
  ): Promise<Tab> {
    const tab = new Tab();
    const cwd = saved ? saved.cwd : (opts.cwd ?? active()?.cwd);
    tab.main.title = saved?.title ?? "shell";
    tab.name = saved?.ui?.name ?? opts.name;
    tab.color = saved?.ui?.color;
    tab.group = saved ? saved.ui?.group : (opts.group ?? active()?.group);
    // Like the folder, a new tab keeps the shell of the tab it was opened from.
    tab.shell = saved ? saved.ui?.shell : (opts.shell ?? active()?.shell);
    if (saved?.ui?.snap) tab.snap = saved.ui.snap;
    // Restored documents are read only when first shown.
    if (saved?.ui?.docs?.length) {
      tab.docs = saved.ui.docs.map((path) => docs.make(tab, path));
      tab.current = Math.min(saved.ui.doc ?? -1, tab.docs.length - 1);
    }
    buildShell(tab, tab.main, host);
    if (cwd) onShellCwd(tab, tab.main, cwd);
    if (tab.current >= 0) tab.view.hide(); // a restored document is shown instead

    const list = [...tabs()];
    const after = saved ? -1 : list.indexOf((opts.behind ?? active())!);
    list.splice(after < 0 ? list.length : after + 1, 0, tab);
    if (opts.behind) {
      // Hidden, it cannot measure itself: it takes the visible terminal's size, so its shell starts at it.
      tab.view.hide();
      const shown = active()?.view.term;
      if (shown) tab.view.resizeTo(shown.cols, shown.rows);
      setTabs(list);
    } else {
      active()?.shown.hide();
      setTabs(list);
      activate(tab);
    }
    // A restored shell tab shows its previous history first. Not agent tabs: resuming redisplays the session.
    const history =
      saved?.ui?.snap && !saved.agent
        ? invoke<string | null>("scrollback_load", { id: saved.ui.snap }).catch(() => null)
        : Promise.resolve(null);
    return history
      .then((h) => h && tab.view.restoreSnapshot(h))
      .then(() => tab.view.start(cwd, saved?.agent, opts.startAgent, tab.shell))
      .then(session.save) // the pty id is not reactive
      .catch((e) => void (tab.main.title = `error: ${e}`))
      .then(() => tab);
  }

  async function restore() {
    const saved = await invoke<Saved>("session_restore");
    setGroups(saved.layout?.groups ?? []);
    setPanes(mergePanes(saved.layout?.panes));
    if (saved.layout?.widths?.tabs) setTabsWidth(saved.layout.widths.tabs);
    const starts = batch(() => (saved.tabs.length ? saved.tabs : [undefined]).map(newTab));
    const list = tabs();
    activate(list[Math.min(saved.active, list.length - 1)]);
    await Promise.all(starts);
    session.restored();
    invoke("scrollback_prune", { keep: tabs().map((t) => t.snap) });
    // Launched from Explorer's "Open in Rift": that folder opens as a new tab, after the restored ones.
    const dir = await invoke<string | null>("startup_dir");
    if (dir) newTab({ cwd: dir, title: "" });
  }

  function closeTab(tab: Tab, force = false) {
    const order = visualOrder(tabs(), groups());
    const i = order.indexOf(tab);
    if (i < 0) return;
    const unsaved = tab.docs.filter((d) => d.dirty).map((d) => d.name);
    if (!force && unsaved.length && !confirm(`Discard unsaved changes to ${unsaved.join(", ")}?`)) return;
    tab.docs.forEach((d) => d.dispose());
    consoles.dropTab(tab);
    tab.view.dispose();
    const rest = order.filter((t) => t !== tab);
    setTabs(tabs().filter((t) => t !== tab));
    if (rest.length === 0) {
      getCurrentWindow().close();
    } else if (active() === tab) {
      activate(rest[Math.min(i, rest.length - 1)]);
    }
  }

  const docs = createDocs({ host: () => host, active, single: () => settings().docs === "single" });

  /** The external editor (Settings → General) on `path`, or empty, in the active tab's folder. */
  function openEditor(path?: string) {
    invoke("editor_open", { editor: settings().editor, path, cwd: active()?.cwd }).catch((e) =>
      alert(`Could not open the editor: ${e}`),
    );
  }

  function step(dir: 1 | -1) {
    const order = visualOrder(tabs(), groups());
    const cur = active();
    if (order.length < 2 || !cur) return;
    activate(order[neighbour(order.indexOf(cur), order.length, dir)]);
  }

  function move(tab: Tab, spot: Spot<Tab>) {
    const r = moveTab(tabs(), groups(), tab, spot);
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
      tab.group = id; // the group stands where the tab is
    });
  }

  function deleteGroup(id: string) {
    batch(() => {
      for (const t of tabs()) if (t.group === id) t.group = undefined;
      setGroups(groups().filter((g) => g.id !== id));
    });
  }

  /**
   * Closes every tab of the group, then the group (the window closes if no tab is left, as for a last tab).
   * Asks first when the group has tabs.
   */
  function closeGroup(id: string) {
    const closing = tabs().filter((t) => t.group === id);
    const name = groups().find((g) => g.id === id)?.name;
    const n = closing.length;
    if (n && !confirm(`Close the group “${name}” and its ${n} tab${n === 1 ? "" : "s"}?`)) return;
    for (const t of closing) closeTab(t);
    setGroups(groups().filter((g) => g.id !== id));
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

  /** The terminals' area changed size: the visible ones refit now, hidden tabs in idle time. */
  function refitAll() {
    active()?.view.refit();
    for (const v of consoles.views()) v.refit();
    resizeHiddenTabs();
  }

  function togglePanel(id: PanelId) {
    setPanes(toggle(panes(), id));
  }

  // "Show history" in the files panel: the git panel shows that file's commits (a new object re-asks the same file).
  const [historyAsk, setHistoryAsk] = createSignal<{ file: string }>();
  function showHistory(path: string) {
    const root = panelTab()?.root;
    const file = root && repoPath(root, path);
    if (!file) return;
    setPanes(showPanel(panes(), "git"));
    setHistoryAsk({ file });
  }

  let sizes: ResizeObserver | undefined; // refits the terminals when their area changes size
  const consoles = createConsoles({
    panes,
    setPanes,
    tabs,
    active,
    create: (tab, place, el) => buildShell(tab, new Shell(place), el),
    look,
    sizes: () => sizes,
  });
  const panelName = (id: PanelId) =>
    isTerminal(id) ? `Terminal ${id.slice(5)}` : ({ explorer: "Files", git: "Git", prompts: "Prompts", messages: "Messages", main: "Terminal" } as const)[id];

  // Agent messaging: whether its MCP server is in the agents' configs (Settings), and the messages themselves.
  const [mcp, setMcp] = createSignal<{ id: string; name: string; installed: boolean }[]>();
  const messagingOn = () => (mcp() ? mcp()!.some((a) => a.installed) : undefined);
  const refreshMcp = () => invoke<{ id: string; name: string; installed: boolean }[]>("mcp_status").then(setMcp);
  async function setMessaging(on: boolean) {
    try {
      await invoke("mcp_set", { on });
    } finally {
      await refreshMcp();
    }
  }
  const messaging = createMessaging({
    enabled: () => !!messagingOn(),
    tabs,
    shellOf,
    agents,
    startAgent: (from, o) =>
      newTab(undefined, { cwd: o.cwd, name: o.name, group: from.group, startAgent: o.agent, shell: from.shell, behind: from }),
    worktree: (from, branch) => invoke<string>("git_worktree_add", { root: from.root, branch }),
  });

  function onAgentStatus({ pty, harness, status, message, continued }: AgentStatus) {
    const hit = shellOf(pty);
    if (!hit) return;
    const { tab, shell } = hit;
    batch(() => {
      shell.status = statusFromHook(shell.status, status ?? undefined, continued);
      shell.agent = status ? harness : undefined;
      if (!status) shell.context = undefined;
    });
    messaging.statusChanged(pty);
    git.stats(tab); // an agent at work changes files
    // Finished in the repo the git panel shows (any tab): it reloads now to show the agent's changes.
    git.agentMoved(tab.root, shell.status === "done");
    // A terminal panel's shell is in front only while its panel is shown.
    const visible = active() === tab && windowFocused() && (shell.place === "main" || shown(shell.place));
    if (visible) fadeDoneWhenSeen(tab);
    if (!shouldNotify(shell.status, visible)) return;
    tab.unread = true;
    if (!windowFocused()) getCurrentWindow().requestUserAttention(UserAttentionType.Informational);
    const title = displayTitle({ name: tab.name, title: shell.title, cwd: shell.cwd, status: shell.status });
    sendNotification({
      id: ++notificationId,
      title: `${shell.status === "done" ? "✓" : "■"} ${title}`,
      body: shell.status === "done" ? "Agent finished" : message || "Agent needs your input",
      extra: { pty }, // brought back by a click (onAction) to open this shell
    });
  }

  let notificationId = 0;

  /** A click on a notification: bring Rift to the front on the shell it was about. */
  async function openNotifiedTab(pty: unknown) {
    const win = getCurrentWindow();
    await win.unminimize();
    await win.show();
    await win.setFocus();
    const hit = shellOf(pty);
    if (!hit) return;
    activate(hit.tab);
    if (hit.shell.place !== "main") consoles.reveal(hit.shell.place);
  }

  async function checkIntegrations() {
    // Only the agents used on this machine (their config folder exists) are offered.
    const used = (await invoke<Integration[]>("agent_integrations")).filter((i) => i.detected);
    setAgents(used);
    setMissing(used.filter((i) => !i.installed));
  }

  async function enable(id: string) {
    try {
      await invoke("agent_install", { id });
      await checkIntegrations();
    } catch (e) {
      alert(`Could not enable integration: ${e}`);
    }
  }

  /** A parallel agent: new branch + git worktree next to the repo, opened in a tab running a new `agent`. */
  async function newWorktree(from: Tab, agent: Agent, branch: string) {
    setWorktreeFrom(undefined);
    if (!from.root) return;
    try {
      const dir = await invoke<string>("git_worktree_add", { root: from.root, branch });
      newTab(undefined, { cwd: dir, name: branch, group: from.group, startAgent: agent.id });
    } catch (e) {
      alert(`Could not create the worktree: ${e}`);
      active()?.shown.focus();
    }
  }

  /** The area an element belongs to (`data-zoom`); outside any (sidebar, top bar), none. */
  const zoomArea = (el: EventTarget | null) =>
    ((el as Element | null)?.closest?.("[data-zoom]") as HTMLElement | null)?.dataset.zoom as ZoomArea | undefined;

  // Applied live, saved once the zooming stops: a wheel spin would otherwise write settings.json per notch.
  let zoomSave = 0;
  function zoom(area: ZoomArea, step: number) {
    const next = zoomed(settings(), area, step);
    if (next === settings()) return;
    setSettings(next);
    clearTimeout(zoomSave);
    zoomSave = setTimeout(() => invoke("settings_save", { value: settings() }), 500);
  }

  // Ctrl+wheel (also a touchpad pinch) resizes what is under the cursor, never the whole page.
  let wheelPending = 0;
  function onWheel(e: WheelEvent) {
    if (!e.ctrlKey) return;
    e.preventDefault();
    e.stopPropagation(); // xterm would scroll
    const area = zoomArea(e.target);
    const r = wheelSteps(wheelPending, e.deltaY, e.deltaMode);
    wheelPending = r.pending;
    if (area && r.steps) zoom(area, Math.sign(r.steps));
  }
  document.addEventListener("wheel", onWheel, { capture: true, passive: false });
  onCleanup(() => document.removeEventListener("wheel", onWheel, { capture: true }));

  // The focused area; the terminal when the focus is nowhere in particular.
  const zoomFocused = (step: number) => zoom(zoomArea(document.activeElement) ?? "terminal", step);

  // One handler per shortcut action (a missing one does not compile).
  const shortcuts: Record<Action, () => void> = {
    newTab: () => newTab(),
    closeTab: () => active() && closeTab(active()!),
    nextTab: () => step(1),
    prevTab: () => step(-1),
    toggleFiles: () => togglePanel("explorer"),
    toggleGit: () => togglePanel("git"),
    togglePrompts: () => togglePanel("prompts"),
    toggleMessages: () => togglePanel("messages"),
    newTerminal: () => consoles.open(),
    openEditor: () => openEditor(),
    focusLeft: () => focusPane("left"),
    focusRight: () => focusPane("right"),
    focusUp: () => focusPane("up"),
    focusDown: () => focusPane("down"),
    settings: () => setSettingsOpen(true),
    find: () => setFinding(true),
    renameTab: () => active() && setRenameRequest({ tab: active()! }),
    zoomIn: () => zoomFocused(1),
    zoomOut: () => zoomFocused(-1),
    zoomReset: () => zoomFocused(0),
    refreshPanels: () => {
      git.reloadNow(panelTab()?.root);
      setFilesRefresh(filesRefresh() + 1);
    },
    nextAttention: () => {
      const next = nextNeedingAttention(visualOrder(tabs(), groups()), active());
      if (next) activate(next);
    },
  };

  function onKey(e: KeyboardEvent) {
    // Never reload the app (it would restart every shell); in a terminal xterm takes the key first.
    if (isReloadKey(e) && !(e.target as Element).closest?.(".xterm")) e.preventDefault();
    if (settingsOpen()) return; // the settings page owns the keyboard (shortcut recording, Esc)
    const action = actionFor(e, settings().keys);
    if (!action) return;
    // Capture phase: handled before xterm sees the key.
    e.preventDefault();
    e.stopPropagation();
    shortcuts[action]();
  }

  onMount(() => {
    window.addEventListener("keydown", onKey, true);
    const win = getCurrentWindow();
    win.isFocused().then(setWindowFocused);
    const unlisten = [
      win.onFocusChanged(({ payload: focused }) => {
        setWindowFocused(focused);
        if (focused && active()) {
          active()!.unread = false;
          fadeDoneWhenSeen(active()!);
        }
      }),
      listen<number>("pty-exit", (e) => {
        const hit = shellOf(e.payload);
        if (!hit) return;
        // The tab's own shell ends the tab; a terminal panel's shell only leaves its panel.
        if (hit.shell.place === "main") closeTab(hit.tab, true);
        else consoles.close(hit.shell.place, hit.tab);
      }),
      listen<AgentStatus>("agent-status", (e) => onAgentStatus(e.payload)),
      listen<McpCall>("mcp-call", (e) => messaging.call(e.payload)),
      listen<AgentUsage>("agent-usage", ({ payload: u }) => {
        const hit = shellOf(u.pty);
        if (hit) hit.shell.context = u.context ?? undefined;
        // API-key sessions have no plan limits: keep what a subscription session last reported.
        if (u.fiveHour || u.sevenDay) setLimits({ fiveHour: u.fiveHour ?? undefined, sevenDay: u.sevenDay ?? undefined });
      }),
      // Another `rift.exe <dir>` was launched (Explorer menu): single-instance forwards the folder here.
      listen<string>("open-dir", (e) => newTab({ cwd: e.payload, title: "" })),
    ];
    // Closing while agents work or wait would kill them: ask first. Then install a downloaded update.
    const closeRequests = win.onCloseRequested(async (event) => {
      const busy = tabs()
        .flatMap((t) => t.shells)
        .filter((s) => s.status === "working" || s.status === "blocked").length;
      const s = busy === 1 ? "" : "s";
      if (busy && !confirm(`${busy} agent${s} still working or waiting for you. Close Rift anyway?`)) {
        event.preventDefault();
        return;
      }
      const unsaved = tabs().flatMap((t) => t.docs.filter((d) => d.dirty).map((d) => d.name));
      if (unsaved.length && !confirm(`Discard unsaved changes to ${unsaved.join(", ")}?`)) {
        event.preventDefault();
        return;
      }
      await session.flush();
      await saveHistories(tabs());
      await updater?.installIfReady();
    });
    // Registered at startup: notifications shown before a listener exists report no click.
    const notificationClicks = onAction((e) => openNotifiedTab(e.notification?.extra?.pty));
    let frame = 0;
    const resize = (sizes = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      if (dragging) return;
      frame = requestAnimationFrame(refitAll);
    }));
    resize.observe(host);
    const onSystemTheme = (e: MediaQueryListEvent) => setSystemIsDark(e.matches);
    systemDark.addEventListener("change", onSystemTheme);
    // Settings first: restored terminals are created with the right theme and font.
    invoke("settings_load")
      .then((saved) => setSettings(mergeSettings(saved)))
      .finally(restore);
    checkIntegrations();
    refreshMcp();
    invoke("prompts_load").then((saved) => setPromptLists(mergePrompts(saved)));
    invoke<string[] | null>("bench_dirs").then(async (dirs) => {
      if (!dirs) {
        // Not in dev (would offer the latest release over local work) nor in the bench.
        if (!import.meta.env.DEV) updater = startUpdates((version, restart) => setUpdate({ version, restart: () => session.flush().then(() => saveHistories(tabs())).then(restart) }));
        return;
      }
      const bench = await import("./bench");
      bench.run({
        // Alternate between the bench repos so every switch changes repo (worst case for the panels).
        newTab: () => newTab(dirs.length ? { cwd: dirs[tabs().length % dirs.length], title: "" } : undefined),
        views: () => tabs().map((t) => t.view),
        activate: (i) => activate(tabs()[i]),
        setPanels: (open) => {
          for (const id of ["explorer", "git"] as const) if (shown(id) !== open) togglePanel(id);
        },
        openDoc: (i, file) => docs.open(`${dirs[0]}/${file}`, tabs()[i]),
        showsDoc: (i) => tabs()[i].current >= 0,
        openConsoles: async (count) => {
          for (const tab of tabs().slice(0, count)) {
            activate(tab);
            consoles.open();
            await new Promise((r) => setTimeout(r, 300)); // its shell starts
          }
        },
        consoleOf: (i) => consoles.viewOf(tabs()[i]),
      });
    });
    onCleanup(() => {
      window.removeEventListener("keydown", onKey, true);
      systemDark.removeEventListener("change", onSystemTheme);
      unlisten.forEach((u) => u.then((f) => f()));
      notificationClicks.then((l) => l.unregister());
      closeRequests.then((f) => f());
      resize.disconnect();
    });
  });

  function renderPanel(id: PanelId) {
    if (id === "main") return mainEl;
    if (id === "explorer") {
      return (
        <Explorer
          root={panelTab()?.root ?? panelTab()?.cwd}
          refresh={filesRefresh()}
          onOpenFile={(path) => docs.open(path)}
          onEditFile={openEditor}
          onHistory={panelTab()?.root ? showHistory : undefined}
          onDeleted={(path) => {
            // Its documents close (asking first about unsaved changes); the git panel shows the deletion.
            for (const tab of tabs()) {
              for (let i = tab.docs.length - 1; i >= 0; i--) if (isUnder(tab.docs[i].path, path)) docs.close(tab, i);
            }
            if (shown("git")) git.reload();
          }}
          onClose={() => togglePanel("explorer")}
        />
      );
    }
    if (id === "prompts") {
      return (
        <Prompts
          repo={promptRepo()}
          prompts={promptLists()[promptKey(promptRepo() ?? "")] ?? []}
          onAdd={(text) => changePrompts(addPrompt(promptLists(), promptKey(promptRepo()!), text))}
          onEdit={(i, text) => changePrompts(editPrompt(promptLists(), promptKey(promptRepo()!), i, text))}
          onRemove={(i) => changePrompts(removePrompt(promptLists(), promptKey(promptRepo()!), i))}
          onMove={(from, to) => changePrompts(movePrompt(promptLists(), promptKey(promptRepo()!), from, to))}
          onSend={(i) => {
            const tab = active();
            const key = promptKey(promptRepo()!);
            const text = promptLists()[key]?.[i];
            if (!tab || !text) return;
            if (tab.current >= 0) docs.show(tab, -1);
            tab.view.paste(text);
            changePrompts(removePrompt(promptLists(), key, i));
          }}
          onClose={() => togglePanel("prompts")}
        />
      );
    }
    if (id === "messages") {
      return (
        <Messages
          entries={messaging.entries()}
          enabled={messagingOn()}
          onOpen={(pty) => {
            const hit = shellOf(pty);
            if (!hit) return;
            activate(hit.tab);
            if (hit.shell.place !== "main") consoles.reveal(hit.shell.place);
          }}
          onClear={messaging.clear}
          onClose={() => togglePanel("messages")}
        />
      );
    }
    if (id === "git") {
      return (
        <GitPanel
          root={panelTab()?.root}
          branch={panelTab()?.branch}
          behind={panelTab()?.stats?.behind}
          agent={agents()[0]?.name}
          refresh={git.refresh()}
          showHistory={historyAsk()}
          onClose={() => togglePanel("git")}
          onHeadChanged={() => {
            // A switch, commit, pull or push: every tab of this repo shows the new branch and stats.
            const root = panelTab()?.root;
            for (const tab of tabs()) {
              if (!root || tab.root !== root || !tab.cwd) continue;
              invoke<{ branch: string } | null>("git_head", { cwd: tab.cwd }).then((head) => (tab.branch = head?.branch));
              git.stats(tab);
            }
          }}
        />
      );
    }
    return consoles.render(id, panelName(id));
  }

  /** What Find searches: the active tab's shell the user last typed in, else its own terminal. */
  function findTarget(): TermView {
    const tab = active()!;
    return focusedShell && tab.shells.includes(focusedShell) ? focusedShell.view : tab.view;
  }

  /** Alt+arrow: focus the pane beside the focused one (the tab's terminal, a panel, a terminal panel). */
  function focusPane(dir: "left" | "right" | "up" | "down") {
    const to = paneBeside(panesEl, dir);
    if (!to) return;
    const group = index(panes()).get(to.dataset.pane!);
    const id = group && isGroup(group) ? group.shown : undefined;
    if (id === "main") active()?.shown.focus();
    else if (id && isTerminal(id)) consoles.view(id)?.focus();
    else (to.querySelector<HTMLElement>("[data-autofocus]") ?? to.querySelector<HTMLElement>("textarea, input, [tabindex]:not([tabindex='-1']), button"))?.focus();
  }

  // The tab's terminal, documents and top bar: one element for the window's life (terminals are never remounted),
  // placed in the group that holds "main".
  const mainEl = (
    <main class="main">
      <TopBar
        tab={barTab()}
        limits={limits()}
        promptsShown={shown("prompts")}
        messages={messagingOn() ? shown("messages") : undefined}
        onToggleMessages={() => togglePanel("messages")}
        gitShown={shown("git")}
        onShowDoc={docs.show}
        onCloseDoc={docs.close}
        onNewTerminal={() => consoles.open()}
        onOpenEditor={() => openEditor()}
        onTogglePrompts={() => togglePanel("prompts")}
        onToggleGit={() => togglePanel("git")}
      />
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
              Enable <b>{i.name}</b> integration: tab status icons, notifications and each tab's session restored
              on restart. {i.setup} Your other settings are kept; a .bak copy is written.
            </span>
            <button onClick={() => enable(i.id)}>Enable</button>
            <button onClick={() => setMissing(missing().filter((m) => m !== i))}>Not now</button>
          </div>
        )}
      </For>
      <div class="terms" ref={host} data-zoom="terminal">
        {/* Own wrapper: a <Show> alone in an element clears all of it when it hides (Solid sets textContent),
            which would erase every tab's terminal. */}
        <div class="contents">
          <Show when={finding() && active()}>
            <FindBar
              find={(text, backwards) => findTarget().find(text, backwards)}
              onClose={() => (findTarget().endFind(), setFinding(false))}
            />
          </Show>
        </div>
      </div>
    </main>
  ) as HTMLElement;

  return (
    <div class="app">
      <div class="sidebar-col" style={{ width: `${tabsWidth()}px` }}>
        <Sidebar
          tabs={tabs()}
          groups={groups()}
          active={active()}
          onActivate={activate}
          onClose={closeTab}
          onNewTab={(shell) => newTab(undefined, shell ? { shell } : {})}
          shells={shells()}
          onMoveTab={move}
          onMoveGroup={(id, spot) => setTabs(moveGroup(tabs(), groups(), id, spot))}
          onNewGroup={newGroup}
          onUpdateGroup={updateGroup}
          onDeleteGroup={deleteGroup}
          onCloseGroup={closeGroup}
          filesShown={shown("explorer")}
          onToggleFiles={() => togglePanel("explorer")}
          onOpenSettings={() => setSettingsOpen(true)}
          filter={filter()}
          onFilter={setFilter}
          agents={agents()}
          onNewWorktree={(tab, agent) => setWorktreeFrom({ tab, agent })}
          messages={messaging.counts}
          rename={renameRequest()}
          onFocusTerminal={() => active()?.shown.focus()}
        />
        <Resizer edge="right" size={tabsWidth()} min={160} max={480} onResize={setTabsWidth} onDragging={onDragging} />
      </div>
      <Show when={worktreeFrom()}>
        {(from) => (
          <PromptDialog
            title={`New ${from().agent.name} in a worktree`}
            placeholder="Branch name, e.g. feature/login"
            hint={`A new branch from the current commit, checked out next to the repo in ${from().tab.root?.split(/[\\/]/).pop()}.worktrees/, with a new agent session.`}
            confirm="Create"
            onSubmit={(branch) => newWorktree(from().tab, from().agent, branch)}
            onCancel={() => (setWorktreeFrom(undefined), active()?.shown.focus())}
          />
        )}
      </Show>
      <Show when={settingsOpen()}>
        <SettingsPage
          settings={settings()}
          onChange={changeSettings}
          onClose={() => (setSettingsOpen(false), active()?.shown.show())}
          onCheckUpdate={updater && updater.checkNow}
          mcp={mcp()}
          onMessaging={setMessaging}
        />
      </Show>
      <Panes root={panes()} onChange={setPanes} name={panelName} render={renderPanel} onDragging={onDragging} ref={(el) => (panesEl = el)} />
    </div>
  );
}

export default App;
