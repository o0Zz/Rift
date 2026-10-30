mod pty;

use std::sync::Arc;

use portable_pty::PtySize;
use pty::{PtyManager, Shell, TabId};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Manager, State};

type Ptys<'a> = State<'a, Arc<PtyManager>>;

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        cols,
        rows,
        ..Default::default()
    }
}

/// Opens a shell for a new tab. Output is streamed as raw bytes on `on_data`; exit is the `pty-exit` event.
#[tauri::command]
fn pty_open(
    app: AppHandle,
    ptys: Ptys,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    on_data: Channel<InvokeResponseBody>,
) -> Result<TabId, String> {
    ptys.open(
        cwd.map(Into::into),
        size(cols, rows),
        Box::new(move |bytes| {
            let _ = on_data.send(InvokeResponseBody::Raw(bytes));
        }),
        Box::new(move |id| {
            let _ = app.emit("pty-exit", id);
        }),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn pty_write(ptys: Ptys, id: TabId, data: String) -> Result<(), String> {
    ptys.write(id, data.as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command]
fn pty_resize(ptys: Ptys, id: TabId, cols: u16, rows: u16) -> Result<(), String> {
    ptys.resize(id, size(cols, rows)).map_err(|e| e.to_string())
}

#[tauri::command]
fn pty_close(ptys: Ptys, id: TabId) {
    ptys.close(id);
}

#[tauri::command]
fn bench_enabled() -> bool {
    std::env::var_os("RIFT_BENCH").is_some()
}

#[tauri::command]
fn bench_done(app: AppHandle, report: String, ok: bool) {
    println!("{report}");
    app.exit(if ok { 0 } else { 1 });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let home = app.path().home_dir()?;
            let ptys = PtyManager::new(Shell::default_for_platform(), home);
            ptys.prewarm();
            app.manage(ptys);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pty_open,
            pty_write,
            pty_resize,
            pty_close,
            bench_enabled,
            bench_done
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
