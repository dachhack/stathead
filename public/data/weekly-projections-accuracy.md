# Weekly projection accuracy — 2026, weeks 1–10

_2960 player-weeks scored out of sample; generated 2026-11-17T13:02_

## All players who played

| method | n | MAE | RMSE | r | bias |
|---|---|---|---|---|---|
| StatHead (published) | 2848 | 4.71 | 6.39 | 0.6395 | -0.15 |
| season line only | 2848 | 4.73 | 6.42 | 0.6349 | -0.11 |
| external benchmark | 2848 | 4.51 | 6.16 | 0.6698 | -0.12 |

## By position (MAE / r): StatHead vs season line vs benchmark

| pos | n | StatHead | season line | benchmark |
|---|---|---|---|---|
| QB | 297 | 6.32 / 0.2994 | 6.46 / 0.2278 | 6.30 / 0.3489 |
| RB | 770 | 4.71 / 0.6507 | 4.70 / 0.6529 | 4.41 / 0.6964 |
| WR | 1156 | 4.68 / 0.5967 | 4.67 / 0.5964 | 4.44 / 0.6312 |
| TE | 625 | 4.01 / 0.5409 | 4.08 / 0.5226 | 3.92 / 0.5585 |

## Starters (projected ≥ 8)

| method | n | MAE | RMSE | r | bias |
|---|---|---|---|---|---|
| StatHead | 1359 | 6.26 | 7.74 | 0.4626 | +0.62 |
| season line only | 1359 | 6.31 | 7.82 | 0.4451 | +0.58 |
| external benchmark | 1359 | 6.04 | 7.55 | 0.5002 | +0.39 |

## Against naive in-season baselines (weeks 2+, players with a prior game)

| method | n | MAE | RMSE | r | bias |
|---|---|---|---|---|---|
| StatHead | 2125 | 4.85 | 6.50 | 0.625 | -0.16 |
| season line only | 2125 | 4.91 | 6.57 | 0.6148 | -0.15 |
| season-to-date average | 2125 | 5.26 | 7.21 | 0.566 | -0.23 |
| last week | 2125 | 6.13 | 8.48 | 0.4724 | -0.02 |
| external benchmark | 2125 | 4.71 | 6.27 | 0.6551 | -0.04 |

## Matchup layer calibration

Slope of (actual − season line) on (projection − season line): 1 = the projected swing is the right size, 0 = no information. impliedScale = scale in force × slope — what POS_MATCHUP_SCALE should be.

| pos | n | slope | ± se | scale in force | implied scale |
|---|---|---|---|---|---|
| overall | 2960 | +0.67 | 0.13 | 0.97 | 0.65 |
| QB | 343 | +1.06 | 0.36 | 1.00 | 1.06 |
| RB | 789 | +0.30 | 0.23 | 0.86 | 0.26 |
| WR | 1179 | +0.46 | 0.25 | 0.92 | 0.42 |
| TE | 649 | +1.12 | 0.25 | 1.21 | 1.35 |

## Pick lines

107 graded picks (10 pending): hit rate 54% (model expected 58%), return +0.36 units, ROI +0.3% per pick.

