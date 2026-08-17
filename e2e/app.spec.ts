/**
 * What the app must do.
 *
 * These are written against the bugs that actually happened, not against a
 * checklist: opening a file used to save it back rewritten, switching files
 * used to crash the window, and a document could be lost to a stale write.
 * Each of those is one test here.
 */
import { test, expect, type Page } from "@playwright/test";
import { installFakeBackend, type FakeRepo } from "./fake-backend";

const REPOS: FakeRepo[] = [
  {
    path: "/repo/one",
    name: "one",
    branch: "main",
    modified: ["notes/second.md"],
    files: {
      "first.md": "# First\n\n- alpha\n- beta\n\nSome *prose* with a_word_b in it.\n",
      "notes/second.md": "# Second\n\nAnother file.\n",
      "notes/third.md": "# Third\n\nAnd a third.\n",
    },
  },
  {
    path: "/repo/two",
    name: "two",
    branch: "release",
    files: { "readme.md": "# Two\n\nA second repository.\n" },
  },
];

/** Boot the app with the fake backend and the repositories already open. */
async function open(page: Page, repos: FakeRepo[] = REPOS) {
  const faults: string[] = [];
  page.on("pageerror", (e) => faults.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") faults.push(m.text());
  });

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
    [installFakeBackend.toString(), repos] as const,
  );

  await page.goto("/");
  await expect(page.locator(".files")).toBeVisible();
  await expandAll(page);
  return faults;
}

/**
 * Open every repository and folder, so a test can reach any file without
 * arranging the tree first. Repeats because expanding a folder can reveal more.
 */
async function expandAll(page: Page) {
  for (let pass = 0; pass < 6; pass++) {
    const shut = page.locator('.row.repo[aria-expanded="false"], .row.dir[aria-expanded="false"]');
    const n = await shut.count();
    if (n === 0) return;
    for (let i = 0; i < n; i++) {
      const row = shut.nth(0);
      if (await row.isVisible()) await row.click();
    }
  }
}

const fileRow = (page: Page, name: string) =>
  page.locator(".row.file", { hasText: name }).first();

test("shows every open repository, with its branch", async ({ page }) => {
  await open(page);
  await expect(page.locator(".row.repo")).toHaveCount(2);
  await expect(page.locator(".repo-name").first()).toHaveText(/one/i);
  await expect(page.locator(".repo-branch").first()).toHaveText(/main/);
});

test("opening a file does not write it back", async ({ page }) => {
  const faults = await open(page);
  await fileRow(page, "first").click();
  await expect(page.locator(".milkdown")).toContainText("First");

  // Long enough for the 180ms report and the 2s autosave to have fired.
  await page.waitForTimeout(2600);
  const writes = await page.evaluate(() =>
    (window as any).__fake.calls.filter((c: any) => c.cmd === "write_plan"),
  );
  expect(writes, "reading a file is not editing it").toHaveLength(0);
  expect(faults).toEqual([]);
});

test("switching between files keeps working", async ({ page }) => {
  const faults = await open(page);

  for (const name of ["first", "second", "third", "first", "second"]) {
    await fileRow(page, name).click();
    await expect(page.locator(".milkdown")).toContainText(
      name === "first" ? "First" : name === "second" ? "Second" : "Third",
    );
  }

  // The crash this catches was a recursion inside a plugin: it surfaced as
  // "Maximum call stack size exceeded" and blanked the window.
  expect(faults, faults.join("\n")).toEqual([]);
  await expect(page.locator(".fault")).toHaveCount(0);
});

test("typing reaches disk, once, and unchanged elsewhere", async ({ page }) => {
  await open(page);
  await fileRow(page, "third").click();
  await page.locator(".milkdown .ProseMirror").click();
  await page.keyboard.type(" and more");

  await expect
    .poll(async () =>
      page.evaluate(
        () => (window as any).__fake.repos[0].files["notes/third.md"] as string,
      ),
    )
    .toContain("and more");

  const other = await page.evaluate(
    () => (window as any).__fake.repos[0].files["first.md"] as string,
  );
  expect(other, "editing one file must not touch another").toContain("- alpha");
});

