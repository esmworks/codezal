# Codezal — Parallel Agent Runs: Technical Design

**Status:** v0.4 (2026-09-23) — task group layer removed; product definition in
`docs/PRD-PARALEL-WORKER.md`.

## 1. Layers

```
agent aracı (agents/tool.ts)
  └─ CodezalEngine.#agentBridge ── biçim kararı (bekletme / arka plan / yalıtım)
       ├─ bellekte koşu: #agentRun (SessionManager.inMemory, izin ana oturumdan)
       │    └─ runs.slots (ortak Limiter) + #subagentStops (subagents:stop)
       └─ ayrık koşu: AgentRunManager (agents/runs.ts)
            ├─ kuyruk + eşzamanlılık: runs.slots (agentConcurrency, bellek koşularıyla ortak)
            ├─ WorktreeService (main git.ts köprüsü)
            └─ WorkerSession (worker.ts) → WorkerRuntime → createSession (tam oturum)
```

- `packages/agent/src/worker.ts` — `WorkerSession`: lifecycle of a single run (open the session →
  hand over the task → collect the summary, usage and changed files). The `WorkerRuntime` and
  `WorktreeService` interfaces abstract the engine and git; the pool is tested without Pi.
- `packages/agent/src/agents/runs.ts` — `AgentRunManager`: per-main-session run list, queue,
  concurrency, worktree creation, review decision, persistence (`AgentRunStore`).
- `packages/agent/src/agents/run-tools.ts` — `agent_list`, `agent_message`, `agent_stop`.
- `packages/agent/src/agents/limiter.ts` — concurrency limit. A single instance (`runs.slots`)
  limits both detached runs and in-memory subagents: if the setting were split into two separate
  counters, twice as many agents would run at the same time.

## 2. Form decision (`#agentBridge`)

1. If the calling session is a run session, error (no nested delegation).
2. `background = (call.background ?? definition.background) && !unattended`.
3. Isolation (`#isolationFor`):
   - call `worktree` → `required`. The schema does not offer `none` to the model: the model was
     turning automatic isolation off to avoid the approval step (in testing it passed `none` on
     every call);
   - definition `worktree` → `required` for a writing agent, `none` for a read-only one;
   - a writing agent (`canWrite`: `edit`/`write`/`bash`) running in the background or while
     another writing in-memory run is active → `preferred`; otherwise `none`;
   - if the main folder has uncommitted changes (`WorktreeService.dirty`), `preferred` → `none`:
     a worktree is created from HEAD, and the agent would work on the old files without seeing
     those changes.
4. If a writing agent is requested in the background or with `required` isolation in plan mode,
   error (`prompt.agentPlanBlocked`); `preferred` isolation runs in memory, passing through the
   plan gate.
5. If there is `background` or isolation, `#detachedRun`; otherwise `#agentRun` under the `Limiter`.

If a `preferred` worktree cannot be created (not a git repository), the run continues in the root;
a `required` run becomes `failed` before starting (`errors.agentWorktreeFailed`).

## 3. Detached run

- **Session**: `WorkerRuntime.open` → `createSession({ …, parentSessionId })`. Model, thinking and
  extra system prompt come from the agent definition (or the main session if absent); then
  `setActiveToolsByName(resolveAgentTools(profile))`. The metadata carries `parentSessionId`:
  `SessionSummary.parentSessionId` is filtered out of the sidebar in the renderer. Run sessions are
  not refreshed in `reloadLiveSessions` (refreshing would re-enable extension tools).
- **Permission**: the run's mode comes via `permission({ parentSessionId, isolated })`: a worktree
  run uses the `agentWorktreePermission` setting, a run without isolation uses the main session's
  mode. The gate works with the run ID, but `PermissionManager` publishes the request with the main
  session's ID and a `run` field (`{ id, title }`) (`runs.runOf`); the response returns via
  `requestId`. The main session's state does not change. The renderer keeps all permission cards
  in a single list (`permissions`); a card is removed only by a `permission_resolved` event
  (response, cancellation, session close) or when the run ends, and a status event does not delete
  the card (with parallel subagents, another tool's "working" event was deleting the pending
  card). Turn end drops only the main session's own requests. The `sessions:open` snapshot carries
  pending permissions (those of runs with the `run` field), the plan approval and the question: on
  reopening, the card does not vanish and leave the gate waiting forever. An in-memory subagent
  passes through the main session's gate and counts as its request; the card carries `agent` (the
  job name, or the agent name if absent; same as the detached run's title) only for the label. The
  run returns to `working` once its last pending approval is answered (not while others wait in
  parallel tool calls).
