---
status: done
---
# Auto-Updates

Upgrading Plans currently means noticing that a new release exists, finding it,
downloading a `.dmg`, mounting it, and dragging the app over the old one. Most
people will not do that, which means a fix can be built, signed, notarized,
published — and still reach nobody.

The goal: an installed copy of Plans learns about a new version on its own,
says so quietly, and updates itself when the reader presses a button.

Almost everything the updater needs already exists.
`.github/workflows/release.yml` produces signed, notarized universal builds and
gates them behind a draft release that a human has to publish. This plan adds
the feed and the client, not a new release process. The notes shown alongside
an update come from [`5_changesets.md`](./5_changesets.md).

## Approach

`tauri-plugin-updater`, pointed at GitHub Releases. No hosted service, no
separate feed to keep alive, no second place where a release can be half-done.

Rust, in `src-tauri/Cargo.toml`:

- `tauri-plugin-updater` — the check, download, and install
- `tauri-plugin-process` — the relaunch afterwards

Both registered next to `tauri_plugin_opener` and `tauri_plugin_dialog` in
`lib.rs:790`. Frontend: `@tauri-apps/plugin-updater` and
`@tauri-apps/plugin-process`, called through the profiling wrapper in `api.ts`
like every other IPC call, so update timings land in the perf HUD alongside
everything else.

`src-tauri/capabilities/default.json` gains `updater:default` and
`process:allow-restart`. `tauri.conf.json` grows its first `plugins` block, and
`bundle.createUpdaterArtifacts: true`, which makes the build emit the
`.app.tar.gz` and `.sig` pair the updater consumes. The `.dmg` stays exactly as
it is — it remains the first-install path, and the updater artifacts sit beside
it rather than replacing it.

This is also the first thing in the app to need a `setup` hook and app state.
`lib.rs` today has neither, no `.manage(...)`, and no command emits an event.
The periodic check wants all three. Worth doing deliberately rather than
discovering it halfway through.

## Signing

The updater has its own keypair, unrelated to the Apple one. Apple's signature
says the bundle came from a known developer; the updater's signature says this
specific archive is the one we published. Both are needed, and they fail
differently.

```sh
pnpm tauri signer generate -w ~/.tauri/plans.key
```

The **public** key is pinned in `tauri.conf.json` and compiled into the binary.
The private key becomes two more repo secrets, added to the table in
`RELEASES.md`:

| Secret                               | Value                                 |
| ------------------------------------ | ------------------------------------- |
| `TAURI_SIGNING_PRIVATE_KEY`          | contents of the generated private key |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | the password set when generating it   |

The updater verifies the signature before it replaces anything on disk, so a
compromised feed cannot install a payload. That property holds only while the
private key stays in CI, and it is unrecoverable if the key is lost: a new
keypair means every installed copy stops seeing updates, silently, forever.
Back it up somewhere that is not the repo.

## The feed

```
https://github.com/RatulMaharaj/plans/releases/latest/download/latest.json
```

`tauri-action` generates `latest.json` and attaches it to the release. The
`releases/latest/download/` path resolves to the newest **published**
release — drafts and prereleases are invisible to it.

That is the reason not to invent a separate hosted feed: the existing gate in
`RELEASES.md` becomes the update gate for free. Nothing reaches an installed
app until someone has mounted the `.dmg`, launched it, and pressed Publish. The
`verify` job still stands between the build and that button.

## When it checks

- **On launch**, after a short delay. Never on the critical path to first
  paint — the window is up and usable before any network call happens.
- **On an interval** for sessions that stay open for days, which is the normal
  way an editor gets used.
- **On demand**, from a *Check for updates* command in `Palette.tsx` and a
  control in `SettingsPage.tsx`.

Automatic failure is silent. Offline, behind a corporate proxy, GitHub having a
bad afternoon — none of these are the reader's problem to solve, and none of
them should produce a message. A check the reader asked for reports its result
either way, including "you're up to date", because silence there reads as a
broken button.

## What the reader sees

A quiet banner, not a modal. Nothing about an update is urgent enough to take
the document away from someone mid-sentence.

- The new version number and the notes from the `notes` field of `latest.json`,
  which `changesets.md` fills from `CHANGELOG.md`
- *Install and restart* / *Later*
- Download progress in place, on the banner
- Relaunch via `relaunch()` from the process plugin

Nothing downloads or installs without a press. After the relaunch, the release
notes sheet opens by itself, because `lastSeenVersion` in `settings.ts` no
longer matches the running version — the two features meet there, and neither
needs to know about the other.

A new setting alongside the rest in `settings.ts`:

- `updates`: `notify` (default) | `off`

No `auto` mode. Replacing a running editor's own binary without being asked is
not a thing to do to someone who has unsaved text in it.

## CI

Extend the `verify` job in `release.yml`. It currently mounts the `.dmg` and
checks `codesign` and `spctl`; it should also assert that the release carries
`latest.json`, the `.app.tar.gz`, and its `.sig`.

This matters more than it sounds. A release missing its updater artifacts looks
completely fine — the `.dmg` is there, signed and notarized, the release notes
read well, the publish succeeds — and is simply invisible to every installed
copy. The failure has no symptom until someone asks why they never got the
update.

## Open questions

- How does the updater behave in `tauri dev` and under Playwright? `e2e/fake-backend.ts`
  stubs the IPC layer, so the check must be made genuinely inert there, not
  merely never triggered — a test run that reaches out to GitHub is flaky by
  construction, and one that starts downloading a build is worse.
- Universal binaries mean every update is both architectures. That is a larger
  download than it needs to be; per-arch feeds halve it at the cost of a second
  build matrix and a second thing to get wrong. Probably not worth it yet, but
  the size should be measured before deciding.
- What happens when the app is not in `/Applications` — running from
  `~/Downloads`, or from a read-only volume? The install will fail; the
  question is whether it fails legibly, and whether the failure should point
  the reader at the `.dmg` instead.
- Staged rollout (a percentage in `latest.json`) is real insurance against
  shipping a bad build to everyone at once, and meaningless with a handful of
  users. Revisit when there are enough installs for a percentage to mean
  anything.
- Should the app ever refuse to run a version the feed marks as broken? That is
  a kill switch, and a kill switch is a thing an update server can do to a
  reader's working copy. Leaning no.

## Next

- [x] Generate the updater keypair; add both secrets; back the key up off-repo
- [x] `createUpdaterArtifacts: true`, `plugins.updater` block with pubkey and endpoint
- [x] Confirm `.app.tar.gz`, `.sig`, `latest.json` exist — the v0.1.0 tag did it,
      and the `verify` job now fails without them
- [x] Extend the `verify` job to require all three
- [x] Register the updater and process plugins in `lib.rs`; update capabilities
- [x] Manual *Check for updates* command in `Palette.tsx`, result reported either way
- [x] Update banner with notes, progress, and relaunch
- [x] `updates` setting; launch check behind it, and an interval check beside it
      — driven from the frontend rather than a Rust `setup` hook, which nothing
      else needed once the check stopped being on the path to first paint
- [x] Make the check inert in `e2e/fake-backend.ts`
- [ ] End-to-end test: install 0.1.0 from the `.dmg`, publish 0.1.1, update in place
- [x] Update `RELEASES.md` — auto-update moves out of *Not yet covered*
- [ ] <br />
