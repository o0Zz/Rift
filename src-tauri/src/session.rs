//! What gets restored on next launch: the tabs (cwd, title) and the agent session running in each.
//! The frontend owns the tab list; agent bindings come from hooks. Written to disk on every change.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::agents::{AgentEvent, AgentSession};
use crate::pty::TabId;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct SavedTab {
    pub cwd: Option<String>,
    pub title: String,
    pub agent: Option<AgentSession>,
}

#[derive(Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Saved {
    pub tabs: Vec<SavedTab>,
    pub active: usize,
}

/// A tab as the frontend reports it. `pty` is unknown until its shell is open.
#[derive(Debug, Clone, Deserialize)]
pub struct TabInfo {
    pub pty: Option<TabId>,
    pub cwd: Option<String>,
    pub title: String,
}

#[derive(Default)]
struct Inner {
    tabs: Vec<TabInfo>,
    active: usize,
    agents: HashMap<TabId, AgentSession>,
    /// No write before the frontend reported its tabs, so a half-restored state never hits disk.
    initialized: bool,
    /// Set when the window closes: shells are about to die and their exit must not erase the state.
    frozen: bool,
}

pub struct SessionStore {
    path: PathBuf,
    inner: Mutex<Inner>,
}

impl SessionStore {
    pub fn new(path: PathBuf) -> Self {
        SessionStore {
            path,
            inner: Mutex::default(),
        }
    }

    /// The state saved by the previous run (empty if none or unreadable).
    pub fn load(&self) -> Saved {
        std::fs::read_to_string(&self.path)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default()
    }

    pub fn update_tabs(&self, tabs: Vec<TabInfo>, active: usize) {
        let mut inner = self.inner.lock().unwrap();
        if inner.frozen {
            return;
        }
        inner
            .agents
            .retain(|pty, _| tabs.iter().any(|t| t.pty == Some(*pty)));
        inner.tabs = tabs;
        inner.active = active;
        inner.initialized = true;
        self.write(&inner);
    }

    /// Binds a resumed session to its new shell before the agent reports it, so it survives an early close.
    pub fn bind(&self, pty: TabId, agent: AgentSession) {
        let mut inner = self.inner.lock().unwrap();
        if !inner.frozen {
            inner.agents.insert(pty, agent);
        }
    }

    pub fn agent_event(&self, pty: TabId, harness: &str, event: &AgentEvent) {
        let mut inner = self.inner.lock().unwrap();
        if inner.frozen {
            return;
        }
        match event {
            AgentEvent::SessionStarted { session_id } => {
                let agent = AgentSession {
                    harness: harness.into(),
                    session_id: session_id.clone(),
                };
                inner.agents.insert(pty, agent);
            }
            // Only the session still bound: after /clear the new session starts before the old one ends.
            AgentEvent::SessionEnded { session_id } => {
                if inner
                    .agents
                    .get(&pty)
                    .is_some_and(|a| &a.session_id == session_id)
                {
                    inner.agents.remove(&pty);
                }
            }
        }
        self.write(&inner);
    }

    pub fn freeze(&self) {
        self.inner.lock().unwrap().frozen = true;
    }

