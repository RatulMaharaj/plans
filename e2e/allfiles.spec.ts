/**
 * All files in the tree, and the rule that keeps it honest.
 *
 * With `showAllFiles` on, the walk returns every text file, not only the
 * markdown. Milkdown parses markdown into a document and serialises it back;
 * hand it TypeScript and saving would rewrite the file into whatever the
 * round trip produced — so a non-markdown file must never reach the writing
 * surface, however it is asked for.
 */
import { test, expect, type Page } from "@playwright/test";
import { installFakeBackend, type FakeRepo } from "./fake-backend";

const REPOS: FakeRepo[] = [
  {
    path: "/repo/plans",
    name: "plans",
    branch: "main",
    files: {
      "a-plan.md": "# A plan\n\nSome prose.\n",
      "util.ts": "export const answer = () => 42;\n",
    },
  },
];

async function boot(page: Page, settings: Record<string, unknown> = {}) {
  await page.addInitScript(
    ([fn, list, prefs]) => {
      // eslint-disable-next-line no-new-func
      new Function(`return ${fn}`)()(list);
      localStorage.setItem(
        "plans.repos.v1",
        JSON.stringify((list as FakeRepo[]).map((r) => r.path)),
      );
      localStorage.setItem("plans.tabs.v1", "[]");
      localStorage.setItem("plans.settings.v1", JSON.stringify(prefs));
    },
    [installFakeBackend.toString(), REPOS, settings] as const,
  );
  await page.goto("/");
  await expect(page.locator(".files")).toBeVisible();
}

const fileRow = (page: Page, name: string) =>
  page.locator(".row.file", { hasText: name }).first();

test("off by default: the tree shows the markdown alone", async ({ page }) => {
  await boot(page);
  await expect(fileRow(page, "a-plan.md")).toBeVisible();
  await expect(page.locator(".row.file", { hasText: "util.ts" })).toHaveCount(0);
});

test("on: every file, with its real name — prettifying is for markdown", async ({ page }) => {
  await boot(page, { showAllFiles: true, showExtensions: false });
  // The plan reads as a title; the module keeps its extension, because the
  // extension is the point.
  await expect(fileRow(page, "a plan")).toBeVisible();
  await expect(fileRow(page, "util.ts")).toBeVisible();
});

test("a .ts file cannot reach the writing surface", async ({ page }) => {
  await boot(page, { showAllFiles: true });
  await fileRow(page, "util.ts").click();

  // It opens in Source, showing the text exactly as it is on disk.
  await expect(page.locator(".surface:not(.aside) .cm-content")).toContainText(
    "export const answer",
  );

  // The mode row offers Source alone — Write is hidden, not disabled.
  await expect(page.locator(".view-switch button", { hasText: "Source" })).toBeVisible();
  await expect(page.locator(".view-switch button", { hasText: "Write" })).toHaveCount(0);

  // The writing surface is not merely aside; it is not mounted at all.
  await expect(page.locator(".surface")).toHaveCount(1);

  // ⌘1 does nothing rather than silently switching.
  await page.keyboard.press("Meta+1");
  await expect(page.locator(".surface")).toHaveCount(1);
  await expect(page.locator(".surface:not(.aside) .cm-content")).toContainText(
    "export const answer",
  );

  // A markdown file beside it still gets the full pair of surfaces.
  await fileRow(page, "a-plan.md").click();
  await expect(page.locator(".view-switch button", { hasText: "Write" })).toBeVisible();
  await expect(page.locator(".surface")).toHaveCount(2);
});
