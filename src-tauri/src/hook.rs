//! Agent hooks → app. The agent runs `rift.exe hook <harness>` with the hook JSON on stdin; that process
//! forwards it, tagged with the tab id, to the Rift instance named in RIFT_PIPE.

use std::io::{Read, Write};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::AsyncReadExt;
use tokio::net::windows::named_pipe::ServerOptions;

use crate::pty::TabId;

#[derive(Debug, Serialize, Deserialize)]
pub struct HookMessage {
    pub tab: TabId,
    pub harness: String,
    pub payload: Value,
}

pub fn pipe_path(name: &str) -> String {
    format!(r"\\.\pipe\{name}")
}

/// Entry point of `rift.exe hook <harness>`. Never fails loudly: a broken hook must not disturb the agent.
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
        match std::fs::OpenOptions::new()
            .write(true)
            .open(pipe_path(pipe))
        {
            Ok(mut f) => return f.write_all(&line),
            Err(_) => std::thread::sleep(Duration::from_millis(10)),
        }
    }
    Err(std::io::ErrorKind::TimedOut.into())
}

/// Accepts hook connections forever, one message per connection.
pub async fn serve(
    name: String,
    on_message: impl Fn(HookMessage) + Send + Sync + 'static,
) -> std::io::Result<()> {
    let path = pipe_path(&name);
    let on_message = std::sync::Arc::new(on_message);
    let mut server = ServerOptions::new()
        .first_pipe_instance(true)
        .create(&path)?;
    loop {
        server.connect().await?;
        let mut conn = std::mem::replace(&mut server, ServerOptions::new().create(&path)?);
        let on_message = on_message.clone();
        tokio::spawn(async move {
            let mut buf = Vec::new();
            if conn.read_to_end(&mut buf).await.is_ok()
                && let Ok(msg) = serde_json::from_slice(&buf)
            {
                on_message(msg);
            }
        });
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
        tabs.sort();
        assert_eq!(tabs, [7, 8]);
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
