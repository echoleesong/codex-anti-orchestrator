import type {
  CommandExecutor,
  CreatePROptions,
  PRChecksResult,
  PROperationResult,
  UpdatePROptions,
  ViewPROptions,
} from '../types.js';
import { defaultExecutor } from '../utils/exec.js';

export const PROTECTED_BRANCHES: readonly string[] = [
  'main',
  'master',
  'release',
  'production',
  'prod',
  'develop',
];

export const FORBIDDEN_GH_ACTIONS: readonly string[] = [
  'merge',
  'workflow',
  'release',
  'deploy',
  'dispatch',
  'publish',
];

/**
 * Validates that the branch is not a protected branch and follows the task branch convention (anti/*).
 */
export function validateSafeBranchForPush(branch: string): void {
  if (!branch || typeof branch !== 'string') {
    throw new Error('Branch name must be a non-empty string.');
  }

  const normalized = branch.trim().toLowerCase();

  // 1. Strictly block pushes to protected branches
  if (PROTECTED_BRANCHES.includes(normalized)) {
    throw new Error(
      `Security violation: Direct pushes to protected branch "${branch}" are strictly forbidden.`
    );
  }

  // 2. Enforce anti/* branch naming policy
  if (!normalized.startsWith('anti/')) {
    throw new Error(
      `Security violation: Orchestrator branches must follow the "anti/<task-id>" naming convention (attempted: "${branch}").`
    );
  }
}

/**
 * Validates that an operation does not attempt forbidden merge, workflow, release, or deploy actions.
 */
export function assertAllowedPROperation(action: string): void {
  const normalized = action.toLowerCase();
  for (const forbidden of FORBIDDEN_GH_ACTIONS) {
    if (normalized.includes(forbidden)) {
      throw new Error(
        `Security violation: Operation "${action}" involves forbidden action "${forbidden}". Automated merge, release, and deploy are strictly prohibited.`
      );
    }
  }
}

export class GitHubPRAdapter {
  private executor: CommandExecutor;

  constructor(executor: CommandExecutor = defaultExecutor) {
    this.executor = executor;
  }

  /**
   * Pushes the isolated task branch to the remote origin safely.
   */
  async pushTaskBranch(
    worktreePath: string,
    branchName: string,
    executor: CommandExecutor = this.executor
  ): Promise<PROperationResult> {
    validateSafeBranchForPush(branchName);

    const args = ['push', '--set-upstream', 'origin', branchName];
    const res = await executor('git', args, { cwd: worktreePath });

    if (res.exitCode !== 0 || res.error) {
      return {
        success: false,
        error: `Failed to push branch "${branchName}": ${res.stderr.trim() || res.stdout.trim() || res.error?.message || 'Git push error'}`,
      };
    }

    return {
      success: true,
    };
  }

  /**
   * Creates a new Pull Request for the task branch via gh pr create.
   */
  async createPR(options: CreatePROptions): Promise<PROperationResult> {
    validateSafeBranchForPush(options.branch);
    assertAllowedPROperation('create');

    const executor = options.executor || this.executor;
    const baseBranch = options.baseBranch || 'main';

    const args = [
      'pr',
      'create',
      '--head',
      options.branch,
      '--base',
      baseBranch,
      '--title',
      options.title,
      '--body',
      options.body,
    ];

    const res = await executor('gh', args, { cwd: options.worktreePath });

    if (res.exitCode !== 0 || res.error) {
      return {
        success: false,
        error: `Failed to create PR: ${res.stderr.trim() || res.stdout.trim() || res.error?.message || 'gh pr create failed'}`,
      };
    }

    const output = res.stdout.trim();
    // Parse PR URL from output (e.g. https://github.com/owner/repo/pull/123)
    const urlMatch = output.match(/https:\/\/github\.com\/[^\s\/]+\/[^\s\/]+\/pull\/(\d+)/);
    const prUrl = urlMatch ? urlMatch[0] : output;
    const prNumber = urlMatch ? parseInt(urlMatch[1], 10) : undefined;

    return {
      success: true,
      prUrl,
      prNumber,
      title: options.title,
      body: options.body,
    };
  }

  /**
   * Views Pull Request metadata via gh pr view.
   */
  async viewPR(options: ViewPROptions): Promise<PROperationResult> {
    assertAllowedPROperation('view');
    const executor = options.executor || this.executor;

    const args = ['pr', 'view', options.prNumberOrBranch, '--json', 'number,title,body,state,url'];

    const res = await executor('gh', args, { cwd: options.worktreePath });

    if (res.exitCode !== 0 || res.error) {
      return {
        success: false,
        error: `Failed to view PR: ${res.stderr.trim() || res.stdout.trim() || res.error?.message || 'gh pr view failed'}`,
      };
    }

    try {
      const parsed = JSON.parse(res.stdout.trim()) as {
        number?: number;
        title?: string;
        body?: string;
        state?: string;
        url?: string;
      };

      return {
        success: true,
        prNumber: parsed.number,
        title: parsed.title,
        body: parsed.body,
        state: parsed.state,
        prUrl: parsed.url,
      };
    } catch {
      return {
        success: true,
        prUrl: res.stdout.trim(),
      };
    }
  }

