/**
 * A new version exists.
 *
 * A banner, not a modal. Nothing about an update is urgent enough to take the
 * document away from someone mid-sentence, and nothing downloads or installs
 * without a press.
 */
import type { Available } from "./update";

type Props = {
  found: Available;
  /** null while nothing is downloading; 0..1, or null-in-progress for unknown. */
  progress: number | null;
  installing: boolean;
  onInstall: () => void;
  onDismiss: () => void;
};

export function UpdateBanner({ found, progress, installing, onInstall, onDismiss }: Props) {
  const pct = progress === null ? null : Math.round(progress * 100);

  return (
    <div className="update-banner" role="status">
      <div className="update-text">
        <b>Plans {found.version}</b>
        {found.notes && <span className="update-notes">{firstLine(found.notes)}</span>}
      </div>

      {installing ? (
        <div className="update-progress" aria-label="Downloading">
          <div
            className={`update-bar${pct === null ? " unknown" : ""}`}
            style={pct === null ? undefined : { width: `${pct}%` }}
          />
          <span className="update-pct">{pct === null ? "downloading" : `${pct}%`}</span>
        </div>
      ) : (
        <div className="update-acts">
          <button className="act" onClick={onInstall}>
            Install and restart
          </button>
          <button className="act quiet" onClick={onDismiss}>
            Later
          </button>
        </div>
      )}
    </div>
  );
}

/** The banner has one line to spend; the sheet shows the rest after restart. */
function firstLine(notes: string) {
  const line = notes
    .split("\n")
    .map((l) => l.replace(/^\s*[-*]\s+/, "").trim())
    .find((l) => l && !l.startsWith("#"));
  return line ?? "";
}
