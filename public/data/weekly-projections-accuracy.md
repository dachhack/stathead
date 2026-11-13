# Weekly projection accuracy — 2026, weeks 1–9

_2686 player-weeks scored out of sample; generated 2026-11-12T13:01_

## All players who played

| method | n | MAE | RMSE | r | bias |
|---|---|---|---|---|---|
| StatHead (published) | 2585 | 4.69 | 6.33 | 0.6396 | -0.10 |
| season line only | 2585 | 4.71 | 6.36 | 0.6353 | -0.06 |
| external benchmark | 2585 | 4.49 | 6.11 | 0.668 | -0.09 |

## By position (MAE / r): StatHead vs season line vs benchmark

| pos | n | StatHead | season line | benchmark |
|---|---|---|---|---|
| QB | 271 | 6.27 / 0.2927 | 6.41 / 0.2176 | 6.29 / 0.3308 |
| RB | 697 | 4.67 / 0.6507 | 4.65 / 0.6539 | 4.34 / 0.6935 |
| WR | 1051 | 4.65 / 0.5983 | 4.63 / 0.5982 | 4.42 / 0.6316 |
| TE | 566 | 4.03 / 0.5519 | 4.10 / 0.5352 | 3.93 / 0.5697 |

## Starters (projected ≥ 8)

| method | n | MAE | RMSE | r | bias |
|---|---|---|---|---|---|
| StatHead | 1239 | 6.20 | 7.65 | 0.4537 | +0.68 |
| season line only | 1239 | 6.25 | 7.72 | 0.4368 | +0.65 |
| external benchmark | 1239 | 5.98 | 7.46 | 0.4927 | +0.43 |

## Against naive in-season baselines (weeks 2+, players with a prior game)

| method | n | MAE | RMSE | r | bias |
|---|---|---|---|---|---|
| StatHead | 1926 | 4.83 | 6.45 | 0.6214 | -0.14 |
| season line only | 1926 | 4.88 | 6.52 | 0.6111 | -0.13 |
| season-to-date average | 1926 | 5.26 | 7.22 | 0.5587 | -0.24 |
| last week | 1926 | 6.08 | 8.42 | 0.4756 | +0.01 |
| external benchmark | 1926 | 4.68 | 6.24 | 0.6493 | -0.04 |

## Matchup layer calibration

Slope of (actual − season line) on (projection − season line): 1 = the projected swing is the right size, 0 = no information. impliedScale = scale in force × slope — what POS_MATCHUP_SCALE should be.

| pos | n | slope | ± se | scale in force | implied scale |
|---|---|---|---|---|---|
| overall | 2686 | +0.64 | 0.14 | 0.98 | 0.63 |
| QB | 309 | +1.07 | 0.37 | 1.00 | 1.07 |
| RB | 715 | +0.23 | 0.24 | 0.89 | 0.21 |
| WR | 1073 | +0.44 | 0.25 | 0.94 | 0.41 |
| TE | 589 | +1.15 | 0.28 | 1.16 | 1.34 |

## Pick lines

95 graded picks (6 pending): hit rate 58% (model expected 59%), return +5.63 units, ROI +5.9% per pick.

