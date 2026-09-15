import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexAdapter } from '../src/adapters/codex-adapter.js';
import type { CommandExecutor } from '../src/types.js';

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map((entry) => rm(entry, { recursive: true, force: true }))
  );
});

describe('incremental Codex review safety', () => {
  it('keeps full-review scope after CHANGES_REQUIRED so unresolved blockers cannot disappear', async () => {
    const worktree = await mkdtemp(path.join(tmpdir(), 'incremental-review-safety-'));
    cleanupPaths.push(worktree);
    const baseSha = 'a'.repeat(40);
    const firstHead = '1'.repeat(40);
    const secondHead = '2'.repeat(40);
    await mkdir(path.join(worktree, '.git', 'refs', 'heads'), { recursive: true });
    await writeFile(path.join(worktree, '.git', 'HEAD'), `${firstHead}\n`);
    await writeFile(path.join(worktree, '.git', 'refs', 'heads', 'main'), `${baseSha}\n`);

    const observedBases: string[] = [];
    let codexCalls = 0;
    let mergeBaseChecks = 0;
    const executor: CommandExecutor = async (file, args) => {
      if (file === 'git') {
        if (args[0] === 'merge-base') mergeBaseChecks += 1;
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (file === 'codex') {
        codexCalls += 1;
        observedBases.push(args[args.indexOf('--base') + 1] || '');
        return {
          exitCode: 0,
          stdout: JSON.stringify(
            codexCalls === 1
              ? {
                  verdict: 'CHANGES_REQUIRED',
                  summary: 'Two blockers remain.',
                  blockingIssues: ['Fix A', 'Fix B'],
                  warnings: [],
                  humanVerificationChecklist: [],
                }
              : {
                  verdict: 'APPROVE',
                  summary: 'Full re-review is clean.',
                  blockingIssues: [],
                  warnings: [],
                  humanVerificationChecklist: ['Verify the feature locally.'],
                }
          ),
          stderr: '',
        };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    };

    const adapter = new CodexAdapter(executor, {
      cacheFile: path.join(worktree, 'review-cache.json'),
      maxCallsPerTask: 3,
    });
    const options = {
      worktreePath: worktree,
      baseBranch: 'main',
      taskPrompt: 'Implement feature.',
    };

    expect((await adapter.review(options)).verdict).toBe('CHANGES_REQUIRED');
    await writeFile(path.join(worktree, '.git', 'HEAD'), `${secondHead}\n`);
    expect((await adapter.review(options)).verdict).toBe('APPROVE');

    expect(observedBases).toEqual([baseSha, baseSha]);
    expect(mergeBaseChecks).toBe(0);
  });
});
