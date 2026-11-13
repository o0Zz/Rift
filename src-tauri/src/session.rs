//! What gets restored on next launch: the tabs (cwd, title) and the agent session running in each.
//! The frontend owns the tab list; agent bindings come from hooks. Written to disk on every change.

use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::agents::{AgentEvent, AgentSession};
use crate::pty::TabId;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct SavedTab {
    pub cwd: Option<String>,
    pub title: String,
    pub agent: Option<AgentSession>,
    /// Frontend-only tab data (name, color, group), stored as is.
    #[serde(default)]
    pub ui: Value,
}

#[derive(Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Saved {
    pub tabs: Vec<SavedTab>,
    pub active: usize,
    /// Frontend-only sidebar data (groups), stored as is.
    #[serde(default)]
    pub layout: Value,
}

/// What a freshly loaded page restores: the saved state, and what went wrong reading it (shown to the user).
#[derive(Debug, Serialize)]
pub struct Restored {
    #[serde(flatten)]
    pub saved: Saved,
    pub problem: Option<String>,
}

/// While tabs change, a backup at most this often: a burst (tabs closing one after another) keeps the
/// state from before it instead of rolling every copy out.
const BACKUP_EVERY: Duration = Duration::from_secs(60);

/// `rift.log` past this size starts over (the previous one kept as `rift.log.old`).
const LOG_MAX: u64 = 512 * 1024;

/// A tab as the frontend reports it. `pty` is unknown until its shell is open.
#[derive(Debug, Clone, Deserialize)]
pub struct TabInfo {
    pub pty: Option<TabId>,
    pub cwd: Option<String>,
    pub title: String,
    #[serde(default)]
    pub ui: Value,
}

#[derive(Default)]
struct Inner {
    tabs: Vec<TabInfo>,
    active: usize,
    layout: Value,
    agents: HashMap<TabId, AgentSession>,
    /// No write before the frontend reported its tabs, so a half-restored state never hits disk.
    initialized: bool,
    /// Set when the window closes: shells are about to die and their exit must not erase the state.
    frozen: bool,
    /// Tabs and groups as last written: a backup is taken only when they change (not the active tab).
    last_tabs: Vec<u8>,
    last_backup: Option<Instant>,
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

    /// The state saved on disk (tests: what the next run would restore).
    #[cfg(test)]
    pub fn load(&self) -> Saved {
        self.read().0
    }

    /// For a freshly loaded page, before the previous page's shells are closed: forgets that page's tabs
    /// (their agents' exit hooks must not rewrite the file with them), backs the file up, then reads it.
    pub fn restore(&self) -> Restored {
        let mut inner = self.inner.lock().unwrap();
        *inner = Inner {
            frozen: inner.frozen,
            last_backup: Some(Instant::now()),
            ..Inner::default()
        };
        drop(inner);
        let backed_up = crate::files::backup(&self.path);
        let (saved, problem) = self.read();
        let problem = problem.map(|p| match backed_up {
            Ok(()) => format!(
                "{p}. A copy of the file is in {}, with the previous ones.",
                crate::files::backups_dir(&self.path).display()
            ),
            Err(e) => format!("{p} (no backup: {e})."),
        });
        self.note(&format!(
            "page loaded: {} tabs to restore{}",
            saved.tabs.len(),
            problem
                .as_deref()
                .map_or(String::new(), |p| format!(" ({p})"))
        ));
        Restored { saved, problem }
    }

    /// The saved state, read tab by tab: a tab that does not parse is left out, not the whole session.
    fn read(&self) -> (Saved, Option<String>) {
        let Ok(text) = std::fs::read_to_string(&self.path) else {
            return (Saved::default(), None); // first run
        };
        let value = match serde_json::from_str::<Value>(&text) {
            Ok(v) if v.is_object() => v,
            Ok(_) => {
                return (
                    Saved::default(),
                    Some("session.json holds no session".into()),
                );
            }
            Err(e) => {
                return (
                    Saved::default(),
                    Some(format!("session.json could not be read ({e})")),
                );
            }
        };
        let all = value["tabs"].as_array().map_or(&[][..], Vec::as_slice);
        let tabs: Vec<SavedTab> = all
            .iter()
            .filter_map(|t| serde_json::from_value(t.clone()).ok())
            .collect();
        let lost = all.len() - tabs.len();
        let problem =
            (lost > 0).then(|| format!("{lost} of {} saved tabs could not be read", all.len()));
        let saved = Saved {
            tabs,
            active: value["active"].as_u64().unwrap_or(0) as usize,
            layout: value["layout"].clone(),
        };
        (saved, problem)
    }

