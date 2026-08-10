#!/usr/bin/env node
// Supervisor Loop: the main control loop for Taskforce v0.2.
// Executes one non-blocking supervisor tick: consume the previous Chief
// decision, launch ready nodes, read every active surface, and emit the next
// observation batch.
//
// Usage:
//   node supervisor_loop.mjs --project-dir /path --workflow-id my-workflow --wait --poll-seconds 15
//   node supervisor_loop.mjs --project-dir /path --workflow-id my-workflow --once
//
// Environment:
//   TASKFORCE_LAUNCHING_TIMEOUT_SECONDS=60 (time before a launch-timeout event)
//   TASKFORCE_SURFACE_FAILURE_THRESHOLD=3 (consecutive failed reads before exit)
//
// v0.2 Architecture:
//   - 4 node lifecycle states: pending, running, completed, cancelled
//   - launch_phase is metadata, not a lifecycle state
//   - Immediate events: agent_question, result, cli_exit, launching_timeout
//   - node_id is the primary identity for surfaces, observations, and decisions
//   - CLI aliveness confirmed by reading cmux surface — detectEvents promotes to running
//   - Workflow-scoped I/O under state/<workflowId>/
//   - batch_id binding prevents stale decisions
//   - Event dedup via result hash prevents repeated immediate events
//   - cancelNode sends Ctrl-C to running surface via cmux

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { parseArgs, nowIso, atomicWriteJson, appendJsonl, readJson, writeNodeState } from './protocol_lib.mjs';
import { collectAllSurfaces, collectSurfaces, readCmuxScreen } from './surface_collector.mjs';
import { resolveCmuxPath } from './doctor.mjs';
import { parseDecisionBatch, classifyDecisions } from './decision_batch.mjs';
import { dispatchBatch } from './intervention_dispatcher.mjs';
import {
  loadWorkflow,
  getReadyNodes,
  getRunningNodes,
  getObservableTaskIds,
  updateNode,
  relaunchNode,
  workflowState,
  saveWorkflow,
} from './workflow_registry.mjs';
import { loadContract } from './task_contract.mjs';
import { ensureCliAvailable } from './cli_selector.mjs';

const LAUNCHING_TIMEOUT_SECONDS = Number(process.env.TASKFORCE_LAUNCHING_TIMEOUT_SECONDS || 60);
const SURFACE_FAILURE_THRESHOLD = Math.max(1, Number(process.env.TASKFORCE_SURFACE_FAILURE_THRESHOLD || 3));
const SCREEN_REVIEW_INSTRUCTION =
  'Make a fresh semantic judgment for every observation. Read current_screen from the bottom upward: ' +
  'the current prompt, menu, confirmation, question, or selectable action takes priority over earlier progress text. ' +
  'Do not return continue while the CLI visibly waits for input unless user authority is deliberately pending. ' +
  'Every periodic observation requires a fresh judgment even when the screen is unchanged; unchanged is not a stall. ' +
  'Continue is the default for active work. Thinking, Write/Edit execution, streaming output, tests, debugging, partial implementation, ' +
  'elapsed time, an unchanged screen, or files not yet appearing are not reasons to send urgency, reminders, task restatements, or start-now prompts. ' +
  'Use send only for a visible input request, concrete goal or boundary drift, or an explicit failure that cannot proceed without guidance. ' +
  'Chief owns permission judgment. For a TUI menu, inspect the current highlight and send exactly one official key ' +
  '(up, down, left, right, enter, tab, escape, backspace, or delete) with expected_screen_hash; never type a displayed option number unless the TUI explicitly names it as a shortcut. ' +
  'After a navigation key, re-read the screen and confirm the new highlight before sending enter. Use input only for text. ' +
  'Ask the user outside the runtime only for credentials, product authority, dangerous or irreversible permission; keep the node running meanwhile. ' +
  'Never relaunch a live worker; relaunch is available only after its process has already exited. ' +
  'Return one action per active node: continue, send, relaunch, or complete.';
const HOST_REVIEW_INSTRUCTION =
  'Review every included node now, write the batch-bound decision, and immediately start the next --wait. ' +
  'Do not end supervision or return a final response while workflow_terminal is false.';

function truncateTail(value, max) {
  const text = String(value || '');
  return text.length <= max ? text : `…${text.slice(-max)}`;
}

// Cached cmux availability — checked once, then reused.
let _cmuxAvailable = null;
function isCmuxAvailable() {
  if (_cmuxAvailable === null) {
    _cmuxAvailable = !!resolveCmuxPath();
  }
  return _cmuxAvailable;
}

// Generate a unique batch_id for observation batches.
export function generateBatchId() {
  const ts = Date.now().toString(36);
  const rand = crypto.randomBytes(4).toString('hex');
  return `obs-${ts}-${rand}`;
}

