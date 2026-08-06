#!/usr/bin/env node
// Parse one Chief action for every observed node. Runtime actions deliberately
// describe only what to do; Chief owns all semantic classification.

const VALID_ACTIONS = new Set(['continue', 'send', 'relaunch', 'complete']);
export const CMUX_KEYS = new Set([
  'enter', 'tab', 'escape', 'backspace', 'delete', 'up', 'down', 'left', 'right',
]);

export function parseDecisionBatch(batch, expectedNodeIds = null) {
  const errors = [];
  const decisions = [];
  if (!batch || !Array.isArray(batch.decisions)) {
    return { decisions, errors: ['missing or invalid decisions array'], batch_id: null, workflow_id: null };
  }
  const batchId = batch.batch_id || null;
  const workflowId = batch.workflow_id || null;
  if (!batchId) errors.push('missing batch_id');
  if (!workflowId) errors.push('missing workflow_id');

  const targets = new Set();
  const expected = Array.isArray(expectedNodeIds) ? new Set(expectedNodeIds.map(String)) : null;
  for (const source of batch.decisions) {
    const nodeId = String(source.node_id || '').trim();
    if (!nodeId) {
      errors.push({ node_id: '', error: 'missing node_id' });
      continue;
    }
    if (targets.has(nodeId)) {
      errors.push({ node_id: nodeId, error: 'multiple actions for the same node' });
      continue;
    }
    targets.add(nodeId);
    if (expected && !expected.has(nodeId)) {
      errors.push({ node_id: nodeId, error: 'node was not present in the observed batch' });
      continue;
    }
    const action = String(source.action || '').trim();
    if (!VALID_ACTIONS.has(action)) {
      errors.push({ node_id: nodeId, error: `invalid action: ${action}` });
      continue;
    }
    if (action === 'send') {
      const hasInput = typeof source.input === 'string' && source.input.length > 0;
      const key = typeof source.key === 'string' ? source.key.trim().toLowerCase() : '';
      const hasKey = key.length > 0;
      if (hasInput === hasKey) {
        errors.push({ node_id: nodeId, error: 'send requires exactly one of non-empty input or key' });
        continue;
      }
      if (hasKey && !CMUX_KEYS.has(key)) {
        errors.push({ node_id: nodeId, error: `unsupported cmux key: ${key}` });
        continue;
      }
      if (!String(source.expected_screen_hash || '').trim()) {
        errors.push({ node_id: nodeId, error: 'send requires expected_screen_hash' });
        continue;
      }
    }
    decisions.push({
      node_id: nodeId,
      action,
      reason: String(source.reason || '').trim(),
      ...(action === 'send' ? {
        ...(typeof source.input === 'string' && source.input.length > 0
          ? { input: source.input, submit: source.submit !== false }
          : { key: String(source.key).trim().toLowerCase() }),
        expected_screen_hash: String(source.expected_screen_hash).trim(),
      } : {}),
      ...(action === 'relaunch' ? {
        ...(source.cli ? { cli: String(source.cli).trim() } : {}),
        ...(source.model !== undefined ? { model: source.model } : {}),
        instruction: String(source.instruction || '').trim(),
      } : {}),
    });
  }
  if (expected) {
    for (const nodeId of expected) {
      if (!targets.has(nodeId)) errors.push({ node_id: nodeId, error: 'missing action for observed node' });
    }
  }
  return { decisions, errors, batch_id: batchId, workflow_id: workflowId };
}

export function classifyDecisions(parsed) {
  const sends = [];
  const relaunches = [];
  const continuations = [];
  const completions = [];
  for (const decision of parsed.decisions) {
    if (decision.action === 'send') sends.push(decision);
    else if (decision.action === 'relaunch') relaunches.push(decision);
    else if (decision.action === 'complete') completions.push(decision);
    else continuations.push(decision);
  }
  return { sends, relaunches, continuations, completions };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.stdout.write('Use supervisor_loop.mjs for the runtime pipeline.\n');
}
