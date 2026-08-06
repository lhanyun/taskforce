#!/usr/bin/env node
// Ephemeral CLI selection for Taskforce. Availability is always read from the
// current PATH; no profiles or discovery snapshots are created.

import path from 'node:path';
import { getAdapter } from './cli_adapters.mjs';
import { listAvailableClis, which } from './doctor.mjs';

export function ensureCliAvailable(cli) {
  const requested = String(cli || '').trim();
  if (!requested) return { ok: false, error: 'cli_required' };

  try {
    getAdapter(requested);
  } catch (error) {
    return { ok: false, error: 'adapter_unavailable', diagnostic: String(error?.message || error) };
  }

  const executablePath = which(requested);
  if (!executablePath) {
    return { ok: false, error: 'cli_unavailable', cli: requested };
  }
  return {
    ok: true,
    cli: requested.includes('/') ? requested : path.basename(requested),
    name: path.basename(requested),
    path: executablePath,
  };
}

export function selectCli({ requestedCli = '', chiefCli = '', availableClis = null } = {}) {
  const explicit = String(requestedCli || '').trim();
  if (explicit) {
    const checked = ensureCliAvailable(explicit);
    return checked.ok ? { ...checked, selected_by: 'user' } : checked;
  }

  const chief = String(chiefCli || '').trim();
  if (chief) {
    const checked = ensureCliAvailable(chief);
    return checked.ok ? { ...checked, selected_by: 'chief' } : checked;
  }

  const available = Array.isArray(availableClis) ? availableClis : listAvailableClis();
  if (available.length === 0) return { ok: false, error: 'no_cli_available', available: [] };
  if (available.length > 1) {
    return {
      ok: false,
      error: 'cli_selection_required',
      available: available.map((item) => typeof item === 'string' ? item : item.name),
    };
  }

  const only = typeof available[0] === 'string' ? available[0] : available[0].name;
  const checked = ensureCliAvailable(only);
  return checked.ok ? { ...checked, selected_by: 'only_available' } : checked;
}
