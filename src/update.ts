// Auto-update from GitHub Releases (endpoint + public key in tauri.conf.json).
// A new version downloads in the background; it installs on "Restart now" or when Rift closes.
import { invoke } from "@tauri-apps/api/core";
import { check, type Update } from "@tauri-apps/plugin-updater";

const EVERY = 6 * 60 * 60 * 1000;

export type Updater = {
  /** Called by the window's close handler: installs a downloaded update (the installer then exits Rift). */
  installIfReady(): Promise<void>;
};

/** Starts the update loop for the app's lifetime. `onReady` gets the new version once it is downloaded. */
export function startUpdates(onReady: (version: string, restart: () => Promise<void>) => void): Updater {
  let ready: Update | undefined;

  async function poll() {
    if (ready) return;
    try {
      const update = await check();
      if (!update) return;
      await update.download();
      ready = update;
      onReady(update.version, () => install(true));
    } catch (e) {
      console.warn("update check failed", e); // offline, GitHub down...: try again later
    }
  }

  async function install(restart: boolean) {
    if (!ready) return;
    await invoke("session_freeze"); // the installer kills Rift: the session must not change anymore
    await ready.install({ restartAfterInstall: restart });
  }

  setInterval(poll, EVERY);
  poll();
  return { installIfReady: () => install(false).catch(() => {}) };
}
