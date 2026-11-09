//! Claude Code adapter: hooks in ~/.claude/settings.json, `claude --resume <id>`.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde_json::{Value, json};

use super::config;
use super::{AgentEvent, AgentHarness, Limit, Usage};

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
    /// ~/.claude.json, where Claude keeps its user MCP servers (read only: written through `claude mcp`).
    pub user_config: PathBuf,
}

/// Rift's hook handler: exec form, so no shell (Git Bash on Windows) is involved.
fn handler(exe: &Path) -> Value {
    json!({ "type": "command", "command": exe.to_string_lossy(), "args": ["hook", "claude"] })
}

/// Rift's status line: a shell command (Claude runs it through Git Bash or PowerShell on Windows), so
/// forward slashes, and quotes only when the path has a space (PowerShell would not run a quoted path).
fn status_line(exe: &Path) -> Value {
    let path = exe.to_string_lossy().replace('\\', "/");
    let path = if path.contains(' ') {
        format!("\"{path}\"")
    } else {
        path
    };
    json!({ "type": "command", "command": format!("{path} status claude") })
}

fn is_our_status_line(line: &Value) -> bool {
    line["command"].as_str().is_some_and(|c| {
        c.strip_suffix(" status claude")
            .is_some_and(|exe| config::is_rift(exe.trim_matches('"')))
    })
}

/// Context window and plan limits from Claude's status line JSON; `None` for a hook payload.
pub fn parse_usage(p: &Value) -> Option<Usage> {
    if p.get("hook_event_name").is_some() || p.get("context_window").is_none() {
        return None;
    }
    let limit = |window: &str| {
        let l = &p["rate_limits"][window];
        Some(Limit {
            used: l["used_percentage"].as_f64()?,
            resets_at: l["resets_at"].as_i64()?,
        })
    };
    Some(Usage {
        context: p["context_window"]["used_percentage"].as_f64(),
        five_hour: limit("five_hour"),
        seven_day: limit("seven_day"),
    })
}

