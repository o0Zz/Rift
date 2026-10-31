# Rift Terminal

A fast terminal built around coding agents (Claude Code first). Windows first (developed and hand-tested there), also built and tested in CI for Linux and macOS. It exists because Warp lags when switching tabs.

## Performance comes first (hard requirement)

**Speed beats every feature.** A feature that makes Rift slower does not ship, however useful it is.

- Before building a requested feature, estimate its cost on the budget below. If it can slow tab switch, new tab, typing, output or startup, or adds idle work, **say so up front and push back hard**: name the cost, propose a cheaper design or dropping it. Never implement it silently and never soften the warning.
- If the user still wants it after that, build the cheapest version, measure it (`npm run bench`) and report the numbers. Over budget = not done.
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
- Each tab's terminal stays **mounted**; switching only toggles `display`. Never destroy/recreate a terminal or replay scrollback.
- Hidden tabs receive PTY output but do not render.
- Nothing runs on a tab switch except showing the tab: panels, git and stats load later, debounced, off the main thread.
- No polling, no file watchers, no timers while idle.
- One spare shell is pre-spawned so "new tab" just attaches it.
- No UI-thread work that scales with scrollback, repo size or number of tabs.
- Measured rejections (keep them): WebGL renderer (~54 ms vs ~15 ms p95 cycling 20 tabs, ~16 context cap); refitting the terminal while dragging a resizer (100+ ms per frame); resizing hidden tabs on their next switch (~149 ms p95: they resize in idle time instead, `resizeHiddenTabs`); live panels (user's choice: no watcher).
- Known floor: xterm resumes a hidden terminal via IntersectionObserver, ~1 extra frame (20-27 ms p50 key → rendered). Next thing to attack if switching ever feels slow.

## Stack

- **Tauri 2** (Rust backend, system WebView). No Electron.
- **Rust**: PTY via `portable-pty` (ConPTY on Windows), git via the `git` CLI (matches the user's config/hooks), state in the Tauri app data dir (`%APPDATA%\dev.rift.terminal\`: `session.json`, `settings.json`, `scrollback/`).
- **Frontend**: TypeScript + Solid. Terminal: **xterm.js, DOM renderer**.
- **Shells** (`shell.rs`): default Windows: PowerShell 7, else Windows PowerShell; Linux/macOS: `$SHELL` (fallback zsh on macOS, bash on Linux). Profiles (`shell::profiles`, installed ones only): Windows: PowerShell 7, Windows PowerShell, Command Prompt, Git Bash, WSL; Unix: login shell + `/etc/shells`. Default in Settings → Terminal; right-click + for another one; a new tab inherits the active tab's shell (`ui.shell`). The spare shell is only for the default shell.

## Architecture

```
src-tauri/src/
  pty.rs            spawn, resize, read/write, spare shell (Tauri-free, tested against real shells)
  shell.rs          per-OS shells + integration (cwd reporting, startup command), user rc files untouched
  session.rs        what to restore: tabs (cwd, opaque ui) + agent session per tab
  scrollback.rs     per-tab history (`<id>.ans`) saved on close, shown again on restore
  hook.rs           `rift hook` client + server: named pipe (Windows) / Unix socket
  agents/           AgentHarness trait + adapters (claude.rs; later codex, gemini...)
  git.rs            branch from .git/HEAD (no process); status/diff/stats/commit/worktree via git CLI (CREATE_NO_WINDOW)
  files.rs          one directory level per call (never walks recursively)
  settings.rs       settings.json (frontend owns its shape)
  explorer_menu.rs  "Open in Rift" registry entries (HKCU) + `rift.exe <dir>` parsing
  lib.rs / main.rs  Tauri commands + setup / `rift.exe hook <harness>` subcommand, else the app
src/
  App.tsx           wiring: restore/save, keys, agent status, top bar
  tabs/             layout.ts (pure: order, moves, titles, notify rule; tested), Tab.ts (state as Solid signals), Sidebar.tsx, GitStats.tsx, icons.tsx, nav.ts
  terminal/         TermView.ts (one xterm per tab), themes.ts, osc.ts, paths.ts
  panels/           Explorer, GitPanel, diff.ts, fileIcons.ts
  ui/               Menu, Resizer, Icon, PromptDialog, FindBar
  docs/             DocView.ts (one open file), place.ts (pure; tested), editor.ts + markdown.ts (lazy chunks)
  settings/         settings.ts (pure + tested), SettingsPage.tsx
  update.ts, bench.ts
```

Frontend ↔ backend: Tauri commands, the PTY `Channel`, and events (`pty-exit`, `agent-status`, `open-dir`). Add a module only when its feature is built. No abstraction until a second user exists, except `AgentHarness` (stated requirement).

## Decisions (keep them)

### Terminal pipeline
- `pty_open` takes a Tauri `Channel`; output goes as `InvokeResponseBody::Raw` bytes (no JSON) to `term.write(Uint8Array)`. Exit = `pty-exit` event, detected by waiting on the child (ConPTY keeps the pipe open after exit).
- New tabs open in the **active tab's folder**, after it, in its group. Spare shell: one shell waiting in a folder (home at launch); `pty_prewarm(cwd)` once the active tab and its folder are stable for 1 s. `pty_open` takes the spare only for the same folder (case/trailing-separator insensitive), default shell, no startup command; its output is buffered and replayed on attach.
- ConPTY sends `ESC[6n` at startup and blocks until answered; xterm answers. `TermView` queues input on a promise until `pty_open` returns, since the replayed spare output triggers the answer before the id is known. Tests answer by hand (`\x1b[1;1R`).
- Shortcuts are handled in a capture-phase `keydown` listener (`tabs/nav.ts`) so xterm never sees them. New tab = Ctrl+Shift+T, close = Ctrl+Shift+W: plain Ctrl+T/W belong to the shell and to Claude Code.

### Terminal conveniences and agent attention
- The webview never reloads: F5 / Ctrl+R / Cmd+R are blocked outside a terminal (`isReloadKey`; a reload restarts every shell). F5 = refresh the files and git panels.
- Find: Ctrl+Shift+F (`FindBar`, search addon). Links: Ctrl+click only (`open_url`, http(s) only). Zoom: Ctrl+= / - / 0.
- Shift+Enter in an agent tab sends ESC+CR (Claude's new line); in a shell it stays Enter. Esc in a working/blocked agent tab sets it idle (`statusAfterEscape`): agents fire no hook on interrupt.
- Image paste into Claude: Claude reads the clipboard on its own key (Alt+V on Windows, passed by xterm as `ESC v`; Ctrl+V on Linux/macOS). A paste without text sends the Ctrl+V byte (0x16); on macOS Ctrl+V is not paste (Cmd+V is).
- Drag a file from the files panel onto a terminal types its path (`quotePath`). OS file-manager drops are not supported: Tauri's native drag-drop breaks HTML5 drag and drop on Windows (`dragDropEnabled: false`).
- Closing with agents working/blocked asks first (`onCloseRequested`). The session freezes on `WindowEvent::Destroyed`, not on close request (cancellable).
- `needsAttention` = blocked, or done and unread. Ctrl+Shift+U goes to the next one (blocked first). Sidebar filter All / Needs me / Working. Window title `Rift <version> — N waiting`. Taskbar flashes (`requestUserAttention`) when in the background. A seen "done" badge fades after 3 s (`fadeDoneWhenSeen`).
- "New Claude in a worktree…": `git_worktree_add` creates/checks out the branch in `<repo>.worktrees/<branch>`, then a tab there starts the agent (`start_agent` → `AgentHarness::start_command`).
- UI: icons from `ui/Icon.tsx` (SVG, `currentColor`), never Unicode glyphs. Menus work from the keyboard (↑/↓, Enter, Esc); F2 renames. Focus returns to the terminal after a menu, rename or tab click. Text input uses `ui/PromptDialog.tsx`, never `window.prompt` (blocked in WebView2).

### Sidebar
- Vertical tabs on the left. Named groups (collapsible, colored, draggable); tabs have optional color and name. Colors fill the whole row / group block (`color-mix`); **a colored group's color always wins** (`ownRowColor`); a tab keeps its own color for outside the group.
- One global tab array + `group` per tab; the **visual order** (`visualOrder`) drives the sidebar and Ctrl+PgUp/PgDn. Activating a tab in a collapsed group expands it.
- Title: user name > agent's terminal title > folder name; a title ending in `.exe` is ignored.
- Tab icon: shell prompt, or the agent's icon by harness id (needs the hooks; no process polling). Badge: working = spinning magenta, done = green, blocked = yellow; unread dot + toast when done/blocked and not in front. Under the tab: branch + git stats.
- Name/color/group/shell/snap are opaque `ui` per tab, groups and panel state are `layout`: the backend never interprets them.
- Window focus comes from Tauri `onFocusChanged` (`document.hasFocus()` is unreliable in WebView2).

### Side panels and top bar
- Files (left, Ctrl+Shift+E) and git (right, Ctrl+Shift+G), toggled from the sidebar header / the top bar's git button / their ×; resizable (`ui/Resizer.tsx`). State and widths saved in `layout`.
- Prompts (right, Ctrl+Shift+O, top bar list button): prompts prepared in advance, one list per repo (`promptKey`: case/separator-insensitive), in `prompts.json` (frontend owns the shape, `mergePrompts`), saved on each edit. Enter adds/saves, Shift+Enter = new line. A click edits; the ← button (left) or a drag onto the terminal (`PROMPT_DRAG_TYPE`, removed on `dragend` if dropped) pastes the prompt into the active tab (`TermView.paste`, bracketed, no Enter) and removes it.
- **Not live**: panels load when shown, when the shown tab changes, or on ⟳. The git panel reloads in place (checks and open diff kept, `keepChecked`) when an agent in its repo finishes, and on a switch to a tab of the same repo only if a prompt or agent event marked that repo changed (`changedRepos`): a switch where nothing happened costs no git call. They follow `panelTab`, which trails the active tab by 150 ms (holding Ctrl+PgDn never loads every tab passed). All commands async; stale answers dropped. Explorer root = repo root, else cwd; folders listed on first expand, cached until ⟳.
- Each tab knows its repo root + branch: `git_head` reads `.git/HEAD` at every prompt (OSC 9;9 / OSC 7).
- Top bar (Warp-style): active tab title, git button on the right (branch + `+added −deleted ↑ahead ↓behind`). It updates one frame after the switch (`barTab` in rAF), and `.topbar`/`.sidebar` have `contain: layout paint style`, `.terms` `contain: strict`: without them it cost ~4 ms per switch and failed the bench.
- Git stats (`git_stats`, two git commands in parallel, ~80 ms): 1.5 s after a prompt or agent status change (coalesced per tab) and after a commit, **never on a tab switch**.
- Commit: checkboxes, message, Ctrl+Enter. `git::commit` commits exactly the checked files (`git add` for untracked, then `git commit --only`; renames via `Change.orig`); pathspecs NUL-separated on stdin with `--literal-pathspecs`.
- ✨ Generate: the checked files' diff (capped 60 KB) → first harness's `one_shot` (Claude: `claude -p --model haiku --tools "" --no-session-persistence`, ~10 s). Conventional Commits, no co-author line (`COMMIT_PROMPT`).

### Documents (files opened in a tab)
- A click in the files panel opens the file **in the tab**, shown instead of its terminal; the top bar becomes sub-tabs `Terminal | file × | ...` (the bar's height never changes, so terminals never refit for it). "Open with default app" is in the file's menu. Not text (binary, not UTF-8, > 5 MB, `files::read_text`) → default app.
- Setting "Opening a file": one at a time (default; replaces the shown or last document, never one with unsaved changes, `placeDoc`) or a new sub-tab each time.
- `DocView` (`docs/`) is like `TermView`: mounted for the tab's life, `display` toggle. It reads the file only once shown and still visible (a restore activates every tab), and re-checks the mtime 150 ms after being shown (changed outside + no unsaved edits → reloaded). No watcher.
- Editor: **CodeMirror 6**, not Monaco (MBs, slow start). `docs/editor.ts` is a lazy chunk (~114 KB gz), languages load per file (`@codemirror/language-data`). Highlighting, search, undo, Ctrl+S; no LSP/autocomplete. The file's line endings are kept (`lineSeparator`). Font = terminal font via CSS variables.
- Markdown opens in the reader (`docs/markdown.ts`, lazy, marked + **DOMPurify**: the page can call Rift's commands, so files never bring scripts, handlers, forms or `style`), with Edit/Read in the top bar. Links: http(s) → browser, relative → opened in Rift, never navigate the app. Relative images load from disk through the asset protocol (`localImage` + `convertFileSrc`; scope `**`, no more than `fs_read_text` already allows).
- Unsaved changes: confirm before closing the document, its tab or Rift. Open documents are saved per tab (`ui.docs`, `ui.doc`).
- Measured: switching to a tab showing a document = 1.5-1.9 ms of work (style + layout), less than a terminal.

### Settings and themes
- Overlay (⚙ or Ctrl+,; Esc closes); Rift's shortcuts are off while it is open.
- `settings.ts` is the single source: `ACTIONS`, `defaultKeys(mac)`, `mergeSettings` (any saved shape → valid), `comboOf`, `actionFor`, `bind`. Shortcuts dispatch only through `actionFor`. A shortcut needs Ctrl, Alt or Cmd, or is F1-F12 (`isValidShortcut`). macOS defaults use Cmd.
- Tab size (Compact / Comfortable / Large = 36 / 44 / 52 px rows, `TAB_ROW_HEIGHT`) sets the `--tab-row` CSS variable: no terminal refit.
- Every UI color is a CSS variable (`:root` dark, `[data-theme="light"]`), never a literal. Terminal palettes in `terminal/themes.ts`. "System" follows `prefers-color-scheme` live.
- Theme/font apply live via `TermView.setLook`; the effect tracks only theme + font (a shortcut edit must not re-render terminals). A font change re-wraps: visible tab now, hidden ones in idle time. Settings load before tabs restore.

### Session restore
- Shells get `RIFT_TAB_ID` (pty id) and `RIFT_PIPE` (`rift-<pid>`: `\\.\pipe\rift-<pid>`, or `$XDG_RUNTIME_DIR`/temp `rift-<pid>.sock`). The agent's hook runs `rift hook <harness>`, forwarding stdin + tab id; outside Rift it is a silent no-op; always exits 0. The pipe server handles connections **sequentially** (status depends on order).
- PowerShell: `-NoExit -EncodedCommand <init + startup>`; init wraps the user's prompt to emit OSC 9;9. cmd: `/K` with a `PROMPT` emitting OSC 9;9. bash (also Git Bash, MSYS paths converted): `--rcfile` sourcing ~/.bashrc, then OSC 7. zsh: `ZDOTDIR` whose files source the user's own, then OSC 7. Startup command via `RIFT_STARTUP`. WSL and other shells run plain. User profiles untouched.
- Frontend owns the tab list (`session_update`); hooks own the agent binding per pty. `SessionStore` writes on every change (tmp + rename), never before the frontend's first report, never after the freeze.
- A restored tab binds its session at `pty_open`. `SessionEnded` unbinds only a matching id (`/clear`). Resume accepts UUID-shaped ids only (no injection from a tampered file).
- Scrollback: on close and before an update restart, each **shell** tab's last 2000 lines are serialized with colors to `scrollback/<snap>.ans`, written back on restore under a dim "── restored ──" line. Agent tabs skipped (`--resume` redisplays). Orphans pruned after restore; ids validated.
- `session_restore` first closes every tab shell (spare kept): dev reloads would leak shells. Bench mode uses temp session/settings files; `RIFT_DATA_DIR` gives an isolated profile (and disables single instance) for demos.

### Agent harness
- Everything agent-specific goes through `AgentHarness` (`agents/mod.rs`): `id`, `name`, `parse_hook`, `resume_command`, `start_command`, `hooks_installed`, `install_hooks`, `one_shot`. UI and session code never mention "claude"; they use `AgentHarness`, `AgentEvent`, `AgentSession { harness, session_id }`.
- Claude hooks: in `~/.claude/settings.json`, **exec form** (`"command": "<path>\rift.exe", "args": ["hook", "claude"]`; shell form would go through Git Bash). Installed only on the user's "Enable" click; other settings and key order kept, `.bak` written, older Rift entries replaced. `SessionStart` → idle + bind, `SessionEnd` → unbind, `UserPromptSubmit`/`PostToolUse` → working, `Stop` → done, `Notification` → blocked (except `idle_prompt`). Hook call ~25 ms. Never edit that file without the user's click; uninstall not built.
- Usage: the same click sets `statusLine` to `rift status claude` (a shell command: forward slashes, quoted only with a space), unless the user has their own (kept, and counts as installed; hooks without any `statusLine` ask to Enable again). It prints `ctx 34% · 5h 23% · 7d 41%` back into Claude and forwards the JSON through the pipe → `agent-usage` (`agents::parse_usage`): context on the tab, 5h/7d plan limits in the top bar. Event-driven only (Claude debounces at 300 ms); no polling.
- Resume per tab: each tab runs `claude --resume <its own session_id>` in its cwd.

## Windows specifics
- Explorer menu ("Open in Rift" = new tab in the running window): Settings → Windows. `HKCU\Software\Classes\{Directory\shell, Directory\Background\shell, Drive\shell}\Rift`, command `"<exe>" "%V"`. Windows 11: under "Show more options" (top level needs MSIX + `IExplorerCommand`, later). Tests use `HKCU\Software\RiftTest-*`. No "new window" entry until multi-window exists.
- Single instance (off in bench mode): a second `rift.exe <dir>` forwards to the running Rift (`open-dir` → new tab) and exits. `dir_arg` fixes Explorer's drive-root quoting (`"C:\"` → `C:"`).

## Releases and CI
- Repo https://github.com/o0Zz/rift (public). CI: `lint` on Linux (fmt, clippy, tsc, vitest) + `test` on windows/ubuntu/macos, then on master `installers` per OS (artifacts). Time is Rust compilation (~150 s cold): never add a second full compile per OS. The bench stays local (needs a visible window).
- Packaging: Windows NSIS; macOS universal `.dmg`, **unsigned**; Linux AppImage (self-updates) + `.deb`.
- Versioning: repo stays `0.0.0`; CI builds `0.0.0+RUN` (dev) or `X.Y.Z+RUN` (tag `vX.Y.Z`), shown as `X.Y.Z.RUN`. The updater compares X.Y.Z only.
- Release: `git tag vX.Y.Z && git push --tags` → `release.yml` builds every OS with tauri-action and publishes one GitHub Release with `latest.json`.
- Signing key `~/.tauri/rift.key` + `rift.key.password` (never in the repo), GitHub secrets `TAURI_SIGNING_PRIVATE_KEY(_PASSWORD)`; public key in tauri.conf.json. Losing it means installed copies cannot update.
- In-app updater (`src/update.ts`, not in dev/bench): checks at startup and every 6 h, downloads in the background, "Restart now" or installs on close, after `session_freeze` and saving scrollback.
- Measured release: installer 2.4 MB, exe 7.2 MB, hook call 11 ms.

## Scope
- Done: tabs, spare shell, shell profiles, session + per-tab Claude resume, scrollback restore, grouped vertical tabs, agent status + notifications + attention tools, files and git panels (diff, commit selected files, AI message, stats, top bar), worktrees, documents in tabs (editor + Markdown reader), settings (themes, fonts, shortcuts, Cmd on macOS), Explorer menu, auto-update, benches.
- Next: multi-window, split panes, command palette (Ctrl+Shift+P), launch configurations, global hotkey, stage hunks, review comments sent to the tab's agent.
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
