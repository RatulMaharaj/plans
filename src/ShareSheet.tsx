/**
 * Share links, minted and killed.
 *
 * A share link is a person publishing one document to chosen readers, so the
 * residual risk — the link travels further than intended — is answered with
 * revocation rather than by pretending the link is not a capability. Which is
 * why minting and the list of live links are one small sheet and not a
 * management page: you mint one, and the thing that undoes it is right there.
 * The reasoning is in plans/sharable-links.md.
 */
import { track } from "./analytics";
import { useEffect, useRef, useState } from "react";
import { workspace, type ShareLink } from "./workspace";

type Props = {
  /** The workspace being shared, and its name for the sheet's title. */
  id: string;
  name: string;
  /** The app's toast, so failures are said in the usual voice. */
  notify: (text: string, kind?: "info" | "error") => void;
  onClose: () => void;
};

/** "today", "3 days ago" — enough to shame a link nobody remembers minting. */
export function ago(at: number, now = Date.now()): string {
  const days = Math.floor((now - at) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

/** The other half of the same sentence: how long this one has left. */
export function until(at: number, now = Date.now()): string {
  const days = Math.ceil((at - now) / 86_400_000);
  if (days <= 0) return "expired";
  if (days === 1) return "expires tomorrow";
  return `expires in ${days} days`;
}

export function ShareSheet({ id, name, notify, onClose }: Props) {
  const [links, setLinks] = useState<ShareLink[] | null>(null);
  const [minted, setMinted] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLInputElement | null>(null);
  const sheet = useRef<HTMLDivElement | null>(null);

  // Focus lands on the sheet itself, so Escape is heard here and stops before
  // it reaches the app's own Escape — which would leave zen, not close this.
  useEffect(() => sheet.current?.focus(), []);

  useEffect(() => {
    let alive = true;
    void workspace.share
      .list(id)
      .then((l) => alive && setLinks(l))
      .catch(() => alive && setLinks([]));
    return () => {
      alive = false;
    };
  }, [id]);

  // The link is on the clipboard, and also in a field: a copy that silently
  // failed would leave nothing to paste and nothing to see.
  useEffect(() => {
    if (minted) field.current?.select();
  }, [minted]);

  const mint = async () => {
    setBusy(true);
    try {
      const link = await workspace.share.mint(id);
      const url = workspace.shareUrl(link.token);
      track("share_link_created");
      setMinted(url);
      setLinks((prev) => [
        { id: link.id, createdBy: link.createdBy, createdAt: link.createdAt, expiresAt: link.expiresAt },
        ...(prev ?? []),
      ]);
      await navigator.clipboard.writeText(url).then(
        () => notify("Share link copied"),
        () => notify("The link is below; the clipboard refused it", "error"),
      );
    } catch (e) {
      notify(e instanceof Error ? e.message : "Could not mint a link", "error");
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (linkId: string) => {
    try {
      await workspace.share.revoke(id, linkId);
      setLinks((prev) => (prev ?? []).filter((l) => l.id !== linkId));
      notify("Link revoked");
    } catch (e) {
      notify(e instanceof Error ? e.message : "Could not revoke that link", "error");
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
          A link anyone can open in a browser — read-only, live, no account. It stops working after
          thirty days, or the moment you revoke it; the other links carry on.
        </p>
        {minted && (
          <input
            ref={field}
            className="name-field share-link"
            data-testid="share-link"
            value={minted}
            readOnly
            spellCheck={false}
            onFocus={(e) => e.currentTarget.select()}
          />
        )}
        <div className="share-links">
          {links === null ? (
            <p className="name-path">Looking…</p>
          ) : links.length === 0 ? (
            <p className="name-path">No links yet.</p>
          ) : (
            links.map((l) => (
              <div className="share-row" key={l.id}>
                <span className="share-who">
                  @{l.createdBy} · {ago(l.createdAt)} · {until(l.expiresAt)}
                </span>
                <button className="rail-btn" onClick={() => void revoke(l.id)}>
                  Revoke
                </button>
              </div>
            ))
          )}
        </div>
        <div className="matter-foot">
          <span>esc close</span>
          <button className="act" onClick={() => void mint()} disabled={busy}>
            New link
          </button>
        </div>
      </div>
    </div>
  );
}
