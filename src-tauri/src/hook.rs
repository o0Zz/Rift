//! Agent hooks → app. The agent runs `rift hook <harness>` with the hook JSON on stdin; that process
//! forwards it, tagged with the tab id, to the Rift instance named in RIFT_PIPE: a named pipe on Windows,
//! a Unix socket elsewhere. One message per connection, handled in arrival order.

use std::io::{Read, Write};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::AsyncReadExt;

use crate::pty::TabId;

#[derive(Debug, Serialize, Deserialize)]
pub struct HookMessage {
    pub tab: TabId,
    pub harness: String,
    pub payload: Value,
}

/// Entry point of `rift hook <harness>`. Never fails loudly: a broken hook must not disturb the agent.
pub fn run_client(harness: &str) {
    let (Ok(tab), Ok(pipe)) = (std::env::var("RIFT_TAB_ID"), std::env::var("RIFT_PIPE")) else {
        return; // agent not running inside Rift
    };
    let mut stdin = String::new();
    let _ = std::io::stdin().take(1 << 20).read_to_string(&mut stdin);
    let (Ok(tab), Ok(payload)) = (tab.parse(), serde_json::from_str(&stdin)) else {
        return;
    };
    let _ = send(
        &pipe,
        &HookMessage {
            tab,
            harness: harness.into(),
            payload,
        },
    );
}

pub fn send(pipe: &str, msg: &HookMessage) -> std::io::Result<()> {
    let line = serde_json::to_vec(msg)?;
    // The server re-arms its pipe right after each connection; retry briefly if it is busy.
    for _ in 0..20 {
        match transport::connect(pipe) {
            Ok(mut conn) => return conn.write_all(&line),
            Err(_) => std::thread::sleep(Duration::from_millis(10)),
        }
    }
    Err(std::io::ErrorKind::TimedOut.into())
}

/// Accepts hook connections forever, one message per connection, handled in arrival order
/// (a `Stop` must never be applied before the `PostToolUse` that preceded it).
pub async fn serve(name: String, on_message: impl Fn(HookMessage)) -> std::io::Result<()> {
    let mut listener = transport::Listener::bind(&name)?;
    loop {
        let mut conn = listener.accept().await?;
        let mut buf = Vec::new();
        if conn.read_to_end(&mut buf).await.is_ok()
            && let Ok(msg) = serde_json::from_slice(&buf)
        {
            on_message(msg);
        }
    }
}

#[cfg(windows)]
mod transport {
    use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};

    fn path(name: &str) -> String {
        format!(r"\\.\pipe\{name}")
    }

    pub fn connect(name: &str) -> std::io::Result<std::fs::File> {
        std::fs::OpenOptions::new().write(true).open(path(name))
    }

    pub struct Listener {
        path: String,
        next: NamedPipeServer,
    }

    impl Listener {
        pub fn bind(name: &str) -> std::io::Result<Self> {
            let path = path(name);
            let next = ServerOptions::new()
                .first_pipe_instance(true)
                .create(&path)?;
            Ok(Listener { path, next })
        }

        pub async fn accept(&mut self) -> std::io::Result<NamedPipeServer> {
            self.next.connect().await?;
            // Re-arm first: the next hook can connect (and write into the pipe buffer) while we read.
            let fresh = ServerOptions::new().create(&self.path)?;
            Ok(std::mem::replace(&mut self.next, fresh))
        }
    }
}

#[cfg(unix)]
mod transport {
    use std::path::PathBuf;

    use tokio::net::{UnixListener, UnixStream};

    /// In the per-user runtime dir when there is one (only this user can connect).
    fn path(name: &str) -> PathBuf {
        let dir = std::env::var_os("XDG_RUNTIME_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        dir.join(format!("{name}.sock"))
    }

    pub fn connect(name: &str) -> std::io::Result<std::os::unix::net::UnixStream> {
        std::os::unix::net::UnixStream::connect(path(name))
    }

    pub struct Listener(UnixListener);

    impl Listener {
        pub fn bind(name: &str) -> std::io::Result<Self> {
            let path = path(name);
            let _ = std::fs::remove_file(&path); // left over by a crashed run with the same pid
            Ok(Listener(UnixListener::bind(path)?))
        }

        pub async fn accept(&mut self) -> std::io::Result<UnixStream> {
            Ok(self.0.accept().await?.0)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tokio::sync::mpsc;

    #[tokio::test(flavor = "multi_thread")]
    async fn messages_reach_the_server() {
        let name = format!("rift-test-{}", std::process::id());
        let (tx, mut rx) = mpsc::unbounded_channel();
        tokio::spawn(serve(name.clone(), move |m| {
            let _ = tx.send(m);
        }));
        tokio::time::sleep(Duration::from_millis(100)).await;

        for tab in [7, 8] {
            let name = name.clone();
            tokio::task::spawn_blocking(move || {
                let msg = HookMessage {
                    tab,
                    harness: "claude".into(),
                    payload: json!({ "session_id": "s" }),
                };
                send(&name, &msg).unwrap();
            })
            .await
            .unwrap();
        }
        let mut tabs = Vec::new();
        for _ in 0..2 {
            let m = tokio::time::timeout(Duration::from_secs(5), rx.recv())
                .await
                .unwrap()
                .unwrap();
            assert_eq!(m.harness, "claude");
            assert_eq!(m.payload["session_id"], "s");
            tabs.push(m.tab);
        }
        assert_eq!(tabs, [7, 8], "messages must arrive in send order");
    }

    #[test]
    fn send_fails_fast_without_server() {
        let msg = HookMessage {
            tab: 1,
            harness: "claude".into(),
            payload: json!({}),
        };
        assert!(send("rift-test-nobody-listens", &msg).is_err());
    }
}
