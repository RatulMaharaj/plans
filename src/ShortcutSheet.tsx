/**
 * Every shortcut, from the registry — a view of `DEFAULT_KEYS`, not a
 * hand-written table that goes stale. Click a binding to press a new one;
 * overrides land in settings and merge over the defaults the way settings
 * already merge.
 *
 * The contextual keys — Escape, ⌘B, and friends — are listed but not
 * rebindable: their meaning depends on what is on screen, and they stay
 * hand-written in App.tsx. The sheet says so rather than pretending.
 */
import { useEffect, useState } from "react";
import {
  CONTEXTUAL_KEYS,
  DEFAULT_KEYS,
  mergeKeys,
  renderKeys,
  specFrom,
} from "./keys";

type Props = {
  overrides: Record<string, string>;
  onOverrides: (next: Record<string, string>) => void;
  onClose: () => void;
};

export function ShortcutSheet({ overrides, onOverrides, onClose }: Props) {
  /** The command id waiting for its new keys, if any. */
  const [capturing, setCapturing] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const merged = mergeKeys(overrides);

  useEffect(() => {
    if (!capturing) return;
    const h = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setCapturing(null);
        return;
      }
      if (e.key === "Backspace" || e.key === "Delete") {
        // Unbound, explicitly — "" merges as "no keys".
        onOverrides({ ...overrides, [capturing]: "" });
        setCapturing(null);
        return;
      }
      const spec = specFrom(e);
      if (!spec) return; // a bare modifier: keep waiting
      const taken = merged.find((k) => k.id !== capturing && k.keys === spec);
      if (taken) {
        // A conflict is an error, not a silent last-one-wins: two commands on
        // one chord means one of them silently never runs.
        setNote(`${renderKeys(spec)} already runs “${taken.label}” — unbind that first.`);
        setCapturing(null);
        return;
      }
      const dflt = DEFAULT_KEYS.find((k) => k.id === capturing)?.keys;
      const next = { ...overrides };
      if (spec === dflt) delete next[capturing];
      else next[capturing] = spec;
      onOverrides(next);
      setNote(null);
      setCapturing(null);
    };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, [capturing, overrides, onOverrides, merged]);

  // Esc closes the sheet — unless a capture owns the keyboard right now.
  useEffect(() => {
    if (capturing) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, [capturing, onClose]);

  const groups = [...new Set(merged.map((k) => k.group))];

  return (
    <div className="matter-scrim" onMouseDown={onClose}>
      <div className="matter-sheet shortcut-sheet" onMouseDown={(e) => e.stopPropagation()}>
        <div className="matter-head">
          <span className="tag">Keyboard shortcuts</span>
        </div>
        <div className="shortcut-list">
          {groups.map((g) => (
            <section key={g}>
              <h3 className="shortcut-group">{g}</h3>
              {merged
                .filter((k) => k.group === g)
                .map((k) => (
                  <div className="shortcut-row" key={k.id}>
                    <span className="shortcut-label">{k.label}</span>
                    {overrides[k.id] !== undefined && (
                      <button
                        className="shortcut-reset"
                        title={`Back to ${renderKeys(DEFAULT_KEYS.find((d) => d.id === k.id)?.keys ?? "")}`}
                        onClick={() => {
                          const next = { ...overrides };
                          delete next[k.id];
                          onOverrides(next);
                        }}
                      >
                        reset
                      </button>
                    )}
                    <button
                      className={`shortcut-keys ${capturing === k.id ? "capturing" : ""}`}
                      title="Click, then press the new keys. ⌫ unbinds, esc cancels."
                      onClick={() => {
                        setNote(null);
                        setCapturing(capturing === k.id ? null : k.id);
                      }}
                    >
                      {capturing === k.id ? "press keys…" : renderKeys(k.keys) || "unbound"}
                    </button>
                  </div>
                ))}
            </section>
          ))}
          <section>
            <h3 className="shortcut-group">Contextual — not rebindable</h3>
            {CONTEXTUAL_KEYS.map((k) => (
              <div className="shortcut-row" key={k.keys}>
                <span className="shortcut-label">
                  {k.label}
                  {k.note && <span className="shortcut-note"> — {k.note}</span>}
                </span>
                <span className="shortcut-keys fixed">{renderKeys(k.keys)}</span>
              </div>
            ))}
          </section>
        </div>
        <div className="matter-foot">
          <span>{note ?? "Click a binding, press the new keys · ⌫ unbinds · esc closes"}</span>
          <button className="act" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
