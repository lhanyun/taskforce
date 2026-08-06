#!/usr/bin/env node
// CLI adapter module for Taskforce v0.2.
// Owns one command contract per CLI: launch its interactive TUI with an
// initial prompt. Availability is checked separately with a PATH scan.

import path from 'node:path';

// Resolve a CLI name to its executable path. Handles path-qualified names.
export function resolveCli(cli) {
  if (cli.includes('/')) return cli;
  return cli;
}

// Adapter registry. Each adapter provides:
//   name: CLI identifier string
//   tuiLaunchCommand(cli, model, promptText): returns argument array for
//     TUI launch. model is string|null; null means no --model flag.
//     promptText is the actual prompt content string (not a file path).
const ADAPTERS = {
  opencode: {
    name: 'opencode',
    tuiLaunchCommand(cli, model, promptText) {
      const cmd = [resolveCli(cli)];
      if (model !== null && model !== undefined) {
        cmd.push('--model', String(model));
      }
      cmd.push('--prompt', String(promptText));
      return cmd;
    },
  },
  codex: {
    name: 'codex',
    tuiLaunchCommand(cli, model, promptText) {
      const cmd = [resolveCli(cli)];
      if (model !== null && model !== undefined) {
        cmd.push('--model', String(model));
      }
      cmd.push(String(promptText));
      return cmd;
    },
  },
  claude: {
    name: 'claude',
    tuiLaunchCommand(cli, model, promptText) {
      const cmd = [resolveCli(cli)];
      if (model !== null && model !== undefined) {
        cmd.push('--model', String(model));
      }
      // Claude Code accepts the initial interactive prompt as a positional
      // argument. --prompt is not a Claude option; -p/--print is non-TUI.
      cmd.push(String(promptText));
      return cmd;
    },
  },
  codebuddy: {
    name: 'codebuddy',
    tuiLaunchCommand(cli, model, promptText) {
      const cmd = [resolveCli(cli)];
      if (model !== null && model !== undefined) {
        cmd.push('--model', String(model));
      }
      cmd.push(String(promptText));
      return cmd;
    },
  },
};

// Get the adapter for a CLI name. Returns the adapter object or throws
// if the CLI is not supported.
export function getAdapter(cli) {
  const name = path.basename(resolveCli(cli));
  const adapter = ADAPTERS[name];
  if (!adapter) {
    throw new Error(
      `No CLI adapter registered for '${name}'. ` +
      `Supported CLIs: ${Object.keys(ADAPTERS).join(', ')}. ` +
      `To add support, register an adapter in cli_adapters.mjs.`
    );
  }
  return adapter;
}

// Return the TUI launch command array for the given CLI, model, and prompt text.
export function tuiLaunchCommand(cli, model, promptText) {
  const adapter = getAdapter(cli);
  return adapter.tuiLaunchCommand(cli, model, promptText);
}