| cut | n | hits | hit rate | expected | return | ROI |
|---|---|---|---|---|---|---|
| all | 107 | 58 | 54% | 58% | +0.36 | +0.3% |
| auto picks | 99 | 53 | 54% | 58% | -0.81 | -0.8% |
| call picks | 8 | 5 | 62% | 60% | +1.17 | +14.6% |
| line moved toward | 10 | 5 | 50% | 59% | -0.70 | -7.0% |
| line moved unchanged | 67 | 36 | 54% | 57% | +1.02 | +1.5% |
| line moved away | 22 | 12 | 55% | 60% | -0.70 | -3.2% |
| stat anyTD | 1 | 1 | 100% | 60% | +0.81 | +81.0% |
| stat passRushYds | 1 | 1 | 100% | 58% | +0.77 | +77.0% |
| stat passTD | 5 | 1 | 20% | 53% | -2.95 | -59.0% |
| stat passYds | 4 | 3 | 75% | 60% | +1.35 | +33.8% |
| stat rec | 44 | 26 | 59% | 56% | +5.58 | +12.7% |
| stat recYds | 15 | 9 | 60% | 60% | +1.32 | +8.8% |
| stat rushAtt | 19 | 9 | 47% | 59% | -2.76 | -14.5% |
| stat rushRecYds | 8 | 4 | 50% | 62% | -0.89 | -11.1% |
| stat rushYds | 10 | 4 | 40% | 60% | -2.87 | -28.7% |
| confidence 62%+ | 20 | 13 | 65% | 63% | +3.13 | +15.7% |
| confidence 58-62% | 43 | 24 | 56% | 60% | +0.17 | +0.4% |
| confidence 54-58% | 27 | 13 | 48% | 56% | -2.25 | -8.3% |
| confidence 50-54% | 17 | 8 | 47% | 52% | -0.69 | -4.1% |
| flagged | 15 | 8 | 53% | 58% | -0.07 | -0.5% |
| unflagged | 92 | 50 | 54% | 58% | +0.43 | +0.5% |

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
| 8 | Tyler Goodson | rushYds | 19.5 | under | 64% | 14.0 | None | +0.00 |
| 8 | Rachaad White | rushAtt | 12.5 | under | 66% | 11.0 | True | +0.71 |
| 8 | J.K. Dobbins | rushYds | 22.5 | over | 63% | 13.0 | False | -1.00 |
| 8 | Jayden Daniels | rushAtt | 6.5 | under | 58% | 2.0 | True | +0.95 |
| 8 | Ja'Kobi Lane | recYds | 30.5 | under | 62% | 13.0 | True | +0.80 |
| 8 | Kenneth Walker III | rec | 2.5 | under | 53% | 4.0 | False | -1.00 |
| 8 | Justin Jefferson | rec | 5.5 | under | 56% | 5.0 | True | +0.97 |
| 8 | Sam LaPorta | rec | 4.5 | under | 59% | 3.0 | True | +0.85 |
| 8 | Malik Willis | rushAtt | 6.5 | under | 60% | 1.0 | None | +0.00 |
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
| 8 | Tyler Goodson ★ | rushYds | 20.5 | under | 64% | 14.0 | None | +0.00 |
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
| 9 | Malik Willis | rushAtt | 5.5 | under | 62% | 2.0 | None | +0.00 |
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
| 10 | Antonio Williams | rec | 3.5 | under | 62% | 2.0 | True | +1.05 |
| 10 | Cam Skattebo | rec | 1.5 | over | 54% | 3.0 | True | +1.11 |
| 9 | Justin Jefferson | recYds | 79.5 | under | 62% | 58.0 | True | +0.79 |
| 10 | Devin Singletary | rushRecYds | 39.5 | under | 60% | 3.0 | True | +0.76 |
| 10 | Devin Singletary | rec | 1.5 | over | 53% | 0.0 | False | -1.00 |
| 10 | Cam Skattebo | rushRecYds | 61.5 | over | 60% | 122.0 | True | +0.78 |
| 10 | Darnell Mooney | rec | 1.5 | under | 59% | 2.0 | False | -1.00 |
| 10 | Jack Bech | recYds | 7.5 | over | 62% | 10.0 | True | +1.06 |
| 10 | Josh Downs | rec | 2.5 | over | 58% | 4.0 | True | +1.04 |
| 10 | Dak Prescott | passTD | 1.5 | under | 51% | 5.0 | False | -1.00 |
| 10 | Laquon Treadwell | recYds | 29.5 | under | 62% | 24.0 | True | +0.78 |
| 10 | Bijan Robinson | rec | 3.5 | under | 54% | 4.0 | False | -1.00 |
| 10 | Devaughn Vele | rec | 3.5 | over | 55% | 2.0 | False | -1.00 |
| 10 | Reggie Virgil | recYds | 25.5 | under | 61% | None | None | +0.00 |
| 10 | Jahan Dotson | rec | 1.5 | under | 50% | 3.0 | False | -1.00 |
| 10 | Kyle Pitts Sr. | rec | 3.5 | under | 56% | 4.0 | False | -1.00 |
| 10 | Deshaun Watson | rushAtt | 6.5 | under | 59% | 8.0 | False | -1.00 |
| 10 | Blake Corum | rushAtt | 11.5 | under | 58% | 17.0 | False | -1.00 |
| 10 | Jalen Nailor | rec | 1.5 | over | 55% | 1.0 | False | -1.00 |
| 10 | Darnell Washington | rec | 2.5 | over | 58% | 1.0 | False | -1.00 |
| 10 | Javonte Williams | rec | 2.5 | under | 55% | 1.0 | True | +0.95 |
| 10 | Tre Tucker | rec | 2.5 | over | 55% | 1.0 | False | -1.00 |
| 10 | Matthew Stafford | passYds | 211.5 | over | 60% | 249.0 | True | +0.78 |
| 10 | Isaiah Likely | rec | 4.5 | over | 58% | 9.0 | True | +0.82 |
| 10 | Deshaun Watson | rushYds | 27.5 | under | 59% | 49.0 | False | -1.00 |
| 10 | Austin Ekeler | rushAtt | 8.5 | under | 58% | 9.0 | False | -1.00 |
| 10 | Devaughn Vele | recYds | 27.5 | over | 59% | 14.0 | False | -1.00 |
| 10 | Tucker Kraft | rec | 3.5 | under | 51% | 1.0 | True | +1.08 |
| 10 | Tre Tucker | recYds | 26.5 | over | 58% | 9.0 | False | -1.00 |
| 10 | Reggie Virgil | rec | 2.5 | under | 62% | None | None | +0.00 |
| 10 | Josh Allen | passTD | 1.5 | under | 51% | 1.0 | True | +1.05 |
| 10 | Konata Mumpfield | recYds | 27.5 | under | 62% | 81.0 | False | -1.00 |
| 10 | Tutu Atwell | recYds | 29.5 | under | 62% | 31.0 | False | -1.00 |
| 10 | Justin Herbert | rushAtt | 4.5 | under | 56% | None | None | +0.00 |
| 10 | Matthew Stafford | passYds | 210.5 | over | 60% | 249.0 | True | +0.77 |
| 10 | Tutu Atwell | rec | 2.5 | under | 62% | 1.0 | True | +0.67 |
| 10 | Keaton Mitchell | rushAtt | 3.5 | over | 56% | None | None | +0.00 |
| 10 | Reggie Virgil | recYds | 24.5 | under | 61% | None | None | +0.00 |
| 10 | Elijah Higgins | recYds | 19.5 | under | 60% | None | None | +0.00 |
| 10 | Zay Flowers | rec | 5.5 | under | 54% | None | None | +0.00 |

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
| 10 | 2026-11-13T01:08 | 274 | 4.979 | 0.6452 | 4.734 | 18 (230 pts): 4 / 5 / 9 |