const COMPLETION_REVIEW_PROMPT =
  'The worker claims completion. Before returning complete, compare the task goal and done_when ' +
  'with the actual project files (inspect them when needed), the result, validation evidence, and current ' +
  'screen. CLI exit and the worker\'s own completed claim are not proof. If the implementation is ' +
  'incomplete, off-target, or insufficiently verified, choose send with a concrete correction. ' +
  'Choose relaunch only when the current process cannot reasonably continue. ' +
  'Return complete only when the goal and done_when are genuinely satisfied.';

// Short reference identifier for the completion review prompt. The full text is
// delivered via the skill's SKILL.md / AGENTS.md and is stable across versions.
// Including the full string in every result event bloated the observation batch
// (600+ bytes per occurrence). The ref lets the host look up the canonical text.
const COMPLETION_REVIEW_PROMPT_REF = 'completion-review-v1';

// Validation evidence is summarized instead of inlined verbatim. The full
// validation.json can be several KB; inlining it made result-event observations
// disproportionately large. Chief reads the file directly when it needs detail.
function summarizeValidationEvidence(filePath) {
  if (!fs.existsSync(filePath)) return { provided: false, ref: null };
  const artifact = readJson(filePath);
  if (!artifact || artifact._invalid_json) return { provided: false, ref: null, error: 'invalid JSON' };
  const serialized = JSON.stringify(artifact);
  const charLimit = 300;
  return {
    provided: true,
    ref: filePath,
    summary: serialized.length <= charLimit ? serialized : `${serialized.slice(0, charLimit)}…`,
    full_size_bytes: Buffer.byteLength(serialized, 'utf8'),
  };
}

// Completion review evidence is deliberately compact. The Chief needs enough context
// for a semantic decision, not another heavyweight artifact protocol.
function compactArtifact(filePath, charLimit = 4000) {
  if (!fs.existsSync(filePath)) return null;
  const artifact = readJson(filePath);
  if (!artifact || artifact._invalid_json) return 'invalid JSON';
  const serialized = JSON.stringify(artifact);
  return serialized.length <= charLimit ? serialized : `${serialized.slice(0, charLimit)}…`;
}

function factFingerprint(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex').slice(0, 20);
}

// Workflow-scoped state directory for observation/decision files.
function workflowStateDir(orch, workflowId) {
  const dir = path.join(orch, 'state', 'workflows', workflowId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function observationBatchPath(orch, workflowId) {
  return path.join(workflowStateDir(orch, workflowId), 'latest_observation_batch.json');
}

function decisionBatchPath(orch, workflowId) {
  return path.join(workflowStateDir(orch, workflowId), 'latest_decision_batch.json');
}

function supervisorLockPath(orch, workflowId) {
  return path.join(workflowStateDir(orch, workflowId), 'supervisor.lock');
}

// Remove a file without triggering host-level safe-delete / trash interception.
// Some agent hosts (e.g. workbuddy) intercept fs.unlinkSync and move deleted
// files to the OS trash instead of deleting them. Taskforce's short-lived
// lock and decision-batch files are recreated every tick, so routing them to
// trash floods the user's trash bin. rename-to-tmpdir sidesteps the intercept:
// fs.renameSync is not intercepted, and files under os.tmpdir() are exempt
// from safe-delete (they are native-deleted). The OS reclaims tmpdir space.
function quietRemove(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return;
  try {
    const dest = path.join(os.tmpdir(), `taskforce-removed-${crypto.randomBytes(6).toString('hex')}`);
    fs.renameSync(filePath, dest);
    try { fs.unlinkSync(dest); } catch (_) { /* OS reclaims tmpdir; leave if unlink fails */ }
  } catch (_) {
    // Fall back to direct unlink if rename fails (e.g. cross-device). This may
    // trigger safe-delete on some hosts, but only in the rare fallback path.
    try { fs.unlinkSync(filePath); } catch (_) { /* best effort */ }
  }
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (exc) {
    return exc?.code === 'EPERM';
  }
}

function acquireSupervisorLock(orch, workflowId) {
  const lockPath = supervisorLockPath(orch, workflowId);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, started_at: nowIso() }) + '\n', 'utf8');
      fs.closeSync(fd);
      return { ok: true, lockPath };
    } catch (exc) {
      if (exc?.code !== 'EEXIST') return { ok: false, status: 'lock_failed', diagnostic: String(exc.message || exc) };
      const owner = readJson(lockPath);
      const ownerPid = Number(owner.pid || 0);
      if (processIsAlive(ownerPid)) return { ok: false, status: 'already_running', owner_pid: ownerPid };
      quietRemove(lockPath);
    }
  }
  return { ok: false, status: 'already_running' };
}

function releaseSupervisorLock(lock) {
  if (!lock?.ok || !lock.lockPath) return;
  const owner = readJson(lock.lockPath);
  if (Number(owner.pid || 0) !== process.pid) return;
  quietRemove(lock.lockPath);
}

// Only the latest observation can accept a decision, so one overwritten
// receipt is enough to prevent replay without creating a file per tick.
function consumedBatchPath(orch, workflowId) {
  return path.join(workflowStateDir(orch, workflowId), 'last_consumed_batch.json');
}

