/**
 * Chords and the Keyboard page.
 *
 * A chord is a KeySpec with a space — "mod+k w" — matched in two steps by the
 * one keydown lookup. These cover the matcher's beat and its timeout, the ⌘K
 * prefix decision (the palette keeps ⌘P/⌘⇧P), the new conflict refusals, the
 * pack merge order, and the Settings → Keyboard page itself.
 */
import { test, expect, type Page } from "@playwright/test";
import { installFakeBackend, type FakeRepo } from "./fake-backend";

const REPOS: FakeRepo[] = [
  {
    path: "/repo/plans",
    name: "plans",
    branch: "main",
    files: {
      "a.md": "# A\n\npara one\n",
      "b.md": "# B\n\npara two\n",
    },
  },
];

async function boot(page: Page) {
  await page.addInitScript(
    ([fn, list]) => {
      // eslint-disable-next-line no-new-func
      new Function(`return ${fn}`)()(list);
      localStorage.setItem(
        "plans.repos.v1",
        JSON.stringify((list as FakeRepo[]).map((r) => r.path)),
      );
      localStorage.setItem("plans.tabs.v1", "[]");
      localStorage.setItem("plans.split.v1", "null");
      localStorage.setItem("plans.splitTabs.v1", "[]");
    },
    [installFakeBackend.toString(), REPOS] as const,
  );
  await page.goto("/");
  await expect(page.locator(".files")).toBeVisible();
}

/** Settings → Keyboard, the long way a reader takes. */
async function openKeyboard(page: Page) {
  await page.keyboard.press("Meta+,");
  await expect(page.locator(".settings-title")).toHaveText("Settings");
  await page.locator(".setting-row", { hasText: "Keyboard shortcuts" }).getByRole("button", { name: "Open" }).click();
  await expect(page.locator(".settings-title")).toHaveText("Keyboard");
}

const bindingFor = (page: Page, label: string) =>
  page.locator(".keyboard-row", { hasText: label }).locator(".shortcut-keys");

test("⌘K arms a chord, shows it in the status bar, and ⌘K W closes all buffers", async ({ page }) => {
  await boot(page);
  await page.locator(".row.file", { hasText: "a" }).first().click();
  await page.locator(".row.file", { hasText: "b" }).first().click();
  await expect(page.locator(".tab")).toHaveCount(2);

  // The prefix is swallowed and shown — the palette does not open on ⌘K.
  await page.keyboard.press("Meta+k");
  await expect(page.locator(".palette")).toHaveCount(0);
  await expect(page.locator(".chord-hint")).toHaveText("⌘K …");

  await page.keyboard.press("w");
  await expect(page.locator(".tab")).toHaveCount(0);
  await expect(page.locator(".chord-hint")).toHaveCount(0);
});

test("an armed chord times out, and a non-completing key is processed normally", async ({ page }) => {
  await boot(page);
  await page.locator(".row.file", { hasText: "a" }).first().click();

  // Timeout: the armed prefix clears itself after the beat.
  await page.keyboard.press("Meta+k");
  await expect(page.locator(".chord-hint")).toBeVisible();
  await expect(page.locator(".chord-hint")).toHaveCount(0, { timeout: 5_000 });
  await expect(page.locator(".tab")).toHaveCount(1);

  // A second combo that completes no chord falls through: ⌘P still opens
  // the palette, and the pending state is gone.
  await page.keyboard.press("Meta+k");
  await expect(page.locator(".chord-hint")).toBeVisible();
  await page.keyboard.press("Meta+p");
  await expect(page.locator(".palette")).toBeVisible();
  await expect(page.locator(".chord-hint")).toHaveCount(0);
});

test("the palette keeps ⌘P and ⌘⇧P as its doors", async ({ page }) => {
  await boot(page);
  await page.keyboard.press("Meta+p");
  await expect(page.locator(".palette")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".palette")).toHaveCount(0);
  await page.keyboard.press("Meta+Shift+p");
  await expect(page.locator(".palette")).toBeVisible();
});

