# Security

Taskforce coordinates coding agents that can read source code, run commands, and generate patches. Treat project-local artifacts as sensitive.

## Do Not Publish

Do not commit generated runtime artifacts from real projects:

- `.taskforce/runs/`
- `.taskforce/state/`
- `.taskforce/launchers/`

These files may contain prompts, private file paths, source snippets, secrets printed in logs, or model outputs.

## Reporting Issues

For public issues, remove private project content and replace paths, repository names, and model/provider details with placeholders.

For sensitive reports, open a private disclosure channel with the maintainers before sharing artifacts.

## Agent Safety

Taskforce does not make arbitrary agent output trusted. A worker completion
claim is only evidence: Chief must compare the requested goal with the actual
implementation and validation before marking the node complete. Permission
menu input is executed only through a Chief `send` action bound to the exact
screen hash Chief reviewed.
