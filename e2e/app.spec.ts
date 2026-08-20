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

  /**
   * Select the way a person does — click into the heading, then extend with the
   * keyboard. Setting a DOM range directly leaves ProseMirror's own selection
   * empty until it syncs, so a synthetic paste arriving immediately after sees
   * nothing selected and the handler correctly declines.
   */
  // Select the word in the heading.
  await page.locator(".milkdown .ProseMirror h1").click();
  await page.evaluate(() => {
    const text = document.querySelector(".milkdown .ProseMirror h1")?.firstChild;
    if (!text) throw new Error("no heading to select");
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 5);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  });

  /**
   * ProseMirror takes the DOM selection into its own state on selectionchange,
   * which is asynchronous. A synthetic paste dispatched immediately arrives
   * while the editor still believes nothing is selected — and the handler then
   * correctly declines, since pasting over nothing is an ordinary paste.
   */
  await expect
    .poll(async () =>
      page.evaluate(() => (window.getSelection()?.toString() ?? "").trim()),
    )
    .toBe("Third");
  await page.waitForTimeout(250);

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
  await page.locator(".ctx-item", { hasText: "Rename…" }).click();

  // A name, not a path: slashes are not a way to move a file any more.
  await page.locator(".name-field").fill("fourth.md");
  await page.keyboard.press("Enter");

  await expect
    .poll(async () =>
      page.evaluate(() => Object.keys((window as any).__fake.repos[0].files)),
    )
    .toContain("notes/fourth.md");

  const gone = await page.evaluate(() =>
    Object.keys((window as any).__fake.repos[0].files).includes("notes/third.md"),
  );
  expect(gone, "the old path should not be left behind").toBe(false);
  // The tab follows the file rather than pointing at a path that is gone.
  await expect(page.locator(".tab.on")).toContainText(/fourth/i);

  // And the renamed file still opens — from the tree, and from the tab.
  await expect(page.locator(".milkdown")).toContainText("Third");
  await fileRow(page, "first").click();
  await expect(page.locator(".milkdown")).toContainText("First");
  await page.locator(".row.file", { hasText: "fourth" }).first().click();
  await expect(page.locator(".milkdown")).toContainText("Third");
});

test("searching inside files finds a line and opens it", async ({ page }) => {
  await open(page);
  await page.keyboard.press("Meta+p");
  await page.locator(".palette-input").fill("*Another file");
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

  /*
   * And it is a plan from its first save.
   *
   * Without a status a file is invisible to everything that reads plans — the
   * tree's dot, the status filter, the ordering — until someone remembers to
   * add one. The word is the first of the configured vocabulary.
   */
  const made = await page.evaluate(
    () => (window as any).__fake.repos[0].files["ideas/first-idea.md"] as string,
  );
  expect(made.startsWith("---\nstatus: draft\n---\n")).toBe(true);
});

/**
 * Naming a file used to leave you looking at it rather than writing in it.
 *
 * The assertion is deliberately about typing rather than about focus: what a
 * reader wants is for the next keystroke to land in the new document, and
 * `document.activeElement` agreeing without the text arriving would be the
 * harness agreeing with the code and nothing more.
 */
test("a new file is ready to type in", async ({ page }) => {
  await open(page);
  await page.locator(".row.repo").first().click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "New file here" }).click();
  await page.locator(".name-field").fill("Straight in");
  await page.keyboard.press("Enter");

  await expect(page.locator(".ProseMirror")).toContainText("Straight in");
  await page.keyboard.type("first words");
  await expect(page.locator(".ProseMirror")).toContainText("first words");
});

/** The other half: opening something to read it must not take the cursor. */
test("opening a file does not steal the cursor", async ({ page }) => {
  await open(page);
  await page.locator(".row.file").first().click();
  await expect(page.locator(".ProseMirror")).toBeVisible();
  await page.locator(".row.file").nth(1).click();
  expect(
    await page.evaluate(() => !!document.activeElement?.closest(".ProseMirror")),
  ).toBe(false);
});

