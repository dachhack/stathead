# Strength of matchup: validation

`scripts/backtest_matchups.py` replays the matchup ledger
(`scripts/build-matchups.py`) on 2016-2025 and asks two questions of every
position, metric and number of weeks played N (3, 4, 6, 9, 12):

1. **Rank stability.** Spearman correlation across the 32 defenses between
   what a defense allowed per game over weeks 1..N and over weeks N+1..end
   (`r raw`), the same with over-expected as the predictor (`r OE`), the
   same scored on only the next four weeks (`r next 4`), and for points the
   prior season alone (`r prior`) and the weekly projections' blend of prior
   and current, w = N/(N+6) (`r blend`). Means over seasons.
2. **Player carry.** For every player-game in weeks N+1..end (players with
   8+ games), rel = his value in the game over his mean in his other games
   that season, regressed on (opponent ratio − 1), the ratio being the
   opponent's weeks-1..N allowed over the league average. The slope is the
   share of a defense's early deviation that reached the players facing it:
   1.0 = take the ledger at face value, 0 = noise. `soft 8` / `tough 8` are
   mean rel against a top-8 / bottom-8 defense by raw rank. Rates (ypc, ypr)
   and TD counts have no player test: a player's per-game rate or TD count
   is too noisy to be the target.

Output: `public/data/matchups-backtest.json`, which the builder reads to stamp
a `reliability` block into `matchups-<season>.json`; MCP `get_matchups` quotes
it on every response.

## What was built

Per defense and position (QB/RB/WR/TE), season to date:

- **Points allowed** per game (PPR, with receptions so half, standard and
  TE-premium are exact), rank 1 = most allowed.
- **Over expected (OE):** allowed minus what the offenses faced produce in
  their *other* games this season (leave-one-out; league average when there
  is none). Rates apply the offense's other-games rate to the volume it had.
  The schedule-adjusted ledger; it averages to zero across the league.
- **Component metrics** where the position has the volume: QB `passPts`
  `passAtt` `passYds` `passTD` `int` `rushPts` `carries` `rushYds` `rushTD`;
  RB `rushPts` `carries` `rushYds` `rushTD` `ypc` `recPts` `targets` `rec`
  `recYds` `recTD`; WR and TE `recPts` `targets` `rec` `recYds` `recTD` `ypr`.
  Each per game with rank, OE and OE rank.
- **Rest of schedule** per team and position: mean of the remaining
  opponents' points, OE and model factor, ranked 1 = softest, plus weeks
  15-17.
- **Model factor:** the def-vs-pos multiplier the weekly projections apply
  (prior season blended with this one, 40% of the deviation kept, clamped),
  carried alongside so the two can be read together.

## Results after 4 weeks

