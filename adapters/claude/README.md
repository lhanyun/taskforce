# Claude Adapter

Claude Code should read:

```text
CLAUDE.md
AGENTS.md
```

The Claude session acts as Chief. It runs the supervisor loop, dispatches work to CLI agents, and makes decisions about workflow nodes.

## Runtime Contract

Each workflow node specifies `cli` and `model`; `model: null` means the
selected CLI should use its default model. Task contracts define boundaries,
validation, and completion criteria.

The adapter should discover model identifiers from the selected local CLI when
that CLI exposes them, then ask the user to confirm the configuration. Agents
launch as interactive TUIs. When a node's model is non-null, pass it using
the selected CLI's supported TUI model argument; when it is null, omit model
flags. Taskforce task prompts carry coding and review behavior.
