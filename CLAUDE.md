# Rift Terminal

A fast Windows terminal built around coding agents (Claude Code first). The reason it exists:
Warp lags when switching tabs. **Speed beats features here. Every feature must keep tab switch
and new tab instant.**

## Performance budget (hard rules, checked in tests/benchmarks)

| Action                               | Budget        |
|--------------------------------------|---------------|
| Tab switch (Ctrl+PgUp/PgDn, click)   | < 16 ms (1 frame), no reflow of the hidden tab |
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
- **Rust backend**: PTY via `portable-pty` (ConPTY), git via the `git` CLI (simple, matches user's git config/hooks), file watching via `notify`, state in a small SQLite or JSON file under `%APPDATA%\Rift`.
- **Frontend**: TypeScript + Solid — no virtual-DOM-heavy framework. Terminal: **xterm.js with the WebGL addon**.
- **Default shell**: PowerShell 7 (`pwsh`). Shell is configurable per profile (pwsh, Windows PowerShell, cmd, Git Bash, WSL, Nushell). `ls`, `cat`, `rm` work in pwsh as aliases; Git Bash/WSL profiles for real coreutils.
- Packaging: MSI/NSIS via Tauri bundler.

## Architecture

Target layout (✅ = exists). Add a module only when its feature is built.

```
src-tauri/src/       Rust
  pty.rs ✅          spawn, resize, read/write, spare shell (Tauri-free, tested against real shells)
  lib.rs ✅          Tauri commands + setup
  session/           tab state, persistence, restore
  agents/            AgentHarness trait + adapters (claude/, later codex/, gemini/...)
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
- ConPTY sends `ESC[6n` (cursor position request) at startup and blocks until answered. xterm.js answers it. That is why `TermView` queues input on a promise until `pty_open` returns: the replayed spare output triggers the answer *before* the id is known. Tests answer it by hand (`[1;1R`).
- Each tab owns one `TermView` (one xterm) for its whole life; switching = `display: none` toggle, fit only on show.
- WebGL: browsers cap contexts (~16), so only the 8 most recently shown tabs hold a `WebglAddon` (LRU in `TermView.ts`).
- Shortcuts are handled in a capture-phase `keydown` listener (`tabs/nav.ts`) so xterm never sees them.

### Agent harness abstraction

Everything agent-specific goes through one trait so Codex/Gemini/OpenCode can be added later without touching the UI:

```rust
trait AgentHarness {
    fn id(&self) -> &'static str;                         // "claude"
    fn detect(&self, cmdline: &str) -> bool;              // is this tab running us?
    fn install_hooks(&self) -> Result<()>;                // wire status reporting
    fn resume_command(&self, session_id: &str) -> String; // e.g. `claude --resume <id>`
    fn one_shot(&self, prompt: &str, stdin: &str) -> Result<String>; // non-interactive call
}
// Status events the UI understands: Working, Idle, NeedsInput(message), Ended
```

UI code never mentions "claude" directly; it talks to `AgentHarness` and the status events.

### Claude adapter

- **Status (icon working/idle, notifications)**: Claude Code hooks. Rift registers hooks (`UserPromptSubmit` → Working, `Stop` → Idle, `Notification` → NeedsInput, `SessionStart`/`SessionEnd` → bind/unbind session). Hook command is a tiny `rift-hook` binary that forwards the hook JSON + `RIFT_TAB_ID` env var to the app over a named pipe (`\\.\pipe\rift`). Every PTY is spawned with `RIFT_TAB_ID` set, so this also works when the user types `claude` by hand.
- **Resume per tab**: the `SessionStart` hook gives `session_id` + `cwd`; store `{tab_id, cwd, harness, session_id}`. On reopen, recreate each tab in its cwd and run `claude --resume <session_id>` in the tabs that had a live agent session. Each tab resumes its *own* session, not "the last one".
- **Commit message**: `one_shot` runs `claude -p` with the staged diff on stdin and a fixed prompt. Uses the user's existing Claude login, no API key in Rift.
- Never edit the user's `~/.claude/settings.json` without asking; prefer merging Rift's hook entries and removing them cleanly on uninstall.

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
- Perf budget has a benchmark test (tab switch with 20 tabs and 50k lines scrollback each). A regression fails CI.
- Keep it small: no abstraction until a second user of it exists — except `AgentHarness`, which is a stated requirement.
- Commits: one short subject line, no sign-off trailers.

## Status
Done: tabs + PTY + spare shell + shortcuts + copy/paste. Next: tab-switch benchmark, session restore, Claude hooks/status icons, git panel, file tree, Explorer menu.

## Commands
```
npm run tauri dev                 # run (Vite on :1420 + Rust app)
npm run tauri build               # package
cd src-tauri && cargo test        # backend tests (spawn real cmd.exe)
npm test                          # frontend tests (vitest)
npm run typecheck                 # tsc --noEmit
```
