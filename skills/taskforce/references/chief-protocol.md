# Chief protocol

Use the built-in `--wait --poll-seconds 15` supervisor while worker CLIs
continue independently. It returns each scheduled screen read for Chief review.

Run one `supervisor_loop.mjs --wait --poll-seconds 15 --json` invocation at a
time. After it returns, Chief personally reviews the observations, writes one
decision per included node, and immediately starts the next wait. A returned
observation has `workflow_terminal: false` and is not a stopping point; do not
end supervision or return a final response until the runtime reports
`workflow_terminal: true`. Never create a shell
polling script, another background watcher, nested wait loop, or regex/rule-based
decision program as a substitute for the built-in local wait and Chief.
If the runtime reports `supervisor_already_running`, keep that supervisor and
do not stop it. Every 15-second read returns the current tail for a fresh Chief
decision, including unchanged screens.

For every running surface:

1. Read the compact terminal tail from the bottom upward; the current prompt,
   menu, confirmation, question, or selectable action has priority over older
   progress text.
2. Compare visible work with goal, boundaries, and last action.
3. Return exactly one action: `continue`, `send`, `relaunch`, or `complete`.

`continue` is the default for active work. Thinking, Write/Edit execution,
streaming output, tests, debugging, partial implementation, elapsed time, an
unchanged screen, or missing future files are not reasons to send urgency,
reminders, task restatements, or “start now” prompts. Use `send` only for a
visible input request, concrete goal/boundary drift, or an explicit failure that
cannot proceed without guidance.

`send` handles both natural-language correction and TUI answers. Use `input`
only for text. For a TUI, use one official `key`: `enter`, `tab`, `escape`,
`backspace`, `delete`, `up`, `down`, `left`, or `right`. Always bind it to the
observed `expected_screen_hash`. Runtime re-reads the surface and sends nothing
if the screen changed. `input_delivered` confirms cmux transport only; the next
screen confirms whether the TUI acted on it.

Chief owns ordinary project-scoped permission decisions. If credentials,
product authority, system/global access, dangerous or irreversible operations,
or external commitments require the user, ask outside the runtime and return
`continue`; the node remains running.

For a permission menu, inspect the visible command, requested scope, risk, and
current highlight. Menu numbers are labels unless explicitly documented as
shortcuts. Send one navigation key, re-read and verify the new highlight, then
send `enter` against the new screen hash. Never approve solely because a keyword
is present or the default menu item is selected.

Never use `relaunch` while the worker PID is alive or its liveness is unknown.
Slow Thinking, delayed file output, unchanged screens, streaming output, and
`stale_screen` do not justify replacing a live worker. Runtime accepts relaunch
only after the worker has already exited, preserving live context by default.
Completion claims require goal and implementation review. Artifacts and process
exit are evidence only and cannot terminate supervision without Chief's
verified `complete` decision.
