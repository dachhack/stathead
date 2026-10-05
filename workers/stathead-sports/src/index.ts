/**
 * Cloudflare Worker — StatHead daily-sport data service (NHL, MLB, NBA, WNBA)
 * for authorized partners.
 *
 * Token-gated and unlisted: nothing here is linked from the site, the MCP
 * server or the README. The store is filled by `src/jobs/daily.ts` (run from
 * .github/workflows/sports-daily.yml) through the admin routes; schedules and
 * in-progress box scores are read from the feeds on request and cached 60 s.
 * See src/router.ts for the routes and docs/daily-sport-service.md for the
 * contract.
 *
 * Deploy:  npx wrangler deploy   (from workers/stathead-sports/), then
 *          npx wrangler secret put API_TOKENS
 *          npx wrangler secret put ADMIN_TOKEN
 */

import { handle, type Env } from './router.js';

interface ExecutionContext {
  waitUntil(p: Promise<unknown>): void;
}

declare const caches: { default: { match(req: Request): Promise<Response | undefined>; put(req: Request, res: Response): Promise<void> } } | undefined;

export default {
  async fetch(req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const cache = typeof caches !== 'undefined' ? caches.default : undefined;
    return handle(req, env, { cache });
  },
};
