# Taskforce

**One Skill for running supervised agent loops from mainstream coding CLIs such
as Codex CLI, Claude Code, and OpenCode.**

You name the CLIs, tasks, dependencies, and optional models. Taskforce runs the
workers in cmux, keeps reading their real terminals, handles runtime input,
corrects drift, and verifies the result.

> **One Skill · Mainstream coding CLIs · Multiple workers · Semantic supervision**

[中文说明](README.zh-CN.md)

## Quick start

### 1. Prepare the runtime

- Codex CLI, Claude Code, OpenCode, or another environment that supports Agent
  Skills and local commands;
- [cmux](https://cmux.com/) with Automation socket access enabled;
- at least one worker CLI in `PATH`: `opencode`, `codex`, `claude`, or
  `codebuddy`;
- Node.js 18+ and a Git project.

The CLI running Taskforce and the worker CLI may be the same tool or different
ones.

### 2. Install the Skill

For example, install it globally for Codex:

```bash
npx skills add lhanyun/taskforce \
  --skill taskforce --agent codex --global
```

Replace `codex` with `cursor`, `opencode`, or `claude-code` for another
environment. For a project installation, run it from the project root without
`--global`.

### 3. Describe your loop

Sequential work:

```text
Use Taskforce. Launch opencode to implement the settings page and run its tests.
When it finishes, launch codebuddy to inspect the code and tests and fix the
issues it finds. Keep supervising until the work is truly complete.
```

Parallel work:

```text
Use Taskforce. Launch codex for the backend API and opencode for the frontend in
parallel. When both finish, launch claude for an overall review. Supervise the
whole workflow.
```

A description can include the CLI, task, ordering, completion conditions, and
an exact model ID supported by that CLI. Without a model override, the CLI uses
its default. There is no workflow JSON, profile system, or polling script to
write.

## What Taskforce does

```text
record explicit tasks and dependencies
  → launch worker CLIs in cmux
  → read every real TUI every 10–20 seconds
  → continue, answer a menu, correct drift, or recover an exited worker
  → check the goal, implementation, and validation
```

Workers continue independently between reviews. Fixed artifacts add evidence;
they never pause screen supervision or complete a task by themselves.

## Why Taskforce?

| Without Taskforce | With Taskforce |
|---|---|
| Learn another agent control platform | Add one Skill to the coding CLI you already use |
| Open and switch between terminals manually | Describe a sequential or parallel loop in chat |
| Wait for eventual agent replies | Observe the real TUI every 10–20 seconds |
| Discover permission menus after work stalls | Inspect scope and operate the original TUI |
| Restart to correct direction and lose context | Send guidance to the existing surface |
| Finish when a CLI exits or claims success | Check implementation and validation first |

Taskforce does not choose agents for you. It runs the CLIs you name and keeps
watching how they actually work.

## Runtime judgment

```text
Thinking / coding / testing
  → continue; do not rush it

project-scoped permission menu
  → inspect command and scope → send one key → re-read the screen

goal or boundary drift
  → send a concrete correction to the same TUI

worker claims completion
  → inspect goal, code, and tests → complete
```

Thinking duration, an unchanged screen, and missing files are not relaunch
reasons. The runtime never kills a live worker merely to relaunch it.

## Small runtime model

```text
pending → running → completed
pending/running → cancelled
```

The supervisor has four actions:

| Action | Meaning |
|---|---|
| `continue` | Send nothing and keep observing |
| `send` | Send text or one TUI key to the current surface |
| `relaunch` | Create a new attempt after the old worker exits |
| `complete` | Finish after checking the goal and implementation |

Menu operations send one key at a time and validate the complete screen hash
before input. A changed screen returns `stale_screen` instead of sending an old
choice to a new menu.

## Scope

Taskforce is not an engineering methodology, role system, model router, patch
integration framework, or general workflow platform. It focuses on runtime
observation and guidance for coding CLIs.

You keep your existing CLI habits, including Skills, project instructions,
model configuration, permission settings, and engineering workflow. Taskforce
does not replace how a worker CLI operates; it adds an outer layer for launch,
screen observation, and necessary runtime intervention.

## Development

```bash
cd skills/taskforce
npm test
```

See the [runtime specification](specs/2026-08-04-runtime-supervisor-loop-redesign.md)
and [supervision decision protocol](skills/taskforce/references/chief-protocol.md).
Read [CONTRIBUTING.md](CONTRIBUTING.md) before changing the runtime protocol.
