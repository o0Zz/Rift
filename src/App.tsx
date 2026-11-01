import { batch, createEffect, createSignal, For, on, onCleanup, onMount, Show, untrack } from "solid-js";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { onAction, sendNotification } from "@tauri-apps/plugin-notification";
import { TermView, type AgentSession, type TermLook } from "./terminal/TermView";
import { TERMINAL_THEMES } from "./terminal/themes";
import { neighbour } from "./tabs/nav";
import { actionFor, DEFAULTS, displayVersion, isReloadKey, mergeSettings, resolveTheme, TAB_ROW_HEIGHT, type Settings } from "./settings/settings";
import { SettingsPage } from "./settings/SettingsPage";
import { startUpdates, type Updater } from "./update";
import {
  displayTitle,
  moveGroup,
  moveTab,
  needsAttention,
  nextNeedingAttention,
  shouldNotify,
  statusAfterEscape,
  visualOrder,
  type Agent,
  type Drop,
  type Group,
  type Status,
  type TabFilter,
} from "./tabs/layout";
import { Tab, type GitStats } from "./tabs/Tab";
import { DocView } from "./docs/DocView";
import { afterClose, placeDoc } from "./docs/place";
import { Sidebar } from "./tabs/Sidebar";
import { GitStatsView } from "./tabs/GitStats";
import { limitsLabel, limitsTitle, type Limit, type Limits } from "./tabs/usage";
import { Icon } from "./ui/Icon";
import { Explorer } from "./panels/Explorer";
import { isUnder } from "./panels/fileOps";
import { GitPanel } from "./panels/GitPanel";
import { Prompts } from "./panels/Prompts";
import { addPrompt, editPrompt, mergePrompts, promptKey, removePrompt, type PromptLists } from "./panels/promptLists";
import { Resizer } from "./ui/Resizer";
import { FindBar } from "./ui/FindBar";
import { PromptDialog } from "./ui/PromptDialog";
import "./App.css";

type TabUi = { name?: string; color?: string; group?: string; shell?: string; snap?: string; docs?: string[]; doc?: number };
type SavedTab = { cwd?: string; title: string; agent?: AgentSession; ui?: TabUi };
type Panels = { explorer: boolean; git: boolean; prompts: boolean };
type Widths = { tabs: number; explorer: number; git: number; prompts: number };
type Saved = { tabs: SavedTab[]; active: number; layout?: { groups?: Group[]; panels?: Panels; widths?: Widths } };
type Integration = { id: string; name: string; detected: boolean; installed: boolean; setup: string };
type AgentStatus = { pty: number; harness: string; status: Status | null; message: string | null };
type AgentUsage = { pty: number; context: number | null } & { [K in keyof Limits]: Limit | null };

