import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import { transitionTaskState } from '../src/state/state-machine.js';
import type { TaskRecord } from '../src/types.js';

const execFileAsync = promisify(execFile);
const cliPath = path.resolve(process.cwd(), 'src/cli.ts');

describe('Orchestrator Core & Lifecycle Integration', () => {
  let tempBaseDir: string;
  let testRepoPath: string;
  let tempStateDir: string;
  let orchestrator: Orchestrator;

  beforeEach(() => {
    tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-test-base-'));
    testRepoPath = path.join(tempBaseDir, 'test-project');
    tempStateDir = path.join(tempBaseDir, 'orchestrator-state');

    fs.mkdirSync(testRepoPath, { recursive: true });
    fs.mkdirSync(tempStateDir, { recursive: true });

    // Initialize git repository
    execFileSync('git', ['init', '-b', 'main'], { cwd: testRepoPath });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: testRepoPath });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: testRepoPath });
    fs.writeFileSync(path.join(testRepoPath, 'index.ts'), 'console.log("hello");\n');
    execFileSync('git', ['add', 'index.ts'], { cwd: testRepoPath });
    execFileSync('git', ['commit', '-m', 'initial commit'], { cwd: testRepoPath });

    // Injected constructor parameters for test isolation
    orchestrator = new Orchestrator({
      stateDir: tempStateDir,
      allowedBaseDir: tempBaseDir,
    });
  });

  afterEach(() => {
    fs.rmSync(tempBaseDir, { recursive: true, force: true });
  });

  it('should successfully create a task and enter WORKTREE_READY state', async () => {
    const task = await orchestrator.createTask({
      repoPath: testRepoPath,
      prompt: 'Implement auth module',
    });

    expect(task.state).toBe('WORKTREE_READY');
    expect(task.prompt).toBe('Implement auth module');
    expect(task.targetRepoPath).toBe(fs.realpathSync(testRepoPath));
    expect(fs.existsSync(task.worktreePath)).toBe(true);
    expect(task.diagnostics.worktreePreserved).toBe(true);

    // Verify state history: IDLE -> INITIALIZING -> WORKTREE_PREPARING -> WORKTREE_READY
    const stateTransitions = task.transitions.map((t) => t.to);
    expect(stateTransitions).toEqual(['INITIALIZING', 'WORKTREE_PREPARING', 'WORKTREE_READY']);

    // Verify task can be reloaded
    const loaded = await orchestrator.getTask(task.id);
    expect(loaded.id).toBe(task.id);
    expect(loaded.state).toBe('WORKTREE_READY');
  });

  it('should reject task creation if stateDir is inside the target repository', async () => {
    const inRepoStateDir = path.join(testRepoPath, '.orch-state');
    const badOrchestrator = new Orchestrator({
      stateDir: inRepoStateDir,
      allowedBaseDir: tempBaseDir,
    });

    await expect(
      badOrchestrator.createTask({
        repoPath: testRepoPath,
        prompt: 'Task with in-repo stateDir',
      })
    ).rejects.toThrow(/Invalid state directory isolation/);
  });

  it('should reject task creation if working tree is dirty', async () => {
    fs.writeFileSync(path.join(testRepoPath, 'dirty.txt'), 'uncommitted changes\n');

    await expect(
      orchestrator.createTask({
        repoPath: testRepoPath,
        prompt: 'Task on dirty repo',
      })
    ).rejects.toThrow(/Target repository working tree is not clean/);
  });

  it('should reject task creation if Git lockfile is present without deleting it', async () => {
    const lockFile = path.join(testRepoPath, '.git', 'index.lock');
    fs.writeFileSync(lockFile, 'locked');

    await expect(
      orchestrator.createTask({
        repoPath: testRepoPath,
        prompt: 'Task on locked repo',
      })
    ).rejects.toThrow(/Git repository lock detected/);

    expect(fs.existsSync(lockFile)).toBe(true);
  });

  it('should cancel task while preserving the worktree', async () => {
    const task = await orchestrator.createTask({
      repoPath: testRepoPath,
      prompt: 'Task to cancel',
    });

    const cancelled = await orchestrator.cancelTask(task.id, 'User stopped task');
    expect(cancelled.state).toBe('ABORTED');
    expect(cancelled.diagnostics.worktreePreserved).toBe(true);
    expect(fs.existsSync(task.worktreePath)).toBe(true);

    const reloaded = await orchestrator.getTask(task.id);
    expect(reloaded.state).toBe('ABORTED');
  });

  it('should handle resume from NEEDS_USER_DECISION with override or guidance', async () => {
    const task = await orchestrator.createTask({
      repoPath: testRepoPath,
      prompt: 'Task needing decision',
    });

    // Advance task state to NEEDS_USER_DECISION
    transitionTaskState(task, 'AGY_DEVELOPING');
    transitionTaskState(task, 'PR_CREATING');
    transitionTaskState(task, 'CODEX_REVIEWING');
    transitionTaskState(task, 'REVIEW_EVALUATING');
    transitionTaskState(task, 'NEEDS_USER_DECISION', {
      reason: 'Max review cycles reached with remaining warnings.',
    });
    const { saveTaskState } = await import('../src/state/state-machine.js');
    await saveTaskState(tempStateDir, task);

    // Resume with override
    const resumedOverride = await orchestrator.resumeTask(task.id, { override: true });
    expect(resumedOverride.state).toBe('AWAITING_HUMAN_OVERRIDE');

    // Test resume with guidance
    task.state = 'NEEDS_USER_DECISION';
    await saveTaskState(tempStateDir, task);
    const resumedGuidance = await orchestrator.resumeTask(task.id, {
      guidance: 'Fix null pointer in auth.ts',
    });
    expect(resumedGuidance.state).toBe('AGY_FIXING');
    expect(resumedGuidance.prompt).toContain('Fix null pointer in auth.ts');
  });

  describe('commitWorktreeChanges Fail-Closed Staging Policy', () => {
    it('should stage only validated safe files and commit successfully', async () => {
      const task = await orchestrator.createTask({
        repoPath: testRepoPath,
        prompt: 'Safe staging test',
      });

      fs.writeFileSync(path.join(task.worktreePath, 'feature.ts'), 'export const x = 1;\n');
      const committed = await orchestrator.commitWorktreeChanges(
        task.worktreePath,
        'feat: add feature.ts'
      );
      expect(committed).toBe(true);

      const log = execFileSync('git', ['log', '-1', '--oneline'], {
        cwd: task.worktreePath,
      }).toString();
      expect(log).toContain('feat: add feature.ts');
    });

    it('should fail closed and reject commit if prohibited sensitive files exist in worktree', async () => {
      const task = await orchestrator.createTask({
        repoPath: testRepoPath,
        prompt: 'Sensitive file test',
      });

      fs.writeFileSync(path.join(task.worktreePath, 'feature.ts'), 'export const x = 1;\n');
      fs.writeFileSync(path.join(task.worktreePath, '.env.production'), 'SECRET_KEY=123456\n');

      await expect(
        orchestrator.commitWorktreeChanges(task.worktreePath, 'feat: unsafe commit')
      ).rejects.toThrow(/Safe staging policy violation/);
    });
  });

  describe('CLI Command Invariants', () => {
    it('should strictly reject create command for repositories outside /Users/lisong/code in production mode', async () => {
      const env = {
        ...process.env,
        CODEX_ORCHESTRATOR_STATE_DIR: tempStateDir,
      };

      try {
        await execFileAsync(
          'npx',
          [
            'tsx',
            cliPath,
            'create',
            '--repo',
            testRepoPath,
            '--prompt',
            'CLI Security Test',
            '--json',
          ],
          { env }
        );
        expect.unreachable('CLI should have rejected repository outside /Users/lisong/code');
      } catch (err: unknown) {
        const execErr = err as { code?: number; stderr?: string };
        expect(execErr.code).toBe(1);
        expect(execErr.stderr).toContain('must reside strictly within /Users/lisong/code');
      }
    });

    it('should support status listing via CLI', async () => {
      const env = {
        ...process.env,
        CODEX_ORCHESTRATOR_STATE_DIR: tempStateDir,
      };

      // Create a task programmatically in the stateDir
      await orchestrator.createTask({
        repoPath: testRepoPath,
        prompt: 'Task for status CLI test',
      });

      const listRes = await execFileAsync('npx', ['tsx', cliPath, 'status', '--all', '--json'], {
        env,
      });
      const allTasks = JSON.parse(listRes.stdout.trim()) as TaskRecord[];
      expect(allTasks.length).toBeGreaterThanOrEqual(1);
      expect(allTasks[0].state).toBe('WORKTREE_READY');
    });
  });
});
