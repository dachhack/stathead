/**
 * Cloudflare Worker – CORS proxy for ESPN per-player news.
 *
 * ESPN's athlete news endpoint isn't reliably CORS-open, so the browser can't
 * call it directly. This worker fronts the call and adds permissive CORS.
 *
 * Route:  GET /news/<espnAthleteId>?limit=8
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
 * Deploy:  npx wrangler deploy   (from workers/espn-news-proxy/)
 */

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

function corsResponse(body: BodyInit | null, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  return new Response(body, { ...init, headers });
}

function jsonResponse(data: unknown, status = 200): Response {
  return corsResponse(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=900' },
  });
}

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method === 'OPTIONS') return corsResponse(null, { status: 204 });
    if (request.method !== 'GET') return corsResponse('Method not allowed', { status: 405 });

    const url = new URL(request.url);
    const m = url.pathname.match(/^\/news\/(\d+)$/);
    if (!m) return corsResponse('Not found', { status: 404 });

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
        // Surface the upstream error (the client treats non-200 as "no news").
        return corsResponse(text, {
          status: resp.status,
          statusText: resp.statusText,
          headers: { 'Content-Type': resp.headers.get('Content-Type') || 'application/json' },
        });
      }

      // Slim the (large) overview payload down to the card-relevant slices.
      try {
        const data = JSON.parse(text) as Record<string, unknown>;
        if (Array.isArray(data.news)) {
          return jsonResponse({
            articles: (data.news as unknown[]).slice(0, limit),
            rotowire: data.rotowire,
            fantasy: data.fantasy,
            awards: data.awards,
            statistics: data.statistics,
          });
        }
      } catch {
        // fall through to raw passthrough
      }
      // Unexpected shape – hand the raw body to the client's defensive parser.
      return corsResponse(text, {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=900' },
      });
    } catch (err) {
      return corsResponse(`Upstream error: ${err}`, { status: 502 });
    }
  },
};