test("a file changed underneath an edit asks rather than overwriting", async ({ page }) => {
  await open(page);
  await fileRow(page, "third").click();
  await page.locator(".milkdown .ProseMirror").click();
  await page.keyboard.type("mine");

  // Something else writes the same file before our save lands.
  await page.evaluate(() => {
    (window as any).__fake.repos[0].files["notes/third.md"] = "# Third\n\ntheirs\n";
  });

  await expect(page.locator(".conflict")).toBeVisible({ timeout: 15000 });
  await expect(page.locator(".conflict")).toContainText(/changed on disk/i);
  const onDisk = await page.evaluate(
    () => (window as any).__fake.repos[0].files["notes/third.md"] as string,
  );
  expect(onDisk, "nothing is overwritten until asked").toContain("theirs");
});

test("the palette finds files, and commands by the words people use", async ({ page }) => {
  await open(page);
  await page.keyboard.press("Meta+p");
  await expect(page.locator(".palette")).toBeVisible();

  await page.locator(".palette-input").fill("third");
  await expect(page.locator(".palette-row").first()).toContainText(/third/i);
  await page.keyboard.press("Enter");
  await expect(page.locator(".milkdown")).toContainText("Third");

  // "dark" must reach Night, though the app calls a theme a paper.
  await page.keyboard.press("Meta+p");
  await page.locator(".palette-input").fill(">dark");
  await expect(page.locator(".palette-row").first()).toContainText(/night/i);
  await page.keyboard.press("Enter");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "night");
});

test("tabs follow the files that are open, and close", async ({ page }) => {
  const faults = await open(page);
  await fileRow(page, "first").click();
  await fileRow(page, "second").click();
  await expect(page.locator(".tab")).toHaveCount(2);

  await page.locator(".tab.on .tab-close").click();
  await expect(page.locator(".tab")).toHaveCount(1);
  expect(faults, faults.join("\n")).toEqual([]);
  await expect(page.locator(".milkdown")).toContainText("First");
});

test("the source view shows the file as it is on disk", async ({ page }) => {
  await open(page);
  await fileRow(page, "first").click();
  await page.keyboard.press("Meta+2");
  // Bullets stay "-" and text is not escaped: the round trip is the identity.
  await expect(page.locator(".source")).toContainText("- alpha");
  await expect(page.locator(".source")).toContainText("a_word_b");
});

test("pasting a link over a selection makes the selection a link", async ({ page }) => {
  await open(page);
  await fileRow(page, "third").click();
  const editor = page.locator(".milkdown .ProseMirror");
  await editor.click();

  // Select the word "third" in the heading, then paste a URL over it.
  await page.evaluate(() => {
    const h = document.querySelector(".milkdown .ProseMirror h1");
    const text = h?.firstChild;
    if (!text) throw new Error("no heading to select");
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 5);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  });

  await editor.evaluate((el) => {
    const data = new DataTransfer();
    data.setData("text/plain", "https://looped.sh/docs");
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });

  await expect(editor.locator('a[href="https://looped.sh/docs"]')).toHaveText(/third/i);

  // And the file keeps it as markdown, not as pasted-over text.
  await expect
    .poll(async () =>
      page.evaluate(() => (window as any).__fake.repos[0].files["notes/third.md"] as string),
    )
    .toContain("](https://looped.sh/docs)");
});

test("a file can be renamed, and moved by typing a path", async ({ page }) => {
  await open(page);
  await fileRow(page, "third").click();
  await page.locator(".row.file", { hasText: "third" }).first().click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Rename or move" }).click();

  await page.locator(".name-field, .matter-body").first().fill("notes/moved/fourth.md");
  await page.keyboard.press("Enter");

  await expect
    .poll(async () =>
      page.evaluate(() => Object.keys((window as any).__fake.repos[0].files)),
    )
    .toContain("notes/moved/fourth.md");

  const gone = await page.evaluate(() =>
    Object.keys((window as any).__fake.repos[0].files).includes("notes/third.md"),
  );
  expect(gone, "the old path should not be left behind").toBe(false);
  // The tab follows the file rather than pointing at a path that is gone.
  await expect(page.locator(".tab.on")).toContainText(/fourth/i);
});

