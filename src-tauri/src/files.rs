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