| cut | n | hits | hit rate | expected | return | ROI |
|---|---|---|---|---|---|---|
| all | 95 | 55 | 58% | 59% | +5.63 | +5.9% |
| auto picks | 86 | 49 | 57% | 59% | +3.67 | +4.3% |
| call picks | 9 | 6 | 67% | 61% | +1.96 | +21.8% |
| line moved toward | 19 | 10 | 53% | 59% | -0.61 | -3.2% |
| line moved unchanged | 48 | 30 | 62% | 58% | +7.79 | +16.2% |
| line moved away | 20 | 10 | 50% | 61% | -2.29 | -11.4% |
| stat anyTD | 1 | 1 | 100% | 60% | +0.81 | +81.0% |
| stat passRushYds | 1 | 1 | 100% | 58% | +0.77 | +77.0% |
| stat passTD | 3 | 0 | 0% | 54% | -3.00 | -100.0% |
| stat passYds | 4 | 2 | 50% | 60% | -0.42 | -10.5% |
| stat rec | 29 | 20 | 69% | 56% | +8.83 | +30.4% |
| stat recYds | 12 | 9 | 75% | 60% | +4.05 | +33.8% |
| stat rushAtt | 20 | 12 | 60% | 60% | +1.74 | +8.7% |
| stat rushRecYds | 12 | 2 | 17% | 61% | -8.43 | -70.3% |
| stat rushYds | 13 | 8 | 62% | 61% | +1.28 | +9.8% |
| confidence 62%+ | 18 | 13 | 72% | 63% | +4.93 | +27.4% |
| confidence 58-62% | 45 | 25 | 56% | 60% | -0.32 | -0.7% |
| confidence 54-58% | 21 | 11 | 52% | 56% | -0.16 | -0.8% |
| confidence 50-54% | 11 | 6 | 55% | 52% | +1.18 | +10.7% |
| flagged | 10 | 6 | 60% | 59% | +0.82 | +8.2% |
| unflagged | 85 | 49 | 58% | 59% | +4.81 | +5.7% |

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
| 9 | Zay Flowers | rec | 4.5 | over | 54% | 3.0 | False | -1.00 |
| 9 | Rhamondre Stevenson | rushYds | 54.5 | under | 62% | 32.0 | None | +0.00 |
| 9 | Christian Watson | rec | 4.5 | under | 55% | 7.0 | False | -1.00 |
| 9 | Zay Flowers | recYds | 45.5 | over | 60% | 6.0 | False | -1.00 |
| 9 | Jordan Love | passYds | 273.5 | under | 60% | 372.0 | False | -1.00 |
| 9 | Rhamondre Stevenson | anyTD | 0.5 | under | 57% | 1.0 | None | +0.00 |
| 9 | Rhamondre Stevenson | rushAtt | 14.5 | under | 62% | 6.0 | None | +0.00 |
| 9 | Zay Flowers | recYds | 44.5 | over | 60% | 6.0 | False | -1.00 |
| 9 | Malik Willis | rushAtt | 5.5 | under | 62% | 2.0 | True | +0.99 |
| 9 | Aaron Jones Sr. | rushAtt | 8.5 | over | 62% | 5.0 | False | -1.00 |
| 9 | T.J. Hockenson | rec | 4.5 | under | 62% | 4.0 | True | +0.80 |
| 9 | Mark Andrews | rec | 2.5 | under | 57% | 2.0 | True | +0.95 |
| 9 | T.J. Hockenson | recYds | 41.5 | under | 61% | 33.0 | True | +0.78 |
| 9 | Omarion Hampton | rushAtt | 8.5 | over | 58% | 13.0 | True | +0.85 |
| 9 | Caleb Williams | passTD | 1.5 | under | 54% | 2.0 | False | -1.00 |
| 9 | Jordan Love | passYds | 274.5 | under | 60% | 372.0 | False | -1.00 |
| 9 | Rachaad White | rec | 2.5 | under | 54% | 2.0 | True | +1.02 |
| 9 | Marvin Mims Jr. | rec | 1.5 | over | 53% | 1.0 | False | -1.00 |
| 9 | Marvin Harrison Jr. | rec | 2.5 | under | 61% | 2.0 | True | +0.76 |
| 9 | Aaron Jones Sr. | rushYds | 31.5 | over | 61% | 16.0 | False | -1.00 |
| 9 | Omarion Hampton | rec | 1.5 | over | 54% | 0.0 | False | -1.00 |
| 9 | Quinshon Judkins | rushYds | 65.5 | under | 60% | 43.0 | True | +0.78 |
| 9 | J.K. Dobbins | rushAtt | 8.5 | over | 59% | 4.0 | False | -1.00 |
| 9 | Jordan Addison | rec | 3.5 | under | 60% | 2.0 | True | +0.77 |
| 9 | Quinshon Judkins | rushAtt | 16.5 | under | 60% | 15.0 | True | +0.76 |
| 9 | Rachaad White | rushAtt | 11.5 | under | 62% | 7.0 | True | +0.69 |
| 9 | Jadarian Price | rushRecYds | 62.5 | under | 58% | 78.0 | False | -1.00 |
| 9 | Kyle Pitts Sr. | rec | 3.5 | under | 50% | 3.0 | True | +1.09 |
| 9 | Jayden Daniels | rushYds | 37.5 | under | 57% | 16.0 | True | +0.81 |
| 9 | Rachaad White | recYds | 17.5 | under | 59% | 41.0 | False | -1.00 |
| 9 | J.K. Dobbins | rushAtt | 7.5 | over | 62% | 4.0 | False | -1.00 |
| 9 | Noah Gray | rec | 1.5 | over | 57% | 1.0 | False | -1.00 |
| 9 | Aaron Jones Sr. | rushRecYds | 42.5 | over | 61% | 21.0 | False | -1.00 |
| 9 | Justin Jefferson | recYds | 78.5 | under | 61% | 58.0 | True | +0.77 |
| 9 | Justin Jefferson | rec | 6.5 | under | 62% | 3.0 | True | +0.73 |
| 9 | Jadarian Price | rushRecYds | 65.5 | under | 59% | 78.0 | False | -1.00 |
| 9 | Kyle Pitts Sr. | recYds | 41.5 | under | 58% | 23.0 | True | +0.79 |
| 9 | Jadarian Price | rushAtt | 13.5 | under | 62% | 9.0 | True | +0.67 |
| 9 | Jadarian Price | rushRecYds | 66.5 | under | 60% | 78.0 | False | -1.00 |
| 9 | Breece Hall | rushAtt | 12.5 | over | 57% | 15.0 | True | +0.87 |
| 9 | Quinshon Judkins | rushYds | 68.5 | under | 60% | 43.0 | True | +0.76 |
| 9 | Jadarian Price | rushYds | 54.5 | under | 59% | 24.0 | True | +0.77 |
| 9 | Jalen Coker | rec | 4.5 | under | 57% | 4.0 | True | +0.81 |
| 9 | Breece Hall | rushRecYds | 59.5 | over | 58% | 87.0 | True | +0.78 |
| 9 | Khalil Shakir | rec | 3.5 | under | 54% | 4.0 | False | -1.00 |
| 9 | Jadarian Price | rushRecYds | 69.5 | under | 61% | 78.0 | False | -1.00 |
| 9 | Jadarian Price | rushYds | 55.5 | under | 60% | 24.0 | True | +0.79 |
| 9 | Christian McCaffrey | rushAtt | 13.5 | under | 57% | 18.0 | False | -1.00 |
| 9 | Kayshon Boutte | rec | 1.5 | over | 54% | 4.0 | True | +0.98 |
| 9 | Kaelon Black | rushYds | 40.5 | under | 59% | 70.0 | False | -1.00 |
| 9 | DJ Moore | rec | 3.5 | under | 56% | 3.0 | True | +0.88 |
| 9 | Bucky Irving | rushAtt | 15.5 | over | 57% | 20.0 | True | +0.81 |
| 9 | George Kittle | rec | 5.5 | under | 53% | 4.0 | True | +0.98 |
| 9 | Josh Allen | passRushYds | 272.5 | under | 58% | 249.0 | True | +0.77 |
| 9 | Jadarian Price | rushRecYds | 68.5 | under | 61% | 78.0 | False | -1.00 |
| 9 | Josh Allen | passYds | 236.5 | under | 58% | 234.0 | True | +0.79 |
| 9 | Justin Jefferson | recYds | 79.5 | under | 62% | 58.0 | True | +0.79 |

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
| 9 | 2026-11-06T01:08 | 302 | 4.425 | 0.6194 | 4.361 | 18 (210 pts): 2 / 13 / 3 |

