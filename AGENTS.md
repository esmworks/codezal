# Codezal — Contribution Rules

This repository contains the Codezal desktop app. Architecture is in `docs/ARCHITECTURE.md`,
releasing is in `docs/RELEASE.md`, release notes are in `CHANGELOG.md`, and the contributor guide
is `CONTRIBUTING.md`.

## Language

- Documentation (all Markdown files) is in English.
- UI strings live in `packages/i18n`, in both Turkish (`tr.ts`) and English (`en.ts`).
- Code identifiers (variables, functions, types, file names) are in English.
- Comments are short and explain *why*. Existing comments are in Turkish; keep the surrounding
  file's language when editing.
- Commit messages follow the `type(scope): summary` style used in the history.

## Structure

- pnpm monorepo. `apps/desktop` is the Electron app; `packages/*` are libraries consumed as source
  (no build step).
- `packages/contracts` is the single source of truth: to add an IPC channel, add its schema to
  `ipcContract` first, then register it in main with `handle()`.
- `apps/desktop/resources/audit/` is a vendored copy of Cloudflare's `security-audit-skill`: never
  edit it by hand; it is excluded from Biome lint. Update steps are in the folder's `README.md`.
- The Pi SDK is imported only inside `packages/agent`. The main process talks to it through
  `CodezalEngine`; the renderer does not know about Pi.
- Pi events are published to `AgentEventBus`; to add a new consumer, subscribe instead of changing
  the engine.

## Rules

- Work is not done until `pnpm check`, `pnpm lint` and `pnpm test` are clean.
- Biome formatting: 2 spaces, 100 columns, double quotes.
- `any` and `!` (non-null assertion) are forbidden.
- Never send credentials to the renderer; only `connected: boolean` goes there.
- Version pinning: every dependency uses an exact version (no `^`). The Pi family is upgraded as a
  single version.
- When adding a native module (node-pty etc.), add it to the `allowBuilds` map in
  `pnpm-workspace.yaml`.
- Electron 44+ has no postinstall in its package; the binary is downloaded by
  `scripts/ensure-electron.mjs` (root `postinstall`). If `pnpm dev` says "Electron uninstall",
  `pnpm install` is enough.
- In development the Dock name/icon come from the `node_modules/electron` package; `app.setName()`
  is not enough. `scripts/brand-dev-electron.mjs` (root `postinstall`) updates the Info.plist names
  and `electron.icns`, creates a symlink to the binary named `Codezal Dev` and points `path.txt` at
  it ("Codezal Dev" and a "DEV" badge in the Dock, so it is not confused with the release build;
  the data root is still `Codezal`). Do not rename the binary: `app.isPackaged` looks at the file
  name, and the development build would be treated as packaged. Re-run it when brand assets change.
- pnpm 11+ does not read settings from `.npmrc`; `nodeLinker`, `allowBuilds` etc. live in
  `pnpm-workspace.yaml`.
- The user extension surface has been **removed**: Codezal loads only the in-engine extension
  factories (`codezal-hooks`, `codezal-permissions`, `codezal-plan`, `codezal-agents`,
  `codezal-images`, `codezal-advisor`, `codezal-mcp`, `codezal-outputs`, `codezal-turn`,
  `codezal-goal`; `packages/agent/src/engine.ts`) — `noExtensions: true` plus empty
  `additionalExtensionPaths`. The extension install/enable path, the discovery folders
  (`pi/extensions`, `.codezal/extensions`), `plugins.json`, the Extensions page and the `plugins:*`
  IPC channels are gone; Pi's `.pi/extensions` auto-discovery was never used. Sub-agents (explore,
  audit) do not load extensions either. `codezal-hooks` is not an extension loader: it runs the
  user's PreToolUse/PostToolUse shell commands (`userData/hooks.json`, and `hooks` in
  `.codezal/ayarlar*.json` for trusted projects); it is registered in the main session and in
  `agent` sub-agents. The `ctx.ui` bridge for in-engine extensions is
  `packages/agent/src/extension-ui.ts`; the card in the chat is `session/ExtensionUiCard.tsx`.
- The single source of credentials is the `keys.json` pool; the active slot is mirrored to
  `auth.json` for Pi and child processes (`CredentialPool.#syncAuth`), and the main process points
  `PI_CODING_AGENT_DIR` at the Codezal store — nothing is written to `~/.pi/agent`.

## Commands

```bash
pnpm install
pnpm dev        # Electron + Vite development
pnpm check      # tsc
pnpm lint       # biome
pnpm test       # vitest
pnpm build      # electron-vite build
```
