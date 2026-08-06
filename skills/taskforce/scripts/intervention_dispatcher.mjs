#!/usr/bin/env node
// Execute Chief `send` actions against the exact screen Chief reviewed.

import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { appendJsonl, nowIso } from './protocol_lib.mjs';
import { resolveCmuxPath } from './doctor.mjs';
import { hashScreen, readCmuxScreen } from './surface_collector.mjs';
import { CMUX_KEYS } from './decision_batch.mjs';

function runCmux(cmux, args, failureStatus) {
  const result = spawnSync(cmux, args, { encoding: 'utf8', timeout: 8000 });
  return result.status === 0
    ? { ok: true }
    : {
        ok: false,
        status: failureStatus,
        diagnostic: (result.stderr || result.stdout || result.error?.message || '').trim(),
      };
}

function sendCmuxInput(surface, { input, key, submit }) {
  const cmux = resolveCmuxPath();
  if (!cmux || !surface) return { ok: false, status: 'missing_path_or_surface' };
  if (key) {
    const sent = runCmux(cmux, ['send-key', '--surface', surface, '--', key], 'send_key_failed');
    return sent.ok
      ? { ok: true, status: 'input_delivered', surface, transport: 'send-key', key }
      : { ...sent, surface, transport: 'send-key', key };
  }

  const sent = runCmux(cmux, ['send', '--surface', surface, '--', input], 'send_failed');
  if (!sent.ok) return { ...sent, surface, transport: 'send' };
  if (submit) {
    const entered = runCmux(cmux, ['send-key', '--surface', surface, '--', 'enter'], 'submit_failed');
    if (!entered.ok) {
      return { ...entered, surface, transport: 'send+send-key', text_delivered: true };
    }
  }
  // This confirms only that cmux accepted the input. Whether the worker TUI
  // acted on it is established by the next screen observation.
  return { ok: true, status: 'input_delivered', surface,
    transport: submit ? 'send+send-key' : 'send', submitted: Boolean(submit) };
}

export function dispatchSend({ workflow_id = '', node_id = '', input, key, submit = true,
  expected_screen_hash = '', cmux_surface = '', run_dir = '', orch = '' }) {
  if (!cmux_surface) return { ok: false, status: 'missing_surface', node_id, action: 'send' };
  const hasInput = typeof input === 'string' && input.length > 0;
  const hasKey = typeof key === 'string' && key.length > 0;
  if (hasInput === hasKey) {
    return { ok: false, status: 'invalid_send_payload', node_id, action: 'send' };
  }
  const normalizedKey = hasKey ? key.trim().toLowerCase() : undefined;
  if (normalizedKey && !CMUX_KEYS.has(normalizedKey)) {
    return { ok: false, status: 'unsupported_key', node_id, action: 'send', key: normalizedKey };
  }

  // Re-read immediately before input/key. This keeps a late Chief response from
  // selecting an option on a different menu or sending a correction to a new
  // turn that appeared after the observation.
  const current = readCmuxScreen(cmux_surface);
  if (!current.ok) return { ok: false, status: 'screen_unreadable', node_id, action: 'send' };
  const actualHash = hashScreen(current.text);
  if (!expected_screen_hash || actualHash !== expected_screen_hash) {
    return {
      ok: false, status: 'stale_screen', node_id, action: 'send',
      expected_screen_hash, actual_screen_hash: actualHash,
    };
  }

  const sentAt = nowIso();
  const actionId = sentAt.replace(/[-:.+]/g, '');
  const sendResult = sendCmuxInput(cmux_surface, { input, key: normalizedKey, submit });
  const intervention = {
    schema: 'taskforce.intervention.v1', intervention_id: actionId,
    workflow_id, node_id, action: 'send',
    ...(hasInput ? { input, submit } : { key: normalizedKey }),
    expected_screen_hash, surface: cmux_surface, send_result: sendResult,
    intervened_at: sentAt,
  };
  if (run_dir) {
    try { appendJsonl(path.join(run_dir, 'interventions.jsonl'), intervention); } catch (_) { /* best effort */ }
  }
  if (orch) {
    try {
      appendJsonl(path.join(orch, 'state', 'workflows', workflow_id, 'interventions.jsonl'), intervention);
    } catch (_) { /* best effort */ }
  }
  return { ok: sendResult.ok, status: sendResult.status, node_id, action: 'send',
    intervention_id: actionId, send_result: sendResult };
}

export function dispatchBatch(decisions, nodeSurfaceMap, orch) {
  return decisions.map((decision) => {
    const surface = nodeSurfaceMap[decision.node_id] || {};
    return dispatchSend({
      workflow_id: surface.workflow_id || '', node_id: decision.node_id,
      input: decision.input, key: decision.key, submit: decision.submit,
      expected_screen_hash: decision.expected_screen_hash,
      cmux_surface: surface.cmux_surface || '', run_dir: surface.run_dir || '', orch,
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.stdout.write('Use supervisor_loop.mjs for the runtime pipeline.\n');
}
