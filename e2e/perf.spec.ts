/**
 * What the app must stay fast at.
 *
 * Every performance failure in this project was invisible until measured, and
 * each was a regression rather than a slow algorithm: a hidden editor
 * reparsing on every keystroke, a plugin dispatching from its own update hook,
 * four repositories walked at once behind someone's typing. So these are
 * budgets, not benchmarks — they exist to fail when a change makes the app
 * worse, and the numbers are deliberately loose enough that only a real
 * regression trips them.
 *
 * The budgets are generous because CI machines are slow and shared. A change
 * that doubles the cost of typing will still fail; ordinary noise will not.
 */
import { test, expect, type Page } from "@playwright/test";
import { installFakeBackend, type FakeRepo } from "./fake-backend";

/** A repository big enough that O(files) mistakes show up. */
function bigRepo(files: number): FakeRepo {
  const out: Record<string, string> = {};
  for (let i = 0; i < files; i++) {
    const dir = `area-${i % 12}/sub-${i % 5}`;
    out[`${dir}/note-${i}.md`] = `# Note ${i}\n\nSome prose about thing ${i}.\n`;
  }
  // A few at the root, so a test can reach files without opening folders.
  for (let i = 0; i < 6; i++) out[`top-${i}.md`] = `# Top ${i}\n\nShort.\n`;
  out["big.md"] = `# Big\n\n${"A paragraph of ordinary prose. ".repeat(40)}\n\n${Array.from(
    { length: 200 },
    (_, i) => `- item ${i}`,
  ).join("\n")}\n`;
  out["small.md"] = "# Small\n\nShort.\n";
  return { path: "/repo/big", name: "big", branch: "main", files: out };
}

const REPO = bigRepo(1200);

async function boot(page: Page) {
  await page.addInitScript(
    ([fn, repo]) => {
      new Function(`return ${fn}`)()([repo]);
      localStorage.setItem("plans.repos.v1", JSON.stringify(["/repo/big"]));
      localStorage.setItem("plans.tabs.v1", "[]");
    },
    [installFakeBackend.toString(), REPO] as const,
  );
  await page.goto("/");
  await expect(page.locator(".files")).toBeVisible();
}

/** Milliseconds of main-thread work, which is what "feels slow" means. */
async function blockingTime(page: Page, during: () => Promise<void>): Promise<number> {
  await page.evaluate(() => {
    (window as any).__long = 0;
    (window as any).__obs?.disconnect?.();
    const obs = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) (window as any).__long += e.duration;
    });
    obs.observe({ entryTypes: ["longtask"] });
    (window as any).__obs = obs;
  });
  await during();
  return page.evaluate(() => (window as any).__long as number);
}

test.describe("budgets", () => {
  test("a repository of 1,200 files opens without a stall", async ({ page }) => {
    await boot(page);
    // The active repository opens by itself; this measures that arrival.
    const blocked = await blockingTime(page, async () => {
      await expect(page.locator(".row.file").first()).toBeVisible();
      await page.waitForTimeout(1500);
    });
    // Building and rendering the tree is real work; freezing the window is not.
    expect(blocked, `${blocked}ms of main thread blocked`).toBeLessThan(2500);
  });

  test("typing does not re-render the app", async ({ page }) => {
    await boot(page);
    await page.locator(".row.file", { hasText: "small" }).first().click();
    await page.locator(".milkdown .ProseMirror").click();

    const before = await page.evaluate(() => (window as any).__fake.calls.length);
    await page.keyboard.type("the quick brown fox jumps over the lazy dog", { delay: 12 });
    const after = await page.evaluate(() => (window as any).__fake.calls.length);

    /**
     * 43 characters. Each one used to serialise the document, cross into React,
     * and re-render everything; a save per keystroke would show here as dozens
     * of calls. A handful is the debounce doing its job.
     */
    expect(after - before, "IPC calls while typing").toBeLessThan(8);
  });

  test("typing stays responsive in a long document", async ({ page }) => {
    await boot(page);
    await page.locator(".row.file", { hasText: "big" }).first().click();
    await page.locator(".milkdown .ProseMirror").click();

    const blocked = await blockingTime(page, async () => {
      await page.keyboard.type("some words typed into a long document", { delay: 10 });
      await page.waitForTimeout(400);
    });
    expect(blocked, `${blocked}ms blocked while typing`).toBeLessThan(1200);
  });

  test("switching files does not rebuild the editor", async ({ page }) => {
    await boot(page);
    await page.locator(".row.file", { hasText: "top-0" }).first().click();
    await expect(page.locator(".milkdown")).toBeVisible();

    // The editor is built once; after that a swap is a transaction.
    const started = Date.now();
    for (let i = 0; i < 6; i++) {
      await page.locator(".row.file", { hasText: `top-${i % 3}` }).first().click();
      await expect(page.locator(".milkdown .ProseMirror")).toContainText(`Top ${i % 3}`);
    }
    const each = (Date.now() - started) / 6;
    expect(each, `${Math.round(each)}ms per switch`).toBeLessThan(900);
  });

  test("the palette opens over a large repository without lag", async ({ page }) => {
    await boot(page);
    const blocked = await blockingTime(page, async () => {
      await page.keyboard.press("Meta+p");
      await expect(page.locator(".palette")).toBeVisible();
      await page.locator(".palette-input").fill("note-5");
      await expect(page.locator(".palette-row").first()).toBeVisible();
    });
    expect(blocked, `${blocked}ms blocked opening the palette`).toBeLessThan(900);
  });

  test("polling stays quiet when nothing changes", async ({ page }) => {
    await boot(page);
    await page.locator(".row.file", { hasText: "small" }).first().click();
    await page.waitForTimeout(500);

    const before = await page.evaluate(() => (window as any).__fake.calls.length);
    await page.waitForTimeout(6000);
    const after = await page.evaluate(() => (window as any).__fake.calls.length);

    /**
     * Six seconds of an idle app. The active repository's status is polled on
     * the short interval and the full walk far less often — the version that
     * walked every repository every four seconds is what made the window slow.
     */
    expect(after - before, "IPC calls while idle for 6s").toBeLessThan(14);
  });
});
