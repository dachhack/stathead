/**
 * Cloudflare Worker – first-party, privacy-friendly visitor tracking for
 * StatHead. No cookies, no localStorage, no third parties, no raw IPs
 * stored — the app fires a `sendBeacon` per view and this worker writes a
 * data point to Workers Analytics Engine.
 *
 * Endpoints:
 *   POST /hit     – pageview beacon from the app. Body: {"page":"…","ref":"…"}.
 *                   Only recorded when the request Origin is a StatHead host.
 *   GET  /stats   – aggregated JSON (daily views/visitors, top pages,
 *                   referrers, countries). `?days=1..90` window (default 30).
 *                   Aggregates only — safe to leave public. Edge-cached 5 min.
 *   GET  /        – tiny self-contained HTML dashboard over /stats.
 *
 * Anonymous visitors: each hit stores SHA-256(UTC date | IP | user agent)
 * truncated to 8 bytes. The hash rotates daily, so a "visitor" is
 * "distinct browser today" and nothing links a browser across days.
 *
 * Data point layout (dataset `stathead_visits`):
 *   blob1 page        tab id, 'player-detail', …
 *   blob2 site host   stathead.app / dachhack.github.io / *.pages.dev
 *   blob3 referrer    external referrer hostname ('' = direct/internal)
 *   blob4 country     ISO code from request.cf
 *   blob5 visitor     daily-rotating anonymous hash
 *   double1           1 (a pageview)
 *   index1            visitor hash (sampling key)
 *
 * /stats needs a Cloudflare API token with **Account Analytics: Read**,
 * pushed as the ANALYTICS_API_TOKEN worker secret (deploy-workers.yml does
 * this from the CLOUDFLARE_ANALYTICS_API_TOKEN repo secret, falling back to
 * CLOUDFLARE_API_TOKEN — the fallback only works if that token carries the
 * Analytics permission). Optional CF_ACCOUNT_ID secret skips account
 * auto-discovery. Beacon ingestion works with no secrets at all.
 *
 * Deploy:  npx wrangler deploy   (from workers/visit-tracker/)
 */

// Cloudflare runtime globals (no @cloudflare/workers-types dependency).
declare const caches: { default: { match(req: Request): Promise<Response | undefined>; put(req: Request, resp: Response): Promise<void> } };
interface Ctx { waitUntil(p: Promise<unknown>): void }
interface AnalyticsDataset { writeDataPoint(point: { blobs?: string[]; doubles?: number[]; indexes?: string[] }): void }
interface Env { VISITS: AnalyticsDataset; ANALYTICS_API_TOKEN?: string; CF_ACCOUNT_ID?: string }

const DATASET = 'stathead_visits';
const STATS_TTL = 300; // seconds of edge cache on /stats
const CF_API = 'https://api.cloudflare.com/client/v4';

function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return false;
  try {
    return isStatHeadHost(new URL(origin).hostname);
  } catch {
    return false;
  }
}

function isStatHeadHost(h: string): boolean {
  return (
    h === 'dachhack.github.io' ||
    h === 'stathead.app' ||
    h === 'www.stathead.app' ||
    h === 'localhost' ||
    h === '127.0.0.1' ||
    h.endsWith('.pages.dev') // Cloudflare Pages preview deploys
  );
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

function withCors(resp: Response, origin: string | null): Response {
  const headers = new Headers(resp.headers);
  for (const [k, v] of Object.entries(corsHeaders(origin))) headers.set(k, v);
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers });
}

