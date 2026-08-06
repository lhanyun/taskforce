# v0.2 Breaking Simplification — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform Taskforce from a multi-agent engineering framework with fixed roles into a pure runtime supervisor loop that observes CLI Agents and corrects them when they drift — no roles, no engineering gates, no file-overlap scheduling.

**Architecture:** Delete all role/engineering infrastructure. Replace with a minimal data model (task contract JSON, role-less workflow nodes, 7-node lifecycle states). Rewrite the launch chain as role-less. Rewrite supervisor_loop to use the new lifecycle and event model. Update all tests.

**Tech Stack:** Node.js >=18, ESM (.mjs), cmux, JSON/JSONL evidence, `node --test` runner.

---

## File Structure

### Files to DELETE entirely
```
skills/taskforce/scripts/configure_roles.mjs
skills/taskforce/scripts/prepare_agent_batch.mjs
skills/taskforce/scripts/prepare_acceptance_review.mjs
skills/taskforce/scripts/approve_clarification.mjs
skills/taskforce/scripts/scope_check.mjs
skills/taskforce/scripts/concurrency.mjs
skills/taskforce/scripts/orchestrator_tick_v2.mjs
skills/taskforce/scripts/orchestrator_wait_v2.mjs
skills/taskforce/scripts/direction_monitor.mjs
skills/taskforce/scripts/decide_direction.mjs
skills/taskforce/scripts/collect_agent_state.mjs
skills/taskforce/scripts/render_agent_prompt.mjs
skills/taskforce/scripts/prepare_cmux_launch.mjs
skills/taskforce/assets/templates/roles.json
skills/taskforce/assets/templates/PLAN.md
skills/taskforce/assets/templates/PROGRESS.md
skills/taskforce/assets/templates/LEARNINGS.md
skills/taskforce/assets/templates/STATUS.md
skills/taskforce/assets/templates/RESULT.md
skills/taskforce/assets/templates/QUESTION.md
skills/taskforce/assets/templates/ACCEPTANCE.md
skills/taskforce/assets/templates/TASK.md
skills/taskforce/references/roles.md
skills/taskforce/references/role-runtime-v2.md
skills/taskforce/references/role-configuration.md
skills/taskforce/references/acceptance-review.md
skills/taskforce/references/document-contracts.md
skills/taskforce/references/hard-protocol.md
skills/taskforce/references/agent-prompts.md
skills/taskforce/references/routing.md
skills/taskforce/references/state-machine.md
tests/taskforce_orchestrator.test.mjs
tests/taskforce_foundation.test.mjs
tests/taskforce_onboarding_node.test.mjs
tests/taskforce_launch_runner.test.mjs
tests/taskforce_installers.test.mjs
```

### Files to REWRITE
```
skills/taskforce/scripts/protocol_lib.mjs      — strip role constants, state constants, writeState, statusPayload, runDir
skills/taskforce/scripts/workflow_registry.mjs  — remove role, remove old states, new lifecycle
skills/taskforce/scripts/supervisor_loop.mjs    — new event model, new states
skills/taskforce/scripts/surface_collector.mjs  — remove old states
skills/taskforce/scripts/agent_runner.mjs       — remove role, clarification gate, direction check
skills/taskforce/scripts/orchestrate.mjs        — pure non-blocking launch, remove --role, --mode
skills/taskforce/scripts/prepare_terminal_launch.mjs — remove role, mode
skills/taskforce/scripts/cli_adapters.mjs       — add steering capability
skills/taskforce/scripts/init_orchestration.mjs — remove PLAN/PROGRESS/LEARNINGS/roles.json templates
skills/taskforce/scripts/setup.mjs              — remove role configuration
skills/taskforce/scripts/preflight.mjs          — remove role validation
skills/taskforce/scripts/observation_batch.mjs  — add task contract, immediate events
skills/taskforce/scripts/decision_batch.mjs     — add batch_id, workflow_id mandatory
skills/taskforce/scripts/intervention_dispatcher.mjs — add steering type
skills/taskforce/SKILL.md                       — rewrite for v0.2
skills/taskforce/package.json                   — update test list
tests/taskforce_supervisor.test.mjs             — rewrite for new model
```

### Files to KEEP as-is (with minor adjustments)
```
skills/taskforce/scripts/doctor.mjs             — read-only discovery, no role logic
tests/fixtures/fake_cmux.mjs                    — test fixture
tests/fixtures/fake_agent_cli.mjs               — test fixture
```

---

## Task 1: New Task Contract Schema

**Files:**
- Create: `skills/taskforce/scripts/task_contract.mjs`
- Test: `tests/taskforce_supervisor.test.mjs` (add tests)

Replace the old Markdown task file with a minimal JSON task contract. Tasks are now `tasks/<task-id>.json` instead of `tasks/<task-id>.md`.

