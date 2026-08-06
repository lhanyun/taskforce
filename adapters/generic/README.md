# Generic Adapter

Any host agent can use Taskforce if it can:

1. Read `AGENTS.md`.
2. Execute scripts under `skills/taskforce/scripts/`.
3. Launch CLI agents through a terminal/session backend.
4. Inspect `.taskforce/runs/**` evidence.
5. Keep integration methodology outside Taskforce's runtime loop.

The protocol does not require the host agent to be Codex.

## Runtime Contract

Each workflow node specifies `cli` and `model`; `model: null` means the
selected CLI's default model. Task contracts define boundaries, validation,
and completion criteria.

A generic adapter should discover model identifiers from the selected local CLI
when a reliable discovery surface exists, then ask the user to confirm the
configuration. Launch agents as interactive TUIs through a terminal or session
backend. If a node has a non-null model, pass it with the selected CLI's
documented TUI model argument; if the model is null, omit model flags. Keep
task behavior in task contracts and prompts.
