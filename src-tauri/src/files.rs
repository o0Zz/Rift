//! File explorer backend: one directory level at a time, never a recursive walk. Also the file helpers
//! Rift's own state files share.

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde::de::DeserializeOwned;

/// Writes `bytes` to `path` through `<path>.tmp` + rename: a crash mid-write never leaves a cut file.
/// Creates the parent folder if needed.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(tmp, path)
}

/// Rolling copies kept per state file (`backups/<stem>-<UTC time>.json`): a bad save can be undone by hand.
pub const BACKUPS_KEPT: usize = 20;

/// The folder holding the backups of the state file `path`.
pub fn backups_dir(path: &Path) -> PathBuf {
    path.with_file_name("backups")
}

/// Copies the state file `path` (if it exists) to its backups folder, keeping the newest `BACKUPS_KEPT`.
pub fn backup(path: &Path) -> std::io::Result<()> {
    let Ok(bytes) = std::fs::read(path) else {
        return Ok(()); // nothing saved yet
    };
    let dir = backups_dir(path);
    let stem = path.file_stem().unwrap_or_default().to_string_lossy();
    let name = format!("{stem}-{}.json", stamp(std::time::SystemTime::now()));
    write_atomic(&dir.join(name), &bytes)?;
    // Names sort by time: drop the oldest beyond the limit.
    let prefix = format!("{stem}-");
    let mut copies: Vec<PathBuf> = std::fs::read_dir(&dir)?
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| {
            p.file_name().is_some_and(|n| {
                let n = n.to_string_lossy();
                n.starts_with(&prefix) && n.ends_with(".json")
            })
        })
        .collect();
    copies.sort();
    let extra = copies.len().saturating_sub(BACKUPS_KEPT);
    for old in &copies[..extra] {
        let _ = std::fs::remove_file(old);
    }
    Ok(())
}

/// `2026-11-13_07-25-47-123Z` (UTC): sortable, valid in a file name on every OS.
pub fn stamp(t: std::time::SystemTime) -> String {
    let ms = t
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64);
    let (days, rest) = ((ms / 86_400_000) as i64, ms % 86_400_000);
    // Days since 1970-01-01 to a civil date (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    let (h, m, s, milli) = (
        rest / 3_600_000,
        rest / 60_000 % 60,
        rest / 1000 % 60,
        rest % 1000,
    );
    format!("{year:04}-{month:02}-{day:02}_{h:02}-{m:02}-{s:02}-{milli:03}Z")
}

