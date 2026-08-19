/**
 * The agent chat, driven through the app.
 *
 * The point of these is the wiring rather than the agent: that nothing is
 * sent until someone speaks, that every turn carries the plan it is about,
 * that narration streams into the transcript, that the session survives
 * between turns, and that a machine without the CLI gets no button instead
 * of a broken one. The fake runs no agent — a test pushes narration with
 * `__fake.emit` and reads what the app sent out of `calls`.
 */
import { test, expect, type Page } from "@playwright/test";
import { installFakeBackend, type FakeRepo } from "./fake-backend";

const REPOS: FakeRepo[] = [
  {
    path: "/repo/one",
    name: "one",
    branch: "main",
    files: { "plans/first.md": "# First\n\nA plan.\n" },
  },
];

type Boot = {
  /** False to simulate a machine with no agent CLI at all. */
  chat?: boolean;
  /** Where the chat sits, when a test cares. */
  place?: "bottom" | "side";
};

async function open(page: Page, boot: Boot = {}) {
  const faults: string[] = [];
  page.on("pageerror", (e) => faults.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") faults.push(m.text());
  });

  await page.addInitScript(
    ([fn, list, b]) => {
      // eslint-disable-next-line no-new-func
      new Function(`return ${fn}`)()(list);
      const s = (window as any).__fake;
      s.chat = (b as Boot).chat ?? true;
      const place = (b as Boot).place;
      if (place) localStorage.setItem("plans.settings.v1", JSON.stringify({ chatPlace: place }));
      localStorage.setItem(
        "plans.repos.v1",
        JSON.stringify((list as FakeRepo[]).map((r) => r.path)),
      );
      localStorage.setItem("plans.tabs.v1", "[]");
    },
    [installFakeBackend.toString(), REPOS, boot] as const,
  );

  await page.goto("/");
  await expect(page.locator(".files")).toBeVisible();
  return faults;
}

/** Expand the tree until every folder is open, as app.spec.ts does. */
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

/** Open the one plan the fake repository holds. */
async function openPlan(page: Page) {
  await expandAll(page);
  await page.locator(".row.file").first().click();
  await expect(page.locator(".page-path")).toContainText("first.md");
}

/** The arguments of every `cmd` call the app has made so far. */
const argsOf = (page: Page, cmd: string) =>
  page.evaluate(
    (c) => (window as any).__fake.calls.filter((x: any) => x.cmd === c).map((x: any) => x.args),
    cmd,
  );

const calls = async (page: Page, cmd: string) => (await argsOf(page, cmd)).length;

/** Type into the chat and send. */
async function say(page: Page, text: string) {
  const input = page.locator(".chat-input textarea");
  await input.fill(text);
  await input.press("Enter");
}

test("nothing is sent until someone speaks", async ({ page }) => {
  await open(page);
  await openPlan(page);
  await page.keyboard.press("Meta+j");
  await expect(page.locator(".chat")).toBeVisible();

  await page.waitForTimeout(800);
  expect(await calls(page, "chat_send")).toBe(0);
});

test("a message carries the plan it is about", async ({ page }) => {
  await open(page);
  await openPlan(page);
  await page.keyboard.press("Meta+j");
  await say(page, "tighten the opening");

  await expect(page.locator(".chat-msg.user")).toContainText("tighten the opening");
  await expect.poll(() => calls(page, "chat_send")).toBe(1);
  const [sent] = await argsOf(page, "chat_send");
  expect(sent.repo).toBe("/repo/one");
  // The plan's identity rides the first turn of a session.
  expect(sent.prompt).toContain("plans/first.md");
  expect(sent.prompt).toContain("tighten the opening");
  expect(sent.session).toBe(null);
});

