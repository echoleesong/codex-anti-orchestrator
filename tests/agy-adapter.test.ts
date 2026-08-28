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

  describe('Model validation', () => {
    const adapter = new AgyAdapter();

    it('should accept valid model identifiers', () => {
      expect(adapter.validateModel('gemini-2.5-pro')).toBe('gemini-2.5-pro');
      expect(adapter.validateModel('gpt-4o')).toBe('gpt-4o');
      expect(adapter.validateModel('claude-3-5-sonnet:20241022')).toBe(
        'claude-3-5-sonnet:20241022'
      );
      expect(adapter.validateModel('org/model_v1.0')).toBe('org/model_v1.0');
    });

    it('should reject non-string or empty model values', () => {
      expect(() => adapter.validateModel('')).toThrow(/Model must be a non-empty string/);
      expect(() => adapter.validateModel('   ')).toThrow(/Model must be a non-empty string/);
      expect(() => adapter.validateModel(null)).toThrow(/Model must be a non-empty string/);
      expect(() => adapter.validateModel(undefined)).toThrow(/Model must be a non-empty string/);
      expect(() => adapter.validateModel(123)).toThrow(/Model must be a non-empty string/);
    });

    it('should reject flag-prefixed model strings', () => {
      expect(() => adapter.validateModel('--dangerously-skip-permissions')).toThrow(
        /flag prefixes are not allowed/
      );
      expect(() => adapter.validateModel('-m')).toThrow(/flag prefixes are not allowed/);
    });

    it('should reject models with illegal characters', () => {
      expect(() => adapter.validateModel('model with spaces')).toThrow(
        /contains disallowed characters/
      );
      expect(() => adapter.validateModel('model;rm -rf /')).toThrow(
        /contains disallowed characters/
      );
      expect(() => adapter.validateModel('model`whoami`')).toThrow(
        /contains disallowed characters/
      );
    });
  });

  describe('Bounded print timeout validation', () => {
    const adapter = new AgyAdapter();

    it('should accept valid duration strings within 1s to 30m', () => {
      expect(adapter.validatePrintTimeout('1s')).toBe('1s');
      expect(adapter.validatePrintTimeout('30s')).toBe('30s');
      expect(adapter.validatePrintTimeout('300s')).toBe('300s');
      expect(adapter.validatePrintTimeout('5m')).toBe('5m');
      expect(adapter.validatePrintTimeout('30m')).toBe('30m');
      expect(adapter.validatePrintTimeout('1000ms')).toBe('1000ms');
      expect(adapter.validatePrintTimeout('1800s')).toBe('1800s');
      expect(adapter.validatePrintTimeout('1800000ms')).toBe('1800000ms');
    });

    it('should reject timeouts below minimum bound of 1s (1000ms)', () => {
      expect(() => adapter.validatePrintTimeout('500ms')).toThrow(
        /below the minimum allowed bound/
      );
      expect(() => adapter.validatePrintTimeout('0s')).toThrow(/below the minimum allowed bound/);
      expect(() => adapter.validatePrintTimeout('0m')).toThrow(/below the minimum allowed bound/);
    });

    it('should reject timeouts above maximum bound of 30m (1800s / 1800000ms)', () => {
      expect(() => adapter.validatePrintTimeout('1801s')).toThrow(
        /exceeds the maximum allowed bound/
      );
      expect(() => adapter.validatePrintTimeout('1800001ms')).toThrow(
        /exceeds the maximum allowed bound/
      );
      expect(() => adapter.validatePrintTimeout('31m')).toThrow(
        /exceeds the maximum allowed bound/
      );
      expect(() => adapter.validatePrintTimeout('1h')).toThrow(/exceeds the maximum allowed bound/);
      expect(() => adapter.validatePrintTimeout('2000s')).toThrow(
        /exceeds the maximum allowed bound/
      );
    });

    it('should reject invalid, flag-prefixed, or arbitrary timeout strings', () => {
      expect(() => adapter.validatePrintTimeout('')).toThrow(
        /Print timeout must be a valid duration string/
      );
      expect(() => adapter.validatePrintTimeout('   ')).toThrow(
        /Print timeout must be a valid duration string/
      );
      expect(() => adapter.validatePrintTimeout('--timeout=10')).toThrow(
        /Print timeout must be a valid duration string/
      );
      expect(() => adapter.validatePrintTimeout('-t')).toThrow(
        /Print timeout must be a valid duration string/
      );
      expect(() => adapter.validatePrintTimeout('infinite')).toThrow(
        /Invalid print timeout format/
      );
      expect(() => adapter.validatePrintTimeout('10xyz')).toThrow(/Invalid print timeout format/);
    });

    it('should reject non-string timeout values', () => {
      expect(() => adapter.validatePrintTimeout(300)).toThrow(
        /Print timeout must be a duration string/
      );
      expect(() => adapter.validatePrintTimeout(null)).toThrow(
        /Print timeout must be a duration string/
      );
      expect(() => adapter.validatePrintTimeout(undefined)).toThrow(
        /Print timeout must be a duration string/
      );
      expect(() => adapter.validatePrintTimeout({})).toThrow(
        /Print timeout must be a duration string/
      );
    });
  });

  it('should invoke agy with argument array, --sandbox, --mode accept-edits, and --print', async () => {
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
    expect(call.args[1]).toBe('--mode');
    expect(call.args[2]).toBe('accept-edits');
    expect(call.args[3]).toBe('--print');
    expect(call.args).not.toContain('--edit');
    expect(call.args).not.toContain('-p');
    expect(call.args).not.toContain('--dangerously-skip-permissions');
    expect(call.options?.cwd).toBe(worktreePath);
  });

  it('should support validated model and bounded print timeout options in agy args', async () => {
    const capturedCalls: Array<{
      file: string;
      args: string[];
      options?: Record<string, unknown>;
    }> = [];

    const mockExecutor: CommandExecutor = async (file, args, options) => {
      capturedCalls.push({ file, args, options });
      return {
        exitCode: 0,
        stdout: 'agy fix completed',
        stderr: '',
      };
    };

    const adapter = new AgyAdapter(mockExecutor);
    const result = await adapter.runFix(
      worktreePath,
      'Fix user profile API',
      { blockingIssues: ['Fix syntax error'] },
      {
        targetRepoPath: testRepoPath,
        model: 'gemini-2.5-pro',
        printTimeout: '5m',
      }
    );

    expect(result.success).toBe(true);
    expect(capturedCalls.length).toBe(1);

    const call = capturedCalls[0];
    expect(call.args).toEqual([
      '--sandbox',
      '--mode',
      'accept-edits',
      '--model',
      'gemini-2.5-pro',
      '--print-timeout',
      '5m',
      '--print',
      expect.stringContaining('### Original Task Prompt'),
    ]);
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
