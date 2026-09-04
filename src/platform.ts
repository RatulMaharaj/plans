/**
 * Which desktop the webview is on.
 *
 * Asked once, from `navigator.platform`, because the answer shapes two things
 * the page draws: how a shortcut is spelled (⌘⇧O against Ctrl+Shift+O) and
 * which controls exist at all (the `plans` command line is macOS-only for
 * now). The Tauri shell knows this too, but a round trip to ask it would
 * arrive after the first paint, and a key sheet that switches spelling a
 * moment after it opens is worse than one that asked the browser.
 *
 * `navigator.platform` rather than the user agent: WebView2 says `Win32`
 * there and nothing else does, while a user agent is a costume — Playwright's
 * "Desktop Chrome" wears a Windows one on every host, and the suite would
 * have the Windows sheet on a Mac. Two answers, because the app ships for
 * two desktops: Windows when the platform says so, and the Mac spelling
 * everywhere else, which keeps a Linux dev build reading exactly as it did
 * before Windows existed.
 */
const platform = typeof navigator === "undefined" ? "" : navigator.platform;

export const IS_WINDOWS = /^Win/i.test(platform);
export const IS_MAC = !IS_WINDOWS;
