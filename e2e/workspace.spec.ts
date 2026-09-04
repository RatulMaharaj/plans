/**
 * A workspace, end to end: two people in one document.
 *
 * The Rust boundary is faked as everywhere else, but the workspace server is
 * real — started here, in memory, with the dev sign-in on — because the whole
 * feature is the wire, and a fake of the wire would prove nothing. Two browser
 * contexts play two people; what is asserted is what each of them sees.
 */
import { test, expect, type Browser, type Locator, type Page } from "@playwright/test";
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
  await expect(page.getByTestId("account")).toHaveText(login);
  (page as any).__faults = faults;
  return page;
}

const editor = (page: Page) => page.locator(".milkdown .ProseMirror");

/** The heading a workspace has in the file tree. */
const heading = (page: Page, name: string) => page.locator(".row.repo.ws", { hasText: name });
const row = (page: Page, name: string) => page.locator(".row.file", { hasText: name });

/** Right-click a row and press one item of the menu that opens. */
async function menu(page: Page, at: Locator, item: string) {
  await at.click({ button: "right" });
  await page.locator(".ctx .ctx-item", { hasText: item }).first().click();
}

/** Answer the one-line question a menu item asked. */
async function answer(page: Page, value: string, confirm: string) {
  await page.locator(".matter-sheet .name-field").fill(value);
  await page.locator(".matter-sheet .act", { hasText: confirm }).click();
}

/** The workspace the signed-in person has, for the endpoints below. */
async function only(token: string) {
  const list = await (await fetch(`${base}/workspaces`, { headers: { Authorization: `Bearer ${token}` } })).json();
  return list[0].id;
}