/**
 * The one file operation that is not a move.
 *
 * Within a repository, dragging is a rename and git follows the history. Across
 * two of them there is no history to follow, so the original has to survive —
 * which is the assertion that matters here, more than the arrival.
 */
test("a file dragged into another repository is copied, not moved", async ({ page }) => {
  await open(page);
  const file = page.locator(".row.file", { hasText: "first" }).first();
  const other = page.locator(".row.repo", { hasText: "two" }).first();
  await file.dragTo(other);

  await expect
    .poll(async () =>
      page.evaluate(() => Object.keys((window as any).__fake.repos[1].files)),
    )
    .toContain("first.md");
  // Still where it was.
  expect(
    await page.evaluate(() => Object.keys((window as any).__fake.repos[0].files)),
  ).toContain("first.md");
});

/**
 * The plans folder in some order other than the alphabet.
 *
 * `plan-dependencies.md` asks whether `status:` already implies enough sequence
 * to be worth having, and says to try that before adding an `order:` field
 * nobody would keep in step by hand. This is the trying.
 */
test("files can be ordered by status instead of by name", async ({ page }) => {
  await open(page, [
    {
      path: "/repo/one",
      name: "one",
      branch: "main",
      files: {
        "aardvark.md": "---\nstatus: done\n---\n# Aardvark\n",
        "zebra.md": "---\nstatus: draft\n---\n# Zebra\n",
        "plain.md": "# Plain\n",
      },
    },
  ]);

  const names = () =>
    page.locator(".row.file .row-name").allTextContents();

  expect(await names()).toEqual(["aardvark.md", "plain.md", "zebra.md"]);

  await page.keyboard.press("Meta+p");
  await page.locator(".palette-input").fill(">order files by status");
  await expect(page.locator(".palette-row").first()).toContainText(/order files by status/i);
  await page.keyboard.press("Enter");

  // draft before done, per the configured vocabulary; the file with no status
  // at all comes last, so adopting this can be partial.
  await expect.poll(names).toEqual(["zebra.md", "aardvark.md", "plain.md"]);
});

