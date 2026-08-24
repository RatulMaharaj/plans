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
    modified: ["a-plan.md", "util.ts"],
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

test("the source of a non-markdown file is editable, and saves as typed", async ({ page }) => {
  await boot(page, { showAllFiles: true, autosave: "afterDelay", autosaveDelay: 0.05 });
  await fileRow(page, "util.ts").click();
  const src = page.locator(".surface:not(.aside) .cm-content");
  await expect(src).toContainText("export const answer");

  await src.click();
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.type("export const question = () => 6 * 7;\n");
  // The buffer reached disk unchanged — no markdown round trip in the way.
  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          (window as any).__fake.repos.find((r: any) => r.path === "/repo/plans")
            .files["util.ts"],
      ),
    )
    .toContain("export const question");
});

test("the palette search scope toggles between markdown and every file", async ({ page }) => {
  await boot(page);
  await page.keyboard.press("Meta+p");

  // File names: markdown by default, with the switch on show in the footer.
  await expect(page.locator(".palette-scope")).toHaveText(/markdown/i);
  await page.locator(".palette-input").fill("util");
  await expect(page.locator(".palette-empty")).toBeVisible();

  await page.locator(".palette-scope").click();
  await expect(page.locator(".palette-scope")).toHaveText(/all files/i);
  await expect(page.locator(".palette-row").first()).toContainText(/util\.ts/i);

  // Inside files: the same switch governs which files are read.
  await page.locator(".palette-scope").click();
  await page.locator(".palette-input").fill("*answer");
  await expect(page.locator(".palette-empty")).toContainText(/nothing matches/i);
  await page.locator(".palette-scope").click();
  await expect(page.locator(".palette-row").first()).toContainText(/answer/i);
});

test("the git panel lists every changed file, whatever the tree shows", async ({ page }) => {
  // The tree is still markdown-only here; the panel reports the repository.
  await boot(page, { showGit: true });
  await expect(page.locator(".git")).toBeVisible();
  await expect(page.locator(".git")).toContainText("a-plan.md");
  await expect(page.locator(".git")).toContainText("util.ts");
});
