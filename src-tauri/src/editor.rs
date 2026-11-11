//! The user's external editor (Settings → General): opens a file, or an empty document, outside Rift.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use anyhow::{Context, Result, bail};

/// The program and the arguments before the file. `editor` is a program name on PATH or its full path;
/// empty = automatic: Notepad++ if installed, else Notepad (Windows); TextEdit (macOS); the default app (Linux).
fn command_for(editor: &str, file: Option<&Path>) -> Result<(PathBuf, Vec<String>)> {
    let editor = editor.trim();
    if !editor.is_empty() {
        let program = if editor.contains(['/', '\\']) {
            PathBuf::from(editor)
        } else {
            crate::process::find_program(editor)
        };
        return Ok((program, vec![]));
    }
    if cfg!(windows) {
        return Ok((
            notepad_plus_plus().unwrap_or_else(|| "notepad.exe".into()),
            vec![],
        ));
    }
    if cfg!(target_os = "macos") {
        // -t: the default text editor; without a file, TextEdit itself.
        let args = if file.is_some() {
            vec!["-t"]
        } else {
            vec!["-a", "TextEdit"]
        };
        return Ok(("open".into(), args.into_iter().map(String::from).collect()));
    }
    if file.is_some() {
        return Ok(("xdg-open".into(), vec![]));
    }
    bail!("choose an editor in Settings → General")
}

/// Notepad++'s usual install folders.
fn notepad_plus_plus() -> Option<PathBuf> {
    ["ProgramFiles", "ProgramFiles(x86)"]
        .iter()
        .filter_map(std::env::var_os)
        .map(|dir| Path::new(&dir).join("Notepad++").join("notepad++.exe"))
        .find(|p| p.is_file())
}

/// Starts the editor on `file` (or empty) in `cwd` and returns at once: Rift never waits for it.
pub fn open(editor: &str, file: Option<&Path>, cwd: Option<&Path>) -> Result<()> {
    let (program, args) = command_for(editor, file)?;
    let mut cmd = crate::process::command(&program);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Some(file) = file {
        cmd.arg(file);
    }
    if let Some(dir) = cwd.filter(|d| d.is_dir()) {
        cmd.current_dir(dir);
    }
    let mut child = cmd
        .spawn()
        .with_context(|| format!("could not start {}", program.display()))?;
    // Reaped when it exits (no zombie on Unix).
    std::thread::spawn(move || child.wait());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    #[test]
    fn automatic_editor_per_os() {
        let (program, _) = command_for(" ", Some(Path::new("a.txt"))).unwrap();
        let name = program
            .file_name()
            .unwrap()
            .to_string_lossy()
            .to_lowercase();
        if cfg!(windows) {
            assert!(name == "notepad.exe" || name == "notepad++.exe", "{name}");
        } else if cfg!(target_os = "macos") {
            assert_eq!(name, "open");
        } else {
            assert_eq!(name, "xdg-open");
            assert!(command_for("", None).is_err());
        }
    }

    #[test]
    fn chosen_editor_by_name_or_path() {
        let path = if cfg!(windows) {
            r"C:\Tools\ed.exe"
        } else {
            "/opt/ed"
        };
        assert_eq!(command_for(path, None).unwrap().0, PathBuf::from(path));
        assert_eq!(
            command_for(" nosuch-editor ", None).unwrap(),
            ("nosuch-editor".into(), vec![])
        );
    }

    #[test]
    fn opens_the_file_with_the_chosen_editor() {
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().join("out.txt");
        let file = dir.path().join("my notes & todo.txt");
        // A script standing in for the editor writes the file it was given.
        #[cfg(windows)]
        let editor = {
            let s = dir.path().join("editor.cmd");
            // %1 keeps its quotes: the `&` stays text.
            std::fs::write(
                &s,
                format!(
                    "@echo %1> \"{}\"
",
                    out.display()
                ),
            )
            .unwrap();
            s
        };
        #[cfg(unix)]
        let editor = {
            use std::os::unix::fs::PermissionsExt;
            let s = dir.path().join("editor.sh");
            let script = format!(
                "#!/bin/sh
printf '%s' \"$1\" > '{}'
",
                out.display()
            );
            std::fs::write(&s, script).unwrap();
            std::fs::set_permissions(&s, std::fs::Permissions::from_mode(0o755)).unwrap();
            s
        };
        open(&editor.to_string_lossy(), Some(&file), Some(dir.path())).unwrap();
        let start = Instant::now();
        let got = loop {
            if let Ok(s) = std::fs::read_to_string(&out)
                && !s.is_empty()
            {
                break s;
            }
            assert!(
                start.elapsed() < Duration::from_secs(10),
                "the editor never ran"
            );
            std::thread::sleep(Duration::from_millis(50));
        };
        assert_eq!(got.trim().trim_matches('"'), file.to_string_lossy());
    }

    #[test]
    fn missing_editor_is_an_error() {
        assert!(open("rift-no-such-editor", None, None).is_err());
    }
}