test("the answer streams into one bubble", async ({ page }) => {
  await open(page);
  await openPlan(page);
  await page.keyboard.press("Meta+j");
  await say(page, "hello");
  await expect.poll(() => calls(page, "chat_send")).toBe(1);

  await page.evaluate(() => {
    const f = (window as any).__fake;
    f.emit("chat-delta", { id: 1, text: "Read" });
    f.emit("chat-tool", { id: 1, name: "Edit" });
    f.emit("chat-delta", { id: 1, text: "ing the plan now." });
  });
  await expect(page.locator(".chat-msg.assistant")).toHaveCount(1);
  await expect(page.locator(".chat-msg.assistant")).toContainText("Reading the plan now.");
  // The one honest peek at the files: the tool line.
  await expect(page.locator(".chat-tool")).toContainText("Edit");
});

test("the session survives between turns", async ({ page }) => {
  await open(page);
  await openPlan(page);
  await page.keyboard.press("Meta+j");
  await say(page, "first");
  await expect.poll(() => calls(page, "chat_send")).toBe(1);
  await page.evaluate(() => {
    const f = (window as any).__fake;
    f.emit("chat-delta", { id: 1, text: "done" });
    f.emit("chat-done", { id: 1, session: "sess-42", ok: true });
  });

  await say(page, "second");
  await expect.poll(() => calls(page, "chat_send")).toBe(2);
  const sent = await argsOf(page, "chat_send");
  // --resume carries the conversation, so the preamble is not repeated.
  expect(sent[1].session).toBe("sess-42");
  expect(sent[1].prompt).not.toContain("You are working in");
});

test("the transcript belongs to the plan, not the panel", async ({ page }) => {
  await open(page);
  await openPlan(page);
  await page.keyboard.press("Meta+j");
  await say(page, "remember me");
  await expect.poll(() => calls(page, "chat_send")).toBe(1);

  await page.keyboard.press("Meta+j");
  await expect(page.locator(".chat")).toHaveCount(0);
  await page.keyboard.press("Meta+j");
  await expect(page.locator(".chat-msg.user")).toContainText("remember me");
});

test("stop kills the turn but not the conversation", async ({ page }) => {
  await open(page);
  await openPlan(page);
  await page.keyboard.press("Meta+j");
  await say(page, "long answer please");
  await expect.poll(() => calls(page, "chat_send")).toBe(1);

  await page.locator(".mux-key", { hasText: "Stop" }).click();
  await expect.poll(() => calls(page, "chat_cancel")).toBe(1);
  const [cancelled] = await argsOf(page, "chat_cancel");
  expect(cancelled.id).toBe(1);
});

test("no agent CLI means no button, rather than one that fails", async ({ page }) => {
  const faults = await open(page, { chat: false });
  await expect(page.locator('.rail-btn[title^="Agent chat"]')).toHaveCount(0);
  await page.keyboard.press("Meta+j");
  await expect(page.locator(".chat")).toHaveCount(0);
  expect(faults).toEqual([]);
});

test("fleshing out a plan is the first message of its chat", async ({ page }) => {
  await open(page);
  await openPlan(page);
  // The palette is the only door now: the page header carries no agent button.
  await page.keyboard.press("Meta+p");
  await page.locator(".palette-input").fill(">flesh out");
  await expect(page.locator(".palette-row").first()).toContainText(/flesh out/i);
  await page.keyboard.press("Enter");

  // The run is shown as a conversation, not announced from a distance.
  await expect(page.locator(".chat")).toBeVisible();
  await expect.poll(() => calls(page, "chat_send")).toBe(1);
  const [sent] = await argsOf(page, "chat_send");
  expect(sent.prompt).toContain("Flesh out the plan at plans/first.md");
  await expect(page.locator(".chat-msg.user")).toContainText("Flesh out the plan");
});

test("nothing is committed by talking", async ({ page }) => {
  await open(page);
  await openPlan(page);
  await page.keyboard.press("Meta+j");
  await say(page, "please edit");
  await expect.poll(() => calls(page, "chat_send")).toBe(1);

  const wrote = await page.evaluate(() =>
    (window as any).__fake.calls.some((c: any) =>
      ["git_commit", "git_stage", "git_push"].includes(c.cmd),
    ),
  );
  expect(wrote).toBe(false);
});


