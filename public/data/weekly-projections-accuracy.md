# Weekly projection accuracy — 2026, weeks 1–7

_2107 player-weeks scored out of sample; generated 2026-10-30T13:02_

## All players who played

| method | n | MAE | RMSE | r | bias |
|---|---|---|---|---|---|
| StatHead (published) | 2034 | 4.72 | 6.32 | 0.6437 | -0.12 |
| season line only | 2034 | 4.74 | 6.35 | 0.6391 | -0.07 |
| external benchmark | 2034 | 4.50 | 6.09 | 0.6723 | -0.15 |

## By position (MAE / r): StatHead vs season line vs benchmark

| pos | n | StatHead | season line | benchmark |
|---|---|---|---|---|
| QB | 213 | 5.99 / 0.3221 | 6.11 / 0.2277 | 6.08 / 0.3171 |
| RB | 550 | 4.65 / 0.6628 | 4.61 / 0.6706 | 4.32 / 0.7045 |
| WR | 826 | 4.73 / 0.5872 | 4.73 / 0.5849 | 4.46 / 0.6285 |
| TE | 445 | 4.18 / 0.5334 | 4.25 / 0.5119 | 4.07 / 0.5487 |

## Starters (projected ≥ 8)

| method | n | MAE | RMSE | r | bias |
|---|---|---|---|---|---|
| StatHead | 983 | 6.24 | 7.67 | 0.462 | +0.63 |
| season line only | 983 | 6.27 | 7.74 | 0.4449 | +0.61 |
| external benchmark | 983 | 5.97 | 7.46 | 0.5011 | +0.23 |

## Against naive in-season baselines (weeks 2+, players with a prior game)

| method | n | MAE | RMSE | r | bias |
|---|---|---|---|---|---|
| StatHead | 1504 | 4.84 | 6.42 | 0.6238 | -0.17 |
| season line only | 1504 | 4.89 | 6.48 | 0.6136 | -0.16 |
| season-to-date average | 1504 | 5.37 | 7.35 | 0.5473 | -0.34 |
| last week | 1504 | 6.08 | 8.45 | 0.4684 | -0.07 |
| external benchmark | 1504 | 4.68 | 6.20 | 0.6508 | -0.11 |

## Matchup layer calibration

Slope of (actual − season line) on (projection − season line): 1 = the projected swing is the right size, 0 = no information. impliedScale = scale in force × slope — what POS_MATCHUP_SCALE should be.

| pos | n | slope | ± se | scale in force | implied scale |
|---|---|---|---|---|---|
| overall | 2107 | +0.69 | 0.16 | 1.00 | 0.69 |
| QB | 236 | +1.30 | 0.42 | 1.00 | 1.30 |
| RB | 563 | +0.06 | 0.24 | 1.00 | 0.06 |
| WR | 843 | +0.60 | 0.29 | 1.00 | 0.60 |
| TE | 465 | +1.85 | 0.41 | 1.00 | 1.85 |

## Pick lines

7 graded picks (30 pending): hit rate 57% (model expected 60%), return -0.05 units, ROI -0.7% per pick.

| cut | n | hits | hit rate | expected | return | ROI |
|---|---|---|---|---|---|---|
| all | 7 | 4 | 57% | 60% | -0.05 | -0.7% |
| auto picks | 4 | 3 | 75% | 61% | +1.34 | +33.5% |
| call picks | 3 | 1 | 33% | 59% | -1.39 | -46.3% |
| stat passTD | 1 | 0 | 0% | 55% | -1.00 | -100.0% |
| stat passYds | 1 | 1 | 100% | 62% | +0.79 | +79.0% |
| stat rec | 1 | 1 | 100% | 64% | +0.61 | +61.0% |
| stat recYds | 2 | 2 | 100% | 60% | +1.55 | +77.5% |
| stat rushAtt | 1 | 0 | 0% | 59% | -1.00 | -100.0% |
| stat rushRecYds | 1 | 0 | 0% | 64% | -1.00 | -100.0% |
| confidence 62%+ | 3 | 2 | 67% | 64% | +0.40 | +13.3% |
| confidence 58-62% | 3 | 2 | 67% | 59% | +0.55 | +18.3% |
| confidence 54-58% | 4 | 2 | 50% | 58% | -0.45 | -11.2% |
| confidence 50-54% | 4 | 2 | 50% | 58% | -0.45 | -11.2% |
| unflagged | 7 | 4 | 57% | 60% | -0.05 | -0.7% |

| week | player | stat | line | lean | P(lean) | actual | hit | ret |
|---|---|---|---|---|---|---|---|---|
| 7 | Dallas Goedert ★ | rec | 5.5 | under | 64% | 5.0 | True | +0.61 |
| 7 | Javonte Williams ★ | rushAtt | 16.5 | under | 59% | 25.0 | False | -1.00 |
| 7 | Dallas Goedert | recYds | 49.5 | under | 59% | 48.0 | True | +0.77 |
| 7 | Dak Prescott ★ | passTD | 1.5 | under | 55% | 3.0 | False | -1.00 |
| 7 | Javonte Williams | rushRecYds | 81.5 | under | 64% | 155.0 | False | -1.00 |
| 7 | Dak Prescott | passYds | 266.5 | under | 62% | 212.0 | True | +0.79 |
| 7 | Javonte Williams | recYds | 12.5 | under | 60% | 0.0 | True | +0.78 |

