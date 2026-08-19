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
  /** Replaces the default single-plan repository. */
  repos?: FakeRepo[];
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
    [installFakeBackend.toString(), boot.repos ?? REPOS, boot] as const,
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

/** End the turn `id` the way the backend would, with a session id. */
async function finish(page: Page, id: number, _session = "") {
  await page.evaluate((i) => {
    const f = (window as any).__fake;
    f.emit("agent-message", { repo: "/repo/one", turn: i, text: "…" });
    f.emit("agent-turn", { repo: "/repo/one", turn: i, stop: "EndTurn", ok: true });
  }, id);
}

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
  expect(await calls(page, "agent_prompt")).toBe(0);
});

test("a message carries the plan it is about", async ({ page }) => {
  await open(page);
  await openPlan(page);
  await page.keyboard.press("Meta+j");
  await say(page, "tighten the opening");

  await expect(page.locator(".chat-msg.user")).toContainText("tighten the opening");
  await expect.poll(() => calls(page, "agent_prompt")).toBe(1);
  const [sent] = await argsOf(page, "agent_prompt");
  expect(sent.repo).toBe("/repo/one");
  // The plan's identity rides the first turn of a session.
  expect(sent.text).toContain("plans/first.md");
  expect(sent.text).toContain("tighten the opening");
  // Which agent to start, if one is not running for this repo yet.
  expect(sent.agent).toBe("claude");
});

test("the answer streams into one bubble", async ({ page }) => {
  await open(page);
  await openPlan(page);
  await page.keyboard.press("Meta+j");
  await say(page, "hello");
  await expect.poll(() => calls(page, "agent_prompt")).toBe(1);

  await page.evaluate(() => {
    const f = (window as any).__fake;
    const r = "/repo/one";
    f.emit("agent-message", { repo: r, turn: 1, text: "Read" });
    f.emit("agent-tool", { repo: r, turn: 1, callId: "t1", title: "Edit", status: "pending" });
    f.emit("agent-message", { repo: r, turn: 1, text: "ing the plan now." });
  });
  await expect(page.locator(".chat-msg.assistant")).toHaveCount(1);
  await expect(page.locator(".chat-msg.assistant")).toContainText("Reading the plan now.");
  // The one honest peek at the files: the tool line.
  await expect(page.locator(".chat-tool")).toContainText("Edit");
});

test("a tool line finishes rather than repeating itself", async ({ page }) => {
  await open(page);
  await openPlan(page);
  await page.keyboard.press("Meta+j");
  await say(page, "edit it");
  await expect.poll(() => calls(page, "agent_prompt")).toBe(1);

  await page.evaluate(() => {
    const f = (window as any).__fake;
    const r = "/repo/one";
    // The first notification names the tool before its arguments exist; the
    // second carries the title the agent wrote and the status.
    f.emit("agent-tool", { repo: r, turn: 1, callId: "t1", title: "Edit File", status: "pending" });
    f.emit("agent-tool", {
      repo: r,
      turn: 1,
      callId: "t1",
      title: "Edit first.md",
      status: "completed",
      locations: ["first.md"],
    });
  });

  // One line, amended in place — the old design appended, so a tool could
  // never stop saying "running".
  await expect(page.locator(".chat-tool")).toHaveCount(1);
  await expect(page.locator(".chat-tool")).toContainText("Edit first.md");
  await expect(page.locator(".chat-tool.completed")).toHaveCount(1);
});

test("the session holds the conversation, so nothing is re-sent", async ({ page }) => {
  await open(page);
  await openPlan(page);
  await page.keyboard.press("Meta+j");
  await say(page, "first");
  await expect.poll(() => calls(page, "agent_prompt")).toBe(1);
  await finish(page, 1);

  await say(page, "second");
  await expect.poll(() => calls(page, "agent_prompt")).toBe(2);
  const sent = await argsOf(page, "agent_prompt");
  // The agent process is still alive and holds the context itself. There is
  // no session id to carry and no preamble to repeat — the old design needed
  // both because every turn was a fresh `-p` invocation.
  expect(sent[1].text).toBe("second");
  expect(sent[1].repo).toBe("/repo/one");
});

test("the transcript belongs to the repository, not the panel", async ({ page }) => {
  await open(page);
  await openPlan(page);
  await page.keyboard.press("Meta+j");
  await say(page, "remember me");
  await expect.poll(() => calls(page, "agent_prompt")).toBe(1);

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
  await expect.poll(() => calls(page, "agent_prompt")).toBe(1);

  await page.locator(".mux-key", { hasText: "Stop" }).click();
  await expect.poll(() => calls(page, "agent_cancel")).toBe(1);
  const [cancelled] = await argsOf(page, "agent_cancel");
  expect(cancelled.turn).toBe(1);
  expect(cancelled.repo).toBe("/repo/one");
});

test("no agent CLI means no button, rather than one that fails", async ({ page }) => {
  const faults = await open(page, { chat: false });
  await expect(page.locator('.rail-btn[title^="Agent chat"]')).toHaveCount(0);
  await page.keyboard.press("Meta+j");
  await expect(page.locator(".chat")).toHaveCount(0);
  expect(faults).toEqual([]);
});

test("handing a plan to the agent is the first message of its chat", async ({ page }) => {
  await open(page);
  await openPlan(page);
  // The palette is the only door now: the page header carries no agent button.
  await page.keyboard.press("Meta+p");
  await page.locator(".palette-input").fill(">hand off");
  await expect(page.locator(".palette-row").first()).toContainText(/hand off/i);
  await page.keyboard.press("Enter");

  // The run is shown as a conversation, not announced from a distance.
  await expect(page.locator(".chat")).toBeVisible();
  await expect.poll(() => calls(page, "agent_prompt")).toBe(1);
  const [sent] = await argsOf(page, "agent_prompt");
  expect(sent.text).toContain("Take over the plan at plans/first.md");
  await expect(page.locator(".chat-msg.user")).toContainText("Take over the plan");
});

