# Injury availability in weekly projections (2026-09-25)

Checked against ESPN over weeks 1–2 of 2026, our weekly board missed by 7.27 PPR
(RMSE) and ESPN's by 6.59. We projected 5+ points for 52 players who didn't
play; ESPN did that for 16. About a third of the gap was availability. This
change fixes three causes.

## 1. Measured designation multipliers

`scripts/measure-injury-designations.py` →
`public/data/injury-designation-multipliers.json`. The sample is every
QB/RB/WR/TE designated on the nflverse report, 2016–2025 REG weeks 1–16, with
a baseline of at least 5 PPR per game over 4+ undesignated games. For each one
it divides the points scored that week by the player's own healthy baseline,
with a missed game counted as 0.

| status | n | played | multiplier (90% CI) | was |
|---|---|---|---|---|
| Out | 1,485 | 0.1% | ×0.00 | ×0 |
| Doubtful | 258 | 1.2% | **×0.01** | ×0.25 |
| Questionable | 2,404 | 71% | **×0.63** (0.61–0.65) | ×1 (flag only) |
| … Full practice last | 446 | 85% | ×0.80 | |
| … Limited | 1,594 | 72% | ×0.64 | |
| … Did not practice | 341 | 48% | ×0.39 | |

These are expected values. A Questionable player at ×0.63 is not "63% of his
usual line if he plays": if he plays he scores ×0.88, and he plays 71% of the
time. Rankings built on this board correctly push him down. In a start/sit
call, read the availability column.

## 2. Sleeper's live status for the current week

The official report only has game statuses once they're posted, on Friday for
Sunday games, and it doesn't carry them from week to week. On Thursday of
week 3 it had 8 designations. Sleeper already had Jayden Daniels Out, Caleb
Williams Doubtful, Jaxson Dart on IR, Cooper Rush Out and Dallas Goedert
Doubtful.

- `scripts/fetch-sleeper-injuries.py` snapshots rostered skill players with a
  status into `public/data/sleeper-injuries-2026.json`.
- The weekly builder stamps them on rows as `slp` for the current week.
  IR/PUP/Sus/NFI always count. A game-week call (Out, Doubtful, Questionable)
  counts only if Sleeper updated it after the team's last kickoff. That's the
  same rule that stops last week's Out from being read as this week's.
- The MCP and the site use the official report for its own week first, and
  fall back to `slp` when the report says nothing about the player.
- `.github/workflows/refresh-injuries.yml` runs every 20 minutes, 7am–11pm ET.
  It fetches the nflverse report, roster, depth chart, scores and Sleeper, and
  rebuilds only the weekly file. The hourly `refresh-data.yml` fetches Sleeper
  too, so its rebuild keeps the stamps.

Sleeper can't be backtested, because the committed daily Sleeper snapshot
never kept injury fields. From now on `sleeper-injuries-2026.json` history
makes that possible.

## 3. Backup QBs by depth chart

A QB below QB1 on the depth chart is now `backup=true` whatever his projected
game count. With the in-season blend, a QB2 who started once had 4–8
projected games and ranked as a starter. In week 3 Drew Lock, Mac Jones and
Carson Wentz projected 14–20 while ESPN had them at 0. When the starter is
out, the backup still starts through next-man-up.

## Result

Weeks 1–2, replayed from the boards and injury reports as they stood before
each kickoff. Sleeper isn't included because it can't be replayed.

| | ESPN | ours before | ours now |
|---|---|---|---|
| RMSE, all | 6.59 | 7.27 | **7.12** |
| QB | 8.51 | 9.21 | **8.76** |
| WR | 6.62 | 7.37 | **7.21** |
| RB | 6.00 | 6.68 | 6.62 |
| TE | 5.95 | 6.42 | 6.42 |
| projected 5+, didn't play | 16 | 52 | 46 |

Week 3 against ESPN: 23 players ESPN had at 0 but we projected at 5+. With
Sleeper that drops to 8. Five are Questionable players ESPN zeroed and we
discount to ×0.63.

## Open

- RBs still run hot (+2.4 points per game vs +0.8 for ESPN). The cause is in
  the season pool, not availability.
- A Questionable player isn't an heir to his own teammates' vacated work (he
  is himself vacating). That's simpler than giving him 63% of a share.