// ---------------------------------------------------------------------------
// Workflow lifecycle
// ---------------------------------------------------------------------------

export function checkWorkflowCompletion(orch, workflowId) {
  const workflow = loadWorkflow(orch, workflowId);
  if (!workflow.workflow_id) return { completed: false, reason: 'workflow_not_found' };
  const state = workflowState(workflow);
  return {
    completed: state === 'completed' || state === 'cancelled',
    state,
    workflow_id: workflowId,
  };
}

// Artifact and process facts become observation events. They never force a
// semantic lifecycle state; Chief decides whether to send, relaunch, or wait.
export function detectEvents(orch, workflowId) {
  const workflow = loadWorkflow(orch, workflowId);
  if (!workflow.workflow_id) return [];
  const stateDir = path.join(orch, 'state', workflowId);
  const events = [];

  for (const node of workflow.nodes) {
    if (node.status !== 'running') continue;
    const statePath = path.join(stateDir, `${node.id}.json`);
    let payload = fs.existsSync(statePath) ? readJson(statePath) : {};
    if (!payload || payload.node_id !== node.id) payload = {};
    const updates = {};
    const emitted = payload.emitted_event_fingerprints && typeof payload.emitted_event_fingerprints === 'object'
      ? { ...payload.emitted_event_fingerprints } : {};
    let fingerprintsChanged = false;
    const emitOnce = (key, fingerprintValue, event) => {
      const fingerprint = factFingerprint(fingerprintValue);
      if (emitted[key] === fingerprint) return;
      emitted[key] = fingerprint;
      fingerprintsChanged = true;
      events.push(event);
    };
    const clearFingerprint = (key) => {
      if (!Object.prototype.hasOwnProperty.call(emitted, key)) return;
      delete emitted[key];
      fingerprintsChanged = true;
    };
    if (!node.cmux_surface && payload.cmux_surface) updates.cmux_surface = String(payload.cmux_surface);
    if (!node.run_dir && payload.run_dir) updates.run_dir = String(payload.run_dir);

    const surface = node.cmux_surface || payload.cmux_surface || '';
    const launchPhase = node.launch_phase || payload.launch_phase || '';
    if (launchPhase === 'failed' && node.event) {
      emitOnce('launch_failure', { run_dir: node.run_dir || payload.run_dir || '', event: node.event },
        { node_id: node.id, task: node.task, ...node.event, requires_decision: true });
    } else {
      clearFingerprint('launch_failure');
    }
    if (launchPhase && surface && isCmuxAvailable()) {
      if (readCmuxScreen(surface).ok) {
        updates.launch_phase = null;
        writeNodeState(orch, workflowId, node.id, { status: 'running', launch_phase: null });
        events.push({ node_id: node.id, task: node.task, type: 'launch_confirmed' });
      }
    }
    if (launchPhase && updates.launch_phase !== null) {
      const started = new Date(payload.started_at || node.launched_at || '').getTime();
      if (!isNaN(started) && Date.now() - started > LAUNCHING_TIMEOUT_SECONDS * 1000) {
        emitOnce('launching_timeout', { started, launchPhase },
          { node_id: node.id, task: node.task, type: 'launching_timeout', requires_decision: true });
      }
    } else {
      clearFingerprint('launching_timeout');
    }

    const runDir = node.run_dir || payload.run_dir || '';
    if (runDir) {
      const questionsPath = path.join(runDir, 'questions.json');
      if (fs.existsSync(questionsPath)) {
        const questions = readJson(questionsPath);
        emitOnce('questions', questions, { node_id: node.id, task: node.task, type: 'question',
          content: questions.questions || [], requires_decision: true });
      } else clearFingerprint('questions');

      const resultPath = path.join(runDir, 'result.json');
      if (fs.existsSync(resultPath)) {
        const result = readJson(resultPath);
        const state = String(result.state || '').trim();
        if (state === 'completed') {
          const validationEvidence = summarizeValidationEvidence(path.join(runDir, 'validation.json'));
          emitOnce('result', { result, validationEvidence }, { node_id: node.id, task: node.task, type: 'result', state,
            summary: result.summary || '',
            validation_evidence: validationEvidence,
            chief_prompt_ref: COMPLETION_REVIEW_PROMPT_REF, requires_decision: true });
        } else if (state === 'failed' || state === 'blocked') {
          emitOnce('result', result, { node_id: node.id, task: node.task, type: 'result', state,
            summary: result.summary || '', questions: result.questions || [], requires_decision: true });
        } else {
          emitOnce('result', result, { node_id: node.id, task: node.task, type: 'invalid_result', state,
            summary: result.summary || '', requires_decision: true });
        }
      } else clearFingerprint('result');
    } else {
      clearFingerprint('questions');
      clearFingerprint('result');
    }

    if (surface) {
      const failures = Number(payload.surface_read_failures || 0);
      if ((payload.last_screen_read_at || payload.last_seen_active) &&
          failures >= SURFACE_FAILURE_THRESHOLD) {
        emitOnce('cli_exit', { surface, runDir }, { node_id: node.id, task: node.task, type: 'cli_exit', surface,
          consecutive_read_failures: failures, requires_decision: true });
      } else clearFingerprint('cli_exit');
    } else clearFingerprint('cli_exit');
    if (fingerprintsChanged) {
      writeNodeState(orch, workflowId, node.id, { emitted_event_fingerprints: emitted });
    }
    if (Object.keys(updates).length) updateNode(orch, workflowId, node.id, updates);
  }
  return events;
}

