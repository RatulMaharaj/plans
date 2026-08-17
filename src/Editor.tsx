import { useCallback, useEffect, useRef } from "react";
import { Crepe, CrepeFeature } from "@milkdown/crepe";
import { remarkPluginsCtx, remarkStringifyOptionsCtx } from "@milkdown/core";
import remarkFrontmatter from "remark-frontmatter";
import { $prose, replaceAll } from "@milkdown/utils";
import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import { languages } from "@codemirror/language-data";
import { LanguageDescription } from "@codemirror/language";
import { yaml } from "@codemirror/lang-yaml";
import { codeTheme } from "./code-theme";
import { htmlBridge, htmlContext, htmlView, pictureView } from "./html-view";
import { editorViewCtx } from "@milkdown/core";
import { mermaidView } from "./mermaid-view";
import { pasteLink } from "./paste-link";
import { imageContext, pasteImage } from "./paste-image";
import { yamlSchema } from "./yaml-node";
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
  onChange: (markdown: string) => void;
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

function breaksFromHtml() {
  return () => (tree: { children?: unknown[] }) => {
    const walk = (node: any) => {
      const kids = node?.children;
      if (!Array.isArray(kids)) return;
      for (let i = 0; i < kids.length; i++) {
        const child = kids[i];
        if (child?.type === "html" && BR.test(String(child.value).trim())) {
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
  onChange,
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
  /** Set by the live editor, so a swap can declare the new document untouched. */
  const untouch = useRef<(() => void) | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const root = hostRef.current;
    if (!root) return;
    htmlContext.repo = repo;
    htmlContext.relPath = relPath;
    imageContext.repo = repo;
    imageContext.relPath = relPath;
    imageContext.folder = imageFolder;

    const crepe = new Crepe({
      root,
      defaultValue: initialValue,
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

    /**
     * Writing HTML back into the document. A fragment may be several lines, and
     * each line is its own html node, so the range is replaced by one node per
     * line — which is the shape the parser would have produced.
     */
    const nodesFor = (value: string, schema: import("@milkdown/kit/prose/model").Schema) =>
      value
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
    untouch.current = () => {
      touched = false;
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

    crepe
      .create()
      .then(() => {
        if (disposed) {
          void crepe.destroy();
          return;
        }
        created.current = true;
        // A frame after creation, so the initial serialisation has been and gone.
        requestAnimationFrame(() => {
          ready = true;
          // A file opened while the editor was still building, taken now.
          if (queued.current !== null) {
            const text = queued.current;
            queued.current = null;
            swap(text);
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
      disposed = true;
      created.current = false;
      for (const ev of ["beforeinput", "paste", "cut", "drop", "keydown"] as const) {
        root.removeEventListener(ev, onInput, true);
      }
      if (instance.current === crepe) instance.current = null;
      htmlBridge.apply = null;
      htmlBridge.insert = null;
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
  }, []);

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
      queued.current = text;
      return;
    }
    swapping.current = true;
    lastSentRef.current = text;
    untouch.current?.();
    try {
      crepe.editor.action(replaceAll(text));
    } catch (e) {
      console.error("could not replace the document", e);
    } finally {
      // Let the resulting transactions settle before anything counts as typing.
      requestAnimationFrame(() => {
        swapping.current = false;
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
    imageContext.repo = repo;
    imageContext.relPath = relPath;
    imageContext.folder = imageFolder;
    swap(initialValue);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey]);

  // Toggling spellcheck shouldn't rebuild the document, so it's set on the
  // live contenteditable rather than passed at construction.
  useEffect(() => {
    const el = hostRef.current?.querySelector<HTMLElement>(".ProseMirror");
    if (el) el.spellcheck = spellcheck;
  }, [spellcheck, docKey]);

  return <div className="editor-host" ref={hostRef} />;
}
