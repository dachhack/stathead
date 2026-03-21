/**
 * Cloudflare Worker – lightweight CORS proxy for KeepTradeCut.
 *
 * Allowed upstream paths:
 *   GET  /dynasty-rankings?…
 *   POST /dynasty-rankings/histories
 *
 * Deploy:  npx wrangler deploy   (from workers/ktc-proxy/)
 */

const ALLOWED_ORIGIN = 'https://dachhack.github.io';
const KTC_BASE = 'https://keeptradecut.com';

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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
    // Preflight
    if (request.method === 'OPTIONS') {
      return corsResponse(null, { status: 204 });
    }

    const url = new URL(request.url);
    const path = url.pathname + url.search;

    // Only allow specific KTC paths
    if (
      !path.startsWith('/dynasty-rankings')
    ) {
      return corsResponse('Not found', { status: 404 });
    }

    const upstream = `${KTC_BASE}${path}`;

    const upstreamHeaders: Record<string, string> = {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      Accept: request.headers.get('Accept') || '*/*',
      Referer: 'https://keeptradecut.com/',
      Origin: 'https://keeptradecut.com',
    };

    const init: RequestInit = {
      method: request.method,
      headers: upstreamHeaders,
    };

    if (request.method === 'POST') {
      upstreamHeaders['Content-Type'] =
        request.headers.get('Content-Type') || 'application/json';
      init.body = await request.text();
    }

    try {
      const resp = await fetch(upstream, init);
      return corsResponse(resp.body, {
        status: resp.status,
        statusText: resp.statusText,
        headers: {
          'Content-Type': resp.headers.get('Content-Type') || 'text/html',
          'Cache-Control': 'public, max-age=3600',
        },
      });
    } catch (err) {
      return corsResponse(`Upstream error: ${err}`, { status: 502 });
    }
  },
};
