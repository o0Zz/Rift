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
    /// Old path of a rename: committing the rename must include it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub orig: Option<String>,
}

fn git(root: &Path, args: &[&str]) -> Result<std::process::Output> {
    git_with_input(root, args, None)
}

/// Runs git without a console window. `input` is written to stdin (e.g. a pathspec list).
fn git_with_input(
    root: &Path,
    args: &[&str],
    input: Option<&[u8]>,
) -> Result<std::process::Output> {
    use std::io::Write;
    use std::process::Stdio;
    let mut cmd = Command::new("git");
    cmd.current_dir(root)
        .args(args)
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: no console flashing from the GUI app
    }
    let mut child = cmd.spawn().context("could not run git")?;
    if let Some(input) = input {
        child.stdin.take().unwrap().write_all(input)?; // dropped right after: git sees EOF
    }
    child.wait_with_output().context("could not run git")
}

fn check(out: std::process::Output) -> Result<std::process::Output> {
    if out.status.success() {
        return Ok(out);
    }
    let err = String::from_utf8_lossy(&out.stderr);
    let msg = if err.trim().is_empty() {
        String::from_utf8_lossy(&out.stdout)
    } else {
        err
    };
    bail!("{}", msg.trim())
}

/// Commits exactly the given files (`(path, untracked)`: new, modified, deleted, renamed — both sides of a
/// rename) with `message`. Other staged changes stay staged. Returns git's one-line summary of the new commit.
pub fn commit(root: &Path, files: &[(String, bool)], message: &str) -> Result<String> {
    if message.trim().is_empty() {
        bail!("Empty commit message");
    }
    if files.is_empty() {
        bail!("No file selected");
    }
    // NUL-separated pathspecs on stdin: no command-line length limit, any file name.
    let spec = |untracked_only: bool| {
        let mut spec = Vec::new();
        for (path, untracked) in files {
            if *untracked || !untracked_only {
                spec.extend_from_slice(path.as_bytes());
                spec.push(0);
            }
        }
        spec
    };
    let from_stdin = ["--pathspec-from-file=-", "--pathspec-file-nul"];
    // New files must be added first; `commit --only` takes care of everything git already tracks.
    // --literal-pathspecs: `[id].tsx` is a file name, not a glob.
    let new_files = spec(true);
    if !new_files.is_empty() {
        let add = [&["--literal-pathspecs", "add"][..], &from_stdin].concat();
        check(git_with_input(root, &add, Some(&new_files))?)?;
    }
    let args = [
        &["--literal-pathspecs", "commit", "--only", "-m", message][..],
        &from_stdin,
    ]
    .concat();
    let out = check(git_with_input(root, &args, Some(&spec(false)))?)?;
    let text = String::from_utf8_lossy(&out.stdout);
    Ok(text.lines().next().unwrap_or_default().to_string())
}

/// Creates a git worktree for `branch` next to the repository, in `<repo>.worktrees/<branch>`, so
/// parallel agents work on separate checkouts. Creates the branch from HEAD unless it exists.
/// Returns the worktree folder.
pub fn worktree_add(root: &Path, branch: &str) -> Result<PathBuf> {
    check(git(root, &["check-ref-format", "--branch", branch])?).context("invalid branch name")?;
    let repo = root
        .file_name()
        .context("repository has no folder name")?
        .to_string_lossy();
    let parent = root.parent().context("repository has no parent folder")?;
    let path = parent
        .join(format!("{repo}.worktrees"))
        .join(branch.replace(['/', '\\'], "-"));
    if path.exists() {
        bail!("{} already exists", path.display());
    }
    let target = path.to_string_lossy().into_owned();
    let exists = git(
        root,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("refs/heads/{branch}"),
        ],
    )?
    .status
    .success();
    if exists {
        check(git(root, &["worktree", "add", &target, branch])?)?;
    } else {
        check(git(root, &["worktree", "add", "-b", branch, &target])?)?;
    }
    Ok(path)
}

