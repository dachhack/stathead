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
  version: '1.0.13',
});

/**
 * MCP clients routinely send every tool argument as a string — e.g.
 * `season=2026` arrives as `"2026"`, `red_zone=true` as `"true"` — because
 * the transport JSON or the client's form layer stringifies them. Strict
 * `z.number()` / `z.boolean()` then reject valid input with "expected
 * number, received string". These preprocessors coerce string-encoded
 * numbers and booleans back to their real types before validation, while
 * leaving genuinely invalid input to fail with a clear error. We avoid
 * `z.coerce.*` because it's lossy here: `z.coerce.number("")` is 0 and
 * `z.coerce.boolean("false")` is true. */
function coerceNumber(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  const t = v.trim();
  if (t === '') return v; // let the empty string fail rather than become 0
  const n = Number(t);
  return Number.isNaN(n) ? v : n;
}

function coerceBoolean(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  const t = v.trim().toLowerCase();
  if (t === 'true' || t === '1') return true;
  if (t === 'false' || t === '0') return false;
  return v;
}

/**
 * Convert an Anthropic-style JSON-Schema `input_schema` into the Zod raw
 * shape that `McpServer.tool()` expects. The SDK reads parameters from a Zod
 * shape (not raw JSON Schema) — passing the JSON `properties` directly makes
 * it publish an empty schema, so MCP clients drop every argument before
 * sending and the tools receive nothing. Our tool params are only
 * string/number/boolean (+ string/numeric enums), so a small mapping covers
 * them. Numeric and boolean params are wrapped so string-encoded values from
 * MCP clients still validate (see coerceNumber/coerceBoolean).
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
        // Preprocess so a string-encoded value (teams="12") still matches.
        const lits: ZodTypeAny[] = vals.map((v) => z.literal(v as string | number));
        const union =
          lits.length === 1
            ? lits[0]
            : z.union(lits as unknown as [ZodTypeAny, ZodTypeAny, ...ZodTypeAny[]]);
        zt = z.preprocess(coerceNumber, union);
      }
    } else if (def.type === 'number' || def.type === 'integer') {
      zt = z.preprocess(coerceNumber, z.number());
    } else if (def.type === 'boolean') {
      zt = z.preprocess(coerceBoolean, z.boolean());
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
