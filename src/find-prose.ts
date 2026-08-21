/**
 * The Write view's find engine: a ProseMirror decoration plugin.
 *
 * Milkdown bundles no find at all, so this walks the document's text nodes
 * for matches and paints them with decorations — decorations rather than
 * anything DOM-level, because the document under a live editor redraws
 * whenever an agent's write arrives through the watcher, and a decoration set
 * is recomputed with the doc rather than left pointing at text that moved.
 *
 * Matching runs over the *rendered* text, so searching "plan" finds it inside
 * bold or a heading without anyone thinking about asterisks. Content the view
 * renders specially — HTML cards, frontmatter — keeps its source in an
 * attribute, not a text node: those are matched too (the count stays honest),
 * but the highlight is the enclosing block, and "scroll to it" means the
 * block. Mermaid needs no special case: the fence keeps its source as real
 * text, with the diagram beneath it.
 */
import { Plugin, PluginKey, TextSelection } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import type { EditorView } from "@milkdown/kit/prose/view";
import type { Node } from "@milkdown/kit/prose/model";
import { FIND_CAP, findCaseSensitive } from "./find";

type Match = { from: number; to: number; block: boolean };

type FindState = {
  query: string;
  matches: Match[];
  /** Index into `matches`, or -1 when there is nothing current. */
  current: number;
  /**
   * A seek that arrived before the document did — a palette hit opening a
   * file whose swap has not settled — held until matches exist to take it.
   */
  seek: number | null;
  deco: DecorationSet;
};

type Meta =
  | { set: string; seek?: number }
  | { nav: 1 | -1 }
  | { clear: true };

export const findPluginKey = new PluginKey<FindState>("plans-find");

const EMPTY: FindState = { query: "", matches: [], current: -1, seek: null, deco: DecorationSet.empty };

function collect(doc: Node, query: string): Match[] {
  if (!query) return [];
  const cs = findCaseSensitive(query);
  const needle = cs ? query : query.toLowerCase();
  const out: Match[] = [];
  const scan = (text: string, push: (at: number) => void) => {
    const hay = cs ? text : text.toLowerCase();
    let i = 0;
    while (out.length < FIND_CAP) {
      const at = hay.indexOf(needle, i);
      if (at < 0) break;
      push(at);
      i = at + Math.max(1, needle.length);
    }
  };
  doc.descendants((node, pos) => {
    if (out.length >= FIND_CAP) return false;
    if (node.isText) {
      scan(node.text ?? "", (at) =>
        out.push({ from: pos + at, to: pos + at + query.length, block: false }),
      );
      return false;
    }
    // Specially rendered content: the source lives in an attribute, so a hit
    // is real but has no text position. The whole node is the match.
    if ((node.type.name === "html" || node.type.name === "yaml") && typeof node.attrs.value === "string") {
      scan(String(node.attrs.value), () => out.push({ from: pos, to: pos + node.nodeSize, block: true }));
      return false;
    }
    return true;
  });
  return out;
}

function decorate(doc: Node, matches: Match[], current: number): DecorationSet {
  if (!matches.length) return DecorationSet.empty;
  const decos: Decoration[] = [];
  let lastBlock = -1;
  matches.forEach((m, i) => {
    if (m.block) {
      // Several hits in one card are one highlight — the count says several,
      // the paint cannot honestly show where inside the render they are.
      if (m.from === lastBlock && i !== current) return;
      lastBlock = m.from;
      decos.push(
        Decoration.node(m.from, m.to, {
          class: i === current ? "find-block current" : "find-block",
        }),
      );
    } else {
      decos.push(
        Decoration.inline(m.from, m.to, {
          class: i === current ? "find-match current" : "find-match",
        }),
      );
    }
  });
  return DecorationSet.create(doc, decos);
}

function built(doc: Node, query: string, matches: Match[], current: number, seek: number | null): FindState {
  return { query, matches, current, seek, deco: decorate(doc, matches, current) };
}

export function findProsePlugin(report: (current: number, total: number) => void) {
  return new Plugin<FindState>({
    key: findPluginKey,
    state: {
      init: () => EMPTY,
      apply(tr, prev) {
        const meta = tr.getMeta(findPluginKey) as Meta | undefined;
        if (meta && "clear" in meta) return EMPTY;
        if (meta && "set" in meta) {
          const matches = collect(tr.doc, meta.set);
          let current = -1;
          let seek: number | null = meta.seek ?? null;
          if (matches.length) {
            if (seek != null) {
              current = Math.min(seek, matches.length - 1);
              seek = null;
            } else if (prev.query === meta.set && prev.current >= 0) {
              current = Math.min(prev.current, matches.length - 1);
            } else {
              const at = tr.selection.from;
              current = matches.findIndex((m) => m.from >= at);
              if (current < 0) current = 0;
            }
          }
          return built(tr.doc, meta.set, matches, current, seek);
        }
        if (meta && "nav" in meta) {
          if (!prev.matches.length) return prev;
          const current = (prev.current + meta.nav + prev.matches.length) % prev.matches.length;
          return built(tr.doc, prev.query, prev.matches, current, null);
        }
        if (tr.docChanged) {
          if (!prev.query) return prev;
          // The document moved under a live query — an agent's write through
          // the watcher, or typing. Recompute, and keep the current match
          // pointed near where it was.
          const matches = collect(tr.doc, prev.query);
          let current = -1;
          let seek = prev.seek;
          if (matches.length) {
            if (seek != null) {
              current = Math.min(seek, matches.length - 1);
              seek = null;
            } else if (prev.current >= 0) {
              const was = tr.mapping.map(prev.matches[prev.current]?.from ?? 0);
              current = matches.findIndex((m) => m.from >= was);
              if (current < 0) current = matches.length - 1;
            } else {
              current = 0;
            }
          }
          return built(tr.doc, prev.query, matches, current, seek);
        }
        return prev;
      },
    },
    props: {
      decorations(state) {
        return findPluginKey.getState(state)?.deco ?? DecorationSet.empty;
      },
    },
    view: () => ({
      update(view, prevState) {
        const s = findPluginKey.getState(view.state);
        const p = findPluginKey.getState(prevState);
        if (!s || s === p) return;
        if (s.query || p?.query) report(s.current + 1, s.matches.length);
      },
    }),
  });
}

/** Bring the current match into view: select text, or scroll to the block. */
export function scrollToCurrent(view: EditorView) {
  const s = findPluginKey.getState(view.state);
  if (!s || s.current < 0) return;
  const m = s.matches[s.current];
  if (m.block) {
    const dom = view.nodeDOM(m.from) as HTMLElement | null;
    dom?.scrollIntoView({ block: "center" });
  } else {
    // A real selection, so the match behaves like one — but this is reading,
    // not editing: nothing here marks the document touched.
    view.dispatch(
      view.state.tr
        .setSelection(TextSelection.create(view.state.doc, m.from, m.to))
        .scrollIntoView(),
    );
  }
}
