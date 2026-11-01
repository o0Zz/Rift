//! GitHub Copilot CLI adapter: Rift's own hook file ~/.copilot/hooks/rift.json, `copilot --resume=<id>`.

use std::path::{Path, PathBuf};

use anyhow::Result;
use serde_json::{Map, Value, json};

use super::config;
use super::{AgentEvent, AgentHarness};

// PascalCase names: Copilot then sends Claude-style payloads (`hook_event_name`, `session_id`).
const EVENTS: [&str; 6] = [
    "SessionStart",
    "SessionEnd",
    "UserPromptSubmit",
    "PostToolUse",
    "Stop",
    "Notification",
];

/// The notifications where Copilot waits on the user (others: shell or background agent finished).
const BLOCKING: &str = "permission_prompt|elicitation_dialog";

pub struct Copilot {
    /// Usually ~/.copilot/hooks/rift.json (or $COPILOT_HOME/hooks); a temp file in tests.
    pub hooks: PathBuf,
}

/// The whole file: Rift owns it, so it is simply rewritten. Exec form, no shell involved.
fn hook_file(exe: &Path) -> Value {
    let mut hooks = Map::new();
    for event in EVENTS {
        let mut entry = json!({ "type": "command", "exec": exe.to_string_lossy(), "args": ["hook", "copilot"],
            "timeoutSec": 10 });
        if event == "Notification" {
            entry["matcher"] = BLOCKING.into();
        }
        hooks.insert(event.into(), json!([entry]));
    }
    json!({ "version": 1, "hooks": hooks })
}

impl AgentHarness for Copilot {
    fn id(&self) -> &'static str {
        "copilot"
    }

    fn name(&self) -> &'static str {
        "Copilot CLI"
    }

    /// ~/.copilot exists (the hooks folder itself may not yet).
    fn detected(&self) -> bool {
        self.hooks
            .parent()
            .and_then(Path::parent)
            .is_some_and(Path::is_dir)
    }

    fn parse_hook(&self, payload: &Value) -> Option<AgentEvent> {
        let session_id = payload["session_id"].as_str()?.to_string();
        match payload["hook_event_name"].as_str()? {
            "SessionStart" => Some(AgentEvent::SessionStarted { session_id }),
            "SessionEnd" => Some(AgentEvent::SessionEnded { session_id }),
            "UserPromptSubmit" | "PostToolUse" => Some(AgentEvent::Working),
            "Stop" => Some(AgentEvent::Done),
            "Notification"
                if payload["notification_type"]
                    .as_str()
                    .is_some_and(|t| BLOCKING.split('|').any(|b| b == t)) =>
            {
                Some(AgentEvent::NeedsInput {
                    message: payload["message"].as_str().unwrap_or_default().into(),
                })
            }
            _ => None,
        }
    }

    fn resume_command(&self, session_id: &str) -> Option<String> {
        config::safe_id(session_id).then(|| format!("copilot --resume={session_id}"))
    }

    fn start_command(&self) -> String {
        "copilot".into()
    }

    /// Copilot ignores stdin when given `-p`: the instructions and the diff both go through stdin. No tools.
    fn one_shot(&self, cwd: &Path, prompt: &str, input: &str) -> Result<String> {
        let args = ["-s", "--no-ask-user", "--available-tools="];
        config::run("copilot", &args, cwd, &format!("{prompt}\n\n{input}"))
    }

    fn hooks_installed(&self, exe: &Path) -> bool {
        config::read_json(&self.hooks).is_ok_and(|f| f == hook_file(exe))
    }

    fn install_hooks(&self, exe: &Path) -> Result<()> {
        config::write_json(&self.hooks, &hook_file(exe))
    }

    fn setup(&self) -> String {
        format!(
            "Writes Rift's hooks to their own file, {}.",
            self.hooks.display()
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const EXE: &str = r"C:\Apps\Rift\rift.exe";

    fn ev(name: &str, extra: Value) -> Option<AgentEvent> {
        // Shapes built by Copilot CLI 1.0.63 for PascalCase hooks (`MM()` in its app.js).
        let mut p = json!({ "hook_event_name": name, "session_id": "043da599-c2d9-41f4-a539-98f8517d82fa",
            "timestamp": "2026-10-31T10:00:00.000Z", "cwd": "/repo" });
        p.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        Copilot {
            hooks: PathBuf::new(),
        }
        .parse_hook(&p)
    }

    #[test]
    fn parses_its_hooks() {
        let id = "043da599-c2d9-41f4-a539-98f8517d82fa".to_string();
        assert_eq!(
            ev("SessionStart", json!({ "source": "new" })),
            Some(AgentEvent::SessionStarted {
                session_id: id.clone()
            })
        );
        assert_eq!(
            ev("SessionEnd", json!({ "reason": "user_exit" })),
            Some(AgentEvent::SessionEnded { session_id: id })
        );
        assert_eq!(
            ev("UserPromptSubmit", json!({ "prompt": "hi" })),
            Some(AgentEvent::Working)
        );
        assert_eq!(
            ev("PostToolUse", json!({ "tool_name": "bash" })),
            Some(AgentEvent::Working)
        );
        assert_eq!(
            ev("Stop", json!({ "stop_reason": "end_turn" })),
            Some(AgentEvent::Done)
        );
        assert_eq!(
            ev(
                "Notification",
                json!({ "notification_type": "permission_prompt", "message": "Permission needed" })
            ),
            Some(AgentEvent::NeedsInput {
                message: "Permission needed".into()
            })
        );
        assert_eq!(
            ev(
                "Notification",
                json!({ "notification_type": "shell_completed" })
            ),
            None
        );
    }

    #[test]
    fn writes_its_own_file_and_recognizes_it() {
        let dir = tempfile::tempdir().unwrap();
        let c = Copilot {
            hooks: dir.path().join("hooks").join("rift.json"),
        };
        assert!(c.detected());
        assert!(!c.hooks_installed(Path::new(EXE)));
        c.install_hooks(Path::new(r"C:\old\rift.exe")).unwrap();
        assert!(
            !c.hooks_installed(Path::new(EXE)),
            "another exe path asks to enable again"
        );
        c.install_hooks(Path::new(EXE)).unwrap();
        assert!(c.hooks_installed(Path::new(EXE)));
        let f = config::read_json(&c.hooks).unwrap();
        assert_eq!(f["version"], 1);
        assert_eq!(f["hooks"]["Stop"][0]["exec"], EXE);
        assert_eq!(f["hooks"]["Stop"][0]["args"], json!(["hook", "copilot"]));
        assert_eq!(f["hooks"]["Notification"][0]["matcher"], BLOCKING);
    }

    #[test]
    fn resume_command_rejects_shell_syntax() {
        let c = Copilot {
            hooks: PathBuf::new(),
        };
        assert_eq!(
            c.resume_command("043da599-c2d9-41f4-a539-98f8517d82fa")
                .as_deref(),
            Some("copilot --resume=043da599-c2d9-41f4-a539-98f8517d82fa")
        );
        assert_eq!(c.resume_command("`id`"), None);
    }
}
