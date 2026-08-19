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

2026-08-19 — Season-prep data audit. Refreshed the Sleeper ADP snapshot
(the FFC / KTC / FantasyCalc / Sleeper fetch workflows are all green and
had already run this morning), then closed the season-rollover gaps the
daily automation would have hit at kickoff: NGS split per season from
nflverse's all-seasons file (it was dumping a decade of rows into
`ngs_2025_*`, and Week 1 would have overwritten 2025 with 2026); 2025
added to advanced stats / FTN / play-by-play / participation, which all
stopped at 2024; `refresh-data.yml` now commits the in-season
injuries / snaps / player-stats snapshots the MCP, Python package and
local dev read; and ESPN restored as a live ADP source — its snapshot
used a view that omits ADP entirely, so all 937 skill players were being
dropped from the consensus blend. Details in HANDOFF.md.

Then, from a downstream MCP report of "projections not refreshed since
2026-04-12": `get_projections` was serving `redraft-projections.json`, a
static April spine that is an *input* to the daily pool builder, not its
output — so it disagreed with `get_weekly_projections` and the site by
several PPG (Gibbs 21.1 vs 25.9). All four projection surfaces
(`get_projections`, `export_excel`, `import_excel`'s diff, the waiver
board) now read one accessor over the daily-rebuilt season pool. MCP
1.0.64 published to npm; **1.0.65 (get_metadata projection-freshness
caveats; `games`/`projPts`/`min_games` on get_projections and `gp` on the
weekly ranking table, after a downstream report that one-game backups
outrank starters on ppg) is not yet published**. Also bumped the refresh
workflow's `static-data-v4` cache key: with a constant key actions/cache
never re-saves, so newly-added downloads would have been re-fetched every
run forever.

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
framework; defVsPos gains K/DST entries). 1.0.63 was published to npm; 1.0.64 (this session) is not.

## Current blockers

- None.

## Next 3 tasks

0. Publish MCP **1.0.68** (1.0.66 is live; 1.0.67 adds the projected stat line, 1.0.68 adds kickers with field-goal components) — until then every
   npx/connector client still lacks the projected-games fields. And dispatch
   **Refresh Clay** (new `refresh-clay.yml`) to unfreeze the `consensus`
   preset, stuck at 2026-06-16; leave `CLAY_PROJECTIONS_B64` unset so that
   workflow stays its only writer.
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
