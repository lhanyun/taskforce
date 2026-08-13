#!/usr/bin/env node
// Shared helpers for the Taskforce protocol (Node runtime).
// v0.2: no roles, no fixed states, no role-based paths.
// Byte-shape parity: JSON.stringify(obj, null, 2) + "\n", UTF-8, non-ASCII
// preserved, trailing newline. JSONL: JSON.stringify(obj) + "\n" per line.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

// v0.2 node lifecycle states.
// Four factual lifecycle states. Waiting menus, questions, failures, and
// launch progress are observation/event metadata, not extra states.
export const NODE_STATUSES = new Set([
  'pending', 'running', 'completed', 'cancelled',
]);

// Match Python datetime.now(timezone.utc).isoformat():
// "YYYY-MM-DDTHH:MM:SS.ffffff+00:00" (6 fractional digits, +00:00 offset).
// Node Date has millisecond precision; microseconds are zero-padded to 6 digits.
export function nowIso() {
  const d = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const us = pad(d.getUTCMilliseconds(), 3) + '000';
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}` +
    `.${us}+00:00`
  );
}

export function atomicWriteJson(filePath, payload) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}

export function appendJsonl(filePath, payload) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(filePath, JSON.stringify(payload) + '\n', 'utf8');
}

export function readJson(filePath) {
  if (!fs.existsSync(filePath)) return {};
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (exc) {
    return { _invalid_json: true, error: String(exc && exc.message ? exc.message : exc), path: String(filePath) };
  }
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) return payload;
  return { _invalid_json: true, path: String(filePath) };
}

// v0.2: node state file path — state/<workflowId>/<nodeId>.json
export function nodeStatePath(orch, workflowId, nodeId) {
  return path.join(orch, 'state', workflowId, `${nodeId}.json`);
}

// v0.2: node run directory — runs/<workflowId>/<nodeId>/<attemptId>/
export function nodeRunDir(orch, workflowId, nodeId, attemptId) {
  return path.join(orch, 'runs', workflowId, nodeId, attemptId);
}

// v0.2: write node state file.
// Uses read-modify-write to preserve existing fields (cmux_surface, run_dir, etc.)
// when only a subset of fields are updated.
export function writeNodeState(orch, workflowId, nodeId, payload) {
  const statePath = nodeStatePath(orch, workflowId, nodeId);
  let existing = {};
  if (fs.existsSync(statePath)) {
    try {
      existing = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      if (!existing || typeof existing !== 'object' || Array.isArray(existing)) existing = {};
    } catch (_) { existing = {}; }
  }
  const merged = { ...existing, ...payload, updated_at: nowIso() };
  atomicWriteJson(statePath, merged);
  return merged;
}

// A worker model is opt-in. Only an explicit, non-empty identifier reaches a
// CLI as a --model flag; every other value means "let the CLI use its own
// default model". Without this, an empty string or a placeholder like
// "default" would be forwarded verbatim and force the CLI into a model
// picker or an unknown-model error.
const DEFAULT_MODEL_ALIASES = new Set(['', 'null', 'none', 'default', 'auto', 'undefined']);

export function normalizeModel(value) {
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  const text = String(value).trim();
  if (DEFAULT_MODEL_ALIASES.has(text.toLowerCase())) return null;
  return text;
}

// The worker's OS process is the ground truth for "this attempt is still live".
// agent.pid is written by tui_exec.sh, which then execs the CLI into the same
// process, so the pid stays valid for the CLI's whole lifetime.
export function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (exc) {
    return exc?.code === 'EPERM';
  }
}

export function readAttemptPid(runDir) {
  if (!runDir) return null;
  try {
    const value = Number(fs.readFileSync(path.join(runDir, 'agent.pid'), 'utf8').trim());
    return Number.isInteger(value) && value > 1 ? value : null;
  } catch (_) {
    return null;
  }
}

// Attempt directories are the durable record of every launch. Scanning them is
// the only way to find a live worker whose workflow entry was rewritten or
// whose node state file was already overwritten by a later attempt. Attempt ids
// are UTC timestamps, so reverse lexicographic order is newest first.
export function findLiveAttempt(orch, workflowId, nodeId) {
  const nodeRuns = path.join(orch, 'runs', workflowId, nodeId);
  let attemptIds = [];
  try {
    attemptIds = fs.readdirSync(nodeRuns, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse();
  } catch (_) {
    return null;
  }
  for (const attemptId of attemptIds) {
    const runDir = path.join(nodeRuns, attemptId);
    const agentPid = readAttemptPid(runDir);
    if (!processIsAlive(agentPid)) continue;
    const launch = readJson(path.join(runDir, 'launch.json'));
    return {
      attempt_id: attemptId,
      run_dir: runDir,
      agent_pid: agentPid,
      cmux_surface: String(launch.cmux_surface || ''),
      cmux_workspace: String(launch.cmux_workspace || ''),
      attempt_number: Number(launch.attempt_number || 0) || null,
      started_at: launch.started_at || null,
    };
  }
  return null;
}

export function slug(value) {
  if (typeof value !== 'string') value = String(value);
  return value.trim().replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '');
}

// Minimal argument parser shared by CLI entry points.
export function parseArgs(argv, spec = {}) {
  const flags = new Set(spec.flags || []);
  const valued = new Set(spec.valued || []);
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      let name;
      let val;
      let hasVal = false;
      const eq = a.indexOf('=');
      if (eq > 1) {
        name = a.slice(2, eq);
        val = a.slice(eq + 1);
        hasVal = true;
      } else {
        name = a.slice(2);
      }
      if (flags.has(name)) {
        out[name] = true;
      } else if (valued.has(name)) {
        out[name] = hasVal ? val : argv[++i];
      } else {
        out[name] = hasVal ? val : argv[++i];
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}
