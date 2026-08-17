import { useEffect, useState } from "react";
import { api, type GitStatus, type StatusEntry } from "./api";

type Props = {
  repo: string;
  scope: string[];
  status: GitStatus | null;
  busy: string | null;
  onRun: (label: string, fn: () => Promise<unknown>) => void;
  notify: (msg: string, kind?: "info" | "error") => void;
};

/**
 * The panel is for *acting* on the repository, never for finding out its
 * state — the index already carries a mark for every changed plan. That's what
 * makes it safe to leave closed.
 */
export function GitPanel({ repo, scope, status, busy, onRun, notify }: Props) {
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

  const staged = status.entries.filter((e) => e.index !== " " && e.index !== "?");
  const unstaged = status.entries.filter((e) => e.worktree !== " ");

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
          <select
            className="branch-select"
            value={status.branch}
            disabled={!!busy}
            aria-label="Branch"
            onChange={(e) =>
              onRun(`Switched to ${e.target.value}`, () =>
                api.gitCheckout(repo, e.target.value),
              )
            }
          >
            {branches.length ? (
              branches.map((b) => <option key={b}>{b}</option>)
            ) : (
              <option>{status.branch}</option>
            )}
          </select>
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
        onAll={
          unstaged.length
            ? () =>
                onRun("Staged all", () =>
                  api.gitStage(repo, scope.length ? scope : ["."]),
                )
            : undefined
        }
      />

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
}: {
  title: string;
  entries: StatusEntry[];
  staged: boolean;
  busy: string | null;
  action: string;
  onAction: (paths: string[]) => void;
  onAll?: () => void;
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
        return (
          <div className="change" key={`${staged}-${e.path}`}>
            <span className="change-path" title={e.path}>
              <span className="change-name">{e.path.split("/").pop()}</span>
              {dir && <span className="change-dir">{dir}</span>}
            </span>
            <button
              className="act"
              onClick={() => onAction([e.path])}
              disabled={!!busy}
            >
              {action}
            </button>
          </div>
        );
      })}
    </section>
  );
}
