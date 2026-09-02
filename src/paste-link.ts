/**
 * Paste a URL over a selection and it becomes a link.
 *
 * The default is to replace what you selected with the URL's text, which is
 * almost never what was meant: if a phrase is selected and a link is on the
 * clipboard, the phrase is the label. This is what every editor people already
 * use does, and its absence reads as a missing feature rather than a choice.
 *
 * Nothing else changes — no selection, or a clipboard that isn't a link, falls
 * through to the normal paste.
 */
import { track } from "./analytics";
import { $prose } from "@milkdown/utils";
import { linkSchema } from "@milkdown/preset-commonmark";
import { Plugin, PluginKey } from "@milkdown/kit/prose/state";

/**
 * A URL, or something close enough that a person meant one.
 *
 * Deliberately narrow: bare words with dots ("e.g. this") are not links, and
 * turning them into one silently would be worse than doing nothing.
 */
export function looksLikeLink(text: string): boolean {
  const t = text.trim();
  if (!t || /\s/.test(t)) return false;
  if (/^(https?|mailto|tel|ftp):/i.test(t)) return true;
  // A bare domain with a plausible suffix: example.com, docs.looped.sh/path.
  return /^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(t) && !/\.(md|markdown|txt|png|jpe?g|gif|svg)$/i.test(t);
}

/** What goes in the href: a bare domain needs a scheme to be a link at all. */
export function hrefFor(text: string): string {
  const t = text.trim();
  if (/^[\w+.-]+:/i.test(t)) return t;
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(t) ? `mailto:${t}` : `https://${t}`;
}

export const pasteLink = $prose((ctx) => {
  return new Plugin({
    key: new PluginKey("plans-paste-link"),
    /**
     * Caught on the way down, not through handlePaste.
     *
     * Crepe registers its own paste handling before anything added here, and
     * the first plugin to claim the event wins — so by the time a handlePaste
     * prop would run, the selection has already been replaced by the URL. A
     * capture-phase listener on the editor's own element sees it first.
     */
    view: (view) => {
      const onPaste = (event: ClipboardEvent) => {
        const text = event.clipboardData?.getData("text/plain") ?? "";
        if (!looksLikeLink(text)) return;

        const { state, dispatch } = view;
        const { from, to, empty } = state.selection;
        if (empty) return;
        if (!state.doc.textBetween(from, to, " ").trim()) return;

        event.preventDefault();
        event.stopPropagation();

        const link = linkSchema.type(ctx);
        dispatch(state.tr.addMark(from, to, link.create({ href: hrefFor(text) })).scrollIntoView());
        track("link_pasted");
      };

      view.dom.addEventListener("paste", onPaste, true);
      return {
        destroy: () => view.dom.removeEventListener("paste", onPaste, true),
      };
    },
  });
});
