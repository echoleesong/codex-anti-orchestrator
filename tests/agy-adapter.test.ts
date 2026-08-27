import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgyAdapter } from '../src/adapters/agy-adapter.js';
import type { CommandExecutor, ExecOutput } from '../src/types.js';

describe('Antigravity CLI (agy) Adapter', () => {
  let tempDir: string;
  let testRepoPath: string;
  let worktreePath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-adapter-test-'));
    testRepoPath = path.join(tempDir, 'repo');
    worktreePath = path.join(tempDir, 'state', 'worktrees', 'task-123');

    fs.mkdirSync(testRepoPath, { recursive: true });
    fs.mkdirSync(worktreePath, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should validate external worktree isolation and reject in-repo paths', () => {
    const adapter = new AgyAdapter();

    // Valid external worktree
    expect(() => {
      adapter.validateWorktree(worktreePath, testRepoPath);
    }).not.toThrow();

    // In-repo worktree attempt
    const inRepoWorktree = path.join(testRepoPath, 'sub-worktree');
    fs.mkdirSync(inRepoWorktree, { recursive: true });

    expect(() => {
      adapter.validateWorktree(inRepoWorktree, testRepoPath);
    }).toThrow(/Security violation: Worktree cannot reside within/);
  });

  it('should reject non-existent worktree directories', () => {
    const adapter = new AgyAdapter();
    const nonExistent = path.join(tempDir, 'does-not-exist');

    expect(() => {
      adapter.validateWorktree(nonExistent, testRepoPath);
    }).toThrow(/does not exist/);
  });

  it('should build structured development prompts', () => {
    const adapter = new AgyAdapter();
    const prompt = adapter.buildDevelopmentPrompt('Implement OAuth2 login');

    expect(prompt).toContain('### Task Instructions');
    expect(prompt).toContain('Implement OAuth2 login');
    expect(prompt).toContain('Development Guidelines');
    expect(prompt).toContain('unit test coverage');
  });

  it('should build structured fix prompts with blocking issues and test failures', () => {
    const adapter = new AgyAdapter();
    const fixPrompt = adapter.buildFixPrompt('Implement OAuth2 login', {
      blockingIssues: [
        'Null pointer exception in token validation',
        'Missing unit tests for refresh token',
      ],
      warnings: ['Optimize import statements'],
      testErrors: 'FAIL tests/auth.test.ts > should refresh token (expected 200, got 500)',
    });

    expect(fixPrompt).toContain('### Original Task Prompt');
    expect(fixPrompt).toContain('Implement OAuth2 login');
    expect(fixPrompt).toContain('### Fix Instructions (Code Review & Test Feedback)');
    expect(fixPrompt).toContain('[BLOCKER] Null pointer exception in token validation');
    expect(fixPrompt).toContain('[BLOCKER] Missing unit tests for refresh token');
    expect(fixPrompt).toContain('[WARN] Optimize import statements');
    expect(fixPrompt).toContain('FAIL tests/auth.test.ts');
  });

  it('should invoke agy with argument array, --sandbox flag, and isolated worktree cwd', async () => {
    const capturedCalls: Array<{
      file: string;
      args: string[];
      options?: Record<string, unknown>;
    }> = [];

    const mockExecutor: CommandExecutor = async (file, args, options) => {
      capturedCalls.push({ file, args, options });
      return {
        exitCode: 0,
        stdout: 'agy completed coding tasks successfully',
        stderr: '',
      };
    };

    const adapter = new AgyAdapter(mockExecutor);
    const result = await adapter.runDevelopment(worktreePath, 'Create user profile API', {
      targetRepoPath: testRepoPath,
    });

    expect(result.success).toBe(true);
    expect(result.stdout).toContain('agy completed coding tasks');
    expect(capturedCalls.length).toBe(1);

    const call = capturedCalls[0];
    expect(call.file).toBe('agy');
    expect(call.args[0]).toBe('--sandbox');
    expect(call.args[1]).toBe('--edit');
    expect(call.args[2]).toBe('-p');
    expect(call.options?.cwd).toBe(worktreePath);
    expect(call.args).not.toContain('--dangerously-skip-permissions');
  });

  it('should handle agy execution failures gracefully', async () => {
    const mockExecutor: CommandExecutor = async () => ({
      exitCode: 1,
      stdout: '',
      stderr: 'Agent syntax error in generated code',
    });

    const adapter = new AgyAdapter(mockExecutor);
    const result = await adapter.runDevelopment(worktreePath, 'Broken prompt', {
      targetRepoPath: testRepoPath,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Agent syntax error');
  });
});
