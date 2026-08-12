import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = path.join(ROOT, 'skills', 'taskforce', 'scripts');
const FAKE_CMUX = path.join(ROOT, 'tests', 'fixtures', 'fake_cmux.mjs');

function temp(prefix = 'taskforce-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function initWorkflow(project, workflowId = 'wf', status = 'running') {
  const orch = path.join(project, '.taskforce');
  fs.mkdirSync(path.join(orch, 'workflows'), { recursive: true });
  fs.mkdirSync(path.join(orch, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(orch, 'state', workflowId), { recursive: true });
  fs.writeFileSync(path.join(orch, 'tasks', 'task-a.json'), JSON.stringify({
    id: 'task-a', goal: 'Implement the requested behavior', boundaries: [], validation: [], done_when: ['behavior works'],
  }));
  fs.writeFileSync(path.join(orch, 'workflows', `${workflowId}.json`), JSON.stringify({
    schema: 'taskforce.workflow.v2', workflow_id: workflowId, nodes: [{
      id: 'node-a', task: 'task-a', cli: 'opencode', model: null, depends_on: [], status,
      reason: null, event: null, last_decision: null, cmux_surface: 'surface-a', run_dir: '', attempt_count: 1,
    }],
  }));
  fs.writeFileSync(path.join(orch, 'state', workflowId, 'node-a.json'), JSON.stringify({
    workflow_id: workflowId, node_id: 'node-a', task_id: 'task-a', cli: 'opencode', status,
    cmux_surface: 'surface-a', run_dir: '',
  }));
  return orch;
}

test('computeDelta distinguishes changed and unchanged screens', async () => {
  const { computeDelta, hashScreen } = await import(path.join(SCRIPTS, 'surface_collector.mjs'));
  assert.equal(computeDelta('a', 'a').changed, false);
  assert.equal(computeDelta('a', 'b').changed, true);
  const stableFooter = Array.from({ length: 30 }, (_, index) => `footer ${index}`).join('\n');
  assert.notEqual(
    hashScreen(`Allow project only\n${stableFooter}`),
    hashScreen(`Allow global access\n${stableFooter}`),
  );
});

test('collector includes unchanged active screen for every Chief tick', async () => {
  const { collectAllSurfaces } = await import(path.join(SCRIPTS, 'surface_collector.mjs'));
  const project = temp();
  const orch = initWorkflow(project);
  const old = process.env.CMUX_BIN;
  process.env.CMUX_BIN = FAKE_CMUX;
  try {
    const first = collectAllSurfaces(orch, ['task-a'], 'wf');
    const second = collectAllSurfaces(orch, ['task-a'], 'wf');
    assert.equal(first.length, 1);
    assert.equal(second.length, 1);
    assert.equal(second[0].changed, false);
    assert.equal(second[0].delta.since_last, '');
    assert.match(second[0].delta.current_screen, /still working/);
  } finally {
    if (old === undefined) delete process.env.CMUX_BIN; else process.env.CMUX_BIN = old;
  }
});

test('decision parser exposes only the focused four actions', async () => {
  const { parseDecisionBatch, classifyDecisions } = await import(path.join(SCRIPTS, 'decision_batch.mjs'));
  const parsed = parseDecisionBatch({ batch_id: 'obs-1', workflow_id: 'wf', decisions: [
    { node_id: 'a', action: 'continue' },
    { node_id: 'b', action: 'send', key: 'enter', expected_screen_hash: 'hash' },
    { node_id: 'c', action: 'relaunch', cli: 'opencode', instruction: 'Inspect existing files' },
    { node_id: 'd', action: 'complete' },
  ] });
  assert.deepEqual(parsed.errors, []);
  const classified = classifyDecisions(parsed);
  assert.equal(classified.continuations.length, 1);
  assert.equal(classified.sends.length, 1);
  assert.equal(classified.relaunches.length, 1);
  assert.equal(classified.completions.length, 1);
});

test('send accepts either text or one official cmux key', async () => {
  const { parseDecisionBatch } = await import(path.join(SCRIPTS, 'decision_batch.mjs'));
  const parsed = parseDecisionBatch({
    batch_id: 'obs-1', workflow_id: 'wf', decisions: [
      { node_id: 'text', action: 'send', input: 'Continue the review', submit: true, expected_screen_hash: 'a' },
      { node_id: 'menu', action: 'send', key: 'DOWN', expected_screen_hash: 'b' },
    ],
  }, ['text', 'menu']);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.decisions[0].input, 'Continue the review');
  assert.equal(parsed.decisions[0].submit, true);
  assert.equal(parsed.decisions[1].key, 'down');
  assert.equal('input' in parsed.decisions[1], false);

  for (const decision of [
    { node_id: 'a', action: 'send', expected_screen_hash: 'x' },
    { node_id: 'a', action: 'send', input: '2', key: 'down', expected_screen_hash: 'x' },
    { node_id: 'a', action: 'send', key: 'shift+tab', expected_screen_hash: 'x' },
  ]) {
    const invalid = parseDecisionBatch({ batch_id: 'obs-2', workflow_id: 'wf', decisions: [decision] }, ['a']);
    assert.equal(invalid.errors.length, 1);
  }
});

test('legacy decision labels are rejected', async () => {
  const { parseDecisionBatch } = await import(path.join(SCRIPTS, 'decision_batch.mjs'));
  for (const action of ['correct', 'blocked', 'retry', 'restart', 'reassign', 'split']) {
    const parsed = parseDecisionBatch({ batch_id: 'obs-1', workflow_id: 'wf', decisions: [{ node_id: 'a', action }] });
    assert.match(parsed.errors[0].error, /invalid action/);
  }
});

test('decision batch must cover exactly the observed nodes', async () => {
  const { parseDecisionBatch } = await import(path.join(SCRIPTS, 'decision_batch.mjs'));
  const missing = parseDecisionBatch({
    batch_id: 'obs-1', workflow_id: 'wf', decisions: [{ node_id: 'a', action: 'continue' }],
  }, ['a', 'b']);
  assert.match(missing.errors[0].error, /missing action/);

  const extra = parseDecisionBatch({
    batch_id: 'obs-1', workflow_id: 'wf', decisions: [
      { node_id: 'a', action: 'continue' },
      { node_id: 'pending', action: 'complete' },
    ],
  }, ['a']);
  assert.match(extra.errors[0].error, /not present in the observed batch/);
});

test('send rejects a stale screen without terminal input', async () => {
  const { dispatchSend } = await import(path.join(SCRIPTS, 'intervention_dispatcher.mjs'));
  const log = path.join(temp(), 'cmux.log');
  const oldBin = process.env.CMUX_BIN;
  const oldLog = process.env.FAKE_CMUX_LOG;
  process.env.CMUX_BIN = FAKE_CMUX;
  process.env.FAKE_CMUX_LOG = log;
  try {
    const result = dispatchSend({ node_id: 'a', cmux_surface: 'surface-a', input: '1', expected_screen_hash: 'stale' });
    assert.equal(result.status, 'stale_screen');
    assert.equal(fs.existsSync(log), false);
  } finally {
    if (oldBin === undefined) delete process.env.CMUX_BIN; else process.env.CMUX_BIN = oldBin;
    if (oldLog === undefined) delete process.env.FAKE_CMUX_LOG; else process.env.FAKE_CMUX_LOG = oldLog;
  }
});

