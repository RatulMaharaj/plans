import { useState } from "react";
import { api, type GitStatus, type StatusEntry } from "./api";

type Props = {
  repo: string;
  status: GitStatus | null;
  busy: string | null;
  onRun: (label: string, fn: () => Promise<unknown>) => void;
  notify: (msg: string, kind?: "info" | "error") => void;
  /** Open a changed file and show its diff. */
  onOpen: (relPath: string) => void;
};

/**
 * The panel is for *acting* on the repository, never for finding out its
 * state — the index already carries a mark for every changed plan. That's what
 * makes it safe to leave closed.
 */
export function GitPanel({ repo, status, busy, onRun, notify, onOpen }: Props) {
  const [message, setMessage] = useState("");

  if (!status) {
    return (
      <aside className="git">
        <div className="git-section none">No repository status.</div>
      </aside>
    );
  }

  // This app edits markdown, so the panel only ever acts on markdown. A repo's
  // source changes are none of its business, and "stage all" must never mean
  // "git add ." — it stages exactly the files listed above it.
  const mine = status.entries.filter((e) => /\.(md|markdown)$/i.test(e.path));
  /**
   * Conflicted files are neither staged nor merely modified: both sides are
   * still sitting in the file. They come out of the two lists and into their
   * own, because "Unstage" and "Discard" are the wrong verbs for them.
   */
  const isConflict = (e: StatusEntry) =>
    e.index === "U" ||
    e.worktree === "U" ||
    e.index + e.worktree === "AA" ||
    e.index + e.worktree === "DD";
  const clashing = mine.filter(isConflict);
  const settled = mine.filter((e) => !isConflict(e));
  const staged = settled.filter((e) => e.index !== " " && e.index !== "?");
  const unstaged = settled.filter((e) => e.worktree !== " ");
  const others = status.entries.length - mine.length;

  /**
   * An unfinished merge or rebase. The app cannot finish one — that is a
   * terminal's job — so it says so plainly and takes away the two buttons
   * that would make the situation worse.
   */
  const mid = status.operation;

  const commit = () => {
    if (!staged.length) return notify("Nothing staged to commit", "error");
    onRun("Committed", async () => {
      await api.gitCommit(repo, message);
      setMessage("");
    });
  };

  return (
    <aside className="git">
      {/*
       * The same bar the chat and the tree carry, and for the same reason:
       * these are columns side by side, and one of them starting a few pixels
       * lower reads as a mistake. The repository's name is in the rail and
       * the branch is beside it, so neither is repeated here — what belongs
       * in a header is what you would press.
       */}
      <div className="panel-head">
        <span className="tag">Changes</span>
        <span className="mux-spacer" />
        {/* The word says what it does, the arrow says which way, and the
            count is what you actually read when there is one. */}
        <button
          className="panel-act"
          disabled={!!busy || !!mid}
          title={mid ? `Finish the ${mid} first` : status.behind ? `Pull ${status.behind} behind` : "Pull"}
          aria-label="Pull"
          onClick={() => onRun("Pulled", () => api.gitPull(repo))}
        >
          Pull <span className="arrow">↓</span>
          {status.behind ? <span className="n"> {status.behind}</span> : null}
        </button>
        <button
          className="panel-act"
          disabled={!!busy || !!mid}
          title={mid ? `Finish the ${mid} first` : status.ahead ? `Push ${status.ahead} ahead` : "Push"}
          aria-label="Push"
          onClick={() => onRun("Pushed", () => api.gitPush(repo))}
        >
          Push <span className="arrow">↑</span>
          {status.ahead ? <span className="n"> {status.ahead}</span> : null}
        </button>
      </div>
      {mid && (
        <p className="git-alarm">
          A {mid} is unfinished{clashing.length ? `, and ${clashing.length} file${clashing.length > 1 ? "s" : ""} still hold both sides` : ""}. Resolve
          the files, then <code>git {mid} --continue</code> or{" "}
          <code>git {mid} --abort</code> in a terminal. Pull and push wait until
          you have.
        </p>
      )}
      {!mid && !status.hasUpstream && (
        <p className="git-aside">
          This branch has no upstream. Push will create one on origin.
        </p>
      )}

      <div className="commit">
        <textarea
          placeholder="Describe this change"
          value={message}
          rows={3}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) commit();
          }}
        />
        <button
          className="solid"
          onClick={commit}
          disabled={!!busy || !staged.length || !message.trim()}
        >
          Commit {staged.length ? `${staged.length} file${staged.length > 1 ? "s" : ""}` : ""}
        </button>
      </div>

      {clashing.length > 0 && (
        <section className="git-section">
          <div className="section-head">
            <span className="tag">Conflicted</span>
          </div>
          {clashing.map((e) => (
            <div className="change" key={`conflict-${e.path}`}>
              <button
                className="change-path"
                onClick={() => onOpen(e.path)}
                title="Open it and see both sides"
              >
                <span className="change-name conflicted">{e.path.split("/").pop()}</span>
              </button>
              {/* Staging is how git is told a conflict is settled, so it is
                  the one action offered — after you have edited the file. */}
              <span className="change-acts">
                <button
                  className="act"
                  disabled={!!busy}
                  onClick={() => onRun("Marked resolved", () => api.gitStage(repo, [e.path]))}
                >
                  Resolved
                </button>
              </span>
            </div>
          ))}
        </section>
      )}

      <Section
        title="Staged"
        entries={staged}
        staged
        busy={busy}
        action="Unstage"
        onAction={(paths) => onRun("Unstaged", () => api.gitUnstage(repo, paths))}
        onOpen={onOpen}
        onAll={
          staged.length
            ? () =>
                onRun("Unstaged all", () =>
                  api.gitUnstage(repo, staged.map((e) => e.path)),
                )
            : undefined
        }
      />

      <Section
        title="Not staged"
        entries={unstaged}
        staged={false}
        busy={busy}
        action="Stage"
        onAction={(paths) => onRun("Staged", () => api.gitStage(repo, paths))}
        onOpen={onOpen}
        onDiscard={(path) => {
          // Discarding cannot be undone by git, so it asks first.
          if (!window.confirm(`Throw away your changes to ${path}?`)) return;
          onRun("Change discarded", () => api.gitDiscard(repo, [path]));
        }}
        onAll={
          unstaged.length
            ? () =>
                onRun("Staged all", () =>
                  api.gitStage(repo, unstaged.map((e) => e.path)),
                )
            : undefined
        }
      />

      {others > 0 && (
        <p className="git-aside">
          {others} other change{others > 1 ? "s" : ""} in this repository, outside
          markdown. Not shown, and not touched by anything here.
        </p>
      )}

    </aside>
  );
}