| Pos | Metric | r raw | r OE | r next 4 | r prior | r blend | slope raw | slope OE | slope next 4 | soft 8 | tough 8 | player-games |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| QB | passPts | 0.14 | 0.15 | 0.06 |  |  | 0.16 | 0.14 | 0.13 | 1.06 | 0.96 | 3629 |
| QB | passAtt | 0.10 | 0.15 | 0.08 |  |  | 0.11 | 0.15 | 0.18 | 1.02 | 0.99 | 3628 |
| QB | passYds | 0.14 | 0.12 | 0.11 |  |  | 0.18 | 0.15 | 0.24 | 1.04 | 0.97 | 3623 |
| QB | passTD | 0.08 | 0.09 | 0.05 |  |  |  |  |  |  |  |  |
| QB | int | 0.12 | 0.16 | 0.16 |  |  | 0.10 | 0.10 | 0.16 | 1.08 | 0.91 | 2755 |
| QB | rushPts | 0.03 | 0.05 | -0.06 |  |  | -0.03 | -0.03 | -0.06 | 1.03 | 1.00 | 3105 |
| QB | carries | -0.02 | 0.03 | -0.09 |  |  | -0.00 | -0.03 | -0.07 | 1.01 | 1.01 | 3657 |
| QB | rushYds | -0.03 | 0.12 | -0.06 |  |  | 0.03 | 0.05 | -0.07 | 1.05 | 1.04 | 3222 |
| QB | rushTD | 0.01 | 0.00 | -0.02 |  |  |  |  |  |  |  |  |
| QB | ppr | 0.13 | 0.15 | 0.07 | 0.20 | 0.25 | 0.16 | 0.13 | 0.16 | 1.06 | 0.97 | 3623 |
| RB | rushPts | 0.26 | 0.24 | 0.23 |  |  | 0.19 | 0.14 | 0.23 | 1.14 | 0.98 | 7176 |
| RB | carries | 0.28 | 0.28 | 0.22 |  |  | 0.18 | 0.17 | 0.29 | 1.06 | 0.99 | 7531 |
| RB | rushYds | 0.31 | 0.29 | 0.23 |  |  | 0.23 | 0.19 | 0.27 | 1.14 | 0.96 | 7391 |
| RB | rushTD | 0.12 | 0.14 | 0.14 |  |  |  |  |  |  |  |  |
| RB | ypc | 0.15 | 0.14 | 0.11 |  |  |  |  |  |  |  |  |
| RB | recPts | 0.15 | 0.13 | 0.06 |  |  | 0.11 | 0.09 | 0.13 | 1.07 | 0.97 | 7450 |
| RB | targets | 0.17 | 0.20 | 0.12 |  |  | 0.10 | 0.12 | 0.15 | 1.03 | 0.97 | 7673 |
| RB | rec | 0.20 | 0.24 | 0.16 |  |  | 0.13 | 0.13 | 0.19 | 1.04 | 0.96 | 7628 |
| RB | recYds | 0.15 | 0.17 | 0.07 |  |  | 0.10 | 0.10 | 0.13 | 1.06 | 0.97 | 7339 |
| RB | recTD | -0.00 | -0.01 | -0.01 |  |  |  |  |  |  |  |  |
| RB | ppr | 0.22 | 0.16 | 0.16 | 0.24 | 0.29 | 0.11 | 0.09 | 0.16 | 1.06 | 1.01 | 8142 |
| WR | recPts | 0.09 | 0.06 | 0.09 |  |  | 0.10 | 0.08 | 0.11 | 1.01 | 0.96 | 10296 |
| WR | targets | 0.18 | 0.19 | 0.12 |  |  | 0.14 | 0.15 | 0.11 | 1.03 | 0.99 | 10770 |
| WR | rec | 0.16 | 0.14 | 0.14 |  |  | 0.12 | 0.12 | 0.11 | 1.02 | 0.97 | 10496 |
| WR | recYds | 0.12 | 0.06 | 0.06 |  |  | 0.10 | 0.08 | 0.07 | 1.01 | 0.98 | 10207 |
| WR | recTD | 0.01 | 0.00 | 0.01 |  |  |  |  |  |  |  |  |
| WR | ypr | 0.12 | 0.11 | 0.08 |  |  |  |  |  |  |  |  |
| WR | ppr | 0.09 | 0.05 | 0.07 | 0.13 | 0.16 | 0.07 | 0.07 | 0.01 | 1.01 | 0.98 | 12949 |
| TE | recPts | 0.18 | 0.19 | 0.10 |  |  | 0.15 | 0.11 | 0.17 | 1.11 | 0.97 | 6796 |
| TE | targets | 0.12 | 0.16 | 0.08 |  |  | 0.09 | 0.07 | 0.07 | 1.06 | 0.98 | 6992 |
| TE | rec | 0.17 | 0.20 | 0.16 |  |  | 0.13 | 0.09 | 0.17 | 1.08 | 0.97 | 6931 |
| TE | recYds | 0.14 | 0.15 | 0.07 |  |  | 0.13 | 0.08 | 0.10 | 1.08 | 0.95 | 6677 |
| TE | recTD | 0.05 | 0.07 | 0.01 |  |  |  |  |  |  |  |  |
| TE | ypr | 0.10 | 0.08 | 0.08 |  |  |  |  |  |  |  |  |
| TE | ppr | 0.20 | 0.21 | 0.11 | 0.17 | 0.26 | 0.14 | 0.12 | 0.16 | 1.09 | 0.94 | 5863 |

## Results after 9 weeks