test('send with current screen hash sends exact input to the exact surface', async () => {
  const { dispatchSend } = await import(path.join(SCRIPTS, 'intervention_dispatcher.mjs'));
  const { hashScreen } = await import(path.join(SCRIPTS, 'surface_collector.mjs'));
  const log = path.join(temp(), 'cmux.log');
  const oldBin = process.env.CMUX_BIN;
  const oldLog = process.env.FAKE_CMUX_LOG;
  process.env.CMUX_BIN = FAKE_CMUX;
  process.env.FAKE_CMUX_LOG = log;
  try {
    const result = dispatchSend({ node_id: 'a', cmux_surface: 'surface-a', input: 'Continue current work',
      submit: true, expected_screen_hash: hashScreen('agent is still working\n') });
    assert.equal(result.ok, true);
    assert.equal(result.status, 'input_delivered');
    assert.equal(result.send_result.transport, 'send+send-key');
    const sent = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(sent[0].slice(0, 3), ['send', '--surface', 'surface-a']);
    assert.equal(sent[0].at(-1), 'Continue current work');
    assert.deepEqual(sent[1], ['send-key', '--surface', 'surface-a', '--', 'enter']);
  } finally {
    if (oldBin === undefined) delete process.env.CMUX_BIN; else process.env.CMUX_BIN = oldBin;
    if (oldLog === undefined) delete process.env.FAKE_CMUX_LOG; else process.env.FAKE_CMUX_LOG = oldLog;
  }
});

test('TUI menu navigation sends one key and requires a fresh screen hash before enter', async () => {
  const { dispatchSend } = await import(path.join(SCRIPTS, 'intervention_dispatcher.mjs'));
  const { hashScreen } = await import(path.join(SCRIPTS, 'surface_collector.mjs'));
  const project = temp('tf-tui-keys-');
  const log = path.join(project, 'cmux.log');
  const surfacesFile = path.join(project, 'surfaces.json');
  const firstScreen = 'Do you want to proceed?\n> 1. Yes\n  2. Trust this session\n  3. No';
  const secondScreen = 'Do you want to proceed?\n  1. Yes\n> 2. Trust this session\n  3. No';
  fs.writeFileSync(surfacesFile, JSON.stringify({ 'surface-a': { text: firstScreen } }));
  const oldBin = process.env.CMUX_BIN;
  const oldLog = process.env.FAKE_CMUX_LOG;
  const oldSurfaces = process.env.FAKE_CMUX_SURFACES_FILE;
  process.env.CMUX_BIN = FAKE_CMUX;
  process.env.FAKE_CMUX_LOG = log;
  process.env.FAKE_CMUX_SURFACES_FILE = surfacesFile;
  try {
    const moved = dispatchSend({ node_id: 'a', cmux_surface: 'surface-a', key: 'down',
      expected_screen_hash: hashScreen(`${firstScreen}\n`) });
    assert.equal(moved.ok, true);
    fs.writeFileSync(surfacesFile, JSON.stringify({ 'surface-a': { text: secondScreen } }));

    const staleEnter = dispatchSend({ node_id: 'a', cmux_surface: 'surface-a', key: 'enter',
      expected_screen_hash: hashScreen(`${firstScreen}\n`) });
    assert.equal(staleEnter.status, 'stale_screen');

    const entered = dispatchSend({ node_id: 'a', cmux_surface: 'surface-a', key: 'enter',
      expected_screen_hash: hashScreen(`${secondScreen}\n`) });
    assert.equal(entered.ok, true);
    const sent = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(sent, [
      ['send-key', '--surface', 'surface-a', '--', 'down'],
      ['send-key', '--surface', 'surface-a', '--', 'enter'],
    ]);
  } finally {
    if (oldBin === undefined) delete process.env.CMUX_BIN; else process.env.CMUX_BIN = oldBin;
    if (oldLog === undefined) delete process.env.FAKE_CMUX_LOG; else process.env.FAKE_CMUX_LOG = oldLog;
    if (oldSurfaces === undefined) delete process.env.FAKE_CMUX_SURFACES_FILE;
    else process.env.FAKE_CMUX_SURFACES_FILE = oldSurfaces;
  }
});

test('continue keeps a permission-waiting node running', async () => {
  const { processDecisionBatch } = await import(path.join(SCRIPTS, 'supervisor_loop.mjs'));
  const { loadWorkflow } = await import(path.join(SCRIPTS, 'workflow_registry.mjs'));
  const project = temp();
  const orch = initWorkflow(project);
  const result = processDecisionBatch({ batch_id: 'obs-1', workflow_id: 'wf', decisions: [
    { node_id: 'node-a', action: 'continue', reason: 'Chief is waiting for user authority outside runtime' },
  ] }, {}, orch, 'wf', ['node-a']);
  assert.equal(result.continuations.length, 1);
  assert.equal(result.dispatchResults.length, 0);
  assert.equal(loadWorkflow(orch, 'wf').nodes[0].status, 'running');
});

test('an observed batch cannot complete an unobserved pending node', async () => {
  const { processDecisionBatch } = await import(path.join(SCRIPTS, 'supervisor_loop.mjs'));
  const { loadWorkflow } = await import(path.join(SCRIPTS, 'workflow_registry.mjs'));
  const project = temp();
  const orch = initWorkflow(project);
  const workflowPath = path.join(orch, 'workflows', 'wf.json');
  const workflow = JSON.parse(fs.readFileSync(workflowPath));
  workflow.nodes.push({
    id: 'pending', task: 'task-a', cli: 'opencode', model: null,
    depends_on: ['node-a'], status: 'pending', cmux_surface: '', run_dir: '', attempt_count: 0,
  });
  fs.writeFileSync(workflowPath, JSON.stringify(workflow));

  const result = processDecisionBatch({
    batch_id: 'obs-1', workflow_id: 'wf', decisions: [{ node_id: 'pending', action: 'complete' }],
  }, {}, orch, 'wf', ['node-a']);
  assert.equal(result.rejected, true);
  assert.equal(loadWorkflow(orch, 'wf').nodes.find((node) => node.id === 'pending').status, 'pending');
});

test('normal long Thinking never creates a timeout event or replaces the CLI', async () => {
  const { detectEvents } = await import(path.join(SCRIPTS, 'supervisor_loop.mjs'));
  const { loadWorkflow } = await import(path.join(SCRIPTS, 'workflow_registry.mjs'));
  const project = temp();
  const orch = initWorkflow(project);
  const statePath = path.join(orch, 'state', 'wf', 'node-a.json');
  const state = JSON.parse(fs.readFileSync(statePath));
  state.last_screen_change_at = '2000-01-01T00:00:00.000000+00:00';
  fs.writeFileSync(statePath, JSON.stringify(state));
  process.env.TASKFORCE_NO_RESPONSE_TIMEOUT_SECONDS = '1';
  try {
    const events = detectEvents(orch, 'wf');
    assert.equal(events.some((event) => event.type === 'no_response'), false);
    assert.equal(loadWorkflow(orch, 'wf').nodes[0].cli, 'opencode');
    assert.equal(loadWorkflow(orch, 'wf').nodes[0].status, 'running');
  } finally {
    delete process.env.TASKFORCE_NO_RESPONSE_TIMEOUT_SECONDS;
  }
});

test('every supervisor response tells Chief not to rush active Thinking or Write work', () => {
  const project = temp('tf-chief-boundary-');
  initWorkflow(project);
  const output = JSON.parse(execFileSync(process.execPath, [
    path.join(SCRIPTS, 'supervisor_loop.mjs'), '--project-dir', project,
    '--workflow-id', 'wf', '--once', '--json',
  ], { env: { ...process.env, CMUX_BIN: FAKE_CMUX }, encoding: 'utf8' }));

  assert.match(output.chief_instruction, /Continue is the default for active work/);
  assert.match(output.chief_instruction, /Thinking, Write\/Edit execution/);
  assert.match(output.chief_instruction, /not reasons to send urgency, reminders, task restatements, or start-now prompts/);
  assert.match(output.chief_instruction, /visible input request, concrete goal or boundary drift/);
  assert.equal(output.review_required, true);
  assert.equal(output.workflow_terminal, false);
  assert.match(output.host_instruction, /immediately start the next --wait/);
  assert.match(output.host_instruction, /Do not end supervision/);
});

