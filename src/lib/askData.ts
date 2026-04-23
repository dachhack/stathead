/**
 * "Ask the data" feature — lets Claude answer questions by querying the
 * DuckDB tables registered in src/lib/duckdb. Exposes a single `run_sql`
 * tool that routes through the same runQuery() path the SQL editor uses,
 * so the user sees exactly the SQL the model is running.
 *
 * API key is stored in localStorage; requests go directly from the
 * browser to api.anthropic.com — never through any other server.
 */
import type { Tool, ToolResultBlockParam } from '@anthropic-ai/sdk/resources/messages';
import { runQuery, TABLE_DOCS } from './duckdb';

export const ASK_DATA_TOOLS: Tool[] = [
  {
    name: 'run_sql',
    description:
      "Execute a DuckDB SELECT / WITH / DESCRIBE / SHOW statement against the local in-browser database. Returns column names and up to 200 rows of results (JSON-serialized, one row per line). Always add a LIMIT clause unless you are aggregating. Mutations and DDL are rejected — the database is read-only.",
    input_schema: {
      type: 'object',
      properties: {
        sql: {
          type: 'string',
          description:
            'A read-only SQL statement (SELECT, WITH, DESCRIBE, or SHOW). Will be rejected otherwise.',
        },
      },
      required: ['sql'],
    },
  },
];

const ALLOWED = /^\s*(select|with|describe|show)\b/i;

/** Execute a tool call from Claude. Runs the SQL + serializes the first
 *  200 rows in a way that stays legible inside a tool_result block. */
export async function executeAskTool(
  name: string,
  input: Record<string, unknown>,
): Promise<{ content: string; is_error?: boolean }> {
  if (name !== 'run_sql') {
    return { content: `Unknown tool: ${name}`, is_error: true };
  }
  const sql = String(input.sql ?? '').trim();
  if (!sql) {
    return { content: 'sql parameter is required', is_error: true };
  }
  if (!ALLOWED.test(sql)) {
    return {
      content:
        'Only SELECT / WITH / DESCRIBE / SHOW statements are allowed. Rewrite the query as a read-only SELECT.',
      is_error: true,
    };
  }
  try {
    const out = await runQuery(sql);
    const limit = 200;
    const truncated = out.rows.length > limit;
    const rows = out.rows.slice(0, limit);
    const serialized = rows.map((r) => JSON.stringify(r)).join('\n');
    return {
      content: [
        `columns: ${out.columns.join(', ')}`,
        `row_count: ${out.rowCount}${truncated ? ` (showing first ${limit})` : ''}`,
        `elapsed_ms: ${out.elapsedMs.toFixed(1)}`,
        '',
        'rows:',
        serialized || '(no rows)',
      ].join('\n'),
    };
  } catch (e) {
    return { content: `SQL error: ${(e as Error).message || String(e)}`, is_error: true };
  }
}

/** Convert {content, is_error} into a tool_result block of the shape the
 *  Anthropic SDK wants on the next turn. Caller attaches tool_use_id. */
export function toToolResult(
  id: string,
  result: { content: string; is_error?: boolean },
): ToolResultBlockParam {
  return {
    type: 'tool_result',
    tool_use_id: id,
    content: result.content,
    ...(result.is_error ? { is_error: true } : {}),
  };
}

/** Build a system prompt that catalogs every table + column type, so
 *  Claude can write correct SQL without a DESCRIBE round-trip. Called
 *  once per chat session — DuckDB DESCRIBE is ~5 ms per table. */
export async function buildAskDataSystemPrompt(): Promise<string> {
  const schemaBlocks: string[] = [];
  for (const t of TABLE_DOCS) {
    try {
      const d = await runQuery(`DESCRIBE ${t.name}`);
      const cols = d.rows
        .map((r) => `  - ${r.column_name}  ${r.column_type}${(r as { null?: string }).null === 'NO' ? ' NOT NULL' : ''}`)
        .join('\n');
      schemaBlocks.push(`## ${t.name}\n${t.description}\n\n${cols}`);
    } catch {
      schemaBlocks.push(`## ${t.name}\n${t.description}\n(schema fetch failed)`);
    }
  }
  return [
    'You are StatHead Data Assistant. Answer user questions about NFL fantasy football by querying a local in-browser DuckDB database containing the StatHead model outputs + upstream data (NFL stats, ADP, KTC, rookie career predictions, etc.).',
    '',
    'Rules:',
    '- To get data, call the `run_sql` tool with a DuckDB SELECT statement. You can call it multiple times in one turn if needed.',
    '- Always include a LIMIT (default 100) unless you are aggregating. Results beyond the first 200 rows are truncated.',
    '- Match player names fuzzily with ILIKE — the data has `Ja\'Marr Chase` (apostrophe), `Patrick Mahomes II` (Jr./II suffixes), etc. Example: `WHERE player_display_name ILIKE \'%chase%\'`.',
    '- When joining `adp_historical` or similar to `player_stats`, match on `lower(player_display_name) = lower(name)` and on `season`.',
    '- For weekly stats filter `season_type = \'REG\'` unless the user explicitly asks about playoffs.',
    '- Schema drift: `player_stats` has both `recent_team` (pre-2025) and `team` (2025+). Use `COALESCE(recent_team, team)`.',
    '- After getting the data, give a short narrative answer and include the exact SQL you ran inside a ```sql fenced block so the user can adapt it.',
    '- Round sensibly (2 decimals for rates/shares, 1 for PPG, integers for yards/TDs).',
    '- If a query returns 0 rows, try alternative filters before giving up — different season, fuzzier name, looser threshold.',
    '',
    '# Tables available',
    '',
    schemaBlocks.join('\n\n'),
  ].join('\n');
}
