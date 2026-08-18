# stathead-mcp

An [MCP](https://modelcontextprotocol.io) server that exposes
[StatHead](https://github.com/dachhack/stathead)'s NFL fantasy-analytics
toolset to Claude (Desktop / Code), Cursor, or any MCP client — so you can ask
natural-language questions and get live, structured NFL data back.

It ships as a single self-contained bundle with **no runtime dependencies** and
fetches all data on demand, so there's nothing to download or build — `npx` and
go.

## What you get

50 tools spanning player and team data, including:

| Area | Tools |
| --- | --- |
| Discovery | `get_metadata` — sources, season coverage, and valid enums (call this first to scope a question) |
| Players | season stats, weekly/game logs, snap counts, injuries, advanced stats, Next Gen Stats, rosters, contracts, depth charts |
| Games & plays | schedules/results, play-by-play, participation, FTN charting |
| Fantasy | StatHead blended dynasty values, `get_projections` (StatHead's in-house season PPG model), `get_weekly_projections` (per-week matchup-adjusted points, weeks 1–18), `get_player_props` (per-week stat lines priced as props — line, over/under, p10–p90 — with strength of matchup overall, by fantasy position and by stat), `get_rest_of_game_props` (what's left after Q1 / halftime / Q3, adjusted for score and in-game pace), ADP (FFC / ESPN / Sleeper), `get_adp_with_results` (ADP vs actual finish), trending adds/drops |
| Sleeper leagues | `get_sleeper_user_leagues`, `get_sleeper_league` (standings + rosters), `get_sleeper_league_users` (cheap manager list), `get_sleeper_matchups`, `get_sleeper_transactions` (trades/waivers/adds), `get_sleeper_waiver_wire` (free agents × trending × projections), `get_sleeper_draft`, `get_sleeper_user_snooper` (cross-league exposure), `get_sleeper_user_history` (multi-season records + titles) — a connected graph: a username lists leagues, a league name (or id) opens that league, and each manager's `owner_id`/display name walks back to *their* leagues, exposure, and history |
| Draft & college | `get_prospect_outcomes` (calibrated boom/bust probabilities + grades), draft picks, `get_rookie_class` (draft+combine+rookie stats in one call), prospect profiles, combine, college stats (player or cohort), QBR |
| Model & methodology | `get_model_docs` (how the models work + per-position feature importance), `get_player_features` (why a player is scored the way they are — feature drivers, bands, direction) |
| Your own numbers | `export_excel` / `import_excel` / `clear_overrides` — download a styled projections / rankings / rookie-rankings workbook (or a `by_team` projection sheet with live PPR formulas), edit it, re-upload it, and have your values drive every later query |

### Bring your own projections & rankings

The same boards the website lets you download are available over MCP as real
`.xlsx` files (built with zero extra dependencies — Node's own `zlib`):

1. `export_excel kind="projections"` (or `rankings`, `rookie_rankings`) writes a
   styled workbook to disk and returns its path. Edit the highlighted column —
   **Proj PPG** for projections, **My Rank** for rankings/rookies — in Excel or
   Google Sheets.
2. `import_excel path="…"` reads it back and saves your values as overrides.
3. `get_projections`, `get_fantasy_rankings`, and `get_prospect_outcomes` then
   automatically use **your** numbers (flagged in the output) until you run
   `clear_overrides`.

Workbooks default to `$STATHEAD_DIR` (or the current working directory); pass
`path` to choose where they land. Overrides persist in
`$STATHEAD_DIR`/`~/.stathead/overrides.json`.

## Quick start

Run it directly — no install, no clone:

```bash
npx -y stathead-mcp
```

It speaks MCP over stdio, so you normally wire it into a client rather than run
it by hand.

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`
(macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "stathead": {
      "command": "npx",
      "args": ["-y", "stathead-mcp"]
    }
  }
}
```

### Claude Code

```bash
claude mcp add stathead -- npx -y stathead-mcp
```

### Cursor / other MCP clients

Use the same `command`/`args` (`npx -y stathead-mcp`) in the client's MCP
config.

### Claude mobile apps / claude.ai web / Claude Desktop (remote connector)

Prefer a URL over a local command? The same tools are hosted over MCP's
Streamable HTTP transport by a Cloudflare Worker (`workers/stathead-mcp/`,
deployed via `deploy-workers.yml`):

```
https://stathead-mcp.dachhack.workers.dev
```

Add it under **Settings → Connectors → Add custom connector**, paste the URL,
and save — no command, no API key. (A `GET` to that URL returns a small health
payload; clients `POST` JSON-RPC to it.) The npm/stdio package above stays the
path for Claude Code and Cursor.

The Worker records a privacy-respecting usage counter (MCP method + tool name
only — no IPs or request bodies) to a Cloudflare Analytics Engine dataset
(`stathead_mcp_usage`). View aggregates at `GET /stats` once you set the
`CF_ACCOUNT_ID` + `CF_ANALYTICS_TOKEN` worker secrets (`wrangler secret put …`),
or query the dataset in the Cloudflare dashboard. npm download counts don't see
remote-connector usage — this does.

## Data sources & freshness

Most tools fetch live from open upstreams (nflverse, Sleeper,
FantasyFootballCalculator, ESPN's public endpoints). A handful read committed
daily snapshots (StatHead's blended dynasty values, ADP history, in-house
season projections), which the server fetches from the hosted StatHead site by
default.

Please review **[`DATA_SOURCES.md`](../DATA_SOURCES.md)** before redistributing
any data this server returns — several upstreams are proprietary or paid and
carry their own terms.

### Configuration

All optional, via environment variables:

| Var | Default | Purpose |
| --- | --- | --- |
| `STATHEAD_DATA_BASE` | GitHub raw (data branch) | Base URL for committed snapshot data (`<base>data/<file>`). Defaults to GitHub raw, which serves every file uncompressed/reliably (the Cloudflare host gzips files over its 25 MiB cap, which Node can't decode). Override to point at your own deployment or a local `http://localhost:5173/` dev server. |
| `VITE_KTC_PROXY` | project worker | CORS proxy for KeepTradeCut. Deploy your own (`workers/ktc-proxy`) to avoid shared rate limits. |
| `VITE_FC_PROXY` | project worker | CORS proxy for FantasyCalc (`workers/fc-proxy`). |
| `VITE_ODDS_API_KEY` | — | Enables betting-odds tools ([the-odds-api.com](https://the-odds-api.com)). |

Running from a full repo checkout instead? The server reads snapshots straight
from local `public/data/` and ignores `STATHEAD_DATA_BASE`.

## Building from source

The bundle is produced from the StatHead monorepo:

```bash
# from the repo root
npm install
npm run build:mcp      # → mcp/dist/server.mjs (esbuild, single file)
node mcp/dist/server.mjs
```

## Publishing

```bash
npm run build:mcp                  # repo root — refresh the bundle
cd mcp && npm publish --access public
```

The published tarball is just `dist/server.mjs` + this README (~220 KB).

### Listing in the MCP Registry

`server.json` is the manifest for the official [MCP Registry](https://registry.modelcontextprotocol.io)
(`io.github.dachhack/stathead-mcp`). After an npm publish, the
**Publish to MCP Registry** workflow (`.github/workflows/publish-mcp-registry.yml`)
pushes it — authenticating via GitHub OIDC for the `io.github.dachhack/*`
namespace (no secret). The npm package carries a matching `mcpName` field so the
registry can verify the package belongs to this entry, and the workflow syncs
`server.json`'s version from `package.json` so they never drift.

Most community directories (Glama, mcp.so, PulseMCP) mirror the official
registry and/or auto-index public npm packages with the `model-context-protocol`
keyword (which `package.json` has), so a registry publish propagates to them.

## License

MIT — see [`../LICENSE`](../LICENSE). The code is MIT; the **data** it returns
is not necessarily redistributable. See
[`DATA_SOURCES.md`](../DATA_SOURCES.md).
