# Weekly projection accuracy — 2026, weeks 1–8

_2384 player-weeks scored out of sample; generated 2026-11-08T13:01_

## All players who played

| method | n | MAE | RMSE | r | bias |
|---|---|---|---|---|---|
| StatHead (published) | 2298 | 4.72 | 6.35 | 0.6419 | -0.12 |
| season line only | 2298 | 4.74 | 6.38 | 0.6363 | -0.09 |
| external benchmark | 2298 | 4.50 | 6.13 | 0.67 | -0.15 |

## By position (MAE / r): StatHead vs season line vs benchmark

| pos | n | StatHead | season line | benchmark |
|---|---|---|---|---|
| QB | 241 | 6.17 / 0.3185 | 6.33 / 0.2287 | 6.19 / 0.3309 |
| RB | 621 | 4.70 / 0.6538 | 4.67 / 0.6587 | 4.36 / 0.6962 |
| WR | 934 | 4.66 / 0.5941 | 4.66 / 0.5916 | 4.41 / 0.6305 |
| TE | 502 | 4.14 / 0.5461 | 4.21 / 0.5256 | 4.03 / 0.5639 |

## Starters (projected ≥ 8)

| method | n | MAE | RMSE | r | bias |
|---|---|---|---|---|---|
| StatHead | 1105 | 6.25 | 7.70 | 0.4524 | +0.60 |
| season line only | 1105 | 6.30 | 7.77 | 0.4338 | +0.57 |
| external benchmark | 1105 | 5.99 | 7.49 | 0.4934 | +0.27 |

## Against naive in-season baselines (weeks 2+, players with a prior game)

| method | n | MAE | RMSE | r | bias |
|---|---|---|---|---|---|
| StatHead | 1702 | 4.87 | 6.49 | 0.6212 | -0.21 |
| season line only | 1702 | 4.92 | 6.56 | 0.6103 | -0.21 |
| season-to-date average | 1702 | 5.35 | 7.33 | 0.5513 | -0.35 |
| last week | 1702 | 6.12 | 8.46 | 0.4729 | -0.07 |
| external benchmark | 1702 | 4.71 | 6.28 | 0.6471 | -0.14 |

## Matchup layer calibration

Slope of (actual − season line) on (projection − season line): 1 = the projected swing is the right size, 0 = no information. impliedScale = scale in force × slope — what POS_MATCHUP_SCALE should be.

| pos | n | slope | ± se | scale in force | implied scale |
|---|---|---|---|---|---|
| overall | 2384 | +0.73 | 0.15 | 0.99 | 0.72 |
| QB | 271 | +1.24 | 0.40 | 1.00 | 1.24 |
| RB | 637 | +0.17 | 0.25 | 0.94 | 0.16 |
| WR | 953 | +0.62 | 0.28 | 0.96 | 0.60 |
| TE | 523 | +1.69 | 0.36 | 1.08 | 1.83 |

## Pick lines

41 graded picks (44 pending): hit rate 61% (model expected 59%), return +4.84 units, ROI +11.8% per pick.

| cut | n | hits | hit rate | expected | return | ROI |
|---|---|---|---|---|---|---|
| all | 41 | 25 | 61% | 59% | +4.84 | +11.8% |
| auto picks | 32 | 19 | 59% | 59% | +2.88 | +9.0% |
| call picks | 9 | 6 | 67% | 61% | +1.96 | +21.8% |
| line moved toward | 8 | 3 | 38% | 60% | -2.46 | -30.7% |
| line moved unchanged | 19 | 14 | 74% | 57% | +7.28 | +38.3% |
| line moved away | 7 | 4 | 57% | 62% | +0.07 | +1.0% |
| stat anyTD | 1 | 1 | 100% | 60% | +0.81 | +81.0% |
| stat passTD | 2 | 0 | 0% | 54% | -2.00 | -100.0% |
| stat passYds | 1 | 1 | 100% | 62% | +0.79 | +79.0% |
| stat rec | 12 | 9 | 75% | 56% | +5.06 | +42.2% |
| stat recYds | 5 | 5 | 100% | 61% | +3.92 | +78.4% |
| stat rushAtt | 9 | 5 | 56% | 60% | +0.10 | +1.1% |
| stat rushRecYds | 5 | 1 | 20% | 62% | -3.21 | -64.2% |
| stat rushYds | 6 | 3 | 50% | 63% | -0.63 | -10.5% |
| confidence 62%+ | 13 | 9 | 69% | 64% | +2.92 | +22.5% |
| confidence 58-62% | 15 | 10 | 67% | 60% | +2.89 | +19.3% |
| confidence 54-58% | 8 | 4 | 50% | 56% | -0.08 | -1.0% |
| confidence 50-54% | 5 | 2 | 40% | 52% | -0.89 | -17.8% |
| flagged | 3 | 1 | 33% | 61% | -1.05 | -35.0% |
| unflagged | 38 | 24 | 63% | 59% | +5.89 | +15.5% |

