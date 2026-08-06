# Codex Adapter

Codex uses the skill at:

```text
skills/taskforce/SKILL.md
```

For plugin distribution, use:

```text
.codex-plugin/plugin.json
```

The Codex host agent is the Chief. It runs short supervisor ticks, reads every active surface, and corrects runtime drift.

Primary installation:

```bash
npx skills add <GITHUB_OWNER>/taskforce --skill taskforce --agent codex --global
```

Local fallback:

```bash
./install.sh --agent codex --scope global
```

Installation copies the Skill only. Project CLI/model selection and terminal
preflight happen on first use.

## Runtime Contract

Each workflow node specifies `cli` and `model`; `model: null` means Codex
should use its CLI default. Task contracts define boundaries, validation, and
completion criteria.

Codex CLI agents are launched through the interactive Codex TUI. Discover
available models from the local Codex CLI when possible, then ask the user to
confirm the node configuration. If a node has a non-null model, pass it using
the Codex TUI's supported model argument; if the model is null, omit model
flags. Taskforce prompts carry coding and review intent rather than storing
that behavior in node config.
