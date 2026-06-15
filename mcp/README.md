# stathead-mcp

An [MCP](https://modelcontextprotocol.io) server that exposes
[StatHead](https://github.com/dachhack/stathead)'s NFL fantasy-analytics
toolset to Claude (Desktop / Code), Cursor, or any MCP client — so you can ask
natural-language questions and get live, structured NFL data back.

It ships as a single self-contained bundle with **no runtime dependencies** and
fetches all data on demand, so there's nothing to download or build — `npx` and
go.

## What you get

29 tools spanning player and team data, including:

| Area | Tools |
| --- | --- |
| Discovery | `get_metadata` — sources, season coverage, and valid enums (call this first to scope a question) |
| Players | season stats, weekly/game logs, snap counts, injuries, advanced stats, Next Gen Stats, rosters, contracts, depth charts |
| Games & plays | schedules/results, play-by-play, participation, FTN charting |
| Fantasy | StatHead blended dynasty values, ADP (FFC / ESPN / Sleeper), `get_adp_with_results` (ADP vs actual finish), trending adds/drops, projections |
| Draft & college | draft picks, `get_rookie_class` (draft+combine+rookie stats in one call), prospect profiles, combine, college stats (player or cohort), QBR |

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

## Data sources & freshness

Most tools fetch live from open upstreams (nflverse, Sleeper,
FantasyFootballCalculator, ESPN's public endpoints). A handful read committed
daily snapshots (dynasty values, ADP history, consensus projections), which the
server fetches from the hosted StatHead site by default.

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

## License

MIT — see [`../LICENSE`](../LICENSE). The code is MIT; the **data** it returns
is not necessarily redistributable. See
[`DATA_SOURCES.md`](../DATA_SOURCES.md).
