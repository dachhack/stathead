# Weekly projection accuracy — 2026, weeks 1–10

_2977 player-weeks scored out of sample; generated 2026-11-21T13:02_

## All players who played

| method | n | MAE | RMSE | r | bias |
|---|---|---|---|---|---|
| StatHead (published) | 2865 | 4.71 | 6.38 | 0.6394 | -0.16 |
| season line only | 2865 | 4.73 | 6.41 | 0.6349 | -0.11 |
| external benchmark | 2865 | 4.51 | 6.15 | 0.6697 | -0.12 |

## By position (MAE / r): StatHead vs season line vs benchmark

| pos | n | StatHead | season line | benchmark |
|---|---|---|---|---|
| QB | 299 | 6.30 / 0.2993 | 6.43 / 0.2278 | 6.27 / 0.3496 |
| RB | 775 | 4.71 / 0.6509 | 4.70 / 0.6532 | 4.41 / 0.6963 |
| WR | 1162 | 4.68 / 0.5964 | 4.67 / 0.5961 | 4.44 / 0.6308 |
| TE | 629 | 4.01 / 0.5397 | 4.08 / 0.522 | 3.92 / 0.558 |

## Starters (projected ≥ 8)

| method | n | MAE | RMSE | r | bias |
|---|---|---|---|---|---|
| StatHead | 1365 | 6.25 | 7.74 | 0.4624 | +0.61 |
| season line only | 1365 | 6.30 | 7.81 | 0.4451 | +0.58 |
| external benchmark | 1365 | 6.04 | 7.54 | 0.4998 | +0.38 |

## Against naive in-season baselines (weeks 2+, players with a prior game)

| method | n | MAE | RMSE | r | bias |
|---|---|---|---|---|---|
| StatHead | 2141 | 4.85 | 6.49 | 0.625 | -0.17 |
| season line only | 2141 | 4.90 | 6.56 | 0.6149 | -0.16 |
| season-to-date average | 2141 | 5.26 | 7.19 | 0.5661 | -0.24 |
| last week | 2141 | 6.14 | 8.48 | 0.4707 | -0.04 |
| external benchmark | 2141 | 4.70 | 6.26 | 0.655 | -0.05 |

## Matchup layer calibration

Slope of (actual − season line) on (projection − season line): 1 = the projected swing is the right size, 0 = no information. impliedScale = scale in force × slope — what POS_MATCHUP_SCALE should be.

| pos | n | slope | ± se | scale in force | implied scale |
|---|---|---|---|---|---|
| overall | 2977 | +0.66 | 0.13 | 0.97 | 0.64 |
| QB | 345 | +1.05 | 0.35 | 1.00 | 1.05 |
| RB | 794 | +0.30 | 0.23 | 0.85 | 0.26 |
| WR | 1185 | +0.46 | 0.25 | 0.91 | 0.42 |
| TE | 653 | +1.08 | 0.24 | 1.22 | 1.32 |

## Pick lines

110 graded picks (39 pending): hit rate 53% (model expected 58%), return -2.64 units, ROI -2.4% per pick.

| cut | n | hits | hit rate | expected | return | ROI |
|---|---|---|---|---|---|---|
| all | 110 | 58 | 53% | 58% | -2.64 | -2.4% |
| auto picks | 102 | 53 | 52% | 58% | -3.81 | -3.7% |
| call picks | 8 | 5 | 62% | 60% | +1.17 | +14.6% |
| line moved toward | 10 | 5 | 50% | 59% | -0.70 | -7.0% |
| line moved unchanged | 69 | 36 | 52% | 57% | -0.98 | -1.4% |
| line moved away | 22 | 12 | 55% | 60% | -0.70 | -3.2% |
| stat anyTD | 1 | 1 | 100% | 60% | +0.81 | +81.0% |
| stat passRushYds | 1 | 1 | 100% | 58% | +0.77 | +77.0% |
| stat passTD | 5 | 1 | 20% | 53% | -2.95 | -59.0% |
| stat passYds | 4 | 3 | 75% | 60% | +1.35 | +33.8% |
| stat rec | 45 | 26 | 58% | 56% | +4.58 | +10.2% |
| stat recYds | 15 | 9 | 60% | 60% | +1.32 | +8.8% |
| stat rushAtt | 21 | 9 | 43% | 59% | -4.76 | -22.7% |
| stat rushRecYds | 8 | 4 | 50% | 62% | -0.89 | -11.1% |
| stat rushYds | 10 | 4 | 40% | 60% | -2.87 | -28.7% |
| confidence 62%+ | 20 | 13 | 65% | 63% | +3.13 | +15.7% |
| confidence 58-62% | 43 | 24 | 56% | 60% | +0.17 | +0.4% |
| confidence 54-58% | 30 | 13 | 43% | 56% | -5.25 | -17.5% |
| confidence 50-54% | 17 | 8 | 47% | 52% | -0.69 | -4.1% |
| flagged | 15 | 8 | 53% | 58% | -0.07 | -0.5% |
| unflagged | 95 | 50 | 53% | 58% | -2.57 | -2.7% |

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
| 10 | Justin Herbert | rushAtt | 4.5 | under | 56% | 7.0 | False | -1.00 |
| 10 | Matthew Stafford | passYds | 210.5 | over | 60% | 249.0 | True | +0.77 |
| 10 | Tutu Atwell | rec | 2.5 | under | 62% | 1.0 | True | +0.67 |
| 10 | Keaton Mitchell | rushAtt | 3.5 | over | 56% | 3.0 | False | -1.00 |
| 10 | Reggie Virgil | recYds | 24.5 | under | 61% | None | None | +0.00 |
| 10 | Elijah Higgins | recYds | 19.5 | under | 60% | None | None | +0.00 |
| 10 | Zay Flowers | rec | 5.5 | under | 54% | 6.0 | False | -1.00 |

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
| 10 | 2026-11-13T01:08 | 291 | 4.93 | 0.6443 | 4.685 | 12 (155 pts): 4 / 5 / 3 |

