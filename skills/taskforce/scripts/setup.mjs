#!/usr/bin/env node
// v0.2 setup: create .taskforce/ directory, check cmux, check at least one CLI.
// No roles, no roles.json, no configure_roles.

import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { parseArgs } from './protocol_lib.mjs';
import { SUPPORTED_CLIS, discoverCmux, listAvailableClis } from './doctor.mjs';
import { initialize } from './init_orchestration.mjs';

function expandUser(p) {
  if (typeof p !== 'string') return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function result(ok, status, extra = {}) {
  return { schema: 'taskforce.setup.v2', ok, status, ...extra };
}

function isGitWorkTree(project) {
  const check = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd: project, encoding: 'utf8', timeout: 8000,
  });
  return check.status === 0 && String(check.stdout || '').trim() === 'true';
}

function emit(payload, asJson) {
  if (asJson) {
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  } else if (payload.status === 'ready') {
    process.stdout.write('Taskforce setup is ready.\n');
  } else {
    const parts = [payload.status, payload.diagnostic, payload.remediation].filter((x) => typeof x === 'string' && x);
    process.stdout.write(parts.join('\n') + '\n');
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2), {
    flags: ['json'],
    valued: ['project-dir', 'orchestrator-dir'],
  });
  const asJson = !!args.json;
  const project = path.resolve(expandUser(args['project-dir'] || ''));
  const orchRel = args['orchestrator-dir'] || '.taskforce';

  const root = initialize(project, orchRel);
  if (!isGitWorkTree(project)) {
    const payload = result(false, 'git_repository_required', {
      diagnostic: 'Taskforce must run inside a Git working tree.',
    });
    emit(payload, asJson);
    return 2;
  }
  const cmux = discoverCmux();
  if (!cmux.ready) {
    const payload = result(false, 'cmux_not_ready', {
      diagnostic: cmux.diagnostic || '',
      remediation: cmux.remediation || '',
    });
    emit(payload, asJson);
    return 2;
  }

  const availableClis = listAvailableClis();

  if (availableClis.length === 0) {
    const payload = result(false, 'no_cli_available', {
      diagnostic: 'No agent CLI is installed or executable',
      checked: SUPPORTED_CLIS,
    });
    emit(payload, asJson);
    return 2;
  }

  const payload = result(true, 'ready', {
    project_dir: project,
    orchestrator_dir: root,
    cmux: cmux.classification,
    available_clis: availableClis.map((cli) => cli.name),
  });
  emit(payload, asJson);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
