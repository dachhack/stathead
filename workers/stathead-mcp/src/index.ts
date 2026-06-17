/**
 * Cloudflare Worker — REMOTE (HTTP) transport for the StatHead MCP server.
 *
 * The same tool logic that ships on npm as `stathead-mcp` (stdio) is reused
 * here over MCP's Streamable HTTP transport, so the server can be added as a
 * custom connector in clients that only take a URL — the Claude mobile apps and
 * claude.ai web (Settings → Connectors → Add custom connector → this Worker's
 * URL). The npm/stdio build is unchanged and stays the path for Claude Desktop
 * / Claude Code.
 *
 * Design: NFL_TOOLS + executeTool are imported from the canonical bundle
 * (mcp/dist/server.mjs), which skips its stdio startup when it detects the
 * Worker runtime (navigator.userAgent === 'Cloudflare-Workers'). This Worker is
 * a thin transport adapter — stateless request/response JSON-RPC, no session
 * state. All data is fetched over HTTPS at runtime, so it runs read-only.
 *
 * Privacy-respecting usage counter: each MCP request records ONE Analytics
 * Engine data point with just the method (and tool name for tools/call) — no
 * IPs, no request bodies, no user identifiers. Read aggregates at GET /stats
 * (when CF_ACCOUNT_ID + CF_ANALYTICS_TOKEN are set), or in the Cloudflare
 * dashboard / Analytics Engine SQL on the `stathead_mcp_usage` dataset.
 *
 * Deploy:  npx wrangler deploy   (from workers/stathead-mcp/)
 */

// @ts-expect-error — JS bundle without type declarations; shapes asserted below.
import { NFL_TOOLS, executeTool, SERVER_VERSION } from '../../../mcp/dist/server.mjs';

// Minimal Cloudflare runtime types (no @cloudflare/workers-types dependency).
interface AnalyticsEngineDataset {
  writeDataPoint(event: { indexes?: string[]; blobs?: string[]; doubles?: number[] }): void;
}
interface ExecutionContext {
  waitUntil(p: Promise<unknown>): void;
}
interface Env {
  USAGE?: AnalyticsEngineDataset;
  // Optional — set both to enable the GET /stats summary endpoint:
  //   wrangler secret put CF_ACCOUNT_ID
  //   wrangler secret put CF_ANALYTICS_TOKEN   (token with Account Analytics: Read)
  CF_ACCOUNT_ID?: string;
  CF_ANALYTICS_TOKEN?: string;
}

interface ToolDef {
  name: string;
  description?: string;
  input_schema: unknown;
}
interface ToolResult {
  content: string | unknown;
  is_error?: boolean;
}
interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

const TOOLS = NFL_TOOLS as ToolDef[];
const VERSION = (SERVER_VERSION as string) || '0.0.0';
const DEFAULT_PROTOCOL = '2025-06-18';
const USAGE_DATASET = 'stathead_mcp_usage';

function corsHeaders(origin: string | null): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function isNotification(msg: JsonRpcMessage): boolean {
  return msg.id === undefined || msg.id === null;
}

// Privacy-respecting usage event: method + tool name only. No PII.
function recordUsage(env: Env, method: string, tool: string): void {
  if (!env?.USAGE) return;
  try {
    env.USAGE.writeDataPoint({ indexes: [method], blobs: [method, tool], doubles: [1] });
  } catch {
    // never let metrics break a request
  }
}

async function handleMessage(msg: JsonRpcMessage, env: Env): Promise<object | null> {
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize':
      recordUsage(env, 'initialize', '');
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: (params?.protocolVersion as string) || DEFAULT_PROTOCOL,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'stathead', version: VERSION },
        },
      };
    case 'tools/list':
      recordUsage(env, 'tools/list', '');
      return {
        jsonrpc: '2.0',
        id,
        result: {
          tools: TOOLS.map((t) => ({
            name: t.name,
            description: t.description ?? '',
            inputSchema: t.input_schema,
          })),
        },
      };
    case 'tools/call': {
      const name = params?.name as string;
      const args = (params?.arguments as Record<string, unknown>) ?? {};
      recordUsage(env, 'tools/call', name || 'unknown');
      try {
        const result = (await executeTool(name, args)) as ToolResult;
        const text =
          typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
        return {
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text }], isError: result.is_error ?? false },
        };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return {
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: `Error: ${message}` }], isError: true },
        };
      }
    }
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };
    default:
      if (method?.startsWith('notifications/') || isNotification(msg)) return null;
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
  }
}

// GET /stats — aggregate usage from Analytics Engine (last 30 days). Requires
// CF_ACCOUNT_ID + CF_ANALYTICS_TOKEN secrets; otherwise returns a hint.
async function handleStats(env: Env): Promise<object> {
  if (!env.CF_ACCOUNT_ID || !env.CF_ANALYTICS_TOKEN) {
    return {
      counting: true,
      dataset: USAGE_DATASET,
      note: 'Usage is being recorded. To view it here, set CF_ACCOUNT_ID + CF_ANALYTICS_TOKEN worker secrets, or query the dataset in the Cloudflare dashboard / Analytics Engine SQL API.',
    };
  }
  const sql = `SELECT index1 AS method, blob2 AS tool, sum(_sample_interval) AS count
    FROM ${USAGE_DATASET}
    WHERE timestamp > NOW() - INTERVAL '30' DAY
    GROUP BY method, tool
    ORDER BY count DESC
    LIMIT 100`;
  try {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`,
      { method: 'POST', headers: { Authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}` }, body: sql },
    );
    if (!res.ok) return { error: `Analytics query failed: ${res.status}`, detail: (await res.text()).slice(0, 300) };
    const data = (await res.json()) as { data?: Array<{ method: string; tool: string; count: number }> };
    const rows = data.data ?? [];
    const total = rows.reduce((s, r) => s + Number(r.count || 0), 0);
    const byMethod: Record<string, number> = {};
    const toolCalls: Record<string, number> = {};
    for (const r of rows) {
      byMethod[r.method] = (byMethod[r.method] || 0) + Number(r.count || 0);
      if (r.method === 'tools/call' && r.tool) toolCalls[r.tool] = (toolCalls[r.tool] || 0) + Number(r.count || 0);
    }
    return { window: 'last 30 days', total_requests: total, by_method: byMethod, tool_calls: toolCalls };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const origin = request.headers.get('Origin');
    const cors = corsHeaders(origin);
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    // GET /stats → usage summary; GET anything else → discovery/health.
    if (request.method === 'GET') {
      if (url.pathname === '/stats') {
        const stats = await handleStats(env);
        return new Response(JSON.stringify(stats, null, 2), {
          status: 200,
          headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({
          name: 'stathead-mcp',
          version: VERSION,
          transport: 'streamable-http',
          tools: TOOLS.length,
          usage: 'POST JSON-RPC (MCP) to this URL. Add it as a custom connector in Claude.',
          stats: '/stats',
        }),
        { status: 200, headers: { ...cors, 'Content-Type': 'application/json' } },
      );
    }

    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405, headers: cors });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }),
        { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } },
      );
    }

    const messages = Array.isArray(body) ? (body as JsonRpcMessage[]) : [body as JsonRpcMessage];
    const responses = (await Promise.all(messages.map((m) => handleMessage(m, env)))).filter(
      (r): r is object => r !== null,
    );

    if (responses.length === 0) {
      return new Response(null, { status: 202, headers: cors });
    }

    const payload = Array.isArray(body) ? responses : responses[0];
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  },
};
