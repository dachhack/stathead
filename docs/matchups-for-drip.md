# Strength of matchup: integration notes for Drip Fantasy

Shipped in `stathead-mcp` **1.0.113** (MCP tool `get_matchups`) and as a
published data file. Everything is StatHead-computed from nflverse weekly
stats and the schedule; no third-party rankings are involved, so it can be
shown as is.

## The data file

`public/data/matchups-2026.json`, rebuilt every two hours in season by
`refresh-data.yml`, served at

```
https://raw.githubusercontent.com/dachhack/stathead/refs/heads/claude/nfl-fantasy-workbench-6D1yd/public/data/matchups-2026.json
```

and alongside the site's other data files. About 180 KB. Top-level keys:

| Key | What it holds |
|---|---|
| `season`, `generatedAt`, `playedThrough`, `currentWeek` | `playedThrough` = last week with every game final; `currentWeek` = the week to show. |
| `league[pos]` | League-average `ppr` and `rec` allowed per game, prior-season values, and per-metric averages under `metrics`. |
| `defenses[D][pos]` | Season to date for defense `D` against the position: `g` games, `ppr`, `rec` allowed per game, `rank.{ppr,half,std}` (1 = most allowed), `oe` / `oeRec` / `oeRank` (over expected, see below), `metrics[m] = {pg, oe, rank, oeRank}`, `prior` (last season), `factor` / `factorRank` (the StatHead model multiplier), `byWeek` game log. |
| `ros[T][pos]` | Rest of schedule for team `T`: mean of the remaining opponents' `ppr`, `rec`, `oe`, `factor`, with `rank.{ppr,half,std}`, `oeRank`, `factorRank` (1 = softest) and `playoffPpr` / `playoffRec` for weeks 15-17. |
| `schedule[T]` | Every game for `T`: `w`, `opp`, `home`, `played`, and the opponent's `factor` per position. Byes are the missing weeks; `bye[T]` names it. |
| `reliability` | Backtest grades per position and metric at the current number of weeks played (below). |
| `metricLabels`, `metricsByPosition` | Metric keys and their meaning. |

**Scoring.** Receptions ride along so any format is exact:
`half = ppr - 0.5*rec`, `std = ppr - rec`, TE-premium = `ppr + bonus*rec`
for TEs. The same conversion applies to over-expected (`oe + coef*oeRec`).

**Ranks.** 1 = most allowed = softest matchup for the offense, among
defenses that have played. The one metric where that is the worst matchup
is `int` (interceptions thrown).

**Over expected (`oe`).** Allowed per game minus what the offenses faced
produce in their other games this season (leave-one-out; league average
when there is none). It averages to zero across the league and tells you
whether a rank is the defense or its schedule.

**Metrics.** QB `passPts passAtt passYds passTD int rushPts carries rushYds
rushTD`; RB `rushPts carries rushYds rushTD ypc recPts targets rec recYds
recTD`; WR and TE `recPts targets rec recYds recTD ypr`. Rates (`ypc`,
`ypr`) are totals over totals. Composites use 0.04/yd, 4/TD, -2/INT
passing; 0.1/yd, 6/TD, -2/fumble lost rushing; 1/rec, 0.1/yd, 6/TD,
-2/fumble lost receiving.

## The MCP tool

`get_matchups` with `view` = `week` (default: each offense's position
against the defense it faces this week), `defenses` (the defense-vs-
position table), `ros` (rest of schedule per team), `metrics` (a
position's component metrics), or `schedule` (a team's or a player's
week-by-week strip: `player_name: "Brock Bowers"`). `metric` reads a
metric instead of points in any view; `scoring` is `ppr | half | std |
tep0.5 | tep1.0`. `output_format: jsonl` or `csv` for machine use. Every
response ends with the reliability line for what it shows.

## How much to trust it

`docs/matchups-validation.md` has the 2016-2025 backtest. The short
version, after four weeks:

- Only 10-25% of a defense's raw deviation shows up in the players facing
  it. A top-8 matchup was worth about +5-15% of a player's own average
  (RB rushing and TE the most), a bottom-8 about -3-6%.
- The StatHead `factor` (prior season blended with this one, 40% of the
  deviation kept) ranks the rest of the season better than the raw ledger
  at every position until midseason. Use the rank to say who concedes the
  most; use the factor to move a projection.
- RB rushing is the most reliable split. QB rushing and every TD metric
  are noise. Over expected is a diagnostic, not a better forecast, until
  around week 9.
- `reliability.byPosition[pos][metric].grade` is `moderate`, `weak` or
  `noise` for the current week count, with `r`, `slope`, `soft8` and
  `tough8` behind it. A UI that shows a rank should show the grade.

Nothing from this file is applied to StatHead's projections; the weekly
projections keep their own factor. No existing tool or field changed.

## Team depth charts (added with MCP 1.0.114)

Also publishable, and now shipped in a consumer shape: each team's newest
published depth chart (nflverse, CC-BY-4.0; the teams' charts as carried by
ESPN) for offense, defense and special teams, every slot and rank.

File: `public/data/depth-charts-2026.json`, rebuilt every 20 minutes in
season by the injury refresh and every two hours by the data refresh, at

```
https://raw.githubusercontent.com/dachhack/stathead/refs/heads/claude/nfl-fantasy-workbench-6D1yd/public/data/depth-charts-2026.json
```

| Key | What it holds |
|---|---|
| `snapshot`, `teams[T]` | The newest snapshot time overall and per team, each team's previous and 7-day-old reference snapshots, and its formations (offense `3WR 1TE`, defense `Base 4-3 D` or `Base 3-4 D`). |
| `rows[]` | One row per team, slot and player: `team`, `group` (offense / defense / specialTeams), `slot`, `pos`, `label`, `rank`, `slotRank`, `starter`, `name`, `gsis_id`, `espn_id`, `status`, `depthScore`, `depthRank`. |
| `changes[]`, `changes7d[]` | Slot-level moves since each team's previous snapshot, and since its newest snapshot at least 7 days old: `from`, `to`, `kind` (up / down / added / removed), `newStarter`, `since`. |
| `slotNames` | `group|pos|slot` to the chart's slot name (Left Tackle, Nickel Back...). |

**The one thing to know about this feed.** A chart lists three receiver
slots that all carry `pos` WR, and the chart's `rank` runs across the
position: the slots carry ranks 1/4/7, 2/5/8 and 3/6. So a team's receiver
order is the rank order, the WR2 slot's starter has rank 2, and anything
keyed on team + position + rank collapses the three slots into one. Key on
`slot` (or `label`, which numbers duplicate abbreviations WR1 / WR2 / WR3 by
slot order) and use `slotRank` / `starter` for "who starts in this slot".

`status` is the nflverse roster status (ACT, RES = injured reserve, EXE,
DEV = practice squad). `depthScore` / `depthRank` are StatHead's own
within-position depth-order model for QB/RB/WR/TE, carried so a chart that
disagrees with usage is visible.

MCP: `get_depth_charts` (season optional; `team`, `position` or a slot label
such as `WR2`, `group`, `player_name`, `starters_only`) and
`get_depth_charts view=changes since=previous|7d` for the moves. Python:
`load_depth_charts()` and `load_depth_chart_changes("previous" | "7d")`.
Earlier seasons read the raw nflverse file (chart view only).

Behaviour change in 1.0.114: `get_depth_charts` used to dedupe on
abbreviation + rank and so returned one receiver line per team; it now
returns all three slots. `season` is optional (defaults to the current one).
