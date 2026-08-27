import { describe, expect, it } from 'vitest';
import {
  buildCodexReviewPrompt,
  CodexAdapter,
  parseCodexReviewOutput,
} from '../src/adapters/codex-adapter.js';
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
    it('should construct arguments strictly matching the codex exec --sandbox read-only contract', async () => {
      const executedFiles: string[] = [];
      const executedArgs: string[][] = [];

      const mockExecutor: CommandExecutor = async (file, args) => {
        executedFiles.push(file);
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
      expect(executedFiles.length).toBe(1);
      expect(executedFiles[0]).toBe('codex');

      const args = executedArgs[0];
      expect(args[0]).toBe('exec');
      expect(args[1]).toBe('--sandbox');
      expect(args[2]).toBe('read-only');
      expect(typeof args[3]).toBe('string');
      expect(args[3]).toContain('strictly read-only code review');
      expect(args[3]).toContain('anti/task-123');
      expect(args[3]).toContain('"verdict": "APPROVE"');
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

  describe('buildCodexReviewPrompt', () => {
    it('should explicitly ask for full diff from base branch to task branch', () => {
      const prompt = buildCodexReviewPrompt({
        baseBranch: 'main',
        targetBranch: 'anti/task-123',
      });
      expect(prompt).toContain(
        'Review the full code diff from the base branch ("main") to the task branch ("anti/task-123").'
      );
      expect(prompt).toContain('strictly read-only code review');
      expect(prompt).toContain('"verdict": "APPROVE" | "CHANGES_REQUIRED" | "NEEDS_USER_DECISION"');
    });

    it('should default baseBranch to main when omitted', () => {
      const prompt = buildCodexReviewPrompt({
        targetBranch: 'anti/task-456',
      });
      expect(prompt).toContain(
        'Review the full code diff from the base branch ("main") to the task branch ("anti/task-456").'
      );
    });

    it('should handle review prompt without target branch', () => {
      const prompt = buildCodexReviewPrompt({
        baseBranch: 'release-1.0',
      });
      expect(prompt).toContain('Review the full code diff from the base branch ("release-1.0").');
    });

    it('should embed diff fence when diff is provided', () => {
      const prompt = buildCodexReviewPrompt({
        baseBranch: 'develop',
        targetBranch: 'anti/task-789',
        diff: '--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new',
      });
      expect(prompt).toContain(
        'Review the full code diff from the base branch ("develop") to the task branch ("anti/task-789").'
      );
      expect(prompt).toContain('Code Diff to review:');
      expect(prompt).toContain('```diff');
      expect(prompt).toContain('+new');
    });
  });
});
