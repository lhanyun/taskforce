#!/usr/bin/env node
// Deterministic fake cmux controlled by FAKE_CMUX_SCENARIO.
// Node port of tests/fixtures/fake_cmux.py.
//
// Per the T-006 audit (§5.5), this shim REJECTS unknown commands (including
// `set_agent_lifecycle`) with an "Unknown command" message and exit 1, so a
// removed cmux command can never ship silently behind the test fixture. This
// intentionally diverges from the Python fake, which masked the
// set_agent_lifecycle bug by printing "ok".

import fs from 'node:fs';
import process from 'node:process';

const scenario = process.env.FAKE_CMUX_SCENARIO || 'ready';
const args = process.argv.slice(2);

function surfaceFromArgs() {
  const index = args.indexOf('--surface');
  return index >= 0 ? String(args[index + 1] || '') : '';
}

function configuredSurface() {
  const configPath = process.env.FAKE_CMUX_SURFACES_FILE;
  if (!configPath || !fs.existsSync(configPath)) return null;
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return config[surfaceFromArgs()] || null;
  } catch (_) {
    return null;
  }
}

function fail(msg) {
  process.stderr.write(msg + '\n');
  process.exit(1);
}

if (args.length === 1 && args[0] === '-v') {
  if (scenario === 'broken') {
    process.stderr.write('broken\n');
    process.exit(1);
  }
  process.stdout.write('cmux fake-1.0\n');
  process.exit(0);
}

if (args.length === 1 && args[0] === 'ping') {
  const messages = {
    connection: 'connection refused',
    denied: 'Access denied',
    password: 'authentication required: password',
    unknown: 'unexpected control failure',
    sandbox: 'Operation not permitted',
  };
  if (scenario in messages) {
    process.stderr.write(messages[scenario] + '\n');
    process.exit(1);
  }
  process.stdout.write('pong\n');
  process.exit(0);
}

if (args.length > 0 && (args[0] === 'new-workspace' || args[0] === 'workspace' || args[0] === 'notify')) {
  // Canonical workspace creation is `cmux workspace create ...`; legacy
  // `new-workspace` remains an accepted alias. `notify` is always best-effort.
  const log = process.env.FAKE_CMUX_LOG;
  if (log) {
    fs.appendFileSync(log, JSON.stringify(args) + '\n', 'utf8');
  }
  process.stdout.write('ok\n');
  process.exit(0);
}

if (args.length > 0 && (args[0] === 'set-status' || args[0] === 'set-progress' || args[0] === 'log')) {
  // Sidebar status/progress/log commands. pushCmuxSidebar swallows failures
  // silently; logging here lets tests assert the terminal-state push happened.
  const log = process.env.FAKE_CMUX_LOG;
  if (log) {
    fs.appendFileSync(log, JSON.stringify(args) + '\n', 'utf8');
  }
  process.stdout.write('ok\n');
  process.exit(0);
}

if (args.length > 0 && args[0] === 'send') {
  const log = process.env.FAKE_CMUX_LOG;
  if (log) {
    fs.appendFileSync(log, JSON.stringify(args) + '\n', 'utf8');
  }
  if (scenario === 'denied') {
    process.stderr.write('Access denied\n');
    process.exit(1);
  }
  if (scenario === 'connection') {
    process.stderr.write('connection refused\n');
    process.exit(1);
  }
  process.stdout.write('sent\n');
  process.exit(0);
}

if (args.length > 0 && (args[0] === 'read-screen' || args[0] === 'capture-pane')) {
  const surfaceConfig = configuredSurface();
  if (surfaceConfig) {
    if (surfaceConfig.readable === false) {
      process.stderr.write(String(surfaceConfig.error || 'surface unavailable') + '\n');
      process.exit(1);
    }
    process.stdout.write(String(surfaceConfig.text || 'agent is still working') + '\n');
    process.exit(0);
  }
  if (scenario === 'permission') {
    process.stdout.write(
      [
        'Frontend-Master - DeepSeek-V4-Pro',
        '',
        'Permission required',
        '  Access external directory /tmp',
        '',
        'Patterns',
        '',
        '- /tmp/*',
        '',
        '  Allow once    Allow always    > Reject',
        '',
      ].join('\n')
    );
    process.exit(0);
  }
  if (scenario === 'permission-project') {
    // Permission prompt requesting access INSIDE the project directory.
    // The requested path is read from FAKE_CMUX_PROJECT_DIR so the test can
    // make the request match the project root.
    const projectDir = process.env.FAKE_CMUX_PROJECT_DIR || '/tmp/project';
    process.stdout.write(
      [
        'Frontend-Master - DeepSeek-V4-Pro',
        '',
        'Permission required',
        `  Access external directory ${projectDir}/src`,
        '',
        'Patterns',
        '',
        `- ${projectDir}/src/*`,
        '',
        '> Allow once    Allow always      Reject',
        '',
      ].join('\n')
    );
    process.exit(0);
  }
  if (scenario === 'direction-progress') {
    process.stdout.write(
      [
        'Developer is analyzing the task.',
        '',
        "I will rewrite the authentication architecture and replace the public API.",
        'Then I will update the existing callers.',
        '',
      ].join('\n')
    );
    process.exit(0);
  }
  process.stdout.write('agent is still working\n');
  process.exit(0);
}

if (args.length > 0 && args[0] === 'send-key') {
  const log = process.env.FAKE_CMUX_LOG;
  if (log) {
    fs.appendFileSync(log, JSON.stringify(args) + '\n', 'utf8');
  }
  process.stdout.write('sent\n');
  process.exit(0);
}

if (args.length > 0 && args[0] === '--help') {
  process.stdout.write('fake cmux\n');
  process.exit(0);
}

fail(
  `Unknown command '${args[0] || ''}'. Run 'cmux --help' for the full command list.`
);
