/**
 * The promise made in Settings, held to.
 *
 * The claim on that page is specific — anonymous counts, and never a file
 * name, a path, or a word of anyone's writing. That is a claim about bytes
 * leaving the machine, so this test watches the wire rather than the code: it
 * drives the app the way a person would, opening files and typing prose that
 * would be unmistakable if it ever escaped, and asserts on every request.
 *
 * It also pins the two structural guarantees: the toggle is where it says it
 * is, and a development build never reports at all, so working on the app
 * doesn't pollute the numbers the app is for.
 */
import { test, expect } from "@playwright/test";
import { installFakeBackend, type FakeRepo } from "./fake-backend";

/** Strings that appear nowhere but this repository's private contents. */
const SECRET = "zarquon-nineteen-secret-prose";
const REPOS: FakeRepo[] = [
  {
    path: "/repo/private-thoughts",
    name: "private-thoughts",
    branch: "main",
    files: {
      "confidential-plan.md": `# Confidential\n\nSome ordinary prose.\n`,
    },
  },
];

test("nothing about the document reaches the wire", async ({ page }) => {
  const sent: string[] = [];
  // Every request, not just PostHog's: a leak through some other host would be
  // exactly as bad, and this way the test doesn't have to guess the endpoint.
  await page.route("**/*", async (route) => {
    const req = route.request();
    const url = req.url();
    if (
      !url.startsWith("http://localhost") &&
      !url.startsWith("http://127.0.0.1")
    ) {
      sent.push(`${url} ${req.postData() ?? ""}`);
      // Answer rather than hitting the network, so a real project's numbers
      // never see a test run.
      return route.fulfill({ status: 200, body: "1" });
    }
    return route.continue();
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
      // Make this dev build actually report, at a host that is not the real
      // project, so the assertions below are made against real traffic.
      localStorage.setItem(
        "plans.telemetry.testHost",
        "https://telemetry.test",
      );
    },
    [installFakeBackend.toString(), REPOS] as const,
  );

  await page.goto("/");
  await expect(page.locator(".files")).toBeVisible();

  // Open the file and write something that could only have come from here.
  await page.locator(".file", { hasText: "confidential-plan" }).first().click();
  await page.locator(".milkdown").click();
  await page.keyboard.type(` ${SECRET}`);
  // Past the autosave delay so a save event fires, plus a beat for PostHog to
  // flush its queue.
  await page.waitForTimeout(4500);

  // The test is only worth anything if events really were sent.
  expect(sent.some((r) => r.includes("telemetry.test"))).toBe(true);

  const wire = sent.join("\n");
  for (const leak of [
    SECRET,
    "confidential-plan",
    "private-thoughts",
    "/repo/",
  ]) {
    expect(wire, `"${leak}" must never leave the machine`).not.toContain(leak);
  }
});

test("a development build reports nothing at all", async ({ page }) => {
  const offsite: string[] = [];
  page.on("request", (r) => {
    if (!/^http:\/\/(localhost|127\.0\.0\.1)/.test(r.url()))
      offsite.push(r.url());
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
    [installFakeBackend.toString(), REPOS] as const,
  );

  await page.goto("/");
  await expect(page.locator(".files")).toBeVisible();
  await page.waitForTimeout(1500);

  expect(offsite.filter((u) => u.includes("posthog"))).toEqual([]);
});

test("the switch is in Settings, and starts on", async ({ page }) => {
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
    [installFakeBackend.toString(), REPOS] as const,
  );
  await page.goto("/");
  await expect(page.locator(".files")).toBeVisible();

  await page.keyboard.press(
    process.platform === "darwin" ? "Meta+," : "Control+,",
  );
  await page.locator(".settings-filter").fill("anonymous");

  const toggle = page.locator('[role="switch"]', {
    hasText: "Send anonymous usage data",
  });
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-checked", "true");

  // Turning it off is remembered, which is the only part of the promise the
  // app itself is responsible for keeping across launches.
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  const saved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("plans.settings.v1") ?? "{}"),
  );
  expect(saved.telemetry).toBe(false);
});
