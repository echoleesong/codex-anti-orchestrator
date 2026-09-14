import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexAdapter } from '../src/adapters/codex-adapter.js';
import {
  CodexReviewBudgetStore,
  resolveWorktreeHeadSha,
} from '../src/adapters/codex-review-budget.js';
import type { CodexReviewResult, CommandExecutor } from '../src/types.js';

const cleanupPaths: string[] = [];

async function createFakeWorktree(headSha: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'codex-budget-test-'));
  cleanupPaths.push(root);
  await mkdir(path.join(root, '.git'));
  await writeFile(path.join(root, '.git', 'HEAD'), `${headSha}\n`);
  return root;
}

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

describe('Codex review budget and cache', () => {
  it('resolves a detached HEAD and persists a bounded task call budget', async () => {
    const sha = '1'.repeat(40);
    const worktree = await createFakeWorktree(sha);
    const cacheFile = path.join(worktree, 'state', 'review-cache.json');
    const store = new CodexReviewBudgetStore({ cacheFile, maxCallsPerTask: 2 });

    expect(await resolveWorktreeHeadSha(worktree)).toBe(sha);
    const identity = await store.identify(worktree, 'main', 'task');
    expect(identity?.headSha).toBe(sha);
    expect(identity).toBeDefined();
    if (!identity) throw new Error('Expected review identity');

    expect((await store.reserveCall(identity)).allowed).toBe(true);
    expect((await store.reserveCall(identity)).allowed).toBe(true);
    const exhausted = await store.reserveCall(identity);
    expect(exhausted).toEqual({ allowed: false, calls: 2, maxCalls: 2 });

    const result: CodexReviewResult = {
      verdict: 'CHANGES_REQUIRED',
      summary: 'One defect',
      blockingIssues: ['bug'],
      warnings: [],
      humanVerificationChecklist: [],
      parsedCleanly: true,
      rawOutput: '- [P1] bug',
    };
    await store.store(identity, result);
    expect(await store.getCached(identity)).toEqual(result);
  });

  it('reuses the same-HEAD review and refuses model calls after the hard budget', async () => {
    const worktree = await createFakeWorktree('2'.repeat(40));
    const cacheFile = path.join(worktree, 'state', 'review-cache.json');
    let modelCalls = 0;

    const executor: CommandExecutor = async () => {
      modelCalls += 1;
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          verdict: 'APPROVE',
          summary: `review ${modelCalls}`,
          blockingIssues: [],
          warnings: [],
          humanVerificationChecklist: ['Run the changed behavior locally.'],
        }),
        stderr: '',
      };
    };

    const adapter = new CodexAdapter(executor, { cacheFile, maxCallsPerTask: 3 });
    const options = { worktreePath: worktree, baseBranch: 'main', taskPrompt: 'Implement timer.' };

    const first = await adapter.review(options);
    const cached = await adapter.review(options);
    expect(first.verdict).toBe('APPROVE');
    expect(cached).toEqual(first);
    expect(modelCalls).toBe(1);

    await writeFile(path.join(worktree, '.git', 'HEAD'), `${'3'.repeat(40)}\n`);
    expect((await adapter.review(options)).verdict).toBe('APPROVE');
    await writeFile(path.join(worktree, '.git', 'HEAD'), `${'4'.repeat(40)}\n`);
    expect((await adapter.review(options)).verdict).toBe('APPROVE');
    expect(modelCalls).toBe(3);

    await writeFile(path.join(worktree, '.git', 'HEAD'), `${'5'.repeat(40)}\n`);
    const exhausted = await adapter.review(options);
    expect(exhausted.verdict).toBe('NEEDS_USER_DECISION');
    expect(exhausted.parsedCleanly).toBe(false);
    expect(exhausted.summary).toContain('review budget exhausted');
    expect(modelCalls).toBe(3);
  });
});
