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
copies the Skill. First use scans `PATH` for supported CLIs, checks cmux
Automation access from Cursor, and runs preflight.

## Runtime Contract

Each workflow node specifies `cli`; `model` is optional and defaults to `null`,
meaning the selected CLI starts on its own default model. Task contracts define
boundaries, validation, and completion criteria.

Cursor acts as Chief while CLI agents run in interactive TUIs through the
configured terminal backend. Do not enumerate a CLI's models or ask the user to
choose one; set a node's model only when the user supplied an exact model ID,
and pass it only with that CLI's supported TUI model argument. Omit model flags
for null models. Task contracts and rendered prompts carry coding and review
intent.
