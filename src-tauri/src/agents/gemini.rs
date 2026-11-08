//! Gemini CLI adapter: hooks in ~/.gemini/settings.json, `gemini --resume <id>`.

use std::path::{Path, PathBuf};

use anyhow::Result;
use serde_json::{Value, json};

use super::config::{self, HookShell};
use super::{AgentEvent, AgentHarness};

// AfterTool flips "blocked" back to "working" once a permission is granted and the tool ran.
const EVENTS: [&str; 6] = [
    "SessionStart",
    "SessionEnd",
    "BeforeAgent",
    "AfterTool",
    "AfterAgent",
    "Notification",
];

pub struct Gemini {
    /// Usually ~/.gemini/settings.json; a temp file in tests.
    pub settings: PathBuf,
}

/// Gemini only runs command lines: PowerShell on Windows, bash elsewhere.
fn handler(exe: &Path) -> Value {
    let shell = if cfg!(windows) {
        HookShell::PowerShell
    } else {
        HookShell::Posix
    };
    json!({ "type": "command", "name": "rift", "command": config::hook_command(exe, "gemini", shell) })
}

impl AgentHarness for Gemini {
    fn id(&self) -> &'static str {
        "gemini"
    }

    fn name(&self) -> &'static str {
        "Gemini CLI"
    }

    fn detected(&self) -> bool {
        self.settings.parent().is_some_and(Path::is_dir)
    }

    fn parse_hook(&self, payload: &Value) -> Option<AgentEvent> {
        let session_id = payload["session_id"].as_str()?.to_string();
        match payload["hook_event_name"].as_str()? {
            "SessionStart" => Some(AgentEvent::SessionStarted { session_id }),
            "SessionEnd" => Some(AgentEvent::SessionEnded { session_id }),
            "BeforeAgent" => Some(AgentEvent::Working),
            "AfterTool" => Some(AgentEvent::ToolDone),
            "AfterAgent" => Some(AgentEvent::Done),
            // ToolPermission is the only notification Gemini sends today.
            "Notification" => Some(AgentEvent::NeedsInput {
                message: payload["message"].as_str().unwrap_or_default().into(),
            }),
            _ => None,
        }
    }

    fn resume_command(&self, session_id: &str) -> Option<String> {
        config::safe_id(session_id).then(|| format!("gemini --resume {session_id}"))
    }

    fn start_command(&self) -> String {
        "gemini".into()
    }

    /// Fastest model, no extensions; `-p` is appended to the diff on stdin.
    fn one_shot(&self, cwd: &Path, prompt: &str, input: &str) -> Result<String> {
        let args = [
            "-p",
            prompt,
            "-m",
            "flash-lite",
            "-e",
            "none",
            "--output-format",
            "text",
        ];
        config::run("gemini", &args, cwd, input)
    }

    fn hooks_installed(&self, exe: &Path) -> bool {
        config::hooks_installed(&self.settings, &EVENTS, &handler(exe))
    }

    fn install_hooks(&self, exe: &Path) -> Result<()> {
        config::install_hooks(&self.settings, &EVENTS, &handler(exe), "gemini")
    }

    fn setup(&self) -> String {
        format!("Adds Rift's hooks to {}.", self.settings.display())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const EXE: &str = r"C:\Apps\Rift\rift.exe";

    fn ev(name: &str, extra: Value) -> Option<AgentEvent> {
        // Fields from github.com/google-gemini/gemini-cli docs/hooks/reference.md.
        let mut p = json!({ "hook_event_name": name, "session_id": "8f9c1e2a-0b1c-4d5e-8f90-a1b2c3d4e5f6",
            "cwd": "/repo", "timestamp": "2026-10-31T10:00:00Z", "transcript_path": "/t.json" });
        p.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        Gemini {
            settings: PathBuf::new(),
        }
        .parse_hook(&p)
    }

    #[test]
    fn parses_its_hooks() {
        let id = "8f9c1e2a-0b1c-4d5e-8f90-a1b2c3d4e5f6".to_string();
        assert_eq!(
            ev("SessionStart", json!({ "source": "startup" })),
            Some(AgentEvent::SessionStarted {
                session_id: id.clone()
            })
        );
        assert_eq!(
            ev("SessionEnd", json!({ "reason": "exit" })),
            Some(AgentEvent::SessionEnded { session_id: id })
        );
        assert_eq!(
            ev("BeforeAgent", json!({ "prompt": "hi" })),
            Some(AgentEvent::Working)
        );
        assert_eq!(
            ev("AfterTool", json!({ "tool_name": "run_shell_command" })),
            Some(AgentEvent::ToolDone)
        );
        assert_eq!(
            ev("AfterAgent", json!({ "prompt_response": "ok" })),
            Some(AgentEvent::Done)
        );
        assert_eq!(
            ev(
                "Notification",
                json!({ "notification_type": "ToolPermission", "message": "Allow ls?" })
            ),
            Some(AgentEvent::NeedsInput {
                message: "Allow ls?".into()
            })
        );
        assert_eq!(ev("BeforeModel", json!({})), None);
    }

    #[test]
    fn installs_next_to_the_users_settings_and_hooks() {
        let dir = tempfile::tempdir().unwrap();
        let g = Gemini {
            settings: dir.path().join("settings.json"),
        };
        let original = r#"{ "model": { "name": "gemini-2.5-pro" },
  "hooks": { "AfterAgent": [{ "hooks": [{ "type": "command", "command": "notify-send done" }] }] } }"#;
        std::fs::write(&g.settings, original).unwrap();
        assert!(!g.hooks_installed(Path::new(EXE)));
        g.install_hooks(Path::new(r"C:\old\rift.exe")).unwrap();
        g.install_hooks(Path::new(EXE)).unwrap();
        assert!(g.hooks_installed(Path::new(EXE)));

        let s = config::read_json(&g.settings).unwrap();
        assert_eq!(s["model"]["name"], "gemini-2.5-pro");
        assert_eq!(
            s["hooks"]["AfterAgent"],
            json!([
                { "hooks": [{ "type": "command", "command": "notify-send done" }] },
                { "hooks": [handler(Path::new(EXE))] }
            ]),
            "the user's hook stays, the old Rift entry is replaced"
        );
        assert!(dir.path().join("settings.json.bak").exists());
    }

    #[test]
    fn resume_command_rejects_shell_syntax() {
        let g = Gemini {
            settings: PathBuf::new(),
        };
        assert_eq!(
            g.resume_command("8f9c1e2a-0b1c-4d5e-8f90-a1b2c3d4e5f6")
                .as_deref(),
            Some("gemini --resume 8f9c1e2a-0b1c-4d5e-8f90-a1b2c3d4e5f6")
        );
        assert_eq!(g.resume_command("x; rm -rf ~"), None);
    }
}