/*
 * Where the chat sits.
 *
 * These assert geometry rather than class names: the setting is only worth
 * anything if the panel actually lands somewhere different, and a rule that
 * loses a specificity fight would still leave the class on the element.
 */

/** The bounding box of a selector, which every one of these compares. */
const box = async (page: Page, sel: string) => {
  const b = await page.locator(sel).boundingBox();
  if (!b) throw new Error(`no box for ${sel}`);
  return b;
};

test("below the page, the chat starts where the file tree ends", async ({ page }) => {
  await open(page, { place: "bottom" });
  await openPlan(page);
  await page.keyboard.press("Meta+j");
  await expect(page.locator(".chat")).toBeVisible();

  const tree = await box(page, ".files");
  const chat = await box(page, ".mux");
  const doc = await box(page, ".page-path");

  // Pushed by the tree, not spanning under it.
  expect(chat.x).toBeGreaterThanOrEqual(tree.x + tree.width - 1);
  // And still a row: it sits below the document rather than beside it.
  expect(chat.y).toBeGreaterThan(doc.y);
});

test("hiding the tree gives the width back", async ({ page }) => {
  await open(page, { place: "bottom" });
  await openPlan(page);
  await page.keyboard.press("Meta+j");
  await expect(page.locator(".chat")).toBeVisible();
  const pushed = await box(page, ".mux");

  await page.keyboard.press("Meta+b");
  await expect(page.locator(".files")).toBeHidden();
  const full = await box(page, ".mux");

  expect(full.x).toBeLessThan(pushed.x);
  expect(full.width).toBeGreaterThan(pushed.width);
});

test("beside the page, the chat is a column and the tree keeps its own", async ({ page }) => {
  await open(page, { place: "side" });
  await openPlan(page);
  await page.keyboard.press("Meta+j");
  await expect(page.locator(".chat")).toBeVisible();

  const tree = await box(page, ".files");
  const chat = await box(page, ".mux");

  // On the right of everything, and tall rather than wide.
  expect(chat.x).toBeGreaterThan(tree.x + tree.width);
  expect(chat.height).toBeGreaterThan(chat.width);
  // The tree is untouched by the move — it is a fixture, not part of the page.
  expect(tree.x).toBe(0);
});

test("the placement can be changed without reaching for settings", async ({ page }) => {
  await open(page, { place: "bottom" });
  await openPlan(page);
  await page.keyboard.press("Meta+j");
  await settle(page, ".mux");
  const before = await box(page, ".mux");

  await page.keyboard.press("Meta+p");
  await page.locator(".palette-input").fill(">chat beside");
  await expect(page.locator(".palette-row").first()).toContainText(/beside/i);
  await page.keyboard.press("Enter");

  await expect.poll(async () => (await box(page, ".mux")).x).toBeGreaterThan(before.x);
});

/**
 * Wait for `sel` to stop moving. The panel slides in, and a drag begun while
 * it is still travelling grabs an edge that is no longer under the pointer by
 * the time the button goes down.
 */
async function settle(page: Page, sel: string) {
  let last = -1;
  await expect
    .poll(async () => {
      const y = Math.round((await box(page, sel)).y);
      const still = y === last;
      last = y;
      return still;
    })
    .toBe(true);
}

/** Drag `sel` by (dx, dy) with real pointer events. */
async function drag(page: Page, sel: string, dx: number, dy: number) {
  await settle(page, ".mux");
  const b = await box(page, sel);
  const x = b.x + b.width / 2;
  const y = b.y + b.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 8 });
  await page.mouse.up();
}