| Pos | Metric | r raw | r OE | r next 4 | r prior | r blend | slope raw | slope OE | slope next 4 | soft 8 | tough 8 | player-games |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| QB | passPts | 0.14 | 0.18 | 0.12 |  |  | 0.23 | 0.27 | 0.15 | 1.06 | 0.93 | 2290 |
| QB | passAtt | 0.12 | 0.16 | 0.06 |  |  | 0.13 | 0.16 | -0.02 | 1.02 | 0.98 | 2292 |
| QB | passYds | 0.14 | 0.17 | 0.11 |  |  | 0.19 | 0.23 | 0.10 | 1.04 | 0.97 | 2288 |
| QB | passTD | 0.08 | 0.14 | 0.05 |  |  |  |  |  |  |  |  |
| QB | int | 0.12 | 0.16 | 0.02 |  |  | 0.21 | 0.22 | 0.14 | 1.06 | 0.88 | 1742 |
| QB | rushPts | 0.04 | 0.11 | 0.02 |  |  | 0.05 | 0.09 | 0.13 | 1.02 | 1.00 | 1973 |
| QB | carries | 0.07 | 0.14 | -0.03 |  |  | 0.12 | 0.26 | 0.09 | 1.07 | 0.99 | 2310 |
| QB | rushYds | 0.00 | 0.05 | -0.05 |  |  | 0.08 | 0.16 | 0.08 | 1.08 | 0.96 | 2027 |
| QB | rushTD | 0.07 | 0.09 | 0.06 |  |  |  |  |  |  |  |  |
| QB | ppr | 0.15 | 0.18 | 0.09 | 0.18 | 0.21 | 0.23 | 0.26 | 0.20 | 1.05 | 0.95 | 2288 |
| RB | rushPts | 0.27 | 0.25 | 0.16 |  |  | 0.40 | 0.36 | 0.25 | 1.16 | 0.93 | 4544 |
| RB | carries | 0.26 | 0.26 | 0.17 |  |  | 0.34 | 0.32 | 0.19 | 1.07 | 0.99 | 4796 |
| RB | rushYds | 0.33 | 0.32 | 0.21 |  |  | 0.39 | 0.35 | 0.31 | 1.13 | 0.95 | 4688 |
| RB | rushTD | 0.11 | 0.11 | 0.03 |  |  |  |  |  |  |  |  |
| RB | ypc | 0.25 | 0.24 | 0.16 |  |  |  |  |  |  |  |  |
| RB | recPts | 0.21 | 0.23 | 0.14 |  |  | 0.27 | 0.23 | 0.27 | 1.08 | 0.91 | 4740 |
| RB | targets | 0.22 | 0.25 | 0.12 |  |  | 0.26 | 0.25 | 0.21 | 1.07 | 0.94 | 4904 |
| RB | rec | 0.26 | 0.29 | 0.13 |  |  | 0.27 | 0.23 | 0.27 | 1.08 | 0.92 | 4876 |
| RB | recYds | 0.22 | 0.22 | 0.13 |  |  | 0.30 | 0.26 | 0.22 | 1.05 | 0.92 | 4704 |
| RB | recTD | -0.02 | -0.01 | 0.01 |  |  |  |  |  |  |  |  |
| RB | ppr | 0.23 | 0.24 | 0.10 | 0.23 | 0.27 | 0.26 | 0.23 | 0.21 | 1.07 | 0.97 | 5185 |
| WR | recPts | 0.08 | 0.10 | 0.04 |  |  | 0.16 | 0.19 | 0.11 | 1.01 | 0.96 | 6641 |
| WR | targets | 0.15 | 0.16 | 0.11 |  |  | 0.15 | 0.17 | 0.04 | 1.03 | 0.99 | 6919 |
| WR | rec | 0.15 | 0.16 | 0.15 |  |  | 0.15 | 0.14 | 0.10 | 1.01 | 0.96 | 6769 |
| WR | recYds | 0.11 | 0.11 | 0.07 |  |  | 0.18 | 0.20 | 0.10 | 1.00 | 0.94 | 6581 |
| WR | recTD | -0.05 | 0.01 | -0.04 |  |  |  |  |  |  |  |  |
| WR | ypr | 0.15 | 0.17 | 0.13 |  |  |  |  |  |  |  |  |
| WR | ppr | 0.09 | 0.11 | 0.04 | 0.08 | 0.10 | 0.15 | 0.18 | 0.05 | 1.03 | 0.96 | 8299 |
| TE | recPts | 0.14 | 0.14 | 0.13 |  |  | 0.20 | 0.19 | 0.29 | 1.10 | 0.99 | 4286 |
| TE | targets | 0.14 | 0.16 | 0.08 |  |  | 0.16 | 0.15 | 0.20 | 1.12 | 1.01 | 4422 |
| TE | rec | 0.15 | 0.16 | 0.11 |  |  | 0.17 | 0.14 | 0.16 | 1.11 | 0.99 | 4367 |
| TE | recYds | 0.19 | 0.19 | 0.21 |  |  | 0.23 | 0.19 | 0.30 | 1.08 | 0.97 | 4206 |
| TE | recTD | -0.02 | 0.00 | -0.01 |  |  |  |  |  |  |  |  |
| TE | ypr | 0.10 | 0.09 | 0.08 |  |  |  |  |  |  |  |  |
| TE | ppr | 0.16 | 0.15 | 0.14 | 0.18 | 0.21 | 0.18 | 0.16 | 0.21 | 1.09 | 0.96 | 3733 |

