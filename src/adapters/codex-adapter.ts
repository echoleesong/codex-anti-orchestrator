import type {
  CodexReviewOptions,
  CodexReviewResult,
  CodexVerdict,
  CommandExecutor,
} from '../types.js';
import { defaultExecutor } from '../utils/exec.js';

const VALID_VERDICTS: readonly CodexVerdict[] = [
  'APPROVE',
  'CHANGES_REQUIRED',
  'NEEDS_USER_DECISION',
];

/**
 * Extracts and parses structured review output from Codex.
 * Guarantees fail-safe fallback to NEEDS_USER_DECISION on malformed, missing, or invalid output.
 */
export function parseCodexReviewOutput(rawOutput: string): CodexReviewResult {
  const fallbackResult: CodexReviewResult = {
    verdict: 'NEEDS_USER_DECISION',
    summary: 'Codex review output was empty, missing, or malformed. Failing safe to human review.',
    blockingIssues: [],
    warnings: [],
    parsedCleanly: false,
    rawOutput: rawOutput || '',
  };

  if (!rawOutput || typeof rawOutput !== 'string' || !rawOutput.trim()) {
    return fallbackResult;
  }

  const trimmed = rawOutput.trim();

  // Attempt to parse JSON directly or from markdown ```json ``` blocks
  let parsed: unknown = null;

  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Try extracting JSON block
    const jsonMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (jsonMatch && jsonMatch[1]) {
      try {
        parsed = JSON.parse(jsonMatch[1].trim());
      } catch {
        // Fallback below
      }
    } else {
      // Try searching for first { and last }
      const firstBrace = trimmed.indexOf('{');
      const lastBrace = trimmed.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace > firstBrace) {
        try {
          parsed = JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
        } catch {
          // Fallback below
        }
      }
    }
  }

  if (!parsed || typeof parsed !== 'object') {
    return {
      ...fallbackResult,
      summary:
        'Failed to parse structured JSON from Codex review output. Falling safe to NEEDS_USER_DECISION.',
    };
  }

  const obj = parsed as Record<string, unknown>;

  // Extract and validate verdict
  let rawVerdict = typeof obj.verdict === 'string' ? obj.verdict.trim().toUpperCase() : '';
  // Check for common alternative keys
  if (!rawVerdict && typeof obj.status === 'string') {
    rawVerdict = obj.status.trim().toUpperCase();
  }

  // Normalize verdict
  let normalizedVerdict: CodexVerdict | undefined;
  if (rawVerdict === 'APPROVE' || rawVerdict === 'APPROVED') {
    normalizedVerdict = 'APPROVE';
  } else if (
    rawVerdict === 'CHANGES_REQUIRED' ||
    rawVerdict === 'REJECT' ||
    rawVerdict === 'REJECTED' ||
    rawVerdict === 'NEEDS_CHANGES'
  ) {
    normalizedVerdict = 'CHANGES_REQUIRED';
  } else if (
    rawVerdict === 'NEEDS_USER_DECISION' ||
    rawVerdict === 'DECISION_REQUIRED' ||
    rawVerdict === 'MANUAL_REVIEW'
  ) {
    normalizedVerdict = 'NEEDS_USER_DECISION';
  }

  // If verdict is not recognized, fail safe to NEEDS_USER_DECISION
  if (!normalizedVerdict || !VALID_VERDICTS.includes(normalizedVerdict)) {
    return {
      verdict: 'NEEDS_USER_DECISION',
      summary: `Invalid or missing review verdict ("${String(obj.verdict)}"). Failing safe to NEEDS_USER_DECISION.`,
      blockingIssues: [],
      warnings: [],
      parsedCleanly: false,
      rawOutput,
    };
  }

  // Invariant: For APPROVE, require an explicitly present blockingIssues array containing only strings and zero entries
  if (normalizedVerdict === 'APPROVE') {
    const hasValidBlockingIssues =
      'blockingIssues' in obj &&
      Array.isArray(obj.blockingIssues) &&
      obj.blockingIssues.length === 0 &&
      obj.blockingIssues.every((item) => typeof item === 'string');

    if (!hasValidBlockingIssues) {
      const rawBlockers = obj.blockingIssues;
      const extractedBlockers = Array.isArray(rawBlockers)
        ? rawBlockers.map((b) => (typeof b === 'string' ? b : JSON.stringify(b))).filter(Boolean)
        : [];
      return {
        verdict: 'NEEDS_USER_DECISION',
        summary:
          'Invalid APPROVE review payload: blockingIssues must be an explicitly present empty array of strings. Failing safe to NEEDS_USER_DECISION.',
        blockingIssues: extractedBlockers,
        warnings: Array.isArray(obj.warnings)
          ? obj.warnings.map((w) => (typeof w === 'string' ? w : JSON.stringify(w))).filter(Boolean)
          : [],
        parsedCleanly: false,
        rawOutput,
      };
    }
  }

  // Extract blocking issues
  const rawBlockers = obj.blockingIssues || obj.blocking_issues || obj.issues || obj.blockers || [];
  const blockingIssues: string[] = Array.isArray(rawBlockers)
    ? rawBlockers.map((b) => (typeof b === 'string' ? b : JSON.stringify(b))).filter(Boolean)
    : [];

  // Extract warnings
  const rawWarnings = obj.warnings || obj.suggestions || [];
  const warnings: string[] = Array.isArray(rawWarnings)
    ? rawWarnings.map((w) => (typeof w === 'string' ? w : JSON.stringify(w))).filter(Boolean)
    : [];

  const summary =
    typeof obj.summary === 'string' && obj.summary.trim()
      ? obj.summary.trim()
      : `Review completed with verdict: ${normalizedVerdict}`;

  return {
    verdict: normalizedVerdict,
    summary,
    blockingIssues: normalizedVerdict === 'APPROVE' ? [] : blockingIssues,
    warnings,
    parsedCleanly: true,
    rawOutput,
  };
}