test("nothing is committed by talking", async ({ page }) => {
  await open(page);
  await openPlan(page);
  await page.keyboard.press("Meta+j");
  await say(page, "please edit");
  await expect.poll(() => calls(page, "agent_prompt")).toBe(1);

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
  const tabs = await box(page, ".tab-row");
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

test("the handoff prompt is editable, and is what gets sent", async ({ page }) => {
  await open(page);
  await openPlan(page);
  await page.keyboard.press("Meta+,");
  await page.locator(".settings-filter").fill("handoff");
  const area = page.locator('textarea[aria-label="Handoff prompt"]');
  await area.fill("Rewrite {file} in the voice of a ship's log.");

  await page.keyboard.press("Escape");
  await page.keyboard.press("Meta+p");
  await page.locator(".palette-input").fill(">hand off");
  await page.keyboard.press("Enter");

  await expect.poll(() => calls(page, "agent_prompt")).toBe(1);
  const [sent] = await argsOf(page, "agent_prompt");
  // The panel wraps every turn in its own preamble; the instruction is ours.
  expect(sent.text).toContain("Rewrite plans/first.md in the voice of a ship's log.");
  expect(sent.text).not.toContain("house style of this folder");
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
  const tabs = await box(page, ".tab-row");

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

test("the first poll of a repository does not take the app down", async ({ page }) => {
  // `refreshStatusFor` compares the new status against a `prev[repo]` that is
  // undefined until the slower whole-repo refresh has run once. The poll for
  // the active repository gets there first, so this is the ordinary path, not
  // an edge: reading `.branch` off the missing side threw on every launch.
  const faults = await open(page);
  await openPlan(page);
  await expect.poll(() => calls(page, "git_status"), { timeout: 15000 }).toBeGreaterThan(0);
  await page.waitForTimeout(1000);

  expect(faults).toEqual([]);
  await expect(page.locator(".files")).toBeVisible();
});

/*
 * What is already installed.
 *
 * Both of these buttons used to offer the same press whatever the state was,
 * so pressing them looked like nothing happening.
 */

test("installing the CLI changes the button to say so", async ({ page }) => {
  await open(page);
  await page.keyboard.press("Meta+,");
  const row = page.locator(".setting-row", { hasText: "Command line" });
  await expect(row).toBeVisible();
  await expect(row.locator("button.act")).toHaveText("Install");
  await row.locator("button.act").click();

  await expect(row.locator(".act.done")).toHaveText("Installed");
  await expect(row.locator("button.act")).toHaveCount(0);
});

test("a repository that already has the skill is not offered it again", async ({ page }) => {
  await open(page);
  await page.keyboard.press("Meta+,");

  const row = page.locator(".repo-row", { hasText: "one" });
  await expect(row.locator("button.act", { hasText: "Install skill" })).toBeVisible();
  await row.locator("button.act", { hasText: "Install skill" }).click();

  // Written, and the button stops asking.
  await expect(row.locator(".act.done")).toHaveText("Skill installed");
});

test("a plan is handed to the agent from its right-click menu", async ({ page }) => {
  await open(page);
  await expandAll(page);
  await page.locator(".row.file").first().click({ button: "right" });

  await page.locator(".ctx-item", { hasText: "Hand off to agent" }).click();

  // The chat opens on that plan with the instruction already sent.
  await expect(page.locator(".chat")).toBeVisible();
  await expect.poll(() => calls(page, "agent_prompt")).toBe(1);
  const [sent] = await argsOf(page, "agent_prompt");
  expect(sent.text).toContain("Take over the plan at plans/first.md");
});

test("no agent means no handoff in the menu, rather than one that fails", async ({ page }) => {
  await open(page, { chat: false });
  await expandAll(page);
  await page.locator(".row.file").first().click({ button: "right" });

  await expect(page.locator(".ctx")).toBeVisible();
  await expect(page.locator(".ctx-item", { hasText: "Hand off to agent" })).toHaveCount(0);
});

test("the agent is chosen from the ones the machine has", async ({ page }) => {
  await open(page);
  await page.keyboard.press("Meta+,");
  await page.locator(".settings-filter").fill("chat agent");

  const pick = page.locator(".setting-row", { hasText: "Chat agent" });
  // Both known agents are offered, and the one that is missing says so
  // rather than vanishing from the list.
  await expect(pick.locator("button", { hasText: "claude" })).toBeVisible();
  await expect(pick.locator("button", { hasText: "codex (not installed)" })).toBeVisible();
});

test("an agent that is not installed says how to get it", async ({ page }) => {
  await open(page);
  await page.keyboard.press("Meta+,");
  await page.locator(".settings-filter").fill("chat agent");
  await page
    .locator(".setting-row", { hasText: "Chat agent" })
    .locator("button", { hasText: "Codex" })
    .click();

  // Every agent speaks the same protocol now, so the only thing that can be
  // wrong is that this machine does not have it.
  await page.locator(".settings-filter").fill("");
  await expect(page.locator(".settings")).toContainText("Needs Node and a Codex login.");
});

test("switching plans keeps the conversation, and says where you moved", async ({ page }) => {
  await open(page, {
    repos: [
      {
        path: "/repo/one",
        name: "one",
        branch: "main",
        files: { "plans/first.md": "# First\n", "plans/second.md": "# Second\n" },
      },
    ],
  });
  await expandAll(page);
  await page.locator(".row.file").first().click();
  await page.keyboard.press("Meta+j");
  await say(page, "hello");
  await expect.poll(() => calls(page, "agent_prompt")).toBe(1);

  await finish(page, 1, "sess-1");

  // A different plan, same chat: the transcript is still there.
  await page.locator(".row.file").nth(1).click();
  await expect(page.locator(".chat-msg.user")).toContainText("hello");

  await say(page, "and this one?");
  await expect.poll(() => calls(page, "agent_prompt")).toBe(2);
  const sent = await argsOf(page, "agent_prompt");
  // The move is mentioned once, on the turn after it happened — and the
  // repository framing is not repeated, because --resume carries it.
  expect(sent[1].text).toContain("plans/second.md");
  expect(sent[1].text).not.toContain("You are working in the repository");
});

test("the same plan twice running is not announced twice", async ({ page }) => {
  await open(page);
  await openPlan(page);
  await page.keyboard.press("Meta+j");
  await say(page, "one");
  await expect.poll(() => calls(page, "agent_prompt")).toBe(1);
  await finish(page, 1, "sess-1");
  await say(page, "two");
  await expect.poll(() => calls(page, "agent_prompt")).toBe(2);

  const sent = await argsOf(page, "agent_prompt");
  expect(sent[0].text).toContain("plans/first.md");
  expect(sent[1].text).not.toContain("plans/first.md");
});

/*
 * Hiding finished plans.
 */

const MIXED: FakeRepo[] = [
  {
    path: "/repo/one",
    name: "one",
    branch: "main",
    files: {
      "plans/first.md": "---\nstatus: active\n---\n# First\n",
      "plans/second.md": "---\nstatus: done\n---\n# Second\n",
      "plans/completed/third.md": "---\nstatus: active\n---\n# Third\n",
    },
  },
];

const names = async (page: Page) =>
  page.locator(".row.file .row-name").allTextContents();

test("finished plans can be hidden, by status and by folder", async ({ page }) => {
  await open(page, { repos: MIXED });
  await expandAll(page);
  expect((await names(page)).length).toBe(3);

  await page.keyboard.press("Meta+p");
  await page.locator(".palette-input").fill(">show finished plans");
  await page.keyboard.press("Enter");

  // Both ways a plan says it is over: the status, and the folder it sits in.
  const left = await names(page);
  expect(left.join(" ")).toContain("first");
  expect(left.join(" ")).not.toContain("second");
  expect(left.join(" ")).not.toContain("third");
});

test("hiding them does not close one that is open", async ({ page }) => {
  await open(page, { repos: MIXED });
  await expandAll(page);
  await page.locator(".row.file", { hasText: "second" }).click();
  await expect(page.locator(".page-path")).toContainText("second.md");

  await page.keyboard.press("Meta+p");
  await page.locator(".palette-input").fill(">show finished plans");
  await page.keyboard.press("Enter");

  // Out of the tree, still on screen: the setting is a view, not a close.
  await expect(page.locator(".row.file", { hasText: "second" })).toHaveCount(0);
  await expect(page.locator(".page-path")).toContainText("second.md");
});

test("a tool call is shown with what it touched, not just its name", async ({ page }) => {
  await open(page);
  await openPlan(page);
  await page.keyboard.press("Meta+j");
  await say(page, "read it");
  await expect.poll(() => calls(page, "agent_prompt")).toBe(1);

  await page.evaluate(() => {
    const f = (window as any).__fake;
    const r = "/repo/one";
    // The agent writes the title itself; the app no longer guesses one from
    // tool inputs it had to know the shape of.
    f.emit("agent-tool", {
      repo: r,
      turn: 1,
      callId: "t1",
      title: "Read first.md",
      status: "completed",
    });
    f.emit("agent-message", { repo: r, turn: 1, text: "It is a plan." });
  });

  await expect(page.locator(".chat-tool")).toContainText("Read first.md");
  await expect(page.locator(".chat-msg.assistant")).toContainText("It is a plan.");
});

test("a turn that cannot start says so in the transcript", async ({ page }) => {
  await open(page);
  await openPlan(page);
  await page.keyboard.press("Meta+j");
  // The backend refuses: the binary is not on the PATH this app was given.
  await page.evaluate(() => {
    (window as any).__fake.failNextSend = "claude is not installed";
  });
  await say(page, "hello?");

  // Not only a toast — a toast is gone by the time you look back, and a turn
  // that produced nothing must not look like one still thinking.
  await expect(page.locator(".chat-tool")).toContainText("not installed");
  await expect(page.locator(".chat-input textarea")).toBeEnabled();
});

test("marking a plan done hides it at once, not at the next poll", async ({ page }) => {
  await open(page, { repos: MIXED });
  await expandAll(page);

  // Hide finished plans, then finish one.
  await page.keyboard.press("Meta+p");
  await page.locator(".palette-input").fill(">show finished plans");
  await page.keyboard.press("Enter");
  await expect(page.locator(".row.file", { hasText: "first" })).toBeVisible();

  await page.locator(".row.file", { hasText: "first" }).click();
  await page.keyboard.press("Meta+p");
  await page.locator(".palette-input").fill(">status: done");
  await page.locator(".palette-row").first().click();

  // The tree knows without reading the file back: the value was just typed.
  await expect(page.locator(".row.file", { hasText: "first" })).toHaveCount(0);
});

test("the context menu stays on screen near the bottom edge", async ({ page }) => {
  await open(page, { repos: MIXED });
  await expandAll(page);

  // Right-click the lowest row there is, which is where a menu opening
  // downwards would run off the window.
  const rows = page.locator(".row.file");
  await rows.last().click({ button: "right" });

  const menu = await box(page, ".ctx");
  const h = page.viewportSize()!.height;
  const w = page.viewportSize()!.width;
  expect(menu.y).toBeGreaterThanOrEqual(0);
  expect(menu.y + menu.height).toBeLessThanOrEqual(h);
  expect(menu.x + menu.width).toBeLessThanOrEqual(w);
  // And every item in it is reachable, which is the point of the clamping.
  await expect(page.locator(".ctx-item").last()).toBeVisible();
});

test("cmd-backspace deletes the selected file, after asking", async ({ page }) => {
  await open(page);
  await openPlan(page);
  // Selected in the tree, which is the surface this chord belongs to.
  await page.locator(".row.file.active").focus();

  await page.keyboard.press("Meta+Backspace");

  // It asked — a native sheet, not the browser's confirm, which a WKWebView
  // swallows without showing anything.
  await expect
    .poll(() => page.evaluate(() => (window as any).__fake.asked))
    .toContainEqual(expect.stringContaining("Delete plans/first.md"));
  await expect.poll(() => calls(page, "delete_plan")).toBe(1);
  const [gone] = await argsOf(page, "delete_plan");
  expect(gone.relPath).toBe("plans/first.md");
});

test("cmd-backspace outside the tree is not a delete", async ({ page }) => {
  await open(page);
  await openPlan(page);

  // The caret is in the document: ⌘⌫ means "delete to start of line" there,
  // and taking that away to delete a file would be a nasty surprise.
  await page.locator(".milkdown .ProseMirror.editor").click();
  await page.keyboard.press("Meta+Backspace");

  await page.waitForTimeout(300);
  expect(await calls(page, "delete_plan")).toBe(0);
});

test("F2 renames the open file", async ({ page }) => {
  await open(page);
  await openPlan(page);
  await page.keyboard.press("F2");

  // The name sheet, prefilled with what it is called now.
  await expect(page.locator(".matter-sheet")).toBeVisible();
  await expect(page.locator(".name-field")).toHaveValue(/first/);
});

test("saying no to the question leaves the file alone", async ({ page }) => {
  await open(page);
  await openPlan(page);
  await page.evaluate(() => ((window as any).__fake.confirmAnswer = false));
  await page.locator(".row.file.active").focus();

  await page.keyboard.press("Meta+Backspace");

  await expect
    .poll(() => page.evaluate(() => (window as any).__fake.asked.length))
    .toBeGreaterThan(0);
  expect(await calls(page, "delete_plan")).toBe(0);
  await expect(page.locator(".page-path")).toContainText("first.md");
});

test("clicking a plan leaves the tree holding focus, so the chord is usable", async ({ page }) => {
  await open(page);
  await expandAll(page);
  await page.locator(".row.file").first().click();

  // The gate is only workable if a plain click puts you in a state where the
  // chord fires — otherwise it would be a shortcut nobody can reach.
  const inTree = await page.evaluate(() => !!document.activeElement?.closest(".files"));
  expect(inTree).toBe(true);

  await page.keyboard.press("Meta+Backspace");
  await expect.poll(() => calls(page, "delete_plan")).toBe(1);
});

/*
 * Permissions.
 *
 * The agent blocks while it waits on us, which makes every way of not
 * answering into a way of wedging the session. These cover the answering and
 * the not-answering alike.
 */

test("a permission request waits in the transcript, and answering frees it", async ({ page }) => {
  await open(page);
  await openPlan(page);
  await page.keyboard.press("Meta+j");
  await say(page, "edit the plan");
  await expect.poll(() => calls(page, "agent_prompt")).toBe(1);

  await page.evaluate(() => {
    (window as any).__fake.emit("agent-permission", {
      repo: "/repo/one",
      requestId: "/repo/one::t1",
      title: "Edit first.md",
      options: [
        { optionId: "allow", name: "Allow" },
        { optionId: "always", name: "Always allow" },
      ],
    });
  });

  const ask = page.locator(".chat-ask");
  await expect(ask).toContainText("Edit first.md");
  await ask.locator("button", { hasText: "Allow" }).first().click();

  const answered = await page.evaluate(() => (window as any).__fake.answered);
  expect(answered).toEqual([{ requestId: "/repo/one::t1", option: "allow" }]);
});

test("an answered question stops being a question", async ({ page }) => {
  await open(page);
  await openPlan(page);
  await page.keyboard.press("Meta+j");
  await say(page, "edit it");
  await page.evaluate(() => {
    (window as any).__fake.emit("agent-permission", {
      repo: "/repo/one",
      requestId: "r1",
      title: "Write note.md",
      options: [{ optionId: "allow", name: "Allow" }],
    });
  });
  await page.locator(".chat-ask button", { hasText: "Allow" }).click();

  // The backend confirms what was chosen, and the buttons become a statement:
  // one you could press again after the agent moved on would be a lie.
  await page.evaluate(() => {
    (window as any).__fake.emit("agent-permission-done", {
      repo: "/repo/one",
      requestId: "r1",
      chosen: "allow",
    });
  });
  await expect(page.locator(".chat-ask-was")).toHaveText("Allow");
  await expect(page.locator(".chat-ask button")).toHaveCount(0);
});

test("a question that was never answered is inert on the next launch", async ({ page }) => {
  await open(page);
  await openPlan(page);
  await page.keyboard.press("Meta+j");
  await say(page, "edit it");
  await page.evaluate(() => {
    (window as any).__fake.emit("agent-permission", {
      repo: "/repo/one",
      requestId: "r1",
      title: "Write note.md",
      options: [{ optionId: "allow", name: "Allow" }],
    });
  });
  // The agent's options, plus the app's own way out of the question.
  await expect(page.locator(".chat-ask button")).toHaveCount(2);

  // Reopening the panel rereads the transcript. The process that asked is
  // gone, so live-looking buttons wired to nothing would be the bug.
  // No ⌘J here: the panel being open is a persisted setting, so it comes back
  // open and the chord would close it.
  await page.reload();
  await expect(page.locator(".files")).toBeVisible();
  await expect(page.locator(".chat")).toBeVisible();
  await expect(page.locator(".chat-ask")).toContainText("Write note.md");
  await expect(page.locator(".chat-ask button")).toHaveCount(0);
  await expect(page.locator(".chat-ask-was")).toHaveText("cancelled");
});

test("asking is a setting, and off by default", async ({ page }) => {
  await open(page);
  await page.keyboard.press("Meta+,");
  await page.locator(".settings-filter").fill("ask before");

  const row = page.locator(".setting-row", { hasText: "Ask before acting" });
  await expect(row).toBeVisible();
  // Off means the backend answers for you — which is what it is told.
  await expect.poll(() => argsOf(page, "agent_auto_allow")).toContainEqual({ on: true });

  await row.locator(".switch").click();
  await expect.poll(() => argsOf(page, "agent_auto_allow")).toContainEqual({ on: false });
});

/*
 * What the agent says it can do.
 *
 * The point of every one of these is that the app knows nothing: no model
 * names, no effort levels, no command list. It draws what arrives.
 */

/** An option whose text is long enough to stretch anything that can stretch. */
const WORDY = {
  id: "agent",
  name: "Agent",
  currentValue: "delegator",
  options: [
    { value: "default", name: "Default", description: "Standard agent" },
    {
      value: "delegator",
      name: "delegator-with-a-very-long-persona-name-indeed",
      description:
        "Use this agent when the user has a quick, self-contained idea or tangential task they want explored or executed in parallel without interrupting or queuing onto the main agent's current workflow. ".repeat(
          3,
        ),
    },
  ],
};

/** Push the option list a real adapter sends when a session opens. */
async function advertise(page: Page) {
  await page.evaluate(() => {
    const f = (window as any).__fake;
    f.options = [
      {
        id: "agent",
        name: "Agent",
        currentValue: "default",
        options: [{ value: "default", name: "Default" }],
      },
      {
        id: "effort",
        name: "Effort",
        category: "thought_level",
        currentValue: "low",
        options: [
          { value: "low", name: "Low" },
          { value: "high", name: "High" },
        ],
      },
      {
        id: "model",
        name: "Model",
        category: "model",
        currentValue: "fable",
        options: [
          { value: "fable", name: "Fable" },
          { value: "haiku", name: "Haiku" },
        ],
      },
    ];
    f.emit("agent-config", { repo: "/repo/one", options: f.options });
  });
}

test("the model and effort pickers come from the agent", async ({ page }) => {
  await open(page);
  await openPlan(page);
  await page.keyboard.press("Meta+j");
  await advertise(page);

  // Reserved categories first, in a fixed order, then anything else — the
  // uncategorised "Agent" option must survive, not be curated away.
  const labels = await page.locator(".agent-option .dd-trigger").evaluateAll((els) =>
    els.map((e) => e.getAttribute("aria-label")),
  );
  expect(labels).toEqual(["Model", "Effort", "Agent"]);

  // In the composer, with the message they apply to — not at the top, where
  // they would read as a status bar for the conversation instead.
  const options = (await page.locator(".agent-options").boundingBox())!;
  const box = (await page.locator(".chat-input textarea").boundingBox())!;
  const log = (await page.locator(".chat-log").boundingBox())!;
  expect(options.y).toBeGreaterThan(box.y);
  expect(options.y).toBeGreaterThan(log.y + log.height - 1);
  await expect(page.locator('.agent-option [aria-label="Model"]')).toContainText("Fable");
});

test("choosing a model asks the agent, and shows the agent's answer", async ({ page }) => {
  await open(page);
  await openPlan(page);
  await page.keyboard.press("Meta+j");
  await advertise(page);

  await page.locator('.agent-option [aria-label="Model"]').click();
  await page.locator(".dd-item", { hasText: "Haiku" }).click();

  const [set] = await argsOf(page, "agent_set_config");
  expect(set).toEqual({ repo: "/repo/one", id: "model", value: "haiku" });

  // Redrawn from what the agent replied, not from the click: a choice can
  // change what else is on offer, and only the agent knows that.
  await page.evaluate(() => {
    const f = (window as any).__fake;
    f.emit("agent-config", { repo: "/repo/one", options: f.options });
  });
  await expect(page.locator('.agent-option [aria-label="Model"]')).toContainText("Haiku");
});

test("an agent with nothing to configure gets no toolbar", async ({ page }) => {
  await open(page);
  await openPlan(page);
  await page.keyboard.press("Meta+j");
  await expect(page.locator(".chat")).toBeVisible();
  await expect(page.locator(".agent-options")).toHaveCount(0);
});

test("slash commands complete from what the agent advertised", async ({ page }) => {
  await open(page);
  await openPlan(page);
  await page.keyboard.press("Meta+j");
  await page.evaluate(() => {
    (window as any).__fake.emit("agent-commands", {
      repo: "/repo/one",
      commands: [
        { name: "compact", description: "Shorten the conversation" },
        { name: "context", description: "What is in the context" },
        { name: "review", description: "Review the diff" },
      ],
    });
  });

  const box = page.locator(".chat-input textarea");
  await box.fill("/co");
  await expect(page.locator(".chat-slash-item")).toHaveCount(2);

  await box.press("ArrowDown");
  await box.press("Enter");
  await expect(box).toHaveValue("/compact ");
  // Completing is not sending: the agent parses the slash itself.
  expect(await calls(page, "agent_prompt")).toBe(0);
});

test("a slash you meant literally still sends", async ({ page }) => {
  await open(page);
  await openPlan(page);
  await page.keyboard.press("Meta+j");
  await page.evaluate(() => {
    (window as any).__fake.emit("agent-commands", {
      repo: "/repo/one",
      commands: [{ name: "compact", description: "Shorten" }],
    });
  });

  const box = page.locator(".chat-input textarea");
  await box.fill("/compact");
  // Enter with nothing highlighted sends, rather than completing something
  // you have already finished typing.
  await box.press("Enter");
  await expect.poll(() => calls(page, "agent_prompt")).toBe(1);
  const [sent] = await argsOf(page, "agent_prompt");
  expect(sent.text).toContain("/compact");
});

test("context and cost are shown in the status bar, and outlast the panel", async ({ page }) => {
  await open(page);
  await openPlan(page);
  await page.keyboard.press("Meta+j");

  await page.evaluate(() => {
    (window as any).__fake.emit("agent-usage", {
      repo: "/repo/one",
      used: 250000,
      size: 1000000,
      cost: 0.2811,
    });
  });
  await expect(page.locator(".bar")).toContainText("25% context");
  await expect(page.locator(".bar")).toContainText("$0.28");

  // A fact about the session, not about the panel: closing the chat does not
  // make it untrue.
  await page.keyboard.press("Meta+j");
  await expect(page.locator(".chat")).toHaveCount(0);
  await expect(page.locator(".bar")).toContainText("25% context");
});

test("the agent's task list is shown while it works", async ({ page }) => {
  await open(page);
  await openPlan(page);
  await page.keyboard.press("Meta+j");
  await say(page, "do a few things");

  await page.evaluate(() => {
    (window as any).__fake.emit("agent-plan", {
      repo: "/repo/one",
      entries: [
        { content: "Read the plan", status: "completed" },
        { content: "Rewrite the opening", status: "in_progress" },
        { content: "Check the citations", status: "pending" },
      ],
    });
  });

  const todo = page.locator(".chat-todo li");
  await expect(todo).toHaveCount(3);
  await expect(todo.nth(1)).toHaveClass(/in_progress/);

  // Amended rather than appended: a later plan replaces the earlier one.
  await page.evaluate(() => {
    (window as any).__fake.emit("agent-plan", {
      repo: "/repo/one",
      entries: [{ content: "Read the plan", status: "completed" }],
    });
  });
  await expect(page.locator(".chat-todo li")).toHaveCount(1);
});

test("a session is remembered, and offered back to the next process", async ({ page }) => {
  await open(page);
  await openPlan(page);
  await page.keyboard.press("Meta+j");
  await say(page, "first");
  await expect.poll(() => calls(page, "agent_prompt")).toBe(1);

  // The backend reports the session it opened.
  await page.evaluate(() => {
    (window as any).__fake.emit("agent-session", { repo: "/repo/one", sessionId: "sess-7" });
  });
  await finish(page, 1);

  // The agent dies between turns; the next prompt asks to pick it back up.
  await page.evaluate(() => {
    (window as any).__fake.emit("agent-down", { repo: "/repo/one", message: "" });
  });
  await say(page, "second");
  await expect.poll(() => calls(page, "agent_prompt")).toBe(2);
  const sent = await argsOf(page, "agent_prompt");
  expect(sent[0].resume).toBe(null);
  expect(sent[1].resume).toBe("sess-7");
});

test("the answer is rendered as markdown, and never as markup", async ({ page }) => {
  await open(page);
  await openPlan(page);
  await page.keyboard.press("Meta+j");
  await say(page, "explain");

  await page.evaluate(() => {
    const f = (window as any).__fake;
    f.emit("agent-message", {
      repo: "/repo/one",
      turn: 1,
      text: "Use **status** and `plans/`:\n- first\n- second\n\n```\ncargo test\n```",
    });
  });

  const bubble = page.locator(".chat-msg.assistant");
  await expect(bubble.locator("strong")).toHaveText("status");
  await expect(bubble.locator("code").first()).toHaveText("plans/");
  await expect(bubble.locator(".chat-md-list li")).toHaveCount(2);
  await expect(bubble.locator(".chat-md-code")).toContainText("cargo test");
});

test("html in an answer is text, not html", async ({ page }) => {
  await open(page);
  await openPlan(page);
  await page.keyboard.press("Meta+j");
  await say(page, "explain");

  // The agent's prose comes from files, and a file is not something to hand
  // the DOM as markup.
  await page.evaluate(() => {
    (window as any).__fake.emit("agent-message", {
      repo: "/repo/one",
      turn: 1,
      text: "<img src=x onerror=alert(1)> and <b>bold</b>",
    });
  });

  const bubble = page.locator(".chat-msg.assistant");
  await expect(bubble).toContainText("<img src=x onerror=alert(1)>");
  await expect(bubble.locator("img")).toHaveCount(0);
  await expect(bubble.locator("b")).toHaveCount(0);
});

test("what you typed is shown as you typed it", async ({ page }) => {
  await open(page);
  await openPlan(page);
  await page.keyboard.press("Meta+j");
  await say(page, "what does **this** mean?");

  // Only the agent's prose is rendered; your own asterisks are yours.
  await expect(page.locator(".chat-msg.user")).toContainText("**this**");
  await expect(page.locator(".chat-msg.user strong")).toHaveCount(0);
});

test("an agent can be installed so it stops being fetched every time", async ({ page }) => {
  await open(page);
  await page.keyboard.press("Meta+,");
  await page.locator(".settings-filter").fill("started as");

  const row = page.locator(".setting-row", { hasText: "Started as" });
  // npx is the fallback: it re-resolves the package on every launch.
  await expect(row).toContainText("npx");
  await row.locator("button.act", { hasText: "Install" }).click();

  // Afterwards it runs the binary directly, and stops offering.
  await expect(row).toContainText("claude-agent-acp");
  await expect(row).not.toContainText("npx");
  await expect(row.locator(".act.done")).toHaveText("Installed");
});

test("an old chat is left behind, not dragged into the new one", async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    // What the previous design wrote: a transcript plus a CLI session id that
    // no ACP agent can do anything with.
    localStorage.setItem(
      "plans.chat.v2::/repo/one",
      JSON.stringify({
        messages: [{ role: "user", text: "an old question" }],
        session: "old-cli-session",
      }),
    );
  });
  await page.reload();
  await openPlan(page);
  await page.keyboard.press("Meta+j");
  await expect(page.locator(".chat")).toBeVisible();

  // A conversation the agent has no memory of is a conversation on one side.
  await expect(page.locator(".chat-log")).not.toContainText("an old question");
  await expect(page.locator(".chat-hint")).toBeVisible();

  // Left on disk, though: not shown is not the same as deleted.
  const kept = await page.evaluate(() => localStorage.getItem("plans.chat.v2::/repo/one"));
  expect(kept).toContain("an old question");
});

test("a wordy option cannot stretch the window", async ({ page }) => {
  await open(page, { place: "side" });
  await openPlan(page);
  await page.keyboard.press("Meta+j");
  const before = (await page.locator(".chat").boundingBox())!;
  const overBefore = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );

  await page.evaluate((wordy) => {
    const f = (window as any).__fake;
    f.options = [wordy];
    f.emit("agent-config", { repo: "/repo/one", options: f.options });
  }, WORDY);
  await expect(page.locator(".agent-option")).toHaveCount(1);

  // The panel is a grid column, and a grid item's default min-width lets an
  // over-wide child stretch its track — which pushed the whole window sideways.
  const after = (await page.locator(".chat").boundingBox())!;
  expect(Math.abs(after.width - before.width)).toBeLessThan(2);
  // The symptom was the whole app sliding left, so that is what is asserted:
  // the tree still starts at the window's edge. The panel's own x can wander
  // a couple of pixels when a scrollbar appears, which is not the same thing.
  const tree = (await page.locator(".files").boundingBox())!;
  expect(tree.x).toBe(0);
  // The pickers add no horizontal overflow of their own — measured against
  // what the window already had, which is not this feature's to fix.
  const over = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(over).toBeLessThanOrEqual(overBefore);
});

