#!/usr/bin/env node
// Minimal executable fake agent CLI used by deterministic Taskforce tests.
// Node port of tests/fixtures/fake_agent_cli.py.

import process from 'node:process';

if (process.argv.includes('--version')) {
  process.stdout.write('fake-agent 1.0\n');
  process.exit(0);
}
process.stdout.write('fake agent\n');
