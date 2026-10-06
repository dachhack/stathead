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
