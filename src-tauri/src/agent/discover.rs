//! Finding an agent to talk to.
//!
//! Two jobs that look alike and are not: resolving a program name against the
//! PATH a *terminal* would have, and knowing which ACP agents exist to offer.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;
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
static SHELL_PATH: OnceLock<Option<String>> = OnceLock::new();

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

/// The binary to run for `name`, as an absolute path where one can be found.
///
/// Resolved rather than passed through so a failure is "not installed" rather
/// than "not on this process's PATH", and so the catalogue and the spawn can
/// never disagree about whether something exists.
pub fn resolve(name: &str) -> Option<PathBuf> {
    let dirs = login_path()
        .map(String::from)
        .or_else(|| std::env::var("PATH").ok())?;
    for dir in dirs.split(':').filter(|d| !d.is_empty()) {
        let p = Path::new(dir).join(name);
        if p.is_file() {
            return Some(p);
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
        args: &["-y", "@agentclientprotocol/claude-agent-acp@0.70.0"],
        install: "Needs Node. Runs via npx on first use.",
    },
    Known {
        id: "codex",
        label: "Codex",
        program: "npx",
        args: &["-y", "@agentclientprotocol/codex-acp"],
        install: "Needs Node and a Codex login.",
    },
    Known {
        id: "gemini",
        label: "Gemini",
        program: "gemini",
        args: &["--experimental-acp"],
        install: "npm i -g @google/gemini-cli",
    },
    Known {
        id: "opencode",
        label: "OpenCode",
        program: "opencode",
        args: &["acp"],
        install: "See opencode.ai for install instructions.",
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
}

pub fn find(id: &str) -> Option<&'static Known> {
    KNOWN.iter().find(|k| k.id == id)
}

/// The argv for an agent id, resolved to an absolute program.
pub fn argv_for(id: &str) -> Option<Vec<String>> {
    let k = find(id)?;
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
            let found = resolve(k.program);
            AgentFound {
                id: k.id.to_string(),
                label: k.label.to_string(),
                ready: found.is_some(),
                install: k.install.to_string(),
                argv: std::iter::once(k.program.to_string())
                    .chain(k.args.iter().map(|a| (*a).to_string()))
                    .collect(),
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
