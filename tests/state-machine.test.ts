import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  isValidTransition,
  listTaskStates,
  loadTaskState,
  saveTaskState,
  transitionTaskState,
} from '../src/state/state-machine.js';
import type { TaskRecord } from '../src/types.js';

describe('State Machine & Transitions', () => {
  let tempStateDir: string;

  beforeEach(() => {
    tempStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-machine-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempStateDir, { recursive: true, force: true });
  });

  const createInitialTask = (): TaskRecord => ({
    id: 'task-100-test-abc',
    targetRepoPath: '/fake/repo',
    baseBranch: 'main',
    taskBranch: 'anti/task-100-test-abc',
    worktreePath: path.join(tempStateDir, 'worktrees', 'task-100-test-abc'),
    state: 'IDLE',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    prompt: 'Implement core feature',
    transitions: [],
    diagnostics: {
      reviewCycles: 0,
      maxReviewCycles: 3,
      resumePossible: false,
      worktreePreserved: true,
    },
  });

  it('should allow valid linear pipeline transitions including WORKTREE_READY', () => {
    let task = createInitialTask();

    task = transitionTaskState(task, 'INITIALIZING');
    expect(task.state).toBe('INITIALIZING');

    task = transitionTaskState(task, 'WORKTREE_PREPARING');
    expect(task.state).toBe('WORKTREE_PREPARING');

    task = transitionTaskState(task, 'WORKTREE_READY');
    expect(task.state).toBe('WORKTREE_READY');

    task = transitionTaskState(task, 'AGY_DEVELOPING');
    expect(task.state).toBe('AGY_DEVELOPING');

    task = transitionTaskState(task, 'PR_CREATING');
    expect(task.state).toBe('PR_CREATING');

    task = transitionTaskState(task, 'CODEX_REVIEWING');
    expect(task.state).toBe('CODEX_REVIEWING');

    task = transitionTaskState(task, 'REVIEW_EVALUATING');
    expect(task.state).toBe('REVIEW_EVALUATING');

    // Clean review -> AWAITING_HUMAN_APPROVAL
    task = transitionTaskState(task, 'AWAITING_HUMAN_APPROVAL', {
      reviewClean: true,
      testsPass: true,
      ciPassing: true,
      ciProof: { allPassing: true },
    });
    expect(task.state).toBe('AWAITING_HUMAN_APPROVAL');

    // Human merge -> COMPLETED
    task = transitionTaskState(task, 'COMPLETED');
    expect(task.state).toBe('COMPLETED');
  });

  it('should STRICTLY reject transition from NEEDS_USER_DECISION to AWAITING_HUMAN_APPROVAL', () => {
    let task = createInitialTask();
    task.state = 'NEEDS_USER_DECISION';

    expect(() => {
      transitionTaskState(task, 'AWAITING_HUMAN_APPROVAL');
    }).toThrow(
      /Illegal state transition: NEEDS_USER_DECISION cannot transition directly to AWAITING_HUMAN_APPROVAL/
    );
  });

  it('should allow transition from NEEDS_USER_DECISION to AWAITING_HUMAN_OVERRIDE', () => {
    let task = createInitialTask();
    task.state = 'NEEDS_USER_DECISION';

    task = transitionTaskState(task, 'AWAITING_HUMAN_OVERRIDE', {
      reason: 'User explicitly accepted documented warnings.',
    });
    expect(task.state).toBe('AWAITING_HUMAN_OVERRIDE');
  });

  it('should allow transition from NEEDS_USER_DECISION to AGY_FIXING on retry', () => {
    let task = createInitialTask();
    task.state = 'NEEDS_USER_DECISION';

    task = transitionTaskState(task, 'AGY_FIXING', {
      reason: 'User provided new guidance to retry fix loop.',
    });
    expect(task.state).toBe('AGY_FIXING');
  });

  it('should strictly reject AWAITING_HUMAN_APPROVAL when reviewClean, testsPass, ciPassing, or structured ciProof is missing, false, or malformed', () => {
    const makeTask = () => {
      const t = createInitialTask();
      t.state = 'REVIEW_EVALUATING';
      return t;
    };

    // Missing all options
    expect(() => {
      transitionTaskState(makeTask(), 'AWAITING_HUMAN_APPROVAL', {});
    }).toThrow(/reviewClean, testsPass, ciPassing === true, and a structured ciProof object/);

    // Missing testsPass
    expect(() => {
      transitionTaskState(makeTask(), 'AWAITING_HUMAN_APPROVAL', {
        reviewClean: true,
        ciPassing: true,
        ciProof: { allPassing: true },
      });
    }).toThrow(/reviewClean, testsPass, ciPassing === true, and a structured ciProof object/);

    // Missing reviewClean
    expect(() => {
      transitionTaskState(makeTask(), 'AWAITING_HUMAN_APPROVAL', {
        testsPass: true,
        ciPassing: true,
        ciProof: { allPassing: true },
      });
    }).toThrow(/reviewClean, testsPass, ciPassing === true, and a structured ciProof object/);

    // Missing ciPassing alone (caller passes ciProof only)
    expect(() => {
      transitionTaskState(makeTask(), 'AWAITING_HUMAN_APPROVAL', {
        reviewClean: true,
        testsPass: true,
        ciProof: { allPassing: true },
      });
    }).toThrow(/reviewClean, testsPass, ciPassing === true, and a structured ciProof object/);

    // Missing ciProof alone (caller passes ciPassing only)
    expect(() => {
      transitionTaskState(makeTask(), 'AWAITING_HUMAN_APPROVAL', {
        reviewClean: true,
        testsPass: true,
        ciPassing: true,
      });
    }).toThrow(/reviewClean, testsPass, ciPassing === true, and a structured ciProof object/);

    // False reviewClean
    expect(() => {
      transitionTaskState(makeTask(), 'AWAITING_HUMAN_APPROVAL', {
        reviewClean: false,
        testsPass: true,
        ciPassing: true,
        ciProof: { allPassing: true },
      });
    }).toThrow(/reviewClean, testsPass, ciPassing === true, and a structured ciProof object/);

    // False testsPass
    expect(() => {
      transitionTaskState(makeTask(), 'AWAITING_HUMAN_APPROVAL', {
        reviewClean: true,
        testsPass: false,
        ciPassing: true,
        ciProof: { allPassing: true },
      });
    }).toThrow(/reviewClean, testsPass, ciPassing === true, and a structured ciProof object/);

    // False ciPassing
    expect(() => {
      transitionTaskState(makeTask(), 'AWAITING_HUMAN_APPROVAL', {
        reviewClean: true,
        testsPass: true,
        ciPassing: false,
        ciProof: { allPassing: true },
      });
    }).toThrow(/reviewClean, testsPass, ciPassing === true, and a structured ciProof object/);

    // False ciProof object allPassing
    expect(() => {
      transitionTaskState(makeTask(), 'AWAITING_HUMAN_APPROVAL', {
        reviewClean: true,
        testsPass: true,
        ciPassing: true,
        ciProof: { allPassing: false },
      });
    }).toThrow(/reviewClean, testsPass, ciPassing === true, and a structured ciProof object/);

    // Malformed ciProof: boolean instead of structured object
    expect(() => {
      transitionTaskState(makeTask(), 'AWAITING_HUMAN_APPROVAL', {
        reviewClean: true,
        testsPass: true,
        ciPassing: true,
        ciProof: true,
      });
    }).toThrow(/reviewClean, testsPass, ciPassing === true, and a structured ciProof object/);

    // Malformed ciProof: null
    expect(() => {
      transitionTaskState(makeTask(), 'AWAITING_HUMAN_APPROVAL', {
        reviewClean: true,
        testsPass: true,
        ciPassing: true,
        ciProof: null,
      });
    }).toThrow(/reviewClean, testsPass, ciPassing === true, and a structured ciProof object/);

    // Malformed ciProof: array
    expect(() => {
      transitionTaskState(makeTask(), 'AWAITING_HUMAN_APPROVAL', {
        reviewClean: true,
        testsPass: true,
        ciPassing: true,
        ciProof: [{ allPassing: true }],
      });
    }).toThrow(/reviewClean, testsPass, ciPassing === true, and a structured ciProof object/);

    // Malformed ciProof: empty object (missing allPassing)
    expect(() => {
      transitionTaskState(makeTask(), 'AWAITING_HUMAN_APPROVAL', {
        reviewClean: true,
        testsPass: true,
        ciPassing: true,
        ciProof: {},
      });
    }).toThrow(/reviewClean, testsPass, ciPassing === true, and a structured ciProof object/);

    // Malformed ciProof: non-boolean allPassing
    expect(() => {
      transitionTaskState(makeTask(), 'AWAITING_HUMAN_APPROVAL', {
        reviewClean: true,
        testsPass: true,
        ciPassing: true,
        ciProof: { allPassing: 'true' },
      });
    }).toThrow(/reviewClean, testsPass, ciPassing === true, and a structured ciProof object/);

    // Valid proof with simple allPassing: true
    const okTask1 = transitionTaskState(makeTask(), 'AWAITING_HUMAN_APPROVAL', {
      reviewClean: true,
      testsPass: true,
      ciPassing: true,
      ciProof: { allPassing: true },
    });
    expect(okTask1.state).toBe('AWAITING_HUMAN_APPROVAL');

    // Valid proof with complete PRChecksResult object
    const okTask2 = transitionTaskState(makeTask(), 'AWAITING_HUMAN_APPROVAL', {
      reviewClean: true,
      testsPass: true,
      ciPassing: true,
      ciProof: {
        success: true,
        allPassing: true,
        checks: [{ name: 'ci/test', state: 'SUCCESS', bucket: 'pass' }],
      },
    });
    expect(okTask2.state).toBe('AWAITING_HUMAN_APPROVAL');
  });

  it('should reject invalid random state transitions', () => {
    const task = createInitialTask();
    expect(isValidTransition('IDLE', 'COMPLETED')).toBe(false);
    expect(isValidTransition('AGY_DEVELOPING', 'AWAITING_HUMAN_APPROVAL')).toBe(false);

    expect(() => {
      transitionTaskState(task, 'COMPLETED');
    }).toThrow(/Invalid state transition/);
  });

  it('should persist and load task state atomically', async () => {
    let task = createInitialTask();
    task = transitionTaskState(task, 'INITIALIZING', { reason: 'Init test' });

    await saveTaskState(tempStateDir, task);

    const loaded = await loadTaskState(tempStateDir, task.id);
    expect(loaded).toBeDefined();
    expect(loaded?.id).toBe(task.id);
    expect(loaded?.state).toBe('INITIALIZING');
    expect(loaded?.transitions.length).toBe(1);
    expect(loaded?.transitions[0].to).toBe('INITIALIZING');
  });

  it('should list all saved task records', async () => {
    const task1 = createInitialTask();
    task1.id = 'task-1';
    task1.createdAt = new Date(Date.now() - 10000).toISOString();

    const task2 = createInitialTask();
    task2.id = 'task-2';
    task2.createdAt = new Date().toISOString();

    await saveTaskState(tempStateDir, task1);
    await saveTaskState(tempStateDir, task2);

    const all = await listTaskStates(tempStateDir);
    expect(all.length).toBe(2);
    // Newest first
    expect(all[0].id).toBe('task-2');
    expect(all[1].id).toBe('task-1');
  });
});
