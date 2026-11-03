// Auto-update from GitHub Releases (endpoint + public key in tauri.conf.json).
// A new version downloads in the background; it installs on "Restart now" or when Rift closes.
import { invoke } from "@tauri-apps/api/core";
import { check, type Update } from "@tauri-apps/plugin-updater";

const EVERY = 6 * 60 * 60 * 1000;

export type Updater = {
  /** Called by the window's close handler: installs a downloaded update (the installer then exits Rift). */
  installIfReady(): Promise<void>;
  /** Checks now (Settings button) and downloads what it finds: the new version, or undefined when up to date. */
  checkNow(): Promise<string | undefined>;
};

/**
 * Starts the update loop for the app's lifetime: at once, then every 6 h. `onReady` gets the new version once
 * it is downloaded. `find` is the updater plugin's `check` (replaced in tests).
 */
export function startUpdates(
  onReady: (version: string, restart: () => Promise<void>) => void,
  find: () => Promise<Update | null> = check,
): Updater {
  let ready: Update | undefined;
  let running: Promise<string | undefined> | undefined;

  // One check at a time: a click during the timer's check (or its download) waits for that one.
  function checkNow(): Promise<string | undefined> {
    if (ready) return Promise.resolve(ready.version);
    running ??= (async () => {
      try {
        const update = await find();
        if (!update) return undefined;
        await update.download();
        ready = update;
        onReady(update.version, () => install(true));
        return update.version;
      } finally {
        running = undefined;
      }
    })();
    return running;
  }

  // Offline, GitHub down...: try again later.
  const poll = () => checkNow().catch((e) => console.warn("update check failed", e));

  async function install(restart: boolean) {
    if (!ready) return;
    await invoke("session_freeze"); // the installer kills Rift: the session must not change anymore
    await ready.install({ restartAfterInstall: restart });
  }

  setInterval(poll, EVERY);
  poll();
  return { installIfReady: () => install(false).catch(() => {}), checkNow };
}
