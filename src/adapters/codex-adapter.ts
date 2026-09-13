import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
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

const CODEX_REVIEW_OUTPUT_SCHEMA = {
  type: 'object',
  description:
    'Strict result for a read-only code review. APPROVE requires zero blocking issues and at least one concrete human verification check. CHANGES_REQUIRED is for actionable defects. NEEDS_USER_DECISION is only for genuine ambiguity or conflicting requirements.',
  additionalProperties: false,
  required: [
    'verdict',
    'summary',
    'blockingIssues',
    'warnings',
    'humanVerificationChecklist',
  ],
  properties: {
    verdict: {
      type: 'string',
      description: 'The final review verdict.',
      enum: ['APPROVE', 'CHANGES_REQUIRED', 'NEEDS_USER_DECISION'],
    },
    summary: { type: 'string', description: 'A concise summary grounded in the reviewed diff.' },
    blockingIssues: {
      type: 'array',
      description: 'Actionable correctness, security, or regression defects. Must be empty for APPROVE.',
      items: { type: 'string' },
    },
    warnings: {
      type: 'array',
      description: 'Non-blocking review observations.',
      items: { type: 'string' },
    },
    humanVerificationChecklist: {
      type: 'array',
      description:
        'Specific observable checks for the changed behavior in a running local application. Must contain at least one item for APPROVE.',
      items: { type: 'string' },
    },
  },
} as const;

/**
 * Extracts and parses structured review output from Codex.
 * Guarantees fail-safe fallback to NEEDS_USER_DECISION on malformed, missing, or invalid output.
 */
