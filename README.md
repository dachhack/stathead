# StatHead

**An open NFL fantasy-football analytics platform** — live data, machine-learned
projections, dynasty values, and prospect grades, served as a web app **and** as
an [MCP](https://modelcontextprotocol.io) server you can plug straight into
Claude or any AI client.

- 🌐 **Web app** — [stathead.app](https://stathead.app)
  ([QA mirror](https://dachhack.github.io/stathead/))
- 🤖 **MCP server** — 29 NFL tools for AI projects → [`mcp/`](mcp/)
- 🧠 **ML pipeline** — projection / dynasty-value / prospect models trained from
  10+ seasons of data
- 📦 **MIT-licensed code.** ⚠️ The **data** has its own terms —
  see [`DATA_SOURCES.md`](DATA_SOURCES.md) before redistributing anything.

---

## Use it in your own AI project (MCP)

The fastest way to build on StatHead. No clone, no build:

```bash
npx -y stathead-mcp
```

**Claude Code:**

```bash
claude mcp add stathead -- npx -y stathead-mcp
```

**Claude Desktop** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "stathead": { "command": "npx", "args": ["-y", "stathead-mcp"] }
  }
}
```

Then ask things like *"Compare Bijan Robinson's and Jahmyr Gibbs' weekly
consistency in 2024"* or *"Top 10 dynasty WRs by StatHead value, with their
ages."* Full tool list and configuration: [`mcp/README.md`](mcp/README.md).

## Run the web app locally

```bash
npm install
npm run dev          # Vite dev server
```

Other useful scripts:

| Script | What it does |
| --- | --- |
| `npm run build` | Production build (semantic layer → features → tsc → vite → Pages post-build) |
| `npm run build:mcp` | Bundle the MCP server → `mcp/dist/server.mjs` |
| `npm run mcp` | Run the MCP server from source (`tsx`) |
| `npm run lint` | ESLint |
| `npm run data:local` | Download data sources for local work |

The repo is a TypeScript/React (Vite) front end plus a TypeScript + Python data
& ML pipeline under [`scripts/`](scripts/) and [`python/`](python/). The same
tool layer (`src/tools.ts` → `src/data.ts`) backs both the app and the MCP
server.

## Data

StatHead pulls from many upstreams — open data (nflverse, DynastyProcess, CFBD),
public APIs (Sleeper, ESPN, FantasyFootballCalculator), proprietary community
values (KeepTradeCut, FantasyCalc), and derived features from paid scouting
products. **Licensing varies a lot by source.**

👉 **Read [`DATA_SOURCES.md`](DATA_SOURCES.md) before redistributing data,
publishing a dataset, or shipping a commercial product.** The short version:
share the open sources and StatHead's own model outputs freely; fetch the rest
from the original source under your own access rather than rebundling it.

## Data proxies (self-hosting)

Live KeepTradeCut, FantasyCalc, and ESPN data is fetched through small
Cloudflare Worker CORS proxies, because those upstream APIs block direct
browser requests. The worker source lives under [`workers/`](workers/) and a
deploy workflow is in
[`.github/workflows/deploy-workers.yml`](.github/workflows/deploy-workers.yml).

By default the app points at the upstream project's workers, so it works as
soon as you clone it. **If you deploy your own copy, stand up your own workers**
(so you don't depend on — or get rate-limited by — someone else's) and override
the URLs via env vars. Copy [`.env.example`](.env.example) to `.env.local` and set:

| Var | Proxies |
| --- | --- |
| `VITE_KTC_PROXY` | KeepTradeCut dynasty values (`workers/ktc-proxy`) |
| `VITE_FC_PROXY` | FantasyCalc values (`workers/fc-proxy`) |
| `VITE_ESPN_NEWS_PROXY` | ESPN player news/overview (`workers/espn-news-proxy`) |

Each falls back to the project's worker when unset. Deploy a worker with
`cd workers/<name> && npx wrangler deploy` (or use the deploy workflow).

## Environments

Two deploy targets, fed by the same codebase:

| Env | URL | Host | Base path | Trigger |
| --- | --- | --- | --- | --- |
| **QA** | `dachhack.github.io/stathead/` | GitHub Pages | `/stathead/` | push to the dev branch ([`deploy.yml`](.github/workflows/deploy.yml)) |
| **Production** | `stathead.app` | Cloudflare Pages | `/` | push to `production` ([`deploy-prod.yml`](.github/workflows/deploy-prod.yml)) |

The base path is set by the `BASE_PATH` env var in
[`vite.config.ts`](vite.config.ts) (default `/stathead/`); the prod
workflow builds with `BASE_PATH=/`. Everything in the app reads
`import.meta.env.BASE_URL`, so that one switch repoints every asset and
data URL.

**Promote QA → prod by merging the dev branch into `production`.** That
push builds for the root domain and uploads to Cloudflare Pages. See the
header of [`deploy-prod.yml`](.github/workflows/deploy-prod.yml) for the
one-time Cloudflare Pages + DNS setup.

## License

Code is [MIT](LICENSE). Data is **not** covered by that license — see
[`DATA_SOURCES.md`](DATA_SOURCES.md). The name "Stathead" may conflict with
[Sports Reference's Stathead](https://stathead.com) trademark; see the note in
that file.
