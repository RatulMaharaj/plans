import { useEffect, useState } from "react";
import { api, type GitStatus, type StatusEntry } from "./api";
import { Dropdown } from "./Dropdown";

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
  const [branches, setBranches] = useState<string[]>([]);

  useEffect(() => {
    api
      .gitBranches(repo)
      .then((b) => setBranches(b.branches))
      .catch(() => setBranches([]));
  }, [repo, status?.branch]);

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
  const staged = mine.filter((e) => e.index !== " " && e.index !== "?");
  const unstaged = mine.filter((e) => e.worktree !== " ");
  const others = status.entries.length - mine.length;

  const commit = () => {
    if (!staged.length) return notify("Nothing staged to commit", "error");
    onRun("Committed", async () => {
      await api.gitCommit(repo, message);
      setMessage("");
    });
  };

  return (
    <aside className="git">
      <div className="git-head">
        <span className="tag">Repository</span>
        <div className="branch-row">
          <Dropdown
            className="wide"
            ariaLabel="Branch"
            value={status.branch}
            disabled={!!busy}
            onChange={(b) => onRun(`Switched to ${b}`, () => api.gitCheckout(repo, b))}
            choices={(branches.length ? branches : [status.branch]).map((b) => ({
              value: b,
              label: b,
            }))}
          />
        </div>
        <div className="sync">
          <button
            className="ghost"
            disabled={!!busy}
            onClick={() => onRun("Pulled", () => api.gitPull(repo))}
          >
            Pull{status.behind ? <span className="n">{status.behind}</span> : null}
          </button>
          <button
            className="ghost"
            disabled={!!busy}
            onClick={() => onRun("Pushed", () => api.gitPush(repo))}
          >
            Push{status.ahead ? <span className="n">{status.ahead}</span> : null}
          </button>
        </div>
        {!status.hasUpstream && (
          <p className="tag note">
            This branch has no upstream. Push will create one on origin.
          </p>
        )}
      </div>

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
