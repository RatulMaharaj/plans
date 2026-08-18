# Releasing Plans

Plans ships as a signed and notarized macOS `.dmg`, built by
[`.github/workflows/release.yml`](.github/workflows/release.yml). This document
covers the one-time setup and the per-release routine.

Signing and notarization are not optional polish: an unsigned build downloaded
from the internet is quarantined by Gatekeeper and shows up as *"Plans is
damaged and can't be opened"* on anyone else's Mac. The workflow is built so
that a broken signature fails CI rather than a user's machine.

---

## One-time setup

### 1. Developer ID Application certificate

Notarization requires that specific certificate type — an *Apple Development*
or *Apple Distribution* cert will **not** work.

1. Create one at [developer.apple.com/account/resources/certificates](https://developer.apple.com/account/resources/certificates).

2. Download it, double-click to add it to your login keychain.

3. In Keychain Access, find it, right-click → **Export** → `.p12`, and set a
   password. Export the certificate *with its private key*.

4. Base64 it for GitHub:

   ```sh
   base64 -i Certificates.p12 | pbcopy
   ```

5. Note the identity string exactly as it appears:

   ```sh
   security find-identity -v -p codesigning | grep "Developer ID Application"
   # -> "Developer ID Application: Your Name (TEAMID)"
   ```

### 2. App Store Connect API key

Notarization uses an API key rather than an Apple ID and app-specific password:
it isn't tied to a personal account, survives 2FA changes, and can be revoked on
its own.

1. Create a key at [appstoreconnect.apple.com/access/integrations/api](https://appstoreconnect.apple.com/access/integrations/api)
   with the **Developer** role.
2. Download the `.p8` — **Apple only lets you download it once.**
3. Note the **Key ID** and the **Issuer ID** shown on that page.
4. Base64 it:

   ```sh
   base64 -i AuthKey_XXXXXXXX.p8 | pbcopy
   ```

### 3. Updater signing keypair

The updater has its own keypair, unrelated to the Apple one. Apple's signature
says the bundle came from a known developer; the updater's says *this specific
archive is the one we published*. Both are needed, and they fail differently.

```sh
pnpm tauri signer generate -w ~/.tauri/plans.key
```

The **public** key is pinned in `src-tauri/tauri.conf.json` and compiled into
the binary. The private key goes into the secrets below.

> **Back the private key up somewhere that is not this repo.** The updater
> verifies the signature before it replaces anything on disk, so a compromised
> feed cannot install a payload — but that property holds only while the private
> key stays in CI, and losing it is unrecoverable. A new keypair means every
> installed copy stops seeing updates, silently, forever.

### 4. Repo secrets

Add these under **Settings → Secrets and variables → Actions** on
`RatulMaharaj/plans`. This is a personal repo, so the `loopedautomation` org
secrets used by `whisper` and `meet` do not reach it — the values can be the
same if it's the same Developer ID team, but they have to be set here too.

| Secret                         | Value                                               |
| ------------------------------ | --------------------------------------------------- |
| `MACOS_CERTIFICATE_P12_BASE64` | base64 of the Developer ID Application `.p12`       |
| `MACOS_CERTIFICATE_PASSWORD`   | the password you set when exporting the `.p12`      |
| `APPLE_SIGNING_IDENTITY`       | e.g. `Developer ID Application: Your Name (TEAMID)` |
| `APPLE_API_KEY_ID`             | App Store Connect key id                            |
| `APPLE_API_ISSUER_ID`          | issuer id for that key                              |
| `APPLE_API_PRIVATE_KEY_BASE64` | base64 of the `.p8` private key                     |
| `TAURI_SIGNING_PRIVATE_KEY`    | contents of `~/.tauri/plans.key`                    |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | the password set when generating it, or empty |

Certificates expire (typically 5 years) and the workflow will start failing at
the signing step when yours does. Regenerate and update the two `MACOS_*`
secrets.

---

## Cutting a release

1. Collect the changesets into a version and a changelog:

   ```sh
   pnpm run version
   ```

   That runs `changeset version` — which consumes everything in `.changeset/`,
   bumps `package.json`, and writes `CHANGELOG.md` — and then
   `scripts/sync-version.mjs`, which copies the new version into
   `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` and `Cargo.lock`, and
   regenerates `src/release-notes.ts` so the app can show its own notes offline.

   Read what it wrote. The changelog section becomes the GitHub release body and
   the sheet the app opens after updating, so this is the moment to fix a note
   that reads badly. CI fails the build if the versions ever disagree
   (`pnpm run version:check`).

2. Commit, then tag and push the version that was just cut:

   ```sh
   git commit -am "Release 0.2.0"
   git tag v0.2.0
   git push origin main v0.2.0
   ```

3. The workflow builds, signs, notarizes, staples, and creates a **draft**
   release. Notarization is Apple-side and usually takes a few minutes.

4. The `verify` job mounts the real `.dmg` and runs `codesign` and `spctl`
   against it, and checks that the release carries `latest.json`, the
   `.app.tar.gz` and its `.sig`. If it goes red, do not publish — see
   *Troubleshooting*. A release missing its updater artifacts looks completely
   fine and is simply invisible to every installed copy.

5. Download the `.dmg` from the draft release, open it, drag Plans to
   Applications, and launch it once. It should open with no Gatekeeper prompt
   at all.

6. The release body is already written, from `CHANGELOG.md`. Read it, then
   **Publish** — that press is what makes the release visible to
   `releases/latest/download/latest.json`, and so to every installed copy.

### Building without releasing

Run the workflow manually from the Actions tab (`workflow_dispatch`). It builds
and signs exactly as a tagged run does, but creates no release — the `.dmg`
lands as a workflow artifact you can download and test. Use this to validate
secrets before your first real tag.

---

## What the workflow actually does

| Step                                                | Why                                                                                                                                                      |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Universal build (`--target universal-apple-darwin`) | One download that runs on both Apple Silicon and Intel, rather than an arch the user has to pick correctly.                                              |
| `tauri-action` with `APPLE_CERTIFICATE*`            | Tauri imports the `.p12` into a temporary keychain and signs the app with hardened runtime enabled.                                                      |
| `.p8` written to `$RUNNER_TEMP`                     | Tauri wants the notarization key as a file on disk. `$RUNNER_TEMP` is wiped when the job ends and never lands in an artifact.                            |
| Notarize + staple                                   | Stapling embeds Apple's ticket in the bundle so the app launches offline without a Gatekeeper round-trip.                                                |
| Draft release                                       | Nothing reaches users until someone opens it, checks the installer, and publishes — which is the update gate too, since the feed only sees published releases. |
| Updater artifacts + `latest.json`                   | The `.app.tar.gz` and its signature are what an installed copy downloads; `latest.json` is the feed it reads. The `.dmg` remains the first-install path. |
| Separate `verify` job                               | Signing fails subtly — wrong identity, or notarized without stapling. Verifying the real artifact with Apple's own tooling beats trusting the build log. |

Signing degrades gracefully: with no certificate secrets the build still runs
and produces an unsigned app, so a manual run never blocks on secrets that
aren't set up yet. That build is for local testing only — the `verify` job
fails any *tagged* release that isn't properly signed.

---

## Troubleshooting

**`No signing certificate found` / signing step fails**
The `.p12` is missing its private key, or `APPLE_SIGNING_IDENTITY` doesn't match
the cert byte-for-byte. Re-export from Keychain Access selecting the key, and
copy the identity string out of `security find-identity -v -p codesigning`.

**Notarization returns `Invalid`**
Apple's log says exactly why. Fetch it locally:

```sh
xcrun notarytool log <submission-id> \
  --key AuthKey_XXXXXXXX.p8 --key-id <KEY_ID> --issuer <ISSUER_ID>
```

The usual causes are an unsigned nested binary or a missing hardened runtime
flag on something Tauri bundled.

**`spctl` rejects the app but `codesign` passes**
The app is signed but the notarization ticket wasn't stapled — the app will work
on the build machine and fail on a machine that's offline or has never seen it.

**Nobody is getting the update**
Check the published release actually has `latest.json`, `*.app.tar.gz` and
`*.app.tar.gz.sig` attached, and that the release is *published* rather than a
draft — the feed only ever resolves to a published release.

```sh
curl -sL https://github.com/RatulMaharaj/plans/releases/latest/download/latest.json
```

**`Signature error` when installing an update**
The updater public key in `tauri.conf.json` does not match the private key that
signed the archive. If `TAURI_SIGNING_PRIVATE_KEY` was regenerated, the pinned
public key has to change with it — and every copy installed before that change
will never update again.

**"Plans is damaged and can't be opened" on a user's Mac**
That's the quarantine message for an unsigned or unnotarized download. Confirm
against the shipped artifact:

```sh
spctl --assess --type execute --verbose=4 /Applications/Plans.app
xcrun stapler validate /Applications/Plans.app
```

---

## Not yet covered

- **Windows and Linux.** `bundle.targets` is `"all"`, but the workflow is
  macOS-only by design, not by omission. Both need their own runner and, for
  Windows, a separate code-signing certificate.
- **Staged rollout.** `latest.json` can carry a percentage, which is real
  insurance against shipping a bad build to everyone at once and meaningless
  with a handful of users. Revisit when there are enough installs for a
  percentage to mean anything.
- **Per-arch updates.** Every update is a universal binary, so it is both
  architectures. Per-arch feeds halve the download at the cost of a second build
  matrix and a second thing to get wrong.
- **Homebrew cask.** `looped/whisper` pushes a cask to a tap on each release;
  Plans has no tap wired up.

