# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow [SemVer](https://semver.org/).

## [Unreleased]

### Added

- **Codezal is open source** under the Apache License 2.0. See `LICENSE`, `NOTICE`,
  `CONTRIBUTING.md` and `SECURITY.md`.

### Fixed

- **Old tool errors stay in context**: the cheap context tier (microcompact) no longer replaces
  failed tool results with a placeholder, so the model keeps what it learned from the error.
- **No preset profile name**: new installs no longer greet the user with a hard-coded name; the
  greeting also updates when the name is cleared.
- **Help > Documentation** opens the correct repository.

## [1.2.0] - 2026-09-29

### Added

- **Word documents can be read and written**: `read` opens `.docx`/`.docm`/`.dotx`/`.dotm` files
  without any package and returns headings, lists, tables, links, headers/footers,
  footnotes/endnotes, comments and tracked changes as Markdown; `docx_create` takes Markdown from
  the model and works out page size, numbering, DXA table widths and image sizes itself. Until now
  the ZIP bytes were mistaken for text (`packages/agent/src/docx.ts`, `ooxml.ts`).
- **Editing Word documents with `docx_edit`**: text replacement, paragraph insertion/deletion,
  comments, writing tracked changes and accepting/rejecting all of them; table row/column
  insertion and deletion, cell merging and splitting, table insertion/deletion. Formatting is kept
  when text is split across runs, ambiguous matches raise an error, and edits are applied
  all-or-nothing; comments, bookmarks and vertical merges stay consistent after accept/reject.
- **Documents created at the end of a turn appear as cards**: under the last message, a file icon,
  name, type line and an "Open" button; no card is drawn for a file that is not on disk (md, pdf,
  docx, txt, csv, xlsx, pptx, html; at most 10).
- **Excel workbooks can be read and written**: `read` returns `.xlsx`/`.xlsm` files sheet by sheet
  as tables with column letters and row numbers (formatted values, formula list, merges, tables,
  notes, defined names); `xlsx_create` builds a workbook from an array of rows (Turkish formula
  syntax is translated, header formatting, freeze panes, filters), and `xlsx_edit` writes cells,
  inserts/deletes rows and columns, handles sheet operations, merging and formatting. Formulas,
  tables, charts, drawings and notes shift the way they do in Excel; formula values are written by
  the calculator and Excel recalculates on open. Validation: 229 real workbooks read, 211 edited,
  and 2,444 formulas in two workbooks produced the same output as Excel.
- **`xlsx_edit` can convert a table to a range**: `table_remove` removes the table like Excel's
  "Convert to Range"; structured references are converted to A1 ranges across the whole workbook,
  and the pivot source takes the range. The calculator was sped up with a per-column head pointer
  (10 MB workbook: 138 s → 28 s).
- **A separate model can be chosen for web summaries**: "Web summary model" under Settings > Usage
  & model; the list is sorted by the estimated cost of a typical summary call (≈8k input + ≈700
  output tokens) and the label shows the input/output price. If left empty, or if the selected
  model has no key, the task's own model is used.

### Changed

- **Dependencies updated**: the Pi family as a single version 0.87.1, Electron 44.4.5, MCP SDK 2.1,
  and the latest zod, React, Biome and Vitest; obsolete age exceptions were removed. Since context
  comes from `SessionManager` in Pi 0.87, the error message is dropped with `appendContextEdit`
  when resuming after a transient error.
- **Web content in unattended task runs is summarized by a separate model**: pages and search
  results are not handed raw to the main agent; a separate tool-less model call writes a summary
  with source links; if no summary can be obtained, it does not fall back to the raw result but
  returns an error.
- **Floating boxes show the quota of the selected provider**: the windows, remaining credit and
  balance belonging to the session model's provider are refreshed when a turn ends.

### Fixed

- **The signed macOS build was failing the release**: the native modules shipped with Pi 0.87.1
  come with an ad-hoc "linker-signed" signature on macOS; osx-sign could not re-sign them with a
  timestamp and failed with "A timestamp was expected but was not found", so the release step never
  started. After packaging these signatures are stripped and the files are signed through the
  normal path with the hardened runtime (`build/after-pack.cjs`).
- **The `pdf_create`/`docx_create` card carries the path the tool wrote**: a relative name is
  resolved against the output folder in Assistant, but the UI joined the raw target onto the
  working folder; the card and the Outputs box showed the wrong path and the document card was
  never drawn (`resolvedTargetOf`).
- **The Outputs box scrolls internally on a long list**: the box scrolls instead of stretching the
  page.
- **Calendar tools reject an invalid date with a clear error**: if `timeMin`/`timeMax` cannot be
  parsed, the error names the field, the given value and an ISO 8601 example instead of a bare
  `RangeError`; a reversed range is rejected before any request is made.
- **The "New" and "Scheduled" rows in the sidebar shrank to the session-row scale**.
- **OpenCode Go's short quota window is shown as "5 hours"**: the endpoint calls this window
  "rolling"; according to the docs its length is 5 hours.
- **Duplicate `dangerous`/`fromAgent` keys in the permission texts were removed**.

### Security

- **The `web_fetch` connection is pinned to the checked address**: the name is resolved once, all
  addresses are checked, and the request goes only to those addresses via the `node:http(s)`
  `lookup` option (DNS rebinding closed, no new package). The address list was extended:
  `192.0.0/24`, TEST-NETs, `198.18/15`, `224/4`, `240/4`, IPv4 embedded in 6to4/NAT64, local NAT64,
  Teredo, documentation range, `ff00::/8`.
- **`web_fetch` and `web_search` ask for approval in Ask and Plan modes**: the card shows the full
  address or the query and the scope; "Always allow this session" is granted per domain/for
  searches. The agent can no longer carry data it has read out of the machine by putting it in a
  query.
- **Web content arrives in an untrusted block**: invisible and tag characters are stripped, and
  instruction patterns are counted without deleting the line and written into the warning.
- **Data exfiltration commands are treated as dangerous**: piping into a network tool,
  `curl -d @/-T/-F`, `wget --post-file`, command output embedded in the address, `/dev/tcp`; they
  are rejected in unattended tasks.
- **An unattended task run cannot change tasks**: creating, changing and deleting tasks with
  `schedule_task` is disabled and only listing is allowed; an instruction on a page could set up a
  persistent new task in Full access.
- **`web_fetch` follows only same-site and `http`→`https` redirects**: on a redirect to another
  site the address is returned to the model and the retried call falls under the domain approval.
- **"Can search the web" permission (`allowWeb`) for scheduled tasks**: in Ask/Plan mode the web
  tools pass without asking for the duration of the run; it is shown in the window, in
  `schedule_task` and on the approval card.

## [1.1.0] - 2026-09-28

### Added

- **`/interview` (`/görüşme`) command**: switches to plan mode before implementation, asks at
  least three rounds of questions with the `question` tool, writes the answers into the plan file
  as a specification and submits it for approval with `plan_exit`; the request is clarified before
  any code is written (`SLASH_COMMANDS`, `prompt.interview`).
- **Scheduled tasks on their own page**: the "Scheduled" entry in the sidebar (with the task
  count) opens all tasks, independent of project, in a single grid; search, "Next run / By name /
  Last run" sorting, the "New task" menu and six ready-made template forms pre-fill it. The task
  list was bloating the home screen; the duplicate list was removed
  (`asistan/AsistanScheduled.tsx`).

### Changed

- **Description and system prompt are comfortable to write in the agent form**: the description
  moved to a multi-line field, the system prompt can be edited in a large window via the corner
  button; the scope options name the project as "All projects / Only <project>". A long system
  prompt could not be written in the narrow card (`settings/pages/AgentsPage.tsx`).
- **Opened chats are bound to a memory limit**: the transcripts of the last 20 sessions are kept in
  memory and the rest are rebuilt from the `sessions:open` snapshot; sessions carrying a running
  turn, a pending card or a subagent are never dropped (memory was bloating during long runs).
- **Search stopped folding Turkish case**: Settings and ⌘K searches use `matchesFold`; "OpenAI" no
  longer becomes `openaı` and fails to match.

### Fixed

- **Local file leak into PDF closed**: via `<iframe>`/`<object>` in the model's HTML, file text
  could be printed into the PDF through a `file://` path; the PDF window now runs in a separate
  session with a filter, and local resources are blocked through frames/objects (`main/pdf.ts`).
- **In a turn that continues after a nudge, work flows under the old report**: when hidden nudges
  such as background completion resume the turn, the new steps piled on top of the old interim
  report and the "Thinking" row stayed above the report; while the turn is running, the part after
  the report is now kept separate (`lib/turnRuns.ts`).
- **The counter shows the right time while a turn runs**: the live duration now runs from the start
  of the section after the last interim report; the time before the report was being counted twice,
  both in the collapsed list and in the counter (`liveSegmentStart`, `findLiveRows`).
- **Scheduled tasks no longer run twice, and a deleted task does not come back**: the current
  record in the store is read before a task starts; writing the result does not recreate a record
  deleted during the run.
- **A corrupt settings/task file no longer wipes data**: invalid JSON is backed up as
  `*.corrupt-<time>.json` and the intact fields are recovered; writes are atomic
  (`main/store.ts`).
- **Stop also works during a retry wait**: while waiting in backoff after an error, Stop now really
  ends the turn; a shell process that does not close is escalated to SIGKILL.
- **Esc closes only the topmost layer**: a single press no longer closes the confirmation dialog,
  menu, lightbox, Settings and the running turn together; unsaved form content is preserved
  (`lib/escapeLayers.ts`).
- **"No projects yet" no longer shows at startup before the list arrives**: a loading state is
  shown while projects/sessions load, and a "Retry" row on an IPC error.
- **The update card no longer disappears**: while a download was in progress or an update was
  ready, the check status dropped to `checking`/`available` and hid "Restart".
- **The "Max" thinking level is read back correctly**: because the `max` level was not mapped, the
  chip showed "Low".
- **The keep-awake counter is bound to the session**: the machine no longer stays awake even if the
  `run_end` of a session deleted during a turn never arrives.
- **Closed terminal processes no longer linger orphaned**: a process that ignores SIGHUP gets
  SIGKILL after 1.5 s; on shutdown, MCP connections and child processes are awaited.
- **Crash in Google Drive search**: `typeOf("constructor")` walked the prototype chain and crashed
  the query; non-type values are ignored.
- **The unsigned macOS build can be opened**: the fuses modify the Electron Framework binary, so it
  died with "Code Signature Invalid" on Apple Silicon; the build is re-signed ad hoc.

### Security

- **The permission gate resolves paths like Pi**: escape from the trusted root (memory, plan) via
  `..` and symlinks, and the misleading target on the approval card, were closed
  (`packages/agent/src/permission.ts`).
- **Credential files are protected**: `keys.json`, `auth.json`, `mcp.json` and their `.tmp` copies
  are not read or written in any permission mode; a `grep` that covers these files asks in every
  mode.
