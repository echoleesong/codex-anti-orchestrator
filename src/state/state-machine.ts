import fs from 'node:fs';
import path from 'node:path';
import { getTaskDir, getTaskStateFilePath } from '../security/path-validator.js';
import type { PRChecksResult, StateTransitionRecord, TaskRecord, TaskState } from '../types.js';

export const VALID_TRANSITIONS: Record<TaskState, TaskState[]> = {
  IDLE: ['INITIALIZING', 'ABORTED'],
  INITIALIZING: ['WORKTREE_PREPARING', 'FAILED', 'ABORTED'],
  WORKTREE_PREPARING: ['WORKTREE_READY', 'FAILED', 'ABORTED'],
  WORKTREE_READY: ['AGY_DEVELOPING', 'FAILED', 'ABORTED'],
  AGY_DEVELOPING: ['PR_CREATING', 'FAILED', 'ABORTED'],
  PR_CREATING: ['CODEX_REVIEWING', 'FAILED', 'ABORTED'],
  CODEX_REVIEWING: ['REVIEW_EVALUATING', 'FAILED', 'ABORTED'],
  REVIEW_EVALUATING: [
    'AWAITING_HUMAN_APPROVAL',
    'AGY_FIXING',
    'NEEDS_USER_DECISION',
    'FAILED',
    'ABORTED',
  ],
  AGY_FIXING: ['PR_UPDATING', 'FAILED', 'ABORTED'],
  PR_UPDATING: ['CODEX_REVIEWING', 'FAILED', 'ABORTED'],
  AWAITING_HUMAN_APPROVAL: ['COMPLETED', 'ABORTED'],
  NEEDS_USER_DECISION: ['AGY_FIXING', 'AWAITING_HUMAN_OVERRIDE', 'ABORTED'],
  AWAITING_HUMAN_OVERRIDE: ['COMPLETED', 'ABORTED', 'AGY_FIXING'],
  FAILED: [
    'INITIALIZING',
    'WORKTREE_PREPARING',
    'WORKTREE_READY',
    'AGY_DEVELOPING',
    'AGY_FIXING',
    'ABORTED',
  ],
  COMPLETED: [],
  ABORTED: [],
};

/**
 * Checks if a transition between two states is valid according to the state machine matrix.
 */
export function isValidTransition(from: TaskState, to: TaskState): boolean {
  if (from === to) return true;
  const allowed = VALID_TRANSITIONS[from];
  return Boolean(allowed && allowed.includes(to));
}

export interface StateTransitionOptions {
  reason?: string;
  error?: string;
  reviewClean?: boolean;
  testsPass?: boolean;
  ciPassing?: boolean;
  ciProof?: { allPassing?: boolean; [key: string]: unknown } | PRChecksResult | unknown;
}

/**
 * Validates and records a state transition on a TaskRecord.
 * Throws an Error if the transition is illegal.
 */