test("a workspace is a folder in the tree, and both people see every change", async ({ browser }) => {
  const alice = await boot(browser, "alice");

  // A workspace is a heading in the file tree, with one file already in it.
  await alice.locator(".ws-new").click();
  await answer(alice, "Roadmap", "Create");
  await expect(heading(alice, "Roadmap")).toBeVisible();
  await expect(alice.locator(".page-path")).toHaveText("Roadmap · plan.md");
  await expect(editor(alice).locator("h1")).toHaveText("Roadmap");

  // Untouched, the file already answers as a file: the template is published
  // without anyone typing, or the factory would read an empty plan.
  const aliceToken = await session("alice");
  const id = await only(aliceToken);
  await expect
    .poll(async () =>
      (await fetch(`${base}/w/${id}/plan.md`, { headers: { Authorization: `Bearer ${aliceToken}` } })).text(),
    )
    .toContain("# Roadmap");

  // Bob is not in it yet, and sees nothing.
  const bob = await boot(browser, "bob");
  await expect(bob.locator(".ws-hint")).toContainText("None yet");

  await alice.locator(".page-actions .rail-btn", { hasText: "Invite" }).click();
  await answer(alice, "bob", "Invite");

  // The invite reaches bob on his next look at the list, and what he gets is
  // the folder — drawn from the tree, without a socket into it yet.
  await bob.reload();
  await expect(bob.getByTestId("account")).toHaveText("bob");
  await expect(heading(bob, "Roadmap")).toBeVisible();
  await heading(bob, "Roadmap").click();
  await row(bob, "plan").click();
  await expect(editor(bob).locator("h1")).toHaveText("Roadmap");

  // Alice types; bob sees the words and where alice is.
  await editor(alice).locator("h1").click();
  await alice.keyboard.press("End");
  await alice.keyboard.press("Enter");
  await alice.keyboard.type("Ship the room first.");
  await expect(editor(bob)).toContainText("Ship the room first.");
  await expect(bob.locator(".ProseMirror-yjs-cursor")).toBeVisible();
  await expect(bob.locator(".ProseMirror-yjs-cursor > div")).toHaveText("alice");

  // Alice makes a folder and a file in it. Bob's tree grows on its own.
  await heading(alice, "Roadmap").click({ button: "right" });
  await alice.locator(".ctx .ctx-item", { hasText: "New folder here" }).click();
  await answer(alice, "notes", "Create");
  await expect(alice.locator(".row.dir", { hasText: "notes" })).toBeVisible();
  await expect(bob.locator(".row.dir", { hasText: "notes" })).toBeVisible();

  await alice.locator(".row.dir", { hasText: "notes" }).click({ button: "right" });
  await alice.locator(".ctx .ctx-item", { hasText: "New file here" }).click();
  await answer(alice, "risks.md", "Create");
  await expect(alice.locator(".page-path")).toHaveText("Roadmap · notes/risks.md");
  await expect(editor(alice).locator("h1")).toHaveText("Risks");

  // Bob sees it appear and opens it — the same document, not a copy. The
  // folder arrived closed, as folders do; the file is behind one click.
  await bob.locator(".row.dir", { hasText: "notes" }).click();
  await expect(row(bob, "risks")).toBeVisible();
  await row(bob, "risks").click();
  await editor(bob).locator("h1").click();
  await bob.keyboard.press("End");
  await bob.keyboard.press("Enter");
  await bob.keyboard.type("The server falls over.");
  await expect(editor(alice)).toContainText("The server falls over.");

  // Faces: alice sees bob beside the file he is in and at the top of it; a
  // dev login has no picture, so his is the letter on his colour.
  await expect(row(alice, "risks").locator(".presence .avatar")).toHaveAttribute("title", "bob");
  await expect(alice.locator(".page-head > .presence .avatar")).toHaveAttribute("title", "bob");
  await expect(alice.locator(".page-head > .presence .avatar")).toHaveText("B");
  await expect(bob.locator(".page-head > .presence .avatar")).toHaveAttribute("title", "alice");

  // The raw file is there, and an edit to it goes through the shared
  // document like any other: bob sees it in his page.
  await alice.locator(".view-switch button", { hasText: "Source" }).click();
  const src = alice.locator(".surface:not(.aside) .cm-content");
  await expect(src).toContainText("The server falls over.");
  await src.click();
  await alice.keyboard.press("Meta+End");
  await alice.keyboard.type("\nFrom the source.");
  await expect(editor(bob)).toContainText("From the source.", { timeout: 10_000 });
  await alice.locator(".view-switch button", { hasText: "Write" }).click();
  await expect(editor(alice)).toContainText("From the source.");

  // A rename lands on both sides mid-edit, and the document travels with it:
  // alice is still typing into the file bob renamed.
  await menu(bob, row(bob, "risks"), "Rename…");
  await answer(bob, "dangers.md", "Rename");
  await expect(row(alice, "dangers")).toBeVisible();
  await expect(alice.locator(".page-path")).toHaveText("Roadmap · notes/dangers.md");
  // A rename onto a name that exists is refused, and both files stay.
  await heading(bob, "Roadmap").click({ button: "right" });
  await bob.locator(".ctx .ctx-item", { hasText: "New file here" }).click();
  await answer(bob, "scratch.md", "Create");
  await expect(bob.locator(".page-path")).toHaveText("Roadmap · scratch.md");
  await menu(bob, row(bob, "scratch"), "Rename…");
  await answer(bob, "plan.md", "Rename");
  await expect(bob.locator(".toast")).toContainText("already here");
  await expect(row(bob, "plan")).toBeVisible();
  await expect(row(bob, "scratch")).toBeVisible();
  await row(bob, "dangers").click();
  await editor(alice).locator("p", { hasText: "falls over" }).click();
  await alice.keyboard.press("End");
  await alice.keyboard.type(" Twice.");
  await expect(editor(bob)).toContainText("The server falls over. Twice.");


  // And the read endpoint knows the folder by its new name.
  await expect
    .poll(async () =>
      (
        await fetch(`${base}/w/${id}/notes/dangers.md`, {
          headers: { Authorization: `Bearer ${aliceToken}` },
        })
      ).text(),
    )
    .toContain("The server falls over. Twice.");

  expect((alice as any).__faults).toEqual([]);
  expect((bob as any).__faults).toEqual([]);

  // Bob leaves; the heading goes from his tree and nobody else's. Alice,
  // who made it, deletes it, and it is gone from hers too.
  bob.on("dialog", (d) => void d.accept());
  alice.on("dialog", (d) => void d.accept());
  await heading(bob, "Roadmap").click({ button: "right" });
  await expect(bob.locator(".ctx .ctx-item", { hasText: "Leave this workspace" })).toBeVisible();
  await bob.locator(".ctx .ctx-item", { hasText: "Leave this workspace" }).click();
  await expect(heading(bob, "Roadmap")).toHaveCount(0);
  await expect(heading(alice, "Roadmap")).toBeVisible();
  await heading(alice, "Roadmap").click({ button: "right" });
  await alice.locator(".ctx .ctx-item", { hasText: "Delete this workspace" }).click();
  await expect(heading(alice, "Roadmap")).toHaveCount(0);
  await expect(alice.locator(".page-path")).toHaveText("");
});

