import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

function isStrictChildPath(parentPath: string, candidatePath: string): boolean {
  const relative = path.relative(parentPath, candidatePath);
  return (
    relative.length > 0 &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function canonicalizeWithExistingAncestor(candidatePath: string): string {
  let current = candidatePath;
  const missingSegments: string[] = [];

  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return candidatePath;
    missingSegments.unshift(path.basename(current));
    current = parent;
  }

  return path.join(fs.realpathSync(current), ...missingSegments);
}

/**
 * Validates that a target repository path resides strictly inside a user-confirmed allowed base directory.
 */
export function validateTargetRepoPath(
  targetPath: string,
  allowedBaseDir: string
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

  if (!allowedBaseDir || typeof allowedBaseDir !== 'string' || !allowedBaseDir.trim()) {
    return {
      valid: false,
      resolvedPath: path.resolve(rawTrimmed),
      error: 'Allowed base directory is not configured. Confirm one before creating a task.',
    };
  }

  const resolvedAllowedBase = path.resolve(allowedBaseDir);
  const realAllowedBase = fs.existsSync(resolvedAllowedBase)
    ? fs.realpathSync(resolvedAllowedBase)
    : resolvedAllowedBase;

  const resolvedTarget = path.resolve(rawTrimmed);

  const canonicalTarget = canonicalizeWithExistingAncestor(resolvedTarget);
  if (canonicalTarget === realAllowedBase) {
    return {
      valid: false,
      resolvedPath: canonicalTarget,
      error: `Target path cannot be the root base directory itself (${realAllowedBase}). Must be a project subdirectory.`,
    };
  }
  if (!isStrictChildPath(realAllowedBase, canonicalTarget)) {
    return {
      valid: false,
      resolvedPath: resolvedTarget,
      error: `Access denied: Target repository (${canonicalTarget}) must reside strictly within ${realAllowedBase}.`,
    };
  }

  try {
    if (!fs.existsSync(resolvedTarget)) {
      return {
        valid: false,
        resolvedPath: resolvedTarget,
        error: `Target directory does not exist: ${resolvedTarget}`,
      };
    }

    const realTarget = fs.realpathSync(resolvedTarget);

    // Compare canonical paths rather than raw string prefixes. On macOS, /var commonly
    // resolves to /private/var; canonical containment both supports that alias and rejects
    // symlinks that escape the confirmed directory.
    if (!isStrictChildPath(realAllowedBase, realTarget)) {
      return {
        valid: false,
        resolvedPath: realTarget,
        error: `Access denied: Target repository (${realTarget}) must reside strictly within ${realAllowedBase}.`,
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

/**
 * Validates whether a file path is prohibited from being staged to git.
 * Enforces fail-closed protection against node_modules, secrets, tokens, state files, and build outputs.
 */
export function isProhibitedStagingPath(filePath: string): {
  prohibited: boolean;
  reason?: string;
} {
  if (!filePath || typeof filePath !== 'string') {
    return { prohibited: true, reason: 'Empty path' };
  }

  const normalized = filePath.trim().replace(/\\/g, '/');
  const baseName = path.basename(normalized).toLowerCase();

  // 1. Block node_modules anywhere in the tree
  if (
    normalized === 'node_modules' ||
    normalized.startsWith('node_modules/') ||
    normalized.includes('/node_modules/')
  ) {
    return { prohibited: true, reason: 'node_modules cannot be staged' };
  }

  // 2. Block environment / secret files (allow .env.example)
  if (baseName === '.env' || (baseName.startsWith('.env.') && baseName !== '.env.example')) {
    return { prohibited: true, reason: 'Environment and secret files cannot be staged' };
  }

  // 3. Block private keys, credentials, tokens
  if (
    baseName.includes('credential') ||
    baseName.includes('secret') ||
    baseName.startsWith('id_rsa') ||
    baseName.startsWith('id_ed25519') ||
    baseName.endsWith('.pem') ||
    baseName.endsWith('.pfx') ||
    baseName.endsWith('.p12') ||
    (baseName.endsWith('.key') && !baseName.endsWith('.d.ts'))
  ) {
    return { prohibited: true, reason: 'Credential/key files cannot be staged' };
  }

  // 4. Block orchestrator state paths
  if (
    normalized.includes('.codex-anti-orchestrator') ||
    normalized.includes('orchestrator-state') ||
    baseName === 'state.json'
  ) {
    return { prohibited: true, reason: 'Orchestrator state files cannot be staged' };
  }

  // 5. Block git internals
  if (normalized === '.git' || normalized.startsWith('.git/')) {
    return { prohibited: true, reason: 'Git internals cannot be staged' };
  }

  // 6. Block build artifacts
  if (
    normalized === 'dist' ||
    normalized.startsWith('dist/') ||
    normalized === 'coverage' ||
    normalized.startsWith('coverage/')
  ) {
    return { prohibited: true, reason: 'Build artifacts cannot be staged' };
  }

  // 7. Block temporary files and locks
  if (baseName.endsWith('.tmp') || baseName.endsWith('.swp') || baseName.endsWith('.bak')) {
    return { prohibited: true, reason: 'Temporary editor/system files cannot be staged' };
  }

  return { prohibited: false };
}
