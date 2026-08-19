---
status: draft
---
# Mention A Plan With @

Typing `@` in the composer should offer the repository's plans, and put the one
you pick into the turn as context the agent can read — without you pasting it,
and without it filling the transcript.

## Why it is worth doing

The chat is per repository, and a turn says which plan is on screen only when
that changes (`ChatPanel.tsx`, the `where` line in `send`). That covers the
common case and nothing else: talking about *two* plans, or about one you are
not looking at, currently means pasting a path and hoping the agent reads it.

The protocol already has the answer. `claude-agent-acp` advertises
`promptCapabilities.embeddedContext: true` at `initialize` — verified, it is in
the handshake this app already makes — and a `session/prompt` takes an array of
content blocks, not a string. We send exactly one, `ContentBlock::Text`
(`session.rs:155`). A mention is a second block.

`@` was deliberately left free for this when the palette took `#` for chats.

## The shape

- **The picker is the slash list again.** `ChatPanel.tsx:491` matches `/^\/(\S*)$/`
  and filters `thread.commands`; `@` is the same idea filtering the repo's plan
  files, which `App` already holds. Generalising that one regex and list is
  most of the frontend work — resist building a second popup.
- **The turn carries blocks, not a sentence.** `agent_prompt` grows from
  `text: String` to something like `text` plus `mentions: Vec<String>`, and
  `session.rs` maps each to a resource-link or embedded-resource block beside
  the text. Read the ACP content-block types before choosing which; a link the
  agent resolves is cheaper than embedding a file we have already read.
- **The transcript shows the mention, not the file.** A bubble that swallows
  a 200-line plan is a bubble nobody scrolls past twice.

## Open questions

- Link or embed? Embedding is certain — the agent gets the text whether or not
  it can read the path — but it duplicates what is already on disk, and the
  agent's own Read tool exists. Try the link first and see if agents follow it.
- Only plans, or any file in the repo? The tree only shows markdown, and the
  agent can read anything anyway. Start with what the tree shows.
- What happens on a mention of a file that has since moved? Probably nothing
  worth handling: the agent says it cannot find it, which is true.

## Done when

- `@` in the composer offers the repository's plans and completes one.
- The turn arrives with the mention as its own content block, and the agent
  can act on that plan without being told its path in prose.
- The transcript shows which plan was mentioned, not its contents.
- `@` still types as a plain character when there is nothing to complete —
  the same courtesy `/` already gets.

## Next

- [ ] Read the ACP content-block types; decide link vs embed
- [ ] Generalise the slash popup to take a trigger and a list
- [ ] `agent_prompt` takes mentions; `session.rs` builds the blocks
- [ ] A test that the block reaches the agent, and one that the bubble stays short