export function transitionTaskState(
  task: TaskRecord,
  nextState: TaskState,
  options: StateTransitionOptions = {}
): TaskRecord {
  const currentState = task.state;

  if (currentState === nextState) {
    return task;
  }

  // Strict invariant: NEVER allow NEEDS_USER_DECISION -> AWAITING_HUMAN_APPROVAL
  if (currentState === 'NEEDS_USER_DECISION' && nextState === 'AWAITING_HUMAN_APPROVAL') {
    throw new Error(
      'Illegal state transition: NEEDS_USER_DECISION cannot transition directly to AWAITING_HUMAN_APPROVAL. ' +
        'A clean approval requires passing all tests and zero Codex review blockers. Use AWAITING_HUMAN_OVERRIDE for manual risk acceptance.'
    );
  }

  // Strict invariant: AWAITING_HUMAN_APPROVAL only allowed from REVIEW_EVALUATING on strictly clean pass
  if (nextState === 'AWAITING_HUMAN_APPROVAL') {
    if (currentState !== 'REVIEW_EVALUATING') {
      throw new Error(
        `Illegal state transition: AWAITING_HUMAN_APPROVAL can only be entered from REVIEW_EVALUATING (current: ${currentState}).`
      );
    }
    // reviewClean, testsPass, ciPassing === true, AND a structured ciProof object demonstrating allPassing === true
    // must all be explicitly and strictly true. A caller cannot pass ciPassing alone.
    const isCiProofValid =
      typeof options.ciProof === 'object' &&
      options.ciProof !== null &&
      !Array.isArray(options.ciProof) &&
      (options.ciProof as { allPassing?: unknown }).allPassing === true;

    if (
      options.reviewClean !== true ||
      options.testsPass !== true ||
      options.ciPassing !== true ||
      !isCiProofValid
    ) {
      throw new Error(
        'Cannot transition to AWAITING_HUMAN_APPROVAL: reviewClean, testsPass, ciPassing === true, and a structured ciProof object demonstrating allPassing === true must all be strictly provided and true (missing, false, or malformed fields rejected).'
      );
    }
  }

  if (!isValidTransition(currentState, nextState)) {
    throw new Error(
      `Invalid state transition: Cannot transition from ${currentState} to ${nextState}. Allowed transitions: [${(VALID_TRANSITIONS[currentState] || []).join(', ')}]`
    );
  }

  const transitionRecord: StateTransitionRecord = {
    from: currentState,
    to: nextState,
    timestamp: new Date().toISOString(),
    reason: options.reason,
    error: options.error,
  };

  task.state = nextState;
  task.updatedAt = transitionRecord.timestamp;
  task.transitions.push(transitionRecord);

  if (options.error) {
    task.diagnostics.lastError = options.error;
    task.diagnostics.failedState = currentState;
  }

  // Update resume capabilities and diagnostics
  if (nextState === 'FAILED') {
    task.diagnostics.resumePossible = true;
    task.diagnostics.resumeTargetState = currentState;
    task.diagnostics.resumeInstructions = `Run 'orchestrator resume ${task.id}' after addressing the failure cause.`;
  } else if (nextState === 'NEEDS_USER_DECISION') {
    task.diagnostics.resumePossible = true;
    task.diagnostics.resumeTargetState = 'AGY_FIXING';
    task.diagnostics.resumeInstructions = `Run 'orchestrator resume ${task.id} --guidance "<prompt>"' to retry or 'orchestrator resume ${task.id} --override' to accept with known risks.`;
  } else if (nextState === 'AWAITING_HUMAN_OVERRIDE') {
    task.diagnostics.resumePossible = false;
    task.diagnostics.resumeInstructions =
      'Task is awaiting human manual merge with documented overrides. Merge PR manually in GitHub.';
  } else if (nextState === 'AWAITING_HUMAN_APPROVAL') {
    task.diagnostics.resumePossible = false;
    task.diagnostics.resumeInstructions =
      'Task is awaiting human manual approval and PR merge in GitHub.';
  } else if (nextState === 'COMPLETED' || nextState === 'ABORTED') {
    task.diagnostics.resumePossible = false;
  }

  return task;
}

/**
 * Persists a TaskRecord to disk atomically.
 */
export async function saveTaskState(stateDir: string, task: TaskRecord): Promise<void> {
  const taskDir = getTaskDir(stateDir, task.id);
  const stateFilePath = getTaskStateFilePath(stateDir, task.id);
  const tempFilePath = `${stateFilePath}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;

  fs.mkdirSync(taskDir, { recursive: true });

  const serialized = JSON.stringify(task, null, 2);
  fs.writeFileSync(tempFilePath, serialized, 'utf-8');
  fs.renameSync(tempFilePath, stateFilePath);
}

/**
 * Loads a TaskRecord from disk.
 */
export async function loadTaskState(stateDir: string, taskId: string): Promise<TaskRecord | null> {
  const stateFilePath = getTaskStateFilePath(stateDir, taskId);
  if (!fs.existsSync(stateFilePath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(stateFilePath, 'utf-8');
    return JSON.parse(content) as TaskRecord;
  } catch (err) {
    throw new Error(
      `Failed to load task state for ${taskId}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Lists all persisted task records in the state directory.
 */
export async function listTaskStates(stateDir: string): Promise<TaskRecord[]> {
  const tasksBaseDir = path.join(path.resolve(stateDir), 'tasks');
  if (!fs.existsSync(tasksBaseDir)) {
    return [];
  }

  const taskDirs = fs.readdirSync(tasksBaseDir);
  const tasks: TaskRecord[] = [];

  for (const taskId of taskDirs) {
    const task = await loadTaskState(stateDir, taskId);
    if (task) {
      tasks.push(task);
    }
  }

  // Sort newest first
  return tasks.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}
