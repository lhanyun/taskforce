#!/usr/bin/env node
// Lightweight, read-only availability check for agent CLIs and cmux.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { parseArgs } from './protocol_lib.mjs';

export const SUPPORTED_CLIS = ['opencode', 'codex', 'claude', 'codebuddy'];

export const AUTOMATION_HELP =
  'Open cmux → Settings → Automation and change Socket control mode from ' +
  'cmux processes only to Automation. Do not enable full open access.';

export const CMUX_NOT_RUNNING_HELP =
  'cmux is installed but not running. Start it with `open -a cmux`, wait a ' +
  'few seconds for the socket to come up, then re-run Taskforce setup.';

// Process-name patterns used to detect a running cmux app when `cmux ping`
// fails. The binary path lives inside the .app bundle, so matching the app
// name covers both /Applications and ~/Applications installs.
export const CMUX_PROCESS_PATTERNS = [
  /\/cmux\.app\//i,
  /\bcmux\b/i,
];

function isCmuxProcessRunning() {
  // Test override: when set, skips the real pgrep so tests can simulate
  // "app not running" deterministically regardless of the host's actual state.
  if (process.env.TASKFORCE_CMUX_PROCESS_RUNNING === '0') return false;
  if (process.env.TASKFORCE_CMUX_PROCESS_RUNNING === '1') return true;
  // pgrep is available on macOS and most Linux distros. Fall back to false
  // (treat as "unknown / not running") when unavailable — setup will then
  // surface the Automation-settings remediation as before.
  const r = spawnSync('pgrep', ['-fl', 'cmux'], { encoding: 'utf8', timeout: 4000 });
  if (r.error || r.status === null) return false;
  if (r.status !== 0) return false; // pgrep exits 1 when no match
  const lines = String(r.stdout || '').split(/\r?\n/).filter(Boolean);
  return lines.some((line) => CMUX_PROCESS_PATTERNS.some((re) => re.test(line)));
}

// Error strings that indicate a sandbox (e.g. macOS App Sandbox, Seatbelt) is
// blocking the Unix socket connection to cmux — NOT a cmux settings problem.
// When these appear, the user should re-run outside the sandbox rather than
// changing cmux Automation settings that may already be correct.
export const SANDBOX_ERROR_PATTERNS = [
  /operation not permitted/i,
  /permission denied/i,
  /not permitted/i,
];

export const SANDBOX_HINT =
  'This may be a sandbox restriction on Unix socket access, not a cmux ' +
  'settings issue. Try running the Taskforce scripts outside the sandbox ' +
  '(e.g. disable App Sandbox / Seatbelt for the host process). If cmux ' +
  'Automation is already enabled, the socket is being blocked by the ' +
  'sandbox, not by cmux.';

export const CMUX_APP_PATHS = [
  '/Applications/cmux.app/Contents/Resources/bin/cmux',
  path.join(os.homedir(), 'Applications/cmux.app/Contents/Resources/bin/cmux'),
];

function expandUser(p) {
  if (typeof p !== 'string') return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function isExecutable(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch (e) {
    return false;
  }
}

// Resolve an executable by name across PATH (respecting PATHEXT on Windows),
// or treat an absolute/relative path as-is when it contains a separator.
export function which(name) {
  if (!name) return '';
  if (name.includes(path.sep) || (process.platform === 'win32' && name.includes('/')) || name.includes(path.posix.sep)) {
    try {
      if (fs.statSync(name).isFile()) return path.resolve(name);
    } catch (e) {
      return '';
    }
    return '';
  }
  const pathEnv = process.env.PATH || '';
  const sep = process.platform === 'win32' ? ';' : ':';
  const exts =
    process.platform === 'win32'
      ? (process.env.PATHEXT || '.EXE;.BAT;.CMD').split(';')
      : [''];
  for (const dir of pathEnv.split(sep)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try {
        if (fs.statSync(candidate).isFile() && isExecutable(candidate)) {
          return path.resolve(candidate);
        }
      } catch (e) {
        // continue
      }
    }
  }
  return '';
}

// Side-effect-free PATH scan. Taskforce does not enumerate models or execute
// CLI version commands during setup or normal orchestration.
export function listAvailableClis() {
  const available = [];
  for (const name of SUPPORTED_CLIS) {
    const executablePath = which(name);
    if (executablePath && isExecutable(executablePath)) {
      available.push({ name, path: executablePath });
    }
  }
  return available;
}

