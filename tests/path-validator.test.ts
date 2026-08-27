import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  generateSafeTaskId,
  getTaskBranchName,
  getTaskWorktreePath,
  validateTargetRepoPath,
} from '../src/security/path-validator.js';

describe('Path and Security Validation', () => {
  let tempBaseDir: string;

  beforeEach(() => {
    tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestrator-test-base-'));
  });

  afterEach(() => {
    fs.rmSync(tempBaseDir, { recursive: true, force: true });
  });

  it('should allow valid project subdirectories inside allowedBaseDir', () => {
    const projectDir = path.join(tempBaseDir, 'my-project');
    fs.mkdirSync(projectDir, { recursive: true });

    const res = validateTargetRepoPath(projectDir, tempBaseDir);
    expect(res.valid).toBe(true);
    expect(res.resolvedPath).toBe(fs.realpathSync(projectDir));
  });

  it('should reject the root base directory itself', () => {
    const res = validateTargetRepoPath(tempBaseDir, tempBaseDir);
    expect(res.valid).toBe(false);
    expect(res.error).toContain('cannot be the root base directory itself');
  });

  it('should reject paths outside allowedBaseDir', () => {
    const outsideDir = os.tmpdir();
    const res = validateTargetRepoPath(outsideDir, tempBaseDir);
    expect(res.valid).toBe(false);
    expect(res.error).toContain('Access denied');
  });

  it('should reject directory traversal attempts escaping allowedBaseDir', () => {
    const traversalPath = path.join(tempBaseDir, '../other-secret-folder');
    const res = validateTargetRepoPath(traversalPath, tempBaseDir);
    expect(res.valid).toBe(false);
    expect(res.error).toContain('Access denied');
  });

  it('should reject non-existent directories', () => {
    const nonExistent = path.join(tempBaseDir, 'does-not-exist');
    const res = validateTargetRepoPath(nonExistent, tempBaseDir);
    expect(res.valid).toBe(false);
    expect(res.error).toContain('does not exist');
  });

  it('should generate sanitized task IDs without raw string interpolation', () => {
    const unsafePrompt = 'rm -rf /; echo "hello"; && $(touch /tmp/bad)';
    const taskId = generateSafeTaskId(unsafePrompt);

    expect(taskId).toMatch(/^task-\d+-rm-rf-echo-hell-[a-f0-9]{6}$/);
    expect(taskId).not.toContain(';');
    expect(taskId).not.toContain('&');
    expect(taskId).not.toContain('$');
    expect(taskId).not.toContain('/');
  });

  it('should derive safe branch names and isolated worktree paths', () => {
    const taskId = 'task-1740643200-feature-abc123';
    const stateDir = '/custom/state/dir';

    const branch = getTaskBranchName(taskId);
    expect(branch).toBe('anti/task-1740643200-feature-abc123');

    const worktreePath = getTaskWorktreePath(stateDir, taskId);
    expect(worktreePath).toBe('/custom/state/dir/worktrees/task-1740643200-feature-abc123');
  });
});