- **Dangerous command detection was strengthened**: `bash -c`, `\rm`, the `$(…)` subshell,
  `sudo`/`env` wrappers, `git push +refspec`/`-f`/`:branch`, `git branch -D`, `git restore`,
  `find -delete` and PowerShell `-Recurse -Force` now produce a warning
  (`packages/agent/src/tool-info.ts`).
- **`web_fetch` rechecks the address after a redirect**: the name is verified against all resolved
  IPs (loopback/private/CGNAT/IPv4-mapped IPv6), the response is truncated at 5 MB, and provider
  keys in error text are masked.
- **External links are `https:` only**: opening `file:`/custom schemes via `shell.openExternal` was
  blocked (loopback `http:` is allowed for the local OAuth return).
- **`codezal-file` was hardened**: SVGs are served with a CSP that disallows scripts and with
  `nosniff`; requests with an `http(s)` referrer coming from the embedded browser return 403.
- **The packaged binary was tightened**: the `runAsNode`, `NODE_OPTIONS` and `--inspect` fuses are
  off; `CODEZAL_USER_DATA` and `CODEZAL_DEBUG_PORT` are read only in unpackaged builds.
- **The `schedule_task` approval card shows the permission**: if permission is not granted, the
  card states that the task runs with full access and shows the content of the prompt.

## [1.0.9] - 2026-09-26

### Added

- **Background commands and agents in a single status card, as in ZCode**: the separate Agents and
  Background cards in the floating panel became a single card with "Terminals" and "Agents"
  sections. Both sections use the same row: title, an "N running for" counter and Stop. The badge to
  the left of the composer shows the number of running commands and agents. New channels:
  `background:list`, `background:output`, `background:stop`.
- **Background tasks in the right panel, as in Claude**: clicking a row in the floating card opens
  the task in the "Background tasks" tab of the right panel. The list consists of "Running" and a
  collapsible "Finished" section; each task is a card: title, type · status · duration, token and
  tool usage, a "View transcript" / "View output" link and Stop on a running task. Finished ones
  are cleared with the trash icon. The card opens the detail in the same tab; the back arrow
  returns to the list. The agent detail shows the model row, the task prompt in a bubble, the tool
  steps and the agent's report; the command detail shows the command and the live output
  (scrolling up stops following, "Jump to bottom" resumes it). "All tasks" under the card opens the
  list.
- **The title of a background command is a short description**: `bash_background start` accepts an
  optional `description` field ("Summarize the repo"); the card, the floating box and the detail
  title show it, while the full command stays in the bubble in the detail and in the tooltip. For a
  command without a description, the title is the one-line form of the command. `description` was
  added to `BackgroundJob` and the `background_start` event.
- **Right-click menu in the file tree and search results**: right-clicking a row offers open, open
  in the default app, reveal in Finder, copy path and copy relative path (`panel/FilesTab.tsx`);
  copying to the clipboard is done from the menu.

### Changed

- **Design review fixes**: the chat body became denser (line height 1.75 → 1.5, normal letter
  spacing, 12px between blocks); tool and "Thought" rows share one rhythm. Status colors moved to
  the diff family (green/red on the light theme now pass 4.5:1 contrast), the "error" text of a
  failed tool row is red, and the "Full access" chip is in the warning color. The faint text token
  (`--tx3`) passes WCAG AA in both themes.
- **Sidebar groups**: project and folder headings use the same faint label as "Pinned"; the
  "Projects" label is gone, and adding a folder/project sits next to "New". Assistant projects
  without sessions and the empty "Sessions" group are hidden. Chat rows became denser.
- Change counters state their scope ("44 uncommitted", "3 files changed this turn"); the composer
  has the same width as the chat column; the inline code chip lost its border.
- **The environment card shows line changes**: instead of the number of uncommitted files in the
  header, the total of added/removed lines is shown (like `+120 −8`); the file count stays in the
  tooltip.

### Fixed

- **The screen no longer hangs on "Loading…" when the open chat is deleted**: when the open chat is
  deleted or archived from the sidebar, the chat menu or by bulk selection, the chat right below it
  in the same section (or above it if none) is opened; if no chat is left in the section, it
  returns to the home screen.
- When a turn that started a background command ended, its steps were folded under a "ran for X s"
  heading; the row that started the command looked like it had vanished from the chat. These turns
  now stay open.

### Removed

- **Unused design mockups were deleted**: the `design/` folder in the repo (`Codezal.dc.html` and
  `support.js`, ~4,100 lines) was removed; no code referenced the files, they only sat in version
  control.

## [1.0.8] - 2026-09-23

### Added