Latest week's biggest no-shows: Puka Nacua (WR, 22.7, out), Kenneth Walker III (RB, 20.5, none), Zay Flowers (WR, 15.5, none), Derrick Henry (RB, 14.9, none), Mike Evans (WR, 14.7, questionable), Jacoby Brissett (QB, 14.5, none)

## Confidence bands (actual ÷ projected, players who played, fitted on weeks 1–10)

Projection × p10–p90 = the 80% band, × p25–p75 the 50% band; the median ratio is below 1 because weeks are right-skewed. Thin cells are shrunk toward the pooled tier shape (shrunk = weight on it). Walk-forward check on week 10: 76% of actuals inside the 80% band, 53% inside the 50% band (n=270).

| pos | tier | n | shrunk | p10 | p25 | median | p75 | p90 |
|---|---|---|---|---|---|---|---|---|
| QB | <3 | 2 | 1.00 | 0.00 | 0.00 | 0.73 | 2.61 | 6.27 |
| QB | 3-6 | 0 | 1.00 | 0.00 | 0.32 | 0.81 | 1.61 | 2.77 |
| QB | 6-10 | 4 | 1.00 | 0.14 | 0.40 | 0.81 | 1.39 | 2.00 |
| QB | 10-15 | 99 | 0.29 | 0.05 | 0.35 | 0.71 | 1.16 | 1.58 |
| QB | 15+ | 238 | 0.14 | 0.19 | 0.62 | 0.92 | 1.26 | 1.59 |
| RB | <3 | 215 | 0.16 | 0.00 | 0.00 | 0.69 | 2.46 | 5.90 |
| RB | 3-6 | 127 | 0.24 | 0.01 | 0.33 | 0.86 | 1.68 | 2.80 |
| RB | 6-10 | 151 | 0.21 | 0.11 | 0.35 | 0.75 | 1.27 | 1.90 |
| RB | 10-15 | 149 | 0.21 | 0.25 | 0.46 | 0.75 | 1.30 | 1.86 |
| RB | 15+ | 139 | 0.22 | 0.37 | 0.58 | 0.89 | 1.22 | 1.61 |
| WR | <3 | 310 | 0.11 | 0.00 | 0.00 | 0.52 | 2.72 | 6.62 |
| WR | 3-6 | 194 | 0.17 | 0.00 | 0.29 | 0.81 | 1.62 | 2.78 |
| WR | 6-10 | 320 | 0.11 | 0.16 | 0.46 | 0.90 | 1.42 | 2.09 |
| WR | 10-15 | 238 | 0.14 | 0.23 | 0.46 | 0.78 | 1.33 | 1.85 |
| WR | 15+ | 108 | 0.27 | 0.36 | 0.57 | 0.88 | 1.42 | 1.71 |
| TE | <3 | 242 | 0.14 | 0.00 | 0.00 | 0.88 | 2.45 | 4.89 |
| TE | 3-6 | 102 | 0.28 | 0.00 | 0.36 | 0.76 | 1.57 | 2.65 |
| TE | 6-10 | 187 | 0.18 | 0.17 | 0.38 | 0.79 | 1.45 | 1.96 |
| TE | 10-15 | 97 | 0.29 | 0.20 | 0.35 | 0.73 | 1.21 | 1.78 |
| TE | 15+ | 19 | 0.68 | 0.41 | 0.66 | 0.95 | 1.33 | 1.65 |