/// The JSON file at `path`, or the default value if it is missing or unreadable.
pub fn read_json_or_default<T: DeserializeOwned + Default>(path: &Path) -> T {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

/// The per-user runtime folder when there is one (only this user can use it), else the temp folder.
pub fn runtime_dir() -> PathBuf {
    std::env::var_os("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
}

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

/// Bigger files open in the default app: the editor would hold them all in memory.
const MAX_TEXT: u64 = 5_000_000;

#[derive(Debug, PartialEq, Serialize)]
pub struct Text {
    pub text: String,
    /// Last modification (ms since the epoch), to notice changes made outside Rift.
    pub mtime: u64,
}

/// A text file to show in Rift, or None when it is not one (binary, not UTF-8, too big).
pub fn read_text(path: &Path) -> std::io::Result<Option<Text>> {
    let meta = std::fs::metadata(path)?;
    if meta.len() > MAX_TEXT {
        return Ok(None);
    }
    let bytes = std::fs::read(path)?;
    if bytes[..bytes.len().min(8000)].contains(&0) {
        return Ok(None);
    }
    Ok(String::from_utf8(bytes).ok().map(|text| Text {
        text,
        mtime: millis(&meta),
    }))
}

/// Writes `text` as is (the caller keeps the file's line endings) and returns the new mtime.
pub fn write_text(path: &Path, text: &str) -> std::io::Result<u64> {
    std::fs::write(path, text)?;
    mtime(path)
}

pub fn mtime(path: &Path) -> std::io::Result<u64> {
    Ok(millis(&std::fs::metadata(path)?))
}

fn millis(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as u64)
}

/// Moves a file or folder to the Recycle Bin / Trash (never a permanent delete: a misclick can be undone).
pub fn trash(path: &Path) -> Result<(), trash::Error> {
    #[allow(unused_mut)]
    let mut trash = trash::TrashContext::default();
    // Finder (the default) needs automation rights and plays a sound; the file manager API needs neither.
    #[cfg(target_os = "macos")]
    {
        use trash::macos::{DeleteMethod, TrashContextExtMacos};
        trash.set_delete_method(DeleteMethod::NsFileManager);
    }
    trash.delete(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stamps_are_utc_and_sortable() {
        let at = |ms: u64| stamp(std::time::UNIX_EPOCH + std::time::Duration::from_millis(ms));
        assert_eq!(at(0), "1970-01-01_00-00-00-000Z");
        // 2026-11-13T07:25:47.123Z
        assert_eq!(at(1_794_554_747_123), "2026-11-13_07-25-47-123Z");
        assert_eq!(at(951_782_400_000), "2000-02-29_00-00-00-000Z");
    }

    #[test]
    fn backups_roll_and_keep_the_newest() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.json");
        backup(&path).unwrap(); // nothing saved yet: no copy
        assert!(!backups_dir(&path).exists());
        // Another state file's copies share the folder and are never pruned with these.
        std::fs::create_dir_all(backups_dir(&path)).unwrap();
        std::fs::write(
            backups_dir(&path).join("settings-1970-01-01_00-00-00-000Z.json"),
            "{}",
        )
        .unwrap();
        for i in 0..BACKUPS_KEPT + 5 {
            std::fs::write(&path, format!("{{\"n\":{i}}}")).unwrap();
            backup(&path).unwrap();
            std::thread::sleep(std::time::Duration::from_millis(2)); // distinct names
        }
        let mut names: Vec<String> = std::fs::read_dir(backups_dir(&path))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(names.len(), BACKUPS_KEPT + 1);
        assert!(names.contains(&"settings-1970-01-01_00-00-00-000Z.json".into()));
        let oldest = names.iter().find(|n| n.starts_with("session-")).unwrap();
        let first = std::fs::read_to_string(backups_dir(&path).join(oldest)).unwrap();
        assert_eq!(first, "{\"n\":5}", "the 5 oldest copies are gone");
    }

    #[test]
    fn trash_moves_files_and_folders_away() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("rift-trash-test.txt");
        let folder = dir.path().join("rift-trash-test");
        std::fs::write(&file, "x").unwrap();
        std::fs::create_dir(&folder).unwrap();
        std::fs::write(folder.join("inner.txt"), "y").unwrap();

        trash(&file).unwrap();
        trash(&folder).unwrap();
        assert!(!file.exists() && !folder.exists());
        assert!(trash(&file).is_err(), "nothing left to delete");
    }

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

    #[test]
    fn reads_and_writes_text_keeping_line_endings() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.cpp");
        std::fs::write(&path, "int a;\r\nint b; // é\r\n").unwrap();
        let read = read_text(&path).unwrap().unwrap();
        assert_eq!(read.text, "int a;\r\nint b; // é\r\n");
        assert!(read.mtime > 0);
        let mtime = write_text(&path, "x\r\n").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"x\r\n");
        assert_eq!(mtime, super::mtime(&path).unwrap());
    }

    #[test]
    fn binary_latin1_and_huge_files_are_not_text() {
        let dir = tempfile::tempdir().unwrap();
        let cases: [(&str, Vec<u8>); 3] = [
            ("a.png", b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec()),
            ("latin1.cs", b"// caf\xe9".to_vec()),
            ("huge.log", vec![b'x'; MAX_TEXT as usize + 1]),
        ];
        for (name, bytes) in cases {
            let path = dir.path().join(name);
            std::fs::write(&path, bytes).unwrap();
            assert_eq!(read_text(&path).unwrap(), None, "{name}");
        }
        assert!(read_text(&dir.path().join("missing.txt")).is_err());
    }
}
