/**
 * Display pool — allocates and frees Xvfb display numbers per instance.
 * Persisted to ~/.config/gv-bridge/displays.yaml
 */

import * as fs from 'fs';
import * as path from 'path';
import { getDisplayPoolPath } from './paths';

interface DisplayPoolState {
  assignments: Record<string, string>; // instanceId -> displayNum
}

function loadState(): DisplayPoolState {
  const path = getDisplayPoolPath();
  if (!fs.existsSync(path)) {
    return { assignments: {} };
  }
  try {
    const raw = fs.readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.assignments === 'object') {
      return parsed as DisplayPoolState;
    }
  } catch {
    // ignore parse errors
  }
  return { assignments: {} };
}

function saveState(state: DisplayPoolState): void {
  const poolPath = getDisplayPoolPath();
  const dir = path.dirname(poolPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(poolPath, JSON.stringify(state, null, 2), 'utf-8');
}

function parseDisplayNum(displayNum: string): number {
  return parseInt(displayNum.replace(':', ''), 10);
}

export function allocateDisplay(instanceId: string): string {
  const state = loadState();

  // Already assigned?
  if (state.assignments[instanceId]) {
    return state.assignments[instanceId];
  }

  const used = new Set(Object.values(state.assignments).map(parseDisplayNum));
  let candidate = 99;
  while (used.has(candidate)) {
    candidate++;
  }

  const displayNum = `:${candidate}`;
  state.assignments[instanceId] = displayNum;
  saveState(state);
  return displayNum;
}

export function freeDisplay(instanceId: string): void {
  const state = loadState();
  delete state.assignments[instanceId];
  saveState(state);
}

export function getAssignedDisplay(instanceId: string): string | undefined {
  const state = loadState();
  return state.assignments[instanceId];
}