test("the bottom chat is dragged taller by its top edge", async ({ page }) => {
  await open(page, { place: "bottom" });
  await openPlan(page);
  await page.keyboard.press("Meta+j");
  await settle(page, ".mux");
  const before = await box(page, ".mux");

  await drag(page, ".chat-edge", 0, -80);

  await expect.poll(async () => (await box(page, ".mux")).height).toBeGreaterThan(
    before.height + 50,
  );
  // And it stuck: the height is a setting, not a transient.
  const kept = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("plans.settings.v1") ?? "{}"),
  );
  expect(kept.muxHeight).toBeGreaterThan(300);
});

test("the side chat is dragged wider by its left edge", async ({ page }) => {
  await open(page, { place: "side" });
  await openPlan(page);
  await page.keyboard.press("Meta+j");
  await settle(page, ".mux");
  const before = await box(page, ".mux");

  await drag(page, ".chat-edge", -70, 0);

  await expect.poll(async () => (await box(page, ".mux")).width).toBeGreaterThan(
    before.width + 40,
  );
});

test("the tree's edge runs past the chat rather than stopping at it", async ({ page }) => {
  await open(page, { place: "bottom" });
  await openPlan(page);
  await page.keyboard.press("Meta+j");
  await expect(page.locator(".chat")).toBeVisible();

  // Polled rather than read once: the panel slides in, and a box measured
  // mid-animation is a few pixels below where it lands.
  await expect
    .poll(async () => {
      const tree = await box(page, ".files");
      const chat = await box(page, ".mux");
      // The bordered column reaches the panel's bottom, so there is a wall
      // beside the chat instead of a gap where the tree ran out.
      return tree.y + tree.height - (chat.y + chat.height);
    })
    .toBeGreaterThanOrEqual(-1);
});

test("the page header carries no agent button", async ({ page }) => {
  await open(page);
  await openPlan(page);
  await expect(page.locator(".page-act")).toHaveCount(0);
});

test("the chat's header is the same bar height as the tabs", async ({ page }) => {
  await open(page, { place: "side" });
  await openPlan(page);
  await page.keyboard.press("Meta+j");
  await expect(page.locator(".chat")).toBeVisible();

  // Beside the page, these two sit side by side; a couple of pixels out is
  // visible as a step in the rule that runs under both of them.
  const tabs = await box(page, ".tabs");
  const head = await box(page, ".chat .panel-head");
  expect(head.height).toBe(tabs.height);
  // And the tree's search bar, which is the same strip a column further left.
  const filter = await box(page, ".filter");
  expect(head.height).toBe(filter.height);
});

/*
 * One right-hand column.
 *
 * Beside the page, git and the chat want the same space. The rule is that the
 * one you just asked for wins — a press that appears to do nothing is worse
 * than a press that closes something.
 */

test("beside the page, opening the chat closes the git panel", async ({ page }) => {
  await open(page, { place: "side" });
  await openPlan(page);
  await page.keyboard.press("Meta+g");
  await expect(page.locator(".git")).toBeVisible();

  await page.keyboard.press("Meta+j");
  await expect(page.locator(".chat")).toBeVisible();
  await expect(page.locator(".git")).toHaveCount(0);
});

test("beside the page, opening the git panel closes the chat", async ({ page }) => {
  await open(page, { place: "side" });
  await openPlan(page);
  await page.keyboard.press("Meta+j");
  await expect(page.locator(".chat")).toBeVisible();

  await page.keyboard.press("Meta+g");
  await expect(page.locator(".git")).toBeVisible();
  await expect(page.locator(".chat")).toHaveCount(0);
});

test("below the page they coexist, because they are not in each other's way", async ({ page }) => {
  await open(page, { place: "bottom" });
  await openPlan(page);
  await page.keyboard.press("Meta+g");
  await page.keyboard.press("Meta+j");

  await expect(page.locator(".git")).toBeVisible();
  await expect(page.locator(".chat")).toBeVisible();
});