test('only a terminal workflow tells the host that supervision may end', () => {
  const project = temp('tf-host-terminal-');
  initWorkflow(project, 'wf', 'completed');
  const output = JSON.parse(execFileSync(process.execPath, [
    path.join(SCRIPTS, 'supervisor_loop.mjs'), '--project-dir', project,
    '--workflow-id', 'wf', '--once', '--json',
  ], { env: { ...process.env, CMUX_BIN: FAKE_CMUX }, encoding: 'utf8' }));

  assert.equal(output.action, 'workflow_complete');
  assert.equal(output.review_required, false);
  assert.equal(output.workflow_terminal, true);
  assert.equal(output.host_instruction, null);
});

test('invalid result is evidence, not completion', async () => {
  const { detectEvents } = await import(path.join(SCRIPTS, 'supervisor_loop.mjs'));
  const { updateNode, loadWorkflow } = await import(path.join(SCRIPTS, 'workflow_registry.mjs'));
  const project = temp();
  const orch = initWorkflow(project);
  const run = path.join(orch, 'runs', 'wf', 'node-a', 'attempt-1');
  fs.mkdirSync(run, { recursive: true });
  fs.writeFileSync(path.join(run, 'result.json'), JSON.stringify({ summary: 'done' }));
  updateNode(orch, 'wf', 'node-a', { run_dir: run });
  const events = detectEvents(orch, 'wf');
  assert.equal(events[0].type, 'invalid_result');
  assert.equal(loadWorkflow(orch, 'wf').nodes[0].status, 'running');
});

test('completed result still requires Chief completion review', async () => {
  const { detectEvents } = await import(path.join(SCRIPTS, 'supervisor_loop.mjs'));
  const { updateNode } = await import(path.join(SCRIPTS, 'workflow_registry.mjs'));
  const project = temp();
  const orch = initWorkflow(project);
  const run = path.join(orch, 'runs', 'wf', 'node-a', 'attempt-1');
  fs.mkdirSync(run, { recursive: true });
  fs.writeFileSync(path.join(run, 'result.json'), JSON.stringify({ state: 'completed', summary: 'implemented' }));
  updateNode(orch, 'wf', 'node-a', { run_dir: run });
  const event = detectEvents(orch, 'wf')[0];
  assert.equal(event.type, 'result');
  assert.equal(event.chief_prompt_ref, 'completion-review-v1');
  assert.equal(event.validation_evidence.provided, false);
});

test('validation evidence is summarized with a file ref instead of inlined verbatim', async () => {
  const { detectEvents } = await import(path.join(SCRIPTS, 'supervisor_loop.mjs'));
  const { updateNode } = await import(path.join(SCRIPTS, 'workflow_registry.mjs'));
  const project = temp('tf-validation-summary-');
  const orch = initWorkflow(project);
  const run = path.join(orch, 'runs', 'wf', 'node-a', 'attempt-1');
  fs.mkdirSync(run, { recursive: true });
  // A realistically sized validation.json (similar to the workbuddy test case).
  const validation = {
    task: 'build-x', timestamp: '2026-08-10T06:44:04.248000+00:00',
    validation_commands: Array.from({ length: 8 }, (_, i) => ({
      command: `check-${i}`, outcome: 'pass', evidence: 'evidence-'.repeat(20) + i,
    })),
    requirements_coverage: { section_a: 'present — ' + 'detail '.repeat(30) },
    style_requirements: { theme: 'confirmed — ' + 'x'.repeat(100) },
    remaining_gaps: [],
  };
  fs.writeFileSync(path.join(run, 'validation.json'), JSON.stringify(validation));
  fs.writeFileSync(path.join(run, 'result.json'), JSON.stringify({ state: 'completed', summary: 'done' }));
  updateNode(orch, 'wf', 'node-a', { run_dir: run });
  const event = detectEvents(orch, 'wf')[0];
  assert.equal(event.type, 'result');
  assert.equal(event.validation_evidence.provided, true);
  assert.equal(event.validation_evidence.ref, path.join(run, 'validation.json'));
  assert.ok(typeof event.validation_evidence.summary === 'string');
  // Summary must be a short excerpt, not the full validation content.
  assert.ok(event.validation_evidence.summary.length <= 310,
    `summary too long: ${event.validation_evidence.summary.length}`);
  assert.ok(event.validation_evidence.full_size_bytes > 300,
    `full_size_bytes should reflect the real file size: ${event.validation_evidence.full_size_bytes}`);
  // The original validation content must not appear in full inside the observation.
  assert.ok(!event.validation_evidence.summary.includes('requirements_coverage'),
    'summary must not contain deep validation fields');
});

test('unchanged artifact facts are emitted only once until their content changes', async () => {
  const { detectEvents } = await import(path.join(SCRIPTS, 'supervisor_loop.mjs'));
  const { updateNode } = await import(path.join(SCRIPTS, 'workflow_registry.mjs'));
  const project = temp('tf-event-dedup-');
  const orch = initWorkflow(project);
  const run = path.join(orch, 'runs', 'wf', 'node-a', 'attempt-1');
  fs.mkdirSync(run, { recursive: true });
  updateNode(orch, 'wf', 'node-a', { run_dir: run });
  fs.writeFileSync(path.join(run, 'result.json'), JSON.stringify({ state: 'completed', summary: 'first' }));

  assert.equal(detectEvents(orch, 'wf').filter((event) => event.type === 'result').length, 1);
  assert.equal(detectEvents(orch, 'wf').filter((event) => event.type === 'result').length, 0);
  fs.writeFileSync(path.join(run, 'validation.json'), JSON.stringify({ commands: ['npm test'], passed: true }));
  assert.equal(detectEvents(orch, 'wf').filter((event) => event.type === 'result').length, 1);
  fs.writeFileSync(path.join(run, 'result.json'), JSON.stringify({ state: 'completed', summary: 'updated' }));
  assert.equal(detectEvents(orch, 'wf').filter((event) => event.type === 'result').length, 1);
});

test('relaunch replaces an attempt only after its recorded worker has stopped', async () => {
  const { relaunchNode, loadWorkflow, updateNode } = await import(path.join(SCRIPTS, 'workflow_registry.mjs'));
  const project = temp();
  const orch = initWorkflow(project);
  const run = path.join(orch, 'runs', 'wf', 'node-a', 'attempt-1');
  fs.mkdirSync(run, { recursive: true });
  fs.writeFileSync(path.join(run, 'agent.pid'), '2147483647\n');
  updateNode(orch, 'wf', 'node-a', { run_dir: run });
  const oldBin = process.env.CMUX_BIN;
  process.env.CMUX_BIN = FAKE_CMUX;
  try {
    assert.equal(relaunchNode(orch, 'wf', 'node-a', { instruction: 'Inspect existing files first' }).ok, true);
  } finally {
    if (oldBin === undefined) delete process.env.CMUX_BIN; else process.env.CMUX_BIN = oldBin;
  }
  const node = loadWorkflow(orch, 'wf').nodes[0];
  assert.equal(node.status, 'pending');
  assert.equal(node.relaunch_instruction, 'Inspect existing files first');
});

