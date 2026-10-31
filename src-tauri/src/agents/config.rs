//! Shared by the adapters: agent config files with Claude-style hooks, Rift's hook command line, one-shot runs.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use serde_json::{Map, Value, json};

/// A JSON config file; `{}` when it does not exist yet.
pub fn read_json(path: &Path) -> Result<Value> {
    match std::fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text)
            .with_context(|| format!("{} is not valid JSON", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        Err(e) => Err(e.into()),
    }
}

/// Writes `value`, the previous file saved next to it as `<name>.bak`.
pub fn write_json(path: &Path, value: &Value) -> Result<()> {
    if path.exists() {
        let mut bak = path.as_os_str().to_owned();
        bak.push(".bak");
        std::fs::copy(path, PathBuf::from(bak))?;
    } else if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(path, serde_json::to_string_pretty(value)? + "\n")?;
    Ok(())
}

/// Whether every event of `settings["hooks"]` (Claude's shape: event → groups → hooks) holds `wanted`.
pub fn has_hooks(settings: &Value, events: &[&str], wanted: &Value) -> bool {
    events.iter().all(|event| {
        settings["hooks"][event].as_array().is_some_and(|groups| {
            groups
                .iter()
                .any(|g| g["hooks"].as_array().is_some_and(|hs| hs.contains(wanted)))
        })
    })
}

/// Adds `handler` to each event, replacing an older Rift entry for agent `id` (e.g. another exe path).
/// The user's other hooks and settings are kept, in order.
pub fn add_hooks(settings: &mut Value, events: &[&str], handler: &Value, id: &str) -> Result<()> {
    let root = settings
        .as_object_mut()
        .context("the settings file is not a JSON object")?;
    let hooks = root.entry("hooks").or_insert_with(|| json!({}));
    let hooks = hooks
        .as_object_mut()
        .context("\"hooks\" is not an object")?;
    for event in events {
        let groups = hooks.entry(*event).or_insert_with(|| json!([]));
        let groups = groups
            .as_array_mut()
            .context("hook event is not an array")?;
        for group in groups.iter_mut() {
            if let Some(hs) = group.get_mut("hooks").and_then(Value::as_array_mut) {
                hs.retain(|h| !is_ours(h, id));
            }
        }
        groups.retain(|g| g["hooks"].as_array().is_none_or(|hs| !hs.is_empty()));
        let mut group = Map::new();
        group.insert("hooks".into(), json!([handler]));
        groups.push(Value::Object(group));
    }
    Ok(())
}

/// Whether `path` is Rift's executable, whatever the install folder: `rift.exe` on Windows, `rift` elsewhere.
pub fn is_rift(path: &str) -> bool {
    let name = path.rsplit(['/', '\\']).next().unwrap_or(path);
    name.eq_ignore_ascii_case("rift") || name.eq_ignore_ascii_case("rift.exe")
}

/// Whether a hook entry is Rift's for agent `id`: exec form (`command`/`exec` + `args: ["hook", id]`) or a
/// shell command line from `hook_command`.
pub fn is_ours(handler: &Value, id: &str) -> bool {
    if handler["args"] == json!(["hook", id]) {
        let exe = handler["command"].as_str().or(handler["exec"].as_str());
        return exe.is_some_and(is_rift);
    }
    handler["args"].is_null()
        && handler["command"].as_str().is_some_and(|c| {
            c.strip_suffix(&format!(" hook {id}"))
                .is_some_and(|exe| is_rift(exe.trim_start_matches("& ").trim_matches(['"', '\''])))
        })
}

/// The shell an agent runs its hook command lines with.
#[derive(Clone, Copy)]
pub enum HookShell {
    PowerShell,
    Cmd,
    Posix,
}

/// `rift hook <id>` as a command line for agents that only take a shell string, with the exe path quoted.
pub fn hook_command(exe: &Path, id: &str, shell: HookShell) -> String {
    let path = exe.to_string_lossy();
    match shell {
        // A quoted path is a string to PowerShell: the call operator runs it.
        HookShell::PowerShell => format!("& '{}' hook {id}", path.replace('\'', "''")),
        HookShell::Cmd => format!("\"{path}\" hook {id}"),
        HookShell::Posix => format!("'{}' hook {id}", path.replace('\'', r"'\''")),
    }
}

/// Session ids handed to a resume command line: letters, digits, `-` and `_` only (no shell syntax).
pub fn safe_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Finds `name` on PATH. On Windows npm installs agents as `.cmd` shims, which `Command` does not look for.
fn program(name: &str) -> PathBuf {
    if cfg!(windows)
        && let Some(paths) = std::env::var_os("PATH")
    {
        for dir in std::env::split_paths(&paths) {
            for ext in ["exe", "cmd", "bat"] {
                let candidate = dir.join(format!("{name}.{ext}"));
                if candidate.is_file() {
                    return candidate;
                }
            }
        }
    }
    PathBuf::from(name)
}

