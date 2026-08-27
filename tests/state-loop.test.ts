import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import type { CommandExecutor, ExecOutput } from '../src/types.js';

describe('Controlled State-Loop Execution & Transitions', () => {
  let tempDir: string;
  let repoPath: string;
  let stateDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-loop-test-'));
    repoPath = path.join(tempDir, 'repo');
    stateDir = path.join(tempDir, 'state');

    fs.mkdirSync(path.join(repoPath, '.git'), { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const createMockExecutor = (
    options: {
      codexVerdicts?: string[];
      testsPass?: boolean[];
      agyFail?: boolean;
      pushFail?: boolean;
    } = {}
  ): CommandExecutor => {
    let codexCallCount = 0;
    let testCallCount = 0;

    return async (
      file: string,
      args: string[],
      execOptions?: Record<string, unknown>
    ): Promise<ExecOutput> => {
      const full = `${file} ${args.join(' ')}`;
      const cwd = (execOptions?.cwd as string) || '';

      // Git checks
      if (full.includes('rev-parse --is-inside-work-tree')) {
        return { exitCode: 0, stdout: 'true\n', stderr: '' };
      }
      if (full.includes('rev-parse --git-dir')) {
        return { exitCode: 0, stdout: '.git\n', stderr: '' };
      }
      if (full.includes('rev-parse --abbrev-ref HEAD')) {
        return { exitCode: 0, stdout: 'main\n', stderr: '' };
      }
      if (full.includes('status --porcelain')) {
        if (cwd.includes('worktrees')) {
          return { exitCode: 0, stdout: 'M  src/feature.ts\n', stderr: '' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (full.includes('worktree add')) {
        const wtPath = args[args.indexOf('-b') + 2];
        if (wtPath) {
          fs.mkdirSync(wtPath, { recursive: true });
        }
        return { exitCode: 0, stdout: 'Preparing worktree\n', stderr: '' };
      }
      if (full.includes('git add') || full.includes('git commit') || full.includes('git diff')) {
        return { exitCode: 0, stdout: 'index.ts\n', stderr: '' };
      }

      // Git push
      if (full.includes('git push')) {
        if (options.pushFail) {
          return { exitCode: 1, stdout: '', stderr: 'fatal: remote rejected push' };
        }
        return { exitCode: 0, stdout: 'Push successful\n', stderr: '' };
      }

      // agy execution
      if (file === 'agy') {
        if (options.agyFail) {
          return { exitCode: 1, stdout: '', stderr: 'agy fatal compilation error' };
        }
        return { exitCode: 0, stdout: 'agy code generated successfully\n', stderr: '' };
      }

      // gh pr operations
      if (file === 'gh') {
        if (args.includes('create')) {
          return {
            exitCode: 0,
            stdout: 'https://github.com/echoleesong/codex-anti-orchestrator/pull/99\n',
            stderr: '',
          };
        }
        if (args.includes('view') || args.includes('edit') || args.includes('comment')) {
          return { exitCode: 0, stdout: '{}', stderr: '' };
        }
      }

      // codex review
      if (file === 'codex') {
        const verdicts = options.codexVerdicts || ['APPROVE'];
        const verdict = verdicts[Math.min(codexCallCount, verdicts.length - 1)];
        codexCallCount++;

        if (verdict === 'MALFORMED') {
          return { exitCode: 0, stdout: 'Broken non-json output', stderr: '' };
        }

        if (verdict === 'APPROVE') {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              verdict: 'APPROVE',
              summary: 'All code meets requirements.',
              blockingIssues: [],
              warnings: [],
            }),
            stderr: '',
          };
        }

        if (verdict === 'CHANGES_REQUIRED') {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              verdict: 'CHANGES_REQUIRED',
              summary: 'Please fix security vulnerabilities.',
              blockingIssues: ['Missing input validation in controller'],
              warnings: [],
            }),
            stderr: '',
          };
        }

        if (verdict === 'NEEDS_USER_DECISION') {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              verdict: 'NEEDS_USER_DECISION',
              summary: 'Tradeoff required between latency and memory.',
              blockingIssues: [],
              warnings: [],
            }),
            stderr: '',
          };
        }
      }

      // npm test runner
      if (file === 'npm' && args.includes('test')) {
        const passResults = options.testsPass ?? [true];
        const passed = passResults[Math.min(testCallCount, passResults.length - 1)];
        testCallCount++;

        return {
          exitCode: passed ? 0 : 1,
          stdout: passed ? 'All 10 tests passed' : '1 test failed',
          stderr: passed ? '' : 'AssertionError: expected true to be false',
        };
      }

      return { exitCode: 0, stdout: '', stderr: '' };
    };
  };

  it('should run full clean pipeline to AWAITING_HUMAN_APPROVAL on clean review & passing tests', async () => {
    const mock = createMockExecutor({
      codexVerdicts: ['APPROVE'],
      testsPass: [true],
    });

    const orchestrator = new Orchestrator({
      stateDir,
      allowedBaseDir: tempDir,
      executor: mock,
    });

    const task = await orchestrator.createTask({
      repoPath,
      prompt: 'Implement safe state loop',
    });

    expect(task.state).toBe('WORKTREE_READY');

    const finishedTask = await orchestrator.runTaskLoop(task.id, { executor: mock });

    expect(finishedTask.state).toBe('AWAITING_HUMAN_APPROVAL');
    expect(finishedTask.diagnostics.worktreePreserved).toBe(true);
    expect(finishedTask.diagnostics.lastReviewVerdict).toBe('APPROVE');
    expect(finishedTask.diagnostics.lastTestPassed).toBe(true);

    const states = finishedTask.transitions.map((t) => t.to);
    expect(states).toContain('AGY_DEVELOPING');
    expect(states).toContain('PR_CREATING');
    expect(states).toContain('CODEX_REVIEWING');
    expect(states).toContain('REVIEW_EVALUATING');
    expect(states[states.length - 1]).toBe('AWAITING_HUMAN_APPROVAL');
  });

  it('should run fix cycle when CHANGES_REQUIRED is returned and reach AWAITING_HUMAN_APPROVAL on subsequent pass', async () => {
    const mock = createMockExecutor({
      codexVerdicts: ['CHANGES_REQUIRED', 'APPROVE'],
      testsPass: [true, true],
    });

    const orchestrator = new Orchestrator({
      stateDir,
      allowedBaseDir: tempDir,
      executor: mock,
    });

    const task = await orchestrator.createTask({
      repoPath,
      prompt: 'Implement feature needing 1 fix cycle',
    });

    const finishedTask = await orchestrator.runTaskLoop(task.id, { executor: mock });

    expect(finishedTask.state).toBe('AWAITING_HUMAN_APPROVAL');
    expect(finishedTask.diagnostics.reviewCycles).toBe(1);

    const states = finishedTask.transitions.map((t) => t.to);
    expect(states).toContain('AGY_FIXING');
    expect(states).toContain('PR_UPDATING');
    expect(states[states.length - 1]).toBe('AWAITING_HUMAN_APPROVAL');
  });

  it('should transition to NEEDS_USER_DECISION when max review cycles is exhausted', async () => {
    const mock = createMockExecutor({
      codexVerdicts: [
        'CHANGES_REQUIRED',
        'CHANGES_REQUIRED',
        'CHANGES_REQUIRED',
        'CHANGES_REQUIRED',
      ],
      testsPass: [true, true, true, true],
    });

    const orchestrator = new Orchestrator({
      stateDir,
      allowedBaseDir: tempDir,
      executor: mock,
    });

    const task = await orchestrator.createTask({
      repoPath,
      prompt: 'Feature with stubborn issues',
      maxReviewCycles: 2,
    });

    const finishedTask = await orchestrator.runTaskLoop(task.id, { executor: mock });

    expect(finishedTask.state).toBe('NEEDS_USER_DECISION');
    expect(finishedTask.diagnostics.reviewCycles).toBe(2);
    expect(finishedTask.diagnostics.worktreePreserved).toBe(true);
    expect(finishedTask.diagnostics.resumePossible).toBe(true);
  });

  it('should transition to NEEDS_USER_DECISION when Codex output is malformed or requests decision', async () => {
    const mock = createMockExecutor({
      codexVerdicts: ['MALFORMED'],
    });

    const orchestrator = new Orchestrator({
      stateDir,
      allowedBaseDir: tempDir,
      executor: mock,
    });

    const task = await orchestrator.createTask({
      repoPath,
      prompt: 'Feature with malformed review',
    });

    const finishedTask = await orchestrator.runTaskLoop(task.id, { executor: mock });

    expect(finishedTask.state).toBe('NEEDS_USER_DECISION');
    expect(finishedTask.diagnostics.worktreePreserved).toBe(true);
  });

  it('should transition to FAILED and preserve worktree when agy execution fails', async () => {
    const mock = createMockExecutor({
      agyFail: true,
    });

    const orchestrator = new Orchestrator({
      stateDir,
      allowedBaseDir: tempDir,
      executor: mock,
    });

    const task = await orchestrator.createTask({
      repoPath,
      prompt: 'Feature with agy failure',
    });

    const finishedTask = await orchestrator.runTaskLoop(task.id, { executor: mock });

    expect(finishedTask.state).toBe('FAILED');
    expect(finishedTask.diagnostics.lastError).toContain('agy fatal compilation error');
    expect(finishedTask.diagnostics.worktreePreserved).toBe(true);
    expect(finishedTask.diagnostics.resumePossible).toBe(true);
  });

  it('should handle resume with override or guidance from NEEDS_USER_DECISION', async () => {
    const mock = createMockExecutor({
      codexVerdicts: ['NEEDS_USER_DECISION'],
    });

    const orchestrator = new Orchestrator({
      stateDir,
      allowedBaseDir: tempDir,
      executor: mock,
    });

    const task = await orchestrator.createTask({
      repoPath,
      prompt: 'Task for resume testing',
    });

    await orchestrator.runTaskLoop(task.id, { executor: mock });

    // Test override
    const overrideTask = await orchestrator.resumeTask(task.id, { override: true });
    expect(overrideTask.state).toBe('AWAITING_HUMAN_OVERRIDE');
    expect(overrideTask.diagnostics.worktreePreserved).toBe(true);
  });
});
