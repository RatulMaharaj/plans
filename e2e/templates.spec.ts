/**
 * Making a file that is not a plan.
 *
 * The app used to know exactly one shape of new file, built in Rust. The shape
 * now comes from a markdown file in `~/.plans/templates/`, so what is worth
 * testing is the chain: what the folder holds becomes what the palette and the
 * tree offer, and what a template says becomes the bytes on disk.
 */
import { test, expect, type Page } from "@playwright/test";
import { installFakeBackend, type FakeRepo, type FakeTemplate } from "./fake-backend";

const REPOS: FakeRepo[] = [
  {
    path: "/repo/one",
    name: "one",
    branch: "main",
    files: { "first.md": "# First\n\nSome prose.\n" },
  },
];

async function open(page: Page, templates?: FakeTemplate[], repos: FakeRepo[] = REPOS) {
  await page.addInitScript(
    ([fn, list, tpl]) => {
      // eslint-disable-next-line no-new-func
      new Function(`return ${fn}`)()(list, undefined, tpl ?? undefined);
      localStorage.setItem(
        "plans.repos.v1",
        JSON.stringify((list as FakeRepo[]).map((r) => r.path)),
      );
      localStorage.setItem("plans.tabs.v1", "[]");
    },
    [installFakeBackend.toString(), repos, templates ?? null] as const,
  );

  await page.goto("/");
  await expect(page.locator(".files")).toBeVisible();
}

/** What the shipped daily-note pattern comes to today. */
function todaysNote() {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.md`;
}

const mod = process.platform === "darwin" ? "Meta" : "Control";

/** The palette, in command mode, running one command by name. */
async function command(page: Page, query: string, label = query) {
  await page.keyboard.press(`${mod}+Shift+P`);
  await page.locator(".palette-input").fill(`>${query}`);
  await page.locator(".palette-row", { hasText: label }).first().click();
}

const files = (page: Page) =>
  page.evaluate(() => (window as any).__fake.repos[0].files as Record<string, string>);

/**
 * The shipped plan template has to reproduce, byte for byte, what the hardcoded
 * scaffold used to write — otherwise this whole change is a behaviour change
 * wearing a refactor's clothes.
 */
test("the plan template writes what the backend used to write", async ({ page }) => {
  await open(page);
  await page.keyboard.press(`${mod}+n`);
  await page.locator(".name-field").fill("A Fresh Plan");
  await page.keyboard.press("Enter");

  await expect.poll(async () => Object.keys(await files(page))).toContain("a-fresh-plan.md");
  expect((await files(page))["a-fresh-plan.md"]).toBe("---\nstatus: draft\n---\n# A Fresh Plan\n\n");
});

/**
 * A filename the calendar answers needs no sheet, which is the whole point of
 * a daily note — and running it twice is the same day twice, so the second one
 * opens the note rather than refusing to overwrite it.
 */
test("a daily note is one keystroke, with no sheet in the way", async ({ page }) => {
  await open(page);
  await command(page, "Daily Note", "New: Daily Note");

  await expect.poll(async () => Object.keys(await files(page))).toContain(todaysNote());
  // No frontmatter, no heading: the template's body is empty, so the file is.
  expect((await files(page))[todaysNote()]).toBe("");
  await expect(page.locator(".name-field")).toHaveCount(0);
});

/**
 * The one behaviour a date-named file needs that a titled one does not: today's
 * note already existing is not a collision, it is today's note.
 */
test("asking again for today's note opens the one already there", async ({ page }) => {
  const name = todaysNote();
  await open(page, undefined, [
    {
      path: "/repo/one",
      name: "one",
      branch: "main",
      files: { "first.md": "# First\n", [name]: "what happened today\n" },
    },
  ]);

  await command(page, "Daily Note", "New: Daily Note");
  await expect(page.locator(".milkdown")).toContainText("what happened today");
  expect((await files(page))[name]).toBe("what happened today\n");
});

/** A template the reader wrote is a template the app offers. */
test("a template in the folder becomes a command and a file", async ({ page }) => {
  await open(page, [
    {
      name: "bug.md",
      text: [
        "---",
        "name: Bug Report",
        'fileName: "bug-{slug}.md"',
        "frontmatter:",
        '  status: "{firstStatus}"',
        "  kind: bug",
        "---",
        "# {title}",
        "",
        "## What happened",
      ].join("\n"),
    },
  ]);

  await command(page, "Bug Report", "New: Bug Report");
  await page.locator(".name-field").fill("Tabs Vanish");
  await page.keyboard.press("Enter");

  await expect.poll(async () => Object.keys(await files(page))).toContain("bug-tabs-vanish.md");
  expect((await files(page))["bug-tabs-vanish.md"]).toBe(
    "---\nstatus: draft\nkind: bug\n---\n# Tabs Vanish\n\n## What happened\n\n",
  );
});

/** More than one template turns the tree's one item into a question. */
test("the tree offers the templates it has", async ({ page }) => {
  await open(page);
  await page.locator(".row.repo").first().click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "New file here" }).click();
  await expect(page.locator(".ctx-item.ctx-sub")).toHaveText(["Plan", "Daily Note"]);

  await page.locator(".ctx-item.ctx-sub", { hasText: "Daily Note" }).click();
  await expect(page.locator(".name-field")).toHaveCount(0);
  await expect.poll(async () => Object.keys(await files(page))).toHaveLength(2);
});

/** Settings does not edit templates; it says where they are. */
test("settings names the templates folder and opens it", async ({ page }) => {
  await open(page);
  await page.keyboard.press(`${mod}+,`);
  const row = page.locator(".setting-row", { hasText: "New file templates" });
  await expect(row).toContainText("/home/test/.plans/templates");
  await expect(row).toContainText("Plan, Daily Note");

  await row.getByRole("button", { name: "Open folder" }).click();
  await expect
    .poll(async () => page.evaluate(() => (window as any).__fake.templatesOpened))
    .toBe(1);
});
