//! Finding an agent to talk to.
//!
//! Two jobs that look alike and are not: resolving a program name against the
//! PATH a *terminal* would have, and knowing which ACP agents exist to offer.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;
#[cfg(unix)]
use std::sync::OnceLock;

/// The PATH a login shell would have, found once and remembered.
///
/// A GUI app launched from Finder or the Dock inherits launchd's PATH, which
/// is `/usr/bin:/bin:/usr/sbin:/sbin` and nothing else. Every way people
/// actually install an agent CLI — `~/.local/bin`, Homebrew, a node version
/// manager, `~/.bun/bin` — is outside it, so `Command::new("npx")` fails
/// with "not found" for someone who can run `npx` perfectly well in a
/// terminal. The same app started from a terminal works, which is exactly the
/// kind of difference that makes a bug look like magic.
///
/// Asking the login shell is the only honest way to know: the PATH is
/// assembled by the user's own dotfiles, and guessing a list of directories
/// would be wrong for the next person.
#[cfg(unix)]
static SHELL_PATH: OnceLock<Option<String>> = OnceLock::new();

#[cfg(unix)]
pub fn login_path() -> Option<&'static str> {
    SHELL_PATH
        .get_or_init(|| {
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
            let out = Command::new(shell)
                .args(["-lc", "printf %s \"$PATH\""])
                .output()
                .ok()?;
            if !out.status.success() {
                return None;
            }
            let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
            (!p.is_empty()).then_some(p)
        })
        .as_deref()
}

/// Windows has no login shell to ask, and no need for one: a GUI process
/// starts with the same user PATH a terminal gets, so the fallback `resolve`
/// takes — this process's own PATH — is already the right answer. `None`
/// here is what makes it take that fallback.
#[cfg(windows)]
pub fn login_path() -> Option<&'static str> {
    None
}

/// The file names that could be `name` on this platform, most preferred first.
///
/// On Unix a command is one file. On Windows it is one of several: npm puts
/// both a `claude-agent-acp.exe` shim and a `claude-agent-acp.cmd` wrapper on
/// the PATH, and the extensionless file does not exist. The list is
/// `PATHEXT`, the same one the shell walks, except that `.exe` is moved to
/// the front and `.cmd` right behind it: a real executable spawns directly,
/// and a `.cmd` needs `cmd.exe` to run it — which Rust's `Command` arranges
/// on its own when it sees the extension, so either result works as
/// `argv[0]`, and the `.exe` is just the shorter road. A name that already
/// carries an extension is looked up as written.
///
/// `pathext` is a parameter rather than read here so the Windows shape can be
/// tested on any machine.
fn candidates(name: &str, pathext: Option<&str>) -> Vec<String> {
    let Some(pathext) = pathext else {
        return vec![name.to_string()];
    };
    if Path::new(name).extension().is_some() {
        return vec![name.to_string()];
    }
    let mut exts: Vec<String> = pathext
        .split(';')
        .filter(|e| !e.is_empty())
        .map(|e| e.to_ascii_lowercase())
        .collect();
    for (i, want) in [".exe", ".cmd"].iter().enumerate() {
        if let Some(at) = exts.iter().position(|e| e == want) {
            let e = exts.remove(at);
            exts.insert(i.min(exts.len()), e);
        } else {
            exts.insert(i.min(exts.len()), (*want).to_string());
        }
    }
    exts.iter().map(|e| format!("{name}{e}")).collect()
}

#[cfg(windows)]
fn platform_pathext() -> Option<String> {
    Some(std::env::var("PATHEXT").unwrap_or_else(|_| ".EXE;.CMD;.BAT;.COM".into()))
}

#[cfg(not(windows))]
fn platform_pathext() -> Option<String> {
    None
}

