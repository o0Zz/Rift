//! Everything agent-specific (Claude Code, Codex, Gemini CLI, Copilot CLI) sits behind `AgentHarness`.

mod claude;
mod codex;
mod config;
mod copilot;
mod gemini;

use std::path::Path;

use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The user's own convention for commit messages (see their CLAUDE.md), for `AgentHarness::one_shot`.
pub const COMMIT_PROMPT: &str = "Write a git commit message for the diff on stdin, following Conventional Commits. \
Subject line: `type(scope): description`, where type is one of feat, fix, docs, style, refactor, perf, test, \
build, ci, chore; the scope is optional (the main area touched, one short word); the description is in the \
imperative mood, lower case, no final period; the whole line at most 72 characters. \
For a breaking change, add `!` before the colon and a `BREAKING CHANGE:` footer. \
Optionally a blank line and a brief body. No co-author or sign-off lines. \
Output only the message, without quotes or code fences.";

/// What an agent reported through its hook.
#[derive(Debug, Clone, PartialEq)]
pub enum AgentEvent {
    SessionStarted {
        session_id: String,
    },
    SessionEnded {
        session_id: String,
    },
    /// A turn started (the user sent a prompt).
    Working,
    /// A tool finished mid-turn: still working. Arrives late after an interrupt, which it must not undo.
    ToolDone,
    /// Finished its turn, waiting for the next prompt.
    Done,
    /// Blocked on the user (e.g. a permission prompt).
    NeedsInput {
        message: String,
    },
}

impl AgentEvent {
    /// Status shown on the tab; `None` = no agent running.
    pub fn status(&self) -> Option<&'static str> {
        match self {
            AgentEvent::SessionStarted { .. } => Some("idle"),
            AgentEvent::SessionEnded { .. } => None,
            AgentEvent::Working | AgentEvent::ToolDone => Some("working"),
            AgentEvent::Done => Some("done"),
            AgentEvent::NeedsInput { .. } => Some("blocked"),
        }
    }
}

/// Live numbers from an agent's status line: context window and plan limits, in percent.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub context: Option<f64>,
    pub five_hour: Option<Limit>,
    pub seven_day: Option<Limit>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Limit {
    pub used: f64,
    /// Unix epoch seconds.
    pub resets_at: i64,
}

impl Usage {
    /// The line printed back into the agent's own status bar: "ctx 34% · 5h 23% · 7d 41%".
    pub fn line(&self) -> String {
        let parts = [
            self.context.map(|c| format!("ctx {c:.0}%")),
            self.five_hour
                .as_ref()
                .map(|l| format!("5h {:.0}%", l.used)),
            self.seven_day
                .as_ref()
                .map(|l| format!("7d {:.0}%", l.used)),
        ];
        parts
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join(" \u{b7} ")
    }
}

/// Usage from a status line payload (`rift status <harness>`); `None` for hook payloads.
pub fn parse_usage(harness: &str, payload: &Value) -> Option<Usage> {
    match harness {
        "claude" => claude::parse_usage(payload),
        _ => None,
    }
}

/// An agent session bound to a tab, enough to resume it later.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentSession {
    pub harness: String,
    pub session_id: String,
}

pub trait AgentHarness: Send + Sync {
    fn id(&self) -> &'static str;
    fn name(&self) -> &'static str;
    /// Whether the agent looks used on this machine (its config folder exists): only those offer "Enable".
    fn detected(&self) -> bool;
    /// Translates a hook payload into an event; `None` for events Rift does not use.
    fn parse_hook(&self, payload: &Value) -> Option<AgentEvent>;
    /// Shell command resuming `session_id`; `None` if the id looks malformed.
    fn resume_command(&self, session_id: &str) -> Option<String>;
    /// Whether the agent is configured to call `exe hook <id>`.
    fn hooks_installed(&self, exe: &Path) -> bool;
    fn install_hooks(&self, exe: &Path) -> Result<()>;
    /// Shown before the Enable click: what `install_hooks` writes and where, and anything left to do.
    fn setup(&self) -> String;
    /// Runs the agent non-interactively in `cwd`: `prompt` as instruction, `input` on stdin; returns its answer.
    fn one_shot(&self, cwd: &Path, prompt: &str, input: &str) -> Result<String>;
    /// Shell command starting a new interactive session (e.g. `claude`).
    fn start_command(&self) -> String;
}

pub struct Harnesses(pub Vec<Box<dyn AgentHarness>>);

impl Harnesses {
    /// Every supported agent, with its config files under `home`.
    pub fn new(home: &Path) -> Self {
        let copilot_home = std::env::var_os("COPILOT_HOME")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| home.join(".copilot"));
        Harnesses(vec![
            Box::new(claude::Claude {
                settings: home.join(".claude").join("settings.json"),
            }),
            Box::new(codex::Codex {
                hooks: home.join(".codex").join("hooks.json"),
            }),
            Box::new(gemini::Gemini {
                settings: home.join(".gemini").join("settings.json"),
            }),
            Box::new(copilot::Copilot {
                hooks: copilot_home.join("hooks").join("rift.json"),
            }),
        ])
    }

    pub fn get(&self, id: &str) -> Option<&dyn AgentHarness> {
        self.0.iter().find(|h| h.id() == id).map(|h| h.as_ref())
    }

    /// The agent that writes one-shot answers (commit messages): the first one used on this machine.
    pub fn for_one_shot(&self) -> Option<&dyn AgentHarness> {
        let first = self.0.iter().find(|h| h.detected()).or(self.0.first());
        first.map(|h| h.as_ref())
    }
}
