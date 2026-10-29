# Releasing

Releases are automatic: `.github/workflows/release.yml` runs when a `v*` tag is pushed (or when the
workflow is triggered manually with a `v*` tag selected). The first job (`quality`) checks that the
tag matches the `apps/desktop/package.json` version and runs `pnpm check`, `pnpm lint` and
`pnpm test`; if any of them fails, packaging does not start. A manual run triggered from a branch
stops at this step. It is a one-to-one counterpart of the old (Tauri) pipeline — the three-job
`release.yml` in the `codezal/app` repository — adapted to electron-builder.

As in the old pipeline, there is **no rsync/SSH**: the `publish` job runs on the update server itself
(a self-hosted Linux runner) and copies the files locally under `/var/codezal-updates`; nginx serves
that directory as `https://updates.codezal.com/`.

## Workflow

| Job | Runner | Output |
| --- | --- | --- |
| `macos` | `[self-hosted, macOS]` | Signed + notarized arm64/x64 DMG, ZIP, `latest-mac.yml` |
| `windows` | `windows-latest` (GitHub) | `Codezal-Setup-<sürüm>.exe`, `latest.yml` |
| `publish` | `[self-hosted, Linux]` | `latest.json`, the copy of the files on the server, release verification |

### Gates kept from the old pipeline

- **Tag/version match:** If the tag (`v1.0.0`) and the `apps/desktop/package.json` version differ, the
  job stops at the very start; a wrong version is never announced.
- **Signing + notarization regression gate:** After packaging, the `.app` and `.dmg` are checked with
  `codesign --verify --deep --strict` and `xcrun stapler validate`. If an ad-hoc signature or any
  signature other than `Developer ID Application` is found, the release stops — if an unsigned DMG
  were silently released, users would get a "damaged" warning and the update would be rejected.
- **Copy order:** Binaries first, manifests last. The client never sees a manifest that points to a
  file that is not yet on the server.
- **Post-release verification:** The `publish` job actually requests the manifests and files with
  `release:verify`; a 404 or a version mismatch does not count as a green release.
- **Intermediate artifact cleanup:** After a successful release, the `mac-files`/`win-files`
  artifacts are deleted; if the release fails, they are kept (for 2 days) so it can be retried.
- **Secret names:** Identical to the legacy ones (see below).

**Signing chain (manual, as in legacy):** `CSC_LINK` is **not** passed to electron-builder. 26.15.3
unlocks its own temporary keychain with a random password and passes the `.p12` password as
`set-key-partition-list -k`; on macOS 26 this fails with `SecKeychainUnlock: ... passphrase ... not correct`
and signing never starts. Instead, the `macos` job builds the keychain itself:
`$RUNNER_TEMP/codezal-signing.keychain-db`, a random password, `.p12` import, the partition list
`apple-tool:,apple:,codesign:`, and placing it at the head of the search list. electron-builder finds
the identity there automatically (`CSC_IDENTITY_AUTO_DISCOVERY` is on by default); at the end of the
job the keychain is deleted with `if: always()`. `mac.notarize: true` notarizes and staples the
`.app`s; since electron-builder does not staple DMGs, they are stapled in a separate step
(`DMG'leri notarize et ve mühürle`) with `notarytool submit --wait` + `stapler staple` — the same
job as `make-dmg` in the legacy pipeline.

## Manifests

Three consumers, three separate files — they must not be mixed up:

| Consumer | File it reads | Produced by |
| --- | --- | --- |
| In-app update (macOS) | `latest-mac.yml` | electron-builder |
| In-app update (Windows) | `latest.yml` | electron-builder |
| Website download page (`codezal.com/download`) | `latest.json` | `release:manifest` |

All three sit in the **same folder** as the artifacts.

### Release notes

The in-app update card reads the note from the `releaseNotes` field in the electron-updater feed
(`latest-mac.yml` / `latest.yml`) (`updater.ts` → `info.releaseNotes`). The field is filled through
`releaseInfo.releaseNotesFile`:

1. `pnpm bump <sürüm>` closes the `## [Unreleased]` section in CHANGELOG into a
   `## [<sürüm>] - <tarih>` heading, opens a new empty section above it, and includes the CHANGELOG in
   the `--tag` commit.
2. At the start of the packaging commands (`package:mac`, `package:win`, `package:linux`),
   `apps/desktop/scripts/release-notes.mjs` runs: it extracts that version's section from CHANGELOG
   and writes it to `apps/desktop/release-notes.md` (markdown headings are reduced to a `**Heading**`
   line; the update card shows plain text). The file is in `.gitignore`.
