# Cross-position absence effects (2026-09-24)

When a starter is out, `get_weekly_projections` hands his line to his own
position group (`VACATED_CAPTURE`, next man up). This study measures what the
absence does to the **other** positions on the team, and ships only the effects
that improve projections for held-out seasons.

Reproduce: `python3 scripts/measure-cross-position-absence.py` (about 1 min) →
`public/data/cross-position-absence.json`.

## Method

- 2016–2025 regular season, weeks 1–16 (later weeks have rest games).
- **Leader:** the team's top player at a position (QB by pass attempts, others
  by PPR per game), min 6 games, on no other team that season. That gives
  165 QB, 173 RB, 148 WR and 195 TE team-seasons with at least one absence.
- **In-week:** the leader has a stat row (a QB needs 15+ attempts).
  **Out-week:** the team played and he did not. A QB with 1–14 attempts left
  early or came in late, so those weeks are dropped.
- **Established teammate:** 3+ games with the leader and 1+ without. These are
  the players a projection is about. Depth players who only appear once the
  leader is out are left out of the individual numbers.
- **Validation:** fit on 2016–2021, then predict each established teammate's
  per-game PPR in the out-weeks for 2022–2025. The comparison is RMSE against
  no adjustment, which is the current rule.
- 90% CIs come from resampling team-seasons (2,000 draws).

## QB1 out: shipped

Every teammate is scaled by `m = 1 + a + e·(r − 1)`. Here `r` is the backup's
passing level over the starter's, measured before the season: pass yards per
15+-attempt game over the prior three seasons, shrunk 4 games toward league
average (85% of it for a backup). `r` is **not** taken from the out-weeks,
because that would be receiving yards measuring passing yards. A first draft
of this study did exactly that and overstated the WR gain by about 2×.

| teammate | a (90% CI) | e (90% CI) | m at mean r = 0.905 | holdout RMSE: none → constant → model |
|---|---|---|---|---|
| WR | −0.135 (−0.19, −0.08) | 0.25 (−0.02, 0.57) | **×0.84** | 4.06 → 3.77 → **3.76** (−7.6%) |
| TE | −0.069 (−0.15, 0.01) | 0.44 (−0.01, 0.88) | **×0.89** | 3.57 → 3.52 → **3.51** |
| RB | −0.062 (−0.10, −0.02) | 0.16 (−0.17, 0.49) | **×0.92** | 4.49 → 4.41 → **4.40** |

The drop itself is solid: the intercept's CI excludes zero for WR and RB. The
backup-quality slope is positive for all three but soft. Even a backup who
projects to pass as well as the starter costs his receivers most of the drop,
so it isn't only about arm talent. At runtime `r` = the heir's projected
`passYdsPG` over the starter's, from the weekly feed, clamped to 0.5–1.2.

## Non-QB leaders: WR → QB shipped, the rest measured and not applied

Capture = Δ per game for established teammates ÷ the leader's per-game line,
split by each teammate's share of his group's in-week points.

| leader out → | capture (90% CI) | holdout RMSE none → capture | shipped |
|---|---|---|---|
| WR → QB | −0.061 (−0.11, −0.01) | 5.63 → **5.54** | ✅ |
| WR → RB | +0.060 (−0.02, 0.15) | 4.58 → 4.57 | no (CI spans 0, ~0 gain) |
| WR → TE | +0.072 (0.00, 0.14) | 3.97 → 4.01 | no (worse) |
| TE → WR | +0.117 (−0.02, 0.26) | 4.59 → 4.60 | no (worse) |
| TE → RB | −0.071 (−0.19, 0.04) | 4.00 → 3.98 | no (CI spans 0) |
| TE → QB | −0.038 (−0.11, 0.04) | 5.59 → 5.58 | no (CI spans 0) |
| RB → WR | −0.034 (−0.12, 0.05) | 4.73 → 4.76 | no |
| RB → TE | +0.005 (−0.04, 0.05) | 3.67 → 3.67 | no |
| RB → QB | −0.013 (−0.06, 0.04) | 5.56 → 5.59 | no |

Counted at the **team** level, TE1 out does move WR production: +0.36 of the
TE's line over 2016–2025. But only about +0.12 of that reaches established WRs,
and that part doesn't hold up in the held-out seasons. The rest goes to depth
receivers who weren't playing before, such as extra 3-WR snaps. The intuitive
"TE out → start his WR2" call isn't supported.

As a sanity check, the same method reproduces the same-position rates already
in the MCP: RB 0.79 (MCP 0.74), WR 0.60 (0.48), TE 0.45 (0.42).

## Implementation

`mcp/dist/server.mjs`, week mode, after next-man-up:

- If the team's QB1 is out (lowest depth among non-backup QBs with more than
  3 projected games), every healthy RB/WR/TE on the team is scaled by `m`. The
  effect is weighted by the fraction of his line actually vacated, so Doubtful
  counts as 75%. The heir is the top healthy QB by depth.
- A QB1 already on a reserve list (RES/EXE, which carries a 1-game placeholder
  line) is not treated as out. His receivers' lines already come from a team
  pie that excludes him, and the in-season blend already reflects games played
  with the backup, so the multiplier is only for week-to-week absences.
- WR points vacated on a team → the top healthy QB loses 6.1% of them.
- The result is shown in a `crossPos` column.
- Rows are now built for the whole league and filtered afterwards. A
  `position=WR` or `player_name` query used to drop the QB who was out, and the
  teammates of a single player, before either pass could see them.
- Free-agent and practice-squad rows no longer vacate anything. A QB released
  by GB (Clayton Tune, 1-game line) had been handing Jordan Love +9.5.

`scripts/build-weekly-projections.py` adds `passYdsPG` to QB rows.

## Backup QB taking over (fixed)

A backup QB who took over used to keep his own per-game line **plus** a
next-man-up share of the starter's (VACATED_CAPTURE 0.56 × HEIR_TOP_SHARE
0.80). With Josh Allen out, Kyle Allen showed 19.0 + 14.3 = 32.8. The pool
builds a backup's line from the team's leftover passing at slightly worse
efficiency, so that line already means "what he scores if he starts".

Over 162 backup stretches (2016–2025, games with 15+ attempts; `qbHeir` in the
JSON), using a proxy for the pool's line (0.9 × the starter's passing points
+ 1 rushing point):

| backup's points per start | bias | RMSE (2022–25 only) |
|---|---|---|
| own line + share (old) | +7.7 | 9.72 (9.40) |
| share only | −5.1 | 7.21 (6.64) |
| **own line only (now)** | **−0.8** | **5.34 (4.90)** |

The next QB on the depth chart now simply starts, at his own line scaled by the
fraction of the start that's vacated (a Doubtful starter keeps 25%). He shows
`status=starting` and `promoted=starts`, and sorts among the starters instead
of below them.

## Open

- Questionable is still only flagged, with no discount.
