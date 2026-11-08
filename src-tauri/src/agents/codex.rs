//! Codex CLI adapter: hooks in ~/.codex/hooks.json, `codex resume <id>`.

use std::path::{Path, PathBuf};

use anyhow::Result;
use serde_json::{Value, json};

use super::config::{self, HookShell};
use super::{AgentEvent, AgentHarness};

// PermissionRequest = waiting for an approval; PostToolUse flips it back to "working" once the tool ran.
const EVENTS: [&str; 6] = [
    "SessionStart",
    "SessionEnd",
    "UserPromptSubmit",
    "PostToolUse",
    "PermissionRequest",
    "Stop",
];

pub struct Codex {
    /// Usually ~/.codex/hooks.json; a temp file in tests.
    pub hooks: PathBuf,
}

/// Codex only runs command lines: `cmd /C` on Windows, `$SHELL -lc` elsewhere.
fn handler(exe: &Path) -> Value {
    let shell = if cfg!(windows) {
        HookShell::Cmd
    } else {
        HookShell::Posix
    };
    json!({ "type": "command", "command": config::hook_command(exe, "codex", shell) })
}

impl AgentHarness for Codex {
    fn id(&self) -> &'static str {
        "codex"
    }

    fn name(&self) -> &'static str {
        "Codex"
    }

    fn detected(&self) -> bool {
        self.hooks.parent().is_some_and(Path::is_dir)
    }

    fn parse_hook(&self, payload: &Value) -> Option<AgentEvent> {
        let session_id = payload["session_id"].as_str()?.to_string();
        match payload["hook_event_name"].as_str()? {
            "SessionStart" => Some(AgentEvent::SessionStarted { session_id }),
            "SessionEnd" => Some(AgentEvent::SessionEnded { session_id }),
            "UserPromptSubmit" => Some(AgentEvent::Working),
            "PostToolUse" => Some(AgentEvent::ToolDone),
            "Stop" => Some(AgentEvent::Done),
            "PermissionRequest" => Some(AgentEvent::NeedsInput {
                message: match payload["tool_name"].as_str() {
                    Some(tool) => format!("Codex asks to run {tool}"),
                    None => "Codex needs your approval".into(),
                },
            }),
            _ => None,
        }
    }

    fn resume_command(&self, session_id: &str) -> Option<String> {
        config::safe_id(session_id).then(|| format!("codex resume {session_id}"))
    }

    fn start_command(&self) -> String {
        "codex".into()
    }

    /// Read-only sandbox, nothing saved; the diff on stdin is appended to the prompt.
    fn one_shot(&self, cwd: &Path, prompt: &str, input: &str) -> Result<String> {
        let args = [
            "exec",
            "--ephemeral",
            "--sandbox",
            "read-only",
            "--skip-git-repo-check",
            prompt,
        ];
        config::run("codex", &args, cwd, input)
    }

    fn hooks_installed(&self, exe: &Path) -> bool {
        config::hooks_installed(&self.hooks, &EVENTS, &handler(exe))
    }

    fn install_hooks(&self, exe: &Path) -> Result<()> {
        config::install_hooks(&self.hooks, &EVENTS, &handler(exe), "codex")
    }

    fn setup(&self) -> String {
        format!(
            "Adds Rift's hooks to {}. Codex runs new hooks only once trusted: then type /hooks in Codex and approve them.",
            self.hooks.display()
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const EXE: &str = r"C:\Apps\Rift\rift.exe";

    fn ev(name: &str, extra: Value) -> Option<AgentEvent> {
        // Fields from the Codex hooks docs (learn.chatgpt.com/docs/hooks) and codex-rs/hooks.
        let mut p = json!({ "hook_event_name": name, "session_id": "019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a5b",
            "cwd": "/repo", "model": "gpt-5-codex", "transcript_path": null });
        p.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        Codex {
            hooks: PathBuf::new(),
        }
        .parse_hook(&p)
    }

    #[test]
    fn parses_its_hooks() {
        let id = "019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a5b".to_string();
        assert_eq!(
            ev("SessionStart", json!({ "source": "startup" })),
            Some(AgentEvent::SessionStarted {
                session_id: id.clone()
            })
        );
        assert_eq!(
            ev("SessionEnd", json!({ "reason": "other" })),
            Some(AgentEvent::SessionEnded { session_id: id })
        );
        assert_eq!(
            ev(
                "UserPromptSubmit",
                json!({ "turn_id": "1", "prompt": "hi" })
            ),
            Some(AgentEvent::Working)
        );
        assert_eq!(
            ev("PostToolUse", json!({ "tool_name": "shell" })),
            Some(AgentEvent::ToolDone)
        );
        assert_eq!(
            ev(
                "PermissionRequest",
                json!({ "tool_name": "shell", "tool_input": {} })
            ),
            Some(AgentEvent::NeedsInput {
                message: "Codex asks to run shell".into()
            })
        );
        assert_eq!(
            ev("Stop", json!({ "stop_hook_active": false })),
            Some(AgentEvent::Done)
        );
        assert_eq!(ev("PreToolUse", json!({})), None);
    }

    #[test]
    fn installs_into_its_own_hooks_file() {
        let dir = tempfile::tempdir().unwrap();
        let c = Codex {
            hooks: dir.path().join("hooks.json"),
        };
        assert!(!c.hooks_installed(Path::new(EXE)));
        c.install_hooks(Path::new(EXE)).unwrap();
        c.install_hooks(Path::new(EXE)).unwrap();
        assert!(c.hooks_installed(Path::new(EXE)));
        let s = config::read_json(&c.hooks).unwrap();
        for event in EVENTS {
            assert_eq!(
                s["hooks"][event],
                json!([{ "hooks": [handler(Path::new(EXE))] }]),
                "{event}"
            );
        }
        assert!(c.setup().contains("/hooks"));
        assert!(c.setup().contains(&c.hooks.display().to_string()));
    }

    #[test]
    fn resume_command_rejects_shell_syntax() {
        let c = Codex {
            hooks: PathBuf::new(),
        };
        assert_eq!(
            c.resume_command("019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a5b")
                .as_deref(),
            Some("codex resume 019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a5b")
        );
        assert_eq!(c.resume_command("a && b"), None);
    }
}
