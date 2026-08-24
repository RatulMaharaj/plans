/**
 * Clicking down the git panel's list of changed files.
 *
 * Two regressions live here. The first was cache poisoning: @pierre/diffs
 * caches highlights by `cacheKey`, and a transitional render that paired one
 * file's committed side with another file's working copy under the new key
 * left the diff rendering as the previous file — or as nothing at all. The
 * second is speed: the committed side is prefetched for every changed file,
 * so each diff should paint from cache, not behind a fetch.
 */
import { test, expect, type Page } from "@playwright/test";
import { installFakeBackend, type FakeRepo } from "./fake-backend";

function repoWithChanges(): FakeRepo {
  const files: Record<string, string> = {};
  const heads: Record<string, string> = {};
  const modified: string[] = [];
  // Realistic plan-sized documents: a fat paragraph plus a long list.
  const body = (seed: number) =>
    `# Plan ${seed}\n\n${`A paragraph of ordinary prose about topic ${seed}. `.repeat(60)}\n\n${Array.from(
      { length: 400 },
      (_, i) => `- step ${i}: do the thing ${(i * seed) % 97}`,
    ).join("\n")}\n`;
  for (let i = 0; i < 8; i++) {
    const p = `plans/plan-${i}.md`;
    heads[p] = body(i);
    files[p] =
      body(i).replace(/step 5:.*$/m, `step 5: rewritten in change ${i}`) +
      `\nAdded a closing paragraph in the working copy of ${i}.\n`;
    modified.push(p);
  }
  for (let i = 0; i < 400; i++) files[`notes/note-${i}.md`] = `# Note ${i}\n\nShort.\n`;
  return { path: "/repo/m", name: "m", branch: "main", files, heads, modified };
}

const REPO = repoWithChanges();

async function boot(page: Page) {
  await page.addInitScript(
    ([fn, repo]) => {
      new Function(`return ${fn}`)()([repo]);
      localStorage.setItem("plans.repos.v1", JSON.stringify(["/repo/m"]));
      localStorage.setItem("plans.tabs.v1", "[]");
      localStorage.setItem("plans.settings.v1", JSON.stringify({ showGit: true }));
    },
    [installFakeBackend.toString(), REPO] as const,
  );
  await page.goto("/");
  await expect(page.locator(".files")).toBeVisible();
}

test("each changed file shows its own diff, promptly", async ({ page }) => {
  await boot(page);
  await expect(page.locator(".git")).toBeVisible();
  // Let the head prefetch warm the cache, as it would while a person reads.
  await page.waitForTimeout(800);

  for (let i = 0; i < 8; i++) {
    const t0 = Date.now();
    await page.locator(".git .change-path", { hasText: `plan-${i}` }).first().click();
    // Its own change, not the previous file's, and not a blank surface.
    await expect(page.locator(".diff-surface")).toContainText(`change ${i}`, {
      timeout: 5000,
    });
    const ms = Date.now() - t0;
    // A loose budget: measured ~60–200ms; only a real regression trips 1500.
    expect(ms, `click→diff for plan-${i} took ${ms}ms`).toBeLessThan(1500);
  }
});
