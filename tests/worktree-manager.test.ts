import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkGitCleanliness,
  checkGitLockfile,
  createWorktree,
  getCurrentBranch,
  isGitRepository,
  removeWorktree,
} from '../src/git/git-utils.js';

describe('Git Worktree & Cleanliness Management', () => {
  let tempDir: string;
  let testRepoPath: string;
  let tempStateDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-test-root-'));
    testRepoPath = path.join(tempDir, 'sample-repo');
    tempStateDir = path.join(tempDir, 'state-dir');

    fs.mkdirSync(testRepoPath, { recursive: true });
    fs.mkdirSync(tempStateDir, { recursive: true });

    // Initialize sample git repository
    execFileSync('git', ['init', '-b', 'main'], { cwd: testRepoPath });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: testRepoPath });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: testRepoPath });

    fs.writeFileSync(path.join(testRepoPath, 'README.md'), '# Sample Repo\n');
    execFileSync('git', ['add', 'README.md'], { cwd: testRepoPath });
    execFileSync('git', ['commit', '-m', 'initial commit'], { cwd: testRepoPath });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should verify git repository status correctly', async () => {
    expect(await isGitRepository(testRepoPath)).toBe(true);
    expect(await isGitRepository(tempStateDir)).toBe(false);
    expect(await getCurrentBranch(testRepoPath)).toBe('main');
  });

  it('should detect clean repository vs uncommitted changes', async () => {
    const cleanRes = await checkGitCleanliness(testRepoPath);
    expect(cleanRes.clean).toBe(true);
    expect(cleanRes.uncommitted.length).toBe(0);

    // Create untracked file
    fs.writeFileSync(path.join(testRepoPath, 'untracked.txt'), 'hello\n');
    const dirtyRes1 = await checkGitCleanliness(testRepoPath);
    expect(dirtyRes1.clean).toBe(false);
    expect(dirtyRes1.uncommitted.length).toBe(1);

    // Stage file
    execFileSync('git', ['add', 'untracked.txt'], { cwd: testRepoPath });
    const dirtyRes2 = await checkGitCleanliness(testRepoPath);
    expect(dirtyRes2.clean).toBe(false);
  });

  it('should detect Git lockfiles and NEVER auto-delete them', async () => {
    const gitDir = path.join(testRepoPath, '.git');
    const lockFile = path.join(gitDir, 'index.lock');

    fs.writeFileSync(lockFile, 'lock-content');

    const lockRes = await checkGitLockfile(testRepoPath);
    expect(lockRes.locked).toBe(true);
    expect(lockRes.lockPath).toBe(lockFile);

    // Invariant verification: lockfile must NOT be deleted
    expect(fs.existsSync(lockFile)).toBe(true);
  });

  it('should create an isolated external worktree in state directory outside repo', async () => {
    const taskId = 'task-test-01';
    const branchName = 'anti/task-test-01';
    const worktreePath = path.join(tempStateDir, 'worktrees', taskId);

    const result = await createWorktree(testRepoPath, worktreePath, branchName, 'main');
    expect(result.success).toBe(true);
    expect(fs.existsSync(worktreePath)).toBe(true);
    expect(fs.existsSync(path.join(worktreePath, 'README.md'))).toBe(true);

    // Verify worktree is located outside the target repo directory
    expect(worktreePath.startsWith(testRepoPath)).toBe(false);

    // Verify active branch in worktree
    const worktreeBranch = await getCurrentBranch(worktreePath);
    expect(worktreeBranch).toBe(branchName);

    // Remove worktree
    const removeRes = await removeWorktree(testRepoPath, worktreePath);
    expect(removeRes.success).toBe(true);
    expect(fs.existsSync(worktreePath)).toBe(false);
  });
});
