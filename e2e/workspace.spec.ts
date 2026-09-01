/**
 * A workspace, end to end: two people in one document.
 *
 * The Rust boundary is faked as everywhere else, but the workspace server is
 * real — started here, in memory, with the dev sign-in on — because the whole
 * feature is the wire, and a fake of the wire would prove nothing. Two browser
 * contexts play two people; what is asserted is what each of them sees.
 */
import { test, expect, type Browser, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { installFakeBackend, type FakeRepo } from "./fake-backend";

// One server per file, one file per worker: serial keeps the port to one owner.
test.describe.configure({ mode: "serial" });

const REPOS: FakeRepo[] = [
  {
    path: "/repo/one",
    name: "one",
    branch: "main",
    files: { "plans/existing.md": "---\nstatus: draft\n---\n\n# Existing\n" },
  },
];

let server: ChildProcess;
let base: string;

test.beforeAll(async ({}, info) => {
  const port = 1431 + info.workerIndex;
  base = `http://127.0.0.1:${port}`;
  const entry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../server/src/index.js");
  server = spawn(process.execPath, [entry], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      WORKSPACES_DB: ":memory:",
      WORKSPACES_DEV_LOGIN: "1",
    },
    stdio: "ignore",
  });
  const until = Date.now() + 15_000;
  while (Date.now() < until) {
    try {
      if ((await fetch(`${base}/health`)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("the workspace server did not come up");
});

test.afterAll(() => {
  server?.kill();
});

async function session(login: string): Promise<string> {
  const r = await fetch(`${base}/auth/dev`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ login }),
  });
  return (await r.json()).token;
}

/** Boot the app as one person: signed in, pointed at the test's server. */
async function boot(browser: Browser, login: string): Promise<Page> {
  const token = await session(login);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const faults: string[] = [];
  page.on("pageerror", (e) => faults.push(e.message));
  await page.addInitScript(
    ([fn, list, tok, url]) => {
      // eslint-disable-next-line no-new-func
      new Function(`return ${fn}`)()(list);
      (window as any).__fake.workspaceToken = tok;
      localStorage.setItem("plans.workspaceServer", url as string);
      localStorage.setItem(
        "plans.repos.v1",
        JSON.stringify((list as FakeRepo[]).map((r) => r.path)),
      );
      localStorage.setItem("plans.tabs.v1", "[]");
    },
    [installFakeBackend.toString(), REPOS, token, base] as const,
  );
  await page.goto("/");
  await expect(page.getByTestId("account")).toHaveText(`@${login}`);
  (page as any).__faults = faults;
  return page;
}

const editor = (page: Page) => page.locator(".milkdown .ProseMirror");