### Stat-line simulation

Per-player bands from the projected stat line (see the bands note). Fitted dispersions: Walk-forward check on week 10: simulation 72% of actuals inside the 80% band, 41% inside the 50% band; the published blend with the tier bands 74% / 44% (n=196).

| pos | volume σ (log) by tier | yards/opportunity gamma shape | TD overdispersion |
|---|---|---|---|
| QB | passAtt 0.25/0.23/0.23, rushAtt 0.66/–/–/– | passYds 0.522, rushYds 0.5 | passTD 1.0, rushTD 1.0 |
| RB | rushAtt 0.74/0.65/0.50/0.41, tgt 0.64/0.63/0.58/– | rushYds 0.634, recYds 0.933 | rushTD 1.0, recTD 1.122 |
| WR | tgt 0.64/0.64/0.56/0.54 | recYds 1.221 | recTD 1.109 |
| TE | tgt 0.62/0.57/0.57/0.54 | recYds 1.42 | recTD 1.225 |

## Stat lines (2960 player-weeks; rule per week: wk 1 proportional, wk 2 proportional, wk 3 proportional, wk 4 proportional, wk 5 proportional, wk 6 proportional, wk 7 proportional, wk 8 split, wk 9 split, wk 10 split)

MAE / r per component — StatHead vs the flat per-game stat vs the external benchmark — and the matchup swing's calibration on that component (1 = right size, 0 = no information).

