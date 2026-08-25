/**
 * Settings as a file.
 *
 * The app's thesis is that plain files people and agents can both read beat
 * opaque state, and the settings were the one piece of its own state arguing
 * the opposite. They now live in settings.json, with localStorage kept on as a
 * warm start so the theme is right on the first frame.
 *
 * That arrangement has exactly four ways to be wrong, and each is a test here:
 * the file never gets written on first launch, the cache wins a disagreement
 * it should lose, an edit made outside never arrives, or a typo silently
 * resets everything someone spent an afternoon choosing.
 */
import { test, expect, type Page } from "@playwright/test";
import { installFakeBackend, type FakeRepo } from "./fake-backend";

const REPOS: FakeRepo[] = [
  {
    path: "/repo/one",
    name: "one",
    branch: "main",
    files: { "first.md": "# First\n\nSome prose.\n" },
  },
];

/**
 * Boot with a given settings file already on disk, and a given warm-start
 * cache — the two are set apart precisely so a test can make them disagree.
 */
async function open(
  page: Page,
  opts: { file?: string | null; cache?: Record<string, unknown> } = {},
) {
  await page.addInitScript(
    ([fn, list, file, cache]) => {
      // eslint-disable-next-line no-new-func
      new Function(`return ${fn}`)()(list);
      localStorage.setItem(
        "plans.repos.v1",
        JSON.stringify((list as FakeRepo[]).map((r) => r.path)),
      );
      localStorage.setItem("plans.tabs.v1", "[]");
      if (cache) localStorage.setItem("plans.settings.v1", JSON.stringify(cache));
      if (file !== null && file !== undefined) {
        (window as any).__fake.settingsFile = { text: file, stamp: 1 };
      }
    },
    [
      installFakeBackend.toString(),
      REPOS,
      opts.file ?? null,
      opts.cache ?? null,
    ] as const,
  );
  await page.goto("/");
  await expect(page.locator(".files")).toBeVisible();
}

const fake = (page: Page) =>
  page.evaluate(() => ({
    text: (window as any).__fake.settingsFile.text as string | null,
    stamp: (window as any).__fake.settingsFile.stamp as number,
    schema: (window as any).__fake.settingsSchema as string | null,
    opened: (window as any).__fake.settingsOpened as number,
  }));

/** Run a command from the palette by typing enough of its label. */
async function runCommand(page: Page, label: string) {
  await page.keyboard.press("Meta+Shift+p");
  await expect(page.locator(".palette")).toBeVisible();
  await page.locator(".palette-input").fill(`>${label}`);
  await page.locator(".palette-row", { hasText: label }).first().click();
  await expect(page.locator(".palette")).toHaveCount(0);
}

/** Play the outside editor: new text, and a stamp that has moved. */
async function editOutside(page: Page, text: string) {
  await page.evaluate((t) => {
    const f = (window as any).__fake;
    f.settingsFile = { text: t, stamp: f.settingsFile.stamp + 100 };
  }, text);
}

test("first launch writes the file from whatever was in localStorage", async ({ page }) => {
  await open(page, { file: null, cache: { theme: "sepia", measure: 62 } });

  await expect.poll(async () => (await fake(page)).text).not.toBeNull();
  const { text } = await fake(page);
  const written = JSON.parse(text!);

  // Migration is the same code path with the arrow reversed: what was in the
  // cache is what the file starts as.
  expect(written.theme).toBe("sepia");
  expect(written.measure).toBe(62);
  // And it points at its schema, so an editor completes this build's keys.
  expect(written.$schema).toBe("./settings.schema.json");
});

test("the schema is rewritten beside the file on every launch", async ({ page }) => {
  await open(page);
  await expect.poll(async () => (await fake(page)).schema).not.toBeNull();

  const { schema } = await fake(page);
  const parsed = JSON.parse(schema!);
  expect(parsed.properties.theme.enum).toEqual(["day", "sepia", "night"]);
  // RANGES is where the bounds come from; the type alone cannot say this.
  expect(parsed.properties.measure.minimum).toBe(52);
  // The two keys that are bookkeeping rather than settings say so.
  expect(parsed.properties.treeWidth.readOnly).toBe(true);
});

test("the file wins a disagreement with the cache", async ({ page }) => {
  await open(page, {
    cache: { theme: "day" },
    file: JSON.stringify({ theme: "night" }),
  });

  // The warm start paints day; the file is canonical, so a beat later it is
  // night — and the cache has been brought into line for the next launch.
  await expect(page.locator("html")).toHaveAttribute("data-theme", "night");
  await expect
    .poll(() =>
      page.evaluate(() => JSON.parse(localStorage.getItem("plans.settings.v1")!).theme),
    )
    .toBe("night");
});

test("an edit made outside arrives without a restart", async ({ page }) => {
  await open(page, { file: JSON.stringify({ theme: "day", watchSeconds: 1 }) });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "day");

  await editOutside(page, JSON.stringify({ theme: "night", watchSeconds: 1 }));

  // This is the moment the feature proves itself — and it is also how the
  // agent in the chat panel changes your settings, with no new tool surface.
  await expect(page.locator("html")).toHaveAttribute("data-theme", "night", {
    timeout: 10_000,
  });
});

test("a file that does not parse keeps the last settings and says so", async ({ page }) => {
  await open(page, { file: JSON.stringify({ theme: "night", watchSeconds: 1 }) });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "night");

  await editOutside(page, '{ "theme": "day", oops');

  await expect(page.locator(".toast")).toContainText("doesn't parse", {
    timeout: 10_000,
  });
  // "You have a typo" is recoverable; "your settings reset" is rage.
  await expect(page.locator("html")).toHaveAttribute("data-theme", "night");
});

test("keys this build does not know survive a save", async ({ page }) => {
  await open(page, {
    file: JSON.stringify({ theme: "day", watchSeconds: 1, futureThing: { a: 1 } }),
  });

  await expect(page.locator("html")).toHaveAttribute("data-theme", "day");

  // Change something through the app, which rewrites the whole file.
  await runCommand(page, "Night");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "night");

  // A file written by a newer build, opened by this one, should not lose what
  // this one has no field for. VS Code keeps them; so do we.
  await expect
    .poll(async () => {
      const { text } = await fake(page);
      return text ? JSON.parse(text) : null;
    })
    .toMatchObject({ theme: "night", futureThing: { a: 1 } });
});

test("both doors to the file open it in the system editor", async ({ page }) => {
  await open(page);

  // The settings page, which is also where the platform-specific path is
  // shown, so "where is my file" has an answer without a document.
  await page.keyboard.press("Meta+,");
  await page.locator(".settings-filter").fill("Settings file");
  await expect(page.locator(".settings-body")).toContainText(
    "/config/plans/settings.json",
  );
  await page.getByRole("button", { name: "Open settings file (JSON)" }).click();
  await expect.poll(async () => (await fake(page)).opened).toBe(1);

  // And the palette, for the hands that never leave the keyboard.
  await runCommand(page, "Open settings file (JSON)");
  await expect.poll(async () => (await fake(page)).opened).toBe(2);
});
