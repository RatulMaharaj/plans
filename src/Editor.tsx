import { useEffect, useRef } from "react";
import { Crepe, CrepeFeature } from "@milkdown/crepe";
import { remarkStringifyOptionsCtx } from "@milkdown/core";
import { languages } from "@codemirror/language-data";
import { LanguageDescription } from "@codemirror/language";
import { yaml } from "@codemirror/lang-yaml";
import { codeTheme } from "./code-theme";
import { htmlBridge, htmlContext, htmlView, pictureView } from "./html-view";
import { editorViewCtx } from "@milkdown/core";
import { mermaidView } from "./mermaid-view";
import "./editor-theme.css";

type Props = {
  /** Which file this is, so HTML can resolve its relative image paths. */
  repo: string;
  relPath: string;
  /** Changing this key tears down and rebuilds the editor with fresh content. */
  docKey: string;
  initialValue: string;
  spellcheck: boolean;
  onChange: (markdown: string) => void;
};

/**
 * Milkdown Crepe gives us a WYSIWYG surface whose source of truth is markdown,
 * so what lands on disk stays diff-friendly for git.
 */
export function Editor({ docKey, repo, relPath, initialValue, spellcheck, onChange }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const root = hostRef.current;
    if (!root) return;
    htmlContext.repo = repo;
    htmlContext.relPath = relPath;

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
        handlers: { text: (node: { value: string }) => node.value },
      });
    });

    /**
     * Loading a document is not editing it.
     *
     * Parsing markdown into ProseMirror and serialising it back is not the
     * identity: bullet markers, emphasis characters, escaping and blank lines
     * all get normalised. Those serialisations arrive through the same
     * markdownUpdated channel as real typing, so without this gate merely
     * opening a file marked it dirty and autosave wrote the rewrite to disk.
     *
     * So: ignore everything until create() has settled, and ignore any update
     * that still matches the text we were given.
     */
    let ready = false;
    crepe.on((listener) => {
      listener.markdownUpdated((_ctx, markdown, prev) => {
        if (!ready) return;
        if (markdown === prev || markdown === initialValue) return;
        onChangeRef.current(markdown);
      });
    });

    // Render HTML rather than printing its source into the prose.
    crepe.editor.use(htmlView);
    // A <picture> is a run of html nodes; this picks one by the app's paper.
    crepe.editor.use(pictureView);
    // ```mermaid blocks keep their source and gain a diagram beneath it.
    crepe.editor.use(mermaidView);

    /**
     * Writing HTML back into the document. A fragment may be several lines, and
     * each line is its own html node, so the range is replaced by one node per
     * line — which is exactly the shape the parser would have produced.
     */
    const nodesFor = (value: string, schema: import("@milkdown/kit/prose/model").Schema) =>
      value
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => schema.nodes.html.create({ value: line }));

    htmlBridge.apply = ({ from, to, value }) => {
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
      crepe.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const nodes = nodesFor(value, view.state.schema);
        if (!nodes.length) return;
        const { from, to } = view.state.selection;
        view.dispatch(view.state.tr.replaceWith(from, to, nodes).scrollIntoView());
      });
    };

    crepe
      .create()
      .then(() => {
        // A frame after creation, so the initial serialisation has been and gone.
        requestAnimationFrame(() => {
          ready = true;
        });
      })
      .catch((e) => console.error("editor failed to start", e));

    return () => {
      htmlBridge.apply = null;
      htmlBridge.insert = null;
      crepe.destroy();
    };
    // initialValue is intentionally excluded: docKey drives remounts.
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