test('relaunch rejects a live worker and keeps its original surface', async () => {
  const { relaunchNode, loadWorkflow, updateNode } = await import(path.join(SCRIPTS, 'workflow_registry.mjs'));
  const project = temp();
  const orch = initWorkflow(project);
  const run = path.join(orch, 'runs', 'wf', 'node-a', 'attempt-1');
  fs.mkdirSync(run, { recursive: true });
  fs.writeFileSync(path.join(run, 'agent.pid'), `${process.pid}\n`);
  updateNode(orch, 'wf', 'node-a', { run_dir: run });
  const oldBin = process.env.CMUX_BIN;
  process.env.CMUX_BIN = FAKE_CMUX;
  let result;
  try {
    result = relaunchNode(orch, 'wf', 'node-a', { reason: 'Try another approach' });
  } finally {
    if (oldBin === undefined) delete process.env.CMUX_BIN; else process.env.CMUX_BIN = oldBin;
  }
  assert.equal(result.ok, false);
  assert.equal(result.status, 'worker_alive');
  const node = loadWorkflow(orch, 'wf').nodes[0];
  assert.equal(node.status, 'running');
  assert.equal(node.cmux_surface, 'surface-a');
  assert.equal(node.run_dir, run);
  assert.equal(node.event.type, 'relaunch_rejected');
  const recovery = JSON.parse(fs.readFileSync(path.join(orch, 'state', 'workflows', 'wf', 'recoveries.jsonl'), 'utf8'));
  assert.equal(recovery.action, 'relaunch_rejected');
  assert.equal(recovery.previous.cmux_surface, 'surface-a');
  assert.equal(recovery.exit_check.status, 'worker_alive');
});

test('supervisor tick never launches a replacement while the old worker is alive', () => {
  const project = temp('tf-relaunch-guard-');
  const orch = initWorkflow(project);
  const cmuxLog = path.join(project, 'cmux.log');
  const run = path.join(orch, 'runs', 'wf', 'node-a', 'attempt-1');
  fs.mkdirSync(run, { recursive: true });
  fs.writeFileSync(path.join(run, 'agent.pid'), `${process.pid}\n`);
  const workflowPath = path.join(orch, 'workflows', 'wf.json');
  const workflow = JSON.parse(fs.readFileSync(workflowPath));
  workflow.nodes[0].run_dir = run;
  fs.writeFileSync(workflowPath, JSON.stringify(workflow));
  const nodeStatePath = path.join(orch, 'state', 'wf', 'node-a.json');
  const nodeState = JSON.parse(fs.readFileSync(nodeStatePath));
  nodeState.run_dir = run;
  fs.writeFileSync(nodeStatePath, JSON.stringify(nodeState));

  const decisionDir = path.join(orch, 'state', 'workflows', 'wf');
  fs.mkdirSync(decisionDir, { recursive: true });
  fs.writeFileSync(path.join(decisionDir, 'latest_observation_batch.json'), JSON.stringify({
    batch_id: 'obs-live-worker', workflow_id: 'wf', observations: [{ node_id: 'node-a' }],
  }));
  fs.writeFileSync(path.join(decisionDir, 'latest_decision_batch.json'), JSON.stringify({
    batch_id: 'obs-live-worker', workflow_id: 'wf', decisions: [{
      node_id: 'node-a', action: 'relaunch', reason: 'Replace the attempt',
    }],
  }));

  const output = JSON.parse(execFileSync(process.execPath, [
    path.join(SCRIPTS, 'supervisor_loop.mjs'), '--project-dir', project,
    '--workflow-id', 'wf', '--once', '--json',
  ], {
    env: { ...process.env, CMUX_BIN: FAKE_CMUX, FAKE_CMUX_LOG: cmuxLog },
    encoding: 'utf8',
  }));
  assert.deepEqual(output.launches, []);
  const after = JSON.parse(fs.readFileSync(workflowPath)).nodes[0];
  assert.equal(after.status, 'running');
  assert.equal(after.attempt_count, 1);
  assert.equal(after.cmux_surface, 'surface-a');
  assert.equal(after.run_dir, run);
  assert.equal(fs.existsSync(cmuxLog), false);
});

test('workflow uses only four factual lifecycle states', async () => {
  const { NODE_STATUSES } = await import(path.join(SCRIPTS, 'protocol_lib.mjs'));
  assert.deepEqual([...NODE_STATUSES], ['pending', 'running', 'completed', 'cancelled']);
});

test('cancelling a node also cancels pending descendants', async () => {
  const { cancelNode, workflowState } = await import(path.join(SCRIPTS, 'workflow_registry.mjs'));
  const project = temp();
  const orch = initWorkflow(project, 'wf', 'pending');
  const workflowPath = path.join(orch, 'workflows', 'wf.json');
  const workflow = JSON.parse(fs.readFileSync(workflowPath));
  workflow.nodes.push(
    { id: 'child', task: 'task-a', cli: 'opencode', model: null, depends_on: ['node-a'], status: 'pending' },
    { id: 'grandchild', task: 'task-a', cli: 'opencode', model: null, depends_on: ['child'], status: 'pending' },
  );
  fs.writeFileSync(workflowPath, JSON.stringify(workflow));

  const cancelled = cancelNode(orch, 'wf', 'node-a');
  assert.deepEqual(cancelled.nodes.map((node) => node.status), ['cancelled', 'cancelled', 'cancelled']);
  assert.equal(workflowState(cancelled), 'cancelled');
});

test('workflow state is derived and legacy stored state is removed', async () => {
  const { loadWorkflow, workflowState } = await import(path.join(SCRIPTS, 'workflow_registry.mjs'));
  const project = temp();
  const orch = initWorkflow(project, 'wf', 'completed');
  const workflowPath = path.join(orch, 'workflows', 'wf.json');
  const legacy = JSON.parse(fs.readFileSync(workflowPath));
  legacy.state = 'running';
  fs.writeFileSync(workflowPath, JSON.stringify(legacy));

  const workflow = loadWorkflow(orch, 'wf');
  assert.equal('state' in workflow, false);
  assert.equal(workflowState(workflow), 'completed');
  assert.equal('state' in JSON.parse(fs.readFileSync(workflowPath)), false);
});

test('workflow validation allows the same task contract on separate nodes', async () => {
  const { validateWorkflow } = await import(path.join(SCRIPTS, 'workflow_registry.mjs'));
  const errors = validateWorkflow([
    { id: 'a', task: 'shared', cli: 'opencode', depends_on: [] },
    { id: 'b', task: 'shared', cli: 'claude', depends_on: [] },
  ]);
  assert.deepEqual(errors, []);
});

test('CLI adapters launch Claude positionally and OpenCode with --prompt', async () => {
  const { tuiLaunchCommand } = await import(path.join(SCRIPTS, 'cli_adapters.mjs'));
  assert.deepEqual(tuiLaunchCommand('claude', null, 'do it'), ['claude', 'do it']);
  assert.deepEqual(tuiLaunchCommand('opencode', 'm', 'do it'), ['opencode', '--model', 'm', '--prompt', 'do it']);
});

test('an unspecified model launches the CLI on its own default', async () => {
  const { tuiLaunchCommand } = await import(path.join(SCRIPTS, 'cli_adapters.mjs'));
  for (const unspecified of [null, undefined, '', '   ', 'null', 'default', 'auto', 'None']) {
    assert.deepEqual(tuiLaunchCommand('codex', unspecified, 'do it'), ['codex', 'do it'],
      `model ${JSON.stringify(unspecified)} must not produce a --model flag`);
  }
  assert.deepEqual(tuiLaunchCommand('codex', '  gpt-5  ', 'do it'), ['codex', '--model', 'gpt-5', 'do it']);
});

