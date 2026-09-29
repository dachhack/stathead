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

## Game day: the inactive list (2026-09-29)

A Questionable player is a coin flip we price at ×0.63 until the team posts
its inactive list, about 90 minutes before kickoff. After that he is either
out or playing. Neither the nflverse report nor Sleeper carries the list: in
week 3 Sleeper never moved a Questionable skill player to Out, and ESPN's game
rosters fill in only after the game. RotoWire does, on ESPN's athlete
overview, 20-80 minutes before kickoff ("Bowers (knee) is active", "Legette
(knee) is inactive").

`scripts/fetch-gameday-inactives.py` runs with every injury refresh. It
checks only teams kicking off in the next 4 hours, and only players whose
status is in doubt: this week's Questionable / Doubtful (official report or
Sleeper), plus every depth-chart QB of a team whose QB is designated. A
RotoWire headline published within 5 hours before kickoff is classified active
/ inactive (a forecast like "expected to be active" is not a call; an in-game
"ruled out for the rest of" is not either) and saved to
`public/data/gameday-2026.json`, sticky for the week. The builder stamps it
on the row as `gd`.

Applied in week mode (MCP and site), ahead of the designation:

| call | multiplier | source |
|---|---|---|
| inactive | 0 | |
| active, Questionable | ×0.88; Full ×0.91 / Limited ×0.88 / DNP ×0.77 | multIfPlayed, 2016-2025 |
| active, Doubtful | ×0.58 | multIfPlayed |

An inactive starter's line goes to his position-mates through next-man-up,
as an Out does.

### Questionable backup QB

When the QB1 is out, the start now walks down the depth chart: each backup
takes the part of the vacated start he is himself available for (his own
multiplier) and passes the rest to the next. Before, a Questionable QB2 kept
his ×0.80 and the other 20% went nowhere: Tyson Bagent (concussion) 13.8,
Case Keenum 0; Keenum started and scored 24.5.

### Week 3 replay

Boards and injury reports as they stood before each kickoff, game-day calls
rebuilt from the RotoWire items in the player-buzz snapshots (16 matched).
ESPN's projections are from Thursday.

| MAE (PPR) | before | + QB chain | + game day | ESPN |
|---|---|---|---|---|
| all (277) | 5.14 | 5.13 | **5.02** | 5.12 |
| QB | 6.68 | 6.59 | 6.59 | 5.77 |
| RB | 4.67 | 4.67 | **4.61** | 4.96 |
| WR | 4.83 | 4.83 | **4.64** | 4.90 |
| TE | 5.51 | 5.51 | 5.45 | 5.39 |

Correlation with actual points: all 0.599 → 0.624, TE 0.36 → 0.42. A player
confirmed active vacates nothing: his ×0.88 is how he scores when he plays,
not a chance that his backup starts.

## QB starter calls (2026-09-29)

QB was our weakest position in week 3 (correlation 0.06 against ESPN's 0.48),
almost all of it wrong starters: Cooper Rush projected 14.6 behind a named
Michael Penix, and Case Keenum at 3.1 when he had been reported "in line to
start" since Sunday morning. Those calls are in RotoWire's blurbs all week.

`fetch-gameday-inactives.py` now also sweeps every depth-chart QB (1-3) of
every team still to play, hourly (every run for teams inside 4 hours of
kickoff). A headline published since the team's last game is classified
by its first clause, which is about the page's own player:

| call | examples |
|---|---|
| firm | "will start", "named the starting quarterback", "is the Giants' starting quarterback", "will return to the starting lineup" |
| likely | "is expected / likely / in line / on track to start" |
| not | "will serve as the backup", "won't start", "is expected to remain the backup" |

A hedge before the call ("could be in line to start", "may start", "next in
line to start") is no call. The newest call per QB is saved in `qbCalls` in
`gameday-2026.json`; the builder stamps it as `qbc`.

Weeks 1-3 of 2026 against the QB who threw the most passes: single calls were
right 30 of 33 times (the three misses superseded later the same week); a
team's newest start call named the starter in 12 team-weeks of 12 (8 firm, 4
likely); "not starting" calls with no one named held 10 of 11.

In week mode the team's newest firm / likely call names the starter. He starts
with P 0.95 (firm) or 0.85 (likely), never less than what the QBs ahead of him
already vacated (with Jayden Daniels out, "Mariota is expected to start" is a
certain start). The QB he displaces keeps the rest; that counts as vacated, so
the receivers get the QB-change adjustment. A lone "not starting" call leaves
the QB1 5% and next-man-up promotes the QB2.

Timestamps: ESPN's RotoWire `published` reads "Mon Sep 28 13:04:41 PDT 2026",
which the first version of the fetcher failed to parse, dropping every call.
Fixed before the first live game-day window.

### Week 3 replay, with QB calls

| MAE (PPR) | before | + game day | + QB calls | ESPN |
|---|---|---|---|---|
| all (277) | 5.14 | 5.02 | **4.89** | 5.12 |
| QB | 6.68 | 6.59 | **5.49** | 5.77 |

QB correlation with actual points 0.06 → 0.54 (ESPN 0.48); all 0.599 → 0.653
(ESPN 0.632).

## Open

- RBs still run hot (+2.4 points per game vs +0.8 for ESPN). The cause is in
  the season pool, not availability.
- A Questionable player isn't an heir to his own teammates' vacated work (he
  is himself vacating). That's simpler than giving him 63% of a share.