test("a menu shows every option at once, whole", async ({ page }) => {
  await open(page, { place: "side" });
  await openPlan(page);
  await page.keyboard.press("Meta+j");
  await page.evaluate((wordy) => {
    const f = (window as any).__fake;
    f.options = [wordy];
    f.emit("agent-config", { repo: "/repo/one", options: f.options });
  }, WORDY);

  await page.locator('.agent-option [aria-label="Agent"]').click();
  const menu = page.locator(".agent-option .dd-menu");

  // Nothing scrolls: a picker you have to scroll is a picker you have to
  // search, and the point of these is to see what the agent offers.
  const scrolls = await menu.evaluate((el) => el.scrollHeight > el.clientHeight + 1);
  expect(scrolls).toBe(false);

  // And nothing is clipped: a description cut mid-word tells you less than
  // the name already did.
  const clipped = await page
    .locator(".agent-option .dd-note")
    .evaluateAll((els) => els.some((e) => e.scrollHeight > e.clientHeight + 1));
  expect(clipped).toBe(false);
});

test("an open menu stays inside the panel", async ({ page }) => {
  await open(page, { place: "side" });
  await openPlan(page);
  await page.keyboard.press("Meta+j");
  await page.evaluate((wordy) => {
    const f = (window as any).__fake;
    f.options = [wordy];
    f.emit("agent-config", { repo: "/repo/one", options: f.options });
  }, WORDY);

  await page.locator('.agent-option [aria-label="Agent"]').click();
  const menu = (await page.locator(".agent-option .dd-menu").boundingBox())!;
  const trigger = (await page.locator('.agent-option [aria-label="Agent"]').boundingBox())!;

  // Anchored on the end of the button, growing back into the space there is.
  expect(Math.round(menu.x + menu.width)).toBeLessThanOrEqual(
    Math.round(trigger.x + trigger.width) + 1,
  );
  expect(menu.x).toBeGreaterThanOrEqual(0);
});