test("searching inside files finds a line and opens it", async ({ page }) => {
  await open(page);
  await page.keyboard.press("Meta+p");
  await page.locator(".palette-input").fill("?Another file");
  await expect(page.locator(".palette-row").first()).toContainText(/Another file/i);
  await expect(page.locator(".palette-foot")).toContainText(/inside files/i);
  await page.keyboard.press("Enter");
  await expect(page.locator(".milkdown")).toContainText("Second");
});

test("a pasted image is written into the repository, not inlined", async ({ page }) => {
  await open(page);
  await fileRow(page, "second").click();
  const editor = page.locator(".milkdown .ProseMirror");
  await editor.click();

  await editor.evaluate((el) => {
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const file = new File([png], "shot.png", { type: "image/png" });
    const data = new DataTransfer();
    data.items.add(file);
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });

  // The bytes land in the repository's image folder, not beside the document…
  await expect
    .poll(async () =>
      page.evaluate(() => Object.keys((window as any).__fake.repos[0].files)),
    )
    .toContain("assets/second.png");

  // …and the markdown links to it relatively, climbing out of notes/.
  await expect
    .poll(async () =>
      page.evaluate(() => (window as any).__fake.repos[0].files["notes/second.md"] as string),
    )
    .toContain("../assets/second.png");
});

test("a new folder appears, and holds a file", async ({ page }) => {
  await open(page);
  await page.locator(".row.repo").first().click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "New folder here" }).click();
  await page.locator(".name-field").fill("ideas");
  await page.keyboard.press("Enter");

  // An empty folder is invisible to a tree built from files, so the app has to
  // remember it until it has one.
  await expect(page.locator(".row.dir", { hasText: "ideas" })).toBeVisible();

  await page.locator(".row.dir", { hasText: "ideas" }).click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "New file here" }).click();
  await page.locator(".name-field").fill("First idea");
  await page.keyboard.press("Enter");

  await expect
    .poll(async () =>
      page.evaluate(() => Object.keys((window as any).__fake.repos[0].files)),
    )
    .toContain("ideas/first-idea.md");
});

test("a file can be dragged into a folder", async ({ page }) => {
  await open(page);
  const file = page.locator(".row.file", { hasText: "first" }).first();
  const folder = page.locator(".row.dir", { hasText: "notes" }).first();
  await file.dragTo(folder);

  await expect
    .poll(async () =>
      page.evaluate(() => Object.keys((window as any).__fake.repos[0].files)),
    )
    .toContain("notes/first.md");
});

test("a folder can be dragged into another folder, with everything inside it", async ({
  page,
}) => {
  await open(page);
  // Make a destination, then move notes/ into it.
  await page.locator(".row.repo").first().click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "New folder here" }).click();
  await page.locator(".name-field").fill("archive");
  await page.keyboard.press("Enter");

  const notes = page.locator(".row.dir", { hasText: /^notes\/$/ }).first();
  const archive = page.locator(".row.dir", { hasText: "archive" }).first();
  await notes.dragTo(archive);

  await expect
    .poll(async () =>
      page.evaluate(() => Object.keys((window as any).__fake.repos[0].files)),
    )
    .toContain("archive/notes/second.md");
});

test("a folder cannot be dropped inside itself", async ({ page }) => {
  await open(page);
  const notes = page.locator(".row.dir", { hasText: /^notes\/$/ }).first();
  await notes.dragTo(notes);
  // Still where it was, rather than notes/notes/second.md.
  const files = await page.evaluate(() =>
    Object.keys((window as any).__fake.repos[0].files),
  );
  expect(files).toContain("notes/second.md");
});
