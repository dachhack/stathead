# RB overprojection (2026-09-25)

**Symptom:** against ESPN, weeks 1–2 of 2026, our RBs ran +2.4 PPR per player per week (ESPN +0.8). In the season pool the #1/#5/#12/#24 RB were at 503/356/280/211 PPR. The 2016–25 average is 394/290/226/175. Jonathan Taylor was at 26.4 rushing TDs, Derrick Henry 25.1 and Jahmyr Gibbs 21.5; no RB has scored more than 18 since 2016.

RB **volume** was fine: carries and targets were 0.98× the 2021–25 league totals. **Scoring efficiency** wasn't: rushing TDs 1.40×, receiving TDs 1.21×, rushing yards 1.12×. There were four causes, largest first.

## 1. The team model predicted 2026 from zero-filled features

`scripts/train_team_projections.py`, last built April 2026, reads its team features (coaching, pace, pass rate, yards per carry, Vegas, roster turnover) from the feature store for the season being projected. The store stops at 2025. So at prediction time 22 of 33 features were silently 0, a situation the model never saw in training. It projected 23.0 rushing TDs and 36.6 passing TDs per team; the real averages over 2023–25 were 14.7–16.0 and ~25. Rushing TDs went straight into RB lines. Passing TDs didn't reach anyone, because QB and receiver TDs come from a separate receiving-TD total, which was sane.

Training also read same-season features: a 2024 row saw 2024's own pass rate, pace and win total. So its cross-validation was optimistic.

**Fix:**
- Features are now read from the season before the one being projected (`FEATURE_LAG = 1`), for training and prediction alike.
- A feature missing for 20%+ of the training or prediction rows is dropped, never zero-filled. `newHeadCoach` and `teamDomeGames` drop out.
- A guard refuses to write when a projected league average is off the prior season by more than 15%.

2026 league averages are now 16.2 rushing TDs (actual last season 15.8), 25.1 passing TDs (25.3) and 2,008 rushing yards (1,986).

## 2. The team model's predictions were too spread out

Regressing held-out actuals on held-out predictions gives slopes of 0.54–0.77. Real outcomes vary only 54–77% as much as the predictions, so extreme teams were over-projected: IND 24 rushing TDs against a league average of 16. Each stat is now pulled toward the league average by its cross-validated slope (`cvMetrics[stat].calibrationSlope`). IND is now 22, BAL 18, DET 20, and the range is 11–22.

**Open decision:** the ensemble, even calibrated, doesn't beat a naive baseline of 50% last season + 50% league average.

| stat | model RMSE | calibrated | league avg | 50/50 baseline |
|---|---|---|---|---|
| rushing TDs | 5.2 | 5.1 | 5.5 | 5.2 |
| passing TDs | 7.4 | 7.1 | 7.6 | **6.9** |
| rushing yards | 337 | 330 | 360 | **313** |
| pass attempts | 55.6 | 55.0 | 58.8 | **54.3** |

## 3. The RB split could exceed the team total

- **Backs with a model-predicted share** took `team rushing TDs × their share of team carries`, while the QB took his own cut of the same total. Chicago's backs were allocated 25.9 of a 25-TD team, with 7.4 more for the QB.
- **Receiving TDs** used the back's target share of ALL team receiving TDs. Backs score on far fewer of their targets.
- **The reconciliation only ever scaled up.**

**Fix** (`buildProjectionPool.ts`): RB rushing yards reconcile to the RB total in both directions, and RB rushing and receiving TDs are capped at the RB total (the team total × the RB group's prior-season share).

## 4. In-season blend: one weight for every stat line

The blend weighted every stat by the position's total-points weight (RB 3.5). Taylor's 4 TDs in two 2026 games moved his TD rate as fast as his carries. Fitted per stat line with the same method (2016–2025, prior season vs weeks 1..k, predicting the rest of the season), TDs need two to six times as many games as total points (RB rushing TDs 6 vs total points 3; QB rushing TDs 30 vs 5), and volume slightly fewer. `IN_SEASON_K_FIELD` scales each position's weight by that ratio.

## Also: roster-status absences were counted twice

Players on the exempt list, IR, the practice squad or unrostered are already out of the season pool's team split, so their work is in their teammates' lines. Next-man-up in `get_weekly_projections` handed their conditional line out again: Josh Jacobs gave MarShawn Lloyd +7.4 (17.5 vs ESPN 8.6), and ARI's IR backs gave Jeremiyah Love +8.3. Only week-to-week designations on active players are redistributed now.

## Result

| | before | after | 2016–25 average |
|---|---|---|---|
| RB rank #1 / #5 / #12 / #24 (PPR) | 503 / 356 / 280 / 211 | 451 / 322 / 251 / 187 | 394 / 290 / 226 / 175 |
| RB rushing TDs, top 3 | 26.4 / 25.1 / 21.5 | 19.1 / 18.4 / 17.0 | max 18 |

Pool RB league totals against 2021–25: carries 1.02×, rushing yards 1.03×, rushing TDs 1.04×, receiving TDs 0.99×, PPR 1.02×.

Week 3 against ESPN, players both expect to play:

| RB | before | after |
|---|---|---|
| correlation | 0.85 | 0.86 |
| average gap (MAE) | 2.92 | 2.40 |
| bias (ours − ESPN) | +1.58 | −0.99 |

The top end is still 8–14% above the historical average for ranked RBs. Part of that is early-season usage (Gibbs 22.5 carries per game in 2026), which the blend correctly moves toward.
