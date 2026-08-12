---
name: taskforce
description: Supervise terminal-visible coding CLIs through cmux with frequent Chief review and precise runtime input.
---

# Taskforce

Taskforce is a focused runtime supervisor loop. It launches coding CLIs in
visible cmux surfaces, reads what they are actually doing, and lets Chief decide
what to do next.

It is not an engineering methodology, role system, patch integration framework,
model discovery service, or general workflow platform.

## Core loop

The built-in wait runs one short local tick every 10–20 seconds:

```text
consume previous Chief actions
  → launch pending/relaunched nodes
  → read every running cmux surface
  → write the current compact observation batch
  → Chief makes a fresh decision for every included node
  → return immediately
```

Worker CLIs continue independently between ticks. Never wait for `result.json`,
validation output, or a shell command instead of reading screens.

Invoke the built-in `supervisor_loop.mjs --wait --poll-seconds 15 --json`. It
reads every running surface every 15 seconds and returns that compact terminal
tail for a fresh Chief decision, even when its hash is unchanged. Screen
changes, immediate events, and post-`send` confirmations may return earlier.
Use `--once` only for a manual or diagnostic single tick.

Run only one supervisor invocation for a workflow. The runtime rejects a
competing invocation; keep the existing wait running rather than stopping it.
An unconsumed observation is returned again and is never overwritten by a new
batch.

Every observation returns `review_required: true` and
`workflow_terminal: false`. Chief must decide that batch and immediately start
the next `--wait`; it must not end supervision or return a final response while
the workflow remains nonterminal. Only `workflow_complete` returns
`workflow_terminal: true`.

Do not generate shell polling scripts, background watchers, nested wait loops,
or regex/rule-based programs that inspect screens or manufacture Chief
decisions. Automation may schedule the next tick but must not replace review of
an emitted observation.

```bash
node <skill-dir>/scripts/supervisor_loop.mjs \
  --project-dir <project-dir> \
  --workflow-id <workflow-id> \
  --wait --poll-seconds 15 --json
```

If the Chief process runs outside cmux, enable `CMUX_SOCKET_MODE=allowAll` so
the supervisor can push workflow status to each worker's sidebar.

## Setup

```bash
node <skill-dir>/scripts/setup.mjs --project-dir <project-dir> --json
```

Setup creates the minimal `.taskforce/` tree and verifies Git, cmux Automation
socket access, and at least one supported CLI in `PATH`. It does not execute CLI
version or model-list commands. If setup reports `cmux_not_running`, start the
cmux app with `open -a cmux`, wait a few seconds, then re-run setup; only the
`cmux_not_accessible` classification requires changing Automation socket settings.

## Contracts and nodes

```json
{
  "id": "task-a",
  "goal": "Implement the requested behavior",
  "boundaries": [],
  "validation": [],
  "done_when": []
}
```

```json
{
  "id": "node-a",
  "task": "task-a",
  "cli": "opencode",
  "model": null,
  "depends_on": []
}
```

Node ID is the runtime routing identity. Multiple nodes may reuse one task
contract.

## Four factual states

```text
pending → running → completed
pending/running → cancelled
```

Only `pending`, `running`, `completed`, and `cancelled` are lifecycle states.
Launch progress is `launch_phase` metadata.

Thinking, coding, tests, permission menus, questions, worker failure claims, and
CLI exits all remain `running`. They are facts in the observation; Chief owns
their meaning. There is no `blocked`, `launching`, or `failed` state.

## Four Chief actions

| Action | Effect |
|---|---|
| `continue` | Send nothing and keep observing |
| `send` | Send exact text or one TUI key after screen-hash validation |
| `relaunch` | Replace an attempt only after its worker has already exited |
| `complete` | Complete after checking goal and actual implementation |

`continue` is the default for active work. Thinking, Write/Edit execution,
streaming output, tests, debugging, partial implementation, elapsed time, an
unchanged screen, and files not yet appearing do not justify sending urgency,
reminders, task restatements, or “start now” prompts. Use `send` only for a
visible input request, concrete goal/boundary drift, or an explicit failure that
cannot proceed without guidance.

Decision batch:

