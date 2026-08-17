/**
 * Reading faces. All five are open-source families from Open Foundry
 * (open-foundry.com), vendored locally by scripts/fetch-fonts.mjs.
 */
export type FontChoice = {
  id: string;
  label: string;
  designer: string;
  /** One word on what it's for — shown under the name in the Aa menu. */
  note: string;
  stack: string;
  /** Optical correction so the five faces feel like one size at one setting. */
  scale: number;
};

export const MONO = `"Space Mono", ui-monospace, SFMono-Regular, monospace`;

/**
 * Monospaced faces for the chrome and for code blocks.
 *
 * Only Space Mono is vendored; the rest are faces macOS already has, so none of
 * these need the network either.
 */
export type MonoChoice = { id: string; label: string; note: string; stack: string };

export const MONO_FONTS: MonoChoice[] = [
  {
    id: "space-mono",
    label: "Space Mono",
    note: "Quirky, wide — the app's own",
    stack: MONO,
  },
  {
    id: "system",
    label: "SF Mono",
    note: "The system monospace",
    stack: `ui-monospace, SFMono-Regular, "SF Mono", monospace`,
  },
  {
    id: "menlo",
    label: "Menlo",
    note: "Even, unfussy, very legible",
    stack: `Menlo, Consolas, monospace`,
  },
  {
    id: "monaco",
    label: "Monaco",
    note: "Narrow, old Mac terminal",
    stack: `Monaco, Menlo, monospace`,
  },
  {
    id: "courier",
    label: "Courier",
    note: "Typewriter, for drafting",
    stack: `"Courier New", Courier, monospace`,
  },
];

export const FONTS: FontChoice[] = [
  {
    id: "vollkorn",
    label: "Vollkorn",
    designer: "Friedrich Althausen",
    note: "Warm serif, long reading",
    stack: `"Vollkorn", Georgia, serif`,
    scale: 1.02,
  },
  {
    id: "libre-baskerville",
    label: "Libre Baskerville",
    designer: "Impallari Type",
    note: "Bookish, wide, deliberate",
    stack: `"Libre Baskerville", Georgia, serif`,
    scale: 0.92,
  },
  {
    id: "work-sans",
    label: "Work Sans",
    designer: "Wei Huang",
    note: "Plain sans, gets out of the way",
    stack: `"Work Sans", system-ui, sans-serif`,
    scale: 1,
  },
  {
    id: "karla",
    label: "Karla",
    designer: "Jonny Pinhorn",
    note: "Grotesque with a bit of grit",
    stack: `"Karla", system-ui, sans-serif`,
    scale: 1,
  },
  {
    id: "space-mono",
    label: "Space Mono",
    designer: "Colophon Foundry",
    note: "Monospaced, for drafting",
    stack: MONO,
    scale: 0.94,
  },
];

export type TypeSettings = {
  fontId: string;
  /** Body size in px before the per-face optical correction. */
  size: number;
  /** Line length in ch. */
  measure: number;
};

export const DEFAULT_TYPE: TypeSettings = {
  fontId: "vollkorn",
  size: 18,
  measure: 66,
};

export const SIZE_RANGE = { min: 15, max: 23, step: 1 };
export const MEASURE_RANGE = { min: 52, max: 88, step: 2 };

export function applyType(t: TypeSettings) {
  const font = FONTS.find((f) => f.id === t.fontId) ?? FONTS[0];
  const root = document.documentElement.style;
  root.setProperty("--doc-font", font.stack);
  root.setProperty("--doc-size", `${(t.size * font.scale).toFixed(2)}px`);
  root.setProperty("--doc-measure", `${t.measure}ch`);
}