Latest week's biggest no-shows: Puka Nacua (WR, 22.7, out), Kenneth Walker III (RB, 20.5, none), Mike Evans (WR, 14.7, questionable), Sam Darnold (QB, 14.3, out), Carnell Tate (WR, 14.2, questionable), Josh Jacobs (RB, 12.2, out)

## Confidence bands (actual ÷ projected, players who played, fitted on weeks 1–10)

Projection × p10–p90 = the 80% band, × p25–p75 the 50% band; the median ratio is below 1 because weeks are right-skewed. Thin cells are shrunk toward the pooled tier shape (shrunk = weight on it). Walk-forward check on week 10: 76% of actuals inside the 80% band, 53% inside the 50% band (n=287).

| pos | tier | n | shrunk | p10 | p25 | median | p75 | p90 |
|---|---|---|---|---|---|---|---|---|
| QB | <3 | 2 | 1.00 | 0.00 | 0.00 | 0.73 | 2.63 | 6.27 |
| QB | 3-6 | 0 | 1.00 | 0.00 | 0.32 | 0.81 | 1.64 | 2.77 |
| QB | 6-10 | 4 | 1.00 | 0.14 | 0.40 | 0.81 | 1.39 | 1.99 |
| QB | 10-15 | 101 | 0.28 | 0.05 | 0.35 | 0.72 | 1.16 | 1.58 |
| QB | 15+ | 238 | 0.14 | 0.19 | 0.62 | 0.92 | 1.26 | 1.59 |
| RB | <3 | 215 | 0.16 | 0.00 | 0.00 | 0.69 | 2.46 | 5.90 |
| RB | 3-6 | 127 | 0.24 | 0.01 | 0.33 | 0.86 | 1.69 | 2.80 |
| RB | 6-10 | 155 | 0.20 | 0.10 | 0.35 | 0.75 | 1.27 | 1.90 |
| RB | 10-15 | 150 | 0.21 | 0.25 | 0.46 | 0.76 | 1.30 | 1.86 |
| RB | 15+ | 139 | 0.22 | 0.37 | 0.58 | 0.89 | 1.22 | 1.61 |
| WR | <3 | 311 | 0.11 | 0.00 | 0.00 | 0.52 | 2.71 | 6.59 |
| WR | 3-6 | 195 | 0.17 | 0.00 | 0.29 | 0.82 | 1.64 | 2.78 |
| WR | 6-10 | 323 | 0.11 | 0.16 | 0.46 | 0.91 | 1.42 | 2.08 |
| WR | 10-15 | 238 | 0.14 | 0.23 | 0.46 | 0.78 | 1.33 | 1.85 |
| WR | 15+ | 109 | 0.27 | 0.36 | 0.57 | 0.87 | 1.41 | 1.71 |
| TE | <3 | 243 | 0.14 | 0.00 | 0.00 | 0.88 | 2.49 | 4.88 |
| TE | 3-6 | 105 | 0.28 | 0.00 | 0.36 | 0.74 | 1.59 | 2.67 |
| TE | 6-10 | 187 | 0.18 | 0.17 | 0.38 | 0.79 | 1.45 | 1.96 |
| TE | 10-15 | 97 | 0.29 | 0.20 | 0.35 | 0.73 | 1.21 | 1.78 |
| TE | 15+ | 19 | 0.68 | 0.41 | 0.66 | 0.95 | 1.33 | 1.65 |

### Stat-line simulation

Per-player bands from the projected stat line (see the bands note). Fitted dispersions: Walk-forward check on week 10: simulation 72% of actuals inside the 80% band, 42% inside the 50% band; the published blend with the tier bands 74% / 44% (n=211).

