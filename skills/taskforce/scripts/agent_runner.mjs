#!/usr/bin/env node
// Run one CLI under a minimal file-based protocol.
// v0.2: no roles, no clarification gate, no direction check.
// The only prompt is the minimal task contract prompt (~500 tokens).
//
// Writes protocol startup evidence and a tui_exec.sh snippet. The generated
// cmux launcher sources that snippet so the CLI replaces the shell in-place.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {
  parseArgs,
  nowIso,
  readJson,
  atomicWriteJson,
  nodeRunDir,
  writeNodeState,
} from './protocol_lib.mjs';
import { tuiLaunchCommand, getAdapter } from './cli_adapters.mjs';
import { loadContract, compactSummary } from './task_contract.mjs';

// POSIX shell quoting.
function shQuote(part) {
  const s = String(part);
  if (s === '') return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, "'\"'\"'") + "'";
}

function shJoin(parts) {
  return parts.map((p) => shQuote(p)).join(' ');
}

// v0.2 minimal prompt: task contract + simple rules (~500 tokens).
export function minimalPrompt(contract, projectPath, runPath, taskId, recoveryContext = null) {
  const summary = compactSummary(contract);
  const recovery = recoveryContext && (recoveryContext.reason || recoveryContext.instruction)
    ? `\nRecovery context from the previous attempt:\n` +
      `- Reason: ${String(recoveryContext.reason || 'Previous attempt did not complete')}\n` +
      `- Chief instruction: ${String(recoveryContext.instruction || 'Use a different concrete approach and make progress promptly')}\n` +
      `- Do not repeat the stalled approach; inspect the current workspace before editing.\n`
    : '';
  return (
    `You are a Taskforce worker agent for task ${taskId}.\n\n` +
    `Task: ${summary.goal}\n` +
    `Boundaries: ${summary.boundaries.length > 0 ? summary.boundaries.join('; ') : '(work within allowed scope)'}\n` +
    `Validation: ${summary.validation.length > 0 ? summary.validation.join('; ') : '(run relevant validation)'}\n` +
    `Done when: ${summary.done_when.length > 0 ? summary.done_when.join('; ') : '(validation passes)'}\n` +
    recovery + `\n` +
    `Rules:\n` +
    `- Work within the specified boundaries.\n` +
    `- Create and modify all implementation files under the project root.\n` +
    `- Never place application source, assets, tests, or deliverables under .taskforce/.\n` +
    `- Run validation commands before declaring completion.\n` +
    `- If the chief sends a correction, read the correction, acknowledge it, and re-align.\n` +
    `- Write ${path.join(runPath, 'validation.json')} with the commands run, outcomes, and any remaining validation gaps.\n` +
    `- Write ${path.join(runPath, 'result.json')} when done with state: completed, failed, or blocked.\n` +
    `- If blocked or uncertain, write ${path.join(runPath, 'questions.json')} and stop.\n` +
    `- Do not modify files outside the allowed scope.\n\n` +
    `Project root (all implementation work): ${projectPath}\n` +
    `Protocol evidence directory (JSON evidence only): ${runPath}\n`
  );
}

// Write a tui_exec.sh shell snippet.
export function writeTuiExecScript(runPath, command) {
  const execPath = path.join(runPath, 'tui_exec.sh');
  const pidPath = path.join(runPath, 'agent.pid');
  const execLine = shJoin(command);
  fs.writeFileSync(
    execPath,
    '#!/usr/bin/env bash\n' +
    `printf '%s\\n' "$$" > ${shQuote(pidPath)}\n` +
    `exec ${execLine}\n`,
    'utf8'
  );
  fs.chmodSync(execPath, 0o755);
  return execPath;
}