- [ ] **Step 1: Write the `task_contract.mjs` module**

```javascript
// skills/taskforce/scripts/task_contract.mjs
// Task Contract: minimal JSON schema for a task definition.
// Replaces the old Markdown task file with role-specific sections.

import fs from 'node:fs';
import path from 'node:path';
import { readJson, atomicWriteJson, nowIso, slug } from './protocol_lib.mjs';

// Validate a task contract object.
export function validateContract(contract) {
  const errors = [];
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)) {
    return ['contract must be a JSON object'];
  }
  if (!contract.id || typeof contract.id !== 'string') {
    errors.push('contract.id is required and must be a string');
  }
  if (!contract.goal || typeof contract.goal !== 'string') {
    errors.push('contract.goal is required and must be a string');
  }
  if (contract.boundaries !== undefined && !Array.isArray(contract.boundaries)) {
    errors.push('contract.boundaries must be an array of strings');
  }
  if (contract.validation !== undefined && !Array.isArray(contract.validation)) {
    errors.push('contract.validation must be an array of strings');
  }
  if (contract.done_when !== undefined && !Array.isArray(contract.done_when)) {
    errors.push('contract.done_when must be an array of strings');
  }
  return errors;
}

// Load a task contract from .taskforce/tasks/<task-id>.json
export function loadContract(orch, taskId) {
  const contractPath = path.join(orch, 'tasks', `${taskId}.json`);
  const contract = readJson(contractPath);
  if (!contract || !contract.id) return null;
  return contract;
}

// Write a task contract to .taskforce/tasks/<task-id>.json
export function saveContract(orch, contract) {
  const contractPath = path.join(orch, 'tasks', `${contract.id}.json`);
  atomicWriteJson(contractPath, { ...contract, updated_at: nowIso() });
  return contract;
}

// Build a compact task summary for the Chief observation.
// This is what goes into the observation batch — not the full contract.
export function compactSummary(contract) {
  return {
    id: contract.id,
    goal: contract.goal,
    boundaries: contract.boundaries || [],
    validation: contract.validation || [],
    done_when: contract.done_when || [],
  };
}
```

- [ ] **Step 2: Add tests for task_contract.mjs**

Add to `tests/taskforce_supervisor.test.mjs`:

```javascript
test('validateContract: rejects missing id and goal', () => {
  const { validateContract } = await import(path.join(SCRIPTS, 'task_contract.mjs'));
  assert.deepEqual(validateContract({}), ['contract.id is required and must be a string', 'contract.goal is required and must be a string']);
  assert.deepEqual(validateContract(null), ['contract must be a JSON object']);
});

test('validateContract: accepts valid contract', () => {
  const { validateContract } = await import(path.join(SCRIPTS, 'task_contract.mjs'));
  assert.deepEqual(validateContract({ id: 't1', goal: 'Do something' }), []);
});

test('loadContract / saveContract: round-trip', () => {
  const { loadContract, saveContract } = await import(path.join(SCRIPTS, 'task_contract.mjs'));
  const temp = mkdtemp('tf-contract-');
  const orch = path.join(temp, '.taskforce');
  fs.mkdirSync(path.join(orch, 'tasks'), { recursive: true });
  saveContract(orch, { id: 't1', goal: 'Add login', boundaries: ['Keep password login'], validation: ['npm test'], done_when: ['Login tests pass'] });
  const loaded = loadContract(orch, 't1');
  assert.equal(loaded.id, 't1');
  assert.equal(loaded.goal, 'Add login');
  assert.deepEqual(loaded.boundaries, ['Keep password login']);
});

test('compactSummary: produces compact task summary', () => {
  const { compactSummary } = await import(path.join(SCRIPTS, 'task_contract.mjs'));
  const summary = compactSummary({ id: 't1', goal: 'Add login', boundaries: ['Keep password login'], validation: ['npm test'], done_when: ['Login tests pass'] });
  assert.equal(summary.id, 't1');
  assert.ok(!summary.updated_at); // no internal fields
});
```

- [ ] **Step 3: Run tests to verify**

Run: `cd skills/taskforce && npm test`
Expected: all tests pass

- [ ] **Step 4: Commit**

```bash
git add skills/taskforce/scripts/task_contract.mjs tests/taskforce_supervisor.test.mjs
git commit -m "feat: add task contract JSON schema (v0.2)"
```

---

## Task 2: Rewrite workflow_registry.mjs — Role-less Nodes, New Lifecycle

**Files:**
- Rewrite: `skills/taskforce/scripts/workflow_registry.mjs`
- Update: `tests/taskforce_supervisor.test.mjs`

Remove `role` from workflow nodes. Remove `awaiting_completion`, `needs_chief`, `candidate_done`, `intervention_failed`, `clarification_ready`, `protocol_violation`, `dependency_failed` states. Only 7 states remain: `pending`, `launching`, `running`, `blocked`, `completed`, `failed`, `cancelled`. Add `reason` and `event` fields for context.