export function parseCodexReviewOutput(
  rawOutput: string,
  nativeApprovalChecklist: string[] = []
): CodexReviewResult {
  const fallbackResult: CodexReviewResult = {
    verdict: 'NEEDS_USER_DECISION',
    summary: 'Codex review output was empty, missing, or malformed. Failing safe to human review.',
    blockingIssues: [],
    warnings: [],
    humanVerificationChecklist: [],
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
    const nativeFindings = trimmed
      .split(/\n(?=- \[P[0-3]\] )/)
      .filter((block) => /^- \[P[0-3]\] /.test(block.trim()));
    if (nativeFindings.length > 0) {
      const firstFindingIndex = trimmed.search(/^- \[P[0-3]\] /m);
      const preamble = trimmed
        .slice(0, firstFindingIndex)
        .replace(/\s*Full review comments:\s*$/i, '')
        .trim();
      return {
        verdict: 'CHANGES_REQUIRED',
        summary: preamble || `Codex review found ${nativeFindings.length} actionable issue(s).`,
        blockingIssues: nativeFindings.map((finding) => finding.trim()),
        warnings: [],
        humanVerificationChecklist: [],
        parsedCleanly: true,
        rawOutput,
      };
    }

    if (/^No findings\.(?:\s|$)/i.test(trimmed) && nativeApprovalChecklist.length > 0) {
      const residualRisk = trimmed.replace(/^No findings\.\s*/i, '').trim();
      return {
        verdict: 'APPROVE',
        summary: 'Codex review found no actionable issues.',
        blockingIssues: [],
        warnings: residualRisk ? [residualRisk] : [],
        humanVerificationChecklist: nativeApprovalChecklist,
        parsedCleanly: true,
        rawOutput,
      };
    }

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
      humanVerificationChecklist: [],
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
        humanVerificationChecklist: [],
        parsedCleanly: false,
        rawOutput,
      };
    }
  }

  const rawChecklist = obj.humanVerificationChecklist || obj.human_verification_checklist || [];
  const humanVerificationChecklist: string[] = Array.isArray(rawChecklist)
    ? rawChecklist
        .map((item) => (typeof item === 'string' ? item.trim() : ''))
        .filter(Boolean)
        .slice(0, 12)
    : [];

  // A clean PR must include review-authored, concrete checks for the human handoff.
  if (normalizedVerdict === 'APPROVE' && humanVerificationChecklist.length === 0) {
    return {
      verdict: 'NEEDS_USER_DECISION',
      summary:
        'Invalid APPROVE review payload: humanVerificationChecklist must contain at least one concrete live verification item. Failing safe to human review.',
      blockingIssues: [],
      warnings: [],
      humanVerificationChecklist: [],
      parsedCleanly: false,
      rawOutput,
    };
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
    humanVerificationChecklist,
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
    '  "warnings": ["<list of non-blocking suggestions, stylistic notes, or warnings>"],',
    '  "humanVerificationChecklist": ["<concrete behavior a human should verify in the running local application>"]',
    '}',
    '```',
    'Verdict Criteria:',
    '- APPROVE: Code is clean, well-tested, adheres to architecture, and has zero blocking issues.',
    '- CHANGES_REQUIRED: Code contains bugs, test failures, security flaws, or defects that can be automatically fixed.',
    '- NEEDS_USER_DECISION: Ambiguity, architectural tradeoffs, or conflicting requirements require human decision.',
    '- For APPROVE, humanVerificationChecklist must contain one or more specific, observable checks tailored to the changed behavior. These checks will be run by Anti in a localhost development environment and shown to the human before merge.'
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
    // Repository-wide reviews routinely exceed two minutes. A short timeout can
    // make Codex handle SIGTERM and exit 0 before emitting its final response,
    // which is otherwise indistinguishable from a successful empty review.
    const timeoutMs = options.timeoutMs ?? 600000;

    const outputDir = await mkdtemp(path.join(tmpdir(), 'codex-anti-review-'));
    const schemaPath = path.join(outputDir, 'schema.json');
    const lastMessagePath = path.join(outputDir, 'last-message.json');

    try {
      await writeFile(schemaPath, JSON.stringify(CODEX_REVIEW_OUTPUT_SCHEMA), { mode: 0o600 });

      // The dedicated review subcommand computes the branch diff itself and is
      // read-only. Keep it isolated from unrelated user plugins and tools, and
      // persist the final message because stdout is not a stable API across
      // Codex CLI versions or graceful timeout handling.
      const args = [
        'exec',
        'review',
        '--base',
        options.baseBranch || 'main',
        '--ignore-user-config',
        '--ephemeral',
        '--disable',
        'plugins',
        '--disable',
        'apps',
        '--disable',
        'memories',
        '--disable',
        'multi_agent',
        '--disable',
        'browser_use',
        '--disable',
        'computer_use',
        '--disable',
        'image_generation',
        '--disable',
        'hooks',
        '--output-schema',
        schemaPath,
        '--output-last-message',
        lastMessagePath,
      ];

      const execResult = await executor('codex', args, {
        cwd: options.worktreePath,
        timeoutMs,
        rejectForbiddenFlags: true,
      });
      const persistedOutput = await readFile(lastMessagePath, 'utf8').catch(() => '');
      const reviewOutput = persistedOutput.trim() ? persistedOutput : execResult.stdout;

      if (execResult.timedOut || execResult.error || execResult.exitCode !== 0) {
        const executionReason = execResult.timedOut
          ? `timed out after ${timeoutMs}ms`
          : `exit code ${execResult.exitCode}`;
        return {
          verdict: 'NEEDS_USER_DECISION',
          summary: `Codex review execution error (${executionReason}): ${execResult.stderr.trim() || reviewOutput.trim() || execResult.error?.message || 'Unknown error'}`,
          blockingIssues: [],
          warnings: [],
          humanVerificationChecklist: [],
          parsedCleanly: false,
          rawOutput: reviewOutput || execResult.stderr,
        };
      }

      if (!reviewOutput.trim()) {
        return {
          verdict: 'NEEDS_USER_DECISION',
          summary:
            'Codex review process exited successfully without a final response in either the output file or stdout. Failing safe to human review.',
          blockingIssues: [],
          warnings: [],
          humanVerificationChecklist: [],
          parsedCleanly: false,
          rawOutput: '',
        };
      }

      const taskRequirement = options.taskPrompt?.trim();
      const nativeApprovalChecklist = taskRequirement
        ? [
            `In the running local application, verify this reviewed requirement is satisfied without runtime or console errors: ${taskRequirement.slice(0, 600)}`,
          ]
        : [];
      return parseCodexReviewOutput(reviewOutput, nativeApprovalChecklist);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  }
}
