/**
 * The workspaces bar, under the tree.
 *
 * The workspaces themselves are headings *in* the tree now — a workspace is a
 * folder of files, and the tree already knows how to draw folders, filter
 * them, and offer new-file, rename, move and delete. What is left here is the
 * one thing the tree has nowhere to put: making a workspace, and the sentence
 * that explains what one is to someone who is not signed in.
 */
import type { Account } from "./workspace";

type Props = {
  account: Account | null;
  /** How many are on the shelf, so an empty shelf can say so. */
  count: number;
  onNew: () => void;
  onSignIn: () => void;
};

export function Workspaces({ account, count, onNew, onSignIn }: Props) {
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
          A workspace is a folder of files, edited together and live.{" "}
          <button className="ws-link" onClick={onSignIn}>
            Sign in
          </button>{" "}
          to open one.
        </p>
      ) : count === 0 ? (
        <p className="ws-hint">None yet. Make one, or ask to be invited.</p>
      ) : null}
    </div>
  );
}
