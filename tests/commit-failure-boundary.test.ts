import { describe, expect, it } from 'vitest';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import type { CommandExecutor } from '../src/types.js';

describe('git commit failure boundary', () => {
  it('throws on a real git commit failure instead of reporting a no-change result', async () => {
    const executor: CommandExecutor = async (file, args) => {
      const command = `${file} ${args.join(' ')}`;
      if (command === 'git status --porcelain') {
        return { exitCode: 0, stdout: 'M  src/feature.ts\n', stderr: '' };
      }
      if (command.startsWith('git add --')) {
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (command === 'git diff --cached --name-only') {
        return { exitCode: 0, stdout: 'src/feature.ts\n', stderr: '' };
      }
      if (command.startsWith('git commit -m')) {
        return { exitCode: 1, stdout: '', stderr: 'pre-commit hook rejected the commit' };
      }
      throw new Error(`Unexpected command: ${command}`);
    };

    const orchestrator = new Orchestrator({ executor });

    await expect(
      orchestrator.commitWorktreeChanges(
        '/isolated/worktree',
        'fix: preserve commit failures',
        executor
      )
    ).rejects.toThrow(
      /Failed to commit validated staged changes.*pre-commit hook rejected the commit/
    );
  });
});