| week | player | stat | line | lean | P(lean) | actual | hit | ret |
|---|---|---|---|---|---|---|---|---|
| 7 | Dallas Goedert ★ | rec | 5.5 | under | 64% | 5.0 | True | +0.61 |
| 8 | Chuba Hubbard | rushAtt | 15.5 | over | 60% | 22.0 | True | +0.78 |
| 7 | Javonte Williams ★ | rushAtt | 16.5 | under | 59% | 25.0 | False | -1.00 |
| 7 | Dallas Goedert | recYds | 49.5 | under | 59% | 48.0 | True | +0.77 |
| 8 | Chuba Hubbard | rushYds | 69.5 | over | 66% | 81.0 | True | +0.77 |
| 7 | Dak Prescott ★ | passTD | 1.5 | under | 55% | 3.0 | False | -1.00 |
| 8 | Jordan Love | passTD | 1.5 | under | 53% | 3.0 | False | -1.00 |
| 7 | Javonte Williams | rushRecYds | 81.5 | under | 64% | 155.0 | False | -1.00 |
| 8 | Chuba Hubbard | rushRecYds | 88.5 | over | 63% | 119.0 | True | +0.79 |
| 7 | Dak Prescott | passYds | 266.5 | under | 62% | 212.0 | True | +0.79 |
| 8 | Ashton Jeanty | anyTD | 0.5 | under | 60% | 0.0 | True | +0.81 |
| 8 | Jalen Coker | recYds | 62.5 | under | 60% | 36.0 | True | +0.78 |
| 7 | Javonte Williams | recYds | 12.5 | under | 60% | 0.0 | True | +0.78 |
| 8 | Jalen Coker | rec | 4.5 | under | 50% | 2.0 | True | +1.09 |
| 8 | J.K. Dobbins | rushAtt | 7.5 | over | 62% | 7.0 | False | -1.00 |
| 8 | Jonnu Smith | rec | 0.5 | over | 70% | None | None | +0.00 |
| 8 | Omarion Hampton ★ | rec | 1.5 | over | 55% | 2.0 | True | +1.19 |
| 8 | Tyler Goodson | rushYds | 19.5 | under | 64% | 14.0 | True | +0.81 |
| 8 | Rachaad White | rushAtt | 12.5 | under | 66% | 11.0 | True | +0.71 |
| 8 | J.K. Dobbins | rushYds | 22.5 | over | 63% | 13.0 | False | -1.00 |
| 8 | Jayden Daniels | rushAtt | 6.5 | under | 58% | 2.0 | True | +0.95 |
| 8 | Ja'Kobi Lane | recYds | 30.5 | under | 62% | 13.0 | True | +0.80 |
| 8 | Kenneth Walker III | rec | 2.5 | under | 53% | 4.0 | False | -1.00 |
| 8 | Justin Jefferson | rec | 5.5 | under | 56% | 5.0 | True | +0.97 |
| 8 | Sam LaPorta | rec | 4.5 | under | 59% | 3.0 | True | +0.85 |
| 8 | Malik Willis | rushAtt | 6.5 | under | 60% | 1.0 | True | +0.80 |
| 8 | Ja'Kobi Lane | rec | 2.5 | under | 60% | 1.0 | True | +0.80 |
| 8 | MarShawn Lloyd | rushAtt | 5.5 | over | 54% | 3.0 | False | -1.00 |
| 8 | Jahan Dotson | rec | 1.5 | under | 51% | 2.0 | False | -1.00 |
| 8 | Rachaad White | rushYds | 44.5 | under | 59% | 55.0 | False | -1.00 |
| 8 | RJ Harvey | rushYds | 7.5 | over | 60% | None | None | +0.00 |
| 8 | Jonathan Taylor | rushRecYds | 83.5 | over | 59% | 47.0 | False | -1.00 |
| 8 | Jonathan Taylor | rushAtt | 16.5 | over | 56% | 8.0 | False | -1.00 |
| 8 | Jonathan Taylor | rushYds | 60.5 | over | 59% | 23.0 | False | -1.00 |
| 8 | KC Concepcion | rec | 4.5 | under | 57% | 3.0 | True | +0.81 |
| 8 | Ja'Kobi Lane ★ | recYds | 31.5 | under | 62% | 13.0 | True | +0.79 |
| 8 | Jonathan Taylor | rushRecYds | 81.5 | over | 60% | 47.0 | False | -1.00 |
| 8 | Rachaad White ★ | rushAtt | 11.5 | under | 64% | 11.0 | True | +0.86 |
| 8 | Tyler Goodson ★ | rushYds | 20.5 | under | 64% | 14.0 | True | +0.79 |
| 8 | Jonathan Taylor ★ | rushRecYds | 71.5 | over | 64% | 47.0 | False | -1.00 |
| 8 | Justin Jefferson ★ | rec | 6.5 | under | 61% | 5.0 | True | +0.72 |
| 8 | Chris Bell | rec | 1.5 | under | 57% | 4.0 | False | -1.00 |
| 8 | Dallas Goedert | rec | 4.5 | under | 53% | 4.0 | True | +1.02 |

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
| 8 | 2026-10-30T00:08 | 277 | 4.688 | 0.6281 | 4.486 | 12 (136 pts): 0 / 9 / 3 |

