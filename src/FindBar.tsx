/**
 * The find bar: an input, a count, next and previous — and nothing else.
 *
 * Every control on a find bar is a question the reader has to decline before
 * typing, so there is no regex toggle, no whole-word switch, no replace.
 * Case is smart: insensitive until the query contains a capital. One
 * instance, floating over the top edge of the surface it is searching, in
 * the app's own chrome rather than any editor's stock panel.
 */
import { useEffect, useRef } from "react";
import { FIND_CAP } from "./find";

type Props = {
  query: string;
  onQuery: (q: string) => void;
  /** From the active engine; null until the first report arrives. */
  count: { current: number; total: number } | null;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
  /**
   * Bumped when the bar should take the keyboard. Zero when it must not:
   * ⌘F pressed mid-message in the chat composer opens find over the
   * document, but the bar does not steal the composer's focus until the
   * reader types or clicks in it.
   */
  focusSeq: number;
};

export function FindBar({ query, onQuery, count, onNext, onPrev, onClose, focusSeq }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (focusSeq > 0) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [focusSeq]);

  const label = !query
    ? ""
    : !count || count.total === 0
      ? "No matches"
      : count.total >= FIND_CAP
        ? `${Math.max(count.current, 1)} of ${FIND_CAP}+`
        : `${Math.max(count.current, 1)} of ${count.total}`;

  return (
    // Zero-height anchor in the pane's flow, so the bar floats over the top
    // edge of whatever surface renders beneath it — zen or not, conflict or
    // not — without measuring any header.
    <div className="find-anchor">
      <div className="find-bar" role="search" aria-label="Find in this file">
        <input
          ref={inputRef}
          className="find-input"
          type="text"
          placeholder="Find"
          spellCheck={false}
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              e.stopPropagation();
              if (e.shiftKey) onPrev();
              else onNext();
              return;
            }
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              onClose();
              return;
            }
            // The bar's keys, not the app's — but chords stay the app's,
            // the same contract the chat composer keeps.
            if (!e.metaKey && !e.ctrlKey) e.stopPropagation();
          }}
        />
        <span className="find-count" aria-live="polite">
          {label}
        </span>
        <button className="find-btn" aria-label="Previous match" title="Previous match (⇧↩)" onClick={onPrev}>
          ↑
        </button>
        <button className="find-btn" aria-label="Next match" title="Next match (↩)" onClick={onNext}>
          ↓
        </button>
        <button className="find-btn" aria-label="Close find" title="Close (esc)" onClick={onClose}>
          ×
        </button>
      </div>
    </div>
  );
}