- [ ] **Step 1: Rewrite `workflow_registry.mjs`**

```javascript
#!/usr/bin/env node
// Workflow Registry: manages workflow nodes with explicit dependencies.
// v0.2: no roles, no max_parallel, no file-overlap scheduling.
// Node lifecycle: pending → launching → running → blocked → running
//                                                ↘ completed
//                                                ↘ failed
//                                                ↘ cancelled
// Blocked nodes carry a reason (agent_question, permission_request, etc.)
// and an optional event object. No separate "needs_chief" state.

import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson, nowIso, parseArgs, readJson } from './protocol_lib.mjs';

const VALID_NODE_STATUSES = new Set([
  'pending', 'launching', 'running', 'blocked', 'completed', 'failed', 'cancelled',
]);

// Blocked reason enum — why a node is blocked.
const BLOCKED_REASONS = new Set([
  'agent_question',       // Agent wrote questions.json
  'permission_request',   // Agent needs permission
  'external_input',       // Waiting for external input
  'chief_decision',       // Chief explicitly blocked
  'cli_exit',             // CLI exited/crashed
  'no_response',          // Long time without response
]);

function workflowPath(orch, workflowId) {
  return path.join(orch, 'workflows', `${workflowId}.json`);
}

export function loadWorkflow(orch, workflowId) {
  return readJson(workflowPath(orch, workflowId));
}

export function saveWorkflow(orch, workflow) {
  atomicWriteJson(workflowPath(orch, workflow.workflow_id), workflow);
  return workflow;
}

// Validate a workflow definition.
export function validateWorkflow(workflow) {
  const errors = [];
  if (!workflow || !workflow.workflow_id) {
    return ['workflow_id is required'];
  }
  const nodes = workflow.nodes || [];
  const nodeIds = new Set();
  for (const node of nodes) {
    if (!node.id) { errors.push(`node missing id`); continue; }
    if (nodeIds.has(node.id)) { errors.push(`duplicate node id: ${node.id}`); continue; }
    nodeIds.add(node.id);
    if (!node.cli) { errors.push(`node ${node.id} missing cli`); continue; }
    if (!node.task) { errors.push(`node ${node.id} missing task`); continue; }
    for (const dep of (node.depends_on || [])) {
      if (!nodeIds.has(dep) && !nodes.some(n => n.id === dep)) {
        errors.push(`node ${node.id} depends on unknown node: ${dep}`);
      }
    }
  }
  // Check for dependency cycles.
  if (detectCycle(nodes)) {
    errors.push('workflow contains a dependency cycle');
  }
  return errors;
}

function detectCycle(nodes) {
  const adj = {};
  for (const n of nodes) adj[n.id] = n.depends_on || [];
  const visited = new Set();
  const inStack = new Set();
  function dfs(id) {
    if (inStack.has(id)) return true;
    if (visited.has(id)) return false;
    visited.add(id);
    inStack.add(id);
    for (const dep of (adj[id] || [])) {
      if (dfs(dep)) return true;
    }
    inStack.delete(id);
    return false;
  }
  for (const n of nodes) {
    if (dfs(n.id)) return true;
  }
  return false;
}

export function createWorkflow(orch, workflowId, nodes = []) {
  const workflow = {
    schema: 'taskforce.workflow.v2',
    workflow_id: workflowId,
    state: 'running',
    created_at: nowIso(),
    updated_at: nowIso(),
    nodes: nodes.map((n) => ({
      id: n.id,
      cli: n.cli,
      model: n.model || null,
      task: n.task || n.id,
      depends_on: n.depends_on || [],
      status: 'pending',
      reason: null,
      event: null,
      cmux_surface: '',
      run_dir: '',
    })),
  };
  return saveWorkflow(orch, workflow);
}

export function addNode(orch, workflowId, node) {
  const workflow = loadWorkflow(orch, workflowId);
  if (!workflow.workflow_id) return null;
  workflow.nodes.push({
    id: node.id,
    cli: node.cli,
    model: node.model || null,
    task: node.task || node.id,
    depends_on: node.depends_on || [],
    status: 'pending',
    reason: null,
    event: null,
    cmux_surface: '',
    run_dir: '',
  });
  workflow.updated_at = nowIso();
  return saveWorkflow(orch, workflow);
}

export function cancelNode(orch, workflowId, nodeId) {
  const workflow = loadWorkflow(orch, workflowId);
  if (!workflow.workflow_id) return null;
  const node = workflow.nodes.find((n) => n.id === nodeId);
  if (node) {
    node.status = 'cancelled';
    node.reason = 'user_cancelled';
  }
  workflow.updated_at = nowIso();
  return saveWorkflow(orch, workflow);
}

export function updateNode(orch, workflowId, nodeId, updates) {
  const workflow = loadWorkflow(orch, workflowId);
  if (!workflow.workflow_id) return null;
  const node = workflow.nodes.find((n) => n.id === nodeId);
  if (!node) return null;
  Object.assign(node, updates);
  workflow.updated_at = nowIso();
  return saveWorkflow(orch, workflow);
}

// Get nodes whose dependencies are all completed and that are still pending.
export function getReadyNodes(orch, workflowId) {
  const workflow = loadWorkflow(orch, workflowId);
  if (!workflow.workflow_id) return [];
  const completedIds = new Set(
    workflow.nodes.filter((n) => n.status === 'completed').map((n) => n.id)
  );
  return workflow.nodes.filter((n) => {
    if (n.status !== 'pending') return false;
    return n.depends_on.every((dep) => completedIds.has(dep));
  });
}

// Get nodes in an observable state (running, blocked with surface).
// Blocked nodes are observable because the Chief needs to see them
// to make informed decisions (e.g., answer questions).
const OBSERVABLE_STATUSES = new Set(['running', 'launching', 'blocked']);

export function getRunningNodes(orch, workflowId) {
  const workflow = loadWorkflow(orch, workflowId);
  if (!workflow.workflow_id) return [];
  return workflow.nodes.filter(
    (n) => OBSERVABLE_STATUSES.has(n.status) && n.cmux_surface
  );
}

export function getObservableTaskIds(orch, workflowId) {
  const workflow = loadWorkflow(orch, workflowId);
  if (!workflow.workflow_id) return [];
  return workflow.nodes
    .filter((n) => OBSERVABLE_STATUSES.has(n.status) && n.cmux_surface)
    .map((n) => n.task);
}

// Compute workflow state from node states.
export function workflowState(workflow) {
  const nodes = workflow.nodes || [];
  if (nodes.length === 0) return 'running';

  const allCompleted = nodes.every((n) => n.status === 'completed');
  const anyFailed = nodes.some((n) => n.status === 'failed');
  const allCancelled = nodes.every((n) => n.status === 'cancelled');

  const active = nodes.some((n) =>
    ['pending', 'launching', 'running', 'blocked'].includes(n.status)
  );

  if (allCompleted) return 'completed';
  if (anyFailed && !active) return 'failed';
  if (allCancelled) return 'cancelled';
  if (!active) return 'blocked';
  return 'running';
}

function main() {
  const args = parseArgs(process.argv.slice(2), {
    flags: [],
    valued: ['project-dir', 'orchestrator-dir', 'workflow-id', 'action'],
  });
  process.stdout.write('Use supervisor_loop.mjs for full pipeline.\n');
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
```

