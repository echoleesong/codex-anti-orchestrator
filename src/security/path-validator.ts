import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_ALLOWED_BASE_DIR = '/Users/lisong/code';

export function getDefaultStateDir(): string {
  if (process.env.CODEX_ORCHESTRATOR_STATE_DIR) {
    return path.resolve(process.env.CODEX_ORCHESTRATOR_STATE_DIR);
  }
  return path.join(os.homedir(), '.codex-anti-orchestrator');
}

export interface PathValidationResult {
  valid: boolean;
  resolvedPath: string;
  error?: string;
}

/**
 * Validates that a target repository path resides strictly inside the allowed base directory (/Users/lisong/code).
 * Production enforces /Users/lisong/code; testing environments can pass explicit allowedBaseDir parameter.
 */
export function validateTargetRepoPath(
  targetPath: string,
  allowedBaseDir: string = DEFAULT_ALLOWED_BASE_DIR
): PathValidationResult {
  if (!targetPath || typeof targetPath !== 'string') {
    return {
      valid: false,
      resolvedPath: '',
      error: 'Target repository path must be a non-empty string.',
    };
  }

  const rawTrimmed = targetPath.trim();
  if (!rawTrimmed) {
    return {
      valid: false,
      resolvedPath: '',
      error: 'Target repository path cannot be empty.',
    };
  }

  const resolvedAllowedBase = path.resolve(allowedBaseDir);
  const realAllowedBase = fs.existsSync(resolvedAllowedBase)
    ? fs.realpathSync(resolvedAllowedBase)
    : resolvedAllowedBase;

  const resolvedTarget = path.resolve(rawTrimmed);

  // Reject paths equal to the allowed base directory itself
  if (
    resolvedTarget === resolvedAllowedBase ||
    (fs.existsSync(resolvedTarget) && fs.realpathSync(resolvedTarget) === realAllowedBase)
  ) {
    return {
      valid: false,
      resolvedPath: resolvedTarget,
      error: `Target path cannot be the root base directory itself (${resolvedAllowedBase}). Must be a project subdirectory.`,
    };
  }

  // Pre-check lexical path containment
  const lexicalPrefix = resolvedAllowedBase.endsWith(path.sep)
    ? resolvedAllowedBase
    : `${resolvedAllowedBase}${path.sep}`;

  if (!resolvedTarget.startsWith(lexicalPrefix)) {
    return {
      valid: false,
      resolvedPath: resolvedTarget,
      error: `Access denied: Target repository (${resolvedTarget}) must reside strictly within ${resolvedAllowedBase}.`,
    };
  }

  // Verify existence and directory type
  try {
    if (!fs.existsSync(resolvedTarget)) {
      return {
        valid: false,
        resolvedPath: resolvedTarget,
        error: `Target directory does not exist: ${resolvedTarget}`,
      };
    }

    const realTarget = fs.realpathSync(resolvedTarget);

    const realPrefix = realAllowedBase.endsWith(path.sep)
      ? realAllowedBase
      : `${realAllowedBase}${path.sep}`;

    if (!realTarget.startsWith(realPrefix)) {
      return {
        valid: false,
        resolvedPath: realTarget,
        error: `Symlink escape detected: real path (${realTarget}) is outside ${realAllowedBase}.`,
      };
    }

    const stat = fs.statSync(realTarget);
    if (!stat.isDirectory()) {
      return {
        valid: false,
        resolvedPath: realTarget,
        error: `Target path is not a directory: ${realTarget}`,
      };
    }

    return {
      valid: true,
      resolvedPath: realTarget,
    };
  } catch (err) {
    return {
      valid: false,
      resolvedPath: resolvedTarget,
      error: `Path resolution error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Validates that the state directory resides strictly outside the target repository.
 * Prevents in-repo workspace pollution and symlink escapes.
 */
export function validateStateDirIsolation(
  stateDir: string,
  targetRepoPath: string
): PathValidationResult {
  if (!stateDir || typeof stateDir !== 'string') {
    return {
      valid: false,
      resolvedPath: '',
      error: 'State directory path must be a non-empty string.',
    };
  }

  const resolvedState = path.resolve(stateDir);
  const resolvedTarget = path.resolve(targetRepoPath);

  // Resolve realpaths where possible
  let realTarget = resolvedTarget;
  try {
    if (fs.existsSync(resolvedTarget)) {
      realTarget = fs.realpathSync(resolvedTarget);
    }
  } catch {
    // Keep resolvedTarget if realpath resolution fails
  }

  // If state dir exists, resolve realpath; otherwise resolve parent realpath
  let realState = resolvedState;
  try {
    if (fs.existsSync(resolvedState)) {
      realState = fs.realpathSync(resolvedState);
    } else {
      let cur = path.dirname(resolvedState);
      while (cur !== path.dirname(cur) && !fs.existsSync(cur)) {
        cur = path.dirname(cur);
      }
      if (fs.existsSync(cur)) {
        const realParent = fs.realpathSync(cur);
        const rel = path.relative(cur, resolvedState);
        realState = path.resolve(realParent, rel);
      }
    }
  } catch {
    // Keep resolvedState if resolution fails
  }

  // Check 1: State directory cannot be equal to target repository
  if (realState === realTarget || resolvedState === resolvedTarget) {
    return {
      valid: false,
      resolvedPath: realState,
      error: `State directory (${realState}) cannot be the target repository directory (${realTarget}).`,
    };
  }

  // Check 2: State directory cannot be inside target repository
  const targetPrefix = realTarget.endsWith(path.sep) ? realTarget : `${realTarget}${path.sep}`;
  if (realState.startsWith(targetPrefix) || resolvedState.startsWith(targetPrefix)) {
    return {
      valid: false,
      resolvedPath: realState,
      error: `State directory (${realState}) cannot be located inside target repository (${realTarget}).`,
    };
  }

  // Check 3: Target repository cannot be inside state directory
  const statePrefix = realState.endsWith(path.sep) ? realState : `${realState}${path.sep}`;
  if (realTarget.startsWith(statePrefix) || resolvedTarget.startsWith(statePrefix)) {
    return {
      valid: false,
      resolvedPath: realState,
      error: `Target repository (${realTarget}) cannot be located inside state directory (${realState}).`,
    };
  }

  return {
    valid: true,
    resolvedPath: realState,
  };
}

/**
 * Sanitizes and generates a safe, deterministic task identifier without raw user input interpolation.
 * Format: task-<timestamp>-<safeSlug>-<randomHex>
 */
export function generateSafeTaskId(hint?: string): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const randomSuffix = crypto.randomBytes(3).toString('hex');

  let safeSlug = 'task';
  if (hint && typeof hint === 'string') {
    const cleaned = hint
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 15);
    if (cleaned.length > 0) {
      safeSlug = cleaned;
    }
  }

  return `task-${timestamp}-${safeSlug}-${randomSuffix}`;
}

/**
 * Derives a standardized, safe branch name from a validated task ID.
 */
export function getTaskBranchName(taskId: string): string {
  const sanitizedId = taskId.replace(/[^a-zA-Z0-9-_]/g, '');
  return `anti/${sanitizedId}`;
}

/**
 * Returns the isolated external worktree path inside the orchestrator state directory.
 */
export function getTaskWorktreePath(stateDir: string, taskId: string): string {
  const sanitizedId = taskId.replace(/[^a-zA-Z0-9-_]/g, '');
  return path.join(path.resolve(stateDir), 'worktrees', sanitizedId);
}

/**
 * Returns the path to the task's state.json file in the orchestrator state directory.
 */
export function getTaskStateFilePath(stateDir: string, taskId: string): string {
  const sanitizedId = taskId.replace(/[^a-zA-Z0-9-_]/g, '');
  return path.join(path.resolve(stateDir), 'tasks', sanitizedId, 'state.json');
}

/**
 * Returns the task storage directory.
 */
export function getTaskDir(stateDir: string, taskId: string): string {
  const sanitizedId = taskId.replace(/[^a-zA-Z0-9-_]/g, '');
  return path.join(path.resolve(stateDir), 'tasks', sanitizedId);
}
