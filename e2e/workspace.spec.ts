/**
 * A workspace, end to end: two people in one folder of files.
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

  // Bob sees it appear and opens it — the same document, not a copy.
  await expect(row(bob, "risks")).toBeVisible();
  await row(bob, "risks").click();
  await editor(bob).locator("h1").click();
  await bob.keyboard.press("End");
  await bob.keyboard.press("Enter");
  await bob.keyboard.type("The server falls over.");
  await expect(editor(alice)).toContainText("The server falls over.");

  // A rename lands on both sides mid-edit, and the document travels with it:
  // alice is still typing into the file bob renamed.
  await menu(bob, row(bob, "risks"), "Rename…");
  await answer(bob, "dangers.md", "Rename");
  await expect(row(alice, "dangers")).toBeVisible();
  await expect(alice.locator(".page-path")).toHaveText("Roadmap · notes/dangers.md");
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

  // A file the tree does not name, and a stranger, are both nothing.
  expect((await fetch(`${base}/w/${id}/nope.md`, { headers: key })).status).toBe(404);
  const eve = await session("eve");
  expect((await fetch(`${base}/w/${id}/`, { headers: { Authorization: `Bearer ${eve}` } })).status).toBe(404);

  expect((alice as any).__faults).toEqual([]);
});

test("a share link opens the file it names, and copying out kills every link", async ({ browser }) => {
  const alice = await boot(browser, "alice");
  await alice.locator(".ws-new").click();
  await answer(alice, "Sharing", "Create");
  await expect(editor(alice).locator("h1")).toHaveText("Sharing");

  await heading(alice, "Sharing").click({ button: "right" });
  await alice.locator(".ctx .ctx-item", { hasText: "New file here" }).click();
  await answer(alice, "detail.md", "Create");
  await expect(alice.locator(".page-path")).toHaveText("Sharing · detail.md");
  await editor(alice).locator("h1").click();
  await alice.keyboard.press("End");
  await alice.keyboard.press("Enter");
  await alice.keyboard.type("Anyone with the link can read this.");

  // The sheet names the open file, and so does the link it mints.
  await alice.locator(".page-actions .rail-btn", { hasText: "Share" }).click();
  await expect(alice.getByTestId("share-sheet")).toContainText("Sharing / detail.md");
  await alice.getByTestId("share-sheet").locator(".act", { hasText: "New link" }).click();
  const link = await alice.getByTestId("share-link").inputValue();
  expect(link).toContain("/share#");

  // The editor serialises once the typing stops, so wait for the sentence to
  // reach the room rather than racing it into the reader's browser.
  const token = link.split("#")[1];
  await expect
    .poll(async () => {
      const r = await fetch(`${base}/share/doc`, { headers: { Authorization: `Bearer ${token}` } });
      return r.ok ? (await r.json()).markdown : "";
    })
    .toContain("Anyone with the link can read this.");

  // A reader with no session, no app and no repository — a browser and a URL.
  const reader = await (await browser.newContext()).newPage();
  await reader.goto(link);
  await expect(reader.locator(".head .name")).toHaveText("Sharing / detail.md");
  await expect(reader.locator("#doc h1")).toHaveText("Detail");
  await expect(reader.locator("#doc")).toContainText("Anyone with the link can read this.");

  // A link whose fragment was cleaned off is a different failure from a dead
  // one, and says so rather than showing an error that looks like revocation.
  await reader.goto(link.split("#")[0]);
  await expect(reader.locator(".note")).toContainText("missing its key");
  await expect(reader.locator("#doc")).toHaveCount(0);

  // Revoked from the same control that minted it.
  await alice.locator(".share-row .rail-btn", { hasText: "Revoke" }).click();
  await expect(alice.getByTestId("share-sheet")).toContainText("No links yet");
  await reader.goto(link);
  await expect(reader.locator(".note")).toContainText("no longer works");

  // Out of the room and into the repository. The plan's own frontmatter is
  // what travels — there is no review gate to stamp — and the workspace's
  // remaining links stop working, because the document is a file now.
  await alice.getByTestId("share-sheet").locator(".act", { hasText: "New link" }).click();
  const second = await alice.getByTestId("share-link").inputValue();
  await alice.locator(".matter-scrim").click({ position: { x: 5, y: 5 } });
  await expect(alice.getByTestId("share-sheet")).toHaveCount(0);
  await alice.locator(".page-actions .rail-btn", { hasText: "Copy to repository" }).click();
  await expect(alice.locator(".matter-sheet .name-field")).toHaveValue("Detail");
  await expect(alice.locator(".matter-sheet .name-path")).toHaveText("Detail.md");
  await alice.locator(".matter-sheet .act", { hasText: "Copy" }).click();

  await expect(alice.locator(".page-path")).toHaveText("Detail.md");
  const written = await alice.evaluate(() => (window as any).__fake.repos[0].files["Detail.md"]);
  expect(written).toContain("Anyone with the link can read this.");
  await expect
    .poll(async () =>
      (await fetch(`${base}/share/doc`, { headers: { Authorization: `Bearer ${second.split("#")[1]}` } })).status,
    )
    .toBe(404);

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
