# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: app.spec.ts >> a new file is ready to type in
- Location: e2e/app.spec.ts:360:1

# Error details

```
Error: expect(locator).toContainText(expected) failed

Locator: locator('.ProseMirror')
Expected substring: "first words"
Received string:    "Straight in"
Timeout: 10000ms

Call log:
  - Expect "toContainText" with timeout 10000ms
  - waiting for locator('.ProseMirror')
    3 × locator resolved to <div translate="no" role="textbox" contenteditable="true" class="ProseMirror virtual-cursor-enabled editor">…</div>
      - unexpected value "Straight in"
    21 × locator resolved to <div translate="no" role="textbox" contenteditable="true" class="ProseMirror virtual-cursor-enabled editor ProseMirror-focused">…</div>
       - unexpected value "Straight in"

```

```yaml
- textbox:
  - heading "Straight in" [level=1]
```

# Test source

```ts
  269 | 
  270 |   // And the renamed file still opens — from the tree, and from the tab.
  271 |   await expect(page.locator(".milkdown")).toContainText("Third");
  272 |   await fileRow(page, "first").click();
  273 |   await expect(page.locator(".milkdown")).toContainText("First");
  274 |   await page.locator(".row.file", { hasText: "fourth" }).first().click();
  275 |   await expect(page.locator(".milkdown")).toContainText("Third");
  276 | });
  277 | 
  278 | test("searching inside files finds a line and opens it", async ({ page }) => {
  279 |   await open(page);
  280 |   await page.keyboard.press("Meta+p");
  281 |   await page.locator(".palette-input").fill("*Another file");
  282 |   await expect(page.locator(".palette-row").first()).toContainText(/Another file/i);
  283 |   await expect(page.locator(".palette-foot")).toContainText(/inside files/i);
  284 |   await page.keyboard.press("Enter");
  285 |   await expect(page.locator(".milkdown")).toContainText("Second");
  286 | });
  287 | 
  288 | test("a pasted image is written into the repository, not inlined", async ({ page }) => {
  289 |   await open(page);
  290 |   await fileRow(page, "second").click();
  291 |   const editor = page.locator(".milkdown .ProseMirror");
  292 |   await editor.click();
  293 | 
  294 |   await editor.evaluate((el) => {
  295 |     const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  296 |     const file = new File([png], "shot.png", { type: "image/png" });
  297 |     const data = new DataTransfer();
  298 |     data.items.add(file);
  299 |     el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  300 |   });
  301 | 
  302 |   // The bytes land in the repository's image folder, not beside the document…
  303 |   await expect
  304 |     .poll(async () =>
  305 |       page.evaluate(() => Object.keys((window as any).__fake.repos[0].files)),
  306 |     )
  307 |     .toContain("assets/second.png");
  308 | 
  309 |   // …and the markdown links to it relatively, climbing out of notes/.
  310 |   await expect
  311 |     .poll(async () =>
  312 |       page.evaluate(() => (window as any).__fake.repos[0].files["notes/second.md"] as string),
  313 |     )
  314 |     .toContain("../assets/second.png");
  315 | });
  316 | 
  317 | test("a new folder appears, and holds a file", async ({ page }) => {
  318 |   await open(page);
  319 |   await page.locator(".row.repo").first().click({ button: "right" });
  320 |   await page.locator(".ctx-item", { hasText: "New folder here" }).click();
  321 |   await page.locator(".name-field").fill("ideas");
  322 |   await page.keyboard.press("Enter");
  323 | 
  324 |   // An empty folder is invisible to a tree built from files, so the app has to
  325 |   // remember it until it has one.
  326 |   await expect(page.locator(".row.dir", { hasText: "ideas" })).toBeVisible();
  327 | 
  328 |   await page.locator(".row.dir", { hasText: "ideas" }).click({ button: "right" });
  329 |   await page.locator(".ctx-item", { hasText: "New file here" }).click();
  330 |   await page.locator(".name-field").fill("First idea");
  331 |   await page.keyboard.press("Enter");
  332 | 
  333 |   await expect
  334 |     .poll(async () =>
  335 |       page.evaluate(() => Object.keys((window as any).__fake.repos[0].files)),
  336 |     )
  337 |     .toContain("ideas/first-idea.md");
  338 | 
  339 |   /*
  340 |    * And it is a plan from its first save.
  341 |    *
  342 |    * Without a status a file is invisible to everything that reads plans — the
  343 |    * tree's dot, the status filter, the ordering — until someone remembers to
  344 |    * add one. The word is the first of the configured vocabulary.
  345 |    */
  346 |   const made = await page.evaluate(
  347 |     () => (window as any).__fake.repos[0].files["ideas/first-idea.md"] as string,
  348 |   );
  349 |   expect(made.startsWith("---\nstatus: draft\n---\n")).toBe(true);
  350 | });
  351 | 
  352 | /**
  353 |  * Naming a file used to leave you looking at it rather than writing in it.
  354 |  *
  355 |  * The assertion is deliberately about typing rather than about focus: what a
  356 |  * reader wants is for the next keystroke to land in the new document, and
  357 |  * `document.activeElement` agreeing without the text arriving would be the
  358 |  * harness agreeing with the code and nothing more.
  359 |  */
  360 | test("a new file is ready to type in", async ({ page }) => {
  361 |   await open(page);
  362 |   await page.locator(".row.repo").first().click({ button: "right" });
  363 |   await page.locator(".ctx-item", { hasText: "New file here" }).click();
  364 |   await page.locator(".name-field").fill("Straight in");
  365 |   await page.keyboard.press("Enter");
  366 | 
  367 |   await expect(page.locator(".ProseMirror")).toContainText("Straight in");
  368 |   await page.keyboard.type("first words");
> 369 |   await expect(page.locator(".ProseMirror")).toContainText("first words");
      |                                              ^ Error: expect(locator).toContainText(expected) failed
  370 | });
  371 | 
  372 | /** The other half: opening something to read it must not take the cursor. */
  373 | test("opening a file does not steal the cursor", async ({ page }) => {
  374 |   await open(page);
  375 |   await page.locator(".row.file").first().click();
  376 |   await expect(page.locator(".ProseMirror")).toBeVisible();
  377 |   await page.locator(".row.file").nth(1).click();
  378 |   expect(
  379 |     await page.evaluate(() => !!document.activeElement?.closest(".ProseMirror")),
  380 |   ).toBe(false);
  381 | });
  382 | 
  383 | /**
  384 |  * The one file operation that is not a move.
  385 |  *
  386 |  * Within a repository, dragging is a rename and git follows the history. Across
  387 |  * two of them there is no history to follow, so the original has to survive —
  388 |  * which is the assertion that matters here, more than the arrival.
  389 |  */
  390 | test("a file dragged into another repository is copied, not moved", async ({ page }) => {
  391 |   await open(page);
  392 |   const file = page.locator(".row.file", { hasText: "first" }).first();
  393 |   const other = page.locator(".row.repo", { hasText: "two" }).first();
  394 |   await file.dragTo(other);
  395 | 
  396 |   await expect
  397 |     .poll(async () =>
  398 |       page.evaluate(() => Object.keys((window as any).__fake.repos[1].files)),
  399 |     )
  400 |     .toContain("first.md");
  401 |   // Still where it was.
  402 |   expect(
  403 |     await page.evaluate(() => Object.keys((window as any).__fake.repos[0].files)),
  404 |   ).toContain("first.md");
  405 | });
  406 | 
  407 | /**
  408 |  * The plans folder in some order other than the alphabet.
  409 |  *
  410 |  * `plan-dependencies.md` asks whether `status:` already implies enough sequence
  411 |  * to be worth having, and says to try that before adding an `order:` field
  412 |  * nobody would keep in step by hand. This is the trying.
  413 |  */
  414 | test("files can be ordered by status instead of by name", async ({ page }) => {
  415 |   await open(page, [
  416 |     {
  417 |       path: "/repo/one",
  418 |       name: "one",
  419 |       branch: "main",
  420 |       files: {
  421 |         "aardvark.md": "---\nstatus: done\n---\n# Aardvark\n",
  422 |         "zebra.md": "---\nstatus: draft\n---\n# Zebra\n",
  423 |         "plain.md": "# Plain\n",
  424 |       },
  425 |     },
  426 |   ]);
  427 | 
  428 |   const names = () =>
  429 |     page.locator(".row.file .row-name").allTextContents();
  430 | 
  431 |   expect(await names()).toEqual(["aardvark.md", "plain.md", "zebra.md"]);
  432 | 
  433 |   await page.keyboard.press("Meta+p");
  434 |   await page.locator(".palette-input").fill(">order files by status");
  435 |   await expect(page.locator(".palette-row").first()).toContainText(/order files by status/i);
  436 |   await page.keyboard.press("Enter");
  437 | 
  438 |   // draft before done, per the configured vocabulary; the file with no status
  439 |   // at all comes last, so adopting this can be partial.
  440 |   await expect.poll(names).toEqual(["zebra.md", "aardvark.md", "plain.md"]);
  441 | });
  442 | 
  443 | /** ⌃Tab, the binding every tabbed application has. */
  444 | test("ctrl-tab cycles through the open buffers", async ({ page }) => {
  445 |   await open(page);
  446 |   await fileRow(page, "first").click();
  447 |   await fileRow(page, "second").click();
  448 |   await expect(page.locator(".page-path")).toHaveText("notes/second.md");
  449 | 
  450 |   await page.keyboard.press("Control+Tab");
  451 |   await expect(page.locator(".page-path")).toHaveText("first.md");
  452 |   // And wraps, rather than stopping at the end.
  453 |   await page.keyboard.press("Control+Tab");
  454 |   await expect(page.locator(".page-path")).toHaveText("notes/second.md");
  455 | 
  456 |   await page.keyboard.press("Control+Shift+Tab");
  457 |   await expect(page.locator(".page-path")).toHaveText("first.md");
  458 | });
  459 | 
  460 | test("a file can be dragged into a folder", async ({ page }) => {
  461 |   await open(page);
  462 |   const file = page.locator(".row.file", { hasText: "first" }).first();
  463 |   const folder = page.locator(".row.dir", { hasText: "notes" }).first();
  464 |   await file.dragTo(folder);
  465 | 
  466 |   await expect
  467 |     .poll(async () =>
  468 |       page.evaluate(() => Object.keys((window as any).__fake.repos[0].files)),
  469 |     )
```