import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import {
  changeOf,
  commitFiles as files,
  commitRange,
  diffLineClass,
  discardQuestion,
  fetchDue,
  inRange,
  keepChecked,
  pickCommits,
  type Change,
} from "./diff";
import { TRASH_NAME } from "./fileOps";
import { Icon } from "../ui/Icon";
import { createMenu } from "../ui/Menu";
import { Loaded, PanelHead } from "../ui/Panel";
import { PromptDialog } from "../ui/PromptDialog";
import { Resizer } from "../ui/Resizer";

type Ref = { name: string; kind: "head" | "branch" | "remote" | "tag" };
type Commit = {
  hash: string;
  short: string;
  author: string;
  email: string;
  /** Relative ("3 hours ago"); `when` is the exact date. */
  date: string;
  when: string;
  subject: string;
  body: string;
  refs: Ref[];
  /** Commits it holds (itself and its ancestors): the first commit is 1; null in a very large history. */
  number: number | null;
};
type Branch = { name: string; current: boolean };
type Busy = "commit" | "generate" | "push" | "pull" | "branch" | "discard";

/** Last background fetch per repo, for the whole app (the panel may be closed and reopened). */
const fetched = new Map<string, number>();

/**
 * Branch (switch / create), pull and push, changed files with their diff and commit of the checked files;
 * History: the last commits; a click shows one commit's author, message and changes, Shift+click those of a
 * range of commits. Right-click a file: its own history (renames followed) until the filter is cleared.
 * Not live: loads when shown, when the shown repo changes, after an action, on ⟳, or when `refresh` changes
 * (an agent in its repo finished, or a command did in a terminal there). Never on a timer or a watcher.
 * Showing a repo, ⟳ and the branch menu also fetch in the background (at most every 5 min per repo, ⟳ always),
 * so Pull shows how many commits the remote has.
 */
