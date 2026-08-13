#!/usr/bin/env node
// Minimal workflow registry for the runtime supervisor loop.

import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  appendJsonl,
  atomicWriteJson,
  normalizeModel,
  nowIso,
  parseArgs,
  processIsAlive,
  readAttemptPid as readAgentPid,
  readJson,
  writeNodeState,
} from './protocol_lib.mjs';
import { listAvailableClis, resolveCmuxPath } from './doctor.mjs';
import { ensureCliAvailable, selectCli } from './cli_selector.mjs';

function workflowPath(orch, workflowId) {
  return path.join(orch, 'workflows', `${workflowId}.json`);
}

export function loadWorkflow(orch, workflowId) {
  const workflow = readJson(workflowPath(orch, workflowId));
  let migrated = false;
  if (Object.prototype.hasOwnProperty.call(workflow, 'state')) {
    delete workflow.state;
    migrated = true;
  }
  if (Array.isArray(workflow.nodes)) {
    for (const node of workflow.nodes) {
      if (['launching', 'blocked', 'failed'].includes(node.status)) { node.status = 'running'; migrated = true; }
      if (node.last_decision && !node.last_action) { node.last_action = node.last_decision; migrated = true; }
      if (node.retry_reason && !node.relaunch_reason) { node.relaunch_reason = node.retry_reason; migrated = true; }
      if (node.retry_instruction && !node.relaunch_instruction) {
        node.relaunch_instruction = node.retry_instruction;
        migrated = true;
      }
    }
  }
  if (migrated && workflow.workflow_id) atomicWriteJson(workflowPath(orch, workflowId), workflow);
  return workflow;
}

export function saveWorkflow(orch, workflow) {
  const persisted = { ...workflow };
  delete persisted.state;
  atomicWriteJson(workflowPath(orch, persisted.workflow_id), persisted);
  return persisted;
}

function resolveMissingNodeClis(nodes, options = {}) {
  if (!nodes.some((node) => !node.cli)) return { nodes, errors: [], available: [] };
  const available = Array.isArray(options.availableClis) ? options.availableClis : listAvailableClis();
  const errors = [];
  const resolved = nodes.map((node) => {
    if (node.cli) return node;
    const selection = selectCli({ chiefCli: options.chiefCli || '', availableClis: available });
    if (!selection.ok) {
      errors.push(`node ${node.id || '(missing id)'}: ${selection.error}`);
      return node;
    }
    return { ...node, cli: selection.cli, model: normalizeModel(node.model) };
  });
  return { nodes: resolved, errors, available: available.map((item) => typeof item === 'string' ? item : item.name) };
}

export function validateWorkflow(nodes) {
  if (!Array.isArray(nodes)) return ['nodes must be an array'];
  const errors = [];
  const ids = new Set();
  const safe = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
  for (const node of nodes) {
    if (!node.id) { errors.push('node missing id'); continue; }
    if (!safe.test(node.id)) errors.push(`node id '${node.id}' is not a safe slug`);
    if (ids.has(node.id)) errors.push(`duplicate node id: ${node.id}`);
    ids.add(node.id);
    if (!node.cli) errors.push(`node ${node.id} missing cli`);
    if (!node.task) errors.push(`node ${node.id} missing task`);
    else if (!safe.test(node.task)) errors.push(`node ${node.id} task '${node.task}' is not a safe slug`);
  }
  for (const node of nodes) {
    for (const dep of node.depends_on || []) {
      if (!ids.has(dep)) errors.push(`node ${node.id} depends on unknown node: ${dep}`);
    }
  }
  if (hasCycle(nodes)) errors.push('workflow contains a dependency cycle');
  return errors;
}

function hasCycle(nodes) {
  const deps = Object.fromEntries(nodes.filter((n) => n.id).map((n) => [n.id, n.depends_on || []]));
  const visited = new Set();
  const active = new Set();
  function visit(id) {
    if (active.has(id)) return true;
    if (visited.has(id)) return false;
    visited.add(id);
    active.add(id);
    for (const dep of deps[id] || []) if (visit(dep)) return true;
    active.delete(id);
    return false;
  }
  return Object.keys(deps).some(visit);
}

function newNode(node) {
  return {
    id: node.id,
    cli: node.cli,
    model: normalizeModel(node.model),
    task: node.task || node.id,
    depends_on: node.depends_on || [],
    status: 'pending',
    event: null,
    last_action: null,
    cmux_surface: '',
    run_dir: '',
    attempt_count: 0,
  };
}

export function createWorkflow(orch, workflowId, nodes = [], options = {}) {
  const selection = resolveMissingNodeClis(nodes, options);
  const errors = selection.errors.concat(validateWorkflow(selection.nodes));
  if (errors.length) {
    return { schema: 'taskforce.workflow.v2', workflow_id: workflowId, nodes: [], _validation_errors: errors,
      ...(selection.available.length ? { _available_clis: selection.available } : {}) };
  }
  return saveWorkflow(orch, {
    schema: 'taskforce.workflow.v2', workflow_id: workflowId,
    created_at: nowIso(), updated_at: nowIso(), nodes: selection.nodes.map(newNode),
  });
}