| pos | stat | n | actual/g | StatHead | flat | benchmark | swing slope |
|---|---|---|---|---|---|---|---|
| QB | passAtt | 343 | 28.34 | 9.46 / 0.2273 | 9.22 / 0.2591 | 6.67 / 0.2416 | -0.005 |
| QB | passComp | 343 | 18.12 | 6.55 / 0.255 | 6.41 / 0.2634 | 4.74 / 0.2798 | 0.254 |
| QB | passYds | 343 | 201.98 | 77.41 / 0.2649 | 77.11 / 0.2593 | 60.05 / 0.2873 | 0.498 |
| QB | passTD | 343 | 1.32 | 0.97 / 0.2701 | 0.98 / 0.2356 | 0.91 / 0.3151 | 1.198 |
| QB | int | 343 | 0.63 | 0.71 / -0.1198 | 0.70 / -0.1049 | 0.66 / 0.0474 | -0.502 |
| QB | rushAtt | 343 | 3.24 | 2.36 / 0.0539 | 2.37 / 0.0559 | 1.97 / 0.3774 | -0.162 |
| QB | rushYds | 343 | 13.64 | 13.26 / 0.2123 | 13.34 / 0.2055 | 12.62 / 0.4084 | 0.626 |
| QB | rushTD | 343 | 0.15 | 0.24 / 0.2897 | 0.24 / 0.2794 | 0.28 / 0.2864 | 2.303 |
| RB | rushAtt | 789 | 8.33 | 3.50 / 0.7553 | 3.45 / 0.7628 | 3.19 / 0.8003 | 0.062 |
| RB | rushYds | 789 | 34.59 | 19.54 / 0.6711 | 19.61 / 0.6722 | 18.68 / 0.7011 | 0.398 |
| RB | rushTD | 789 | 0.27 | 0.35 / 0.3886 | 0.35 / 0.378 | 0.35 / 0.398 | 1.398 |
| RB | tgt | 789 | 2.05 | 1.30 / 0.5696 | 1.29 / 0.5828 | 1.22 / 0.6274 | -0.463 |
| RB | rec | 789 | 1.6 | 1.12 / 0.532 | 1.11 / 0.5426 | 1.06 / 0.5881 | -0.216 |
| RB | recYds | 789 | 12.03 | 10.77 / 0.437 | 10.74 / 0.4466 | 10.33 / 0.4846 | -0.294 |
| RB | recTD | 789 | 0.06 | 0.12 / 0.1371 | 0.12 / 0.1253 | 0.13 / 0.1672 | 6.279 |
| WR | tgt | 1179 | 4.42 | 2.10 / 0.6507 | 2.09 / 0.6551 | 1.87 / 0.7161 | 0.128 |
| WR | rec | 1179 | 2.75 | 1.47 / 0.6398 | 1.45 / 0.6439 | 1.35 / 0.6871 | 0.19 |
| WR | recYds | 1179 | 35.84 | 22.75 / 0.5848 | 22.74 / 0.5823 | 21.45 / 0.6139 | 0.599 |
| WR | recTD | 1179 | 0.21 | 0.30 / 0.2648 | 0.30 / 0.2604 | 0.31 / 0.2665 | 1.641 |
| TE | tgt | 649 | 3.3 | 1.56 / 0.6814 | 1.56 / 0.6798 | 1.53 / 0.6997 | 0.526 |
| TE | rec | 649 | 2.34 | 1.34 / 0.6187 | 1.32 / 0.6172 | 1.29 / 0.6332 | 0.513 |
| TE | recYds | 649 | 23.82 | 16.19 / 0.5639 | 16.35 / 0.5519 | 15.85 / 0.5715 | 1.02 |
| TE | recTD | 649 | 0.2 | 0.29 / 0.1944 | 0.29 / 0.1702 | 0.30 / 0.2139 | 1.823 |
