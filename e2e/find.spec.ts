/**
 * ⌘F: find inside the file on screen.
 *
 * One bar, in the app's own chrome, with a per-surface engine underneath —
 * ProseMirror decorations in Write, CodeMirror's search machinery in Source.
 * These tests hold the contract that makes the binding trustworthy: it works
 * in both views (and in a Source-only non-markdown file), the count is
 * honest, Enter and ⇧Enter step through, Escape hands focus back, and a
 * palette `*` hit opens its file with the find already seeded.
 */
import { test, expect, type Page } from "@playwright/test";
import { installFakeBackend, type FakeRepo } from "./fake-backend";

const REPOS: FakeRepo[] = [
  {
    path: "/repo/one",
    name: "one",
    branch: "main",
    files: {
      "guide.md": "# Guide\n\nalpha first\n\nalpha second\n\nalpha third\n",
      "other.md": "# Other\n\nNothing to see.\n",
      "util.ts": "export const alpha = 1;\nexport const beta = 2;\n",
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

test("⌘F finds in the page: count, next, previous", async ({ page }) => {
  await boot(page);
  await fileRow(page, "guide").click();
  await expect(page.locator(".milkdown")).toContainText("alpha first");

  await page.keyboard.press("Meta+f");
  await expect(page.locator(".find-bar")).toBeVisible();
  await expect(page.locator(".find-input")).toBeFocused();

  await page.keyboard.type("alpha");
  // Highlights arrive on the 180ms pause; the count says where you are.
  await expect(page.locator(".find-count")).toHaveText("1 of 3");
  await expect(page.locator(".milkdown .find-match")).toHaveCount(3);
  await expect(page.locator(".milkdown .find-match.current")).toHaveCount(1);

  await page.keyboard.press("Enter");
  await expect(page.locator(".find-count")).toHaveText("2 of 3");
  await page.keyboard.press("Enter");
  await expect(page.locator(".find-count")).toHaveText("3 of 3");
  // Wraps rather than stopping — the browser contract.
  await page.keyboard.press("Enter");
  await expect(page.locator(".find-count")).toHaveText("1 of 3");
  await page.keyboard.press("Shift+Enter");
  await expect(page.locator(".find-count")).toHaveText("3 of 3");
});

test("the same bar drives the source view", async ({ page }) => {
  await boot(page);
  await fileRow(page, "guide").click();
  await page.keyboard.press("Meta+2");
  await expect(page.locator(".surface:not(.aside) .cm-content")).toContainText("alpha first");

  await page.keyboard.press("Meta+f");
  await expect(page.locator(".find-bar")).toBeVisible();
  await page.keyboard.type("alpha");

  await expect(page.locator(".find-count")).toHaveText("1 of 3");
  await expect(page.locator(".source .cm-searchMatch")).toHaveCount(3);
  await page.keyboard.press("Enter");
  await expect(page.locator(".find-count")).toHaveText("2 of 3");

  // No stock CodeMirror panel ever shows — the bar is the app's own.
  await expect(page.locator(".cm-search")).toHaveCount(0);
});

test("the query survives a view switch; the count follows the surface", async ({ page }) => {
  await boot(page);
  await fileRow(page, "guide").click();
  await page.keyboard.press("Meta+f");
  await page.keyboard.type("second");
  await expect(page.locator(".find-count")).toHaveText("1 of 1");

  await page.keyboard.press("Meta+2");
  await expect(page.locator(".find-input")).toHaveValue("second");
  await expect(page.locator(".source .cm-searchMatch")).toHaveCount(1);
  // The write surface, set aside, keeps no paint the reader cannot see.
  await expect(page.locator(".find-count")).toHaveText("1 of 1");
});

test("escape closes the bar and hands focus back to the page", async ({ page }) => {
  await boot(page);
  await fileRow(page, "guide").click();
  await page.locator(".milkdown .ProseMirror").click();

  await page.keyboard.press("Meta+f");
  await expect(page.locator(".find-input")).toBeFocused();
  await page.keyboard.type("alpha");
  await expect(page.locator(".find-count")).toHaveText("1 of 3");

  await page.keyboard.press("Escape");
  await expect(page.locator(".find-bar")).toHaveCount(0);
  await expect(page.locator(".milkdown .find-match")).toHaveCount(0);
  // Focus is back where the cursor was, not lost to the body.
  const inPage = await page.evaluate(
    () => !!document.activeElement?.closest(".ProseMirror"),
  );
  expect(inPage, "escape returns focus to the editor").toBe(true);
});

test("a palette * hit opens the file with the find seeded", async ({ page }) => {
  await boot(page);
  // Start somewhere else, so the hit genuinely opens the file.
  await fileRow(page, "other").click();
  await expect(page.locator(".milkdown")).toContainText("Nothing to see");

  await page.keyboard.press("Meta+p");
  await page.keyboard.type("*second");
  const hit = page.locator(".palette-row", { hasText: "guide.md" }).first();
  await hit.click();

  // Same bar, query prefilled, the match nearest the hit line current.
  await expect(page.locator(".find-bar")).toBeVisible();
  await expect(page.locator(".find-input")).toHaveValue("second");
  await expect(page.locator(".find-count")).toHaveText("1 of 1");
  await expect(page.locator(".milkdown .find-match.current")).toBeVisible();
});

test("find works where only Source exists: a non-markdown file", async ({ page }) => {
  await boot(page, { showAllFiles: true });
  await fileRow(page, "util.ts").click();
  await expect(page.locator(".surface:not(.aside) .cm-content")).toContainText(
    "export const alpha",
  );

  await page.keyboard.press("Meta+f");
  await expect(page.locator(".find-bar")).toBeVisible();
  await page.keyboard.type("export");
  await expect(page.locator(".find-count")).toHaveText("1 of 2");
  await expect(page.locator(".source .cm-searchMatch")).toHaveCount(2);
});
