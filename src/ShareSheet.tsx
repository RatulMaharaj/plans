/**
 * Sharing a plan: one address, on or off.
 *
 * What this used to be — a list of minted tokens, each with its own expiry
 * and its own Revoke — was a management page for a capability. A published
 * plan is simpler and says more: there is one page, its URL is the whole of
 * the secret, and the thing that undoes it is "Stop sharing". While it is on
 * the page follows the file, so what a reader sees is what the author last
 * saved. The reasoning is in plans/public-plan-pages.md.
 */
import { useEffect, useRef, useState } from "react";

type Props = {
  /** What is being shared, for the sheet's title. */
  name: string;
  /** Whether the page is live, and where — null when nothing is shared yet. */
  url: string | null;
  /**
   * A workspace document's page reads the room, so it is live without anyone
   * saving anything; a file's page follows its saves. The sheet says which,
   * because they are different promises.
   */
  live: boolean;
  onPublish: () => Promise<void> | void;
  onStop: () => Promise<void> | void;
  onCopy: () => Promise<void> | void;
  onClose: () => void;
};

export function ShareSheet({ name, url, live, onPublish, onStop, onCopy, onClose }: Props) {
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLInputElement | null>(null);
  const sheet = useRef<HTMLDivElement | null>(null);

  // Focus lands on the sheet itself, so Escape is heard here and stops before
  // it reaches the app's own Escape — which would leave zen, not close this.
  useEffect(() => sheet.current?.focus(), []);

  // The URL is on the clipboard, and also in a field: a copy that silently
  // failed would leave nothing to paste and nothing to see.
  useEffect(() => {
    if (url) field.current?.select();
  }, [url]);

  const run = async (fn: () => Promise<void> | void) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="matter-scrim" onMouseDown={onClose}>
      <div
        className="matter-sheet share-sheet"
        data-testid="share-sheet"
        ref={sheet}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <div className="matter-head">
          <span className="tag">Share “{name}”</span>
        </div>
        <p className="name-path">
          {url
            ? live
              ? "This plan has a page. Anyone with the address can read it, and it follows the document as it changes."
              : "This plan has a page. Anyone with the address can read it, and it follows every save while sharing is on."
            : "A page anyone can open in a browser — read-only, no account. The address is the whole of the secret: share it with the people you mean to, and stop sharing to take it back."}
        </p>
        {url && (
          <input
            ref={field}
            className="name-field share-link"
            data-testid="share-link"
            value={url}
            readOnly
            spellCheck={false}
            onFocus={(e) => e.currentTarget.select()}
          />
        )}
        <div className="matter-foot">
          <span>esc close</span>
          {url ? (
            <>
              <button className="rail-btn" onClick={() => void run(onStop)} disabled={busy} data-testid="stop-sharing">
                Stop sharing
              </button>
              <button className="act" onClick={() => void run(onCopy)} disabled={busy}>
                Copy link
              </button>
            </>
          ) : (
            <button className="act" onClick={() => void run(onPublish)} disabled={busy} data-testid="publish">
              Share
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
