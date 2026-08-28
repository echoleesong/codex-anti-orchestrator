import { AgyAdapter } from '../adapters/agy-adapter.js';
import { CodexAdapter } from '../adapters/codex-adapter.js';
import { GitHubPRAdapter } from '../adapters/github-pr-adapter.js';
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
  getDefaultStateDir,
  getTaskBranchName,
  getTaskWorktreePath,
  isProhibitedStagingPath,
  validateStateDirIsolation,
  validateTargetRepoPath,
} from '../security/path-validator.js';
import {
  listTaskStates,
  loadTaskState,
  saveTaskState,
  transitionTaskState,
} from '../state/state-machine.js';
import type {
  CommandExecutor,
  CIWaitObservation,
  CIWaitOptions,
  CreateTaskOptions,
  IOrchestrator,
  ResumeTaskOptions,
  TaskRecord,
  TaskEventSource,
  TaskState,
} from '../types.js';
import { defaultExecutor, redactSecrets } from '../utils/exec.js';

export interface RunLoopOptions {
  executor?: CommandExecutor;
  maxReviewCycles?: number;
  testRunner?: (
    worktreePath: string,
    executor: CommandExecutor
  ) => Promise<{ pass: boolean; errors?: string }>;
  ciWait?: CIWaitOptions;
}

const MAX_TASK_EVENTS = 100;
const MAX_CI_WAIT_HISTORY = 20;
const DEFAULT_CI_WAIT_ATTEMPTS = 12;
const DEFAULT_CI_POLL_INTERVAL_MS = 10_000;

export class Orchestrator implements IOrchestrator {
  private stateDir: string;
  private allowedBaseDir: string;
  private defaultExecutor: CommandExecutor;
  private agyAdapter: AgyAdapter;
  private codexAdapter: CodexAdapter;
  private prAdapter: GitHubPRAdapter;

  constructor(
    options: {
      stateDir?: string;
      allowedBaseDir?: string;
      executor?: CommandExecutor;
    } = {}
  ) {
    this.stateDir = options.stateDir || getDefaultStateDir();
    this.allowedBaseDir = options.allowedBaseDir || DEFAULT_ALLOWED_BASE_DIR;
    this.defaultExecutor = options.executor || defaultExecutor;

    this.agyAdapter = new AgyAdapter(this.defaultExecutor);
    this.codexAdapter = new CodexAdapter(this.defaultExecutor);
    this.prAdapter = new GitHubPRAdapter(this.defaultExecutor);
  }

  getStateDir(): string {
    return this.stateDir;
  }

  getAllowedBaseDir(): string {
    return this.allowedBaseDir;
  }

  private recordEvent(
    task: TaskRecord,
    source: TaskEventSource,
    message: string,
    detail?: string
  ): void {
    const event = {
      timestamp: new Date().toISOString(),
      source,
      message: redactSecrets(message).slice(0, 500),
      detail: detail ? redactSecrets(detail).slice(0, 2_000) : undefined,
    };
    task.events = [...(task.events || []), event].slice(-MAX_TASK_EVENTS);
  }

