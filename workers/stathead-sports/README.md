# stathead-sports

A token-gated Cloudflare Worker that serves daily-sport data (NHL, MLB, NBA,
WNBA, MLS, Premier League) to authorized partners. It is not linked from the site, the MCP server
or the main README, and nothing it serves is committed to the repository.

- Contract and field dictionaries: `docs/daily-sport-service.md`.
- Routes: `src/router.ts`. Adapters: `src/sports/`. Store keys: `src/store.ts`.
- Daily fill: `src/jobs/daily.ts`, run by `.github/workflows/sports-daily.yml`.

## Local checks

```bash
cd workers/stathead-sports
npm install --no-save typescript@5 @types/node@22   # once
npx tsc -p tsconfig.json --noEmit && npx tsc -p tsconfig.jobs.json --noEmit
npx tsx test/smoke.ts                                 # live upstream smoke for all six sports + router test
npx tsx src/jobs/daily.ts --sport wnba --out out     # dry-run the daily job to files
```

## Deploy

`deploy-workers.yml` deploys it with the other workers, creates the `SPORTS`
KV namespace on first deploy, and pushes two secrets from the repository:

| Repository secret | Worker secret | Meaning |
| --- | --- | --- |
| `SPORTS_API_TOKENS` | `API_TOKENS` | `client:token,client2:token2`; each token at least 16 characters |
| `SPORTS_ADMIN_TOKEN` | `ADMIN_TOKEN` | what `sports-daily.yml` uses to write the store |
| `SPORTS_API_URL` | — | the Worker's URL, for `sports-daily.yml` |

By hand: `npx wrangler kv namespace create SPORTS`, paste the id into
`wrangler.toml`, `npx wrangler deploy`, then `npx wrangler secret put
API_TOKENS` and `npx wrangler secret put ADMIN_TOKEN`. Generate tokens with
`openssl rand -hex 24`.

## Shape

Everything under `/v1` needs `Authorization: Bearer <token>`. Bulk bundles
(directory, calendar, season lines, ADP, crosswalk, final box scores for NBA,
WNBA, MLS and the Premier League) are read from KV and were written by the daily job. Schedules by date
and box scores not yet stored are read from the feed on request and cached for
60 seconds, so a partner polling a live night costs the upstream one request
per game per minute at most.
