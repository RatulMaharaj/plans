import { useCallback, useEffect, useRef, useState } from "react";
import { Crepe, CrepeFeature } from "@milkdown/crepe";
import { remarkPluginsCtx, remarkStringifyOptionsCtx } from "@milkdown/core";
import remarkFrontmatter from "remark-frontmatter";
import { $prose, replaceAll } from "@milkdown/utils";
import { Plugin, PluginKey, TextSelection } from "@milkdown/kit/prose/state";
import { languages } from "@codemirror/language-data";
import { LanguageDescription } from "@codemirror/language";
import { yaml } from "@codemirror/lang-yaml";
import { codeTheme } from "./code-theme";
import { htmlBridge, htmlContext, htmlView, isComment, pictureView } from "./html-view";
import { editorViewCtx } from "@milkdown/core";
import { mermaidView } from "./mermaid-view";
import { pasteLink } from "./paste-link";
import { imageContext, pasteImage } from "./paste-image";
import { yamlSchema } from "./yaml-node";
import { findPluginKey, findProsePlugin, scrollToCurrent } from "./find-prose";
import type { FindHandle } from "./find";
import { trace } from "./perf";
import { collab, collabServiceCtx } from "@milkdown/plugin-collab";
import type { Room } from "./workspace";
import "./editor-theme.css";

type Props = {
  /** Which file this is, so HTML can resolve its relative image paths. */
  repo: string;
  relPath: string;
  /** Changing this key tears down and rebuilds the editor with fresh content. */
  docKey: string;
  initialValue: string;
  spellcheck: boolean;
  /** Where pasted images are written, relative to the repository root. */
  imageFolder: string;
  /** `@name` written into new comments and replies; "" when git has no name. */
  author: string;
  onChange: (markdown: string) => void;
  /** ⌘-click on a link lands here; the caller decides file versus browser. */
  onOpenLink?: (href: string) => void;
  /** ⌘F's engine for this surface, registered while the editor is mounted. */
  findRef?: React.MutableRefObject<FindHandle | null>;
  onFindCount?: (current: number, total: number) => void;
  /**
   * What is selected in this surface, for whoever asks — the rewrite prompt.
   *
   * Per-surface like `findRef`, and for the same reason: the split pane mounts
   * a second editor, and a module-level singleton would answer for whichever
   * of the two mounted last. The reader right-clicked in one document, and the
   * quote has to come from that one.
   */
  selectionRef?: React.MutableRefObject<(() => string) | null>;
  /** The whole document as markdown, on demand — the copy-to-repository path. */
  markdownRef?: React.MutableRefObject<(() => string) | null>;
  /**
   * A document whose truth is on the wire.
   *
   * With a room, the editor binds Milkdown's collab plugin to the room's Yjs
   * doc and awareness: edits go out as they happen, others' cursors are drawn
   * in, and `initialValue` becomes a template applied only if the shared
   * document is empty. `onChange` still fires — it is how the serialised
   * markdown reaches the room's `meta` map, which is what the server's read
   * endpoint answers with. The caller keys this component by room, so a
   * different workspace is a different editor rather than a swap.
   */
  room?: Room;
};

/**
 * Milkdown Crepe gives us a WYSIWYG surface whose source of truth is markdown,
 * so what lands on disk stays diff-friendly for git.
 */
/**
 * `<br>` becomes a real line break.
 *
 * Milkdown drops inline `<br/>`: it survives neither as an html node nor as a
 * break, so `Title<br/><sub>…` renders as one run-on line. Rewriting it to
 * mdast's own break before Milkdown parses gives it something it understands,
 * and the serialiser writes it back as HTML so the file keeps its author's form.
 */
const BR = /^<br\s*\/?>$/i;

/**
 * Only where a break can legally go.
 *
 * A `<br>` inside a paragraph or a heading is a line break. A `<br>` standing
 * on its own between blocks is not: mdast puts it at the root, and a break
 * there builds a document the schema refuses — "Cannot create node for doc" —
 * which fails the whole file rather than the block. The symptom was clicking a
 * file and still seeing the previous one, because the swap threw and left the
 * old document in place.
 *
 * A block-level `<br>` keeps its html node, which the html view renders.
 */
const INLINE_PARENTS = new Set([
  "paragraph",
  "heading",
  "emphasis",
  "strong",
  "delete",
  "link",
  "linkReference",
  "tableCell",
  "footnoteDefinition",
]);