  private async waitForCI(
    task: TaskRecord,
    pr: GitHubPRAdapter,
    prTarget: string,
    executor: CommandExecutor,
    options: CIWaitOptions = {}
  ): Promise<{
    passing: boolean;
    checks: import('../types.js').PRChecksResult;
    terminalReason?: string;
  }> {
    const maxAttempts = options.maxAttempts ?? DEFAULT_CI_WAIT_ATTEMPTS;
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_CI_POLL_INTERVAL_MS;
    const sleep =
      options.sleep ||
      ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const checks = await pr.getPRChecks(task.worktreePath, prTarget, executor);
      const isPendingCheck = (check: { bucket: string; state: string }) =>
        /pending|queued|waiting|in_progress|in progress|requested/.test(
          `${check.bucket} ${check.state}`.toLowerCase()
        );
      const isPassingCheck = (check: { bucket: string; state: string }) =>
        check.bucket.toLowerCase() === 'pass' &&
        ['success', 'neutral', 'pass', 'completed'].includes(check.state.toLowerCase());
      const pending =
        checks.success &&
        checks.checks.length > 0 &&
        checks.checks.some(isPendingCheck) &&
        checks.checks.every((check) => isPendingCheck(check) || isPassingCheck(check));
      const status: CIWaitObservation['status'] = checks.allPassing
        ? 'PASSING'
        : pending
          ? 'PENDING'
          : checks.success
            ? 'FAILING'
            : 'UNAVAILABLE';
      const summary =
        checks.error || checks.checks.map((check) => `${check.name}: ${check.state}`).join(', ');
      const observation: CIWaitObservation = {
        timestamp: new Date().toISOString(),
        attempt,
        status,
        summary: summary.slice(0, 2_000),
        checks: checks.checks,
      };
      task.diagnostics.ciWaitAttempts = attempt;
      task.diagnostics.ciWaitHistory = [
        ...(task.diagnostics.ciWaitHistory || []),
        observation,
      ].slice(-MAX_CI_WAIT_HISTORY);
      this.recordEvent(
        task,
        'GITHUB_CI',
        `CI observation ${attempt}/${maxAttempts}: ${status}`,
        observation.summary
      );
      await saveTaskState(this.stateDir, task);

      if (checks.allPassing) {
        return { passing: true, checks };
      }
      if (!pending) {
        return {
          passing: false,
          checks,
          terminalReason:
            checks.error || 'GitHub PR CI checks failed or completed without a passing result.',
        };
      }
      if (attempt < maxAttempts) {
        await sleep(pollIntervalMs);
      }
    }

