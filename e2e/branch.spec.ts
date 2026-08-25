/**
 * Searching a long menu.
 *
 * The branch picker is the worst case — the factory mints a branch per plan,
 * so every name shares a prefix and the list only grows — but the behaviour
 * under test belongs to `Dropdown` itself: past a threshold the menu gains a
 * filter, scored by the same matcher the palette uses, and a short list keeps
 * the plain type-ahead a real select taught everyone.
 */
import { test, expect, type Page } from "@playwright/test";
import { installFakeBackend, type FakeRepo } from "./fake-backend";

const MANY = [
  "main",
  "plans/settings-json",
  "plans/branch-search",
  "plans/split-panes",
  "plans/hotkey-chords",
  "plans/remote-repos",
  "plans/formatters",
  "plans/tmux-sessions",
  "plans/see-every-file",
  "plans/drop-a-file-in",
  "plans/collaboration",
];

const REPOS: FakeRepo[] = [
  {
    path: "/repo/one",
    name: "one",
    branch: "main",
    branches: MANY,
    remotes: ["origin/plans/agent-ux-bakeoff"],
    files: { "plans/first.md": "# First\n\nA plan.\n" },
  },
];

async function open(page: Page, repos: FakeRepo[] = REPOS) {
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
}

/** Open the rail's branch menu and wait for the lazy list to land. */
async function branchMenu(page: Page) {
  await page.locator('.rail [aria-label="Branch"]').click();
  const menu = page.locator(".branch-pick .dd-menu");
  await expect(menu).toBeVisible();
  await expect(menu.locator(".dd-item")).toHaveCount(MANY.length + 1);
  return menu;
}

test("a long menu can be searched by anything but its prefix", async ({ page }) => {
  await open(page);
  const menu = await branchMenu(page);

  // The whole point: `settings` matches nothing at the front of a list where
  // every name begins `plans/`, and finds the branch anyway.
  await menu.locator(".dd-filter").fill("settings");
  await expect(menu.locator(".dd-item")).toHaveCount(1);
  await expect(menu.locator(".dd-item .dd-label")).toHaveText("plans/settings-json");
});

test("Enter takes the filtered list's pick, and Escape backs out in two steps", async ({
  page,
}) => {
  await open(page);
  const menu = await branchMenu(page);
  const filter = menu.locator(".dd-filter");

  await filter.fill("splt");
  await filter.press("Escape");
  await expect(filter).toHaveValue("");
  await expect(menu).toBeVisible();

  await filter.fill("splt");
  await filter.press("Enter");
  await expect(page.locator(".branch-pick .dd-menu")).toHaveCount(0);
  await expect(page.locator('.rail [aria-label="Branch"]')).toContainText("plans/split-panes");
});

test("a short menu keeps the plain type-ahead, with no filter box", async ({ page }) => {
  await open(page, [{ ...REPOS[0], branches: ["main", "other"], remotes: [] }]);
  await page.locator('.rail [aria-label="Branch"]').click();
  const menu = page.locator(".branch-pick .dd-menu");
  await expect(menu.locator(".dd-item")).toHaveCount(2);
  await expect(menu.locator(".dd-filter")).toHaveCount(0);
});

test("a branch that only exists on origin is offered, set apart", async ({ page }) => {
  await open(page);
  const menu = await branchMenu(page);

  const remote = menu.locator(".dd-item.apart");
  await expect(remote).toHaveCount(1);
  await expect(remote.locator(".dd-label")).toHaveText("plans/agent-ux-bakeoff");
  await expect(remote.locator(".dd-note")).toHaveText("origin");

  // Picking it checks out the full remote name — the Rust side is what turns
  // that into a tracking branch.
  await remote.click();
  const args = await page.evaluate(() =>
    (window as any).__fake.calls
      .filter((x: any) => x.cmd === "git_checkout")
      .map((x: any) => x.args),
  );
  expect(args).toEqual([{ repo: "/repo/one", branch: "origin/plans/agent-ux-bakeoff" }]);
});
