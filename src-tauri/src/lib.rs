mod agents;
mod explorer_menu;
mod files;
mod git;
pub mod hook;
mod process;
mod pty;
mod scrollback;
mod session;
mod settings;
mod shell;

use std::sync::Arc;

use agents::{AgentEvent, AgentSession, Harnesses};
use portable_pty::PtySize;
use pty::{PtyManager, TabId};
use scrollback::Scrollback;
use serde::Serialize;
use session::{Saved, SessionStore, TabInfo};
use settings::SettingsFile;
use shell::Shell;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};

type Ptys<'a> = State<'a, Arc<PtyManager>>;

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        cols,
        rows,
        ..Default::default()
    }
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// Opens a shell for a new tab. Output is streamed as raw bytes on `on_data`; exit is the `pty-exit` event.
/// With `agent`, the shell starts by resuming that agent session.
/// Off the main thread (`async`), like every command that creates or closes a pseudo console: those calls
/// wait for the console host process, and a sync command would freeze the window with them.
#[tauri::command(async)]
#[allow(clippy::too_many_arguments)] // Tauri injects state/app params
fn pty_open(
    app: AppHandle,
    ptys: Ptys,
    harnesses: State<Harnesses>,
    session: State<SessionStore>,
    cwd: Option<String>,
    agent: Option<AgentSession>,
    start_agent: Option<String>,
    shell: Option<String>,
    cols: u16,
    rows: u16,
    on_data: Channel<InvokeResponseBody>,
) -> Result<TabId, String> {
    // Resume a saved session, or start a new one (`start_agent`: harness id, e.g. a new worktree tab).
    let startup = agent
        .as_ref()
        .and_then(|a| harnesses.get(&a.harness)?.resume_command(&a.session_id))
        .or_else(|| Some(harnesses.get(start_agent.as_deref()?)?.start_command()));
    let id = ptys
        .open(
            cwd.map(Into::into),
            startup.as_deref(),
            // A tab's own shell profile; unknown (uninstalled) profiles fall back to the default shell.
            shell.as_deref().and_then(Shell::from_profile),
            size(cols, rows),
            Box::new(move |bytes| {
                let _ = on_data.send(InvokeResponseBody::Raw(bytes));
            }),
            Box::new(move |id| {
                let _ = app.emit("pty-exit", id);
            }),
        )
        .map_err(err)?;
    if let (Some(agent), Some(_)) = (agent, startup) {
        session.bind(id, agent);
    }
    Ok(id)
}

#[tauri::command]
fn pty_write(ptys: Ptys, id: TabId, data: String) -> Result<(), String> {
    ptys.write(id, data.as_bytes()).map_err(err)
}

#[tauri::command]
fn pty_resize(ptys: Ptys, id: TabId, cols: u16, rows: u16) -> Result<(), String> {
    ptys.resize(id, size(cols, rows)).map_err(err)
}

/// The shells installed here (default first), for settings and "New tab with…".
#[tauri::command]
fn shell_profiles() -> &'static [shell::Profile] {
    shell::profiles()
}

/// Default shell from settings (`None`: the platform default). Spare shells use it from now on.
#[tauri::command(async)]
fn shell_set_default(ptys: Ptys, id: Option<String>) {
    let shell = id
        .as_deref()
        .and_then(Shell::from_profile)
        .unwrap_or_else(Shell::default_for_platform);
    ptys.set_default_shell(shell);
    ptys.prewarm(None);
}

/// Keeps a spare shell ready in `cwd` (the active tab's folder): the next new tab there is instant.
#[tauri::command]
fn pty_prewarm(ptys: Ptys, cwd: Option<String>) {
    ptys.prewarm(cwd.map(Into::into));
}

#[tauri::command(async)]
fn pty_close(ptys: Ptys, id: TabId) {
    ptys.close(id);
}

/// Opens a link from the terminal (Ctrl+click) in the browser. Web links only: a terminal can print anything.
#[tauri::command]
async fn open_url(url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("only http(s) links are opened".into());
    }
    tauri_plugin_opener::open_url(url, None::<&str>).map_err(err)
}

