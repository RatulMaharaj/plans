import { defineConfig, devices } from "@playwright/test";

/**
 * The frontend, in a real browser, with the Rust boundary faked.
 *
 * tauri-driver has no macOS support, so the packaged app cannot be driven here.
 * That matters less than it sounds: every failure this project has actually had
 * lived in the frontend or at the IPC boundary, and both are covered by pointing
 * a browser at the dev server with `invoke` stubbed. The Rust side is tested on
 * its own, with `cargo test`.
 */
export default defineConfig({
  testDir: "./e2e",
  /**
   * Two workers, not one per core. Each test boots a Milkdown editor, which is
   * heavy; running four at once on one machine starves them all and they fail
   * on timing rather than on behaviour.
   */
  fullyParallel: true,
  workers: 2,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  timeout: 45_000,
  expect: { timeout: 10_000 },
  use: {
    /*
     * Port 1430, not the app's 1420 (and not 1421, which HMR takes).
     *
     * A Tauri dev window loads the dev server's URL, so it shares an origin —
     * and therefore a localStorage — with anything else pointed at that port.
     * These tests write `plans.repos.v1` on every boot, which quietly emptied
     * the repository list of a running app. A second port is a second origin,
     * and the two stop being able to reach each other's storage.
     */
    baseURL: "http://localhost:1430",
    trace: "retain-on-failure",
    video: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "pnpm web --port 1430 --strictPort",
    url: "http://localhost:1430",
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