function breaksFromHtml() {
  return () => (tree: { children?: unknown[] }) => {
    const walk = (node: any) => {
      const kids = node?.children;
      if (!Array.isArray(kids)) return;
      const inline = INLINE_PARENTS.has(String(node?.type));
      for (let i = 0; i < kids.length; i++) {
        const child = kids[i];
        if (inline && child?.type === "html" && BR.test(String(child.value).trim())) {
          kids[i] = { type: "break" };
        } else {
          walk(child);
        }
      }
    };
    walk(tree);
  };
}

export function Editor({
  docKey,
  repo,
  relPath,
  initialValue,
  spellcheck,
  imageFolder,
  author,
  onChange,
  onOpenLink,
  findRef,
  onFindCount,
  selectionRef,
  markdownRef,
  room,
}: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const instance = useRef<Crepe | null>(null);
  /** Only true between create() resolving and destroy(); actions need it. */
  const created = useRef(false);
  /** A document that arrived before the editor was ready to take it. */
  const queued = useRef<string | null>(null);
  /** True while a document is being swapped in, so it is not read as an edit. */
  const swapping = useRef(false);
  /** The text last handed to App, so an unchanged document is not reported. */
  const lastSentRef = useRef("");

  /**
   * Bumped to rebuild the editor from scratch.
   *
   * The editor is constructed once and swapped thereafter, which is what makes
   * switching files quick — but it means a swap that silently fails leaves a
   * blank page and no way back. If a document goes in and nothing comes out,
   * this starts again rather than leaving someone staring at an empty buffer.
   */
  const [rebuild, setRebuild] = useState(0);
  /** The text a rebuild was already attempted for, so it happens once. */
  const rebuiltFor = useRef<string | null>(null);

  /** Set by the live editor, so a swap can declare the new document untouched. */
  const untouch = useRef<(() => void) | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onFindCountRef = useRef(onFindCount);
  onFindCountRef.current = onFindCount;

  /**
   * ⌘F's engine: metas into the find plugin, through the editor that exists.
   * Registered once — the functions reach the live instance through refs, so
   * they survive the editor being rebuilt underneath them.
   */
  useEffect(() => {
    if (!findRef) return;
    const act = (fn: (view: import("@milkdown/kit/prose/view").EditorView) => void) => {
      const crepe = instance.current;
      if (!crepe || !created.current) return;
      try {
        crepe.editor.action((ctx) => fn(ctx.get(editorViewCtx)));
      } catch (e) {
        trace("find action failed", { error: String(e) });
      }
    };
    const handle: FindHandle = {
      set: (q, seek) =>
        act((view) => {
          const before = findPluginKey.getState(view.state);
          view.dispatch(view.state.tr.setMeta(findPluginKey, { set: q, seek }));
          // Scroll when the current match is new — a fresh query or a seek —
          // not on a recount of the query already on screen.
          if (q && (seek !== undefined || before?.query !== q)) scrollToCurrent(view);
        }),
      next: () =>
        act((view) => {
          view.dispatch(view.state.tr.setMeta(findPluginKey, { nav: 1 }));
          scrollToCurrent(view);
        }),
      prev: () =>
        act((view) => {
          view.dispatch(view.state.tr.setMeta(findPluginKey, { nav: -1 }));
          scrollToCurrent(view);
        }),
      clear: () => act((view) => view.dispatch(view.state.tr.setMeta(findPluginKey, { clear: true }))),
    };
    findRef.current = handle;
    return () => {
      if (findRef.current === handle) findRef.current = null;
    };
  }, [findRef]);

  /**
   * The selected text, asked for at the moment of a right-click.
   *
   * The document's own text, not `window.getSelection()`: through decorations,
   * widgets and mermaid figures the DOM answers with furniture the markdown
   * does not contain, and the point of the quote is that the agent can find it
   * in the file. `textBetween` with "\n" between blocks is the closest thing
   * ProseMirror has to what the serialiser would write.
   */
  useEffect(() => {
    if (!selectionRef) return;
    const read = () => {
      const crepe = instance.current;
      if (!crepe || !created.current) return "";
      try {
        let text = "";
        crepe.editor.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          const { from, to } = view.state.selection;
          if (from !== to) text = view.state.doc.textBetween(from, to, "\n");
        });
        return text;
      } catch (e) {
        trace("selection read failed", { error: String(e) });
        return "";
      }
    };
    selectionRef.current = read;
    return () => {
      if (selectionRef.current === read) selectionRef.current = null;
    };
  }, [selectionRef]);

  useEffect(() => {
    const root = hostRef.current;
    if (!root) return;
    htmlContext.repo = repo;
    htmlContext.relPath = relPath;
    htmlContext.author = author;
    imageContext.repo = repo;
    imageContext.relPath = relPath;
    imageContext.folder = imageFolder;

    const crepe = new Crepe({
      root,
      // A shared document arrives from the room; the template goes in below.
      defaultValue: room ? "" : initialValue,
      // Replaces CodeMirror's stock palette, which is generated into hashed
      // class names and so can't be reached from CSS.
      featureConfigs: {
        [CrepeFeature.CodeMirror]: {
          theme: codeTheme,
          /**
           * Crepe ships a short language list that has no YAML in it, which
           * matters here: frontmatter is YAML, and so is half of what gets
           * pasted into a plan. The full CodeMirror set, plus YAML explicitly
           * since it is not in that set either.
           */
          languages: [
            ...languages,
            LanguageDescription.of({
              name: "yaml",
              alias: ["yml", "frontmatter"],
              extensions: ["yaml", "yml"],
              load: async () => yaml(),
            }),
          ],
        },
      },
    });

    /**
     * Serialise markdown the way people write it, and the way Claude Code
     * writes it — remark's defaults are "*" for bullets and "_" for emphasis,
     * which turns every list in the repo over the first time a file is saved.
     * The point of this app is diff-friendly files, so the round trip has to
     * be as close to the identity as remark can be made to go.
     */
    crepe.editor.config((ctx) => {
      ctx.update(remarkPluginsCtx, (plugins) => [
        ...plugins,
        /**
         * Frontmatter is a thing, not three dashes.
         *
         * Without this the parser reads `---` as a thematic break and the YAML
         * beneath it as a setext heading, and serialising that back produces
         * `----------------` where the closing fence was. The app normally
         * hides the problem by splitting frontmatter off before the editor
         * sees it — but with that setting turned off the YAML is in the
         * document, and every save mangled it a little further.
         */
        { plugin: remarkFrontmatter, options: ["yaml"] } as never,
        { plugin: breaksFromHtml(), options: {} },
      ]);
      ctx.set(remarkStringifyOptionsCtx, {
        bullet: "-",
        emphasis: "*",
        strong: "*",
        fence: "`",
        fences: true,
        rule: "-",
        listItemIndent: "one",

        /**
         * Emit text exactly as it is, without adding backslash escapes.
         *
         * By default remark rewrites "a_word_b" as "a\\_word\\_b" and "2 * 3"
         * as "2 \\* 3" — safe, but it means the file on disk stops matching what
         * anyone wrote, and every save adds noise to the diff. Measured: with
         * this handler a representative document round-trips byte-identical;
         * without it, it does not.
         *
         * The trade-off: a literal asterisk or underscore typed in the page is
         * no longer protected, so it may re-parse as emphasis next time the
         * file is opened. Fidelity to what is on disk is worth more here.
         */
        handlers: {
          text: (node: { value: string }) => node.value,
          // It arrived as HTML and leaves as HTML, rather than as a backslash
          // or two invisible trailing spaces.
          break: () => "<br />",
        },
      });
    });

    // Render HTML rather than printing its source into the prose.
    // Pasting a link over a selection turns it into one.
    // A `yaml` node needs a schema before remark-frontmatter can produce one:
    // an unknown node type fails the whole document, not just the block.
    crepe.editor.use(yamlSchema);
    crepe.editor.use(pasteLink);
    // A pasted or dropped image is written into the repository and linked.
    crepe.editor.use(pasteImage);
    crepe.editor.use(htmlView);
    // A <picture> is a run of html nodes; this picks one by the app's paper.
    crepe.editor.use(pictureView);
    // ```mermaid blocks keep their source and gain a diagram beneath it.
    crepe.editor.use(mermaidView);
    // ⌘F over the rendered text: matches as decorations, recomputed with the
    // document so an agent's write through the watcher cannot strand them.
    crepe.editor.use($prose(() => findProsePlugin((c, t) => onFindCountRef.current?.(c, t))));
    // The shared document, when there is one: ySync, yCursor and yUndo bound
    // to the room after create(), below.
    if (room) crepe.editor.use(collab);

    /**
     * Writing HTML back into the document. A fragment may be several lines, and
     * each line is its own html node, so the range is replaced by one node per
     * line — which is the shape the parser would have produced.
     */
    const nodesFor = (value: string, schema: import("@milkdown/kit/prose/model").Schema) =>
      // A complete comment stays one node, newlines and all: split per line its
      // halves are not comments, and the card would not render until reopen.
      // It serialises verbatim, so the file still gets the multi-line block.
      isComment(value)
        ? [schema.nodes.html.create({ value })]
        : value
            .split("\n")
            .filter((line) => line.trim().length > 0)
            .map((line) => schema.nodes.html.create({ value: line }));

    htmlBridge.apply = ({ from, to, value }) => {
      touched = true;
      crepe.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const nodes = nodesFor(value, view.state.schema);
        const tr = view.state.tr;
        if (nodes.length) tr.replaceWith(from, to, nodes);
        else tr.delete(from, to);
        view.dispatch(tr);
      });
    };

    htmlBridge.insert = (value) => {
      touched = true;
      crepe.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const nodes = nodesFor(value, view.state.schema);
        if (!nodes.length) return;
        const { from, to } = view.state.selection;
        view.dispatch(view.state.tr.replaceWith(from, to, nodes).scrollIntoView());
      });
    };

    /**
     * A comment goes in at the cursor, where the reader pointed. A selection
     * is kept, not replaced — the comment sits at its end, about the text it
     * follows. A selection at the document itself falls back to the end.
     */
    htmlBridge.comment = (value) => {
      touched = true;
      crepe.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const nodes = nodesFor(value, view.state.schema);
        if (!nodes.length) return;
        const { $to } = view.state.selection;
        if ($to.depth > 0) {
          view.dispatch(view.state.tr.insert($to.pos, nodes).scrollIntoView());
        } else {
          const para = view.state.schema.nodes.paragraph.create(null, nodes);
          view.dispatch(
            view.state.tr.insert(view.state.doc.content.size, para).scrollIntoView(),
          );
        }
      });
    };

    /**
     * Put the cursor at the end of the document and take focus.
     *
     * Unlike its neighbours above this deliberately does not set `touched`.
     * Moving the cursor is not editing, and saying otherwise would re-open the
     * bug where merely opening a file marked it dirty and autosave wrote the
     * serialiser's rewrite back to disk.
     *
     * `TextSelection.near` rather than a selection at the size itself: the end
     * of the document is a position *between* blocks, where a cursor cannot
     * sit. Searching backwards from it finds the nearest place one can — for a
     * newly created file, the empty paragraph under the heading.
     */
    htmlBridge.focusEnd = () => {
      try {
        crepe.editor.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          const at = view.state.doc.resolve(view.state.doc.content.size);
          view.dispatch(view.state.tr.setSelection(TextSelection.near(at, -1)).scrollIntoView());
          view.focus();
        });
      } catch (e) {
        trace("focus failed", { error: String(e) });
      }
    };

    /**
     * Loading a document is not editing it. Parsing markdown into ProseMirror
     * and serialising it back is not the identity — bullets, emphasis and
     * escaping all normalise — so nothing is reported until create() has
     * settled and the text genuinely differs from what we were handed.
     */
    /**
     * Nothing is an edit until someone edits.
     *
     * `ready` was not enough. Parsing and re-serialising is not always the
     * identity — HTML especially — so a file could differ from itself the
     * moment it was opened, and autosave would write the difference back. A
     * document is only dirty once a person has typed, pasted, cut or dropped
     * into it, or changed it through the app's own HTML editor.
     */
    let touched = false;
    let ready = false;
    let timer: number | null = null;
    lastSentRef.current = initialValue;

    /**
     * Read the markdown on a pause, not on every key.
     *
     * Milkdown's markdownUpdated listener serialises the whole document before
     * it calls back, on every single transaction. Subscribing to it therefore
     * puts a full serialise — and, through onChange, a React render of the
     * whole app — between the key going down and the character appearing.
     *
     * So nothing subscribes. A plugin notices the document changed and asks for
     * the markdown once the typing stops, which is also all autosave ever
     * needed. ⌘S and switching files flush through the same path.
     */
    const send = () => {
      timer = null;
      if (!ready || !touched || swapping.current) return;
      const markdown = crepe.getMarkdown();
      if (markdown === lastSentRef.current) return;
      lastSentRef.current = markdown;
      // What the server hands to anyone reading the workspace as a file. Only
      // when it differs: a set of the same value is still an update, and two
      // editors answering each other's updates would never stop.
      if (room) {
        const meta = room.doc.getMap<string>("meta");
        if (meta.get("markdown") !== markdown) meta.set("markdown", markdown);
      }
      onChangeRef.current(markdown);
    };

    crepe.editor.use(
      $prose(
        () =>
          new Plugin({
            key: new PluginKey("plans-changed"),
            view: () => ({
              update: (view, prev) => {
                if (view.state.doc.eq(prev.doc)) return;
                if (timer) clearTimeout(timer);
                timer = window.setTimeout(send, 180);
              },
            }),
          }),
      ),
    );

    instance.current = crepe;
    created.current = false;
    if (markdownRef) {
      markdownRef.current = () => {
        if (!created.current) return "";
        try {
          return crepe.getMarkdown();
        } catch {
          return "";
        }
      };
    }
    untouch.current = () => {
      touched = false;
    };
    // A flush about to read the buffer asks for the keystrokes still inside
    // the debounce — otherwise everything typed in the last 180ms is missing
    // from what gets saved, and a caller quoting "the file" quotes the past.
    htmlBridge.collect = () => {
      if (timer) {
        clearTimeout(timer);
        send();
      }
    };

    const onInput = () => {
      touched = true;
    };
    for (const ev of ["beforeinput", "paste", "cut", "drop", "keydown"] as const) {
      root.addEventListener(ev, onInput, true);
    }
    /**
     * True once this effect has been cleaned up.
     *
     * create() and destroy() are both async, and React can unmount and remount
     * before either settles — StrictMode does exactly that. Without this, the
     * second editor is built while the first is still tearing down and both end
     * up in the DOM, each answering to the same keystrokes.
     */
    let disposed = false;
    /** Stops waiting for the room's first sync, if the editor goes first. */
    let unsync: (() => void) | null = null;

    crepe
      .create()
      .then(() => {
        if (disposed) {
          void crepe.destroy();
          return;
        }
        created.current = true;
        trace("editor created");
        if (room) {
          // Bind now; connect once the server's state has arrived, or the
          // template would be applied to a document that only looks empty.
          const connect = () => {
            if (disposed) return;
            try {
              crepe.editor.action((ctx) => {
                const service = ctx.get(collabServiceCtx);
                service.bindDoc(room.doc).setAwareness(room.awareness);
                service.applyTemplate(initialValue).connect();
              });
            } catch (e) {
              trace("collab connect failed", { error: String(e) });
            }
          };
          if (room.synced) connect();
          else unsync = room.onSynced(connect);
        }
        // A frame after creation, so the initial serialisation has been and gone.
        requestAnimationFrame(() => {
          ready = true;
          // A file opened while the editor was still building, taken now.
          if (queued.current !== null) {
            const text = queued.current;
            queued.current = null;
            trace("taking queued document", { chars: text.length });
            // swap() honours a pending focus request in its own frame; leaving
            // it to do so is what keeps this one-shot from firing twice.
            swap(text);
            return;
          }
          /*
           * The editor does not exist until the first file is opened — the
           * blank state renders instead of it — so a file created from an empty
           * window is built here, at construction, and never reaches swap().
           * Without this the request would sit set for the rest of the session
           * and steal the cursor from whatever was opened next.
           */
          if (htmlBridge.focusNext) {
            htmlBridge.focusNext = false;
            htmlBridge.focusEnd?.();
          }
        });
      })
      .catch((e) => console.error("editor failed to start", e));

    return () => {
      // Anything typed in the last moment still reaches the buffer.
      if (timer) {
        clearTimeout(timer);
        send();
      }
      trace("editor destroyed");
      disposed = true;
      created.current = false;
      unsync?.();
      if (markdownRef && instance.current === crepe) markdownRef.current = null;
      for (const ev of ["beforeinput", "paste", "cut", "drop", "keydown"] as const) {
        root.removeEventListener(ev, onInput, true);
      }
      if (instance.current === crepe) instance.current = null;
      htmlBridge.apply = null;
      htmlBridge.insert = null;
      htmlBridge.comment = null;
      htmlBridge.collect = null;
      /*
       * The reason the bridge is a bridge. A focus request outliving the editor
       * it was meant for would otherwise fire at a destroyed view; nulled here,
       * the pending call is simply a no-op. `focusNext` is left alone — it
       * belongs to App, and clearing it on a remount would drop a live request.
       */
      htmlBridge.focusEnd = null;
      /**
       * Do not touch the host here. destroy() resolves later, and React reuses
       * the same element for the next editor — clearing it then wipes the DOM
       * of the instance that has already replaced this one. The `disposed`
       * guard above is what keeps the two from overlapping.
       */
      void crepe.destroy();
    };
    // initialValue is read at construction; later documents arrive below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rebuild]);

  /**
   * A different document, into the editor that already exists.
   *
   * The first render is the one that costs — schema, plugins, a CodeMirror per
   * code block. Tearing that down and doing it again for every file switch is
   * seconds of work to show text we already have in hand.
   */
  /**
   * Put a different document into the editor that already exists.
   *
   * Only ever after create() has resolved: Milkdown throws "Should not call a
   * context out of the plugin" if an action reaches an editor that is still
   * building, which took the whole app down with it. A file opened during that
   * window waits in `queued` and is taken as soon as the editor is ready.
   */
  const swap = useCallback((text: string) => {
    const crepe = instance.current;
    if (!crepe || !created.current) {
      trace("swap queued", { chars: text.length, hasEditor: !!crepe });
      queued.current = text;
      return;
    }
    trace("swap", { chars: text.length });
    swapping.current = true;
    lastSentRef.current = text;
    untouch.current?.();
    try {
      crepe.editor.action(replaceAll(text));
    } catch (e) {
      trace("swap failed", { error: String(e) });
      console.error("could not replace the document", e);
    } finally {
      // Let the resulting transactions settle before anything counts as typing.
      requestAnimationFrame(() => {
        swapping.current = false;
        // Did the document actually arrive?
        if (text.trim()) {
          const now = (() => {
            try {
              return crepe.getMarkdown();
            } catch {
              return "";
            }
          })();
          if (!now.trim() && rebuiltFor.current !== text) {
            // Once per document: a file the schema cannot build would otherwise
            // rebuild the editor forever, which is worse than showing nothing.
            rebuiltFor.current = text;
            trace("swap left the editor empty — rebuilding", { chars: text.length });
            setRebuild((n) => n + 1);
          }
        }
        /*
         * Honoured here and nowhere earlier: this frame exists precisely to let
         * the replacement transactions settle, and focusing before they have is
         * focusing a document still being built. Optional, because the rebuild
         * branch above may have just torn the editor down.
         */
        if (htmlBridge.focusNext) {
          htmlBridge.focusNext = false;
          htmlBridge.focusEnd?.();
        }
      });
    }
  }, []);

  const built = useRef(false);
  useEffect(() => {
    if (!built.current) {
      built.current = true;
      return;
    }
    htmlContext.repo = repo;
    htmlContext.relPath = relPath;
    htmlContext.author = author;
    imageContext.repo = repo;
    imageContext.relPath = relPath;
    imageContext.folder = imageFolder;
    swap(initialValue);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey]);

  // The identity arrives from git after the editor is often already built, and
  // changing it should never rebuild a document.
  useEffect(() => {
    htmlContext.author = author;
  }, [author]);

  // Toggling spellcheck shouldn't rebuild the document, so it's set on the
  // live contenteditable rather than passed at construction.
  useEffect(() => {
    const el = hostRef.current?.querySelector<HTMLElement>(".ProseMirror");
    if (el) el.spellcheck = spellcheck;
  }, [spellcheck, docKey]);

  return (
    <div
      className="editor-host"
      ref={hostRef}
      /*
       * Links do something. A plain click stays an editing click — the caret
       * lands in the link text — but the webview must never navigate away,
       * and ⌘-click follows the link: another markdown file opens here,
       * anything with a scheme opens where it belongs.
       */
      onClickCapture={(e) => {
        const a = (e.target as Element).closest?.("a[href]");
        if (!a) return;
        e.preventDefault();
        if (!(e.metaKey || e.ctrlKey)) return;
        e.stopPropagation();
        onOpenLink?.(a.getAttribute("href") ?? "");
      }}
    />
  );
}