/// Runs `name args` in `cwd` without a window, `input` on stdin; its stdout, trimmed.
pub fn run(name: &str, args: &[&str], cwd: &Path, input: &str) -> Result<String> {
    use std::io::Write;
    use std::process::{Command, Stdio};
    let mut cmd = Command::new(program(name));
    cmd.current_dir(cwd)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = cmd
        .spawn()
        .with_context(|| format!("could not run `{name}` (is it installed and on PATH?)"))?;
    let mut stdin = child.stdin.take().unwrap();
    let input = input.to_string();
    // Write from another thread: a large diff must not deadlock against the agent's own output.
    let writer = std::thread::spawn(move || stdin.write_all(input.as_bytes()));
    let out = child.wait_with_output()?;
    let _ = writer.join();
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let err = if err.trim().is_empty() {
            String::from_utf8_lossy(&out.stdout)
        } else {
            err
        };
        bail!("{name} failed: {}", err.trim());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_rift_hook_entries_in_every_form() {
        let exe = Path::new(r"C:\Program Files\Rift\rift.exe");
        for shell in [HookShell::PowerShell, HookShell::Cmd, HookShell::Posix] {
            let h = json!({ "type": "command", "command": hook_command(exe, "gemini", shell) });
            assert!(is_ours(&h, "gemini"), "{h}");
            assert!(!is_ours(&h, "codex"), "{h}");
        }
        assert!(is_ours(
            &json!({ "exec": "/usr/bin/rift", "args": ["hook", "copilot"] }),
            "copilot"
        ));
        assert!(!is_ours(
            &json!({ "command": "'/usr/bin/drift' hook gemini" }),
            "gemini"
        ));
        assert!(!is_ours(&json!({ "command": "echo hi" }), "gemini"));
    }

    #[test]
    fn hook_command_lines_quote_the_path() {
        let exe = Path::new("/opt/it's/rift");
        assert_eq!(
            hook_command(exe, "codex", HookShell::Posix),
            r"'/opt/it'\''s/rift' hook codex"
        );
        let exe = Path::new(r"C:\A B\rift.exe");
        assert_eq!(
            hook_command(exe, "gemini", HookShell::PowerShell),
            r"& 'C:\A B\rift.exe' hook gemini"
        );
        assert_eq!(
            hook_command(exe, "codex", HookShell::Cmd),
            r#""C:\A B\rift.exe" hook codex"#
        );
    }

    /// The hook command lines run through the real shells the agents use, with a space in the exe path.
    #[test]
    fn hook_command_lines_run_the_exe_in_real_shells() {
        use std::process::Command;
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("My Apps");
        std::fs::create_dir(&folder).unwrap();
        let out = |cmd: &mut Command| {
            String::from_utf8_lossy(&cmd.output().unwrap().stdout)
                .trim()
                .to_string()
        };
        #[cfg(windows)]
        {
            // A batch file standing in for rift.exe: prints its arguments.
            let exe = folder.join("rift.cmd");
            std::fs::write(&exe, "@echo %*\r\n").unwrap();
            // Gemini: PowerShell -Command <line>.
            let line = hook_command(&exe, "gemini", HookShell::PowerShell);
            let ps = Command::new("powershell")
                .args(["-NoProfile", "-NonInteractive", "-Command", &line])
                .output()
                .unwrap();
            assert_eq!(
                String::from_utf8_lossy(&ps.stdout).trim(),
                "hook gemini",
                "{line}"
            );
            // Codex: cmd /C "<line>", passed raw.
            use std::os::windows::process::CommandExt;
            let line = hook_command(&exe, "codex", HookShell::Cmd);
            let got = out(Command::new("cmd").arg("/C").raw_arg(format!("\"{line}\"")));
            assert_eq!(got, "hook codex", "{line}");
        }
        #[cfg(unix)]
        {
            let exe = folder.join("rift");
            std::fs::write(&exe, "#!/bin/sh\necho \"$@\"\n").unwrap();
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).unwrap();
            let line = hook_command(&exe, "gemini", HookShell::Posix);
            assert_eq!(
                out(Command::new("sh").args(["-c", &line])),
                "hook gemini",
                "{line}"
            );
        }
    }

    #[test]
    fn safe_ids_only() {
        assert!(safe_id("019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a5b"));
        assert!(safe_id("thr_example"));
        assert!(!safe_id("x; rm -rf ~"));
        assert!(!safe_id("$(id)"));
        assert!(!safe_id(""));
    }

    #[test]
    fn writes_a_backup_of_the_previous_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sub").join("hooks.json");
        write_json(&path, &json!({ "a": 1 })).unwrap();
        assert!(!dir.path().join("sub").join("hooks.json.bak").exists());
        write_json(&path, &json!({ "a": 2 })).unwrap();
        assert_eq!(read_json(&path).unwrap(), json!({ "a": 2 }));
        let bak = std::fs::read_to_string(dir.path().join("sub").join("hooks.json.bak")).unwrap();
        assert!(bak.contains("\"a\": 1"), "{bak}");
    }

    #[test]
    fn runs_a_program_with_stdin() {
        let dir = tempfile::tempdir().unwrap();
        let out = if cfg!(windows) {
            run("findstr", &["x"], dir.path(), "axb\nnope\n").unwrap()
        } else {
            run("grep", &["x"], dir.path(), "axb\nnope\n").unwrap()
        };
        assert_eq!(out, "axb");
        assert!(
            run("rift-no-such-agent", &[], dir.path(), "")
                .unwrap_err()
                .to_string()
                .contains("rift-no-such-agent")
        );
    }
}