Latest week's biggest no-shows: Deshaun Watson (QB, 15.1, questionable), Mike Evans (WR, 14.8, questionable), Sam Darnold (QB, 14.7, out), DeVonta Smith (WR, 14.3, questionable), Kyler Murray (QB, 14.1, questionable), Cam Skattebo (RB, 13.9, questionable)

## Confidence bands (actual ÷ projected, players who played, fitted on weeks 1–9)

Projection × p10–p90 = the 80% band, × p25–p75 the 50% band; the median ratio is below 1 because weeks are right-skewed. Thin cells are shrunk toward the pooled tier shape (shrunk = weight on it). Walk-forward check on week 9: 88% of actuals inside the 80% band, 62% inside the 50% band (n=298).

| pos | tier | n | shrunk | p10 | p25 | median | p75 | p90 |
|---|---|---|---|---|---|---|---|---|
| QB | <3 | 2 | 1.00 | 0.00 | 0.00 | 0.74 | 2.60 | 5.62 |
| QB | 3-6 | 0 | 1.00 | 0.00 | 0.31 | 0.80 | 1.59 | 2.71 |
| QB | 6-10 | 2 | 1.00 | 0.16 | 0.41 | 0.80 | 1.41 | 2.02 |
| QB | 10-15 | 85 | 0.32 | 0.06 | 0.36 | 0.72 | 1.17 | 1.59 |
| QB | 15+ | 220 | 0.15 | 0.21 | 0.62 | 0.89 | 1.26 | 1.56 |
| RB | <3 | 192 | 0.17 | 0.00 | 0.00 | 0.70 | 2.45 | 5.33 |
| RB | 3-6 | 115 | 0.26 | 0.00 | 0.32 | 0.81 | 1.61 | 2.75 |
| RB | 6-10 | 138 | 0.23 | 0.11 | 0.35 | 0.75 | 1.30 | 1.91 |
| RB | 10-15 | 134 | 0.23 | 0.25 | 0.45 | 0.74 | 1.28 | 1.80 |
| RB | 15+ | 130 | 0.23 | 0.37 | 0.58 | 0.89 | 1.20 | 1.53 |
| WR | <3 | 278 | 0.13 | 0.00 | 0.00 | 0.53 | 2.69 | 6.20 |
| WR | 3-6 | 178 | 0.18 | 0.00 | 0.26 | 0.79 | 1.56 | 2.69 |
| WR | 6-10 | 294 | 0.12 | 0.17 | 0.46 | 0.88 | 1.40 | 2.08 |
| WR | 10-15 | 216 | 0.16 | 0.24 | 0.47 | 0.77 | 1.32 | 1.81 |
| WR | 15+ | 99 | 0.29 | 0.36 | 0.58 | 0.88 | 1.44 | 1.70 |
| TE | <3 | 223 | 0.15 | 0.00 | 0.00 | 0.88 | 2.48 | 4.80 |
| TE | 3-6 | 91 | 0.30 | 0.00 | 0.35 | 0.80 | 1.58 | 2.65 |
| TE | 6-10 | 169 | 0.19 | 0.17 | 0.38 | 0.80 | 1.49 | 2.02 |
| TE | 10-15 | 87 | 0.32 | 0.20 | 0.39 | 0.75 | 1.24 | 1.80 |
| TE | 15+ | 18 | 0.69 | 0.41 | 0.67 | 0.94 | 1.31 | 1.60 |

