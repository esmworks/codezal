# Contributing to Codezal

Thanks for your interest in improving Codezal. This guide covers how to set up the project, what
we expect from a pull request, and the rules the codebase follows. The full set of architectural
rules lives in [`AGENTS.md`](AGENTS.md) and [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Before you start

- For bugs, open an issue with steps to reproduce, the expected and actual behavior, your OS and the
  Codezal version (Settings > Account).
- For larger changes (new features, new IPC channels, new dependencies), open an issue first so the
  approach can be agreed on before you write the code.
- Security issues: do **not** open a public issue. Follow [`SECURITY.md`](SECURITY.md).

## Development setup

Requirements: Node 22.19+, pnpm 12 (`corepack enable`).

```bash
pnpm install
pnpm dev
```

If `pnpm dev` reports "Electron uninstall", run `pnpm install` again: the Electron binary is
downloaded by the root `postinstall` script.

## Pull request checklist

A pull request is ready for review when:

- `pnpm check`, `pnpm lint` and `pnpm test` all pass.
- New behavior has tests; bug fixes come with a test that fails without the fix.
- User-facing strings are added to both `packages/i18n/src/tr.ts` and `packages/i18n/src/en.ts`.
- `CHANGELOG.md` has an entry under `## [Unreleased]` for user-visible changes.
- The change is focused: one topic per pull request.

## Code rules

- Formatting is Biome: 2 spaces, 100 columns, double quotes. Run `pnpm lint:fix` before committing.
- `any` and the non-null assertion operator (`!`) are not allowed.
- Code identifiers (variables, functions, types, file names) are in English.
- Comments explain *why*, briefly. Existing comments are in Turkish; new comments may be in Turkish
  or English.
- `packages/contracts` is the single source of truth: to add an IPC channel, add its schema to
  `ipcContract` first, then register it in main with `handle()`.
- The Pi SDK is imported only inside `packages/agent`. The renderer never talks to Pi directly.
- Never send credentials to the renderer; only a `connected: boolean` crosses that boundary.
- Dependencies are pinned to exact versions (no `^`). Ask in an issue before adding a new one.
- `apps/desktop/resources/audit/` is vendored third-party code; do not edit it by hand.

## Developer Certificate of Origin

Codezal uses the [Developer Certificate of Origin](https://developercertificate.org/) (DCO). By
contributing you certify that you wrote the change or otherwise have the right to submit it under
the project's license. Sign off every commit:

```bash
git commit -s -m "fix(session): ..."
```

This adds a `Signed-off-by: Your Name <you@example.com>` line to the commit message.

## License

By contributing, you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE).