test("effort reads as a scale, not as a list of alternatives", async ({ page }) => {
  await open(page);
  await openPlan(page);
  await page.keyboard.press("Meta+j");
  await page.evaluate(() => {
    const f = (window as any).__fake;
    // The order a real adapter sends: default first, then ascending.
    f.options = [
      {
        id: "effort",
        name: "Effort",
        category: "thought_level",
        currentValue: "low",
        options: [
          { value: "default", name: "Default" },
          { value: "low", name: "Low" },
          { value: "medium", name: "Medium" },
          { value: "high", name: "High" },
          { value: "xhigh", name: "Xhigh" },
          { value: "max", name: "Max" },
        ],
      },
    ];
    f.emit("agent-config", { repo: "/repo/one", options: f.options });
  });

  await page.locator('.agent-option [aria-label="Effort"]').click();
  const shown = await page.locator(".agent-option .dd-item .dd-label").allTextContents();

  // The menu opens upward from the composer, so hardest-first in the markup
  // reads lowest-to-highest from the bottom, with Default nearest the button.
  expect(shown).toEqual(["Max", "Xhigh", "High", "Medium", "Low", "Default"]);
});

test("a model list is left in the order the agent chose", async ({ page }) => {
  await open(page);
  await openPlan(page);
  await page.keyboard.press("Meta+j");
  await advertise(page);

  // Only effort is a scale. A model list is a set of alternatives, and the
  // agent's own order is the one that means something.
  await page.locator('.agent-option [aria-label="Model"]').click();
  const shown = await page.locator(".agent-option .dd-item .dd-label").allTextContents();
  expect(shown).toEqual(["Fable", "Haiku"]);
});

