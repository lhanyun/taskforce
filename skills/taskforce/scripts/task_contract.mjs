#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { readJson, atomicWriteJson } from './protocol_lib.mjs';

export function validateContract(contract) {
  const errors = [];
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)) {
    return ['contract must be an object'];
  }
  if (typeof contract.id !== 'string' || !contract.id.trim()) {
    errors.push('id is required and must be a non-empty string');
  }
  if (typeof contract.goal !== 'string' || !contract.goal.trim()) {
    errors.push('goal is required and must be a non-empty string');
  }
  const arrayFields = ['boundaries', 'validation', 'done_when'];
  for (const field of arrayFields) {
    if (contract[field] !== undefined) {
      if (!Array.isArray(contract[field])) {
        errors.push(`${field} must be an array if present`);
      } else if (!contract[field].every((v) => typeof v === 'string')) {
        errors.push(`${field} must be an array of strings`);
      }
    }
  }
  return errors;
}

export function loadContract(orch, taskId) {
  const filePath = path.join(orch, 'tasks', `${taskId}.json`);
  if (!fs.existsSync(filePath)) return null;
  const data = readJson(filePath);
  if (data._invalid_json) return null;
  return data;
}

export function saveContract(orch, contract) {
  const filePath = path.join(orch, 'tasks', `${contract.id}.json`);
  atomicWriteJson(filePath, contract);
}

export function compactSummary(contract) {
  return {
    id: contract.id,
    goal: contract.goal,
    ...(contract.boundaries ? { boundaries: contract.boundaries } : { boundaries: [] }),
    ...(contract.validation ? { validation: contract.validation } : { validation: [] }),
    ...(contract.done_when ? { done_when: contract.done_when } : { done_when: [] }),
  };
}
