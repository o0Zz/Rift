# Rift Terminal

A fast terminal built around coding agents (Claude Code, Codex, Gemini CLI, Copilot CLI). Windows first (developed and hand-tested there), built and tested in CI for Linux and macOS. It exists because Warp lags when switching tabs.

## Performance comes first (hard requirement)

**Speed beats every feature.** A feature that makes Rift slower does not ship, however useful it is.

- Before building a feature, estimate its cost on the budget below. If it can slow tab switch, new tab, typing, output or startup, or adds idle work, **say so up front and push back hard**: name the cost, propose a cheaper design or dropping it. Never implement it silently, never soften the warning.
- If the user still wants it, build the cheapest version, run `npm run bench` and report the numbers. Over budget = not done.
- Every change to tabs, terminal, panels or rendering runs the bench before it is committed.

| Action                               | Budget        |
|--------------------------------------|---------------|
| Tab switch: main-thread work p95     | < 16 ms (one frame) — `npm run bench` |
| Tab switch: key → rendered p95       | < 50 ms — `npm run bench` |
| Heavy output (8.7 MB): frame gap p95 | < 100 ms — `npm run bench` |
| New tab until prompt is usable       | < 150 ms (our part, shell startup excluded: < 30 ms) |
| Cold app start to first prompt       | < 500 ms      |
| Idle CPU with 10 tabs                | ~0 %          |

