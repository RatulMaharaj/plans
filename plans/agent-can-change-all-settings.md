---
status: ready
---
# Agent Can Change All Settings

What the title says: an agent should be able to change any setting by writing
to `settings.json` directly. And the striking thing about this plan is how
little of it is capability. Since `settings-json.md` shipped, the file exists
in the config directory with a generated schema beside it (`lib.rs:1003-1004`),
the app polls its stamp and applies changes live, and the watcher's own
comment already names this exact use: "it is how the agent in the chat panel
changes your settings when asked, with no new tool surface at all"
(`App.tsx:742-744`). The mechanism is done. What the agent lacks is
*knowledge* — that the file exists, where it is, and the etiquette of editing
it. Knowledge is what skills are for, so the seed's instinct is right: this
is a skill that ships with the app.

## Why a skill, and not a tool

The alternative shape — an ACP-side "set setting" command, or a chat
convention the panel intercepts — would be a second door to the same room.
The app's whole thesis is that the file is the interface: a person edits it
in VS Code, a sync daemon replaces it, an agent writes it, and all three land
in the same watcher, the same parse-or-keep-last-good, the same telemetry
shallow-compare (`App.tsx:776-788`). A dedicated tool would bypass the schema,
need its own validation, and teach agents a private protocol where a public
file already works. The skill costs a markdown file; the tool costs a
protocol.

There is also a safety argument for the file path, and it comes free. The
agent's session is rooted in the repository (`session.rs` hands the repo as
the session's cwd), and `settings.json` lives outside it — so an agent
reaching for it trips the ordinary permission machinery, and the request
arrives as a card in the transcript like any other out-of-tree write. "Agent
can change all settings" never means "silently"; the consent flow is the one
the app already has, not a new grant invented here.

## What the skill says

The delivery machinery is ready: `skill.ts` holds a table of bundled skills
with named fences and per-skill Claude paths (`skill.ts:35`), and a settings
skill is one more row plus `skills/settings/SKILL.md`. Following the argument
made for the review skill, it installs everywhere the others do — the text is
small and inert in a repo whose owner never asks for it.

The content, argued:

- **Where the file is.** The config directory is per-platform but
  deterministic from the app identifier (`com.ratulmaharaj.plans`,
  `tauri.conf.json:5`): `~/Library/Application Support/…` on macOS, the XDG
  config home on Linux, `%APPDATA%` on Windows. The skill carries that table.
  The settings page also shows the resolved path — the skill says so, as the
  fallback for a platform the table gets wrong.
- **Read the schema, not your memory.** `settings.schema.json` sits beside
  the file, rewritten on every launch from this build's own `Settings` type
  (`lib.rs:1071-1073`), so it is always the truth about which keys exist,
  which enums are legal, and which ranges bind. An agent that reads it first
  cannot invent a key or a value the app will shrug at.
- **The etiquette.** Rewrite the whole file in one write — the watcher
  tolerates a torn write by keeping the last good settings and saying so
  (`App.tsx:746-748`), but one write means it never has to. Keep `$schema`
  (the app treats it as its own, `settings.ts:355-356`). Keep keys you do not
  recognise — the app itself preserves extras on every save (`settings.ts:331`),
  and an agent should clear the same bar. Leave the app-managed keys
  (`lastSeenVersion`, `treeWidth`) alone; the schema marks them.
- **How to know it worked.** The change is its own confirmation — the theme
  turns, the panel moves — but the skill also tells the agent to re-read the
  file after the app's next write if it needs certainty, rather than
  narrating success it has not seen.

## The trap this plan has to fix

The settings poll is gated on `watchSeconds > 0` (`App.tsx:750`), because it
joined the general watching rhythm — and that gate breaks this feature in the
one configuration that most needs it. Someone who set `watchSeconds: 0` and
then asks the agent for a dark theme gets silence: the write lands, the app
never looks. Worse, the failure teaches the person that the feature is flaky,
not that a setting is off.

The document watcher can honour `watchSeconds: 0` — that is a choice about
*repository* churn. The settings file is one `stat` every few seconds
(`settings_stat` exists precisely so a quiet poll costs a stat, not a read —
`lib.rs:1068-1070`), and it is the only channel through which the file can
ever be turned back on. The settings poll should run unconditionally, at a
fixed gentle interval, and this plan makes that change. A setting whose
observer can be configured away is a setting that can wedge itself.

## Open questions

- Should the chat preamble mention the settings path once per session, the
  way it mentions the open plan (`ChatPanel.tsx:432`)? It would make the
  skill's platform table redundant on the machine that matters — but it
  spends context on every session for a request most sessions never make.
  Leaning no: the skill is enough, and the table is four lines.
- Sharp keys: `telemetry`, `updates`, and `keyOverrides` are all legal
  targets, and "all settings" is the title. Is the out-of-tree write
  permission enough ceremony, or should the skill tell the agent to confirm
  in conversation before flipping privacy-adjacent switches? Leaning: the
  skill says to state what it is about to change and why — prose, not
  machinery.
- If two agents (or an agent and the app) write in the same poll window, last
  write wins with no stamp check — `settings_write` returns the new stamp but
  nothing compares an expected one, unlike `write_plan`'s optimistic check
  (`api.ts:190`). Is a settings file worth the same STALE dance, or is
  last-write-wins honest enough for a file this small?
- The identifier is baked into the skill's path table; if it ever changes,
  the skill lies until someone remembers. Generate the table into the skill
  at build time, or accept the risk?

## Next

- [ ] Write `skills/settings/SKILL.md`: the platform path table,
      read-the-schema-first, the etiquette (one write, keep `$schema` and
      extras, app-managed keys), state-your-change, verify-by-reading
- [ ] Add the row to `SKILLS` (`skill.ts:35`) with its named fence;
      installs with the rest
- [ ] Unhook the settings poll from `watchSeconds` — unconditional, fixed
      interval, still a `stat` when quiet
- [ ] e2e: an outside write to the settings file changes the app while a
      chat is open; a torn/invalid write keeps last-good and toasts once
- [ ] Decide the stamp-check question before anyone builds multi-writer
      habits on last-write-wins
