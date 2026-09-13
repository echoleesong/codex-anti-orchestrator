import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import { sanitizePromptAuditText } from '../src/security/prompt-sanitizer.js';
import { loadTaskState, saveTaskState } from '../src/state/state-machine.js';
import type { CommandExecutor, TaskRecord } from '../src/types.js';

describe('Prompt Audit Sanitization & Persistence', () => {
  describe('sanitizePromptAuditText', () => {
    it('redacts sensitive tokens, credentials, and API keys', () => {
      const raw = [
        'GitHub PAT: ghp_123456789012345678901234567890123456',
        'OpenAI: sk-proj-abcdef12345678901234567890',
        'Anthropic: sk-ant-api03-abcdef12345678901234567890',
        'Header: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abcdef',
        'URL: https://admin:superSecretPassword123@github.com/org/repo.git',
      ].join('\n');

      const sanitized = sanitizePromptAuditText(raw);
      expect(sanitized).toContain('[REDACTED_GITHUB_TOKEN]');
      expect(sanitized).toContain('[REDACTED_OPENAI_KEY]');
      expect(sanitized).toContain('[REDACTED_ANTHROPIC_KEY]');
      expect(sanitized).toContain('[REDACTED_BEARER_TOKEN]');
      expect(sanitized).toContain('[REDACTED_PASSWORD]');
      expect(sanitized).not.toContain('ghp_123456789012345678901234567890123456');
      expect(sanitized).not.toContain('superSecretPassword123');
    });

    it('suppresses absolute filesystem paths across platforms', () => {
      const worktreePath = '/Users/alice/projects/.orchestrator/worktrees/task-123';
      const targetRepoPath = '/Users/alice/projects/my-app';
      const stateDir = '/Users/alice/.orchestrator';

      const raw = [
        `Target repo: ${targetRepoPath}`,
        `Worktree: ${worktreePath}`,
        `State: ${stateDir}`,
        'System log at /var/log/system.log and /tmp/scratch.txt',
        'Unix path: /Users/alice/secret/file.txt',
        'Windows path: C:\\Users\\Alice\\secret\\file.txt',
      ].join('\n');

      const sanitized = sanitizePromptAuditText(raw, {
        worktreePath,
        targetRepoPath,
        stateDir,
      });

      expect(sanitized).not.toContain(worktreePath);
      expect(sanitized).not.toContain(targetRepoPath);
      expect(sanitized).not.toContain(stateDir);
      expect(sanitized).not.toContain('/Users/alice/secret/file.txt');
      expect(sanitized).not.toContain('C:\\Users\\Alice\\secret\\file.txt');
      expect(sanitized).toContain('[WORKTREE]');
      expect(sanitized).toContain('[REPO]');
      expect(sanitized).toContain('[STATE_DIR]');
      expect(sanitized).toContain('[PATH]');
    });

    it('redacts environment variable assignments and process.env values', () => {
      const raw = [
        'export GITHUB_TOKEN=ghp_secrettoken12345678901234567890',
        'SECRET_KEY="production-secret-99887766"',
        'DATABASE_URL=postgres://user:pass@localhost:5432/app',
      ].join('\n');

      const sanitized = sanitizePromptAuditText(raw);
      expect(sanitized).toContain('GITHUB_TOKEN=[REDACTED_ENV]');
      expect(sanitized).toContain('SECRET_KEY=[REDACTED_ENV]');
      expect(sanitized).not.toContain('production-secret-99887766');
    });

    it('bounds maximum character length with truncation indicator', () => {
      const longText = 'A'.repeat(500);
      const sanitized = sanitizePromptAuditText(longText, { maxLength: 100 });
      expect(sanitized.length).toBeLessThan(150);
      expect(sanitized).toContain('... [TRUNCATED]');
    });
  });

  describe('Orchestrator Prompt Audit Recording & Interruption Persistence', () => {
    let tempDir: string;
    let tempStateDir: string;
    let testRepoPath: string;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-audit-test-'));
      tempStateDir = path.join(tempDir, 'state');
      testRepoPath = path.join(tempDir, 'repo');

      fs.mkdirSync(tempStateDir, { recursive: true });
      fs.mkdirSync(testRepoPath, { recursive: true });

      // Initialize git repository
      execFileSync('git', ['init', '-b', 'main'], { cwd: testRepoPath });
      execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: testRepoPath });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: testRepoPath });
      fs.writeFileSync(path.join(testRepoPath, 'README.md'), '# Test Repo\n');
      execFileSync('git', ['add', 'README.md'], { cwd: testRepoPath });
      execFileSync('git', ['commit', '-m', 'initial commit'], { cwd: testRepoPath });
    });

    afterEach(() => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('records and persists Anti 初始开发 prompt before agy execution', async () => {
      const orchestrator = new Orchestrator({
        stateDir: tempStateDir,
        allowedBaseDir: tempDir,
      });

      const task = await orchestrator.createTask({
        repoPath: testRepoPath,
        prompt: 'Implement user login feature',
      });

      // Execute task loop where agy runs initial development
      let recordedDuringExecution: TaskRecord | null = null;

      const executingExecutor: CommandExecutor = async (file, args) => {
        if (file === 'agy' && args.includes('--mode')) {
          // Verify on disk that the prompt audit record is ALREADY persisted BEFORE execution finishes!
          recordedDuringExecution = await loadTaskState(tempStateDir, task.id);
          // Simulate crash/failure during agy execution
          return { exitCode: 1, stdout: '', stderr: 'Unexpected SIGKILL during agy execution' };
        }
        if (file === 'git') {
          if (args[0] === 'rev-parse') return { exitCode: 0, stdout: 'main\n', stderr: '' };
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      };

      const finalTask = await orchestrator.runTaskLoop(task.id, { executor: executingExecutor });

      // Invariant: The prompt audit was persisted on disk even when agy failed / was killed!
      expect(recordedDuringExecution).not.toBeNull();
      expect(recordedDuringExecution!.promptAudits).toBeDefined();
      expect(recordedDuringExecution!.promptAudits!.length).toBe(1);

      const audit = recordedDuringExecution!.promptAudits![0];
      expect(audit.actor).toBe('ANTI');
      expect(audit.stage).toBe('AGY_DEVELOPING');
      expect(audit.title).toBe('Anti 初始开发');
      expect(audit.timestamp).toBeTruthy();
      // Verifies final sent prompt includes full instructions, not just raw task.prompt
      expect(audit.body).toContain('### Task Instructions');
      expect(audit.body).toContain('Implement user login feature');
      expect(audit.body).toContain('### Development Guidelines');

      // Final task state on disk also preserves the prompt audit
      const loadedFromDisk = await loadTaskState(tempStateDir, task.id);
      expect(loadedFromDisk!.promptAudits!.length).toBe(1);
      expect(finalTask.state).toBe('FAILED');
    });

    it('records final prompts for Codex 审查, Anti 审查修复, and Anti 本机核验', async () => {
      let callCount = 0;
      let uncommittedChanges = true;
      const mockExecutor: CommandExecutor = async (file, args) => {
        if (file === 'git') {
          if (args[0] === 'rev-parse') return { exitCode: 0, stdout: 'main\n', stderr: '' };
          if (args[0] === 'status') {
            if (args.includes('--porcelain')) {
              return {
                exitCode: 0,
                stdout: uncommittedChanges ? 'M feature.ts\n' : '',
                stderr: '',
              };
            }
            return { exitCode: 0, stdout: '', stderr: '' };
          }
          if (args[0] === 'diff') return { exitCode: 0, stdout: 'feature.ts\n', stderr: '' };
          if (args[0] === 'commit') {
            uncommittedChanges = false;
            return { exitCode: 0, stdout: '', stderr: '' };
          }
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        if (file === 'gh') {
          if (args[0] === 'pr' && args[1] === 'create') {
            return { exitCode: 0, stdout: 'https://github.com/org/repo/pull/42\n', stderr: '' };
          }
          if (args[0] === 'pr' && args[1] === 'checks') {
            return {
              exitCode: 0,
              stdout: JSON.stringify([
                { name: 'test', state: 'SUCCESS', bucket: 'pass', workflow: 'CI' },
              ]),
              stderr: '',
            };
          }
          if (args[0] === 'pr' && args[1] === 'comment') {
            return { exitCode: 0, stdout: '', stderr: '' };
          }
        }
        if (file === 'codex') {
          callCount++;
          if (callCount === 1) {
            // First review returns CHANGES_REQUIRED to trigger fix cycle
            return {
              exitCode: 0,
              stdout: JSON.stringify({
                verdict: 'CHANGES_REQUIRED',
                summary: 'Found bug in feature.ts',
                blockingIssues: ['Null pointer dereference in auth'],
                warnings: ['Consider adding more logging'],
                humanVerificationChecklist: ['Verify login with valid credentials'],
              }),
              stderr: '',
            };
          } else {
            // Second review returns APPROVE
            return {
              exitCode: 0,
              stdout: JSON.stringify({
                verdict: 'APPROVE',
                summary: 'Code is clean and verified',
                blockingIssues: [],
                warnings: [],
                humanVerificationChecklist: ['Verify login works on localhost:3000'],
              }),
              stderr: '',
            };
          }
        }
        if (file === 'agy') {
          // Check which step
          const promptArg = args[args.indexOf('--print') + 1] || '';
          if (promptArg.includes('Mandatory Live Verification')) {
            // Live verification output
            return {
              exitCode: 0,
              stdout: JSON.stringify({
                status: 'PASSED',
                command: 'npm run start',
                url: 'http://127.0.0.1:3000',
                checks: ['Verify login works on localhost:3000'],
                summary: 'App started cleanly on 127.0.0.1:3000 and verified.',
              }),
              stderr: '',
            };
          }
          uncommittedChanges = true;
          return { exitCode: 0, stdout: 'Agy completed code edits\n', stderr: '' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      };

      const orchestrator = new Orchestrator({
        stateDir: tempStateDir,
        allowedBaseDir: tempDir,
      });

      const task = await orchestrator.createTask({
        repoPath: testRepoPath,
        prompt: 'Build user auth',
      });

      // Run loop through AGY_DEVELOPING -> CODEX_REVIEWING (CHANGES_REQUIRED) -> AGY_FIXING -> CODEX_REVIEWING (APPROVE) -> AGY_VALIDATING -> AWAITING_HUMAN_APPROVAL
      const finalTask = await orchestrator.runTaskLoop(task.id, {
        executor: mockExecutor,
        testRunner: async () => ({ pass: true }),
      });

      expect(finalTask.state).toBe('AWAITING_HUMAN_APPROVAL');
      expect(finalTask.promptAudits).toBeDefined();

      const titles = finalTask.promptAudits!.map((a) => a.title);
      expect(titles).toContain('Anti 初始开发');
      expect(titles).toContain('Codex 审查');
      expect(titles).toContain('Anti 审查修复');
      expect(titles).toContain('Anti 本机核验');

      // Verify Codex 审查 record
      const codexAudit = finalTask.promptAudits!.find((a) => a.title === 'Codex 审查')!;
      expect(codexAudit.actor).toBe('CODEX');
      expect(codexAudit.stage).toBe('CODEX_REVIEWING');
      expect(codexAudit.body).toContain(
        'You are performing an automated, strictly read-only code review'
      );
      expect(codexAudit.body).toContain('Code Diff to review:');
      expect(codexAudit.body).toContain('feature.ts');

      // Verify Anti 审查修复 record
      const fixAudit = finalTask.promptAudits!.find((a) => a.title === 'Anti 审查修复')!;
      expect(fixAudit.actor).toBe('ANTI');
      expect(fixAudit.stage).toBe('AGY_FIXING');
      expect(fixAudit.body).toContain('### Fix Instructions (Code Review & Test Feedback)');
      expect(fixAudit.body).toContain('Null pointer dereference in auth');

      // Verify Anti 本机核验 record
      const validAudit = finalTask.promptAudits!.find((a) => a.title === 'Anti 本机核验')!;
      expect(validAudit.actor).toBe('ANTI');
      expect(validAudit.stage).toBe('AGY_VALIDATING');
      expect(validAudit.body).toContain('### Mandatory Live Verification Before Human PR Review');
      expect(validAudit.body).toContain('Verify login works on localhost:3000');
    });

    it('regression: CODEX_REVIEWING prompt audit and codex.review share exact final prompt with diff', async () => {
      const orchestrator = new Orchestrator({
        stateDir: tempStateDir,
        allowedBaseDir: tempDir,
      });

      const task = await orchestrator.createTask({
        repoPath: testRepoPath,
        prompt: 'Add secure token auth',
      });

      const mockDiff = [
        '--- a/src/auth.ts',
        '+++ b/src/auth.ts',
        '@@ -1,3 +1,5 @@',
        ' export function authenticate() {',
        '+  const secretToken = "ghp_1234567890abcdef1234567890abcdef12345678";',
        `+  const sessionDir = "${path.join(tempStateDir, 'worktrees', task.id)}";`,
        '   return true;',
        ' }',
      ].join('\n');

      let capturedCodexPrompt = '';
      let diskAuditBeforeCodexFinished: TaskRecord | null = null;
      let codexCalled = false;
      let uncommittedChanges = true;

      const mockExecutor: CommandExecutor = async (file, args) => {
        if (file === 'git') {
          if (args[0] === 'rev-parse') return { exitCode: 0, stdout: 'main\n', stderr: '' };
          if (args[0] === 'status') {
            if (args.includes('--porcelain')) {
              return {
                exitCode: 0,
                stdout: uncommittedChanges ? 'M src/auth.ts\n' : '',
                stderr: '',
              };
            }
            return { exitCode: 0, stdout: '', stderr: '' };
          }
          if (args[0] === 'diff') {
            return { exitCode: 0, stdout: mockDiff, stderr: '' };
          }
          if (args[0] === 'commit') {
            uncommittedChanges = false;
            return { exitCode: 0, stdout: '', stderr: '' };
          }
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        if (file === 'gh') {
          if (args[0] === 'pr' && args[1] === 'create') {
            return { exitCode: 0, stdout: 'https://github.com/org/repo/pull/777\n', stderr: '' };
          }
          if (args[0] === 'pr' && args[1] === 'checks') {
            return {
              exitCode: 0,
              stdout: JSON.stringify([
                { name: 'ci', state: 'SUCCESS', bucket: 'pass', workflow: 'CI' },
              ]),
              stderr: '',
            };
          }
        }
        if (file === 'agy') {
          const promptArg = args[args.indexOf('--print') + 1] || '';
          if (promptArg.includes('Mandatory Live Verification')) {
            return {
              exitCode: 0,
              stdout: JSON.stringify({
                status: 'PASSED',
                command: 'npm run start',
                url: 'http://127.0.0.1:3000',
                checks: ['Verify token auth works'],
                summary: 'Auth verified on localhost:3000',
              }),
              stderr: '',
            };
          }
          return { exitCode: 0, stdout: 'Anti code edits finished\n', stderr: '' };
        }
        if (file === 'codex') {
          codexCalled = true;
          // args: ['exec', '--sandbox', 'read-only', prompt]
          capturedCodexPrompt = args[3];

          // Invariant: Prompt audit is already persisted to disk BEFORE codex call returns
          diskAuditBeforeCodexFinished = await loadTaskState(tempStateDir, task.id);

          return {
            exitCode: 0,
            stdout: JSON.stringify({
              verdict: 'APPROVE',
              summary: 'All token authentication changes approved.',
              blockingIssues: [],
              warnings: [],
              humanVerificationChecklist: ['Verify token auth works'],
            }),
            stderr: '',
          };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      };

      const finalTask = await orchestrator.runTaskLoop(task.id, {
        executor: mockExecutor,
        testRunner: async () => ({ pass: true }),
      });

      expect(codexCalled).toBe(true);
      expect(finalTask.state).toBe('AWAITING_HUMAN_APPROVAL');

      // 1. Verify that the prompt sent to Codex actually contains the diff
      expect(capturedCodexPrompt).toBeTruthy();
      expect(capturedCodexPrompt).toContain('Code Diff to review:');
      expect(capturedCodexPrompt).toContain('```diff');
      expect(capturedCodexPrompt).toContain('secretToken');
      expect(capturedCodexPrompt).toContain('sessionDir');

      // 2. Verify disk persistence happened atomically before Codex completed
      expect(diskAuditBeforeCodexFinished).not.toBeNull();
      const auditBeforeFinish = diskAuditBeforeCodexFinished!.promptAudits?.find(
        (a) => a.stage === 'CODEX_REVIEWING'
      );
      expect(auditBeforeFinish).toBeDefined();

      // 3. Verify audit record in task matches the exact captured prompt after sanitization
      const codexAudit = finalTask.promptAudits?.find((a) => a.stage === 'CODEX_REVIEWING');
      expect(codexAudit).toBeDefined();

      const expectedSanitizedBody = sanitizePromptAuditText(capturedCodexPrompt, {
        worktreePath: finalTask.worktreePath,
        targetRepoPath: finalTask.targetRepoPath,
        stateDir: tempStateDir,
        allowedBaseDir: tempDir,
      });

      expect(codexAudit!.body).toBe(expectedSanitizedBody);

      // 4. Verify sanitization details inside the shared diff
      expect(codexAudit!.body).toContain('[REDACTED_GITHUB_TOKEN]');
      expect(codexAudit!.body).not.toContain('ghp_1234567890abcdef1234567890abcdef12345678');
      expect(codexAudit!.body).toContain('[WORKTREE]');
      expect(codexAudit!.body).not.toContain(finalTask.worktreePath);
    });

    it('gracefully handles legacy tasks without promptAudits', async () => {
      // Create legacy task JSON directly on disk without promptAudits
      const legacyTask: TaskRecord = {
        id: 'task-legacy-001',
        targetRepoPath: testRepoPath,
        baseBranch: 'main',
        taskBranch: 'anti/task-legacy-001',
        worktreePath: path.join(tempStateDir, 'worktrees', 'task-legacy-001'),
        state: 'WORKTREE_READY',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        prompt: 'Legacy task without promptAudits',
        transitions: [],
        diagnostics: {
          reviewCycles: 0,
          maxReviewCycles: 3,
          resumePossible: false,
          worktreePreserved: true,
        },
      };

      await saveTaskState(tempStateDir, legacyTask);

      const loaded = await loadTaskState(tempStateDir, 'task-legacy-001');
      expect(loaded).not.toBeNull();
      expect(loaded!.promptAudits).toBeUndefined();

      const orchestrator = new Orchestrator({
        stateDir: tempStateDir,
        allowedBaseDir: tempDir,
      });

      const fetched = await orchestrator.getTask('task-legacy-001');
      expect(fetched.id).toBe('task-legacy-001');
      expect(fetched.promptAudits).toBeUndefined();
    });
  });
});
