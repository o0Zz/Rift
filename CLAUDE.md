# Rift Terminal

A fast Windows terminal built around coding agents (Claude Code first). The reason it exists:
Warp lags when switching tabs. **Speed beats features here. Every feature must keep tab switch
and new tab instant.**

## Performance budget (hard rules, checked in tests/benchmarks)

| Action                               | Budget        |
|--------------------------------------|---------------|
| Tab switch: main-thread work p95     | < 16 ms (fits one frame) — `npm run bench` |
| Tab switch: key → rendered p95       | < 50 ms — `npm run bench` |
| New tab until prompt is usable       | < 150 ms (pwsh startup itself excluded from our part: < 30 ms) |
| Cold app start to first prompt       | < 500 ms      |
| Idle CPU with 10 tabs                | ~0 %          |

How we hold the budget:
- Each tab's terminal stays **mounted**. Switching only toggles visibility (`display`/`visibility`), never destroys/recreates the terminal, never replays scrollback.
- Hidden tabs keep receiving PTY output into the buffer but do not render.
- Side panels (file tree, git diff) load lazily and refresh on file-watch events, never on tab switch.
- Pre-spawn one spare shell in the background so "new tab" just attaches it.
- No work on the UI thread that scales with scrollback, repo size or number of tabs.

## Stack

- **Tauri 2** (Rust backend, system WebView2 frontend). No Electron.
- **Rust backend**: PTY via `portable-pty` (ConPTY), git via the `git` CLI (simple, matches user's git config/hooks), file watching via `notify`, state in `%APPDATA%\dev.rift.terminal\session.json` (Tauri app data dir).
- **Frontend**: TypeScript + Solid — no virtual-DOM-heavy framework. Terminal: **xterm.js, DOM renderer** (WebGL measured slower for tab switching, see below).
- **Default shell**: PowerShell 7 (`pwsh`). Shell is configurable per profile (pwsh, Windows PowerShell, cmd, Git Bash, WSL, Nushell). `ls`, `cat`, `rm` work in pwsh as aliases; Git Bash/WSL profiles for real coreutils.
- Packaging: MSI/NSIS via Tauri bundler.

## Architecture

Target layout (✅ = exists). Add a module only when its feature is built.

```
src-tauri/src/       Rust
  pty.rs ✅          spawn, resize, read/write, spare shell (Tauri-free, tested against real shells)
  lib.rs ✅          Tauri commands + setup
  main.rs ✅         `rift.exe hook <harness>` subcommand, else the app
  session.rs ✅      what to restore: tabs (cwd, title) + agent session per tab
  hook.rs ✅         hook client (`rift.exe hook`) + named-pipe server
  agents/ ✅         AgentHarness trait + adapters (claude.rs ✅, later codex, gemini...)
  git/               status, diff, stage/unstage, commit
  fs/                file tree + watcher
  notify/            Windows toast notifications
  shell_integration/ Explorer context menu (un)registration
src/                 Frontend
  tabs/ ✅  terminal/ ✅  panels/filetree/  panels/git/  settings/
```

Frontend ↔ backend via Tauri commands (request/response) and events (agent status, fs/git changes).

### Terminal pipeline (decisions already made — keep them)
- `pty_open` takes a Tauri `Channel`; PTY output is sent as `InvokeResponseBody::Raw` bytes (no JSON) and fed to `term.write(Uint8Array)`. Shell exit is the `pty-exit` event (payload: pty id).
- Exit is detected by waiting on the child, not by reader EOF: ConPTY keeps the pipe open after the shell exits.
- Spare shell: started at launch and after every `pty_open` without `cwd`. Its output is buffered in `Sink::Buffer` and replayed on attach.
- ConPTY sends `ESC[6n` (cursor position request) at startup and blocks until answered. xterm.js answers it. That is why `TermView` queues input on a promise until `pty_open` returns: the replayed spare output triggers the answer *before* the id is known. Tests answer it by hand (`\x1b[1;1R`).
- Each tab owns one `TermView` (one xterm) for its whole life; switching = `display: none` toggle, fit only on show.
- No WebGL addon. Measured: creating a WebGL context on show made cycling 20 tabs ~54 ms p95 vs ~15 ms with the DOM renderer, and browsers cap contexts at ~16. Re-adding it needs a bench that proves a win.
- Known latency floor: xterm resumes a hidden terminal via IntersectionObserver, which costs ~1 extra frame (~20-27 ms p50 key → rendered). Next thing to attack if switching ever feels slow.
- Shortcuts are handled in a capture-phase `keydown` listener (`tabs/nav.ts`) so xterm never sees them.

### Agent harness abstraction

Everything agent-specific goes through one trait so Codex/Gemini/OpenCode can be added later without touching the UI:

`src-tauri/src/agents/mod.rs`: `id`, `name`, `parse_hook(payload) -> AgentEvent`, `resume_command(session_id)`, `hooks_installed(exe)`, `install_hooks(exe)`. Add methods when a feature needs them (planned: status events Working/Idle/NeedsInput, `one_shot` for commit messages).

UI and session code never mention "claude" directly; they talk to `AgentHarness`, `AgentEvent` and `AgentSession { harness, session_id }`.

### Session restore (decisions already made — keep them)
- Shells are spawned with `RIFT_TAB_ID` (pty id) and `RIFT_PIPE` (`rift-<pid>`, one pipe per Rift instance). The agent's hook runs `rift.exe hook <harness>`, which forwards stdin + tab id to that pipe. Outside Rift (no env) it is a silent no-op; it always exits 0.
- PowerShell starts with `-NoExit -EncodedCommand <init + startup>`: init wraps the user's prompt (after their profile) to emit OSC 9;9 with the cwd; startup is e.g. `claude --resume <id>`. No file written, user profile untouched.
- Frontend owns the tab list (`session_update`); hooks own the agent binding per pty. `SessionStore` writes on every change (tmp + rename), never before the frontend's first report, never after `CloseRequested` (freeze), so killing shells on close cannot erase sessions.
- `SessionEnded` only unbinds if it matches the bound id (`/clear` starts the new session before ending the old one).
- A restored tab binds its session at `pty_open`, before the agent reports anything.
- Resume only accepts UUID-shaped ids, so a tampered session file cannot inject shell commands.
- `RIFT_BENCH` uses a temp session file so the bench never touches the user's tabs.

### Claude adapter

- **Hooks**: registered in `~/.claude/settings.json` in **exec form** (`"command": "<path>\rift.exe", "args": ["hook", "claude"]`); shell form would run through Git Bash on Windows. Installed only when the user clicks "Enable" in the app banner. Other settings are preserved (key order too), a `.bak` is written, an older Rift entry (other exe path) is replaced. Today: `SessionStart`/`SessionEnd`. Next: `UserPromptSubmit` → Working, `Stop` → Idle, `Notification` → NeedsInput.
- **Resume per tab**: on reopen each tab starts in its cwd and runs `claude --resume <its own session_id>`. Also works when the user types `claude` by hand, since the env comes from the tab's shell.
- **Commit message**: `one_shot` runs `claude -p` with the staged diff on stdin and a fixed prompt. Uses the user's existing Claude login, no API key in Rift.
- Never edit the user's `~/.claude/settings.json` without their click. Uninstall (removing Rift's entries) is not built yet.

