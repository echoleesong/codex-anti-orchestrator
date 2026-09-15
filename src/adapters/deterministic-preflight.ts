import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { CommandExecutor } from '../types.js';

const PREFLIGHT_SCRIPTS = ['format:check', 'typecheck', 'lint', 'test', 'build'] as const;
const MAX_ERROR_DETAIL = 2_000;

export interface DeterministicPreflightResult {
  pass: boolean;
  checks: string[];
  errors: string[];
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function commandFailureDetail(
  command: string,
  result: Awaited<ReturnType<CommandExecutor>>
): string {
  const detail =
    result.stderr.trim() || result.stdout.trim() || result.error?.message || 'command failed';
  const reason = result.timedOut ? 'timed out' : `exit ${result.exitCode}`;
  return `${command} failed (${reason}): ${detail.slice(0, MAX_ERROR_DETAIL)}`;
}

/**
 * Runs deterministic, non-model gates before Codex is allowed to spend review quota.
 * Only a fixed allowlist of conventional package scripts is executed.
 */
export async function runDeterministicPreflight(
  worktreePath: string,
  executor: CommandExecutor,
  scope: { baseSha?: string; headSha?: string } = {}
): Promise<DeterministicPreflightResult> {
  const checks: string[] = [];
  const errors: string[] = [];

  if (scope.baseSha && scope.headSha) {
    const diffScope = `${scope.baseSha}...${scope.headSha}`;
    const diffCheck = await executor('git', ['diff', '--check', diffScope], {
      cwd: worktreePath,
    });
    if (diffCheck.exitCode === 0 && !diffCheck.error && !diffCheck.timedOut) {
      checks.push(`git diff --check ${diffScope}: PASS`);
    } else {
      const command = `git diff --check ${diffScope}`;
      checks.push(`${command}: FAIL`);
      errors.push(commandFailureDetail(command, diffCheck));
    }
  }

  let packageJson: { scripts?: Record<string, unknown> } | undefined;
  try {
    packageJson = JSON.parse(
      await readFile(path.join(worktreePath, 'package.json'), 'utf8')
    ) as { scripts?: Record<string, unknown> };
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return { pass: errors.length === 0, checks, errors };
    }
    errors.push(`package.json preflight failed: ${error instanceof Error ? error.message : String(error)}`);
    checks.push('package.json parse/read: FAIL');
    return { pass: false, checks, errors };
  }

  const scripts = packageJson.scripts || {};
  for (const scriptName of PREFLIGHT_SCRIPTS) {
    if (typeof scripts[scriptName] !== 'string') continue;

    const command = `npm run ${scriptName}`;
    const result = await executor('npm', ['run', scriptName], { cwd: worktreePath });
    if (result.exitCode === 0 && !result.error && !result.timedOut) {
      checks.push(`${command}: PASS`);
    } else {
      checks.push(`${command}: FAIL`);
      errors.push(commandFailureDetail(command, result));
    }
  }

  return { pass: errors.length === 0, checks, errors };
}
