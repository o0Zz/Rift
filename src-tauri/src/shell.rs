//! Which shell a tab runs and how Rift hooks into it, per platform. At every prompt the shell reports its cwd
//! (OSC 9;9 from PowerShell, OSC 7 from bash/zsh), and an optional startup command (e.g. `claude --resume <id>`)
//! runs once the user's own config is loaded. The user's profile and rc files are never modified.

use portable_pty::CommandBuilder;

#[derive(Clone, Debug)]
pub enum Shell {
    #[cfg(windows)]
    PowerShell { exe: String },
    /// bash and zsh get cwd reporting and the startup command; any other shell runs plain.
    #[cfg(unix)]
    Posix { exe: String },
    /// Deterministic shell for tests.
    #[cfg(all(test, windows))]
    Cmd,
}

impl Shell {
    /// PowerShell 7 if installed, Windows PowerShell otherwise.
    #[cfg(windows)]
    pub fn default_for_platform() -> Self {
        let pwsh = std::env::var_os("PATH")
            .map(|p| std::env::split_paths(&p).any(|dir| dir.join("pwsh.exe").is_file()))
            .unwrap_or(false);
        Shell::PowerShell {
            exe: if pwsh { "pwsh.exe" } else { "powershell.exe" }.into(),
        }
    }

    /// The user's login shell ($SHELL), else zsh on macOS and bash elsewhere.
    #[cfg(unix)]
    pub fn default_for_platform() -> Self {
        let fallback = if cfg!(target_os = "macos") {
            "/bin/zsh"
        } else {
            "/bin/bash"
        };
        let exe = std::env::var("SHELL")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| fallback.into());
        Shell::Posix { exe }
    }

    /// The shell command line, running `startup` once the shell is ready.
    pub fn command(&self, startup: Option<&str>) -> CommandBuilder {
        match self {
            #[cfg(windows)]
            Shell::PowerShell { exe } => windows::powershell(exe, startup),
            #[cfg(unix)]
            Shell::Posix { exe } => unix::posix(exe, startup),
            #[cfg(all(test, windows))]
            Shell::Cmd => {
                let mut cmd = CommandBuilder::new("cmd.exe");
                cmd.arg("/Q");
                if let Some(s) = startup {
                    cmd.args(["/K", s]);
                }
                cmd
            }
        }
    }
}

#[cfg(windows)]
mod windows {
    use base64::Engine;
    use portable_pty::CommandBuilder;

    /// Runs after the user's profile: wraps their prompt so every prompt reports the cwd (OSC 9;9).
    const PWSH_INIT: &str = r#"
$global:__riftPrompt = $function:prompt
function global:prompt {
  $loc = $executionContext.SessionState.Path.CurrentLocation
  $p = & $global:__riftPrompt
  if ($loc.Provider.Name -eq 'FileSystem') { "$([char]27)]9;9;`"$($loc.ProviderPath)`"$([char]27)\$p" } else { $p }
}
"#;

    /// `-EncodedCommand`: init + startup without writing any file.
    pub fn powershell(exe: &str, startup: Option<&str>) -> CommandBuilder {
        let script = format!("{PWSH_INIT}\n{}", startup.unwrap_or(""));
        let utf16: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
        let mut cmd = CommandBuilder::new(exe);
        cmd.args(["-NoLogo", "-NoExit", "-EncodedCommand"]);
        cmd.arg(base64::engine::general_purpose::STANDARD.encode(utf16));
        cmd
    }
}

#[cfg(unix)]
mod unix {
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
            let base = std::env::var_os("XDG_RUNTIME_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(std::env::temp_dir);
            let dir = base.join(format!("rift-shell-{}", std::process::id()));
            let zsh = dir.join("zsh");
            let _ = std::fs::create_dir_all(&zsh);
            let _ = std::fs::write(dir.join("rift.bash"), format!("{BASH_RC}{RUN_STARTUP}"));
            let _ = std::fs::write(zsh.join(".zshenv"), ZSHENV);
            let _ = std::fs::write(zsh.join(".zprofile"), ZPROFILE);
            let _ = std::fs::write(zsh.join(".zshrc"), format!("{ZSHRC}{RUN_STARTUP}"));
            dir
        })
    }

    pub fn posix(exe: &str, startup: Option<&str>) -> CommandBuilder {
        let mut cmd = CommandBuilder::new(exe);
        // A GUI app may not have them: full colors for the programs run in the terminal.
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        let name = Path::new(exe)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(exe);
        match name {
            "bash" => {
                cmd.arg("--rcfile");
                cmd.arg(integration_dir().join("rift.bash"));
                cmd.arg("-i");
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
