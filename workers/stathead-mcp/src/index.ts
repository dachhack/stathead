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
 * Deploy:  npx wrangler deploy   (from workers/stathead-mcp/)
 */

// @ts-expect-error — JS bundle without type declarations; shapes asserted below.
import { NFL_TOOLS, executeTool, SERVER_VERSION } from '../../../mcp/dist/server.mjs';

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

function corsHeaders(origin: string | null): Record<string, string> {
  // A remote MCP endpoint is a public, server-to-server API (all data is
  // public NFL stats), so CORS is permissive; reflect the origin when present.
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

async function handleMessage(msg: JsonRpcMessage): Promise<object | null> {
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize':
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

export default {
  async fetch(request: Request): Promise<Response> {
    const origin = request.headers.get('Origin');
    const cors = corsHeaders(origin);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    // A GET returns a small discovery/health payload (and confirms the URL is
    // live when you paste it into a browser).
    if (request.method === 'GET') {
      return new Response(
        JSON.stringify({
          name: 'stathead-mcp',
          version: VERSION,
          transport: 'streamable-http',
          tools: TOOLS.length,
          usage: 'POST JSON-RPC (MCP) to this URL. Add it as a custom connector in Claude.',
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
    const responses = (await Promise.all(messages.map(handleMessage))).filter(
      (r): r is object => r !== null,
    );

    // All-notification batch → 202 Accepted with no body (MCP spec).
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