  /**
   * Updates Pull Request metadata or appends feedback comments.
   */
  async updatePR(options: UpdatePROptions): Promise<PROperationResult> {
    assertAllowedPROperation('update');
    const executor = options.executor || this.executor;

    // 1. Edit PR title / body if provided
    if (options.title || options.body) {
      const editArgs = ['pr', 'edit'];
      if (options.prNumberOrBranch) {
        editArgs.push(options.prNumberOrBranch);
      }
      if (options.title) {
        editArgs.push('--title', options.title);
      }
      if (options.body) {
        editArgs.push('--body', options.body);
      }

      const editRes = await executor('gh', editArgs, { cwd: options.worktreePath });
      if (editRes.exitCode !== 0 || editRes.error) {
        return {
          success: false,
          error: `Failed to edit PR: ${editRes.stderr.trim() || editRes.stdout.trim() || 'gh pr edit failed'}`,
        };
      }
    }

    // 2. Add comment if provided
    if (options.comment) {
      const commentArgs = ['pr', 'comment'];
      if (options.prNumberOrBranch) {
        commentArgs.push(options.prNumberOrBranch);
      }
      commentArgs.push('--body', options.comment);

      const commentRes = await executor('gh', commentArgs, { cwd: options.worktreePath });
      if (commentRes.exitCode !== 0 || commentRes.error) {
        return {
          success: false,
          error: `Failed to post PR comment: ${commentRes.stderr.trim() || commentRes.stdout.trim() || 'gh pr comment failed'}`,
        };
      }
    }

    return {
      success: true,
      title: options.title,
      body: options.body,
    };
  }

  /**
   * Inspects PR CI check status via gh pr checks.
   */
  async getPRChecks(
    worktreePath: string,
    prNumberOrBranch?: string,
    executor: CommandExecutor = this.executor
  ): Promise<PRChecksResult> {
    assertAllowedPROperation('checks');

    const args = ['pr', 'checks'];
    if (prNumberOrBranch) {
      args.push(prNumberOrBranch);
    }
    args.push('--json', 'bucket,completedAt,description,event,link,name,startedAt,state,workflow');

    const res = await executor('gh', args, { cwd: worktreePath });

    if (res.exitCode !== 0 || res.error) {
      return {
        success: false,
        allPassing: false,
        checks: [],
        error: `Failed to get PR checks: ${res.stderr.trim() || res.stdout.trim() || res.error?.message || 'gh pr checks failed'}`,
      };
    }

    const rawOutput = res.stdout.trim();
    if (!rawOutput) {
      return {
        success: false,
        allPassing: false,
        checks: [],
        error: 'No check output returned by gh pr checks (failing closed).',
      };
    }

    try {
      const parsed: unknown = JSON.parse(rawOutput);

      if (!Array.isArray(parsed) || parsed.length === 0) {
        return {
          success: false,
          allPassing: false,
          checks: [],
          error: 'No CI checks found or invalid check data format (failing closed).',
        };
      }

      for (const item of parsed) {
        if (!item || typeof item !== 'object') {
          return {
            success: false,
            allPassing: false,
            checks: [],
            error:
              'Malformed check entry in PR checks: check item must be an object (failing closed).',
          };
        }
        const c = item as Record<string, unknown>;
        if (
          typeof c.name !== 'string' ||
          !c.name.trim() ||
          typeof c.state !== 'string' ||
          !c.state.trim() ||
          typeof c.bucket !== 'string' ||
          !c.bucket.trim()
        ) {
          return {
            success: false,
            allPassing: false,
            checks: [],
            error: `Malformed check entry in PR checks: missing or empty required name, state, or bucket fields: ${JSON.stringify(c)} (failing closed).`,
          };
        }
      }

      const checks = (parsed as Array<Record<string, unknown>>).map((c) => {
        const name = (c.name as string).trim();
        const state = (c.state as string).trim();
        const bucket = (c.bucket as string).trim();
        const description = typeof c.description === 'string' ? c.description.trim() : undefined;
        const link = typeof c.link === 'string' ? c.link.trim() : undefined;
        const workflow = typeof c.workflow === 'string' ? c.workflow.trim() : undefined;
        const status = typeof c.status === 'string' ? c.status.trim() : state;
        const conclusion = typeof c.conclusion === 'string' ? c.conclusion.trim() : bucket;

        return {
          name,
          state,
          bucket,
          description,
          link,
          workflow,
          status,
          conclusion,
        };
      });

      const passingStates = ['success', 'neutral', 'pass', 'completed'];
      const allPassing =
        checks.length > 0 &&
        checks.every(
          (c) => c.bucket.toLowerCase() === 'pass' && passingStates.includes(c.state.toLowerCase())
        );

      return {
        success: true,
        allPassing,
        checks,
      };
    } catch (err) {
      return {
        success: false,
        allPassing: false,
        checks: [],
        error: `Failed to parse PR checks JSON: ${err instanceof Error ? err.message : String(err)} (failing closed).`,
      };
    }
  }
}
