/**
 * Markdown that contains HTML.
 *
 * A README is markdown too: centred divs, <sub> subtitles, <br> breaks, badge
 * rows, <picture> covers. The editor is WYSIWYG, so it has to render what the
 * spec allows rather than print the source and hope.
 */
import { test, expect, type Page } from "@playwright/test";
import { installFakeBackend, type FakeRepo } from "./fake-backend";

const FILES: Record<string, string> = {
  "wrap.md": `Para with <sub>a subtitle</sub> and <b>bold</b> inline.\n`,
  "break.md": `Line one<br/>line two\n`,
  "centre.md": `<div align="center">\n\n# Title<br/><sub><b>Sub.</b></sub>\n\n</div>\n`,
  "plain.md": `# Plain\n\nNo html at all.\n`,
};

const REPO: FakeRepo = {
  path: "/repo/one",
  name: "one",
  branch: "main",
  files: FILES,
};

async function open(page: Page, file: string) {
  const faults: string[] = [];
  page.on("pageerror", (e) => faults.push(e.message));
  await page.addInitScript(
    ([fn, repo]) => {
      new Function(`return ${fn}`)()([repo]);
      localStorage.setItem("plans.repos.v1", JSON.stringify(["/repo/one"]));
      localStorage.setItem("plans.tabs.v1", "[]");
    },
    [installFakeBackend.toString(), REPO] as const,
  );
  await page.goto("/");
  await page.locator(".row.file", { hasText: file.replace(".md", "") }).first().click();
  await expect(page.locator(".milkdown .ProseMirror")).toBeVisible();
  return faults;
}

test("an inline wrapper styles the text it wraps, and hides its tags", async ({ page }) => {
  await open(page, "wrap.md");
  const editor = page.locator(".milkdown .ProseMirror");
  await expect(editor.locator(".md-i-sub")).toHaveText("a subtitle");
  await expect(editor.locator(".md-i-b")).toHaveText("bold");
  // The tags themselves are in the document but not on the page.
  await expect(editor.locator(".md-html:not(.md-hidden)")).toHaveCount(0);
});

test("<br> is a line break, not a missing character", async ({ page }) => {
  await open(page, "break.md");
  const breaks = await page.evaluate(
    () =>
      document.querySelectorAll(".milkdown .ProseMirror br:not(.ProseMirror-trailingBreak)").length,
  );
  expect(breaks, "the break should be rendered").toBeGreaterThan(0);
});

test("a centred block is centred", async ({ page }) => {
  await open(page, "centre.md");
  const centred = page.locator(".milkdown .ProseMirror .md-center").first();
  await expect(centred).toHaveCount(1);
  await expect(centred).toHaveCSS("text-align", "center");
});

test("html round-trips unchanged when it is only read", async ({ page }) => {
  await open(page, "centre.md");
  await page.waitForTimeout(2600);
  const writes = await page.evaluate(() =>
    (window as any).__fake.calls.filter((c: any) => c.cmd === "write_plan"),
  );
  expect(writes, "rendering html is not editing it").toHaveLength(0);
});
