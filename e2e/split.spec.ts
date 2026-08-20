import { test, expect, type Page } from "@playwright/test";
import { installFakeBackend, type FakeRepo } from "./fake-backend";

const REPOS: FakeRepo[] = [
  {
    path: "/repo/plans",
    name: "plans",
    branch: "main",
    files: {
      "a.md": "---\nstatus: ready\n---\n# A\n\npara one\n",
      "b.md": "# B\n\npara two\n",
      "c.md": "# C\n\npara three\n",
    },
  },
];

async function boot(page: Page) {
  await page.addInitScript(
    ([fn, list]) => {
      // eslint-disable-next-line no-new-func
      new Function(`return ${fn}`)()(list);
      localStorage.setItem(
        "plans.repos.v1",
        JSON.stringify((list as FakeRepo[]).map((r) => r.path)),
      );
      localStorage.setItem("plans.tabs.v1", "[]");
      localStorage.setItem("plans.split.v1", "null");
      localStorage.setItem("plans.splitTabs.v1", "[]");
    },
    [installFakeBackend.toString(), REPOS] as const,
  );
  await page.goto("/");
  await expect(page.locator(".files")).toBeVisible();
}

/** Pointer-drag from a source locator into the split drop zone. */
async function dragToSplit(page: Page, source: ReturnType<Page["locator"]>) {
  const from = (await source.boundingBox())!;
  const zone = (await page.locator(".page-body").boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 60, from.y + 30, { steps: 3 });
  await page.mouse.move(zone.x + zone.width - 40, zone.y + zone.height / 2, { steps: 5 });
  // Before a split exists the dashed strip is the target; once one is open
  // the pane itself is, and the strip stays away — no third pane implied.
  if ((await page.locator(".split-pane").count()) === 0) {
    await expect(page.locator(".split-drop")).toBeVisible();
  } else {
    await expect(page.locator(".split-drop")).toHaveCount(0);
  }
  await page.mouse.up();
}

const splitTabOn = (page: Page) => page.locator(".split-pane .tab.on .tab-name");
const mainTabs = (page: Page) => page.locator('[data-strip="main"] .tab');

test("dragging a file onto the page edge opens it in the split", async ({ page }) => {
  await boot(page);
  await page.locator(".row.file", { hasText: "b" }).first().click();
  await expect(page.locator(".editor-host .ProseMirror").first()).toBeVisible();

  await dragToSplit(page, page.locator(".row.file", { hasText: "a" }).first());
  await expect(page.locator(".split-pane")).toBeVisible();
  await expect(splitTabOn(page)).toHaveText(/a/);
  // The split shows its file's frontmatter, as the main header does.
  await expect(page.locator(".split-pane .status-badge")).toHaveText("ready");

  // A drop on the open split retargets it, and both tabs stay in its strip.
  await dragToSplit(page, page.locator(".row.file", { hasText: "c" }).first());
  await expect(splitTabOn(page)).toHaveText(/c/);
  await expect(page.locator(".split-pane .tab")).toHaveCount(2);

  // Closing the split's tabs closes the pane with the last one.
  await page.locator(".split-pane .tab-close").last().click();
  await expect(splitTabOn(page)).toHaveText(/a/);
  await page.locator(".split-pane .tab-close").click();
  await expect(page.locator(".split-pane")).toHaveCount(0);
});

test("moving the open document to the side lets the next tab fill in", async ({ page }) => {
  await boot(page);
  await page.locator(".row.file", { hasText: "a" }).first().click();
  await page.locator(".row.file", { hasText: "b" }).first().click();
  await expect(mainTabs(page)).toHaveCount(2);

  // b is the open document; dragging its tab to the side MOVES it.
  await dragToSplit(page, page.locator('[data-strip="main"] .tab-name', { hasText: "b" }));
  await expect(splitTabOn(page)).toHaveText(/b/);
  await expect(mainTabs(page)).toHaveCount(1);
  // The next tab filled the main pane.
  await expect(page.locator(".main-pane .tab.on .tab-name")).toHaveText(/a/);

  // Moving the last one out leaves the empty state, not a stranded buffer.
  await dragToSplit(page, page.locator('[data-strip="main"] .tab-name', { hasText: "a" }));
  await expect(mainTabs(page)).toHaveCount(0);
  await expect(page.locator(".main-pane .blank")).toBeVisible();
  await expect(page.locator(".split-pane .tab")).toHaveCount(2);
});

test("tabs reorder fluidly within a strip", async ({ page }) => {
  await boot(page);
  for (const n of ["a", "b", "c"]) {
    await page.locator(".row.file", { hasText: n }).first().click();
  }
  await expect(mainTabs(page)).toHaveCount(3);

  // Drag the first tab past the last: a b c -> b c a.
  const first = (await page.locator('[data-strip="main"] .tab-name', { hasText: "a" }).boundingBox())!;
  const last = (await page.locator('[data-strip="main"] .tab-name', { hasText: "c" }).boundingBox())!;
  await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2);
  await page.mouse.down();
  await page.mouse.move(first.x + 40, first.y + 3, { steps: 3 });
  await page.mouse.move(last.x + last.width - 2, last.y + last.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect(mainTabs(page).first()).toHaveText(/b/);
  await expect(mainTabs(page).last()).toHaveText(/a/);
});