test("two people argue a plan in one room, review it, and copy it out", async ({ browser }) => {
  const alice = await boot(browser, "alice");

  // A room with only alice in it.
  await alice.locator(".ws-new").click();
  await alice.locator(".matter-sheet .name-field").fill("Roadmap");
  await alice.locator(".matter-sheet .act", { hasText: "Create" }).click();
  await expect(alice.locator(".page-path")).toHaveText("workspace · Roadmap");
  await expect(editor(alice).locator("h1")).toHaveText("Roadmap");
  await expect(alice.locator(".ws-row", { hasText: "Roadmap" })).toBeVisible();

  // Bob is not in it yet, and sees nothing.
  const bob = await boot(browser, "bob");
  await expect(bob.locator(".ws-hint")).toContainText("None yet");

  await alice.locator(".page-actions .rail-btn", { hasText: "Invite" }).click();
  await alice.locator(".matter-sheet .name-field").fill("bob");
  await alice.locator(".matter-sheet .act", { hasText: "Invite" }).click();

  // The invite reaches bob on his next look at the list.
  await bob.reload();
  await expect(bob.getByTestId("account")).toHaveText("@bob");
  await bob.locator(".ws-row", { hasText: "Roadmap" }).click();
  await expect(editor(bob).locator("h1")).toHaveText("Roadmap");

  // Alice types; bob sees the words and where alice is.
  await editor(alice).locator("h1").click();
  await alice.keyboard.press("End");
  await alice.keyboard.press("Enter");
  await alice.keyboard.type("Ship the room first.");
  await expect(editor(bob)).toContainText("Ship the room first.");
  await expect(bob.locator(".ProseMirror-yjs-cursor")).toBeVisible();
  await expect(bob.locator(".ProseMirror-yjs-cursor > div")).toHaveText("alice");

  // And the other way.
  await editor(bob).locator("p", { hasText: "Ship the room" }).click();
  await bob.keyboard.press("End");
  await bob.keyboard.type(" Then the door.");
  await expect(editor(alice)).toContainText("Ship the room first. Then the door.");

  // Alice asks for review, and cannot be the one who grants it.
  await alice.locator(".page-actions .rail-btn", { hasText: "Request review" }).click();
  await expect(alice.getByTestId("review-state")).toHaveText("in review");
  await expect(alice.locator(".page-actions .rail-btn", { hasText: "Approve" })).toBeDisabled();

  // Bob heard about it over the wire, and can.
  await expect(bob.getByTestId("review-state")).toHaveText("in review");
  const approve = bob.locator(".page-actions .rail-btn", { hasText: "Approve" });
  await expect(approve).toBeEnabled();
  await approve.click();
  await expect(bob.getByTestId("review-state")).toHaveText("approved");
  await expect(alice.getByTestId("review-state")).toHaveText("approved");
  await expect(alice.locator(".ws-row .status-dot.tone-approved")).toBeVisible();

  // Out of the room and into the repository, stamped with the outcome.
  await alice.locator(".page-actions .rail-btn", { hasText: "Copy to repository" }).click();
  await expect(alice.locator(".matter-sheet .name-field")).toHaveValue("Roadmap");
  // Nothing has been created in this repository yet, so the root it is.
  await expect(alice.locator(".matter-sheet .name-path")).toHaveText("Roadmap.md");
  await alice.locator(".matter-sheet .act", { hasText: "Copy" }).click();

  await expect(alice.locator(".page-path")).toHaveText("Roadmap.md");
  const written = await alice.evaluate(() => (window as any).__fake.repos[0].files["Roadmap.md"]);
  expect(written).toContain("status: ready");
  expect(written).toContain("approved-by: bob");
  expect(written).toContain("# Roadmap");
  expect(written).toContain("Ship the room first. Then the door.");

  // The server hands the same text to anyone holding the workspace's token.
  const token = await session("alice");
  const list = await (await fetch(`${base}/workspaces`, { headers: { Authorization: `Bearer ${token}` } })).json();
  const minted = await (
    await fetch(`${base}/workspaces/${list[0].id}/token`, { method: "POST", headers: { Authorization: `Bearer ${token}` } })
  ).json();
  const served = await (await fetch(`${base}/w/${list[0].id}/plan.md`, { headers: { Authorization: `Bearer ${minted.token}` } })).text();
  expect(served).toContain("Ship the room first. Then the door.");

  expect((alice as any).__faults).toEqual([]);
  expect((bob as any).__faults).toEqual([]);
});

test("signed out, the section invites you in and the sign-in sheet shows a code", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.addInitScript(
    ([fn, list, url]) => {
      // eslint-disable-next-line no-new-func
      new Function(`return ${fn}`)()(list);
      localStorage.setItem("plans.workspaceServer", url as string);
      localStorage.setItem("plans.repos.v1", JSON.stringify((list as FakeRepo[]).map((r) => r.path)));
      localStorage.setItem("plans.tabs.v1", "[]");
    },
    [installFakeBackend.toString(), REPOS, base] as const,
  );
  await page.goto("/");
  await expect(page.getByTestId("sign-in")).toBeVisible();
  await expect(page.locator(".ws-hint")).toContainText("Sign in with GitHub");

  // This server has no OAuth app, so the sheet says so rather than hanging.
  await page.getByTestId("sign-in").click();
  await expect(page.getByTestId("signin")).toBeVisible();
  await expect(page.locator(".signin-error")).toContainText("not configured");
});
