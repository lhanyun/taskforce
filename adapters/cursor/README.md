# Cursor Adapter

Install project-locally with the primary Agent Skills CLI:

```bash
npx skills add <GITHUB_OWNER>/taskforce --skill taskforce --agent cursor
```

Or globally:

```bash
npx skills add <GITHUB_OWNER>/taskforce --skill taskforce --agent cursor --global
```

The fallback installer targets `.agents/skills/taskforce` for project scope
and `$HOME/.cursor/skills/taskforce` for global scope.

Reload Cursor, open a Git project, and invoke `/taskforce`. Installation only
copies the Skill. First use discovers CLIs/models, checks cmux Automation
access from Cursor, and runs preflight.

## Runtime Contract

Each workflow node specifies `cli` and `model`; `model: null` means the
selected CLI should use its default model. Task contracts define boundaries,
validation, and completion criteria.

Cursor acts as Chief while CLI agents run in interactive TUIs through the
configured terminal backend. Discover models from each selected CLI when
available, ask the user to confirm the node configuration, and pass a non-null
model only with that CLI's supported TUI model argument. Omit model flags for
null models. Task contracts and rendered prompts carry coding and review intent.
