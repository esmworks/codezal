# Architecture

## Processes

```
┌──────────────────────────── Electron ────────────────────────────┐
│                                                                  │
│  MAIN (Node, ESM)                    RENDERER (Chromium, sandbox)│
│  ┌──────────────────────┐            ┌────────────────────────┐  │
│  │ CodezalEngine        │            │ React 19 + Zustand     │  │
│  │  ├ ModelRuntime (Pi) │  agent:    │  ├ app store           │  │
│  │  ├ AgentSession[]    │  event ──▶ │  ├ sessions store      │  │
│  │  ├ AgentEventBus     │            │  ├ models store        │  │
│  │  │   ├ IPC bridge    │  invoke    │  └ screens             │  │
│  │  │   ├ Permissions   │  ◀──────── │                        │  │
│  │  │   └ Usage counter │            └────────────────────────┘  │
│  │  └ SessionManager    │                     ▲                  │
│  └──────────────────────┘                     │ contextBridge    │
│            ▲                          ┌───────┴────────┐         │
│            │ ipcMain.handle           │ PRELOAD (CJS)  │         │
│            └──────────────────────────│ window.codezal │         │
│                                       └────────────────┘         │
└──────────────────────────────────────────────────────────────────┘
```

- **Main**: Hosts the Pi SDK. `apps/desktop/src/main`. ESM (`out/main/index.mjs`).
- **Preload**: `window.codezal = { invoke, on }`. Bundled to CJS because the sandbox is on
  (`out/preload/index.cjs`).
- **Renderer**: `apps/desktop/src/renderer`. No Node access. It reaches the bridge only through
  `src/api.ts`.

## Packages

| Package | Responsibility |
|---|---|
| `@codezal/contracts` | Zod schemas: domain model, transcript, agent events, `ipcContract`, the `CodezalBridge` type |
| `@codezal/agent` | `CodezalEngine`, `AgentEventBus`, Pi wrappers, the permission gate |
| `@codezal/ui` | `tokens.css` (24 design variables + Tailwind `@theme`), theme helpers |
| `@codezal/desktop` | The Electron app |

Packages are not built; `exports` points straight at `src/*.ts` and electron-vite includes them in
the bundle (`externalizeDepsPlugin({ exclude })`).

## IPC contract

Channels are defined in `packages/contracts/src/ipc.ts`:

```ts
"sessions:prompt": { req: z.object({ id, text }), res: z.void() }
```

On the main side, `handle("sessions:prompt", async ({ id, text }) => …)`:

1. The request is validated against the `req` schema.
2. The handler runs.
3. The response is validated against the `res` schema.
4. Error messages are scrubbed with `maskSecrets`.

Main → renderer events flow over a single channel: `agent:event`, whose payload is the `AgentEvent`
union.

## Event flow

```
Pi AgentSessionEvent ─▶ engine.mapEvent() ─▶ AgentEventBus.emit()
                                                 ├─▶ webContents.send("agent:event")
                                                 ├─▶ PermissionManager (holds permission_request)
                                                 ├─▶ PlanReviewGate (holds plan_review)
                                                 ├─▶ QuestionGate (holds question_request)
                                                 └─▶ UsageCounter

Sub-session (SubagentTracker) ─▶ subagents / subagent_trace ─▶ AgentEventBus.emit()
```

## Main modules (`apps/desktop/src/main`)

