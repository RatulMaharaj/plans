/**
 * The rebind capture, shared by the shortcut sheet and the Keyboard page.
 *
 * While active it owns the keyboard: Escape cancels, ⌫ unbinds, anything else
 * becomes a KeySpec. After a first combo it keeps listening for `CHORD_MS` —
 * exactly the beat the matcher gives a chord — so a second combo commits a
 * two-step spec, and silence commits the plain one. The armed first combo is
 * returned so the button can show it while the beat runs.
 */
import { useEffect, useRef, useState } from "react";
import { CHORD_MS, specFrom, type KeySpec } from "./keys";

export function useKeyCapture(
  active: boolean,
  handlers: {
    onSpec: (spec: KeySpec) => void;
    onUnbind: () => void;
    onCancel: () => void;
  },
): KeySpec | null {
  const [armed, setArmed] = useState<KeySpec | null>(null);
  // The latest handlers, without retying the listener on every render.
  const now = useRef(handlers);
  now.current = handlers;

  useEffect(() => {
    if (!active) {
      setArmed(null);
      return;
    }
    let first: KeySpec | null = null;
    let timer: number | null = null;
    const h = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        now.current.onCancel();
        return;
      }
      if (e.key === "Backspace" || e.key === "Delete") {
        now.current.onUnbind();
        return;
      }
      const spec = specFrom(e);
      if (!spec) return; // a bare modifier: keep waiting
      if (first) {
        if (timer) clearTimeout(timer);
        now.current.onSpec(`${first} ${spec}`);
        return;
      }
      first = spec;
      setArmed(spec);
      timer = window.setTimeout(() => now.current.onSpec(first!), CHORD_MS);
    };
    window.addEventListener("keydown", h, true);
    return () => {
      window.removeEventListener("keydown", h, true);
      if (timer) clearTimeout(timer);
      setArmed(null);
    };
  }, [active]);

  return armed;
}