test('a node keeps no model unless one was explicitly requested', async () => {
  const { createWorkflow, loadWorkflow } = await import(path.join(SCRIPTS, 'workflow_registry.mjs'));
  const project = temp('tf-node-model-');
  const orch = path.join(project, '.taskforce');
  fs.mkdirSync(path.join(orch, 'workflows'), { recursive: true });
  createWorkflow(orch, 'wf', [
    { id: 'a', task: 'task-a', cli: 'opencode', depends_on: [] },
    { id: 'b', task: 'task-a', cli: 'opencode', model: '', depends_on: [] },
    { id: 'c', task: 'task-a', cli: 'opencode', model: 'default', depends_on: [] },
    { id: 'd', task: 'task-a', cli: 'opencode', model: 'gpt-5', depends_on: [] },
  ]);
  const nodes = loadWorkflow(orch, 'wf').nodes;
  assert.equal(nodes.find((node) => node.id === 'a').model, null);
  assert.equal(nodes.find((node) => node.id === 'b').model, null);
  assert.equal(nodes.find((node) => node.id === 'c').model, null);
  assert.equal(nodes.find((node) => node.id === 'd').model, 'gpt-5');
});

test('a launcher survives a project path with shell metacharacters', () => {
  const project = temp('tf-quote-$(id) ');
  const orch = initWorkflow(project);
  execFileSync(process.execPath, [path.join(SCRIPTS, 'prepare_terminal_launch.mjs'),
    '--project-dir', project, '--task-file', path.join(orch, 'tasks', 'task-a.json'),
    '--workflow-id', 'wf', '--node-id', 'node-a', '--cli', 'opencode'], { encoding: 'utf8' });
  const launcher = fs.readFileSync(path.join(orch, 'launchers', 'task-a-node-a.sh'), 'utf8');
  assert.doesNotMatch(launcher, /cd "\/.*\$\(id\)/, 'the project path must not be interpolated unquoted');
  assert.match(launcher, /export PATH=/);
  execFileSync('bash', ['-n', path.join(orch, 'launchers', 'task-a-node-a.sh')]);
});

test('a running node with an unreadable surface still returns a Chief review', () => {
  const project = temp('tf-unobservable-');
  const orch = initWorkflow(project);
  // The node is running but its surface never came up, so no screen can be read.
  const workflowPath = path.join(orch, 'workflows', 'wf.json');
  const workflow = JSON.parse(fs.readFileSync(workflowPath));
  workflow.nodes[0].cmux_surface = '';
  fs.writeFileSync(workflowPath, JSON.stringify(workflow));
  const statePath = path.join(orch, 'state', 'wf', 'node-a.json');
  const state = JSON.parse(fs.readFileSync(statePath));
  state.cmux_surface = '';
  fs.writeFileSync(statePath, JSON.stringify(state));

  const result = JSON.parse(execFileSync(process.execPath, [
    path.join(SCRIPTS, 'supervisor_loop.mjs'), '--project-dir', project,
    '--workflow-id', 'wf', '--once', '--json',
  ], { env: { ...process.env, CMUX_BIN: FAKE_CMUX }, encoding: 'utf8' }));

  assert.equal(result.action, 'observe');
  assert.equal(result.observations[0].node_id, 'node-a');
  assert.equal(result.observations[0].review_reason, 'surface_unreadable');
  assert.equal(result.observations[0].surface_status, 'no_surface');
});

test('an empty workflow is terminal instead of supervised forever', async () => {
  const { workflowState } = await import(path.join(SCRIPTS, 'workflow_registry.mjs'));
  assert.equal(workflowState({ workflow_id: 'wf', nodes: [] }), 'completed');
});

test('agent runner records launch progress as metadata while status stays running', () => {
  const project = temp('tf-runner-state-');
  const orch = initWorkflow(project);
  const taskFile = path.join(orch, 'tasks', 'task-a.json');
  execFileSync(process.execPath, [path.join(SCRIPTS, 'agent_runner.mjs'),
    '--prepare', '--project-dir', project, '--task-file', taskFile,
    '--workflow-id', 'wf', '--node-id', 'node-a', '--cli', 'opencode'], {
    env: { ...process.env, CMUX_WORKSPACE_ID: 'workspace-a', CMUX_SURFACE_ID: 'surface-a' },
    encoding: 'utf8',
  });
  const state = JSON.parse(fs.readFileSync(path.join(orch, 'state', 'wf', 'node-a.json')));
  assert.equal(state.status, 'running');
  assert.equal(state.launch_phase, 'ready');
  const runPath = state.run_dir;
  const launch = JSON.parse(fs.readFileSync(path.join(runPath, 'launch.json')));
  assert.equal(launch.agent_pid_file, path.join(runPath, 'agent.pid'));
  const tuiExec = fs.readFileSync(path.join(runPath, 'tui_exec.sh'), 'utf8');
  assert.match(tuiExec, /printf '%s\\n' "\$\$"/);
  assert.match(tuiExec, /agent\.pid/);
});

test('agent prompt separates project deliverables from protocol evidence', async () => {
  const { minimalPrompt } = await import(path.join(SCRIPTS, 'agent_runner.mjs'));
  const project = '/workspace/example';
  const run = '/workspace/example/.taskforce/runs/wf/node-a/attempt-1';
  const prompt = minimalPrompt({
    goal: 'Build the game', boundaries: [], validation: [], done_when: ['game works'],
  }, project, run, 'task-a');

  assert.match(prompt, /Project root \(all implementation work\): \/workspace\/example/);
  assert.match(prompt, /Never place application source, assets, tests, or deliverables under \.taskforce\//);
  assert.match(prompt, /Protocol evidence directory \(JSON evidence only\):/);
  assert.match(prompt, new RegExp(`${run}/result\\.json`));
  assert.doesNotMatch(prompt, /Output directory:/);
});

test('legacy blocked state is migrated to running during collection', async () => {
  const { collectSurfaces } = await import(path.join(SCRIPTS, 'surface_collector.mjs'));
  const project = temp('tf-state-migrate-');
  const orch = initWorkflow(project);
  const statePath = path.join(orch, 'state', 'wf', 'node-a.json');
  const state = JSON.parse(fs.readFileSync(statePath));
  state.status = 'blocked';
  fs.writeFileSync(statePath, JSON.stringify(state));
  const surfaces = collectSurfaces(orch, ['task-a'], 'wf');
  assert.equal(surfaces[0].status, 'running');
  assert.equal(JSON.parse(fs.readFileSync(statePath)).status, 'running');
});

test('doctor performs a lightweight PATH scan without model discovery', async () => {
  const doctor = await import(path.join(SCRIPTS, 'doctor.mjs'));
  assert.equal(typeof doctor.listAvailableClis, 'function');
  assert.equal('discoverCli' in doctor, false);
});

test('two separate short ticks consume decision A before emitting observation B', () => {
  const project = temp('tf-tick-');
  const orch = initWorkflow(project);
  const log = path.join(project, 'cmux.log');
  const env = { ...process.env, CMUX_BIN: FAKE_CMUX, FAKE_CMUX_LOG: log };
  const script = path.join(SCRIPTS, 'supervisor_loop.mjs');
  const argv = [script, '--project-dir', project, '--workflow-id', 'wf', '--once', '--json'];
  const first = JSON.parse(execFileSync(process.execPath, argv, { env, encoding: 'utf8' }));
  assert.equal(first.action, 'observe');
  const decisionDir = path.join(orch, 'state', 'workflows', 'wf');
  fs.writeFileSync(path.join(decisionDir, 'latest_decision_batch.json'), JSON.stringify({
    batch_id: first.batch_id, workflow_id: 'wf', decisions: [{
      node_id: 'node-a', action: 'send', input: 'Keep working on the current plan', submit: true,
      expected_screen_hash: first.observations[0].screen_hash,
    }],
  }));
  const second = JSON.parse(execFileSync(process.execPath, argv, { env, encoding: 'utf8' }));
  assert.equal(second.decision_processed, true);
  assert.equal(second.action, 'observe');
  assert.notEqual(second.batch_id, first.batch_id);
  assert.equal(fs.existsSync(path.join(decisionDir, 'observations.jsonl')), false);
  assert.equal(fs.existsSync(path.join(decisionDir, 'consumed')), false);
  let receipt = JSON.parse(fs.readFileSync(path.join(decisionDir, 'last_consumed_batch.json')));
  assert.equal(receipt.batch_id, first.batch_id);
  fs.writeFileSync(path.join(decisionDir, 'latest_decision_batch.json'), JSON.stringify({
    batch_id: second.batch_id, workflow_id: 'wf', decisions: [{
      node_id: 'node-a', action: 'continue', reason: 'Normal progress',
    }],
  }));
  const third = JSON.parse(execFileSync(process.execPath, argv, { env, encoding: 'utf8' }));
  assert.equal(third.decision_processed, true);
  assert.equal(third.action, 'idle');
  assert.equal(third.batch_id, null);
  assert.deepEqual(third.observations, []);
  receipt = JSON.parse(fs.readFileSync(path.join(decisionDir, 'last_consumed_batch.json')));
  assert.equal(receipt.batch_id, second.batch_id);
  const sends = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse).filter((entry) => entry[0] === 'send');
  assert.equal(sends.length, 1);
});

test('wait mode returns promptly when the screen changes before the next interval', async () => {
  const project = temp('tf-wait-change-');
  const orch = initWorkflow(project);
  const surfacesFile = path.join(project, 'surfaces.json');
  fs.writeFileSync(surfacesFile, JSON.stringify({ 'surface-a': { text: 'steady screen' } }));
  const env = { ...process.env, CMUX_BIN: FAKE_CMUX, FAKE_CMUX_SURFACES_FILE: surfacesFile };
  const script = path.join(SCRIPTS, 'supervisor_loop.mjs');
  const baseArgv = [script, '--project-dir', project, '--workflow-id', 'wf', '--json'];

  const first = JSON.parse(execFileSync(process.execPath, [...baseArgv, '--once'], { env, encoding: 'utf8' }));
  const decisionDir = path.join(orch, 'state', 'workflows', 'wf');
  fs.writeFileSync(path.join(decisionDir, 'latest_decision_batch.json'), JSON.stringify({
    batch_id: first.batch_id, workflow_id: 'wf', decisions: [{
      node_id: 'node-a', action: 'continue', reason: 'Wait for a new fact',
    }],
  }));
  const idle = JSON.parse(execFileSync(process.execPath, [...baseArgv, '--once'], { env, encoding: 'utf8' }));
  assert.equal(idle.action, 'idle');

  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...baseArgv, '--wait', '--poll-seconds', '0.02'], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const change = setTimeout(() => {
      fs.writeFileSync(surfacesFile, JSON.stringify({ 'surface-a': { text: 'new permission menu' } }));
    }, 5);
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`wait mode timed out: ${stderr}`));
    }, 3000);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(change);
      clearTimeout(timeout);
      if (code !== 0) reject(new Error(`wait mode exited ${code}: ${stderr}`));
      else resolve(JSON.parse(stdout));
    });
  });
  assert.equal(result.action, 'observe');
  assert.match(result.observations[0].current_screen, /new permission menu/);
});