function runSubprocess(command, timeout = 8) {
  try {
    const r = spawnSync(command[0], command.slice(1), {
      encoding: 'utf8',
      timeout: timeout * 1000,
    });
    if (r.error) {
      return { ok: false, stdout: r.stdout || '', stderr: r.stderr || '', error: String(r.error.message || r.error) };
    }
    return { ok: r.status === 0, returncode: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
  } catch (exc) {
    return { ok: false, stdout: '', stderr: '', error: String(exc) };
  }
}

function diagnostic(result) {
  return [result.stdout || '', result.stderr || '', result.error || ''].join('\n').trim();
}

export function resolveCmuxPath() {
  const candidates = [];
  if (process.env.CMUX_BIN) candidates.push(expandUser(process.env.CMUX_BIN));
  const pathEntry = which('cmux');
  if (pathEntry) candidates.push(pathEntry);
  candidates.push(...CMUX_APP_PATHS);
  for (const candidate of candidates) {
    let resolved;
    try {
      resolved = fs.realpathSync(candidate);
    } catch (e) {
      continue;
    }
    try {
      if (fs.statSync(resolved).isFile() && isExecutable(resolved)) {
        return resolved;
      }
    } catch (e) {
      // continue
    }
  }
  return '';
}

export function discoverCmux() {
  const found = resolveCmuxPath();
  if (!found) {
    return { installed: false, ready: false, classification: 'cmux_not_installed' };
  }
  const version = runSubprocess([found, '-v']);
  if (!version.ok) {
    return {
      installed: true,
      path: found,
      ready: false,
      classification: 'cmux_not_installed',
      diagnostic: diagnostic(version),
    };
  }
  const ping = runSubprocess([found, 'ping']);
  if (!ping.ok) {
    const pingDiagnostic = diagnostic(ping);
    // Detect sandbox-induced socket failures. These look like "Operation not
    // permitted" / "Permission denied" and mean the host process can't reach
    // cmux's Unix socket — not that cmux Automation is misconfigured.
    const sandboxSuspected = SANDBOX_ERROR_PATTERNS.some((re) => re.test(pingDiagnostic));
    // Distinguish "cmux app not running" from "running but socket misconfigured".
    // ping fails in both cases; only the latter needs the Automation-settings
    // remediation. When the app process is absent, the right fix is to launch it.
    if (!sandboxSuspected && !isCmuxProcessRunning()) {
      return {
        installed: true,
        path: found,
        ready: false,
        classification: 'cmux_not_running',
        diagnostic: pingDiagnostic,
        remediation: CMUX_NOT_RUNNING_HELP,
      };
    }
    return {
      installed: true,
      path: found,
      ready: false,
      classification: 'cmux_not_accessible',
      diagnostic: sandboxSuspected
        ? `${pingDiagnostic}\n\n${SANDBOX_HINT}`
        : pingDiagnostic,
      sandbox_suspected: sandboxSuspected,
      remediation: sandboxSuspected
        ? `${AUTOMATION_HELP}\n\n${SANDBOX_HINT}`
        : AUTOMATION_HELP,
    };
  }
  return {
    installed: true,
    path: found,
    ready: true,
    classification: 'cmux_ready',
    version: (version.stdout || version.stderr || '').trim(),
  };
}

export function discover() {
  return {
    schema: 'taskforce.availability.v1',
    clis: listAvailableClis(),
    cmux: discoverCmux(),
  };
}

export function renderHuman(payload) {
  const lines = ['Taskforce availability', '', 'Agent CLIs:'];
  for (const cli of payload.clis) lines.push(`- ${cli.name}: ${cli.path}`);
  if (payload.clis.length === 0) lines.push('- none');
  lines.push('', `cmux: ${payload.cmux.classification}`);
  if (payload.cmux.remediation) lines.push(payload.cmux.remediation);
  return lines.join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2), {
    flags: ['json'],
    valued: ['output'],
  });
  const payload = discover();
  if (args.output) {
    const out = expandUser(args.output);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  }
  if (args.json) {
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  } else {
    process.stdout.write(renderHuman(payload) + '\n');
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
