# Programmatic control

```bash
node <skill-dir>/scripts/setup.mjs --project-dir <project-dir> --json
```

```bash
node <skill-dir>/scripts/supervisor_loop.mjs \
  --project-dir <project-dir> \
  --workflow-id <workflow-id> \
  --wait --poll-seconds 15 --json
```

`--wait` reads cmux on the configured interval and returns every current tail
for a fresh Chief review, including unchanged screens. Use `--once` for a
diagnostic single tick. Only one supervisor may run per workflow; a competing
invocation returns `supervisor_already_running`. A pending observation is
returned again until its bound decision is consumed.

Every observation response includes `review_required: true`,
`workflow_terminal: false`, `host_instruction`, and `chief_instruction`. The
host must judge the included observations, write their batch-bound decisions,
and immediately start the next `--wait`. It must not end supervision or return
a final response while `workflow_terminal` is false. Only
`workflow_complete` returns `workflow_terminal: true`.

Write Chief output to:

```text
.taskforce/state/workflows/<workflow-id>/latest_decision_batch.json
```

```json
{
  "batch_id": "obs-...",
  "workflow_id": "workflow-id",
  "decisions": [
    { "node_id": "a", "action": "continue", "reason": "Normal progress" },
    { "node_id": "b", "action": "send", "reason": "Move to the project-scoped permission option", "expected_screen_hash": "...", "key": "down" },
    { "node_id": "c", "action": "relaunch", "reason": "CLI exited", "instruction": "Inspect current files first", "cli": "opencode", "model": null },
    { "node_id": "d", "action": "complete", "reason": "Goal and implementation verified" }
  ]
}
```

Each tick consumes actions for the previous batch before creating the next
observation. `send` is hash-bound and contains exactly one of text `input` or a
single official TUI `key`. After a navigation key, inspect the next screen and
use its new hash before sending `enter`. `relaunch` has no blocked-state
prerequisite.