/** Daily-rotating anonymous visitor id: SHA-256(UTC date | ip | ua), 8 bytes hex. */
async function visitorHash(ip: string, ua: string): Promise<string> {
  const day = new Date().toISOString().slice(0, 10);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${day}|${ip}|${ua}`));
  return [...new Uint8Array(digest).slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function looksLikeBot(ua: string): boolean {
  return /bot|spider|crawl|headless|prerender|lighthouse|pingdom/i.test(ua);
}

async function recordHit(request: Request, env: Env): Promise<void> {
  const origin = request.headers.get('Origin');
  if (!isAllowedOrigin(origin)) return; // silently drop non-StatHead traffic
  const ua = request.headers.get('User-Agent') || '';
  if (looksLikeBot(ua)) return;

  const raw = await request.text();
  if (raw.length > 1000) return;
  let body: { page?: unknown; ref?: unknown };
  try {
    body = JSON.parse(raw);
  } catch {
    return;
  }
  const page = String(body.page ?? '').slice(0, 120);
  if (!page) return;

  // External referrer hostname only; own hosts count as internal → ''.
  let refHost = '';
  try {
    const h = new URL(String(body.ref ?? '')).hostname;
    if (h && !isStatHeadHost(h)) refHost = h;
  } catch { /* direct visit or unparsable referrer */ }

  const siteHost = new URL(origin as string).hostname;
  const cf = (request as Request & { cf?: { country?: string } }).cf;
  const visitor = await visitorHash(request.headers.get('CF-Connecting-IP') || '', ua);

  env.VISITS.writeDataPoint({
    blobs: [page, siteHost, refHost, cf?.country ?? '', visitor],
    doubles: [1],
    indexes: [visitor],
  });
}

// ---------------------------------------------------------------------------
// /stats — aggregation over the Analytics Engine SQL API
// ---------------------------------------------------------------------------

let discoveredAccountId: string | null = null;

async function resolveAccountId(env: Env): Promise<string> {
  if (env.CF_ACCOUNT_ID) return env.CF_ACCOUNT_ID;
  if (discoveredAccountId) return discoveredAccountId;
  const resp = await fetch(`${CF_API}/accounts`, {
    headers: { Authorization: `Bearer ${env.ANALYTICS_API_TOKEN}` },
  });
  const json = (await resp.json()) as { result?: Array<{ id?: string }> };
  const id = json.result?.[0]?.id;
  if (!id) throw new Error('Could not auto-discover the Cloudflare account id — set the CF_ACCOUNT_ID worker secret.');
  discoveredAccountId = id;
  return id;
}

async function sqlQuery(env: Env, accountId: string, sql: string): Promise<Array<Record<string, unknown>>> {
  const resp = await fetch(`${CF_API}/accounts/${accountId}/analytics_engine/sql`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.ANALYTICS_API_TOKEN}` },
    body: `${sql} FORMAT JSON`,
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`Analytics SQL API ${resp.status}: ${text.slice(0, 300)}`);
  return (JSON.parse(text) as { data?: Array<Record<string, unknown>> }).data ?? [];
}

/** `sum(_sample_interval)` un-samples counts if AE ever samples this dataset. */
function topQuery(blob: string, alias: string, days: number, extraWhere = ''): string {
  return `SELECT ${blob} AS ${alias}, sum(_sample_interval) AS views
    FROM ${DATASET}
    WHERE timestamp > now() - INTERVAL '${days}' DAY ${extraWhere}
    GROUP BY ${alias} ORDER BY views DESC LIMIT 25`;
}

async function buildStats(env: Env, days: number): Promise<Record<string, unknown>> {
  const accountId = await resolveAccountId(env);
  const q = (sql: string) => sqlQuery(env, accountId, sql);
  const windowWhere = `WHERE timestamp > now() - INTERVAL '${days}' DAY`;

  // count(DISTINCT …) guarded separately: if the SQL dialect rejects it,
  // views still render and visitor counts degrade to null.
  const [daily, dailyVisitors, totalVisitors, pages, referrers, countries] = await Promise.all([
    q(`SELECT toStartOfInterval(timestamp, INTERVAL '1' DAY) AS day, sum(_sample_interval) AS views
       FROM ${DATASET} ${windowWhere} GROUP BY day ORDER BY day ASC`),
    q(`SELECT toStartOfInterval(timestamp, INTERVAL '1' DAY) AS day, count(DISTINCT blob5) AS visitors
       FROM ${DATASET} ${windowWhere} GROUP BY day ORDER BY day ASC`).catch(() => null),
    q(`SELECT count(DISTINCT blob5) AS visitors FROM ${DATASET} ${windowWhere}`).catch(() => null),
    q(topQuery('blob1', 'page', days)),
    q(topQuery('blob3', 'referrer', days, "AND blob3 != ''")),
    q(topQuery('blob4', 'country', days, "AND blob4 != ''")),
  ]);

  const visitorsByDay = new Map((dailyVisitors ?? []).map((r) => [String(r.day), Number(r.visitors)]));
  const dailyOut = daily.map((r) => ({
    date: String(r.day).slice(0, 10),
    views: Number(r.views),
    visitors: visitorsByDay.get(String(r.day)) ?? null,
  }));

  return {
    updated: new Date().toISOString(),
    days,
    totals: {
      views: dailyOut.reduce((s, d) => s + d.views, 0),
      visitors: totalVisitors?.[0] ? Number(totalVisitors[0].visitors) : null,
    },
    daily: dailyOut,
    pages,
    referrers,
    countries,
  };
}

