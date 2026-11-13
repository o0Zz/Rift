//! User settings (theme, fonts, shortcuts): a JSON file the frontend owns the shape of.
//! Kept apart from session.json so it can be edited by hand.

use std::path::PathBuf;

use serde_json::Value;

pub struct SettingsFile(pub PathBuf);

impl SettingsFile {
    /// Saved settings, or `null` (frontend defaults) if missing or unreadable.
    pub fn load(&self) -> Value {
        crate::files::read_json_or_default(&self.0)
    }

    /// Saves a changed value; the file it replaces goes to the rolling backups first.
    pub fn save(&self, settings: &Value) -> std::io::Result<()> {
        let json = serde_json::to_vec_pretty(settings)?;
        if std::fs::read(&self.0).is_ok_and(|old| old == json) {
            return Ok(());
        }
        crate::files::backup(&self.0)?;
        crate::files::write_atomic(&self.0, &json)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn saves_and_loads_settings() {
        let dir = tempfile::tempdir().unwrap();
        let file = SettingsFile(dir.path().join("sub").join("settings.json"));
        assert_eq!(file.load(), Value::Null);
        let s = json!({ "theme": "light", "keys": { "newTab": ["Ctrl+Shift+T"] } });
        file.save(&s).unwrap();
        assert_eq!(file.load(), s);
    }

    #[test]
    fn each_change_backs_up_the_previous_file() {
        let dir = tempfile::tempdir().unwrap();
        let file = SettingsFile(dir.path().join("prompts.json"));
        let backups = || {
            let mut v: Vec<String> = std::fs::read_dir(crate::files::backups_dir(&file.0))
                .map(|d| {
                    d.map(|e| std::fs::read_to_string(e.unwrap().path()).unwrap())
                        .collect()
                })
                .unwrap_or_default();
            v.sort();
            v
        };
        file.save(&json!({ "a": 1 })).unwrap();
        assert!(backups().is_empty(), "nothing to back up the first time");
        file.save(&json!({ "a": 1 })).unwrap();
        assert!(backups().is_empty(), "same content: no write, no copy");
        file.save(&json!({ "a": 2 })).unwrap();
        assert_eq!(
            backups(),
            [serde_json::to_string_pretty(&json!({ "a": 1 })).unwrap()]
        );
        assert_eq!(file.load(), json!({ "a": 2 }));
    }

    #[test]
    fn unreadable_file_means_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let file = SettingsFile(dir.path().join("settings.json"));
        std::fs::write(&file.0, "{ broken").unwrap();
        assert_eq!(file.load(), Value::Null);
    }
}