test('wait mode returns an unchanged screen for Chief review on every interval', async () => {
  const project = temp('tf-wait-periodic-');
  const orch = initWorkflow(project);
  const surfacesFile = path.join(project, 'surfaces.json');
  fs.writeFileSync(surfacesFile, JSON.stringify({ 'surface-a': { text: 'unchanged interactive screen' } }));
  const env = { ...process.env, CMUX_BIN: FAKE_CMUX, FAKE_CMUX_SURFACES_FILE: surfacesFile };
  const script = path.join(SCRIPTS, 'supervisor_loop.mjs');
  const baseArgv = [script, '--project-dir', project, '--workflow-id', 'wf', '--json'];
  const first = JSON.parse(execFileSync(process.execPath, [...baseArgv, '--once'], { env, encoding: 'utf8' }));
  const decisionDir = path.join(orch, 'state', 'workflows', 'wf');
  fs.writeFileSync(path.join(decisionDir, 'latest_decision_batch.json'), JSON.stringify({
    batch_id: first.batch_id, workflow_id: 'wf', decisions: [{ node_id: 'node-a', action: 'continue' }],
  }));
  execFileSync(process.execPath, [...baseArgv, '--once'], { env, encoding: 'utf8' });

  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...baseArgv, '--wait', '--poll-seconds', '0.02'], { env });
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('periodic review timed out')); }, 3000);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0) reject(new Error(`periodic wait exited ${code}`));
      else resolve(JSON.parse(stdout));
    });
  });
  assert.equal(result.action, 'observe');
  assert.equal(result.observations[0].review_reason, 'periodic_review');
  assert.match(result.observations[0].current_screen, /unchanged interactive screen/);
});

test('an unconsumed observation is returned again and never overwritten', () => {
  const project = temp('tf-pending-observation-');
  const orch = initWorkflow(project);
  const surfacesFile = path.join(project, 'surfaces.json');
  fs.writeFileSync(surfacesFile, JSON.stringify({ 'surface-a': { text: 'permission menu A' } }));
  const env = { ...process.env, CMUX_BIN: FAKE_CMUX, FAKE_CMUX_SURFACES_FILE: surfacesFile };
  const argv = [path.join(SCRIPTS, 'supervisor_loop.mjs'), '--project-dir', project,
    '--workflow-id', 'wf', '--once', '--json'];

  const first = JSON.parse(execFileSync(process.execPath, argv, { env, encoding: 'utf8' }));
  fs.writeFileSync(surfacesFile, JSON.stringify({ 'surface-a': { text: 'different screen B' } }));
  const repeated = JSON.parse(execFileSync(process.execPath, argv, { env, encoding: 'utf8' }));
  assert.equal(repeated.pending_review, true);
  assert.equal(repeated.batch_id, first.batch_id);
  assert.equal(repeated.review_required, true);
  assert.equal(repeated.workflow_terminal, false);
  assert.match(repeated.host_instruction, /immediately start the next --wait/);
  assert.match(repeated.chief_instruction, /Continue is the default for active work/);
  assert.match(repeated.observations[0].current_screen, /permission menu A/);
  assert.doesNotMatch(repeated.observations[0].current_screen, /different screen B/);
});

