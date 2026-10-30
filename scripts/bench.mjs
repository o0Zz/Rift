// Builds a production frontend + debug backend and runs the in-app tab-switch benchmark.
// Keep the window visible while it runs: WebView2 throttles frames for hidden windows.
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Own target dir so a running `tauri dev` (which locks target/debug/rift.exe) does not block the bench.
const env = { ...process.env, CARGO_TARGET_DIR: resolve("src-tauri/target/bench") };
const build = spawnSync("npx tauri build --debug --no-bundle", { stdio: "inherit", shell: true, env });
if (build.status !== 0) process.exit(build.status ?? 1);

// A second repo with pending changes, so tabs alternate between two repos and the panels reload on each switch.
const repo = mkdtempSync(join(tmpdir(), "rift-bench-repo-"));
const git = (...args) => spawnSync("git", ["-C", repo, ...args], { stdio: "ignore" });
git("init", "-q");
for (let i = 0; i < 50; i++) writeFileSync(join(repo, `file${i}.txt`), `line ${i}\n`);
git("add", ".");
git("-c", "user.email=b@b", "-c", "user.name=bench", "commit", "-q", "-m", "init");
for (let i = 0; i < 10; i++) writeFileSync(join(repo, `file${i}.txt`), `changed ${i}\n`);

const app = spawnSync("src-tauri/target/bench/debug/rift.exe", {
  env: { ...process.env, RIFT_BENCH: "1", RIFT_BENCH_DIRS: [process.cwd(), repo].join(";") },
  stdio: ["ignore", "inherit", "inherit"],
  timeout: 5 * 60_000,
});
process.exit(app.status ?? 1);
