// Builds a production frontend + debug backend and runs the in-app tab-switch benchmark.
// Keep the window visible while it runs: WebView2 throttles frames for hidden windows.
import { spawnSync } from "node:child_process";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
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

// Heavy output: ~8 MB of colored log-like lines, printed in a tab (like a big `cat` or a fast agent).
const output = join(mkdtempSync(join(tmpdir(), "rift-bench-out-")), "output.txt");
const colors = [31, 32, 33, 34, 35, 36];
let text = "";
for (let i = 0; i < 100_000; i++) {
  text += `\x1b[${colors[i % 6]}m${String(i).padStart(6)}\x1b[0m  INFO  request handled in ${i % 97} ms  path=/api/v1/items/${i}  status=200\r\n`;
}
writeFileSync(output, text);
console.log(`heavy output file: ${(statSync(output).size / 1e6).toFixed(1)} MB`);

const app = spawnSync("src-tauri/target/bench/debug/rift.exe", {
  env: { ...process.env, RIFT_BENCH: "1", RIFT_BENCH_DIRS: [process.cwd(), repo].join(";"), RIFT_BENCH_OUTPUT: output },
  stdio: ["ignore", "inherit", "inherit"],
  timeout: 5 * 60_000,
});
process.exit(app.status ?? 1);