export function GitPanel(props: {
  root?: string;
  branch?: string;
  /** Commits the upstream has that we do not (badge on Pull). */
  behind?: number;
  refresh?: number;
  /** ⟳: re-reads the tab's repo and branch (a `git init` or a checkout by an agent brings no prompt). */
  onRecheck(): void;
  /** Asked from the files panel: History of this file (path from the repo root). A new object each time. */
  showHistory?: { file: string };
  /** The agent ✨ Generate sends the diff to (the first one used on this machine). */
  agent?: string;
  onClose(): void;
  /** Branch, commits or upstream changed: the tabs of this repo re-read their branch and stats. */
  onHeadChanged?(): void;
}) {
  const [view, setView] = createSignal<"changes" | "history">("changes");
  // Heights of the commit list and the file list, once dragged (until then CSS sizes them).
  const [logHeight, setLogHeight] = createSignal<number>();
  const [filesHeight, setFilesHeight] = createSignal<number>();
  const sized = (h: number | undefined) => (h === undefined ? {} : { height: `${h}px`, "max-height": "none" });
  const handle = (h: () => number | undefined, set: (h: number) => void) => (
    <Resizer edge="bottom" size={h()} min={40} max={window.innerHeight * 0.7} onResize={set} />
  );
  const [changes, setChanges] = createSignal<Change[] | string>();
  const [checked, setChecked] = createSignal(new Set<string>());
  const [selected, setSelected] = createSignal<Change>();
  const [diff, setDiff] = createSignal<string>();
  const [message, setMessage] = createSignal("");
  const [busy, setBusy] = createSignal<Busy>();
  const [note, setNote] = createSignal<{ text: string; error?: boolean }>();
  const [commits, setCommits] = createSignal<Commit[] | string>();
  const [picks, setPicks] = createSignal<string[]>([]);
  const [commitChanges, setCommitChanges] = createSignal<Change[] | string>();
  const [naming, setNaming] = createSignal(false);
  /** History of this file only (path from the repo root); undefined = the whole repo. */
  const [historyFile, setHistoryFile] = createSignal<string>();
  const menu = createMenu();
  let request = 0; // drops answers for a repo we already left
  let logRequest = 0;

  const list = () => (Array.isArray(changes()) ? (changes() as Change[]) : []);
  const picked = () => list().filter((c) => checked().has(c.path));
  // Read by every commit row (its highlight): mapped once per log, not once per row.
  const order = createMemo(() => {
    const log = commits();
    return Array.isArray(log) ? log.map((c) => c.hash) : [];
  });
  const range = () => commitRange(order(), picks());
  const short = (hash?: string) => hash?.slice(0, 7);
  /** The commit whose details show: one picked, not a range. */
  const picked1 = () => {
    const r = range();
    const log = commits();
    return r && !r.from && Array.isArray(log) ? log.find((c) => c.hash === r.to) : undefined;
  };
  const clearDiff = () => {
    setSelected(undefined);
    setDiff(undefined);
  };

  /** `keep`: same repo, newer state. The list, checks and open diff stay put instead of starting over. */
  async function load(root: string, keep = false) {
    const id = ++request;
    const before = list();
    const open = selected();
    if (!keep) {
      setChanges(undefined);
      clearDiff();
    }
    const result = await invoke<Change[]>("git_status", { root }).catch((e) => String(e));
    if (id !== request) return;
    setChanges(result);
    const now = Array.isArray(result) ? result : [];
    setChecked(keep ? keepChecked(checked(), before, now) : new Set(now.map((c) => c.path)));
    if (!keep || view() !== "changes") return;
    const still = now.find((c) => c.path === open?.path);
    if (still) show(still);
    else clearDiff();
  }

  async function loadLog(root: string) {
    const id = ++logRequest;
    setCommits(undefined);
    setPicks([]);
    setCommitChanges(undefined);
    const result = await invoke<Commit[]>("git_log", { root, file: historyFile() }).catch((e) => String(e));
    if (id === logRequest) setCommits(result);
  }

  /** History of one file, or of the whole repo again (`undefined`). */
  function historyOf(file?: string) {
    setHistoryFile(file);
    setView("history");
    clearDiff();
    if (props.root) loadLog(props.root);
  }

  /** `keep`: a reload in place (see `load`). */
  function reload(keep = false) {
    const root = props.root;
    if (!root) return;
    load(root, keep);
    if (view() === "history") loadLog(root);
  }

  /** Updates the remote-tracking branches; then this repo's tabs re-read their stats (behind). Errors stay quiet. */
  async function fetchRemote(root: string, force = false) {
    if (!fetchDue(fetched, root, Date.now(), force)) return;
    const ok = await invoke("git_fetch", { root }).then(() => true, () => false);
    if (ok && root === props.root) props.onHeadChanged?.();
  }

  /** After a commit, pull, discard or branch change: this panel and the repo's tabs show the new state. */
  function headMoved() {
    reload();
    props.onHeadChanged?.();
  }

  /** The diff of a changed file, or of a file of the picked commit(s). */
  async function show(change: Change) {
    const id = ++request;
    setSelected(change);
    setDiff(undefined);
    const r = range();
    const text = await (view() === "history" && r
      ? invoke<string>("git_commit_diff", { root: props.root, from: r.from, to: r.to, path: change.path })
      : invoke<string>("git_diff", { root: props.root, path: change.path, untracked: change.status === "?" })
    ).catch((e) => String(e));
    if (id === request) setDiff(text);
  }

  async function pick(hash: string, shift: boolean) {
    setPicks(pickCommits(picks(), hash, shift));
    clearDiff();
    const r = range();
    setCommitChanges(undefined);
    if (!r) return;
    const id = ++logRequest;
    const result = await invoke<Change[]>("git_commit_files", { root: props.root, from: r.from, to: r.to }).catch(
      (e) => String(e),
    );
    if (id !== logRequest) return;
    setCommitChanges(result);
    // In a file's history, its diff in that commit is what one came for.
    const file = historyFile();
    const own = file && Array.isArray(result) ? changeOf(result, file) : undefined;
    if (own) show(own);
  }

  function setMode(next: "changes" | "history") {
    if (view() === next) return;
    setView(next);
    clearDiff();
    if (next === "history" && props.root) loadLog(props.root);
  }

  function toggle(path: string) {
    const next = new Set(checked());
    if (!next.delete(path)) next.add(path);
    setChecked(next);
  }

  const allChecked = () => list().length > 0 && picked().length === list().length;
  const toggleAll = () => setChecked(new Set(allChecked() ? [] : list().map((c) => c.path)));

  /** Runs one git action with its busy state; its answer (or error) shows under the header. */
  async function act(kind: Busy, run: () => Promise<string | void>) {
    setBusy(kind);
    setNote(undefined);
    try {
      const text = await run();
      if (text) setNote({ text });
      return true;
    } catch (e) {
      setNote({ text: String(e), error: true });
      return false;
    } finally {
      setBusy(undefined);
    }
  }

  const generate = () =>
    act("generate", async () => {
      setMessage(await invoke<string>("commit_message", { root: props.root, files: files(picked()) }));
    });

  async function commit(andPush = false) {
    if (!canCommit()) return;
    const done = await act("commit", async () => {
      const summary = await invoke<string>("git_commit", { root: props.root, files: files(picked()), message: message() });
      setMessage("");
      return summary;
    });
    if (!done) return;
    headMoved();
    if (andPush) push();
  }

  async function push() {
    if (await act("push", () => invoke<string>("git_push", { root: props.root }))) props.onHeadChanged?.();
  }

  async function pull() {
    // Even a failed pull changes the repo: a conflict leaves a merge in progress and files to resolve.
    await act("pull", () => invoke<string>("git_pull", { root: props.root }));
    headMoved();
  }

  /** Back to HEAD: the checked files, or the one right-clicked. Asks first (tracked changes cannot be undone). */
  async function discard(changes: Change[]) {
    if (busy() || !changes.length || !confirm(discardQuestion(changes, TRASH_NAME))) return;
    await act("discard", () => invoke<void>("git_discard", { root: props.root, files: files(changes) }));
    // Even a partial failure changed some files.
    headMoved();
  }

  /** `pending`: a change not committed yet, which can also be discarded. */
  function fileMenu(e: MouseEvent, change: Change, pending?: boolean) {
    menu.open(e, [
      { label: "Show history of this file", run: () => historyOf(change.path) },
      ...(pending ? [{ label: "Discard changes…", run: () => discard([change]) }] : []),
    ]);
  }

  async function changeBranch(command: "git_switch" | "git_create_branch", branch: string) {
    setNaming(false);
    if (!(await act("branch", () => invoke<void>(command, { root: props.root, branch })))) return;
    setNote({ text: `On branch ${branch}` });
    headMoved();
  }

  async function branchMenu(e: MouseEvent) {
    if (props.root) fetchRemote(props.root);
    const branches = await invoke<Branch[]>("git_branches", { root: props.root }).catch((err) => {
      setNote({ text: String(err), error: true });
      return [] as Branch[];
    });
    // The click's position is still readable after the await.
    menu.open(e, [
      { label: "New branch…", run: () => setNaming(true) },
      "separator",
      // Most recent first; a long list would not fit on screen.
      ...branches.slice(0, 30).map((b) => ({
        label: b.current ? `${b.name} (current)` : b.name,
        run: () => !b.current && changeBranch("git_switch", b.name),
      })),
    ]);
  }

  const canCommit = () => !busy() && picked().length > 0 && message().trim() !== "";

  // Tracks the root only: load() reads the list it replaces, which must not loop back here.
  createEffect(
    on(
      () => props.root,
      (root) => {
        setNote(undefined);
        setHistoryFile(undefined); // a path of the previous repo
        reload();
        if (root) fetchRemote(root);
      },
    ),
  );
  createEffect(on(() => props.refresh, () => reload(true), { defer: true }));
  // Not deferred: the panel may have just been shown for it. After the root effect, which clears the filter.
  createEffect(on(() => props.showHistory, (ask) => ask && historyOf(ask.file)));

  const FileRow = (p: { change: Change; check?: boolean }) => (
    <div
      class="git-file"
      classList={{ active: selected()?.path === p.change.path }}
      title={p.change.path}
      onContextMenu={(e) => fileMenu(e, p.change, p.check)}
    >
      <Show when={p.check}>
        <input type="checkbox" checked={checked().has(p.change.path)} onChange={() => toggle(p.change.path)} />
      </Show>
      <span class={`git-status s-${p.change.status === "?" ? "u" : p.change.status}`}>
        {p.change.status === "?" ? "U" : p.change.status}
      </span>
      <span class="git-lines">
        <Show when={p.change.lines}>
          {(l) => (
            <>
              <span class="stat-add">+{l().added}</span> <span class="stat-del">−{l().deleted}</span>
            </>
          )}
        </Show>
      </span>
      <span class="git-path" onClick={() => show(p.change)}>
        <bdo dir="ltr">{p.change.path}</bdo>
      </span>
    </div>
  );

  return (
    <aside class="panel git" data-zoom="git">
      <PanelHead
        title={
          <Show when={props.branch} fallback="Git">
            <button class="branch branch-btn" title="Switch or create a branch" disabled={!!busy()} onClick={branchMenu}>
              <Icon name="branch" size={14} /> {props.branch} <Icon name="down" size={12} />
            </button>
          </Show>
        }
        closeTip="Close (Ctrl+Shift+G)"
        onClose={() => props.onClose()}
      >
        <Show when={props.root}>
          <button
            class="icon-btn pull-btn"
            title={props.behind ? `Pull (${props.behind} commit${props.behind === 1 ? "" : "s"} behind)` : "Pull"}
            disabled={!!busy()}
            onClick={pull}
          >
            <Icon name="pull" />
            <Show when={props.behind}>
              <span class="pull-badge">{props.behind! > 99 ? "99+" : props.behind}</span>
            </Show>
          </button>
          <button class="icon-btn" title="Push" disabled={!!busy()} onClick={push}>
            <Icon name="push" />
          </button>
        </Show>
        <button
          class="icon-btn"
          title="Refresh (and fetch)"
          onClick={() => {
            props.onRecheck();
            reload();
            if (props.root) fetchRemote(props.root, true);
          }}
        >
          <Icon name="refresh" />
        </button>
      </PanelHead>
      <Show when={props.root} fallback={<div class="tree-note">Not a git repository</div>}>
        <div class="git-views">
          <div class="segmented">
            <button classList={{ on: view() === "changes" }} onClick={() => setMode("changes")}>
              Changes
            </button>
            <button classList={{ on: view() === "history" }} onClick={() => setMode("history")}>
              History
            </button>
          </div>
          <Show when={busy() === "push" || busy() === "pull" || busy() === "branch"}>
            <span class="git-busy">{busy() === "push" ? "Pushing…" : busy() === "pull" ? "Pulling…" : "Switching…"}</span>
          </Show>
        </div>
        <Show when={note()}>
          {(n) => <div class="commit-note git-note" classList={{ error: n().error }}>{n().text}</div>}
        </Show>
        <Show
          when={view() === "history"}
          fallback={
            <>
            <div class="git-files" style={sized(filesHeight())}>
              <Loaded value={changes()}>
                {() => (
                  <Show when={list().length} fallback={<div class="tree-note">No changes</div>}>
                    <label class="git-file all">
                      <input type="checkbox" checked={allChecked()} onChange={toggleAll} />
                      <span>
                        {picked().length} of {list().length} files selected
                      </span>
                      <button
                        class="icon-btn git-discard"
                        title="Discard the changes to the selected files"
                        disabled={!!busy() || picked().length === 0}
                        onClick={(e) => {
                          e.preventDefault(); // inside the label: would also toggle every checkbox
                          discard(picked());
                        }}
                      >
                        <Icon name="discard" />
                      </button>
                    </label>
                    <For each={list()}>{(change) => <FileRow change={change} check />}</For>
                  </Show>
                )}
              </Loaded>
            </div>
            {handle(filesHeight, setFilesHeight)}
            </>
          }
        >
          <Show when={historyFile()}>
            {(file) => (
              <div class="git-file all git-filter" title={file()}>
                <span>
                  History of <bdo dir="ltr">{file()}</bdo>
                </span>
                <button class="icon-btn" title="Back to the whole history" onClick={() => historyOf(undefined)}>
                  <Icon name="close" size={12} />
                </button>
              </div>
            )}
          </Show>
          <div class="git-files git-log" style={sized(logHeight())}>
            <Loaded value={commits()}>
              {(log) => (
                <Show when={log().length} fallback={<div class="tree-note">No commits yet</div>}>
                  <For each={log()}>
                    {(commit) => (
                      <div
                        class="git-commit"
                        classList={{ active: inRange(order(), picks(), commit.hash) }}
                        title={`${commit.short} · ${commit.author} · ${commit.date}\nShift+click another commit to see the whole range`}
                        // Shift+click would also select the page's text.
                        onMouseDown={(e) => e.shiftKey && e.preventDefault()}
                        onClick={(e) => pick(commit.hash, e.shiftKey)}
                      >
                        <Show when={commit.number}>
                          <span class="git-num">#{commit.number}</span>
                        </Show>
                        <span class="git-hash">{commit.short}</span>
                        <For each={commit.refs}>
                          {(ref) => <span class={`git-ref ${ref.kind}`}>{ref.name}</span>}
                        </For>
                        <span class="git-subject">{commit.subject}</span>
                        <span class="git-when">{commit.date}</span>
                      </div>
                    )}
                  </For>
                </Show>
              )}
            </Loaded>
          </div>
          {handle(logHeight, setLogHeight)}
          <Show when={range()}>
            {(r) => (
              <>
              <Show when={picked1()}>
                {(c) => (
                  <div class="git-commit-info">
                    <div class="git-commit-meta">
                      <b>{c().author}</b> &lt;{c().email}&gt; · {c().when} ({c().date})
                    </div>
                    <div class="git-commit-msg">
                      <b>{c().subject}</b>
                      <Show when={c().body}>{"\n\n" + c().body}</Show>
                    </div>
                  </div>
                )}
              </Show>
              <div class="git-files" style={sized(filesHeight())}>
                <div class="git-file all">
                  {r().from
                    ? `${r().count} commits, ${short(r().from)} to ${short(r().to)}`
                    : `Changes in ${short(r().to)}`}
                </div>
                <Loaded value={commitChanges()}>
                  {(c) => <For each={c()}>{(change) => <FileRow change={change} />}</For>}
                </Loaded>
              </div>
              {handle(filesHeight, setFilesHeight)}
              </>
            )}
          </Show>
        </Show>
        <div class="diff">
          <Show
            when={selected()}
            fallback={
              <div class="tree-note">
                {view() === "history" && !picks().length
                  ? "Click a commit to see its changes; Shift+click another one for the whole range"
                  : "Click a file to see its diff"}
              </div>
            }
          >
            <Show when={diff() !== undefined} fallback={<div class="tree-note">Loading…</div>}>
              <For each={diff()!.split("\n")}>{(line) => <div class={`diff-line ${diffLineClass(line)}`}>{line || " "}</div>}</For>
            </Show>
          </Show>
        </div>
        <Show when={view() === "changes"}>
          <div class="commit-box">
            <textarea
              placeholder="Commit message (Ctrl+Enter to commit)"
              value={message()}
              onInput={(e) => setMessage(e.currentTarget.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter" && e.ctrlKey) commit();
              }}
            />
            <div class="commit-actions">
              <button
                disabled={!!busy() || picked().length === 0}
                onClick={generate}
                title={`Write the message from the diff of the selected files (sent to ${props.agent ?? "Claude Code"})`}
              >
                {busy() === "generate" ? "Generating…" : "✨ Generate"}
              </button>
              <button class="primary" disabled={!canCommit()} onClick={() => commit(true)} title="Commit, then push">
                Commit & Push
              </button>
              <button disabled={!canCommit()} onClick={() => commit()}>
                {busy() === "commit" ? "Committing…" : `Commit ${picked().length} file${picked().length === 1 ? "" : "s"}`}
              </button>
            </div>
          </div>
        </Show>
        <Show when={naming()}>
          <PromptDialog
            title="New branch"
            placeholder="Branch name, e.g. feature/login"
            hint={`Created from the current commit (${props.branch}) and checked out; local changes come along.`}
            confirm="Create"
            onSubmit={(name) => changeBranch("git_create_branch", name)}
            onCancel={() => setNaming(false)}
          />
        </Show>
      </Show>
      <menu.Menu />
    </aside>
  );
}
