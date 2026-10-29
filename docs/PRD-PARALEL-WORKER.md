# Codezal — Parallel Agent Runs PRD

**Status:** v0.4 — Task group layer removed, its capabilities moved into the `agent` tool (2026-09-23)
**Owner:** Esmworks
**Scope:** Coding and Assistant modes, local machine
**Related documents:** `docs/TECH-PARALEL-WORKER.md` (technical design), `docs/ARCHITECTURE.md`
(User-defined agents, Agent runs)

**Changelog**

- **v0.4** (Sep 23, 2026) — Removed the task group (coordinator session + `worker_*` tools + group
  board). In every chat the model was already splitting work across subagents with the `agent`
  tool; a separate group concept made the same thing possible through a second surface. Worktree
  isolation, background runs, the queue, review (Apply/Discard) and run management moved into
  the `agent` tool and agent definitions. The `explore` tool was removed too: exploration is the
  built-in `explore` agent.
- **v0.3.2** (Sep 18, 2026) — Phase 1 (engine) implemented; the v0.1–v0.3 task group design is in
  git history.

---

## 1. Summary

For multi-part work (fixing several bugs at once, the backend + UI + test parts of a feature, a
long scan), the main chat splits the work across subagents. Every chat can do this on its own:
there is no need to open a "group", set up a coordinator session or write instructions.

A subagent runs in one of three forms:

| Form | When | Result |
| --- | --- | --- |
| **Blocking** (default) | Short job, result needed right away | The main turn waits; the summary comes back as the tool result |
| **In the background** (`background: true`) | Long job, no need to wait for the result | The tool immediately returns the run ID; when the run finishes, the main chat is woken with a hidden message |
| **In a worktree** (`isolation: "worktree"`) | A job that changes files may conflict with other work | The agent works in its own git worktree; changes do not reach the main folder until the user approves |

The forms can be combined (background + worktree). The model can pick the form in the call; if it
does not, the default in the agent definition applies, and if there is none, the engine decides.

## 2. Problem

- The task group was a separate concept: the user had to first set up a group in Settings and write
  instructions, then find the coordinator session and talk to it. The same work could already be
  done in a normal chat with the `agent` tool; the two paths were unaware of each other.
- Subagents in a normal chat were inadequate: they all worked in the same folder (two agents
  writing in parallel overwrote each other's files), the main turn always waited, a single
  subagent could not be stopped, and `explore` was a separate tool that ignored model selection.

## 3. Goals

1. One path: parallel work is done in every chat with the `agent` tool.
2. Conflict-free parallelism: agents that change files are automatically moved into a separate
   worktree when they run in parallel or in the background.
3. Work without waiting: long jobs continue in the background while the main chat keeps talking to
   the user.
4. User control: every run appears in the Agents box and can be stopped individually; worktree
   changes do not reach the main branch without being reviewed.
5. Cost limit: the number of concurrent agents is capped by a setting; the rest wait in a queue.

**Non-goals:** cloud runs, direct messaging between agents, nested delegation (a subagent cannot
assign work to another agent), automatic merging.

## 4. User flow

1. The user says "fix these three bugs". The model makes three `agent` calls in the same response.
2. The first agent that writes works in the main folder, the others in their own worktrees. Three
   rows appear in the Agents box (worktree rows with a branch icon).
3. If a worktree agent leaves changes, its row stays "in review"; at the end of the chat, like a
   permission card, a **review card** appears: **Apply** (merge into the main branch), **Inspect**
   (the diff opens inside the card), **Discard**. The user does not have to open a panel.
4. If a long scan is started with `background: true`, the model returns to the user immediately;
   when the scan finishes, the main chat wakes up and relays the result itself. If the user is in
   another window, a system notification arrives.
5. If an agent asks for approval, the card appears in the main chat (there is no need to open the
   run session) and the row becomes "waiting on you".

## 5. Requirements

| No | Requirement |
| --- | --- |
| R1 | The `agent` tool accepts the `background` and `isolation` (`worktree`) options; the model cannot turn isolation off |
| R2 | An agent definition (`.md` front matter and the Settings > Agents form) carries `isolation: worktree` and `background: true` defaults |
| R3 | A writing agent (`edit`/`write`/`bash`) is automatically moved into a worktree when it runs in the background or in parallel with another writing agent; if the folder is not a git repository, it continues in the main folder |
| R4 | A run that explicitly requests a worktree does not start if the worktree cannot be created, and the reason is shown |
| R5 | In plan mode, a writing agent cannot be run in the background or in a worktree |
| R6 | The concurrent agent limit (1–8, default 3) is chosen in Settings > Agents |
| R7 | The permission mode of worktree agents comes from the setting (default **Auto-edit**); a detached run without isolation uses the main chat's permissions |
| R8 | The permission card of a detached run appears in the main chat |
| R9 | The model monitors, steers and stops runs with `agent_list`, `agent_message`, `agent_stop`; the decision to apply or discard belongs to the user alone |
| R10 | When a background run finishes, the main chat is woken with a hidden message; a run the user stopped does not nudge it |
| R11 | A blocking subagent can be stopped individually from the Agents tab; the main turn continues with the partial result |
| R12 | The run record is stored per main chat: on reopening, a run that was cut off comes back as "failed", and a run awaiting review comes back with its decision pending |
| R13 | Run sessions do not appear in the sidebar; when the main chat is deleted, they are deleted too |

## 6. Acceptance criteria

- When two writing agents are started in the same response, the second one runs in a worktree and
  the files do not conflict.
- After a `background: true` run starts, the model can reply to the user in the same turn; when the
  run finishes, a new turn opens in the main chat and the result is relayed.
- A run awaiting review can still be closed with Apply/Discard after the app is restarted.
- With the concurrency limit at 1, the second run shows as "queued" and starts when the first one
  finishes.
- A request to start a writing agent in the background in plan mode returns with an explanatory
  error.

## 7. Risks

| Risk | Mitigation |
| --- | --- |
| A worktree agent makes a commit and the changes look like "none" | The run prompt tells it not to commit or switch branches; the apply step commits any remaining changes itself |
| Background runs increase cost | Concurrency limit; cost on the run row; the user can stop runs one by one |
| Automatic isolation does not work in a folder that is not a git repository | `preferred` isolation continues in the main folder; an explicit request (`required`) fails with an error |
| A worktree does not see uncommitted changes | If the main folder is dirty, automatic isolation is not applied; on an explicit request the agent works from the last commit |
| Merge conflict | `applyWorktree` aborts the merge on a conflict; the branch and worktree are kept |
