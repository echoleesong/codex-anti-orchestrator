import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runDeterministicPreflight } from '../src/adapters/deterministic-preflight.js';
import type { CommandExecutor } from '../src/types.js';

const cleanupPaths: string[] = [];

async function createWorktree(): Promise<string> {
  const worktree = await mkdtemp(path.join(tmpdir(), 'deterministic-preflight-'));
  cleanupPaths.push(worktree);
  return worktree;
}

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map((entry) => rm(entry, { recursive: true, force: true }))
  );
});

describe('deterministic Codex preflight', () => {
  it('runs diff checking and only allowlisted package scripts, collecting failures', async () => {
    const worktree = await createWorktree();
    await writeFile(
      path.join(worktree, 'package.json'),
      JSON.stringify({
        scripts: {
          typecheck: 'tsc --noEmit',
          test: 'vitest run',
          deploy: 'should-never-run',
        },
      })
    );

    const calls: string[] = [];
    const executor: CommandExecutor = async (file, args) => {
      calls.push(`${file} ${args.join(' ')}`);
      if (file === 'npm' && args[1] === 'typecheck') {
        return { exitCode: 1, stdout: '', stderr: 'Type error in src/app.ts' };
      }
      return { exitCode: 0, stdout: 'ok', stderr: '' };
    };

    const result = await runDeterministicPreflight(worktree, executor, {
      baseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
    });

    expect(result.pass).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.testScriptPresent).toBe(true);
    expect(result.testPassed).toBe(true);
    expect(result.errors[0]).toContain('npm run typecheck failed');
    expect(calls).toEqual([
      `git diff --check ${'a'.repeat(40)}...${'b'.repeat(40)}`,
      'npm run typecheck',
      'npm run test',
    ]);
    expect(calls.join('\n')).not.toContain('deploy');
  });

  it('passes with only the git scope check when package.json is absent', async () => {
    const worktree = await createWorktree();
    const calls: string[] = [];
    const executor: CommandExecutor = async (file, args) => {
      calls.push(`${file} ${args.join(' ')}`);
      return { exitCode: 0, stdout: '', stderr: '' };
    };

    const result = await runDeterministicPreflight(worktree, executor, {
      baseSha: 'c'.repeat(40),
      headSha: 'd'.repeat(40),
    });

    expect(result.pass).toBe(true);
    expect(result.testScriptPresent).toBe(false);
    expect(result.testPassed).toBeUndefined();
    expect(calls).toEqual([`git diff --check ${'c'.repeat(40)}...${'d'.repeat(40)}`]);
  });

  it('fails closed on malformed package.json without executing package scripts', async () => {
    const worktree = await createWorktree();
    await writeFile(path.join(worktree, 'package.json'), '{not-json');
    const calls: string[] = [];
    const executor: CommandExecutor = async (file, args) => {
      calls.push(`${file} ${args.join(' ')}`);
      return { exitCode: 0, stdout: '', stderr: '' };
    };

    const result = await runDeterministicPreflight(worktree, executor);

    expect(result.pass).toBe(false);
    expect(result.errors[0]).toContain('package.json preflight failed');
    expect(calls).toEqual([]);
  });
});
