# Adapters

Taskforce has one core protocol and multiple host-agent adapters.

Adapters should stay thin:

- point the host agent to `AGENTS.md` or `skills/taskforce/SKILL.md`;
- explain where local skills/plugins are installed;
- avoid duplicating the full protocol;
- keep model/provider choices in examples, not defaults.

## Workflow Node Configuration

Each workflow node specifies `cli`. `model` is optional and defaults to `null`,
meaning the CLI starts on the default model the user already configured for it.
Task contracts define boundaries, validation, and completion criteria separately.

Adapters are TUI launchers. They should never enumerate models, infer one from
the task, or ask the user to pick one; a model belongs in node config only when
the user supplied an exact model ID, and it is then passed through the CLI's
supported TUI model argument. They should not encode task behavior in node
config; task contracts and prompts carry that intent.

Current adapters:

- `codex/`
- `claude/`
- `opencode/`
- `generic/`
- `cursor/`