test("switching agents starts a new session, and says so", async ({ page }) => {
  await open(page);
  await page.evaluate(() => ((window as any).__fake.codex = "codex 1.0"));
  await openPlan(page);
  await page.keyboard.press("Meta+j");
  await say(page, "first");
  await expect.poll(() => calls(page, "agent_prompt")).toBe(1);
  await page.evaluate(() => {
    (window as any).__fake.emit("agent-session", { repo: "/repo/one", sessionId: "claude-1" });
  });
  await finish(page, 1);

  // Pick the other agent.
  await page.keyboard.press("Meta+,");
  await page
    .locator(".setting-row", { hasText: "Chat agent" })
    .locator("button", { hasText: "Codex" })
    .click();
  // Leaving settings is enough: the panel being open is a persisted setting.
  await page.keyboard.press("Escape");
  await expect(page.locator(".chat")).toBeVisible();

  await say(page, "second");
  await expect.poll(() => calls(page, "agent_prompt")).toBe(2);
  const sent = await argsOf(page, "agent_prompt");
  expect(sent[1].agent).toBe("codex");
  // A session belongs to the agent that opened it; offering it to another is
  // asking for a refusal.
  expect(sent[1].resume).toBe(null);

  // The transcript stays — it is what was said — and says what happened.
  await expect(page.locator(".chat-log")).toContainText("first");
  await expect(page.locator(".chat-log")).toContainText("Switched to codex");
});

