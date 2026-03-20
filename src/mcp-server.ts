#!/usr/bin/env node
/**
 * MCP Server for StatHead NFL analytics tools.
 *
 * Exposes all NFL data tools (player stats, play-by-play, NGS, team metrics, etc.)
 * as an MCP server that works with Claude Desktop, Claude Code, or any MCP client.
 *
 * Usage:
 *   npx tsx src/mcp-server.ts
 *
 * Claude Desktop config (~/.claude/claude_desktop_config.json):
 *   {
 *     "mcpServers": {
 *       "stathead": {
 *         "command": "npx",
 *         "args": ["tsx", "src/mcp-server.ts"],
 *         "cwd": "/path/to/stathead"
 *       }
 *     }
 *   }
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { NFL_TOOLS, executeTool } from './tools.ts';

const server = new McpServer({
  name: 'stathead',
  version: '1.0.0',
});

// Register each NFL tool with the MCP server
for (const tool of NFL_TOOLS) {
  server.tool(
    tool.name,
    tool.description ?? '',
    tool.input_schema.properties as Record<string, unknown>,
    async (params: Record<string, unknown>) => {
      const result = await executeTool(tool.name, params);
      const content =
        typeof result.content === 'string'
          ? result.content
          : JSON.stringify(result.content);
      return {
        content: [{ type: 'text' as const, text: content }],
        isError: result.is_error ?? false,
      };
    }
  );
}

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('MCP server error:', err);
  process.exit(1);
});
