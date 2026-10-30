//! File explorer backend: one directory level at a time, never a recursive walk.

use std::path::Path;

use serde::Serialize;

#[derive(Debug, PartialEq, Serialize)]
pub struct Entry {
    pub name: String,
    pub dir: bool,
}

/// Lists `dir`: folders first, then files, each alphabetically (case-insensitive). `.git` is hidden.
pub fn list(dir: &Path) -> std::io::Result<Vec<Entry>> {
    let mut entries: Vec<Entry> = std::fs::read_dir(dir)?
        .filter_map(Result::ok)
        .filter(|e| e.file_name() != ".git")
        .map(|e| Entry {
            name: e.file_name().to_string_lossy().into_owned(),
            dir: e.file_type().is_ok_and(|t| t.is_dir()),
        })
        .collect();
    entries.sort_by_key(|e| (!e.dir, e.name.to_lowercase()));
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_folders_first_and_hides_git() {
        let dir = tempfile::tempdir().unwrap();
        for d in [".git", "src", "Docs"] {
            std::fs::create_dir(dir.path().join(d)).unwrap();
        }
        for f in ["b.txt", "A.md"] {
            std::fs::write(dir.path().join(f), "").unwrap();
        }
        let names: Vec<_> = list(dir.path())
            .unwrap()
            .into_iter()
            .map(|e| (e.name, e.dir))
            .collect();
        assert_eq!(
            names,
            [
                ("Docs".into(), true),
                ("src".into(), true),
                ("A.md".into(), false),
                ("b.txt".into(), false)
            ]
        );
    }
}
