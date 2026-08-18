# STATUS

> Orchestrator-facing status. Keep this short and current — `meta`'s
> `/standup` reads it. In-repo WIP details belong in HANDOFF.md.
> Goal / Phase / Cadence are mirrored into `meta/projects.md`.

## Goal

A full-stack NFL fantasy football research workbench — React app, daily
data-snapshot pipelines, ML projection/value models, and an MCP server —
covering redraft, dynasty, and best-ball/SFB formats; currently being
hardened for public launch at stathead.app.

## Current phase

2026 draft-season feature work: Scott Fish Bowl 16 scoring + cheatsheet
research tab merged to the default branch
(`claude/nfl-fantasy-workbench-6D1yd`); SFB16 live-draft support in use.

## Cadence

Near-daily July–December (draft season through playoffs); maintenance-only
in the offseason. Automated daily data snapshots commit regardless.

## Last worked

2026-08-18 — In-season walk-forward model + backtest: new
`scripts/build-inseason-projections.py` re-projects each week from the weeks
already played (usage share x team volume x opponent, times per-touch
efficiency), with constants fit on 2023+2024 by
`scripts/fit-inseason-params.py` so the 2025 scoring is out of sample.
`scripts/eval-weekly-backtest.py` scores it against actuals, three naive
baselines and Sleeper's published weekly projections: MAE 4.64 / R² 0.398 /
Spearman 0.685 on PPR points, beating the prior-season line (5.28 / 0.284 /
0.588) on 59.6% of player-weeks and beating Sleeper at QB. Sleeper's raw
snapshot stays local-only per their terms; only derived metrics ship. Also
fixed a silent nflverse schema break (`recent_team`/`interceptions` renamed
for 2025+) that had been emptying every prior-season lookup.

Earlier 2026-08-18 — Player props + rest-of-game projections: two new builders
(`scripts/build-player-props.py` → `player-props-2026.json`,
`scripts/build-quarter-splits.py` → `quarter-splits-2025.json`) turn the
season pool into per-week **stat lines** (attempts / yards / TDs / targets /
receptions) priced as props — half-point line, over/under and p10–p90 range —
with strength of matchup emitted overall, by fantasy position and by stat,
plus bye weeks and injury-report availability. Play-by-play supplies
quarter-by-quarter shares, game-script multipliers by score differential and
in-game blend weights, so any full-game line converts to a rest-of-game one
after Q1 / half / Q3. Shared math in `src/lib/playerProps.ts`, mirrored into
the MCP bundle (1.0.64, tools `get_player_props` + `get_rest_of_game_props`)
and the Python package (0.4.0, `stathead.props`); new "Player Props" app tab;
both builders wired into `refresh-data.yml`.

Previously (2026-07-28) — Visitor tracking: first-party, cookie-less pageview analytics
(new `workers/visit-tracker` Cloudflare Worker on Workers Analytics
Engine + a `sendBeacon` hook in the app; daily-rotating anonymous
visitor hash, DNT/GPC honored). `/stats` JSON + mini dashboard at
visit-tracker.dachhack.workers.dev; visit counts + top
pages/referrers/countries now lead the daily report email (no in-app
stats tab by design); deploy wired into
`deploy-workers.yml`. One-time setup: add repo secret
`CLOUDFLARE_ANALYTICS_API_TOKEN` (Account Analytics: Read) and dispatch
deploy-workers after merge.

Previously (2026-07-24) — First weekly-projections layer: new
`scripts/build-weekly-projections.py` splits the season pool across the
2026 schedule (opponent def-vs-pos multipliers from 2025 points allowed,
regressed 60% + home/away, normalized back to the season line) into
committed `weekly-projections-2026.json`, refreshed daily by
`refresh-data.yml`; new "Weekly Projections" tab (week/pos/scoring
filters, matchup badges, playoff-weeks outlook). Season projections
already auto-refresh daily. Piped weekly projections into the MCP
(`get_weekly_projections`) and the Python package
(`load_weekly_projections()`); shipped 1.0.62 to npm + 0.3.2 to PyPI +
promoted prod. Then app-team feedback round (MCP 1.0.63): injury-aware
weekly availability, as_of staleness metadata, gsis/sleeper ids on
projection rows, silent 300/200-row caps lifted to 1000 with explicit
truncation notes, sleeper-projections `fields` bug fixed, in-season
def-vs-pos blend wired in the builder. Deferred items (in-season base
re-fit, Vegas multipliers, uncertainty bands) logged in
docs/MCP_FEEDBACK_BACKLOG.md Round 22. Added K + team-DST weekly
projections (32 each: depth-chart PK1s, team context + same matchup
framework; defVsPos gains K/DST entries). 1.0.63 not yet published.

## Current blockers

- None.

## Next 3 tasks

1. Fix projection-pool depth-share artifacts: deep TEs inflated (Greg
   Dulcich, Colby Parkinson) and Brock Bowers' TE TD line cold vs market.
2. Recalibrate the SFB16 big-play estimators against published SFB
   projections — the 20+-yd-reception rate runs ~5–13% hot for elite
   high-YPR receivers (candidate: coefficient 0.022 → ~0.018).
3. Post-draft SFB16 recap: score all 12 rosters with the SFB model once
   the Sleeper draft completes (draft 1366445711050162176).
4. Weekly projections v2: in-season re-projection (blend actuals as weeks
   complete), Vegas totals/spreads as game-environment multipliers, and
   injury/depth-chart awareness.
5. Player props v2: Vegas totals/spreads as a game-environment input, K/DST
   props, and per-player (rather than league-wide) in-game blend weights.
6. In-season model v2: close the ~4pp skill-usage prop calibration gap (a
   heavier left tail for mid-game exits / benchings is the leading
   hypothesis), add snap-count and depth-chart signal, and wire the
   in-season line into the Player Props tab once 2026 weeks exist.
