//! PTY sessions, one per tab. Knows nothing about Tauri so it can be tested against real shells.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

use anyhow::{Context, Result};
use portable_pty::{ChildKiller, MasterPty, PtySize, native_pty_system};

pub use crate::shell::Shell;

pub type TabId = u32;
pub type OnData = Box<dyn FnMut(Vec<u8>) + Send>;
pub type OnExit = Box<dyn FnOnce(TabId) + Send>;

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
    /// A shell started ahead of time in a folder (the active tab's), so a new tab there does not wait
    /// for shell startup.
    spare: Mutex<Option<(PathBuf, TabId)>>,
}

/// Same folder, ignoring a trailing separator; case-insensitive on Windows only (Linux paths are not).
fn same_dir(a: &Path, b: &Path) -> bool {
    let norm = |p: &Path| {
        let s = p.to_string_lossy();
        let s = s.trim_end_matches(['\\', '/']);
        if cfg!(windows) {
            s.to_lowercase()
        } else {
            s.to_string()
        }
    };
    norm(a) == norm(b)
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

    /// Start a spare shell in `dir` (home if `None`) in the background, replacing a spare waiting in
    /// another folder. Nothing to do if one already waits there.
    pub fn prewarm(self: &Arc<Self>, dir: Option<PathBuf>) {
        let dir = dir.unwrap_or_else(|| self.home.clone());
        if self
            .spare
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|(d, _)| same_dir(d, &dir))
        {
            return;
        }
        let me = self.clone();
        thread::spawn(move || {
            let Ok(id) = me.spawn(&dir, None) else {
                return;
            };
            let replaced = me.spare.lock().unwrap().replace((dir, id));
            if let Some((_, old)) = replaced {
                me.close(old);
            }
        });
    }

    /// Open a tab's shell in `cwd` (home if `None`). Takes the spare shell if it waits in that folder
    /// and there is no startup command. Refilling the spare is the caller's call (`prewarm`).
    pub fn open(
        self: &Arc<Self>,
        cwd: Option<PathBuf>,
        startup: Option<&str>,
        size: PtySize,
        on_data: OnData,
        on_exit: OnExit,
    ) -> Result<TabId> {
        let dir = cwd.unwrap_or_else(|| self.home.clone());
        let spare = if startup.is_none() {
            let mut spare = self.spare.lock().unwrap();
            match spare.as_ref() {
                Some((d, _)) if same_dir(d, &dir) => spare.take().map(|(_, id)| id),
                _ => None,
            }
        } else {
            None
        };
        let id = match spare {
            Some(id) => id,
            None => self.spawn(&dir, startup)?,
        };
        self.resize(id, size)?;
        self.attach(id, on_data, on_exit)?;
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
        let spare = self.spare.lock().unwrap().as_ref().map(|(_, id)| *id);
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

    // A small deterministic shell per OS: cmd on Windows, sh elsewhere.
    #[cfg(windows)]
    mod os {
        pub const ENTER: &str = "\r\n";
        pub const PROMPT: &str = ">";
        pub const PRINT_TAB_ID: &str = "echo rift-%RIFT_TAB_ID%-ok";
        pub const PRINT_CWD: &str = "cd";
        pub fn shell() -> super::Shell {
            super::Shell::Cmd
        }
    }

    #[cfg(unix)]
    mod os {
        pub const ENTER: &str = "\r";
        pub const PROMPT: &str = "$";
        pub const PRINT_TAB_ID: &str = "echo rift-$RIFT_TAB_ID-ok";
        pub const PRINT_CWD: &str = "pwd";
        pub fn shell() -> super::Shell {
            super::Shell::Posix {
                exe: "/bin/sh".into(),
            }
        }
    }

    fn run(m: &PtyManager, id: TabId, command: &str) {
        m.write(id, format!("{command}{}", os::ENTER).as_bytes())
            .unwrap();
    }

    fn test_manager() -> Arc<PtyManager> {
        PtyManager::new(os::shell(), std::env::temp_dir(), vec![])
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
        #[cfg(windows)]
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
            if let Some((_, id)) = *m.spare.lock().unwrap() {
                return id;
            }
            thread::sleep(Duration::from_millis(20));
        }
        panic!("spare shell never started");
    }

    #[test]
    fn runs_commands_and_sees_tab_id() {
        let m = test_manager();
        let (id, out, _) = open(&m, Some(std::env::temp_dir()), None);
        run(&m, id, os::PRINT_TAB_ID);
        wait_for_output(&out, &format!("rift-{id}-ok"));
        m.close(id);
    }

    #[test]
    fn new_tab_takes_prewarmed_shell_and_replays_its_output() {
        let m = test_manager();
        m.prewarm(None);
        let spare = wait_for_spare(&m);
        // Let the spare print its prompt into the buffer before anyone attaches.
        thread::sleep(Duration::from_millis(500));

        let (id, out, _) = open(&m, None, None);
        assert_eq!(id, spare);
        wait_for_output(&out, os::PROMPT); // buffered prompt is replayed
        run(&m, id, "echo still-alive");
        wait_for_output(&out, "still-alive");

        assert!(m.spare.lock().unwrap().is_none(), "the spare was used");
        m.close(id);
    }

    #[test]
    fn spare_is_only_used_in_its_own_folder() {
        let m = test_manager();
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        m.prewarm(Some(a.path().into()));
        let spare = wait_for_spare(&m);

        let (in_b, _, _) = open(&m, Some(b.path().into()), None);
        assert_ne!(in_b, spare, "another folder spawns its own shell");
        // Same folder, other spelling (trailing separator; case too on Windows): takes the spare.
        let other_spelling = format!("{}{}", a.path().display(), std::path::MAIN_SEPARATOR);
        #[cfg(windows)]
        let other_spelling = other_spelling.to_uppercase();
        let (in_a, out, _) = open(&m, Some(other_spelling.into()), None);
        assert_eq!(in_a, spare);
        run(&m, in_a, os::PRINT_CWD);
        wait_for_output(&out, &a.path().file_name().unwrap().to_string_lossy());
        m.close(in_a);
        m.close(in_b);
    }

    #[test]
    fn prewarm_keeps_a_spare_in_the_same_folder_and_replaces_another() {
        let m = test_manager();
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        m.prewarm(Some(a.path().into()));
        let first = wait_for_spare(&m);
        m.prewarm(Some(a.path().into()));
        thread::sleep(Duration::from_millis(300));
        assert_eq!(wait_for_spare(&m), first, "same folder: no new shell");

        m.prewarm(Some(b.path().into()));
        let deadline = Instant::now() + Duration::from_secs(10);
        while wait_for_spare(&m) == first && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(20));
        }
        let second = wait_for_spare(&m);
        assert_ne!(second, first);
        assert!(
            m.write(first, b"x").is_err(),
            "the replaced spare is closed"
        );
        m.close(second);
    }

    #[test]
    fn reports_exit_when_shell_exits() {
        let m = test_manager();
        let (id, _out, exit) = open(&m, Some(std::env::temp_dir()), None);
        run(&m, id, "exit");
        assert_eq!(exit.recv_timeout(Duration::from_secs(10)).unwrap(), id);
        m.close(id);
    }

    #[test]
    fn startup_command_runs_in_new_shell() {
        let m = test_manager();
        let (id, out, _) = open(&m, Some(std::env::temp_dir()), Some("echo rift-startup-ok"));
        wait_for_output(&out, "rift-startup-ok");
        m.close(id);
    }

    #[cfg(windows)]
    #[test]
    fn powershell_reports_cwd_and_runs_startup() {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().canonicalize().unwrap();
        let cwd = cwd
            .to_string_lossy()
            .trim_start_matches(r"\\?\")
            .to_string();
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
        let m = test_manager();
        let (a, _, _) = open(&m, Some(std::env::temp_dir()), None);
        let (b, _, _) = open(&m, Some(std::env::temp_dir()), None);
        m.prewarm(None);
        let spare = wait_for_spare(&m);
        m.close_all_tabs();
        assert!(m.write(a, b"x").is_err());
        assert!(m.write(b, b"x").is_err());
        assert!(m.write(spare, os::ENTER.as_bytes()).is_ok());
        m.close(spare);
    }

    /// bash/zsh integration: the user's config still loads, the startup command runs, and each prompt
    /// reports the cwd as OSC 7.
    #[cfg(unix)]
    fn check_posix_integration(exe: &str) {
        let dir = tempfile::tempdir().unwrap();
        let m = PtyManager::new(
            Shell::Posix { exe: exe.into() },
            std::env::temp_dir(),
            vec![],
        );
        let (id, out, _) = open(&m, Some(dir.path().into()), Some("echo rift-startup-ok"));
        wait_for_output(&out, "rift-startup-ok");
        // macOS temp dirs may be reported through /private: check the folder name.
        let name = dir
            .path()
            .file_name()
            .unwrap()
            .to_string_lossy()
            .to_string();
        let all = wait_for_output(&out, &name);
        assert!(all.contains("\x1b]7;file://"), "no OSC 7 in: {all}");
        m.close(id);
    }

    #[cfg(unix)]
    #[test]
    fn bash_reports_cwd_and_runs_startup() {
        check_posix_integration("/bin/bash");
    }

    #[cfg(unix)]
    #[test]
    fn zsh_reports_cwd_and_runs_startup() {
        // zsh ships with macOS; Linux CI images may not have it.
        if std::path::Path::new("/bin/zsh").exists() {
            check_posix_integration("/bin/zsh");
        }
    }

    #[test]
    fn close_removes_tab() {
        let m = test_manager();
        let (id, _out, _) = open(&m, Some(std::env::temp_dir()), None);
        m.close(id);
        assert!(m.write(id, b"x").is_err());
    }
}
