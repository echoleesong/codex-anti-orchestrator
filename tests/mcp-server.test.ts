import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createOrchestratorMcpServer,
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
} from '../src/mcp/server.js';
import type {
  CreateTaskOptions,
  IOrchestrator,
  ResumeTaskOptions,
  TaskRecord,
} from '../src/types.js';

describe('MCP Server Tool & Safety Boundary Tests', () => {
  const sampleTaskRecord: TaskRecord = {
    id: 'task-1740000000-implement-auth-ab12cd',
    targetRepoPath: '/Users/example/projects/my-project',
    baseBranch: 'main',
    taskBranch: 'anti/task-1740000000-implement-auth-ab12cd',
    worktreePath:
      '/Users/example/.codex-anti-orchestrator/worktrees/task-1740000000-implement-auth-ab12cd',
    state: 'WORKTREE_READY',
    createdAt: '2026-08-27T12:00:00.000Z',
    updatedAt: '2026-08-27T12:00:00.000Z',
    prompt: 'Implement secure JWT authentication',
    transitions: [
      {
        from: 'IDLE',
        to: 'INITIALIZING',
        timestamp: '2026-08-27T12:00:00.000Z',
        reason: 'Task init',
      },
      {
        from: 'INITIALIZING',
        to: 'WORKTREE_PREPARING',
        timestamp: '2026-08-27T12:00:00.000Z',
        reason: 'Allocating worktree',
      },
      {
        from: 'WORKTREE_PREPARING',
        to: 'WORKTREE_READY',
        timestamp: '2026-08-27T12:00:00.000Z',
        reason: 'Ready for agy',
      },
    ],
    diagnostics: {
      reviewCycles: 0,
      maxReviewCycles: 3,
      resumePossible: false,
      worktreePreserved: true,
    },
  };

  let mockOrchestrator: IOrchestrator;
  let client: Client;

  const setupClientAndServer = async (orchestrator: IOrchestrator) => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createOrchestratorMcpServer({
      orchestrator,
      monitorLauncher: {
        ensureStarted: vi.fn(async () => ({ url: 'http://127.0.0.1:4390', opened: true })),
      },
    });
    await server.connect(serverTransport);

    const mcpClient = new Client(
      { name: 'test-codex-desktop-client', version: '1.0.0' },
      { capabilities: {} }
    );
    await mcpClient.connect(clientTransport);
    return { server, client: mcpClient };
  };

  beforeEach(async () => {
    mockOrchestrator = {
      createTask: vi.fn(async (options: CreateTaskOptions) => ({
        ...sampleTaskRecord,
        targetRepoPath: options.repoPath,
        prompt: options.prompt,
        baseBranch: options.baseBranch || 'main',
      })),
      runTaskLoop: vi.fn(async (taskId: string) => ({
        ...sampleTaskRecord,
        id: taskId,
        state: 'AWAITING_HUMAN_APPROVAL' as const,
      })),
      getTask: vi.fn(async (taskId: string) => ({
        ...sampleTaskRecord,
        id: taskId,
      })),
      listTasks: vi.fn(async () => [sampleTaskRecord]),
      cancelTask: vi.fn(async (taskId: string, reason?: string) => ({
        ...sampleTaskRecord,
        id: taskId,
        state: 'ABORTED' as const,
        transitions: [
          ...sampleTaskRecord.transitions,
          {
            from: sampleTaskRecord.state,
            to: 'ABORTED' as const,
            timestamp: '2026-08-27T12:05:00.000Z',
            reason: reason || 'Cancelled via MCP',
          },
        ],
      })),
      resumeTask: vi.fn(async (taskId: string, _options?: ResumeTaskOptions) => ({
        ...sampleTaskRecord,
        id: taskId,
        state: 'AGY_FIXING' as const,
      })),
      getStateDir: vi.fn(() => '/Users/example/.codex-anti-orchestrator/worktrees'),
      getAllowedBaseDir: vi.fn(() => '/Users/example/projects'),
      configureAllowedBaseDir: vi.fn((allowedBaseDir: string) => ({
        allowedBaseDir,
        confirmedAt: '2026-08-28T00:00:00.000Z',
      })),
    };

    const setup = await setupClientAndServer(mockOrchestrator);
    client = setup.client;
  });

  describe('Tool Listing & Boundary Invariants', () => {
    it('should expose only the authorized orchestration tools', async () => {
      const toolsResponse = await client.listTools();
      const toolNames = toolsResponse.tools.map((t) => t.name);

      expect(toolNames).toHaveLength(7);
      expect(toolNames).toEqual([
        'orchestrator_configure_allowed_base',
        'orchestrator_create_task',
        'orchestrator_run_task',
        'orchestrator_get_task_status',
        'orchestrator_list_tasks',
        'orchestrator_resume_task',
        'orchestrator_cancel_task',
      ]);
    });

    it('should strictly confirm NO merge or auto-merge tools exist in MCP toolset', async () => {
      const toolsResponse = await client.listTools();
      const toolNames = toolsResponse.tools.map((t) => t.name);

      const prohibitedMergeKeywords = [
        'merge',
        'pr_merge',
        'gh_pr_merge',
        'git_merge',
        'fastforward',
      ];
      for (const keyword of prohibitedMergeKeywords) {
        const found = toolNames.some((name) => name.toLowerCase().includes(keyword));
        expect(found, `Found prohibited merge tool matching keyword "${keyword}"`).toBe(false);
      }
    });

    it('should strictly confirm NO arbitrary shell or command execution tools exist', async () => {
      const toolsResponse = await client.listTools();
      const toolNames = toolsResponse.tools.map((t) => t.name);

      const prohibitedExecKeywords = [
        'exec',
        'shell',
        'command',
        'bash',
        'cmd',
        'run_command',
        'eval',
        'script',
      ];
      for (const keyword of prohibitedExecKeywords) {
        const found = toolNames.some((name) => name.toLowerCase().includes(keyword));
        expect(found, `Found prohibited execution tool matching keyword "${keyword}"`).toBe(false);
      }
    });

    it('should strictly confirm NO deployment, publishing, or workflow dispatch tools exist', async () => {
      const toolsResponse = await client.listTools();
      const toolNames = toolsResponse.tools.map((t) => t.name);

      const prohibitedDeployKeywords = ['deploy', 'publish', 'release', 'workflow', 'dispatch'];
      for (const keyword of prohibitedDeployKeywords) {
        const found = toolNames.some((name) => name.toLowerCase().includes(keyword));
        expect(found, `Found prohibited deploy tool matching keyword "${keyword}"`).toBe(false);
      }
    });

    it('should provide complete descriptions and input schemas for all exposed tools', async () => {
      const toolsResponse = await client.listTools();
      for (const tool of toolsResponse.tools) {
        expect(tool.description).toBeDefined();
        expect(tool.description!.length).toBeGreaterThan(10);
        expect(tool.inputSchema).toBeDefined();
        expect(tool.inputSchema.type).toBe('object');
      }
    });

    it('should strictly omit override from orchestrator_resume_task schema', async () => {
      const toolsResponse = await client.listTools();
      const resumeTool = toolsResponse.tools.find((t) => t.name === 'orchestrator_resume_task');
      expect(resumeTool).toBeDefined();
      const properties = (resumeTool?.inputSchema as { properties?: Record<string, unknown> })
        .properties;
      expect(properties).toBeDefined();
      expect(properties).toHaveProperty('taskId');
      expect(properties).toHaveProperty('guidance');
      expect(properties).not.toHaveProperty('override');
    });
  });

  describe('Allowed base configuration', () => {
    it('persists only an explicitly confirmed allowed repository root', async () => {
      const res = await client.callTool({
        name: 'orchestrator_configure_allowed_base',
        arguments: { allowedBaseDir: '/Users/other/projects', confirmed: true },
      });
      expect(res.isError).toBeFalsy();
      const parsed = JSON.parse((res.content[0] as { type: 'text'; text: string }).text);
      expect(parsed.data.allowedBaseDir).toBe('/Users/other/projects');
      expect(mockOrchestrator.configureAllowedBaseDir).toHaveBeenCalledWith(
        '/Users/other/projects'
      );
    });
  });

  describe('Tool 1: orchestrator_create_task', () => {
    it('should successfully create a task with required parameters in stable JSON text format', async () => {
      const res = await client.callTool({
        name: 'orchestrator_create_task',
        arguments: {
          repoPath: '/Users/example/projects/my-project',
          prompt: 'Implement secure JWT authentication',
        },
      });

      expect(res.isError).toBeFalsy();
      expect(res.content).toHaveLength(1);
      expect(res.content[0].type).toBe('text');

      const parsed = JSON.parse((res.content[0] as { type: 'text'; text: string }).text);
      expect(parsed.ok).toBe(true);
      expect(parsed.monitor).toEqual({ url: 'http://127.0.0.1:4390', opened: true });
      expect(parsed.data.id).toBe(sampleTaskRecord.id);
      expect(parsed.data.prompt).toBe('Implement secure JWT authentication');
      expect(parsed.data.targetRepoPath).toBe('/Users/example/projects/my-project');

      expect(mockOrchestrator.createTask).toHaveBeenCalledWith({
        repoPath: '/Users/example/projects/my-project',
        prompt: 'Implement secure JWT authentication',
        baseBranch: undefined,
      });
    });

    it('should successfully create a task with optional baseBranch', async () => {
      const res = await client.callTool({
        name: 'orchestrator_create_task',
        arguments: {
          repoPath: '/Users/example/projects/my-project',
          prompt: 'Refactor database adapter',
          baseBranch: 'develop',
        },
      });

      expect(res.isError).toBeFalsy();
      const parsed = JSON.parse((res.content[0] as { type: 'text'; text: string }).text);
      expect(parsed.ok).toBe(true);
      expect(mockOrchestrator.createTask).toHaveBeenCalledWith({
        repoPath: '/Users/example/projects/my-project',
        prompt: 'Refactor database adapter',
        baseBranch: 'develop',
      });
    });

    it('should map orchestrator errors to structured tool error result with safe code and message', async () => {
      vi.mocked(mockOrchestrator.createTask).mockRejectedValueOnce(
        new Error('Invalid target repository path: path resolves outside /Users/example/projects')
      );

      const res = await client.callTool({
        name: 'orchestrator_create_task',
        arguments: {
          repoPath: '/etc/sensitive-dir',
          prompt: 'Perform unauthorized change',
        },
      });

      expect(res.isError).toBe(true);
      const parsed = JSON.parse((res.content[0] as { type: 'text'; text: string }).text);
      expect(parsed.ok).toBe(false);
      expect(parsed.error.code).toBe('INVALID_PATH');
      expect(parsed.error.message).toContain('Invalid target repository path');
      expect(parsed.error.message).toContain('/Users/example/projects');
    });

    it('should map non-Error exception to stringified tool error result', async () => {
      vi.mocked(mockOrchestrator.createTask).mockRejectedValueOnce(
        'Raw string error from orchestrator'
      );

      const res = await client.callTool({
        name: 'orchestrator_create_task',
        arguments: {
          repoPath: '/Users/example/projects/my-project',
          prompt: 'Fix bug',
        },
      });

      expect(res.isError).toBe(true);
      const parsed = JSON.parse((res.content[0] as { type: 'text'; text: string }).text);
      expect(parsed.ok).toBe(false);
      expect(parsed.error.code).toBe('ORCHESTRATION_ERROR');
      expect(parsed.error.message).toContain('Raw string error from orchestrator');
    });

    it('should redact secrets in error response and omit raw stack traces', async () => {
      const errWithStack = new Error(
        'Failed to connect with token ghp_1234567890abcdef1234567890abcdef1234\n    at Object.createTask (/Users/example/projects/src/secret.ts:42:15)'
      );
      vi.mocked(mockOrchestrator.createTask).mockRejectedValueOnce(errWithStack);

      const res = await client.callTool({
        name: 'orchestrator_create_task',
        arguments: {
          repoPath: '/Users/example/projects/my-project',
          prompt: 'Fix bug',
        },
      });

      expect(res.isError).toBe(true);
      const parsed = JSON.parse((res.content[0] as { type: 'text'; text: string }).text);
      expect(parsed.ok).toBe(false);
      expect(parsed.error.message).not.toContain('ghp_1234567890abcdef1234567890abcdef1234');
      expect(parsed.error.message).toContain('[REDACTED_GITHUB_TOKEN]');
      expect(parsed.error.message).not.toContain('at Object.createTask');
    });

    it('should reject missing repoPath parameter', async () => {
      const res = await client.callTool({
        name: 'orchestrator_create_task',
        arguments: {
          prompt: 'Implement feature',
        } as unknown as Record<string, unknown>,
      });

      expect(res.isError).toBe(true);
      const text = (res.content[0] as { type: 'text'; text: string }).text;
      expect(text).toMatch(/repoPath/i);
    });

    it('should reject empty repoPath parameter', async () => {
      const res = await client.callTool({
        name: 'orchestrator_create_task',
        arguments: {
          repoPath: '',
          prompt: 'Implement feature',
        },
      });

      expect(res.isError).toBe(true);
      const text = (res.content[0] as { type: 'text'; text: string }).text;
      expect(text).toMatch(/repoPath.*empty/i);
    });

    it('should reject missing prompt parameter', async () => {
      const res = await client.callTool({
        name: 'orchestrator_create_task',
        arguments: {
          repoPath: '/Users/example/projects/my-project',
        } as unknown as Record<string, unknown>,
      });

      expect(res.isError).toBe(true);
      const text = (res.content[0] as { type: 'text'; text: string }).text;
      expect(text).toMatch(/prompt/i);
    });

    it('should reject empty prompt parameter', async () => {
      const res = await client.callTool({
        name: 'orchestrator_create_task',
        arguments: {
          repoPath: '/Users/example/projects/my-project',
          prompt: '',
        },
      });

      expect(res.isError).toBe(true);
      const text = (res.content[0] as { type: 'text'; text: string }).text;
      expect(text).toMatch(/prompt.*empty/i);
    });

    it('should reject empty baseBranch parameter', async () => {
      const res = await client.callTool({
        name: 'orchestrator_create_task',
        arguments: {
          repoPath: '/Users/example/projects/my-project',
          prompt: 'Feature',
          baseBranch: '',
        },
      });

      expect(res.isError).toBe(true);
      const text = (res.content[0] as { type: 'text'; text: string }).text;
      expect(text).toMatch(/baseBranch.*empty/i);
    });

    it('should reject unknown extra parameters (strict schema enforcement)', async () => {
      const res = await client.callTool({
        name: 'orchestrator_create_task',
        arguments: {
          repoPath: '/Users/example/projects/my-project',
          prompt: 'Implement feature',
          maliciousFlag: '--dangerously-skip-permissions',
        } as unknown as Record<string, unknown>,
      });

      expect(res.isError).toBe(true);
      const text = (res.content[0] as { type: 'text'; text: string }).text;
      expect(text).toMatch(/unrecognized_keys|invalid/i);
    });
  });

  describe('Tool 2: orchestrator_run_task', () => {
    it('should successfully run task loop for a valid taskId', async () => {
      const res = await client.callTool({
        name: 'orchestrator_run_task',
        arguments: {
          taskId: 'task-1740000000-implement-auth-ab12cd',
        },
      });

      expect(res.isError).toBeFalsy();
      expect(mockOrchestrator.runTaskLoop).toHaveBeenCalledWith(
        'task-1740000000-implement-auth-ab12cd'
      );

      const parsed = JSON.parse((res.content[0] as { type: 'text'; text: string }).text);
      expect(parsed.ok).toBe(true);
      expect(parsed.data.state).toBe('AWAITING_HUMAN_APPROVAL');
    });

    it('should map task loop failure to structured tool error result', async () => {
      vi.mocked(mockOrchestrator.runTaskLoop).mockRejectedValueOnce(
        new Error('Task not found: task-non-existent')
      );

      const res = await client.callTool({
        name: 'orchestrator_run_task',
        arguments: {
          taskId: 'task-non-existent',
        },
      });

      expect(res.isError).toBe(true);
      const parsed = JSON.parse((res.content[0] as { type: 'text'; text: string }).text);
      expect(parsed.ok).toBe(false);
      expect(parsed.error.code).toBe('TASK_NOT_FOUND');
      expect(parsed.error.message).toContain('Task not found: task-non-existent');
    });

    it('should reject missing taskId parameter', async () => {
      const res = await client.callTool({
        name: 'orchestrator_run_task',
        arguments: {} as unknown as Record<string, unknown>,
      });

      expect(res.isError).toBe(true);
      const text = (res.content[0] as { type: 'text'; text: string }).text;
      expect(text).toMatch(/taskId/i);
    });

    it('should reject empty taskId parameter', async () => {
      const res = await client.callTool({
        name: 'orchestrator_run_task',
        arguments: {
          taskId: '',
        },
      });

      expect(res.isError).toBe(true);
      const text = (res.content[0] as { type: 'text'; text: string }).text;
      expect(text).toMatch(/taskId.*empty/i);
    });

    it('should reject unrecognized extra keys', async () => {
      const res = await client.callTool({
        name: 'orchestrator_run_task',
        arguments: {
          taskId: 'task-123',
          autoMerge: true,
        } as unknown as Record<string, unknown>,
      });

      expect(res.isError).toBe(true);
      const text = (res.content[0] as { type: 'text'; text: string }).text;
      expect(text).toMatch(/unrecognized_keys|invalid/i);
    });
  });

  describe('Tool 3: orchestrator_get_task_status', () => {
    it('should successfully return status of a specific task', async () => {
      const res = await client.callTool({
        name: 'orchestrator_get_task_status',
        arguments: {
          taskId: 'task-1740000000-implement-auth-ab12cd',
        },
      });

      expect(res.isError).toBeFalsy();
      expect(mockOrchestrator.getTask).toHaveBeenCalledWith(
        'task-1740000000-implement-auth-ab12cd'
      );

      const parsed = JSON.parse((res.content[0] as { type: 'text'; text: string }).text);
      expect(parsed.ok).toBe(true);
      expect(parsed.data.id).toBe('task-1740000000-implement-auth-ab12cd');
      expect(parsed.data.state).toBe('WORKTREE_READY');
    });

    it('should map getTask errors to tool error result', async () => {
      vi.mocked(mockOrchestrator.getTask).mockRejectedValueOnce(
        new Error('Task not found: invalid-task-id')
      );

      const res = await client.callTool({
        name: 'orchestrator_get_task_status',
        arguments: {
          taskId: 'invalid-task-id',
        },
      });

      expect(res.isError).toBe(true);
      const parsed = JSON.parse((res.content[0] as { type: 'text'; text: string }).text);
      expect(parsed.ok).toBe(false);
      expect(parsed.error.code).toBe('TASK_NOT_FOUND');
      expect(parsed.error.message).toContain('Task not found: invalid-task-id');
    });

    it('should reject missing or empty taskId', async () => {
      const resMissing = await client.callTool({
        name: 'orchestrator_get_task_status',
        arguments: {} as unknown as Record<string, unknown>,
      });
      expect(resMissing.isError).toBe(true);

      const resEmpty = await client.callTool({
        name: 'orchestrator_get_task_status',
        arguments: { taskId: '' },
      });
      expect(resEmpty.isError).toBe(true);
    });

    it('should reject unrecognized extra keys', async () => {
      const res = await client.callTool({
        name: 'orchestrator_get_task_status',
        arguments: {
          taskId: 'task-123',
          verbose: true,
        } as unknown as Record<string, unknown>,
      });

      expect(res.isError).toBe(true);
    });
  });

  describe('Tool 4: orchestrator_list_tasks', () => {
    it('should successfully list all tasks', async () => {
      const res = await client.callTool({
        name: 'orchestrator_list_tasks',
        arguments: {},
      });

      expect(res.isError).toBeFalsy();
      expect(mockOrchestrator.listTasks).toHaveBeenCalled();

      const parsed = JSON.parse((res.content[0] as { type: 'text'; text: string }).text);
      expect(parsed.ok).toBe(true);
      expect(Array.isArray(parsed.data)).toBe(true);
      expect(parsed.data).toHaveLength(1);
      expect(parsed.data[0].id).toBe(sampleTaskRecord.id);
    });

    it('should map listTasks error to structured error result', async () => {
      vi.mocked(mockOrchestrator.listTasks).mockRejectedValueOnce(
        new Error('Failed to read state directory')
      );

      const res = await client.callTool({
        name: 'orchestrator_list_tasks',
        arguments: {},
      });

      expect(res.isError).toBe(true);
      const parsed = JSON.parse((res.content[0] as { type: 'text'; text: string }).text);
      expect(parsed.ok).toBe(false);
      expect(parsed.error.code).toBe('ORCHESTRATION_ERROR');
      expect(parsed.error.message).toContain('Failed to read state directory');
    });

    it('should reject unrecognized arbitrary filter arguments', async () => {
      const res = await client.callTool({
        name: 'orchestrator_list_tasks',
        arguments: {
          filterSql: 'SELECT * FROM tasks',
        } as unknown as Record<string, unknown>,
      });

      expect(res.isError).toBe(true);
      const text = (res.content[0] as { type: 'text'; text: string }).text;
      expect(text).toMatch(/unrecognized_keys|invalid/i);
    });
  });

  describe('Tool 5: orchestrator_resume_task', () => {
    it('should resume task with user guidance in stable JSON text format', async () => {
      const res = await client.callTool({
        name: 'orchestrator_resume_task',
        arguments: {
          taskId: 'task-1740000000-implement-auth-ab12cd',
          guidance: 'Handle null JWT tokens in authorization middleware',
        },
      });

      expect(res.isError).toBeFalsy();
      expect(mockOrchestrator.resumeTask).toHaveBeenCalledWith(
        'task-1740000000-implement-auth-ab12cd',
        {
          guidance: 'Handle null JWT tokens in authorization middleware',
        }
      );

      const parsed = JSON.parse((res.content[0] as { type: 'text'; text: string }).text);
      expect(parsed.ok).toBe(true);
      expect(parsed.data.state).toBe('AGY_FIXING');
    });

    it('should resume task with no optional guidance', async () => {
      const res = await client.callTool({
        name: 'orchestrator_resume_task',
        arguments: {
          taskId: 'task-1740000000-implement-auth-ab12cd',
        },
      });

      expect(res.isError).toBeFalsy();
      expect(mockOrchestrator.resumeTask).toHaveBeenCalledWith(
        'task-1740000000-implement-auth-ab12cd',
        {
          guidance: undefined,
        }
      );
      const parsed = JSON.parse((res.content[0] as { type: 'text'; text: string }).text);
      expect(parsed.ok).toBe(true);
    });

    it('should strictly reject override parameter (override is human-only outside MCP surface)', async () => {
      const res = await client.callTool({
        name: 'orchestrator_resume_task',
        arguments: {
          taskId: 'task-1740000000-implement-auth-ab12cd',
          override: true,
        } as unknown as Record<string, unknown>,
      });

      expect(res.isError).toBe(true);
      const text = (res.content[0] as { type: 'text'; text: string }).text;
      expect(text).toMatch(/unrecognized_keys|invalid/i);
      expect(mockOrchestrator.resumeTask).not.toHaveBeenCalled();
    });

    it('should map resumeTask error to structured error result', async () => {
      vi.mocked(mockOrchestrator.resumeTask).mockRejectedValueOnce(
        new Error(
          'Cannot resume task in state COMPLETED. Resume is only supported from NEEDS_USER_DECISION or FAILED.'
        )
      );

      const res = await client.callTool({
        name: 'orchestrator_resume_task',
        arguments: {
          taskId: 'task-1740000000-implement-auth-ab12cd',
        },
      });

      expect(res.isError).toBe(true);
      const parsed = JSON.parse((res.content[0] as { type: 'text'; text: string }).text);
      expect(parsed.ok).toBe(false);
      expect(parsed.error.code).toBe('INVALID_STATE');
      expect(parsed.error.message).toContain('Cannot resume task in state COMPLETED');
    });

    it('should reject empty guidance', async () => {
      const resEmptyGuidance = await client.callTool({
        name: 'orchestrator_resume_task',
        arguments: {
          taskId: 'task-123',
          guidance: '',
        },
      });
      expect(resEmptyGuidance.isError).toBe(true);
    });

    it('should reject unrecognized extra keys', async () => {
      const res = await client.callTool({
        name: 'orchestrator_resume_task',
        arguments: {
          taskId: 'task-123',
          forceBypass: true,
        } as unknown as Record<string, unknown>,
      });

      expect(res.isError).toBe(true);
    });
  });

  describe('Tool 6: orchestrator_cancel_task', () => {
    it('should successfully cancel a task with custom reason in stable JSON text format', async () => {
      const res = await client.callTool({
        name: 'orchestrator_cancel_task',
        arguments: {
          taskId: 'task-1740000000-implement-auth-ab12cd',
          reason: 'User decided to postpone this feature',
        },
      });

      expect(res.isError).toBeFalsy();
      expect(mockOrchestrator.cancelTask).toHaveBeenCalledWith(
        'task-1740000000-implement-auth-ab12cd',
        'User decided to postpone this feature'
      );

      const parsed = JSON.parse((res.content[0] as { type: 'text'; text: string }).text);
      expect(parsed.ok).toBe(true);
      expect(parsed.data.state).toBe('ABORTED');
    });

    it('should cancel task with default reason if none provided', async () => {
      const res = await client.callTool({
        name: 'orchestrator_cancel_task',
        arguments: {
          taskId: 'task-1740000000-implement-auth-ab12cd',
        },
      });

      expect(res.isError).toBeFalsy();
      expect(mockOrchestrator.cancelTask).toHaveBeenCalledWith(
        'task-1740000000-implement-auth-ab12cd',
        'Cancelled via MCP'
      );
      const parsed = JSON.parse((res.content[0] as { type: 'text'; text: string }).text);
      expect(parsed.ok).toBe(true);
    });

    it('should map cancelTask error to structured error result', async () => {
      vi.mocked(mockOrchestrator.cancelTask).mockRejectedValueOnce(
        new Error('Task not found: task-invalid')
      );

      const res = await client.callTool({
        name: 'orchestrator_cancel_task',
        arguments: {
          taskId: 'task-invalid',
        },
      });

      expect(res.isError).toBe(true);
      const parsed = JSON.parse((res.content[0] as { type: 'text'; text: string }).text);
      expect(parsed.ok).toBe(false);
      expect(parsed.error.code).toBe('TASK_NOT_FOUND');
      expect(parsed.error.message).toContain('Task not found: task-invalid');
    });

    it('should reject missing or empty taskId', async () => {
      const res = await client.callTool({
        name: 'orchestrator_cancel_task',
        arguments: { taskId: '' },
      });
      expect(res.isError).toBe(true);
    });

    it('should reject empty reason string', async () => {
      const res = await client.callTool({
        name: 'orchestrator_cancel_task',
        arguments: {
          taskId: 'task-123',
          reason: '',
        },
      });
      expect(res.isError).toBe(true);
    });

    it('should reject unrecognized extra keys', async () => {
      const res = await client.callTool({
        name: 'orchestrator_cancel_task',
        arguments: {
          taskId: 'task-123',
          deleteWorktreeImmediately: true,
        } as unknown as Record<string, unknown>,
      });

      expect(res.isError).toBe(true);
    });
  });

  describe('Non-Existent & Forbidden Tool Invocations', () => {
    it('should return error when attempting to invoke non-existent tool', async () => {
      const res = await client.callTool({
        name: 'non_existent_orchestrator_tool',
        arguments: {},
      });

      expect(res.isError).toBe(true);
      const text = (res.content[0] as { type: 'text'; text: string }).text;
      expect(text).toMatch(/not found/i);
    });

    it('should fail closed when attempting to invoke prohibited merge tool', async () => {
      const res = await client.callTool({
        name: 'orchestrator_merge_pr',
        arguments: { prNumber: 123 },
      });

      expect(res.isError).toBe(true);
      const text = (res.content[0] as { type: 'text'; text: string }).text;
      expect(text).toMatch(/not found/i);
    });

    it('should fail closed when attempting to invoke prohibited command execution tool', async () => {
      const res = await client.callTool({
        name: 'orchestrator_execute_command',
        arguments: { command: 'rm -rf /' },
      });

      expect(res.isError).toBe(true);
      const text = (res.content[0] as { type: 'text'; text: string }).text;
      expect(text).toMatch(/not found/i);
    });
  });

  describe('Server Metadata & Default Configuration', () => {
    it('should configure default server name and version', () => {
      const server = createOrchestratorMcpServer();
      expect(server).toBeDefined();
      expect(MCP_SERVER_NAME).toBe('codex-anti-orchestrator');
      expect(MCP_SERVER_VERSION).toBe('0.1.0');
    });

    it('should support custom server name and version override', async () => {
      const customSetup = await setupClientAndServer(mockOrchestrator);
      expect(customSetup.server).toBeDefined();
    });
  });
});
