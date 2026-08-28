import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('MCP Stdio Client & Real Child Process Integration', () => {
  let tmpDir: string;
  let spyLogPath: string;
  let client: Client | null = null;
  let transport: StdioClientTransport | null = null;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-stdio-test-'));
    spyLogPath = path.join(tmpDir, 'spy-invocations.log');

    // Create spy executables for agy, codex, and gh in a mock bin directory
    const mockBinDir = path.join(tmpDir, 'mock-bin');
    fs.mkdirSync(mockBinDir, { recursive: true });

    for (const tool of ['agy', 'codex', 'gh']) {
      const toolScript = path.join(mockBinDir, tool);
      fs.writeFileSync(
        toolScript,
        `#!/usr/bin/env sh\necho "${tool} was invoked with: $@" >> "${spyLogPath}"\nexit 0\n`,
        { mode: 0o755 }
      );
    }
  });

  afterAll(async () => {
    if (client) {
      try {
        await client.close();
      } catch {
        // Ignore close errors during teardown
      }
    }
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should launch bin/mcp.js over StdioClientTransport, initialize, list authorized tools, and never trigger agy/codex/gh', async () => {
    const mcpBinPath = path.resolve(process.cwd(), 'bin/mcp.js');
    expect(fs.existsSync(mcpBinPath), `bin/mcp.js must exist at ${mcpBinPath}`).toBe(true);

    const distPath = path.resolve(process.cwd(), 'dist/mcp-cli.js');
    expect(
      fs.existsSync(distPath),
      `Compiled dist/mcp-cli.js must exist. Run npm run build first.`
    ).toBe(true);

    const mockBinDir = path.join(tmpDir, 'mock-bin');

    transport = new StdioClientTransport({
      command: process.execPath,
      args: [mcpBinPath],
      env: {
        ...process.env,
        PATH: `${mockBinDir}:${process.env.PATH || ''}`,
      },
    });

    client = new Client(
      { name: 'test-stdio-integration-client', version: '1.0.0' },
      { capabilities: {} }
    );

    // 1. Connect and initialize protocol
    await client.connect(transport);

    // 2. Query available tools via MCP protocol
    const toolsResponse = await client.listTools();
    const toolNames = toolsResponse.tools.map((t) => t.name).sort();

    // 3. Prove exactly the permitted tools exist
    expect(toolNames).toHaveLength(7);
    expect(toolNames).toEqual([
      'orchestrator_cancel_task',
      'orchestrator_configure_allowed_base',
      'orchestrator_create_task',
      'orchestrator_get_task_status',
      'orchestrator_list_tasks',
      'orchestrator_resume_task',
      'orchestrator_run_task',
    ]);

    // 4. Verify schemas and ensure override is not present on orchestrator_resume_task
    const resumeTool = toolsResponse.tools.find((t) => t.name === 'orchestrator_resume_task');
    expect(resumeTool).toBeDefined();
    const resumeProperties = (resumeTool?.inputSchema as { properties?: Record<string, unknown> })
      ?.properties;
    expect(resumeProperties).toBeDefined();
    expect(resumeProperties).toHaveProperty('taskId');
    expect(resumeProperties).toHaveProperty('guidance');
    expect(resumeProperties).not.toHaveProperty('override');

    // 5. Prove that neither agy, codex, nor gh were triggered during initialization/list-tools
    expect(fs.existsSync(spyLogPath)).toBe(false);

    // 6. Ensure clean termination
    await client.close();
    client = null;
    transport = null;
  });
});
