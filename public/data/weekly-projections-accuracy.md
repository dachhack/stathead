# Weekly projection accuracy — 2026, weeks 1–6

_1831 player-weeks scored out of sample; generated 2026-10-27T02:20_

## All players who played

| method | n | MAE | RMSE | r | bias |
|---|---|---|---|---|---|
| StatHead (published) | 1769 | 4.76 | 6.36 | 0.6413 | -0.07 |
| season line only | 1769 | 4.79 | 6.41 | 0.6339 | -0.02 |
| external benchmark | 1769 | 4.53 | 6.13 | 0.6697 | -0.15 |

## By position (MAE / r): StatHead vs season line vs benchmark

| pos | n | StatHead | season line | benchmark |
|---|---|---|---|---|
| QB | 185 | 6.14 / 0.3051 | 6.24 / 0.2204 | 6.21 / 0.3006 |
| RB | 483 | 4.62 / 0.6747 | 4.63 / 0.674 | 4.30 / 0.707 |
| WR | 717 | 4.80 / 0.5734 | 4.80 / 0.5694 | 4.48 / 0.6206 |
| TE | 384 | 4.21 / 0.5354 | 4.29 / 0.5136 | 4.09 / 0.555 |

## Starters (projected ≥ 8)

| method | n | MAE | RMSE | r | bias |
|---|---|---|---|---|---|
| StatHead | 860 | 6.30 | 7.74 | 0.4679 | +0.74 |
| season line only | 860 | 6.34 | 7.82 | 0.4506 | +0.72 |
| external benchmark | 860 | 5.99 | 7.52 | 0.5065 | +0.26 |

## Against naive in-season baselines (weeks 2+, players with a prior game)

| method | n | MAE | RMSE | r | bias |
|---|---|---|---|---|---|
| StatHead | 1297 | 4.92 | 6.50 | 0.6181 | -0.13 |
| season line only | 1297 | 4.96 | 6.57 | 0.6078 | -0.13 |
| season-to-date average | 1297 | 5.49 | 7.50 | 0.5394 | -0.38 |
| last week | 1297 | 6.17 | 8.57 | 0.4647 | -0.06 |
| external benchmark | 1297 | 4.73 | 6.27 | 0.6473 | -0.12 |

## Matchup layer calibration

Slope of (actual − season line) on (projection − season line): 1 = the projected swing is the right size, 0 = no information. impliedScale = scale in force × slope — what POS_MATCHUP_SCALE should be.

| pos | n | slope | ± se | scale in force | implied scale |
|---|---|---|---|---|---|
| overall | 1831 | +0.91 | 0.19 | 1.00 | 0.91 |
| QB | 205 | +1.16 | 0.47 | 1.00 | 1.16 |
| RB | 494 | +0.47 | 0.36 | 1.00 | 0.47 |
| WR | 731 | +0.69 | 0.31 | 1.00 | 0.69 |
| TE | 401 | +1.87 | 0.44 | 1.00 | 1.87 |

## Week by week

| week | snapshot | n | MAE | r | benchmark MAE | starters who did not play (flagged out / questionable / unflagged) |
|---|---|---|---|---|---|---|
| 1 | 2026-09-09T22:21 | 292 | 5.309 | 0.6125 | 4.922 | 12 (144 pts): 0 / 0 / 12 |
| 2 | 2026-09-17T22:14 | 325 | 4.955 | 0.6183 | 4.34 | 12 (168 pts): 0 / 0 / 12 |
| 3 | 2026-09-24T22:30 | 317 | 4.672 | 0.6642 | 4.537 | 12 (140 pts): 1 / 0 / 11 |
| 4 | 2026-10-02T00:09 | 315 | 4.359 | 0.672 | 4.497 | 17 (211 pts): 7 / 7 / 3 |
| 5 | 2026-10-09T00:09 | 303 | 4.778 | 0.6622 | 4.46 | 17 (198 pts): 6 / 10 / 1 |
| 6 | 2026-10-16T00:08 | 279 | 4.501 | 0.6387 | 4.418 | 15 (189 pts): 4 / 8 / 3 |