export function addNode(orch, workflowId, node, options = {}) {
  const workflow = loadWorkflow(orch, workflowId);
  if (!workflow.workflow_id) return null;
  const selection = resolveMissingNodeClis([node], options);
  if (selection.errors.length) return { ...workflow, _validation_errors: selection.errors };
  const candidate = [...workflow.nodes, selection.nodes[0]];
  const errors = validateWorkflow(candidate);
  if (errors.length) return { ...workflow, _validation_errors: errors };
  workflow.nodes.push(newNode(selection.nodes[0]));
  workflow.updated_at = nowIso();
  return saveWorkflow(orch, workflow);
}

export function updateNode(orch, workflowId, nodeId, updates) {
  const workflow = loadWorkflow(orch, workflowId);
  if (!workflow.workflow_id) return null;
  const node = workflow.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) return null;
  Object.assign(node, updates);
  workflow.updated_at = nowIso();
  return saveWorkflow(orch, workflow);
}

function waitForProcessExit(pid) {
  const timeoutMs = Math.max(0, Number(process.env.TASKFORCE_STOP_CONFIRM_TIMEOUT_MS || 1500));
  const deadline = Date.now() + timeoutMs;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  while (processIsAlive(pid) && Date.now() < deadline) {
    Atomics.wait(sleeper, 0, 0, Math.min(100, Math.max(1, deadline - Date.now())));
  }
  return !processIsAlive(pid);
}

function stopSurface(surface, runDir) {
  if (!surface) return { ok: true, status: 'no_surface' };
  const cmux = resolveCmuxPath();
  if (!cmux) return { ok: false, status: 'cmux_unavailable' };
  const agentPid = readAgentPid(runDir);
  if (agentPid && !processIsAlive(agentPid)) {
    return { ok: true, status: 'already_stopped', surface, agent_pid: agentPid };
  }
  const result = spawnSync(cmux, ['send', '--surface', surface, '--', '\x03'], { encoding: 'utf8', timeout: 5000 });
  if (result.status !== 0) {
    return { ok: false, status: 'interrupt_failed', surface, agent_pid: agentPid,
      diagnostic: (result.stderr || result.stdout || '').trim() };
  }
  if (!agentPid) {
    return { ok: false, status: 'stop_unconfirmed', surface, agent_pid: null,
      diagnostic: 'agent.pid is unavailable; keeping the original attempt under supervision' };
  }
  if (!waitForProcessExit(agentPid)) {
    return { ok: false, status: 'stop_unconfirmed', surface, agent_pid: agentPid,
      diagnostic: 'interrupt was delivered but the worker process is still alive' };
  }
  return { ok: true, status: 'stopped', surface, agent_pid: agentPid, diagnostic: '' };
}

export function cancelNode(orch, workflowId, nodeId) {
  const workflow = loadWorkflow(orch, workflowId);
  if (!workflow.workflow_id) return null;
  const node = workflow.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) return null;
  if (node.status === 'completed') return workflow;

  const cancelled = new Set([node.id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const candidate of workflow.nodes) {
      if (['completed', 'cancelled'].includes(candidate.status) || cancelled.has(candidate.id)) continue;
      if ((candidate.depends_on || []).some((dependency) => cancelled.has(dependency))) {
        cancelled.add(candidate.id);
        changed = true;
      }
    }
  }

  for (const candidate of workflow.nodes) {
    if (!cancelled.has(candidate.id)) continue;
    if (candidate.status === 'running') stopSurface(candidate.cmux_surface, candidate.run_dir);
    candidate.status = 'cancelled';
    candidate.event = {
      type: 'cancelled',
      reason: candidate.id === node.id ? 'user_cancelled' : 'dependency_cancelled',
    };
    writeNodeState(orch, workflowId, candidate.id, {
      workflow_id: workflowId,
      node_id: candidate.id,
      task_id: candidate.task,
      cli: candidate.cli,
      status: 'cancelled',
      event: candidate.event,
    });
  }
  workflow.updated_at = nowIso();
  return saveWorkflow(orch, workflow);
}

