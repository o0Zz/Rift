//! Running a program from the GUI: no console window, stdin written while both outputs are read (a big payload
//! never deadlocks), killed with what it started when it does not finish in time.

use std::ffi::OsStr;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Output, Stdio};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};

/// A command that opens no console window.
pub fn command(program: impl AsRef<OsStr>) -> Command {
    #[allow(unused_mut)]
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: no console flashing from the GUI app
    }
    cmd
}

/// Finds `name` on PATH. On Windows npm installs agents as `.cmd` shims, which `Command` does not look for.
pub fn find_program(name: &str) -> PathBuf {
    if cfg!(windows)
        && let Some(paths) = std::env::var_os("PATH")
    {
        for dir in std::env::split_paths(&paths) {
            for ext in ["exe", "cmd", "bat"] {
                let candidate = dir.join(format!("{name}.{ext}"));
                if candidate.is_file() {
                    return candidate;
                }
            }
        }
    }
    PathBuf::from(name)
}

/// Runs `cmd` with `input` on stdin and returns its output; after `timeout` it is killed and this fails.
/// `what` names the program in errors.
pub fn output(mut cmd: Command, input: &[u8], timeout: Duration, what: &str) -> Result<Output> {
    let mut child = cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| format!("could not run `{what}` (is it installed and on PATH?)"))?;
    let mut stdin = child.stdin.take().unwrap();
    let input = input.to_vec();
    let writer = std::thread::spawn(move || stdin.write_all(&input)); // dropped after: the program sees EOF
    fn read_all(mut r: impl Read + Send + 'static) -> std::thread::JoinHandle<Vec<u8>> {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = r.read_to_end(&mut buf);
            buf
        })
    }
    let stdout = read_all(child.stdout.take().unwrap());
    let stderr = read_all(child.stderr.take().unwrap());
    let deadline = Instant::now() + timeout;
    // Short waits first: most runs (git status, diff) end within milliseconds.
    let mut wait = Duration::from_millis(1);
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if Instant::now() >= deadline {
            kill_tree(&mut child);
            bail!(
                "{what} did not answer in {} s (waiting for a login or an approval?)",
                timeout.as_secs()
            );
        }
        std::thread::sleep(wait);
        wait = (wait * 2).min(Duration::from_millis(50));
    };
    let _ = writer.join();
    Ok(Output {
        status,
        stdout: stdout.join().unwrap_or_default(),
        stderr: stderr.join().unwrap_or_default(),
    })
}

/// What a failed program said: its stderr, else its stdout (some report errors there), trimmed.
pub fn failure_text(out: &Output) -> String {
    let err = String::from_utf8_lossy(&out.stderr);
    let text = if err.trim().is_empty() {
        String::from_utf8_lossy(&out.stdout)
    } else {
        err
    };
    text.trim().to_string()
}

/// Kills `child` and, on Windows, what it started (`taskkill /T`): killing an npm `.cmd` shim alone leaves
/// its node process running.
fn kill_tree(child: &mut Child) {
    #[cfg(windows)]
    let _ = command("taskkill")
        .args(["/T", "/F", "/PID", &child.id().to_string()])
        .output();
    let _ = child.kill();
    let _ = child.wait();
}