function App() {
  let host!: HTMLDivElement;
  const [tabs, setTabs] = createSignal<Tab[]>([]);
  const [groups, setGroups] = createSignal<Group[]>([]);
  const [active, setActive] = createSignal<Tab>();
  const [missing, setMissing] = createSignal<Integration[]>([]);
  const [agents, setAgents] = createSignal<Integration[]>([]);
  const [shells, setShells] = createSignal<{ id: string; name: string }[]>([]);
  invoke<{ id: string; name: string }[]>("shell_profiles").then(setShells);
  // The default shell (settings) is the backend's: spare shells start with it.
  createEffect(on(() => settings().shell, (id) => invoke("shell_set_default", { id: id || null }), { defer: true }));
  const [update, setUpdate] = createSignal<{ version: string; restart: () => Promise<void> }>();
  // Plan limits from the latest status line (they are per account, not per tab).
  const [limits, setLimits] = createSignal<Limits>({});
  // From Tauri's window events: document.hasFocus() is not reliable in WebView2.
  const [windowFocused, setWindowFocused] = createSignal(true);
  const [settings, setSettings] = createSignal<Settings>(DEFAULTS);
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  const [finding, setFinding] = createSignal(false);
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

  // Window title: version, plus how many tabs need the user ("Rift 1.2.3.45 — 2 waiting").
  const [version, setVersion] = createSignal("");
  getVersion().then((v) => setVersion(displayVersion(v)));
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

  const [panels, setPanels] = createSignal<Panels>({ explorer: false, git: false, prompts: false });
  const [widths, setWidths] = createSignal<Widths>({ tabs: 240, explorer: 240, git: 440, prompts: 320 });
  // Prompts prepared in advance, per repo; saved on each change (a user action, never in the background).
  const [promptLists, setPromptLists] = createSignal<PromptLists>({});
  const promptRepo = () => panelTab()?.root ?? panelTab()?.cwd;
  const changePrompts = (next: PromptLists) => {
    setPromptLists(next);
    invoke("prompts_save", { value: next });
  };
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
    panelTimer = setTimeout(() => {
      const root = tab?.root;
      const same = root === panelTab()?.root;
      setPanelTab(tab);
      // Another repo loads anyway; the same one reloads only if something may have changed it.
      if (root && changedRepos.delete(root) && same && panels().git) setGitRefresh(gitRefresh() + 1);
    }, 150);
  });
  // Repos where files may have changed since the git panel loaded them: a prompt came back or an agent
  // moved. Switching tabs reloads the panel only for those, so a switch where nothing happened costs nothing.
  const changedRepos = new Set<string>();
  const [gitRefresh, setGitRefresh] = createSignal(0); // bumped to reload the git panel in place
  const [filesRefresh, setFilesRefresh] = createSignal(0); // bumped to reload the files panel (F5)
  // Keep the spare shell in the active tab's folder, so a new tab there (which opens in the same
  // folder) is instant. Only once the tab and its folder stay put: each move costs a shell start.
  let prewarmTimer = 0;
  createEffect(() => {
    const cwd = active()?.cwd;
    clearTimeout(prewarmTimer);
    prewarmTimer = setTimeout(() => invoke("pty_prewarm", { cwd: cwd ?? null }), 1000);
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
        ui: {
          name: t.name,
          color: t.color,
          group: t.group,
          shell: t.shell,
          snap: t.snap,
          docs: t.docs.map((d) => d.path),
          doc: t.current,
        } satisfies TabUi,
      })),
      active: Math.max(0, list.indexOf(active()!)),
      layout: { groups: groups(), panels: panels(), widths: widths() },
    });
  }
  createEffect(save);

  // Git stats per tab (~80 ms of git in the background, never on a tab switch): after a prompt or an agent
  // status change, coalesced so that a burst of prompts costs one refresh per tab and 1.5 s.
  const statsPending = new WeakSet<Tab>();
  function refreshStats(tab: Tab) {
    if (statsPending.has(tab)) return;
    statsPending.add(tab);
    setTimeout(async () => {
      statsPending.delete(tab);
      const root = tab.root;
      tab.stats = root ? await invoke<GitStats>("git_stats", { root }).catch(() => undefined) : undefined;
    }, 1500);
  }

  /** Saves every shell tab's history (agent tabs are redisplayed by resuming). Before closing or updating. */
  function saveHistories() {
    return Promise.all(
      tabs()
        .filter((t) => !t.agent)
        .map((t) => invoke("scrollback_save", { id: t.snap, data: t.view.snapshot() }).catch(() => {})),
    );
  }

  /** A finished agent the user has now seen goes back to the plain agent icon after a moment. */
  function fadeDoneWhenSeen(tab: Tab) {
    if (tab.status !== "done") return;
    setTimeout(() => {
      if (tab.status === "done" && active() === tab && windowFocused()) tab.status = "idle";
    }, 3000);
  }

  function activate(tab: Tab) {
    const t0 = performance.now();
    if (active() !== tab) active()?.shown.hide();
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

  /** New tabs open right after the active one, in its group and its folder. */
  function newTab(
    saved?: SavedTab,
    opts: { cwd?: string; name?: string; group?: string; startAgent?: string; shell?: string } = {},
  ): Promise<void> {
    const tab = new Tab();
    const cwd = saved ? saved.cwd : (opts.cwd ?? active()?.cwd);
    tab.title = saved?.title ?? "shell";
    tab.cwd = cwd;
    tab.name = saved?.ui?.name ?? opts.name;
    tab.color = saved?.ui?.color;
    tab.group = saved ? saved.ui?.group : (opts.group ?? active()?.group);
    // Like the folder, a new tab keeps the shell of the tab it was opened from.
    tab.shell = saved ? saved.ui?.shell : (opts.shell ?? active()?.shell);
    if (saved?.ui?.snap) tab.snap = saved.ui.snap;
    // Restored documents are read only when first shown.
    if (saved?.ui?.docs?.length) {
      tab.docs = saved.ui.docs.map((path) => makeDoc(tab, path));
      tab.current = Math.min(saved.ui.doc ?? -1, tab.docs.length - 1);
    }
    const onCwd = (cwd: string) => {
      tab.cwd = cwd;
      // At every prompt: also catches `git checkout` (same cwd, new branch).
      invoke<{ root: string; branch: string } | null>("git_head", { cwd }).then((head) =>
        batch(() => {
          tab.root = head?.root;
          tab.branch = head?.branch;
          if (head) changedRepos.add(head.root);
          refreshStats(tab);
        }),
      );
    };
    if (cwd) onCwd(cwd);
    tab.view = new TermView(
      host,
      {
        onTitle: (v) => (tab.title = v),
        onCwd,
        isAgent: () => !!tab.agent,
        onEscape: () => (tab.status = statusAfterEscape(tab.status)),
      },
      look(),
    );
    if (tab.current >= 0) tab.view.hide(); // a restored document is shown instead

    const list = [...tabs()];
    const after = saved ? -1 : list.indexOf(active()!);
    list.splice(after < 0 ? list.length : after + 1, 0, tab);
    active()?.shown.hide();
    setTabs(list);
    activate(tab);
    // A restored shell tab shows its previous history first. Not agent tabs: resuming redisplays the session.
    const history =
      saved?.ui?.snap && !saved.agent
        ? invoke<string | null>("scrollback_load", { id: saved.ui.snap }).catch(() => null)
        : Promise.resolve(null);
    return history
      .then((h) => h && tab.view.restoreSnapshot(h))
      .then(() => tab.view.start(cwd, saved?.agent, opts.startAgent, tab.shell))
      .then(save) // the pty id is not reactive
      .catch((e) => void (tab.title = `error: ${e}`));
  }

  async function restore() {
    const saved = await invoke<Saved>("session_restore");
    setGroups(saved.layout?.groups ?? []);
    if (saved.layout?.panels) setPanels({ ...panels(), ...saved.layout.panels });
    if (saved.layout?.widths) setWidths({ ...widths(), ...saved.layout.widths });
    const starts = batch(() => (saved.tabs.length ? saved.tabs : [undefined]).map(newTab));
    const list = tabs();
    activate(list[Math.min(saved.active, list.length - 1)]);
    await Promise.all(starts);
    setRestored(true);
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
    tab.view.dispose();
    const rest = order.filter((t) => t !== tab);
    setTabs(tabs().filter((t) => t !== tab));
    if (rest.length === 0) {
      getCurrentWindow().close();
    } else if (active() === tab) {
      activate(rest[Math.min(i, rest.length - 1)]);
    }
  }

  // Documents: files opened from the files panel, shown in the tab instead of its terminal (top bar sub-tabs).
  function makeDoc(tab: Tab, path: string): DocView {
    const doc: DocView = new DocView(host, path, {
      // Not text (binary, too big): the default app opens it instead.
      onNotText: () => {
        invoke("fs_open", { path });
        const i = tab.docs.indexOf(doc);
        if (i >= 0) closeDoc(tab, i, true);
      },
      onOpenFile: (p) => openDoc(p, tab),
    });
    return doc;
  }

  /** Shows document `index` of the tab, or its terminal (-1). */
  function showDoc(tab: Tab, index: number) {
    const front = tab === active();
    if (front) tab.shown.hide();
    tab.current = index;
    if (!front) return;
    tab.shown.show();
    tab.shown.focus();
  }

  function openDoc(path: string, tab = active()) {
    if (!tab) return;
    const { index, replace } = placeDoc(tab.docs, tab.current, path, settings().docs === "single");
    if (index < tab.docs.length && !replace) return showDoc(tab, index);
    const docs = [...tab.docs];
    const [old] = docs.splice(index, replace ? 1 : 0, makeDoc(tab, path));
    old?.dispose();
    tab.docs = docs;
    showDoc(tab, index);
  }

  function closeDoc(tab: Tab, index: number, force = false) {
    const doc = tab.docs[index];
    if (!force && doc.dirty && !confirm(`Discard unsaved changes to ${doc.name}?`)) return;
    const shown = tab.current === index;
    batch(() => {
      tab.current = afterClose(tab.current, index);
      tab.docs = tab.docs.filter((d) => d !== doc);
    });
    doc.dispose();
    if (shown && tab === active()) {
      tab.shown.show();
      tab.shown.focus();
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

  /** Closes every tab of the group, then the group (the window closes if no tab is left, as for a last tab). */
  function closeGroup(id: string) {
    for (const t of tabs().filter((t) => t.group === id)) closeTab(t);
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

  function togglePanel(panel: keyof Panels) {
    setPanels({ ...panels(), [panel]: !panels()[panel] });
  }

  function onAgentStatus({ pty, harness, status, message }: AgentStatus) {
    const tab = tabs().find((t) => t.view.ptyId === pty);
    if (!tab) return;
    batch(() => {
      tab.status = status ?? undefined;
      tab.agent = status ? harness : undefined;
      if (!status) tab.context = undefined;
    });
    refreshStats(tab); // an agent at work changes files
    if (tab.root) changedRepos.add(tab.root);
    // Finished in the repo the git panel shows (any tab): reload it now to show the agent's changes.
    if (tab.status === "done" && tab.root && panels().git && panelTab()?.root === tab.root) {
      changedRepos.delete(tab.root);
      setGitRefresh(gitRefresh() + 1);
    }
    const visible = active() === tab && windowFocused();
    if (visible) fadeDoneWhenSeen(tab);
    if (!shouldNotify(tab.status, visible)) return;
    tab.unread = true;
    if (!windowFocused()) getCurrentWindow().requestUserAttention(UserAttentionType.Informational);
    sendNotification({
      id: ++notificationId,
      title: `${tab.status === "done" ? "✓" : "■"} ${displayTitle(tab)}`,
      body: tab.status === "done" ? "Agent finished" : message || "Agent needs your input",
      extra: { pty }, // brought back by a click (onAction) to open this tab
    });
  }

  let notificationId = 0;

  /** A click on a notification: bring Rift to the front on the tab it was about. */
  async function openNotifiedTab(pty: unknown) {
    const win = getCurrentWindow();
    await win.unminimize();
    await win.show();
    await win.setFocus();
    const tab = tabs().find((t) => t.view.ptyId === pty);
    if (tab) activate(tab);
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

  function zoom(step: number) {
    const fontSize = step === 0 ? DEFAULTS.fontSize : Math.min(32, Math.max(8, settings().fontSize + step));
    if (fontSize !== settings().fontSize) changeSettings({ ...settings(), fontSize });
  }

  function onKey(e: KeyboardEvent) {
    // Never reload the app (it would restart every shell); in a terminal xterm takes the key first.
    if (isReloadKey(e) && !(e.target as Element).closest?.(".xterm")) e.preventDefault();
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
    else if (action === "togglePrompts") togglePanel("prompts");
    else if (action === "settings") setSettingsOpen(true);
    else if (action === "find") setFinding(true);
    else if (action === "renameTab") active() && setRenameRequest({ tab: active()! });
    else if (action === "zoomIn") zoom(1);
    else if (action === "zoomOut") zoom(-1);
    else if (action === "zoomReset") zoom(0);
    else if (action === "refreshPanels") {
      const root = panelTab()?.root;
      if (root) changedRepos.delete(root);
      setGitRefresh(gitRefresh() + 1);
      setFilesRefresh(filesRefresh() + 1);
    }
    else if (action === "nextAttention") {
      const next = nextNeedingAttention(visualOrder(tabs(), groups()), active());
      if (next) activate(next);
    }
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
        const tab = tabs().find((t) => t.view.ptyId === e.payload);
        if (tab) closeTab(tab, true);
      }),
      listen<AgentStatus>("agent-status", (e) => onAgentStatus(e.payload)),
      listen<AgentUsage>("agent-usage", ({ payload: u }) => {
        const tab = tabs().find((t) => t.view.ptyId === u.pty);
        if (tab) tab.context = u.context ?? undefined;
        // API-key sessions have no plan limits: keep what a subscription session last reported.
        if (u.fiveHour || u.sevenDay) setLimits({ fiveHour: u.fiveHour ?? undefined, sevenDay: u.sevenDay ?? undefined });
      }),
      // Another `rift.exe <dir>` was launched (Explorer menu): single-instance forwards the folder here.
      listen<string>("open-dir", (e) => newTab({ cwd: e.payload, title: "" })),
    ];
    // Closing while agents work or wait would kill them: ask first. Then install a downloaded update.
    const closeRequests = win.onCloseRequested(async (event) => {
      const busy = tabs().filter((t) => t.status === "working" || t.status === "blocked").length;
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
      await saveHistories();
      await updater?.installIfReady();
    });
    // Registered at startup: notifications shown before a listener exists report no click.
    const notificationClicks = onAction((e) => openNotifiedTab(e.notification?.extra?.pty));
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
    invoke("prompts_load").then((saved) => setPromptLists(mergePrompts(saved)));
    invoke<string[] | null>("bench_dirs").then(async (dirs) => {
      if (!dirs) {
        // Not in dev (would offer the latest release over local work) nor in the bench.
        if (!import.meta.env.DEV) updater = startUpdates((version, restart) => setUpdate({ version, restart: () => saveHistories().then(restart) }));
        return;
      }
      const bench = await import("./bench");
      bench.run({
        // Alternate between the bench repos so every switch changes repo (worst case for the panels).
        newTab: () => newTab(dirs.length ? { cwd: dirs[tabs().length % dirs.length], title: "" } : undefined),
        views: () => tabs().map((t) => t.view),
        activate: (i) => activate(tabs()[i]),
        setPanels: (open) => setPanels({ ...panels(), explorer: open, git: open }),
        openDoc: (i, file) => openDoc(`${dirs[0]}/${file}`, tabs()[i]),
        showsDoc: (i) => tabs()[i].current >= 0,
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

  return (
    <div class="app">
      <div class="pane" style={{ width: `${widths().tabs}px` }}>
      <Sidebar
        tabs={tabs()}
        groups={groups()}
        active={active()}
        onActivate={activate}
        onClose={closeTab}
        onNewTab={(shell) => newTab(undefined, shell ? { shell } : {})}
        shells={shells()}
        onMoveTab={move}
        onMoveGroup={(id, before) => setGroups(moveGroup(groups(), id, before))}
        onNewGroup={newGroup}
        onUpdateGroup={updateGroup}
        onDeleteGroup={deleteGroup}
        onCloseGroup={closeGroup}
        panels={panels()}
        onTogglePanel={togglePanel}
        onOpenSettings={() => setSettingsOpen(true)}
        filter={filter()}
        onFilter={setFilter}
        agents={agents()}
        onNewWorktree={(tab, agent) => setWorktreeFrom({ tab, agent })}
        rename={renameRequest()}
        onFocusTerminal={() => active()?.shown.focus()}
      />
        <Resizer edge="right" size={widths().tabs} min={160} max={480} onResize={resizeWidth("tabs")} onDragging={onDragging} />
      </div>
      <Show when={panels().explorer}>
        <div class="pane" style={{ width: `${widths().explorer}px` }}>
          <Explorer
            root={panelTab()?.root ?? panelTab()?.cwd}
            refresh={filesRefresh()}
            onOpenFile={(path) => openDoc(path)}
            onDeleted={(path) => {
              // Its documents close (asking first about unsaved changes); the git panel shows the deletion.
              for (const tab of tabs()) {
                for (let i = tab.docs.length - 1; i >= 0; i--) if (isUnder(tab.docs[i].path, path)) closeDoc(tab, i);
              }
              if (panels().git) setGitRefresh(gitRefresh() + 1);
            }}
            onClose={() => togglePanel("explorer")}
          />
          <Resizer
            edge="right"
            size={widths().explorer}
            min={160}
            max={600}
            onResize={resizeWidth("explorer")}
            onDragging={onDragging}
          />
        </div>
      </Show>
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
        />
      </Show>
      <main class="main">
        {/* Like Warp: the active tab's branch and changes on the right, opening the git panel. */}
        <div class="topbar">
          <Show
            when={barTab()?.docs.length ? barTab() : undefined}
            fallback={<span class="topbar-title">{barTab() ? displayTitle(barTab()!) : ""}</span>}
          >
            {(tab) => (
              <div class="doc-tabs">
                <button class="doc-tab" classList={{ on: tab().current < 0 }} onClick={() => showDoc(tab(), -1)}>
                  Terminal
                </button>
                <For each={tab().docs}>
                  {(doc, i) => (
                    <div
                      class="doc-tab"
                      classList={{ on: tab().current === i() }}
                      title={doc.path}
                      onClick={() => showDoc(tab(), i())}
                      onAuxClick={(e) => e.button === 1 && closeDoc(tab(), i())}
                    >
                      <span class="doc-name">{doc.name}</span>
                      <Show when={doc.dirty}>
                        <span class="doc-dirty" title="Unsaved (Ctrl+S)" />
                      </Show>
                      <button
                        class="doc-close"
                        title="Close"
                        onClick={(e) => (e.stopPropagation(), closeDoc(tab(), i()))}
                      >
                        <Icon name="close" size={10} />
                      </button>
                    </div>
                  )}
                </For>
              </div>
            )}
          </Show>
          <Show when={barTab()?.docs[barTab()!.current]?.markdown && barTab()!.docs[barTab()!.current]}>
            {(doc) => (
              <button class="doc-mode" onClick={() => doc().toggleEdit()}>
                {doc().editing ? "Read" : "Edit"}
              </button>
            )}
          </Show>
          <Show when={limitsLabel(limits())}>
            {(label) => (
              <span class="usage" title={limitsTitle(limits())}>
                {label()}
              </span>
            )}
          </Show>
          <button
            class="icon-btn"
            classList={{ on: panels().prompts }}
            onClick={() => togglePanel("prompts")}
            title="Prompts (Ctrl+Shift+O)"
          >
            <Icon name="list" />
          </button>
          <button
            class="git-button"
            classList={{ on: panels().git }}
            onClick={() => togglePanel("git")}
            title="Git changes (Ctrl+Shift+G)"
          >
            <Icon name="branch" size={14} />
            <span>{barTab()?.branch ?? "Git"}</span>
            <GitStatsView stats={barTab()?.stats} />
          </button>
        </div>
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
        <div class="terms" ref={host}>
          <Show when={finding() && active()}>
            <FindBar
              find={(text, backwards) => active()!.view.find(text, backwards)}
              onClose={() => (setFinding(false), active()?.view.endFind())}
            />
          </Show>
        </div>
      </main>
      <Show when={panels().prompts}>
        <div class="pane" style={{ width: `${widths().prompts}px` }}>
          <Resizer edge="left" size={widths().prompts} min={220} max={800} onResize={resizeWidth("prompts")} onDragging={onDragging} />
          <Prompts
            repo={promptRepo()}
            prompts={promptLists()[promptKey(promptRepo() ?? "")] ?? []}
            onAdd={(text) => changePrompts(addPrompt(promptLists(), promptKey(promptRepo()!), text))}
            onEdit={(i, text) => changePrompts(editPrompt(promptLists(), promptKey(promptRepo()!), i, text))}
            onRemove={(i) => changePrompts(removePrompt(promptLists(), promptKey(promptRepo()!), i))}
            onSend={(i) => {
              const tab = active();
              const key = promptKey(promptRepo()!);
              const text = promptLists()[key]?.[i];
              if (!tab || !text) return;
              if (tab.current >= 0) showDoc(tab, -1);
              tab.view.paste(text);
              changePrompts(removePrompt(promptLists(), key, i));
            }}
            onClose={() => togglePanel("prompts")}
          />
        </div>
      </Show>
      <Show when={panels().git}>
        <div class="pane" style={{ width: `${widths().git}px` }}>
          <Resizer edge="left" size={widths().git} min={280} max={1000} onResize={resizeWidth("git")} onDragging={onDragging} />
          <GitPanel
            root={panelTab()?.root}
            branch={panelTab()?.branch}
            agent={agents()[0]?.name}
            refresh={gitRefresh()}
            onClose={() => togglePanel("git")}
            onHeadChanged={() => {
              // A switch, commit, pull or push: every tab of this repo shows the new branch and stats.
              const root = panelTab()?.root;
              for (const tab of tabs()) {
                if (!root || tab.root !== root || !tab.cwd) continue;
                invoke<{ branch: string } | null>("git_head", { cwd: tab.cwd }).then((head) => (tab.branch = head?.branch));
                refreshStats(tab);
              }
            }}
          />
        </div>
      </Show>
    </div>
  );
}

export default App;
