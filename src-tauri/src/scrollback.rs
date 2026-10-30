//! Terminal history kept across restarts: one file per tab (its serialized screen, ANSI colors included),
//! written when Rift closes and read back when the tab is restored.

use std::path::PathBuf;

use anyhow::{Result, bail};

pub struct Scrollback(pub PathBuf);

/// Ids come from the frontend (UUIDs): nothing that could leave the folder.
fn valid(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

impl Scrollback {
    fn file(&self, id: &str) -> Result<PathBuf> {
        if !valid(id) {
            bail!("invalid scrollback id");
        }
        Ok(self.0.join(format!("{id}.ans")))
    }

    pub fn save(&self, id: &str, data: &str) -> Result<()> {
        let file = self.file(id)?;
        std::fs::create_dir_all(&self.0)?;
        std::fs::write(file, data)?;
        Ok(())
    }

    pub fn load(&self, id: &str) -> Option<String> {
        std::fs::read_to_string(self.file(id).ok()?).ok()
    }

    /// Deletes the histories of tabs that no longer exist.
    pub fn prune(&self, keep: &[String]) {
        let Ok(entries) = std::fs::read_dir(&self.0) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let id = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or_default();
            if path.extension().is_some_and(|e| e == "ans") && !keep.iter().any(|k| k == id) {
                let _ = std::fs::remove_file(path);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saves_loads_and_prunes() {
        let dir = tempfile::tempdir().unwrap();
        let s = Scrollback(dir.path().join("scrollback"));
        assert_eq!(s.load("a1"), None);
        s.save("a1", "\x1b[32mgreen\x1b[0m\r\nline 2").unwrap();
        s.save("b2", "other").unwrap();
        assert_eq!(
            s.load("a1").as_deref(),
            Some("\x1b[32mgreen\x1b[0m\r\nline 2")
        );
        s.prune(&["b2".into()]);
        assert_eq!(s.load("a1"), None);
        assert_eq!(s.load("b2").as_deref(), Some("other"));
    }

    #[test]
    fn rejects_ids_that_could_escape_the_folder() {
        let dir = tempfile::tempdir().unwrap();
        let s = Scrollback(dir.path().into());
        for id in ["../x", "a/b", "a\\b", "", "C:", &"x".repeat(65)] {
            assert!(s.save(id, "data").is_err(), "{id:?}");
            assert_eq!(s.load(id), None);
        }
    }
}
