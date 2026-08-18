/**
 * Learning about a new version, and reading what changed.
 *
 * The real install path ends in replacing the running bundle and relaunching,
 * which is not a thing a browser can do — that half is verified by hand, once,
 * against a published release. What is testable here is everything before the
 * press: that a found update says so quietly rather than modally, that "Later"
 * means later, that a check the reader asked for answers either way, and that
 * the notes open exactly once after the version changes underneath them.
 */
import { test, expect, type Page } from "@playwright/test";
import { installFakeBackend, type FakeRepo, type FakeUpdate } from "./fake-backend";

const REPOS: FakeRepo[] = [
  {
    path: "/repo/one",
    name: "one",
    branch: "main",
    files: { "first.md": "# First\n\nSome prose.\n" },
  },
];

/**
 * Boot with the feed claiming `update`, and with `seen` already recorded as the
 * version whose notes have been read.
 */
async function open(page: Page, opts: { update?: FakeUpdate; seen?: string } = {}) {
  await page.addInitScript(
    ([fn, list, update, seen]) => {
      // eslint-disable-next-line no-new-func
      new Function(`return ${fn}`)()(list, update ?? undefined);
      localStorage.setItem(
        "plans.repos.v1",
        JSON.stringify((list as FakeRepo[]).map((r) => r.path)),
      );
      localStorage.setItem("plans.tabs.v1", "[]");
      if (seen) {
        localStorage.setItem("plans.settings.v1", JSON.stringify({ lastSeenVersion: seen }));
      }
    },
    [installFakeBackend.toString(), REPOS, opts.update ?? null, opts.seen ?? null] as const,
  );

  await page.goto("/");
  await expect(page.locator(".files")).toBeVisible();
}

/** The palette, in command mode, running one command by name. */
async function command(page: Page, label: string) {
  await page.keyboard.press(process.platform === "darwin" ? "Meta+Shift+P" : "Control+Shift+P");
  // ">" is command mode; filling the field wholesale would drop back to files.
  await page.locator(".palette-input").fill(`>${label}`);
  await page.locator(".palette-row", { hasText: label }).first().click();
}

test("a found update is a banner, not a modal", async ({ page }) => {
  await open(page, {
    seen: "0.0.0-test",
    update: { version: "9.9.9", notes: "- Something worth having." },
  });

  await command(page, "Check for updates");

  const banner = page.locator(".update-banner");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("9.9.9");
  await expect(banner).toContainText("Something worth having.");
  // The document is still reachable: nothing was taken away to show this.
  await expect(page.locator(".matter-scrim")).toHaveCount(0);
  await expect(page.locator(".files")).toBeVisible();
});

test("later means later", async ({ page }) => {
  await open(page, {
    seen: "0.0.0-test",
    update: { version: "9.9.9", notes: "- Something worth having." },
  });

  await command(page, "Check for updates");
  await page.locator(".update-banner .act", { hasText: "Later" }).click();
  await expect(page.locator(".update-banner")).toHaveCount(0);
});

test("a check the reader asked for answers even when there is nothing", async ({ page }) => {
  await open(page, { seen: "0.0.0-test" });

  await command(page, "Check for updates");

  // Silence here would read as a broken button.
  await expect(page.locator(".toast")).toContainText("latest version");
  await expect(page.locator(".update-banner")).toHaveCount(0);
});

test("the notes open once when the version has moved, and not again", async ({ page }) => {
  // An older version was the last one read, so the running one is new.
  await open(page, { seen: "0.0.0-older" });

  const sheet = page.locator(".matter-sheet", { hasText: "What's new" });
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText("0.0.0-test");

  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);

  // The version is written down as soon as the notes are shown, which is what
  // stops the next launch showing them again. (Reloading the page cannot prove
  // it here: the init script re-seeds localStorage on every navigation.)
  const seen = await page.evaluate(
    () => JSON.parse(localStorage.getItem("plans.settings.v1") ?? "{}").lastSeenVersion,
  );
  expect(seen).toBe("0.0.0-test");
});

test("a fresh install is not told what is new about the version it just chose", async ({
  page,
}) => {
  // No lastSeenVersion at all: never run before.
  await open(page);
  await expect(page.locator(".files")).toBeVisible();
  await expect(page.locator(".matter-sheet", { hasText: "What's new" })).toHaveCount(0);
});

test("the notes are reachable on demand, whether or not they have been seen", async ({ page }) => {
  await open(page, { seen: "0.0.0-test" });

  await command(page, "Release notes");
  await expect(page.locator(".matter-sheet", { hasText: "What's new" })).toBeVisible();
});
