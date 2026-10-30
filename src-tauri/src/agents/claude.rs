//! Claude Code adapter: hooks in ~/.claude/settings.json, `claude --resume <id>`.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde_json::{Map, Value, json};

use super::{AgentEvent, AgentHarness};

// PostToolUse flips "blocked" back to "working" once a permission is granted and the tool ran.
const EVENTS: [&str; 6] = [
    "SessionStart",
    "SessionEnd",
    "UserPromptSubmit",
    "PostToolUse",
    "Stop",
    "Notification",
];

pub struct Claude {
    /// Usually ~/.claude/settings.json; a temp file in tests.
    pub settings: PathBuf,
}

impl Claude {
    fn read_settings(&self) -> Result<Value> {
        match std::fs::read_to_string(&self.settings) {
            Ok(text) => {
                serde_json::from_str(&text).context("~/.claude/settings.json is not valid JSON")
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
            Err(e) => Err(e.into()),
        }
    }
}

/// Rift's hook handler: exec form, so no shell (Git Bash on Windows) is involved.
fn handler(exe: &Path) -> Value {
    json!({ "type": "command", "command": exe.to_string_lossy(), "args": ["hook", "claude"] })
}

fn is_ours(handler: &Value) -> bool {
    handler["args"] == json!(["hook", "claude"])
        && handler["command"]
            .as_str()
            .is_some_and(|c| c.to_lowercase().ends_with("rift.exe"))
}

impl AgentHarness for Claude {
    fn id(&self) -> &'static str {
        "claude"
    }