/// Lines changed and commits ahead/behind, shown on the tab and on the git button. Background only.
#[tauri::command]
async fn git_stats(root: String) -> Result<git::Stats, String> {
    git::stats(root.as_ref()).map_err(err)
}

/// New git worktree (and branch) next to the repository, for a parallel agent. Returns its folder.
#[tauri::command]
async fn git_worktree_add(root: String, branch: String) -> Result<String, String> {
    git::worktree_add(root.as_ref(), branch.trim())
        .map(|p| p.display().to_string())
        .map_err(err)
}

/// Tabs saved by the previous run. Called once per page load: shells left over from a previous
/// page (dev reload, WebView reload) have no tab anymore and are closed.
#[tauri::command(async)]
fn session_restore(session: State<SessionStore>, ptys: Ptys) -> Saved {
    ptys.close_all_tabs();
    session.load()
}

/// A tab's history, saved when Rift closes (`id`: the tab's snapshot id, a UUID).
#[tauri::command]
async fn scrollback_save(
    store: State<'_, Scrollback>,
    id: String,
    data: String,
) -> Result<(), String> {
    store.save(&id, &data).map_err(err)
}

#[tauri::command]
async fn scrollback_load(
    store: State<'_, Scrollback>,
    id: String,
) -> Result<Option<String>, String> {
    Ok(store.load(&id))
}

/// After restoring: histories of tabs that are gone are deleted.
#[tauri::command]
async fn scrollback_prune(store: State<'_, Scrollback>, keep: Vec<String>) -> Result<(), String> {
    store.prune(&keep);
    Ok(())
}

/// Before an update installs (the installer kills the app): keep the session as it is now.
#[tauri::command]
fn session_freeze(session: State<SessionStore>) {
    session.freeze();
}

#[tauri::command]
fn session_update(
    session: State<SessionStore>,
    tabs: Vec<TabInfo>,
    active: usize,
    layout: serde_json::Value,
) {
    session.update_tabs(tabs, active, layout);
}

/// Payload of the `agent-status` event.
#[derive(Clone, Serialize)]
struct AgentStatus {
    pty: TabId,
    /// Harness id, so the UI can show that agent's icon.
    harness: String,
    status: Option<&'static str>,
    message: Option<String>,
}

/// Payload of the `agent-usage` event (the agent's status line).
#[derive(Clone, Serialize)]
struct AgentUsage {
    pty: TabId,
    #[serde(flatten)]
    usage: agents::Usage,
}

#[derive(Serialize)]
struct Integration {
    id: &'static str,
    name: &'static str,
    detected: bool,
    installed: bool,
    /// What Enable writes, shown before the click.
    setup: String,
}

#[tauri::command]
fn agent_integrations(harnesses: State<Harnesses>) -> Result<Vec<Integration>, String> {
    let exe = std::env::current_exe().map_err(err)?;
    Ok(harnesses
        .0
        .iter()
        .map(|h| Integration {
            id: h.id(),
            name: h.name(),
            detected: h.detected(),
            installed: h.hooks_installed(&exe),
            setup: h.setup(),
        })
        .collect())
}

/// Writes the agent's hook config (e.g. ~/.claude/settings.json). Only called from the user's explicit click.
#[tauri::command]
fn agent_install(harnesses: State<Harnesses>, id: String) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(err)?;
    harnesses
        .get(&id)
        .ok_or("unknown agent")?
        .install_hooks(&exe)
        .map_err(err)
}

// Explorer and git panel. All async: they run off the main thread and never delay a tab switch.

#[tauri::command]
async fn fs_list(dir: String) -> Result<Vec<files::Entry>, String> {
    files::list(dir.as_ref()).map_err(err)
}

#[tauri::command]
async fn fs_open(path: String) -> Result<(), String> {
    tauri_plugin_opener::open_path(path, None::<&str>).map_err(err)
}

/// A file to show in a document tab; None = not text (open it in the default app instead).
#[tauri::command]
async fn fs_read_text(path: String) -> Result<Option<files::Text>, String> {
    files::read_text(path.as_ref()).map_err(err)
}

