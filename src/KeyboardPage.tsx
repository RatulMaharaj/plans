/**
 * Settings → Keyboard: where bindings are managed at length.
 *
 * The sheet (⌘/) stays the quick reference; this page is the workbench —
 * every registry command grouped as the sheet groups them, capture-to-rebind
 * (chords included), unbind, reset-to-default, a "Reset all", and the preset
 * packs. The contextual and editor-local keys are listed read-only, so the
 * page is complete about what it does not own.
 */
import { useState } from "react";
import { useKeyCapture } from "./capture";
import {
  bindingConflict,
  CONTEXTUAL_KEYS,
  EDITOR_KEYS,
  mergeKeys,
  PRESETS,
  renderKeys,
  type KeyPreset,
} from "./keys";
import type { Settings } from "./settings";

type Props = {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  onBack: () => void;
};

export function KeyboardPage({ settings: s, onChange, onBack }: Props) {
  /** The command id waiting for its new keys, if any. */
  const [capturing, setCapturing] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const overrides = s.keyOverrides;
  const merged = mergeKeys(overrides, s.keyPreset);
  /** What a command falls back to without an override: defaults plus pack. */
  const base = mergeKeys({}, s.keyPreset);
  const onOverrides = (next: Record<string, string>) => onChange({ keyOverrides: next });

  const armed = useKeyCapture(capturing !== null, {
    onCancel: () => setCapturing(null),
    onUnbind: () => {
      if (capturing) onOverrides({ ...overrides, [capturing]: "" });
      setCapturing(null);
    },
    onSpec: (spec) => {
      if (!capturing) return;
      // The same refusals, in the same words, as the sheet.
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

  const groups = [...new Set(merged.map((k) => k.group))];
  const overridden = Object.keys(overrides).length;

  return (
    <div className="settings keyboard-page">
      <div className="settings-inner">
        <header className="settings-head">
          <h1 className="settings-title">Keyboard</h1>
          <button className="rail-btn" onClick={onBack}>
            Back to settings
          </button>
          <button
            className="rail-btn"
            disabled={!overridden}
            title="Forget every rebind — the preset pack, if one is chosen, stays."
            onClick={() => {
              onOverrides({});
              setNote(null);
              setCapturing(null);
            }}
          >
            Reset all
          </button>
        </header>

        <p className="keyboard-note" role="status">
          {note ??
            "Click a binding, then press the new keys — two combos within a beat make a chord like ⌘K W. ⌫ unbinds, esc cancels."}
        </p>

        {/* ---- preset packs -------------------------------------------- */}
        <section className="settings-group">
          <div className="settings-aside">
            <span className="tag">Preset</span>
            <p className="settings-hint">
              A pack merges between the defaults and your own rebinds, so
              personal bindings survive switching packs.
            </p>
          </div>
          <div className="settings-body">
            <div className="setting-row static">
              <span className="setting-label">
                Keybinding pack
                <span className="setting-hint">
                  {s.keyPreset === "default"
                    ? "The app's own bindings, untouched."
                    : PRESETS[s.keyPreset].note}
                </span>
              </span>
              <span className="segmented">
                {(["default", "vscode", "vim"] as KeyPreset[]).map((p) => (
                  <button
                    key={p}
                    className={p === s.keyPreset ? "on" : ""}
                    aria-pressed={p === s.keyPreset}
                    onClick={() => onChange({ keyPreset: p })}
                  >
                    {p === "default" ? "Default" : PRESETS[p].label}
                  </button>
                ))}
              </span>
            </div>
          </div>
        </section>

        {/* ---- the registry -------------------------------------------- */}
        {groups.map((g) => (
          <section className="settings-group" key={g}>
            <div className="settings-aside">
              <span className="tag">{g}</span>
            </div>
            <div className="settings-body">
              {merged
                .filter((k) => k.group === g)
                .map((k) => {
                  const dflt = base.find((d) => d.id === k.id)?.keys ?? "";
                  const edited = overrides[k.id] !== undefined;
                  return (
                    <div className={`shortcut-row keyboard-row ${edited ? "edited" : ""}`} key={k.id}>
                      <span className="shortcut-label">
                        {k.label}
                        {edited && <span className="key-edited"> · rebound</span>}
                      </span>
                      {edited && (
                        <button
                          className="shortcut-reset"
                          title={`Back to ${renderKeys(dflt) || "unbound"}`}
                          onClick={() => {
                            const next = { ...overrides };
                            delete next[k.id];
                            onOverrides(next);
                          }}
                        >
                          reset
                        </button>
                      )}
                      {!!k.keys && (
                        <button
                          className="shortcut-reset"
                          title="Leave this command with no keys."
                          onClick={() => {
                            const next = { ...overrides };
                            if (dflt === "") delete next[k.id];
                            else next[k.id] = "";
                            onOverrides(next);
                          }}
                        >
                          unbind
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
                  );
                })}
            </div>
          </section>
        ))}

        {/* ---- what this page does not own ------------------------------ */}
        <section className="settings-group">
          <div className="settings-aside">
            <span className="tag">Contextual</span>
            <p className="settings-hint">
              Not rebindable: their meaning depends on what is on screen, and
              they stay hand-written in the app.
            </p>
          </div>
          <div className="settings-body">
            {CONTEXTUAL_KEYS.map((k) => (
              <div className="shortcut-row keyboard-row" key={k.keys}>
                <span className="shortcut-label">
                  {k.label}
                  {k.note && <span className="shortcut-note"> — {k.note}</span>}
                </span>
                <span className="shortcut-keys fixed">{renderKeys(k.keys)}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="settings-group">
          <div className="settings-aside">
            <span className="tag">In the editor</span>
            <p className="settings-hint">
              Not rebindable: these belong to Milkdown and CodeMirror, inside
              the writing surfaces.
            </p>
          </div>
          <div className="settings-body">
            {EDITOR_KEYS.map((k) => (
              <div className="shortcut-row keyboard-row" key={k.keys}>
                <span className="shortcut-label">
                  {k.label}
                  {k.note && <span className="shortcut-note"> — {k.note}</span>}
                </span>
                <span className="shortcut-keys fixed">{renderKeys(k.keys)}</span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