## Features

### MVP (v0.1)
- Tabs: new / close / rename / reorder, Ctrl+Shift+T, Ctrl+Shift+W (Ctrl+T/W stay with the shell), **Ctrl+PgUp / Ctrl+PgDn**, Ctrl+(Shift+)Tab, middle-click close. Instant switch.
- Terminal: pwsh default, profiles, copy/paste, find (Ctrl+F), links clickable, configurable font/theme.
- Agent status icon on each tab (working / idle / needs input) + Windows toast when an agent finishes or needs input while its tab is not focused.
- Session restore: tabs, cwd, titles, and per-tab Claude session resume.
- Right panel: git changes of the active tab's repo, file diff, **checkboxes to select files to commit**, commit message box, **"Generate message" button (AI from staged diff)**, commit.
- Left panel: file explorer of the active tab's cwd (open file in default editor, reveal in Explorer, copy path).
- Explorer integration: "Open in Rift" on folder and folder background right-click.

### v0.2
- Split panes, command palette (Ctrl+Shift+P), tab configs / launch configurations, global hotkey (quake mode), stage hunks, editable diff, send inline review comment to the tab's agent, git worktree per tab, vertical tabs with branch metadata, unified notification center.

### Warp features deliberately out of scope
Blocks/rewritten input editor (would fight PowerShell's PSReadLine and cost speed), built-in AI agent, Warp Drive / notebooks / team sharing, cloud agents, built-in code editor with LSP, session sharing, accounts/login. Revisit only if asked.

### Warp feature reference (for later decisions)
Blocks (actions, find, filter, sharing, sticky header), input editor (syntax highlight, completions, autosuggestions, history search, vim keys, synchronized inputs, command corrections), tabs & vertical tabs, split panes, tab configs, launch configs, global hotkey, configurable toolbar, session restoration, themes/fonts/opacity/blur/pane dimming, settings file + sync, subshell/SSH warpify, markdown viewer, desktop notifications, bell, quit warning, URI scheme, command palette, code editor + file tree + LSP, code review panel, git worktrees, Warp Agent / CLI / cloud agents, third-party agents (Claude Code, Codex, Gemini CLI, OpenCode), Warp Drive (workflows, notebooks, prompts, env vars), team & session sharing.

## Windows specifics
- Explorer menu: register under `HKCU\Software\Classes\Directory\shell\Rift` and `...\Directory\Background\shell\Rift` (no admin). On Windows 11 this appears under "Show more options"; the top-level modern menu needs a sparse MSIX package + `IExplorerCommand` (v0.2).
- CLI: `rift.exe <dir>` opens a new tab in the running instance (single-instance plugin), not a new window.
- Notifications: Windows toast via `tauri-plugin-notification`; click focuses the right tab.

## Conventions
- Rust: `cargo fmt`, `cargo clippy -- -D warnings`. Frontend: `tsc --noEmit`, eslint.
- Every feature ships with tests in the same change. Prefer end-to-end: real PTY spawn, real git repo in a temp dir, real hook JSON through the named pipe.
- Perf budget has a benchmark (`src/bench.ts`: 20 tabs x 10k lines, cycle + toggle). Run it after any change to tabs, terminal or rendering; it exits non-zero over budget.
- Keep it small: no abstraction until a second user of it exists — except `AgentHarness`, which is a stated requirement.
- Commits: one short subject line, no sign-off trailers.

## Status
Done: tabs + PTY + spare shell + shortcuts + copy/paste + tab-switch bench + session restore (tabs, cwd, per-tab Claude resume). Next: Claude status icons + notifications, git panel, file tree, Explorer menu.

## Commands
```
npm run tauri dev                 # run (Vite on :1420 + Rust app)
npm run tauri build               # package
cd src-tauri && cargo test        # backend tests (spawn real cmd.exe)
npm test                          # frontend tests (vitest)
npm run typecheck                 # tsc --noEmit
npm run bench                     # tab-switch benchmark in the real WebView (keep the window visible; fails over budget)
```