Latest week's biggest no-shows: DeVonta Smith (WR, 14.1, questionable), Breece Hall (RB, 13.7, questionable), Carnell Tate (WR, 13.1, questionable), Emeka Egbuka (WR, 13.1, questionable), A.J. Brown (WR, 12.1, questionable), Omar Cooper Jr. (WR, 11.7, none)

## Confidence bands (actual ÷ projected, players who played, fitted on weeks 1–8)

Projection × p10–p90 = the 80% band, × p25–p75 the 50% band; the median ratio is below 1 because weeks are right-skewed. Thin cells are shrunk toward the pooled tier shape (shrunk = weight on it). Walk-forward check on week 8: 83% of actuals inside the 80% band, 55% inside the 50% band (n=277).

| pos | tier | n | shrunk | p10 | p25 | median | p75 | p90 |
|---|---|---|---|---|---|---|---|---|
| QB | <3 | 1 | 1.00 | 0.00 | 0.00 | 0.77 | 2.70 | 5.90 |
| QB | 3-6 | 0 | 1.00 | 0.00 | 0.32 | 0.77 | 1.59 | 2.74 |
| QB | 6-10 | 1 | 1.00 | 0.14 | 0.38 | 0.79 | 1.42 | 2.03 |
| QB | 10-15 | 71 | 0.36 | 0.13 | 0.44 | 0.78 | 1.28 | 1.62 |
| QB | 15+ | 198 | 0.17 | 0.19 | 0.62 | 0.91 | 1.27 | 1.57 |
| RB | <3 | 171 | 0.19 | 0.00 | 0.00 | 0.70 | 2.52 | 5.85 |
| RB | 3-6 | 101 | 0.28 | 0.04 | 0.34 | 0.80 | 1.59 | 2.73 |
| RB | 6-10 | 122 | 0.25 | 0.11 | 0.33 | 0.74 | 1.30 | 1.91 |
| RB | 10-15 | 123 | 0.24 | 0.25 | 0.46 | 0.76 | 1.30 | 1.85 |
| RB | 15+ | 115 | 0.26 | 0.38 | 0.59 | 0.90 | 1.20 | 1.52 |
| WR | <3 | 245 | 0.14 | 0.00 | 0.00 | 0.53 | 2.73 | 6.24 |
| WR | 3-6 | 156 | 0.20 | 0.00 | 0.27 | 0.78 | 1.54 | 2.71 |
| WR | 6-10 | 265 | 0.13 | 0.15 | 0.44 | 0.86 | 1.38 | 2.09 |
| WR | 10-15 | 193 | 0.17 | 0.20 | 0.47 | 0.77 | 1.32 | 1.82 |
| WR | 15+ | 89 | 0.31 | 0.34 | 0.58 | 0.88 | 1.43 | 1.71 |
| TE | <3 | 197 | 0.17 | 0.00 | 0.00 | 0.94 | 2.59 | 5.19 |
| TE | 3-6 | 82 | 0.33 | 0.00 | 0.35 | 0.71 | 1.67 | 2.67 |
| TE | 6-10 | 151 | 0.21 | 0.16 | 0.37 | 0.79 | 1.51 | 2.03 |
| TE | 10-15 | 77 | 0.34 | 0.22 | 0.41 | 0.78 | 1.27 | 1.84 |
| TE | 15+ | 15 | 0.73 | 0.43 | 0.68 | 0.94 | 1.32 | 1.61 |

### Stat-line simulation

Per-player bands from the projected stat line (see the bands note). Fitted dispersions: Walk-forward check on week 8: simulation 72% of actuals inside the 80% band, 42% inside the 50% band; the published blend with the tier bands 74% / 44% (n=207).

