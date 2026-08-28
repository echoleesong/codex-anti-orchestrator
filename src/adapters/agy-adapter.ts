import fs from 'node:fs';
import path from 'node:path';
import { validateStateDirIsolation } from '../security/path-validator.js';
import type {
  AgyExecutionResult,
  AgyFixFeedback,
  AgyRunOptions,
  CommandExecutor,
  LiveVerificationResult,
} from '../types.js';
import { defaultExecutor } from '../utils/exec.js';

export const DEFAULT_AGY_PRINT_TIMEOUT_MS = 300_000; // 5 minutes matching agy default print-timeout
export const PROCESS_TIMEOUT_BUFFER_MS = 30_000; // 30 seconds process overhead buffer

export function parseLiveVerificationOutput(rawOutput: string): LiveVerificationResult {
  const fallback = (summary: string): LiveVerificationResult => ({
    status: 'UNAVAILABLE',
    checks: [],
    summary,
    parsedCleanly: false,
    rawOutput: rawOutput || '',
  });
  if (!rawOutput.trim()) return fallback('Anti returned no live verification evidence.');

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawOutput.trim());
  } catch {
    const match = rawOutput.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (!match?.[1]) return fallback('Anti did not return a structured live verification report.');
    try {
      parsed = JSON.parse(match[1].trim());
    } catch {
      return fallback('Anti returned malformed live verification JSON.');
    }
  }

  if (!parsed || typeof parsed !== 'object')
    return fallback('Anti returned invalid live verification data.');
  const report = parsed as Record<string, unknown>;
  const status = typeof report.status === 'string' ? report.status.toUpperCase() : '';
  const command =
    typeof report.command === 'string' ? report.command.trim().slice(0, 500) : undefined;
  const url = typeof report.url === 'string' ? report.url.trim().slice(0, 500) : undefined;
  const checks = Array.isArray(report.checks)
    ? report.checks
        .map((item) => (typeof item === 'string' ? item.trim() : ''))
        .filter(Boolean)
        .slice(0, 20)
    : [];
  const summary =
    typeof report.summary === 'string' && report.summary.trim()
      ? report.summary.trim().slice(0, 2_000)
      : 'Anti did not provide a live verification summary.';
  const loopbackUrl = url && /^https?:\/\/(127\.0\.0\.1|localhost)(?::\d+)?(?:\/|$)/i.test(url);

  if (status === 'PASSED' && command && loopbackUrl && checks.length > 0) {
    return { status: 'PASSED', command, url, checks, summary, parsedCleanly: true, rawOutput };
  }
  if (status === 'FAILED') {
    return { status: 'FAILED', command, url, checks, summary, parsedCleanly: true, rawOutput };
  }
  return {
    status: 'UNAVAILABLE',
    command,
    url,
    checks,
    summary:
      status === 'PASSED'
        ? 'Anti claimed a pass without a localhost URL, launch command, or completed checks.'
        : summary,
    parsedCleanly: status === 'UNAVAILABLE',
    rawOutput,
  };
}

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

  buildLiveVerificationPrompt(checklist: string[]): string {
    return [
      '### Mandatory Live Verification Before Human PR Review',
      'Do not edit source files during this step. Inspect existing project scripts and documentation, then start the current application locally from this isolated worktree using its supported development command.',
      'Use only loopback networking (127.0.0.1 or localhost). Do not expose a LAN address, deploy anything, install dependencies, or access files outside this worktree.',
      'Wait for startup, perform the listed observable checks using available local tools, then stop any server you started before finishing.',
      '',
      '### Codex Review Checklist',
      ...checklist.map((item) => `- ${item}`),
      '',
      '### Required Response',
      'Respond with only this JSON object (or a fenced JSON object):',
      '{',
      '  "status": "PASSED" | "FAILED" | "UNAVAILABLE",',
      '  "command": "exact local development command used",',
      '  "url": "http://127.0.0.1:<port> or http://localhost:<port>",',
      '  "checks": ["each completed observable check"],',
      '  "summary": "what was observed, or why verification could not run"',
      '}',
      'Use PASSED only when a localhost development server was actually started and at least one checklist item was observed. Otherwise use FAILED or UNAVAILABLE.',
    ].join('\n');
  }

  /**
   * Validates explicit model option.
   * Model must be a non-empty string, cannot start with a hyphen/flag prefix, and must match allowed naming pattern.
   */
  validateModel(model: unknown): string {
    if (typeof model !== 'string' || !model.trim()) {
      throw new Error('Model must be a non-empty string.');
    }
    const trimmed = model.trim();
    if (trimmed.startsWith('-')) {
      throw new Error(`Invalid model "${trimmed}": flag prefixes are not allowed.`);
    }
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(trimmed)) {
      throw new Error(`Invalid model "${trimmed}": contains disallowed characters.`);
    }
    return trimmed;
  }

  /**
   * Parses a validated duration string into milliseconds.
   */
  parseDurationMs(durationStr: string): number {
    const trimmed = durationStr.trim();
    const match = /^(\d+)(ms|s|m|h)?$/i.exec(trimmed);
    if (!match) {
      throw new Error(`Invalid duration format "${trimmed}".`);
    }
    const val = parseInt(match[1], 10);
    const unit = (match[2] || 's').toLowerCase();
    if (unit === 'ms') return val;
    if (unit === 's') return val * 1000;
    if (unit === 'm') return val * 60 * 1000;
    if (unit === 'h') return val * 60 * 60 * 1000;
    return val * 1000;
  }

  /**
   * Validates bounded print timeout option.
   * Accepts explicit duration strings (e.g. "30s", "5m", "1800s", "1000ms").
   * Allowed bounds: minimum 1 second (1000ms), maximum 30 minutes (1800s / 1800000ms).
   */
  validatePrintTimeout(timeout: unknown): string {
    if (typeof timeout !== 'string') {
      throw new Error('Print timeout must be a duration string (e.g. "30s", "5m", "1800s").');
    }

    const trimmed = timeout.trim();
    if (!trimmed || trimmed.startsWith('-')) {
      throw new Error('Print timeout must be a valid duration string.');
    }
    const match = /^(\d+)(ms|s|m|h)?$/i.exec(trimmed);
    if (!match) {
      throw new Error(
        `Invalid print timeout format "${trimmed}". Expected duration such as "30s", "5m", "1800s".`
      );
    }
    const ms = this.parseDurationMs(trimmed);

    const MIN_MS = 1000;
    const MAX_MS = 30 * 60 * 1000;

    if (ms < MIN_MS) {
      throw new Error(
        `Print timeout "${trimmed}" (${ms}ms) is below the minimum allowed bound of 1s (1000ms).`
      );
    }
    if (ms > MAX_MS) {
      throw new Error(
        `Print timeout "${trimmed}" (${ms}ms) exceeds the maximum allowed bound of 30m (1800000ms).`
      );
    }
    return trimmed;
  }

  /**
   * Executes agy in sandboxed noninteractive mode inside the isolated external worktree.
   * Note: agy invocations are self-contained per iteration; no session daemon resume is promised.
   */
  async runAgy(options: AgyRunOptions): Promise<AgyExecutionResult> {
    const executor = options.executor || this.executor;

    this.validateWorktree(options.worktreePath, options.targetRepoPath);

    // Strict command invariant: uses argument array only, explicitly chooses --sandbox, safe --mode accept-edits, and --print
    const args: string[] = ['--sandbox', '--mode', 'accept-edits'];

    if (options.model !== undefined) {
      const model = this.validateModel(options.model);
      args.push('--model', model);
    }

    let printTimeoutMs = DEFAULT_AGY_PRINT_TIMEOUT_MS;
    if (options.printTimeout !== undefined) {
      const printTimeout = this.validatePrintTimeout(options.printTimeout);
      args.push('--print-timeout', printTimeout);
      printTimeoutMs = this.parseDurationMs(printTimeout);
    }

    args.push('--print', options.prompt);

    // Ensure child process timeout is safely consistent with print timeout plus fixed overhead
    const minRequiredProcessTimeout = printTimeoutMs + PROCESS_TIMEOUT_BUFFER_MS;
    const timeoutMs =
      options.timeoutMs !== undefined
        ? Math.max(options.timeoutMs, minRequiredProcessTimeout)
        : minRequiredProcessTimeout;

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

  /** Starts the changed application on localhost and records Anti's structured smoke-test evidence. */
  async runLiveVerification(
    worktreePath: string,
    checklist: string[],
    options: Partial<AgyRunOptions> = {}
  ): Promise<LiveVerificationResult> {
    const result = await this.runAgy({
      ...options,
      worktreePath,
      prompt: this.buildLiveVerificationPrompt(checklist),
    });
    if (!result.success) {
      return {
        status: 'FAILED',
        checks: [],
        summary: result.error || 'Anti failed to run live verification.',
        parsedCleanly: false,
        rawOutput: result.stdout || result.stderr,
      };
    }
    return parseLiveVerificationOutput(result.stdout);
  }
}