- **Agents can run in the background and in their own worktrees**: the `agent` tool gained
  `background` and `isolation` options. A background run does not block the main chat; the main
  chat relays the result itself when it finishes. An agent that modifies files is moved into its
  own worktree when it runs in the background or in parallel with another writing agent; its
  changes are decided at the end of the chat from the review card (like the permission card) or
  from the Agents tab with Inspect / Apply / Delete. An agent definition can carry these behaviors
  by default (Isolation and Run in background in the Settings > Agents form). The number of
  concurrent agents and the permission mode of worktree agents are chosen under Settings > Agents >
  How agents run. The model tracks runs with `agent_list`, `agent_message` and `agent_stop`; the
  permission card of a detached run appears in the main chat as a separate card stating which agent
  it belongs to (it does not override the main chat's own approval). A single subagent can be
  stopped from the Agents tab. The concurrent agent limit is the total of held and detached agents.
  Worktree branch names are ASCII only (`ajan-bol-js-hatasini-duzelt-…`). Permission cards arriving
  at the same time do not override one another; when a session is reopened (opening the panel, an
  event gap), pending permission, plan and question cards come back, and an agent does not hang
  while waiting for an invisible approval. The changes of a stopped or timed-out worktree agent
  fall into review; the worktree of one that leaves no changes is deleted. The model cannot turn
  isolation off (`isolation` takes only `worktree`; in a trial it passed `none` on every call to
  escape approval); if the main folder has uncommitted changes, automatic isolation is not applied,
  because the worktree cannot see them. The permission card of a held subagent also states which
  agent is asking. In the review card the first button is Inspect, and Apply/Delete unlock a short
  time after the card appears: while giving approvals in succession, a new card slid under the
  cursor and was applied by accident. The card appears under the reply when the main chat's turn
  ends; while the turn is running, the run shows as "in review" in the Agents box.
- **"Open in…": open the project in an external app**: a split button was added to the top bar of
  the session; the left side opens in the last used app, the chevron opens a menu of installed apps
  (file manager, editors, terminals). Detection happens in main (`open-with.ts`: macOS `.app`,
  Windows known paths, Linux PATH), and an app that is not installed does not appear in the list.
  Icons are taken on macOS from the bundle's own `.icns` resource and on other platforms once via
  `app.getFileIcon` and cached (`getFileIcon` is not preferred because it returns a generic icon on
  Mac); if one cannot be obtained, the row is drawn with a glyph and does not drop out of the menu.
  The last choice is stored in the `openWithApp` setting. Opening is done without a shell and does
  not wait for the app to quit: `open -a` on macOS (`open -n -a … --args` for terminals that take
  the directory as a flag), a detached process on other platforms; on Windows only `.exe` counts
  (`.cmd` cannot be launched without a shell). Command paths do not go to the renderer
  (`openWith:list`, `openWith:open`).
### Changed

- **Exploration is now the `explore` agent**: the separate `explore` tool was removed; the model
  hands exploration to the `explore` agent through the `agent` tool. The exploration model can be
  chosen under Settings > Agents, and the task text limit is 8000 characters instead of 2000 (a
  long task was giving a validation error).
- **The macOS installer window was reworked**: the DMG uses its own background instead of
  electron-builder's generic template (540×380, icons in the lower half): the cube texture from the
  app at the top, a Codezal → Applications arrow in the middle, a "drag" caption at the bottom. The
  window is 600×352 and the title bar allowance is accounted for, so no gap is left at the top.
  Hidden files (`.background.tiff`, `.VolumeIcon.icns`) are placed below the window; they are not
  lined up between the icons when Finder shows hidden files. The image is produced with
  `scripts/dmg-background.mjs`.
- **The browser opens with codezal.com**: if there is no saved page (first launch, an empty or
  `about:blank` address), the embedded browser opens `https://www.codezal.com` instead of
  `localhost:3000`; a saved page is kept as is.
- **The Files panel was simplified**: the colored folder icons were removed from the tree; a folder
  is drawn only with an expand arrow and a file with a single-color gray type icon (the icon sits in
  the arrow's slot, no empty column is left). Rows are 26px and 13px, a child's icon aligns with the
  parent's name; a change appears as a letter on a file and a dot on a folder. Search moved above
  the tree and is also used while a file is open (Esc clears it). In the header the path is written
  as a breadcrumb with faint folders and a prominent file name. The selected row is visible on the
  light theme too; the tree is 200px by default and expands to at most 420px.
- **Slash commands as in ZCode**: the composer moved to the Lexical editor. Typing `/` makes the
  composer grow upward and take the panel inside it (a single card), and removing the `/` returns it
  to its old state with the same animation; a row shows only `/name` and the description, results
  are ranked by score (prefix > substring > letter order) and split into Commands / Skills /
  Templates sections. ↑↓ navigates, Enter or Tab selects, Esc closes. A selected command, skill,
  file mention and a long paste become a single-unit **tag** in the box (deleted with one
  Backspace). The panel opens only with a `/` at the start of the message: commands and Pi skills
  work only at the start.
- **Command names are English**: `/help`, `/ask`, `/audit`, `/mode`, `/effort`, `/new`, `/resume`,
  `/skill`; descriptions stay Turkish. The old Turkish spellings (`/yardım`, `/sor`, `/denetim`,
  `/mod`, `/düşünme`…) keep working as aliases and keep being found in search.
- **The `+` button adds context only**: files, folders, images and connectors; commands and skills
  moved to the `/` panel.
- **The user bubble shows what was typed**: the instruction sent to the model, the Pi skill body and
  the read list are not drawn in the bubble; command and file tags appear instead. Copy, rewind, the
  turn bar and the session title also use the typed text (old records are recognized too).
- **Coding | Assistant tabs in the sidebar**: mode selection became a segmented tab like in Claude
  desktop, with a "New" button under it in both modes.
- **Settings tabs moved to a segmented view**: the tabs that split the page moved to the new
  `SegmentedTabs` component (Connection, Memory, Usage, Diagnostics); the selected segment rises
  within a gray rail and does not disappear on a white background on the light theme (`--sel` is
  white on the light theme). Filter pills remain as `Tabs`, and the selected pill gained a thin
  border (`settings/list.tsx`).
- **The Connectors page was split into Connected / Ready tabs**: long connected lists were pushing
  the catalog to the bottom of the screen. If there is no connected connector the page opens on the
  catalog, and the tab does not change when the first connector is added; in the catalog an added
  connector does not drop off the list but stays with an "Added" button, and "View in connected" in
  the notification returns to the list. The "Add connector" title became "Add custom connector".
- **Actions on the Skills page were put on a single strip**: search on the left, refresh/open
  folder/add on the right; the description was wrapping to two lines when in the section heading.

### Removed

- **Task groups**: the Settings > Task group page, the group section in the sidebar, the
  coordinator session, the `worker_*` tools, group memory and the group board were removed; the same
  work is done in every chat with the `agent` tool. Old `task-groups/` records are not read.
- **Skills > Templates and Packages**: the page shows only skills and source folders. Pi prompt
  templates (`/name` commands, the Templates group in the `/` panel) and the npm/git package
  install/update/remove path (`skills:installPackage`, `skills:removePackage`,
  `skills:updatePackages`, `skills:progress`) were removed. Packages were a leftover gate of the
  removed extension surface; all 6 templates the user saw now came from the `pi-subagents` package,
  which called the no-longer-existing `subagent` tool.

### Fixed

- **A success notification can carry an action**: `toast.success` gained a second action parameter
  (`stores/toast.ts`); the notification shown when a connector is added takes you straight to the
  connected list.

- **A pending card vanished when a chat that had run in the background was opened**: the event of an
  unopened chat (e.g. an agent run that finished after the window was refreshed) set up a partial
  state; when the chat was opened this state was counted as "already open" and the record was not
  loaded: empty transcript, no permission card, the agent waiting for an invisible approval. An
  event of an unopened chat now only updates the list.

- **A removed package was reinstalling itself**: when Pi's resource loader finds a package in the
  settings file missing, it installs it from npm without asking. In 1.0.7 the `pi-subagents` files
  had been deleted but its entry in `settings.json` remained; the first session downloaded the
  package again. Session loaders and the Skills catalog now work with a settings view that sees the
  package list as empty (`withoutPackages`), and prompt templates are not loaded either
  (`noPromptTemplates`); a package entry in the user's or a trusted project's `.pi/settings.json`
  installs nothing.

## [1.0.7] - 2026-09-22

### Added

- **Assistant reply preview in the turn bar bubble**: when hovering over a user query in the turn
  bar on the right edge of the chat, the bubble now shows not just the query but also the first
  paragraphs of the assistant's reply to that turn. The summary is trimmed to at most two
  paragraphs and 220 characters (`...`); if the reply has not arrived yet, it says separately that
  the turn is still running. The derivation is tested as a pure function in `lib/turnPreview.ts`
  (same semantics as ZCode's turn navigator).
- **A long command does not lock the turn**: the `bash` tool was wrapped under the same name
  (`bash-tool.ts`); a command that exceeds 90 seconds is moved to the background automatically and
  its result returns to the model via a hidden nudge when it finishes. A command is **never started
  twice**: if it finishes within the window, Pi's normal result arrives (output, exit code,
  truncation, the temp file with the full output); if the window is exceeded, the same process
  becomes a background job and appears in the Agents box. Commands that verify one's own changes
  (typecheck, lint, test) stay in the foreground; moving to the background is disabled in
  unattended (scheduled) sessions. `timeout` cuts in the foreground, and if the command was moved to
  the background, it is the final deadline of the job; cutting the turn does not kill a background
  job.
- **Background output and the polling rule**: truncation is not silent: the completion notice and
  the `output` action state the original character count and how to read the stored tail; a task
  whose time ran out is not counted as "stopped by user", it is reported with a separate note. A
  rule was added to the prompt texts (tr + en): "do not poll background work with `sleep`, `ps`,
  `pgrep`, `top`; either move on to other work or finish your reply".

- **Commands work as in ZCode**: the `/` panel now reads the catalog from a single place and
  **filters as you type** (the query comes from the composer; the panel has no separate search box);
  local commands run immediately on selection and are not written into the draft. The catalog:
  `/yardım`, `/model`, `/mod`, `/düşünme`, `/compact`, `/beceri`, `/mcp`, `/yeni`, `/geçmiş`,
  `/init` + existing shortcuts. Command names are written per language (`/yardım` ↔ `/help`,
  `/denetim` ↔ `/audit`) but both resolve to the same command; arguments can be written by id
  (`/mod plan`), by ZCode's name (`/mod yolo`) or by the name shown in the UI
  (`/düşünme Yüksek`).
- **A marker row in the chat for command results**: since `/model`, `/mod`, `/düşünme` and
  `/compact` do not go to the model, there was no user bubble in the chat; their results now appear
  as a single row between two thin lines ("Model · Opus 4 → GPT-5", "Context summarized"). Markers
  are written to `sessions/meta.json` and, when the session is reopened, are merged into the
  transcript in time order; only identifiers are stored, not translated text, so they read
  correctly even if the UI language changes.
- **Command screen (`/yardım`)**: a searchable screen listing commands with their usage and
  description; runnable rows run with one click. The desktop counterpart of ZCode's `/help` output.
- **The command gate also applies on entry screens**: for a user who types `/yardım` or `/geçmiş`,
  no empty session is opened and no "provider not connected" error is shown; the command runs
  before the provider/project checks.
- **Rewind and branching carry markers too**: marker rows after the rewound point are dropped from
  the chat **and** from the record (the traces of the branched-off part do not come back); a
  session branched from a point takes with it the markers that fall in the copied range. Before,
  markers stayed only in the live chat: after a rewind they vanished, and on reopening the rows of
  the dropped branch came back.

- **Multiple terminals in the panel**: instead of a single "Terminal" tab, each terminal opens its
  own tab in the panel strip ("Terminal 1", "Terminal 2"…); added with "New terminal" from the
  palette and the empty-state tiles, and ⌘J brings the project's open terminal to the front. Tabs
  are independent shells (work continues in one while another keeps a long job running), and closing
  a tab kills only its own shell; the tab of a dead shell is drawn faint. Tab names come from the
  sequence number and a freed number is given to a new terminal; the terminal tabs in
  `stores/panel.ts` are not persistent (there is no shell after a reopen).
- **Two-tier context management**: long sessions are now compacted **ahead of time** once the fill
  threshold is exceeded, not only after an overflow error; before that, a cheap tier kicks in and
  the bodies of old tool results are turned into a placeholder in the copy sent to the model (the
  session file and the UI are unaffected). New file: `packages/agent/src/microcompact.ts`; the
  ahead-of-time compaction threshold is `AUTO_COMPACT_PERCENT` in `engine.ts` (85%). With the old
  behavior the user waited after getting a "context full" error; now the turn starts with a summary.
- **Tool result budget**: tool output sent to the model is capped at 40k characters and the
  truncation is reported with a **machine-readable** marker (original length + strategy). Pi's
  built-in tools truncated their own output; Codezal's tools, especially remote MCP connectors, were
  unlimited and could return megabytes in a single call. New file:
  `packages/agent/src/tool-budget.ts`.
- **Prompt history in the composer (↑/↓)**: the last 50 prompts are stored per project; in a
  multi-line box it kicks in only when there is no line above/below the cursor, and at the end of
  the list it returns to the draft being typed. New file: `lib/promptHistory.ts`.
- **Tool card open/closed state is preserved**: when a diff or command output is open and you
  switch to another session and come back, the card stays open (`lib/toolCardOpen.ts`).
- **Search is independent of Turkish/English spelling**: `lib/searchText.ts` folds in both
  directions (`IPC`/`ıpc`/`İpc`/`ipc` collapse to the same key). Because of the previous
  `toLocaleLowerCase("tr")`, abbreviations like `ipc`, `ui` and `ide` returned no results.
- **The search card says which route it searched by**: the `details.endpoint` field of the
  `web_search` result is carried as `ToolCallItem.searchBackend` and shown on the card as
  "Built-in search · N matches" / "DuckDuckGo · N matches". When the provider did not support
  built-in search (e.g. models using the Chat Completions API), the tool silently fell back to
  DuckDuckGo and the output of the two routes looked the same on screen: which search ran could only
  be read from the session records.

### Changed

- **The panel opens in two ways**: the `+` button opens it with the panel's own search box
  (including context rows), while the `/` key opens it by reading the query from the composer.
  Labels are written with ZCode's section names ("Commands", "Skills", "Templates") and a keyboard
  hint row sits at the bottom of the panel.
- **`/goal` is now caught at the store layer**: the command used to be handled only on the session
  screen; it was moved to a single gate so all three screens get the same behavior.
- **`/compact` takes no arguments**: extra text is not silently swallowed; it returns an error
  stating how the command is used.

- **Inline code in chat text is now real monospace and a thin chip**: the code chip is now drawn
  with `--font-code`. Before, it used `--font-mono`, which is the UI's sans stack: code could not be
  told apart from body text and looked like a gray button with a 10px radius and wide padding
  (especially long file paths). The radius dropped to 4px, the padding to 4px/1px, a `border-line`
  border was added to the background; letter spacing was separated from the body's wide spacing
  (`components/Markdown.tsx`, `CODE_CHIP`).
- **Links and clickable file paths are blue**: `--link` / `--linkHov` tokens were added to the
  palette (dark `#6cb6ff`, light `#0969da`; `packages/ui/src/tokens.css`) and every clickable text is
  written in this color. Before, a link had the body color and was set apart only by a faint
  underline: inside a long reply it was not clear it was clickable. The underline starts fainter
  than the text color, and on hover the text and underline darken together. Blue has a single
  meaning: "this is clickable" (docs/DESIGN.md §3).
- **The file path chip is no longer a chip**: clickable paths are no longer in a gray box but are
  written like a link (blue + faint underline, `LINK_TX`). Putting blue text on a gray background
  carried two opposing signals; the user saw the hand cursor and read it as "blue but a box".
  Clickable text (file paths and links) is written in the body's font and size: blue text sits
  inside the sentence and must not look like a separate layer with its own typeface. Code chips
  remain monospace gray boxes: **gray chip = code, blue + underline = clickable**.
- **The sidebar shows 5 chats per group**: the default visible chat limit went from 8 to 5; the rest
  are collapsed behind a "show" row (`lib/sidebarLimit.ts`).

### Removed

- **The Design module was removed entirely**: the Design tab in the sidebar and the whole module
  behind it were deleted — screens (`screens/design/*`, `shell/DesignSidebar.tsx`), the store
  (`stores/design.ts`), main modules (`design-{server,system,export,templates}.ts` and their tests),
  the `resources/design-templates/` templates and the `electron-builder.yml` entry, the `design:*`
  IPC channels and the `design:server` event, `design` from `AppMode`, `DesignKind`,
  `SessionMeta.designKind`, the design icon in `icons.ts` and the design keys in `tr.ts`/`en.ts`.
  App modes were reduced to two, Coding and Assistant; the system prompt, the permission table and
  the tool sets recognize only these two modes (`docs/ARCHITECTURE.md` and `README.md` were
  updated). The module was unused and every surface of it carried a maintenance burden.
- **Old design sessions are archived**: an unrecognized mode record is clipped to coding and the
  session is archived — not visible in the sidebar and in search, the chat file is not deleted
  (Settings → Archived tasks); archived sessions are not counted in the home page statistics.


### Fixed

- **Addresses written without a scheme were mistaken for file paths**: text like
  `releases.electronjs.org/release/v44.0.0` was counted as a "path" because its last segment has a
  dot (`v44.0.0`) and was drawn as an "Open file" button; clicking it tried to open a local file
  that does not exist. Text whose first segment is in domain form (`electronjs.org/blog/…`) is no
  longer counted as a path (`lib/mentions.ts`, `HOST_SEGMENT`); intermediate folder names like
  `desktop.v2/src/a.ts` are not affected.
- **"Undo" was undoing the wrong turn (data loss)**: the turn record was one per session and was
  overwritten on every turn; undoing an old turn erased the work of the **last** turn and left the
  changes of the requested turn in place. The record is now sealed per turn
  (`main/turn-backup.ts`) and undo touches only that turn's files.
- **Wake-up and session cleanup when agent output finishes**: background processes of a deleted
  session are killed, the extension bridge/audit session/nudge counters are released; MCP extension
  subscriptions are dropped when a session closes (`dispose` did not emit `session_shutdown`).
- **"Stop" lost during subagent setup**: if the cancellation signal fired before the listener was
  attached, the run continued to the end; it is now also checked at attach time and the turn is
  never started.
- **The scheduler was running the same task concurrently**: when a run took longer than the
  interval, a second turn started; a running task is not restarted and the schedule is computed from
  the end.
- **The first message of a new session could be lost silently**: if the send is rejected, the bubble
  is withdrawn and the error is reported (before, it only went to the console).
- **Memory buildup**: the session event buffer, design version thumbnails, background task records
  and worker results were bounded; they are all released when a session is deleted.
- **"Always allow this session" is now bound to the target**: permission was stored only by tool
  name, so an approval given for one file let all later operations with the same tool through
  (including writes outside the project).
- **`web_fetch` redirects are revalidated**: only the first address was checked; a public address
  could redirect with a 302 to a local service and have its body read (SSRF).
- **The main window loads only its own document**: the `file:` prefix was enough, and an HTML file
  dropped onto the window could take over the preload bridge (file writing, terminal).
- **The MCP tool catalog is not written into the system prompt**: names/descriptions coming from a
  remote server were in the highest-trust position; they are now given as an undrawn user message.
- **Header injection in a Gmail draft**: line breaks in the `To`/`Cc` fields could add a hidden
  recipient (`Bcc`); control characters are stripped.
- **An API key is given only to a `secret` prompt**: `text` prompts were also being answered with
  the key, and on providers like Cloudflare/Bedrock/Vertex the key was written into the wrong field.
- **Dangerous command detection**: `rm -r -f`, `rm --recursive --force`, `git clean -d -f` now
  produce a warning (before, only the combined `-rf` was caught).
- **Absolute paths on Windows**: turn file rows and the design sidebar were joining and corrupting
  `C:\...` paths; the plan file row never appeared because of the separator.
- **File badges did not appear outside the root on Windows**: `relative` produces `\` while git
  produces `/`.
- **Changes tab**: with fast file switching a late-returning diff was drawn under the wrong row;
  `git:changed` arriving while a run was in progress was swallowed.
- **Files that could not be undone**: `git restore --staged --worktree` is used (`checkout`
  silently dropped on a staged file).
- **The end-of-turn check hung on timeout**: if the process ignores the signal, the result is still
  returned.
- **Audit integrity**: invalid candidates in hunter output no longer count as an "empty result"
  (the unit was wrongly marked "covered"), the **content** of a dirty working tree goes into the
  source stamp (two different dirty states are not counted as the same), a budget override cannot
  raise the profile limit, and the run folder is reserved with `mkdir` (concurrent audits were
  overwriting each other).
- **Turkish lowercasing is not fixed**: in the English UI, "ImageGen" in the group summary became
  "ımagegen".
- **The MCP tool catalog is not re-added every turn**: as long as pending tools were not loaded, the
  same few kilobytes were written into context every turn; it is now sent only when the catalog
  changes.
- **After a rewind, "Undo" targets the correct turn**: when the branch is cut, the file records of
  later turns are dropped too (otherwise it would land on the record of a deleted turn).
- **Prompt history preserves pastes**: while navigating with ↑/↓, the real content of a long paste
  and the images come back; before, the placeholder text was sent.
- **Deleting a task group asks for confirmation**: the "Delete" button deleted the group, workers
  and worktrees (including uncommitted changes) with a single click; it now asks for confirmation
  like other destructive actions.
- **The suggestion in the commit window does not overwrite what is typed**: the message of a user
  who started typing while the model call took seconds was erased when the suggestion arrived.
- **The Files tab does not write a late response**: with fast file switching an old read was
  overwriting the content of the new file; search results were also bound to query order.
- **Escape closes a single layer**: with a confirmation dialog or menu open in settings, Escape
  closed both together and dropped the unsaved form.
- **If a settings and skill write fails, it is rolled back and reported**: the toggle stayed on
  while nothing had been written to the file (it looked like it "turned itself off" after a
  reopen).
- **Windows carry a focus trap** (`role="dialog"`, `aria-modal`, Tab cycles within the card);
  icon-only buttons were given accessible names (close window, close tab, close notification).
- **Tab carries focus in the model picker** (before, it switched panels and trapped the focus).
- **Quota numbers follow the locale**: the Turkish UI writes "65,3" (before, a dot).
- **Removing a skill source asks for confirmation**; deleting an agent from the agent form closes
  the form; the agent save toast shows the real confirmation text instead of the dialog title; the
  non-functional "⋯" button in the sidebar was removed.
- **Files that could not be undone are reported**: a file that could not be backed up because of
  the size limit is not skipped silently; a warning appears next to the "undone" message.
- **The audit repair turn also counts against the budget** and if the source list was trimmed, the
  report says so (before, the counter showed too little and trimmed files were counted as
  "covered").

- **Turn window in long sessions (virtualization)**: in chats over 150 turns, invisible turns are
  not rendered to the DOM and their places are held with **spacing** — the total height is
  preserved, so the chat's scroll anchor (`scrollAnchor`) does not drift. The window is written to
  state only when its bounds change (no render on every scroll frame) and turn heights are kept in
  an LRU cache. In chats below the threshold the behavior stays exactly the same. New file:
  `lib/virtualWindow.ts` (pure computation + cache, 11 tests); the component test verifies that in a
  300-turn chat only the window is drawn and in a 20-turn one nothing changes.
- **Manual context compaction (`/compact`)**: in a long session the user can summarize the context
  on their own request. The command is caught in the `sessions` store (it is an action, not prompt
  text), the result is shown as a toast and the fill indicator drops immediately; it can be
  discovered through a palette row. It is rejected while a turn is running (Pi's `compact()` calls
  `abort()` at the start, which would cut the running turn). When Pi finds no old content to compact
  (`keepRecentTokens` = last 20k tokens) or the last record is already a summary, it throws this
  **as an error**; these two cases are turned into separate reasons and reported as "no old content
  to summarize" / "already summarized". On a real failure, the masked reason is also shown —
  "could not be summarized" alone does not allow diagnosis.
- **Stop is no longer a silent no-op**: compaction emitted the "working" state and never cleared
  it; the UI showed a turn that lasted forever and pressing Stop did nothing (there was no run to
  stop, and Pi's `abort()` emits no event). The state is closed on every exit and `abort()` pulls
  the state to "idle" in any case if there is no run. The engine test verifies the state sequence
  (`working` → `idle`).
- **Compaction circuit breakers**: after three consecutive failed compactions and three consecutive
  "freed no space" results, the automatic attempt stops; a new user turn resets the counters. Before,
  a failed compaction was retried every turn and delayed the turn.
- **Error reason taxonomy**: provider errors are classified with fixed codes (`quota_exhausted`,
  `rate_limited`, `auth_failed`, `context_exceeded`, `request_too_large`, `provider_overloaded`,
  `provider_aborted`, `network`, `timeout`). The reason is written to the error event and the event
  trace; the Diagnostics bundle includes a count per reason. Since free text cannot be counted, the
  question "which error, how often" can only be answered with a code.
- **`docs/DESIGN.md` + design scale gate**: type scale, radius ladder, rules for color/spacing/
  shadow/motion/accessibility and named exceptions. `designScale.test.ts` scans the sources and
  fails if it finds an off-scale `text-[Npx]`/`rounded-[Npx]` or an unnamed raw color — since a
  rules document alone does not hold, it is enforced by machine.
- **`TEST_IDS` registry**: e2e tests that measure layout use the identifiers in
  `packages/contracts/src/test-ids.ts` instead of binding to class names or DOM order (this was the
  cause of the two tests that broke yesterday). Behavior tests stay on role/text selectors.

- **`web_search` uses the provider's built-in search**: on Anthropic, OpenAI/Azure Responses and
  Google models, search is now done with the provider's own web search tool instead of DuckDuckGo
  scraping; the tool makes a single inner request to the model and returns the summary and source
  list, and the model uses the sources in its reply as markdown links. For a provider without built-in
  search and for a reply that comes back without sources, the tool falls back to DuckDuckGo as
  before. New file: `packages/agent/src/web-search-native.ts`; the Pi SDK models only client tools,
  so the server-side search tool is added to the request body through the `onPayload` hook.
- **"Cancel" on the plan approval card**: the plan is abandoned; it is not applied, the turn stops
  and the session returns to the permission mode it had before `plan_enter`. The decision is carried
  with `PlanDecision.cancelled` and the model is informed.

## [1.0.6] - 2026-09-19

### Added
- **Live view and tracking of subagents**: an **Agents** tab was added to the right panel.
  Exploration (explore), security audit hunters/verifiers, code review and parallel workers now
  appear in a single list with live duration, step count, tokens/s and the last tool; clicking a
  row draws that run's **full tool stream** (with the chat's tool cards). On the engine side,
  `SubagentTracker` (`packages/agent/src/subagent-trace.ts`) normalizes subsession events and
  publishes them with the new `subagent_trace` event; the `SubagentRun` schema was extended with
  `kind`, `model`, `thinkingLevel`, `tokens`, `tokensPerSec`, `usage`, `task` and
  `parentToolCallId` fields. The `explore` card in the chat links to the trace with a "Subagent"
  badge and a "Watch live" button; the `Agents box` rows were also enriched (steps, tokens/s). Noise
  limits: partial output every 200 ms, a single trace item is trimmed at 4 KB, and the panel keeps
  the last 300 items per run (in line with the AGENTS.md rules, the Pi SDK is imported only inside
  `packages/agent`).
- **Assistant context can be copied into the project folder**: the folder tree is ready when a
  project is saved (`Çıktılar/` + new `Bağlam/`). With the button on the context row, a file or
  folder is copied into the project folder (`rapor (2).pdf` on a name collision), "Refresh" moves the
  old copy to the trash and recopies from the source; when a context is removed from the list its
  copy is not permanently deleted but goes to the trash. For a context that has a copy, the system
  prompt shows the copy as the primary path and the source in parentheses. Approval above 500 MB,
  rejection above 2 GB; a link (URL) context is not copied. New channels: `assistant:copyContext`,
  `assistant:removeContext`; a backward-compatible `copy` field was added to the `assistant.json`
  schema.
- **Worker permission mode per group**: a task group now carries its own permission mode (`ask` /
  `auto-edit` / `full`, default `auto-edit`) and worker sessions are opened with this mode; it is
  chosen from the Settings > Task group form. In `ask` mode, the state where a worker is waiting for
  approval appears on the board as "waiting on you". Old group records fall back to `auto-edit`.
- **Parallel workers: diff screen, group consumption and restore (Phase 4)**: the worktree changes
  of a worker awaiting review open on the board with "Review" (`taskGroups:workerDiff`); untracked
  new files also enter the diff. Group consumption (cost and token total per worker) appears in the
  board header. When the app is reopened, the coordinator session's link to the group is restored:
  the coordinator opens with worker tools and worker events land in the right session. The pending
  count on the board is announced to screen readers with `aria-live`.
- **Parallel workers: board, memory and notifications (Phase 2–3)**: a group board opens in the
  coordinator session — workers are split into status sections (Running, Waiting on you, Ready for
  review, Merged, Failed/Cancelled); clicking a row opens the worker transcript, a running one is
  stopped, one awaiting review is applied to the main branch or its worktree is deleted. The
  worker's completed/in-progress/pending report items (✓ ◐ 💬) appear under the row; hovering over
  the changed file count lists the file paths. **Group memory** was added: a rule the coordinator
  writes with the `memory_write` tool is stored in `task-groups/<id>/memory/MEMORY.md` and goes into
  the prompt of later workers. A system notification is sent when a worker finishes, fails or waits
  for approval. Groups are created, paused and archived from the Settings > **Task group** page;
  while the experimental flag (`taskGroupsOn`) is off, the engine does not set up the worktree
  bridge at all.
- **Parallel worker sessions (experimental, engine layer)**: the layer where the coordinator session
  distributes work to separate worker sessions is now native inside the engine. Each worker runs in
  its own git worktree and has its own context and token counter; concurrency is 3 by default (1–8
  in the group settings), and when the limit is reached jobs are queued. The coordinator uses the
  `worker_start`, `worker_list`, `worker_message` and `worker_stop` tools; the workers' permission
  and decision questions are bound to the worker's session through the existing permission/question
  flow. The Agents box shows worker rows with status, a live sub-line, duration and changed file
  count; a run that finishes successfully waits in the "review" state and applying to the main
  branch happens with user approval. Phase 1 covers the engine; the board, memory and merge screen
  come in later phases.
- **Extension subagent status is visible on the desktop**: in rpc mode pi-subagents sends runs as a
  `PI_SUBAGENT_ASYNC_JSON:` snapshot through `ctx.ui.setWidget`; the app validates the snapshot,
  converts it into a `subagents` event and shows it as a live row in the **Agents** box on the right
  (task, status, duration, tool activity, step count). This removed the red "unsupported UI call:
  setWidget" notification that appeared in every session. In addition, `onTerminalInput` is now
  silently ignored (there is no raw terminal input on desktop; same behavior as the no-op in Pi's
  rpc mode) — the second red notification was cut for this reason too.
- **Command Code provider**: the commandcode.ai Provider API appears under Settings > Connection
  like opencode-go; the API key is entered into the existing credential pool (keys.json → auth.json)
  and no new secret storage path is opened. 70 models are defined from the `/provider/v1/models` list
  and the docs "Pricing & Limits" prices; Claude models go to the Anthropic Messages endpoint
  (`.../provider`), the others to the OpenAI Chat Completions endpoint (`.../provider/v1`). Since
  thinking parameters vary by model family, `reasoning` starts off; the model list is refreshed with
  the app version, and this entry is removed if Pi ships the provider built in.

### Changed
- **Assistant outputs were moved outside the code repository**: persistent outputs are now written
  under `<Documents>/Codezal Asistan/<project>/Çıktılar` (the previous location was
  `<Documents>/Codezal/<project>/Çıktılar`, i.e. inside the repo root, and it was accumulating
  orphan folders at the root). The rule is defined in one place with `outputsDirFor` in
  `packages/contracts/src/assistant.ts`; `outputsRootFor` gives the root and `OUTPUTS_ROOT_NAME` the
  folder name. Windows correctness was also hardened: `safeFolderName` trims a trailing dot/space and
  appends `_` to device names such as `CON`, `PRN`, `COM1`… (for a name with an extension like
  `CON.local` the base name is tested; Windows resolves `CON.txt` to the device too); Documents
  redirected to OneDrive and UNC shares were pinned by tests. Existing outputs were moved to the new
  root.
- **The user extension surface was removed**: since the parallel worker layer became built in
  (`worker.ts`, `task-group.ts` — with its board, memory and diff screen), the path for installing/
  enabling external extensions was closed entirely. The Extensions page, the install gate and the
  curated list, the `plugins:*` IPC channels, the discovery folders and the `PI_SUBAGENT_ASYNC_JSON`
  widget parser were removed; the `pi-subagents` package installed on the machine was also deleted.
  The engine now loads only its own `codezal-*` extension factories (permission, plan, image budget,
  MCP, output, turn and goal gates) — the behavior of these gates did not change. The subagent
  capability is built in: the coordinator opens a worker with `worker_start` and the board tracks it.
- **The update check starts immediately at launch**: waiting 15 s was missing the check in
  quickly closed sessions; also, a failed check (a DNS error just as the network comes up) is now
  retried with increasing delays of 1 → 2 → 5 minutes, and after a successful check it returns to
  the normal 15-minute interval. Check results are written to the log: an info line when a new
  version is found and when an update is downloaded, and "up to date"/"check started" lines in the
  verbose log.

### Fixed
- **Built-in workers hung at the permission gate**: worker sessions were opened with a fixed `ask`
  permission mode; since every `edit` call waited for approval, the worker appeared to run forever
  (in a field trial two workers stayed `working` for 7 minutes, with the session record stopped at
  an `edit` call). Workers are now opened with `auto-edit`: file editing is free, running commands
  still asks for approval. Also, **waiting on a permission and decision question was not visible on
  the board**: since the pending request came from the engine's own gate rather than a Pi event, it
  never entered the `worker_status` mapping; the permission request and question gate now move the
  worker directly to the `waiting` state. After the trial, two workers ran in parallel and dropped to
  `review` in 12 seconds, each changed only its own worktree, and the main branch stayed clean.
- **The frame of an expanded tool card no longer touches the text**: when the frame was over a
  collapsed row, the border stuck to the icon (left) and the arrow (right); the card is now drawn
  overflowing outward by 8px, row content stays aligned with its collapsed neighbors (expanding/
  collapsing does not jump), and the divider lines stay inside the border.

## [1.0.5] - 2026-09-17

### Added
- **Language registry and quality gate**: supported languages are in one place (`@codezal/i18n`
  `LOCALES`); adding a new language is a registry line + a dictionary file. If Turkish text outside
  the dictionary is left in the renderer, the test breaks (`i18nLeak.test.ts`), and the match
  between the registry and `AppSettings.language` is tested separately.

### Changed
- **The language comes from the system on first launch**: the UI no longer opens in Turkish by
  default; if the operating system's language is supported, that language (currently tr/en) is
  selected, otherwise English. It works only on first launch: a language chosen in Settings >
  General never changes again. The document's `lang` attribute also follows the real language
  (screen reader and spell check).
- **The audit report from the shared dictionary**: report texts (Markdown + PDF) moved to the
  `audit.report` keys in `@codezal/i18n`; in the English report `<html lang>` is correct, and the
  "Attack class" and verification plan labels are also translated.
- **Update checks became more frequent**: the open app now checks for a new version not every 6
  hours but **every 15 minutes** (also 15 s after launch). The check is a manifest request of a few
  KB; a downloaded update is still installed when the app is closed. It can also be checked
  manually with "Check" under Settings > Account.

### Fixed
- **The fake "theme not supported" notification is gone**: even with no extension installed, an
  "extension made an unsupported UI call: theme" notification appeared at every session start. The
  source was Pi's own wrapper: it copies the UI surface with `{...ui}` (spread evaluates getters),
  and the bridge's `theme` getter was being read and counted as an "unsupported call". The getter is
  now non-enumerable: it does not fire during copying, and a real theme read is still reported once.
  If the notification has no extension context (the `ctx.ui` bridge), the message itself is shown
  instead of the "extension extension raised an error" wrapping.

## [1.0.4] - 2026-09-17

### Fixed
- **The composer draft is no longer lost**: the content (text + paste chunks + image attachments)
  is stored per session; moving back and forth between sessions drops none of it. Long pastes
  appear as `[Yapıştırıldı ~N satır]` and are expanded with the real content on send; if sending
  fails, the draft is restored as it was and the error is shown as a toast. The draft on the entry
  screens is also preserved under the `home:*` key.

### Added
- **Extensions (experimental)**: tools, commands and event hooks can be added with Pi's extension
  API. Extensions are discovered but not loaded automatically; they are enabled under Settings >
  Extensions by approving per file/folder (`<userData>/pi/extensions` and
  `<project>/.codezal/extensions`). Extension code runs with full system privileges; details and
  security notes are in `docs/PLUGINS.md`.
- **Code review (experimental, shadow mode)**: while the "Code review" switch under Settings > Code
  review is on, the "Review" button that appears under the last turn starts an on-demand review. The
  reviewer and an independent verifier run in separate read-only subsessions (`read/grep/find/ls`,
  in memory, no extensions); only candidates of class `bug` trigger a verification round. In
  **shadow mode** the findings are only reported — they are not sent back to the model and no file
  changes. Results are written to the `userData/reviews/<repo>/<session>.jsonl` record; a "Real /
  False positive" mark on the card is kept for measurement; the token cost of the run appears on the
  row. There is no automatic trigger; the scope is the last 5 user turns and at most 10 files.

## [1.0.3] - 2026-09-16

### Added
- **Full per-turn undo (including `bash`)**: in projects with a Git repository, the working tree is
  saved at the start of a turn with `git stash create` (it is not added to the stash list); "Undo"
  now returns files changed by terminal commands to their pre-turn state too and deletes new files
  created in the turn. User changes that existed before the turn are preserved; in non-git projects,
  file-based backups continue.
- **User-defined shortcuts**: under Settings > Keyboard shortcuts, a key is captured for each
  command with "Change" (⌘/Ctrl required, conflicts are warned), and there are "Reset to default" and
  "Reset all". `AppSettings.keybindings` is stored; the main menu and all hints (sidebar, header
  strip) are resolved from the same source (`resolveAccelerator`).
- **Background chip and usage views**: running background tasks appear as a chip in the session
  header strip (commands in the tooltip; it stays when the panel is open too). On the Usage page, a
  "Year / Weekly" view selector and a "Refresh" button were added to the heat map.
- **The MCP tool list is live**: when a server changes its tool list (`tools/list_changed`) it is
  refetched; when a connector is added/disabled/removed or a connection drops, open sessions are
  refreshed with `onToolsChanged` — the tools of a removed connector no longer remain in a live
  session. The disable flow also publishes `mcp:changed`.
- **Open sessions pick up resource changes instantly**: on skill/template/package changes, besides
  the `skills:changed` broadcast, open sessions are refreshed with `session.reload()`; extensions
  reconnect and the resource list is built in its new state on the next turn. Running (streaming)
  sessions are skipped, and an error does not take down a single session.
- **Connections recover on their own**: MCP connectors that dropped after a network outage or sleep
  no longer wait for the Connectors page to be opened. The network watcher in main (`powerMonitor`
  "resume" + a 30 s `net.isOnline()` transition) retries enabled connectors in an error/not-connected
  state; a debounce reduces concurrent triggers to a single attempt. The attempt made when the
  Connectors page opens uses the same path (the `mcp:reconnectFailed` channel).
- **Credential references (`!command` / `$ENV`)**: a reference can be written in the API key field
  instead of a plain key; the real key does not stay in the file. `!command` runs in the user's shell
  (e.g. `!security find-generic-password -ws 'anthropic'` reads the key from the macOS Keychain),
  `$ENV_VAR` / `${ENV_VAR}` reads from an environment variable. The command result is cached for the
  process lifetime and has a 10 s timeout; a reference that cannot be resolved appears as "not
  connected" and an undefined environment variable is flagged under Settings > Connection. Slots with
  references are shown in the list with a `command` badge or `$VAR` text (`hint` only for a plain
  key). It is the same as Pi's pattern; since `models.json` references are already resolved on the Pi
  side, this change is for `keys.json` (the key pool).
- **Release notes on the update card**: release preparation is now tied to the CHANGELOG. While
  `pnpm bump` writes the version numbers, it closes the "Unreleased" section under a `## [<version>] -
  <date>` heading and opens a new empty section; packaging (`package:mac` / `package:win` /
  `package:linux`) converts this section into `release-notes.md` and puts it in `latest-mac.yml` /
  `latest.yml` as `releaseNotes`. The update card shows the notes of the new version; `release:verify`
  rejects a release without notes. The CHANGELOG history was split into 1.0.0 / 1.0.1 / 1.0.2
  headings (with git history as evidence).

## [1.0.2] - 2026-09-16

### Added
- **Update card**: when a new version is found, a card appears at the bottom right — the transition
  from the running version to the new one, release notes if any, download progress (% and MB). When
  "Later" is chosen the card shrinks to a persistent badge in the corner (it reopens when a new
  version arrives); when the download finishes it is installed with "Restart", and if the user does
  not press it the update is installed when the app is quit. On error, "Retry" appears; only
  download/install errors for a known version show the card. The action in the Settings > Account row
  also becomes "Download" / "Restart" / "Check" depending on the state.

### Fixed
- **Single selection in the question card**: in a single-choice question, clicking an option again
  cancels the selection; before, the selection stayed stuck.

## [1.0.1] - 2026-09-16

### Changed
- **A running tool card states it clearly**: while the card is running, the verb is drawn in
  continuous form ("Running", "Reading", "Editing"…) and turns to past tense when finished. Before,
  it said "Ran" the whole time and left only a small spinning arc; it read as either finished or
  stuck. The spinner now appears with "running…" text next to it (not only on the audit card, but
  for all types). The "Working…" indicator at the bottom is also no longer hidden while a tool is
  running; it is hidden only while reply text is streaming (streaming text draws its own live
  cursor).

### Fixed
- **Input boxes died after deletion on Windows**: the confirmation for deleting a chat/project/folder
  was taken with the native `window.confirm`; on Windows, Electron/Chromium does not give keyboard
  focus back to the window after the dialog closes, and even though the cursor blinked, keys did not
  reach the app (electron/electron#41603). Confirmation is now taken from an in-app window
  (`askConfirm`); no native JS dialog remains anywhere in the repo.
- **Windows compatibility**: agent commands go through a single resolution (Git Bash on Windows,
  falling back to PowerShell with a log warning if absent), PowerShell output is pinned to UTF-8,
  `stop` closes the process tree with `taskkill /F /T`, and commands do not open a black console
  window. The data root moves to `%LOCALAPPDATA%` on Windows (the old folder is moved on first
  launch), a second copy is prevented by a single-instance lock and the notification ID is set. On
  Windows, file locks (`EBUSY`/`EPERM`) are retried with short waits on delete/write paths, `~\` and
  UNC paths are resolved, reserved file names are escaped; a `windows-latest` job was added to CI.

## [1.0.0] - 2026-09-16

### Added
- **Adding folders to the composer**: files and folders are brought into context by dragging and
  dropping them onto the composer or with the "Add folder" row in the "+" palette; both write the
  path into the draft as `@path` (images still go as attachments, and dragged non-image files are
  no longer filtered out). The same behavior from Assistant's context box was carried to all
  composers.
- **Multi-select in the sidebar**: chats, projects (Assistant) and folders (Coding, Design) are
  selected like in Finder: starting from the open row, Shift for a range, Cmd/Ctrl one by one; the
  selection is shown only with row highlighting. Right-clicking a selected row opens the shared menu:
  "Delete 3 selected chats" removes all with a single confirmation (chats are deleted entirely, in
  folders the sessions move to the archive, in projects the tasks stay under Sessions). A plain click
  or a click on empty space drops the selection.
- **Background commands (`bash_background`)**: long-running commands (build, test run, install,
  development server) no longer lock the turn. The agent starts the command in the background and
  continues the turn; when the command finishes, the session wakes up on its own and the result is
  reported to the user. The output of a running task can be read and the task can be stopped; when
  the session closes, its tasks are closed too. In the permission table, starting a command is in the
  same class as `bash` (approval in Ask, blocked in Plan mode), reading output is free.
- **Plan mode enter/exit tools (`plan_enter` / `plan_exit`)**: on an ambiguous or broad job the
  model switches to Plan mode on its own, writes the plan into the plan file and submits it for
  approval with `plan_exit`. A plan approval card appears in the transcript: "Approve and implement"
  returns the session to the previous permission mode (the chip is updated) and the model starts
  implementing in the same turn; "Request changes" passes the written feedback to the model, Plan
  mode continues, and the plan is updated and presented again. Plan mode entered manually from the
  chip is also exited with `plan_exit` (to "Ask", since the mode to return to is not known). In
  scheduled tasks the card is not shown and the plan is rejected. Active in Coding, Assistant and
  Design sessions; it does not ask for permission.
- **Exploration subagent (`explore`)**: the model delegates a research task to a separate,
  read-only subsession (`read`, `grep`, `find`, `ls`); only a summary returns to the main turn, and
  the dozens of files scanned do not enter the main session's context. The subsession stays in memory
  (not visible in the session list), cannot modify files or run commands; for this reason it does not
  ask for approval and also works in Plan mode. Its cost is added to the session's usage counter; it
  closes on its own when the turn is stopped or after three minutes.
- **Web tools in every mode**: `web_search` and `web_fetch` are available not only in Assistant but
  also in Coding and Design sessions. Since reading from the network does not touch local files, they
  are in the read class in the permission table: they do not ask for approval in Ask mode and they
  also work in Plan mode (local network addresses are still blocked).
- **Catalog and `tool_search` for connector tools**: when the total number of tools from connected
  connectors exceeds 20, the tools are presented to the model not with full definitions but with a
  one-line catalog grouped by connector. The model searches for the tool it needs with `tool_search`;
  matches (at most 8) are loaded with full definitions and called in the same turn. If the message
  mentions a connector name, that connector's tools are loaded without needing a search: the name is
  split into words and searched, so a "open the file in Drive" request finds the "Google Drive"
  connector. The number of tools preloaded in a turn is limited, and a connector with more than 30
  tools is loaded only through search. The system prompt does not bloat, and connectors with many
  tools can stay enabled.
- **PDF generation tool (`pdf_create`)**: the model writes a complete HTML document, the app
  converts it to PDF with Chromium and writes it to a file; no external tool such as Python or pandoc
  is needed, and Turkish characters are printed directly. In Assistant a relative name goes to the
  output folder; in the permission table it is in the file-write class (asks for approval in Ask mode,
  blocked in Plan mode), appears in the Outputs box and "Undo" deletes it. Active in Coding,
  Assistant and Design sessions.
- **Undo to before the turn**: an "Undo" button in the "N files changed" list under the turn. Before
  the agent runs `edit` or `write`, the file's current state is backed up under
  `userData/snapshots/<session>/<turn>/`; the button returns the edited files to their pre-turn state
  and deletes those created in that turn. Files changed by terminal commands are out of scope; files
  larger than 8 MB are not backed up.
- **Step list tool (`task_list`)**: in a multi-step job the model records the steps and their states
  (pending / in progress / done) with the tool; the Progress box shows this list ("›" the step being
  done), and a checklist embedded in the chat text is read only when the tool is not used. Active in
  Coding, Assistant and Design sessions; it does not ask for permission.
- **End-of-turn checks** (Settings > Code review > End-of-turn checks, off by default): at the end of
  every Coding/Design turn in which the agent modified files, the enabled lint/test/build commands
  run. If a command fails, the tail of its output is given back to the model and the turn continues
  (at most twice in the same turn); the result appears under the final reply as a "Checks passed /
  Check failed" row.
- **Error detail in the collapsed summary**: next to "1 error", the name, target and the first line
  of output of the first failing tool are written ("Terminal python3 cizim.py: ModuleNotFoundError…");
  what blew up is visible without opening the card.
- **Multiple API keys and automatic switching**: under Settings > Connection, multiple keys (with an
  optional label) are added to a provider. When the active key's limit is full (429, quota, usage
  limit) the app switches to the next key and the turn continues where it left off; when the time
  reported by the server or the configured wait time (1/3/5/24 hours, default 5) passes, it returns
  to the first key. The key list shows its state (Active / Backup / Full → hour); there are Use and
  Delete buttons, and a notification on switching. Keys are kept in `userData/pi/keys.json` (0600);
  the old `auth.json` is imported automatically on first launch.
- **Connectors (MCP connectors)**: from Settings > Connectors, a remote MCP server (Streamable HTTP)
  is added by name and address; an optional Bearer token, and OAuth in the browser for servers that
  require sign-in (dynamic client registration, PKCE, local loopback return). The server's tools
  enter the agent's tool list under the name `mcp_<connector>_<tool>`, fall to approval according to
  the permission mode, and appear on the tool card with a "Connector" heading. Status, tool count and
  list, enable/disable, sign-out and removal; the palette MCP row shows the connected tool count.
  Tokens are kept only in `userData/pi/mcp.json` (0600).
- **Ready-made connectors**: under Settings > Connectors, a searchable, categorized catalog (Google
  Gmail/Drive/Calendar/Docs/Sheets/Slides, Notion, Linear, Atlassian, Asana, monday, Airtable, Canva,
  Webflow, Intercom, Zapier, HubSpot, GitHub, Sentry, Vercel, Supabase, Neon, Context7, DeepWiki,
  Hugging Face, Cloudflare Docs, Microsoft Learn, Stripe, PayPal, Square). Added with one click; if
  sign-in is needed the browser opens automatically; those that ask for a token open a field. For
  Google servers the user's own Google Cloud OAuth client is entered (the redirect address can be
  copied) and the same client is copied to other Google connectors with one click. Connectors are
  listed with real brand logos; the requested Google permissions were narrowed to the narrow list in
  Google's documentation, and when the Connectors page opens, failed connectors are retried once. If
  an OAuth client ships with the app (`CODEZAL_GOOGLE_CLIENT_ID` / `CODEZAL_GOOGLE_CLIENT_SECRET` in
  the build), Google connectors are also added with one click; the user does not have to set up their
  own Google Cloud project. The key is read from the `.env` file at the repo root, and for a
  desktop-type client, if the loopback port 47821 is taken, another port is chosen.
- **Skill system**: Pi's Agent Skills standard (`SKILL.md`) and prompt templates became visible in
  Codezal. Besides built-in commands, the palette (`/`) lists searchable skills (`/skill:name`) and
  templates (`/name`) from `~/.agents/skills`, the project's `.agents/skills`, Codezal's own `skills/`
  folder and source folders; arrow keys and Enter select. Settings > Skills: a list by scope,
  enable/disable one by one (the `+path`/`-path` pattern compatible with the Pi TUI), add/remove
  source folders, open the Codezal folder, install/remove/update npm/git packages (skills and
  templates only; extensions are off), diagnostic warnings. On first launch, the existing
  `~/.pi/agent/skills` and `~/.pi/agent/prompts` are added as sources. The `/paralel` placeholder was
  removed from the palette.
- **Markdown preview**: in the Files viewer `.md` files open formatted; the `</>` button in the
  header switches to the source and the eye button back to the preview. Headings at document scale
  (22/18/15px).
- **Syntax highlighting**: the Files viewer and chat code blocks are colored with Shiki (JS regex
  engine, no WASM; languages are lazy-loaded by extension/fence language; vitesse-light/dark, live
  adaptation to theme changes; plain text above 200 KB).
- **Terminal WebGL**: with `@xterm/addon-webgl`, block/box characters are drawn seamlessly
  regardless of font; on context loss it falls back to DOM rendering.
- **Quality infrastructure**: GitHub Actions (check, lint, test; unsigned macOS packaging on main),
  Playwright end-to-end tests (`pnpm test:e2e`), unit tests for main modules.
- **Error surface**: a file log at `userData/logs/codezal.log` (keys masked, 5 MB rotation); recording
  of uncaught errors and renderer crashes in main; an error boundary in the renderer, a notification
  (toast) at the bottom right for unhandled rejections with a "Logs" link; opening the log from
  Settings > Account.
- **First launch**: a three-step welcome when no provider is connected; it is stated explicitly that
  the agent runs directly on the machine with the user's permissions.
- **Automatic update**: `electron-updater` (in the packaged version a check after 15 s and every 6
  hours, install on quit); status and "Check" under Settings > Account.
- **Skills**: `/plan` and `/sor` put the session in plan mode and add instructions, `/debug` adds
  debugging instructions, `@` opens the file picker and `@path` mentions turn into a "read first"
  list. The session screen also has the palette and the permission mode chip.
- **Branch and Duplicate**: the branch button on a message copies the conversation up to that point
  into a new session (Pi `createBranchedSession`); in the sidebar, Duplicate copies the whole session
  (`forkFrom`).
- **Steering**: a message typed while the agent is running is queued as `steer`; the stop and send
  buttons appear together.
- **Sidebar**: "Open in Terminal" (system terminal) and "Remove folder" (removes from the list,
  archives its sessions; the disk is not deleted) in the folder menu.
- **Assistant web tool**: `web_fetch` converts a page to plain text (http/https only, local network
  blocked, 60k character limit).
- **Context and cost**: context fill percentage in the session footer; USD cost by provider price on
  the Usage page.
- Suggestion cards change depending on whether there is a git repository; the greeting and card
  toggles in Personalization are now effective.
- **Eight new settings in General**: *Notification sound* (mutes the sound separately while
  notifications are on), *Keep the computer awake* (prevents the system from idle-sleeping only while
  an agent turn is running; the screen still turns off), *Terminal font* (the app's default if empty;
  a change applies instantly to open terminals) and *Links* (separate targets for web addresses in
  chat and for localhost/`.local` addresses: the embedded browser or the system browser; default web
  → system, local → app).
- **Network settings**: under Settings > Connection > Network, *Proxy bypass list* (visible when a
  proxy is on, comma-separated addresses connect directly) and *Custom root certificate* (a PEM path
  for corporate intercepting proxies; model, MCP and command traffic trust it, takes effect after a
  restart).
- **Download updates automatically** (Settings > Account): when off, a new version is only announced
  and the user starts the download; installation happens on quitting the app in any case.
- **Archive stale sessions** (Settings > Archived tasks): scans hourly and moves a session to the
  archive 3/7/14/30 days after its last change; it does not touch pinned and running sessions.
- **Window controls on Windows and Linux**: minimize / maximize / close buttons now exist — since
  they are drawn by the system, Windows 11's Snap Layouts menu and accessibility work too. The strip's
  color follows the app theme (also when the operating system changes while "system" is selected).
  The title strips at the top right were narrowed so they do not sit under the controls, the space
  reserved for the macOS traffic lights is left only on macOS, and the menu bar opens when Alt is
  pressed.
- **Diagnostics**: **Show diagnostics** in the "···" menu on the session screen — a trace of turns,
  model requests and tool calls: time to first token (TTFT) per request, duration, `tok/s`, token
  breakdown, tool durations and errors. Records are derived from the live event stream, no separate
  measurement is made; "Copy trace" puts the text on the clipboard. The Settings > **Diagnostics**
  page has a live log (level filter, search, auto-scroll), version/path information and "Copy
  diagnostics". When **Verbose logging** is on, debug lines are written to a separate file
  (`codezal-debug.log`); **Agent event trace** stores each session's events as masked NDJSON under
  `agent-events/` (5 MB per session, 7 days; the trace is deleted when the session is deleted). All
  of it stays on the local disk.
### Changed
- **The chat area was simplified**: tool rows are borderless; the border and fill remained only on the
  expanded card and the failed row, and the failed row shows the first line of output in red. Three
  or more consecutive reads/searches of the same type fold into a single row ("5 read · a.ts, b.ts…"),
  expandable from the arrow; while the turn is running, the row updates in place as the group grows.
  Thinking, tool and collapsed-sequence rows have the same measure and the arrow is always at the far
  right. The "Working…" indicator is not drawn while there is a running tool card or streaming
  thinking/text (a single live indicator). Verbs follow a single pattern: "Ran" (instead of
  Terminal), "Connector called", "Steps updated", "Ran in background"; the thinking and sequence
  summaries are active ("thought for 10 s", "worked for 2 min"). In a terminal row the `cd <cwd>`
  prefix is also dropped when followed by a line end or `;`. A "This session" box was added to the
  right column: files changed during the session (+/−, most recently touched on top), which open in
  the Files tab on click.
- **PDF reading is in the `read` tool's own description**: the `read` tool was replaced with a
  version wrapping Pi's built-in definition. Its description now states PDF support, that `offset` is
  the page number and `limit` is the page count; the model no longer tries to open a PDF in the
  terminal with pypdf/pymupdf. With the new `render: true` parameter, a text-heavy page can also be
  taken as a page image (when it wants to check a drawing it produced); the limit of 5 images per
  call applies. The exploration subagent can also read PDFs.
- **The menu bar icon** (Settings > General > "Show in menu bar") is now real: clicking the icon
  opens a Show / New task / Settings / Quit menu, and on macOS the brand glyph is drawn as a template
  icon that follows the system theme. When the switch is turned off the icon is removed; while on, the
  app stays in the background on Windows and Linux even when the last window is closed.
- **Launch at startup** is now real: it starts the app at login (`setLoginItemSettings`). It applies
  only in the packaged version; if the operating system rejects the registration the switch turns
  itself off and it is logged. The row is not shown on Linux because Electron does not support it.
- **Two placeholders were removed from General settings**: "Mode" (For coding / For daily work) and
  "Join early access" were not tied to any behavior and misled the UI. The old `settings.json` is
  cleaned up automatically on the next write.
- Like/dislike was removed from message actions (it was non-functional); copy and branch remain.
- `main/index.ts` was split into domain-based `ipc/*` modules, and `settings/pages.tsx` into
  one file per page.
- The embedded `<webview>` was hardened: preload and Node are not inherited, permission requests
  (camera, etc.) are denied, the main window cannot navigate out of the app, and new windows open
  according to the target in Settings > General > Links.

### Fixed
- **A scheduled task's chat was not appearing in the sidebar**: the session created while the task
  was running did not appear in the sidebar until the app was restarted because the chat list was not
  refreshed. The list is now refreshed when the task starts and ends; the chat appears instantly under
  the relevant project.
- **The switch model shortcut was not working**: ⌘M conflicts with macOS's *Window > Minimize*
  shortcut, and pressing the key minimized the window. The command was moved to ⌘⇧M and Minimize got
  ⌘M back.
- **Shortcut hints were hard-wired to macOS**: the sidebar menus, the "New task" badge and the title
  strip hints were fixed text like "⌘N"; on Windows and Linux they now say "Ctrl+N" and the keys are
  produced from a single source (`SHORTCUTS`).
- **The keyboard shortcuts list was showing the wrong key**: since shortcuts are defined for the US
  layout, on Turkish Q Settings falls on ⌘Ö and the sidebar on ⌘, but the list said "⌘," and "⌘\". The
  list now shows the letter the key produces in the user's layout and matches the menu.
- **Design was showing Coding's project**: the selected folder was single and shared; the repo chosen
  in Coding appeared in Design's sidebar and folder chip. Also, when a folder was removed from the
  list the next project was selected automatically, and mistaken for deleted it could be removed by
  accident. The selection is now kept per section (Coding and Design do not carry each other's
  selection), nothing is put in place of a removed project, and this decision is preserved across
  reopening. "Remove folder" also moves only the current section's sessions to the archive; it does
  not touch the other section's sessions.
- Links in chat were opening in the system browser regardless of the setting: the window set up its
  own `setWindowOpenHandler` and overrode the one in the hardening (a `webContents` keeps a single
  handler).
- Settings > Archived tasks was not opening ("Maximum update depth exceeded"): the session list
  selector was producing a new array on every render.
- **The model chip was showing another session's model**: the chip read the global preference; when
  returning to a session running with DeepSeek it said "Kimi" while the session continued with its
  recorded model. The chip and model picker now show the session's own model (from main at open, then
  from the model that produced the reply); the thinking level is also read from the session. The
  thinking level of a reopened session is not dropped to "Low".
- **Text in the input box was carried to another chat**: when the session changes the screen is
  rebuilt from scratch; each session's unsent draft is stored separately and comes back when returning
  to that session.
- **The packaged app was not opening**: a build made with `npx electron-builder` crashed with `Cannot
  find package '@earendil-works/pi-coding-agent'` after being copied to `/Applications`; the packager
  took the package manager to be "npm" and nested the Pi family. Detection was pinned with the
  `packageManager` field, `package:inspect` now catches this layout, and `package:mac:unsigned` was
  added for unsigned builds.
- **The updater never started in the packaged version**: `electron-updater` exposes its CJS
  `autoUpdater` through a getter, an ESM named import gets `undefined`, and every launch logged
  "Cannot set properties of undefined (setting 'autoDownload')"; it is now read via `default`.
- **"Provider finish_reason: error" was killing the turn**: OpenAI-compatible endpoints such as Kimi
  K3 (via OpenCode Go) can cut the stream with `finish_reason: "error"` in the middle of long
  thinking. Pi counts this as an error, but since the retry pattern recognizes only `network_error`,
  the turn ended there and the user typed "continue" each time. The app now treats this cut (and
  `unknown`, a stream that arrives with no finish reason, "upstream request failed") as transient: the
  error banner is kept, the UI switches to "waiting", and the turn is resumed where it left off up to
  three times with 2/4/8 s waits. If the attempts run out, the error now appears with an explanation
  of what it is and what to do.
- **A turn that ended with a tool and stopped without writing text required typing "continue"**:
  providers such as DeepSeek can return an empty reply after a tool turn; the turn ended there and the
  user continued by hand. When the engine sees an empty reply at the end of a turn, it now sends the
  model a hidden nudge and the turn continues in the same stream (once per turn). In Assistant, a turn
  that writes a script to produce output and never runs it is nudged the same way: run the script,
  open the produced file with `read` and verify it, save it to the output folder. This rule was also
  added to the Assistant system prompt.
- **Two "worked for N s" rows in the same turn, and the model badge under the wrong message**: since
  end-of-turn detection skipped tool cards, in a turn that ended with a tool an interim narration was
  taken for the end of the turn; the sequence was split in two, and the model badge and file list
  landed under the interim sentence. Now only an assistant message that has text and is not followed by
  a tool is the end of the turn; a sequence with no closing text folds as a single piece and its
  summary says "incomplete". A turn continued by the end-of-turn nudge also stays a single sequence in
  the UI.
- **With a DeepSeek vision model, the session locked up after the fifth image**: the provider accepts
  at most 4 images per request and images in history are sent again every turn; the turn ended with
  the error "At most 4 image(s) may be provided in one prompt", and a new message got the same error.
  Before each request, the oldest images beyond the limit are now turned into a placeholder; images
  that come with a tool result, like a PDF page, are also counted. The session record does not change,
  and rewind finds the images.
- **Web search was giving back-to-back errors at the rate limit**: when DuckDuckGo returned 429, the
  tool gave an error immediately, so the model changed the query and searched again, the limit grew
  and the turn filled with "Could not search" cards. The tool now recognizes the limit and retries
  twice on its own (1.5 s and 4 s); if it is still limited, a message telling what to do is returned
  instead of a raw "429". It was also added to the system prompt: after a limit message, no search is
  made with new queries and no `sleep` is run in the terminal.
- The thinking label was saying "thought for 0 s" for blocks under a second; in that case it stays
  as plain "Thought".
- **The thinking time was disappearing when it finished**: while running the label counted "4 min 12
  s · Thinking…" and returned to plain "Thought" when finished. The counter now freezes at its final
  value: "thought for 4 min 12 s". In old sessions that have no duration record, the label stays plain
  as before.
- **The scrollbar was hanging on the screen at idle**: the thumb now appears only while the cursor is
  over that area, as on macOS, app-wide. Its length is proportional to the content; when the content
  slightly exceeds the window, the bar naturally looks long.
- **PDF drawings were never going to the model**: on schematic, plan and chart pages, the text layer
  carries only labels (an A4 electrical panel drawing is ~80 characters); the reader counted this as
  "has text" and did not send the page image. Because the model could not see the drawing, it tried to
  convert the PDF to an image in the terminal on its own. Pages whose text does not describe the page
  (little text but carrying a vector drawing or a large bitmap) now go both as label text and as a
  page image.
- PDF reading was added to the system prompt: the model knows it will open a PDF with `read`, that
  `offset` is the page number, and that it must not run converters such as pdftoppm/pymupdf in the
  terminal.
- **There was no right-click menu**: selected reply text could not be copied with a right click. A
  Cut/Copy/Paste and Select all menu was added (it opens only when there is a selection or an input
  box).
- Transcript: while a reply was streaming, every chunk scrolled the list to the end, so text could
  not be selected with the mouse; auto-scroll stops while there is a selection.
- **Connector tools were not visible**: the tool list given to Pi worked like an allow list and
  filtered out `mcp_*` tools, so even though connected connectors appeared "Connected", the agent
  could not use them. Connector tools are now enabled together with the base tools according to the
  mode; the Assistant prompt tells it to answer a connector question from the tool list.
- Model catalog: entries with a negative price in the Pi catalog were breaking the `models:catalog`
  schema and blocking the provider list (and the first-launch welcome); the price is clamped to zero.
- Terminal: the xterm session is kept alive independent of the component; connecting to the shell
  with a blank screen ("sometimes it doesn't work") on session/theme change was fixed. The theme
  updates live, "Clear" wipes the screen without breaking the shell.
- Terminal: line height 1.25 → 1; the horizontal gaps in block-character drawings like the Claude Code
  logo are gone.
- Panel: when a file with long lines is opened in full-screen mode, the top-right icons and the file
  tree overflowing the window (`min-w-0`) were fixed.
- File-based memory (Claude Code harness model): each fact is a separate markdown file, the `MEMORY.md`
  index enters every session's system prompt, and the agent writes memory with its own tools. Scopes
  are general / Coding project / Assistant project. Viewing, adding notes, deleting and opening the
  folder from the Settings > Memory page and the Assistant project panel. Writing to the memory
  folder does not ask for permission.
- The Assistant sidebar as in the design: personal projects (Personal finance, English learning…)
  instead of code folders and tasks under them; tasks without a project under "Sessions". The folder
  button opens "New project" in Assistant mode; New task, Rename, Delete project on the project row.
- **Coding mode**: project picker, branch picker, permission mode / model / thinking level menus,
  skill palette, streaming transcript, tool cards (diff and terminal output), approval card, session
  persistence (rename, delete, pin, archive, Markdown export).
- **Workspace panel**: Terminal (node-pty + xterm), Files (tree, git badges, search, viewer), Browser
  (webview). Changes and Commit modals, branch switching, worktree per task.
- **Settings**: General, Keyboard shortcuts, Personalization, Usage & model, Connection (API key and
  OAuth/device code sign-in), Account, Code review (pre-commit lint/test/build), Worktree, Archive.
- **Assistant mode**: projects, memory and context, scheduled tasks (daily/weekdays/weekly/monthly/
  interval), progress steps, desktop notifications.
- **Design mode**: preview frame and viewports, Edit/Inspect tools, element selection, applying
  changes to code, versions and a context sidebar.
- **Distribution**: electron-builder configuration (macOS dmg/zip, Windows NSIS, Linux AppImage), icon
  set, asar inspection script (`package:inspect`), hardened runtime entitlements.

- **Image attachment**: up to 10 images (PNG, JPEG, GIF, WebP) via pasting into the composer (⌘V),
  drag-and-drop and file selection. Images are downscaled to a 2000 px / 4.5 MB limit with Pi's
  `resizeImage` and sent with `session.prompt(text, { images })`, stored as base64 in the session file
  and shown in the user bubble when reopened. A large preview on click; a warning on a model that does
  not support images.
- **Smooth streaming**: text chunks are merged per frame and shown gradually.
- Message actions only on the last message of the turn; the model/thinking chips are in the bottom
  row of the session composer.

- **Icons**: the real app icon (macOS/Windows/Linux), the notification icon, an About block (versions)
  under Settings > Account, colored icons by file and folder type in the Files tab (Material Icon
  Theme, MIT).
- Sessions were not listed when the app was reopened: Pi's `listAll(dir)` call scans the folder flat,
  while our sessions are in a subfolder per project. Subfolders are now scanned one by one.
- Turkish-localized git output was breaking simple-git's error detection; git commands run with
  `LC_ALL=C`.
- On pnpm install, node-pty's `spawn-helper` was losing its execute permission; the `postinstall`
  step restores the permission.
- The sidebar button could not be clicked with the mouse: the draggable area of the title strips
  below covered the button (regions merge in document order). The button is now rendered last; aligned
  with the traffic lights (18px left, vertically centered in the 34px strip). While the sidebar is
  hidden, session titles leave 124px of space on the left.
- The home screens (Coding, Assistant, Design) are vertically centered as in the design instead of a
  fixed top gap.
- Since Electron does not support `window.prompt`, 14 inputs such as naming, project creation and
  memory notes did not work at all; all were moved to an in-app text window (`components/Prompt.tsx`).
- The Assistant project screen went into an infinite loop when opened (`filter` in the selector); fixed
  with memo.
- In development mode, the Dock icon is the Codezal icon instead of Electron's.
- The working folder of an Assistant project (userData/asistan/<project>) was never created; the bash
  tool failed with "working directory doesn't exist". It is now created on the first task.
- When adding a context file to an Assistant project a path was being typed in; now a native file
  picker opens (`files:pickFiles`), multiple files can be selected, and the same file is not added
  twice.
- In the Commit or push, Changes, Schedule and text-prompt windows the content was stuck to the edges;
  the `Modal` component now gives the content area padding.
- The horizontal line under the Coding session header was removed; the same look as the Assistant task
  header.
- The recent files list was turning into an object on the second launch (`loadJson` spread the array);
  the Files tab crashed with "recentFiles.filter is not a function". Arrays are now loaded as arrays.
- Chat text: tables were shown with raw pipe characters; headings were out of proportion with the body.
  The Markdown parser was split into `lib/markdown.ts`; tables, numbered and nested lists, task boxes,
  quotes, horizontal rules, italics, strikethrough and links are supported. Heading sizes were matched
  to the design (16/15/14px).

### Known Limitations
- Code signing, notarization and automatic update require certificates and a release environment.
- The Windows and Linux packages have not yet been tried on those platforms.