Latest week's biggest no-shows: Lamar Jackson (QB, 15.8, questionable), Rashee Rice (WR, 15.4, questionable), Jalen Hurts (QB, 15.3, out), Baker Mayfield (QB, 14.0, out), Cam Skattebo (RB, 13.8, none), Quinshon Judkins (RB, 13.5, questionable)

## Confidence bands (actual ÷ projected, players who played, fitted on weeks 1–6)

Projection × p10–p90 = the 80% band, × p25–p75 the 50% band; the median ratio is below 1 because weeks are right-skewed. Thin cells are shrunk toward the pooled tier shape (shrunk = weight on it). Walk-forward check on week 6: 84% of actuals inside the 80% band, 58% inside the 50% band (n=273).

| pos | tier | n | shrunk | p10 | p25 | median | p75 | p90 |
|---|---|---|---|---|---|---|---|---|
| QB | <3 | 0 | 1.00 | 0.00 | 0.00 | 0.79 | 2.76 | 6.56 |
| QB | 3-6 | 0 | 1.00 | 0.00 | 0.34 | 0.80 | 1.59 | 2.77 |
| QB | 6-10 | 1 | 1.00 | 0.12 | 0.37 | 0.78 | 1.38 | 2.02 |
| QB | 10-15 | 49 | 0.45 | 0.17 | 0.47 | 0.81 | 1.36 | 1.66 |
| QB | 15+ | 155 | 0.20 | 0.26 | 0.61 | 0.88 | 1.27 | 1.56 |
| RB | <3 | 133 | 0.23 | 0.00 | 0.00 | 0.72 | 2.54 | 6.65 |
| RB | 3-6 | 75 | 0.35 | 0.05 | 0.37 | 0.81 | 1.59 | 2.73 |
| RB | 6-10 | 98 | 0.29 | 0.07 | 0.30 | 0.63 | 1.27 | 1.84 |
| RB | 10-15 | 98 | 0.29 | 0.23 | 0.39 | 0.71 | 1.23 | 1.75 |
| RB | 15+ | 88 | 0.31 | 0.41 | 0.60 | 0.89 | 1.21 | 1.55 |
| WR | <3 | 187 | 0.18 | 0.00 | 0.00 | 0.65 | 3.17 | 6.46 |
| WR | 3-6 | 115 | 0.26 | 0.00 | 0.31 | 0.80 | 1.56 | 2.79 |
| WR | 6-10 | 204 | 0.16 | 0.16 | 0.45 | 0.86 | 1.36 | 2.14 |
| WR | 10-15 | 153 | 0.21 | 0.20 | 0.46 | 0.75 | 1.33 | 1.85 |
| WR | 15+ | 68 | 0.37 | 0.36 | 0.57 | 0.85 | 1.42 | 1.70 |
| TE | <3 | 156 | 0.20 | 0.00 | 0.00 | 0.88 | 2.37 | 6.45 |
| TE | 3-6 | 60 | 0.40 | 0.00 | 0.35 | 0.73 | 1.58 | 2.70 |
| TE | 6-10 | 110 | 0.27 | 0.16 | 0.36 | 0.78 | 1.47 | 2.03 |
| TE | 10-15 | 63 | 0.39 | 0.18 | 0.37 | 0.74 | 1.29 | 1.86 |
| TE | 15+ | 11 | 1.00 | 0.35 | 0.59 | 0.88 | 1.30 | 1.61 |

### Stat-line simulation

Per-player bands from the projected stat line (see the bands note). Fitted dispersions: Walk-forward check on week 6: simulation 79% of actuals inside the 80% band, 45% inside the 50% band; the published blend with the tier bands 82% / 46% (n=207).

| pos | volume σ (log) by tier | yards/opportunity gamma shape | TD overdispersion |
|---|---|---|---|
| QB | passAtt 0.25/0.25/0.23, rushAtt 0.54/–/–/– | passYds 0.612, rushYds 0.5 | passTD 1.0, rushTD 1.0 |
| RB | rushAtt 0.72/0.66/0.50/0.33, tgt 0.62/0.66/–/– | rushYds 0.746, recYds 0.922 | rushTD 1.0, recTD 1.0 |
| WR | tgt 0.63/0.70/0.57/0.60 | recYds 1.273 | recTD 1.114 |
| TE | tgt 0.64/0.59/0.60/0.56 | recYds 1.546 | recTD 1.408 |

