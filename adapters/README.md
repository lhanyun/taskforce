# Adapters

Taskforce has one core protocol and multiple host-agent adapters.

Adapters should stay thin:

- point the host agent to `AGENTS.md` or `skills/taskforce/SKILL.md`;
- explain where local skills/plugins are installed;
- avoid duplicating the full protocol;
- keep model/provider choices in examples, not defaults.

## Workflow Node Configuration

Each workflow node specifies `cli` and `model`. `model: null` means use the
CLI's default model. Task contracts define boundaries, validation, and
completion criteria separately.

Adapters are TUI launchers. They should discover available model identifiers
from the local CLI when possible, ask the user to confirm node configuration,
and pass a configured model only through the CLI's supported TUI model argument.
They should not encode task behavior in node config; task contracts and prompts
carry that intent.

Current adapters:

- `codex/`
- `claude/`
- `opencode/`
- `generic/`
- `cursor/`
