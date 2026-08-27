import fs from 'node:fs';
import path from 'node:path';
import type { CommandExecutor } from '../types.js';
import { defaultExecutor } from '../utils/exec.js';

export interface CleanlinessResult {
  clean: boolean;
  uncommitted: string[];
  error?: string;
}

export interface LockfileResult {
  locked: boolean;
  lockPath?: string;
  details?: string;
  error?: string;
}

export interface WorktreeResult {
  success: boolean;
  worktreePath: string;
  branchName: string;
  error?: string;
}

/**
 * Checks if the git working tree is completely clean.
 */
export async function checkGitCleanliness(
  repoPath: string,
  executor: CommandExecutor = defaultExecutor
): Promise<CleanlinessResult> {
  const res = await executor('git', ['status', '--porcelain'], { cwd: repoPath });
  if (res.exitCode !== 0) {
    return {
      clean: false,
      uncommitted: [],
      error: `Failed to check repository status: ${res.stderr.trim() || 'git command failed'}`,
    };
  }

  const lines = res.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length > 0) {
    return {
      clean: false,
      uncommitted: lines,
    };
  }

  return {
    clean: true,
    uncommitted: [],
  };
}

/**
 * Inspects repository for any active Git lock files.
 * Strictly diagnostic: NEVER automatically deletes or alters lock files.
 * If lock check cannot be completed, returns an explicit error to halt task creation.
 */
export async function checkGitLockfile(
  repoPath: string,
  executor: CommandExecutor = defaultExecutor
): Promise<LockfileResult> {
  try {
    let gitDir = path.join(repoPath, '.git');

    // If .git is a file (e.g. in a worktree or submodule), or to be robust, resolve gitdir
    const gitDirRes = await executor('git', ['rev-parse', '--git-dir'], { cwd: repoPath });
    if (gitDirRes.exitCode !== 0) {
      return {
        locked: false,
        error: `Failed to resolve Git directory via 'git rev-parse --git-dir': ${gitDirRes.stderr.trim() || 'command failed'}`,
      };
    }

    if (gitDirRes.stdout.trim()) {
      gitDir = path.resolve(repoPath, gitDirRes.stdout.trim());
    }

    if (!fs.existsSync(gitDir)) {
      return {
        locked: false,
        error: `Git directory does not exist: ${gitDir}`,
      };
    }

    const commonLockFiles = [
      path.join(gitDir, 'index.lock'),
      path.join(gitDir, 'HEAD.lock'),
      path.join(gitDir, 'config.lock'),
      path.join(gitDir, 'packed-refs.lock'),
      path.join(gitDir, 'shallow.lock'),
    ];

    for (const lockFile of commonLockFiles) {
      if (fs.existsSync(lockFile)) {
        return {
          locked: true,
          lockPath: lockFile,
          details: `Git lockfile found: ${path.relative(repoPath, lockFile) || lockFile}. Git repository is currently busy or locked.`,
        };
      }
    }

    // Check refs/heads/ for lock files
    const refsHeads = path.join(gitDir, 'refs', 'heads');
    if (fs.existsSync(refsHeads)) {
      try {
        const entries = fs.readdirSync(refsHeads, { recursive: true });
        for (const entry of entries) {
          if (typeof entry === 'string' && entry.endsWith('.lock')) {
            const lockFile = path.join(refsHeads, entry);
            return {
              locked: true,
              lockPath: lockFile,
              details: `Git ref lockfile found: ${lockFile}.`,
            };
          }
        }
      } catch (err) {
        return {
          locked: false,
          error: `Failed to inspect refs directory for lockfiles: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    return { locked: false };
  } catch (err) {
    return {
      locked: false,
      error: `Lock check error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Verifies that the path is a valid git repository.
 */
export async function isGitRepository(
  repoPath: string,
  executor: CommandExecutor = defaultExecutor
): Promise<boolean> {
  const res = await executor('git', ['rev-parse', '--is-inside-work-tree'], { cwd: repoPath });
  return res.exitCode === 0 && res.stdout.trim() === 'true';
}

/**
 * Gets the current active branch of a repository.
 */
export async function getCurrentBranch(
  repoPath: string,
  executor: CommandExecutor = defaultExecutor
): Promise<string> {
  const res = await executor('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoPath });
  if (res.exitCode === 0 && res.stdout.trim()) {
    return res.stdout.trim();
  }
  return 'main';
}

/**
 * Creates an isolated external git worktree.
 */
export async function createWorktree(
  repoPath: string,
  worktreePath: string,
  branchName: string,
  baseBranch: string,
  executor: CommandExecutor = defaultExecutor
): Promise<WorktreeResult> {
  // Ensure parent directory of worktree exists
  const parentDir = path.dirname(worktreePath);
  fs.mkdirSync(parentDir, { recursive: true });

  const res = await executor(
    'git',
    ['worktree', 'add', '-b', branchName, worktreePath, baseBranch],
    {
      cwd: repoPath,
    }
  );

  if (res.exitCode !== 0) {
    return {
      success: false,
      worktreePath,
      branchName,
      error: `Failed to create git worktree: ${res.stderr.trim() || res.stdout.trim() || 'unknown git error'}`,
    };
  }

  return {
    success: true,
    worktreePath,
    branchName,
  };
}

/**
 * Removes an external git worktree.
 */
export async function removeWorktree(
  repoPath: string,
  worktreePath: string,
  executor: CommandExecutor = defaultExecutor
): Promise<{ success: boolean; error?: string }> {
  const res = await executor('git', ['worktree', 'remove', worktreePath, '--force'], {
    cwd: repoPath,
  });

  // Prune any disconnected worktree references
  await executor('git', ['worktree', 'prune'], { cwd: repoPath });

  if (res.exitCode !== 0) {
    return {
      success: false,
      error: res.stderr.trim() || 'Failed to remove worktree',
    };
  }

  return { success: true };
}
