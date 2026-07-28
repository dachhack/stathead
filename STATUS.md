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

2026-07-28 — Visitor tracking: first-party, cookie-less pageview analytics
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
(`get_weekly_projections`, server 1.0.62 — needs a publish-mcp
dispatch) and the Python package (`load_weekly_projections()`, 0.3.2 —
needs a python-publish dispatch).

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
