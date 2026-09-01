/**
 * The workspaces section of the sidebar.
 *
 * Its own region under the tree rather than a heading inside it: the tree's
 * machinery assumes paths on disk everywhere it walks — drop spots, git marks,
 * rename — and a workspace has none of that. What it has is a name, who is in
 * it, and where its review stands, and that is all this shows.
 */
import type { Account, Workspace } from "./workspace";

type Props = {
  account: Account | null;
  workspaces: Workspace[];
  /** The workspace open in the main pane, if one is. */
  activeId: string | null;
  /** Live: the id of every room with an open socket. */
  live: Set<string>;
  onOpen: (ws: Workspace) => void;
  onNew: () => void;
  onSignIn: () => void;
};

/** The review state, in the status chip's own vocabulary. */
export function reviewTone(state: Workspace["review"]["state"]): string {
  return state === "approved" ? "approved" : state === "requested" ? "busy" : state === "changes" ? "draft" : "other";
}

export function reviewLabel(state: Workspace["review"]["state"]): string {
  return state === "requested" ? "in review" : state === "changes" ? "changes" : state === "approved" ? "approved" : "";
}

export function Workspaces({ account, workspaces, activeId, live, onOpen, onNew, onSignIn }: Props) {
  return (
    <div className="workspaces" data-testid="workspaces">
      <div className="ws-head">
        <span className="ws-title">Workspaces</span>
        {account && (
          <button className="ws-new" onClick={onNew} title="A new workspace, with you in it">
            + New
          </button>
        )}
      </div>
      {!account ? (
        <p className="ws-hint">
          A workspace is a plan argued out with others before it is a file.{" "}
          <button className="ws-link" onClick={onSignIn}>
            Sign in
          </button>{" "}
          to open one.
        </p>
      ) : workspaces.length === 0 ? (
        <p className="ws-hint">None yet. Make one, or ask to be invited.</p>
      ) : (
        <div className="ws-list">
          {workspaces.map((w) => {
            const label = reviewLabel(w.review.state);
            return (
              <button
                key={w.id}
                className={`row ws-row ${w.id === activeId ? "on" : ""}`}
                onClick={() => onOpen(w)}
                title={`${w.members.length === 1 ? "just you" : w.members.join(", ")}${
                  live.has(w.id) ? " — open" : ""
                }`}
              >
                <span className="row-name">{w.name}</span>
                {label && (
                  <span className={`status-dot tone-${reviewTone(w.review.state)}`} title={label} />
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