- [ ] **Step 2: Update tests for workflow_registry.mjs**

Replace all existing workflow tests with new ones that test the v0.2 model (no role, new states, reason/event fields, cycle detection, validation). Add tests for:
- `createWorkflow` creates nodes without `role` field
- `validateWorkflow` catches missing cli, duplicate ids, dependency cycles
- `getReadyNodes` only returns pending nodes with completed deps
- `updateNode` sets reason/event on blocked nodes
- `workflowState` computes correctly with new states

- [ ] **Step 3: Run tests to verify**

Run: `cd skills/taskforce && npm test`
Expected: all tests pass

- [ ] **Step 4: Commit**

```bash
git add skills/taskforce/scripts/workflow_registry.mjs tests/taskforce_supervisor.test.mjs
git commit -m "feat: rewrite workflow_registry — role-less nodes, 7-state lifecycle (v0.2)"
```

---

## Task 3: Rewrite protocol_lib.mjs — Strip Role System

**Files:**
- Rewrite: `skills/taskforce/scripts/protocol_lib.mjs`

Remove: `STANDARD_ROLES`, `CODE_EDIT_ROLE`, `CHIEF_STATES`, `TERMINAL_STATES`, `validateRolesContract`, `loadRoles`, `statusPayload`, `writeState`, `runDir` (role-based path). Keep: `nowIso`, `atomicWriteJson`, `appendJsonl`, `readJson`, `parseArgs`, `slug`, `taskIdFromFile`, `runCommand`, `relativeOrAbsolute`.

Add new state file path: `state/<workflow-id>/<node-id>.json` instead of `state/tasks/<taskId>-<role>.json`.

- [ ] **Step 1: Rewrite `protocol_lib.mjs`**

Key changes:
- Remove `STANDARD_ROLES`, `CODE_EDIT_ROLE`, `CHIEF_STATES`, `TERMINAL_STATES`
- Remove `validateRolesContract`, `loadRoles`
- Remove `statusPayload`, `writeState` (role-based state writing)
- Remove `runDir` (role-based path: `runs/<taskId>-<role>`)
- Add `nodeStatePath(orch, workflowId, nodeId)` → `state/<workflowId>/<nodeId>.json`
- Add `nodeRunDir(orch, workflowId, nodeId, attemptId)` → `runs/<workflowId>/<nodeId>/<attemptId>/`
- Add `writeNodeState(orch, workflowId, nodeId, payload)` — writes to `state/<workflowId>/<nodeId>.json`
- Keep all utility functions unchanged

