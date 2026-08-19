---
status: ready
---
# Speak ACP, and let the agent tell us what it can do

## Context

The chat works, but the abstraction under it is a pretence. `chat.rs` hardcodes
Claude Code's argv (`-p`, `--output-format stream-json`, `--include-partial-messages`,
`--permission-mode acceptEdits`, `--resume`) and parses Claude Code's JSON shapes,
so "which agent" is a dropdown with one real entry and a note apologising for the
other. There is no model picker, no reasoning-effort control, no slash commands,
and no way for the agent to ask before it edits — not because they were skipped,
but because there is nowhere in this design to put them. `chat_agents` returning
`supported: false` for codex is that gap wearing a label.

T3 Code ([pingdotgg/t3code](https://github.com/pingdotgg/t3code)) solves the same
problem the same way for five agents: one adapter per provider, each talking
**JSON-RPC over stdio**, so one UI drives them all. For OpenCode that protocol is
**[ACP](https://agentclientprotocol.com)** — an open standard with an
[official Rust SDK](https://github.com/agentclientprotocol/rust-sdk) — and ACP is
what turns the three missing features into things we render rather than things we
build:

- **Model and effort are not ours to know.** `session/new` returns `configOptions`:
  a list of `{id, name, category, type:"select", currentValue, options[]}` with
  reserved categories `model`, `thought_level`, `mode`. We draw a dropdown per
  option and call `session/set_config_option`. The picker exists for every agent
  without the app learning a single model name.
- **Slash commands** arrive as `available_commands_update` with names, descriptions
  and input hints, and are invoked by sending `/name args` as ordinary prompt text.
- **Permissions** become a request *to us* (`session/request_permission`) instead of
  a flag that guarantees we are never asked.

Decisions already taken: go all-in on ACP and delete the stream-json path; the agent
command is configurable rather than a bare binary name; keep accepting edits by
default but wire the permission path so an agent's mode picker can turn it on.

**The inversion that drives everything below:** today the unit of work is a *turn* —
spawn, parse, die. Under ACP it is a *session* — one long-lived process per repo that
outlives every turn, holds the session id, and talks back. Process ownership,
cancellation, and quit behaviour all follow from that.

## Verified against the real thing

Both open questions were settled by running a probe client against
`@agentclientprotocol/claude-agent-acp` 0.70.0. Recorded here because it changes
several details below, and because the next person should not have to re-derive it.

**The async model is simple.** `agent-client-protocol` 2.0.0 builds cleanly and its
API is `Client.builder().on_receive_notification(…).on_receive_request(…)
.connect_with(agent, |connection| async { … })`, driven by a plain `#[tokio::main]`
multi-thread runtime. `AcpAgent::from_str("npx -y …")` spawns the subprocess *and* is
the transport. **No `LocalSet`, no current-thread runtime, no thread-per-session.**
The earlier draft of this plan assumed otherwise, from 0.x guidance that no longer
holds. Permission requests arrive as an async closure with a `responder`, so awaiting
a human answer inside one is natural rather than a fight.

**The package is `@agentclientprotocol/claude-agent-acp`** (bin `claude-agent-acp`).
`@zed-industries/claude-code-acp` is the old name and is deprecated, though several
guides still print it.

**What the adapter actually advertises**, from `session/new` — all four are `select`
options in one list, which is the whole argument for rendering them generically:

| id | category | values |
|---|---|---|
| `model` | `model` | Default, Opus (1M), Fable, Sonnet, Haiku — each with a description |
| `effort` | `thought_level` | default, low, medium, high, xhigh, max |
| `mode` | `mode` | Auto, Manual, Accept Edits, **Plan Mode**, Don't Ask, Bypass Permissions |
| `agent` | *(none)* | Default, plus every agent persona configured locally |

Note that `agent` has **no category at all**. Anything that switched on the reserved
categories would have silently dropped it — render the list, do not curate it.

**Tool calls carry their own title.** A `tool_call` notification is followed by
`tool_call_update`s sharing a `toolCallId`, and the update carries
`title: "Read note.md"`, `kind: "read"`, `status: "completed"`, `locations[]` and the
content. `tool_detail()`'s field-name guessing is not merely replaceable — it is
obsolete.

**Also on the wire, unasked for:** `available_commands_update` (every local skill and
command, with descriptions), `usage_update` with tokens *and* cost in USD, and
`agentCapabilities.loadSession: true` — so resumption after a crash is available, and
a context/cost readout is nearly free.

**The default mode is `auto`**, a model classifier that approves or denies without
asking. That matches the decision to stay permissive by default, and it means the
permission UI is exercised only when the human picks Manual — which the mode picker
in stage 3 gives them.

## Rust: `chat.rs` becomes `agent/`

Split by what changes for different reasons:

- **`agent/discover.rs`** — `login_path()` and `resolve()` move here **verbatim,
  comments included**. They are the most valuable code in the current file (a
  Finder-launched GUI has only launchd's PATH), and ACP changes nothing about their
  reasoning. `a_binary_outside_this_process_path_is_still_found` moves with them.
  Add the agent catalogue: `{id, label, program, args, install_hint}` —
  `("npx", ["-y", "@agentclientprotocol/claude-agent-acp"])`, plus `codex-acp`,
  `gemini --experimental-acp`, `opencode`.
- **`agent/session.rs`** — the per-session thread: spawn the child, `initialize`,
  `session/new {cwd: repo}`, then loop on an `Op` channel
  (`Prompt`, `Cancel`, `SetConfig`, `PermissionAnswer`, `Shutdown`).
- **`agent/client.rs`** — the `Client` trait impl.
- **`agent/events.rs`** — `session/update` → Tauri event mapping, and its serde
  types. The one place worth testing hard.
- **`agent/mod.rs`** — Tauri commands and state.

State is `Agents(Mutex<HashMap<String /*repo*/, Live>>)`, keyed by repo because the
transcript already is (`plans.chat.v2::<repo>`). Tauri commands stay synchronous and
still return `R<T>`; they only push an `Op`, so `lib.rs`'s handler list changes in
names, not in style.

**Lifecycle.** Start lazily on the first prompt, not at boot — booting a process for
someone who never opens the chat is rude, and `initialize` may prompt for auth.
Survive plan switches and panel close. On child exit, emit `agent-down` with the tail
of stderr; the next prompt restarts and uses `session/load` when the agent advertised
`loadSession`. **Add a `RunEvent::Exit` handler in `lib.rs`** to shut sessions down:
today's children are per-turn and short-lived, and a forgotten `node` per repo is a
real regression. Watch for `npx` orphaning its child — consider a process group.

**`fs/write_text_file`** is a new attack surface the old design did not have.
Canonicalise and refuse anything outside `cwd`, in one function, with a test. The
existing watcher and git panel pick the writes up exactly as before.

## The event set: redesign, don't retrofit

The four `chat-*` events cannot carry ACP. `chat-tool` has no id, so a tool line can
never go running → done, and there is no channel for thinking, plans, permissions or
config. Replace with `agent-*`:

| Event | Payload |
|---|---|
| `agent-message` / `agent-thought` | `{repo, turn, text}` |
| `agent-tool` | `{repo, turn, callId, title, kind, status, locations[]}` — UI upserts on `callId` |
| `agent-plan` | `{repo, entries[]}` |
| `agent-commands` | `{repo, commands[]}` |
| `agent-config` | `{repo, options[]}` |
| `agent-permission` | `{repo, turn, requestId, callId, title, options[]}` |
| `agent-turn` | `{repo, turn, stop}` |
| `agent-down` | `{repo, message}` |

`turn` stays a counter so ChatPanel's "route late events by turn id" machinery
survives; `repo` is added because the process now outlives the turn.

**`tool_detail()` and its guessed Claude field names are deleted.** ACP tool calls
carry a `title` the agent wrote for display. Its three tests are replaced by tests
that the title is shown and that an update with the same `callId` replaces rather
than appends.

## UI

**`src/ChatPanel.tsx`** — `Msg` becomes a discriminated union: `user`/`assistant`/
`thought` carry text; `tool` carries `{callId, title, kind, status}`; `permission`
carries `{requestId, title, options, answered?}`; `note` for seams and errors. `say()`
gains a sibling `upsertTool(callId, patch)` using the same backwards scan, so it reads
as a variant of an established idea. `Thread` gains `commands`, `configOptions`, `plan`.

On reload, any persisted `pending` tool becomes `interrupted` and an unanswered
permission renders as inert text — otherwise the transcript shows live-looking buttons
wired to a dead process.

**`src/AgentOptions.tsx`** (new) — renders `configOptions` as a row of the existing
`Dropdown`, reserved categories first. **Never hardcode "model" or "effort"**; the
agent says what it has. Render nothing when the list is empty. On change, call
`agent_set_config` and replace the whole list from the reply.

**Slash commands** — in the textarea's existing `onKeyDown`, when the value matches
`/^\/(\S*)$/`, show a filtered popup over `thread.commands`. The sent text is
unchanged; the agent parses the slash itself. Arrow keys `stopPropagation` as the
chord handling already does. No new Tauri command.

## Settings

`checked()` — "a binary name is a word, not a command line" — is now wrong, since the
canonical invocation is `npx -y @agentclientprotocol/claude-agent-acp`. Relaxing it to
free text would be worse: that is arbitrary code execution from a settings string, and
there is no shell anywhere in this codebase.

So: `chatCommand` becomes a catalogue id, plus `chatCommandArgv: string[]` used only
when it is `"custom"` — edited as a list of fields, not one text box. **Argv-as-array
is what makes it un-shell-able.** `checked()` becomes `checked_argv()`: non-empty,
program resolvable. `AgentFound.supported` becomes `ready` and the "installed but
speaks the wrong protocol" caveat disappears — every catalogue entry speaks ACP by
construction. `agentCommand` (clipboard) and `handoffPrompt` are untouched.

Pin the version in the catalogue args so a protocol-breaking npm release cannot break
the app overnight.

## Migration

Bump to `plans.chat.v3::<repo>`. v2's `{role,text}` maps cleanly onto the new `note`
role, so migrate one way and **drop the stored session id** — a Claude CLI session id
means nothing to `session/load`. Show one `note` at the seam: *"New agent session —
earlier context is not carried over."* Following the v1→v2 comment's own reasoning:
preserve what was said, don't pretend a continuity that isn't there.

No agent installed behaves as it does now — the panel hides, and Settings shows the
install hint instead of a chat that fails.

## Staging

1. **Parity.** `agent/`, one catalogue entry, session lifecycle, message/tool/turn/down
   events, permissions auto-approved (matching today's `acceptEdits`), v3 migration,
   `chat.rs` deleted. Usable at the end of this stage, behaving as today.
2. **Permissions.** `request_permission` in the transcript; cancel resolves pending
   requests; a per-repo "always allow edits" toggle keeps stage 1's behaviour.
3. **Config options and commands.** `AgentOptions.tsx`, slash autocomplete. *This is
   where the model picker and reasoning effort arrive — for every agent, free.*
4. **The rest.** More catalogue entries, `session/load` after a crash, thinking
   rendering, plans as a todo strip, MCP servers in `session/new`, markdown.

## The hard parts

- **Permission deadlock.** The agent blocks on us; we block on a user who may have
  closed the panel. Every exit — cancel, panel close, repo switch, quit, agent death —
  must resolve the oneshot as cancelled. Test it.
- **The SDK's async model**, per §"verify first". Riskiest assumption in the plan.
- **Process cleanup on quit**, including `npx`'s shim.
- **Protocol drift.** ACP and the wrappers are young; pinning is a judgement call.

## Verification

- `cargo test` — event-mapping tests in `agent/events.rs` feeding literal
  `SessionNotification` JSON and asserting the emitted payload. Direct successor to
  `the_stream_shapes_we_rely_on_parse`, and the test that catches an SDK bump.
- **A scripted fake ACP agent** (`tests/fake_agent.rs`): reads JSON-RPC on stdin,
  answers `initialize` and `session/new`, and on `session/prompt` emits two chunks, a
  tool call, a permission request, then `end_turn`. Point a real session thread at it.
  The only way to test the permission round-trip and cancel-resolves-pending, and it
  needs no network, no node, no auth. **Highest-value new test asset in the change.**
- `npx playwright test` — `e2e/fake-backend.ts` grows `agent_*` handlers;
  `agent_set_config` returns a *mutated* list so "the picker reflects the agent's
  answer, not the click" is testable. Most of chat.spec.ts survives with renamed
  events, plus: a tool row updating in place, a permission answered from the
  transcript, a slash completion, a picker driven by advertised options, a crash
  mid-turn.
- `cargo clippy --all-targets`, `cargo fmt --check`, `npx tsc --noEmit`.
- **By hand, in the real app** (the tests cannot show this): launch from Finder,
  confirm the agent is found, that prose streams, that a tool line goes running → done
  with a real title, and that the model and effort dropdowns are populated by the agent.