    fn write(&self, inner: &Inner) {
        if !inner.initialized {
            return;
        }
        let saved = Saved {
            tabs: inner
                .tabs
                .iter()
                .map(|t| SavedTab {
                    cwd: t.cwd.clone(),
                    title: t.title.clone(),
                    agent: t.pty.and_then(|p| inner.agents.get(&p).cloned()),
                })
                .collect(),
            active: inner.active,
        };
        // Write-then-rename so a crash mid-write never leaves a truncated file.
        let tmp = self.path.with_extension("json.tmp");
        let result = std::fs::create_dir_all(self.path.parent().unwrap())
            .and_then(|_| std::fs::write(&tmp, serde_json::to_vec_pretty(&saved).unwrap()))
            .and_then(|_| std::fs::rename(&tmp, &self.path));
        if let Err(e) = result {
            eprintln!("rift: could not save session: {e}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tab(pty: TabId, cwd: &str) -> TabInfo {
        TabInfo {
            pty: Some(pty),
            cwd: Some(cwd.into()),
            title: format!("t{pty}"),
        }
    }

    fn started(id: &str) -> AgentEvent {
        AgentEvent::SessionStarted {
            session_id: id.into(),
        }
    }

    fn agent(id: &str) -> Option<AgentSession> {
        Some(AgentSession {
            harness: "claude".into(),
            session_id: id.into(),
        })
    }

    #[test]
    fn saves_tabs_with_their_agent_sessions_and_reloads_them() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.json");
        let store = SessionStore::new(path.clone());
        store.update_tabs(vec![tab(1, r"C:\a"), tab(2, r"C:\b"), tab(3, r"C:\c")], 1);
        store.agent_event(1, "claude", &started("s1"));
        store.agent_event(3, "claude", &started("s3"));

        let saved = SessionStore::new(path).load();
        assert_eq!(saved.active, 1);
        let agents: Vec<_> = saved.tabs.iter().map(|t| t.agent.clone()).collect();
        assert_eq!(agents, [agent("s1"), None, agent("s3")]);
        assert_eq!(saved.tabs[1].cwd.as_deref(), Some(r"C:\b"));
    }

    #[test]
    fn session_end_unbinds_only_the_matching_session() {
        let dir = tempfile::tempdir().unwrap();
        let store = SessionStore::new(dir.path().join("session.json"));
        store.update_tabs(vec![tab(1, "a")], 0);
        // /clear: new session starts, then the old one ends.
        store.agent_event(1, "claude", &started("old"));
        store.agent_event(1, "claude", &started("new"));
        store.agent_event(
            1,
            "claude",
            &AgentEvent::SessionEnded {
                session_id: "old".into(),
            },
        );
        assert_eq!(store.load().tabs[0].agent, agent("new"));
        // Exiting claude.
        store.agent_event(
            1,
            "claude",
            &AgentEvent::SessionEnded {
                session_id: "new".into(),
            },
        );
        assert_eq!(store.load().tabs[0].agent, None);
    }

    #[test]
    fn closing_the_window_keeps_sessions() {
        let dir = tempfile::tempdir().unwrap();
        let store = SessionStore::new(dir.path().join("session.json"));
        store.update_tabs(vec![tab(1, "a"), tab(2, "b")], 0);
        store.agent_event(1, "claude", &started("s1"));
        store.freeze();
        // Shells being killed: agent exits and tabs disappear.
        store.agent_event(
            1,
            "claude",
            &AgentEvent::SessionEnded {
                session_id: "s1".into(),
            },
        );
        store.update_tabs(vec![], 0);
        let saved = store.load();
        assert_eq!(saved.tabs.len(), 2);
        assert_eq!(saved.tabs[0].agent, agent("s1"));
    }

    #[test]
    fn closed_tab_drops_its_agent_and_bound_resume_survives() {
        let dir = tempfile::tempdir().unwrap();
        let store = SessionStore::new(dir.path().join("session.json"));
        // Restored tab: bound before the frontend reports it, then reported.
        store.bind(
            5,
            AgentSession {
                harness: "claude".into(),
                session_id: "r".into(),
            },
        );
        store.update_tabs(vec![tab(5, "a"), tab(6, "b")], 0);
        assert_eq!(store.load().tabs[0].agent, agent("r"));
        store.update_tabs(vec![tab(6, "b")], 0);
        assert_eq!(
            store.load().tabs,
            [SavedTab {
                cwd: Some("b".into()),
                title: "t6".into(),
                agent: None
            }]
        );
    }

    #[test]
    fn nothing_written_before_frontend_reports_tabs() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.json");
        std::fs::write(
            &path,
            r#"{"tabs":[{"cwd":"x","title":"t","agent":null}],"active":0}"#,
        )
        .unwrap();
        let store = SessionStore::new(path);
        store.agent_event(1, "claude", &started("s"));
        assert_eq!(store.load().tabs.len(), 1);
    }
}