    /// One line in `rift.log` (next to the session): rare events only, to tell later what happened to tabs.
    pub fn note(&self, line: &str) {
        let log = self.path.with_file_name("rift.log");
        if std::fs::metadata(&log).is_ok_and(|m| m.len() > LOG_MAX) {
            let _ = std::fs::rename(&log, log.with_extension("log.old"));
        }
        let stamp = crate::files::stamp(std::time::SystemTime::now());
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log)
        {
            let _ = writeln!(f, "{stamp} {line}");
        }
    }

    pub fn update_tabs(&self, tabs: Vec<TabInfo>, active: usize, layout: Value) {
        let mut inner = self.inner.lock().unwrap();
        if inner.frozen {
            return;
        }
        if inner.initialized && tabs.len() < inner.tabs.len() {
            self.note(&format!("tabs: {} -> {}", inner.tabs.len(), tabs.len()));
        }
        inner
            .agents
            .retain(|pty, _| tabs.iter().any(|t| t.pty == Some(*pty)));
        inner.tabs = tabs;
        inner.active = active;
        inner.layout = layout;
        inner.initialized = true;
        self.write(&mut inner);
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
            // Status changes are live-only, nothing to restore.
            _ => return,
        }
        self.write(&mut inner);
    }

    pub fn freeze(&self) {
        let mut inner = self.inner.lock().unwrap();
        if !inner.frozen {
            inner.frozen = true;
            self.note(&format!(
                "closing: session kept with {} tabs",
                inner.tabs.len()
            ));
        }
    }

    fn write(&self, inner: &mut Inner) {
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
                    ui: t.ui.clone(),
                })
                .collect(),
            active: inner.active,
            layout: inner.layout.clone(),
        };
        // The file about to be replaced goes to the backups when tabs or groups changed.
        let tabs = serde_json::to_vec(&(&saved.tabs, saved.layout.get("groups"))).unwrap();
        if tabs != inner.last_tabs {
            if inner
                .last_backup
                .is_none_or(|t| t.elapsed() >= BACKUP_EVERY)
            {
                if let Err(e) = crate::files::backup(&self.path) {
                    eprintln!("rift: could not back up the session: {e}");
                }
                inner.last_backup = Some(Instant::now());
            }
            inner.last_tabs = tabs;
        }
        let json = serde_json::to_vec_pretty(&saved).unwrap();
        if let Err(e) = crate::files::write_atomic(&self.path, &json) {
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
            ui: Value::Null,
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
        store.update_tabs(
            vec![tab(1, r"C:\a"), tab(2, r"C:\b"), tab(3, r"C:\c")],
            1,
            Value::Null,
        );
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
        store.update_tabs(vec![tab(1, "a")], 0, Value::Null);
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
        store.update_tabs(vec![tab(1, "a"), tab(2, "b")], 0, Value::Null);
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
        store.update_tabs(vec![], 0, Value::Null);
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
        store.update_tabs(vec![tab(5, "a"), tab(6, "b")], 0, Value::Null);
        assert_eq!(store.load().tabs[0].agent, agent("r"));
        store.update_tabs(vec![tab(6, "b")], 0, Value::Null);
        assert_eq!(
            store.load().tabs,
            [SavedTab {
                cwd: Some("b".into()),
                title: "t6".into(),
                agent: None,
                ui: Value::Null,
            }]
        );
    }

    #[test]
    fn keeps_frontend_ui_data_as_is() {
        let dir = tempfile::tempdir().unwrap();
        let store = SessionStore::new(dir.path().join("session.json"));
        let mut t = tab(1, "a");
        t.ui = serde_json::json!({ "name": "api", "color": "#e5534b", "group": "g1" });
        let layout = serde_json::json!({ "groups": [{ "id": "g1", "name": "Backend", "collapsed": false }] });
        store.update_tabs(vec![t], 0, layout.clone());
        let saved = store.load();
        assert_eq!(saved.tabs[0].ui["color"], "#e5534b");
        assert_eq!(saved.layout, layout);
    }

    #[test]
    fn status_events_do_not_rewrite_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.json");
        let store = SessionStore::new(path.clone());
        store.update_tabs(vec![tab(1, "a")], 0, Value::Null);
        std::fs::remove_file(&path).unwrap();
        store.agent_event(1, "claude", &AgentEvent::Working);
        store.agent_event(1, "claude", &AgentEvent::Done);
        assert!(!path.exists());
    }

    fn backups(path: &std::path::Path) -> Vec<Saved> {
        let mut files: Vec<_> = std::fs::read_dir(crate::files::backups_dir(path))
            .map(|d| d.map(|e| e.unwrap().path()).collect())
            .unwrap_or_default();
        files.sort();
        files
            .iter()
            .map(|f| crate::files::read_json_or_default(f))
            .collect()
    }

    #[test]
    fn a_reloaded_page_starts_clean_and_old_agent_exits_never_rewrite_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.json");
        let store = SessionStore::new(path.clone());
        store.update_tabs(vec![tab(1, "a"), tab(2, "b")], 0, Value::Null);
        store.agent_event(1, "claude", &started("s1"));

        // The page reloads: its shells are closed, so their agents end after the new page asked.
        let restored = store.restore();
        assert_eq!(restored.saved.tabs.len(), 2);
        assert_eq!(restored.problem, None);
        let ended = AgentEvent::SessionEnded {
            session_id: "s1".into(),
        };
        store.agent_event(1, "claude", &ended);
        assert_eq!(store.load().tabs[0].agent, agent("s1"), "still resumable");
        assert_eq!(backups(&path).len(), 1, "the file was backed up on load");
        let log = std::fs::read_to_string(dir.path().join("rift.log")).unwrap();
        assert!(log.contains("page loaded: 2 tabs to restore"), "{log}");
    }

    #[test]
    fn unreadable_tabs_are_left_out_and_reported() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.json");
        std::fs::write(
            &path,
            r#"{"tabs":[{"cwd":"a","title":"t","agent":null},{"cwd":5},{"cwd":"b","title":"u","agent":null}],
                "active":1,"layout":{"groups":[]}}"#,
        )
        .unwrap();
        let store = SessionStore::new(path.clone());
        let r = store.restore();
        assert_eq!(r.saved.tabs.len(), 2);
        assert_eq!(r.saved.active, 1);
        let problem = r.problem.unwrap();
        assert!(
            problem.starts_with("1 of 3 saved tabs could not be read"),
            "{problem}"
        );
        assert_eq!(backups(&path).len(), 1);

        std::fs::write(&path, "{ cut").unwrap();
        let r = store.restore();
        assert!(r.saved.tabs.is_empty());
        assert!(
            r.problem
                .unwrap()
                .starts_with("session.json could not be read")
        );
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "{ cut",
            "kept until the page saves"
        );
    }

    #[test]
    fn tab_changes_are_backed_up_at_most_once_a_minute_and_switches_never() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.json");
        let store = SessionStore::new(path.clone());
        let all = vec![tab(1, "a"), tab(2, "b"), tab(3, "c")];
        store.update_tabs(all.clone(), 0, Value::Null);
        assert!(backups(&path).is_empty(), "no file before the first write");
        // Switching tabs only changes `active`: never a backup.
        store.inner.lock().unwrap().last_backup = None;
        store.update_tabs(all.clone(), 2, Value::Null);
        assert!(backups(&path).is_empty());
        // Tabs closing one after another: one backup, the state before the burst.
        store.update_tabs(all[..2].to_vec(), 0, Value::Null);
        store.update_tabs(all[..1].to_vec(), 0, Value::Null);
        let b = backups(&path);
        assert_eq!(b.len(), 1);
        assert_eq!(b[0].tabs.len(), 3);
        // A minute later, the next change backs up again.
        store.inner.lock().unwrap().last_backup = Some(Instant::now() - BACKUP_EVERY);
        store.update_tabs(vec![], 0, Value::Null);
        assert_eq!(
            backups(&path)
                .iter()
                .map(|s| s.tabs.len())
                .collect::<Vec<_>>(),
            [3, 1]
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