3. electron-builder writes this file into the feed as `releaseNotes`; `release:verify` checks that the
   field is present in the release (if it is missing, release verification fails).

If the version's section is missing from CHANGELOG, `release-notes.mjs` warns and writes an empty
file; local trials are not blocked, and the missing note is caught at the `release:verify` gate on
release.

> The release source is not GitHub Releases: updates are served from our own server, independent of
> the repository's visibility (when the repository was private, electron-updater's anonymous
> `provider: github` request got a 404). `electron-builder.yml`
> defines `publish: { provider: generic, url: https://updates.codezal.com }`, and the packaging
> scripts run with `--publish never` (the generic provider cannot upload; in CI, on a tag push,
> electron-builder would try to publish and fail).

The shape of `latest.json` is the website's contract (`codezal-website/src/lib/release.ts`): URLs are
not built from a template, the URL in `downloads` is used as is, and only `.dmg`/`.exe` are accepted.
If a field is missing or the extension does not match, the site leaves the download cards inactive —
it is better to give no link than to link to the wrong file.

```json
{
  "version": "1.0.0",
  "notes": "https://codezal.com/docs#intro",
  "pub_date": "…",
  "downloads": {
    "macArm": "https://updates.codezal.com/Codezal-1.0.0-arm64.dmg",
    "macIntel": "https://updates.codezal.com/Codezal-1.0.0-x64.dmg",
    "win": "https://updates.codezal.com/Codezal-Setup-1.0.0.exe"
  }
}
```

## One-time setup in the new repository

### 1. Runners

The `macos` and `publish` jobs need self-hosted runners. The legacy remote `github.com/codezal/app` no
longer exists; the old registrations must be **re-attached** to the `esmworks/codezal` repository:
Settings → Actions → Runners (`https://github.com/esmworks/codezal/settings/actions/runners`).

- `macos` job: a runner labeled `[self-hosted, macOS]`.
- `publish` job: a `[self-hosted, Linux]` runner running on the update server itself; it must have
  write access to the `/var/codezal-updates` directory (otherwise the `cp` and `chmod` steps fail).

Until the registrations are moved to the new repository, the Release workflow waits in the queue.

### 2. Apple secrets

`esmworks/codezal` → Settings → Secrets and variables → Actions → New repository secret
(`https://github.com/esmworks/codezal/settings/secrets/actions`). The five names must match the
workflow's usage exactly:

| Secret | Value |
| --- | --- |
| `APPLE_CERTIFICATE` | The **base64** of the Developer ID Application `.p12` file |
| `APPLE_CERTIFICATE_PASSWORD` | The password set when exporting the `.p12` |
| `APPLE_ID` | The email of the Apple Developer account |
| `APPLE_PASSWORD` | **Not** the account password — an app-specific password (notarytool does not accept the account password) |
| `APPLE_TEAM_ID` | `URU3Q835QP` |

Producing `APPLE_CERTIFICATE`: Keychain Access → *login* → My Certificates →
`Developer ID Application: ERHAN ERBAS (URU3Q835QP)` → right-click → Export → `.p12`. The password you
are asked for becomes `APPLE_CERTIFICATE_PASSWORD`. Copy its base64 to the clipboard and paste it into
the secret, then delete the `.p12` file (it contains the private key):

```bash
base64 -i ~/Desktop/DeveloperID.p12 | pbcopy
```

