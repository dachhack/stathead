/**
 * Cloudflare Worker – CORS proxy for ESPN per-player news.
 *
 * ESPN's athlete news endpoint isn't reliably CORS-open, so the browser can't
 * call it directly. This worker fronts the call and adds CORS.
 *
 * Routes: GET /news/<espnAthleteId>?limit=8   (edge-cached, EDGE_TTL)
 *         GET /league/<season>/<leagueId>       ESPN fantasy league: teams, rosters,
 *             lineup slots and scoring (slimmed). Public leagues need nothing;
 *             a private league sends the manager's own ESPN cookies as request
 *             headers X-ESPN-S2 / X-ESPN-SWID, which are forwarded upstream as
 *             the Cookie header and never stored or cached (edge cache only
 *             holds responses fetched without credentials, LEAGUE_TTL).
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

import { slimEspnLeague } from '../../../src/lib/espnLeagueSlim';

// Cloudflare runtime globals (no @cloudflare/workers-types dependency).
declare const caches: { default: { match(req: Request): Promise<Response | undefined>; put(req: Request, resp: Response): Promise<void> } };
interface Ctx { waitUntil(p: Promise<unknown>): void }

const EDGE_TTL = 900; // seconds (15m) — news moves intraday
const LEAGUE_TTL = 300; // seconds (5m) — rosters move on waivers and trades
const ESPN_FANTASY = 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl';

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
    'Access-Control-Allow-Headers': 'Content-Type, X-ESPN-S2, X-ESPN-SWID',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function withCors(resp: Response, origin: string | null): Response {
  const headers = new Headers(resp.headers);
  for (const [k, v] of Object.entries(corsHeaders(origin))) headers.set(k, v);
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers });
}

// ── ESPN fantasy league ─────────────────────────────────────────────────────

async function leagueRoute(season: string, leagueId: string, request: Request, ctx: Ctx): Promise<Response> {
  const s2 = request.headers.get('X-ESPN-S2');
  const swid = request.headers.get('X-ESPN-SWID');
  const authed = !!(s2 && swid);
  const upstream = `${ESPN_FANTASY}/seasons/${season}/segments/0/leagues/${leagueId}?view=mTeam&view=mRoster&view=mSettings`;
  const cache = caches.default;
  const cacheKey = new Request(`https://espn-news-proxy.cache/league/${season}/${leagueId}`, { method: 'GET' });
  if (!authed) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }
  const headers: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    Accept: 'application/json',
    Referer: 'https://fantasy.espn.com/',
  };
  // The manager's own session, only when they supplied it; it goes upstream
  // and nowhere else.
  if (authed) headers.Cookie = `espn_s2=${s2}; SWID=${swid}`;
  try {
    const resp = await fetch(upstream, { method: 'GET', headers });
    const text = await resp.text();
    if (!resp.ok) {
      const msg = resp.status === 401 || resp.status === 403
        ? 'ESPN refused: this league is private. Paste your espn_s2 and SWID cookies to load it.'
        : resp.status === 404 ? 'ESPN has no league with that id for that season.' : `ESPN returned ${resp.status}.`;
      return new Response(JSON.stringify({ error: msg, status: resp.status }), { status: resp.status, headers: { 'Content-Type': 'application/json' } });
    }
    let data: unknown;
    try { data = JSON.parse(text); } catch { return new Response(JSON.stringify({ error: 'ESPN sent something that is not JSON.' }), { status: 502, headers: { 'Content-Type': 'application/json' } }); }
    const body = JSON.stringify(slimEspnLeague(data));
    const out = new Response(body, { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': authed ? 'no-store' : `public, max-age=${LEAGUE_TTL}` } });
    if (!authed) ctx.waitUntil(cache.put(cacheKey, out.clone()));
    return out;
  } catch (err) {
    return new Response(JSON.stringify({ error: `Upstream error: ${err}` }), { status: 502, headers: { 'Content-Type': 'application/json' } });
  }
}

export default {
  async fetch(request: Request, _env: unknown, ctx: Ctx): Promise<Response> {
    const origin = request.headers.get('Origin');

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) });
    if (request.method !== 'GET') return withCors(new Response('Method not allowed', { status: 405 }), origin);

    const url = new URL(request.url);
    const lg = url.pathname.match(/^\/league\/(\d{4})\/(\d+)$/);
    if (lg) return withCors(await leagueRoute(lg[1], lg[2], request, ctx), origin);
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
