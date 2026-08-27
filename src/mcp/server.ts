import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Orchestrator } from '../orchestrator/orchestrator.js';
import type { IOrchestrator, OrchestratorMcpServerOptions } from '../types.js';

export const MCP_SERVER_NAME = 'codex-anti-orchestrator';
export const MCP_SERVER_VERSION = '0.1.0';

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
    async (args) => {
      try {
        const task = await orchestrator.createTask({
          repoPath: args.repoPath,
          prompt: args.prompt,
          baseBranch: args.baseBranch,
        });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(task, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: error instanceof Error ? error.message : String(error),
            },
          ],
        };
      }
    }
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
    async (args) => {
      try {
        const task = await orchestrator.runTaskLoop(args.taskId);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(task, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: error instanceof Error ? error.message : String(error),
            },
          ],
        };
      }
    }
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
    async (args) => {
      try {
        const task = await orchestrator.getTask(args.taskId);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(task, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: error instanceof Error ? error.message : String(error),
            },
          ],
        };
      }
    }
  );

  // 4. orchestrator_list_tasks (no arbitrary filters)
  server.registerTool(
    'orchestrator_list_tasks',
    {
      description:
        'Lists all orchestrated development tasks stored in the orchestrator state directory.',
      inputSchema: z.object({}).strict(),
    },
    async () => {
      try {
        const tasks = await orchestrator.listTasks();
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(tasks, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: error instanceof Error ? error.message : String(error),
            },
          ],
        };
      }
    }
  );

  // 5. orchestrator_resume_task (taskId, optional guidance, optional override)
  server.registerTool(
    'orchestrator_resume_task',
    {
      description:
        'Resumes a task from NEEDS_USER_DECISION or FAILED state, optionally providing additional guidance or overriding review warnings.',
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
          override: z
            .boolean()
            .optional()
            .describe(
              'Optional flag to accept PR with known warnings and transition to AWAITING_HUMAN_OVERRIDE'
            ),
        })
        .strict(),
    },
    async (args) => {
      try {
        const task = await orchestrator.resumeTask(args.taskId, {
          guidance: args.guidance,
          override: args.override,
        });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(task, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: error instanceof Error ? error.message : String(error),
            },
          ],
        };
      }
    }
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
    async (args) => {
      try {
        const task = await orchestrator.cancelTask(args.taskId, args.reason || 'Cancelled via MCP');
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(task, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: error instanceof Error ? error.message : String(error),
            },
          ],
        };
      }
    }
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
