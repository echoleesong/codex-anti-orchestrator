import { execFile } from 'node:child_process';
import type { CommandExecutor, ExecOutput, SafeExecOptions } from '../types.js';

export const FORBIDDEN_FLAGS: readonly string[] = ['--dangerously-skip-permissions'];

/**
 * Checks if argument list contains any forbidden flags.
 */
export function checkForbiddenFlags(
  args: string[],
  forbiddenFlags: readonly string[] = FORBIDDEN_FLAGS
): { forbidden: boolean; flag?: string } {
  for (const arg of args) {
    for (const forbidden of forbiddenFlags) {
      if (arg === forbidden || arg.startsWith(`${forbidden}=`)) {
        return { forbidden: true, flag: arg };
      }
    }
  }
  return { forbidden: false };
}

/**
 * Redacts sensitive tokens, credentials, and secrets from output strings.
 */
export function redactSecrets(text: string): string {
  if (!text || typeof text !== 'string') {
    return text || '';
  }

  let redacted = text;

  // 1. GitHub Personal Access Tokens and OAuth tokens
  redacted = redacted.replace(
    /\b(ghp_[a-zA-Z0-9]{36,}|gho_[a-zA-Z0-9]{36,}|ghu_[a-zA-Z0-9]{36,}|ghs_[a-zA-Z0-9]{36,}|ghr_[a-zA-Z0-9]{36,}|github_pat_[a-zA-Z0-9_]{22,})\b/g,
    '[REDACTED_GITHUB_TOKEN]'
  );

  // 2. Anthropic API Keys
  redacted = redacted.replace(/\b(sk-ant-[a-zA-Z0-9_-]{20,})\b/g, '[REDACTED_ANTHROPIC_KEY]');

  // 3. OpenAI API Keys
  redacted = redacted.replace(
    /\b(sk-(?!ant-)(?:proj-)?[a-zA-Z0-9_-]{20,})\b/g,
    '[REDACTED_OPENAI_KEY]'
  );

  // 4. HTTP Bearer Authorization headers / tokens
  redacted = redacted.replace(/(Bearer\s+)[a-zA-Z0-9_\-\.\~]{10,}/gi, '$1[REDACTED_BEARER_TOKEN]');

  // 5. Basic authentication in URLs: https://user:pass@host
  redacted = redacted.replace(
    /(https?:\/\/)([^:\/\s@]+):([^@\/\s]+)(@)/gi,
    '$1$2:[REDACTED_PASSWORD]$4'
  );

  // 6. Generic key-value secret assignments: api_key=..., token: ..., secret=..., password=...
  redacted = redacted.replace(
    /((?:api[_-]?key|access[_-]?token|auth[_-]?token|secret[_-]?key|password)\s*[:=]\s*["']?)[a-zA-Z0-9_\-\.]{8,}(["']?)/gi,
    '$1[REDACTED_SECRET]$2'
  );

  return redacted;
}

/**
 * Safely executes a child process without a shell, using strict argument arrays.
 * Enforces timeout, bounded stdout/stderr buffers, signal handling, and secret redaction.
 */
export async function safeExecute(
  file: string,
  args: string[],
  options: SafeExecOptions = {}
): Promise<ExecOutput> {
  const {
    cwd = process.cwd(),
    timeoutMs = 60000,
    maxBuffer = 10 * 1024 * 1024,
    env = process.env,
    rejectForbiddenFlags = true,
    forbiddenFlags = FORBIDDEN_FLAGS,
  } = options;

  // Enforce forbidden flags check before child process spawn
  if (rejectForbiddenFlags) {
    const check = checkForbiddenFlags(args, forbiddenFlags);
    if (check.forbidden) {
      const err = new Error(
        `Forbidden command flag detected: "${check.flag}". Execution halted for security.`
      );
      return {
        exitCode: 1,
        stdout: '',
        stderr: redactSecrets(err.message),
        error: err,
      };
    }
  }

  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer,
        env,
        shell: false, // Invariant: argument arrays only, never run in shell
      },
      (error, stdout, stderr) => {
        const rawStdout = stdout?.toString() || '';
        const rawStderr = stderr?.toString() || '';

        const sanitizedStdout = redactSecrets(rawStdout);
        const sanitizedStderr = redactSecrets(rawStderr);

        let exitCode = 0;
        let signal: NodeJS.Signals | string | null = null;
        let timedOut = false;

        if (error) {
          if (
            error.killed &&
            (error.signal === 'SIGTERM' || (error as { code?: string }).code === 'ETIMEDOUT')
          ) {
            timedOut = true;
          }
          signal = error.signal || null;
          exitCode = typeof error.code === 'number' ? error.code : 1;
        }

        resolve({
          exitCode,
          stdout: sanitizedStdout,
          stderr: sanitizedStderr,
          signal,
          timedOut,
          error: error || undefined,
        });
      }
    );
  });
}

/**
 * Default command executor implementing CommandExecutor interface.
 */
export const defaultExecutor: CommandExecutor = (file, args, options = {}) => {
  return safeExecute(file, args, options);
};