test("two accounts make a two-voice thread, signed by login, and it travels into a repository verbatim", async ({
  browser,
}) => {
  const alice = await boot(browser, "alice");
  await alice.locator(".ws-new").click();
  await answer(alice, "Threads", "Create");
  await expect(editor(alice).locator("h1")).toHaveText("Threads");
  await alice.locator(".page-actions .rail-btn", { hasText: "Invite" }).click();
  await answer(alice, "bob", "Invite");

  const bob = await boot(browser, "bob");
  await expect(heading(bob, "Threads")).toBeVisible();
  await heading(bob, "Threads").click();
  await row(bob, "plan").click();
  await expect(editor(bob).locator("h1")).toHaveText("Threads");

  // Alice comments on a line. The prompt says the account signs it, and the
  // comment lands signed with her login rather than anything git says.
  await editor(alice).locator("h1").click();
  await alice.keyboard.press("End");
  await alice.keyboard.press("Enter");
  await alice.keyboard.type("Ship the room first.");
  await alice.keyboard.press("Meta+Shift+m");
  await expect(alice.locator(".matter-sheet .name-path")).toContainText("<!-- @alice: … -->");
  await expect(alice.locator(".matter-sheet .name-path")).toContainText("your account");
  const ask = alice.locator(".matter-sheet textarea");
  await ask.fill("Is this the right order? Ask ");
  // `@` completes to a member's handle.
  await ask.press("@");
  await ask.press("b");
  await expect(alice.locator(".mentions-item")).toHaveText(["@bob"]);
  await ask.press("Enter");
  await expect(ask).toHaveValue("Is this the right order? Ask @bob ");
  await alice.locator(".matter-sheet .act").click();
  await expect(alice.locator(".md-comment")).toHaveCount(1);

  // Bob sees the comment, and his reply is his own handle: a second voice.
  await expect(bob.locator(".md-comment")).toHaveCount(1);
  await bob.locator(".md-comment-mark").click();
  const field = bob.locator(".md-comment-field");
  await expect(field).toHaveAttribute("placeholder", "Reply as @bob");
  await field.fill("Yes, the room first. ");
  await field.press("@");
  await field.press("a");
  await expect(bob.locator(".mentions-item")).toHaveText(["@alice"]);
  await field.press("Enter");
  await expect(field).toHaveValue("Yes, the room first. @alice ");
  await field.press("Enter");

  // Alice's card: two turns, each a member with the face their cursor wears.
  await expect(alice.locator(".md-comment-mark")).toHaveText("comment +2");
  await alice.locator(".md-comment-mark").click();
  await expect(alice.locator(".md-comment-handle")).toHaveText(["@alice", "@bob"]);
  await expect(alice.locator(".md-comment-who .avatar")).toHaveText(["A", "B"]);
  await expect(alice.locator(".md-comment-who .avatar").nth(1)).toHaveAttribute("title", "bob");
  await alice.keyboard.press("Escape");

  // On the public page the handles keep their colours and lose the faces:
  // a reader is anonymous, and the member list never reaches the page.
  await alice.getByTestId("share-plan").click();
  await alice.getByTestId("publish").click();
  const url = await alice.getByTestId("share-link").inputValue();
  await alice.keyboard.press("Escape");
  const reader = await readerFor(browser, idOf(url));
  await expect(reader.locator(".md-comment-mark")).toHaveText("comment +2", { timeout: 20_000 });
  await reader.locator(".md-comment-mark").click();
  await expect(reader.locator(".md-comment-handle")).toHaveText(["@alice", "@bob"]);
  await expect(reader.locator(".md-comment-handle").first()).toHaveCSS("color", /rgb\(/);
  await expect(reader.locator(".md-comment-who .avatar")).toHaveCount(0);

  // Copied into a repository, the thread is the same lines of the same file.
  await alice.locator(".page-actions .rail-btn", { hasText: "Copy to repository" }).click();
  await alice.locator(".matter-sheet .act", { hasText: "Copy" }).click();
  await expect(alice.locator(".page-path")).not.toContainText("Threads ·");
  const copied = await alice.evaluate(() => {
    const repo = (window as any).__fake.repos[0];
    return Object.values(repo.files as Record<string, string>).find((f) => f.includes("@bob:")) ?? "";
  });
  expect(copied).toContain("<!--\n@alice: Is this the right order? Ask @bob\n@bob: Yes, the room first. @alice\n-->");

  expect((alice as any).__faults).toEqual([]);
  expect((bob as any).__faults).toEqual([]);
});

test("the read endpoint lists the tree and answers a path, for a member or the workspace's token", async ({
  browser,
}) => {
  const alice = await boot(browser, "alice");
  await alice.locator(".ws-new").click();
  await answer(alice, "Reading", "Create");
  await expect(editor(alice).locator("h1")).toHaveText("Reading");

  await heading(alice, "Reading").click({ button: "right" });
  await alice.locator(".ctx .ctx-item", { hasText: "New file here" }).click();
  await answer(alice, "second.md", "Create");
  await expect(alice.locator(".page-path")).toHaveText("Reading · second.md");

  const token = await session("alice");
  const id = await only(token);
  const minted = await (
    await fetch(`${base}/workspaces/${id}/token`, { method: "POST", headers: { Authorization: `Bearer ${token}` } })
  ).json();
  const key = { Authorization: `Bearer ${minted.token}` };

  // The listing is the folder; the old `plan.md` shape still answers.
  await expect
    .poll(async () => {
      const r = await fetch(`${base}/w/${id}/`, { headers: key });
      return r.ok ? (await r.json()).files.map((f: { path: string }) => f.path).sort() : [];
    })
    .toEqual(["plan.md", "second.md"]);
  expect(await (await fetch(`${base}/w/${id}/plan.md`, { headers: key })).text()).toContain("# Reading");
  await expect
    .poll(async () => (await fetch(`${base}/w/${id}/second.md`, { headers: key })).text())
    .toContain("# Second");

  // A repository's file dropped on the workspace becomes a shared copy: in
  // the tree, open on the page, and answered by the read endpoint at once.
  const folder = alice.getByRole("button", { name: "plans/" });
  if (await folder.count()) await folder.click();
  await alice.locator(".row.file", { hasText: "existing" }).first().dragTo(heading(alice, "Reading"));
  await expect(alice.locator(".page-path")).toHaveText("Reading · existing.md");
  await expect(editor(alice).locator("h1")).toHaveText("Existing");
  await expect
    .poll(async () => (await fetch(`${base}/w/${id}/existing.md`, { headers: key })).text())
    .toContain("# Existing");

  // A file the tree does not name, and a stranger, are both nothing.
  expect((await fetch(`${base}/w/${id}/nope.md`, { headers: key })).status).toBe(404);
  const eve = await session("eve");
  expect((await fetch(`${base}/w/${id}/`, { headers: { Authorization: `Bearer ${eve}` } })).status).toBe(404);

  expect((alice as any).__faults).toEqual([]);
});

/**
 * A reader: a browser with no session, no app and no repository.
 *
 * The page is normally at `/{id}`, served by the server out of the reader
 * build. Nothing here is built — these tests run off the Vite dev server — so
 * the reader is opened at its entry with the id said explicitly, which is the
 * same document reading the same address out of a different place. What the
 * build adds is the routing, and that is the server test's business.
 */
async function readerFor(browser: Browser, id: string): Promise<Page> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.addInitScript((url) => {
    localStorage.setItem("plans.workspaceServer", url as string);
  }, base);
  await page.goto(`/src/share/index.html?id=${id}`);
  return page;
}