// ---------------------------------------------------------------------------
// Node launch
// ---------------------------------------------------------------------------

// Launch ready nodes directly through the cmux terminal launcher.
// v0.2: uses node.cli and node.model, no --role.
// running covers the supervised attempt; launch_phase records surface startup.
export function launchReadyNodes(orch, project, workflowId, skillDir) {
  const ready = getReadyNodes(orch, workflowId);
  const results = [];
  for (const node of ready) {
    const cliAvailability = ensureCliAvailable(node.cli);
    if (!cliAvailability.ok) {
      updateNode(orch, workflowId, node.id, {
        status: 'running',
        launch_phase: 'failed',
        event: { type: 'cli_unavailable', cli: node.cli, diagnostic: cliAvailability.diagnostic || '' },
      });
      results.push({
        node_id: node.id,
        task: node.task,
        launched: false,
        error: 'cli_unavailable',
        cli: node.cli,
      });
      continue;
    }
    updateNode(orch, workflowId, node.id, {
      status: 'running',
      launch_phase: 'creating_surface',
      event: null,
      launched_at: nowIso(),
      attempt_count: Number(node.attempt_count || 0) + 1,
    });

    const taskFile = path.join(orch, 'tasks', `${node.task}.json`);
    const taskFileMd = path.join(orch, 'tasks', `${node.task}.md`);
    const actualTaskFile = fs.existsSync(taskFile) ? taskFile : (fs.existsSync(taskFileMd) ? taskFileMd : null);

    if (!actualTaskFile) {
      updateNode(orch, workflowId, node.id, {
        status: 'running',
        launch_phase: 'failed',
        event: { type: 'launch_failed', error: 'task_file_missing' },
      });
      results.push({ node_id: node.id, task: node.task, launched: false, error: 'task_file_missing' });
      continue;
    }

    const orchRel = path.relative(project, orch) || '.taskforce';
    const launchScript = path.join(skillDir, 'scripts', 'prepare_terminal_launch.mjs');

    const launchArgs = [
      launchScript,
      '--project-dir', String(project),
      '--orchestrator-dir', orchRel,
      '--task-file', String(actualTaskFile),
      '--workflow-id', workflowId,
      '--node-id', node.id,
      '--cli', String(node.cli),
      '--execute',
    ];

    if (node.model) {
      launchArgs.push('--model', String(node.model));
    }

    try {
      const launchResult = spawnSync(process.execPath, launchArgs, {
        encoding: 'utf8',
        timeout: 30000,
      });

      if (launchResult.status !== 0) {
        const diagnostic = (launchResult.stderr || launchResult.stdout || '').trim().slice(0, 200);
        updateNode(orch, workflowId, node.id, {
          status: 'running',
          launch_phase: 'failed',
          event: { type: 'launch_failed', diagnostic },
        });
        results.push({ node_id: node.id, task: node.task, launched: false, error: 'launch_failed', diagnostic });
        continue;
      }

      results.push({ node_id: node.id, task: node.task, launched: true });
    } catch (exc) {
      updateNode(orch, workflowId, node.id, {
        status: 'running',
        launch_phase: 'failed',
        event: { type: 'launch_exception', diagnostic: String(exc.message || exc) },
      });
      results.push({ node_id: node.id, task: node.task, launched: false, error: String(exc.message || exc) });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Decision processing
// ---------------------------------------------------------------------------

// Process a Chief decision batch: parse → classify → dispatch → update nodes.
// v0.2: lifecycle updates are gated on dispatch success.
// Batch-level fail-closed: any structural errors → reject entire batch.
// Decisions are recorded in decisions.jsonl for audit.
// Consumed batch_id is persisted to prevent replay.
export function processDecisionBatch(chiefOutput, nodeSurfaceMap, orch, workflowId, expectedObservations) {
  const observed = Array.isArray(expectedObservations) ? expectedObservations : [];
  const expectedNodeIds = observed.map((item) => typeof item === 'string' ? item : item?.node_id).filter(Boolean);
  const observedScreenHashes = Object.fromEntries(observed
    .filter((item) => item && typeof item === 'object' && item.node_id)
    .map((item) => [item.node_id, String(item.screen_hash || '')]));
  const parsed = parseDecisionBatch(chiefOutput, expectedNodeIds);
  const appliedAt = nowIso();
  const decidedAt = chiefOutput?.decided_at || appliedAt;
  const decisionSnapshot = (decision) => ({
    action: decision.action,
    reason: decision.reason || '',
    ...(decision.action === 'send' ? {
      ...(decision.input !== undefined
        ? { input: decision.input, submit: decision.submit }
        : { key: decision.key }),
      expected_screen_hash: decision.expected_screen_hash,
    } : {}),
    ...(decision.instruction ? { instruction: decision.instruction } : {}),
    ...(decision.cli ? { cli: decision.cli, model: decision.model ?? null } : {}),
    reviewed_screen_hash: observedScreenHashes[decision.node_id] || '',
    decided_at: decidedAt,
    applied_at: appliedAt,
    batch_id: chiefOutput?.batch_id || null,
  });

  // Record errors for audit, regardless of whether we proceed.
  if (parsed.errors.length > 0) {
    fs.mkdirSync(path.join(orch, 'state', 'workflows', workflowId), { recursive: true });
    appendJsonl(path.join(orch, 'state', 'workflows', workflowId, 'decision_errors.jsonl'), {
      at: nowIso(),
      errors: parsed.errors,
      batch_id: chiefOutput.batch_id || null,
      workflow_id: chiefOutput.workflow_id || null,
    });
  }

  // Batch-level fail-closed: if there are any structural errors,
  // reject the entire batch. No side effects.
  if (parsed.errors.length > 0) {
    return {
      sends: [],
      completions: [],
      continuations: [],
      relaunches: [],
      relaunchResults: [],
      dispatchResults: [],
      rejected: true,
      rejection_reason: 'batch_has_errors',
      errors: parsed.errors,
    };
  }

  const classified = classifyDecisions(parsed);
  const dispatchResults = dispatchBatch(classified.sends, nodeSurfaceMap, orch);
  const dispatchByNode = Object.fromEntries(dispatchResults.map((result) => [result.node_id, result]));

  const workflow = loadWorkflow(orch, workflowId);
  if (workflow.workflow_id) {
    for (const d of classified.completions) {
      const node = workflow.nodes.find((candidate) => candidate.id === d.node_id);
      if (node) {
        updateNode(orch, workflowId, node.id, {
          status: 'completed',
          event: { type: 'completed', reason: d.reason || '' },
          last_action: decisionSnapshot(d),
        });
        writeNodeState(orch, workflowId, node.id, { status: 'completed' });
      }
    }

    for (const d of classified.sends) {
      const node = workflow.nodes.find((candidate) => candidate.id === d.node_id);
      if (!node) continue;
      const dr = dispatchByNode[d.node_id];
      if (dr?.ok === true) {
        updateNode(orch, workflowId, node.id, { last_action: decisionSnapshot(d), event: null });
        if (node.run_dir) {
          const question = path.join(node.run_dir, 'questions.json');
          if (fs.existsSync(question)) {
            try { fs.renameSync(question, path.join(node.run_dir, 'questions.json.addressed')); } catch (_) { /* best effort */ }
          }
        }
      } else {
        updateNode(orch, workflowId, node.id, { last_action: decisionSnapshot(d),
          event: { type: 'send_failed', status: dr?.status || 'unknown' } });
      }
    }

    for (const d of classified.continuations) {
      const node = workflow.nodes.find((candidate) => candidate.id === d.node_id);
      if (node) updateNode(orch, workflowId, node.id, { last_action: decisionSnapshot(d), event: null });
    }
  }

  const relaunchResults = [];
  for (const d of classified.relaunches) {
    const current = loadWorkflow(orch, workflowId);
    const node = current.nodes?.find((candidate) => candidate.id === d.node_id);
    if (!node) {
      relaunchResults.push({ ok: false, action: 'relaunch', error: 'node_not_found', node_id: d.node_id });
      continue;
    }
    const result = relaunchNode(orch, workflowId, node.id, {
      cli: d.cli,
      model: d.model,
      reason: d.reason,
      instruction: d.instruction || '',
      decided_at: decidedAt,
      last_action: decisionSnapshot(d),
    });
    relaunchResults.push({ action: 'relaunch', node_id: node.id, task_id: node.task, ...result });
  }

  const decDir = path.join(orch, 'state', 'workflows', workflowId);
  fs.mkdirSync(decDir, { recursive: true });
  const durableDecisions = classified.sends.concat(classified.relaunches, classified.completions);
  if (durableDecisions.length > 0) appendJsonl(path.join(decDir, 'decisions.jsonl'), {
    at: nowIso(),
    batch_id: chiefOutput.batch_id,
    workflow_id: chiefOutput.workflow_id,
    decisions: durableDecisions,
    dispatch_results: dispatchResults,
    relaunch_results: relaunchResults,
  });

  // Persist consumed batch_id to prevent replay.
  if (chiefOutput.batch_id) {
    atomicWriteJson(consumedBatchPath(orch, workflowId), {
      consumed_at: nowIso(),
      batch_id: chiefOutput.batch_id,
      workflow_id: chiefOutput.workflow_id,
    });
  }

  return {
    sends: classified.sends,
    completions: classified.completions,
    continuations: classified.continuations,
    relaunches: classified.relaunches,
    relaunchResults,
    dispatchResults,
  };
}

// Check if a batch_id has already been consumed.
export function isBatchConsumed(orch, workflowId, batchId) {
  if (!batchId) return false;
  const latest = readJson(consumedBatchPath(orch, workflowId));
  if (latest.batch_id === batchId) return true;
  // Read old receipts during migration, but never create new per-batch files.
  return fs.existsSync(path.join(workflowStateDir(orch, workflowId), 'consumed', `${batchId}.json`));
}

// Try to consume a pending Chief decision file.
// Validates batch_id — strictly mandatory. Rejects replayed batches.
export function tryConsumeDecision(orch, workflowId, nodeSurfaceMap, expectedBatchId, expectedObservations) {
  const decPath = decisionBatchPath(orch, workflowId);
  if (!fs.existsSync(decPath)) return { processed: false };

  try {
    const chiefOutput = readJson(decPath);
    if (!chiefOutput || !chiefOutput.decisions) {
      return { processed: false };
    }

    // Validate workflow_id match.
    if (chiefOutput.workflow_id && chiefOutput.workflow_id !== workflowId) {
      return { processed: false, reason: 'workflow_id_mismatch' };
    }

    // Validate batch_id — strictly mandatory.
    if (!expectedBatchId) {
      return { processed: false, reason: 'no_pending_batch' };
    }
    if (!chiefOutput.batch_id) {
      return { processed: false, reason: 'missing_batch_id' };
    }
    if (chiefOutput.batch_id !== expectedBatchId) {
      return { processed: false, reason: 'batch_id_mismatch', expected: expectedBatchId, got: chiefOutput.batch_id };
    }

    // Check for replay — already consumed batch.
    if (isBatchConsumed(orch, workflowId, chiefOutput.batch_id)) {
      // Remove the action file to stop reprocessing it.
      quietRemove(decPath);
      return { processed: false, reason: 'batch_already_consumed' };
    }

    const result = processDecisionBatch(chiefOutput, nodeSurfaceMap, orch, workflowId, expectedObservations);

    // Remove the submitted file either way. A rejected decision leaves the
    // observation pending so Chief can submit a corrected batch.
    quietRemove(decPath);

    if (result.rejected) {
      return { processed: false, reason: result.rejection_reason || 'decision_rejected', result };
    }

    return { processed: true, result };
  } catch (e) {
    process.stderr.write(`[${nowIso()}] error processing decision batch: ${e.message}\n`);
    return { processed: false, error: String(e.message) };
  }
}

// ---------------------------------------------------------------------------
// Observation collection
// ---------------------------------------------------------------------------

// One poll cycle: collect surfaces and accumulate one observation per node.
// v0.2: node_id is the primary identity for surface map, observations, and cursors.
export function collectCycle(orch, workflowId, buffer, reviewIntervalSeconds = 15) {
  const taskIdFilter = getObservableTaskIds(orch, workflowId);
  const collected = collectAllSurfaces(orch, taskIdFilter, workflowId);
  const workflow = loadWorkflow(orch, workflowId);
  const nodes = new Map((workflow.nodes || []).map((node) => [node.id, node]));

  // Build surface map keyed by node_id — the primary identity.
  // This prevents collision when two nodes share the same task_id.
  const nodeSurfaceMap = {};
  for (const surface of collected) {
    const key = surface.node_id || surface.task_id;
    nodeSurfaceMap[key] = {
      cmux_surface: surface.cmux_surface,
      run_dir: surface.run_dir,
      cli: surface.cli || '',
      node_id: surface.node_id || '',
      task_id: surface.task_id || '',
      workflow_id: surface.workflow_id || '',
    };
  }

  // Every scheduled read is a Chief review. Screen changes and post-send
  // confirmations may return earlier; an unchanged screen is still reviewed at
  // the configured interval and is never interpreted as a stall by runtime.
  for (const surface of collected) {
    if (!surface.delta) continue;
    const nodeKey = surface.node_id || surface.task_id;
    const existing = buffer.observations.find((o) => o.node_id === nodeKey);
    const node = nodes.get(nodeKey);
    const lastAction = node?.last_action || null;
    const reviewedAt = new Date(lastAction?.applied_at || lastAction?.decided_at || '').getTime();
    const sameReviewedScreen = Boolean(lastAction?.reviewed_screen_hash) &&
      lastAction.reviewed_screen_hash === surface.delta.screen_hash;
    const periodicReviewDue = lastAction?.action === 'continue' && sameReviewedScreen &&
      Number.isFinite(reviewedAt) && Date.now() - reviewedAt >= reviewIntervalSeconds * 1000;
    const postSend = lastAction?.action === 'send';
    const needsFollowup = postSend || periodicReviewDue || Boolean(node?.event);
    if (!surface.changed && !existing && !needsFollowup) continue;
    if (existing) {
      if (surface.changed) {
        existing.review_reason = 'screen_changed';
      }
      if (!existing.review_reason) {
        existing.review_reason = postSend ? 'post_send_confirmation'
          : periodicReviewDue ? 'periodic_review' : 'event';
      }
      existing.surface = surface.cmux_surface;
      existing.current_screen = truncateTail(surface.delta.current_screen, surface.changed ? 4000 : 1200);
      existing.screen_hash = surface.delta.screen_hash;
      existing.screen_changed = Boolean(existing.screen_changed || surface.changed);
      if (postSend) {
        existing.send_effect = lastAction.expected_screen_hash === surface.delta.screen_hash
          ? 'screen_unchanged' : 'screen_changed';
      }
    } else {
      buffer.observations.push({
        node_id: nodeKey,
        task_id: surface.task_id,
        surface: surface.cmux_surface,
        current_screen: truncateTail(surface.delta.current_screen, surface.changed ? 4000 : 1200),
        screen_hash: surface.delta.screen_hash,
        screen_changed: Boolean(surface.changed),
        review_reason: surface.changed ? 'screen_changed'
          : postSend ? 'post_send_confirmation'
            : periodicReviewDue ? 'periodic_review' : 'event',
        ...(postSend ? {
          send_effect: lastAction.expected_screen_hash === surface.delta.screen_hash
            ? 'screen_unchanged' : 'screen_changed',
        } : {}),
      });
    }
  }

  return { collected, nodeSurfaceMap };
}

// Enrich buffered observations with task context.
export function enrichObservations(orch, workflowId, observations) {
  const workflow = loadWorkflow(orch, workflowId);
  if (!workflow.workflow_id) return observations;

  for (const obs of observations) {
    // Find node by node_id first, then fall back to task_id.
    const node = workflow.nodes.find((n) => n.id === obs.node_id) ||
                 workflow.nodes.find((n) => n.task === obs.task_id);
    if (!node) continue;

    // Load task contract for goal and boundaries.
    const contract = loadContract(orch, node.task);
    if (contract) {
      obs.task_goal = contract.goal;
      obs.task_boundaries = (contract.boundaries || []).join('; ');
      obs.task_validation = (contract.validation || []).join('; ');
      obs.task_done_when = (contract.done_when || []).join('; ');
    }

    obs.node_id = node.id;
    obs.node_status = node.status;
    obs.node_event = node.event || null;
    obs.last_action = node.last_action || null;
    obs.attempt_count = Number(node.attempt_count || 0);
  }
  return observations;
}

// Flush the observation buffer: enrich, build batch with batch_id,
// write to workflow-scoped path, reset buffer.
export function flushBuffer(orch, workflowId, buffer) {
  if (buffer.observations.length === 0) {
    return { batch: null, batchId: null };
  }

  enrichObservations(orch, workflowId, buffer.observations);

  const batchId = generateBatchId();
  const batch = {
    schema: 'taskforce.observation-batch.v1',
    batch_id: batchId,
    workflow_id: workflowId,
    observed_at: nowIso(),
    review_required: true,
    workflow_terminal: false,
    host_instruction: HOST_REVIEW_INSTRUCTION,
    chief_instruction: SCREEN_REVIEW_INSTRUCTION,
    observations: buffer.observations,
  };

  // Keep exactly one complete observation batch. Durable audit history is
  // reserved for decisions, interventions, and recoveries.
  const batchPath = observationBatchPath(orch, workflowId);
  atomicWriteJson(batchPath, batch);

  // Reset buffer.
  buffer.observations = [];

  return { batch, batchId };
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

export function supervisorTick({ orch, project, workflowId, skillDir, reviewIntervalSeconds = 15 }) {
  const buffer = { observations: [] };
  let decisionResult = { processed: false };

  // 1. Consume the decision for the PREVIOUS persisted observation before
  // collecting a new screen. This preserves strict batch binding across
  // independent --once invocations.
  const previousBatch = readJson(observationBatchPath(orch, workflowId));
  const consumedBatch = readJson(consumedBatchPath(orch, workflowId));
  const previousPending = Boolean(previousBatch?.batch_id) && consumedBatch.batch_id !== previousBatch.batch_id;
  const currentSurfaces = collectSurfaces(orch, getObservableTaskIds(orch, workflowId), workflowId);
  const decisionSurfaceMap = {};
  for (const surface of currentSurfaces) {
    decisionSurfaceMap[surface.node_id || surface.task_id] = {
      cmux_surface: surface.cmux_surface,
      run_dir: surface.run_dir,
      cli: surface.cli || '',
      node_id: surface.node_id || '',
      task_id: surface.task_id || '',
      workflow_id: surface.workflow_id || workflowId,
    };
  }
  if (previousBatch?.batch_id) {
    decisionResult = tryConsumeDecision(
      orch, workflowId, decisionSurfaceMap, previousBatch.batch_id, previousBatch.observations || []
    );
  }

  // Never overwrite a batch that still needs a Chief decision. A prematurely
  // started second review receives the same batch rather than advancing the
  // workflow and invalidating its eventual decision.
  if (previousPending && !decisionResult.processed) {
    return {
      action: 'observe',
      pending_review: true,
      decision_processed: false,
      decision_reason: decisionResult.reason || null,
      batch_id: previousBatch.batch_id,
      review_required: true,
      workflow_terminal: false,
      host_instruction: previousBatch.host_instruction || HOST_REVIEW_INSTRUCTION,
      chief_instruction: previousBatch.chief_instruction || SCREEN_REVIEW_INSTRUCTION,
      observations: previousBatch.observations || [],
      events_detected: 0,
      launches: [],
    };
  }

  const completion = checkWorkflowCompletion(orch, workflowId);
  if (completion.completed) {
    return {
      action: 'workflow_complete',
      ...completion,
      decision_processed: decisionResult.processed,
      review_required: false,
      workflow_terminal: true,
      host_instruction: null,
    };
  }

  // 2. Detect artifact/lifecycle events after applying the last decision.
  const events = detectEvents(orch, workflowId);

    // Add immediate events to the observation buffer.
    // Key by node_id for observation identity.
  for (const event of events) {
      const nodeKey = event.node_id || event.task;
      const existing = buffer.observations.find((o) => o.node_id === nodeKey);
      if (existing) {
        if (!existing.immediate_events) existing.immediate_events = [];
        existing.immediate_events.push(event);
      } else {
        buffer.observations.push({
          node_id: nodeKey,
          task_id: event.task,
          immediate_events: [event],
        });
      }
  }

  // 3. Launch ready nodes, including nodes queued by relaunch above.
  const launchResults = launchReadyNodes(orch, project, workflowId, skillDir);
  for (const launch of launchResults.filter((result) => !result.launched)) {
      const existing = buffer.observations.find((observation) => observation.node_id === launch.node_id);
      const event = {
        node_id: launch.node_id,
        task: launch.task,
        type: 'launch_failed',
        error: launch.error,
        diagnostic: launch.diagnostic || '',
        requires_decision: true,
      };
      if (existing) {
        if (!existing.immediate_events) existing.immediate_events = [];
        existing.immediate_events.push(event);
      } else {
        buffer.observations.push({ node_id: launch.node_id, task_id: launch.task, immediate_events: [event] });
      }
  }

  // 4. Read every active surface and emit exactly one next observation batch.
  collectCycle(orch, workflowId, buffer, reviewIntervalSeconds);
  const { batch } = flushBuffer(orch, workflowId, buffer);
  return {
    action: batch ? 'observe' : 'idle',
    decision_processed: decisionResult.processed,
    decision_reason: decisionResult.reason || null,
    batch_id: batch?.batch_id || null,
    review_required: Boolean(batch),
    workflow_terminal: false,
    host_instruction: batch?.host_instruction || null,
    chief_instruction: batch?.chief_instruction || null,
    observations: batch?.observations || [],
    events_detected: events.length,
    launches: launchResults,
  };
}

function waitLocally(milliseconds) {
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(sleeper, 0, 0, milliseconds);
}

function main() {
  const args = parseArgs(process.argv.slice(2), {
    flags: ['once', 'wait', 'json'],
    valued: ['project-dir', 'orchestrator-dir', 'workflow-id', 'poll-seconds'],
  });
  const project = path.resolve(String(args['project-dir'] || '').replace(/^~(?=$|\/|\\)/, process.env.HOME || ''));
  const orchRel = args['orchestrator-dir'] || '.taskforce';
  const orch = path.join(project, orchRel);
  const workflowId = args['workflow-id'] || '';
  const skillDir = path.resolve(
    String(args['skill-dir'] || '').replace(/^~(?=$|\/|\\)/, process.env.HOME || '') ||
    path.join(path.dirname(new URL(import.meta.url).pathname), '..')
  );

  if (!workflowId) {
    process.stderr.write('usage: supervisor_loop.mjs --project-dir --workflow-id (--once|--wait) [--poll-seconds 15] [--json]\n');
    return 2;
  }

  const lock = acquireSupervisorLock(orch, workflowId);
  if (!lock.ok) {
    process.stdout.write(JSON.stringify({
      action: 'supervisor_already_running', workflow_id: workflowId,
      status: lock.status, owner_pid: lock.owner_pid || null,
      review_required: false,
      workflow_terminal: false,
      host_instruction: 'Keep the existing supervisor; do not stop it or start another wait.',
      instruction: 'Keep the existing supervisor; do not stop it or start another wait.',
    }, null, 2) + '\n');
    return 0;
  }

  try {
    const pollSeconds = Math.max(0.01, Number(args['poll-seconds'] || 15));
    const pollMs = pollSeconds * 1000;
    let result;
    do {
      result = supervisorTick({ orch, project, workflowId, skillDir, reviewIntervalSeconds: pollSeconds });
      if (!args.wait || result.action !== 'idle') break;
      waitLocally(pollMs);
    } while (true);

    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return 0;
  } finally {
    releaseSupervisorLock(lock);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