test("moving the chat to the side gives way for it", async ({ page }) => {
  await open(page, { place: "bottom" });
  await openPlan(page);
  await page.keyboard.press("Meta+g");
  await page.keyboard.press("Meta+j");
  await expect(page.locator(".git")).toBeVisible();

  await page.keyboard.press("Meta+p");
  await page.locator(".palette-input").fill(">chat beside");
  await page.keyboard.press("Enter");

  // The chat is what moved, so the chat is what keeps the column.
  await expect(page.locator(".chat")).toBeVisible();
  await expect(page.locator(".git")).toHaveCount(0);
});

/*
 * Settings and the rail.
 */

test("a panel button leaves Settings rather than toggling something unseen", async ({ page }) => {
  await open(page);
  await openPlan(page);
  await page.keyboard.press("Meta+,");
  await expect(page.locator(".settings")).toBeVisible();

  await page.locator(".rail-btn", { hasText: "Chat" }).click();
  await expect(page.locator(".settings")).toHaveCount(0);
  await expect(page.locator(".chat")).toBeVisible();
});

test("the git button does the same, and does not merely flip a setting", async ({ page }) => {
  await open(page);
  await openPlan(page);
  await page.keyboard.press("Meta+,");
  await page.locator(".rail-btn", { hasText: "Git" }).click();

  await expect(page.locator(".settings")).toHaveCount(0);
  await expect(page.locator(".git")).toBeVisible();
});

test("the agent settings are gathered in one section", async ({ page }) => {
  await open(page);
  await page.keyboard.press("Meta+,");
  await page.locator(".settings-filter").fill("chat");

  const agents = page.locator(".settings-group", { hasText: "Agents" });
  await expect(agents).toBeVisible();
  // Placement lives with the agent now, not with the window furniture.
  await expect(agents).toContainText("Chat sits");
  await expect(agents).toContainText("Chat agent");
});

test("the flesh-out instruction is editable, and is what gets sent", async ({ page }) => {
  await open(page);
  await openPlan(page);
  await page.keyboard.press("Meta+,");
  await page.locator(".settings-filter").fill("flesh");
  const area = page.locator('textarea[aria-label="Flesh out says"]');
  await area.fill("Rewrite {file} in the voice of a ship's log.");

  await page.keyboard.press("Escape");
  await page.keyboard.press("Meta+p");
  await page.locator(".palette-input").fill(">flesh out");
  await page.keyboard.press("Enter");

  await expect.poll(() => calls(page, "chat_send")).toBe(1);
  const [sent] = await argsOf(page, "chat_send");
  // The panel wraps every turn in its own preamble; the instruction is ours.
  expect(sent.prompt).toContain("Rewrite plans/first.md in the voice of a ship's log.");
  expect(sent.prompt).not.toContain("house style of this folder");
});

test("the branch picker is in the rail, not the git panel", async ({ page }) => {
  await open(page);
  await openPlan(page);
  const picker = page.locator('.rail [aria-label="Branch"]');
  await expect(picker).toBeVisible();

  // And it is left of everything else the rail does.
  const branch = (await picker.boundingBox())!;
  const git = (await page.locator(".rail-btn", { hasText: "Git" }).boundingBox())!;
  expect(branch.x).toBeLessThan(git.x);

  await page.keyboard.press("Meta+g");
  await expect(page.locator(".git")).toBeVisible();
  await expect(page.locator('.git [aria-label="Branch"]')).toHaveCount(0);
});

test("branches are not fetched until the picker is opened", async ({ page }) => {
  await open(page);
  await openPlan(page);
  await page.waitForTimeout(600);
  expect(await calls(page, "git_branches")).toBe(0);

  await page.locator('.rail [aria-label="Branch"]').click();
  await expect.poll(() => calls(page, "git_branches")).toBeGreaterThan(0);
});

test("the commit box is above the changes, not past the end of them", async ({ page }) => {
  await open(page);
  await openPlan(page);
  await page.keyboard.press("Meta+g");
  await expect(page.locator(".git")).toBeVisible();

  const commit = await box(page, ".commit");
  const first = await box(page, ".git-section >> nth=0");
  expect(commit.y).toBeLessThan(first.y);
});