function Section({
  title,
  entries,
  staged,
  busy,
  action,
  onAction,
  onAll,
  onDiscard,
  onOpen,
}: {
  title: string;
  entries: StatusEntry[];
  staged: boolean;
  busy: string | null;
  action: string;
  onAction: (paths: string[]) => void;
  onAll?: () => void;
  /** Present on the unstaged side only: throw the change away. */
  onDiscard?: (path: string) => void;
  onOpen?: (path: string) => void;
}) {
  return (
    <section className="git-section">
      <div className="section-head">
        <span className="tag">
          {title} {entries.length ? `· ${entries.length}` : ""}
        </span>
        {onAll && (
          <button className="act" onClick={onAll} disabled={!!busy}>
            {action} all
          </button>
        )}
      </div>
      {entries.length === 0 && <div className="none">Nothing here</div>}
      {entries.map((e) => {
        const dir = e.path.includes("/")
          ? e.path.slice(0, e.path.lastIndexOf("/"))
          : "";
        // A deleted file has nothing to open — its diff is all that's left.
        const gone = (staged ? e.index : e.worktree) === "D";
        return (
          <div className="change" key={`${staged}-${e.path}`}>
            <button
              className="change-path"
              title={gone ? `${e.path} (deleted)` : `Open ${e.path}`}
              disabled={!onOpen || gone}
              onClick={() => onOpen?.(e.path)}
            >
              <span className={`change-name ${gone ? "gone" : ""}`}>
                {e.path.split("/").pop()}
              </span>
              {dir && <span className="change-dir">{dir}</span>}
            </button>
            <span className="change-acts">
              {onDiscard && (
                <button
                  className="act quiet"
                  onClick={() => onDiscard(e.path)}
                  disabled={!!busy}
                  title={gone ? "Restore this file" : "Throw this change away"}
                >
                  Undo
                </button>
              )}
              <button
                className="act"
                onClick={() => onAction([e.path])}
                disabled={!!busy}
              >
                {action}
              </button>
            </span>
          </div>
        );
      })}
    </section>
  );
}
