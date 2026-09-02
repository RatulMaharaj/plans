import posthog from "posthog-js";

/**
 * Usage numbers, and nothing else.
 *
 * This app opens the markdown in someone's private repositories, so the rule
 * here is narrow and absolute: events carry counts and the names of things in
 * this codebase — never a file path, a filename, a repository name, or a word
 * of anyone's prose. If a property couldn't be shown to the person it came
 * from without embarrassment, it does not go in.
 *
 * Nobody is identified. There is no account to attach anything to; the only
 * identifier is a random number PostHog makes up for this install and keeps in
 * localStorage, thrown away with the rest of the settings. Autocapture and
 * session replay stay off — both work by reading the DOM, and here the DOM is
 * the document.
 */

const KEY =
  (import.meta.env.VITE_POSTHOG_KEY as string | undefined) ??
  "phc_tZjU9Q32FmJUZzjwKKCXnUzuzyAbNLffne2soBgEqMGL";
const HOST =
  (import.meta.env.VITE_POSTHOG_HOST as string | undefined) ??
  "https://us.i.posthog.com";

let live = false;

/**
 * The one way to make a development build report, used by the test that checks
 * nothing about the document reaches the wire — a guarantee worth proving
 * against real traffic rather than against the fact that dev builds are quiet.
 *
 * It carries its own host, so this can never be a way to send anyone's real
 * editing to the real project by accident.
 */
function testHost(): string | null {
  try {
    return localStorage.getItem("plans.telemetry.testHost");
  } catch {
    return null;
  }
}

/**
 * Start, or don't. Called once at boot with the saved preference. In `pnpm dev`
 * this stays off regardless, so developing the app doesn't pollute the numbers
 * the app is for.
 */
export function startAnalytics(enabled: boolean) {
  const forced = testHost();
  if (!KEY || !enabled || (import.meta.env.DEV && !forced)) return;
  posthog.init(KEY, {
    api_host: forced ?? HOST,
    // The window is a local tauri:// shell. A "page view" here is meaningless,
    // and its URL is a path on someone's disk.
    capture_pageview: false,
    capture_pageleave: false,
    autocapture: false,
    disable_session_recording: true,
    // Never identified, so never give anyone a person profile.
    person_profiles: "identified_only",
    // The referrer and initial URL are, again, a path on someone's disk.
    mask_personal_data_properties: true,
  });
  posthog.register({ surface: "desktop" });
  live = true;
}

/**
 * Stamp every later event with how many repositories are open, so any event
 * can be broken down by it — "how many repos at once" without a dedicated
 * event to remember to send.
 */
export function setRepoCount(n: number) {
  if (!live) return;
  posthog.register({ repos_open: n });
}

/** Stamp every later event with the build that sent it. */
export function setAppVersion(version: string) {
  if (!live) return;
  posthog.register({ app_version: version });
}

/** Turned off mid-session: stop sending, and forget what is queued. */
export function stopAnalytics() {
  if (!live) return;
  posthog.opt_out_capturing();
  posthog.reset();
  live = false;
}

/** Turned back on mid-session, without a restart. */
export function resumeAnalytics() {
  if (!live) return startAnalytics(true);
  posthog.opt_in_capturing();
}

/**
 * One event. Properties are kept safe by the call sites rather than by type:
 * numbers, booleans, and names of things in this codebase only.
 */
export function track(
  event: string,
  props?: Record<string, string | number | boolean>,
) {
  if (!live) return;
  posthog.capture(event, props);
}

/**
 * The command ids whose last part is someone's own thing — a chat id, a
 * repository path, a word from their status vocabulary, an agent's name.
 * Anything under one of these reports as the prefix alone. Every other id
 * is a static string in this codebase, and goes as it is.
 */
const PERSONAL_PREFIXES = ["chat.", "repo.", "agent.use.", "skill.open.", "status.", "model.", "effort."];

/** A palette command id, with the part that is not ours cut off. */
export function commandName(id: string): string {
  const hit = PERSONAL_PREFIXES.find((p) => id.startsWith(p));
  return hit ? `${hit}*` : id;
}