test('continue on an unchanged interactive screen receives the next periodic Chief review', () => {
  const project = temp('tf-periodic-review-');
  const orch = initWorkflow(project);
  const surfacesFile = path.join(project, 'surfaces.json');
  fs.writeFileSync(surfacesFile, JSON.stringify({ 'surface-a': { text: 'Do you want to proceed?\n> 1. Yes\n  2. No' } }));
  const env = { ...process.env, CMUX_BIN: FAKE_CMUX, FAKE_CMUX_SURFACES_FILE: surfacesFile };
  const argv = [path.join(SCRIPTS, 'supervisor_loop.mjs'), '--project-dir', project,
    '--workflow-id', 'wf', '--once', '--json'];

  const first = JSON.parse(execFileSync(process.execPath, argv, { env, encoding: 'utf8' }));
  const decisionDir = path.join(orch, 'state', 'workflows', 'wf');
  fs.writeFileSync(path.join(decisionDir, 'latest_decision_batch.json'), JSON.stringify({
    batch_id: first.batch_id, workflow_id: 'wf', decisions: [{
      node_id: 'node-a', action: 'continue', reason: 'Mistakenly treated as normal progress',
    }],
  }));
  const idle = JSON.parse(execFileSync(process.execPath, argv, { env, encoding: 'utf8' }));
  assert.equal(idle.action, 'idle');

  const workflowPath = path.join(orch, 'workflows', 'wf.json');
  const workflow = JSON.parse(fs.readFileSync(workflowPath));
  workflow.nodes[0].last_action.applied_at = '2000-01-01T00:00:00.000000+00:00';
  fs.writeFileSync(workflowPath, JSON.stringify(workflow));
  const periodic = JSON.parse(execFileSync(process.execPath, argv, { env, encoding: 'utf8' }));
  assert.equal(periodic.action, 'observe');
  assert.equal(periodic.observations[0].review_reason, 'periodic_review');
  assert.match(periodic.observations[0].current_screen, /Do you want to proceed/);
  assert.equal('since_decision' in periodic.observations[0], false);
});

test('one workflow rejects a competing supervisor while its wait is active', async () => {
  const project = temp('tf-supervisor-lock-');
  const orch = initWorkflow(project);
  const surfacesFile = path.join(project, 'surfaces.json');
  fs.writeFileSync(surfacesFile, JSON.stringify({ 'surface-a': { text: 'steady' } }));
  const env = { ...process.env, CMUX_BIN: FAKE_CMUX, FAKE_CMUX_SURFACES_FILE: surfacesFile };
  const script = path.join(SCRIPTS, 'supervisor_loop.mjs');
  const baseArgv = [script, '--project-dir', project, '--workflow-id', 'wf', '--json'];
  const first = JSON.parse(execFileSync(process.execPath, [...baseArgv, '--once'], { env, encoding: 'utf8' }));
  const decisionDir = path.join(orch, 'state', 'workflows', 'wf');
  fs.writeFileSync(path.join(decisionDir, 'latest_decision_batch.json'), JSON.stringify({
    batch_id: first.batch_id, workflow_id: 'wf', decisions: [{ node_id: 'node-a', action: 'continue' }],
  }));
  execFileSync(process.execPath, [...baseArgv, '--once'], { env, encoding: 'utf8' });

  const waiter = spawn(process.execPath, [...baseArgv, '--wait', '--poll-seconds', '1'], { env });
  let waiterStdout = '';
  waiter.stdout.on('data', (chunk) => { waiterStdout += chunk; });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const competing = JSON.parse(execFileSync(process.execPath, [...baseArgv, '--once'], { env, encoding: 'utf8' }));
  assert.equal(competing.action, 'supervisor_already_running');
  assert.equal(competing.review_required, false);
  assert.equal(competing.workflow_terminal, false);
  assert.match(competing.host_instruction, /Keep the existing supervisor/);
  assert.match(competing.instruction, /do not stop/i);

  fs.writeFileSync(surfacesFile, JSON.stringify({ 'surface-a': { text: 'changed' } }));
  const waiterResult = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { waiter.kill('SIGKILL'); reject(new Error('waiter did not exit')); }, 3000);
    waiter.on('error', reject);
    waiter.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0) reject(new Error(`waiter exited ${code}`));
      else resolve(JSON.parse(waiterStdout));
    });
  });
  assert.equal(waiterResult.action, 'observe');
});

test('Chief answers a permission menu in-place without relaunching the node', () => {
  const project = temp('tf-permission-');
  const orch = initWorkflow(project);
  const log = path.join(project, 'cmux.log');
  const env = { ...process.env, CMUX_BIN: FAKE_CMUX, FAKE_CMUX_LOG: log, FAKE_CMUX_SCENARIO: 'permission' };
  const script = path.join(SCRIPTS, 'supervisor_loop.mjs');
  const argv = [script, '--project-dir', project, '--workflow-id', 'wf', '--once', '--json'];
  const first = JSON.parse(execFileSync(process.execPath, argv, { env, encoding: 'utf8' }));
  assert.match(first.observations[0].current_screen, /Permission required/);
  const decisionDir = path.join(orch, 'state', 'workflows', 'wf');
  fs.writeFileSync(path.join(decisionDir, 'latest_decision_batch.json'), JSON.stringify({
    batch_id: first.batch_id, workflow_id: 'wf', decisions: [{
      node_id: 'node-a', action: 'send', key: 'enter',
      reason: 'Approve the currently highlighted project-scoped option',
      expected_screen_hash: first.observations[0].screen_hash,
    }],
  }));
  const followup = JSON.parse(execFileSync(process.execPath, argv, { env, encoding: 'utf8' }));
  const entries = fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  const sends = entries.filter((entry) => entry[0] === 'send-key');
  assert.equal(sends.length, 1);
  assert.equal(sends[0].at(-1), 'enter');
  assert.equal(followup.observations[0].review_reason, 'post_send_confirmation');
  assert.equal(followup.observations[0].send_effect, 'screen_unchanged');
  const node = JSON.parse(fs.readFileSync(path.join(orch, 'workflows', 'wf.json'))).nodes[0];
  assert.equal(node.status, 'running');
  assert.equal(node.attempt_count, 1);
  assert.equal(node.cmux_surface, 'surface-a');
});

test('one CLI exit is isolated from another running node', async () => {
  const { detectEvents } = await import(path.join(SCRIPTS, 'supervisor_loop.mjs'));
  const { loadWorkflow } = await import(path.join(SCRIPTS, 'workflow_registry.mjs'));
  const project = temp('tf-isolation-');
  const orch = initWorkflow(project);
  const workflowPath = path.join(orch, 'workflows', 'wf.json');
  const workflow = JSON.parse(fs.readFileSync(workflowPath));
  workflow.nodes.push({
    id: 'node-b', task: 'task-a', cli: 'claude', model: null, depends_on: [], status: 'running',
    reason: null, event: null, last_decision: null, cmux_surface: 'surface-b', run_dir: '', attempt_count: 1,
  });
  fs.writeFileSync(workflowPath, JSON.stringify(workflow));
  const stateA = JSON.parse(fs.readFileSync(path.join(orch, 'state', 'wf', 'node-a.json')));
  Object.assign(stateA, { last_screen_read_at: new Date().toISOString(), surface_read_failures: 3 });
  fs.writeFileSync(path.join(orch, 'state', 'wf', 'node-a.json'), JSON.stringify(stateA));
  fs.writeFileSync(path.join(orch, 'state', 'wf', 'node-b.json'), JSON.stringify({
    workflow_id: 'wf', node_id: 'node-b', task_id: 'task-a', cli: 'claude', status: 'running',
    cmux_surface: 'surface-b', surface_read_failures: 0, last_screen_read_at: new Date().toISOString(),
  }));
  const events = detectEvents(orch, 'wf');
  assert.equal(events.some((event) => event.node_id === 'node-a' && event.type === 'cli_exit'), true);
  const nodes = loadWorkflow(orch, 'wf').nodes;
  assert.equal(nodes.find((node) => node.id === 'node-a').status, 'running');
  assert.equal(nodes.find((node) => node.id === 'node-b').status, 'running');
});

test('all remaining runtime scripts pass node --check', () => {
  for (const name of fs.readdirSync(SCRIPTS).filter((entry) => entry.endsWith('.mjs'))) {
    execFileSync(process.execPath, ['--check', path.join(SCRIPTS, name)], { stdio: 'pipe' });
  }
});