/**
 * Constructs the structured review prompt for Codex execution in read-only sandbox mode.
 */
export function buildCodexReviewPrompt(
  options: {
    baseBranch?: string;
    targetBranch?: string;
    diff?: string;
  } = {}
): string {
  const baseBranch = options.baseBranch || 'main';
  const lines: string[] = [
    'You are performing an automated, strictly read-only code review of changes in this repository worktree.',
    `Review the full code diff from the base branch ("${baseBranch}")${options.targetBranch ? ` to the task branch ("${options.targetBranch}")` : ''}.`,
  ];

  if (options.diff) {
    lines.push('Code Diff to review:');
    lines.push('```diff');
    lines.push(options.diff.trim());
    lines.push('```');
  }

  lines.push(
    '',
    'Review all changed files, tests, and documentation for correctness, security, style, and regressions.',
    'You MUST respond with a JSON object strictly matching this schema:',
    '```json',
    '{',
    '  "verdict": "APPROVE" | "CHANGES_REQUIRED" | "NEEDS_USER_DECISION",',
    '  "summary": "<Concise summary of review findings>",',
    '  "blockingIssues": ["<list of any blocking security, functional, or stability issues>"],',
    '  "warnings": ["<list of non-blocking suggestions, stylistic notes, or warnings>"]',
    '}',
    '```',
    'Verdict Criteria:',
    '- APPROVE: Code is clean, well-tested, adheres to architecture, and has zero blocking issues.',
    '- CHANGES_REQUIRED: Code contains bugs, test failures, security flaws, or defects that can be automatically fixed.',
    '- NEEDS_USER_DECISION: Ambiguity, architectural tradeoffs, or conflicting requirements require human decision.'
  );

  return lines.join('\n');
}

export class CodexAdapter {
  private executor: CommandExecutor;

  constructor(executor: CommandExecutor = defaultExecutor) {
    this.executor = executor;
  }

  /**
   * Invokes Codex using 'codex exec --sandbox read-only' to perform a read-only code review.
   * Enforces argument arrays, read-only sandbox permissions, and fail-closed parsing.
   */
  async review(options: CodexReviewOptions): Promise<CodexReviewResult> {
    const executor = options.executor || this.executor;
    const timeoutMs = options.timeoutMs ?? 120000; // 2 minutes default

    const prompt = buildCodexReviewPrompt({
      baseBranch: options.baseBranch,
      targetBranch: options.prNumberOrBranch,
      diff: options.diff,
    });

    // Strict command invariant: uses 'codex exec --sandbox read-only <prompt>'
    const args = ['exec', '--sandbox', 'read-only', prompt];

    const execResult = await executor('codex', args, {
      cwd: options.worktreePath,
      timeoutMs,
      rejectForbiddenFlags: true,
    });

    if (execResult.error || execResult.exitCode !== 0) {
      return {
        verdict: 'NEEDS_USER_DECISION',
        summary: `Codex review execution error (exit code ${execResult.exitCode}): ${execResult.stderr.trim() || execResult.stdout.trim() || execResult.error?.message || 'Unknown error'}`,
        blockingIssues: [],
        warnings: [],
        parsedCleanly: false,
        rawOutput: execResult.stdout || execResult.stderr,
      };
    }

    return parseCodexReviewOutput(execResult.stdout);
  }
}
