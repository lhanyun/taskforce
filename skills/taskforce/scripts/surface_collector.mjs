#!/usr/bin/env node
// Surface Collector: reads all active cmux surfaces, computes deltas and hashes.
// No model calls. Pure data collection for the supervisor loop.
// Only running nodes are observable. Menus, questions, and failures remain
// running so Chief can continue reading and responding on the same surface.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { atomicWriteJson, readJson, nowIso, parseArgs } from './protocol_lib.mjs';
import { resolveCmuxPath } from './doctor.mjs';

const SCREEN_READ_LINES = 80;
const SCREEN_READ_TIMEOUT_SECONDS = 5;

// A readable worker surface belongs to a running node. Waiting menus and
// questions stay running so Chief can answer them in-place.
const RUNNING_STATES = new Set(['running']);

export function hashScreen(text) {
  return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

export function computeDelta(previousScreen, currentScreen) {
  const currentLines = String(currentScreen || '').split(/\r?\n/);

  const currentHash = hashScreen(currentScreen);
  const previousHash = hashScreen(previousScreen);
  const changed = currentHash !== previousHash;

  let sinceLast;
  if (changed) {
    sinceLast = String(currentScreen || '');
  } else {
    sinceLast = '';
  }

  return {
    since_last: sinceLast,
    current_screen: String(currentScreen || ''),
    screen_hash: currentHash,
    line_count: currentLines.length,
    changed,
  };
}

export function collectSurfaces(orch, taskIdFilter = null, workflowId = null) {
  const stateDir = path.join(orch, 'state');
  if (!fs.existsSync(stateDir)) return [];
  // Build a set of allowed task IDs if a filter is provided.
  // An empty array means "collect nothing" (explicit empty scope).
  // null means "collect everything" (no filter).
  if (taskIdFilter !== null && taskIdFilter.length === 0) return [];
  const filterSet = taskIdFilter ? new Set(taskIdFilter) : null;
  const surfaces = [];

  // v0.2: state files are under state/<workflowId>/<nodeId>.json
  // If workflowId is specified, only scan that workflow's directory.
  // This prevents cross-workflow task_id collision.
  const workflowDirs = [];
  if (workflowId) {
    const specificDir = path.join(stateDir, workflowId);
    if (fs.existsSync(specificDir) && fs.statSync(specificDir).isDirectory()) {
      workflowDirs.push({ name: workflowId, path: specificDir });
    }
  } else {
    // Scan all workflow directories (legacy behavior, but should be avoided).
    for (const entry of fs.readdirSync(stateDir)) {
      const entryPath = path.join(stateDir, entry);
      if (fs.statSync(entryPath).isDirectory()) {
        workflowDirs.push({ name: entry, path: entryPath });
      }
    }
  }

  for (const { name: wfId, path: wfPath } of workflowDirs) {
    for (const name of fs.readdirSync(wfPath).filter((f) => f.endsWith('.json')).sort()) {
      const payload = readJson(path.join(wfPath, name));
      if (!payload || !payload.task_id) continue;
      if (['launching', 'blocked', 'failed'].includes(String(payload.status || ''))) {
        payload.status = 'running';
        atomicWriteJson(path.join(wfPath, name), payload);
      }
      if (!RUNNING_STATES.has(String(payload.status || ''))) continue;
      if (!payload.cmux_surface) continue;
      if (filterSet && !filterSet.has(payload.task_id)) continue;
      surfaces.push({
        task_id: payload.task_id,
        node_id: payload.node_id || '',
        workflow_id: wfId,
        cli: payload.cli || '',
        cmux_surface: payload.cmux_surface,
        run_dir: payload.run_dir || '',
        status: payload.status,
      });
    }
  }
  return surfaces;
}

export function readCmuxScreen(surface) {
  const cmuxPath = resolveCmuxPath();
  if (!cmuxPath || !surface) return { ok: false, text: '', error: 'cmux_or_surface_missing' };
  const attempts = [
    [cmuxPath, 'read-screen', '--surface', surface, '--scrollback', '--lines', String(SCREEN_READ_LINES)],
    [cmuxPath, 'capture-pane', '--surface', surface, '--scrollback', '--lines', String(SCREEN_READ_LINES)],
  ];
  for (const command of attempts) {
    try {
      const completed = spawnSync(command[0], command.slice(1), {
        encoding: 'utf8',
        timeout: SCREEN_READ_TIMEOUT_SECONDS * 1000,
      });
      if (completed.status === 0 && (completed.stdout || '').trim()) {
        return { ok: true, text: completed.stdout, command };
      }
    } catch (e) {
      // Try the fallback command below.
    }
  }
  return { ok: false, text: '', error: 'screen_read_unavailable' };
}

// Collect every running surface and return observation data.
// v0.2: updates last_seen_active in state files when a surface is read successfully.
// Tracks failed reads to support CLI exit detection.
export function collectAllSurfaces(orch, taskIdFilter = null, workflowId = null) {
  const surfaces = collectSurfaces(orch, taskIdFilter, workflowId);
  const results = [];
  for (const info of surfaces) {
    const statePath = path.join(orch, 'state', info.workflow_id || workflowId || '', `${info.node_id || info.task_id}.json`);
    const screen = readCmuxScreen(info.cmux_surface);
    if (!screen.ok) {
      // Persist consecutive read failures. The supervisor uses a threshold
      // rather than treating one transient cmux error as a CLI exit.
      if (fs.existsSync(statePath)) {
        try {
          const stateData = readJson(statePath);
          if (stateData && typeof stateData === 'object') {
            stateData.surface_read_failures = Number(stateData.surface_read_failures || 0) + 1;
            stateData.last_screen_read_error_at = nowIso();
            atomicWriteJson(statePath, stateData);
          }
        } catch (_) { /* ignore write errors */ }
      }
      results.push({ ...info, delta: null, changed: false, error: screen.error });
      continue;
    }

    // Short-lived Chief ticks compare against the last persisted raw screen
    // hash. No separate snapshot or in-memory cursor is needed.
    const persistedState = fs.existsSync(statePath) ? readJson(statePath) : {};
    const previousHash = persistedState.last_screen_hash || '';
    const delta = computeDelta('', screen.text);
    const changed = delta.screen_hash !== previousHash;
    delta.changed = changed;
    delta.since_last = changed ? screen.text : '';

    // Read health and output activity are different signals: a frozen pane can
    // remain readable. Only a content change advances last_screen_change_at.
    if (fs.existsSync(statePath)) {
      try {
        const stateData = readJson(statePath);
        if (stateData && typeof stateData === 'object') {
          const observedAt = nowIso();
          stateData.last_screen_read_at = observedAt;
          stateData.last_screen_hash = delta.screen_hash;
          stateData.surface_read_failures = 0;
          if (changed) {
            stateData.last_screen_change_at = observedAt;
            // Backward-compatible alias. It now means observed output activity,
            // not merely a successful pane read.
            stateData.last_seen_active = observedAt;
          }
          atomicWriteJson(statePath, stateData);
        }
      } catch (_) { /* ignore write errors */ }
    }
    results.push({ ...info, delta, changed });
  }
  return results;
}

function main() {
  const args = parseArgs(process.argv.slice(2), {
    flags: [],
    valued: ['project-dir', 'orchestrator-dir'],
  });
  const project = path.resolve(String(args['project-dir'] || '').replace(/^~(?=$|\/|\\)/, process.env.HOME || ''));
  const orchRel = args['orchestrator-dir'] || '.taskforce';
  const orch = path.join(project, orchRel);
  const results = collectAllSurfaces(orch);
  process.stdout.write(JSON.stringify({ collected_at: nowIso(), surfaces: results }, null, 2) + '\n');
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