/// `claude -p` for short text tasks: small fast model, no tools, not saved in the user's session list.
fn one_shot_args(prompt: &str) -> [&str; 7] {
    [
        "-p",
        prompt,
        "--model",
        "haiku",
        "--tools",
        "",
        "--no-session-persistence",
    ]
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
            "UserPromptSubmit" => Some(AgentEvent::Working),
            "PostToolUse" => Some(AgentEvent::ToolDone),
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

    fn one_shot(&self, cwd: &Path, prompt: &str, input: &str) -> Result<String> {
        config::run("claude", &one_shot_args(prompt), cwd, input)
    }

    fn start_command(&self) -> String {
        "claude".into()
    }

    fn resume_command(&self, session_id: &str) -> Option<String> {
        // Session ids are UUIDs; anything else must not reach a shell command line.
        let valid = !session_id.is_empty()
            && session_id
                .chars()
                .all(|c| c.is_ascii_hexdigit() || c == '-');
        valid.then(|| format!("claude --resume {session_id}"))
    }

    fn detected(&self) -> bool {
        self.settings.parent().is_some_and(Path::is_dir)
    }

    fn hooks_installed(&self, exe: &Path) -> bool {
        let Ok(settings) = config::read_json(&self.settings) else {
            return false;
        };
        // The status line counts as set up when it is anyone's: Rift never replaces the user's own.
        settings.get("statusLine").is_some() && config::has_hooks(&settings, &EVENTS, &handler(exe))
    }

    /// Adds Rift's handler to each event and its status line (unless the user has one). Everything else in
    /// the file is kept; the previous file is saved as settings.json.bak.
    fn install_hooks(&self, exe: &Path) -> Result<()> {
        let mut settings = config::read_json(&self.settings)?;
        config::add_hooks(&mut settings, &EVENTS, &handler(exe), "claude")?;
        let root = settings.as_object_mut().context("not a JSON object")?;
        if root.get("statusLine").is_none_or(is_our_status_line) {
            root.insert("statusLine".into(), status_line(exe));
        }
        config::write_json(&self.settings, &settings)
    }

    fn mcp_installed(&self, exe: &Path) -> bool {
        config::mcp_json_installed(&self.user_config, exe)
    }

    /// Through `claude mcp`: every running Claude rewrites ~/.claude.json and could undo a change made behind
    /// its back.
    fn set_mcp(&self, exe: &Path, on: bool) -> Result<()> {
        if on && self.mcp_installed(exe) {
            return Ok(());
        }
        let home = self.user_config.parent().unwrap_or(Path::new("."));
        let present = config::read_json(&self.user_config)
            .is_ok_and(|v| v["mcpServers"].get("rift").is_some());
        // `add` refuses a name in use: an entry for another exe path goes first.
        if present {
            config::run(
                "claude",
                &["mcp", "remove", "--scope", "user", "rift"],
                home,
                "",
            )?;
        }
        if on {
            let exe = exe.to_string_lossy();
            config::run(
                "claude",
                &["mcp", "add", "--scope", "user", "rift", "--", &exe, "mcp"],
                home,
                "",
            )?;
        }
        Ok(())
    }

    fn setup(&self) -> String {
        format!(
            "Adds Rift's hooks and a status line showing context and plan usage (unless you have your own) to {}.",
            self.settings.display()
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const EXE: &str = r"C:\Apps\Rift\rift.exe";

    fn claude(dir: &tempfile::TempDir) -> Claude {
        Claude {
            settings: dir.path().join("settings.json"),
            user_config: PathBuf::new(),
        }
    }

    fn read(c: &Claude) -> Value {
        serde_json::from_str(&std::fs::read_to_string(&c.settings).unwrap()).unwrap()
    }

    #[test]
    fn parses_session_hooks() {
        let c = Claude {
            settings: PathBuf::new(),
            user_config: PathBuf::new(),
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
            user_config: PathBuf::new(),
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
            Some(AgentEvent::ToolDone)
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
    fn one_shot_uses_a_fast_model_without_tools_or_saved_session() {
        let args = one_shot_args("Write a commit message");
        assert_eq!(&args[..2], ["-p", "Write a commit message"]);
        let flags = args.join(" ");
        assert!(flags.contains("--model haiku"), "{flags}");
        assert!(flags.contains("--tools ") && args.contains(&""), "{flags}");
        assert!(flags.contains("--no-session-persistence"), "{flags}");
    }

    #[test]
    fn resume_command_rejects_non_uuid_ids() {
        let c = Claude {
            settings: PathBuf::new(),
            user_config: PathBuf::new(),
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
        assert_eq!(keys, ["model", "hooks", "permissions", "statusLine"]);
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
    fn installs_a_status_line_but_never_replaces_the_users() {
        let dir = tempfile::tempdir().unwrap();
        let c = claude(&dir);
        c.install_hooks(Path::new(r"C:\Program Files\Rift\rift.exe"))
            .unwrap();
        assert_eq!(
            read(&c)["statusLine"]["command"],
            r#""C:/Program Files/Rift/rift.exe" status claude"#
        );
        // Ours is updated to the new exe; the user's own stays, and still counts as installed.
        c.install_hooks(Path::new(EXE)).unwrap();
        assert_eq!(
            read(&c)["statusLine"]["command"],
            "C:/Apps/Rift/rift.exe status claude"
        );
        let mut s = read(&c);
        s["statusLine"] = json!({ "type": "command", "command": "~/my-line.sh" });
        std::fs::write(&c.settings, s.to_string()).unwrap();
        c.install_hooks(Path::new(EXE)).unwrap();
        assert_eq!(read(&c)["statusLine"]["command"], "~/my-line.sh");
        assert!(c.hooks_installed(Path::new(EXE)));
    }

    #[test]
    fn hooks_without_a_status_line_ask_to_enable_again() {
        let dir = tempfile::tempdir().unwrap();
        let c = claude(&dir);
        c.install_hooks(Path::new(EXE)).unwrap();
        let mut s = read(&c);
        s.as_object_mut().unwrap().remove("statusLine");
        std::fs::write(&c.settings, s.to_string()).unwrap();
        assert!(!c.hooks_installed(Path::new(EXE)));
    }

    #[test]
    fn parses_usage_from_the_status_line_json() {
        // Shape documented at code.claude.com/docs/en/statusline.
        let full = json!({
            "session_id": "abc",
            "model": { "display_name": "Opus" },
            "context_window": { "used_percentage": 8, "context_window_size": 200000 },
            "rate_limits": {
                "five_hour": { "used_percentage": 23.5, "resets_at": 1738425600 },
                "seven_day": { "used_percentage": 41.2, "resets_at": 1738857600 }
            }
        });
        let usage = parse_usage(&full).unwrap();
        assert_eq!(usage.context, Some(8.0));
        assert_eq!(
            usage.five_hour,
            Some(Limit {
                used: 23.5,
                resets_at: 1738425600
            })
        );
        assert_eq!(usage.line(), "ctx 8% \u{b7} 5h 24% \u{b7} 7d 41%");
        // API key users: no rate limits; early in a session: no percentage yet.
        let early = json!({ "session_id": "abc", "context_window": { "used_percentage": null } });
        let usage = parse_usage(&early).unwrap();
        assert_eq!((usage.context, &usage.five_hour), (None, &None));
        assert_eq!(usage.line(), "");
        // Hook payloads are not usage.
        assert_eq!(
            parse_usage(&json!({ "hook_event_name": "Stop", "session_id": "abc" })),
            None
        );
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
