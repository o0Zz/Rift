//! Runs the real `rift.exe hook claude` the way Claude Code does: hook JSON on stdin, env from the tab's shell.

use std::io::Write;
use std::process::{Command, Stdio};
use std::time::Duration;

use rift_lib::hook::serve;
use tokio::sync::mpsc;

fn run_hook(env: &[(&str, &str)], stdin: &str) -> std::process::ExitStatus {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_rift"));
    cmd.args(["hook", "claude"])
        .stdin(Stdio::piped())
        .env_remove("RIFT_TAB_ID")
        .env_remove("RIFT_PIPE");
    for (k, v) in env {
        cmd.env(k, v);
    }
    let mut child = cmd.spawn().unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(stdin.as_bytes())
        .unwrap();
    child.wait().unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn hook_command_forwards_payload_to_its_rift_instance() {
    let pipe = format!("rift-cli-test-{}", std::process::id());
    let (tx, mut rx) = mpsc::unbounded_channel();
    tokio::spawn(serve(pipe.clone(), move |m| {
        let _ = tx.send(m);
    }));
    tokio::time::sleep(Duration::from_millis(100)).await;

    let payload = r#"{"hook_event_name":"SessionStart","session_id":"00893aaf-19fa-41d2-8238-13269b9b3ca0","source":"startup"}"#;
    let status = tokio::task::spawn_blocking(move || {
        run_hook(&[("RIFT_TAB_ID", "42"), ("RIFT_PIPE", &pipe)], payload)
    })
    .await
    .unwrap();
    assert!(status.success());

    let msg = tokio::time::timeout(Duration::from_secs(5), rx.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(msg.tab, 42);
    assert_eq!(msg.harness, "claude");
    assert_eq!(
        msg.payload["session_id"],
        "00893aaf-19fa-41d2-8238-13269b9b3ca0"
    );
}

#[test]
fn hook_command_is_a_silent_no_op_outside_rift() {
    // Claude run from another terminal: no RIFT_* env. Must exit 0 without touching anything.
    assert!(
        run_hook(
            &[],
            r#"{"hook_event_name":"SessionStart","session_id":"x"}"#
        )
        .success()
    );
    // Rift not running anymore (stale pipe name): still exit 0.
    assert!(run_hook(&[("RIFT_TAB_ID", "1"), ("RIFT_PIPE", "rift-gone")], "{}").success());
}
