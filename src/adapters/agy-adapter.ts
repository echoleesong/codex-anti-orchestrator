import fs from 'node:fs';
import path from 'node:path';
import { validateStateDirIsolation } from '../security/path-validator.js';
import type {
  AgyExecutionResult,
  AgyFixFeedback,
  AgyRunOptions,
  CommandExecutor,
} from '../types.js';
import { defaultExecutor } from '../utils/exec.js';

export class AgyAdapter {
  private executor: CommandExecutor;

  constructor(executor: CommandExecutor = defaultExecutor) {
    this.executor = executor;
  }

  /**
   * Validates that the worktree path is isolated and safe for agy invocation.
   */
  validateWorktree(worktreePath: string, targetRepoPath?: string): void {
    if (!worktreePath || typeof worktreePath !== 'string') {
      throw new Error('Worktree path must be a non-empty string.');
    }

    const resolvedWorktree = path.resolve(worktreePath);
    if (!fs.existsSync(resolvedWorktree)) {
      throw new Error(`Worktree directory does not exist: ${resolvedWorktree}`);
    }

    const stat = fs.statSync(resolvedWorktree);
    if (!stat.isDirectory()) {
      throw new Error(`Worktree path is not a directory: ${resolvedWorktree}`);
    }

    if (targetRepoPath) {
      const isolationCheck = validateStateDirIsolation(resolvedWorktree, targetRepoPath);
      if (!isolationCheck.valid) {
        throw new Error(
          `Security violation: Worktree cannot reside within or equal the target repository. ${isolationCheck.error}`
        );
      }
    }
  }

  /**
   * Builds the initial development prompt for agy.
   */
  buildDevelopmentPrompt(userPrompt: string): string {
    return [
      '### Task Instructions',
      userPrompt.trim(),
      '',
      '### Development Guidelines',
      '1. Implement the requested feature or fix in this isolated worktree.',
      '2. Ensure comprehensive unit test coverage for new and modified code.',
      '3. Maintain existing formatting and style conventions.',
      '4. Do NOT attempt to run permissions bypass commands or edit files outside this worktree.',
      '5. Verify code quality by running tests before finishing.',
    ].join('\n');
  }

  /**
   * Builds the fix prompt for agy incorporating review feedback and test failures.
   */
  buildFixPrompt(originalPrompt: string, feedback: AgyFixFeedback): string {
    const lines: string[] = [
      '### Original Task Prompt',
      originalPrompt.trim(),
      '',
      '### Fix Instructions (Code Review & Test Feedback)',
      'Please address the following issues identified during automated review and verification:',
      '',
    ];

    if (feedback.blockingIssues && feedback.blockingIssues.length > 0) {
      lines.push('#### Blocking Issues:');
      for (const issue of feedback.blockingIssues) {
        lines.push(`- [BLOCKER] ${issue}`);
      }
      lines.push('');
    }

    if (feedback.warnings && feedback.warnings.length > 0) {
      lines.push('#### Warnings / Suggestions:');
      for (const warning of feedback.warnings) {
        lines.push(`- [WARN] ${warning}`);
      }
      lines.push('');
    }

    if (feedback.testErrors) {
      lines.push('#### Test Failures:');
      lines.push('```');
      lines.push(feedback.testErrors.trim());
      lines.push('```');
      lines.push('');
    }

    lines.push('### Guidelines for Fix:');
    lines.push('1. Resolve all blocking issues and failing tests without introducing regressions.');
    lines.push('2. Do not mutate files outside this isolated worktree.');
    lines.push('3. Verify fixes locally before finishing.');

    return lines.join('\n');
  }

  /**
   * Executes agy in sandboxed mode inside the isolated external worktree.
   * Note: agy invocations are self-contained per iteration; no session daemon resume is promised.
   */
  async runAgy(options: AgyRunOptions): Promise<AgyExecutionResult> {
    const executor = options.executor || this.executor;
    const timeoutMs = options.timeoutMs ?? 180000; // 3 minutes default for agent coding

    this.validateWorktree(options.worktreePath, options.targetRepoPath);

    // Strict command invariant: uses argument array only, explicitly chooses --sandbox and --edit mode
    const args = ['--sandbox', '--edit', '-p', options.prompt];

    const result = await executor('agy', args, {
      cwd: options.worktreePath,
      timeoutMs,
      rejectForbiddenFlags: true,
    });

    if (result.exitCode !== 0 || result.error) {
      return {
        success: false,
        stdout: result.stdout,
        stderr: result.stderr,
        error:
          result.error?.message ||
          `agy exited with code ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim() || 'Unknown error'}`,
      };
    }

    return {
      success: true,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  /**
   * Runs the initial development phase with agy.
   */
  async runDevelopment(
    worktreePath: string,
    prompt: string,
    options: Partial<AgyRunOptions> = {}
  ): Promise<AgyExecutionResult> {
    const fullPrompt = this.buildDevelopmentPrompt(prompt);
    return this.runAgy({
      ...options,
      worktreePath,
      prompt: fullPrompt,
    });
  }

  /**
   * Runs the fix phase with agy using structured feedback.
   */
  async runFix(
    worktreePath: string,
    originalPrompt: string,
    feedback: AgyFixFeedback,
    options: Partial<AgyRunOptions> = {}
  ): Promise<AgyExecutionResult> {
    const fixPrompt = this.buildFixPrompt(originalPrompt, feedback);
    return this.runAgy({
      ...options,
      worktreePath,
      prompt: fixPrompt,
    });
  }
}
