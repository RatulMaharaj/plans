/**
 * Comments land at the cursor — in whichever paragraph it sits, not at the
 * end of the document, which is where they drifted twice.
 */
import { test, expect, type Page } from "@playwright/test";
import { installFakeBackend, type FakeRepo } from "./fake-backend";

const REPOS: FakeRepo[] = [
  {
    path: "/repo/one",
    name: "one",
    branch: "main",
    files: {
      "plan.md": "# Plan\n\nFirst paragraph here.\n\nSecond paragraph here.\n\nLast paragraph here.\n",
    },
  },
];

async function open(page: Page) {
  await page.addInitScript(
    ([fn, list]) => {
      // eslint-disable-next-line no-new-func
      new Function(`return ${fn}`)()(list);
      localStorage.setItem(
        "plans.repos.v1",
        JSON.stringify((list as FakeRepo[]).map((r) => r.path)),
      );
      localStorage.setItem("plans.tabs.v1", "[]");
    },
    [installFakeBackend.toString(), REPOS] as const,
  );
  await page.goto("/");
  await expect(page.locator(".files")).toBeVisible();
  const repo = page.locator('.row.repo[aria-expanded="false"]');
  if (await repo.count()) await repo.click();
}

test("a comment goes in at the cursor, not the end of the document", async ({ page }) => {
  await open(page);
  await page.locator(".row.file", { hasText: "plan" }).click();
  await expect(page.locator(".ProseMirror")).toBeVisible();

  // Put the caret in the middle paragraph.
  await page.locator(".ProseMirror p", { hasText: "Second paragraph" }).click();

  await page.keyboard.press("Meta+Shift+m");
  await expect(page.locator(".matter-sheet")).toBeVisible();
  await page.locator(".matter-sheet textarea, .matter-sheet .name-field").first().fill("needs a source");
  await page.locator(".matter-sheet .act").click();

  // The comment card exists, and sits with the middle paragraph — before the
  // last one in document order.
  const comment = page.locator(".md-comment");
  await expect(comment).toHaveCount(1);
  const order = await page.evaluate(() => {
    const c = document.querySelector(".md-comment");
    const last = [...document.querySelectorAll(".ProseMirror p")].find((p) =>
      p.textContent?.includes("Last paragraph"),
    );
    if (!c || !last) return "missing";
    return c.compareDocumentPosition(last) & Node.DOCUMENT_POSITION_FOLLOWING
      ? "before-last"
      : "after-last";
  });
  expect(order).toBe("before-last");

  // And the source agrees: the comment sits with its paragraph on disk too.
  await page.keyboard.press("Meta+s");
  await page.waitForTimeout(500);
  await page.locator(".view-switch button", { hasText: "Source" }).click();
  const source = await page.locator(".source .cm-content").innerText();
  expect(source.indexOf("needs a source")).toBeGreaterThan(-1);
  expect(source.indexOf("needs a source")).toBeLessThan(source.indexOf("Last paragraph"));
});

test("the right-click menu's comment lands by the cursor too", async ({ page }) => {
  await open(page);
  await page.locator(".row.file", { hasText: "plan" }).click();
  await expect(page.locator(".ProseMirror")).toBeVisible();

  const middle = page.locator(".ProseMirror p", { hasText: "Second paragraph" });
  await middle.click();
  await middle.click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "New comment" }).click();
  await expect(page.locator(".matter-sheet")).toBeVisible();
  await page.locator(".matter-sheet textarea, .matter-sheet .name-field").first().fill("via the menu");
  await page.locator(".matter-sheet .act").click();

  await expect(page.locator(".md-comment")).toHaveCount(1);
  const order = await page.evaluate(() => {
    const c = document.querySelector(".md-comment");
    const last = [...document.querySelectorAll(".ProseMirror p")].find((p) =>
      p.textContent?.includes("Last paragraph"),
    );
    if (!c || !last) return "missing";
    return c.compareDocumentPosition(last) & Node.DOCUMENT_POSITION_FOLLOWING
      ? "before-last"
      : "after-last";
  });
  expect(order).toBe("before-last");
});
