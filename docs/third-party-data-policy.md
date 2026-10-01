# Third-party data policy

**Third-party rankings, values and projections are inputs, never outputs.**
StatHead may use them as factors in its own numbers, but no StatHead surface
(site, MCP tool, export, generated file meant for users) shows one raw.

Third-party means anything StatHead didn't compute: KeepTradeCut (KTC),
FantasyCalc, FantasyPros ECR (and its best/worst/SD/ownership),
FantasyFootballCalculator (FFC) ADP (and its high/low/SD/times drafted),
Sleeper ADP and projections, ESPN ADP/ranks/auction values/ownership/grades,
PFF, Tankathon, NFL Mock Draft Database, Underdog and the like.

## What is allowed

| Allowed | Not allowed |
|---|---|
| A StatHead blend of two or more sources (StatHead ADP) | One source's number, or a "blend" of one source |
| A StatHead model output that uses market data as a feature (devy value model, composite, projections) | A per-source column next to the blend |
| A smooth curve fitted to a market's scale (devy composite, dynasty-slot values) | Handing the market's own sorted values to our order |
| Ranks computed on StatHead values | A source's own rank or position rank |
| Naming sources in prose ("blends FantasyPros, Sleeper and FFC") | Sums, trends or grades computed on raw third-party values |
| Platform activity counts (Sleeper trending adds/drops) | |

## Where it's implemented

- **StatHead ADP:** `src/lib/statheadAdp.ts` (site) and `statheadAdpRows` /
  `buildHistoricConsensusAdp` (MCP). Needs two or more sources.
- **StatHead dynasty values:** `scripts/build-rescale-snapshot.cjs`. The value is
  the geometric mean of FantasyCalc's value and KTC's value calibrated to the
  same scale, with a smooth log-log spline per position. Values are shown in
  tens, and position ranks are recomputed on StatHead value. The rescalers
  (`src/lib/valueRescale.ts`, MCP `makeRescaler`) never fall back to raw values.
- **StatHead rankings (MCP `get_fantasy_rankings`, `export_excel` rankings):**
  the average of the StatHead ADP rank and the StatHead projection rank.
- **Devy:** `scripts/build-devy-rankings.py` (see `docs/devy-rankings.md`).

## Known gaps

- **Raw inputs are still served.** They are committed under `public/data/` and
  published with the site: the site computes several blends in the browser, and
  the hosted MCP reads the files from the site. The repository is public, so
  they're in git history too. Closing this means precomputing the StatHead
  files in CI, serving only those, and making the repository private (or moving
  the raw inputs to private storage).
- **Live proxies** (`workers/ktc-proxy`, `workers/fc-proxy`) return raw market
  data to the browser.
- **Vegas lines** (`get_games`, Games view) are shown as published; they are
  market odds, not a ranking. Undecided.
