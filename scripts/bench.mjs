// Builds a production frontend + debug backend and runs the in-app tab-switch benchmark.
// Keep the window visible while it runs: WebView2 throttles frames for hidden windows.
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

// Own target dir so a running `tauri dev` (which locks target/debug/rift.exe) does not block the bench.
const env = { ...process.env, CARGO_TARGET_DIR: resolve("src-tauri/target/bench") };
const build = spawnSync("npx tauri build --debug --no-bundle", { stdio: "inherit", shell: true, env });
if (build.status !== 0) process.exit(build.status ?? 1);

const app = spawnSync("src-tauri/target/bench/debug/rift.exe", {
  env: { ...process.env, RIFT_BENCH: "1" },
  stdio: ["ignore", "inherit", "inherit"],
  timeout: 5 * 60_000,
});
process.exit(app.status ?? 1);
