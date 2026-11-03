//! Which shell a tab runs and how Rift hooks into it. At every prompt the shell reports its cwd
//! (OSC 9;9 from PowerShell and cmd, OSC 7 from bash/zsh, Git Bash included), and an optional startup
//! command (e.g. `claude --resume <id>`) runs once the user's own config is loaded. The user's profile and
//! rc files are never modified. `profiles()` lists the shells installed on this machine.

use portable_pty::CommandBuilder;

#[derive(Clone, Debug)]
#[allow(clippy::enum_variant_names)] // `PowerShell` is the product's name
pub enum Shell {
    #[cfg(windows)]
    PowerShell { exe: String },
    #[cfg(windows)]
    Cmd,
    /// The default WSL distribution, no cwd reporting.
    #[cfg(windows)]
    Wsl { exe: String },
    /// bash and zsh get cwd reporting and the startup command; any other shell runs plain.
    /// On Windows: Git Bash.
    Posix { exe: String },
}

/// A shell offered to the user ("New tab with…", default shell in settings).
#[derive(Clone, Debug, serde::Serialize)]
pub struct Profile {
    pub id: String,
    pub name: String,
    #[serde(skip)]
    pub shell: Shell,
}

impl Shell {
    /// PowerShell 7 if installed, Windows PowerShell otherwise.
    #[cfg(windows)]
    pub fn default_for_platform() -> Self {
        profiles()[0].shell.clone()
    }

    /// The user's login shell ($SHELL), else zsh on macOS and bash elsewhere.
    #[cfg(unix)]
    pub fn default_for_platform() -> Self {
        Shell::Posix {
            exe: unix::login_shell(),
        }
    }

    /// The shell of profile `id` (see `profiles()`), if installed.
    pub fn from_profile(id: &str) -> Option<Self> {
        profiles()
            .iter()
            .find(|p| p.id == id)
            .map(|p| p.shell.clone())
    }

    /// The shell command line, running `startup` once the shell is ready.
    pub fn command(&self, startup: Option<&str>) -> CommandBuilder {
        match self {
            #[cfg(windows)]
            Shell::PowerShell { exe } => windows::powershell(exe, startup),
            #[cfg(windows)]
            Shell::Cmd => windows::cmd(startup),
            #[cfg(windows)]
            Shell::Wsl { exe } => windows::wsl(exe, startup),
            Shell::Posix { exe } => posix::command(exe, startup),
        }
    }
}

/// The installed shells, the platform default first, looked up once (PATH and file checks): a new tab
/// with its own shell reads the list.
pub fn profiles() -> &'static [Profile] {
    static PROFILES: std::sync::OnceLock<Vec<Profile>> = std::sync::OnceLock::new();
    PROFILES.get_or_init(|| {
        #[cfg(windows)]
        return windows::profiles();
        #[cfg(unix)]
        return unix::profiles();
    })
}

#[cfg(windows)]
mod windows {
    use std::path::PathBuf;

    use base64::Engine;
    use portable_pty::CommandBuilder;

    use super::{Profile, Shell};

