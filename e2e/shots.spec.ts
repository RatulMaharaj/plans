/**
 * The pictures in the README and on the site, taken from the running app.
 *
 * A drawing of the app goes stale the moment the app changes, and it flatters:
 * every detail is whatever the drawer felt like. These are the real frontend,
 * in a real browser, with the Rust boundary faked the same way the tests fake
 * it — so what the picture shows is what the app does.
 *
 * Skipped unless SHOTS=1, so `pnpm test` stays about behaviour: `pnpm shots`.
 */
import { test, expect, type Page } from "@playwright/test";
import { installFakeBackend, type FakeRepo } from "./fake-backend";

test.skip(!process.env.SHOTS, "run with `pnpm shots`");

/**
 * A repository that looks like the ones this app is for: plans and notes an
 * agent wrote, one of them edited since the last commit.
 */
const REPOS: FakeRepo[] = [
  {
    path: "/repo/plans",
    name: "plans",
    branch: "main",
    modified: ["plans/1_what_this_is_for.md"],
    files: {
      "README.md": "# Looped Plans\n\nA small desktop app for the markdown in your repositories.\n",
      "BUGS.md": "# Bugs\n\n- The diff scrolls to the top when a hunk is staged.\n",
      "plans/4_updater.md": "# The updater\n\nCheck on launch, ask before replacing.\n",
      "plans/1_what_this_is_for.md": `# Everything markdown, across every repository

These files were written by an agent in a terminal. This app is the part
where a person reads them: **one tree over every repository you keep open**,
each page rendered as a page, and the file on disk as the only buffer.

> Nothing is locked and nothing is lost. Every save is checked against the
> version you opened, so an edit made elsewhere is caught, never clobbered.

| Press | What you get                        |
| ----- | ----------------------------------- |
| \`⌘1\`  | the page, as a reader would see it  |
| \`⌘2\`  | the raw markdown, exactly as stored |

\`\`\`sh
# Both are the same buffer, and both are editable.
git commit -m "..."   # or ⌘⏎ in the git panel, without leaving
\`\`\`
`,
    },
  },
  {
    path: "/repo/notes",
    name: "notes",
    branch: "main",
    files: {
      "inbox.md": "# Inbox\n\n- Read the Tauri updater docs\n",
      "reading.md": "# Reading\n\n- *The Mythical Man-Month*\n",
    },
  },
];

/** Boot the app with a paper chosen, the tree open, and one file on screen. */
async function shoot(page: Page, theme: "day" | "sepia" | "night", file: string) {
  await page.addInitScript(
    ([fn, list, id]) => {
      new Function(`return ${fn}`)()(list);
      localStorage.setItem(
        "plans.repos.v1",
        JSON.stringify((list as FakeRepo[]).map((r) => r.path)),
      );
      localStorage.setItem("plans.tabs.v1", "[]");
      localStorage.setItem(
        "plans.settings.v1",
        JSON.stringify({ theme: id, watchSeconds: 0, size: 17 }),
      );
    },
    [installFakeBackend.toString(), REPOS, theme] as const,
  );

  await page.setViewportSize({ width: 1180, height: 780 });
  await page.goto("/");
  await expect(page.locator(".files")).toBeVisible();

  // Open every repository and folder, so the file below can be clicked.
  for (let pass = 0; pass < 6; pass++) {
    const shut = page.locator('.row.repo[aria-expanded="false"], .row.dir[aria-expanded="false"]');
    if ((await shut.count()) === 0) break;
    for (let i = await shut.count(); i > 0; i--) {
      const row = shut.nth(0);
      if (await row.isVisible()) await row.click();
    }
  }

  await page.locator(".row.file", { hasText: file }).first().click();
  await expect(page.locator(".milkdown")).toBeVisible();
  // Let the editor settle and drop the caret, so no cursor blinks in the shot.
  await page.locator(".rail").first().click();
  await page.waitForTimeout(700);

  /**
   * A window, not a viewport. The picture sits on a README as well as on the
   * site, and a README cannot draw a frame around it — so the frame is taken
   * with the shot, in the app's own rule colour.
   *
   * Drawn as an overlay rather than a border on the app: the rail and the
   * tree paint their own backgrounds over anything the root element draws.
   *
   * Square, not rounded: rounding would need a transparent ground, and the
   * app's chrome is translucent, so the whole thing goes milky once the page
   * behind it is taken away.
   */
  await page.addStyleTag({
    content: `body::after {
        content: "";
        position: fixed;
        inset: 0;
        border: 1px solid var(--rule-strong);
        pointer-events: none;
        z-index: 9999;
      }`,
  });

  await page.screenshot({ path: `site/plans-${theme}.png`, scale: "css" });
}

test("day", async ({ page }) => shoot(page, "day", "1_what_this_is_for.md"));
test("sepia", async ({ page }) => shoot(page, "sepia", "1_what_this_is_for.md"));
test("night", async ({ page }) => shoot(page, "night", "1_what_this_is_for.md"));
