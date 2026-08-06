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
  "model": "your-model-name",
  "depends_on": [],
  "status": "pending"
}
```

`model: null` means OpenCode should use its default model. Do not put private
provider aliases in the public default template. Installation does not write
this project configuration; first-use discovery and explicit user confirmation
do.

## Runtime Contract

- Discover models from the installed OpenCode CLI when the CLI exposes a stable
  list or help surface. If discovery is unavailable, accept user-provided model
  identifiers without inventing defaults.
- Launch OpenCode only as an interactive TUI. Taskforce supplies the task prompt
  through the selected terminal backend.
- When `model` is non-null, pass it using OpenCode's supported TUI model
  argument. When `model` is null, omit any model argument.
- Keep node config limited to `cli` and `model`; task scope, boundaries, and
  validation belong in the task contract.