| Module | Responsibility |
|---|---|
| `index.ts` | App lifecycle: logging, hardening, engine and stores, bus subscribers, registering the IPC modules, scheduler, updater |
| `context.ts` | `AppContext` (paths, engine, projects, stores, terminals, settings) and dialog helpers |
| `ipc.ts` | `handle()` (Zod validation + secret masking + logging) and `broadcast()` |
| `ipc/app.ts` | `app:*` (version, paths, log, update) and `window:*` |
| `ipc/models.ts` | Catalog, API key, OAuth / device-code flow |
| `ipc/sessions.ts` | Projects (pick, forget, open in terminal), sessions (including fork), permission/plan/question replies |
| `ipc/workspace.ts` | Terminal, files, git, worktree, pre-commit checks |
| `ipc/settings.ts` | Settings, usage, file-picker dialogs, data export, notifications |
| `ipc/assistant.ts` | Scheduled tasks, assistant projects, context copy/removal, memory |
| `ipc/audit.ts` | Security audit: `audit:state/start/export/reveal`; PDF export goes through `renderPdf` |
| `audit-assets.ts` | Root of the audit skill bundle (packaged: `extraResources/audit`, development: `resources/audit`) |
| `assistant.ts` | Running scheduled tasks, preparing the project folder, assistant system-prompt additions (context line), legacy memory migration |
| `context-copy.ts` | Context copy: size measurement (`measure`), target-name collisions (`rapor (2).pdf`), copying with `fs.cp`, trash on removal (`shell.trashItem`) |
| `pdf.ts` | `renderPdf`: writes the HTML to a temp file, loads it in a hidden window and returns the PDF bytes via Chromium `printToPDF` (the bridge for the `pdf_create` tool; JS disabled, `<base href>` is the PDF folder) |
| `log.ts` | `FileLogger`: `userData/logs/codezal.log`, 5 MB rotation, key masking |
| `security.ts` | `will-attach-webview` (preload/Node are not inherited), permission requests denied, `will-navigate` guard; `setWindowOpenHandler` is set up in one place and hands the link to `links.ts` |
| `updater.ts` | `electron-updater`: periodic check in packaged builds, `update:status` event; download is automatic or manual depending on the setting |
| `shell.ts` | Detecting the user's shell and opening a folder in the system terminal |
| `open-with.ts` | "Open in…": detecting installed editors/terminals (macOS `.app`, known paths on Windows, PATH on Linux), a per-app icon (on macOS the bundle's `.icns` PNG entry, elsewhere `app.getFileIcon`) with a cache, and opening the folder in the chosen app (`execFile`; no shell is spawned, identity and command stay in main) |
| `terminals.ts` | `TerminalManager`: shell via node-pty, `terminal:data` / `terminal:exit` events |
| `files.ts` | File tree (git badges, `modifiedAt`), reading (512 KB limit, binary detection), search, creation |
| `local-files.ts` | `codezal-file://local/<yol>` scheme: serves PDFs and images so the renderer can show them with `<iframe>`/`<img>`; previewable types only (the CSP `frame-src`/`img-src` is open to them) |
| `git.ts` | simple-git: status and +/- counts, branches, commit/push, diff, heuristic commit message, worktrees |
| `checks.ts` | Pre-commit lint/test/build commands; stops at the first failure |
| `store.ts`, `stores.ts` | `JsonStore` (a JSON file with a Zod schema) and the app stores: settings, usage (by day and cost; summary/heatmap/trend calculations live in the renderer's `lib/usageStats.ts`), schedule, assistant |
| `scheduler.ts` | `nextRun()` calculation and running due tasks on a once-a-minute `tick()` |
| `menu.ts`, `window.ts` | App menu (`SHORTCUTS` is the single source) and window (webview enabled). Window controls are drawn by the system: traffic lights on macOS, `titleBarOverlay` on Windows/Linux; the overlay color follows the theme |
| `system.ts` | OS integration: menu-bar icon (`Tray`, template glyph on macOS) and launch at login (`setLoginItemSettings`, packaged builds only), sleep blocker while an agent turn runs (`powerSaveBlocker`) |
| `links.ts` | Where a link in the chat goes: the embedded browser (`link:open`) or the system browser, depending on the setting; localhost / `127.*` / `.local` follow a separate rule |
| `archive.ts` | `expiredSessions()`: ids of sessions that are unpinned, not running and whose last change is older than the given number of days (the hourly scan lives in `index.ts`) |

Main → renderer event channels: `agent:event`, `terminal:data`, `terminal:exit`, `git:changed`,
`oauth:progress`, `schedule:ran`, `sessions:changed`, `memory:changed`, `audit:changed`,
`update:status`, `link:open`, `app:log`. All of them are defined in `packages/contracts/src/ipc.ts`.

`sessions:changed` is for changes the UI did not ask for (the auto-archive scan); user actions
update the list optimistically, and the event is emitted only for background work.

## Error surface

- Main: `process.on("uncaughtException" | "unhandledRejection")`, `render-process-gone`,
  `child-process-gone` and every IPC error are written to the log; the process does not crash.
- Renderer: `ErrorBoundary` shows a reload screen on a render error; `unhandledrejection` and
  `error` events become a toast at the bottom right (with a "Logs" link) and go to the log via
  `app:logError`. This is why the `void invoke(...)` pattern is safe: errors are not lost silently.
- Log: `userData/logs/codezal.log`, lines are scrubbed with `maskSecrets`, a `.1` backup at 5 MB.

## Diagnostics

Observability has three layers: a file log, a per-session event trace and UI panels. None of them
needs separate server-side measurement; durations are derived from the events' `at` field.

- **Log** (`main/log.ts`): `logs/codezal.log` (info/warn/error) and, when verbose logging is on,
  `logs/codezal-debug.log` (debug lines go to a separate file so the main log does not bloat; both
  keep a `.1` backup at 5 MB). The last 500 lines are held in memory in a ring buffer.
- **Event trace** (`main/agent-trace.ts`): an `AgentEventBus` subscriber appends every event to
  `userData/agent-events/<oturum>.ndjson` (lines pass through `maskSecrets`). Rotates at 5 MB per
  session, files older than 7 days are deleted at startup; deleting a session deletes its trace. The
  point is to be able to reconstruct the event order from a bug report afterwards (the persistent
  log holds human-readable lines and does not carry the event itself).
- **Settings > Diagnostics** (`settings/pages/DiagnosticsPage.tsx`): the last lines via
  `app:logTail`, the live `app:log` stream while `app:logWatch` is on (nothing is emitted when there
  is no watcher), a level filter, search, "Copy diagnostics" (version + paths + active session trace
  summary + last log lines), and the `verboseLog` and `agentTraceLog` toggles.
- **Session trace panel** (`session/TracePanel.tsx`, the session "···" menu): records are derived
  from the event stream by a pure function in `lib/trace.ts` — per-request TTFT (from the request
  boundary to the first token), step duration, `tok/s`, token breakdown, tool durations, turn
  totals. Delta events do not produce records; at most 400 records are kept per session.

## Renderer layout (`apps/desktop/src/renderer/src`)

- `stores/`: Zustand stores. `reduce.ts` is the pure event reducer (`reduceEvent`); `sessions.ts`
  wires it to IPC.
- `screens/`: `KodlamaHome`, `SessionScreen`, `asistan/*`.
- `panel/`: right-panel tabs (Browser, Files, Changes, Findings, Agents) and a separate tab for each
  terminal (`terminal:<anahtar>`, `panel/TerminalTab.tsx`); the tab strip and the lifetime of the
  shells are managed by `stores/panel.ts` plus a module-level session map. `modals/`: the Commit
  window and (for the design screen that has no panel surface) the Changes window.
- `settings/`: the settings overlay; pages are `settings/pages/*.tsx`, shared types in
  `pages/common.ts`. `shell/`: sidebar, title bar, search palette.
- `lib/`: pure helpers (`format.ts`, `progress.ts`, `skills.ts`, `trace.ts`, `diff.ts`,
  `searchText.ts`, `promptHistory.ts`, `toolCardOpen.ts`); tests sit next to them.
- **Search folding** (`lib/searchText.ts`): `foldForSearch` splits off and discards accents and maps
  the dotless `ı` to `i`, then lowercases independently of locale. `toLocaleLowerCase("tr")` alone
  was not enough: because of the `I → ı` conversion, a session titled `IPC` could not be found by
  searching `ipc`. The sidebar search, the model picker and the `/` panel use the same helper. The
  helper lives in `packages/contracts/src/search.ts` (the renderer module re-exports it): the
  content search in main uses the same rule. `foldWithMap` keeps the original position of every unit
  of the folded text; the snippet and the highlight range map back to the original text through it.
- **⌘K content search** (`sessions:search`, `packages/agent/src/session-search.ts`): the renderer
  sends session ids, and the path is resolved from main's registry. The Pi JSONL file is read as a
  stream and only user/assistant text is indexed (tool output, images and thinking are left out);
  rewound branches are skipped. The index sits in a per-file LRU cache and is refreshed when size or
  time changes. A hit carries the message as `role` + `at`; on selection the palette hands off to
  in-chat find.
- **In-chat find** (⌘F, `lib/transcriptFind.ts`, `lib/findHighlight.ts`, `session/FindBar.tsx`):
  since the virtual window does not put off-screen turns into the DOM, matches are counted from the
  data model; the highlight is painted on rendered rows with the CSS Custom Highlight API (no
  markers are added to the DOM). If the current match is not rendered, the view first goes to the
  row using the height model, and once the row is rendered the range is centered; a folded work
  sequence is opened with `reveal`.
- **Transcript rendering**: every structure derived from a turn (grouping, turn ends, the per-turn
  tool list, sequence durations) is computed in a single `useMemo`, and the row components
  (`UserBubble`, `AssistantBlock`) are `memo`ized. Before this, even the duration counter that ticks
  once a second while a turn runs regrouped the whole list and redrew every row. This depends on the
  call sites being stabilized with `useCallback` (`SessionScreen`).
- **Turn window in long sessions** (`lib/virtualWindow.ts`): above 150 turns, turns that are not
  visible are not drawn and their places are held with spacers. The spacer **preserves the total
  height**; this is required because the chat's scroll anchor (`lib/scrollAnchor.ts`) relies on
  geometry. The window is written to state only when its bounds change (scroll frames do not trigger
  a render), and measured turn heights sit in an LRU cache. For chats below the threshold the code
  path is the same as before.
- **Context compaction**: automatic (threshold `AUTO_COMPACT_PERCENT`, circuit breakers
  `MAX_COMPACT_FAILURES` / `MAX_RAPID_REFILLS`) and manual (`/compact`, which goes through the
  command gate below).
- **Error reason** (`packages/agent/src/provider-error.ts`): `classifyProviderError` reduces a
  provider error to one of 10 fixed codes; the code goes into the error event, the event trace and
  the Diagnostics bundle's counts. The text goes to the user, the code goes to measurement.
- **Test ids** (`packages/contracts/src/test-ids.ts`): e2e tests that measure layout use
  `data-testid` instead of binding to class or DOM order; behavior tests stay on role/text
  selectors.
- **Design rules** (`docs/DESIGN.md`): the type scale and the radius ladder are enforced by machine
  through `designScale.test.ts` — an out-of-scale value or a raw color with no name is caught at the
  gate.
- **Fonts**: the interface uses SF Pro (`--font-sans`, `--font-mono`); code surfaces (diff, file
  preview, command output, `CodeView`) use the real monospace `--font-code` — aligned columns and
  shiki token colors only read well that way (ZCode makes the same distinction).
- `stores/toast.ts` + `components/Toasts.tsx`: short-lived notifications; `humanizeError` drops the
  channel prefix.
- `shell/Welcome.tsx`: a one-time welcome while no provider is connected (localStorage
  `codezal.welcome`).

### Commands (`/…`)

Local commands work like ZCode's built-in commands: **they do not go to the model**, they run in the
UI and their result appears in the chat as a **marker line**. Four parts:

- **Catalog** (`lib/slashCommands.ts`): the naming rule is the same as in ZCode — the list shows the
  canonical ASCII name in every language (`/help`, `/effort`, `/mode`), and the description comes
  from the UI language. Customary Turkish spellings are aliases in the dictionary
  (`commands.name.help` → `yardım`): the resolver recognizes them too and they enter the `/` panel
  search, but they are not drawn separately in the list. Folding is tried with both ASCII and
  Turkish lowercasing (`/YARDIM`, `/INIT`). Argument values can be written by id (`plan`), by
  ZCode's name (`yolo`) or by the name shown in the UI (`Full access`).
- **Execution** (`session/commands.ts`): `runSlashCommand` is the single gate; it does not import
  the store and takes session actions through `CommandPorts` (so no circular import arises).
  Shortcut commands (`/plan`, `/ask`, `/debug`, `/audit`, `/init`) do not live here:
  `lib/promptText.ts` expands the text into a labeled instruction block
  (`<codezal-command name="plan">…</codezal-command>`) and it goes to the model; `@dosya` mentions
  stay in the text (a path with spaces is quoted as `@"/a/b c.ts"`), and the read list is appended
  at the end in a `<codezal-files>` block without duplicates. No list is added to a local command's
  argument: the argument is the entire rest of the text. An invalid argument throws — the send is
  rejected and the Composer restores the draft.
- **Gates**: inside a session `sessions.prompt`, on the entry screens `sessions.runCommand`
  (**before** the provider check, otherwise `/help` would fail with "no provider connected"), and a
  last safety net inside `sessions.create`. If a command runs, none of them sends a prompt to the
  model; in that case `create` returns `null` and no session is opened.
- **Display**: opens the `/help` command screen (`session/CommandsScreen.tsx`), the `/model` `/mode`
  `/effort` pickers (anchored to the composer box), and the `/skill` and `/mcp` settings pages.
  Commands that change state leave a **marker line** in the chat: `MarkerItem` (`kind`, `from`,
  `to`, `outcome`) is both emitted with `agent:event` and written to `sessions/meta.json`; when a
  session is reopened, `#withMarks` merges the markers into the transcript in **time order** (on a
  tie the transcript order is kept). Translated text is not embedded in the record: the record
  carries only ids, and the UI builds the display name in `session/markers.ts` from the catalog and
  the dictionary.

### Composer draft

The Composer content does not live bound to the DOM: `session/composerParts.ts` is the single source
of truth (`text` + `pastes` + `images`). A long paste (3+ lines or 150+ characters) enters the
visible text as a `[Pasted ~N lines]` placeholder; the real content stays in `pastes` and is put
back in place with `expandDraft` on send. `stores/drafts.ts` keeps the draft under the session id
(under a `home:*` key on the entry screens); moving back and forth between sessions loses neither
the text nor the images. Sending is optimistic: `Composer` empties the box right away, and if
`onSend` rejects, the same draft is restored and the error is toasted; incrementing `hydrateKey`
refreshes after a rewind/restore.

### Input box and the `/` panel

`session/Composer.tsx` is a Lexical plain-text editor (like ZCode's chat input). The draft model has
not changed: `session/editor/draftText.ts` converts the editor to draft text (`$draftText`) and
writes it back (`$writeDraft`). A command, skill, file mention and long paste are `TokenNode`
(`editor/tokenNode.ts`) tags: a `TextNode` in "token" mode; the screen shows a short name (`Plan`,
`a.ts`) while the draft holds the value (`/plan`, `@/yol/a.ts`, the placeholder), and a single
Backspace deletes it. The icon is drawn with a `::before` mask (`.cz-token`); adding an element to
the DOM breaks Lexical's selection mapping. Programmatic writes (loading a draft, history ↑/↓,
clearing on send) carry `QUIET_TAG`: the panel does not open and the history cursor is not reset.
Copy/cut writes the tag's value.

`editor/SlashPlugin.tsx` manages the panel: the query is read from the editor, and only a `/sorgu`
token **at the start of the message** opens the panel (commands and Pi skills only work at the
start). Rows are scored by `lib/slashSearch.ts` (prefix > substring > letter order; name >
description > keyword, ZCode's `promptInputTriggers` logic, Apache-2.0) and split into sections
(Commands, Skills); the default selection is the best match across the whole list. Keys are handled
in the panel with `COMMAND_PRIORITY_CRITICAL`: Enter/Tab selects, Esc closes and does not reopen
until the same token changes, and with no match Enter passes to the composer and sends. Local action
commands run on selection and are deleted from the box; the others leave a tag. The panel is not a
separate card but the upper extension of the input box (`.cz-composer` / `.cz-slash`, `styles.css`):
when it opens the box grows upward and when it closes it shrinks back. The height animates
`0 → auto` with `interpolate-size`; the `0fr → 1fr` trick left a gap at intermediate values in an
absolutely positioned container. The selected row is scrolled only within the list (`scrollIntoView`
also scrolled ancestor boxes). The `+` button (`session/ComposerPalette.tsx`) only adds context:
file, folder, image, services.

The bubble (`session/PromptText.tsx`) rebuilds the text sent to the model with `collapsePrompt`: the
instruction block becomes `/plan`, the Pi `<skill …>` block becomes `/skill:ad`, and the read list
is dropped; older untagged records are recognized from the instruction text in the dictionary. Copy,
rewind and the turn bar use the same text; the session title too (`deriveSessionTitle` →
`collapsePromptMarkup`, `packages/contracts/src/text.ts`) is derived from the request that was typed
rather than from the instruction.

## Changes surface

The working tree list is drawn in one place: `panel/ChangesView.tsx` (branch, totals, file rows,
inline diff, per-file undo). It is called from two places:

- **The Changes tab in the right panel** (`panel/ChangesTab.tsx`): the user path. ⌘G, the menu in
  the session header and the "Changes" row in the "Environment" box open this tab through
  `lib/revealChanges`; if the panel is closed it opens. The "Commit" button goes to the commit
  window (which stays a form).
- **The Changes window** (`modals/ChangesModal.tsx`): only for the design screen that has no right
  panel; it shows the same body.

Diff drawing is shared with the chat cards: `DiffLines` in `session/ToolCard.tsx` draws both tool
output (`N|satır`) and a raw patch (`diff --git … @@`). A raw patch is parsed by `lib/diff.ts` —
line numbers from both sides, the add/remove padding and its rail, character-level highlighting of
the changed part on paired lines (`highlightPair`), and an "N unmodified lines" separator for the
unchanged blocks in between (`foldHunks`). ZCode draws this view with a separate diff library; no
dependency was added here, and only as much parsing as needed is done (tests in `lib/diff.test.ts`).

The "N files changed" card in the chat (`session/TurnFiles.tsx`) is the turn's own file list and
opens the diff in place with an inline "Review"; the old "This session" box in the right rail was
removed for that reason.

### Turn undo ("Undo")

Two sources work together (`main/ipc/sessions.ts` → `sessions:undoFiles`):

- **Git turn record** (`main/turn-backup.ts`): in a git repository `git stash create` runs at the
  turn start and the changed files are sealed at the turn end; this is tried first.
- **The engine's file backup** (`packages/agent/src/snapshots.ts`, keyed by session + user message
  index): the state of the file before `edit`/`write`; for `bash`, a before/after directory-index
  diff around the command (`bash-snapshot.ts`: a file tracked cleanly in git comes from the index
  blob, the others from the pre-command copy; if the file/time/byte limit is exceeded the turn
  backup is marked "incomplete" and newly created files are not recorded for deletion). Sub-agents
  working in the same folder (a held `agent` run and a detached run without a worktree) write to the
  turn in which the main session opened the run; a worktree run is out of scope. If the git record
  did the job, the engine backup is applied only to paths git did not touch.

The `bash`/`agent` result gets the changed files added as `details.changedFiles`; they enter the
turn file list (`lib/turnFiles.ts`) through
`ToolCallItem.
changedFiles`.

## Images

User images come from the renderer with `sessions:prompt` as
`ImageAttachment {mimeType, data(base64), name?}`. `packages/agent/src/images.ts` converts them to
Pi `ImageContent` and shrinks them with `resizeImage` to a 2000×2000 px / **700 KB base64** limit;
they are sent with `session.prompt(text, { images })`. Pi stores images as base64 in the message
content of the session JSONL file; `mapping.ts` moves the `image` blocks back onto the user item
when a session is opened. Model support is declared by `CatalogModel.vision` (an "image" entry in Pi
`model.input`). By Pi's rule, session files are written to disk at the first assistant reply; a
session that contains only a user message is not persisted.

### Request body budget

Provider gateways cap the request body: on OpenCode Go the measured limit is exactly 6 MiB
(6,291,456 bytes pass, 6,292,000 bytes do not) and when it is exceeded the response is an
unexplained 400 — the body contains only `{"model":"…"}`. Because all images in a session are resent
on every turn, this limit is easy to exceed and the session gets locked permanently: sending a new
message does not help either, since the error comes from the accumulated input. There are three
defenses:

- `images.ts`: a 700 KB base64 budget per image. Pi's shrinker produces candidates in the order PNG,
  JPEG(q80)… and picks the first one that fits the budget, so this threshold drops screenshots to
  JPEG (measured: 1.37 MB PNG → 386 KB JPEG, 3.7×).
- `image-budget.ts`: a session-wide `SESSION_IMAGE_BUDGET_BYTES` (4 MiB). On every turn `prompt()`
  uses `trimImageHistory` to turn the oldest images into a text placeholder; only the in-memory
  messages change, the record in the session file stays.
- `provider-error.ts`: `explainProviderError` recognizes this unexplained 400 and turns it into the
  `errors.requestTooLarge` text; `mapping.ts` and the engine's error emission pass through it.

### Context management (two tiers)

Every tool result in a session is resent on every later turn; in a long session this fills the
window and loses the turn. There are two tiers, and **the cheap one runs first**:

- **Cheap tier** (`microcompact.ts`, the `context` hook): the text bodies of old tool results are
  turned into a placeholder in the copy sent to the model. The newest `KEEP_RECENT_TOOL_RESULTS` (5)
  results are kept; results with images are left alone (an image has its own budget). The conversion
  happens only in Pi's copy: the session file, the UI and rewind see the full output. If the savings
  are below `MIN_SAVINGS_CHARS`, the history is not changed at all.
- **Expensive tier** (`engine.ts` `#autoCompact`, threshold `AUTO_COMPACT_PERCENT`): when the user
  sends a new message and fullness is above 85%, a summary is produced before the turn starts.
  Previously compaction ran only **after** an overflow error was received (reactive): the turn
  failed, the user waited and one request was wasted. No compaction is done while a stream is
  running (so the model's context is not pulled out from under it); the reactive path stays as a
  fallback.

### Tool result budget

`tool-budget.ts`: tool text sent to the model is capped at `MAX_TOOL_RESULT_CHARS` (40 thousand) and
the truncation is announced with a **machine-readable** marker (original length + strategy). Pi's
built-in tools truncate their own output and write the full version to a temp file; Codezal's tools
— remote MCP connectors in particular — carried no such limit and could return megabytes in a single
call. The truncation is not silent: the model knows the view it holds is partial and, if needed,
calls again with a narrower query.

## Brand and icons

- The app icon is `apps/desktop/build/icon.{icns,ico,png}` (a red squircle "C"); the packager uses
  it, and `icon.png` is carried via `extraResources` as the notification and Linux/Windows window
  icon.
- The renderer's brand assets are in `src/renderer/public/brand/` (squircle and light/dark glyph,
  256 px).
- File type icons are the VS Code Material Icon Theme (PKief, MIT) SVGs under
  `src/renderer/public/file-icons/`; the mapping is static in `src/lib/file-icons.manifest.json`. To
  regenerate, only the file icons are taken from the `material-icon-theme` package's
  `generateManifest()` output: the manifest keeps `fileNames`, `fileExtensions` and `file`, and the
  SVGs they point to are copied. The folder keys (`folderNames`, `folderNamesExpanded`, `folder`,
  `folderExpanded`, `rootFolder*`) and the `folder*` SVGs are not taken: the file tree draws a
  folder with only an expand arrow.

## Packaging

`pnpm --filter @codezal/desktop package` → `electron-vite build` + `electron-builder --mac --dir`.
For an unsigned/non-notarized DMG use `package:mac:unsigned` (`--arm64` can be added). Fuses modify
the Electron Framework binary; in an unsigned build, if `electronFuses.resetAdHocDarwinSignature`
does not re-sign the app ad hoc, Apple Silicon kills it at launch with `Code Signature Invalid`. The
`files:` list in `electron-builder.yml` contains only negative patterns, so node_modules (including
the Pi family) goes into the asar. Native modules (`node-pty`, `@napi-rs/canvas`) stay outside
through `asarUnpack`. `package:inspect` reports the asar size and contents (target < 100 MB;
currently ≈ 67 MB) and verifies that every package the main/preload bundle leaves external is in the
asar's top-level `node_modules`.

Always run electron-builder through the pnpm scripts (not `npx electron-builder`). The packager
detects the package manager from the `packageManager` field, the lockfile or the environment; since
there is no lockfile under `apps/desktop`, when run with `npx` it takes the environment to be "npm",
cannot read the pnpm tree, walks node_modules by hand and nested the shared dependencies of desktop
and `packages/agent` (the Pi family, zod, pdfjs) under
`@codezal/agent/
node_modules/`. An app opened from inside the repo (`release/`) found the repo's
node_modules and worked, while one copied to `/Applications` crashed with
`Cannot find package '@earendil-works/pi-coding-agent'`. The `packageManager: pnpm@…` field in
`apps/desktop/package.json` makes this detection independent of the invocation form; when the pnpm
version changes while the Pi version is upgraded, this field is updated together with the root.

Although `pdfjs-dist` and `@napi-rs/canvas` are used as source in `packages/agent`, they also appear
in the `apps/desktop` dependencies: `externalizeDepsPlugin` leaves only the dependencies listed
there external. If they are not listed, rollup embeds pdfjs into the chunk, and pdfjs could not find
its Node "fake worker" (`pdf.worker.mjs`) and its font/cmap assets next to the chunk; PDF reading
passed in tests but failed every time in the app. pdfjs stays outside the asar via `asarUnpack`: in
Node the "fake worker" loads `pdf.worker.mjs` with a dynamic `import()` and reads the font/cmap
assets by path, and both need a real file system. The browser viewer, the modern build and the image
decoders are left out with `files:` filters.

`@napi-rs/canvas` brings a separate binary package per platform. `supportedArchitectures` in
`pnpm-workspace.yaml` downloads all the published targets; the platform filters in
`electron-builder.yml` put into the package only those belonging to the target's operating system.
If the binding still cannot be found, reading does not break: the page is skipped with an "Image not
sent" note, and the text layer gathered up to that point is kept.

## File layout (user data)

```
~/Library/Application Support/Codezal/
  pi/{keys.json, models.json, settings.json}   # keys.json: key pool (a plain key or a !command/$ENV reference)
  sessions/<proje-slug>/*.jsonl
  plans/<proje-slug>/<oturum>.md  # plans written in plan mode (see "Project-local layout" below)
  settings.json      # AppSettings
  logs/codezal.log   # file log (keys masked)
  logs/codezal-debug.log  # only while verbose logging is on (Settings > Diagnostics)
  agent-events/<oturum>.ndjson  # per-session agent event trace (masked; kept 7 days)
  audits/<depo>-<yol-özeti>/run-N/  # security audit: run-metadata.json, coverage-ledger.json,
                     # candidates.json, findings.json, REPORT.md, FINDINGS-DETAIL.md,
                     # NEEDS-VALIDATION.md, REPORT.pdf (outside the repo; schema compatible with upstream)
  projects.json      # recent projects; `trusted` (trust decision) and `fingerprint` (git root commit)
  usage.json         # token counter by provider/model/day (old records are by month)
  schedule.json      # scheduled tasks
  assistant.json     # assistant projects (instructions, context; the context's `copy` field holds the copy path)
  asistan/<proje>/   # working directories of assistant sessions (temporary files)
                     # persistent outputs: ~/Documents/Codezal Asistan/<proje adı>/Çıktılar
                     # context copies: Bağlam/ in the same project folder (contracts `contextDirFor`;
                     # copied by hand, "Refresh" sends the old one to the trash, removal also goes to the trash)
                     # (root `outputsRootFor`; a sibling of the code repo, the engine's `codezal-outputs`
                     # extension redirects writing outside on the first try)
  agents/<ad>.md     # user sub-agent definitions (Settings > Agents; personal, not committed)
  agents-state.json  # enable/disable + model overrides of the built-in agents
  hooks.json         # global PreToolUse/PostToolUse hooks (see "Hooks" below)
  memory/            # file-based memory (below)
    genel/           # loaded in every session
    proje/<yol-slug>/# Coding: by working folder
    asistan/<id>/    # By Assistant project
```

## System prompt

Pi builds the prompt from named sections (`preamble`, `tools`, `rules`, `addendum`,
`project_context`, `skills`, `cwd`) and writes it to the session file as a system message; later
changes are section patches. The whole prompt sent to the model can be read from the
`role: "system"` entry in the session file.

- **`codezal-prompt`** (`system-prompt.ts`, the first factory): on every turn, in
  `before_agent_start`, replaces Pi's preamble (the "assistant inside pi" text) with
  `prompt.identity`. Pi replaces the preamble only through `customPrompt`, and in that case it does
  not produce the `tools`/`rules`/`docs` sections; the tool and rule sections are taken from the
  prompt Pi processed and put back as named sections, and the Pi docs section is dropped.
  `environment` is appended at the end: local date, day and time zone, operating system, shell,
  model, git branch (no clock time and no git status, so the prompt cache is not broken). It is the
  first factory: if an extension returns `systemPrompt`, the prompt is pinned as it is at that
  moment. Plan mode also uses a named section (`plan`) and does not pin the prompt.
- **Addendum (`addendum`)**: the mode prompt, the language rule, outcome reporting
  (`prompt.reportOutcomes`), working habits (parallel reads, carrying on through context compaction,
  checking the goal before a hard-to-reverse action; `prompt.workHabits`), the external content rule
  (`prompt.untrustedContent`), PDF and search notes, general instructions, mode additions, memory.
- Read-only sub-sessions (`#readOnlySubSession`: audit hunter/verifier, code review) also get
  `codezal-prompt`, with the identity text `prompt.identityReadOnly`; their additions are only the
  external content rule (the code under review and web content can carry instructions). The role
  definition is still in the user message.

## Memory

The same model as the Claude Code harness: memory is markdown files that the agent writes and reads
with its own file tools; there is no separate database.

- Every record holds a single fact; the front matter has `name` (kebab-case, also the `[[bağlantı]]`
  name), `description` (one line; used to decide whether it is relevant), and `type`
  (`kullanici | geribildirim | proje | kaynak`). The body holds the fact; for feedback/project
  records, **Why:** and **How to apply:** lines.
- `MEMORY.md` is the index: one record per line. At every session start `MemoryStore.systemPrompt()`
  adds the rules and the indexes of the loaded scopes to the system prompt; when needed the agent
  reads the whole file with `read` and writes a new one with `write`. The index is regenerated from
  the files with `rebuildIndex()`; it stays consistent even if lines the agent wrote by hand are
  broken.
- Scope selection is in the engine: global in every session; `proje/<cwd-slug>` in Coding,
  `asistan/<projectId>` in Assistant. Writing to the memory folder does not open a permission dialog
  (`PermissionManager` trusted roots).
- UI: Settings > Memory (global + selected project) and the Memory panel on the Assistant project
  screen use the same `MemoryList` component; main watches the folder with `fs.watch` and emits
  `memory:changed`. The old `project.memory` text list is moved into files at first launch.

## Project-local layout (`.codezal/`)

The two-layer model of other tools (`.claude/`, `.codex/`, `.gemini/`, `.kiro/`): personal and
machine-specific data (sessions, memory, keys, usage) stays in the home directory; configuration
shared with the team lives in `.codezal/` at the project root and is committed. The root instruction
files `AGENTS.md` (the open standard) and `CODEZAL.md` are read in every case: Pi loads the
AGENTS.md family (the first of `AGENTS.override.md` → `AGENTS.md` → `CLAUDE.md` found in each folder
from the working folder up to the root), and the engine adds only `CODEZAL.md`. When the engine also
counted AGENTS.md, it entered the prompt twice.

```
<proje>/
  AGENTS.md, CODEZAL.md        # instructions; each enters the project context of every session once
  .codezal/
    ayarlar.json               # committed: permission, model, thinking → new-session default; hooks
    ayarlar.local.json         # personal; added to .gitignore when created
    planlar/<tarih>-<başlık>.md # plans copied with "Save to project"
    agents/<ad>.md             # project sub-agents (committed; overrides a user agent with the same name)
```

- `.codezal/` is created only on the first write (the two rows in Settings > Personalization, or a
  plan save); an empty project is not polluted. Reading is in `main/project-local.ts`, the schema is
  `contracts` `ProjectConfig`.
- **Trust gate** (`project:open`): if the project has `.codezal/` or `.pi/` and there is no decision
  in `projects.json`, the main process asks once. The decision is `ProjectRef.trusted`; the engine
  ties Pi's `.pi/settings.json` and the project skills to `projectTrusted(cwd)`, and main ties
  reading `ayarlar*.json` to it. When the user creates the file themselves or saves a plan, the
  project counts as trusted; the decision changes with the toggle in Settings > Personalization.
  Trust also passes to the project's subfolders (`.worktrees/<dal>`).
- **Relocation** (`project:open`): `projects.json` keeps the git root commit as a fingerprint. When
  a folder that is not in the list is opened and there is an entry whose fingerprint matches and
  whose path is lost, `engine.relocateProject` moves the session, memory and plan folders to the new
  slug and refreshes the `cwd` in the session headers (Pi `SessionManager.list` filters by the cwd
  in the header, and `open` takes the working folder from there). Folders that are not git have no
  fingerprint; relocation is not detected.
- **Plan files**: while the permission mode is `plan`, the `codezal-plan` extension adds the path
  `plans/<proje-slug>/<oturum>.md` to the system prompt on every turn (`before_agent_start`) as a
  section named `plan` (`prompt.planFile`); when plan mode is left, Pi removes the section with a
  patch. Like memory, the permission gate treats this folder as a trusted root; writing elsewhere is
  still blocked in plan mode. In the per-turn file list the plan file appears as "Plan file", and
  "Save to project" copies it with `plans:saveToProject` under `.codezal/planlar/` as
  `<tarih>-<ilk # başlık slug'ı>.md` (the same title on the same day is overwritten).

## Skills and routing

- Built-in commands are expanded in the renderer: `/plan`, `/sor` and `/debug` only add an
  instruction and do not change the permission mode (the chip selection always wins); `@/yol`
  mentions become a "read first" list (`lib/skills.ts`, pure and tested). They were not made Pi
  prompt templates: Pi splits the `$@` arguments on whitespace and strips the quotes, which would
  flatten a multi-line request. The MCP row shows the number of connected tools and opens Settings >
  Connectors.
- Pi skills: the engine's `DefaultResourceLoader` (`noExtensions`, `noThemes`, `noPromptTemplates`)
  does Pi's standard skill discovery; `~/.agents/skills`, the project's `.agents/skills` (including
  ancestor folders), `agentDir/skills` and the `skills` entries in Pi's settings file are read. The
  names and descriptions of enabled skills enter the system prompt as `<available_skills>`; the
  `/skill:ad` command expands inside `session.prompt()`, and the renderer passes it through as is.
  Prompt templates and npm/git packages are not used: since Pi `resolve()` installs a missing
  package from the settings without asking, the loader is given `withoutPackages(settingsManager)`
  (the `packages` it reads are empty, writes go to the real manager).
- `packages/agent/src/resources.ts` `ResourceCatalog`: with the same package-less view it collects
  all skills (including disabled ones) through `DefaultPackageManager.resolve()`, parses them with
  `loadSkillsFromDir`; name collisions and frontmatter errors are returned as diagnostics.
  Enable/disable writes the same `+yol`/`-yol` pattern (an absolute path) as the Pi TUI's
  `pi config` command. Source folders are `settings.skills`. Since Pi queues writes, every change
  waits for `flush()`. Sessions have their own loader; changes apply in new sessions (decision: a
  live `session.reload()` was not done because it could interrupt a running agent).
- IPC: `skills:list`, `skills:setEnabled`, `skills:addSource`, `skills:removeSource`,
  `skills:reveal`; event `skills:changed`. The renderer's `stores/skills.ts` holds the catalog; the
  `/` panel (`session/editor/SlashPlugin.tsx`) and Settings > Skills
  (`settings/pages/SkillsPage.tsx`) use the same store. On first launch `seedDefaults` writes the
  existing `~/.pi/agent/skills` folder as a source; it is not re-added after the user removes it.
- Security: extensions and packages are not loaded, only skill files are read. Skill content
  instructs the model; review the content before adding a source.
- Text sent while the agent is working enters Pi's `steer()` queue through `sessions:steer`; the
  agent sees the message after its next tool call. The mapper emits `run_end` at `agent_end`, while
  Pi keeps the run going until `agent_settled` (end-of-turn checks, `agent_before_settle`); in that
  window the UI may think the session is idle and send `sessions:prompt`. `engine.prompt` first
  waits for the run to settle (`waitForIdle`), then sends the message as a new turn: a steer that
  entered the queue in that window could miss Pi's last look at the queue and hang. The scheduler's
  `promptAndWait` and the goal's start message (`goal("set")`) go through the same wait. If Stop was
  pressed while waiting (the per-session Stop counter) or the session was closed, the message does
  not start a turn; on Stop an `unsent` marker is dropped into the chat (with the message's first 80
  characters, because the UI added the bubble before sending and there is no bubble after reopening
  either). If a run is still going at send time (a background nudge), `sendUserMessage` in
  `user-message.ts` turns the message into a steer; messages with images take the same path.
  `sessions:steer`/`sessions:followUp` start a new turn if the session is not streaming; otherwise
  the message would hang in a queue with nobody to start it. Since the streaming check comes first
  and queueing comes after image preparation and Pi's input handlers, Pi may settle in between: the
  queue watcher (`#watchQueue`), when the run settles and messages are left in Pi's queue, drains
  the queue and sends the messages as a single new turn (steers first, then follow-ups). Since Pi's
  queue gives only the text, the images come from the engine's own record (`#queued`); matching is
  done from the end, with the text given to Pi. Stop clears the queue and drops an `unsent` marker
  for each message (`abort()` the pending ones, the watcher those that entered the queue after
  Stop); if not cleared, Pi would attach them to the user's next message and send them.
- In a turn stopped while a tool is running, Pi opens the next model request with an aborted signal;
  the request setup (`lazyStream`) returns `stopReason: "error"` and "This operation was aborted"
  regardless of the provider. `abort()` notifies the mapper (`EventMapper.noteStop`); an error
  response that arrives before the turn closes counts as `aborted`, no error banner is emitted and
  `run_end` closes as stopped. A tool call that ends with an error in the same window ("Command
  aborted") carries `tool_end.stopped`; the card says "stopped" and the state is written to the
  session file with a `codezal-tool-stop` record (`reason: "stopped"`), so it also survives
  reopening.
- Branch: the renderer counts text-bearing assistant messages from 1 (`assistantOrdinal`); the
  engine finds the matching entry on `getBranch()` with the same rule and produces a new file with
  `createBranchedSession(leafId)`. Duplicate: a full copy with `SessionManager.forkFrom`. Both
  return the new session open.
- At the end of a turn the `context` event (`session.getContextUsage()`) carries context fullness;
  the session footer shows the percentage, amber at 80%.

## Credential pool and key rotation

- `packages/agent/src/credential-pool.ts` `CredentialPool`: implements the Pi `CredentialStore`
  interface and is passed with `ModelRuntime.create({ credentials })`; the pool is primary (at first
  launch the credentials in `auth.json` are carried into `keys.json` as a single slot); after every
  write the active slots are mirrored to `auth.json` with `#syncAuth`, because the child processes
  of Pi extensions read the key from there. Ordered slots are kept per provider; `read()` returns
  the first slot whose cooldown has passed, and if all are cooling it tries the one that opens
  earliest. Since Pi calls `read()` on every request, rotation happens without touching Pi. The file
  stamp (mtime, size) is checked on every access; if the user edits `keys.json` by hand the pool
  re-reads and does not overwrite it (Settings > Account opens the file).
- Referenced credentials: a slot value need not be a plain key; following Pi's pattern, a `!komut`
  (runs in the user's shell, `agentShellRun`; 10 s timeout, cached for the process lifetime) or a
  `$VAR` / `${VAR}` environment variable reference can be stored. Pi applies no resolution to a
  value coming from a custom store (that is the job of its own `AuthStorage`); resolution is done in
  `read()` with `config-value.ts`, and for an unresolvable reference `read()` returns `undefined` —
  which gives the same outcome ("not connected") as Pi's behavior for a credential without a key.
  `snapshot()` makes the reference visible through the `kind` / `reference` / `envMissing` fields;
  `hint` stays empty on a referenced slot. Because references in `models.json` are resolved in Pi's
  `provider-composer` pipeline, this scope covers only `keys.json`.
- Detection is `engine.ts` `#trackLimit`: if an assistant message has `stopReason: "error"` and
  `isLimitError`, the active slot cools down for `parseRetryDelayMs(hata) ?? keyCooldownHours`, and
  the `credentialRotated` callback goes to main (the `credential:rotated` event → toast + the
  provider list is refreshed). A successful response clears the slot's cooldown. The error text is
  inspected rather than Pi's retry pattern because Opencode Go-style quota errors are in Pi's "not
  retried" class. `isLimitError` looks only at quota/limit words; since Pi's
  `Server requested Ns retry delay` wrapper is also produced for outage errors, the decision is left
  to the original provider message at the tail of the wrapper.
- Resuming the turn (`#resumeAfterRotation`): the right to resume arises only if a switch to another
  key *actually* happened and is consumed by the loop; if there is no key to switch to, or the error
  is not limit-related, the right lapses. This way a persistent error cannot rerun the turn forever.
  Since `agent.continue()` runs outside Pi's `_runAgentPrompt` loop, the two jobs of that loop that
  fall to the resumed turn (`session.compact()` on a context overflow, budgeted backoff on a
  transient error) are repeated here with Pi's own `isContextOverflow` / `isRetryableAssistantError`
  classifiers. A new user turn (`prompt`) resets the budget.
- Pi's `retry` setting is overridden according to **the provider of the session's model**
  (`#applyRetrySettings`, re-applied when the model changes): `maxRetries ≥ anahtar+2`, and if that
  provider has more than one key, `baseDelayMs` 1 s and `maxRetryDelayMs` 5 s (to fail fast and move
  to the next key rather than waiting out a long server delay). For a single-key provider Pi's
  default is kept; otherwise a limit that clears by waiting would turn into an error.
- The renderer sees only `ApiKeySlot` (label, last 4 digits, status); the key value never leaves.

## Connectors (remote MCP)

In the UI they are called "Connectors"; in code the concept appears as `connector`.

- `packages/agent/src/mcp.ts` `McpManager`: connects to Streamable HTTP servers with
  `@modelcontextprotocol/client` 2 (https only; http is allowed for loopback). It keeps one `Client`
  per connector, converts the `listTools` result to a Pi `ToolDefinition` (`mcp_<bağlayıcı>_<araç>`;
  the raw JSON Schema goes through Pi's TypeBox compiler) and calls `callTool` in `execute`;
  `isError` results become a tool error, image content passes through.
- Local command (stdio) servers are added by the user by hand (`mcp:addStdio`; the command,
  arguments, environment and folder are stored in `mcp.json` with 0600). The child process does not
  inherit Codezal's credential environment (`PI_CODING_AGENT_DIR`, `*_API_KEY`): only the PATH main
  resolved, the variables the user entered and the SDK's basic variables pass. The process is killed
  when the connection drops or the app quits; on error a masked stderr tail is shown on the
  connector row.
- `tools/list_changed`: the tool list is refreshed and new tools are added to the live session;
  since Pi cannot delete a registration, a removed tool becomes inactive and, if called, returns an
  error without going to the server.
- Pinning tool definitions (a tool poisoning defense): in the first non-empty list a digest of each
  tool's name + description + schema is written to `mcp.json` (TOFU). After that a changed or newly
  arrived tool is not exposed to the model until the user sees the old/new state in Connectors and
  approves it (`mcp:approveTools`). In-app services are not pinned.
- Resources and prompts: a shared `mcp_resources` tool (list/read, text only, truncated by the tool
  budget) for servers that offer resources. Prompts are listed in the `/` panel as
  `/<servis>:<istem>`; on selection (`mcp:getPrompt`, a form if there are arguments) the text is
  written to the composer, and the user reads it and sends it themselves.
- In-app services (`packages/agent/src/native.ts` shared types, `native-<servis>.ts` services,
  `native-services.ts` registration; `native` in the store): connectors that are not MCP servers and
  where Codezal calls the provider's API directly. Since the MCP servers Google hosts are closed to
  the Workspace Developer Preview, six Google services (Drive, Gmail, Calendar, Docs, Sheets,
  Slides) go this way: the same store, the same `ConnectorOAuthProvider` and loopback server;
  discovery goes through `authServerUrl` (`accounts.google.com`), the tool list is local
  (`NativeService.tools`), and on connect a `probe` (Drive `about.user`, Gmail `profile`, Calendar
  `calendarList`) verifies the token and API access. Requests are `fetch` with a Bearer header; on a
  401 the SDK's `auth()` refreshes with the refresh token, and if that fails the connector falls to
  "Sign-in required". Tools are registered under the name `mcp_<servis>_*` through the same path as
  MCP tools (deferral included). Docs, Sheets and Slides do file search through the Drive API
  (`NativeContext.driveUrl`).
- Tool deferral: while the total of connected tools is within `DIRECT_TOOL_LIMIT` (20), all of them
  are registered with their full schema. Once it is exceeded, new tools are not registered with Pi;
  in `before_agent_start` the extension adds to the system prompt a one-line catalog grouped by
  connector (`catalogText`: the agent name + the first sentence of the description, at most 110
  characters) and registers the `tool_search` tool. The search (`matchTools`) scores the query words
  by name (3), connector name (2) and description words (1) and loads at most 8 tools with
  `pi.registerTool`; since Pi refreshes the registry mid-turn (`_refreshToolRegistry` →
  `prepareNextTurn`), a loaded tool can be used in the next model call of the same turn.
  `tool_search` carries no `mcp_` prefix, is read-only in the permission table, and the card shows
  "Tools searched". The Pi context of a closed session becomes invalid but `dispose` does not emit
  `session_shutdown`; an extension that gets a registration error drops its `onChange` subscription.
- Word matching (`alike`): it holds if two words are equal or one is a prefix of the other (for a
  word shorter than four letters, only equality). Turkish suffixes made a one-directional rule
  necessary: the query "etkinlikleri listele" ("list the events") could not find a tool containing
  "etkinlik" ("event") and returned a tool of the wrong connector.
- Preloading: `mentionedConnectors` splits the connector name into words and counts the name as
  mentioned only if a word specific to that connector appears in the prompt. When the whole name was
  searched as a substring, catalog names like "Google Drive", "monday.com" and "Atlassian (Jira,
  Confluence)" never matched; the specific-word condition also keeps a bare "google" from loading
  all six Google connectors at once. There are two gates: if a connector's **total** tool count is
  above `MANY_TOOLS` (30) it is never preloaded (if the pending count were checked, a service with
  many tools would end up fully loaded after a few searches), and the total loaded in a turn is
  limited by `PRELOAD_LIMIT` (= `MANY_TOOLS`). A connector that does not fit is skipped and the loop
  continues; small connectors do not starve because of a large one.
- Credentials: the store is `agentDir/mcp.json` (0600, plain JSON; the same approach as auth.json).
  The Bearer token goes in the `requestInit` header. For OAuth, `ConnectorOAuthProvider`: the SDK
  does discovery, dynamic client registration (`token_endpoint_auth_method: none`, PKCE) and
  refresh; the provider writes the client registration, tokens and verifier to the store. Login
  (`login`) opens a single-use loopback server on 127.0.0.1 (preferably 47821, a random port if it
  is taken, and the client is re-registered), opens the authorization URL in the browser with
  `openExternal`, verifies that `state` matches, gets the token with `finishAuth` and connects with
  a fresh carrier. In a non-interactive connect, a redirect request falls to the `needs-login`
  state; no browser is opened during a tool call. An OAuth connector with no token is counted as
  `needs-login` without connecting at all (Google serves the tool list without sign-in but returns
  401 on a call); if a 401 arrives during a call, the connection is closed and the state is set to
  `needs-login`.
- Own OAuth client: for servers that offer no dynamic registration (Google Workspace MCP) `mcp:add`
  takes `oauthClient {clientId, clientSecret}`; the provider returns this "preset" as the client
  information, registration is skipped, and the SDK sends the secret according to
  `token_endpoint_auth_methods_supported`. In this case the loopback port is strictly 47821 (the
  redirect URI registered with Google cannot change; if it is taken, `errors.mcpPortBusy`).
  `authorizeParams` (Google: `access_type=offline`, `prompt=consent`) is added to the authorization
  URL, and `discoveryState` is kept in the store. `copyClientFrom` copies the preset of a connector
  in the same `clientGroup`; the summary carries only `ownClient: boolean` and `clientGroup`.
- Catalog: `renderer/src/lib/connectorCatalog.ts` holds 30 verified official remote servers
  (credential type `oauth` DCR, `open`, `token`, `ownClient`); descriptions are i18n
  `settings.connectorCatalog.<id>`. A card adds with one click and, if the result is `needs-login`,
  starts login automatically; if the same address is already added it says "Added". Figma, Slack and
  Microsoft 365 are deliberately left out.
- Logos: `renderer/src/lib/connectorLogos.ts` holds Simple Icons (CC0) single-`path` brand marks and
  their official colors; the tile background is the brand color and the mark is white or dark
  depending on luminance (`logoInk`). Services without their own mark and manually added servers
  fall back to the MCP mark.
- The OAuth client that ships with the app: since Google offers no dynamic client registration, the
  publisher's client is embedded at build time. `electron.vite.config.ts` reads the `.env` file at
  the repo root with `loadEnv` (`CODEZAL_GOOGLE_CLIENT_ID` / `_SECRET`, kept out of git) and embeds
  it into the constants of `apps/desktop/src/main/oauth-clients.ts` with `define`. The engine gives
  it to the `McpManager` `builtInClients` map (`clientGroup` → client); if no credentials are given,
  `add()` takes them from here by family, so the user just says "Add". The `mcp:builtInGroups`
  channel tells the UI which families have an embedded client; for the others the card opens the
  client id/secret form.
- Loopback gate: for the "Web application" client the user enters, the redirect URI is registered
  one by one, so `strictPort` is on and if 47821 is taken, login fails. Since the client that ships
  with the app is the desktop type (Google accepts any loopback port, and per RFC 8252 the secret is
  not considered a secret), `strictPort` is off; if the port is taken a random one is chosen and the
  preset client is not re-registered.
- Google scopes: since the server metadata lists all scopes (the full mailbox for Gmail), the
  catalog entries write the narrow list from Google's documentation through `authorizeParams.scope`;
  the `scope` parameter in the authorization URL takes effect instead of the SDK's `determineScope`.
- When the Connectors page opens, services that are enabled but in error are retried once; because
  the connection does not come back by itself after sleep/network loss.
- Session binding: the engine puts the `codezal-mcp` inline extension into `extensionFactories`; at
  startup the extension registers the connected tools with `pi.registerTool` and adds those that
  connect later to the live session with `onChange`. Since Pi's `tools` option works like an
  allowlist and would eliminate extension tools, the engine does not pass it: in Assistant only
  `edit` is excluded with `excludeTools`, and when the session opens `#activateTools` activates the
  base tools by mode + the `mcp_*` tools with `setActiveToolsByName`; tools registered later become
  active by themselves through Pi's registry refresh (`engine.test.ts`). Because it comes after the
  permission extension, the `tool_call` gate applies to these tools too (the custom tool rule:
  blocked in plan mode, free in full access, otherwise ask). A removed tool cannot be taken back
  from Pi; a call returns a "not connected" error.
- IPC: `mcp:list`, `mcp:add`, `mcp:update`, `mcp:remove`, `mcp:login`, `mcp:logout`,
  `mcp:reconnect`; event `mcp:changed`. The contract `McpConnector` carries only the status, tool
  list and credential type; the token does not go to the renderer. The renderer has `stores/mcp.ts`
  and `settings/pages/ConnectorsPage.tsx`; `describeTool` turns `mcp_*` names into a "Connector
  called" card.
- Test: `mcp.test.ts` serves `@modelcontextprotocol/server`'s `createMcpHandler` over `node:http`;
  with a 401 + a small OAuth imitation (metadata, register, token) it verifies the full sign-in
  flow, connecting with a stored token on restart, and logout.

## Web tools

`packages/agent/src/web-fetch.ts`: `web_fetch` via Pi `defineTool`. Only http/https; localhost,
`.local` and private IP blocks are rejected; HTML is reduced to plain text with `htmlToText`,
truncated at 60 thousand characters, 20 s timeout. The name is resolved once at each redirect step,
all addresses are checked with `isPrivateAddress`, and the connection is opened only to these
addresses with `pinnedFetch` (`node:http(s)` + `lookup`); since the global `fetch` resolves the name
again, a short-lived DNS record could be used to get back into the internal network (rebinding). On
the permission side `web_fetch` is not in the read class: in Ask and Plan mode a new domain is asked
about and the session permission is given per domain (`allowKey(web_fetch, host)`); so that the
agent cannot put a file it read into an address and send it out. `web_search` is asked about in the
same modes: the query shows on the card, and the session permission with a targetless key
(`allowKey(web_search, undefined)`) covers all searches in the session; since the query differs
every time, a per-query permission was pointless. `web-search.ts` uses the DuckDuckGo HTML endpoints
and on a rate limit waits and retries twice.

Web content goes to the model as an untrusted block (`untrusted.ts`, the counterpart of the legacy
`wrapUntrusted`): `web_fetch` page text, DuckDuckGo results and the summary/sources of the built-in
search are wrapped between `<<<UNTRUSTED_WEB_CONTENT id=…>>>` …
`<<<END_UNTRUSTED_WEB_CONTENT id=…>>>`. The id is random on every call; a page cannot imitate the
closing line and write text outside the block. Invisible characters (zero-width, direction-changing,
the Unicode tag block) are deleted. Instruction patterns (legacy `redactInjectionAttempts`) are
counted without deleting the line and the count is written into the block's warning: legacy deleted
the line, and a news line containing "jailbreak" would have gone too.

Results from connected services go in the same envelope (`kind: "service"`,
`<<<UNTRUSTED_SERVICE_CONTENT …>>>`, warning `prompt.serviceUntrusted`): a remote MCP tool result
and error text, the local Google services, `mcp_resources` reads. Email, document and record content
may have been written by someone else. The tool card does not show the envelope: `outputOfResult`
drops the header, warning and closing lines with `unwrapUntrusted` (web cards included); the closing
line stays as it is in a truncated block.

In a scheduled task (`ScheduledTask.allowWeb`) web permission is given at save time: for a task
running in Ask/Plan mode `runScheduled` marks the session with `setWebAllowed`, `gate` lets the web
tools through even in an unattended session, and the mark is lifted when the run ends. This way
tasks like a news summary can run in Plan mode instead of Full access; an instruction on the page
cannot reach files or the shell. A task run (an unattended session) cannot create, modify or delete
tasks with `schedule_task`; it only lists (the counterpart of ZCode's automation turn denylist,
inside `gate`). Otherwise an instruction on a page that was read could set up a persistent new task
that runs every day in Full access. In the same session `web_fetch` does not hand the page to the
main agent (`WebFetchOptions.quarantine`, the counterpart of ZCode's `processFetchedContent`): the
page is summarized in a single tool-less model call with `extractPage` according to the tool's
`prompt`, and only the summary goes to the main agent in the untrusted block. If there is no model
or no response, the read fails; falling back to raw text would silently remove the protection.
`web_search` likewise does not hand results to the main agent with the same marker
(`WebSearchOptions`): both the built-in search summary and the DuckDuckGo results are reduced with
`extractPage` to a list of findings + source links according to the query (a second call on the
built-in path). Sub-agents look at the main session's unattended marker. The summary model is the
"Web summary model" in Settings > Usage & model (`AppSettings.webSummaryModel`, read live by the
engine through `EngineConfig.webSummaryModel`); `pickSummaryModel` looks for the choice among models
that have a key (`getAvailable`), and if it is empty or not found falls back to the task's model.
The list in the setting is sorted by the estimated cost of a typical summary call
(`summaryModelsByCost`: ~8 thousand input + ~700 output tokens); looking only at the input price
made a model with expensive output look cheap.

`web_fetch` follows a redirect only within the same site (a `www.` difference is allowed), on the
same protocol/port or an http→https upgrade with default ports (`isFollowableRedirect`, ZCode's
`isPermittedRedirect`). On a redirect to another site the body is not read and the address is
returned to the model; if the model calls again, the new domain falls to approval. This way an
approved site cannot carry a request to a site the user did not see.

`isDangerousCommand` also recognizes data exfiltration patterns (a pipe to a network tool,
`curl -d @`/`-T`/`-F x=@`, `wget --post-file`, `$(…)` embedded in an address, `/dev/tcp`); in an
unattended task in Full access these are rejected.

`web-search-native.ts`: the provider's built-in web search (ZCode's WebSearch system). The Pi SDK
models only client-side tools; `web-search-native.ts` adds the server-side search tool to the body
of the inner model request with the `onPayload` hook (Anthropic `web_search_20250305`, OpenAI/Azure
Responses `web_search`, Google `google_search`). The request is made with
`ctx.modelRegistry.complete`: the tool does not scrape pages itself, it gets a summary + source list
from a model with search capability. If the provider is not supported or the summary comes back
without sources, the tool falls back to the DuckDuckGo path; there is a 60 s timeout. The sources
are extracted from the markdown links in the summary text (the Pi SDK does not carry provider
citation fields to the model), the result is given to the model as "Summary + Sources" and it is
told to use the sources in its reply. The tool's `details.endpoint` field (`native`/`html`/`lite`)
is carried to the UI as `ToolCallItem.searchBackend`: the card's meta line shows a "Built-in search"
or "DuckDuckGo" label, so which path ran can be read off the screen — the output of the two paths
could not be told apart.

Both tools are registered and enabled in every mode (previously only in Assistant): when writing
code too one needs to search for docs, release notes and error messages. In the permission table
they are in the read class — they read from the network and do not touch local files — so they also
work in Plan mode; research is part of the plan.

## Advisor (`advisor`)

`advisor.ts`: a parameterless tool through which the agent consults a stronger model. The model is
chosen in Settings > Usage & model as a provider and model (`AppSettings.advisorModel`, read live by
the engine through `EngineConfig.advisorModel`); if empty, the advisor is off. The tool is
registered in the `codezal-advisor` extension factory only while a model is selected, so it does not
appear in the model's tool list or system prompt while off; when the setting changes, `settings:set`
calls `reloadLiveSessions` and it is added to or dropped from open sessions. Its name is in
`DEFAULT_TOOLS`/`ASSISTANT_TOOLS` (`setActiveToolsByName` ignores it while unregistered); it does
not enter the narrowed tool set of sub-agents and agent runs. Its permission class is read-only.

On a call, the session's active branch (`buildSessionContext` + `convertToLlm`, compaction summary
included) is converted to plain text and sent with `streamSimple` in a single user message together
with the agent's system prompt (project instructions, at most 30 thousand characters);
`reasoning: "high"` on a thinking model. Raw messages are not sent: the result of the `advisor` call
in the last assistant message does not exist yet (Anthropic rejects a tool call with no result) and
the advisor may be a different provider. A tool result is truncated at 20 thousand characters, and
an argument and thinking block at 6 thousand, from the head and tail; the total limit is computed
from the model's context window, and if exceeded the first user message (the task) is kept and old
entries are dropped. If the selected model has no key, it does not fall back to the task's model,
the tool returns an error (the point of the advisor is the stronger model). Usage is written to the
counter with the `usage` event under the name `sağlayıcı/model`.

In a scheduled (unattended) run the advisor is used if `AppSettings.advisorScheduled` is on (default
off: every consultation sends the entire conversation to the strong model and accumulates with
nobody watching). Since the unattended marker is set after the session opens, the decision cannot be
made at startup; `#syncAdvisor` at the start of `prompt` and `promptAndWait` removes the tool from
the active set, and when the unattended state ends it adds back only what it hid itself (it does not
leak into the narrowed set of an agent run). The `allowed` gate inside the tool is a second defense
against state that changes mid-turn.

## User-defined agents (`agent`)

The user defines their own sub-agents; the model delegates a task to the agent it names. A
definition is a Markdown file (front matter + a system prompt body), and the page is Settings >
Agents.

- **Format** (`packages/agent/src/agents/profile.ts`): `name`, `description` (required), `color`,
  `model` (`sağlayıcı/model`; empty or `inherit` = the main session's model), `thinking`, `tools`,
  `disallowedTools`, `injectAgentsMd`, `isolation` (`worktree` or none) and `background` (`true` or
  none). The parser is lenient: both `tools: read, grep` and `-` lines one under another are
  accepted.
- **Store** (`agents/store.ts`): built-in agents come from code (`general`, `explore`), file agents
  are read from `<veri>/agents` (user) and `<proje>/.codezal/agents` (project). Precedence is
  built-in < user < project; built-in names cannot be overridden by a file, and such files are
  reported as diagnostics. Enable/disable is kept in `agents-state.json`, and the file is not
  deleted. The new agent form opens with user scope: a definition written to the project folder is
  committed and shared with the team, so that choice must be deliberate.
- **Model of built-in agents**: `general` and `explore` are defined in code; they cannot be edited,
  deleted or disabled. The model is chosen with the picker on the row and written to the `overrides`
  map in `agents-state.json` (for file agents the model stays in their own front matter).
- **Tool set**: `resolveAgentTools` resolves it from the profile. If `tools` is empty,
  `SUBAGENT_TOOLS` (`read`, `grep`, `find`, `ls`, `edit`, `write`, `bash`, `web_search`,
  `web_fetch`); a nested agent (`agent`), run management (`agent_list`/`agent_message`/`agent_stop`)
  and the plan tools are never given. Connector (mcp_*) tools are not loaded into the sub-session,
  so they are not in the default set.
- **Run** (`CodezalEngine.#agentRun`): the sub-session is opened in memory; the profile's system
  prompt is added with `appendSystemPrompt`, and the project instruction files are added with
  `agentsFilesOverride` when `injectAgentsMd` is on; when it is off `noContextFiles` is passed,
  otherwise Pi would load AGENTS.md anyway. `codezal-prompt` is the first factory in the sub-session
  too; the external content rule goes to the sub-agent as well. The model and thinking level come
  from the profile, or from the main session if empty.
- **Permission**: since the tool set is not read-only, the `codezal-permissions` factory is bound to
  the sub-session with the main session's identity: write/shell calls are asked of the user in the
  main session, and the decision is made according to the main session's permission mode. The
  `agent` tool itself is in the read class in the permission table.
- **Liveness**: the `agent` tool is registered from the `codezal-agents` factory; since
  `session.reload()` reruns the factory, adding/deleting/disabling on the page is reflected in an
  open session's tool definition too (a custom tool list is not regenerated on refresh, which is why
  registration is done from the factory).
- **Trace**: a run appears in the Agents panel through `subagents`/`subagent_trace` events with the
  `agent` type and the agent's name; the exploration agent (`explore`) with the `explore` type and
  the task title. Consumption is emitted under the main session's identity; a sub-turn is stopped at
  10 minutes. A single run can be stopped from the Agents tab (`subagents:stop` → `#subagentStops`);
  the main turn continues with a partial result.
- **Exploration**: there is no separate `explore` tool (it was removed); exploration is the built-in
  `explore` agent (`EXPLORE_TOOLS`: `read`, `grep`, `find`, `ls`). This way its model can be changed
  from Settings > Agents, and the task limit is that of the `agent` tool (8000 characters).

## Agent runs (background / worktree)

Work that runs in parallel and without waiting is not a separate "task group" concept but two
options of the `agent` tool; the detailed design is in `docs/TECH-PARALEL-WORKER.md`.

- **Form decision** (`CodezalEngine.#agentBridge`): a run that is `background` or needs isolation
  runs detached (`AgentRunManager`, a full session); the others run in memory (`#agentRun`,
  `Limiter`). A writing agent running in the background or in parallel with another writing agent is
  put in a worktree automatically (`preferred`: if it is not a git repository, it continues in the
  root); an explicit request is `required`. In plan mode a writing agent cannot run detached.
- **Concurrency**: `agentConcurrency` (1–8, default 3) is the limit of both the detached pool and
  the in-memory runs (two separate counters, the same setting).
- **Permission**: a worktree run uses `agentWorktreePermission` (default `auto-edit`), and a
  detached run without isolation uses the main session's mode. The permission card is asked in the
  main session (the `PermissionManager` request is routed to the main session with `runs.parentOf`).
- **Result**: when a background run finishes, the main session is woken with
  `#nudge(…, "background")`. A worktree run that leaves changes waits in the `review` state; the
  decision is the user's (`agentRuns:review`, the review card at the end of the chat and the Agents
  tab).
- **Record**: per main session `meta.json` → `agentRuns`; run sessions carry `parentSessionId`, do
  not appear in the sidebar, and are deleted when the main session is deleted.

## Security audit (`audit_*`)

Runs the Cloudflare `security-audit-skill` workflow as a product feature: coverage ledger → isolated
hunt → independent verification → schema-validated record → deterministic report. Decisions:

- **No new mode**: an audit is a session in Coding mode; the session is marked with
  `Meta.audit.runId` and `SessionSummary.auditRunId` (a shield icon in the sidebar).
- **The app writes the state, not the model** (K2): `AuditSession` + `AuditStore` write atomically
  (tmp + rename) under `userData/audits/<depo>-<özet>/run-N/`: `run-metadata.json`,
  `coverage-ledger.json`, `candidates.json`, `findings.json`, three Markdown reports and
  `REPORT.pdf`. The folder layout is compatible with upstream `validate-findings.cjs` /
  `validate-coverage-ledger.cjs`.
- **The target code is not run** (K3): `run-metadata.json` carries
  `execution_policy: "source-only"`; the hunter and verifier sub-sessions are built like the
  exploration agent with `SessionManager.inMemory` + `EXPLORE_TOOLS`, and have no network tools. A
  claim that depends on running code stays `needs_validation`.
- **Independence is enforced in code** (K4): every candidate carries `foundBy` (the hunter session);
  the verifier is a separate session, and `promoteCandidate` rejects a `confirmed` record where
  `verifiedBy == foundBy`. `AuditView.independentlyVerified` is true only on `confirmed` records.
- **During an audit the main session is in plan permission** (K5): finding text that comes from
  untrusted repository content cannot turn into an `edit`/`write`/`bash` call. The audit tools are
  in the `READ_ONLY` class (they write only to the app's own run folder) and when the report is
  produced the session returns to its previous permission.

**Flow** (`audit/tools.ts` + `engine.ts` `#audit*`): `audit_start` extracts the scope, produces the
units (`saldırı sınıfı × yüzey`, coarsened by profile) and inherits the previous run's `covered`
units at the same source version (`ledger.ts`). `audit_hunt` gives a unit to an isolated hunter; the
hunter itself `read`s the attack-class pack (`resources/audit/*.md`) and returns only structured
JSON candidates (a single repair turn; if still broken the candidate is kept as `parse_error` — it
does not vanish). `audit_verify` tries to refute a candidate in a **different** sub-session.
`audit_record` converts verified candidates into the upstream schema and writes them to
`findings.json`; `audit_status` gives a compact summary of the ledger without pulling it into
context; `audit_report` *derives* the reports *from the records* (the model writes no prose), and if
work is missing the run is marked `incomplete`.

**Budget**: a hard agent-call limit per profile (quick 25 / standard 60 / deep 150); when exceeded
the tool refuses, the unit becomes `deferred` and the run closes `incomplete` — it is not diluted
silently.

**Source pack**: `apps/desktop/resources/audit/` (an upstream copy, the commit is in `README.md`) is
packaged with `extraResources`; in development `app.getAppPath()/resources/audit`. The schema and
validator parity test (`audit/upstream.test.ts`) runs the produced `findings.json` through the
upstream validator with Node.

**UI**: the **Findings** tab in the right panel (`panel/AuditTab.tsx`, `stores/audit.ts`, the
`audit:state` / `audit:start` / `audit:export` / `audit:reveal` channels; `audit:changed` is emitted
from main). Finding texts are rendered as plain text; they are not interpreted as HTML/markdown.

## Code review (experimental, shadow mode)

A light quality observer that optionally checks file changes at the end of a turn; it is a separate
subsystem independent of the security audit, using its patterns (an isolated read-only sub-session,
independent verification, an append-only record) (`review.ts`, `engine.ts` `#runReview`).

- **Triggered by hand**: with `reviewerOn` on in Settings > Code review, the "Review" button that
  appears under the last turn calls the `review:run` channel; the engine takes as scope at most 10
  files changed with `edit`/`write` in the last 5 user turns. There is no automatic trigger — the
  token cost depends on the user's request; the run continues in the background, and start/end
  arrive with the `review` event.
- **Evidence requirement**: the reviewer returns only candidates that carry file:line + a code
  quote/reproduction ("you don't have to find a bug"); `bug`-class candidates are put through a
  refutation attempt in a separate sub-session (confirmed/rejected/inconclusive). `risk`/`nit` do
  not burn a verification turn (a cost limit).
- **Shadow mode**: findings are not sent back to the model and no fix loop is set up; the result
  goes only to the `ReviewStore` record (`userData/reviews/<depo>/<oturum>.jsonl`,
  `run`/`finding`/`mark` lines) and the `ReviewCard`. The "Real / False positive" mark is
  measurement data; moving to a permanent system depends on this data.

## Hooks (`codezal-hooks`)

The counterpart of Claude Code's PreToolUse / PostToolUse hooks; not a plugin but the user's shell
commands. `packages/agent/src/hooks.ts`, the loader `main/hooks.ts`, the schema contracts
`hooks.ts`.

- **Sources**: `userData/hooks.json` (root `{ PreToolUse?: [...], PostToolUse?: [...] }`) and, in a
  trusted project, the `hooks` field in `.codezal/ayarlar.json` + `ayarlar.local.json`. The two
  project files **merge** (the local file does not override the team rule). Hooks of an untrusted
  project are not read. The list is re-read on every tool call; a corrupt file is written to the log
  once and skipped.
- **Entry**: `{ matcher, command, timeoutSec? }`. `matcher` is a regular expression applied to the
  **whole** tool name (`bash` does not match `bash_background`; empty or `*` matches all). The
  command runs in the agent shell (`agentShellRun`), in the session's working folder, with main's
  PATH-corrected environment (`hookEnv`); `{ event, tool, input, sessionId, cwd }` is written to
  stdin (for PostToolUse additionally a truncated `result` and `isError`).
- **PreToolUse**: runs **before** the permission gate (no approval is asked for a call it blocks).
  Exit 2 → the call is blocked, and stderr becomes the first line of the reason (it returns to the
  model, an error line on the card); 0 → passes; other codes, a timeout (default 30 s) and a launch
  failure are only a warning in the log.
- **PostToolUse**: only observes; on exit 2 stderr is added to the tool result as feedback.
- The "Hooks" section in Settings > Personalization shows the list (`hooks:list`) read-only with its
  source file; "Open" opens `hooks.json` (with a skeleton if it does not exist).

## Bash sandbox (macOS Seatbelt)

`packages/agent/src/sandbox.ts`. The setting is `bashSandbox` (default off; Settings >
Personalization > Security). When on and on macOS, agent commands run under
`/usr/bin/sandbox-exec -p <profil>`:

- Profile: `(allow default)` → `(deny file-write*)` → the working folder, output folder, temporary
  folders (`/private/tmp`, `/private/var/folders`, `$TMPDIR`), package caches (`~/Library/Caches`,
  `~/.npm`, `~/Library/pnpm`, `~/.cache`, `~/.cargo/registry`, `~/go/pkg`) and `/dev` are writable →
  the data root (`userData`) is closed to read+write → writable roots inside the data root (the
  Assistant working folder) are reopened. In SBPL a later rule overrides an earlier one. Paths are
  also written in their real form (`/tmp` → `/private/tmp`); strings are embedded with `\` and `"`
  escaped. The network stays open.
- Scope: `bash` (the foreground window at argv level in `BackgroundRunner`, Pi's built-in executor
  through `spawnHook` as `exec sandbox-exec … <kabuk> -c <komut>`), `bash_background` and the `bash`
  of `agent` sub-agents. The decision is made on every command; the toggle is reflected immediately
  in open sessions.
- The result of a call that ran sandboxed is marked with `details.sandboxed` (the `codezal-turn`
  `tool_result` hook; since Pi throws an error on a non-zero exit, the tool itself cannot write it)
  and the terminal card says "Sandboxed". If `sandbox-exec` is missing the command runs unprotected,
  and the tool result warns once in the session. Outside macOS the setting has no effect, and the
  toggle says "Available on macOS only".
- Known limit: in a git worktree `.git` points to the main repository's folder; since it stays
  outside the working folder, a commit from inside a worktree is rejected in the sandbox.

## Background commands (`bash_background`)

`packages/agent/src/background.ts`: `BackgroundRunner` holds the processes, and `backgroundTool`
gives the model the `start` / `output` / `stop` / `list` actions. The aim is not to lock the turn —
when a minutes-long build, test run or dev server was run with `bash`, the user had to wait.

- The command runs in the shell resolved by `agentShellRun` in `packages/agent/src/shell.ts`: on
  Windows Git Bash (the **same** resolution as Pi's `bash` tool; if missing it falls back to
  PowerShell), on POSIX `$SHELL`. The end-of-turn checks (`main/checks.ts`) use the same resolution.
  On POSIX the process is born in its own group (`detached`); `stop` closes the tree with
  `killProcessTree` (`taskkill /F /T` on Windows), otherwise the child processes of `pnpm dev` would
  be left orphaned. The last 20 thousand characters of output are kept.
- **Wake-up on exit**: when the process ends, `CodezalEngine.#onBackgroundExit` nudges the session
  with a `NUDGE_TYPE` message (`display: false`); if Pi is idle this starts a new turn
  (`sendCustomMessage`: "not streaming + triggerTurn → new turn"). The model sees the exit code and
  the output tail and reports the result to the user itself. The extension API (`pi`) is therefore
  kept per session in the `#pi` map: there is no other way to send a message to a session after its
  turn has ended.
- A task the user `stop`ped does not nudge (the user asked for the result themselves), and when the
  session closes (`closeSession`) that session's tasks are stopped — no orphaned process is left.
- The permission table splits by action: `evaluatePermission` gives the read class when
  `args.action !== "start"`, and the shell class for `start` (approval in Ask, blocked in Plan, free
  in Full access). Dangerous command patterns produce the same warning as `bash`, and the card is
  also of the `terminal` type.

### Automatic backgrounding (the `bash` wrapper)

`packages/agent/src/bash-tool.ts` wraps Pi's `bash` tool under the same name (see `read-tool.ts`):
at first, backgrounding was left to **the model's up-front decision**; a model that could not
predict that a command would run long executed it with `bash`, and the turn and the user waited. Now
a command that exceeds its window is moved to the background automatically:

- The command is started **once** (`BackgroundRunner.start(..., { backgrounded: false })`). If it
  finishes within the foreground window (`AUTO_BACKGROUND_MS`, 90 s), Pi's normal result is returned
  — output, exit code, truncation and the temp file with the full output all come through the same
  path, because Pi does the formatting; the only thing that changes is who holds the process
  (`BashOperations`). If the window is exceeded the same process becomes a background job with
  `markBackgrounded`, `background_start` is emitted (chip + Agents box) and a "you will be woken
  when it finishes" note returns to the model as the tool result.
- **Verification commands** (`isVerificationCommand`) and **unattended sessions** stay in Pi's
  built-in executor: the first because closing the turn depends on the result (when it was thrown
  into the background, the model wrote a report without seeing the result and then went on to fix it
  after the nudge), the second because there is nobody to see the nudge. Both keep the earlier
  behavior.
- `timeout` carries two meanings: if it expires in the foreground the command is cut off (Pi's
  "Command timed out" error), and if the command was moved to the background it becomes the job's
  final deadline and the process is closed (a `timedOut` note). Interrupting the turn closes the
  process that is in the foreground window; if the job was moved to the background, interrupting
  does not kill it — the user stops it from the panel if they want.
- A task in the foreground window carries `backgrounded: false`: it does not emit `background_end`,
  nudges nobody, and does not appear in the `sessions:open` response or in the
  `bash_background list` result (its end is only the tool result).

Truncation is not silent on the background path either (see "Tool result budget"): the `outputChars`
total is counted **before truncation**, and the end notification and the `output` action state the
original length and how to read the stored tail (`truncationNote`). Previously a model that read a 4
thousand character tail could take the output to be complete and conclude "no errors".

## Agents box and the sub-agent live trace

The Agents card in the right column of the Coding screen and the **Agents** tab of the right panel
share the same data: the sub-agents running in this session (exploration, audit hunter/verifier,
code review) and detached agent runs (background / worktree) are listed with live duration, step
count, tokens/s and the last tool; the tab draws the full tool stream of the selected run.

- **One producer, one schema**: `packages/agent/src/subagent-trace.ts` (`SubagentTracker`). Every
  path that opens an alternate session (`#agentRun`, `#readOnlySubSession`) opens a
  `SubagentHandle`; the run header is emitted as a `subagents` snapshot (replace) and the tool
  stream as `subagent_trace` events (append). Trace items have the same schema as the main
  transcript (`TranscriptItem`), so the panel reuses the chat's tool cards. **There is one tracker
  per session** (`CodezalEngine.#tracerFor`) and `begin` is called after the sub-session is set up:
  a separate tracker per run would, with replace semantics, make parallel hunters overwrite one
  another; a run opened before setup would, on error, be left stuck as "running". Finished runs are
  capped by `MAX_FINISHED_RUNS` (20).
- **Noise limit**: partial tool output is emitted at most every 200 ms (`TOOL_UPDATE_MIN_MS`), a
  single item is truncated at 4 KB (`TRACE_OUTPUT_MAX`), the assistant text at the end of the turn
  is sent instead of `text_delta`; the renderer keeps the last 300 items per run
  (`AGENT_TRACE_MAX`).
- **Persistence**: a finished run is written, with its header and trace (the last `TRACE_KEEP_ITEMS`
  (200) items, each limited to `TRACE_KEEP_CHARS` (1.5 KB)), to the main session's Pi file as a
  `codezal-subagent-run` custom entry (`appendCustomEntry`; it does not go to the model).
  Exploration and audit hunter/verifier runs (`UNSAVED_KINDS`) are not saved and their old records
  are not loaded: they are single-use, and an audit opens dozens of runs and would grow the file.
  When a session is made live (`#attach`: opening from disk, branching), the `getBranch()` records
  are loaded into the tracker with `SubagentTracker.restore`: so that the `subagents` emission
  (replace) of a run that starts later does not wipe the old ones. A branched session carries the
  runs over with the same `runId`. `sessions:open` returns `subagents` and `subagentTraces`; the
  renderer puts them into the runtime and, with `useAgents.seed`, into the trace store. Rewind drops
  finished runs that started after the cut point (`dropAfter`). "Clear finished" only hides in
  renderer memory; when the app restarts the runs come back. A running run is not saved.
- **Usage**: the sub-turn's consumption is written both to the main session's `usage` event (the
  cost counter) and to the run header (`tokens`, `tokensPerSec`, `usage`); model information arrives
  with the first assistant message.
- **Link**: `parentToolCallId` ties the `agent` card in the main transcript to the run; the card
  shows a "Subagent" badge and, when expanded, a "Watch live" button (`session/AgentBadge.tsx`).
- **Trace stores**: in-memory runs are in `stores/agents.ts` (`trace`, `hidden`, `selected`), and
  detached runs use their own session transcript (`sessions.runtime[koşuOturumu]`; rows come from
  `stores/agentRuns.ts`). "Clear finished" hides the run; when a session is deleted `forgetSession`
  drops the traces. As a safety belt the trace store is capped by `MAX_TRACE_RUNS` (40), and the
  item count per run by `AGENT_TRACE_MAX` (300). The badge in the chat takes run data not from
  context but from each card's own selector (`useAgentRun`): otherwise every sub-agent event would
  redraw the whole transcript. `SessionRuntime.subagents` is not cleared at turn start: a sub-agent
  run can continue independently of the turn.
- **Background commands** do not count as agents: they are listed in a separate card and do not
  enter the "running" counter. Their records are written to `SessionRuntime.backgrounds` with
  `background_start` / `background_end` events, and the `sessions:open` response carries the running
  tasks.
- The box is drawn only when there is content, and folds with `useCollapseOnDone` when the work is
  done (`session/AgentsBox.tsx`, inside `EnvBox`).

## PDF reading (the `read` wrapper)

`packages/agent/src/read-tool.ts`: Pi's `read` tool is redefined under the same name; Pi puts a
custom tool of the same name in place of the built-in one (in tool registration, extension tools are
written later). Why wrap: the model decides which tool to pick from the tool description; Pi's
description says "text and images", does not mention PDF, and presents `offset` as a line number.
The `prompt.pdfRead` line in the system prompt was not enough on its own, and the model would try to
open the PDF in the terminal with pypdf/pymupdf. The wrapper reads a `.pdf` path itself (with
`resolveReadPath`, following Pi's path rules): `readPdfContent` in `pdf.ts` extracts the text layer
page by page and turns scanned and drawing pages (`pageKind`) into images; `offset` is the page
number, `limit` the page count, and `render: true` also adds every page in the range as an image (20
pages, 5 images and 60 thousand characters per call). If the file does not exist or is not a PDF,
the call is handed over to Pi's built-in definition (`createReadToolDefinition`). The wrapper is
registered both in the main session's `customTools` list and in the exploration sub-agent; in the
permission table `read` stays in the read class.

## PDF creation tool

`packages/agent/src/pdf-create.ts`: `pdf_create` via Pi `defineTool`. The model supplies a complete
HTML document, `EngineConfig.renderPdf` (main `pdf.ts`, Chromium `printToPDF`) turns it into PDF
bytes and the tool writes the file to the target path; there is no external dependency, and Turkish
characters are rendered with system fonts. A relative name falls into the output folder in Assistant
and the working folder in other modes (`resolvePdfPath`); the `.pdf` extension is added. In the
permission table it is in the `write` class, and the output gate and the pre-turn backup (so that
undo can delete it) know the same path. Since the card type is `create`, the Outputs box and the
turn file list see the PDF. The reading side is separate: a PDF is opened with `read` (see "PDF
reading" above). A tool was chosen over a skill: a shell command led to a Python/poppler dependency
and a "run a converter" instruction that contradicted the `pdfRead` prompt.

## PDF editing tool

`pdf_edit` (`pdf-edit-tool.ts`, engine `pdf-edit.ts`, `pdf-lib` + `@pdf-lib/fontkit`) does the
operations `merge`, `split`, `rotate`, `delete_pages`, `extract_pages`, `watermark`, `fill_form` and
the read-only `list_fields` on an existing PDF; since it does not depend on Chromium it is
registered in every mode. The input is not changed implicitly: if there is no `output`,
`resolvePdfEditTargets` picks a name appended next to the source (`-merged`, `-rotated`, `-part-N`…;
a taken name is skipped with `-2`, `-3`, and the suffix is English regardless of the language
choice), and the input changes only if `output` explicitly points to it. The same resolution is used
through `editedFile` in `create-tools.ts` (the permission gate) and `editedFiles` (the turn backup;
every part in `split`). The card is of the `create` type, `list_fields` draws a `read` card, and in
the permission table it is a read. Since pdf-lib's standard fonts print only WinAnsi, a Unicode TTF
is embedded as a subset for the watermark and form values: no font is shipped in the repo, and main
picks the first one on the system from the `PDF_FONT_CANDIDATES` list with `resolvePdfFont()` (macOS
Arial / Arial Unicode, Windows Arial / Segoe UI, Linux DejaVu / Noto / Liberation) and passes it
with `EngineConfig.pdfFont`. If there is no font, text that fits WinAnsi is printed in Helvetica,
and a Turkish character gives an explicit error. An encrypted PDF is rejected with a clear Turkish
error; encryption and OCR are out of scope.

## Word reading and generation

Reading: the `read` wrapper hands a `.docx`/`.docm`/`.dotx`/`.dotm` path to `readDocxContent` in
`docx.ts`. There is no package dependency: `ooxml.ts` reads/writes the ZIP by hand (entries with
`zlib.inflateRawSync`, with a 64 MB ceiling; when writing, unchanged entries are copied with their
raw bytes) and parses the XML losslessly in terms of meaning and writes it back (the declaration,
comments and empty tags are preserved); `docx.ts` converts `word/document.xml` to Markdown. Headings
are resolved from the style name ("heading N"; in Turkish Word the id may be `Balk1` but the name
does not change), from the `basedOn` chain or from `outlineLvl`; the list type from `numbering.xml`;
links from `document.xml.rels`. A table becomes a GFM table, text boxes (`w:txbxContent`) are read,
and tracked deleted text is skipped. Header/footer appear as a single-line band at the start and
end, footnotes/endnotes as `[^n]:`, a comment with the text it is anchored to as
`{==metin==}{>>yazar: yorum<<}`, and a tracked change as `{++eklenen++}`/`{--silinen--}`
(CriticMarkup); the title line states the number of changes and comments. `offset`/`limit` apply to
the converted lines. The same view (`convertDocx`) goes, in main's `files:read`, as
`FileContent.markdown` to the Outputs and Files preview; the renderer draws Markdown's CriticMarkup
in color.

Editing: `docx_edit` (`docx-edit-tool.ts`, engine `docx-edit.ts`) changes an existing document by
text: `replace`, `insert_after`/`insert_before`, `delete`, `comment`,
`row_insert_after`/`row_insert_before`, `row_delete`, `col_insert_*`, `col_delete`, `cell_merge`,
`cell_split`, `table_insert_*`, `table_delete`, `accept_all`/`reject_all`. Row operations search in
the row's `| a | b |` text in the read view (`rowText`, the same as the reader's padding); a new row
is a copy of the neighboring row, and a row inserted under the header takes the first body row as
its model; tracked rows carry `w:ins`/`w:del` inside `w:trPr`. Column operations (`col_insert_*`,
`col_delete`) and `cell_merge` search in the cell text and work with the grid: the `w:tblGrid`
widths are scaled with the total preserved, the DXA `tcW`s are set equal to the columns they span,
and the merged cell's `gridSpan` and the rows' gaps `gridBefore`/`gridAfter` are updated. Tracked
columns carry `w:cellIns`/`w:cellDel`; accept/reject removes the cell and only the grid column that
belonged to it together with `removeCells`. Merging writes `gridSpan` + `vMerge`; in tracked mode,
since Word itself leaves no trace (cell-level `tcPrChange`/`cellDel` breaks the grid on
accept/reject in Word), the rows of the range are written as changed rows: the old state as a
tracked-deleted copy, the merged state as tracked-inserted; the `vMerge` continuation left headless
after accept/reject is repaired by position (`repairMerges`). The bookmark start/end in rows are
moved to the table level, before/after the changed rows: if left in the row they would vanish on
accept or reject (the name is unique, and Word drops the second copy); at the table level they
remain in both cases but cover the changed rows instead of the cell text. For a comment whose anchor
is in the rows, a twin is made (a new id; the `commentsExtended` reply chain, the
`commentsIds`/`commentsExtensible` durable ids with a new paragraph/durable id) and the deleted copy
is bound to it: on accept the original, on reject the twin remains. Since Word's default view hides
the deleted row, the balloon appears once on the page, next to the cell text; Word's Reviewing Pane
lists both. A comment whose anchor is outside is moved to the table level like the start/end
bookmarks in rows (Word already widens a range that spills out of a table to the whole row, so the
scope does not change). A comment whose anchor drops on accept/reject is deleted with its records
from the parts (`#dropComments`; the reader takes the comment count from the part). Splitting
(`cell_split`, turns a merged cell into grid cells; the opened cell takes its format from the
nearest same-type non-merged cell in the same column, and the top/bottom border from its own row) is
written in tracked mode through the same path (`#replaceRows`). `table_insert_*` writes a Markdown
table as a new `w:tbl`: the template is the nearest body table in the document (table properties,
the cell/paragraph/run format of the header and body rows), or else the `docx_create` look; like
`docx_create`, an empty paragraph with no spacing is put after the table (not if the next block is
already empty), and it is also separated from a table before it. `table_delete` in tracked mode
deletes all rows as tracked; accept/reject removes a table left with no rows with `dropEmptyTables`.
The match is searched in the paragraph's accepted view (insertions included, deletions excluded);
since Word splits text into runs arbitrarily, the runs at the boundaries are split in two and the
format is copied to each part. Whitespace/quote differences are tolerated; if not found, the read
view's markers (`**`, `{++`, line-start `## `, `- `) are stripped and it is searched again. An
ambiguous match is an error without `all`, and edits are applied all or nothing. `track: true`
writes `w:ins`/`w:del` like Word's "Track Changes" (ids after the largest `w:id` in the document;
text inside someone else's tracked insertion is not wrapped, it is removed directly); if there is no
comment part, the part + relationship + content type are added. The schema order (rPr/pPr children)
is preserved, otherwise Word opens the document as "corrupt". Before writing, the tool opens the
result with its own reader; the card's diff is the read view's before/after `generateDiffString`.
The written path (`output` relative to the source's folder) comes from `editedFile` in
`create-tools.ts` for the permission gate, turn backup and output gate (`FILE_EDIT_TOOLS`:
`docx_edit`, `xlsx_edit`); an in-place edit does not go through the output gate like `edit`.

Generation: the `docx_create` tool in `docx-create.ts` takes Markdown, and `markdownToDocx` in
`docx-build.ts` converts it to Word with the `docx` library. The library's pitfalls are not taught
to the model, they are solved here: an explicit page size (A4/Letter, 2 cm margins), bullets/numbers
with a `numbering` definition (every numbered list starts at 1 with its own `instance`), table and
cell widths in DXA, shading `CLEAR`, and image size read from the file header and fitted to the
page. A missing/remote/unsupported image does not bring the document down; it becomes a placeholder
and a warning in the result. The relative name, permission class, output gate and turn backup are
shared with `pdf_create` (`FILE_CREATE_TOOLS` / `resolveCreatedFile` in `create-tools.ts`). Claude's
`docx` skill was not adopted: its license forbids copying and derivative work, and it depends on
pandoc/LibreOffice/Python.

## Excel reading, generation and editing

No package was added; the ZIP/XML layer is shared with Word (`ooxml.ts`). The model touches a cell
by address (A1).

Reading: `read` hands a `.xlsx`/`.xlsm`/`.xltx`/`.xltm` path to `readXlsxContent` in `xlsx.ts`. Each
sheet becomes a `## Sheet N: name` heading and a Markdown table with column letters and row numbers
(leading empty columns are trimmed, empty rows are skipped); a cell shows the cached value, with its
number format (dates ISO, percent, decimal, the accounting zero section). Formulas are collected
under the table in a `**Formulas:**` list, with the same formula shifting row by row gathered on a
single line (`D2:D4: =B2*C2`); the dependent cell of a shared formula is derived from the master
formula by shifting. Merged cells, tables, notes, hidden sheets and defined names are also written.
`offset`/`limit` apply to the output lines. The viewer (`files:read`) takes the same view up to 4 MB
and 500 rows per sheet.

Formula layer: `xlsx-formula.ts` scans references skipping text constants, table (`Tbl[Sütun]`) and
external workbook (`[1]`) references; shared formula translation, row/column insert-delete shifting
(like Excel: inserting inside a range grows the range, a single deleted cell becomes `#REF!`, a
range shrinks) and sheet rename are here. `xlsx-calc.ts` computes common functions (sum,
criteria-based, rounding, logical, text, lookup, date); for a function or mode it does not know it
returns `undefined` and that cell's cache stays as it is. Array (`t="array"`, dynamic `cm`) and data
table formulas are not computed, and their caches count as constant values. I/İ/ı case matching
depends on Excel's locale ("Çin" = "ÇİN" is correct in Turkish Excel): if English and Turkish
folding give different results, the comparison counts as not computable. A per-column "rows computed
from the start" marker reduces the edge count of formulas that look at a large range on every row
(`SUMIF(C:C;…)`, cumulative `SUM($B$2:B9)`) from rows × range to linear. On every write
`calcPr fullCalcOnLoad="1"` is set: Excel recalculates on open; the cache is written only so that
the read view and the preview see the correct value.

Generation: `xlsx_create` (`xlsx-create.ts`, engine `xlsx-build.ts`) takes sheets as row arrays.
Cell input is resolved in `parseInput` in `xlsx-write.ts`: `=` is a formula, `'` forces text, an ISO
date becomes a serial number, `12.5%` the percent format, and a number with a leading zero or over
15 digits stays text. Turkish formula spelling (`TOPLA(A1:A3;B1)*1,5`) is converted to the English
form in the file, and new functions are written with the `_xlfn.` prefix. If the first row is text
with no formulas it counts as a header (bold, fill, bottom border, freeze, optional filter); column
width is estimated from the content. A bad merge/range does not bring the workbook down, it becomes
a warning in the result; a formula error (`#DIV/0!` etc.) is also warned about.

Editing: `xlsx_edit` (`xlsx-edit-tool.ts`, engine `xlsx-edit.ts`) applies the actions `set`,
`clear`, `append`, `row_insert`/`row_delete`, `col_insert`/`col_delete`, `merge`/`unmerge`,
`format`, `sheet_add`/ `sheet_delete`/`sheet_rename` in order; if one fails none is written. A
single formula given to a range shifts like fill-down; a new cell takes the format of its row or of
the cells above; `append` carries on the last row's format and the trailing formula columns, and
grows a table and filter that end at the last row. A row/column operation first expands shared
formulas into cells, then shifts the formulas, merges, conditional format and data validation
ranges, defined names, tables (column list included), chart series (`c:f`), pivot sources, drawing
anchors, notes and VML note boxes in all sheets. An operation that deletes a table's header or all
its data rows is rejected; a deletion that covers the table entirely also removes the table.

Table removal: `table_remove` is like Excel's "Convert to Range": values and cell formats stay, the
table style's colors go. Structured references like `Tablo[Sütun]`, `Tablo[#All]`,
`Tablo[[#This Row],[Adet]]` are converted to A1 everywhere in the workbook (cell, conditional
format, data validation, defined name, the calculated columns of other tables) with
`replaceTableRefs` in `xlsx-formula.ts`: fields absolute (`$C$2:$C$9`), same row relative (`C5`),
from another sheet with the sheet name. A pivot source takes the range instead of the table name;
the query table part is also removed; a table bound to a slicer is rejected. On deletion (deleting a
row/column that covers it entirely, deleting a sheet that has a table) the same conversion is done
first, and the shifting turns references that fall into the deleted area into `#REF!`. Consecutive
removals walk the formulas once by the name index (`ad[` → cells); about 0.3 s per table in a 10 MB
workbook with 45 tables. `calcChain.xml` is removed on every write (if the old one stays, Excel asks
for repair). In the warning only the formula errors caused by the edit are shown: a cell that
already carries an error in the cache is not warned again even if it shifts, since it stays the same
in the node move. The tool opens the result with its own reader before writing; the card's diff is
the read view's before/after diff. The permission, output gate and turn backup are shared with
`docx_edit` (`FILE_EDIT_TOOLS`).

Verification: 229 real workbooks on the local disk were read; 211 of them were processed without
error with five edits (cell, row insert, column insert, `append`, format); 20 opened in Excel with
no repair, and in two edited workbooks the cached values of 2,444 formulas came out the same as
Excel's calculation. Table removal was tried on a workbook with 83 tables; in four workbooks the
Excel results of 10,681 formulas, including 2,919 with table references, were the same as the values
before the conversion.

## Plan tools (`plan_enter` / `plan_exit`)

`packages/agent/src/plan-tools.ts`: Claude Code's EnterPlanMode / ExitPlanMode pattern. The tools do
not know the Pi session; they work through the `PlanBridge` the engine provides (`mode` / `planPath`
/ `enter` / `review`) and enter `customTools` in every mode if `plansDir` is defined. `plan_enter`
writes the previous permission mode to `LiveSession.planReturnTo` with `CodezalEngine.#enterPlan`,
opens the plan folder and puts the session in Plan; `plan_exit` reads the plan file and gives it to
`PlanReviewGate` with `#reviewPlan`. The gate is the plan counterpart of `PermissionManager`: it
emits a `plan_review` event, the decision returns through the `plans:respond` IPC, pending ones are
rejected on `abort` and on close; in an unattended session (`isUnattended`) it is rejected without
showing a card, with the `permission.unattended` feedback. On approval the session returns to
`planReturnTo` ("Ask" for a manually entered Plan) and the `permission_mode` event updates the
renderer chip; the model reads the tool result and moves on to implementation in the same turn. On
rejection the feedback returns to the model with the tool result and the mode does not change.
"Cancel" on the card (`cancelled`) abandons the plan: the session still returns to `planReturnTo`
and the turn is stopped (the stop is left to a microtask so that the result of the `plan_exit` tool
returns to Pi). If the user leaves Plan from the chip (`setPermission`), the stored return mode is
cleared. In the permission table both tools are in the read class; otherwise `plan_exit` would be
blocked in Plan mode. Renderer: `PlanReviewCard` shows the plan as Markdown;
`SessionRuntime.planReview` fills with `plan_review` and is cleared by the answer, `run_end` and a
non-waiting `status`.

## Question tool (`question`)

`packages/agent/src/question-tool.ts`: the model asks the user a multiple-choice question while
working; this is especially to clear up ambiguity before writing a plan or starting a large change.
The tool does not know the Pi session; it goes to `QuestionGate` through the `QuestionBridge.ask`
the engine provides. A `question_request` event is emitted, the answer returns through the
`questions:respond` IPC; pending ones on `abort` and on close are resolved with an empty answer per
question, and in an unattended session (`isUnattended`) an empty answer returns without showing a
card so the turn does not hang. The tool runs with `executionMode: "sequential"`: no other tool runs
in the same turn while a question is pending. `custom` (on by default) adds a free-text field for
the user; if there are no options, free text is mandatory. In the permission table it is in the read
class; it runs in Ask and Plan mode without asking for approval. Renderer: `QuestionCard`;
`SessionRuntime.question` fills with `question_request` and is cleared by the answer, `run_end` and
a non-waiting `status`.

## End-to-end tests

`pnpm test:e2e`: builds with electron-vite and opens `out/main/index.mjs` with Playwright
`_electron.launch` with a temporary `CODEZAL_USER_DATA` folder (it does not touch real data). Vitest
tests are under `src/**`, Playwright tests under `apps/desktop/e2e/`.