#[tauri::command]
async fn fs_write_text(path: String, text: String) -> Result<u64, String> {
    files::write_text(path.as_ref(), &text).map_err(err)
}

#[tauri::command]
async fn fs_mtime(path: String) -> Result<u64, String> {
    files::mtime(path.as_ref()).map_err(err)
}

#[tauri::command]
async fn fs_reveal(path: String) -> Result<(), String> {
    tauri_plugin_opener::reveal_item_in_dir(path).map_err(err)
}

#[tauri::command]
async fn fs_trash(path: String) -> Result<(), String> {
    files::trash(path.as_ref()).map_err(err)
}

#[tauri::command]
async fn git_head(cwd: String) -> Option<git::Head> {
    git::head(cwd.as_ref())
}

#[tauri::command]
async fn git_status(root: String) -> Result<Vec<git::Change>, String> {
    git::status(root.as_ref()).map_err(err)
}

#[tauri::command]
async fn git_commit(
    root: String,
    files: Vec<(String, bool)>,
    message: String,
) -> Result<String, String> {
    git::commit(root.as_ref(), &files, &message).map_err(err)
}

#[tauri::command]
async fn git_discard(root: String, files: Vec<(String, bool)>) -> Result<(), String> {
    git::discard(root.as_ref(), &files).map_err(err)
}

/// The user's own convention for commit messages (see their CLAUDE.md).
const COMMIT_PROMPT: &str = "Write a git commit message for the diff on stdin, following Conventional Commits. \
Subject line: `type(scope): description`, where type is one of feat, fix, docs, style, refactor, perf, test, \
build, ci, chore; the scope is optional (the main area touched, one short word); the description is in the \
imperative mood, lower case, no final period; the whole line at most 72 characters. \
For a breaking change, add `!` before the colon and a `BREAKING CHANGE:` footer. \
Optionally a blank line and a brief body. No co-author or sign-off lines. \
Output only the message, without quotes or code fences.";

/// AI commit message for the selected files, written by the first agent used on this machine.
#[tauri::command]
async fn commit_message(
    harnesses: State<'_, Harnesses>,
    root: String,
    files: Vec<(String, bool)>,
) -> Result<String, String> {
    let diff = git::diff_many(root.as_ref(), &files, 60_000).map_err(err)?;
    if diff.trim().is_empty() {
        return Err("Nothing to describe: the selected files have no diff".into());
    }
    let agent = harnesses.for_one_shot().ok_or("no agent configured")?;
    agent
        .one_shot(root.as_ref(), COMMIT_PROMPT, &diff)
        .map_err(err)
}

#[tauri::command]
async fn git_diff(root: String, path: String, untracked: bool) -> Result<String, String> {
    git::diff(root.as_ref(), &path, untracked).map_err(err)
}

#[tauri::command]
async fn git_branches(root: String) -> Result<Vec<git::Branch>, String> {
    git::branches(root.as_ref()).map_err(err)
}

#[tauri::command]
async fn git_switch(root: String, branch: String) -> Result<(), String> {
    git::switch(root.as_ref(), branch.trim()).map_err(err)
}

#[tauri::command]
async fn git_create_branch(root: String, branch: String) -> Result<(), String> {
    git::create_branch(root.as_ref(), branch.trim()).map_err(err)
}

#[tauri::command]
async fn git_push(root: String) -> Result<String, String> {
    git::push(root.as_ref()).map_err(err)
}

#[tauri::command]
async fn git_pull(root: String) -> Result<String, String> {
    git::pull(root.as_ref()).map_err(err)
}

/// History panel: the last 200 commits (enough to browse; no paging until someone needs it).
#[tauri::command]
async fn git_log(root: String) -> Result<Vec<git::Commit>, String> {
    git::log(root.as_ref(), 200).map_err(err)
}

#[tauri::command]
async fn git_commit_files(
    root: String,
    from: Option<String>,
    to: String,
) -> Result<Vec<git::Change>, String> {
    git::commit_files(root.as_ref(), from.as_deref(), &to).map_err(err)
}

