/**
 * The frontmatter editor.
 *
 * The block is kept out of the page entirely — it's metadata, not prose — and
 * opened on demand from the header button that appears when a file has one.
 * Edited as plain text so the YAML survives exactly as written.
 */
import { useEffect, useRef } from "react";

type Props = {
  /** Null when the file has no frontmatter; the sheet is then not shown. */
  matter: string | null;
  onChange: (matter: string | null) => void;
  onClose: () => void;
};

export function FrontmatterSheet({ matter, onChange, onClose }: Props) {
  const box = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    box.current?.focus();
  }, []);

  if (matter === null) return null;

  return (
    <div className="matter-scrim" onMouseDown={onClose}>
      <div className="matter-sheet" onMouseDown={(e) => e.stopPropagation()}>
        <div className="matter-head">
          <span className="tag">Frontmatter</span>
          <button
            className="act quiet"
            onClick={() => {
              if (window.confirm("Remove the frontmatter block?")) {
                onChange(null);
                onClose();
              }
            }}
          >
            Remove
          </button>
        </div>
        <textarea
          ref={box}
          className="matter-body"
          value={matter}
          spellCheck={false}
          placeholder={"title: \ndate: "}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              onClose();
            }
          }}
        />
        <div className="matter-foot">
          <span>YAML, written back verbatim</span>
          <span>esc to close</span>
        </div>
      </div>
    </div>
  );
}