## Reading

- **Early-season ranks are mostly noise.** After 4 weeks the raw ledger's
  rank stability is r = 0.1-0.3, and only 10-25% of a defense's deviation
  shows up in the players who face it. A top-8 matchup was worth about +5
  to +15% of a player's own average (RB rushing and TE the most), a bottom-8
  about -3 to -6%. The asymmetry is real: soft defenses give more than tough
  ones take away.
- **The model blend beats the raw ledger for points at every N.** Prior
  season + current with w = N/(N+6) ranks the rest of the season better than
  weeks 1..N alone (TE 0.26 vs 0.20 at N=4; RB 0.29 vs 0.22; QB 0.25 vs
  0.13). The 0.40 shrink in the weekly projections sits at the slope the
  data shows around weeks 6-9, so the factor is the right number to move a
  projection by. The raw rank answers "who concedes the most", not "how much
  to move him".
- **Over expected is a modest improvement, not a fix.** It matches or edges
  the raw ledger for rank stability at most positions (QB and RB receiving
  especially, TE receptions) and loses a little on the player slope at N=4,
  because a four-game leave-one-out expectation is itself noisy. By week 9
  it is level or ahead. Its real use is diagnostic: a top-3 raw rank with OE
  near zero is schedule.
- **By metric.** RB rushing (carries, yards, rushing points) is the most
  reliable split at every N (r ≈ 0.3, slope 0.2 → 0.4 by week 9), then RB
  and TE receptions and WR/TE targets (r ≈ 0.15-0.2, slope ≈ 0.1-0.17).
  QB passing yards and attempts carry a little (slope ≈ 0.1-0.2). **QB
  rushing is noise** (r ≈ 0, slope ≈ 0) — how much a defense concedes to
  quarterback runs depends on which quarterbacks it met. **TD metrics are noise** (r ≈ 0-0.1; RB rushing TDs are the one
  exception at r ≈ 0.12, barely better). Yards per carry and yards per reception are weak
  at the defense level (r ≈ 0.1-0.25) and were not tested on players.
- **Stability improves slowly.** By week 9 slopes roughly double (RB rushing
  0.4, QB and TE points 0.2, WR 0.15) and rank stability edges up, but the
  "next 4 weeks" correlations stay low (0.05-0.2): a defense's split moves
  within a season (injuries, scheme, game script), so even a well-measured
  rank is a soft forecast of the next month.

## Decisions

- Every `get_matchups` response quotes the grade for what it shows
  (`moderate` slope ≥ 0.30, `weak` 0.10-0.30, `noise` below; rank stability
  where there is no player test) at the backtest cut nearest to the weeks
  played, so a consumer reading a TE rank in October is told it is weak and
  that the factor is the better number.
- Nothing in the raw ledger is applied to projections. The weekly
  projections keep their blended, shrunk factor; the raw ranks and metric
  splits are published for the question they answer.
- The backtest is not in the data-refresh workflow (it takes a minute and
  changes once a year). Rerun it after a season closes:
  `python3 scripts/backtest_matchups.py 2016 <last season>`, then rebuild
  the matchups file.
