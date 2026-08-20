/**
 * Frontmatter, split and put back.
 *
 * `matter.ts` has no dependencies and no DOM, so it can be exercised directly
 * — which matters here, because the bug this file was written for was invisible
 * from the app. A file grew a second, empty block in front of its real one and
 * nothing surfaced it: only the first block parses, so the plan's status simply
 * stopped existing as far as the app was concerned, while the file on disk
 * still looked almost right to a person reading it.
 */
import { test, expect } from "@playwright/test";
import { splitFrontmatter, joinFrontmatter } from "../src/matter";

test.describe("frontmatter", () => {
  test("an untouched block goes back byte for byte", () => {
    const text = "---\nstatus: ready\n---\n# Title\n\nProse.\n";
    const split = splitFrontmatter(text);
    expect(joinFrontmatter(split.matter, split.body, split)).toBe(text);
  });

  /**
   * The bug. `null` means the file has no block; `""` means the block is there
   * and holds nothing — which is what emptying the sheet's textarea produces.
   * Writing a bare pair of fences for the second is how a file ended up opening
   * `---`, blank, `---`, and then its real metadata.
   */
  test("an emptied block writes no fences", () => {
    expect(joinFrontmatter("", "# Title\n")).toBe("# Title\n");
    expect(joinFrontmatter("   \n\n", "# Title\n")).toBe("# Title\n");
  });

  test("a file already carrying an empty block is repaired by saving it", () => {
    const text = "---\n\n---\n# Title\n";
    const split = splitFrontmatter(text);
    expect(split.matter).toBe("");
    // Not preserved verbatim: the emptiness is the thing being fixed.
    expect(joinFrontmatter(split.matter, split.body, split)).toBe("# Title\n");
  });

  test("no block stays no block", () => {
    expect(joinFrontmatter(null, "# Title\n")).toBe("# Title\n");
  });

  test("a changed block is rebuilt with exactly one pair of fences", () => {
    const text = "---\nstatus: draft\n---\n# Title\n";
    const split = splitFrontmatter(text);
    const out = joinFrontmatter("status: ready", split.body, split);
    expect(out).toBe("---\nstatus: ready\n---\n# Title\n");
    expect(out.match(/^---$/gm)).toHaveLength(2);
  });
});