async function handleStats(request: Request, env: Env, ctx: Ctx, origin: string | null): Promise<Response> {
  if (!env.ANALYTICS_API_TOKEN) {
    return withCors(
      Response.json(
        { error: 'ANALYTICS_API_TOKEN is not configured. Create a Cloudflare API token with "Account Analytics: Read", add it as the CLOUDFLARE_ANALYTICS_API_TOKEN repo secret, and re-run deploy-workers.yml.' },
        { status: 501 },
      ),
      origin,
    );
  }
  const url = new URL(request.url);
  const days = Math.min(90, Math.max(1, Number(url.searchParams.get('days')) || 30));

  // Same edge-cache pattern as the proxy workers: origin-agnostic key, no
  // ACAO stored, CORS re-added per request.
  const cache = caches.default;
  const cacheKey = new Request(`${url.origin}/stats?days=${days}`, { method: 'GET' });
  let cached = await cache.match(cacheKey);
  if (!cached) {
    try {
      const stats = await buildStats(env, days);
      cached = Response.json(stats, { headers: { 'Cache-Control': `public, max-age=${STATS_TTL}` } });
      ctx.waitUntil(cache.put(cacheKey, cached.clone()));
    } catch (err) {
      return withCors(Response.json({ error: String(err) }, { status: 502 }), origin);
    }
  }
  return withCors(cached, origin);
}

// ---------------------------------------------------------------------------
// / — minimal dashboard over /stats (inline, no dependencies)
// ---------------------------------------------------------------------------

