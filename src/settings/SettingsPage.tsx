import { createSignal, For, Match, Show, Switch, onCleanup, onMount } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { Icon } from "../ui/Icon";
import { ACTIONS, bind, comboOf, DEFAULT_KEYS, FONT_MAX, FONT_MIN, IS_MAC, isValidShortcut, type Action, type Settings, type TabSize, type ThemeChoice } from "./settings";

type Page = "general" | "appearance" | "agents" | "shortcuts" | "windows";

/** One page per subject, picked in the list on the left. */
const PAGES: Record<Page, { title: string; intro: string }> = {
  general: { title: "General", intro: "Shell, files and updates." },
  appearance: { title: "Appearance", intro: "Colors, sizes and the terminal font. Applied at once." },
  agents: { title: "Agents", intro: "How coding agents in Rift tabs work together." },
  shortcuts: { title: "Shortcuts", intro: "Click + and press the keys to add one, or × to remove it." },
  windows: { title: "Windows", intro: "Rift in File Explorer." },
};

/** The page shown last: Settings reopens there. */
let lastPage: Page = "general";

/** Settings overlay. While open, Rift's own shortcuts are off (App), so keys can be recorded. */
export function SettingsPage(props: {
  settings: Settings;
  onChange(s: Settings): void;
  onClose(): void;
  /** Checks for an update now: the new version (downloaded, banner shown) or undefined. None in dev/bench. */
  onCheckUpdate?(): Promise<string | undefined>;
  /** The agents used here and whether each has Rift's MCP server (agent messaging); undefined = loading. */
  mcp?: { id: string; name: string; installed: boolean }[];
  /** Adds or removes Rift's MCP server in every used agent's config. */
  onMessaging(on: boolean): Promise<void>;
}) {
  const [recording, setRecording] = createSignal<Action>();
  const [page, showPage] = createSignal<Page>(lastPage);
  const setPage = (p: Page) => showPage((lastPage = p));
  const [filter, setFilter] = createSignal("");
  const [note, setNote] = createSignal<string>();
  // `null`: no Explorer menu on this OS, the Windows section is hidden.
  const [menuInstalled, setMenuInstalled] = createSignal<boolean | null>();
  const [menuError, setMenuError] = createSignal<string>();
  const [version, setVersion] = createSignal<string>();
  const [profiles, setProfiles] = createSignal<{ id: string; name: string }[]>([]);
  invoke<{ id: string; name: string }[]>("shell_profiles").then(setProfiles);
  getVersion().then(setVersion);
  invoke<boolean | null>("explorer_menu_installed").then(setMenuInstalled, (e) => setMenuError(String(e)));

  async function setExplorerMenu(enabled: boolean) {
    setMenuError(undefined);
    try {
      await invoke("explorer_menu_set", { enabled });
      setMenuInstalled(await invoke<boolean | null>("explorer_menu_installed"));
    } catch (e) {
      setMenuError(String(e));
    }
  }
  const [mcpBusy, setMcpBusy] = createSignal(false);
  const [mcpError, setMcpError] = createSignal<string>();
  const messagingOn = () => !!props.mcp?.some((a) => a.installed);
  async function toggleMessaging() {
    setMcpBusy(true);
    setMcpError(undefined);
    try {
      await props.onMessaging(!messagingOn());
    } catch (e) {
      setMcpError(String(e));
    } finally {
      setMcpBusy(false);
    }
  }

  // The Windows page only where there is an Explorer menu.
  const pages = (): Page[] => ["general", "appearance", "agents", "shortcuts", ...(menuInstalled() === null ? [] : ["windows" as const])];

  const set = (patch: Partial<Settings>) => props.onChange({ ...props.settings, ...patch });

  const [updateNote, setUpdateNote] = createSignal<string>();
  const [checking, setChecking] = createSignal(false);
  async function checkUpdate() {
    setChecking(true);
    setUpdateNote("Checking…");
    try {
      const found = await props.onCheckUpdate!();
      setUpdateNote(found ? `Rift ${found} is downloaded: restart from the banner, or it installs when you close Rift.` : "Up to date.");
    } catch (e) {
      setUpdateNote(`Could not check: ${e}`);
    } finally {
      setChecking(false);
    }
  }

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = recording();
      if (!action) {
        if (e.key === "Escape") props.onClose();
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") return setRecording(undefined);
      const combo = comboOf(e);
      if (!combo) return; // a lone modifier: keep waiting
      setRecording(undefined);
      if (!isValidShortcut(combo)) return setNote(`${combo}: a shortcut must use ${IS_MAC ? "Cmd, Ctrl or Alt" : "Ctrl or Alt"} (or be F1-F12), so normal typing still reaches the terminal.`);
      const r = bind(props.settings.keys, action, combo);
      set({ keys: r.keys });
      setNote(r.takenFrom ? `${combo} was removed from “${ACTIONS[r.takenFrom]}”.` : undefined);
    };
    window.addEventListener("keydown", onKey, true);
    onCleanup(() => window.removeEventListener("keydown", onKey, true));
  });

  function unbind(action: Action, combo: string) {
    set({ keys: { ...props.settings.keys, [action]: props.settings.keys[action].filter((c) => c !== combo) } });
  }

  const themes: [ThemeChoice, string][] = [
    ["dark", "Dark"],
    ["light", "Light"],
    ["system", "System"],
  ];
  const docModes: [Settings["docs"], string][] = [
    ["single", "One at a time"],
    ["tabs", "New tab each time"],
  ];
  const tabSizes: [TabSize, string][] = [
    ["compact", "Compact"],
    ["comfortable", "Comfortable"],
    ["large", "Large"],
  ];

  return (
    <div class="settings-backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div class="settings">
        <div class="settings-head">
          <span>Settings</span>
          <button class="icon-btn" title="Close (Esc)" onClick={() => props.onClose()}>
            <Icon name="close" />
          </button>
        </div>
        <div class="settings-main">
          <nav class="settings-nav">
            <For each={pages().map((id) => [id, PAGES[id]] as const)}>
              {([id, p]) => (
                <button classList={{ on: page() === id }} onClick={() => (setRecording(undefined), setPage(id))}>
                  {p.title}
                </button>
              )}
            </For>
          </nav>
          <div class="settings-body">
            <h2>{PAGES[page()].title}</h2>
            <p class="settings-intro">{PAGES[page()].intro}</p>
            <Switch>
              <Match when={page() === "general"}>
                <div class="setting">
                  <label for="shell">
                    Default shell
                    <span class="setting-sub">What a new tab runs. Right-click + in the sidebar for another one.</span>
                  </label>
                  <select id="shell" value={props.settings.shell} onChange={(e) => set({ shell: e.currentTarget.value })}>
                    <option value="">Automatic ({profiles()[0]?.name ?? "system default"})</option>
                    <For each={profiles()}>{(p) => <option value={p.id}>{p.name}</option>}</For>
                  </select>
                </div>
                <div class="setting">
                  <label>
                    Opening a file
                    <span class="setting-sub">From the files panel: replace the shown file, or add a sub-tab each time.</span>
                  </label>
                  <div class="segmented">
                    <For each={docModes}>
                      {([value, label]) => (
                        <button classList={{ on: props.settings.docs === value }} onClick={() => set({ docs: value })}>
                          {label}
                        </button>
                      )}
                    </For>
                  </div>
                </div>
                <div class="setting">
                  <label>
                    Updates · Rift {version()}
                    <span class="setting-sub">
                      {updateNote() ??
                        (props.onCheckUpdate
                          ? "Checked at startup and every 6 hours; new versions download in the background."
                          : "Updates are off in development builds.")}
                    </span>
                  </label>
                  <Show when={props.onCheckUpdate}>
                    <button class="setting-btn" disabled={checking()} onClick={checkUpdate}>
                      Check now
                    </button>
                  </Show>
                </div>
              </Match>

              <Match when={page() === "appearance"}>
                <div class="setting">
                  <label>Theme</label>
                  <div class="segmented">
                    <For each={themes}>
                      {([value, label]) => (
                        <button classList={{ on: props.settings.theme === value }} onClick={() => set({ theme: value })}>
                          {label}
                        </button>
                      )}
                    </For>
                  </div>
                </div>
                <div class="setting">
                  <label>
                    Tab size
                    <span class="setting-sub">Height of a tab in the sidebar.</span>
                  </label>
                  <div class="segmented">
                    <For each={tabSizes}>
                      {([value, label]) => (
                        <button classList={{ on: props.settings.tabSize === value }} onClick={() => set({ tabSize: value })}>
                          {label}
                        </button>
                      )}
                    </For>
                  </div>
                </div>
                <div class="setting">
                  <label for="font-size">
                    Terminal font size
                    <span class="setting-sub">Also Ctrl+= / Ctrl+- / Ctrl+wheel over a terminal.</span>
                  </label>
                  <input
                    id="font-size"
                    type="number"
                    min={FONT_MIN}
                    max={FONT_MAX}
                    value={props.settings.fontSize}
                    onChange={(e) => {
                      const v = Number(e.currentTarget.value);
                      if (v >= FONT_MIN && v <= FONT_MAX) set({ fontSize: v });
                    }}
                  />
                </div>
                <div class="setting">
                  <label for="font-family">
                    Terminal font
                    <span class="setting-sub">A CSS font list: the first one installed is used.</span>
                  </label>
                  <input
                    id="font-family"
                    class="wide"
                    value={props.settings.fontFamily}
                    onChange={(e) => e.currentTarget.value.trim() && set({ fontFamily: e.currentTarget.value })}
                  />
                </div>
              </Match>

              <Match when={page() === "agents"}>
                <div class="setting">
                  <label>
                    Agent messaging (MCP)
                    <span class="setting-sub">
                      Agents in Rift tabs can list each other, send each other messages (typed in once the receiver is
                      idle) and start agents in new tabs. See them in the Messages panel (Ctrl+Shift+M).
                    </span>
                    <span class="setting-sub">
                      Adds Rift's MCP server to{" "}
                      {props.mcp?.length ? props.mcp.map((a) => a.name + (a.installed ? " (on)" : "")).join(", ") : "no agent used here"}.
                      Running agents get it when restarted.
                    </span>
                  </label>
                  <Show when={props.mcp?.length}>
                    <button class="setting-btn" disabled={mcpBusy()} onClick={toggleMessaging}>
                      {mcpBusy() ? "…" : messagingOn() ? "Turn off" : "Turn on"}
                    </button>
                  </Show>
                </div>
                <Show when={mcpError()}>
                  <div class="settings-note">{mcpError()}</div>
                </Show>
              </Match>

              <Match when={page() === "shortcuts"}>
                <div class="settings-tools">
                  <input
                    class="wide"
                    placeholder="Filter shortcuts"
                    value={filter()}
                    onInput={(e) => setFilter(e.currentTarget.value)}
                  />
                  <button class="link" onClick={() => (set({ keys: DEFAULT_KEYS }), setNote(undefined))}>
                    Reset to defaults
                  </button>
                </div>
                <Show when={note()}>
                  <div class="settings-note">{note()}</div>
                </Show>
                <For each={(Object.keys(ACTIONS) as Action[]).filter((a) => ACTIONS[a].toLowerCase().includes(filter().trim().toLowerCase()))}>
                  {(action) => (
                    <div class="setting">
                      <label>{ACTIONS[action]}</label>
                      <div class="keys">
                        <For each={props.settings.keys[action]}>
                          {(combo) => (
                            <span class="key">
                              {combo}
                              <span class="key-x" title="Remove" onClick={() => unbind(action, combo)}>
                                ×
                              </span>
                            </span>
                          )}
                        </For>
                        <button
                          class="key add"
                          classList={{ recording: recording() === action }}
                          onClick={() => (setNote(undefined), setRecording(recording() === action ? undefined : action))}
                        >
                          {recording() === action ? "Press keys… (Esc to cancel)" : "+"}
                        </button>
                      </div>
                    </div>
                  )}
                </For>
              </Match>

              <Match when={page() === "windows"}>
                <div class="setting">
                  <label>
                    “Open in Rift” in the File Explorer right-click menu
                    <span class="setting-sub">Opens the folder in a new tab. On Windows 11 it is under “Show more options”.</span>
                  </label>
                  <Show when={menuInstalled() !== undefined}>
                    <button class="setting-btn" onClick={() => setExplorerMenu(!menuInstalled())}>
                      {menuInstalled() ? "Remove" : "Add"}
                    </button>
                  </Show>
                </div>
                <Show when={menuError()}>
                  <div class="settings-note">{menuError()}</div>
                </Show>
              </Match>
            </Switch>
            <p class="settings-hint">Saved in settings.json next to session.json, so it can also be edited by hand.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
