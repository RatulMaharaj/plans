/**
 * Frontmatter, as a node the editor understands.
 *
 * remark-frontmatter parses `---` blocks into `yaml` nodes, which is what stops
 * the parser reading them as a thematic break with a setext heading under it —
 * a misreading that rewrote the closing fence as `----------------` and grew
 * the file on every save.
 *
 * Milkdown has no schema for a `yaml` node, though, and an unknown node type
 * fails the whole document rather than the block. So it gets one here: an atom
 * that shows the metadata, keeps its text exactly, and serialises back through
 * remark-frontmatter as the fenced block it came from.
 *
 * Only reached when the frontmatter panel is turned off. With it on, the block
 * never enters the document at all — see matter.ts.
 */
import { $nodeSchema } from "@milkdown/utils";

export const yamlSchema = $nodeSchema("yaml", () => ({
  atom: true,
  group: "block",
  // Not editable in place: the panel is where frontmatter is edited, and an
  // atom cannot be half-parsed into invalid YAML by a stray keystroke.
  selectable: true,
  draggable: false,
  attrs: { value: { default: "" } },
  parseDOM: [
    {
      tag: 'pre[data-type="frontmatter"]',
      getAttrs: (dom) => ({ value: (dom as HTMLElement).textContent ?? "" }),
    },
  ],
  toDOM: (node) => [
    "pre",
    { "data-type": "frontmatter", class: "md-frontmatter" },
    String(node.attrs.value ?? ""),
  ],
  parseMarkdown: {
    match: ({ type }) => type === "yaml",
    runner: (state, node, type) => {
      state.addNode(type, { value: String(node.value ?? "") });
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === "yaml",
    runner: (state, node) => {
      state.addNode("yaml", undefined, String(node.attrs.value ?? ""));
    },
  },
}));