- **Events**: `worker_started` / `worker_status` / `worker_report` / `worker_ended` flow with the
  main session's ID. The run session's `tool_start` event becomes the row's latest action via
  `runs.noteActivity`.
- **Ending**: a worktree run that leaves changes goes to `review` — including a stopped or failed
  run (even if the work is partial, the decision belongs to the user; the end information carries
  the actual result and the nudge follows it). If there are no changes, the worktree and its
  branch are deleted and the run stays `done`/`cancelled`/`failed`. When a background run ends,
  `#onAgentRunEnded` wakes the main session with `#nudge(…, "background")` (`prompt.agentRunDone`
  + summary + review note). A blocking worktree run waits for `run.ended` and returns the same
  summary as the tool result; cancelling the main turn and `AGENT_TIMEOUT_MS` stop the run. The
  timeout is counted from when the run starts (`run.started`), not the time spent in the queue; a
  run that times out returns `prompt.agentTimeout`.
- **Steering and stopping**: an `agent_message` sent to a run that is queued or starting up is
  stored and delivered together with the task. A stop that arrives during startup ends the run
  once, after startup finishes. `agent_stop` returns `prompt.agentRunMissing` for a run that is
  not found or has already ended.
- **Persistence**: `SessionMetaStore` keeps each main session's `agentRuns` list
  (`MAX_STORED_RUNS` = 20). A finished run moves from the live list to the record (a run awaiting
  review stays live until a decision is made); the session → run mapping is limited to running
  runs. On startup, a running run is marked `failed`; a `review` run can be decided via its `cwd`
  and `worktree` path. When the main session is deleted, the runs stop, the record is dropped and
  the run sessions are deleted.

## 4. Channels and UI

- IPC: `agentRuns:list | stop | steer | review | diff`, `subagents:stop`
  (`apps/desktop/src/main/ipc/agent-runs.ts`).
- Renderer: `stores/agentRuns.ts` (rows per main session, live via events), `lib/jobs.ts`
  (`workerRow`: an isolated run is of kind `worker`, others `agent`), `session/AgentsBox.tsx`,
  `panel/AgentsTab.tsx` (Stop, Inspect/Apply/Discard, diff), `session/AgentReviewPanel.tsx`
  (review card: at the end of `Transcript`, only while the main turn has finished — while the turn
  was running it stayed under the streaming reply and slipped in between permission cards, causing
  wrong clicks; not in the Environment column, because that column was hidden when the panel
  opened). The first button is Inspect; Apply/Discard become available after 1.2 s. The panel row
  has the same shape as an in-memory subagent: the label is the agent name, the task line is the
  run name; model, thinking, steps (tool count) and output tokens are shown, and a run awaiting
  review reads "in review".
- Settings > Agents: "How agents run" (`agentConcurrency`, `agentWorktreePermission`) and
  Isolation / Run in background in the agent form.

## 5. Worktree bridge

`main/index.ts` gives the engine `worktrees`: `createWorktree(cwd, worktreeRoot, agentWorktreeName(title, id))`
(`git.ts`; the branch name is `ajan-<başlık>-<kimlik kuyruğu>`, ASCII only: Turkish letters are
simplified), `removeWorktree(…, { deleteBranch: true })`, `worktreeChangedFiles`, `worktreeDiff`,
`applyWorktree` (commits the remaining changes to the run branch and merges it into the main
branch; on a conflict, `merge --abort`). If `worktreeClean` is enabled, the applied worktree is
deleted.

## 6. Tests

- `agents/runs.flow.test.ts`: real engine, temporary git repository and worktrees; scripted model
  (`agents/flow-model.ts`, Pi faux). The session looks at its first message: the main session
  starts the agents on the `PLAN:` line in a single response, and the subagent writes the file on
  the `DOSYA:` line.
- `e2e/agent-flow.spec.ts`: the same model in a real window. Main wires it only with
  `CODEZAL_E2E_FAUX=1` and in an unpackaged build (`main/index.ts`).