/*
 * Chats, of which there are now more than one per repository.
 */

test("New starts a fresh conversation and keeps the old one", async ({ page }) => {
  await open(page);
  await openPlan(page);
  await page.keyboard.press("Meta+j");
  await say(page, "the first conversation");
  await expect.poll(() => calls(page, "agent_prompt")).toBe(1);
  await finish(page, 1);

  await page.locator(".mux-key", { hasText: "New" }).click();

  // Blank, and the agent's session ends with it — a new conversation the
  // agent still remembers the last one from is new in name only.
  await expect(page.locator(".chat-msg.user")).toHaveCount(0);
  await expect.poll(() => calls(page, "agent_stop")).toBe(1);

  // The old one is still there, named after what it was about.
  await page.locator('[aria-label="Conversation"]').click();
  await expect(page.locator(".dd-item")).toContainText(["New chat", "the first conversation"]);
});

test("an old conversation can be opened again", async ({ page }) => {
  await open(page);
  await openPlan(page);
  await page.keyboard.press("Meta+j");
  await say(page, "remember this one");
  await finish(page, 1);
  await page.locator(".mux-key", { hasText: "New" }).click();
  await say(page, "and this one");
  await finish(page, 2);

  await page.locator('[aria-label="Conversation"]').click();
  await page.locator(".dd-item", { hasText: "remember this one" }).click();
  await expect(page.locator(".chat-msg.user")).toContainText("remember this one");
  await expect(page.locator(".chat-log")).not.toContainText("and this one");
});

