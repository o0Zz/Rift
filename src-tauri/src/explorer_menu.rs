//! "Open in Rift" in the Windows Explorer right-click menu (per user, no admin), and the command-line
//! folder argument it launches Rift with (`rift <dir>`, used on every OS by single-instance).

use std::path::{Path, PathBuf};

#[cfg(windows)]
pub use registry::ExplorerMenu;

#[cfg(windows)]
mod registry {
    use std::path::Path;

    use anyhow::Result;
    use winreg::RegKey;
    use winreg::enums::HKEY_CURRENT_USER;

    /// On a folder, on the empty space inside a folder, on a drive.
    const ENTRIES: [&str; 3] = [
        r"Directory\shell\Rift",
        r"Directory\Background\shell\Rift",
        r"Drive\shell\Rift",
    ];

    pub struct ExplorerMenu {
        /// `Software\Classes` under HKCU; a throwaway key in tests.
        pub base: String,
    }

    impl Default for ExplorerMenu {
        fn default() -> Self {
            ExplorerMenu {
                base: r"Software\Classes".into(),
            }
        }
    }

    fn command(exe: &Path) -> String {
        format!("\"{}\" \"%V\"", exe.display())
    }

    impl ExplorerMenu {
        pub fn install(&self, exe: &Path) -> Result<()> {
            let hkcu = RegKey::predef(HKEY_CURRENT_USER);
            for entry in ENTRIES {
                let (key, _) = hkcu.create_subkey(format!(r"{}\{entry}", self.base))?;
                key.set_value("", &"Open in Rift")?;
                key.set_value("Icon", &exe.display().to_string())?;
                let (cmd, _) = key.create_subkey("command")?;
                cmd.set_value("", &command(exe))?;
            }
            Ok(())
        }

        /// Installed, and pointing at this exe.
        pub fn installed(&self, exe: &Path) -> bool {
            let hkcu = RegKey::predef(HKEY_CURRENT_USER);
            ENTRIES.iter().all(|entry| {
                hkcu.open_subkey(format!(r"{}\{entry}\command", self.base))
                    .and_then(|k| k.get_value::<String, _>(""))
                    .is_ok_and(|v| v == command(exe))
            })
        }

        pub fn uninstall(&self) -> Result<()> {
            let hkcu = RegKey::predef(HKEY_CURRENT_USER);
            for entry in ENTRIES {
                match hkcu.delete_subkey_all(format!(r"{}\{entry}", self.base)) {
                    Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.into()),
                    _ => {}
                }
            }
            Ok(())
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        struct TestKey(ExplorerMenu, String);

        impl Drop for TestKey {
            fn drop(&mut self) {
                let _ = RegKey::predef(HKEY_CURRENT_USER).delete_subkey_all(&self.1);
            }
        }

        fn test_menu(name: &str) -> TestKey {
            let root = format!(r"Software\RiftTest-{}-{name}", std::process::id());
            TestKey(
                ExplorerMenu {
                    base: format!(r"{root}\Classes"),
                },
                root,
            )
        }

        #[test]
        fn install_check_and_uninstall() {
            let t = test_menu("roundtrip");
            let exe = Path::new(r"C:\Apps\Rift\rift.exe");
            assert!(!t.0.installed(exe));
            t.0.install(exe).unwrap();
            assert!(t.0.installed(exe));
            assert!(
                !t.0.installed(Path::new(r"C:\Other\rift.exe")),
                "another exe path is not ours"
            );

            let hkcu = RegKey::predef(HKEY_CURRENT_USER);
            let bg = hkcu
                .open_subkey(format!(r"{}\Directory\Background\shell\Rift", t.0.base))
                .unwrap();
            assert_eq!(bg.get_value::<String, _>("").unwrap(), "Open in Rift");
            let cmd = bg
                .open_subkey("command")
                .unwrap()
                .get_value::<String, _>("")
                .unwrap();
            assert_eq!(cmd, r#""C:\Apps\Rift\rift.exe" "%V""#);

            t.0.uninstall().unwrap();
            assert!(!t.0.installed(exe));
            t.0.uninstall().unwrap(); // idempotent
        }
    }
}

/// The folder to open from Rift's command line (`rift <dir>`), resolved against `cwd`.
/// On Windows, Explorer passes `"C:\"` for a drive, which arrives as `C:"`: the stray quote is dropped.
pub fn dir_arg(args: &[String], cwd: &Path) -> Option<PathBuf> {
    let arg = args.iter().skip(1).find(|a| !a.starts_with('-'))?;
    #[cfg(windows)]
    let arg = {
        let arg = arg.trim_end_matches('"');
        if arg.ends_with(':') {
            format!(r"{arg}\")
        } else {
            arg.to_string()
        }
    };
    let path = cwd.join(arg);
    path.is_dir().then_some(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn folder_argument() {
        let dir = tempfile::tempdir().unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        let d = dir.path().to_string_lossy().to_string();
        assert_eq!(
            dir_arg(&args(&["rift", &d]), elsewhere.path()),
            Some(dir.path().into())
        );
        // Relative to the launching process's cwd.
        std::fs::create_dir(dir.path().join("sub")).unwrap();
        assert_eq!(
            dir_arg(&args(&["rift", "sub"]), dir.path()),
            Some(dir.path().join("sub"))
        );
        // Nothing, flags, or not a folder.
        assert_eq!(dir_arg(&args(&["rift"]), dir.path()), None);
        assert_eq!(dir_arg(&args(&["rift", "--flag"]), dir.path()), None);
        assert_eq!(dir_arg(&args(&["rift", "missing"]), dir.path()), None);
    }

    #[cfg(windows)]
    #[test]
    fn drive_root_mangled_by_windows_quoting() {
        assert_eq!(
            dir_arg(&args(&["rift.exe", "C:\""]), Path::new("D:\\")),
            Some(PathBuf::from("C:\\"))
        );
    }
}
