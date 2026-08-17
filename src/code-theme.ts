/**
 * The code block theme.
 *
 * CodeMirror generates its stock highlight colours into hashed class names at
 * runtime, so they can't be restyled from CSS. This replaces them outright,
 * drawing every hue from the current paper's own --code-* set.
 *
 * A code block is the one place the app's "colour only ever means differs from
 * HEAD" rule is set aside: here colour is doing real work, telling a string
 * from a keyword. Each paper carries the same five inks, tuned to it.
 */
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

/**
 * Every colour is a var(), so a block repaints when the paper changes — each
 * theme in App.css carries its own set of the same five inks.
 */
const keyword = "var(--code-keyword)";
const fn = "var(--code-fn)";
const type = "var(--code-type)";
const string = "var(--code-string)";
const number = "var(--code-number)";
const name = "var(--code-name)";
const punct = "var(--code-punct)";
const comment = "var(--code-comment)";

const highlight = HighlightStyle.define([
  // Structure: what the language itself provides.
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword], color: keyword },
  { tag: [t.definitionKeyword, t.modifier, t.operatorKeyword], color: keyword },
  { tag: [t.self, t.null, t.atom, t.bool], color: keyword },

  // What the author names.
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: fn },
  { tag: [t.definition(t.function(t.variableName))], color: fn, fontWeight: "700" },
  { tag: [t.typeName, t.className, t.namespace, t.macroName], color: type },
  { tag: [t.definition(t.variableName), t.definition(t.propertyName)], color: name },
  { tag: [t.variableName, t.propertyName], color: name },
  { tag: [t.attributeName], color: type },
  { tag: [t.tagName], color: keyword },

  // Values.
  { tag: [t.string, t.special(t.string)], color: string },
  { tag: [t.regexp, t.escape], color: number },
  { tag: [t.number, t.integer, t.float], color: number },

  // Everything holding it together stays quiet.
  { tag: [t.operator, t.punctuation, t.bracket, t.separator, t.derefOperator], color: punct },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: comment, fontStyle: "italic" },
  { tag: [t.meta, t.processingInstruction], color: comment },
  { tag: [t.invalid], color: "var(--git-mod)" },

  // Markdown and prose-ish grammars.
  { tag: [t.heading], color: keyword, fontWeight: "700" },
  { tag: [t.link, t.url], color: fn, textDecoration: "underline" },
  { tag: [t.emphasis], fontStyle: "italic" },
  { tag: [t.strong], fontWeight: "700" },
  { tag: [t.strikethrough], textDecoration: "line-through" },
]);

/** Code sits a little smaller than the prose it interrupts. */
const chrome = EditorView.theme({
  "&": {
    background: "var(--paper)",
    color: "var(--code-name)",
    fontFamily: "var(--mono)",
    fontSize: "calc(var(--doc-size) * 0.72)",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-content": {
    fontFamily: "var(--mono)",
    caretColor: "var(--ink)",
    padding: "6px 0",
  },
  ".cm-line": { padding: "0 10px" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--ink)" },
  ".cm-gutters": {
    background: "var(--paper)",
    color: "var(--ink-3)",
    border: "none",
    fontFamily: "var(--mono)",
  },
  ".cm-activeLine": { background: "transparent" },
  ".cm-activeLineGutter": { background: "transparent", color: "var(--ink-2)" },
  // CodeMirror paints the selection into its own layer, and anything it
  // leaves to the browser picks up the macOS accent colour — which is why an
  // unstyled selection can come out green, blue or pink depending on the Mac.
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": {
    background: "var(--shade)",
  },
  ".cm-selectionLayer .cm-selectionBackground": { background: "var(--shade)" },
  ".cm-selectionBackground": { background: "var(--shade)" },
  "& ::selection": { background: "var(--shade)", color: "var(--ink)" },
  ".cm-selectionMatch": { background: "var(--shade)" },
  ".cm-scroller": { lineHeight: "1.7", overflow: "auto" },
});

export const codeTheme: Extension = [chrome, syntaxHighlighting(highlight)];
