import { describe, expect, it } from 'vitest';
import { CodexAdapter, parseCodexReviewOutput } from '../src/adapters/codex-adapter.js';
import type { CommandExecutor } from '../src/types.js';

describe('OpenAI Codex CLI (codex) Adapter & Review Parser', () => {
  describe('parseCodexReviewOutput', () => {
    it('should parse valid APPROVE verdict with no blocking issues', () => {
      const output = JSON.stringify({
        verdict: 'APPROVE',
        summary: 'All changes are clean, tests pass, and adhere to architecture.',
        blockingIssues: [],
        warnings: ['Consider adding more comments in helper.'],
      });

      const res = parseCodexReviewOutput(output);
      expect(res.verdict).toBe('APPROVE');
      expect(res.parsedCleanly).toBe(true);
      expect(res.blockingIssues.length).toBe(0);
      expect(res.warnings.length).toBe(1);
      expect(res.summary).toContain('All changes are clean');
    });

    it('should parse valid CHANGES_REQUIRED verdict with blocking issues', () => {
      const output = JSON.stringify({
        verdict: 'CHANGES_REQUIRED',
        summary: 'Found potential memory leak and unhandled promise rejection.',
        blockingIssues: ['Unhandled rejection in fetchUser()', 'Unbounded array growth in cache'],
        warnings: [],
      });

      const res = parseCodexReviewOutput(output);
      expect(res.verdict).toBe('CHANGES_REQUIRED');
      expect(res.parsedCleanly).toBe(true);
      expect(res.blockingIssues.length).toBe(2);
      expect(res.blockingIssues).toContain('Unhandled rejection in fetchUser()');
    });

    it('should parse valid NEEDS_USER_DECISION verdict', () => {
      const output = JSON.stringify({
        verdict: 'NEEDS_USER_DECISION',
        summary: 'Architectural tradeoff required between performance and memory.',
        blockingIssues: [],
        warnings: ['High memory footprint under heavy load'],
      });

      const res = parseCodexReviewOutput(output);
      expect(res.verdict).toBe('NEEDS_USER_DECISION');
      expect(res.parsedCleanly).toBe(true);
      expect(res.summary).toContain('Architectural tradeoff');
    });

    it('should downgrade APPROVE to CHANGES_REQUIRED if blocking issues are present', () => {
      const output = JSON.stringify({
        verdict: 'APPROVE',
        summary: 'Looks good but please fix security issue.',
        blockingIssues: ['Hardcoded password found in config'],
        warnings: [],
      });

      const res = parseCodexReviewOutput(output);
      expect(res.verdict).toBe('CHANGES_REQUIRED');
      expect(res.blockingIssues.length).toBe(1);
    });

    it('should extract JSON embedded in markdown code fences', () => {
      const output = `
Here is my review:

\`\`\`json
{
  "verdict": "APPROVE",
  "summary": "Code looks great and passes all static analysis.",
  "blockingIssues": [],
  "warnings": []
}
\`\`\`

Thanks!
`;
      const res = parseCodexReviewOutput(output);
      expect(res.verdict).toBe('APPROVE');
      expect(res.parsedCleanly).toBe(true);
    });

    it('should fail safe to NEEDS_USER_DECISION on empty or blank output', () => {
      expect(parseCodexReviewOutput('').verdict).toBe('NEEDS_USER_DECISION');
      expect(parseCodexReviewOutput('   \n  ').verdict).toBe('NEEDS_USER_DECISION');
      expect(parseCodexReviewOutput('').parsedCleanly).toBe(false);
    });

    it('should fail safe to NEEDS_USER_DECISION on malformed or corrupted JSON output', () => {
      const malformed =
        'Random unformatted text without valid json: { verdict: APPROVE, summary: incomplete';
      const res = parseCodexReviewOutput(malformed);
      expect(res.verdict).toBe('NEEDS_USER_DECISION');
      expect(res.parsedCleanly).toBe(false);
      expect(res.summary).toContain('Failed to parse structured JSON');
    });

    it('should fail safe to NEEDS_USER_DECISION on unrecognized verdict string', () => {
      const invalidVerdict = JSON.stringify({
        verdict: 'UNKNOWN_CUSTOM_STATUS',
        summary: 'Something unknown',
      });
      const res = parseCodexReviewOutput(invalidVerdict);
      expect(res.verdict).toBe('NEEDS_USER_DECISION');
      expect(res.parsedCleanly).toBe(false);
      expect(res.summary).toContain('Invalid or missing review verdict');
    });
  });

  describe('CodexAdapter execution', () => {
    it('should invoke codex in read-only sandbox mode and parse review results', async () => {
      const executedArgs: string[][] = [];

      const mockExecutor: CommandExecutor = async (file, args) => {
        executedArgs.push(args);
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            verdict: 'APPROVE',
            summary: 'Clean implementation with zero issues.',
            blockingIssues: [],
            warnings: [],
          }),
          stderr: '',
        };
      };

      const adapter = new CodexAdapter(mockExecutor);
      const res = await adapter.review({
        worktreePath: '/fake/worktree',
        prNumberOrBranch: 'anti/task-123',
      });

      expect(res.verdict).toBe('APPROVE');
      expect(res.parsedCleanly).toBe(true);
      expect(executedArgs.length).toBe(1);

      const args = executedArgs[0];
      expect(args).toContain('review');
      expect(args).toContain('--read-only');
      expect(args).toContain('--format');
      expect(args).toContain('json');
      expect(args).toContain('--target');
      expect(args).toContain('anti/task-123');
    });

    it('should fail safe to NEEDS_USER_DECISION when codex execution fails or crashes', async () => {
      const mockExecutor: CommandExecutor = async () => ({
        exitCode: 1,
        stdout: '',
        stderr: 'fatal: connection to review daemon lost',
      });

      const adapter = new CodexAdapter(mockExecutor);
      const res = await adapter.review({
        worktreePath: '/fake/worktree',
      });

      expect(res.verdict).toBe('NEEDS_USER_DECISION');
      expect(res.parsedCleanly).toBe(false);
      expect(res.summary).toContain('Codex review execution error');
    });
  });
});