/// Diff of several files, for an AI commit message: capped at `max` bytes.
pub fn diff_many(root: &Path, changes: &[(String, bool)], max: usize) -> Result<String> {
    let mut all = String::new();
    for (path, untracked) in changes {
        all.push_str(&diff(root, path, *untracked)?);
        if all.len() > max {
            let cut = (0..=max)
                .rev()
                .find(|&i| all.is_char_boundary(i))
                .unwrap_or(0);
            all.truncate(cut);
            all.push_str("\n… (diff truncated)\n");
            break;
        }
    }
    Ok(all)
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
        let orig = if x == 'R' || x == 'C' {
            fields.next().map(String::from) // the old path of a rename/copy
        } else {
            None
        };
        let status = match (x, y) {
            ('?', _) => '?',
            ('U', _) | (_, 'U') | ('A', 'A') | ('D', 'D') => 'U',
            (' ', y) => y,
            (x, _) => x,
        };
        changes.push(Change {
            path: path.to_string(),
            status: status.to_string(),
            orig,
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

    fn committed_files(root: &Path) -> String {
        let out = git(root, &["show", "--name-status", "--format=%s", "HEAD"]).unwrap();
        String::from_utf8_lossy(&out.stdout)
            .trim()
            .replace('\t', " ")
    }

    #[test]
    fn commit_takes_only_the_selected_files() {
        let dir = repo();
        let r = dir.path();
        std::fs::write(r.join("kept.txt"), "changed\n").unwrap();
        std::fs::remove_file(r.join("gone.txt")).unwrap();
        std::fs::write(r.join("[id].tsx"), "new\n").unwrap();
        std::fs::write(r.join("left out.txt"), "not now\n").unwrap();

        let files = [("kept.txt", false), ("gone.txt", false), ("[id].tsx", true)]
            .map(|(p, u)| (p.to_string(), u));
        let summary = commit(r, &files, "Pick some files").unwrap();
        assert!(summary.contains("Pick some files"), "{summary}");
        assert_eq!(
            committed_files(r),
            "Pick some files\n\nA [id].tsx\nD gone.txt\nM kept.txt"
        );
        // The unselected file is still pending.
        let left: Vec<_> = status(r).unwrap().into_iter().map(|c| c.path).collect();
        assert_eq!(left, ["left out.txt"]);
    }

    #[test]
    fn commit_keeps_other_staged_changes_staged() {
        let dir = repo();
        let r = dir.path();
        std::fs::write(r.join("kept.txt"), "staged\n").unwrap();
        run(r, &["add", "kept.txt"]);
        std::fs::write(r.join("other.txt"), "x\n").unwrap();
        commit(r, &[("other.txt".into(), true)], "Only other").unwrap();
        assert_eq!(committed_files(r), "Only other\n\nA other.txt");
        let pending: Vec<_> = status(r)
            .unwrap()
            .into_iter()
            .map(|c| (c.path, c.status))
            .collect();
        assert_eq!(pending, [("kept.txt".to_string(), "M".to_string())]);
    }

    #[test]
    fn commit_includes_both_sides_of_a_rename() {
        let dir = repo();
        let r = dir.path();
        run(r, &["mv", "kept.txt", "renamed.txt"]);
        let change = status(r)
            .unwrap()
            .into_iter()
            .find(|c| c.status == "R")
            .unwrap();
        assert_eq!(change.orig.as_deref(), Some("kept.txt"));
        commit(
            r,
            &[(change.path, false), (change.orig.unwrap(), false)],
            "Rename",
        )
        .unwrap();
        assert!(status(r).unwrap().is_empty());
    }

    #[test]
    fn commit_rejects_empty_message_and_reports_git_errors() {
        let dir = repo();
        let r = dir.path();
        assert!(commit(r, &[("kept.txt".into(), false)], "  ").is_err());
        let err = commit(r, &[("does-not-exist.txt".into(), false)], "msg").unwrap_err();
        assert!(!err.to_string().is_empty());
    }

    #[test]
    fn diff_many_is_capped() {
        let dir = repo();
        let r = dir.path();
        std::fs::write(r.join("kept.txt"), "x\n".repeat(5000)).unwrap();
        std::fs::write(r.join("new.txt"), "y\n").unwrap();
        let d = diff_many(
            r,
            &[("kept.txt".into(), false), ("new.txt".into(), true)],
            1000,
        )
        .unwrap();
        assert!(
            d.len() < 1100 && d.ends_with("(diff truncated)\n"),
            "{}",
            d.len()
        );
    }

    #[test]
    fn worktree_add_creates_a_checkout_next_to_the_repo() {
        let parent = tempfile::tempdir().unwrap();
        let root = parent.path().join("app");
        std::fs::create_dir(&root).unwrap();
        run(&root, &["init", "-q", "-b", "main"]);
        run(&root, &["config", "user.email", "t@t"]);
        run(&root, &["config", "user.name", "t"]);
        std::fs::write(root.join("a.txt"), "a\n").unwrap();
        run(&root, &["add", "."]);
        run(&root, &["commit", "-q", "-m", "init"]);

        let wt = worktree_add(&root, "feature/login").unwrap();
        assert_eq!(
            wt,
            parent.path().join("app.worktrees").join("feature-login")
        );
        assert!(wt.join("a.txt").exists());
        assert_eq!(head(&wt).unwrap().branch, "feature/login");

        // An existing branch is checked out as is; the same folder twice is refused.
        run(&root, &["branch", "existing"]);
        assert_eq!(
            head(&worktree_add(&root, "existing").unwrap())
                .unwrap()
                .branch,
            "existing"
        );
        assert!(worktree_add(&root, "feature/login").is_err());
        assert!(worktree_add(&root, "bad..name").is_err());
    }

    #[test]
    fn status_fails_cleanly_outside_a_repo() {
        let dir = tempfile::tempdir().unwrap();
        assert!(status(dir.path()).is_err());
    }
}
