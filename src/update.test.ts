import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Update } from "@tauri-apps/plugin-updater";
import { startUpdates } from "./update";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const fakeUpdate = (version: string) => ({ version, download: vi.fn(async () => {}) }) as unknown as Update;

it("says up to date when there is nothing new, and checks again on a click", async () => {
  const find = vi.fn(async () => null);
  const updater = startUpdates(() => {}, find);
  expect(await updater.checkNow()).toBeUndefined(); // joins the startup check
  expect(find).toHaveBeenCalledTimes(1);
  expect(await updater.checkNow()).toBeUndefined(); // a later click checks again
  expect(find).toHaveBeenCalledTimes(2);
});

it("downloads a new version once, tells the banner, and answers later clicks from it", async () => {
  const update = fakeUpdate("1.3.0");
  const find = vi.fn(async () => update);
  const onReady = vi.fn();
  const updater = startUpdates(onReady, find);
  expect(await updater.checkNow()).toBe("1.3.0"); // joins the startup check
  expect(await updater.checkNow()).toBe("1.3.0"); // already downloaded
  expect(find).toHaveBeenCalledTimes(1);
  expect(update.download).toHaveBeenCalledTimes(1);
  expect(onReady).toHaveBeenCalledTimes(1);
  expect(onReady.mock.calls[0][0]).toBe("1.3.0");
});

it("reports a failed check to the click, and a later click tries again", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const find = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(null);
  const updater = startUpdates(() => {}, find);
  await expect(updater.checkNow()).rejects.toThrow("offline"); // joins the failing startup check
  expect(await updater.checkNow()).toBeUndefined();
});
