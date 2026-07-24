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
research tab on `claude/scott-fish-bowl-scoring-is6b9x`, unmerged into the
default branch (`claude/nfl-fantasy-workbench-6D1yd`).

## Cadence

Near-daily July–December (draft season through playoffs); maintenance-only
in the offseason. Automated daily data snapshots commit regardless.

## Last worked

2026-07-11 — Added the SFB16 Cheatsheet research tab (local-only paid data
+ in-app import); the day before, SFB16 scoring landed across rankings,
My Rankings, and projections.

## Current blockers

- None.

## Next 3 tasks

1. Merge `claude/scott-fish-bowl-scoring-is6b9x` (SFB16 scoring + cheatsheet
   tab) into the default branch.
2. Fix projection-pool depth-share artifacts: deep TEs inflated (Greg
   Dulcich, Colby Parkinson) and Brock Bowers' TE TD line cold vs market.
3. Recalibrate the SFB16 big-play estimators against published SFB
   projections — the 20+-yd-reception rate runs ~5–13% hot for elite
   high-YPR receivers (candidate: coefficient 0.022 → ~0.018).
