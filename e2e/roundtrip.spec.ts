/**
 * Does Prettier's markdown disagree with ours in a way that survives?
 *
 * The formatters plan rests on one assumption: that we can hand our serialised
 * markdown to Prettier, write what comes back, and have the editor parse it to
 * the same document. If Prettier normalises something Milkdown then re-emits
 * differently, saving twice would oscillate — the file would change on every
 * save forever, which is the exact churn the feature exists to prevent.
 *
 * This runs the loop directly, with no browser: our stringify settings stand in
 * for the editor's serialiser, since they are the same options Editor.tsx sets
 * on remarkStringifyOptionsCtx. It is the cheapest possible answer to the
 * question, and the plan says to answer it before anything ships.
 */
import { test, expect } from "@playwright/test";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkStringify from "remark-stringify";
import remarkFrontmatter from "remark-frontmatter";
import * as prettier from "prettier";

/** The options Editor.tsx sets — kept in step with it by hand, deliberately. */
const OURS = {
  bullet: "-" as const,
  emphasis: "*" as const,
  strong: "*" as const,
  fence: "`" as const,
  fences: true,
  rule: "-" as const,
  listItemIndent: "one" as const,
  handlers: { text: (node: { value: string }) => node.value },
};

/** Our serialiser: parse markdown, print it back the way the editor would. */
function ours(markdown: string): string {
  return String(
    unified()
      .use(remarkParse)
      .use(remarkGfm)
      // As the editor does: frontmatter is parsed, not mistaken for a rule.
      .use(remarkFrontmatter, ["yaml"])
      .use(remarkStringify, OURS)
      .processSync(markdown),
  );
}

async function pretty(markdown: string): Promise<string> {
  return prettier.format(markdown, { parser: "markdown" });
}

const FIXTURES: Record<string, string> = {
  "a plan, as an agent writes one": `# Auth plan

Some prose about the work, with a [link](https://example.com) and \`code\`.

- one
- two
  - nested
- three

1. first
2. second

> A quote, which is worth keeping.

\`\`\`ts
const x: number = 1;
\`\`\`
`,
  "a table": `# Table

| Command | What it does |
| --- | --- |
| \`pnpm test\` | runs the tests |
| \`pnpm app\` | starts the app |
`,
  "task lists": `# Tasks

- [ ] not done
- [x] done
- [ ] also not done
`,
  "text that wants escaping": `# Escapes

A sentence with a_word_b and 2 * 3 and a literal <br /> in it.

Some **strong** and *emphasis* together.
`,
  "frontmatter and a heading": `---
title: A plan
date: 2026-08-17
---

# The plan

Body text.
`,
  "long prose that prettier may rewrap": `# Wrapping

${"A long sentence that runs well past eighty characters to see whether the printer decides to rewrap it or leaves it alone. ".repeat(2)}
`,
};

test.describe("markdown round trip", () => {
  for (const [name, source] of Object.entries(FIXTURES)) {
    test(`${name}: prettier's output survives our parser`, async () => {
      // The loop a save would perform: ours → prettier → ours.
      const once = await pretty(ours(source));
      const twice = ours(once);

      /**
       * The assertion that matters. If these differ, every save oscillates
       * between two forms and the feature is unshippable as designed.
       */
      expect(ours(twice), "our parser must not undo Prettier's formatting").toBe(ours(once));
    });

    test(`${name}: formatting is idempotent`, async () => {
      const once = await pretty(ours(source));
      const twice = await pretty(ours(once));
      expect(twice, "a second save must not change the file again").toBe(once);
    });
  }
});
