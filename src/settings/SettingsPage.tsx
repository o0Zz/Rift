import { createSignal, For, Show, onCleanup, onMount } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { Icon } from "../ui/Icon";
import { ACTIONS, bind, comboOf, DEFAULT_KEYS, displayVersion, isValidShortcut, type Action, type Settings, type ThemeChoice } from "./settings";

/** Settings overlay. While open, Rift's own shortcuts are off (App), so keys can be recorded. */
export function SettingsPage(props: { settings: Settings; onChange(s: Settings): void; onClose(): void }) {
  const [recording, setRecording] = createSignal<Action>();
  const [note, setNote] = createSignal<string>();
  // `null`: no Explorer menu on this OS, the Windows section is hidden.
  const [menuInstalled, setMenuInstalled] = createSignal<boolean | null>();
  const [menuError, setMenuError] = createSignal<string>();
  const [version, setVersion] = createSignal<string>();
  getVersion().then((v) => setVersion(displayVersion(v)));
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
  const set = (patch: Partial<Settings>) => props.onChange({ ...props.settings, ...patch });

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
      if (!isValidShortcut(combo)) return setNote(`${combo}: a shortcut must use Ctrl or Alt, so normal typing still reaches the terminal.`);
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

  return (
    <div class="settings-backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div class="settings">
        <div class="settings-head">
          <span>Settings</span>
          <button class="icon-btn" title="Close (Esc)" onClick={() => props.onClose()}>
            <Icon name="close" />
          </button>
        </div>
        <div class="settings-body">
          <h3>Appearance</h3>
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
            <label for="font-size">Terminal font size</label>
            <input
              id="font-size"
              type="number"
              min="8"
              max="32"
              value={props.settings.fontSize}
              onChange={(e) => {
                const v = Number(e.currentTarget.value);
                if (v >= 8 && v <= 32) set({ fontSize: v });
              }}
            />
          </div>
          <div class="setting">
            <label for="font-family">Terminal font</label>
            <input
              id="font-family"
              class="wide"
              value={props.settings.fontFamily}
              onChange={(e) => e.currentTarget.value.trim() && set({ fontFamily: e.currentTarget.value })}
            />
          </div>

          <Show when={menuInstalled() !== null}>
            <h3>Windows</h3>
            <div class="setting">
              <label>
                “Open in Rift” in the File Explorer right-click menu
                <span class="setting-sub">
                  Opens the folder in a new tab. On Windows 11 it is under “Show more options”.
                </span>
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
          </Show>

          <h3>
            Shortcuts
            <button class="link" onClick={() => (set({ keys: DEFAULT_KEYS }), setNote(undefined))}>
              Reset to defaults
            </button>
          </h3>
          <Show when={note()}>
            <div class="settings-note">{note()}</div>
          </Show>
          <For each={Object.keys(ACTIONS) as Action[]}>
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
          <p class="settings-hint">
            Saved in settings.json next to session.json, so it can also be edited by hand.
            <Show when={version()}>
              <br />
              Rift {version()}
            </Show>
          </p>
        </div>
      </div>
    </div>
  );
}