test("/clear clears the chat, which is what it looks like it does", async ({ page }) => {
  await open(page);
  await openPlan(page);
  await page.keyboard.press("Meta+j");
  await say(page, "something to forget");
  await expect.poll(() => calls(page, "agent_prompt")).toBe(1);
  await finish(page, 1);

  await say(page, "/clear");

  // Not sent on: passed to the agent it clears the agent's context and leaves
  // the transcript on screen, which looks exactly like nothing happening.
  expect(await calls(page, "agent_prompt")).toBe(1);
  await expect(page.locator(".chat-msg.user")).toHaveCount(0);
  await expect.poll(() => calls(page, "agent_stop")).toBe(1);
});

test("chats are per repository, and survive a restart", async ({ page }) => {
  await open(page);
  await openPlan(page);
  await page.keyboard.press("Meta+j");
  await say(page, "a question worth keeping");
  await finish(page, 1);

  await page.reload();
  await expect(page.locator(".files")).toBeVisible();
  await expect(page.locator(".chat-msg.user")).toContainText("a question worth keeping");
});

test("chats are reachable from the palette", async ({ page }) => {
  await open(page);
  await openPlan(page);
  await page.keyboard.press("Meta+j");
  await say(page, "the first conversation");
  await finish(page, 1);

  // New, from the palette.
  await page.keyboard.press("Meta+p");
  await page.locator(".palette-input").fill(">new chat");
  await expect(page.locator(".palette-row").first()).toContainText(/new chat/i);
  await page.keyboard.press("Enter");
  await expect(page.locator(".chat-msg.user")).toHaveCount(0);

  // And back to the old one, by the name it gave itself.
  await page.keyboard.press("Meta+p");
  await page.locator(".palette-input").fill(">first conversation");
  await expect(page.locator(".palette-row").first()).toContainText("the first conversation");
  await page.keyboard.press("Enter");
  await expect(page.locator(".chat-msg.user")).toContainText("the first conversation");
});

