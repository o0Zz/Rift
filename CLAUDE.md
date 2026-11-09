# Rift Terminal

A fast terminal built around coding agents (Claude Code, Codex, Gemini CLI, Copilot CLI). Windows first (developed and hand-tested there), built and tested in CI for Linux and macOS. It exists because Warp lags when switching tabs.

## Performance comes first (hard requirement)

**Speed beats every feature.** A feature that makes Rift slower does not ship.

- Before building, estimate the cost on the budget below. If it can slow tab switch, new tab, typing, output or startup, or adds idle work, **say so up front and push back hard** (name the cost, propose a cheaper design or dropping it). Never implement it silently.
- If the user still wants it: cheapest version, `npm run bench`, report the numbers. Over budget = not done. Every change to tabs, terminal, panels or rendering runs the bench before it is committed.

| Action                               | Budget        |
|--------------------------------------|---------------|
| Tab switch: main-thread work p95     | < 16 ms (one frame) — `npm run bench` |
| Tab switch: key → rendered p95       | < 50 ms — `npm run bench` |
| Heavy output (8.7 MB): frame gap p95 | < 100 ms — `npm run bench` |
| New tab until prompt is usable       | < 150 ms (our part, shell startup excluded: < 30 ms) |
| Cold app start to first prompt       | < 500 ms      |
| Idle CPU with 10 tabs                | ~0 %          |