## Week by week

| week | snapshot | n | MAE | r | benchmark MAE | starters who did not play (flagged out / questionable / unflagged) |
|---|---|---|---|---|---|---|
| 1 | 2026-09-09T22:21 | 292 | 5.309 | 0.6125 | 4.922 | 12 (144 pts): 0 / 0 / 12 |
| 2 | 2026-09-17T22:14 | 325 | 4.955 | 0.6183 | 4.34 | 12 (168 pts): 0 / 0 / 12 |
| 3 | 2026-09-24T22:30 | 317 | 4.672 | 0.6642 | 4.537 | 12 (140 pts): 1 / 0 / 11 |
| 4 | 2026-10-02T00:09 | 315 | 4.359 | 0.672 | 4.497 | 17 (211 pts): 7 / 7 / 3 |
| 5 | 2026-10-09T00:09 | 303 | 4.778 | 0.6622 | 4.46 | 17 (198 pts): 6 / 10 / 1 |
| 6 | 2026-10-16T00:08 | 279 | 4.501 | 0.6387 | 4.418 | 15 (189 pts): 4 / 8 / 3 |
| 7 | 2026-10-23T00:08 | 276 | 4.454 | 0.6624 | 4.358 | 13 (158 pts): 3 / 10 / 0 |

Latest week's biggest no-shows: Lamar Jackson (QB, 17.5, questionable), DeVonta Smith (WR, 15.2, questionable), Mike Evans (WR, 14.3, questionable), Breece Hall (RB, 14.2, questionable), Rashee Rice (WR, 12.8, questionable), Kyle Monangai (RB, 12.2, out)

## Confidence bands (actual ÷ projected, players who played, fitted on weeks 1–7)

Projection × p10–p90 = the 80% band, × p25–p75 the 50% band; the median ratio is below 1 because weeks are right-skewed. Thin cells are shrunk toward the pooled tier shape (shrunk = weight on it). Walk-forward check on week 7: 86% of actuals inside the 80% band, 56% inside the 50% band (n=272).

| pos | tier | n | shrunk | p10 | p25 | median | p75 | p90 |
|---|---|---|---|---|---|---|---|---|
| QB | <3 | 0 | 1.00 | 0.00 | 0.00 | 0.79 | 2.72 | 6.32 |
| QB | 3-6 | 0 | 1.00 | 0.00 | 0.34 | 0.82 | 1.59 | 2.77 |
| QB | 6-10 | 1 | 1.00 | 0.12 | 0.37 | 0.78 | 1.39 | 2.03 |
| QB | 10-15 | 60 | 0.40 | 0.18 | 0.44 | 0.79 | 1.27 | 1.63 |
| QB | 15+ | 175 | 0.19 | 0.28 | 0.63 | 0.92 | 1.29 | 1.58 |
| RB | <3 | 152 | 0.21 | 0.00 | 0.00 | 0.74 | 2.52 | 6.36 |
| RB | 3-6 | 88 | 0.31 | 0.05 | 0.38 | 0.86 | 1.72 | 2.76 |
| RB | 6-10 | 108 | 0.27 | 0.09 | 0.33 | 0.69 | 1.28 | 1.87 |
| RB | 10-15 | 109 | 0.27 | 0.24 | 0.43 | 0.75 | 1.29 | 1.77 |
| RB | 15+ | 101 | 0.28 | 0.42 | 0.60 | 0.90 | 1.20 | 1.51 |
| WR | <3 | 217 | 0.16 | 0.00 | 0.00 | 0.56 | 2.90 | 6.36 |
| WR | 3-6 | 135 | 0.23 | 0.00 | 0.31 | 0.80 | 1.55 | 2.78 |
| WR | 6-10 | 235 | 0.14 | 0.15 | 0.43 | 0.79 | 1.36 | 2.13 |
| WR | 10-15 | 171 | 0.19 | 0.23 | 0.46 | 0.75 | 1.30 | 1.86 |
| WR | 15+ | 80 | 0.33 | 0.37 | 0.58 | 0.88 | 1.43 | 1.70 |
| TE | <3 | 175 | 0.19 | 0.00 | 0.00 | 0.91 | 2.46 | 5.50 |
| TE | 3-6 | 74 | 0.35 | 0.00 | 0.34 | 0.77 | 1.67 | 2.75 |
| TE | 6-10 | 132 | 0.23 | 0.15 | 0.35 | 0.79 | 1.50 | 2.02 |
| TE | 10-15 | 70 | 0.36 | 0.21 | 0.37 | 0.78 | 1.26 | 1.86 |
| TE | 15+ | 13 | 1.00 | 0.36 | 0.61 | 0.91 | 1.31 | 1.61 |

### Stat-line simulation