    const last = task.diagnostics.ciWaitHistory?.at(-1);
    return {
      passing: false,
      checks: { success: true, allPassing: false, checks: last?.checks || [] },
      terminalReason: `GitHub PR CI remained pending after ${maxAttempts} bounded polling attempts.`,
    };
  }

  /**
   * Creates a new orchestrated development task.
   * Enforces path safety, state isolation, git cleanliness, and isolated external worktrees.
   */
  async createTask(options: CreateTaskOptions): Promise<TaskRecord> {
    const executor = options.executor || this.defaultExecutor;
    const allowedBase = options.allowedBaseDir || this.allowedBaseDir;
    const stateDir = options.stateDir || this.stateDir;
    const maxReviewCycles = options.maxReviewCycles ?? 3;

    // 1. Validate Target Repository Path
    const pathCheck = validateTargetRepoPath(options.repoPath, allowedBase);
    if (!pathCheck.valid) {
      throw new Error(`Invalid target repository path: ${pathCheck.error}`);
    }
    const targetRepoPath = pathCheck.resolvedPath;

    // 2. Validate State Directory Isolation (must be outside target repository)
    const stateIsolationCheck = validateStateDirIsolation(stateDir, targetRepoPath);
    if (!stateIsolationCheck.valid) {
      throw new Error(`Invalid state directory isolation: ${stateIsolationCheck.error}`);
    }

    // 3. Validate Git Repository
    const isRepo = await isGitRepository(targetRepoPath, executor);
    if (!isRepo) {
      throw new Error(`Directory is not a valid Git repository: ${targetRepoPath}`);
    }

    // 4. Inspect Git Lockfile (Fail fast if locked; NEVER auto-delete lock files)
    const lockCheck = await checkGitLockfile(targetRepoPath, executor);
    if (lockCheck.error) {
      throw new Error(
        `Failed to complete Git lockfile check: ${lockCheck.error}. Automated task creation halted.`
      );
    }
    if (lockCheck.locked) {
      throw new Error(
        `Git repository lock detected: ${lockCheck.details}. Automated task creation halted. Please resolve the lock manually.`
      );
    }

    // 5. Validate Git Cleanliness
    const cleanlinessCheck = await checkGitCleanliness(targetRepoPath, executor);
    if (!cleanlinessCheck.clean) {
      throw new Error(
        `Target repository working tree is not clean. Uncommitted changes:\n${cleanlinessCheck.uncommitted.join('\n')}`
      );
    }

    // 6. Generate Sanitized IDs and Paths
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
      events: [],
      diagnostics: {
        reviewCycles: 0,
        maxReviewCycles,
        resumePossible: false,
        worktreePreserved: true,
      },
    };

    this.recordEvent(
      task,
      'ORCHESTRATOR',
      'Task accepted and isolated worktree allocation started.'
    );

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

    // 7. Create Isolated External Worktree
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

    // Transition WORKTREE_PREPARING -> WORKTREE_READY (Ready for Phase 3 agy development)
    transitionTaskState(task, 'WORKTREE_READY', {
      reason: 'External worktree allocated and validated. Ready for agent development invocation.',
    });
    await saveTaskState(stateDir, task);

    return task;
  }

  /**
   * Helper to commit current changes in the isolated worktree using a fail-closed staging policy.
   * Rejects prohibited, sensitive, and generated files before staging (never uses 'git add -A').
   */
  async commitWorktreeChanges(
    worktreePath: string,
    commitMessage: string,
    executor: CommandExecutor = this.defaultExecutor
  ): Promise<boolean> {
    const statusRes = await executor('git', ['status', '--porcelain'], {
      cwd: worktreePath,
    });

    if (statusRes.exitCode !== 0) {
      throw new Error(`Failed to check worktree status before staging: ${statusRes.stderr.trim()}`);
    }

    const lines = statusRes.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    if (lines.length === 0) {
      return false; // No changes to commit
    }

    const filesToStage: string[] = [];
    const prohibitedDetected: Array<{ file: string; reason: string }> = [];

    for (const line of lines) {
      // Line format: XY <path> or XY <old> -> <new>
      const rawPath = line.slice(3).trim();
      const actualFile = rawPath.includes(' -> ') ? rawPath.split(' -> ')[1].trim() : rawPath;

      const check = isProhibitedStagingPath(actualFile);
      if (check.prohibited) {
        prohibitedDetected.push({
          file: actualFile,
          reason: check.reason || 'Prohibited staging path',
        });
      } else {
        filesToStage.push(actualFile);
      }
    }

    if (prohibitedDetected.length > 0) {
      const details = prohibitedDetected.map((p) => `  - ${p.file} (${p.reason})`).join('\n');
      throw new Error(
        `Safe staging policy violation: Found prohibited or sensitive files in worktree before commit:\n${details}\nAutomated staging halted.`
      );
    }

    if (filesToStage.length === 0) {
      return false;
    }

    // Stage only explicitly validated safe files
    const addRes = await executor('git', ['add', '--', ...filesToStage], { cwd: worktreePath });
    if (addRes.exitCode !== 0 || addRes.error) {
      throw new Error(
        `Failed to stage validated safe files: ${addRes.stderr.trim() || addRes.error?.message || 'git add failed'}`
      );
    }

    const diffRes = await executor('git', ['diff', '--cached', '--name-only'], {
      cwd: worktreePath,
    });

    if (!diffRes.stdout.trim()) {
      return false; // No changes staged
    }

    const commitRes = await executor('git', ['commit', '-m', commitMessage], {
      cwd: worktreePath,
    });
    return commitRes.exitCode === 0;
  }

  /**
   * Helper to execute automated tests in the worktree.
   */
  private async runWorktreeTests(
    worktreePath: string,
    executor: CommandExecutor,
    customRunner?: (
      worktreePath: string,
      executor: CommandExecutor
    ) => Promise<{ pass: boolean; errors?: string }>
  ): Promise<{ pass: boolean; errors?: string }> {
    if (customRunner) {
      return customRunner(worktreePath, executor);
    }

    const testRes = await executor('npm', ['test'], { cwd: worktreePath });
    if (testRes.exitCode === 0) {
      return { pass: true };
    }

    return {
      pass: false,
      errors:
        testRes.stderr.trim() || testRes.stdout.trim() || 'Tests failed with non-zero exit code.',
    };
  }

  /**
   * Executes the full controlled development, review, and fix state loop.
   */
  async runTaskLoop(taskId: string, loopOptions: RunLoopOptions = {}): Promise<TaskRecord> {
    const executor = loopOptions.executor || this.defaultExecutor;
    const agy = new AgyAdapter(executor);
    const codex = new CodexAdapter(executor);
    const pr = new GitHubPRAdapter(executor);

    let task = await this.getTask(taskId);

    // Loop continues until a stopping state is reached:
    // Terminal / Human gate states: AWAITING_HUMAN_APPROVAL, NEEDS_USER_DECISION, AWAITING_HUMAN_OVERRIDE, COMPLETED, FAILED, ABORTED
    while (
      task.state !== 'AWAITING_HUMAN_APPROVAL' &&
      task.state !== 'NEEDS_USER_DECISION' &&
      task.state !== 'AWAITING_HUMAN_OVERRIDE' &&
      task.state !== 'COMPLETED' &&
      task.state !== 'FAILED' &&
      task.state !== 'ABORTED'
    ) {
      try {
        switch (task.state) {
          case 'WORKTREE_READY': {
            // 1. Transition to AGY_DEVELOPING
            transitionTaskState(task, 'AGY_DEVELOPING', {
              reason: 'Invoking agy for autonomous code generation and tests.',
            });
            await saveTaskState(this.stateDir, task);
            this.recordEvent(task, 'ANTI', 'Development request dispatched to Antigravity.');
            await saveTaskState(this.stateDir, task);

            // 2. Invoke agy in isolated external worktree with --sandbox
            const agyRes = await agy.runDevelopment(task.worktreePath, task.prompt, {
              targetRepoPath: task.targetRepoPath,
              stateDir: this.stateDir,
              executor,
            });

            if (!agyRes.success) {
              transitionTaskState(task, 'FAILED', {
                reason: 'agy development execution failed.',
                error: agyRes.error,
              });
              await saveTaskState(this.stateDir, task);
              return task;
            }

            this.recordEvent(
              task,
              'ANTI',
              'Antigravity development invocation completed.',
              agyRes.stdout
            );

            // 3. Commit changes & push branch
            const committed = await this.commitWorktreeChanges(
              task.worktreePath,
              `feat: ${task.prompt.slice(0, 50).trim()}`,
              executor
            );
            if (!committed) {
              transitionTaskState(task, 'FAILED', {
                reason: 'Antigravity completed without producing staged worktree changes.',
              });
              this.recordEvent(
                task,
                'ORCHESTRATOR',
                'No changes were committed; PR creation halted.'
              );
              await saveTaskState(this.stateDir, task);
              return task;
            }

            const pushRes = await pr.pushTaskBranch(task.worktreePath, task.taskBranch, executor);
            if (!pushRes.success) {
              transitionTaskState(task, 'FAILED', {
                reason: 'Failed to push task branch to remote origin.',
                error: pushRes.error,
              });
              await saveTaskState(this.stateDir, task);
              return task;
            }

            // 4. Transition to PR_CREATING and open PR
            transitionTaskState(task, 'PR_CREATING', {
              reason: 'Opening GitHub Pull Request for task branch.',
            });
            await saveTaskState(this.stateDir, task);

            const prRes = await pr.createPR({
              worktreePath: task.worktreePath,
              branch: task.taskBranch,
              baseBranch: task.baseBranch,
              title: `feat: ${task.prompt.slice(0, 60).trim()}`,
              body: `Automated PR generated for task: ${task.id}\n\nPrompt: ${task.prompt}`,
              executor,
            });

            if (!prRes.success) {
              transitionTaskState(task, 'FAILED', {
                reason: 'Failed to create GitHub Pull Request.',
                error: prRes.error,
              });
              await saveTaskState(this.stateDir, task);
              return task;
            }

            task.metadata = {
              ...(task.metadata || {}),
              prUrl: prRes.prUrl,
              prNumber: prRes.prNumber,
            };
            this.recordEvent(task, 'ORCHESTRATOR', 'Pull request created.', prRes.prUrl);

            // Transition PR_CREATING -> CODEX_REVIEWING
            transitionTaskState(task, 'CODEX_REVIEWING', {
              reason: 'PR published. Starting read-only Codex review.',
            });
            await saveTaskState(this.stateDir, task);
            break;
          }

          case 'CODEX_REVIEWING': {
            // Invoke Codex review in read-only sandbox mode, explicitly checking diff against baseBranch
            const reviewResult = await codex.review({
              worktreePath: task.worktreePath,
              baseBranch: task.baseBranch,
              prNumberOrBranch: task.taskBranch,
              executor,
            });

            task.diagnostics.lastReviewVerdict = reviewResult.verdict;
            task.diagnostics.humanVerificationChecklist = reviewResult.humanVerificationChecklist;
            this.recordEvent(
              task,
              'CODEX',
              `Codex review completed with verdict: ${reviewResult.verdict}.`,
              reviewResult.summary
            );

            // Transition CODEX_REVIEWING -> REVIEW_EVALUATING
            transitionTaskState(task, 'REVIEW_EVALUATING', {
              reason: `Codex review completed with verdict: ${reviewResult.verdict}`,
            });
            await saveTaskState(this.stateDir, task);

            // 1. Run automated tests in worktree (mandatory local tests)
            const testResult = await this.runWorktreeTests(
              task.worktreePath,
              executor,
              loopOptions.testRunner
            );
            const testPassed = testResult.pass;
            const testErrors = testResult.errors;

            task.diagnostics.lastTestPassed = testPassed;

            // 2. Query GitHub PR CI checks
            const prTarget = task.metadata?.prNumber
              ? String(task.metadata.prNumber)
              : task.taskBranch;
            const reviewClean =
              reviewResult.verdict === 'APPROVE' && reviewResult.blockingIssues.length === 0;

            // 3. Evaluation logic in REVIEW_EVALUATING:

            // Fail-safe fallback if Codex review requested decision or was malformed
            if (reviewResult.verdict === 'NEEDS_USER_DECISION') {
              transitionTaskState(task, 'NEEDS_USER_DECISION', {
                reason: 'Codex review indicated NEEDS_USER_DECISION or unparseable output.',
              });
              await saveTaskState(this.stateDir, task);
              return task;
            }

            const ciWait = await this.waitForCI(task, pr, prTarget, executor, loopOptions.ciWait);
            const ciPassing = ciWait.passing;

            // Fail-closed stop if PR CI checks fail, cannot be read, or remain pending beyond bounded polling.
            if (!ciPassing) {
              transitionTaskState(task, 'NEEDS_USER_DECISION', {
                reason: ciWait.checks.error
                  ? `GitHub PR CI checks failed or unavailable: ${ciWait.terminalReason || ciWait.checks.error}`
                  : `GitHub PR CI checks require user decision: ${ciWait.terminalReason || 'unknown CI state'}`,
              });
              await saveTaskState(this.stateDir, task);
              return task;
            }

            // A clean automated result is not enough for a human handoff. Anti must now start the
            // current application locally and execute Codex's review-authored observable checks.
            if (testPassed && reviewClean && ciPassing) {
              transitionTaskState(task, 'AGY_VALIDATING', {
                reason:
                  'All automated gates passed. Starting Anti local development-environment verification before human PR review.',
              });
              this.recordEvent(
                task,
                'ANTI',
                'Live verification request dispatched with Codex review checklist.',
                reviewResult.humanVerificationChecklist.join('\n')
              );
              await saveTaskState(this.stateDir, task);
              break;
            }

            // If not clean and review cycles exhausted -> NEEDS_USER_DECISION
            if (task.diagnostics.reviewCycles >= task.diagnostics.maxReviewCycles) {
              transitionTaskState(task, 'NEEDS_USER_DECISION', {
                reason: `Reached maximum review cycles (${task.diagnostics.maxReviewCycles}) with unresolved issues.`,
              });
              await saveTaskState(this.stateDir, task);
              return task;
            }

            // Can attempt fix cycle
            task.diagnostics.reviewCycles += 1;
            transitionTaskState(task, 'AGY_FIXING', {
              reason: `Attempting automated fix iteration ${task.diagnostics.reviewCycles} of ${task.diagnostics.maxReviewCycles}.`,
            });
            task.metadata = {
              ...(task.metadata || {}),
              lastFeedback: {
                blockingIssues: reviewResult.blockingIssues,
                warnings: reviewResult.warnings,
                testErrors,
              },
            };
            await saveTaskState(this.stateDir, task);
            break;
          }

          case 'AGY_VALIDATING': {
            const checklist = task.diagnostics.humanVerificationChecklist || [];
            const verification = await agy.runLiveVerification(task.worktreePath, checklist, {
              targetRepoPath: task.targetRepoPath,
              stateDir: this.stateDir,
              executor,
            });
            task.diagnostics.liveVerification = verification;
            this.recordEvent(
              task,
              'ANTI',
              `Live verification completed with status: ${verification.status}.`,
              verification.summary
            );

            if (verification.status !== 'PASSED') {
              transitionTaskState(task, 'NEEDS_USER_DECISION', {
                reason: `Mandatory local live verification did not pass: ${verification.summary}`,
              });
              await saveTaskState(this.stateDir, task);
              return task;
            }

            const verificationCleanliness = await checkGitCleanliness(task.worktreePath, executor);
            if (!verificationCleanliness.clean) {
              transitionTaskState(task, 'NEEDS_USER_DECISION', {
                reason:
                  'Live verification modified the worktree or repository status could not be verified; no unreviewed changes will be committed automatically.',
              });
              this.recordEvent(
                task,
                'ORCHESTRATOR',
                'Live verification left the worktree non-clean; human decision required.',
                verificationCleanliness.uncommitted.join('\n') || verificationCleanliness.error
              );
              await saveTaskState(this.stateDir, task);
              return task;
            }

            const lastCIObservation = task.diagnostics.ciWaitHistory?.at(-1);
            const ciProof = {
              success: lastCIObservation?.status === 'PASSING',
              allPassing: lastCIObservation?.status === 'PASSING',
              checks: lastCIObservation?.checks || [],
            };

            transitionTaskState(task, 'AWAITING_HUMAN_APPROVAL', {
              reason:
                'Automated tests and CI passed, Codex supplied human verification points, and Anti recorded a passed localhost live verification.',
              reviewClean: task.diagnostics.lastReviewVerdict === 'APPROVE',
              testsPass: task.diagnostics.lastTestPassed === true,
              ciPassing: ciProof.allPassing,
              ciProof,
              liveVerificationPassed: true,
            });
            await saveTaskState(this.stateDir, task);
            return task;
          }

          case 'AGY_FIXING': {
            const feedback = (task.metadata?.lastFeedback as {
              blockingIssues: string[];
              warnings?: string[];
              testErrors?: string;
            }) || {
              blockingIssues: ['Please resolve issues found in testing/review.'],
            };

            const fixRes = await agy.runFix(task.worktreePath, task.prompt, feedback, {
              targetRepoPath: task.targetRepoPath,
              stateDir: this.stateDir,
              executor,
            });

            if (!fixRes.success) {
              transitionTaskState(task, 'FAILED', {
                reason: 'agy fix execution failed.',
                error: fixRes.error,
              });
              await saveTaskState(this.stateDir, task);
              return task;
            }

            // Commit fix changes
            await this.commitWorktreeChanges(
              task.worktreePath,
              `fix: resolve review feedback and test failures (cycle ${task.diagnostics.reviewCycles})`,
              executor
            );

            // Push updated changes to task branch
            const pushRes = await pr.pushTaskBranch(task.worktreePath, task.taskBranch, executor);
            if (!pushRes.success) {
              transitionTaskState(task, 'FAILED', {
                reason: 'Failed to push fix commits to task branch.',
                error: pushRes.error,
              });
              await saveTaskState(this.stateDir, task);
              return task;
            }

            // Transition AGY_FIXING -> PR_UPDATING
            transitionTaskState(task, 'PR_UPDATING', {
              reason: 'Pushed fix commits to task branch and updated PR.',
            });
            await saveTaskState(this.stateDir, task);

            // Update PR with iteration comment
            await pr.updatePR({
              worktreePath: task.worktreePath,
              prNumberOrBranch: task.taskBranch,
              comment: `Iterative fix committed for cycle ${task.diagnostics.reviewCycles}/${task.diagnostics.maxReviewCycles}.`,
              executor,
            });

            // Transition PR_UPDATING -> CODEX_REVIEWING
            transitionTaskState(task, 'CODEX_REVIEWING', {
              reason: 'Fix pushed. Triggering re-review with Codex.',
            });
            await saveTaskState(this.stateDir, task);
            break;
          }

          default: {
            throw new Error(`Unhandled state in task loop: ${task.state}`);
          }
        }
      } catch (err) {
        const curState = task.state as TaskState;
        if (curState !== 'FAILED' && curState !== 'ABORTED') {
          transitionTaskState(task, 'FAILED', {
            reason: 'Task loop encountered unhandled error.',
            error: err instanceof Error ? err.message : String(err),
          });
          await saveTaskState(this.stateDir, task);
        }
        return task;
      }
    }

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
      const failedState = task.diagnostics.resumeTargetState;
      const targetState =
        failedState === 'AGY_FIXING' || failedState === 'PR_UPDATING'
          ? 'AGY_FIXING'
          : failedState === 'AGY_VALIDATING'
            ? 'AGY_VALIDATING'
            : failedState === 'CODEX_REVIEWING' || failedState === 'REVIEW_EVALUATING'
              ? 'CODEX_REVIEWING'
              : 'WORKTREE_READY';
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
