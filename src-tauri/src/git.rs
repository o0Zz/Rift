//! Git: branch from `.git/HEAD` (file reads only, cheap enough for every prompt) and, on demand,
//! status/diff through the `git` CLI (respects the user's config).

use std::path::{Path, PathBuf};

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

/// Longest a git command may run: push/pull can wait on a login or a host key nobody answers.
const GIT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);

/// Runs git without a console window. `input` is written to stdin (e.g. a pathspec list).
fn git_with_input(
    root: &Path,
    args: &[&str],
    input: Option<&[u8]>,
) -> Result<std::process::Output> {
    let mut cmd = crate::process::command("git");
    cmd.current_dir(root)
        .args(args)
        // Never wait on a terminal prompt nobody sees (push/pull): fail, or let the credential helper's
        // own window ask.
        .env("GIT_TERMINAL_PROMPT", "0");
    crate::process::output(cmd, input.unwrap_or_default(), GIT_TIMEOUT, "git")
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

/// Throws away the changes of exactly the given files (`(path, untracked)`, both sides of a rename): a file HEAD
/// has goes back to it (index and working tree); one HEAD lacks (untracked, newly added, a rename's new name) is
/// unstaged and moved to the Recycle Bin / Trash, never deleted for good. Other files are left alone.
pub fn discard(root: &Path, files: &[(String, bool)]) -> Result<()> {
    if files.is_empty() {
        bail!("No file selected");
    }
    // In the index, not in HEAD: added, or the new side of a rename (--no-renames splits it into D + A).
    let out = check(git(
        root,
        &[
            "diff",
            "--cached",
            "--no-renames",
            "--name-only",
            "--diff-filter=A",
            "-z",
        ],
    )?)?;
    let text = String::from_utf8_lossy(&out.stdout);
    let added: std::collections::HashSet<&str> =
        text.split('\0').filter(|p| !p.is_empty()).collect();
    let spec = |paths: &[&String]| {
        let mut spec = Vec::new();
        for path in paths {
            spec.extend_from_slice(path.as_bytes());
            spec.push(0);
        }
        spec
    };
    let from_stdin = ["--pathspec-from-file=-", "--pathspec-file-nul"];
    let staged_new: Vec<_> = files
        .iter()
        .filter(|(p, _)| added.contains(p.as_str()))
        .map(|(p, _)| p)
        .collect();
    let tracked: Vec<_> = files
        .iter()
        .filter(|(p, untracked)| !untracked && !added.contains(p.as_str()))
        .map(|(p, _)| p)
        .collect();
    let new: Vec<_> = files
        .iter()
        .filter(|(p, untracked)| *untracked || added.contains(p.as_str()))
        .map(|(p, _)| p)
        .collect();
    if !staged_new.is_empty() {
        // `rm --cached` works before the first commit too; -f: staged and edited again is fine here.
        let args = [
            &["--literal-pathspecs", "rm", "--cached", "-f", "-q"][..],
            &from_stdin,
        ]
        .concat();
        check(git_with_input(root, &args, Some(&spec(&staged_new)))?)?;
    }
    if !tracked.is_empty() {
        let args = [
            &[
                "--literal-pathspecs",
                "restore",
                "--source=HEAD",
                "--staged",
                "--worktree",
            ][..],
            &from_stdin,
        ]
        .concat();
        check(git_with_input(root, &args, Some(&spec(&tracked)))?)?;
    }
    for path in new {
        let file = root.join(path);
        if file.exists() {
            crate::files::trash(&file).with_context(|| format!("Move {path} to the trash"))?;
        }
    }
    Ok(())
}

/// What the tab shows next to its branch: lines changed against HEAD, commits ahead/behind upstream.
#[derive(Debug, Default, PartialEq, Serialize)]
pub struct Stats {
    pub added: u32,
    pub deleted: u32,
    pub ahead: u32,
    pub behind: u32,
}

/// `git diff --shortstat`: " 3 files changed, 12 insertions(+), 3 deletions(-)" -> (12, 3).
fn parse_shortstat(text: &str) -> (u32, u32) {
    let count = |word: &str| {
        text.split(',')
            .find(|part| part.contains(word))
            .and_then(|part| part.split_whitespace().next()?.parse().ok())
            .unwrap_or(0)
    };
    (count("insertion"), count("deletion"))
}

/// `git status --porcelain=v2 --branch`: the "# branch.ab +1 -2" line -> (1, 2); none without upstream.
fn parse_ahead_behind(text: &str) -> (u32, u32) {
    text.lines()
        .find_map(|l| l.strip_prefix("# branch.ab "))
        .and_then(|ab| {
            let mut it = ab.split_whitespace();
            let ahead = it.next()?.trim_start_matches('+').parse().ok()?;
            let behind = it.next()?.trim_start_matches('-').parse().ok()?;
            Some((ahead, behind))
        })
        .unwrap_or((0, 0))
}

/// Both git commands run in parallel (~80 ms on Windows, mostly git's process start).
pub fn stats(root: &Path) -> Result<Stats> {
    let diff_root = root.to_path_buf();
    let diff = std::thread::spawn(move || {
        git(
            &diff_root,
            &["--no-optional-locks", "diff", "HEAD", "--shortstat"],
        )
    });
    let status = check(git(
        root,
        &[
            "--no-optional-locks",
            "status",
            "--porcelain=v2",
            "--branch",
            "--untracked-files=no",
        ],
    )?)?;
    let diff = diff
        .join()
        .map_err(|_| anyhow::anyhow!("git diff panicked"))??;
    let (added, deleted) = parse_shortstat(&String::from_utf8_lossy(&diff.stdout));
    let (ahead, behind) = parse_ahead_behind(&String::from_utf8_lossy(&status.stdout));
    Ok(Stats {
        added,
        deleted,
        ahead,
        behind,
    })
}

/// Creates a git worktree for `branch` next to the repository, in `<repo>.worktrees/<branch>`, so
/// parallel agents work on separate checkouts. Creates the branch from HEAD unless it exists.
/// Returns the worktree folder.
pub fn worktree_add(root: &Path, branch: &str) -> Result<PathBuf> {
    valid_branch(root, branch)?;
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

/// Diff of several files, for an AI commit message: capped at `max` bytes. Tracked files in one git call
/// per hundred paths (a command line has a length limit), untracked ones one by one.
pub fn diff_many(root: &Path, changes: &[(String, bool)], max: usize) -> Result<String> {
    let tracked: Vec<&str> = changes
        .iter()
        .filter(|(_, untracked)| !untracked)
        .map(|(p, _)| p.as_str())
        .collect();
    let mut all = String::new();
    for paths in tracked.chunks(100) {
        all.push_str(&diff_tracked(root, paths)?);
        if all.len() > max {
            return Ok(truncated(all, max));
        }
    }
    for (path, _) in changes.iter().filter(|(_, untracked)| *untracked) {
        all.push_str(&diff(root, path, true)?);
        if all.len() > max {
            return Ok(truncated(all, max));
        }
    }
    Ok(all)
}

/// `text` cut to at most `max` bytes (on a character boundary), saying so.
fn truncated(mut text: String, max: usize) -> String {
    if text.len() > max {
        let cut = (0..=max)
            .rev()
            .find(|&i| text.is_char_boundary(i))
            .unwrap_or(0);
        text.truncate(cut);
        text.push_str("\n… (diff truncated)\n");
    }
    text
}

pub fn status(root: &Path) -> Result<Vec<Change>> {
    let out = check(git(
        root,
        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    )?)?;
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

fn capped_diff(out: &std::process::Output) -> String {
    truncated(String::from_utf8_lossy(&out.stdout).into_owned(), MAX_DIFF)
}

#[derive(Debug, PartialEq, Serialize)]
pub struct Branch {
    pub name: String,
    pub current: bool,
}

/// Local branches, most recently committed first.
pub fn branches(root: &Path) -> Result<Vec<Branch>> {
    let out = check(git(
        root,
        &[
            "branch",
            "--sort=-committerdate",
            "--format=%(HEAD)%00%(refname:short)",
        ],
    )?)?;
    Ok(String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|l| l.split_once('\0'))
        .map(|(head, name)| Branch {
            name: name.to_string(),
            current: head == "*",
        })
        .collect())
}

fn valid_branch(root: &Path, name: &str) -> Result<()> {
    check(git(root, &["check-ref-format", "--branch", name])?).context("invalid branch name")?;
    Ok(())
}

/// Switches to an existing local branch. Git refuses (and says why) if local changes would be lost.
pub fn switch(root: &Path, branch: &str) -> Result<()> {
    valid_branch(root, branch)?;
    check(git(root, &["switch", branch])?)?;
    Ok(())
}

/// Creates `branch` from the current commit and switches to it (local changes come along).
pub fn create_branch(root: &Path, branch: &str) -> Result<()> {
    valid_branch(root, branch)?;
    check(git(root, &["switch", "-c", branch])?)?;
    Ok(())
}

/// Last line git printed (push/pull talk on stderr), as a short summary.
fn summary(out: &std::process::Output, fallback: &str) -> String {
    let text = format!(
        "{}\n{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    text.lines()
        .map(str::trim)
        .rfind(|l| !l.is_empty())
        .unwrap_or(fallback)
        .to_string()
}

/// `git push`; a branch without upstream is pushed to the first remote and tracks it from then on.
pub fn push(root: &Path) -> Result<String> {
    let has_upstream = git(root, &["rev-parse", "--abbrev-ref", "@{upstream}"])?
        .status
        .success();
    let out = if has_upstream {
        check(git(root, &["push"])?)?
    } else {
        let remotes = check(git(root, &["remote"])?)?;
        let remotes = String::from_utf8_lossy(&remotes.stdout);
        let remote = remotes.lines().next().context("no remote to push to")?;
        check(git(root, &["push", "-u", remote, "HEAD"])?)?
    };
    Ok(summary(&out, "Pushed"))
}

/// `git pull`, with the user's own settings (merge or rebase): git explains when it cannot.
pub fn pull(root: &Path) -> Result<String> {
    Ok(summary(&check(git(root, &["pull"])?)?, "Pulled"))
}

#[derive(Debug, PartialEq, Serialize)]
pub struct Commit {
    pub hash: String,
    pub short: String,
    pub author: String,
    /// Relative, e.g. "3 hours ago".
    pub date: String,
    pub subject: String,
}

/// The last `max` commits of HEAD; empty for a repository without commits.
pub fn log(root: &Path, max: usize) -> Result<Vec<Commit>> {
    let out = git(
        root,
        &[
            "log",
            &format!("-n{max}"),
            "--format=%H%x1f%h%x1f%an%x1f%ar%x1f%s%x1e",
        ],
    )?;
    if !out.status.success() {
        let none = git(root, &["rev-parse", "--verify", "--quiet", "HEAD"])?;
        return if none.status.success() {
            check(out).map(|_| Vec::new())
        } else {
            Ok(Vec::new())
        };
    }
    Ok(String::from_utf8_lossy(&out.stdout)
        .split('\x1e')
        .filter_map(|record| {
            let f: Vec<_> = record.trim_start_matches('\n').split('\x1f').collect();
            (f.len() == 5).then(|| Commit {
                hash: f[0].into(),
                short: f[1].into(),
                author: f[2].into(),
                date: f[3].into(),
                subject: f[4].into(),
            })
        })
        .collect())
}

fn valid_rev(rev: &str) -> Result<()> {
    if rev.is_empty() || !rev.chars().all(|c| c.is_ascii_hexdigit()) {
        bail!("not a commit id: {rev}");
    }
    Ok(())
}

/// `git diff --name-status -z` -> changes ("R100\0old\0new" for a rename).
fn parse_name_status(text: &str) -> Vec<Change> {
    let mut fields = text.split('\0').filter(|f| !f.is_empty());
    let mut changes = Vec::new();
    while let Some(status) = fields.next() {
        let letter = status.chars().next().unwrap_or('M');
        let orig = if letter == 'R' || letter == 'C' {
            fields.next().map(String::from)
        } else {
            None
        };
        let Some(path) = fields.next() else { break };
        changes.push(Change {
            path: path.to_string(),
            status: letter.to_string(),
            orig,
        });
    }
    changes
}

/// What a range starting at commit `oldest` is compared against, so that `oldest`'s own changes count:
/// its parent, or the empty tree for the first commit.
fn before(root: &Path, oldest: &str) -> Result<String> {
    valid_rev(oldest)?;
    let parent = git(
        root,
        &["rev-parse", "--verify", "--quiet", &format!("{oldest}^")],
    )?;
    Ok(if parent.status.success() {
        String::from_utf8_lossy(&parent.stdout).trim().to_string()
    } else {
        "4b825dc642cb6eb9a060e54bf8d69288fbee4904".into() // git's empty tree
    })
}

/// Files changed by commit `to` (`from` None), or by the commits `from` (oldest) to `to`, both included.
pub fn commit_files(root: &Path, from: Option<&str>, to: &str) -> Result<Vec<Change>> {
    valid_rev(to)?;
    let out = match from {
        Some(from) => {
            let base = before(root, from)?;
            check(git(
                root,
                &["diff", "--name-status", "-z", "-M", &base, to],
            )?)?
        }
        // `show` also works for the first commit, which has no parent to diff against. A merge is compared
        // with its first parent (what the merge brought in, like GitHub): the default combined diff lists
        // cleanly merged files but shows no line of them.
        None => check(git(
            root,
            &[
                "show",
                "--format=",
                "--diff-merges=first-parent",
                "--name-status",
                "-z",
                "-M",
                to,
            ],
        )?)?,
    };
    Ok(parse_name_status(&String::from_utf8_lossy(&out.stdout)))
}

/// Diff of one file in commit `to`, or over the commits `from` (oldest) to `to`, both included.
pub fn commit_diff(root: &Path, from: Option<&str>, to: &str, path: &str) -> Result<String> {
    valid_rev(to)?;
    let out = match from {
        Some(from) => {
            let base = before(root, from)?;
            check(git(
                root,
                &["diff", "--no-color", "-M", &base, to, "--", path],
            )?)?
        }
        None => check(git(
            root,
            &[
                "show",
                "--format=",
                "--diff-merges=first-parent",
                "--no-color",
                "-M",
                to,
                "--",
                path,
            ],
        )?)?,
    };
    Ok(capped_diff(&out))
}

/// Diff of one file against HEAD (staged + unstaged). Untracked files show as fully added.
pub fn diff(root: &Path, path: &str, untracked: bool) -> Result<String> {
    let out = if untracked {
        // --no-index exits with 1 when the files differ, which is always the case here.
        git(
            root,
            &["diff", "--no-color", "--no-index", "--", "/dev/null", path],
        )?
    } else {
        return diff_tracked(root, &[path]);
    };
    Ok(capped_diff(&out))
}

/// Diff of tracked files against HEAD (against the index before the first commit).
fn diff_tracked(root: &Path, paths: &[&str]) -> Result<String> {
    let args = |base: &'static [&'static str]| [base, &["--"], paths].concat();
    let out = git(root, &args(&["diff", "--no-color", "HEAD"]))?;
    let out = if out.status.success() {
        out
    } else {
        git(root, &args(&["diff", "--no-color", "--cached"]))? // no commit yet
    };
    Ok(capped_diff(&out))
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
    fn discard_reverts_only_the_selected_files() {
        let dir = repo();
        let r = dir.path();
        std::fs::write(r.join("kept.txt"), "changed\n").unwrap();
        run(r, &["add", "kept.txt"]); // staged too: both go back to HEAD
        std::fs::remove_file(r.join("gone.txt")).unwrap();
        std::fs::write(r.join("[id].tsx"), "new\n").unwrap();
        std::fs::write(r.join("added.txt"), "added\n").unwrap();
        run(r, &["add", "added.txt"]);
        std::fs::write(r.join("left out.txt"), "not now\n").unwrap();

        let files = [
            ("kept.txt", false),
            ("gone.txt", false),
            ("[id].tsx", true),
            ("added.txt", false),
        ]
        .map(|(p, u)| (p.to_string(), u));
        discard(r, &files).unwrap();
        // core.autocrlf may check it out with CRLF.
        let kept = std::fs::read_to_string(r.join("kept.txt")).unwrap();
        assert_eq!(kept.replace('\r', ""), "one\ntwo\n");
        assert!(r.join("gone.txt").exists());
        // New files are in the Recycle Bin / Trash, not deleted for good.
        assert!(!r.join("[id].tsx").exists() && !r.join("added.txt").exists());
        let left: Vec<_> = status(r).unwrap().into_iter().map(|c| c.path).collect();
        assert_eq!(left, ["left out.txt"]);
        assert!(discard(r, &[]).is_err());
    }

    #[test]
    fn discard_undoes_a_rename() {
        let dir = repo();
        let r = dir.path();
        run(r, &["mv", "kept.txt", "renamed.txt"]);
        let change = status(r)
            .unwrap()
            .into_iter()
            .find(|c| c.status == "R")
            .unwrap();
        discard(r, &[(change.path, false), (change.orig.unwrap(), false)]).unwrap();
        assert!(status(r).unwrap().is_empty());
        assert!(r.join("kept.txt").exists() && !r.join("renamed.txt").exists());
    }

    #[test]
    fn a_merge_shows_what_it_brought_in() {
        let dir = repo();
        let r = dir.path();
        run(r, &["checkout", "-q", "-b", "side"]);
        std::fs::write(
            r.join("kept.txt"),
            "one
two
three
",
        )
        .unwrap();
        run(r, &["commit", "-qam", "side"]);
        run(r, &["checkout", "-q", "main"]);
        std::fs::write(
            r.join("gone.txt"),
            "y
",
        )
        .unwrap();
        run(r, &["commit", "-qam", "main"]);
        run(r, &["merge", "-q", "--no-edit", "side"]);
        let head = git(r, &["rev-parse", "HEAD"]).unwrap();
        let head = String::from_utf8_lossy(&head.stdout).trim().to_string();
        let files: Vec<_> = commit_files(r, None, &head)
            .unwrap()
            .into_iter()
            .map(|c| (c.path, c.status))
            .collect();
        assert_eq!(files, [("kept.txt".to_string(), "M".to_string())]);
        let d = commit_diff(r, None, &head, "kept.txt").unwrap();
        assert!(d.contains("+three"), "{d}");
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
    fn diff_many_shows_every_file_tracked_or_not() {
        let dir = repo();
        let r = dir.path();
        for f in ["a.txt", "b.txt"] {
            std::fs::write(r.join(f), "one\n").unwrap();
        }
        run(r, &["add", "."]);
        run(r, &["commit", "-qm", "two files"]);
        std::fs::write(r.join("a.txt"), "one\nA\n").unwrap();
        std::fs::write(r.join("b.txt"), "one\nB\n").unwrap();
        std::fs::write(r.join("c d.txt"), "C\n").unwrap();
        let files = [("a.txt", false), ("b.txt", false), ("c d.txt", true)]
            .map(|(p, u)| (p.to_string(), u));
        let d = diff_many(r, &files, 60_000).unwrap();
        for added in ["+A", "+B", "+C"] {
            assert!(d.contains(added), "{added} missing in:\n{d}");
        }
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
    fn parses_shortstat_and_ahead_behind() {
        assert_eq!(
            parse_shortstat(" 3 files changed, 12 insertions(+), 3 deletions(-)\n"),
            (12, 3)
        );
        assert_eq!(parse_shortstat(" 1 file changed, 1 insertion(+)"), (1, 0));
        assert_eq!(parse_shortstat(" 1 file changed, 2 deletions(-)"), (0, 2));
        assert_eq!(parse_shortstat(""), (0, 0));
        let status = "# branch.oid abc\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +4 -1\n";
        assert_eq!(parse_ahead_behind(status), (4, 1));
        assert_eq!(parse_ahead_behind("# branch.head main\n"), (0, 0)); // no upstream
    }

    #[test]
    fn stats_count_changed_lines_against_head() {
        let dir = repo();
        let r = dir.path();
        assert_eq!(stats(r).unwrap(), Stats::default());
        std::fs::write(r.join("kept.txt"), "one\nTWO\nthree\n").unwrap(); // 1 line changed, 1 added
        std::fs::remove_file(r.join("gone.txt")).unwrap(); // 1 line removed
        let s = stats(r).unwrap();
        assert_eq!((s.added, s.deleted), (2, 2));
        assert_eq!((s.ahead, s.behind), (0, 0));
    }

    #[test]
    fn branches_switch_and_create() {
        let dir = repo();
        let r = dir.path();
        run(r, &["branch", "other"]);
        let names: Vec<_> = branches(r)
            .unwrap()
            .into_iter()
            .map(|b| (b.name, b.current))
            .collect();
        assert!(names.contains(&("main".into(), true)), "{names:?}");
        assert!(names.contains(&("other".into(), false)), "{names:?}");

        switch(r, "other").unwrap();
        assert_eq!(head(r).unwrap().branch, "other");
        create_branch(r, "feature/new").unwrap();
        assert_eq!(head(r).unwrap().branch, "feature/new");
        assert!(create_branch(r, "feature/new").is_err(), "exists already");
        assert!(create_branch(r, "bad..name").is_err());
        assert!(switch(r, "nope").is_err());
        assert!(switch(r, "-f").is_err(), "never an option");
    }

    #[test]
    fn switch_refuses_to_lose_local_changes() {
        let dir = repo();
        let r = dir.path();
        run(r, &["switch", "-q", "-c", "other"]);
        std::fs::write(r.join("kept.txt"), "on other\n").unwrap();
        run(r, &["commit", "-q", "-am", "other"]);
        std::fs::write(r.join("kept.txt"), "local edit\n").unwrap();
        let err = switch(r, "main").unwrap_err().to_string();
        assert!(err.contains("kept.txt"), "{err}");
        assert_eq!(head(r).unwrap().branch, "other");
    }

    #[test]
    fn push_sets_upstream_then_pull_brings_commits_back() {
        let parent = tempfile::tempdir().unwrap();
        let remote = parent.path().join("remote.git");
        let remote_arg = remote.to_string_lossy().into_owned();
        run(
            parent.path(),
            &["init", "-q", "--bare", "-b", "main", &remote_arg],
        );
        let dir = repo();
        let r = dir.path();
        run(r, &["remote", "add", "origin", &remote_arg]);

        push(r).unwrap(); // no upstream yet: -u origin HEAD
        std::fs::write(r.join("kept.txt"), "second\n").unwrap();
        run(r, &["commit", "-q", "-am", "second"]);
        push(r).unwrap(); // tracked now: plain push

        let other = parent.path().join("other");
        let other_arg = other.to_string_lossy().into_owned();
        run(parent.path(), &["clone", "-q", &remote_arg, &other_arg]);
        run(&other, &["config", "user.email", "t@t"]);
        run(&other, &["config", "user.name", "t"]);
        std::fs::write(other.join("kept.txt"), "third\n").unwrap();
        run(&other, &["commit", "-q", "-am", "third"]);
        push(&other).unwrap();

        pull(r).unwrap();
        assert_eq!(log(r, 1).unwrap()[0].subject, "third");
    }

    #[test]
    fn push_without_remote_says_so() {
        let dir = repo();
        assert!(push(dir.path()).unwrap_err().to_string().contains("remote"));
    }

    #[test]
    fn log_lists_commits_newest_first() {
        let dir = repo();
        let r = dir.path();
        std::fs::write(r.join("kept.txt"), "changed\n").unwrap();
        run(r, &["commit", "-q", "-am", "Second | with a pipe"]);
        let commits = log(r, 10).unwrap();
        let subjects: Vec<_> = commits.iter().map(|c| c.subject.as_str()).collect();
        assert_eq!(subjects, ["Second | with a pipe", "init"]);
        assert_eq!(commits[0].hash.len(), 40);
        assert!(commits[0].hash.starts_with(&commits[0].short));
        assert_eq!(log(r, 1).unwrap().len(), 1);

        let empty = tempfile::tempdir().unwrap();
        run(empty.path(), &["init", "-q"]);
        assert!(log(empty.path(), 10).unwrap().is_empty());
    }

    #[test]
    fn files_and_diffs_of_a_commit_and_between_two() {
        let dir = repo();
        let r = dir.path();
        std::fs::write(r.join("kept.txt"), "one\nTWO\n").unwrap();
        run(r, &["commit", "-q", "-am", "edit"]);
        run(r, &["mv", "gone.txt", "moved.txt"]);
        std::fs::write(r.join("new.txt"), "new\n").unwrap();
        run(r, &["add", "."]);
        run(r, &["commit", "-q", "-m", "move and add"]);
        let commits = log(r, 10).unwrap();
        let (last, edit, first) = (&commits[0].hash, &commits[1].hash, &commits[2].hash);
        let summary = |changes: Vec<Change>| -> Vec<(String, String, Option<String>)> {
            changes
                .into_iter()
                .map(|c| (c.status, c.path, c.orig))
                .collect()
        };

        assert_eq!(
            summary(commit_files(r, None, edit).unwrap()),
            [("M".into(), "kept.txt".into(), None)]
        );
        assert_eq!(
            summary(commit_files(r, None, first).unwrap()).len(),
            2,
            "the first commit has no parent"
        );
        // A range includes its oldest commit: from `edit` on, the edit, the rename and the new file.
        assert_eq!(
            summary(commit_files(r, Some(edit), last).unwrap()),
            [
                ("M".into(), "kept.txt".into(), None),
                ("R".into(), "moved.txt".into(), Some("gone.txt".into())),
                ("A".into(), "new.txt".into(), None),
            ]
        );
        // From the first commit (no parent): everything is new.
        let all: Vec<_> = summary(commit_files(r, Some(first), last).unwrap())
            .into_iter()
            .map(|(status, path, _)| (status, path))
            .collect();
        assert_eq!(
            all,
            [
                ("A".to_string(), "kept.txt".to_string()),
                ("A".into(), "moved.txt".into()),
                ("A".into(), "new.txt".into())
            ]
        );

        let d = commit_diff(r, None, edit, "kept.txt").unwrap();
        assert!(d.contains("-two") && d.contains("+TWO"), "{d}");
        let d = commit_diff(r, Some(edit), last, "kept.txt").unwrap();
        assert!(
            d.contains("-two") && d.contains("+TWO"),
            "the oldest commit counts: {d}"
        );
        let d = commit_diff(r, Some(first), last, "new.txt").unwrap();
        assert!(d.contains("+new"), "{d}");
        assert!(commit_files(r, None, "HEAD; rm -rf").is_err());
        assert!(commit_diff(r, Some("--output=x"), last, "a").is_err());
    }

    #[test]
    fn status_fails_cleanly_outside_a_repo() {
        let dir = tempfile::tempdir().unwrap();
        assert!(status(dir.path()).is_err());
    }
}