How we hold it:
- Each tab's terminal stays **mounted**; a switch only toggles `display`. Never recreate a terminal or replay scrollback. Hidden tabs receive PTY output but do not render.
- Nothing runs on a tab switch but showing the tab: panels, git, stats and the session save come later, debounced. No polling, watchers or idle timers; no UI-thread work that scales with scrollback, repo size or tab count.
- One spare shell is pre-spawned so "new tab" just attaches it.
- `.topbar`/`.sidebar` `contain: layout paint style`, `.terms` and `.pane-group` `contain: strict`; the top bar updates one frame after the switch (`barTab` in rAF). Without them a switch cost ~4 ms more.
- Measured rejections (keep them): WebGL renderer (~54 vs ~15 ms p95 cycling 20 tabs, ~16 context cap); refitting while dragging a resizer (100+ ms/frame); resizing hidden tabs on their next switch (~149 ms p95: done in idle time instead, `resizeHiddenTabs`); live panels (user's choice); Monaco (CodeMirror instead).
- Known floor: xterm resumes a hidden terminal via IntersectionObserver, ~1 extra frame (20-27 ms p50 key → rendered). Next to attack if switching ever feels slow.

## Stack

- **Tauri 2** (Rust, system WebView). No Electron.
- **Rust**: PTY via `portable-pty` (ConPTY on Windows), git via the `git` CLI (the user's config/hooks), state in the app data dir (`%APPDATA%\dev.rift.terminal\`: `session.json`, `settings.json`, `prompts.json`, `scrollback/`).
- **Frontend**: TypeScript + Solid. Terminal: **xterm.js, DOM renderer**. Editor: CodeMirror 6 (lazy).
- **Shells** (`shell.rs`): default PowerShell 7, else Windows PowerShell; Linux/macOS `$SHELL` (fallback zsh / bash). Profiles (installed only, listed once): PowerShell 7, Windows PowerShell, cmd, Git Bash, WSL; Unix: login shell + `/etc/shells`. Default in Settings; right-click + for another; a new tab inherits the active tab's shell (`ui.shell`). The spare shell is only for the default shell.

## Architecture

```
src-tauri/src/
  pty.rs            spawn, resize, write (one writer thread per shell), spare shell (Tauri-free, tested on real shells)
  shell.rs          per-OS shells + integration (cwd reporting, startup command), user rc files untouched
  session.rs        what to restore: tabs (cwd, opaque ui) + agent session per tab
  scrollback.rs     per-tab history (`<id>.ans`) saved on close, shown again on restore
  hook.rs           `rift hook` client + server: named pipe (Windows) / Unix socket
  agents/           AgentHarness trait + adapters (claude, codex, gemini, copilot); config.rs: hook files, one-shot runs
  git.rs            branch from .git/HEAD (no process); status/diff/stats/commit/worktree via git CLI
  process.rs        runs git and one-shots: no window, stdin + both outputs at once, killed with its children on timeout
  files.rs          one directory level per call (never recursive)
  settings.rs       settings.json (frontend owns its shape)
  explorer_menu.rs  "Open in Rift" registry entries (HKCU) + `rift.exe <dir>` parsing
  lib.rs / main.rs  Tauri commands + setup / `rift hook|status <harness>`, else the app
src/
  App.tsx           wiring: restore, keys (one handler per action), agent status, panels, Enable banners
  tabs/             layout.ts (pure: order, moves, titles, notify rule), Tab.ts (Solid signals), Sidebar, TopBar, GitStats, icons, nav,
                    session.ts (debounced session save, histories), gitWatch.ts (when the git panel reloads, stats refresh)
  terminal/         TermView.ts (one xterm per tab), themes.ts, osc.ts, paths.ts
  panels/           panes.ts (tree of splits, pure), PaneTree.tsx (tree + drag and drop), Consoles.tsx (terminal panels), Explorer, GitPanel, Prompts, diff.ts, fileIcons.ts
  docs/             docs.ts (open/show/close in a tab), DocView.ts, place.ts (pure), editor.ts + markdown.ts (lazy)
  ui/               Menu, Resizer (+ resize.ts), Icon, PromptDialog, FindBar, Panel (PanelHead, Loaded)
  settings/         settings.ts (pure), SettingsPage.tsx
  update.ts, bench.ts
```

Frontend ↔ backend: Tauri commands, the PTY `Channel`, events (`pty-exit`, `agent-status`, `agent-usage`, `open-dir`). A module only when its feature is built; no abstraction until a second user exists, except `AgentHarness` (stated requirement). No migration or compatibility code: a saved shape that no longer fits falls back to defaults (`merge*` only validate).

## Decisions (keep them)

### Terminal
- `pty_open` takes a Tauri `Channel`; output = `InvokeResponseBody::Raw` bytes to `term.write(Uint8Array)`. Exit = `pty-exit`, from waiting on the child (ConPTY keeps the pipe open). `pty_write` only queues to the shell's writer thread: a shell that stops reading blocks nothing.
- New tabs open in the **active tab's folder**, after it, in its group. Spare shell: waits in a folder (home at launch); `pty_prewarm(cwd)` once the active tab and folder are stable for 1 s; `pty_open` takes it only for the same folder (case/trailing-separator insensitive), default shell, no startup command; its output is replayed on attach.
- portable-pty loads any `conpty.dll` found by name; WezTerm puts an old one on `PATH` (its `OpenConsole.exe` hung Rift at startup in `ClosePseudoConsole`): `lock_dll_search` (`SetDefaultDllDirectories`, first thing in `run`) limits DLL search to the app folder and System32. Commands that create or close a pseudo console (`pty_open`, `pty_close`, `shell_set_default`, `session_restore`) are `command(async)`: they wait for the console host, never on the main thread. `pty_write`/`pty_resize` stay sync (hot path).
- ConPTY sends `ESC[6n` at startup and blocks until answered; xterm answers. `TermView` queues input until `pty_open` returns. Tests answer by hand (`\x1b[1;1R`). An answer below the console's first size hangs it for good (a resize is not applied before): a shell is created at its tab's size and the writer caps that first answer's row to it (restored history, spare shell taken by a taller terminal).
- Shell integration reports the cwd at every prompt (OSC 9;9 PowerShell/cmd, OSC 7 bash/zsh, Git Bash MSYS paths converted) without touching the user's rc files (wrappers that source them). Startup command via `RIFT_STARTUP`. WSL/others run plain.
- Shortcuts: capture-phase `keydown`, so xterm never sees them; dispatched only through `settings.ts` `actionFor`. Windows/Linux new/close tab = Ctrl+Shift+T/W (Ctrl+T/W/F belong to the shell and agents); macOS Cmd+T/W/F. A shortcut needs Ctrl, Alt or Cmd, or is F1-F12.
- The webview never reloads (it would restart every shell): F5 / Ctrl+R / Cmd+R blocked outside a terminal (`isReloadKey`). F5 = refresh files and git panels.
- Find Ctrl+Shift+F (search addon). Links: Ctrl+click, http(s) only (`open_url`). Zoom (`zoomed`, `wheelSteps`): Ctrl+wheel resizes the area under the cursor (`data-zoom`), Ctrl+= / - / 0 the focused one (else terminals). Terminals = `fontSize` (default 12 px, all terminals: one cell size); files, git, prompts, docs = `scale` (0.6-2, CSS variables `--scale-*`, panel sizes in em, headers fixed). Applied live, saved 500 ms after the last step.
- Shift+Enter in an agent tab sends ESC+CR. Image paste: the agent reads the clipboard on its own key (Alt+V on Windows = `ESC v`; Ctrl+V elsewhere); a paste without text sends 0x16. Claude's keys, untested in other agents.
- Drag a file from the files panel onto a terminal types its path (`quotePath`). No OS file-manager drops: Tauri's native drag-drop breaks HTML5 drag and drop on Windows (`dragDropEnabled: false`).

### Sidebar and attention
- Vertical tabs, one global array + `group` per tab; the **visual order** (`sidebarItems` / `visualOrder`) drives the sidebar and Ctrl+PgUp/PgDn: a group stands where its first tab is, so groups and ungrouped tabs mix (empty groups last). Named groups (collapsible, draggable): `color` = dot + name, `background` = tints the block and wins over its tabs' colors. Activating a tab in a collapsed group expands it.
- Drag and drop (`Spot`, `moveTab`, `moveGroup`): upper half of a row = before it, lower half = after it (a tab joins that tab's group); group header upper half = just above the group, outside it, lower half = first in it (a tab) or after it (a group). A group never lands inside another; empty area = bottom, ungrouped.
- Title: user name > agent's terminal title > folder (a title ending in `.exe` is ignored). Icon: shell prompt or the agent's (by harness id, from hooks). Under it: branch + git stats. Row size 36 / 44 / 52 px (`--tab-row`, no refit).
- Per-tab `ui` (name, color, group, shell, snap, docs) and `layout` (groups, panes, widths) are opaque to the backend.
- Badges: working = spinning magenta, done = green, blocked = yellow; unread dot + toast when done/blocked and not in front. `needsAttention` = blocked, or done and unread. Ctrl+Shift+U = next one (blocked first). Filter All / Needs me / Working. Title `Rift <version> — N waiting`; taskbar flashes in the background; a seen "done" fades after 3 s. Esc or Ctrl+C (no selection) in a working/blocked agent tab = `interrupted`, a red "!" badge (agents fire no hook on interrupt, `isInterruptKey`); a tool-finished hook (`AgentEvent::ToolDone`, `continued`) arriving late cannot undo it, only a new prompt, Stop or a question (`statusFromHook`).
- Closing with agents working/blocked asks first, so does closing a group with tabs. Window focus from Tauri `onFocusChanged` (`document.hasFocus()` is unreliable in WebView2).
- "New <agent> in a worktree…": `git_worktree_add` → `<repo>.worktrees/<branch>`, a tab there runs `AgentHarness::start_command`.
- UI: SVG icons (`ui/Icon.tsx`, `currentColor`), never Unicode glyphs. Menus keyboard-usable, in a `Portal` (`contain: paint` clipped them); F2 renames. Focus returns to the terminal after a menu, rename or tab click. Text input via `ui/PromptDialog.tsx` (`window.prompt` is blocked in WebView2).

### Panels and top bar
- Panes (`panes.ts`, `PaneTree.tsx`): one tree of splits for every tab, saved as `layout.panes`. A split = row/column with flex weights (`sizes`) and a 1px handle between children; a leaf = a group of panels, tabs when several (`shown` undefined = closed, keeps its place). "main" (the tab's top bar, terminals, documents) is one leaf alone in its group; its `<main>` is built once and moved there, so tab terminals never remount. Panes render by id (`index`, `For` over ids): a move or resize never remounts siblings. Defaults [files | main | git + prompts]; Ctrl+Shift+E / G / O show or hide.
- Move by dragging a panel's header (outside its buttons) or tab; the spot under the cursor lights up like VS Code: a pane's outer quarter = beside it (`zoneAt`, `insert`: a sibling when the parent runs that way, else a new split), its middle = a tab (none on main), within 24 px of the window edge = a full side; `sameSpot` = no-op. No right-click menu (user's choice). Alt+arrows (Ctrl+Alt on macOS) focus the pane on that side (`nextPane`): main → its terminal or document, a terminal panel → its shell, else `[data-autofocus]` (the new-prompt box) or the first input.
- A tab is a list of shells (`Tab.shells`, `tabs/Shell.ts`): its own at "main", one per terminal panel it started; none is special for agents (status, Shift+Enter, Esc, context, notifications, Find on the last focused one, the tab's shell profile). Hooks report by pty id (`shellOf`). The sidebar shows the `lead` shell (blocked > done > working, else main); a panel shell's badge is also in its header. Only main is saved/restored and owns the tab's repo.
- Terminal panels (`Consoles.tsx`, `term:<n>`): the panel's place is the same for every tab, its shell is the active tab's (user's choice, over the earlier shared shells). A tab without one there sees "Start a terminal here": a shell starts only on a click (or + / Ctrl+Shift+K, which fills such a panel first), never on a switch; a switch only toggles which terminal is displayed (`.pane-term` `contain: strict`). × ends this tab's shell; the panel leaves once no tab has one; a closed tab ends its shells. The "Start a terminal here" box is always in the panel, only its `display` changes: a lone `<Show>` in an element clears it whole when it hides (Solid sets `textContent`), which erased hand-added terminals (same reason for the `.contents` wrapper around the find bar). Bench case "cycle, tabs with a terminal panel" (two terminals per switch, last tab without one; fails if a terminal left the page): work p95 13.5-15 ms, near the budget (an earlier 4.6 ms was measured on terminals that bug had erased), latency equal to the plain cycle (measured at 60 Hz). Not restored, no scrollback.
- **Not live**: panels load when shown, when the shown tab changes, or on ⟳/F5. They follow `panelTab`, 150 ms behind the active tab. Commands async, stale answers dropped. The git panel reloads in place (checks and diff kept) when an agent in its repo finishes, when a prompt comes back in a terminal of its repo (`gitWatch.promptCameBack`, 300 ms after the last one: catches a typed `git pull`), after Pull even a failed one (a conflict), and on a switch to a tab of the same repo only if marked changed (`gitWatch`). Lists use `Loaded`, which follows the value: a reload in place updates "No changes" / an error (a `<Show>` callback is built once and would keep the first state). GitPanel loads on `on(() => props.root)` only (a plain effect looped git).
- Explorer root = repo root, else cwd; folders listed on first expand, cached until ⟳. Delete (macOS Cmd+Backspace) moves to Recycle Bin / Trash after a confirm (`fs_trash`, never permanent); documents under it close. Right-click a folder or the empty space: "Open in File Explorer / Finder / file manager" (`fs_open` on the folder, the root for empty space).
- Each tab knows its repo root + branch: `git_head` reads `.git/HEAD` at every prompt. Stats (`git_stats`, ~80 ms): 1.5 s after a prompt or agent status change (coalesced per tab) and after a commit, **never on a tab switch**.
- Top bar (Warp-style): title, + (new terminal), prompts, git button (branch + `+added −deleted ↑ahead ↓behind`), Claude's 5h/7d plan usage.
- Git file lists show `+added −deleted` per file: `git diff --numstat` in parallel with the status (commit files: with the name-status); untracked files counted in Rust (first 200, ≤ 1 MB, not binary). Commit & Push is the primary (blue) button.
- Git, all on a click: commit exactly the checked files (`git commit --only`, pathspecs on stdin with `--literal-pathspecs`), Discard (checked files, or right-click one; confirm first, `discardQuestion`): `git::discard` restores what HEAD has (`restore --source=HEAD --staged --worktree`), unstages new files and moves them to the Recycle Bin / Trash, branch menu, Pull (user's config), Push (no upstream → `-u <first remote> HEAD`), history (Shift+click = a range, both ends). `GIT_TERMINAL_PROMPT=0`; any git command killed after 5 min. Commit ids checked hex. `onHeadChanged` re-reads branch + stats of every tab of the repo.
- ✨ Generate: checked files' diff (capped 60 KB) → `one_shot` of the first agent used here (tooltip names it), Conventional Commits, no co-author (`COMMIT_PROMPT`), killed after 120 s with its children.
- Prompts: one list per repo (`promptKey`) in `prompts.json`, saved on each edit. ✓ (Apply) or a drag onto the terminal pastes it (bracketed, no Enter) and removes it. Drag up/down in the list reorders (`movePrompt`, a line marks the gap; `moved` keeps dragend from removing it).

### Documents (files opened in a tab)
- A click in the files panel opens the file **in the tab** (`docs.ts`); the top bar becomes sub-tabs `Terminal | file × | ...` (same height: no refit). Setting: one document at a time (`placeDoc`: replaces the shown or last one, never an unsaved one) or a sub-tab each. Not text (binary, not UTF-8, > 5 MB) → default app; from a Markdown link → shown in the file manager, never opened (a link to an .exe would run it).
- `DocView` is like `TermView`: mounted for the tab's life, `display` toggle; reads the file once shown and still visible; re-checks the mtime 150 ms after being shown (changed outside, no unsaved edits → reloaded). No watcher. Switching to a document tab ≈ 1.5-1.9 ms.
- Editor (`editor.ts`, lazy ~114 KB gz, `@codemirror/language-data`): highlighting, search, undo, Ctrl+S; line endings kept; terminal font via CSS variables. No LSP/autocomplete.
- Markdown reader (`markdown.ts`, lazy, marked + **DOMPurify**: the page can call Rift's commands, so no scripts, handlers, forms or `style`), Edit/Read in the top bar. Links: http(s) → browser, relative → opened in Rift, never navigate the app. Relative images via the asset protocol.
- Unsaved changes: confirm before closing the document, its tab or Rift. Open documents saved per tab (`ui.docs`, `ui.doc`).

### Settings and themes
- Overlay (⚙ or Ctrl+,; Esc closes); shortcuts off while open. `settings.ts` is the single source (`ACTIONS`, `defaultKeys(mac)`, `mergeSettings`, `actionFor`, `bind`). Settings load before tabs restore.
- Every UI color is a CSS variable (`:root` dark, `[data-theme="light"]`). Terminal palettes in `terminal/themes.ts`. "System" follows `prefers-color-scheme` live.
- Theme/font apply live (`TermView.setLook`); the effect tracks only theme + font. A font change re-wraps the visible tab now, hidden ones in idle time.

### Session restore
- Frontend owns the tab list (`session_update`, sent 300 ms after the last change, at once before closing or updating: `session.flush`); hooks own the agent binding per pty. `SessionStore` writes tmp + rename, never before the first report, never after the freeze (`WindowEvent::Destroyed`).
- A restored tab binds its session at `pty_open` and runs the harness's `resume_command` in its cwd (its own session). `SessionEnded` unbinds only a matching id (`/clear`). Resume ids validated (UUID for Claude, `config::safe_id` for others).
- Scrollback: on close and before an update restart, each **shell** tab's last 2000 lines (with colors) to `scrollback/<snap>.ans` (tmp + rename), written back under a dim "── restored ──" line. Agent tabs skipped (resume redisplays). Orphans pruned; ids validated.
- `session_restore` first closes every tab shell (dev reloads would leak them). Bench mode: fresh temp session/settings/prompts files. `RIFT_DATA_DIR` = isolated profile, no single instance.

### Agent harness
- Everything agent-specific goes through `AgentHarness` (`agents/mod.rs`): `id`, `name`, `detected` (config folder exists: only those get Enable, a worktree entry and Generate), `parse_hook`, `resume_command`, `start_command`, `hooks_installed`, `install_hooks`, `setup` (what Enable writes, shown before the click), `one_shot`. `Harnesses::new(home)` lists them. UI and session code never name an agent.
- Hooks: shells get `RIFT_TAB_ID` and `RIFT_PIPE` (`\\.\pipe\rift-<pid>`, or `$XDG_RUNTIME_DIR`/temp `rift-<pid>.sock`). `rift hook <harness>` forwards stdin + tab id; outside Rift a silent no-op; always exits 0, prints nothing. The server handles connections **in order** (status depends on it), drops a client silent for 2 s and survives a failed connection. ~11-25 ms per hook.
- Agent config files are written only on the user's Enable click: other settings and key order kept, Rift's own entries replaced, `.bak` + tmp + rename.
- Claude Code: **exec form** hooks (a shell form would go through Git Bash); `idle_prompt` notifications are not a block. Enable also sets `statusLine` to `rift status claude` (forward slashes, quoted only with a space: PowerShell would not run a quoted path) unless the user has one: it prints `ctx 34% · 5h 23% · 7d 41%` and forwards the JSON (`agent-usage`: context on the tab, plan limits in the top bar).
- Codex, Gemini CLI, Copilot CLI: built from their docs/source, never run live (event mappings in each adapter + tests). Codex runs new hooks only once trusted (`/hooks`; Rift never writes trust hashes). Gemini hooks never print nor exit 2 (= block). Copilot gets Rift's own file, rewritten whole, PascalCase events for Claude-shaped payloads. No status line for them. OpenCode not built (plugins in a shared server, API mid-rewrite).
- npm agents are `.cmd` shims on Windows: `config::program` searches PATH for `.exe`/`.cmd`/`.bat`; batch arguments escaped (tested through a node shim).

## Windows specifics
- Explorer menu (Settings → Windows): HKCU registry entries only (Windows 11: under "Show more options"; the top level needs MSIX). Tests use `HKCU\Software\RiftTest-*`.
- Single instance (off in bench mode): a second `rift.exe <dir>` forwards to the running Rift (`open-dir` → new tab). `dir_arg` fixes Explorer's drive-root quoting (`"C:\"` → `C:"`).

## Releases and CI
- Repo https://github.com/o0Zz/Rift (public). CI: `lint` on Linux (fmt, clippy, tsc, vitest) + `test` on windows/ubuntu/macos, then on master `installers` per OS. Rust compilation is the time (~150 s cold): never a second full compile per OS. The bench stays local (needs a visible window). Clippy runs on Linux only: check `#[cfg(windows)]` code by hand.
- Packaging: Windows NSIS; macOS universal `.dmg`, **unsigned**; Linux AppImage (self-updates) + `.deb`.
- Versioning: repo stays `0.0.0`; a release (tag `vX.Y.Z`) builds `X.Y.Z`; a master build `X.Y.Z+N` = last tag + N commits since (`git describe`, full-history checkout; `0.0.0+N` before any tag), shown as is; the updater compares X.Y.Z (a `+N` build updates at the next release). First release v1.0.0 (2026-11-01): installers 3.2 MB (Windows), 7.7 MB (dmg), 5.0 MB (deb), 83 MB (AppImage).
- Release: `git tag vX.Y.Z && git push origin vX.Y.Z` → `release.yml` (tauri-action, every OS, one GitHub Release with `latest.json`).
- Signing key `~/.tauri/rift.key` + `rift.key.password` (never in the repo), secrets `TAURI_SIGNING_PRIVATE_KEY(_PASSWORD)`, public key in tauri.conf.json. Losing it = installed copies cannot update.
- Updater (`update.ts`, not in dev/bench): at startup and every 6 h, downloads in the background, "Restart now" or installs on close, after `session_freeze` and saving scrollback.

## Scope
- Done: tabs, spare shell, shell profiles, session + per-tab agent resume, scrollback restore, grouped vertical tabs, agent status + notifications + attention tools (4 agents), files / git / prompts / terminal panels in a tree of splits, worktrees, documents in tabs (editor + Markdown reader), settings, Explorer menu, auto-update, benches.
- Next: multi-window, command palette (Ctrl+Shift+P), launch configurations, global hotkey, stage hunks, review comments sent to the tab's agent.
- Out of scope (cost speed or not the product): Warp blocks / rewritten input editor, built-in AI agent, Warp Drive / notebooks / sharing, cloud agents, IDE features (LSP, autocomplete, project search), accounts. Revisit only if asked.

## Conventions
- Rust: `cargo fmt`, `cargo clippy -- -D warnings`. Frontend: `tsc --noEmit`, vitest.
- Every feature ships with tests. Prefer end-to-end: real PTY, real git repo in a temp dir, real hook JSON through the pipe.
- Commits: **Conventional Commits**, one short subject line, optional brief body, no sign-off trailers.
- Dev loop: keep `npm run tauri dev` running (the user watches live). Tests and bench with `CARGO_TARGET_DIR=src-tauri/target/test` so they don't fight the running app over `rift.exe`.

## Commands
```
npm run tauri dev                 # run (Vite on :1420 + Rust app)
npm run tauri build               # package
cd src-tauri && cargo test        # backend tests (real shells)
npm test                          # frontend tests (vitest)
npm run typecheck                 # tsc --noEmit
npm run bench                     # tab switch + heavy output in the real WebView (window visible; fails over budget)
npx tauri icon src-tauri/icons/rift.svg   # regenerate icons; then delete icons/android, icons/ios, 64x64.png and
                                  # touch tauri.conf.json (icons are re-embedded only when it changes)
```
