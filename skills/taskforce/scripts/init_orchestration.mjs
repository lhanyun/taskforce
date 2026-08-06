#!/usr/bin/env node
// Initialize a Taskforce orchestration directory tree.
// v0.2: no roles, no PLAN/PROGRESS/LEARNINGS, no roles.json template.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { parseArgs } from './protocol_lib.mjs';

const DIRECTORIES = [
  'tasks',
  'state',
  'runs',
  'workflows',
  'launchers',
];

function expandUser(p) {
  if (typeof p !== 'string') return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function initialize(project, orchDir = '.taskforce') {
  project = path.resolve(expandUser(project));
  const root = path.join(project, orchDir);
  for (const name of DIRECTORIES) {
    fs.mkdirSync(path.join(root, name), { recursive: true });
  }
  // v0.2: no template files are copied. The task contract is JSON,
  // and there are no roles, PLAN, PROGRESS, or LEARNINGS templates.
  return root;
}

function main() {
  const args = parseArgs(process.argv.slice(2), {
    flags: [],
    valued: ['dir'],
  });
  const projectDir = args._[0] || '';
  const project = path.resolve(expandUser(projectDir));
  const orchDir = args.dir || '.taskforce';
  const root = initialize(project, orchDir);
  process.stdout.write(root + '\n');
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
