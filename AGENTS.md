# Taskforce Agent Instructions

Use Taskforce when the user asks for multi-agent coding orchestration, terminal-visible coding agents, workflow supervision, or runtime agent control.

## Host Agent Role

You are the Chief. You run the supervisor loop and make decisions about workflow nodes.

## Minimal Workflow

1. Initialize or reuse `.taskforce/`.
2. Create task contracts at `.taskforce/tasks/<task-id>.json` with `{id, goal, boundaries[], validation[], done_when[]}`.
3. Create workflow nodes at `.taskforce/workflows/<workflow-id>.json`, each with `cli` and `model` fields.
4. Repeatedly run one short supervisor tick: collect surfaces → Chief reviews every current tail → dispatch decisions.
5. Loop until all nodes reach a terminal state (`completed` or `cancelled`).

Taskforce must read active cmux surfaces locally every 10–20 seconds. Use the
built-in `supervisor_loop.mjs --wait --poll-seconds 15 --json`; it returns only
when Chief review is needed. `--once` is for diagnostics. Never start a separate
wait for `result.json`, `questions.json`, validation output, or any other fixed
artifact: artifacts enrich observations but never block screen supervision.
Worker CLIs continue running independently between Chief ticks.
Every observation keeps the compact terminal tail. Read it from the bottom
upward: the current prompt, menu, confirmation, question, or selectable action
takes priority over earlier progress text and means the CLI is waiting for input.
Every emitted observation requires a fresh Chief decision for each included
node. Every 15-second read emits the current terminal tail, including unchanged
screens after `continue`; screen changes, immediate events, and one follow-up
after `send` may emit earlier. Elapsed Thinking time, absence of file output,
`screen_changed`, and `stale_screen` are never relaunch reasons.
`continue` is the default for active work. Thinking, Write/Edit execution,
streaming output, tests, debugging, partial implementation, elapsed time,
unchanged screens, and files not yet appearing are not reasons to send urgency,
reminders, task restatements, or “start now” prompts. Use `send` only for a
visible input request, concrete goal/boundary drift, or an explicit failure that
cannot proceed without guidance.
Permission menus, questions, worker failures, and CLI exits remain `running`;
they are observation facts, not lifecycle states. Chief decides whether to
continue, send input, relaunch, or complete.

Run exactly one built-in `--wait` invocation per review. After it returns, Chief
must inspect the observations and personally decide the action for every
included node before immediately starting the next wait. An observation with
`workflow_terminal: false` is not a stopping point: do not end supervision or
return a final response while the workflow remains nonterminal. Do not create
shell polling scripts, background watchers, nested wait loops, or regex/rule
programs to review screens or manufacture Chief decisions. Do not answer a
permission menu from keywords or its default selection alone: inspect the
visible command, requested scope, risk, and current highlight. TUI menu labels
are not text shortcuts unless the screen explicitly says so. Use `send` with
one official `key` (`up`, `down`, `left`, `right`, `enter`, `tab`, `escape`,
`backspace`, or `delete`) bound to `expected_screen_hash`; after navigation,
read the new screen and confirm its highlight before sending `enter`. Use
`input` only for text. The existence of `result.json`, validation output,
or a stopped CLI never ends supervision by itself; only Chief's verified
`complete` decision does.
If an invocation reports `supervisor_already_running`, keep the existing wait;
never stop it as though it were stuck. An unconsumed observation must be decided
before a new batch can be emitted. `input_delivered` confirms cmux transport,
not that the worker TUI acted on the input; verify the next screen.

## Decision Semantics

- **continue**: no terminal input
- **send**: send exact text or one TUI key after matching `expected_screen_hash`
- **relaunch**: replace an attempt only after its worker has already exited
- **complete**: mark node completed after goal/implementation review

Chief owns ordinary permission judgment and runtime recovery. For safe,
project-scoped operations, use `send` directly. Ask the user only for product
authority, credentials, dangerous or irreversible permissions, or external
input; keep the node running while waiting. Splitting work is workflow planning.
Do not take over routine feature coding; escalate only when direct Chief coding,
product authority, credentials, dangerous permissions, or external input is required.

## 4 Node Lifecycle States

`pending` → `running` → `completed` | `cancelled`

Launch progress is `launch_phase` metadata. There is no `blocked`, `launching`,
or `failed` lifecycle state.

## Evidence

Workflow-level batch evidence is under:

```text
.taskforce/state/workflows/<workflow-id>/
  latest_observation_batch.json
  last_consumed_batch.json
  decisions.jsonl
  interventions.jsonl
  recoveries.jsonl
```

Node-attempt evidence is under:

```text
.taskforce/runs/<workflow-id>/<node-id>/<attempt-id>/
  launch.json
  agent.pid
  interventions.jsonl
  result.json
  validation.json
```

Terminal output is the primary progress and direction signal. Worker artifacts
support completion review but never pause screen supervision.
