//! Git: branch from `.git/HEAD` (file reads only, cheap enough for every prompt) and, on demand,
//! status/diff through the `git` CLI (respects the user's config).

use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{Context, Result, bail};
use serde::Serialize;

#[derive(Debug, PartialEq, Serialize)]
pub struct Head {
    /// Repository root (the folder containing `.git`).
    pub root: PathBuf,
    /// Branch name, or a short commit id when detached.
    pub branch: String,
}

/// Finds the repository containing `cwd` and its current branch, without running git.
pub fn head(cwd: &Path) -> Option<Head> {
    let root = cwd.ancestors().find(|d| d.join(".git").exists())?;
    let dot_git = root.join(".git");
    // Worktrees and submodules: `.git` is a file pointing to the real git dir.
    let git_dir = if dot_git.is_file() {
        let text = std::fs::read_to_string(&dot_git).ok()?;
        let target = PathBuf::from(text.trim().strip_prefix("gitdir:")?.trim());
        if target.is_absolute() {
            target
        } else {
            root.join(target)
        }
    } else {
        dot_git
    };
    let head = std::fs::read_to_string(git_dir.join("HEAD")).ok()?;
    let head = head.trim();
    let branch = match head.strip_prefix("ref: refs/heads/") {
        Some(name) => name.to_string(),
        None => head.chars().take(7).collect(),
    };
    Some(Head {
        root: root.to_path_buf(),
        branch,
    })
}

#[derive(Debug, PartialEq, Serialize)]
pub struct Change {
    pub path: String,
    /// One letter: M modified, A added, D deleted, R renamed, ? untracked, U conflict.
    pub status: String,
}

fn git(root: &Path, args: &[&str]) -> Result<std::process::Output> {
    let mut cmd = Command::new("git");
    cmd.current_dir(root).args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: no console flashing from the GUI app
    }
    cmd.output().context("could not run git")
}

pub fn status(root: &Path) -> Result<Vec<Change>> {
    let out = git(
        root,
        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    )?;
    if !out.status.success() {
        bail!("{}", String::from_utf8_lossy(&out.stderr).trim());
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut fields = text.split('\0').filter(|f| !f.is_empty());
    let mut changes = Vec::new();
    while let Some(entry) = fields.next() {
        let (xy, path) = entry.split_at(3.min(entry.len()));
        let (x, y) = (
            xy.chars().next().unwrap_or(' '),
            xy.chars().nth(1).unwrap_or(' '),
        );
        if x == 'R' || x == 'C' {
            fields.next(); // the old path of a rename/copy
        }
        let status = match (x, y) {
            ('?', _) => '?',
            ('U', _) | (_, 'U') | ('A', 'A') | ('D', 'D') => 'U',
            (' ', y) => y,
            (x, _) => x,
        };
        changes.push(Change {
            path: path.to_string(),
            status: status.to_string(),
        });
    }
    Ok(changes)
}

const MAX_DIFF: usize = 512 * 1024;

/// Diff of one file against HEAD (staged + unstaged). Untracked files show as fully added.
pub fn diff(root: &Path, path: &str, untracked: bool) -> Result<String> {
    let out = if untracked {
        // --no-index exits with 1 when the files differ, which is always the case here.
        git(
            root,
            &["diff", "--no-color", "--no-index", "--", "/dev/null", path],
        )?
    } else {
        let out = git(root, &["diff", "--no-color", "HEAD", "--", path])?;
        if out.status.success() {
            out
        } else {
            git(root, &["diff", "--no-color", "--cached", "--", path])? // no commit yet
        }
    };
    let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
    if text.len() > MAX_DIFF {
        let cut = (0..=MAX_DIFF)
            .rev()
            .find(|&i| text.is_char_boundary(i))
            .unwrap_or(0);
        text.truncate(cut);
        text.push_str("\n… diff truncated\n");
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(root: &Path, args: &[&str]) {
        assert!(git(root, args).unwrap().status.success(), "git {args:?}");
    }

    fn repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let r = dir.path();
        run(r, &["init", "-q", "-b", "main"]);
        run(r, &["config", "user.email", "t@t"]);
        run(r, &["config", "user.name", "t"]);
        std::fs::write(r.join("kept.txt"), "one\ntwo\n").unwrap();
        std::fs::write(r.join("gone.txt"), "x\n").unwrap();
        run(r, &["add", "."]);
        run(r, &["commit", "-q", "-m", "init"]);
        dir
    }

    #[test]
    fn head_finds_root_and_branch_from_a_subfolder() {
        let dir = repo();
        let sub = dir.path().join("a").join("b");
        std::fs::create_dir_all(&sub).unwrap();
        let h = head(&sub).unwrap();
        assert_eq!(h.root, dir.path());
        assert_eq!(h.branch, "main");
        run(dir.path(), &["checkout", "-q", "-b", "feature/x"]);
        assert_eq!(head(&sub).unwrap().branch, "feature/x");
    }

    #[test]
    fn head_is_none_outside_a_repo() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(head(dir.path()), None);
    }

    #[test]
    fn status_and_diff_cover_modified_deleted_and_untracked() {
        let dir = repo();
        let r = dir.path();
        std::fs::write(r.join("kept.txt"), "one\nTWO\n").unwrap();
        std::fs::remove_file(r.join("gone.txt")).unwrap();
        std::fs::create_dir(r.join("new dir")).unwrap();
        std::fs::write(r.join("new dir").join("é.txt"), "hello\n").unwrap();

        let mut changes = status(r).unwrap();
        changes.sort_by(|a, b| a.path.cmp(&b.path));
        let summary: Vec<_> = changes
            .iter()
            .map(|c| (c.path.as_str(), c.status.as_str()))
            .collect();
        assert_eq!(
            summary,
            [("gone.txt", "D"), ("kept.txt", "M"), ("new dir/é.txt", "?")]
        );

        let d = diff(r, "kept.txt", false).unwrap();
        assert!(d.contains("-two") && d.contains("+TWO"), "{d}");
        let d = diff(r, "new dir/é.txt", true).unwrap();
        assert!(d.contains("+hello"), "{d}");
    }

    #[test]
    fn status_fails_cleanly_outside_a_repo() {
        let dir = tempfile::tempdir().unwrap();
        assert!(status(dir.path()).is_err());
    }
}
