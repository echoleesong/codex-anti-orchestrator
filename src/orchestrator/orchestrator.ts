import {
  checkGitCleanliness,
  checkGitLockfile,
  createWorktree,
  getCurrentBranch,
  isGitRepository,
} from '../git/git-utils.js';
import {
  DEFAULT_ALLOWED_BASE_DIR,
  generateSafeTaskId,
  getAllowedBaseDir,
  getDefaultStateDir,
  getTaskBranchName,
  getTaskWorktreePath,
  validateTargetRepoPath,
} from '../security/path-validator.js';
import {
  listTaskStates,
  loadTaskState,
  saveTaskState,
  transitionTaskState,
} from '../state/state-machine.js';
import type { CreateTaskOptions, ResumeTaskOptions, TaskRecord } from '../types.js';
import { defaultExecutor } from '../utils/exec.js';

export class Orchestrator {
  private stateDir: string;
  private allowedBaseDir: string;

  constructor(options: { stateDir?: string; allowedBaseDir?: string } = {}) {
    this.stateDir = options.stateDir || getDefaultStateDir();
    this.allowedBaseDir = options.allowedBaseDir || getAllowedBaseDir();
  }

  getStateDir(): string {
    return this.stateDir;
  }

  /**
   * Creates a new orchestrated development task.
   * Enforces path safety, git cleanliness, and isolated external worktrees.
   */
  async createTask(options: CreateTaskOptions): Promise<TaskRecord> {
    const executor = options.executor || defaultExecutor;
    const allowedBase = options.allowedBaseDir || this.allowedBaseDir;
    const stateDir = options.stateDir || this.stateDir;

    // 1. Validate Target Repository Path
    const pathCheck = validateTargetRepoPath(options.repoPath, allowedBase);
    if (!pathCheck.valid) {
      throw new Error(`Invalid target repository path: ${pathCheck.error}`);
    }
    const targetRepoPath = pathCheck.resolvedPath;

    // 2. Validate Git Repository
    const isRepo = await isGitRepository(targetRepoPath, executor);
    if (!isRepo) {
      throw new Error(`Directory is not a valid Git repository: ${targetRepoPath}`);
    }

    // 3. Inspect Git Lockfile (NEVER auto-delete lock files)
    const lockCheck = await checkGitLockfile(targetRepoPath, executor);
    if (lockCheck.locked) {
      throw new Error(
        `Git repository lock detected: ${lockCheck.details}. Automated task creation halted. Please resolve the lock manually.`
      );
    }

    // 4. Validate Git Cleanliness
    const cleanlinessCheck = await checkGitCleanliness(targetRepoPath, executor);
    if (!cleanlinessCheck.clean) {
      throw new Error(
        `Target repository working tree is not clean. Uncommitted changes:\n${cleanlinessCheck.uncommitted.join('\n')}`
      );
    }

    // 5. Generate Sanitized IDs and Paths
    const taskId = generateSafeTaskId(options.prompt);
    const baseBranch = options.baseBranch || (await getCurrentBranch(targetRepoPath, executor));
    const taskBranch = getTaskBranchName(taskId);
    const worktreePath = getTaskWorktreePath(stateDir, taskId);

    const now = new Date().toISOString();
    const task: TaskRecord = {
      id: taskId,
      targetRepoPath,
      baseBranch,
      taskBranch,
      worktreePath,
      state: 'IDLE',
      createdAt: now,
      updatedAt: now,
      prompt: options.prompt,
      transitions: [],
      diagnostics: {
        reviewCycles: 0,
        maxReviewCycles: 3,
        resumePossible: false,
        worktreePreserved: true,
      },
    };

    // Transition IDLE -> INITIALIZING
    transitionTaskState(task, 'INITIALIZING', {
      reason: 'Starting task initialization and prerequisite validation.',
    });
    await saveTaskState(stateDir, task);

    // Transition INITIALIZING -> WORKTREE_PREPARING
    transitionTaskState(task, 'WORKTREE_PREPARING', {
      reason: `Allocating external isolated worktree at ${worktreePath}`,
    });
    await saveTaskState(stateDir, task);

    // 6. Create Isolated External Worktree
    const worktreeRes = await createWorktree(
      targetRepoPath,
      worktreePath,
      taskBranch,
      baseBranch,
      executor
    );

    if (!worktreeRes.success) {
      transitionTaskState(task, 'FAILED', {
        reason: 'Failed to create isolated Git worktree.',
        error: worktreeRes.error,
      });
      await saveTaskState(stateDir, task);
      throw new Error(`Failed to create worktree: ${worktreeRes.error}`);
    }

    // Transition WORKTREE_PREPARING -> AGY_DEVELOPING
    transitionTaskState(task, 'AGY_DEVELOPING', {
      reason: 'Worktree ready. Prepared for agent development loop.',
    });
    await saveTaskState(stateDir, task);

    return task;
  }

  /**
   * Retrieves a task by ID.
   */
  async getTask(taskId: string): Promise<TaskRecord> {
    const task = await loadTaskState(this.stateDir, taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }
    return task;
  }

  /**
   * Lists all orchestrated tasks.
   */
  async listTasks(): Promise<TaskRecord[]> {
    return listTaskStates(this.stateDir);
  }

  /**
   * Cancels a task and preserves its worktree.
   */
  async cancelTask(taskId: string, reason: string = 'Cancelled by user'): Promise<TaskRecord> {
    const task = await this.getTask(taskId);

    if (task.state === 'COMPLETED' || task.state === 'ABORTED') {
      return task;
    }

    transitionTaskState(task, 'ABORTED', {
      reason,
    });
    task.diagnostics.worktreePreserved = true;
    await saveTaskState(this.stateDir, task);

    return task;
  }

  /**
   * Resumes a paused, failed, or decision-pending task.
   */
  async resumeTask(taskId: string, options: ResumeTaskOptions = {}): Promise<TaskRecord> {
    const task = await this.getTask(taskId);

    if (task.state === 'NEEDS_USER_DECISION') {
      if (options.override) {
        transitionTaskState(task, 'AWAITING_HUMAN_OVERRIDE', {
          reason: 'User explicitly accepted PR with known unresolved risks/warnings.',
        });
      } else {
        if (options.guidance) {
          task.prompt = `${task.prompt}\n\n[User Guidance for Fix]: ${options.guidance}`;
        }
        transitionTaskState(task, 'AGY_FIXING', {
          reason: 'User provided new guidance to resume fix cycle.',
        });
      }
      await saveTaskState(this.stateDir, task);
      return task;
    }

    if (task.state === 'FAILED') {
      const targetState = task.diagnostics.resumeTargetState || 'WORKTREE_PREPARING';
      transitionTaskState(task, targetState, {
        reason: `Resuming task from previous failure in ${task.diagnostics.failedState || 'unknown state'}`,
      });
      task.diagnostics.lastError = undefined;
      await saveTaskState(this.stateDir, task);
      return task;
    }

    throw new Error(
      `Cannot resume task ${taskId} in state ${task.state}. Resume is only supported from NEEDS_USER_DECISION or FAILED.`
    );
  }
}