/// The binary to run for `name`, as an absolute path where one can be found.
///
/// Resolved rather than passed through so a failure is "not installed" rather
/// than "not on this process's PATH", and so the catalogue and the spawn can
/// never disagree about whether something exists.
pub fn resolve(name: &str) -> Option<PathBuf> {
    let dirs = login_path()
        .map(String::from)
        .or_else(|| std::env::var("PATH").ok())?;
    let pathext = platform_pathext();
    let names = candidates(name, pathext.as_deref());
    // `split_paths` knows the separator — `:` here, `;` on Windows — and
    // hands back the entries as paths, which is what they were all along.
    for dir in std::env::split_paths(&dirs).filter(|d| !d.as_os_str().is_empty()) {
        for n in &names {
            let p = dir.join(n);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

/// An agent the app knows how to start.
///
/// `program` plus `args` rather than a command line, because there is no shell
/// anywhere in this codebase and a settings string that becomes one would be
/// arbitrary code execution. An argv array cannot be talked into running
/// something else.
pub struct Known {
    pub id: &'static str,
    pub label: &'static str,
    pub program: &'static str,
    pub args: &'static [&'static str],
    /// What to tell someone who does not have it.
    pub install: &'static str,
    /// What to do when it starts but refuses to work.
    ///
    /// Every one of these needs signing in, and none of them can do it over
    /// ACP — the handshake fails and the process exits with a sentence about
    /// a missing key. The sentence is true and useless, because the thing to
    /// do about it happens in a terminal.
    pub auth: &'static str,
    /// The command this agent installs as, when it is installed properly.
    ///
    /// Checked before `program`, because `npx` is a fallback rather than the
    /// good path: it re-resolves the package on every launch, which costs a
    /// second or two of a person's attention on the first prompt of every
    /// session. A globally installed binary just runs.
    pub bin: Option<&'static str>,
    /// The npm package to install, for the agents that come from npm.
    pub package: Option<&'static str>,
    /// Where this agent looks for a repository's conventions.
    ///
    /// Repository-relative, and a list because some agents read more than one
    /// place. The app has exactly one text to install — the conventions are the
    /// same conventions whoever is reading them — so all that differs between
    /// agents is where a copy goes, which is what this table is.
    ///
    /// Two kinds of path live here and they are not written the same way. A
    /// file under a tool's own dotted directory belongs to the app and is
    /// replaced outright; a file at the root of the repository belongs to the
    /// *repository*, may already say things the app knows nothing about, and
    /// only ever has its own section rewritten. The frontend decides which is
    /// which from the path, so nothing here has to carry a flag.
    pub conventions: &'static [&'static str],
}

/// The agents worth offering, in the order they are offered.
///
/// Versions are pinned. ACP and these wrappers are young enough that a
/// floating `@latest` would let a protocol-breaking publish reach into a
/// running app overnight; a stale pin is a bug report, an unpinned break is a
/// morning of confusion.
pub const KNOWN: &[Known] = &[
    Known {
        id: "claude",
        label: "Claude Code",
        program: "npx",
        args: &["-y", "@agentclientprotocol/claude-agent-acp@0.73.0"],
        install: "Needs Node. Install it to start instantly instead of fetching each time.",
        auth: "Run `claude` in a terminal once and sign in.",
        bin: Some("claude-agent-acp"),
        package: Some("@agentclientprotocol/claude-agent-acp@0.73.0"),
        conventions: &[".claude/skills/plans/SKILL.md"],
    },
    Known {
        id: "codex",
        label: "Codex",
        program: "npx",
        args: &["-y", "@agentclientprotocol/codex-acp"],
        install: "Needs Node and a Codex login.",
        auth: "Run `codex` in a terminal once and sign in.",
        bin: Some("codex-acp"),
        package: Some("@agentclientprotocol/codex-acp"),
        conventions: &["AGENTS.md"],
    },
    Known {
        id: "gemini",
        label: "Gemini",
        program: "gemini",
        args: &["--experimental-acp"],
        install: "Needs the Gemini CLI.",
        auth: "Run `gemini` in a terminal once to sign in, or set GEMINI_API_KEY.",
        bin: None,
        package: Some("@google/gemini-cli"),
        conventions: &["GEMINI.md"],
    },
    Known {
        id: "opencode",
        label: "OpenCode",
        program: "opencode",
        args: &["acp"],
        install: "See opencode.ai for install instructions.",
        auth: "Run `opencode auth login` in a terminal.",
        bin: None,
        package: None,
        conventions: &["AGENTS.md"],
    },
];

/// One entry in the picker: what it is, and whether it can be started here.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentFound {
    pub id: String,
    pub label: String,
    /// Whether `program` resolves on this machine.
    ///
    /// Not "does it speak our protocol" — every entry speaks ACP by
    /// construction, which is the whole point of the change that introduced
    /// this file. The old `supported` flag existed to apologise for codex,
    /// and there is nothing left to apologise for.
    pub ready: bool,
    pub install: String,
    /// The argv, shown in settings so nothing about the launch is hidden.
    pub argv: Vec<String>,
    /// What to do when it starts but will not answer.
    pub auth: String,
    /// Whether it is installed rather than fetched by npx on every launch.
    pub installed: bool,
    /// Whether the app can install it for you.
    pub installable: bool,
    /// Where this agent reads a repository's conventions.
    pub conventions: Vec<String>,
}

pub fn find(id: &str) -> Option<&'static Known> {
    KNOWN.iter().find(|k| k.id == id)
}

/// The argv for an agent id, resolved to an absolute program.
///
/// The installed binary wins over the `npx` fallback: same protocol, same
/// agent, without re-resolving a package every time a session opens.
pub fn argv_for(id: &str) -> Option<Vec<String>> {
    let k = find(id)?;
    if let Some(direct) = k.bin.and_then(resolve) {
        return Some(vec![direct.to_string_lossy().into_owned()]);
    }
    let bin = resolve(k.program)?;
    let mut argv = vec![bin.to_string_lossy().into_owned()];
    argv.extend(k.args.iter().map(|a| (*a).to_string()));
    Some(argv)
}

