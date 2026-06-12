/**
 * Cloudflare Worker – lightweight CORS proxy for KeepTradeCut.
 *
 * Allowed upstream paths:
 *   GET  /dynasty-rankings?…           (edge-cached, EDGE_TTL)
 *   POST /dynasty-rankings/histories   (proxied, not cached)
 *
 * CORS is restricted to the StatHead origins — QA on GitHub Pages, prod
 * on stathead.app, plus local/preview hosts — echoed per request with
 * `Vary: Origin`. GET responses are stored in the Cloudflare edge cache
 * WITHOUT the per-origin CORS header (which is re-added on every hit), so
 * a single cached body serves every allowed origin correctly and most
 * user requests never reach KeepTradeCut.
 *
 * Note: in production the app reads committed daily snapshots
 * (public/data/ktc_rankings_*.json, ktc_history.json) and only falls
 * back to this worker when a snapshot is missing — so this is the
 * resilience/abuse-control layer, not the hot path.
 *
 * Deploy:  npx wrangler deploy   (from workers/ktc-proxy/)
 */

// Cloudflare runtime globals (no @cloudflare/workers-types dependency).
declare const caches: { default: { match(req: Request): Promise<Response | undefined>; put(req: Request, resp: Response): Promise<void> } };
interface Ctx { waitUntil(p: Promise<unknown>): void }

const KTC_BASE = 'https://keeptradecut.com';
const EDGE_TTL = 3600; // seconds (1h)

/** StatHead origins + local/preview hosts. Anything else is refused by
 *  the browser (we hand back a non-matching ACAO). */
function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return false;
  try {
    const h = new URL(origin).hostname;
    return (
      h === 'dachhack.github.io' ||
      h === 'stathead.app' ||
      h === 'www.stathead.app' ||
      h === 'localhost' ||
      h === '127.0.0.1' ||
      h.endsWith('.pages.dev') // Cloudflare Pages preview deploys
    );
  } catch {
    return false;
  }
}

function corsHeaders(origin: string | null): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': isAllowedOrigin(origin) ? (origin as string) : 'https://stathead.app',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

/** Re-wrap a response with per-request CORS headers. */
function withCors(resp: Response, origin: string | null): Response {
  const headers = new Headers(resp.headers);
  for (const [k, v] of Object.entries(corsHeaders(origin))) headers.set(k, v);
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers });
}

const UPSTREAM_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Referer: 'https://keeptradecut.com/',
  Origin: 'https://keeptradecut.com',
};

export default {
  async fetch(request: Request, _env: unknown, ctx: Ctx): Promise<Response> {
    const origin = request.headers.get('Origin');

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    const url = new URL(request.url);
    const path = url.pathname + url.search;
    if (!path.startsWith('/dynasty-rankings')) {
      return withCors(new Response('Not found', { status: 404 }), origin);
    }

    const upstreamUrl = `${KTC_BASE}${path}`;

    // POST (histories) — body-dependent, so not cached.
    if (request.method === 'POST') {
      try {
        const resp = await fetch(upstreamUrl, {
          method: 'POST',
          headers: {
            ...UPSTREAM_HEADERS,
            Accept: request.headers.get('Accept') || '*/*',
            'Content-Type': request.headers.get('Content-Type') || 'application/json',
          },
          body: await request.text(),
        });
        return withCors(
          new Response(resp.body, {
            status: resp.status,
            statusText: resp.statusText,
            headers: { 'Content-Type': resp.headers.get('Content-Type') || 'text/html' },
          }),
          origin,
        );
      } catch (err) {
        return withCors(new Response(`Upstream error: ${err}`, { status: 502 }), origin);
      }
    }

    if (request.method !== 'GET') {
      return withCors(new Response('Method not allowed', { status: 405 }), origin);
    }

    // GET rankings — serve from the edge cache, populating on a miss.
    // Key is the worker URL (origin-agnostic); the cached body carries no
    // ACAO so it's reused across every allowed origin.
    const cache = caches.default;
    const cacheKey = new Request(url.toString(), { method: 'GET' });
    let cached = await cache.match(cacheKey);
    if (!cached) {
      try {
        const resp = await fetch(upstreamUrl, {
          method: 'GET',
          headers: { ...UPSTREAM_HEADERS, Accept: request.headers.get('Accept') || '*/*' },
        });
        const body = await resp.text();
        cached = new Response(body, {
          status: resp.status,
          statusText: resp.statusText,
          headers: {
            'Content-Type': resp.headers.get('Content-Type') || 'text/html',
            'Cache-Control': `public, max-age=${EDGE_TTL}`,
          },
        });
        if (resp.ok) ctx.waitUntil(cache.put(cacheKey, cached.clone()));
      } catch (err) {
        return withCors(new Response(`Upstream error: ${err}`, { status: 502 }), origin);
      }
    }
    return withCors(cached, origin);
  },
};
