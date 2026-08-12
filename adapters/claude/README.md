# Claude Adapter

Claude Code should read:

```text
CLAUDE.md
AGENTS.md
```

The Claude session acts as Chief. It runs the supervisor loop, dispatches work to CLI agents, and makes decisions about workflow nodes.

## Runtime Contract

Each workflow node specifies `cli`; `model` is optional and defaults to `null`,
meaning the selected CLI starts on its own default model. Task contracts define
boundaries, validation, and completion criteria.

The adapter must not enumerate model identifiers or ask the user to choose one.
Set a node's model only when the user supplied an exact model ID. Agents launch
as interactive TUIs. When a node's model is non-null, pass it using the selected
CLI's supported TUI model argument; when it is null, omit model flags.
Taskforce task prompts carry coding and review behavior.