| pos | volume σ (log) by tier | yards/opportunity gamma shape | TD overdispersion |
|---|---|---|---|
| QB | passAtt 0.24/0.24/0.23, rushAtt 0.61/–/–/– | passYds 0.625, rushYds 0.5 | passTD 1.0, rushTD 1.0 |
| RB | rushAtt 0.76/0.64/0.49/0.42, tgt 0.62/0.68/0.55/– | rushYds 0.678, recYds 0.943 | rushTD 1.0, recTD 1.0 |
| WR | tgt 0.63/0.66/0.56/0.56 | recYds 1.212 | recTD 1.097 |
| TE | tgt 0.64/0.60/0.58/0.52 | recYds 1.503 | recTD 1.346 |

## Stat lines (2384 player-weeks; rule per week: wk 1 proportional, wk 2 proportional, wk 3 proportional, wk 4 proportional, wk 5 proportional, wk 6 proportional, wk 7 proportional, wk 8 split)

MAE / r per component — StatHead vs the flat per-game stat vs the external benchmark — and the matchup swing's calibration on that component (1 = right size, 0 = no information).

| pos | stat | n | actual/g | StatHead | flat | benchmark | swing slope |
|---|---|---|---|---|---|---|---|
| QB | passAtt | 271 | 29.24 | 9.20 / 0.2063 | 8.89 / 0.2527 | 6.80 / 0.2533 | -0.002 |
| QB | passComp | 271 | 18.76 | 6.34 / 0.2453 | 6.17 / 0.2573 | 4.90 / 0.2705 | 0.258 |
| QB | passYds | 271 | 206.77 | 73.10 / 0.2597 | 72.71 / 0.259 | 59.74 / 0.2578 | 0.457 |
| QB | passTD | 271 | 1.35 | 0.93 / 0.2631 | 0.95 / 0.2158 | 0.88 / 0.2798 | 1.573 |
| QB | int | 271 | 0.62 | 0.67 / -0.0511 | 0.66 / -0.0289 | 0.65 / 0.0679 | -0.488 |
| QB | rushAtt | 271 | 3.29 | 2.45 / 0.0425 | 2.46 / 0.0445 | 1.95 / 0.3949 | -0.169 |
| QB | rushYds | 271 | 14.01 | 13.60 / 0.2011 | 13.72 / 0.1922 | 12.55 / 0.4541 | 0.751 |
| QB | rushTD | 271 | 0.16 | 0.25 / 0.3079 | 0.26 / 0.3026 | 0.28 / 0.2959 | 1.654 |
| RB | rushAtt | 637 | 8.39 | 3.53 / 0.7595 | 3.47 / 0.7689 | 3.24 / 0.8007 | 0.068 |
| RB | rushYds | 637 | 35.03 | 19.90 / 0.669 | 19.87 / 0.6727 | 18.99 / 0.6999 | 0.24 |
| RB | rushTD | 637 | 0.28 | 0.36 / 0.3836 | 0.37 / 0.3722 | 0.36 / 0.4059 | 1.373 |
| RB | tgt | 637 | 2.07 | 1.32 / 0.5564 | 1.31 / 0.5726 | 1.23 / 0.623 | -0.46 |
| RB | rec | 637 | 1.62 | 1.13 / 0.5237 | 1.12 / 0.5347 | 1.06 / 0.5823 | -0.231 |
| RB | recYds | 637 | 11.84 | 10.53 / 0.43 | 10.51 / 0.4425 | 10.11 / 0.4727 | -0.477 |
| RB | recTD | 637 | 0.06 | 0.11 / 0.114 | 0.11 / 0.106 | 0.13 / 0.1171 | 3.284 |
| WR | tgt | 953 | 4.43 | 2.13 / 0.6366 | 2.12 / 0.6421 | 1.88 / 0.713 | 0.122 |
| WR | rec | 953 | 2.76 | 1.50 / 0.6258 | 1.49 / 0.6279 | 1.37 / 0.6785 | 0.3 |
| WR | recYds | 953 | 35.54 | 22.70 / 0.5786 | 22.75 / 0.5748 | 21.29 / 0.6099 | 0.681 |
| WR | recTD | 953 | 0.21 | 0.30 / 0.2721 | 0.30 / 0.2678 | 0.31 / 0.2775 | 1.601 |
| TE | tgt | 523 | 3.37 | 1.58 / 0.6879 | 1.58 / 0.6861 | 1.55 / 0.7138 | 0.533 |
| TE | rec | 523 | 2.41 | 1.35 / 0.6288 | 1.35 / 0.6214 | 1.31 / 0.6453 | 0.832 |
| TE | recYds | 523 | 24.42 | 16.66 / 0.5645 | 16.85 / 0.5492 | 16.29 / 0.5717 | 1.45 |
| TE | recTD | 523 | 0.22 | 0.30 / 0.203 | 0.30 / 0.1807 | 0.31 / 0.2255 | 3.464 |
