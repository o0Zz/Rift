//! PTY sessions, one per tab. Knows nothing about Tauri so it can be tested against real shells.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

use anyhow::{Context, Result};
use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};

pub type TabId = u32;
pub type OnData = Box<dyn FnMut(Vec<u8>) + Send>;
pub type OnExit = Box<dyn FnOnce(TabId) + Send>;

#[derive(Clone, Debug)]
pub struct Shell {
    pub program: String,
    pub args: Vec<String>,
}

impl Shell {
    /// PowerShell 7 if installed, Windows PowerShell otherwise.
    pub fn default_for_platform() -> Self {
        let pwsh = std::env::var_os("PATH")
            .map(|p| std::env::split_paths(&p).any(|dir| dir.join("pwsh.exe").is_file()))
            .unwrap_or(false);
        Shell {
            program: if pwsh { "pwsh.exe" } else { "powershell.exe" }.into(),
            args: vec!["-NoLogo".into()],
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
    next_id: AtomicU32,
    sessions: Mutex<HashMap<TabId, Session>>,
    /// A shell started ahead of time so a new tab does not wait for shell startup.
    spare: Mutex<Option<TabId>>,
}

impl PtyManager {
    pub fn new(shell: Shell, home: PathBuf) -> Arc<Self> {
        Arc::new(PtyManager {
            shell,
            home,
            next_id: AtomicU32::new(1),
            sessions: Mutex::new(HashMap::new()),
            spare: Mutex::new(None),
        })
    }

    /// Start a spare shell in the background, unless one is already waiting.
    pub fn prewarm(self: &Arc<Self>) {
        let me = self.clone();
        thread::spawn(move || {
            let Ok(id) = me.spawn(&me.home) else { return };
            let mut spare = me.spare.lock().unwrap();
            if spare.is_none() {
                *spare = Some(id);
            } else {
                drop(spare);
                me.close(id);
            }
        });
    }

    /// Open a tab's shell. `cwd = None` means the home directory and takes the spare shell.
    pub fn open(
        self: &Arc<Self>,
        cwd: Option<PathBuf>,
        size: PtySize,
        on_data: OnData,
        on_exit: OnExit,
    ) -> Result<TabId> {
        let spare = if cwd.is_none() {
            self.spare.lock().unwrap().take()
        } else {
            None
        };
        let id = match spare {
            Some(id) => id,
            None => self.spawn(cwd.as_deref().unwrap_or(&self.home))?,
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

    fn spawn(&self, cwd: &Path) -> Result<TabId> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let pair = native_pty_system().openpty(PtySize {
            rows: 24,
            cols: 80,
            ..Default::default()
        })?;

        let mut cmd = CommandBuilder::new(&self.shell.program);
        cmd.args(&self.shell.args);
        cmd.cwd(cwd);
        cmd.env("RIFT_TAB_ID", id.to_string());
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
        let shell = Shell {
            program: "cmd.exe".into(),
            args: vec!["/Q".into()],
        };
        PtyManager::new(shell, std::env::temp_dir())
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
    ) -> (TabId, mpsc::Receiver<Vec<u8>>, mpsc::Receiver<TabId>) {
        let (data_tx, data_rx) = mpsc::channel();
        let (exit_tx, exit_rx) = mpsc::channel();
        let id = m
            .open(
                cwd,
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
        let (id, out, _) = open(&m, Some(std::env::temp_dir()));
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

        let (id, out, _) = open(&m, None);
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
        let (id, _out, exit) = open(&m, Some(std::env::temp_dir()));
        m.write(id, b"exit\r\n").unwrap();
        assert_eq!(exit.recv_timeout(Duration::from_secs(10)).unwrap(), id);
        m.close(id);
    }

    #[test]
    fn close_removes_tab() {
        let m = cmd_manager();
        let (id, _out, _) = open(&m, Some(std::env::temp_dir()));
        m.close(id);
        assert!(m.write(id, b"x").is_err());
    }
}