function expandUser(p) {
  if (typeof p !== 'string') return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function main(argv) {
  const args = parseArgs(argv || process.argv.slice(2), {
    flags: ['prepare'],
    valued: [
      'project-dir',
      'orchestrator-dir',
      'task-file',
      'cli',
      'model',
      'workflow-id',
      'node-id',
    ],
  });
  if (!args['project-dir'] || !args['task-file'] || !args['cli'] || !args['workflow-id'] || !args['node-id']) {
    process.stderr.write(
      'usage: agent_runner.mjs --prepare --project-dir --task-file --cli --workflow-id --node-id [--model]\n'
    );
    return 2;
  }
  if (!args.prepare) {
    process.stderr.write('agent_runner.mjs is prepare-only; pass --prepare\n');
    return 2;
  }

  const project = path.resolve(expandUser(args['project-dir']));
  const orchRel = args['orchestrator-dir'] || '.taskforce';
  const orch = path.join(project, orchRel);
  let taskFile = args['task-file'];
  if (!path.isAbsolute(taskFile)) taskFile = path.join(project, taskFile);
  taskFile = path.resolve(taskFile);

  const cli = String(args.cli || '').trim();
  const model = args.model !== undefined ? args.model : null;
  const workflowId = args['workflow-id'];
  const nodeId = args['node-id'];

  if (!cli) {
    process.stderr.write('cli is required\n');
    return 1;
  }

  // Validate CLI adapter exists before proceeding.
  try {
    getAdapter(cli);
  } catch (e) {
    process.stderr.write(`Invalid CLI adapter: ${e.message}\n`);
    return 1;
  }

  // Load task contract (v0.2: JSON, not Markdown).
  // Fall back to Markdown task ID extraction for compatibility.
  const taskId = path.basename(taskFile, path.extname(taskFile));
  const contract = loadContract(orch, taskId) || { id: taskId, goal: `Complete task ${taskId}` };

  const workflow = readJson(path.join(orch, 'workflows', `${workflowId}.json`));
  const workflowNode = Array.isArray(workflow.nodes)
    ? workflow.nodes.find((node) => node.id === nodeId)
    : null;
  const recoveryContext = workflowNode && (workflowNode.relaunch_reason || workflowNode.relaunch_instruction)
    ? { reason: workflowNode.relaunch_reason || '', instruction: workflowNode.relaunch_instruction || '' }
    : null;

  const attemptId = nowIso().replace(/[-:]/g, '').replace('T', 'T');
  const runPath = nodeRunDir(orch, workflowId, nodeId, attemptId);
  fs.mkdirSync(runPath, { recursive: true });

  const promptText = minimalPrompt(contract, project, runPath, taskId, recoveryContext);
  const promptPath = path.join(runPath, 'prompt.txt');
  fs.writeFileSync(promptPath, promptText, 'utf8');
  const startedAt = nowIso();

  atomicWriteJson(path.join(runPath, 'launch.json'), {
    schema: 'taskforce.launch.v1',
    workflow_id: workflowId,
    node_id: nodeId,
    task_id: taskId,
    attempt_id: attemptId,
    cli,
    model,
    attempt_number: Number(workflowNode?.attempt_count || 1),
    recovery_context: recoveryContext,
    agent_pid_file: path.join(runPath, 'agent.pid'),
    started_at: startedAt,
  });

  // The node is already running from the supervisor's perspective. launch_phase
  // is factual metadata used until the cmux surface becomes readable.
  writeNodeState(orch, workflowId, nodeId, {
    schema: 'taskforce.node-state.v2',
    workflow_id: workflowId,
    node_id: nodeId,
    task_id: taskId,
    cli,
    model,
    status: 'running',
    launch_phase: 'ready',
    event: null,
    attempt_id: attemptId,
    started_at: startedAt,
    cmux_workspace: process.env.CMUX_WORKSPACE_ID || '',
    cmux_surface: process.env.CMUX_SURFACE_ID || '',
    run_dir: runPath,
    surface_read_failures: 0,
    last_screen_hash: '',
    last_screen_read_at: null,
    last_screen_change_at: null,
  });

  // Build the TUI command via CLI adapter.
  const command = tuiLaunchCommand(cli, model, promptText);
  fs.writeFileSync(
    path.join(runPath, 'command.json'),
    JSON.stringify({ command }, null, 2) + '\n',
    'utf8'
  );

  // Write the tui_exec.sh snippet.
  const execScriptPath = writeTuiExecScript(runPath, command);

  process.stdout.write(`TUI_EXEC_PATH=${execScriptPath}\n`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
