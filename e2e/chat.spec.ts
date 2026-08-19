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
  await page.locator(".page-act", { hasText: "Flesh out" }).click();

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