test("the Keyboard page rebinds, unbinds, resets, and resets all", async ({ page }) => {
  await boot(page);
  await openKeyboard(page);

  // Rebind: click the binding, press the new keys, see them rendered.
  await bindingFor(page, "New plan").click();
  await expect(bindingFor(page, "New plan")).toHaveText("press keys…");
  await page.keyboard.press("Meta+Shift+9");
  await expect(bindingFor(page, "New plan")).toHaveText("⌘⇧9");
  await expect(page.locator(".keyboard-row", { hasText: "New plan" })).toContainText("rebound");

  // Unbind, from the explicit control.
  await page
    .locator(".keyboard-row", { hasText: "Save now" })
    .getByRole("button", { name: "unbind" })
    .click();
  await expect(bindingFor(page, "Save now")).toHaveText("unbound");

  // Reset one row back to its default.
  await page
    .locator(".keyboard-row", { hasText: "Save now" })
    .getByRole("button", { name: "reset" })
    .click();
  await expect(bindingFor(page, "Save now")).toHaveText("⌘S");

  // Reset all clears every override at once.
  await page.getByRole("button", { name: "Reset all" }).click();
  await expect(bindingFor(page, "New plan")).toHaveText("⌘N");
  await expect(page.locator(".key-edited")).toHaveCount(0);

  // The page is honest about what it does not own.
  await expect(page.locator(".settings-group", { hasText: "Contextual" })).toBeVisible();
  await expect(page.locator(".settings-group", { hasText: "In the editor" })).toContainText("Bold");
});

test("capture takes a two-combo chord, and it runs", async ({ page }) => {
  await boot(page);
  await openKeyboard(page);

  await bindingFor(page, "Git panel").click();
  await page.keyboard.press("Meta+k");
  await expect(bindingFor(page, "Git panel")).toHaveText("⌘K …");
  await page.keyboard.press("g");
  await expect(bindingFor(page, "Git panel")).toHaveText("⌘K G");

  // And the chord actually dispatches: leave settings, play it.
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Meta+k");
  await page.keyboard.press("g");
  await expect(page.locator(".rail-btn", { hasText: "Git" })).toHaveClass(/on/);
});

test("conflicts are refused: duplicates, swallowed bindings, and a taken prefix", async ({ page }) => {
  await boot(page);
  await openKeyboard(page);
  const note = page.locator(".keyboard-note");

  // The refusal that already existed: an exact duplicate.
  await bindingFor(page, "New plan").click();
  await page.keyboard.press("Meta+s");
  await page.keyboard.press("x");
  // "mod+s x" — a chord whose prefix is Save's whole binding.
  await expect(note).toContainText("⌘S already runs “Save now” — a chord starting there would swallow it.");

  await bindingFor(page, "New plan").click();
  await page.keyboard.press("Meta+g");
  await expect(note).toContainText("⌘G already runs “Git panel” — unbind that first.");

  // A plain binding on an existing chord's prefix never fires.
  await bindingFor(page, "New plan").click();
  await page.keyboard.press("Meta+k");
  await expect(note).toContainText("starts the ⌘K W chord for “Close all buffers”", {
    timeout: 5_000,
  });

  // Refused means unchanged.
  await expect(bindingFor(page, "New plan")).toHaveText("⌘N");
});

test("preset packs merge under personal overrides, and switching back restores the defaults", async ({ page }) => {
  await boot(page);
  await openKeyboard(page);

  // A personal rebind first.
  await bindingFor(page, "New plan").click();
  await page.keyboard.press("Meta+Shift+9");
  await expect(bindingFor(page, "New plan")).toHaveText("⌘⇧9");

  // The Vim pack takes the ⌃W window family — and the note keeps modal
  // editing honestly out of scope.
  await page.getByRole("button", { name: "Vim" }).click();
  await expect(page.locator(".setting-row", { hasText: "Keybinding pack" })).toContainText(
    "modal editing is a separate future feature",
  );
  await expect(bindingFor(page, "Split — another file beside this one")).toHaveText("⌃W V");
  // The personal rebind survives the pack switch.
  await expect(bindingFor(page, "New plan")).toHaveText("⌘⇧9");

  // VS Code: only commands that exist here take its keys.
  await page.getByRole("button", { name: "VS Code" }).click();
  await expect(bindingFor(page, "Agent chat")).toHaveText("⌃`");
  await expect(bindingFor(page, "New plan")).toHaveText("⌘⇧9");

  // Back to the app's own bindings, untouched.
  await page.getByRole("button", { name: "Default" }).click();
  await expect(bindingFor(page, "Split — another file beside this one")).toHaveText("⌘\\");
  await expect(bindingFor(page, "Agent chat")).toHaveText("⌘J");
  await expect(bindingFor(page, "New plan")).toHaveText("⌘⇧9");
});