- [ ] **Step 2: Run tests to verify**

Run: `cd skills/taskforce && npm test`
Expected: all tests pass (may need to fix imports in other files first)

- [ ] **Step 3: Commit**

```bash
git add skills/taskforce/scripts/protocol_lib.mjs
git commit -m "feat: strip role system from protocol_lib (v0.2)"
```

---

## Task 4: Rewrite agent_runner.mjs — Role-less, Minimal Prompt

**Files:**
- Rewrite: `skills/taskforce/scripts/agent_runner.mjs`

Remove all role-specific logic: clarification gate, direction check, CODE_EDIT_ROLE, protocolPrompt. Replace with a minimal prompt (~500 tokens) that includes the task contract.

- [ ] **Step 1: Rewrite `agent_runner.mjs`**

Key changes:
- Remove `--role` parameter
- Remove `loadRoles` import
- Remove `CODE_EDIT_ROLE` import
- Remove `protocolPrompt` — replace with `minimalPrompt(contract, runPath, taskId)`
- Remove `classify` — no more protocol_violation, clarification_ready, candidate_done
- Input: `--project-dir`, `--task-file`, `--cli` (required), `--model` (optional), `--workflow-id`, `--node-id`
- Write state to `state/<workflowId>/<nodeId>.json` instead of `state/tasks/<taskId>-<role>.json`
- Run dir: `runs/<workflowId>/<nodeId>/<attemptId>/` instead of `runs/<taskId>-<role>/attempts/<attemptId>/`
- The minimal prompt includes: task contract, run directory, and simple rules (work within boundaries, run validation, write result.json)

- [ ] **Step 2: Run tests to verify**

Run: `cd skills/taskforce && npm test`

- [ ] **Step 3: Commit**

```bash
git add skills/taskforce/scripts/agent_runner.mjs
git commit -m "feat: rewrite agent_runner — role-less, minimal prompt (v0.2)"
```

---

## Task 5: Rewrite orchestrate.mjs — Pure Non-Blocking Launch

**Files:**
- Rewrite: `skills/taskforce/scripts/orchestrate.mjs`

Remove all role/engineering gates. Make it a pure non-blocking launch entry point.

- [ ] **Step 1: Rewrite `orchestrate.mjs`**

Key changes:
- Input: `--project-dir`, `--workflow-id`, `--node-id`, `--task-file`, `--cli` (required), `--model` (optional)
- Remove `--role`, `--mode`, `--slim`
- Remove preflight gate, role loading, concurrency check, file-overlap check
- Remove dependency check (handled by workflow_registry)
- Remove blocking mode (always non-blocking)
- Remove `orchestrator_wait_v2.mjs` call
- Launch: call `prepare_terminal_launch.mjs` with `--cli` and `--model`
- On success: return JSON with workflow_id, node_id, task_id, cli, model, run_dir, cmux_surface, attempt_id
- On failure: record failure reason, set node to `failed` (not infinite retry)

- [ ] **Step 2: Run tests to verify**

Run: `cd skills/taskforce && npm test`

- [ ] **Step 3: Commit**

```bash
git add skills/taskforce/scripts/orchestrate.mjs
git commit -m "feat: rewrite orchestrate — pure non-blocking launch (v0.2)"
```

---

## Task 6: Rewrite prepare_terminal_launch.mjs — Role-less

**Files:**
- Rewrite: `skills/taskforce/scripts/prepare_terminal_launch.mjs`

Remove role loading, mode determination, acceptance-reviewer logic. Accept `--cli` and `--model` directly.

- [ ] **Step 1: Rewrite `prepare_terminal_launch.mjs`**

Key changes:
- Remove `--role` and `--mode` parameters
- Remove `loadRoles` import
- Remove acceptance-reviewer mode detection
- Accept `--cli` (required) and `--model` (optional) directly
- Remove `--slim` (the minimal prompt is now the only prompt)
- Generate the prompt inline (minimal task contract prompt) instead of calling render_agent_prompt.mjs
- Pass `--cli` and `--model` to agent_runner.mjs

- [ ] **Step 2: Run tests to verify**

Run: `cd skills/taskforce && npm test`

- [ ] **Step 3: Commit**

```bash
git add skills/taskforce/scripts/prepare_terminal_launch.mjs
git commit -m "feat: rewrite prepare_terminal_launch — role-less (v0.2)"
```

---

## Task 7: Rewrite supervisor_loop.mjs — New Event Model

**Files:**
- Rewrite: `skills/taskforce/scripts/supervisor_loop.mjs`