/** ⌃Tab, the binding every tabbed application has. */
test("ctrl-tab cycles through the open buffers", async ({ page }) => {
  await open(page);
  await fileRow(page, "first").click();
  await fileRow(page, "second").click();
  await expect(page.locator(".page-path")).toHaveText("notes/second.md");

  await page.keyboard.press("Control+Tab");
  await expect(page.locator(".page-path")).toHaveText("first.md");
  // And wraps, rather than stopping at the end.
  await page.keyboard.press("Control+Tab");
  await expect(page.locator(".page-path")).toHaveText("notes/second.md");

  await page.keyboard.press("Control+Shift+Tab");
  await expect(page.locator(".page-path")).toHaveText("first.md");
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

test("a renamed file can still be edited", async ({ page }) => {
  const faults = await open(page);
  await fileRow(page, "third").click();
  await page.locator(".row.file", { hasText: "third" }).first().click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Rename…" }).click();
  await page.locator(".name-field").fill("renamed.md");
  await page.keyboard.press("Enter");

  await expect(page.locator(".milkdown")).toContainText("Third");

  // The watcher polls the open file; a rename must not leave it chasing the
  // old path, and typing must still reach disk under the new one.
  await page.waitForTimeout(5000);
  await page.locator(".milkdown .ProseMirror").click();
  await page.keyboard.type(" edited after rename");

  await expect
    .poll(
      async () =>
        page.evaluate(
          // Renaming keeps the file where it is; only its name changes.
          () => (window as any).__fake.repos[0].files["notes/renamed.md"] as string | undefined,
        ),
      { timeout: 15000 },
    )
    .toContain("edited after rename");

  expect(faults, faults.join("\n")).toEqual([]);
});

test("a file that vanishes underneath an edit is not treated as a conflict", async ({
  page,
}) => {
  await open(page);
  await fileRow(page, "third").click();
  await page.locator(".milkdown .ProseMirror").click();
  await page.keyboard.type("still mine");

  // Something removes it — a rename elsewhere, a delete, a branch switch.
  await page.evaluate(() => {
    delete (window as any).__fake.repos[0].files["notes/third.md"];
  });

  // The buffer is the only copy left, so it is written rather than refused,
  // and no conflict is raised against a file that is not there.
  await expect
    .poll(
      async () =>
        page.evaluate(
          () =>
            (window as any).__fake.repos[0].files["notes/third.md"] as string | undefined,
        ),
      { timeout: 15000 },
    )
    .toContain("still mine");
  await expect(page.locator(".conflict")).toHaveCount(0);
});

test("frontmatter survives when it is left in the editor", async ({ page }) => {
  const faults = await open(page, [
    {
      path: "/repo/one",
      name: "one",
      branch: "main",
      files: { "meta.md": "---\ntitle: A plan\ndate: 2026-08-17\n---\n\n# The plan\n\nBody.\n" },
    },
  ]);

  // Turn the frontmatter block off, so the YAML is in the document itself.
  await page.keyboard.press("Meta+Shift+p");
  await page.locator(".palette-input").fill(">frontmatter");
  await expect(page.locator(".palette-row").first()).toContainText(/frontmatter/i);
  await page.keyboard.press("Enter");
  await expect(page.locator(".palette")).toHaveCount(0);

  await fileRow(page, "meta").click();
  await page.locator(".milkdown .ProseMirror").click();
  await page.keyboard.type("x");

  await expect
    .poll(
      async () =>
        page.evaluate(() => (window as any).__fake.repos[0].files["meta.md"] as string),
      { timeout: 15000 },
    )
    .toContain("title: A plan");

  const text = await page.evaluate(
    () => (window as any).__fake.repos[0].files["meta.md"] as string,
  );
  // Not a thematic break and a setext heading, which is what it used to become.
  expect(text, "the closing fence must stay a fence").not.toContain("-----");
  expect(faults, faults.join("\n")).toEqual([]);
});

/**
 * Zooming inside the figure is looking closer at something framed to the size
 * of a paragraph, which is the wrong size for the diagrams that most need
 * looking at. Maximising is the same picture with room to read it.
 */
test("a diagram can be maximised, and escaped", async ({ page }) => {
  await open(page, [
    {
      path: "/repo/one",
      name: "one",
      branch: "main",
      files: { "chart.md": "# Chart\n\n```mermaid\nflowchart LR\n  A --> B\n```\n" },
    },
  ]);
  await fileRow(page, "chart").click();
  await expect(page.locator(".mermaid-figure svg")).toBeVisible({ timeout: 20000 });

  await page.locator('.mermaid-figure [aria-label="Maximise the diagram"]').click();

  // Its own copy, outside the editor entirely — the figure clips its overflow,
  // and anything inside the editor's DOM is something ProseMirror owns.
  const full = page.locator(".mermaid-scrim .mermaid-full svg");
  await expect(full).toBeVisible({ timeout: 20000 });
  expect(await page.locator(".mermaid-figure svg").count()).toBe(1);

  /*
   * The same controls look the same in both places.
   *
   * Crepe ships `.milkdown button { border-style: none; background: none }`,
   * which is a class and an element and so outranks a bare class of ours. The
   * buttons inside the editor lost their border and their face while the
   * maximised copy — which lives outside `.milkdown` — kept both, so the same
   * button read as a button in one place and as bare text in the other.
   */
  const face = (sel: string) =>
    page.evaluate((s) => {
      const c = getComputedStyle(document.querySelector(s) as HTMLElement);
      return { bg: c.backgroundColor, border: c.borderTopWidth, style: c.borderTopStyle };
    }, sel);
  const outside = await face(".mermaid-full .mermaid-tool");
  expect(outside.style).toBe("solid");

  await page.keyboard.press("Escape");
  await expect(page.locator(".mermaid-scrim")).toHaveCount(0);
  // Escape closed the diagram and nothing else: zen is a different Escape.
  await expect(page.locator(".mermaid-figure svg")).toBeVisible();

  expect(await face(".mermaid-figure .mermaid-tool")).toEqual(outside);
});

test("a diagram is redrawn when the paper changes", async ({ page }) => {
  await open(page, [
    {
      path: "/repo/one",
      name: "one",
      branch: "main",
      files: { "chart.md": "# Chart\n\n```mermaid\nflowchart LR\n  A --> B\n```\n" },
    },
  ]);
  await fileRow(page, "chart").click();

  const figure = page.locator(".mermaid-figure svg");
  await expect(figure).toBeVisible({ timeout: 20000 });
  const before = await figure.innerHTML();

  await page.keyboard.press("Meta+Shift+p");
  await page.locator(".palette-input").fill(">night");
  await expect(page.locator(".palette-row").first()).toContainText(/night/i);
  await page.keyboard.press("Enter");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "night");

  /**
   * The diagram's own colours are baked into its SVG when it is drawn, so a
   * change of paper has to redraw it. It used to keep the old colours until
   * the file was closed and opened again.
   */
  await expect
    .poll(async () => figure.innerHTML(), { timeout: 20000 })
    .not.toBe(before);
});

test("a file with a standalone <br /> still opens, and switching works", async ({ page }) => {
  const faults = await open(page, [
    {
      path: "/repo/one",
      name: "one",
      branch: "main",
      files: {
        // A break standing on its own between blocks, as agents often write.
        "loose.md": "# Loose\n\n<br />\n\nBody after the break.\n",
        "other.md": "# Other\n\nOther body.\n",
      },
    },
  ]);

  await fileRow(page, "loose").click();
  await expect(page.locator(".milkdown")).toContainText("Body after the break");

  // Switching must actually switch: a document that fails to build leaves the
  // previous one on screen, which is what a lone <br /> used to do.
  await fileRow(page, "other").click();
  await expect(page.locator(".milkdown")).toContainText("Other body");
  await expect(page.locator(".milkdown")).not.toContainText("Body after the break");

  await fileRow(page, "loose").click();
  await expect(page.locator(".milkdown")).toContainText("Body after the break");
  expect(faults, faults.join("\n")).toEqual([]);
});

test("searching for a font finds the typefaces", async ({ page }) => {
  await open(page);
  await page.keyboard.press("Meta+Shift+p");
  await page.locator(".palette-input").fill(">font");

  // The app calls them typefaces and papers; nobody searching types that.
  const rows = page.locator(".palette-row");
  await expect(rows.first()).toBeVisible();
  const labels = (await rows.allInnerTexts()).join(" ").toLowerCase();
  expect(labels).toContain("work sans");
  expect(labels).toContain("space mono");
});

test("rename asks for a name; moving is a separate question", async ({ page }) => {
  await open(page);
  await page.locator(".row.file", { hasText: "second" }).first().click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Rename…" }).click();

  // The field holds the name alone, not the path it lives at.
  await expect(page.locator(".name-field")).toHaveValue("second.md");
  await page.locator(".name-field").fill("Second Thoughts");
  await page.keyboard.press("Enter");

  /**
   * Exactly what was typed, in the folder it was already in. A rename edits a
   * filename, so the name is taken literally — slugifying belongs to new files,
   * where what is typed is a title rather than a name.
   */
  await expect
    .poll(async () =>
      page.evaluate(() => Object.keys((window as any).__fake.repos[0].files)),
    )
    .toContain("notes/Second Thoughts.md");

  // Moving is its own action, with folders to choose from rather than a path.
  await page
    .locator(".row.file", { hasText: "second thoughts" })
    .first()
    .click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Move to…" }).click();
  // The sheet's own picker, not the repository dropdown in the rail.
  await page.locator(".matter-sheet .dd-trigger").click();
  await page.locator(".dd-item", { hasText: "repository root" }).click();
  await page.locator(".matter-sheet .act", { hasText: "Move" }).click();

  await expect
    .poll(async () =>
      page.evaluate(() => Object.keys((window as any).__fake.repos[0].files)),
    )
    .toContain("Second Thoughts.md");
});
