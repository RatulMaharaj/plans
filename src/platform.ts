/**
 * Which desktop the webview is on.
 *
 * Asked once, from `navigator.platform`, because the answer shapes two things
 * the page draws: how a shortcut is spelled (⌘⇧O against Ctrl+Shift+O) and
 * which controls exist at all (the `plans` command line is not on Windows
 * yet). The Tauri shell knows this too, but a round trip to ask it would
 * arrive after the first paint, and a key sheet that switches spelling a
 * moment after it opens is worse than one that asked the browser.
 *
 * `navigator.platform` rather than the user agent: WebView2 says `Win32`
 * there, WebKitGTK says `Linux x86_64`, and nothing else does either, while a
 * user agent is a costume — Playwright's "Desktop Chrome" wears a Windows one
 * on every host, and the suite would have the Windows sheet on a Mac. Three
 * answers, because the app ships for three desktops. Windows and Linux both
 * spell `mod` as Ctrl and write modifiers as words, so most of the page only
 * asks `IS_MAC`; `IS_LINUX` is for the few places Linux differs from Windows,
 * like the `plans` command line, which Linux has and Windows does not.
 */
const platform = typeof navigator === "undefined" ? "" : navigator.platform;

export const IS_WINDOWS = /^Win/i.test(platform);
export const IS_LINUX = !IS_WINDOWS && /Linux/i.test(platform);
export const IS_MAC = !IS_WINDOWS && !IS_LINUX;
