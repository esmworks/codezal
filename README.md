# Codezal

A desktop AI coding agent that runs on your machine. Pick a project folder, describe the task, and
the agent explores the project, edits files, runs commands, and shows every step as a card. Two
modes: **Coding** (autonomous development in real repositories) and **Assistant** (non-code work
and scheduled tasks). The interface is available in Turkish and English.

The agent engine is [Pi](https://github.com/earendil-works/pi-coding-agent); the shell is Electron.
All work happens locally. API keys never reach the renderer and are stored on disk with `0600`
permissions. Instead of a raw key you can enter a `!command` (e.g. macOS Keychain) or a `$ENV_VAR`
reference.

## Getting started

Requirements: Node 22.19+, pnpm 12 (`corepack enable`).

```bash
pnpm install
pnpm dev
```

On first launch, connect a provider under Settings > Connection (an API key, or device-code sign-in
for ChatGPT / Copilot), then pick a project folder and describe your task.

## Commands

| Command | Purpose |
|---|---|
| `pnpm dev` | Electron + Vite development |
| `pnpm check` | TypeScript type check (all packages) |
| `pnpm lint` | Biome (2 spaces, 100 columns, double quotes) |
| `pnpm test` | Vitest unit and contract tests (offline) |
| `pnpm test:e2e` | Playwright end-to-end tests against the built app |
| `pnpm --filter @codezal/desktop package` | macOS `.app` (unsigned, in `release/`) |
| `pnpm --filter @codezal/desktop package:inspect` | asar size and content check |

## Layout

```
apps/desktop/          Electron app (main, preload, renderer)
packages/contracts/    Zod schemas and the IPC contract (single source of truth)
packages/agent/        Pi wrapper: sessions, permission gate, catalog, memory, web tool
packages/i18n/         dictionaries (tr/en) and type-safe t()
packages/ui/           design tokens
docs/ARCHITECTURE.md   process model, IPC, event bus
```

Contribution rules are in [`AGENTS.md`](AGENTS.md) and [`CONTRIBUTING.md`](CONTRIBUTING.md); release
notes are in [`CHANGELOG.md`](CHANGELOG.md).

## Data

Everything lives under `~/Library/Application Support/Codezal/`: `pi/` (credentials and models;
`keys.json` and `mcp.json` are stored with `0600` permissions; the pool's active key is mirrored to
`pi/auth.json` for Pi child processes, and `PI_CODING_AGENT_DIR` points at the Codezal store),
`sessions/` (JSONL sessions), `memory/` (file-based memory), `logs/codezal.log` (keys masked) and
`settings.json`. Assistant outputs go to `~/Documents/Codezal Asistan/<project>/Çıktılar`, context
copies to `Bağlam/` in the same project folder (a sibling of the code repository, so outputs never
mix with the repository root).

## Distribution

`electron-builder.yml` defines macOS dmg/zip, Windows NSIS and Linux AppImage targets. The `macos`
job imports the `.p12` into a temporary keychain it creates itself (`CSC_LINK` is not set);
notarization needs `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID`. Auto-update runs
through `updates.codezal.com` (`electron-updater`, generic provider) and only in signed builds;
details are in [`docs/RELEASE.md`](docs/RELEASE.md).

### OAuth client for Google services

Google does not offer dynamic client registration, so for the Google cards under
Settings > Connectors to work in one click, the publisher's client is embedded at build time. Copy
`.env.example` to `.env` and fill in the values (`.env` is git-ignored; do not put keys in your
shell history):

```
CODEZAL_GOOGLE_CLIENT_ID=...
CODEZAL_GOOGLE_CLIENT_SECRET=...
```

Create the client in Google Cloud as a **"Desktop app"**: Google does not treat the secret of this
client type as confidential (RFC 8252) and accepts any `127.0.0.1` port, so sign-in still works when
47821 is taken. Also enable the product APIs (Gmail, Drive, Calendar, Docs, Sheets, Slides) and
their MCP counterparts (`gmailmcp`, `drivemcp`, `calendarmcp`, `docsmcp`, `sheetsmcp`,
`slidesmcp`). If the variables are left empty, the app asks users for their own client.

The embedded credentials can be read from the package; this is expected for desktop apps and PKCE
provides the protection. Still, use the Google Cloud project for Codezal only and set up quota
alerts.

## Contributing

Issues and pull requests are welcome. Read [`CONTRIBUTING.md`](CONTRIBUTING.md) first. To report a
security issue, follow [`SECURITY.md`](SECURITY.md) instead of opening a public issue.

## License

Codezal is licensed under the [Apache License 2.0](LICENSE). See [`NOTICE`](NOTICE) for third-party
components and acknowledgements.

The name "Codezal" and the Codezal logo are trademarks of Esmworks and are not covered by the
license. If you distribute a fork, please use a different name and logo.