```json
{
  "batch_id": "obs-...",
  "workflow_id": "build-ui",
  "decisions": [
    { "node_id": "ui", "action": "continue", "reason": "Normal progress" },
    {
      "node_id": "auth",
      "action": "send",
      "reason": "Trust only this project directory",
      "expected_screen_hash": "...",
      "key": "down"
    },
    {
      "node_id": "tests",
      "action": "relaunch",
      "reason": "The CLI exited",
      "instruction": "Inspect existing files before continuing",
      "cli": "opencode",
      "model": null
    }
  ]
}
```

Write it to:

```text
.taskforce/state/workflows/<workflow-id>/latest_decision_batch.json
```

The next tick consumes it against the previous persisted observation before
creating a new batch.

## `send`: correction and UI response

`send` unifies natural-language correction and permission/menu response. Runtime
does not classify the intent. A send contains exactly one of `input` (text) or
`key` (one TUI key).

Before sending, the dispatcher re-reads the surface and compares the complete
captured screen with `expected_screen_hash`. If the screen changed, it returns
`stale_screen` and sends nothing. This prevents a late answer from selecting a
different menu.

Examples:

```json
{ "node_id": "ui", "action": "send", "expected_screen_hash": "...", "input": "Keep the existing API", "submit": true }
```

```json
{ "node_id": "worker", "action": "send", "expected_screen_hash": "...", "key": "down" }
```

Official keys are `enter`, `tab`, `escape`, `backspace`, `delete`, `up`,
`down`, `left`, and `right`. Menu numbers are labels unless the TUI explicitly
documents them as shortcuts. Send one key per review: after navigation, re-read
the screen and verify the new highlight before sending `enter` with the new
screen hash. Text uses `cmux send`; keys use `cmux send-key`.

A successful cmux call means `input_delivered`, not that the TUI acted on it.
The next observation reports whether the screen changed. Send keeps the same
node, surface, process, and attempt and never uses relaunch merely to recover
from a permission menu.

## Permission authority

Chief owns permission judgment:

- approve safe, project-scoped reads/writes, tests, and ordinary commands;
- prefer a clearly scoped “trust this project” option when appropriate;
- inspect the visible command, requested scope, and risk before choosing an
  explicit menu action; never approve from keywords or the default selection
  alone;
- reject or ask the user for credentials, product authority, dangerous or
  irreversible operations, system/global access, or external commitments.

When asking the user, return `continue` and keep the node running. Do not create
a blocked lifecycle state.

## Relaunch

Runtime never interrupts a live worker for relaunch. Thinking duration, an
unchanged screen, streaming output, `stale_screen`, a stale correction, and a
missing artifact are not relaunch reasons. While the recorded worker PID is
alive—or liveness is unknown—the action is rejected and the original node,
surface, process, and attempt remain running and observable.

`relaunch` is accepted only after the worker PID has already exited, or for a
pending node with no active attempt. Recovery evidence retains the previous run
and surface.

There is no hard retry counter or blocked prerequisite. Chief owns the judgment.
Task splitting remains explicit workflow planning, not a runtime action.

## Completion

CLI exit and worker completion claims are not proof. Before `complete`, compare
goal and `done_when` with actual implementation, `result.json`,
`validation.json`, and current screen. Invalid result states never complete a
node automatically. The presence of an artifact or a stopped CLI must not end
the review loop; only Chief's verified `complete` decision does.

## Evidence

```text
.taskforce/state/workflows/<workflow-id>/
  latest_observation_batch.json
  last_consumed_batch.json
  decisions.jsonl
  interventions.jsonl
  recoveries.jsonl

.taskforce/runs/<workflow-id>/<node-id>/<attempt-id>/
  launch.json
  agent.pid
  prompt.txt
  command.json
  tui_exec.sh
  result.json
  validation.json
  interventions.jsonl
```

Every running surface is read on every scheduled tick and every tick produces a
fresh Chief review. Screen hashes describe change but never decide whether a
review is needed. The latest
emitted observation is overwritten, and durable history records
send/relaunch/complete, interventions, and recoveries. Screen snapshots and
repetitive continue actions are not accumulated.

Chief does not take over routine feature coding. Direct Chief coding still
requires user approval.
