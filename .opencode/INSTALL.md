# OpenCode

Taskforce can launch OpenCode as a CLI agent through workflow node configuration.

Example workflow node:

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

Keep model/provider choices in local project configuration. Do not commit private provider aliases or credentials.