How we hold it:
- Each tab's terminal stays **mounted**; switching only toggles `display`. Never destroy/recreate a terminal or replay scrollback. Hidden tabs receive PTY output but do not render.
- Nothing runs on a tab switch except showing the tab: panels, git and stats load later, debounced, off the main thread.
- No polling, no file watchers, no timers while idle. No UI-thread work that scales with scrollback, repo size or number of tabs.
- One spare shell is pre-spawned so "new tab" just attaches it.
- `.topbar`/`.sidebar` have `contain: layout paint style`, `.terms` `contain: strict`; the top bar updates one frame after the switch (`barTab` in rAF). Without them a switch cost ~4 ms more and failed the bench.
- Measured rejections (keep them): WebGL renderer (~54 ms vs ~15 ms p95 cycling 20 tabs, ~16 context cap); refitting the terminal while dragging a resizer (100+ ms per frame); resizing hidden tabs on their next switch (~149 ms p95: they resize in idle time instead, `resizeHiddenTabs`); live panels (user's choice: no watcher); Monaco (MBs, slow start: CodeMirror instead).
- Known floor: xterm resumes a hidden terminal via IntersectionObserver, ~1 extra frame (20-27 ms p50 key → rendered). Next thing to attack if switching ever feels slow.

## Stack

- **Tauri 2** (Rust backend, system WebView). No Electron.
- **Rust**: PTY via `portable-pty` (ConPTY on Windows), git via the `git` CLI (the user's config/hooks), state in the app data dir (`%APPDATA%\dev.rift.terminal\`: `session.json`, `settings.json`, `prompts.json`, `scrollback/`).
- **Frontend**: TypeScript + Solid. Terminal: **xterm.js, DOM renderer**. Editor: CodeMirror 6 (lazy).
- **Shells** (`shell.rs`): default Windows: PowerShell 7, else Windows PowerShell; Linux/macOS: `$SHELL` (fallback zsh on macOS, bash on Linux). Profiles (installed only): PowerShell 7, Windows PowerShell, Command Prompt, Git Bash, WSL; Unix: login shell + `/etc/shells`. Default in Settings; right-click + for another; a new tab inherits the active tab's shell (`ui.shell`). The spare shell is only for the default shell.

## Architecture

```
src-tauri/src/
  pty.rs            spawn, resize, read/write, spare shell (Tauri-free, tested against real shells)
  shell.rs          per-OS shells + integration (cwd reporting, startup command), user rc files untouched
  session.rs        what to restore: tabs (cwd, opaque ui) + agent session per tab
  scrollback.rs     per-tab history (`<id>.ans`) saved on close, shown again on restore
  hook.rs           `rift hook` client + server: named pipe (Windows) / Unix socket
  agents/           AgentHarness trait + adapters (claude, codex, gemini, copilot); config.rs: shared hook-file and one-shot helpers
  git.rs            branch from .git/HEAD (no process); status/diff/stats/commit/worktree via git CLI (CREATE_NO_WINDOW)
  files.rs          one directory level per call (never walks recursively)
  settings.rs       settings.json (frontend owns its shape)
  explorer_menu.rs  "Open in Rift" registry entries (HKCU) + `rift.exe <dir>` parsing
  lib.rs / main.rs  Tauri commands + setup / `rift hook|status <harness>` subcommands, else the app
src/
  App.tsx           wiring: restore/save, keys, agent status, top bar, Enable banners
  tabs/             layout.ts (pure: order, moves, titles, notify rule; tested), Tab.ts (state as Solid signals), Sidebar.tsx, GitStats.tsx, icons.tsx, nav.ts
  terminal/         TermView.ts (one xterm per tab), themes.ts, osc.ts, paths.ts
  panels/           Explorer, GitPanel, Prompts, diff.ts, fileIcons.ts
  ui/               Menu, Resizer (+ resize.ts, pure), Icon, PromptDialog, FindBar
  docs/             DocView.ts (one open file), place.ts (pure; tested), editor.ts + markdown.ts (lazy chunks)
  settings/         settings.ts (pure + tested), SettingsPage.tsx
  update.ts, bench.ts
```

Frontend ↔ backend: Tauri commands, the PTY `Channel`, and events (`pty-exit`, `agent-status`, `agent-usage`, `open-dir`). Add a module only when its feature is built. No abstraction until a second user exists, except `AgentHarness` (stated requirement).

## Decisions (keep them)

### Terminal
- `pty_open` takes a Tauri `Channel`; output goes as `InvokeResponseBody::Raw` bytes (no JSON) to `term.write(Uint8Array)`. Exit = `pty-exit`, detected by waiting on the child (ConPTY keeps the pipe open after exit).
- New tabs open in the **active tab's folder**, after it, in its group. Spare shell: one shell waiting in a folder (home at launch); `pty_prewarm(cwd)` once the active tab and its folder are stable for 1 s. `pty_open` takes it only for the same folder (case/trailing-separator insensitive), default shell, no startup command; its output is buffered and replayed on attach.
- ConPTY sends `ESC[6n` at startup and blocks until answered; xterm answers. `TermView` queues input until `pty_open` returns (the replayed spare output triggers the answer before the id is known). Tests answer by hand (`\x1b[1;1R`).
- Shell integration: PowerShell `-NoExit -EncodedCommand <init + startup>` (wraps the user's prompt to emit OSC 9;9); cmd `/K` with a `PROMPT` emitting OSC 9;9; bash (also Git Bash, MSYS paths converted) `--rcfile` sourcing ~/.bashrc, then OSC 7; zsh `ZDOTDIR` whose files source the user's own, then OSC 7. Startup command via `RIFT_STARTUP`. WSL and other shells run plain. User profiles untouched.
- Shortcuts: capture-phase `keydown` (`tabs/nav.ts`), so xterm never sees them; dispatched only through `settings.ts` `actionFor`. Windows/Linux new/close tab = Ctrl+Shift+T/W (plain Ctrl+T/W belong to the shell and the agents); macOS uses Cmd+T/W/F. A shortcut needs Ctrl, Alt or Cmd, or is F1-F12 (`isValidShortcut`).
- The webview never reloads: F5 / Ctrl+R / Cmd+R are blocked outside a terminal (`isReloadKey`; a reload restarts every shell). F5 = refresh the files and git panels.
- Find: Ctrl+Shift+F (`FindBar`, search addon). Links: Ctrl+click only (`open_url`, http(s) only). Zoom: Ctrl+= / - / 0.
- Shift+Enter in an agent tab sends ESC+CR (new line); in a shell it stays Enter. Image paste: the agent reads the clipboard on its own key (Alt+V on Windows, sent by xterm as `ESC v`; Ctrl+V on Linux/macOS); a paste without text sends 0x16. Both are Claude's keys, untested in the other agents.
- Drag a file from the files panel onto a terminal types its path (`quotePath`). OS file-manager drops are not supported: Tauri's native drag-drop breaks HTML5 drag and drop on Windows (`dragDropEnabled: false`).

### Sidebar and attention
- Vertical tabs. One global tab array + `group` per tab; the **visual order** (`visualOrder`) drives the sidebar and Ctrl+PgUp/PgDn. Named groups (collapsible, colored, draggable); a colored group's color always wins over the tab's (`ownRowColor`). Activating a tab in a collapsed group expands it.
- Title: user name > agent's terminal title > folder name; a title ending in `.exe` is ignored. Icon: shell prompt, or the agent's icon by harness id (from hooks; no process polling). Under the tab: branch + git stats. Tab row size Compact / Comfortable / Large (36 / 44 / 52 px, `--tab-row`, no refit).
- Name/color/group/shell/snap/docs are opaque `ui` per tab, groups and panel state `layout`: the backend never interprets them.
- Badges: working = spinning magenta, done = green, blocked = yellow; unread dot + toast when done/blocked and not in front. `needsAttention` = blocked, or done and unread. Ctrl+Shift+U goes to the next one (blocked first). Filter All / Needs me / Working. Window title `Rift <version> — N waiting`. Taskbar flashes (`requestUserAttention`) in the background. A seen "done" fades after 3 s (`fadeDoneWhenSeen`). Esc in a working/blocked agent tab sets it idle (`statusAfterEscape`): agents fire no hook on interrupt.
- Closing with agents working/blocked asks first (`onCloseRequested`). Window focus from Tauri `onFocusChanged` (`document.hasFocus()` is unreliable in WebView2).
- "New <agent> in a worktree…" (one entry per agent used on this machine): `git_worktree_add` creates/checks out the branch in `<repo>.worktrees/<branch>`, then a tab there runs `AgentHarness::start_command`.
- UI: icons from `ui/Icon.tsx` (SVG, `currentColor`), never Unicode glyphs. Menus work from the keyboard and render in a `Portal` (the sidebar's `contain: paint` clipped them); F2 renames. Focus returns to the terminal after a menu, rename or tab click. Text input uses `ui/PromptDialog.tsx`, never `window.prompt` (blocked in WebView2).

### Panels and top bar
- Docks (`panels/docks.ts`, pure + tested; `panels/Dock.tsx`): left, right, bottom, one arrangement for every tab, saved as `layout.docks` (`mergeDocks` repairs any shape and reads the pre-dock `panels`/`widths`). A dock shows one panel; with several it gets tabs. Defaults: files left (Ctrl+Shift+E), git + prompts right (Ctrl+Shift+G / O), terminal bottom (Ctrl+Shift+J). Move: right-click a panel header or dock tab, or drag a dock tab onto a side (drop zones only during the drag). Only the shown panel is mounted. Resizable (`ui/Resizer.tsx`, `top` edge for the bottom dock).
- Terminal panel: one `TermView` for the whole window (not per tab, so nothing on a tab switch), started in the active tab's folder the first time it is shown, moved between docks without restarting, disposed when its shell exits. Not restored with the session, no scrollback saved. Per-tab splits rejected: N shells per tab, N terminals rendered per switch.
- **Not live**: panels load when shown, when the shown tab changes, or on ⟳/F5. They follow `panelTab`, which trails the active tab by 150 ms (holding Ctrl+PgDn never loads every tab passed). All commands async; stale answers dropped. The git panel reloads in place (checks and open diff kept, `keepChecked`) when an agent in its repo finishes, and on a switch to a tab of the same repo only if a prompt or agent event marked it changed (`changedRepos`). GitPanel loads on `on(() => props.root)` only: a plain effect re-ran `load()` on every answer (git in a loop).
- Explorer root = repo root, else cwd; folders listed on first expand, cached until ⟳. Delete (macOS also Cmd+Backspace) or the menu moves to Recycle Bin / Trash (`fs_trash`, `trash` crate; never a permanent delete) after a confirm; documents under it close (`isUnder`).
- Each tab knows its repo root + branch: `git_head` reads `.git/HEAD` at every prompt (OSC 9;9 / OSC 7). Git stats (`git_stats`, two git commands in parallel, ~80 ms): 1.5 s after a prompt or agent status change (coalesced per tab) and after a commit, **never on a tab switch**.
- Top bar (Warp-style): active tab title, git button (branch + `+added −deleted ↑ahead ↓behind`), Claude's 5h/7d plan usage.
- Commit: checkboxes, message, Ctrl+Enter. `git::commit` commits exactly the checked files (`git add` for untracked, then `git commit --only`; renames via `Change.orig`); pathspecs NUL-separated on stdin with `--literal-pathspecs`.
- Git actions, all on a click: branch menu (last 30 local branches: `git switch`; "New branch…" = `git switch -c`), Pull (the user's merge/rebase config), Push (no upstream → `-u <first remote> HEAD`), Commit & Push. `GIT_TERMINAL_PROMPT=0`. `onHeadChanged` re-reads branch + stats of every tab of that repo.
- History (Changes | History): `git log -n200`. Click = the commit's files, Shift+click = the range, both ends included (`pickCommits`, `commitRange`, `inRange`); a file → its diff. Commit ids checked hex before reaching git. Commit list and file list resize in height (bottom `Resizer`, not saved).
- ✨ Generate: the checked files' diff (capped 60 KB) → `one_shot` of the first agent used on this machine (order Claude, Codex, Gemini, Copilot; the tooltip names it). Conventional Commits, no co-author line (`COMMIT_PROMPT`). Killed after 120 s with its child processes (`config::run`; npm `.cmd` shims start node).
- Prompts: one list per repo (`promptKey`: case/separator-insensitive) in `prompts.json` (frontend owns the shape, `mergePrompts`), saved on each edit. Enter adds/saves, Shift+Enter = new line. The ← button or a drag onto the terminal (`PROMPT_DRAG_TYPE`, removed on `dragend` if dropped) pastes it (`TermView.paste`, bracketed, no Enter) and removes it.

### Documents (files opened in a tab)
- A click in the files panel opens the file **in the tab**, instead of its terminal; the top bar becomes sub-tabs `Terminal | file × | ...` (same height: terminals never refit). Setting: one document at a time (replaces the shown or last one, never one with unsaved changes, `placeDoc`) or a new sub-tab each time. Not text (binary, not UTF-8, > 5 MB, `files::read_text`) → default app.
- `DocView` is like `TermView`: mounted for the tab's life, `display` toggle. Reads the file only once shown and still visible (a restore activates every tab); re-checks the mtime 150 ms after being shown (changed outside + no unsaved edits → reloaded). No watcher. Measured: switching to a document tab = 1.5-1.9 ms of work.
- Editor `docs/editor.ts`: lazy chunk (~114 KB gz), languages per file (`@codemirror/language-data`). Highlighting, search, undo, Ctrl+S; no LSP/autocomplete. Line endings kept (`lineSeparator`). Terminal font via CSS variables.
- Markdown reader (`docs/markdown.ts`, lazy, marked + **DOMPurify**: the page can call Rift's commands, so files never bring scripts, handlers, forms or `style`), Edit/Read in the top bar. Links: http(s) → browser, relative → opened in Rift, never navigate the app. Relative images via the asset protocol (`localImage` + `convertFileSrc`).
- Unsaved changes: confirm before closing the document, its tab or Rift. Open documents saved per tab (`ui.docs`, `ui.doc`).

### Settings and themes
- Overlay (⚙ or Ctrl+,; Esc closes); Rift's shortcuts are off while open. `settings.ts` is the single source: `ACTIONS`, `defaultKeys(mac)`, `mergeSettings` (any saved shape → valid), `comboOf`, `actionFor`, `bind`. Settings load before tabs restore.
- Every UI color is a CSS variable (`:root` dark, `[data-theme="light"]`), never a literal. Terminal palettes in `terminal/themes.ts`. "System" follows `prefers-color-scheme` live.
- Theme/font apply live via `TermView.setLook`; the effect tracks only theme + font (a shortcut edit must not re-render terminals). A font change re-wraps: visible tab now, hidden ones in idle time.

### Session restore
- Frontend owns the tab list (`session_update`); hooks own the agent binding per pty. `SessionStore` writes on every change (tmp + rename), never before the frontend's first report, never after the freeze (`WindowEvent::Destroyed`, not the cancellable close request).
- A restored tab binds its session at `pty_open` and runs the harness's `resume_command` in its cwd (its own session, not the last one). `SessionEnded` unbinds only a matching id (`/clear`). Resume ids are validated (UUID for Claude, `config::safe_id` for the others): no injection from a tampered file.
- Scrollback: on close and before an update restart, each **shell** tab's last 2000 lines are serialized with colors to `scrollback/<snap>.ans`, written back on restore under a dim "── restored ──" line. Agent tabs skipped (resume redisplays). Orphans pruned; ids validated.
- `session_restore` first closes every tab shell (spare kept): dev reloads would leak shells. Bench mode uses temp session/settings files; `RIFT_DATA_DIR` gives an isolated profile (and disables single instance) for demos.

### Agent harness
- Everything agent-specific goes through `AgentHarness` (`agents/mod.rs`): `id`, `name`, `detected` (its config folder exists: only those get "Enable", a worktree entry and Generate), `parse_hook`, `resume_command`, `start_command`, `hooks_installed`, `install_hooks`, `setup` (what Enable writes and where, shown before the click), `one_shot`. UI and session code never mention an agent by name; they use `AgentHarness`, `AgentEvent`, `AgentSession { harness, session_id }`.
- Hook pipeline: shells get `RIFT_TAB_ID` (pty id) and `RIFT_PIPE` (`\\.\pipe\rift-<pid>`, or `$XDG_RUNTIME_DIR`/temp `rift-<pid>.sock`). The agent's hook runs `rift hook <harness>`, forwarding stdin + tab id; outside Rift a silent no-op; always exits 0, prints nothing. The server handles connections **sequentially** (status depends on order). Hook call ~11-25 ms.
- Agent config files are written only on the user's "Enable" click (never otherwise; uninstall not built): other settings and key order kept, older Rift entries replaced, `.bak` written, temp file + rename (`config::write_json`).
- Claude Code: `~/.claude/settings.json`, **exec form** (`"command": "<path>\rift.exe", "args": ["hook", "claude"]`; shell form would go through Git Bash). `SessionStart` → idle + bind, `SessionEnd` → unbind, `UserPromptSubmit`/`PostToolUse` → working, `Stop` → done, `Notification` → blocked (except `idle_prompt`). The same click sets `statusLine` to `rift status claude` (forward slashes, quoted only with a space) unless the user has their own (kept, counts as installed). It prints `ctx 34% · 5h 23% · 7d 41%` back into Claude and forwards the JSON → `agent-usage` (`agents::parse_usage`): context on the tab, plan limits in the top bar. Event-driven only. One-shot `claude -p --model haiku --tools "" --no-session-persistence`.
- Other agents, built from their docs/source and not run live (none installed or logged in here):
  - Codex: `~/.codex/hooks.json`, command line through `cmd /C` / `$SHELL -lc`. `PermissionRequest` → blocked. Codex runs new hooks only once trusted: `setup` tells the user to approve them with `/hooks` (Rift never writes trust hashes). Resume `codex resume <id>`; one-shot `codex exec --ephemeral --sandbox read-only`.
  - Gemini CLI: `~/.gemini/settings.json`, command line through PowerShell (`& '<exe>' hook gemini`) / bash. `BeforeAgent`/`AfterTool` → working, `AfterAgent` → done, `Notification` → blocked. Hooks must print nothing and never exit 2 (= block). Resume `gemini --resume <id>`; one-shot `gemini -p … -m flash-lite`.
  - Copilot CLI: Rift's own file `~/.copilot/hooks/rift.json` (or `$COPILOT_HOME`), rewritten whole, exec form. PascalCase events so payloads are Claude-shaped; `Notification` matcher `permission_prompt|elicitation_dialog` → blocked. Resume `copilot --resume=<id>`; one-shot reads instructions + diff from stdin (`-p` ignores stdin).
  - No status line / usage for them (none offers one to external commands).
  - OpenCode: not built. Its plugins run in a shared background server (no tab environment) and its plugin API is mid-rewrite (V1 docs vs V2 source).
- npm installs agents as `.cmd` shims on Windows: `config::program` searches PATH for `.exe`/`.cmd`/`.bat`; Rust escapes batch arguments (tested end-to-end through a node shim).

## Windows specifics
- Explorer menu ("Open in Rift" = new tab in the running window): Settings → Windows. `HKCU\Software\Classes\{Directory\shell, Directory\Background\shell, Drive\shell}\Rift`, command `"<exe>" "%V"`. Windows 11: under "Show more options" (top level needs MSIX + `IExplorerCommand`). Tests use `HKCU\Software\RiftTest-*`.
- Single instance (off in bench mode): a second `rift.exe <dir>` forwards to the running Rift (`open-dir` → new tab) and exits. `dir_arg` fixes Explorer's drive-root quoting (`"C:\"` → `C:"`).

## Releases and CI
- Repo https://github.com/o0Zz/Rift (public). CI: `lint` on Linux (fmt, clippy, tsc, vitest) + `test` on windows/ubuntu/macos (node available: a test runs an npm-style shim), then on master `installers` per OS (artifacts). Time is Rust compilation (~150 s cold): never add a second full compile per OS. The bench stays local (needs a visible window).
- Packaging: Windows NSIS; macOS universal `.dmg`, **unsigned**; Linux AppImage (self-updates) + `.deb`.
- Versioning: repo stays `0.0.0`; CI builds `0.0.0+RUN` (dev) or `X.Y.Z+RUN` (tag `vX.Y.Z`), shown as `X.Y.Z.RUN`. The updater compares X.Y.Z only. First release: v1.0.0 (2026-11-01).
- Release: `git tag vX.Y.Z && git push origin vX.Y.Z` → `release.yml` builds every OS with tauri-action and publishes one GitHub Release with `latest.json`.
- Signing key `~/.tauri/rift.key` + `rift.key.password` (never in the repo), GitHub secrets `TAURI_SIGNING_PRIVATE_KEY(_PASSWORD)`; public key in tauri.conf.json. Losing it means installed copies cannot update.
- In-app updater (`src/update.ts`, not in dev/bench): checks at startup and every 6 h, downloads in the background, "Restart now" or installs on close, after `session_freeze` and saving scrollback.
- Measured (v1.0.0): Windows installer 3.2 MB, macOS dmg 7.7 MB, deb 5.0 MB, AppImage 83 MB.

## Scope
- Done: tabs, spare shell, shell profiles, session + per-tab agent resume, scrollback restore, grouped vertical tabs, agent status + notifications + attention tools (Claude Code, Codex, Gemini CLI, Copilot CLI), files / git / prompts / terminal panels in movable docks (diff, commit selected files, history ranges, AI message, stats, top bar), worktrees, documents in tabs (editor + Markdown reader), settings (themes, fonts, tab size, shortcuts, Cmd on macOS), Explorer menu, auto-update, benches.
- Next: multi-window, command palette (Ctrl+Shift+P), launch configurations, global hotkey, stage hunks, review comments sent to the tab's agent.
- Out of scope (cost speed or not the product): Warp blocks / rewritten input editor (fights PSReadLine), built-in AI agent, Warp Drive / notebooks / team or session sharing, cloud agents, IDE features in the editor (LSP, autocomplete, project search), accounts. Revisit only if asked.

## Conventions
- Rust: `cargo fmt`, `cargo clippy -- -D warnings`. Frontend: `tsc --noEmit`, vitest.
- Every feature ships with tests in the same change. Prefer end-to-end: real PTY, real git repo in a temp dir, real hook JSON through the pipe.
- Commits: **Conventional Commits** (`feat(scope): description`), one short subject line, optional brief body, no sign-off trailers.
- Dev loop: keep `npm run tauri dev` running (the user watches changes live). Run tests with `CARGO_TARGET_DIR=src-tauri/target/test` so they don't fight the running app over `rift.exe`.

## Commands
```
npm run tauri dev                 # run (Vite on :1420 + Rust app)
npm run tauri build               # package
cd src-tauri && cargo test        # backend tests (real shells)
npm test                          # frontend tests (vitest)
npm run typecheck                 # tsc --noEmit
npm run bench                     # tab switch + heavy output in the real WebView (keep the window visible; fails over budget)
npx tauri icon src-tauri/icons/rift.svg   # regenerate icons; then delete icons/android, icons/ios, 64x64.png and
                                  # touch tauri.conf.json (icons are re-embedded only when it changes)
```