#[tauri::command]
async fn git_commit_diff(
    root: String,
    from: Option<String>,
    to: String,
    path: String,
) -> Result<String, String> {
    git::commit_diff(root.as_ref(), from.as_deref(), &to, &path).map_err(err)
}

#[tauri::command]
fn settings_load(settings: State<SettingsFile>) -> serde_json::Value {
    settings.load()
}

#[tauri::command]
fn settings_save(settings: State<SettingsFile>, value: serde_json::Value) -> Result<(), String> {
    settings.save(&value).map_err(err)
}

/// Prompts prepared in advance (prompts.json, per repo): a JSON file the frontend owns, like settings.
struct PromptsFile(SettingsFile);

#[tauri::command]
fn prompts_load(prompts: State<PromptsFile>) -> serde_json::Value {
    prompts.0.load()
}

#[tauri::command]
async fn prompts_save(
    prompts: State<'_, PromptsFile>,
    value: serde_json::Value,
) -> Result<(), String> {
    prompts.0.save(&value).map_err(err)
}

/// Folder Rift was launched with (`rift.exe <dir>`, e.g. from Explorer's "Open in Rift"), opened as a new tab.
#[tauri::command]
fn startup_dir() -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    let cwd = std::env::current_dir().ok()?;
    explorer_menu::dir_arg(&args, &cwd).map(|d| d.display().to_string())
}

#[tauri::command]
fn explorer_menu_installed() -> Result<Option<bool>, String> {
    #[cfg(windows)]
    {
        let exe = std::env::current_exe().map_err(err)?;
        Ok(Some(explorer_menu::ExplorerMenu::default().installed(&exe)))
    }
    // `None`: no Explorer menu on this OS (the settings section is hidden).
    #[cfg(not(windows))]
    Ok(None)
}

/// Adds or removes "Open in Rift" in Explorer's right-click menu. Only from the user's click in settings.
#[tauri::command]
fn explorer_menu_set(enabled: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        let menu = explorer_menu::ExplorerMenu::default();
        if enabled {
            menu.install(&std::env::current_exe().map_err(err)?)
                .map_err(err)
        } else {
            menu.uninstall().map_err(err)
        }
    }
    #[cfg(not(windows))]
    {
        let _ = enabled;
        Err("The Explorer menu only exists on Windows".into())
    }
}

/// `RIFT_DATA_DIR`: an isolated profile (own session and settings, no single instance), e.g. to try
/// things or take screenshots without touching the user's tabs.
fn data_dir_override() -> Option<std::path::PathBuf> {
    std::env::var_os("RIFT_DATA_DIR").map(Into::into)
}

fn bench_mode() -> bool {
    std::env::var_os("RIFT_BENCH").is_some()
}

/// In bench mode, the folders the bench opens its tabs in (RIFT_BENCH_DIRS, `;`-separated): git repos,
/// so the panels do real work when switching. `None` outside bench mode.
#[tauri::command]
fn bench_dirs() -> Option<Vec<String>> {
    bench_mode().then(|| {
        std::env::var("RIFT_BENCH_DIRS")
            .unwrap_or_default()
            .split(';')
            .filter(|d| !d.is_empty())
            .map(String::from)
            .collect()
    })
}

/// In bench mode, a big text file (RIFT_BENCH_OUTPUT) printed in a tab to measure heavy output: path and size.
#[tauri::command]
fn bench_output_file() -> Option<(String, u64)> {
    let path = std::env::var("RIFT_BENCH_OUTPUT")
        .ok()
        .filter(|_| bench_mode())?;
    let size = std::fs::metadata(&path).ok()?.len();
    Some((path, size))
}