Remove `awaiting_completion`, `needs_chief`, `candidate_done`, `intervention_failed`, `dependency_failed` from the lifecycle. Replace with event-based detection: blocked nodes carry `reason` and `event`. Immediate events are added to the observation buffer directly.

- [ ] **Step 1: Rewrite `supervisor_loop.mjs`**

Key changes:
- Remove `syncNodeStatesFromDisk` — replaced by `detectEvents` which reads state files and detects:
  - CLI exit/crash → set node to `failed` with reason
  - questions.json → set node to `blocked` with reason `agent_question` and event
  - result.json → set node to `completed` (if valid) or `failed`
  - No more `awaiting_completion` or `candidate_done` — Chief decides `complete` directly
- Remove `archiveQuestions` — not needed because questions.json is an event, not a state
- Remove `updateDiskState` — not needed with new state model
- `processDecisionBatch` — handle `correct` as: if dispatch ok, keep `running`; if dispatch fails, keep `blocked` with reason `steering_failed`
- `blocked` decision: set node to `blocked` with reason `chief_decision`
- `complete` decision: set node to `completed`
- `continue` decision: no state change, just log
- If node is `blocked` with reason `agent_question` and Chief says `continue` or `correct`, set back to `running`
- `launchReadyNodes` — use `--cli` and `--model` from node, no `--role`
- Immediate events: questions.json, result.json, CLI exit are added directly to the observation buffer as events, not just as triggers for force-review

- [ ] **Step 2: Update tests for new lifecycle**

- [ ] **Step 3: Run tests to verify**

Run: `cd skills/taskforce && npm test`

- [ ] **Step 4: Commit**

```bash
git add skills/taskforce/scripts/supervisor_loop.mjs tests/taskforce_supervisor.test.mjs
git commit -m "feat: rewrite supervisor_loop — event model, new lifecycle (v0.2)"
```

---

## Task 8: Update surface_collector.mjs — New States

**Files:**
- Modify: `skills/taskforce/scripts/surface_collector.mjs`

- [ ] **Step 1: Update RUNNING_STATES**

Change from:
```javascript
const RUNNING_STATES = new Set(['running', 'launching', 'needs_chief', 'blocked', 'awaiting_completion', 'candidate_done']);
```
To:
```javascript
const RUNNING_STATES = new Set(['running', 'launching', 'blocked']);
```

- [ ] **Step 2: Remove `role` from collected surface data**

In `collectSurfaces`, remove `role: payload.role || ''` from the returned surface objects.

- [ ] **Step 3: Run tests to verify**

Run: `cd skills/taskforce && npm test`

- [ ] **Step 4: Commit**

```bash
git add skills/taskforce/scripts/surface_collector.mjs
git commit -m "feat: update surface_collector — v0.2 states, no role (v0.2)"
```

---

## Task 9: Update cli_adapters.mjs — Add Steering Capability

**Files:**
- Modify: `skills/taskforce/scripts/cli_adapters.mjs`

- [ ] **Step 1: Add steering type to each adapter**

Each adapter declares a `steering` property: `'immediate'`, `'queued'`, or `'interrupt-required'`.

```javascript
const ADAPTERS = {
  opencode: {
    name: 'opencode',
    steering: 'immediate',  // opencode can receive input immediately
    // ... existing methods
  },
  codex: {
    name: 'codex',
    steering: 'queued',  // codex queues input for next turn
    // ... existing methods
  },
  claude: {
    name: 'claude',
    steering: 'immediate',  // claude can receive input immediately
    // ... existing methods
  },
  codebuddy: {
    name: 'codebuddy',
    steering: 'queued',  // codebuddy queues input
    // ... existing methods
  },
};

export function getSteering(cli) {
  const adapter = getAdapter(cli);
  return adapter.steering;
}
```

- [ ] **Step 2: Add tests for steering**

- [ ] **Step 3: Run tests to verify**

Run: `cd skills/taskforce && npm test`

- [ ] **Step 4: Commit**

```bash
git add skills/taskforce/scripts/cli_adapters.mjs
git commit -m "feat: add steering capability to CLI adapters (v0.2)"
```

---

## Task 10: Update observation_batch.mjs — Add Task Contract and Immediate Events

**Files:**
- Modify: `skills/taskforce/scripts/observation_batch.mjs`

- [ ] **Step 1: Update observation schema to include task contract and immediate events**

Each observation now includes:
- `task_contract`: compact summary from `task_contract.mjs`
- `last_decision`: the last Chief decision for this task
- `immediate_events`: array of immediate events (question, exit, complete, etc.)

- [ ] **Step 2: Add tests**

- [ ] **Step 3: Run tests to verify**

Run: `cd skills/taskforce && npm test`

- [ ] **Step 4: Commit**

