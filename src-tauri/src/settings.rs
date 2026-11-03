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

    pub fn save(&self, settings: &Value) -> std::io::Result<()> {
        crate::files::write_atomic(&self.0, &serde_json::to_vec_pretty(settings)?)
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
    fn unreadable_file_means_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let file = SettingsFile(dir.path().join("settings.json"));
        std::fs::write(&file.0, "{ broken").unwrap();
        assert_eq!(file.load(), Value::Null);
    }
}