### Stat-line simulation

Per-player bands from the projected stat line (see the bands note). Fitted dispersions: Walk-forward check on week 9: simulation 77% of actuals inside the 80% band, 52% inside the 50% band; the published blend with the tier bands 80% / 52% (n=217).

| pos | volume σ (log) by tier | yards/opportunity gamma shape | TD overdispersion |
|---|---|---|---|
| QB | passAtt 0.24/0.23/0.23, rushAtt 0.64/–/–/– | passYds 0.626, rushYds 0.5 | passTD 1.0, rushTD 1.0 |
| RB | rushAtt 0.76/0.63/0.51/0.42, tgt 0.62/0.65/0.60/– | rushYds 0.659, recYds 0.955 | rushTD 1.0, recTD 1.0 |
| WR | tgt 0.65/0.65/0.56/0.54 | recYds 1.197 | recTD 1.088 |
| TE | tgt 0.63/0.59/0.57/0.49 | recYds 1.471 | recTD 1.271 |

## Stat lines (2686 player-weeks; rule per week: wk 1 proportional, wk 2 proportional, wk 3 proportional, wk 4 proportional, wk 5 proportional, wk 6 proportional, wk 7 proportional, wk 8 split, wk 9 split)

MAE / r per component — StatHead vs the flat per-game stat vs the external benchmark — and the matchup swing's calibration on that component (1 = right size, 0 = no information).