test("every panel header is the same bar, whichever panel it is", async ({ page }) => {
  await open(page, { place: "side" });
  await openPlan(page);
  await page.keyboard.press("Meta+j");
  const chatHead = await box(page, ".chat .panel-head");

  await page.keyboard.press("Meta+g");
  await expect(page.locator(".git")).toBeVisible();
  const gitHead = await box(page, ".git .panel-head");
  const tabs = await box(page, ".tabs");

  expect(gitHead.height).toBe(chatHead.height);
  expect(gitHead.height).toBe(tabs.height);
  // Pull and push are in it, and the repository's name is not repeated.
  // Words and arrows both: the word says what it does, the arrow which way.
  await expect(page.locator('.git .panel-head [aria-label="Pull"]')).toContainText("Pull ↓");
  await expect(page.locator('.git .panel-head [aria-label="Push"]')).toContainText("Push ↑");
  await expect(page.locator(".git")).not.toContainText("Repository");
});

/*
 * An unfinished merge.
 *
 * The app cannot finish one, and the point of these is that it stops
 * pretending otherwise: the files are marked, the two buttons that would make
 * things worse are off, and the way out is written down.
 */

/** A repo mid-merge, with one plan holding both sides. */
async function openConflicted(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("plans.repos.v1", JSON.stringify(["/repo/one"]));
    localStorage.setItem("plans.tabs.v1", "[]");
  });
  await page.addInitScript(
    ([fn]) => {
      // eslint-disable-next-line no-new-func
      new Function(`return ${fn}`)()([
        {
          path: "/repo/one",
          name: "one",
          branch: "main",
          files: { "plans/first.md": "# First\n" },
          conflicted: ["plans/first.md"],
          operation: "merge",
        },
      ]);
      (window as any).__fake.chat = true;
    },
    [installFakeBackend.toString()] as const,
  );
  await page.goto("/");
  await expect(page.locator(".files")).toBeVisible();
}

test("an unfinished merge is said out loud, and stops pull and push", async ({ page }) => {
  await openConflicted(page);
  await page.keyboard.press("Meta+g");
  await expect(page.locator(".git")).toBeVisible();

  await expect(page.locator(".git-alarm")).toContainText("A merge is unfinished");
  await expect(page.locator(".git-alarm")).toContainText("git merge --abort");
  await expect(page.locator('.git [aria-label="Pull"]')).toBeDisabled();
  await expect(page.locator('.git [aria-label="Push"]')).toBeDisabled();
});

test("a conflicted file is its own thing, not a staged one", async ({ page }) => {
  await openConflicted(page);
  await page.keyboard.press("Meta+g");

  const section = page.locator(".git-section", { hasText: "Conflicted" });
  await expect(section).toContainText("first.md");
  // And it is not counted among the staged, whose codes it superficially matches.
  // "Staged" alone also matches the "Not staged" section; filter on the exact heading.
  await expect(
    page.locator(".git-section").filter({ has: page.getByText("Staged", { exact: true }) }),
  ).toContainText("Nothing here");
});

test("the tree marks a conflict as its own state", async ({ page }) => {
  await openConflicted(page);
  await expandAll(page);
  const row = page.locator(".row.file").first();
  await expect(row).toHaveClass(/conflict/);
  await expect(row.locator(".row-name")).toHaveAttribute("title", "conflicted");
});

test("marking a conflict resolved stages it, which is what git means by resolved", async ({
  page,
}) => {
  await openConflicted(page);
  await page.keyboard.press("Meta+g");
  await page.locator(".git-section", { hasText: "Conflicted" }).locator(".act").click();

  await expect.poll(() => calls(page, "git_stage")).toBe(1);
  const [staged] = await argsOf(page, "git_stage");
  expect(staged.paths).toEqual(["plans/first.md"]);
});
