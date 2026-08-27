import { describe, expect, it } from 'vitest';
import {
  assertAllowedPROperation,
  GitHubPRAdapter,
  PROTECTED_BRANCHES,
  validateSafeBranchForPush,
} from '../src/adapters/github-pr-adapter.js';
import type { CommandExecutor, ExecOutput } from '../src/types.js';

describe('GitHub PR Adapter & Safety Boundaries', () => {
  describe('validateSafeBranchForPush', () => {
    it('should strictly block pushes to protected branches', () => {
      for (const branch of PROTECTED_BRANCHES) {
        expect(() => {
          validateSafeBranchForPush(branch);
        }).toThrow(/Security violation: Direct pushes to protected branch/);
      }
    });

    it('should block non-anti branches from being pushed by orchestrator', () => {
      expect(() => {
        validateSafeBranchForPush('feature/new-button');
      }).toThrow(
        /Security violation: Orchestrator branches must follow the "anti\/<task-id>" naming convention/
      );

      expect(() => {
        validateSafeBranchForPush('hotfix/bug');
      }).toThrow(/Security violation/);
    });

    it('should allow valid anti/* task branches', () => {
      expect(() => {
        validateSafeBranchForPush('anti/task-12345-my-feature-abc123');
      }).not.toThrow();
    });
  });

  describe('assertAllowedPROperation', () => {
    it('should strictly block forbidden operations: merge, workflow, release, deploy', () => {
      expect(() => assertAllowedPROperation('merge')).toThrow(/Security violation/);
      expect(() => assertAllowedPROperation('auto-merge')).toThrow(/Security violation/);
      expect(() => assertAllowedPROperation('workflow-dispatch')).toThrow(/Security violation/);
      expect(() => assertAllowedPROperation('release')).toThrow(/Security violation/);
      expect(() => assertAllowedPROperation('deploy')).toThrow(/Security violation/);
    });

    it('should allow read and metadata operations: create, view, update, checks', () => {
      expect(() => assertAllowedPROperation('create')).not.toThrow();
      expect(() => assertAllowedPROperation('view')).not.toThrow();
      expect(() => assertAllowedPROperation('update')).not.toThrow();
      expect(() => assertAllowedPROperation('checks')).not.toThrow();
    });
  });

  describe('GitHubPRAdapter operations', () => {
    it('should push task branch safely with argument arrays', async () => {
      const calls: string[][] = [];
      const mockExecutor: CommandExecutor = async (file, args) => {
        calls.push([file, ...args]);
        return { exitCode: 0, stdout: 'Branch pushed', stderr: '' };
      };

      const adapter = new GitHubPRAdapter(mockExecutor);
      const res = await adapter.pushTaskBranch('/fake/worktree', 'anti/task-100-feat');

      expect(res.success).toBe(true);
      expect(calls.length).toBe(1);
      expect(calls[0]).toEqual(['git', 'push', '--set-upstream', 'origin', 'anti/task-100-feat']);
    });

    it('should create PR via gh pr create with title and body', async () => {
      const calls: string[][] = [];
      const mockExecutor: CommandExecutor = async (file, args) => {
        calls.push([file, ...args]);
        return {
          exitCode: 0,
          stdout: 'https://github.com/echoleesong/codex-anti-orchestrator/pull/42\n',
          stderr: '',
        };
      };

      const adapter = new GitHubPRAdapter(mockExecutor);
      const res = await adapter.createPR({
        worktreePath: '/fake/worktree',
        branch: 'anti/task-100-feat',
        baseBranch: 'main',
        title: 'feat: add user profile API',
        body: 'Automated PR description',
      });

      expect(res.success).toBe(true);
      expect(res.prUrl).toBe('https://github.com/echoleesong/codex-anti-orchestrator/pull/42');
      expect(res.prNumber).toBe(42);
      expect(calls[0]).toEqual([
        'gh',
        'pr',
        'create',
        '--head',
        'anti/task-100-feat',
        '--base',
        'main',
        '--title',
        'feat: add user profile API',
        '--body',
        'Automated PR description',
      ]);
    });

    it('should view PR metadata via gh pr view', async () => {
      const mockExecutor: CommandExecutor = async () => ({
        exitCode: 0,
        stdout: JSON.stringify({
          number: 42,
          title: 'feat: add user profile API',
          body: 'PR Body',
          state: 'OPEN',
          url: 'https://github.com/echoleesong/codex-anti-orchestrator/pull/42',
        }),
        stderr: '',
      });

      const adapter = new GitHubPRAdapter(mockExecutor);
      const res = await adapter.viewPR({
        worktreePath: '/fake/worktree',
        prNumberOrBranch: '42',
      });

      expect(res.success).toBe(true);
      expect(res.prNumber).toBe(42);
      expect(res.state).toBe('OPEN');
    });

    it('should update PR metadata and post comments via gh pr edit and gh pr comment', async () => {
      const calls: string[][] = [];
      const mockExecutor: CommandExecutor = async (file, args) => {
        calls.push([file, ...args]);
        return { exitCode: 0, stdout: '', stderr: '' };
      };

      const adapter = new GitHubPRAdapter(mockExecutor);
      const res = await adapter.updatePR({
        worktreePath: '/fake/worktree',
        prNumberOrBranch: 'anti/task-100-feat',
        title: 'feat: updated title',
        comment: 'Fix iteration 2 applied.',
      });

      expect(res.success).toBe(true);
      expect(calls.length).toBe(2);
      expect(calls[0]).toEqual([
        'gh',
        'pr',
        'edit',
        'anti/task-100-feat',
        '--title',
        'feat: updated title',
      ]);
      expect(calls[1]).toEqual([
        'gh',
        'pr',
        'comment',
        'anti/task-100-feat',
        '--body',
        'Fix iteration 2 applied.',
      ]);
    });

    it('should parse PR checks status accurately when all pass', async () => {
      const mockExecutor: CommandExecutor = async () => ({
        exitCode: 0,
        stdout: JSON.stringify([
          { name: 'build', status: 'completed', conclusion: 'success' },
          { name: 'test', status: 'completed', conclusion: 'success' },
        ]),
        stderr: '',
      });

      const adapter = new GitHubPRAdapter(mockExecutor);
      const checks = await adapter.getPRChecks('/fake/worktree', 'anti/task-100');

      expect(checks.success).toBe(true);
      expect(checks.allPassing).toBe(true);
      expect(checks.checks.length).toBe(2);
    });

    it('should fail closed (success: false, allPassing: false) when JSON parsing fails', async () => {
      const mockExecutor: CommandExecutor = async () => ({
        exitCode: 0,
        stdout: 'not-valid-json-output',
        stderr: '',
      });

      const adapter = new GitHubPRAdapter(mockExecutor);
      const checks = await adapter.getPRChecks('/fake/worktree', 'anti/task-100');

      expect(checks.success).toBe(false);
      expect(checks.allPassing).toBe(false);
      expect(checks.error).toContain('Failed to parse PR checks JSON');
    });

    it('should fail closed when output is empty', async () => {
      const mockExecutor: CommandExecutor = async () => ({
        exitCode: 0,
        stdout: '   \n   ',
        stderr: '',
      });

      const adapter = new GitHubPRAdapter(mockExecutor);
      const checks = await adapter.getPRChecks('/fake/worktree', 'anti/task-100');

      expect(checks.success).toBe(false);
      expect(checks.allPassing).toBe(false);
      expect(checks.error).toContain('No check output returned');
    });

    it('should detect failing checks correctly', async () => {
      const mockExecutor: CommandExecutor = async () => ({
        exitCode: 0,
        stdout: JSON.stringify([
          { name: 'build', status: 'completed', conclusion: 'success' },
          { name: 'test', status: 'completed', conclusion: 'failure' },
        ]),
        stderr: '',
      });

      const adapter = new GitHubPRAdapter(mockExecutor);
      const checks = await adapter.getPRChecks('/fake/worktree', 'anti/task-100');

      expect(checks.success).toBe(true);
      expect(checks.allPassing).toBe(false);
    });
  });
});
