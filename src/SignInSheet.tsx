/**
 * Signing in, GitHub's device way.
 *
 * The app has no URL for GitHub to send anyone back to, so the exchange is a
 * code: this sheet shows it, opens the page where it is typed, and waits.
 * The server does the talking to GitHub — the app never holds a GitHub token,
 * only a session of ours, and that goes to the keychain.
 */
import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { workspace, type Account, type DeviceStart } from "./workspace";

type Props = {
  onDone: (account: Account) => void;
  onCancel: () => void;
};

export function SignInSheet({ onDone, onCancel }: Props) {
  const [start, setStart] = useState<DeviceStart | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // Through a ref: the flow starts once, whatever the parent re-renders with.
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;
    (async () => {
      try {
        const s = await workspace.startSignIn();
        if (cancelled) return;
        setStart(s);
        // Open the page once the code is on screen, so there is something to
        // type when the browser comes up.
        void openUrl(s.verificationUri).catch(() => {
          // A browser that will not open is not fatal: the URL is on the sheet.
        });
        // GitHub names the cadence; polling faster only earns a refusal.
        const wait = Math.max(1, s.interval) * 1000;
        const poll = async () => {
          if (cancelled) return;
          try {
            const who = await workspace.pollSignIn(s.deviceCode);
            if (cancelled) return;
            if (who) {
              onDoneRef.current(who);
              return;
            }
          } catch (e) {
            if (!cancelled) setError(String((e as Error).message ?? e));
            return;
          }
          timer = window.setTimeout(poll, wait);
        };
        timer = window.setTimeout(poll, wait);
      } catch (e) {
        if (!cancelled) setError(String((e as Error).message ?? e));
      }
    })();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  return (
    <div className="matter-scrim" onMouseDown={onCancel}>
      <div className="matter-sheet signin" onMouseDown={(e) => e.stopPropagation()} data-testid="signin">
        <div className="matter-head">
          <span className="tag">Sign in with GitHub</span>
        </div>
        {error ? (
          <p className="signin-error">{error}</p>
        ) : !start ? (
          <p className="ws-hint">Asking GitHub for a code…</p>
        ) : (
          <>
            <p className="ws-hint">
              Type this code at{" "}
              <button className="ws-link" onClick={() => void openUrl(start.verificationUri)}>
                {start.verificationUri.replace(/^https?:\/\//, "")}
              </button>
              . This sheet closes by itself once GitHub has it.
            </p>
            <button
              className="signin-code"
              title="Copy the code"
              onClick={() => {
                void navigator.clipboard?.writeText(start.userCode).then(() => setCopied(true));
              }}
            >
              {start.userCode}
            </button>
            <p className="signin-note">{copied ? "Copied." : "Click to copy."}</p>
          </>
        )}
        <div className="matter-foot">
          <span>esc cancel</span>
          <button className="act" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