| pos | stat | n | actual/g | StatHead | flat | benchmark | swing slope |
|---|---|---|---|---|---|---|---|
| QB | passAtt | 309 | 28.72 | 9.28 / 0.1996 | 9.01 / 0.2291 | 6.57 / 0.2499 | -0.004 |
| QB | passComp | 309 | 18.39 | 6.41 / 0.2335 | 6.25 / 0.2385 | 4.71 / 0.2773 | 0.256 |
| QB | passYds | 309 | 203.61 | 75.44 / 0.2354 | 74.93 / 0.2239 | 59.85 / 0.2604 | 0.469 |
| QB | passTD | 309 | 1.31 | 0.94 / 0.2464 | 0.96 / 0.2052 | 0.88 / 0.2892 | 1.265 |
| QB | int | 309 | 0.63 | 0.71 / -0.1104 | 0.70 / -0.0941 | 0.67 / 0.0405 | -0.495 |
| QB | rushAtt | 309 | 3.25 | 2.41 / 0.0446 | 2.42 / 0.0466 | 1.99 / 0.3635 | -0.166 |
| QB | rushYds | 309 | 13.72 | 13.54 / 0.2046 | 13.63 / 0.1975 | 12.77 / 0.4148 | 0.644 |
| QB | rushTD | 309 | 0.16 | 0.25 / 0.2869 | 0.25 / 0.278 | 0.28 / 0.2542 | 2.032 |
| RB | rushAtt | 715 | 8.39 | 3.54 / 0.757 | 3.48 / 0.7653 | 3.22 / 0.7996 | 0.066 |
| RB | rushYds | 715 | 34.91 | 19.66 / 0.669 | 19.67 / 0.6719 | 18.82 / 0.6975 | 0.263 |
| RB | rushTD | 715 | 0.28 | 0.36 / 0.38 | 0.36 / 0.3688 | 0.35 / 0.3973 | 1.392 |
| RB | tgt | 715 | 2.04 | 1.30 / 0.5597 | 1.29 / 0.5742 | 1.22 / 0.621 | -0.468 |
| RB | rec | 715 | 1.58 | 1.11 / 0.5259 | 1.10 / 0.5353 | 1.06 / 0.5778 | -0.214 |
| RB | recYds | 715 | 11.64 | 10.51 / 0.4212 | 10.49 / 0.4321 | 10.10 / 0.4597 | -0.473 |
| RB | recTD | 715 | 0.06 | 0.11 / 0.1387 | 0.11 / 0.1276 | 0.13 / 0.1543 | 5.113 |
| WR | tgt | 1073 | 4.42 | 2.09 / 0.6493 | 2.08 / 0.6543 | 1.86 / 0.7169 | 0.124 |
| WR | rec | 1073 | 2.76 | 1.47 / 0.6409 | 1.46 / 0.645 | 1.35 / 0.6883 | 0.211 |
| WR | recYds | 1073 | 35.67 | 22.67 / 0.5819 | 22.66 / 0.5796 | 21.41 / 0.6102 | 0.574 |
| WR | recTD | 1073 | 0.21 | 0.30 / 0.2692 | 0.30 / 0.2638 | 0.31 / 0.2715 | 1.921 |
| TE | tgt | 589 | 3.35 | 1.56 / 0.6894 | 1.56 / 0.6877 | 1.52 / 0.7115 | 0.53 |
| TE | rec | 589 | 2.39 | 1.34 / 0.6282 | 1.32 / 0.6268 | 1.29 / 0.6452 | 0.504 |
| TE | recYds | 589 | 24.34 | 16.15 / 0.5731 | 16.29 / 0.5619 | 15.89 / 0.58 | 1.014 |
| TE | recTD | 589 | 0.21 | 0.29 / 0.208 | 0.29 / 0.1872 | 0.30 / 0.2292 | 1.94 |
