mod agents;
mod explorer_menu;
mod files;
mod git;
pub mod hook;
mod pty;
mod session;
mod settings;

use std::sync::Arc;

use agents::{AgentEvent, AgentSession, Harnesses, claude::Claude};
use portable_pty::PtySize;
use pty::{PtyManager, Shell, TabId};
use serde::Serialize;
use session::{Saved, SessionStore, TabInfo};
use settings::SettingsFile;
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
#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri injects state/app params
fn pty_open(
    app: AppHandle,
    ptys: Ptys,
    harnesses: State<Harnesses>,
    session: State<SessionStore>,
    cwd: Option<String>,
    agent: Option<AgentSession>,
    cols: u16,
    rows: u16,
    on_data: Channel<InvokeResponseBody>,
) -> Result<TabId, String> {
    let startup = agent
        .as_ref()
        .and_then(|a| harnesses.get(&a.harness)?.resume_command(&a.session_id));
    let id = ptys
        .open(
            cwd.map(Into::into),
            startup.as_deref(),
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

#[tauri::command]
fn pty_close(ptys: Ptys, id: TabId) {
    ptys.close(id);
}

/// Tabs saved by the previous run. Called once per page load: shells left over from a previous
/// page (dev reload, WebView reload) have no tab anymore and are closed.
#[tauri::command]
fn session_restore(session: State<SessionStore>, ptys: Ptys) -> Saved {
    ptys.close_all_tabs();
    session.load()
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

#[derive(Serialize)]
struct Integration {
    id: &'static str,
    name: &'static str,
    installed: bool,
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
            installed: h.hooks_installed(&exe),
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

#[tauri::command]
async fn fs_reveal(path: String) -> Result<(), String> {
    tauri_plugin_opener::reveal_item_in_dir(path).map_err(err)
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

/// The user's own convention for commit messages (see their CLAUDE.md).
const COMMIT_PROMPT: &str = "Write a git commit message for the diff on stdin. \
One short subject line in the imperative mood (max 72 characters), optionally a blank line and a brief body. \
No co-author or sign-off lines. Output only the message, without quotes or code fences.";

/// AI commit message for the selected files, written by the first agent harness (Claude today).
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
    let agent = harnesses.0.first().ok_or("no agent configured")?;
    agent
        .one_shot(root.as_ref(), COMMIT_PROMPT, &diff)
        .map_err(err)
}

#[tauri::command]
async fn git_diff(root: String, path: String, untracked: bool) -> Result<String, String> {
    git::diff(root.as_ref(), &path, untracked).map_err(err)
}

#[tauri::command]
fn settings_load(settings: State<SettingsFile>) -> serde_json::Value {
    settings.load()
}

#[tauri::command]
fn settings_save(settings: State<SettingsFile>, value: serde_json::Value) -> Result<(), String> {
    settings.save(&value).map_err(err)
}

/// Folder Rift was launched with (`rift.exe <dir>`, e.g. from Explorer's "Open in Rift"), opened as a new tab.
#[tauri::command]
fn startup_dir() -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    let cwd = std::env::current_dir().ok()?;
    explorer_menu::dir_arg(&args, &cwd).map(|d| d.display().to_string())
}

#[tauri::command]
fn explorer_menu_installed() -> Result<bool, String> {
    let exe = std::env::current_exe().map_err(err)?;
    Ok(explorer_menu::ExplorerMenu::default().installed(&exe))
}

/// Adds or removes "Open in Rift" in Explorer's right-click menu. Only from the user's click in settings.
#[tauri::command]
fn explorer_menu_set(enabled: bool) -> Result<(), String> {
    let menu = explorer_menu::ExplorerMenu::default();
    if enabled {
        menu.install(&std::env::current_exe().map_err(err)?)
            .map_err(err)
    } else {
        menu.uninstall().map_err(err)
    }
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

#[tauri::command]
fn bench_done(app: AppHandle, report: String, ok: bool) {
    println!("{report}");
    app.exit(if ok { 0 } else { 1 });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();
    // Single instance: a second `rift.exe <dir>` (Explorer menu) opens a tab in this window instead.
    // Not in bench mode, where the bench app must run next to a dev instance.
    if !bench_mode() {
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

            // The bench must neither restore nor overwrite the user's tabs.
            let session_path = if bench_mode() {
                std::env::temp_dir().join("rift-bench-session.json")
            } else {
                app.path().app_data_dir()?.join("session.json")
            };
            let _ = bench_mode() && std::fs::remove_file(&session_path).is_ok();
            app.manage(SessionStore::new(session_path));
            // The bench runs with default settings, never the user's.
            app.manage(SettingsFile(if bench_mode() {
                std::env::temp_dir().join("rift-bench-settings.json")
            } else {
                app.path().app_data_dir()?.join("settings.json")
            }));
            app.manage(Harnesses(vec![Box::new(Claude {
                settings: home.join(".claude").join("settings.json"),
            })]));

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(hook::serve(pipe.clone(), move |msg| {
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

            let ptys = PtyManager::new(
                Shell::default_for_platform(),
                home,
                vec![("RIFT_PIPE".into(), pipe)],
            );
            ptys.prewarm();
            app.manage(ptys);
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { .. } = event {
                window.state::<SessionStore>().freeze();
            }
        })
        .invoke_handler(tauri::generate_handler![
            pty_open,
            pty_write,
            pty_resize,
            pty_close,
            session_restore,
            session_update,
            session_freeze,
            agent_integrations,
            agent_install,
            fs_list,
            fs_open,
            fs_reveal,
            git_head,
            git_status,
            git_diff,
            git_commit,
            settings_load,
            startup_dir,
            explorer_menu_installed,
            explorer_menu_set,
            settings_save,
            commit_message,
            bench_dirs,
            bench_done
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