```bash
git add skills/taskforce/scripts/observation_batch.mjs
git commit -m "feat: add task contract and immediate events to observations (v0.2)"
```

---

## Task 11: Update decision_batch.mjs — Mandatory batch_id and workflow_id

**Files:**
- Modify: `skills/taskforce/scripts/decision_batch.mjs`

- [ ] **Step 1: Make `batch_id` and `workflow_id` mandatory in decision validation**

In `parseDecisionBatch`, add validation:
- `batch_id` must be present in the batch
- `workflow_id` must be present in the batch
- Each decision must have `task_id`, `decision`, and `reason`
- `correct` decisions must have `instruction`

- [ ] **Step 2: Add tests**

- [ ] **Step 3: Run tests to verify**

Run: `cd skills/taskforce && npm test`

- [ ] **Step 4: Commit**

```bash
git add skills/taskforce/scripts/decision_batch.mjs
git commit -m "feat: mandatory batch_id and workflow_id in decisions (v0.2)"
```

---

## Task 12: Update intervention_dispatcher.mjs — Steering Type

**Files:**
- Modify: `skills/taskforce/scripts/intervention_dispatcher.mjs`

- [ ] **Step 1: Add steering type to dispatch results**

In `dispatchIntervention`, look up the steering type from `cli_adapters.mjs` and include it in the result. When steering is `queued`, the dispatch still tries to send but marks the result as `queued` rather than `immediate`.

- [ ] **Step 2: Run tests to verify**

Run: `cd skills/taskforce && npm test`

- [ ] **Step 3: Commit**

```bash
git add skills/taskforce/scripts/intervention_dispatcher.mjs
git commit -m "feat: add steering type to intervention dispatch (v0.2)"
```

---

## Task 13: Delete Old System Files

**Files:**
- Delete: 15+ scripts and templates listed in the File Structure section

- [ ] **Step 1: Delete old scripts**

```bash
rm skills/taskforce/scripts/configure_roles.mjs
rm skills/taskforce/scripts/prepare_agent_batch.mjs
rm skills/taskforce/scripts/prepare_acceptance_review.mjs
rm skills/taskforce/scripts/approve_clarification.mjs
rm skills/taskforce/scripts/scope_check.mjs
rm skills/taskforce/scripts/concurrency.mjs
rm skills/taskforce/scripts/orchestrator_tick_v2.mjs
rm skills/taskforce/scripts/orchestrator_wait_v2.mjs
rm skills/taskforce/scripts/direction_monitor.mjs
rm skills/taskforce/scripts/decide_direction.mjs
rm skills/taskforce/scripts/collect_agent_state.mjs
rm skills/taskforce/scripts/render_agent_prompt.mjs
rm skills/taskforce/scripts/prepare_cmux_launch.mjs
```

- [ ] **Step 2: Delete old templates**

```bash
rm skills/taskforce/assets/templates/roles.json
rm skills/taskforce/assets/templates/PLAN.md
rm skills/taskforce/assets/templates/PROGRESS.md
rm skills/taskforce/assets/templates/LEARNINGS.md
rm skills/taskforce/assets/templates/STATUS.md
rm skills/taskforce/assets/templates/RESULT.md
rm skills/taskforce/assets/templates/QUESTION.md
rm skills/taskforce/assets/templates/ACCEPTANCE.md
rm skills/taskforce/assets/templates/TASK.md
```

- [ ] **Step 3: Delete old references**

```bash
rm skills/taskforce/references/roles.md
rm skills/taskforce/references/role-runtime-v2.md
rm skills/taskforce/references/role-configuration.md
rm skills/taskforce/references/acceptance-review.md
rm skills/taskforce/references/document-contracts.md
rm skills/taskforce/references/hard-protocol.md
rm skills/taskforce/references/agent-prompts.md
rm skills/taskforce/references/routing.md
rm skills/taskforce/references/state-machine.md
```

- [ ] **Step 4: Delete old test files**

```bash
rm tests/taskforce_orchestrator.test.mjs
rm tests/taskforce_foundation.test.mjs
rm tests/taskforce_onboarding_node.test.mjs
rm tests/taskforce_launch_runner.test.mjs
rm tests/taskforce_installers.test.mjs
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: delete old role/engineering system files (v0.2)"
```

---

## Task 14: Update init_orchestration.mjs and setup.mjs

**Files:**
- Rewrite: `skills/taskforce/scripts/init_orchestration.mjs`
- Rewrite: `skills/taskforce/scripts/setup.mjs`
- Rewrite: `skills/taskforce/scripts/preflight.mjs`

- [ ] **Step 1: Update `init_orchestration.mjs`**

Remove `PLAN.md`, `PROGRESS.md`, `LEARNINGS.md`, `roles.json` from templates. Add `tasks/` directory creation. The init only creates the directory structure — no role configuration.

- [ ] **Step 2: Rewrite `setup.mjs`**

