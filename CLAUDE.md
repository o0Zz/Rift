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
  git.rs ✅          branch from .git/HEAD (no process); status/diff via git CLI (CREATE_NO_WINDOW)
  files.rs ✅        one directory level per call (explorer is lazy, never walks recursively)
  settings.rs ✅     settings.json (frontend owns its shape), next to session.json
  explorer_menu.rs ✅ "Open in Rift" registry entries (HKCU) + `rift.exe <dir>` argument parsing
  notify/            Windows toast notifications
  shell_integration/ Explorer context menu (un)registration
src/                 Frontend
  tabs/ ✅  terminal/ ✅ (+ themes.ts)  panels/ ✅ (Explorer, GitPanel, diff.ts, fileIcons.ts)  ui/ ✅ (Menu, Resizer)  settings/ ✅ (settings.ts pure + tested, SettingsPage.tsx)
```

Frontend tabs: `tabs/layout.ts` (pure logic: order, moves, titles, notify rule — unit-tested), `tabs/Tab.ts` (tab state as Solid signals behind getters), `tabs/Sidebar.tsx` (UI only), `App.tsx` (wiring: restore/save, keys, agent status).

### Settings and themes (decisions already made — keep them)
- Settings page: overlay opened by ⚙ (tabs header) or Ctrl+,; Esc closes. While it is open, Rift's shortcuts are off so keys can be recorded.
- `settings.ts` is the single source: `ACTIONS`, `DEFAULT_KEYS`, `mergeSettings` (any saved shape → valid settings, defaults for the rest), `comboOf` ("Ctrl+Shift+T"), `actionFor`, `bind` (moves a combo taken from another action). App dispatches shortcuts only through `actionFor(e, settings().keys)`.
- A shortcut must use Ctrl or Alt (`isValidShortcut`): otherwise it would steal typing from the terminal.
- Themes: every UI color is a CSS variable (`:root` = dark, `:root[data-theme="light"]` overrides); add new colors as variables, never as literals. Terminal palettes in `terminal/themes.ts` (light darkens ANSI yellow/cyan/white for contrast). "System" follows `prefers-color-scheme` live.
- Theme/font changes apply live to every terminal via `TermView.setLook`; the effect tracks only theme + font size + font family (editing a shortcut or adding a tab must not re-render all terminals). A font change re-wraps like a resize: visible tab now, hidden ones in idle time.
- Settings load before the tabs restore, so restored terminals start with the right look. The bench uses a temp settings file (defaults).

### Side panels (decisions already made — keep them)
- Files panel (left, Ctrl+Shift+E) and git panel (right, Ctrl+Shift+G), toggled from the sidebar header or their × button; open/closed state saved in `layout.panels`.
- Tabs sidebar, files and git panels are resizable (`ui/Resizer.tsx`, widths saved in `layout.widths`). While dragging, the terminal is **not** refit (re-wrap = 100+ ms per drag frame); it refits on release, then hidden tabs follow in idle time.
- Commit (git panel): checkboxes (all checked after each load), message, Ctrl+Enter. `git::commit` commits exactly the checked files: `git add` only for untracked ones, then `git commit --only` (keeps other staged changes staged; handles deletions and both sides of a rename via `Change.orig`). Pathspecs go NUL-separated on stdin with `--literal-pathspecs` (no length limit, `[id].tsx` is not a glob).
- ✨ Generate: `commit_message` sends the checked files' diff (capped 60 KB) to the first harness's `one_shot`. Claude: `claude -p --model haiku --tools "" --no-session-persistence` (~10 s, mostly claude startup). The prompt follows the user's commit convention (one subject line, optional body, no co-author line).
- **Not live** (user's choice, for speed): panels load when shown, when the shown tab changes, or on ⟳. No file watcher.
- Panels follow `panelTab`, which trails the active tab by 150 ms: holding Ctrl+PgDn never loads every tab it passes. All panel commands are `async` (off the main thread); stale answers are dropped.
- Explorer root = the tab's repo root, else its cwd. Folders are listed when first expanded and cached until ⟳.
- Each tab knows its repo root + branch: `git_head` reads `.git/HEAD` (worktrees too) at every prompt (OSC 9;9), so `git checkout` updates the branch shown under the tab.
- Width changes (panel toggle, window resize) make xterm re-wrap 10k lines of scrollback per terminal (~100-150 ms each). Hidden tabs are therefore resized in idle time, nearest first (`resizeHiddenTabs`), not on their next switch. Measured: without it, cycling tabs after opening a panel was ~149 ms p95.

### Sidebar (decisions already made — keep them)
- Vertical tabs on the left (240px). Named groups (collapsible, colored, drag to reorder); tabs have an optional color and an optional user name. Colors fill the whole row / whole group block (Warp-style, `color-mix`); **a colored group's color always wins** over its tabs' own colors (`ownRowColor`); a tab's own color is kept and shows again outside the group or in a colorless group. Right-click menus; double-click renames.
- Tab icon (`tabs/icons.tsx`): shell prompt, or the running agent's icon by harness id (`agent-status` carries `harness`). The icon needs the hooks (Enable banner); no process polling or title guessing.
- One global tab array + `group` per tab; the **visual order** (`visualOrder`: groups in order, then ungrouped) drives the sidebar and Ctrl+PgUp/PgDn. Activating a tab in a collapsed group expands it. New tabs open after the active tab, in its group.
- Title: user name > agent's terminal title (Claude names the conversation) > folder name; a title ending in `.exe` (pwsh sets its own path) is ignored.
- Name/color/group are saved as opaque `ui` per tab and groups as `layout`: the backend never interprets them.
- `dragDropEnabled: false` in tauri.conf.json, otherwise Tauri swallows HTML5 drag and drop on Windows.
- Window focus comes from Tauri `onFocusChanged`: `document.hasFocus()` is unreliable in WebView2.
- Status badge (Warp-style, bottom-right of the icon): working = spinning magenta, done = green, blocked = yellow square; unread blue dot + Windows toast when done/blocked and the tab is not in front (not active or window unfocused).

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

`src-tauri/src/agents/mod.rs`: `id`, `name`, `parse_hook(payload) -> AgentEvent`, `resume_command(session_id)`, `hooks_installed(exe)`, `install_hooks(exe)`, `one_shot(cwd, prompt, input)`. Add methods when a feature needs them.

UI and session code never mention "claude" directly; they talk to `AgentHarness`, `AgentEvent` and `AgentSession { harness, session_id }`.

### Session restore (decisions already made — keep them)
- Shells are spawned with `RIFT_TAB_ID` (pty id) and `RIFT_PIPE` (`rift-<pid>`, one pipe per Rift instance). The agent's hook runs `rift.exe hook <harness>`, which forwards stdin + tab id to that pipe. Outside Rift (no env) it is a silent no-op; it always exits 0.
- PowerShell starts with `-NoExit -EncodedCommand <init + startup>`: init wraps the user's prompt (after their profile) to emit OSC 9;9 with the cwd; startup is e.g. `claude --resume <id>`. No file written, user profile untouched.
- Frontend owns the tab list (`session_update`); hooks own the agent binding per pty. `SessionStore` writes on every change (tmp + rename), never before the frontend's first report, never after `CloseRequested` (freeze), so killing shells on close cannot erase sessions.
- `SessionEnded` only unbinds if it matches the bound id (`/clear` starts the new session before ending the old one).
- A restored tab binds its session at `pty_open`, before the agent reports anything.
- Resume only accepts UUID-shaped ids, so a tampered session file cannot inject shell commands.
- `RIFT_BENCH` uses a temp session file so the bench never touches the user's tabs.
- `session_restore` first closes every tab shell (`close_all_tabs`, spare kept): a freshly loaded page owns none, and dev reloads would otherwise leak shells (and resumed agents).
- The hook pipe server handles connections **sequentially**: status depends on order (a `Stop` applied before the preceding `PostToolUse` would leave "working" stuck).

### Claude adapter

- **Hooks**: registered in `~/.claude/settings.json` in **exec form** (`"command": "<path>\rift.exe", "args": ["hook", "claude"]`); shell form would run through Git Bash on Windows. Installed only when the user clicks "Enable" in the app banner. Other settings are preserved (key order too), a `.bak` is written, an older Rift entry (other exe path) is replaced. Events: `SessionStart` → idle (+ bind), `SessionEnd` → none (+ unbind), `UserPromptSubmit`/`PostToolUse` → working (PostToolUse also clears "blocked" once a permission is granted), `Stop` → done, `Notification` → blocked (except `idle_prompt`, the 60 s reminder). A hook call costs ~25 ms (process start). Known gap: interrupting Claude (Esc) fires no hook, so the tab stays "working" until the next prompt.
- **Resume per tab**: on reopen each tab starts in its cwd and runs `claude --resume <its own session_id>`. Also works when the user types `claude` by hand, since the env comes from the tab's shell.
- **Commit message**: `one_shot` runs `claude -p` with the staged diff on stdin and a fixed prompt. Uses the user's existing Claude login, no API key in Rift.
- Never edit the user's `~/.claude/settings.json` without their click. Uninstall (removing Rift's entries) is not built yet.

## Features

### MVP (v0.1)
- Tabs: new / close / rename / reorder, Ctrl+Shift+T, Ctrl+Shift+W (Ctrl+T/W stay with the shell), **Ctrl+PgUp / Ctrl+PgDn**, Ctrl+(Shift+)Tab, middle-click close. Instant switch. All shortcuts configurable in settings.
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
- Explorer menu ("Open in Rift" = new tab in the running window): Settings → Windows → Add/Remove. Writes `HKCU\Software\Classes\{Directory\shell, Directory\Background\shell, Drive\shell}\Rift` with command `"<exe>" "%V"` (no admin). On Windows 11 it is under "Show more options"; the top-level modern menu needs a sparse MSIX package + `IExplorerCommand` (later). Registered with the current exe path (in dev: target\debug\rift.exe). Tests use a throwaway `HKCU\Software\RiftTest-*` key, never the real one.
- Single instance (`tauri-plugin-single-instance`, off in bench mode): a second `rift.exe <dir>` forwards its args to the running Rift (`open-dir` event → new tab, window focused) and exits. A first launch with `<dir>` restores the session, then opens `<dir>` as a new tab (`startup_dir`).
- `dir_arg` fixes Explorer's drive-root quoting (`"C:\"` arrives as `C:"`) and resolves relative paths against the launching process's cwd.
- "New window" from Explorer: deliberately not offered until real multi-window exists (user's choice).
- Notifications: Windows toast via `tauri-plugin-notification`.

## Releases and auto-update
- Repo: https://github.com/o0Zz/rift (public). CI (`.github/workflows/ci.yml`): tsc, vitest, fmt, clippy -D warnings, cargo test on windows-latest. The tab-switch bench stays local (needs a visible window).
- Release: `npm version patch|minor|major` (bumps package.json — the single app version, tauri.conf.json points to it — commits and tags `vX.Y.Z`), then `git push --follow-tags`. `.github/workflows/release.yml` checks tag == package.json version, builds the NSIS installer with tauri-action and publishes it with `latest.json` on the GitHub Release.
- Update signing key: `~/.tauri/rift.key` + `rift.key.password` (never in the repo). GitHub secrets `TAURI_SIGNING_PRIVATE_KEY` (key file content) and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. The public key is in tauri.conf.json `plugins.updater.pubkey`; losing the private key means installed copies can no longer update.
- In-app (`src/update.ts`, not in dev/bench): checks `releases/latest/download/latest.json` at startup and every 6 h, downloads in the background, shows "Restart now"; otherwise installs when Rift closes. `session_freeze` runs first: the installer kills Rift, the session must stay as it was.
- Local release build: `TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/rift.key)" TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(cat ~/.tauri/rift.key.password)" npx tauri build` (~10 min first time: LTO). Measured: installer 2.4 MB, exe 7.2 MB, hook call 11 ms, bench passes.
- Installed path is per user and stable across updates, so the Claude hooks / Explorer menu registered from the installed exe keep working after updates.

## Conventions
- Rust: `cargo fmt`, `cargo clippy -- -D warnings`. Frontend: `tsc --noEmit`, eslint.
- Every feature ships with tests in the same change. Prefer end-to-end: real PTY spawn, real git repo in a temp dir, real hook JSON through the named pipe.
- Perf budget has a benchmark (`src/bench.ts`: 20 tabs x 10k lines; cycle, toggle, and cycle with both panels open while tabs alternate between two git repos — `scripts/bench.mjs` creates the second repo). Run it after any change to tabs, terminal, panels or rendering; it exits non-zero over budget.
- Keep it small: no abstraction until a second user of it exists — except `AgentHarness`, which is a stated requirement.
- Commits: one short subject line, no sign-off trailers.

## Status
Done: tabs + PTY + spare shell + shortcuts + copy/paste + tab-switch bench + session restore (tabs, cwd, per-tab Claude resume) + left sidebar with groups/colors/rename/drag + agent status badges + notifications + files panel + git panel (branch, changes, diff, commit selected files, AI commit message) + resizable/closable panels + settings page (theme dark/light/system, font, shortcuts) + app icon + Explorer "Open in Rift" (new tab, single instance). Next: default shell choice (pwsh/cmd/Git Bash/WSL), multi-window, session resume polish.

Dev loop: keep `npm run tauri dev` running (the user watches changes live). Run tests with `CARGO_TARGET_DIR=src-tauri/target/test` so they don't fight the running app over `target/debug/rift.exe`.

## Commands
```
npm run tauri dev                 # run (Vite on :1420 + Rust app)
npm run tauri build               # package
cd src-tauri && cargo test        # backend tests (spawn real cmd.exe)
npm test                          # frontend tests (vitest)
npm run typecheck                 # tsc --noEmit
npx tauri icon src-tauri/icons/rift.svg   # regenerate app icons from the SVG source; then delete
                                  # icons/android, icons/ios, 64x64.png and touch tauri.conf.json
                                  # (the build script only re-embeds icons when that file changes)
npm run bench                     # tab-switch benchmark in the real WebView (keep the window visible; fails over budget)
```