/** The id out of the address the share sheet is showing. */
const idOf = (url: string) => url.split("/").pop() as string;

test("a plan in a repository is shared as a page, follows its saves, and stops", async ({ browser }) => {
  const alice = await boot(browser, "alice");

  // The file lives in a folder the tree opens closed.
  const folder = alice.getByRole("button", { name: "plans/" });
  if (await folder.count()) await folder.click();
  await alice.locator(".row.file", { hasText: "existing" }).first().click();
  await expect(editor(alice).locator("h1")).toHaveText("Existing");
  await editor(alice).locator("h1").click();
  await alice.keyboard.press("End");
  await alice.keyboard.press("Enter");
  await alice.keyboard.type("Anyone with the address can read this.");

  await alice.getByTestId("share-plan").click();
  await alice.getByTestId("publish").click();
  const url = await alice.getByTestId("share-link").inputValue();
  expect(url).toContain(base);
  await alice.keyboard.press("Escape");

  // The page is the app's own renderer: the same heading, the same prose.
  const reader = await readerFor(browser, idOf(url));
  await expect(reader.locator(".milkdown h1")).toHaveText("Existing");

  // A reader picks their paper, and the choice is kept in their browser.
  await reader.getByTestId("theme-night").click();
  await expect(reader.locator("html")).toHaveAttribute("data-theme", "night");
  await reader.reload();
  await expect(reader.locator("html")).toHaveAttribute("data-theme", "night");
  await expect(reader.locator(".milkdown h1")).toHaveText("Existing");
  await expect(reader.locator(".milkdown")).toContainText("Anyone with the address can read this.");

  // A save republishes, and the page catches up on its next poll.
  await editor(alice).locator("p", { hasText: "Anyone with the address" }).click();
  await alice.keyboard.press("End");
  await alice.keyboard.type(" Even after a save.");
  await alice.keyboard.press("Meta+s");
  await expect(reader.locator(".milkdown")).toContainText("Even after a save.", { timeout: 20_000 });

  // Stopped from the same control that started it, and the address dies.
  await alice.getByTestId("share-plan").click();
  await alice.getByTestId("stop-sharing").click();
  await expect(alice.getByTestId("share-plan")).toHaveText("Share…");
  await reader.reload();
  await expect(reader.locator(".share-gone")).toContainText("This plan is not shared");

  expect((alice as any).__faults).toEqual([]);
});

