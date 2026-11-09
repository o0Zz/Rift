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

/// Writes `value`, the previous file saved next to it as `<name>.bak`. Temp file + rename: a crash never
/// leaves the agent a half-written config.
pub fn write_json(path: &Path, value: &Value) -> Result<()> {
    if path.exists() {
        let mut bak = path.as_os_str().to_owned();
        bak.push(".bak");
        std::fs::copy(path, bak)?;
    }
    let text = serde_json::to_string_pretty(value)? + "\n";
    crate::files::write_atomic(path, text.as_bytes())?;
    Ok(())
}

/// Whether the Claude-style hooks file at `path` holds `handler` for every event.
pub fn hooks_installed(path: &Path, events: &[&str], handler: &Value) -> bool {
    read_json(path).is_ok_and(|s| has_hooks(&s, events, handler))
}

/// Adds `handler` to every event of the Claude-style hooks file at `path` (see `add_hooks`).
pub fn install_hooks(path: &Path, events: &[&str], handler: &Value, id: &str) -> Result<()> {
    let mut settings = read_json(path)?;
    add_hooks(&mut settings, events, handler, id)?;
    write_json(path, &settings)
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
fn is_ours(handler: &Value, id: &str) -> bool {
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
        HookShell::PowerShell => {
            let quoted: String = path
                .chars()
                .flat_map(|c| {
                    let quote =
                        matches!(c, '\'' | '\u{2018}' | '\u{2019}' | '\u{201A}' | '\u{201B}');
                    std::iter::repeat_n(c, if quote { 2 } else { 1 })
                })
                .collect();
            format!("& '{quoted}' hook {id}")
        }
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

/// How long a one-shot agent run may take (e.g. stuck on a login or an approval).
const RUN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

/// Runs `name args` in `cwd` without a window, `input` on stdin; its stdout, trimmed.
pub fn run(name: &str, args: &[&str], cwd: &Path, input: &str) -> Result<String> {
    run_for(name, args, cwd, input, RUN_TIMEOUT)
}

/// `run`, killed (with its children: npm shims start node) after `timeout`.
fn run_for(
    name: &str,
    args: &[&str],
    cwd: &Path,
    input: &str,
    timeout: std::time::Duration,
) -> Result<String> {
    let mut cmd = crate::process::command(program(name));
    cmd.current_dir(cwd).args(args);
    let out = crate::process::output(cmd, input.as_bytes(), timeout, name)?;
    if !out.status.success() {
        bail!("{name} failed: {}", crate::process::failure_text(&out));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Rift's MCP server (agent messaging) as a JSON config entry: `exe mcp`, plus `extra` fields.
pub fn mcp_json(exe: &Path, extra: Value) -> Value {
    let mut entry = json!({ "command": exe.to_string_lossy(), "args": ["mcp"] });
    if let (Some(e), Value::Object(more)) = (entry.as_object_mut(), extra) {
        e.extend(more);
    }
    entry
}

/// Whether `mcpServers.rift` of the JSON file at `path` runs `exe mcp`.
pub fn mcp_json_installed(path: &Path, exe: &Path) -> bool {
    read_json(path).is_ok_and(|v| {
        let entry = &v["mcpServers"]["rift"];
        entry["command"].as_str() == Some(&*exe.to_string_lossy())
            && entry["args"] == json!(["mcp"])
    })
}

/// Sets (`Some`) or removes `mcpServers.rift` in the JSON file at `path`; everything else is kept.
pub fn set_mcp_json(path: &Path, entry: Option<Value>) -> Result<()> {
    let mut settings = read_json(path)?;
    let root = settings
        .as_object_mut()
        .context("the settings file is not a JSON object")?;
    if entry.is_none()
        && root
            .get("mcpServers")
            .is_none_or(|s| s.get("rift").is_none())
    {
        return Ok(()); // nothing to remove: the file stays untouched
    }
    let servers = root.entry("mcpServers").or_insert_with(|| json!({}));
    let servers = servers
        .as_object_mut()
        .context("\"mcpServers\" is not an object")?;
    match entry {
        Some(e) => {
            servers.insert("rift".into(), e);
        }
        None => {
            servers.remove("rift");
        }
    }
    write_json(path, &settings)
}

/// Rift's MCP server as a Codex `config.toml` table. Codex passes MCP servers only a few variables:
/// `env_vars` forwards the two that name the tab and the Rift instance.
pub fn mcp_toml(exe: &Path) -> String {
    // A JSON string is a valid TOML basic string.
    let command = serde_json::to_string(&exe.to_string_lossy()).unwrap_or_default();
    format!(
        "[mcp_servers.rift]\ncommand = {command}\nargs = [\"mcp\"]\nenv_vars = [\"RIFT_TAB_ID\", \"RIFT_PIPE\"]\n"
    )
}

/// `text` (a TOML file) without the `[mcp_servers.rift]` table and its sub-tables, then `table` if any.
pub fn with_mcp_toml(text: &str, table: Option<&str>) -> String {
    let mut out = String::new();
    let mut skipping = false;
    for line in text.lines() {
        let head = line.trim();
        if head.starts_with('[') {
            let name = head.trim_matches(['[', ']']).trim();
            skipping = name == "mcp_servers.rift" || name.starts_with("mcp_servers.rift.");
        }
        if !skipping {
            out.push_str(line);
            out.push('\n');
        }
    }
    if let Some(table) = table {
        if !out.is_empty() && !out.ends_with("\n\n") {
            out.push('\n');
        }
        out.push_str(table);
    }
    out
}

/// Sets (`Some(exe)`) or removes Rift's table in the Codex config at `path` (previous file kept as `.bak`).
pub fn set_mcp_toml(path: &Path, exe: Option<&Path>) -> Result<()> {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(e.into()),
    };
    let next = with_mcp_toml(&text, exe.map(mcp_toml).as_deref());
    if next == text {
        return Ok(());
    }
    if path.exists() {
        let mut bak = path.as_os_str().to_owned();
        bak.push(".bak");
        std::fs::copy(path, bak)?;
    }
    crate::files::write_atomic(path, next.as_bytes())?;
    Ok(())
}

/// Whether the Codex config at `path` holds Rift's table for `exe`.
pub fn mcp_toml_installed(path: &Path, exe: &Path) -> bool {
    std::fs::read_to_string(path).is_ok_and(|t| t.replace("\r\n", "\n").contains(&mcp_toml(exe)))
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
        let exec = |cmd: &str| {
            is_ours(
                &json!({ "command": cmd, "args": ["hook", "claude"] }),
                "claude",
            )
        };
        assert!(exec(r"C:\Users\me\AppData\Local\Rift\rift.exe"));
        assert!(exec("/usr/bin/rift"));
        assert!(exec("/Applications/Rift.app/Contents/MacOS/rift"));
        assert!(!exec("/usr/bin/drift"));
        assert!(!is_ours(
            &json!({ "command": "/usr/bin/rift", "args": ["other"] }),
            "claude"
        ));
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
        // PowerShell also ends a '...' string at typographic quotes: doubled like '.
        let quoted = Path::new("C:\\Bob\u{2019}s 'apps'\\rift.exe");
        assert_eq!(
            hook_command(quoted, "gemini", HookShell::PowerShell),
            "& 'C:\\Bob\u{2019}\u{2019}s ''apps''\\rift.exe' hook gemini"
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
        assert!(!dir.path().join("sub").join("hooks.json.tmp").exists());
    }

    #[test]
    fn a_run_that_never_answers_is_stopped() {
        let dir = tempfile::tempdir().unwrap();
        let start = std::time::Instant::now();
        let timeout = std::time::Duration::from_secs(1);
        let err = if cfg!(windows) {
            run_for("ping", &["-n", "30", "127.0.0.1"], dir.path(), "", timeout)
        } else {
            run_for("sleep", &["30"], dir.path(), "", timeout)
        }
        .unwrap_err()
        .to_string();
        assert!(err.contains("did not answer in 1 s"), "{err}");
        assert!(start.elapsed() < std::time::Duration::from_secs(10));
    }

    /// npm installs Codex and Gemini as `.cmd` shims running node: the commit prompt (backticks, `!`, quotes,
    /// parentheses) must reach the agent unchanged through cmd.exe.
    #[cfg(windows)]
    #[test]
    fn prompt_reaches_an_npm_cmd_shim_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        let shim = dir.path().join("agent.cmd");
        std::fs::write(
            &shim,
            "@node -e \"process.stdout.write(JSON.stringify(process.argv.slice(1)))\" -- %*\r\n",
        )
        .unwrap();
        let prompt = format!(
            "{} 100% \"quoted\" ^caret %PATH% & | < >",
            super::super::COMMIT_PROMPT
        );
        let out = run(shim.to_str().unwrap(), &["-p", &prompt], dir.path(), "").unwrap();
        let args: Vec<String> = serde_json::from_str(&out).unwrap();
        assert_eq!(args, ["-p", prompt.as_str()]);
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

    #[test]
    fn mcp_json_entry_is_added_and_removed_keeping_the_rest() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let exe = Path::new(r"C:\Apps\Rift\rift.exe");
        std::fs::write(
            &path,
            r#"{"theme":"dark","mcpServers":{"other":{"command":"x"}}}"#,
        )
        .unwrap();
        set_mcp_json(&path, Some(mcp_json(exe, json!({ "type": "local" })))).unwrap();
        assert!(mcp_json_installed(&path, exe));
        assert!(!mcp_json_installed(&path, Path::new("/other/rift")));
        let v = read_json(&path).unwrap();
        assert_eq!(v["mcpServers"]["rift"]["type"], "local");
        assert_eq!(v["mcpServers"]["other"]["command"], "x");
        set_mcp_json(&path, None).unwrap();
        let v = read_json(&path).unwrap();
        assert!(v["mcpServers"].get("rift").is_none());
        assert_eq!(v["theme"], "dark");
        assert!(!mcp_json_installed(&path, exe));
    }

    #[test]
    fn removing_a_missing_mcp_entry_writes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        set_mcp_json(&path, None).unwrap();
        assert!(!path.exists());
        set_mcp_toml(&dir.path().join("config.toml"), None).unwrap();
        assert!(!dir.path().join("config.toml").exists());
    }

    #[test]
    fn codex_table_replaces_the_old_one_and_keeps_the_rest() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        let exe = Path::new(r"C:\Program Files\Rift\rift.exe");
        let before = "model = \"o3\"\n\n[mcp_servers.rift]\ncommand = \"old\"\n\n[mcp_servers.rift.env]\nA = \"1\"\n\n\
                      [mcp_servers.docs]\ncommand = \"d\"\n";
        std::fs::write(&path, before).unwrap();
        set_mcp_toml(&path, Some(exe)).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(mcp_toml_installed(&path, exe));
        assert!(!text.contains("old") && !text.contains("A = "), "{text}");
        assert!(
            text.starts_with("model = \"o3\"") && text.contains("[mcp_servers.docs]"),
            "{text}"
        );
        assert!(
            text.contains(r#"command = "C:\\Program Files\\Rift\\rift.exe""#),
            "{text}"
        );
        set_mcp_toml(&path, None).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(
            !text.contains("mcp_servers.rift") && text.contains("[mcp_servers.docs]"),
            "{text}"
        );
    }
}