test("the split has no close button; the palette closes it", async ({ page }) => {
  await boot(page);
  await page.locator(".row.file", { hasText: "b" }).first().click();
  await dragToSplit(page, page.locator(".row.file", { hasText: "a" }).first());
  await expect(page.locator(".split-pane")).toBeVisible();

  // A Frontmatter button where the ✕ used to be — a.md has a block to edit.
  await expect(page.locator(".split-pane .page-head button", { hasText: "Frontmatter" })).toBeVisible();
  await expect(page.locator(".split-pane .page-head")).not.toContainText("✕");

  await page.keyboard.press("Meta+Shift+p");
  await page.locator(".palette-input").fill(">close the split");
  await page.keyboard.press("Enter");
  await expect(page.locator(".split-pane")).toHaveCount(0);
});

test("swapping the panes trades the whole tab sets", async ({ page }) => {
  await boot(page);
  await page.locator(".row.file", { hasText: "a" }).first().click();
  await page.locator(".row.file", { hasText: "b" }).first().click();
  await dragToSplit(page, page.locator(".row.file", { hasText: "c" }).first());
  await expect(splitTabOn(page)).toHaveText(/c/);
  await expect(mainTabs(page)).toHaveCount(2);

  await page.keyboard.press("Meta+Shift+p");
  await page.locator(".palette-input").fill(">swap the panes");
  await page.keyboard.press("Enter");

  // c crossed to the main strip; a and b are the split's set now.
  await expect(mainTabs(page)).toHaveCount(1);
  await expect(page.locator(".main-pane .tab.on .tab-name")).toHaveText(/c/);
  await expect(page.locator(".split-pane .tab")).toHaveCount(2);
  await expect(splitTabOn(page)).toHaveText(/b/);
});

test("a tab drags between the two strips", async ({ page }) => {
  await boot(page);
  await page.locator(".row.file", { hasText: "a" }).first().click();
  await page.locator(".row.file", { hasText: "b" }).first().click();
  await dragToSplit(page, page.locator(".row.file", { hasText: "c" }).first());

  // Main strip -> split strip, by dropping on the strip itself.
  const from = (await page.locator('[data-strip="main"] .tab-name', { hasText: "a" }).boundingBox())!;
  const to = (await page.locator('[data-strip="split"]').boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 40, from.y + 20, { steps: 3 });
  await page.mouse.move(to.x + to.width - 10, to.y + to.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect(page.locator(".split-pane .tab")).toHaveCount(2);
  await expect(mainTabs(page)).toHaveCount(1);

  // And back again.
  const back = (await page.locator('[data-strip="split"] .tab-name', { hasText: "a" }).boundingBox())!;
  const main = (await page.locator('[data-strip="main"]').boundingBox())!;
  await page.mouse.move(back.x + back.width / 2, back.y + back.height / 2);
  await page.mouse.down();
  await page.mouse.move(back.x - 40, back.y + 20, { steps: 3 });
  await page.mouse.move(main.x + main.width - 10, main.y + main.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect(mainTabs(page)).toHaveCount(2);
  await expect(page.locator(".split-pane .tab")).toHaveCount(1);
});

test("the same document can be open in both panes", async ({ page }) => {
  await boot(page);
  await page.locator(".row.file", { hasText: "a" }).first().click();
  await page.keyboard.press("Meta+Shift+p");
  await page.locator(".palette-input").fill(">both panes");
  await page.keyboard.press("Enter");

  await expect(page.locator(".split-pane")).toBeVisible();
  await expect(splitTabOn(page)).toHaveText(/a/);
  await expect(page.locator(".main-pane .tab.on .tab-name")).toHaveText(/a/);
  // Two live views of one file.
  await expect(page.locator(".main-pane .editor-host .ProseMirror")).toContainText("para one");
  await expect(page.locator(".split-pane .editor-host .ProseMirror")).toContainText("para one");
});

test("the one view switch drives the focused pane", async ({ page }) => {
  await boot(page);
  await page.locator(".row.file", { hasText: "b" }).first().click();
  await dragToSplit(page, page.locator(".row.file", { hasText: "a" }).first());
  await expect(page.locator(".split-pane")).toBeVisible();

  // Split has focus after the drop: no Diff offered, Source acts on the split.
  await expect(page.locator(".view-switch button", { hasText: "Diff" })).toHaveCount(0);
  await page.locator(".view-switch button", { hasText: "Source" }).click();
  await expect(page.locator(".split-pane .source")).toBeVisible();

  // Focus the main pane: Diff returns, and its view is untouched.
  await page.locator(".main-pane .editor-host").first().click();
  await expect(page.locator(".view-switch button", { hasText: "Diff" })).toHaveCount(1);
  await expect(page.locator(".main-pane .editor-host .ProseMirror")).toBeVisible();
});