Producing `APPLE_PASSWORD`: [appleid.apple.com](https://appleid.apple.com) → Sign-In and Security →
App-Specific Passwords → generate a new one (`xxxx-xxxx-xxxx-xxxx`).

`APPLE_TEAM_ID`: `URU3Q835QP` — it is the value in parentheses in the output of
`security find-identity -v -p codesigning`.

With the CLI (do not type the values on the command line; paste them when `gh` asks):

```bash
gh secret set APPLE_CERTIFICATE --repo esmworks/codezal < /dev/stdin
base64 -i ~/Desktop/DeveloperID.p12 | gh secret set APPLE_CERTIFICATE --repo esmworks/codezal
gh secret list --repo esmworks/codezal   # shows only names and dates
```

### 3. Windows code-signing certificate

There is none yet; the `.exe` comes out unsigned and SmartScreen shows an "unknown publisher" warning.
Options: an OV/EV certificate (`win.signtoolOptions`) or Azure Trusted Signing. Once a certificate is
obtained, it is added to the `win` section in `apps/desktop/electron-builder.yml`.

## Releasing

```bash
pnpm bump 1.0.0 --tag          # package.json files + CHANGELOG (Unreleased is closed), commit and v1.0.0 tag (does not push)
git push origin HEAD v1.0.0    # triggers the Release workflow
```

The workflow compares the tag with the `apps/desktop/package.json` version; if they differ, it stops at
the very start.

File names are fixed by `artifactName` in `electron-builder.yml`:

```
Codezal-<sürüm>-arm64.dmg      Codezal-<sürüm>-arm64-mac.zip
Codezal-<sürüm>-x64.dmg        Codezal-<sürüm>-x64-mac.zip
Codezal-Setup-<sürüm>.exe
```

`${arch}` is written explicitly: the default template omits the architecture on x64 and produces
`Codezal-1.0.0.dmg` — the site could not tell which card should link to which file.

The site reads `latest.json` with a 30-minute ISR; no redeploy is needed.

## Scripts

| Script | What it does |
| --- | --- |
| `pnpm bump <sürüm> [--tag]` | Writes the version, closes the "Unreleased" section of CHANGELOG into a `## [<sürüm>] - <tarih>` heading; with `--tag`, commit + tag (does not push) |
| `pnpm --filter @codezal/desktop package:mac` / `package:win` / `package:linux` | Packages (`--publish never`) |
| `pnpm --filter @codezal/desktop package:inspect` | Checks the asar contents |
| `pnpm --filter @codezal/desktop release:manifest` | Produces `latest.json` from the real files in `release/`; checks the DMG with `spctl` |
| `pnpm --filter @codezal/desktop release:verify` | Actually requests the manifests and files in the release (the cache is bypassed) |
| `pnpm --filter @codezal/desktop release:upload` | Non-CI fallback only: copies the artifacts with rsync (a dry run without `--yes`) |

`release:manifest` does not invent file names; it uses the `.dmg`/`.exe` files that are actually in
`release/`, reports a missing platform, and stops with an error if a DMG fails the `spctl` check.

Before the first release, `release:verify` reports the current server state like this:

```
- latest.json sürümü 0.5.8, beklenen 0.1.0
- latest.json içinde `downloads` yok; site indirme kartlarını pasif bırakır
- latest-mac.yml yok (404); o platformda uygulama içi güncelleme çalışmaz
```

## Manual release (outside CI)

When the runners are not ready, or for a single-platform fix:

```bash
# CSC_LINK IS NOT PASSED: the Developer ID identity in the local login keychain is used; if macOS asks
# for permission on the first code signing, choose "Always Allow". Notarization needs APPLE_ID/password/team.
pnpm --filter @codezal/desktop package:mac
# The DMG must be stapled too (as in CI):
xcrun notarytool submit release/Codezal-<sürüm>-arm64.dmg --apple-id "$APPLE_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD" --team-id "$APPLE_TEAM_ID" --wait
xcrun stapler staple release/Codezal-<sürüm>-arm64.dmg
pnpm --filter @codezal/desktop package:inspect
pnpm --filter @codezal/desktop release:manifest   # release/latest.json
CODEZAL_RELEASE_TARGET="kullanıcı@sunucu:/var/codezal-updates" \
  pnpm --filter @codezal/desktop release:upload           # dry run, uploads nothing
CODEZAL_RELEASE_TARGET="kullanıcı@sunucu:/var/codezal-updates" \
  pnpm --filter @codezal/desktop release:upload --yes     # real upload
pnpm --filter @codezal/desktop release:verify
```

`release:upload` copies the binaries first and the manifests after; optional `CODEZAL_RELEASE_SSH_KEY`,
`CF_ZONE_ID` + `CF_API_TOKEN` (clears only the manifest cache).

The Windows outputs (`.exe`, `.exe.blockmap`, `latest.yml`) must be produced on a Windows machine and
copied into the same `release/` folder; the manifest script looks at a single folder.

## Caveats

- `updates.codezal.com/latest.json` now serves the new pipeline (1.0.0, `downloads` schema); the
  update check of old Tauri 0.5.x clients stops working after this schema change. The last legacy
  builds are archived on the server under `/var/codezal-updates-archive/0.5.8/`.
- `latest-mac.yml` uses the **zip**, not the DMG; the zip and blockmap files must be uploaded too,
  otherwise the in-app update cannot download.
- Different content is never uploaded under an already-published name: it does not match the blockmap
  and sha512, and update verification breaks. If a fix is needed, a patch release is made.
