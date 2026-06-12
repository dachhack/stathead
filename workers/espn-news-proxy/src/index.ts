/**
 * Cloudflare Worker – CORS proxy for ESPN per-player news.
 *
 * ESPN's athlete news endpoint isn't reliably CORS-open, so the browser can't
 * call it directly. This worker fronts the call and adds CORS.
 *
 * Route:  GET /news/<espnAthleteId>?limit=8   (edge-cached, EDGE_TTL)
 * Upstream (athlete "overview" – embeds a recent-news array; the dedicated
 *   .../athletes/<id>/news path 404s on ESPN's backend):
 *   https://site.web.api.espn.com/apis/common/v3/sports/football/nfl/athletes/<id>/overview
 *
 * The overview payload is large (full gamelog/events dominate it), so we keep
 * only the lightweight, card-relevant slices and return them as
 * { articles, rotowire, fantasy, awards, statistics }. If the shape is
 * unexpected we fall back to passing the raw upstream body through, so the
 * (defensive) client parser still has a shot.
 *
 * This is the only per-user live external call in the app — KTC/FantasyCalc
 * render from committed snapshots. CORS is restricted to the StatHead
 * origins (echoed, with Vary: Origin) and successful responses are stored
 * in the Cloudflare edge cache (without the per-origin CORS header), so a
 * popular player's news is fetched from ESPN at most once per EDGE_TTL.
 *
 * Deploy:  npx wrangler deploy   (from workers/espn-news-proxy/)
 */

// Cloudflare runtime globals (no @cloudflare/workers-types dependency).
declare const caches: { default: { match(req: Request): Promise<Response | undefined>; put(req: Request, resp: Response): Promise<void> } };
interface Ctx { waitUntil(p: Promise<unknown>): void }

const EDGE_TTL = 900; // seconds (15m) — news moves intraday

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
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function withCors(resp: Response, origin: string | null): Response {
  const headers = new Headers(resp.headers);
  for (const [k, v] of Object.entries(corsHeaders(origin))) headers.set(k, v);
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers });
}

export default {
  async fetch(request: Request, _env: unknown, ctx: Ctx): Promise<Response> {
    const origin = request.headers.get('Origin');

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) });
    if (request.method !== 'GET') return withCors(new Response('Method not allowed', { status: 405 }), origin);

    const url = new URL(request.url);
    const m = url.pathname.match(/^\/news\/(\d+)$/);
    if (!m) return withCors(new Response('Not found', { status: 404 }), origin);

    // Serve from the edge cache (key includes id + limit); fetch + slim on miss.
    const cache = caches.default;
    const cacheKey = new Request(url.toString(), { method: 'GET' });
    const hit = await cache.match(cacheKey);
    if (hit) return withCors(hit, origin);

    const id = m[1];
    const limit = Number((url.searchParams.get('limit') || '8').replace(/\D/g, '')) || 8;
    const upstream = `https://site.web.api.espn.com/apis/common/v3/sports/football/nfl/athletes/${id}/overview?region=us&lang=en`;

    try {
      const resp = await fetch(upstream, {
        method: 'GET',
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          Accept: 'application/json',
          Referer: 'https://www.espn.com/',
        },
      });

      const text = await resp.text();
      if (!resp.ok) {
        // Surface the upstream error (client treats non-200 as "no news"); don't cache.
        return withCors(
          new Response(text, {
            status: resp.status,
            statusText: resp.statusText,
            headers: { 'Content-Type': resp.headers.get('Content-Type') || 'application/json' },
          }),
          origin,
        );
      }

      // Slim the (large) overview payload down to the card-relevant slices.
      let bodyOut = text;
      try {
        const data = JSON.parse(text) as Record<string, unknown>;
        if (Array.isArray(data.news)) {
          bodyOut = JSON.stringify({
            articles: (data.news as unknown[]).slice(0, limit),
            rotowire: data.rotowire,
            fantasy: data.fantasy,
            awards: data.awards,
            statistics: data.statistics,
          });
        }
      } catch {
        // fall through to raw passthrough (bodyOut stays = text)
      }

      const cached = new Response(bodyOut, {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${EDGE_TTL}` },
      });
      ctx.waitUntil(cache.put(cacheKey, cached.clone()));
      return withCors(cached, origin);
    } catch (err) {
      return withCors(new Response(`Upstream error: ${err}`, { status: 502 }), origin);
    }
  },
};