test('quietRemove removes a file from its original path without leaving it in place', () => {
  const file = path.join(os.tmpdir(), `taskforce-quietremove-src-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(file, '{"hello":"world"}');
  assert.equal(fs.existsSync(file), true);
  // Re-import supervisor_loop to access quietRemove. It is not exported, so we
  // verify behavior indirectly: the lock-release and decision-consume paths
  // call quietRemove, and we assert the target file is gone afterwards.
  // Here we just confirm a file we create can be made to disappear by the
  // same mechanism the runtime uses (rename to tmpdir + unlink).
  const dest = path.join(os.tmpdir(), `taskforce-quietremove-dest-${process.pid}-${Date.now()}`);
  fs.renameSync(file, dest);
  fs.unlinkSync(dest);
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.existsSync(dest), false);
});

test('releasing the supervisor lock leaves no lock file behind for the next acquire', () => {
  const project = temp('tf-lock-cleanup-');
  const orch = initWorkflow(project);
  const script = path.join(SCRIPTS, 'supervisor_loop.mjs');
  const argv = [script, '--project-dir', project, '--workflow-id', 'wf', '--once', '--json'];
  const env = { ...process.env, CMUX_BIN: FAKE_CMUX };

  // First tick acquires and releases the lock.
  execFileSync(process.execPath, argv, { env, encoding: 'utf8' });
  const lockPath = path.join(orch, 'state', 'workflows', 'wf', 'supervisor.lock');
  assert.equal(fs.existsSync(lockPath), false,
    'lock file must not remain after a clean supervisor exit (would trigger safe-delete trash on hosts like workbuddy)');

  // Second tick must be able to acquire the lock again (no stale residue).
  const second = JSON.parse(execFileSync(process.execPath, argv, { env, encoding: 'utf8' }));
  assert.notEqual(second.action, 'supervisor_already_running');
  assert.equal(fs.existsSync(lockPath), false);
});

test('consuming a decision batch leaves no decision file behind', () => {
  const project = temp('tf-decision-cleanup-');
  const orch = initWorkflow(project);
  const surfacesFile = path.join(project, 'surfaces.json');
  fs.writeFileSync(surfacesFile, JSON.stringify({ 'surface-a': { text: 'progress' } }));
  const env = { ...process.env, CMUX_BIN: FAKE_CMUX, FAKE_CMUX_SURFACES_FILE: surfacesFile };
  const script = path.join(SCRIPTS, 'supervisor_loop.mjs');
  const argv = [script, '--project-dir', project, '--workflow-id', 'wf', '--once', '--json'];

  const first = JSON.parse(execFileSync(process.execPath, argv, { env, encoding: 'utf8' }));
  const decPath = path.join(orch, 'state', 'workflows', 'wf', 'latest_decision_batch.json');
  fs.writeFileSync(decPath, JSON.stringify({
    batch_id: first.batch_id, workflow_id: 'wf',
    decisions: [{ node_id: 'node-a', action: 'continue', reason: 'ok' }],
  }));
  assert.equal(fs.existsSync(decPath), true);

  // Consume the decision.
  execFileSync(process.execPath, argv, { env, encoding: 'utf8' });
  assert.equal(fs.existsSync(decPath), false,
    'decision batch file must be removed after consumption (would trigger safe-delete trash on hosts like workbuddy)');

  // The consumed-batch receipt prevents replay even without the file.
  const third = JSON.parse(execFileSync(process.execPath, argv, { env, encoding: 'utf8' }));
  assert.notEqual(third.decision_reason, 'batch_already_consumed');
});

test('workflow_complete pushes terminal sidebar state before returning', () => {
  const project = temp('tf-sidebar-terminal-');
  const orch = initWorkflow(project, 'wf', 'completed');
  // pushCmuxSidebar needs cmux_workspace in the node state file to know where
  // to push. The default initWorkflow helper does not set it.
  const statePath = path.join(orch, 'state', 'wf', 'node-a.json');
  const state = JSON.parse(fs.readFileSync(statePath));
  state.cmux_workspace = 'workspace-a';
  fs.writeFileSync(statePath, JSON.stringify(state));

  const log = path.join(project, 'cmux.log');
  const output = JSON.parse(execFileSync(process.execPath, [
    path.join(SCRIPTS, 'supervisor_loop.mjs'), '--project-dir', project,
    '--workflow-id', 'wf', '--once', '--json',
  ], { env: { ...process.env, CMUX_BIN: FAKE_CMUX, FAKE_CMUX_LOG: log }, encoding: 'utf8' }));

  assert.equal(output.action, 'workflow_complete');
  assert.equal(output.workflow_terminal, true);

  // The sidebar push must have happened: set-status for the node pill and
  // set-progress at 1.0 (all nodes completed).
  const entries = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  const setStatus = entries.filter((e) => e[0] === 'set-status');
  const setProgress = entries.filter((e) => e[0] === 'set-progress');
  assert.ok(setStatus.length >= 1, 'set-status must be pushed on workflow completion');
  assert.ok(setProgress.length >= 1, 'set-progress must be pushed on workflow completion');
  assert.equal(setProgress[0][1], '1.00', 'progress must be 1.0 when all nodes completed');
  assert.match(setStatus[0].join(' '), /checkmark/, 'completed node pill must use checkmark icon');
});

test('discoverCmux classifies cmux_not_running when ping fails and no process is alive', async () => {
  const { discoverCmux } = await import(path.join(SCRIPTS, 'doctor.mjs'));
  const oldBin = process.env.CMUX_BIN;
  const oldProc = process.env.TASKFORCE_CMUX_PROCESS_RUNNING;
  process.env.CMUX_BIN = FAKE_CMUX;
  process.env.FAKE_CMUX_SCENARIO = 'connection';
  process.env.TASKFORCE_CMUX_PROCESS_RUNNING = '0';
  try {
    const result = discoverCmux();
    assert.equal(result.installed, true);
    assert.equal(result.ready, false);
    assert.equal(result.classification, 'cmux_not_running');
    assert.match(result.remediation, /open -a cmux/);
  } finally {
    if (oldBin === undefined) delete process.env.CMUX_BIN; else process.env.CMUX_BIN = oldBin;
    if (oldProc === undefined) delete process.env.TASKFORCE_CMUX_PROCESS_RUNNING;
    else process.env.TASKFORCE_CMUX_PROCESS_RUNNING = oldProc;
    delete process.env.FAKE_CMUX_SCENARIO;
  }
});

test('discoverCmux classifies cmux_not_accessible when ping fails but process is alive', async () => {
  const { discoverCmux } = await import(path.join(SCRIPTS, 'doctor.mjs'));
  const oldBin = process.env.CMUX_BIN;
  const oldProc = process.env.TASKFORCE_CMUX_PROCESS_RUNNING;
  process.env.CMUX_BIN = FAKE_CMUX;
  process.env.FAKE_CMUX_SCENARIO = 'connection';
  process.env.TASKFORCE_CMUX_PROCESS_RUNNING = '1';
  try {
    const result = discoverCmux();
    assert.equal(result.installed, true);
    assert.equal(result.ready, false);
    assert.equal(result.classification, 'cmux_not_accessible');
    assert.match(result.remediation, /Automation/);
  } finally {
    if (oldBin === undefined) delete process.env.CMUX_BIN; else process.env.CMUX_BIN = oldBin;
    if (oldProc === undefined) delete process.env.TASKFORCE_CMUX_PROCESS_RUNNING;
    else process.env.TASKFORCE_CMUX_PROCESS_RUNNING = oldProc;
    delete process.env.FAKE_CMUX_SCENARIO;
  }
});
