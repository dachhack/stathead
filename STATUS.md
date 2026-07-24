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

2026-07-24 — Merged the SFB16 branch (scoring + cheatsheet tab, built
2026-07-10/11) into the default branch; ran live SFB16 draft support
(Sleeper-synced draft board artifact, pick recommendations).

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