export function relaunchNode(orch, workflowId, nodeId, options = {}) {
  const workflow = loadWorkflow(orch, workflowId);
  if (!workflow.workflow_id) return { ok: false, error: 'workflow_not_found' };
  const node = workflow.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) return { ok: false, error: 'node_not_found' };
  if (['completed', 'cancelled'].includes(node.status)) {
    return { ok: false, error: `node_not_relaunchable:${node.status}` };
  }

  let nextCli = node.cli;
  let nextModel = normalizeModel(node.model);
  if (String(options.cli || '').trim()) {
    const target = ensureCliAvailable(options.cli);
    if (!target.ok) return target;
    nextCli = target.name;
    nextModel = normalizeModel(options.model);
  }
  const previous = {
    run_dir: node.run_dir || '',
    attempt_id: node.run_dir ? path.basename(node.run_dir) : '',
    cmux_surface: node.cmux_surface || '',
    cli: node.cli,
    model: normalizeModel(node.model),
  };
  const agentPid = readAgentPid(node.run_dir);
  const workerAlive = agentPid ? processIsAlive(agentPid) : Boolean(node.cmux_surface);
  const decidedAt = options.decided_at || nowIso();
  if (workerAlive) {
    const status = agentPid ? 'worker_alive' : 'worker_liveness_unknown';
    const event = {
      type: 'relaunch_rejected',
      reason: status,
      agent_pid: agentPid,
    };
    Object.assign(node, {
      event,
      last_action: options.last_action || node.last_action || null,
    });
    workflow.updated_at = decidedAt;
    saveWorkflow(orch, workflow);
    writeNodeState(orch, workflowId, nodeId, { status: node.status, event });
    appendJsonl(path.join(orch, 'state', 'workflows', workflowId, 'recoveries.jsonl'), {
      schema: 'taskforce.recovery.v1', workflow_id: workflowId, node_id: nodeId,
      action: 'relaunch_rejected', reason: String(options.reason || ''),
      instruction: String(options.instruction || ''), previous,
      next: { cli: nextCli, model: nextModel },
      exit_check: { status, agent_pid: agentPid }, at: workflow.updated_at,
    });
    return { ok: false, status, cli: node.cli, model: node.model ?? null,
      exit_check: { status, agent_pid: agentPid } };
  }

  const exitCheck = {
    status: node.cmux_surface || agentPid ? 'worker_exited' : 'no_active_attempt',
    agent_pid: agentPid,
  };

  Object.assign(node, {
    cli: nextCli, model: nextModel, status: 'pending', event: null,
    last_action: options.last_action || node.last_action || null,
    relaunch_reason: String(options.reason || ''),
    relaunch_instruction: String(options.instruction || ''),
    cmux_surface: '', run_dir: '', launch_phase: null, launched_at: null,
  });
  workflow.updated_at = decidedAt;
  saveWorkflow(orch, workflow);
  writeNodeState(orch, workflowId, nodeId, { status: 'pending', cli: nextCli, model: nextModel,
    event: null, cmux_surface: '', run_dir: '', launch_phase: null });
  appendJsonl(path.join(orch, 'state', 'workflows', workflowId, 'recoveries.jsonl'), {
    schema: 'taskforce.recovery.v1', workflow_id: workflowId, node_id: nodeId, action: 'relaunch',
    reason: String(options.reason || ''), instruction: String(options.instruction || ''),
    previous, next: { cli: nextCli, model: nextModel }, exit_check: exitCheck, at: workflow.updated_at,
  });
  return { ok: true, status: 'pending', cli: nextCli, model: nextModel, exit_check: exitCheck };
}

export function getReadyNodes(orch, workflowId) {
  const workflow = loadWorkflow(orch, workflowId);
  if (!workflow.workflow_id) return [];
  const completed = new Set(workflow.nodes.filter((node) => node.status === 'completed').map((node) => node.id));
  return workflow.nodes.filter((node) => node.status === 'pending' && (node.depends_on || []).every((dep) => completed.has(dep)));
}

export function getRunningNodes(orch, workflowId) {
  const workflow = loadWorkflow(orch, workflowId);
  if (!workflow.workflow_id) return [];
  return workflow.nodes.filter((node) => node.status === 'running' && node.cmux_surface);
}

export function getObservableTaskIds(orch, workflowId) {
  return getRunningNodes(orch, workflowId).map((node) => node.task);
}

export function workflowState(workflow) {
  const nodes = workflow.nodes || [];
  // A workflow with no nodes has nothing left to supervise. Reporting it as
  // running would keep the supervisor waiting forever on an empty screen set.
  if (!nodes.length) return 'completed';
  if (nodes.every((node) => node.status === 'cancelled')) return 'cancelled';
  if (nodes.every((node) => ['completed', 'cancelled'].includes(node.status))) return 'completed';
  if (nodes.some((node) => node.status === 'running')) return 'running';
  const completed = new Set(nodes.filter((node) => node.status === 'completed').map((node) => node.id));
  if (nodes.some((node) => node.status === 'pending' && (node.depends_on || []).every((dep) => completed.has(dep)))) return 'running';
  return 'running';
}

function main() {
  parseArgs(process.argv.slice(2), { flags: [], valued: [] });
  process.stdout.write('Use supervisor_loop.mjs for the runtime pipeline.\n');
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main());
