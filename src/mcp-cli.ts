#!/usr/bin/env node
import { runStdioMcpServer } from './mcp/server.js';

runStdioMcpServer().catch((error) => {
  process.stderr.write(
    `Fatal Orchestrator MCP server error: ${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exit(1);
});
