#!/usr/bin/env node
/**
 * MCP Server for StatHead NFL analytics tools.
 *
 * Exposes all NFL data tools (player stats, play-by-play, NGS, FantasyCalc, team metrics, etc.)
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
import { z, type ZodTypeAny } from 'zod';
import { NFL_TOOLS, executeTool } from './tools.ts';

const server = new McpServer({
  name: 'stathead',
  version: '1.0.5',
});

/**
 * Convert an Anthropic-style JSON-Schema `input_schema` into the Zod raw
 * shape that `McpServer.tool()` expects. The SDK reads parameters from a Zod
 * shape (not raw JSON Schema) — passing the JSON `properties` directly makes
 * it publish an empty schema, so MCP clients drop every argument before
 * sending and the tools receive nothing. Our tool params are only
 * string/number/boolean (+ string enums), so a small mapping covers them.
 */
function toZodShape(schema: {
  properties?: unknown;
  required?: unknown;
}): Record<string, ZodTypeAny> {
  const props = (schema.properties ?? {}) as Record<
    string,
    { type?: string; description?: string; enum?: string[] }
  >;
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const shape: Record<string, ZodTypeAny> = {};
  for (const [key, def] of Object.entries(props)) {
    let zt: ZodTypeAny;
    if (Array.isArray(def.enum) && def.enum.length > 0) {
      const vals = def.enum as unknown[];
      if (vals.every((v) => typeof v === 'string')) {
        zt = z.enum(vals as [string, ...string[]]);
      } else {
        // Numeric/mixed enums (e.g. teams: [8,10,12,14]) — z.enum is
        // string-only, so build a union of literals. Renders as an enum
        // in the published JSON schema and accepts the numeric values.
        const lits: ZodTypeAny[] = vals.map((v) => z.literal(v as string | number));
        zt =
          lits.length === 1
            ? lits[0]
            : z.union(lits as unknown as [ZodTypeAny, ZodTypeAny, ...ZodTypeAny[]]);
      }
    } else if (def.type === 'number' || def.type === 'integer') {
      zt = z.number();
    } else if (def.type === 'boolean') {
      zt = z.boolean();
    } else {
      zt = z.string();
    }
    if (def.description) zt = zt.describe(def.description);
    if (!required.has(key)) zt = zt.optional();
    shape[key] = zt;
  }
  return shape;
}

// Register each NFL tool with the MCP server
for (const tool of NFL_TOOLS) {
  server.tool(
    tool.name,
    tool.description ?? '',
    toZodShape(tool.input_schema),
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