test("the palette does not offer the chat you are already in", async ({ page }) => {
  await open(page);
  await openPlan(page);
  await page.keyboard.press("Meta+j");
  await say(page, "the only conversation");
  await finish(page, 1);

  await page.keyboard.press("Meta+p");
  await page.locator(".palette-input").fill(">only conversation");
  // "Chat: …" is a way of going somewhere, and you are already there.
  await expect(page.locator(".palette-row", { hasText: "Chat: the only" })).toHaveCount(0);
});

test("# shows the chats, and takes you to one", async ({ page }) => {
  await open(page);
  await openPlan(page);
  await page.keyboard.press("Meta+j");
  await say(page, "the first conversation");
  await finish(page, 1);
  await page.locator(".mux-key", { hasText: "New" }).click();
  await say(page, "the second conversation");
  await finish(page, 2);

  await page.keyboard.press("Meta+p");
  await page.locator(".palette-input").fill("#");
  await expect(page.locator(".palette-foot")).toContainText(/chats/i);
  // Both of them: this is a list to read, and one with a hole in it is
  // harder to read than one without.
  await expect(page.locator(".palette-row")).toHaveCount(2);

  await page.locator(".palette-input").fill("#first");
  await expect(page.locator(".palette-row").first()).toContainText("the first conversation");
  await page.keyboard.press("Enter");
  await expect(page.locator(".chat-msg.user")).toContainText("the first conversation");
});

test("the chat you are in says so", async ({ page }) => {
  await open(page);
  await openPlan(page);
  await page.keyboard.press("Meta+j");
  await say(page, "only one so far");
  await finish(page, 1);

  await page.keyboard.press("Meta+p");
  await page.locator(".palette-input").fill("#only");
  await expect(page.locator(".palette-row").first()).toContainText("current");
});
