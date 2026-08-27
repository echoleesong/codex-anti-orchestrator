import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  generateSafeTaskId,
  getTaskBranchName,
  getTaskWorktreePath,
  isProhibitedStagingPath,
  validateStateDirIsolation,
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

  describe('validateStateDirIsolation', () => {
    it('should allow stateDir outside target repository', () => {
      const repoDir = path.join(tempBaseDir, 'repo');
      const stateDir = path.join(tempBaseDir, 'state');
      fs.mkdirSync(repoDir, { recursive: true });
      fs.mkdirSync(stateDir, { recursive: true });

      const res = validateStateDirIsolation(stateDir, repoDir);
      expect(res.valid).toBe(true);
    });

    it('should reject stateDir located inside target repository', () => {
      const repoDir = path.join(tempBaseDir, 'repo');
      const inRepoStateDir = path.join(repoDir, '.orchestrator-state');
      fs.mkdirSync(inRepoStateDir, { recursive: true });

      const res = validateStateDirIsolation(inRepoStateDir, repoDir);
      expect(res.valid).toBe(false);
      expect(res.error).toContain('cannot be located inside target repository');
    });

    it('should reject stateDir equal to target repository', () => {
      const repoDir = path.join(tempBaseDir, 'repo');
      fs.mkdirSync(repoDir, { recursive: true });

      const res = validateStateDirIsolation(repoDir, repoDir);
      expect(res.valid).toBe(false);
      expect(res.error).toContain('cannot be the target repository directory');
    });

    it('should reject target repository located inside stateDir', () => {
      const stateDir = path.join(tempBaseDir, 'state');
      const insideRepo = path.join(stateDir, 'repo');
      fs.mkdirSync(insideRepo, { recursive: true });

      const res = validateStateDirIsolation(stateDir, insideRepo);
      expect(res.valid).toBe(false);
      expect(res.error).toContain('cannot be located inside state directory');
    });
  });

  describe('isProhibitedStagingPath', () => {
    it('should reject prohibited paths: node_modules, secrets, env, and orchestrator state', () => {
      expect(isProhibitedStagingPath('node_modules').prohibited).toBe(true);
      expect(isProhibitedStagingPath('node_modules/pkg/index.js').prohibited).toBe(true);
      expect(isProhibitedStagingPath('.env').prohibited).toBe(true);
      expect(isProhibitedStagingPath('.env.production').prohibited).toBe(true);
      expect(isProhibitedStagingPath('credentials.json').prohibited).toBe(true);
      expect(isProhibitedStagingPath('id_rsa').prohibited).toBe(true);
      expect(isProhibitedStagingPath('id_ed25519').prohibited).toBe(true);
      expect(isProhibitedStagingPath('server.key').prohibited).toBe(true);
      expect(isProhibitedStagingPath('cert.pem').prohibited).toBe(true);
      expect(isProhibitedStagingPath('state.json').prohibited).toBe(true);
      expect(isProhibitedStagingPath('.codex-anti-orchestrator/state.json').prohibited).toBe(true);
      expect(isProhibitedStagingPath('.git/index').prohibited).toBe(true);
      expect(isProhibitedStagingPath('dist/bundle.js').prohibited).toBe(true);
      expect(isProhibitedStagingPath('coverage/lcov.info').prohibited).toBe(true);
    });

    it('should allow legitimate project source and config files', () => {
      expect(isProhibitedStagingPath('src/index.ts').prohibited).toBe(false);
      expect(isProhibitedStagingPath('tests/app.test.ts').prohibited).toBe(false);
      expect(isProhibitedStagingPath('README.md').prohibited).toBe(false);
      expect(isProhibitedStagingPath('package.json').prohibited).toBe(false);
      expect(isProhibitedStagingPath('.gitignore').prohibited).toBe(false);
      expect(isProhibitedStagingPath('.env.example').prohibited).toBe(false);
    });
  });
});
