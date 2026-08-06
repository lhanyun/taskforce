# Contributing

Taskforce is protocol-first. Keep changes small, testable, and adapter-neutral.

## Guidelines

- Keep `skills/taskforce/SKILL.md` concise.
- Put detailed workflow rules in `skills/taskforce/references/`.
- Put deterministic behavior in scripts instead of long prompts.
- Do not add personal model names, private provider aliases, or local absolute paths.
- Do not make one host agent the only supported Chief.
- Keep CLI adapter examples generic; put provider-specific examples under `examples/`.

## Validation

Run:

```bash
node --test tests/*.test.mjs
for f in skills/taskforce/scripts/*.mjs; do node --check "$f"; done
bash -n install.sh
```