/// Every known agent, and whether this machine can run it.
#[tauri::command]
pub fn agent_list() -> Vec<AgentFound> {
    KNOWN
        .iter()
        .map(|k| {
            let installed = k.bin.and_then(resolve).is_some();
            AgentFound {
                id: k.id.to_string(),
                label: k.label.to_string(),
                ready: installed || resolve(k.program).is_some(),
                install: k.install.to_string(),
                auth: k.auth.to_string(),
                // What it would actually run, not what the table says: the
                // difference between the two is the point of this change.
                argv: if installed {
                    vec![k.bin.unwrap_or(k.program).to_string()]
                } else {
                    std::iter::once(k.program.to_string())
                        .chain(k.args.iter().map(|a| (*a).to_string()))
                        .collect()
                },
                installed,
                installable: k.package.is_some() && !installed,
                conventions: k.conventions.iter().map(|c| (*c).to_string()).collect(),
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn on_windows_a_name_is_looked_up_with_its_extensions() {
        // npm installs both a `.cmd` and an `.exe` shim; the `.exe` spawns
        // without a `cmd.exe` in between, so it goes first whatever order
        // PATHEXT lists them in. The rest of PATHEXT keeps its order, and
        // a name that already carries an extension is left alone.
        let got = candidates("npx", Some(".COM;.EXE;.BAT;.CMD;.JS"));
        assert_eq!(got, ["npx.exe", "npx.cmd", "npx.com", "npx.bat", "npx.js"]);
        assert_eq!(candidates("npx", Some("")), ["npx.exe", "npx.cmd"]);
        assert_eq!(candidates("git.exe", Some(".EXE;.CMD")), ["git.exe"]);
        // Unix: one file, as written.
        assert_eq!(candidates("npx", None), ["npx"]);
    }

    #[cfg(unix)]
    #[test]
    fn a_binary_outside_this_process_path_is_still_found() {
        // The point of `resolve`: a GUI app's PATH is not the shell's, so the
        // lookup goes through the login shell. `sh` is on every PATH there is,
        // which makes it the one name safe to assert on.
        assert!(resolve("sh").is_some());
        assert!(resolve("plans-no-such-agent-9f3").is_none());
    }

    #[test]
    fn the_catalogue_is_argv_not_a_command_line() {
        // A shell metacharacter in here would mean nothing — there is no shell
        // — but its presence would signal someone had started thinking of
        // these as command lines, which is the door this design closes.
        for k in KNOWN {
            assert!(!k.program.contains(' '), "{}", k.id);
            for a in k.args {
                assert!(
                    !a.contains(';') && !a.contains('|') && !a.contains('&'),
                    "{}",
                    k.id
                );
            }
        }
    }

    #[test]
    fn an_unknown_agent_has_no_argv() {
        assert!(argv_for("no-such-agent").is_none());
    }

    #[test]
    fn npx_is_the_fallback_not_the_plan() {
        // Every npm-based entry names the binary it installs as, so a global
        // install can be preferred over re-resolving a package each launch.
        // An entry with a package but no binary would silently never take the
        // fast path.
        for k in KNOWN {
            if k.program == "npx" {
                assert!(k.bin.is_some(), "{} would always go through npx", k.id);
                assert!(k.package.is_some(), "{} could never be installed", k.id);
            }
        }
    }

    #[test]
    fn an_agent_the_app_cannot_install_does_not_offer_to() {
        let list = agent_list();
        for a in &list {
            let k = find(&a.id).unwrap();
            if k.package.is_none() {
                assert!(!a.installable, "{}", a.id);
            }
            // Offering to install something already installed is a button
            // that does nothing you can see.
            if a.installed {
                assert!(!a.installable, "{}", a.id);
            }
        }
    }
}

/// Install an agent globally, so it starts without npx fetching it first.
///
/// `npm i -g`, and nothing cleverer: the packages are npm packages, npm is
/// what put node on this machine in the first place, and a bespoke downloader
/// would be a second thing to trust.
#[tauri::command]
pub fn agent_install(id: String) -> Result<String, String> {
    let k = find(&id).ok_or("no such agent")?;
    let package = k.package.ok_or("this agent is not installed through npm")?;
    let npm = resolve("npm").ok_or("npm is not on the PATH your shell gives this app")?;
    let mut cmd = Command::new(npm);
    cmd.args(["install", "-g", package]);
    crate::no_console(&mut cmd);
    let out = cmd
        .output()
        .map_err(|e| format!("could not run npm: {e}"))?;
    if out.status.success() {
        Ok(package.to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}