| pos | volume σ (log) by tier | yards/opportunity gamma shape | TD overdispersion |
|---|---|---|---|
| QB | passAtt 0.25/0.24/0.23, rushAtt 0.66/–/–/– | passYds 0.523, rushYds 0.5 | passTD 1.0, rushTD 1.0 |
| RB | rushAtt 0.74/0.65/0.50/0.41, tgt 0.64/0.63/0.58/– | rushYds 0.624, recYds 0.934 | rushTD 1.0, recTD 1.115 |
| WR | tgt 0.65/0.65/0.56/0.54 | recYds 1.221 | recTD 1.106 |
| TE | tgt 0.63/0.57/0.57/0.54 | recYds 1.423 | recTD 1.223 |

## Stat lines (2977 player-weeks; rule per week: wk 1 proportional, wk 2 proportional, wk 3 proportional, wk 4 proportional, wk 5 proportional, wk 6 proportional, wk 7 proportional, wk 8 split, wk 9 split, wk 10 split)

MAE / r per component — StatHead vs the flat per-game stat vs the external benchmark — and the matchup swing's calibration on that component (1 = right size, 0 = no information).

| pos | stat | n | actual/g | StatHead | flat | benchmark | swing slope |
|---|---|---|---|---|---|---|---|
| QB | passAtt | 345 | 28.37 | 9.48 / 0.2305 | 9.24 / 0.2628 | 6.73 / 0.2381 | -0.005 |
| QB | passComp | 345 | 18.14 | 6.56 / 0.2576 | 6.43 / 0.2664 | 4.77 / 0.2774 | 0.254 |
| QB | passYds | 345 | 202.17 | 77.54 / 0.2632 | 77.25 / 0.2581 | 60.44 / 0.2814 | 0.491 |
| QB | passTD | 345 | 1.31 | 0.97 / 0.2748 | 0.99 / 0.2395 | 0.91 / 0.3199 | 1.228 |
| QB | int | 345 | 0.63 | 0.71 / -0.1221 | 0.70 / -0.1072 | 0.66 / 0.0454 | -0.504 |
| QB | rushAtt | 345 | 3.24 | 2.36 / 0.0541 | 2.37 / 0.0561 | 1.97 / 0.378 | -0.162 |
| QB | rushYds | 345 | 13.71 | 13.30 / 0.2145 | 13.37 / 0.2083 | 12.68 / 0.4075 | 0.587 |
| QB | rushTD | 345 | 0.16 | 0.25 / 0.2847 | 0.25 / 0.2748 | 0.28 / 0.2811 | 2.246 |
| RB | rushAtt | 794 | 8.33 | 3.51 / 0.754 | 3.46 / 0.7616 | 3.20 / 0.7983 | 0.061 |
| RB | rushYds | 794 | 34.53 | 19.66 / 0.6679 | 19.73 / 0.669 | 18.81 / 0.6971 | 0.398 |
| RB | rushTD | 794 | 0.28 | 0.35 / 0.3927 | 0.35 / 0.3825 | 0.35 / 0.4039 | 1.366 |
| RB | tgt | 794 | 2.06 | 1.31 / 0.5687 | 1.29 / 0.5817 | 1.23 / 0.6251 | -0.462 |
| RB | rec | 794 | 1.6 | 1.12 / 0.5298 | 1.11 / 0.5403 | 1.06 / 0.5852 | -0.211 |
| RB | recYds | 794 | 12.03 | 10.76 / 0.4368 | 10.73 / 0.4464 | 10.32 / 0.484 | -0.289 |
| RB | recTD | 794 | 0.06 | 0.12 / 0.137 | 0.12 / 0.1251 | 0.13 / 0.1669 | 6.314 |
| WR | tgt | 1185 | 4.42 | 2.10 / 0.6488 | 2.09 / 0.6532 | 1.88 / 0.7144 | 0.129 |
| WR | rec | 1185 | 2.75 | 1.47 / 0.6404 | 1.45 / 0.6445 | 1.35 / 0.6877 | 0.19 |
| WR | recYds | 1185 | 35.88 | 22.76 / 0.5843 | 22.75 / 0.5818 | 21.46 / 0.6135 | 0.599 |
| WR | recTD | 1185 | 0.21 | 0.30 / 0.2651 | 0.30 / 0.2607 | 0.31 / 0.2668 | 1.656 |
| TE | tgt | 653 | 3.3 | 1.56 / 0.681 | 1.56 / 0.6794 | 1.53 / 0.6992 | 0.526 |
| TE | rec | 653 | 2.35 | 1.34 / 0.616 | 1.32 / 0.6161 | 1.30 / 0.6315 | 0.469 |
| TE | recYds | 653 | 23.9 | 16.24 / 0.5611 | 16.41 / 0.5499 | 15.89 / 0.5691 | 0.979 |
| TE | recTD | 653 | 0.2 | 0.29 / 0.196 | 0.29 / 0.1711 | 0.30 / 0.2149 | 1.843 |
