/**
 * Every shortcut, from the registry — a view of `DEFAULT_KEYS`, not a
 * hand-written table that goes stale. Click a binding to press a new one —
 * chords included: a second combo within the beat makes a two-step spec.
 * Overrides land in settings and merge over the defaults (and the chosen
 * preset pack) the way settings already merge.
 *
 * The contextual keys — Escape, ⌘B, and friends — are listed but not
 * rebindable: their meaning depends on what is on screen, and they stay
 * hand-written in App.tsx. The sheet says so rather than pretending. The
 * editor's own keys — bold, italic — are listed on the same terms: they
 * belong to Milkdown and CodeMirror.
 *
 * The sheet is the quick reference (⌘/); Settings → Keyboard is where
 * bindings are managed at length.
 */
import { useEffect, useState } from "react";
import { useKeyCapture } from "./capture";
import {
  bindingConflict,
  CONTEXTUAL_KEYS,
  EDITOR_KEYS,
  mergeKeys,
  renderKeys,
  type KeyPreset,
} from "./keys";

type Props = {
  overrides: Record<string, string>;
  preset: KeyPreset;
  onOverrides: (next: Record<string, string>) => void;
  onClose: () => void;
};

export function ShortcutSheet({ overrides, preset, onOverrides, onClose }: Props) {
  /** The command id waiting for its new keys, if any. */
  const [capturing, setCapturing] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const merged = mergeKeys(overrides, preset);
  /** What the command falls back to without an override: defaults plus pack. */
  const base = mergeKeys({}, preset);

  const armed = useKeyCapture(capturing !== null, {
    onCancel: () => setCapturing(null),
    onUnbind: () => {
      // Unbound, explicitly — "" merges as "no keys".
      if (capturing) onOverrides({ ...overrides, [capturing]: "" });
      setCapturing(null);
    },
    onSpec: (spec) => {
      if (!capturing) return;
      // A conflict is an error, not a silent last-one-wins: two commands on
      // one chord means one of them silently never runs.
      const clash = bindingConflict(spec, capturing, merged);
      if (clash) {
        setNote(clash);
        setCapturing(null);
        return;
      }
      const dflt = base.find((k) => k.id === capturing)?.keys;
      const next = { ...overrides };
      if (spec === dflt) delete next[capturing];
      else next[capturing] = spec;
      onOverrides(next);
      setNote(null);
      setCapturing(null);
    },
  });

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
                        title={`Back to ${renderKeys(base.find((d) => d.id === k.id)?.keys ?? "") || "unbound"}`}
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
                      title="Click, then press the new keys — two combos make a chord. ⌫ unbinds, esc cancels."
                      onClick={() => {
                        setNote(null);
                        setCapturing(capturing === k.id ? null : k.id);
                      }}
                    >
                      {capturing === k.id
                        ? armed
                          ? `${renderKeys(armed)} …`
                          : "press keys…"
                        : renderKeys(k.keys) || "unbound"}
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
          <section>
            <h3 className="shortcut-group">In the editor — not rebindable</h3>
            {EDITOR_KEYS.map((k) => (
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
