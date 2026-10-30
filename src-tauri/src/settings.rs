//! User settings (theme, fonts, shortcuts): a JSON file the frontend owns the shape of.
//! Kept apart from session.json so it can be edited by hand.

use std::path::PathBuf;

use serde_json::Value;

pub struct SettingsFile(pub PathBuf);

impl SettingsFile {
    /// Saved settings, or `null` (frontend defaults) if missing or unreadable.
    pub fn load(&self) -> Value {
        std::fs::read_to_string(&self.0)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or(Value::Null)
    }

    pub fn save(&self, settings: &Value) -> std::io::Result<()> {
        if let Some(dir) = self.0.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = self.0.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(settings)?)?;
        std::fs::rename(tmp, &self.0)
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
