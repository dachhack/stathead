/**
 * Cloudflare Worker – reliable timer for the injury-status refresh.
 *
 * GitHub Actions' `schedule:` trigger is best-effort and drops runs when the
 * platform is busy: refresh-injuries.yml (cron every 20 min) ran once in its
 * first 11 hours, and refresh-data.yml (cron hourly) ran 4 times in a day.
 * This worker's cron trigger (wrangler.toml) fires on time and starts the
 * workflow through the GitHub API (workflow_dispatch).
 *
 * Routes: GET /  → JSON status: config, whether GH_TOKEN is set, and the result
 *                  of the most recent dispatch this isolate made (best-effort;
 *                  isolates recycle, so check Cloudflare's cron logs or the
 *                  workflow's run list for history).
 *
 * Deploy:  npx wrangler deploy   (from workers/refresh-scheduler/), then
 *          npx wrangler secret put GH_TOKEN
 */

interface Env {
  GH_TOKEN?: string;
  REPO: string;
  WORKFLOW: string;
  REF: string;
}
interface Ctx { waitUntil(p: Promise<unknown>): void }
interface ScheduledEvent { cron: string; scheduledTime: number }

let last: { at: string; cron: string; status: number | null; detail: string } | null = null;

async function dispatch(env: Env, cron: string): Promise<void> {
  const at = new Date().toISOString();
  if (!env.GH_TOKEN) {
    last = { at, cron, status: null, detail: 'GH_TOKEN secret is not set' };
    console.error('refresh-scheduler: GH_TOKEN secret is not set; nothing dispatched');
    return;
  }
  const url = `https://api.github.com/repos/${env.REPO}/actions/workflows/${env.WORKFLOW}/dispatches`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.GH_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'stathead-refresh-scheduler',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ref: env.REF }),
  });
  // 204 No Content on success.
  const detail = resp.status === 204 ? 'dispatched' : (await resp.text()).slice(0, 300);
  last = { at, cron, status: resp.status, detail };
  if (resp.status !== 204) {
    console.error(`refresh-scheduler: dispatch failed ${resp.status}: ${detail}`);
    // Throwing marks the cron invocation as failed in Cloudflare's logs.
    throw new Error(`dispatch failed: HTTP ${resp.status}`);
  }
  console.log(`refresh-scheduler: dispatched ${env.WORKFLOW} on ${env.REF} (${cron})`);
}

export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: Ctx): Promise<void> {
    ctx.waitUntil(dispatch(env, event.cron));
  },

  async fetch(_req: Request, env: Env): Promise<Response> {
    const body = {
      worker: 'refresh-scheduler',
      repo: env.REPO,
      workflow: env.WORKFLOW,
      ref: env.REF,
      schedule: '7,27,47 11-23,0-4 * * * (UTC) — every 20 min, 7am-11pm ET',
      tokenConfigured: !!env.GH_TOKEN,
      lastDispatchThisIsolate: last,
    };
    return new Response(JSON.stringify(body, null, 2), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  },
};