    /// Runs after the user's profile: wraps their prompt so every prompt reports the cwd (OSC 9;9).
    const PWSH_INIT: &str = r#"
$global:__riftPrompt = $function:prompt
function global:prompt {
  $loc = $executionContext.SessionState.Path.CurrentLocation
  $p = & $global:__riftPrompt
  if ($loc.Provider.Name -eq 'FileSystem') { "$([char]27)]9;9;`"$($loc.ProviderPath)`"$([char]27)\$p" } else { $p }
}
"#;

    /// cmd's own prompt syntax reports the cwd: `$e]9;9;$P$e\` is OSC 9;9 (as documented by Windows Terminal).
    const CMD_PROMPT: &str = r"prompt $e]9;9;$P$e\$P$G";

    fn on_path(exe: &str) -> bool {
        std::env::var_os("PATH")
            .map(|p| std::env::split_paths(&p).any(|dir| dir.join(exe).is_file()))
            .unwrap_or(false)
    }

    fn git_bash() -> Option<PathBuf> {
        ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"]
            .iter()
            .filter_map(|var| {
                std::env::var_os(var).map(|d| PathBuf::from(d).join(r"Git\bin\bash.exe"))
            })
            .chain(
                std::env::var_os("LOCALAPPDATA")
                    .map(|d| PathBuf::from(d).join(r"Programs\Git\bin\bash.exe")),
            )
            .find(|p| p.is_file())
    }

    pub fn profiles() -> Vec<Profile> {
        let profile = |id: &str, name: &str, shell| Profile {
            id: id.into(),
            name: name.into(),
            shell,
        };
        let mut list = Vec::new();
        if on_path("pwsh.exe") {
            list.push(profile(
                "pwsh",
                "PowerShell 7",
                Shell::PowerShell {
                    exe: "pwsh.exe".into(),
                },
            ));
        }
        list.push(profile(
            "powershell",
            "Windows PowerShell",
            Shell::PowerShell {
                exe: "powershell.exe".into(),
            },
        ));
        list.push(profile("cmd", "Command Prompt", Shell::Cmd));
        if let Some(bash) = git_bash() {
            list.push(profile(
                "gitbash",
                "Git Bash",
                Shell::Posix {
                    exe: bash.display().to_string(),
                },
            ));
        }
        let wsl =
            PathBuf::from(std::env::var_os("SystemRoot").unwrap_or_else(|| r"C:\Windows".into()))
                .join(r"System32\wsl.exe");
        if wsl.is_file() {
            list.push(profile(
                "wsl",
                "WSL",
                Shell::Wsl {
                    exe: wsl.display().to_string(),
                },
            ));
        }
        list
    }

    /// `-EncodedCommand`: init + startup without writing any file.
    pub fn powershell(exe: &str, startup: Option<&str>) -> CommandBuilder {
        let script = format!("{PWSH_INIT}\n{}", startup.unwrap_or(""));
        let utf16: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
        let mut cmd = CommandBuilder::new(exe);
        cmd.args(["-NoLogo", "-NoExit", "-EncodedCommand"]);
        cmd.arg(base64::engine::general_purpose::STANDARD.encode(utf16));
        cmd
    }

    pub fn cmd(startup: Option<&str>) -> CommandBuilder {
        let mut cmd = CommandBuilder::new("cmd.exe");
        cmd.arg("/K");
        cmd.arg(match startup {
            Some(s) => format!("{CMD_PROMPT} & {s}"),
            None => CMD_PROMPT.into(),
        });
        cmd
    }

    /// Plain WSL (its shell lives inside Linux, out of Rift's reach for cwd reporting).
    pub fn wsl(exe: &str, startup: Option<&str>) -> CommandBuilder {
        let mut cmd = CommandBuilder::new(exe);
        if let Some(s) = startup {
            cmd.args(["--", "sh", "-lc", &format!("{s}; exec \"$SHELL\" -l")]);
        }
        cmd
    }
}

#[cfg(unix)]
mod unix {
    use std::path::Path;

    use super::{Profile, Shell};

    pub fn login_shell() -> String {
        let fallback = if cfg!(target_os = "macos") {
            "/bin/zsh"
        } else {
            "/bin/bash"
        };
        std::env::var("SHELL")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| fallback.into())
    }

    /// The login shell, then the other shells of /etc/shells that exist (one per name).
    pub fn profiles() -> Vec<Profile> {
        let listed = std::fs::read_to_string("/etc/shells").unwrap_or_default();
        let candidates = std::iter::once(login_shell()).chain(
            listed
                .lines()
                .map(str::trim)
                .filter(|l| l.starts_with('/'))
                .map(String::from),
        );
        let mut list: Vec<Profile> = Vec::new();
        for exe in candidates {
            let Some(id) = Path::new(&exe)
                .file_name()
                .and_then(|n| n.to_str())
                .map(String::from)
            else {
                continue;
            };
            if Path::new(&exe).is_file() && !list.iter().any(|p| p.id == id) {
                let name = format!("{}{}", id[..1].to_uppercase(), &id[1..]);
                list.push(Profile {
                    id,
                    name,
                    shell: Shell::Posix { exe },
                });
            }
        }
        list
    }
}

/// bash and zsh integration, also used by Git Bash on Windows.
mod posix {
    use std::path::{Path, PathBuf};
    use std::sync::OnceLock;

    use portable_pty::CommandBuilder;

    // Each file first loads the user's own one, then adds Rift's hook. The startup command comes through
    // RIFT_STARTUP (only UUID-validated resume commands reach it) and runs once, after the user's config.
    const RUN_STARTUP: &str = r#"
if [ -n "$RIFT_STARTUP" ]; then __rift_startup="$RIFT_STARTUP"; unset RIFT_STARTUP; eval "$__rift_startup"; unset __rift_startup; fi
"#;

    const BASH_RC: &str = r#"
[ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc"
__rift_cwd() { printf '\033]7;file://%s%s\033\\' "$HOSTNAME" "$PWD"; }
PROMPT_COMMAND="__rift_cwd${PROMPT_COMMAND:+; $PROMPT_COMMAND}"
"#;

    // zsh reads $ZDOTDIR/.zshenv, .zprofile (login), .zshrc: Rift points ZDOTDIR at its own folder, each
    // file sources the user's original (from RIFT_USER_ZDOTDIR) and hands ZDOTDIR back after .zshrc.
    const ZSHENV: &str = r#"
__rift_zd="$ZDOTDIR"; ZDOTDIR="${RIFT_USER_ZDOTDIR:-$HOME}"
[ -f "$ZDOTDIR/.zshenv" ] && . "$ZDOTDIR/.zshenv"
RIFT_USER_ZDOTDIR="$ZDOTDIR"; ZDOTDIR="$__rift_zd"; unset __rift_zd
"#;

    const ZPROFILE: &str = r#"
__rift_zd="$ZDOTDIR"; ZDOTDIR="$RIFT_USER_ZDOTDIR"
[ -f "$ZDOTDIR/.zprofile" ] && . "$ZDOTDIR/.zprofile"
ZDOTDIR="$__rift_zd"; unset __rift_zd
"#;

    const ZSHRC: &str = r#"
ZDOTDIR="$RIFT_USER_ZDOTDIR"; unset RIFT_USER_ZDOTDIR
[ -f "$ZDOTDIR/.zshrc" ] && . "$ZDOTDIR/.zshrc"
__rift_cwd() { printf '\033]7;file://%s%s\033\\' "$HOST" "$PWD"; }
precmd_functions+=(__rift_cwd)
"#;

    /// Rift's shell init files, written once per process (per-user runtime dir when there is one).
    fn integration_dir() -> &'static Path {
        static DIR: OnceLock<PathBuf> = OnceLock::new();
        DIR.get_or_init(|| {
            let dir =
                crate::files::runtime_dir().join(format!("rift-shell-{}", std::process::id()));
            let zsh = dir.join("zsh");
            let _ = std::fs::create_dir_all(&zsh);
            let _ = std::fs::write(dir.join("rift.bash"), format!("{BASH_RC}{RUN_STARTUP}"));
            let _ = std::fs::write(zsh.join(".zshenv"), ZSHENV);
            let _ = std::fs::write(zsh.join(".zprofile"), ZPROFILE);
            let _ = std::fs::write(zsh.join(".zshrc"), format!("{ZSHRC}{RUN_STARTUP}"));
            dir
        })
    }

    pub fn command(exe: &str, startup: Option<&str>) -> CommandBuilder {
        let mut cmd = CommandBuilder::new(exe);
        // A GUI app may not have them: full colors for the programs run in the terminal.
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        let name = Path::new(exe)
            .file_stem()
            .and_then(|n| n.to_str())
            .unwrap_or(exe);
        match name {
            "bash" => {
                // Forward slashes: Git Bash on Windows reads them, backslashes would be escapes.
                let rc = integration_dir()
                    .join("rift.bash")
                    .to_string_lossy()
                    .replace('\\', "/");
                cmd.args(["--rcfile", &rc, "-i"]);
            }
            "zsh" => {
                let user = std::env::var_os("ZDOTDIR")
                    .or_else(|| std::env::var_os("HOME"))
                    .unwrap_or_default();
                cmd.env("RIFT_USER_ZDOTDIR", user);
                cmd.env("ZDOTDIR", integration_dir().join("zsh"));
                cmd.arg("-l"); // login shell, like macOS terminals (PATH from /etc/zprofile)
            }
            _ => {
                // No integration known: no cwd reporting; the startup command runs before the shell.
                match startup {
                    Some(s) => cmd.args(["-c", &format!("{s}; exec {exe} -i")]),
                    None => cmd.arg("-i"),
                }
                return cmd;
            }
        }
        if let Some(s) = startup {
            cmd.env("RIFT_STARTUP", s);
        }
        cmd
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profiles_start_with_the_default_and_are_unique() {
        let list = profiles();
        assert!(!list.is_empty());
        let mut ids: Vec<_> = list.iter().map(|p| p.id.clone()).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), list.len(), "duplicate profile ids");
        assert!(Shell::from_profile(&list[0].id).is_some());
        assert!(Shell::from_profile("no-such-shell").is_none());
        #[cfg(windows)]
        for id in ["powershell", "cmd"] {
            assert!(
                list.iter().any(|p| p.id == id),
                "{id} is always there on Windows"
            );
        }
    }
}
