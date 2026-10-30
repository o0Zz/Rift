//! Everything agent-specific (Claude Code today, Codex/Gemini later) sits behind `AgentHarness`.

pub mod claude;

use std::path::Path;

use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// What an agent reported through its hook.
#[derive(Debug, Clone, PartialEq)]
pub enum AgentEvent {
    SessionStarted { session_id: String },
    SessionEnded { session_id: String },
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
    /// Translates a hook payload into an event; `None` for events Rift does not use.
    fn parse_hook(&self, payload: &Value) -> Option<AgentEvent>;
    /// Shell command resuming `session_id`; `None` if the id looks malformed.
    fn resume_command(&self, session_id: &str) -> Option<String>;
    /// Whether the agent is configured to call `exe hook <id>`.
    fn hooks_installed(&self, exe: &Path) -> bool;
    fn install_hooks(&self, exe: &Path) -> Result<()>;
}

pub struct Harnesses(pub Vec<Box<dyn AgentHarness>>);

impl Harnesses {
    pub fn get(&self, id: &str) -> Option<&dyn AgentHarness> {
        self.0.iter().find(|h| h.id() == id).map(|h| h.as_ref())
    }
}