test("a workspace document's page follows the room, and an old share link still lands on it", async ({
  browser,
}) => {
  const alice = await boot(browser, "alice");
  await alice.locator(".ws-new").click();
  await alice.locator(".matter-sheet .name-field").fill("Sharing");
  await alice.locator(".matter-sheet .act", { hasText: "Create" }).click();
  await expect(editor(alice).locator("h1")).toHaveText("Sharing");

  await editor(alice).locator("h1").click();
  await alice.keyboard.press("End");
  await alice.keyboard.press("Enter");
  await alice.keyboard.type("Argued in a room, read in a browser.");

  await alice.getByTestId("share-plan").click();
  await alice.getByTestId("publish").click();
  const url = await alice.getByTestId("share-link").inputValue();
  await alice.keyboard.press("Escape");

  const reader = await readerFor(browser, idOf(url));
  await expect(reader.locator(".milkdown h1")).toHaveText("Sharing");
  await expect(reader.locator(".milkdown")).toContainText("Argued in a room, read in a browser.", {
    timeout: 20_000,
  });

  // Nothing is saved here — the page reads the room, so it follows the typing.
  await editor(alice).locator("p", { hasText: "Argued in a room" }).click();
  await alice.keyboard.press("End");
  await alice.keyboard.type(" And it keeps up.");
  await expect(reader.locator(".milkdown")).toContainText("And it keeps up.", { timeout: 20_000 });

  // A link minted before pages existed resolves to the document's page.
  const token = await session("alice");
  const list = await (await fetch(`${base}/workspaces`, { headers: { Authorization: `Bearer ${token}` } })).json();
  const minted = await (
    await fetch(`${base}/workspaces/${list[0].id}/share`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    })
  ).json();
  const resolved = await (
    await fetch(`${base}/api/share/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: minted.token }),
    })
  ).json();
  expect(resolved.id).toBe(idOf(url));

  expect((alice as any).__faults).toEqual([]);
});

test("signed out, the section invites you in and the sign-in sheet reports an unconfigured server", async ({ browser }) => {
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
  await expect(page.locator(".ws-hint")).toContainText("Sign in");

  // This server has no tenant, so the sheet says so rather than hanging.
  await page.getByTestId("sign-in").click();
  await expect(page.getByTestId("signin")).toBeVisible();
  await expect(page.locator(".signin-error")).toContainText("not configured");
});

/**
 * The agent in a workspace.
 *
 * The Rust side is faked, so no agent runs; what is real is everything the
 * app does around one. The scratch folder is what the app handed the fake
 * (`__fake.scratch`), a read is an `agent-fs` event the app answers out of
 * the room, and a write is one the app turns into an edit of the shared
 * document — which the other person then sees. See plans/agents-in-workspaces.md.
 */
test("an agent in a workspace reads what was just typed and writes into everyone's editor", async ({
  browser,
}) => {
  const alice = await boot(browser, "alice");
  await alice.locator(".ws-new").click();
  await answer(alice, "Agents", "Create");
  await expect(editor(alice).locator("h1")).toHaveText("Agents");

  const aliceToken = await session("alice");
  const id = await only(aliceToken);
  const dir = `/scratch/${id}`;

  // The chat is offered, because the folder has been written from the tree.
  await expect(alice.locator(".rail-btn", { hasText: "Chat" })).toBeVisible();
  const scratch = (page: Page, path: string) =>
    page.evaluate(
      ([ws, p]) => (window as any).__fake.scratch[ws]?.find((f: { path: string }) => f.path === p)?.text ?? null,
      [id, path] as const,
    );
  await expect.poll(() => scratch(alice, "plan.md")).toContain("# Agents");

  // The folder follows the room: a moment after typing, the file has it.
  await editor(alice).locator("h1").click();
  await alice.keyboard.press("End");
  await alice.keyboard.press("Enter");
  await alice.keyboard.type("Read me back.");
  await expect.poll(() => scratch(alice, "plan.md")).toContain("Read me back.");

  // A read is answered from the room, with what was typed a moment ago.
  await alice.locator(".rail-btn", { hasText: "Chat" }).click();
  await expect(alice.locator(".mux")).toBeVisible();
  const replies = (page: Page) =>
    page.evaluate(() => (window as any).__fake.fsReplies as { requestId: string; content: string | null }[]);
  await alice.evaluate(
    ([repo, ws]) =>
      (window as any).__fake.emit("agent-fs", {
        repo,
        requestId: "r1",
        op: "read",
        workspace: ws,
        path: "plan.md",
        content: null,
      }),
    [dir, id] as const,
  );
  await expect.poll(async () => (await replies(alice)).find((r) => r.requestId === "r1")?.content ?? null).toContain(
    "Read me back.",
  );
  // A file the workspace does not have is a refusal, not a hang.
  await alice.evaluate(
    ([repo, ws]) =>
      (window as any).__fake.emit("agent-fs", {
        repo,
        requestId: "r2",
        op: "read",
        workspace: ws,
        path: "nope.md",
        content: null,
      }),
    [dir, id] as const,
  );
  await expect.poll(async () => (await replies(alice)).some((r) => r.requestId === "r2" && r.content === null)).toBe(true);

  // Bob is in the room too, with the same file open.
  const bob = await boot(browser, "bob");
  await alice.locator(".page-actions .rail-btn", { hasText: "Invite" }).click();
  await answer(alice, "bob", "Invite");
  await bob.reload();
  await expect(bob.getByTestId("account")).toHaveText("bob");
  await heading(bob, "Agents").click();
  await row(bob, "plan").click();
  await expect(editor(bob)).toContainText("Read me back.");

  // A write to the open file goes through alice's editor, and bob sees it.
  await alice.evaluate(
    ([repo, ws]) =>
      (window as any).__fake.emit("agent-fs", {
        repo,
        requestId: "w1",
        op: "write",
        workspace: ws,
        path: "plan.md",
        content: "---\nstatus: done\n---\n\n# Agents\n\nThe agent wrote this.\n",
      }),
    [dir, id] as const,
  );
  await expect.poll(async () => (await replies(alice)).find((r) => r.requestId === "w1")?.content).toBe("");
  await expect(editor(alice)).toContainText("The agent wrote this.");
  await expect(editor(bob)).toContainText("The agent wrote this.", { timeout: 10_000 });
  await expect(editor(bob)).not.toContainText("Read me back.");
  // Status is just a write: the tree's dot follows the frontmatter.
  await expect(row(bob, "plan").locator(".status-dot")).toHaveClass(/tone-done/);
  await expect.poll(() => scratch(alice, "plan.md")).toContain("The agent wrote this.");

  // A write to a file nobody has open makes it, in a folder that did not
  // exist, through an editor nobody sees — and bob can open the result.
  await alice.evaluate(
    ([repo, ws]) =>
      (window as any).__fake.emit("agent-fs", {
        repo,
        requestId: "w2",
        op: "write",
        workspace: ws,
        path: "notes/todo.md",
        content: "# Todo\n\nShip it.\n",
      }),
    [dir, id] as const,
  );
  await expect.poll(async () => (await replies(alice)).find((r) => r.requestId === "w2")?.content).toBe("");
  await expect(alice.locator(".row.dir", { hasText: "notes" })).toBeVisible();
  await expect.poll(() => scratch(alice, "notes/todo.md")).toContain("Ship it.");
  await expect(bob.locator(".row.dir", { hasText: "notes" })).toBeVisible();
  await bob.locator(".row.dir", { hasText: "notes" }).click();
  await row(bob, "todo").click();
  await expect(editor(bob).locator("h1")).toHaveText("Todo");
  await expect(editor(bob)).toContainText("Ship it.");
  // The headless editor is gone once its one write has landed.
  await expect(alice.locator(".editor-host.headless")).toHaveCount(0);

  expect((alice as any).__faults).toEqual([]);
  expect((bob as any).__faults).toEqual([]);
});
