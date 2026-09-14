import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexAdapter } from '../src/adapters/codex-adapter.js';
import {
  CodexReviewBudgetStore,
  resolveWorktreeHeadSha,
  resolveWorktreeRefSha,
} from '../src/adapters/codex-review-budget.js';
import type { CodexReviewResult, CommandExecutor } from '../src/types.js';

const cleanupPaths: string[] = [];

async function createFakeWorktree(
  headSha: string,
  baseSha: string = 'a'.repeat(40)
): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'codex-budget-test-'));
  cleanupPaths.push(root);
  await mkdir(path.join(root, '.git', 'refs', 'heads'), { recursive: true });
  await writeFile(path.join(root, '.git', 'HEAD'), `${headSha}\n`);
  await writeFile(path.join(root, '.git', 'refs', 'heads', 'main'), `${baseSha}\n`);
  return root;
}

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map((entry) => rm(entry, { recursive: true, force: true }))
  );
});

describe('Codex review budget and cache', () => {
  it('resolves HEAD and base SHA and persists a bounded task call budget', async () => {
    const headSha = '1'.repeat(40);
    const baseSha = 'a'.repeat(40);
    const worktree = await createFakeWorktree(headSha, baseSha);
    const cacheFile = path.join(worktree, 'state', 'review-cache.json');
    const store = new CodexReviewBudgetStore({ cacheFile, maxCallsPerTask: 2 });

    expect(await resolveWorktreeHeadSha(worktree)).toBe(headSha);
    expect(await resolveWorktreeRefSha(worktree, 'main')).toBe(baseSha);
    const identity = await store.identify(worktree, 'main', 'task');
    expect(identity).toMatchObject({ headSha, baseSha, cacheable: true });

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

  it('reuses the same review identity and invalidates cache when base or HEAD changes', async () => {
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

    const adapter = new CodexAdapter(executor, { cacheFile, maxCallsPerTask: 4 });
    const options = { worktreePath: worktree, baseBranch: 'main', taskPrompt: 'Implement timer.' };

    const first = await adapter.review(options);
    const cached = await adapter.review(options);
    expect(first.verdict).toBe('APPROVE');
    expect(cached).toEqual(first);
    expect(modelCalls).toBe(1);

    await writeFile(path.join(worktree, '.git', 'refs', 'heads', 'main'), `${'b'.repeat(40)}\n`);
    expect((await adapter.review(options)).verdict).toBe('APPROVE');
    expect(modelCalls).toBe(2);

    await writeFile(path.join(worktree, '.git', 'HEAD'), `${'3'.repeat(40)}\n`);
    expect((await adapter.review(options)).verdict).toBe('APPROVE');
    expect(modelCalls).toBe(3);
  });

  it('still enforces the hard call budget when Git identity cannot be resolved', async () => {
    const worktree = await mkdtemp(path.join(tmpdir(), 'codex-budget-no-git-'));
    cleanupPaths.push(worktree);
    const cacheFile = path.join(worktree, 'state', 'review-cache.json');
    let modelCalls = 0;

    const executor: CommandExecutor = async () => {
      modelCalls += 1;
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          verdict: 'CHANGES_REQUIRED',
          summary: 'Needs work',
          blockingIssues: ['bug'],
          warnings: [],
          humanVerificationChecklist: [],
        }),
        stderr: '',
      };
    };

    const adapter = new CodexAdapter(executor, { cacheFile, maxCallsPerTask: 2 });
    const options = { worktreePath: worktree, baseBranch: 'main', taskPrompt: 'Task' };

    expect((await adapter.review(options)).verdict).toBe('CHANGES_REQUIRED');
    expect((await adapter.review(options)).verdict).toBe('CHANGES_REQUIRED');
    const exhausted = await adapter.review(options);

    expect(exhausted.verdict).toBe('NEEDS_USER_DECISION');
    expect(exhausted.summary).toContain('review budget exhausted');
    expect(modelCalls).toBe(2);
  });

  it('serializes concurrent quota reservations so the hard limit cannot be raced', async () => {
    const worktree = await createFakeWorktree('4'.repeat(40));
    const cacheFile = path.join(worktree, 'state', 'review-cache.json');
    const store = new CodexReviewBudgetStore({ cacheFile, maxCallsPerTask: 3 });
    const identity = await store.identify(worktree, 'main', 'task');

    const reservations = await Promise.all(
      Array.from({ length: 8 }, () => store.reserveCall(identity))
    );

    expect(reservations.filter((entry) => entry.allowed)).toHaveLength(3);
    expect(reservations.filter((entry) => !entry.allowed)).toHaveLength(5);
  });

  it('fails closed instead of silently resetting a malformed persisted budget', async () => {
    const worktree = await createFakeWorktree('5'.repeat(40));
    const cacheFile = path.join(worktree, 'state', 'review-cache.json');
    await mkdir(path.dirname(cacheFile), { recursive: true });
    await writeFile(cacheFile, '{not-json');

    const store = new CodexReviewBudgetStore({ cacheFile });
    const identity = await store.identify(worktree, 'main', 'task');

    await expect(store.reserveCall(identity)).rejects.toThrow('refusing to reset quota');
  });
});
