---
name: settings
description: How to change any Plans setting by editing settings.json in the app's config directory - where the file is per platform, reading the generated schema first, and the etiquette of writing it back. Use when asked to change the theme, fonts, layout, agent defaults or any other Plans preference.
---
# Changing Plans settings

Everything the settings page can change is one JSON file, and you can edit it.
When someone asks you for a dark theme, a wider measure or a different default
agent, you are being asked to write `settings.json`. The app polls that file
every few seconds and applies what it finds, so the window changes while you
are still in the conversation. There is no separate tool to call and no
command to send through the chat.

The file lives outside whatever repository you have open, so the write goes
through the ordinary out-of-tree permission flow and the person sees a card
asking them to allow it. That is the consent step for this whole skill. Do not
try to route around it.

## Where the file is

The app's config directory is per platform, keyed on the identifier
`com.ratulmaharaj.plans`:

| Platform | Path |
| --- | --- |
| macOS | `~/Library/Application Support/com.ratulmaharaj.plans/settings.json` |
| Linux | `$XDG_CONFIG_HOME/com.ratulmaharaj.plans/settings.json`, and `~/.config/com.ratulmaharaj.plans/settings.json` when that variable is unset |
| Windows | `%APPDATA%\com.ratulmaharaj.plans\settings.json` |

If the file is not at any of those paths, ask the person to open Settings in
the app. The "Settings file" group at the bottom of the page prints the
resolved path, which is the authority when this table is wrong.

## Read the schema before you write

`settings.schema.json` sits in the same directory, and the app rewrites it on
every launch from the build that is actually running. It is the current truth
about which keys exist, which strings are legal for the enums, and where the
numeric ranges stop. Read it first, every time. Guessing a key from memory
gets you a key the app files away as an extra and never reads, which looks
like the setting failed to take.

Two things in the schema to pay attention to:

- Keys marked `readOnly` are bookkeeping the app writes to itself, currently
  `treeWidth` and `lastSeenVersion`. Leave their values alone.
- `telemetry`, `updates` and `keyOverrides` are legal targets like any other
  key. They are also the ones a person will be annoyed to find changed by
  surprise, so say what you are about to do before you do it.

## Writing the file

Read the whole file, change the keys you mean to change, and write the whole
thing back in one write. The app tolerates a torn write by keeping the last
good settings and saying so in a toast, and one write means it never has to.

Keep `$schema` at the top with its existing value. The app writes that key
itself and an editor uses it for completion.

Keep every key you do not recognise. A file written by a newer build, or by a
hand that got ahead of the release, holds keys this build has no field for,
and the app itself preserves them on every save. You should clear the same
bar. This means that dropping unknown keys because they are not in the schema
is a way of deleting someone's settings.

Say what you are changing, in prose, before you write. "I'm going to set
`theme` to `night` and leave the rest of the file as it is" is enough. For the
privacy-adjacent keys above, say it and wait for the person to agree rather
than folding the change into a larger edit.

## Knowing it worked

Most of the time the change is its own confirmation. The theme turns, the tree
gets wider, the font changes, and the person watching the window can see it.

When you need to be certain, read the file back after a few seconds and check
the value you wrote is still there. The app rewrites the file whenever
settings change, and reading it back is how you tell "it was applied" apart
from "I wrote it and nothing happened". Report what you actually read. Do not
narrate a success you have not seen.
