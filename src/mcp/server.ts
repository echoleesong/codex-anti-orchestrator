import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { MonitorAutoLauncher } from '../monitor/auto-launch.js';
import { Orchestrator } from '../orchestrator/orchestrator.js';
import type { IOrchestrator, OrchestratorMcpServerOptions } from '../types.js';
import { redactSecrets } from '../utils/exec.js';

export const MCP_SERVER_NAME = 'codex-anti-orchestrator';
export const MCP_SERVER_VERSION = '0.1.0';

export interface McpSuccessPayload<T> {
  ok: true;
  data: T;
}

export interface McpErrorPayload {
  ok: false;
  error: {
    code: string;
    message: string;
  };
}

/**
 * Formats a successful MCP tool response as stable JSON text.
 */
export function formatSuccessResponse<T>(data: T, monitor?: { url: string; opened: boolean }) {
  const payload: McpSuccessPayload<T> = {
    ok: true,
    data,
  };
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(monitor ? { ...payload, monitor } : payload, null, 2),
      },
    ],
  };
}

/**
 * Formats an MCP error response as stable JSON text with a bounded safe message,
 * structured error code, and automated credential/secret redaction without raw stacks.
 */
export function formatErrorResponse(error: unknown) {
  let rawMessage = '';
  if (error instanceof Error) {
    rawMessage = error.message;
  } else if (typeof error === 'string') {
    rawMessage = error;
  } else {
    rawMessage = String(error ?? 'Unknown error occurred');
  }

  // Strip any raw stack trace lines if present
  const messageWithoutStack = rawMessage.split(/\n\s*at\s+/)[0]?.trim() || rawMessage.trim();

  // Redact secrets and bound message length
  const safeMessage = redactSecrets(messageWithoutStack).slice(0, 1000);

  // Derive stable error code
  let code = 'ORCHESTRATION_ERROR';
  if (/task not found/i.test(safeMessage)) {
    code = 'TASK_NOT_FOUND';
  } else if (
    /invalid.*path|outside.*allowed|not a valid git repository|isolation/i.test(safeMessage)
  ) {
    code = 'INVALID_PATH';
  } else if (/cannot resume|cannot transition|invalid state|unhandled state/i.test(safeMessage)) {
    code = 'INVALID_STATE';
  } else if (/lock.*detected|index\.lock/i.test(safeMessage)) {
    code = 'GIT_LOCK_ERROR';
  } else if (/dirty|uncommitted/i.test(safeMessage)) {
    code = 'REPO_DIRTY';
  } else if (/empty|invalid|unrecognized|validation|schema/i.test(safeMessage)) {
    code = 'VALIDATION_ERROR';
  }

  const payload: McpErrorPayload = {
    ok: false,
    error: {
      code,
      message: safeMessage || 'An orchestration error occurred.',
    },
  };

  return {
    isError: true,
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

/**
 * Creates and configures the Orchestrator MCP server instance.
 * Exposes strictly the 6 authorized orchestration tools.
 * Safe input schemas, structured error mapping, and dependency injection supported.
 */
export function createOrchestratorMcpServer(options: OrchestratorMcpServerOptions = {}): McpServer {
  const orchestrator: IOrchestrator =
    options.orchestrator ||
    new Orchestrator({
      stateDir: options.stateDir,
      allowedBaseDir: options.allowedBaseDir,
      executor: options.executor,
    });

  const server = new McpServer({
    name: options.serverInfo?.name || MCP_SERVER_NAME,
    version: options.serverInfo?.version || MCP_SERVER_VERSION,
  });
  const monitorLauncher =
    options.monitorLauncher ||
    new MonitorAutoLauncher({ stateDir: orchestrator.getStateDir?.() || '' });
  const runWithMonitor = async <T>(operation: () => Promise<T>) => {
    let monitor: { url: string; opened: boolean } | undefined;
    try {
      monitor = await monitorLauncher.ensureStarted();
    } catch (error) {
      // Monitoring must never prevent a task from safely returning its own state or diagnostics.
      process.stderr.write(
        `codex-anti-orchestrator monitor unavailable: ${
          error instanceof Error ? error.message : String(error)
        }\n`
      );
    }
    try {
      return formatSuccessResponse(await operation(), monitor);
    } catch (error) {
      return formatErrorResponse(error);
    }
  };

  // 1. orchestrator_create_task (repoPath, prompt, optional baseBranch)
  server.registerTool(
    'orchestrator_create_task',
    {
      description:
        'Creates a new orchestrated development task, validates repository cleanliness and lockfile safety, and allocates an isolated external Git worktree.',
      inputSchema: z
        .object({
          repoPath: z
            .string()
            .min(1, 'repoPath must not be empty')
            .describe(
              'Absolute path to the target Git repository (must reside in allowed base directory)'
            ),
          prompt: z
            .string()
            .min(1, 'prompt must not be empty')
            .describe(
              'Development task instructions describing desired code changes, features, or bugfixes'
            ),
          baseBranch: z
            .string()
            .min(1, 'baseBranch must not be empty')
            .optional()
            .describe(
              'Optional base branch for the external worktree (defaults to repository HEAD branch)'
            ),
        })
        .strict(),
    },
    async (args) =>
      runWithMonitor(async () =>
        orchestrator.createTask({
          repoPath: args.repoPath,
          prompt: args.prompt,
          baseBranch: args.baseBranch,
        })
      )
  );

  // 2. orchestrator_run_task (taskId)
  server.registerTool(
    'orchestrator_run_task',
    {
      description:
        'Executes the automated development, GitHub PR creation, and Codex review state loop for an existing task.',
      inputSchema: z
        .object({
          taskId: z
            .string()
            .min(1, 'taskId must not be empty')
            .describe('Unique identifier of the task to execute'),
        })
        .strict(),
    },
    async (args) => runWithMonitor(() => orchestrator.runTaskLoop(args.taskId))
  );

  // 3. orchestrator_get_task_status (taskId)
  server.registerTool(
    'orchestrator_get_task_status',
    {
      description:
        'Retrieves the current status, state machine history, and diagnostics for a specific task.',
      inputSchema: z
        .object({
          taskId: z
            .string()
            .min(1, 'taskId must not be empty')
            .describe('Unique identifier of the task to query'),
        })
        .strict(),
    },
    async (args) => runWithMonitor(() => orchestrator.getTask(args.taskId))
  );

  // 4. orchestrator_list_tasks (no arbitrary filters)
  server.registerTool(
    'orchestrator_list_tasks',
    {
      description:
        'Lists all orchestrated development tasks stored in the orchestrator state directory.',
      inputSchema: z.object({}).strict(),
    },
    async () => runWithMonitor(() => orchestrator.listTasks())
  );

  // 5. orchestrator_resume_task (taskId, optional guidance)
  // NOTE: Risk-acceptance override is strictly excluded from MCP surface to maintain human-only decision guarantees.
  server.registerTool(
    'orchestrator_resume_task',
    {
      description:
        'Resumes a task from NEEDS_USER_DECISION or FAILED state, optionally providing additional guidance instructions for retrying the fix cycle.',
      inputSchema: z
        .object({
          taskId: z
            .string()
            .min(1, 'taskId must not be empty')
            .describe('Unique identifier of the task to resume'),
          guidance: z
            .string()
            .min(1, 'guidance must not be empty')
            .optional()
            .describe('Optional guidance instructions for retrying the fix cycle'),
        })
        .strict(),
    },
    async (args) =>
      runWithMonitor(() =>
        orchestrator.resumeTask(args.taskId, {
          guidance: args.guidance,
        })
      )
  );

  // 6. orchestrator_cancel_task (taskId, optional reason)
  server.registerTool(
    'orchestrator_cancel_task',
    {
      description:
        'Cancels an active or decision-pending task (transitions to ABORTED) while safely preserving its external worktree for inspection.',
      inputSchema: z
        .object({
          taskId: z
            .string()
            .min(1, 'taskId must not be empty')
            .describe('Unique identifier of the task to cancel'),
          reason: z
            .string()
            .min(1, 'reason must not be empty')
            .optional()
            .describe('Optional reason describing why the task is being cancelled'),
        })
        .strict(),
    },
    async (args) =>
      runWithMonitor(() => orchestrator.cancelTask(args.taskId, args.reason || 'Cancelled via MCP'))
  );

  return server;
}

/**
 * Connects and runs the Orchestrator MCP server on standard I/O transport.
 */
export async function runStdioMcpServer(
  options: OrchestratorMcpServerOptions = {}
): Promise<McpServer> {
  const server = createOrchestratorMcpServer(options);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}