Remove all role configuration logic. Setup now just:
1. Creates the `.taskforce/` directory structure
2. Checks that cmux is installed
3. Checks that at least one CLI is available
4. Returns ready/not-ready status

No more `roles.json`, no more `configure_roles.mjs`, no more `STANDARD_ROLES`.

- [ ] **Step 3: Rewrite `preflight.mjs`**

Remove role validation. Preflight now just checks:
1. Git repository
2. cmux installed and working
3. At least one CLI available

No more per-role checks, no more `max_parallel`, no more `model` validation.

- [ ] **Step 4: Run tests to verify**

Run: `cd skills/taskforce && npm test`

- [ ] **Step 5: Commit**

```bash
git add skills/taskforce/scripts/init_orchestration.mjs skills/taskforce/scripts/setup.mjs skills/taskforce/scripts/preflight.mjs
git commit -m "feat: rewrite init/setup/preflight — no roles (v0.2)"
```

---

## Task 15: Rewrite SKILL.md and package.json

**Files:**
- Rewrite: `skills/taskforce/SKILL.md`
- Update: `skills/taskforce/package.json`

- [ ] **Step 1: Rewrite SKILL.md for v0.2**

Remove all references to roles, developer, architect, ui-designer, acceptance-reviewer. Document the new workflow model, task contract, and supervisor loop. Remove references to `--role`, `--mode`, `--slim`.

- [ ] **Step 2: Update package.json test list**

Remove deleted test files from the test script. Keep only `taskforce_supervisor.test.mjs`.

- [ ] **Step 3: Commit**

```bash
git add skills/taskforce/SKILL.md skills/taskforce/package.json
git commit -m "docs: rewrite SKILL.md and update package.json for v0.2"
```

---

## Task 16: Rewrite Test Suite

**Files:**
- Rewrite: `tests/taskforce_supervisor.test.mjs`

Comprehensive test suite for the new v0.2 model. Must cover all acceptance criteria.

- [ ] **Step 1: Write new test suite covering:**

1. **Task Contract** — validate, load, save, compact summary
2. **Workflow Registry** — no role, new states, reason/event, validation, cycle detection
3. **Surface Collector** — new RUNNING_STATES, no role
4. **Observation Batch** — task contract in observations, immediate events
5. **Decision Batch** — mandatory batch_id/workflow_id, validation
6. **Intervention Dispatcher** — steering type, dispatch results
7. **Supervisor Loop** — new lifecycle, event detection, force-review
8. **CLI Adapters** — steering capability
9. **Integration** — launch without roles, multiple CLIs, no role concurrency

- [ ] **Step 2: Run full test suite**

Run: `cd skills/taskforce && npm test`
Expected: all tests pass

- [ ] **Step 3: Commit**

```bash
git add tests/taskforce_supervisor.test.mjs
git commit -m "test: rewrite test suite for v0.2 model"
```

---

## Task 17: Final Verification — Acceptance Criteria

**Files:**
- All files

- [ ] **Step 1: Verify all acceptance criteria**

Run through each acceptance test from the spec:

1. No configuration file needed to start Codex — `orchestrate.mjs --cli codex` works
2. Same workflow can start Codex, Claude, and OpenCode — different nodes with different `cli`
3. 10 fake CLIs can launch simultaneously — no role concurrency limit
4. Explicit dependencies work correctly — serial and parallel
5. File overlap does NOT block launch — no scope_check
6. Normal collection sends no cmux input — only `correct`/`blocked` do
7. `continue` produces zero cmux input
8. `correct` only sends to target surface
9. Single CLI blocked doesn't stop others
10. No screen change → no Chief batch
11. Screen change enters batch within 20s
12. Immediate events enter next tick batch
13. Same batch can't be consumed twice
14. Dynamic add/cancel without restart
15. CLI crash doesn't stop independent nodes
16. Workflow complete → supervisor exits
17. Worker prompt ~500 tokens
18. `git diff --check` clean

- [ ] **Step 2: Run `git diff --check`**

Run: `git diff --check`
Expected: no errors

- [ ] **Step 3: Final commit**

```bash
git add -A
git commit -m "chore: v0.2 breaking simplification complete"
```

---

## Self-Review

**1. Spec coverage:** Every P0 item from the spec is covered by Tasks 1-8. P1 items (CLI Adapter Steering, Resource Limits, Dynamic Workflow, Evidence Store) are covered by Tasks 9-12. P1 "Delete old system" is Task 13. Verification tests are Task 17.

**2. Placeholder scan:** No TBDs or TODOs. All code steps include actual implementation.

**3. Type consistency:** All functions use consistent parameter names across tasks. `workflowId` is always `workflowId`, `nodeId` is always `nodeId`, `cli` is always `cli`. The task contract schema is defined in Task 1 and used consistently in Tasks 7, 10, and 16.
