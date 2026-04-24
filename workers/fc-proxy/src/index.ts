/**
 * Cloudflare Worker – CORS proxy for FantasyCalc.
 *
 * The public api.fantasycalc.com endpoint returns 403 host_not_allowed to
 * most direct requests. Routing through this worker lets the site use FC
 * without each browser IP needing to be on FC's server-side allowlist.
 *
 * Allowed upstream paths:
 *   GET /values/current?isDynasty=…&numQbs=…&numTeams=…&ppr=…
 *
 * Deploy:  npx wrangler deploy   (from workers/fc-proxy/)
 */

const ALLOWED_ORIGIN = 'https://dachhack.github.io';
const FC_BASE = 'https://api.fantasycalc.com';

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

function corsResponse(body: BodyInit | null, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) {
    headers.set(k, v);
  }
  return new Response(body, { ...init, headers });
}

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return corsResponse(null, { status: 204 });
    }
    if (request.method !== 'GET') {
      return corsResponse('Method not allowed', { status: 405 });
    }

    const url = new URL(request.url);
    const path = url.pathname + url.search;

    if (!url.pathname.startsWith('/values/current')) {
      return corsResponse('Not found', { status: 404 });
    }

    const upstream = `${FC_BASE}${path}`;

    try {
      const resp = await fetch(upstream, {
        method: 'GET',
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          Accept: 'application/json, text/plain, */*',
        },
      });
      return corsResponse(resp.body, {
        status: resp.status,
        statusText: resp.statusText,
        headers: {
          'Content-Type': resp.headers.get('Content-Type') || 'application/json',
          'Cache-Control': 'public, max-age=900',
        },
      });
    } catch (err) {
      return corsResponse(`Upstream error: ${err}`, { status: 502 });
    }
  },
};