## Stat lines (1831 player-weeks; rule per week: wk 1 proportional, wk 2 proportional, wk 3 proportional, wk 4 proportional, wk 5 proportional, wk 6 proportional)

MAE / r per component — StatHead vs the flat per-game stat vs the external benchmark — and the matchup swing's calibration on that component (1 = right size, 0 = no information).

| pos | stat | n | actual/g | StatHead | flat | benchmark | swing slope |
|---|---|---|---|---|---|---|---|
| QB | passAtt | 205 | 30.11 | 9.18 / 0.1046 | 8.78 / 0.1786 | 6.88 / 0.2514 | -0.179 |
| QB | passComp | 205 | 19.25 | 6.18 / 0.1798 | 5.93 / 0.2003 | 4.80 / 0.2723 | 0.147 |
| QB | passYds | 205 | 210.76 | 71.30 / 0.2154 | 71.02 / 0.2106 | 60.03 / 0.2426 | 0.468 |
| QB | passTD | 205 | 1.37 | 0.93 / 0.2008 | 0.94 / 0.1561 | 0.87 / 0.2701 | 1.513 |
| QB | int | 205 | 0.62 | 0.68 / -0.0619 | 0.67 / -0.027 | 0.66 / 0.0471 | -1.759 |
| QB | rushAtt | 205 | 3.44 | 2.60 / 0.0008 | 2.62 / 0.0023 | 1.94 / 0.4278 | -0.141 |
| QB | rushYds | 205 | 15.31 | 14.36 / 0.1736 | 14.54 / 0.1666 | 12.74 / 0.4901 | 0.618 |
| QB | rushTD | 205 | 0.17 | 0.26 / 0.3318 | 0.26 / 0.3327 | 0.29 / 0.3073 | 0.237 |
| RB | rushAtt | 494 | 8.19 | 3.32 / 0.7798 | 3.26 / 0.7878 | 3.12 / 0.8127 | -0.246 |
| RB | rushYds | 494 | 33.55 | 18.57 / 0.6999 | 18.58 / 0.7026 | 17.89 / 0.7207 | 0.138 |
| RB | rushTD | 494 | 0.27 | 0.36 / 0.3959 | 0.37 / 0.3859 | 0.35 / 0.4193 | 2.548 |
| RB | tgt | 494 | 2.07 | 1.30 / 0.5651 | 1.30 / 0.573 | 1.23 / 0.6179 | -0.318 |
| RB | rec | 494 | 1.61 | 1.11 / 0.516 | 1.11 / 0.5208 | 1.06 / 0.5677 | -0.012 |
| RB | recYds | 494 | 11.34 | 10.18 / 0.4414 | 10.21 / 0.4436 | 9.78 / 0.4677 | 0.046 |
| RB | recTD | 494 | 0.06 | 0.12 / 0.1117 | 0.12 / 0.1048 | 0.13 / 0.0858 | 2.701 |
| WR | tgt | 731 | 4.53 | 2.29 / 0.5928 | 2.27 / 0.6005 | 1.99 / 0.6867 | 0.041 |
| WR | rec | 731 | 2.82 | 1.56 / 0.5988 | 1.55 / 0.6009 | 1.42 / 0.6632 | 0.317 |
| WR | recYds | 731 | 36.53 | 23.13 / 0.566 | 23.21 / 0.5605 | 21.40 / 0.6055 | 0.757 |
| WR | recTD | 731 | 0.2 | 0.30 / 0.2515 | 0.30 / 0.2464 | 0.32 / 0.2717 | 1.941 |
| TE | tgt | 401 | 3.34 | 1.61 / 0.6786 | 1.63 / 0.6751 | 1.58 / 0.7067 | 0.582 |
| TE | rec | 401 | 2.39 | 1.37 / 0.622 | 1.37 / 0.6114 | 1.33 / 0.6386 | 1.028 |
| TE | recYds | 401 | 23.34 | 16.57 / 0.5617 | 16.79 / 0.5434 | 16.13 / 0.5663 | 1.565 |
| TE | recTD | 401 | 0.22 | 0.30 / 0.1879 | 0.30 / 0.1658 | 0.31 / 0.221 | 4.792 |
