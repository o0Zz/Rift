//! PTY sessions, one per tab. Knows nothing about Tauri so it can be tested against real shells.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

use anyhow::{Context, Result};
use base64::Engine;
use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};

pub type TabId = u32;
pub type OnData = Box<dyn FnMut(Vec<u8>) + Send>;
pub type OnExit = Box<dyn FnOnce(TabId) + Send>;

/// Runs after the user's profile: wraps their prompt so every prompt reports the cwd (OSC 9;9).
const PWSH_INIT: &str = r#"
$global:__riftPrompt = $function:prompt
function global:prompt {
  $loc = $executionContext.SessionState.Path.CurrentLocation
  $p = & $global:__riftPrompt
  if ($loc.Provider.Name -eq 'FileSystem') { "$([char]27)]9;9;`"$($loc.ProviderPath)`"$([char]27)\$p" } else { $p }
}
"#;

#[derive(Clone, Debug)]
pub enum Shell {
    PowerShell {
        exe: String,
    },
    /// Deterministic shell for tests.
    #[cfg(test)]
    Cmd,
}

impl Shell {
    /// PowerShell 7 if installed, Windows PowerShell otherwise.
    pub fn default_for_platform() -> Self {
        let pwsh = std::env::var_os("PATH")
            .map(|p| std::env::split_paths(&p).any(|dir| dir.join("pwsh.exe").is_file()))
            .unwrap_or(false);
        Shell::PowerShell {
            exe: if pwsh { "pwsh.exe" } else { "powershell.exe" }.into(),
        }
    }

    /// The shell command line, running `startup` (e.g. `claude --resume <id>`) once the shell is ready.
    fn command(&self, startup: Option<&str>) -> CommandBuilder {
        match self {
            Shell::PowerShell { exe } => {
                let script = format!("{PWSH_INIT}\n{}", startup.unwrap_or(""));
                let utf16: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
                let mut cmd = CommandBuilder::new(exe);
                cmd.args(["-NoLogo", "-NoExit", "-EncodedCommand"]);
                cmd.arg(base64::engine::general_purpose::STANDARD.encode(utf16));
                cmd
            }
            #[cfg(test)]
            Shell::Cmd => {
                let mut cmd = CommandBuilder::new("cmd.exe");
                cmd.arg("/Q");
                if let Some(s) = startup {
                    cmd.args(["/K", s]);
                }
                cmd
            }
        }
    }
}

/// Where a session's output goes. A spare shell runs before any tab owns it,
/// so its output (the prompt) is buffered and replayed on attach.
enum Sink {
    Buffer {
        data: Vec<u8>,
        exited: bool,
    },
    Attached {
        on_data: OnData,
        on_exit: Option<OnExit>,
    },
}

impl Sink {
    fn data(&mut self, bytes: Vec<u8>) {
        match self {
            Sink::Buffer { data, .. } => data.extend(bytes),
            Sink::Attached { on_data, .. } => on_data(bytes),
        }
    }

    fn exit(&mut self, id: TabId) {
        match self {
            Sink::Buffer { exited, .. } => *exited = true,
            Sink::Attached { on_exit, .. } => {
                if let Some(f) = on_exit.take() {
                    f(id)
                }
            }
        }
    }
}

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    sink: Arc<Mutex<Sink>>,
}

pub struct PtyManager {
    shell: Shell,
    home: PathBuf,
    /// Extra environment for every shell (e.g. the hook pipe name).
    env: Vec<(String, String)>,
    next_id: AtomicU32,
    sessions: Mutex<HashMap<TabId, Session>>,
    /// A shell started ahead of time so a new tab does not wait for shell startup.
    spare: Mutex<Option<TabId>>,
}

impl PtyManager {
    pub fn new(shell: Shell, home: PathBuf, env: Vec<(String, String)>) -> Arc<Self> {
        Arc::new(PtyManager {
            shell,
            home,
            env,
            next_id: AtomicU32::new(1),
            sessions: Mutex::new(HashMap::new()),
            spare: Mutex::new(None),
        })
    }

    /// Start a spare shell in the background, unless one is already waiting.
    pub fn prewarm(self: &Arc<Self>) {
        let me = self.clone();
        thread::spawn(move || {
            let Ok(id) = me.spawn(&me.home, None) else {
                return;
            };
            let mut spare = me.spare.lock().unwrap();
            if spare.is_none() {
                *spare = Some(id);
            } else {
                drop(spare);
                me.close(id);
            }
        });
    }

    /// Open a tab's shell. Without `cwd` (= home) and `startup`, it takes the spare shell.
    pub fn open(
        self: &Arc<Self>,
        cwd: Option<PathBuf>,
        startup: Option<&str>,
        size: PtySize,
        on_data: OnData,
        on_exit: OnExit,
    ) -> Result<TabId> {
        let spare = if cwd.is_none() && startup.is_none() {
            self.spare.lock().unwrap().take()
        } else {
            None
        };
        let id = match spare {
            Some(id) => id,
            None => self.spawn(cwd.as_deref().unwrap_or(&self.home), startup)?,
        };
        self.resize(id, size)?;
        self.attach(id, on_data, on_exit)?;
        self.prewarm();
        Ok(id)
    }

    pub fn write(&self, id: TabId, data: &[u8]) -> Result<()> {
        let mut sessions = self.sessions.lock().unwrap();
        let s = sessions.get_mut(&id).context("unknown tab")?;
        s.writer.write_all(data)?;
        s.writer.flush()?;
        Ok(())
    }

    pub fn resize(&self, id: TabId, size: PtySize) -> Result<()> {
        let sessions = self.sessions.lock().unwrap();
        sessions
            .get(&id)
            .context("unknown tab")?
            .master
            .resize(size)
    }

    pub fn close(&self, id: TabId) {
        let session = self.sessions.lock().unwrap().remove(&id);
        if let Some(mut s) = session {
            let _ = s.killer.kill();
            // Dropping the master closes the pseudo console, which ends the reader thread.
        }
    }

    /// Closes every tab's shell (not the spare). For a freshly loaded frontend, which owns none of them.
    pub fn close_all_tabs(&self) {
        let spare = *self.spare.lock().unwrap();
        let ids: Vec<TabId> = self
            .sessions
            .lock()
            .unwrap()
            .keys()
            .copied()
            .filter(|id| Some(*id) != spare)
            .collect();
        for id in ids {
            self.close(id);
        }
    }

    fn attach(&self, id: TabId, mut on_data: OnData, on_exit: OnExit) -> Result<()> {
        let sink = self
            .sessions
            .lock()
            .unwrap()
            .get(&id)
            .context("unknown tab")?
            .sink
            .clone();
        let mut sink = sink.lock().unwrap();
        let Sink::Buffer { data, exited } = std::mem::replace(
            &mut *sink,
            Sink::Attached {
                on_data: Box::new(|_| {}),
                on_exit: None,
            },
        ) else {
            anyhow::bail!("tab already attached");
        };
        if !data.is_empty() {
            on_data(data);
        }
        *sink = Sink::Attached {
            on_data,
            on_exit: Some(on_exit),
        };
        if exited {
            sink.exit(id);
        }
        Ok(())
    }

    fn spawn(&self, cwd: &Path, startup: Option<&str>) -> Result<TabId> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let pair = native_pty_system().openpty(PtySize {
            rows: 24,
            cols: 80,
            ..Default::default()
        })?;

        let mut cmd = self.shell.command(startup);
        cmd.cwd(cwd);
        cmd.env("RIFT_TAB_ID", id.to_string());
        for (k, v) in &self.env {
            cmd.env(k, v);
        }
        let mut child = pair.slave.spawn_command(cmd)?;
        drop(pair.slave);

        let killer = child.clone_killer();
        let mut reader = pair.master.try_clone_reader()?;
        let writer = pair.master.take_writer()?;
        let sink = Arc::new(Mutex::new(Sink::Buffer {
            data: Vec::new(),
            exited: false,
        }));

        let out = sink.clone();
        thread::spawn(move || {
            let mut buf = vec![0u8; 64 * 1024];
            while let Ok(n @ 1..) = reader.read(&mut buf) {
                out.lock().unwrap().data(buf[..n].to_vec());
            }
        });
        // ConPTY keeps the output pipe open after the shell exits, so exit is detected by waiting on the child.
        let exit = sink.clone();
        thread::spawn(move || {
            let _ = child.wait();
            exit.lock().unwrap().exit(id);
        });

        self.sessions.lock().unwrap().insert(
            id,
            Session {
                master: pair.master,
                writer,
                killer,
                sink,
            },
        );
        Ok(id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    fn cmd_manager() -> Arc<PtyManager> {
        PtyManager::new(Shell::Cmd, std::env::temp_dir(), vec![])
    }

    fn size() -> PtySize {
        PtySize {
            rows: 30,
            cols: 100,
            ..Default::default()
        }
    }

    /// Opens a tab and returns its id plus receivers for its output and exit.
    fn open(
        m: &Arc<PtyManager>,
        cwd: Option<PathBuf>,
        startup: Option<&str>,
    ) -> (TabId, mpsc::Receiver<Vec<u8>>, mpsc::Receiver<TabId>) {
        let (data_tx, data_rx) = mpsc::channel();
        let (exit_tx, exit_rx) = mpsc::channel();
        let id = m
            .open(
                cwd,
                startup,
                size(),
                Box::new(move |b| {
                    let _ = data_tx.send(b);
                }),
                Box::new(move |id| {
                    let _ = exit_tx.send(id);
                }),
            )
            .unwrap();
        // ConPTY asks for the cursor position (ESC[6n) on startup and waits; xterm.js answers it in the app.
        m.write(id, b"\x1b[1;1R").unwrap();
        (id, data_rx, exit_rx)
    }

    fn wait_for_output(rx: &mpsc::Receiver<Vec<u8>>, needle: &str) -> String {
        let deadline = Instant::now() + Duration::from_secs(15);
        let mut all = Vec::new();
        while Instant::now() < deadline {
            if let Ok(chunk) = rx.recv_timeout(Duration::from_millis(100)) {
                all.extend(chunk);
                if String::from_utf8_lossy(&all).contains(needle) {
                    return String::from_utf8_lossy(&all).into();
                }
            }
        }
        panic!(
            "never saw {needle:?}, got: {}",
            String::from_utf8_lossy(&all)
        );
    }

    fn wait_for_spare(m: &PtyManager) -> TabId {
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if let Some(id) = *m.spare.lock().unwrap() {
                return id;
            }
            thread::sleep(Duration::from_millis(20));
        }
        panic!("spare shell never started");
    }

    #[test]
    fn runs_commands_and_sees_tab_id() {
        let m = cmd_manager();
        let (id, out, _) = open(&m, Some(std::env::temp_dir()), None);
        m.write(id, b"echo rift-%RIFT_TAB_ID%-ok\r\n").unwrap();
        wait_for_output(&out, &format!("rift-{id}-ok"));
        m.close(id);
    }

    #[test]
    fn new_tab_takes_prewarmed_shell_and_replays_its_output() {
        let m = cmd_manager();
        m.prewarm();
        let spare = wait_for_spare(&m);
        // Let the spare print its prompt into the buffer before anyone attaches.
        thread::sleep(Duration::from_millis(500));

        let (id, out, _) = open(&m, None, None);
        assert_eq!(id, spare);
        wait_for_output(&out, ">"); // buffered prompt is replayed
        m.write(id, b"echo still-alive\r\n").unwrap();
        wait_for_output(&out, "still-alive");

        // Opening refills the spare.
        assert_ne!(wait_for_spare(&m), id);
        m.close(id);
    }

    #[test]
    fn reports_exit_when_shell_exits() {
        let m = cmd_manager();
        let (id, _out, exit) = open(&m, Some(std::env::temp_dir()), None);
        m.write(id, b"exit\r\n").unwrap();
        assert_eq!(exit.recv_timeout(Duration::from_secs(10)).unwrap(), id);
        m.close(id);
    }

    #[test]
    fn startup_command_runs_in_new_shell() {
        let m = cmd_manager();
        let (id, out, _) = open(&m, Some(std::env::temp_dir()), Some("echo rift-startup-ok"));
        wait_for_output(&out, "rift-startup-ok");
        m.close(id);
    }

    #[test]
    fn powershell_reports_cwd_and_runs_startup() {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().canonicalize().unwrap();
        let cwd = cwd.to_string_lossy().trim_start_matches(r"\?\").to_string();
        let m = PtyManager::new(Shell::default_for_platform(), std::env::temp_dir(), vec![]);
        let (id, out, _) = open(
            &m,
            Some(cwd.clone().into()),
            Some("Write-Output rift-pwsh-ok"),
        );
        wait_for_output(&out, "rift-pwsh-ok");
        wait_for_output(&out, &format!("\x1b]9;9;\"{cwd}\""));
        m.close(id);
    }

    #[test]
    fn close_all_tabs_keeps_the_spare() {
        let m = cmd_manager();
        let (a, _, _) = open(&m, Some(std::env::temp_dir()), None);
        let (b, _, _) = open(&m, Some(std::env::temp_dir()), None);
        let spare = wait_for_spare(&m);
        m.close_all_tabs();
        assert!(m.write(a, b"x").is_err());
        assert!(m.write(b, b"x").is_err());
        assert!(
            m.write(
                spare, b"rem
"
            )
            .is_ok()
        );
        m.close(spare);
    }

    #[test]
    fn close_removes_tab() {
        let m = cmd_manager();
        let (id, _out, _) = open(&m, Some(std::env::temp_dir()), None);
        m.close(id);
        assert!(m.write(id, b"x").is_err());
    }
}