Per-player bands from the projected stat line (see the bands note). Fitted dispersions: Walk-forward check on week 7: simulation 76% of actuals inside the 80% band, 45% inside the 50% band; the published blend with the tier bands 79% / 45% (n=204).

| pos | volume σ (log) by tier | yards/opportunity gamma shape | TD overdispersion |
|---|---|---|---|
| QB | passAtt 0.25/0.24/0.22, rushAtt 0.60/–/–/– | passYds 0.623, rushYds 0.5 | passTD 1.0, rushTD 1.0 |
| RB | rushAtt 0.71/0.65/0.50/0.36, tgt 0.63/0.65/0.56/– | rushYds 0.667, recYds 0.957 | rushTD 1.0, recTD 1.0 |
| WR | tgt 0.62/0.68/0.56/0.56 | recYds 1.181 | recTD 1.11 |
| TE | tgt 0.65/0.62/0.60/0.54 | recYds 1.566 | recTD 1.397 |

## Stat lines (2107 player-weeks; rule per week: wk 1 proportional, wk 2 proportional, wk 3 proportional, wk 4 proportional, wk 5 proportional, wk 6 proportional, wk 7 proportional)

MAE / r per component — StatHead vs the flat per-game stat vs the external benchmark — and the matchup swing's calibration on that component (1 = right size, 0 = no information).

| pos | stat | n | actual/g | StatHead | flat | benchmark | swing slope |
|---|---|---|---|---|---|---|---|
| QB | passAtt | 236 | 29.89 | 9.03 / 0.1538 | 8.68 / 0.2103 | 6.71 / 0.2521 | 0.002 |
| QB | passComp | 236 | 19.17 | 6.12 / 0.2159 | 5.92 / 0.2275 | 4.72 / 0.2703 | 0.261 |
| QB | passYds | 236 | 210.77 | 70.59 / 0.252 | 70.57 / 0.2414 | 58.06 / 0.2723 | 0.563 |
| QB | passTD | 236 | 1.36 | 0.91 / 0.253 | 0.93 / 0.2026 | 0.85 / 0.2935 | 1.782 |
| QB | int | 236 | 0.61 | 0.66 / -0.0384 | 0.65 / -0.0122 | 0.64 / 0.0879 | -0.504 |
| QB | rushAtt | 236 | 3.38 | 2.51 / 0.0143 | 2.52 / 0.016 | 1.93 / 0.419 | -0.169 |
| QB | rushYds | 236 | 14.82 | 13.85 / 0.1921 | 13.99 / 0.1828 | 12.50 / 0.4859 | 0.79 |
| QB | rushTD | 236 | 0.17 | 0.26 / 0.308 | 0.26 / 0.3064 | 0.28 / 0.298 | 0.869 |
| RB | rushAtt | 563 | 8.32 | 3.44 / 0.7683 | 3.37 / 0.7793 | 3.19 / 0.8067 | 0.07 |
| RB | rushYds | 563 | 34.48 | 19.43 / 0.6793 | 19.36 / 0.6855 | 18.51 / 0.7106 | 0.128 |
| RB | rushTD | 563 | 0.28 | 0.37 / 0.3745 | 0.37 / 0.3626 | 0.36 / 0.3988 | 1.326 |
| RB | tgt | 563 | 2.1 | 1.32 / 0.5625 | 1.30 / 0.5809 | 1.23 / 0.6264 | -0.452 |
| RB | rec | 563 | 1.64 | 1.12 / 0.5276 | 1.11 / 0.5402 | 1.06 / 0.5843 | -0.249 |
| RB | recYds | 563 | 11.82 | 10.37 / 0.4548 | 10.35 / 0.469 | 9.95 / 0.4939 | -0.453 |
| RB | recTD | 563 | 0.06 | 0.11 / 0.111 | 0.11 / 0.1047 | 0.13 / 0.1211 | 2.414 |
| WR | tgt | 843 | 4.47 | 2.19 / 0.6167 | 2.17 / 0.6226 | 1.92 / 0.6998 | 0.126 |
| WR | rec | 843 | 2.77 | 1.51 / 0.6173 | 1.50 / 0.619 | 1.37 / 0.676 | 0.341 |
| WR | recYds | 843 | 35.98 | 22.97 / 0.5762 | 23.02 / 0.5727 | 21.38 / 0.6126 | 0.65 |
| WR | recTD | 843 | 0.2 | 0.30 / 0.2611 | 0.30 / 0.2577 | 0.31 / 0.2715 | 1.478 |
| TE | tgt | 465 | 3.34 | 1.61 / 0.6807 | 1.61 / 0.6787 | 1.57 / 0.7087 | 0.531 |
| TE | rec | 465 | 2.4 | 1.37 / 0.6239 | 1.37 / 0.6154 | 1.34 / 0.6386 | 0.925 |
| TE | recYds | 465 | 23.68 | 16.67 / 0.5637 | 16.84 / 0.5477 | 16.24 / 0.5688 | 1.474 |
| TE | recTD | 465 | 0.22 | 0.30 / 0.1835 | 0.30 / 0.1612 | 0.31 / 0.2058 | 4.787 |