    fn name(&self) -> &'static str {
        "Claude Code"
    }

    fn parse_hook(&self, payload: &Value) -> Option<AgentEvent> {
        let session_id = payload["session_id"].as_str()?.to_string();
        match payload["hook_event_name"].as_str()? {
            "SessionStart" => Some(AgentEvent::SessionStarted { session_id }),
            "SessionEnd" => Some(AgentEvent::SessionEnded { session_id }),
            "UserPromptSubmit" | "PostToolUse" => Some(AgentEvent::Working),
            "Stop" => Some(AgentEvent::Done),
            // idle_prompt is the "still waiting for you" reminder after a finished turn: not a block.
            "Notification" if payload["notification_type"] != "idle_prompt" => {
                Some(AgentEvent::NeedsInput {
                    message: payload["message"].as_str().unwrap_or_default().into(),
                })
            }
            _ => None,
        }
    }

    fn resume_command(&self, session_id: &str) -> Option<String> {
        // Session ids are UUIDs; anything else must not reach a shell command line.
        let valid = !session_id.is_empty()
            && session_id
                .chars()
                .all(|c| c.is_ascii_hexdigit() || c == '-');
        valid.then(|| format!("claude --resume {session_id}"))
    }

    fn hooks_installed(&self, exe: &Path) -> bool {
        let Ok(settings) = self.read_settings() else {
            return false;
        };
        let wanted = handler(exe);
        EVENTS.iter().all(|event| {
            settings["hooks"][event].as_array().is_some_and(|groups| {
                groups
                    .iter()
                    .any(|g| g["hooks"].as_array().is_some_and(|hs| hs.contains(&wanted)))
            })
        })
    }

    /// Adds Rift's handler to each event, replacing an older Rift entry (e.g. another exe path).
    /// Everything else in the file is kept; the previous file is saved as settings.json.bak.
    fn install_hooks(&self, exe: &Path) -> Result<()> {
        let mut settings = self.read_settings()?;
        let root = settings
            .as_object_mut()
            .context("settings.json is not a JSON object")?;
        let hooks = root.entry("hooks").or_insert_with(|| json!({}));
        let hooks = hooks
            .as_object_mut()
            .context("\"hooks\" is not an object")?;
        for event in EVENTS {
            let groups = hooks.entry(event).or_insert_with(|| json!([]));
            let groups = groups
                .as_array_mut()
                .context("hook event is not an array")?;
            for group in groups.iter_mut() {
                if let Some(hs) = group.get_mut("hooks").and_then(Value::as_array_mut) {
                    hs.retain(|h| !is_ours(h));
                }
            }
            groups.retain(|g| g["hooks"].as_array().is_none_or(|hs| !hs.is_empty()));
            let mut group = Map::new();
            group.insert("hooks".into(), json!([handler(exe)]));
            groups.push(Value::Object(group));
        }

        if self.settings.exists() {
            std::fs::copy(&self.settings, self.settings.with_extension("json.bak"))?;
        } else if let Some(dir) = self.settings.parent() {
            std::fs::create_dir_all(dir)?;
        }
        std::fs::write(
            &self.settings,
            serde_json::to_string_pretty(&settings)? + "\n",
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const EXE: &str = r"C:\Apps\Rift\rift.exe";

    fn claude(dir: &tempfile::TempDir) -> Claude {
        Claude {
            settings: dir.path().join("settings.json"),
        }
    }

    fn read(c: &Claude) -> Value {
        serde_json::from_str(&std::fs::read_to_string(&c.settings).unwrap()).unwrap()
    }

    #[test]
    fn parses_session_hooks() {
        let c = Claude {
            settings: PathBuf::new(),
        };
        let start =
            json!({ "hook_event_name": "SessionStart", "session_id": "abc", "source": "startup" });
        let end = json!({ "hook_event_name": "SessionEnd", "session_id": "abc" });
        let other = json!({ "hook_event_name": "PreToolUse", "session_id": "abc" });
        assert_eq!(
            c.parse_hook(&start),
            Some(AgentEvent::SessionStarted {
                session_id: "abc".into()
            })
        );
        assert_eq!(
            c.parse_hook(&end),
            Some(AgentEvent::SessionEnded {
                session_id: "abc".into()
            })
        );
        assert_eq!(c.parse_hook(&other), None);
    }

    #[test]
    fn parses_status_hooks() {
        let c = Claude {
            settings: PathBuf::new(),
        };
        let ev = |name: &str, extra: Value| {
            let mut p = json!({ "hook_event_name": name, "session_id": "abc" });
            p.as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            c.parse_hook(&p)
        };
        assert_eq!(
            ev("UserPromptSubmit", json!({ "prompt": "hi" })),
            Some(AgentEvent::Working)
        );
        assert_eq!(
            ev("PostToolUse", json!({ "tool_name": "Bash" })),
            Some(AgentEvent::Working)
        );
        assert_eq!(ev("Stop", json!({})), Some(AgentEvent::Done));
        assert_eq!(
            ev(
                "Notification",
                json!({ "notification_type": "permission_prompt", "message": "Claude needs your permission" })
            ),
            Some(AgentEvent::NeedsInput {
                message: "Claude needs your permission".into()
            })
        );
        assert_eq!(
            ev(
                "Notification",
                json!({ "notification_type": "idle_prompt" })
            ),
            None
        );
    }

    #[test]
    fn older_install_without_status_hooks_is_not_complete() {
        let dir = tempfile::tempdir().unwrap();
        let c = claude(&dir);
        let only_session: Value = json!({ "hooks": {
            "SessionStart": [{ "hooks": [handler(Path::new(EXE))] }],
            "SessionEnd": [{ "hooks": [handler(Path::new(EXE))] }],
        }});
        std::fs::write(&c.settings, only_session.to_string()).unwrap();
        assert!(!c.hooks_installed(Path::new(EXE)));
        c.install_hooks(Path::new(EXE)).unwrap();
        assert!(c.hooks_installed(Path::new(EXE)));
        assert_eq!(
            read(&c)["hooks"]["SessionStart"],
            json!([{ "hooks": [handler(Path::new(EXE))] }])
        );
    }

    #[test]
    fn resume_command_rejects_non_uuid_ids() {
        let c = Claude {
            settings: PathBuf::new(),
        };
        assert_eq!(
            c.resume_command("00893aaf-19fa-41d2-8238-13269b9b3ca0")
                .as_deref(),
            Some("claude --resume 00893aaf-19fa-41d2-8238-13269b9b3ca0")
        );
        assert_eq!(c.resume_command("x; rm -rf ~"), None);
        assert_eq!(c.resume_command(""), None);
    }

    #[test]
    fn installs_into_missing_file() {
        let dir = tempfile::tempdir().unwrap();
        let c = claude(&dir);
        assert!(!c.hooks_installed(Path::new(EXE)));
        c.install_hooks(Path::new(EXE)).unwrap();
        assert!(c.hooks_installed(Path::new(EXE)));
        assert_eq!(
            read(&c)["hooks"]["SessionStart"][0]["hooks"][0],
            handler(Path::new(EXE))
        );
    }

    #[test]
    fn keeps_user_settings_and_other_hooks_in_order() {
        let dir = tempfile::tempdir().unwrap();
        let c = claude(&dir);
        let original = r#"{
  "model": "opus",
  "hooks": {
    "SessionStart": [{ "matcher": "startup", "hooks": [{ "type": "command", "command": "echo hi" }] }],
    "PreToolUse": [{ "hooks": [{ "type": "command", "command": "lint" }] }]
  },
  "permissions": { "allow": ["Bash(ls)"] }
}"#;
        std::fs::write(&c.settings, original).unwrap();
        c.install_hooks(Path::new(EXE)).unwrap();

        let s = read(&c);
        let keys: Vec<_> = s.as_object().unwrap().keys().cloned().collect();
        assert_eq!(keys, ["model", "hooks", "permissions"]);
        assert_eq!(
            s["hooks"]["SessionStart"][0]["hooks"][0]["command"],
            "echo hi"
        );
        assert_eq!(s["hooks"]["PreToolUse"][0]["hooks"][0]["command"], "lint");
        assert_eq!(s["permissions"]["allow"][0], "Bash(ls)");
        assert_eq!(
            std::fs::read_to_string(dir.path().join("settings.json.bak")).unwrap(),
            original
        );
    }

    #[test]
    fn reinstall_is_idempotent_and_replaces_old_exe_path() {
        let dir = tempfile::tempdir().unwrap();
        let c = claude(&dir);
        c.install_hooks(Path::new(r"C:\old\rift.exe")).unwrap();
        c.install_hooks(Path::new(EXE)).unwrap();
        c.install_hooks(Path::new(EXE)).unwrap();
        let s = read(&c);
        for event in EVENTS {
            assert_eq!(
                s["hooks"][event],
                json!([{ "hooks": [handler(Path::new(EXE))] }]),
                "{event}"
            );
        }
    }

    #[test]
    fn refuses_to_overwrite_invalid_json() {
        let dir = tempfile::tempdir().unwrap();
        let c = claude(&dir);
        std::fs::write(&c.settings, "{ not json").unwrap();
        assert!(c.install_hooks(Path::new(EXE)).is_err());
        assert_eq!(std::fs::read_to_string(&c.settings).unwrap(), "{ not json");
    }
}