const DASH_HTML = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>StatHead · Visitors</title>
<style>
:root{color-scheme:light;
  --surface:#fcfcfb;--card:#f3f2ef;--text:#0b0b0b;--text-2:#52514e;--bar:#2a78d6;--grid:#e2e1dd}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;
  --surface:#1a1a19;--card:#242423;--text:#ffffff;--text-2:#c3c2b7;--bar:#3987e5;--grid:#383835}}
*{box-sizing:border-box;margin:0}
body{background:var(--surface);color:var(--text);font:14px/1.45 system-ui,sans-serif;padding:24px;max-width:880px;margin:0 auto}
h1{font-size:18px;font-weight:600}
header{display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:16px}
select{background:var(--card);color:var(--text);border:1px solid var(--grid);border-radius:6px;padding:4px 8px;font:inherit}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:20px}
.tile{background:var(--card);border-radius:8px;padding:12px 14px}
.tile .n{font-size:26px;font-weight:650;font-variant-numeric:tabular-nums}
.tile .l{color:var(--text-2);font-size:12px}
h2{font-size:13px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:.04em;margin:22px 0 8px}
.chart{display:flex;align-items:flex-end;gap:2px;height:140px;background:var(--card);border-radius:8px;padding:10px}
.chart .bar{flex:1;min-width:2px;background:var(--bar);border-radius:4px 4px 0 0;min-height:2px}
.chart .bar:hover{opacity:.75}
table{width:100%;border-collapse:collapse}
td{padding:4px 6px;border-top:1px solid var(--grid)}
td.v{text-align:right;font-variant-numeric:tabular-nums;color:var(--text-2);white-space:nowrap}
td .meter{display:inline-block;height:8px;background:var(--bar);border-radius:4px;vertical-align:middle;margin-right:8px}
.cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:0 28px}
.err{color:var(--text-2);background:var(--card);border-radius:8px;padding:14px;white-space:pre-wrap;word-break:break-word}
details{margin-top:8px}summary{color:var(--text-2);cursor:pointer;font-size:12px}
</style></head><body>
<header><h1>StatHead visitors</h1>
<label>Window <select id="days"><option value="7">7 days</option><option value="30" selected>30 days</option><option value="90">90 days</option></select></label>
</header>
<div id="out">Loading…</div>
<script>
const out = document.getElementById('out');
const fmt = (n) => n == null ? '–' : Number(n).toLocaleString();
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function tbl(rows, key) {
  if (!rows || !rows.length) return '<td colspan=2 style="color:var(--text-2)">No data yet</td>';
  const max = Math.max(...rows.map((r) => Number(r.views)));
  return rows.map((r) =>
    '<tr><td>' + esc(r[key]) + '</td><td class=v><span class=meter style="width:' +
    Math.max(2, 60 * Number(r.views) / max) + 'px"></span>' + fmt(r.views) + '</td></tr>').join('');
}
async function load() {
  out.textContent = 'Loading…';
  try {
    const r = await fetch('/stats?days=' + document.getElementById('days').value);
    const s = await r.json();
    if (!r.ok) { out.innerHTML = '<div class=err>' + esc(s.error || r.status) + '</div>'; return; }
    const max = Math.max(1, ...s.daily.map((d) => d.views));
    out.innerHTML =
      '<div class=tiles>' +
        '<div class=tile><div class=n>' + fmt(s.totals.views) + '</div><div class=l>Pageviews · ' + s.days + 'd</div></div>' +
        '<div class=tile><div class=n>' + fmt(s.totals.visitors) + '</div><div class=l>Visitors · ' + s.days + 'd</div></div>' +
        '<div class=tile><div class=n>' + fmt(s.daily.at(-1)?.views ?? 0) + '</div><div class=l>Views today (UTC)</div></div>' +
      '</div>' +
      '<h2>Daily pageviews</h2><div class=chart>' +
        s.daily.map((d) => '<div class=bar style="height:' + Math.max(2, 100 * d.views / max) +
          '%" title="' + d.date + ': ' + fmt(d.views) + ' views' +
          (d.visitors != null ? ', ' + fmt(d.visitors) + ' visitors' : '') + '"></div>').join('') +
      '</div>' +
      '<details><summary>Daily table</summary><table>' +
        s.daily.map((d) => '<tr><td>' + d.date + '</td><td class=v>' + fmt(d.views) + ' views</td><td class=v>' + fmt(d.visitors) + ' visitors</td></tr>').join('') +
      '</table></details>' +
      '<div class=cols>' +
        '<div><h2>Top pages</h2><table>' + tbl(s.pages, 'page') + '</table></div>' +
        '<div><h2>Referrers</h2><table>' + tbl(s.referrers, 'referrer') + '</table></div>' +
        '<div><h2>Countries</h2><table>' + tbl(s.countries, 'country') + '</table></div>' +
      '</div>';
  } catch (e) { out.innerHTML = '<div class=err>' + esc(e) + '</div>'; }
}
document.getElementById('days').addEventListener('change', load);
load();
</script></body></html>`;

export default {
  async fetch(request: Request, env: Env, ctx: Ctx): Promise<Response> {
    const origin = request.headers.get('Origin');
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (url.pathname === '/hit') {
      if (request.method !== 'POST') {
        return withCors(new Response('Method not allowed', { status: 405 }), origin);
      }
      // Never let analytics failures surface to the app: always 204.
      try {
        await recordHit(request, env);
      } catch { /* drop */ }
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (url.pathname === '/stats' && request.method === 'GET') {
      return handleStats(request, env, ctx, origin);
    }

    if ((url.pathname === '/' || url.pathname === '/dash') && request.method === 'GET') {
      return new Response(DASH_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }

    return withCors(new Response('Not found', { status: 404 }), origin);
  },
};