#[tauri::command]
fn bench_done(app: AppHandle, report: String, ok: bool) {
    println!("{report}");
    app.exit(if ok { 0 } else { 1 });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    pty::lock_dll_search();
    let mut builder = tauri::Builder::default();
    // Single instance: a second `rift.exe <dir>` (Explorer menu) opens a tab in this window instead.
    // Not in bench mode or an isolated profile, which must run next to the user's instance.
    if !bench_mode() && data_dir_override().is_none() {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            if let Some(dir) = explorer_menu::dir_arg(&argv, std::path::Path::new(&cwd)) {
                let _ = app.emit("open-dir", dir.display().to_string());
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }));
    }
    builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let home = app.path().home_dir()?;
            // Per-process pipe: hooks reach the Rift instance that owns their tab.
            let pipe = format!("rift-{}", std::process::id());

            // The bench never reads nor overwrites the user's files: fresh temp ones, default settings.
            let data_dir = data_dir_override().map_or_else(|| app.path().app_data_dir(), Ok)?;
            let data_file = |name: &str| {
                if bench_mode() {
                    let file = std::env::temp_dir().join(format!("rift-bench-{name}"));
                    let _ = std::fs::remove_file(&file);
                    file
                } else {
                    data_dir.join(name)
                }
            };
            let session_path = data_file("session.json");
            // Tab histories live next to the session (temp folder for the bench).
            app.manage(Scrollback(session_path.with_file_name("scrollback")));
            app.manage(SessionStore::new(session_path));
            app.manage(SettingsFile(data_file("settings.json")));
            app.manage(PromptsFile(SettingsFile(data_file("prompts.json"))));
            app.manage(Harnesses::new(&home));

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(hook::serve(pipe.clone(), move |msg| {
                // Status line: live numbers only, no status or session change.
                if let Some(usage) = agents::parse_usage(&msg.harness, &msg.payload) {
                    let _ = handle.emit(
                        "agent-usage",
                        AgentUsage {
                            pty: msg.tab,
                            usage,
                        },
                    );
                    return;
                }
                let harnesses = handle.state::<Harnesses>();
                let Some(event) = harnesses
                    .get(&msg.harness)
                    .and_then(|h| h.parse_hook(&msg.payload))
                else {
                    return;
                };
                handle
                    .state::<SessionStore>()
                    .agent_event(msg.tab, &msg.harness, &event);
                let message = match &event {
                    AgentEvent::NeedsInput { message } => Some(message.clone()),
                    _ => None,
                };
                let status = AgentStatus {
                    pty: msg.tab,
                    harness: msg.harness.clone(),
                    status: event.status(),
                    message,
                };
                let _ = handle.emit("agent-status", status);
            }));

            // Title shows the version: "Rift 1.2.3" (a release), "Rift 1.2.3+4" (4 master commits later),
            // "Rift 0.0.0" (dev).
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_title(&format!("Rift {}", app.package_info().version));
            }

            let ptys = PtyManager::new(
                Shell::default_for_platform(),
                home,
                vec![("RIFT_PIPE".into(), pipe)],
            );
            ptys.prewarm(None);
            app.manage(ptys);
            Ok(())
        })
        // Frozen when the window is really gone, not when closing is requested: the frontend may still
        // cancel (agents working). After this the shells die, and their exit must not erase the session.
        .on_window_event(|window, event| {
            if let WindowEvent::Destroyed = event {
                window.state::<SessionStore>().freeze();
            }
        })
        .invoke_handler(tauri::generate_handler![
            pty_open,
            pty_write,
            pty_resize,
            pty_close,
            pty_prewarm,
            shell_profiles,
            shell_set_default,
            session_restore,
            session_update,
            session_freeze,
            scrollback_save,
            scrollback_load,
            scrollback_prune,
            agent_integrations,
            agent_install,
            fs_list,
            fs_open,
            fs_read_text,
            fs_write_text,
            fs_mtime,
            fs_reveal,
            fs_trash,
            git_head,
            git_status,
            git_diff,
            git_branches,
            git_switch,
            git_create_branch,
            git_push,
            git_pull,
            git_log,
            git_commit_files,
            git_commit_diff,
            git_commit,
            git_discard,
            git_worktree_add,
            git_stats,
            open_url,
            settings_load,
            startup_dir,
            explorer_menu_installed,
            explorer_menu_set,
            settings_save,
            prompts_load,
            prompts_save,
            commit_message,
            bench_dirs,
            bench_output_file,
            bench_done
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
