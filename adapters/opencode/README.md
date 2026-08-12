# OpenCode Adapter

Install the Taskforce host skill with:

```bash
npx skills add <GITHUB_OWNER>/taskforce --skill taskforce --agent opencode --global
```

Or use the inspected local fallback:

```bash
./install.sh --agent opencode --scope global
```

OpenCode is commonly used as a CLI agent in Taskforce workflow nodes.

Configure it in a workflow node:

```json
{
  "id": "backend-auth",
  "task_contract": "backend-auth",
  "cli": "opencode",
  "model": null,
  "depends_on": [],
  "status": "pending"
}
```

`model: null` is the default and means OpenCode starts on the model the user
already configured for it. Do not put private provider aliases in the public
default template.

## Runtime Contract

- Never enumerate OpenCode's models or ask the user to pick one. Set `model`
  only when the user supplied an exact model ID.
- Launch OpenCode only as an interactive TUI. Taskforce supplies the task prompt
  through the selected terminal backend.
- When `model` is non-null, pass it using OpenCode's supported TUI model
  argument. When `model` is null, omit any model argument.
- Keep node config limited to `cli` and an optional `model`; task scope,
  boundaries, and validation belong in the task contract.
